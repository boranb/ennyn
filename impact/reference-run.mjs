/**
 * The impact table's reference command under a time limit that holds for what the command starts, run by
 * impact/table.mjs as `node reference-run.mjs <limitMs> <graceMs> <program> [args...]`; `ennyn lock`
 * (core/heavy-lock.mjs) runs its heavy jobs through it the same way.
 *
 * The command runs in a process group of its own (`detached`), with pipes of its own that this process relays to its
 * stdout and stderr. At the limit its group gets SIGTERM, so a wrapper that forwards it (`npm run`) and a worker that
 * cleans up on it (a lock file) do so; `graceMs` later the group gets SIGKILL, which nothing in it can ignore. A
 * SIGKILL to the command alone would leave what it started running with no limit (measured: `npm run` and a shell
 * script without `exec`, npm 10.9.9, Node 22.23.4) (not by a test: no record).
 *
 * When the command itself ends, before the limit, that end is the result: the output it wrote is relayed for at most
 * SETTLE_MS more, then the end is said and the relay stops, so a process the command left (one that left the group,
 * `setsid`, too) holds only this process's pipe, never the table's. What is left of the group is then stopped as at the
 * limit (SIGTERM, `graceMs`, SIGKILL) and said apart (`left: stopped`), without making the end a timeout. A process
 * that left the group is not reached.
 *
 * Windows has no process groups: `detached` there gives the command a console of its own and no group. At the limit
 * the command's tree is stopped by taskkill /T /F (stopTree), with no SIGTERM first; nothing is stopped after the
 * command's own end (unmeasured on Windows).
 *
 * File descriptor 3 gets `pid N` first, then the end, `exit N`, `signal NAME`, `stopped` (the limit ended it),
 * `interrupted NAME` (a signal to this process ended it) or `error CODE`, and after it `left: stopped` when the group
 * had processes left at the command's end.
 */
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { stopTree } from "../core/git.mjs";

/** How often the group is asked whether it still has a process, in ms. */
const POLL_MS = 50;
/**
 * How long the output the command wrote before it ended has to arrive, once it has ended: it is in the pipe already,
 * and the relay reads it in a few turns of the event loop; a pipe a left process holds open is not waited for longer.
 */
const SETTLE_MS = 500;

/** @param {string} line */
const say = (line) => {
  try {
    writeSync(3, `${line}\n`);
  } catch {
    // No descriptor 3: run by hand.
  }
};

/** Whether the group led by `pid` still has a process. @param {number} pid */
function groupLives(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

const [limitMs, graceMs] = process.argv.slice(2, 4).map(Number);
const [program, ...args] = process.argv.slice(4);
const windows = process.platform === "win32";
const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], detached: !windows });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let stopped = false;
/** @type {NodeJS.Timeout | undefined} */
let hard;

/** @param {NodeJS.Signals} signal */
function signalGroup(signal) {
  if (child.pid === undefined) return;
  try {
    if (windows) stopTree(child.pid);
    else process.kill(-child.pid, signal);
  } catch {
    // The group is gone.
  }
}

/** SIGTERM to the group, SIGKILL `graceMs` later. */
function stopGroup() {
  signalGroup("SIGTERM");
  hard = setTimeout(() => signalGroup("SIGKILL"), graceMs);
}

const soft = setTimeout(() => {
  stopped = true;
  stopGroup();
}, limitMs);

/**
 * A SIGINT, SIGTERM or SIGHUP to this process (Ctrl-C, a caller that stops it) stops the group as at the limit, and
 * the end says `interrupted NAME`: the group left the caller's, so the signal does not reach it, and ended here
 * without this the command would run on with no limit.
 * @type {NodeJS.Signals | null}
 */
let asked = null;
/** @param {NodeJS.Signals} signal */
function interrupt(signal) {
  if (stopped || asked) return;
  asked = signal;
  clearTimeout(soft);
  stopGroup();
}
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => interrupt(signal));
// A reader that closed this process's stdout or stderr (`ennyn lock -- npm test | head`) ends the run as SIGPIPE would
// end a command it read from; what the command still writes is dropped, so it does not block on a full pipe.
for (const out of [process.stdout, process.stderr]) {
  out.on("error", () => {
    unrelay();
    interrupt("SIGPIPE");
  });
}

/**
 * The relay stops: what the command's pipes still bring is read and dropped until this process ends. Closing them
 * instead would end a left process that writes on SIGPIPE before it can clean up (measured: a shell worker reporting
 * its killed sleep on stderr died so, its lock left, macOS).
 */
function unrelay() {
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.unpipe();
    pipe.resume();
  }
}

/** The end is said; what is left of the group is stopped and waited for, then this process ends. @param {string} how */
function finish(how) {
  clearTimeout(soft);
  unrelay();
  say(stopped ? "stopped" : asked ? `interrupted ${asked}` : how);
  const pid = child.pid;
  if (windows || pid === undefined || !groupLives(pid)) return done();
  // Left by the command in its group: stopped as at the limit, said apart from the end.
  if (!stopped && !asked) {
    say("left: stopped");
    stopGroup();
  }
  const poll = setInterval(() => {
    if (groupLives(pid)) return;
    clearInterval(poll);
    done();
  }, POLL_MS);
}

function done() {
  clearTimeout(hard);
  // The relay's last writes reach the table before this process ends.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(0)));
}

if (child.pid !== undefined) say(`pid ${child.pid}`);
child.on("error", (e) => {
  clearTimeout(soft);
  say(`error ${/** @type {NodeJS.ErrnoException} */ (e).code ?? "unknown"}`);
  process.exit(0);
});
child.on("exit", (code, signal) => {
  const how = signal ? `signal ${signal}` : `exit ${code}`;
  let ended = false;
  const settle = () => {
    if (ended) return;
    ended = true;
    finish(how);
  };
  // Its output is all read once both pipes close; a pipe a left process holds gets SETTLE_MS.
  let open = 2;
  for (const pipe of [child.stdout, child.stderr]) pipe.once("close", () => --open === 0 && settle());
  if (child.stdout.closed && child.stderr.closed) settle();
  setTimeout(settle, SETTLE_MS);
});
