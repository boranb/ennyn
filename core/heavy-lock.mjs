/**
 * `ennyn lock -- <command>`: one heavy job at a time on this machine, first come first served, each under a time limit.
 *
 * The folder (`ENNYN_LOCK_DIR`, else `~/.ennyn-lock`) is the one the hand-written `locked.sh` uses, laid out alike, so
 * a waiter of either kind takes its turn in one order: a ticket `queue/<seconds since the epoch, %017.6f>-<pid>`, a
 * ticket whose waiter is gone dropped by any waiter, and the lock taken by the waiter whose ticket sorts first, by
 * creating the directory `suite.lock`. Only names of a ticket's shape are judged or removed: any other file in the
 * queue is left where it is. A queue that is a symbolic link is refused: nothing is written or removed behind it. An ennyn ticket holds its waiter's start, so a pid given again to a later
 * process is no waiter; a `locked.sh` ticket is empty, and its pid alone counts.
 *
 * Who holds the lock is written beside it, in `suite.lock.holder` (outside the directory, which `locked.sh` removes
 * with rmdir): this process and the runner, each by pid and start (a pid given again is another process), the run's
 * process group, the time its limit ends, and which `suite.lock` it is (inode and mtime: one taken again later is
 * another). Any ennyn waiter drops the lock once neither process lives and the run's group is gone, or its limit plus
 * the grace has passed (a group left with no runner holds its own limit no longer), claiming the drop first
 * (dropRecorded). A lock with no record of its own is a `locked.sh` holder's, or one whose record was not written: the
 * first ticket drops it only past 120 minutes, as `locked.sh` does. The holder sets the lock's mtime to now every
 * REFRESH_MS while its run lives, rewriting the record to match, so that rule never takes a long run's lock; it
 * releases the lock only while it is still its own, and otherwise leaves it and says so.
 *
 * The run itself is impact/reference-run.mjs's: the command in a process group of its own, SIGTERM to the group at the
 * limit, SIGKILL `GRACE_MS` later (Windows: its tree by taskkill /T /F). A SIGINT, SIGTERM or SIGHUP to this process
 * goes to the runner, which stops the group the same way.
 *
 * Each run adds one JSON line to `lock.log` in the folder (command, cwd, waited ms, ran ms, its end), written while
 * the lock is held; past LOG_MAX bytes the log moves to `lock.log.1` first, so the two hold at most twice that.
 *
 * The head of the queue takes a free lock only when the machine has room (readRoom, judgeRoom): free memory, swap
 * used, the 1-minute load per logical CPU and the free space where the run writes, each against its threshold. While
 * one is short it keeps its ticket, first in the queue, and looks again at each poll; past its own limit of waiting it
 * starts anyway and says so, so the queue never stops for good. A reading that cannot be made is said as unmeasured
 * and never holds a job: a lock that waits for good on a reading it cannot make is worse than none.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, statfsSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { constants, cpus as hostCpus, freemem, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { alive, stopTree } from "./git.mjs";

/** The limit of a run when none is given, in minutes: a whole suite takes 9 to 20 here, under load up to twice that. */
export const DEFAULT_LIMIT_MIN = 45;
/** The longest limit taken, in minutes. */
export const MAX_LIMIT_MIN = 600;
/** Between SIGTERM to the run's group and SIGKILL: time for a test runner to remove its temporary folders. */
export const GRACE_MS = 10_000;
/** How often a waiter looks at the queue. */
const POLL_MS = 500;
/** A lock with no record of its own is a dead run's past this age, as `locked.sh` reads it. */
export const OLD_LOCK_MS = 120 * 60_000;
/** Past this size the log moves to `lock.log.1`. */
export const LOG_MAX = 1024 * 1024;
/** The longest command text a log line keeps. */
const COMMAND_MAX = 2000;
/** The exit status of a run stopped at its limit, as GNU timeout gives. */
export const STOPPED_EXIT = 124;
/**
 * How often the holder sets the lock's mtime to now while its run lives, so `locked.sh`'s 120-minute rule never reads
 * a long run's lock as old. A machine asleep longer than OLD_LOCK_MS can still wake to a lock that reads old before
 * the first refresh after the wake.
 */
export const REFRESH_MS = 60_000;
/** How long `ps` may take to say a process's start. */
const PS_LIMIT_MS = 5_000;

