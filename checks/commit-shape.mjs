/**
 * Commit message shape: a short subject, a short body, and the structured lines
 * the loop measures (review rounds, impact summary). Detail belongs in one
 * place (the work-graph node or the lesson catalog), not in three.
 *
 * Measured origin: commit messages grew from ~950 to ~1,700 characters per task
 * while production code per task stayed flat; the extra prose bought nothing.
 */

import { matchAny } from "../core/glob.mjs";
import { parseTrailers } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";

/** @param {string} s */
const len = (s) => [...s].length;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text git will store, so the check measures what lands in history. git's
 * cleanup depends on how the message was given: with `-m` / `-F` (git sets
 * GIT_EDITOR=":" for the hook) `#` lines and a `git commit -v` scissors line are
 * kept ("whitespace"); with the editor they are dropped and the scissors line
 * ends the message ("strip"). A kept line is counted like any other, otherwise
 * prose could hide behind a `#`. Both modes drop trailing spaces and repeated
 * and edge blank lines. The comment marker is git's `core.commentChar` / `core.commentString`
 * (default `#`): with `;` git drops `;` lines and keeps `#` ones.
 * @param {string} message
 * @param {"strip" | "whitespace"} cleanup
 * @param {string} [comment] the comment marker
 */
export function storedMessage(message, cleanup, comment = "#") {
  let text = message.replace(/\r\n/g, "\n");
  // The scissors line (`git commit -v`) ends the message only when git strips; with -m / -F it is stored.
  const scissors = cleanup === "strip" ? text.search(new RegExp(`^${escapeRe(comment)} -+ >8 -+$`, "m")) : -1;
  if (scissors !== -1) text = text.slice(0, scissors);
  /** @type {string[]} */
  const out = [];
  for (const raw of text.split("\n")) {
    if (cleanup === "strip" && raw.startsWith(comment)) continue;
    const line = raw.replace(/\s+$/, "");
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * The reason written with the bypass marker: "" when the bracket never closes,
 * null without a marker. The one parser for it; metrics/bypass.mjs counts the
 * uses in history with the same rule.
 * @param {string} text the stored message
 * @param {string} marker `commitMsg.allowMarker`
 * @returns {string | null}
 */
export function allowMarkerReason(text, marker) {
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const close = text.indexOf("]", at);
  return close === -1 ? "" : text.slice(at + marker.length, close).trim();
}

/**
 * Subjects the check never looks at (`commitMsg.skipSubjects`: merges, reverts).
 * Shared with metrics/bypass.mjs: a revert of a bypass commit is not a bypass.
 * @param {string} subject
 * @param {any} config
 */
export function skippedSubject(subject, config) {
  return config.commitMsg.skipSubjects.some((/** @type {string} */ re) => new RegExp(re).test(subject));
}

/**
 * @param {string} message raw commit message (as given to a commit-msg hook)
 * @param {{ config: any, stagedPaths?: string[], cleanup?: "strip" | "whitespace", comment?: string, foldTarget?: { message: string, paths: string[] } | null, ownSubject?: boolean }} opts
 *   `cleanup` is git's mode for this commit: "whitespace" when the message came from `-m` / `-F`.
 *   `comment` is git's comment marker (`core.commentChar`), "#" by default.
 *   `foldTarget`: for an amend! / squash! commit, the commit it folds into (its message and paths).
 *   `ownSubject`: false when the subject is not this commit's to change (it is checked elsewhere).
 * @returns {{ ok: boolean, errors: string[], skipped?: string }}
 */
export function checkCommitShape(message, { config, stagedPaths = [], cleanup = "strip", comment = "#", foldTarget = null, ownSubject = true }) {
  const lang = config.language;
  const cm = config.commitMsg;
  const rv = config.review;
  const text = storedMessage(message, cleanup, comment);
  const lines = text.split("\n");
  const subject = lines[0] ?? "";

  // An empty message: git aborts the commit itself and says why.
  if (text === "") return { ok: true, errors: [], skipped: "empty" };
  // amend! / squash! (git commit --fixup=amend: / --squash): autosquash folds them in without running
  // this hook, so the message they leave in history is checked now. An amend!'s body replaces the target's
  // message, so the target's paths still need what they needed (an Impact line). A squash!'s body is added
  // to the target's message: the target's subject and lines are already history and not this commit's to
  // fix; its own staged paths count, and the target's Impact line covers them.
  // A bare fixup! disappears and is skipped (skipSubjects).
  const fold = /^(amend|squash)! (.*)$/.exec(subject);
  if (fold) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    if (!rest) return { ok: true, errors: [], skipped: "subject" };
    const paths = [...stagedPaths, ...(foldTarget?.paths ?? [])];
    if (fold[1] === "amend") return checkCommitShape(rest, { config, stagedPaths: paths, cleanup: "whitespace", comment });
    const base = foldTarget ? storedMessage(foldTarget.message, "whitespace") : fold[2];
    return checkCommitShape(`${base}\n\n${rest}`, { config, stagedPaths, cleanup: "whitespace", comment, ownSubject: false });
  }
  if (skippedSubject(subject, config)) {
    return { ok: true, errors: [], skipped: "subject" };
  }

  const reason = allowMarkerReason(text, cm.allowMarker);
  if (reason !== null) {
    if (reason.length < 8) return { ok: false, errors: [t("shape.allowNoReason", { marker: cm.allowMarker }, lang)] };
    return { ok: true, errors: [], skipped: "marker" };
  }

  const errors = [];
  if (ownSubject && len(subject) > cm.subjectMax) errors.push(t("shape.subjectTooLong", { len: len(subject), max: cm.subjectMax }, lang));
  // The project's chosen types (/ennyn:init); the rework rate finds repairs by the fix type.
  if (ownSubject && cm.types.length) {
    const typeRe = new RegExp(`^(${cm.types.map(escapeRe).join("|")})(\\([^)]*\\))?!?:\\s+\\S`);
    if (!typeRe.test(subject)) errors.push(t("shape.typeMissing", { types: cm.types.join(", "), example: cm.fixType }, lang));
  }

  // Structured lines (rounds, impact, root cause) may sit in the body or in the
  // trailer paragraph; only prose is counted, and the trailer paragraph is never prose.
  const bodyLines = lines.slice(1);
  let proseCandidates = bodyLines;
  if (parseTrailers(text).size) {
    const lastBlank = bodyLines.map((l) => l.trim() === "").lastIndexOf(true);
    proseCandidates = lastBlank === -1 ? [] : bodyLines.slice(0, lastBlank);
  }

  const structuredPrefixes = [...cm.structuredLines, rv.roundsLine, rv.thirdRoundLine, rv.impactLine];
  const isStructured = (/** @type {string} */ l) => structuredPrefixes.some((p) => l.trimStart().startsWith(p));
  const prose = proseCandidates.filter((l) => l.trim() !== "" && !isStructured(l));
  // Terse commits: the subject says what changed; measurements stay as structured lines; detail lives in the graph.
  if (cm.style === "terse" && prose.length) errors.push(t("shape.terseBody", { n: prose.length }, lang));
  else if (prose.length > cm.bodyMaxLines) errors.push(t("shape.bodyTooManyLines", { n: prose.length, max: cm.bodyMaxLines }, lang));
  const proseChars = prose.reduce((n, l) => n + len(l), 0);
  if (proseChars > cm.bodyMaxChars) errors.push(t("shape.bodyTooLong", { n: proseChars, max: cm.bodyMaxChars }, lang));

  for (const l of bodyLines) {
    if (isStructured(l) && len(l) > cm.structuredLineMax) {
      const prefix = structuredPrefixes.find((p) => l.trimStart().startsWith(p));
      errors.push(t("shape.structuredTooLong", { prefix: String(prefix), n: len(l), max: cm.structuredLineMax }, lang));
    }
  }

  const roundsLine = bodyLines.find((l) => l.trimStart().startsWith(rv.roundsLine));
  if (roundsLine) {
    const raw = roundsLine.trimStart().slice(rv.roundsLine.length).trim();
    if (!/^\d+$/.test(raw)) errors.push(t("shape.roundsNotInteger", { line: rv.roundsLine, value: raw }, lang));
    else if (Number(raw) > rv.maxRounds) {
      const third = bodyLines.find((l) => l.trimStart().startsWith(rv.thirdRoundLine));
      const reason = third ? third.trimStart().slice(rv.thirdRoundLine.length).trim() : "";
      if (reason.length < 8) {
        errors.push(t("shape.thirdRoundMissing", { rounds: raw, max: rv.maxRounds, line: rv.thirdRoundLine }, lang));
      }
    }
  }

  if (rv.impactRequiredGlobs.length) {
    const hits = stagedPaths.filter((p) => matchAny(p, rv.impactRequiredGlobs) && !matchAny(p, rv.impactIgnoreGlobs));
    if (hits.length && !bodyLines.some((l) => l.trimStart().startsWith(rv.impactLine))) {
      errors.push(t("shape.impactMissing", { line: rv.impactLine, paths: hits.slice(0, 3).join(", ") }, lang));
    }
  }

  return { ok: errors.length === 0, errors };
}
