/**
 * Commit-gate attempt log. One JSON line per attempt in `<stateDir>/gate-attempts.jsonl`
 * (machine-local, never committed). The project's commit wrapper calls `ennyn gate-record`
 * after every attempt; `ennyn gate-stats` summarizes wait, failures and waste.
 *
 * Recording never decides anything: a wrapper that cannot record still returns the
 * commit's own exit code, and says that the attempt went unrecorded.
 *
 * Why (origin project, 2026-10): the wrapper printed the gate's duration only to the
 * terminal, so its cost had to be scraped back from agent transcripts, where 16% of the
 * attempts had no readable outcome.
 */

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { git, gitMaybe, resolveStateDir, stagedPaths } from "../core/git.mjs";
import { parseBound } from "./szz.mjs";

export const GATE_LOG_FILE = "gate-attempts.jsonl";
/** `full`: the commit ran the gate. `message`: the message was rejected before the gate started. */
export const KINDS = /** @type {const} */ (["full", "message"]);

/**
 * @typedef {{
 *   v: 1, kind: "full" | "message", start: string | null, end: string, seconds: number | null, exit: number,
 *   result: "pass" | "fail", commit: string | null, files: string[], step: string | null, runner: string | null,
 *   startGiven?: number
 * }} GateAttempt
 *   `start` and `seconds` are null together when the start given cannot be this attempt's; `startGiven`
 *   then keeps what the wrapper passed.
 */

/**
 * @param {string} projectDir
 * @param {string} stateDir config `paths.stateDir`
 */
export function gateLogPath(projectDir, stateDir) {
  return join(resolveStateDir(projectDir, stateDir), GATE_LOG_FILE);
}

/**
 * Paths a commit changed (the root commit included).
 * @param {string} cwd
 * @param {string} rev
 * @returns {string[]}
 */
export function commitPaths(cwd, rev) {
  // "--" ends the revision: a file named like it would stop git on an ambiguous argument.
  return git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", rev, "--"], { cwd }).split("\0").filter(Boolean);
}

/** @param {number} sec */
const iso = (sec) => new Date(sec * 1000).toISOString();

/** 2000-01-01: a start before it is not epoch seconds (a shell's $SECONDS, an uptime clock). */
const EPOCH_FLOOR = 946684800;
/** An attempt longer than a day is a start from another clock, or a machine that slept: no wait to count. */
const MAX_SECONDS = 24 * 60 * 60;
/** Longest step or runner name, in code points: it is printed on one line of the summary. */
const MAX_NAME = 200;
/**
 * Terminal escape sequences a wrapper copies from the gate's output: an OSC string (a hyperlink, a title)
 * ended by BEL or ESC \, a CSI code (colour, cursor) in its 7-bit or 8-bit form, and the short ESC forms
 * (`tput sgr0` writes ESC ( B).
 */
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
/** Other C0 and C1 control characters: a CR from CRLF output, a tab, a newline that would print a line of its own. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A step or runner name as one printable line: escape sequences dropped, other control characters as spaces,
 * at most MAX_NAME code points; null when nothing is left. A longer name is cut and ends in "…#" and 8 hex
 * digits of its digest, so two names that differ only past the cut stay two. The name is a label: a bad one
 * never costs the attempt it labels.
 * @param {unknown} v
 * @returns {string | null}
 */
export function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(ESCAPES, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const points = [...s];
  if (points.length <= MAX_NAME) return s;
  const digest = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `${points.slice(0, MAX_NAME - 10).join("")}…#${digest}`;
}

/**
 * The seconds an attempt took, or null when its start cannot be this attempt's: before 2000, after the end,
 * or more than a day before it. The same rule on write and on read (a line an older version wrote).
 * @param {number} start @param {number} end epoch seconds
 */
function measuredSeconds(start, end) {
  return start >= EPOCH_FLOOR && end >= start && end - start <= MAX_SECONDS ? end - start : null;
}

/**
 * True when the log exists, is not empty and does not end with a newline: an
 * earlier write was cut off (disk full, killed process). Appending right after
 * it would glue the next attempt to the fragment and lose both.
 * @param {string} path
 */
