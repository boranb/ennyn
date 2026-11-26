/**
 * Does the push hook (adapters/claude-code/hooks/push-spellings.mjs) let a push run by itself only where the push runs
 * in the session project's own checkout? Its own tests (test/push-spellings.test.mjs) hold each verdict as a hand-written
 * answer; the class this file is for, a verdict that stands for a fact and parts from it on some input
 * (`stand-in-for-the-fact`), stands behind the hook's reading of where the push runs: the input's `cwd` and
 * CLAUDE_PROJECT_DIR, compared by checks/push-mode.mjs. Here the fact is read from a real shell and git alone, never
 * from the hook's code nor core/git.mjs: the text before the push and the push's own git options run in bash from the
 * input's `cwd` (`pwd -P`, then `git <options> rev-parse` of the top, the common git dir and the git dir), and the same
 * is read in the session's folder. Only the corpus's own `cd`, `pushd` and `-C` words run, never a push.
 *
 * Every repository here is one where push-check's other facts hold (push.mode after-closing with the approval line, a
 * branch with an upstream of one url, nothing widened, a commit to send and a green run recorded on its tree), so where the push runs is the one fact that moves (the folder,
 * or a git variable in the session's environment); test/push-check-oracle holds the rest. "Goes" is: the push runs,
 * in a folder whose top, common git dir and git dir are the session's. "Run" is what Claude Code does with the hook's
 * answer, not its shape: a crash or a message alone runs the call too. The test fails where the hook lets a push run
 * that does not go, and where it asks or refuses one that goes, unless the corpus names that parting, either way: as
 * the design's, with why (skills/cycle/push.md step 4: only a bare `git push`, in a call of its own, runs by itself),
 * or as a gap, with the node that would close it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordRun } from "../plugin/checks/test-runs.mjs";
import { DEFAULTS } from "../plugin/core/config.mjs";
import { ownHome } from "./own-home.mjs";

const HOOK = fileURLToPath(new URL("../plugin/adapters/claude-code/hooks/push-spellings.mjs", import.meta.url));
/** The push hook's time limit in seconds, from its own entry in the plugin's hooks.json: past it Claude Code runs the call. */
const LIMIT_S = (() => {
  /** @type {{ hooks: Record<string, { hooks: { command: string, timeout?: number }[] }[]> }} */
  const wiring = JSON.parse(readFileSync(new URL("../plugin/hooks/hooks.json", import.meta.url), "utf8"));
  const entry = Object.values(wiring.hooks).flat().flatMap((m) => m.hooks).find((h) => h.command.includes("/push-spellings.mjs"));
  if (typeof entry?.timeout !== "number") throw new Error("hooks.json gives the push hook no timeout");
  return entry.timeout;
})();
/** Claude Code reads the entry's timeout in seconds (`e.timeout*1000` in the CLI 2.1.310 binary). */
const LIMIT_MS = LIMIT_S * 1000;
const { root: ROOT } = ownHome("en-push-folder-");
const DIR = realpathSync(ROOT);
const CLAUDE = join(DIR, "claude-config");
mkdirSync(CLAUDE);

/** An identity of its own (a container derives none), no maintenance racing a reading. */
const SET = ["user.name=t", "user.email=t@t", "commit.gpgsign=false", "gc.auto=0", "maintenance.auto=false"].flatMap((kv) => ["-c", kv]);
/** @param {string} cwd @param {string[]} args */
function g(cwd, args) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A checkout where push-check's facts hold: after-closing, approved, pushed to a bare upstream, one commit ahead, recorded green. @param {string} dir */
function repo(dir) {
  const bare = `${dir}.git`;
  g(DIR, ["init", "-q", "--bare", "-b", "main", bare]);
  g(DIR, ["init", "-q", "-b", "main", dir]);
  mkdirSync(join(dir, ".ennyn")), mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ push: { mode: "after-closing" } }));
  writeFileSync(join(dir, "sub", "s.txt"), "s\n");
  g(dir, ["add", "-A"]), g(dir, ["commit", "-q", "-m", "chore: push by itself\n\nUser-Approved-Loosening: push.mode"]);
  g(dir, ["remote", "add", "origin", bare]), g(dir, ["push", "-q", "-u", "origin", "main"]);
  writeFileSync(join(dir, "a.txt"), "1\n"), g(dir, ["add", "a.txt"]), g(dir, ["commit", "-q", "-m", "chore: two"]);
  return recorded(dir);
}

