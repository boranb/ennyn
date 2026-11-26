/**
 * `ennyn lock -- <command>` (core/heavy-lock.mjs): one queue a machine, in the layout of the hand-written locked.sh
 * (a copy in __fixtures__, its folder from ENNYN_LOCK_DIR), each run under a time limit that stops its whole
 * process group, a dead holder's lock dropped by fact. Every lock folder is a temporary one; every process a test
 * signals is one the test started, or one a process it started started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_MAX, OLD_LOCK_MS, ROOM_DEFAULTS, deadLock, dropRecorded, judgeRoom, processStart, readRoom, roomThresholds, runLocked } from "../plugin/core/heavy-lock.mjs";

const CLI = fileURLToPath(new URL("../plugin/scripts/ennyn.mjs", import.meta.url));
const LOCKED_SH = fileURLToPath(new URL("__fixtures__/locked.sh", import.meta.url));

/**
 * Processes and groups the tests started, by pid and start, stopped when a test ends however it ended: one whose
 * start reads otherwise by then is another process, never signalled.
 * @type {Map<number, { start: string | null, group: boolean }>}
 */
const started = new Map();

/** @param {number} pid @param {boolean} [group] a group the test's runs lead */
function track(pid, group = false) {
  try {
    started.set(pid, { start: processStart(pid), group });
  } catch {
    // Its start cannot be read: never signalled.
  }
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {import("node:test").TestContext} t */
function box(t) {
  // Its real path: the command reports its cwd as the process reads it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-lock-")));
  t.after(() => {
    for (const [pid, { start, group }] of started) {
      try {
        if (start !== null && processStart(pid) === start) process.kill(group ? -pid : pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
    started.clear();
  });
  return { dir, lock: join(dir, "lock") };
}

/**
 * Thresholds no machine falls short of, for the runs that test the queue, not the room: the test machine may be short.
 * The room itself is tested with readings given to runLocked, never by filling the machine.
 */
const ANY_ROOM = { ENNYN_LOCK_MIN_MEMORY: "0", ENNYN_LOCK_MAX_LOAD: "1000", ENNYN_LOCK_MIN_DISK: "0" };
/** A machine with room. @returns {import("../plugin/core/heavy-lock.mjs").Room} */
const roomy = () => ({ memory: { value: 50 }, swap: { value: 0 }, load: { value: 0.1 }, disk: [{ dir: "/tmp", read: { value: 100 } }] });

/**
 * A process the test starts, with its output gathered and its end awaited.
 * @param {string} program @param {string[]} args @param {{ cwd: string, lock: string }} at
 */
function run(program, args, { cwd, lock }) {
  const child = spawn(program, args, { cwd, env: { ...process.env, ...ANY_ROOM, ENNYN_LOCK_DIR: lock }, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid !== undefined) track(child.pid);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  /** @type {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, at: number }>} */
  const ended = new Promise((done) => child.on("close", (code, signal) => done({ code, signal, stdout, stderr, at: performance.now() })));
  return { child, ended };
}

/** `ennyn lock` with these arguments. @param {string[]} args @param {{ cwd: string, lock: string }} at */
const lock = (args, at) => run(process.execPath, [CLI, "lock", ...args], at);

/** A node command that writes `text` to the end of `file`. @param {string} file @param {string} text */
const append = (file, text) => [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${text}\n`)})`];

/** A node command that waits until `file` exists. @param {string} file */
const holdUntil = (file) => [process.execPath, "-e", `const f = ${JSON.stringify(file)}; const t = setInterval(() => require("fs").existsSync(f) && clearInterval(t), 20);`];

/** A shell that writes its pid and its child's, then waits on the child: no exec, so the child is not the command. */
const HANG = ["sh", "-c", 'echo $$ > sh.pid; sleep 300 & echo $! > sleep.pid; wait; true'];

/** Waits until `f` gives a value; a wait that ends at the limit fails the test with what it waited for. */
async function until(/** @type {() => any} */ f, /** @type {string} */ what, limitMs = 60_000) {
  const end = performance.now() + limitMs;
  for (;;) {
    const v = f();
    if (v) return v;
    if (performance.now() > end) throw new Error(`no ${what} in ${limitMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The holder record, once it names the run's group. @param {string} lock */
function record(lock) {
  try {
    const r = JSON.parse(readFileSync(join(lock, "suite.lock.holder"), "utf8"));
    return r.group ? r : null;
  } catch {
    return null;
  }
}

/** The tickets waiting. @param {string} lock */
const tickets = (lock) => (existsSync(join(lock, "queue")) ? readdirSync(join(lock, "queue")) : []);

/** The pid a file holds, once it holds one. @param {string} file */
const pidIn = (file) => until(() => Number((existsSync(file) && readFileSync(file, "utf8").trim()) || 0), file);

/** deadLock's verdict without the record's text. @param {string} dir @param {string} holderPath */
function judged(dir, holderPath) {
  const d = deadLock(dir, holderPath);
  return d && d.why === "holder" ? { why: d.why, pid: d.pid } : d;
}

/** The log's lines. @param {string} lock */
const logLines = (lock) => readFileSync(join(lock, "lock.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("lock: at the limit the run's whole group stops, the lock is released, and the waiter queued behind runs", async (t) => {
  const at = box(t);
  const holder = lock(["--limit", "0.03", "--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  const sh = await pidIn(join(at.dir, "sh.pid"));
  const sleeper = await pidIn(join(at.dir, "sleep.pid"));
  track(rec.group, true);
  track(sh);
  track(sleeper);
  const ran = join(at.dir, "ran");
  const waiter = lock(["--", ...append(ran, "waiter")], { cwd: at.dir, lock: at.lock });
  const h = await holder.ended;
  assert.equal(h.code, 124, h.stderr);
  assert.match(h.stderr, /stopped at its limit/);
  // The shell was the command, its sleep a child of it: neither runs on.
  assert.deepEqual([alive(sh), alive(sleeper), alive(rec.runner.pid)], [false, false, false]);
  const w = await waiter.ended;
  assert.equal(w.code, 0, w.stderr);
  assert.equal(readFileSync(ran, "utf8"), "waiter\n");
  assert.ok(!existsSync(join(at.lock, "suite.lock")) && !existsSync(join(at.lock, "suite.lock.holder")), "lock and record released");
  const [first, second] = logLines(at.lock);
  assert.equal(first.end, "stopped");
  assert.equal(first.command, HANG.join(" "));
  assert.equal(first.cwd, at.dir);
  assert.ok(first.ranMs >= 0.03 * 60_000 * 0.9, `ran ${first.ranMs} ms`);
  assert.equal(second.end, "exit 0");
  assert.ok(second.waitedMs > 0);
});

test("lock: waiters take their turns in the order they came, an ennyn waiter and a locked.sh waiter alike", async (t) => {
  const at = box(t);
  const order = join(at.dir, "order");
  const release = join(at.dir, "release");
  const holder = lock(["--", ...holdUntil(release)], { cwd: at.dir, lock: at.lock });
  await until(() => record(at.lock), "holder record");
  const first = run("sh", [LOCKED_SH, ...append(order, "locked.sh")], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 1, "first ticket");
  const second = lock(["--", ...append(order, "ennyn")], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 2, "second ticket");
  writeFileSync(release, "");
  assert.equal((await holder.ended).code, 0);
  assert.equal((await first.ended).code, 0);
  assert.equal((await second.ended).code, 0);
  assert.equal(readFileSync(order, "utf8"), "locked.sh\nennyn\n");

  // The other way round: a locked.sh holder writes no record, and an ennyn waiter waits for it, never dropping it.
  const again = join(at.dir, "release-2");
  const shHolder = run("sh", [LOCKED_SH, ...holdUntil(again)], { cwd: at.dir, lock: at.lock });
  await until(() => existsSync(join(at.lock, "suite.lock")) && tickets(at.lock).length === 0, "locked.sh holding");
  const waiter = lock(["--", ...append(order, "after")], { cwd: at.dir, lock: at.lock });
  const waiting = await until(() => tickets(at.lock).length === 1, "waiter's ticket");
  assert.ok(waiting && !existsSync(join(at.lock, "suite.lock.holder")));
  writeFileSync(again, "");
  assert.equal((await shHolder.ended).code, 0);
  const w = await waiter.ended;
  assert.equal(w.code, 0, w.stderr);
  assert.doesNotMatch(w.stderr, /dropped/);
  assert.equal(readFileSync(order, "utf8"), "locked.sh\nennyn\nafter\n");
});

test("lock: a holder killed with its runner and its run leaves a lock the next waiter drops at once", async (t) => {
  const at = box(t);
  const holder = lock(["--limit", "10", "--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  track(rec.group, true);
  const ran = join(at.dir, "ran");
  const waiter = lock(["--", ...append(ran, "waiter")], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 1, "waiter's ticket");
  const killed = performance.now();
  process.kill(holder.child.pid ?? 0, "SIGKILL");
  process.kill(rec.runner.pid, "SIGKILL");
  process.kill(-rec.group, "SIGKILL");
  const w = await waiter.ended;
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stderr, new RegExp(`dropped the lock of a run that is gone \\(pid ${holder.child.pid}\\)`));
  // The limit was ten minutes: the drop came from the holder's death, not from its limit.
  assert.ok(w.at - killed < 5 * 60_000, `${w.at - killed} ms`);
  assert.equal(readFileSync(ran, "utf8"), "waiter\n");
});

test("lock: a holder killed alone leaves its runner holding the run to its limit, and the lock goes with the run", async (t) => {
  const at = box(t);
  const holder = lock(["--limit", "0.03", "--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  const sleeper = await pidIn(join(at.dir, "sleep.pid"));
  track(rec.group, true);
  track(sleeper);
  const ran = join(at.dir, "ran");
  const waiter = lock(["--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ran)}, String(${sleeper}))`], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 1, "waiter's ticket");
  process.kill(holder.child.pid ?? 0, "SIGKILL");
  const w = await waiter.ended;
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stderr, /dropped the lock of a run that is gone/);
  // When the waiter ran, the run it waited for was gone: its sleep too.
  assert.equal(alive(sleeper), false);
  assert.equal(alive(rec.runner.pid), false);
});

test("lock: a ticket whose process is gone is dropped from the queue, as locked.sh drops it", async (t) => {
  const at = box(t);
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  const stale = `0000000001.000000-${gone.child.pid}`;
  writeFileSync(join(at.lock, "queue", stale), "");
  const r = await lock(["--", "true"], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tickets(at.lock), []);
});

test("lock: a runner killed alone takes its run's group with it, and the lock is released", async (t) => {
  const at = box(t);
  const holder = lock(["--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  const sleeper = await pidIn(join(at.dir, "sleep.pid"));
  track(rec.group, true);
  track(sleeper);
  process.kill(rec.runner.pid, "SIGKILL");
  const h = await holder.ended;
  assert.equal(h.code, 1, h.stderr);
  // SIGKILL leaves a zombie until its new parent reaps it.
  await until(() => !alive(sleeper), "the run's sleep gone");
  assert.ok(!existsSync(join(at.lock, "suite.lock")));
  assert.equal(logLines(at.lock).at(-1).end, "runner SIGKILL");
});

test("lock: a dead lock is read by fact: the holder's pid and start, the run's group and its deadline, the lock's own identity", async (t) => {
  const at = box(t);
  mkdirSync(at.lock, { recursive: true });
  const dir = join(at.lock, "suite.lock");
  const holderPath = join(at.lock, "suite.lock.holder");
  mkdirSync(dir);
  // No record: locked.sh's lock, dropped only past 120 minutes.
  assert.equal(deadLock(dir, holderPath), null);
  const old = (Date.now() - OLD_LOCK_MS - 60_000) / 1000;
  utimesSync(dir, old, old);
  assert.deepEqual(deadLock(dir, holderPath), { why: "old" });
  const now = (Date.now()) / 1000;
  utimesSync(dir, now, now);
  const st = statSync(dir, { bigint: true });
  const id = `${st.ino}-${st.mtimeNs}`;
  const me = { pid: process.pid, start: processStart(process.pid) };
  const put = (/** @type {object} */ r) => writeFileSync(holderPath, JSON.stringify({ v: 1, runner: null, group: null, deadline: Date.now() + 60_000, lock: id, ...r }));
  put({ holder: me });
  assert.equal(deadLock(dir, holderPath), null, "a living holder");
  put({ holder: { pid: process.pid, start: "another start" } });
  assert.deepEqual(judged(dir, holderPath), { why: "holder", pid: process.pid }, "a pid given again is another process");
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  const dead = { pid: gone.child.pid, start: "x" };
  put({ holder: dead, runner: me });
  assert.equal(deadLock(dir, holderPath), null, "a living runner");
  put({ holder: dead, runner: { pid: gone.child.pid, start: null } });
  assert.deepEqual(judged(dir, holderPath), { why: "holder", pid: gone.child.pid }, "a runner recorded with no start, gone");
  // A group left with no holder and no runner holds the lock until its deadline.
  const group = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  track(group.pid ?? 0, true);
  put({ holder: dead, group: group.pid });
  assert.equal(deadLock(dir, holderPath), null, "the run's group before its deadline");
  put({ holder: dead, group: group.pid, deadline: Date.now() - 1 });
  assert.deepEqual(judged(dir, holderPath), { why: "holder", pid: gone.child.pid }, "the run's group past its deadline");
  // A record of another lock (a dead run's, left beside a lock taken since) is no record of this one.
  put({ holder: dead, lock: `${id}0` });
  assert.equal(deadLock(dir, holderPath), null);
  writeFileSync(holderPath, "{not json");
  assert.equal(deadLock(dir, holderPath), null);
});

test("lock: a signal to the lock stops its run's group and releases the lock; one to a waiter takes its ticket away", async (t) => {
  const at = box(t);
  const holder = lock(["--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  const sleeper = await pidIn(join(at.dir, "sleep.pid"));
  track(rec.group, true);
  track(sleeper);
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 1, "waiter's ticket");
  waiter.child.kill("SIGTERM");
  assert.equal((await waiter.ended).code, 143);
  assert.deepEqual(tickets(at.lock), []);
  holder.child.kill("SIGTERM");
  const h = await holder.ended;
  assert.equal(h.code, 143, h.stderr);
  assert.equal(alive(sleeper), false);
  assert.ok(!existsSync(join(at.lock, "suite.lock")));
  assert.equal(logLines(at.lock).at(-1).end, "interrupted SIGTERM");
});

test("lock: the run's exit is the command's, 127 for a program not found, and a closed stdout ends the run as SIGPIPE", async (t) => {
  const at = box(t);
  assert.equal((await lock(["--", "sh", "-c", "exit 7"], { cwd: at.dir, lock: at.lock }).ended).code, 7);
  assert.equal((await lock(["--", join(at.dir, "no-such-program")], { cwd: at.dir, lock: at.lock }).ended).code, 127);
  const loud = lock(["--", "sh", "-c", 'echo $$ > loud.pid; while :; do echo line; done'], { cwd: at.dir, lock: at.lock });
  const pid = await pidIn(join(at.dir, "loud.pid"));
  track(pid);
  loud.child.stdout.destroy();
  const l = await loud.ended;
  assert.equal(l.code, 141, l.stderr);
  assert.doesNotMatch(l.stderr, /EPIPE|at /);
  assert.equal(alive(pid), false);
  assert.deepEqual(logLines(at.lock).map((e) => e.end), ["exit 7", "error ENOENT", "interrupted SIGPIPE"]);
});

test("lock: the log moves aside past its bound, so it never grows without end", async (t) => {
  const at = box(t);
  mkdirSync(at.lock, { recursive: true });
  writeFileSync(join(at.lock, "lock.log"), "x".repeat(LOG_MAX + 1));
  assert.equal((await lock(["--", "true"], { cwd: at.dir, lock: at.lock }).ended).code, 0);
  assert.equal(statSync(join(at.lock, "lock.log.1")).size, LOG_MAX + 1);
  assert.equal(logLines(at.lock).length, 1);
});

test("lock: usage: a command after --, a limit above 0 and at most 600 minutes", async (t) => {
  const at = box(t);
  for (const args of [[], ["true"], ["--"], ["--limit", "0", "--", "true"], ["--limit", "601", "--", "true"], ["--limit", "ten", "--", "true"], ["--limit", "-1", "--", "true"]]) {
    const r = await lock(args, { cwd: at.dir, lock: at.lock }).ended;
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.ok(!existsSync(at.lock), "a usage error takes no ticket");
});

/** A node command that notes its start and end in `file`, `ms` apart: runs that overlap show in it. */
const job = (/** @type {string} */ file, /** @type {string} */ name, ms = 300) => [
  process.execPath,
  "-e",
  `const fs = require("fs"); const f = ${JSON.stringify(file)}; fs.appendFileSync(f, ${JSON.stringify(name)} + " start " + (performance.timeOrigin + performance.now()) + "\\n"); setTimeout(() => fs.appendFileSync(f, ${JSON.stringify(name)} + " end " + (performance.timeOrigin + performance.now()) + "\\n"), ${ms});`,
];

/** The runs `file` noted, each with its start and end, and the pairs that ran at once. @param {string} file */
function spans(file) {
  /** @type {Record<string, { start: number, end: number }>} */
  const s = {};
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const [name, kind, at] = line.split(" ");
    (s[name] ??= { start: NaN, end: NaN })[/** @type {"start" | "end"} */ (kind)] = Number(at);
  }
  const names = Object.keys(s).sort((a, b) => s[a].start - s[b].start);
  const together = names.slice(1).filter((n, i) => !(s[names[i]].end <= s[n].start));
  return { names, together };
}

test("lock: any ennyn waiter drops a dead ennyn holder's lock, also behind a locked.sh waiter at the head of the queue", async (t) => {
  const at = box(t);
  const order = join(at.dir, "order");
  const holder = lock(["--limit", "10", "--", ...HANG], { cwd: at.dir, lock: at.lock });
  const rec = await until(() => record(at.lock), "holder record");
  track(rec.group, true);
  const first = run("sh", [LOCKED_SH, ...append(order, "locked.sh")], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 1, "locked.sh's ticket");
  const second = lock(["--", ...append(order, "ennyn")], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 2, "ennyn's ticket");
  process.kill(holder.child.pid ?? 0, "SIGKILL");
  process.kill(rec.runner.pid, "SIGKILL");
  process.kill(-rec.group, "SIGKILL");
  assert.equal((await first.ended).code, 0);
  const s = await second.ended;
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stderr, /dropped the lock of a run that is gone/);
  assert.equal(readFileSync(order, "utf8"), "locked.sh\nennyn\n");
});

test("lock: two ennyn waiters and a locked.sh waiter behind a dead holder's lock run one at a time", async (t) => {
  const at = box(t);
  const notes = join(at.dir, "notes");
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  mkdirSync(join(at.lock, "suite.lock"), { recursive: true });
  const st = statSync(join(at.lock, "suite.lock"), { bigint: true });
  writeFileSync(join(at.lock, "suite.lock.holder"), JSON.stringify({ v: 1, holder: { pid: gone.child.pid, start: "x" }, runner: null, group: null, deadline: 0, lock: `${st.ino}-${st.mtimeNs}` }));
  const all = [lock(["--", ...job(notes, "e1")], { cwd: at.dir, lock: at.lock }), lock(["--", ...job(notes, "e2")], { cwd: at.dir, lock: at.lock }), run("sh", [LOCKED_SH, ...job(notes, "sh")], { cwd: at.dir, lock: at.lock })];
  const ends = await Promise.all(all.map((p) => p.ended));
  assert.deepEqual(ends.map((e) => e.code), [0, 0, 0], ends.map((e) => e.stderr).join("\n"));
  const { names, together } = spans(notes);
  assert.deepEqual([...names].sort(), ["e1", "e2", "sh"]);
  assert.deepEqual(together, [], "runs that overlapped");
});

test("lock: a holder whose lock was taken from under it leaves the new lock alone and says so", async (t) => {
  const at = box(t);
  const release = join(at.dir, "release");
  const holder = lock(["--", ...holdUntil(release)], { cwd: at.dir, lock: at.lock });
  await until(() => record(at.lock), "holder record");
  // What locked.sh's 120-minute rule does: rmdir; then another waiter takes the lock anew.
  rmdirSync(join(at.lock, "suite.lock"));
  mkdirSync(join(at.lock, "suite.lock"));
  writeFileSync(release, "");
  const h = await holder.ended;
  assert.equal(h.code, 0, h.stderr);
  assert.match(h.stderr, /not released: it is no longer this run's/);
  assert.ok(existsSync(join(at.lock, "suite.lock")), "the new holder's lock stays");
});

test("lock: the holder keeps its lock's mtime fresh while the run lives, so locked.sh never reads it as old", async (t) => {
  const at = box(t);
  const release = join(at.dir, "release");
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  const running = runLocked({ command: holdUntil(release)[0], args: holdUntil(release).slice(1), limitMs: 60_000, cwd: at.dir, env, refreshMs: 100, room: roomy });
  const dir = join(at.lock, "suite.lock");
  await until(() => record(at.lock), "holder record");
  const first = statSync(dir, { bigint: true }).mtimeNs;
  // The lock's identity holds its mtime, so the age locked.sh reads cannot be set back from outside here: the test
  // waits for the holder to move the mtime on by itself.
  await until(() => statSync(dir, { bigint: true }).mtimeNs > first, "a later mtime");
  // The record follows the lock's new identity: a waiter still reads it as the living holder's.
  await until(() => deadLock(dir, join(at.lock, "suite.lock.holder")) === null && JSON.parse(readFileSync(join(at.lock, "suite.lock.holder"), "utf8")).lock === `${statSync(dir, { bigint: true }).ino}-${statSync(dir, { bigint: true }).mtimeNs}`, "the record of the refreshed lock");
  writeFileSync(release, "");
  assert.equal(await running, 0);
  assert.ok(!existsSync(dir));
});

test("lock: a dead lock that cannot be removed is said once, waited on, and a signal still ends the waiter", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "left"), "");
  const old = (Date.now() - OLD_LOCK_MS - 60_000) / 1000;
  utimesSync(dir, old, old);
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  let said = "";
  waiter.child.stderr.on("data", (b) => (said += b));
  await until(() => /could not be removed/.test(said), "the failed drop said");
  // Two more turns of the wait: a waiter that spun would have said it many times by now.
  const twice = performance.now();
  await until(() => performance.now() - twice > 1200, "two polls");
  waiter.child.kill("SIGTERM");
  const w = await waiter.ended;
  assert.equal(w.code, 143);
  assert.equal(w.stderr.match(/could not be removed/g)?.length, 1, w.stderr);
});

test("lock: an ennyn ticket whose pid now names a later process is dropped; a locked.sh ticket goes by its pid alone", async (t) => {
  const at = box(t);
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  const other = spawn("sleep", ["300"], { stdio: "ignore" });
  track(other.pid ?? 0);
  const name = `0000000001.000000-${other.pid}`;
  writeFileSync(join(at.lock, "queue", name), "a start that is not this process's");
  const r = await lock(["--", "true"], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tickets(at.lock), []);
  // The same pid in a ticket with nothing in it, as locked.sh writes: kept while the pid lives.
  writeFileSync(join(at.lock, "queue", name), "");
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 2, "the waiter behind it");
  assert.equal(waiter.child.exitCode, null);
  other.kill("SIGKILL");
  assert.equal((await waiter.ended).code, 0);
});

test("lock: a holder record that cannot be written releases the lock and leaves no temporary file", async (t) => {
  const at = box(t);
  // A directory with something in it where the record goes: the rename onto it fails.
  mkdirSync(join(at.lock, "suite.lock.holder"), { recursive: true });
  writeFileSync(join(at.lock, "suite.lock.holder", "x"), "");
  const r = await lock(["--", "true"], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(r.code, 1, r.stderr);
  assert.ok(!existsSync(join(at.lock, "suite.lock")), "the lock released");
  assert.deepEqual(readdirSync(at.lock).filter((n) => n.startsWith("suite.lock.holder.")), []);
});

test("lock: a drop is claimed by renaming the record, and only the record judged, of the lock still there, is dropped", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  const holderPath = join(at.lock, "suite.lock.holder");
  mkdirSync(dir, { recursive: true });
  const st = () => statSync(dir, { bigint: true });
  const text = JSON.stringify({ v: 1, holder: { pid: 1, start: "x" }, lock: `${st().ino}-${st().mtimeNs}` });
  // A record that is not the one judged (a new holder wrote it meanwhile): put back, the lock kept.
  writeFileSync(holderPath, text.replace('"x"', '"y"'));
  assert.equal(dropRecorded(dir, holderPath, text), "lost");
  assert.ok(existsSync(dir) && readFileSync(holderPath, "utf8").includes('"y"'));
  assert.deepEqual(readdirSync(at.lock).filter((n) => n.includes(".drop-")), []);
  // The record judged, of another lock (the lock taken anew): put back, the lock kept.
  const other = JSON.stringify({ v: 1, holder: { pid: 1, start: "x" }, lock: "1-2" });
  writeFileSync(holderPath, other);
  assert.equal(dropRecorded(dir, holderPath, other), "lost");
  assert.ok(existsSync(dir) && existsSync(holderPath));
  // The record judged, of this lock: the lock and the record go, and a second drop finds nothing to claim.
  writeFileSync(holderPath, text);
  assert.equal(dropRecorded(dir, holderPath, text), "dropped");
  assert.ok(!existsSync(dir) && !existsSync(holderPath));
  assert.equal(dropRecorded(dir, holderPath, text), "lost");
});

test("lock: a lock with no record of its own, old, is dropped by the first ticket only", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  mkdirSync(dir);
  const old = (Date.now() - OLD_LOCK_MS - 60_000) / 1000;
  utimesSync(dir, old, old);
  // A locked.sh waiter ahead, alive.
  const ahead = spawn("sleep", ["300"], { stdio: "ignore" });
  track(ahead.pid ?? 0);
  writeFileSync(join(at.lock, "queue", `0000000001.000000-${ahead.pid}`), "");
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 2, "the waiter's ticket");
  // The waiter's ticket holds its start, as processStart reads it.
  const own = tickets(at.lock).find((n) => n.endsWith(`-${waiter.child.pid}`)) ?? "";
  await until(() => readFileSync(join(at.lock, "queue", own), "utf8") !== "", "the ticket's start");
  assert.equal(readFileSync(join(at.lock, "queue", own), "utf8"), processStart(waiter.child.pid ?? 0));
  const since = performance.now();
  await until(() => performance.now() - since > 1500, "three polls");
  assert.ok(existsSync(dir), "a waiter behind the first left the old lock alone");
  ahead.kill("SIGKILL");
  const w = await waiter.ended;
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stderr, /older than 120 minutes/);
});

