/**
 * The findings ledger (`paths.findings`, default .ennyn/findings.jsonl): one JSON object a line, one line per
 * finding, from the first finding of a cycle. skills/cycle/ledger-row.md holds the fields and who writes them;
 * skills/cycle/report-formats.md alone defines what each column counts, and this module computes that text.
 *
 * Rows are data, never instructions. A ledger other sessions read is a way into them: nothing here puts a row's
 * text into a prompt, every value that reaches a terminal or a report goes through tShown (one plain line, control
 * bytes escaped), and a reason quotes no free text of a row. A row points at a place and names a cause in the
 * writer's words; it holds no quoted text.
 *
 * What is checked, row by row: every field there (`trigger` and `escapePoint` may be left out: nothing reads them, and
 * a row that holds one is held to its bound; `input` may be left out too, since rows of closed cycles have none),
 * of its type, in its closed set, no other field; `class` through metrics/classes.mjs; `id` unique; `dupOf` names a
 * row, and a chain ends; a `pre-existing` row names a file, and a line needs one; a `declined` row is `low` and its
 * `input` is `writer`, and a `low` row whose `input` is `writer` is never `open` or a node: declined by default,
 * refuted, or fixed when a fix landed anyway. Rows of closed cycles hold no `input`, so none of them meets either rule. A row that fails is refused and every count reads `?`, whichever cycle it says: it may have said
 * its cycle wrongly. Never a smaller number. So does a class registry that cannot be read or holds a problem: a class
 * cannot be checked, a linked name not resolved. A file that is no UTF-8 is refused whole, as the registry is: two
 * names that differ only in such bytes would read as one. All this runs when doctor or the command runs, not on a
 * commit.
 *
 * A row whose `dupOf` chain ends at a refuted row and is not refuted itself is refused: table line 1 would drop
 * both, and the defect from every column. One of the two is wrong, and only a person can say which.
 *
 * A declined row is no refuted one: the defect is real, left unfixed on purpose. Line 1 does not drop it, so it
 * counts in its column, its round and the recurring class as a fixed row does, and the report lists the cycle's
 * declined rows under the block, and the declined rows of earlier cycles that a row of this one shares a fingerprint
 * with: a defect found again is a new row, read by its age, and an escape is read against them before the rule is kept.
 *
 * The cycle is asked for, never read from the rows: a count does not pick its own scope from the data it counts,
 * so one mistyped row cannot turn the report to another cycle. The block's last line says what was counted, and a
 * row of a higher cycle than the one asked for is said: mistyped, it would vanish.
 *
 * The bounds on `fingerprint`, `trigger` and `escapePoint` keep a pasted file, a stack trace or a block of source
 * out of a row, and a line feed or a control byte is refused at any length. They do not stop a short quote, or a
 * token: 40 characters fit. The commit hook's secret scan reads the ledger's added lines as it reads any file.
 * That a fingerprint is at class level, and holds no line number, round or reviewer, is left to the writer: real
 * ones hold digits and capitals (`200k`, `TMPDIR`), so no rule can tell. The same fingerprint twice with no `dupOf`,
 * in one cycle or across cycles, is said, and refuses nothing: a defect seen again after its fix is a new row by
 * report-formats.md. One list, over the whole ledger: doctor counts its groups, a report keeps those with a counted row.
 *
 * Under the block, the recurrence ladder of report-formats.md, per file, over cycle N and the two before it: which
 * files are at rung 2 and at the fix-loop brake, and why. A file at the brake that got a new patch node fails the
 * command, and so does one whose patch nodes could not be looked for: that is never read as none. ladderOf and
 * brakePatches say what each counts.
 *
 * What the table needs from git it asks once, and only when a row needs it. Git failing, a tree a partial clone
 * does not hold or a start not noted reads `?` in the columns that row could fall in, with the reason, and the
 * others stay exact. Objects as HOOK_READ_ENV reads them: nothing is fetched.
 */

import { isUtf8 } from "node:buffer";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { leavesRoot, READ_LIMIT, readRegular } from "../core/files.mjs";
import { git, gitBytes, HOOK_READ_ENV } from "../core/git.mjs";
import { tShown } from "../core/i18n.mjs";
import { cycleStart } from "./bypass.mjs";
import { HASH, classProblems, currentClass, isId, isObject, loadClasses, plain, quoted } from "./classes.mjs";
import { formatConvergence } from "./convergence.mjs";
import { loadGraph } from "../plan/mechanization.mjs";

/** The highest cycle: a date for a cycle's number is refused, and with it a typo of a few digits. */
export const CYCLE_MAX = 9999;
/** The longest fingerprint: a few words. The real ledger's longest is 89. */
export const FINGERPRINT_MAX = 120;
/** The longest trigger or escape point. The real ledger's longest are 145 and 124. */
export const NOTE_MAX = 200;
/** The most refused rows kept with their reasons; the others are counted. */
export const KEPT_MAX = 20;
/**
 * Past this many refused rows reading stops: the counts read `?` already, and each line that does not parse costs
 * Node an exception (16 MiB of them took 114 s at load 10, cycle 16).
 */
export const REFUSED_MAX = 1000;
/** The most ids, or names, a reason lists; the others are counted. */
const LISTED_MAX = 5;
/** The most same-fingerprint lines a report prints; the others are counted. */
const SAME_SHOWN = 5;
const PATH_MAX = 300;
const NAME_MAX = 120;

export const SEVERITIES = ["critical", "high", "medium", "low"];
/** `brief`: a gap of the cycle's own brief, which a task's restatement showed before any code (skills/cycle/task-brief.md, Report). */
export const SOURCES = ["first-write", "previous-fix", "pre-existing", "brief"];
/** What finds a defect without being a gate; report-formats.md: any other value is `test:<file>` or `gate:<name>`. */
export const NOT_GATES = ["review", "measurement", "author-reading"];
export const OUTCOMES = ["fixed-test", "fixed", "refuted", "declined", "open"];
/** Who produces the input a finding's scenario needs: an attacker, normal use (a person or an agent), or only this project's own writer. */
export const INPUTS = ["attacker", "use", "writer"];

/** The columns a row with no age could fall in. */
const AGE_COLUMNS = /** @type {const} */ (["preExisting", "gateCaught", "escapedNew", "escapedOld"]);
const COUNT_KEYS = /** @type {const} */ (["foundInReview", "fixIntroduced", ...AGE_COLUMNS]);
/** The file table lines read, as report-formats.md spells it: ENNYN_CONFIG does not move it. */
const CONFIG = ".ennyn/config.json";
const COMMIT = /^[0-9a-f]{7,64}$/;
const GATE = /^gate:[a-z0-9][a-z0-9:._-]*$/;