const RUNNER = fileURLToPath(new URL("../impact/reference-run.mjs", import.meta.url));
const SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * The room a job is admitted with. Memory: macOS's free-memory level (kern.memorystatus_level, the figure
 * `memory_pressure` prints), Linux's MemAvailable share, or a container's own room where it leaves less; load: the
 * 1-minute load average per logical CPU of the host; disk: GB (10^9 bytes) free to an unprivileged user on the volumes
 * of the temporary folder and of the run's folder. Each has an option and a variable (ROOM_KNOBS). Swap is shown and
 * never judged: swapped pages stay out after the pressure ends (and macOS adds swap files as they fill: 1024M became
 * 2048M at 684M to 1054M used), so its share says what was short, not what is.
 */
export const ROOM_DEFAULTS = Object.freeze({ minMemory: 15, maxLoad: 1.5, minDisk: 5 });
/** @typedef {{ minMemory: number, maxLoad: number, minDisk: number }} Thresholds */
/** Each threshold's option, its variable and its bounds. */
export const ROOM_KNOBS = Object.freeze(
  /** @type {const} */ ({
    minMemory: { option: "min-memory", env: "ENNYN_LOCK_MIN_MEMORY", max: 100 },
    maxLoad: { option: "max-load", env: "ENNYN_LOCK_MAX_LOAD", max: 1000 },
    minDisk: { option: "min-disk", env: "ENNYN_LOCK_MIN_DISK", max: 1_000_000 },
  }),
);
/** macOS's sysctl by its own path: one found through PATH (node_modules/.bin, Homebrew) would decide admission, and a PATH without /usr/sbin (cron, launchd) would leave memory unmeasured. */
const SYSCTL = "/usr/sbin/sysctl";
/** How long a reading's program may take. */
const READ_LIMIT_MS = 5_000;

/**
 * The thresholds an option, else its variable, else the default gives, and the ones set away from the default (said
 * at each run, so none is changed without a word). A value that is not a number in its bounds throws.
 * @param {Record<string, string | true | undefined>} opts by option name @param {NodeJS.ProcessEnv} [env]
 * @returns {{ thresholds: Thresholds, set: string[] }}
 */
export function roomThresholds(opts, env = process.env) {
  const thresholds = /** @type {Thresholds} */ ({ ...ROOM_DEFAULTS });
  const set = [];
  for (const [key, knob] of /** @type {[keyof Thresholds, (typeof ROOM_KNOBS)[keyof Thresholds]][]} */ (Object.entries(ROOM_KNOBS))) {
    const [from, value] = opts[knob.option] !== undefined ? [`--${knob.option}`, opts[knob.option]] : env[knob.env] !== undefined ? [knob.env, env[knob.env]] : [null, undefined];
    if (from === null) continue;
    const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!(n >= 0 && n <= knob.max) || (key === "maxLoad" && n === 0)) throw new Error(`${from} must be a number from ${key === "maxLoad" ? "above 0" : "0"} to ${knob.max}, not ${JSON.stringify(value)}`);
    thresholds[key] = n;
    if (n !== ROOM_DEFAULTS[key]) set.push(`${from}=${value}`);
  }
  return { thresholds, set };
}

/** @typedef {{ value: number } | { unmeasured: string }} Reading */
/** @typedef {{ memory: Reading, swap: Reading, load: Reading, disk: { dir: string, read: Reading }[] }} Room */

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
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: READ_LIMIT_MS, killSignal: "SIGKILL" });
  } catch {
    return null;
  }
}

/** A reading of a value, or why there is none. @param {number | null} value @param {string} why */
const reading = (value, why) => (value !== null && Number.isFinite(value) ? { value } : { unmeasured: why });

/**
 * The machine's room now. macOS: one `/usr/sbin/sysctl -n kern.memorystatus_level vm.swapusage`; Linux: /proc/meminfo,
 * and the cgroup's limit and use at the top of the process's cgroup tree, which inside a container are the container's
 * own (v2 memory.max and memory.current, v1 memory/memory.limit_in_bytes and memory.usage_in_bytes), less the inactive
 * page cache its memory.stat names, which the kernel reclaims (as docker stats reads it); the smaller share of host and
 * container counts. A v2 process whose limit sits below the top of the tree it sees (a cgroup namespace not used) is
 * read by the host's share: a stated limit. Windows: os.freemem over os.totalmem, no swap, and no load (os.loadavg is
 * always 0 there). A reading that fails is `unmeasured`, with why; none throws.
 * @param {{ platform?: string, read?: (path: string) => string | null, run?: (command: string, args: string[]) => string | null, load?: () => number[], cpus?: number, free?: () => number, total?: () => number, statfs?: (path: string) => { bavail: number, bsize: number }, dirs?: string[] }} [io]
 * @returns {Room}
 */