test("lock: a record that names another process with this pid is not this run's, and the lock is left", async (t) => {
  const at = box(t);
  const release = join(at.dir, "release");
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  const said = [];
  const running = runLocked({ command: holdUntil(release)[0], args: holdUntil(release).slice(1), limitMs: 60_000, cwd: at.dir, env, say: (s) => said.push(s.key), room: roomy });
  const rec = await until(() => record(at.lock), "holder record");
  writeFileSync(join(at.lock, "suite.lock.holder"), JSON.stringify({ ...rec, holder: { pid: process.pid, start: "another start" } }));
  writeFileSync(release, "");
  assert.equal(await running, 0);
  assert.ok(said.includes("lock.notReleased"), said.join(" "));
  assert.ok(existsSync(join(at.lock, "suite.lock")));
});

test("lock: a record that cannot be read at release leaves the lock, and says it could not be read", async (t) => {
  const at = box(t);
  const release = join(at.dir, "release");
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  const said = [];
  const running = runLocked({ command: holdUntil(release)[0], args: holdUntil(release).slice(1), limitMs: 60_000, cwd: at.dir, env, say: (s) => said.push(s.key), room: roomy });
  await until(() => record(at.lock), "holder record");
  const holderPath = join(at.lock, "suite.lock.holder");
  rmSync(holderPath);
  mkdirSync(holderPath);
  writeFileSync(join(holderPath, "x"), "");
  writeFileSync(release, "");
  assert.equal(await running, 0);
  assert.deepEqual(said.filter((k) => k.startsWith("lock.release") || k === "lock.notReleased"), ["lock.releaseUnread"]);
  assert.ok(existsSync(join(at.lock, "suite.lock")));
});

