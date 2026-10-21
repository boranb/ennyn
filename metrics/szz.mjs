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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "../core/git.mjs";

const DAY = 86400;

/**
 * `fixCommits` is the number of candidates whose subject matches the fix pattern:
 * when most candidates are fixes, the subject convention does not separate defect
 * repair from ordinary work and the rate measures churn, not rework.
 * `censored` counts in-range commits left out because their window has not closed yet.
 * @typedef {{ origin: string, fix: string, files: string[], lines: number, share: number, days: number }} ReworkPair
 * @typedef {{ commits: number, reworked: number, rate: number | null, fixCommits: number, censored: number, pairs: ReworkPair[] }} ReworkResult
 * @typedef {{ hash: string, time: number, subject: string, changes: { status: string, path: string }[] }} LogCommit
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
 * `--since` for a lower bound in epoch seconds, one day early: git stops walking at
 * --since by a date heuristic, so the exact bound is applied to %ct afterwards.
 * @param {number} sec
 */
export function gitSince(sec) {
  return `--since=${gitDate(sec - DAY)}`;
}

/**
 * Non-merge commits with their committer time, subject and name-status list.
 * @param {string} cwd
 * @param {number | null} sinceSec
 * @returns {LogCommit[]}
 */
function readLog(cwd, sinceSec) {
  const scope = ["--no-merges", ...(sinceSec !== null ? [gitSince(sinceSec)] : [])];
  // Throws outside a repository (unmeasured is not zero); an empty repository has no log.
  git(["rev-parse", "--git-dir"], { cwd });
  if (!git(["rev-parse", "--verify", "-q", "HEAD"], { cwd, allowFail: true })) return [];
  // Hash, committer time, subject: three NUL-terminated fields per commit (no message holds a NUL,
  // so a control character in a subject cannot shift a field).
  const head = git(["log", "-z", "--format=%H%x00%ct%x00%s", ...scope], { cwd }).split("\0");
  /** @type {LogCommit[]} */
  const commits = [];
  /** @type {Map<string, LogCommit>} */
  const byHash = new Map();
  for (let i = 0; i + 2 < head.length; i += 3) {
    const c = { hash: head[i].replace(/^\n/, ""), time: Number(head[i + 1]), subject: head[i + 2], changes: [] };
    commits.push(c);
    byHash.set(c.hash, c);
  }
  // Paths, raw (-z): each status and path is its own NUL-terminated field, so a quote or a tab in a
  // file name survives (unquoted output C-quotes such names and the diff below would find no file).
  const fields = git(["-c", "core.quotePath=false", "log", "-z", "--no-renames", "--root", "--name-status", "--format=%H", ...scope], { cwd }).split("\0");
  /** @type {LogCommit | null} */
  let cur = null;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i].replace(/^\n/, "");
    if (cur && /^[A-Z]$/.test(f) && i + 1 < fields.length) cur.changes.push({ status: f, path: fields[++i] });
    else if (/^[0-9a-f]{40,64}$/.test(f)) cur = byHash.get(f) ?? null;
  }
  return commits;
}

/**
 * Full messages of the given commits (only fixes need one: a fix that names its origin's hash links it),
 * read in chunks so the command line stays short.
 * @param {string} cwd
 * @param {string[]} hashes
 * @param {number} [chunk]
 * @returns {Map<string, string>}
 */
export function commitMessages(cwd, hashes, chunk = 500) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < hashes.length; i += chunk) {
    const fields = git(["log", "--no-walk=unsorted", "-z", "--format=%H%x00%B", ...hashes.slice(i, i + chunk)], { cwd }).split("\0");
    for (let j = 0; j + 1 < fields.length; j += 2) out.set(fields[j].replace(/^\n/, ""), fields[j + 1]);
  }
  return out;
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
 * `--ignore-revs-file ""` drops the lists in blame.ignoreRevsFile, so the origins
 * are the same on every machine (a list naming a missing file still stops git).
 * @param {string} cwd
 * @param {string} fix
 * @param {string} file
 * @param {[number, number][]} ranges
 * @returns {Map<string, number>} origin commit hash → blamed line count
 */
function blameOrigins(cwd, fix, file, ranges) {
  const lineArgs = ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]);
  const out = git(["blame", "-w", "-M", "-C", "--ignore-revs-file", "", "--porcelain", ...lineArgs, `${fix}^`, "--", file], { cwd });
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40,64}) \d+ \d+ (\d+)$/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + Number(m[2]));
  }
  return counts;
}

/**
 * The commits at the edge of a shallow clone: git blames every line older than the clone on them, so
 * they are censored, neither a candidate nor any line's known origin. Empty in a full clone.
 * @param {string} cwd
 * @returns {Set<string>}
 */
export function shallowEdge(cwd) {
  const path = resolve(cwd, git(["rev-parse", "--git-path", "shallow"], { cwd }));
  return new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
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
  // The i flag folds case by English rules; "İçe aktar…" lowers to "içe" only by Turkish ones. Both are
  // tried, so an English "SPLIT" (Turkish rules make it "splıt") and a Turkish "İçe" both match.
  const commitLang = config.commitMsg?.language ?? config.language;
  const isMove = (/** @type {string} */ s) => moveRe.test(s) || moveRe.test(s.toLocaleLowerCase(commitLang === "tr" ? "tr" : "en"));
  const isProduction = (/** @type {string} */ p) => !exclude.test(p) && !testRe.test(p);

  const log = readLog(cwd, sinceSec);
  const window = windowDays * DAY;
  const inRange = (/** @type {number} */ t, /** @type {number} */ extra) =>
    (sinceSec === null || t >= sinceSec) && (untilSec === null || t <= untilSec + extra);

  /** @type {Map<string, LogCommit>} */
  const candidates = new Map();
  let censored = 0;
  const edge = shallowEdge(cwd);
  for (const c of log) {
    if (!inRange(c.time, 0) || !c.changes.some((ch) => isProduction(ch.path))) continue;
    // An edge commit's own lines cannot be told from older ones: unmeasured, like an open window.
    if (c.time + window > nowSec || edge.has(c.hash)) censored += 1;
    else candidates.set(c.hash, c);
  }

  /** @type {ReworkPair[]} */
  const pairs = [];
  const reworked = new Set();
  const fixes = log.filter((c) => fixRe.test(c.subject) && inRange(c.time, window));
  const fixMessages = commitMessages(cwd, fixes.map((c) => c.hash));
  for (const fix of fixes) {
    const production = fix.changes.filter((ch) => isProduction(ch.path));
    if (production.length > m.maxFixFiles) continue;
    /** @type {Map<string, { lines: number, files: Set<string> }>} */
    const owned = new Map();
    let total = 0;
    for (const { status, path: file } of production) {
      if (status !== "M") continue;
      // On the command line: a diff driver's own algorithm (diff.<driver>.algorithm) outranks the config pin.
      const diff = git(["diff", "--no-color", "--no-ext-diff", "--diff-algorithm=myers", "--indent-heuristic", "-U0", "-w", `${fix.hash}^`, fix.hash, "--", file], { cwd });
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
    const message = fixMessages.get(fix.hash) ?? fix.subject;
    for (const [origin, { lines, files }] of owned) {
      const o = candidates.get(origin);
      if (!o || isMove(o.subject)) continue;
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
