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
 * other: a failed, killed, stopped or missing git is never read as "nothing there". test/fault-injection.test.mjs
 * runs every CLI command with each of its git calls failing, and with the first and the last never ending.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isUtf8 } from "node:buffer";
import { realpathSync } from "node:fs";
import { readIfThere } from "./files.mjs";
import { startsWithMark, wideEncoding, wideLines } from "./encoding.mjs";

/** The largest file read whole to be decoded as UTF-16 or UTF-32; past it, git's own lines are still read. */
export const WIDE_LIMIT = 16 * 1024 * 1024;

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

/**
 * How long one git call may run, in ms, before git is stopped (SIGKILL) and the call fails, saying so: `call` for
 * any call, `walk` for one that walks the history or the whole tree (log, blame, rev-list, grep), whose time grows
 * with the repository. A stream counts from git's last output instead. When the limit passes, the pipes are closed
 * too: a process git started may still hold them (cycle 11: a cat-file whose input never ended held a commit for
 * 16 minutes). Measured in cycle 13: the commit-msg hook's slowest call, cat-file --batch of a staged 55 MB file,
 * took 0.7 s at load 17; the slowest walk, a log of 53,000 commits, 1.7 s at load 34; at load 85-274 the test suite
 * ran six times slower. Nothing in Ennyn changes them: no environment variable or config, so a committed file
 * cannot shorten them and let a commit through unchecked; only a test's preload lowers them (test/fault-fs.mjs).
 * git runs in Ennyn's own process group, never one of its own: Ctrl-C reaches the terminal's foreground group, and a
 * git in another group would outlive Node and the limit's timer. So the limit kills git alone; a process git
 * started and did not end loses its parent and our pipes.
 */
export const GIT_LIMITS = { call: 60_000, walk: 600_000 };

/**
 * The most a staged diff call reads, by the larger of each file's two sizes. git computes a file's whole diff
 * before it writes any of it, and that time grows faster than the file: short lines reordered took 1.6 s for
 * 0.5 MB, 5.3 s for 1 MB, 10.5 s for 2 MB and 50 s for 4 MB at load 65-75 (cycle 13). A file past it gets a call of
 * its own, so a stop names it alone; the others go together up to it.
 */
export const DIFF_GROUP = 1024 * 1024;

/**
 * The calls a staged diff of `paths` is split into, in order: up to DIFF_GROUP and 500 paths a call, by the larger
 * of each file's two sizes in `changes` (stagedChanges; a path not there counts as small), so a file past
 * DIFF_GROUP has one of its own.
 * @param {string[]} paths @param {Map<string, { oldSize: number, newSize: number }>} changes
 * @returns {string[][]}
 */
export function diffGroups(paths, changes) {
  const size = (/** @type {string} */ p) => Math.max(changes.get(p)?.oldSize ?? 0, changes.get(p)?.newSize ?? 0);
  /** @type {string[][]} */
  const groups = [];
  /** @type {string[]} */
  let group = [];
  let bytes = 0;
  for (const p of paths) {
    const n = size(p);
    if (group.length && (group.length === 500 || bytes + n > DIFF_GROUP)) groups.push(group), (group = []), (bytes = 0);
    group.push(p);
    bytes += n;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** @param {number} ms */
const seconds = (ms) => `${ms / 1000} s`;

/**
 * The command's name, past any "-c key=value" in front of it.
 * @param {string[]} args
 */
function commandName(args) {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return args[at];
}

/**
 * The error of a call stopped at its limit. @param {string[]} args @param {number} ms
 * @returns {Error & { code: "ETIMEDOUT", stderr: string }}
 */
function stopped(args, ms) {
  const text = `git ${commandName(args)}: did not finish in ${seconds(ms)} and was stopped`;
  return Object.assign(new Error(text), { code: /** @type {const} */ ("ETIMEDOUT"), stderr: text });
}

/**
 * Stops a streaming git child once it has written nothing for the call limit: it is killed (with the processes
 * it started, on Windows), its pipes are closed, and `fail` gets an error naming the command and the limit. A
 * close handler that would hand on a line returns at once when `stopped` is set: the call has already failed.
 * @param {import("node:child_process").ChildProcess} child @param {string} name @param {(e: Error) => void} fail
 * @returns {{ stopped: boolean }}
 */
function stopWhenSilent(child, name, fail) {
  const ms = GIT_LIMITS.call;
  const state = { stopped: false };
  const timer = setTimeout(() => {
    state.stopped = true;
    if (process.platform === "win32" && child.pid !== undefined) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    child.kill("SIGKILL");
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
    const text = `git ${name}: wrote nothing for ${seconds(ms)} and was stopped`;
    fail(Object.assign(new Error(text), { code: "ETIMEDOUT", stderr: text }));
  }, ms);
  const heard = () => timer.refresh();
  child.stdout?.on("data", heard);
  child.stderr?.on("data", heard);
  // A child that could not start closes too.
  child.on("close", () => clearTimeout(timer));
  return state;
}

/** @param {NodeJS.ProcessEnv} env @param {boolean} keepIndex */
function cleanEnv(env, keepIndex) {
  const out = { ...env };
  for (const k of LEAKY_ENV) if (!(keepIndex && k === "GIT_INDEX_FILE")) delete out[k];
  for (const k of SHAPING_ENV) delete out[k];
  // GIT_TRACE=/dev/stdout (or any GIT_TRACE_* sent there) would be read as git's answer.
  for (const k of Object.keys(out)) if (k.startsWith("GIT_TRACE")) delete out[k];
  return out;
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, keepIndex?: boolean, walk?: boolean }} opts
 *   `keepIndex` keeps GIT_INDEX_FILE (only for an index already checked by hookIndexFile). `walk`: the call walks
 *   the history or the whole tree, and gets GIT_LIMITS.walk.
 * @returns {string} stdout without the trailing newline; a failure throws, with git's message as `stderr`
 */
export function git(args, opts) {
  return gitBytes(args, opts).toString("utf8").replace(/\n$/, "");
}

/**
 * git() with stdout as git wrote it: bytes that are not UTF-8 (a file in another encoding, UTF-16) stay
 * as they are, where a string would hold U+FFFD for them. `input` goes to git's stdin.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, keepIndex?: boolean, input?: string | Buffer, walk?: boolean }} opts
 * @returns {Buffer}
 */
export function gitBytes(args, { cwd, env = process.env, keepIndex = false, input, walk = false }) {
  const limit = walk ? GIT_LIMITS.walk : GIT_LIMITS.call;
  try {
    // In Ennyn's process group: GIT_LIMITS says why.
    return execFileSync("git", [...FIXED_CONFIG, ...args], {
      cwd,
      env: cleanEnv(env, keepIndex),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: limit,
      killSignal: "SIGKILL",
      ...(input === undefined ? {} : { input }),
    });
  } catch (err) {
    // A killed git or one that did not start says nothing on stderr: say what happened instead.
    const e = /** @type {Error & { stderr?: string | Buffer, signal?: string | null, code?: string }} */ (err);
    e.stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : e.stderr;
    const name = commandName(args);
    // A stopped git may have said something before it hung: the limit is what ended it. Output past the buffer
    // stops git with SIGTERM: that is no kill from outside.
    if (e.code === "ETIMEDOUT") {
      // git may have exited, with a code that means something, while a process it started held the output.
      const stop = stopped(args, limit);
      Object.assign(e, { message: stop.message, stderr: stop.stderr, status: null });
    } else if (e.code === "ENOBUFS") e.stderr = `git ${name}: its output was larger than 64 MB`;
    else if (!String(e.stderr ?? "").trim()) e.stderr = `git ${name}: ${e.signal ? `killed by ${e.signal}` : e.code === "ENOENT" ? NO_START : e.message}`;
    throw e;
  }
}

/**
 * A git call whose exit code and error text the caller reads itself: git grep exits 1 for "no match"
 * and also when a file cannot be read, and says which on stderr. A call stopped at its limit has `error`
 * (code ETIMEDOUT), whatever its status: git may have exited, with a code that means something, while a process it
 * started held the output. Every reader looks at `error` before the status; gitError's error has no status.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, walk?: boolean }} opts
 * @returns {GitRun}
 * @typedef {{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: Error }} GitRun
 */
export function gitRun(args, { cwd, env = process.env, walk = false }) {
  const limit = walk ? GIT_LIMITS.walk : GIT_LIMITS.call;
  const r = spawnSync("git", [...FIXED_CONFIG, ...args], { cwd, env: cleanEnv(env, false), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: limit, killSignal: "SIGKILL" });
  const error = r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT" ? stopped(args, limit) : r.error;
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(error ? { error } : {}) };
}

