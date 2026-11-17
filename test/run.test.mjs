// The suite's concurrency: fed counts and cgroup text by hand, never this machine's (test/run.mjs reads those).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OVERRIDE, TALLY, concurrency, containerCpus, nodeReporter, readMachine, runPassingStops, tallyArgs, unfinished, wholeArgs } from "./run.mjs";

test("concurrency: half the physical cores, at least 1", () => {
  assert.deepEqual(concurrency({ physical: 10, logical: 10 }), { n: 5, why: "half the 10 physical cores" });
  assert.equal(concurrency({ physical: 10, logical: 20 }).n, 5);
  assert.equal(concurrency({ physical: 7, logical: 14 }).n, 3);
  assert.equal(concurrency({ physical: 2, logical: 4 }).n, 1);
  assert.equal(concurrency({ physical: 1, logical: 1 }).n, 1);
});

test("concurrency: a quarter of the logical CPUs where the physical count could not be read, at least 1", () => {
  assert.deepEqual(concurrency({ physical: null, logical: 20 }), { n: 5, why: "a quarter of the 20 logical CPUs: the physical count could not be read" });
  assert.equal(concurrency({ physical: null, logical: 23 }).n, 5);
  assert.equal(concurrency({ physical: null, logical: 3 }).n, 1);
  assert.equal(concurrency({ physical: 0, logical: 16 }).n, 4);
  assert.equal(concurrency({ physical: NaN, logical: 16 }).n, 4);
  assert.equal(concurrency({ physical: 6.5, logical: 16 }).n, 4);
});

test("concurrency: in a container, half the CPUs it may use when that is smaller", () => {
  // cgroup v2: cpu.max is "<quota> <period>", or "max <period>" with no quota.
  assert.deepEqual(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "400000 100000\n" } }), { n: 2, why: "half the 4 CPUs the container may use" });
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "max 100000\n" } }).n, 5);
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "150000 100000\n" } }).n, 1);
  // A container allowed more than half the host's cores leaves the host's number.
  assert.deepEqual(concurrency({ physical: 4, logical: 8, cgroup: { cpuMax: "800000 100000" } }), { n: 2, why: "half the 4 physical cores" });
  // Equal, the host's reason stands.
  assert.deepEqual(concurrency({ physical: 4, logical: 8, cgroup: { cpuset: "0-3" } }), { n: 2, why: "half the 4 physical cores" });
  // cgroup v1: -1 is no quota.
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { quota: "200000\n", period: "100000\n" } }).n, 1);
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { quota: "-1\n", period: "100000\n" } }).n, 5);
  // The cpuset alone, and the smaller of the two.
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuset: "0-3\n" } }).n, 2);
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "600000 100000", cpuset: "0-1,4-5\n" } }).n, 2);
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "200000 100000", cpuset: "0-7" } }).n, 1);
  // Over the fallback too.
  assert.deepEqual(concurrency({ physical: null, logical: 64, cgroup: { cpuset: "0-5" } }), { n: 3, why: "half the 6 CPUs the container may use" });
});

test("concurrency: cgroup text that is not a limit limits nothing", () => {
  assert.equal(containerCpus({}), null);
  assert.equal(containerCpus({ cpuMax: "max 100000" }), null);
  assert.equal(containerCpus({ cpuMax: "" }), null);
  assert.equal(containerCpus({ cpuMax: "0 100000" }), null);
  assert.equal(containerCpus({ cpuMax: "abc 100000" }), null);
  assert.equal(containerCpus({ cpuMax: "200000" }), null);
  assert.equal(containerCpus({ cpuMax: "1e5 100000" }), null);
  assert.equal(containerCpus({ cpuMax: "100000 1e5" }), null);
  assert.equal(containerCpus({ quota: "200000", period: null }), null);
  assert.equal(containerCpus({ quota: "200000", period: "0" }), null);
  assert.equal(containerCpus({ cpuset: "3-1" }), null);
  assert.equal(containerCpus({ cpuset: "0-3,x" }), null);
  assert.equal(containerCpus({ cpuMax: "250000 100000" }), 2.5);
  assert.equal(containerCpus({ cpuset: "0,2,4-6" }), 5);
  // v2 wins over v1 files when both are there.
  assert.equal(containerCpus({ cpuMax: "max 100000", quota: "100000", period: "100000" }), null);
});