test("lock: where links do not exist, a claim goes back by rename, and one that cannot go back is left, never removed", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  const holderPath = join(at.lock, "suite.lock.holder");
  mkdirSync(dir, { recursive: true });
  const st = () => statSync(dir, { bigint: true });
  const text = JSON.stringify({ v: 1, holder: { pid: 1, start: "x" }, lock: `${st().ino}-${st().mtimeNs}` });
  const noLinks = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  const claims = () => readdirSync(at.lock).filter((n) => n.includes(".drop-"));
  // Not the record judged: back by rename.
  writeFileSync(holderPath, text.replace('"x"', '"y"'));
  assert.equal(dropRecorded(dir, holderPath, text, noLinks), "lost");
  assert.ok(readFileSync(holderPath, "utf8").includes('"y"'));
  assert.deepEqual(claims(), []);
  // A lock that cannot be removed: the record back by rename, the error said.
  // (A file in the lock moves its mtime, so the record judged names the lock as it is now.)
  writeFileSync(join(dir, "left"), "");
  const full = JSON.stringify({ v: 1, holder: { pid: 1, start: "x" }, lock: `${st().ino}-${st().mtimeNs}` });
  writeFileSync(holderPath, full);
  const r = dropRecorded(dir, holderPath, full, noLinks);
  assert.ok(r instanceof Error, String(r));
  assert.equal(readFileSync(holderPath, "utf8"), full);
  assert.deepEqual(claims(), []);
  rmSync(join(dir, "left"));
  // A record written at its path meanwhile: the claim cannot go back over it and is left where it is.
  writeFileSync(holderPath, text.replace('"x"', '"y"'));
  const meanwhile = () => {
    writeFileSync(holderPath, "a new holder's record");
    noLinks();
  };
  const left = dropRecorded(dir, holderPath, text, meanwhile);
  assert.ok(typeof left === "object" && "left" in left, String(left));
  assert.equal(readFileSync(holderPath, "utf8"), "a new holder's record");
  assert.equal(readFileSync(left.left, "utf8"), text.replace('"x"', '"y"'));
  assert.ok(existsSync(dir));
});