/**
 * The error for a git call that failed: git's own message, else how it ended (a signal, no git at all); for
 * a call stopped at its limit, that.
 * @param {string[]} args @param {GitRun} r
 */
export function gitError(args, r) {
  const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
  const how = r.error ? (code === "ENOENT" ? NO_START : r.error.message) : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  if (code === "ETIMEDOUT") return Object.assign(new Error(how), { stderr: how, status: null });
  const said = r.stderr.trim();
  const err = /** @type {Error & { stderr: string, status: number | null }} */ (new Error(`git ${args.join(" ")}: ${said.split("\n")[0] || how}`));
  err.stderr = said || `git ${commandName(args)}: ${how}`;
  err.status = r.status;
  return err;
}

/**
 * A git question whose "nothing there" answer is an exit code: `config --get` and `--get-regexp` exit 1
 * for no such key, `rev-parse --verify -q` 1 for no such revision, `remote get-url` 2 for no such remote,
 * `merge-base --is-ancestor` 1 for "no". null for those codes, stdout otherwise. Any other exit, a signal
 * (a killed git), a git stopped at its limit or one that cannot start throws.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, absent: number[], walk?: boolean }} opts
 * @returns {string | null}
 */
export function gitMaybe(args, { cwd, env = process.env, absent, walk = false }) {
  const r = gitRun(args, { cwd, env, walk });
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
 * How the commit-msg hook reads objects: as they are, and from this machine only. A replace ref (`git replace HEAD
 * <commit>`) would have HEAD's tree read as another commit's, and a line already there not count as added. In a
 * partial clone a missing object would be fetched from the promisor remote, a connection the hook does not make:
 * it is read as missing and said unread instead. git reads GIT_NO_LAZY_FETCH from 2.45 and in the maintenance
 * releases of May 2024 (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1), as do distribution builds that took that
 * fix (Ubuntu 22.04's 2.34.1, Debian 12's 2.39.5); a git without it, 2.44.0 among them, fetches the object.
 */
export const HOOK_READ_ENV = { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };

/**
 * One object's bytes, read by its id: a file whose name git cannot be asked for, or one its diff could not read.
 * Up to git()'s 64 MB buffer; its one caller, commit-check, runs with HOOK_READ_ENV. A git that fails throws.
 * @param {string} cwd @param {string} oid
 * @returns {Buffer}
 */
export function blobBytes(cwd, oid) {
  return gitBytes(["cat-file", "blob", oid], { cwd });
}

/** Why a staged path whose object is not on this machine is not read (stagedChanges' `missing`). */
export const MISSING_OBJECT = "its object is not on this machine (a partial clone), and the hook fetches nothing";

/**
 * The environment of a read of what a commit will hold: the index the hook was given, and the objects as
 * HOOK_READ_ENV reads them.
 * @param {string | null} index
 */
const stagedEnv = (index) => ({ ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}), ...HOOK_READ_ENV });

/**
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts] pass the hook's environment to read the index it was given
 * @returns {string[]}
 */
export function stagedPaths(cwd, opts = {}) {
  return stagedNames(cwd, opts).paths;
}

/**
 * The staged paths, read as bytes: `notUtf8` holds those whose names are not UTF-8, as `paths` spells them
 * (U+FFFD for each byte that is not). Such a name cannot be handed back to git as a pathspec, and it may
 * read the same as another staged name that is UTF-8.
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ paths: string[], notUtf8: string[] }}
 */
