import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, appendFileSync, existsSync, realpathSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { recordAttempt, readAttempts, summarizeAttempts, durationStats, gateLogPath, isAttempt, cleanName } from "../metrics/gate-log.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
/** A start in epoch seconds (2027-01-15): attempts are written relative to it. */
const T = 1_800_000_000;

/** @param {Record<string, unknown>} [config] */
function repo(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pl-gate-")));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  if (config) {
    mkdirSync(join(dir, ".ennyn"), { recursive: true });
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
  }
  const write = (/** @type {Record<string, string>} */ files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  return {
    dir,
    write,
    /** @param {Record<string, string>} files */
    stage(files) {
      write(files);
      git(["add", "--", ...Object.keys(files)], { cwd: dir });
    },
    /** @param {Record<string, string>} files @param {string} message */
    commit(files, message) {
      write(files);
      git(["add", "-A"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir });
      return git(["rev-parse", "HEAD"], { cwd: dir });
    },
  };
}

/** @param {string} cwd */
const cfgFor = (cwd) => loadConfig({ cwd, env: {} });

/** @param {string} cwd @param {string[]} args */
function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("gate-log: a passing attempt takes its files from the commit and lands in the machine-local state dir", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const hash = r.commit({ "src/x.js": "x\n", "docs/y.md": "y\n" }, "second");
  const { path, entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 1_800_000_000, end: 1_800_000_270, exit: 0, commit: "HEAD" });
  assert.equal(path, join(r.dir, ".git", "ennyn", "gate-attempts.jsonl"));
  assert.deepEqual(
    { result: entry.result, commit: entry.commit, files: entry.files, seconds: entry.seconds, kind: entry.kind },
    { result: "pass", commit: hash, files: ["docs/y.md", "src/x.js"], seconds: 270, kind: "full" },
  );
  assert.equal(entry.start, "2027-01-15T08:00:00.000Z");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), entry);
});

test("gate-log: a file named like the commit's hash does not stop the file list (the revision ends at --)", () => {
  const r = repo();
  const hash = r.commit({ "a.txt": "a\n" }, "first");
  r.write({ [hash]: "" });
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 1_800_000_000, end: 1_800_000_010, exit: 0, commit: "HEAD" });
  assert.deepEqual([entry.commit, entry.files], [hash, ["a.txt"]]);
});

test("gate-log: the root commit's files are listed too", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "root");
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: T + 100, end: T + 160, exit: 0, commit: "HEAD" });
  assert.deepEqual(entry.files, ["a.txt"]);
});

test("gate-log: a failed attempt takes its files from the index and keeps the exit code and step", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  r.stage({ "b.txt": "b\n", "c.txt": "c\n" });
  r.write({ "unstaged.txt": "u\n" });
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: T + 100, end: T + 400, exit: 1, step: "check:file-size", runner: "remote" });
  assert.deepEqual(
    { result: entry.result, commit: entry.commit, files: entry.files, exit: entry.exit, step: entry.step, runner: entry.runner },
    { result: "fail", commit: null, files: ["b.txt", "c.txt"], exit: 1, step: "check:file-size", runner: "remote" },
  );
});

test("gate-log: exit 0 without a commit is a failure (the command returned 0 but HEAD did not move)", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: T + 100, end: T + 100, exit: 0 });
  assert.equal(entry.result, "fail");
});

test("gate-log: contradictory or malformed attempts are refused, nothing is written", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  const base = { cwd: r.dir, config, start: T + 100, end: T + 200 };
  assert.throws(() => recordAttempt({ ...base, exit: 0, kind: "message" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 5, kind: "message", commit: "HEAD" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 1, commit: "HEAD" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 0, commit: "no-such-ref" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 0, kind: "partial" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 256 }), RangeError);
  assert.throws(() => recordAttempt({ ...base, start: 1.5, exit: 1 }), RangeError);
  assert.equal(existsSync(gateLogPath(r.dir, config.paths.stateDir)), false);
});

