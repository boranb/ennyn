/**
 * The cycle's worktrees. Each one the cycle makes carries a mark, a lock whose reason is `ennyn:<cycle>`
 * (`git worktree add --lock --reason ennyn:<cycle>`): git prunes no locked worktree, and a worktree without the mark
 * is never read here, nor the main one. At the end a marked worktree goes only when removing it loses nothing, which
 * `git worktree remove` without `--force` does not see to (git 2.34.1, 2.39.5 and 2.56.0, measured): it deletes ignored
 * files, a change git status does not see, and the worktree's HEAD reflog and its own refs, the only hold on a commit
 * made on a detached HEAD.
 *
 * Nothing here asks `git status` whether the folder is clean: status trusts the repository's stat settings (an
 * in-place edit of the same size with its time set back passes under `core.trustctime=false`), does not list a `.git`
 * entry below the top, and warns and exits 0 on a folder it cannot read (cycle 19 review, three gits). The folder is
 * compared with HEAD instead, by its bytes: every file a HEAD path of the same mode (no executable bit is
 * read on Windows, whose disk keeps none) and the same blob, or the bytes checkout writes for that blob, every link a
 * HEAD link to the same target, every HEAD path on disk; empty folders pass, and anything else keeps it. So does an
 * index that differs from HEAD, an entry flagged assume-unchanged or skip-worktree, a branch not merged, a detached
 * HEAD no ref outside the worktree holds, state git keeps for an operation in progress, and a commit only the
 * worktree's own reflogs or refs hold.
 *
 * The mark is read from the common git dir (`worktrees/<id>/locked` and `gitdir`, as gitrepository-layout describes
 * them), never from `git worktree list --porcelain`: below git 2.36 that has no -z, and a path holding a line feed
 * then prints a lock line of its own. Every file read here is a regular file opened without blocking, never through
 * a link: a named pipe in place of `.git`, `locked` or `gitdir` once held the command.
 *
 * The removal is not git's: Git for Windows 2.47.1 deletes through a junction in the folder, with or without
 * `--force`. The folder is moved aside in one rename, looked at again, and deleted by Node's `rmSync`, which unlinks
 * a link, a junction too, and never enters it (Node 22, Windows and Linux, measured); git then drops its entry. It
 * would enter a folder swapped for a junction between its look at it and its read of it, and a volume mount point,
 * which libuv does not report as a link.
 *
 * What the check cannot see: a file a process still writes in the worktree after the last look (a link it makes is
 * unlinked, never entered; `--remove <path>` is meant for a worktree whose task has stopped), an NTFS alternate data
 * stream, which Node does not list, and a mark someone copied onto another worktree by hand, which makes it the cycle's.
 */

import { lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { readRegular } from "../core/files.mjs";
import { argBatches, commonDir, git, gitBytes, gitError, gitMaybe, gitRun } from "../core/git.mjs";

/** The mark: a lock reason of `ennyn:` and a cycle's number, as git stores it (with a line feed). */
export const MARK = /^ennyn:(\d+)\n?$/;

/**
 * What a linked worktree's own git folder may hold when no operation is in progress; anything else (rebase-merge,
 * rebase-apply, MERGE_HEAD, CHERRY_PICK_HEAD, sequencer, BISECT_LOG, config.worktree, submodules' modules, an
 * index.lock) is state that removing it would lose. Measured on git 2.34.1, 2.39.5 and 2.56.0: AUTO_MERGE and
 * REBASE_HEAD stay after a rebase that ended, MERGE_RR after one rerere recorded; the commits REBASE_HEAD,
 * ORIG_HEAD and FETCH_HEAD name are checked with the worktree's own.
 */
export const PLAIN = new Set(["HEAD", "ORIG_HEAD", "AUTO_MERGE", "REBASE_HEAD", "MERGE_RR", "FETCH_HEAD", "commondir", "gitdir", "index", "logs", "locked", "refs", "COMMIT_EDITMSG"]);

/** The name a worktree's folder is moved to for its removal, before its random part. @param {string} name */
const ASIDE = (name) => `.${name}.ennyn-removing-`;

/** Refs only one worktree sees: they go with it. */
const OWN_REFS = /^refs\/(worktree|bisect|rewritten)\//;

/** The most bytes of `locked` or `gitdir` read. */
const SMALL = 64 * 1024;

/** Room past a file's size for what git says on stderr while it writes the bytes checkout would. */
const SAID = 64 * 1024;

/** @param {unknown} e */
const errno = (e) => /** @type {NodeJS.ErrnoException} */ (e)?.code;
/** @param {string} s */
const lines = (s) => s.split("\n").filter(Boolean);
/** A path as the disk spells it: case and links resolved (a case-insensitive disk takes WTS for wts). */
const real = (/** @type {string} */ p) => realpathSync.native(p);

/**
 * Each entry below `path`, read with lstat and never through a link, every folder descended into, in one fixed order:
 * the check and the second look walk the same way.
 * @param {string} path
 */
function* below(path) {
  const stack = [""];
  while (stack.length) {
    const rel = /** @type {string} */ (stack.pop());
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(rel ? join(path, rel) : path).sort();
    } catch (e) {
      throw new Error(`${rel || "."} could not be read: ${errno(e) ?? /** @type {Error} */ (e).message}`);
    }
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(path, p), { bigint: true });
      if (st.isDirectory()) stack.push(p);
      yield { p, name, st };
    }
  }
}

/**
 * What the second look compares of one entry: its name and kind, and for anything but a folder its size, its change
 * and modification times and its inode (a folder's own change shows in the names below it).
 * @param {string} p @param {import("node:fs").BigIntStats} st
 */
const mark = (p, st) => (st.isDirectory() ? `${p}\0d` : `${p}\0${st.isFile() ? "f" : st.isSymbolicLink() ? "l" : "o"}\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}\0${st.ino}`);

/** lstat, or null when nothing is there. @param {string} p */
function look(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return null;
    throw e;
  }
}

/** A small regular file in `dir`, or null when it is not there; a pipe, a device or a link in its place throws. @param {string} dir @param {string} name */
function readSmall(dir, name) {
  const bytes = readRegular(dir, join(dir, name), { limit: SMALL });
  return bytes === null ? null : bytes.toString("utf8");
}

/**
 * @typedef {{ id: string, admin: string, mark: string, path: string | null, dup: boolean }} Marked `admin`: the folder
 *   git keeps for it in the common git dir; `path`: the worktree as `gitdir` names it, null when that file is gone;
 *   `dup`: another of git's entries names the same folder
 * @typedef {{ go: true } | { go: false, why: string, vars?: Record<string, string | number | string[]> } | { go: false, unmeasured: string }} Verdict
 */

/**
 * The repository's marked worktrees, by id, how many linked worktrees carry no mark, and the entries whose mark or
 * place could not be read: nothing is known of those.
 * @param {string} cwd any worktree of the repository
 * @returns {{ marked: Marked[], others: number, unread: { id: string, error: string }[] }}
 */
export function markedWorktrees(cwd) {
  const common = commonDir(cwd);
  if (!common) throw new Error("not in a git repository");
  const dir = join(common, "worktrees");
  /** @type {string[]} */
  let ids;
  try {
    ids = readdirSync(dir).sort();
  } catch (e) {
    if (errno(e) === "ENOENT") return { marked: [], others: 0, unread: [] };
    throw e;
  }
  const entries = [];
  const unread = [];
  for (const id of ids) {
    const admin = join(dir, id);
    try {
      // An entry that is no folder is no worktree's.
      if (!look(admin)?.isDirectory()) continue;
      const mark = readSmall(admin, "locked");
      const gitdir = readSmall(admin, "gitdir");
      // An absolute path, or one relative to this folder (git 2.48's --relative-paths); a line feed in it is the path's.
      const path = gitdir === null ? null : dirname(resolve(admin, gitdir.replace(/\n$/, "")));
      entries.push({ id, admin, mark: mark !== null && MARK.test(mark) ? mark.replace(/\n$/, "") : null, path });
    } catch (e) {
      unread.push({ id, error: /** @type {Error} */ (e).message });
    }
  }
  // Two entries that name one folder: git acts on whichever it finds first, so neither is removed.
  /** @type {Map<string, number>} */
  const named = new Map();
  const place = (/** @type {string} */ p) => {
    try {
      return real(p);
    } catch {
      return p;
    }
  };
  for (const e of entries) if (e.path !== null) named.set(place(e.path), (named.get(place(e.path)) ?? 0) + 1);
  const marked = entries.filter((e) => e.mark !== null).map((e) => ({ ...e, mark: /** @type {string} */ (e.mark), dup: e.path !== null && (named.get(place(e.path)) ?? 0) > 1 }));
  return { marked, others: entries.length - marked.length, unread };
}

