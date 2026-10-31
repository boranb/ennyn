#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: bridges path-scoped rules into side copies.
 *
 * Claude Code loads a `.claude/rules/*.md` file with a `paths:` list when a
 * tool touches a matching path of the project. Work done in a side copy (a git
 * worktree, or a plain copy under `sideCopy.roots`) is at other paths, where
 * the project's rules may not load; Claude Code 2.1.310 was seen to load a
 * copy's own rules in a worktree under `.claude/worktrees/` (cycle 14 review),
 * which are the copy's text, not the project's. For
 * Read/Edit/Write/MultiEdit/NotebookEdit on a side-copy path, this hook maps
 * the path back to the project, finds the project's rules that apply, and
 * hands them to the model as `additionalContext`, once per rule per session.
 *
 * Exit codes: 0 on every handled path (including "nothing to do" and malformed
 * input); 1 only when the hook cannot run (bad config). Never 2: in Claude Code
 * exit 2 feeds stderr back as a tool error.
 * Output goes to `hookSpecificOutput.additionalContext` (read by the model),
 * never `systemMessage` (shown only to the user).
 */

import { resolveStateDir, stateRoot } from "../../../core/git.mjs";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readRegular, writeState } from "../../../core/files.mjs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { asciiJson, shown, t } from "../../../core/i18n.mjs";
import { mapSideCopyPath } from "../../../side-copy/map-path.mjs";
import { hookProjectDir, projectConfig } from "../project.mjs";
import { LEAVES, isLimit, loadPathScopedRules, readRuleBody, reasonText, rulesForPath } from "../rules-index.mjs";

/** The file tools the hook reads a path from; hooks/hooks.json's matcher sends exactly these (test/plugin.test.mjs). */
export const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Claude Code keeps a hook's additionalContext to 10,000 characters: past that it saves the text to a file and
 * shows the model a path and a 2,000-character preview it is not asked to read (code.claude.com/docs/en/hooks).
 * The rules marked as given must be the ones the model reads, so the whole text stays under it; a UTF-8 byte
 * count is never below the character count, so bytes are measured.
 */
export const CONTEXT_CAP = 10000;

/** @param {string} s */
const digest = (s) => createHash("sha256").update(s).digest("hex");

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Where the "already injected" list of one context lives (shared with side-copy-reset.mjs): the session's,
 * or a subagent's in it, which Claude Code names with `agent_id` (a subagent has a context of its own, and a
 * rule given there is not in the main conversation's). An id that is cleaned for a file name, holds capitals
 * (a case-insensitive disk folds them) or is not text keeps a digest of the raw one; "+" parts the session from
 * the agent, and no cleaned id holds one, so no two contexts share a file.
 * @param {string} projectDir
 * @param {string} stateDir
 * @param {unknown} sessionId
 * @param {unknown} [agentId]
 */
export function sideCopyStatePath(projectDir, stateDir, sessionId, agentId) {
  const part = (/** @type {unknown} */ v) => {
    if (v === undefined || v === null || v === "") return "+none";
    if (typeof v !== "string") return `+${digest(JSON.stringify(v) ?? String(v)).slice(0, 16)}`;
    // Cut to 60 characters a part, so session and agent stay within a file name's 255 bytes.
    const safe = v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
    return safe === v && !/[A-Z]/.test(v) ? safe : `${safe}+${digest(v).slice(0, 12)}`;
  };
  const agent = agentId === undefined || agentId === null || agentId === "" ? "" : `+agent-${part(agentId)}`;
  return join(resolveStateDir(projectDir, stateDir), "side-copy", `${part(sessionId)}${agent}.json`);
}

/** A rule as given: its file and the text it had, so an edited rule is given again. @param {string} file @param {string} body */
const givenKey = (file, body) => `${file}#${digest(body).slice(0, 16)}`;

/** A rule link out of the project, once its note is given: said once per context, not on every file. @param {string} file */
const outsideKey = (file) => `outside:${file}`;