test("gate-log: a linked worktree records into the shared git dir, next to the main checkout's attempts", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "pl-gate-wt-"))), "w");
  git(["worktree", "add", "-q", "-b", "side", wt], { cwd: r.dir });
  const main = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: T + 100, end: T + 110, exit: 1 });
  const side = recordAttempt({ cwd: wt, config: cfgFor(wt), start: T + 200, end: T + 230, exit: 1 });
  assert.equal(side.path, main.path);
  assert.equal(readAttempts(main.path).attempts.length, 2);
});

test("gate-log: no log is not the same as no attempts; unreadable lines are counted, not dropped silently", () => {
  const r = repo();
  const path = gateLogPath(r.dir, ".git/ennyn");
  assert.deepEqual(readAttempts(path), { exists: false, attempts: [], skipped: 0 });
  r.commit({ "a.txt": "a\n" }, "first");
  recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: T + 100, end: T + 160, exit: 1 });
  appendFileSync(path, '{"v":1,"kind":"full","start":"2026-01-0\n');
  appendFileSync(path, JSON.stringify({ v: 2, kind: "full" }) + "\n\n");
  const log = readAttempts(path);
  assert.equal(log.exists, true);
  assert.equal(log.attempts.length, 1);
  assert.equal(log.skipped, 2);
});

test("gate-log: a torn last line (no newline) stays one skipped line; the next attempt is kept", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  const path = gateLogPath(r.dir, config.paths.stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"v":1,"kind":"full","start":"2026');
  recordAttempt({ cwd: r.dir, config, start: T + 100, end: T + 160, exit: 0, commit: "HEAD" });
  recordAttempt({ cwd: r.dir, config, start: T + 200, end: T + 230, exit: 1 });
  const log = readAttempts(path);
  assert.deepEqual(
    { results: log.attempts.map((a) => a.result), skipped: log.skipped },
    { results: ["pass", "fail"], skipped: 1 },
  );
});

test("gate-log: an existing empty log gets no leading blank line", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  const path = gateLogPath(r.dir, config.paths.stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  recordAttempt({ cwd: r.dir, config, start: T + 100, end: T + 160, exit: 1 });
  assert.equal(readFileSync(path, "utf8")[0], "{");
});

test("gate-log: isAttempt rejects each missing or mistyped field", () => {
  const good = { v: 1, kind: "full", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:01:00.000Z", seconds: 60, exit: 1, result: "fail", commit: null, files: ["a"], step: null, runner: null };
  assert.equal(isAttempt(good), true);
  for (const [k, bad] of Object.entries({ v: 2, kind: "partial", start: "never", seconds: -1, exit: 1.5, result: "ok", commit: 7, files: [1], step: 3, runner: false })) {
    assert.equal(isAttempt({ ...good, [k]: bad }), false, k);
  }
});

test("gate-log: durationStats uses nearest rank", () => {
  assert.deepEqual(durationStats([]), { n: 0, median: null, p90: null });
  assert.deepEqual(durationStats([30]), { n: 1, median: 30, p90: 30 });
  assert.deepEqual(durationStats([50, 10, 40, 20, 30]), { n: 5, median: 30, p90: 50 });
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 60);
  assert.deepEqual(durationStats(ten), { n: 10, median: 300, p90: 540 });
});

/** @param {Partial<import("../metrics/gate-log.mjs").GateAttempt>} o */
const att = (o) => ({ v: 1, kind: "full", start: "2026-03-10T12:00:00.000Z", end: "", seconds: 60, exit: 0, result: "pass", commit: "c", files: [], step: null, runner: null, ...o });

test("gate-log: summary counts passes, failures, message rejections, waste and failing steps", () => {
  const s = summarizeAttempts(
    /** @type {any} */ ([
      att({ seconds: 240 }),
      // A step on a passing attempt is not a failing step.
      att({ seconds: 300, step: "test" }),
      att({ result: "fail", exit: 1, commit: null, seconds: 600, step: "test" }),
      att({ result: "fail", exit: 1, commit: null, seconds: 120, step: "check:decks" }),
      att({ result: "fail", exit: 1, commit: null, seconds: 180, step: "test" }),
      att({ result: "fail", exit: 1, commit: null, seconds: 60 }),
      att({ kind: "message", result: "fail", exit: 5, commit: null, seconds: 1 }),
    ]),
  );
  assert.deepEqual(
    { ...s, pass: s.pass, fail: s.fail },
    {
      attempts: 7,
      full: 6,
      message: 1,
      passed: 2,
      failed: 4,
      failRate: 4 / 6,
      pass: { n: 2, median: 240, p90: 300 },
      fail: { n: 4, median: 120, p90: 600 },
      wastedSeconds: 960,
      unmeasuredDurations: 0,
      steps: [
        { step: "test", n: 2 },
        { step: "check:decks", n: 1 },
      ],
      unmeasuredSteps: 1,
    },
  );
});

