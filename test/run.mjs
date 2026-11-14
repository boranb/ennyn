/**
 * `npm test`: every test file, under the suite's concurrency limit. Node runs `os.availableParallelism() - 1` test
 * files at once by default, and many of them start processes of their own; the whole suite's failures that each file
 * did not show alone came at loads far above the machine's cores. The limit leaves cores to the machine and to a
 * second suite beside this one: half the physical cores, at least 1; inside a container (its cgroup's CPU quota and
 * cpuset) no more than half the CPUs it may use; a quarter of the logical CPUs where the physical count cannot be read.
 * ENNYN_TEST_CONCURRENCY, a positive integer, wins; any other value stops the run. test/short.mjs uses the same limit,
 * and starts its runs through runPassingStops, so a stop reaches its runs as it reaches npm test's.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OVERRIDE = "ENNYN_TEST_CONCURRENCY";

/**
 * @typedef {{ cpuMax?: string | null, quota?: string | null, period?: string | null, cpuset?: string | null }} Cgroup
 * The text of the cgroup files: v2 `cpu.max`, v1 `cpu.cfs_quota_us` and `cpu.cfs_period_us`, the cpuset's CPU list.
 */

/** The CPU numbers a list (`0-3,6`) names, or null when it is not one. @param {string} text @returns {number[] | null} */
function cpuList(text) {
  const out = [];
  for (const part of text.trim().split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m || Number(m[2] ?? m[1]) < Number(m[1])) return null;
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.push(n);
  }
  return out;
}

/** CPUs a quota allows (quota over period), or null for none or text that is not one. @param {string} quota @param {string} period */
function quotaCpus(quota, period) {
  if (!/^\d+$/.test(quota.trim()) || !/^\d+$/.test(period.trim())) return null;
  const [q, p] = [Number(quota), Number(period)];
  return q > 0 && p > 0 ? q / p : null;
}

/** The CPUs a container may use, the smaller of its quota and its cpuset; null when neither limits it. @param {Cgroup} cgroup */
export function containerCpus(cgroup) {
  const found = [];
  if (cgroup.cpuMax) {
    // "max <period>" is no quota, and reads as none.
    const [quota, period = ""] = cgroup.cpuMax.trim().split(/\s+/);
    found.push(quotaCpus(quota, period));
  } else if (cgroup.quota && cgroup.period) found.push(quotaCpus(cgroup.quota, cgroup.period));
  if (cgroup.cpuset) found.push(cpuList(cgroup.cpuset)?.length ?? null);
  const known = found.filter((n) => n !== null);
  return known.length ? Math.min(...known) : null;
}

/**
 * The suite's concurrency and why, from what the machine says.
 * @param {{ physical: number | null, logical: number, cgroup?: Cgroup, env?: string }} machine
 * @returns {{ n: number, why: string }}
 */
export function concurrency({ physical, logical, cgroup = {}, env }) {
  if (env !== undefined) {
    if (!/^[1-9]\d*$/.test(env) || !Number.isSafeInteger(Number(env))) throw new Error(`${OVERRIDE} must be a positive integer, not ${JSON.stringify(env)}`);
    return { n: Number(env), why: `${OVERRIDE}=${env}` };
  }
  const half = (/** @type {number} */ n) => Math.max(1, Math.floor(n / 2));
  const host =
    Number.isInteger(physical) && /** @type {number} */ (physical) > 0
      ? { n: half(/** @type {number} */ (physical)), why: `half the ${physical} physical cores` }
      : { n: Math.max(1, Math.floor(logical / 4)), why: `a quarter of the ${logical} logical CPUs: the physical count could not be read` };
  const cpus = containerCpus(cgroup);
  return cpus !== null && half(cpus) < host.n ? { n: half(cpus), why: `half the ${cpus} CPUs the container may use` } : host;
}

/** @param {string} path @returns {string | null} */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** @param {string} command @param {string[]} args @returns {string | null} */
function runText(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL" });
  } catch {
    return null;
  }
}

/** A count a program printed, or null. @param {string | null} text */
const count = (text) => (text !== null && /^\s*[1-9]\d*\s*$/.test(text) ? Number(text) : null);

