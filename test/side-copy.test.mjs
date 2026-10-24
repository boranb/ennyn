import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { loadConfig } from "../core/config.mjs";
import { t } from "../core/i18n.mjs";
import { mapSideCopyPath } from "../side-copy/map-path.mjs";
import {
  loadPathScopedRules,
  parsePaths,
  readRuleBody,
  rulesForPath,
  splitFrontMatter,
} from "../adapters/claude-code/rules-index.mjs";

const hookPath = fileURLToPath(new URL("../adapters/claude-code/hooks/side-copy-rules.mjs", import.meta.url));
const resetPath = fileURLToPath(new URL("../adapters/claude-code/hooks/side-copy-reset.mjs", import.meta.url));

/** Every exit code the hook produced in this file; checked by the last test. */
const exitCodes = [];

const ENGINE_RULE = `---
description: engine rules
paths:
  - "src/lib/engine/**"
---

# Engine
ENGINE-RULE-BODY: coerce nulls before aggregating.
`;
const ALWAYS_RULE = "# Always\nALWAYS-RULE-BODY\n";
const INLINE_RULE = `---
paths: ["server/src/**", "docs/*.{md,txt}"]
---
INLINE-RULE-BODY
`;
const NESTED_RULE = `---
paths:
- server/src/**/*.mjs   # server modules
- 'web/[a-z]*.ts'
---
NESTED-RULE-BODY
`;

/** @param {string} prefix */
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** @param {string} path @param {string} text */
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ---------------------------------------------------------------- fixtures --

const project = tmp("pl-sc-proj-");
put(join(project, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
put(join(project, ".claude/rules/engine.md"), ENGINE_RULE);
put(join(project, ".claude/rules/always.md"), ALWAYS_RULE);
put(join(project, ".claude/rules/inline.md"), INLINE_RULE);
put(join(project, ".claude/rules/sub/nested.md"), NESTED_RULE);
put(join(project, "src/lib/engine/x.ts"), "export const x = 1;\n");
put(join(project, "server/package.json"), JSON.stringify({ name: "demo-server" }));
put(join(project, "server/src/a.mjs"), "export const a = 1;\n");
git(["init", "-q", "-b", "main"], { cwd: project });
git(["add", "."], { cwd: project });
git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: project });

// Plain copies live under a configured root; the worktree deliberately does not.
const scratch = tmp("pl-sc-scratch-");
const copy = join(scratch, "copy");
cpSync(project, copy, { recursive: true, filter: (src) => basename(src) !== ".git" });
const copyWithGit = join(scratch, "copy-with-git");
cpSync(project, copyWithGit, { recursive: true });
const foreign = join(scratch, "foreign");
cpSync(project, foreign, { recursive: true, filter: (src) => basename(src) !== ".git" });
writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "other" }));
const outsideCopy = join(tmp("pl-sc-elsewhere-"), "copy");
cpSync(project, outsideCopy, { recursive: true, filter: (src) => basename(src) !== ".git" });

const worktree = join(tmp("pl-sc-wt-"), "wt");
git(["worktree", "add", "-q", "--detach", worktree], { cwd: project });
const nestedWorktree = join(project, ".claude/worktrees/side");
git(["worktree", "add", "-q", "--detach", nestedWorktree], { cwd: project });

put(join(project, ".ennyn/config.json"), JSON.stringify({ sideCopy: { roots: [scratch] } }));
const configs = tmp("pl-sc-configs-");
const trConfig = join(configs, "tr.json");
writeFileSync(trConfig, JSON.stringify({ language: "tr", sideCopy: { roots: [scratch] } }));
const smallConfig = join(configs, "small.json");
writeFileSync(smallConfig, JSON.stringify({ sideCopy: { roots: [scratch], maxInjectBytes: 60 } }));
const brokenConfig = join(configs, "broken.json");
writeFileSync(brokenConfig, "{");
const unknownKeyConfig = join(configs, "unknown.json");
writeFileSync(unknownKeyConfig, JSON.stringify({ sideCopy: { rootz: [] } }));
const noStateConfig = join(configs, "nostate.json");
// stateDir under a regular file: the directory can never be created.
writeFileSync(noStateConfig, JSON.stringify({ paths: { stateDir: "package.json/state" } }));

const engineRule = join(project, ".claude/rules/engine.md");
const inlineRule = join(project, ".claude/rules/inline.md");
const nestedRule = join(project, ".claude/rules/sub/nested.md");
const real = (p) => realpathSync(p);
const neutralCwd = tmp("pl-sc-cwd-");

// ------------------------------------------------------------------ helpers --

/** Environment for the hook: nothing from the session running these tests leaks in. */
function hookEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_PROJECT_DIR" || k === "ENNYN_CONFIG") delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * @param {unknown} input object (JSON-encoded) or raw stdin string
 * @param {Record<string, string>} [env]
 */
function runHook(input, env = { CLAUDE_PROJECT_DIR: project }) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: hookEnv(env),
    cwd: neutralCwd,
    encoding: "utf8",
    // Claude Code stops this hook at 15 s (hooks/hooks.json): a run past 20 s here would be stopped there too.
    timeout: 20000,
  });
  exitCodes.push(r.status);
  return r;
}