/** A green whole run recorded on the checkout's HEAD tree, as `ennyn test whole` writes one. @param {string} dir */
function recorded(dir) {
  const now = new Date().toISOString();
  recordRun(dir, DEFAULTS, { v: 1, kind: "whole", tree: g(dir, ["rev-parse", "HEAD^{tree}"]), head: g(dir, ["rev-parse", "HEAD"]), exit: 0, start: now, end: now });
  return dir;
}

const P = repo(join(DIR, "project"));
const N = repo(join(P, "nested"));
writeFileSync(join(P, ".git", "info", "exclude"), "nested/\nnested.git/\n");
const W = join(DIR, "linked");
g(P, ["worktree", "add", "-q", "-b", "side", W]), g(W, ["push", "-q", "-u", "origin", "side"]);
writeFileSync(join(W, "w.txt"), "w\n"), g(W, ["add", "w.txt"]), g(W, ["commit", "-q", "-m", "chore: side"]), recorded(W);
const O = repo(join(DIR, "other"));
const Q = repo(join(DIR, "two words"));
const PLAIN = join(DIR, "plain");
mkdirSync(PLAIN);
const LINK = join(DIR, "link-to-project");
symlinkSync(P, LINK);

/**
 * @typedef {{ name: string, session: string, shell: string, pre?: string, join?: string, opts?: string, oldpwd?: string, env?: Record<string, string>, known?: string }} Case
 * The command is `<pre><join>git <opts>push` (join ` && ` by default); `oldpwd`: where the shell stood before the
 * input's `cwd`; `env`: what the session's settings put in the environment of the shell and the hook alike (the
 * session's checkout is read without it: it is the folder whose config decides); `known`: why the hook parts from the
 * facts there, the design's, or the node that would close it.
 */
const BARE = "only a bare git push, in a call of its own, runs by itself (push.md step 4)";
const QUOTE = "a quote makes the reader refuse the push (push-spellings.mjs)";
const OPTION = "the reader leaves a push only as `git push`, nothing between the two words (push-spellings.mjs)";
/** @type {Case[]} */
const CASES = [
  { name: "the shell at the top", session: P, shell: P },
  { name: "the shell in a subfolder", session: P, shell: join(P, "sub") },
  { name: "the shell in a nested repository", session: P, shell: N },
  { name: "the shell in a linked worktree", session: P, shell: W },
  { name: "the shell in another repository", session: P, shell: O },
  { name: "the shell in a folder of no repository", session: P, shell: PLAIN },
  { name: "the shell's folder removed", session: P, shell: join(DIR, "gone") },
  { name: "the shell in the git dir", session: P, shell: join(P, ".git") },
  { name: "the shell at the top through a link", session: P, shell: LINK },
  { name: "the session in a subfolder, the shell at the top", session: join(P, "sub"), shell: P },
  { name: "the session in the linked worktree, the shell there", session: W, shell: W },
  { name: "the session in the linked worktree, the shell in the main checkout", session: W, shell: P },
  { name: "the session in the nested repository, the shell in the outer one", session: N, shell: P },
  { name: "the session and the shell in a folder with a space", session: Q, shell: Q },
  { name: "cd into a nested repository", session: P, shell: P, pre: "cd nested" },
  { name: "cd into a linked worktree", session: P, shell: P, pre: `cd ${W}` },
  { name: "cd into a subfolder", session: P, shell: P, pre: "cd sub", known: BARE },
  { name: "a cd that fails, then &&", session: P, shell: P, pre: "cd nowhere" },
  { name: "a cd that fails, then ;", session: P, shell: P, pre: "cd nowhere", join: "; ", known: BARE },
  { name: "cd - back into a nested repository", session: P, shell: P, pre: "cd -", oldpwd: N },
  { name: "cd - back to the top", session: P, shell: join(P, "sub"), pre: "cd -", oldpwd: P, known: BARE },
  { name: "cd .. out of the repository", session: P, shell: P, pre: "cd .." },
  { name: "cd .. from a subfolder to the top", session: P, shell: join(P, "sub"), pre: "cd ..", known: BARE },
  { name: "pushd into a nested repository", session: P, shell: P, pre: "pushd nested" },
  { name: "pushd to the top", session: P, shell: join(P, "sub"), pre: `pushd ${P}`, known: BARE },
  { name: "git -C a nested repository", session: P, shell: P, opts: "-C nested " },
  { name: "git -C the top from a subfolder", session: P, shell: join(P, "sub"), opts: "-C .. ", known: OPTION },
  { name: "cd into a folder with a space, quoted", session: Q, shell: DIR, pre: "cd 'two words'", known: QUOTE },
  {
    name: "GIT_DIR in the session's environment names another repository",
    session: P,
    shell: P,
    env: { GIT_DIR: join(O, ".git") },
    known: "node push-mode-git-dir-env: the push honours GIT_DIR and the decision does not",
  },
];

