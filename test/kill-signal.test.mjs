import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, git, waitGone } from "../core/git.mjs";
import { REFERENCE_GRACE_MS } from "../impact/table.mjs";
import { limitProblems } from "./kill-signal.mjs";
import { lexInChild } from "./reference/markdown.mjs";
import { fenceName, inFence, shellBox } from "./shell-box.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The calls the reader cannot read whole and that need no kill signal, each by its file, a text on its line, how many
 * calls it excuses, and why. An entry that excuses another number of calls fails the test: one left stale, and one
 * that would excuse a new call written alike.
 * @type {{ file: string, text: string, count: number, why: string }[]}
 */
const ALLOWED = [
  { file: "test/hermetic.mjs", text: "(childProcess);", count: 1, why: "wraps child_process's functions for every test file: it passes the caller's options through and adds no limit" },
  { file: "test/reads.mjs", text: "(childProcess);", count: 1, why: "wraps child_process's functions to record what a test reads: it passes the caller's options through and adds no limit" },
  { file: "test/mutation.test.mjs", text: "(childProcess);", count: 4, why: "replaces a child_process function with a stand-in for one test, and puts it back; it starts no process with a limit" },
  { file: "test/hermetic.test.mjs", text: "(spawnSync, probe)", count: 2, why: "hands spawnSync to a function the test builds, to check which file a call comes from; no limit" },
  { file: "test/hook-oracle.test.mjs", text: "watched(seconds, command), { ...opts,", count: 1, why: "its options are a cwd and an environment (the parameter's type); the limit is the watching shell's own, a SIGKILL to the group" },
  { file: "test/linux-run.mjs", text: 'spawnSync("docker", args,', count: 1, why: "its options are an input and a cwd (the parameter's type); docker gets no time limit here" },
  { file: "test/fault-fs.mjs", text: "} = cp;", count: 1, why: "takes child_process's functions to wrap them for a fault: it passes the caller's options through and adds no limit" },
  { file: "test/fault-fs.mjs", text: "(cp);", count: 1, why: "replaces child_process's functions with the wrappers that fail one call; no limit of its own" },
  { file: "test/eval/selftest.mjs", text: "runEval(spawnRun,", count: 3, why: "hands spawn to runEval, whose call has no timeout option: its own timer kills the run's process tree with SIGKILL" },
  { file: "test/reference/npm.mjs", text: "    req,", count: 1, why: "hands on a createRequire loader rooted in npm's own folder, to load npm's modules (arborist, pacote); nothing loads child_process through it" },
  { file: "test/reference/pretooluse.mjs", text: 'execFileSync("git", [...quiet,', count: 4, why: "the options are a cwd and an environment (`at`, a name the file declares twice, so the reader does not resolve it); no limit" },
];

/**
 * The problems of a file the allow list does not cover: an entry covers an `unreadable` call on a line holding its
 * text, never a call with a limit and no kill signal. Each call an entry covers is counted in `used`.
 * @param {string} file @param {string} text @param {import("./kill-signal.mjs").Problem[]} problems
 * @param {typeof ALLOWED} allowed @param {Map<number, number>} used @returns {string[]}
 */
function unallowed(file, text, problems, allowed, used) {
  const lines = text.split("\n");
  const out = [];
  for (const p of problems) {
    const at = allowed.findIndex((a) => a.file === file && lines[p.line - 1].includes(a.text));
    if (p.verdict === "unreadable" && at >= 0) used.set(at, (used.get(at) ?? 0) + 1);
    else out.push(`${file}:${p.line}: ${p.verdict}: ${p.why}`);
  }
  return out;
}

/**
 * The entries that excused another number of calls than they pin: none is stale, and none excuses a call written
 * alike later. @param {typeof ALLOWED} allowed @param {Map<number, number>} used
 */
const stale = (allowed, used) => allowed.flatMap((a, k) => ((used.get(k) ?? 0) === a.count ? [] : [`${a.file}: ${a.text}: excuses ${used.get(k) ?? 0}, pins ${a.count}`]));

/** The tracked and new JavaScript files of the tree. */
const sources = () =>
  git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
    .split("\0")
    .filter((f) => /\.(mjs|cjs|js)$/.test(f));

const IMPORT = 'import { spawn, spawnSync, execFile, execFileSync, execSync, exec, fork } from "node:child_process";\n';