/**
 * A clean path from the top of the tree, as git spells it: `./x`, `a//b`, a backslash or a space at a part's end
 * name a file only by luck, and a test spelled so would never read as tracked.
 * @param {unknown} v @returns {boolean}
 */
const cleanPath = (v) => plain(v, PATH_MAX) && !/^~|^[A-Za-z]:|\\/.test(v) && v.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part === part.trim());
/** @param {string[]} list @returns {[(v: unknown) => boolean, string]} */
const oneOf = (list) => [(v) => list.includes(/** @type {string} */ (v)), `one of ${list.join(", ")}`];
/** @param {number} max @returns {[(v: unknown) => boolean, string]} */
const text = (max) => [(v) => plain(v, max), `one plain line of at most ${max} characters`];

/** Each field but `class`, with what it must be. @type {Record<string, [(v: unknown) => boolean, string]>} */
const RULES = {
  cycle: [(v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= CYCLE_MAX, `a whole number from 1 to ${CYCLE_MAX}`],
  task: [(v) => plain(v, NAME_MAX) && !/\s/.test(v), "a graph node's id"],
  round: [(v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0, "a whole number, 0 or more"],
  id: [isId, "lower-case words and digits parted by single dashes"],
  severity: oneOf(SEVERITIES),
  source: oneOf(SOURCES),
  caughtBy: [(v) => NOT_GATES.includes(/** @type {string} */ (v)) || (typeof v === "string" && ((GATE.test(v) && v.length <= NAME_MAX) || (v.startsWith("test:") && cleanPath(v.slice(5))))), `one of ${NOT_GATES.join(", ")}, test:<file>, gate:<name>`],
  dupOf: [(v) => v === null || isId(v), "null or a row's id"],
  fingerprint: text(FINGERPRINT_MAX),
  outcome: [(v) => OUTCOMES.includes(/** @type {string} */ (v)) || (typeof v === "string" && /^node:\S+$/.test(v) && plain(v, NAME_MAX)), `one of ${OUTCOMES.join(", ")}, node:<graph id>`],
  commit: [(v) => v === null || (typeof v === "string" && COMMIT.test(v)), "null or a commit's hash"],
  bornIn: [(v) => v === null || (typeof v === "string" && HASH.test(v)), "null or a full commit hash"],
  file: [(v) => v === null || cleanPath(v), "null or a path from the repository's top"],
  line: [(v) => v === null || (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1), "null or a line number"],
};
/** The fields a row may leave out, with what they must be when it holds them. @type {typeof RULES} */
const OPTIONAL = { trigger: text(NOTE_MAX), escapePoint: text(NOTE_MAX), input: oneOf(INPUTS) };
/** Every field of a row, in the order ledger-row.md lists them. */
export const FIELDS = ["cycle", "task", "round", "id", "severity", "class", "source", "caughtBy", "dupOf", "fingerprint", "trigger", "escapePoint", "input", "outcome", "commit", "bornIn", "file", "line"];

/**
 * @typedef {{ cycle: number, task: string, round: number, id: string, severity: string, class: string[], source: string, caughtBy: string, dupOf: string | null, fingerprint: string, trigger?: string, escapePoint?: string, input?: string, outcome: string, commit: string | null, bornIn: string | null, file: string, line: number | null }} Row
 * @typedef {{ raw: Record<string, unknown>, at: string, problems: string[] }} Entry a row as it is read, valid or not
 * @typedef {{ at: string, problems: string[] }} Refused
 * @typedef {{ rows: Row[], refused: Refused[], refusedCount: number, stopped: boolean, same: string[][], total: number }} Parsed
 *   `rows`: those that passed. `refused`: the first KEPT_MAX, `refusedCount` all of them. `stopped`: reading stopped
 *   at REFUSED_MAX, so `refusedCount` and `total` are how far it went. `same`: ids that share a fingerprint with no
 *   dupOf. `total`: every line read that is not blank.
 * @typedef {{ key: string, vars?: Record<string, string | number | string[]> }} Reason a catalog key below findings.why, as a report gives it
 * @typedef {{ key: string, vars: Record<string, string | number | string[]>, ids: string[] }} Unplaced what could not be placed, and why
 * @typedef {{ id: string, times: number, layers: [string, number][] }} Recurring
 * @typedef {{ file: string, classes: { id: string, cycles: number[] }[], previousFix: number[], rounds: { round: number, previousFix: number, fixed: number }[], ids: string[], nodes: { row: string, node: string }[] }} LadderFile
 *   why the file is there: classes in the cycles it needs, the cycles of previous-fix rows, the rounds of cycle N with
 *   more previous-fix rows than fixed ones; `ids` its rows in the window, `nodes` those whose outcome names a node
 * @typedef {{ node: string, file: string, rows: string[], path: boolean }} Patch a new node linked to a file at the brake: by the rows that name it or it names, or by the file's path
 * @typedef {{ cycles: number[], read: number[], brake: LadderFile[], rung2: LadderFile[], patches: Patch[], unmeasured: Reason | null }} Ladder
 *   `read`: the ledger's rows of each cycle, in the order of `cycles`; `unmeasured`: why patch nodes could not be looked for
 * @typedef {{ path: string, cycle: number, rows: number, counted: number, counts: import("./convergence.mjs").Convergence, recurring: { exact: boolean, top: Recurring[] }, unplaced: Unplaced[], refused: Refused[], refusedCount: number, stopped: boolean, same: string[][], higher: string[], untracked: string[], declined: string[], refound: string[], brief: string[], ladder: Ladder | null }} CycleReport
 *   `rows`: the ledger's, `counted`: the cycle's. `top` is empty unless `exact`. `same`: the ledger's groups that hold
 *   a counted row. `higher`:
 *   ids of rows of a cycle above the one asked for. `untracked`: ids of rows whose test HEAD does not track.
 *   `declined`: ids of the cycle's declined rows line 1 leaves. `refound`: ids of declined rows of earlier cycles,
 *   with no dupOf, whose fingerprint, folded, a row of this cycle that line 1 leaves holds: a lower bound. `brief`: ids
 *   of the cycle's brief rows line 1 leaves, which line 2 puts in no column; no round, recurring class or ladder reads
 *   them, and only a name of theirs that resolves to no entry is said. `ladder`:
 *   the recurrence ladder, null when the counts could not be read.
 */

/**
 * What is wrong with one row on its own, other rows aside. A reason names a field and what it must be, and quotes
 * no value but a field's name and a class value cut short. `reg` null: the registry could not be read, classes are
 * left unchecked and the caller says so.
 * @param {Record<string, unknown>} raw @param {import("./classes.mjs").Registry | null} reg
 * @returns {string[]}
 */
function rowProblems(raw, reg) {
  const problems = Object.keys(raw).filter((k) => !FIELDS.includes(k)).map((k) => `unknown field ${quoted(k)}`);
  for (const [field, [holds, must]] of Object.entries(RULES)) {
    if (!Object.hasOwn(raw, field)) problems.push(`no ${field}`);
    else if (!holds(raw[field])) problems.push(`${field} must be ${must}`);
  }
  for (const [field, [holds, must]] of Object.entries(OPTIONAL)) if (Object.hasOwn(raw, field) && !holds(raw[field])) problems.push(`${field} must be ${must}`);
  if (!Object.hasOwn(raw, "class")) problems.push("no class");
  else if (reg) problems.push(...classProblems(reg, raw.class));
  if (raw.source !== "pre-existing" && typeof raw.bornIn === "string") problems.push("bornIn belongs only to a pre-existing row");
  if (raw.outcome === "declined") {
    // finding-schema.md, Outcome: only a low finding whose input this project's own writer alone makes is left unfixed.
    if (raw.severity !== "low") problems.push("declined belongs only to a low row: a critical or high finding is fixed with a test, a node or refuted, a medium one fixed, a node or refuted");
    if (raw.input !== "writer") problems.push("a declined row's input is writer: only a finding whose input this project's own writer alone makes is declined");
  } else if (raw.severity === "low" && raw.input === "writer" && (raw.outcome === "open" || (typeof raw.outcome === "string" && raw.outcome.startsWith("node:")))) {
    // Declined by default; a fix that landed anyway is recorded as what happened.
    problems.push("a low row whose input is writer is declined, refuted or fixed: it is never left open, and it becomes no node");
  }
  if (raw.source === "brief") {
    // ledger-row.md: the orchestrator's row, read before review from a report's opening, about a text outside the tree.
    if (raw.round !== 0) problems.push("a brief row is of round 0: it is read before review");
    if (raw.caughtBy !== "review") problems.push("a brief row is caught by review: the orchestrator's reading of the restatement");
    if (raw.file !== null) problems.push("a brief row names no file: the brief is not in the tree");
    if (raw.severity !== "medium" && raw.severity !== "low") problems.push("a brief row is medium or low: the gap reached no code");
    if (raw.outcome !== "fixed" && raw.outcome !== "refuted") problems.push("a brief row is fixed, the brief corrected, or refuted");
  }
  if (raw.file === null) {
    // With no file there is no line to blame, so a null bornIn would have no repair.
    if (raw.source === "pre-existing") problems.push("a pre-existing row names a file: the one the fix belongs in");
    if (typeof raw.line === "number") problems.push("a line needs a file");
  }
  return problems;
}

/**
 * Every `dupOf`: it names a row, and its chain, read to its end, ends at one that is not refuted unless this row is,
 * and at a brief row exactly when this row is one.
 * A chain that ends at a declined row holds only declined or refuted rows of that row's cycle, and a declined row's
 * chain ends at a declined one. One pass, each row walked once.
 * @param {Entry[]} entries @param {Map<string, Entry>} byId
 */
function chainProblems(entries, byId) {
  /** Where a row's chain ends; null when it does not. @type {Map<string, Entry | null>} */
  const ends = new Map();
  for (const entry of entries) {
    const { dupOf } = entry.raw;
    if (!isId(dupOf)) continue;
    if (!byId.has(dupOf)) {
      entry.problems.push("dupOf names no row");
      continue;
    }
    /** @type {Set<string>} */
    const here = new Set();
    /** @type {Entry} */
    let on = entry;
    while (isId(on.raw.dupOf) && byId.has(on.raw.dupOf) && !ends.has(/** @type {string} */ (on.raw.id)) && !here.has(/** @type {string} */ (on.raw.id))) {
      here.add(/** @type {string} */ (on.raw.id));
      on = /** @type {Entry} */ (byId.get(on.raw.dupOf));
    }
    const id = /** @type {string} */ (on.raw.id);
    const end = here.has(id) ? null : ends.has(id) ? /** @type {Entry | null} */ (ends.get(id)) : on;
    for (const walked of here) ends.set(walked, end);
    if (end === null) entry.problems.push("dupOf leads in a circle: a chain must end");
    else if ((end.raw.source === "brief") !== (entry.raw.source === "brief")) entry.problems.push("dupOf joins a brief row and a row that is not: a brief's gap and a defect of the code are two rows, each counted where it belongs");
    else if (end.raw.outcome === "refuted" && entry.raw.outcome !== "refuted") entry.problems.push("dupOf ends at a refuted row while this row is not refuted: the defect would count nowhere, so one of the two is wrong");
    else if (end.raw.outcome === "declined") {
      // The defect would read as declined, left unfixed, whatever this row says of it.
      if (entry.raw.outcome !== "declined" && entry.raw.outcome !== "refuted") entry.problems.push("dupOf ends at a declined row while this row is neither declined nor refuted: the defect would read as left unfixed");
      // A later cycle's find is a new row, read by its age: a dupOf would count it nowhere.
      if (end.raw.cycle !== entry.raw.cycle) entry.problems.push("dupOf ends at a declined row of another cycle: a defect found again is a new row of its own cycle");
    } else if (entry.raw.outcome === "declined") entry.problems.push("a declined row's dupOf ends at a row that is not declined: the two outcomes clash");
  }
}

/**
 * Reads a ledger's text, line by line. Memory and time follow the file: a line that holds no valid id is counted and
 * let go, past KEPT_MAX a refusal keeps no reasons, and past REFUSED_MAX reading stops.
 * @param {string} text
 * @param {import("./classes.mjs").Registry | null} reg
 * @returns {Parsed}
 */
export function parseFindings(text, reg) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Map<string, Entry>} */
  const byId = new Map();
  /** @type {Refused[]} */
  const refused = [];
  let refusedCount = 0;
  /** Rows of `entries` already known to fail. */
  let failing = 0;
  let total = 0;
  let stopped = false;
  const refuse = (/** @type {string} */ at, /** @type {string[]} */ problems) => {
    if (refused.length < KEPT_MAX) refused.push({ at, problems });
    refusedCount++;
  };
  // A byte order mark some editors write is no part of a row.
  for (const [i, line] of text.replace(/^\uFEFF/, "").split("\n").entries()) {
    if (line.trim() === "") continue;
    if (refusedCount + failing >= REFUSED_MAX) {
      stopped = true;
      break;
    }
    total++;
    /** @type {unknown} */
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      // Node's message can show the text around the fault, and a row's text is never quoted.
      refuse(`line ${i + 1}`, ["the line does not parse"]);
      continue;
    }
    if (!isObject(raw)) {
      refuse(`line ${i + 1}`, ["a row must be a JSON object"]);
      continue;
    }
    const problems = rowProblems(raw, reg);
    if (!isId(raw.id)) {
      refuse(`line ${i + 1}`, problems);
      continue;
    }
    const entry = { raw, at: `line ${i + 1} (${raw.id})`, problems };
    entries.push(entry);
    if (byId.has(raw.id)) problems.push("id is there twice");
    else byId.set(raw.id, entry);
    if (problems.length) failing++;
  }
  chainProblems(entries, byId);
  /** @type {Row[]} */
  const rows = [];
  for (const { raw, at, problems } of entries) {
    if (problems.length) refuse(at, problems);
    else rows.push(/** @type {Row} */ (/** @type {unknown} */ (raw)));
  }
  return { rows, refused, refusedCount, stopped, same: sameFingerprint(rows), total };
}

