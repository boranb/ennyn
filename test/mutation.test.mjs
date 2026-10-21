import { describe, test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { journalPath, MutationError, parseMutants, restoreJournal, runMutants, summarizeMutants } from "../metrics/mutation.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const NODE = JSON.stringify(process.execPath);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A project whose test command is `node check.mjs`: add() and data.json's limit are tested, twice() is not,
 * notes.txt must hold "alpha". check.mjs writes its pid; it sleeps (and writes its pid to "sleeping") when
 * notes.txt says "sleep" or data.json has "sleep", and naps 2.5 s when notes.txt says "nap". src/esm.js, src/cjs.js and pkg/a.js are JavaScript
 * no test loads: a module without a package type, CommonJS, and a module by its package.json.
 */
function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-")));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  const files = {
    "src/add.mjs": "export const add = (a, b) => a + b;\nexport const twice = (x) => x * 2;\n",
    "src/esm.js": "export const e = 1;\n",
    "src/cjs.js": "module.exports = 1;\n",
    "pkg/package.json": '{ "type": "module" }\n',
    "pkg/a.js": "export default 1;\n",
    "pkg/b.js": "const b = 1;\n",
    "pkg/c.cjs": "module.exports = 1;\n",
    "data.json": '{ "limit": 3 }\n',
    "notes.txt": "alpha\n",
    "overlap.txt": "aaa\n",
    "dup.mjs": "export const x = 1, y = 1;\n",
    "latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    "check.mjs": [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { add } from "./src/add.mjs";',
      'writeFileSync("pid", String(process.pid));',
      'const notes = readFileSync("notes.txt", "utf8");',
      'const data = JSON.parse(readFileSync("data.json", "utf8"));',
      'if (notes.includes("nap")) await new Promise((r) => setTimeout(r, 2500));',
      'if (notes.includes("sleep") || data.sleep) {',
      '  writeFileSync("sleeping", String(process.pid));',
      '  await new Promise((r) => setTimeout(r, 60_000));',
      '}',
      'if (add(2, 3) !== 5 || data.limit !== 3 || !notes.includes("alpha")) process.exit(1);',
      "",
    ].join("\n"),
    "checker.mjs": [
      'import { readFileSync } from "node:fs";',
      'const text = readFileSync(process.argv[2], "utf8");',
      'if (text.includes("SLOW")) await new Promise((r) => setTimeout(r, 60_000));',
      'process.exit(text.includes("BAD") ? 1 : 0);',
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  writeFileSync(join(dir, "..", `${dir.split(/[\\/]/).pop()}-outside.mjs`), "export const o = 1;\n");
  const snapshot = () => Object.fromEntries(Object.keys(files).map((p) => [p, readFileSync(join(dir, p)).toString("base64")]));
  const list = join(dir, "..", `${dir.split(/[\\/]/).pop()}-list.json`);
  return { dir, before: snapshot(), snapshot, list, journal: journalPath(dir, ".git/ennyn") };
}

const m = (/** @type {string} */ id, /** @type {string} */ file, /** @type {string} */ old, /** @type {string} */ nu) => ({ id, file, old, new: nu });
/** @param {import("../metrics/mutation.mjs").MutantResult} r */
const said = (r) => `${r.outcome}${r.reason ? ` ${r.reason.key}${r.reason.vars ? ` ${JSON.stringify(r.reason.vars)}` : ""}` : ""}`;

test("mutate: the list loads whole or not at all, with every problem named", () => {
  assert.deepEqual(parseMutants("[{").problems.length, 1);
  assert.match(parseMutants("{}").problems[0], /JSON array/);
  assert.match(parseMutants("[]").problems[0], /no mutant/);
  const { mutants, problems } = parseMutants(
    JSON.stringify([
      m("a", "x.mjs", "1", "2"),
      null,
      { id: "b", file: "x.mjs", old: "", new: "y" },
      m("c", "x.mjs", "1", "1"),
      m("a", "x.mjs", "3", "4"),
      { id: "d", file: "x.mjs", old: "1" },
      { ...m("e", "x.mjs", "1", "2"), why: "notes are kept out" },
      m("f", "x.mjs", "\ud83d", "x"),
    ]),
  );
  assert.deepEqual(problems, [
    "[1] is not an object",
    '[2] b: "old" must be a non-empty string',
    '[3] c: "new" equals "old"',
    '[4] a: id "a" is used twice',
    '[5] d: "new" must be a string',
    '[7] f: "old" holds half of a character (a lone surrogate)',
  ]);
  assert.deepEqual(mutants.map((x) => x.id), ["a", "e"]);
  assert.deepEqual(Object.keys(mutants[1]), ["id", "file", "old", "new"]);
});

