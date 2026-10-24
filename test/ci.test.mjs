import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciFindings, ciIntroduced, ciKind, ciMessages, ciSet, ciText, localPath, pinnedUses, stripComment } from "../checks/ci.mjs";
import { git, stagedVersions } from "../core/git.mjs";
import { loadConfig, ConfigError } from "../core/config.mjs";
import { checkSetup } from "../setup/doctor.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = `sha256:${"0a98".repeat(16)}`;

/** The `uses` of a text as [line, value, pinned]. @param {string} text @param {"workflow" | "action"} [kind] */
const usesOf = (text, kind = "workflow") => ciFindings(text, kind).uses.map((u) => [u.n, u.value, u.pinned]);

test("ci uses: every way YAML writes a step's or a job's uses is read, and only a commit, a digest or a local path is pinned (reject corpus)", () => {
  /** @type {[string, string, (string | number | boolean)[][]][]} */
  const reject = [
    ["a dash item", "steps:\n  - uses: actions/checkout@v4\n", [[2, "actions/checkout@v4", false]]],
    ["double quotes", 'steps:\n  - uses: "actions/checkout@v4"\n', [[2, "actions/checkout@v4", false]]],
    ["single quotes", "steps:\n  - uses: 'actions/checkout@v4'\n", [[2, "actions/checkout@v4", false]]],
    ["a branch", "steps:\n  - uses: actions/checkout@main\n", [[2, "actions/checkout@main", false]]],
    ["a comment after a tag", "steps:\n  - uses: actions/checkout@v4 # v4.2.2\n", [[2, "actions/checkout@v4", false]]],
    ["a flow mapping item", "steps:\n  - { uses: actions/checkout@v4, with: { fetch-depth: 0 } }\n", [[2, "actions/checkout@v4", false]]],
    ["a flow mapping under a key", "steps:\n  - step: { uses: actions/checkout@v4 }\n", [[2, "actions/checkout@v4", false]]],
    ["a sequence at its key's column", "steps:\n- uses: a/b@v1\n- run: x\n", [[2, "a/b@v1", false]]],
    ["the value on the next line", "steps:\n  - uses:\n      a/b@v1\n", [[3, "a/b@v1", false]]],
    ["an alias of a scalar", "env:\n  X: &co a/b@v1\nsteps:\n  - uses: *co\n", [[4, "a/b@v1", false]]],
    ["an alias with no anchor", "steps:\n  - uses: *nowhere\n", [[2, "*nowhere", false]]],
    ["an alias of a pinned scalar is pinned", `env:\n  X: &co a/b@${SHA}\nsteps:\n  - uses: *co\n`, [[4, `a/b@${SHA}`, true]]],
    ["a tag", "steps:\n  - uses: !!str a/b@v1\n", [[2, "a/b@v1", false]]],
    ["a reusable workflow", "jobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@main\n", [[3, "org/repo/.github/workflows/x.yml@main", false]]],
    ["a docker image by tag", "steps:\n  - uses: docker://alpine:3.20\n", [[2, "docker://alpine:3.20", false]]],
    ["a SHA in capitals", `steps:\n  - uses: a/b@${SHA.toUpperCase()}\n`, [[2, `a/b@${SHA.toUpperCase()}`, false]]],
    ["a short SHA", "steps:\n  - uses: a/b@3d3c42e\n", [[2, "a/b@3d3c42e", false]]],
    ["a quoted key", 'steps:\n  - "uses": a/b@v1\n', [[2, "a/b@v1", false]]],
    ["a space before the colon", "steps:\n  - uses : a/b@v1\n", [[2, "a/b@v1", false]]],
    ["CRLF", "steps:\r\n  - uses: a/b@v1\r\n", [[2, "a/b@v1", false]]],
    ["no ref at all", "steps:\n  - uses: a/b\n", [[2, "a/b", false]]],
    ["a byte order mark", "\uFEFFsteps:\n  - uses: a/b@v1\n", [[2, "a/b@v1", false]]],
    ["two documents", "steps:\n  - uses: a/b@v1\n---\nsteps:\n  - uses: c/d@v2\n", [[2, "a/b@v1", false], [5, "c/d@v2", false]]],
    ["a SHA with a tag after it", `steps:\n  - uses: a/b@${SHA}-v4\n`, [[2, `a/b@${SHA}-v4`, false]]],
    ["a path with no ./ in front", "steps:\n  - uses: .github/actions/x\n", [[2, ".github/actions/x", false]]],
    ["after a run block in the same step", "steps:\n  - run: |\n      make\n    uses: a/b@v1\n", [[4, "a/b@v1", false]]],
  ];
  for (const [name, text, want] of reject) assert.deepEqual(usesOf(text), want, name);
  // A quote that does not close is no value to judge: the file is refused.
  assert.deepEqual(ciFindings('steps:\n  - uses: "a/b@v1\n', "workflow").unread.map((u) => u.n), [2]);
  // An action's steps are read the same way.
  assert.deepEqual(usesOf("runs:\n  using: composite\n  steps:\n    - uses: a/b@v1\n", "action"), [[4, "a/b@v1", false]]);
});

test("ci uses: text that only looks like a uses is not read as one (accept corpus)", () => {
  /** @type {[string, string, (string | number | boolean)[][]][]} */
  const accept = [
    ["a full SHA with its tag in a comment", `steps:\n  - uses: actions/checkout@${SHA} # v7.0.1\n`, [[2, `actions/checkout@${SHA}`, true]]],
    ["a local action", "steps:\n  - uses: ./.github/actions/build\n", [[2, "./.github/actions/build", true]]],
    ["a docker image by digest", `steps:\n  - uses: docker://alpine@${DIGEST}\n`, [[2, `docker://alpine@${DIGEST}`, true]]],
    ["a run block holding a workflow", "steps:\n  - run: |\n      cat > x.yml <<EOF\n      uses: a/b@v1\n      EOF\n", []],
    ["a folded block", "steps:\n  - run: >-\n      uses: a/b@v1\n", []],
    ["an input named uses", "steps:\n  - uses: ./x\n    with:\n      uses: a/b@v1\n", [[2, "./x", true]]],
    ["an env value named uses", "env:\n  uses: a/b@v1\n", []],
    ["a comment", "steps:\n  # - uses: a/b@v1\n  - run: x\n", []],
    ["a value that says uses", 'steps:\n  - name: "uses: a/b@v1"\n', []],
    ["a run that says uses", 'steps:\n  - run: echo "uses: a/b@v1"\n', []],
    ["a key that ends in uses", "steps:\n  - reuses: a/b@v1\n", []],
  ];
  for (const [name, text, want] of accept) assert.deepEqual(usesOf(text), want, name);
  assert.ok(pinnedUses(`a/b/path@${SHA}`));
  assert.ok(!pinnedUses(`a/b@${SHA}0`));
  assert.ok(!pinnedUses("docker://alpine@sha256:abc"));
});

test("ci text: only UTF-8 with no NUL is read; a byte order mark is dropped", () => {
  assert.equal(ciText(Buffer.from("\uFEFFa: b\n")), "a: b\n");
  // Valid UTF-8, but UTF-16 with no byte order mark: its keys would read as nothing.
  assert.equal(ciText(Buffer.from("a: b\n", "utf16le")), null);
  assert.equal(ciText(Buffer.from([0x61, 0xe9, 0x0a])), null);
});

test("ci comments: a # starts a comment only outside quotes and after whitespace", () => {
  assert.equal(stripComment("a: b # c"), "a: b ");
  assert.equal(stripComment('a: "b # c" # d'), 'a: "b # c" ');
  assert.equal(stripComment("a: 'it''s # here' # d"), "a: 'it''s # here' ");
  assert.equal(stripComment("a: b#c"), "a: b#c");
  assert.equal(stripComment("run: echo don't # x"), "run: echo don't ");
  assert.equal(stripComment("# all"), "");
});

const TARGET = "on:\n  pull_request_target:\n    types: [opened]\n";

