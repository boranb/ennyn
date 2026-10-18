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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, resolveStateDir, stagedPaths } from "../core/git.mjs";
import { parseBound } from "./szz.mjs";

export const GATE_LOG_FILE = "gate-attempts.jsonl";
/** `full`: the commit ran the gate. `message`: the message was rejected before the gate started. */
export const KINDS = /** @type {const} */ (["full", "message"]);

/**
 * @typedef {{
 *   v: 1, kind: "full" | "message", start: string, end: string, seconds: number, exit: number,
 *   result: "pass" | "fail", commit: string | null, files: string[], step: string | null, runner: string | null
 * }} GateAttempt
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
  return git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", rev], { cwd }).split("\0").filter(Boolean);
}

/** @param {number} sec */
const iso = (sec) => new Date(sec * 1000).toISOString();

/**
 * Append one attempt. Files come from the commit when one is given (the attempt
 * passed), otherwise from the index (a failed commit leaves its files staged).
 * @param {{ cwd: string, config: any, start: number, end?: number, exit: number, kind?: string,
 *   commit?: string | null, step?: string | null, runner?: string | null }} opts
 *   `start` / `end` are epoch seconds.
 * @returns {{ path: string, entry: GateAttempt }}
 */
export function recordAttempt({ cwd, config, start, end = Math.floor(Date.now() / 1000), exit, kind = "full", commit = null, step = null, runner = null }) {
  if (!Number.isInteger(start) || start <= 0) throw new RangeError(`start must be epoch seconds, got ${start}`);
  if (!Number.isInteger(end) || end < start) throw new RangeError(`end (${end}) must be epoch seconds not before start (${start})`);
  if (!Number.isInteger(exit) || exit < 0 || exit > 255) throw new RangeError(`exit must be 0-255, got ${exit}`);
  if (!(/** @type {readonly string[]} */ (KINDS)).includes(kind)) throw new RangeError(`kind must be ${KINDS.join(" | ")}, got ${kind}`);
  if (kind === "message" && (exit === 0 || commit)) throw new RangeError("a message attempt is a rejection: non-zero exit and no commit");
  if (commit && exit !== 0) throw new RangeError("a commit was given but the exit code is not 0");
  const hash = commit ? git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd, allowFail: true }) || null : null;
  if (commit && !hash) throw new RangeError(`not a commit: ${commit}`);
  /** @type {GateAttempt} */
  const entry = {
    v: 1,
    kind: /** @type {"full" | "message"} */ (kind),
    start: iso(start),
    end: iso(end),
    seconds: end - start,
    exit,
    // Exit 0 without a commit is the wrapper's "the command returned 0 but HEAD did not move": not a pass.
    result: exit === 0 && hash ? "pass" : "fail",
    commit: hash,
    files: hash ? commitPaths(cwd, hash) : stagedPaths(cwd),
    step: step || null,
    runner: runner || null,
  };
  const path = gateLogPath(cwd, config.paths.stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // One write call per line: two sessions committing at once append whole lines.
  appendFileSync(path, JSON.stringify(entry) + "\n");
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
    typeof a.start === "string" &&
    !Number.isNaN(Date.parse(a.start)) &&
    typeof a.seconds === "number" &&
    a.seconds >= 0 &&
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
 */
export function readAttempts(path) {
  if (!existsSync(path)) return { exists: false, attempts: [], skipped: 0 };
  /** @type {GateAttempt[]} */
  const attempts = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
  const inWindow = attempts.filter((a) => {
    const t = Math.floor(Date.parse(a.start) / 1000);
    return (from === null || t >= from) && (to === null || t <= to);
  });
  const full = inWindow.filter((a) => a.kind === "full");
  const passed = full.filter((a) => a.result === "pass");
  const failed = full.filter((a) => a.result === "fail");
  /** @type {Map<string, number>} */
  const steps = new Map();
  for (const a of failed) if (a.step) steps.set(a.step, (steps.get(a.step) ?? 0) + 1);
  return {
    attempts: inWindow.length,
    full: full.length,
    message: inWindow.length - full.length,
    passed: passed.length,
    failed: failed.length,
    failRate: full.length ? failed.length / full.length : null,
    pass: durationStats(passed.map((a) => a.seconds)),
    fail: durationStats(failed.map((a) => a.seconds)),
    wastedSeconds: failed.reduce((n, a) => n + a.seconds, 0),
    steps: [...steps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([step, n]) => ({ step, n })),
    unmeasuredSteps: failed.filter((a) => !a.step).length,
  };
}