export function readRoom({ platform = process.platform, read = readText, run = runText, load = loadavg, cpus = hostCpus().length, free = freemem, total = totalmem, statfs = statfsSync, dirs = [tmpdir()] } = {}) {
  /** @type {Reading} */
  let memory = { unmeasured: `not read on ${platform}` };
  /** @type {Reading} */
  let swap = { unmeasured: `not read on ${platform}` };
  if (platform === "darwin") {
    const [level = "", usage = ""] = (run(SYSCTL, ["-n", "kern.memorystatus_level", "vm.swapusage"]) ?? "").split("\n");
    memory = reading(/^\d+$/.test(level.trim()) && Number(level) <= 100 ? Number(level) : null, "sysctl kern.memorystatus_level gave no percentage");
    const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(usage);
    swap = reading(m ? (Number(m[1]) > 0 ? (Number(m[2]) / Number(m[1])) * 100 : 0) : null, "sysctl vm.swapusage gave no total and used");
  } else if (platform === "linux") {
    const info = read("/proc/meminfo") ?? "";
    const kb = (/** @type {string} */ name) => {
      const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(info);
      return m ? Number(m[1]) : null;
    };
    const [memTotal, available, swapTotal, swapFree] = [kb("MemTotal"), kb("MemAvailable"), kb("SwapTotal"), kb("SwapFree")];
    let share = memTotal && available !== null ? (available / memTotal) * 100 : null;
    const num = (/** @type {string | null} */ t) => (t !== null && /^\d+$/.test(t.trim()) ? Number(t) : null);
    const statOf = (/** @type {string | null} */ t, /** @type {string} */ key) => num(new RegExp(`^${key} (\\d+)$`, "m").exec(t ?? "")?.[1] ?? null);
    const cg = "/sys/fs/cgroup";
    const v2max = read(`${cg}/memory.max`);
    const [max, current, inactive] =
      v2max !== null
        ? [num(v2max), num(read(`${cg}/memory.current`)), statOf(read(`${cg}/memory.stat`), "inactive_file")]
        : [num(read(`${cg}/memory/memory.limit_in_bytes`)), num(read(`${cg}/memory/memory.usage_in_bytes`)), statOf(read(`${cg}/memory/memory.stat`), "total_inactive_file")];
    // "max" (v2) is no limit, and v1's "no limit" is a number past the host's memory, which the smaller share drops.
    if (share !== null && max && current !== null) share = Math.min(share, (Math.max(0, max - Math.max(0, current - (inactive ?? 0))) / max) * 100);
    memory = reading(share, "/proc/meminfo gave no MemTotal and MemAvailable");
    swap = reading(swapTotal === 0 ? 0 : swapTotal && swapFree !== null ? ((swapTotal - swapFree) / swapTotal) * 100 : null, "/proc/meminfo gave no SwapTotal and SwapFree");
  } else if (platform === "win32") {
    try {
      memory = reading(total() > 0 ? (free() / total()) * 100 : null, "os.totalmem gave 0");
    } catch (e) {
      memory = { unmeasured: String(/** @type {Error} */ (e).message) };
    }
  }
  /** @type {Reading} */
  let perCpu = { unmeasured: "os.loadavg is always 0 on Windows" };
  if (platform !== "win32") {
    try {
      // The load average is the host's, whatever CPUs a container may use: divided by the host's CPUs, not
      // availableParallelism(), which a cpuset narrows (a 2-CPU container on a busy 64-CPU host would always read short).
      perCpu = reading(cpus > 0 ? load()[0] / cpus : null, "no logical CPU count");
    } catch (e) {
      perCpu = { unmeasured: String(/** @type {Error} */ (e).message) };
    }
  }
  const disk = [...new Set(dirs)].map((dir) => {
    try {
      const s = statfs(dir);
      return { dir, read: reading((s.bavail * s.bsize) / 1e9, "statfs gave no free blocks") };
    } catch (e) {
      return { dir, read: /** @type {Reading} */ ({ unmeasured: String(/** @type {Error} */ (e).message) }) };
    }
  });
  return { memory, swap, load: perCpu, disk };
}

/**
 * The room against the thresholds: the readings as text, the short ones, the unmeasured ones (never short).
 * @param {Room} room @param {Thresholds} t
 * @returns {{ text: string, short: string[], unmeasured: string[] }}
 */