/**
 * Ids of rows that share a fingerprint with no dupOf, a list for each fingerprint: said, and refused nowhere.
 * @param {Row[]} rows
 * @returns {string[][]}
 */
function sameFingerprint(rows) {
  /** @type {Map<string, string[]>} */
  const byPrint = new Map();
  for (const r of rows) {
    if (r.dupOf !== null) continue;
    const ids = byPrint.get(r.fingerprint);
    if (ids) ids.push(r.id);
    else byPrint.set(r.fingerprint, [r.id]);
  }
  return [...byPrint.values()].filter((ids) => ids.length > 1);
}

/** How many a report says were refused: past REFUSED_MAX, as far as reading went. @param {{ refusedCount: number, stopped: boolean }} led */
const refusedShown = (led) => `${led.refusedCount}${led.stopped ? "+" : ""}`;

/** An error as one line. @param {unknown} e */
const oneLine = (e) => String(/** @type {Error & { stderr?: unknown }} */ (e)?.stderr || /** @type {Error} */ (e)?.message || e).trim().split("\n")[0];

/**
 * The registry a ledger is read against. No file is no registry yet: a project may have none. One that cannot be
 * read, or holds a problem, is null, with why.
 * @param {string} cwd @param {{ paths: { classes: string } }} config
 * @returns {{ reg: import("./classes.mjs").Registry | null, classError: string | null }}
 */
