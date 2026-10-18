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
 *   perRound: number[],
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

/** @param {string} s */
const norm = (s) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text after "<label>:" on the first line carrying it, with markdown emphasis
 * stripped; the line index is returned so a later search can start there.
 * @param {string[]} lines
 * @param {string} label
 * @param {number} from
 * @returns {{ index: number, rest: string } | null}
 */
function findLabeled(lines, label, from = 0) {
  const re = new RegExp(`(?:^|[^\\p{L}])${escapeRe(label)}\\s*:`, "iu");
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].replace(/[*_`]/g, "");
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
 * @returns {Convergence | null}
 */
function parseWith(lines, L) {
  const found = findLabeled(lines, L.findings);
  if (!found) return null;
  /** @type {Convergence} */
  const out = { realEscape: null, fixIntroduced: null, preExisting: null, gateCaught: null, perRound: [] };
  for (const seg of segments(found.rest)) {
    const m = /^(.*?)\s*[:=]?\s*(\S+)$/u.exec(seg);
    if (!m) continue;
    const key = COUNT_KEYS.find((k) => norm(L.counts[k]) === norm(m[1]));
    if (key && /^\d+$/.test(m[2])) out[key] = Number(m[2]);
  }
  const roundLine = findLabeled(lines, L.perRound, found.index) ?? findLabeled(lines, L.perRound);
  if (roundLine) {
    const re = new RegExp(`^${escapeRe(L.round)}\\s+(\\d+)\\+?\\s*(?:→|->|:|=)\\s*(\\d+)$`, "iu");
    /** @type {number[]} */
    const rounds = [];
    for (const seg of segments(roundLine.rest)) {
      const m = re.exec(seg);
      if (m && Number(m[1]) >= 1) rounds[Number(m[1]) - 1] = Number(m[2]);
    }
    out.perRound = Array.from(rounds, (n) => n ?? 0);
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
    const parsed = parseWith(lines, labels(lang));
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
      return `${L.round} ${i + 1}${plus} → ${n}`;
    });
    lines.push(`${L.perRound}: ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}
