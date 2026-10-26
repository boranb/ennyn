import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, existsSync, rmSync, symlinkSync } from "node:fs";
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
  // The rules named, each one: security.secrets is on by default, so a warning alone would not show the types.
  const rules = async () => (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.hookMissing")?.vars.rules;
  assert.deepEqual(await rules(), ["commitMsg.types", "security.secrets"]);
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
  const rules = async () => (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.hookMissing")?.vars.rules;
  assert.deepEqual(await rules(), ["review.impactRequiredGlobs", "security.secrets"]);
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
      name: "an Ennyn plugin script under core.hooksPath whose record names a version that is gone",
      want: "doctor.hookPluginStale",
      says: /every commit is refused/,
      make: (/** @type {string} */ d) => {
        const data = mkdtempSync(join(tmpdir(), "en-data-"));
        writeFileSync(join(data, "root"), `${join(data, "gone")}\n`);
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript("", data), { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    {
      name: "an Ennyn plugin script under core.hooksPath with no record (the plugin uninstalled)",
      want: "doctor.hookPluginUnrecorded",
      says: /where none is recorded, so every commit goes through unchecked/,
      make: (/** @type {string} */ d) => {
        const data = join(mkdtempSync(join(tmpdir(), "en-data-")), "gone");
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript("", data), { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    {
      name: "an Ennyn script under core.hooksPath that runs a plugin version Claude Code has replaced",
      want: "doctor.hookReplaced",
      says: /a plugin version Claude Code has replaced/,
      make: (/** @type {string} */ d) => {
        const old = pluginVersion(mkdtempSync(join(tmpdir(), "en-plugin-")), "0.9.0");
        writeFileSync(join(old, ".orphaned_at"), "1\n");
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript(join(old, "scripts", "ennyn.mjs")), { mode: 0o755 });
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
  // The secret scan off (except names every path), so each list holds only the rule the config sets.
  const off = { secrets: { except: ["**/*"] } };
  for (const [config, named, rules] of /** @type {[Record<string, unknown>, RegExp, string[]][]} */ ([
    [{ commitMsg: { style: "terse" }, security: off }, /commitMsg\.style/, ["commitMsg.style"]],
    [{ review: { cochange: [{ paths: ["src/**"], docs: ["README.md"] }] }, security: off }, /review\.cochange/, ["review.cochange"]],
    [{ review: { impactRequiredGlobs: ["src/**"], forbidden: [{ text: "debugger", paths: ["**"] }] }, security: off }, /review\.forbidden, review\.impactRequiredGlobs/, ["review.forbidden", "review.impactRequiredGlobs"]],
    [{}, /security\.secrets/, ["security.secrets"]],
  ])) {
    const dir = mkdtempSync(join(tmpdir(), "en-hook-paper-"));
    git(["init", "-q", "-b", "main"], { cwd: dir });
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
    writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
    const item = (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.hookMissing");
    assert.ok(item && item.level === "warn", JSON.stringify(config));
    assert.deepEqual(item.vars.rules, rules, JSON.stringify(config));
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


/**
 * A plugin version as Claude Code caches it (`cache/<marketplace>/<plugin>/<version>/`), with a CLI that only
 * says which version ran and refuses the commit, so a commit's stderr names the version the hook ran.
 * @param {string} base @param {string} version
 */
function pluginVersion(base, version) {
  const root = join(base, "cache", "mkt", "ennyn", version);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "ennyn.mjs"), `process.stderr.write("ran ${version}\\n");\nprocess.exit(1);\n`);
  return root;
}

/** This checkout as a plugin version: the real CLI, so a commit is checked as it would be. */
const SELF = dirname(dirname(CLI));
const PLUGIN_ROOT_HOOK = join(SELF, "adapters", "claude-code", "hooks", "plugin-root.mjs");
const cliOf = (/** @type {string} */ root) => join(root, "scripts", "ennyn.mjs");
const record = (/** @type {string} */ data) => readFileSync(join(data, "root"), "utf8");
/** The hook lines of doctor's report. @param {string} dir @param {Record<string, string>} [env] @param {string} [self] */
const hookKeys = async (dir, env = {}, self = undefined) => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  return (await checkSetup({ cwd: dir, env, ...(self ? { self } : {}) })).items.filter((i) => i.key.startsWith("doctor.hook")).map((i) => i.key);
};
/** A repository doctor reads a hook line for. */
const doctorRepo = () => {
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  return dir;
};
/** A plugin session's variables, as its SessionStart hook names them. @param {string} data @param {string} root */
const sessionEnv = (data, root) => ({ ENNYN_PLUGIN_DATA: data, ENNYN_PLUGIN_ROOT: root });

/** The SessionStart hook as Claude Code runs a plugin hook: its paths in the environment, the input on stdin. @param {Record<string, string>} env */
const sessionStart = (env) => spawnSync(process.execPath, [PLUGIN_ROOT_HOOK], { input: '{"source":"startup"}', env: { ...process.env, ...env }, encoding: "utf8" });

/** install-hook as a command, in a plugin session when `env` names one. @param {string} dir @param {Record<string, string>} env @param {string[]} args */
const installCli = (dir, env, ...args) => spawnSync(process.execPath, [CLI, "install-hook", ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });

test("hook follows the plugin: installed from the plugin, it runs the version the record names, and each session records the version it runs", () => {
  const dir = repo();
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const v1 = pluginVersion(base, "1.0.0");
  const v2 = pluginVersion(base, "2.0.0");
  const data = join(base, "data", "ennyn-mkt");
  const res = installHook({ cwd: dir, cliPath: cliOf(v1), pluginData: data });
  assert.deepEqual([res.result, res.data, record(data)], ["installed", data, `${v1}\n`]);
  const st = hookStatus(dir);
  assert.deepEqual([st.data, st.recorded, st.cli, st.problem], [data, v1, cliOf(v1), null]);
  assert.doesNotMatch(readFileSync(st.path, "utf8"), /1\.0\.0/, "the hook names no version");
  assert.match(commit(dir, "feat: one").stderr, /ran 1\.0\.0/);
  // An update: the next session records the new version, and the next commit runs it.
  assert.equal(sessionStart({ CLAUDE_PLUGIN_ROOT: v2, CLAUDE_PLUGIN_DATA: data }).stdout, "");
  assert.match(commit(dir, "feat: two").stderr, /ran 2\.0\.0/);
  // A session still on the replaced version (the update finished after it loaded) records nothing, quietly.
  writeFileSync(join(v1, ".orphaned_at"), "1\n");
  assert.equal(sessionStart({ CLAUDE_PLUGIN_ROOT: v1, CLAUDE_PLUGIN_DATA: data }).stdout, "");
  assert.match(commit(dir, "feat: three").stderr, /ran 2\.0\.0/);
  // install-hook from it refuses, and moves nothing: the record and the hook stay on the newer version.
  const hook = readFileSync(st.path, "utf8");
  const old = installHook({ cwd: dir, cliPath: cliOf(v1), pluginData: data });
  assert.deepEqual([old.result, old.root, record(data), readFileSync(st.path, "utf8")], ["replacedCopy", v1, `${v2}\n`, hook]);
  // Run again from the version the record names, with no data directory given, install-hook keeps the hook on the record.
  assert.equal(installHook({ cwd: dir, cliPath: cliOf(v2) }).result, "unchanged");
  // From another copy (a clone run inside a v2 session): the hook that follows the plugin is not turned into one pinned to the clone.
  const clone = installHook({ cwd: dir, cliPath: CLI, session: { data, root: v2 } });
  assert.deepEqual([clone.result, readFileSync(st.path, "utf8"), record(data)], ["followsRecord", hook, `${v2}\n`]);
  // A repository with no hook yet gets the clone by its path.
  const fresh = repo();
  assert.equal(installHook({ cwd: fresh, cliPath: CLI, session: { data, root: v2 } }).result, "installed");
  assert.deepEqual([hookStatus(fresh).cli, hookStatus(fresh).data], [CLI, null]);
});

test("hook follows the plugin: a record naming a gone version refuses the commit with a way out; no record (uninstalled, or the directory made again empty) lets it through; doctor tells them apart", async () => {
  const { idleReason, replacedRoot, recordPluginRoot, readRecord } = hookModule;
  const dir = doctorRepo();
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  installHook({ cwd: dir, cliPath: CLI, pluginData: data });
  assert.deepEqual(await hookKeys(dir), ["doctor.hookOk"]);
  assert.notEqual(commit(dir, "untyped").status, 0, "checked through the record");
  assert.equal(commit(dir, "feat: typed").status, 0);
  // The record names a version Claude Code then replaced: the hook still checks, with that version's rules.
  const old = pluginVersion(base, "0.9.0");
  recordPluginRoot(data, old);
  writeFileSync(join(old, ".orphaned_at"), "1\n");
  assert.equal(replacedRoot(hookStatus(dir)), realpathSync(old));
  assert.deepEqual(await hookKeys(dir), ["doctor.hookReplaced"]);
  // ... and deleted it, with no session since (or an uninstall that kept the data): refused, saying what works either way.
  rmSync(old, { recursive: true });
  assert.equal(idleReason(hookStatus(dir)), "stale");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookPluginStale"]);
  const refused = commit(dir, "feat: refused");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is no absolute path to a version that is there, so this commit is refused/);
  assert.match(refused.stderr, /Run install-hook from the plugin again \(\/ennyn:init.*delete this hook/);
  // install-hook from the plugin session, run as that advice says, puts it right.
  assert.equal(installHook({ cwd: dir, cliPath: CLI, session: { data, root: SELF } }).result, "updated");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookOk"]);
  // An empty or unusable record names nothing: refused as gone, never read as no record.
  for (const text of ["\n", ""]) {
    writeFileSync(join(data, "root"), text);
    assert.equal(idleReason(hookStatus(dir)), "stale", JSON.stringify(text));
    assert.equal(commit(dir, "feat: empty record").status, 1, JSON.stringify(text));
  }
  // The first line is the record, for the hook's read -r and for doctor alike.
  writeFileSync(join(data, "root"), `${SELF}\nsomething after it\n`);
  assert.deepEqual([readRecord(data).root, idleReason(hookStatus(dir))], [SELF, null]);
  assert.equal(commit(dir, "feat: first line").status, 0);
  sessionStart({ CLAUDE_PLUGIN_ROOT: SELF, CLAUDE_PLUGIN_DATA: data });
  assert.deepEqual(await hookKeys(dir), ["doctor.hookOk"]);
  // Uninstalled: Claude Code deletes the data directory with it. Never a lock on the user's commits.
  rmSync(data, { recursive: true });
  assert.equal(idleReason(hookStatus(dir)), "unrecorded");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookPluginUnrecorded"]);
  const passed = commit(dir, "untyped after uninstall");
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /no plugin version is recorded in .*so the commit message is not checked/);
  // A session still open makes the directory again, empty, at its next plugin hook: still no record, still through.
  mkdirSync(data, { recursive: true });
  assert.equal(idleReason(hookStatus(dir)), "unrecorded");
  assert.equal(commit(dir, "untyped, directory made again").status, 0);
  // install-hook from the plugin, installed again, puts it back.
  assert.equal(installHook({ cwd: dir, cliPath: CLI, pluginData: data }).result, "updated");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookOk"]);
});

test("hook follows the plugin: the one writer of the record refuses what would make the hook run the wrong thing", () => {
  const { RecordError, recordPluginRoot, readRecord } = hookModule;
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const v1 = pluginVersion(base, "1.0.0");
  const data = join(base, "data", "ennyn-mkt");
  const reason = (/** @type {() => unknown} */ f) => {
    try {
      f();
    } catch (e) {
      if (e instanceof RecordError) return e.reason;
      throw e;
    }
    return "written";
  };
  assert.equal(reason(() => recordPluginRoot("relative/data", v1)), "relative");
  assert.equal(reason(() => recordPluginRoot(data, "relative/root")), "relative");
  assert.equal(reason(() => recordPluginRoot(data, `${v1}\nsecond`)), "control");
  assert.equal(reason(() => recordPluginRoot(data, join(base, "no-such-version"))), "noCli");
  const empty = join(base, "empty");
  mkdirSync(empty);
  assert.equal(reason(() => recordPluginRoot(data, empty)), "noCli", "a root with no CLI would refuse every commit");
  assert.ok(!existsSync(data), "nothing written for a refused version");
  // A trailing separator is one spelling of the same root; a second write of it is none.
  assert.equal(reason(() => recordPluginRoot(data, `${v1}/`)), "written");
  assert.deepEqual([record(data), recordPluginRoot(data, v1)], [`${v1}\n`, false]);
  // The hook's own reader reads the line the writer wrote, quote and all.
  const odd = pluginVersion(base, `it's $(here) "x"`);
  recordPluginRoot(data, odd);
  const read = spawnSync("sh", ["-c", 'IFS= read -r r < "$1"; printf %s "$r"', "sh", join(data, "root")], { encoding: "utf8" });
  assert.deepEqual([read.stdout, readRecord(data).root], [odd, odd]);
  writeFileSync(join(odd, ".orphaned_at"), "1\n");
  const v2 = pluginVersion(base, "2.0.0");
  recordPluginRoot(data, v2);
  assert.equal(reason(() => recordPluginRoot(data, odd)), "replaced");
  assert.equal(record(data), `${v2}\n`);
  // Something in the record's place that is no regular file is not Ennyn's: kept, and refused.
  rmSync(join(data, "root"));
  mkdirSync(join(data, "root", "keep"), { recursive: true });
  assert.equal(readRecord(data).problem, "foreign", "a directory in its place is no record");
  assert.equal(reason(() => recordPluginRoot(data, v2)), "foreign");
  assert.ok(existsSync(join(data, "root", "keep")));
});

test("hook follows the plugin (review round two): the temporary record is made new, so a link planted at its name is removed, not written through", () => {
  const { recordPluginRoot } = hookModule;
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const v1 = pluginVersion(base, "1.0.0");
  const data = join(base, "data", "ennyn-mkt");
  mkdirSync(data, { recursive: true });
  const victim = join(base, "victim");
  writeFileSync(victim, "keep me\n");
  symlinkSync(victim, join(data, `root.${process.pid}.tmp`));
  recordPluginRoot(data, v1);
  assert.equal(readFileSync(victim, "utf8"), "keep me\n");
  assert.ok(lstatSync(join(data, "root")).isFile(), "the record is a regular file, not the planted link");
  assert.equal(record(data), `${v1}\n`);
});

test("hook follows the plugin (review round two): a link, a FIFO or a relative line at the record's place refuses the commit, as doctor and the writer say; nothing heals by passing", async () => {
  const { idleReason } = hookModule;
  const dir = doctorRepo();
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  installHook({ cwd: dir, cliPath: CLI, pluginData: data });
  const at = join(data, "root");
  // A dangling link: before, read as no record, so every commit passed and no session could write over it.
  rmSync(at);
  symlinkSync(join(base, "nowhere"), at);
  assert.equal(idleReason(hookStatus(dir)), "foreign");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookRecordForeign"]);
  const dangling = commit(dir, "untyped through a dangling link");
  assert.equal(dangling.status, 1);
  assert.match(dangling.stderr, /is no record Ennyn wrote \(a link, or not a regular file\), so this commit is refused/);
  assert.match(JSON.parse(sessionStart({ CLAUDE_PLUGIN_ROOT: SELF, CLAUDE_PLUGIN_DATA: data }).stdout).systemMessage, /is no regular file/);
  // A link to a good record is still no record Ennyn wrote.
  rmSync(at);
  writeFileSync(join(base, "elsewhere"), `${SELF}\n`);
  symlinkSync(join(base, "elsewhere"), at);
  assert.equal(commit(dir, "feat: typed through a link").status, 1);
  // A FIFO is refused unread: the hook never waits on it.
  rmSync(at);
  if (spawnSync("mkfifo", [at]).status === 0) {
    const fifo = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "untyped through a fifo"], { cwd: dir, encoding: "utf8", timeout: 20000 });
    assert.deepEqual([fifo.status, fifo.signal], [1, null]);
    assert.equal(idleReason(hookStatus(dir)), "foreign");
    rmSync(at);
  }
  // A relative line would run the repository's own file: before, an untyped commit passed through it.
  mkdirSync(join(dir, "evil", "scripts"), { recursive: true });
  writeFileSync(join(dir, "evil", "scripts", "ennyn.mjs"), "process.exit(0);\n");
  writeFileSync(at, "evil\n");
  assert.equal(idleReason(hookStatus(dir)), "stale", "doctor agrees: no root the hook runs");
  assert.equal(commit(dir, "untyped through a relative record").status, 1);
  // doctor run from inside the repository, where the relative path names the repository's file, agrees too.
  const inside = spawnSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  assert.match(inside.stdout, /names no version it can run .*every commit is refused/);
  // A control character (a CR from an editor) is no root either, for the hook and for doctor, even where one is there.
  const cr = join(base, "cr\r");
  mkdirSync(join(cr, "scripts"), { recursive: true });
  writeFileSync(join(cr, "scripts", "ennyn.mjs"), "process.exit(0);\n");
  writeFileSync(at, `${cr}\n`);
  assert.equal(idleReason(hookStatus(dir)), "stale");
  assert.equal(commit(dir, "untyped, carriage return").status, 1);
  writeFileSync(at, `${SELF}\n`);
  assert.equal(commit(dir, "feat: good again").status, 0);
});

test("hook follows the plugin (review round two): a data directory inside the repository is refused, given or from the session", () => {
  const dir = repo();
  const inside = join(dir, "tracked", "d");
  const given = installCli(dir, {}, "--plugin-data", inside);
  assert.equal(given.status, 1);
  assert.match(given.stdout, /is inside this repository, where its record would be the repository's own file\. Nothing was written/);
  const fromSession = installCli(dir, sessionEnv(inside, SELF));
  assert.equal(fromSession.status, 1);
  assert.match(fromSession.stdout, /is inside this repository/);
  assert.deepEqual([hookStatus(dir).state, existsSync(inside)], ["none", false]);
});

test("hook follows the plugin: the SessionStart hook records through the writer, names the data directory and its version to the session's commands once, says what it could not do, and never blocks", () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const v1 = pluginVersion(base, "1.0.0");
  const data = join(base, "data", "it's $HOME \\n");
  const envFile = join(base, "session-env");
  const quiet = (/** @type {ReturnType<typeof sessionStart>} */ r) => [r.status, r.stdout];
  // Not a plugin hook (no paths), or a root with no data directory: nothing written, nothing said.
  assert.deepEqual(quiet(sessionStart({})), [0, ""]);
  assert.deepEqual(quiet(sessionStart({ CLAUDE_PLUGIN_ROOT: v1 })), [0, ""], "a root with no data directory is no failure to say");
  assert.deepEqual(quiet(sessionStart({ CLAUDE_PLUGIN_DATA: data })), [0, ""], "nor a data directory with no root");
  assert.ok(!existsSync(data));
  const env = { CLAUDE_PLUGIN_ROOT: v1, CLAUDE_PLUGIN_DATA: data, CLAUDE_ENV_FILE: envFile };
  assert.deepEqual(quiet(sessionStart(env)), [0, ""]);
  assert.deepEqual(quiet(sessionStart(env)), [0, ""]);
  assert.equal(record(data), `${v1}\n`);
  // The line Claude Code runs before each Bash command names both, as the shell reads them back; added once.
  const named = spawnSync("sh", ["-c", '. "$1"; printf "%s|%s" "$ENNYN_PLUGIN_DATA" "$ENNYN_PLUGIN_ROOT"', "sh", envFile], { encoding: "utf8" });
  assert.equal(named.stdout, `${data}|${v1}`);
  assert.equal(readFileSync(envFile, "utf8").split("\n").filter(Boolean).length, 1);
  // A session on a replaced version: no record, nothing said, its variables still given (install-hook there refuses).
  writeFileSync(join(v1, ".orphaned_at"), "1\n");
  const v2 = pluginVersion(base, "2.0.0");
  sessionStart({ CLAUDE_PLUGIN_ROOT: v2, CLAUDE_PLUGIN_DATA: data, CLAUDE_ENV_FILE: envFile });
  assert.deepEqual(quiet(sessionStart(env)), [0, ""]);
  assert.equal(record(data), `${v2}\n`);
  assert.equal(readFileSync(envFile, "utf8").split("\n").filter(Boolean).length, 2);
  // A root the writer refuses for any other reason is said.
  const said = sessionStart({ CLAUDE_PLUGIN_ROOT: join(base, "no-cli"), CLAUDE_PLUGIN_DATA: data });
  assert.equal(said.status, 0);
  assert.match(JSON.parse(said.stdout).systemMessage, /could not be applied .*holds no scripts\/ennyn\.mjs/);
  assert.equal(record(data), `${v2}\n`);
  // The hook's messages print a path with a backslash as it is: printf '%s', not echo.
  rmSync(join(data, "root"));
  const dir = repo();
  writeFileSync(hookStatus(dir).path, hookModule.hookScript("", data), { mode: 0o755 });
  assert.ok(commit(dir, "anything").stderr.includes(`no plugin version is recorded in ${data} (`));
});

test("hook follows the plugin: install-hook takes the data directory as an absolute path; an unset one is refused, not read as none", () => {
  const dir = repo();
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "it's here");
  // "${CLAUDE_PLUGIN_DATA}" unset in the shell arrives empty.
  for (const bad of ["", "relative/data"]) {
    const r = installCli(dir, {}, "--plugin-data", bad);
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
    assert.match(r.stderr, /--plugin-data needs the plugin's data directory as an absolute path/);
    assert.equal(hookStatus(dir).state, "none");
  }
  // A record the writer refuses (something else in its place): said, nothing written, exit 1.
  mkdirSync(join(data, "root"), { recursive: true });
  const refused = installCli(dir, {}, "--plugin-data", data);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /The plugin version was not recorded and no hook was written: .*is no regular file/);
  assert.equal(hookStatus(dir).state, "none");
  rmSync(join(data, "root"), { recursive: true });
  const ok = installCli(dir, {}, "--plugin-data", data);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /follows plugin updates/);
  assert.equal(hookStatus(dir).data, data, "a quote in the path survives the script");
  assert.notEqual(commit(dir, "untyped").status, 0);
});

test("hook follows the plugin: every piece of advice, followed from a plugin session, ends in the hook that follows updates; a hook from before gets there too", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  // The session's SessionStart hook ran: the record names the version it runs (this checkout).
  sessionStart({ CLAUDE_PLUGIN_ROOT: SELF, CLAUDE_PLUGIN_DATA: data });
  const env = sessionEnv(data, SELF);
  const key = async (/** @type {string} */ d) => (await hookKeys(d, env))[0];
  /** @type {[string, (d: string) => void, string][]} */
  const cases = [
    ["no hook", () => {}, "doctor.hookMissing"],
    // Installed before hooks followed updates, or without the data directory: it names the version the session runs.
    ["a hook naming this version by its path", (d) => installHook({ cwd: d, cliPath: CLI }), "doctor.hookPinned"],
    ["a hook whose CLI moved", (d) => installHook({ cwd: d, cliPath: join(d, "moved", "ennyn.mjs") }), "doctor.hookCliGone"],
    [
      "a plugin hook git does not run",
      (d) => {
        installHook({ cwd: d, cliPath: CLI, pluginData: data });
        chmodSync(hookStatus(d).path, 0o644);
      },
      "doctor.hookNotRun",
    ],
  ];
  for (const [name, make, want] of cases) {
    if (process.platform === "win32" && want === "doctor.hookNotRun") continue;
    const dir = doctorRepo();
    make(dir);
    assert.equal(await key(dir), want, name);
    const r = installCli(dir, env);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(hookStatus(dir).data, data, `${name}: install-hook as the advice says writes the hook that follows updates`);
    assert.equal(await key(dir), "doctor.hookOk", name);
  }
  // Without the session (hooks disabled, --bare): no data directory to go by, and doctor cannot tell; the init skill passes it.
  const bare = repo();
  assert.equal(installCli(bare, {}).status, 0);
  assert.deepEqual([hookStatus(bare).cli, hookStatus(bare).data], [CLI, null]);
});

test("hook follows the plugin (review round two): in a session whose record names a replaced or another scope's version, the advice ends in the record form with this session's version, and a pinned hook is never ✓", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  const env = sessionEnv(data, SELF);
  const old = pluginVersion(base, "0.0.1");
  for (const state of ["replaced", "another scope"]) {
    hookModule.recordPluginRoot(data, old);
    if (state === "replaced") writeFileSync(join(old, ".orphaned_at"), "1\n");
    const dir = doctorRepo();
    installHook({ cwd: dir, cliPath: CLI, pluginData: data });
    hookModule.recordPluginRoot(data, state === "replaced" ? SELF : old);
    if (state === "replaced") writeFileSync(join(data, "root"), `${old}\n`);
    assert.deepEqual(await hookKeys(dir, env), [state === "replaced" ? "doctor.hookReplaced" : "doctor.hookOtherVersion"], state);
    const r = installCli(dir, env);
    assert.equal(r.status, 0, `${state}: ${r.stdout}${r.stderr}`);
    assert.deepEqual([hookStatus(dir).data, record(data)], [data, `${SELF}\n`], `${state}: the record names this session's version`);
    assert.deepEqual(await hookKeys(dir, env), ["doctor.hookOk"], state);
    // A new repository installed flagless in that state reads the record from the start.
    hookModule.recordPluginRoot(data, SELF);
    if (state === "replaced") writeFileSync(join(data, "root"), `${old}\n`);
    else hookModule.recordPluginRoot(data, old);
    const fresh = doctorRepo();
    assert.equal(installCli(fresh, env).status, 0);
    assert.equal(hookStatus(fresh).data, data, state);
    rmSync(join(old, ".orphaned_at"), { force: true });
  }
  // A hook that names the version the session's record names, by its path, is pinned too (another scope's);
  // so is one that names the session's version while the record names another.
  hookModule.recordPluginRoot(data, old);
  const pinned = doctorRepo();
  installHook({ cwd: pinned, cliPath: cliOf(old) });
  assert.deepEqual(await hookKeys(pinned, env), ["doctor.hookPinned"]);
  const ours = doctorRepo();
  installHook({ cwd: ours, cliPath: CLI });
  assert.deepEqual(await hookKeys(ours, env), ["doctor.hookPinned"]);
  // A session is named by absolute paths only.
  assert.equal(hookModule.sessionOf({ ENNYN_PLUGIN_DATA: "data", ENNYN_PLUGIN_ROOT: SELF }), null);
  assert.equal(hookModule.sessionOf({ ENNYN_PLUGIN_DATA: data, ENNYN_PLUGIN_ROOT: "." }), null);
  assert.deepEqual(hookModule.sessionOf(env), { data, root: SELF });
});

