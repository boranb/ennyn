import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { leftovers, recordStart, startPath } from "../metrics/leftovers.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const config = { paths: { stateDir: ".git/ennyn" } };
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-leftovers-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  /** @param {Record<string, string>} files @param {string} [cwd] */
  const put = (files, cwd = dir) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, p)), { recursive: true });
      writeFileSync(join(cwd, p), text);
    }
  };
  return {
    dir,
    put,
    /** Commits only what it is given: a sweep of the work tree is a case of its own. @param {Record<string, string>} files @param {string} [cwd] */
    commit(files, cwd = dir) {
      put(files, cwd);
      if (Object.keys(files).length) git(["add", "--", ...Object.keys(files)], { cwd });
      git([...ID, "commit", "-q", "--allow-empty", "-m", "chore: x"], { cwd });
      return git(["rev-parse", "HEAD"], { cwd });
    },
  };
}
const cli = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
/** The record of a tree is keyed by its top as git spells it (a temporary folder's real path on macOS). @param {string} dir */
const recordOf = (dir) => startPath(git(["rev-parse", "--show-toplevel"], { cwd: dir }), ".git/ennyn");

test("leftovers: untracked files: those of the start are not the cycle's; a new folder is one item; ignored ones are left out", () => {
  const r = repo();
  r.commit({ ".gitignore": "*.log\n", "a.txt": "1\n", "?? odd": "x\n" });
  r.put({ "old.txt": "\n", "lab/old.json": "\n" });
  recordStart({ cwd: r.dir, config });
  r.put({ "new.txt": "\n", "lab/new.json": "\n", "out/a.json": "\n", "out/deep/b.json": "\n", "run.log": "\n" });
  // A staged rename carries its source as a field of its own: a source named like an untracked entry is no such entry.
  git(["mv", "?? odd", "moved"], { cwd: r.dir });
  const res = leftovers({ cwd: r.dir, config });
  assert.equal(res.untracked.state, "found");
  assert.deepEqual(res.untracked.items, [
    { path: "lab/new.json", files: 1 },
    { path: "new.txt", files: 1 },
    { path: "out/", files: 2 },
  ]);
  assert.deepEqual(res.uncommitted.items, [{ code: "R ", path: "moved", from: "?? odd" }]);
  // Nothing is removed.
  for (const p of ["old.txt", "new.txt", "lab/new.json", "out/deep/b.json", "run.log"]) assert.ok(existsSync(join(r.dir, p)), p);
});

// Finding c19-t4-code-r1-03, the reviewer's probe S1: the closing's commit would take a staged file nobody was asked about.
test("leftovers: a new file staged and one added with intent to add, at the closing, are changes not committed", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n" });
  assert.equal(cli(r.dir, "leftovers", "--start").status, 0);
  r.put({ "stray.txt": "x\n", "intent.txt": "y\n" });
  git(["add", "stray.txt"], { cwd: r.dir });
  git(["add", "-N", "intent.txt"], { cwd: r.dir });
  const res = leftovers({ cwd: r.dir, config });
  assert.deepEqual([res.untracked.state, res.uncommitted.state], ["clean", "found"]);
  assert.deepEqual(res.uncommitted.items, [
    { code: " A", path: "intent.txt" },
    { code: "A ", path: "stray.txt" },
  ]);
  const close = cli(r.dir, "leftovers");
  assert.equal(close.status, 1);
  assert.match(close.stdout, /^ {2}A {2}stray\.txt$/m);
  assert.match(close.stdout, /^ {3}A intent\.txt$/m);
});

test("leftovers: changes not committed: modified, staged, deleted and renamed are listed; one of the start under the same code is not the cycle's", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n", "b.txt": "1\n", "c.txt": "1\n", "d.txt": "rename me\n", "e.txt": "1\n" });
  // The user's own work before the cycle: a.txt changed, e.txt staged.
  r.put({ "a.txt": "mine\n", "e.txt": "staged\n" });
  git(["add", "e.txt"], { cwd: r.dir });
  recordStart({ cwd: r.dir, config });
  r.put({ "a.txt": "mine, more\n", "b.txt": "2\n", "e.txt": "staged, then changed\n" });
  git(["rm", "-q", "--cached", "c.txt"], { cwd: r.dir });
  git(["mv", "d.txt", "d2.txt"], { cwd: r.dir });
  const res = leftovers({ cwd: r.dir, config });
  assert.equal(res.uncommitted.state, "found");
  assert.deepEqual(res.uncommitted.items, [
    { code: " M", path: "b.txt" },
    { code: "D ", path: "c.txt" },
    { code: "R ", path: "d2.txt", from: "d.txt" },
    { code: "MM", path: "e.txt" },
  ]);
  // c.txt left the index and stays on disk: untracked now, and new since the start.
  assert.deepEqual(res.untracked.items, [{ path: "c.txt", files: 1 }]);
});

