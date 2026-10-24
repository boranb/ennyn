import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import * as hookModule from "../setup/hook.mjs";
import { HOOK_MARKER, hookScript, hookStatus, installHook } from "../setup/hook.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

/** A repository whose config declares commit types, so the hook has something to reject. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-hook-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" } }));
  return dir;
}

/** @param {string} dir @param {string} message */
function commit(dir, message) {
  writeFileSync(join(dir, "a.txt"), String(Math.random()));
  git(["add", "-A"], { cwd: dir });
  return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
}

test("hook: installs once, runs on every commit, rejects an untyped subject and lets a typed one through", () => {
  const dir = repo();
  const first = installHook({ cwd: dir, cliPath: CLI });
  assert.equal(first.result, "installed");
  assert.ok(statSync(first.path).mode & 0o100, "executable");
  assert.ok(readFileSync(first.path, "utf8").includes(HOOK_MARKER));
  assert.equal(hookStatus(dir).state, "ennyn");
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "unchanged");
  assert.equal(installHook({ cwd: dir, cliPath: CLI + ".moved" }).result, "updated");
  installHook({ cwd: dir, cliPath: CLI });

  const bad = commit(dir, "added a page");
  assert.notEqual(bad.status, 0, "untyped subject is rejected");
  assert.match(bad.stderr, /commitMsg\.types \(feat, fix\)/);
  const good = commit(dir, "feat: a page");
  assert.equal(good.status, 0, good.stderr);
  assert.equal(git(["log", "--format=%s"], { cwd: dir }), "feat: a page");
});

test("hook: never over a hook it did not write; a project's own hook that runs commit-check counts as wired", () => {
  const dir = repo();
  const path = hookStatus(dir).path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho theirs\n");
  assert.deepEqual([installHook({ cwd: dir, cliPath: CLI }).result, readFileSync(path, "utf8")], ["other", "#!/bin/sh\necho theirs\n"]);
  writeFileSync(path, '#!/bin/sh\nnode tools/ennyn/scripts/ennyn.mjs commit-check "$1"\n');
  // Executable, as git runs only such a hook (a mode given to writeFileSync holds only for a new file).
  chmodSync(path, 0o755);
  assert.equal(hookStatus(dir).state, "wired");
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "wired");
});

test("hook: a core.hooksPath directory (usually tracked) gets no machine-specific path written into it", () => {
  const dir = repo();
  git(["config", "core.hooksPath", ".githooks"], { cwd: dir });
  const res = installHook({ cwd: dir, cliPath: CLI });
  assert.deepEqual([res.result, res.hooksPath], ["hooksPath", ".githooks"]);
  assert.ok(!existsSync(join(dir, ".githooks", "commit-msg")));
});

test("hook: a moved CLI or a missing node lets the commit through with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-hook-script-"));
  const hook = join(dir, "commit-msg");
  writeFileSync(hook, hookScript(join(dir, "gone", "ennyn.mjs")));
  writeFileSync(join(dir, "msg"), "anything\n");
  const moved = spawnSync("sh", [hook, join(dir, "msg")], { encoding: "utf8" });
  assert.deepEqual([moved.status, /not found; commit message not checked/.test(moved.stderr)], [0, true]);
  const noNode = spawnSync("/bin/sh", [hook, join(dir, "msg")], { env: { ...process.env, PATH: "/nonexistent" }, encoding: "utf8" });
  assert.deepEqual([noNode.status, /node not found/.test(noNode.stderr)], [0, true]);
  // A quote in the path survives the shell.
  assert.match(hookScript("/a/it's here/ennyn.mjs"), /cli='\/a\/it'\\''s here\/ennyn\.mjs'/);
});

test("hook: installed from a linked worktree, it lands in the shared hooks directory", () => {
  const dir = repo();
  assert.equal(commit(dir, "feat: base").status, 0);
  const wt = join(mkdtempSync(join(tmpdir(), "en-hook-wt-")), "wt");
  git(["worktree", "add", "-q", wt], { cwd: dir });
  const res = installHook({ cwd: wt, cliPath: CLI });
  assert.equal(res.result, "installed");
  assert.equal(hookStatus(dir).state, "ennyn", "the main checkout sees the same hook");
});

