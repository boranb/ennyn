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
import { readIfThere } from "./files.mjs";

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
    // The command's name, past any "-c key=value" in front of it.
    let at = 0;
    while (args[at] === "-c") at += 2;
    // Output past the buffer stops git with SIGTERM: that is no kill from outside.
    if (e.code === "ENOBUFS") e.stderr = `git ${args[at]}: its output was larger than 64 MB`;
    else if (!String(e.stderr ?? "").trim()) e.stderr = `git ${args[at]}: ${e.signal ? `killed by ${e.signal}` : e.code === "ENOENT" ? NO_START : e.message}`;
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
 * The lines a commit adds to `paths` (the staged paths a review.forbidden rule names), numbered as in the new
 * file. Read from the index the hook was given (stagedPaths), with those paths as pathspecs, 500 a git call:
 * only the files a rule reads are diffed, so a large file elsewhere cannot fill git()'s buffer. A path handed
 * back to git can match nothing (macOS precomposes a decomposed name; bytes that are not UTF-8 come back
 * changed, and two such names can decode alike): every path asked must show in a header, else it throws and
 * the hook says it did not check. The diff is pinned against the user's config: no color, external diff or
 * textconv, the a/ and b/ prefixes (diff.noprefix and diff.mnemonicPrefix change them), a submodule as its
 * commit line, no renames (a moved file is added in full, as its new name is staged), and every file as
 * text (--text: a NUL byte, a -diff or binary attribute and core.bigFileThreshold would otherwise hide its
 * lines). A file stored in UTF-16 holds the text with NULs between its letters: it is not matched.
 * In a merge every added line counts: the other side's commits may have run no hook (cherry-pick, rebase,
 * --no-verify, a clone without it). A line a parent named in MERGE_HEAD already holds carries that parent in
 * `from`, for the message only: MERGE_HEAD is a file anyone can write.
 * @param {string} cwd the repository's top
 * @param {string[]} paths
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Map<string, AddedLine[]>}
 * @typedef {{ line: number, text: string, from?: string }} AddedLine
 */
export function stagedAddedLines(cwd, paths, { env } = {}) {
  /** @type {Map<string, AddedLine[]>} */
  const out = new Map();
  if (!paths.length) return out;
  const index = env ? hookIndexFile(cwd, env) : null;
  const run = (/** @type {string[]} */ against, /** @type {string[]} */ batch) =>
    git(["-c", "core.quotePath=false", "diff", "--cached", ...against, "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "-U0", "--src-prefix=a/", "--dst-prefix=b/", "--", ...batch], {
      cwd,
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
      keepIndex: Boolean(index),
    });
  const parents = mergeHeads(cwd);
  const unique = [...new Set(paths)];
  for (let at = 0; at < unique.length; at += 500) {
    const batch = unique.slice(at, at + 500);
    const mine = addedLines(run([], batch), new Set(batch), { complete: true });
    for (const parent of parents) {
      const theirs = addedLines(run([parent], batch), null);
      for (const [path, lines] of mine) {
        const added = new Set((theirs.get(path) ?? []).map((l) => l.line));
        for (const l of lines) if (!added.has(l.line)) l.from ??= parent;
      }
    }
    for (const [path, lines] of mine) out.set(path, lines);
  }
  return out;
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
 * answer. A hunk header that does not parse throws.
 * @param {string} text
 * @param {Set<string> | null} asked
 * @param {{ complete?: boolean }} [opts]
 * @returns {Map<string, AddedLine[]>}
 */
export function addedLines(text, asked, { complete = false } = {}) {
  /** @type {Map<string, AddedLine[]>} */
  const out = new Map();
  /** @type {Set<string>} */
  const shown = new Set();
  /** @type {string | null} */
  let file = null;
  /** @type {AddedLine[] | null} */
  let lines = null;
  let header = false;
  let n = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      lines = null;
      header = true;
      const path = headerPath(raw.slice(11));
      if (path === null || (asked && !asked.has(path))) throw new Error(`git diff named a path it was not asked for: ${JSON.stringify(raw.slice(11, 200))}`);
      shown.add(path);
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
    } else if (!header && raw.startsWith("+")) {
      if (file !== null) {
        if (!lines) out.set(file, (lines = []));
        lines.push({ line: n, text: raw.slice(1) });
      }
      n++;
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