function registryOf(cwd, config) {
  try {
    const reg = loadClasses({ cwd, config });
    return reg.problems.length ? { reg: null, classError: reg.problems[0] } : { reg, classError: null };
  } catch (e) {
    return { reg: null, classError: oneLine(e) };
  }
}

/**
 * The ledger, read as a regular file through no link below the project, at most READ_LIMIT; nothing there is no
 * ledger yet. A path the user names may lie outside the project: then its own directory is the root, and only its
 * last component is looked at. A file that is there but cannot be read, or is refused, throws, naming it.
 * @param {{ cwd: string, config: { paths: { findings: string, classes: string } }, ledger?: string }} opts `ledger`: absolute or relative to `cwd`
 * @returns {Parsed & { path: string, there: boolean, reg: import("./classes.mjs").Registry | null, classError: string | null }}
 */
export function loadLedger({ cwd, config, ledger }) {
  const path = ledger ?? config.paths.findings;
  const file = resolve(cwd, path);
  const { reg, classError } = registryOf(cwd, config);
  const bytes = readRegular(leavesRoot(cwd, file) ? dirname(file) : cwd, file, { limit: READ_LIMIT });
  if (bytes === null) return { path, there: false, reg, classError, rows: [], refused: [], refusedCount: 0, stopped: false, same: [], total: 0 };
  if (!isUtf8(bytes)) return { path, there: true, reg, classError, rows: [], refused: [{ at: "the file", problems: ["the file is not valid UTF-8"] }], refusedCount: 1, stopped: false, same: [], total: 0 };
  return { path, there: true, reg, classError, ...parseFindings(bytes.toString("utf8"), reg) };
}

/**
 * The ledger's one line of a report: its key, values and level, for doctor.
 * @param {ReturnType<typeof loadLedger>} led
 * @returns {{ level: "ok" | "fail" | "unmeasured", key: string, vars: Record<string, string | number | string[]> }}
 */
export function ledgerLine(led) {
  const path = [led.path];
  if (!led.there) return { level: "ok", key: "findings.none", vars: { path } };
  const vars = { path, rows: led.total };
  if (led.refusedCount) {
    const first = led.refused[0];
    return { level: "fail", key: "findings.bad", vars: { ...vars, refused: refusedShown(led), first: `${first.at}: ${first.problems[0]}` } };
  }
  if (led.classError !== null) return { level: "unmeasured", key: "findings.classesUnmeasured", vars: { ...vars, error: led.classError } };
  return { level: "ok", key: "findings.ok", vars: { ...vars, same: led.same.length } };
}

/** @template T @param {() => T} read @returns {() => T} */
function once(read) {
  /** @type {{ value: T } | null} */
  let done = null;
  return () => (done ??= { value: read() }).value;
}

/**
 * What the table's age lines read from git, once. `why` when no row can have an age.
 * @param {string} cwd @param {{ hash: string | null, why: Reason | null }} start @param {NodeJS.ProcessEnv} env
 * @returns {{ why: Reason } | { history: Set<string>, before: Set<string> }}
 */
function ageFacts(cwd, start, env) {
  if (start.why !== null) return { why: start.why };
  if (start.hash === null) return { why: { key: "notNoted" } };
  const commits = (/** @type {string} */ rev) => new Set(git(["rev-list", rev], { cwd, env, walk: true }).split("\n"));
  try {
    if (git(["rev-parse", "--is-shallow-repository"], { cwd, env }) === "true") return { why: { key: "shallow" } };
    if (!holdsConfig(cwd, "HEAD", env)) return { why: { key: "noConfig" } };
    return { history: commits("HEAD"), before: commits(start.hash) };
  } catch (e) {
    return { why: { key: "gitFailed", vars: { error: oneLine(e) } } };
  }
}

/** Whether a commit's tree holds the config, as report-formats.md writes the command. @param {string} cwd @param {string} rev @param {NodeJS.ProcessEnv} env */
const holdsConfig = (cwd, rev, env) => git(["ls-tree", "--full-tree", "--name-only", rev, "--", CONFIG], { cwd, env }) !== "";