test("gate-log: the window is local calendar days, both ends inclusive", () => {
  const local = (/** @type {number} */ d, /** @type {number} */ h) => new Date(2026, 2, d, h, 0, 0).toISOString();
  const list = /** @type {any} */ ([att({ start: local(9, 23) }), att({ start: local(10, 0) }), att({ start: local(11, 23) }), att({ start: local(12, 0) })]);
  assert.equal(summarizeAttempts(list, { since: "2026-03-10", until: "2026-03-11" }).attempts, 2);
  assert.equal(summarizeAttempts(list, { since: "2026-03-12" }).attempts, 1);
  assert.equal(summarizeAttempts(list).attempts, 4);
  assert.equal(summarizeAttempts([]).failRate, null);
});

test("cli: gate-record then gate-stats, in the project language, with --json", () => {
  const r = repo({ language: "tr" });
  r.commit({ "a.txt": "a\n" }, "first");
  const start = String(Math.floor(Date.now() / 1000) - 300);
  const pass = run(r.dir, "gate-record", "--start", start, "--exit", "0", "--commit", "HEAD");
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /^Kapı denemesi kaydedildi \(geçti\): /);
  r.stage({ "b.txt": "b\n" });
  assert.equal(run(r.dir, "gate-record", "--start", start, "--exit", "1", "--step", "lint").code, 0);
  assert.equal(run(r.dir, "gate-record", "--start", start, "--exit", "5", "--kind", "message").code, 0);
  // A start in the future is no reason to lose the attempt: it is kept, its duration unmeasured.
  const future = run(r.dir, "gate-record", "--start", String(Math.floor(Date.now() / 1000) + 3600), "--exit", "1");
  assert.equal(future.code, 0, future.stderr);
  assert.match(future.stdout, /^Kapı denemesi kaydedildi \(düştü\): .*; süresi ölçülmedi: /);
  const stats = run(r.dir, "gate-stats");
  assert.equal(stats.code, 0, stats.stderr);
  assert.match(stats.stdout, /^Kapı: 3 deneme, 1 geçti, 2 düştü \(67%\); 1 mesaj kapıdan önce reddedildi\.$/m);
  assert.match(stats.stdout, /^1 denemenin süresi ölçülmedi /m);
  assert.match(stats.stdout, /^Düşen adımlar: lint 1\.$/m);
  const json = JSON.parse(run(r.dir, "gate-stats", "--json").stdout);
  assert.equal(json.exists, true);
  assert.equal(json.full, 3);
  assert.equal(json.unmeasuredDurations, 1);
  assert.equal(json.path, join(r.dir, ".git", "ennyn", "gate-attempts.jsonl"));
});

test("cli: gate-stats without a log says so instead of reporting zero", () => {
  const r = repo();
  const res = run(r.dir, "gate-stats");
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^No gate attempts recorded yet \(/);
  assert.equal(JSON.parse(run(r.dir, "gate-stats", "--json").stdout).exists, false);
});

