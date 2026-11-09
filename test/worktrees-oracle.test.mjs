/**
 * Does `ennyn worktrees --remove` lose nothing, and keep only what removing would lose? Its own tests
 * (test/worktrees.test.mjs) hold each verdict as a word; the class this file is for, a verdict that stands for a fact
 * and parts from it on some state, was found 12 times in plan/worktrees.mjs, all by review. Here the fact is read by
 * test/repo-facts.mjs, from git and the file system alone: before the command, then after it on a worktree it removed,
 * or after a removal by force on one it kept. What is lost: an object gc would now prune, a ref that moved, an index
 * entry HEAD's tree does not hold, a file a checkout of HEAD does not write back the same. The test fails where the
 * command removed and something was lost, or kept where nothing would have been and the corpus does not name that
 * keep as the design's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { markedWorktrees, removeWorktree } from "../plan/worktrees.mjs";
import { head, holds, index, listing, missingFrom, refs, tree, unreachable } from "./repo-facts.mjs";
import { ownHome } from "./own-home.mjs";

const { root: ROOT } = ownHome("en-wt-oracle-");

/** An identity of its own (a container derives none), no maintenance racing a reading. */
const SET = ["user.name=t", "user.email=t@t", "commit.gpgsign=false", "protocol.file.allow=always", "advice.detachedHead=false", "gc.auto=0", "maintenance.auto=false"].flatMap((kv) => ["-c", kv]);
/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
function g(cwd, args, env = {}) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000, killSignal: "SIGKILL" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** git that may fail: its exit code. @param {string} cwd @param {string[]} args */
const gq = (cwd, args) => spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" }).status;
/** @param {string} p @param {string} text */
const put = (p, text) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));

const DIR = realpathSync(ROOT);
const MAIN = join(DIR, "main");
mkdirSync(MAIN);
g(MAIN, ["init", "-q", "-b", "main"]);
for (const kv of ["gc.auto=0", "maintenance.auto=false", "user.name=t", "user.email=t@t"]) g(MAIN, ["config", ...kv.split("=")]);
put(join(MAIN, "a.txt"), "a\n"), put(join(MAIN, ".gitignore"), ".env\nignored-dir/\n");
g(MAIN, ["add", "-A"]), g(MAIN, ["commit", "-q", "-m", "base"]);

/** A worktree at `wts/<name>`, locked with the mark as the cycle makes them (`reason` null: not locked). */
function add(/** @type {string} */ name, how = ["-b", `c/${name}`], /** @type {string | null} */ reason = "ennyn:27", start = "main") {
  const path = join(DIR, "wts", name);
  g(MAIN, ["worktree", "add", "-q", ...(reason === null ? [] : ["--lock", "--reason", reason]), ...how, path, start]);
  return path;
}
/** A commit in `cwd` that writes `file`. */
function commit(/** @type {string} */ cwd, /** @type {string} */ msg, file = "f.txt") {
  put(join(cwd, file), `${msg}\n`), g(cwd, ["add", "-A"]), g(cwd, ["commit", "-q", "-m", msg]);
  return g(cwd, ["rev-parse", "HEAD"]);
}
const land = (/** @type {string} */ branch) => g(MAIN, ["merge", "-q", "--ff-only", branch]);

/**
 * @typedef {{ name: string, files?: string, design?: string }} State
 *   `files`: where its files are, when not at its path (a moved folder); `design`: the reason the command keeps it
 *   though removing it loses nothing now, with why that keep is the design's
 */
/** @type {State[]} */
const STATES = [];
/** @param {string} name @param {Omit<State, "name">} [more] */
const state = (name, more = {}) => STATES.push({ name, ...more });

