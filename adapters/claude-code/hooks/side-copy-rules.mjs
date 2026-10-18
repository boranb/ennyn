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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "../../../core/config.mjs";
import { t } from "../../../core/i18n.mjs";
import { mapSideCopyPath } from "../../../side-copy/map-path.mjs";
import { loadPathScopedRules, readRuleBody, rulesForPath } from "../rules-index.mjs";

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * @param {string} projectDir
 * @param {string} stateDir
 * @param {unknown} sessionId
 */
function statePath(projectDir, stateDir, sessionId) {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "no-session";
  return join(resolveStateDir(projectDir, stateDir), "side-copy", `${safe}.json`);
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

/**
 * Inline as many rules as the budget holds (each tried in order, so a large
 * rule does not crowd out the smaller ones after it); list the rest by path.
 * @param {string} relPath
 * @param {Array<{ file: string, body: string }>} rules
 * @param {number} maxBytes
 * @param {string} lang
 */
function render(relPath, rules, maxBytes, lang) {
  const header = t("sidecopy.header", { relPath }, lang);
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  const listed = [];
  let size = Buffer.byteLength(header, "utf8");
  for (const r of rules) {
    const block = `<rule file="${r.file}">\n${r.body}\n</rule>`;
    const add = Buffer.byteLength(block, "utf8") + 2;
    if (size + add <= maxBytes) {
      blocks.push(block);
      size += add;
    } else listed.push(r.file);
  }
  const list = [t("sidecopy.tooLarge", { relPath }, lang), ...listed.map((f) => `- ${f}`)].join("\n");
  if (!blocks.length) return list;
  return [header, ...blocks, ...(listed.length ? [list] : [])].join("\n\n");
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

  const matching = rulesForPath(loadPathScopedRules(projectDir), mapped.relPath);
  if (!matching.length) return 0;

  const state = statePath(projectDir, config.paths.stateDir, input.session_id);
  const emitted = readEmitted(state);
  const fresh = [];
  for (const file of matching) {
    if (emitted.has(file)) continue;
    const body = readRuleBody(file);
    if (body !== null) fresh.push({ file, body });
  }
  if (!fresh.length) return 0;

  for (const r of fresh) emitted.add(r.file);
  writeEmitted(state, emitted);

  const additionalContext = render(mapped.relPath, fresh, config.sideCopy.maxInjectBytes, config.language);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const reason = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`${t("sidecopy.cannotRun", { reason }, "en")}\n`);
    process.exitCode = 1;
  },
);
