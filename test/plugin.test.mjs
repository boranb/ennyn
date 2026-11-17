import { GIT_CALLS, GIT_MS, SETTLE_MS } from "../adapters/claude-code/compact-boundary.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, readlinkSync, existsSync, rmSync, statSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "../core/git.mjs";
import { ConfigError, loadConfig } from "../core/config.mjs";
import { checkCommitShape } from "../checks/commit-shape.mjs";
import { npmrcEntries } from "../checks/deps.mjs";
import { GATE_KEYS, LOOSENING_LINE } from "../checks/loosening.mjs";
import { t } from "../core/i18n.mjs";
import { hookProjectDir, projectConfig } from "../adapters/claude-code/project.mjs";
import { FILE_TOOLS } from "../adapters/claude-code/hooks/side-copy-rules.mjs";
import { askRules, OFFERED, outwardCommands } from "../setup/permissions.mjs";
import { projectFiles } from "../setup/scan.mjs";
import { formatConvergence } from "../metrics/convergence.mjs";

// What `claude plugin validate --strict` checks, for machines without the claude CLI.
// Origin: a ": " inside an unquoted agent description made the YAML unparsable, and
// Claude Code then loaded the security reviewer with no name and no description.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

/** @param {string} text @returns {Map<string, string> | null} raw values by key */
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = new Map();
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (kv) out.set(kv[1], kv[2]);
  }
  return out;
}