/**
 * Whether a row's `caughtBy` is a gate: `gate:<name>`, or `test:<file>` with the file tracked at HEAD; the reason
 * when git cannot say. A test HEAD does not track is no gate, as the table says, and the row goes on `untracked`:
 * a typo reads the way a task not landed yet does, so the report names both.
 * @param {Row} row @param {Facts} facts
 * @returns {boolean | Reason}
 */
function isGate(row, facts) {
  if (row.caughtBy.startsWith("gate:")) return true;
  if (!row.caughtBy.startsWith("test:")) return false;
  const read = facts.tree();
  if ("why" in read) return read.why;
  const tracked = read.files.has(row.caughtBy.slice("test:".length));
  if (!tracked) facts.untracked.push(row.id);
  return tracked;
}

/**
 * @typedef {{ column: typeof COUNT_KEYS[number] | null } | { unknown: readonly (typeof COUNT_KEYS[number])[], why: Reason }} Placed
 * @typedef {{ ages: () => ReturnType<typeof ageFacts>, tree: () => { files: Set<string> } | { why: Reason }, configIn: (hash: string) => boolean | Reason, untracked: string[] }} Facts
 */

/**
 * By age: line 3 of the table, the list under it. Which of line 1's conditions holds only changes the reason.
 * @param {Row} row @param {Facts} facts
 * @returns {Placed}
 */
function byAge(row, facts) {
  const ages = facts.ages();
  const noAge = (/** @type {Reason} */ why) => ({ unknown: AGE_COLUMNS, why });
  if ("why" in ages) return noAge(ages.why);
  if (row.bornIn === null) return noAge({ key: "noBornIn" });
  if (!ages.history.has(row.bornIn)) return noAge({ key: "offHistory" });
  const held = facts.configIn(row.bornIn);
  if (typeof held === "object") return noAge(held);
  if (!held) return { column: "preExisting" };
  if (ages.before.has(row.bornIn)) return { column: "escapedOld" };
  const gate = isGate(row, facts);
  if (typeof gate === "object") return { unknown: ["gateCaught", "escapedNew"], why: gate };
  return { column: gate ? "gateCaught" : "escapedNew" };
}

/**
 * The table of report-formats.md, "One row, one column": the first line that holds decides.
 * @param {Row} row @param {Facts} facts
 * @returns {Placed}
 */
function place(row, facts) {
  if (row.dupOf !== null || row.outcome === "refuted") return { column: null };
  if (row.source === "brief") return { column: null };
  if (row.source === "pre-existing") return byAge(row, facts);
  const gate = isGate(row, facts);
  if (typeof gate === "object") return { unknown: row.source === "previous-fix" ? ["gateCaught", "fixIntroduced"] : ["gateCaught"], why: gate };
  if (gate) return { column: "gateCaught" };
  if (row.source === "previous-fix") return { column: "fixIntroduced" };
  return { column: row.caughtBy === "review" ? "foundInReview" : null };
}

/**
 * New classes per round: rows of round 1 and later that line 1 leaves; a class counts once, in the first round that
 * names it, and one first named in round 0, by a row line 1 leaves, not at all. What resolves to an entry merges with
 * it: a linked name, a name that folds to its id, a superseded id. Three places: round 1, round 2, round 3 and later.
 * @param {Row[]} live @param {import("./classes.mjs").Registry} reg
 * @returns {number[]}
 */
function newClasses(live, reg) {
  const named = (/** @type {string} */ value) => currentClass(reg, value) ?? value;
  const before = new Set(live.filter((r) => r.round === 0).flatMap((r) => r.class.map(named)));
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const r of live) for (const c of r.class.map(named)) if (!before.has(c)) first.set(c, Math.min(first.get(c) ?? r.round, r.round));
  const places = [0, 0, 0];
  for (const round of first.values()) places[Math.min(round, places.length) - 1]++;
  return places;
}

/**
 * The most recurring class: rows line 1 leaves, by registry id, a linked name and a superseded id for their entry,
 * each row once. `top` holds every class tied at the most, by id, none when no class came twice. `names`: values no
 * entry leads to. While there is one the count is not exact: it may yet link to any entry.
 * @param {Row[]} live @param {import("./classes.mjs").Registry} reg
 * @returns {{ top: Recurring[], names: string[] }}
 */
function recurring(live, reg) {
  const { tally, names } = tallyClasses(live, reg);
  const most = Math.max(2, ...[...tally.values()].map((c) => c.times));
  const top = [...tally].filter(([, c]) => c.times === most).sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    top: top.map(([id, c]) => ({ id, times: c.times, layers: [...c.layers].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)) })),
    names: [...names],
  };
}

/**
 * Rows by the registry entry each class value leads to (currentClass), each row once per entry, with the layers that
 * caught them; `names`: values no entry leads to. The recurring class and the recent recurrence read it.
 * @param {Row[]} rows @param {import("./classes.mjs").Registry} reg
 */
function tallyClasses(rows, reg) {
  /** @type {Map<string, { times: number, layers: Map<string, number> }>} */
  const tally = new Map();
  /** @type {Set<string>} */
  const names = new Set();
  for (const row of rows) {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const value of row.class) {
      const id = currentClass(reg, value);
      if (id === null) names.add(value);
      else ids.add(id);
    }
    for (const id of ids) {
      const seen = tally.get(id) ?? { times: 0, layers: new Map() };
      seen.times++;
      seen.layers.set(row.caughtBy, (seen.layers.get(row.caughtBy) ?? 0) + 1);
      tally.set(id, seen);
    }
  }
  return { tally, names };
}

/** The cycles the recurrence ladder reads: the one counted and the two before it. */
export const LADDER_CYCLES = 3;
/** A graph node that asks for a braked file's design decision is named so: the one new node such a file may get. */
export const DECISION_SUFFIX = "-design-decision";

/** @param {Row} r */
const isFixed = (r) => r.outcome === "fixed" || r.outcome === "fixed-test";

/**
 * How often each class recurred lately, for the mechanization slot (`ennyn mechanization`): over the newest cycle the
 * rows hold and the LADDER_CYCLES - 1 before it, rows as the recurring class reads them (line 1 leaves, no brief row),
 * each row once per entry, a linked name, a folded name and a superseded id for their entry: a class split under a new
 * name counts as one once the name is linked. The window is read from the rows, as the command has no cycle of its own:
 * a row of a mistyped higher cycle moves it, and the command prints it. `cycles` is empty with no rows. `count(value)`:
 * the rows of the entry a class value leads to, 0 when none is in the window; null for a value that leads to none.
 * `entry(value)`: the id of that entry, or null. `names`: values of the window's rows no entry leads to: while there is one, a count may be short.
 * @param {Row[]} rows every row the ledger holds @param {import("./classes.mjs").Registry} reg
 * @returns {{ cycles: number[], count: (value: unknown) => number | null, entry: (value: unknown) => string | null, names: string[] }}
 */