test("ci pwn: a pull_request_target workflow that checks out the pull request's code is found (reject corpus)", () => {
  /** @type {[string, string, number[]][]} */
  const reject = [
    ["checkout of the head SHA", `${TARGET}jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`, [9]],
    ["the head repository", `${TARGET}jobs:\n  a:\n    steps:\n      - uses: x/y@${SHA}\n        with:\n          repository: \${{ github.event.pull_request.head.repo.full_name }}\n`, [9]],
    ["the head ref", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ github.head_ref }}\n`, [8]],
    ["a pull ref", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          ref: refs/pull/\${{ github.event.number }}/merge\n`, [8]],
    ["checkout's own opt-out", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          allow-unsafe-pr-checkout: true\n`, [8]],
    ["git in a run block", `${TARGET}jobs:\n  a:\n    steps:\n      - run: |\n          git fetch origin pull/\${{ github.event.number }}/head\n          make\n`, [8]],
    ["gh pr checkout on one line", `${TARGET}jobs:\n  a:\n    steps:\n      - run: gh pr checkout \${{ github.event.pull_request.number }}\n`, [7]],
    ["the trigger as a value", `on: pull_request_target\njobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`, [6]],
    ["the trigger in a flow list", `on: [push, pull_request_target]\njobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.ref }}\n`, [6]],
    ["the trigger as an item", `on:\n  - pull_request_target\njobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.merge_commit_sha }}\n`, [7]],
  ];
  for (const [name, text, lines] of reject) assert.deepEqual(ciFindings(text, "workflow").pwn.map((p) => p.n), lines, name);
});

test("ci pwn: pull request code checked out elsewhere, or the base checked out, is not found (accept corpus)", () => {
  const head = "\n          ref: ${{ github.event.pull_request.head.sha }}\n";
  /** @type {[string, string][]} */
  const accept = [
    ["pull_request, not the target", `on: pull_request\njobs:\n  a:\n    steps:\n      - with:${head}`],
    ["the base checked out", `${TARGET}jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n`],
    ["the base SHA", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.base.sha }}\n`],
    ["the head SHA only in a comment", `${TARGET}jobs:\n  a:\n    steps:\n      - with: # ref: \${{ github.event.pull_request.head.sha }}\n          x: 1\n`],
    ["the head SHA for a status, not a checkout", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          script: |\n            github.rest.repos.createCommitStatus({ sha: context.payload.pull_request.head.sha })\n          sha: \${{ github.event.pull_request.head.sha }}\n`],
    ["the opt-out turned off", `${TARGET}jobs:\n  a:\n    steps:\n      - with:\n          allow-unsafe-pr-checkout: false\n`],
    ["the trigger only in a comment", `on: pull_request # not pull_request_target\njobs:\n  a:\n    steps:\n      - with:${head}`],
    ["a fetch of the base branch", `${TARGET}jobs:\n  a:\n    steps:\n      - run: git fetch origin main\n`],
    ["the head ref only echoed", `${TARGET}jobs:\n  a:\n    steps:\n      - run: echo \${{ github.head_ref }}\n`],
    ["the trigger only in a run block", `on: push\njobs:\n  a:\n    steps:\n      - run: |\n          echo pull_request_target\n      - with:${head}`],
  ];
  for (const [name, text] of accept) assert.deepEqual(ciFindings(text, "workflow").pwn, [], name);
});

test("ci permissions: a job that gets the default token, and write-all, are found; any permissions set are not", () => {
  const jobs = "jobs:\n  a:\n    runs-on: x\n  b:\n    permissions:\n      contents: read\n    runs-on: x\n";
  assert.deepEqual(ciFindings(`on: push\n${jobs}`, "workflow").unpermitted, [{ job: "a", n: 3 }]);
  for (const top of ["permissions:\n  contents: read\n", "permissions: {}\n", "permissions: read-all\n"]) {
    assert.deepEqual(ciFindings(`on: push\n${top}${jobs}`, "workflow").unpermitted, [], top);
  }
  assert.deepEqual(ciFindings(`on: push\npermissions: write-all\n${jobs}`, "workflow").writeAll, [{ where: "", n: 2 }]);
  assert.deepEqual(ciFindings("on: push\njobs:\n  a:\n    permissions: write-all\n", "workflow").writeAll, [{ where: "a", n: 4 }]);
  // A key at the jobs' column after them is no job; an action file has no jobs to judge.
  assert.deepEqual(ciFindings("jobs:\n  a:\n    permissions: {}\nenv:\n  b: 1\n", "workflow").unpermitted, []);
  assert.deepEqual(ciFindings(`on: push\n${jobs}`, "action").unpermitted, []);
  // Jobs written as a flow mapping are read like a block one.
  assert.deepEqual(ciFindings("on: push\njobs: { a: { runs-on: x }, b: { permissions: {} } }\n", "workflow").unpermitted, [{ job: "a", n: 2 }]);
});

test("ci introduced: what HEAD's version already holds is not new; a second copy, a removed permissions and a new file are", () => {
  const intro = (/** @type {string} */ now, /** @type {string | null} */ before) => ciIntroduced(ciFindings(now, "workflow"), before === null ? null : ciFindings(before, "workflow"));
  const old = `on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n`;
  assert.deepEqual(intro(old, old).unpinned, []);
  // Moved down a line: the same uses, not a new one.
  assert.deepEqual(intro(old.replace("steps:", "steps:\n      - run: x"), old).unpinned, []);
  const twice = `${old}      - uses: a/b@v1\n`;
  assert.deepEqual(intro(twice, old).unpinned.map((u) => u.n), [7]);
  assert.deepEqual(intro(old.replace("permissions: {}\n", ""), old).unpermitted.map((j) => j.job), ["a"]);
  assert.deepEqual(intro(old, null).unpinned.map((u) => u.n), [6]);
});

/** A repository with Ennyn's default config; `stage` writes files and adds them. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-ci-repo-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { ".ennyn/config.json": "{}\n" });
  const stage = (/** @type {Record<string, string | Buffer>} */ files) => {
    put(dir, files);
    git(["add", "-A"], { cwd: dir });
  };
  const commit = (/** @type {string} */ message, /** @type {string[]} */ ...extra) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", ...extra, "-m", message], { cwd: dir, encoding: "utf8" });
  const check = (/** @type {string[]} */ ...flags) => {
    writeFileSync(join(dir, ".git", "MSG"), "chore: ci\n");
    return spawnSync(process.execPath, [CLI, "commit-check", ...flags, ".git/MSG"], { cwd: dir, encoding: "utf8" });
  };
  return { dir, stage, commit, check };
}

/** @param {string} dir @param {Record<string, string | Buffer>} files */
function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const PINNED = `on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n`;
const WF = ".github/workflows/ci.yml";