/** No startup file, no CDPATH: the facts of the words alone. */
const SHELL_ENV = { ...process.env, BASH_ENV: undefined, ENV: undefined, CDPATH: undefined, OLDPWD: undefined, GIT_TERMINAL_PROMPT: "0" };

/**
 * Where a push run as `<pre><join>git <opts>push` from `shell` would run: null when it does not run (the shell cannot
 * start there, or the text before it fails under &&); `top` null when git finds no work tree there.
 * @param {string} shell @param {Case} c
 */
function where(shell, c) {
  const read = `{ pwd -P; git ${c.opts ?? ""}rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir 2>/dev/null; }`;
  // bash clears an OLDPWD it is handed (3.2, measured): an earlier cd in the same shell sets it, outside the command.
  const before = c.oldpwd ? `cd '${c.oldpwd}' && cd '${shell}' && ` : "";
  const text = before + (c.pre ? `${c.pre} >/dev/null${c.join ?? " && "}${read}` : read);
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", text], { cwd: shell, encoding: "utf8", env: { ...SHELL_ENV, ...c.env }, timeout: 30_000, killSignal: "SIGKILL" });
  if (r.error) return null;
  const [pwd, top, common, gitDir] = r.stdout.split("\n");
  if (!pwd) return null;
  return { pwd, top: top || null, common: common || null, gitDir: gitDir || null };
}

/**
 * The hook's verdict as Claude Code acts on it (test/reference/pretooluse.json, CLI 2.1.310): `deny` for exit 2 or a
 * printed deny (it holds over exit 1), `ask` for a printed ask at exit 0, and `run` for anything else: no output, a
 * message alone, output that is no decision, another exit, a crash, a kill, or no answer within LIMIT_MS all run it.
 * @param {string} hook @param {Case} c @param {string} command
 */
function verdict(hook, c, command) {
  const input = { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" }, cwd: c.shell };
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: c.session, CLAUDE_CONFIG_DIR: CLAUDE, ...c.env }, cwd: DIR, encoding: "utf8", timeout: LIMIT_MS, killSignal: "SIGKILL" });
  if (r.status === 2) return "deny";
  let decision;
  try {
    decision = JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision;
  } catch {
    decision = undefined;
  }
  if (decision === "deny") return "deny";
  return decision === "ask" && r.status === 0 ? "ask" : "run";
}

/** Each case's command and facts, read once. */
const FACTS = CASES.map((c) => {
  const command = `${c.pre ? `${c.pre}${c.join ?? " && "}` : ""}git ${c.opts ?? ""}push`;
  const at = where(c.shell, c);
  const own = where(c.session, { name: "", session: "", shell: "" });
  const goes = at !== null && at.top !== null && own !== null && at.top === own.top && at.common === own.common && at.gitDir === own.gitDir;
  return { c, command, at, own, goes };
});