/** @param {string} session @param {string} file @param {string} [tool] */
const readInput = (session, file, tool = "Read") => ({
  session_id: session,
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file },
  cwd: project,
});

/** @param {{ stdout: string }} r */
function context(r) {
  const out = JSON.parse(r.stdout);
  return /** @type {string} */ (out.hookSpecificOutput.additionalContext);
}

// --------------------------------------------------------------- rules-index --

test("rules-index: block, inline and unquoted lists; rules without paths are not indexed", () => {
  const rules = loadPathScopedRules(project);
  assert.deepEqual(rules, [
    { file: engineRule, patterns: ["src/lib/engine/**"] },
    { file: inlineRule, patterns: ["server/src/**", "docs/*.{md,txt}"] },
    { file: nestedRule, patterns: ["server/src/**/*.mjs", "web/[a-z]*.ts"] },
  ]);
  assert.deepEqual(rulesForPath(rules, "src/lib/engine/deep/q.ts"), [engineRule]);
  assert.deepEqual(rulesForPath(rules, "server/src/a.mjs"), [inlineRule, nestedRule]);
  assert.deepEqual(rulesForPath(rules, "docs/guide.txt"), [inlineRule]);
  assert.deepEqual(rulesForPath(rules, "web/ab.ts"), [nestedRule]);
  assert.deepEqual(rulesForPath(rules, "README.md"), []);
  assert.deepEqual(loadPathScopedRules(tmp("pl-sc-norules-")), []);
});

test("rules-index: front matter edge cases", () => {
  assert.deepEqual(parsePaths('paths: [\n  "a/**",\n  "b/*.{ts,tsx}", # c\n  "c/[ab].md"\n]'), [
    "a/**",
    "b/*.{ts,tsx}",
    "c/[ab].md",
  ]);
  assert.deepEqual(parsePaths("paths: src/**, lib/*.{js,mjs}"), ["src/**", "lib/*.{js,mjs}"]);
  assert.deepEqual(parsePaths('paths:\n  - "a\\"b/**"\n  - \'it\'\'s/*\'\ndescription: x\n  - not-paths'), [
    'a"b/**',
    "it's/*",
  ]);
  assert.deepEqual(parsePaths("paths:\n"), []);
  assert.equal(parsePaths("description: no paths here\n  paths: nested-is-not-top-level"), null);
  const fm = splitFrontMatter("﻿---\r\npaths:\r\n  - x/**\r\n---\r\nBODY\r\n");
  assert.equal(fm.frontMatter, "paths:\n  - x/**");
  assert.equal(fm.body, "BODY\n");
  assert.equal(splitFrontMatter("---\npaths: [a]\nno closing line").frontMatter, null);
  assert.equal(readRuleBody(engineRule), "# Engine\nENGINE-RULE-BODY: coerce nulls before aggregating.");
  assert.equal(readRuleBody(join(project, "no-such.md")), null);
});

// ----------------------------------------------------------------- map-path --

test("map-path: git worktree outside the roots maps by common git dir, new files included", () => {
  assert.deepEqual(mapSideCopyPath(join(worktree, "src/lib/engine/x.ts"), { projectDir: project, roots: [] }), {
    root: real(worktree),
    relPath: "src/lib/engine/x.ts",
  });
  // Write of a file that does not exist yet, under directories that do not exist yet.
  assert.deepEqual(mapSideCopyPath(join(worktree, "src/new/deep/y.ts"), { projectDir: project }), {
    root: real(worktree),
    relPath: "src/new/deep/y.ts",
  });
});

test("map-path: in-tree paths are null even under a root and across /var vs /private/var spellings", () => {
  const roots = [dirname(project)];
  assert.equal(mapSideCopyPath(join(project, "src/lib/engine/x.ts"), { projectDir: project, roots }), null);
  assert.equal(mapSideCopyPath(join(real(project), "src/lib/engine/x.ts"), { projectDir: project, roots }), null);
  assert.equal(mapSideCopyPath(join(project, "src/lib/engine/x.ts"), { projectDir: real(project), roots }), null);
  assert.equal(mapSideCopyPath(project, { projectDir: project, roots }), null);
});

test("map-path: a worktree nested inside the project directory is still a side copy", () => {
  assert.deepEqual(mapSideCopyPath(join(nestedWorktree, "src/lib/engine/x.ts"), { projectDir: project }), {
    root: real(nestedWorktree),
    relPath: "src/lib/engine/x.ts",
  });
});

test("map-path: plain copy under a root is matched by package name", () => {
  const roots = [scratch];
  assert.deepEqual(mapSideCopyPath(join(copy, "src/lib/engine/x.ts"), { projectDir: project, roots }), {
    root: real(copy),
    relPath: "src/lib/engine/x.ts",
  });
  // A copy that carried its own .git directory is a different repository; it falls through to the name check.
  assert.deepEqual(mapSideCopyPath(join(copyWithGit, "src/lib/engine/x.ts"), { projectDir: project, roots }), {
    root: real(copyWithGit),
    relPath: "src/lib/engine/x.ts",
  });
  // A workspace package inside the copy has its own name; the copy root above it still wins.
  assert.deepEqual(mapSideCopyPath(join(copy, "server/src/a.mjs"), { projectDir: project, roots }), {
    root: real(copy),
    relPath: "server/src/a.mjs",
  });
  // The root itself can be the copy.
  assert.deepEqual(mapSideCopyPath(join(copy, "src/lib/engine/x.ts"), { projectDir: project, roots: [copy] }), {
    root: real(copy),
    relPath: "src/lib/engine/x.ts",
  });
});