// Nothing new: a branch at main, one landed, a detached HEAD at main, an empty folder.
add("fresh"), state("fresh");
commit(add("landed"), "landed"), land("c/landed"), state("landed");
add("detached-main", ["--detach"]), state("detached-main");
mkdirSync(join(add("empty-folder"), "empty")), state("empty-folder");
// Commits: only the worktree holds one, a branch holds one, a shared reflog holds one.
commit(add("detached-new", ["--detach"]), "detached-new"), state("detached-new");
commit(add("own-branch"), "own-branch"), state("own-branch", { design: "notMerged: the branch stays, its task has not landed" });
const brl = add("branch-reflog");
commit(brl, "branch-reflog"), g(brl, ["reset", "-q", "--hard", "main"]), state("branch-reflog");
const hrl = add("head-reflog", ["--detach"]);
commit(hrl, "head-reflog"), g(hrl, ["checkout", "-q", "--detach", "main"]), state("head-reflog");
const wref = add("worktree-ref", ["--detach"]);
g(wref, ["update-ref", "refs/worktree/keep", commit(wref, "worktree-ref")]), g(wref, ["checkout", "-q", "--detach", "main"]), state("worktree-ref");
// A commit only ORIG_HEAD names: no reflog line for it (the one the worktree was made with goes first).
const orig = add("orig-head", ["--detach"]);
const nolog = ["-c", "core.logAllRefUpdates=false"];
rmSync(join(g(orig, ["rev-parse", "--absolute-git-dir"]), "logs", "HEAD"));
put(join(orig, "f.txt"), "orig-head\n"), g(orig, ["add", "-A"]), g(orig, [...nolog, "commit", "-q", "-m", "orig-head"]), g(orig, [...nolog, "reset", "-q", "--hard", "main"]), state("orig-head");
// A commit no HEAD ever named, held by a ref of the worktree's own alone.
const wonly = add("worktree-ref-only", ["--detach"]);
g(wonly, ["update-ref", "refs/worktree/keep", g(wonly, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "worktree-ref-only"])]), state("worktree-ref-only");
const dsr = add("detached-shared-reflog");
commit(dsr, "detached-shared-reflog"), g(dsr, ["checkout", "-q", "--detach"]), g(MAIN, ["branch", "-f", "c/detached-shared-reflog", "main"]);
state("detached-shared-reflog", { design: "detached: a shared branch's reflog goes with its branch (git branch -d), which the worktree's HEAD did not" });
const dsnap = add("detached-snapshot", ["--detach"]);
g(dsnap, ["update-ref", "refs/snapshot/d", commit(dsnap, "detached-snapshot")]), state("detached-snapshot");
const dstash = add("detached-stash", ["--detach"]);
commit(dstash, "detached-stash"), put(join(dstash, "a.txt"), "stashed\n"), g(dstash, ["stash", "-q"]), state("detached-stash");
const sq = add("squashed");
commit(sq, "one", "s1.txt"), commit(sq, "two", "s2.txt"), g(sq, ["reset", "-q", "--soft", "main"]), g(sq, ["commit", "-q", "-m", "squashed"]), land("c/squashed"), state("squashed");
// A landing whose rebase stopped on a conflict and was continued.
commit(MAIN, "conflict base", "conf.txt");
const cl = add("conflict-landed");
commit(cl, "task side", "conf.txt"), commit(MAIN, "main side", "conf.txt");
assert.notEqual(gq(cl, ["rebase", "-q", "main"]), 0);
put(join(cl, "conf.txt"), "resolved\n"), g(cl, ["add", "conf.txt"]), g(cl, ["rebase", "--continue"], { GIT_EDITOR: "true" }), land("c/conflict-landed"), state("conflict-landed");
// A merge stopped on a conflict: an operation in progress.
const mc = add("merge-conflict");
commit(mc, "mc side", "conf.txt"), commit(MAIN, "main again", "conf.txt"), assert.notEqual(gq(mc, ["merge", "-q", "main"]), 0), state("merge-conflict");
// Files: untracked, ignored, an ignored folder, a link, a nested repository, a changed mode.
put(join(add("untracked"), "u.txt"), "u\n"), state("untracked");
put(join(add("ignored"), ".env"), "secret\n"), state("ignored");
put(join(add("ignored-dir"), "ignored-dir", "x"), "x\n"), state("ignored-dir");
symlinkSync("a.txt", join(add("untracked-link"), "ln")), state("untracked-link");
const nested = join(add("nested-repo"), "nested");
mkdirSync(nested), g(nested, ["init", "-q"]), commit(nested, "inner"), state("nested-repo");
chmodSync(join(add("exec-bit"), "a.txt"), 0o755), state("exec-bit");
// The index: a staged rename, a staged edit with the disk back at HEAD's bytes.
g(add("staged-rename"), ["mv", "a.txt", "b.txt"]), state("staged-rename");
const di = add("dirty-index");
put(join(di, "a.txt"), "staged\n"), g(di, ["add", "a.txt"]), put(join(di, "a.txt"), "a\n"), state("dirty-index");
// Changes git status does not see: assume-unchanged, skip-worktree, an edit of the same size with its time set back.
const au = add("assume-unchanged");
g(au, ["update-index", "--assume-unchanged", "a.txt"]), put(join(au, "a.txt"), "hidden\n"), state("assume-unchanged");
const sw = add("skip-worktree");
g(sw, ["update-index", "--skip-worktree", "a.txt"]), put(join(sw, "a.txt"), "hidden\n"), state("skip-worktree");
const sh = add("stat-hidden");
const was = join(sh, "a.txt");
put(was, "b\n"), utimesSync(was, new Date(0), new Date(0)), state("stat-hidden");
// Bytes checkout converts: an eol=crlf file, landed, as checkout writes it.
const crlf = add("crlf");
put(join(crlf, ".gitattributes"), "c.txt eol=crlf\n"), put(join(crlf, "c.txt"), "one\ntwo\n"), g(crlf, ["add", "-A"]), g(crlf, ["commit", "-q", "-m", "crlf"]);
rmSync(join(crlf, "c.txt")), g(crlf, ["checkout", "--", "c.txt"]), land("c/crlf"), state("crlf");
// A moved folder: its entry names a path where nothing is.
const mv = add("moved");
renameSync(mv, join(DIR, "moved-elsewhere")), state("moved", { files: join(DIR, "moved-elsewhere"), design: "gone: its folder is not at its path, so nothing of it is read" });
// A submodule checked out in the worktree: its repository lives in the worktree's git folder.
const src = join(DIR, "src");
mkdirSync(src), g(src, ["init", "-q"]), commit(src, "s1");
const sm = add("submodule");
g(sm, ["submodule", "add", "-q", src, "sub"]), g(sm, ["commit", "-q", "-m", "sub"]), land("c/submodule"), state("submodule");
// Not marked: never touched.
const UNMARKED = [add("other-reason", undefined, "someone else"), add("unlocked", undefined, null)];
for (const u of UNMARKED) put(join(u, "u.txt"), "mine\n");

