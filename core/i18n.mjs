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

/**
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @param {string} [lang]
 */
export function t(key, vars = {}, lang = "en") {
  const text = catalog(lang)[key] ?? catalog("en")[key];
  if (text === undefined) throw new Error(`missing message key "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}