test("ci hook: a commit that adds a uses by tag, a pull request checkout or a job without permissions fails, and says where", () => {
  const r = repo();
  r.stage({ [WF]: PINNED });
  assert.equal(r.check("--hook").status, 0, "a pinned workflow with permissions passes");
  assert.equal(r.commit("chore: ci").status, 0);
  r.stage({ [WF]: PINNED.replace(`@${SHA} # v7.0.1`, "@v7") });
  const tag = r.check("--hook");
  assert.equal(tag.status, 1);
  assert.match(tag.stderr, /\.github\/workflows\/ci\.yml: 1 new uses name code that can change under the same name.*line 8 \(actions\/checkout@v7\)/);
  r.stage({ [WF]: PINNED.replace("permissions:\n  contents: read\n", "") });
  assert.match(r.check("--hook").stderr, /neither the workflow nor these jobs set permissions.*line 3 \(a\)/);
  r.stage({ [WF]: PINNED.replace("on: push", "on: pull_request_target").replace("# v7.0.1", "# v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}") });
  assert.match(r.check("--hook").stderr, /pull_request_target workflow checks out the pull request's code.*line 10/);
  // The bypass marker loosens the message's shape, not the files.
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci [commit-shape-allow: testing the marker]\n");
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" }).status, 1);
  // A composite action file is read for its uses.
  r.stage({ [WF]: PINNED, "tools/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: a/b@v1\n" });
  assert.match(r.check("--hook").stderr, /tools\/action\.yml: 1 new uses/);
});

test("ci hook: what HEAD already holds stays; a deleted file, an excepted one and a file the check cannot read pass, the last saying so", () => {
  const r = repo();
  // Committed past the hook: the old state the check leaves alone.
  r.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n" });
  assert.equal(r.commit("chore: old", "--no-verify").status, 0);
  r.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n      - run: make\n" });
  assert.equal(r.check("--hook").status, 0, "touching a file does not make its old lines new");
  git(["rm", "-q", "-f", WF], { cwd: r.dir });
  const deleted = r.check("--hook");
  assert.deepEqual([deleted.status, deleted.stderr], [0, ""], "a deleted workflow brings nothing, and nothing is said");
  r.stage({ ".ennyn/config.json": JSON.stringify({ security: { ci: { except: [".github/workflows/legacy.yml"] } } }), ".github/workflows/legacy.yml": "steps:\n  - uses: a/b@v1\n" });
  assert.equal(r.check("--hook").status, 0, "an excepted file is not read");
  const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("steps:\n  - uses: a/b@v1\n", "utf16le")]);
  r.stage({ [WF]: wide });
  const said = r.check("--hook");
  assert.equal(said.status, 0);
  assert.match(said.stderr, /ci\.yml: not checked \(not UTF-8 text\)/);
  git(["rm", "-q", "--cached", WF], { cwd: r.dir });
  symlinkSync("../../elsewhere.yml", join(r.dir, ".github", "workflows", "link.yml"));
  git(["add", "-A"], { cwd: r.dir });
  assert.match(r.check("--hook").stderr, /link\.yml: not checked \(a symbolic link\)/);
});

test("ci hook: a staged CI file whose name is not UTF-8 is said by the hook, and fails commit-check run by hand", () => {
  const r = repo();
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: r.dir, input: "steps:\n  - uses: a/b@v1\n", encoding: "utf8" }).stdout.trim();
  const name = Buffer.from([...Buffer.from(".github/workflows/"), 0xff, ...Buffer.from(".yml")]);
  assert.equal(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: r.dir, input: Buffer.concat([Buffer.from(`100644 ${hash}\t`), name, Buffer.from("\n")]) }).status, 0);
  const hook = r.check("--hook");
  assert.equal(hook.status, 0);
  assert.match(hook.stderr, /security\.ci was not checked in 1 staged path\(s\) whose names are not UTF-8/);
  const hand = r.check();
  assert.equal(hand.status, 1);
  assert.match(hand.stderr, /security\.ci was not checked in 1 staged path/);
});

test("ci hook: a merge that brings a uses by tag from the other side fails; the index a hook is given is the one read", () => {
  const r = repo();
  r.stage({ "README.md": "x\n" });
  assert.equal(r.commit("chore: start").status, 0);
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  r.stage({ [WF]: "on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n" });
  assert.equal(r.commit("chore: side", "--no-verify").status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "README.md": "y\n" });
  assert.equal(r.commit("chore: main").status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-commit", "--no-ff", "side"], { cwd: r.dir, encoding: "utf8" }).status, 0);
  assert.match(r.check("--hook").stderr, /ci\.yml: 1 new uses/);
  git(["merge", "--abort"], { cwd: r.dir });
  // git commit -- <path> gives the hook a temporary index: the staged workflow there is read, not the main one.
  const index = join(r.dir, ".git", "index.partial");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(["read-tree", "HEAD"], { cwd: r.dir, env, keepIndex: true });
  put(r.dir, { [WF]: "on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n" });
  git(["add", WF], { cwd: r.dir, env, keepIndex: true });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.match(hook.stderr, /ci\.yml: 1 new uses/);
});

test("ci hook: a file past 16 MB is said, and a name the index holds decomposed is read as written", () => {
  const r = repo();
  r.stage({ [WF]: `steps:\n  - uses: a/b@v1\n${"#".repeat(16 * 1024 * 1024)}\n` });
  assert.match(r.check("--hook").stderr, /ci\.yml: not checked \(past 16 MB\)/);
  git(["rm", "-q", "--cached", WF], { cwd: r.dir });
  // An index entry named in NFD (as Linux git writes it) under macOS git's composing of what it is asked.
  git(["config", "core.precomposeUnicode", "true"], { cwd: r.dir });
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: r.dir, input: "steps:\n  - uses: a/b@v1\n", encoding: "utf8" }).stdout.trim();
  const name = ".github/workflows/e\u0301.yml";
  assert.equal(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: r.dir, input: `100644 ${hash}\t${name}\n` }).status, 0);
  assert.match(r.check("--hook").stderr, /e\u0301\.yml: 1 new uses/);
});

test("ci messages: a staged name in neither the index nor HEAD is said, a deleted file is not", () => {
  const out = ciMessages(new Map([["a.yml", { staged: null, head: null }], ["b.yml", { staged: null, head: Buffer.from("x: 1\n") }]]), "en");
  assert.deepEqual(out, { errors: [], warnings: ["a.yml: not checked (not in the index or HEAD under this name); its uses, triggers and permissions are not known"] });
});

test("ci versions: both versions of a staged file are read as bytes, and what cannot be read says why", () => {
  const r = repo();
  r.stage({ "a.yml": "old\n", "gone.yml": "x\n" });
  assert.equal(r.commit("chore: a").status, 0);
  r.stage({ "a.yml": "new\n", "b.yml": "b\n" });
  git(["rm", "-q", "gone.yml"], { cwd: r.dir });
  const v = stagedVersions(r.dir, ["a.yml", "b.yml", "gone.yml"]);
  assert.deepEqual([...v].map(([p, x]) => [p, x.staged?.toString(), x.head?.toString(), x.unread]), [
    ["a.yml", "new\n", "old\n", undefined],
    ["b.yml", "b\n", undefined, undefined],
    ["gone.yml", undefined, "x\n", undefined],
  ]);
});

test("ci config: security.ci takes lists of globs, and [] turns the check off", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-ci-cfg-"));
  assert.deepEqual(loadConfig({ cwd: dir, env: {}, override: { security: { ci: { paths: [] } } } }).security.ci.paths, []);
  for (const bad of [{ paths: [""] }, { except: [3] }, { paths: ["[z-a]"] }, { extra: true }]) {
    assert.throws(() => loadConfig({ cwd: dir, env: {}, override: { security: { ci: bad } } }), ConfigError, JSON.stringify(bad));
  }
});

test("ci doctor: what the tracked CI files hold today is counted, and a file it cannot read is unmeasured", async () => {
  const r = repo();
  r.stage({ [WF]: PINNED });
  const ok = await checkSetup({ cwd: r.dir, env: {} });
  assert.ok(ok.items.some((i) => i.key === "doctor.ciClean" && i.level === "ok"));
  r.stage({ [WF]: PINNED.replace(`@${SHA} # v7.0.1`, "@v7").replace("permissions:\n  contents: read\n", "permissions: write-all\n"), ".github/workflows/b.yml": "on: push\njobs:\n  b:\n    runs-on: x\n" });
  const bad = await checkSetup({ cwd: r.dir, env: {} });
  const keys = bad.items.filter((i) => i.key.startsWith("doctor.ci")).map((i) => [i.level, i.key]);
  assert.deepEqual(keys, [["warn", "doctor.ciUnpinned"], ["warn", "doctor.ciPermissions"], ["warn", "doctor.ciWriteAll"]]);
  r.stage({ [WF]: Buffer.from([0xff, 0xfe, 0x41, 0x00]) });
  const unread = await checkSetup({ cwd: r.dir, env: {} });
  assert.ok(unread.items.some((i) => i.key === "doctor.ciUnread" && i.level === "unmeasured"));
});

