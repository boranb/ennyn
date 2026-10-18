/**
 * SZZ-style rework measurement: how many commits had their lines changed again
 * by a fix commit within N days.
 *
 * A candidate is a non-merge commit in [since, until] that touches at least one
 * production path and whose N-day observation window has closed (a commit from
 * yesterday cannot have been reworked within a week yet; counting it would bias
 * the rate down). For every fix commit (subject matches `metrics.fixSubject`)
 * the old side of each modified production file is diffed (`-U0 -w`), and the
 * meaningful deleted lines (not blank, comment, bracket-only or import) are
 * blamed at the fix's parent with move and copy detection.
 *
 * Only a strong link counts, the criterion the origin project checked by hand
 * (precision 60-67%, n=15): the origin owns at least `minLines` of the fix's
 * meaningful deleted lines AND at least `minShare` of them, or the fix message
 * names the origin's hash. Sweep fixes (more than `maxFixFiles` production
 * files) and origins whose subject says they moved code are skipped: blame
 * would name them for lines they did not write.
 *
 * Pure additions are never attributed (classic SZZ): a fix that only adds lines
 * names no origin.
 */

import { git } from "../core/git.mjs";

const DAY = 86400;

/**
 * `fixCommits` is the number of candidates whose subject matches the fix pattern:
 * when most candidates are fixes, the subject convention does not separate defect
 * repair from ordinary work and the rate measures churn, not rework.
 * `censored` counts in-range commits left out because their window has not closed yet.
 * @typedef {{ origin: string, fix: string, files: string[], lines: number, share: number, days: number }} ReworkPair
 * @typedef {{ commits: number, reworked: number, rate: number | null, fixCommits: number, censored: number, pairs: ReworkPair[] }} ReworkResult
 * @typedef {{ hash: string, time: number, subject: string, body: string, changes: { status: string, path: string }[] }} LogCommit
 */

/**
 * Parse a bound. "YYYY-MM-DD" is a local calendar day (start for `since`, end
 * for `until`, both inclusive); other strings go through Date.parse.
 * @param {string | Date | undefined | null} value
 * @param {"start" | "end"} edge
 * @returns {number | null} epoch seconds
 */
