import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import * as hookModule from "../setup/hook.mjs";
import { BLOCK_MARKER, HOOK_MARKER, hookBlock, hookLine as printedLine, hookScript, hookStatus, idleReason, installHook, namesCheck, printedCheck } from "../setup/hook.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

/** What husky 9.1.7's index.js writes as .husky/_/commit-msg. */
const HUSKY_STUB = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';
/** A stand-in for .husky/_/h, with the two lines of husky 9.1.7's that matter here: node_modules/.bin first on PATH, and the project's file under sh -e. */
const HUSKY_RUNNER = '#!/usr/bin/env sh\ns=$(dirname "$(dirname "$0")")/$(basename "$0")\nexport PATH="node_modules/.bin:$PATH"\nsh -e "$s" "$@"\n';

/** What husky 8.0.3 generates as .husky/_/husky.sh, shortened to what runs here: it runs the hook again under sh -e, and git ignores it (.husky/_/.gitignore: *). */
const HUSKY8_SH = '#!/usr/bin/env sh\nif [ -z "$husky_skip_init" ]; then\n  if [ "$HUSKY" = "0" ]; then\n    exit 0\n  fi\n  readonly husky_skip_init=1\n  export husky_skip_init\n  sh -e "$0" "$@"\n  exit $?\nfi\n';

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

test("hook: a staged file the workflow reader cannot take costs no other file its refusals, and the commit does not land", () => {
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "pwn.yml"), "on: pull_request_target\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n");
  const alone = commit(dir, "feat: a workflow");
  assert.notEqual(alone.status, 0);
  writeFileSync(join(dir, ".github", "workflows", "decoy.yml"), 'on: push\npermissions: {}\nname: "\\U00110000"\n');
  const beside = commit(dir, "feat: a workflow");
  assert.notEqual(beside.status, 0, "exit 0 here was the whole gate switched off");
  for (const re of [/pwn\.yml: 1 new uses/, /pwn\.yml: a pull_request_target workflow checks out/, /pwn\.yml: neither the workflow nor these jobs set permissions/, /decoy\.yml: YAML the check cannot follow/]) assert.match(beside.stderr, re);
  assert.doesNotMatch(beside.stderr, /security\.ci was not checked/);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: dir, encoding: "utf8" }).status, 1, "nothing was committed");
});

test("hook: never over a hook it did not write; a project's own hook counts as wired only with what install-hook printed", () => {
  const dir = repo();
  const path = hookStatus(dir).path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho theirs\n");
  assert.deepEqual([installHook({ cwd: dir, cliPath: CLI }).result, readFileSync(path, "utf8")], ["other", "#!/bin/sh\necho theirs\n"]);
  writeFileSync(path, '#!/bin/sh\nnode tools/ennyn/scripts/ennyn.mjs commit-check "$1"\n');
  // Executable, as git runs only such a hook (a mode given to writeFileSync holds only for a new file).
  chmodSync(path, 0o755);
  assert.equal(hookStatus(dir).state, "wired");
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "blockUnread");
  writeFileSync(path, `#!/bin/sh\n${printedLine(CLI)}\n`);
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
  // The project's own tracked hook that holds the printed line is as good as ours.
  mkdirSync(join(dir, ".githooks"));
  // Executable, as git runs only such a hook.
  writeFileSync(join(dir, ".githooks", "commit-msg"), `#!/bin/sh\n${printedLine(CLI)}\n`, { mode: 0o755 });
  assert.ok((await keys()).includes("ok doctor.hookOk"));
});

test("hook: husky's stubs are not ours to edit; .husky/commit-msg holding the printed block counts as wired, for install and doctor", async () => {
  const { checkSetup } = await import("../setup/doctor.mjs");
  const { home, data } = plugged();
  const dir = repo();
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
  mkdirSync(join(dir, ".husky", "_"), { recursive: true });
  writeFileSync(join(dir, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
  git(["config", "core.hooksPath", ".husky/_"], { cwd: dir });
  const bare = installHook({ cwd: dir, cliPath: CLI });
  assert.deepEqual([bare.result, bare.hooksKind], ["hooksPath", "husky"]);
  assert.equal(readFileSync(join(dir, ".husky", "_", "commit-msg"), "utf8"), HUSKY_STUB, "stub untouched");
  writeFileSync(join(dir, ".husky", "commit-msg"), 'npx ennyn commit-check "$1"\n');
  assert.equal(installHook({ cwd: dir, cliPath: CLI }).result, "blockUnread");
  // The line is no answer under husky, whose runner can put a dependency's node first on PATH.
  writeFileSync(join(dir, ".husky", "commit-msg"), `${printedLine(CLI)}\n`);
  assert.deepEqual([hookStatus(dir).unread, installHook({ cwd: dir, cliPath: CLI }).result], [join(dir, ".husky", "commit-msg"), "blockUnread"]);
  writeFileSync(join(dir, ".husky", "commit-msg"), hookBlock(data));
  const items = (await checkSetup({ cwd: dir, env: { HOME: home, PATH: process.env.PATH } })).items.map((i) => `${i.level} ${i.key}`);
  assert.ok(items.includes("ok doctor.hookOk"), items.join("\n"));
});

test("hook: a global core.hooksPath (outside the repository) is reported as such, with a line that survives the shell", () => {
  const dir = repo();
  const global = mkdtempSync(join(tmpdir(), "en-global-hooks-"));
  git(["config", "core.hooksPath", global], { cwd: dir });
  const res = installHook({ cwd: dir, cliPath: '/opt/it\'s "x"/$HOME/ennyn.mjs' });
  assert.deepEqual([res.result, res.hooksKind], ["hooksPath", "global"]);
  assert.equal(res.line, `node '/opt/it'\\''s "x"/$HOME/ennyn.mjs' commit-check --hook "$1" || exit $?`);
  assert.ok(!existsSync(join(global, "commit-msg")));
  // The quoted line is one argument to sh: echo it back through a shell to be sure.
  const echoed = spawnSync("sh", ["-c", res.line.replace(/^node /, "printf '%s' ").replace(/ commit-check --hook "\$1" \|\| exit \$\?$/, "")], { encoding: "utf8" });
  assert.equal(echoed.stdout, `/opt/it's "x"/$HOME/ennyn.mjs`);
});

test("hook: a config that does not load lets the commit through with a warning, so the fix can be committed", () => {
  const dir = repo();
  installHook({ cwd: dir, cliPath: CLI });
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat"], typo: 1 } }));
  // Past the hook: HEAD's config does not load either, so nothing is left to check by.
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: broken"], { cwd: dir });
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
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: a pattern past the hook"], { cwd: dir });
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
  const hookLine = async (dir) => (await checkSetup({ cwd: dir, env: { HOME: process.env.HOME, PATH: process.env.PATH } })).items.find((i) => i.key.startsWith("doctor.hook"));
  /** @param {string} dir */
  const install = (dir) => spawnSync(process.execPath, [CLI, "install-hook"], { cwd: dir, encoding: "utf8" });
  /** @param {(dir: string) => void} make */
  const state = (make) => {
    const dir = repo();
    writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }] }));
    make(dir);
    return dir;
  };
  const wiredLine = `#!/bin/sh\n${printedLine(CLI)}\n`;
  /** Ennyn's script where only this machine puts it: a hooks directory outside the repository. @param {string} d @param {string} text */
  const machineHooks = (d, text) => {
    const hooks = mkdtempSync(join(tmpdir(), "en-machine-hooks-"));
    writeFileSync(join(hooks, "commit-msg"), text, { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], { cwd: d });
  };
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
        machineHooks(d, hookScript(join(d, "gone", "ennyn.mjs")));
      },
    },
    {
      name: "an Ennyn plugin script under core.hooksPath whose record names a version that is gone",
      want: "doctor.hookPluginStale",
      says: /every commit is refused/,
      make: (/** @type {string} */ d) => {
        const data = mkdtempSync(join(tmpdir(), "en-data-"));
        writeFileSync(join(data, "root"), `${join(data, "gone")}\n`);
        machineHooks(d, hookScript("", data));
      },
    },
    {
      name: "an Ennyn plugin script under core.hooksPath with no record (the plugin uninstalled)",
      want: "doctor.hookPluginUnrecorded",
      says: /where none is recorded, so every commit goes through unchecked/,
      make: (/** @type {string} */ d) => {
        const data = join(mkdtempSync(join(tmpdir(), "en-data-")), "gone");
        machineHooks(d, hookScript("", data));
      },
    },
    {
      name: "an Ennyn script under core.hooksPath that runs a plugin version Claude Code has replaced",
      want: "doctor.hookReplaced",
      says: /a plugin version Claude Code has replaced/,
      make: (/** @type {string} */ d) => {
        const old = pluginVersion(mkdtempSync(join(tmpdir(), "en-plugin-")), "0.9.0");
        writeFileSync(join(old, ".orphaned_at"), "1\n");
        machineHooks(d, hookScript(join(old, "scripts", "ennyn.mjs")));
      },
    },
    {
      name: "an Ennyn script under core.hooksPath that runs",
      want: "doctor.hookOk",
      says: /already runs commit-check/,
      make: (/** @type {string} */ d) => {
        machineHooks(d, hookScript(CLI));
      },
    },
    {
      name: "Ennyn's script copied into a tracked directory, which reads as any other text",
      want: "doctor.hookUnread",
      says: /names commit-check, but it is not the block or the line/,
      make: (/** @type {string} */ d) => {
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), hookScript(CLI), { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    },
    { name: "a wired hook that runs", want: "doctor.hookOk", says: /already runs commit-check/, make: (/** @type {string} */ d) => writeFileSync(join(d, ".git", "hooks", "commit-msg"), wiredLine, { mode: 0o755 }) },
    ...[
      ["Ennyn's block behind another command in a tracked hook", '#!/bin/sh\n[ -n "$SKIP" ] && exit 0\n', "doctor.hookUnread", /names commit-check.*Nothing was written\. Run install-hook from the Claude Code plugin/],
      ["Ennyn's block first in a tracked hook", "#!/bin/sh\n", "doctor.hookOk", /already runs commit-check/],
    ].map(([name, before, want, says]) => ({
      name: /** @type {string} */ (name),
      want: /** @type {string} */ (want),
      says: /** @type {RegExp} */ (says),
      make: (/** @type {string} */ d) => {
        hookModule.recordPluginRoot(join(/** @type {string} */ (process.env.HOME), ".claude", "plugins", "data", "ennyn-ennyn"), SELF);
        mkdirSync(join(d, ".githooks"));
        writeFileSync(join(d, ".githooks", "commit-msg"), `${before}${hookBlock("/x/plugins/data/ennyn-ennyn")}`, { mode: 0o755 });
        git(["config", "core.hooksPath", ".githooks"], { cwd: d });
      },
    })),
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

test("hook audit (review): text cannot tell a hook that checks from one that does not: each below names commit-check and reads unread, and real git shows both kinds (accept and reject corpus)", () => {
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
  for (const [list, checks] of /** @type {[string[], boolean][]} */ ([[calls, true], [idle, false]])) {
    for (const body of list) {
      assert.equal(refused(body), checks, `the oracle: ${JSON.stringify(body)}`);
      assert.equal(namesCheck(body), true, JSON.stringify(body));
      assert.equal(hookStatus(dir).unread, hook, JSON.stringify(body));
    }
  }
  // Another word holds the name: the file reads as another hook.
  for (const body of ['node x commit-checker "$1"', 'node x my-commit-check "$1"', "echo commit_check"]) assert.equal(namesCheck(body), false, JSON.stringify(body));
  for (const body of ['node x >commit-check', 'SUB=commit-check', "# commit-check", '"commit-check"', "[cli, 'commit-check']"]) assert.equal(namesCheck(body), true, JSON.stringify(body));
  writeFileSync(hook, "#!/bin/sh\nnode x commit-checker\n");
  assert.deepEqual([hookStatus(dir).state, hookStatus(dir).unread], ["other", null]);
  writeFileSync(hook, "#!/bin/sh\n# node x commit-check \"$1\" (disabled)\nexit 0\n");
  assert.deepEqual([hookStatus(dir).state, hookStatus(dir).unread], ["wired", hook]);
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
  writeFileSync(join(dir, ".config", "husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
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
  return (await checkSetup({ cwd: dir, env: { PATH: process.env.PATH, ...env }, ...(self ? { self } : {}) })).items.filter((i) => i.key.startsWith("doctor.hook")).map((i) => i.key);
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

test("hook follows the plugin: a session root spelled another way that names this copy is the session, so the hook follows the record", async () => {
  // Measured on Windows (Node 22): realpathSync's own walk keeps `c:\…` and an 8.3 name as given, the kernel's real
  // path (realpathSync.native) gives the spelling on disk, and a root spelled so was read as another copy, the hook
  // pinned to this one. A volume that folds case, made here: that spelling is this copy to the kernel alone.
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const spelled = SELF.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const [walk, kernel] = [fs.realpathSync, fs.realpathSync.native];
  const folds = Object.assign((/** @type {any} */ p, /** @type {any} */ o) => (p === spelled ? spelled : walk(p, o)), { native: (/** @type {any} */ p, /** @type {any} */ o) => kernel(p === spelled ? SELF : p, o) });
  const data = join(mkdtempSync(join(tmpdir(), "en-spelled-")), "data");
  const dir = repo();
  fs.realpathSync = /** @type {any} */ (folds);
  syncBuiltinESMExports();
  try {
    const res = installHook({ cwd: dir, cliPath: CLI, session: { data, root: spelled } });
    assert.deepEqual([res.result, res.data], ["installed", data]);
  } finally {
    fs.realpathSync = walk;
    syncBuiltinESMExports();
  }
  assert.equal(hookStatus(dir).data, data);
});

test("hook follows the plugin: a session root that cannot be looked at is no proof of this copy: the hook names this copy, nothing throws", () => {
  // realpathSync.native refuses what it cannot read (EACCES here, EPERM on Windows); it is read as another copy.
  if (process.getuid?.() === 0) return;
  const box = mkdtempSync(join(tmpdir(), "en-shut-"));
  const shut = join(box, "shut");
  mkdirSync(join(shut, "root"), { recursive: true });
  chmodSync(shut, 0o000);
  try {
    const dir = repo();
    const res = installHook({ cwd: dir, cliPath: CLI, session: { data: join(box, "data"), root: join(shut, "root") } });
    assert.deepEqual([res.result, hookStatus(dir).data, hookStatus(dir).cli], ["installed", null, CLI]);
  } finally {
    chmodSync(shut, 0o755);
  }
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
    const hooks = mkdtempSync(join(tmpdir(), "en-machine-hooks-"));
    writeFileSync(join(hooks, "commit-msg"), script, { mode: 0o755 });
    git(["config", "core.hooksPath", hooks], { cwd: d });
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

/**
 * A project's own commit-msg hook, as the second project kept its tracked one: early exits for the subjects it
 * exempts and for a marker in the message, then a check of its own (a ticket in the subject). Builtins only, so
 * it runs with no PATH. `block` goes first, as install-hook says.
 * @param {string} block
 */
const projectHook = (block, shebang = "#!/bin/sh\n") => `${shebang}${block}IFS= read -r subject < "$1"
case $subject in
  Merge*|Revert*|fixup!*|squash!*) exit 0 ;;
esac
while IFS= read -r l; do
  case $l in
    *'[no-prevention]'*) exit 0 ;;
  esac
done < "$1"
case $subject in
  *PRJ-*) ;;
  *) echo "project: no ticket in the subject" >&2; exit 1 ;;
esac
`;

/** The environment of a commit made outside a Claude Code session, with `vars` over the test's. @param {Record<string, string | undefined>} vars */
const outside = (vars) => {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of ["ENNYN_PLUGIN_DATA", "ENNYN_PLUGIN_ROOT", "CLAUDE_CONFIG_DIR"]) delete env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
};

/** git commit in `dir` of `files`, staged, with `message`, in `env`. @param {string} dir @param {string} message @param {Record<string, string>} files @param {Record<string, string | undefined>} env */
function commitIn(dir, message, files, env) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(["add", "-A"], { cwd: dir });
  // By its path: a case's PATH may hold no git.
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: dir, env, encoding: "utf8" });
  // A refused commit leaves its changes staged: the next case starts from HEAD.
  if (r.status !== 0) git(["reset", "-q", "--hard", "HEAD"], { cwd: dir });
  return r;
}

/** A repository whose tracked hooks directory holds the project's own hook with `block` in it, committed. @param {string} block */
function trackedHooks(block, hooksPath = ".githooks") {
  const dir = doctorRepo();
  mkdirSync(join(dir, ".githooks"));
  writeFileSync(join(dir, ".githooks", "commit-msg"), projectHook(block), { mode: 0o755 });
  git(["config", "core.hooksPath", hooksPath], { cwd: dir });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: PRJ-0 hooks"], { cwd: dir });
  return dir;
}

test("hook in a tracked hooks directory: install-hook prints a block for the project's own hook; first there, it checks every commit the hook's early exits skip, names no path of this machine, and holds with core.hooksPath absolute", async () => {
  const { TOKENS } = await import("./secret-shapes.mjs");
  const home = mkdtempSync(join(tmpdir(), "en-home-"));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const probe = doctorRepo();
  mkdirSync(join(probe, ".githooks"));
  git(["config", "core.hooksPath", ".githooks"], { cwd: probe });
  const res = installHook({ cwd: probe, cliPath: CLI, pluginData: data });
  assert.equal(res.result, "hooksPath");
  assert.ok(!existsSync(join(probe, ".githooks", "commit-msg")), "nothing written into the tracked directory");
  assert.ok(res.block.startsWith(BLOCK_MARKER), res.block);
  for (const path of [home, data, SELF, tmpdir()]) assert.ok(!res.block.includes(path), `the block names no path of this machine: ${path}`);
  const dir = trackedHooks(res.block);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"], "the block, first, reads as wired");
  const env = outside({ HOME: home });
  const secret = () => ({ "src/token.js": `export const token = "${TOKENS.github}";\n`, "src/n.txt": String(Math.random()) });
  const clean = () => ({ "src/n.txt": String(Math.random()) });
  // Each subject the project's hook exits early for: refused with a secret, through without one.
  for (const message of ['Revert "feat: PRJ-1 a"', "fixup! feat: PRJ-0 hooks", "feat: PRJ-2 b\n\n[no-prevention]"]) {
    const refused = commitIn(dir, message, secret(), env);
    assert.equal(refused.status, 1, `${message}: ${refused.stderr}`);
    assert.match(refused.stderr, /adds what reads as a secret/, message);
    const passed = commitIn(dir, message, clean(), env);
    assert.equal(passed.status, 0, `${message}: ${passed.stderr}`);
  }
  // A merge: git runs the commit-msg hook for the merge commit, which brings the other side's secret.
  for (const [branch, files, want] of /** @type {[string, () => Record<string, string>, number][]} */ ([
    ["side", secret, 1],
    ["side-clean", clean, 0],
  ])) {
    git(["checkout", "-q", "-b", branch], { cwd: dir });
    for (const [p, text] of Object.entries(files())) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", `feat: PRJ-3 ${branch}`], { cwd: dir });
    git(["checkout", "-q", "main"], { cwd: dir });
    const merge = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", `Merge branch '${branch}'`, branch], { cwd: dir, env, encoding: "utf8" });
    assert.equal(merge.status, want, `${branch}: ${merge.stdout}${merge.stderr}`);
    if (want) {
      assert.match(merge.stderr, /adds what reads as a secret/);
      git(["merge", "--abort"], { cwd: dir });
    }
  }
  // The rest of the hook still runs: Ennyn's convention, then the project's own check, each refusing what it refuses.
  assert.match(commitIn(dir, "untyped PRJ-4", clean(), env).stderr, /commitMsg\.types/);
  const noTicket = commitIn(dir, "feat: no ticket", clean(), env);
  assert.deepEqual([noTicket.status, /project: no ticket/.test(noTicket.stderr)], [1, true]);
  assert.equal(commitIn(dir, "feat: PRJ-5 c", clean(), env).status, 0);
  // core.hooksPath made absolute (Claude Code's agent-worktree setup writes it so): the same block, the same verdicts.
  git(["config", "core.hooksPath", join(dir, ".githooks")], { cwd: dir });
  assert.equal(hookStatus(dir).hooksKind, "repo");
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(dir, 'Revert "feat: PRJ-5 c"', secret(), env).status, 1);
  assert.equal(commitIn(dir, 'Revert "feat: PRJ-5 c"', clean(), env).status, 0);
  // From a plugin session, the command prints the same block after its advice, and exits 1: nothing was written.
  const cli = installCli(probe, sessionEnv(data, SELF));
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /Paste the block below at the top of \.githooks\/commit-msg, before any other command/);
  assert.ok(cli.stdout.endsWith(res.block), cli.stdout);
  assert.ok(!existsSync(join(probe, ".githooks", "commit-msg")));
  // Outside a session with no data directory given, there is no block to print: it says how to get one.
  const bare = installCli(probe, {});
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /Run install-hook from the Claude Code plugin/);
  assert.ok(!bare.stdout.includes(BLOCK_MARKER));
  // A global hooks directory is this machine's own: the line, as before, and no block.
  const global = doctorRepo();
  git(["config", "core.hooksPath", mkdtempSync(join(tmpdir(), "en-global-hooks-"))], { cwd: global });
  const everywhere = installCli(global, sessionEnv(data, SELF));
  assert.equal(everywhere.status, 1);
  assert.match(everywhere.stdout, /To check them all, add this line to/);
  assert.ok(!everywhere.stdout.includes(BLOCK_MARKER));
});