/** A paths pattern the hook cannot read, once its note is given: said once per context. @param {{ file: string, pattern: string }} b */
const badKey = (b) => `bad:${b.file}#${digest(b.pattern).slice(0, 16)}`;

/** How long a pattern the hook cannot read is shown: its start, as a value. */
const PATTERN_SHOWN_MAX = 80;

/** The file a given-list entry names: the key less its digest, or a plain path from before digests were kept. @param {string} entry */
const keyFile = (entry) => (/#[0-9a-f]{16}$/.test(entry) ? entry.slice(0, -17) : entry);

/**
 * The largest `n` from 0 to `max` for which `fits(n)` holds, `fits` holding for every smaller one too: a
 * search, not a step down from `max` that rebuilds the text for each entry dropped.
 * @param {number} max @param {(n: number) => boolean} fits
 */
function most(max, fits) {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * @param {string} root the directory it is read below with no link (stateRoot) @param {string} path
 * @returns {Set<string>}
 */
function readEmitted(root, path) {
  try {
    // Nothing there yet reads as "null": no list.
    const data = JSON.parse(readRegular(root, path)?.toString("utf8") ?? "null");
    return new Set(Array.isArray(data?.emitted) ? data.emitted.filter((/** @type {unknown} */ x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Best effort: a state file that cannot be written (a link a commit holds among its directories, say) only costs
 * a repeated injection, so the rules are emitted anyway.
 * @param {string} root @param {string} path
 * @param {Set<string>} emitted
 */
function writeEmitted(root, path, emitted) {
  try {
    writeState(root, path, JSON.stringify({ emitted: [...emitted].sort() }) + "\n", "replace");
  } catch {
    // ignored on purpose, see above
  }
}

/** @param {string} s */
const bytes = (s) => Buffer.byteLength(s, "utf8");

/**
 * The most bytes a name takes in the hook's text, shown. Escaped, a name can grow sixfold (each "<" or control
 * character is six bytes); past these its middle is cut, so the text stays inside CONTEXT_CAP whatever the
 * names, and the rule that applies is at least named: the side copy's path, shown up to three times (header,
 * list, note), 1,000; a project name, 4,100, so a real path (Linux's limit is 4,096 bytes) shown as it is is
 * never cut.
 */
export const PATH_SHOWN_MAX = 1000;
export const NAME_SHOWN_MAX = 4100;

/**
 * A name as a value with a visible start and end: one JSON string, or, past `max` bytes, its start and its
 * end as two, with "…" between them.
 * @param {string} name @param {number} [max]
 */
export function value(name, max = PATH_SHOWN_MAX) {
  const whole = asciiJson(name);
  if (bytes(whole) <= max) return whole;
  const cps = [...name];
  const half = Math.floor((max - bytes("…")) / 2);
  const head = most(cps.length, (n) => bytes(asciiJson(cps.slice(0, n).join(""))) <= half);
  const tail = most(cps.length - head, (n) => bytes(asciiJson(cps.slice(cps.length - n).join(""))) <= half);
  return `${asciiJson(cps.slice(0, head).join(""))}…${asciiJson(cps.slice(cps.length - tail).join(""))}`;
}

/**
 * A name of the project's own (a rule file, one that cannot be read) as the model reads it in the hook's
 * text: as it is, as Claude Code's own loading names it, or as a value (`value`) when it holds what could
 * frame words of its own as the hook's: a line break, a control or format character, a quote, a backslash,
 * an angle bracket; or when it is longer than NAME_SHOWN_MAX. A side copy's names are always values (render).
 * `cut`: shown by its start and end only, so the file cannot be opened by what is shown.
 * @param {string} name
 * @returns {{ text: string, quoted: boolean, cut: boolean }}
 */
export function named(name) {
  // Its own bound (NAME_SHOWN_MAX), so not shown()'s.
  const plain = !shown(name, { name: true, max: Infinity }).quoted && !/[<>]/.test(name) && bytes(name) <= NAME_SHOWN_MAX;
  if (plain) return { text: name, quoted: false, cut: false };
  return { text: value(name, NAME_SHOWN_MAX), quoted: true, cut: bytes(asciiJson(name)) > NAME_SHOWN_MAX };
}

/** An error as one line the user can read: no line breaks, and no control character a terminal would act on. @param {string} s */
export const said = (s) => shown(s.trim().replace(/\s*\n\s*(?:- )?/g, "; ")).text;

/**
 * The token a text's rule markers hold (`<rule-<token> file=…>` … `</rule-<token>>`): 12 hex characters drawn for
 * each text, again while a body holds them. A body is given byte for byte, so nothing in it (a `</rule>`, code
 * such as `Promise<Rule[]>`, a look-alike character) can end its element, and the cost is one search per body.
 * @param {string[]} bodies @param {() => string} [draw]
 */
export function boundary(bodies, draw = () => randomBytes(6).toString("hex")) {
  for (;;) {
    const token = draw();
    if (!bodies.some((b) => b.includes(token))) return token;
  }
}

/** The note on rule files that cannot be read takes at most this much of the cap; past it, a count. */
const NOTE_MAX = 2000;

/**
 * Inline as many rules as the budget holds (each tried in order, so a large rule does not crowd out the
 * smaller ones after it); list the rest by path; then the note on the rule files that could not be read. The
 * whole text never passes CONTEXT_CAP: the budget for rules is `maxBytes` (at most the cap) less the note and
 * the list, were every rule listed; a list or a note too long names as many paths as fit and how many more.
 * `given` holds the rules the text inlines or names whole: a rule in a count only, or named by its start and end
 * only (`named().cut`), is not given.
 * @param {string} relPath
 * @param {Array<{ file: string, body: string, changed?: boolean }>} rules
 * @param {number} maxBytes
 * @param {string} lang
 * @param {string[]} [unreadable]
 * @param {string[]} [outside] rule links whose real path leaves the project: not followed, which the text says
 * @param {Map<string, string>} [limits] a walk's limit reached at a path (depth, entries), shown beside it
 * @param {{ file: string, pattern: string }[]} [bad] paths patterns no expression can hold: skipped, which the text
 *   says, with the rule's file and the pattern's start
 * @param {() => string} [draw] the marker token's source (boundary); random unless a test gives one
 * @returns {{ text: string, given: Set<string>, said: Set<string>, badSaid: Set<{ file: string, pattern: string }>, token: string }} `said`:
 *   the links out the text names; `badSaid`: the patterns it names; `token`: the one the rule markers hold (boundary)
 */
export function render(relPath, rules, maxBytes, lang, unreadable = [], outside = [], limits = new Map(), bad = [], draw = undefined) {
  // The side copy's name: no trusted text (a worktree may hold a pull request under review), always a value.
  const path = value(relPath);
  const item = (/** @type {string} */ file) => named(file).text;
  const header = t("sidecopy.header", { relPath: path }, lang);
  const top = t("sidecopy.tooLarge", { relPath: path }, lang);
  // A path the walk stopped at says why: what below it was not read, a count of the directories left too.
  const unreadItem = (/** @type {string} */ file) => (limits.has(file) ? `${item(file)} (${limits.get(file)})` : item(file));
  const noteWith = (/** @type {number} */ kept) =>
    t("sidecopy.unreadable", { relPath: path, list: { shown: [...unreadable.slice(0, kept).map(unreadItem), ...(kept < unreadable.length ? [t("sidecopy.unreadableMore", { n: unreadable.length - kept }, lang)] : [])].join(", ") } }, lang);
  const noted = most(unreadable.length, (n) => bytes(noteWith(n)) <= NOTE_MAX);
  const note = unreadable.length ? noteWith(noted) : null;
  const outsideWith = (/** @type {number} */ kept) =>
    t("sidecopy.outside", { list: { shown: [...outside.slice(0, kept).map(item), ...(kept < outside.length ? [t("sidecopy.unreadableMore", { n: outside.length - kept }, lang)] : [])].join(", ") } }, lang);
  const outsideKept = most(outside.length, (n) => bytes(outsideWith(n)) <= NOTE_MAX);
  const outsideNote = outside.length ? outsideWith(outsideKept) : null;
  // Said: only the links the note names whole.
  const said = new Set(outside.slice(0, outsideKept).filter((f) => !named(f).cut));
  const badItem = (/** @type {{ file: string, pattern: string }} */ b) => `${item(b.file)} ${value(b.pattern, PATTERN_SHOWN_MAX)}`;
  const badWith = (/** @type {number} */ kept) =>
    t("sidecopy.badPattern", { list: { shown: [...bad.slice(0, kept).map(badItem), ...(kept < bad.length ? [t("sidecopy.unreadableMore", { n: bad.length - kept }, lang)] : [])].join(", ") } }, lang);
  const badKept = most(bad.length, (n) => bytes(badWith(n)) <= NOTE_MAX);
  const badNote = bad.length ? badWith(badKept) : null;
  const badSaid = new Set(bad.slice(0, badKept).filter((b) => !named(b.file).cut));
  const after = (note ? bytes(note) + 2 : 0) + (outsideNote ? bytes(outsideNote) + 2 : 0) + (badNote ? bytes(badNote) + 2 : 0);
  const budget = Math.min(maxBytes, CONTEXT_CAP) - after - bytes([top, ...rules.map((r) => `- ${item(r.file)}`)].join("\n")) - 2;
  const token = boundary(rules.map((r) => r.body), draw);
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  const listed = [];
  /** @type {Set<string>} */
  const given = new Set();
  let size = bytes(header);
  for (const r of rules) {
    const changed = r.changed ? ` changed="${t("sidecopy.changed", {}, lang)}"` : "";
    const file = named(r.file);
    const block = `<rule-${token} file=${file.quoted ? file.text : `"${file.text}"`}${changed}>\n${r.body}\n</rule-${token}>`;
    const add = bytes(block) + 2;
    if (size + add <= budget) {
      blocks.push(block);
      given.add(r.file);
      size += add;
    } else listed.push(r.file);
  }
  const parts = blocks.length ? [header, ...blocks] : [];
  if (listed.length) {
    const used = (/** @type {string} */ list) => bytes([...parts, list, ...(note ? [note] : []), ...(outsideNote ? [outsideNote] : []), ...(badNote ? [badNote] : [])].join("\n\n"));
    const list = (/** @type {number} */ kept) => [top, ...listed.slice(0, kept).map((f) => `- ${item(f)}`), ...(kept < listed.length ? [t("sidecopy.listMore", { n: listed.length - kept }, lang)] : [])].join("\n");
    const kept = most(listed.length, (n) => used(list(n)) <= CONTEXT_CAP);
    parts.push(list(kept));
    // Named cut, a rule cannot be opened by what is shown: it is not given, and is offered again.
    for (const f of listed.slice(0, kept)) if (!named(f).cut) given.add(f);
  }
  if (note) parts.push(note);
  if (outsideNote) parts.push(outsideNote);
  if (badNote) parts.push(badNote);
  return { text: parts.join("\n\n"), given, said, badSaid, token };
}

/** @returns {Promise<number>} exit code */
async function main() {
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object" || !FILE_TOOLS.has(input.tool_name)) return 0;

  const ti = input.tool_input ?? {};
  const rawPath = [ti.file_path, ti.path, ti.notebook_path].find((p) => typeof p === "string" && p);
  if (!rawPath) return 0;

  const projectDir = hookProjectDir(input);
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(typeof input.cwd === "string" ? input.cwd : projectDir, rawPath);

  let config;
  try {
    config = projectConfig(projectDir);
  } catch (err) {
    process.stderr.write(`${t("sidecopy.cannotRun", { reason: said(/** @type {Error} */ (err).message) }, "en")}\n`);
    return 1;
  }
  // Not a project Ennyn works in (../project.mjs): nothing of it is read.
  if (!config) return 0;

  // The roots are the config's, relative to where it was found (the repository's top), not to a session started
  // below it; as real paths, as the mapping resolves them.
  const base = realpathSync.native(config.projectDir);
  // An entry that is no name stays as it is: the mapping skips it, as before.
  const roots = /** @type {string[]} */ (config.sideCopy.roots.map((/** @type {unknown} */ r) => (typeof r === "string" && r ? resolve(base, r) : r)));
  const mapped = mapSideCopyPath(absPath, { projectDir, roots });
  if (!mapped) return 0;

  /** @type {string[]} */
  const found = [];
  /** @type {Map<string, string>} */
  const why = new Map();
  // A pattern the hook cannot read is skipped, as Claude Code skips it; its rule still applies by its others.
  /** @type {{ file: string, pattern: string }[]} */
  const bad = [];
  const matching = rulesForPath(loadPathScopedRules(projectDir, found, why), mapped.relPath, bad);
  // A rule link out of the project (Claude Code's own notion, CLAUDE_PROJECT_DIR) is not followed: Claude Code
  // loads it only once the user approves external imports, which the hook cannot see. Said once per context.
  const linkedOut = found.filter((p) => why.get(p) === LEAVES);
  const unreadable = found.filter((p) => why.get(p) !== LEAVES);
  /** @type {Map<string, string>} */
  const limits = new Map(unreadable.filter((p) => isLimit(why.get(p))).map((p) => [p, reasonText(/** @type {string} */ (why.get(p)), config.language)]));

  const state = sideCopyStatePath(projectDir, config.paths.stateDir, input.session_id, input.agent_id);
  const root = stateRoot(projectDir, state);
  const emitted = readEmitted(root, state);
  const outside = linkedOut.filter((p) => !emitted.has(outsideKey(p)));
  const badNew = bad.filter((p) => !emitted.has(badKey(p)));
  if (!matching.length && !unreadable.length && !outside.length && !badNew.length) return 0;
  /** @type {Array<{ file: string, body: string, changed: boolean }>} */
  const fresh = [];
  const before = (/** @type {string} */ file) => [...emitted].filter((e) => keyFile(e) === file);
  for (const file of matching) {
    // Read every time: a rule edited since it was given is given again, with its new text, marked as such.
    const body = readRuleBody(file);
    if (body === null) unreadable.push(file);
    else if (!emitted.has(givenKey(file, body))) fresh.push({ file, body, changed: before(file).length > 0 });
  }
  if (!fresh.length && !unreadable.length && !outside.length && !badNew.length) return 0;

  const { text, given, said: saidOutside, badSaid } = render(mapped.relPath, fresh, config.sideCopy.maxInjectBytes, config.language, unreadable, outside, limits, badNew);
  // Marked as given only what the text inlines or names, and only once it is written out: a rule that could not
  // be read, one in a count, or a text that never reached Claude Code comes back on the next file. One entry a
  // rule: the text it had before goes.
  for (const r of fresh) {
    if (!given.has(r.file)) continue;
    for (const e of before(r.file)) emitted.delete(e);
    emitted.add(givenKey(r.file, r.body));
  }
  for (const f of saidOutside) emitted.add(outsideKey(f));
  for (const f of badSaid) emitted.add(badKey(f));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }), (err) => {
    if (!err && (given.size || saidOutside.size || badSaid.size)) writeEmitted(root, state, emitted);
  });
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

// Claude Code stopped reading: end without a stack trace, as a process ended by SIGPIPE.
if (invokedDirectly) {
  process.stdout.on("error", (e) => {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPIPE") process.exit(141);
    throw e;
  });
}

if (invokedDirectly) main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // The message, not a stack trace: this runs on every edit, and says why it cannot.
    const reason = said(err instanceof Error ? err.message : String(err));
    process.stderr.write(`${t("sidecopy.cannotRun", { reason }, "en")}\n`);
    process.exitCode = 1;
  },
);