test("hook follows the plugin (review round two): outside a session, install-hook never turns a hook that follows the plugin into a pinned one", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  const dir = doctorRepo();
  installHook({ cwd: dir, cliPath: CLI, pluginData: data });
  writeFileSync(join(data, "root"), `${join(base, "gone")}\n`);
  const hook = readFileSync(hookStatus(dir).path, "utf8");
  assert.deepEqual(await hookKeys(dir), ["doctor.hookPluginStale"]);
  const r = installCli(dir, {});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /follows the plugin through the record in .*Nothing was written\. Run install-hook from the plugin/);
  assert.equal(readFileSync(hookStatus(dir).path, "utf8"), hook);
  assert.deepEqual(await hookKeys(dir), ["doctor.hookPluginStale"], "still said, never ✓");
  // With the data directory given, this copy is recorded and the hook checks again.
  assert.equal(installCli(dir, {}, "--plugin-data", data).status, 0);
  assert.deepEqual(await hookKeys(dir), ["doctor.hookOk"]);
});

test("hook follows the plugin (review round two): doctor run from a replaced copy says so, not that another scope wrote the record", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  const old = pluginVersion(base, "0.0.1");
  const dir = doctorRepo();
  installHook({ cwd: dir, cliPath: CLI, pluginData: data });
  writeFileSync(join(old, ".orphaned_at"), "1\n");
  // An old session (0.0.1, replaced) while a newer one recorded this checkout.
  assert.deepEqual(await hookKeys(dir, sessionEnv(data, old), old), ["doctor.hookSelfReplaced"]);
  assert.deepEqual(await hookKeys(dir, sessionEnv(data, SELF)), ["doctor.hookOk"]);
});