export function stagedNames(cwd, { env } = {}) {
  const index = env ? hookIndexFile(cwd, env) : null;
  // Both names of a rename (diff.renames would list only the new one): moving a file out is a change there too.
  const out = gitBytes(["diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd, env: stagedEnv(index), keepIndex: Boolean(index) });
  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  const notUtf8 = [];
  for (let at = 0; at < out.length; ) {
    let end = out.indexOf(0, at);
    if (end === -1) end = out.length;
    const name = out.subarray(at, end);
    at = end + 1;
    if (!name.length) continue;
    paths.push(name.toString("utf8"));
    if (!isUtf8(name)) notUtf8.push(name.toString("utf8"));
  }
  return { paths, notUtf8 };
}

/**
 * A path as git writes it in a diff header: C-quoted when it holds a quote, a backslash or a control
 * character ("a\tb", octal for bytes), else as is.
 * @param {string} s
 */
export function unquotePath(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  /** @type {number[]} */
  const bytes = [];
  const named = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 });
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== "\\") {
      const ch = String.fromCodePoint(/** @type {number} */ (s.codePointAt(i)));
      bytes.push(...Buffer.from(ch, "utf8"));
      i += ch.length - 1;
    } else if (/[0-7]{3}/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(named[s[i + 1]] ?? s.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * `changes` with each path's old size the largest of HEAD's and every merge parent's version (`ls-tree -l`, 500
 * paths a call): a diff against a parent is no faster than its larger side. A tree that cannot be read leaves the
 * sizes as they were; they only shape the calls.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @param {Map<string, StagedChange>} changes @param {string[]} paths @param {string[]} parents
 * @returns {Map<string, StagedChange>}
 */
function withParents(cwd, env, changes, paths, parents) {
  const out = new Map(changes);
  for (const parent of parents) {
    for (let at = 0; at < paths.length; at += 500) {
      let listed = "";
      try {
        listed = gitBytes(["-c", "core.precomposeUnicode=false", "ls-tree", "-r", "-l", "-z", parent, "--", ...paths.slice(at, at + 500)], { cwd, env }).toString("utf8");
      } catch {
        continue;
      }
      for (const entry of listed.split("\0")) {
        const m = /^\d+ blob [0-9a-f]+ +(\d+)\t([^]*)$/.exec(entry);
        if (!m) continue;
        const c = out.get(m[2]);
        const size = Number(m[1]);
        if (!c || size > c.oldSize) out.set(m[2], { ...(c ?? { status: "M", mode: "", oid: "", oldOid: "", newSize: 0, missing: false, oldMissing: false, newMissing: false }), oldSize: size });
      }
    }
  }
  return out;
}

/**
 * The lines a commit adds to `paths` (the staged paths a review.forbidden rule names), numbered as in the new
 * file. Read from the index the hook was given (stagedPaths), with those paths as pathspecs, in the calls diffGroups
 * splits them into by their sizes (stagedChanges; in a merge, every parent's too): only the files a rule reads are
 * diffed, so a large file elsewhere
 * cannot fill git()'s buffer, and a call that fails or is stopped puts its paths, with why, into `unread` and the
 * others are still read (thrown when no `unread` map is given). A path is handed
 * back as git wrote it (core.precomposeUnicode off: macOS git would compose a decomposed name); a name that
 * is not UTF-8 cannot be (stagedNames), and every path asked must show in a header, else it throws and the
 * hook says it did not check. The diff is pinned against the user's config: no color, external diff or
 * textconv, the a/ and b/ prefixes (diff.noprefix and diff.mnemonicPrefix change them), a submodule as its
 * commit line, no renames (a moved file is added in full, as its new name is staged), and every file as
 * text (--text: a NUL byte, a -diff or binary attribute and core.bigFileThreshold would otherwise hide its
 * lines). The diff is read as bytes: a line that holds a NUL or is not UTF-8 keeps them in `raw`. A file whose
 * added lines hold a NUL or start with a byte order mark is read again whole from the index (one cat-file for
 * all of them): when it is text in UTF-16 or UTF-32 (core/encoding.mjs), its decoded lines are added to git's
 * own (`decoded`: the encoding; numbered as an editor numbers them); git's lines stay, so decoding can only add
 * a match. A file past WIDE_LIMIT, or one cat-file could not read, keeps git's lines alone, and its path goes
 * into `wideUnread` with the reason. Objects are read as they are, not as a replace
 * ref has them.
 * In a merge every added line counts: the other side's commits may have run no hook (cherry-pick, rebase,
 * --no-verify, a clone without it). A line a parent named in MERGE_HEAD already holds carries that parent in
 * `from`, for the message only: MERGE_HEAD is a file anyone can write.
 * @param {string} cwd the repository's top
 * @param {string[]} paths
 * @param {{ env?: NodeJS.ProcessEnv, wideUnread?: Map<string, string>, unread?: Map<string, string> }} [opts]
 * @returns {Map<string, AddedLine[]>}
 * @typedef {{ line: number, text: string, from?: string, raw?: Buffer, decoded?: string }} AddedLine `text` is
 *   the line read as UTF-8 (U+FFFD for bytes that are not); `raw`, only for a line that holds a NUL or is not
 *   UTF-8, its bytes; `decoded`: the encoding of a line decoded from UTF-16 or UTF-32, not one of git's
 */
export function stagedAddedLines(cwd, paths, { env, wideUnread = new Map(), unread } = {}) {
  /** @type {Map<string, AddedLine[]>} */
  const out = new Map();
  if (!paths.length) return out;
  const index = env ? hookIndexFile(cwd, env) : null;
  const readEnv = stagedEnv(index);
  const run = (/** @type {string[]} */ against, /** @type {string[]} */ batch) =>
    gitBytes(["-c", "core.quotePath=false", "-c", "core.precomposeUnicode=false", "diff", "--cached", ...against, "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "--full-index", "-U0", "--src-prefix=a/", "--dst-prefix=b/", "--", ...batch], {
      cwd,
      env: readEnv,
      keepIndex: Boolean(index),
    });
  const parents = mergeHeads(cwd);
  // The sizes only shape the calls: unread, every file counts as small (500 a call), and a call that fails still
  // costs only its own files.
  /** @type {Map<string, StagedChange>} */
  let changes = new Map();
  try {
    changes = stagedChanges(cwd, { env });
  } catch {
    // Sizes unknown.
  }
  const unique = [...new Set(paths)];
  const absent = unique.filter((p) => changes.get(p)?.missing);
  if (absent.length && !unread) throw new Error(`${absent.length} staged path(s) ${MISSING_OBJECT}: ${absent.slice(0, 3).map((p) => JSON.stringify(p)).join(", ")}`);
  for (const p of absent) unread?.set(p, MISSING_OBJECT);
  const asked = unique.filter((p) => !changes.get(p)?.missing);
  /** @type {{ path: string, oid: string, lines: AddedLine[] }[]} */
  const candidates = [];
  for (const batch of diffGroups(asked, parents.length ? withParents(cwd, readEnv, changes, asked, parents) : changes)) {
    /** @type {Map<string, string>} */
    const blobs = new Map();
    let mine;
    try {
      mine = addedLines(run([], batch), new Set(batch), { complete: true, blobs });
    } catch (e) {
      if (!unread) throw e;
      const why = String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];
      for (const p of batch) unread.set(p, why);
      continue;
    }
    for (const parent of parents) {
      /** @type {Map<string, AddedLine[]>} */
      let theirs;
      try {
        theirs = addedLines(run([parent], batch), null);
      } catch (e) {
        // `from` is for the message only: with the parent's diff unread the lines count as this commit's own.
        if (!unread) throw e;
        continue;
      }
      for (const [path, lines] of mine) {
        const added = new Set((theirs.get(path) ?? []).map((l) => l.line));
        for (const l of lines) if (!added.has(l.line)) l.from ??= parent;
      }
    }
    for (const [path, lines] of mine) {
      out.set(path, lines);
      const oid = blobs.get(path);
      if (oid && lines.some((l) => l.raw && (l.raw.includes(0) || (l.line === 1 && startsWithMark(l.raw))))) candidates.push({ path, oid, lines });
    }
  }
  readWide(cwd, readEnv, candidates, out, wideUnread);
  return out;
}

/**
 * `cat-file --batch-check` of `oids`, a line each: "<oid> <type> <size>", or "<oid> missing" for one this machine
 * does not hold. Under GIT_NO_LAZY_FETCH git 2.45 and later say "missing" of an object a partial clone lacks; the
 * maintenance releases of May 2024 and the builds that took them (Debian 12's 2.39.5, measured in cycle 13) die at
 * it instead ("could not fetch <oid> from promisor remote"): the lines before it stand, that one is missing, and
 * what is left after it is asked again, so a call for each such object at most. Any other failure throws.
 * @param {string} cwd @param {string[]} oids @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string[]}
 */
export function batchCheck(cwd, oids, { env } = {}) {
  /** @type {string[]} */
  const lines = [];
  let left = oids;
  while (left.length) {
    try {
      lines.push(...gitBytes(["cat-file", "--batch-check"], { cwd, env, input: left.join("\n") + "\n" }).toString("utf8").split("\n").filter(Boolean));
      return lines;
    } catch (err) {
      const e = /** @type {Error & { stdout?: Buffer | string, stderr?: string, status?: number | null }} */ (err);
      const lost = /could not fetch ([0-9a-f]{40,64}) from promisor remote/.exec(String(e.stderr ?? ""))?.[1];
      const said = String(e.stdout ?? "").split("\n").filter(Boolean);
      // Each line answers the next object asked; the one git died at is the one after them.
      if (e.status !== 128 || !lost || left[said.length] !== lost) throw err;
      lines.push(...said, `${lost} missing`);
      left = left.slice(said.length + 1);
    }
  }
  return lines;
}

/** What the secret scan reads of one commit's added lines, in bytes: a bound on the hook's time, whatever the commit holds. */
export const READ_BUDGET = 64 * 1024 * 1024;

/**
 * The staged changes as one `diff --raw` lists them, with no pathspec (one walk of the index, whatever the
 * count): per path its status letter (A added, M, T, D deleted…), new mode, and old and new sizes from one
 * `cat-file --batch-check`, and both object ids (`oid`, `oldOid`). A submodule's commit is no object this repository
 * holds: its ids are "" and its sizes 0, on either side. `oldMissing` / `newMissing`: that side's object is not on
 * this machine (a partial clone; HOOK_READ_ENV fetches nothing), and `missing` either. Names read as bytes, as
 * stagedNames reads them, from the index the hook was given. A git that fails throws.
 * @param {string} cwd @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, StagedChange>}
 * @typedef {{ status: string, mode: string, oid: string, oldOid: string, oldSize: number, newSize: number, missing: boolean, oldMissing: boolean, newMissing: boolean }} StagedChange
 */