export function judgeRoom(room, t) {
  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const short = [];
  /** @type {string[]} */
  const unmeasured = [];
  /** @param {string} name @param {Reading} r @param {(v: number) => string} text @param {(v: number) => boolean} isShort */
  const one = (name, r, text, isShort) => {
    if ("unmeasured" in r) return void unmeasured.push(`${name} (${r.unmeasured})`);
    parts.push(`${name} ${text(r.value)}`);
    if (isShort(r.value)) short.push(`${name} ${text(r.value)}`);
  };
  const round = (/** @type {number} */ v) => String(Number(v.toFixed(2)));
  one("memory", room.memory, (v) => `${round(v)}% free (min ${t.minMemory}%)`, (v) => v < t.minMemory);
  one("swap", room.swap, (v) => `${round(v)}% used (not judged)`, () => false);
  one("load", room.load, (v) => `${round(v)} per CPU (max ${t.maxLoad})`, (v) => v > t.maxLoad);
  for (const d of room.disk) one(`disk ${d.dir}`, d.read, (v) => `${round(v)} GB free (min ${t.minDisk} GB)`, (v) => v < t.minDisk);
  return { text: [...parts, ...unmeasured.map((u) => `${u}: unmeasured`)].join(", "), short, unmeasured };
}

/** The lock folder. @param {NodeJS.ProcessEnv} [env] */
export const lockDir = (env = process.env) => resolve(env.ENNYN_LOCK_DIR || join(homedir(), ".ennyn-lock"));

/**
 * A process's start, so a pid given again reads as another process; null once it is gone or a zombie. Linux: clock
 * ticks since boot (field 22 of /proc/<pid>/stat); elsewhere `ps`'s lstart in UTC, to the second; Windows: "" (no
 * start is read there, the pid alone counts). A start that cannot be read throws: never read as gone. The way is
 * chosen by the platform, never by a probe of /proc: a probe that failed once would give one process starts of two
 * forms, and its own ticket would read as another process's.
 * @param {number} pid @returns {string | null}
 */
export function processStart(pid) {
  if (process.platform === "win32") return alive(pid) ? "" : null;
  if (process.platform === "linux") {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (e) {
      // No entry for a pid that still answers (no /proc mounted): its start cannot be read.
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" && !alive(pid)) return null;
      throw e;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  }
  const out = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: PS_LIMIT_MS, killSignal: "SIGKILL" });
  // A pid that is gone: exit 1 and nothing said.
  if (out.status === 1 && out.stdout === "" && out.stderr === "") return null;
  const [state, ...start] = out.status === 0 ? out.stdout.trim().split(/\s+/) : [];
  if (!state || start.length === 0) throw new Error(`the start of pid ${pid} could not be read: ps ${out.error ? out.error.message : `exit ${out.status}`}`);
  return state.startsWith("Z") ? null : start.join(" ");
}

/**
 * Whether a process recorded by pid and start still runs: one recorded with no start by its pid alone, and one whose
 * start cannot be read now counts as running. @param {{ pid: number, start: string | null } | null | undefined} p
 * @param {(pid: number) => string | null} [startOf]
 */
function lives(p, startOf = processStart) {
  if (!p || !Number.isInteger(p.pid) || p.pid <= 0) return false;
  if (typeof p.start !== "string") return alive(p.pid);
  try {
    return startOf(p.pid) === p.start;
  } catch {
    return true;
  }
}

