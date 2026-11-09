/**
 * The facts a verdict about a repository stands for, read from git and the file system alone: never from the code
 * under test, nor from core/git.mjs. `ennyn worktrees --remove` says removing a worktree loses nothing, `ennyn
 * leftovers` that nothing new is left in the work tree; test/worktrees-oracle.test.mjs and
 * test/leftovers-oracle.test.mjs set each verdict against what these read before and after.
 *
 * What "lost" means for git's objects: an object `git fsck --unreachable` lists after and did not list before. That
 * reading counts every ref, every worktree's HEAD and index and every reflog as a hold, which is what gc keeps: an
 * object a reflog still holds is in `git reflog` and stays until the entry expires, one fsck lists is what gc prunes.
 * `--no-reflogs` would call a commit only the worktree's HEAD reflog holds unreachable before the removal too, and miss
 * that the removal drops its last hold. git 2.34.1 reads no linked worktree's index in fsck (2.56.0 does, measured), so
 * an index is read on its own: each entry against the tree of its HEAD.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** No maintenance racing a reading, and an identity of its own for any commit. */
const SET = ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.fsmonitor="];

/** git's output, or a throw with its words. @param {string} cwd @param {string[]} args */
export function gitOut(cwd, args) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

/** NUL-separated fields, the last empty one dropped. @param {string} s */
const fields = (s) => s.split("\0").filter(Boolean);

/** Every object gc would prune, as `<type> <oid>`. @param {string} cwd */
export const unreachable = (cwd) => new Set(gitOut(cwd, ["fsck", "--unreachable", "--no-progress"]).split("\n").filter((l) => l.startsWith("unreachable ")).map((l) => l.slice("unreachable ".length)));