test("lock: a waiter reads a record's start once and asks its pid alone while the record's bytes stay the same", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  const holderPath = join(at.lock, "suite.lock.holder");
  mkdirSync(dir, { recursive: true });
  const st = statSync(dir, { bigint: true });
  const living = JSON.stringify({ v: 1, holder: { pid: process.pid, start: processStart(process.pid) }, runner: null, group: null, deadline: Date.now() + 60_000, lock: `${st.ino}-${st.mtimeNs}` });
  writeFileSync(holderPath, living);
  const memo = { text: "", pids: /** @type {number[]} */ ([]), at: 0 };
  assert.equal(deadLock(dir, holderPath, Date.now(), memo), null);
  assert.deepEqual({ text: memo.text, pids: memo.pids }, { text: living, pids: [process.pid] });
  // A start that no longer matches, under the bytes the memo holds: the memo's pid alone is asked, and it lives.
  const forged = living.replace(/"start":"[^"]*"/, '"start":"another"');
  assert.equal(deadLock(dir, holderPath, Date.now(), { text: forged, pids: [process.pid], at: Date.now() }), null);
  writeFileSync(holderPath, forged);
  assert.equal(deadLock(dir, holderPath, Date.now(), { text: forged, pids: [process.pid], at: Date.now() }), null);
  // Other bytes than the memo's: the start is read again, and the pid given again reads as another process.
  assert.equal(deadLock(dir, holderPath, Date.now(), { text: living, pids: [process.pid], at: Date.now() })?.why, "holder");
  // The memo's pid gone: read again too.
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  assert.equal(deadLock(dir, holderPath, Date.now(), { text: forged, pids: [gone.child.pid ?? 0], at: Date.now() })?.why, "holder");
});

