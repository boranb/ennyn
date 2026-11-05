/**
 * `ennyn worktrees`: which of the cycle's marked worktrees can go, and `--remove`. The states come from the labs of
 * cycle 19 (git 2.34.1, 2.39.5 and 2.56.0, each removed with `git worktree remove` and what was lost counted) and its
 * first review. A clean `git status` lost something in each of these: a change behind assume-unchanged or
 * skip-worktree, an untracked file under `status.showUntrackedFiles=no`, an in-place edit with its time set back under
 * `core.trustctime=false`, a `.git` entry below the top, output a clean filter drops; and so did a commit only the
 * worktree's own reflogs or refs held. Those are kept here, and the states that lose nothing go, a landing that
 * stopped on a conflict among them. A worktree without the mark is never touched: the mark is read from the common
 * git dir, so a path holding a line feed cannot forge one, as it can in `git worktree list --porcelain` without -z.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markedWorktrees, verdict } from "../plan/worktrees.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

/** An identity of its own (a container derives none), no maintenance racing the test's deletes. */
const SET = ["user.name=t", "user.email=t@t", "commit.gpgsign=false", "protocol.file.allow=always", "advice.detachedHead=false", "gc.auto=0", "maintenance.auto=false"].flatMap((kv) => ["-c", kv]);

/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
function g(cwd, args, env = {}) {
  // A limit: a git that opens a named pipe would wait on it for ever.
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** git that may fail: its exit code. @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
const gq = (cwd, args, env = {}) => spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).status;

/** A wait that holds the thread: an edit after it falls outside git's racy second. @param {number} ms */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** @param {string} cwd @param {string[]} args */
const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, "worktrees", ...args], { cwd, encoding: "utf8" });

/** @param {string} p @param {string} text */
const put = (p, text) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-wt-")));
  const main = join(dir, "main");
  mkdirSync(main);
  g(main, ["init", "-q", "-b", "main"]);
  put(join(main, "a.txt"), "a\n");
  put(join(main, ".gitignore"), ".env\nignored-dir/\n");
  g(main, ["add", "-A"]);
  g(main, ["commit", "-q", "-m", "base"]);
  /**
   * A worktree at `wts/<name>`, made as the cycle makes them: locked with the mark at creation (`reason` null: not locked).
   * @param {string} name @param {string[]} [how] @param {string | null} [reason] @param {string} [start] the commit it starts at
   */
  const add = (name, how = ["-b", `c/${name}`], reason = "ennyn:19", start) => {
    const path = join(dir, "wts", name);
    g(main, ["worktree", "add", "-q", ...(reason === null ? [] : ["--lock", "--reason", reason]), ...how, path, ...(start ? [start] : [])]);
    return path;
  };
  /** A commit in `cwd` that writes `file`. */
  const commit = (/** @type {string} */ cwd, /** @type {string} */ msg, file = "f.txt", env = {}) => {
    put(join(cwd, file), `${msg}\n`);
    g(cwd, ["add", "-A"], env);
    g(cwd, ["commit", "-q", "-m", msg], env);
    return g(cwd, ["rev-parse", "HEAD"]);
  };
  return { dir, main, add, commit };
}

/** What each reason says, in English: the key it comes from. */
const WHY = {
  unmeasured: /^unmeasured: /,
  gone: /its folder is gone/,
  here: /this command runs in it/,
  dup: /names the same folder/,
  state: /keeps state of its own/,
  staged: /its index differs from HEAD/,
  flagged: /are marked assume-unchanged or skip-worktree/,
  unborn: /it has no commit/,
  gitEntry: /is a \.git entry/,
  notInHead: /is not in HEAD/,
  missing: /is not on disk as HEAD has it/,
  link: /a link whose target differs/,
  mode: /another mode on disk/,
  special: /a pipe, a socket or a device/,
  differs: /^\S.* differs from what a checkout of HEAD writes$/,
  changed: /changed after it was checked/,
  notMerged: /is not merged/,
  detached: /^no branch, tag or other shared ref holds its commit \(a detached HEAD\): a reflog does not, it goes with its ref$/,
  leftBehind: /^\d+ commits only it holds: its HEAD reflog, ORIG_HEAD, REBASE_HEAD, FETCH_HEAD or its own refs and their reflogs name them, and no shared ref or reflog holds them$/,
};

/**
 * The verdict of each worktree under `wts/`, by name: "go", "removed" or the key of the reason it is kept.
 * @param {string} out @returns {Record<string, string>}
 */