/** Whether the run's process group (Windows: the run's process) still has a process. @param {unknown} pid */
function groupLives(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") return alive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** A ticket's name, as both writers make it (%017.6f seconds, then the pid): the only names the sweep judges. */
const TICKET = /^\d{10}\.\d{6}-\d+$/;

/** A ticket's name: the time to the microsecond, %017.6f, and this process's pid. */
function ticketName() {
  return `${((performance.timeOrigin + performance.now()) / 1000).toFixed(6).padStart(17, "0")}-${process.pid}`;
}

/**
 * Whether a ticket's waiter still runs. An ennyn ticket holds its waiter's start, so a pid given again to a later
 * process reads as gone; a `locked.sh` ticket holds nothing, and its pid alone counts, as `locked.sh` reads it. A
 * ticket that cannot be read, or whose waiter's start cannot be read, counts as live.
 * @param {string} path @param {number} pid @param {() => void} [startRead] called when a start was read and matched
 */
function ticketLives(path, pid, startRead = () => {}) {
  let start;
  try {
    start = readFileSync(path, "utf8").trim();
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT";
  }
  if (start === "") return alive(pid);
  if (!lives({ pid, start })) return false;
  startRead();
  return true;
}

/**
 * The live tickets in queue order; a ticket whose waiter is gone is removed, as `locked.sh` removes it. A name not of
 * a ticket's shape is no ticket: never judged, never removed, never in the order. A ticket's
 * start is read once (`known`, by name: a name and its process fix the verdict), after that its pid alone is asked
 * (signal 0, no `ps`); a name no longer in the queue is forgotten. An empty ticket (locked.sh's) is read each time.
 * The waiter's own ticket is never judged: it lives while the waiter does. One no longer in the queue (another waiter
 * read it dead) is null: no turn can come to it, and the wait ends.
 * @param {string} queue @param {Set<string>} known tickets whose start this waiter read and found living
 * @param {string} own the waiter's ticket name
 * @returns {string[] | null}
 */
function liveTickets(queue, known, own) {
  const names = readdirSync(queue).filter((n) => TICKET.test(n)).sort();
  if (!names.includes(own)) return null;
  for (const n of known) if (!names.includes(n)) known.delete(n);
  return names.filter((n) => {
    if (n === own) return true;
    const pid = Number(n.slice(n.lastIndexOf("-") + 1));
    if (Number.isInteger(pid) && pid > 0 && alive(pid) && (known.has(n) || ticketLives(join(queue, n), pid, () => known.add(n)))) return true;
    try {
      unlinkSync(join(queue, n));
    } catch {
      // Gone already, or not ours to remove: the next look tries again.
    }
    return false;
  });
}

/** Which `suite.lock` this is: its inode and mtime. @param {string} lock */
function lockId(lock) {
  const st = lstatSync(lock, { bigint: true });
  return `${st.ino}-${st.mtimeNs}`;
}

/** Writes the record whole, by a rename; a write that fails leaves no temporary file. @param {string} path @param {object} record */
function writeRecord(path, record) {
  const tmp = `${path}.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw e;
  }
}

/**
 * Drops a dead ennyn holder's lock, claimed first: the record is renamed to a name of this waiter's own, so of two
 * waiters that judged it dead one rename wins and the other does nothing. The winner reads the claimed record back:
 * the one it judged, of the lock still there (inode and mtime), or it puts the record back and does nothing.
 * A record put back goes by a link, which never replaces one a new holder wrote meanwhile.
 * @param {string} lock @param {string} holderPath @param {string} text the record as judged
 * @param {(from: string, to: string) => void} [link] linkSync; a test gives one that fails
 * @returns {"dropped" | "lost" | Error | { left: string }} `left`: a claim that could not be put back, left where it is
 */
export function dropRecorded(lock, holderPath, text, link = linkSync) {
  const claim = `${holderPath}.drop-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(holderPath, claim);
  } catch {
    return "lost";
  }
  /**
   * The claim goes back where it was; true once it is back or a record stands there. A link never replaces a record a
   * new holder wrote meanwhile; where links do not exist (FAT), a rename puts it back when nothing stands there. A
   * claim that could not be put back is left, never removed: it may be a living holder's record.
   */
  const putBack = () => {
    try {
      link(claim, holderPath);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") {
        if (existsSync(holderPath)) return false;
        try {
          renameSync(claim, holderPath);
          return true;
        } catch {
          return false;
        }
      }
      // A new holder's record is there: it stays, and the claim, older, goes.
    }
    try {
      unlinkSync(claim);
    } catch {
      // Gone already.
    }
    return true;
  };
  let same = false;
  try {
    same = readFileSync(claim, "utf8") === text && JSON.parse(text).lock === lockId(lock);
  } catch {
    // The lock is gone, or the record cannot be read: not the one judged.
  }
  if (!same) return putBack() ? "lost" : { left: claim };
  try {
    rmdirSync(lock);
  } catch (e) {
    // Kept with its record, so the next look judges it the same way.
    return putBack() ? /** @type {Error} */ (e) : { left: claim };
  }
  try {
    unlinkSync(claim);
  } catch {
    // Gone already.
  }
  return "dropped";
}

/**
 * Whether the held lock is a dead run's, and why; null while it is held, or gone already.
 * @param {string} lock @param {string} holderPath @param {number} now epoch ms
 * @param {{ text: string, pids: number[], at: number }} [memo] a waiter's last look: a record whose holder or runner
 *   read living, by its bytes, and when; the same bytes again ask that pid by signal 0 alone, with no `ps`, for
 *   `rereadMs` (the holder's refresh cadence) and before the record's deadline: a pid given again to another process
 *   then reads as one at most that long
 * @param {{ rereadMs?: number, startOf?: (pid: number) => string | null }} [how] a test gives a short interval and a
 *   start reader of its own
 * @returns {{ why: "holder", pid: number, text: string } | { why: "old" } | null}
 */
