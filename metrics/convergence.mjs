/**
 * Convergence report: the two lines every cycle ends with.
 *
 *   Findings: real escape N · fix-introduced N · pre-existing N · gate-caught N
 *   New classes per round: round 1 → N · round 2 → N · round 3+ → N
 *
 * Labels come from the message catalog of the project language, so a Turkish
 * project writes and parses Turkish labels. English labels are accepted as a
 * fallback. A count that is absent or not a number parses as null: an
 * unreported count is not zero.
 */

import { t } from "../core/i18n.mjs";

/**
 * @typedef {{
 *   realEscape: number | null,
 *   fixIntroduced: number | null,
 *   preExisting: number | null,
 *   gateCaught: number | null,
 *   perRound: (number | null)[],
 * }} Convergence
 */

const COUNT_KEYS = /** @type {const} */ (["realEscape", "fixIntroduced", "preExisting", "gateCaught"]);

/** @param {string} lang */
function labels(lang) {
  return {
    findings: t("convergence.findings", {}, lang),
    perRound: t("convergence.perRound", {}, lang),
    round: t("convergence.round", {}, lang),
    counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, t(`convergence.${k}`, {}, lang)])),
  };
}

/** Lower case in the catalog's language: Turkish "İ" / "I" lower to "i" / "ı", not "i̇" / "i". */
const lower = (/** @type {string} */ s, /** @type {string} */ lang) => s.toLocaleLowerCase(lang === "tr" ? "tr" : "en");

/** @param {string} s @param {string} lang */
const norm = (s, lang) => lower(s.replace(/\s+/g, " ").trim(), lang);

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text after "<label>:" on the first line carrying it, with markdown emphasis
 * stripped and lowered in the catalog's language (so an upper-case "BULGULAR:"
 * matches); the line index is returned so a later search can start there.
 * @param {string[]} lines
 * @param {string} label
 * @param {string} lang
 * @param {number} from
 * @returns {{ index: number, rest: string } | null}
 */
function findLabeled(lines, label, lang, from = 0) {
  const re = new RegExp(`(?:^|[^\\p{L}])${escapeRe(lower(label, lang))}\\s*:`, "u");
  for (let i = from; i < lines.length; i++) {
    const line = lower(lines[i].replace(/[*_`]/g, ""), lang);
    const m = re.exec(line);
    if (m) return { index: i, rest: line.slice(m.index + m[0].length) };
  }
  return null;
}

/** @param {string} rest */
const segments = (rest) =>
  rest
    .split(/[·,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @param {string[]} lines
 * @param {ReturnType<typeof labels>} L
 * @param {string} lang
 * @returns {Convergence | null}
 */
function parseWith(lines, L, lang) {
  const found = findLabeled(lines, L.findings, lang);
  if (!found) return null;
  /** @type {Convergence} */
  const out = { realEscape: null, fixIntroduced: null, preExisting: null, gateCaught: null, perRound: [] };
  for (const seg of segments(found.rest)) {
    const m = /^(.*?)\s*[:=]?\s*(\S+)$/u.exec(seg);
    if (!m) continue;
    const key = COUNT_KEYS.find((k) => norm(L.counts[k], lang) === norm(m[1], lang));
    // A sentence-ending "." or ";" after the last count is punctuation, not part of the number.
    const n = m[2].replace(/[.;,]+$/, "");
    if (key && /^\d+$/.test(n)) out[key] = Number(n);
  }
  const roundLine = findLabeled(lines, L.perRound, lang, found.index) ?? findLabeled(lines, L.perRound, lang);
  if (roundLine) {
    // `?` is an explicit "unmeasured" round (formatConvergence writes it for null); it keeps its place.
    const re = new RegExp(`^${escapeRe(lower(L.round, lang))}\\s+(\\d+)\\+?\\s*(?:→|->|:|=)\\s*(\\d+|\\?)[.;,]*$`, "u");
    /** @type {(number | null)[]} */
    const rounds = [];
    for (const seg of segments(roundLine.rest)) {
      const m = re.exec(seg);
      if (m && Number(m[1]) >= 1) rounds[Number(m[1]) - 1] = m[2] === "?" ? null : Number(m[2]);
    }
    // A round that is not written is unmeasured, not zero (same rule as the four counts).
    out.perRound = Array.from(rounds, (n) => n ?? null);
  }
  return out;
}

/**
 * Parse the convergence lines of a cycle report or handoff. The first findings
 * line wins (handoffs keep the newest cycle on top); the per-round line is the
 * first one at or after it.
 * @param {string} text
 * @param {{ language: string }} config
 * @returns {Convergence | null} null when no findings line exists
 */
export function parseConvergence(text, config) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const langs = config.language === "en" ? ["en"] : [config.language, "en"];
  for (const lang of langs) {
    const parsed = parseWith(lines, labels(lang), lang);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Inverse of parseConvergence. A null count is written as "?" (parses back to null).
 * The last round label gets "+" when it aggregates round 3 and later.
 * @param {Convergence} counts
 * @param {{ language: string }} config
 * @returns {string}
 */
export function formatConvergence(counts, config) {
  const L = labels(config.language);
  const show = (/** @type {number | null | undefined} */ n) => (typeof n === "number" ? String(n) : "?");
  const lines = [`${L.findings}: ${COUNT_KEYS.map((k) => `${L.counts[k]} ${show(counts[k])}`).join(" · ")}`];
  const rounds = counts.perRound ?? [];
  if (rounds.length) {
    const parts = rounds.map((n, i) => {
      const plus = i === rounds.length - 1 && i >= 2 ? "+" : "";
      return `${L.round} ${i + 1}${plus} → ${show(n)}`;
    });
    lines.push(`${L.perRound}: ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}
