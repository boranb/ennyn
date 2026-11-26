/**
 * SZZ-style rework measurement: how many commits had their lines changed again
 * by a fix commit within N days.
 *
 * A candidate is a non-merge commit in [since, until] that changes at least one
 * production file (a submodule's commit is none: it holds no line, so no link can
 * name it) and whose N-day observation window has closed (a commit from yesterday
 * cannot have been reworked within a week yet; counting it would bias the rate
 * down). For every fix commit (subject matches `metrics.fixSubject`)
 * the old side of each modified production file is diffed (`-U0 -w`), and the
 * meaningful deleted lines (not blank, comment, bracket-only or import) are
 * blamed at the fix's parent with move and copy detection.
 *
 * Only a strong link counts, the criterion the origin project checked by hand
 * (precision 60-67%, n=15): the origin owns at least `minLines` of the fix's
 * meaningful deleted lines AND at least `minShare` of them, or the fix message
 * names the origin's hash. Sweep fixes (more than MAX_FIX_FILES production
 * files) and origins whose subject says they moved code are skipped: blame
 * would name them for lines they did not write.
 *
 * Pure additions are never attributed (classic SZZ): a fix that only adds lines
 * names no origin. Nor does a file the fix adds, deletes or renames (read as a
 * deletion and an addition), a file git reads as binary, or a merge: only the files
 * a non-merge fix modifies are read. A fix that moved only a submodule read nothing,
 * and is counted apart.
 */

import { resolve } from "node:path";
import { git, headCommit, rawChange } from "../core/git.mjs";
import { readIfThere } from "../core/files.mjs";

const DAY = 86400;
/** The window after a commit, in days, when `rework` is given no --days. */
export const REWORK_DAYS = 7;
/** A fix touching more production files than this is a sweep, not a defect repair. */
const MAX_FIX_FILES = 15;

/**
 * `fixCommits` is the number of candidates whose subject matches the fix pattern:
 * when most candidates are fixes, the subject convention does not separate defect
 * repair from ordinary work and the rate measures churn, not rework.
 * `censored` counts in-range commits left out because their window has not closed yet, or has no place
 * (the edge of a shallow clone, a commit object with no committer time). `skewed` counts candidates left out
 * the same way: a strong link names them, but its fix is dated before them (blame found the origin behind
 * the fix, so a clock was wrong) or has no committer time, and no other fix measured them. Only fixes in
 * the range are read: with `since`, a fix dated before it is never seen (node rework-skew-before-since).
 * `submoduleFixes` counts the fixes read (dated in the range, or up to a window after `until`) whose only production
 * change moved a submodule: they hold no line, so what they repaired is unmeasured.
 * `shallow`: HEAD's history has a shallow boundary; commits before it are not counted.
 * @typedef {{ origin: string, fix: string, files: string[], lines: number, share: number, days: number }} ReworkPair
 * @typedef {{ commits: number, reworked: number, rate: number | null, fixCommits: number, censored: number, skewed: number, submoduleFixes: number, shallow: boolean, pairs: ReworkPair[] }} ReworkResult
 * @typedef {{ hash: string, time: number, subject: string, changes: { status: string, path: string }[], submodules: string[] }} LogCommit
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

/**
 * Non-merge commits whose committer time `within` accepts, newest first, with their subject, the files
 * they change and, apart, the submodules they move. No date goes to git: its --since walk stops at a commit dated early (a clock off by
 * days) and never reaches the commits behind it. Every commit's time and hash is listed, about 52 bytes
 * each (git()'s 64 MB buffer holds some 1.2 million commits; past that it throws, never a short list),
 * and filtered here; subjects and paths are read for the kept commits only, in chunks so the command
 * line stays short. A commit object with no committer time has the time NaN: it is in no dated range.
 * @param {string} cwd
 * @param {(time: number) => boolean} within
 * @param {number} [chunk]
 * @returns {LogCommit[]}
 */
