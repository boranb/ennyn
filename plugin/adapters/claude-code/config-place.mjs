/**
 * Where a hook's project is, and whether a config could be there, with no git and nothing that loads the config: the
 * cost filter project.mjs runs first, apart so that a hook that runs on every shell command can run it alone. Loading
 * project.mjs takes about 5 ms and its answer asks git, which the push hook does not.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { gone } from "../../core/files.mjs";

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
 * Whether git would take this folder for a repository's top: a `.git` file, or a `.git` with a HEAD in it. Anything else
 * of that name git walks past, an empty folder and a dangling link among them, so `mkdir .git` silences nothing.
 * @param {string} dir
 */
function repositoryTop(dir) {
  try {
    return statSync(join(dir, ".git")).isFile() || statSync(join(dir, ".git", "HEAD")).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a config could be found from `projectDir` at all: the file an absolute ENNYN_CONFIG names, or something
 * at the config's relative place in the folder or a folder above it, by its real path, which is where git looks for
 * the top. Not a second lookup, a cost filter: a project with none asks git nothing, so in projects that never used
 * Ennyn the side-copy and style hooks run no git (the reset asks git where its lists are, as before). A session
 * folder that is not there holds none. `repoOnly` stops the walk at the first repository's top, where git would stop,
 * for a caller that may not ask git: a config above a repository is not that repository's.
 * @param {string} projectDir @param {string} rel @param {boolean} [repoOnly]
 */
export function mayHold(projectDir, rel, repoOnly = false) {
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
    if (dirname(dir) === dir || (repoOnly && repositoryTop(dir))) return false;
    dir = dirname(dir);
  }
}