function endsTorn(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    // No log yet; a log that cannot be read (write-only, a directory) fails the record instead of gluing onto it.
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return false;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one attempt. Files come from the commit when one is given (the attempt
 * passed), otherwise from the index (a failed commit leaves its files staged).
 * @param {{ cwd: string, config: any, start: number, end?: number, exit: number, kind?: string,
 *   commit?: string | null, step?: string | null, runner?: string | null }} opts
 *   `start` / `end` are epoch seconds.
 * @returns {{ path: string, entry: GateAttempt }}
 */
export function recordAttempt({ cwd, config, start, end = Math.floor(Date.now() / 1000), exit, kind = "full", commit = null, step = null, runner = null }) {
  // Only an outcome that contradicts itself is refused; a start from another clock leaves the duration
  // unmeasured, and the attempt's result, files and step are kept.
  if (!Number.isInteger(start) || start < 0) throw new RangeError(`start must be epoch seconds, got ${start}`);
  if (!Number.isInteger(end) || end < 0) throw new RangeError(`end must be epoch seconds, got ${end}`);
  if (!Number.isInteger(exit) || exit < 0 || exit > 255) throw new RangeError(`exit must be 0-255, got ${exit}`);
  if (!(/** @type {readonly string[]} */ (KINDS)).includes(kind)) throw new RangeError(`kind must be ${KINDS.join(" | ")}, got ${kind}`);
  if (kind === "message" && (exit === 0 || commit)) throw new RangeError("a message attempt is a rejection: non-zero exit and no commit");
  if (commit && exit !== 0) throw new RangeError("a commit was given but the exit code is not 0");
  const hash = commit ? gitMaybe(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd, absent: [1] }) : null;
  if (commit && !hash) throw new RangeError(`not a commit: ${commit}`);
  const seconds = measuredSeconds(start, end);
  /** @type {GateAttempt} */
  const entry = {
    v: 1,
    kind: /** @type {"full" | "message"} */ (kind),
    // A start from another clock may be no date at all (microseconds, nanoseconds): kept as given.
    start: seconds === null ? null : iso(start),
    end: iso(end),
    seconds,
    exit,
    // Exit 0 without a commit is the wrapper's "the command returned 0 but HEAD did not move": not a pass.
    result: exit === 0 && hash ? "pass" : "fail",
    commit: hash,
    files: hash ? commitPaths(cwd, hash) : stagedPaths(cwd),
    step: cleanName(step),
    runner: cleanName(runner),
    ...(seconds === null ? { startGiven: start } : {}),
  };
  const path = gateLogPath(cwd, config.paths.stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // One write call per line: two sessions committing at once append whole lines. A torn last line is closed
  // first, so it stays one skipped line instead of swallowing this attempt.
  appendFileSync(path, (endsTorn(path) ? "\n" : "") + JSON.stringify(entry) + "\n");
  return { path, entry };
}

/** @param {unknown} v */
const nullableString = (v) => v === null || typeof v === "string";

/**
 * @param {unknown} o
 * @returns {o is GateAttempt}
 */
export function isAttempt(o) {
  if (!o || typeof o !== "object") return false;
  const a = /** @type {Record<string, unknown>} */ (o);
  return (
    a.v === 1 &&
    (/** @type {readonly unknown[]} */ (KINDS)).includes(a.kind) &&
    // Measured: a start and the seconds. Unmeasured: neither (or an older line's start), and an end to place it by.
    ((typeof a.start === "string" && !Number.isNaN(Date.parse(a.start)) && typeof a.seconds === "number" && a.seconds >= 0) ||
      ((a.start === null || (typeof a.start === "string" && !Number.isNaN(Date.parse(a.start)))) &&
        a.seconds === null &&
        typeof a.end === "string" &&
        !Number.isNaN(Date.parse(a.end)))) &&
    Number.isInteger(a.exit) &&
    (a.result === "pass" || a.result === "fail") &&
    nullableString(a.commit) &&
    Array.isArray(a.files) &&
    a.files.every((f) => typeof f === "string") &&
    nullableString(a.step) &&
    nullableString(a.runner)
  );
}

/**
 * @param {string} path
 * @returns {{ exists: boolean, attempts: GateAttempt[], skipped: number }}
 *   `exists: false` means nothing was ever recorded, which is not the same as zero attempts in a window.
 *   `skipped` counts lines that are not attempts (a torn write, a hand edit): they are reported, not dropped silently.
 *   A log that is there but cannot be read (no permission on it or its directory, a directory in its place) throws.
 */
export function readAttempts(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { exists: false, attempts: [], skipped: 0 };
    throw err;
  }
  /** @type {GateAttempt[]} */
  const attempts = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (isAttempt(o)) attempts.push(o);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { exists: true, attempts, skipped };
}

/**
 * Nearest-rank percentiles; null without values.
 * @param {number[]} values
 * @returns {{ n: number, median: number | null, p90: number | null }}
 */
export function durationStats(values) {
  if (!values.length) return { n: 0, median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  const rank = (/** @type {number} */ p) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  return { n: s.length, median: rank(0.5), p90: rank(0.9) };
}

/**
 * @param {GateAttempt[]} attempts
 * @param {{ since?: string | null, until?: string | null }} [window] local calendar days, both inclusive
 */
export function summarizeAttempts(attempts, { since = null, until = null } = {}) {
  const from = parseBound(since, "start");
  const to = parseBound(until, "end");
  const sec = (/** @type {string} */ s) => Math.floor(Date.parse(s) / 1000);
  /** The duration, by the write rule also for a line an older version wrote; null: unmeasured. @param {GateAttempt} a */
  const took = (a) => (a.seconds === null || a.start === null ? null : measuredSeconds(sec(a.start), sec(a.start) + a.seconds));
  const inWindow = attempts.filter((a) => {
    // An attempt with no measured duration is placed by its end: its start is from another clock.
    const t = took(a) === null && a.end ? sec(a.end) : sec(/** @type {string} */ (a.start));
    return (from === null || t >= from) && (to === null || t <= to);
  });
  const full = inWindow.filter((a) => a.kind === "full");
  const passed = full.filter((a) => a.result === "pass");
  const failed = full.filter((a) => a.result === "fail");
  /** @type {Map<string, number>} */
  const steps = new Map();
  for (const a of failed) {
    const step = cleanName(a.step);
    if (step) steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  const timed = (/** @type {GateAttempt[]} */ list) => /** @type {number[]} */ (list.map(took).filter((s) => s !== null));
  return {
    attempts: inWindow.length,
    full: full.length,
    message: inWindow.length - full.length,
    passed: passed.length,
    failed: failed.length,
    failRate: full.length ? failed.length / full.length : null,
    pass: durationStats(timed(passed)),
    fail: durationStats(timed(failed)),
    wastedSeconds: timed(failed).reduce((n, s) => n + s, 0),
    unmeasuredDurations: full.filter((a) => took(a) === null).length,
    // Ties in UTF-16 order, the same on every machine: localeCompare follows the machine's locale (Turkish puts "ia" after "Ib").
    steps: [...steps].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([step, n]) => ({ step, n })),
    unmeasuredSteps: failed.filter((a) => !cleanName(a.step)).length,
  };
}
