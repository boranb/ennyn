/**
 * The short suite leaves slow gates out of an author's run, so its own decisions are tested here: that every test
 * file is in it or named slow, what brings a slow file back, and that a read of what changed that fails runs
 * everything. The script runs for real in a copy with a fake suite. A real run is `npm run test:short`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { matchAny } from "../core/glob.mjs";
import { testNames } from "./declarations.mjs";
import { ACCOUNTING, READS, SLOW, choose, codeHash, decide, reasons, testFiles, whatChanged } from "./short.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDS = "test/guards.test.mjs";
const HOOK = "test/hook.test.mjs";
const FAULT = "test/fault-injection.test.mjs";

/** @param {string} dir @param {string} message */
function commit(dir, message) {
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], { cwd: dir });
}

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/**
 * A repository with `files` on main, on a new branch `work`.
 * @param {Record<string, string>} files
 */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "en-short-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, files);
  commit(dir, "start");
  git(["checkout", "-q", "-b", "work"], { cwd: dir });
  return dir;
}

const SUITE = { "test/a.test.mjs": "", [GUARDS]: "", [HOOK]: "", [FAULT]: "" };

/** What the shell makes of package.json's `test/*.test.mjs`, in `cwd`. @param {string} cwd */
const shell = (cwd) => execFileSync("sh", ["-c", 'for f in test/*.test.mjs; do printf "%s\\0" "$f"; done'], { cwd, encoding: "utf8" }).split("\0").filter(Boolean).sort();

/** The slow files a report says are left out. @param {string[]} says */
const leftOut = (says) => says.flatMap((l) => /^left out (\S+): /.exec(l)?.[1] ?? []);

test("short: every test file is in the short set or named slow, with no third state, and each named slow file exists", () => {
  const all = testFiles(ROOT);
  assert.deepEqual(all, shell(ROOT), "the list is the shell's, on this tree");
  assert.ok(all.includes("test/short.test.mjs"));
  assert.deepEqual(Object.keys(SLOW).sort(), [FAULT, GUARDS, HOOK].sort());
  for (const f of Object.keys(SLOW)) assert.ok(all.includes(f), `${f}: named slow, and not a test file`);

  // This tree's files, on a branch that changed nothing: each one runs or is said to be left out, once.
  const chosen = choose(all, { paths: [], added: [], base: "0".repeat(40), branch: "work" }, () => null);
  assert.deepEqual(leftOut(chosen.says).sort(), Object.keys(SLOW).sort());
  assert.deepEqual([...chosen.files, ...leftOut(chosen.says)].sort(), all);

  // Names the shell takes and leaves.
  const dir = repo({ ...SUITE, "test/new.test.mjs": "", "test/helper.mjs": "", "test/.hidden.test.mjs": "", "test/.test.mjs": "", "test/sub/deep.test.mjs": "", "test/line\nbreak.test.mjs": "" });
  assert.deepEqual(testFiles(dir), shell(dir));
  assert.ok(testFiles(dir).includes("test/line\nbreak.test.mjs"));
  const { files, says } = decide(dir);
  assert.deepEqual(leftOut(says).sort(), [FAULT, GUARDS, HOOK].sort());
  assert.deepEqual([...files, ...leftOut(says)].sort(), testFiles(dir));
});

test("short: a path that brings a slow file back matches a file at HEAD", () => {
  const atHead = git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: ROOT }).split("\0").filter(Boolean);
  assert.ok(atHead.length > 100, "HEAD's files are read");
  for (const [file, rules] of Object.entries(SLOW)) {
    assert.ok(rules.length, `${file}: nothing brings it back`);
    for (const { paths, why } of rules) {
      assert.ok(why && paths.length, `${file}: a rule with no reason or no paths`);
      for (const p of paths) assert.ok(atHead.some((f) => matchAny(f, [p])), `${file}: ${p} matches nothing at HEAD`);
    }
  }
  assert.ok(!atHead.some((f) => matchAny(f, ["nothing/at/all"])), "a path that names nothing matches nothing");
});

test("short: what the branch changed is read against the merge base: committed, staged, not staged, untracked, gone, moved, oddly named", () => {
  const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\nd\nd\nd\n", "back.txt": "b\n", "same.txt": "s\n", ".gitignore": "ignored.txt\n", "sub/.gitignore": "deep.txt\n" });
  put(dir, { "committed.txt": "new\n" });
  commit(dir, "on the branch");
  put(dir, { "a.txt": "changed\n", "staged.txt": "new\n" });
  git(["add", "a.txt", "staged.txt"], { cwd: dir });
  // Staged, with the tree put back: the commit would hold what the tree does not show.
  put(dir, { "back.txt": "staged\n" });
  git(["add", "back.txt"], { cwd: dir });
  put(dir, { "back.txt": "b\n" });
  put(dir, { "b.txt": "changed\n", "untracked.txt": "new\n", 'o"dd\tname.txt': "new\n", "ignored.txt": "new\n", "excluded.txt": "new\n", "sub/deep.txt": "new\n", "sub/kept.txt": "new\n" });
  rmSync(join(dir, "c.txt"));
  git(["mv", "d.txt", "moved.txt"], { cwd: dir });
  // The main branch moves on: what it took is not the branch's change.
  const other = join(mkdtempSync(join(tmpdir(), "en-short-main-")), "m");
  git(["worktree", "add", "-q", other, "main"], { cwd: dir });
  put(other, { "only-on-main.txt": "m\n" });
  commit(other, "main moves on");
  // Only the repository's own ignore files count: a machine's or a clone's can hide anything.
  const everything = join(mkdtempSync(join(tmpdir(), "en-short-ignore-")), "ignore");
  writeFileSync(everything, "*\n");
  git(["config", "core.excludesFile", everything], { cwd: dir });
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  appendFileSync(join(dir, ".git", "info", "exclude"), "excluded.txt\n");

  const got = whatChanged(dir);
  assert.ok(!("unread" in got), JSON.stringify(got));
  assert.deepEqual([...got.paths].sort(), ["a.txt", "b.txt", "back.txt", "c.txt", "committed.txt", "d.txt", "excluded.txt", "moved.txt", 'o"dd\tname.txt', "staged.txt", "sub/kept.txt", "untracked.txt"].sort());
  assert.deepEqual([...got.added].sort(), ["committed.txt", "excluded.txt", "moved.txt", 'o"dd\tname.txt', "staged.txt", "sub/kept.txt", "untracked.txt"].sort());
  assert.equal(got.branch, "work");
  assert.equal(got.base, git(["rev-parse", "main~1"], { cwd: dir }));

  // A branch that changed nothing has nothing to say, and that is an answer, not a failed read.
  const clean = repo({ "a.txt": "a\n" });
  assert.deepEqual({ ...whatChanged(clean), base: "" }, { paths: [], added: [], base: "", branch: "work" });
});