test("cli: gate-record usage errors exit 2, refused attempts and unwritable state exit 1", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  assert.equal(run(r.dir, "gate-record", "--exit", "1").code, 2);
  assert.equal(run(r.dir, "gate-record", "--start", "now", "--exit", "1").code, 2);
  const start = String(Math.floor(Date.now() / 1000) - 60);
  assert.equal(run(r.dir, "gate-record", "--start", start, "--exit", "1", "--kind", "partial").code, 2);
  const refused = run(r.dir, "gate-record", "--start", start, "--exit", "0", "--commit", "no-such-ref");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^Gate attempt not recorded: not a commit: no-such-ref/);
  const blocked = repo({ paths: { stateDir: ".git/HEAD/state" } });
  blocked.commit({ "package.json": "{}\n" }, "first");
  const unwritable = run(blocked.dir, "gate-record", "--start", start, "--exit", "1");
  assert.equal(unwritable.code, 1);
  assert.match(unwritable.stderr, /^ennyn gate-record: /);
  // A state dir a commit points out of the repository, by a path or by a link: nothing is written there.
  const away = realpathSync(mkdtempSync(join(tmpdir(), "pl-gate-away-")));
  writeFileSync(join(away, "victim"), "mine\n");
  const out = repo({ paths: { stateDir: `../${basename(away)}` } });
  assert.match(run(out.dir, "gate-record", "--start", start, "--exit", "1").stderr, /"paths\.stateDir": .* leads outside the project directory/);
  // A state dir in the work tree, where a commit could plant the log or a link (state-leaf-link-gate-log,
  // state-root-leaf-link-dot, -empty, -descent): the config is refused, nothing is written.
  for (const stateDir of ["state", ".", "", "src/.."]) {
    const work = repo({ paths: { stateDir } });
    symlinkSync(join(away, "victim"), join(work.dir, "gate-attempts.jsonl"));
    work.commit({ "a.txt": "a\n" }, "first");
    for (const args of [["gate-record", "--start", start, "--exit", "1"], ["gate-stats"]]) {
      const r = run(work.dir, ...args);
      assert.equal(r.code, 1, `${JSON.stringify(stateDir)} ${args[0]}`);
      assert.match(r.stderr, /"paths\.stateDir": .* must lie under \.git\//, `${JSON.stringify(stateDir)} ${args[0]}`);
    }
  }
  // In the git dir a directory link this machine made (a state dir on another disk) is followed (user-git-state-link);
  // the log itself is never a link.
  const own = repo();
  own.commit({ "a.txt": "a\n" }, "first");
  const disk = realpathSync(mkdtempSync(join(tmpdir(), "pl-gate-disk-")));
  symlinkSync(disk, join(own.dir, ".git", "ennyn"));
  assert.equal(run(own.dir, "gate-record", "--start", start, "--exit", "1").code, 0);
  assert.equal(readFileSync(join(disk, "gate-attempts.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.equal(run(own.dir, "gate-stats").code, 0);
  rmSync(join(disk, "gate-attempts.jsonl"));
  symlinkSync(join(away, "victim"), join(disk, "gate-attempts.jsonl"));
  for (const args of [["gate-record", "--start", start, "--exit", "1"], ["gate-stats"]]) {
    const r = run(own.dir, ...args);
    assert.equal(r.code, 1, args[0]);
    assert.match(r.stderr, /(was not written|could not be read): gate-attempts\.jsonl is a symbolic link$/m, args[0]);
  }
  assert.deepEqual([readdirSync(away), readFileSync(join(away, "victim"), "utf8")], [["victim"], "mine\n"]);
});

test("gate-log audit: a log that is there but cannot be read fails; it is not \"nothing recorded\"", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  recordAttempt({ cwd: r.dir, config, start: T, end: T + 60, exit: 1 });
  const path = gateLogPath(r.dir, config.paths.stateDir);
  // No search permission on the state dir: existsSync says "not there", a read says why.
  chmodSync(dirname(path), 0o000);
  try {
    assert.throws(() => readAttempts(path), /EACCES/);
    const stats = run(r.dir, "gate-stats");
    assert.equal(stats.code, 1, stats.stdout);
    assert.doesNotMatch(stats.stdout, /No gate attempts recorded/);
    assert.match(stats.stderr, /^ennyn gate-stats: .*EACCES/);
  } finally {
    chmodSync(dirname(path), 0o755);
  }
  // A torn log that can be written but not read: closing its last line is not possible, so nothing is glued on.
  writeFileSync(path, '{"v":1,"kind":"fu');
  chmodSync(path, 0o200);
  try {
    assert.throws(() => recordAttempt({ cwd: r.dir, config, start: T, end: T + 60, exit: 1 }), /EACCES/);
  } finally {
    chmodSync(path, 0o644);
  }
  assert.equal(readFileSync(path, "utf8"), '{"v":1,"kind":"fu');
});

test("gate-log audit: a start that cannot be this attempt's keeps the attempt, with its duration unmeasured, on write and on read", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  // A shell's $SECONDS, a start before 2000, a machine that slept 50 hours, a clock stepped back 2 s.
  for (const [start, end] of [[7, T], [946_684_799, 946_684_800], [T, T + 180_000], [T + 2, T]]) {
    const { entry } = recordAttempt({ cwd: r.dir, config, start, end, exit: 1, step: "lint" });
    assert.deepEqual([entry.result, entry.seconds, entry.step], ["fail", null, "lint"], `${start}..${end}`);
  }
  assert.equal(recordAttempt({ cwd: r.dir, config, start: T, end: T + 86_400, exit: 1 }).entry.seconds, 86_400);
  assert.throws(() => recordAttempt({ cwd: r.dir, config, start: 1.5, end: T, exit: 1 }), RangeError, "not seconds at all");
  const path = gateLogPath(r.dir, config.paths.stateDir);
  // A line an older version wrote: a $SECONDS start and decades of "waste".
  appendFileSync(path, JSON.stringify({ v: 1, kind: "full", start: "1970-01-01T00:00:07.000Z", end: "2026-10-01T00:00:00.000Z", seconds: 1_790_000_000, exit: 1, result: "fail", commit: null, files: [], step: null, runner: null }) + "\n");
  const sum = summarizeAttempts(readAttempts(path).attempts);
  assert.deepEqual([sum.failed, sum.unmeasuredDurations, sum.fail.n, sum.wastedSeconds], [6, 5, 1, 86_400]);
  // Placed by its end, not by a 1970 start.
  assert.equal(summarizeAttempts(readAttempts(path).attempts, { since: "2026-09-30", until: "2026-10-02" }).attempts, 1);
  const stats = run(r.dir, "gate-stats");
  assert.match(stats.stdout, /^5 attempts have no measured duration .*; the times above leave them out\.$/m);
  assert.doesNotMatch(stats.stdout, /\d{6,}/, "no decades of waste");
  const cli = run(r.dir, "gate-record", "--start", "7", "--exit", "1");
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /with its duration unmeasured: start 7 is before 2000/);
});