test("lock: a waiter reads an ennyn ticket's start once, and after that its pid alone", async (t) => {
  const at = box(t);
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  const ahead = spawn("sleep", ["300"], { stdio: "ignore" });
  track(ahead.pid ?? 0);
  const name = join(at.lock, "queue", `0000000001.000000-${ahead.pid}`);
  await until(() => processStart(ahead.pid ?? 0), "the sleep's start");
  writeFileSync(name, processStart(ahead.pid ?? 0) ?? "");
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  let said = "";
  waiter.child.stderr.on("data", (b) => (said += b));
  await until(() => /waiting/.test(said), "the waiter waiting behind the ticket");
  // The start the waiter read once matched; another start now is not read again: the ticket stays while its pid lives.
  writeFileSync(name, "another start");
  const since = performance.now();
  await until(() => performance.now() - since > 1500, "three polls");
  assert.ok(existsSync(name));
  assert.equal(waiter.child.exitCode, null);
  ahead.kill("SIGKILL");
  assert.equal((await waiter.ended).code, 0);
});

test("lock: a waiter whose ticket another waiter removed ends, saying so, and never waits for a turn that cannot come", async (t) => {
  const at = box(t);
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  // A locked.sh waiter ahead, alive: the waiter waits behind it.
  const ahead = spawn("sleep", ["300"], { stdio: "ignore" });
  track(ahead.pid ?? 0);
  writeFileSync(join(at.lock, "queue", `0000000001.000000-${ahead.pid}`), "");
  const waiter = lock(["--", "true"], { cwd: at.dir, lock: at.lock });
  await until(() => tickets(at.lock).length === 2, "the waiter's ticket");
  const own = tickets(at.lock).find((n) => n.endsWith(`-${waiter.child.pid}`)) ?? "";
  rmSync(join(at.lock, "queue", own));
  const w = await waiter.ended;
  assert.equal(w.code, 1, w.stderr);
  assert.match(w.stderr, /ticket .* was removed by another waiter/);
  assert.ok(!existsSync(join(at.lock, "suite.lock")), "the lock was never taken");
});