/** [what changed, paths, added, the slow files that come back] @type {[string, string[], string[], string[]][]} */
const CORPUS = [
  // Stays out: what none of the three reads, and the code the short set already covers.
  ["the graph and the handoff", [".ennyn/graph.json", ".ennyn/handoff.md", ".ennyn/metrics.jsonl"], [], []],
  ["documents", ["README.md", "README.tr.md", "DESIGN.md", "CHANGELOG.md", "docs/evidence.md"], [], []],
  ["the method", ["skills/cycle/SKILL.md", "skills/cycle/task-brief.md", "agents/security-reviewer.md"], [], []],
  ["catalogs", ["i18n/en.json", "i18n/tr.json"], [], []],
  ["a metric", ["metrics/convergence.mjs", "metrics/findings.mjs"], [], []],
  ["a check", ["checks/secrets.mjs", "checks/ci.mjs", "checks/deps.mjs"], [], []],
  ["a test that is no gate", ["test/budget.test.mjs", "test/setup.test.mjs"], [], []],
  ["a new helper", ["test/helper.mjs"], ["test/helper.mjs"], []],
  ["a new fixture", ["test/__fixtures__/a.test.mjs"], ["test/__fixtures__/a.test.mjs"], []],
  // Guards.
  ["the guard list", ["test/guards.mjs"], [], [GUARDS]],
  ["the guards test", [GUARDS], [], [GUARDS]],
  ["how a gate file is read", ["test/declarations.mjs"], [], [GUARDS]],
  ["the guards' runner", ["metrics/mutation.mjs"], [], [GUARDS]],
  ["a gate test", ["test/plugin.test.mjs"], [], [GUARDS]],
  ["this gate", ["test/short.test.mjs"], [], [GUARDS]],
  ["a new test file", ["test/new.test.mjs"], ["test/new.test.mjs"], [GUARDS]],
  // The hook.
  ["the hook's file", [HOOK], [], [HOOK]],
  ["the hook's installer", ["setup/hook.mjs"], [], [HOOK]],
  ["what the hook runs", ["checks/commit-shape.mjs"], [], [HOOK]],
  ["the hook's staged reads", ["core/git.mjs"], [], [HOOK, FAULT]],
  ["the commit-check and fold commands", ["scripts/ennyn.mjs"], [], [HOOK, FAULT]],
  ["what reports on the hook", ["setup/doctor.mjs"], [], [HOOK, FAULT]],
  ["the plugin record", ["adapters/claude-code/hooks/plugin-root.mjs"], [], [HOOK, FAULT]],
  // The fault matrix.
  ["the matrix", [FAULT], [], [FAULT, GUARDS]],
  ["its preload", ["test/fault-fs.mjs"], [], [FAULT]],
  ["file reads", ["core/files.mjs"], [], [FAULT]],
  ["the config", ["core/config.mjs"], [], [FAULT]],
  ["the hook list", ["hooks/hooks.json"], [], [FAULT]],
  ["a Claude Code hook", ["adapters/claude-code/hooks/side-copy-rules.mjs"], [], [FAULT]],
  // Every test file loads these.
  ["the hermetic setup", ["test/hermetic.mjs"], [], [GUARDS, HOOK, FAULT]],
  ["the hostile machine", ["test/hostile.mjs"], [], [GUARDS, HOOK, FAULT]],
];

test("short: a slow file comes back for its listed paths and for nothing else, with a reason that names the path", () => {
  const read = (/** @type {string} */ f) => readFileSync(join(ROOT, f), "utf8");
  for (const [what, paths, added, expected] of CORPUS) {
    const back = reasons({ paths, added }, read);
    assert.deepEqual([...back.keys()].sort(), Object.keys(SLOW).sort(), what);
    assert.deepEqual([...back].filter(([, says]) => says.length).map(([f]) => f).sort(), [...expected].sort(), what);
    for (const f of expected) for (const line of /** @type {string[]} */ (back.get(f))) assert.ok(paths.some((p) => line.startsWith(`${p}: `)) || /guard /.test(line), `${what}: ${line}`);
  }
});

test("short: each rule that matches says so, with the first path that matched it", () => {
  const back = reasons({ paths: ["docs/a.md", "core/git.mjs", "core/files.mjs", "core/config.mjs"], added: [] }, () => "");
  assert.deepEqual(back.get(FAULT), ["core/git.mjs: every git call and file read goes through them", "core/config.mjs: the code that most often changed with the matrix"]);
});

test("short: a guarded line brings the guards back; another line of the same file does not", () => {
  const gates = [{ test: "test/gate.test.mjs", guards: [{ id: "g1", why: "", file: "a.md", old: "the line\n", new: "x", pattern: "p" }] }];
  /** @param {string | null} text @param {string[]} [paths] */
  const says = (text, paths = ["a.md"]) => /** @type {string[]} */ (reasons({ paths, added: [] }, () => text, gates).get(GUARDS));
  assert.deepEqual(says("top\nthe line\nbottom changed\n"), [], "the guard still applies");
  assert.deepEqual(says("top\nanother line\n"), ["a.md: the line guard g1 applies to"], "the line is gone");
  assert.deepEqual(says("the line\nthe line\n"), ["a.md: the line guard g1 applies to"], "the line twice: the guard no longer changes one place");
  assert.deepEqual(says(null), ["a.md: the line guard g1 applies to"], "the file is gone");
  assert.deepEqual(says("another line\n", ["b.md"]), [], "a file the branch did not change is not read");
  assert.deepEqual(says("the line\n", ["test/gate.test.mjs"]), ["test/gate.test.mjs: a gate test, whose tests are decided and whose guards must still kill"]);
  assert.deepEqual(reasons({ paths: ["test/n.test.mjs"], added: [] }, () => "", gates).get(GUARDS), [], "a test file that is not new and no gate");
});