export function recentRecurrence(rows, reg) {
  const last = rows.reduce((most, r) => Math.max(most, r.cycle), 0);
  const first = Math.max(1, last - LADDER_CYCLES + 1);
  const cycles = last ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [];
  const { tally, names } = tallyClasses(rows.filter((r) => r.cycle >= first && r.dupOf === null && r.outcome !== "refuted" && r.source !== "brief"), reg);
  const entry = (/** @type {unknown} */ value) => (typeof value === "string" ? currentClass(reg, value) : null);
  const count = (/** @type {unknown} */ value) => {
    const id = entry(value);
    return id === null ? null : (tally.get(id)?.times ?? 0);
  };
  return { cycles, count, entry, names: [...names] };
}

/**
 * The recurrence ladder of report-formats.md, per file, over cycle N and the two before it: rows line 1 leaves, with a
 * file, classes by registry id as the recurring class reads them. At the brake: one class in all three cycles,
 * previous-fix rows in cycle N and N-1, or a round of cycle N whose previous-fix rows in the file outnumber its rows
 * there fixed (`fixed`, `fixed-test`). At rung 2, when not at the brake: one class in two of the cycles, or previous-fix
 * rows in cycle N. A cycle before 1 is no cycle: with fewer than three, no class is in all three.
 * @param {Row[]} rows every row the ledger holds @param {number} cycle @param {import("./classes.mjs").Registry} reg
 * @returns {Ladder}
 */
function ladderOf(rows, cycle, reg) {
  const first = Math.max(1, cycle - LADDER_CYCLES + 1);
  const cycles = Array.from({ length: cycle - first + 1 }, (_, i) => first + i);
  const window = rows.filter((r) => r.cycle >= first && r.cycle <= cycle);
  /** @type {Map<string, Row[]>} */
  const byFile = new Map();
  for (const r of window) {
    if (r.dupOf !== null || r.outcome === "refuted" || r.file === null) continue;
    const held = byFile.get(r.file);
    if (held) held.push(r);
    else byFile.set(r.file, [r]);
  }
  /** @type {Ladder} */
  const ladder = { cycles, read: cycles.map((c) => window.filter((r) => r.cycle === c).length), brake: [], rung2: [], patches: [], unmeasured: null };
  for (const [file, held] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    /** @type {Map<string, Set<number>>} */
    const seen = new Map();
    for (const r of held) {
      for (const id of new Set(r.class.map((value) => currentClass(reg, value) ?? value))) {
        const at = seen.get(id) ?? new Set();
        at.add(r.cycle);
        seen.set(id, at);
      }
    }
    const classesIn = (/** @type {number} */ n) =>
      [...seen]
        .filter(([, at]) => at.size >= n)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, at]) => ({ id, cycles: [...at].sort((a, b) => a - b) }));
    const fixLoop = new Set(held.filter((r) => r.source === "previous-fix").map((r) => r.cycle));
    const last = held.filter((r) => r.cycle === cycle);
    const rounds = [...new Set(last.map((r) => r.round))]
      .sort((a, b) => a - b)
      .map((round) => {
        const of = last.filter((r) => r.round === round);
        return { round, previousFix: of.filter((r) => r.source === "previous-fix").length, fixed: of.filter(isFixed).length };
      })
      .filter((r) => r.previousFix > r.fixed);
    const ids = held.map((r) => r.id);
    const nodes = held.flatMap((r) => (r.outcome.startsWith("node:") ? [{ row: r.id, node: r.outcome.slice("node:".length) }] : []));
    const inAll = classesIn(LADDER_CYCLES);
    const running = fixLoop.has(cycle) && fixLoop.has(cycle - 1);
    if (inAll.length || running || rounds.length) ladder.brake.push({ file, classes: inAll, previousFix: running ? [cycle - 1, cycle] : [], rounds, ids, nodes });
    else {
      const inTwo = classesIn(2);
      if (inTwo.length || fixLoop.has(cycle)) ladder.rung2.push({ file, classes: inTwo, previousFix: fixLoop.has(cycle) ? [cycle] : [], rounds: [], ids, nodes });
    }
  }
  return ladder;
}

/**
 * Whether a text names a row id or a path as a whole word: not as part of a longer id, name or path. A sentence's
 * full stop after a path still ends it.
 * @param {string} text @param {string} word
 */
function names(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text.slice(at + word.length, at + word.length + 2);
    if (!/[\w./-]/.test(before) && !/^(?:[\w/-]|\.\w)/.test(after)) return true;
  }
  return false;
}

/**
 * The patch nodes of the files at the brake, written into `report.ladder`: a node of the graph's open or done list
 * that the graph at the cycle's start did not hold, whose id does not end in DECISION_SUFFIX, and that a row of the
 * file in the window names in its outcome (`node:<id>`), or whose title or source names a row of the file or the
 * file's path. A declined node is none: declining is what the brake asks. What cannot be read is `unmeasured`, with
 * why, never no patch: no start, a start refused, a graph that cannot be read, now or at the start, and a graph that
 * is a module (read at the start, it would run code from history). Nothing is read when no file is at the brake.
 * @param {{ cwd: string, config: any, from?: string, report: CycleReport }} opts
 */
export async function brakePatches({ cwd, config, from, report }) {
  const ladder = report.ladder;
  if (ladder === null || !ladder.brake.length) return;
  const env = { ...process.env, ...HOOK_READ_ENV };
  const start = startOf(cwd, from, env);
  if (start.hash === null) return void (ladder.unmeasured = start.why ?? { key: "notNoted" });
  const path = relative(cwd, resolve(cwd, config.paths.graph)).split(sep).join("/");
  if (extname(path) !== ".json") return void (ladder.unmeasured = { key: "graphModule", vars: { path } });
  const { exports: lists, fields } = config.graph;
  /** @type {import("../plan/mechanization.mjs").Graph} */
  let now;
  /** @type {Set<unknown>} */
  const before = new Set();
  try {
    now = await loadGraph({ cwd, config });
    if (git(["ls-tree", "--full-tree", "--name-only", start.hash, "--", path], { cwd, env }) !== "") {
      const data = JSON.parse(gitBytes(["cat-file", "blob", `${start.hash}:${path}`], { cwd, env }).toString("utf8").replace(/^﻿/, ""));
      for (const name of [lists.open, lists.done, lists.declined]) {
        const list = data?.[name];
        if (list !== undefined && !Array.isArray(list)) throw new Error(`the graph at the start: "${name}" is not a list`);
        for (const node of list ?? []) before.add(node?.[fields.id]);
      }
    }
  } catch (e) {
    return void (ladder.unmeasured = { key: "graphUnread", vars: { error: oneLine(e) } });
  }
  for (const node of [...now.open, ...now.done]) {
    const id = node[fields.id];
    if (typeof id !== "string" || before.has(id) || id.endsWith(DECISION_SUFFIX)) continue;
    const text = [node.title, node[fields.source]].filter((v) => typeof v === "string").join("\n");
    for (const { file, ids, nodes } of ladder.brake) {
      const held = ids.filter((rid) => names(text, rid));
      const pointed = nodes.filter((n) => n.node === id).map((n) => n.row);
      const rows = [...new Set([...pointed, ...held])];
      const path = names(text, file);
      if (rows.length || path) ladder.patches.push({ node: id, file, rows, path });
    }
  }
}

