/**
 * Where a Claude Code hook of Ennyn's acts, and whether it acts at all. A plugin's hooks run in every session
 * of every project the plugin is enabled in. Ennyn's act only in a project with an Ennyn config, found as the CLI
 * finds it (core/git.mjs projectRoot: `.ennyn/config.json` at the repository's top, or the file ENNYN_CONFIG
 * names). Anywhere else each hook reads its input and ends: no output, nothing written, exit 0. The official
 * plugin directory fails a PostToolUse hook that runs with no such gate, as one that observes tool I/O in
 * sessions unrelated to the plugin (has_broad_scope_hooks). The version record (hooks/plugin-root.mjs) is the one
 * hook that runs in every session: it writes the plugin's own data folder and reads nothing of the project.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadConfig } from "../../core/config.mjs";
import { gone } from "../../core/files.mjs";
import { projectRoot } from "../../core/git.mjs";

/**
 * The project a hook runs for: CLAUDE_PROJECT_DIR (the folder the session started in, whose `.claude/` Claude
 * Code reads), else the input's cwd, else the hook's own.
 * @param {unknown} input the hook's input as parsed, or null when it was no JSON
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hookProjectDir(input, env = process.env) {
  const cwd = input !== null && typeof input === "object" ? /** @type {{ cwd?: unknown }} */ (input).cwd : undefined;
  return env.CLAUDE_PROJECT_DIR || (typeof cwd === "string" && cwd) || process.cwd();
}

/**
 * Whether something is at `rel` below `dir`, each part looked at without following a link: a link on the way may
 * lead to a config (which loadConfig then refuses, and the hooks say so), never to "nothing there". A place that
 * cannot be looked at may hold one.
 * @param {string} dir @param {string} rel
 */
function there(dir, rel) {
  let at = dir;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return true;
    } catch (e) {
      return !gone(e);
    }
  }
  return true;
}

/**
 * Whether a config could be found from `projectDir` at all: the file an absolute ENNYN_CONFIG names, or something
 * at the config's relative place in the folder or a folder above it, by its real path, which is where git looks for
 * the top. Not a second lookup, a cost filter: a project with none asks git nothing, so in projects that never used
 * Ennyn the side-copy and style hooks run no git (the reset asks git where its lists are, as before). A session
 * folder that is not there holds none.
 * @param {string} projectDir @param {string} rel
 */
function mayHold(projectDir, rel) {
  let dir;
  try {
    dir = realpathSync(projectDir);
  } catch (e) {
    if (gone(e)) return false;
    throw e;
  }
  // An absolute ENNYN_CONFIG is the user's own path, read following its links (loadConfig): only its last part is
  // looked at, so a link to it still counts.
  if (isAbsolute(rel)) return there(dirname(rel), basename(rel));
  for (;;) {
    if (there(dir, rel)) return true;
    if (dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

/**
 * The project's config, or null when it has none: the one answer every hook but the version record acts on. Read
 * where the CLI reads it, so a session in a subdirectory or a package of a configured repository is configured;
 * the config's `projectDir` is that place (its paths are relative to it). Nothing at the config's place is none:
 * no file, no folder, `.ennyn` a file, an ENNYN_CONFIG naming no file, a session folder that is not there.
 * Something there that does not load (a link, a directory, a file that cannot be read or parsed, a value the
 * config refuses) throws, as loadConfig does: the project asked for Ennyn, and each hook says what it says of a
 * config that does not load. A git that cannot answer (it refuses the repository: another account's, an unknown
 * extension; it is not on the hook's PATH) leaves the session folder as the root, as before the lookup, and is not
 * said: a session at the top keeps its config, and a parent repository of another account says nothing. The CLI
 * stops on the same git (projectRoot throws).
 * @param {string} projectDir
 * @param {NodeJS.ProcessEnv} [env]
 */
export function projectConfig(projectDir, env = process.env) {
  const rel = env.ENNYN_CONFIG || ".ennyn/config.json";
  if (!mayHold(projectDir, rel)) return null;
  let root;
  try {
    root = projectRoot(projectDir);
  } catch {
    root = projectDir;
  }
  const config = loadConfig({ cwd: root, env });
  return config.configPath === null ? null : config;
}