test("short: every failed read of what changed runs everything and says so", () => {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "en-short-bin-"));
  const count = join(bin, "count");
  // Fails the k-th call the way $HOW says, answers it with junk and exit 0, or answers it and every later one with nothing; the others run the real git.
  writeFileSync(join(bin, "git"), `#!/bin/sh\nn=$(cat "${count}")\nn=$((n + 1))\necho $n > "${count}"\nif [ "$HOW" = silent ] && [ "$n" -ge "$FAIL_AT" ]; then exit 0; fi\nif [ "$n" = "$FAIL_AT" ]; then\n  if [ "$HOW" = kill ]; then kill -9 $$; fi\n  if [ "$HOW" = junk ]; then echo junk; exit 0; fi\n  echo "fatal: failed on purpose" >&2\n  exit 128\nfi\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const dir = repo(SUITE);
  const env = (/** @type {number} */ at, /** @type {string} */ how) => ({ ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAIL_AT: String(at), HOW: how });
  writeFileSync(count, "0\n");
  assert.ok(!("unread" in whatChanged(dir, env(0, "exit"))), "no fault: a real answer");
  const calls = Number(readFileSync(count, "utf8"));
  assert.equal(calls, 6, "the top, HEAD, the merge base, two diffs, the untracked list");

  const all = testFiles(dir);
  for (const how of ["exit", "kill"]) {
    for (let at = 1; at <= calls; at++) {
      writeFileSync(count, "0\n");
      const { files, says } = decide(dir, env(at, how));
      assert.deepEqual(files, all, `call ${at} of ${calls} (${how}): everything runs`);
      assert.match(says[0], /^whole suite, 4 test files: git could not say what changed \(/, `call ${at} (${how})`);
      assert.equal(says.length, 1, "nothing is said to be left out");
    }
  }

  // The top, HEAD and the merge base have a shape; an empty diff with exit 0 cannot be told from a real answer.
  // From the tree itself, as npm starts it: node resolves an empty path to the working directory.
  const started = process.cwd();
  process.chdir(dir);
  try {
    for (const how of ["silent", "junk"]) {
      for (const at of [1, 2, 3]) {
        writeFileSync(count, "0\n");
        const { files, says } = decide(dir, env(at, how));
        assert.deepEqual(files, all, `call ${at} (${how}): everything runs`);
        assert.match(says[0], /^whole suite, 4 test files: /, `call ${at} (${how})`);
        assert.equal(says.length, 1, says.join("\n"));
      }
    }
  } finally {
    process.chdir(started);
  }

  const noGit = mkdtempSync(join(tmpdir(), "en-short-nogit-"));
  const missing = decide(dir, { ...process.env, PATH: noGit });
  assert.deepEqual(missing.files, all, "no git at all");
  assert.match(missing.says[0], /git could not say what changed/);
});

test("short: outside a repository, on the main branch, on no branch, with no main branch or no shared history it runs everything and says why", () => {
  /** @param {string} dir @param {RegExp} why */
  const everything = (dir, why) => {
    const { files, says, accounting } = decide(dir);
    assert.deepEqual(files, testFiles(dir));
    assert.equal(files.length, 4);
    assert.equal(accounting, false, "guards runs whole here, so nothing runs part of it again");
    assert.equal(says.length, 1, says.join("\n"));
    assert.match(says[0], /^whole suite, 4 test files: /);
    assert.match(says[0], why);
  };
  const outside = mkdtempSync(join(tmpdir(), "en-short-outside-"));
  put(outside, SUITE);
  everything(outside, /git could not say what changed/);

  const onMain = repo(SUITE);
  git(["checkout", "-q", "main"], { cwd: onMain });
  everything(onMain, /on main itself/);
  // A tag of the same name: git's short spelling of the branch is heads/main then.
  git(["tag", "main"], { cwd: onMain });
  everything(onMain, /on main itself/);

  const detached = repo(SUITE);
  git(["checkout", "-q", "--detach"], { cwd: detached });
  everything(detached, /HEAD is on no branch/);

  const noMain = repo(SUITE);
  git(["branch", "-q", "-D", "main"], { cwd: noMain });
  everything(noMain, /git could not say what changed/);

  const unrelated = repo(SUITE);
  git(["checkout", "-q", "--orphan", "other"], { cwd: unrelated });
  commit(unrelated, "no shared history");
  everything(unrelated, /git could not say what changed/);

  const unborn = mkdtempSync(join(tmpdir(), "en-short-unborn-"));
  git(["init", "-q", "-b", "work"], { cwd: unborn });
  put(unborn, SUITE);
  everything(unborn, /git could not say what changed/);
});

test("short: a tree that is not the repository's top runs everything and says so; a link to the top is the top", () => {
  const outer = repo({ "sub/test/a.test.mjs": "", "sub/test/hook.test.mjs": "" });
  put(outer, { "sub/setup/hook.mjs": "new\n" });
  const inner = join(outer, "sub");
  const below = decide(inner);
  assert.deepEqual(below.files, testFiles(inner));
  assert.equal(below.says.length, 1, below.says.join("\n"));
  assert.match(below.says[0], /^whole suite, 2 test files: the repository's top is .* not this tree/);

  const moved = repo(SUITE);
  git(["config", "core.worktree", mkdtempSync(join(tmpdir(), "en-short-worktree-"))], { cwd: moved });
  const elsewhere = decide(moved);
  assert.deepEqual(elsewhere.files, testFiles(moved));
  assert.match(elsewhere.says[0], /^whole suite, 4 test files: the repository's top is .* not this tree/);

  const link = join(mkdtempSync(join(tmpdir(), "en-short-top-")), "link");
  symlinkSync(repo(SUITE), link);
  assert.match(decide(link).says[0], /^short suite, /);
});

test("short: a guarded file that cannot be read runs everything and says so", () => {
  const dir = repo({ ...SUITE, "README.md": "text\n" });
  rmSync(join(dir, "README.md"));
  mkdirSync(join(dir, "README.md"));
  const { files, says } = decide(dir);
  assert.deepEqual(files, testFiles(dir));
  assert.match(says[0], /^whole suite, 4 test files: a guarded file could not be read \(/);
  assert.equal(says.length, 1);
});

test("short: what comes back is run and said with its reason, what stays out is said too", () => {
  const dir = repo({ ...SUITE, "core/config.mjs": "one\n" });
  put(dir, { "core/config.mjs": "two\n", "other.txt": "new\n" });
  const { files, says } = decide(dir);
  assert.deepEqual(files, ["test/a.test.mjs", FAULT]);
  assert.match(says[0], /^short suite, 2 of 4 test files \(changed on work since main at [0-9a-f]{7}: 2\)$/);
  assert.deepEqual(says.slice(1), [
    "read list: not used, core/config.mjs is code",
    `added ${FAULT}: core/config.mjs: the code that most often changed with the matrix`,
    `left out ${GUARDS}: none of its listed paths changed, and it runs at the closing; its accounting test runs now`,
    `left out ${HOOK}: none of its listed paths changed, and it runs at the closing`,
  ]);
});

/** A test file that passes when test/hermetic.mjs was loaded into it. @param {string} name */
const file = (name) => `import { test } from "node:test";\ntest(${JSON.stringify(name)}, () => { if (!globalThis.HERMETIC) throw new Error("no hermetic setup"); });\n`;

/** The script in a copy of what it needs, with a suite of its own. @param {Record<string, string>} tests */
function copy(tests) {
  const dir = repo({ "test/hermetic.mjs": "globalThis.HERMETIC = true;\n", [HOOK]: file("the slow file ran"), ...tests });
  cpSync(join(ROOT, "core"), join(dir, "core"), { recursive: true });
  copyFileSync(join(ROOT, "test", "short.mjs"), join(dir, "test", "short.mjs"));
  copyFileSync(join(ROOT, "test", "guards.mjs"), join(dir, "test", "guards.mjs"));
  commit(dir, "the script");
  git(["branch", "-q", "-f", "main", "work"], { cwd: dir });
  return dir;
}

/** @param {string} script @param {string} cwd @param {string[]} [args] @param {NodeJS.ProcessEnv} [more] */
function run(script, cwd, args = [], more = {}) {
  const env = { ...process.env, ...more };
  // Under `node --test` this says "report to a parent": the run inside would exit 0 whatever it found.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
}

test("short: the script runs what it chose, says so before and after the run, and exits as the run did", () => {
  const dir = copy({ "test/a.test.mjs": file("the fast file ran") });
  const script = join(dir, "test", "short.mjs");
  const left = `left out ${HOOK}: none of its listed paths changed, and it runs at the closing`;
  // From anywhere: the run starts at the top of the tree it found itself in.
  const good = run(script, tmpdir());
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /the fast file ran/);
  assert.doesNotMatch(good.stdout, /the slow file ran/);
  assert.equal(good.stdout.split(left).length - 1, 2, "said before the run and after it");
  assert.ok(good.stdout.lastIndexOf(left) > good.stdout.lastIndexOf("the fast file ran"), "the last copy comes after the run's output");

  put(dir, { "setup/hook.mjs": "changed\n" });
  const back = run(script, dir);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.match(back.stdout, /the fast file ran/);
  assert.match(back.stdout, /the slow file ran/);
  rmSync(join(dir, "setup"), { recursive: true });

  put(dir, { "test/b.test.mjs": 'import { test } from "node:test";\ntest("a failure", () => { throw new Error("no"); });\n' });
  const bad = run(script, dir);
  assert.equal(bad.status, 1, "a failing test fails the command");
  assert.equal(bad.stdout.split(left).length - 1, 2);
  rmSync(join(dir, "test", "b.test.mjs"));

  // The runner killed under it: no exit code to pass on, and that is no pass.
  put(dir, { "test/c.test.mjs": 'import { test } from "node:test";\ntest("the runner dies", () => { process.kill(process.ppid, "SIGKILL"); });\n' });
  const killed = run(script, dir);
  assert.equal(killed.status, 1, killed.stdout + killed.stderr);
  assert.match(killed.stdout, /^test files: did not finish, SIGKILL$/m);
  rmSync(join(dir, "test", "c.test.mjs"));

  // Through a link: a script that compared names would run nothing and exit 0.
  const link = join(mkdtempSync(join(tmpdir(), "en-short-link-")), "short.mjs");
  symlinkSync(script, link);
  const linked = run(link, dir);
  assert.equal(linked.status, 0, linked.stdout + linked.stderr);
  assert.match(linked.stdout, /the fast file ran/);
});

test("short: --list says the same and runs nothing; anything else it does not know runs nothing either", () => {
  const dir = copy({ "test/a.test.mjs": file("the fast file ran"), "test/b.test.mjs": 'throw new Error("this file ran");\n' });
  const script = join(dir, "test", "short.mjs");
  const list = run(script, dir, ["--list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trimEnd().split("\n"), [
    `short suite, 2 of 3 test files (changed on work since main at ${git(["rev-parse", "HEAD"], { cwd: dir }).slice(0, 7)}: 0)`,
    "read list: not used, test/reads.json is missing; node test/short.mjs --record writes it",
    `left out ${HOOK}: none of its listed paths changed, and it runs at the closing`,
    "test/a.test.mjs",
    "test/b.test.mjs",
  ]);

  for (const args of [["--lits"], ["--list", "x"], ["test/a.test.mjs"]]) {
    const wrong = run(script, dir, args);
    assert.equal(wrong.status, 2, args.join(" "));
    assert.match(wrong.stderr, /^usage: node test\/short\.mjs \[--list \| --record\]/);
    assert.equal(wrong.stdout, "");
  }
});

test("short: after the reports one line per run says how it ended, and the last line says passed or failed", () => {
  /** @param {string} name */
  const act = (name) => `const how = process.env.${name};\nif (how === "fail") throw new Error("no");\nif (how === "kill") process.kill(process.ppid, "SIGKILL");\n`;
  const accounting = "guards: every test that reads this repository has guards; a stand-in";
  const dir = copy({
    "test/a.test.mjs": `import { test } from "node:test";\ntest("a", () => {\n${act("SHORT_FIRST")}});\n`,
    [GUARDS]: `import { test } from "node:test";\ntest(${JSON.stringify(accounting)}, () => {\n${act("SHORT_SECOND")}});\ntest("guards: every guard makes its gate test fail", () => { throw new Error("the mutant run ran"); });\n`,
  });
  const script = join(dir, "test", "short.mjs");
  /** @type {Record<string, string>} */
  const WORDS = { pass: "passed", fail: "failed, exit 1", kill: "did not finish, SIGKILL" };
  for (const first of Object.keys(WORDS)) {
    for (const second of Object.keys(WORDS)) {
      const r = run(script, dir, [], { SHORT_FIRST: first, SHORT_SECOND: second });
      const clean = first === "pass" && second === "pass";
      assert.deepEqual(r.stdout.trimEnd().split("\n").slice(-3), [`test files: ${WORDS[first]}`, `guards' accounting test: ${WORDS[second]}`, `test:short ${clean ? "passed" : "failed"}`], `${first}, ${second}`);
      assert.equal(r.status, clean ? 0 : 1, `${first}, ${second}`);
    }
  }

  // One run, when guards comes back: one line, and the words say the same.
  put(dir, { "test/guards.mjs": `${readFileSync(join(dir, "test", "guards.mjs"), "utf8")}// changed\n` });
  const whole = run(script, dir, [], { SHORT_FIRST: "pass", SHORT_SECOND: "pass" });
  assert.deepEqual(whole.stdout.trimEnd().split("\n").slice(-2), ["test files: failed, exit 1", "test:short failed"]);
  assert.equal(whole.status, 1);
});