test("map-path: different package name, outside every root, or no roots → null", () => {
  assert.equal(mapSideCopyPath(join(foreign, "src/lib/engine/x.ts"), { projectDir: project, roots: [scratch] }), null);
  assert.equal(mapSideCopyPath(join(outsideCopy, "src/lib/engine/x.ts"), { projectDir: project, roots: [scratch] }), null);
  assert.equal(mapSideCopyPath(join(copy, "src/lib/engine/x.ts"), { projectDir: project, roots: [] }), null);
});

test("map-path: bad input is no side copy; a copy root that cannot be read throws, it is no answer", (t) => {
  assert.equal(mapSideCopyPath("relative/x.ts", { projectDir: project, roots: [scratch] }), null);
  assert.equal(mapSideCopyPath(join(copy, "x.ts"), { projectDir: join(tmpdir(), "pl-sc-missing-xyz"), roots: [scratch] }), null);
  assert.equal(
    mapSideCopyPath(join(copy, "src/x.ts"), { projectDir: project, roots: [/** @type {any} */ (42), "", scratch] })?.relPath,
    "src/x.ts",
  );
  const locked = join(scratch, "locked");
  cpSync(project, locked, { recursive: true, filter: (src) => basename(src) !== ".git" });
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  chmodSync(join(locked, "package.json"), 0o000);
  try {
    // Read as "no package.json", a copy of the project would get no rules and nobody would know.
    assert.throws(() => mapSideCopyPath(join(locked, "src/lib/engine/x.ts"), { projectDir: project, roots: [locked] }), /EACCES/);
  } finally {
    chmodSync(join(locked, "package.json"), 0o644);
  }
});

// --------------------------------------------------------------------- hook --

test("hook (a): reading a worktree file injects the matching rule body", () => {
  const r = runHook(readInput("s-a", join(worktree, "src/lib/engine/x.ts")));
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r);
  assert.match(ctx, /^Rules that apply to src\/lib\/engine\/x\.ts in the project/);
  assert.ok(ctx.includes(`<rule file="${engineRule}">`));
  assert.ok(ctx.includes("ENGINE-RULE-BODY: coerce nulls before aggregating."));
  assert.ok(!ctx.includes("ALWAYS-RULE-BODY"), "always-loaded rules are already in context");
  assert.ok(!ctx.includes("INLINE-RULE-BODY"));
  assert.ok(!ctx.includes("paths:"), "front matter is not injected");
});

test("hook (d): output is hookSpecificOutput.additionalContext, never systemMessage", () => {
  const r = runHook(readInput("s-d", join(worktree, "src/lib/engine/x.ts")));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(typeof out.hookSpecificOutput.additionalContext, "string");
  assert.ok(!("systemMessage" in out));
  assert.ok(!r.stdout.includes("systemMessage"));
});

