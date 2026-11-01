/**
 * Commit message shape: a short subject, a short body, and the structured lines
 * the loop measures (review rounds, impact summary). Detail belongs in one
 * place (the work-graph node or the lesson catalog), not in three.
 *
 * Measured origin: commit messages grew from ~950 to ~1,700 characters per task
 * while production code per task stayed flat; the extra prose bought nothing.
 */

import { isUtf8 } from "node:buffer";
import { matchAny } from "../core/glob.mjs";
import { markLength, wideForms } from "../core/encoding.mjs";
import { gitMaybe, parseTrailers } from "../core/git.mjs";
import { shown, t } from "../core/i18n.mjs";
import { masked, secretHits, secretsOff, textSecrets } from "./secrets.mjs";

/** @param {string} s */
const len = (s) => [...s].length;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** git's scissors line after the comment marker and a space (wt-status.c): exactly this, then a line end. */
const CUT_LINE = "------------------------ >8 ------------------------\n";

/** @param {string} message @param {string} comment */
function scissorsAt(message, comment) {
  const line = `${comment} ${CUT_LINE}`;
  if (message.startsWith(line)) return 0;
  const at = message.indexOf(`\n${line}`);
  return at === -1 ? -1 : at + 1;
}

/**
 * Whether git wrote one of the scissors lines into the editor's template: under it only comment lines,
 * then the diff of -v (or a submodule summary), or nothing (the scissors mode, where it replaces the hint;
 * an empty commit). A line typed by hand, above git's or below it, has the user's text under it.
 * @param {string} message @param {string} comment
 */
function gitCutLine(message, comment) {
  const line = `${comment} ${CUT_LINE}`;
  for (let at = scissorsAt(message, comment); at !== -1; ) {
    const next = message.slice(at + line.length).replace(/\n$/, "").split("\n").find((l) => !l.startsWith(comment));
    if (next === undefined || /^(diff --git |Submodule )/.test(next)) return true;
    const i = message.indexOf(`\n${line}`, at);
    at = i === -1 ? -1 : i + 1;
  }
  return false;
}

/**
 * Whether the editor showed git's status template: it has lines that are the comment marker alone, in
 * every language. Without it (--no-status, commit.status false) git wrote neither hint nor -v diff. A
 * commit.template file can hold such a line too, so this is asked only when commit.status is on.
 * @param {string} message @param {string} comment
 */
function templateShown(message, comment) {
  return message.split("\n").includes(comment);
}

/**
 * Whether git cuts the message at its first scissors line (builtin/commit.c): with `--verbose` (`-v`,
 * `commit.verbose`) in any mode, `-m` too, and in the "scissors" mode when the editor ran. A line typed by
 * hand is otherwise kept. A hook cannot see the command line, but an edited message with the status
 * template shows whether -v was in effect: git's own scissors line (gitCutLine). This outranks
 * commit.verbose, which `--no-verbose` overrides. Without the editor or the template (`status`:
 * commit.status), commit.verbose decides.
 * @param {string} message
 * @param {{ cleanup: "strip" | "whitespace" | "verbatim" | "scissors", editor: boolean, verbose?: boolean, comment?: string, status?: boolean }} how
 */
export function gitCuts(message, { cleanup, editor, verbose = false, comment = "#", status = true }) {
  if (scissorsAt(message, comment) === -1) return false;
  if (editor && cleanup === "scissors") return true;
  if (editor && status && gitCutLine(message, comment)) return true;
  if (editor && status && templateShown(message, comment)) return false;
  return verbose;
}

/**
 * The text git will store, so the check measures what lands in history. git's
 * cleanup depends on how the message was given: with `-m` / `-F` (git sets
 * GIT_EDITOR=":" for the hook) `#` lines are kept ("whitespace"); with the
 * editor they are dropped ("strip"). A kept line is counted like any other,
 * otherwise prose could hide behind a `#`. Both modes drop trailing spaces and repeated
 * and edge blank lines. The comment marker is git's `core.commentChar` / `core.commentString`
 * (default `#`): with `;` git drops `;` lines and keeps `#` ones.
 * `commit.cleanup` can set the mode outright: "verbatim" stores the message as given; "scissors" is
 * "whitespace". Where git cuts at the scissors line is `cut` (gitCuts).
 * @param {string} message
 * @param {"strip" | "whitespace" | "verbatim" | "scissors"} cleanup
 * @param {string} [comment] the comment marker
 * @param {boolean} [cut] git cuts at its scissors line; by default as gitCuts decides, taking strip and scissors for the editor
 */