/** A plain (unquoted) YAML scalar that a parser reads as one string. @param {string} v */
function plainScalarProblem(v) {
  if (/^["']/.test(v)) return null;
  if (/^[[\]{}&*!%@`|>#,?-]/.test(v)) return "starts with a YAML indicator";
  if (/: /.test(v) || /:$/.test(v)) return 'holds ": " (read as a new key)';
  if (/ #/.test(v)) return 'holds " #" (read as a comment)';
  return null;
}

const agents = readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).map((f) => ({ path: `agents/${f}`, name: basename(f, ".md") }));
const skills = readdirSync(join(ROOT, "skills")).filter((d) => existsSync(join(ROOT, "skills", d, "SKILL.md"))).map((d) => ({ path: `skills/${d}/SKILL.md`, name: d }));

test("plugin: every agent and skill has front matter a YAML parser reads, named after its file", () => {
  assert.ok(agents.length >= 3 && skills.length >= 2, "agents and skills found");
  for (const { path, name } of [...agents, ...skills]) {
    const fm = frontMatter(read(path));
    assert.ok(fm, `${path}: front matter between --- lines`);
    assert.equal(fm.get("name"), name, `${path}: name`);
    assert.ok((fm.get("description") ?? "").length > 20, `${path}: description`);
    for (const [key, value] of fm) {
      const problem = plainScalarProblem(value);
      assert.equal(problem, null, `${path}: ${key} ${problem}`);
    }
  }
  // The check itself rejects the defect that started it.
  assert.ok(plainScalarProblem("Starts from the path table: every way in"));
  assert.equal(plainScalarProblem('Review — "how does this break?". Use after a task.'), null);
});

/**
 * The two forms Claude Code 2.1.310 runs as a shell command when it loads a skill, read from the binary: a fence opened
 * with ```! and !`command` at a line's start or after white space, in a text whose other inline code is blanked first.
 * @param {string} text
 */
function shellForms(text) {
  const blanked = text.replace(/`[^`\n]+`/g, (code, at) => (text[at - 1] === "!" || text[at - 1] === "`" ? code : `\`${" ".repeat(code.length - 2)}\``));
  return [...text.matchAll(/```!\s*\n?[\s\S]*?\n?```/g), ...blanked.matchAll(/(?<=^|\s)!`[^`]+`/gm)].map((m) => m[0]);
}

/**
 * What a front matter holds, line by line: its keys as written, and any other line whole. Claude Code 2.1.310 grants tools
 * from `allowed-tools` and reads `hooks` here (the binary): lines, not a reader of keys, so a quoted key or a list counts.
 * The block as the binary's pattern finds it, a CRLF file too; one opened and never closed is no clean read, so it counts.
 * @param {string} text
 */
function frontMatterLines(text) {
  if (!/^\s*---/.test(text)) return [];
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return block ? block[1].split("\n").map((line) => line.split(":")[0]) : ["a front matter no pattern closes"];
}

/** Whether an `.npmrc` keeps install scripts off as npm reads it: one assignment of the key, `true`, and no section at all. @param {string} text */
function scriptsKeptOff(text) {
  const set = npmrcEntries(text).filter((x) => x.key === "ignore-scripts");
  return set.length === 1 && set[0].value === "true" && !set[0].list && !/^\s*\[/m.test(text);
}

/** What a package.json brings in beyond dev dependencies at one exact version each: any other section, and any version that is a URL or a range. @param {Record<string, any>} pkg */
const packagesBeyond = (pkg) => [...Object.keys(pkg).filter((k) => k !== "devDependencies" && /dependenc|overrides/i.test(k)), ...Object.entries(pkg.devDependencies ?? {}).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version)).map(([name]) => name)];

/** The markup a drawing needs, as this icon uses it: nothing that loads, runs or embeds. */
const ICON_MARKUP = new Set(["circle", "defs", "feColorMatrix", "feComposite", "feGaussianBlur", "feTurbulence", "filter", "linearGradient", "path", "radialGradient", "rect", "stop", "svg"]);

/** The attributes those need, as this icon uses them: no handler, no `href`, nothing that loads. */
const ICON_ATTRIBUTES = new Set(["baseFrequency", "cx", "cy", "d", "fill", "filter", "gradientUnits", "height", "id", "in2", "numOctaves", "offset", "opacity", "operator", "r", "rx", "seed", "stdDeviation", "stop-color", "stop-opacity", "stroke", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "stroke-width", "transform", "type", "values", "viewBox", "width", "x", "x1", "x2", "xmlns", "y", "y1", "y2"]);

/** Every word inside a tag but its name, quoted values left out: an unquoted value counts, as an attribute's name would, and so does the odd quote a `>` in a value leaves. @param {string} text */
const iconAttributes = (text) => [...text.matchAll(/<[^\s>/!?]+([^>]*)>/g)].flatMap((m) => m[1].replace(/"[^"]*"|'[^']*'/g, " ").match(/[^\s=/]+/g) ?? []);

/** What an SVG holds beyond a drawing: other markup (`<!` and `<?` read as names, so they count) or attributes, a reference out of the file, an import, or the `&` or `\\` that would spell one. @param {string} text */
const iconExtras = (text) => [...[...text.matchAll(/<\/?([^\s>/]*)/g)].map((m) => m[1]).filter((name) => !ICON_MARKUP.has(name)), ...iconAttributes(text).filter((name) => !ICON_ATTRIBUTES.has(name)), ...(text.match(/url\((?!#)|@import|&|\\/gi) ?? [])];

/** Every file below a folder, none when it is not there. @param {string} dir @param {string} [root] @returns {string[]} */
const filesBelow = (dir, root = ROOT) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/")) : []);

/** Where Claude Code 2.1.310's plugin loader reads Markdown by default (the binary). Its `themes` hold JSON and its `workflows` scripts, so neither has front matter. @param {string} [root] */
const pluginMarkdown = (root = ROOT) => ["skills", "agents", "commands", "output-styles"].flatMap((folder) => filesBelow(folder, root));

/** The files of those whose front matter can grant something: an agent's is held by its `tools` line. @param {string} [root] */
const grantingFiles = (root = ROOT) => pluginMarkdown(root).filter((f) => !f.startsWith("agents/") && (!f.startsWith("skills/") || /\/skill\.md$/i.test(f)));

/** Whatever a front matter holds but a name and a description. @param {string} text */
const beyondName = (text) => (frontMatterLines(text) ?? []).filter((line) => !["name", "description"].includes(line));


test("plugin: what SECURITY.md says of this repository's own files holds: no runtime dependency, no install script, tools a reviewer is given, no shell a skill runs, an icon that runs nothing", () => {
  const pkg = JSON.parse(read("package.json"));
  // Only the dev dependencies, each at one exact version: a URL or a range would be another package tomorrow.
  assert.deepEqual(packagesBeyond({ devDependencies: { a: "1.2.3" } }), []);
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides"]) assert.deepEqual(packagesBeyond({ [key]: {} }), [key]);
  for (const version of ["^1.2.3", "~1.2.3", "1.2.x", "latest", "https://example.invalid/a-1.2.3.tgz", "git+https://example.invalid/a#1.2.3", "npm:b@1.2.3"]) assert.deepEqual(packagesBeyond({ devDependencies: { a: version } }), ["a"], version);
  assert.deepEqual(packagesBeyond(pkg), [], "package.json has no runtime dependency");
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "typescript"]);
  // An allow list: npm ci runs names no prefix tells, `dependencies` among them (npm 10.9.9, measured).
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["test", "test:linux", "test:reference", "test:short", "typecheck", "validate:plugin"], "no script npm runs by itself");
  assert.ok(scriptsKeptOff("ignore-scripts=true\n"));
  for (const text of ["ignore-scripts=true\nignore-scripts=false\n", "[x]\nignore-scripts=true\n", "ignore-scripts=true\n[x]\n", "ignore-scripts=false\n", "; ignore-scripts=true\n", "ignore-scripts[]=true\n", "IGNORE-SCRIPTS=true\n", ""]) assert.ok(!scriptsKeptOff(text), text);
  assert.ok(scriptsKeptOff(read(".npmrc")), ".npmrc keeps install scripts off");
  // A plugin agent's hooks, mcpServers and permissionMode are ignored (2.1.310, read from the binary); its tools are not.
  // The model of each agent is named (2.1.310 honours a plugin agent's `model`): reviewers the session's, the two helpers haiku and without a shell.
  const helpers = ["scout", "summarizer"];
  for (const a of agents) {
    const fm = frontMatter(read(a.path));
    const helper = helpers.includes(a.name);
    assert.equal(fm?.get("tools"), helper ? "Read, Grep, Glob" : "Read, Grep, Glob, Bash", a.path);
    assert.equal(fm?.get("model"), helper ? "haiku" : "inherit", a.path);
  }
  assert.equal(agents.filter((a) => helpers.includes(a.name)).length, helpers.length, "the helper agents exist");
  // The positive control: what a loader runs, and the `!` these skills write as a word, which it does not.
  assert.equal(shellForms("x\n!`id`\n").length, 1);
  assert.equal(shellForms("x !`id`").length, 1);
  assert.equal(shellForms("```!\nid\n```\n").length, 1);
  assert.deepEqual(shellForms("On a `!`, propose the line `a`.\n"), []);
  // Every folder the loader reads, the day one exists: a command is a skill's sibling, and an output style can force itself on.
  const box = mkdtempSync(join(tmpdir(), "pl-folders-"));
  for (const f of ["commands/sub/go.md", "output-styles/s.md", "agents/a.md", "skills/s/SKILL.md", "skills/s/notes.md", "styles/x.md"]) {
    mkdirSync(dirname(join(box, f)), { recursive: true });
    writeFileSync(join(box, f), "");
  }
  assert.deepEqual(pluginMarkdown(box).sort(), ["agents/a.md", "commands/sub/go.md", "output-styles/s.md", "skills/s/SKILL.md", "skills/s/notes.md"]);
  assert.deepEqual(grantingFiles(box).sort(), ["commands/sub/go.md", "output-styles/s.md", "skills/s/SKILL.md"]);
  for (const f of pluginMarkdown()) assert.deepEqual(shellForms(read(f)), [], f);
  // Nothing a loader grants: a tool list as a value, as a list, under a quoted key, in a CRLF file, past a block left open.
  assert.deepEqual(beyondName("---\nname: a\ndescription: b\n---\n"), []);
  assert.deepEqual(beyondName("---\ndescription: b\n---\n"), []);
  assert.deepEqual(beyondName("no front matter\n"), []);
  assert.deepEqual(beyondName("---\r\nname: a\r\n---\r\n"), []);
  assert.deepEqual(beyondName("---  \nname: a\n---  \n"), []);
  for (const text of ["---\nname: a\nallowed-tools: Bash\n---\n", "---\nallowed-tools:\n  - Bash\n---\n", '---\n"allowed-tools": Bash\n---\n', "---\nhooks: x\n---\n", "---\nforce-for-plugin: true\n---\n", "---\r\nallowed-tools: Bash\r\n---\r\n", "---  \nallowed-tools: Bash\n---  \n", "---\nallowed-tools: Bash\n"]) assert.notDeepEqual(beyondName(text), [], text);
  assert.ok(grantingFiles().length >= 2);
  for (const f of grantingFiles()) assert.deepEqual(beyondName(read(f)), [], f);
  // The positive control of the icon's lists: each way a file could do more than draw, then the file.
  assert.deepEqual(iconExtras('<svg><path d="M0 0"/></svg>'), []);
  assert.deepEqual(iconExtras('<rect fill="url(#a)"/>'), []);
  const beyond = { onload: '<svg onload="x"></svg>', onclick: "<rect onclick='x'/>", unquoted: "<rect onclick=x />", href: '<linearGradient href="#x"/>', xlink: '<linearGradient xlink:href="x"/>', filter: '<filter href="x"/>', data: '<rect href="data:text/html,x"/>', past: '<svg id=">" onload="x">', style: '<rect style="fill:red"/>', script: "<script/>", embed: '<iframe src="x"/>', image: '<image href="x"/>', use: '<use href="x"/>', styleSheet: "<style>a{}</style>", pi: '<?xml-stylesheet href="x"?>', outside: '<rect fill="url(https://example.invalid/x#a)"/>', quoted: "<rect fill=\"url('https://example.invalid/x')\"/>", upper: '<rect fill="URL(x)"/>', import: "@import 'x';", doctype: '<!DOCTYPE svg [<!ENTITY s "x">]>', entity: '<rect fill="u&#114;l(x)"/>', escape: '<rect fill="u\\72 l(x)"/>' };
  for (const [what, text] of Object.entries(beyond)) assert.notDeepEqual(iconExtras(text), [], what);
  assert.deepEqual(iconExtras(read(".claude-plugin/icon.svg")), [], "the icon is paths and gradients");
});

test("plugin: every SKILL.md stays under 8 KB (DESIGN.md: skills are read whole, every time)", () => {
  for (const { path } of skills) assert.ok(statSync(join(ROOT, path)).size < 8 * 1024, `${path}: ${statSync(join(ROOT, path)).size} bytes`);
});

test("plugin: a core task answers the smallest-change row before its first edit, five rows or none, in its impact table's file; what it never cuts is said once, in text read on demand", () => {
  // A review of an agent skill's ladder (2026-10-25): what the task asks for, what the repository, the platform or a dependency
  // already does, only then new code; an independent run's robustness fell on input its tasks did not mention, so the never-cut
  // list stands beside the row. Pinned as whole lines, as the hand-written briefs' rules are.
  const holds = (/** @type {string} */ file, /** @type {string} */ line) => assert.ok(read(file).split("\n").includes(line), `${file}: ${line}`);
  // It reaches the agent by section 2 of the skill, which every brief's Protocol row names, and by the brief's own rows,
  // a restart's consolidated brief among them.
  holds("skills/cycle/SKILL.md", "3. **[Impact table](impact-table.md)** before the first edit: a core task's smallest-change row, always; the five rows only when the change touches a shared decision, predicate, gate or accept/reject rule: `ennyn.mjs impact --symbol <name> --files <paths>`. Each row is answered by a command's output, never by recall. Heuristic rules, dictionaries, thresholds: an accept **and** reject corpus and a failing test first.");
  holds("skills/cycle/task-brief.md", "| **Task** | the node, its slot, where its evidence is, what to deliver, the commit type |");
  holds("skills/cycle/task-brief.md", "| **Impact table** | its path, or `not needed` and why; a core task gets a path either way: its smallest-change row is answered there before the first edit, with the five rows or without them, and set against the diff before the commit. The agent writes what it learns there |");
  holds("skills/cycle/task-brief.md", "| **Node** | the task as it stands, its slot, and the failure count |");
  // The plan the brief is written from gives a core task's path too.
  assert.match(read("skills/cycle/report-formats.md"), /^1-2\. \[core tasks: [^\n]* — impact table: \[path, for the smallest-change row; the five rows required\/not needed \+ why\] — /m);
  const file = "skills/cycle/impact-table.md";
  holds(file, "Every core task answers it before its first edit, also when the five rows are skipped, in the file its impact table goes to. One line per new piece (a file, function, option, command or dependency), its cells in this order:");
  holds(file, "| Piece | Asked by | Already here | Done by | New code |");
  holds(file, "| its name | the line of the task (its node, its brief or a protocol step) that asks for it, quoted | `git grep -w` of its names and verbs, and what that found | the platform, git or an installed dependency, by running it (`--help`, a probe) with its version; or none | only what the three cells before it leave |");
  const kept = "validation of anything read from outside the process (stdin, files, arguments, pasted data), data-loss handling, security, accessibility, anything the task asks for.";
  holds(file, `A piece no line asks for is left out and named in one line, \`Left out: <piece>, …\`; a change that adds no piece writes \`No new piece\`. **Never cut**, even when no line asks for it: ${kept}`);
  holds(file, "A never-cut piece no line asks for still gets its line, with `never cut: <kind>` in its Asked by cell.");
  // Answered before writing, it is read again against what the commit holds, by the author before the commit and by the reviewer
  // after: the full diff, since a piece may be a function inside a file the row already names, which a list of files never shows.
  holds(file, "Before the commit, set the row against the full diff (`git diff --merge-base <base branch>` for tracked files, `git status --short --untracked-files=all` for new ones): a piece added while writing, a function or option in a file the row already names too, gets its line, and a piece the `Left out` line names is either out of the diff or moved from that line into the row with the line that asks for it.");
  // The reviewer reads the finding schema, not this file: its sentence holds a core task's row alone, and names the never-cut kinds
  // itself, so a check no line asks for is the row's gap, never a piece to cut (cycle 20, round two).
  const review = "When the table holds a core task's smallest-change row, set it against the full diff: each new piece the diff holds, a function or option inside a file too, is in the row with the line of the task that asks for it; validation of anything read from outside the process, data-loss handling, security and accessibility need no asking line (`never cut`). A piece the row lacks, or its `Left out` line names, is a finding; for a never-cut piece the finding is the row's gap, never the piece.";
  holds("skills/cycle/finding-schema.md", review);
  for (const kind of ["validation of anything read from outside the process", "data-loss handling", "security", "accessibility"]) assert.ok(kept.includes(kind) && review.includes(kind), kind);
  const text = read(file);
  assert.ok(text.indexOf("## The smallest-change row") > text.indexOf("## The five rows") && text.indexOf("## The smallest-change row") < text.indexOf("## Heuristic rules"), "the row stands with the five rows");
  // Read on demand: the never-cut list whole once in the skills and agents, and no text a session loads before a skill runs names the row.
  const shipped = [...skills.flatMap(({ name }) => readdirSync(join(ROOT, "skills", name)).map((f) => `skills/${name}/${f}`)), ...agents.map((a) => a.path)];
  assert.deepEqual(shipped.filter((f) => read(f).includes(kept)), [file]);
  assert.equal(read(file).split(kept).length, 2, "said once");
  const styles = filesBelow("styles");
  assert.ok(styles.length > 0, "the styles are read");
  for (const f of styles) assert.ok(!/smallest-change/i.test(read(f)), f);
  const description = (/** @type {string} */ path) => frontMatter(read(path))?.get("description") ?? "";
  for (const { path } of [...agents, ...skills]) {
    assert.notEqual(description(path), "", `${path}: the description is read`);
    assert.ok(!/smallest-change/i.test(description(path)), path);
  }
});

test("plugin: the closing runs ennyn.mjs leftovers after its commit, and the handoff's leftover command, unmeasured when none is named", () => {
  // Before step 6's commit the closing's own graph, handoff and ledger are changes not committed (cycle 18's closing commit holds all of them).
  const line = String(read("skills/cycle/SKILL.md").split("\n").find((l) => l.startsWith("5. **Security checks:**")));
  for (const part of ["after step 6's commit `ennyn.mjs leftovers`", "and the handoff's leftover command (none: unmeasured)"]) assert.ok(line.includes(part), part);
  assert.match(read("skills/cycle/SKILL.md"), /`ennyn\.mjs leftovers --start` notes HEAD/);
  // An answer that comes after the closing's commit has a commit to land in, and the budget is recorded again.
  assert.ok(read("skills/cycle/report-formats.md").includes("goes into one follow-up commit with the graph and a fresh `ennyn.mjs budget --record`, before the push"));
});

test("plugin: the approval line of a loosening is the user's: the cycle skill says so, and the design lists every key a gate reads", () => {
  assert.ok(read("skills/cycle/SKILL.md").includes(`ask the user; \`${LOOSENING_LINE} <key>\` only on their plain yes for that key`));
  assert.ok(read("skills/cycle/SKILL.md").includes("a task agent stops and reports the keys"));
  assert.match(read("skills/cycle/task-brief.md"), /it stops and reports the keys and why the task needs them\. The orchestrator asks the user/);
  assert.ok(read("skills/init/gates.md").includes(`${LOOSENING_LINE} <key>, <key>`));
  const design = read("DESIGN.md");
  const section = design.slice(design.indexOf("## What a commit may loosen"), design.indexOf("## Module contracts"));
  for (const key of GATE_KEYS) assert.ok(section.includes(`\`${key}\``) || section.includes(`\`${key.split(".").at(-1)}\``), key);
  assert.match(section, /a tripwire and a record, not a boundary/);
  assert.match(read("SECURITY.md"), /a tripwire and a record, not a boundary/);
  // push.mode's approval is the same line: an agent that writes it lets its own bare push run unasked (cycle 27 audit).
  // Each document states the limit whole: who writes the line, what it turns on, and the ask rule that still stops it.
  const limit = "an agent that writes it itself turns `after-closing` on, and its next bare `git push` runs unasked where no ask rule stands";
  for (const doc of ["skills/cycle/push.md", "SECURITY.md"]) {
    assert.ok(read(doc).includes(limit), `${doc}: the approval an agent writes itself`);
    assert.doesNotMatch(read(doc), /agent (cannot|can't|can not) (grant|approve|give)/, `${doc}: an agent cannot approve the push`);
  }
  assert.ok(read("SECURITY.md").includes("under `push.mode` `after-closing` a bare `git push` the decision allows runs unasked where no ask rule stands"), "SECURITY.md: the push hook under after-closing");
});

test("plugin: under push.mode ask a push never holds a turn: the closing ends before the question, a waiting push holds nothing, a push runs only on a yes in the same exchange, and init's question names what each answer costs", () => {
  // 2026-11-17: a closing's git push asked on screen held an interactive turn 3.5 hours, and every run queued behind it; the
  // origin project hit the same stall. Each rule is pinned as its whole line (node push-ask-never-holds-turn).
  const holds = (/** @type {string} */ file, /** @type {string} */ line) => assert.ok(read(file).split("\n").includes(line), `${file}: ${line}`);
  holds("skills/cycle/push.md", "3. **`ask`:** the closing ends before the question, and nothing waits on the answer. Report, handoff and `journal close` come first: the handoff committed with the closing, `journal close` written, every line of the report settled. Then `ennyn.mjs journal wait \"push: N commits, <hash>\"` (push-check's count of every unpushed commit, HEAD's short hash) is the turn's last call. The closing's last message is the report, then the context step ([handover.md](handover.md)), and last the question: push these N commits, up to <hash>? It is the turn's last words: no tool call waits on the push, and none runs after the question.");
  holds("skills/cycle/push.md", "**A push that waits holds nothing.** The next cycle or one-task run starts on the unpushed branch; nothing in its start refuses one. `journal start` replaces the journal, so the old wait line is gone while that run goes on, and its closing writes the one line again with the new count. One later `git push` sends every waiting commit, and push-check judges them together: the paths of all of them, the test record on HEAD's tree.");
  holds("skills/cycle/push.md", "**The push on a yes.** Under `ask` the agent runs `git push` only as the direct answer to the user's yes to that question, in the same exchange, with HEAD still the hash asked about (moved: ask again): `journal wait --clear`, then the push, alone in its call and the last call of its turn; the same push retried once outside the sandbox on the same yes (a sandboxed push over SSH fails and is retried there: [../init/agent-mode.md](../init/agent-mode.md)) is still the push of that yes, and still the turn's last call when it runs; any other failure is followed only by `journal wait` writing the line again. Never on an earlier yes or a standing one (\"push whenever you like\", a yes in another session or before a clear): a standing yes is `after-closing`, which the user sets ([../init/gates.md](../init/gates.md), Who says yes to the push), and the session says so and asks this push's question instead of pushing into the prompt.");
  holds("skills/cycle/push.md", "5. **Report** the push under `### Push`: the mode, the count, and either the question (asked last, step 3) or the push made with its hash.");
  holds("skills/cycle/SKILL.md", "A critical problem (crash, data loss, auth break, blocker) may replace one core slot. Write the plan as [report-formats.md](report-formats.md) shows. Do not wait for approval between tasks; push only on the user's yes in the same exchange.");
  holds("skills/cycle/handover.md", "What waits for the user after the close (the push question) is still written with `journal wait`, and cleared with `journal wait --clear` when the push is made, so the line below says what waits now; the next `journal start` drops it, and that cycle's closing writes it again ([push.md](push.md)).");
  holds("skills/cycle/handover.md", "**A push waiting under `ask`.** The closing's turn ends on the push question, below the step this file names: route (1) enters plan mode in a later turn, never after the question in the same one. The user's yes to it, in the next message, gets the push as the last call of that turn; any other word goes on, and the next cycle starts on the unpushed branch. The waiting line is data: after a clear or in a new chat, a push is asked again before it runs.");
  holds("skills/cycle/journal.md", "| Something waits for the user (the push, another question), also after `journal close`; the next `journal start` drops it | `journal wait \"<one line>\"`, for the push `journal wait \"push: N commits, <hash>\"` ([push.md](push.md)); `journal wait --clear` when answered |");
  holds("skills/init/gates.md", "Ask it as its own question, before the ask rules are proposed: \"At the end of a cycle, who pushes? `ask` (default): the cycle closes, its commits wait, and you are asked; nothing is pushed while you are away and nothing waits on the answer. `after-closing`: the cycle pushes by itself, a plain `git push` to this branch's upstream, only when the closing's checks and the whole test passed on that commit; a plain `git push` then needs no yes at any other time either, tested or not. Either can be changed later.\" Then ask the agent's mode, as its own question too: [agent-mode.md](agent-mode.md).");
  holds("skills/init/gates.md", "- `ask`, a bare \"ok\" or no answer: write no key. Propose the `git push` rules with the rest.");
  // Section 3's step: the context step, then the question last; the detail is read on demand in push.md.
  holds("skills/cycle/SKILL.md", "7. **Push:** `ennyn.mjs worktrees --remove`; `ennyn.mjs test whole`, once (red: task-brief.md's Landing row); `ennyn.mjs push-check`; [handover.md](handover.md); under `ask` the closing ends first, the push question its last words ([push.md](push.md)).");
  // The closing's report is written from the template in the fence: a line below it is not in the report.
  const close = read("skills/cycle/report-formats.md").split("## End of cycle")[1] ?? "";
  const template = /```md\n([\s\S]*?)\n```/.exec(close)?.[1] ?? "";
  assert.ok(template.split("\n").includes("### Push            → N commits waiting, up to HEAD's hash; `push.mode`; the push made by after-closing (remote, branch, hash), or under `ask` the question, asked last: after the context step, the turn's last words, nothing pushed or waiting on it ([push.md](push.md))"), template);
  // No text left that asks for the push before the closing ends, or pushes on a yes it did not just get.
  for (const f of ["skills/cycle/SKILL.md", "skills/cycle/push.md"]) assert.doesNotMatch(read(f), /\*\*ask\*\* for push approval|state the count and ask for push approval/, f);
});

test("plugin: a brief names the task's gate, and a fix no review reads passes it: the agent before it amends, the orchestrator's rerun counted", () => {
  const brief = read("skills/cycle/task-brief.md");
  const row = (/** @type {string} */ name) => new RegExp(`^\\| \\*\\*${name}\\*\\* \\|.*$`, "m").exec(brief)?.[0] ?? "";
  const gate = row("Gate");
  for (const kind of ["in one line, by command:", "a browser check for a UI change", "the project's harness for a money path", "a test file otherwise", "the audited feature's own check", "for a security audit, the suites of the gates it touches, named in the brief", "until its report names the command", "`none` and why"]) assert.ok(gate.includes(kind), kind);
  // A line written before the fix cannot know where the fix lands: cycle 17's round-two errno fix passed the line its brief could have named.
  assert.ok(gate.includes("beside the test that proves a fix, never instead"), gate);
  assert.ok(brief.indexOf(gate) < brief.indexOf("## What the orchestrator keeps"), "the gate is a part of the brief");
  // The rule's one place: a brief's rows reach the agent, the state table does not.
  assert.ok(row("Protocol").includes("After every fix round, before it amends, it runs the brief's gate"));
  const report = row("Report");
  assert.ok(report.includes("the gate's command and result"));
  assert.ok(report.includes("for each fix, what exercises it: the gate, a test that failed first, or `none` and why (a comment, a case only another git or platform reaches); the orchestrator reads this when no review follows"), report);
  const fixed = row("Last round fixed");
  for (const part of ["The orchestrator reruns the task's gate on the amended commit", "before `Review-Rounds:` goes in", "Red in that rerun is a failed verification"]) assert.ok(fixed.includes(part), part);
  assert.match(brief, /^\*\*A failed verification\*\* is a result[^\n]*the task's gate after the last round's fixes/m);
  // The consolidated brief replaces the task's: without this the gate is lost at a restart.
  assert.ok(row("Verification").includes("the task's gate among them"));
  assert.match(read("skills/cycle/report-formats.md"), /^`\*\*Task N done:\*\*.* \| Gate: \[result · last round clean · none and why\] \| /m);
});

test("plugin: rules the cycle's hand-written briefs carried are in the shipped text: the reviewer's ask, the author's working rules, the closing's read of its briefs", () => {
  // Cycles 16 to 19 gave these only in briefs kept outside the repository; a project running Ennyn gets the shipped text alone.
  // Each rule is pinned as its whole line: a label pin let 9 of 10 hedges through in review (cycle 19). A rule contradicted
  // in other words in another file is past any pin here; review reads for that.
  const holds = (/** @type {string} */ file, /** @type {string} */ line) => assert.ok(read(file).split("\n").includes(line), `${file}: ${line}`);
  holds("skills/cycle/SKILL.md", "1. **Graph:** update every node whose status changed; every leftover real defect but a declined one, every ask of the user, and each brief rule [`### Briefs`](report-formats.md) sends to a node, becomes a node, as do step 3's class and a core split's step (nothing else does), at the end of the list, dated (`graph.fields.since`).");
  holds("skills/cycle/SKILL.md", "7. **Review**, once its restatement holds (task-brief.md), with the reviewers that match the change: `review.agents` when set, else Ennyn's (correctness, security, data correctness). Give them the task's node, the changed files, the impact table and [finding-schema.md](finding-schema.md). **Two rounds**; after them a failing test or the gate rerun, never another reader. For security work the path table replaces the round limit: list every way to reach the protected state first.");
  holds("agents/code-reviewer.md", 'You review a change you did not write. You ask two questions: **how does this break?** and **is the ask of the task\'s node met, all of it?** You report defects and gaps against the ask; you do not propose refactors, style changes or "nice to have" items.');
  holds("agents/code-reviewer.md", "- the task's node from the work graph: its ask is the requirement you check,");
  // A brief's gap read from the author's restatement before review (node brief-paraphrase): written before the first
  // edit, the report's opening, a ledger row against the brief.
  holds("skills/cycle/task-brief.md", "- **The brief's reading.** Before step 7 it reads the report's two paragraphs against the node's ask: one that misses or adds to the ask is a row with `source: brief` in its own rows file ([ledger-row.md](ledger-row.md)), and the brief is corrected before review. Convergence lists these rows under its block.");
  const briefText = read("skills/cycle/task-brief.md");
  for (const part of ["Before its first edit it writes two short paragraphs in its own words: what the task asks, and how the code it touches works now, as the brief describes it.", "| **Report** | its last message, in order: the Protocol row's two paragraphs, unchanged · changes ·"]) assert.ok(briefText.includes(part), part);
  holds("agents/code-reviewer.md", "3. **Then the ask.** Read the task's node and set each part of its ask against the change: a part not met, and a change the ask does not hold, is a finding of its kind (the finding schema's Scope).");
  holds("skills/cycle/finding-schema.md", "**Scope:** correctness (wrong result, crash, data leak, bypassed gate) and requirements: is the ask of the task's node met, all of it? The ask is the node plus the protocol's own steps (the sweep, the documents the change affects, a small fix of the task's own), so those are never unrequested. A requirement finding names its kind in its title: `missing` (not done), `partial` (done in part), `contradicts` (done against the ask) or `unrequested` (done, not asked). A completion claim, in the author's report or the commit message, is no evidence. Style, naming and refactoring suggestions are out of scope.");
  holds("skills/cycle/finding-schema.md", "**Prefer running to reading:** a test, a command or a harness through the real program over a code path read. A claim about what another program does (git, a shell, npm, Claude Code) is checked in that program, with its version, never from memory.");
  const schema = read("skills/cycle/finding-schema.md");
  assert.ok(schema.indexOf("**Prefer running to reading:**") < schema.indexOf("## Fields"), "the reviewer reads it before the fields");
  const rules = "| **Rules** | prefer running to reading; a claim about what another program does (git, a shell, npm, Claude Code) is checked in that program, with its version, never from memory. Stay in the task: what is small and the task's own is fixed (a finding as finding-schema.md's Outcome says), the rest goes back as a proposed node (id, one-line title, source). No `git stash` in a worktree: the stash is shared across worktrees. The snapshot ref below keeps a copy; to look at the base, read it from git (`git show <start>:<path>`) or a throwaway worktree. A test run keeps its exit status (`set -o pipefail`, or a log file read afterwards). A command that passed is not run again on an unchanged tree. Stop only a process you started, by its PID or process group: never a kill chosen by a filter, a name, a window title or a port (`taskkill /FI` or `/IM`, `Stop-Process -Name`, `pkill`, `killall`, `kill $(lsof …)`); the user's own programs may be open. A test writes only in temporary folders it made; one that reads the user's settings runs with a temporary `HOME` (and the tool's own config folder, such as `CLAUDE_CONFIG_DIR`); a lab that runs a destructive command (a kill, a delete, a push) runs it in a box the operating system bounds, or runs a harmless stand-in. A design on a safety path (what refuses, what deletes, what pushes) is measured on the real program before it goes into a brief: a design argued from reading failed in review there time after time. |";
  holds("skills/cycle/task-brief.md", rules);
  const brief0 = () => read("skills/cycle/task-brief.md");
  // A changelog every task adds to conflicts at each landing: the agent reports its line, the orchestrator writes it (cycles 25-27's briefs).
  assert.ok(brief0().includes("and any file every task adds to (a changelog): the agent gives that line in its report and the orchestrator writes it at landing"));
  holds("skills/cycle/push.md", "1. `git fetch` first: the user may have pushed from another machine. A branch behind its upstream is not pushed; rebase, and the tests run on the new tree. Before the whole test command, note `git rev-parse HEAD`.");
  // A reviewer once stopped its own hung process by a window-title filter that matches every window: each reviewer holds the rule.
  const kill = "**Stop only a process you started, by its PID or process group**: never a kill chosen by a filter, a name, a window title or a port (`taskkill /FI` or `/IM`, `Stop-Process -Name`, `pkill`, `killall`, `kill $(lsof …)`); the user's own programs may be open.";
  holds("agents/code-reviewer.md", `5. ${kill}`);
  holds("agents/security-reviewer.md", kill);
  holds("agents/data-reviewer.md", `6. ${kill}`);
  const brief = read("skills/cycle/task-brief.md");
  assert.ok(brief.indexOf(rules) < brief.indexOf("## What the orchestrator keeps"), "the rules are a part of the brief");
  // Cycles 36 to 41 gave this one only in briefs and the handoff: claude -p stops background work its ceiling after the last
  // turn ended (node headless-run-keeps-turn). The agents' half is a part of the brief, a reviewer's too.
  const longJobs = "| **Long jobs** | waited for in the foreground. A call that outlasts its `timeout` (at most 10 minutes in Claude Code 2.1.310) is moved to the background, and that is no wait: the next call waits again. A job that may outlast one call starts in the background with its `timeout` set past the job's length (a background call is stopped at its own, at most 7200000 ms, and then writes no exit file), its exit status written to a file; then foreground calls, one after another until the file is there, each a loop bounded under the call's limit (`i=0; while [ ! -f <file> ] && [ $i -lt 270 ]; do sleep 2; i=$((i+1)); done` under a 600000 ms `timeout`; a leading `sleep 30` is blocked). A job stopped (the tool's notice, or its limit passed with no file) is a failed run, never waited on. The agent never ends its turn while a job it started runs: a foreground agent's background job is stopped at its final response, and a background agent that ends its turn is only said to resume on its own, so the job dies or its result reaches no one. A tool call that comes back rejected with no reason is retried once only where the agent's shell holds `CLAUDE_CODE_SESSION_ATTENDED=0` (read so in a runner's shells, Claude Code 2.1.310; its value in an interactive session is unmeasured); a second rejection, or one anywhere else, is the user's no: the agent stops and reports the command. A refusal that gives its reason (a hook's, a rule's, the shell tool's block) is answered by that reason, never retried |";
  holds("skills/cycle/task-brief.md", longJobs);
  assert.ok(brief.indexOf(longJobs) < brief.indexOf("## What the orchestrator keeps"), "the long jobs are a part of the brief");
  holds("skills/cycle/task-brief.md", "- **Its turn.** In a runner in a terminal (`claude -p`), Claude Code 2.1.310 stops the background work still running `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` after the last turn ended (600000 ms by default; read in the program, not run). Cycle 36's two losses match it: an agent's tool call came back rejected 10 minutes after the orchestrator's turn ended, to the second, and an agent's mutation run stopped writing about 10 minutes after the next one ended. There the orchestrator does not end its turn while an agent works or a job runs whose result it waits for: the Agent call runs in the foreground (`run_in_background: false`), or foreground calls, each under 10 minutes and bounded as the **Long jobs** row's loop, wait until the agent's `subagents/agent-<id>.meta.json` holds `\"finished\":true` (2.1.310) or the job's exit file is there. A transcript's last line is no done test: a finished agent's can be bookkeeping. `finished` ends the wait, not the work: an agent that ended its turn on its own background job is `finished` too. So the orchestrator reads the agent's last message: one that is not its report (it says it waits on a job) breaks the **Long jobs** row, and a message sends the agent back to wait for its job in the foreground and report, as **Lost or waiting** below, not a failure. An agent sent work with `SendMessage` has no foreground call and its `finished` is cleared, so the waits hold there too. The waits end: an agent with no `finished` and no new line for 30 minutes, in its transcript or in that of an agent whose `meta.json` names it as `parentAgentId`, is **Lost or waiting**, never a silent wait. The runner keeps the default ceiling: `0` waits with no end, so one forgotten job would hold the run and the heavy-job queue behind it, and staying in the turn holds either way. An interactive session gets an agent's completion as a notification in a later turn, and no loss was measured there.");
  holds("skills/cycle/task-brief.md", "It does not get the author's reasoning. It works in a **folder of its own**, on a real copy of the commit, and its probes and harnesses stay there for the author to rerun. Its brief carries the **Long jobs** row, as an author's does. All findings of a round go to the author in one message.");
  holds("skills/cycle/one-task.md", "**A runner in a terminal** keeps its turn while the agent works: task-brief.md, What the orchestrator keeps, **Its turn**.");
  // The closing writes its report from the template in the fence: a line below the fence is not in the report.
  const close = read("skills/cycle/report-formats.md").split("## End of cycle")[1] ?? "";
  const template = /```md\n([\s\S]*?)\n```/.exec(close)?.[1] ?? "";
  assert.ok(template.split("\n").includes("### Briefs          → each rule the cycle's hand-written briefs gave that did work, read against the skill's text: the file that holds it, the node that brings it in, or the project's own (its paths, its machine, its own ceilings); none when no brief was written"), template);
  // The batch's verdicts reach the user in the report, a clarify's question with them, and the cycle's declined count.
  assert.ok(template.split("\n").includes("### Verdicts        → each proposed node of the batch: go, clarify with its question for the user, or decline with its one reason; nodes declined this cycle: N, from doctor's declined count at the start and now; none when no batch was read; open nodes at the start and now"));
  // Each rule once in the skill and the agents: the author's brief and the reviewer's schema are two readers, so running and the other program are said in both.
  const shipped = [...skills.flatMap(({ name }) => readdirSync(join(ROOT, "skills", name)).map((f) => `skills/${name}/${f}`)), ...agents.map((a) => a.path)].map(read).join("\n").toLowerCase();
  const count = (/** @type {string} */ s) => shipped.split(s.toLowerCase()).length - 1;
  for (const once of ["`git stash` in a worktree", "pipefail", "unchanged tree", "completion claim", "`unrequested`", "hand-written briefs", "`sendmessage`", "`run_in_background: false`", "`claude_code_print_bg_wait_ceiling_ms`", "`claude_code_session_attended=0`", "`subagents/agent-<id>.meta.json`", "`parentagentid`", "never retried"]) assert.equal(count(once), 1, once);
  for (const twice of ["prefer running to reading", "checked in that program"]) assert.equal(count(twice), 2, twice);
});

test("plugin: a run of one named node or fix: SKILL.md points to one-task.md, which keeps section 2 and section 3 whole and leaves out section 1's slots", () => {
  // SKILL.md stands at Codex's 8,000-byte cut, so the run's text is a file beside it. Each rule is pinned as its whole line.
  const skill = read("skills/cycle/SKILL.md");
  const lines = read("skills/cycle/one-task.md").split("\n");
  assert.ok(skill.split("\n").includes("A node or fix asked for alone: [one-task.md](one-task.md)."), "the pointer");
  for (const line of [
    "**When:** the request, or the skill's arguments, name one graph node or describe one fix. Claude Code adds the arguments to the skill's text as a last line `ARGUMENTS: …`, so a runner in a terminal names the node it runs: the skill's command, then the node's id. Nothing named, or a cycle asked for: section 1 of `SKILL.md`.",
    "**A cycle open** on this clone, started and not closed (this session runs it, or `ennyn.mjs worktrees` lists a worktree marked with a number past the handoff's last cycle): the run does not start, and says so. In that cycle's session a fix in words becomes a node at its closing (section 3, step 1); from another session nothing is written.",
    "**Start** as section 1 does: `ennyn.mjs doctor` shows no ✗ (else stop); the config, the handoff and the graph are read in one turn; `ennyn.mjs leftovers --start` notes HEAD.",
    "**A node named:** an open node of the graph. Done, or no such id: stop and say so; never take a near id for it. Not ready (a `needs` not done, a closed gate): say why, and go on only on the user's plain yes.",
    "**A fix in words:** an open node that already asks for it is the task; else write it first as a node at the end of the list, dated (`graph.fields.since`), its source the user's words and the date. The reviewers check the change against a node's ask, and the rows and the closing name it.",
    "**Nobody to ask** (a runner in a terminal): where this file asks, the run stops and says why.",
    "**The task** runs in a fresh agent on a common brief and a task brief, as a task of a cycle does, in a marked worktree ([task-brief.md](task-brief.md)); on a restart the consolidated brief replaces the task brief and the common brief stays. The session is the orchestrator: the plan, step 7, the verdicts, the failure count, the landing. The session that reruns a verdict's numbers and lands the commit is not the one that wrote it, and a restart takes a fresh agent anyway. A host with no subagents: as task-brief.md says.",
    "**Protocol:** section 2 of `SKILL.md`, every step, split between the agent and the session as in a cycle.",
    "**Its number:** the run is a cycle of one task. It takes the next number after the handoff's last cycle, and the next cycle follows it. That number is every row's `cycle`, the rows' ids (`c<N>-t1-…`), the worktree mark (`ennyn:<N>`) and `ennyn.mjs convergence --cycle <N>`, so the command counts this run's rows and no other's. Under the last cycle's number, the counts of a closed cycle would change.",
    "**A fix's defect** is one row of round 0: its code is older than the run's start, so `pre-existing`, with `bornIn` ([report-formats.md](report-formats.md)), and `caughtBy` what reproduced it. A node that asks for something new has no such row.",
    "**Plan,** three lines: `**One task:** [node id, value and cost; for a fix, the node written for it] — impact table: [required/not needed + why] — checks: [tests, mutation, reviewers]`, then the cycle plan's `**Security:**` and `**Agent mode:**` lines as [report-formats.md](report-formats.md) writes them.",
    "**Closing:** section 3 of `SKILL.md`, every step: graph, handoff, convergence, retire lessons, security checks, budget, push. The handoff names the run (cycle N, one task, its node) and keeps the next step for the next cycle.",
    "**Left out:** section 1's slots (core, mechanization, legacy audit), the picks that fill them, and the cycle plan's `**Discovery:**` and `**Tasks:**` lines.",
    "**Budget:** `ennyn.mjs budget --record` without `--security-audit`: the run has no audit slot. The record counts as a cycle toward `security.everyCycles`, so work done brings the security audit nearer; when `ennyn.mjs audit` says it is due, the report says the next cycle of four holds it.",
    "**Report:** as [report-formats.md](report-formats.md) gives a cycle's: `**Task 1 done:**` or `**Task 1 stopped:**`, then `## Cycle complete` with `### Done` holding result 1 and `### Audit` reading `none: one task`, with the security audit's answer when it is due.",
  ]) assert.ok(lines.includes(line), line);
  // A run started while a cycle is open would take its number and replace its start record: the check comes before `--start`.
  assert.ok(lines.indexOf("**A cycle open** on this clone, started and not closed (this session runs it, or `ennyn.mjs worktrees` lists a worktree marked with a number past the handoff's last cycle): the run does not start, and says so. In that cycle's session a fix in words becomes a node at its closing (section 3, step 1); from another session nothing is written.") < lines.findIndex((l) => l.startsWith("**Start**")), "the open-cycle check comes first");
  // Two briefs, as a cycle's task: a restart replaces the task brief, so the run's Paths, Protocol, Commands and Rules stay.
  assert.ok(read("skills/cycle/task-brief.md").split("\n").includes("**The consolidated brief** replaces the task's brief; the common brief stays."));
  // Asked in words, a model picks a skill by its listing: the description names the run.
  assert.match(frontMatter(skill)?.get("description") ?? "", /, or to run one named node or fix alone\.$/);
  // Read from SKILL.md, not copied: a step section 3 gains, or a slot section 1 gains, fails here until the run decides it.
  const closing = lines.find((l) => l.startsWith("**Closing:**")) ?? "";
  const steps = [...(skill.split("## 3. End of cycle")[1] ?? "").matchAll(/^\d+\. \*\*([^*:]+):?\*\*/gm)].map((m) => m[1].toLowerCase());
  assert.ok(steps.length >= 7, steps.join(", "));
  for (const step of steps) assert.ok(closing.includes(step), `the closing leaves out ${step}: ${closing}`);
  const left = lines.find((l) => l.startsWith("**Left out:**")) ?? "";
  const slots = [...(skill.split("## 1.")[1]?.split("## 2.")[0] ?? "").matchAll(/^\| ([^|]+?) ×\d+ \|/gm)].map((m) => m[1].toLowerCase());
  assert.ok(slots.length >= 3, slots.join(", "));
  for (const slot of slots) assert.ok(left.includes(slot), `the run keeps ${slot}: ${left}`);
  // Each line of the cycle plan's template is kept in the run's plan or left out by name: a security line is never dropped unsaid.
  const plan = lines.find((l) => l.startsWith("**Plan,**")) ?? "";
  const template = /## Cycle plan\n+```md\n([\s\S]*?)\n```/.exec(read("skills/cycle/report-formats.md"))?.[1] ?? "";
  const labels = [...template.matchAll(/^\*\*([^*]+):\*\*/gm)].map((m) => `**${m[1]}:**`);
  assert.ok(labels.length >= 3, labels.join(", "));
  for (const label of labels) assert.ok(plan.includes(label) !== left.includes(label), `${label} is kept or left out, once: ${plan} | ${left}`);
  // The node reaches the skill as its arguments, appended as `ARGUMENTS: …` only when no placeholder takes them; a `$1`
  // in the text would take the argument in its place (Claude Code 2.1.97's cli.js, and the skills docs read 2026-11-04).
  for (const { path } of skills) assert.doesNotMatch(read(path), /\$(?:ARGUMENTS|\d)/, path);
});

/** The tree as test/guards.test.mjs cloneOfTree reads it: what git lists, tracked or not, that is there. @param {string} root @param {string} folder */
const treeFiles = (root, folder) =>
  git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", folder], { cwd: root })
    .split("\0")
    .filter((f) => f && existsSync(join(root, f)));

test("plugin: a skill links every file of its tree beside its SKILL.md, and every link in its files leads to a file", () => {
  // These files load on demand: one the SKILL.md does not name is never read, one a skill names and is gone is a step that cannot be taken.
  // The tree, not the index or the folder: a file not yet added counts, a .DS_Store does not. Read as a model reads them, so a link in a fence still names the file.
  const box = mkdtempSync(join(tmpdir(), "pl-tree-"));
  git(["init", "-q"], { cwd: box });
  mkdirSync(join(box, "s"));
  for (const [f, text] of [[".gitignore", "ignored\n"], ["s/kept", ""], ["s/removed", ""]]) writeFileSync(join(box, f), text);
  git(["add", "-A"], { cwd: box });
  rmSync(join(box, "s/removed"));
  for (const f of ["s/new", "s/ignored"]) writeFileSync(join(box, f), "");
  assert.deepEqual(treeFiles(box, "s").sort(), ["s/kept", "s/new"]);

  const linked = (/** @type {string} */ text) => [...new Set([...text.matchAll(/\]\((?![a-z]+:)([^)#\s]+)/g)].map((m) => posix.normalize(m[1])))].sort();
  assert.deepEqual(linked("[b](./b.md) [a](a.md#rounds) [b](b.md) [site](https://example.com/c.md)"), ["a.md", "b.md"]);
  for (const { path, name } of skills) {
    const folder = `skills/${name}`;
    const files = treeFiles(ROOT, folder);
    assert.deepEqual(linked(read(path)), files.filter((f) => f !== path).map((f) => posix.relative(folder, f)).sort(), path);
    for (const f of files) for (const target of linked(read(f))) assert.ok(existsSync(join(ROOT, dirname(f), target)), `${f}: ${target}`);
  }
});

test("plugin: the snapshot script in task-brief.md keeps an unfinished tree in a ref, and fails where it keeps nothing", () => {
  const script = /```sh\n([\s\S]*?)```/.exec(read("skills/cycle/task-brief.md"))?.[1].replace(/^ {2}/gm, "");
  assert.ok(script, "the script is in the brief");
  const dir = mkdtempSync(join(tmpdir(), "pl-snapshot-"));
  const file = join(dir, "snapshot.sh");
  writeFileSync(file, script);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), "ignored\n");
  writeFileSync(join(repo, "tracked"), "a\n");
  git(["add", "-A"], { cwd: repo });
  const who = ["-c", "user.name=t", "-c", "user.email=t@t"];
  git([...who, "commit", "-q", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "tracked"), "b\n");
  writeFileSync(join(repo, "untracked"), "c\n");
  writeFileSync(join(repo, "ignored"), "d\n");
  const status = git(["status", "--porcelain"], { cwd: repo });
  const head = git(["rev-parse", "HEAD"], { cwd: repo });
  const run = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) =>
    spawnSync("sh", [file, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env } });
  const refs = () => git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/snapshot"], { cwd: repo });

  assert.notEqual(run([]).status, 0, "no name: no silent success");
  assert.equal(refs(), "");

  assert.equal(run(["t1"]).status, 0);
  assert.equal(git(["show", "refs/snapshot/t1:tracked"], { cwd: repo }).trim(), "b");
  assert.deepEqual(git(["ls-tree", "--name-only", "refs/snapshot/t1"], { cwd: repo }).trim().split("\n"), [".gitignore", "tracked", "untracked"]);
  assert.equal(git(["rev-parse", "refs/snapshot/t1^"], { cwd: repo }), head);
  assert.equal(git(["status", "--porcelain"], { cwd: repo }), status);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: repo }), head);

  const kept = refs();
  writeFileSync(join(repo, "tracked"), "e\n");
  assert.notEqual(run(["t1"], { GIT_AUTHOR_NAME: "" }).status, 0, "git refuses the identity: the script says so");
  assert.notEqual(run(["no such"]).status, 0, "git refuses the name: the script says so");
  assert.equal(refs(), kept, "and the last snapshot stands");
});

test("plugin: the cycle's worktrees: the closing removes the marked ones before the push, and the brief's squash commits in Claude Code's shell", () => {
  const push = String(read("skills/cycle/SKILL.md").split("## 3. End of cycle")[1]?.split("\n").find((l) => l.startsWith("7. **Push:**")));
  assert.ok(push.indexOf("`ennyn.mjs worktrees --remove`") > 0 && push.indexOf("`ennyn.mjs worktrees --remove`") < push.indexOf("`ennyn.mjs push-check`"), push);
  // Claude Code's shell sets GIT_EDITOR=true: a commit that waits for its message aborts there (cycle 19).
  const squash = /`(git reset --soft \$\(git merge-base HEAD <base branch>\) && git commit[^`]*)`/.exec(read("skills/cycle/task-brief.md"))?.[1];
  assert.ok(squash, "the squash is in the brief");
  const repo = mkdtempSync(join(tmpdir(), "pl-squash-"));
  const who = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  git(["init", "-q", "-b", "main"], { cwd: repo });
  for (const [i, msg] of ["base", "one", "two"].entries()) {
    if (i === 1) git(["checkout", "-q", "-b", "task"], { cwd: repo });
    writeFileSync(join(repo, `${msg}.txt`), `${msg}\n`);
    git(["add", "-A"], { cwd: repo });
    git([...who, "commit", "-q", "-m", msg], { cwd: repo });
  }
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: repo });
  const env = { ...process.env, GIT_EDITOR: "true", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };
  const run = spawnSync("sh", ["-c", squash.replace("<base branch>", "main").replace("<subject>", "feat: one and two")], { cwd: repo, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(["rev-list", "--count", "main..HEAD"], { cwd: repo }), "1");
  assert.equal(git(["rev-parse", "HEAD^{tree}"], { cwd: repo }), tree);
  assert.equal(git(["log", "-1", "--format=%s"], { cwd: repo }), "feat: one and two");
});

test("plugin: the fix label /ennyn:init writes reads every form the commit gate admits as the fix type", () => {
  const line = String(read("skills/init/SKILL.md").split("\n").find((l) => l.startsWith("- `metrics.fixSubject`:")));
  const templates = [...line.matchAll(/`([^`]*<fixType>[^`]*)`/g)].map((m) => m[1]);
  assert.equal(templates.length, 2, line);
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-init-label-")), env: {}, override: { commitMsg: { types: ["özellik", "düzeltme"], fixType: "düzeltme" } } });
  for (const template of templates) {
    const label = new RegExp(template.replace("<fixSubject.proposal>", "^onarım").replace("<fixType>", "düzeltme"));
    for (const subject of ["düzeltme: a", "düzeltme(x): a", "düzeltme!: a", "düzeltme(x)!: a"]) {
      assert.ok(checkCommitShape(subject, { config }).ok, `the gate admits ${subject}`);
      assert.ok(label.test(subject), `${template} reads ${subject}`);
    }
  }
});

test("plugin: the repository asks before every command that leaves the machine, as /ennyn:init proposes", () => {
  // Read as the work tree holds it: whether git holds it committed is doctor's line, not this test's.
  const pf = projectFiles(ROOT);
  const res = askRules(pf, outwardCommands(["package.json"], true), { committed: (path) => ({ text: pf.read(path) ?? "" }) });
  assert.deepEqual(res.unread, []);
  assert.equal(res.rules.length, 38, "git push, npm publish and seventeen gh commands, each for Bash and PowerShell");
  for (const r of res.rules) assert.equal(r.where, "shared", `${r.rule} in .claude/settings.json`);
});

test("plugin: the repository writes no offered rule: it runs cycles, and such a rule stops them", () => {
  const ask = JSON.parse(read(".claude/settings.json")).permissions.ask;
  const held = askRules(projectFiles(ROOT), [...OFFERED.destroys, ...OFFERED.installs], { committed: () => ({ text: read(".claude/settings.json") }) }).rules.filter((r) => r.where !== null);
  assert.deepEqual(held, []);
  assert.equal(ask.some((/** @type {string} */ r) => /git (clean|reset|checkout|restore|branch|worktree|stash)/.test(r)), false);
});

test("plugin: Claude Code keeps the repository's ask rules as one file: the record holds that file whole, and its rules stop what they name", () => {
  const rec = JSON.parse(read("test/reference/claude-code.json"));
  // The whole file, not its ask list: one wrong value of any key and Claude Code skips the file, every ask rule with it.
  const own = JSON.parse(read(".claude/settings.json"));
  for (const id of ["repo-settings-whole-push", "repo-settings-whole-gh"]) {
    const cell = rec.cells.find((/** @type {{ id: string }} */ c) => c.id === id);
    assert.deepEqual(JSON.parse(cell.files[".claude/settings.json"]), own, `${id}: .claude/settings.json changed since the record; add cells holding it whole (node test/reference/claude-code.mjs add) and name them here`);
    assert.match(cell.cc.call, /^stopped/, id);
  }
});

test("plugin: /ennyn:init asks for the fast test on every path: the interview never skips it, and the new-project path asks it alone of question 3", () => {
  assert.ok(read("skills/init/SKILL.md").includes("Skip a question the survey has nothing for, but never the fast test."), "the interview");
  const step = String(read("skills/init/new-project.md").split("\n").find((l) => l.startsWith("3. **New**")));
  assert.ok(step.includes("From 3 ask only for the fast test"), step);
  assert.ok(step.includes('written to `commands.fastTest` (`{ "none": "<why>" }` for none)'), step);
  // A new project's survey is empty: a rule that skips question 3 whole would leave doctor's ✗ for the agent to fill unasked.
  assert.doesNotMatch(step, /Skip 3\b/, step);
});

test("plugin: /ennyn:init makes a new project's first commit before any install: what it holds and what npm cannot do", () => {
  const step = read("skills/init/new-project.md").split("4. **The first commit**")[1];
  assert.ok(step, "the step");
  assert.ok(read("skills/init/new-project.md").split("\n").find((l) => l.startsWith("3. **New**"))?.includes("then step 4"), "step 3 leads to it");
  // Secrets and keys as DESIGN.md's MACHINE_GLOBS name them, Claude Code's local settings, and build output; measured with git check-ignore.
  for (const line of [".env", ".env.*", "!.env.example", ".netrc", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*", "node_modules/", "dist/", "build/", ".claude/settings.local.json"]) assert.ok(step.includes(`\`${line}\``), line);
  for (const words of [
    "before any scaffold or install",
    "`.npmrc` with `ignore-scripts=true`",
    "`security.deps.cooldownDays`",
    "`ennyn install-hook --plugin-data \"${CLAUDE_PLUGIN_DATA}\"` before the commit",
    "`.claude/settings.json` with the ask rules",
    "`.ennyn/config.json`",
    // With no repository the files are still written; only the commit and the hook wait.
    "With no repository",
    "wait for a `git init`",
  ]) assert.ok(step.includes(words), words);
});

test("plugin: /ennyn:init's first commit sets npm's release age by the installed version, and the scripts guard where npm reads it", () => {
  const step = read("skills/init/new-project.md").split("4. **The first commit**")[1];
  // npm 11.10.0 first defines min-release-age, but up to 11.14.1 a git dependency's prepare or a `before` in the user's
  // config fails the install with it; 11.15.0 is the first where both pass (measured on the packed versions).
  for (const words of ["Read `npm -v`", "from 11.15.0", "`min-release-age=<days>` with the days of `security.deps.cooldownDays`", "Below 11.15.0", "the only age check", "`before`", "git dependency"]) assert.ok(step.includes(words), words);
  assert.doesNotMatch(step, /from 11\.10\.0(?:, the first npm that defines it,)? add/, "11.10.0 to 11.14.1 fail an install with the key");
  // npm 10 and 11.0.0 take an unknown key silently, 11.9.0 warns: no single word for every version below.
  assert.doesNotMatch(step, /takes it without a word/, "npm 11.9.0 warns");
  // npm finds its prefix by walking up to a package.json or node_modules/: a stray one above leaves the root's .npmrc unread.
  for (const words of ["the root included", "`npm prefix` prints that folder", "`pwd -P`", "install nothing until the user decides"]) assert.ok(step.includes(words), words);
  assert.doesNotMatch(step, /no release-age key and no `allowScripts`/, "npm 11.21 and 12 define allow-scripts");
  assert.doesNotMatch(step, /allow-scripts=/, "ignore-scripts already blocks every script");
  // A scaffold into a subfolder has its own package.json: the root .npmrc is not read there.
  for (const words of ["copy `.npmrc` there", "`npm config get ignore-scripts` prints `true`", "still hold their lines"]) assert.ok(step.includes(words), words);
  // pnpm's keys as its 12.16.1 package names them; uv's stay unmeasured.
  for (const words of ["pnpm 12.16.1", "`minimumReleaseAge`", "`allowBuilds`", "`strictDepBuilds`", "`exclude-newer`", "not measured", "only on the user's yes"]) assert.ok(step.includes(words), words);
});

test("plugin: /ennyn:init offers what destroys or installs apart, writes none unasked, and its report says what these rules cannot do", () => {
  const gates = read("skills/init/gates.md");
  assert.ok(read("skills/init/SKILL.md").includes("`agentSetup.offered`"), "the skill sends init to the list");
  // Plan approval's clear option: asked in question 4, written to the project's settings on a yes, never the user's.
  assert.ok(read("skills/init/SKILL.md").includes("`agentSetup.ask` rules, push mode, plan approval's clear option: [gates.md](gates.md); agent mode: [agent-mode.md](agent-mode.md)."));
  // The agent's mode: one question, nothing written unless taken, the measured values only, never the scrub variable.
  const mode = read("skills/init/agent-mode.md");
  for (const words of [
    '**As it is** (the default; "ok" or no answer): nothing is written.',
    "Only on a plain \"without bypass\". Write `proposal` as the scan gives it",
    "`disableBypassPermissionsMode` is the string `\"disable\"`, never `true`",
    "The block does not set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`",
    "`credentials` here holds `deny` entries only",
  ]) assert.ok(mode.includes(words), words);
  assert.ok(gates.includes("On the user's yes, write `\"showClearContextOnPlanAccept\": true` into `.claude/settings.json`, keeping every other key, and commit it with the config; never into the user's own settings"));
  // The closing's route through plan approval is one procedure: which session runs the state steps, and the cleared one picks nothing again.
  const handover = read("skills/cycle/handover.md").split("\n");
  for (const line of [
    "**Route (1), before the plan.** The old session, its closing done, reads what section 1 reads, runs `ennyn.mjs doctor`, picks the tasks as section 1 does, then enters plan mode (`EnterPlanMode`; the user approves) and writes the plan: the cycle's number, its tasks, and as its first steps `ennyn.mjs leftovers --start` and `ennyn.mjs journal start --cycle <N> --tasks <ids>`. It runs neither: plan mode writes nothing, and the start record is taken at the HEAD the new cycle begins from. It presents the plan (`ExitPlanMode`).",
    "**Route (1), after the clear.** The cleared session starts from the plan alone: it runs `ennyn.mjs leftovers --start`, then `ennyn.mjs journal start` with the plan's number and tasks, then goes on at section 2 with the plan's tasks. It does not pick again.",
    "The key is read merged, as Claude Code reads it: `.claude/settings.local.json` overrides `.claude/settings.json`, so check both.",
  ]) assert.ok(handover.includes(line), line);
  for (const words of [
    "These rules read command text and are no boundary: an option before the subcommand, a script or an interpreter gets past them.",
    "A rule here stops an unattended cycle: it cannot tell a task's worktree from the main checkout.",
    "Asked nothing, write nothing.",
    // The interview's other questions take "ok" as yes: this one must not, or a word about the rest writes these.
    'Its default is none: "ok" to this question writes none.',
    "They stop on text, so some harmless commands stop too:",
  ]) assert.ok(gates.includes(words), words);
  // Asked in the interview's one message, and "ok" there means cycles run: `pip install` stalls a cycle as `git clean` does.
  // A plain no is the only way to the offer, whose own default stays none. The report says why.
  const interview = read("skills/init/SKILL.md").split("## 2. Ask once")[1].split("## 3.")[0];
  const [asked, after] = interview.split("Nothing else is asked");
  assert.ok(asked.includes("Will cycles run unattended? Default yes; only a plain no opens `agentSetup.offered`."), "the question is in the one message");
  assert.match(after, /^ but that offer;/, "the offer is the one question after it");
  assert.ok(gates.includes('Yes, a bare "ok" or no answer: offer neither set.'));
  assert.ok(gates.includes("**On a plain no, offer** each set in one question"));
  assert.ok(!gates.includes("**Ask first**"), "a second interview");
  assert.ok(gates.includes("Neither set was offered: a rule on these commands stops an unattended cycle, since it cannot tell a task's worktree from the main checkout."));
  // No count of lines to go stale, and the skill's closed report list reaches them.
  assert.doesNotMatch(gates, /the (two|three|\d+) lines of step/);
  assert.ok(read("skills/init/SKILL.md").split("Report in at most")[1].includes("the lines gates.md says to report"), "the report list sends the agent to them");
  // True of what a project's hook can do, and of what a read's text can trigger.
  assert.ok(gates.includes("unless a `PermissionRequest` hook in the settings answers it"));
  assert.doesNotMatch(gates, /over any allow rule, and `\.claude\/settings\.json`/);
  assert.ok(gates.includes("A read whose text holds `-X POST` stops like a write"));
  // What stays open is one line, and gh api's limit says more than -f.
  for (const spelling of ["-XPOST", "-iX POST", "--method=POST"]) assert.ok(gates.includes(spelling), spelling);
});

test("plugin: the repository ignores .claude/worktrees/, where Claude Code puts agent worktrees, by its .gitignore, as /ennyn:init proposes", () => {
  // As the work tree holds it: doctor reads HEAD, and a guard edits the work tree of a clone.
  assert.ok(read(".gitignore").split("\n").includes(".claude/worktrees/"));
});

test("plugin: hook commands point at files that exist; manifests agree on name and version", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  const commands = Object.values(hooks).flatMap((/** @type {any[]} */ groups) => groups.flatMap((g) => g.hooks.map((/** @type {any} */ h) => h.command)));
  assert.ok(commands.length >= 3);
  for (const c of commands) {
    const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(c);
    assert.ok(m, `command names a file under the plugin root: ${c}`);
    assert.ok(existsSync(join(ROOT, m[1])), `${m[1]} exists`);
  }
  const pkg = JSON.parse(read("package.json"));
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(plugin.name, pkg.name);
  assert.equal(market.name, pkg.name);
  assert.deepEqual(market.plugins.map((/** @type {any} */ p) => p.name), [pkg.name]);
  // The install source is this repository's root: another repository or a URL would install code no review here read.
  assert.deepEqual(market.plugins.map((/** @type {any} */ p) => p.source), ["./"], "the marketplace entry installs from this repository's root");
  assert.equal(plugin.version, pkg.version, "a push without a version bump never reaches users; bump both together");
  // One description for the package, the plugin and its marketplace entry: the install description says what the hooks do.
  assert.deepEqual([plugin.description, market.plugins[0].description], [pkg.description, pkg.description]);
  // The plugin root is the repository root, so a root CLAUDE.md would be shipped and ignored.
  assert.ok(!existsSync(join(ROOT, "CLAUDE.md")), "developer notes live in .claude/CLAUDE.md");
});