test("hook (b): a path inside the project produces no output", () => {
  const r = runHook(readInput("s-b", join(project, "src/lib/engine/x.ts")));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("hook (c): each rule is emitted once per session", () => {
  const first = runHook(readInput("s-c", join(worktree, "src/lib/engine/x.ts")));
  assert.ok(context(first).includes("ENGINE-RULE-BODY"));
  assert.ok(existsSync(join(project, ".git/ennyn/side-copy/s-c.json")));
  const again = runHook(readInput("s-c", join(worktree, "src/lib/engine/other.ts"), "Edit"));
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "");
  // A different file in the same session gets only the rules not yet emitted.
  const server = context(runHook(readInput("s-c", join(worktree, "server/src/a.mjs"), "Write")));
  assert.ok(server.includes("INLINE-RULE-BODY") && server.includes("NESTED-RULE-BODY"));
  assert.ok(!server.includes("ENGINE-RULE-BODY"));
  // A new session starts over.
  assert.ok(context(runHook(readInput("s-c2", join(worktree, "src/lib/engine/x.ts")))).includes("ENGINE-RULE-BODY"));
  // A hostile session id cannot escape the state directory.
  const odd = runHook(readInput("../../../escape", join(worktree, "src/lib/engine/x.ts")));
  assert.equal(odd.status, 0);
  assert.deepEqual(readdirSync(join(project, ".git/ennyn/side-copy")).filter((f) => f.startsWith(".._.._.._escape")).map((f) => f.replace(/\+[0-9a-f]{12}\.json$/, "+<digest>.json")), [".._.._.._escape+<digest>.json"]);
});

test("hook: state that cannot be written does not stop the injection", () => {
  const env = { CLAUDE_PROJECT_DIR: project, ENNYN_CONFIG: noStateConfig };
  for (let i = 0; i < 2; i++) {
    const r = runHook(readInput("s-nostate", join(worktree, "src/lib/engine/x.ts")), env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(context(r).includes("ENGINE-RULE-BODY"));
  }
});

test("hook (e): malformed or empty stdin exits 0 with no output", () => {
  for (const input of ["{not json", "", "null", "[1,2]", '"Read"']) {
    const r = runHook(input);
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
  const noPath = runHook({ session_id: "s-e", tool_name: "Read", tool_input: {}, cwd: project });
  assert.equal(noPath.status, 0);
  assert.equal(noPath.stdout, "");
});

test("hook (f): plain copy under a configured root; foreign copy ignored", () => {
  const r = runHook(readInput("s-f", join(copy, "src/lib/engine/x.ts"), "Edit"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(context(r).includes("ENGINE-RULE-BODY"));
  const other = runHook(readInput("s-f2", join(foreign, "src/lib/engine/x.ts")));
  assert.equal(other.status, 0);
  assert.equal(other.stdout, "");
});

test("hook (g): non-file tools produce no output", () => {
  const r = runHook({
    session_id: "s-g",
    tool_name: "Bash",
    tool_input: { command: `cat ${worktree}/src/lib/engine/x.ts`, file_path: join(worktree, "src/lib/engine/x.ts") },
    cwd: project,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("hook (h): above maxInjectBytes only the rule paths are listed", () => {
  const r = runHook(readInput("s-h", join(worktree, "server/src/a.mjs")), {
    CLAUDE_PROJECT_DIR: project,
    ENNYN_CONFIG: smallConfig,
  });
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r);
  assert.match(ctx, /too large to inline/);
  assert.deepEqual(ctx.split("\n").slice(1), [`- ${inlineRule}`, `- ${nestedRule}`]);
  assert.ok(!ctx.includes("INLINE-RULE-BODY"));
});

test("hook (k): within the budget as many rules as fit are inlined, the rest listed by path", () => {
  const full = context(runHook(readInput("s-k1", join(worktree, "server/src/a.mjs"))));
  const parts = full.split(/\n\n(?=<rule file=)/);
  assert.equal(parts.length, 3, "header + two rule blocks with the default budget");
  const bytes = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");
  // The budget keeps room for the list the rules would make were none of them inlined.
  const reserve = bytes([t("sidecopy.tooLarge", { relPath: "server/src/a.mjs" }, "en"), `- ${inlineRule}`, `- ${nestedRule}`].join("\n")) + 2;
  const budget = bytes(parts[0]) + 2 + bytes(parts[1]) + 1 + reserve;
  const cfg = join(configs, "one-fits.json");
  writeFileSync(cfg, JSON.stringify({ sideCopy: { roots: [scratch], maxInjectBytes: budget } }));
  const ctx = context(runHook(readInput("s-k2", join(worktree, "server/src/a.mjs")), { CLAUDE_PROJECT_DIR: project, ENNYN_CONFIG: cfg }));
  assert.ok(ctx.startsWith(parts[0]));
  assert.ok(ctx.includes(parts[1]), "the first rule is inlined");
  assert.ok(!ctx.includes(parts[2]), "the second rule is not inlined");
  const second = /<rule file="([^"]+)">/.exec(parts[2])?.[1];
  assert.ok(second);
  assert.match(ctx, /too large to inline/);
  assert.ok(ctx.endsWith(`- ${second}`));
});

test("reset hook: after compaction or /clear the rules come back; other session starts keep the list", () => {
  const reset = (/** @type {string} */ source) =>
    spawnSync(process.execPath, [resetPath], {
      input: JSON.stringify({ session_id: "s-reset", hook_event_name: "SessionStart", source, cwd: project }),
      env: hookEnv({ CLAUDE_PROJECT_DIR: project }),
      cwd: neutralCwd,
      encoding: "utf8",
    });
  const read = () => runHook(readInput("s-reset", join(worktree, "src/lib/engine/x.ts")));
  assert.ok(context(read()).includes("ENGINE-RULE-BODY"));
  assert.equal(read().stdout, "", "second read in the same session: already given");
  assert.equal(reset("startup").status, 0);
  assert.equal(read().stdout, "", "a plain session start keeps the list");
  assert.equal(reset("compact").status, 0);
  assert.ok(context(read()).includes("ENGINE-RULE-BODY"), "after compaction the rule is given again");
  assert.equal(reset("clear").status, 0);
  assert.ok(context(read()).includes("ENGINE-RULE-BODY"), "after /clear the rule is given again");
  for (const bad of ["{not json", "", "null"]) {
    const r = spawnSync(process.execPath, [resetPath], { input: bad, env: hookEnv({ CLAUDE_PROJECT_DIR: project }), encoding: "utf8" });
    assert.equal(r.status, 0);
  }
});

test("reset hook audit: a reset it cannot do is said to the user; a rule it cannot read is named, not dropped", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads and writes anywhere");
  const { sideCopyStatePath } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  runHook(readInput("s-locked", join(worktree, "src/lib/engine/x.ts")));
  const dir = dirname(sideCopyStatePath(project, ".git/ennyn", "s-locked"));
  chmodSync(dir, 0o555);
  try {
    const r = spawnSync(process.execPath, [resetPath], {
      input: JSON.stringify({ session_id: "s-locked", hook_event_name: "SessionStart", source: "compact", cwd: project }),
      env: hookEnv({ CLAUDE_PROJECT_DIR: project }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /^ennyn: the side-copy rules given in this session could not be reset, .*EACCES/);
  } finally {
    chmodSync(dir, 0o755);
  }
  chmodSync(engineRule, 0o000);
  try {
    const r = runHook(readInput("s-unreadable", join(worktree, "src/lib/engine/x.ts")));
    assert.equal(r.status, 0, r.stderr);
    assert.match(context(r), new RegExp(`could not be read, so whether they apply to src/lib/engine/x\\.ts was not checked: .*${basename(engineRule).replace(".", "\\.")}`));
  } finally {
    chmodSync(engineRule, 0o644);
  }
  // Not marked as given: once it can be read, the same session gets it.
  assert.ok(context(runHook(readInput("s-unreadable", join(worktree, "src/lib/engine/x.ts")))).includes("ENGINE-RULE-BODY"));
});

test("map-path audit: a copy git will not open is mapped by its .git file only when that names a worktree of the project", () => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "en-sc-gitfile-")));
  git(["init", "-q", "-b", "main"], { cwd: proj });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "root"], { cwd: proj });
  // Git dirs git refuses to open (a repository format it does not know), one where a worktree's would be
  // and one where a submodule's would be.
  for (const sub of ["worktrees/side", "modules/sub"]) {
    const gitdir = join(proj, ".git", sub);
    git(["init", "-q", "--bare", gitdir], { cwd: proj });
    git(["config", "core.repositoryformatversion", "99"], { cwd: gitdir });
  }
  const copy = (/** @type {string} */ sub) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-sc-copy-")));
    writeFileSync(join(dir, ".git"), `gitdir: ${join(proj, ".git", sub)}\n`);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.js"), "x\n");
    return join(dir, "src", "x.js");
  };
  assert.equal(mapSideCopyPath(copy("worktrees/side"), { projectDir: proj })?.relPath, "src/x.js");
  assert.equal(mapSideCopyPath(copy("modules/sub"), { projectDir: proj }), null, "a submodule is another repository");
});