test("hook: git commit --fixup and --squash still work with the hook in place (autosquash folds them away)", () => {
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI });
  assert.equal(commit(dir, "feat: base").status, 0);
  const base = git(["rev-parse", "HEAD"], { cwd: dir });
  for (const flag of [`--fixup=${base}`, `--squash=${base}`]) {
    writeFileSync(join(dir, "a.txt"), String(Math.random()));
    git(["add", "-A"], { cwd: dir });
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-edit", flag], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
  }
  assert.deepEqual(git(["log", "--format=%s"], { cwd: dir }).split("\n"), ["squash! feat: base", "fixup! feat: base", "feat: base"]);
});

test("doctor: declared commit types without a hook warn; with the hook installed they pass", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  const keys = async () => (await checkSetup({ cwd: dir, env: {} })).items.map((i) => `${i.level} ${i.key}`);
  assert.ok((await keys()).includes("warn doctor.hookMissing"));
  installHook({ cwd: dir, cliPath: CLI });
  assert.ok((await keys()).includes("ok doctor.hookOk"));
  git(["config", "core.hooksPath", ".githooks"], { cwd: dir });
  assert.ok((await keys()).includes("warn doctor.hookPath"));
  // The project's own tracked hook that runs commit-check is as good as ours.
  mkdirSync(join(dir, ".githooks"));
  // Executable, as git runs only such a hook.
  writeFileSync(join(dir, ".githooks", "commit-msg"), "#!/bin/sh\nnode tools/ennyn/scripts/ennyn.mjs commit-check \"$1\"\n", { mode: 0o755 });
  assert.ok((await keys()).includes("ok doctor.hookOk"));
});

test("hook: husky's stubs are not ours to edit; .husky/commit-msg running commit-check counts as wired, for install and doctor", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  mkdirSync(join(dir, ".husky", "_"), { recursive: true });
  writeFileSync(join(dir, ".husky", "_", "commit-msg"), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', { mode: 0o755 });
  git(["config", "core.hooksPath", ".husky/_"], { cwd: dir });
  const bare = installHook({ cwd: dir, cliPath: CLI });
  assert.deepEqual([bare.result, bare.hooksKind], ["hooksPath", "husky"]);
  assert.equal(readFileSync(join(dir, ".husky", "_", "commit-msg"), "utf8"), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', "stub untouched");
  writeFileSync(join(dir, ".husky", "commit-msg"), 'npx ennyn commit-check "$1"\n');
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "wired");
  const items = (await checkSetup({ cwd: dir, env: {} })).items.map((i) => `${i.level} ${i.key}`);
  assert.ok(items.includes("ok doctor.hookOk"), items.join("\n"));
});

test("hook: a global core.hooksPath (outside the repository) is reported as such, with a line that survives the shell", () => {
  const dir = repo();
  const global = mkdtempSync(join(tmpdir(), "en-global-hooks-"));
  git(["config", "core.hooksPath", global], { cwd: dir });
  const res = installHook({ cwd: dir, cliPath: '/opt/it\'s "x"/$HOME/ennyn.mjs' });
  assert.deepEqual([res.result, res.hooksKind], ["hooksPath", "global"]);
  assert.equal(res.line, `node '/opt/it'\\''s "x"/$HOME/ennyn.mjs' commit-check --hook "$1"`);
  assert.ok(!existsSync(join(global, "commit-msg")));
  // The quoted line is one argument to sh: echo it back through a shell to be sure.
  const echoed = spawnSync("sh", ["-c", res.line.replace(/^node /, "printf '%s' ").replace(/ commit-check --hook "\$1"$/, "")], { encoding: "utf8" });
  assert.equal(echoed.stdout, `/opt/it's "x"/$HOME/ennyn.mjs`);
});

test("hook: a config that does not load lets the commit through with a warning, so the fix can be committed", () => {
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI });
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat"], typo: 1 } }));
  const r = commit(dir, "anything at all");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /config does not load, so this commit was not checked: not its message, not its lines/);
  // Run by hand (no --hook), the same config is still an error.
  writeFileSync(join(dir, "MSG"), "x\n");
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", join(dir, "MSG")], { cwd: dir }).status, 1);
});