test("hook follows the plugin (review round two): under core.hooksPath a pinned or another scope's hook is no \"nothing to do\": install-hook says what to change and exits 1", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const data = join(base, "data", "ennyn-mkt");
  const v1 = pluginVersion(base, "1.0.0");
  hookModule.recordPluginRoot(data, SELF);
  const env = sessionEnv(data, SELF);
  /** @param {string} script */
  const underHooksPath = (script) => {
    const d = doctorRepo();
    mkdirSync(join(d, ".githooks"));
    writeFileSync(join(d, ".githooks", "commit-msg"), script, { mode: 0o755 });
    git(["config", "core.hooksPath", ".githooks"], { cwd: d });
    return d;
  };
  const pinned = underHooksPath(hookScript(CLI));
  assert.deepEqual(await hookKeys(pinned, env), ["doctor.hookPinned"]);
  const p = installCli(pinned, env);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /names one plugin version .*put this line in its place: node "\$\(cat /);
  const other = underHooksPath(hookScript("", data));
  hookModule.recordPluginRoot(data, v1);
  assert.deepEqual(await hookKeys(other, env), ["doctor.hookOtherVersion"]);
  const o = installCli(other, env);
  assert.equal(o.status, 1);
  assert.match(o.stdout, /installs of the plugin in two scopes share one record/);
});