test("gate-log audit: step and runner names print on one line; a bad name is cleaned, never the attempt lost", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  // A CR from CRLF output, colour codes, a newline that would print a summary line of its own, a tab, C1.
  for (const [raw, want] of [["lint\r", "lint"], ["\u001b[31mlint\u001b[0m", "lint"], ["lint\nGate: 0 attempts", "lint Gate: 0 attempts"], ["a\tb", "a b"], ["c1\u0085", "c1"], ["\r\n", null], ["", null]]) {
    assert.equal(cleanName(raw), want, JSON.stringify(raw));
  }
  // At most 200 code points; 101 emoji are 101, not 202. 200 stay whole, 201 are cut.
  assert.equal(cleanName("😀".repeat(101)), "😀".repeat(101));
  assert.equal(cleanName("y".repeat(200)), "y".repeat(200));
  assert.match(String(cleanName("y".repeat(201))), /^y{190}…#[0-9a-f]{8}$/);
  const { entry } = recordAttempt({ cwd: r.dir, config, start: T, end: T + 60, exit: 1, step: "\u001b[31mlint\u001b[0m\r", runner: "remote\r" });
  assert.deepEqual([entry.step, entry.runner], ["lint", "remote"]);
  // A line an older version wrote with "lint\r" counts, and with the same step as "lint".
  const path = gateLogPath(r.dir, config.paths.stateDir);
  const good = { v: 1, kind: "full", start: "2027-01-15T08:00:00.000Z", end: "2027-01-15T08:01:00.000Z", seconds: 60, exit: 1, result: "fail", commit: null, files: [], runner: null };
  appendFileSync(path, JSON.stringify({ ...good, step: "lint\r" }) + "\n");
  const log = readAttempts(path);
  assert.deepEqual([log.attempts.length, log.skipped], [2, 0]);
  assert.deepEqual(summarizeAttempts(log.attempts).steps, [{ step: "lint", n: 2 }]);
});