test("mutate: killed, survived, invalid, unchecked and not applied, and every file is back byte for byte", async () => {
  const p = project();
  symlinkSync(join(p.dir, "..", `${p.dir.split(/[\\/]/).pop()}-outside.mjs`), join(p.dir, "link.mjs"));
  const mutants = [
    m("k1", "src/add.mjs", "a + b", "a - b"),
    m("s1", "src/add.mjs", "x * 2", "x * 3"),
    m("i1", "src/add.mjs", "a + b;", "a + ;"),
    m("j1", "data.json", "3", "4"),
    m("j2", "data.json", " }", ""),
    // JavaScript is checked as Node reads it: a broken module in a package without a type does not parse,
    // nor a top-level await in CommonJS, nor a broken module that package.json makes one.
    m("e1", "src/esm.js", "= 1;", "= ;"),
    m("e2", "src/esm.js", "= 1;", "= 2;"),
    m("e3", "src/cjs.js", "module.exports = 1;", "await 1;\nmodule.exports = 1;"),
    m("e4", "pkg/a.js", "default 1;", "default ;"),
    // pkg/ is a module package: b.js parses as CommonJS too, but a with statement is not allowed in a module;
    // c.cjs stays CommonJS there, where a top-level await does not parse.
    m("e5", "pkg/b.js", "const b = 1;", "const b = 1;\nwith (b) {}"),
    m("e6", "pkg/c.cjs", "module.exports = 1;", "await 1;\nmodule.exports = 1;"),
    m("u1", "notes.txt", "alpha", "beta"),
    m("u2", "notes.txt", "alpha", "alphabet"),
    // Taken as written: a replacement pattern would put "alpha" back and the tests would pass.
    m("u3", "notes.txt", "alpha", "$& $'"),
    m("a1", "dup.mjs", "1", "2"),
    m("a2", "src/add.mjs", "nothing", "x"),
    m("a3", `../${p.dir.split(/[\\/]/).pop()}-outside.mjs`, "1", "2"),
    m("a4", "missing.mjs", "1", "2"),
    m("a5", "latin1.txt", "caf", "CAF"),
    m("a6", "link.mjs", "1", "2"),
    m("a7", "src", "x", "y"),
    // "aa" is twice in "aaa", overlapping.
    m("a8", "overlap.txt", "aa", "ab"),
  ];
  const seen = [];
  const res = await runMutants({ cwd: p.dir, mutants, command: `${NODE} check.mjs`, journal: p.journal, onResult: (r) => seen.push(r.id) });
  assert.equal(res.baseline.exit, 0);
  assert.equal(res.timeoutMs, res.baseline.ms + 30_000, "a fast suite gets 30 s more, not three times almost nothing");
  assert.deepEqual(seen, mutants.map((x) => x.id), "every mutant reported in order");
  assert.deepEqual(Object.fromEntries(res.results.map((r) => [r.id, said(r)])), {
    k1: "killed",
    s1: "survived",
    i1: "invalid mutate.reason.parse",
    j1: "killed",
    j2: "invalid mutate.reason.parse",
    e1: "invalid mutate.reason.parse",
    e2: "survived",
    e3: "invalid mutate.reason.parse",
    e4: "invalid mutate.reason.parse",
    e5: "invalid mutate.reason.parse",
    e6: "invalid mutate.reason.parse",
    u1: "unchecked mutate.reason.noCheck",
    u2: "survived mutate.reason.noCheck",
    u3: "unchecked mutate.reason.noCheck",
    a1: 'unapplied mutate.reason.occurs {"n":2}',
    a2: 'unapplied mutate.reason.occurs {"n":0}',
    a3: "unapplied mutate.reason.outside",
    a4: "unapplied mutate.reason.missing",
    a5: "unapplied mutate.reason.notText",
    a6: "unapplied mutate.reason.outside",
    a7: "unapplied mutate.reason.missing",
    a8: 'unapplied mutate.reason.occurs {"n":2}',
  });
  // u2 survived where no check reads: a survivor to test, but out of the count, like u1 and u3's kills.
  assert.deepEqual(summarizeMutants(res.results), { killed: 2, total: 4, timeout: 0, survived: 2, invalid: 7, unapplied: 8, unchecked: 2, uncheckedSurvived: 1 });
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false, "the journal goes with the run");
  assert.notEqual(statSync(dirname(p.journal)).mode & 0o777, 0o700, "a state dir in the repository keeps its own modes");
});

