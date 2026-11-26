/**
 * Where a Claude Code hook of Ennyn's acts, and whether it acts at all. A plugin's hooks run in every session
 * of every project the plugin is enabled in. Ennyn's act only in a project with an Ennyn config, found as the CLI
 * finds it (core/git.mjs projectRoot: `.ennyn/config.json` at the repository's top, or the file ENNYN_CONFIG
 * names). Anywhere else each hook reads its input and ends: no output, nothing written, exit 0. The official
 * plugin directory fails a PostToolUse hook that runs with no such gate, as one that observes tool I/O in
 * sessions unrelated to the plugin (has_broad_scope_hooks). The version record (hooks/plugin-root.mjs) is the one
 * hook that runs in every session: it writes the plugin's own data folder and reads nothing of the project.
 */

import { loadConfig } from "../../core/config.mjs";
import { projectRoot } from "../../core/git.mjs";
import { mayHold } from "./config-place.mjs";

export { hookProjectDir } from "./config-place.mjs";

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
