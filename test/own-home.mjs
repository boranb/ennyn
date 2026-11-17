/**
 * A home of a test file's own. A file that writes under a home takes it from here, not from HOME: run with no
 * test/hermetic.mjs, HOME is the user's, and a review showed an oracle deleting ~/.config/git and rewriting a plugin's
 * record there. ownHome refuses, before any write, when HOME does not lie in the temporary folder, then points HOME,
 * XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL at a new folder, for this process and every child it starts. It also takes
 * away every other place a write can follow out of that home (TAKEN, and git's variables but two): run from a plugin
 * session with HOME in the temporary folder, install-hook rewrote the session's record named by ENNYN_PLUGIN_DATA, and
 * a leaked GIT_DIR had git rewrite another repository's index. test/hermetic.mjs takes most of them away too.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * The places a write follows out of the home, each taken away: a plugin session's data directory and root (install-hook
 * writes the record there), Claude Code's plugin variables and env file (the SessionStart hook writes both), its
 * config folder (where doctor and the block look for the record), and the heavy-job queue (`ennyn lock` writes it).
 */
const TAKEN = ["ENNYN_PLUGIN_DATA", "ENNYN_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "CLAUDE_CONFIG_DIR", "ENNYN_LOCK_DIR"];
/** git's variables that stay: they only narrow what git reads. Every other GIT_* goes (a repository, an index, a config). */
const GIT_KEPT = ["GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES"];

/** The real path, or the path as given when nothing is there. @param {string} path */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * @param {string} prefix the temporary folder's name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ root: string, home: string }} `root`: a new folder in the temporary folder; `home`: the new home in it
 */
export function ownHome(prefix, env = process.env) {
  if (!env.HOME || !real(env.HOME).startsWith(real(tmpdir()) + sep)) {
    throw new Error(`this test file refuses to run: HOME (${env.HOME}) does not lie in the temporary folder (${tmpdir()}); run it with --import ./test/hermetic.mjs`);
  }
  for (const k of Object.keys(env)) if (TAKEN.includes(k) || (k.startsWith("GIT_") && !GIT_KEPT.includes(k))) delete env[k];
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[safe]\n\tdirectory = *\n");
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig") });
  return { root, home };
}