test("hook in a tracked hooks directory: the block warns and passes with no node or no record, so the project's own checks still run; it refuses a broken record or a data directory it cannot know, also under sh -e", () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const home = join(base, "home");
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  const block = hookBlock(data);
  const dir = trackedHooks(block);
  const hook = join(dir, ".githooks", "commit-msg");
  const msg = join(base, "msg");
  /** The hook as git runs it, on a message, in `env`; `flags` for the shell (husky runs its user hook with sh -e). @param {string} message @param {Record<string, string | undefined>} env */
  const run = (message, env, ...flags) => {
    writeFileSync(msg, `${message}\n`);
    return spawnSync("/bin/sh", [...flags, hook, msg], { cwd: dir, env, encoding: "utf8" });
  };
  const env = outside({ HOME: home });
  // No record (the plugin not installed for this user, or uninstalled): through, saying so; the project's check runs.
  const none = run("feat: PRJ-1 a", env);
  assert.deepEqual([none.status, none.stderr.includes(`no plugin version is recorded in ${data}`)], [0, true], none.stderr);
  const noneNoTicket = run("feat: no ticket", env);
  assert.deepEqual([noneNoTicket.status, /project: no ticket/.test(noneNoTicket.stderr)], [1, true], noneNoTicket.stderr);
  mkdirSync(data, { recursive: true });
  assert.equal(run("feat: PRJ-1 a", env).status, 0, "the directory made again, empty");
  // No node: through, saying so; the project's check runs.
  hookModule.recordPluginRoot(data, SELF);
  const noNode = run("untyped PRJ-1", outside({ HOME: home, PATH: "/nonexistent" }));
  assert.deepEqual([noNode.status, /node not found/.test(noNode.stderr)], [0, true], noNode.stderr);
  assert.equal(run("feat: no ticket", outside({ HOME: home, PATH: "/nonexistent" })).status, 1);
  // The record found: checked (an untyped subject refused), here and under sh -e.
  assert.equal(run("untyped PRJ-1", env).status, 1);
  assert.equal(run("untyped PRJ-1", env, "-e").status, 1);
  assert.equal(run("feat: PRJ-1 typed", env, "-e").status, 0);
  rmSync(join(data, "root"));
  assert.equal(run("feat: PRJ-1 a", env, "-e").status, 0, "no record under sh -e: through, and the project's part still runs");
  assert.equal(run("feat: no ticket", env, "-e").status, 1);
  // A broken record refuses the commit: a link, a relative line, a control character, a version that is gone.
  const at = join(data, "root");
  writeFileSync(join(base, "elsewhere"), `${SELF}\n`);
  symlinkSync(join(base, "elsewhere"), at);
  const link = run("feat: PRJ-1 a", env);
  assert.deepEqual([link.status, /is no record Ennyn wrote/.test(link.stderr)], [1, true], link.stderr);
  rmSync(at);
  for (const line of ["relative/root", `${SELF}\r`, join(base, "gone")]) {
    writeFileSync(at, `${line}\n`);
    const r = run("feat: PRJ-1 a", env);
    assert.deepEqual([r.status, /so this commit is refused/.test(r.stderr)], [1, true], `${JSON.stringify(line)}: ${r.stderr}`);
  }
  // Where it reads the record: the session's data directory, else CLAUDE_CONFIG_DIR's, else HOME's.
  const sessionData = join(base, "session-data");
  const configDir = join(base, "config");
  hookModule.recordPluginRoot(data, pluginVersion(base, "home"));
  hookModule.recordPluginRoot(join(configDir, "plugins", "data", "ennyn-test"), pluginVersion(base, "config"));
  hookModule.recordPluginRoot(sessionData, pluginVersion(base, "session"));
  assert.match(run("feat: PRJ-1 a", env).stderr, /ran home/);
  assert.match(run("feat: PRJ-1 a", outside({ HOME: home, CLAUDE_CONFIG_DIR: configDir })).stderr, /ran config/);
  assert.match(run("feat: PRJ-1 a", outside({ HOME: home, CLAUDE_CONFIG_DIR: configDir, ENNYN_PLUGIN_DATA: sessionData })).stderr, /ran session/);
  // A data directory it cannot know refuses: no HOME (and no session, no CLAUDE_CONFIG_DIR), or one that is no absolute path.
  // HOME is taken away inside the child: the test's own children always get one.
  for (const unset of ["unset HOME", "HOME="]) {
    writeFileSync(msg, "feat: PRJ-1 a\n");
    const noHome = spawnSync("/bin/sh", ["-c", `${unset}; exec /bin/sh "$@"`, "sh", hook, msg], { cwd: dir, env, encoding: "utf8" });
    assert.deepEqual([noHome.status, /HOME is not set/.test(noHome.stderr)], [1, true], `${unset}: ${noHome.stderr}`);
  }
  const relative = run("feat: PRJ-1 a", outside({ HOME: home, CLAUDE_CONFIG_DIR: "cfg" }));
  assert.deepEqual([relative.status, /is no absolute path, or holds a control character, so this commit is refused/.test(relative.stderr)], [1, true], relative.stderr);
  assert.equal(run("feat: PRJ-1 a", outside({ HOME: home, ENNYN_PLUGIN_DATA: `${sessionData}\r` })).status, 1, "a control character is no directory");
});

test("hook in a tracked hooks directory: a block behind a command that may exit is no ✓; doctor and install-hook say so, and real git shows why", async () => {
  const home = mkdtempSync(join(tmpdir(), "en-home-"));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const block = hookBlock(data);
  const { TOKENS } = await import("./secret-shapes.mjs");
  // The block at the end of the project's hook, after its early exits: the trial's first wiring.
  const dir = trackedHooks("");
  const hook = join(dir, ".githooks", "commit-msg");
  writeFileSync(hook, `${projectHook("")}${block}`);
  assert.equal(hookStatus(dir).unread, hook);
  assert.equal(idleReason(hookStatus(dir)), "unread");
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"]);
  const before = hookStatus(dir);
  const r = installCli(dir, {});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\.githooks\/commit-msg names commit-check.*it prints the block that goes at the top of \S*\.githooks\/commit-msg/);
  assert.ok(!r.stdout.includes(BLOCK_MARKER), "no data directory known, no block to print");
  assert.deepEqual(hookStatus(dir), before, "install-hook writes into no hook it did not write");
  // Real git: the revert with a secret passes the late block; moved first, it is refused.
  const env = outside({ HOME: home });
  const secret = { "src/token.js": `export const token = "${TOKENS.github}";\n` };
  assert.equal(commitIn(dir, 'Revert "feat: PRJ-0 hooks"', secret, env).status, 0, "the early exit skipped the late block");
  git(["reset", "-q", "--hard", "HEAD~1"], { cwd: dir });
  writeFileSync(hook, projectHook(block));
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(dir, 'Revert "feat: PRJ-0 hooks"', secret, env).status, 1);
  // husky 9: the block in .husky/commit-msg, the file its stub runs; the warning names that file.
  const husky = doctorRepo();
  mkdirSync(join(husky, ".husky", "_"), { recursive: true });
  writeFileSync(join(husky, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
  writeFileSync(join(husky, ".husky", "commit-msg"), `npx lint-staged\n${block}`);
  git(["config", "core.hooksPath", ".husky/_"], { cwd: husky });
  assert.equal(hookStatus(husky).unread, join(husky, ".husky", "commit-msg"));
  assert.deepEqual(await hookKeys(husky, { HOME: home }), ["doctor.hookUnread"]);
  const { checkSetup } = await import("../setup/doctor.mjs");
  assert.deepEqual((await checkSetup({ cwd: husky, env: { PATH: process.env.PATH } })).items.find((i) => i.key === "doctor.hookUnread")?.vars.path, [join(husky, ".husky", "commit-msg")]);
  writeFileSync(join(husky, ".husky", "commit-msg"), `${block}npx lint-staged\n`);
  assert.deepEqual(await hookKeys(husky, { HOME: home }), ["doctor.hookOk"]);
  // With no .husky/commit-msg yet, install-hook from the plugin names that file and prints the block for it.
  rmSync(join(husky, ".husky", "commit-msg"));
  const printed = installCli(husky, sessionEnv(data, SELF));
  assert.equal(printed.status, 1);
  assert.match(printed.stdout, /Paste the block below at the top of \.husky\/commit-msg, before any other command.*HUSKY=0 skips the whole hook/);
  assert.ok(printed.stdout.endsWith(block));
  assert.ok(!existsSync(join(husky, ".husky", "commit-msg")) && readFileSync(join(husky, ".husky", "_", "commit-msg"), "utf8") === HUSKY_STUB, "nothing written");
});

/** The path of git itself: a commit in a row of the table below runs with a PATH of the row's. */
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const NODE_DIR = dirname(process.execPath);
/** The shells a row runs under, each once: /bin/sh is dash on the Linux run. */
/** This volume reads a path in another case. */
const FOLDS_CASE = existsSync(tmpdir().toUpperCase());
/** A data directory spelled another way: what the block does with it, when that spelling is a directory here (`there`) and when it is none. @param {boolean} there */
const spelled = (there) => (there ? { expect: "refused", says: /inside this work tree/ } : { expect: "said", says: /no plugin version is recorded/ });
const SHELLS = [...new Map(["/bin/sh", "/bin/dash"].filter((s) => existsSync(s)).map((s) => [realpathSync(s), s])).values()];
const SYSTEM = "/usr/bin:/bin";
const PLANTED = "#!/bin/sh\nexit 0\n";
const PLANTED_CLI = "process.exit(0);\n";