test("mutate: every write gives the file a newer whole-second mtime, so a cache keyed by mtime and size cannot serve a mutant", async () => {
  const p = project();
  const file = join(p.dir, "src", "add.mjs");
  // Ahead of now, as a run with fast mutants leaves it: the first mutant still gets a newer second.
  const ahead = Math.floor(Date.now() / 1000) + 2;
  utimesSync(file, ahead, ahead);
  const before = Math.floor(statSync(file).mtimeMs / 1000);
  // Each run logs the mtime it sees; the two mutants keep the file's size.
  const log = `${NODE} -e "require('fs').appendFileSync('mt.log', Math.floor(require('fs').statSync('src/add.mjs').mtimeMs / 1000) + '\\n')"`;
  await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b"), m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${log} && ${NODE} check.mjs`, journal: p.journal });
  const seen = readFileSync(join(p.dir, "mt.log"), "utf8").trim().split("\n").map(Number);
  const [, k1, s1] = seen;
  const after = Math.floor(statSync(file).mtimeMs / 1000);
  assert.ok(before < k1 && k1 < s1 && s1 < after, `${[before, ...seen, after]}`);
  assert.deepEqual(p.snapshot(), p.before);
});

test("mutate: tests that fail without a mutant stop the run before any file changes", async () => {
  const p = project();
  writeFileSync(join(p.dir, "notes.txt"), "no greek letter\n");
  const res = await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: p.journal });
  assert.equal(res.baseline.exit, 1);
  assert.deepEqual(res.results, []);
  assert.equal(readFileSync(join(p.dir, "src/add.mjs"), "utf8"), "export const add = (a, b) => a + b;\nexport const twice = (x) => x * 2;\n");
  assert.equal(existsSync(p.journal), false);
});