export function deadLock(lock, holderPath, now = Date.now(), memo = { text: "", pids: /** @type {number[]} */ ([]), at: 0 }, { rereadMs = REFRESH_MS, startOf = processStart } = {}) {
  let id;
  let mtimeMs;
  try {
    id = lockId(lock);
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return null;
  }
  /** @type {any} */
  let rec = null;
  let text = "";
  try {
    text = readFileSync(holderPath, "utf8");
    rec = JSON.parse(text);
  } catch {
    // No record, or one that cannot be read: the lock is read as locked.sh's.
  }
  if (rec && typeof rec === "object" && rec.lock === id) {
    // The same record bytes as at the last look, whose process then read living by its start: its pid alone is asked.
    const fresh = now - memo.at < rereadMs && typeof rec.deadline === "number" && now < rec.deadline;
    if (fresh && memo.text === text && memo.pids.length && memo.pids.every(alive)) return null;
    const living = lives(rec.holder, startOf) ? rec.holder : lives(rec.runner, startOf) ? rec.runner : null;
    if (living) {
      memo.text = text;
      memo.pids = [living.pid];
      memo.at = now;
      return null;
    }
    if (groupLives(rec.group) && typeof rec.deadline === "number" && now < rec.deadline) return null;
    return { why: "holder", pid: rec.holder?.pid, text };
  }
  return now - mtimeMs > OLD_LOCK_MS ? { why: "old" } : null;
}

/** The end the runner said, as an exit status. @param {string} end */
function exitOf(end) {
  const [word, value] = end.split(" ");
  if (word === "exit") return Number(value);
  if (word === "stopped") return STOPPED_EXIT;
  if (word === "signal" || word === "interrupted") return 128 + (constants.signals[/** @type {NodeJS.Signals} */ (value)] ?? 0);
  if (word === "error") return value === "ENOENT" ? 127 : 126;
  return 1;
}