// Review round one: each case below passed silently, or said the wrong thing, before its fix.

test("ci round one: the reader follows the YAML GitHub runs, and refuses what it cannot follow", () => {
  const head = "${{ github.event.pull_request.head.sha }}";
  const T = "on: pull_request_target\n";
  const pwnOf = (/** @type {string} */ text, kind = /** @type {"workflow" | "action"} */ ("workflow")) => ciFindings(text, kind).pwn.map((p) => p.n);
  // Every line break YAML has.
  for (const br of ["\r", "\u0085", "\u2028", "\u2029"]) assert.deepEqual(usesOf(["steps:", "  - uses: a/b@v1", ""].join(br)), [[2, "a/b@v1", false]], JSON.stringify(br));
  // Steps as a flow sequence, on one line and over several.
  assert.deepEqual(usesOf("steps: [{uses: a/b@v1}, {run: echo hi}]\n"), [[1, "a/b@v1", false]]);
  assert.deepEqual(usesOf("steps: [\n  { uses: a/b@v1 },\n  { run: x }\n]\n"), [[1, "a/b@v1", false]]);
  // Keys spelled with escapes, a tag or an anchor; a trigger spelled with an escape.
  assert.deepEqual(usesOf('steps:\n  - "\\x75ses": a/b@v1\n'), [[2, "a/b@v1", false]]);
  assert.deepEqual(usesOf("steps:\n  - !!str uses: a/b@v1\n  - &k uses: c/d@v2\n"), [[2, "a/b@v1", false], [3, "c/d@v2", false]]);
  assert.deepEqual(pwnOf(`on:\n  "pull_request\\u005ftarget":\njobs:\n  a:\n    steps:\n      - with:\n          ref: ${head}\n`), [7]);
  assert.deepEqual(pwnOf(`on: ["pull_request\\x5ftarget"]\njobs:\n  a:\n    steps:\n      - with:\n          ref: ${head}\n`), [6]);
  // An explicit key is refused, not skipped.
  assert.deepEqual(ciFindings("steps:\n  - ? uses\n    : a/b@v1\n", "workflow").unread.map((u) => u.n), [2, 3]);
  // A quoted value over two lines is one value: its second line is no key.
  assert.deepEqual(ciFindings('on: push\nname: "x\n  permissions: read-all"\njobs:\n  a:\n    runs-on: x\n', "workflow").unpermitted, [{ job: "a", n: 5 }]);
  // Aliases of a mapping and of a scalar on an item are read again where they stand.
  assert.deepEqual(usesOf("x:\n  - &co\n    uses: a/b@v1\nsteps:\n  - *co\n"), [[3, "a/b@v1", false], [5, "a/b@v1", false]]);
  assert.deepEqual(ciFindings("on:\n  push:\n    branches: [main]\nx:\n  - &p write-all\npermissions: *p\njobs:\n  a: {}\n", "workflow").writeAll, [{ where: "", n: 6 }]);
  assert.deepEqual(usesOf("base: &b\n  uses: a/b@v1\nsteps:\n  - <<: *b\n"), [[2, "a/b@v1", false], [4, "a/b@v1", false]]);
  // A merge puts its keys in the mapping it stands in: a job's merged permissions are the job's.
  assert.deepEqual(ciFindings("on: push\nd: &d\n  permissions: {}\njobs:\n  a:\n    <<: *d\n    runs-on: x\n", "workflow").unpermitted, []);
  // The flow mapping on the line after its key.
  assert.deepEqual(pwnOf(`${T}jobs:\n  a:\n    steps:\n      - with:\n          { ref: "${head}" }\n`), [6]);
  // A job named like an input map is a job; a matrix value named uses is no step.
  assert.deepEqual(usesOf("jobs:\n  secrets:\n    uses: o/r/.github/workflows/x.yml@main\n"), [[3, "o/r/.github/workflows/x.yml@main", false]]);
  assert.deepEqual(usesOf("jobs:\n  a:\n    strategy:\n      matrix:\n        uses: [a, b]\n"), []);
  // What the reading cannot follow, and input built to make it slow, ends in a refusal, at once.
  const started = Date.now();
  assert.ok(ciFindings(`${"- ".repeat(50000)}x\n`, "workflow").unread.length);
  let laughs = "a: &a [x,x,x,x,x,x,x,x,x,x]\n";
  for (let k = 0; k < 9; k++) laughs += `b${k}: &b${k} [${Array(10).fill(k ? `*b${k - 1}` : "*a").join(",")}]\n`;
  assert.ok(ciFindings(laughs, "workflow").unread.length);
  for (const line of ["a" + " ".repeat(40000) + "b", 'x "'.repeat(80000), "a:".repeat(100000), "run: ${{ ".repeat(100000)]) ciFindings(`${line}\n`, "workflow");
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test("ci round one: a pull request's code fetched in more ways, through a callee, and a local action from an unpinned checkout, are found", () => {
  const T = "on: pull_request_target\njobs:\n  a:\n    steps:\n";
  const pwnOf = (/** @type {string} */ text) => ciFindings(text, "workflow").pwn.map((p) => p.n);
  assert.deepEqual(pwnOf(`${T}      - run: |\n          git fetch origin \\\n            "pull/\${{ github.event.pull_request.number }}/head:pr"\n`), [6]);
  assert.deepEqual(pwnOf(`${T}      - run: |\n          PR_REF="refs/pull/\${{ github.event.number }}/merge"\n          git fetch origin "$PR_REF"\n`), [7]);
  assert.deepEqual(pwnOf(`${T}      - env:\n          SHA: \${{ github.event.pull_request.head.sha }}\n        run: git checkout "$SHA"\n`), [7]);
  assert.deepEqual(pwnOf(`${T}      - with:\n          ref: \${{ github.event.pull_request.head['sha'] }}\n`), [6]);
  assert.deepEqual(pwnOf(`${T}      - with:\n          ref: \${{ format('refs/{0}/{1}/merge', 'pull', github.event.number) }}\n`), [6]);
  assert.deepEqual(pwnOf(`${T}      - with:\n          ref: \${{ GitHub.Event.Pull_Request.Head.SHA }}\n`), [6], "contexts are read without case");
  assert.deepEqual(pwnOf(`${T}      - with:\n          ref: \${{ github.event.pull_request.base.sha }}\n`), []);
  // A reusable workflow and a local action the trigger reaches: what they check out counts in their own file.
  const files = new Map([
    [".github/workflows/pr.yml", "on: pull_request_target\npermissions: {}\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n  b:\n    steps:\n      - uses: ./.github/actions/pr\n      - uses: ./.github/actions/gone\n"],
    [".github/workflows/build.yml", "on: workflow_call\npermissions: {}\njobs:\n  a:\n    steps:\n      - with:\n          ref: ${{ github.event.pull_request.head.sha }}\n"],
    [".github/actions/pr/action.yml", "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/${{ github.event.number }}/head\n      shell: bash\n"],
  ]);
  const { findings, missing } = ciSet(files);
  assert.deepEqual(findings.get(".github/workflows/build.yml")?.pwn.map((p) => [p.n, p.what]), [[7, "ref: ${{ github.event.pull_request.head.sha }} (reached from .github/workflows/pr.yml)"]]);
  assert.deepEqual(findings.get(".github/actions/pr/action.yml")?.pwn.map((p) => p.n), [4]);
  assert.deepEqual(missing, [{ path: ".github/workflows/pr.yml", n: 9, callee: ".github/actions/gone" }]);
  // Called from pull_request only, the same callee checks out nothing it should not.
  assert.deepEqual(ciSet(new Map([...files].map(([p, x]) => [p, x.replace("pull_request_target", "pull_request")]))).findings.get(".github/workflows/build.yml")?.pwn, []);
  // A local action inside a checkout of another repository by a branch runs code nobody pinned.
  const loose = `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          repository: someorg/shared\n          ref: main\n          path: ext\n      - uses: ./ext/setup\n      - uses: ./mine\n`;
  assert.deepEqual(ciFindings(loose, "workflow").uses.map((u) => [u.value, u.pinned, u.from]), [[`actions/checkout@${SHA}`, true, undefined], ["./ext/setup", false, "someorg/shared@main"], ["./mine", true, undefined]]);
  assert.deepEqual(ciFindings(loose.replace("ref: main", `ref: ${SHA}`), "workflow").uses.map((u) => u.pinned), [true, true, true]);
  // With no path the other repository is the workspace: every local action is its code.
  assert.deepEqual(ciFindings(loose.replace("          path: ext\n", ""), "workflow").uses.map((u) => u.pinned), [true, false, false]);
  // A checkout step read again through an alias keeps its keys together: its pinned ref still pins it.
  const aliased = `x:\n  - &co\n    uses: actions/checkout@${SHA}\n    with: { repository: o/r, ref: ${SHA}, path: ext }\njobs:\n  a:\n    steps:\n      - *co\n      - uses: ./ext/x\n`;
  assert.deepEqual(ciFindings(aliased, "workflow").uses.map((u) => u.pinned), [true, true, true]);
  // Two checkouts read again through one alias stay two steps: the second one's branch is its own.
  const two = `s: &s\n  - uses: actions/checkout@${SHA}\n    with: { repository: o/r, ref: ${SHA}, path: ext }\n  - uses: actions/checkout@${SHA}\n    with: { repository: o/q, ref: main, path: ext2 }\njobs:\n  a:\n    steps: *s\n    x:\n      - uses: ./ext2/x\n      - uses: ./ext/y\n`;
  assert.deepEqual(ciFindings(two, "workflow").uses.map((u) => [u.value, u.pinned]).slice(-2), [["./ext2/x", false], ["./ext/y", true]]);
});

test("ci round one: a workflow named action.yml is a workflow, messages escape what a file holds, and reasons follow the language", () => {
  assert.equal(ciKind(".github/workflows/action.yml"), "workflow");
  assert.equal(ciKind("tools/build/action.yaml"), "action");
  const evil = Buffer.from('steps:\n  - uses: "evil/x@main\\r\\u001b[2K\\nAll checks passed"\n');
  const out = ciMessages(new Map([["a.yml", { staged: evil, head: null }]]), "en");
  assert.equal(out.errors.length, 1);
  assert.ok(!/[\u0000-\u001f]/.test(out.errors[0]), JSON.stringify(out.errors[0]));
  assert.match(out.errors[0], /\\u001b\[2K\\nAll checks passed/);
  const tr = ciMessages(new Map([["a.yml", { staged: null, head: null, unread: /** @type {const} */ ("symlink") }]]), "tr");
  assert.match(tr.warnings[0], /sembolik bağ/);
  // YAML the reading cannot follow is refused; a callee it does not hold is said.
  const forms = ciMessages(new Map([[".github/workflows/a.yml", { staged: Buffer.from("steps:\n  - ? uses\n    : a/b@v1\n"), head: null }]]), "en");
  assert.match(forms.errors.join("\n"), /a\.yml: YAML the check cannot follow.*line 2 \(an explicit key/);
  const gone = ciMessages(new Map([[".github/workflows/p.yml", { staged: Buffer.from("on: pull_request_target\npermissions: {}\njobs:\n  a:\n    uses: ./.github/workflows/gone.yml\n"), head: null }]]), "en");
  assert.deepEqual(gone, { errors: [], warnings: [".github/workflows/p.yml: a pull_request_target workflow reaches .github/workflows/gone.yml at line 5, which the check does not read; what it checks out was not checked"] });
});

test("ci round one: the hook reads past a HEAD it cannot read, names security.ci when the staged paths are unread, and keeps its errors when the message check fails", () => {
  const r = repo();
  // HEAD's version is a symbolic link: the staged regular file is checked against nothing.
  mkdirSync(join(r.dir, ".github", "workflows"), { recursive: true });
  symlinkSync("../../elsewhere.yml", join(r.dir, WF));
  git(["add", "-A"], { cwd: r.dir });
  assert.equal(r.commit("chore: link", "--no-verify").status, 0);
  rmSync(join(r.dir, WF));
  writeFileSync(join(r.dir, WF), "on: push\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n");
  git(["add", WF], { cwd: r.dir });
  const replaced = r.check("--hook");
  assert.equal(replaced.status, 1);
  assert.match(replaced.stderr, /ci\.yml: 1 new uses/);
  // An index from outside the git dir: the message names every check that went without the staged paths.
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const foreign = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: join(r.dir, "foreign-index") } });
  assert.match(foreign.stderr, /review\.forbidden, security\.ci, security\.deps and security\.secrets checks ran without them/);
  // A pattern in the config that does not compile: the message goes unchecked, the workflow's errors stand.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ commitMsg: { skipSubjects: ["("] } }) });
  git(["add", ".ennyn/config.json"], { cwd: r.dir });
  const broken = r.check("--hook");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /ci\.yml: 1 new uses/);
  // paths [] turns the check off.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ security: { ci: { paths: [] } } }) });
  git(["add", ".ennyn/config.json"], { cwd: r.dir });
  assert.deepEqual([r.check("--hook").status, r.check("--hook").stderr], [0, ""]);
});