export function stagedChanges(cwd, { env } = {}) {
  const index = env ? hookIndexFile(cwd, env) : null;
  const readEnv = stagedEnv(index);
  const out = gitBytes(["-c", "core.precomposeUnicode=false", "diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"], { cwd, env: readEnv, keepIndex: Boolean(index) });
  /** @type {{ path: string, status: string, mode: string, old: string, new: string }[]} */
  const entries = [];
  for (let at = 0; at < out.length; ) {
    const meta = out.indexOf(0, at);
    if (meta === -1) break;
    const end = out.indexOf(0, meta + 1);
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(out.toString("utf8", at, meta));
    const path = out.toString("utf8", meta + 1, end === -1 ? out.length : end);
    at = end === -1 ? out.length : end + 1;
    if (m) entries.push({ path, status: m[5], mode: m[2], old: m[1] === "160000" ? "" : m[3], new: m[2] === "160000" ? "" : m[4] });
  }
  const oids = [...new Set(entries.flatMap((e) => [e.old, e.new]).filter((o) => o && !/^0+$/.test(o)))];
  /** @type {Map<string, number>} */
  const sizes = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  if (oids.length) {
    for (const l of batchCheck(cwd, oids, { env: readEnv })) {
      const m = /^([0-9a-f]+) (?:\w+ (\d+)|(missing))$/.exec(l);
      if (m?.[3]) missing.add(m[1]);
      else if (m) sizes.set(m[1], Number(m[2]));
    }
  }
  return new Map(
    entries.map((e) => {
      const oldMissing = missing.has(e.old);
      const newMissing = missing.has(e.new);
      return [e.path, { status: e.status, mode: e.mode, oid: e.new, oldOid: e.old, oldSize: sizes.get(e.old) ?? 0, newSize: sizes.get(e.new) ?? 0, missing: oldMissing || newMissing, oldMissing, newMissing }];
    }),
  );
}

/**
 * Files the commit adds, streamed whole from one `cat-file --batch`: `onLine(path, number, bytes)` for each line
 * (split at every newline byte, as git's diff splits them, numbered from 1). A new file's lines are all added,
 * and git's diff would hold every one of them in memory to compare with nothing. Rejects as streamStagedDiff.
 * @param {string} cwd @param {{ path: string, oid: string }[]} files
 * @param {{ env?: NodeJS.ProcessEnv, onLine: (path: string, line: number, bytes: Buffer) => void }} opts
 * @returns {Promise<void>}
 */
export function streamStagedBlobs(cwd, files, { env, onLine }) {
  const index = env ? hookIndexFile(cwd, env) : null;
  return new Promise((done, fail) => {
    if (!files.length) return done();
    const child = spawn("git", [...FIXED_CONFIG, "cat-file", "--batch"], { cwd, env: cleanEnv(stagedEnv(index), Boolean(index)), stdio: ["pipe", "pipe", "pipe"] });
    stopWhenSilent(child, "cat-file", fail);
    let k = 0;
    /** Bytes of the current blob still to come; -1 while a header is awaited. */
    let left = -1;
    let n = 1;
    /** @type {Buffer[]} */
    let carry = [];
    let stderr = "";
    let bad = "";
    const line = (/** @type {Buffer} */ bytes) => onLine(files[k].path, n++, bytes);
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      let at = 0;
      while (at < chunk.length && !bad) {
        if (left === -1) {
          const eol = chunk.indexOf(0x0a, at);
          if (eol === -1) return void carry.push(chunk.subarray(at));
          const head = Buffer.concat([...carry, chunk.subarray(at, eol)]).toString("utf8");
          carry = [];
          at = eol + 1;
          const m = /^([0-9a-f]+) blob (\d+)$/.exec(head);
          if (!m || m[1] !== files[k]?.oid) {
            bad = `cat-file wrote something other than the blob: ${JSON.stringify(head.slice(0, 80))}`;
            child.kill("SIGTERM");
            return;
          }
          left = Number(m[2]);
          n = 1;
          continue;
        }
        // Inside a blob: its lines, then the newline cat-file puts after it.
        const end = Math.min(chunk.length, at + left);
        for (let eol = chunk.indexOf(0x0a, at); eol !== -1 && eol < end; eol = chunk.indexOf(0x0a, at)) {
          line(carry.length ? Buffer.concat([...carry, chunk.subarray(at, eol)]) : chunk.subarray(at, eol));
          carry = [];
          left -= eol + 1 - at;
          at = eol + 1;
        }
        if (at < end) carry.push(chunk.subarray(at, end)), (left -= end - at), (at = end);
        if (left === 0 && at < chunk.length) {
          // The blob's end; a last line with no newline is a line too.
          if (carry.length) line(Buffer.concat(carry)), (carry = []);
          at++;
          k++;
          left = -1;
        }
      }
    });
    child.stderr.on("data", (/** @type {Buffer} */ c) => {
      if (stderr.length < 65536) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      const err = /** @type {Error & { stderr?: string }} */ (e);
      err.stderr = `git cat-file: ${/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? NO_START : e.message}`;
      fail(err);
    });
    child.on("close", (code, signal) => {
      if (bad || code !== 0 || k < files.length) {
        const why = bad || stderr.trim().split("\n")[0] || (signal ? `killed by ${signal}` : code !== 0 ? `exit ${code}` : `${files.length - k} blob(s) not written`);
        const err = /** @type {Error & { stderr?: string }} */ (new Error(`git cat-file: ${why}`));
        err.stderr = `git cat-file: ${why}`;
        return fail(err);
      }
      done();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(files.map((f) => f.oid).join("\n") + "\n");
  });
}

/**
 * The staged -U0 diff streamed: `onLine(path, number, bytes)` for each added line as git writes it, numbered as
 * in the new file, nothing kept, so memory is a line's and time the lines'. The diff is pinned as
 * stagedAddedLines pins it (--text, no textconv, external diff, color or renames, a/ and b/ prefixes).
 * `paths`: pathspecs, or null for every staged path (one walk of the index). `against`: a revision to diff
 * against instead of HEAD. `onLine` returning false stops git, and the stream ends as read so far
 * (`stopped`). Resolves with the paths a header named; a git that fails, is killed or does not start rejects,
 * with git's message as `stderr`, and so does one that writes nothing for GIT_LIMITS.call.
 * @param {string} cwd @param {string[] | null} paths
 * @param {{ env?: NodeJS.ProcessEnv, against?: string[], onLine: (path: string, line: number, bytes: Buffer) => boolean | void }} opts
 * @returns {Promise<{ shown: Set<string>, stopped: boolean }>}
 */