/** Where `hook`'s verdicts part from the facts, less the known partings, and a row a case. @param {string} hook */
function judge(hook) {
  const rows = [];
  const parted = [];
  const verdicts = [];
  for (const { c, command, at, own, goes } of FACTS) {
    const v = verdict(hook, c, command);
    verdicts.push(v);
    rows.push(`${c.name}: ${command} -> ${v}; facts ${JSON.stringify({ at, own, goes })}`);
    const out = [];
    if (v === "run" && !goes) out.push("lets a push run that does not run in the session's checkout");
    if (v !== "run" && goes) out.push(`${v} where the push runs in the session's checkout`);
    if (out.length === 1 && c.known !== undefined) continue;
    for (const o of out) parted.push(`${c.name}: ${o}`);
    if (c.known !== undefined && out.length === 0) parted.push(`${c.name}: the known parting (${c.known}) is gone: take it out of the corpus`);
  }
  return { rows, parted, verdicts };
}

test("push hook folder oracle: a push runs by itself only where it runs in the session's own checkout, and is asked nowhere else the facts allow", (t) => {
  const { rows, parted } = judge(HOOK);
  // Each row a diagnostic, and no long message on the assertion (test/push-check-oracle.test.mjs says why).
  for (const r of rows) t.diagnostic(r);
  assert.deepEqual(parted, []);
});

test("push hook folder oracle: the judge finds a hook that lets every push run, and one that asks every push", () => {
  const stub = (/** @type {string} */ name, /** @type {string} */ out) => {
    const file = join(DIR, name);
    writeFileSync(file, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(out)}));\n`);
    return file;
  };
  const runs = judge(stub("runs.mjs", "")).parted;
  const asks = judge(stub("asks.mjs", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }))).parted;
  const stay = FACTS.filter((f) => !f.goes && f.c.known === undefined).map((f) => `${f.c.name}: lets a push run that does not run in the session's checkout`);
  const go = FACTS.filter((f) => f.goes && f.c.known === undefined).map((f) => `${f.c.name}: ask where the push runs in the session's checkout`);
  // The corpus holds both kinds, and the judge names every case of each.
  assert.ok(stay.length >= 10 && go.length >= 5, `${stay.length} stay, ${go.length} go`);
  for (const s of stay) assert.ok(runs.includes(s), s);
  for (const s of go) assert.ok(asks.includes(s), s);
});

test("push hook folder oracle: the judge finds a hook that crashes, prints only a message, or answers past its limit, where the real one asks", () => {
  // Claude Code runs the call past both (test/reference/pretooluse.json): each is a push let run.
  const wrap = (/** @type {string} */ name, /** @type {string} */ instead) => {
    const file = join(DIR, name);
    const real = `require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(HOOK)}], { input: require("node:fs").readFileSync(0), encoding: "utf8" })`;
    writeFileSync(file, `const r = ${real};\nif (r.stdout.includes('"ask"')) { ${instead} } else process.stdout.write(r.stdout);\n`);
    return file;
  };
  const asked = judge(HOOK).verdicts.flatMap((v, i) => (v === "ask" && !FACTS[i].goes ? [`${FACTS[i].c.name}: lets a push run that does not run in the session's checkout`] : []));
  assert.ok(asked.length >= 10, `${asked.length} asked`);
  for (const [name, instead] of [
    ["crashes.cjs", 'throw new Error("crash");'],
    ["says.cjs", 'process.stdout.write(JSON.stringify({ systemMessage: "unread" }));'],
  ]) {
    const parted = judge(wrap(name, instead)).parted;
    for (const s of asked) assert.ok(parted.includes(s), `${name}: ${s}`);
  }
  // An ask that comes past the host's limit: Claude Code has run the call. Once, for one case, just past the limit.
  const late = join(DIR, "late.cjs");
  writeFileSync(late, `const input = require("node:fs").readFileSync(0);
const r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(HOOK)}], { input, encoding: "utf8" });
if (JSON.parse(input.toString()).cwd === ${JSON.stringify(O)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${(LIMIT_S + 1) * 1000});
process.stdout.write(r.stdout);
`);
  const other = "the shell in another repository: lets a push run that does not run in the session's checkout";
  assert.ok(asked.includes(other), other);
  assert.ok(judge(late).parted.includes(other), `late.cjs: ${other}`);
});