/** A check that could not be made, in a line: git's words when git said any. @param {unknown} e @returns {Verdict} */
function unmeasured(e) {
  const x = /** @type {Error & { stderr?: unknown }} */ (e);
  return { go: false, unmeasured: (x.stderr ? String(x.stderr) : x.message).trim().split("\n")[0] };
}

/**
 * Whether removing a marked worktree loses nothing; a check that could not be made keeps it, and says so.
 * @param {string} top the real path of the worktree the command runs in @param {Marked} w
 * @param {string[]} [shape] gets what the walks saw of its git folder and its folder, for the second look
 * @param {string} [platform] the platform whose disk is read: on win32 it keeps no executable bit
 * @returns {Verdict}
 */
export function verdict(top, w, shape = [], platform = process.platform) {
  try {
    return judge(top, w, shape, platform);
  } catch (e) {
    return unmeasured(e);
  }
}

/**
 * The second look, right before the removal: the worktree's git folder and its folder, now at `path`, walked again
 * with lstat alone, which reads no file, against what the check saw. The check reads every tracked byte (32 s for
 * 1 GiB on git 2.34.1, cycle 19 review), and what changed meanwhile it did not read. Any difference keeps it, naming
 * the first entry.
 * @param {Marked} w @param {string} path @param {string[]} shape
 * @returns {Verdict}
 */
function again(w, path, shape) {
  try {
    const now = shapeOf(path, w.admin);
    const at = now.findIndex((s, i) => s !== shape[i]);
    const i = at === -1 && now.length !== shape.length ? Math.min(now.length, shape.length) : at;
    if (i === -1) return { go: true };
    return { go: false, why: "changed", vars: { path: [(now[i] ?? shape[i]).split("\0")[0]] } };
  } catch (e) {
    return unmeasured(e);
  }
}

/** The worktree's git folder, its entries named `.git/…`. @param {string} admin */
const inGit = (admin) => [...below(admin)].map(({ p, st }) => mark(`.git/${p}`, st));

/** The worktree's git folder, then its folder, as the check's walks met them. @param {string} path @param {string} admin */
const shapeOf = (path, admin) => [...inGit(admin), ...[...below(path)].map(({ p, st }) => mark(p, st))];

/** Whether anything is at `p`; a look that fails counts as something. @param {string} p */
const there = (p) => {
  try {
    return look(p) !== null;
  } catch {
    return true;
  }
};

/**
 * @typedef {{ removed: true } | { removed: false, verdict: Verdict, notMoved?: true }
 *   | { removed: false, error: string, entry: "relocked" | "notRelocked" | "dropped", folder: "left" | "aside" | "changed" | "gone", aside: string }} Removal
 */