test("hook (j): Turkish output when the project language is tr", () => {
  const r = runHook(readInput("s-j", join(worktree, "src/lib/engine/x.ts")), {
    CLAUDE_PROJECT_DIR: project,
    ENNYN_CONFIG: trConfig,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /^Projede src\/lib\/engine\/x\.ts için geçerli kurallar \(yan kopyada çalışıyorsun/);
});

test("hook: project dir falls back to input.cwd; NotebookEdit uses notebook_path", () => {
  const r = runHook(readInput("s-cwd", join(worktree, "src/lib/engine/n.ipynb"), "NotebookEdit"), {});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(context(r).includes("ENGINE-RULE-BODY"));
});

test("hook: config errors exit 1 with the reason on stderr and nothing on stdout", () => {
  for (const cfg of [brokenConfig, unknownKeyConfig]) {
    const r = runHook(readInput("s-cfg", join(worktree, "src/lib/engine/x.ts")), {
      CLAUDE_PROJECT_DIR: project,
      ENNYN_CONFIG: cfg,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /Invalid ennyn config/);
  }
});

test("hook: every file tool it handles gets the rule (hooks.json's matcher sends exactly these: test/plugin.test.mjs)", async () => {
  const { FILE_TOOLS } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  assert.ok(FILE_TOOLS.size >= 5);
  for (const tool of FILE_TOOLS) {
    const r = runHook(readInput(`s-matcher-${tool}`, join(worktree, "src/lib/engine/x.ts"), tool));
    assert.ok(context(r).includes("ENGINE-RULE-BODY"), tool);
  }
});

test("hook (i): every exit code observed is 0 or 1, never 2", () => {
  assert.ok(exitCodes.length >= 20, `only ${exitCodes.length} hook runs observed`);
  assert.ok(exitCodes.includes(0) && exitCodes.includes(1));
  for (const code of exitCodes) assert.ok(code === 0 || code === 1, `exit code ${code}`);
});

test("side-copy audit: a git that cannot run is no 'not a side copy': the hook says it cannot run", () => {
  // A worktree of its own: the common-dir answer for the others is cached.
  const fresh = join(tmp("pl-sc-wt-nogit-"), "wt");
  git(["worktree", "add", "-q", "--detach", fresh], { cwd: project });
  const saved = process.env.PATH;
  process.env.PATH = tmp("pl-sc-nogit-");
  try {
    assert.throws(() => mapSideCopyPath(join(fresh, "src", "lib", "engine", "x.ts"), { projectDir: project }), /git did not start/);
  } finally {
    process.env.PATH = saved;
  }
});

test("side-copy audit: another repository this git cannot open is no worktree of the project, and no failure", () => {
  const other = tmp("pl-sc-newer-");
  git(["init", "-q"], { cwd: other });
  // A repository a newer git made: this git refuses to open it.
  git(["config", "core.repositoryformatversion", "1"], { cwd: other });
  git(["config", "extensions.fromthefuture", "true"], { cwd: other });
  put(join(other, "src/lib/engine/x.ts"), "export const x = 1;\n");
  assert.equal(mapSideCopyPath(join(other, "src/lib/engine/x.ts"), { projectDir: project }), null);
});

test("side-copy audit: a rule edited during the session is given again, with its new text, and only that rule", () => {
  const rule = join(project, ".claude/rules/audit-stale.md");
  put(rule, '---\npaths:\n  - "src/audit/**"\n---\nSTALE-V1\n');
  try {
    const first = context(runHook(readInput("s-stale", join(worktree, "src/audit/a.ts"))));
    assert.match(first, /STALE-V1/);
    assert.equal(runHook(readInput("s-stale", join(worktree, "src/audit/b.ts"))).stdout, "", "unchanged: given once");
    put(rule, '---\npaths:\n  - "src/audit/**"\n---\nSTALE-V2\n');
    const again = context(runHook(readInput("s-stale", join(worktree, "src/audit/c.ts"))));
    assert.match(again, /STALE-V2/);
    assert.doesNotMatch(again, /STALE-V1/);
    assert.equal(runHook(readInput("s-stale", join(worktree, "src/audit/d.ts"))).stdout, "", "the new text is given once too");
    // The state keeps one entry for the rule, not one for each text it ever had.
    const state = JSON.parse(readFileSync(join(project, ".git/ennyn/side-copy/s-stale.json"), "utf8")).emitted;
    assert.equal(state.filter((/** @type {string} */ e) => e.startsWith(`${rule}#`)).length, 1, JSON.stringify(state));
  } finally {
    rmSync(rule, { force: true });
  }
});

test("side-copy audit: session ids that clean up to the same name keep lists of their own", () => {
  const file = join(worktree, "src/lib/engine/x.ts");
  assert.match(context(runHook(readInput("s/one", file))), /ENGINE-RULE-BODY/);
  assert.match(context(runHook(readInput("s_one", file))), /ENGINE-RULE-BODY/, "another session: its own list");
  assert.match(context(runHook(readInput("s:one", file))), /ENGINE-RULE-BODY/);
  assert.equal(runHook(readInput("s/one", file)).stdout, "", "the same session: given once");
});

test("side-copy audit: the text never passes the 10,000 characters Claude Code shows a model, rules inlined, listed or not read", async () => {
  const { render, CONTEXT_CAP } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  const rule = (/** @type {number} */ i, /** @type {number} */ n) => ({ file: `/p/.claude/rules/r${i}.md`, body: "x".repeat(n) });
  // A rule bigger than the cap: listed, the small one after it inlined.
  const big = render("src/a.ts", [rule(1, 12000), rule(2, 100)], 10000, "en").text;
  assert.ok(big.length <= CONTEXT_CAP, String(big.length));
  assert.match(big, /<rule file="\/p\/\.claude\/rules\/r2\.md">/);
  assert.match(big, /- \/p\/\.claude\/rules\/r1\.md$/);
  // Many rules that fit one by one: inlined until the list and the unread note still fit after them.
  const unread = [`/p/.claude/rules/${"y".repeat(300)}.md`];
  const many = render("src/a.ts", Array.from({ length: 40 }, (_, i) => rule(i, 400)), 10000, "en", unread).text;
  assert.ok(many.length <= CONTEXT_CAP && Buffer.byteLength(many) <= CONTEXT_CAP, String(many.length));
  assert.ok(many.endsWith(`${unread[0]}`));
  // More rule paths than the cap holds: as many as fit, and how many more.
  const lots = render("src/a.ts", Array.from({ length: 600 }, (_, i) => rule(i, 20000)), 10000, "en").text;
  assert.ok(lots.length <= CONTEXT_CAP, String(lots.length));
  assert.match(lots, /…and \d+ more rule files that apply here$/);
  // A text in two-byte letters is measured in bytes, never more characters than bytes.
  const tr = render("src/a.ts", [{ file: "/p/ğ.md", body: "ş".repeat(6000) }], 10000, "tr").text;
  assert.ok(tr.length <= CONTEXT_CAP);
  assert.equal(loadConfig({ cwd: tmp("pl-sc-cap-"), env: {}, override: { sideCopy: { maxInjectBytes: 24000 } } }).sideCopy.maxInjectBytes, 24000, "loads; held to the cap");
  assert.equal(loadConfig({ cwd: tmp("pl-sc-cap-"), env: {} }).sideCopy.maxInjectBytes, 9000);
});

test("side-copy audit: a subagent's context keeps its own list; the main conversation still gets the rule", () => {
  const file = join(worktree, "src/lib/engine/x.ts");
  const sub = (/** @type {string} */ agent) => ({ ...readInput("s-agents", file), agent_id: agent, agent_type: "general-purpose" });
  assert.match(context(runHook(sub("a1"))), /ENGINE-RULE-BODY/);
  assert.equal(runHook(sub("a1")).stdout, "", "the same subagent: given once");
  assert.match(context(runHook(sub("a2"))), /ENGINE-RULE-BODY/, "another subagent");
  assert.match(context(runHook(readInput("s-agents", file))), /ENGINE-RULE-BODY/, "the main conversation never got it");
  assert.equal(runHook(readInput("s-agents", file)).stdout, "");
});

test("side-copy audit (mutation pass): the cap holds for any budget given, counts the note after the rules, and is measured in bytes", async (tc) => {
  const { render, CONTEXT_CAP } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  const rule = (/** @type {number} */ i, /** @type {number} */ n) => ({ file: `/p/.claude/rules/r${i}.md`, body: "x".repeat(n) });
  // A budget above the cap, given by a caller the config does not check.
  assert.ok(render("src/a.ts", [rule(1, 6000), rule(2, 6000), rule(3, 6000)], 24000, "en").text.length <= CONTEXT_CAP);
  // One rule that fits the budget alone, and a long note after it: the note is part of the text.
  const unread = [`/p/.claude/rules/${"z".repeat(1500)}.md`];
  const one = render("src/a.ts", [rule(1, 9000)], 10000, "en", unread).text;
  assert.ok(one.length <= CONTEXT_CAP, String(one.length));
  assert.ok(one.endsWith(`${unread[0]}`));
  // 6,000 two-byte letters are 12,000 bytes: past a 10,000-byte budget, so listed, not inlined.
  const tr = render("src/a.ts", [{ file: "/p/ğ.md", body: "ş".repeat(6000) }], 10000, "tr").text;
  assert.doesNotMatch(tr, /ş/);
  assert.match(tr, /- \/p\/ğ\.md/);
  // Through the hook: a rule that cannot be read, and a large one sized to fit only when the note is not counted.
  if (process.getuid?.() === 0) return tc.skip("root reads any file");
  const big = join(project, ".claude/rules/audit-big.md");
  const locked = join(project, `.claude/rules/audit-locked-${"n".repeat(180)}.md`);
  const relPath = "src/big/a.ts";
  const bytes = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");
  const header = t("sidecopy.header", { relPath }, "en");
  const reserve = bytes([t("sidecopy.tooLarge", { relPath }, "en"), `- ${big}`].join("\n")) + 2;
  const wrap = bytes(`<rule file="${big}">\n\n</rule>`);
  const body = "B".repeat(10000 - reserve - bytes(header) - 2 - wrap);
  assert.ok(bytes(t("sidecopy.unreadable", { relPath, list: locked }, "en")) > reserve, "the note is longer than the room kept for the list");
  put(big, `---\npaths:\n  - "src/big/**"\n---\n${body}\n`);
  put(locked, '---\npaths:\n  - "src/big/**"\n---\nL\n');
  const cfg = join(configs, "cap.json");
  writeFileSync(cfg, JSON.stringify({ sideCopy: { roots: [scratch], maxInjectBytes: 10000 } }));
  try {
    // A rule file that cannot be read: the note naming it comes after the large rule, inside the cap.
    chmodSync(locked, 0o000);
    const r = runHook(readInput("s-cap", join(worktree, relPath)), { CLAUDE_PROJECT_DIR: project, ENNYN_CONFIG: cfg });
    assert.equal(r.status, 0, r.stderr);
    const ctx = context(r);
    assert.ok(ctx.length <= CONTEXT_CAP, String(ctx.length));
    assert.match(ctx, /could not be read/);
  } finally {
    chmodSync(locked, 0o644);
    rmSync(big, { force: true });
    rmSync(locked, { force: true });
  }
});

// ------------------------------------------------------------- after review round one --

test("side-copy audit (review): a reset after compaction or /clear forgets the session's subagent lists too", () => {
  const file = join(worktree, "src/lib/engine/x.ts");
  const sub = { ...readInput("s-rst", file), agent_id: "a1" };
  assert.match(context(runHook(sub)), /ENGINE-RULE-BODY/);
  assert.equal(runHook(sub).stdout, "");
  const r = spawnSync(process.execPath, [resetPath], { input: JSON.stringify({ session_id: "s-rst", source: "compact", cwd: project }), env: hookEnv({ CLAUDE_PROJECT_DIR: project }), cwd: neutralCwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(runHook(sub)), /ENGINE-RULE-BODY/, "the subagent's list went with the session's");
});

test("side-copy audit (review): a budget above the cap still loads, is held to the cap, and doctor says so", async () => {
  const cfg = join(configs, "old-budget.json");
  writeFileSync(cfg, JSON.stringify({ sideCopy: { roots: [scratch], maxInjectBytes: 24000 } }));
  const r = runHook(readInput("s-old", join(worktree, "src/lib/engine/x.ts")), { CLAUDE_PROJECT_DIR: project, ENNYN_CONFIG: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /ENGINE-RULE-BODY/);
  const { checkSetup } = await import("../setup/doctor.mjs");
  const res = await checkSetup({ cwd: project, env: { ENNYN_CONFIG: cfg } });
  assert.ok(res.items.some((i) => i.level === "warn" && i.key === "doctor.injectAboveCap"), JSON.stringify(res.items.map((i) => i.key)));
});

test("side-copy audit (review): a rule named only in a count is not marked as given; a changed rule says it replaces its earlier text", async () => {
  const { render } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  const rules = Array.from({ length: 200 }, (_, i) => ({ file: `/p/.claude/rules/${"r".repeat(80)}${i}.md`, body: "x".repeat(200) }));
  const out = render("src/a.ts", rules, 9000, "en", []);
  assert.ok(out.text.length <= 10000);
  assert.match(out.text, /…and \d+ more rule files that apply here/);
  for (const r of rules) assert.equal(out.given.has(r.file), out.text.includes(r.file), r.file);
  assert.ok(out.given.size < rules.length);
  // Through the hook: an edited rule comes back marked as the new text of one given before.
  const rule = join(project, ".claude/rules/audit-changed.md");
  put(rule, '---\npaths:\n  - "src/changed/**"\n---\nCHANGED-V1\n');
  try {
    context(runHook(readInput("s-chg", join(worktree, "src/changed/a.ts"))));
    put(rule, '---\npaths:\n  - "src/changed/**"\n---\nCHANGED-V2\n');
    assert.match(context(runHook(readInput("s-chg", join(worktree, "src/changed/b.ts")))), /<rule file="[^"]*audit-changed\.md" changed="this text replaces the one given before">\nCHANGED-V2/);
  } finally {
    rmSync(rule, { force: true });
  }
});

test("side-copy audit (review): the note on rules that cannot be read is cut to the cap too", async () => {
  const { render, CONTEXT_CAP } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  const unreadable = Array.from({ length: 200 }, (_, i) => `/p/.claude/rules/${"u".repeat(80)}${i}.md`);
  for (const rules of [[{ file: "/p/r.md", body: "small" }], []]) {
    const out = render("src/a.ts", rules, 9000, "en", unreadable);
    assert.ok(out.text.length <= CONTEXT_CAP, String(out.text.length));
    assert.match(out.text, /could not be read.*…and \d+ more/s);
    assert.deepEqual([...out.given], rules.map((r) => r.file));
  }
});

test("side-copy audit (review): context ids that clean up alike still keep lists of their own", () => {
  const file = join(worktree, "src/lib/engine/x.ts");
  const give = (/** @type {Record<string, unknown>} */ extra) => runHook({ ...readInput("ignored", file), ...extra });
  const pairs = [
    [{ session_id: "s.agent-a1" }, { session_id: "s", agent_id: "a1" }],
    [{ session_id: ["x"] }, { session_id: "x" }],
    [{ session_id: undefined }, { session_id: "no-session" }],
    [{ session_id: "Case" }, { session_id: "case" }],
  ];
  for (const [a, b] of pairs) {
    assert.match(context(give(a)), /ENGINE-RULE-BODY/, JSON.stringify(a));
    assert.match(context(give(b)), /ENGINE-RULE-BODY/, `${JSON.stringify(b)} after ${JSON.stringify(a)}`);
  }
});

test("side-copy audit (review round two): a rule named like another's key, long ids, and long lists cut fast", async () => {
  // A rule file whose name holds "#" is not an earlier text of the rule its name starts with.
  const a = join(project, ".claude/rules/audit-k.md");
  const ab = join(project, ".claude/rules/audit-k.md#b.md");
  put(ab, '---\npaths:\n  - "src/k/**"\n---\nAB-BODY\n');
  try {
    assert.match(context(runHook(readInput("s-key", join(worktree, "src/k/1.ts")))), /AB-BODY/);
    put(a, '---\npaths:\n  - "src/k/**"\n---\nA-BODY\n');
    const next = context(runHook(readInput("s-key", join(worktree, "src/k/2.ts"))));
    assert.match(next, /A-BODY/);
    assert.doesNotMatch(next, /changed=/, "a rule never given is no changed rule");
    assert.equal(runHook(readInput("s-key", join(worktree, "src/k/3.ts"))).stdout, "", "both stay given");
  } finally {
    rmSync(a, { force: true });
    rmSync(ab, { force: true });
  }
  // Long session and agent ids: one list, a file name within 255 bytes.
  const { sideCopyStatePath, render, CONTEXT_CAP } = await import("../adapters/claude-code/hooks/side-copy-rules.mjs");
  const long = { ...readInput("s".repeat(150), join(worktree, "src/lib/engine/x.ts")), agent_id: "a".repeat(150) };
  assert.match(context(runHook(long)), /ENGINE-RULE-BODY/);
  assert.equal(runHook(long).stdout, "");
  assert.ok(Buffer.byteLength(basename(sideCopyStatePath(project, ".git/ennyn", "S".repeat(500), "A".repeat(500)))) <= 255);
  // Thousands of rules and unreadable files: cut to the cap without rebuilding the text for every one dropped.
  const t0 = Date.now();
  const many = Array.from({ length: 6000 }, (_, i) => ({ file: `/p/.claude/rules/${"r".repeat(60)}${i}.md`, body: "x" }));
  const out = render("src/a.ts", many, 9000, "en", many.map((r) => `${r.file}.locked`));
  assert.ok(out.text.length <= CONTEXT_CAP);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});
