/**
 * A home of a test file's own. A file that writes under a home takes it from here, not from HOME: run with no
 * test/hermetic.mjs, HOME is the user's, and a review showed an oracle deleting ~/.config/git and rewriting a plugin's
 * record there. ownHome refuses, before any write, when HOME does not lie in the temporary folder, then points HOME,
 * XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL at a new folder, for this process and every child it starts.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[safe]\n\tdirectory = *\n");
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig") });
  return { root, home };
}
