import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, readlinkSync, existsSync, statSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { ConfigError, loadConfig } from "../core/config.mjs";
import { checkCommitShape } from "../checks/commit-shape.mjs";
import { t } from "../core/i18n.mjs";
import { hookProjectDir, projectConfig } from "../adapters/claude-code/project.mjs";
import { FILE_TOOLS } from "../adapters/claude-code/hooks/side-copy-rules.mjs";
import { askRules, outwardCommands } from "../setup/permissions.mjs";
import { projectFiles } from "../setup/scan.mjs";

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

test("plugin: every SKILL.md stays under 8 KB (DESIGN.md: skills are read whole, every time)", () => {
  for (const { path } of skills) assert.ok(statSync(join(ROOT, path)).size < 8 * 1024, `${path}: ${statSync(join(ROOT, path)).size} bytes`);
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
  assert.equal(res.rules.length, 10, "git push, npm publish and three gh commands, each for Bash and PowerShell");
  for (const r of res.rules) assert.equal(r.where, "shared", `${r.rule} in .claude/settings.json`);
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
  assert.equal(plugin.version, pkg.version, "a push without a version bump never reaches users; bump both together");
  // One description for the package, the plugin and its marketplace entry: the install description says what the hooks do.
  assert.deepEqual([plugin.description, market.plugins[0].description], [pkg.description, pkg.description]);
  // The plugin root is the repository root, so a root CLAUDE.md would be shipped and ignored.
  assert.ok(!existsSync(join(ROOT, "CLAUDE.md")), "developer notes live in .claude/CLAUDE.md");
});

/**
 * Markdown files below `dir`, relative. A walk of its own: Node 20.0 ignores readdirSync's recursive option and
 * lists the top only, so the nested documents went unread on the floor (test/guards.mjs, plugin-pipe).
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

test("i18n: every English key exists in every catalog, vars interpolate, fallback works", () => {
  const en = Object.keys(JSON.parse(read("i18n/en.json"))).sort();
  const catalogs = readdirSync(join(ROOT, "i18n")).filter((f) => f.endsWith(".json") && f !== "en.json");
  assert.ok(catalogs.includes("tr.json"), `catalogs: ${catalogs}`);
  for (const f of catalogs) assert.deepEqual(Object.keys(JSON.parse(read(`i18n/${f}`))).sort(), en, f);
  assert.match(t("shape.subjectTooLong", { len: 130, max: 120 }, "tr"), /130 karakter; sınır 120/);
  assert.throws(() => t("no.such.key"));
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
      const input = event === "PostToolUse" ? { ...base, tool_name: send, tool_input: send === "NotebookEdit" ? { notebook_path: b.file } : { file_path: b.file } } : { ...base, source: send };
      const before = tree(b.box);
      const gitBefore = calls();
      const r = spawnSync(process.execPath, [join(ROOT, script)], {
        input: JSON.stringify(input),
        env: { ...env, ...b.env, ...(projectDir === null ? {} : { CLAUDE_PROJECT_DIR: projectDir }), ...extra },
        cwd: neutral,
        encoding: "utf8",
        timeout: 20000,
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
  const r = spawnSync(process.execPath, [join(ROOT, script)], { input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup", cwd: b.proj }), env, cwd: neutral, encoding: "utf8", timeout: 8000 });
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
