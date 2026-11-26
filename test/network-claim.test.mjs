/**
 * What README.md, README.tr.md and SECURITY.md say about the network holds in the code (graph nodes
 * network-claim-test and readme-says-what-runs). Outside test/, every place the shipped code can reach the network
 * is on an allow list: each call of `fetch` (and the browser-style network globals), each import of a network
 * module of Node, each child process whose program is not git, ps, taskkill or Node running Ennyn's own modules,
 * each string literal that names a network program or git's network subcommands (`fetch`, `push`, `ls-remote`,
 * `curl`, `gh`, `npm`, …), each network command in a shell file, and each command or server a plugin manifest
 * gives Claude Code to run, counted per file. An entry that reaches the network names a claim, and the claim's words
 * stand in the README's list, in both languages, and in SECURITY.md's "What Ennyn runs on a machine". A new call, or
 * a claim dropped from a document, fails here; an entry the code no longer holds fails too, so the list stays the
 * code's. The skills and agents (`plugin/skills/**.md`, `plugin/agents/**.md`) are held the same way (graph node
 * network-claim-skill-steps): each command they give the agent that starts with a network program, or runs one of
 * Ennyn's commands that reach the network, is on the list by file and command, as written. Then the behaviours: the OSV request body carries only name, ecosystem and version, `ennyn deps` asks OSV
 * nothing with `security.deps.advisories` empty, and with `security.deps.online: false` the commit hook asks nothing
 * of the registry, which it does ask with the key on.
 *
 * The files are the repository's own, as git lists them: tracked, and untracked ones no ignore rule hides (as
 * test/hygiene.test.mjs reads them); an ignored folder (an agent's worktree under .claude/worktrees) and a nested
 * repository are not this tree's code.
 *
 * JavaScript is read as text: a line that opens with `*`, `//` or `/*` is a comment, and its calls and words are not
 * counted; imports are counted on every line. A call is its name right before `(` (or `?.(`), as the formatter
 * writes it; a child process call may break its arguments over lines, and child_process may be taken whole under a
 * name (`import * as cp`, `require`) or its functions renamed. A shell file is read line by line, its words unquoted.
 * A network call made through a name this scan does not know (a program held in a variable that the allow list
 * names, a module loaded under a computed name) is past it: the allow list says why each such variable runs nothing
 * of its own on the network.
 *
 * A skill's Markdown is read for its commands only: each line of a fenced block and each code span on one line (a
 * line with an odd count of backticks fails), each command as shell words past assignments, shell keywords, `env`,
 * `timeout` and Ennyn's own `lock … --`. Not read: prose outside code spans ("fetch first"), an indented code block,
 * a block in a quote or HTML `<code>` (none in these files today); a command behind another wrapper (`sudo`, `nice`,
 * `xargs`, `sh -c "…"`, `perl -e … exec`, `docker run … npm`) or a placeholder (`<runner> install`); programs
 * outside `NET_PROGRAMS` (`docker pull`, `pip`, `bunx`, `uvx`, `corepack`, `cargo`, `go get`); node with an option
 * that takes a value before Ennyn's path (`node --import x ennyn.mjs`); and the network use of an Ennyn command
 * missing from `ENNYN_NET`: that table is written by hand from the code sites, and a new command that reaches the
 * network goes into it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { advisoriesOf, lockEntries } from "../plugin/checks/deps.mjs";
import { loadConfig } from "../plugin/core/config.mjs";
import { git } from "../plugin/core/git.mjs";

const TOP = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(TOP, "plugin", "scripts", "ennyn.mjs");

/** Files read as JavaScript. */
const CODE = /\.(?:mjs|cjs|js|mts|cts|ts)$/;
/** Files read as shell. */
const SHELL = /\.(?:sh|bash|zsh|ps1|cmd|bat)$/i;
/** Manifests Claude Code reads the commands and servers of: the plugin's folder and the marketplace's. */
const MANIFEST = /^(?:plugin|\.claude-plugin)\/.*\.json$|^\.mcp\.json$/;
/** Network calls of the platform: fetch, and the browser-style globals Node also has. */
const NET_CALL = /(?<![\w$])(fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon)(?:\?\.)?\(/g;
/** An import of a network module of Node, or of undici, in every form a module loads one. */
const NET_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`](?:node:)?(https?|http2|net|tls|dgram|dns|undici)(?:\/[\w/]*)?["'`]/g;
/** A network module named by its `node:` name anywhere else (a createRequire, a name passed along). */
const NET_MODULE_NAME = /(?<!\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]node:(https?|http2|net|tls|dgram|dns)(?:\/[\w/]*)?["'`]/g;
/** child_process's functions that start a process. */
const CHILD_FUNCS = ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"];
/** Where a module takes child_process: `["']` then its name. */
const CP = String.raw`["'\`](?:node:)?child_process["'\`]`;
/** Programs that reach no network themselves: git's network subcommands are the words below. */
const LOCAL_PROGRAMS = new Set(['"git"', "'git'", '"ps"', '"taskkill"', "process.execPath"]);
/** A string literal, one line long. */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** Words a child process or a git call would name to reach the network. */
const NET_WORDS = new Set(["fetch", "push", "pull", "clone", "ls-remote", "remote", "submodule", "curl", "wget", "gh", "npm", "npx", "pnpm", "yarn", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "ftp"]);
/** A literal that is a command line for a network program. */
const NET_LINE = /^(?:curl|wget|scp|rsync|git\s+(?:fetch|push|pull|clone|ls-remote))(?:\s|$)/;
/** Programs that reach the network: a shell line is read for them anywhere, a skill's command by its head. */
const NET_PROGRAMS = ["curl", "wget", "npm", "npx", "pnpm", "yarn", "gh", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "Invoke-WebRequest", "Invoke-RestMethod", "iwr", "irm"];
/** git's subcommands that reach a remote. */
const GIT_NET = "(?:fetch|push|pull|clone|ls-remote)";
/** A network program or git network subcommand as a shell line runs it. */
const SHELL_NET = new RegExp(String.raw`(?<![\w./-])(${NET_PROGRAMS.join("|")}|git\s+${GIT_NET})(?![\w-])`, "gi");
/** The Markdown the agent follows: the skills and the agents. */
const STEP_FILES = /^plugin\/(?:skills|agents)\/.*\.md$/;
/** The network programs by name, as a step's command word is compared (any case, any folder). */
const NET_NAMES = new Set(NET_PROGRAMS.map((p) => p.toLowerCase()));
/** git's subcommands a step is read for: those that reach a remote, and `remote` and `submodule`, which the code reading counts too. */
const GIT_STEP = new Set(["fetch", "push", "pull", "clone", "ls-remote", "remote", "submodule"]);
/** git's options before the subcommand that take the next word as their value. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
/** Words the shell reads before a command: keywords, negation, a group's opening. */
const LEADING = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);
/** A shell word: unquoted runs and quoted parts together; a quote left open runs to the end. */
const WORD = /(?:[^\s"']+|"(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$))+/g;
/**
 * Ennyn's commands that reach the network, with the claim that names each: the code sites below carry the same
 * claims (`deps` asks OSV, `commit-check` is the hook that asks the registry, `push-check` fetches, `clone-setup`
 * asks GitHub). A skill step that runs one maps to its claim.
 * @type {Record<string, keyof typeof CLAIMS>}
 */
const ENNYN_NET = { deps: "osv", "commit-check": "registry", "push-check": "pushCheck", "clone-setup": "cloneSetup" };
/** Where a command line breaks into commands. */
const SEPARATORS = /&&|\|\||[;|&()]|\$\(/;
/** A code span on one line: its backticks, then its text. */
const SPAN = /(`+)(?!`)(.*?[^`])\1(?!`)/g;
/** The one form of a manifest's command that runs Ennyn's own code, which this scan reads. */
const OWN_COMMAND = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/[\w./-]+\.mjs"$/;

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The names a module gives child_process: the whole module (`import * as cp`, a default import, `require`, an
 * `await import`), and its functions under other names (`{ execSync as run }`, `{ execSync: run }`, a name bound to
 * `promisify(exec)` or `util.promisify(cp.exec)`).
 * @param {string} text
 */
function childNames(text) {
  /** @type {Set<string>} */
  const whole = new Set();
  /** @type {Set<string>} */
  const renamed = new Set();
  for (const m of text.matchAll(new RegExp(String.raw`\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*${CP}`, "g"))) whole.add(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`\bimport\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*${CP}`, "g"))) whole.add(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+import|require)\s*\(\s*${CP}\s*\)`, "g"))) whole.add(m[1]);
  const lists = [
    ...text.matchAll(new RegExp(String.raw`\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${CP}`, "g")),
    ...text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+import|require)\s*\(\s*${CP}\s*\)`, "g")),
  ];
  for (const m of lists)
    for (const part of m[1].split(",")) {
      const r = /^\s*([\w$]+)\s*(?:as|:)\s*([\w$]+)\s*$/.exec(part);
      if (r && CHILD_FUNCS.includes(r[1])) renamed.add(r[2]);
    }
  // A name bound to promisify of one of them, bare, renamed or on the module's name, with or without `util.`.
  const fn = (/** @type {string} */ ref) => {
    const dot = /^([\w$]+)\s*\.\s*([\w$]+)$/.exec(ref);
    return dot ? whole.has(dot[1]) && CHILD_FUNCS.includes(dot[2]) : CHILD_FUNCS.includes(ref) || renamed.has(ref);
  };
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\.\s*)?promisify\s*\(\s*([\w$]+(?:\s*\.\s*[\w$]+)?)\s*\)/g)) if (fn(m[2])) renamed.add(m[1]);
  return { whole, renamed };
}

