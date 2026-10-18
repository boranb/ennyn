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
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { mapSideCopyPath } from "../side-copy/map-path.mjs";
import {
  loadPathScopedRules,
  parsePaths,
  readRuleBody,
  rulesForPath,
  splitFrontMatter,
} from "../adapters/claude-code/rules-index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");
const hookPath = join(pluginRoot, "adapters/claude-code/hooks/side-copy-rules.mjs");

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
    if (k === "CLAUDE_PROJECT_DIR" || k === "ENNYN_CONFIG" || k.startsWith("GIT_")) delete env[k];
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

test("map-path: bad input and unreadable files never throw", () => {
  assert.equal(mapSideCopyPath("relative/x.ts", { projectDir: project, roots: [scratch] }), null);
  assert.equal(mapSideCopyPath(join(copy, "x.ts"), { projectDir: join(tmpdir(), "pl-sc-missing-xyz"), roots: [scratch] }), null);
  assert.equal(
    mapSideCopyPath(join(copy, "src/x.ts"), { projectDir: project, roots: [/** @type {any} */ (42), "", scratch] })?.relPath,
    "src/x.ts",
  );
  const locked = join(scratch, "locked");
  cpSync(project, locked, { recursive: true, filter: (src) => basename(src) !== ".git" });
  chmodSync(join(locked, "package.json"), 0o000);
  try {
    assert.equal(mapSideCopyPath(join(locked, "src/lib/engine/x.ts"), { projectDir: project, roots: [locked] }), null);
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
  assert.ok(existsSync(join(project, ".git/ennyn/side-copy/.._.._.._escape.json")));
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
  const budget = bytes(parts[0]) + 2 + bytes(parts[1]) + 1;
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

test("hooks.json: PostToolUse matcher and a quoted command that resolves to the hook", () => {
  const spec = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"));
  assert.ok(spec.hooks && typeof spec.hooks === "object");
  const [entry] = spec.hooks.PostToolUse;
  assert.equal(entry.matcher, "Read|Edit|Write|MultiEdit|NotebookEdit");
  const [cmd] = entry.hooks;
  assert.equal(cmd.type, "command");
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(cmd.command);
  assert.ok(m, `command must quote \${CLAUDE_PLUGIN_ROOT}: ${cmd.command}`);
  assert.equal(join(pluginRoot, m[1]), hookPath);
  assert.ok(readFileSync(hookPath, "utf8").startsWith("#!/usr/bin/env node\n"));
  // Every tool the matcher sends is one the hook handles.
  for (const tool of entry.matcher.split("|")) {
    const r = runHook(readInput(`s-matcher-${tool}`, join(worktree, "src/lib/engine/x.ts"), tool));
    assert.ok(context(r).includes("ENGINE-RULE-BODY"), tool);
  }
});

test("hook (i): every exit code observed is 0 or 1, never 2", () => {
  assert.ok(exitCodes.length >= 20, `only ${exitCodes.length} hook runs observed`);
  assert.ok(exitCodes.includes(0) && exitCodes.includes(1));
  for (const code of exitCodes) assert.ok(code === 0 || code === 1, `exit code ${code}`);
});
