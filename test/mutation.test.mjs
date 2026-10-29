import { describe, test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { journalPath, MutationError, parseMutants, restoreJournal, runMutants, summarizeMutants } from "../metrics/mutation.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const NODE = JSON.stringify(process.execPath);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a process was killed: gone (signal 0 finds no such process), or a zombie. Killed with its parent,
 * it waits as a zombie until init reaps it, and signal 0 still finds it: on a loaded machine that took
 * longer than the test did. A live one gets 2 s for the kill to land, never the time it would take to end
 * by itself. A pid that is no pid (0 or NaN, from a file read half written) is never "gone".
 * @param {number} pid
 */
async function gone(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ESRCH") return true;
      throw e;
    }
    if (spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z")) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

/** A pid file once it holds a pid: the test writes it, and a read can land between create and write. @param {string} path */
async function pidIn(path) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pid = existsSync(path) ? Number(readFileSync(path, "utf8")) : NaN;
    if ((Number.isInteger(pid) && pid > 0) || Date.now() > deadline) return pid;
    await sleep(50);
  }
}

test("mutate tests: gone() is false for a live process and for a pid that is no pid", async () => {
  for (const pid of [0, NaN, Number(""), process.pid]) assert.equal(await gone(pid), false, String(pid));
});

/**
 * A project whose test command is `node check.mjs`: add() and data.json's limit are tested, twice() is not,
 * notes.txt must hold "alpha". check.mjs writes its pid; it sleeps (and writes its pid to "sleeping") when
 * notes.txt says "sleep" or data.json has "sleep", and naps 4.5 s when notes.txt says "nap". src/esm.js, src/cjs.js and pkg/a.js are JavaScript
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
      'if (notes.includes("nap")) await new Promise((r) => setTimeout(r, 4500));',
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
  assert.deepEqual(parseMutants('\uFEFF[{ "id": "a", "file": "f", "old": "x", "new": "y" }]'), { mutants: [{ id: "a", file: "f", old: "x", new: "y" }], problems: [] }, "a byte order mark is no part of the list");
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

test("mutate: a repository under the temporary directory keeps its state dir's modes", async () => {
  // On Linux /tmp is the real path; on macOS /var is a symlink and the paths never matched by accident.
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = realpathSync(tmpdir());
  try {
    const p = project();
    assert.ok(p.journal.startsWith(tmpdir()), "the state dir is under the temporary directory, as spelled");
    await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: p.journal });
    assert.notEqual(statSync(dirname(p.journal)).mode & 0o777, 0o700);
  } finally {
    // Unset, it stays unset: Node would store the string "undefined".
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
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

test("mutate: an edit made while a mutant is in the file is kept, never written over; the run stops and the journal keeps the original", async () => {
  const p = project();
  const notes = join(p.dir, "notes.txt");
  // An agent or the user edits the file while the mutant's tests run: here the test command does it.
  const edit = `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) f.appendFileSync('notes.txt', 'by hand\\n')"`;
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta"), m("e2", "src/add.mjs", "x * 2", "x * 3")], command: `${edit} && ${NODE} check.mjs`, journal: p.journal }),
    (e) => e instanceof MutationError && /^notes\.txt changed while mutant "e1" was in it \(an edit, or the test command writing it\): it is left as it is, the mutant with it; its original bytes are in .*mutate-\w+\.json \(base64\): take the mutant out by hand, then delete the journal$/.test(e.message),
  );
  assert.equal(readFileSync(notes, "utf8"), "beta\nby hand\n", "the edit is kept");
  assert.deepEqual(readFileSync(join(p.dir, "src", "add.mjs")).toString("base64"), p.before["src/add.mjs"], "no later mutant ran");
  assert.equal(Buffer.from(JSON.parse(readFileSync(p.journal, "utf8")).original, "base64").toString(), "alpha\n");
  // The next run and --restore refuse until the file is put right by hand, then the journal is deleted.
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal }), /changed since; .* put the file right by hand, then delete the journal$/);
  assert.throws(() => restoreJournal(p.dir, p.journal), /changed since/);
  assert.equal(readFileSync(notes, "utf8"), "beta\nby hand\n");
  // A test command that takes the mutant out itself leaves nothing to put back.
  writeFileSync(notes, "alpha\n");
  rmSync(p.journal);
  const res = await runMutants({ cwd: p.dir, mutants: [m("e3", "notes.txt", "alpha", "beta")], command: `${NODE} -e "require('fs').writeFileSync('notes.txt', 'alpha\\n')" && ${NODE} check.mjs`, journal: p.journal });
  assert.deepEqual(res.results.map(said), ["survived mutate.reason.noCheck"]);
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
  // A file deleted while the mutant was in is an edit too: not made again.
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("e4", "notes.txt", "alpha", "beta")], command: `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) f.rmSync('notes.txt')" && ${NODE} check.mjs`, journal: p.journal }), /^MutationError: notes\.txt was deleted while mutant "e4" was in it: nothing is written there; its original bytes are in .* \(base64\): write them back by hand if the file should be there, then delete the journal$/);
  assert.equal(existsSync(notes), false);
  assert.equal(Buffer.from(JSON.parse(readFileSync(p.journal, "utf8")).original, "base64").toString(), "alpha\n");
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} -e 0`, journal: p.journal }), /and the file was deleted since; .* write them back by hand if the file should be there, then delete the journal$/);
  // The CLI says it once, and the exit handler finds nothing left to say.
  writeFileSync(notes, "alpha\n");
  rmSync(p.journal);
  writeFileSync(p.list, JSON.stringify([m("e5", "notes.txt", "alpha", "beta")]));
  const cli = spawnSync(process.execPath, [CLI, "mutate", p.list, "--command", `${edit} && ${NODE} check.mjs`], { cwd: p.dir, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^notes\.txt changed while mutant "e5" was in it \(an edit, or the test command writing it\): [^\n]*journal\n$/);
});

test("mutate: a mutant whose write is cut short (a full disk) is the run's own: the original goes back", async () => {
  const p = project();
  const fs = /** @type {Record<string, any>} */ (await import("node:fs")).default;
  const real = fs.writeSync;
  fs.writeSync = (/** @type {any} */ fd, /** @type {any} */ data, /** @type {any[]} */ ...rest) => {
    if (Buffer.isBuffer(data) && data.includes("a - b")) {
      real(fd, data, 0, 12, 0);
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return real(fd, data, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: p.journal }), /^MutationError: mutant "k1" was not written to src\/add\.mjs \(ENOSPC: no space left on device, write\): the file is as it was; no count from this run$/);
  } finally {
    fs.writeSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("cli: a file that cannot be written stops the run with its error and no stack trace; the file and the journal are as before", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes any file");
  const p = project();
  const file = join(p.dir, "src", "add.mjs");
  writeFileSync(p.list, JSON.stringify([m("k1", "src/add.mjs", "a + b", "a - b")]));
  chmodSync(file, 0o444);
  const r = spawnSync(process.execPath, [CLI, "mutate", p.list, "--command", `${NODE} check.mjs`], { cwd: p.dir, encoding: "utf8" });
  chmodSync(file, 0o644);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^mutant "k1" was not written to src\/add\.mjs \(E(ACCES|PERM): [^\n]*\): the file is as it was; no count from this run\n$/);
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("mutate: an edit or a deletion while the original's parse check runs is not built over: nothing is written, the run stops (round 1)", async () => {
  for (const [what, act, left] of /** @type {const} */ ([
    ["edit", "f.appendFileSync(process.argv[2], 'by hand\\n')", "alpha\nby hand\n"],
    ["delete", "f.rmSync(process.argv[2])", null],
  ])) {
    const p = project();
    const notes = join(p.dir, "notes.txt");
    // The check runs on the original first; it makes the edit once, as an agent working beside the run would.
    writeFileSync(join(p.dir, "once.cjs"), `const f = require("fs"); if (!f.existsSync("done")) { f.writeFileSync("done", ""); ${act}; }`);
    await assert.rejects(
      runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${NODE} -e 0`, check: `${NODE} once.cjs {file}`, journal: p.journal }),
      /^MutationError: notes\.txt changed while mutant "e1" was being prepared \(an edit, or the parse check writing it\): nothing was written to it; run again$/,
      what,
    );
    assert.equal(existsSync(notes) ? readFileSync(notes, "utf8") : null, left, what);
    assert.equal(existsSync(p.journal), false, `${what}: nothing of the run's is in the file`);
  }
});

test("mutate: a file the tests take the mutant out of themselves still gets a newer whole-second mtime (round 1)", async () => {
  const p = project();
  const file = join(p.dir, "src", "add.mjs");
  const ahead = Math.floor(Date.now() / 1000) + 2;
  utimesSync(file, ahead, ahead);
  const log = `${NODE} -e "require('fs').appendFileSync('mt.log', Math.floor(require('fs').statSync('src/add.mjs').mtimeMs / 1000) + '\\n')"`;
  // Same size, written back by the tests (a codegen step, a checkout) within the mutant's second.
  const undo = `${NODE} -e "const f = require('fs'); f.writeFileSync('src/add.mjs', f.readFileSync('src/add.mjs', 'utf8').replace('a - b', 'a + b'))"`;
  await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${log} && ${undo} && ${NODE} check.mjs`, journal: p.journal });
  const [, k1] = readFileSync(join(p.dir, "mt.log"), "utf8").trim().split("\n").map(Number);
  assert.ok(Math.floor(statSync(file).mtimeMs / 1000) > k1, "a cache keyed by mtime and size would serve the mutant");
  assert.deepEqual(p.snapshot(), p.before);
});

test("mutate: a symbolic link swapped in after the mutant was built is not written through, before or after the tests (round 1)", async () => {
  for (const when of ["check", "tests"]) {
    const p = project();
    const out = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-out-")));
    writeFileSync(join(out, "x.txt"), "1\n");
    mkdirSync(join(p.dir, "sub"));
    writeFileSync(join(p.dir, "sub", "x.txt"), "1\n");
    // Once, with the mutant in for the tests (the baseline runs them too): sub/ moves aside and sub becomes a
    // link to a directory outside the project.
    const swap = `${NODE} -e "const f = require('fs'); if (!f.existsSync('swapped') && ${when === "tests" ? "f.readFileSync('sub/x.txt', 'utf8') === '2\\n'" : "true"}) { f.writeFileSync('swapped', ''); f.renameSync('sub', 'sub.bak'); f.symlinkSync(${JSON.stringify(JSON.stringify(out))}, 'sub'); }"`;
    const opts = when === "check" ? { command: `${NODE} -e 0`, check: `${swap.replace(/"$/, "")}" {file}` } : { command: `${swap} && ${NODE} check.mjs` };
    const said = when === "check" ? /^MutationError: mutant "t1" was not written to sub\/x\.txt \(sub is a symbolic link\): the file is as it was; no count from this run$/ : /^MutationError: mutant "t1" is left in the file that was at sub\/x\.txt: sub is a symbolic link, and nothing is written through it; its original bytes are in .* \(base64\): put that file right by hand, then delete the journal$/;
    // A link already there is refused before the open: nothing outside is even opened to write (a device may act on an open).
    const fs = /** @type {Record<string, any>} */ (await import("node:fs")).default;
    const realOpen = fs.openSync;
    const opened = [];
    fs.openSync = (/** @type {any} */ path, /** @type {any} */ flags, /** @type {any[]} */ ...rest) => {
      if (String(path).endsWith(`${sep}x.txt`) && typeof flags === "number" && flags & fs.constants.O_RDWR) opened.push(path);
      return realOpen(path, flags, ...rest);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("t1", "sub/x.txt", "1", "2")], journal: p.journal, ...opts }), said, when);
    } finally {
      fs.openSync = realOpen;
      syncBuiltinESMExports();
    }
    assert.deepEqual(opened, when === "check" ? [] : [join(p.dir, "sub", "x.txt")], `${when}: opened to write once the link was there`);
    assert.equal(readFileSync(join(out, "x.txt"), "utf8"), "1\n", `${when}: the file outside is untouched`);
    if (when === "tests") {
      assert.equal(readFileSync(join(p.dir, "sub.bak", "x.txt"), "utf8"), "2\n", "the mutant is where it was written");
      assert.equal(Buffer.from(JSON.parse(readFileSync(p.journal, "utf8")).original, "base64").toString(), "1\n", "the journal keeps the original");
      // --restore points at the moved file too, never at deleting the journal alone (round 2).
      assert.throws(() => restoreJournal(p.dir, p.journal), /names sub\/x\.txt, and sub is a symbolic link: nothing is written through it\. If a run wrote the journal, the mutant is in the file that was at sub\/x\.txt; its original bytes are in .*, the mutant was "t1": put that file right by hand, then delete the journal$/);
      assert.ok(existsSync(p.journal));
    } else assert.equal(existsSync(p.journal), false);
  }
});

test("mutate: a put-back that cannot write names the mutant left in the file and keeps the journal (round 1)", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes any file");
  const p = project();
  const notes = join(p.dir, "notes.txt");
  const lock = `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) f.chmodSync('notes.txt', 0o444)"`;
  try {
    await assert.rejects(
      runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${lock} && ${NODE} check.mjs`, journal: p.journal }),
      /^MutationError: mutant "e1" is left in notes\.txt: it could not be written back \(E(ACCES|PERM): [^)]*\); its original bytes are in .*mutate-\w+\.json \(base64\): put the file right by hand, then delete the journal$/,
    );
  } finally {
    chmodSync(notes, 0o644);
  }
  assert.equal(readFileSync(notes, "utf8"), "beta\n");
  assert.equal(Buffer.from(JSON.parse(readFileSync(p.journal, "utf8")).original, "base64").toString(), "alpha\n");
});

test("mutate: a FIFO the tests leave at the file's path is never read, and nothing waits on it (round 1)", { timeout: 60_000 }, async () => {
  const p = project();
  const fifo = `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) f.rmSync('notes.txt')" && { [ -e notes.txt ] || mkfifo notes.txt; }`;
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${fifo} && ${NODE} -e 0`, journal: p.journal }),
    /^MutationError: mutant "e1" is left in notes\.txt: .*it is no regular file.*; its original bytes are in /,
  );
  assert.ok(lstatSync(join(p.dir, "notes.txt")).isFIFO());
  assert.ok(existsSync(p.journal));
  // The next run and --restore refuse it too, never opening it to read.
  rmSync(join(p.dir, "notes.txt"));
  spawnSync("mkfifo", [join(p.dir, "notes.txt")]);
  assert.throws(() => restoreJournal(p.dir, p.journal), (e) => e instanceof MutationError && /^notes\.txt could not be put back \(it is no regular file\); its original bytes are in .*, the mutant was "e1": put the file right by hand, then delete the journal$/.test(e.message));
});

test("mutate: a file with another name (a hard link) is not mutated: the write would reach the other name too (round 1)", async () => {
  const p = project();
  const out = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-out-")));
  linkSync(join(p.dir, "notes.txt"), join(out, "twin.txt"));
  const res = await runMutants({ cwd: p.dir, mutants: [m("h1", "notes.txt", "alpha", "beta")], command: `${NODE} check.mjs`, journal: p.journal });
  assert.deepEqual(res.results.map(said), ["unapplied mutate.reason.hardLinked"]);
  assert.equal(readFileSync(join(out, "twin.txt"), "utf8"), "alpha\n");
});

test("mutate: --check gets a file whose name starts with - as ./-name, never as an option (round 1)", async () => {
  const p = project();
  writeFileSync(join(p.dir, "-n.txt"), "alpha\n");
  const res = await runMutants({ cwd: p.dir, mutants: [m("d1", "-n.txt", "alpha", "BAD")], command: `${NODE} -e 0`, check: "cat {file} > /dev/null && grep -qv BAD -- {file}", journal: p.journal });
  assert.deepEqual(res.results.map(said), ["invalid mutate.reason.parse"]);
});

test("mutate: the message names the writers that were running: an edit only, the parse check, the tests (round 2)", async () => {
  // A --check that rewrites the file it reads (a formatter given as the check): the check and the tests ran.
  const p = project();
  writeFileSync(join(p.dir, "fmt.cjs"), `const f = require("fs"); const n = process.argv[2]; f.writeFileSync(n, f.readFileSync(n, "utf8").replace(/ {2,}/g, " "));`);
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("c1", "notes.txt", "alpha", "al  pha")], command: `${NODE} -e 0`, check: `${NODE} fmt.cjs {file}`, journal: p.journal }),
    /^MutationError: notes\.txt changed while mutant "c1" was in it \(an edit, or the parse check or the test command writing it\): /,
  );
  // The file's second mutant: its check ran on the mutant alone, and is named once.
  const r = project();
  writeFileSync(join(r.dir, "fmt.cjs"), readFileSync(join(p.dir, "fmt.cjs")));
  await assert.rejects(
    runMutants({ cwd: r.dir, mutants: [m("c0", "notes.txt", "alpha", "alphb"), m("c1", "notes.txt", "alpha", "al  pha")], command: `${NODE} -e 0`, check: `${NODE} fmt.cjs {file}`, journal: r.journal }),
    /^MutationError: notes\.txt changed while mutant "c1" was in it \(an edit, or the parse check or the test command writing it\): /,
  );
  // A built-in check runs as a read: an edit while it ran is an edit, nothing of the run's.
  const q = project();
  const cp = /** @type {Record<string, any>} */ (childProcess);
  const real = cp.spawnSync;
  let once = true;
  cp.spawnSync = (/** @type {any[]} */ ...args) => {
    if (once && String(args[1]).includes("--check")) {
      once = false;
      writeFileSync(join(q.dir, "src", "add.mjs"), "export const add = (a, b) => a + b; // by hand\nexport const twice = (x) => x * 2;\n");
    }
    return real(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      runMutants({ cwd: q.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: q.journal }),
      /^MutationError: src\/add\.mjs changed while mutant "k1" was being prepared \(an edit\): nothing was written to it; run again$/,
    );
  } finally {
    cp.spawnSync = real;
    syncBuiltinESMExports();
  }
  assert.match(readFileSync(join(q.dir, "src", "add.mjs"), "utf8"), /a \+ b; \/\/ by hand/);
});

test("mutate: a hard link made to the file is never written through: by a put-back, or by --restore (round 2)", async () => {
  const p = project();
  const out = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-out-")));
  const twin = join(out, "twin.txt");
  // The tests give the mutated file a second name outside the project.
  const link = `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) f.linkSync('notes.txt', ${JSON.stringify(JSON.stringify(twin)).slice(1, -1)})"`;
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${link} && ${NODE} check.mjs`, journal: p.journal }),
    /^MutationError: mutant "e1" is left in notes\.txt: it could not be written back \(it has another name \(a hard link\), which a write would reach too\); its original bytes are in /,
  );
  assert.equal(readFileSync(twin, "utf8"), "beta\n", "nothing written to the other name");
  // --restore on the same journal: the same refusal, the other name untouched.
  assert.throws(() => restoreJournal(p.dir, p.journal, { force: true }), /^MutationError: notes\.txt could not be put back \(it has another name \(a hard link\), which a write would reach too\); its original bytes are in .*, the mutant was "e1": put the file right by hand, then delete the journal$/);
  assert.equal(readFileSync(twin, "utf8"), "beta\n");
  assert.ok(existsSync(p.journal));
});

test("mutate: a directory swapped for a link while the file is opened is caught, whether it stays or is swapped back (round 2)", async () => {
  // No test can time the race itself: the open is made to do the swap, so it lands between the look and the open.
  for (const back of [false, true]) {
    const p = project();
    const out = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-out-")));
    writeFileSync(join(out, "x.txt"), "1\n");
    mkdirSync(join(p.dir, "sub"));
    writeFileSync(join(p.dir, "sub", "x.txt"), "1\n");
    const target = join(p.dir, "sub", "x.txt");
    const fs = /** @type {Record<string, any>} */ (await import("node:fs")).default;
    const real = fs.openSync;
    let armed = true;
    fs.openSync = (/** @type {any} */ path, /** @type {any} */ flags, /** @type {any[]} */ ...rest) => {
      if (!(armed && path === target && typeof flags === "number" && flags & fs.constants.O_RDWR)) return real(path, flags, ...rest);
      armed = false;
      fs.renameSync(join(p.dir, "sub"), join(p.dir, "sub.bak"));
      symlinkSync(out, join(p.dir, "sub"));
      const fd = real(path, flags, ...rest);
      if (back) {
        rmSync(join(p.dir, "sub"));
        fs.renameSync(join(p.dir, "sub.bak"), join(p.dir, "sub"));
      }
      return fd;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        runMutants({ cwd: p.dir, mutants: [m("t1", "sub/x.txt", "1", "2")], command: `${NODE} -e 0`, journal: p.journal }),
        back ? /^MutationError: mutant "t1" was not written to sub\/x\.txt \(sub\/x\.txt led to another file while it was opened\): the file is as it was/ : /^MutationError: mutant "t1" was not written to sub\/x\.txt \(sub is a symbolic link\): the file is as it was/,
      );
    } finally {
      fs.openSync = real;
      syncBuiltinESMExports();
    }
    assert.equal(armed, false, "the swap happened");
    assert.equal(readFileSync(join(out, "x.txt"), "utf8"), "1\n", "nothing written outside");
    assert.equal(readFileSync(join(p.dir, back ? "sub" : "sub.bak", "x.txt"), "utf8"), "1\n");
    assert.equal(existsSync(p.journal), false);
  }
});

test("mutate: a file the tests replace with a link is not written through (round 2)", async () => {
  const p = project();
  const out = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-out-")));
  writeFileSync(join(out, "notes.txt"), "outside\n");
  const swap = `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) { f.renameSync('notes.txt', 'notes.bak'); f.symlinkSync(${JSON.stringify(JSON.stringify(join(out, "notes.txt"))).slice(1, -1)}, 'notes.txt'); }"`;
  await assert.rejects(
    runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${swap} && ${NODE} -e 0`, journal: p.journal }),
    /^MutationError: mutant "e1" is left in the file that was at notes\.txt: notes\.txt is a symbolic link, and nothing is written through it; its original bytes are in /,
  );
  assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "outside\n");
  assert.equal(readFileSync(join(p.dir, "notes.bak"), "utf8"), "beta\n");
});

test("mutate: a file replaced by a rename while the mutant is in is judged by its bytes: the original is taken, an edit stops the run (round 2)", async () => {
  // As git checkout or an editor's save does: a new file renamed over the old one, another inode.
  const replace = (/** @type {string} */ text) => `${NODE} -e "const f = require('fs'); if (f.readFileSync('notes.txt', 'utf8').includes('beta')) { f.writeFileSync('notes.new', ${JSON.stringify(JSON.stringify(text)).slice(1, -1)}); f.renameSync('notes.new', 'notes.txt'); }"`;
  const p = project();
  const res = await runMutants({ cwd: p.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${replace("alpha\n")} && ${NODE} check.mjs`, journal: p.journal });
  assert.deepEqual(res.results.map(said), ["survived mutate.reason.noCheck"]);
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
  const q = project();
  await assert.rejects(
    runMutants({ cwd: q.dir, mutants: [m("e1", "notes.txt", "alpha", "beta")], command: `${replace("beta\nby hand\n")} && ${NODE} check.mjs`, journal: q.journal }),
    /^MutationError: notes\.txt changed while mutant "e1" was in it \(an edit, or the test command writing it\): it is left as it is/,
  );
  assert.equal(readFileSync(join(q.dir, "notes.txt"), "utf8"), "beta\nby hand\n");
});

test("mutate: outside a repository the journal is not put under a .git directory", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-norepo-")));
  assert.ok(!journalPath(dir, ".git/ennyn").startsWith(realpathSync(dir)));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.ok(journalPath(dir, "state").startsWith(join(dir, "state")), "a state dir of the project's own is used as is");
  // However a .git value is spelled, outside a repository it goes to the user's own directory, never under ./.git.
  for (const v of ["./.git/ennyn", ".git\\ennyn", ".git"]) assert.ok(!journalPath(dir, v).startsWith(dir), v);
  assert.equal(existsSync(join(dir, ".git")), false);
  // In a linked worktree a .git value goes to the common git dir (".git" is a file there); a work-tree value stays.
  const p = project();
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a"], { cwd: p.dir });
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "en-mut-wt-"))), "wt");
  git(["worktree", "add", "-q", "--detach", wt], { cwd: p.dir });
  assert.equal(dirname(journalPath(wt, "./.git/ennyn")), join(p.dir, ".git", "ennyn"));
  assert.equal(dirname(journalPath(wt, "state")), join(wt, "state"));
});