// Finding c19-t4-code-r2-01, the reviewer's probes SW and SM: a commit that sweeps the work tree takes in what was
// untracked at the start, and the run that follows the closing's commit would read both parts clean.
test("leftovers: a file untracked at the start that HEAD now tracks is listed: a sweep took it in", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n", ".gitignore": "node_modules/\n" });
  r.put({ ".env.local": "TOKEN=x\n", "notes.md": "mine\n", "kept.txt": "still untracked\n" });
  // A nested repository is one untracked folder entry, even with every file listed.
  mkdirSync(join(r.dir, "vendor", "lib"), { recursive: true });
  git(["init", "-q"], { cwd: join(r.dir, "vendor", "lib") });
  writeFileSync(join(r.dir, "vendor", "lib", "x.js"), "\n");
  recordStart({ cwd: r.dir, config });
  assert.ok(JSON.parse(readFileSync(recordOf(r.dir), "utf8")).untracked.includes("vendor/lib/"));
  // SW: the closing's own commit sweeps (git add -A): the user's files go in with the handoff and a stray.
  r.put({ "scratch.mjs": "console.log(1)\n", ".ennyn/handoff.md": "next\n" });
  rmSync(join(r.dir, "vendor", "lib", ".git"), { recursive: true });
  git(["add", "-A", "--", ".env.local", "notes.md", "scratch.mjs", ".ennyn/handoff.md", "vendor"], { cwd: r.dir });
  git([...ID, "commit", "-q", "-m", "chore: cycle closed"], { cwd: r.dir });
  const res = leftovers({ cwd: r.dir, config });
  assert.equal(res.untracked.state, "found");
  assert.deepEqual(res.untracked.items, [
    { path: ".env.local", files: 1, committed: true },
    { path: "notes.md", files: 1, committed: true },
    { path: "vendor/lib/", files: 1, committed: true },
  ]);
  assert.equal(res.uncommitted.state, "clean");
  const close = cli(r.dir, "leftovers");
  assert.equal(close.status, 1);
  assert.match(close.stdout, /^ {2}notes\.md \(untracked at the start, now committed: a sweep took it in\?\)$/m);
  // SM: the start's untracked file committed by a task of the cycle.
  const m = repo();
  m.commit({ "a.txt": "1\n" });
  m.put({ "mine.txt": "user's file\n" });
  recordStart({ cwd: m.dir, config });
  m.commit({ "mine.txt": "user's file\n" });
  assert.deepEqual(leftovers({ cwd: m.dir, config }).untracked.items, [{ path: "mine.txt", files: 1, committed: true }]);
});

// Finding c19-t4-code-r2-02, the reviewer's submodule probe: a submodule's inner edit or stray read clean.
test("leftovers: a submodule whose own work tree changed is a change not committed", () => {
  const sub = repo();
  sub.commit({ "f.txt": "1\n" });
  const r = repo();
  r.commit({ "a.txt": "1\n" });
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.dir, "lib"], { cwd: r.dir });
  git([...ID, "commit", "-q", "-m", "chore: sub"], { cwd: r.dir });
  recordStart({ cwd: r.dir, config });
  assert.equal(leftovers({ cwd: r.dir, config }).uncommitted.state, "clean");
  writeFileSync(join(r.dir, "lib", "scratch.mjs"), "\n");
  assert.deepEqual(leftovers({ cwd: r.dir, config }).uncommitted.items, [{ code: " M", path: "lib" }]);
  writeFileSync(join(r.dir, "lib", "f.txt"), "edited inside the submodule\n");
  assert.deepEqual(leftovers({ cwd: r.dir, config }).uncommitted.items, [{ code: " M", path: "lib" }]);
});