test("concurrency: the override wins when it is a positive integer, and anything else is refused", () => {
  assert.deepEqual(concurrency({ physical: 10, logical: 10, env: "7" }), { n: 7, why: `${OVERRIDE}=7` });
  assert.equal(concurrency({ physical: 10, logical: 10, cgroup: { cpuMax: "100000 100000" }, env: "12" }).n, 12);
  for (const bad of ["", "0", "-2", "1.5", " 3", "3 ", "03", "x", "1e3", "99999999999999999999"]) {
    assert.throws(() => concurrency({ physical: 10, logical: 10, env: bad }), new RegExp(`^Error: ${OVERRIDE} must be a positive integer`), JSON.stringify(bad));
  }
});

test("concurrency: the machine is read on macOS from sysctl, on Linux from sysfs and the cgroup files", () => {
  /** @type {string[][]} */
  const ran = [];
  const mac = readMachine({ platform: "darwin", logical: 10, run: (c, a) => (ran.push([c, ...a]), "10\n"), read: () => assert.fail("macOS reads no file") });
  assert.deepEqual(mac, { physical: 10, logical: 10, cgroup: {} });
  assert.deepEqual(ran, [["sysctl", "-n", "hw.physicalcpu"]]);
  assert.equal(readMachine({ platform: "darwin", logical: 8, run: () => null }).physical, null);
  assert.equal(readMachine({ platform: "darwin", logical: 8, run: () => "eight\n" }).physical, null);
  assert.equal(readMachine({ platform: "darwin", logical: 8, run: () => "0\n" }).physical, null);
  assert.deepEqual(readMachine({ platform: "win32", logical: 8, run: () => "4", read: () => "0" }), { physical: null, logical: 8, cgroup: {} });
  assert.deepEqual(readMachine({ platform: "freebsd", logical: 8, run: () => "4", read: () => "0" }), { physical: null, logical: 8, cgroup: {} });

  // Two threads a core, two packages: 8 CPUs online, 4 cores.
  const topology = { 0: "0 0", 1: "0 0", 2: "0 1", 3: "0 1", 4: "1 0", 5: "1 0", 6: "1 1", 7: "1 1" };
  /** @param {Record<string, string | null>} extra */
  const linux = (extra) => {
    /** @type {Record<string, string | null>} */
    const files = { "/sys/devices/system/cpu/online": "0-7\n", ...extra };
    for (const [cpu, ids] of Object.entries(topology)) {
      const [pkg, core] = ids.split(" ");
      const at = `/sys/devices/system/cpu/cpu${cpu}/topology`;
      if (!(`${at}/physical_package_id` in files)) files[`${at}/physical_package_id`] = `${pkg}\n`;
      if (!(`${at}/core_id` in files)) files[`${at}/core_id`] = `${core}\n`;
    }
    return (/** @type {string} */ path) => files[path] ?? null;
  };
  const run = () => assert.fail("Linux runs no program");
  assert.deepEqual(readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/fs/cgroup/cpu.max": "200000 100000\n", "/sys/fs/cgroup/cpuset.cpus.effective": "0-7\n" }) }), {
    physical: 4,
    logical: 8,
    cgroup: { cpuMax: "200000 100000\n", quota: null, period: null, cpuset: "0-7\n" },
  });
  const v1 = readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "100000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n", "/sys/fs/cgroup/cpuset/cpuset.effective_cpus": "0-3\n" }) });
  assert.deepEqual(v1.cgroup, { cpuMax: null, quota: "100000\n", period: "100000\n", cpuset: "0-3\n" });
  assert.equal(concurrency(v1).n, 1);
  // A core id that cannot be read, or no list of online CPUs, is no physical count.
  assert.equal(readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/devices/system/cpu/cpu5/topology/core_id": null }) }).physical, null);
  assert.equal(readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/devices/system/cpu/online": null }) }).physical, null);
  assert.equal(readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/devices/system/cpu/online": "\n" }) }).physical, null);
  // Only the online CPUs count.
  assert.equal(readMachine({ platform: "linux", logical: 8, run, read: linux({ "/sys/devices/system/cpu/online": "0-1\n" }) }).physical, 1);
});

test("concurrency: the whole suite loads the hermetic setup into every test file under the limit", () => {
  assert.deepEqual(wholeArgs(3), ["--test", "--test-concurrency=3", "--import", "./test/hermetic.mjs", "test/*.test.mjs"]);
});

/** npm test's runner and the reporter it counts with, in a folder of its own. @param {string} prefix */
function runnerCopy(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "test"));
  copyFileSync(fileURLToPath(new URL("./run.mjs", import.meta.url)), join(dir, "test", "run.mjs"));
  copyFileSync(fileURLToPath(new URL("./tally.mjs", import.meta.url)), join(dir, "test", "tally.mjs"));
  return dir;
}