test("mutate: a journal naming a file in a git directory is refused, and so is a mutant of one (journal-names-git-config)", async () => {
  const p = project();
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a"], { cwd: p.dir });
  const config = readFileSync(join(p.dir, ".git", "config"));
  mkdirSync(join(p.dir, "sub"));
  writeFileSync(join(p.dir, "sub", ".git"), "gitdir: ../.git\n");
  mkdirSync(dirname(p.journal), { recursive: true });
  // The git config with core.fsmonitor added would run a command on the next git call.
  const payload = Buffer.concat([config, Buffer.from("[core]\n\tfsmonitor = touch PWNED\n")]);
  for (const file of [".git/config", ".GIT/config", "sub/.git", "./.git/hooks/../config"]) {
    const now = file === "sub/.git" ? readFileSync(join(p.dir, "sub", ".git")) : config;
    writeFileSync(p.journal, JSON.stringify({ pid: 999999, id: "x", file, original: payload.toString("base64"), mutated: now.toString("base64") }));
    assert.throws(() => restoreJournal(p.dir, p.journal), /names .*, in a git directory: no run here wrote it/, file);
  }
  assert.deepEqual([readFileSync(join(p.dir, ".git", "config")).equals(config), existsSync(join(p.dir, "PWNED"))], [true, false]);
  // A mutant of a git dir's file, by its path or through a link into it, is never applied.
  rmSync(p.journal);
  symlinkSync(join(p.dir, ".git"), join(p.dir, "lnk"));
  const res = await runMutants({ cwd: p.dir, mutants: [m("g1", ".git/config", "[core]", "[core]\n\tfsmonitor = x"), m("g2", "lnk/config", "[core]", "[core]\n\tfsmonitor = x")], command: `${NODE} check.mjs`, journal: p.journal });
  assert.deepEqual(res.results.map((r) => `${r.id} ${r.outcome} ${r.reason?.key}`), ["g1 unapplied mutate.reason.gitDir", "g2 unapplied mutate.reason.gitDir"]);
  assert.ok(readFileSync(join(p.dir, ".git", "config")).equals(config));
});