/** @returns {import("./convergence.mjs").Convergence} */
const unknownCounts = () => ({ foundInReview: null, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [null, null, null] });

/**
 * The cycle's start. Not given is the table's "was not noted". One that is no commit or no ancestor of HEAD reads as
 * not noted too, with bypass's sentence as the reason; a git that fails is a reason.
 * @param {string} cwd @param {string | undefined} from @param {NodeJS.ProcessEnv} env
 * @returns {{ hash: string | null, why: Reason | null }}
 */
function startOf(cwd, from, env) {
  if (from === undefined) return { hash: null, why: null };
  try {
    return { hash: cycleStart(cwd, from, env), why: null };
  } catch (e) {
    return { hash: null, why: e instanceof RangeError ? { key: "startRefused", vars: { error: e.message } } : { key: "gitFailed", vars: { error: oneLine(e) } } };
  }
}

/**
 * One cycle of a ledger, counted as report-formats.md says. A count is exact or null. A file that cannot be read, a
 * refused row, a registry that cannot be read, or no row of the cycle: every count null, and the reason. A name that
 * resolves to no entry: the rounds and the recurring class null, since it may yet merge with any class.
 * @param {{ cwd: string, config: { paths: { findings: string, classes: string } }, ledger?: string, from?: string, cycle: number }} opts
 *   `from`: the revision noted at the cycle's start; `cycle`: the cycle to count, asked for and never read from the rows
 * @returns {CycleReport}
 */
export function cycleReport({ cwd, config, ledger, from, cycle }) {
  const env = { ...process.env, ...HOOK_READ_ENV };
  const start = startOf(cwd, from, env);
  /** @type {Map<string, Unplaced>} */
  const unplaced = new Map();
  const note = (/** @type {Reason} */ { key, vars = {} }, /** @type {string} */ id = "") => {
    const at = `${key}\0${JSON.stringify(vars)}`;
    const entry = unplaced.get(at) ?? { key, vars, ids: [] };
    if (id) entry.ids.push(id);
    unplaced.set(at, entry);
  };
  // A start given and wrong is said, whether or not a row needs it.
  if (start.why !== null) note(start.why);
  /** @type {CycleReport} */
  const report = { path: ledger ?? config.paths.findings, cycle, rows: 0, counted: 0, counts: unknownCounts(), recurring: { exact: false, top: [] }, unplaced: [], refused: [], refusedCount: 0, stopped: false, same: [], higher: [], untracked: [], declined: [], refound: [], brief: [], ladder: null };
  const done = () => ({ ...report, unplaced: [...unplaced.values()] });
  /** @type {ReturnType<typeof loadLedger>} */
  let led;
  try {
    led = loadLedger({ cwd, config, ledger });
  } catch (e) {
    note({ key: "unread", vars: { error: oneLine(e) } });
    return done();
  }
  const rows = led.rows.filter((r) => r.cycle === cycle);
  report.path = led.path;
  report.rows = led.total;
  report.counted = rows.length;
  report.refused = led.refused;
  report.refusedCount = led.refusedCount;
  report.stopped = led.stopped;
  const ids = new Set(rows.map((r) => r.id));
  report.same = led.same.filter((group) => group.some((id) => ids.has(id)));
  report.higher = led.rows.filter((r) => r.cycle > cycle).map((r) => r.id);
  /** @type {Reason | null} */
  const nothing = !led.there ? { key: "noLedger", vars: { path: led.path } } : led.refusedCount ? { key: "refused", vars: { n: refusedShown(led) } } : led.reg === null ? { key: "registry", vars: { error: /** @type {string} */ (led.classError) } } : !rows.length ? { key: "noRows", vars: { path: led.path, cycle } } : null;
  if (nothing !== null || led.reg === null) {
    if (nothing !== null) note(nothing);
    return done();
  }

  /** @type {Map<string, boolean | Reason>} */
  const held = new Map();
  const configIn = (/** @type {string} */ hash) => {
    if (!held.has(hash)) {
      try {
        held.set(hash, holdsConfig(cwd, hash, env));
      } catch (e) {
        held.set(hash, { key: "gitFailed", vars: { error: oneLine(e) } });
      }
    }
    return /** @type {boolean | Reason} */ (held.get(hash));
  };
  const tree = once(() => {
    try {
      // No pathspec, so nothing here for core.precomposeUnicode to change: names come as the tree holds them.
      const files = gitBytes(["ls-tree", "-r", "-z", "--full-tree", "--name-only", "HEAD"], { cwd, env, walk: true });
      return { files: new Set(files.toString("utf8").split("\0")) };
    } catch (e) {
      return { why: /** @type {Reason} */ ({ key: "gitFailed", vars: { error: oneLine(e) } }) };
    }
  });
  /** @type {Facts} */
  const facts = { ages: once(() => ageFacts(cwd, start, env)), tree, configIn, untracked: report.untracked };
  /** @type {Record<string, number | null>} */
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  /** @type {Set<string>} */
  const lost = new Set();
  for (const row of rows) {
    const placed = place(row, facts);
    if ("unknown" in placed) {
      note(placed.why, row.id);
      for (const column of placed.unknown) lost.add(column);
    } else if (placed.column !== null) counts[placed.column] = /** @type {number} */ (counts[placed.column]) + 1;
  }
  for (const column of lost) counts[column] = null;
  const live = rows.filter((r) => r.dupOf === null && r.outcome !== "refuted");
  report.declined = live.filter((r) => r.outcome === "declined").map((r) => r.id);
  report.brief = live.filter((r) => r.source === "brief").map((r) => r.id);
  const prints = new Set(live.map((r) => foldPrint(r.fingerprint)));
  report.refound = led.rows.filter((r) => r.cycle < cycle && r.dupOf === null && r.outcome === "declined" && prints.has(foldPrint(r.fingerprint))).map((r) => r.id);
  // A brief row is said on its own line: no round, no recurring class, no ladder (its file is null) reads it.
  const code = live.filter((r) => r.source !== "brief");
  const { names } = recurring(live, led.reg);
  const { top } = recurring(code, led.reg);
  if (names.length) {
    const { list, more } = listed(names);
    note({ key: "unlinked", vars: { n: names.length, names: list, more } });
  }
  report.counts = { .../** @type {any} */ (counts), perRound: names.length ? [null, null, null] : newClasses(code, led.reg) };
  report.recurring = names.length ? { exact: false, top: [] } : { exact: true, top };
  report.ladder = ladderOf(led.rows, cycle, led.reg);
  return done();
}