/**
 * The block as a commit runs it, on the reviewers' probes (cycle 15, task 2, round 1): `env`, `files` (written
 * into the repository and committed), `record` (the first line of the record, for what the bytes are `recordBytes`),
 * and `make` for what no text says; the verdict as the corpus names it (refused, said: through with a line on
 * stderr, pass). A stand-in CLI or `node` that lets everything through makes a wrong run a silent pass.
 *
 * Not here, as documented limits (DESIGN.md): rt-record-nul-dash-ksh, rt-record-c1-dash and rt-record-c1-c-locale
 * (what `[[:cntrl:]]` and `read` make of a NUL or a C1 byte is the shell's and the locale's: dash and ksh drop the
 * NUL and run the path that is left), rt-husky9-init-sh-exit (a user's ~/.config/husky/init.sh runs before the file).
 * Not here, measured on the real runners in review: rt-husky8-real-runner, rt-husky-zero. `every`: a row that also runs
 * under bash, ksh and zsh, whose builtin pwd keeps a spelling dash's does not.
 * @typedef {{ repo: string, home: string, data: string, empty: string, stand: string }} Box
 * @typedef {{ id: string, env?: (b: Box) => Record<string, string>, files?: (b: Box) => Record<string, string>, record?: (b: Box) => string, recordBytes?: (b: Box) => string, make?: (b: Box) => void, undo?: (b: Box) => void, hook?: (block: string, shell: string) => string, message?: string, secret?: boolean, expect: "refused" | "said" | "pass", says?: RegExp, not?: RegExp, notRoot?: boolean, every?: boolean, name?: string }} Row
 */