test("mutate: a journal reached through a symbolic link, or one naming a file through one, writes nothing there", async () => {
  const p = project();
  const away = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-away-")));
  writeFileSync(join(away, "profile"), "export A=1\n");
  // A committed journal under a work-tree state dir naming lnk/profile, lnk a link out (journal-through-link).
  symlinkSync(away, join(p.dir, "lnk"));
  const journal = journalPath(p.dir, "state");
  mkdirSync(dirname(journal), { recursive: true });
  const planted = { pid: 999999, id: "x", file: "lnk/profile", original: Buffer.from("payload\n").toString("base64"), mutated: Buffer.from("export A=1\n").toString("base64") };
  writeFileSync(journal, JSON.stringify(planted));
  assert.throws(() => restoreJournal(p.dir, journal), /names lnk\/profile, and lnk is a symbolic link: nothing is written through it/);
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal }), /lnk is a symbolic link: nothing is written through it/);
  assert.equal(readFileSync(join(away, "profile"), "utf8"), "export A=1\n");
  // The journal itself a link out (state-leaf-link): not read, not removed, nothing written through it.
  writeFileSync(join(away, "journal.json"), JSON.stringify({ ...planted, file: "src/add.mjs" }));
  const linked = journalPath(p.dir, "state2");
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(join(away, "journal.json"), linked);
  assert.throws(() => restoreJournal(p.dir, linked), /could not be read: state2\/mutate-[0-9a-f]{12}\.json is a symbolic link/);
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: linked }), /is a symbolic link/);
  // Its directory a link out: the run takes no journal there.
  symlinkSync(away, join(p.dir, "state3"));
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: journalPath(p.dir, "state3") }), /state3 is a symbolic link/);
  assert.deepEqual([readdirSync(away).sort(), readFileSync(join(away, "profile"), "utf8")], [["journal.json", "profile"], "export A=1\n"]);
  assert.deepEqual(p.snapshot(), p.before);
});