export function readLog(cwd, within, chunk = 200) {
  if (!(Number.isInteger(chunk) && chunk >= 1)) throw new RangeError(`chunk must be a whole number from 1, got ${chunk}`);
  // Throws outside a repository (unmeasured is not zero); an empty repository has no log.
  git(["rev-parse", "--git-dir"], { cwd });
  if (!headCommit(cwd)) return [];
  /** @type {Map<string, LogCommit>} */
  const byHash = new Map();
  // Neither field holds a space or a newline.
  for (const line of git(["log", "--no-merges", "--format=%ct %H"], { cwd, walk: true }).split("\n")) {
    const m = /^(\d*) ([0-9a-f]{40,64})$/.exec(line);
    if (!m) continue;
    const time = m[1] === "" ? NaN : Number(m[1]);
    if (within(time)) byHash.set(m[2], { hash: m[2], time, subject: "", changes: [], submodules: [] });
  }
  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += chunk) {
    // "--" ends the revisions: a file named like one of them would stop git on an ambiguous argument.
    const revs = [...hashes.slice(i, i + chunk), "--"];
    // Hash and subject, NUL-terminated (no message holds a NUL, so a control character cannot shift a field).
    const subjects = git(["log", "--no-walk=unsorted", "-z", "--format=%H%x00%s", ...revs], { cwd }).split("\0");
    for (let j = 0; j + 1 < subjects.length; j += 2) {
      const c = byHash.get(subjects[j].replace(/^\n/, ""));
      if (c) c.subject = subjects[j + 1];
    }
    // Paths, raw (-z): each change and path is its own NUL-terminated field, so a quote or a tab in a file name
    // survives (unquoted output C-quotes such names and the diff below would find no file). --raw for the modes: a
    // submodule's commit reads like a modified file by name. On the command line: diff.ignoreSubmodules and
    // submodule.<name>.ignore would hide it, a machine's config deciding what is said.
    const fields = git(["-c", "core.quotePath=false", "log", "--no-walk=unsorted", "-z", "--no-renames", "--ignore-submodules=none", "--root", "--raw", "--format=%H", ...revs], { cwd }).split("\0");
    /** @type {LogCommit | null} */
    let cur = null;
    for (let j = 0; j < fields.length; j++) {
      const f = fields[j].replace(/^\n/, "");
      const change = cur && j + 1 < fields.length ? rawChange(f) : null;
      if (cur && change) {
        const path = fields[++j];
        if (change.submodule) cur.submodules.push(path);
        else cur.changes.push({ status: change.status, path });
      } else if (/^[0-9a-f]{40,64}$/.test(f)) cur = byHash.get(f) ?? null;
    }
  }
  return [...byHash.values()];
}

/**
 * Full messages of the given commits (only fixes need one: a fix that names its origin's hash links it),
 * read in chunks so the command line stays short.
 * @param {string} cwd
 * @param {string[]} hashes
 * @param {number} [chunk]
 * @returns {Map<string, string>}
 */
export function commitMessages(cwd, hashes, chunk = 200) {
  if (!(Number.isInteger(chunk) && chunk >= 1)) throw new RangeError(`chunk must be a whole number from 1, got ${chunk}`);
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < hashes.length; i += chunk) {
    const fields = git(["log", "--no-walk=unsorted", "-z", "--format=%H%x00%B", ...hashes.slice(i, i + chunk), "--"], { cwd }).split("\0");
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
 * `--ignore-revs-file ""` drops the lists in blame.ignoreRevsFile, so no machine's
 * list moves the origins (a list naming a missing file still stops git);
 * `--no-textconv`: the lines as the commit holds them, as the diff in reworkRate reads them.
 * @param {string} cwd
 * @param {string} fix
 * @param {string} file
 * @param {[number, number][]} ranges
 * @returns {Map<string, number>} origin commit hash → blamed line count
 */
function blameOrigins(cwd, fix, file, ranges) {
  const lineArgs = ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]);
  const out = git(["blame", "-w", "-M", "-C", "--ignore-revs-file", "", "--no-textconv", "--porcelain", ...lineArgs, `${fix}^`, "--", file], { cwd, walk: true });
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40,64}) \d+ \d+ (\d+)$/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + Number(m[2]));
  }
  return counts;
}

/**
 * Whether `hash` is in HEAD's history: merge-base exits 1 for "no", and any other failure throws.
 * @param {string} cwd @param {string} hash
 */
function reaches(cwd, hash) {
  try {
    git(["merge-base", "--is-ancestor", hash, "HEAD"], { cwd, walk: true });
    return true;
  } catch (e) {
    if (/** @type {{ status?: number }} */ (e).status === 1) return false;
    throw e;
  }
}