/** Calls that need no change: a limit with its kill signal, no limit, or no call of node's at all. */
const ACCEPT = {
  "limit and kill signal": 'spawnSync("git", ["x"], { timeout: 5, killSignal: "SIGKILL" });',
  "no limit": 'spawnSync("git", ["x"], { encoding: "utf8" });',
  "no options": 'spawnSync("git", ["x"]);',
  "no arguments past the program": 'spawnSync("git");',
  "a spread before both": 'execFileSync("git", args, { ...opts, timeout: limit, killSignal: "SIGKILL" });',
  "a spread after a named kill signal": 'execFileSync("git", args, { timeout: limit, killSignal: "SIGKILL", ...opts });',
  "options held in a constant": 'const O = { timeout: 1, killSignal: "SIGKILL" };\nspawnSync("a", [], O);',
  "a constant spread with the kill signal beside it": 'const L = { timeout: 1 };\nspawnSync("a", [], { ...L, killSignal: "SIGKILL" });',
  "a constant spread with neither": 'const L = { encoding: "utf8" };\nspawnSync("a", [], { ...L });',
  "an argument list held in a constant": 'const A = ["x"];\nspawnSync("a", A);',
  "an argument list built by a call, two arguments": 'spawnSync("a", ["-c", x].concat(y));',
  "a regular expression's exec": 'const m = /x/.exec(s);\nm.exec(t);',
  "a call in a comment": '// spawnSync("a", [], { timeout: 1 })\n/* execSync("x", { timeout: 1 }) */',
  "a call in a string": 'const s = \'spawnSync("a", [], { timeout: 1 })\';\nconst d = "execSync(\\"x\\", { timeout: 1 })";\nconst t = `spawn("a", [], { timeout: 1 })`;',
  "a namespace call with both": 'import * as cp from "node:child_process";\ncp.spawnSync("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "execSync with both": 'execSync("ls", { timeout: 1, killSignal: "SIGKILL" });',
  "a function of the same name not imported from node": 'function spawnSync(a, b, c) {}\nspawnSync("a", [], { timeout: 1 });',
  "a division beside a call": 'const half = n / 2;\nspawnSync("a", [], { timeout: n / 2, killSignal: "SIGKILL" });',
  "a regular expression holding a quote and a slash": 'const re = /["/]/g;\nspawnSync("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "a template with a call inside, with both": 'const t = `${spawnSync("a", [], { timeout: 1, killSignal: "SIGKILL" }).stdout}`;',
  "a property named like a call": 'const o = { spawnSync: 1 };\no.spawnSync("a", [], { timeout: 1 });',
  "a require with both": 'const { spawnSync: run } = require("node:child_process");\nrun("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "an alias called with both": 'const run = spawnSync;\nrun("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "a default alias with no limit": 'function f(run = spawnSync) { return run("a", []); }',
  "a promisified alias with both": 'const run = promisify(execFile);\nawait run("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "exec with a callback only": 'exec("x", (e, out) => use(out));\nexecFile("x", ["y"], function (e) {});',
  "an abort signal with a kill signal": 'spawn("a", [], { signal: AbortSignal.timeout(1000), killSignal: "SIGKILL" });',
  "a kill signal held in a constant": 'const SIG = "SIGKILL";\nspawnSync("a", [], { timeout: 1, killSignal: SIG });',
  "a shorthand kill signal from a constant": 'const killSignal = "SIGKILL";\nspawnSync("a", [], { timeout: 1, killSignal });',
  "a createRequire loader with both": 'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst { spawnSync: run } = req("node:child_process");\nrun("a", [], { timeout: 1, killSignal: "SIGKILL" });',
  "require's own properties and a loader for another module": 'const p = require.resolve("x");\nconst fs = require("node:fs");',
  "the module's name as a plain string": 'const M = new Set(["child_process", "node:child_process"]);\nif (M.has("child_process")) use("child_process");',
  "a cast constant with both": 'const O = { timeout: 1, killSignal: "SIGKILL" };\nspawnSync("a", [], /** @type {any} */ (O));',
};

/** Calls the gate refuses: a limit with no kill signal, or options it cannot read whole. */
const REJECT = {
  "limit, no kill signal": ['spawnSync("git", ["x"], { timeout: 5 });', ["no-kill-signal"]],
  "a shorthand limit": ['execFileSync("git", args, { encoding: "utf8", timeout });', ["no-kill-signal"]],
  "a quoted key": ['spawnSync("a", [], { "timeout": 1 });', ["no-kill-signal"]],
  "an async spawn": ['spawn("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "execSync": ['execSync("x", { timeout: 1 });', ["no-kill-signal"]],
  "exec with a callback": ['exec("x", { timeout: 1 }, () => {});', ["no-kill-signal"]],
  "execFile with a callback": ['execFile("x", ["y"], { timeout: 1 }, () => {});', ["no-kill-signal"]],
  "fork": ['fork("m.mjs", [], { timeout: 1 });', ["no-kill-signal"]],
  "a constant spread that brings the limit": ['const L = { timeout: 1 };\nspawnSync("a", [], { ...L });', ["no-kill-signal"]],
  "options held in a constant": ['const O = { timeout: 1 };\nspawnSync("a", [], O);', ["no-kill-signal"]],
  "a spread of something unread": ['spawnSync("a", [], { ...opts });', ["unreadable"]],
  "a spread beside a limit": ['spawnSync("a", [], { timeout: 1, ...extra });', ["no-kill-signal"]],
  "options in a parameter": ['function f(opts) { return spawnSync("a", [], opts); }', ["unreadable"]],
  "two arguments, the second unread": ['function f(more) { return spawnSync("a", more); }', ["unreadable"]],
  "a computed key": ['spawnSync("a", [], { [k]: 1 });', ["unreadable"]],
  "options built by a call": ['spawnSync("a", [], make());', ["unreadable"]],
  "a constant declared twice": ['const O = { encoding: "utf8" };\n{ const O = { timeout: 1 }; spawnSync("a", [], O); }', ["unreadable"]],
  "a renamed import": ['import { spawnSync as s } from "node:child_process";\ns("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a namespace import": ['import * as cp from "node:child_process";\ncp.execSync("x", { timeout: 1 });', ["no-kill-signal"]],
  "a default import": ['import cp from "child_process";\ncp.spawnSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "a dynamic import": ['const { spawnSync } = await import("node:child_process");\nspawnSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "a require": ['const { execFileSync } = require("child_process");\nexecFileSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "an alias": ['const run = spawnSync;\nrun("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a default alias": ['function f(run = spawnSync) { return run("a", [], { timeout: 1 }); }', ["no-kill-signal"]],
  "a destructured default alias": ['function f({ spawnRun = spawn } = {}) { return spawnRun("a", [], { timeout: 1 }); }', ["no-kill-signal"]],
  "a promisified alias": ['const run = promisify(execFile);\nawait run("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a promisified call": ['await promisify(execFile)("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a cast constant": ['const O = { timeout: 1 };\nspawnSync("a", [], /** @type {any} */ (O));', ["no-kill-signal"]],
  "the function passed to a call": ['use(spawnSync);', ["unreadable"]],
  "an alias passed on": ['const run = spawnSync;\nuse(run);', ["unreadable"]],
  "a namespace's function as an alias": ['import * as cp from "node:child_process";\nconst run = cp.execFileSync;\nrun("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a default destructured from a dynamic import": ['const { default: cp } = await import("node:child_process");\ncp.spawnSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "the namespace itself as a value": ['import * as cp from "node:child_process";\nuse(cp);', ["unreadable"]],
  "a dynamic import not destructured": ['const cp = await import("node:child_process");\ncp.spawnSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "a dynamic import read some other way": ['use(await import("node:child_process"));', ["unreadable"]],
  "a template with a call inside": ['const t = `${spawnSync("a", [], { timeout: 1 }).stdout}`;', ["no-kill-signal"]],
  "a kill signal named undefined": ['spawnSync("a", [], { timeout: 1, killSignal: undefined });', ["no-kill-signal"]],
  "the function stored in a property": ['holder.run = spawnSync;\nuse(1);', ["unreadable"]],
  "an import by a string name": ['import { "spawnSync" as run } from "node:child_process";\nrun("a", [], { timeout: 1 });', ["unreadable"]],
  "options in a let": ['let O = { encoding: "utf8" };\nO = { timeout: 1 };\nspawnSync("a", [], O);', ["unreadable"]],
  "a constant whose value goes on past its literal": ['const O = { encoding: "utf8" } && more;\nspawnSync("a", [], O);', ["unreadable"]],
  "a division after an index, then a call on the line": ['const r = a[0] / 2; spawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "an abort signal": ['spawn("a", [], { signal: AbortSignal.timeout(1000) });', ["no-kill-signal"]],
  "a kill signal read from a parameter's field": ['function f(o) { return spawnSync("a", [], { timeout: 1, killSignal: o.killSignal }); }', ["unreadable"]],
  "a shorthand kill signal from a parameter": ['function f(killSignal) { return spawnSync("a", [], { timeout: 1, killSignal }); }', ["unreadable"]],
  "a kill signal in a let": ['let SIG = "SIGKILL";\nspawnSync("a", [], { timeout: 1, killSignal: SIG });', ["unreadable"]],
  "a kill signal that is not a string": ['spawnSync("a", [], { timeout: 1, killSignal: 9 });', ["unreadable"]],
  "a createRequire loader": ['import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst { spawnSync } = req("node:child_process");\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "createRequire called inline": ['import module from "node:module";\nconst cp = module.createRequire(import.meta.url)("node:child_process");\ncp.execSync("x", { timeout: 1 });', ["no-kill-signal"]],
  "getBuiltinModule": ['const { execFileSync } = process.getBuiltinModule("node:child_process");\nexecFileSync("x", [], { timeout: 1 });', ["no-kill-signal"]],
  "a call of another call's result": ['const cp = load()("node:child_process");\ncp.execSync("x", { timeout: 1 });', ["unreadable"]],
  "a loader's result passed on": ['import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nuse(req("node:child_process"));', ["unreadable"]],
  "getBuiltinModule as an optional call": ['const { spawnSync } = process.getBuiltinModule?.("node:child_process");\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "getBuiltinModule through an optional member": ['const { spawnSync } = process?.getBuiltinModule("node:child_process");\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "require called optionally": ['const { spawnSync } = require?.("node:child_process");\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "require renamed": ['const r = require;\nconst { spawnSync } = r("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "getBuiltinModule renamed": ['const g = process.getBuiltinModule;\nconst { spawnSync } = g("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "a loader renamed": ['import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst load = req;\nconst { spawnSync } = load("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "a loader in an object": ['import { createRequire } from "node:module";\nconst m = { req: createRequire(import.meta.url) };\nconst { spawnSync } = m.req("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "createRequire renamed on import": ['import { createRequire as cr } from "node:module";\nconst req = cr(import.meta.url);\nconst { spawnSync } = req("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "createRequire renamed": ['import { createRequire } from "node:module";\nconst cr = createRequire;\nconst req = cr(import.meta.url);\nconst { spawnSync } = req("child_process");\nspawnSync("a", [], { timeout: 1 });', ["unreadable"]],
  "a loader assigned later": ['import { createRequire } from "node:module";\nlet req;\nreq = createRequire(import.meta.url);\nconst { spawnSync } = req("child_process");\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal"]],
  "a call the reader cannot close": ['spawnSync("a", [], { timeout: 1 ', ["unreadable"]],
  "two calls, the second line": ['spawnSync("a", [], { timeout: 1, killSignal: "SIGKILL" });\nspawnSync("a", [], { timeout: 1 });', ["no-kill-signal@2"]],
};

/** @param {string} source */
const verdicts = (source) => limitProblems(source).map((p) => p.verdict);

test("kill signal: the reader passes every call of the accept corpus", () => {
  for (const [name, body] of Object.entries(ACCEPT)) {
    const source = body.includes("child_process") || body.startsWith("function spawnSync") ? body : IMPORT + body;
    assert.deepEqual(limitProblems(source), [], name);
  }
});

test("kill signal: the reader refuses every call of the reject corpus, each at its line", () => {
  for (const [name, [body, want]] of Object.entries(REJECT)) {
    const own = body.includes("child_process");
    const source = own ? body : IMPORT + body;
    const shift = own ? 0 : 1;
    const got = limitProblems(source);
    const expected = want.map((w) => w.split("@")[0]);
    assert.deepEqual(got.map((p) => p.verdict), expected, name);
    for (const [i, w] of want.entries()) if (w.includes("@")) assert.equal(got[i].line, Number(w.split("@")[1]) + shift, `${name}: line`);
  }
});

test("kill signal: the allow list covers an unreadable call on its line only, never a limit with no kill signal, and says an entry that excuses another number than it pins", () => {
  const allowed = [{ file: "a.mjs", text: "const run =", count: 1, why: "x" }, { file: "a.mjs", text: "gone", count: 1, why: "x" }, { file: "a.mjs", text: "const go", count: 1, why: "x" }];
  const text = 'import { spawnSync } from "node:child_process";\nconst run = (o) => spawnSync("a", [], o);\nspawnSync("a", [], { timeout: 1 });\nconst go = (o) => spawnSync("b", [], o);\nconst go2 = (o) => spawnSync("c", [], o);\n';
  /** @type {Map<number, number>} */
  const used = new Map();
  const left = unallowed("a.mjs", text, limitProblems(text), allowed, used);
  assert.deepEqual(left, ["a.mjs:3: no-kill-signal: spawnSync has a time limit and no killSignal"]);
  assert.deepEqual([...used], [[0, 1], [2, 2]]);
  assert.deepEqual(stale(allowed, used), ["a.mjs: gone: excuses 0, pins 1", "a.mjs: const go: excuses 2, pins 1"]);
  // A limit with no kill signal on an allowed line is still refused.
  const limited = 'import { spawnSync } from "node:child_process";\nspawnSync("const run =", [], { timeout: 1 });\n';
  assert.equal(unallowed("a.mjs", limited, limitProblems(limited), allowed, new Map()).length, 1);
  // Another file's entry covers nothing here.
  assert.equal(unallowed("b.mjs", text, limitProblems(text), allowed, new Map()).length, 4);
});

test("kill signal: every call in the tree with a time limit names its kill signal, and every call the reader cannot read is allowed by name", () => {
  const files = sources();
  assert.ok(files.includes("core/git.mjs") && files.includes("test/shell-box.mjs"), "the tree's files were not listed");
  /** @type {Map<number, number>} */
  const used = new Map();
  const refused = [];
  let calls = 0;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    calls += (text.match(/killSignal/g) ?? []).length;
    refused.push(...unallowed(file, text, limitProblems(text), ALLOWED, used));
  }
  assert.deepEqual(refused, []);
  assert.deepEqual(stale(ALLOWED, used), [], "an allowed entry that matches no unreadable call");
  assert.ok(calls > 8, `${calls} kill signals read in the tree`);
});

/**
 * The wrapped runs: a limit that wraps another program (the box's sandbox-exec, unshare or shell, the parser's
 * sandbox-exec, the reference command a user names) against a stand-in that ignores SIGTERM. The stand-in records its
 * PID, would write `late` after LATE_S and then holds on for HOLD_S: a run that ends near its limit, with no `late`
 * and the PID gone, was bounded by it. Measured on Node 22.23.4 (macOS): with no kill signal a spawnSync waited for
 * such a child to end on its own, and SIGKILL to a shell left a process the shell had started running.
 */
const LATE_S = 5;
const HOLD_S = 30;
const SLEEP = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));

/** The stand-in's shell lines: ignore SIGTERM (kept across exec), say its PID, wait, write `late`, hold on. @param {string} dir */
const deafLines = (dir) => `trap '' TERM\necho $$ > "${dir}/pid"\n'${SLEEP}' ${LATE_S}\necho late > "${dir}/late"\nexec '${SLEEP}' ${HOLD_S}\n`;

/**
 * Waits until the stand-in's `late` would have been written, then says what is left: `late` written, and the PID
 * still running (null where the PID is a namespace's own and means nothing outside it).
 * @param {string} dir @param {number} start @param {boolean} [pidReadable]
 */
async function leftOf(dir, start, pidReadable = true) {
  const wait = LATE_S * 1000 + 1500 - (performance.now() - start);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  assert.ok(existsSync(join(dir, "pid")), "the stand-in had not started at the limit");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  assert.ok(pid > 1, "the stand-in's PID");
  return { late: existsSync(join(dir, "late")), running: pidReadable ? !waitGone(pid, 2000) : null };
}

test("kill signal: a box run past its limit ends near it, and a stand-in that ignores SIGTERM goes with it", async () => {
  assert.ok(SLEEP, "this test needs sleep");
  const box = shellBox("en-ks-box-", { stands: { deaf: deafLines("$BOX") }, real: [], limit: 2000 });
  // A sleeper of this test's own, in a group of its own: the run's group stop must not reach it.
  const outside = spawn(/** @type {string} */ (SLEEP), [String(HOLD_S)], { detached: true, stdio: "ignore" });
  try {
    const start = performance.now();
    assert.throws(() => box.run("deaf; deaf"), /did not end/);
    const took = performance.now() - start;
    assert.ok(took < LATE_S * 1000, `${Math.round(took)} ms: the run waited for the stand-in`);
    // In a namespace the stand-in's $$ is the namespace's PID, which names another process outside.
    const left = await leftOf(box.box, start, box.fence !== "namespace");
    assert.equal(left.late, false, "the stand-in went on past the run's limit");
    assert.notEqual(left.running, true, "the stand-in still runs");
    assert.ok(outside.pid && alive(outside.pid), "the group stop reached a process outside the run");
  } finally {
    outside.kill("SIGKILL");
    box.close();
  }
});

test("kill signal: a run Node stops for its output past the buffer takes its group with it", async () => {
  assert.ok(SLEEP, "this test needs sleep");
  const head = ["/usr/bin/head", "/bin/head"].find((p) => existsSync(p));
  assert.ok(head, "this test needs head");
  const box = shellBox("en-ks-buf-", { stands: { deaf: deafLines("$BOX") }, real: ["head"], limit: 20_000 });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-ks-buf-")));
  try {
    // The stand-in has said its PID before the output passes the box's 1 MB buffer.
    const start = performance.now();
    assert.throws(() => box.run(`deaf & while [ ! -s '${box.box}/pid' ]; do :; done; head -c 2000000 /dev/zero; wait`), /did not end/);
    const left = await leftOf(box.box, start, box.fence !== "namespace");
    assert.equal(left.late, false, "the box's stand-in went on after its run was stopped");
    assert.notEqual(left.running, true, "the box's stand-in still runs");
    writeFileSync(join(dir, "deaf"), `#!/bin/sh\n${deafLines(dir)}`, { mode: 0o755 });
    const at = performance.now();
    const r = inFence(["/bin/sh", "-c", `'${dir}/deaf' & while [ ! -s '${dir}/pid' ]; do :; done; '${head}' -c 5000 /dev/zero; wait`], { keep: [dir], limit: 20_000, maxBuffer: 1000, encoding: "utf8" });
    assert.equal(/** @type {NodeJS.ErrnoException} */ (r.error)?.code, "ENOBUFS");
    const fenced = await leftOf(dir, at, fenceName() !== "namespace");
    assert.equal(fenced.late, false, "the fenced stand-in went on after its run was stopped");
    assert.notEqual(fenced.running, true, "the fenced stand-in still runs");
  } finally {
    box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill signal: a test's own command in the boundary past its limit ends near it, the stand-in with it", async () => {
  assert.ok(SLEEP, "this test needs sleep");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-ks-fence-")));
  try {
    writeFileSync(join(dir, "deaf"), `#!/bin/sh\n${deafLines(dir)}`, { mode: 0o755 });
    const start = performance.now();
    const r = inFence(["/bin/sh", "-c", `'${dir}/deaf'; true`], { keep: [dir], limit: 2000, encoding: "utf8" });
    const took = performance.now() - start;
    assert.equal(r.signal, "SIGKILL");
    assert.ok(took < LATE_S * 1000, `${Math.round(took)} ms: the run waited for the stand-in`);
    const left = await leftOf(dir, start, fenceName() !== "namespace");
    assert.equal(left.late, false, "the stand-in went on past the run's limit");
    assert.notEqual(left.running, true, "the stand-in still runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill signal: the parser's sandbox past its limit is stopped, a sandbox that ignores SIGTERM too", async () => {
  assert.ok(SLEEP, "this test needs sleep");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-ks-lex-")));
  try {
    const sandbox = join(dir, "sandbox-exec");
    writeFileSync(sandbox, `#!/bin/sh\n${deafLines(dir)}`, { mode: 0o755 });
    const start = performance.now();
    // The variables test/hermetic.mjs asks of every child, as the reference test gives them.
    const env = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES", "TZ", "LC_ALL", "GIT_CONFIG_NOSYSTEM"].map((k) => [k, process.env[k] ?? ""]));
    assert.throws(() => lexInChild("export class Lexer {}", ["x"], { env, sandbox, node: "24.0.0", ms: 2000 }), /the parser's child failed \(spawnSync \S+ ETIMEDOUT\)/);
    const took = performance.now() - start;
    assert.ok(took < LATE_S * 1000, `${Math.round(took)} ms: the run waited for the stand-in`);
    const left = await leftOf(dir, start);
    // The stand-in's shell is the child: SIGKILL ends it, and the sleep it waits on with it only when the group goes.
    assert.equal(left.running, false, "the stand-in still runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill signal: a reference command's group gets SIGTERM at the impact table's limit, then SIGKILL; a command that ends first is its own result, and what it left is stopped", async () => {
  const perl = ["/usr/bin/perl", "/bin/perl"].find((p) => existsSync(p));
  assert.ok(perl, "this test needs perl");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-ks-ref-")));
  // `cleans` and `deaf`: the command waits on its worker past the limit. `left`: the command ends at once and leaves the
  // worker in its group, holding the command's output; `quiet`: the same with the worker's output elsewhere;
  // `daemon`: the worker leaves the group (setsid) and holds the output.
  const WORKERS = ["cleans", "deaf", "left", "quiet", "daemon"];
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".ennyn"), { recursive: true });
    git(["init", "-q"], { cwd: repo });
    for (const worker of WORKERS) {
      const w = join(dir, worker);
      mkdirSync(w);
      const trap = worker === "deaf" ? "trap '' TERM" : `trap 'rm -f "${w}/lock"; exit 0' TERM`;
      // A worker the command starts and does not exec: a SIGKILL to the command alone would leave it running.
      writeFileSync(join(w, "worker.sh"), `#!/bin/sh\necho $$ > '${w}/pid'\n: > '${w}/lock'\n${trap}\nwhile :; do '${SLEEP}' 1; done\n`, { mode: 0o755 });
      const start = {
        cleans: `/bin/sh '${w}/worker.sh'`,
        deaf: `/bin/sh '${w}/worker.sh'`,
        left: `/bin/sh '${w}/worker.sh' &`,
        quiet: `/bin/sh '${w}/worker.sh' >/dev/null 2>&1 &`,
        daemon: `'${perl}' -MPOSIX -e 'POSIX::setsid(); exec "/bin/sh", "${w}/worker.sh"' &`,
      }[worker];
      const waits = ["cleans", "deaf"].includes(worker) ? "" : `\nwhile [ ! -s '${w}/pid' ]; do :; done`;
      writeFileSync(join(w, "ref.sh"), `${start}${waits}\necho done-$1\n`);
      writeFileSync(join(repo, ".ennyn", "config.json"), JSON.stringify({ impact: { referenceCommand: `/bin/sh ${w}/ref.sh {symbol}`, referenceTimeout: 1 } }));
      const at = performance.now();
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "ennyn.mjs"), "impact", "--symbol", "add", "--files", "a.js"], { cwd: repo, encoding: "utf8", timeout: HOLD_S * 2000, killSignal: "SIGKILL" });
      const took = performance.now() - at;
      const s1 = String(r.stdout.split("\n").find((l) => l.startsWith("| S1 ")));
      if (worker === "cleans" || worker === "deaf") assert.match(s1, /timed out after 1 s/, `${worker}: ${r.stderr}`);
      else {
        // The command's own end and output, never a timeout.
        assert.match(s1, /references: done-add/, `${worker}: ${r.stderr}`);
        assert.doesNotMatch(s1, /timed out/, worker);
      }
      // The group's own SIGKILL ends it by the grace; the runner's own limit, 10 s past the grace, would end it later.
      assert.ok(took < 1000 + REFERENCE_GRACE_MS + 8000, `${worker}: ${Math.round(took)} ms: the table waited for the worker`);
      if (worker === "daemon") continue;
      const pid = Number(readFileSync(join(w, "pid"), "utf8"));
      assert.ok(pid > 1 && waitGone(pid, 2000), `${worker}: the worker still runs`);
      if (worker !== "deaf") assert.equal(existsSync(join(w, "lock")), false, `${worker}: the worker was not let clean up on SIGTERM`);
    }
  } finally {
    // A worker loops until stopped: one a failed run left, and the daemon, which nothing here reaches, are stopped
    // here by the PID each wrote.
    for (const worker of WORKERS) {
      const at = join(dir, worker, "pid");
      const pid = existsSync(at) ? Number(readFileSync(at, "utf8")) : 0;
      if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