/**
 * Removes a marked worktree that passes. Git does not delete its folder (Git for Windows 2.47.1 deletes through a
 * junction in it): the folder is moved aside in one rename to a name beside it (`ASIDE`), and a rename that fails
 * keeps it (on Windows, while a process holds a file or its working directory in it). The moved folder is looked at
 * once more (`again`; a change moves it back and keeps it), deleted by `rmSync`, which unlinks a link or a junction
 * and never enters it, and only then unlocked: a removal stopped before that leaves the entry locked with its mark, and
 * `verdict` names the moved folder. git then drops the entry (`git worktree remove` of a folder no longer there; never
 * when something new is at its path). When a step fails, what is true afterwards is said: whether git still lists it
 * (locked with its mark again, or not) or dropped its entry, and whether its folder is back in place, at the name it
 * was moved to (whole, what a failed delete left, or with a change made after the check), or gone.
 * @param {string} top the real path of the worktree the command runs in @param {Marked} w
 * @param {string} [platform] as `verdict`'s
 * @returns {Removal}
 */
export function removeWorktree(top, w, platform = process.platform) {
  /** @type {string[]} */
  const shape = [];
  const v = verdict(top, w, shape, platform);
  if (!v.go) return { removed: false, verdict: v };
  const path = /** @type {string} */ (w.path);
  const aside = join(dirname(path), `${ASIDE(basename(path))}${randomBytes(4).toString("hex")}`);
  try {
    renameSync(path, aside);
  } catch (e) {
    const code = errno(e) ?? /** @type {Error} */ (e).message;
    // A process holding something in it is what Windows refuses a rename for; any other error is said as it is.
    const held = platform === "win32" && ["EBUSY", "EPERM", "EACCES"].includes(code);
    return { removed: false, verdict: { go: false, why: held ? "busy" : "notMoved", vars: { error: code } }, notMoved: true };
  }
  const run = (/** @type {string[]} */ args) => {
    const r = gitRun(args, { cwd: top });
    return r.error || r.status !== 0 ? gitError(args, r).stderr.trim().split("\n")[0] : null;
  };
  /** What is true after a failed step, its folder where `folder` says. @param {string} error @param {"left" | "aside" | "changed" | "gone"} folder @returns {Removal} */
  const stopped = (error, folder) => {
    if (!there(w.admin)) return { removed: false, error, entry: "dropped", folder, aside };
    let still = false;
    try {
      still = MARK.test(readSmall(w.admin, "locked") ?? "");
    } catch {
      // Not readable: lock it again.
    }
    return { removed: false, error, entry: still || run(["worktree", "lock", "--reason", w.mark, path]) === null ? "relocked" : "notRelocked", folder, aside };
  };
  /** The folder back in place, or where it is when that fails. */
  const back = () => {
    try {
      renameSync(aside, path);
      return "left";
    } catch {
      return "aside";
    }
  };
  const late = again(w, aside, shape);
  if (!late.go) {
    const where = back();
    return where === "left" ? { removed: false, verdict: late } : stopped("it changed after it was checked, and could not be moved back", "changed");
  }
  try {
    rmSync(aside, { recursive: true });
  } catch (e) {
    return stopped(/** @type {Error} */ (e).message.split("\n")[0], there(aside) ? "aside" : "gone");
  }
  if (there(path)) return stopped("something new is at its path, so git was not asked to drop its entry", "gone");
  const unlocked = run(["worktree", "unlock", path]);
  if (unlocked !== null) return stopped(unlocked, "gone");
  const dropped = run(["worktree", "remove", path]);
  return dropped === null ? { removed: true } : stopped(dropped, "gone");
}

