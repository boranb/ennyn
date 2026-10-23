/**
 * Git helpers. Every call runs with the repository-locating environment
 * variables removed: a git hook exports GIT_DIR / GIT_INDEX_FILE, and a helper
 * that inherits them silently reads the wrong repository or index. And every
 * call sets back the user's config and environment that change what git
 * prints or which paths a pathspec names: with log.showSignature, git writes
 * signature text in front of each commit's format, and a parser reading
 * fields by position reads the wrong ones; i18n.logOutputEncoding re-encodes
 * messages that are read as UTF-8; diff.interHunkContext and GIT_DIFF_OPTS
 * put context lines into a -U0 diff, whose line counts then drift; a
 * pathspec is a glob ("[id].js" matches "i.js") unless it is literal.
 * test/git-oracle.test.mjs runs the readers under such a config.
 *
 * A git call that fails throws. Where git answers "nothing there" with an exit code of its own (an unset
 * key, a missing ref, no repository), gitMaybe and repoPath return null for that answer and throw for any
 * other: a failed, killed or missing git is never read as "nothing there". test/fault-injection.test.mjs
 * runs every CLI command with each of its git calls failing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const LEAKY_ENV = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR"];
/** Environment that changes what git prints or how it reads a path, removed for every call. */
const SHAPING_ENV = ["GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF", "GIT_ICASE_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_LITERAL_PATHSPECS"];
/**
 * Config that would change parsed output, set back for every call; the defaults of diff.algorithm and
 * diff.indentHeuristic keep the rework rate the same on every machine. Paths in a pathspec are literal.
 */
const FIXED_CONFIG = [
  "--literal-pathspecs",
  ...["log.showSignature=false", "i18n.logOutputEncoding=UTF-8", "diff.interHunkContext=0", "diff.algorithm=myers", "diff.indentHeuristic=true", "log.follow=false", "log.showRoot=true"].flatMap((kv) => ["-c", kv]),
];

/** ENOENT from spawn: no git on PATH, or the working directory is not there. */
const NO_START = "git did not start (no git on PATH, or no such directory)";

/** @param {NodeJS.ProcessEnv} env @param {boolean} keepIndex */
function cleanEnv(env, keepIndex) {
  const out = { ...env };
  for (const k of LEAKY_ENV) if (!(keepIndex && k === "GIT_INDEX_FILE")) delete out[k];
  for (const k of SHAPING_ENV) delete out[k];
  return out;
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, keepIndex?: boolean }} opts
 *   `keepIndex` keeps GIT_INDEX_FILE (only for an index already checked by hookIndexFile).
 * @returns {string} stdout without the trailing newline; a failure throws, with git's message as `stderr`
 */