test("concurrency: npm test's runner says its limit, passes the suite's exit on, and runs nothing on a refused override", () => {
  // The runner in a folder of its own, with a setup and test files of its own.
  const dir = runnerCopy("en-run-");
  writeFileSync(join(dir, "test", "hermetic.mjs"), "globalThis.SETUP = true;\n");
  writeFileSync(join(dir, "test", "a.test.mjs"), 'import { test } from "node:test";\ntest("a ran", () => { if (!globalThis.SETUP) throw new Error("no setup"); });\n');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [OVERRIDE]: "2" };
  // Under node --test this says "report to a parent": the run inside would exit 0 whatever it found.
  delete env.NODE_TEST_CONTEXT;
  const run = (/** @type {NodeJS.ProcessEnv} */ more) => spawnSync(process.execPath, [join(dir, "test", "run.mjs")], { cwd: tmpdir(), env: { ...env, ...more }, encoding: "utf8" });
  const good = run({});
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(good.stdout.split(`test concurrency 2: ${OVERRIDE}=2\n`).length - 1, 1, good.stdout);
  // Node's summary: TAP off a terminal through Node 22, spec from Node 23 (test:linux runs Node 24).
  assert.match(good.stdout, /^(?:#|ℹ) pass 1$/m);

  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("b fails", () => { throw new Error("no"); });\n');
  const bad = run({});
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^(?:#|ℹ) fail 1$/m);

  // The runner's node killed under it: no exit code, and that is no pass.
  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("the runner dies", () => { process.kill(process.ppid, "SIGKILL"); });\n');
  const killed = run({});
  // As a shell reads a signal's end: 128 plus SIGKILL's 9.
  assert.equal(killed.status, 137, killed.stdout + killed.stderr);
  assert.match(killed.stderr, /^the suite did not finish: SIGKILL$/m);

  // node not started at all: a stand-in spawn sends it to a folder that is not there. No exit code, and that is no pass.
  const preload = join(dir, "no-start.mjs");
  writeFileSync(
    preload,
    'import { createRequire, syncBuiltinESMExports } from "node:module";\nconst cp = createRequire(process.execPath)("node:child_process");\nconst real = cp.spawn;\ncp.spawn = (file, args, options) => real(file, args, { ...options, cwd: process.env.EN_NO_DIR });\nsyncBuiltinESMExports();\n',
  );
  const unstarted = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(dir, "test", "run.mjs")], { cwd: tmpdir(), env: { ...env, EN_NO_DIR: join(dir, "not-here") }, encoding: "utf8" });
  assert.equal(unstarted.status, 1, unstarted.stdout + unstarted.stderr);
  assert.match(unstarted.stderr, /^the suite did not start: .*ENOENT$/m);

  const refused = run({ [OVERRIDE]: "many" });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(refused.stderr, `${OVERRIDE} must be a positive integer, not "many"\n`);
  assert.equal(refused.stdout, "", "nothing ran");
});

test("concurrency: a run through the runner ends as spawnSync says, and leaves no stop handler behind", async () => {
  const STOPS = /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]);
  const before = STOPS.map((s) => process.listenerCount(s));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.deepEqual(await runPassingStops(["-e", "process.exit(3)"], { cwd: tmpdir(), env }), { status: 3, signal: null, error: undefined, stop: null });
  // A second run in the same process, as test/short.mjs makes: the first run's handlers are gone.
  const killed = await runPassingStops(["-e", 'process.kill(process.pid, "SIGKILL")'], { cwd: tmpdir(), env });
  assert.deepEqual([killed.status, killed.signal, killed.stop], [null, "SIGKILL", null]);
  const missing = await runPassingStops(["-e", "0"], { cwd: join(tmpdir(), "en-run-no-such-folder"), env });
  assert.equal(missing.status, null);
  assert.match(String(missing.error?.message), /ENOENT/);
  assert.deepEqual(STOPS.map((s) => process.listenerCount(s)), before);
});