/**
 * Markdown files below `dir`, relative. A walk of its own, so node_modules and .git are never entered (a recursive
 * read has no way to leave a folder out).
 * @param {string} dir @returns {string[]}
 */
function markdownFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : markdownFiles(rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

test("docs: no table cell holds an unescaped | inside code (GitHub splits the row there)", () => {
  const tracked = markdownFiles("");
  assert.ok(["docs/evidence.md", "skills/cycle/SKILL.md", "agents/code-reviewer.md", "README.md"].every((f) => tracked.includes(f)), `nested documents read: ${tracked.length}`);
  const bad = [];
  for (const f of tracked) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (!line.startsWith("|")) return;
        for (const span of line.match(/`[^`]*`/g) ?? []) if (/(?<!\\)\|/.test(span)) bad.push(`${f}:${i + 1} ${span}`);
      });
  }
  assert.deepEqual(bad, []);
});

test("plugin: the convergence block in report-formats.md is the one the formatter prints, label by label", () => {
  const block = formatConvergence({ perRound: [null, null, null] }, { language: "en" }).replaceAll("?", "N");
  assert.ok(read("skills/cycle/report-formats.md").includes(`\n${block}\n`), block);
});

test("plugin: the age commands in report-formats.md, run on real git, read a dirty tree, a rewritten line and a partial clone the way the text says", () => {
  const text = read("skills/cycle/report-formats.md");
  const blame = /`(git blame -w [^`]+)`/.exec(text)?.[1];
  const repair = /`(git blame … <base> -- <file>)`/.exec(text)?.[1];
  const inTree = /`(git ls-tree [^`]+)`/.exec(text)?.[1];
  assert.ok(blame && repair && inTree, "the three commands are in the text");
  const box = mkdtempSync(join(tmpdir(), "pl-age-"));
  const repo = join(box, "repo");
  mkdirSync(repo);
  const who = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const commit = (/** @type {string} */ message) => {
    git(["add", "-A"], { cwd: repo });
    git([...who, "commit", "-q", "-m", message], { cwd: repo });
    return git(["rev-parse", "HEAD"], { cwd: repo });
  };
  const sh = (/** @type {string} */ command, cwd = repo) => spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  const hash = (/** @type {string} */ command) => sh(command.replaceAll("<file>", "code.js")).stdout.split(" ")[0];
  const bornIn = (/** @type {number} */ n) => hash(blame.replaceAll("<n>", String(n)));
  const flags = blame.slice("git blame ".length, blame.indexOf(" -- <file>"));
  const atBase = (/** @type {number} */ n, /** @type {string} */ base) => hash(repair.replace("…", flags).replaceAll("<n>", String(n)).replace("<base>", base));
  const config = (/** @type {string} */ commit, /** @type {string} */ cwd) => {
    const { status, stdout } = sh(inTree.replace("<bornIn>", commit), cwd);
    return [status, stdout.trim()];
  };
  git(["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "code.js"), "legacy\n");
  const legacy = commit("legacy");
  mkdirSync(join(repo, ".ennyn"));
  writeFileSync(join(repo, ".ennyn", "config.json"), "{}\n");
  commit("adopt");
  writeFileSync(join(repo, "code.js"), "legacy\nloop\n");
  const loop = commit("a cycle");
  // Uncommitted lines above and below: the numbers are the file's as it stands.
  writeFileSync(join(repo, "code.js"), "new\nnew\nlegacy\nloop\nnew\n");
  assert.equal(bornIn(3), legacy);
  assert.equal(bornIn(4), loop);
  assert.match(bornIn(1), /^0{40}$/, "an uncommitted line is a zero hash");
  // The task rewrote the line: the blame names no old commit, the repair reads it where it stood.
  writeFileSync(join(repo, "code.js"), "legacy(1)\nloop\n");
  assert.match(bornIn(1), /^0{40}$/);
  assert.equal(atBase(1, loop), legacy);
  // The tree answers: the path, or exit 0 and nothing.
  assert.deepEqual(config(legacy, repo), [0, ""], "written in a tree with no config");
  assert.deepEqual(config(loop, repo), [0, ".ennyn/config.json"], "written in a tree with the config");
  // A count that runs in a subdirectory: a path read from there would print nothing, and nothing means pre-existing.
  mkdirSync(join(repo, "sub"));
  assert.deepEqual(config(loop, join(repo, "sub")), [0, ".ennyn/config.json"], "from a subdirectory too");
  // A partial clone with its origin gone: a blob that is not here changes nothing, a tree that is not here is no answer.
  git(["config", "uploadpack.allowFilter", "true"], { cwd: repo });
  const clone = (/** @type {string} */ filter) => {
    const dir = join(box, filter.replace(":", "-"));
    const made = spawnSync("git", ["clone", "-q", "--no-checkout", `--filter=${filter}`, pathToFileURL(repo).href, dir], { cwd: box, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    return dir;
  };
  const blobless = clone("blob:none");
  const treeless = clone("tree:0");
  const shallowTrees = clone("tree:1");
  rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(config(legacy, blobless), [0, ""]);
  assert.deepEqual(config(loop, blobless), [0, ".ennyn/config.json"]);
  assert.deepEqual(config(legacy, shallowTrees), [0, ""], "the root tree has no such folder");
  for (const [commit, dir] of [[legacy, treeless], [loop, treeless], [loop, shallowTrees]]) {
    const [status, printed] = config(commit, dir);
    assert.notEqual(status, 0, "a tree that is not here is no answer");
    assert.equal(printed, "");
  }
});

test("plugin: every caughtBy value report-formats.md names is in the closed set", () => {
  const gate = /^\*\*A gate\*\*.*$/m.exec(read("skills/cycle/report-formats.md"))?.[0] ?? "";
  const values = [...gate.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.ok(values.includes("review") && values.includes("test:<file>") && values.includes("gate:<name>"), gate);
  for (const value of values) assert.match(value, /^(?:review|measurement|author-reading|test:<file>|gate:[a-z<>:]+)$/, value);
});

test("i18n: every English key exists in every catalog, vars interpolate, fallback works", () => {
  const en = Object.keys(JSON.parse(read("i18n/en.json"))).sort();
  const catalogs = readdirSync(join(ROOT, "i18n")).filter((f) => f.endsWith(".json") && f !== "en.json");
  assert.ok(catalogs.includes("tr.json"), `catalogs: ${catalogs}`);
  for (const f of catalogs) assert.deepEqual(Object.keys(JSON.parse(read(`i18n/${f}`))).sort(), en, f);
  assert.match(t("shape.subjectTooLong", { len: 130, max: 120 }, "tr"), /130 karakter; sınır 120/);
  assert.throws(() => t("no.such.key"));
});

test("hooks.json: the PreCompact hook gets both triggers, and its own limits end inside the time Claude Code gives it", () => {
  const [entry] = JSON.parse(read("hooks/hooks.json")).hooks.PreCompact;
  assert.equal(entry.matcher, "auto|manual");
  assert.ok(GIT_MS * GIT_CALLS + SETTLE_MS < entry.hooks[0].timeout * 1000, `${entry.hooks[0].timeout} s`);
});

test("hooks.json: SessionStart `compact` reaches the style hook, which gives the re-read line after a compaction", () => {
  const groups = JSON.parse(read("hooks/hooks.json")).hooks.SessionStart.filter((/** @type {any} */ g) => g.hooks.some((/** @type {any} */ h) => h.command === 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/hooks/conversation-style.mjs"'));
  assert.equal(groups.length, 1);
  assert.ok(groups[0].matcher.split("|").includes("compact"), groups[0].matcher);
  // The state line of a fresh context: Claude Code 2.1.310 gives `clear` after /clear, `startup` in a new chat.
  for (const source of ["clear", "startup"]) assert.ok(groups[0].matcher.split("|").includes(source), source);
});

test("hooks.json: the PreToolUse matcher names the tools that run a command, the record's three, by a quoted command that resolves to the hook", () => {
  const [entry, ...more] = JSON.parse(read("hooks/hooks.json")).hooks.PreToolUse;
  assert.deepEqual(more, [], "one group: the push hook and the kill hook get the same tools");
  assert.deepEqual(entry.matcher.split("|").sort(), ["Bash", "Monitor", "PowerShell"]);
  const scripts = entry.hooks.map((/** @type {any} */ cmd) => {
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(cmd.command);
    assert.ok(m && read(m[1]).startsWith("#!/usr/bin/env node\n"), cmd.command);
    assert.ok(cmd.timeout >= 5, "a hook that times out lets the call run");
    return m[1];
  });
  assert.deepEqual(scripts, ["adapters/claude-code/hooks/push-spellings.mjs", "adapters/claude-code/hooks/kill-targets.mjs"]);
});

test("hooks.json: the PostToolUse matcher sends exactly the file tools the side-copy hook handles, by a quoted command that resolves to it", () => {
  const [entry] = JSON.parse(read("hooks/hooks.json")).hooks.PostToolUse;
  assert.deepEqual(entry.matcher.split("|").sort(), [...FILE_TOOLS].sort());
  const [cmd] = entry.hooks;
  assert.equal(cmd.type, "command");
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(cmd.command);
  assert.ok(m, `command must quote \${CLAUDE_PLUGIN_ROOT}: ${cmd.command}`);
  assert.equal(m[1], "adapters/claude-code/hooks/side-copy-rules.mjs");
  assert.ok(read(m[1]).startsWith("#!/usr/bin/env node\n"));
});

/** @param {string} root @param {string} rel @param {string} text */
function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** Every hook hooks.json wires: its event, what its matcher sends (sources or tools) and its script. */
function wiredHooks() {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  return Object.entries(hooks).flatMap(([event, groups]) =>
    /** @type {any[]} */ (groups).flatMap((g) => g.hooks.map((/** @type {any} */ h) => ({ event, sends: String(g.matcher).split("|"), script: /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(h.command)?.[1] ?? h.command }))),
  );
}

/** Every name below `dir` with its bytes' digest (a link with its target): a file a run wrote, removed or made is a difference. @param {string} dir @returns {string[]} */
function tree(dir, rel = "") {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return [`${name} -> ${readlinkSync(join(dir, name))}`];
    if (e.isDirectory()) return [`${name}/`, ...tree(dir, name)];
    return [`${name} ${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex").slice(0, 16)}`];
  });
}

/**
 * A box as a plugin session sees it: a project with path-scoped rules (one at its top, one in src/ for a session
 * started there) and a linked worktree (the side copy the PostToolUse hook acts on); with a config, a side-copy list
 * of an earlier session (what the reset removes; a project that never used Ennyn has none); the plugin's data
 * directory and the session's env file (what the version record writes).
 * @param {Record<string, unknown> | null} config
 */
function hookBox(config) {
  const box = mkdtempSync(join(tmpdir(), "en-scope-"));
  const proj = join(box, "proj");
  put(proj, ".claude/rules/src.md", '---\npaths: ["src/**"]\n---\nSRC-RULE-BODY\n');
  put(proj, "src/.claude/rules/here.md", '---\npaths: ["src/**"]\n---\nSUBDIR-RULE-BODY\n');
  put(proj, "src/a.js", "1\n");
  if (config) put(proj, ".ennyn/config.json", JSON.stringify(config));
  git(["init", "-q", "-b", "main"], { cwd: proj });
  git(["add", "."], { cwd: proj });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: proj });
  git(["worktree", "add", "-q", "--detach", join(box, "side")], { cwd: proj });
  if (config) put(proj, ".git/ennyn/side-copy/s1.json", '{"emitted":[]}\n');
  mkdirSync(join(box, "data"));
  writeFileSync(join(box, "session-env"), "");
  return { box, proj, file: join(box, "side", "src", "a.js"), env: { CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: join(box, "data"), CLAUDE_ENV_FILE: join(box, "session-env") } };
}