/**
 * The network sites of one JavaScript file: `kind` (call, import, program, word) and `key` (the API, module, program
 * text or word), with the line.
 * @param {string} text
 * @returns {{ kind: string, key: string, line: number }[]}
 */
export function sites(text) {
  /** @type {{ kind: string, key: string, line: number }[]} */
  const out = [];
  const lines = text.split("\n");
  const isComment = (/** @type {number} */ i) => /^\s*(?:\*|\/\/|\/\*)/.test(lines[i] ?? "");
  const lineAt = (/** @type {number} */ index) => text.slice(0, index).split("\n").length;
  // Child processes, over the whole text: the arguments may start on the next line. `.exec(` is a RegExp's unless
  // its receiver is child_process under a name this module gave it.
  const { whole, renamed } = childNames(text);
  const bare = [...CHILD_FUNCS.filter((f) => !f.startsWith("exec") || f.startsWith("execFile")), ...renamed].map(escape);
  const dotted = [...whole].map(escape);
  const call = new RegExp(String.raw`(?:(?<![\w$])(?:${bare.join("|")})|(?<![\w$.])(?:exec|execSync)${dotted.length ? String.raw`|(?<![\w$])(?:${dotted.join("|")})\s*\.\s*(?:${CHILD_FUNCS.join("|")})` : ""})\s*\(\s*([^,)]+)`, "g");
  for (const m of text.matchAll(call)) {
    const line = lineAt(/** @type {number} */ (m.index));
    if (isComment(line - 1)) continue;
    const program = m[1].trim();
    if (!LOCAL_PROGRAMS.has(program)) out.push({ kind: "program", key: program.replace(/\s+/g, " "), line });
  }
  lines.forEach((l, i) => {
    const line = i + 1;
    const comment = isComment(i);
    if (!comment) for (const m of l.matchAll(NET_CALL)) out.push({ kind: "call", key: m[1], line });
    for (const m of l.matchAll(NET_IMPORT)) out.push({ kind: "import", key: m[1], line });
    for (const m of l.matchAll(NET_MODULE_NAME)) out.push({ kind: "import", key: m[1], line });
    if (comment) return;
    for (const m of l.matchAll(LITERAL)) {
      const word = m[2].trim();
      if (NET_WORDS.has(word) || NET_LINE.test(word)) out.push({ kind: "word", key: word, line });
    }
  });
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The network commands of one shell file, line by line, quoted or not; a line that opens with `#` (or `REM`, `::`)
 * is a comment.
 * @param {string} text
 * @returns {{ kind: string, key: string, line: number }[]}
 */
export function shellSites(text) {
  /** @type {{ kind: string, key: string, line: number }[]} */
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(?:#|REM\b|::)/i.test(l)) return;
    for (const m of l.matchAll(SHELL_NET)) out.push({ kind: "shell", key: m[1].toLowerCase().replace(/\s+/g, " "), line: i + 1 });
  });
  return out;
}

/**
 * The commands a skill or an agent gives the agent to run: each line of a fenced block (a `$ ` prompt dropped) and
 * each code span, inside a block too, split where the shell would run the next command (`&&`, `||`, `;`, `|`, `&`,
 * `(`, `$(`). A command that runs a network program, git on a subcommand of `GIT_STEP` or one of Ennyn's commands
 * that reach the network (stepCommand), is a site; its key is the command as written, spaces collapsed. A line outside a
 * block with an odd count of backticks holds a span this reading cannot pair: it is a site of its own, on no list.
 * @param {string} text
 * @returns {{ kind: string, key: string, line: number }[]}
 */