test("lock: a waiter reads the holder's start again once a minute has passed since the last read, and once the deadline has passed", async (t) => {
  const at = box(t);
  const dir = join(at.lock, "suite.lock");
  const holderPath = join(at.lock, "suite.lock.holder");
  mkdirSync(dir, { recursive: true });
  const st = statSync(dir, { bigint: true });
  const t0 = Date.now();
  writeFileSync(holderPath, JSON.stringify({ v: 1, holder: { pid: process.pid, start: "s" }, runner: null, group: null, deadline: t0 + 1000, lock: `${st.ino}-${st.mtimeNs}` }));
  let reads = 0;
  const startOf = () => (reads++, "s");
  const memo = { text: "", pids: /** @type {number[]} */ ([]), at: 0 };
  const how = { rereadMs: 100, startOf };
  assert.equal(deadLock(dir, holderPath, t0, memo, how), null);
  assert.equal(reads, 1);
  assert.equal(deadLock(dir, holderPath, t0 + 50, memo, how), null);
  assert.equal(reads, 1, "within the interval: the pid alone");
  assert.equal(deadLock(dir, holderPath, t0 + 150, memo, how), null);
  assert.equal(reads, 2, "past the interval: the start read again");
  assert.equal(deadLock(dir, holderPath, t0 + 200, memo, how), null);
  assert.equal(reads, 2);
  // Past the record's deadline: read again at every look, whatever the interval.
  assert.equal(deadLock(dir, holderPath, t0 + 1001, memo, { rereadMs: 60_000, startOf }), null);
  assert.equal(deadLock(dir, holderPath, t0 + 1002, memo, { rereadMs: 60_000, startOf }), null);
  assert.equal(reads, 4);
});

test("lock: the queue's sweep judges only ticket-shaped names and leaves every other file where it is", async (t) => {
  const at = box(t);
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  const queue = join(at.lock, "queue");
  mkdirSync(queue, { recursive: true });
  // Files someone left in the queue, each named as no writer names a ticket; the probe of cycle 33 saw them deleted.
  const others = ["notes.txt", "README", "build-output", "2026-report-1", `job-${gone.child.pid}`, `1794654969.818353-${gone.child.pid}.tmp`, `old-0000000001.000000-${gone.child.pid}`, ".hidden"];
  for (const n of others) writeFileSync(join(queue, n), "data\n");
  // A ticket whose waiter is gone is still dropped.
  writeFileSync(join(queue, `0000000001.000000-${gone.child.pid}`), "");
  const r = await lock(["--", ...append(join(at.dir, "ran"), "ran")], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(at.dir, "ran"), "utf8"), "ran\n");
  assert.deepEqual(tickets(at.lock).sort(), [...others].sort());
  for (const n of others) assert.equal(readFileSync(join(queue, n), "utf8"), "data\n", n);
});

test("lock: a queue that is a symbolic link is refused and said: no ticket written, nothing behind it removed, nothing run", async (t) => {
  const at = box(t);
  const gone = run(process.execPath, ["-e", ""], { cwd: at.dir, lock: at.lock });
  await gone.ended;
  const elsewhere = join(at.dir, "elsewhere");
  mkdirSync(elsewhere);
  const kept = ["precious.txt", `0000000001.000000-${gone.child.pid}`];
  for (const n of kept) writeFileSync(join(elsewhere, n), "data\n");
  mkdirSync(at.lock);
  for (const target of [elsewhere, join(at.dir, "nothing")]) {
    rmSync(join(at.lock, "queue"), { force: true });
    symlinkSync(target, join(at.lock, "queue"));
    const r = await lock(["--", ...append(join(at.dir, "ran"), "ran")], { cwd: at.dir, lock: at.lock }).ended;
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /queue .* is a symbolic link/);
    assert.ok(!existsSync(join(at.dir, "ran")), "the command never ran");
    assert.ok(!existsSync(join(at.lock, "suite.lock")), "the lock was never taken");
    assert.deepEqual(readdirSync(elsewhere).sort(), [...kept].sort());
  }
});

/** A reader's file system: the text each path holds, null for none. @param {Record<string, string>} files */
const files = (files) => (/** @type {string} */ path) => files[path] ?? null;
const MEMINFO = "MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:         500000 kB\n";
const DISK = { statfs: () => ({ bavail: 2_500_000, bsize: 4096 }), dirs: ["/t"] };

