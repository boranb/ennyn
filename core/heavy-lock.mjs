/**
 * `ennyn lock -- <command>`: one heavy job at a time on this machine, first come first served, each under a time limit.
 *
 * The folder (`ENNYN_LOCK_DIR`, else `~/.ennyn-lock`) is the one the hand-written `locked.sh` uses, laid out alike, so
 * a waiter of either kind takes its turn in one order: a ticket `queue/<seconds since the epoch, %017.6f>-<pid>`, a
 * ticket whose waiter is gone dropped by any waiter, and the lock taken by the waiter whose ticket sorts first, by
 * creating the directory `suite.lock`. An ennyn ticket holds its waiter's start, so a pid given again to a later
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
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
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

/** The lock folder. @param {NodeJS.ProcessEnv} [env] */
export const lockDir = (env = process.env) => resolve(env.ENNYN_LOCK_DIR || join(homedir(), ".ennyn-lock"));

/**
 * A process's start, so a pid given again reads as another process; null once it is gone or a zombie. Linux: clock
 * ticks since boot (field 22 of /proc/<pid>/stat); elsewhere `ps`'s lstart in UTC, to the second; Windows: "" (no
 * start is read there, the pid alone counts). A start that cannot be read throws: never read as gone.
 * @param {number} pid @returns {string | null}
 */
export function processStart(pid) {
  if (process.platform === "win32") return alive(pid) ? "" : null;
  if (existsSync("/proc/self/stat")) {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
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
 * The live tickets in queue order; a ticket whose waiter is gone is removed, as `locked.sh` removes it. A ticket's
 * start is read once (`known`, by name: a name and its process fix the verdict), after that its pid alone is asked
 * (signal 0, no `ps`); a name no longer in the queue is forgotten. An empty ticket (locked.sh's) is read each time.
 * @param {string} queue @param {Set<string>} [known] tickets whose start this waiter read and found living
 * @returns {string[]}
 */
function liveTickets(queue, known = new Set()) {
  const names = readdirSync(queue).filter((n) => !n.startsWith(".")).sort();
  for (const n of known) if (!names.includes(n)) known.delete(n);
  return names.filter((n) => {
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
 * @param {{ command: string, args: string[], limitMs: number, cwd?: string, env?: NodeJS.ProcessEnv, say?: (s: Said) => void, graceMs?: number, refreshMs?: number }} o
 * @returns {Promise<number>} the run's exit status: its own, 124 stopped at the limit, 128+n ended or interrupted by signal n
 */
export async function runLocked({ command, args, limitMs, cwd = process.cwd(), env = process.env, say = () => {}, graceMs = GRACE_MS, refreshMs = REFRESH_MS }) {
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
  try {
    mkdirSync(queue, { recursive: true });
    ticket = join(queue, ticketName());
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
  try {
    // Wait for the turn: the first live ticket takes the lock. A dead ennyn holder's lock any ennyn waiter may drop,
    // claimed first, so a locked.sh waiter at the head of the queue is not left behind it; a lock with no record of
    // its own only the first ticket drops, as locked.sh does.
    for (;;) {
      if (asked) return (offSignals(onSignal), 128 + constants.signals[asked]);
      const first = liveTickets(queue, known)[0];
      const mine = first !== undefined && join(queue, first) === ticket;
      if (mine) {
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
      if (!waited) say({ key: "lock.waiting", vars: { dir } });
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
      log(dir, { at, command: text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX)}…` : text, cwd, waitedMs, ranMs: Math.round(performance.now() - start), end, ...(left ? { left: "stopped" } : {}) });
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