function verdicts(out) {
  /** @type {Record<string, string>} */
  const got = {};
  for (const line of out.split("\n")) {
    const m = /^(can go|removed|kept): .*\/wts\/([^/\s"]+) \(ennyn:\d+\)(?:: (.*))?$/.exec(line);
    if (!m) continue;
    const why = m[3] ?? "";
    got[m[2]] = m[1] === "can go" ? "go" : m[1] === "removed" ? "removed" : (Object.entries(WHY).find(([, re]) => re.test(why))?.[0] ?? `? ${why}`);
  }
  return got;
}

test("worktrees: a marked worktree goes only when removing it loses nothing; each one kept says why", () => {
  const r = repo();
  const version = g(r.main, ["--version"]);
  // Repository-wide: untracked files hidden from a plain git status, a config of a worktree's own allowed.
  g(r.main, ["config", "status.showUntrackedFiles", "no"]);
  g(r.main, ["config", "extensions.worktreeConfig", "true"]);
  put(join(r.main, ".git", "info", "exclude"), "secret.key\n");
  // And a status that trusts the stat it recorded: a same-size edit with its time set back reads as clean.
  g(r.main, ["config", "core.trustctime", "false"]);
  g(r.main, ["config", "core.checkStat", "minimal"]);
  // A clean filter that drops lines, as a notebook filter drops output.
  g(r.main, ["config", "filter.strip.clean", "sed -e /^output/d"]);
  g(r.main, ["config", "filter.strip.smudge", "cat"]);
  g(r.main, ["config", "diff.ignoreSubmodules", "all"]);
  /** @type {Record<string, string>} */
  const want = {};
  const go = (/** @type {string} */ name) => (want[name] = "go");
  const keep = (/** @type {string} */ name, /** @type {keyof typeof WHY} */ why) => (want[name] = why);

  r.add("clean"), go("clean");
  const merged = r.add("merged");
  r.commit(merged, "merged"), g(r.main, ["merge", "-q", "--ff-only", "c/merged"]), go("merged");
  put(join(r.add("untracked"), "new.txt"), "n\n"), keep("untracked", "notInHead"); // and status.showUntrackedFiles=no
  put(join(r.add("env"), ".env"), "SECRET=1\n"), keep("env", "notInHead");
  put(join(r.add("excluded"), "secret.key"), "k\n"), keep("excluded", "notInHead");
  put(join(r.add("ignored-dir"), "ignored-dir", "data.bin"), "d\n"), keep("ignored-dir", "notInHead");
  put(join(r.add("modified"), "a.txt"), "changed\n"), keep("modified", "differs");
  const staged = r.add("staged");
  put(join(staged, "a.txt"), "staged\n"), g(staged, ["add", "a.txt"]), keep("staged", "staged");
  const nested = join(r.add("nested"), "inner");
  mkdirSync(nested), g(nested, ["init", "-q"]), r.commit(nested, "inner"), keep("nested", "gitEntry");
  // A .git entry that is no repository, and one that is a plain file: git status lists neither.
  put(join(r.add("dotgit-dir"), "vendor", "lib", ".git", "objects", "pack", "data.pack"), "bytes\n"), keep("dotgit-dir", "gitEntry");
  put(join(r.add("dotgit-file"), "notes", ".git"), "my notes\n"), keep("dotgit-file", "gitEntry");
  // Edited in place, same size, its time set back, past git's racy second: status reads it as clean.
  const stat = r.add("stat-edit");
  pause(1100);
  g(stat, ["status", "--porcelain"]);
  const file = join(stat, "a.txt");
  const was = statSync(file);
  writeFileSync(file, "Z\n"), utimesSync(file, was.atime, was.mtime), keep("stat-edit", "differs");
  const fifo = r.add("fifo");
  spawnSync("mkfifo", [join(fifo, "pipe")]), keep("fifo", "special");
  const exec = r.add("mode");
  chmodSync(join(exec, "a.txt"), 0o755), keep("mode", "mode");
  rmSync(join(r.add("missing"), "a.txt")), keep("missing", "missing");
  const asDir = r.add("file-now-dir");
  rmSync(join(asDir, "a.txt")), mkdirSync(join(asDir, "a.txt")), keep("file-now-dir", "missing");
  mkdirSync(join(r.add("empty-dir"), "emptydir")), go("empty-dir"); // no content: it may go
  r.commit(r.add("detached", ["--detach"]), "detached"), keep("detached", "detached");
  r.commit(r.add("own-branch"), "own-branch"), keep("own-branch", "notMerged");
  const snap = r.add("snapshot-only");
  r.commit(snap, "snapshot-only");
  // The task brief's snapshot ref holds the commit: not a branch, tag or remote branch.
  g(snap, ["update-ref", "refs/snapshot/t", g(snap, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "snapshot"])]), keep("snapshot-only", "notMerged");
  r.commit(r.add("tagged"), "tagged"), g(r.main, ["tag", "keep", "c/tagged"]), go("tagged");
  r.commit(r.add("elsewhere"), "elsewhere"), g(r.main, ["branch", "c/copy", "c/elsewhere"]), go("elsewhere");
  const gone = r.add("gone");
  r.commit(gone, "gone"), g(r.main, ["tag", "gone-keep", "c/gone"]), rmSync(gone, { recursive: true, force: true }), keep("gone", "gone");
  // The commit only the old value of the HEAD reflog's one line holds.
  const old = r.add("reflog-old", ["--detach"]);
  r.commit(old, "reflog-old"), rmSync(join(g(old, ["rev-parse", "--absolute-git-dir"]), "logs", "HEAD")), g(old, ["checkout", "-q", "--detach", "main"]), keep("reflog-old", "leftBehind");
  // The commit only the reflog of a ref of the worktree's own holds, the ref moved since.
  const wtlog = r.add("worktree-ref-log", ["--detach"]);
  g(wtlog, ["update-ref", "--create-reflog", "refs/worktree/keep", g(wtlog, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "worktree-ref-log"])]);
  g(wtlog, ["update-ref", "refs/worktree/keep", "main"]), keep("worktree-ref-log", "leftBehind");
  // A REBASE_HEAD left naming a commit nothing else holds (a rebase ended with its reflog gone).
  const rh = r.add("rebase-head", ["--detach"]);
  writeFileSync(join(g(rh, ["rev-parse", "--absolute-git-dir"]), "REBASE_HEAD"), g(rh, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "rebase-head"]) + "\n"), keep("rebase-head", "leftBehind");
  const reflog = r.add("reflog-only", ["--detach"]);
  r.commit(reflog, "reflog-only"), g(reflog, ["checkout", "-q", "--detach", "main"]), keep("reflog-only", "leftBehind");
  const own = r.add("worktree-ref", ["--detach"]);
  g(own, ["update-ref", "refs/worktree/keep", r.commit(own, "worktree-ref")]), g(own, ["checkout", "-q", "--detach", "main"]), keep("worktree-ref", "leftBehind");
  // No reflog: ORIG_HEAD alone holds the commit a reset left. git appends to a reflog that is there whatever
  // core.logAllRefUpdates says, so the one the worktree was made with goes first.
  const orig = r.add("orig-head", ["--detach"]);
  const off = ["-c", "core.logAllRefUpdates=false"];
  rmSync(join(g(orig, ["rev-parse", "--absolute-git-dir"]), "logs", "HEAD"));
  put(join(orig, "f.txt"), "orig-head\n"), g(orig, ["add", "-A"]), g(orig, [...off, "commit", "-q", "-m", "orig-head"]), g(orig, [...off, "reset", "-q", "--hard", "main"]), keep("orig-head", "leftBehind");
  const assume = r.add("assume");
  g(assume, ["update-index", "--assume-unchanged", "a.txt"]), put(join(assume, "a.txt"), "hidden\n"), keep("assume", "flagged");
  const skip = r.add("skip");
  g(skip, ["update-index", "--skip-worktree", "a.txt"]), put(join(skip, "a.txt"), "hidden\n"), keep("skip", "flagged");
  const rebase = r.add("rebase");
  r.commit(rebase, "rebase one", "f1.txt"), r.commit(rebase, "rebase two", "f2.txt"), g(r.main, ["tag", "rebase-keep", "c/rebase"]);
  g(rebase, ["rebase", "-q", "-i", "main"], { GIT_SEQUENCE_EDITOR: "sed -i.bak 1s/^pick/edit/", GIT_EDITOR: "true" }), keep("rebase", "state");
  g(r.add("wt-config"), ["config", "--worktree", "lab.keep", "yes"]), keep("wt-config", "state");
  const unborn = r.add("unborn", ["--detach"]);
  g(unborn, ["checkout", "-q", "--orphan", "c/orphan"]), g(unborn, ["rm", "-q", "-r", "-f", "."]), keep("unborn", "unborn");
  const amended = r.add("amended");
  r.commit(amended, "amended"), put(join(amended, "f.txt"), "amended again\n"), g(amended, ["commit", "-q", "-a", "--amend", "-m", "amended again"]), g(r.main, ["merge", "-q", "--ff-only", "c/amended"]), go("amended");
  const rebased = r.add("rebased");
  r.commit(rebased, "rebased", "r.txt"), r.commit(r.main, "main moves", "m.txt"), g(rebased, ["rebase", "-q", "main"]), g(r.main, ["merge", "-q", "--ff-only", "c/rebased"]), go("rebased");
  const dtb = r.add("detached-then-branch", ["--detach"]);
  r.commit(dtb, "detached-then-branch", "d.txt"), g(dtb, ["checkout", "-q", "-b", "c/dtb"]), g(r.main, ["merge", "-q", "--ff-only", "c/dtb"]), go("detached-then-branch");
  const stashed = r.add("stashed");
  put(join(stashed, "a.txt"), "stashed\n"), g(stashed, ["stash", "-q"]), go("stashed");
  r.add("cycle-7", ["-b", "c/cycle-7"], "ennyn:7"), go("cycle-7");
  // A landing whose rebase stopped on a conflict, with rerere on: REBASE_HEAD, AUTO_MERGE and MERGE_RR stay behind.
  r.commit(r.main, "conflict base", "conf.txt");
  const landed = r.add("conflict-landed");
  r.commit(landed, "task side", "conf.txt"), r.commit(r.main, "main side", "conf.txt");
  const rerere = { GIT_EDITOR: "true", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "rerere.enabled", GIT_CONFIG_VALUE_0: "true" };
  assert.notEqual(gq(landed, ["rebase", "-q", "main"], rerere), 0);
  put(join(landed, "conf.txt"), "resolved\n"), g(landed, ["add", "conf.txt"], rerere), g(landed, ["rebase", "--continue"], rerere);
  g(r.main, ["merge", "-q", "--ff-only", "c/conflict-landed"]), go("conflict-landed");
  // A mutation run's worktree, detached at its task's commit; the task amends and lands: only its branch's reflog holds
  // the commit the worktree is at, and that goes with the branch (git branch -d), so it is kept. One at the branch's tip goes.
  const task = r.add("mt-task");
  r.commit(task, "mt-task", "mt.txt");
  r.add("mutation", ["--detach"], undefined, "c/mt-task");
  put(join(task, "mt.txt"), "mt-task amended\n"), g(task, ["commit", "-q", "-a", "--amend", "-m", "mt-task amended"]), g(r.main, ["merge", "-q", "--ff-only", "c/mt-task"]);
  r.add("mutation-tip", ["--detach"], undefined, "c/mt-task");
  go("mt-task"), keep("mutation", "detached"), go("mutation-tip");
  // A detached HEAD a shared ref other than a branch or tag holds goes: a snapshot ref, the stash.
  const dsnap = r.add("detached-snapshot", ["--detach"]);
  g(dsnap, ["update-ref", "refs/snapshot/d", r.commit(dsnap, "detached-snapshot")]), go("detached-snapshot");
  const dstash = r.add("detached-stash", ["--detach"]);
  r.commit(dstash, "detached-stash"), put(join(dstash, "a.txt"), "stashed\n"), g(dstash, ["stash", "-q"]), go("detached-stash");
  // A fetch in the worktree: FETCH_HEAD is its own (three gits). A fetched commit that only it names keeps the worktree.
  g(r.add("fetched"), ["fetch", "-q", r.main, "main"]), go("fetched");
  const other = join(r.dir, "other");
  mkdirSync(other), g(other, ["init", "-q"]), r.commit(other, "other");
  g(r.add("fetched-other"), ["fetch", "-q", other, "HEAD"]), keep("fetched-other", "leftBehind");
  // HEAD holds a link: the same target goes, another keeps it; a notebook's output a filter drops keeps it.
  const kit = r.add("links", ["-b", "c/links"]);
  symlinkSync("a.txt", join(kit, "ln")), put(join(kit, ".gitattributes"), "*.ipynb filter=strip\n"), put(join(kit, "nb.ipynb"), "code\n");
  // Names git's stdin readers would take otherwise: a leading quote, a line feed.
  put(join(kit, '"q" name.txt'), "q\n"), put(join(kit, "odd\nname.txt"), "odd\n");
  g(kit, ["add", "-A"]), g(kit, ["commit", "-q", "-m", "links"]), g(r.main, ["tag", "links", "c/links"]), go("links");
  const relink = r.add("link-changed", ["--detach"], undefined, "links");
  rmSync(join(relink, "ln")), symlinkSync("missing.txt", join(relink, "ln")), keep("link-changed", "link");
  const toFile = r.add("link-now-file", ["--detach"], undefined, "links");
  rmSync(join(toFile, "ln")), put(join(toFile, "ln"), "a\n"), keep("link-now-file", "notInHead");
  symlinkSync("a.txt", join(r.add("new-link"), "ln2")), keep("new-link", "notInHead");
  const nb = r.add("filtered", ["--detach"], undefined, "links");
  put(join(nb, "nb.ipynb"), "code\noutput 42 from a long run\n"), keep("filtered", "differs");
  // The folder replaced by a link to where it went, and a .git that is a named pipe: neither is followed or read.
  const moved = r.add("symlinked");
  renameSync(moved, `${moved}-real`), symlinkSync(`${moved}-real`, moved), keep("symlinked", "gone");
  const piped = r.add("fifo-git");
  // Two of git's entries name one folder: a marked copy, and the original locked by someone else with a commit only
  // its HEAD reflog holds. git may act on either, so the marked one is kept.
  const twin = r.add("twin", ["--detach"], "someone else");
  r.commit(twin, "twin"), g(twin, ["checkout", "-q", "--detach", "main"]);
  const admins = join(r.main, ".git", "worktrees");
  cpSync(join(admins, "twin"), join(admins, "twin-copy"), { recursive: true });
  writeFileSync(join(admins, "twin-copy", "locked"), "ennyn:19\n"), rmSync(join(admins, "twin-copy", "logs"), { recursive: true });
  writeFileSync(join(twin, ".git"), `gitdir: ${join(admins, "twin-copy")}\n`), keep("twin", "dup");
  // A submodule's repository lives in the worktree's own git folder; git refuses to remove it anyway.
  const src = join(r.dir, "subsrc");
  mkdirSync(src), g(src, ["init", "-q"]), r.commit(src, "s1");
  const sub = r.add("submodule");
  g(sub, ["submodule", "add", "-q", src, "sub"]), g(sub, ["commit", "-q", "-m", "sub"]), g(r.main, ["branch", "c/sub-copy", "c/submodule"]), keep("submodule", "state");
  // A repository already in the worktree, added as a submodule, keeps its git folder inside: only the status check sees
  // a commit in it, and its ignore setting hides it from a plain status.
  const emb = r.add("embedded");
  const inner = join(emb, "emb");
  mkdirSync(inner), g(inner, ["init", "-q"]), r.commit(inner, "emb one");
  g(emb, ["submodule", "add", "-q", src, "emb"]), g(emb, ["commit", "-q", "-m", "emb"]), g(r.main, ["branch", "c/embedded-copy", "c/embedded"]);
  g(r.main, ["config", "submodule.emb.ignore", "all"]), r.commit(inner, "emb two"), keep("embedded", "gitEntry");
  // A staged gitlink change that .gitmodules' ignore=all hides from a plain diff-index (diff.ignoreSubmodules does not):
  // the submodule is not checked out, its folder empty, and a branch holds the commit.
  const gl = r.add("gitlink-ignored");
  const sha = (/** @type {string} */ m) => g(gl, ["commit-tree", "HEAD^{tree}", "-m", m]);
  put(join(gl, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./nowhere\n\tignore = all\n'), mkdirSync(join(gl, "sub"));
  g(gl, ["update-index", "--add", "--cacheinfo", `160000,${sha("gitlink one")},sub`]), g(gl, ["add", ".gitmodules"]), g(gl, ["commit", "-q", "-m", "gitlink"]);
  g(gl, ["update-index", "--cacheinfo", `160000,${sha("gitlink two")},sub`]), g(r.main, ["branch", "c/gitlink-copy", "c/gitlink-ignored"]), keep("gitlink-ignored", "staged");
  // git 2.48 and later can write the paths relative.
  const [maj, min] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  if (maj > 2 || (maj === 2 && min >= 48)) r.add("relative", ["--relative-paths", "-b", "c/relative"]), go("relative");
  // Not marked: never listed, never touched. "line" is the folder a forged path names in list --porcelain.
  r.add("other-reason", undefined, "someone else");
  r.add("spaced", undefined, " ennyn:19");
  r.add("unlocked", undefined, null);
  r.add("line", ["--detach"], null);
  r.add("line\nlocked ennyn:19", ["--detach"], null);
  g(r.main, ["worktree", "lock", r.add("no-reason", undefined, null)]);
  // Last, so no git call of the setup meets it.
  rmSync(join(piped, ".git")), spawnSync("mkfifo", [join(piped, ".git")]), keep("fifo-git", "gone");

  const listed = cli(r.main);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(verdicts(listed.stdout), want, listed.stdout);
  assert.match(listed.stdout, /^7 other linked worktrees carry no mark: left alone\.$/m);
  for (const name of ["other-reason", "spaced", "unlocked", "line", "no-reason"]) assert.doesNotMatch(listed.stdout, new RegExp(`/wts/${name}\\b`));

  // What git can no longer reach after the removal, reflogs of every worktree counted, is what it lost: nothing.
  const unreachable = () => g(r.main, ["fsck", "--unreachable", "--no-progress"]).split("\n").filter(Boolean).sort();
  const before = unreachable();
  const removed = cli(r.main, "--remove");
  assert.equal(removed.status, 0, removed.stderr);
  const after = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v === "go" ? "removed" : v]));
  assert.deepEqual(verdicts(removed.stdout), after, removed.stdout);
  assert.deepEqual(unreachable(), before);
  for (const [name, v] of Object.entries(want)) if (name !== "gone") assert.equal(existsSync(join(r.dir, "wts", name)), v !== "go", name);
  assert.ok(existsSync(join(admins, "twin", "locked")) && existsSync(join(r.dir, "wts", "symlinked-real", "a.txt")));
  // What stays keeps its files and its mark; the worktrees without the mark keep their locks.
  assert.equal(readFileSync(join(r.dir, "wts", "assume", "a.txt"), "utf8"), "hidden\n");
  assert.deepEqual(verdicts(cli(r.main).stdout), Object.fromEntries(Object.entries(want).filter(([, v]) => v !== "go")));
  const porcelain = g(r.main, ["worktree", "list", "--porcelain"]);
  for (const reason of ["locked someone else", "locked ennyn:19", "worktree " + join(r.dir, "wts", "line")]) assert.ok(porcelain.includes(reason), reason);
  assert.ok(existsSync(join(r.dir, "wts", "line\nlocked ennyn:19")));
});