test("ci round one: a caller and its callee committed together are read together, and doctor names excepted files and an unresolved merge", async () => {
  const r = repo();
  r.stage({
    ".github/workflows/pr.yml": "on: pull_request_target\npermissions: {}\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n",
    ".github/workflows/build.yml": "on: workflow_call\npermissions: {}\njobs:\n  a:\n    steps:\n      - with:\n          ref: ${{ github.event.pull_request.head.sha }}\n",
  });
  const both = r.check("--hook");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /build\.yml: a pull_request_target workflow checks out the pull request's code.*line 7 \(.*reached from \.github\/workflows\/pr\.yml\)/);
  // The callee already there, the caller added later: the caller's commit makes the callee's checkout new.
  git(["rm", "-q", "--cached", ".github/workflows/pr.yml"], { cwd: r.dir });
  assert.equal(r.commit("chore: build").status, 0);
  git(["add", ".github/workflows/pr.yml"], { cwd: r.dir });
  assert.match(r.check("--hook").stderr, /build\.yml: a pull_request_target workflow checks out/);
  git(["reset", "-q"], { cwd: r.dir });
  // doctor: an excepted file is named; an unresolved conflict is unmeasured, not clean.
  r.stage({ ".ennyn/config.json": JSON.stringify({ security: { ci: { except: [".github/workflows/build.yml"] } } }) });
  const excepted = await checkSetup({ cwd: r.dir, env: {} });
  assert.ok(excepted.items.some((i) => i.key === "doctor.ciExcepted" && i.level === "warn"));
  const m = repo();
  m.stage({ [WF]: PINNED });
  assert.equal(m.commit("chore: base").status, 0);
  git(["checkout", "-q", "-b", "side"], { cwd: m.dir });
  m.stage({ [WF]: PINNED.replace("on: push", "on: [push]") });
  assert.equal(m.commit("chore: side").status, 0);
  git(["checkout", "-q", "main"], { cwd: m.dir });
  m.stage({ [WF]: PINNED.replace(`@${SHA} # v7.0.1`, "@v7").replace("permissions:\n  contents: read\n", "") });
  assert.equal(m.commit("chore: main", "--no-verify").status, 0);
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "side"], { cwd: m.dir });
  const conflict = await checkSetup({ cwd: m.dir, env: {} });
  const ci = conflict.items.filter((i) => i.key.startsWith("doctor.ci"));
  assert.ok(ci.some((i) => i.key === "doctor.ciUnread" && i.level === "unmeasured" && i.vars.reason === "a conflict not resolved"), JSON.stringify(ci));
  assert.ok(!ci.some((i) => i.key === "doctor.ciClean"), JSON.stringify(ci));
});

