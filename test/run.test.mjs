// The suite's concurrency: fed counts and cgroup text by hand, never this machine's (test/run.mjs reads those).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERRIDE, concurrency, containerCpus, readMachine, wholeArgs } from "./run.mjs";

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

test("concurrency: npm test's runner says its limit, passes the suite's exit on, and runs nothing on a refused override", () => {
  // The runner in a folder of its own, with a setup and test files of its own.
  const dir = mkdtempSync(join(tmpdir(), "en-run-"));
  mkdirSync(join(dir, "test"));
  copyFileSync(fileURLToPath(new URL("./run.mjs", import.meta.url)), join(dir, "test", "run.mjs"));
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
  assert.match(good.stdout, /^# pass 1$/m);

  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("b fails", () => { throw new Error("no"); });\n');
  const bad = run({});
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^# fail 1$/m);

  // The runner's node killed under it: no exit code, and that is no pass.
  writeFileSync(join(dir, "test", "b.test.mjs"), 'import { test } from "node:test";\ntest("the runner dies", () => { process.kill(process.ppid, "SIGKILL"); });\n');
  const killed = run({});
  // As a shell reads a signal's end: 128 plus SIGKILL's 9.
  assert.equal(killed.status, 137, killed.stdout + killed.stderr);
  assert.match(killed.stderr, /^the suite did not finish: SIGKILL$/m);

  const refused = run({ [OVERRIDE]: "many" });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(refused.stderr, `${OVERRIDE} must be a positive integer, not "many"\n`);
  assert.equal(refused.stdout, "", "nothing ran");
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
    const dir = mkdtempSync(join(tmpdir(), "en-run-stop-"));
    mkdirSync(join(dir, "test"));
    copyFileSync(fileURLToPath(new URL("./run.mjs", import.meta.url)), join(dir, "test", "run.mjs"));
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