test("worktrees: --remove with paths removes only those; a path without the mark is said and left, exit 1", () => {
  const r = repo();
  const a = r.add("a");
  const b = r.add("b");
  const plain = r.add("plain", undefined, null);
  const run = cli(r.main, "--remove", a, plain);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^removed: .*\/wts\/a \(ennyn:19\)$/m);
  assert.match(run.stdout, /^not a worktree with Ennyn's mark, left alone: .*\/wts\/plain$/m);
  assert.match(run.stderr, /could not be checked or removed/);
  assert.doesNotMatch(run.stdout, /other linked worktrees/);
  assert.deepEqual([existsSync(a), existsSync(b), existsSync(plain)], [false, true, true]);
});

test("worktrees: when a step of the removal fails, the line says what is true: git's entry, the mark, the folder", () => {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = mkdtempSync(join(tmpdir(), "en-wt-bin-"));
  // git as it is, but the subcommands FAIL_ON names exit 128, as a refusal does; DROP is a folder deleted first, as a
  // removal that dropped git's entry and then failed leaves it.
  put(join(bin, "git"), `#!/bin/sh\nfor f in $FAIL_ON; do case " $* " in *" worktree $f "*) [ -n "$DROP" ] && rm -rf "$DROP"; echo "fatal: refused $f" >&2; exit 128 ;; esac; done\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const line = (/** @type {string} */ step, /** @type {string} */ entry, /** @type {string} */ folder) => new RegExp(`^.*/wts/a \\(ennyn:19\\): the removal did not finish \\(fatal: refused ${step}\\); ${entry}; ${folder}$`, "m");
  const relocked = "git still lists it, locked with its mark again";
  // Unlocked once the folder moved aside is deleted, so the mark holds the entry until then; git drops the entry last.
  const cases = [
    ["unlock", "", line("unlock", relocked, "its folder is gone"), false, true],
    ["remove", "", line("remove", relocked, "its folder is gone"), false, true],
    ["remove lock", "", line("remove", "git still lists it, but its mark could not be put back, so git no longer keeps it from pruning", "its folder is gone"), false, false],
    ["remove", "admin", line("remove", "git no longer lists it, and its mark went with that entry", "its folder is gone"), false, false],
  ];
  for (const [fail, drop, said, folder, locked] of cases) {
    const r = repo();
    const a = r.add("a");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAIL_ON: String(fail), DROP: drop === "admin" ? join(r.main, ".git", "worktrees", "a") : "" };
    const run = spawnSync(process.execPath, [CLI, "worktrees", "--remove"], { cwd: r.main, encoding: "utf8", env });
    assert.equal(run.status, 1, String(fail));
    assert.match(run.stdout, /** @type {RegExp} */ (said));
    assert.match(run.stderr, /each line above says what is true of it/);
    assert.deepEqual([existsSync(a), readdirSync(join(r.dir, "wts"))], [folder, folder ? ["a"] : []], String(fail));
    assert.equal(g(r.main, ["worktree", "list", "--porcelain"]).includes("locked ennyn:19"), locked, String(fail));
  }
});

test("worktrees: a folder that cannot be moved aside is kept whole; a delete that stops partway says where the rest is", (t) => {
  // Root moves and deletes anyway (a container's user): there both worktrees go.
  const root = process.getuid?.() === 0;
  const r = repo();
  const a = r.add("a");
  mkdirSync(join(r.dir, "locked-parent"));
  const b = r.add(join("..", "locked-parent", "b"), ["-b", "c/b"]);
  // A tracked file in a folder that cannot be written: the check reads it, the delete cannot unlink it.
  const c = r.add("c");
  put(join(c, "ro", "x.txt"), "x\n"), g(c, ["add", "-A"]), g(c, ["commit", "-q", "-m", "ro"]), g(r.main, ["merge", "-q", "--ff-only", "c/c"]);
  chmodSync(join(c, "ro"), 0o555), chmodSync(join(r.dir, "locked-parent"), 0o555);
  t.after(() => (chmodSync(join(r.dir, "locked-parent"), 0o755), existsSync(join(r.dir, "wts")) && readdirSync(join(r.dir, "wts")).forEach((n) => existsSync(join(r.dir, "wts", n, "ro")) && chmodSync(join(r.dir, "wts", n, "ro"), 0o755))));
  const run = cli(r.main, "--remove");
  assert.equal(run.status, root ? 0 : 1, run.stdout + run.stderr);
  if (root) return assert.deepEqual([existsSync(a), existsSync(b), existsSync(c)], [false, false, false]);
  assert.match(run.stdout, /^removed: .*\/wts\/a \(ennyn:19\)$/m);
  assert.match(run.stdout, /^kept: .*\/locked-parent\/b \(ennyn:19\): it could not be moved aside for its removal \(EACCES\); nothing was removed$/m);
  const left = /^.*\/wts\/c \(ennyn:19\): the removal did not finish \(EACCES.*\); git still lists it, locked with its mark again; its folder, whole or what a failed delete left of it \(which matched HEAD when checked\), is at (.*\/wts\/\.c\.ennyn-removing-[0-9a-f]{8})$/m.exec(run.stdout);
  assert.ok(left, run.stdout);
  assert.deepEqual([existsSync(b), existsSync(c), readFileSync(join(left[1], "ro", "x.txt"), "utf8")], [true, false, "x\n"]);
  // Not moved aside is not removed: the command did not do what it was asked, alone too.
  const alone = cli(r.main, "--remove", b);
  assert.deepEqual([alone.status, /could not be checked or removed/.test(alone.stderr)], [1, true], alone.stdout);
  assert.ok(g(r.main, ["worktree", "list", "--porcelain"]).includes(`worktree ${c}\nHEAD`));
});

test("worktrees: the worktree the command runs in is kept; with no mark anywhere it says so", () => {
  const r = repo();
  // A file among git's worktree entries is no worktree's.
  put(join(r.main, ".git", "worktrees", "stray"), "x\n");
  const none = cli(r.main);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /^No worktree carries Ennyn's mark/m);
  assert.doesNotMatch(none.stdout, /other linked worktrees/);
  const a = r.add("a");
  const run = cli(a, "--remove");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(verdicts(run.stdout), { a: "here" });
  assert.ok(existsSync(a));
  // Through a link to it, it is the same folder.
  symlinkSync(a, join(r.dir, "link"));
  assert.deepEqual(verdicts(cli(join(r.dir, "link")).stdout), { a: "here" });
  // From the main worktree it goes.
  assert.deepEqual(verdicts(cli(r.main, "--remove").stdout), { a: "removed" });
});

test("worktrees: a worktree named in another case is the folder the command runs in only on a disk that ignores case", () => {
  const r = repo();
  mkdirSync(join(r.dir, "wts"));
  // Whether this disk ignores case: the answer differs by platform (macOS by default yes, Linux no).
  const folds = existsSync(join(r.dir, "WTS"));
  r.add(join("..", "WTS", "a"), ["--detach"]);
  // Where cases are told apart, wts/a is a worktree of its own (case-sensitive APFS, git 2.34.1, 2.39.5, 2.56.0).
  if (!folds) r.add("a", ["--detach"]);
  const run = cli(join(r.dir, "wts", "a"), "--remove");
  assert.equal(run.status, 0, run.stderr);
  if (folds) assert.match(run.stdout, /this command runs in it/);
  else assert.match(run.stdout, /^removed: .*\/WTS\/a \(ennyn:19\)\nkept: .*\/wts\/a \(ennyn:19\): this command runs in it$/m);
  assert.ok(existsSync(join(r.dir, "wts", "a")));
  assert.equal(existsSync(join(r.dir, "WTS", "a")), folds);
});

test("worktrees: a folder in the worktree that cannot be read keeps it, unmeasured, exit 1", (t) => {
  const r = repo();
  const a = r.add("a");
  put(join(a, "secret", "key"), "k\n");
  chmodSync(join(a, "secret"), 0o000);
  t.after(() => chmodSync(join(a, "secret"), 0o755));
  const run = cli(r.main, "--remove");
  // Root reads it anyway (a container's user): there the file is what keeps it.
  const root = process.getuid?.() === 0;
  assert.equal(run.status, root ? 0 : 1, run.stderr);
  assert.match(run.stdout, root ? /secret\/key is not in HEAD/ : /kept: .*\/wts\/a \(ennyn:19\): unmeasured: secret could not be read/);
  chmodSync(join(a, "secret"), 0o755);
  assert.equal(readFileSync(join(a, "secret", "key"), "utf8"), "k\n");
  // A tracked file of another size than its blob is answered without reading it.
  const b = r.add("b");
  put(join(b, "a.txt"), "longer than a\n");
  chmodSync(join(b, "a.txt"), 0o000);
  t.after(() => chmodSync(join(b, "a.txt"), 0o644));
  const sized = cli(r.main, "--remove", b);
  assert.equal(sized.status, 0, sized.stderr);
  assert.deepEqual(verdicts(sized.stdout), { b: "differs" }, sized.stdout);
});

test("worktrees: a file checkout writes through a filter, ident, a line-ending setting or as a plain link goes when it equals what checkout writes; an edit is kept and named", () => {
  /** Each setting is the repository's (a worktree's own config is state that keeps it): one repository for each. */
  const cases = [];
  // Attributes: eol=crlf (as Gradle's .bat files have), a smudge and clean pair (as LFS has), ident.
  const attrs = repo();
  // And a smudge filter whose output passes the file's size by more than git's stderr room: that output is not read whole.
  put(join(attrs.main, ".gitattributes"), "*.bat text eol=crlf\n*.dat filter=up\n*.id ident\n*.big filter=grow\n");
  g(attrs.main, ["config", "filter.up.clean", "tr A-Z a-z"]), g(attrs.main, ["config", "filter.up.smudge", "tr a-z A-Z"]);
  g(attrs.main, ["config", "filter.grow.clean", "head -n 1"]), g(attrs.main, ["config", "filter.grow.smudge", "cat; head -c 70000 /dev/zero"]);
  put(join(attrs.main, "gradlew.bat"), "@echo off\nrem two\n"), put(join(attrs.main, "data.dat"), "lower case\n"), put(join(attrs.main, "v.id"), "$Id$\nbody\n"), put(join(attrs.main, "x.big"), "big\n");
  g(attrs.main, ["add", "-A"]), g(attrs.main, ["commit", "-q", "-m", "attributes"]);
  cases.push([attrs, { attrs: "go", "attrs-edit": "differs", "grow-edit": "differs" }, { "attrs-edit": "gradlew.bat", "grow-edit": "x.big" }]);
  attrs.add("attrs");
  put(join(attrs.add("attrs-edit"), "gradlew.bat"), "@echo off\r\nrem edited\r\n");
  put(join(attrs.add("grow-edit"), "x.big"), "b\n");
  // core.autocrlf=true: every text file is written with CRLF; a binary file as it is.
  const crlf = repo();
  writeFileSync(join(crlf.main, "img.bin"), Buffer.from([0, 1, 2, 10, 13, 10, 255]));
  g(crlf.main, ["add", "-A"]), g(crlf.main, ["commit", "-q", "-m", "binary"]), g(crlf.main, ["config", "core.autocrlf", "true"]);
  cases.push([crlf, { crlf: "go", "crlf-text-edit": "differs", "crlf-binary-edit": "differs" }, { "crlf-text-edit": "a.txt", "crlf-binary-edit": "img.bin" }]);
  crlf.add("crlf");
  put(join(crlf.add("crlf-text-edit"), "a.txt"), "edited\n");
  writeFileSync(join(crlf.add("crlf-binary-edit"), "img.bin"), Buffer.from([0, 1, 2, 10, 13, 10, 254]));
  // core.symlinks=false (Git for Windows' default): a link is written as a plain file holding its target.
  const nolinks = repo();
  symlinkSync("a.txt", join(nolinks.main, "ln")), g(nolinks.main, ["add", "-A"]), g(nolinks.main, ["commit", "-q", "-m", "link"]), g(nolinks.main, ["config", "core.symlinks", "false"]);
  cases.push([nolinks, { nolinks: "go", "nolinks-edit": "differs" }, { "nolinks-edit": "ln" }]);
  assert.equal(readFileSync(join(nolinks.add("nolinks"), "ln"), "utf8"), "a.txt");
  writeFileSync(join(nolinks.add("nolinks-edit"), "ln"), "b.txt");
  // Every case is run before the comparison, so a failure shows them all.
  /** @type {Record<string, string>} */
  const got = {};
  /** @type {Record<string, string>} */
  const expected = {};
  for (const [r, want, named] of /** @type {[ReturnType<typeof repo>, Record<string, string>, Record<string, string>][]} */ (cases)) {
    const run = cli(r.main, "--remove");
    for (const [name, v] of Object.entries(verdicts(run.stdout))) got[name] = v === "differs" ? `differs: ${new RegExp(`/wts/${name} \\(ennyn:19\\): (.*) differs from`).exec(run.stdout)?.[1]}` : v;
    for (const [name, v] of Object.entries(want)) {
      expected[name] = v === "go" ? "removed" : `differs: ${named[name]}`;
      got[`${name} is there`] = String(existsSync(join(r.dir, "wts", name)));
      expected[`${name} is there`] = String(v !== "go");
    }
    got[`${Object.keys(want)[0]}: exit`] = `${run.status} ${run.stderr}`;
    expected[`${Object.keys(want)[0]}: exit`] = "0 ";
  }
  assert.deepEqual(got, expected);
});

test("worktrees: the executable bit on disk keeps a worktree wherever the disk keeps one, under core.fileMode=false too; on win32 no bit is read, and links HEAD holds go as anywhere", () => {
  const r = repo();
  put(join(r.main, "run.sh"), "#!/bin/sh\n"), g(r.main, ["add", "run.sh"]), g(r.main, ["update-index", "--chmod=+x", "run.sh"]), g(r.main, ["commit", "-q", "-m", "exec"]);
  // Links HEAD holds, on a tag of their own: one to a folder, one to a file, one that leads nowhere. The removal
  // unlinks each, so none keeps a worktree, on win32 neither.
  g(r.main, ["checkout", "-q", "-b", "links"]);
  put(join(r.main, "sub", "x.txt"), "x\n"), symlinkSync("sub", join(r.main, "dir-link")), g(r.main, ["add", "-A"]), g(r.main, ["commit", "-q", "-m", "dir link"]), g(r.main, ["tag", "dir-link"]);
  g(r.main, ["rm", "-q", "dir-link"]), symlinkSync("a.txt", join(r.main, "file-link")), g(r.main, ["add", "-A"]), g(r.main, ["commit", "-q", "-m", "file link"]), g(r.main, ["tag", "file-link"]);
  g(r.main, ["rm", "-q", "file-link"]), symlinkSync("nowhere", join(r.main, "lost-link")), g(r.main, ["add", "-A"]), g(r.main, ["commit", "-q", "-m", "lost link"]), g(r.main, ["tag", "lost-link"]);
  g(r.main, ["checkout", "-q", "main"]);
  // A setting that hides the bit from git status: removing the folder still loses a bit set or cleared by hand.
  g(r.main, ["config", "core.fileMode", "false"]);
  chmodSync(join(r.add("bit-lost"), "run.sh"), 0o644);
  chmodSync(join(r.add("bit-gained"), "a.txt"), 0o755);
  // A mode change staged and not on disk: the index differs from HEAD.
  g(r.add("staged"), ["update-index", "--chmod=-x", "run.sh"]);
  r.add("clean");
  r.add("dir-link", ["--detach"], undefined, "dir-link");
  r.add("file-link", ["--detach"], undefined, "file-link");
  r.add("lost-link", ["--detach"], undefined, "lost-link");
  assert.equal(g(join(r.dir, "wts", "bit-lost"), ["status", "--porcelain"]), "");
  const listed = cli(r.main);
  assert.equal(listed.status, 0, listed.stderr);
  const linux = { "bit-lost": "mode", "bit-gained": "mode", staged: "staged", clean: "go", "dir-link": "go", "file-link": "go", "lost-link": "go" };
  assert.deepEqual(verdicts(listed.stdout), linux, listed.stdout);
  // The same worktrees read as on Windows, whose disk keeps no bit: what git status there sees decides.
  const top = realpathSync(r.main);
  /** @param {string} platform */
  const on = (platform) => Object.fromEntries(markedWorktrees(r.main).marked.map((w) => { const v = verdict(top, w, [], platform); return [w.id, v.go ? "go" : "why" in v ? `${v.why}${v.vars?.path ? ` ${v.vars.path}` : ""}` : `unmeasured ${v.unmeasured}`]; }));
  assert.deepEqual(on("linux"), { ...linux, "bit-lost": "mode run.sh", "bit-gained": "mode a.txt" });
  assert.deepEqual(on("win32"), { ...linux, "bit-lost": "go", "bit-gained": "go" });
  const removed = cli(r.main, "--remove");
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(readdirSync(join(r.dir, "wts")).sort(), ["bit-gained", "bit-lost", "staged"]);
  assert.equal(statSync(join(r.dir, "wts", "bit-gained", "a.txt")).mode & 0o777, 0o755);
});

/**
 * Removes the worktree at `path` in a process of its own, `fs.rmSync` wrapped by `mode`: "link" makes a link to `out`
 * in the folder moved aside, as a process still running in it would, right before the delete; "mkdir" makes a folder at
 * the old path right after it; "die" stops the process before the delete, as a kill or a crash would. `fs.renameSync`
 * too: "refuse:<code>" fails the move aside with that code; "backfail" writes a file in the moved folder, then fails the
 * move back. `platform` is the one the removal reads.
 */
const HARNESS = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [mod, main, path, mode, out, platform] = JSON.parse(String(process.env.HARNESS_ARGS));
const rm = fs.rmSync;
const mv = fs.renameSync;
let moves = 0;
fs.renameSync = (a, b) => {
  moves++;
  if (mode.startsWith("refuse:")) throw Object.assign(new Error(mode), { code: mode.slice(7) });
  if (mode === "backfail" && moves === 2) throw Object.assign(new Error("EPERM: refused"), { code: "EPERM" });
  const r = mv(a, b);
  if (mode === "backfail") fs.writeFileSync(join(b, "late.txt"), "late\\n");
  return r;
};
fs.rmSync = (p, o) => {
  if (mode === "link") fs.symlinkSync(out, join(p, "node_modules"));
  if (mode === "die") process.exit(9);
  const r = rm(p, o);
  if (mode === "mkdir") fs.mkdirSync(path);
  return r;
};
syncBuiltinESMExports();
const { markedWorktrees, removeWorktree } = await import(pathToFileURL(mod).href);
const w = markedWorktrees(main).marked.find((m) => m.path === path);
console.log(JSON.stringify(removeWorktree(fs.realpathSync(main), w, platform)));
`;

test("worktrees: the removal never enters a link, never hands git a path something new holds, and a stopped one is named", () => {
  const mod = join(dirname(CLI), "..", "plan", "worktrees.mjs");
  const r = repo();
  const out = join(r.dir, "outside");
  put(join(out, "deep", "keep.txt"), "keep\n");
  const harness = (/** @type {string} */ path, /** @type {string} */ mode, platform = process.platform) => spawnSync(process.execPath, ["--input-type=module", "-e", HARNESS], { cwd: r.main, encoding: "utf8", env: { ...process.env, HARNESS_ARGS: JSON.stringify([mod, r.main, path, mode, out, platform]) } });
  // A link HEAD holds to a folder outside goes, as anywhere: the delete unlinks it.
  g(r.main, ["checkout", "-q", "-b", "held"]), symlinkSync(out, join(r.main, "ext")), g(r.main, ["add", "ext"]), g(r.main, ["commit", "-q", "-m", "ext"]), g(r.main, ["tag", "held"]), g(r.main, ["checkout", "-q", "main"]);
  const held = r.add("held", ["--detach"], undefined, "held");
  assert.deepEqual(verdicts(cli(r.main, "--remove", held).stdout), { held: "removed" });
  const late = harness(r.add("late"), "link");
  assert.equal(late.stdout.trim(), JSON.stringify({ removed: true }), late.stderr);
  // Something new at its old path is never handed to git: the entry stays, locked, and the new folder is left alone.
  const reborn = r.add("reborn");
  const made = JSON.parse(harness(reborn, "mkdir").stdout);
  assert.deepEqual([made.error, made.entry, made.folder], ["something new is at its path, so git was not asked to drop its entry", "relocked", "gone"]);
  // A move aside refused: a process holding something in it is said only where Windows refuses for that.
  const refused = r.add("refused");
  const why = (/** @type {string} */ mode, /** @type {string} */ platform) => JSON.parse(harness(refused, mode, platform).stdout).verdict;
  assert.deepEqual(
    [why("refuse:EPERM", "win32"), why("refuse:EBUSY", "win32"), why("refuse:EACCES", "win32"), why("refuse:ENAMETOOLONG", "win32"), why("refuse:EPERM", "linux")],
    [...["EPERM", "EBUSY", "EACCES"].map((error) => ({ go: false, why: "busy", vars: { error } })), ...["ENAMETOOLONG", "EPERM"].map((error) => ({ go: false, why: "notMoved", vars: { error } }))],
  );
  // Changed after the check and not moved back: said as a change, left locked, where it is.
  const changed = r.add("changed");
  const back = JSON.parse(harness(changed, "backfail").stdout);
  assert.deepEqual([back.error, back.entry, back.folder, readFileSync(join(back.aside, "late.txt"), "utf8")], ["it changed after it was checked, and could not be moved back", "relocked", "changed", "late\n"]);
  assert.match(cli(r.main, "--remove", changed).stdout, /: its folder was moved aside for removal and is at .*\/wts\/\.changed\.ennyn-removing-[0-9a-f]{8}: look, then delete it or move it back$/m);
  // Stopped before the delete: the entry keeps its mark, and the check names where the folder went.
  const stopped = r.add("stopped");
  assert.equal(harness(stopped, "die").status, 9);
  const aside = readdirSync(join(r.dir, "wts")).filter((n) => n.startsWith(".stopped.ennyn-removing-"));
  assert.equal(aside.length, 1);
  const entry = g(r.main, ["worktree", "list", "--porcelain"]).split("\n\n").find((b) => b.startsWith(`worktree ${stopped}\n`));
  assert.match(String(entry), /^locked ennyn:19$/m);
  const listed = cli(r.main);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes(`kept: ${stopped} (ennyn:19): its folder was moved aside for removal and is at ${join(r.dir, "wts", aside[0])}: look, then delete it or move it back\n`), listed.stdout);
  assert.deepEqual([readdirSync(join(r.dir, "wts")).sort(), readdirSync(reborn), readFileSync(join(out, "deep", "keep.txt"), "utf8")], [[aside[0], back.aside.split("/").pop(), "refused", "reborn"].sort(), [], "keep\n"]);
  // Something else at its path: that is what the check names, not a folder beside it.
  mkdirSync(stopped);
  assert.equal(verdicts(cli(r.main).stdout).stopped, "gone");
});

test("worktrees: what is written in a worktree after its check and before git removes it keeps it", () => {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = mkdtempSync(join(tmpdir(), "en-wt-late-"));
  // git as it is; once hash-object, the check's read of the files, is done, the worktree changes: LATE a file it did not
  // hold (an ignored one, which git worktree remove deletes without a word), EDIT a file rewritten in place at its size,
  // DROP a file deleted. Once rev-list, the check's last call (whether a shared ref or reflog holds its own commits), is
  // done: COMMIT a commit on its detached HEAD, which only its HEAD and reflog hold.
  const late = `[ -n "$LATE" ] && mkdir -p "$(dirname "$LATE")" && printf 'late\\n' > "$LATE"; [ -n "$EDIT" ] && printf 'Z\\n' > "$EDIT"; [ -n "$DROP" ] && rm "$DROP"`;
  const commit = `[ -n "$COMMIT" ] && '${real}' -C "$COMMIT" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m late`;
  put(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" hash-object "*) '${real}' "$@"; s=$?; ${late}; exit $s ;; *" rev-list "*) '${real}' "$@"; s=$?; ${commit}; exit $s ;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const r = repo();
  const at = (/** @type {string} */ name, /** @type {Record<string, string>} */ env, how = ["-b", `c/${name}`]) => {
    const path = r.add(name, how);
    const run = spawnSync(process.execPath, [CLI, "worktrees", "--remove", path], { cwd: r.main, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, join(path, v)])) } });
    return [run.status, /: (\S+) changed after it was checked/.exec(run.stdout)?.[1] ?? run.stdout, existsSync(path)];
  };
  // Every case runs before the comparison, so a failure shows them all. An ignored folder the walk meets last; the
  // last entry gone, so the second walk is shorter and the same as far as it goes; the commit changes the git folder.
  const got = {
    "new-file": at("new-file", { LATE: ".env" }),
    "in-place": at("in-place", { EDIT: "a.txt" }),
    last: at("last", { LATE: "ignored-dir/late" }),
    dropped: at("dropped", { DROP: "a.txt" }),
    commit: at("commit", { COMMIT: "." }, ["--detach"]).map((v) => (typeof v === "string" && v.startsWith(".git/") ? ".git/" : v)),
  };
  assert.deepEqual(got, { "new-file": [0, ".env", true], "in-place": [0, "a.txt", true], last: [0, "ignored-dir", true], dropped: [0, "a.txt", true], commit: [0, ".git/", true] });
});