/**
 * The commits at the edge of a shallow clone: git blames every line older than the clone on them, so
 * they are censored, neither a candidate nor any line's known origin. Empty in a full clone.
 * @param {string} cwd
 * @returns {Set<string>}
 */
export function shallowEdge(cwd) {
  const path = resolve(cwd, git(["rev-parse", "--git-path", "shallow"], { cwd }));
  // Not there: a full clone. There but unreadable: the edge is unknown, which is no full clone.
  return new Set((readIfThere(path) ?? "").split("\n").filter(Boolean));
}

/**
 * @param {{ cwd: string, since?: string | Date | null, until?: string | Date | null, days: number, config: any, now?: number }} opts
 *   `now` (epoch seconds, default: the clock) closes observation windows.
 * @returns {ReworkResult}
 */
export function reworkRate({ cwd, since, until, days, config, now }) {
  const m = config.metrics;
  if (!(Number.isFinite(days) && days >= 0)) throw new RangeError(`days must be a non-negative number, got ${days}`);
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

  const window = days * DAY;
  const inRange = (/** @type {number} */ t, /** @type {number} */ extra) =>
    (sinceSec === null || t >= sinceSec) && (untilSec === null || t <= untilSec + extra);
  // A candidate is in [since, until]; a fix may come up to a window after it.
  const log = readLog(cwd, (t) => inRange(t, window));

  /** @type {Map<string, LogCommit>} */
  const candidates = new Map();
  let censored = 0;
  let submoduleFixes = 0;
  const edge = shallowEdge(cwd);
  for (const c of log) {
    if (!inRange(c.time, 0) || !c.changes.some((ch) => isProduction(ch.path))) continue;
    // An edge commit's own lines cannot be told from older ones: unmeasured, like an open window, and like
    // a commit with no time (in a range with no dates), whose window has no place.
    if (!(c.time + window <= nowSec) || edge.has(c.hash)) censored += 1;
    else candidates.set(c.hash, c);
  }

  /** @type {ReworkPair[]} */
  const pairs = [];
  const reworked = new Set();
  /** @type {Set<string>} origins a link names whose window cannot be measured */
  const skewedOrigins = new Set();
  const fixes = log.filter((c) => fixRe.test(c.subject) && inRange(c.time, window));
  const fixMessages = commitMessages(cwd, fixes.map((c) => c.hash));
  for (const fix of fixes) {
    const production = fix.changes.filter((ch) => isProduction(ch.path));
    // No line to read is no clean answer: said, as an open window is.
    if (!production.length && fix.submodules.some(isProduction)) submoduleFixes += 1;
    if (production.length > MAX_FIX_FILES) continue;
    /** @type {Map<string, { lines: number, files: Set<string> }>} */
    const owned = new Map();
    let total = 0;
    for (const { status, path: file } of production) {
      if (status !== "M") continue;
      // On the command line: a diff driver's own algorithm (diff.<driver>.algorithm) outranks the config pin. A
      // textconv driver (a machine's config) would show other lines than the commit holds.
      const diff = git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-algorithm=myers", "--indent-heuristic", "-U0", "-w", `${fix.hash}^`, fix.hash, "--", file], { cwd });
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
      const share = total ? lines / total : 0;
      const named = message.includes(origin.slice(0, 7));
      if (!named && !(lines >= m.minLines && share >= m.minShare)) continue;
      const delta = fix.time - o.time;
      // Blame walks back from the fix, so a fix dated before its origin means a wrong clock, and a fix with no
      // time (NaN) has no window: unmeasured, said.
      if (!(delta >= 0)) {
        skewedOrigins.add(origin);
        continue;
      }
      if (delta > window) continue;
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

  // Such an origin is unmeasured, like an open window: out of the count, unless another fix measured it.
  const unmeasured = [...skewedOrigins].filter((h) => !reworked.has(h));
  for (const h of unmeasured) candidates.delete(h);
  const commits = candidates.size;
  const fixCommits = [...candidates.values()].filter((c) => fixRe.test(c.subject)).length;
  // Only a boundary in HEAD's history holds commits back: a branch fetched shallow elsewhere does not.
  const shallow = [...edge].some((h) => reaches(cwd, h));
  return { commits, reworked: reworked.size, rate: commits === 0 ? null : reworked.size / commits, fixCommits, censored, skewed: unmeasured.length, submoduleFixes, shallow, pairs };
}