export function storedMessage(message, cleanup, comment = "#", cut = gitCuts(message, { cleanup, editor: cleanup === "strip" || cleanup === "scissors", comment })) {
  const at = cut ? scissorsAt(message, comment) : -1;
  const kept = at === -1 ? message : message.slice(0, at);
  if (cleanup === "verbatim") return kept;
  const text = kept.replace(/\r\n/g, "\n");
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
 * git's comment marker for commit messages: the last of core.commentChar and core.commentString set,
 * else "#". "auto" (any case): git's own rule (builtin/commit.c, adjust_comment_line_char), applied to the
 * message before the editor: "#" unless the message holds one; otherwise the first of "#;@!$%^&|:" that
 * starts no line (a line starts after "\n" or "\r"). When the editor ran, the last line git wrote says
 * which it chose: the hint "Please enter the commit message" (English) or a template line that is the
 * marker alone (any language); only with commit.status on (`status`). A line typed by hand says nothing.
 * @param {string} set the configured value ("" when unset) @param {string} message @param {boolean} editor
 * @param {boolean} [status]
 */
export function commentMarker(set, message, editor, status = true) {
  if (set.toLowerCase() !== "auto") return set || "#";
  if (editor && status) {
    const own = [...message.matchAll(/^(\S+) Please enter the commit message|^([#;@!$%^&|:])$/gm)].pop();
    if (own) return own[1] ?? own[2];
  }
  if (!message.includes("#")) return "#";
  const starts = new Set(message.split(/[\r\n]/).map((l) => l.charAt(0)));
  return [..."#;@!$%^&|:"].find((c) => !starts.has(c)) ?? "#";
}

/**
 * How git will clean the message a commit-msg hook was given, read from what the hook can see: the
 * repository's config (with `git -c` settings, which reach the hook in its environment), GIT_EDITOR
 * (git sets it to ":" for `-m` / `-F`) and the template in an edited message.
 * cleanup: commit.cleanup when it is set ("scissors" cuts only when the editor ran: gitCuts); otherwise
 * git strips when the editor ran and only trims whitespace for -m / -F.
 * Options on the command line never reach a hook: `--cleanup=`, and `-v` / `--no-verbose` with -m / -F
 * or without the status template (--no-status, commit.status false), are not measured.
 * test/git-oracle.test.mjs compares the result with what real git stores.
 * @param {{ cwd: string, message: string, env: NodeJS.ProcessEnv }} opts
 * @returns {{ cleanup: "strip" | "whitespace" | "verbatim" | "scissors", comment: string, cut: boolean }}
 */
export function hookCommitMode({ cwd, message, env }) {
  // Two reads (a hook runs on every commit), in config order: the last value wins, as with --get, and
  // core.commentChar and core.commentString set the same marker. The second one reads the typed keys.
  let set = "";
  let marker = "";
  // Exit 1: none of the keys is set. Any other failure throws: unread is not unset.
  for (const entry of (gitMaybe(["config", "-z", "--get-regexp", "^(commit\\.cleanup|core\\.comment(char|string))$"], { cwd, env, absent: [1] }) ?? "").split("\0")) {
    const nl = entry.indexOf("\n");
    const [key, value] = nl === -1 ? [entry, ""] : [entry.slice(0, nl), entry.slice(nl + 1)];
    if (key === "commit.cleanup") set = value;
    else if (key) marker = value;
  }
  /** @type {Map<string, string>} */
  const typed = new Map();
  for (const entry of (gitMaybe(["config", "-z", "--type=bool-or-int", "--get-regexp", "^commit\\.(verbose|status)$"], { cwd, env, absent: [1] }) ?? "").split("\0")) {
    const nl = entry.indexOf("\n");
    if (nl !== -1) typed.set(entry.slice(0, nl), entry.slice(nl + 1));
  }
  const verbose = typed.get("commit.verbose") ?? "";
  // bool-or-int prints "false" for false, no, off, and "0" for 0.
  const off = typed.get("commit.status");
  const status = !(off === "false" || (off !== undefined && Number(off) === 0));
  const editor = env.GIT_EDITOR !== ":";
  const cleanup = set === "strip" || set === "whitespace" || set === "verbatim" || set === "scissors" ? set : editor ? "strip" : "whitespace";
  const comment = commentMarker(marker, message, editor, status);
  const cut = gitCuts(message, { cleanup, editor, verbose: verbose === "true" || Number(verbose) > 0, comment, status });
  return { cleanup, comment, cut };
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
 * The message's shape, and the lines it adds that review.forbidden bans or that hold a secret (security.secrets).
 * Those two are about content, not the message: they hold for every commit the hook sees, whatever its subject
 * or an empty message, and the bypass marker, which loosens the shape, does not loosen them.
 * @param {string} message raw commit message (as given to a commit-msg hook)
 * @param {Parameters<typeof shapeOf>[1] & { addedLines?: Map<string, AddedLine[]>, secretLines?: Map<string, AddedLine[]>, keyFiles?: Map<string, Buffer>, secretsExcept?: string[], exempt?: string[], wideUnread?: Map<string, string> }} opts
 *   `addedLines`: the lines the commit adds, per staged path (stagedAddedLines); `exempt`: paths no rule reads
 *   (the config, which holds every rule's text); `secretLines`: the lines the secret scan reads (the config's
 *   too: a secret there is still one), and by its keys the names the commit adds; `keyFiles`: staged files
 *   read whole for a private key around their added lines (keyCandidates); `secretsExcept`: the except list
 *   as the commit's own config holds it (default: the config's). The message git will store is scanned too.
 * @returns {{ ok: boolean, errors: string[], warnings?: string[], skipped?: string }}
 */
export function checkCommitShape(message, opts) {
  const res = withSecrets(message, shapeOf(message, opts), opts);
  // Also for a message the shape check reads as empty: with --allow-empty-message git commits it anyway.
  if (!opts.addedLines) return res;
  const rules = opts.config.review.forbidden;
  const lang = opts.config.language;
  const wideUnread = opts.wideUnread ?? new Map();
  let scan;
  try {
    scan = forbiddenScan(opts.addedLines, rules, opts.exempt, wideUnread);
  } catch (e) {
    // The scan's own failure, not the message's: the hook weighs it as a gate's (gateFailed).
    throw Object.assign(/** @type {Error} */ (e), { gate: "review.forbidden" });
  }
  const { hits, unread } = scan;
  const banned = forbiddenErrors(hits, rules, lang);
  // What could not be compared is said, never counted as clean; the commit is not refused for it. Text files
  // are named; binary files are counted, so a text file is not lost among them.
  const unsure = rules.flatMap((/** @type {ForbiddenRule} */ rule, /** @type {number} */ i) => {
    const of = (/** @type {string} */ kind) => unread.filter((u) => u.rule === i && u.kind === kind).map((u) => u.path);
    const where = (/** @type {string[]} */ paths) => paths.slice(0, 3).map(pathShown).join(", ") + (paths.length > 3 ? t("shape.cochangeMore", { n: paths.length - 3 }, lang) : "");
    const vars = { rule: i + 1, text: rule.text };
    const [text, binary, wide] = [of("text"), of("binary"), of("wide")];
    return [
      ...(text.length ? [t("shape.forbiddenUnread", { ...vars, where: where(text) }, lang)] : []),
      ...(binary.length ? [t("shape.forbiddenBinaryUnread", { ...vars, n: binary.length }, lang)] : []),
      ...(wide.length ? [t("shape.forbiddenWideUnread", { ...vars, where: where(wide), reason: String(wideUnread.get(wide[0])) }, lang)] : []),
    ];
  });
  const out = unsure.length ? { ...res, warnings: [...(res.warnings ?? []), ...unsure] } : res;
  return banned.length ? { ...out, ok: false, errors: [...banned, ...res.errors] } : out;
}

/** A staged path as a line of a report shows it: any secret in it cut, a control character escaped. @param {string} path */
const pathShown = (path) => shown(masked(path), { name: true }).text;

/** A name as a message lists it: always quoted, a control character escaped, a secret cut. @param {string} path */
export const nameShown = (path) => {
  const s = shown(masked(path), { name: true });
  return s.quoted ? s.text : JSON.stringify(s.text);
};

/**
 * The result with one error for the secrets the commit adds (secretErrors, the message included).
 * @param {string} message
 * @param {{ ok: boolean, errors: string[], warnings?: string[], skipped?: string }} res
 * @param {Parameters<typeof secretErrors>[0]} opts
 */
function withSecrets(message, res, opts) {
  const errors = secretErrors({ ...opts, message });
  return errors.length ? { ...res, ok: false, errors: [...errors, ...res.errors] } : res;
}

/**
 * The message as the secret scan reads it: as given, a superset of what any cleanup stores (the hook cannot see
 * `--cleanup=verbatim` on the command line), cut where git cuts it, at its scissors line; with the editor's
 * status template, its file lines (a tab after the comment marker) are git's own list of names, read as names.
 * @param {string} message @param {{ comment?: string, cut?: boolean }} how
 */
function scannedMessage(message, { comment = "#", cut = false }) {
  const at = cut ? scissorsAt(message, comment) : -1;
  const text = at === -1 ? message : message.slice(0, at);
  return templateShown(text, comment) ? text.split("\n").map((l) => (l.startsWith(`${comment}\t`) ? "" : l)).join("\n") : text;
}

/**
 * One error for the secrets the commit adds: in its files (`hits`, or found in `secretLines`), the names it adds
 * (`names`, by default `secretLines`' paths) and, given `message`, the message (scannedMessage): the first three
 * places, each with its kind and never the secret; in a merge, how many the other side brings. None when except
 * holds a catch-all (secretsOff). Apart from the message's own check, so the hook can stand by what the files
 * bring when reading how git cleans the message fails.
 * @param {{ config: any, hits?: import("./secrets.mjs").SecretHit[], names?: string[], secretLines?: Map<string, AddedLine[]>, keyFiles?: Map<string, Buffer>, secretsExcept?: string[], message?: string, comment?: string, cut?: boolean }} opts
 * @returns {string[]}
 */
export function secretErrors(opts) {
  const { config } = opts;
  const except = opts.secretsExcept ?? config.security.secrets.except;
  if (secretsOff(except)) return [];
  const lang = config.language;
  /** @type {{ where: string, from?: string }[]} */
  const places = [];
  for (const h of [...(opts.hits ?? []), ...(opts.secretLines ? secretHits(opts.secretLines, { except, files: opts.keyFiles }) : [])]) places.push({ where: `${pathShown(h.path)}:${h.line} (${h.shown})`, ...(h.from ? { from: h.from } : {}) });
  for (const path of opts.names ?? [...(opts.secretLines?.keys() ?? [])].filter((p) => !matchAny(p, except))) {
    for (const s of textSecrets(path)) places.push({ where: t("shape.secretName", { path: pathShown(path), shown: s.shown }, lang) });
  }
  if (opts.message !== undefined) for (const s of textSecrets(scannedMessage(opts.message, opts))) places.push({ where: t("shape.secretMessage", { line: s.line, shown: s.shown }, lang) });
  if (!places.length) return [];
  const where = places.slice(0, 3).map((p) => p.where).join(", ") + (places.length > 3 ? t("shape.cochangeMore", { n: places.length - 3 }, lang) : "");
  const merged = places.filter((p) => p.from);
  const brought = merged.length ? t("shape.forbiddenMerged", { n: merged.length, commit: String(merged[0].from).slice(0, 10) }, lang) : "";
  return [t("shape.secret", { where }, lang) + brought];
}

/**
 * @param {string} message raw commit message (as given to a commit-msg hook)
 * @param {{ config: any, stagedPaths?: string[], cleanup?: "strip" | "whitespace" | "verbatim" | "scissors", cut?: boolean, comment?: string, foldTarget?: { message: string, paths: string[] } | null, ownSubject?: boolean, alsoChanged?: string[] }} opts
 *   `cleanup` is git's mode for this commit: "whitespace" when the message came from `-m` / `-F`.
 *   `cut`: git cuts at its scissors line (gitCuts); by default as storedMessage decides.
 *   `comment` is git's comment marker (`core.commentChar`), "#" by default.
 *   `foldTarget`: for an amend! / squash! commit, the commit it folds into (its message and paths).
 *   `ownSubject`: false when the subject is not this commit's to change (it is checked elsewhere).
 *   `alsoChanged`: paths already in history that the fold adds to; a document among them counts as changed.
 * @returns {{ ok: boolean, errors: string[], warnings?: string[], skipped?: string }} `warnings`: staged paths whose
 *   documents (review.cochange) are not staged; they never fail the check
 */
function shapeOf(message, { config, stagedPaths = [], cleanup = "strip", cut, comment = "#", foldTarget = null, ownSubject = true, alsoChanged = [] }) {
  const lang = config.language;
  const cm = config.commitMsg;
  const rv = config.review;
  const text = storedMessage(message, cleanup, comment, cut);
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
    const paths = [...new Set([...stagedPaths, ...(foldTarget?.paths ?? [])])];
    if (fold[1] === "amend") return shapeOf(rest, { config, stagedPaths: paths, cleanup: "whitespace", comment });
    const base = foldTarget ? storedMessage(foldTarget.message, "whitespace") : fold[2];
    return shapeOf(`${base}\n\n${rest}`, { config, stagedPaths, cleanup: "whitespace", comment, ownSubject: false, alsoChanged: foldTarget?.paths ?? [] });
  }
  if (skippedSubject(subject, config)) {
    return { ok: true, errors: [], skipped: "subject" };
  }

  // The bypass marker loosens the shape, not the documents: they are still named.
  const warnings = cochangeWarnings(stagedPaths, rv.cochange, lang, alsoChanged);
  const reason = allowMarkerReason(text, cm.allowMarker);
  if (reason !== null) {
    if (reason.length < 8) return { ok: false, errors: [t("shape.allowNoReason", { marker: cm.allowMarker }, lang)], warnings };
    return { ok: true, errors: [], warnings, skipped: "marker" };
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
    // The line carries the summary: a letter or a digit on it, so a mark or a character that shows as nothing is no record,
    // the Hangul fillers (letters to Unicode) among them. A replacement character is bytes a legacy encoding wrote: content.
    if (hits.length && !bodyLines.some((l) => l.trimStart().startsWith(rv.impactLine) && /(?!\p{DI})[\p{L}\p{N}\uFFFD]/u.test(l.trimStart().slice(rv.impactLine.length)))) {
      errors.push(t("shape.impactMissing", { line: rv.impactLine, paths: hits.slice(0, 3).map(pathShown).join(", ") }, lang));
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Documents that did not move with their code: for each review.cochange rule, the staged paths it names
 * when none of its documents is staged. A path that is one of the rule's documents is a document.
 * @param {string[]} staged
 * @param {{ paths: string[], docs: string[], note?: string }[]} rules
 * @param {string} lang
 * @param {string[]} [alsoChanged] paths a fold adds to (a squash! target's): documents there count, code does not warn
 * @returns {string[]}
 */
export function cochangeWarnings(staged, rules, lang, alsoChanged = []) {
  /** @type {string[]} */
  const out = [];
  for (const rule of rules) {
    if ([...staged, ...alsoChanged].some((p) => matchAny(p, rule.docs))) continue;
    const changed = staged.filter((p) => matchAny(p, rule.paths));
    if (!changed.length) continue;
    const paths = changed.slice(0, 3).map(pathShown).join(", ") + (changed.length > 3 ? t("shape.cochangeMore", { n: changed.length - 3 }, lang) : "");
    out.push(t("shape.cochange", { paths, docs: rule.docs.join(", "), note: rule.note ? ` (${rule.note})` : "" }, lang));
  }
  return out;
}

/** @typedef {import("../core/git.mjs").AddedLine} AddedLine a line a commit adds, numbered as in the new file */
/** @typedef {{ text: string, paths: string[], except?: string[], note?: string }} ForbiddenRule */

/**
 * Added lines that hold a review.forbidden rule's text, as written (case and spaces too), in a path its
 * `paths` name and its `except` do not.
 * @param {Map<string, AddedLine[]>} added
 * @param {ForbiddenRule[]} rules
 * @param {string[]} [exempt] paths no rule reads
 * @returns {{ rule: number, path: string, line: number, from?: string }[]} `rule`: index in rules; `from`: the merge
 *   parent that already holds the line
 */
export function forbiddenHits(added, rules, exempt = []) {
  return forbiddenScan(added, rules, exempt).hits;
}

/** @param {string} s */
const composed = (s) => (/[^\x00-\x7f]/.test(s) ? s.normalize("NFC") : s);

/**
 * forbiddenHits, and the paths a rule could not be compared in. A line holds the text when it holds it as
 * written, or composed (NFC) holds the composed text: "ü" written as "u" and a combining mark is the same
 * text, and a match as written stays one. git's own lines are always read, and a file decoded from UTF-16 or
 * UTF-32 adds its decoded lines (`decoded`, stagedAddedLines); decoding never turns a check of git's lines
 * off. In a file with NULs git's lines are also searched for the text's UTF-16 and UTF-32 bytes: either byte
 * order, or in a decoded file only the decoded one (an ANSI line can put the rest at the other alignment).
 * `unread`, for a path the text was not found in: `text`, a file with no NUL that has a line that is not UTF-8
 * (an 8-bit encoding), where a text with letters outside ASCII has no single spelling; `binary`, the same in a
 * file with NULs (binary, UTF-16 or UTF-32: a NUL is UTF-8, so 8-bit text beside one counts; a byte order mark
 * at the start of the file is no 8-bit text); `wide`, a path
 * in `wideUnread`, not decoded, under a text the search of git's lines cannot find: one with letters outside
 * ASCII (their UTF-16 may hold no NUL, or a newline byte where git splits the line; an ASCII text's UTF-16
 * holds a NUL for every letter and a newline byte only for a newline, which no line holds).
 * @param {Map<string, AddedLine[]>} added
 * @param {ForbiddenRule[]} rules
 * @param {string[]} [exempt]
 * @param {Map<string, string>} [wideUnread] paths that were not decoded (too large, or not read), with why
 * @returns {{ hits: { rule: number, path: string, line: number, from?: string }[], unread: { rule: number, path: string, kind: "text" | "binary" | "wide" }[] }}
 */
export function forbiddenScan(added, rules, exempt = [], wideUnread = new Map()) {
  /** @type {{ rule: number, path: string, line: number, from?: string }[]} */
  const hits = [];
  /** @type {{ rule: number, path: string, kind: "text" | "binary" | "wide" }[]} */
  const unread = [];
  rules.forEach((rule, i) => {
    const text = composed(rule.text);
    const ascii = !/[^\x00-\x7f]/.test(rule.text);
    for (const [path, lines] of added) {
      if (exempt.includes(path) || !matchAny(path, rule.paths) || matchAny(path, rule.except ?? [])) continue;
      const nul = lines.some((l) => l.raw?.includes(0));
      const forms = nul ? wideForms(rule.text, lines.find((l) => l.decoded)?.decoded) : [];
      let hit = false;
      let eightBit = false;
      for (const l of lines) {
        const bytes = nul && !l.decoded ? (l.raw ?? Buffer.from(l.text, "utf8")) : null;
        if (l.text.includes(rule.text) || composed(l.text).includes(text) || (bytes && forms.some((f) => bytes.includes(f)))) {
          hits.push({ rule: i, path, line: l.line, ...(l.from ? { from: l.from } : {}) });
          hit = true;
        } else if (!ascii && l.raw && !isUtf8(l.line === 1 ? l.raw.subarray(markLength(l.raw)) : l.raw)) eightBit = true;
      }
      if (hit) continue;
      if (eightBit) unread.push({ rule: i, path, kind: nul ? "binary" : "text" });
      if (wideUnread.has(path) && !ascii) unread.push({ rule: i, path, kind: "wide" });
    }
  });
  return { hits, unread };
}

/**
 * One error per rule a commit breaks: the first three places, the text and the rule's note; in a merge, how
 * many of the lines the other side brings, and where they are to be fixed.
 * @param {{ rule: number, path: string, line: number, from?: string }[]} hits
 * @param {ForbiddenRule[]} rules
 * @param {string} lang
 */
function forbiddenErrors(hits, rules, lang) {
  return rules.flatMap((rule, i) => {
    const mine = hits.filter((h) => h.rule === i);
    if (!mine.length) return [];
    const where = mine.slice(0, 3).map((h) => `${pathShown(h.path)}:${h.line}`).join(", ") + (mine.length > 3 ? t("shape.cochangeMore", { n: mine.length - 3 }, lang) : "");
    const merged = mine.filter((h) => h.from);
    const brought = merged.length ? t("shape.forbiddenMerged", { n: merged.length, commit: String(merged[0].from).slice(0, 10) }, lang) : "";
    return [t("shape.forbidden", { where, text: rule.text, rule: i + 1, note: rule.note ? ` (${rule.note})` : "" }, lang) + brought];
  });
}