test("count: node's own report stays as it was: spec on a terminal and TAP elsewhere through Node 22, spec from Node 23", () => {
  assert.equal(nodeReporter(false, "22.23.4"), "tap");
  assert.equal(nodeReporter(false, "22.0.0"), "tap");
  assert.equal(nodeReporter(true, "22.0.0"), "spec");
  assert.equal(nodeReporter(false, "23.0.0"), "spec");
  assert.equal(nodeReporter(false, "24.11.1"), "spec");
  assert.deepEqual(tallyArgs("/t/tally.json", false).slice(0, 4), ["--test-reporter", nodeReporter(false), "--test-reporter-destination", "stdout"]);
  assert.deepEqual(tallyArgs("/t/tally.json", true).slice(4), ["--test-reporter", TALLY, "--test-reporter-destination", "/t/tally.json"]);
  assert.match(TALLY, /^file:.*\/test\/tally\.mjs$/);
});

test("count: a tally that is missing, not JSON or not of its shape is no whole run; read by summaries where they came, else by queued tests", () => {
  const unread = /^the count of tests could not be read \(.+\), so the run is not taken as whole$/;
  const shape = { version: 2, summaries: true, files: {}, paths: {} };
  const bad = [
    null,
    "",
    "{",
    "[]",
    "null",
    { ...shape, version: 1 },
    { ...shape, summaries: undefined },
    { ...shape, files: [] },
    { ...shape, paths: null },
    { ...shape, files: { a: { name: "a", bare: false } } },
    { ...shape, files: { a: { name: "a", summary: null } } },
    { ...shape, files: { a: { name: "a", summary: { tests: 1 }, bare: false } } },
    { ...shape, files: { a: { name: "a", summary: { tests: 1, topLevel: -1 }, bare: false } } },
    { ...shape, paths: { a: { name: "a", queued: ["x"] } } },
    { ...shape, paths: { a: { name: "a", queued: [1], ended: [1] } } },
  ];
  for (const t of bad) {
    const text = t === null || typeof t === "string" ? t : JSON.stringify(t);
    const said = unfinished(text);
    assert.equal(said.length, 1, String(text));
    assert.match(said[0], unread, String(text));
  }
  /** @param {boolean} summaries @param {Record<string, { tests: number, topLevel: number } | null>} files @param {Record<string, { queued: string[], ended: string[] }>} [paths] @param {string[]} [bare] */
  const tally = (summaries, files, paths = {}, bare = []) =>
    JSON.stringify({
      version: 2,
      summaries,
      files: Object.fromEntries(Object.entries(files).map(([name, summary]) => [`/r/${name}`, { name, summary, bare: bare.includes(name) }])),
      paths: Object.fromEntries(Object.entries(paths).map(([name, p]) => [`/r/${name}`, { name, ...p }])),
    });
  // Summaries came: each file the run started sent one, with a test in it. What the queued tests say does not count.
  const cut = { "test/helper.mjs": { queued: ["x", "y"], ended: ["x"] } };
  assert.deepEqual(unfinished(tally(true, {})), []);
  assert.deepEqual(unfinished(tally(true, { "test/a.test.mjs": { tests: 3, topLevel: 2 } }, cut)), []);
  assert.deepEqual(unfinished(tally(true, { "test/a.test.mjs": null, "test/b.test.mjs": { tests: 0, topLevel: 0 }, "test/c.test.mjs": { tests: 1, topLevel: 1 } })), [
    "test/a.test.mjs: its process ended before its run did (it sent no summary), so the tests after the last one reported never ran or never reported",
    "test/b.test.mjs: it ran no test (none was registered, or none matched)",
  ]);
  // None came (Node before 22.12): each top-level test queued, by the path node names it with, ended; a name used
  // twice too. And no file node passed itself, which it does only for a file that reported no test.
  assert.deepEqual(unfinished(tally(false, { "test/a.test.mjs": null }, { "test/a.test.mjs": { queued: ["x", "x", "y"], ended: ["y", "x", "x"] } })), []);
  assert.deepEqual(unfinished(tally(false, {}, { "test/a.test.mjs": { queued: ["x", "x", "y"], ended: ["x", "y"] } })), ['test/a.test.mjs: 2 of 3 tests reported; its process ended before "x"']);
  assert.deepEqual(unfinished(tally(false, {}, { "test/a.test.mjs": { queued: ["x", "y", "z"], ended: ["x"] }, "test/b.test.mjs": { queued: [], ended: [] } })), [
    'test/a.test.mjs: 1 of 3 tests reported; its process ended before "y" and 1 more',
  ]);
  assert.deepEqual(unfinished(tally(false, { "test/a.test.mjs": null, "test/z.test.mjs": null }, {}, ["test/z.test.mjs"])), ["test/z.test.mjs: it ran no test (none was registered, or none matched)"]);
  // Where summaries came, a summary says it: the file's own pass changes nothing.
  assert.deepEqual(unfinished(tally(true, { "test/a.test.mjs": { tests: 1, topLevel: 1 } }, {}, ["test/a.test.mjs"])), []);
});