/** Appends the run's line, moving a log past LOG_MAX aside first. @param {string} dir @param {object} entry */
function log(dir, entry) {
  const path = join(dir, "lock.log");
  try {
    if (statSync(path).size > LOG_MAX) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * @typedef {{ key: string, vars?: Record<string, string | number> }} Said
 * @param {{ command: string, args: string[], limitMs: number, cwd?: string, env?: NodeJS.ProcessEnv, say?: (s: Said) => void, graceMs?: number, refreshMs?: number, room?: () => Room, thresholds?: Thresholds }} o
 *   `room`: the machine's room now (a test gives its own); `thresholds`: what counts as room. The wait for room ends at
 *   `limitMs`, the run's own limit, and the run then starts anyway.
 * @returns {Promise<number>} the run's exit status: its own, 124 stopped at the limit, 128+n ended or interrupted by signal n
 */
export async function runLocked({ command, args, limitMs, cwd = process.cwd(), env = process.env, say = () => {}, graceMs = GRACE_MS, refreshMs = REFRESH_MS, room = () => readRoom({ dirs: [tmpdir(), cwd] }), thresholds = ROOM_DEFAULTS }) {
  const dir = lockDir(env);
  const queue = join(dir, "queue");
  const lock = join(dir, "suite.lock");
  const holderPath = join(dir, "suite.lock.holder");
  /** @type {NodeJS.Signals | null} */
  let asked = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let runner = null;
  const nap = new AbortController();
  const onSignal = (/** @type {NodeJS.Signals} */ s) => {
    asked ??= s;
    if (runner) runner.kill(s);
    else nap.abort();
  };
  // Before the ticket: a signal once the ticket is there takes the ticket away with it, never the process alone.
  for (const s of SIGNALS) process.on(s, onSignal);
  let ticket;
  const ownName = ticketName();
  try {
    // A queue that is a link (a dangling one too) is refused before a ticket is written: the sweep removes files in it.
    if (isLink(queue)) {
      say({ key: "lock.queueLink", vars: { queue } });
      return (offSignals(onSignal), 1);
    }
    mkdirSync(queue, { recursive: true });
    ticket = join(queue, ownName);
    // The waiter's start, so a pid given again to a later process is no waiter of this queue.
    writeFileSync(ticket, safeStart(process.pid) ?? "");
  } catch (e) {
    offSignals(onSignal);
    throw e;
  }
  const began = performance.now();
  const at = new Date().toISOString();
  let waited = false;
  let dropFailSaid = false;
  /** Tickets whose start this waiter read once and found living. @type {Set<string>} */
  const known = new Set();
  /** The record this waiter last read living, by its bytes. */
  const memo = { text: "", pids: /** @type {number[]} */ ([]), at: 0 };
  /** When the head of the queue first read the machine short of room; the readings it was admitted on; what was short. */
  let shortSince = /** @type {number | null} */ (null);
  let admittedOn = "";
  let shortOn = "";
  let unmeasuredSaid = false;
  let ceilingSaid = false;
  try {
    // Wait for the turn: the first live ticket takes the lock. A dead ennyn holder's lock any ennyn waiter may drop,
    // claimed first, so a locked.sh waiter at the head of the queue is not left behind it; a lock with no record of
    // its own only the first ticket drops, as locked.sh does.
    for (;;) {
      if (asked) return (offSignals(onSignal), 128 + constants.signals[asked]);
      const live = liveTickets(queue, known, ownName);
      if (live === null) {
        say({ key: "lock.ticketGone", vars: { dir } });
        return (offSignals(onSignal), 1);
      }
      const mine = live[0] === ownName;
      let roomWait = false;
      // Room is read at the head of the queue with the lock free: nobody else's turn waits on it.
      if (mine && !existsSync(lock)) {
        let judged;
        try {
          judged = judgeRoom(room(), thresholds);
        } catch (e) {
          judged = { text: "", short: [], unmeasured: [`room (${/** @type {Error} */ (e).message})`] };
        }
        if (judged.unmeasured.length && !unmeasuredSaid) say({ key: "lock.roomUnmeasured", vars: { what: judged.unmeasured.join(", ") } });
        unmeasuredSaid ||= judged.unmeasured.length > 0;
        admittedOn = judged.text;
        if (judged.short.length) {
          if (shortSince === null) {
            shortSince = performance.now();
            shortOn = judged.short.join(", ");
            say({ key: "lock.roomShort", vars: { short: shortOn, minutes: limitMs / 60_000 } });
          }
          roomWait = performance.now() - shortSince < limitMs;
          if (!roomWait && !ceilingSaid) say({ key: "lock.roomCeiling", vars: { minutes: limitMs / 60_000, short: judged.short.join(", ") } });
          ceilingSaid ||= !roomWait;
        } else ceilingSaid = false;
      }
      if (mine && !roomWait) {
        try {
          mkdirSync(lock);
          break;
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
        }
      }
      const dead = deadLock(lock, holderPath, Date.now(), memo);
      if (dead && (dead.why === "holder" || mine)) {
        const done = dead.why === "holder" ? dropRecorded(lock, holderPath, dead.text) : dropOld(lock);
        if (done === "dropped") {
          say(dead.why === "holder" ? { key: "lock.droppedDead", vars: { pid: dead.pid } } : { key: "lock.droppedOld", vars: { minutes: OLD_LOCK_MS / 60_000 } });
          continue;
        }
        if (typeof done === "object" && "left" in done) say({ key: "lock.claimLeft", vars: { path: done.left } });
        // Said once; the next look, a poll later, tries again.
        if (done instanceof Error && !dropFailSaid) say({ key: "lock.dropFailed", vars: { error: String(done.message) } });
        if (done instanceof Error) dropFailSaid = true;
      }
      if (!waited && !roomWait) say({ key: "lock.waiting", vars: { dir } });
      waited = true;
      try {
        await sleep(POLL_MS, undefined, { signal: nap.signal });
      } catch {
        // Woken by a signal.
      }
    }
  } finally {
    try {
      unlinkSync(ticket);
    } catch {
      // Removed by a waiter that read its pid gone: not this one.
    }
  }

  // The lock is held from here: whatever fails below, the lock is released, if it is still this run's.
  const waitedMs = Math.round(performance.now() - began);
  const start = performance.now();
  /** @type {string | null} which suite.lock this run holds; it moves with each refresh of the mtime */
  let held = null;
  let written = false;
  const own = { pid: process.pid, start: safeStart(process.pid) };
  /** @type {NodeJS.Timeout | undefined} */
  let refresh;
  let recordFailSaid = false;
  try {
    held = lockId(lock);
    const record = { v: 1, holder: own, runner: /** @type {{ pid: number, start: string | null } | null} */ (null), group: /** @type {number | null} */ (null), deadline: Date.now() + limitMs + graceMs, lock: held };
    writeRecord(holderPath, record);
    written = true;
    /** A rewrite while the run lives: one that fails is said once, and the run goes on. */
    const rewrite = () => {
      try {
        writeRecord(holderPath, record);
      } catch (e) {
        if (!recordFailSaid) say({ key: "lock.recordFailed", vars: { error: String(/** @type {Error} */ (e).message) } });
        recordFailSaid = true;
      }
    };
    refresh = setInterval(() => {
      try {
        if (lockId(lock) !== held) return;
        const now = new Date();
        utimesSync(lock, now, now);
        held = lockId(lock);
      } catch {
        // The lock is gone or no longer this run's: release says so.
        return;
      }
      record.lock = held;
      rewrite();
    }, refreshMs);
    // Said only after a wait: a lock taken at once says nothing, and the run's output is all there is.
    if (waited) say({ key: "lock.taken", vars: { seconds: (waitedMs / 1000).toFixed(1) } });
    if (shortSince !== null && !ceilingSaid) say({ key: "lock.roomAdmitted", vars: { room: admittedOn } });
    let end = "";
    let left = false;
    /** @type {number | undefined} */
    let job;
    const exit = await new Promise((done) => {
      const child = spawn(process.execPath, [RUNNER, String(limitMs), String(graceMs), command, ...args], { cwd, env, stdio: ["ignore", "inherit", "inherit", "pipe"] });
      runner = child;
      if (child.pid !== undefined) {
        record.runner = { pid: child.pid, start: safeStart(child.pid) };
        rewrite();
      }
      if (asked) child.kill(asked);
      let said = "";
      child.stdio[3]?.on("data", (b) => {
        said += String(b);
        for (const line of said.split("\n").slice(0, -1)) {
          const m = /^pid (\d+)$/.exec(line);
          if (m && job === undefined) {
            job = Number(m[1]);
            record.group = job;
            rewrite();
          } else if (line === "left: stopped") left = true;
          else if (/^(exit|signal|stopped|interrupted|error)\b/.test(line)) end = line;
        }
        said = said.slice(said.lastIndexOf("\n") + 1);
      });
      child.on("error", (e) => {
        end = `error ${/** @type {NodeJS.ErrnoException} */ (e).code ?? "unknown"}`;
        done(126);
      });
      child.on("close", (code, signal) => {
        if (!end) {
          // The runner ended before it said the run's end: what it ran goes too.
          if (job !== undefined) {
            try {
              if (process.platform === "win32") stopTree(job);
              else process.kill(-job, "SIGKILL");
            } catch {
              // The group is gone.
            }
          }
          end = `runner ${signal ?? `exit ${code}`}`;
          done(asked ? 128 + constants.signals[asked] : 1);
          return;
        }
        done(exitOf(end));
      });
    });
    if (end === "stopped") say({ key: "lock.stopped", vars: { minutes: limitMs / 60_000 } });
    try {
      const text = [command, ...args].join(" ");
      log(dir, { at, command: text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX)}…` : text, cwd, waitedMs, ranMs: Math.round(performance.now() - start), end, ...(left ? { left: "stopped" } : {}), room: admittedOn, ...(shortSince !== null ? { short: shortOn } : {}) });
    } catch (e) {
      say({ key: "lock.logFailed", vars: { error: String(/** @type {Error} */ (e).message) } });
    }
    return /** @type {number} */ (exit);
  } finally {
    clearInterval(refresh);
    offSignals(onSignal);
    release(lock, holderPath, held, written, own, say);
  }
}

/** Whether the path is a symbolic link; one not there is none, and one that cannot be read throws. @param {string} path */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return false;
    throw e;
  }
}

/** @param {(s: NodeJS.Signals) => void} onSignal */
function offSignals(onSignal) {
  for (const s of SIGNALS) process.off(s, onSignal);
}

/** Drops a lock with no record of its own, past 120 minutes. @param {string} lock @returns {"dropped" | Error} */
function dropOld(lock) {
  try {
    rmdirSync(lock);
    return "dropped";
  } catch (e) {
    return /** @type {Error} */ (e);
  }
}

/**
 * Releases the lock only while it is still this run's: the same suite.lock (inode and mtime as last refreshed), and a
 * record, if one was written, that still names this process. A lock taken from under the run (`locked.sh`'s
 * 120-minute rule, a waiter that read this run dead) is left with its record, and said.
 * @param {string} lock @param {string} holderPath @param {string | null} held @param {boolean} written
 * @param {{ pid: number, start: string | null }} own @param {(s: Said) => void} say
 */
function release(lock, holderPath, held, written, own, say) {
  // A lock or record that cannot be read is not known to be this run's: left, and said apart from one that is not.
  /** @type {{ key: string, vars: Record<string, string> } | null} */
  let kept = null;
  try {
    if (held === null || lockId(lock) !== held) kept = { key: "lock.notReleased", vars: { what: "lock" } };
  } catch (e) {
    kept = { key: "lock.releaseUnread", vars: { what: "lock", error: String(/** @type {Error} */ (e).message) } };
  }
  if (!kept && written) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(holderPath, "utf8"));
    } catch (e) {
      kept = { key: "lock.releaseUnread", vars: { what: "record", error: String(/** @type {Error} */ (e).message) } };
    }
    if (!kept && (rec?.holder?.pid !== own.pid || rec.holder.start !== own.start)) kept = { key: "lock.notReleased", vars: { what: "record" } };
  }
  if (kept) return say(kept);
  if (written) {
    try {
      unlinkSync(holderPath);
    } catch {
      // Removed already.
    }
  }
  try {
    rmdirSync(lock);
  } catch (e) {
    say({ key: "lock.releaseFailed", vars: { error: String(/** @type {Error} */ (e).message) } });
  }
}

/** A start that could not be read is recorded as none: the pid alone then counts. @param {number} pid */
function safeStart(pid) {
  try {
    return processStart(pid);
  } catch {
    return null;
  }
}