test("hook follows the plugin: install-hook that writes no hook records nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const v2 = pluginVersion(base, "2.0.0");
  const data = join(base, "data", "ennyn-mkt");
  hookModule.recordPluginRoot(data, v2);
  // A repository with its own hook: install-hook writes nothing, so it records nothing either.
  const foreign = repo();
  writeFileSync(join(foreign, ".git", "hooks", "commit-msg"), "#!/bin/sh\necho theirs\n", { mode: 0o755 });
  const r = installCli(foreign, {}, "--plugin-data", data);
  assert.equal(r.status, 1);
  assert.equal(record(data), `${v2}\n`, "every other repository's hook still runs 2.0.0");
  // The line it advises reads the record, so the project's hook follows updates too; a record naming nothing fails it.
  assert.match(r.stdout, /node "\$\(cat '.*\/root'\)\/scripts\/ennyn\.mjs" commit-check --hook "\$1"/);
  // Recorded back to this copy: a change, though the hook's text is not.
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI, pluginData: data });
  hookModule.recordPluginRoot(data, v2);
  assert.equal(installHook({ cwd: dir, cliPath: CLI, pluginData: data }).result, "updated");
  assert.equal(installHook({ cwd: dir, cliPath: CLI, pluginData: data }).result, "unchanged");
});