/** What `cwd`'s worktree holds that git and the disk can tell. @param {string} at where its files are */
function before(/** @type {string} */ at) {
  const h = head(at);
  return { head: h, index: index(at), tree: tree(at, h), files: listing(at), unreachable: unreachable(MAIN), refs: refs(MAIN), own: holds(at) };
}

/** What went since `was`, the worktree gone. @param {ReturnType<typeof before>} was @param {boolean} filesGone */
function lost(was, filesGone) {
  const now = unreachable(MAIN);
  const nowRefs = refs(MAIN);
  const out = [];
  for (const o of now) if (!was.unreachable.has(o)) out.push(`object ${o}`);
  for (const [r, oid] of was.refs) if (nowRefs.get(r) !== oid) out.push(`ref ${r}`);
  for (const oid of was.own) if ([...now].some((o) => o.endsWith(` ${oid}`))) out.push(`its own ref's object ${oid}`);
  for (const [p, e] of was.index) if (was.tree.get(p) !== e) out.push(`index ${p.replace("\0", " ")}`);
  for (const p of was.tree.keys()) if (!was.index.has(p)) out.push(`index ${p} deleted`);
  if (filesGone && was.head) {
    // What a checkout of its HEAD writes, in a worktree of its own made and removed here.
    const fresh = join(DIR, "fresh");
    g(MAIN, ["worktree", "add", "-q", "--detach", fresh, was.head]);
    const written = listing(fresh);
    g(MAIN, ["worktree", "remove", "--force", fresh]);
    for (const p of missingFrom(was.files, written)) out.push(`file ${p}`);
  } else if (filesGone) for (const p of missingFrom(was.files, new Map())) out.push(`file ${p}`);
  return out;
}

/** Removes the worktree at `path` whatever it holds: its folder, then git's entry. @param {string} path */
function force(path) {
  g(MAIN, ["worktree", "unlock", path]);
  rmSync(path, { recursive: true, force: true });
  g(MAIN, ["worktree", "prune", "--expire=now"]);
}

test("worktrees oracle: --remove removes only what loses nothing, and keeps only what would lose something or the design names", (t) => {
  const top = realpathSync(MAIN);
  const unmarkedBefore = UNMARKED.map(listing);
  const rows = [];
  const parted = [];
  for (const s of STATES) {
    const path = join(DIR, "wts", s.name);
    const was = before(s.files ?? path);
    const w = markedWorktrees(MAIN).marked.find((m) => m.path === path);
    assert.ok(w, `${s.name}: not found among the marked worktrees`);
    const done = removeWorktree(top, w);
    const verdict = done.removed ? "removed" : "verdict" in done ? ("unmeasured" in done.verdict ? `unmeasured: ${done.verdict.unmeasured}` : done.verdict.go ? "go?" : done.verdict.why) : `failed: ${done.error}`;
    if (!done.removed) force(path);
    const gone = lost(was, !s.files);
    rows.push(`${s.name}: ${verdict}; lost: ${gone.length ? gone.join(", ") : "nothing"}`);
    if (done.removed && gone.length) parted.push(`${s.name}: removed, and lost ${gone.join(", ")}`);
    if (!done.removed && !gone.length && verdict !== s.design?.split(":")[0]) parted.push(`${s.name}: kept (${verdict}), and removing it lost nothing`);
    if (s.design && done.removed) parted.push(`${s.name}: the design's keep is gone, it was removed: take it out of the corpus`);
    if (s.design && gone.length) parted.push(`${s.name}: named a keep of the design, but removing it lost ${gone.join(", ")}`);
  }
  for (const [i, u] of UNMARKED.entries()) assert.deepEqual(listing(u), unmarkedBefore[i], u);
  assert.ok(existsSync(join(DIR, "moved-elsewhere", "a.txt")));
  for (const r of rows) t.diagnostic(r);
  assert.deepEqual(parted, [], rows.join("\n"));
});