// Finding c19-t4-code-r1-02, the reviewer's probes W1 and W2: linked worktrees share the state dir.
test("leftovers: each work tree keeps its own start: another tree's --start replaces nothing here", () => {
  for (const sideCommits of [false, true]) {
    const r = repo();
    r.commit({ "a.txt": "1\n" });
    assert.equal(cli(r.dir, "leftovers", "--start").status, 0);
    r.commit({ "lab.mjs": "console.log(1)\n" });
    const side = `${r.dir}-side`;
    git(["worktree", "add", "-q", "-b", "other", side], { cwd: r.dir });
    if (sideCommits) r.commit({ "b.txt": "1\n" }, side);
    const started = cli(side, "leftovers", "--start");
    assert.equal(started.status, 0, started.stderr);
    assert.doesNotMatch(started.stdout, /replaces/);
    assert.notEqual(recordOf(r.dir), recordOf(side));
    r.put({ "stray.txt": "\n" });
    const main = leftovers({ cwd: r.dir, config });
    assert.deepEqual([main.untracked.state, main.untracked.items], ["found", [{ path: "stray.txt", files: 1 }]]);
    const other = leftovers({ cwd: side, config });
    assert.deepEqual([other.untracked.state, other.uncommitted.state], ["clean", "clean"]);
    assert.equal(cli(side, "leftovers").status, 0);
  }
});

// Finding c19-t4-code-r1-07, the reviewer's big-record probe at a small scale: the writer holds the reader's limit.
test("leftovers: --start refuses a record past the size its reader takes, writes nothing, removes the tree's earlier record and names the HEAD", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n" });
  recordStart({ cwd: r.dir, config });
  const path = recordOf(r.dir);
  const old = readFileSync(path);
  for (let i = 0; i < 40; i++) r.put({ [`.venv/${"d".repeat(60)}/m${i}.py`]: "" });
  const head = git(["rev-parse", "HEAD"], { cwd: r.dir });
  // Finding c19-t4-code-r2-03, the reviewer's probe BR: the earlier record must not stand as this cycle's start, and
  // the message notes the HEAD step 1 relies on.
  assert.ok(old.length > 0);
  assert.throws(() => recordStart({ cwd: r.dir, config, limit: 2000 }), (e) => e instanceof RangeError && /2000 bytes/.test(e.message) && /40 untracked/.test(e.message) && e.message.includes(`HEAD ${head}`));
  assert.equal(existsSync(path), false);
  const after = leftovers({ cwd: r.dir, config });
  assert.deepEqual([after.start, after.untracked.state, after.untracked.why?.key], [null, "unmeasured", "leftovers.why.noRecord"]);
  // With no record before it, a refused start removes nothing and still says why.
  assert.throws(() => recordStart({ cwd: r.dir, config, limit: 2000 }), RangeError);
  // What the default limit takes, its reader takes.
  recordStart({ cwd: r.dir, config });
  assert.equal(leftovers({ cwd: r.dir, config }).untracked.state, "clean");
});

test("leftovers: with no record, or one that is no start record of this tree, the untracked part is unmeasured; the rest is still read", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n" });
  r.put({ "a.txt": "2\n" });
  const none = leftovers({ cwd: r.dir, config });
  assert.deepEqual([none.start, none.untracked.state, none.untracked.why?.key, none.uncommitted.state], [null, "unmeasured", "leftovers.why.noRecord", "found"]);
  recordStart({ cwd: r.dir, config });
  const path = recordOf(r.dir);
  const good = JSON.parse(readFileSync(path, "utf8"));
  for (const text of ["{", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, head: "main" }), JSON.stringify({ ...good, untracked: [1] }), JSON.stringify({ ...good, changed: undefined })]) {
    writeFileSync(path, text);
    const bad = leftovers({ cwd: r.dir, config });
    // With no start to read, no change is known to be the start's: a.txt, changed before the start, is listed.
    assert.deepEqual([bad.untracked.state, bad.untracked.why?.key, bad.uncommitted.items], ["unmeasured", "leftovers.why.badRecord", [{ code: " M", path: "a.txt" }]], text);
  }
  writeFileSync(path, JSON.stringify({ ...good, top: `${good.top}-elsewhere` }));
  assert.equal(leftovers({ cwd: r.dir, config }).untracked.why?.key, "leftovers.why.otherTree");
  // The record read, a.txt's change is the start's.
  writeFileSync(path, JSON.stringify(good));
  assert.deepEqual([leftovers({ cwd: r.dir, config }).untracked.state, leftovers({ cwd: r.dir, config }).uncommitted.state], ["clean", "clean"]);
});