/** Every ref of the repository with what it names, HEAD of `cwd`'s worktree left out. @param {string} cwd */
export const refs = (cwd) => new Map(gitOut(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter(Boolean).map((l) => /** @type {[string, string]} */ (l.split(" "))));

/**
 * Every object id a worktree's own refs name, which go with it: git-worktree(1) (2.56.0, REFS) says every pseudo ref
 * (one directly under its git dir, as HEAD, ORIG_HEAD, FETCH_HEAD, MERGE_HEAD, REBASE_HEAD, AUTO_MERGE) and refs/bisect,
 * refs/worktree and refs/rewritten are per worktree. Read from the files gitrepository-layout(5) names for them: the
 * upper-case files of its git dir, everything below its refs/ and logs/ (their reflogs). git fsck reads none of a
 * linked worktree's but HEAD's and its reflog (2.56.0, measured): a commit only such a ref holds reads unreachable
 * before its worktree goes, and after.
 * @param {string} cwd
 * @returns {Set<string>}
 */
export function holds(cwd) {
  const admin = gitOut(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
  /** @type {Set<string>} */
  const out = new Set();
  const read = (/** @type {string} */ p) => {
    for (const oid of readFileSync(p, "utf8").match(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g) ?? []) if (!/^0+$/.test(oid)) out.add(oid);
  };
  const walk = (/** @type {string} */ dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) (lstatSync(join(dir, n)).isDirectory() ? walk : read)(join(dir, n));
  };
  for (const n of readdirSync(admin)) if (/^[A-Z_]+$/.test(n) && lstatSync(join(admin, n)).isFile()) read(join(admin, n));
  walk(join(admin, "refs")), walk(join(admin, "logs"));
  return out;
}

/** The commit HEAD names in `cwd`, or null. @param {string} cwd */
export function head(cwd) {
  const r = spawnSync("git", [...SET, "-C", cwd, "rev-parse", "--verify", "-q", "HEAD^{commit}"], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A tree's entries, path to `<mode> <oid>`; none for no commit. @param {string} cwd @param {string | null} rev */
export const tree = (cwd, rev) =>
  new Map(rev === null ? [] : fields(gitOut(cwd, ["ls-tree", "-r", "-z", "--full-tree", rev])).map((e) => /** @type {[string, string]} */ ([e.slice(e.indexOf("\t") + 1), e.slice(0, e.indexOf("\t")).replace(/ (blob|commit) /, " ")])));

/** The index of `cwd`'s worktree, path to `<mode> <oid>`, a stage other than 0 marked. @param {string} cwd */
export function index(cwd) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const e of fields(gitOut(cwd, ["ls-files", "-s", "-z"]))) {
    const [mode, oid, stage] = e.slice(0, e.indexOf("\t")).split(" ");
    const p = e.slice(e.indexOf("\t") + 1);
    out.set(stage === "0" ? p : `${p}\0stage${stage}`, `${mode} ${oid}`);
  }
  return out;
}

/** Index entries flagged skip-worktree (ls-files -v tag S, or s with assume-unchanged too). @param {string} cwd */
export const skipWorktree = (cwd) => new Set(fields(gitOut(cwd, ["ls-files", "-v", "-z"])).filter((e) => /^[sS] /.test(e)).map((e) => e.slice(2)));


/** The blob id git gives these bytes, sha1 as the corpus repositories are. @param {Buffer} bytes */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * Every entry below `dir` by lstat, never through a link, the top `.git` and hook samples left out: a folder `d`, a file `f <x> <blob
 * id>` (x: the owner's executable bit), a link `l <blob id of its target>`, anything else `o`.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
export function listing(dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const walk = (/** @type {string} */ rel) => {
    for (const name of readdirSync(rel ? join(dir, rel) : dir).sort()) {
      const p = rel ? `${rel}/${name}` : name;
      if (p === ".git" || /(^|\/)\.git\/hooks\/[^/]+\.sample$/.test(p)) continue; // git's template, the same in every repository
      const full = join(dir, p);
      const st = lstatSync(full);
      if (st.isDirectory()) out.set(p, "d"), walk(p);
      else if (st.isFile()) out.set(p, `f ${st.mode & 0o100 ? "x" : "-"} ${readable(full) ? blobId(readFileSync(full)) : `unreadable ${st.size} ${st.mtimeMs}`}`);
      else if (st.isSymbolicLink()) out.set(p, `l ${blobId(readlinkSync(full, { encoding: "buffer" }))}`);
      else out.set(p, "o");
    }
  };
  walk("");
  return out;
}

/** Whether this process may read the file (root may read one of mode 000). @param {string} p */
const readable = (p) => {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Copies of the ignore lists of `cwd`'s worktree that live outside its tree, `.git/info/exclude` and the file
 * `core.excludesFile` names (or git's default, `$XDG_CONFIG_HOME/git/ignore`), into `dir`: the start's rules, for
 * `ignoredBy` at the closing.
 * @param {string} cwd @param {string} dir
 */
export function localRules(cwd, dir) {
  const r = spawnSync("git", [...SET, "-C", cwd, "config", "--path", "core.excludesFile"], { encoding: "utf8" });
  const xdg = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config");
  const from = [gitOut(cwd, ["rev-parse", "--git-path", "info/exclude"]).trim(), r.status === 0 ? r.stdout.trim() : join(xdg, "git", "ignore")];
  return from.map((f, i) => {
    const to = join(dir, `rules-${i}`);
    const at = resolve(cwd, f);
    writeFileSync(to, existsSync(at) ? readFileSync(at) : "");
    return to;
  });
}

/** The `.gitignore` files of a listing, by path, with their bytes. @param {string} cwd @param {Map<string, string>} files */
export const gitignores = (cwd, files) => new Map([...files.keys()].filter((p) => /(^|\/)\.gitignore$/.test(p) && files.get(p)?.startsWith("f ")).map((p) => [p, readFileSync(join(cwd, p))]));

/**
 * Untracked files ignored by the start's rules: the rule files `localRules` copied, and the start's `.gitignore` files
 * (`gitignores`), put in place of the tree's own for the reading and the tree's put back after. A list the cycle
 * wrote or changed, in the tree or outside it, hides nothing here.
 * @param {string} cwd @param {string[]} rules @param {Map<string, Buffer>} lists @param {Map<string, string>} files the tree's listing now
 */
export function ignoredBy(cwd, rules, lists, files) {
  const now = gitignores(cwd, files);
  const swap = (/** @type {Map<string, Buffer>} */ from, /** @type {Map<string, Buffer>} */ to) => {
    for (const p of from.keys()) rmSync(join(cwd, p));
    for (const [p, bytes] of to) mkdirSync(dirname(join(cwd, p)), { recursive: true }), writeFileSync(join(cwd, p), bytes);
  };
  swap(now, lists);
  try {
    return new Set(fields(gitOut(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-per-directory=.gitignore", ...rules.map((f) => `--exclude-from=${f}`)])));
  } finally {
    swap(lists, now);
  }
}

/** What a file or a link HEAD holds writes, in `listing`'s words, when no filter converts it. @param {string} entry `<mode> <oid>` */
export function written(entry) {
  const [mode, oid] = entry.split(" ");
  if (mode === "120000") return `l ${oid}`;
  if (mode === "160000") return "d";
  return `f ${mode === "100755" ? "x" : "-"} ${oid}`;
}

/** The entries of `a` that `b` lacks or holds otherwise, folders left out: a folder holds no bytes. @param {Map<string, string>} a @param {Map<string, string>} b */
export const missingFrom = (a, b) => [...a].filter(([p, v]) => v !== "d" && b.get(p) !== v).map(([p]) => p);