/** @type {Row[]} */
const BLOCK_ROWS = [
  // The data directory or the record inside the work tree: no hook line changed, and the repository's own CLI would run.
  { id: "rt-data-in-repo-session-var", env: (b) => ({ ENNYN_PLUGIN_DATA: join(b.repo, ".x") }), files: (b) => ({ ".x/root": `${join(b.repo, ".x")}\n`, ".x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /inside this work tree/ },
  { id: "rt-data-in-repo-config-dir", env: (b) => ({ CLAUDE_CONFIG_DIR: join(b.repo, ".c") }), files: (b) => ({ ".c/plugins/data/ennyn-test/root": `${join(b.repo, ".x")}\n`, ".x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /inside this work tree/ },
  { id: "rt-data-in-repo-through-a-link", env: (b) => ({ ENNYN_PLUGIN_DATA: join(b.stand, "into-repo", ".x") }), files: (b) => ({ ".x/root": `${join(b.repo, ".x")}\n`, ".x/scripts/ennyn.mjs": PLANTED_CLI }), make: (b) => symlinkSync(b.repo, join(b.stand, "into-repo")), secret: true, expect: "refused", says: /inside this work tree/ },
  { id: "data-in-repo-record-outside", env: (b) => ({ ENNYN_PLUGIN_DATA: join(b.repo, ".x") }), files: (b) => ({ ".x/root": `${b.stand}\n` }), make: (b) => { mkdirSync(join(b.stand, "scripts")); writeFileSync(join(b.stand, "scripts", "ennyn.mjs"), PLANTED_CLI); }, secret: true, expect: "refused", says: /data directory .* lies inside this work tree/ },
  { id: "rt-record-names-repo", record: (b) => join(b.repo, ".x"), files: () => ({ ".x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /inside this work tree/ },
  // What counts as absolute: OS is a variable anyone sets; uname is read after the PATH filter.
  { id: "rt-os-spoof-data-dir", env: () => ({ ENNYN_PLUGIN_DATA: "C:/x", OS: "Windows_NT" }), files: () => ({ "C:/x/root": "C:/x\n", "C:/x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /no absolute path/ },
  { id: "rt-os-spoof-home", env: () => ({ HOME: "C:/h", OS: "Windows_NT" }), files: () => ({ "C:/h/.claude/plugins/data/ennyn-test/root": "C:/x\n", "C:/x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /no absolute path/ },
  { id: "rt-os-spoof-record", env: () => ({ OS: "Windows_NT" }), record: () => "C:/x", files: () => ({ "C:/x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /is no absolute path to a version/ },
  { id: "rt-drive-data-dir-no-os", env: () => ({ ENNYN_PLUGIN_DATA: "C:/x" }), expect: "refused", says: /no absolute path/ },
  { id: "rt-record-drive-no-os", record: () => "C:/x", files: () => ({ "C:/x/scripts/ennyn.mjs": PLANTED_CLI }), expect: "refused" },
  { id: "windows-data-dir", env: (b) => ({ PATH: `${b.stand}:${NODE_DIR}:${SYSTEM}`, ENNYN_PLUGIN_DATA: "C:/nowhere" }), expect: "said", says: /no plugin version is recorded in C:\/nowhere/ },
  { id: "windows-record", env: (b) => ({ PATH: `${b.stand}:${NODE_DIR}:${SYSTEM}` }), record: () => "C:/x", files: () => ({ "C:/x/scripts/ennyn.mjs": PLANTED_CLI }), secret: true, expect: "refused", says: /inside this work tree/ },
  { id: "uname-planted-in-the-repository", env: (b) => ({ PATH: `${join(b.repo, "tools")}:${NODE_DIR}:${SYSTEM}`, ENNYN_PLUGIN_DATA: "C:/nowhere" }), files: () => ({ "tools/uname": "#!/bin/sh\necho MINGW64_NT\n" }), expect: "refused", says: /no absolute path/ },
  // A `node` the repository holds never runs the check.
  { id: "rt-node-path-leading-empty", env: () => ({ PATH: `:${NODE_DIR}:${SYSTEM}` }), files: () => ({ node: PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt-node-path-dot-first", env: () => ({ PATH: `.:${NODE_DIR}:${SYSTEM}` }), files: () => ({ node: PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt-node-path-relative-dir", env: () => ({ PATH: `tools:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "node-path-relative-outside", env: () => ({ PATH: `../stand:${NODE_DIR}:${SYSTEM}` }), make: (b) => writeFileSync(join(b.stand, "node"), PLANTED, { mode: 0o755 }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt-node-path-absolute-repo-dir", env: (b) => ({ PATH: `${join(b.repo, "tools")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "node-path-repo-through-a-link", env: (b) => ({ PATH: `${join(b.stand, "into-repo")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ node: PLANTED }), make: (b) => symlinkSync(b.repo, join(b.stand, "into-repo")), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  // Filtered, not refused: with no node left the commit goes through, saying so, and the planted one is not run.
  { id: "rt-node-path-trailing-empty", env: (b) => ({ PATH: `${b.empty}:` }), files: () => ({ node: PLANTED }), secret: true, expect: "said", says: /node not found/ },
  { id: "node-path-nothing-left", env: () => ({ PATH: "tools" }), files: () => ({ "tools/node": PLANTED, node: PLANTED }), secret: true, expect: "said", says: /node not found/ },
  { id: "rt-no-node", env: (b) => ({ PATH: b.empty }), secret: true, expect: "said", says: /node not found/ },
  // Nothing recorded where it looks: through, saying so.
  { id: "rt-session-var-nowhere", env: () => ({ ENNYN_PLUGIN_DATA: "/nonexistent/x" }), message: 'Revert "x"', secret: true, expect: "said", says: /no plugin version is recorded/ },
  { id: "rt-home-nowhere", env: () => ({ HOME: "/nonexistent/y" }), message: 'Revert "x"', secret: true, expect: "said", says: /no plugin version is recorded/ },
  { id: "rt-config-dir-nowhere", env: () => ({ CLAUDE_CONFIG_DIR: "/nonexistent/z" }), message: 'Revert "x"', secret: true, expect: "said", says: /no plugin version is recorded/ },
  { id: "rt-data-dir-is-a-file", env: () => ({ ENNYN_PLUGIN_DATA: "/etc/passwd" }), expect: "said", says: /no plugin version is recorded/ },
  // A data directory it cannot use refuses, and prints no byte it refused.
  { id: "rt-data-dir-unsearchable", make: (b) => chmodSync(b.data, 0), undo: (b) => chmodSync(b.data, 0o755), message: "untyped", expect: "refused", says: /cannot be read/, notRoot: true },
  { id: "rt-data-dir-blank", env: () => ({ ENNYN_PLUGIN_DATA: " " }), expect: "refused" },
  { id: "rt-config-dir-tilde", env: () => ({ CLAUDE_CONFIG_DIR: "~/.claude" }), expect: "refused" },
  { id: "rt-data-dir-newline", env: () => ({ ENNYN_PLUGIN_DATA: "/a\nb" }), expect: "refused", not: /\/a\nb/ },
  { id: "rt-data-dir-escape-printed", env: () => ({ ENNYN_PLUGIN_DATA: "/a\x1b]0;owned\x07b" }), expect: "refused", not: /\x1b|\x07/ },
  // The record's first line.
  { id: "rt-record-crlf", record: () => `${SELF}\r`, expect: "refused", not: /\r/ },
  { id: "rt-record-escape-printed", record: () => "/a\x1b]0;owned\x07b", expect: "refused", not: /\x1b|\x07/ },
  { id: "rt-record-no-final-newline", recordBytes: () => SELF, message: "untyped", expect: "refused", says: /commitMsg\.types/ },
  { id: "rt-record-tab", record: () => "/a\tb", expect: "refused" },
  { id: "rt-record-empty", recordBytes: () => "", expect: "refused" },
  { id: "rt-record-first-line-blank", recordBytes: () => `\n${SELF}\n`, expect: "refused" },
  { id: "rt-record-relative", record: () => "relative", expect: "refused" },
  // What is at the record's place.
  { id: "rt-dir-at-record", make: (b) => { rmSync(join(b.data, "root")); mkdirSync(join(b.data, "root")); }, expect: "refused", says: /is no record Ennyn wrote/ },
  { id: "rt-fifo-at-record", make: (b) => { rmSync(join(b.data, "root")); spawnSync("mkfifo", [join(b.data, "root")]); }, expect: "refused", says: /is no record Ennyn wrote/ },
  { id: "rt-unreadable-record", make: (b) => chmodSync(join(b.data, "root"), 0), expect: "refused", notRoot: true },
  { id: "rt-dangling-link-at-record", make: (b) => { rmSync(join(b.data, "root")); symlinkSync(join(b.data, "nowhere"), join(b.data, "root")); }, expect: "refused", says: /is no record Ennyn wrote/ },
  // The block given to a shell with CRLF line ends runs nothing: git has no interpreter, or the shell a syntax error.
  { id: "rt-crlf-hook-given-to-a-shell", hook: (block, shell) => `#!${shell}\n${block}`.replace(/\n/g, "\r\n"), expect: "refused" },
  // A PATH entry or a data directory spelled through a link and "..": read as the kernel reads them, not as text.
  { id: "rt2-path-link-dotdot", every: true, env: (b) => ({ PATH: `${b.repo}/link/../..:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "a/node": PLANTED }), make: (b) => { mkdirSync(join(b.repo, "a", "b", "c"), { recursive: true }); symlinkSync(join("a", "b", "c"), join(b.repo, "link")); }, secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "data-link-dotdot", every: true, env: (b) => ({ ENNYN_PLUGIN_DATA: `${b.repo}/link/../..` }), files: () => ({ "a/root": `${SELF}\n` }), make: (b) => { mkdirSync(join(b.repo, "a", "b", "c"), { recursive: true }); symlinkSync(join("a", "b", "c"), join(b.repo, "link")); }, secret: true, expect: "refused", says: /inside this work tree/ },
  // Another spelling of the work tree on a volume that folds case, or through a firmlink: on any other volume no such directory, and a PATH row holds as plain. A data row finds no record there, and the block passes the commit and says so.
  { id: "rt2-path-case-fold", every: true, env: (b) => ({ PATH: `${join(dirname(b.repo), "REPO", "tools")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt2-path-firmlink", every: true, env: (b) => ({ PATH: `/System/Volumes/Data${b.repo}/tools:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt2-pwd-firmlink", every: true, env: (b) => ({ PWD: `/System/Volumes/Data${b.repo}`, PATH: `${join(b.repo, "tools")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt2-pwd-case-fold", every: true, env: (b) => ({ PWD: join(dirname(b.repo), "REPO"), PATH: `${join(b.repo, "tools")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt2-data-case-fold", every: true, env: (b) => ({ ENNYN_PLUGIN_DATA: join(dirname(b.repo), "REPO", ".x") }), files: (b) => ({ ".x/root": `${b.stand}\n` }), make: (b) => { mkdirSync(join(b.stand, "scripts")); writeFileSync(join(b.stand, "scripts", "ennyn.mjs"), PLANTED_CLI); }, secret: true, ...spelled(FOLDS_CASE) },
  { id: "rt2-data-firmlink", every: true, env: (b) => ({ ENNYN_PLUGIN_DATA: `/System/Volumes/Data${b.repo}/.x` }), files: (b) => ({ ".x/root": `${b.stand}\n` }), make: (b) => { mkdirSync(join(b.stand, "scripts")); writeFileSync(join(b.stand, "scripts", "ennyn.mjs"), PLANTED_CLI); }, secret: true, ...spelled(existsSync("/System/Volumes/Data")) },
  // The CLI in the record's version: a link at its place, wherever it points, or its directory linked into the tree.
  { id: "cli-link-into-tree", record: (b) => b.stand, files: () => ({ "evil.mjs": PLANTED_CLI }), make: (b) => { mkdirSync(join(b.stand, "scripts")); symlinkSync(join(b.repo, "evil.mjs"), join(b.stand, "scripts", "ennyn.mjs")); }, secret: true, expect: "refused", says: /its CLI is a link/ },
  { id: "cli-link-outside", record: (b) => b.stand, make: (b) => { writeFileSync(join(b.stand, "real.mjs"), PLANTED_CLI); mkdirSync(join(b.stand, "scripts")); symlinkSync(join(b.stand, "real.mjs"), join(b.stand, "scripts", "ennyn.mjs")); }, secret: true, expect: "refused", says: /its CLI is a link/ },
  { id: "scripts-link-into-tree", record: (b) => b.stand, files: () => ({ "s2/ennyn.mjs": PLANTED_CLI }), make: (b) => symlinkSync(join(b.repo, "s2"), join(b.stand, "scripts")), secret: true, expect: "refused", says: /inside this work tree/ },
  // What a tracked .npmrc gets into node's environment through npm run, and what would load a module from the tree.
  { id: "rt2-node-options-absolute", env: (b) => ({ NODE_OPTIONS: `--require ${join(b.repo, "p.cjs")}` }), files: () => ({ "p.cjs": PLANTED_CLI }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "rt2-node-options-relative", env: () => ({ NODE_OPTIONS: "--require ./p.cjs" }), files: () => ({ "p.cjs": PLANTED_CLI }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "node-path-unset", env: (b) => ({ NODE_PATH: b.repo }), record: (b) => b.stand, make: (b) => { mkdirSync(join(b.stand, "scripts")); writeFileSync(join(b.stand, "scripts", "ennyn.mjs"), 'process.stderr.write(`NODE_PATH ${process.env.NODE_PATH ?? "unset"}\\n`);\nprocess.exit(1);\n'); }, expect: "refused", says: /NODE_PATH unset/ },
  // Under sh -e, set by a shebang or a line before the block: what it refuses it still says.
  { id: "data-dir-unsearchable-e", hook: (block, shell) => `#!${shell} -e\n${block}`, make: (b) => chmodSync(b.data, 0), undo: (b) => chmodSync(b.data, 0o755), message: "untyped", expect: "refused", says: /cannot be read/, notRoot: true },
  { id: "set-e-line-secret", every: true, hook: (block, shell) => `#!${shell}\nset -eu\n${block}`, secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "set-e-line-clean", hook: (block, shell) => `#!${shell}\nset -eu\n${block}`, expect: "pass" },
  { id: "shebang-e-secret", hook: (block, shell) => `#!${shell} -e\n${block}`, secret: true, expect: "refused", says: /adds what reads as a secret/ },
  // A work tree whose path a case pattern would read: the top is compared as text.
  ...["r*", "r[a-z]", "r'q", "r$v"].map((name) => ({ id: `glob-top ${name}`, name, env: (/** @type {Box} */ b) => ({ PATH: `${join(b.repo, "tools")}:${NODE_DIR}:${SYSTEM}` }), files: () => ({ "tools/node": PLANTED }), secret: true, expect: /** @type {const} */ ("refused"), says: /adds what reads as a secret/ })),
  // No record (an install again deletes it): the plugin session's version checks the commit when it is an installed one.
  { id: "session-root-no-record", every: true, env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b) }), make: (b) => rmSync(join(b.data, "root")), expect: "refused", says: /checked with the version this Claude Code session runs\.\n.*\nran session/s },
  { id: "session-var-from-environment", env: () => ({ session: "1", line: "/nowhere", root: "/nowhere" }), secret: true, expect: "refused", says: /adds what reads as a secret/ },
  { id: "session-root-uninstalled", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b) }), make: (b) => { rmSync(join(b.data, "root")); writeFileSync(join(sessionVersion(b), ".orphaned_at"), "1\n"); }, expect: "said", says: /so the commit message is not checked/, not: /ran session/ },
  { id: "session-root-no-data-var", env: (b) => ({ ENNYN_PLUGIN_ROOT: sessionVersion(b) }), make: (b) => rmSync(join(b.data, "root")), expect: "said", says: /so the commit message is not checked/, not: /ran session/ },
  { id: "session-root-outside-cache", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b, b.stand) }), make: (b) => rmSync(join(b.data, "root")), expect: "said", says: /so the commit message is not checked/, not: /ran session/ },
  { id: "session-root-dotdot", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: `${dirname(dirname(b.data))}/cache/../../../../stand` }), make: (b) => { rmSync(join(b.data, "root")); sessionVersion(b, b.stand); }, expect: "said", not: /ran session/ },
  { id: "session-root-cache-linked-into-tree", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: join(dirname(dirname(b.data)), "cache", "test", "ennyn", "1") }), files: () => ({ "test/ennyn/1/scripts/ennyn.mjs": PLANTED_CLI }), make: (b) => { rmSync(join(b.data, "root")); symlinkSync(b.repo, join(dirname(dirname(b.data)), "cache")); }, secret: true, expect: "refused", says: /inside this work tree/ },
  // The fold of a backslash is the shell's own: no program on PATH, and every byte kept.
  { id: "session-root-no-tr-on-path", env: (b) => ({ PATH: NODE_DIR, ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b) }), make: (b) => rmSync(join(b.data, "root")), expect: "refused", says: /ran session/ },
  { id: "session-root-trailing-newline", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: `${sessionVersion(b)}\n` }), make: (b) => rmSync(join(b.data, "root")), expect: "said", not: /ran session/ },
  // Exactly <cache>/<marketplace>/<plugin>/<version>, the two names those of the data directory (<plugin>-<marketplace>).
  { id: "session-root-other-marketplace", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b, join(dirname(dirname(b.data)), "cache", "other", "ennyn", "0.0.1")) }), make: (b) => rmSync(join(b.data, "root")), expect: "said", not: /ran session/ },
  { id: "session-root-shallower", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b, join(dirname(dirname(b.data)), "cache", "test", "0.0.1")) }), make: (b) => rmSync(join(b.data, "root")), expect: "said", not: /ran session/ },
  { id: "session-root-deeper", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b, join(dirname(dirname(b.data)), "cache", "x", "test", "ennyn", "0.0.1")) }), make: (b) => rmSync(join(b.data, "root")), expect: "said", not: /ran session/ },
  // Windows spellings: plugin-root names the root with backslashes (resolve), Claude Code the data directory with slashes.
  { id: "session-root-backslashes", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: sessionVersion(b).replace(/\//g, "\\") }), make: (b) => rmSync(join(b.data, "root")), expect: "refused", says: /ran session/ },
  { id: "session-root-dotdot-backslashes", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: `${join(dirname(dirname(b.data)), "cache", "test", "ennyn")}\\..` }), make: (b) => { rmSync(join(b.data, "root")); sessionVersion(b, join(dirname(dirname(b.data)), "cache", "test")); mkdirSync(join(dirname(dirname(b.data)), "cache", "test", "ennyn")); }, expect: "said", not: /ran session/ },
  { id: "session-root-empty-version", env: (b) => ({ ENNYN_PLUGIN_DATA: b.data, ENNYN_PLUGIN_ROOT: `${sessionVersion(b, join(dirname(dirname(b.data)), "cache", "test", "ennyn"))}/` }), make: (b) => rmSync(join(b.data, "root")), expect: "said", not: /ran session/ },
  ...[["C:\\d\\plugins\\data\\ennyn-test", "C:\\d\\plugins\\cache\\test\\ennyn\\1"], ["C:/d/plugins/data/ennyn-test", "C:\\d\\plugins\\cache\\test\\ennyn\\1"], ["C:\\d\\plugins\\data\\ennyn-test", "C:/d/plugins/cache/test/ennyn/1"]].map(([data, root], i) => ({
    id: `session-root-windows-${i}`,
    env: (/** @type {Box} */ b) => ({ PATH: `${b.stand}:${NODE_DIR}:${SYSTEM}`, ENNYN_PLUGIN_DATA: data, ENNYN_PLUGIN_ROOT: root }),
    // A drive path is relative here: the version found under the work tree, so a fallback that fires reaches the tree's refusal.
    files: () => ({ "C:/d/plugins/cache/test/ennyn/1/scripts/ennyn.mjs": PLANTED_CLI }),
    secret: true,
    expect: /** @type {const} */ ("refused"),
    says: /inside this work tree/,
  })),
  // A clean commit through a good record, and the same with a secret.
  { id: "clean", every: true, expect: "pass" },
  { id: "secret", every: true, secret: true, expect: "refused", says: /adds what reads as a secret/ },
];

/** A stand-in plugin version under the cache beside the box's data directory (or under `at`), whose CLI says it ran and refuses. @param {Box} b @param {string} [at] */
function sessionVersion(b, at = join(dirname(dirname(b.data)), "cache", "test", "ennyn", "0.0.1")) {
  mkdirSync(join(at, "scripts"), { recursive: true });
  writeFileSync(join(at, "scripts", "ennyn.mjs"), 'process.stderr.write("ran session\\n");\nprocess.exit(1);\n');
  return at;
}

/** The shells of an `every` row beyond SHELLS, each once. */
const MORE_SHELLS = ["/bin/bash", "/bin/ksh", "/bin/zsh"].filter((s) => existsSync(s) && !SHELLS.some((k) => realpathSync(k) === realpathSync(s)));

/** One row on a repository of its own, under `shell`. @param {Row} row @param {string} shell */
function blockRow(row, shell) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-rt-")));
  const repo = join(base, row.name ?? "repo");
  const home = join(base, "home");
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  const b = { repo, home, data, empty: join(base, "empty"), stand: join(base, "stand") };
  for (const d of [repo, b.empty, b.stand]) mkdirSync(d, { recursive: true });
  // A stand-in for uname on Git for Windows, in an absolute directory outside the repository.
  writeFileSync(join(b.stand, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0\n", { mode: 0o755 });
  git(["init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, ".ennyn"));
  writeFileSync(join(repo, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" } }));
  mkdirSync(join(repo, ".githooks"));
  const block = hookBlock(data);
  writeFileSync(join(repo, ".githooks", "commit-msg"), row.hook ? row.hook(block, shell) : `#!${shell}\n${block}`, { mode: 0o755 });
  git(["config", "core.hooksPath", ".githooks"], { cwd: repo });
  for (const [path, text] of Object.entries(row.files?.(b) ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text, { mode: 0o755 });
  }
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: repo });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "root"), row.recordBytes ? row.recordBytes(b) : `${row.record ? row.record(b) : SELF}\n`);
  row.make?.(b);
  writeFileSync(join(repo, "n.txt"), String(Math.random()));
  if (row.secret) writeFileSync(join(repo, "token.js"), `export const token = "${SECRET}";\n`);
  git(["add", "-A"], { cwd: repo });
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", row.message ?? "feat: x"], { cwd: repo, env: outside({ HOME: home, ...row.env?.(b) }), encoding: "utf8", timeout: 30000 });
  row.undo?.(b);
  return { verdict: r.status !== 0 ? "refused" : r.stderr ? "said" : "pass", stderr: r.stderr };
}

const { TOKENS: { github: SECRET } } = await import("./secret-shapes.mjs");
const asRoot = process.getuid?.() === 0;

test("block, run by real commits: every probe of rounds 1 and 2 gets its verdict, under /bin/sh and under dash where there is one, the spelling rows under each shell there is", async (t) => {
  for (const shell of [...SHELLS, ...MORE_SHELLS]) {
    for (const row of BLOCK_ROWS.filter((r) => r.every || SHELLS.includes(shell))) {
      await t.test(`${row.id} (${shell})`, { skip: row.notRoot && asRoot ? "root reads what mode 0 forbids" : false }, () => {
        const got = blockRow(row, shell);
        assert.equal(got.verdict, row.expect, got.stderr);
        if (row.says) assert.match(got.stderr, row.says);
        if (row.not) assert.doesNotMatch(got.stderr, row.not);
      });
    }
  }
});

test("block under husky 9.1.7's stub and PATH line: node_modules/.bin/node, linked with no install script, never runs the check; a project that depends on it still commits", (t) => {
  if (!existsSync("/bin/sh")) return t.skip("no /bin/sh");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-rt-")));
  const home = join(base, "home");
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const dir = doctorRepo();
  mkdirSync(join(dir, ".husky", "_"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
  writeFileSync(join(dir, ".husky", "_", "h"), HUSKY_RUNNER, { mode: 0o755 });
  writeFileSync(join(dir, ".husky", "commit-msg"), hookBlock(data));
  writeFileSync(join(dir, "node_modules", ".bin", "node"), PLANTED, { mode: 0o755 });
  git(["config", "core.hooksPath", ".husky/_"], { cwd: dir });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  const env = outside({ HOME: home, PATH: `${NODE_DIR}:${SYSTEM}` });
  const refused = commitIn(dir, 'Revert "x"', { "token.js": `export const token = "${SECRET}";\n` }, env);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /adds what reads as a secret/);
  assert.equal(commitIn(dir, "feat: clean", { "n.txt": String(Math.random()) }, env).status, 0);
});

test("block with nothing left on PATH: an empty PATH means the current directory to sh and dash, so it names none, and the node the repository holds never runs", () => {
  const home = mkdtempSync(join(tmpdir(), "en-home-"));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const dir = trackedHooks(hookBlock(data));
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "tools", "node"), PLANTED, { mode: 0o755 });
  writeFileSync(join(dir, "node"), PLANTED, { mode: 0o755 });
  const msg = join(home, "msg");
  writeFileSync(msg, "feat: PRJ-1 a\n");
  // Run by hand: git puts its exec path first, so a hook it runs never finds PATH empty.
  for (const shell of SHELLS) {
    const r = spawnSync(shell, [join(dir, ".githooks", "commit-msg"), msg], { cwd: dir, env: outside({ HOME: home, PATH: "tools" }), encoding: "utf8" });
    assert.deepEqual([r.status, /node not found/.test(r.stderr)], [0, true], `${shell}: ${r.stderr}`);
  }
});

test("a call behind an early exit, marked or not, is no ✓: doctor warns, install-hook offers the block, and real git shows why; the printed line first holds", async () => {
  const home = mkdtempSync(join(tmpdir(), "en-home-"));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const dir = doctorRepo();
  mkdirSync(join(dir, ".githooks"));
  const hook = join(dir, ".githooks", "commit-msg");
  // The evidence's own hook: the exit for exempt subjects, then the line written by hand from the record.
  const line = `node "$(cat "$HOME/.claude/plugins/data/ennyn-test/root")/scripts/ennyn.mjs" commit-check --hook "$1" || exit $?\n`;
  writeFileSync(hook, `#!/bin/sh\nIFS= read -r s < "$1"\ncase $s in\n  Merge*|Revert*) exit 0 ;;\nesac\n${line}`, { mode: 0o755 });
  git(["config", "core.hooksPath", ".githooks"], { cwd: dir });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"]);
  const before = readFileSync(hook, "utf8");
  const r = installCli(dir, sessionEnv(data, SELF));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /names commit-check/);
  assert.ok(r.stdout.endsWith(hookBlock(data)), r.stdout);
  assert.equal(readFileSync(hook, "utf8"), before, "the project's hook is not written");
  const env = outside({ HOME: home });
  const token = { "token.js": `export const token = "${SECRET}";\n` };
  assert.equal(commitIn(dir, 'Revert "x"', token, env).status, 0, "the oracle: the early exit skipped the line");
  git(["reset", "-q", "--hard", "HEAD~1"], { cwd: dir });
  // By hand from the record, first: not what install-hook printed, though it checks.
  writeFileSync(hook, `#!/bin/sh\n${line}IFS= read -r s < "$1"\ncase $s in\n  Merge*|Revert*) exit 0 ;;\nesac\n`);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(dir, 'Revert "x"', token, env).status, 1, "a false warning, which stops no commit");
  writeFileSync(hook, `#!/bin/sh\n${printedLine(CLI, data)}\nIFS= read -r s < "$1"\ncase $s in\n  Merge*|Revert*) exit 0 ;;\nesac\n`);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"], "the printed line first");
  assert.equal(commitIn(dir, 'Revert "x"', token, env).status, 1);
  // An Ennyn hook holds exits of its own before its call: it is no late hook.
  const own = doctorRepo();
  installHook({ cwd: own, cliPath: CLI, pluginData: data });
  assert.deepEqual([hookStatus(own).unread, hookStatus(own).late], [null, null]);
  assert.deepEqual(await hookKeys(own), ["doctor.hookOk"]);
});

test("a hook counts only with what install-hook printed, byte for byte and first, under a shell the list names: anything else that names it reads unread", () => {
  const block = hookBlock("/x/plugins/data/ennyn-ennyn");
  const line = `${printedLine("/opt/ennyn/scripts/ennyn.mjs")}\n`;
  const record = `${printedLine("", "/x/plugins/data/ennyn-ennyn")}\n`;
  const sh = "#!/bin/sh\n";
  const wired = (/** @type {string} */ text) => assert.notEqual(printedCheck(text), null, text);
  const unread = (/** @type {string} */ text) => assert.equal(printedCheck(text), null, text);
  assert.deepEqual(printedCheck(`${sh}${block}`), { id: "ennyn-ennyn", path: null });
  assert.deepEqual(printedCheck(`${sh}${line}`), { id: null, path: "/opt/ennyn/scripts/ennyn.mjs" });
  assert.deepEqual(printedCheck(`${sh}${record}`), { id: null, path: "/x/plugins/data/ennyn-ennyn/root" });
  // The path comes back unquoted, whatever it holds.
  for (const root of ["/opt/with space", "/opt/qu'ote", '/opt/d"q', "/opt/$HOME", "/opt/ha #sh", "/opt/ünï"]) {
    const cli = `${root}/scripts/ennyn.mjs`;
    assert.deepEqual(printedCheck(`${printedLine(cli)}\n`), { id: null, path: cli }, root);
    assert.deepEqual(printedCheck(`${printedLine("", root)}\n`), { id: null, path: `${root}/root` }, root);
  }
  // Before it: a shebang the list names, blank lines, comments, set lines of e, u and x. After it, anything.
  const shebangs = [];
  for (const dir of ["/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/", "/usr/bin/env ", "#!  /bin/"]) for (const name of ["sh", "bash", "dash", "ksh", "zsh", "ash"]) shebangs.push(dir.startsWith("#!") ? `${dir}${name}` : `#!${dir}${name}`);
  shebangs.push("#!/bin/sh -e", "#!/bin/bash -eux", "#!/usr/bin/env sh -u", "#!/bin/sh ");
  for (const printed of [block, line, record]) {
    for (const shebang of shebangs) wired(`${shebang}\n${printed}`);
    for (const before of ["", "\n", "\n\n", "# ours\n\n", "  # indented\n", "\t\n", "# ends in a backslash \\\n", "set -e\n", "set -eu\n", "set -e -u -x\n", "  set -x  \n", "# no shebang here\n#!/usr/bin/python3\n"]) wired(`${before}${printed}`);
    for (const after of ["exit 0\n", "true ||\n", "'unclosed\n", ". ./lib.sh\n", "\r\n"]) wired(`${sh}${printed}${after}`);
    wired(`${sh}${printed.trimEnd()}`);
    // No shebang on the list: it is no shell the text is known to run under.
    for (const shebang of ["#!/usr/bin/env node", "#!/usr/bin/python3", "#!/bin/fish", "#!/bin/csh", "#!/bin/mksh", "#!/usr/bin/fish", "#!/bin/sh\r", "#!/bin/sh -n", "#!/bin/sh -s", "#!/bin/sh -c true", "#!/bin/sh -en", "#!/bin/sh --", "#!/bin/bash -n", "#!/usr/bin/env -S sh", "#!/usr/bin/env -S bash -e", "#!/usr/bin/env -S sh -n", "#!/usr/bin/env -S sh -c true", "#!/usr/bin/env -i sh", "#!/usr/bin/env A=1 sh", "#!sh", "#!bin/sh", "#!/proc/self/cwd/tools/sh", "#!/tmp/bin/sh", "#!/bin/../tmp/sh", "#!/opt/bin/sh", "#!/usr/local/sbin/sh", "#!/bin/env sh", "#!/usr/bin/env ./sh", "#!/usr/bin/env tools/sh"]) unread(`${shebang}\n${printed}`);
    // Before it: anything else, husky's own line among them.
    for (const before of [". ./lib.sh\n", '. "$(dirname -- "$0")/_/husky.sh"\n', '. "$(dirname "$0")/_/husky.sh"\n', "set -n\n", "set -o noexec\n", "set -en\n", "set -- x\n", "set\n", "set -o errexit\n", "set -euo pipefail\n", "set -e # strict\n", "set -e; exit 0\n", "set -e \\\n  && exit 0\n", "set -e# x\n", "exit 0\n", "true\n", ":\n", "\r\n", "\f\n", "\u00a0\n", "\ufeff\n", "\ufeff#!/bin/sh\n", "# ours\r\n", "# a\rexit 0\n", "x=1\n", "cat <<E\n", "x='\n", "if false; then\n"]) {
      unread(`${sh}${before}${printed}`);
    }
    for (const before of ["! ", "exec ", "A=1 ", "true ", "  ", "\t", "(", "{ ", ">/dev/null ", "if "]) unread(`${sh}${before}${printed}`);
  }
  // The block, edited in any way.
  const edits = [
    block.replace(") || exit $?", ") || true"),
    block.replace(") || exit $?", ")"),
    block.replace(/^.*Printed by.*\n/m, ""),
    block.replace("id='ennyn-ennyn'", "id=ennyn-ennyn"),
    block.replace("id='ennyn-ennyn'", "id='../x'"),
    block.replace("id='ennyn-ennyn'", "id=''"),
    block.replace(/^ {2}top=.*\n/m, ""),
    block.replace(/\n/g, "\r\n"),
    block.replace(/\n/g, "\r"),
    block.trimEnd() + " # ours\n",
    block.trimEnd() + "\r\n",
    block.replace(/cd -P/g, "cd"),
    block.split("\n").filter((l) => !l.startsWith("# ")).join("\n"),
    `${BLOCK_MARKER}\n${line}`,
  ];
  for (const text of edits) assert.notEqual(text, block);
  for (const text of edits) unread(`${sh}${text}`);
  // The line, edited in any way: a shape install-hook does not print for a path it does not name.
  const [head, tail] = printedLine("/opt/ennyn/scripts/ennyn.mjs").split("'/opt/ennyn/scripts/ennyn.mjs'");
  for (const text of [
    "node /opt/ennyn/scripts/ennyn.mjs commit-check --hook \"$1\" || exit $?",
    'node "/opt/ennyn/scripts/ennyn.mjs" commit-check --hook "$1" || exit $?',
    "node '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\"",
    "node '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\" || exit 1",
    "node '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\" || exit $? # ours",
    "node '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\" || exit $?\rexit 0",
    "node '/opt/ennyn/scripts/ennyn.mjs' commit-check \"$1\" || exit $?",
    "node  '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\" || exit $?",
    "nodejs '/opt/ennyn/scripts/ennyn.mjs' commit-check --hook \"$1\" || exit $?",
    "npx ennyn commit-check --hook \"$1\" || exit $?",
    `${head}'scripts/ennyn.mjs'${tail}`,
    `${head}'./scripts/ennyn.mjs'${tail}`,
    `${head}'tools/x/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/ennyn/lax.mjs'${tail}`,
    `${head}'/opt/ennyn/ennyn.mjs'${tail}`,
    `${head}'/opt/ennyn/scripts/../lax/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt//ennyn/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/a\rb/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/a\tb/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/a'b'/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/a'"'"'b/scripts/ennyn.mjs'${tail}`,
    `${head}'/opt/ennyn/scripts/ennyn.mjs' 'x'${tail}`,
    "node \"$(cat /x/root)/scripts/ennyn.mjs\" commit-check --hook \"$1\" || exit $?",
    "node \"$(cat '/x/other')/scripts/ennyn.mjs\" commit-check --hook \"$1\" || exit $?",
    "node \"$(cat 'x/root')/scripts/ennyn.mjs\" commit-check --hook \"$1\" || exit $?",
    "node \"$(cat \"$HOME/.claude/plugins/data/e/root\")/scripts/ennyn.mjs\" commit-check --hook \"$1\" || exit $?",
    "node \"$(cat '/x/root')/scripts/lax.mjs\" commit-check --hook \"$1\" || exit $?",
    "node \"$(cat '/x//root')/scripts/ennyn.mjs\" commit-check --hook \"$1\" || exit $?",
  ]) unread(`${sh}${text}\n`);
  // A Node hook is hand-written too, and an empty file or one of comments holds nothing printed.
  for (const text of ['#!/usr/bin/env node\nrequire("child_process").execFileSync("node", [cli, "commit-check", process.argv[2]]);\n', "", "\n", sh, `${sh}\n# only a comment\n`, "# commit-check\n"]) unread(text);
});

test("hook in a linked worktree: a core.hooksPath an agent worktree made absolute is still the repository's, not a global directory, tracked and under husky", async () => {
  const home = mkdtempSync(join(tmpdir(), "en-home-"));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  const worktree = (/** @type {string} */ dir) => {
    const wt = join(mkdtempSync(join(tmpdir(), "en-hook-wt-")), "wt");
    git(["worktree", "add", "-q", "-b", "agent", wt], { cwd: dir });
    return wt;
  };
  const dir = trackedHooks(hookBlock(data));
  git(["config", "core.hooksPath", join(dir, ".githooks")], { cwd: dir });
  const wt = worktree(dir);
  assert.deepEqual([hookStatus(wt).hooksKind, hookStatus(wt).state], ["repo", "wired"]);
  assert.deepEqual(await hookKeys(wt, { HOME: home }), ["doctor.hookOk"]);
  // With nothing wired yet: the block for the tracked file, never a home path as a line to add to it.
  const bare = doctorRepo();
  mkdirSync(join(bare, ".githooks"));
  writeFileSync(join(bare, ".githooks", "x"), "x\n");
  git(["add", "-A"], { cwd: bare });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: bare });
  git(["config", "core.hooksPath", join(bare, ".githooks")], { cwd: bare });
  const printed = installCli(worktree(bare), sessionEnv(data, SELF));
  assert.equal(printed.status, 1);
  assert.match(printed.stdout, /Paste the block below at the top of /);
  assert.ok(!printed.stdout.includes(home), printed.stdout);
  assert.ok(printed.stdout.endsWith(hookBlock(data)), printed.stdout);
  // husky's stubs behind an absolute path, from the linked worktree: wired, through the file the stub runs.
  const husky = doctorRepo();
  mkdirSync(join(husky, ".husky", "_"), { recursive: true });
  writeFileSync(join(husky, ".husky", "_", ".gitignore"), "*");
  writeFileSync(join(husky, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
  writeFileSync(join(husky, ".husky", "commit-msg"), hookBlock(data));
  git(["add", "-A"], { cwd: husky });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: husky });
  git(["config", "core.hooksPath", join(husky, ".husky", "_")], { cwd: husky });
  const huskyWt = worktree(husky);
  assert.deepEqual([hookStatus(huskyWt).hooksKind, hookStatus(huskyWt).state], ["husky", "wired"]);
  assert.deepEqual(await hookKeys(huskyWt, { HOME: home }), ["doctor.hookOk"]);
  // A directory outside both stays global, from a linked worktree too.
  const global = mkdtempSync(join(tmpdir(), "en-global-hooks-"));
  git(["config", "core.hooksPath", global], { cwd: dir });
  assert.equal(hookStatus(wt).hooksKind, "global");
  // A bare repository's worktree: the folder that holds the repository is no checkout of it.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-hook-bare-")));
  git(["clone", "-q", "--bare", dir, join(base, "x.git")], { cwd: base });
  git([`--git-dir=${join(base, "x.git")}`, "worktree", "add", "-q", join(base, "wt")], { cwd: base });
  mkdirSync(join(base, "hooks"));
  git(["config", "core.hooksPath", join(base, "hooks")], { cwd: join(base, "wt") });
  assert.equal(hookStatus(join(base, "wt")).hooksKind, "global");
});

test("doctor reads the record the block reads, in the block's order: nothing recorded or nothing it may run is no ✓, and install-hook says the same", async () => {
  const base = mkdtempSync(join(tmpdir(), "en-plugin-"));
  const home = join(base, "home");
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  const dir = trackedHooks(hookBlock(data));
  const env = { HOME: home };
  /** @param {Record<string, string>} e */
  const said = (e) => hookKeys(dir, e);
  const cli = () => installCli(dir, outside({ HOME: home }));
  assert.deepEqual(await said(env), ["doctor.hookBlockUnrecorded"], "no record: every commit goes through");
  assert.match(cli().stdout, /where none is recorded, so every commit goes through unchecked/);
  assert.equal(cli().status, 1);
  hookModule.recordPluginRoot(data, SELF);
  assert.deepEqual(await said(env), ["doctor.hookOk"]);
  assert.equal(cli().status, 0);
  // A record it cannot run: every commit is refused.
  writeFileSync(join(data, "root"), `${join(base, "gone")}\n`);
  assert.deepEqual(await said(env), ["doctor.hookBlockStale"]);
  assert.match(cli().stdout, /so every commit is refused/);
  assert.equal(cli().status, 1);
  assert.equal(commitIn(dir, "feat: PRJ-1 a", { "n.txt": "1" }, outside({ HOME: home })).status, 1, "the oracle: the block refuses it");
  rmSync(join(data, "root"));
  symlinkSync(join(base, "gone"), join(data, "root"));
  assert.deepEqual(await said(env), ["doctor.hookBlockStale"], "a link at the record's place");
  rmSync(join(data, "root"));
  mkdirSync(join(dir, ".x", "scripts"), { recursive: true });
  writeFileSync(join(dir, ".x", "scripts", "ennyn.mjs"), PLANTED_CLI);
  writeFileSync(join(data, "root"), `${join(dir, ".x")}\n`);
  assert.deepEqual(await said(env), ["doctor.hookBlockStale"], "a record that names the repository");
  rmSync(join(data, "root"));
  // The block's order: the session's directory, then CLAUDE_CONFIG_DIR's, then HOME's.
  hookModule.recordPluginRoot(data, SELF);
  const config = join(base, "config");
  assert.deepEqual(await said({ ...env, CLAUDE_CONFIG_DIR: config }), ["doctor.hookBlockUnrecorded"]);
  hookModule.recordPluginRoot(join(config, "plugins", "data", "ennyn-test"), SELF);
  assert.deepEqual(await said({ ...env, CLAUDE_CONFIG_DIR: config }), ["doctor.hookOk"]);
  assert.deepEqual(await said({ ...env, CLAUDE_CONFIG_DIR: config, ENNYN_PLUGIN_DATA: join(base, "nowhere") }), ["doctor.hookBlockUnrecorded"]);
  // A version Claude Code has replaced still runs, with that version's checks: no line for the tracked file.
  const old = pluginVersion(base, "0.9.0");
  writeFileSync(join(old, ".orphaned_at"), "1\n");
  writeFileSync(join(data, "root"), `${old}\n`);
  assert.deepEqual(await said(env), ["doctor.hookOk"]);
  assert.equal(cli().status, 0, cli().stdout);
  hookModule.recordPluginRoot(data, SELF);
  // No directory it may read: no HOME, no absolute path, a control character, or one inside the repository.
  for (const e of [{}, { HOME: "relative" }, { ENNYN_PLUGIN_DATA: `${base}\r` }, { ENNYN_PLUGIN_DATA: join(dir, ".x") }]) assert.deepEqual(await said(e), ["doctor.hookBlockNoData"], JSON.stringify(e));
  const noData = installCli(dir, outside({ HOME: home, ENNYN_PLUGIN_DATA: join(dir, ".x") }));
  assert.equal(noData.status, 1);
  assert.match(noData.stdout, /finds no plugin data directory it may read here/);
});

test("install-hook refuses a data directory whose last part the block could not carry", () => {
  const dir = doctorRepo();
  mkdirSync(join(dir, ".githooks"));
  git(["config", "core.hooksPath", ".githooks"], { cwd: dir });
  for (const data of ["/x/..", "/x/.", "/", "/x/it's", "/x/a b", "/x/$(id)"]) {
    const r = installCli(dir, {}, "--plugin-data", data);
    assert.equal(r.status, 1, data);
    assert.match(r.stdout, /does not end in a name the block can hold/, data);
    assert.ok(!r.stdout.includes(BLOCK_MARKER), data);
  }
  assert.ok(installCli(dir, {}, "--plugin-data", "/x/ennyn_A-1.b").stdout.endsWith(hookBlock("/x/ennyn_A-1.b")));
  // The same where the block would replace a call that may be skipped.
  writeFileSync(join(dir, ".githooks", "commit-msg"), '#!/bin/sh\n[ -n "$A" ] && exit 0\nnode x/ennyn.mjs commit-check "$1"\n', { mode: 0o755 });
  const late = installCli(dir, {}, "--plugin-data", "/x/..");
  assert.equal(late.status, 1);
  assert.match(late.stdout, /does not end in a name the block can hold/);
  assert.ok(!late.stdout.includes(BLOCK_MARKER));
});

/** A home with the plugin recorded: this checkout as the version a hook runs. */
function plugged() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "en-home-")));
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, SELF);
  return { home, data };
}

/** A repository whose tracked .githooks/commit-msg is `text`, with `files`, committed. @param {string} text @param {Record<string, string>} [files] */
function ownHook(text, files = {}) {
  const dir = doctorRepo();
  mkdirSync(join(dir, ".githooks"));
  writeFileSync(join(dir, ".githooks", "commit-msg"), text, { mode: 0o755 });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(["config", "core.hooksPath", ".githooks"], { cwd: dir });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  return dir;
}

const TOKEN = { "token.js": `export const token = "${SECRET}";\n` };

test("a call that is not the printed line, first, is no ✓, however the hook skips it: doctor warns, install-hook offers the block, and a real Revert lands a secret", async () => {
  const { home, data } = plugged();
  const call = `node '${CLI.replace(/'/g, "'\\''")}' commit-check --hook "$1"`;
  const read = 'IFS= read -r s < "$1"\n';
  const shapes = {
    "a function above the exit": `#!/bin/sh\ncheck() {\n  ${call}\n}\n${read}case $s in\n  Merge*|Revert*) exit 0 ;;\nesac\ncheck "$1"\n`,
    "a one-line function above the exit": `#!/bin/sh\ncheck() { ${call}; }\n${read}case $s in Revert*) exit 0 ;; esac\ncheck "$1"\n`,
    "a variable above the exit": `#!/bin/sh\nENNYN="${call.replace(/ "\$1"$/, "")}"\n${read}case $s in\n  Revert*) exit 0 ;;\nesac\n$ENNYN "$1"\n`,
    "a subcommand variable above the exit": `#!/bin/sh\nSUB=commit-check\n${read}case $s in\n  Revert*) exit 0 ;;\nesac\n${call.replace("commit-check", '"$SUB"')}\n`,
    "a case arm": `#!/bin/sh\n${read}case $s in\n  Merge*|Revert*) ;;\n  *) ${call} ;;\nesac\n`,
    "an if guard": `#!/bin/sh\n${read}case $s in Revert*) skip=1 ;; esac\nif [ -z "$skip" ]; then\n  ${call}\nfi\n`,
    "an or guard": `#!/bin/sh\n${read}case $s in Revert*) skip=1 ;; esac\n[ -n "$skip" ] || ${call}\n`,
    "a return in main": `#!/bin/sh\nmain() {\n  ${read}  case $s in Revert*) return 0 ;; esac\n  ${call}\n}\nmain "$@"\n`,
    "exec true": `#!/bin/sh\n${read}case $s in Revert*) exec true ;; esac\n${call}\n`,
  };
  const env = outside({ HOME: home });
  for (const [name, text] of Object.entries(shapes)) {
    const dir = ownHook(text);
    assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"], name);
    const r = installCli(dir, sessionEnv(data, SELF));
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.ok(r.stdout.endsWith(hookBlock(data)), `${name}: install-hook offers the block`);
    assert.equal(commitIn(dir, 'Revert "x"', TOKEN, env).status, 0, `the oracle, ${name}: the Revert skipped the call`);
    git(["reset", "-q", "--hard", "HEAD~1"], { cwd: dir });
    assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 1, `${name}: a typed subject is still checked`);
  }
  // The same early exits behind the printed line, and the Revert is refused.
  const first = ownHook(`#!/bin/sh\n# the convention\n\nset -eu\n${printedLine(CLI)}\n${read}case $s in\n  Revert*) exit 0 ;;\nesac\n`);
  assert.deepEqual(await hookKeys(first, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(first, 'Revert "x"', TOKEN, env).status, 1);
  // A false warning is accepted: checks of the project's own before the call warn, and stop no commit.
  const other = ownHook(`#!/bin/sh\nawk 'NR==1 && length > 72 { exit 1 }' "$1"\n${call}\n`);
  assert.deepEqual(await hookKeys(other, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(other, "feat: x", { "n.txt": "1" }, env).status, 0);
});

test("a shebang whose flags run nothing is no ✓, for the block and for a call: real git lands a secret behind each; -e and -u still run", async () => {
  const { home, data } = plugged();
  const block = hookBlock(data);
  const env = outside({ HOME: home });
  const envS = spawnSync("/usr/bin/env", ["-S", "true"]).status === 0;
  const idle = ["#!/bin/sh -n", "#!/bin/sh -s", ...(existsSync("/bin/bash") ? ["#!/bin/bash -n"] : []), ...(envS ? ["#!/usr/bin/env -S sh -n", "#!/usr/bin/env -S sh -c true"] : [])];
  const call = `${printedLine(CLI)}\n`;
  for (const shebang of idle) {
    for (const body of [block, call]) {
      const dir = ownHook(`${shebang}\n${body}`);
      assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"], shebang);
      assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 0, `the oracle, ${shebang}: the hook ran nothing`);
    }
  }
  for (const shebang of ["#!/bin/sh -e", "#!/bin/sh -eu", "#!/bin/sh -x"]) {
    const dir = ownHook(`${shebang}\n${block}`);
    assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"], shebang);
    assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 1, shebang);
    assert.equal(commitIn(dir, "feat: x", { "n.txt": "1" }, env).status, 0, shebang);
  }
  // set -n as a line: the same.
  const dir = ownHook(`#!/bin/sh\nset -n\n${block}`);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 0, "the oracle: set -n ran nothing");
});