test("mutate: a per-user directory another user could write to is refused before a journal in it is read", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-norepo-")));
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  const journal = journalPath(dir, ".git/ennyn");
  mkdirSync(dirname(journal), { recursive: true });
  chmodSync(dirname(journal), 0o777);
  try {
    await assert.rejects(runMutants({ cwd: dir, mutants: [m("k1", "a.mjs", "= 1", "= 2")], command: `${NODE} -e 0`, journal }), (e) => e instanceof MutationError && /is not this user's alone \(owner \d+, mode 777\)/.test(e.message));
    assert.throws(() => restoreJournal(dir, journal), /is not this user's alone/);
  } finally {
    chmodSync(dirname(journal), 0o700);
  }
});

test("mutate: a journal that names a file outside the tree is refused, and that file is left alone", async () => {
  const p = project();
  const outside = join(dirname(p.dir), `outside-${Date.now()}.txt`);
  writeFileSync(outside, "mine\n");
  mkdirSync(dirname(p.journal), { recursive: true });
  const planted = { pid: 999999, id: "x", file: outside, original: Buffer.from("planted\n").toString("base64"), mutated: Buffer.from("mine\n").toString("base64") };
  writeFileSync(p.journal, JSON.stringify(planted));
  await assert.rejects(runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b")], command: `${NODE} check.mjs`, journal: p.journal }), /names .*outside this tree: no run here wrote it/);
  writeFileSync(p.journal, JSON.stringify({ ...planted, file: "../escape.txt" }));
  assert.throws(() => restoreJournal(p.dir, p.journal), /outside this tree/);
  assert.equal(readFileSync(outside, "utf8"), "mine\n");
});

test("mutate: outside a repository the journal's directory is this user's alone (0700)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-mut-norepo-")));
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  const journal = journalPath(dir, ".git/ennyn");
  const res = await runMutants({ cwd: dir, mutants: [m("k1", "a.mjs", "= 1", "= 2")], command: `${NODE} -e 0`, journal });
  assert.deepEqual(res.results.map((r) => r.outcome), ["survived"]);
  assert.equal(statSync(dirname(journal)).mode & 0o777, 0o700);
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
    const started = performance.now();
    // Two commands: the shell forks the test process instead of becoming it, so killing the shell alone would leave it.
    const res = await runMutants({ cwd: p.dir, mutants: [m("t1", "data.json", '"limit": 3', '"limit": 3, "sleep": 1')], command: `${NODE} check.mjs && true`, journal: p.journal, timeoutMs: 1500 });
    assert.ok(performance.now() - started < 45_000, "the run ends at the timeouts, not when the test process would (60 s)");
    assert.deepEqual(res.results.map(said), ["timeout"]);
    assert.deepEqual(summarizeMutants(res.results), { killed: 1, total: 1, timeout: 1, survived: 0, invalid: 0, unapplied: 0, unchecked: 0, uncheckedSurvived: 0 });
    assert.ok(await gone(Number(readFileSync(join(p.dir, "sleeping"), "utf8"))), "the sleeping test process is gone");
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
    // The 4.5 s nap passes the 4 s timeout and leaves node 3.5 s to start under the doubled one; a 2.5 s nap against
    // 2 s and 4 s ran out the second timeout on a loaded 2-CPU Linux VM and on macOS.
    const res = await runMutants({ cwd: p.dir, mutants: [m("n1", "notes.txt", "alpha", "alpha nap")], command: `${NODE} check.mjs`, journal: p.journal, timeoutMs: 4000 });
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
  const real = fs.futimesSync;
  fs.futimesSync = () => {
    throw Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" });
  };
  syncBuiltinESMExports();
  try {
    const res = await runMutants({ cwd: p.dir, mutants: [m("k1", "src/add.mjs", "a + b", "a - b"), m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `${NODE} check.mjs`, journal: p.journal });
    assert.deepEqual(res.results.map(said), ["killed", "survived"]);
  } finally {
    fs.futimesSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(p.snapshot(), p.before);
  assert.equal(existsSync(p.journal), false);
});