test("short: the accounting pattern names the guards file's test that needs no mutant, and it fails when an existing test file starts to find the repository", () => {
  const names = testNames(readFileSync(join(ROOT, GUARDS), "utf8"));
  assert.ok(names.includes("guards: every guard makes its gate test fail"), "the run this leaves out");
  assert.deepEqual(names.filter((n) => new RegExp(ACCOUNTING).test(n)), ["guards: every test that reads this repository has guards; each guard changes one place and names the test that guards it"]);

  // The real test on a copy of this tree, as the command starts it.
  const dir = mkdtempSync(join(tmpdir(), "en-short-tree-"));
  for (const f of git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT }).split("\0").filter(Boolean)) {
    if (!existsSync(join(ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(dir, f));
  }
  const accounting = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "./test/hermetic.mjs", `--test-name-pattern=${ACCOUNTING}`, GUARDS], { cwd: dir, env, encoding: "utf8" });
  };
  const clean = accounting();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^# fail 0$/m);
  // test/core.test.mjs is listed nowhere; test/cli.test.mjs is in NOT_GATES.
  for (const [file, line] of [["test/core.test.mjs", "const here = import.meta.url;\n"], ["test/cli.test.mjs", "const here = process.argv[1];\n"]]) {
    const text = readFileSync(join(dir, file), "utf8");
    writeFileSync(join(dir, file), line + text);
    const found = accounting();
    assert.equal(found.status, 1, `${file}: ${found.stdout.slice(-400)}`);
    assert.match(found.stdout, new RegExp(file.replace("test/", "").replace(/\./g, "\\.")));
    writeFileSync(join(dir, file), text);
  }
});

