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

/** @typedef {Record<string, string | number | string[]>} Vars a list (string[]) is names, joined ", " */

/** @param {string} key @param {string} lang */
function template(key, lang) {
  const text = catalog(lang)[key] ?? catalog("en")[key];
  if (text === undefined) throw new Error(`missing message key "${key}"`);
  return text;
}

/**
 * @param {string} key
 * @param {Vars} [vars]
 * @param {string} [lang]
 */
export function t(key, vars = {}, lang = "en") {
  return template(key, lang).replace(/\{(\w+)\}/g, (_, name) => (name in vars ? (Array.isArray(vars[name]) ? vars[name].join(", ") : String(vars[name])) : `{${name}}`));
}

/**
 * What a report line cannot hold as it is: controls, format characters (direction marks among them), line and
 * paragraph separators. Not ZWNJ and ZWJ (U+200C, U+200D): Persian and Indic names need them, and they neither
 * reorder text nor break a line. One character; `(?:…)+` for a run.
 */
export const UNSHOWN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A value as one line of a report: as it is, or quoted and escaped (JSON's escapes; \u for every other
 * character UNSHOWN names) when it holds a character a line cannot show. A name is quoted also when it holds
 * `"` or `\`, so `a<LF>b.js` and a file named `"a\nb.js"` print apart, and, in a list, when it holds the ", "
 * that joins the list. On Windows, where `\` parts a path and no name holds `"`, a `\` alone quotes nothing:
 * a path stays as a user copies it.
 * @param {string | number} value
 * @param {{ name?: boolean, platform?: string }} [opts]
 * @returns {{ text: string, quoted: boolean }}
 */
export function shown(value, { name = false, platform = process.platform } = {}) {
  const v = String(value);
  const special = platform === "win32" ? /"|, / : /["\\]|, /;
  if (!UNSHOWN.test(v) && !(name && special.test(v))) return { text: v, quoted: false };
  const text = JSON.stringify(v).replace(new RegExp(UNSHOWN.source, "gu"), (c) => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
  return { text, quoted: true };
}

/**
 * t() for a line of a report on what the project holds (doctor, the graph's problems): every value is shown
 * (each name of a list on its own), and a quoted value takes the place of the quotes a message puts around it.
 * @param {string} key
 * @param {Vars} [vars]
 * @param {string} [lang]
 */
export function tShown(key, vars = {}, lang = "en") {
  /** @param {string} name */
  const one = (name) => {
    const v = vars[name];
    if (!Array.isArray(v)) return shown(v);
    return { text: v.map((x) => shown(x, { name: true }).text).join(", "), quoted: false };
  };
  return template(key, lang).replace(/"\{(\w+)\}"|\{(\w+)\}/g, (all, inQuotes, bare) => {
    const name = inQuotes ?? bare;
    if (!(name in vars)) return all;
    const s = one(name);
    return inQuotes && !s.quoted ? `"${s.text}"` : s.text;
  });
}