export function streamStagedDiff(cwd, paths, { env, against = [], onLine }) {
  const index = env ? hookIndexFile(cwd, env) : null;
  const args = [...FIXED_CONFIG, "-c", "core.quotePath=false", "-c", "core.precomposeUnicode=false", "diff", "--cached", ...against, "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "-U0", "--src-prefix=a/", "--dst-prefix=b/", ...(paths ? ["--", ...paths] : [])];
  return new Promise((done, fail) => {
    const child = spawn("git", args, { cwd, env: cleanEnv(stagedEnv(index), Boolean(index)), stdio: ["ignore", "pipe", "pipe"] });
    const silent = stopWhenSilent(child, "diff", fail);
    /** @type {Set<string>} */
    const shown = new Set();
    /** @type {string | null} */
    let file = null;
    let header = false;
    let n = 0;
    let stopped = false;
    /** @type {Buffer[]} */
    let carry = [];
    let stderr = "";
    const line = (/** @type {Buffer} */ bytes) => {
      if (stopped) return;
      if (bytes[0] === 0x2b && !header) {
        if (file !== null && onLine(file, n, bytes.subarray(1)) === false) {
          stopped = true;
          child.kill("SIGTERM");
        }
        n++;
        return;
      }
      const raw = bytes.toString("utf8");
      if (raw.startsWith("diff --git ")) {
        file = null;
        header = true;
        const path = headerPath(raw.slice(11));
        if (path !== null) shown.add(path);
      } else if (header && raw.startsWith("+++ ")) {
        const name = raw.slice(4).replace(/\t$/, "");
        if (name !== "/dev/null") file = unquotePath(name).replace(/^b\//, "");
      } else if (raw.startsWith("@@ ")) {
        header = false;
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (m) n = Number(m[1]);
      }
    };
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      let at = 0;
      for (let end = chunk.indexOf(0x0a); end !== -1 && !stopped; end = chunk.indexOf(0x0a, at)) {
        line(carry.length ? Buffer.concat([...carry, chunk.subarray(at, end)]) : chunk.subarray(at, end));
        carry = [];
        at = end + 1;
      }
      if (!stopped && at < chunk.length) carry.push(chunk.subarray(at));
    });
    child.stderr.on("data", (/** @type {Buffer} */ c) => {
      if (stderr.length < 65536) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      const err = /** @type {Error & { stderr?: string }} */ (e);
      err.stderr = `git diff: ${/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? NO_START : e.message}`;
      fail(err);
    });
    child.on("close", (code, signal) => {
      if (silent.stopped) return;
      if (stopped) return done({ shown, stopped });
      if (code !== 0) {
        const err = /** @type {Error & { stderr?: string }} */ (new Error(`git diff: ${stderr.trim().split("\n")[0] || (signal ? `killed by ${signal}` : `exit ${code}`)}`));
        err.stderr = stderr.trim() || `git diff: ${signal ? `killed by ${signal}` : `exit ${code}`}`;
        return fail(err);
      }
      if (carry.length) line(Buffer.concat(carry));
      done({ shown, stopped });
    });
  });
}

/**
 * Staged files read whole from the index the hook was given, up to `limit` bytes each and `total` in all: their
 * object ids from `ls-files -s` (stage 0), sizes from one `cat-file --batch-check`, bytes from `cat-file
 * --batch`. A path the index does not hold is in neither map; one past a limit, or one cat-file could not
 * read, is in `unread` with why. A git that fails throws.
 * @param {string} cwd @param {string[]} paths
 * @param {{ env?: NodeJS.ProcessEnv, limit?: number, total?: number }} [opts]
 * @returns {{ blobs: Map<string, Buffer>, unread: Map<string, string> }}
 */
export function stagedBlobs(cwd, paths, { env, limit = WIDE_LIMIT, total = READ_BUDGET } = {}) {
  const index = env ? hookIndexFile(cwd, env) : null;
  const readEnv = stagedEnv(index);
  /** @type {Map<string, string>} */
  const oids = new Map();
  const unique = [...new Set(paths)];
  for (let at = 0; at < unique.length; at += 500) {
    const out = gitBytes(["-c", "core.precomposeUnicode=false", "ls-files", "-s", "-z", "--", ...unique.slice(at, at + 500)], { cwd, env: readEnv, keepIndex: Boolean(index) }).toString("utf8");
    for (const e of out.split("\0")) {
      const m = /^\d+ ([0-9a-f]+) 0\t([^]*)$/.exec(e);
      if (m) oids.set(m[2], m[1]);
    }
  }
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  /** @type {Map<string, string>} */
  const unread = new Map();
  const want = [...oids].filter(([path]) => unique.includes(path));
  if (!want.length) return { blobs, unread };
  /** @type {Map<string, number>} */
  const sizes = new Map();
  for (const l of batchCheck(cwd, want.map(([, oid]) => oid), { env: readEnv })) {
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(l);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  let left = total;
  const read = want.filter(([path, oid]) => {
    const size = sizes.get(oid);
    if (size === undefined) unread.set(path, `${oid} is not a blob git can read`);
    else if (size > limit) unread.set(path, `past ${limit / 1024 / 1024} MB`);
    else if (size > left) unread.set(path, `past the ${total / 1024 / 1024} MB read in all`);
    else return (left -= size), true;
    return false;
  });
  if (!read.length) return { blobs, unread };
  const bytes = gitBytes(["cat-file", "--batch"], { cwd, env: readEnv, input: read.map(([, oid]) => oid).join("\n") + "\n" });
  // "<oid> blob <size>\n<bytes>\n" for each, in the order asked; past a header that does not parse, none is read.
  let at = 0;
  for (const [k, [path, oid]] of read.entries()) {
    const eol = bytes.indexOf(0x0a, at);
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(bytes.toString("utf8", at, eol === -1 ? bytes.length : eol));
    if (!m || m[1] !== oid) {
      for (const [rest] of read.slice(k)) unread.set(rest, "cat-file wrote something other than the blob");
      break;
    }
    blobs.set(path, bytes.subarray(eol + 1, eol + 1 + Number(m[2])));
    at = eol + 1 + Number(m[2]) + 1;
  }
  return { blobs, unread };
}

/**
 * A settings file as HEAD holds it: `{ text }` for a regular file of at most `limit` bytes; `{ kind }` for what
 * is no such file: `link` when it, or a directory on its way, is a symbolic link (clones reach a file through
 * it, which is not read here), `other` for a submodule or a directory, `large` past `limit`; null with no commit
 * yet or nothing there. Objects as HOOK_READ_ENV reads them. A git that fails throws.
 * @param {string} cwd @param {string} path "/"-separated, from the repository's top @param {number} limit
 * @returns {{ text: string } | { kind: "link" | "other" | "large" } | null}
 */
export function headFile(cwd, path, limit) {
  if (!headCommit(cwd)) return null;
  const env = { ...process.env, ...HOOK_READ_ENV };
  const parts = path.split("/");
  const specs = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  /** @type {Map<string, { mode: string, oid: string, size: string }>} */
  const entries = new Map();
  const out = gitBytes(["-c", "core.precomposeUnicode=false", "ls-tree", "-l", "-z", "HEAD", "--", ...specs], { cwd, env }).toString("utf8");
  for (const entry of out.split("\0")) {
    const m = /^(\d+) \w+ ([0-9a-f]+) +(\S+)\t(.*)$/s.exec(entry);
    if (m) entries.set(m[4], { mode: m[1], oid: m[2], size: m[3] });
  }
  for (const spec of specs.slice(0, -1)) {
    const on = entries.get(spec);
    if (on) return { kind: on.mode === "120000" ? "link" : "other" };
  }
  const file = entries.get(path);
  if (!file) return null;
  if (file.mode === "120000") return { kind: "link" };
  if (file.mode !== "100644" && file.mode !== "100755") return { kind: "other" };
  if (Number(file.size) > limit) return { kind: "large" };
  return { text: gitBytes(["cat-file", "blob", file.oid], { cwd, env }).toString("utf8") };
}

/**
 * A file as HEAD's tree holds it, or null with no commit yet or no such file there; objects as HOOK_READ_ENV reads
 * them. A git that fails throws.
 * @param {string} cwd @param {string} path
 * @returns {Buffer | null}
 */
export function headBlob(cwd, path) {
  if (!headCommit(cwd)) return null;
  const env = { ...process.env, ...HOOK_READ_ENV };
  const entry = gitBytes(["-c", "core.precomposeUnicode=false", "ls-tree", "-z", "HEAD", "--", path], { cwd, env }).toString("utf8").split("\0")[0];
  const m = /^\d+ blob ([0-9a-f]+)\t/.exec(entry ?? "");
  return m ? gitBytes(["cat-file", "blob", m[1]], { cwd, env }) : null;
}

/**
 * Adds the decoded lines of the candidates that are UTF-16 or UTF-32 text: their sizes from one
 * `cat-file --batch-check`, their bytes from `cat-file --batch`, as few calls as git()'s buffer allows.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @param {{ path: string, oid: string, lines: AddedLine[] }[]} candidates
 * @param {Map<string, AddedLine[]>} out @param {Map<string, string>} wideUnread
 */
function readWide(cwd, env, candidates, out, wideUnread) {
  if (!candidates.length) return;
  // Whatever git's lines look like: a line edited in a large UTF-16 file may look like neither UTF-16 nor 8-bit
  // text. The scan says it for the texts a search of git's lines cannot find.
  const unread = (/** @type {{ path: string }} */ c, /** @type {string} */ reason) => wideUnread.set(c.path, reason);
  const oneLine = (/** @type {unknown} */ e) => String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];
  /** @type {Map<string, number>} */
  const sizes = new Map();
  try {
    const listed = batchCheck(cwd, candidates.map((c) => c.oid), { env });
    for (const l of listed) {
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(l);
      if (m) sizes.set(m[1], Number(m[2]));
    }
  } catch (e) {
    for (const c of candidates) unread(c, oneLine(e));
    return;
  }
  /** @type {{ path: string, oid: string, lines: AddedLine[] }[][]} */
  const calls = [[]];
  let total = 0;
  for (const c of candidates) {
    const size = sizes.get(c.oid);
    if (size === undefined) unread(c, `${c.oid} is not a blob git can read`);
    else if (size > WIDE_LIMIT) unread(c, `past ${WIDE_LIMIT / 1024 / 1024} MB`);
    else {
      if (total + size > 3 * WIDE_LIMIT) calls.push([]), (total = 0);
      /** @type {{ path: string, oid: string, lines: AddedLine[] }[]} */ (calls.at(-1)).push(c);
      total += size;
    }
  }
  for (const call of calls.filter((c) => c.length)) {
    let bytes;
    try {
      bytes = gitBytes(["cat-file", "--batch"], { cwd, env, input: call.map((c) => c.oid).join("\n") + "\n" });
    } catch (e) {
      for (const c of call) unread(c, oneLine(e));
      continue;
    }
    // "<oid> blob <size>\n<bytes>\n" for each, in the order asked; past a header that does not parse, none is read.
    let at = 0;
    for (const [k, c] of call.entries()) {
      const eol = bytes.indexOf(0x0a, at);
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(bytes.toString("utf8", at, eol === -1 ? bytes.length : eol));
      if (!m || m[1] !== c.oid) {
        for (const rest of call.slice(k)) unread(rest, "cat-file wrote something other than the blob");
        break;
      }
      const blob = bytes.subarray(eol + 1, eol + 1 + Number(m[2]));
      at = eol + 1 + Number(m[2]) + 1;
      const wide = wideEncoding(blob);
      if (wide) out.set(c.path, [...c.lines, ...wideLines(blob, wide, c.lines).map((l) => ({ ...l, decoded: wide.encoding }))]);
    }
  }
}