test("husky's line above the block warns whatever the file it sources: a tracked _/husky.sh that exits lands a secret, and the directory's name proves nothing; above it the block is ✓ in the git directory too", async () => {
  const { home, data } = plugged();
  const block = hookBlock(data);
  const env = outside({ HOME: home });
  const line = '. "$(dirname "$0")/_/husky.sh"\n';
  // A plain tracked directory that holds a file of that name: the line reads like husky's and ends the hook.
  const plain = ownHook(`#!/bin/sh\n${line}${block}`, { ".githooks/_/husky.sh": "exit 0\n" });
  assert.deepEqual(await hookKeys(plain, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(plain, "feat: x", TOKEN, env).status, 0, "the oracle: the tracked file ended the hook");
  // The name proves nothing: the same in a directory called .husky.
  const named = doctorRepo();
  mkdirSync(join(named, ".husky", "_"), { recursive: true });
  writeFileSync(join(named, ".husky", "commit-msg"), `#!/usr/bin/env sh\n${line}${block}`, { mode: 0o755 });
  writeFileSync(join(named, ".husky", "_", "husky.sh"), "exit 0\n");
  git(["config", "core.hooksPath", ".husky"], { cwd: named });
  git(["add", "-A"], { cwd: named });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: named });
  assert.deepEqual(await hookKeys(named, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(named, "feat: x", TOKEN, env).status, 0, "the oracle: the tracked file ended the hook");
  // Above the line it holds, there and in the git directory, which no clone gets.
  git(["reset", "-q", "--hard", "HEAD~1"], { cwd: plain });
  writeFileSync(join(plain, ".githooks", "commit-msg"), `#!/bin/sh\n${block}${line}`);
  assert.deepEqual(await hookKeys(plain, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(plain, "feat: x", TOKEN, env).status, 1);
  const inside = doctorRepo();
  mkdirSync(join(inside, ".git", "own", "_"), { recursive: true });
  writeFileSync(join(inside, ".git", "own", "_", "husky.sh"), HUSKY8_SH);
  writeFileSync(join(inside, ".git", "own", "commit-msg"), `#!/bin/sh\n${block}${line}`, { mode: 0o755 });
  git(["config", "core.hooksPath", ".git/own"], { cwd: inside });
  assert.deepEqual(await hookKeys(inside, { HOME: home }), ["doctor.hookOk"]);
});

test("doctor says what the commit does, the block's reading in the block's order: for each state, its line and a real commit", async () => {
  const { home, data } = plugged();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-plugin-")));
  const dir = ownHook(`#!/bin/sh\n${hookBlock(data)}`);
  // What a case leaves in the tree stays out of its commits, so a reset takes none of it.
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "exclude"), ".tools\n.pd\n.x\na\nlink\n");
  const env = outside({ HOME: home });
  /** @param {Record<string, string>} vars @param {string} key @param {number} status @param {RegExp} says */
  const both = async (vars, key, status, says) => {
    const what = `${key}, ${JSON.stringify(vars)}`;
    assert.deepEqual(await hookKeys(dir, { HOME: home, ...vars }), [key], what);
    const r = commitIn(dir, "feat: x", { "n.txt": String(Math.random()) }, { ...env, ...vars });
    assert.equal(r.status, status, `${what}: ${r.stderr}`);
    assert.match(r.stderr, says, what);
    if (status === 0) git(["reset", "-q", "--hard", "HEAD~1"], { cwd: dir });
  };
  // Node only in the tree: dropped by the filter, so every commit goes through, whatever else is wrong.
  const tools = join(dir, ".tools", "bin");
  mkdirSync(tools, { recursive: true });
  symlinkSync(process.execPath, join(tools, "node"));
  const inTree = { PATH: `${tools}:${join(base, "empty")}` };
  await both(inTree, "doctor.hookBlockNoNode", 0, /node not found/);
  await both({ ...inTree, ENNYN_PLUGIN_DATA: "relative" }, "doctor.hookBlockNoNode", 0, /node not found/);
  await both({ PATH: "" }, "doctor.hookBlockNoNode", 0, /node not found/);
  await both({ PATH: "relative/dir" }, "doctor.hookBlockNoNode", 0, /node not found/);
  // A node beside it, outside the tree: it runs, and doctor is content; a directory named node is no node.
  const outsideBin = join(base, "bin");
  mkdirSync(join(outsideBin, "node"), { recursive: true });
  await both({ PATH: outsideBin }, "doctor.hookBlockNoNode", 0, /node not found/);
  await both({ PATH: `${tools}:${dirname(process.execPath)}:${SYSTEM}` }, "doctor.hookOk", 0, /^$/);
  // A relative entry holding one is dropped wherever it lies: the commit runs at the top, and doctor anywhere.
  const relativeBin = join(base, "relative-bin");
  mkdirSync(relativeBin);
  symlinkSync(process.execPath, join(relativeBin, "node"));
  await both({ PATH: relative(process.cwd(), relativeBin) }, "doctor.hookBlockNoNode", 0, /node not found/);
  // install-hook says the same; its own git is found through a directory that holds no node.
  const gitOnly = join(base, "git-only");
  mkdirSync(gitOnly);
  writeFileSync(join(gitOnly, "git"), `#!/bin/sh\nexec ${JSON.stringify(GIT)} "$@"\n`, { mode: 0o755 });
  const cli = installCli(dir, outside({ HOME: home, PATH: `${tools}:${gitOnly}` }));
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /no node is left on PATH, so every commit goes through unchecked/);
  rmSync(tools, { recursive: true });
  // A data directory in the tree: refused when it is there, and when it is not there nothing is recorded.
  await both({ ENNYN_PLUGIN_DATA: join(dir, "absent") }, "doctor.hookBlockUnrecorded", 0, /no plugin version is recorded/);
  // No record, in a session whose version is installed beside the data directory: that version checks the commit.
  const sessionRoot = join(base, "plugins", "cache", "x", "ennyn", "1");
  mkdirSync(join(sessionRoot, "scripts"), { recursive: true });
  writeFileSync(join(sessionRoot, "scripts", "ennyn.mjs"), 'process.stderr.write("ran session\\n");\nprocess.exit(1);\n');
  await both({ ENNYN_PLUGIN_DATA: join(base, "plugins", "data", "ennyn-x"), ENNYN_PLUGIN_ROOT: sessionRoot }, "doctor.hookPluginSession", 1, /ran session/);
  const written = installCli(dir, outside({ HOME: home, ENNYN_PLUGIN_DATA: join(base, "plugins", "data", "ennyn-x"), ENNYN_PLUGIN_ROOT: sessionRoot }));
  assert.deepEqual([written.status, /it now names the version this session runs/.test(written.stdout), readFileSync(join(base, "plugins", "data", "ennyn-x", "root"), "utf8")], [0, true, `${sessionRoot}\n`], written.stdout + written.stderr);
  mkdirSync(join(dir, ".pd"));
  await both({ ENNYN_PLUGIN_DATA: join(dir, ".pd") }, "doctor.hookBlockNoData", 1, /inside this work tree/);
  // Spelled through a link and "..": where the kernel lands, not where the text does.
  mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
  symlinkSync(join("a", "b", "c"), join(dir, "link"));
  await both({ ENNYN_PLUGIN_DATA: `${dir}/link/../..` }, "doctor.hookBlockNoData", 1, /inside this work tree/);
  // The same spelling outside the tree: the record the kernel finds is the one read.
  hookModule.recordPluginRoot(join(base, "deep"), SELF);
  mkdirSync(join(base, "deep", "x", "y"), { recursive: true });
  symlinkSync(join("deep", "x", "y"), join(base, "out"));
  await both({ ENNYN_PLUGIN_DATA: `${base}/out/../..` }, "doctor.hookOk", 0, /^$/);
  hookModule.recordPluginRoot(join(base, "deep", "plugins", "data", "ennyn-test"), SELF);
  await both({ CLAUDE_CONFIG_DIR: `${base}/out/../..` }, "doctor.hookOk", 0, /^$/);
  // Another spelling of the tree, on a volume that folds case: found as what it is, and no such directory elsewhere.
  if (existsSync(dir.toUpperCase())) await both({ ENNYN_PLUGIN_DATA: join(dir.toUpperCase(), ".pd") }, "doctor.hookBlockNoData", 1, /inside this work tree/);
  rmSync(join(dir, ".pd"), { recursive: true });
  // A directory the block cannot enter: refused, and doctor says so.
  if (!asRoot) {
    const locked = join(base, "locked");
    hookModule.recordPluginRoot(locked, SELF);
    chmodSync(locked, 0);
    await both({ ENNYN_PLUGIN_DATA: locked }, "doctor.hookBlockNoData", 1, /cannot be read/);
    chmodSync(locked, 0o755);
  }
  // The record names the tree, however: its CLI there, a replaced version there, the CLI a link, its directory a link.
  const at = join(data, "root");
  const record = (/** @type {string} */ root) => writeFileSync(at, `${root}\n`);
  mkdirSync(join(dir, ".x", "scripts"), { recursive: true });
  writeFileSync(join(dir, ".x", "scripts", "ennyn.mjs"), PLANTED_CLI);
  record(join(dir, ".x"));
  await both({}, "doctor.hookBlockStale", 1, /inside this work tree/);
  writeFileSync(join(dir, ".x", ".orphaned_at"), "1\n");
  await both({}, "doctor.hookBlockStale", 1, /inside this work tree/);
  rmSync(join(dir, ".x", ".orphaned_at"));
  const version = join(base, "version");
  mkdirSync(join(version, "scripts"), { recursive: true });
  symlinkSync(join(dir, ".x", "scripts", "ennyn.mjs"), join(version, "scripts", "ennyn.mjs"));
  record(version);
  await both({}, "doctor.hookBlockStale", 1, /its CLI is a link/);
  rmSync(join(version, "scripts", "ennyn.mjs"));
  writeFileSync(join(base, "real.mjs"), PLANTED_CLI);
  symlinkSync(join(base, "real.mjs"), join(version, "scripts", "ennyn.mjs"));
  await both({}, "doctor.hookBlockStale", 1, /its CLI is a link/);
  rmSync(join(version, "scripts"), { recursive: true });
  symlinkSync(join(dir, ".x", "scripts"), join(version, "scripts"));
  await both({}, "doctor.hookBlockStale", 1, /inside this work tree/);
  rmSync(join(dir, ".x"), { recursive: true });
  // A replaced version outside the tree still runs, with that version's checks.
  const old = pluginVersion(base, "0.9.0");
  writeFileSync(join(old, ".orphaned_at"), "1\n");
  record(old);
  await both({}, "doctor.hookOk", 1, /ran 0\.9\.0/);
});