test("worktrees: a worktree whose refs are in a reftable is kept, exit 1: its reflogs are not read, and git below 2.45 refuses the repository", () => {
  const [maj, min] = (/(\d+)\.(\d+)/.exec(g(tmpdir(), ["--version"])) ?? []).slice(1).map(Number);
  // The answer depends on the git version: reftable came in 2.45.
  const old = maj === 2 && min < 45;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-wt-rt-")));
  const main = join(dir, "main");
  mkdirSync(main);
  g(main, ["init", "-q", "-b", "main", ...(old ? [] : ["--ref-format=reftable"])]);
  put(join(main, "a.txt"), "a\n"), g(main, ["add", "-A"]), g(main, ["commit", "-q", "-m", "base"]);
  const a = join(dir, "wts", "a");
  g(main, ["worktree", "add", "-q", "--lock", "--reason", "ennyn:19", "--detach", a]);
  put(join(a, "f.txt"), "only in the reflog\n"), g(a, ["add", "-A"]), g(a, ["commit", "-q", "-m", "only in the reflog"]), g(a, ["checkout", "-q", "--detach", "main"]);
  // Below 2.45 the config a reftable repository carries: git 2.34.1 and 2.39.5 refuse it before they read a ref, as
  // they refuse one 2.56.0 made, and the command stops with git's words, listing nothing.
  if (old) g(main, ["config", "core.repositoryformatversion", "1"]), g(main, ["config", "extensions.refStorage", "reftable"]);
  const run = cli(main, "--remove");
  assert.equal(run.status, 1, run.stderr);
  if (old) assert.match(run.stderr, /unknown repository extension found:[\s\S]*refstorage/), assert.equal(run.stdout, "");
  else assert.match(run.stdout, /unmeasured: its refs and reflogs are in reftable/);
  assert.ok(existsSync(a));
});