test("hook: an amend! commit is checked for the message it will put into history", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix", style: "terse" } }));
  installHook({ cwd: dir, cliPath: CLI });
  assert.equal(commit(dir, "feat: base").status, 0);
  const prose = commit(dir, "amend! feat: base\n\nfeat: better base\n\nrewrote everything here as prose");
  assert.notEqual(prose.status, 0, "the prose body would land in history at autosquash, unchecked");
  assert.equal(commit(dir, "amend! feat: base\n\nfeat: better base").status, 0);
});

test("hook: a pattern in the config that does not compile warns instead of locking commits", () => {
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI });
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { skipSubjects: ["^(Merge "] } }));
  const r = commit(dir, "anything");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /was not checked/);
});

test("hook: amend! and squash! are checked as the message history will hold, with the target's paths", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"] }, review: { impactRequiredGlobs: ["src/**"] } }));
  // An old untyped commit, made before the hook: its subject is already history.
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "old.js"), "1\n");
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "old untyped work"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  writeFileSync(join(dir, "src", "a.js"), "1\n");
  git(["add", "-A"], { cwd: dir });
  const guarded = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: guarded\n\nImpact: S1 one reader"], { cwd: dir, encoding: "utf8" });
  assert.equal(guarded.status, 0, guarded.stderr);
  const run = (/** @type {string[]} */ ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...args], { cwd: dir, encoding: "utf8" });
  // An empty amend! that rewords the guarded commit must keep its Impact line, also next to a file named
  // like the target's hash (git stops on an ambiguous argument unless the revision ends at --).
  const named = join(dir, git(["rev-parse", "HEAD"], { cwd: dir }));
  writeFileSync(named, "");
  assert.notEqual(run("--allow-empty", "-m", "amend! feat: guarded\n\nfeat: guarded, reworded").status, 0, "the Impact line would vanish at autosquash");
  rmSync(named);
  assert.equal(run("--allow-empty", "-m", "amend! feat: guarded\n\nfeat: guarded, reworded\n\nImpact: S1 one reader").status, 0);
  // A squash! onto the old untyped commit is not blamed for the old subject.
  assert.equal(run("--allow-empty", "-m", "squash! old untyped work\n\nRoot cause: z").status, 0);
  // A squash! that stages a guarded path is covered by the target's own Impact line.
  writeFileSync(join(dir, "src", "a.js"), "2\n");
  git(["add", "-A"], { cwd: dir });
  assert.equal(run("-m", "squash! feat: guarded\n\nRoot cause: y").status, 0);
});

test("hook: an amend! onto a commit whose path holds a quote or a tab still needs that path's Impact line", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"] }, review: { impactRequiredGlobs: ["src/**"] } }));
  installHook({ cwd: dir, cliPath: CLI });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", 'we"ird\tname.js'), "1\n");
  git(["add", "-A"], { cwd: dir });
  const run = (/** @type {string[]} */ ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(run("-m", "feat: odd name\n\nImpact: S1 one reader").status, 0);
  // git quotes such a path unless asked for -z; quoted, it matches no glob and the Impact line was not asked for.
  assert.notEqual(run("--allow-empty", "-m", "amend! feat: odd name\n\nfeat: odd name, reworded").status, 0);
});

test("hook: a hooks path inside the repository, named through a link and not created yet, is still the repository's", () => {
  const dir = repo();
  // mkdtemp under /var on macOS: /var is a link to /private/var, and git prints the real top level.
  git(["config", "core.hooksPath", join(dir, ".githooks")], { cwd: dir });
  assert.equal(hookStatus(dir).hooksKind, "repo");
});

test("hook: a cochange warning shows on the commit, which goes through", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" }, review: { cochange: [{ paths: ["a.txt"], docs: ["b.md"] }] } }));
  installHook({ cwd: dir, cliPath: CLI });
  const r = commit(dir, "feat: change a");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^Warning: a\.txt changed, but not b\.md\. /m);
});