test("hook in a linked worktree of any layout: a tracked hooks directory of a --separate-git-dir repository or a submodule is the repository's, not a global directory", async () => {
  const { home, data } = plugged();
  const block = hookBlock(data);
  /** @param {string} dir @param {string} name */
  const worktree = (dir, name) => {
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "en-hook-wt-"))), name);
    git(["worktree", "add", "-q", "-b", name, wt], { cwd: dir });
    return wt;
  };
  /** The hooks directory made absolute, as an agent worktree's setup does, seen from a worktree of `dir`. @param {string} dir @param {string} name */
  const seen = async (dir, name) => {
    git(["config", "core.hooksPath", join(dir, ".githooks")], { cwd: dir });
    const wt = worktree(dir, name);
    assert.deepEqual([hookStatus(wt).hooksKind, hookStatus(wt).state], ["repo", "wired"], name);
    assert.deepEqual(await hookKeys(wt, { HOME: home }), ["doctor.hookOk"], name);
    // Nothing wired yet: the block for the tracked file, never a home path as a line to add to it.
    rmSync(join(dir, ".githooks", "commit-msg"));
    writeFileSync(join(dir, ".githooks", "x"), "x\n");
    const printed = installCli(wt, sessionEnv(data, SELF));
    assert.equal(printed.status, 1, printed.stdout);
    assert.match(printed.stdout, /Paste the block below at the top of /, name);
    assert.ok(!printed.stdout.includes(home), printed.stdout);
    assert.ok(printed.stdout.endsWith(block), printed.stdout);
    // A hooks directory not made yet is found through what is there.
    git(["config", "core.hooksPath", join(dir, ".githooks", "not", "yet")], { cwd: dir });
    assert.equal(hookStatus(wt).hooksKind, "repo", name);
  };
  // --separate-git-dir: the git directory is elsewhere, and git's own list names it as the main checkout.
  const separate = trackedHooks(block);
  git(["init", "-q", "--separate-git-dir", join(realpathSync(mkdtempSync(join(tmpdir(), "en-hook-sep-"))), "sep.git")], { cwd: separate });
  await seen(separate, "separate");
  // A submodule: its git directory is its superproject's .git/modules/mod.
  const source = trackedHooks(block);
  const superproject = doctorRepo();
  git(["add", "-A"], { cwd: superproject });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: superproject });
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod"], { cwd: superproject });
  await seen(join(superproject, "mod"), "module");
  // A tracked directory of another repository is no directory of this one, from a linked worktree or not.
  const other = trackedHooks(block);
  const dir = doctorRepo();
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  git(["config", "core.hooksPath", join(other, ".githooks")], { cwd: dir });
  assert.equal(hookStatus(dir).hooksKind, "global");
  assert.equal(hookStatus(worktree(dir, "other")).hooksKind, "global");
  // A file at the hooks path's place, and a directory in the git directory of a bare repository: no work tree holds them.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-hook-bare-")));
  writeFileSync(join(base, "a-file"), "x\n");
  git(["config", "core.hooksPath", join(base, "a-file")], { cwd: dir });
  assert.equal(hookStatus(dir).hooksKind, "global");
  git(["clone", "-q", "--bare", dir, join(base, "x.git")], { cwd: base });
  git([`--git-dir=${join(base, "x.git")}`, "worktree", "add", "-q", join(base, "wt")], { cwd: base });
  mkdirSync(join(base, "x.git", "own"));
  git(["config", "core.hooksPath", join(base, "x.git", "own")], { cwd: join(base, "wt") });
  assert.equal(hookStatus(join(base, "wt")).hooksKind, "global");
});