// Review round two: each shape below was swallowed, passed or refused wrongly by the round-one reader.

test("ci round two: what the reader joins never swallows a key; when it would, the file is refused", () => {
  const silentOrSaid = (/** @type {string} */ text, /** @type {string} */ name) => {
    const f = ciFindings(text, "workflow");
    assert.ok(f.uses.some((u) => !u.pinned) || f.unread.length, `${name}: ${JSON.stringify(f.uses)} ${JSON.stringify(f.unread)}`);
  };
  const tail = "      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n";
  const jobs = (/** @type {string} */ step) => `on: push\njobs:\n  a:\n    steps:\n${step}${tail}`;
  // A comma in a block value is a character, not a flow indicator.
  assert.deepEqual(ciFindings(jobs("      - run: IFS=',' read -r a b <<< \"$X\"\n"), "workflow").uses.map((u) => u.value), ["actions/checkout@v4", "actions/setup-node@v4"]);
  assert.deepEqual(ciFindings(jobs("      - run: cut -d',' -f1 x\n"), "workflow").unread, []);
  assert.deepEqual(ciFindings(jobs("      - run: printf '%s,' \"$x\"\n"), "workflow").uses.length, 2);
  silentOrSaid(jobs("      - run: echo a,'b\n"), "comma quote");
  silentOrSaid(jobs("      - run: echo a - 'b\n"), "dash quote");
  silentOrSaid(jobs("      - name: Build\n        'quoted start\n"), "quote at a continuation line");
  // An apostrophe inside a plain flow scalar is a character.
  for (const v of ["env: {GREETING: it's}\n", "on:\n  push:\n    branches: [main, it's]\n"]) {
    const f = ciFindings(`${v}jobs:\n  a:\n    steps:\n      - uses: evil/a@main\n`, "workflow");
    assert.deepEqual([f.uses.map((u) => u.value), f.unpermitted.map((j) => j.job)], [["evil/a@main"], ["a"]], v);
  }
  assert.deepEqual(ciFindings("on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - with: { message: don't panic }\n      - uses: evil/a@main\n", "workflow").uses.map((u) => u.value), ["evil/a@main"]);
  // A quote after a tag or an anchor is a quoted scalar too: its second line is no key.
  for (const p of ["!!str ", "&n "]) assert.deepEqual(ciFindings(`on: push\nname: ${p}"x\n permissions: read-all"\njobs:\n  a:\n    runs-on: x\n`, "workflow").unpermitted, [{ job: "a", n: 5 }], p);
  // Text after a flow collection, and a flow collection that stops at a key, are refused.
  assert.ok(ciFindings("on: [push] x\n", "workflow").unread.length);
  assert.ok(ciFindings("on: [push,\njobs:\n  a:\n    steps:\n      - uses: evil/a@main\n", "workflow").unread.length);
});

test("ci round two: a run command is read on its own; another repository placed by a clone or any path counts, in its own job", () => {
  const T = "on: pull_request_target\njobs:\n  a:\n    steps:\n";
  const pwnOf = (/** @type {string} */ text) => ciFindings(text, "workflow").pwn.map((p) => p.n);
  const env = "      - env:\n          PR: ${{ github.event.pull_request.number }}\n";
  assert.deepEqual(pwnOf(`${T}${env}        run: git fetch origin main && git diff --stat origin/main\n`), []);
  assert.deepEqual(pwnOf(`${T}      - run: |\n          git log -1\n          gh pr comment \${{ github.event.pull_request.number }} --body "Thanks for the pull request!"\n`), []);
  assert.deepEqual(pwnOf(`${T}      - run: gh pr diff \${{ github.event.number }} | wc -l\n`), []);
  assert.deepEqual(pwnOf(`${T}      - run: gh pr diff \${{ github.event.number }} | git apply\n`), [5]);
  assert.deepEqual(pwnOf(`${T}      - run: git fetch origin "$GITHUB_HEAD_REF"\n`), [5]);
  assert.deepEqual(pwnOf(`${T}${env}        run: git fetch origin "pull/$PR/head"\n`), [7]);
  // A ref from an env value is the pull request's code too.
  assert.deepEqual(pwnOf(`on: pull_request_target\nenv:\n  PR_SHA: \${{ github.event.pull_request.head.sha }}\njobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ env.PR_SHA }}\n`), [8]);
  const pinnedOf = (/** @type {string} */ text) => ciFindings(text, "workflow").uses.filter((u) => u.value.startsWith("./")).map((u) => [u.value, u.pinned]);
  const co = `      - uses: actions/checkout@${SHA}\n        with:\n          repository: org/website\n`;
  // Its own job only, after the checkout only; a job's own local workflow comes from the caller's commit.
  assert.deepEqual(pinnedOf(`jobs:\n  docs:\n    steps:\n      - uses: ./.github/actions/early\n${co}      - uses: ./.github/actions/late\n  build:\n    steps:\n      - uses: ./.github/actions/setup\n  call:\n    uses: ./.github/workflows/reusable.yml\n`), [["./.github/actions/early", true], ["./.github/actions/late", false], ["./.github/actions/setup", true], ["./.github/workflows/reusable.yml", true]]);
  // A checkout of the pull request's own repository by an expression is not judged here (pull_request runs it anyway).
  assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          repository: \${{ github.event.pull_request.head.repo.full_name }}\n      - uses: ./x\n`), [["./x", true]]);
  for (const [how, step] of [
    ["clone", "      - run: git clone --depth 1 https://github.com/someorg/shared-actions ext\n"],
    ["gh clone", "      - run: gh repo clone someorg/shared-actions ext\n"],
    ["workspace path", `${co}          path: \${{ github.workspace }}/ext\n`],
    ["dot path", `${co}          path: ext/.\n`],
    ["unknown path", `${co}          path: \${{ inputs.dir }}\n`],
  ]) assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n${step}      - uses: ./ext/setup\n`), [["./ext/setup", false]], how);
});

test("ci round two: a root action, a call six deep and a change under an explicit key are seen", () => {
  const fetch = "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/${{ github.event.number }}/head\n      shell: bash\n";
  const root = ciSet(new Map([[".github/workflows/pr.yml", "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./\n"], ["action.yml", fetch]]));
  assert.deepEqual([root.findings.get("action.yml")?.pwn.length, root.missing], [1, []]);
  const chain = new Map([[".github/workflows/pr.yml", "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./a1\n"]]);
  for (let k = 1; k <= 6; k++) chain.set(`a${k}/action.yml`, k < 6 ? `runs:\n  using: composite\n  steps:\n    - uses: ./a${k + 1}\n` : fetch);
  assert.equal(ciSet(chain).findings.get("a6/action.yml")?.pwn.length, 1);
  const before = ciFindings("jobs:\n  a:\n    steps:\n      - ? uses\n        : ./local\n", "workflow");
  const after = ciFindings("jobs:\n  a:\n    steps:\n      - ? uses\n        : evil/a@main\n", "workflow");
  assert.deepEqual(ciIntroduced(after, before).unread.map((u) => u.n), [5]);
});

