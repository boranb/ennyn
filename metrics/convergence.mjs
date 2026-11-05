/**
 * Convergence report: the two lines every cycle ends with.
 *
 *   Findings: found in review N · fix-introduced N · pre-existing N · gate-caught N · escaped past commit new N · escaped past commit old N
 *   New classes per round: round 1 → N · round 2 → N · round 3+ → N
 *
 * What each column counts is defined in skills/cycle/report-formats.md (a declined
 * row, a real defect left unfixed, counts in its column as a fixed one does); how to
 * compare a report with the old columns is in docs/evidence.md. This module reads
 * and writes the block, and decides nothing about a finding.
 *
 * Labels come from the message catalog of the project language, and every
 * project reads English labels too. The two are not ranked: handoffs keep the
 * newest cycle on top, so whichever comes first in the document is the block.
 *
 * Old reports stay readable: `real escape` is the label `foundInReview` had, read
 * and never printed. Both spellings of one column on a line are a label written
 * twice. An old report has no fifth column, so `escapedNew` and `escapedOld` read
 * null: unreported, never 0, and such a block reads like a new one whose age was
 * not measured: only its `real escape` label tells, and the result does not keep
 * it. A label starts with a letter and holds no separator or parenthesis, and no
 * count label starts another: `cut` and the cell patterns depend on it. So the
 * split by age is two labels, not a note after a count. Turkish upper case keeps
 * the dotted capital: `COMMIT'TEN` lowers to another word and reads null.
 *
 * The first line holding the findings label decides, and the parser never walks
 * past it to an older block: old data read as current is worse than null. A line
 * holds the label wherever it stands, fenced or not. Only a report line gives
 * numbers: one that starts with the label, after at most three spaces, a list or
 * heading mark and emphasis, outside fenced code. Any other line holding it reads
 * as a block of nulls, rounds too, and so does a report line that names no count
 * label: `Findings: none`, a misspelled count label, a word before the label, a
 * fenced example or template, indented code, a code span, struck text, a quote, a
 * one-line HTML comment. The real block below such a line is not read: that is
 * the price, and prose that starts with the label pays it too.
 * A multi-line HTML comment is not told from prose. A line that writes the label
 * without its colon (`Findings (estimate):`, `### Findings`) is no findings line,
 * so an older block answers: an old limit, kept.
 *
 * The per-round line is the block's own: the first line after it holding that
 * label, read by the same rule, before a heading or any line holding a findings
 * label in either language, fenced or not. A line above the block is not its own.
 * The search stops only at an ATX heading or a line holding a label: a Setext
 * heading or a thematic break does not stop it, an old limit, kept.
 *
 * A cell reads as a count only when it is exactly one: digits a number holds
 * without rounding, a sentence's "." or ";" after them allowed. Any other cell
 * is unreported, null, never zero and never a guess: `?`, a word, a number with
 * a separator in it or a note after it. An estimate is one of these: `~39` says
 * "about 39", the result has no way to say "about", so it reads null and the
 * figure stays in the report for a person. A round written in any of these ways
 * keeps its place in perRound.
 *
 * null says no line of the text holds a findings label. A block of nulls says
 * unreported: such a line reads nothing, or the text is past READ_LIMIT and was
 * not read, so nothing is known of what it holds. Text of any kind and
 * JSON-shaped values end in one of these; a hostile proxy or getter is out of
 * the promise, and an unreadable catalog throws, as it is no input.
 */

import { READ_LIMIT } from "../core/files.mjs";
import { t } from "../core/i18n.mjs";
import { outsideFenceLines } from "../setup/scan.mjs";

/**
 * @typedef {{
 *   foundInReview: number | null,
 *   fixIntroduced: number | null,
 *   preExisting: number | null,
 *   gateCaught: number | null,
 *   escapedNew: number | null,
 *   escapedOld: number | null,
 *   perRound: (number | null)[],
 * }} Convergence
 */

const COUNT_KEYS = /** @type {const} */ (["foundInReview", "fixIntroduced", "preExisting", "gateCaught", "escapedNew", "escapedOld"]);
/** The catalog key of the label a column had before: read in old reports, never printed. */
const OLD_LABEL = /** @type {Partial<Record<typeof COUNT_KEYS[number], string>>} */ ({ foundInReview: "realEscape" });

/** The highest round read or printed: a round's number sets the length of perRound, so a report cannot size it. */
export const MAX_ROUNDS = 100;
/** The first round the last place can hold with those after it ("round 3+"). */
const AGGREGATE_FROM = 3;