test("short: with guards left out its accounting test still runs, on its own; its failure fails the command; with guards back it does not run twice", () => {
  const accounting = "guards: every test that reads this repository has guards; a stand-in";
  /** @param {string} body */
  const guards = (body) => `import { test } from "node:test";\ntest(${JSON.stringify(accounting)}, () => { console.log("ACCOUNTING RAN"); ${body} });\ntest("guards: every guard makes its gate test fail", () => { throw new Error("the mutant run ran"); });\n`;
  const dir = copy({ "test/a.test.mjs": file("the fast file ran"), [GUARDS]: guards("") });
  const script = join(dir, "test", "short.mjs");
  const left = run(script, dir);
  assert.equal(left.status, 0, left.stdout + left.stderr);
  assert.match(left.stdout, /ACCOUNTING RAN/);
  assert.match(left.stdout, /the fast file ran/);
  assert.match(left.stdout, new RegExp(`left out ${GUARDS}: none of its listed paths changed, and it runs at the closing; its accounting test runs now`));

  // On the list, not in the run: --list runs nothing and names only what the first run takes.
  const listed = run(script, dir, ["--list"]);
  assert.doesNotMatch(listed.stdout, /ACCOUNTING RAN/);

  // The first run's failure counts though the last run passes.
  const fast = readFileSync(join(dir, "test", "a.test.mjs"), "utf8");
  writeFileSync(join(dir, "test", "a.test.mjs"), 'import { test } from "node:test";\ntest("a failure", () => { throw new Error("no"); });\n');
  const first = run(script, dir);
  assert.equal(first.status, 1, "a failing file fails the command");
  assert.match(first.stdout, /ACCOUNTING RAN/, "the accounting test still ran");
  writeFileSync(join(dir, "test", "a.test.mjs"), fast);

  writeFileSync(join(dir, GUARDS), guards('throw new Error("undecided");'));
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "a failing accounting test"], { cwd: dir });
  git(["branch", "-q", "-f", "main", "work"], { cwd: dir });
  const bad = run(script, dir);
  assert.equal(bad.status, 1, "the accounting test's failure fails the command");
  assert.match(bad.stdout, /the fast file ran/, "the first run went on");

  // Guards comes back: the whole file runs, once, and nothing runs it again.
  put(dir, { "test/guards.mjs": `${readFileSync(join(dir, "test", "guards.mjs"), "utf8")}// changed\n` });
  const back = run(script, dir);
  assert.equal(back.status, 1, "the mutant test ran");
  assert.equal(back.stdout.split("ACCOUNTING RAN").length - 1, 1);
});

