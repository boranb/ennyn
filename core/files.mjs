/**
 * File presence that never reads a failure as "not there". existsSync answers false for a file it cannot
 * look at (no search permission on its directory): a config then read as "none, defaults apply", a work
 * graph as "not found", a test as missing. test/fault-injection.test.mjs fails every file read in turn.
 */

import { readFileSync, statSync } from "node:fs";

/**
 * Nothing there: ENOENT; ENOTDIR (a file where one of the path's directories should be); ELOOP (a link
 * that leads back to itself names no file); ENAMETOOLONG (no file has such a name).
 * @param {unknown} err
 */
export function gone(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG";
}

/**
 * Whether something is at `path`. false only when nothing is (ENOENT, ENOTDIR); a path that cannot be
 * looked at throws. Not statSync's throwIfNoEntry: on Node 20.0 it hides ENOENT only.
 * @param {string} path
 */
export function present(path) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (gone(err)) return false;
    throw err;
  }
}

/**
 * A file's text, or null when nothing is there; a file that is there but cannot be read (no permission, a
 * directory in its place) throws, naming the path (Node's EISDIR message names none).
 * @param {string} path
 * @returns {string | null}
 */
export function readIfThere(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (gone(err)) return null;
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    e.message = `${path} could not be read: ${e.message}`;
    throw e;
  }
}