export function stepSites(text) {
  /** @type {{ kind: string, key: string, line: number }[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
  text.split(/\r?\n/).forEach((l, i) => {
    const line = i + 1;
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && (fence === null || (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()))) {
      fence = fence === null ? f[1] : null;
      return;
    }
    if (fence === null && (l.match(/`/g) ?? []).length % 2) out.push({ kind: "step", key: "unread: a code span this reading cannot pair", line });
    const commands = [...(fence === null ? [] : [l.replace(/^\s*\$\s+/, "")]), ...[...l.matchAll(SPAN)].map((m) => m[2])];
    for (const c of commands)
      for (const part of c.split(SEPARATORS)) {
        const cmd = part.trim().replace(/\s+/g, " ");
        if (stepCommand(cmd).net) out.push({ kind: "step", key: cmd, line });
      }
  });
  return out;
}

/**
 * What a manifest gives Claude Code to run: each `command` that is not `node` on a module of Ennyn's own (whose code
 * the scan reads), each hook of another type (an HTTP hook reaches a URL), and each MCP or LSP server.
 * @param {string} text
 * @returns {{ kind: string, key: string, line: number }[]}
 */
export function manifestSites(text) {
  /** @type {{ kind: string, key: string, line: number }[]} */
  const out = [];
  /** @param {unknown} o */
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "command" && (typeof v !== "string" || !OWN_COMMAND.test(v))) out.push({ kind: "manifest", key: `command ${JSON.stringify(v)}`, line: 0 });
      else if (k === "type" && typeof v === "string" && (v === "http" || "url" in o)) out.push({ kind: "manifest", key: `hook type ${v}`, line: 0 });
      else if (k === "mcpServers" || k === "lspServers") out.push({ kind: "manifest", key: `${k} ${JSON.stringify(v)}`, line: 0 });
      walk(v);
    }
  };
  walk(JSON.parse(text));
  return out;
}

/**
 * The repository's own files outside test/, as git lists them: tracked, and untracked ones no ignore rule hides; a
 * nested repository (git names it with a trailing `/`) and a tracked file gone from disk are left out.
 * @param {string} root
 */
export function ownFiles(root) {
  return git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
    .split("\0")
    .filter((f) => f && !f.endsWith("/") && !f.startsWith("test/") && existsSync(join(root, f)))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort();
}

/** The network sites of one file by its kind, or none. @param {string} file @param {string} text */
export function fileSites(file, text) {
  if (CODE.test(file)) return sites(text);
  if (SHELL.test(file)) return shellSites(text);
  if (MANIFEST.test(file)) return manifestSites(text);
  if (STEP_FILES.test(file)) return stepSites(text);
  return [];
}

/**
 * What the documents say. Each claim's code spans stand in the README's list in both languages (`readme`), its
 * words in each language's list (`en`, `tr`), and its words in SECURITY.md's section (`security`). `sources`: the
 * files and words a claim stands on where no site of the allow list carries it: git's own fetch in a partial clone.
 * A claim no site carries needs one.
 * @type {Record<string, { readme: string[], en: string[], tr: string[], security: string[], sources?: { file: string, text: string }[] }>}
 */
const CLAIMS = {
  registry: { readme: ["`registry.npmjs.org`", "`api.npmjs.org`", "`security.deps.online: false`"], en: ["commit hook"], tr: ["commit hook'u"], security: ["by default `registry.npmjs.org` for the package document and `api.npmjs.org`", "`security.deps.online: false` stops it"] },
  osv: {
    readme: ["`ennyn deps`", "`api.osv.dev`", '`security.deps.advisories: ""`'],
    en: ["when you run it and at the end of each cycle"],
    tr: ["siz çalıştırdığınızda ve her döngünün sonunda"],
    security: ["`ennyn deps`, run by hand and at each cycle's closing", "by default `api.osv.dev`", '`security.deps.advisories: ""` stops it'],
  },
  pushCheck: { readme: ["`ennyn push-check`", "`git fetch`"], en: ["`ennyn push-check` runs `git fetch`"], tr: ["`ennyn push-check` dalınızın remote'unda `git fetch`"], security: ["`push-check` fetches the branch's upstream remote"] },
  cloneSetup: { readme: ["`ennyn clone-setup`", "`api.github.com`"], en: ["signing keys"], tr: ["imzalama anahtarlarını"], security: ["`clone-setup`, with `commits.signed` set and a GitHub login, asks `api.github.com`"] },
  closingPush: { readme: ["`push.mode`", "`after-closing`"], en: ["the agent pushes there"], tr: ["agent da oraya push eder"], security: ["then a `git push` to the branch's upstream"] },
  initIssues: { readme: ["`/ennyn:init`", "`gh`"], en: ["GitHub issues"], tr: ["GitHub issue'larınızı"], security: ["`/ennyn:init` reads the open issues with `gh issue list`"] },
  initNpm: {
    readme: ["`npm prefix`", "`npm config get`", "`update-notifier=false`"],
    en: ["In a new project", "npm itself may ask its registry"],
    tr: ["Yeni bir projede", "npm de kendi registry'sine"],
    security: ["Before that first install `/ennyn:init` runs `npm prefix` and `npm config get`", "npm's own update check", "`update-notifier=false`"],
  },
  initScaffold: {
    readme: [],
    en: ["once you agree on the stack, the agent scaffolds it and installs its packages", "downloads them from that manager's registry"],
    tr: ["agent projenin iskeletini kurar ve paketleri seçtiğiniz paket yöneticisiyle yükler", "o paket yöneticisinin registry'sinden iner"],
    security: ["the agent scaffolds it and installs its packages with the agreed package manager, which downloads from that manager's registry"],
  },
  partialClone: { readme: [], en: ["In a partial clone, git itself fetches"], tr: ["Partial clone'da git"], security: ["in a partial clone (`git clone --filter`) git itself fetches"], sources: [{ file: "plugin/core/git.mjs", text: "GIT_NO_LAZY_FETCH" }] },
};

/**
 * The allow list: every network site of the shipped code, counted per file. `claim` names what the documents say of
 * one that reaches the network; `why` says why one that does not, never reaches it.
 * @type {{ file: string, kind: string, key: string, count: number, claim?: keyof typeof CLAIMS, why?: string }[]}
 */
