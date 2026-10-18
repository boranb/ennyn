/**
 * Conversation style rules, `styles/<style>.<lang>.md`. "normal" has none.
 * They shape the conversation only; files and commits keep their own rules
 * (commit brevity is `commitMsg.style`). Both published projects this follows
 * leave commits, code and documents untouched, and their measured gain over a
 * plain "be concise" was small (see DESIGN.md).
 */

import { readFileSync } from "node:fs";

/**
 * @param {string} style a value of `conversation.style`
 * @param {string} lang "en" | "tr"
 * @returns {string | null}
 */
export function styleRules(style, lang) {
  if (style === "normal") return null;
  return readFileSync(new URL(`../styles/${style}.${lang}.md`, import.meta.url), "utf8");
}