const neutral = mkdtempSync(join(tmpdir(), "en-scope-cwd-"));

/**
 * The hooks that run in every session, and the only places in the box they may write: the plugin's own data folder
 * and the session's env file. They read nothing of the project (the version record, adapters/claude-code/project.mjs).
 * @type {Record<string, string[]>}
 */
const EVERY_SESSION = { "adapters/claude-code/hooks/plugin-root.mjs": ["data/", "session-env "] };

/**
 * Each hook hooks.json wires, for each source or tool its matcher sends, as Claude Code runs it: the input on
 * stdin, the plugin's variables, `projectDir` as CLAUDE_PROJECT_DIR unless it is null. Each run says whether it
 * did anything (printed or changed a file in the box).
 * With `log` (failingGit's), each run counts the git calls it made.
 * @param {ReturnType<typeof hookBox>} b @param {string | null} projectDir @param {Record<string, string>} [extra] @param {string} [log]
 */
function runWired(b, projectDir, extra = {}, log) {
  const calls = () => (log && existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.ENNYN_CONFIG;
  return wiredHooks().flatMap(({ event, sends, script }) =>
    sends.map((send) => {
      const base = { session_id: "s1", hook_event_name: event, cwd: projectDir ?? b.proj };
      const input = event === "PreToolUse" ? { ...base, tool_name: send, tool_input: { command: "git -C . push; pkill node", description: "x" } } : event === "PostToolUse" ? { ...base, tool_name: send, tool_input: send === "NotebookEdit" ? { notebook_path: b.file } : { file_path: b.file } } : event === "PreCompact" ? { ...base, trigger: send, custom_instructions: null } : { ...base, source: send };
      const before = tree(b.box);
      const gitBefore = calls();
      const r = spawnSync(process.execPath, [join(ROOT, script)], {
        input: JSON.stringify(input),
        env: { ...env, ...b.env, ...(projectDir === null ? {} : { CLAUDE_PROJECT_DIR: projectDir }), ...extra },
        cwd: neutral,
        encoding: "utf8",
        timeout: 20000,
        killSignal: "SIGKILL",
      });
      const after = tree(b.box);
      const changed = [...after.filter((x) => !before.includes(x)), ...before.filter((x) => !after.includes(x)).map((x) => `gone: ${x}`)];
      return { at: `${event} ${send} ${script}`, script, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, changed, gitCalls: calls() - gitBefore };
    }),
  );
}

/**
 * A `git` first on PATH that fails every call, as one that refuses the repository (another account's) or is not
 * there; with `log`, each call's arguments are a line in it.
 * @param {string} [log]
 */
function failingGit(log) {
  const bin = mkdtempSync(join(tmpdir(), "en-scope-git-"));
  const record = log ? `echo "$*" >> '${log}'\n` : "";
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${record}echo 'fatal: this git fails every call' >&2\nexit 2\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

/** The hooks that ask git where Ennyn's state is with no config: the reset, at compaction or /clear (its list outlives a checkout). */
const ASKS_GIT = new Set(["adapters/claude-code/hooks/side-copy-reset.mjs"]);

test("hooks: in a project without an Ennyn config every hook hooks.json wires ends at once (exit 0, no output, nothing written, silent with a git that fails); the version record alone runs in every session, writing only the plugin's folder", () => {
  const wired = wiredHooks();
  assert.ok(wired.length >= 4 && wired.some((h) => h.event === "PostToolUse"), `hooks read: ${wired.map((h) => h.script)}`);
  const scripts = [...new Set(wired.map((h) => h.script))];
  assert.deepEqual(Object.keys(EVERY_SESSION).filter((s) => !scripts.includes(s)), [], "a hook listed as running in every session that hooks.json does not wire");
  /** The hooks no run of `runs` was seen to act in: printed, wrote or removed a file, or failed. @param {ReturnType<typeof runWired>} runs */
  const idle = (runs) => scripts.filter((s) => !runs.some((r) => r.script === s && (r.status !== 0 || r.stdout || r.stderr || r.changed.length)));
  // The controls: in a project with a config each hook acts, so a silent run below is the gate's. The project named
  // by CLAUDE_PROJECT_DIR or by the input's cwd alone; a session in a subdirectory of the repository, whose config
  // is found where the CLI finds it (the repository's top); a file ENNYN_CONFIG names.
  const sub = hookBox({ conversation: { style: "terse" } });
  const named = hookBox(null);
  put(named.box, "named.json", '{"conversation":{"style":"terse"}}');
  /** @type {Array<[string, ReturnType<typeof hookBox>, string | null, string, Record<string, string>?]>} */
  const controls = [
    ["the repository's top, named by CLAUDE_PROJECT_DIR", hookBox({ conversation: { style: "terse" } }), "top", "SRC-RULE-BODY"],
    ["the same, named only by the input's cwd", hookBox({ conversation: { style: "terse" } }), null, "SRC-RULE-BODY"],
    ["a session started in src/, the config at the repository's top", sub, join(sub.proj, "src"), "SUBDIR-RULE-BODY"],
    ["ENNYN_CONFIG naming a file, no .ennyn in the project", named, "top", "SRC-RULE-BODY", { ENNYN_CONFIG: join(named.box, "named.json") }],
  ];
  for (const [name, b, projectDir, rule, extra] of controls) {
    const acted = runWired(b, projectDir === "top" ? b.proj : projectDir, extra);
    for (const r of acted) assert.equal(r.status, 0, `${name}: ${r.at}: ${r.stderr}`);
    assert.deepEqual(idle(acted), [], `${name}: a hook that does nothing with a config proves nothing here`);
    assert.ok(acted.some((r) => r.at.startsWith("PostToolUse ") && r.stdout.includes(rule)), `${name}: the side copy's rule given`);
  }
  // A config there that does not load is still the project's: each hook says so, or acts as it would.
  const broken = hookBox(null);
  put(broken.proj, ".ennyn/config.json", "{ broken");
  assert.deepEqual(idle(runWired(broken, broken.proj)), [], "a hook silent on a config that does not load");
  const off = hookBox(null);
  const notDir = hookBox(null);
  put(notDir.proj, ".ennyn", "a file, not the folder\n");
  const above = hookBox(null);
  put(above.box, ".ennyn/config.json", '{"conversation":{"style":"terse"}}');
  const plain = hookBox(null);
  const outside = join(plain.box, "outside");
  put(outside, "src/a.js", "1\n");
  /** @type {Array<[string, ReturnType<typeof hookBox>, string | null, Record<string, string>?]>} */
  const cases = [
    ["a repository with a side copy, named by CLAUDE_PROJECT_DIR", off, off.proj],
    ["the same, named only by the input's cwd", off, null],
    ["a session started in src/ of it", off, join(off.proj, "src")],
    ["a folder outside any repository", plain, outside],
    ["ENNYN_CONFIG naming no file", off, off.proj, { ENNYN_CONFIG: join(off.box, "none.json") }],
    ["`.ennyn` a file", notDir, notDir.proj],
    // Something at the config's place above: git is asked for the top, and a git that cannot answer leaves the
    // session folder, which holds none.
    ["a config in a folder above the repository, not at its top", above, join(above.proj, "src")],
  ];
  // A git that fails every call, as one that refuses the repository or is not there: every hook stays silent. Its
  // calls are counted: in a project that never used Ennyn only the reset asks git anything.
  const log = join(mkdtempSync(join(tmpdir(), "en-scope-log-")), "git-calls");
  const PATH = failingGit(log);
  for (const [name, b, projectDir, extra] of cases) {
    for (const r of runWired(b, projectDir, { PATH, ...extra }, log)) {
      if (b !== above && !ASKS_GIT.has(r.script)) assert.equal(r.gitCalls, 0, `${name}: ${r.at} asked git`);
      const allowed = EVERY_SESSION[r.script];
      if (!allowed) {
        assert.deepEqual([r.status, r.stdout, r.stderr, r.changed], [0, "", "", []], `${name}: ${r.at}`);
        continue;
      }
      // The version record: written in every session, and nothing else in the box.
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], `${name}: ${r.at}`);
      assert.deepEqual(r.changed.filter((c) => !allowed.some((a) => c.replace(/^gone: /, "").startsWith(a))), [], `${name}: ${r.at} wrote outside its own places`);
    }
    if (!existsSync(join(b.box, "data", "root"))) assert.fail(`${name}: the version record was not written`);
  }
  assert.ok(readFileSync(log, "utf8").includes("rev-parse --show-toplevel"), "the case above the repository asked git for the top");
  // At the top of a configured repository a git that cannot answer leaves the session folder, which holds the
  // config: as on main, the style applies and a file of the project's own is no side copy.
  const top = hookBox({ conversation: { style: "terse" } });
  const env = { ...process.env, ...top.env, CLAUDE_PROJECT_DIR: top.proj, PATH: failingGit() };
  delete env.ENNYN_CONFIG;
  const run = (/** @type {string} */ script, /** @type {object} */ input) => spawnSync(process.execPath, [join(ROOT, script)], { input: JSON.stringify({ session_id: "s1", cwd: top.proj, ...input }), env, cwd: neutral, encoding: "utf8" });
  const style = run("adapters/claude-code/hooks/conversation-style.mjs", { hook_event_name: "SessionStart", source: "startup" });
  assert.match(JSON.parse(style.stdout).hookSpecificOutput.additionalContext, /^Conversation style: terse/, style.stdout);
  const own = run("adapters/claude-code/hooks/side-copy-rules.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(top.proj, "src", "a.js") } });
  assert.deepEqual([own.status, own.stdout, own.stderr], [0, "", ""]);
});

test("hooks: the version record reads nothing of the project: a config ENNYN_CONFIG names as a FIFO, or a broken one, never stops or changes it", () => {
  const script = Object.keys(EVERY_SESSION)[0];
  const b = hookBox(null);
  const fifo = join(b.box, "fifo.json");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0, "mkfifo");
  put(b.proj, ".ennyn/config.json", "{ broken");
  const env = { ...process.env, ...b.env, CLAUDE_PROJECT_DIR: b.proj, ENNYN_CONFIG: fifo };
  const started = performance.now();
  const r = spawnSync(process.execPath, [join(ROOT, script)], { input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup", cwd: b.proj }), env, cwd: neutral, encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" });
  assert.deepEqual([r.status, r.signal, r.stdout, r.stderr], [0, null, "", ""], `${performance.now() - started} ms`);
  assert.equal(readFileSync(join(b.box, "data", "root"), "utf8"), `${ROOT}\n`);
});

