/**
 * Map a path in a side copy of the project back to the project-relative path.
 *
 * A side copy is a second checkout of the project used so that a running commit
 * hook is not disturbed: a git worktree (anywhere on disk) or a plain copy
 * (rsync / cp) under one of the configured `sideCopy.roots`. Path-scoped rules
 * are written against project-relative paths, so a file at
 * `<copy>/src/lib/engine/x.ts` must be treated as `src/lib/engine/x.ts`.
 *
 * Measured origin: in-tree reads loaded path-scoped rules 24 of 24 times;
 * 4 of 2,000+ side-copy turns did.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "../core/git.mjs";

/**
 * Real path of `p`; for a path that does not exist yet (a file about to be
 * written) the longest existing prefix is resolved and the rest appended.
 * `/var/...` and `/private/var/...` must compare equal on macOS.
 * @param {string} p
 * @returns {string}
 */
function resolveReal(p) {
  let cur = resolve(p);
  /** @type {string[]} */
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...[...rest].reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const r = relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}

/** @param {string} p */
const toSlash = (p) => p.split(sep).join("/");

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Nearest directory at or above `start` that contains `entry`.
 * @param {string} start
 * @param {string} entry
 * @param {string | null} stopAt last directory to check (inclusive); null = filesystem root
 * @returns {string | null}
 */
function nearestWith(start, entry, stopAt) {
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, entry))) return d;
    if (d === stopAt || dirname(d) === d) return null;
  }
}

/** @type {Map<string, string | null>} */
const commonDirCache = new Map();

/**
 * Real path of the repository's common git dir (shared by all its worktrees).
 * @param {string} dir
 * @returns {string | null}
 */
function commonDir(dir) {
  if (commonDirCache.has(dir)) return commonDirCache.get(dir) ?? null;
  const out = git(["rev-parse", "--git-common-dir"], { cwd: dir, allowFail: true });
  const value = out ? resolveReal(resolve(dir, out)) : null;
  commonDirCache.set(dir, value);
  return value;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function packageName(dir) {
  try {
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} top directory holding the `.git` entry
 * @param {string} file
 * @param {string} project
 * @returns {{ root: string, relPath: string } | null}
 */
function matchWorktree(top, file, project) {
  const mine = commonDir(project);
  if (!mine || commonDir(top) !== mine) return null;
  return { root: top, relPath: toSlash(relative(top, file)) };
}

/**
 * Plain copy: the nearest ancestor (up to the configured root) whose
 * package.json carries the project's name. "Nearest whose name matches" rather
 * than "nearest package.json": in a workspace monorepo `server/package.json`
 * has its own name and must not hide the copy root above it.
 * @param {string} file
 * @param {string} start
 * @param {string} project
 * @param {readonly string[]} roots
 * @returns {{ root: string, relPath: string } | null}
 */
function matchPlainCopy(file, start, project, roots) {
  const name = packageName(project);
  if (!name) return null;
  for (const r of roots) {
    if (typeof r !== "string" || !r) continue;
    const root = resolveReal(resolve(project, r));
    if (!isInside(file, root)) continue;
    for (let d = start; isInside(d, root); d = dirname(d)) {
      if (packageName(d) === name) return { root: d, relPath: toSlash(relative(d, file)) };
      if (d === root || dirname(d) === d) break;
    }
  }
  return null;
}

/**
 * @param {string} absPath file the tool touched
 * @param {{ projectDir: string, roots?: readonly string[] }} opts
 * @returns {{ root: string, relPath: string } | null} null when the path is not in a side copy of this project
 */
export function mapSideCopyPath(absPath, { projectDir, roots = [] }) {
  try {
    if (typeof absPath !== "string" || !isAbsolute(absPath) || typeof projectDir !== "string" || !projectDir) {
      return null;
    }
    const file = resolveReal(absPath);
    const project = resolveReal(projectDir);
    const start = isDir(file) ? file : dirname(file);

    if (isInside(file, project)) {
      // In-tree paths already load rules. The one exception is a worktree that
      // lives inside the project directory (e.g. `.claude/worktrees/<name>`):
      // its files are not at the project-relative paths the rules are written for.
      const top = nearestWith(start, ".git", project);
      if (!top || top === project) return null;
      return matchWorktree(top, file, project);
    }

    const top = nearestWith(start, ".git", null);
    const wt = top ? matchWorktree(top, file, project) : null;
    if (wt) return wt;
    return matchPlainCopy(file, start, project, Array.isArray(roots) ? roots : []);
  } catch {
    return null;
  }
}