/**
 * A fingerprint as `refound` compares it: NFKC, lower case, each run of white space one space, as the class registry
 * folds a name. A re-find in new words is not matched: the list is a lower bound.
 * @param {string} print
 */
const foldPrint = (print) => print.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** A list cut short, each item on its own for tShown, and what says how many it left out. @param {string[]} items */
const listed = (items) => ({ list: items.slice(0, LISTED_MAX), more: items.length > LISTED_MAX ? ` (+${items.length - LISTED_MAX})` : "" });

/** Whether every count of a report is exact and nothing was left out. @param {CycleReport} report */
export const complete = (report) => report.unplaced.length === 0;

/**
 * What `ennyn convergence` prints: the block, in the project's language, with `Proposal:` left to the writer, its last
 * line saying what was counted, then what it could not place and why, what it refused, what it warns of. Every value
 * is shown as one plain line, a name quoted when it could read as several.
 * @param {CycleReport} report @param {{ language: string }} config
 * @returns {string[]}
 */
export function reportLines(report, config) {
  const lang = config.language;
  const { top, exact } = report.recurring;
  const item = (/** @type {Recurring} */ c) => tShown("findings.recurringItem", { id: c.id, times: c.times, layers: c.layers.map(([layer, n]) => `${layer} ${n}`).join(", ") }, lang);
  const known = top.length ? top.map(item).join(" · ") : tShown("findings.recurringNone", {}, lang);
  const ids = (/** @type {string} */ key, /** @type {string[]} */ all, /** @type {Record<string, string | number>} */ vars = {}) => {
    const { list, more } = listed(all);
    return tShown(key, { ...vars, n: all.length, ids: list, more }, lang);
  };
  const out = [
    ...formatConvergence(report.counts, config).split("\n"),
    tShown("findings.recurring", { list: { shown: exact ? known : "?" } }, lang),
    tShown("findings.counted", { cycle: report.cycle, counted: report.counted, rows: `${report.rows}${report.stopped ? "+" : ""}` }, lang),
  ];
  for (const u of report.unplaced) out.push(`? ${tShown(`findings.why.${u.key}`, u.vars, lang)}${u.ids.length ? ids("findings.rows", u.ids) : ""}`);
  for (const r of report.refused) out.push(`✗ ${tShown("findings.refused", { at: r.at, problems: r.problems.join("; ") }, lang)}`);
  if (report.refusedCount > report.refused.length) out.push(`✗ ${tShown("findings.refusedMore", { n: report.refusedCount - report.refused.length }, lang)}`);
  if (report.higher.length) out.push(`! ${ids("findings.higher", report.higher, { cycle: report.cycle })}`);
  if (report.untracked.length) out.push(`! ${ids("findings.untracked", report.untracked)}`);
  if (report.declined.length) out.push(`! ${ids("findings.declined", report.declined)}`);
  if (report.refound.length) out.push(`! ${ids("findings.refound", report.refound)}`);
  if (report.brief.length) out.push(`! ${ids("findings.brief", report.brief)}`);
  for (const group of report.same.slice(0, SAME_SHOWN)) out.push(`! ${ids("findings.same", group)}`);
  if (report.same.length > SAME_SHOWN) out.push(`! ${tShown("findings.sameMore", { n: report.same.length - SAME_SHOWN }, lang)}`);
  if (report.ladder !== null) out.push(...ladderLines(report.ladder, report.cycle, lang, ids));
  return out;
}

/**
 * The ladder's lines under the block: what it read, each file at the brake and at rung 2 with why and its rows, each
 * patch node, and why patch nodes could not be looked for.
 * @param {Ladder} ladder @param {number} cycle @param {string} lang
 * @param {(key: string, all: string[], vars?: Record<string, string | number>) => string} ids
 * @returns {string[]}
 */
function ladderLines(ladder, cycle, lang, ids) {
  const read = ladder.cycles.map((c, i) => `${c} → ${ladder.read[i]}`).join(" · ");
  const out = [tShown("findings.ladder.read", { cycles: { shown: ladder.cycles.join(", ") }, read: { shown: read } }, lang)];
  const why = (/** @type {LadderFile} */ f) =>
    [
      ...f.classes.map((c) => tShown("findings.ladder.class", { id: c.id, cycles: { shown: c.cycles.join(", ") } }, lang)),
      ...(f.previousFix.length ? [tShown("findings.ladder.previousFix", { cycles: { shown: f.previousFix.join(", ") } }, lang)] : []),
      ...f.rounds.map((r) => tShown("findings.ladder.round", { round: r.round, cycle, previousFix: r.previousFix, fixed: r.fixed }, lang)),
    ].join("; ");
  for (const [key, files] of /** @type {const} */ ([["findings.ladder.brake", ladder.brake], ["findings.ladder.rung2", ladder.rung2]])) {
    for (const f of files) out.push(`${tShown(key, { file: f.file, why: { shown: why(f) } }, lang)}${ids("findings.rows", f.ids)}`);
  }
  if (!ladder.brake.length && !ladder.rung2.length) out.push(tShown("findings.ladder.none", {}, lang));
  for (const p of ladder.patches) {
    const by = [...(p.rows.length ? [ids("findings.ladder.byRows", p.rows)] : []), ...(p.path ? [tShown("findings.ladder.byPath", {}, lang)] : [])].join("; ");
    out.push(`✗ ${tShown("findings.ladder.patch", { node: p.node, file: p.file, by: { shown: by } }, lang)}`);
  }
  if (ladder.unmeasured !== null) out.push(`? ${tShown("findings.ladder.unmeasured", { why: { shown: tShown(`findings.ladder.why.${ladder.unmeasured.key}`, ladder.unmeasured.vars, lang) } }, lang)}`);
  return out;
}