test("count: the tally keeps each started file's own summary, and each top-level test queued and ended by the path node names", async () => {
  const { default: tally } = await import(TALLY);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-run-tally-")));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "c.mjs"), "");
  symlinkSync(join(dir, "c.mjs"), join(dir, "test", "c.test.mjs"));
  const at = (/** @type {string} */ f) => join(dir, f);
  // As node --test sends them (labs: Node 22.23.4 on macOS, 22.0.0, 22.23.5 and 24 in containers; 22.0.0 sends no
  // test:summary): its own test per file, named by the path it was given, then each file's tests by their own path.
  const events = [
    { type: "test:enqueue", data: { nesting: 0, name: "test/a.test.mjs", file: at("test/a.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "test/c.test.mjs", file: at("test/c.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "test/z.test.mjs", file: at("test/z.test.mjs") } },
    // Node passes its own test for a file only when the file reported no test (22.0.0, 22.9.0, 22.23.5). It fails
    // it when the file's process failed outside its tests, as a file that does not load: node's exit already says so.
    { type: "test:pass", data: { nesting: 0, name: "test/z.test.mjs", file: at("test/z.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "test/f.test.mjs", file: at("test/f.test.mjs") } },
    { type: "test:fail", data: { nesting: 0, name: "test/f.test.mjs", file: at("test/f.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "x", file: at("test/a.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 1, name: "inner", file: at("test/a.test.mjs") } },
    { type: "test:pass", data: { nesting: 1, name: "inner", file: at("test/a.test.mjs") } },
    { type: "test:pass", data: { nesting: 0, name: "x", file: at("test/a.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "y", file: at("test/a.test.mjs") } },
    { type: "test:fail", data: { nesting: 0, name: "y", file: at("test/a.test.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "z", file: at("test/helper.mjs") } },
    { type: "test:enqueue", data: { nesting: 0, name: "linked", file: at("c.mjs") } },
    { type: "test:pass", data: { nesting: 0, name: "linked", file: at("c.mjs") } },
  ];
  const summary = (/** @type {string | undefined} */ file, /** @type {number} */ n) => ({ type: "test:summary", data: { file, counts: { tests: n + 1, topLevel: n } } });
  /** @param {object[]} list */
  const read = async (list) => {
    let out = "";
    for await (const chunk of tally((async function* () {
      yield* list;
    })())) out += chunk;
    return JSON.parse(out);
  };
  // node --test names its own test for each file relative to where the run started.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const old = await read(events);
    assert.equal(old.summaries, false);
    assert.deepEqual(Object.values(old.files), [
      { name: "test/a.test.mjs", summary: null, bare: false },
      { name: "test/c.test.mjs", summary: null, bare: false },
      { name: "test/z.test.mjs", summary: null, bare: true },
      { name: "test/f.test.mjs", summary: null, bare: false },
    ]);
    assert.deepEqual(unfinished(JSON.stringify(old)), ['test/z.test.mjs: it ran no test (none was registered, or none matched)', 'test/helper.mjs: 0 of 1 tests reported; its process ended before "z"']);
    assert.deepEqual(Object.values(old.paths), [
      { name: "test/a.test.mjs", queued: ["x", "y"], ended: ["x", "y"] },
      { name: "test/helper.mjs", queued: ["z"], ended: [] },
      { name: "c.mjs", queued: ["linked"], ended: ["linked"] },
    ]);
    // The link's summary comes by the link's name, here relative to where the run started.
    const now = await read([...events, summary(at("test/a.test.mjs"), 2), summary("test/c.test.mjs", 1), summary(at("test/z.test.mjs"), 1), summary(undefined, 3)]);
    assert.equal(now.summaries, true);
    assert.deepEqual(Object.values(now.files), [
      { name: "test/a.test.mjs", summary: { tests: 3, topLevel: 2 }, bare: false },
      { name: "test/c.test.mjs", summary: { tests: 2, topLevel: 1 }, bare: false },
      { name: "test/z.test.mjs", summary: { tests: 2, topLevel: 1 }, bare: true },
      { name: "test/f.test.mjs", summary: null, bare: false },
    ]);
    // The file that did not load sent none: node failed the run already, and the count says the same.
    assert.deepEqual(unfinished(JSON.stringify(now)), ["test/f.test.mjs: its process ended before its run did (it sent no summary), so the tests after the last one reported never ran or never reported"]);
    // The run's own summary alone: the files sent none.
    const cut = await read([...events, summary(undefined, 3)]);
    assert.equal(cut.summaries, true);
    assert.equal(unfinished(JSON.stringify(cut)).length, 4);
  } finally {
    process.chdir(cwd);
  }
});

/** Whether this Node's test files send a summary of their own (Node 22.0.0's do not), by a reporter of this test's own. */
function summariesCome() {
  const dir = mkdtempSync(join(tmpdir(), "en-run-summary-"));
  writeFileSync(join(dir, "x.test.mjs"), 'import { test } from "node:test";\ntest("x", () => {});\n');
  writeFileSync(join(dir, "seen.mjs"), 'export default async function* (source) {\n  let seen = false;\n  for await (const { type, data } of source) if (type === "test:summary" && typeof data?.file === "string") seen = true;\n  yield String(seen);\n}\n');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter", pathToFileURL(join(dir, "seen.mjs")).href, "--test-reporter-destination", "stdout", "x.test.mjs"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^(?:true|false)$/);
  return r.stdout === "true";
}

test("count: a run where a test file's process ends at exit 0 before its tests do fails, and says which file", () => {
  const summaries = summariesCome();
  const dir = runnerCopy("en-run-count-");
  writeFileSync(join(dir, "test", "hermetic.mjs"), "");
  const two = 'import { test } from "node:test";\ntest("same name", () => {});\ntest("same name", () => {});\n';
  writeFileSync(join(dir, "test", "a.test.mjs"), two);
  // A test file that is a link: node --test names the link, the test's own place is the file it reaches.
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "c.mjs"), 'import { test } from "node:test";\ntest("linked", () => {});\n');
  symlinkSync(join("..", "elsewhere", "c.mjs"), join(dir, "test", "c.test.mjs"));
  // Tests a shared helper registers for a test file: node names them by the helper's path.
  writeFileSync(join(dir, "test", "helper.mjs"), 'import { test } from "node:test";\nexport const both = () => { test("from the helper", () => {}); test("from the helper too", () => {}); };\n');
  writeFileSync(join(dir, "test", "h.test.mjs"), 'import { both } from "./helper.mjs";\nboth();\n');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [OVERRIDE]: "2" };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [join(dir, "test", "run.mjs")], { cwd: tmpdir(), env, encoding: "utf8" });
  const whole = run();
  assert.equal(whole.status, 0, whole.stdout + whole.stderr);
  assert.doesNotMatch(whole.stderr, /not every test ran/);
  // Node's own report, as before: TAP off a terminal (Node 22), spec from Node 23.
  assert.match(whole.stdout, /^(?:#|ℹ) pass 5$/m);

  // The second of three tests ends its file's process at exit 0: node --test passes the file. A subtest is no test of
  // the file's: the count is of the tests the file itself registered.
  const cut = 'import { test } from "node:test";\ntest("first", async (t) => { await t.test("inner", () => {}); });\ntest("second", () => new Promise(() => setTimeout(() => process.exit(0), 50)));\ntest("third", () => {});\n';
  writeFileSync(join(dir, "test", "b.test.mjs"), cut);
  const bare = spawnSync(process.execPath, ["--test", "test/b.test.mjs"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(bare.status, 0, "node --test alone passes the file that ended early");
  const short = run();
  assert.equal(short.status, 1, short.stdout + short.stderr);
  const said = summaries ? /^not every test ran: test\/b\.test\.mjs: its process ended before its run did \(it sent no summary\)/m : /^not every test ran: test\/b\.test\.mjs: [01] of 3 tests reported; its process ended before "(?:first|second)" and [12] more$/m;
  assert.match(short.stderr, said);
  assert.equal(short.stderr.match(/^not every test ran/gm)?.length, 1, "only the file that ended early is named");

  // A process that ends before it registers a test fails the run on every Node: by its missing summary, or where
  // none come (before 22.12) because node passes the file itself, which it does only for a file that reported no test.
  for (const [text, label] of [
    ["process.exit(0);\n", "at once"],
    ["await new Promise((r) => setTimeout(r, 20));\nprocess.exit(0);\n", "after a top-level await"],
  ]) {
    writeFileSync(join(dir, "test", "b.test.mjs"), text);
    const none = run();
    assert.equal(none.status, 1, `${label}: ${none.stdout}${none.stderr}`);
    assert.match(none.stderr, summaries ? /^not every test ran: test\/b\.test\.mjs: its process ended before its run did/m : /^not every test ran: test\/b\.test\.mjs: it ran no test /m, label);
  }
  // One that ends after a top-level await, before the rest of its tests: where files send summaries the run fails;
  // where none come, every test queued ended, and the run passes (the limit test/tally.mjs states).
  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("early", () => {});\nawait new Promise((r) => setTimeout(r, 50));\nprocess.exit(0);\ntest("late", () => {});\n');
  const late = run();
  assert.equal(late.status, summaries ? 1 : 0, late.stdout + late.stderr);
  if (summaries) assert.match(late.stderr, /^not every test ran: test\/b\.test\.mjs: its process ended before its run did/m);

  // A name pattern that matches no test, as test:short's run of guards' accounting test is made: no run, on every Node.
  rmSync(join(dir, "test", "b.test.mjs"));
  // runCounted in a process of its own: the run under it writes its report on that process's stdout.
  const counted = (/** @type {string} */ pattern) => {
    const script = `import { runCounted } from ${JSON.stringify(pathToFileURL(join(dir, "test", "run.mjs")).href)};\nconst r = await runCounted(["--test", ${JSON.stringify(`--test-name-pattern=${pattern}`)}, "test/a.test.mjs"], { cwd: ${JSON.stringify(dir)} });\nconsole.log("counted " + JSON.stringify([r.status, r.unfinished]));\n`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: tmpdir(), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(/** @type {string} */ (/^counted (.*)$/m.exec(r.stdout)?.[1]));
  };
  assert.deepEqual(counted("^no test has this name$"), [1, ["test/a.test.mjs: it ran no test (none was registered, or none matched)"]]);
  assert.deepEqual(counted("^same name$"), [0, []]);

  // A failing run keeps node's exit, and says nothing of the count.
  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("fails", () => { throw new Error("no"); });\n');
  const failed = run();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.doesNotMatch(failed.stderr, /not every test ran/);
});

/** Whether a process this test started is still there (signal 0 only). @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to `ms` for `done()`, reading every 50 ms. @param {() => boolean} done @param {number} ms */
async function until(done, ms) {
  const start = performance.now();
  while (!done() && performance.now() - start < ms) await new Promise((r) => setTimeout(r, 50));
  return done();
}

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) {
  test(`concurrency: npm test's runner stopped by ${signal} stops the suite under it`, async () => {
    // npm passes a stop on to the script's process: the runner. The suite under it must not run on.
    const dir = runnerCopy("en-run-stop-");
    writeFileSync(join(dir, "test", "hermetic.mjs"), "");
    const started = join(dir, "started");
    writeFileSync(join(dir, "test", "a.test.mjs"), `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("waits", async () => { writeFileSync(${JSON.stringify(started)}, String(process.pid)); await new Promise((r) => setTimeout(r, 120000)); });\n`);
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, [OVERRIDE]: "1" };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn(process.execPath, [join(dir, "test", "run.mjs")], { cwd: dir, env, stdio: "ignore" });
    const ended = new Promise((done) => runner.on("close", (code, sig) => done({ code, sig })));
    let file = 0;
    try {
      assert.ok(await until(() => existsSync(started) && readFileSync(started, "utf8") !== "", 60000), "the test file started");
      file = Number(readFileSync(started, "utf8"));
      runner.kill(signal);
      const { code } = /** @type {{ code: number | null }} */ (await ended);
      assert.notEqual(code, 0, "a stopped suite is no pass");
      assert.ok(await until(() => !alive(file), 30000), `the test file ${file} runs on after the runner was stopped`);
    } finally {
      if (file && alive(file)) process.kill(file, "SIGKILL");
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    }
  });
}
