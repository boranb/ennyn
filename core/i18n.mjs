/**
 * Message catalogs. Output language is a project setting (`language`);
 * a key missing from the chosen catalog falls back to English.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
/** @type {Record<string, Record<string, string>>} */
const catalogs = {};

/** @param {string} lang */
export function catalog(lang) {
  if (!catalogs[lang]) catalogs[lang] = JSON.parse(readFileSync(join(here, "..", "i18n", `${lang}.json`), "utf8"));
  return catalogs[lang];
}

/** @typedef {Record<string, string | number | string[] | { shown: string }>} Vars a list (string[]) is names, joined ", "; `{ shown }` is text already shown */

/** @param {string} key @param {string} lang */
function template(key, lang) {
  const text = catalog(lang)[key] ?? catalog("en")[key];
  if (text === undefined) throw new Error(`missing message key "${key}"`);
  return text;
}

/**
 * A message with its values in place. A value carries no character UNSHOWN names: each is written as a `\u`
 * escape where it stands, a line feed too, so no value starts a line of its own (an error quoting a config's
 * pattern, a path); `{ shown }` is put as its caller wrote it. tShown quotes as well, for a report on what the
 * project holds.
 * @param {string} key
 * @param {Vars} [vars]
 * @param {string} [lang]
 */
export function t(key, vars = {}, lang = "en") {
  return template(key, lang).replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) return `{${name}}`;
    const v = vars[name];
    // `{ shown }` is text its caller already escaped, lines of its own included (a list of problems).
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v.shown;
    return (Array.isArray(v) ? v.join(", ") : String(v)).replace(UNSHOWN_ALL, escaped);
  });
}

/**
 * What a report line cannot hold as it is: controls, format characters (direction marks among them), line and
 * paragraph separators. Not ZWNJ and ZWJ (U+200C, U+200D): Persian and Indic names need them, and they neither
 * reorder text nor break a line. One character; `(?:…)+` for a run.
 */
export const UNSHOWN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** One character as JSON's `\u` escapes (a pair of UTF-16 halves for an astral one). @param {string} c */
const escaped = (c) => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");

/** Every character UNSHOWN names. */
const UNSHOWN_ALL = new RegExp(UNSHOWN.source, "gu");
/** The same, a line feed aside. */
const UNSHOWN_BUT_LF = new RegExp(`(?!\\n)${UNSHOWN.source}`, "gu");
/**
 * A comma a list could be read as parted at: one with a space, a mark (combining, a variation selector) or a
 * joiner after it, or a comma of another script, or a low quotation mark that looks like one.
 */
const LIST_COMMA = /,[\s\p{M}\u200c\u200d]|[\u055d\u060c\u07f8\u1363\u1802\u1808\u201a\u2e41\u2e4c\u3001\ua4fe\ua60d\ua6f5\ufe10\ufe11\ufe50\ufe51\uff0c\uff64]/u;
/** A value longer than this is shown by its start and its end. */
export const SHOWN_MAX = 1000;

/** @param {string} s */
const quoted = (s) => JSON.stringify(s).replace(UNSHOWN_ALL, escaped);

/**
 * A long text's start and end, cut between letters, never inside a pair of UTF-16 halves.
 * @param {string} s @param {number} max
 */
export function ends(s, max) {
  let head = s.slice(0, Math.ceil(max * 0.6));
  let tail = s.slice(s.length - Math.floor(max * 0.3));
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
  return { head, tail, cut: s.length - head.length - tail.length };
}

/**
 * A text kept to `max` UTF-16 units: as it is, or its first `keep` units and "…", never cut inside a pair of halves.
 * @param {string} s @param {number} max @param {number} [keep]
 */
export function clipped(s, max, keep = max - 3) {
  if (s.length <= max) return s;
  const head = s.slice(0, keep);
  return (/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head) + "…";
}

/**
 * A value as one line of a report: as it is, or quoted and escaped (JSON's escapes; \u for every other
 * character UNSHOWN names) when it holds a character a line cannot show. A name is quoted also when it holds
 * `"` or `\`, so `a<LF>b.js` and a file named `"a\nb.js"` print apart, and, in a list, when it holds a comma
 * the list could be read as parted at (", ", a comma and any other space, a comma of another script); so is
 * a value set inside a message's own quotes when it holds `"` or `\`, which would end them or seem to. On
 * Windows, where `\` parts a path and no name holds `"`, a `\` alone quotes nothing: a path stays as a user
 * copies it. A value longer than `max` is shown by its start and end, two quoted strings with `…` between.
 * @param {string | number} value
 * @param {{ name?: boolean, inQuotes?: boolean, platform?: string, max?: number }} [opts]
 * @returns {{ text: string, quoted: boolean }}
 */
export function shown(value, { name = false, inQuotes = false, platform = process.platform, max = SHOWN_MAX } = {}) {
  // A byte of a name that is not UTF-8 is a lone surrogate (nameText); it reads as U+FFFD, as the terminal would show it.
  const v = /** @type {any} */ (String(value)).toWellFormed();
  if (v.length > max) {
    const { head, tail } = ends(v, max);
    return { text: `${quoted(head)}…${quoted(tail)}`, quoted: true };
  }
  const special = platform === "win32" ? /"/ : /["\\]/;
  if (!UNSHOWN.test(v) && !((name || inQuotes) && special.test(v)) && !(name && LIST_COMMA.test(v))) return { text: v, quoted: false };
  return { text: quoted(v), quoted: true };
}

/**
 * Every character UNSHOWN names written as a `\u` escape where it stands, nothing quoted: the last guard of a
 * line the program writes. `keepLines` leaves a line feed as it is, for text of several lines it put together.
 * @param {string} text
 * @param {{ keepLines?: boolean }} [opts]
 */