test("cli: leftovers --start records, the closing lists each part as found, clean or unmeasured, exit 1 unless both are clean", () => {
  const r = repo();
  r.commit({ "a.txt": "1\n" });
  r.put({ "before.txt": "\n" });
  const none = cli(r.dir, "leftovers");
  assert.equal(none.status, 1, none.stderr);
  assert.match(none.stdout, /unmeasured/);
  const started = cli(r.dir, "leftovers", "--start");
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /untracked files: 1\b/);
  const record = JSON.parse(readFileSync(recordOf(r.dir), "utf8"));
  assert.ok(record.untracked.includes("before.txt"));
  const clean = cli(r.dir, "leftovers");
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(clean.stdout.match(/: clean$/gm)?.length, 2, clean.stdout);
  r.put({ "stray.txt": "\n", "a.txt": "2\n" });
  const found = cli(r.dir, "leftovers");
  assert.equal(found.status, 1);
  assert.match(found.stdout, /stray\.txt/);
  assert.match(found.stdout, /^ {3}M a\.txt$/m);
  assert.doesNotMatch(found.stdout, /before\.txt/);
  const json = JSON.parse(cli(r.dir, "leftovers", "--json").stdout);
  assert.deepEqual([json.untracked.state, json.uncommitted.state], ["found", "found"]);
  assert.equal(cli(r.dir, "leftovers", "--from", "HEAD").status, 2);
  // A second start in the same tree replaces its record, and says so; with no commit there is no start.
  assert.match(cli(r.dir, "leftovers", "--start").stdout, /^It replaces this work tree's record of [0-9a-f]{10} from /m);
  const empty = mkdtempSync(join(tmpdir(), "en-leftovers-empty-"));
  git(["init", "-q"], { cwd: empty });
  const unborn = cli(empty, "leftovers", "--start");
  assert.deepEqual([unborn.status, /HEAD names no commit/.test(unborn.stderr)], [1, true], unborn.stderr);
  assert.ok(existsSync(join(r.dir, "stray.txt")));
});