test("hook: a file moved out of a rule's paths or a guarded path is still a change there, whatever diff.renames says", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" }, review: { impactRequiredGlobs: ["core/**"], cochange: [{ paths: ["core/**"], docs: ["DESIGN.md"] }] } }));
  mkdirSync(join(dir, "core"));
  writeFileSync(join(dir, "core", "a.mjs"), "export const a = 1;\n".repeat(20));
  writeFileSync(join(dir, "DESIGN.md"), "# d\n");
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: base\n\nImpact: S1 none"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  git(["config", "diff.renames", "true"], { cwd: dir });
  mkdirSync(join(dir, "lib"));
  git(["mv", "core/a.mjs", "lib/a.mjs"], { cwd: dir });
  const moved = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: move a"], { cwd: dir, encoding: "utf8" });
  assert.equal(moved.status, 1, "the move out of core/ needs an Impact line");
  assert.match(moved.stderr, /impact table \(core\/a\.mjs\)/);
  assert.match(moved.stderr, /^Warning: core\/a\.mjs changed, but not DESIGN\.md\. /m);
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: move a\n\nImpact: S1 none"], { cwd: dir, encoding: "utf8" }).status, 0);
  // An amend! of the move carries the old name too: rewording it keeps the Impact line.
  const reword = (/** @type {string} */ body) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", `amend! feat: move a\n\n${body}`], { cwd: dir, encoding: "utf8" });
  assert.notEqual(reword("feat: move a out of core").status, 0, "the Impact line would vanish at autosquash");
  assert.equal(reword("feat: move a out of core\n\nImpact: S1 none").status, 0);
});

test("hook: a chained squash! finds the commit autosquash folds into, and that commit's documents count", () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" }, review: { cochange: [{ paths: ["core/**"], docs: ["DESIGN.md"] }] } }));
  mkdirSync(join(dir, "core"));
  writeFileSync(join(dir, "core", "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(dir, "DESIGN.md"), "# d\n");
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: module a"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  const squash = (/** @type {string} */ n) => {
    writeFileSync(join(dir, "core", "a.mjs"), `export const a = ${n};\n`);
    git(["add", "-A"], { cwd: dir });
    return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--squash=HEAD", "-m", `step ${n}`], { cwd: dir, encoding: "utf8" });
  };
  const first = squash("2");
  assert.deepEqual([first.status, first.stderr], [0, ""]);
  // git writes "squash! squash! feat: module a"; autosquash folds it into feat: module a, which holds DESIGN.md.
  const second = squash("3");
  assert.equal(git(["log", "-1", "--format=%s"], { cwd: dir }), "squash! squash! feat: module a");
  assert.deepEqual([second.status, second.stderr], [0, ""]);
});

test("doctor audit: a hook whose CLI is gone, or one git does not run (not executable, a husky stub never generated), is no ✓; install-hook makes it run again", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  const keys = async () => (await checkSetup({ cwd: dir, env: {} })).items.map((i) => `${i.level} ${i.key}`);
  const hook = join(dir, ".git", "hooks", "commit-msg");
  // Installed from a copy of Ennyn that has since moved: every commit goes through unchecked.
  installHook({ cwd: dir, cliPath: join(dir, "moved", "it's here", "ennyn.mjs") });
  assert.equal(hookStatus(dir).cli, join(dir, "moved", "it's here", "ennyn.mjs"), "the path as the script quotes it");
  assert.ok((await keys()).includes("warn doctor.hookCliGone"));
  // A directory in the CLI's place is no CLI: the hook itself asks [ -f "$cli" ].
  mkdirSync(join(dir, "moved", "it's here", "ennyn.mjs"), { recursive: true });
  assert.ok((await keys()).includes("warn doctor.hookCliGone"), "a directory is no CLI");
  assert.equal(commit(dir, "untyped subject").status, 0, "the stale hook lets it through");
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "updated");
  assert.ok((await keys()).includes("ok doctor.hookOk"));
  // Not executable: git skips it with a hint, and checks nothing.
  if (process.platform !== "win32") {
    chmodSync(hook, 0o644);
    assert.ok((await keys()).includes("warn doctor.hookNotRun"));
    assert.equal(commit(dir, "untyped again").status, 0, "git ran no hook");
    assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "updated", "install-hook does not call an idle hook unchanged");
    assert.ok(statSync(hook).mode & 0o100);
    assert.ok((await keys()).includes("ok doctor.hookOk"));
    assert.notEqual(commit(dir, "untyped once more").status, 0, "it runs again");
  }
  // husky's hooks path with .husky/commit-msg wired, but the stub husky generates on install not there yet.
  const husky = repo();
  writeFileSync(join(husky, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  mkdirSync(join(husky, ".husky"));
  writeFileSync(join(husky, ".husky", "commit-msg"), 'npx ennyn commit-check "$1"\n');
  git(["config", "core.hooksPath", ".husky/_"], { cwd: husky });
  assert.ok((await checkSetup({ cwd: husky, env: {} })).items.some((i) => i.key === "doctor.hookAbsent"));
});