/**
 * What the machine says: the physical cores (macOS `sysctl -n hw.physicalcpu`; Linux, WSL included, the distinct
 * package and core ids of the online CPUs in sysfs; elsewhere none), the logical CPUs Node may use, and on Linux the
 * cgroup files at the top of the process's cgroup tree, which inside a container are the container's own.
 * @param {{ platform?: string, read?: (path: string) => string | null, run?: (command: string, args: string[]) => string | null, logical?: number }} [io]
 */
export function readMachine({ platform = process.platform, read = readText, run = runText, logical = availableParallelism() } = {}) {
  if (platform === "darwin") return { physical: count(run("sysctl", ["-n", "hw.physicalcpu"])), logical, cgroup: {} };
  if (platform !== "linux") return { physical: null, logical, cgroup: {} };
  const cpu = "/sys/devices/system/cpu";
  const online = cpuList(read(`${cpu}/online`) ?? "");
  const cores = online?.map((n) => [read(`${cpu}/cpu${n}/topology/physical_package_id`), read(`${cpu}/cpu${n}/topology/core_id`)].map((t) => t?.trim()).join(" "));
  const physical = cores && cores.every((c) => /^\d+ \d+$/.test(c)) ? new Set(cores).size : null;
  const fs = "/sys/fs/cgroup";
  const cgroup = {
    cpuMax: read(`${fs}/cpu.max`),
    quota: read(`${fs}/cpu/cpu.cfs_quota_us`),
    period: read(`${fs}/cpu/cpu.cfs_period_us`),
    cpuset: read(`${fs}/cpuset.cpus.effective`) ?? read(`${fs}/cpuset/cpuset.effective_cpus`),
  };
  return { physical, logical, cgroup };
}

/**
 * The limit for this run, said once on stdout so a log shows it; null, said on stderr, when the override is refused.
 * @param {NodeJS.ProcessEnv} [env] @returns {number | null}
 */
export function suiteConcurrency(env = process.env) {
  try {
    const { n, why } = concurrency({ ...readMachine(), env: env[OVERRIDE] });
    console.log(`test concurrency ${n}: ${why}`);
    return n;
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    return null;
  }
}

/** The whole suite's node arguments: node expands the pattern itself. @param {number} n */
export const wholeArgs = (n) => ["--test", `--test-concurrency=${n}`, "--import", "./test/hermetic.mjs", "test/*.test.mjs"];

/** Every stop npm or a terminal passes on to the script's process. */
const STOPS = /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]);

/**
 * Runs node with `args` and passes on every stop this process gets while it runs: npm test's run and each of
 * test/short.mjs's start here. Settles when the run ends, in spawnSync's shape, with the stop that came, if one did.
 * @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, error?: Error, stop: NodeJS.Signals | null }>}
 */
export function runPassingStops(args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve) => {
    const suite = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    /** @type {Error | undefined} */
    let error;
    /** @type {NodeJS.Signals | null} */
    let stop = null;
    // A stop for this process is the suite's: without this the runner ends and node --test runs on. node --test stops
    // its test files on SIGINT and SIGTERM; a SIGHUP ends it and leaves them running, so it gets SIGTERM instead.
    const pass = (/** @type {NodeJS.Signals} */ signal) => {
      stop ??= signal;
      suite.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
    };
    for (const signal of STOPS) process.on(signal, pass);
    suite.on("error", (err) => (error = err));
    // After a failed start too: close follows error.
    suite.on("close", (code, signal) => {
      // A stop that comes once this run is over is no longer passed: it ends this process, or the next run takes it.
      for (const s of STOPS) process.off(s, pass);
      resolve({ status: typeof code === "number" && code >= 0 ? code : null, signal, error, stop });
    });
  });
}

async function main() {
  const n = suiteConcurrency();
  if (n === null) return void (process.exitCode = 2);
  const { status, signal, error } = await runPassingStops(wholeArgs(n));
  if (error) console.error(`the suite did not start: ${error.message}`);
  if (signal) console.error(`the suite did not finish: ${signal}`);
  // A signal's end reads as a shell gives it, 128 plus its number.
  process.exitCode = signal ? 128 + constants.signals[signal] : (status ?? 1);
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) main();