const ALLOWED = [
  { file: "plugin/checks/deps.mjs", kind: "call", key: "fetch", count: 1, claim: "registry", why: "fetchJson: the registry's package document and downloads (the commit hook), OSV's querybatch and vulns (ennyn deps)" },
  { file: "plugin/checks/deps.mjs", kind: "word", key: "npm", count: 1, claim: "osv", why: "the ecosystem OSV is told" },
  { file: "plugin/setup/clone-setup.mjs", kind: "call", key: "fetch", count: 1, claim: "cloneSetup" },
  { file: "plugin/checks/test-runs.mjs", kind: "word", key: "fetch", count: 1, claim: "pushCheck", why: "pushNeeds: git fetch of the upstream remote" },
  { file: "plugin/checks/deps.mjs", kind: "word", key: "submodule", count: 1, why: "a kind of index entry a path goes through" },
  { file: "plugin/core/git.mjs", kind: "word", key: "submodule", count: 2, why: "a kind of index entry (mode 160000)" },
  { file: "plugin/plan/audit.mjs", kind: "word", key: "submodule", count: 1, why: "the name of an audit rule" },
  { file: "plugin/checks/ci.mjs", kind: "word", key: "fetch", count: 1, why: "the CI reader's list of git subcommands a workflow runs; it reads workflow text" },
  { file: "plugin/checks/ci.mjs", kind: "word", key: "pull", count: 1, why: "the CI reader's words, read in workflow text" },
  { file: "plugin/checks/ci.mjs", kind: "word", key: "clone", count: 3, why: "the CI reader's words, read in workflow text" },
  { file: "plugin/checks/ci.mjs", kind: "word", key: "gh", count: 1, why: "the CI reader's words, read in workflow text" },
  { file: "plugin/checks/push-mode.mjs", kind: "word", key: "fetch", count: 1, why: "a remote's config key, compared" },
  { file: "plugin/checks/push-mode.mjs", kind: "word", key: "remote", count: 1, why: "git remote get-url: reads the config" },
  { file: "plugin/checks/commit-identity.mjs", kind: "word", key: "remote", count: 2, why: "git remote get-url: reads the config" },
  { file: "plugin/checks/commit-identity.mjs", kind: "word", key: "ssh", count: 3, why: "a signature format (gpg.format ssh)" },
  { file: "plugin/setup/scan.mjs", kind: "word", key: "remote", count: 2, why: "git remote -v and get-url: read the config" },
  { file: "plugin/adapters/claude-code/kill-targets.mjs", kind: "word", key: "ssh", count: 2, why: "the kill reader's mode for a command ssh would run, read as text" },
  { file: "plugin/setup/doctor.mjs", kind: "word", key: "git push", count: 1, why: "an ask rule's command, looked up in the settings files" },
  { file: "plugin/setup/permissions.mjs", kind: "word", key: "git push", count: 1, why: "an ask rule's command, proposed for the settings file" },
  { file: "plugin/setup/uninstall.mjs", kind: "word", key: "git push", count: 1, why: "an ask rule's command init proposes, listed for removal" },
  { file: "plugin/core/heavy-lock.mjs", kind: "program", key: "command", count: 1, why: "runText: its one caller runs /usr/sbin/sysctl to read free memory" },
  { file: "plugin/impact/reference-run.mjs", kind: "program", key: "program", count: 1, why: "the program impact.referenceCommand names, the project's own" },
  { file: "plugin/metrics/mutation.mjs", kind: "program", key: "command", count: 1, why: "the test command given to ennyn mutate, the project's own" },
  { file: "plugin/scripts/ennyn.mjs", kind: "program", key: "command", count: 1, why: "commands.fastTest or commands.wholeTest for ennyn test, the project's own" },
  // The commands the skills give the agent.
  { file: "plugin/skills/cycle/SKILL.md", kind: "step", key: "ennyn.mjs deps", count: 1, claim: "osv", why: "the closing's security checks" },
  { file: "plugin/skills/cycle/report-formats.md", kind: "step", key: "ennyn.mjs deps", count: 1, claim: "osv", why: "the closing report's line for the same check" },
  { file: "plugin/skills/cycle/SKILL.md", kind: "step", key: "ennyn.mjs push-check", count: 1, claim: "pushCheck", why: "the closing's push step" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "ennyn.mjs push-check", count: 2, claim: "pushCheck" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "ennyn push-check --tested", count: 1, claim: "pushCheck", why: "what after-closing runs before its push" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "git fetch", count: 1, claim: "closingPush", why: "the closing's first push step" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "git push", count: 6, claim: "closingPush", why: "the closing's push, asked unless push.mode is after-closing" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "ennyn.mjs clone-setup", count: 1, claim: "cloneSetup", why: "prints the clone's settings; with a login it asks GitHub for keys" },
  { file: "plugin/skills/init/SKILL.md", kind: "step", key: "gh issue list --state open --limit 50 --json number,title,labels", count: 1, claim: "initIssues" },
  { file: "plugin/skills/init/SKILL.md", kind: "step", key: "gh", count: 1, claim: "initIssues", why: "the issue question's condition: gh works" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm -v", count: 1, claim: "initNpm", why: "asked nothing on npm 10.9.9; claimed with init's other npm checks" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm prefix", count: 1, claim: "initNpm", why: "npm 10.9.9's update check asked its registry for npm, once a cache" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm config get ignore-scripts", count: 1, claim: "initNpm", why: "as npm prefix" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm test", count: 1, why: "what .npmrc leaves running, said; the test command is the project's own" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm run", count: 1, why: "what .npmrc leaves running, said" },
  { file: "plugin/skills/init/new-project.md", kind: "step", key: "npm create vite@latest my-app", count: 1, claim: "initScaffold", why: "the scaffold of a new project, which reaches the package manager's registry" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "git remote set-url", count: 1, why: "how a remote's url changes, said; it writes the config" },
  { file: "plugin/skills/cycle/push.md", kind: "step", key: "git remote get-url --push --all", count: 1, why: "push-check's read of the push url: reads the config" },
  { file: "plugin/skills/cycle/task-brief.md", kind: "step", key: "git remote add origin ../up.git", count: 1, why: "a lab's upstream, a folder on the machine: writes the config" },
  { file: "plugin/skills/init/agent-mode.md", kind: "step", key: "gh", count: 1, why: "a token a gh call uses, for the sandbox's credentials" },
  { file: "plugin/skills/init/agent-mode.md", kind: "step", key: "git push", count: 1, why: "how the sandbox treats the closing's push, which closingPush names" },
  { file: "plugin/skills/cycle/task-brief.md", kind: "step", key: "git push", count: 2, why: "the rule that a lab never pushes, and the ask rule that waits" },
  { file: "plugin/skills/cycle/task-brief.md", kind: "step", key: "git -C up.git fetch -q ../repo main:main", count: 1, why: "a lab's upstream: a fetch between two folders on the machine" },
  { file: "plugin/skills/cycle/task-brief.md", kind: "step", key: "git fetch -q origin", count: 1, why: "a lab's upstream, origin being ../up.git" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "git push", count: 9, why: "the ask rule init proposes and the push mode question; the push is closingPush's" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "npm publish", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "pnpm publish", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "npm run deploy", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh repo create x --source . --push", count: 1, why: "why a repository with no remote gets the gh rules" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh pr merge", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh repo sync", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh release", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh repo create", count: 2, why: "an ask rule's command, proposed, and what runs unasked without it" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh gist create", count: 1, why: "an ask rule's command, proposed" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh api", count: 3, why: "an ask rule's command and its limits" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh api *-X POST*", count: 1, why: "an ask rule as the scan writes it" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh api repos/x -X POST", count: 1, why: "what a mistyped rule lets run" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh release *", count: 1, why: "an ask rule, as doctor counts it" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "gh release view", count: 1, why: "a read that rule asks about too" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "npm install -g", count: 1, why: "an offered rule's command" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "pnpm add -g", count: 1, why: "an offered rule's command" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "npm install --global-style tsx", count: 1, why: "a harmless command such a rule stops, as a limit" },
  { file: "plugin/skills/init/gates.md", kind: "step", key: "pnpm exec", count: 1, why: "a spelling such a rule does not stop, as a limit" },
];

/**
 * The sites of `files` set against an allow list, both ways: a site whose count the list does not hold, and an
 * entry no file holds.
 * @param {string[]} files @param {(file: string) => string} readFile @param {{ file: string, kind: string, key: string, count: number }[]} list
 */
function offList(files, readFile, list) {
  /** @type {Map<string, number>} */
  const counted = new Map();
  /** @type {Map<string, number[]>} */
  const lines = new Map();
  for (const file of files) {
    for (const s of fileSites(file, readFile(file))) {
      const k = `${file} ${s.kind} ${s.key}`;
      counted.set(k, (counted.get(k) ?? 0) + 1);
      lines.set(k, [...(lines.get(k) ?? []), s.line]);
    }
  }
  const allowed = new Map(list.map((a) => [`${a.file} ${a.kind} ${a.key}`, a.count]));
  const unlisted = [...counted].filter(([k, n]) => allowed.get(k) !== n).map(([k, n]) => `${k}: ${n} in the code (lines ${lines.get(k)?.join(", ")}), ${allowed.get(k) ?? 0} allowed`);
  const gone = [...allowed].filter(([k]) => !counted.has(k)).map(([k, n]) => `${k}: ${n} allowed, none in the code`);
  return { counted, problems: [...unlisted, ...gone] };
}

/**
 * What one command runs, read as shell words (quoted parts unquoted, a quoted word with spaces one word), past what
 * stands in front of it: assignments, shell keywords, `env`, `timeout` and Ennyn's own `lock … --`. `net`: it starts
 * a network program, git on one of `GIT_STEP` (its global options skipped) or one of Ennyn's network commands, named
 * in `ennyn` (Ennyn by name or path, or node with its options on that path).
 * @param {string} cmd
 * @returns {{ net: boolean, ennyn?: string }}
 */
export function stepCommand(cmd) {
  return runs((cmd.match(WORD) ?? []).map((w) => w.replace(/"((?:\\.|[^"\\])*)"?|'([^']*)'?/g, (_, d, s) => d ?? s)));
}

/** @param {string[]} words @returns {{ net: boolean, ennyn?: string }} */
function runs(words) {
  let i = 0;
  const options = (/** @type {(w: string) => boolean} */ valued) => {
    while (words[i]?.startsWith("-")) i += valued(words[i]) ? 2 : 1;
  };
  for (;;) {
    while (/^\w+=/.test(words[i] ?? "")) i++;
    if (LEADING.has(words[i])) i++;
    else if (words[i] === "env") (i++, options((w) => w === "-u" || w === "-C" || w === "-S"));
    else if (words[i] === "timeout") (i++, options((w) => w === "-k" || w === "-s"), i++);
    else break;
  }
  const program = words[i];
  if (program === undefined) return { net: false };
  const name = program.slice(program.lastIndexOf("/") + 1).toLowerCase();
  if (NET_NAMES.has(name)) return { net: true };
  i++;
  if (name === "git") {
    options((w) => GIT_VALUED.has(w));
    return { net: GIT_STEP.has(words[i]) };
  }
  if (name === "node") {
    options(() => false);
    if (!/(?:^|\/)ennyn\.mjs$/.test(words[i++] ?? "")) return { net: false };
  } else if (name !== "ennyn" && name !== "ennyn.mjs") return { net: false };
  options(() => false);
  const sub = words[i];
  if (sub === "lock") {
    const end = words.indexOf("--", i);
    return end < 0 ? { net: false } : runs(words.slice(end + 1));
  }
  return sub !== undefined && Object.hasOwn(ENNYN_NET, sub) ? { net: true, ennyn: sub } : { net: false };
}

/**
 * The allow-list steps that run one of Ennyn's network commands with a claim other than that command's.
 * @param {typeof ALLOWED} list
 */
function wrongClaims(list) {
  return list.flatMap((a) => {
    const c = a.kind === "step" ? stepCommand(a.key).ennyn : undefined;
    return c && Object.hasOwn(ENNYN_NET, c) && a.claim !== ENNYN_NET[c] ? [`${a.file} ${a.key}: claim ${a.claim ?? "none"}, not ${ENNYN_NET[c]}`] : [];
  });
}

/** The README's list: from its lead to the line that points at SECURITY.md's section. @param {string} text @param {string} lead */
function readmeList(text, lead) {
  const from = text.indexOf(lead);
  const to = text.indexOf("(SECURITY.md#what-ennyn-runs-on-a-machine)", from);
  return from < 0 || to < 0 ? null : text.slice(from, to);
}

/** SECURITY.md's section "What Ennyn runs on a machine". @param {string} text */
function securitySection(text) {
  const from = text.indexOf("## What Ennyn runs on a machine\n");
  if (from < 0) return null;
  const to = text.indexOf("\n## ", from + 1);
  return text.slice(from, to < 0 ? undefined : to);
}

const read = (/** @type {string} */ p) => readFileSync(join(TOP, p), "utf8");

test("network claim: every fetch, network import, child process and network word of the shipped code is on the allow list, counted per file", () => {
  // The scanner, on shapes it must find and look-alikes it must pass.
  const found = (/** @type {string} */ text) => sites(text).map((s) => `${s.kind}:${s.key}`);
  assert.deepEqual(found('const r = await fetch(url);\nglobalThis.fetch(u);\nnew WebSocket("wss://x");\nawait globalThis.fetch?.(url);'), ["call:fetch", "call:fetch", "call:WebSocket", "call:fetch"]);
  assert.deepEqual(found('import { get } from "node:https";\nimport net from "net";\nconst d = await import("node:dns/promises");\nrequire("http2");\nimport "node:tls";\nconst h = req("node:https");'), ["import:https", "import:net", "import:dns", "import:http2", "import:tls", "import:https"]);
  assert.deepEqual(found('spawnSync("curl", ["-s", u]);\ncp.execFile(cmd, []);\nexec(`git push`);'), ['program:"curl"', "word:curl", "program:cmd", "program:`git push`", "word:git push"]);
  assert.deepEqual(found('git(["fetch", "--quiet", remote], { cwd });\nconst w = "ls-remote";'), ["word:fetch", "word:ls-remote"]);
  // child_process under a name, its functions renamed, and arguments on the next lines.
  assert.deepEqual(found('import * as cp from "node:child_process";\nconst out = cp.execSync("npm view left-pad version");\ncp.exec("ssh host uptime", done);'), ['program:"npm view left-pad version"', 'program:"ssh host uptime"']);
  assert.deepEqual(found('const childProcess = require("child_process");\nchildProcess.execSync("gh issue list --state open");'), ['program:"gh issue list --state open"']);
  assert.deepEqual(found('import { execSync as run, spawn } from "node:child_process";\nrun("npm ci");'), ['program:"npm ci"']);
  assert.deepEqual(found('spawnSync(\n  "npm view x",\n  { shell: true },\n);'), ['program:"npm view x"']);
  assert.deepEqual(found('import { exec } from "node:child_process";\nconst run = promisify(exec);\nawait run("npm view left-pad version");'), ['program:"npm view left-pad version"']);
  assert.deepEqual(found('import * as cp from "node:child_process";\nconst run = util.promisify(cp.exec);\nawait run("gh api user");\nconst wait = promisify(setTimeout);\nawait wait(5);\nconst match = promisify(re.exec);\nmatch("x");'), ['program:"gh api user"']);
  assert.deepEqual(found('spawnSync("git", ["status"]);\nspawnSync(\'git\', [\'status\']);\nspawn(process.execPath, [m]);\nconst m = RE.exec(text);\nconst n = cp.exec;\nobj.fetchJson(u);\n * fetch(url) in a comment\n * spawnSync("curl") in a comment\nconst re = /could not fetch (\\w+)/;\nconst s = "git status";\n * a comment says "fetch" and `push`\n// "curl"\nconst word = "fetched";'), []);
  // A shell file, unquoted; a manifest's commands and servers.
  assert.deepEqual(shellSites("#!/bin/sh\n# curl in a comment\ncurl -fsSL https://x.invalid/i.sh | sh\nnode a.mjs && git fetch origin\nInvoke-WebRequest -Uri $u\necho done\n").map((s) => `${s.key}:${s.line}`), ["curl:3", "git fetch:4", "invoke-webrequest:5"]);
  const own = 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/hooks/x.mjs"';
  assert.deepEqual(manifestSites(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: own }] }] } })), []);
  assert.deepEqual(manifestSites(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "curl -s https://x.invalid" }, { type: "http", url: "https://x.invalid/h" }] }] }, mcpServers: { s: { command: "npx", args: ["-y", "srv"] } } })).map((s) => s.key), ['command "curl -s https://x.invalid"', "hook type http", 'mcpServers {"s":{"command":"npx","args":["-y","srv"]}}', 'command "npx"']);
  // A skill's or an agent's commands: code spans and block lines, by their head, chained ones apart; Ennyn's network
  // commands in each spelling; prose, a later word, a local git call and another Ennyn command are no site.
  const step = (/** @type {string} */ text) => stepSites(text).map((s) => `${s.key}:${s.line}`);
  assert.deepEqual(step("Run `curl -s https://x.invalid` first.\nThen `npx srv` and `ssh host`, `wget u`, `gh issue list`.\n`git -C up fetch -q ../r`, `GIT_DIR=x git ls-remote o`, `Bash(npm publish *)`."), ["curl -s https://x.invalid:1", "npx srv:2", "ssh host:2", "wget u:2", "gh issue list:2", "git -C up fetch -q ../r:3", "GIT_DIR=x git ls-remote o:3", "npm publish *:3"]);
  assert.deepEqual(step("`cd repo && git push`, `ennyn.mjs deps --json`, `ennyn push-check`, `node scripts/ennyn.mjs clone-setup`, `node \"${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs\" commit-check`, `x=$(git fetch o)`"), ["git push:1", "ennyn.mjs deps --json:1", "ennyn push-check:1", "node scripts/ennyn.mjs clone-setup:1", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs" commit-check:1', "git fetch o:1"]);
  assert.deepEqual(step("```sh\nset -eu\n$ curl -fsSL u | sh\nnode a.mjs && npm ci\n```\n```md\n### Checks: `ennyn.mjs deps`\n```"), ["curl -fsSL u:3", "npm ci:4", "ennyn.mjs deps:7"]);
  assert.deepEqual(step("Run git fetch and curl by hand.\n`ennyn.mjs doctor`, `ennyn.mjs leftovers`, `git status`, `npmrc`, `ghost`, `echo curl`, `git log --grep push`, `ennyn.mjs constructor`\n```json\n{ \"npm\": 1 }\n```"), []);
  // Review round one (cycle 59): wrappers, git's global options and its remote and submodule words (as the code
  // reading counts them), Ennyn by path or with node's options, shell keywords and groups, quoted words with spaces.
  const each = (/** @type {string[]} */ spans) => step(spans.map((s) => "\`" + s + "\`").join(" "));
  const wrapped = ["ennyn.mjs lock --limit 30 -- npm run test:linux", "node scripts/ennyn.mjs lock -- node scripts/ennyn.mjs deps", "timeout 60 npm ci", "timeout -k 5 60s git fetch", "env CI=1 npm ci"];
  assert.deepEqual(each(wrapped), wrapped.map((s) => s + ":1"));
  const gitForms = ["git --no-pager fetch origin", "git --git-dir=../up.git fetch origin", "git --work-tree ../w -C ../r -c core.x=y push origin main", "git remote update", "git remote get-url origin", "git submodule update --init", "git pull --rebase"];
  assert.deepEqual(each(gitForms), gitForms.map((s) => s + ":1"));
  const ennynForms = ["plugin/scripts/ennyn.mjs deps", "node --no-warnings scripts/ennyn.mjs deps", "ennyn.mjs --json deps", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs"  deps'];
  assert.deepEqual(each(ennynForms), ennynForms.map((s) => s.replace(/\s+/g, " ") + ":1"));
  assert.deepEqual(step("\`if true; then git push; fi\`, \`! git fetch origin\`, \`{ git fetch origin; }\`, \`while true; do curl u; done\`"), ["then git push:1", "! git fetch origin:1", "{ git fetch origin:1", "do curl u:1"]);
  assert.deepEqual(step('\`GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push\`, \`git -C "$HOME/my repo" fetch\`, \`X=\'a b\' npm ci\`'), ['GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push:1', 'git -C "$HOME/my repo" fetch:1', "X='a b' npm ci:1"]);
  // Look-alikes the wrappers and keywords must not turn into sites.
  assert.deepEqual(step("\`ennyn.mjs lock --limit 30 -- node scripts/ennyn.mjs test fast\`, \`timeout 60 node a.mjs\`, \`env CI=1 node a.mjs\`, \`then echo push\`, \`git -C ../r status\`, \`git --no-pager log --grep fetch\`, \`node --check scripts/ennyn.mjs\`, \`ennyn.mjs --json doctor\`"), []);
  // A fence line with an info string inside a block is the block's text, not its end (CommonMark: a closing fence has none).
  assert.deepEqual(step("```md\n```sh\ncurl x\n```"), ["curl x:3"]);
  assert.deepEqual(step("A `span broken\nover` two lines."), ["unread: a code span this reading cannot pair:1", "unread: a code span this reading cannot pair:2"]);
  // Which files are read as steps: the skills' and the agents' Markdown, no other.
  for (const f of ["plugin/skills/x/SKILL.md", "plugin/agents/x.md"]) assert.deepEqual(fileSites(f, "`curl u`").map((s) => s.key), ["curl u"], f);
  for (const f of ["docs/x.md", "plugin/skills/x/notes.txt", "README.md"]) assert.deepEqual(fileSites(f, "`curl u`"), [], f);
  // Each of Ennyn's network commands is one the CLI has.
  const cliText = read("plugin/scripts/ennyn.mjs");
  for (const c of Object.keys(ENNYN_NET)) assert.match(cliText, new RegExp(String.raw`^  (?:async )?(?:"${escape(c)}"|${escape(c)})\(args\) \{$`, "m"), `ennyn ${c}`);
  // The files are git's: tracked and untracked unignored, not an ignored worktree, a nested repository or test/.
  const box = mkdtempSync(join(tmpdir(), "nc-walk-"));
  git(["init", "-q", "-b", "main"], { cwd: box });
  for (const [f, text] of Object.entries({ ".gitignore": "ignored/\n", "a.mjs": "", "test/t.mjs": "", "ignored/c.mjs": "", "nest/d.mjs": "", "lab/b.mjs": "" })) {
    mkdirSync(dirname(join(box, f)), { recursive: true });
    writeFileSync(join(box, f), text);
  }
  git(["add", ".gitignore", "a.mjs", "test/t.mjs"], { cwd: box });
  git(["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "t"], { cwd: box });
  git(["init", "-q"], { cwd: join(box, "nest") });
  git(["worktree", "add", "-q", "ignored/agent-1"], { cwd: box });
  assert.deepEqual(ownFiles(box), [".gitignore", "a.mjs", "lab/b.mjs"]);
  const files = ownFiles(TOP);
  assert.ok(["plugin/checks/deps.mjs", "plugin/scripts/ennyn.mjs", "scripts/ennyn.mjs", "plugin/hooks/hooks.json", "plugin/.claude-plugin/plugin.json"].every((f) => files.includes(f)), `the walk found the shipped code: ${files.length} files`);
  const { counted, problems } = offList(files, read, ALLOWED);
  assert.equal(new Set(ALLOWED.map((a) => `${a.file} ${a.kind} ${a.key}`)).size, ALLOWED.length, "each allow-list entry once");
  assert.deepEqual(problems, [], "a network site the allow list does not hold, or an entry the code no longer holds: name it in the README's list and SECURITY.md, or say why it reaches nothing");
  // The comparison's control: a step off the list, a count that differs and an entry no file holds, each said.
  const fake = /** @type {Record<string, string>} */ ({ "plugin/skills/a/SKILL.md": "Run `curl u`, then `gh api x` and `gh api x`.\n", "plugin/agents/b.md": "" });
  const fakeList = [{ file: "plugin/skills/a/SKILL.md", kind: "step", key: "gh api x", count: 1, why: "made up" }, { file: "plugin/agents/b.md", kind: "step", key: "ssh h", count: 1, why: "made up" }];
  assert.deepEqual(offList(Object.keys(fake), (f) => fake[f], fakeList).problems, ["plugin/skills/a/SKILL.md step curl u: 1 in the code (lines 1), 0 allowed", "plugin/skills/a/SKILL.md step gh api x: 2 in the code (lines 1, 1), 1 allowed", "plugin/agents/b.md step ssh h: 1 allowed, none in the code"]);
  // The calls the documents name are there: the scan reads what it says it reads.
  for (const k of ["plugin/checks/deps.mjs call fetch", "plugin/setup/clone-setup.mjs call fetch", "plugin/checks/test-runs.mjs word fetch", "plugin/skills/cycle/SKILL.md step ennyn.mjs deps", "plugin/skills/init/SKILL.md step gh issue list --state open --limit 50 --json number,title,labels"]) assert.ok(counted.has(k), k);
  // A step that runs one of Ennyn's network commands maps to that command's claim, not to a why or another claim.
  assert.deepEqual(wrongClaims(ALLOWED), []);
  const bad = [{ file: "f.md", kind: "step", key: "ennyn.mjs deps", count: 1, why: "said elsewhere" }, { file: "f.md", kind: "step", key: "node scripts/ennyn.mjs push-check", count: 1, claim: /** @type {const} */ ("osv") }];
  assert.deepEqual(wrongClaims(bad), ["f.md ennyn.mjs deps: claim none, not osv", "f.md node scripts/ennyn.mjs push-check: claim osv, not pushCheck"]);
});

/**
 * What the documents leave unsaid: for each claim, a word missing from a README's list or SECURITY.md's section,
 * a claim no code site carries that names no source, and a source that no longer holds its words.
 * @param {{ en: string, tr: string, security: string }} docs @param {(file: string) => string} readFile
 * @returns {string[]}
 */
function unsaid(docs, readFile) {
  const used = new Set(ALLOWED.flatMap((a) => (a.claim ? [a.claim] : [])));
  /** @type {string[]} */
  const missing = [];
  for (const [id, c] of Object.entries(CLAIMS)) {
    if (!used.has(id) && !c.sources?.length) missing.push(`${id}: no site carries it and it names no source`);
    for (const s of c.sources ?? []) if (!readFile(s.file).includes(s.text)) missing.push(`${id}: ${s.file} no longer holds ${s.text}`);
    for (const w of [...c.readme, ...c.en]) if (!docs.en.includes(w)) missing.push(`README.md: ${id} needs ${w}`);
    for (const w of [...c.readme, ...c.tr]) if (!docs.tr.includes(w)) missing.push(`README.tr.md: ${id} needs ${w}`);
    for (const w of c.security) if (!docs.security.includes(w)) missing.push(`SECURITY.md: ${id} needs ${w}`);
  }
  return missing;
}

test("network claim: each allowed call that reaches the network is named in README.md, README.tr.md and SECURITY.md", () => {
  const en = readmeList(read("README.md"), "Ennyn has no runtime dependencies");
  const tr = readmeList(read("README.tr.md"), "Ennyn'in runtime bağımlılığı");
  const security = securitySection(read("SECURITY.md"));
  assert.ok(en && tr, "README.md and README.tr.md: the list from its lead to the SECURITY.md link");
  assert.ok(security, "SECURITY.md: the section What Ennyn runs on a machine");
  for (const a of ALLOWED) assert.ok(a.claim ? a.claim in CLAIMS : typeof a.why === "string" && a.why.length > 0, `${a.file} ${a.key}: a claim or why it reaches nothing`);
  assert.deepEqual(unsaid({ en, tr, security }, read), []);
  // The positive control: with empty documents and sources every claim is missing, in each place.
  const none = unsaid({ en: "", tr: "", security: "" }, () => "");
  for (const id of Object.keys(CLAIMS)) for (const place of ["README.md", "README.tr.md", "SECURITY.md"]) assert.ok(none.some((m) => m.startsWith(`${place}: ${id} `)), `${place}: ${id} is checked`);
  assert.ok(none.some((m) => m.startsWith("partialClone: plugin/core/git.mjs")), "a source is checked");
  // A claim only skill steps carry counts as carried: the steps are read.
  for (const id of ["closingPush", "initIssues", "initNpm"]) assert.ok(!none.some((m) => m.startsWith(`${id}: no site`)), `${id} is carried by a step`);
  // The list names nothing it no longer is: there are more than two cases.
  for (const text of [en, tr]) assert.doesNotMatch(text, /only two cases|iki durumda/);
});

/**
 * A loopback server that keeps every request and its body, and answers `answer`'s JSON, else 404.
 * @param {(url: string) => unknown} [answer]
 */
async function server(answer = () => undefined) {
  /** @type {{ method: string, url: string, body: string }[]} */
  const hits = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ method: String(req.method), url: String(req.url), body });
      const a = answer(String(req.url));
      res.writeHead(a === undefined ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify(a ?? { error: "Not found" }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (s.address()).port}`;
  return { origin, hits, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r(undefined)))) };
}

/** A version 3 lock of the given packages. @param {Record<string, unknown>} packages */
const lock = (packages) => `${JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "demo", version: "1.0.0" }, ...packages } }, null, 2)}\n`;
/** An entry resolved from `origin`'s own tarball, with fields a body must not carry. @param {string} origin @param {string} name */
const entry = (origin, name) => ({
  [`node_modules/${name}`]: { version: "1.0.0", resolved: `${origin}/${name}/-/${name.split("/").pop()}-1.0.0.tgz`, integrity: "sha512-q7Rk2LmVx9Tb", license: "MIT", hasInstallScript: true, dependencies: { other: "^2.0.0" } },
});
/** @param {Record<string, unknown>} deps */
const rule = (deps) => /** @type {import("../plugin/checks/deps.mjs").DepsRule} */ (loadConfig({ cwd: mkdtempSync(join(tmpdir(), "nc-cfg-")), env: {}, override: { security: { deps: { timeout: 120, ...deps } } } }).security.deps);

test("network claim: the OSV request body carries only name, ecosystem and version, and with security.deps.advisories empty ennyn deps asks OSV nothing", async () => {
  const osv = await server((url) => (url === "/v1/querybatch" ? { results: [{ vulns: [{ id: "NC-1" }] }, {}] } : url === "/v1/vulns/NC-1" ? { id: "NC-1", summary: "made up" } : undefined));
  try {
    const entries = lockEntries(lock({ ...entry(osv.origin, "alpha"), ...entry(osv.origin, "@scope/beta") })).entries ?? [];
    assert.equal(entries.length, 2);
    const got = await advisoriesOf(entries, rule({ registries: { [osv.origin]: null }, advisories: osv.origin, advisoryRegistries: [osv.origin] }));
    assert.deepEqual(got.advisories.map((a) => a.id), ["NC-1"], "the answer was read, so the request was the one OSV takes");
    const posts = osv.hits.filter((h) => h.method === "POST");
    assert.deepEqual(posts.map((h) => h.url), ["/v1/querybatch"]);
    const body = JSON.parse(posts[0].body);
    assert.deepEqual(Object.keys(body), ["queries"]);
    // Whole, so a field added beside them (the entry's path, its integrity, its resolved URL) fails.
    assert.deepEqual(body.queries, [{ package: { name: "alpha", ecosystem: "npm" }, version: "1.0.0" }, { package: { name: "@scope/beta", ecosystem: "npm" }, version: "1.0.0" }]);
    // The advisory's own record is a GET with no body.
    assert.deepEqual(osv.hits.filter((h) => h.method !== "POST").map((h) => `${h.method} ${h.url} ${h.body.length}`), ["GET /v1/vulns/NC-1 0"]);
    // The off switch the documents name: the same entries, the advisories origin empty, no request and said so.
    const before = osv.hits.length;
    const off = await advisoriesOf(entries, rule({ registries: { [osv.origin]: null }, advisories: "", advisoryRegistries: [osv.origin] }));
    assert.deepEqual(osv.hits.slice(before), []);
    assert.deepEqual(off.unread.map((u) => u.reason.key), ["advisoriesOff"]);
  } finally {
    await osv.close();
  }
});

/** @param {string[]} args @param {string} cwd */
function cli(args, cwd) {
  return /** @type {Promise<{ status: number, stderr: string }>} */ (
    new Promise((done) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => done({ status: /** @type {number} */ (status), stderr }));
    })
  );
}

test("network claim: with security.deps.online false the commit hook fetches nothing, and with it on it asks the registry", async () => {
  const reg = await server();
  try {
    /** @param {boolean} online */
    const commitHook = async (online) => {
      const dir = mkdtempSync(join(tmpdir(), "nc-repo-"));
      git(["init", "-q", "-b", "main"], { cwd: dir });
      const config = { security: { deps: { registries: { [reg.origin]: reg.origin }, advisories: reg.origin, advisoryRegistries: [reg.origin], timeout: 120, online } } };
      mkdirSync(join(dir, ".ennyn"));
      writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
      git(["add", ".ennyn/config.json"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "chore: base"], { cwd: dir });
      writeFileSync(join(dir, "package-lock.json"), lock(entry(reg.origin, "alpha")));
      git(["add", "package-lock.json"], { cwd: dir });
      writeFileSync(join(dir, ".git", "MSG"), "chore: deps\n");
      const before = reg.hits.length;
      const r = await cli(["commit-check", "--hook", ".git/MSG"], dir);
      return { ...r, asked: reg.hits.slice(before).map((h) => `${h.method} ${h.url}`) };
    };
    const off = await commitHook(false);
    assert.deepEqual(off.asked, [], off.stderr);
    assert.match(off.stderr, /security\.deps\.online is false/, "the check reached the lock and said it stayed offline");
    const on = await commitHook(true);
    assert.ok(on.asked.length > 0 && on.asked.every((h) => h.startsWith("GET /alpha") || h.startsWith("GET /versions/alpha")), `with the key on it asks the registry: ${on.asked.join(", ")}`);
  } finally {
    await reg.close();
  }
});