test("ci round two: files that are large, many or not UTF-8 by name, and untouched, neither switch the check off nor fail it", async () => {
  // Reading stays under a few seconds on many steps that check out another repository, and many jobs.
  const started = Date.now();
  ciFindings(`jobs:\n  a:\n    steps:\n${"      - with: { repository: o/r }\n".repeat(20000)}`, "workflow");
  ciFindings(`on: push\njobs:\n${Array.from({ length: 20000 }, (_, k) => `  j${k}:\n    runs-on: x\n`).join("")}`, "workflow");
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  const r = repo();
  // Untouched workflows that add up past one read of git's buffer: the staged one is still checked.
  const big = `on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./x\n${"#".repeat(13 * 1024 * 1024)}\n`;
  r.stage(Object.fromEntries([1, 2, 3, 4].map((k) => [`.github/workflows/big${k}.yml`, big])));
  assert.equal(r.commit("chore: big", "--no-verify").status, 0);
  r.stage({ [WF]: "on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n" });
  const checked = r.check("--hook");
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /ci\.yml: 1 new uses/);
  git(["reset", "-q"], { cwd: r.dir });
  // A tracked workflow whose name is not UTF-8, untouched: said, and a hand run of a clean commit passes.
  const s = repo();
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: s.dir, input: "on: push\n", encoding: "utf8" }).stdout.trim();
  const name = Buffer.from([...Buffer.from(".github/workflows/"), 0xff, ...Buffer.from(".yml")]);
  assert.equal(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: s.dir, input: Buffer.concat([Buffer.from(`100644 ${hash}\t`), name, Buffer.from("\n")]) }).status, 0);
  assert.equal(s.commit("chore: odd", "--no-verify").status, 0);
  // Only the clean workflow: the odd name is in no work tree here, and `add -A` would stage its deletion.
  put(s.dir, { [WF]: PINNED });
  git(["add", WF], { cwd: s.dir });
  const hand = s.check();
  assert.equal(hand.status, 0, hand.stderr);
  assert.match(hand.stderr, /was not checked in 1 tracked CI file/);
  // A callee outside the workflows directory, committed earlier, is read by its path; doctor names a missing one.
  const c = repo();
  c.stage({ "tools/pr/action.yml": "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/${{ github.event.number }}/head\n      shell: bash\n" });
  assert.equal(c.commit("chore: action").status, 0);
  c.stage({ ".github/workflows/pr.yml": "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./tools/pr\n      - uses: ./tools/gone\n" });
  const outside = c.check("--hook").stderr;
  assert.match(outside, /tools\/pr\/action\.yml: a pull_request_target workflow checks out/);
  // The action.yaml it does not have is no file, not one "not in the index".
  assert.doesNotMatch(outside, /not in the index or HEAD/);
  const d = await checkSetup({ cwd: c.dir, env: {} });
  assert.ok(d.items.some((i) => i.key === "doctor.ciCalleeMissing" && i.level === "unmeasured" && String(i.vars.path) === ".github/workflows/pr.yml"), JSON.stringify(d.items.filter((i) => i.key.startsWith("doctor.ci"))));
});

// Review round three: shapes the command-by-command reading let through, and the context reads that could turn
// the check off.

test("ci round three: a git command anywhere on a run line, a ref built or relayed, and a patch through a file are found", () => {
  const T = "on: pull_request_target\njobs:\n  a:\n    steps:\n";
  const head = "${{ github.event.pull_request.head.sha }}";
  const pwnOf = (/** @type {string} */ run) => ciFindings(`${T}      - run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`, "workflow").pwn.map((p) => p.n);
  for (const run of [
    `if git checkout ${head}; then make; fi`,
    "if ! git fetch origin \"pull/${{ github.event.number }}/head:pr\"; then exit 1; fi",
    "(git fetch origin pull/${{ github.event.number }}/head && git checkout FETCH_HEAD)",
    "bash -c \"git fetch origin pull/${{ github.event.number }}/head\"",
    `timeout 60 git fetch origin ${head}`,
    `out=$(git checkout ${head})`,
    `echo ${head} | xargs git checkout`,
    "GH_TOKEN=${{ github.token }} gh pr checkout ${{ github.event.number }}",
    "curl -sL ${{ github.event.pull_request.patch_url }} | git am",
    `git fetch origin \${{ github.event.pull_request.head.sha || github.sha }}`,
    "git checkout ${{ github.event.after }}",
  ]) assert.deepEqual(pwnOf(run), [6], run);
  // An unquoted assignment of an expression taints its name; a patch kept in a file is the same patch.
  assert.deepEqual(pwnOf(`SHA=${head}\ngit fetch origin $SHA && git checkout $SHA`), [7]);
  assert.deepEqual(pwnOf("gh pr diff ${{ github.event.number }} > pr.diff\ngit apply pr.diff"), [7]);
  // `${{ env['X'] }}` is `env.X`.
  assert.deepEqual(ciFindings(`on: pull_request_target\nenv:\n  PR_SHA: ${head}\njobs:\n  a:\n    steps:\n      - with:\n          ref: \${{ env['PR_SHA'] }}\n`, "workflow").pwn.map((p) => p.n), [8]);
  // The number alone builds no ref: a branch named after it is not the pull request's code.
  assert.deepEqual(pwnOf("git checkout -b backport-${{ github.event.pull_request.number }} origin/release"), []);
});

test("ci round three: alias keys, JSON-style flows and item flows over lines are read as YAML reads them", () => {
  assert.deepEqual(usesOf("steps:\n  - &u uses: ./local\n  - *u : actions/checkout@v4\n"), [[2, "./local", true], [3, "actions/checkout@v4", false]]);
  assert.ok(ciFindings("steps:\n  - *nowhere : a/b@v1\n", "workflow").unread.length, "an alias key with no anchor is refused");
  const json = ciFindings('on: pull_request_target\njobs:\n  a:\n    steps:\n      - with: {"msg":"a, #b","ref":"${{ github.event.pull_request.head.sha }}"}\n', "workflow");
  assert.deepEqual([json.unread, json.pwn.map((p) => p.n)], [[], [5]]);
  const item = ciFindings("steps:\n- {uses: a/b@v1,\n  with: {x: 1}}\n- uses: c/d@v2\n", "workflow");
  assert.deepEqual([item.unread, item.uses.map((u) => u.value)], [[], ["a/b@v1", "c/d@v2"]]);
  // A dash inside a value opens no quote; a flow over lines that would take a key is refused.
  assert.deepEqual(ciFindings("on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - run: echo a - 'b\n      - uses: c/d@v2\n", "workflow").unread, []);
  assert.ok(ciFindings("env: {A: 1,\njobs: {a: {steps: [{uses: evil/a@main}]}}}\n", "workflow").unread.length);
});