test("mutate: a timeout the tests cannot meet without a mutant is refused, not counted as kills", async () => {
  const p = project();
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} -e "setTimeout(() => {}, 700)"`, journal: p.journal, timeoutMs: 500 }),
    (e) => e instanceof MutationError && /a timeout of 0\.5 s is under one and a half times the run without mutants/.test(e.message),
  );
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("mutate: a test run that cannot start ends the pass with no count, the file back", async () => {
  const p = project();
  const cp = /** @type {Record<string, any>} */ (childProcess);
  const real = cp.spawn;
  let calls = 0;
  // The second spawn is the first mutant's test run: it gets a working directory that does not exist.
  cp.spawn = (/** @type {any[]} */ ...args) => (++calls === 2 ? real(args[0], { ...args[1], cwd: join(p.dir, "gone") }) : real(...args));
  syncBuiltinESMExports();
  try {
    await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal }), /the test command did not start for mutant s1/);
  } finally {
    cp.spawn = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("mutate: a killed run is undone by the next one or by --restore while the file still holds the mutant; a file changed since is left alone", async () => {
  const p = project();
  const file = join(p.dir, "src", "add.mjs");
  const original = readFileSync(file);
  const mutated = Buffer.from(original.toString().replace("a + b", "a - b"));
  mkdirSync(dirname(p.journal), { recursive: true });
  const journal = (/** @type {number} */ pid) => writeFileSync(p.journal, JSON.stringify({ pid, id: "k1", file: "src/add.mjs", original: original.toString("base64"), mutated: mutated.toString("base64") }));
  // A pid that is gone: a child that already exited.
  const gone = /** @type {number} */ (spawnSync(process.execPath, ["-e", "0"]).pid);
  writeFileSync(file, mutated);
  journal(gone);
  const res = await runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal });
  assert.equal(res.restored, "src/add.mjs");
  assert.deepEqual(readFileSync(file), original);
  assert.equal(res.results[0].outcome, "survived");

  // Edited after the crash: neither the mutant nor the original, so nothing is written and nothing runs.
  writeFileSync(file, "export const add = () => 0;\n");
  journal(gone);
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x", "y")], command: `${NODE} check.mjs`, journal: p.journal }), (e) => e instanceof MutationError && /changed since/.test(e.message));
  assert.equal(readFileSync(file, "utf8"), "export const add = () => 0;\n");
  assert.ok(existsSync(p.journal), "the journal keeps the original bytes");

  // A journal whose pid is alive (a live run, or a pid reused after a reboot): refused, and the way out is
  // --restore, never deleting the journal that holds the original.
  writeFileSync(file, mutated);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  journal(/** @type {number} */ (sleeper.pid));
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x", "y")], command: "true", journal: p.journal }),
    /another ennyn mutate \(pid \d+\) is running in this tree; it holds the original bytes of src\/add\.mjs\. If it is not, run ennyn mutate --restore --force \(never delete the journal\)/,
  );
  // A live pid may be a run in a mutant's tests: writing the file back under it would turn a kill into a survivor.
  assert.throws(() => restoreJournal(p.dir, p.journal), /pid \d+ of the journal is alive: an ennyn mutate may be running in this tree\. If that pid is no such run \(reused after a reboot\), add --force/);
  assert.deepEqual(readFileSync(file), mutated, "nothing written back");
  assert.deepEqual(restoreJournal(p.dir, p.journal, { force: true }), { restored: "src/add.mjs", found: true });
  sleeper.kill();
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(restoreJournal(p.dir, p.journal), { restored: null, found: false });
});

test("mutate: outside a repository the journal is not put under a .git directory", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-norepo-")));
  assert.ok(!journalPath(dir, ".git/ennyn").startsWith(realpathSync(dir)));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.ok(journalPath(dir, "state").startsWith(join(dir, "state")), "a state dir of the project's own is used as is");
});

test("cli: mutate prints each mutant and the count; --json is the result; --restore; usage and list errors", () => {
  const p = project();
  writeFileSync(p.list, JSON.stringify([m("k1", "src/add.mjs", "a + b", "a - b"), m("s1", "src/add.mjs", "x * 2", "x * 3"), m("u1", "notes.txt", "alpha", "beta")]));
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, "mutate", ...args], { cwd: p.dir, encoding: "utf8" });
  const text = run(p.list, "--command", `${NODE} check.mjs`);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Tests pass without mutants in [\d.]+ s; a mutant counts as killed by timeout when it runs past (\d+) s, and again past \d+ s\.$/m);
  assert.match(text.stdout, /^k1 killed src\/add\.mjs$/m);
  assert.match(text.stdout, /^s1 SURVIVED src\/add\.mjs$/m);
  assert.match(text.stdout, /^u1 unchecked notes\.txt — no parse check reads this file$/m);
  assert.match(text.stdout, /^Killed 1\/2 \(0 by timeout\) · invalid 0 · not applied 0 · in files no parse check read: 1 failed, 0 passed$/m);
  assert.match(text.stdout, /^Survived: s1\. Write a test for each/m);
  assert.match(text.stdout, /^1 mutants are in files no parse check read and stay out of the count; pass --check "<command> \{file\}" to count them\.$/m);
  const json = JSON.parse(run(p.list, "--command", `${NODE} check.mjs`, "--json", "--timeout", "60").stdout);
  assert.deepEqual(json.summary, { killed: 1, total: 2, timeout: 0, survived: 1, invalid: 0, unapplied: 0, unchecked: 1, uncheckedSurvived: 0 });
  assert.equal(json.timeoutMs, 60_000);
  assert.deepEqual(p.snapshot(), p.before);
  assert.deepEqual([run("--restore").status, run("--restore").stdout.trim()], [0, "No journal of an interrupted run in this tree."]);
  // A journal a killed run left, whatever its pid: --restore puts the file back.
  const file = join(p.dir, "src", "add.mjs");
  const original = readFileSync(file);
  const mutated = Buffer.from(original.toString().replace("x * 2", "x * 3"));
  mkdirSync(dirname(p.journal), { recursive: true });
  writeFileSync(file, mutated);
  writeFileSync(p.journal, JSON.stringify({ pid: process.pid, id: "s1", file: "src/add.mjs", original: original.toString("base64"), mutated: mutated.toString("base64") }));
  // Its pid is this test's, alive: refused without --force.
  const refused = run("--restore");
  assert.deepEqual([refused.status, /add --force/.test(refused.stderr)], [1, true]);
  const restored = run("--restore", "--force");
  assert.deepEqual([restored.status, restored.stdout.trim()], [0, "An interrupted run had left a mutant in src/add.mjs; the file is back as it was."]);
  assert.deepEqual(readFileSync(file), original);

  assert.equal(run().status, 2, "no list");
  assert.equal(run(p.list).status, 2, "no --command");
  assert.equal(run(p.list, "--command", "x", "--timeout", "0").status, 2);
  assert.equal(run(p.list, "--command", "x", "--timeout", "1.5").status, 2);
  assert.equal(run(p.list, "--command", "x", "--timeout", "2147484").status, 2, "past setTimeout's ceiling a timer fires at once");
  assert.equal(run("--restore", p.list).status, 2);
  assert.equal(run(p.list, "--command", "x", "--force").status, 2, "--force goes with --restore");
  writeFileSync(p.list, "[]");
  const empty = run(p.list, "--command", `${NODE} check.mjs`);
  assert.deepEqual([empty.status, /no mutant/.test(empty.stderr)], [1, true]);
  writeFileSync(join(p.dir, "notes.txt"), "beta\n");
  writeFileSync(p.list, JSON.stringify([m("k1", "src/add.mjs", "a + b", "a - b")]));
  const failing = run(p.list, "--command", `${NODE} check.mjs`);
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /The tests fail without any mutant \(exit 1\); no mutant was run/);
});

// Runs that wait on timers and processes, side by side: each has its own project and journal.
describe("mutate: runs that wait", { concurrency: 4 }, () => {
  test("mutate: a mutant that hangs is killed at the second timeout, the test process with it", async () => {
    const p = project();
    const started = Date.now();
    // Two commands: the shell forks the test process instead of becoming it, so killing the shell alone would leave it.
    const res = await runMutants({ cwd: p.dir, mutants: [m("t1", "data.json", '"limit": 3', '"limit": 3, "sleep": 1')], command: `${NODE} check.mjs && true`, journal: p.journal, timeoutMs: 1500 });
    assert.ok(Date.now() - started < 45_000, "the run ends at the timeouts, not when the test process would (60 s)");
    assert.deepEqual(res.results.map(said), ["timeout"]);
    assert.deepEqual(summarizeMutants(res.results), { killed: 1, total: 1, timeout: 1, survived: 0, invalid: 0, unapplied: 0, unchecked: 0, uncheckedSurvived: 0 });
    assert.throws(() => process.kill(Number(readFileSync(join(p.dir, "sleeping"), "utf8")), 0), { code: "ESRCH" }, "the sleeping test process is gone");
    assert.deepEqual(p.snapshot(), p.before);
  });

  test("mutate: where no parse check reads, a hang is unchecked, not a kill", async () => {
    const p = project();
    const res = await runMutants({ cwd: p.dir, mutants: [m("t2", "notes.txt", "alpha", "alpha sleep")], command: `${NODE} check.mjs && true`, journal: p.journal, timeoutMs: 1500 });
    assert.deepEqual(res.results.map(said), ["unchecked mutate.reason.noCheck"]);
    assert.deepEqual(p.snapshot(), p.before);
  });

  test("mutate: a run slower than the timeout but not stuck gets a second, doubled timeout and is not a kill", async () => {
    const p = project();
    const res = await runMutants({ cwd: p.dir, mutants: [m("n1", "notes.txt", "alpha", "alpha nap")], command: `${NODE} check.mjs`, journal: p.journal, timeoutMs: 2000 });
    assert.equal(res.results[0].outcome, "survived");
    assert.deepEqual(p.snapshot(), p.before);
  });

  test("mutate: a built-in check that cannot run gives no answer, never \"does not parse\"", async () => {
  const p = project();
  const cp = /** @type {Record<string, any>} */ (childProcess);
  const real = cp.spawnSync;
  cp.spawnSync = (/** @type {any[]} */ ...args) => (Array.isArray(args[1]) && String(args[1][0]).startsWith("--input-type=") ? { status: null, signal: null, error: new Error("spawnSync EAGAIN") } : real(...args));
  syncBuiltinESMExports();
  try {
    const res = await runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal });
    assert.deepEqual(res.results.map(said), ["survived mutate.reason.checkNoAnswer"]);
  } finally {
    cp.spawnSync = real;
    syncBuiltinESMExports();
  }
});

test("mutate: a file only its owner may stamp (others may write it) is mutated and put back, unstamped", async () => {
  const p = project();
  const fs = /** @type {Record<string, any>} */ (await import("node:fs")).default;
  const real = fs.utimesSync;
  fs.utimesSync = () => {
    throw Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" });
  };
  syncBuiltinESMExports();
  try {
    const res = await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b"), m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal });
    assert.deepEqual(res.results.map(said), ["killed", "survived"]);
  } finally {
    fs.utimesSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("mutate: what a test run leaves running is stopped before the next mutant", async () => {
    const p = project();
    const started = Date.now();
    const res = await runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `sleep 30 & echo $! > leftover.pid; ${NODE} check.mjs`, journal: p.journal });
    assert.equal(res.results[0].outcome, "survived");
    assert.ok(Date.now() - started < 25_000, "the left-behind process holds the pipes; the run does not wait for it (30 s)");
    assert.throws(() => process.kill(Number(readFileSync(join(p.dir, "leftover.pid"), "utf8")), 0), { code: "ESRCH" });
  });


  test("mutate: --check decides what parses; a check that fails on the file as it is, or gives no answer, cannot", async () => {
    const p = project();
    writeFileSync(join(p.dir, "bad.txt"), "BAD\n");
    const before = p.snapshot();
    const mutants = [
      m("c1", "notes.txt", "alpha", "BAD alpha"),
      m("c2", "notes.txt", "alpha", "beta"),
      m("c3", "bad.txt", "BAD", "BAD!"),
      // --check judges only what no built-in check reads: it would pass these, JSON.parse and node do not.
      m("c6", "data.json", " }", ""),
      m("c7", "src/add.mjs", "a + b;", "a + ;"),
    ];
    const res = await runMutants({ cwd: p.dir, mutants, command: `${NODE} check.mjs`, check: `${NODE} checker.mjs {file}`, journal: p.journal });
    // c3's check fails on the original too; its tests pass: a survivor, counted apart.
    assert.deepEqual(res.results.map(said), ["invalid mutate.reason.parse", "killed", "survived mutate.reason.originalFails", "invalid mutate.reason.parse", "invalid mutate.reason.parse"]);
    // A check that runs past the tests' limit answers nothing: the mutant is unchecked, never invalid.
    const slow = await runMutants({ cwd: p.dir, mutants: [m("c4", "notes.txt", "alpha", "beta")], command: `${NODE} check.mjs`, check: `sleep 5; ${NODE} checker.mjs {file}`, journal: p.journal, timeoutMs: 1500 });
    assert.deepEqual(slow.results.map(said), ["unchecked mutate.reason.checkNoAnswer"]);
    // The check answers for the file as it is, but not for the mutant: unchecked too.
    const stalls = await runMutants({ cwd: p.dir, mutants: [m("c5", "notes.txt", "alpha", "SLOW beta")], command: `${NODE} check.mjs`, check: `${NODE} checker.mjs {file}`, journal: p.journal, timeoutMs: 1500 });
    assert.deepEqual(stalls.results.map(said), ["unchecked mutate.reason.checkNoAnswer"]);
    // A check killed by a signal answers nothing either.
    const killed = await runMutants({ cwd: p.dir, mutants: [m("c8", "notes.txt", "alpha", "beta")], command: `${NODE} check.mjs`, check: "kill -9 $$", journal: p.journal });
    assert.deepEqual(killed.results.map(said), ["unchecked mutate.reason.checkNoAnswer"]);
    assert.deepEqual(p.snapshot(), before);
  });


  test("cli: a closed output pipe ends the run with every file back (an agent's `| head`)", async () => {
    const p = project();
    writeFileSync(p.list, JSON.stringify([m("s1", "src/add.mjs", "x * 2", "x * 3"), m("s2", "src/add.mjs", "a + b", "b + a"), m("s3", "src/add.mjs", "(x)", "(y) => y * 2, z = (x)")]));
    // Each test run waits with its mutant in place, so the broken pipe of one line's write lands mid-mutant.
    const command = `${NODE} -e "setTimeout(() => {}, 400)" && ${NODE} check.mjs`;
    const child = spawn(process.execPath, [CLI, "mutate", p.list, "--command", command], { cwd: p.dir, stdio: ["ignore", "pipe", "ignore"] });
    const closed = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    await new Promise((done) => child.stdout.once("data", done));
    child.stdout.destroy();
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.deepEqual(p.snapshot(), p.before);
    assert.equal(existsSync(p.journal), false);
  });


  test("cli: a signal mid-run stops the tests, puts the file back and drops the journal", async () => {
    const p = project();
    writeFileSync(p.list, JSON.stringify([m("t1", "notes.txt", "alpha", "alpha sleep")]));
    const child = spawn(process.execPath, [CLI, "mutate", p.list, "--command", `${NODE} check.mjs`], { cwd: p.dir, stdio: "ignore" });
    const closed = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    // Wait until the mutant is in place and its test process has started.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(join(p.dir, "sleeping"))) await sleep(50);
    const testPid = Number(readFileSync(join(p.dir, "sleeping"), "utf8"));
    child.kill("SIGINT");
    assert.deepEqual(await closed, { code: null, signal: "SIGINT" });
    assert.equal(readFileSync(join(p.dir, "notes.txt"), "utf8"), "alpha\n");
    assert.equal(existsSync(p.journal), false);
    assert.throws(() => process.kill(testPid, 0), { code: "ESRCH" });
    assert.deepEqual(readdirSync(dirname(p.journal)), []);
  });


  test("cli: a run killed outright (SIGKILL) leaves the journal, and the next run puts the file back", async () => {
    const p = project();
    writeFileSync(p.list, JSON.stringify([m("t1", "notes.txt", "alpha", "alpha sleep")]));
    const child = spawn(process.execPath, [CLI, "mutate", p.list, "--command", `${NODE} check.mjs`], { cwd: p.dir, stdio: "ignore" });
    const closed = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(join(p.dir, "sleeping"))) await sleep(50);
    child.kill("SIGKILL");
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
    assert.equal(readFileSync(join(p.dir, "notes.txt"), "utf8"), "alpha sleep\n", "nothing could put it back");
    const mutantStamp = Math.floor(statSync(join(p.dir, "notes.txt")).mtimeMs / 1000);
    // The orphaned test process sleeps on; stop it before the next run reads the tree.
    process.kill(Number(readFileSync(join(p.dir, "sleeping"), "utf8")), "SIGKILL");
    writeFileSync(p.list, JSON.stringify([m("s1", "src/add.mjs", "x * 2", "x * 3")]));
    const next = spawnSync(process.execPath, [CLI, "mutate", p.list, "--command", `${NODE} check.mjs`], { cwd: p.dir, encoding: "utf8" });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stderr, /An interrupted run had left a mutant in notes\.txt; the file is back as it was/);
    assert.ok(Math.floor(statSync(join(p.dir, "notes.txt")).mtimeMs / 1000) > mutantStamp, "written back with a newer mtime than the mutant's");
    assert.deepEqual(p.snapshot(), p.before);
    assert.equal(existsSync(p.journal), false);
  });
});