export function parseBound(value, edge) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("invalid date");
    return Math.floor(value.getTime() / 1000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const day = new Date(y, mo, d);
    if (day.getFullYear() !== y || day.getMonth() !== mo || day.getDate() !== d) throw new RangeError(`invalid date "${value}"`);
    if (edge === "start") return Math.floor(day.getTime() / 1000);
    return Math.floor(new Date(y, mo, d + 1).getTime() / 1000) - 1;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date "${value}"`);
  return Math.floor(ms / 1000);
}

/** @param {number} sec */
function gitDate(sec) {
  const d = new Date(sec * 1000);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * Non-merge commits with their committer time, subject and name-status list.
 * @param {string} cwd
 * @param {number | null} sinceSec
 * @returns {LogCommit[]}
 */
function readLog(cwd, sinceSec) {
  const args = [
    "-c",
    "core.quotePath=false",
    "log",
    "--no-merges",
    "--no-renames",
    "--root",
    "--name-status",
    "--format=%x01%H%x00%ct%x00%s%x00%b%x02",
  ];
  // One day of slack: git stops walking at --since using a date heuristic.
  if (sinceSec !== null) args.push(`--since=${gitDate(sinceSec - DAY)}`);
  // Throws outside a repository (unmeasured is not zero); an empty repository has no log.
  git(["rev-parse", "--git-dir"], { cwd });
  if (!git(["rev-parse", "--verify", "-q", "HEAD"], { cwd, allowFail: true })) return [];
  const out = git(args, { cwd });
  /** @type {LogCommit[]} */
  const commits = [];
  for (const chunk of out.split("\x01").slice(1)) {
    const end = chunk.indexOf("\x02");
    const header = end === -1 ? chunk : chunk.slice(0, end);
    const [hash, ct, subject = "", body = ""] = header.split("\0");
    const changes = [];
    for (const line of (end === -1 ? "" : chunk.slice(end + 1)).split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      changes.push({ status: line.slice(0, tab).charAt(0), path: line.slice(tab + 1) });
    }
    commits.push({ hash, time: Number(ct), subject, body, changes });
  }
  return commits;
}

/**
 * Old-side line numbers of a `-U0` diff whose content is code (not blank, not a comment).
 * @param {string} diff
 * @returns {number[]}
 */
export function deletedCodeLines(diff) {
  const lines = [];
  let old = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) {
      old = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      if (isCodeLine(line.slice(1))) lines.push(old);
      old += 1;
    }
  }
  return lines;
}

const COMMENT = /^(\/\/|\/\*|\*|#(?!!)|--|<!--)/;
const BRACKETS_ONLY = /^[\]){}([;,]*$/;
const IMPORT = /^(import\s|export\s+(\*|\{[^}]*\})\s+from\s|\}\s*from\s+["']|from\s+\S+\s+import\s|(const|let|var)\s+\S+\s*=\s*require\()/;

/**
 * A line a defect can live in: not blank, comment, bracket-only or import.
 * @param {string} text
 */
export function isCodeLine(text) {
  const s = text.trim();
  if (s === "") return false;
  return !(COMMENT.test(s) || BRACKETS_ONLY.test(s.replace(/\s+/g, "")) || IMPORT.test(s));
}

/**
 * @param {number[]} lines sorted ascending
 * @returns {[number, number][]}
 */
function toRanges(lines) {
  /** @type {[number, number][]} */
  const ranges = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/**
 * One blame call per file: git accepts several -L ranges at once. `-M -C` follows
 * lines moved within and across files to the commit that wrote them.
 * @param {string} cwd
 * @param {string} fix
 * @param {string} file
 * @param {[number, number][]} ranges
 * @returns {Map<string, number>} origin commit hash → blamed line count
 */
function blameOrigins(cwd, fix, file, ranges) {
  const lineArgs = ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]);
  const out = git(["blame", "-w", "-M", "-C", "--porcelain", ...lineArgs, `${fix}^`, "--", file], { cwd });
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40,64}) \d+ \d+ (\d+)$/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + Number(m[2]));
  }
  return counts;
}

/**
 * @param {{ cwd: string, since?: string | Date | null, until?: string | Date | null, days?: number, config: any, now?: number }} opts
 *   `now` (epoch seconds, default: the clock) closes observation windows.
 * @returns {ReworkResult}
 */
export function reworkRate({ cwd, since, until, days, config, now }) {
  const m = config.metrics;
  const windowDays = days ?? m.reworkDays;
  if (!(Number.isFinite(windowDays) && windowDays >= 0)) throw new RangeError(`days must be a non-negative number, got ${windowDays}`);
  const sinceSec = parseBound(since, "start");
  const untilSec = parseBound(until, "end");
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const exclude = new RegExp(m.excludeRe);
  const testRe = new RegExp(m.testRe);
  const fixRe = new RegExp(m.fixSubject);
  const moveRe = new RegExp(m.moveSubject, "i");
  const isProduction = (/** @type {string} */ p) => !exclude.test(p) && !testRe.test(p);

  const log = readLog(cwd, sinceSec);
  const window = windowDays * DAY;
  const inRange = (/** @type {number} */ t, /** @type {number} */ extra) =>
    (sinceSec === null || t >= sinceSec) && (untilSec === null || t <= untilSec + extra);

  /** @type {Map<string, LogCommit>} */
  const candidates = new Map();
  let censored = 0;
  for (const c of log) {
    if (!inRange(c.time, 0) || !c.changes.some((ch) => isProduction(ch.path))) continue;
    if (c.time + window > nowSec) censored += 1;
    else candidates.set(c.hash, c);
  }

  /** @type {ReworkPair[]} */
  const pairs = [];
  const reworked = new Set();
  for (const fix of log) {
    if (!fixRe.test(fix.subject) || !inRange(fix.time, window)) continue;
    const production = fix.changes.filter((ch) => isProduction(ch.path));
    if (production.length > m.maxFixFiles) continue;
    /** @type {Map<string, { lines: number, files: Set<string> }>} */
    const owned = new Map();
    let total = 0;
    for (const { status, path: file } of production) {
      if (status !== "M") continue;
      const diff = git(["diff", "--no-color", "--no-ext-diff", "-U0", "-w", `${fix.hash}^`, fix.hash, "--", file], { cwd });
      const deleted = deletedCodeLines(diff);
      if (!deleted.length) continue;
      total += deleted.length;
      for (const [origin, n] of blameOrigins(cwd, fix.hash, file, toRanges(deleted))) {
        const o = owned.get(origin) ?? { lines: 0, files: new Set() };
        o.lines += n;
        o.files.add(file);
        owned.set(origin, o);
      }
    }
    const message = `${fix.subject}\n${fix.body}`;
    for (const [origin, { lines, files }] of owned) {
      const o = candidates.get(origin);
      if (!o || moveRe.test(o.subject)) continue;
      const delta = fix.time - o.time;
      if (delta < 0 || delta > window) continue;
      const share = total ? lines / total : 0;
      const named = message.includes(origin.slice(0, 7));
      if (!named && !(lines >= m.minLines && share >= m.minShare)) continue;
      reworked.add(origin);
      pairs.push({
        origin,
        fix: fix.hash,
        files: [...files].sort(),
        lines,
        share: Math.round(share * 1000) / 1000,
        days: Math.round((delta / DAY) * 100) / 100,
      });
    }
  }

  const commits = candidates.size;
  const fixCommits = [...candidates.values()].filter((c) => fixRe.test(c.subject)).length;
  return { commits, reworked: reworked.size, rate: commits === 0 ? null : reworked.size / commits, fixCommits, censored, pairs };
}