test("the line install-hook advises keeps the check's verdict: first in a hook that goes on, real git refuses what the check refuses, in both its forms", async () => {
  const { home, data } = plugged();
  const env = outside({ HOME: home });
  const rest = 'IFS= read -r s < "$1"\ncase $s in\n  Revert*) exit 0 ;;\nesac\necho theirs\n';
  for (const pluginData of [null, data]) {
    const dir = repo();
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
    const hook = join(dir, ".git", "hooks", "commit-msg");
    writeFileSync(hook, `#!/bin/sh\n${rest}`, { mode: 0o755 });
    const res = installHook({ cwd: dir, cliPath: CLI, pluginData });
    assert.equal(res.result, "other");
    writeFileSync(hook, `#!/bin/sh\n${res.line}\n${rest}`);
    assert.notEqual(printedCheck(readFileSync(hook, "utf8")), null, res.line);
    assert.equal(commitIn(dir, 'Revert "x"', TOKEN, env).status, 1, res.line);
    assert.equal(commitIn(dir, "untyped subject", { "n.txt": "1" }, env).status, 1, res.line);
    assert.equal(commitIn(dir, "feat: typed", { "n.txt": "2" }, env).status, 0, res.line);
    // The oracle: the same line with no status check loses the verdict, and it is not what install-hook printed.
    writeFileSync(hook, `#!/bin/sh\n${res.line.replace(" || exit $?", "")}\n${rest}`);
    assert.equal(hookStatus(dir).unread, hook, res.line);
    assert.equal(commitIn(dir, 'Revert "x"', TOKEN, env).status, 0, res.line);
  }
});

test("the marker alone counts only where Ennyn writes: a tracked hook or husky's that holds it and exit 0 is no ✓, and real git lands the secret; the local file keeps its reading", async () => {
  const { home } = plugged();
  const env = outside({ HOME: home });
  const text = `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`;
  const tracked = ownHook(text);
  assert.equal(hookStatus(tracked).state, "other");
  assert.deepEqual(await hookKeys(tracked, { HOME: home }), ["doctor.hookPath"]);
  assert.equal(commitIn(tracked, "feat: x", TOKEN, env).status, 0, "the oracle: the hook ran nothing");
  // Ennyn's own script, copied into the tracked directory: any other text that names the check.
  const copy = ownHook(hookScript(CLI));
  assert.deepEqual(await hookKeys(copy, { HOME: home }), ["doctor.hookUnread"]);
  // husky: the marker in the file git runs, or in the file its stub runs.
  const husky = doctorRepo();
  mkdirSync(join(husky, ".husky", "_"), { recursive: true });
  writeFileSync(join(husky, ".husky", "_", "commit-msg"), text, { mode: 0o755 });
  git(["config", "core.hooksPath", ".husky/_"], { cwd: husky });
  assert.equal(hookStatus(husky).state, "other");
  assert.deepEqual(await hookKeys(husky, { HOME: home }), ["doctor.hookPath"]);
  // The local file: only a write on this machine puts it there, and such a write can do anything.
  const local = doctorRepo();
  writeFileSync(join(local, ".git", "hooks", "commit-msg"), text, { mode: 0o755 });
  assert.equal(hookStatus(local).state, "ennyn");
  assert.deepEqual(await hookKeys(local, { HOME: home }), ["doctor.hookOk"]);
  // A hooks directory outside the repository holds what this machine put there, the same way.
  const global = realpathSync(mkdtempSync(join(tmpdir(), "en-global-hooks-")));
  writeFileSync(join(global, "commit-msg"), hookScript(CLI), { mode: 0o755 });
  const outsider = doctorRepo();
  git(["config", "core.hooksPath", global], { cwd: outsider });
  assert.deepEqual([hookStatus(outsider).hooksKind, hookStatus(outsider).state], ["global", "ennyn"]);
});

test("husky's stubs count only while the index holds none: a tracked stub or runner that exits is no ✓ beside the block, and real git lands the secret; what husky generates stays ✓", async () => {
  const { home, data } = plugged();
  const block = hookBlock(data);
  const env = outside({ HOME: home });
  /** husky 9.1.7's directory as it generates it, git ignoring all of it, with the block in the project's file. */
  const husky = () => {
    const dir = doctorRepo();
    mkdirSync(join(dir, ".husky", "_"), { recursive: true });
    writeFileSync(join(dir, ".husky", "commit-msg"), block);
    writeFileSync(join(dir, ".husky", "_", ".gitignore"), "*");
    writeFileSync(join(dir, ".husky", "_", "h"), HUSKY_RUNNER);
    writeFileSync(join(dir, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
    git(["config", "core.hooksPath", ".husky/_"], { cwd: dir });
    return dir;
  };
  /** @param {string} dir @param {string[]} [force] paths to add past husky's own ignore file */
  const start = (dir, force = []) => {
    git(["add", "-A"], { cwd: dir });
    if (force.length) git(["add", "-f", "--", ...force], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  };
  const made = husky();
  start(made);
  assert.deepEqual(await hookKeys(made, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(made, "feat: x", TOKEN, env).status, 1, "the stub ran the block");
  for (const file of ["commit-msg", "h"]) {
    const dir = husky();
    writeFileSync(join(dir, ".husky", "_", file), "#!/bin/sh\nexit 0\n");
    start(dir, [`.husky/_/${file}`]);
    const st = hookStatus(dir);
    assert.deepEqual([st.late, idleReason(st)], [st.path, "late"], file);
    assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookLate"], file);
    const r = installCli(dir, sessionEnv(data, SELF));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /may skip commit-check.*Nothing was written/);
    assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 0, `the oracle, ${file}: the tracked file ended the hook`);
  }
  // Any spelling, and the directory itself: a name another case folds to, a link the repository holds, a submodule.
  const folded = husky();
  writeFileSync(join(folded, ".husky", "_", "Hx"), "x\n");
  start(folded, [".husky/_/Hx"]);
  assert.deepEqual(await hookKeys(folded, { HOME: home }), ["doctor.hookLate"]);
  const linked = husky();
  rmSync(join(linked, ".husky", "_"), { recursive: true });
  mkdirSync(join(linked, "stubs"));
  writeFileSync(join(linked, "stubs", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  symlinkSync(join("..", "stubs"), join(linked, ".husky", "_"));
  start(linked);
  assert.deepEqual(await hookKeys(linked, { HOME: home }), ["doctor.hookLate"]);
  assert.equal(commitIn(linked, "feat: x", TOKEN, env).status, 0, "the oracle: the link's file ended the hook");
  // The link alone: what it points at is ignored, and a commit still chose it.
  const pointing = husky();
  rmSync(join(pointing, ".husky", "_"), { recursive: true });
  mkdirSync(join(pointing, "stubs"));
  writeFileSync(join(pointing, "stubs", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
  writeFileSync(join(pointing, ".gitignore"), "stubs\n");
  symlinkSync(join("..", "stubs"), join(pointing, ".husky", "_"));
  start(pointing);
  assert.deepEqual(await hookKeys(pointing, { HOME: home }), ["doctor.hookLate"]);
  const module_ = husky();
  start(module_);
  const head = git(["rev-parse", "HEAD"], { cwd: module_ }).trim();
  git(["update-index", "--add", "--cacheinfo", `160000,${head},.husky/_`], { cwd: module_ });
  assert.deepEqual(await hookKeys(module_, { HOME: home }), ["doctor.hookLate"]);
});

test("an empty core.hooksPath runs no hook, whatever lies at the top of the work tree or in .git/hooks: doctor says none, and install-hook writes nothing and says why", async () => {
  const { home } = plugged();
  const env = outside({ HOME: home });
  const dir = doctorRepo();
  const stray = `#!/bin/sh\n${hookModule.hookLine(CLI)}\n`;
  writeFileSync(join(dir, "commit-msg"), stray, { mode: 0o755 });
  writeFileSync(join(dir, ".git", "hooks", "commit-msg"), stray, { mode: 0o755 });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
  git(["config", "core.hooksPath", ""], { cwd: dir });
  const st = hookStatus(dir);
  assert.deepEqual([st.state, st.there, st.runs, st.hooksKind], ["none", false, false, null]);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookMissing"]);
  assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 0, "the oracle: neither file ran");
  const before = git(["status", "--porcelain"], { cwd: dir });
  const r = installCli(dir, outside({ HOME: home }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /core\.hooksPath is set but empty.*Nothing was written/);
  assert.equal(git(["status", "--porcelain"], { cwd: dir }), before, "no stray file at the top of the work tree");
  assert.equal(readFileSync(join(dir, ".git", "hooks", "commit-msg"), "utf8"), stray);
});

test("a line that ends in CR is not the printed line: doctor warns, and a bare call there lands a secret, the shell handing --hook a path with the CR in it", async () => {
  const { home } = plugged();
  const env = outside({ HOME: home });
  const line = hookModule.hookLine(CLI);
  for (const text of [`${line}\r\n`, `#!/bin/sh\n${line}\r\n`, `#!/bin/sh\r\n${line}\r\n`, `#!/bin/sh\n# ours\r\n${line}\n`, `#!/bin/sh\n${line} \n`, `#!/bin/sh\n ${line}\n`]) {
    assert.deepEqual(await hookKeys(ownHook(text), { HOME: home }), ["doctor.hookUnread"], JSON.stringify(text));
  }
  const bare = ownHook(`#!/bin/sh\n${line.replace(" || exit $?", "")}\r\n`);
  assert.deepEqual(await hookKeys(bare, { HOME: home }), ["doctor.hookUnread"]);
  assert.equal(commitIn(bare, "feat: x", TOKEN, env).status, 0, "the oracle: the check could not read its argument");
  // The same line with LF line ends, for both its forms.
  assert.deepEqual(await hookKeys(ownHook(`#!/bin/sh\n${line}\n`), { HOME: home }), ["doctor.hookOk"]);
  assert.deepEqual(await hookKeys(ownHook(`${hookModule.hookLine(CLI, join(home, ".claude", "plugins", "data", "ennyn-test"))}\n`), { HOME: home }), ["doctor.hookOk"]);
});

test("the block goes above husky's own line: there doctor says ✓, the check runs twice under husky 8.0.3 and once under 9.1.7, and real git refuses; below the line it warns", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "en-home-")));
  const root = join(home, "version");
  const ran = join(home, "ran");
  mkdirSync(join(root, "scripts"), { recursive: true });
  // A CLI that counts its runs and stops at one that names a token: what the real check does, and how often.
  writeFileSync(join(root, "scripts", "ennyn.mjs"), `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(ran)}, "x");\nprocess.exit(readFileSync(".git/index").includes("token.js") ? 1 : 0);\n`);
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  hookModule.recordPluginRoot(data, root);
  const block = hookBlock(data);
  const env = outside({ HOME: home });
  /** @param {string} generated the files husky writes in .husky/_ @param {Record<string, string>} files @param {string} hooksPath @param {string} text .husky/commit-msg */
  const husky = (files, hooksPath, text) => {
    const dir = doctorRepo();
    mkdirSync(join(dir, ".husky", "_"), { recursive: true });
    writeFileSync(join(dir, ".husky", "_", ".gitignore"), "*");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, ".husky", "_", name), body, { mode: 0o755 });
    writeFileSync(join(dir, ".husky", "commit-msg"), text, { mode: 0o755 });
    git(["config", "core.hooksPath", hooksPath], { cwd: dir });
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
    return dir;
  };
  const source = '. "$(dirname -- "$0")/_/husky.sh"\n';
  const eight = { "husky.sh": HUSKY8_SH };
  // husky 9.1.7's index.js writes this _/husky.sh for a project that kept the two old lines.
  const nine = { "husky.sh": 'echo "husky - DEPRECATED"', h: HUSKY_RUNNER, "commit-msg": HUSKY_STUB };
  for (const [name, files, hooksPath, times] of /** @type {[string, Record<string, string>, string, number][]} */ ([["8.0.3", eight, ".husky", 2], ["9.1.7", nine, ".husky/_", 1]])) {
    const above = husky(files, hooksPath, `#!/usr/bin/env sh\n${block}${source}\necho project\n`);
    assert.deepEqual(await hookKeys(above, { HOME: home }), ["doctor.hookOk"], name);
    rmSync(ran, { force: true });
    assert.equal(commitIn(above, "feat: clean", { "n.txt": "1" }, env).status, 0, name);
    assert.equal(readFileSync(ran, "utf8").length, times, `${name}: runs of the check`);
    assert.equal(commitIn(above, "feat: x", { "token.js": "x\n" }, env).status, 1, name);
    const below = husky(files, hooksPath, `#!/usr/bin/env sh\n${source}${block}`);
    assert.deepEqual(await hookKeys(below, { HOME: home }), ["doctor.hookUnread"], name);
    assert.equal(hookStatus(below).unread, join(below, ".husky", "commit-msg"), name);
    const r = installCli(below, outside({ HOME: home }), "--plugin-data", data);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /names commit-check.*above husky's own line/, name);
    assert.ok(r.stdout.endsWith(block), r.stdout);
  }
});