test("hooks: one predicate says whether a project has a config, found where the CLI finds it: nothing there is none, something there that does not load throws", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "en-scope-pred-"));
  const env = { ...process.env };
  delete env.ENNYN_CONFIG;
  /** None: no file, no folder, `.ennyn` a file, ENNYN_CONFIG naming no file. */
  const bare = dir();
  assert.equal(projectConfig(bare, env), null);
  assert.equal(projectConfig(join(bare, "no-such-folder"), env), null);
  const asFile = dir();
  put(asFile, ".ennyn", "x\n");
  assert.equal(projectConfig(asFile, env), null);
  assert.equal(projectConfig(bare, { ...env, ENNYN_CONFIG: join(bare, "none.json") }), null);
  assert.equal(projectConfig(bare, { ...env, ENNYN_CONFIG: "none.json" }), null);
  // A config: the project's own, or the one ENNYN_CONFIG names, relative to the project or absolute.
  const own = dir();
  put(own, ".ennyn/config.json", '{"language":"tr"}');
  assert.equal(projectConfig(own, env)?.language, "tr");
  assert.equal(projectConfig(own, env)?.configPath, join(own, ".ennyn", "config.json"));
  put(bare, "elsewhere.json", "{}");
  assert.equal(projectConfig(bare, { ...env, ENNYN_CONFIG: "elsewhere.json" })?.configPath, join(bare, "elsewhere.json"));
  assert.equal(projectConfig(own, { ...env, ENNYN_CONFIG: join(bare, "elsewhere.json") })?.language, "en", "the named one, not the project's own");
  // There and not loading: a link, a directory, a parse error, a value the config refuses.
  const linked = dir();
  put(linked, "real.json", "{}");
  mkdirSync(join(linked, ".ennyn"));
  symlinkSync(join(linked, "real.json"), join(linked, ".ennyn", "config.json"));
  assert.throws(() => projectConfig(linked, env), /symbolic link/);
  const folder = dir();
  mkdirSync(join(folder, ".ennyn", "config.json"), { recursive: true });
  assert.throws(() => projectConfig(folder, env), /no regular file/);
  // A link on the way may hold one: loadConfig refuses it, so it is said, never read as none.
  for (const target of ["no-such-folder", "empty-folder"]) {
    const linkedDir = dir();
    mkdirSync(join(linkedDir, "empty-folder"));
    symlinkSync(join(linkedDir, target), join(linkedDir, ".ennyn"));
    assert.throws(() => projectConfig(linkedDir, env), /symbolic link/, target);
  }
  // A `.ennyn` that cannot be searched may hold one: it does not load, and is never read as none.
  const shut = dir();
  put(shut, ".ennyn/config.json", "{}");
  chmodSync(join(shut, ".ennyn"), 0o000);
  try {
    assert.throws(() => projectConfig(shut, env), /permission denied|EACCES/i);
  } finally {
    chmodSync(join(shut, ".ennyn"), 0o755);
  }
  const broken = dir();
  put(broken, ".ennyn/config.json", "{ broken");
  assert.throws(() => projectConfig(broken, env), ConfigError);
  const refused = dir();
  put(refused, ".ennyn/config.json", '{"language":"de"}');
  assert.throws(() => projectConfig(refused, env), ConfigError);
  // Where the CLI finds it: the repository's top, from a subdirectory too; a config above the top is no config,
  // nor is a session folder that is not there.
  const repo = dir();
  put(repo, ".ennyn/config.json", '{"language":"tr"}');
  put(repo, "src/a.js", "1\n");
  git(["init", "-q", "-b", "main"], { cwd: repo });
  const top = git(["rev-parse", "--show-toplevel"], { cwd: repo });
  assert.equal(projectConfig(join(repo, "src"), env)?.configPath, join(top, ".ennyn", "config.json"));
  assert.equal(projectConfig(join(repo, "src"), env)?.projectDir, top);
  const nested = join(repo, "nested");
  put(nested, "a.js", "1\n");
  git(["init", "-q", "-b", "main"], { cwd: nested });
  assert.equal(projectConfig(nested, env), null, "a repository inside a configured folder, with none at its own top");
  assert.equal(projectConfig(join(repo, "gone"), env), null);
  // A git that cannot answer (it refuses the repository, or is not there): the session folder is the root, as on
  // main, and nothing is said; a session at the top keeps its config.
  const path = process.env.PATH;
  process.env.PATH = failingGit();
  try {
    assert.equal(projectConfig(repo, env)?.configPath, join(repo, ".ennyn", "config.json"));
    assert.equal(projectConfig(join(repo, "src"), env), null);
  } finally {
    process.env.PATH = path;
  }
  // A session folder named through a link into the repository: looked for by its real path, as git does.
  const via = join(dir(), "link");
  symlinkSync(join(repo, "src"), via);
  assert.equal(projectConfig(via, env)?.configPath, join(top, ".ennyn", "config.json"));
  // The project: CLAUDE_PROJECT_DIR, else the input's cwd, else the hook's own.
  assert.equal(hookProjectDir({ cwd: "/b" }, { CLAUDE_PROJECT_DIR: "/a" }), "/a");
  assert.equal(hookProjectDir({ cwd: "/b" }, {}), "/b");
  for (const input of [null, "text", { cwd: "" }, { cwd: 7 }, {}]) assert.equal(hookProjectDir(input, { CLAUDE_PROJECT_DIR: "" }), process.cwd(), JSON.stringify(input));
});