/**
 * The other parents of a merge being committed: the hashes in MERGE_HEAD, one a line (more for an octopus);
 * none outside a merge.
 * @param {string} cwd
 * @returns {string[]}
 */
export function mergeHeads(cwd) {
  const path = git(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd });
  const text = readIfThere(resolve(cwd, path));
  if (text === null) return [];
  const heads = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!heads.every((h) => /^[0-9a-f]{40,64}$/.test(h))) throw new Error(`${path} holds something that is not a commit hash`);
  return heads;
}

/**
 * The names the index holds (the one a hook was given) under `paths` (literal pathspecs; a directory names what is
 * in it), read as bytes: `notUtf8` as in stagedNames.
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, paths: string[] }} opts
 * @returns {{ paths: string[], notUtf8: string[] }}
 */
export function indexNames(cwd, { env, paths: under }) {
  const index = env ? hookIndexFile(cwd, env) : null;
  const out = gitBytes(["-c", "core.precomposeUnicode=false", "ls-files", "-z", "--", ...under], { cwd, env: stagedEnv(index), keepIndex: Boolean(index) });
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {string[]} */
  const notUtf8 = [];
  for (const name of splitNul(out)) {
    const text = name.toString("utf8");
    // An unmerged path is listed once per stage.
    if (paths.has(text)) continue;
    paths.add(text);
    if (!isUtf8(name)) notUtf8.push(text);
  }
  return { paths: [...paths], notUtf8 };
}

/**
 * What the index holds at each repository path: `symlink` (with the link's index name, its target as the blob
 * holds it, and the rest of the path past it) or `submodule` when one is the path or a directory on its way, else
 * `tracked` when an entry is the path or under it, else `absent`. Names are compared composed (NFC), and every
 * path and directory is asked as given, composed and decomposed (macOS hands npm decomposed names, the index
 * holds what git stored). `ls-files -s` with literal pathspecs, 500 a call; the links' targets from one
 * `cat-file --batch`; from the index a hook was given.
 * @param {string} cwd @param {string[]} paths repository paths, `/`-separated
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, { kind: "tracked" | "absent" | "symlink" | "submodule", link?: string, target?: string | null, rest?: string }>}
 */