test("leftovers: started inside a bare-looking folder a clone brought in, it reads nothing there: its config's clean filter does not run", () => {
  // The folder, as plain files of a commit: HEAD, objects, refs, an index git must compare by content (read-tree writes
  // no stat data), and a config naming its own work tree inside it, or itself, and a clean filter that leaves a mark.
  // Below git 2.38 git takes it for a repository; from 2.38 safe.bareRepository, which Ennyn's git calls set, refuses it
  // first. Either way nothing runs, but only below 2.38 (the floor, 2.34.1) does this test hold topOf's own refusal.
  const box = mkdtempSync(join(tmpdir(), "en-leftovers-bare-"));
  const mark = join(box, "mark");
  const src = join(box, "src");
  mkdirSync(src);
  git(["init", "-q", "-b", "main"], { cwd: src });
  writeFileSync(join(src, ".gitattributes"), "f filter=x\n");
  writeFileSync(join(src, "f"), "hello\n");
  git(["add", "."], { cwd: src });
  git([...ID, "commit", "-q", "-m", "one"], { cwd: src });
  const outer = join(box, "outer");
  mkdirSync(outer);
  /** A bare-looking folder whose config names `worktree`, relative to it, as its work tree. @param {string} name @param {string} worktree */
  const folder = (name, worktree) => {
    const evil = join(outer, name);
    git(["clone", "-q", "--bare", src, evil], { cwd: box });
    git(["--git-dir", evil, "config", "filter.x.clean", `sh -c 'echo clean >> "${mark}"; cat'`], { cwd: box });
    mkdirSync(join(evil, worktree), { recursive: true });
    mkdirSync(join(evil, "refs", "heads"), { recursive: true });
    writeFileSync(join(evil, "refs", "heads", "main"), `${git(["--git-dir", evil, "rev-parse", "HEAD"], { cwd: box })}\n`);
    for (const f of ["f", ".gitattributes"]) writeFileSync(join(evil, worktree, f), readFileSync(join(src, f)));
    git(["--git-dir", evil, "--work-tree", join(evil, worktree), "read-tree", "HEAD"], { cwd: box });
    git(["--git-dir", evil, "config", "core.bare", "false"], { cwd: box });
    git(["--git-dir", evil, "config", "core.worktree", worktree], { cwd: box });
  };
  folder("evil", "w");
  folder("self", ".");
  folder("dotdot", "w/../w/.");
  // Its work tree the clone's top: git then finds the clone's own repository from there, which names no filter.
  folder("up", "..");
  // A committed link to a folder: the path the command starts in is not the one git reads.
  symlinkSync("evil", join(outer, "lnk"));
  git(["init", "-q", "-b", "main"], { cwd: outer });
  git(["add", "-A"], { cwd: outer });
  git([...ID, "commit", "-q", "-m", "brings the folders"], { cwd: outer });
  const clone = join(box, "clone");
  git(["clone", "-q", outer, clone], { cwd: box });
  try {
    // The folders are live: git with no setting of Ennyn's, started there, runs the filter.
    for (const at of ["evil/w", "self", "dotdot/w"]) {
      spawnSync("git", ["status", "--porcelain"], { cwd: join(clone, at), encoding: "utf8" });
      assert.equal(existsSync(mark), true, `git status in ${at} ran no filter: the folder is not read as a repository`);
      rmSync(mark);
    }
    for (const at of ["evil/w", "evil", "self", "dotdot/w", "dotdot", "lnk/w"].map((p) => join(clone, p))) {
      for (const args of [["leftovers", "--start"], ["leftovers"]]) {
        const r = cli(at, ...args);
        assert.notEqual(r.status, 0, `${args.join(" ")} in ${at}: ${r.stdout}`);
        assert.equal(existsSync(mark), false, `${args.join(" ")} in ${at} ran the folder's clean filter`);
      }
    }
    for (const name of ["evil", "self", "dotdot"]) assert.equal(existsSync(join(clone, name, "ennyn")), false, `nothing is written in ${name}`);
    // A work tree outside the folder reads the clone's own repository, whose config names no program: it records there.
    const up = cli(join(clone, "up"), "leftovers", "--start");
    assert.equal(existsSync(mark), false, "leftovers --start with the work tree outside the folder ran its filter");
    assert.equal(existsSync(join(clone, "up", "ennyn")), false, "nothing is written in the folder");
    assert.ok(up.status === 0 || /safe\.bareRepository|bare repository/.test(up.stderr), up.stderr);
    // GIT_DIR naming the folder, from the clone's top: the variable is dropped and the clone's own repository is read.
    const named = spawnSync(process.execPath, [CLI, "leftovers", "--start"], { cwd: clone, encoding: "utf8", env: { ...process.env, GIT_DIR: join(clone, "evil") } });
    assert.equal(named.status, 0, named.stderr);
    assert.equal(existsSync(mark), false, "GIT_DIR naming the folder ran its filter");
    // A linked worktree beside the clone: its git dir is in the clone's, its top is not.
    git(["worktree", "add", "-q", join(box, "linked")], { cwd: clone });
    const linked = cli(join(box, "linked"), "leftovers", "--start");
    assert.equal(linked.status, 0, linked.stderr);
    // A git dir kept apart whose path begins the work tree's, a folder apart: no folder lies in the other.
    const top = join(box, "ab");
    git(["init", "-q", "-b", "main", "--separate-git-dir", join(box, "a"), top], { cwd: box });
    git([...ID, "commit", "-q", "--allow-empty", "-m", "x"], { cwd: top });
    const apart = cli(top, "leftovers", "--start");
    assert.equal(apart.status, 0, apart.stderr);
    // A git dir kept inside the work tree: the work tree is not in it.
    const tree = join(box, "tree");
    git(["init", "-q", "-b", "main", "--separate-git-dir", join(tree, ".meta"), tree], { cwd: box });
    git([...ID, "commit", "-q", "--allow-empty", "-m", "x"], { cwd: tree });
    const inside = cli(tree, "leftovers", "--start");
    assert.equal(inside.status, 0, inside.stderr);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
