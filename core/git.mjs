/**
 * Git helpers. Every call runs with the repository-locating environment
 * variables removed: a git hook exports GIT_DIR / GIT_INDEX_FILE, and a helper
 * that inherits them silently reads the wrong repository or index.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const LEAKY_ENV = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR"];

/** @param {NodeJS.ProcessEnv} env */
function cleanEnv(env) {
  const out = { ...env };
  for (const k of LEAKY_ENV) delete out[k];
  return out;
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, allowFail?: boolean }} opts
 * @returns {string} stdout without the trailing newline ("" on allowed failure)
 */
export function git(args, { cwd, env = process.env, allowFail = false }) {
  try {
    return execFileSync("git", args, {
      cwd,
      env: cleanEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, "");
  } catch (err) {
    if (allowFail) return "";
    throw err;
  }
}

/** @param {string} cwd @returns {string[]} */
export function stagedPaths(cwd) {
  const out = git(["diff", "--cached", "--name-only", "-z"], { cwd });
  return out.split("\0").filter(Boolean);
}

/**
 * Commits on HEAD that the upstream branch does not have.
 * @param {string} cwd
 * @returns {number | null} null when there is no upstream (cannot measure)
 */
export function unpushedCount(cwd) {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd, allowFail: true });
  if (!upstream) return null;
  const n = git(["rev-list", "--count", `${upstream}..HEAD`], { cwd, allowFail: true });
  return n === "" ? null : Number(n);
}

/**
 * Trailer block of a commit message ("Key: value" lines in the last paragraph).
 * @param {string} message
 * @returns {Map<string, string[]>}
 */
export function parseTrailers(message) {
  const paragraphs = message.replace(/\r\n/g, "\n").trimEnd().split(/\n{2,}/);
  const out = new Map();
  if (paragraphs.length < 2) return out;
  const last = paragraphs[paragraphs.length - 1].split("\n");
  if (!last.every((l) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(l))) return out;
  for (const line of last) {
    const idx = line.indexOf(":");
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1).trim();
    out.set(key, [...(out.get(key) ?? []), val]);
  }
  return out;
}

/**
 * The repository's common git dir (shared by every worktree), absolute.
 * @param {string} cwd
 * @returns {string | null}
 */
export function commonDir(cwd) {
  const out = git(["rev-parse", "--git-common-dir"], { cwd, allowFail: true });
  if (!out) return null;
  const abs = resolve(cwd, out);
  try {
    return realpathSync(abs); // macOS: /var is a symlink to /private/var
  } catch {
    return abs;
  }
}

/**
 * Resolve the machine-local state directory. A value under ".git/" is resolved
 * through the common git dir: in a linked worktree ".git" is a file, and a
 * state dir under it cannot be created.
 * @param {string} projectDir
 * @param {string} stateDir config `paths.stateDir`
 * @returns {string}
 */
export function resolveStateDir(projectDir, stateDir) {
  if (isAbsolute(stateDir)) return stateDir;
  const norm = stateDir.replace(/\\/g, "/");
  if (norm === ".git" || norm.startsWith(".git/")) {
    const common = commonDir(projectDir);
    if (common) return join(common, norm.slice(".git".length));
  }
  return resolve(projectDir, stateDir);
}