export function indexKinds(cwd, paths, { env } = {}) {
  const nfc = (/** @type {string} */ x) => x.normalize("NFC");
  /** @type {Set<string>} */
  const asked = new Set();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) for (const form of ["NFC", "NFD"]) asked.add(parts.slice(0, i).join("/").normalize(form)), asked.add(parts.slice(0, i).join("/"));
  }
  /** @type {Map<string, { mode: string, sha: string, name: string }>} */
  const entries = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  const index = env ? hookIndexFile(cwd, env) : null;
  const opts = { cwd, env: stagedEnv(index), keepIndex: Boolean(index) };
  const list = [...asked];
  for (let at = 0; at < list.length; at += 500) {
    for (const record of splitNul(gitBytes(["-c", "core.precomposeUnicode=false", "ls-files", "-s", "-z", "--", ...list.slice(at, at + 500)], opts))) {
      const text = record.toString("utf8");
      const tab = text.indexOf("\t");
      const [mode, sha] = text.slice(0, tab).split(" ");
      const name = text.slice(tab + 1);
      entries.set(nfc(name), { mode, sha, name });
      for (let i = nfc(name).indexOf("/"); i !== -1; i = nfc(name).indexOf("/", i + 1)) dirs.add(nfc(name).slice(0, i));
    }
  }
  const shas = [...new Set([...entries.values()].filter((e) => e.mode === "120000").map((e) => e.sha))];
  /** @type {Map<string, string | null>} */
  const targets = new Map();
  if (shas.length) {
    const out = gitBytes(["cat-file", "--batch"], { ...opts, input: `${shas.join("\n")}\n` });
    for (let at = 0, i = 0; i < shas.length && at < out.length; i++) {
      const nl = out.indexOf(10, at);
      const size = Number(out.subarray(at, nl).toString("latin1").split(" ")[2]);
      targets.set(shas[i], Number.isSafeInteger(size) ? out.subarray(nl + 1, nl + 1 + size).toString("utf8") : null);
      at = Number.isSafeInteger(size) ? nl + 1 + size + 1 : nl + 1;
    }
  }
  /** @type {Map<string, { kind: "tracked" | "absent" | "symlink" | "submodule", link?: string, target?: string | null, rest?: string }>} */
  const kinds = new Map();
  for (const p of paths) {
    const parts = nfc(p).split("/").filter(Boolean);
    /** @type {{ kind: "tracked" | "absent" | "symlink" | "submodule", link?: string, target?: string | null, rest?: string }} */
    let kind = { kind: parts.length === 0 || entries.has(parts.join("/")) || dirs.has(parts.join("/")) ? "tracked" : "absent" };
    for (let i = 1; i <= parts.length; i++) {
      const e = entries.get(parts.slice(0, i).join("/"));
      if (e?.mode === "120000") {
        kind = { kind: "symlink", link: e.name, target: targets.get(e.sha) ?? null, rest: parts.slice(i).join("/") };
        break;
      }
      if (e?.mode === "160000") {
        kind = { kind: "submodule" };
        break;
      }
    }
    kinds.set(p, kind);
  }
  return kinds;
}

/**
 * Every name the index holds, once, with its symbolic links and its gitlinks (submodules), by mode: one
 * `ls-files -s`. No blob is read, so no link is followed and no object is fetched; a name a conflict holds at
 * several stages is a link when any stage is one.
 * @param {string} cwd
 * @returns {{ files: string[], links: string[], gitlinks: string[] }}
 */
export function indexEntries(cwd) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Set<string>} */
  const links = new Set();
  /** @type {Set<string>} */
  const gitlinks = new Set();
  for (const record of splitNul(gitBytes(["ls-files", "-s", "-z"], { cwd }))) {
    const text = record.toString("utf8");
    const tab = text.indexOf("\t");
    const mode = text.slice(0, text.indexOf(" "));
    const name = text.slice(tab + 1);
    files.add(name);
    if (mode === "120000") links.add(name);
    else if (mode === "160000") gitlinks.add(name);
  }
  return { files: [...files], links: [...links], gitlinks: [...gitlinks] };
}

/** @param {Buffer} out */
function splitNul(out) {
  /** @type {Buffer[]} */
  const names = [];
  for (let at = 0; at < out.length; ) {
    let end = out.indexOf(0, at);
    if (end === -1) end = out.length;
    if (end > at) names.push(out.subarray(at, end));
    at = end + 1;
  }
  return names;
}

/**
 * Both versions of staged files, for checks that judge a file whole (a workflow's triggers and permissions, a
 * lock file): `staged` from the index the hook was given (null: not there, a file the commit deletes), `head`
 * from HEAD (null: new, or no commit yet). In a merge HEAD is the first parent, so what the other side brings is
 * new; with --amend HEAD is the commit amended. Read as bytes, objects as they are (no replace refs),
 * `core.precomposeUnicode` off, 500 paths a listing and at most 3 × WIDE_LIMIT a cat-file call. What cannot be read is said per side, as a code: `unread` for
 * the index side (`symlink`, `submodule`, `large` past WIDE_LIMIT, `notBlob`, `unmerged`: a conflict not
 * resolved), `headUnread` for HEAD's (its `head` is then null). Names are handed to git as written: one that is
 * not UTF-8 cannot be (stagedNames), and the caller says so.
 * @param {string} cwd the repository's top
 * @param {string[]} paths
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, StagedVersion>}
 * @typedef {{ staged: Buffer | null, head: Buffer | null, unread?: Unread, headUnread?: Unread }} StagedVersion
 * @typedef {"symlink" | "submodule" | "large" | "notBlob" | "unmerged"} Unread
 */
export function stagedVersions(cwd, paths, { env } = {}) {
  /** @type {Map<string, StagedVersion>} */
  const out = new Map();
  const unique = [...new Set(paths)];
  if (!unique.length) return out;
  const index = env ? hookIndexFile(cwd, env) : null;
  const readEnv = stagedEnv(index);
  const head = headCommit(cwd);
  /** @type {{ path: string, side: "staged" | "head", oid: string }[]} */
  const wanted = [];
  for (const path of unique) out.set(path, { staged: null, head: null });
  const mark = (/** @type {StagedVersion} */ item, /** @type {"staged" | "head"} */ side, /** @type {Unread} */ why) => {
    if (side === "staged") item.unread = why;
    else item.headUnread = why;
  };
  // "<mode> <oid> <stage>\t<path>" from the index, "<mode> <type> <oid>\t<path>" from HEAD's tree.
  const entries = (/** @type {Buffer} */ bytes, /** @type {RegExp} */ re, /** @type {"staged" | "head"} */ side) => {
    for (const rec of splitNul(bytes).map((b) => b.toString("utf8"))) {
      const tab = rec.indexOf("\t");
      const m = re.exec(rec.slice(0, tab));
      const path = rec.slice(tab + 1);
      const item = out.get(path);
      // A file in HEAD's tree under a staged path that was a directory there: not this file's old version.
      if (!item && unique.some((p) => path.startsWith(`${p}/`))) continue;
      if (tab === -1 || !m || !item) throw new Error(`git listed "${path}", which was not asked for, or a line that does not parse`);
      const [mode, oid, stage] = [m[1], m[2], m[3]];
      if (stage && stage !== "0") mark(item, side, "unmerged");
      else if (mode === "120000") mark(item, side, "symlink");
      else if (mode === "160000") mark(item, side, "submodule");
      else wanted.push({ path, side, oid });
    }
  };
  for (let at = 0; at < unique.length; at += 500) {
    const batch = unique.slice(at, at + 500);
    // A decomposed name is asked for and listed as git wrote it (macOS git would compose it).
    const asIs = ["-c", "core.precomposeUnicode=false"];
    entries(gitBytes([...asIs, "ls-files", "-s", "-z", "--", ...batch], { cwd, env: readEnv, keepIndex: Boolean(index) }), /^(\d{6}) ([0-9a-f]{40,64}) (\d)$/, "staged");
    if (head) entries(gitBytes([...asIs, "ls-tree", "-r", "-z", "--full-tree", head, "--", ...batch], { cwd, env: readEnv }), /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})()$/, "head");
  }
  // An unmerged path has no one staged version.
  const read = wanted.filter((w) => !(w.side === "staged" && out.get(w.path)?.unread === "unmerged"));
  const sizes = new Map(
    batchCheck(cwd, read.map((w) => w.oid), { env: readEnv })
      .map((l) => /^([0-9a-f]+) blob (\d+)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => [/** @type {RegExpExecArray} */ (m)[1], Number(/** @type {RegExpExecArray} */ (m)[2])]),
  );
  const readable = read.filter((w) => {
    const size = sizes.get(w.oid);
    const item = /** @type {StagedVersion} */ (out.get(w.path));
    if (size === undefined) mark(item, w.side, "notBlob");
    else if (size > WIDE_LIMIT) mark(item, w.side, "large");
    return size !== undefined && size <= WIDE_LIMIT;
  });
  // As few cat-file calls as git()'s buffer allows: each reads at most 3 × WIDE_LIMIT, whatever the files add up to.
  /** @type {(typeof readable)[]} */
  const calls = [[]];
  let total = 0;
  for (const w of readable) {
    const size = /** @type {number} */ (sizes.get(w.oid));
    if (total + size > 3 * WIDE_LIMIT) calls.push([]), (total = 0);
    /** @type {typeof readable} */ (calls.at(-1)).push(w);
    total += size;
  }
  for (const call of calls.filter((c) => c.length)) {
    const bytes = gitBytes(["cat-file", "--batch"], { cwd, env: readEnv, input: call.map((w) => w.oid).join("\n") + "\n" });
    // "<oid> blob <size>\n<bytes>\n" for each, in the order asked.
    let at = 0;
    for (const w of call) {
      const eol = bytes.indexOf(0x0a, at);
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(bytes.toString("utf8", at, eol === -1 ? bytes.length : eol));
      if (!m || m[1] !== w.oid) throw new Error("git cat-file wrote something other than the blob asked for");
      /** @type {any} */ (out.get(w.path))[w.side] = bytes.subarray(eol + 1, eol + 1 + Number(m[2]));
      at = eol + 1 + Number(m[2]) + 1;
    }
  }
  return out;
}

