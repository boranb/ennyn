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
 * a row that holds one is held to its bound), of its type, in its closed set, no other field; `class` through
 * metrics/classes.mjs; `id` unique; `dupOf` names a row, and a chain ends; a `pre-existing` row names a file, and a
 * line needs one. A row that fails is refused and every count reads `?`, whichever cycle it says: it may have said
 * its cycle wrongly. Never a smaller number. So does a class registry that cannot be read or holds a problem: a class
 * cannot be checked, a linked name not resolved. A file that is no UTF-8 is refused whole, as the registry is: two
 * names that differ only in such bytes would read as one. All this runs when doctor or the command runs, not on a
 * commit.
 *
 * A row whose `dupOf` chain ends at a refuted row and is not refuted itself is refused: table line 1 would drop
 * both, and the defect from every column. One of the two is wrong, and only a person can say which.
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
 * What the table needs from git it asks once, and only when a row needs it. Git failing, a tree a partial clone
 * does not hold or a start not noted reads `?` in the columns that row could fall in, with the reason, and the
 * others stay exact. Objects as HOOK_READ_ENV reads them: nothing is fetched.
 */

import { isUtf8 } from "node:buffer";
import { dirname, resolve } from "node:path";
import { leavesRoot, READ_LIMIT, readRegular } from "../core/files.mjs";
import { git, gitBytes, HOOK_READ_ENV } from "../core/git.mjs";
import { tShown } from "../core/i18n.mjs";
import { cycleStart } from "./bypass.mjs";
import { HASH, classProblems, currentClass, isId, isObject, loadClasses, plain, quoted } from "./classes.mjs";
import { formatConvergence } from "./convergence.mjs";

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
export const SOURCES = ["first-write", "previous-fix", "pre-existing"];
/** What finds a defect without being a gate; report-formats.md: any other value is `test:<file>` or `gate:<name>`. */
export const NOT_GATES = ["review", "measurement", "author-reading"];
export const OUTCOMES = ["fixed-test", "fixed", "refuted", "open"];

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
const OPTIONAL = { trigger: text(NOTE_MAX), escapePoint: text(NOTE_MAX) };
/** Every field of a row, in the order ledger-row.md lists them. */
export const FIELDS = ["cycle", "task", "round", "id", "severity", "class", "source", "caughtBy", "dupOf", "fingerprint", "trigger", "escapePoint", "outcome", "commit", "bornIn", "file", "line"];

/**
 * @typedef {{ cycle: number, task: string, round: number, id: string, severity: string, class: string[], source: string, caughtBy: string, dupOf: string | null, fingerprint: string, trigger?: string, escapePoint?: string, outcome: string, commit: string | null, bornIn: string | null, file: string, line: number | null }} Row
 * @typedef {{ raw: Record<string, unknown>, at: string, problems: string[] }} Entry a row as it is read, valid or not
 * @typedef {{ at: string, problems: string[] }} Refused
 * @typedef {{ rows: Row[], refused: Refused[], refusedCount: number, stopped: boolean, same: string[][], total: number }} Parsed
 *   `rows`: those that passed. `refused`: the first KEPT_MAX, `refusedCount` all of them. `stopped`: reading stopped
 *   at REFUSED_MAX, so `refusedCount` and `total` are how far it went. `same`: ids that share a fingerprint with no
 *   dupOf. `total`: every line read that is not blank.
 * @typedef {{ key: string, vars?: Record<string, string | number | string[]> }} Reason a catalog key below findings.why, as a report gives it
 * @typedef {{ key: string, vars: Record<string, string | number | string[]>, ids: string[] }} Unplaced what could not be placed, and why
 * @typedef {{ id: string, times: number, layers: [string, number][] }} Recurring
 * @typedef {{ path: string, cycle: number, rows: number, counted: number, counts: import("./convergence.mjs").Convergence, recurring: { exact: boolean, top: Recurring[] }, unplaced: Unplaced[], refused: Refused[], refusedCount: number, stopped: boolean, same: string[][], higher: string[], untracked: string[] }} CycleReport
 *   `rows`: the ledger's, `counted`: the cycle's. `top` is empty unless `exact`. `same`: the ledger's groups that hold
 *   a counted row. `higher`:
 *   ids of rows of a cycle above the one asked for. `untracked`: ids of rows whose test HEAD does not track.
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
  if (raw.file === null) {
    // With no file there is no line to blame, so a null bornIn would have no repair.
    if (raw.source === "pre-existing") problems.push("a pre-existing row names a file: the one the fix belongs in");
    if (typeof raw.line === "number") problems.push("a line needs a file");
  }
  return problems;
}

/**
 * Every `dupOf`: it names a row, and its chain, read to its end, ends at one that is not refuted unless this row is.
 * One pass, each row walked once.
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
    else if (end.raw.outcome === "refuted" && entry.raw.outcome !== "refuted") entry.problems.push("dupOf ends at a refuted row while this row is not refuted: the defect would count nowhere, so one of the two is wrong");
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
 * By age: line 2 of the table, the list under it. Which of line 1's conditions holds only changes the reason.
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
  /** @type {Map<string, { times: number, layers: Map<string, number> }>} */
  const tally = new Map();
  /** @type {Set<string>} */
  const names = new Set();
  for (const row of live) {
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
  const most = Math.max(2, ...[...tally.values()].map((c) => c.times));
  const top = [...tally].filter(([, c]) => c.times === most).sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    top: top.map(([id, c]) => ({ id, times: c.times, layers: [...c.layers].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)) })),
    names: [...names],
  };
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
  const report = { path: ledger ?? config.paths.findings, cycle, rows: 0, counted: 0, counts: unknownCounts(), recurring: { exact: false, top: [] }, unplaced: [], refused: [], refusedCount: 0, stopped: false, same: [], higher: [], untracked: [] };
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
  const { top, names } = recurring(live, led.reg);
  if (names.length) {
    const { list, more } = listed(names);
    note({ key: "unlinked", vars: { n: names.length, names: list, more } });
  }
  report.counts = { .../** @type {any} */ (counts), perRound: names.length ? [null, null, null] : newClasses(live, led.reg) };
  report.recurring = names.length ? { exact: false, top: [] } : { exact: true, top };
  return done();
}

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
  for (const group of report.same.slice(0, SAME_SHOWN)) out.push(`! ${ids("findings.same", group)}`);
  if (report.same.length > SAME_SHOWN) out.push(`! ${tShown("findings.sameMore", { n: report.same.length - SAME_SHOWN }, lang)}`);
  return out;
}