export function unshownEscaped(text, { keepLines = false } = {}) {
  return text.replace(keepLines ? UNSHOWN_BUT_LF : UNSHOWN_ALL, escaped);
}

/**
 * A name as one JSON string in printable ASCII: every other character, "<" and ">" too, as \uXXXX (a pair of
 * UTF-16 halves as two escapes). Nothing inside the value can look like its end: a list of look-alike quotes
 * and brackets (U+201D, U+FF02, U+2039, U+FF1C…) would always miss one.
 * @param {string} name
 */
export function asciiJson(name) {
  return JSON.stringify(name).replace(/[^\x20-\x7e]|[<>]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** What UNSHOWN names that JSON.stringify writes as it is: it escapes the C0 controls itself, and a raw one in its output is its own line break. */
const JSON_UNSHOWN = new RegExp(`(?![\\u0000-\\u001f])${UNSHOWN.source}`, "gu");

/** What JSON.stringify prints for a value under `key`: its toJSON's result when it has one. @param {unknown} v @param {string} key */
const asJson = (v, key) => (v !== null && typeof v === "object" && typeof (/** @type {any} */ (v).toJSON) === "function" ? /** @type {any} */ (v).toJSON(key) : v);

/**
 * Whether JSON.stringify would meet an object again inside itself: a walk of what it prints (own enumerable keys, each
 * value through toJSON, asked with its key at each reach). An object on the open path counts by itself, so a toJSON
 * that makes a new object at each reach still closes a cycle through the object it belongs to; what was printed and
 * walked to its end is not walked again, so the walk is linear in objects and links (a toJSON that makes a new object
 * at each reach costs that object's own keys once per reach).
 * @param {unknown} value
 */
function holdsCycle(value) {
  const open = new Set();
  const done = new Set();
  /** @type {[object, string[], number, unknown][]} what is printed, its keys, the next key, the object it came from */
  const frames = [];
  /** @param {unknown} raw @param {string} key @returns {boolean} a cycle */
  const enter = (raw, key) => {
    const v = asJson(raw, key);
    if (v === null || typeof v !== "object") return false;
    if (open.has(raw)) return true;
    if (done.has(v)) return false;
    open.add(raw);
    frames.push([v, Object.keys(v), 0, raw]);
    return false;
  };
  enter(value, "");
  while (frames.length) {
    const f = frames[frames.length - 1];
    if (f[2] === f[1].length) {
      open.delete(f[3]);
      done.add(f[0]);
      frames.pop();
      continue;
    }
    const key = f[1][f[2]++];
    if (enter(/** @type {any} */ (f[0])[key], key)) return true;
  }
  return false;
}

/**
 * The replacer for a value with a cycle: each object printed once, every later reach of it (a link back, or a second
 * link to it from anywhere) as `{ "$ref": <n> }`, n the object's number among the output's objects and arrays in the
 * order their `{` or `[` opens in the text, the top value 0, each `$ref` object counted too. An object with a toJSON is
 * the object itself, and what its toJSON gave counts too: a later reach of either is a reference to that first print,
 * even where its toJSON would give another value under another key. JSON.stringify calls the replacer just before it
 * prints each value, in that order, so the count is the replacer's own.
 */
function references() {
  /** @type {Map<unknown, number>} */
  const printed = new Map();
  let opened = 0;
  /** @this {any} @param {string} key @param {unknown} value */
  return function (key, value) {
    if (value === null || typeof value !== "object") return value;
    const raw = this[key];
    const at = printed.get(raw) ?? printed.get(value);
    if (at !== undefined) return (opened++, { $ref: at });
    printed.set(raw, opened).set(value, opened);
    opened++;
    return value;
  };
}

/**
 * A command's --json output: JSON.stringify's, with every character UNSHOWN names that it leaves as it is (DEL,
 * C1 controls, direction marks and other format characters, line and paragraph separators) written as `\u`
 * escapes. It parses to the same value; a terminal or a reader sees what a name or a line holds. A value with no
 * cycle is JSON.stringify's text, an object two places share printed in each; one with a cycle, which JSON.stringify
 * alone refuses or follows without end, prints each object once (references) and on one line, as an indent grows
 * with the depth, so its size is linear in its objects and links.
 * @param {unknown} value
 * @returns {string}
 */
export function jsonShown(value) {
  const text = holdsCycle(value) ? JSON.stringify(value, references()) : JSON.stringify(value, null, 2);
  return String(text).replace(JSON_UNSHOWN, escaped);
}

/**
 * t() for a line of a report on what the project holds (doctor, the graph's problems): every value is shown
 * (each name of a list on its own), and a quoted value takes the place of the quotes a message puts around it.
 * @param {string} key
 * @param {Vars} [vars]
 * @param {string} [lang]
 */
export function tShown(key, vars = {}, lang = "en") {
  /** @param {string} name @param {boolean} inQuotes */
  const one = (name, inQuotes) => {
    const v = vars[name];
    if (Array.isArray(v)) return { text: v.map((x) => shown(x, { name: true }).text).join(", "), quoted: false };
    if (v !== null && typeof v === "object") return { text: v.shown, quoted: false };
    return shown(v, { inQuotes });
  };
  return template(key, lang).replace(/"\{(\w+)\}"|\{(\w+)\}/g, (all, inQuotes, bare) => {
    const name = inQuotes ?? bare;
    if (!(name in vars)) return all;
    const s = one(name, inQuotes !== undefined);
    return inQuotes && !s.quoted ? `"${s.text}"` : s.text;
  });
}