/**
 * The name in a `diff --git a/<p> b/<p>` line, with no renames both the same: quoted when git quoted it.
 * @param {string} rest the line after "diff --git "
 * @returns {string | null}
 */
function headerPath(rest) {
  if (rest.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    return end ? unquotePath(end[0]).replace(/^a\//, "") : null;
  }
  const n = (rest.length - 5) / 2;
  const p = rest.slice(2, 2 + n);
  return Number.isInteger(n) && rest === `a/${p} b/${p}` ? p : null;
}

/**
 * The added lines of a `-U0` diff with a/ and b/ prefixes, per file. With `asked`, a header that names a path
 * not in it throws, and with `complete` so does a path in it that no header names: a misread diff is no
 * answer. A hunk header that does not parse throws. Given as bytes (git's own output), a line is split where
 * git splits it, at a newline byte, and keeps its bytes in `raw` when they are not plain UTF-8 text.
 * `blobs`, when given, gets each file's new object id from its `index` line (a `--full-index` diff).
 * @param {string | Buffer} diff
 * @param {Set<string> | null} asked
 * @param {{ complete?: boolean, blobs?: Map<string, string> }} [opts]
 * @returns {Map<string, AddedLine[]>}
 */
export function addedLines(diff, asked, { complete = false, blobs } = {}) {
  const bytes = typeof diff === "string" ? Buffer.from(diff, "utf8") : diff;
  /** @type {Map<string, AddedLine[]>} */
  const out = new Map();
  /** @type {Set<string>} */
  const shown = new Set();
  /** @type {string | null} */
  let file = null;
  /** @type {AddedLine[] | null} */
  let lines = null;
  let header = false;
  /** The path of the header being read, for its `index` line. */
  let named = "";
  let n = 0;
  for (let start = 0; start <= bytes.length; ) {
    let end = bytes.indexOf(0x0a, start);
    if (end === -1) end = bytes.length;
    const at = start;
    start = end + 1;
    // A plus sign starts an added line; the rest is read as text only when it is a header.
    if (bytes[at] === 0x2b && !header) {
      if (file !== null) {
        if (!lines) out.set(file, (lines = []));
        const body = bytes.subarray(at + 1, end);
        /** @type {AddedLine} */
        const l = { line: n, text: body.toString("utf8") };
        if (body.includes(0) || !isUtf8(body)) l.raw = Buffer.from(body);
        lines.push(l);
      }
      n++;
      continue;
    }
    const raw = bytes.toString("utf8", at, end);
    if (raw.startsWith("diff --git ")) {
      file = null;
      lines = null;
      header = true;
      const path = headerPath(raw.slice(11));
      if (path === null || (asked && !asked.has(path))) throw new Error(`git diff named a path it was not asked for: ${JSON.stringify(raw.slice(11, 200))}`);
      shown.add(path);
      named = path;
    } else if (header && raw.startsWith("index ")) {
      const m = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(raw);
      if (m && blobs && !/^0+$/.test(m[1])) blobs.set(named, m[1]);
    } else if (header && raw.startsWith("+++ ")) {
      // A name with a space ends in a tab, for patch, quoted or not; a tab in the name itself is quoted.
      const name = raw.slice(4).replace(/\t$/, "");
      if (name === "/dev/null") continue;
      const path = unquotePath(name);
      if (!path.startsWith("b/") || (asked && !asked.has(path.slice(2)))) throw new Error(`git diff named a path it was not asked for: ${JSON.stringify(name)}`);
      file = path.slice(2);
    } else if (raw.startsWith("@@ ")) {
      header = false;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) throw new Error(`git diff wrote a hunk header that does not parse: ${JSON.stringify(raw.slice(0, 80))}`);
      n = Number(m[1]);
    }
    // "-" lines and "\ No newline at end of file" leave the new file's numbering where it is.
  }
  if (complete && asked) {
    const missing = [...asked].filter((p) => !shown.has(p));
    if (missing.length) throw new Error(`git diff did not show ${missing.length} staged path(s), so their lines were not read: ${missing.slice(0, 3).map((p) => JSON.stringify(p)).join(", ")}`);
  }
  return out;
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
  const n = git(["rev-list", "--count", `${upstream}..HEAD`], { cwd, walk: true });
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
 * A state dir under the git dir, however it is spelled ("./.git/ennyn", ".git\\ennyn"): the part after ".git",
 * or null for a value elsewhere (".git/../x" is x).
 * @param {string} stateDir config `paths.stateDir`
 */
export function underGitDir(stateDir) {
  const norm = posix.normalize(stateDir.replace(/\\/g, "/"));
  return norm === ".git" || norm.startsWith(".git/") ? norm.slice(".git".length) : null;
}

/**
 * Resolve the machine-local state directory. A value under ".git/" is resolved
 * through the common git dir: in a linked worktree ".git" is a file, and a
 * state dir under it cannot be created. Its files are read and written only
 * below stateRoot (core/files.mjs), so a link a commit holds is never followed.
 * @param {string} projectDir
 * @param {string} stateDir config `paths.stateDir`
 * @returns {string}
 */
export function resolveStateDir(projectDir, stateDir) {
  if (isAbsolute(stateDir)) return stateDir;
  const inGit = underGitDir(stateDir);
  if (inGit !== null) {
    const common = commonDir(projectDir);
    if (common) return join(common, inGit);
  }
  return resolve(projectDir, stateDir);
}

/**
 * The directory a file of Ennyn's state is read and written below, no link from it to the file
 * (core/files.mjs writeState): for a file in the common git dir its own directory, since no commit writes
 * there and a link on the way is this machine's (a state dir on another disk); else the project directory
 * for one in it, as spelled or as its real path; else the file's own directory, one this machine chose (the
 * per-user temporary one). The file itself is never a link.
 * @param {string} projectDir @param {string} path absolute
 */
export function stateRoot(projectDir, path) {
  const within = (/** @type {string} */ root) => {
    const r = relative(root, path);
    return r.split(sep)[0] !== ".." && !isAbsolute(r);
  };
  const common = commonDir(projectDir);
  if (common && within(common)) return dirname(path);
  let real = projectDir;
  try {
    real = realpathSync(projectDir);
  } catch {
    // Not there to resolve: its spelling stands.
  }
  return [projectDir, real].find(within) ?? dirname(path);
}