/** What stands before a report line's label: four spaces are code, and a quote mark, a code span or struck text is none of this. */
const LINE_START = /^ {0,3}(?:[-*+] |\d+[.)] |#{1,6} )?[*_]*(?=\p{L})/u;
const HEADING = /^ {0,3}#{1,6}(?: |$)/;

/** The two catalogs (core/config.mjs allows these languages); anything else reads as English. @param {unknown} config */
const languageOf = (config) => (/** @type {{ language?: unknown } | null | undefined} */ (config)?.language === "tr" ? "tr" : "en");

/** @returns {Convergence} */
const unreported = () => ({ foundInReview: null, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });

/** @param {string} key @param {string} lang */
const label = (key, lang) => t(`convergence.${key}`, {}, lang);

/** Lower case in the catalog's language: Turkish "İ" / "I" lower to "i" / "ı", not "i̇" / "i". */
const lower = (/** @type {string} */ s, /** @type {string} */ lang) => s.toLocaleLowerCase(lang === "tr" ? "tr" : "en");

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One language's labels as lines and cells are matched. A line's label reports in its first group what stands right
 * before it: nothing on a line that starts with it. A count cell gives its value; a word that only starts like a
 * label ("eskisi") matches nothing. A round cell gives its number, its "+" and, after an arrow, its value.
 * @param {string} lang
 */
function reading(lang) {
  const word = (/** @type {string} */ key) => escapeRe(lower(label(key, lang), lang));
  const line = (/** @type {string} */ key) => new RegExp(`(^|[^\\p{L}])${word(key)}\\s*:`, "u");
  const spellings = (/** @type {typeof COUNT_KEYS[number]} */ key) => [key, OLD_LABEL[key] ?? []].flat().map(word).join("|");
  return {
    lang,
    findings: line("findings"),
    perRound: line("perRound"),
    counts: COUNT_KEYS.map((key) => ({ key, cell: new RegExp(`^(?:${spellings(key)})(?: ?[:=] ?| |$)(.*)`) })),
    round: new RegExp(`^${word("round")} (\\d+)(\\+?)(?: ?(?:→|->|:|=) ?(.*))?`),
  };
}

/** @param {string | undefined} c */
const isDigit = (c) => /\d/.test(c ?? "");

/**
 * The line as labels are matched: lowered in the catalog's language (so an upper-case "BULGULAR:" matches), without
 * markdown emphasis. Marks between two digits are no emphasis: taken out, they would make "5*2" read 52.
 * @param {string} line
 * @param {string} lang
 */