test("gate-log audit: failing steps with equal counts sort in UTF-16 order, the same on every machine", () => {
  const at = (/** @type {string} */ step) => ({ v: 1, kind: "full", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:01:00.000Z", seconds: 60, exit: 1, result: "fail", commit: null, files: [], step, runner: null });
  const list = /** @type {any[]} */ (["ia", "b", "Ib", "B", "check:z", "check-a", "lint", "lint"].map(at));
  assert.deepEqual(summarizeAttempts(list).steps.map((s) => s.step), ["lint", "B", "Ib", "b", "check-a", "check:z", "ia"]);
});

test("cli audit: an option given twice, an empty --kind, or an empty --commit with exit 0 is a usage error; nothing is recorded", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const start = String(Math.floor(Date.now() / 1000) - 60);
  for (const args of [
    ["--start", start, "--exit", "1", "--exit", "0", "--commit", "HEAD"],
    ["--start", start, "--start", start, "--exit", "1"],
    ["--start", start, "--exit", "1", "--kind", ""],
    ["--start", start, "--exit", "0", "--commit", ""],
    ["--start", start, "--exit", "0", "--commit="],
    ["--start", start, "--exit", "1", "--kind="],
  ]) {
    const res = run(r.dir, "gate-record", ...args);
    assert.equal(res.code, 2, args.join(" "));
    assert.match(res.stderr, /given twice|needs a value/, args.join(" "));
  }
  assert.equal(run(r.dir, "gate-stats", "--json", "--json").code, 2, "a flag twice too");
  assert.equal(readAttempts(gateLogPath(r.dir, ".git/ennyn")).exists, false);
  // With a non-zero exit an empty --commit names no commit: the failure is recorded.
  const failed = run(r.dir, "gate-record", "--start", start, "--exit", "1", "--commit", "");
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(readAttempts(gateLogPath(r.dir, ".git/ennyn")).attempts[0]?.result, "fail");
});

test("gate-log audit (after review): a start no date can hold, every escape sequence, and long names that differ late", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  // date +%s%6N and date +%s%N: no date at all, yet the attempt is kept.
  for (const start of [T * 1_000_000, T * 1_000_000_000]) {
    const { entry } = recordAttempt({ cwd: r.dir, config, start, end: T + 60, exit: 1, step: "lint" });
    assert.deepEqual([entry.result, entry.start, entry.seconds, entry.startGiven], ["fail", null, null, start]);
  }
  const path = gateLogPath(r.dir, config.paths.stateDir);
  const log = readAttempts(path);
  assert.deepEqual([log.attempts.length, log.skipped], [2, 0]);
  assert.equal(summarizeAttempts(log.attempts, { since: "2027-01-15", until: "2027-01-15" }).unmeasuredDurations, 2, "placed by the end");
  const cli = run(r.dir, "gate-record", "--start", String(Math.floor(Date.now() / 1000) * 1_000_000_000), "--exit", "1");
  assert.equal(cli.code, 0, cli.stderr);
  // tput sgr0 on xterm (ESC ( B ESC [ m), a terminal hyperlink (OSC 8, ended by ESC \ or BEL), the 8-bit CSI.
  for (const raw of ["\u001b[31mlint\u001b(B\u001b[m", "\u001b]8;;file:///x\u001b\\lint\u001b]8;;\u001b\\", "\u001b]0;title\u0007lint", "\u009b31mlint\u009b0m"]) {
    assert.equal(cleanName(raw), "lint", JSON.stringify(raw));
  }
  // Two failing command lines that differ only past the cut stay two steps.
  const long = (/** @type {string} */ tail) => `node --test ${"test/x.test.mjs ".repeat(13)}test/${tail}`;
  const [a, b] = [cleanName(long("alpha")), cleanName(long("beta"))];
  assert.notEqual(a, b);
  for (const name of [a, b]) {
    assert.equal([.../** @type {string} */ (name)].length, 200);
    assert.match(String(name), /…#[0-9a-f]{8}$/);
  }
  assert.equal(cleanName(long("alpha")), a, "the same name cuts the same way");
});