test("short: the method names the whole test command, runs it once at the closing and the fast one at landing, and answers a fast command with no slow list and a new slow test", () => {
  const read = (/** @type {string} */ f) => readFileSync(join(ROOT, f), "utf8");
  const brief = read("skills/cycle/task-brief.md");
  assert.match(read("skills/cycle/SKILL.md"), /\(fast test, whole test, lint, typecheck, the mutation tool;/);
  assert.match(read("skills/init/SKILL.md"), /fast test, whole test \(holds every slow gate\), lint and typecheck/);
  assert.match(brief, /\| \*\*Landing\*\* \| One task at a time: rebase, the fast test command and every slow gate the task touches \(no command short of the whole suite: the whole test command\), whatever the agent ran, then the main branch moves; the whole test command waits for the closing \(section 3 of `SKILL\.md`\)\./);
  assert.match(brief, /The landing runs the fast test command and the slow gates the task touches \(the \*\*Landing\*\* row below\), before the main branch moves/);
  assert.match(brief, /One heavy job at a time on the machine: a whole suite, a mutation run, a platform image\./);
  assert.match(read("skills/cycle/SKILL.md"), /7\. \*\*Push:\*\* `ennyn\.mjs worktrees --remove`; the whole test command, once \(red: task-brief\.md's Landing row\);/);
  assert.match(brief, /Red there stops the push: a timing failure is rerun alone first; a real one is traced to the landing commit that brought it and fixed in a new `fix:` commit, written and reviewed as a first write, or the push waits\. The whole run repeats on the fixed tree, and what follows the last edit is done again: the `fix:` commit's rows appended first, convergence run again \(a new block\), the graph, the budget record, leftovers, and `bypass` over the new commit\. A red closing run is a landed task's defect: it counts against no task \(\*\*Landed\*\*\), its `fix:` commit is written by a fresh agent on the session's model and reviewed as a first write, and no escalation applies\./);
  assert.match(brief, /A platform or release matrix the handoff names runs before a release, never at the closing\./);
  assert.match(brief, /a fast command with no slow list is run as it is/);
  assert.match(brief, /A task that adds a slow test says so in its report, and the orchestrator adds it wherever the project lists slow gates\./);
  assert.doesNotMatch(brief, /in the same commit/, "a task does not touch the handoff");
});

test("short: npm run test:short runs the script and npm test still runs every test file", () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(scripts["test:short"], "node test/short.mjs");
  assert.equal(scripts.test, "node --test --import ./test/hermetic.mjs test/*.test.mjs");
});

/** The accounting test's stand-in, which says it ran. */
const ACCOUNTING_STANDIN = `import { test } from "node:test";\ntest("guards: every test that reads this repository has guards; a stand-in", () => { console.log("ACCOUNTING RAN"); });\n`;

/**
 * A copy with a read list recorded on its code: a.test.mjs read notes/a.md, b.test.mjs listed notes/sub, c.test.mjs
 * saw a read it could not name, d.test.mjs read nothing of notes.
 */
function listed() {
  const dir = copy({
    "test/a.test.mjs": file("a ran"),
    "test/b.test.mjs": file("b ran"),
    "test/c.test.mjs": file("c ran"),
    "test/d.test.mjs": file("d ran"),
    [GUARDS]: ACCOUNTING_STANDIN,
    "notes/a.md": "a\n",
    "notes/none.md": "read by no test\n",
  });
  const seen = (/** @type {Partial<{ reads: string[], dirs: string[], unseen: string[] }>} */ s) => ({ reads: [], dirs: [], unseen: [], ...s });
  const tests = {
    "test/a.test.mjs": seen({ reads: ["notes/a.md", "test/a.test.mjs"] }),
    "test/b.test.mjs": seen({ dirs: ["notes/sub"] }),
    "test/c.test.mjs": seen({ unseen: ["spawnSync git: git in the repository"] }),
    "test/d.test.mjs": seen({ reads: ["test/d.test.mjs"] }),
  };
  writeFileSync(join(dir, READS), JSON.stringify({ version: 1, code: codeHash(dir), tests }));
  commit(dir, "the read list");
  git(["branch", "-q", "-f", "main", "work"], { cwd: dir });
  return { dir, tests };
}

test("short: with a fresh read list a branch that changes no code runs the short-suite files that read what changed, and guards' accounting test; a change nobody read runs none", () => {
  const { dir } = listed();
  const script = join(dir, "test", "short.mjs");
  const short = ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/d.test.mjs"];

  put(dir, { "notes/a.md": "changed\n" });
  const text = decide(dir);
  assert.deepEqual(text.files, ["test/a.test.mjs", "test/c.test.mjs"]);
  assert.equal(text.accounting, true);
  assert.equal(text.says[0], `short suite, 2 of 6 test files (changed on work since main at ${git(["rev-parse", "HEAD"], { cwd: dir }).slice(0, 7)}: 1)`);
  assert.equal(text.says[1], "read list: used, no code changed: 2 of 4 short-suite files read what changed");
  assert.ok(text.says.includes("kept test/a.test.mjs: reads notes/a.md"), text.says.join("\n"));
  assert.ok(text.says.includes("kept test/c.test.mjs: its recording saw a read it could not name (spawnSync git: git in the repository)"));
  for (const f of ["test/b.test.mjs", "test/d.test.mjs"]) assert.ok(text.says.includes(`left out ${f}: its recording read none of what changed`), f);
  const ran = run(script, dir);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /a ran/);
  assert.match(ran.stdout, /c ran/);
  assert.doesNotMatch(ran.stdout, /[bd] ran/);
  assert.match(ran.stdout, /ACCOUNTING RAN/);

  // A file new under a listed folder; one beside it whose name only starts the same is not under it.
  put(dir, { "notes/a.md": "a\n", "notes/sub/new.md": "new\n" });
  assert.deepEqual(decide(dir).files, ["test/b.test.mjs", "test/c.test.mjs"]);
  rmSync(join(dir, "notes", "sub"), { recursive: true });
  put(dir, { "notes/subway.md": "new\n" });
  assert.deepEqual(decide(dir).files, ["test/c.test.mjs"]);
  rmSync(join(dir, "notes", "subway.md"));

  // A slow file a text change brings back runs whole, as before: the list does not narrow it.
  put(dir, { "skills/cycle/SKILL.md": "a guarded line gone\n" });
  const back = decide(dir);
  assert.deepEqual(back.files, ["test/c.test.mjs", GUARDS]);
  assert.equal(back.accounting, false);
  rmSync(join(dir, "skills"), { recursive: true });

  // Nobody read it: only what could not be named runs, and with no file at all node --test is not started bare.
  put(dir, { "notes/none.md": "changed\n" });
  assert.deepEqual(decide(dir).files, ["test/c.test.mjs"]);
  const tests = JSON.parse(readFileSync(join(dir, READS), "utf8"));
  tests.tests["test/c.test.mjs"].unseen = [];
  writeFileSync(join(dir, READS), JSON.stringify(tests));
  const none = decide(dir);
  assert.deepEqual(none.files, []);
  assert.equal(none.says[1], "read list: used, no code changed: 0 of 4 short-suite files read what changed");
  // A listing of the whole tree reads every file.
  tests.tests["test/d.test.mjs"].dirs = [""];
  writeFileSync(join(dir, READS), JSON.stringify(tests));
  assert.deepEqual(decide(dir).files, ["test/d.test.mjs"]);
  tests.tests["test/d.test.mjs"].dirs = [];
  writeFileSync(join(dir, READS), JSON.stringify(tests));
  const bare = run(script, dir);
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.doesNotMatch(bare.stdout, /[abcd] ran/, "no test file ran");
  assert.match(bare.stdout, /ACCOUNTING RAN/);
  assert.deepEqual(bare.stdout.trimEnd().split("\n").slice(-2), ["guards' accounting test: passed", "test:short passed"]);
  assert.deepEqual(short.filter((f) => none.says.includes(`left out ${f}: its recording read none of what changed`)), short);
});

test("short: a code change, or a read list missing, unreadable, of another shape, of other test files or of other code, runs the short set as before and says why", () => {
  const { dir, tests } = listed();
  const short = ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/d.test.mjs"];
  const original = readFileSync(join(dir, READS), "utf8");
  /** @param {RegExp} why */
  const asBefore = (why) => {
    const { files, says } = decide(dir);
    assert.deepEqual(files.filter((f) => f !== GUARDS), short, says.join("\n"));
    assert.match(says[1], why);
    assert.ok(!says.some((l) => /^(kept|left out) test\/[a-d]\./.test(l)), says.join("\n"));
  };
  put(dir, { "notes/a.md": "changed\n" });
  for (const code of ["core/glob.mjs", "tool/new.cjs", "web/app.js", "package.json", "sub/package.json"]) {
    put(dir, { [code]: `${existsSync(join(dir, code)) ? readFileSync(join(dir, code), "utf8") : ""}// changed\n` });
    asBefore(new RegExp(`^read list: not used, ${code.replace(/\./g, "\\.")} is code$`));
    git(["checkout", "-q", "--", "."], { cwd: dir });
    git(["clean", "-qfd", "--", "tool", "web", "sub", "package.json"], { cwd: dir });
    put(dir, { "notes/a.md": "changed\n" });
  }
  rmSync(join(dir, READS));
  asBefore(/^read list: not used, test\/reads\.json is missing; node test\/short\.mjs --record writes it$/);
  mkdirSync(join(dir, READS));
  asBefore(/^read list: not used, test\/reads\.json could not be read \(/);
  rmSync(join(dir, READS), { recursive: true });
  /** @type {[unknown, RegExp][]} */
  const wrong = [
    ["{", /is not JSON$/],
    [null, /does not have the shape --record writes$/],
    [{ version: 2, code: "x", tests }, /does not have the shape/],
    [{ version: 1, tests }, /does not have the shape/],
    [{ version: 1, code: "x", tests: [] }, /does not have the shape/],
    [{ version: 1, code: "x", tests: { ...tests, "test/a.test.mjs": { reads: "notes/a.md", dirs: [], unseen: [] } } }, /does not have the shape/],
    [{ version: 1, code: "x", tests: { ...tests, "test/a.test.mjs": { reads: [1], dirs: [], unseen: [] } } }, /does not have the shape/],
    [{ ...JSON.parse(original), tests: { ...tests, "test/e.test.mjs": tests["test/d.test.mjs"] } }, /was recorded on other test files; node test\/short\.mjs --record$/],
    [{ ...JSON.parse(original), tests: { "test/a.test.mjs": tests["test/a.test.mjs"] } }, /was recorded on other test files/],
    [{ ...JSON.parse(original), code: "0".repeat(64) }, /was recorded on other code; node test\/short\.mjs --record$/],
  ];
  for (const [list, why] of wrong) {
    writeFileSync(join(dir, READS), typeof list === "string" ? list : JSON.stringify(list));
    asBefore(why);
  }
  writeFileSync(join(dir, READS), original);
  assert.deepEqual(decide(dir).files, ["test/a.test.mjs", "test/c.test.mjs"], "the list as written is used");

  // Code changed since the recording, committed on the branch: the hash says so even when the list came along.
  put(dir, { "core/glob.mjs": `${readFileSync(join(dir, "core/glob.mjs"), "utf8")}// changed\n` });
  commit(dir, "code");
  git(["branch", "-q", "-f", "main", "work"], { cwd: dir });
  asBefore(/was recorded on other code/);
});

test("short: --record writes what each short-suite file read, in the node children it starts too, and what it could not see; a failed run writes nothing", () => {
  const top = 'const top = join(dirname(fileURLToPath(import.meta.url)), "..");\n';
  const head = 'import { test } from "node:test";\nimport { existsSync, readFileSync, realpathSync, statSync, symlinkSync, watch, writeFileSync, mkdtempSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nimport { tmpdir } from "node:os";\nimport { dirname, join, relative } from "node:path";\nimport { fileURLToPath } from "node:url";\n' + top;
  /** @param {string} body */
  const t = (body) => `${head}test("x", () => {\n${body}\n});\n`;
  const ok = 'if (r.status !== 0) throw new Error(String(r.stderr));';
  const dir = copy({
    // A file read, a CLI started by path, and node started by name from a script that drops NODE_OPTIONS, as a commit hook does.
    "test/a.test.mjs": t(
      [
        'readFileSync(join(top, "notes", "a.md"));',
        // A folder statted and one not there yet: what comes to lie below either changes the answer.
        'statSync(join(top, "tool")); existsSync(join(top, "commands")); realpathSync(top);',
        'let r = spawnSync(process.execPath, [join(top, "tool", "cli.mjs")], { cwd: tmpdir(), encoding: "utf8" });',
        ok,
        'const hook = join(mkdtempSync(join(tmpdir(), "en-hook-")), "hook");',
        'writeFileSync(hook, `unset NODE_OPTIONS\\nexec node ${JSON.stringify(join(top, "tool", "hook.mjs"))}\\n`);',
        'r = spawnSync("sh", [hook], { cwd: tmpdir(), encoding: "utf8" });',
        ok,
      ].join("\n"),
    ),
    // git in the tree: --git-dir alone leaves the work tree here.
    "test/b.test.mjs": t('const r = spawnSync("git", ["--git-dir", join(tmpdir(), "none"), "--version"], { cwd: top, encoding: "utf8" });\n' + ok),
    // node without the preload, a child without the run's folder, and one whose PATH finds another node first.
    "test/c.test.mjs": t(
      [
        'let r = spawnSync(process.execPath, ["-e", "0"], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" });',
        ok,
        'r = spawnSync("sh", ["-c", "true"], { cwd: tmpdir(), env: { ...process.env, ENNYN_READS: "" }, encoding: "utf8" });',
        ok,
        'r = spawnSync("sh", ["-c", "true"], { cwd: tmpdir(), env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, encoding: "utf8" });',
        ok,
      ].join("\n"),
    ),
    // git started here that works elsewhere.
    "test/d.test.mjs": t(
      [
        "if (process.env.SHORT_FAIL) throw new Error('fails');",
        'const away = mkdtempSync(join(tmpdir(), "en-away-"));',
        'let r = spawnSync("git", ["-C", away, "--version"], { cwd: top, encoding: "utf8" });',
        ok,
        'r = spawnSync("git", ["--git-dir", join(away, ".git"), "--work-tree", away, "--version"], { cwd: top, encoding: "utf8" });',
        ok,
        // Where the shell and npm say a run started is no input.
        'r = spawnSync("sh", ["-c", "true"], { cwd: away, env: { ...process.env, PWD: top, OLDPWD: top, INIT_CWD: top, npm_package_json: join(top, "package.json") }, encoding: "utf8" });',
        ok,
      ].join("\n"),
    ),
    // A program that is not node, outside the tree, handed a file of it by an environment value or a relative path.
    "test/e.test.mjs": t('const r = spawnSync("sh", ["-c", \'cat "$F" >/dev/null\'], { cwd: tmpdir(), env: { ...process.env, F: join(top, "notes", "a.md") }, encoding: "utf8" });\n' + ok),
    "test/f.test.mjs": t('const here = realpathSync(tmpdir());\nconst r = spawnSync("sh", ["-c", `cat ${relative(here, join(top, "notes", "a.md"))} >/dev/null`], { cwd: here, encoding: "utf8" });\n' + ok),
    // A read through a link from outside the tree, realpathSync.native, fs.watch.
    "test/g.test.mjs": t(
      [
        'const link = join(mkdtempSync(join(tmpdir(), "en-link-")), "link");',
        'symlinkSync(join(top, "notes", "link.md"), link);',
        "readFileSync(link);",
        'realpathSync.native(join(top, "notes", "native.md"));',
        'watch(join(top, "notes", "watch.md")).close();',
      ].join("\n"),
    ),
    "notes/link.md": "link\n",
    "notes/native.md": "native\n",
    "notes/watch.md": "watch\n",
    "tool/cli.mjs": 'import "./lib.mjs";\nimport { readFileSync } from "node:fs";\nreadFileSync(new URL("../notes/cli.md", import.meta.url));\n',
    "tool/lib.mjs": "export const lib = 1;\n",
    "tool/hook.mjs": 'import { readFileSync } from "node:fs";\nreadFileSync(new URL("../notes/hook.md", import.meta.url));\n',
    "notes/a.md": "a\n",
    "notes/cli.md": "cli\n",
    "notes/hook.md": "hook\n",
  });
  copyFileSync(join(ROOT, "test", "reads.mjs"), join(dir, "test", "reads.mjs"));
  const script = join(dir, "test", "short.mjs");
  const done = run(script, dir, ["--record"]);
  if (typeof registerHooks !== "function") {
    assert.equal(done.status, 2);
    assert.match(done.stderr, /--record needs module\.registerHooks \(Node 22\.15 or later\)/);
    assert.ok(!existsSync(join(dir, READS)));
    return;
  }
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /^test\/reads\.json: 7 test files recorded$/m);
  const list = JSON.parse(readFileSync(join(dir, READS), "utf8"));
  assert.deepEqual(Object.keys(list), ["version", "code", "tests"]);
  assert.equal(list.version, 1);
  assert.equal(list.code, codeHash(dir));
  assert.deepEqual(Object.keys(list.tests), ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/d.test.mjs", "test/e.test.mjs", "test/f.test.mjs", "test/g.test.mjs"]);
  assert.deepEqual(list.tests["test/e.test.mjs"].unseen, ["spawnSync sh: sh handed a path in the repository"]);
  assert.deepEqual(list.tests["test/f.test.mjs"].unseen, ["spawnSync sh: sh handed a path in the repository"]);
  const g = list.tests["test/g.test.mjs"];
  for (const p of ["notes/link.md", "notes/native.md", "notes/watch.md"]) assert.ok(g.reads.includes(p), `g: ${p} in ${g.reads}`);
  assert.deepEqual(g.unseen, []);
  const a = list.tests["test/a.test.mjs"];
  for (const p of ["notes/a.md", "notes/cli.md", "notes/hook.md", "tool/cli.mjs", "tool/lib.mjs", "tool/hook.mjs", "test/a.test.mjs", "test/hermetic.mjs"]) assert.ok(a.reads.includes(p), `a: ${p} in ${a.reads}`);
  assert.deepEqual(a.unseen, []);
  assert.deepEqual(a.dirs, ["commands", "tool"], "a folder and a missing path as listings, and never the top");
  assert.ok(!a.reads.includes("commands") && !a.reads.includes(""), a.reads.join(" "));
  assert.deepEqual(list.tests["test/b.test.mjs"].unseen, ["spawnSync git: git in the repository"]);
  assert.deepEqual(list.tests["test/c.test.mjs"].unseen, ["spawnSync node: node without the preload", "spawnSync sh: a PATH whose first node is another", "spawnSync sh: no ENNYN_READS"]);
  const d = list.tests["test/d.test.mjs"];
  assert.deepEqual(d.unseen, []);
  assert.ok(!d.reads.some((/** @type {string} */ p) => p.startsWith("notes/") || p.startsWith("tool/")), d.reads.join(" "));
  assert.ok(!JSON.stringify(list).includes(tmpdir()) && !JSON.stringify(list).includes(dir), "no path outside the tree");

  // The list it wrote is used, and a failing recording leaves it as it was.
  commit(dir, "the read list");
  git(["branch", "-q", "-f", "main", "work"], { cwd: dir });
  put(dir, { "notes/hook.md": "changed\n" });
  assert.deepEqual(decide(dir).files, ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/e.test.mjs", "test/f.test.mjs"]);
  put(dir, { "notes/hook.md": "hook\n", "commands/x.md": "new\n" });
  assert.deepEqual(decide(dir).files, ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs", "test/e.test.mjs", "test/f.test.mjs"], "a file new below a path that was missing");
  rmSync(join(dir, "commands"), { recursive: true });
  const before = readFileSync(join(dir, READS), "utf8");
  writeFileSync(join(dir, READS), "kept\n");
  const failed = run(script, dir, ["--record"], { SHORT_FAIL: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /the recording run failed, exit 1; test\/reads\.json is not written/);
  assert.equal(readFileSync(join(dir, READS), "utf8"), "kept\n");
  writeFileSync(join(dir, READS), before);
});