test("lock room: each platform's readings, as the system prints them, and a reading that fails is unmeasured", () => {
  // macOS: sysctl's two lines, as this machine printed them (kern.memorystatus_level 9, the figure memory_pressure gave).
  const mac = readRoom({ platform: "darwin", run: () => "9\ntotal = 15360.00M  used = 14068.81M  free = 1291.19M  (encrypted)\n", load: () => [6.87, 8.93, 10.58], cpus: 10, ...DISK });
  assert.deepEqual(mac.memory, { value: 9 });
  assert.equal(Number((/** @type {{ value: number }} */ (mac.swap)).value.toFixed(1)), 91.6);
  assert.equal(Number((/** @type {{ value: number }} */ (mac.load)).value.toFixed(3)), 0.687);
  assert.deepEqual(mac.disk, [{ dir: "/t", read: { value: 10.24 } }]);
  // No swap at all is none used.
  assert.deepEqual(readRoom({ platform: "darwin", run: () => "40\ntotal = 0.00M  used = 0.00M  free = 0.00M\n", ...DISK }).swap, { value: 0 });
  // sysctl that fails or prints something else: both unmeasured, never a number.
  for (const out of [null, "", "high\nnothing", "140\ntotal = x"]) {
    const r = readRoom({ platform: "darwin", run: () => out, ...DISK });
    assert.ok("unmeasured" in r.memory && "unmeasured" in r.swap, JSON.stringify(out));
  }
  // Linux: MemAvailable over MemTotal, swap used over SwapTotal (shown, never judged).
  const host = readRoom({ platform: "linux", read: files({ "/proc/meminfo": MEMINFO }), load: () => [3, 0, 0], cpus: 4, ...DISK });
  assert.deepEqual([host.memory, host.swap, host.load], [{ value: 25 }, { value: 75 }, { value: 0.75 }]);
  // In a container whose own limit leaves less, the container's share counts; "max" is no limit.
  const box = (max, current) => readRoom({ platform: "linux", read: files({ "/proc/meminfo": MEMINFO, "/sys/fs/cgroup/memory.max": max, "/sys/fs/cgroup/memory.current": current }), ...DISK }).memory;
  assert.deepEqual(box("1000\n", "900\n"), { value: 10 });
  assert.deepEqual(box("max\n", "900\n"), { value: 25 });
  assert.deepEqual(box("1000\n", "2000\n"), { value: 0 });
  // The inactive page cache in memory.stat is reclaimed by the kernel: not counted as used (a 2 GiB container with
  // 1.5 GiB of it read 5% free). No memory.stat: the use as it stands.
  const G = 2 ** 30;
  const ROOMY = "MemTotal:       16000000 kB\nMemAvailable:   12800000 kB\n";
  const v2 = (/** @type {Record<string, string>} */ more) => readRoom({ platform: "linux", read: files({ "/proc/meminfo": ROOMY, "/sys/fs/cgroup/memory.max": `${2 * G}\n`, "/sys/fs/cgroup/memory.current": `${Math.round(1.9 * G)}\n`, ...more }), ...DISK }).memory;
  const pct = (/** @type {import("../plugin/core/heavy-lock.mjs").Reading} */ r) => Math.round("value" in r ? r.value : NaN);
  assert.equal(pct(v2({ "/sys/fs/cgroup/memory.stat": `anon 1000\ninactive_file ${1 * G}\nactive_file 10\n` })), 55);
  assert.equal(pct(v2({ "/sys/fs/cgroup/memory.stat": `inactive_file ${1.5 * G}\n` })), 80, "the container's share, up to the host's");
  assert.equal(pct(v2({})), 5, "no memory.stat: the use as it stands");
  // cgroup v1: memory/memory.limit_in_bytes and usage_in_bytes, less memory.stat's total_inactive_file; v1's "no limit"
  // is a number past the host's memory, and the host's share counts.
  const v1 = (/** @type {string} */ limit, /** @type {string} */ usage, /** @type {string | undefined} */ stat) =>
    readRoom({ platform: "linux", read: files({ "/proc/meminfo": MEMINFO, "/sys/fs/cgroup/memory/memory.limit_in_bytes": limit, "/sys/fs/cgroup/memory/memory.usage_in_bytes": usage, ...(stat ? { "/sys/fs/cgroup/memory/memory.stat": stat } : {}) }), ...DISK }).memory;
  assert.deepEqual(v1("1000\n", "950\n"), { value: 5 });
  assert.deepEqual(v1("1000\n", "950\n", "cache 900\ntotal_inactive_file 850\n"), { value: 25 });
  assert.deepEqual(v1("9223372036854771712\n", "950\n"), { value: 25 });
  assert.deepEqual(readRoom({ platform: "linux", read: files({ "/proc/meminfo": "MemTotal: 1 kB\nSwapTotal: 0 kB\n" }), ...DISK }).swap, { value: 0 });
  const none = readRoom({ platform: "linux", read: files({}), ...DISK });
  assert.ok("unmeasured" in none.memory && "unmeasured" in none.swap);
  // The load average is the host's: divided by the host's CPUs (os.cpus), never a cpuset's narrower count.
  assert.deepEqual(readRoom({ platform: "linux", read: files({}), load: () => [cpus().length, 0, 0], ...DISK }).load, { value: 1 });
  // Windows: os.freemem over os.totalmem; no load (os.loadavg is always 0 there), no swap.
  const win = readRoom({ platform: "win32", free: () => 4, total: () => 16, load: () => [0, 0, 0], ...DISK });
  assert.deepEqual(win.memory, { value: 25 });
  assert.ok("unmeasured" in win.load && "unmeasured" in win.swap);
  // A load or a disk reading that throws is unmeasured.
  const broken = readRoom({ platform: "darwin", run: () => null, load: () => { throw new Error("no load"); }, statfs: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); }, dirs: ["/a", "/a", "/b"] });
  assert.deepEqual(broken.load, { unmeasured: "no load" });
  assert.deepEqual(broken.disk.map((d) => d.dir), ["/a", "/b"], "a folder named twice is read once");
  assert.ok(broken.disk.every((d) => "unmeasured" in d.read));
});

test("lock room: a reading on its threshold has room, one past it is short, and an unmeasured one is never short", () => {
  const at = (/** @type {Partial<Record<"memory" | "swap" | "load" | "disk", number | string>>} */ v) => {
    const r = (/** @type {number | string | undefined} */ x, /** @type {number} */ d) => (typeof x === "string" ? { unmeasured: x } : { value: x ?? d });
    return judgeRoom({ memory: r(v.memory, 50), swap: r(v.swap, 0), load: r(v.load, 0.1), disk: [{ dir: "/t", read: r(v.disk, 100) }] }, ROOM_DEFAULTS);
  };
  // Accept: on the threshold, or on the right side of it.
  for (const v of [{}, { memory: 15 }, { swap: 100 }, { load: 1.5 }, { disk: 5 }, { memory: 100, swap: 0, load: 0, disk: 1e6 }]) assert.deepEqual(at(v).short, [], JSON.stringify(v));
  // Reject: past it, each alone.
  assert.deepEqual(at({ memory: 14.9 }).short, ["memory 14.9% free (min 15%)"]);
  // Swap is shown, never judged: pages swapped out stay out after the pressure ends (half memory free, 95% swap used).
  assert.deepEqual(at({ memory: 50, swap: 95 }).short, []);
  assert.match(at({ swap: 95 }).text, /swap 95% used \(not judged\)/);
  assert.deepEqual(at({ load: 1.51 }).short, ["load 1.51 per CPU (max 1.5)"]);
  assert.deepEqual(at({ disk: 4.99 }).short, ["disk /t 4.99 GB free (min 5 GB)"]);
  assert.deepEqual(at({ memory: 14.999 }).short, ["memory 15% free (min 15%)"], "a value is shown to two places, judged whole");
  assert.equal(at({ memory: 9, load: 2 }).short.length, 2);
  // Unmeasured: named, never short.
  const u = at({ memory: "sysctl failed", load: "os.loadavg is always 0 on Windows" });
  assert.deepEqual(u.short, []);
  assert.deepEqual(u.unmeasured, ["memory (sysctl failed)", "load (os.loadavg is always 0 on Windows)"]);
  assert.match(u.text, /memory \(sysctl failed\): unmeasured/);
});

