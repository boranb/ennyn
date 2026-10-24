#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: bridges path-scoped rules into side copies.
 *
 * Claude Code loads a `.claude/rules/*.md` file with a `paths:` list only when
 * a tool touches a matching path inside the project. Work done in a side copy
 * (a git worktree, or a plain copy under `sideCopy.roots`) therefore runs with
 * no path-scoped rules at all. For Read/Edit/Write/MultiEdit/NotebookEdit on a
 * side-copy path, this hook maps the path back to the project, finds the rules
 * that apply, and hands them to the model as `additionalContext`, once per
 * rule per session.
 *
 * Exit codes: 0 on every handled path (including "nothing to do" and malformed
 * input); 1 only when the hook cannot run (bad config). Never 2: in Claude Code
 * exit 2 feeds stderr back as a tool error.
 * Output goes to `hookSpecificOutput.additionalContext` (read by the model),
 * never `systemMessage` (shown only to the user).
 */

import { resolveStateDir } from "../../../core/git.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "../../../core/config.mjs";
import { t } from "../../../core/i18n.mjs";
import { mapSideCopyPath } from "../../../side-copy/map-path.mjs";
import { loadPathScopedRules, readRuleBody, rulesForPath } from "../rules-index.mjs";

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
 * @param {string} path
 * @returns {Set<string>}
 */
function readEmitted(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(data?.emitted) ? data.emitted.filter((/** @type {unknown} */ x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Best effort: a state file that cannot be written only costs a repeated
 * injection, so the rules are emitted anyway.
 * @param {string} path
 * @param {Set<string>} emitted
 */
function writeEmitted(path, emitted) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ emitted: [...emitted].sort() }) + "\n");
    renameSync(tmp, path);
  } catch {
    // ignored on purpose, see above
  }
}

/** @param {string} s */
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** The note on rule files that cannot be read takes at most this much of the cap; past it, a count. */
const NOTE_MAX = 2000;

/**
 * Inline as many rules as the budget holds (each tried in order, so a large rule does not crowd out the
 * smaller ones after it); list the rest by path; then the note on the rule files that could not be read. The
 * whole text never passes CONTEXT_CAP: the budget for rules is `maxBytes` (at most the cap) less the note and
 * the list, were every rule listed; a list or a note too long names as many paths as fit and how many more.
 * `given` holds the rules the text inlines or names: a rule in a count only is not given.
 * @param {string} relPath
 * @param {Array<{ file: string, body: string, changed?: boolean }>} rules
 * @param {number} maxBytes
 * @param {string} lang
 * @param {string[]} [unreadable]
 * @returns {{ text: string, given: Set<string> }}
 */
export function render(relPath, rules, maxBytes, lang, unreadable = []) {
  const header = t("sidecopy.header", { relPath }, lang);
  const top = t("sidecopy.tooLarge", { relPath }, lang);
  const noteWith = (/** @type {number} */ kept) =>
    t("sidecopy.unreadable", { relPath, list: [...unreadable.slice(0, kept), ...(kept < unreadable.length ? [t("sidecopy.unreadableMore", { n: unreadable.length - kept }, lang)] : [])].join(", ") }, lang);
  const noted = most(unreadable.length, (n) => bytes(noteWith(n)) <= NOTE_MAX);
  const note = unreadable.length ? noteWith(noted) : null;
  const after = note ? bytes(note) + 2 : 0;
  const budget = Math.min(maxBytes, CONTEXT_CAP) - after - bytes([top, ...rules.map((r) => `- ${r.file}`)].join("\n")) - 2;
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  const listed = [];
  /** @type {Set<string>} */
  const given = new Set();
  let size = bytes(header);
  for (const r of rules) {
    const changed = r.changed ? ` changed="${t("sidecopy.changed", {}, lang)}"` : "";
    const block = `<rule file="${r.file}"${changed}>\n${r.body}\n</rule>`;
    const add = bytes(block) + 2;
    if (size + add <= budget) {
      blocks.push(block);
      given.add(r.file);
      size += add;
    } else listed.push(r.file);
  }
  const parts = blocks.length ? [header, ...blocks] : [];
  if (listed.length) {
    const used = (/** @type {string} */ list) => bytes([...parts, list, ...(note ? [note] : [])].join("\n\n"));
    const list = (/** @type {number} */ kept) => [top, ...listed.slice(0, kept).map((f) => `- ${f}`), ...(kept < listed.length ? [t("sidecopy.listMore", { n: listed.length - kept }, lang)] : [])].join("\n");
    const kept = most(listed.length, (n) => used(list(n)) <= CONTEXT_CAP);
    parts.push(list(kept));
    for (const f of listed.slice(0, kept)) given.add(f);
  }
  if (note) parts.push(note);
  return { text: parts.join("\n\n"), given };
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

  const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(typeof input.cwd === "string" ? input.cwd : projectDir, rawPath);

  let config;
  try {
    config = loadConfig({ cwd: projectDir });
  } catch (err) {
    process.stderr.write(`${t("sidecopy.cannotRun", { reason: /** @type {Error} */ (err).message }, "en")}\n`);
    return 1;
  }

  const mapped = mapSideCopyPath(absPath, { projectDir, roots: config.sideCopy.roots });
  if (!mapped) return 0;

  /** @type {string[]} */
  const unreadable = [];
  const matching = rulesForPath(loadPathScopedRules(projectDir, unreadable), mapped.relPath);
  if (!matching.length && !unreadable.length) return 0;

  const state = sideCopyStatePath(projectDir, config.paths.stateDir, input.session_id, input.agent_id);
  const emitted = readEmitted(state);
  /** @type {Array<{ file: string, body: string, changed: boolean }>} */
  const fresh = [];
  const before = (/** @type {string} */ file) => [...emitted].filter((e) => keyFile(e) === file);
  for (const file of matching) {
    // Read every time: a rule edited since it was given is given again, with its new text, marked as such.
    const body = readRuleBody(file);
    if (body === null) unreadable.push(file);
    else if (!emitted.has(givenKey(file, body))) fresh.push({ file, body, changed: before(file).length > 0 });
  }
  if (!fresh.length && !unreadable.length) return 0;

  const { text, given } = render(mapped.relPath, fresh, config.sideCopy.maxInjectBytes, config.language, unreadable);
  // Marked as given only what the text inlines or names, and only once it is written out: a rule that could not
  // be read, one in a count, or a text that never reached Claude Code comes back on the next file. One entry a
  // rule: the text it had before goes.
  for (const r of fresh) {
    if (!given.has(r.file)) continue;
    for (const e of before(r.file)) emitted.delete(e);
    emitted.add(givenKey(r.file, r.body));
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }), (err) => {
    if (!err && given.size) writeEmitted(state, emitted);
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
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${t("sidecopy.cannotRun", { reason }, "en")}\n`);
    process.exitCode = 1;
  },
);