/** @param {string} top @param {Marked} w @param {string[]} shape @param {string} platform @returns {Verdict} */
function judge(top, w, shape, platform) {
  if (w.dup) return { go: false, why: "dup" };
  // The folder itself, never through a link to it.
  if (w.path === null || !look(w.path)?.isDirectory() || !pointsBack(w.path, w.admin)) {
    const moved = w.path === null || look(w.path) ? [] : movedAside(w.path);
    return moved.length ? { go: false, why: "movedAside", vars: { path: moved } } : { go: false, why: "gone" };
  }
  if (real(w.path) === top) return { go: false, why: "here" };
  const state = readdirSync(w.admin).filter((n) => !PLAIN.has(n)).sort();
  // A worktree's refs and reflogs in a reftable (git 2.45 and later, measured on 2.56.0) are not read here.
  if (state.includes("reftable")) throw new Error("its refs and reflogs are in reftable, which this check does not read");
  if (state.length) return { go: false, why: "state", vars: { names: state } };
  shape.push(...inGit(w.admin));
  const at = { cwd: w.path, walk: true };
  const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: w.path, absent: [1] });
  if (head === null) return { go: false, why: "unborn" };
  // The index holds HEAD's tree, by object names: no stat is read. A gitlink too: `.gitmodules`' ignore=all hides a
  // staged one from a plain diff-index (git 2.34.1, 2.39.5, 2.56.0; diff.ignoreSubmodules does not).
  const cached = ["diff-index", "--cached", "--quiet", "--ignore-submodules=none", head, "--"];
  const same = gitRun(cached, at);
  if (!same.error && same.status === 1) return { go: false, why: "staged" };
  if (same.error || same.status !== 0) throw gitError(cached, same);
  // ls-files -v: a lower-case tag is assume-unchanged, S skip-worktree.
  const flagged = git(["ls-files", "-v", "-z"], at)
    .split("\0")
    .filter((e) => /^([a-z]|S) /.test(e));
  if (flagged.length) return { go: false, why: "flagged", vars: { n: flagged.length, first: [flagged[0].slice(2)] } };
  const odd = compareWithHead(w.path, head, shape, platform);
  if (odd) return odd;
  const branch = gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd: w.path, absent: [1] });
  const holders = lines(git(["for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"], at)).filter((r) => r !== branch);
  const shared = sharedOf(w.path);
  if (!holders.length) {
    if (branch) return { go: false, why: "notMerged", vars: { branch: [branch.replace(/^refs\/heads\//, "")] } };
    // A detached HEAD goes when a ref outside the worktree holds it (a snapshot ref, the stash), never a reflog alone:
    // that goes with its ref (`git branch -d`), and the worktree's HEAD was the only other hold.
    if (shared.notOnRefs([head]).length) return { go: false, why: "detached" };
  }
  const left = shared.notHeld([...ownCommits(w.path, w.admin)]).length;
  if (left) return { go: false, why: "leftBehind", vars: { n: left } };
  return { go: true };
}

/**
 * The folders beside `path` a removal moved it to and did not finish deleting, as `removeWorktree` names them; none
 * when the parent cannot be read.
 * @param {string} path
 */
function movedAside(path) {
  try {
    return readdirSync(dirname(path)).filter((n) => n.startsWith(ASIDE(basename(path)))).sort().map((n) => join(dirname(path), n));
  } catch {
    return [];
  }
}

/**
 * Whether the `.git` file of the folder at `path` names `admin`: git writes `gitdir: <path>` and a line feed. A `.git`
 * that is no regular file (a folder, a pipe, a link) names nothing.
 * @param {string} path @param {string} admin
 */
function pointsBack(path, admin) {
  if (!look(join(path, ".git"))?.isFile()) return false;
  const text = readSmall(path, ".git");
  if (text === null || !text.startsWith("gitdir: ")) return false;
  try {
    return real(resolve(path, text.slice("gitdir: ".length).replace(/\n$/, ""))) === real(admin);
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return false;
    throw e;
  }
}

/** A path as git's stdin readers take it: C-quoted, so a quote, a backslash or a line feed in a name is the name's. @param {string} p */
const quoted = (p) => `"${p.replace(/[\\"]/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;

/**
 * The folder at `path` against HEAD's tree, by what is on disk: null when it holds what a checkout of HEAD writes, else
 * why not. Read with lstat and never through a link; the top `.git` file is git's. `shape` gets each entry the walk
 * meets, for the second look. On win32 the disk keeps no executable bit (Git for Windows sets `core.fileMode=false`),
 * so none is compared; elsewhere the bit on disk is, whatever `core.fileMode` says: removing the folder loses it.
 * @param {string} path @param {string} head @param {string[]} shape @param {string} platform
 * @returns {Verdict | null}
 */
function compareWithHead(path, head, shape, platform) {
  const at = { cwd: path, walk: true };
  /** @type {Map<string, { mode: string, oid: string, size: number }>} */
  const tree = new Map();
  for (const entry of git(["ls-tree", "-r", "-l", "-z", "--full-tree", head], at).split("\0")) {
    const m = /^(\d+) \w+ ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(entry);
    if (m) tree.set(m[4], { mode: m[1], oid: m[2], size: Number(m[3]) });
  }
  // core.symlinks=false (Git for Windows' default): checkout writes a link as a plain file holding its target.
  const plainLinks = gitMaybe(["config", "--type=bool", "--get", "core.symlinks"], { cwd: path, absent: [1] }) === "false";
  /** @type {{ p: string, oid: string, size: number, link: boolean }[]} */
  const files = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const keep = (/** @type {string} */ why, /** @type {string} */ p) => /** @type {Verdict} */ ({ go: false, why, vars: { path: [p] } });
  for (const { p, name, st } of below(path)) {
    shape.push(mark(p, st));
    if (p === ".git") continue;
    // Another repository or worktree, or what git would take for one: git status does not list it.
    if (name === ".git") return keep("gitEntry", p);
    const want = tree.get(p);
    if (st.isDirectory()) {
      if (want && want.mode !== "160000") return keep("missing", p);
      seen.add(p);
    } else if (st.isSymbolicLink()) {
      if (want?.mode !== "120000") return keep("notInHead", p);
      const target = readlinkSync(join(path, p), { encoding: "buffer" });
      const oid = createHash(want.oid.length === 64 ? "sha256" : "sha1").update(`blob ${target.length}\0`).update(target).digest("hex");
      if (oid !== want.oid) return keep("link", p);
      seen.add(p);
    } else if (st.isFile()) {
      const link = want?.mode === "120000" && plainLinks;
      if (!want || !(link || /^100(644|755)$/.test(want.mode))) return keep("notInHead", p);
      if (!link && platform !== "win32" && (st.mode & 0o100n ? "100755" : "100644") !== want.mode) return keep("mode", p);
      files.push({ p, oid: want.oid, size: Number(st.size), link });
      seen.add(p);
    } else return keep("special", p);
  }
  for (const p of tree.keys()) if (!seen.has(p)) return keep("missing", p);
  // A file whose size is not its blob's is not read for that; the others as raw bytes, since a clean filter would hide
  // what it drops (output a notebook filter strips).
  const sized = files.filter((f) => f.size === tree.get(f.p)?.size);
  const oids = sized.length ? lines(gitBytes(["hash-object", "--no-filters", "--stdin-paths"], { ...at, input: sized.map((f) => quoted(f.p)).join("\n") + "\n" }).toString("utf8")) : [];
  if (oids.length !== sized.length) throw new Error(`git hash-object named ${oids.length} objects for ${sized.length} files`);
  const same = new Set(sized.filter((f, i) => oids[i] === f.oid));
  const differ = files.filter((f) => !same.has(f));
  if (!differ.length) return null;
  // A file checkout writes through a filter, ident, a line-ending setting or another encoding is set against those
  // bytes; a link written as a file is its target as it is.
  const written = mayConvert(path, differ.filter((f) => !f.link).map((f) => f.p));
  for (const f of differ) if (f.link || !written.has(f.p) || !checkoutWrites(path, head, f)) return keep("differs", f.p);
  return null;
}

/**
 * The paths among `paths` that checkout may write as other bytes than their blob's: an attribute (filter, text, eol,
 * ident, working-tree-encoding) other than unspecified or unset, or any of them under `core.autocrlf` set to anything
 * but false. A path counted here that checkout writes as it is only costs a call.
 * @param {string} path @param {string[]} paths
 * @returns {Set<string>}
 */
function mayConvert(path, paths) {
  if (!paths.length) return new Set();
  const crlf = gitMaybe(["config", "--get", "core.autocrlf"], { cwd: path, absent: [1] });
  if (crlf !== null && !/^(false|no|off|0|)$/i.test(crlf.trim())) return new Set(paths);
  const out = gitBytes(["check-attr", "-z", "--stdin", "filter", "text", "eol", "ident", "working-tree-encoding"], { cwd: path, input: paths.join("\0") + "\0" }).toString("utf8").split("\0");
  /** @type {Set<string>} */
  const set = new Set();
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] !== "unspecified" && out[i + 2] !== "unset") set.add(out[i]);
  return set;
}

/**
 * Whether the file holds the bytes checkout writes for its blob: `git cat-file --filters`, which runs the repository's
 * smudge filter for it as checkout does. One call a file: the batch form gives the blob's size, not that output's, so
 * its output cannot be cut (git 2.34.1, 2.39.5 and 2.56.0). An output longer than the file differs from it.
 * @param {string} path @param {string} head @param {{ p: string, size: number }} f
 */
function checkoutWrites(path, head, f) {
  /** @type {Buffer} */
  let out;
  try {
    out = gitBytes(["cat-file", "--filters", `${head}:${f.p}`], { cwd: path, buffer: f.size + SAID });
  } catch (e) {
    if (errno(e) === "ENOBUFS") return false;
    throw e;
  }
  const disk = readRegular(path, join(path, f.p));
  return disk !== null && out.equals(disk);
}

/**
 * The refs every worktree shares: which commits none of them holds (`notOnRefs`), and which none of them and none of
 * their reflogs hold (`notHeld`). A reflog's new values are read: a commit only an old value holds counts as not held.
 * @param {string} path
 */
function sharedOf(path) {
  const at = { cwd: path, walk: true };
  const refs = lines(git(["for-each-ref", "--format=%(refname)"], at)).filter((r) => !OWN_REFS.test(r));
  const notOn = (/** @type {string[]} */ want, /** @type {string[]} */ not) =>
    want.length ? lines(gitBytes(["rev-list", "--stdin"], { ...at, input: [...want, ...not.map((x) => `^${x}`)].join("\n") + "\n" }).toString("utf8")) : [];
  /** @type {Set<string> | null} */
  let held = null;
  return {
    /** @param {string[]} want */
    notOnRefs: (want) => notOn(want, refs),
    /** @param {string[]} want */
    notHeld(want) {
      const left = notOn(want, refs);
      if (!left.length) return left;
      if (held === null) {
        held = new Set();
        for (const batch of argBatches(refs)) for (const c of lines(git(["log", "-g", "--format=%H", ...batch, "--"], at))) held.add(c);
      }
      return notOn(left, [...held]);
    },
  };
}

/**
 * Every commit only this worktree holds: both values of each line of its own reflogs (HEAD's and its own refs', read
 * from its git folder: a reftable keeps the worktree before this), its own refs, and what ORIG_HEAD, REBASE_HEAD and
 * FETCH_HEAD name.
 * @param {string} path @param {string} admin
 * @returns {Set<string>}
 */
function ownCommits(path, admin) {
  /** @type {Set<string>} */
  const own = new Set();
  const named = (/** @type {string} */ oid) => /^[0-9a-f]{40,64}$/.test(oid) && !/^0+$/.test(oid) && own.add(oid);
  const logs = [join(admin, "logs")];
  while (logs.length) {
    const dir = /** @type {string} */ (logs.pop());
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (errno(e) === "ENOENT") continue;
      throw e;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (look(p)?.isDirectory()) logs.push(p);
      else for (const line of (readRegular(admin, p) ?? Buffer.alloc(0)).toString("utf8").split("\n")) line.split(" ", 2).forEach(named);
    }
  }
  for (const oid of lines(git(["for-each-ref", "--format=%(objectname)", "refs/worktree", "refs/bisect", "refs/rewritten"], { cwd: path }))) named(oid);
  for (const ref of ["ORIG_HEAD", "REBASE_HEAD"]) {
    const oid = gitMaybe(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: path, absent: [1] });
    if (oid) named(oid);
  }
  for (const line of (readRegular(admin, join(admin, "FETCH_HEAD")) ?? Buffer.alloc(0)).toString("utf8").split("\n")) named(line.split("\t")[0]);
  return own;
}