test("lock room: thresholds come from the option, else the variable, else the default; a value out of bounds is refused", () => {
  assert.deepEqual(roomThresholds({}, {}), { thresholds: { ...ROOM_DEFAULTS }, set: [] });
  const r = roomThresholds({ "min-memory": "20", "max-load": "1.5" }, { ENNYN_LOCK_MIN_MEMORY: "5", ENNYN_LOCK_MIN_DISK: "0" });
  assert.deepEqual(r.thresholds, { ...ROOM_DEFAULTS, minMemory: 20, minDisk: 0 });
  // Set away from the default: said; the default given again is not.
  assert.deepEqual(r.set, ["--min-memory=20", "ENNYN_LOCK_MIN_DISK=0"]);
  for (const [opts, env] of [[{ "min-memory": "101" }, {}], [{ "min-memory": "-1" }, {}], [{ "max-load": "0" }, {}], [{}, { ENNYN_LOCK_MAX_LOAD: "abc" }], [{}, { ENNYN_LOCK_MIN_DISK: "" }], [{ "min-disk": true }, {}]]) {
    assert.throws(() => roomThresholds(/** @type {any} */ (opts), env), /must be a number/, JSON.stringify([opts, env]));
  }
});

test("lock room: short of room the job keeps its place and waits, says what is short once, and runs once there is room", async (t) => {
  const at = box(t);
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  /** @type {import("../plugin/core/heavy-lock.mjs").Said[]} */
  const said = [];
  let reads = 0;
  const short = { memory: { value: 9 }, swap: { value: 91.6 }, load: { value: 0.7 }, disk: [{ dir: "/t", read: { value: 100 } }] };
  const room = () => (++reads <= 3 ? short : roomy());
  const ran = join(at.dir, "ran");
  const running = runLocked({ command: append(ran, "ran")[0], args: append(ran, "ran").slice(1), limitMs: 60_000, cwd: at.dir, env, say: (s) => said.push(s), room });
  await until(() => reads >= 2, "a second look at the room");
  // While short: its ticket stays first in the queue, the lock is not taken, and nothing ran.
  assert.equal(tickets(at.lock).length, 1);
  assert.ok(!existsSync(join(at.lock, "suite.lock")), "the lock is not taken while short");
  assert.ok(!existsSync(ran));
  assert.equal(await running, 0);
  assert.equal(readFileSync(ran, "utf8"), "ran\n");
  const keys = said.map((s) => s.key);
  assert.deepEqual(keys.filter((k) => k.startsWith("lock.room")), ["lock.roomShort", "lock.roomAdmitted"], JSON.stringify(said));
  assert.ok(!keys.includes("lock.waiting"), "a wait for room is not a wait for the turn");
  assert.equal(said[0].vars?.short, "memory 9% free (min 15%)");
  assert.match(String(said.find((s) => s.key === "lock.roomAdmitted")?.vars?.room), /^memory 50% free \(min 15%\), swap 0% used/);
  const [line] = logLines(at.lock);
  assert.equal(line.short, "memory 9% free (min 15%)");
  assert.match(line.room, /^memory 50% free/);
});

test("lock room: a job short of room past its own limit starts anyway and says so; one that cannot read the room is not held", async (t) => {
  const at = box(t);
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  /** @type {string[]} */
  const said = [];
  const t0 = performance.now();
  const short = () => ({ memory: { value: 1 }, swap: { value: 0 }, load: { value: 0 }, disk: [] });
  assert.equal(await runLocked({ command: "true", args: [], limitMs: 1_500, cwd: at.dir, env, say: (s) => said.push(s.key), room: short }), 0);
  assert.ok(performance.now() - t0 >= 1_500, "it waited its limit first");
  assert.deepEqual(said.filter((k) => k.startsWith("lock.room")), ["lock.roomShort", "lock.roomCeiling"]);
  assert.equal(logLines(at.lock)[0].short, "memory 1% free (min 15%)");
  // A reader that throws, or readings that cannot be made: said once as unmeasured, and the run starts at once.
  for (const room of [() => { throw new Error("EACCES"); }, () => ({ memory: { unmeasured: "sysctl failed" }, swap: { unmeasured: "sysctl failed" }, load: { unmeasured: "x" }, disk: [] })]) {
    /** @type {import("../plugin/core/heavy-lock.mjs").Said[]} */
    const heard = [];
    assert.equal(await runLocked({ command: "true", args: [], limitMs: 60_000, cwd: at.dir, env, say: (s) => heard.push(s), room: /** @type {any} */ (room) }), 0);
    assert.deepEqual(heard.map((s) => s.key), ["lock.roomUnmeasured"]);
  }
});

test("lock room: the CLI refuses a threshold out of bounds before it takes a ticket, and says a threshold set away from its default", async (t) => {
  const at = box(t);
  for (const args of [["--min-memory", "101", "--", "true"], ["--max-load", "0", "--", "true"], ["--min-disk", "lots", "--", "true"]]) {
    const r = await lock(args, { cwd: at.dir, lock: at.lock }).ended;
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /must be a number/);
  }
  // Swap is never judged: no option for it.
  const swap = await lock(["--max-swap", "90", "--", "true"], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(swap.code, 2, swap.stderr);
  assert.match(swap.stderr, /unknown option --max-swap/);
  assert.ok(!existsSync(at.lock), "a usage error takes no ticket");
  // The test's own runs set every threshold away from its default: each is said.
  const r = await lock(["--min-disk", "0", "--", "true"], { cwd: at.dir, lock: at.lock }).ended;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /room thresholds set away from the defaults: ENNYN_LOCK_MIN_MEMORY=0, ENNYN_LOCK_MAX_LOAD=1000, --min-disk=0/);
});

test("lock room: a waiter behind another reads no room and starts no wait for it: its limit of waiting begins at the head", async (t) => {
  const at = box(t);
  const env = { ...process.env, ENNYN_LOCK_DIR: at.lock };
  mkdirSync(join(at.lock, "queue"), { recursive: true });
  // A locked.sh waiter ahead, alive.
  const ahead = spawn("sleep", ["300"], { stdio: "ignore" });
  track(ahead.pid ?? 0);
  const aheadTicket = join(at.lock, "queue", `0000000001.000000-${ahead.pid}`);
  writeFileSync(aheadTicket, "");
  /** @type {string[]} */
  const said = [];
  let reads = 0;
  const room = () => (reads++, roomy());
  const running = runLocked({ command: "true", args: [], limitMs: 60_000, cwd: at.dir, env, say: (s) => said.push(s.key), room });
  await until(() => said.includes("lock.waiting"), "the wait for the turn");
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(reads, 0, "no room read behind another waiter");
  rmSync(aheadTicket);
  assert.equal(await running, 0);
  assert.equal(reads, 1, "read once, at the head");
  assert.deepEqual(said.filter((k) => k.startsWith("lock.room")), []);
});

test("lock room: macOS's sysctl is run by its own path, never one found earlier on PATH", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-sysctl-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "ran");
  // A planted sysctl that would report all memory free.
  writeFileSync(join(dir, "sysctl"), `#!/bin/sh\necho ran > "${marker}"\nprintf '100\\ntotal = 1.00M  used = 0.00M  free = 1.00M\\n'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const r = readRoom({ platform: "darwin", dirs: [] });
    assert.ok(!existsSync(marker), "the sysctl on PATH ran");
    assert.notDeepEqual(r.memory, { value: 100 });
  } finally {
    process.env.PATH = path;
  }
});