test("doctor audit: review.impactRequiredGlobs with no hook is a rule on paper too", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-hook-impact-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ review: { impactRequiredGlobs: ["src/**"] } }));
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  const keys = async () => (await checkSetup({ cwd: dir, env: {} })).items.map((i) => `${i.level} ${i.key}`);
  assert.ok((await keys()).includes("warn doctor.hookMissing"));
  installHook({ cwd: dir, cliPath: CLI });
  assert.ok((await keys()).includes("ok doctor.hookOk"));
});

test("install-hook audit (review): for every hook state doctor and install-hook agree: a ✓ is nothing to do, a warning is fixed or refused with why", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  /** @param {string} dir */
  const hookLine = async (dir) => (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key.startsWith("doctor.hook"));
  /** @param {string} dir */
  const install = (dir) => spawnSync(process.execPath, [CLI, "install-hook"], { cwd: dir, encoding: "utf8" });
  /** @param {(dir: string) => void} make */
  const state = (make) => {
    const dir = repo();
    writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
    make(dir);
    return dir;
  };
  const wiredLine = '#!/bin/sh\nnode tools/ennyn/scripts/ennyn.mjs commit-check "$1"\n';
  const cases = [
    { name: "a wired hook at 0644", want: "doctor.hookNotRun", says: /not executable.*chmod \+x/, make: (/** @type {string} */ d) => writeFileSync(join(d, ".git", "hooks", "commit-msg"), wiredLine, { mode: 0o644 }) },
    {
      name: "a wired tracked hook at 0644 under core.hooksPath",
      want: "doctor.hookNotRun",
      says: /not executable/,
      make: (/** @type {string} */ d) => {
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), wiredLine, { mode: 0o644 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    {
      name: "husky's .husky/commit-msg with no generated stub",
      want: "doctor.hookAbsent",
      says: /is not there.*husky/,
      make: (/** @type {string} */ d) => {
        mkdirSync(join(d, ".husky"));
        writeFileSync(join(d, ".husky", "commit-msg"), 'npx ennyn commit-check "$1"\n');
        git(["config", "core.hooksPath", ".husky/_"], { cwd: d });
      },
    },
    {
      name: "an Ennyn script under core.hooksPath whose CLI moved",
      want: "doctor.hookCliGone",
      says: /which is not there/,
      make: (/** @type {string} */ d) => {
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript(join(d, "gone", "ennyn.mjs")), { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    {
      name: "an Ennyn script under core.hooksPath that runs",
      want: "doctor.hookOk",
      says: /already runs commit-check/,
      make: (/** @type {string} */ d) => {
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript(CLI), { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    { name: "a wired hook that runs", want: "doctor.hookOk", says: /already runs commit-check/, make: (/** @type {string} */ d) => writeFileSync(join(d, ".git", "hooks", "commit-msg"), wiredLine, { mode: 0o755 }) },
  ];
  for (const c of cases) {
    if (process.platform === "win32" && c.want === "doctor.hookNotRun") continue;
    const dir = state(c.make);
    assert.equal((await hookLine(dir))?.key, c.want, c.name);
    const before = hookStatus(dir);
    const r = install(dir);
    assert.match(r.stdout, c.says, `${c.name}: ${r.stdout}`);
    assert.equal(r.status, c.want === "doctor.hookOk" ? 0 : 1, `${c.name}: a warning doctor gives is no "nothing to do"`);
    assert.doesNotMatch(r.stdout, c.want === "doctor.hookOk" ? /^$/ : /already runs|nothing to do/, c.name);
    assert.deepEqual(hookStatus(dir), before, `${c.name}: install-hook writes into no hook it did not write`);
  }
});

test("doctor audit (review): every rule only the commit-msg hook checks warns without a hook, named in one line", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const { t } = await import("../core/i18n.mjs");
  for (const [config, named] of [
    [{ commitMsg: { style: "terse" } }, /commitMsg\.style/],
    [{ review: { cochange: [{ paths: ["src/**"], docs: ["README.md"] }] } }, /review\.cochange/],
    [{ review: { impactRequiredGlobs: ["src/**"], forbidden: [{ text: "debugger", paths: ["**"] }] } }, /review\.forbidden, review\.impactRequiredGlobs/],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "en-hook-paper-"));
    git(["init", "-q", "-b", "main"], { cwd: dir });
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
    writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
    const item = (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.hookMissing");
    assert.ok(item && item.level === "warn", JSON.stringify(config));
    assert.match(t(item.key, item.vars, "en"), named);
    assert.match(t(item.key, item.vars, "tr"), named);
  }
});

test("hook audit (review): a hook is wired when a line runs commit-check as a check; real git is the judge, refusing an untyped subject only then (accept and reject corpus)", () => {
  const { callsCommitCheck } = /** @type {{ callsCommitCheck: (t: string) => boolean }} */ (hookModule);
  const cli = `'${CLI.replace(/'/g, "'\\''")}'`;
  const node = (/** @type {string} */ body) => `#!/usr/bin/env node\n${body}`;
  // Each runs commit-check as a check: git refuses the untyped subject.
  const calls = [
    `node ${cli} commit-check "$1"`,
    `exec node ${cli} commit-check --hook "$1"`,
    `  node ${cli} commit-check "$1" # the convention`,
    `node ${cli} commit-check "$1" || exit 1`,
    `if ! node ${cli} commit-check "$1"; then exit 1; fi`,
    `# checks the message\nnode ${cli} commit-check "$1"`,
    `out="$(node ${cli} commit-check "$1" 2>&1)" || { echo "$out" >&2; exit 1; }`,
    `node ${cli} "commit-check" "$1"`,
    `SUB=commit-check; node ${cli} "$SUB" "$1"`,
    `sh -c "node ${cli} commit-check \\"$1\\""`,
    `node ${cli} commit-check "$1" && :`,
    `if [ -n "$ENNYN_SKIP" ]; then\n  exit 0\nfi\nnode ${cli} commit-check "$1"`,
    `cat >/dev/null <<-'END'\n\ttext\n\tEND\nnode ${cli} commit-check "$1"`,
    `[ $# -gt 0 ] && node ${cli} commit-check "$1"`,
    node(`const { execFileSync } = require("node:child_process");\ntry {\n  execFileSync(process.execPath, [${JSON.stringify(CLI)}, "commit-check", process.argv[2]], { stdio: "inherit" });\n} catch {\n  process.exit(1);\n}`),
  ];
  // Each names commit-check and checks nothing: git takes the untyped subject.
  const idle = [
    `# node ${cli} commit-check "$1"`,
    "echo skipping commit-check",
    "printf 'commit-check is off\\n'",
    `cat >&2 <<EOF\nrun node ${cli} commit-check "$1" yourself\nEOF`,
    `cat <<-'END'\n\tnode ${cli} commit-check "$1"\n\tEND`,
    `node ${cli} commit-check "$1" || true`,
    `node ${cli} commit-check "$1" || :`,
    `node ${cli} commit-check "$1" || exit 0`,
    `exit 0\nnode ${cli} commit-check "$1"`,
    "true # commit-check",
    "if true; then echo commit-check is off; fi",
    ": 'commit-check disabled'",
    node(`// execFileSync(process.execPath, [${JSON.stringify(CLI)}, "commit-check", process.argv[2]]);\nprocess.exit(0);`),
  ];
  const dir = repo();
  const hook = join(dir, ".git", "hooks", "commit-msg");
  /** @param {string} body */
  const refused = (body) => {
    writeFileSync(hook, body.startsWith("#!") ? `${body}\n` : `#!/bin/sh\n${body}\n`);
    chmodSync(hook, 0o755);
    return commit(dir, "untyped subject").status !== 0;
  };
  for (const body of calls) {
    assert.equal(refused(body), true, `the oracle: ${JSON.stringify(body)}`);
    assert.equal(callsCommitCheck(body), true, JSON.stringify(body));
  }
  for (const body of idle) {
    assert.equal(refused(body), false, `the oracle: ${JSON.stringify(body)}`);
    assert.equal(callsCommitCheck(body), false, JSON.stringify(body));
  }
  // Shapes git cannot run here (no npx package, a CRLF shell script), read the same way.
  for (const body of ['npx ennyn commit-check "$1"', 'npx --no -- ennyn commit-check "$1"', `node ${cli} commit-check "$1"\r\n`]) assert.equal(callsCommitCheck(body), true, JSON.stringify(body));
  for (const body of ['node x commit-checker "$1"', 'node x my-commit-check "$1"']) assert.equal(callsCommitCheck(body), false, JSON.stringify(body));
  // Known limit of a line-level reading: a block that never runs. Read as wired; git takes the subject.
  const never = `if false; then\n  node ${cli} commit-check "$1"\nfi`;
  assert.deepEqual([callsCommitCheck(never), refused(never)], [true, false]);
  writeFileSync(hook, "#!/bin/sh\n# node x commit-check \"$1\" (disabled)\nexit 0\n");
  assert.equal(hookStatus(dir).state, "other");
});

test("install-hook audit (review round two): the chmod it advises works on a path with a space, run as printed", (t) => {
  if (process.platform === "win32") return t.skip("no executable bit on Windows");
  const dir = mkdtempSync(join(tmpdir(), "en hook space "));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" } }));
  writeFileSync(join(dir, ".git", "hooks", "commit-msg"), `#!/bin/sh\nnode '${CLI}' commit-check "$1"\n`, { mode: 0o644 });
  const r = spawnSync(process.execPath, [CLI, "install-hook"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  const advice = /Make it executable: (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(advice, r.stdout);
  const run = spawnSync("sh", ["-c", advice], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(hookStatus(dir).runs, true);
});

test("hook audit (review round two): husky in a directory of its own choosing is husky, known by the h it writes", () => {
  const dir = repo();
  mkdirSync(join(dir, ".config", "husky", "_"), { recursive: true });
  writeFileSync(join(dir, ".config", "husky", "_", "h"), "#!/usr/bin/env sh\n");
  writeFileSync(join(dir, ".config", "husky", "_", "commit-msg"), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', { mode: 0o755 });
  writeFileSync(join(dir, ".config", "husky", "commit-msg"), 'npx ennyn commit-check "$1"\n');
  git(["config", "core.hooksPath", ".config/husky/_"], { cwd: dir });
  const st = hookStatus(dir);
  assert.deepEqual([st.hooksKind, st.state], ["husky", "wired"]);
  // A tracked hooks directory named _ that husky did not write stays the repository's.
  const plain = repo();
  mkdirSync(join(plain, "hooks", "_"), { recursive: true });
  git(["config", "core.hooksPath", "hooks/_"], { cwd: plain });
  assert.equal(hookStatus(plain).hooksKind, "repo");
  // An h in a directory not named _ is no husky either.
  writeFileSync(join(plain, "hooks", "h"), "x\n");
  git(["config", "core.hooksPath", "hooks"], { cwd: plain });
  assert.equal(hookStatus(plain).hooksKind, "repo");
  // The advice for husky names the file husky runs, in its own directory.
  rmSync(join(dir, ".config", "husky", "commit-msg"));
  const r = spawnSync(process.execPath, [CLI, "install-hook"], { cwd: dir, encoding: "utf8" });
  assert.match(r.stdout, /\.config\/husky\/commit-msg/, r.stdout);
});