const plain = (line, lang) => lower(line.replace(/[*_`]+/g, (marks, at, all) => (isDigit(all[at - 1]) && isDigit(all[at + marks.length]) ? marks : "")), lang);

/** @param {string} line @param {RegExp} pattern @param {string} lang */
const holds = (line, pattern, lang) => pattern.test(plain(line, lang));

/**
 * Cut what follows a label into cells. A cell starts with a label, so a separator before a digit is inside a number
 * ("1,000" is not a count of 1). A note in parentheses stays in its cell whatever it mentions, nested too; one left
 * open runs to the end of the line.
 * @param {string} text
 * @returns {string[]}
 */
function cut(text) {
  const cells = [];
  let depth = 0;
  let start = 0;
  for (const { 0: mark, index } of text.matchAll(/[()]|[·,](?!\s*\d)/g)) {
    if (mark === "(") depth++;
    else if (mark === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      cells.push(text.slice(start, index));
      start = index + 1;
    }
  }
  cells.push(text.slice(start));
  return cells.map((cell) => cell.replace(/\s+/g, " ").trim());
}

/**
 * The cells of a report line starting with the label; none for any other line.
 * @param {string} line
 * @param {RegExp} pattern
 * @param {string} lang
 * @returns {string[]}
 */
function cellsOf(line, pattern, lang) {
  const start = LINE_START.exec(line);
  const text = start ? plain(line.slice(start[0].length), lang) : "";
  const m = pattern.exec(text);
  return m?.[1] === "" ? cut(text.slice(m[0].length)) : [];
}

/**
 * The count a cell's value holds exactly, or null: past the largest exact integer, digits read as a neighbour. A "."
 * or ";" ends a sentence; a comma has already ended the cell.
 * @param {string} value
 * @returns {number | null}
 */
function exactCount(value) {
  const n = /^\d+[.;]*$/.test(value) ? parseInt(value, 10) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The block a findings line gives. A label written twice is not one reading.
 * @param {string[]} cells
 * @param {ReturnType<typeof reading>["counts"]} counts
 * @returns {Convergence}
 */
function readCounts(cells, counts) {
  const out = unreported();
  for (const { key, cell } of counts) {
    const written = cells.flatMap((text) => cell.exec(text)?.[1] ?? []);
    if (written.length === 1) out[key] = exactCount(written[0]);
  }
  return out;
}

/**
 * perRound of a per-round line. A written round keeps its place whatever its cell holds. A round written twice is not
 * one reading, and only the last round from AGGREGATE_FROM up holds those after it: the place of one round cannot say
 * "round 2 and later", or hold a round another cell also holds.
 * @param {string[]} cells
 * @param {RegExp} head a cell's "<round label> N", its "+" and its value
 * @returns {(number | null)[]}
 */
function readRounds(cells, head) {
  /** @type {Map<number, number | null>} */
  const read = new Map();
  /** @type {number[]} */
  const aggregates = [];
  for (const cell of cells) {
    const m = head.exec(cell);
    if (!m || Number(m[1]) > MAX_ROUNDS) continue;
    const round = Number(m[1]);
    read.set(round, read.has(round) ? null : exactCount(m[3]));
    if (m[2]) aggregates.push(round);
  }
  const last = Math.max(0, ...read.keys());
  for (const round of aggregates) if (round < AGGREGATE_FROM || round < last) read.set(round, null);
  // A round that is not written is unmeasured, not zero (same rule as the counts).
  return Array.from({ length: last }, (_, i) => read.get(i + 1) ?? null);
}

/**
 * Parse the convergence lines of a cycle report or handoff; the rules are in the module's header.
 * @param {unknown} text
 * @param {unknown} config `{ language }`; a language with no catalog reads as English
 * @returns {Convergence | null} null when no line holds a findings label, or text is not a string
 */
export function parseConvergence(text, config) {
  if (typeof text !== "string") return null;
  if (text.length > READ_LIMIT) return unreported();
  const normal = text.replace(/\r\n?/g, "\n");
  const lines = normal.replace(/^\uFEFF/, "").split("\n");
  const prose = new Set(outsideFenceLines(normal));
  const readings = [...new Set([languageOf(config), "en"])].map(reading);
  const findingsIn = (/** @type {string} */ line) => readings.find((r) => holds(line, r.findings, r.lang));
  const at = lines.findIndex(findingsIn);
  const r = findingsIn(lines[at] ?? "");
  if (!r) return null;
  const cells = prose.has(at) ? cellsOf(lines[at], r.findings, r.lang) : [];
  if (!cells.some((text) => r.counts.some(({ cell }) => cell.test(text)))) return unreported();
  const out = readCounts(cells, r.counts);
  for (let i = at + 1; i < lines.length; i++) {
    if (findingsIn(lines[i])) break;
    if (holds(lines[i], r.perRound, r.lang)) {
      if (prose.has(i)) out.perRound = readRounds(cellsOf(lines[i], r.perRound, r.lang), r.round);
      break;
    }
    if (prose.has(i) && HEADING.test(lines[i])) break;
  }
  return out;
}

/**
 * Inverse of parseConvergence. Anything that is not a count is written as "?" (parses back to null). The last round
 * label gets "+" when it aggregates round 3 and later. Past MAX_ROUNDS, the last place printed says the rest is
 * unmeasured: "round 100+ → ?".
 * @param {unknown} counts a Convergence; anything else prints as unmeasured
 * @param {unknown} config `{ language }`; a language with no catalog prints in English
 * @returns {string}
 */
export function formatConvergence(counts, config) {
  const lang = languageOf(config);
  const given = /** @type {Partial<Record<typeof COUNT_KEYS[number], unknown>> & { perRound?: unknown } | null | undefined} */ (counts);
  const show = (/** @type {unknown} */ n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? String(n) : "?");
  const lines = [`${label("findings", lang)}: ${COUNT_KEYS.map((k) => `${label(k, lang)} ${show(given?.[k])}`).join(" · ")}`];
  const written = Array.isArray(given?.perRound) ? given.perRound : [];
  const rounds = written.length > MAX_ROUNDS ? [...written.slice(0, MAX_ROUNDS - 1), null] : written;
  if (rounds.length) {
    const parts = Array.from(rounds, (n, i) => {
      const plus = i === rounds.length - 1 && i + 1 >= AGGREGATE_FROM ? "+" : "";
      return `${label("round", lang)} ${i + 1}${plus} → ${show(n)}`;
    });
    lines.push(`${label("perRound", lang)}: ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}
