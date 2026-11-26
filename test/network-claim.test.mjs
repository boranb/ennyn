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
 * code's. Then the behaviours: the OSV request body carries only name, ecosystem and version, `ennyn deps` asks OSV
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
/** A network program or git network subcommand as a shell line runs it. */
const SHELL_NET = /(?<![\w./-])(curl|wget|npm|npx|pnpm|yarn|gh|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|git\s+(?:fetch|push|pull|clone|ls-remote))(?![\w-])/gi;
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
  return [];
}

/**
 * What the documents say. Each claim's code spans stand in the README's list in both languages (`readme`), its
 * words in each language's list (`en`, `tr`), and its words in SECURITY.md's section (`security`). `sources`: the
 * files and words a claim stands on beside a code site: a step the skills give the agent (the closing's push, its
 * `ennyn deps`, init's issues) or git's own fetch in a partial clone. A claim no code site carries needs one.
 * @type {Record<string, { readme: string[], en: string[], tr: string[], security: string[], sources?: { file: string, text: string }[] }>}
 */
const CLAIMS = {
  registry: { readme: ["`registry.npmjs.org`", "`api.npmjs.org`", "`security.deps.online: false`"], en: ["commit hook"], tr: ["commit hook'u"], security: ["by default `registry.npmjs.org` for the package document and `api.npmjs.org`", "`security.deps.online: false` stops it"] },
  osv: {
    readme: ["`ennyn deps`", "`api.osv.dev`", '`security.deps.advisories: ""`'],
    en: ["when you run it and at the end of each cycle"],
    tr: ["siz çalıştırdığınızda ve her döngünün sonunda"],
    security: ["`ennyn deps`, run by hand and at each cycle's closing", "by default `api.osv.dev`", '`security.deps.advisories: ""` stops it'],
    sources: [{ file: "plugin/skills/cycle/SKILL.md", text: "**Security checks:** `ennyn.mjs deps`" }],
  },
  pushCheck: { readme: ["`ennyn push-check`", "`git fetch`"], en: ["`ennyn push-check` runs `git fetch`"], tr: ["`ennyn push-check` dalınızın remote'unda `git fetch`"], security: ["`push-check` fetches the branch's upstream remote"] },
  cloneSetup: { readme: ["`ennyn clone-setup`", "`api.github.com`"], en: ["signing keys"], tr: ["imzalama anahtarlarını"], security: ["`clone-setup`, with `commits.signed` set and a GitHub login, asks `api.github.com`"] },
  closingPush: { readme: ["`push.mode`", "`after-closing`"], en: ["the agent pushes there"], tr: ["agent da oraya push eder"], security: ["then a `git push` to the branch's upstream"], sources: [{ file: "plugin/skills/cycle/push.md", text: "`git fetch` first" }] },
  initIssues: { readme: ["`/ennyn:init`", "`gh`"], en: ["GitHub issues"], tr: ["GitHub issue'larınızı"], security: ["`/ennyn:init` reads the open issues with `gh issue list`"], sources: [{ file: "plugin/skills/init/SKILL.md", text: "`gh issue list --state open" }] },
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
];

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
  /** @type {Map<string, number>} */
  const counted = new Map();
  /** @type {Map<string, number[]>} */
  const lines = new Map();
  for (const file of files) {
    for (const s of fileSites(file, read(file))) {
      const k = `${file} ${s.kind} ${s.key}`;
      counted.set(k, (counted.get(k) ?? 0) + 1);
      lines.set(k, [...(lines.get(k) ?? []), s.line]);
    }
  }
  const allowed = new Map(ALLOWED.map((a) => [`${a.file} ${a.kind} ${a.key}`, a.count]));
  assert.equal(allowed.size, ALLOWED.length, "each allow-list entry once");
  const unlisted = [...counted].filter(([k, n]) => allowed.get(k) !== n).map(([k, n]) => `${k}: ${n} in the code (lines ${lines.get(k)?.join(", ")}), ${allowed.get(k) ?? 0} allowed`);
  const gone = [...allowed].filter(([k]) => !counted.has(k)).map(([k, n]) => `${k}: ${n} allowed, none in the code`);
  assert.deepEqual([...unlisted, ...gone], [], "a network site the allow list does not hold, or an entry the code no longer holds: name it in the README's list and SECURITY.md, or say why it reaches nothing");
  // The calls the documents name are there: the scan reads what it says it reads.
  for (const k of ["plugin/checks/deps.mjs call fetch", "plugin/setup/clone-setup.mjs call fetch", "plugin/checks/test-runs.mjs word fetch"]) assert.ok(counted.has(k), k);
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
    if (!used.has(id) && !c.sources?.length) missing.push(`${id}: no code site carries it and it names no source`);
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
  assert.ok(none.some((m) => m.startsWith("closingPush: plugin/skills/cycle/push.md")), "a source is checked");
  assert.ok(none.some((m) => m.startsWith("osv: plugin/skills/cycle/SKILL.md")), "a source beside a code site is checked");
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
