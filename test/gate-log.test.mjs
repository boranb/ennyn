import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { recordAttempt, readAttempts, summarizeAttempts, durationStats, gateLogPath, isAttempt } from "../metrics/gate-log.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

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
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 100, end: 160, exit: 0, commit: "HEAD" });
  assert.deepEqual(entry.files, ["a.txt"]);
});

test("gate-log: a failed attempt takes its files from the index and keeps the exit code and step", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  r.stage({ "b.txt": "b\n", "c.txt": "c\n" });
  r.write({ "unstaged.txt": "u\n" });
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 100, end: 400, exit: 1, step: "check:file-size", runner: "remote" });
  assert.deepEqual(
    { result: entry.result, commit: entry.commit, files: entry.files, exit: entry.exit, step: entry.step, runner: entry.runner },
    { result: "fail", commit: null, files: ["b.txt", "c.txt"], exit: 1, step: "check:file-size", runner: "remote" },
  );
});

test("gate-log: exit 0 without a commit is a failure (the command returned 0 but HEAD did not move)", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const { entry } = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 100, end: 100, exit: 0 });
  assert.equal(entry.result, "fail");
});

test("gate-log: contradictory or malformed attempts are refused, nothing is written", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const config = cfgFor(r.dir);
  const base = { cwd: r.dir, config, start: 100, end: 200 };
  assert.throws(() => recordAttempt({ ...base, exit: 0, kind: "message" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 5, kind: "message", commit: "HEAD" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 1, commit: "HEAD" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 0, commit: "no-such-ref" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 0, kind: "partial" }), RangeError);
  assert.throws(() => recordAttempt({ ...base, exit: 256 }), RangeError);
  assert.throws(() => recordAttempt({ ...base, start: 300, exit: 1 }), RangeError);
  assert.throws(() => recordAttempt({ ...base, start: 1.5, exit: 1 }), RangeError);
  assert.equal(existsSync(gateLogPath(r.dir, config.paths.stateDir)), false);
});

test("gate-log: a linked worktree records into the shared git dir, next to the main checkout's attempts", () => {
  const r = repo();
  r.commit({ "a.txt": "a\n" }, "first");
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "pl-gate-wt-"))), "w");
  git(["worktree", "add", "-q", "-b", "side", wt], { cwd: r.dir });
  const main = recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 100, end: 110, exit: 1 });
  const side = recordAttempt({ cwd: wt, config: cfgFor(wt), start: 200, end: 230, exit: 1 });
  assert.equal(side.path, main.path);
  assert.equal(readAttempts(main.path).attempts.length, 2);
});

test("gate-log: no log is not the same as no attempts; unreadable lines are counted, not dropped silently", () => {
  const r = repo();
  const path = gateLogPath(r.dir, ".git/ennyn");
  assert.deepEqual(readAttempts(path), { exists: false, attempts: [], skipped: 0 });
  r.commit({ "a.txt": "a\n" }, "first");
  recordAttempt({ cwd: r.dir, config: cfgFor(r.dir), start: 100, end: 160, exit: 1 });
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
  recordAttempt({ cwd: r.dir, config, start: 100, end: 160, exit: 0, commit: "HEAD" });
  recordAttempt({ cwd: r.dir, config, start: 200, end: 230, exit: 1 });
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
  recordAttempt({ cwd: r.dir, config, start: 100, end: 160, exit: 1 });
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
  const future = run(r.dir, "gate-record", "--start", String(Math.floor(Date.now() / 1000) + 3600), "--exit", "1");
  assert.equal(future.code, 1);
  assert.match(future.stderr, /^Kapı denemesi kaydedilmedi: end /);
  const stats = run(r.dir, "gate-stats");
  assert.equal(stats.code, 0, stats.stderr);
  assert.match(stats.stdout, /^Kapı: 2 deneme, 1 geçti, 1 düştü \(50%\); 1 mesaj kapıdan önce reddedildi\.$/m);
  assert.match(stats.stdout, /^Düşen adımlar: lint 1\.$/m);
  const json = JSON.parse(run(r.dir, "gate-stats", "--json").stdout);
  assert.equal(json.exists, true);
  assert.equal(json.full, 2);
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
  assert.equal(run(r.dir, "gate-record", "--start", "100", "--exit", "1", "--kind", "partial").code, 2);
  const refused = run(r.dir, "gate-record", "--start", "100", "--exit", "0", "--commit", "no-such-ref");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^Gate attempt not recorded: not a commit: no-such-ref/);
  const blocked = repo({ paths: { stateDir: "package.json/state" } });
  blocked.commit({ "package.json": "{}\n" }, "first");
  const unwritable = run(blocked.dir, "gate-record", "--start", "100", "--exit", "1");
  assert.equal(unwritable.code, 1);
  assert.match(unwritable.stderr, /^ennyn gate-record: /);
});
