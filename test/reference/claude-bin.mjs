/**
 * The claude binary the recorders run, and the PATH they hand their children: shared by claude-code.mjs, markdown.mjs,
 * the eval self-test and claude.mjs, apart so that none of them imports another to have it (claude-code.mjs's `check`
 * imports markdown.mjs).
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * PATH as a recorder hands it on and looks in: its absolute folders that are no node_modules/.bin (npm run puts every
 * ancestor's first, and one under /tmp any user may make).
 * @param {string} [path] PATH
 */
export const safePath = (path = process.env.PATH ?? "") =>
  path
    .split(delimiter)
    .filter((d) => isAbsolute(d) && !/(^|[\\/])node_modules[\\/]\.bin[\\/]*$/.test(d))
    .join(delimiter);

/**
 * The claude a recorder runs: `bin` itself when it names a path, else the first `bin` in a folder of safePath; `path`
 * is as found, `file` its real file.
 * @param {string} bin @param {string} [path] PATH
 * @returns {{ path: string, file: string } | null}
 */
export function claudeBinary(bin, path = process.env.PATH ?? "") {
  const isFile = (/** @type {string} */ p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const candidates = /[\\/]/.test(bin) ? [bin] : safePath(path).split(delimiter).filter(Boolean).map((d) => join(d, bin));
  for (const p of candidates) if (isFile(p)) return { path: p, file: realpathSync(p) };
  return null;
}

/** The binary's version, as `--version` prints it. @param {string} bin */
export function versionOf(bin) {
  const m = /^(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: safePath() }, timeout: 30_000, killSignal: "SIGKILL" }).trim());
  if (!m) throw new Error(`${bin} --version printed no version`);
  return m[1];
}