export function git(args, { cwd, env = process.env, keepIndex = false }) {
  try {
    return execFileSync("git", [...FIXED_CONFIG, ...args], {
      cwd,
      env: cleanEnv(env, keepIndex),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, "");
  } catch (err) {
    // A killed git or one that did not start says nothing on stderr: say what happened instead.
    const e = /** @type {Error & { stderr?: string, signal?: string | null, code?: string }} */ (err);
    if (!String(e.stderr ?? "").trim()) e.stderr = `git ${args[0]}: ${e.signal ? `killed by ${e.signal}` : e.code === "ENOENT" ? NO_START : e.message}`;
    throw e;
  }
}

/**
 * A git call whose exit code and error text the caller reads itself: git grep exits 1 for "no match"
 * and also when a file cannot be read, and says which on stderr.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {GitRun}
 * @typedef {{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: Error }} GitRun
 */
export function gitRun(args, { cwd, env = process.env }) {
  const r = spawnSync("git", [...FIXED_CONFIG, ...args], { cwd, env: cleanEnv(env, false), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
}

/**
 * The error for a git call that failed: git's own message, else how it ended (a signal, no git at all).
 * @param {string[]} args @param {GitRun} r
 */
export function gitError(args, r) {
  const how = r.error ? (/** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT" ? NO_START : r.error.message) : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  const said = r.stderr.trim();
  const err = /** @type {Error & { stderr: string, status: number | null }} */ (new Error(`git ${args.join(" ")}: ${said.split("\n")[0] || how}`));
  err.stderr = said || `git ${args[0]}: ${how}`;
  err.status = r.status;
  return err;
}

/**
 * A git question whose "nothing there" answer is an exit code: `config --get` and `--get-regexp` exit 1
 * for no such key, `rev-parse --verify -q` 1 for no such revision, `remote get-url` 2 for no such remote,
 * `merge-base --is-ancestor` 1 for "no". null for those codes, stdout otherwise. Any other exit, a signal
 * (a killed git) or a git that cannot start throws.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, absent: number[] }} opts
 * @returns {string | null}
 */
export function gitMaybe(args, { cwd, env = process.env, absent }) {
  const r = gitRun(args, { cwd, env });
  if (!r.error && r.status !== null && r.status !== 0 && absent.includes(r.status)) return null;
  if (r.error || r.status !== 0) throw gitError(args, r);
  return r.stdout.replace(/\n$/, "");
}

/**
 * A `git rev-parse <flag>` path for the repository at `cwd` (--show-toplevel, --git-dir, --git-common-dir,
 * --absolute-git-dir); null when `cwd` is in no repository, as git says it. Its message is read in the C
 * locale (a Turkish git words it otherwise); any other failure throws: a repository git refuses
 * (safe.directory), no work tree for --show-toplevel (inside .git, a bare repository: a fallback to the
 * working directory there read .git as the project), a killed git, no git at all.
 * @param {string} flag
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {string | null}
 */
export function repoPath(flag, { cwd, env = process.env }) {
  const args = ["rev-parse", flag];
  const r = gitRun(args, { cwd, env: { ...env, LC_ALL: "C", LANGUAGE: "C" } });
  if (!r.error && r.status === 0) return r.stdout.replace(/\n$/, "");
  if (!r.error && r.status === 128 && /^fatal: not a git repository/m.test(r.stderr)) return null;
  throw gitError(args, r);
}

/**
 * HEAD's commit; null when the repository has no commit yet, or `cwd` is in no repository. A branch ref git
 * cannot read (garbage, no permission) makes `rev-parse --verify -q HEAD` exit 1 like a branch with no
 * commit; git log tells the two apart, in the C locale, and a broken one throws.
 * @param {string} cwd
 * @returns {string | null}
 */
export function headCommit(cwd) {
  if (repoPath("--git-dir", { cwd }) === null) return null;
  const hash = gitMaybe(["rev-parse", "--verify", "-q", "HEAD"], { cwd, absent: [1] });
  if (hash) return hash;
  const args = ["log", "-1", "--format=%H"];
  const r = gitRun(args, { cwd, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
  if (!r.error && r.status === 128 && /does not have any commits yet/.test(r.stderr)) return null;
  throw gitError(args, r.status === 0 ? { ...r, status: 1, stderr: "HEAD did not verify, yet git log found a commit" } : r);
}

/**
 * The oldest git the suite runs on (`npm run test:linux`, Ubuntu 22.04's). Older git is not tested, and on 2.30
 * the suite failed four tests, one of them a wrong count: impact read a reference twice for an absolute path.
 */
export const GIT_FLOOR = "2.34";

/**
 * The parts of a "X.Y[.Z…]" version as numbers, or of git's own words for it ("git version 2.39.5 (Apple
 * Git-154)", "git version 2.45.1.windows.1", "git version 2.34.0.rc1"): [X, Y, Z], Z 0 when absent. null for
 * any other text.
 * @param {string} text
 * @returns {number[] | null}
 */
export function parseVersion(text) {
  const m = /^(?:git version )?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Whether version `a` is `b` or newer, part by part (2.100 is newer than 2.34).
 * @param {number[]} a @param {number[]} b
 */
export function versionAtLeast(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * The git on PATH: what `git --version` prints (in the C locale) and its version, null when the text is not
 * git's. A git that fails, is killed or does not start throws.
 * @param {{ cwd: string }} opts
 * @returns {{ text: string, version: number[] | null }}
 */
export function gitVersion({ cwd }) {
  const text = git(["--version"], { cwd, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
  return { text, version: /^git version /.test(text) ? parseVersion(text) : null };
}

/**
 * The index a running hook was given, when it belongs to the repository at
 * `cwd`. `git commit -- <path>` hands its hooks a temporary index through
 * GIT_INDEX_FILE; reading the main index there sees the wrong staged set. An
 * index from another repository (a leaked hook environment) is ignored.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function hookIndexFile(cwd, env) {
  const raw = env.GIT_INDEX_FILE;
  if (!raw) return null;
  const gitDir = repoPath("--absolute-git-dir", { cwd });
  if (!gitDir) return null;
  // A name with nothing behind it stays as given; one that cannot be looked at throws (the hook then says it
  // could not check), never read as another index.
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return resolve(p);
      throw err;
    }
  };
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const dir = real(gitDir);
  const parent = real(dirname(abs));
  // Directly in this repository's git dir: a linked worktree's index (`.git/worktrees/<name>/index`)
  // sits below the main git dir but belongs to the worktree.
  return parent === dir ? join(parent, basename(abs)) : null;
}

/**
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts] pass the hook's environment to read the index it was given
 * @returns {string[]}
 */
export function stagedPaths(cwd, { env } = {}) {
  const index = env ? hookIndexFile(cwd, env) : null;
  // Both names of a rename (diff.renames would list only the new one): moving a file out is a change there too.
  const out = git(["diff", "--cached", "--name-only", "--no-renames", "-z"], {
    cwd,
    env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    keepIndex: Boolean(index),
  });
  return out.split("\0").filter(Boolean);
}

/**
 * Commits on HEAD that the upstream branch does not have.
 * @param {string} cwd
 * @returns {number | null} null when there is nothing to count against (a detached HEAD, no upstream, an
 *   upstream never fetched); a git that fails throws
 */
export function unpushedCount(cwd) {
  const branch = gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd, absent: [1] });
  if (!branch) return null;
  // "@{u}" fails the same way for "no upstream" and for a broken git; for-each-ref prints nothing for the first.
  const upstream = git(["for-each-ref", "--format=%(upstream)", branch], { cwd });
  if (!upstream || !gitMaybe(["rev-parse", "--verify", "-q", upstream], { cwd, absent: [1] })) return null;
  const n = git(["rev-list", "--count", `${upstream}..HEAD`], { cwd });
  if (!/^\d+$/.test(n)) throw new Error(`git rev-list --count printed no count: ${JSON.stringify(n.slice(0, 80))}`);
  return Number(n);
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
 * @returns {string | null} null outside a repository
 */
export function commonDir(cwd) {
  const out = repoPath("--git-common-dir", { cwd });
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