test("ci round three: another repository placed by an expression, a prefixed clone or a local action counts in the caller's job", () => {
  const pinnedOf = (/** @type {string} */ text) => ciFindings(text, "workflow").uses.filter((u) => u.value.startsWith("./")).map((u) => [u.value, u.pinned]);
  const co = (/** @type {string} */ repo) => `      - uses: actions/checkout@${SHA}\n        with:\n          repository: ${repo}\n          ref: main\n          path: ext\n`;
  assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n${co("${{ vars.SHARED_ACTIONS }}")}      - uses: ./ext/setup\n`), [["./ext/setup", false]]);
  assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n${co("${{ github.repository }}")}      - uses: ./ext/setup\n`), [["./ext/setup", true]]);
  assert.deepEqual(pinnedOf("jobs:\n  a:\n    steps:\n      - run: GIT_TERMINAL_PROMPT=0 git clone https://github.com/someorg/shared-actions ext\n      - uses: ./ext/setup\n"), [["./ext/setup", false]]);
  // The workspace's own path is the directory it names: a local action elsewhere is still this repository's.
  assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n${co("o/r").replace("path: ext", "path: ${{ github.workspace }}/ext")}      - uses: ./ext/setup\n      - uses: ./mine\n`), [["./ext/setup", false], ["./mine", true]]);
  // A composite action that checks out another repository does so in its caller's workspace.
  const { findings } = ciSet(new Map([
    [".github/workflows/w.yml", "on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/fetch-shared\n      - uses: ./ext/setup\n  b:\n    steps:\n      - uses: ./ext/setup\n"],
    [".github/actions/fetch-shared/action.yml", `runs:\n  using: composite\n  steps:\n${co("someorg/shared-actions").replace(/^ {6}/gm, "    ")}`],
  ]));
  assert.deepEqual(findings.get(".github/workflows/w.yml")?.uses.map((u) => [u.n, u.pinned]), [[6, true], [7, false], [10, true]]);
  // A local path is the repository's own: `x/../y` is `y`, one that leaves the repository reaches nothing.
  assert.equal(localPath("./x/../tools/a"), "tools/a");
  assert.equal(localPath("./../x"), "..");
});

test("ci round three: the hook reads callers from the configured directories, and context it cannot read leaves the staged files checked", () => {
  // A custom workflows directory: its caller reaches the staged callee.
  const r = repo();
  r.stage({
    ".ennyn/config.json": JSON.stringify({ security: { ci: { paths: [".gitea/workflows/*.yml", "**/action.yml"] } } }),
    ".gitea/workflows/t.yml": "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./tools/a\n",
    "tools/a/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./tools/b\n",
  });
  assert.equal(r.commit("chore: chain", "--no-verify").status, 0);
  r.stage({ "tools/b/action.yml": "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/${{ github.event.number }}/head\n      shell: bash\n" });
  const chained = r.check("--hook");
  assert.equal(chained.status, 1, chained.stderr);
  assert.match(chained.stderr, /tools\/b\/action\.yml: a pull_request_target workflow checks out/);
  // A local path git would refuse or rewrite turns nothing off: the staged workflow's own findings stand.
  const s = repo();
  s.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./../x\n      - uses: ./x/../tools/a\n" });
  const odd = s.check("--hook");
  assert.equal(odd.status, 1, odd.stderr);
  assert.match(odd.stderr, /ci\.yml: 1 new uses/);
  assert.doesNotMatch(odd.stderr, /was not checked|not in the index or HEAD/);
});

test("ci round three: a git call that fails on a callee is said, and the staged workflow's own findings still refuse the commit", () => {
  const r = repo();
  r.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./tools/broken\n" });
  // A git that fails only when asked about the callee.
  const bin = mkdtempSync(join(tmpdir(), "en-ci-git-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *tools/broken*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const out = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /could not read the local callees "?tools\/broken\/action\.yml/);
  assert.match(out.stderr, /ci\.yml: 1 new uses/);
});

// Review round four.

test("ci round four: folded run text is one command, every pull request field counts in a ref, and a clone outside the workspace reaches no local action", () => {
  const T = "on: pull_request_target\njobs:\n  a:\n    steps:\n";
  const pwnOf = (/** @type {string} */ text) => ciFindings(text, "workflow").pwn.map((p) => p.n);
  assert.deepEqual(pwnOf(`${T}      - run: >-\n          git fetch origin\n          pull/\${{ github.event.pull_request.number }}/head:pr\n`), [6]);
  assert.deepEqual(pwnOf(`${T}      - run: >\n          git checkout\n          \${{ github.event.pull_request.head.sha }}\n\n          make\n`), [6]);
  // A literal block keeps its lines: the ref on another line is another command.
  assert.deepEqual(pwnOf(`${T}      - run: |\n          git fetch origin main\n          echo \${{ github.event.pull_request.head.sha }}\n`), []);
  // In a repository or a ref, any field of the pull request but its base names its code (the author's fork).
  assert.deepEqual(pwnOf(`${T}      - with:\n          repository: \${{ github.event.pull_request.user.login }}/\${{ github.event.repository.name }}\n`), [6]);
  const pinnedOf = (/** @type {string} */ text) => ciFindings(text, "workflow").uses.filter((u) => u.value.startsWith("./")).map((u) => [u.value, u.pinned]);
  for (const dir of ["/tmp/tools", '"$RUNNER_TEMP/tools"', "${{ runner.temp }}/tools"]) {
    assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n      - run: git clone https://github.com/org/tools.git ${dir}\n      - uses: ./.github/actions/setup\n`), [["./.github/actions/setup", true]], dir);
  }
  // A variable or the runner's work path spelled out is somewhere in the workspace this reading cannot place.
  // The runner's work path is written in parts, as test/hygiene.test.mjs reads home paths.
  for (const dir of ['"$DEST"', `/${"home"}/runner/work/r/r/ext`]) {
    assert.deepEqual(pinnedOf(`jobs:\n  a:\n    steps:\n      - run: git clone https://github.com/org/tools.git ${dir}\n      - uses: ./.github/actions/setup\n`), [["./.github/actions/setup", false]], dir);
  }
});

test("ci round four: an anchor named again means the newest node, and many local calls into a placing action stay fast", () => {
  // (The anchored mapping sits under env, where a uses is no step's; read again as a step, it is one.)
  assert.deepEqual(usesOf("env:\n  X: &s scalar\n  Y: &s\n    uses: actions/checkout@v4\nsteps:\n  - *s\n"), [[6, "actions/checkout@v4", false]]);
  assert.deepEqual(usesOf("x: &s\n  uses: actions/checkout@v4\ny: &s scalar\nsteps:\n  - uses: *s\n"), [[2, "actions/checkout@v4", false], [5, "scalar", false]]);
  const started = Date.now();
  const steps = Array.from({ length: 20000 }, () => "      - uses: ./a\n").join("");
  ciSet(new Map([[".github/workflows/w.yml", `on: push\npermissions: {}\njobs:\n  j:\n    steps:\n${steps}`], ["a/action.yml", `runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n      with:\n        repository: o/r\n`]]));
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test("ci round four: a patch of the pull request by URL, a ref passed through for, read or a function, and a stale key anchor are found", () => {
  const T = "on: pull_request_target\njobs:\n  a:\n    steps:\n";
  const pwnOf = (/** @type {string} */ run) => ciFindings(`${T}      - run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`, "workflow").pwn.map((p) => p.n);
  for (const run of [
    "curl -sL https://github.com/${{ github.repository }}/pull/${{ github.event.number }}.diff | git apply",
    "curl -sL ${{ github.event.pull_request.html_url }}.patch | git am",
    'gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }} -H "Accept: application/vnd.github.diff" | git apply',
    "git fetch origin ${{ format('refs/{0}l/{1}/head', 'pul', github.event.number) }}",
  ]) assert.deepEqual(pwnOf(run), [6], run);
  assert.deepEqual(pwnOf('for ref in "pull/${{ github.event.number }}/head"; do\n  git fetch origin "$ref"\ndone'), [7]);
  assert.deepEqual(pwnOf('read -r SHA <<< "${{ github.event.pull_request.head.sha }}"\ngit fetch origin "$SHA"'), [7]);
  assert.deepEqual(pwnOf('fetch_pr() { git fetch origin "$1" && git checkout FETCH_HEAD; }\nfetch_pr "pull/${{ github.event.number }}/head"'), [7]);
  // A key anchor named again by a step: the alias is the step.
  assert.deepEqual(usesOf("env:\n  &s FOO: bar\nsteps:\n  - &s\n    uses: evil/a@main\n  - *s\n"), [[5, "evil/a@main", false], [6, "evil/a@main", false]]);
});

test("ci round four: a callee nobody can read is said on every commit, and placements cost a path's depth", () => {
  const files = new Map([
    [".github/workflows/pr.yml", "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/link\n"],
  ]);
  const v = new Map([...files].map(([p, t]) => [p, { staged: Buffer.from(t), head: Buffer.from(t) }]));
  assert.equal(ciMessages(v, "en").warnings.length, 1, "said although HEAD could not read it either");
  // Two placements of one directory in a job: the earlier one already covers a step between them.
  const twice = `jobs:\n  a:\n    steps:\n      - run: git clone https://github.com/o/r ext\n      - uses: ./ext/x\n      - run: git clone https://github.com/o/q ext\n`;
  assert.deepEqual(ciFindings(twice, "workflow").uses.map((u) => u.pinned), [false]);
  const started = Date.now();
  const pairs = Array.from({ length: 10000 }, (_, k) => `      - uses: actions/checkout@${SHA}\n        with: { repository: a/b, path: d${k} }\n      - uses: ./d${k}/x\n`).join("");
  const many = ciSet(new Map([[".github/workflows/w.yml", `on: push\npermissions: {}\njobs:\n  j:\n    steps:\n${pairs}`]]));
  assert.equal(many.findings.get(".github/workflows/w.yml")?.uses.filter((u) => !u.pinned).length, 10000);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});