test("the printed line counts only where the repository cannot choose what it runs: a path in the work tree, or husky's PATH, is no ✓, and a real commit lands the secret behind each", async () => {
  const { home } = plugged();
  const env = outside({ HOME: home });
  const lax = { "tools/scripts/ennyn.mjs": "process.exit(0);\n" };
  const line = (/** @type {string} */ dir) => `#!/bin/sh\n${printedLine(join(realpathSync(dir), "tools", "scripts", "ennyn.mjs"))}\n`;
  const empty = ownHook("", lax);
  writeFileSync(join(empty, ".githooks", "commit-msg"), line(empty));
  const st = hookStatus(empty);
  assert.deepEqual([st.unread, st.late, st.block, idleReason(st)], [join(empty, ".githooks", "commit-msg"), null, null, "unread"]);
  assert.deepEqual(await hookKeys(empty, { HOME: home }), ["doctor.hookUnread"]);
  const r = installCli(empty, outside({ HOME: home }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /names commit-check.*Nothing was written/);
  assert.doesNotMatch(r.stdout, /already runs/);
  assert.equal(commitIn(empty, "feat: x", TOKEN, env).status, 0, "the oracle: the repository's file answered");
  // The record's form: a record in the work tree names a version in it.
  const record = ownHook("", { ...lax, "data/root": "x\n" });
  writeFileSync(join(record, "data", "root"), `${join(realpathSync(record), "tools")}\n`);
  writeFileSync(join(record, ".githooks", "commit-msg"), `#!/bin/sh\n${printedLine("", join(realpathSync(record), "data"))}\n`);
  assert.deepEqual(await hookKeys(record, { HOME: home }), ["doctor.hookUnread"]);
  // Seen from a linked worktree, whose top is another directory: the main checkout is still the repository's.
  const main = ownHook("", lax);
  writeFileSync(join(main, ".githooks", "commit-msg"), line(main));
  git(["add", "-A"], { cwd: main });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: line"], { cwd: main });
  git(["config", "core.hooksPath", join(main, ".githooks")], { cwd: main });
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "en-hook-wt-"))), "wt");
  git(["worktree", "add", "-q", "-b", "agent", wt], { cwd: main });
  assert.deepEqual(await hookKeys(wt, { HOME: home }), ["doctor.hookUnread"]);
  // A path elsewhere, in another repository or in none, is this machine's.
  const elsewhere = ownHook(`#!/bin/sh\n${printedLine(CLI)}\n`);
  assert.deepEqual([hookStatus(elsewhere).block, hookStatus(elsewhere).unread], [null, null]);
  assert.deepEqual(await hookKeys(elsewhere, { HOME: home }), ["doctor.hookOk"]);
  // husky 9.1.7's runner puts node_modules/.bin first: a package's bin named node answers, and the block filters it.
  /** @param {string} text */
  const husky = (text) => {
    const dir = doctorRepo();
    mkdirSync(join(dir, ".husky", "_"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "node"), PLANTED, { mode: 0o755 });
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, ".husky", "_", ".gitignore"), "*");
    writeFileSync(join(dir, ".husky", "_", "h"), HUSKY_RUNNER);
    writeFileSync(join(dir, ".husky", "_", "commit-msg"), HUSKY_STUB, { mode: 0o755 });
    writeFileSync(join(dir, ".husky", "commit-msg"), text);
    git(["config", "core.hooksPath", ".husky/_"], { cwd: dir });
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: base"], { cwd: dir });
    return dir;
  };
  const data = join(home, ".claude", "plugins", "data", "ennyn-test");
  for (const text of [`${printedLine(CLI)}\n`, `${printedLine(CLI, data)}\n`]) {
    const dir = husky(text);
    assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"], text);
    assert.equal(commitIn(dir, "feat: x", TOKEN, env).status, 0, `the oracle, ${text}: the package's node answered`);
  }
  const block = husky(hookBlock(data));
  assert.deepEqual(await hookKeys(block, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(commitIn(block, "feat: x", TOKEN, env).status, 1, "the block filters PATH");
});

test("a hand-written call in the local hook, with no plugin in sight: install-hook prints the line, and the advice followed ends in ✓", async () => {
  const { home } = plugged();
  const dir = doctorRepo();
  const hook = join(dir, ".git", "hooks", "commit-msg");
  writeFileSync(hook, '#!/bin/sh\nnode x/scripts/ennyn.mjs commit-check "$1"\n', { mode: 0o755 });
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookUnread"]);
  const r = installCli(dir, outside({ HOME: home }));
  assert.equal(r.status, 1, r.stdout);
  const advice = /first and as it stands here: (.+)$/m.exec(r.stdout)?.[1];
  assert.equal(advice, printedLine(CLI), r.stdout);
  writeFileSync(hook, `#!/bin/sh\n${advice}\n`);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"]);
  assert.equal(installCli(dir, outside({ HOME: home })).status, 0);
  // A copy in the work tree: this machine chose the path, as for Ennyn's own hook there.
  writeFileSync(hook, `#!/bin/sh\n${printedLine(join(realpathSync(dir), "tools", "scripts", "ennyn.mjs"))}\n`);
  assert.deepEqual(await hookKeys(dir, { HOME: home }), ["doctor.hookOk"]);
});

test("hook follows the plugin: with the record gone, a session of an installed version checks with it; an uninstalled one, another plugin's or one outside the cache lets the commit through", async () => {
  // Measured on Claude Code 2.1.310: an uninstall deletes the data directory and marks the version `.orphaned_at`; an
  // install at the same version reuses that directory and clears the mark; no install makes the record, a session does.
  const dir = repo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-plugin-")));
  const v = pluginVersion(base, "0.0.1");
  const data = join(base, "data", "ennyn-mkt");
  installHook({ cwd: dir, cliPath: cliOf(v), pluginData: data });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "--no-verify", "-m", "feat: base"], { cwd: dir });
  rmSync(data, { recursive: true });
  const session = sessionEnv(data, v);
  const checked = commitIn(dir, "feat: reinstalled", { "a.txt": String(Math.random()) }, outside(session));
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /ran 0\.0\.1/);
  assert.match(checked.stderr, /no plugin version is recorded in .*so this commit is checked with the version this Claude Code session runs/);
  const st = hookStatus(dir, session);
  assert.deepEqual([idleReason(st), st.cli, st.fromSession], [null, cliOf(v), true]);
  // A `tr` the repository holds, first on PATH, never runs: the hook folds a backslash by itself.
  const ran = join(base, "tr-ran");
  writeFileSync(join(dir, "tr"), `#!/bin/sh\ntouch ${JSON.stringify(ran)}\ncat\n`, { mode: 0o755 });
  const planted = commitIn(dir, "feat: planted", { "a.txt": String(Math.random()) }, outside({ ...session, PATH: `.:${dirname(process.execPath)}:/usr/bin:/bin` }));
  assert.deepEqual([planted.status, /ran 0\.0\.1/.test(planted.stderr), existsSync(ran)], [1, true, false], planted.stderr);
  rmSync(join(dir, "tr"), { force: true });
  assert.deepEqual(await hookKeys(dir, session), ["doctor.hookPluginSession"]);
  // Outside a session, or in another plugin's: through, saying so, as before.
  // A trailing newline is a byte of the path: no data directory and no version of this plugin.
  for (const env of [outside({}), outside(sessionEnv(join(base, "data", "other"), v)), outside({ ENNYN_PLUGIN_DATA: data }), outside(sessionEnv(`${data}\n`, v)), outside(sessionEnv(data, `${v}\n`))]) {
    const passed = commitIn(dir, "untyped", { "a.txt": String(Math.random()) }, env);
    assert.deepEqual([passed.status, /so the commit message is not checked/.test(passed.stderr)], [0, true], passed.stderr);
  }
  assert.deepEqual([idleReason(hookStatus(dir, {})), hookStatus(dir, {}).fromSession], ["unrecorded", false]);
  assert.equal(idleReason(hookStatus(dir, sessionEnv(join(base, "data", "other"), v))), "unrecorded");
  assert.deepEqual([sessionEnv(`${data}\n`, v), sessionEnv(data, `${v}\n`)].map((e) => idleReason(hookStatus(dir, e))), ["unrecorded", "unrecorded"]);
  // A root the session names that is no installed version of this plugin: through, never run.
  const elsewhere = pluginVersion(join(base, "x"), "0.0.1");
  // As text: join would take the ".." out.
  const dotted = `${base}/cache/../x/cache/mkt/ennyn/0.0.1`;
  const otherMarket = join(base, "cache", "other", "ennyn", "0.0.1");
  mkdirSync(join(otherMarket, "scripts"), { recursive: true });
  writeFileSync(join(otherMarket, "scripts", "ennyn.mjs"), "process.exit(1);\n");
  const shallow = join(base, "cache", "mkt", "0.0.1");
  mkdirSync(join(shallow, "scripts"), { recursive: true });
  writeFileSync(join(shallow, "scripts", "ennyn.mjs"), "process.exit(1);\n");
  // Where ennyn\.. and a trailing slash would land: a CLI there, so only the path's shape keeps it from running.
  for (const at of [join(base, "cache", "mkt"), join(base, "cache", "mkt", "ennyn")]) {
    mkdirSync(join(at, "scripts"), { recursive: true });
    writeFileSync(join(at, "scripts", "ennyn.mjs"), "process.exit(1);\n");
  }
  for (const root of [elsewhere, dotted, "cache/mkt/ennyn/0.0.1", join(base, "cache", "mkt", "ennyn", "none"), otherMarket, shallow, `${join(base, "cache", "mkt", "ennyn")}\\..`, `${join(base, "cache", "mkt", "ennyn")}/`]) {
    const passed = commitIn(dir, "untyped", { "a.txt": String(Math.random()) }, outside(sessionEnv(data, root)));
    assert.deepEqual([passed.status, /ran /.test(passed.stderr), /not checked/.test(passed.stderr)], [0, false, true], `${root}: ${passed.stderr}`);
    assert.equal(idleReason(hookStatus(dir, sessionEnv(data, root))), "unrecorded", root);
  }
  // The root spelled with backslashes, as plugin-root writes it on Windows: the same version.
  assert.equal(hookStatus(dir, sessionEnv(data, v.replace(/\//g, "\\"))).fromSession, true);
  // install-hook in the session writes the record again, so a commit outside it is checked too.
  // From another copy than the session's version install-hook is refused (followsRecord), and writes nothing.
  const again = installCli(dir, outside(session));
  assert.deepEqual([again.status, /now names/.test(again.stdout), existsSync(join(data, "root"))], [1, false, false], again.stdout);
  // Run as the session's version, it writes the record.
  assert.equal(withEnv(session, () => installHook({ cwd: dir, cliPath: cliOf(v), session: { data, root: v } })).result, "updated");
  assert.deepEqual([record(data), hookStatus(dir, {}).fromSession], [`${v}\n`, false]);
  assert.match(commitIn(dir, "feat: outside", { "a.txt": String(Math.random()) }, outside({})).stderr, /ran 0\.0\.1/);
  rmSync(data, { recursive: true });
  // Uninstalled: the version marked replaced. Never a lock on the user's commits.
  writeFileSync(join(v, ".orphaned_at"), "1\n");
  const gone = commitIn(dir, "untyped", { "a.txt": String(Math.random()) }, outside(session));
  assert.deepEqual([gone.status, /ran /.test(gone.stderr)], [0, false], gone.stderr);
  assert.deepEqual(await hookKeys(dir, session), ["doctor.hookPluginUnrecorded"]);
  // Installed again: install-hook from the session puts the record back.
  rmSync(join(v, ".orphaned_at"));
  assert.equal(installHook({ cwd: dir, cliPath: cliOf(v), pluginData: data }).result, "updated");
  assert.deepEqual([record(data), hookStatus(dir, session).fromSession], [`${v}\n`, false]);
});

/** `fn` with `vars` in this process's environment, put back after. @template T @param {Record<string, string>} vars @param {() => T} fn */
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("hook follows the plugin: install-hook writes the record from the session only on a run that goes through, and never a version folder linked out of the cache", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "en-plugin-")));
  const v = pluginVersion(base, "0.0.1");
  const data = join(base, "data", "ennyn-mkt");
  const session = sessionEnv(data, v);
  /** A repository whose Ennyn hook reads `at` (no record there), in its own hooks or under a global core.hooksPath. @param {string} at @param {string} [hooks] */
  const hooked = (at, hooks) => {
    const dir = repo();
    if (hooks) {
      mkdirSync(hooks, { recursive: true });
      git(["config", "core.hooksPath", hooks], { cwd: dir });
    }
    const path = hookStatus(dir).path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, hookScript("", at), { mode: 0o755 });
    return dir;
  };
  const dir = hooked(data);
  assert.equal(hookStatus(dir, session).fromSession, true);
  // Refused runs write nothing: another copy than the session's (followsRecord), a version Claude Code has replaced.
  assert.equal(withEnv(session, () => installHook({ cwd: dir, cliPath: CLI })).result, "followsRecord");
  const old = pluginVersion(join(base, "old"), "0.0.1");
  writeFileSync(join(old, ".orphaned_at"), "1\n");
  assert.equal(withEnv(session, () => installHook({ cwd: dir, cliPath: cliOf(old) })).result, "replacedCopy");
  assert.equal(existsSync(join(data, "root")), false);
  // A data directory in the work tree, with the session's version beside it there: refused, and nothing in the tree.
  const inner = repo();
  const innerData = join(realpathSync(inner), "plugins", "data", "ennyn-mkt");
  const innerVersion = join(realpathSync(inner), "plugins", "cache", "mkt", "ennyn", "0.0.1");
  mkdirSync(join(innerVersion, "scripts"), { recursive: true });
  writeFileSync(join(innerVersion, "scripts", "ennyn.mjs"), "process.exit(1);\n");
  const innerPath = hookStatus(inner).path;
  mkdirSync(dirname(innerPath), { recursive: true });
  writeFileSync(innerPath, hookScript("", innerData), { mode: 0o755 });
  const innerSession = sessionEnv(innerData, innerVersion);
  assert.equal(hookStatus(inner, innerSession).fromSession, true);
  assert.equal(withEnv(innerSession, () => installHook({ cwd: inner, cliPath: CLI, pluginData: innerData })).result, "dataInRepository");
  assert.equal(existsSync(join(innerData, "root")), false);
  // A run that records a version of its own (another copy, given the data directory) keeps it: the session does not write over it.
  const v2 = pluginVersion(base, "0.0.3");
  assert.deepEqual([withEnv(session, () => installHook({ cwd: dir, cliPath: cliOf(v2), pluginData: data })).restored, record(data)], [false, `${v2}\n`]);
  rmSync(join(data, "root"));
  // A run that goes through (Ennyn's script under a global core.hooksPath: wired) writes it.
  const global = hooked(data, join(base, "global-hooks"));
  const wired = withEnv(session, () => installHook({ cwd: global, cliPath: CLI }));
  assert.deepEqual([wired.result, wired.restored, record(data)], ["wired", true, `${v}\n`]);
  // The version folder a link out of the cache: the text is a version of this plugin, the folder is not; refused, unwritten.
  rmSync(join(data, "root"));
  const outsideVersion = join(base, "outside");
  mkdirSync(join(outsideVersion, "scripts"), { recursive: true });
  writeFileSync(join(outsideVersion, "scripts", "ennyn.mjs"), "process.exit(1);\n");
  const linked = join(base, "cache", "mkt", "ennyn", "0.0.2");
  symlinkSync(outsideVersion, linked);
  const linkSession = sessionEnv(data, linked);
  assert.equal(hookStatus(global, linkSession).fromSession, true);
  assert.throws(() => withEnv(linkSession, () => installHook({ cwd: global, cliPath: CLI })), (e) => e instanceof hookModule.RecordError && e.reason === "link");
  assert.equal(existsSync(join(data, "root")), false);
  // The cache itself through a link: the same folder once both are resolved, so it is written.
  const realCache = join(base, "real-cache");
  mkdirSync(join(realCache, "mkt", "ennyn", "0.0.1", "scripts"), { recursive: true });
  writeFileSync(join(realCache, "mkt", "ennyn", "0.0.1", "scripts", "ennyn.mjs"), "process.exit(1);\n");
  const linkedBase = join(base, "lb");
  mkdirSync(join(linkedBase, "data"), { recursive: true });
  symlinkSync(realCache, join(linkedBase, "cache"));
  const lbData = join(linkedBase, "data", "ennyn-mkt");
  const lbRoot = join(linkedBase, "cache", "mkt", "ennyn", "0.0.1");
  const lbGlobal = hooked(lbData, join(base, "lb-hooks"));
  assert.equal(withEnv(sessionEnv(lbData, lbRoot), () => installHook({ cwd: lbGlobal, cliPath: CLI })).restored, true);
  assert.equal(record(lbData), `${lbRoot}\n`);
});