test("mutate: what a test run leaves running is stopped before the next mutant", async () => {
    const p = project();
    const started = performance.now();
    const res = await runMutants({ cwd: p.dir, mutants: [m("s1", "src/add.mjs", "x * 2", "x * 3")], command: `sleep 30 & echo $! > leftover.pid; ${NODE} check.mjs`, journal: p.journal });
    assert.equal(res.results[0].outcome, "survived");
    assert.ok(performance.now() - started < 25_000, "the left-behind process holds the pipes; the run does not wait for it (30 s)");
    assert.ok(await gone(Number(readFileSync(join(p.dir, "leftover.pid"), "utf8"))));
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
    assert.deepEqual(await closed, { code: 141, signal: null }, "a run cut short is no pass");
    assert.deepEqual(p.snapshot(), p.before);
    assert.equal(existsSync(p.journal), false);
  });


  test("cli: a signal mid-run stops the tests, puts the file back and drops the journal", async () => {
    const p = project();
    writeFileSync(p.list, JSON.stringify([m("t1", "notes.txt", "alpha", "alpha sleep")]));
    const child = spawn(process.execPath, [CLI, "mutate", p.list, "--command", `${NODE} check.mjs`], { cwd: p.dir, stdio: "ignore" });
    const closed = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    // Wait until the mutant is in place and its test process has started.
    const testPid = await pidIn(join(p.dir, "sleeping"));
    child.kill("SIGINT");
    assert.deepEqual(await closed, { code: null, signal: "SIGINT" });
    assert.equal(readFileSync(join(p.dir, "notes.txt"), "utf8"), "alpha\n");
    assert.equal(existsSync(p.journal), false);
    assert.ok(await gone(testPid));
    assert.deepEqual(readdirSync(dirname(p.journal)), []);
  });


  for (const closedErr of [false, true]) {
    test(`cli: a signal after an edit to the mutated file leaves the edit and the journal, saying so once, escaped${closedErr ? "; with stderr closed it still ends by the signal" : ""}`, async () => {
      const p = project();
      // A name with a terminal escape in it: what the exit handler says is escaped as the CLI escapes the rest.
      const odd = join(p.dir, "odd\u001b[2Jname.txt");
      writeFileSync(odd, "alpha\n");
      writeFileSync(p.list, JSON.stringify([m("t1", "odd\u001b[2Jname.txt", "alpha", "beta")]));
      const command = `${NODE} -e "const f = require('fs'); const n = f.readdirSync('.').find((x) => x.startsWith('odd')); if (f.readFileSync(n, 'utf8').includes('beta')) { f.writeFileSync('sleeping', String(process.pid)); setTimeout(() => {}, 60000); }"`;
      const child = spawn(process.execPath, [CLI, "mutate", p.list, "--command", command], { cwd: p.dir, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const closed = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
      const testPid = await pidIn(join(p.dir, "sleeping"));
      writeFileSync(odd, "beta\nby hand\n");
      if (closedErr) child.stderr.destroy();
      child.kill("SIGINT");
      assert.deepEqual(await closed, { code: null, signal: "SIGINT" });
      assert.equal(readFileSync(odd, "utf8"), "beta\nby hand\n");
      assert.equal(Buffer.from(JSON.parse(readFileSync(p.journal, "utf8")).original, "base64").toString(), "alpha\n");
      if (!closedErr) assert.match(stderr, /^odd\\u001b\[2Jname\.txt changed while mutant "t1" was in it \(an edit, or the test command writing it\): it is left as it is, the mutant with it; its original bytes are in .* \(base64\): take the mutant out by hand, then delete the journal\n$/);
      assert.ok(await gone(testPid));
    });
  }


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
