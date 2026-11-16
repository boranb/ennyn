import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TEXT, ciCallees, ciFindings, ciIntroduced, ciKind, ciMessages, ciSet, ciText, localPath, pinnedUses, prExpression, stripComment, yamlRead } from "../checks/ci.mjs";
import { git, stagedVersions } from "../core/git.mjs";
import { loadConfig, ConfigError } from "../core/config.mjs";
import { checkSetup } from "../setup/doctor.mjs";
import { TOKENS } from "./secret-shapes.mjs";

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
    ["a SHA with a tag after it", `steps:\n  - uses: a/b@${SHA}-v4\n`, [[2, `a/b@${SHA}-v4`, false]]],
    ["a path with no ./ in front", "steps:\n  - uses: .github/actions/x\n", [[2, ".github/actions/x", false]]],
    ["after a run block in the same step", "steps:\n  - run: |\n      make\n    uses: a/b@v1\n", [[4, "a/b@v1", false]]],
  ];
  for (const [name, text, want] of reject) assert.deepEqual(usesOf(text), want, name);
  // Forms outside the part of YAML this reading takes are refused, never read otherwise: a value on the line below
  // its key, a second document.
  assert.deepEqual(ciFindings("steps:\n  - uses:\n      a/b@v1\n", "workflow").unread.map((u) => [u.n, u.what]), [[2, "a value on the line below its key"]]);
  assert.deepEqual(ciFindings("steps:\n  - uses: a/b@v1\n---\nsteps:\n  - uses: c/d@v2\n", "workflow").unread.map((u) => [u.n, u.what]), [[3, "a document marker with a node after it, or a second document"]]);
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

test("ci hook: what HEAD already holds stays; a deleted file and an excepted one pass; text that is not UTF-8 and a symbolic link are refused", () => {
  const r = repo();
  // Committed past the hook: the old state the check leaves alone.
  r.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n" });
  assert.equal(r.commit("chore: old", "--no-verify").status, 0);
  r.stage({ [WF]: "on: push\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n      - run: make\n" });
  assert.equal(r.check("--hook").status, 0, "touching a file does not make its old lines new");
  git(["rm", "-q", "-f", WF], { cwd: r.dir });
  const deleted = r.check("--hook");
  assert.deepEqual([deleted.status, deleted.stderr], [0, ""], "a deleted workflow brings nothing, and nothing is said");
  r.stage({ ".ennyn/config.json": JSON.stringify({ security: { ci: { except: [".github/workflows/legacy.yml"] } } }) });
  assert.equal(r.commit("chore: except, past the hook", "--no-verify").status, 0);
  r.stage({ ".github/workflows/legacy.yml": "steps:\n  - uses: a/b@v1\n" });
  assert.equal(r.check("--hook").status, 0, "an excepted file is not read");
  const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("steps:\n  - uses: a/b@v1\n", "utf16le")]);
  r.stage({ [WF]: wide });
  const refused = r.check("--hook");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ci\.yml: this commit brings a file the check cannot read \(not UTF-8 text\)/);
  git(["rm", "-q", "-f", WF], { cwd: r.dir });
  symlinkSync("../../elsewhere.yml", join(r.dir, ".github", "workflows", "link.yml"));
  git(["add", "-A"], { cwd: r.dir });
  const link = r.check("--hook");
  assert.equal(link.status, 1);
  assert.match(link.stderr, /link\.yml: this commit brings a file the check cannot read \(a symbolic link\)/);
});

test("ci hook: a staged CI file whose name is not UTF-8 is refused by the hook and fails commit-check run by hand", () => {
  const r = repo();
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: r.dir, input: "steps:\n  - uses: a/b@v1\n", encoding: "utf8" }).stdout.trim();
  const name = Buffer.from([...Buffer.from(".github/workflows/"), 0xff, ...Buffer.from(".yml")]);
  assert.equal(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: r.dir, input: Buffer.concat([Buffer.from(`100644 ${hash}\t`), name, Buffer.from("\n")]) }).status, 0);
  const hook = r.check("--hook");
  assert.equal(hook.status, 1);
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

test("ci hook: a file past 16 MB is refused, and a name the index holds decomposed is read as written", () => {
  const r = repo();
  r.stage({ [WF]: `steps:\n  - uses: a/b@v1\n${"#".repeat(16 * 1024 * 1024)}\n` });
  assert.match(r.check("--hook").stderr, /ci\.yml: this commit brings a file the check cannot read \(past 16 MB\)/);
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
  // A merge key is refused: GitHub reads `<<` as a key named so, never merges. So is a value on the line after its key.
  assert.deepEqual(ciFindings("base: &b\n  uses: a/b@v1\nsteps:\n  - <<: *b\n", "workflow").unread.map((u) => u.n), [4]);
  assert.deepEqual(ciFindings("on: push\nd: &d\n  permissions: {}\njobs:\n  a:\n    <<: *d\n    runs-on: x\n", "workflow").unread.map((u) => u.n), [6]);
  assert.deepEqual(ciFindings(`${T}jobs:\n  a:\n    steps:\n      - with:\n          { ref: "${head}" }\n`, "workflow").unread.map((u) => u.n), [5]);
  // A job named like an input map is a job; a matrix value named uses is no step.
  assert.deepEqual(usesOf("jobs:\n  secrets:\n    uses: o/r/.github/workflows/x.yml@main\n"), [[3, "o/r/.github/workflows/x.yml@main", false]]);
  assert.deepEqual(usesOf("jobs:\n  a:\n    strategy:\n      matrix:\n        uses: [a, b]\n"), []);
  // What the reading cannot follow, and input built to make it slow, ends in a refusal, at once.
  const started = performance.now();
  assert.ok(ciFindings(`${"- ".repeat(50000)}x\n`, "workflow").unread.length);
  let laughs = "a: &a [x,x,x,x,x,x,x,x,x,x]\n";
  for (let k = 0; k < 9; k++) laughs += `b${k}: &b${k} [${Array(10).fill(k ? `*b${k - 1}` : "*a").join(",")}]\n`;
  assert.ok(ciFindings(laughs, "workflow").unread.length);
  for (const line of ["a" + " ".repeat(40000) + "b", 'x "'.repeat(80000), "a:".repeat(100000), "run: ${{ ".repeat(100000)]) ciFindings(`${line}\n`, "workflow");
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
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
  assert.match(tr.errors[0], /sembolik bağ/);
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
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  // A pattern in the config that does not compile: the message goes unchecked, the workflow's errors stand.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ commitMsg: { skipSubjects: ["("] } }) });
  git(["add", ".ennyn/config.json"], { cwd: r.dir });
  assert.equal(r.commit("chore: config", "--no-verify", ".ennyn/config.json").status, 0);
  const broken = r.check("--hook");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /ci\.yml: 1 new uses/);
  assert.match(broken.stderr, /this commit's message was not checked, nor its review\.forbidden lines \(.*\); security\.ci, security\.deps and security\.secrets ran/);
  assert.doesNotMatch(broken.stderr, /not its lines/, "three gates ran");
  // paths [] turns the check off.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ security: { ci: { paths: [] } } }) });
  git(["add", ".ennyn/config.json"], { cwd: r.dir });
  assert.equal(r.commit("chore: config", "--no-verify", ".ennyn/config.json").status, 0);
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
  // The key's refusal covers its value's line too: both are new.
  assert.deepEqual(ciIntroduced(after, before).unread.map((u) => u.n), [4, 5]);
});

test("ci round two: files that are large, many or not UTF-8 by name, and untouched, neither switch the check off nor fail it", async () => {
  // Reading stays under a few seconds on many steps that check out another repository, and many jobs.
  const started = performance.now();
  ciFindings(`jobs:\n  a:\n    steps:\n${"      - with: { repository: o/r }\n".repeat(20000)}`, "workflow");
  ciFindings(`on: push\njobs:\n${Array.from({ length: 20000 }, (_, k) => `  j${k}:\n    runs-on: x\n`).join("")}`, "workflow");
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
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
  const started = performance.now();
  const steps = Array.from({ length: 20000 }, () => "      - uses: ./a\n").join("");
  ciSet(new Map([[".github/workflows/w.yml", `on: push\npermissions: {}\njobs:\n  j:\n    steps:\n${steps}`], ["a/action.yml", `runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n      with:\n        repository: o/r\n`]]));
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
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
  const started = performance.now();
  // Under GitHub's 1 MiB limit, past which the file is refused whole.
  const pairs = Array.from({ length: 7000 }, (_, k) => `      - uses: actions/checkout@${SHA}\n        with: { repository: a/b, path: d${k} }\n      - uses: ./d${k}/x\n`).join("");
  const many = ciSet(new Map([[".github/workflows/w.yml", `on: push\npermissions: {}\njobs:\n  j:\n    steps:\n${pairs}`]]));
  assert.equal(many.findings.get(".github/workflows/w.yml")?.uses.filter((u) => !u.pinned).length, 7000);
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
});

test("ci reader: a workflow past GitHub's limit is refused whole, one at the limit is read", () => {
  // actions/runner src/Sdk/WorkflowParser/ParseOptions.cs: MaxFileSize, 1024 * 1024 characters of the text.
  assert.equal(MAX_TEXT, 1024 * 1024);
  const head = "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: a/b@v1\n#";
  const at = `${head}${"x".repeat(MAX_TEXT - head.length)}`;
  assert.equal(at.length, MAX_TEXT);
  assert.deepEqual(yamlRead(at).unread, []);
  assert.equal(ciFindings(at, "workflow").uses.length, 1);
  const past = yamlRead(`${at}x`);
  assert.deepEqual([past.entries.length, past.unread.map((u) => u.what)], [0, [`a file past ${MAX_TEXT} characters, more than GitHub reads`]]);
});

test("ci reader: every joiner and every run rule takes time linear in the text, on texts built to make one rescan", () => {
  // Growth, not a wall-clock bound, in CPU time, the best of three: sixteen times the text costs about sixteen times
  // the time if linear, 256 if quadratic. Round one of cycle 14 measured a 1 MB double-quoted run at 96.6 s (the
  // escaped-break test ran over the whole joined value on each line), a flow collection of 40k lines at 17 s, and a
  // line of `read … <<<` at 22-106 s.
  const head = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n";
  const make = {
    "a double quote over lines": (/** @type {number} */ n) => `${head}      - run: "a\n${"          x\n".repeat(n / 12)}          "\n`,
    "escaped line breaks": (/** @type {number} */ n) => `${head}      - run: "a\\\n${"          x\\\n".repeat(n / 12)}          "\n`,
    "a flow collection over lines": (/** @type {number} */ n) => `${head}      - with: {\n${"          a: b,\n".repeat(n / 16)}          z: y}\n        uses: a/b@v1\n`,
    "read <<< on one folded line": (/** @type {number} */ n) => `${head}      - run: x\n${"          read a <<< b\n".repeat(n / 24)}`,
    "for … in on one folded line": (/** @type {number} */ n) => `${head}      - run: x\n${"          for a in b c\n".repeat(n / 24)}`,
    "open quotes on one folded line": (/** @type {number} */ n) => `${head}      - run: x\n${"          a=\"b c\n".repeat(n / 16)}`,
    "spaces in one line": (/** @type {number} */ n) => `${head}      - run: x${" ".repeat(n)}y\n`,
    // Round two of cycle 14: a read before <<< (220 KB took 71 s), open expressions in assignments (a 1.02 MB line, 99 s),
    // function headers with no closing brace (549 KB, 95 s), continuation lines (40k lines, 4.7 s).
    "read words before <<<": (/** @type {number} */ n) => `${head}      - run: x${" read a b c".repeat(n / 11)} x= <<< y\n`,
    "open expressions in assignments": (/** @type {number} */ n) => `${head}      - run: x${" a=\${{".repeat(n / 6)}\n`,
    "function headers": (/** @type {number} */ n) => `${head}      - run: |\n${"          f() {\n".repeat(n / 16)}`,
    "continuation lines": (/** @type {number} */ n) => `${head}      - run: |\n${"          git fetch \\\n".repeat(n / 22)}          x\n`,
    "function headers, one brace at the end": (/** @type {number} */ n) => `${head}      - run: |\n${"          f() {\n".repeat(n / 16)}          git fetch $1 }\n`,
    "open expressions, one closed at the end": (/** @type {number} */ n) => `${head}      - run: x${" a=${{".repeat(n / 6)} }}\n`,
    "backtick continuations": (/** @type {number} */ n) => `${head}      - run: |\n${"          a `\n".repeat(n / 14)}          x\n`,
  };
  const best = (/** @type {string} */ text) => Math.min(...[0, 1, 2].map(() => {
    const t0 = process.cpuUsage();
    ciFindings(text, "workflow", { targeted: true });
    const { user, system } = process.cpuUsage(t0);
    return (user + system) / 1000;
  }));
  for (const [name, text] of Object.entries(make)) {
    const g = (best(text(512 * 1024)) + 5) / (best(text(32 * 1024)) + 5);
    assert.ok(g < 48, `${name}: sixteen times the text took ${g.toFixed(1)} times as long`);
  }
});

test("ci reader: nesting past 100 levels, a flow collection that does not close and a `read` inside a command are said", () => {
  // GitHub's MaxDepth is 50 (ParseOptions.cs): past 100 levels the reading stops there and refuses.
  let deep = "on: push\n";
  for (let k = 0; k < 120; k++) deep += `${" ".repeat(k)}a:\n`;
  assert.ok(yamlRead(deep).unread.some((u) => u.what === "levels nested past 100"));
  let forty = "on: push\n";
  for (let k = 0; k < 40; k++) forty += `${"  ".repeat(k)}a:\n`;
  assert.deepEqual(yamlRead(forty).unread, []);
  assert.deepEqual(yamlRead("a: [x,\nb: y\n").unread.map((u) => u.what), ["a flow collection that does not close before the next key"]);
  // `while read`, `if read`: the here-string taints its names wherever the read stands in its command.
  const run = (/** @type {string} */ line) => `on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - run: |\n          ${line}\n          git fetch origin "$R"\n`;
  for (const line of ['read R <<< "${{ github.head_ref }}"', 'if read -r R <<< "${{ github.head_ref }}"; then :; fi', 'while read R <<< "${{ github.head_ref }}"; do break; done']) assert.equal(ciFindings(run(line), "workflow").pwn.length, 1, line);
  assert.equal(ciFindings(run('read R <<< "main"'), "workflow").pwn.length, 0);
});

test("ci round two of cycle 14: what the reading refuses is known by the text it covers, so an edit inside it is new", () => {
  const T = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n";
  const intro = (/** @type {string} */ now, /** @type {string} */ before) => ciIntroduced(ciFindings(now, "workflow"), ciFindings(before, "workflow")).unread.map((u) => u.what);
  // A block header on the line below its key: the block under it is covered.
  assert.deepEqual(intro(`${T}      - run:\n          |\n          git fetch origin pull/1/head\n`, `${T}      - run:\n          |\n          echo hi\n`), ["a value on the line below its key"]);
  // An alias of a block scalar: the anchored block is covered.
  const alias = (/** @type {string} */ body) => `${T.replace("jobs:", `x: &s |\n  ${body}\njobs:`)}      - run: *s\n`;
  assert.equal(intro(alias("git fetch origin pull/1/head"), alias("echo hi")).length, 1);
  // A file past GitHub's limit: the whole file is covered.
  const big = (/** @type {string} */ x) => `${T}      - run: ${x}\n#${"x".repeat(MAX_TEXT)}`;
  assert.equal(intro(big("git fetch origin pull/1/head"), big("echo hi")).length, 1);
  // A second document: the rest of the file is covered.
  const two = (/** @type {string} */ x) => `${T}      - run: echo\n---\non: push\nx: y\nz: ${x}\n`;
  assert.equal(intro(two("b"), two("a")).length, 1);
  // The same refusal, untouched, is no new one.
  assert.deepEqual(intro(alias("echo hi"), alias("echo hi")), []);
});

test("ci round two of cycle 14: the reading takes block mappings and sequences, scalars and flow collections only as listed", () => {
  const T = "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n";
  const whats = (/** @type {string} */ text) => yamlRead(text).unread.map((u) => u.what);
  assert.deepEqual(whats(`--- {on: push}\n`), ["a document marker with a node after it, or a second document"]);
  assert.deepEqual(whats(`{on: push, jobs: {a: {steps: [{uses: a/b@v1}]}}}\n`), ["a document that is no block mapping"]);
  assert.deepEqual(whats(`%YAML 1.1\n---\non: push\n`), ["a directive (%)"]);
  assert.deepEqual(whats(`on: push\n...\non: pull_request_target\n`), ["text after the document's end (...)"]);
  assert.deepEqual(whats(`${T}      - run: >2\n          git fetch origin\n          pull/1/head\n`), ["a block scalar with an indentation indicator"]);
  assert.deepEqual(whats(`${T}      - &s {uses: a/b@v1}\n`), ["a tag or an anchor on a flow collection"]);
  assert.deepEqual(whats(`${T.replace("    steps:\n", "")}    steps: [!!map {uses: a/b@v1}]\n`), ["a flow collection this reading cannot follow (a tag or an anchor in a flow collection)"]);
  assert.deepEqual(whats(`x: &s a/b@v1\ny: &s c/d@v2\n`), ["&s, an anchor named twice"]);
  assert.deepEqual(whats(`${T}      - uses: !!map a/b@v1\n`), ["a tag this reading does not take (!!map)"]);
  assert.deepEqual(whats(`${T}\t- uses: a/b@v1\n`), ["a tab in the indentation"]);
  assert.deepEqual(whats(`jobs:\n  a:\n      runs-on: x\n    permissions: {}\n`), ["a line at a column its mapping or sequence does not use"]);
  assert.deepEqual(whats(`${T}      - <<: {uses: a/b@v1}\n`), ["a merge key (<<), which GitHub reads as a key named so"]);
  assert.deepEqual(whats(`${T}      - !!str\n        uses: a/b@v1\n`), ["properties with no node on their line"]);
  assert.deepEqual(whats(`${T.replace("    steps:\n", "")}    steps: &s [{uses: a/b@v1}]\n`), ["a tag or an anchor on a flow collection"]);
  assert.deepEqual(whats(`${T}      - with: !!str\n          ref: x\n`), ["a tag on a mapping or a sequence", "a line at a column its mapping or sequence does not use"]);
  assert.deepEqual(whats(`on: push\njobs: {a: {steps: [{run: echo}]}}\n`), []);
  assert.deepEqual(whats(`${T}      - uses: !!str a/b@v1\n      - uses: !<tag:yaml.org,2002:str> a/b@v1\n`), []);
});

test("ci round two of cycle 14: the leaf tests join every shell's continuation, skip git's own options and read Windows paths", () => {
  const T = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: windows-latest\n    steps:\n";
  const pwnOf = (/** @type {string} */ run) => ciFindings(`${T}      - run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`, "workflow").pwn.length;
  assert.equal(pwnOf("git fetch origin `\n  pull/1/head"), 1);
  assert.equal(pwnOf("git fetch origin ^\n  pull/1/head"), 1);
  assert.equal(pwnOf("git fetch origin \\\n  pull/1/head"), 1);
  assert.equal(pwnOf("git fetch origin\npull/1/head"), 0);
  // A name written to $GITHUB_ENV holds the pull request's ref in every later step.
  assert.equal(ciFindings(`${T}      - run: echo "R=\${{ github.head_ref }}" >> "$GITHUB_ENV"\n      - run: git fetch origin "$R"\n`, "workflow").pwn.length, 1);
  assert.equal(ciFindings(`${T}      - run: echo "R=main" >> "$GITHUB_ENV"\n      - run: git fetch origin "$R"\n`, "workflow").pwn.length, 0);
  // A quoted assignment is its whole quote, white space and all.
  assert.equal(pwnOf("R=\"x ${{ github.head_ref }}\"\ngit fetch origin \"$R\""), 1);
  const cloned = (/** @type {string} */ run, /** @type {string} */ path) => ciFindings(`on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - run: ${run}\n      - uses: ./${path}\n`, "workflow").uses.at(-1)?.pinned;
  assert.equal(cloned('git -c http.extraheader="AUTHORIZATION: basic x" clone https://github.com/o/r.git lib', "lib/act"), false);
  assert.equal(cloned("git -C . clone https://github.com/o/r.git lib", "lib/act"), false);
  assert.equal(cloned("git -C sub clone https://github.com/o/r.git lib", "sub/lib/act"), false);
  assert.equal(cloned("git -C sub clone https://github.com/o/r.git lib", "lib/act"), true);
  const checkout = (/** @type {string} */ path, /** @type {string} */ local) => ciFindings(`on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          repository: o/r\n          path: ${path}\n      - uses: ./${local}\n`, "workflow").uses.at(-1)?.pinned;
  assert.equal(checkout("${{ github.workspace }}\\lib", "lib/act"), false);
  assert.equal(checkout("lib\\sub", "lib/sub/act"), false);
});

test("ci escapes: an escape that names no character is a refused form, wherever it stands, and the file reads on; every other escape reads as before", () => {
  const BAD = ["\\x", "\\x4", "\\xZZ", "\\u", "\\u12", "\\uZZZZ", "\\U", "\\U0011", "\\UZZZZZZZZ", "\\U00110000", "\\UFFFFFFFF", "\\uD800", "\\uDBFF", "\\uDC00", "\\uDFFF", "\\U0000D800", "\\U0000DFFF", "\\uD83D\\uDE00", "\\U00110000\\x41"];
  const WHAT = "an escape that names no character";
  const after = "jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n";
  /** @type {[string, (e: string) => string, RegExp][]} */
  const PLACES = [
    ["a value", (e) => `on: push\nname: "${e}"\n`, /^an escape/],
    ["a key", (e) => `on: push\n"${e}": 1\n`, /^an escape/],
    ["a key with a mapping below", (e) => `on: push\n"${e}":\n  a: 1\n`, /^an escape/],
    ["an item", (e) => `on: push\nx:\n  - "${e}"\n`, /^an escape/],
    ["a value in a flow collection", (e) => `on: push\nx: ["${e}"]\n`, /^an escape/],
    ["a key in a flow collection", (e) => `on: push\nx: {"${e}": 1}\n`, /^a flow collection this reading cannot follow \(an escape/],
    ["a pair in a flow sequence", (e) => `on: push\nx: ["${e}": 1]\n`, /^a flow collection this reading cannot follow \(an escape/],
    ["a quote over lines", (e) => `on: push\nname: "a\n  ${e}"\n`, /^an escape/],
  ];
  for (const e of BAD) {
    for (const [name, make, what] of PLACES) {
      const f = ciFindings(make(e) + after, "workflow");
      assert.ok(f.unread.some((u) => what.test(u.what) && u.what.includes(WHAT)), `${e} in ${name}: ${JSON.stringify(f.unread.map((u) => u.what))}`);
      assert.deepEqual(f.uses.map((u) => u.value), ["a/b@v1"], `${e} in ${name}: the lines after it are read`);
    }
    // Where a line is only looked at, to see whether it is a key: no throw, and the form around it is refused.
    for (const text of [`on: push\nname: a\n  "${e}": 1\n`, `on: push\nname: "a\n"${e}": 1\n`, `on: [push,\n"${e}": 1\n`, `on: push\nname:\n  "${e}": 1\n`]) assert.ok(yamlRead(text).unread.length, JSON.stringify(text));
    // Not a double-quoted scalar: no escape to read.
    for (const text of [`on: push\nname: '${e}'\n`, `on: push\nname: ${e}\n`, `on: push\nname: |\n  "${e}"\n`, `on: push\n# "${e}"\n`]) assert.deepEqual(yamlRead(text).unread, [], JSON.stringify(text));
  }
  // A step whose quoted value holds one is no pinned step, a local path neither.
  assert.deepEqual(usesOf(`steps:\n  - uses: "a/b@${SHA}\\U00110000"\n`), [[2, `a/b@${SHA}\\U00110000`, false]]);
  assert.deepEqual(usesOf('steps:\n  - uses: "./x\\U00110000"\n'), [[2, "./x\\U00110000", false]]);
  // What stands below a key that holds one is read as its own, and refused once.
  const below = ciFindings('on: push\njobs:\n  "\\U00110000":\n    runs-on: x\n    steps:\n      - uses: a/b@v1\n', "workflow");
  assert.deepEqual([below.unread.map((u) => u.n), below.uses.map((u) => u.value), below.unpermitted], [[3], ["a/b@v1"], [{ job: "\\U00110000", n: 3 }]]);
  /** @type {[string, string][]} */
  const GOOD = [["\\x41", "A"], ["\\xFF", "\u00ff"], ["\\u0041", "A"], ["\\uD7FF", "\ud7ff"], ["\\uE000", "\ue000"], ["\\uFFFF", "\uffff"], ["\\U00000041", "A"], ["\\U0000D7FF", "\ud7ff"], ["\\U0000E000", "\ue000"], ["\\U0001F600", "\u{1f600}"], ["\\U0010FFFF", "\u{10ffff}"], ["\\n", "\n"], ["\\t", "\t"], ["\\\\", "\\"], ['\\"', '"'], ["\\/", "/"], ["\\ ", " "], ["\\0", "\0"], ["\\N", "\u0085"], ["\\L", "\u2028"], ["\\P", "\u2029"], ["\\\\x4", "\\x4"], ["\\\\U00110000", "\\U00110000"]];
  for (const [e, value] of GOOD) {
    const r = yamlRead(`on: push\nname: "${e}"\n"k${e}": 1\n`);
    assert.deepEqual(r.unread, [], e);
    assert.deepEqual(r.entries.slice(1).map((x) => [x.key, x.value]), [["name", value], [`k${value}`, "1"]], e);
  }
});

test("ci files: a decoy beside a refused workflow takes nothing from it: staged, by hand, at HEAD, as a callee and in doctor", async () => {
  const PWN = `on: pull_request_target\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
  const three = [/pwn\.yml: 1 new uses/, /pwn\.yml: a pull_request_target workflow checks out/, /pwn\.yml: neither the workflow nor these jobs set permissions/];
  const stands = (/** @type {{ status: number | null, stderr: string }} */ r) => {
    assert.equal(r.status, 1, r.stderr);
    for (const re of three) assert.match(r.stderr, re);
    assert.doesNotMatch(r.stderr, /security\.ci was not checked/);
  };
  const r = repo();
  r.stage({ ".github/workflows/pwn.yml": PWN });
  stands(r.check("--hook"));
  r.stage({ ".github/workflows/decoy.yml": 'on: push\npermissions: {}\nname: "\\U00110000"\n' });
  const hook = r.check("--hook");
  stands(hook);
  assert.match(hook.stderr, /decoy\.yml: YAML the check cannot follow.*line 3 \(an escape that names no character/);
  stands(r.check());
  // The same decoy held at HEAD and read as context: nothing new in it, and the rest is judged.
  assert.equal(r.commit("chore: past the hook", "--no-verify").status, 0);
  r.stage({ ".github/workflows/pwn.yml": `${PWN}      - run: make\n` });
  assert.equal(r.check("--hook").status, 0, "nothing the commit brings is new");
  r.stage({ ".github/workflows/second.yml": PWN });
  const second = r.check("--hook");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /second\.yml: a pull_request_target workflow checks out/);
  assert.doesNotMatch(second.stderr, /decoy\.yml/);
  // Doctor reports on what the index holds, the decoy among it.
  const d = await checkSetup({ cwd: r.dir, env: process.env });
  assert.deepEqual(d.items.filter((i) => i.key.startsWith("doctor.ci")).map((i) => i.key), ["doctor.ciUnpinned", "doctor.ciPwn", "doctor.ciPermissions", "doctor.ciForms"]);
  // A callee that holds one is read on: what it checks out still reaches its caller's file.
  const c = repo();
  c.stage({ ".github/workflows/pr.yml": "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n", ".github/actions/x/action.yml": 'name: "\\x4"\nruns:\n  using: composite\n  steps:\n    - run: git fetch origin pull/1/head\n      shell: bash\n' });
  const callee = c.check("--hook");
  assert.equal(callee.status, 1);
  assert.match(callee.stderr, /action\.yml: a pull_request_target workflow checks out.*reached from \.github\/workflows\/pr\.yml/);
  assert.match(callee.stderr, /action\.yml: YAML the check cannot follow.*line 1/);
});

/** Runs `body` with `String.fromCodePoint` throwing for U+E000: `"\uE000"` then stands for a text no reading gets through. @param {() => void} body */
function stopping(body) {
  const real = String.fromCodePoint;
  String.fromCodePoint = (/** @type {number[]} */ ...c) => {
    if (c[0] === 0xe000) throw new RangeError("stopped here");
    return real(...c);
  };
  try {
    body();
  } finally {
    String.fromCodePoint = real;
  }
}
const STOPS = 'on: push\nname: "\\uE000"\n';
const PWN_TEXT = `on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;

test("ci files: a reading that throws is held to its file: named, refused when the commit brings the text, said when HEAD holds it, and the others stand", () => {
  assert.equal(ciFindings(STOPS, "workflow").unread.length, 0, "with no fault the marker is an ordinary character");
  const key = (/** @type {string} */ p) => Buffer.from(p);
  stopping(() => {
    assert.throws(() => ciFindings(STOPS, "workflow"), /stopped here/);
    // ciSet: the file is one form, known by its whole text, and its callers name it.
    const set = ciSet(new Map([["a.yml", STOPS], ["b.yml", PWN_TEXT]]));
    assert.deepEqual(set.findings.get("a.yml")?.unread, [{ n: 1, what: "a file this reading stopped on (stopped here)", text: STOPS }]);
    assert.equal(set.findings.get("a.yml")?.stopped, true);
    assert.equal(set.findings.get("b.yml")?.pwn.length, 1);
    const pr = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./tools/x\n";
    const reached = ciSet(new Map([[".github/workflows/p.yml", pr], ["tools/x/action.yml", STOPS]]));
    assert.deepEqual(reached.missing, [{ path: ".github/workflows/p.yml", n: 7, callee: "tools/x" }]);
    assert.equal(reached.findings.get("tools/x/action.yml")?.unread.length, 1, "one form, stopped alone and reached");
    // Brought by the commit: refused, whatever HEAD held.
    for (const head of [null, key("on: push\n")]) {
      const out = ciMessages(new Map([[".github/workflows/a.yml", { staged: key(STOPS), head }], [".github/workflows/b.yml", { staged: key(PWN_TEXT), head: null }]]), "en");
      assert.deepEqual(out.errors.map((e) => e.split(":")[0]), [".github/workflows/a.yml", ".github/workflows/b.yml"], JSON.stringify(out));
      assert.match(out.errors[0], /YAML the check cannot follow.*line 1 \(a file this reading stopped on \(stopped here\)\)/);
      assert.match(out.errors[1], /pull_request_target workflow checks out/);
      assert.deepEqual(out.warnings, []);
    }
    // Held at HEAD: nothing new, and named.
    const held = ciMessages(new Map([[".github/workflows/a.yml", { staged: key(STOPS), head: key(STOPS) }], [".github/workflows/b.yml", { staged: key(PWN_TEXT), head: null }]]), "en");
    assert.equal(held.errors.length, 1);
    assert.match(held.errors[0], /b\.yml: a pull_request_target/);
    assert.deepEqual(held.warnings, [".github/workflows/a.yml: not checked (its reading stopped); its uses, triggers and permissions are not known"]);
    assert.match(ciMessages(new Map([["a.yml", { staged: key(STOPS), head: key(STOPS) }]]), "tr").warnings[0], /okuma yarıda kaldı/);
    // Known by its whole text: an edit of a file HEAD holds is new.
    const edited = ciMessages(new Map([[".github/workflows/a.yml", { staged: key(`${STOPS}# more\n`), head: key(STOPS) }]]), "en");
    assert.match(edited.errors[0], /a file this reading stopped on/);
    // A HEAD version that stops is no version: everything staged is new.
    const before = ciMessages(new Map([[".github/workflows/b.yml", { staged: key(PWN_TEXT), head: key(`${PWN_TEXT}"\\uE000": 1\n`) }]]), "en");
    assert.equal(before.errors.length, 1);
    assert.match(before.errors[0], /pull_request_target workflow checks out/);
    // ciCallees: a file that stops calls nothing; the others' callees stand.
    assert.deepEqual(ciCallees(new Map([["a.yml", { staged: key(STOPS), head: null }], [".github/workflows/p.yml", { staged: key(pr), head: key(STOPS) }]])), ["tools/x/action.yml", "tools/x/action.yaml"]);
  });
});

test("ci hook: a reading that throws, in the real hook and in doctor: the other files' refusals stand and the file is named", () => {
  const r = repo();
  r.stage({ ".github/workflows/pwn.yml": PWN_TEXT.replace(`@${SHA}`, "@v4"), ".github/workflows/stops.yml": STOPS });
  const fault = `data:text/javascript,const real=String.fromCodePoint;String.fromCodePoint=(...c)=>{if(c[0]===0xe000)throw new RangeError("stopped here");return real(...c)};`;
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const hook = spawnSync(process.execPath, ["--import", fault, CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /pwn\.yml: 1 new uses/);
  assert.match(hook.stderr, /pwn\.yml: a pull_request_target workflow checks out/);
  assert.match(hook.stderr, /stops\.yml: YAML the check cannot follow.*a file this reading stopped on \(stopped here\)/);
  assert.doesNotMatch(hook.stderr, /was not checked/);
  // Committed past the hook, and asked of doctor: the whole report, the file among the forms.
  assert.equal(r.commit("chore: past the hook", "--no-verify").status, 0);
  const doctor = spawnSync(process.execPath, ["--import", fault, CLI, "doctor"], { cwd: r.dir, encoding: "utf8" });
  assert.doesNotMatch(doctor.stderr, /ennyn doctor: /);
  assert.match(doctor.stdout, /CI files: .*stops\.yml.*hold YAML the check cannot follow/);
  assert.match(doctor.stdout, /CI files: .*pwn\.yml.*check out the pull request's code/);
});

test("ci hook: text that is not UTF-8 is refused when the commit brings it, said when HEAD holds the same bytes, and stops nothing beside it", () => {
  const latin = Buffer.from("on: pull_request_target\n# caf\xe9\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n", "latin1");
  const key = /ci\.yml: this commit brings a file the check cannot read \(not UTF-8 text\)/;
  const r = repo();
  r.stage({ [WF]: latin, ".github/workflows/b.yml": PWN_TEXT });
  const brought = r.check("--hook");
  assert.equal(brought.status, 1);
  assert.match(brought.stderr, key);
  assert.match(brought.stderr, /b\.yml: a pull_request_target workflow checks out/);
  assert.equal(r.check().status, 1, "by hand too");
  assert.equal(r.commit("chore: past the hook", "--no-verify").status, 0);
  r.stage({ ".github/workflows/c.yml": PINNED });
  const held = r.check("--hook");
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stderr, /ci\.yml: not checked \(not UTF-8 text\)/);
  // An edit of it brings it again; made UTF-8 it is read.
  r.stage({ [WF]: Buffer.concat([latin, Buffer.from("# more\n")]) });
  const edited = r.check("--hook");
  assert.equal(edited.status, 1, "on its own, nothing else refused");
  assert.match(edited.stderr, key);
  r.stage({ [WF]: PINNED });
  assert.equal(r.check("--hook").status, 0);
  // A deleted file brings nothing.
  assert.deepEqual(ciMessages(new Map([["a.yml", { staged: null, head: latin }]]), "en"), { errors: [], warnings: [] });
});

/** Staged with no file on disk, the name as given: [name, text][]. @param {string} dir @param {[string | Buffer, string | Buffer][]} entries */
function stageNames(dir, entries) {
  const lines = entries.map(([name, text]) => {
    const oid = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: text, encoding: "utf8" }).stdout.trim();
    return Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from(name), Buffer.from([0])]);
  });
  const r = spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: Buffer.concat(lines), maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, String(r.stderr));
}
/** Past what one argument can hold, on macOS and on Linux. */
const PAST_ARGV = "z".repeat(1100 * 1024);
const REFUSED_LOCK = JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/a": { version: "1.0.0", resolved: "https://evil.example/a/-/a-1.0.0.tgz", integrity: "sha512-AAAA" } } });
const BYTE_NAME = (/** @type {string} */ head, /** @type {string} */ tail) => Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]);

test("gate failure: a name past the argument limit refuses the commit, naming the gate, where the commit brings that gate's file; by hand it throws", () => {
  const offline = { security: { deps: { online: false, advisories: "" } } };
  /** @type {[string, string, Record<string, unknown>, RegExp][]} */
  const GATES = [
    ["security.ci", `${PAST_ARGV}/action.yml`, {}, /security\.ci was not checked, so this commit is refused/],
    ["security.deps", `${PAST_ARGV}/package-lock.json`, offline, /security\.deps was not checked, so this commit is refused/],
    ["review.forbidden", `${PAST_ARGV}.txt`, { review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] } }, /review\.forbidden was not checked, so this commit is refused/],
  ];
  for (const [gate, name, config, said] of GATES) {
    const r = repo();
    r.stage({ ".ennyn/config.json": JSON.stringify(config), "ok.txt": "x\n" });
    stageNames(r.dir, [[name, "{}\n"]]);
    const hook = r.check("--hook");
    assert.equal(hook.status, 1, `${gate}: ${hook.stderr.slice(0, 300)}`);
    assert.match(hook.stderr, said, gate);
    assert.equal(r.check().status, 1, gate);
  }
  // A name no gate reads costs nothing.
  const r = repo();
  stageNames(r.dir, [[`${PAST_ARGV}.txt`, "x\n"]]);
  const none = r.check("--hook");
  assert.equal(none.status, 0, none.stderr.slice(0, 300));
});

test("gate failure: names that only add up past the limit are read in chunks: an honest large commit is judged, not refused", () => {
  const r = repo();
  r.stage({ ".github/workflows/pwn.yml": PWN_TEXT, ".ennyn/config.json": JSON.stringify({ review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] } }) });
  const seg = "b".repeat(200);
  stageNames(r.dir, Array.from({ length: 500 }, (_, i) => /** @type {[string, string]} */ ([`${i}/${Array(11).fill(seg).join("/")}/action.yml`, i === 499 ? "name: x\nNEEDLE: 1\n" : "name: x\n"])));
  const hook = r.check("--hook");
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /pwn\.yml: a pull_request_target workflow checks out/);
  assert.match(hook.stderr, /adds "NEEDLE"/);
  assert.doesNotMatch(hook.stderr, /was not checked/);
});

test("gate failure: staged names past 64 MB are read, and the gates judge them", () => {
  const r = repo();
  // A package.json lists the whole index, which holds them too.
  r.stage({ ".ennyn/config.json": JSON.stringify({ security: { deps: { online: false, advisories: "" } } }), ".github/workflows/pwn.yml": PWN_TEXT, "package.json": '{"name":"x"}\n', "package-lock.json": '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n' });
  stageNames(r.dir, Array.from({ length: 1100 }, (_, i) => /** @type {[string, string]} */ ([`${String(i).padStart(5, "0")}${"y".repeat(61 * 1024)}`, "x\n"])));
  const hook = r.check("--hook");
  assert.equal(hook.status, 1, hook.stderr.slice(0, 300));
  assert.match(hook.stderr, /pwn\.yml: a pull_request_target workflow checks out/);
  assert.doesNotMatch(hook.stderr, /was not checked/);
});

test("ci callees: one candidate that cannot be read costs only itself: the round reads on, and it is named", () => {
  const CALLEE = "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/1/head\n      shell: bash\n";
  const CALLER = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./tools/x\n";
  const neighbour = (/** @type {string} */ uses) => `on: push\npermissions: {}\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: ${uses}\n`;
  /** @type {[string, Record<string, string>][]} */
  const CASES = [
    ["a NUL in a neighbour", { ".github/workflows/p.yml": CALLER, ".github/workflows/d.yml": neighbour('"./a\\0b"') }],
    ["a NUL in the same file", { ".github/workflows/p.yml": `${CALLER}      - uses: "./a\\0b"\n` }],
    ["a value no argument holds", { ".github/workflows/p.yml": CALLER, ".github/workflows/d.yml": neighbour(`./${"a".repeat(900000)}`) }],
  ];
  for (const [name, files] of CASES) {
    const r = repo();
    r.stage({ "tools/x/action.yml": CALLEE });
    assert.equal(r.commit("chore: held", "--no-verify").status, 0);
    r.stage(files);
    const hook = r.check("--hook");
    assert.equal(hook.status, 1, name);
    assert.match(hook.stderr, /tools\/x\/action\.yml: a pull_request_target workflow checks out.*reached from/, name);
    assert.match(hook.stderr, /security\.ci could not read the local callees/, name);
    assert.equal(r.check().status, 1, `${name}, by hand`);
  }
  // Alone, a candidate that names no file git could hold is named and refuses nothing.
  const r = repo();
  r.stage({ ".github/workflows/d.yml": neighbour('"./a\\0b"') });
  const alone = r.check("--hook");
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stderr, /security\.ci could not read the local callees/);
});

test("ci files: a symbolic link or a file past 16 MB the commit brings is refused, the same at HEAD is said, a submodule stays said", () => {
  const big = `steps:\n  - uses: a/b@v1\n${"#".repeat(16 * 1024 * 1024)}\n`;
  const new_ = /x\.yml: this commit brings a file the check cannot read \(/;
  const link = repo();
  mkdirSync(join(link.dir, ".github", "workflows"), { recursive: true });
  symlinkSync("../../elsewhere.txt", join(link.dir, ".github", "workflows", "x.yml"));
  link.stage({ "elsewhere.txt": "on: pull_request_target\n" });
  const brought = link.check("--hook");
  assert.equal(brought.status, 1, brought.stderr);
  assert.match(brought.stderr, new_);
  assert.match(brought.stderr, /a symbolic link/);
  assert.equal(link.check().status, 1, "by hand too");
  assert.equal(link.commit("chore: past the hook", "--no-verify").status, 0);
  link.stage({ ".github/workflows/c.yml": PINNED });
  const held = link.check("--hook");
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stderr, /x\.yml: not checked \(a symbolic link\)/);
  // Another target is another file.
  rmSync(join(link.dir, ".github", "workflows", "x.yml"));
  symlinkSync("../../other.txt", join(link.dir, ".github", "workflows", "x.yml"));
  link.stage({ "other.txt": "on: pull_request_target\n" });
  assert.match(link.check("--hook").stderr, new_);
  const large = repo();
  large.stage({ ".github/workflows/x.yml": big });
  const past = large.check("--hook");
  assert.equal(past.status, 1);
  assert.match(past.stderr, new_);
  assert.match(past.stderr, /past 16 MB/);
  assert.equal(large.check().status, 1, "by hand too");
  assert.equal(large.commit("chore: past the hook", "--no-verify").status, 0);
  large.stage({ ".github/workflows/c.yml": PINNED });
  const stays = large.check("--hook");
  assert.equal(stays.status, 0, stays.stderr);
  assert.match(stays.stderr, /x\.yml: not checked \(past 16 MB\)/);
  // A file made a link, with the same bytes as its old text: brought.
  const made = repo();
  made.stage({ ".github/workflows/x.yml": "../../y\n" });
  assert.equal(made.commit("chore: a file", "--no-verify").status, 0);
  rmSync(join(made.dir, ".github", "workflows", "x.yml"));
  symlinkSync("../../y\n", join(made.dir, ".github", "workflows", "x.yml"));
  git(["add", "-A"], { cwd: made.dir });
  assert.equal(made.check("--hook").status, 1);
  // A link or a submodule only intended to add (`git add -N`): the commit does not carry it, so it is not refused.
  const intent = repo();
  intent.stage({ ".github/workflows/c.yml": PINNED });
  mkdirSync(join(intent.dir, ".github", "workflows"), { recursive: true });
  symlinkSync("../../elsewhere.txt", join(intent.dir, ".github", "workflows", "x.yml"));
  mkdirSync(join(intent.dir, ".github", "workflows", "s.yml"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: join(intent.dir, ".github", "workflows", "s.yml") }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "s"], { cwd: join(intent.dir, ".github", "workflows", "s.yml") }).status, 0);
  git(["add", "-N", ".github/workflows/x.yml", ".github/workflows/s.yml"], { cwd: intent.dir });
  const listed = git(["ls-files", "-s", ".github/workflows"], { cwd: intent.dir });
  assert.match(listed, /^120000 \S+ 0\t\.github\/workflows\/x\.yml$/m);
  assert.match(listed, /^160000 \S+ 0\t\.github\/workflows\/s\.yml$/m);
  // Read as no version at all: no code, no object.
  assert.deepEqual([...stagedVersions(intent.dir, [".github/workflows/x.yml", ".github/workflows/s.yml"]).values()], [{ staged: null, head: null }, { staged: null, head: null }]);
  const left = intent.check("--hook");
  assert.equal(left.status, 0, left.stderr);
  assert.doesNotMatch(left.stderr, /this commit brings/);
  // Over an empty file HEAD holds (the same object, another kind), git lists it deleted: no version, nothing brought.
  const over = repo();
  over.stage({ ".github/workflows/e.yml": "" });
  assert.equal(over.commit("chore: an empty workflow", "--no-verify").status, 0);
  git(["rm", "-q", "--cached", ".github/workflows/e.yml"], { cwd: over.dir });
  rmSync(join(over.dir, ".github", "workflows", "e.yml"));
  symlinkSync("../../elsewhere.txt", join(over.dir, ".github", "workflows", "e.yml"));
  git(["add", "-N", ".github/workflows/e.yml"], { cwd: over.dir });
  assert.equal(stagedVersions(over.dir, [".github/workflows/e.yml"]).get(".github/workflows/e.yml")?.unread, undefined);
  const gone = over.check("--hook");
  assert.equal(gone.status, 0, gone.stderr);
  assert.doesNotMatch(gone.stderr, /this commit brings/);
  // A submodule's entry: said.
  const sub = repo();
  assert.equal(spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: sub.dir, input: `160000 ${"b".repeat(40)}\t.github/workflows/s.yml\0` }).status, 0);
  const said = sub.check("--hook");
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stderr, /s\.yml: not checked \(a submodule\)/);
});

test("names: a staged name that is not UTF-8 under a gate's paths is refused, and a valid name that reads the same is still judged", () => {
  const needle = { review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] }, security: { deps: { online: false, advisories: "" } } };
  /** @type {[string, Buffer, RegExp][]} */
  const ALONE = [
    ["security.ci", BYTE_NAME(".github/workflows/p", ".yml"), /security\.ci was not checked in 1 staged path\(s\) whose names are not UTF-8/],
    ["security.deps", BYTE_NAME("p", "/package-lock.json"), /security\.deps was not checked in 1 staged path\(s\) whose names are not UTF-8/],
    ["review.forbidden", BYTE_NAME("p", ".txt"), /review\.forbidden was not checked in 1 staged path\(s\) whose names are not UTF-8/],
  ];
  for (const [gate, name, said] of ALONE) {
    const r = repo();
    r.stage({ ".ennyn/config.json": JSON.stringify(gate === "review.forbidden" ? needle : { security: { deps: { online: false, advisories: "" } } }) });
    stageNames(r.dir, [[name, "{}\n"]]);
    const hook = r.check("--hook");
    assert.equal(hook.status, 1, `${gate}: ${hook.stderr}`);
    assert.match(hook.stderr, said, gate);
  }
  // A name outside every gate's paths: refused by none.
  const none = repo();
  stageNames(none.dir, [[BYTE_NAME("p", ".txt"), "x\n"]]);
  assert.equal(none.check("--hook").status, 0);
  // The valid name that spells U+FFFD itself, beside a name that reads the same: judged, in each gate.
  const ci = repo();
  ci.stage({ ".github/workflows/p\ufffd.yml": PWN_TEXT });
  stageNames(ci.dir, [[BYTE_NAME(".github/workflows/p", ".yml"), "on: push\n"]]);
  assert.match(ci.check("--hook").stderr, /p\ufffd\.yml: a pull_request_target workflow checks out/);
  const deps = repo();
  deps.stage({ ".ennyn/config.json": JSON.stringify(needle), "p\ufffd/package-lock.json": REFUSED_LOCK });
  stageNames(deps.dir, [[BYTE_NAME("p", "/package-lock.json"), "{}\n"]]);
  assert.match(deps.check("--hook").stderr, /p\ufffd\/package-lock\.json: 1 new entries come from a source/);
  const forbidden = repo();
  forbidden.stage({ ".ennyn/config.json": JSON.stringify(needle), "p\ufffd.txt": "NEEDLE\n" });
  stageNames(forbidden.dir, [[BYTE_NAME("p", ".txt"), "x\n"]]);
  assert.match(forbidden.check("--hook").stderr, /p\ufffd\.txt:1 adds "NEEDLE"/);
  // The secret scan reads each by its own object.
  const secrets = repo();
  secrets.stage({ "p\ufffd.txt": `token = ${TOKENS.npm}\n` });
  stageNames(secrets.dir, [[BYTE_NAME("p", ".txt"), "x\n"]]);
  assert.match(secrets.check("--hook").stderr, /p\ufffd\.txt:1 \(npm-token/);
});

test("ci files: a callee whose reading stops only when reached is refused when the commit brings it, whichever mode reads it", () => {
  const CALLER = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./tools/x\n";
  const CALLEE = "runs:\n  using: composite\n  steps:\n    - run: git fetch origin STOPHERE\n      shell: bash\n";
  const stopsWhenReached = (/** @type {() => void} */ body) => {
    const real = String.prototype.matchAll;
    // Only the rules of a reached file ask this of a run's text.
    String.prototype.matchAll = function (/** @type {any} */ re) {
      if (this.includes("STOPHERE")) throw new RangeError("stopped here");
      return real.call(this, re);
    };
    try {
      body();
    } finally {
      String.prototype.matchAll = real;
    }
  };
  stopsWhenReached(() => {
    assert.deepEqual(ciFindings(CALLEE, "action").unread, [], "alone it reads");
    const key = (/** @type {string} */ p) => Buffer.from(p);
    const files = (/** @type {Buffer | null} */ head) => new Map([[".github/workflows/p.yml", { staged: key(CALLER), head: null }], ["tools/x/action.yml", { staged: key(CALLEE), head }]]);
    const brought = ciMessages(files(null), "en");
    assert.equal(brought.errors.length, 1, JSON.stringify(brought));
    assert.match(brought.errors[0], /tools\/x\/action\.yml: YAML the check cannot follow.*a file this reading stopped on \(stopped here\)/);
    assert.match(brought.warnings[0], /p\.yml: a pull_request_target workflow reaches tools\/x/);
    const held = ciMessages(files(key(CALLEE)), "en");
    assert.deepEqual(held.errors, [], JSON.stringify(held));
    assert.ok(held.warnings.some((w) => /reaches tools\/x/.test(w)), JSON.stringify(held));
    assert.ok(held.warnings.some((w) => /tools\/x\/action\.yml: not checked \(its reading stopped\)/.test(w)), JSON.stringify(held));
  });
});

test("ci reader: a shell function's name of any length reads: no regular expression is built from a file's text", () => {
  for (const n of [32, 40000, 500000]) {
    const name = "a".repeat(n);
    const text = `runs:\n  using: composite\n  steps:\n    - run: |\n        ${name}() {\n          git fetch "$1"\n        }\n        ${name} pull/1/head\n      shell: bash\n`;
    assert.equal(ciFindings(text, "action", { targeted: true }).pwn.length, 1, String(n));
    // Its definition alone is no call.
    assert.equal(ciFindings(text.replace(`${name} pull/1/head`, "true"), "action", { targeted: true }).pwn.length, 0, String(n));
    // On the line of its definition too, with white space in the parentheses.
    const same = `runs:\n  using: composite\n  steps:\n    - run: |\n        ${name} ( ) { git fetch "$1"; }\n      shell: bash\n`;
    assert.equal(ciFindings(same, "action", { targeted: true }).pwn.length, 0, String(n));
  }
  const line = (/** @type {string} */ text) => ciFindings(`runs:\n  using: composite\n  steps:\n    - run: |\n        f() {\n          git fetch "$1"\n        }\n        ${text}\n      shell: bash\n`, "action", { targeted: true }).pwn.length;
  assert.equal(line("f pull/1/head"), 1, "a call");
  assert.equal(line("f ( ) pull/1/head"), 0, "white space in the parentheses: its definition");
  assert.equal(line("f pull/1/head; f()"), 0, "its definition further on: as the line was read before");
});

test("ci set and doctor: a file whose aliases multiply to 190,000 uses reads through: no list is spread into a call", async () => {
  const many = (/** @type {string} */ use) => `a: &a\n${Array.from({ length: 1000 }, () => `  - uses: ${use}\n`).join("")}${Array.from({ length: 190 }, (_, i) => `b${i}: *a\n`).join("")}`;
  const caller = "on: pull_request_target\npermissions: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./tools/big\n";
  const set = ciSet(new Map([[".github/workflows/c.yml", caller], ["tools/big/action.yml", many("./y")]]));
  assert.ok(set.missing.length > 100000, "every call a reached file makes is walked");
  const r = repo();
  r.stage({ ".github/workflows/big.yml": `on: push\npermissions: {}\n${many("a/b@v1")}`, ".github/workflows/pwn.yml": PWN_TEXT });
  assert.equal(r.commit("chore: past the hook", "--no-verify").status, 0);
  const d = await checkSetup({ cwd: r.dir, env: process.env });
  assert.ok(d.items.some((i) => i.key === "doctor.ciUnpinned"));
  assert.ok(d.items.some((i) => i.key === "doctor.ciPwn"));
});

test("gate failure: the secret scan keeps to the same rule: a name no argument holds cannot hide a key, and many names do not turn it off", () => {
  const r = repo();
  const key = `-----BEGIN RSA PRIVATE KEY-----`;
  stageNames(r.dir, [[`${PAST_ARGV}.pem`, `${key}\n`]]);
  const hook = r.check("--hook");
  assert.equal(hook.status, 1, hook.stderr.slice(0, 300));
  assert.match(hook.stderr, /security\.secrets was not checked, so this commit is refused/);
  // Names that fit git's 64 MiB as a list and not with `diff --raw`'s hundred bytes a name: the token beside them is found.
  const many = repo();
  stageNames(many.dir, [...Array.from({ length: 1095 }, (_, i) => /** @type {[string, string]} */ ([`${String(i).padStart(5, "0")}${"n".repeat(61275)}`, "x\n"])), ["secret.txt", `token = ${TOKENS.npm}\n`]]);
  const found = many.check("--hook");
  assert.equal(found.status, 1, found.stderr.slice(0, 300));
  assert.doesNotMatch(found.stderr, /was not checked/);
  assert.match(found.stderr, /secret\.txt:1 \(npm-token/);
});

test("gate failure: a throw of the forbidden scan refuses a commit it reads, and a pattern the message check cannot compile still passes", () => {
  const r = repo();
  r.stage({ ".ennyn/config.json": JSON.stringify({ review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] } }), "a.txt": "é\n" });
  const fault = `data:text/javascript,const real=String.prototype.normalize;String.prototype.normalize=function(f){if(String(this).includes("é"))throw new RangeError("stopped here");return real.call(this,f)};`;
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const hook = spawnSync(process.execPath, ["--import", fault, CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /review\.forbidden was not checked, so this commit is refused: .*\(stopped here\)/);
  r.stage({ ".ennyn/config.json": JSON.stringify({ commitMsg: { skipSubjects: ["("] } }) });
  assert.equal(r.commit("chore: config", "--no-verify", ".ennyn/config.json").status, 0);
  assert.equal(r.check("--hook").status, 0);
});

test("gate failure: a throw of the deps check refuses a commit that brings a lock, naming the gate", () => {
  const r = repo();
  r.stage({ ".ennyn/config.json": JSON.stringify({ security: { deps: { online: false, advisories: "" } } }), "package-lock.json": REFUSED_LOCK });
  // Stands for a throw of the check's own code: no input is known to make one.
  const fault = `data:text/javascript,const real=Object.entries;Object.entries=function(o){if(o&&o["node_modules/a"])throw new RangeError("stopped here");return real(o)};`;
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const hook = spawnSync(process.execPath, ["--import", fault, CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /security\.deps was not checked, so this commit is refused: .*\(stopped here\)/);
});

/** The environment of a run with a git on PATH that does `script` first, then the real one. @param {string} script */
function fakeGit(script) {
  const bin = mkdtempSync(join(tmpdir(), "en-ci-git-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
}

test("ci callees: a batch that fails is read name by name: what fails alone is named, every other callee stands", () => {
  const r = repo();
  r.stage({ "tools/x/action.yml": "runs:\n  using: composite\n  steps:\n    - run: git fetch origin pull/1/head\n      shell: bash\n" });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  r.stage({ ".github/workflows/p.yml": "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./FAILME\n      - uses: ./tools/x\n" });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const env = fakeGit('case " $* " in *FAILME*) echo "fatal: injected" >&2; exit 128 ;; esac');
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /tools\/x\/action\.yml: a pull_request_target workflow checks out/);
  assert.match(hook.stderr, /could not read the local callees FAILME\/action\.yml, FAILME\/action\.yaml \(fatal: injected\)/);
});

test("gate failure: a list of changes past even its larger buffer refuses the commit, naming the secret scan", () => {
  const r = repo();
  r.stage({ "a.txt": "x\n" });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const env = fakeGit(`case " $* " in *" --raw "*) head -c ${256 * 1024 * 1024 + 1024} /dev/zero; exit 0 ;; esac`);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /security\.secrets was not checked, so this commit is refused/);
  // A commit that only deletes brings nothing that read could lose.
  const gone = repo();
  gone.stage({ "a.txt": "x\n" });
  assert.equal(gone.commit("chore: held", "--no-verify").status, 0);
  git(["rm", "-q", "a.txt"], { cwd: gone.dir });
  writeFileSync(join(gone.dir, ".git", "MSG"), "chore: ci\n");
  const deleted = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: gone.dir, encoding: "utf8", env });
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.match(deleted.stderr, /security\.secrets was not checked: the staged lines could not be read/);
});

test("gate failure: a diff past the buffer is a ceiling: its file is said, the commit goes on, the files beside it are judged", () => {
  const r = repo();
  r.stage({ ".ennyn/config.json": JSON.stringify({ review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] } }), "big.txt": Buffer.concat([Buffer.alloc(65 * 1024 * 1024, 0x61), Buffer.from("\nNEEDLE\n")]) });
  const hook = r.check("--hook");
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /review\.forbidden was not checked in 1 staged path\(s\) \(.*big\.txt.*\): git diff: its output was larger than 64 MB/);
  r.stage({ "other.txt": "NEEDLE\n" });
  const beside = r.check("--hook");
  assert.equal(beside.status, 1, beside.stderr);
  assert.match(beside.stderr, /other\.txt:1 adds "NEEDLE"/);
  assert.match(beside.stderr, /review\.forbidden was not checked in 1 staged path\(s\) \(.*big\.txt/);
});

const OFFLINE = { security: { deps: { online: false, advisories: "" } } };
const NEEDLE_RULE = { review: { forbidden: [{ text: "NEEDLE", paths: ["**"] }] } };
/** Past the buffer of a read that holds names. */
const PAST_NAMES = 256 * 1024 * 1024 + 1024;

/** Takes names out of the index by stdin: a name past the limit cannot be given as an argument. @param {string} dir @param {(string | Buffer)[]} names */
function unstageNames(dir, names) {
  const r = spawnSync("git", ["update-index", "--force-remove", "-z", "--stdin"], { cwd: dir, input: Buffer.concat(names.flatMap((n) => [Buffer.from(n), Buffer.from([0])])), maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, String(r.stderr));
}

test("gate scope: a name past the argument limit HEAD holds locks nothing: its removal passes, a commit beside it passes, a commit that changes it is refused", () => {
  /** @type {[string, string, Record<string, string>][]} */
  const GATES = [
    ["security.ci", `.github/workflows/${PAST_ARGV}.yml`, { ".github/workflows/c.yml": PINNED }],
    ["security.deps", `${PAST_ARGV}/package-lock.json`, { "a/package.json": '{"name":"a","version":"1.0.1"}\n' }],
    ["review.forbidden", `${PAST_ARGV}.txt`, { "a.txt": "x\n" }],
  ];
  for (const [gate, name, beside] of GATES) {
    const seeded = () => {
      const r = repo();
      r.stage({ ".ennyn/config.json": JSON.stringify({ ...NEEDLE_RULE, ...OFFLINE }) });
      stageNames(r.dir, [[name, "{}\n"]]);
      assert.equal(r.commit("chore: held", "--no-verify").status, 0, gate);
      return r;
    };
    const gone = seeded();
    unstageNames(gone.dir, [name]);
    const removed = gone.check("--hook");
    assert.equal(removed.status, 0, `${gate}, removed: ${removed.stderr.slice(0, 300)}`);
    // By hand every failure throws, and security.ci reads HEAD's version of what is deleted.
    if (gate === "security.ci") assert.equal(gone.check().status, 1, "by hand");
    const near = seeded();
    put(near.dir, beside);
    git(["add", "--", ...Object.keys(beside)], { cwd: near.dir });
    const stays = near.check("--hook");
    assert.equal(stays.status, 0, `${gate}, beside it: ${stays.stderr.slice(0, 300)}`);
    const changed = seeded();
    stageNames(changed.dir, [[name, "{ }\n"]]);
    const brought = changed.check("--hook");
    assert.equal(brought.status, 1, `${gate}, changed`);
    assert.match(brought.stderr, new RegExp(`${gate.replace(".", "\\.")} was not checked, so this commit is refused`), gate);
  }
});

test("gate scope: a workflow beside a tracked name past the limit is still judged, and that name is said", () => {
  const r = repo();
  stageNames(r.dir, [[`.github/workflows/${PAST_ARGV}.yml`, "on: push\n"]]);
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  put(r.dir, { ".github/workflows/pwn.yml": PWN_TEXT });
  git(["add", ".github/workflows/pwn.yml"], { cwd: r.dir });
  const hook = r.check("--hook");
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /pwn\.yml: a pull_request_target workflow checks out/);
  assert.match(hook.stderr, /security\.ci could not read .*no git argument can hold that name/);
  assert.doesNotMatch(hook.stderr, /so this commit is refused/);
});

test("gate scope: a name that is not UTF-8 the commit deletes refuses nothing, in any gate", () => {
  for (const [gate, name] of /** @type {[string, Buffer][]} */ ([
    ["security.ci", BYTE_NAME(".github/workflows/p", ".yml")],
    ["security.deps", BYTE_NAME("p", "/package-lock.json")],
    ["review.forbidden", BYTE_NAME("p", ".txt")],
  ])) {
    const r = repo();
    r.stage({ ".ennyn/config.json": JSON.stringify({ ...NEEDLE_RULE, ...OFFLINE }) });
    stageNames(r.dir, [[name, "{}\n"]]);
    assert.equal(r.commit("chore: held", "--no-verify").status, 0, gate);
    unstageNames(r.dir, [name]);
    const hook = r.check("--hook");
    assert.equal(hook.status, 0, `${gate}: ${hook.stderr}`);
    assert.doesNotMatch(hook.stderr, /so this commit is refused/, gate);
  }
});

test("gate scope: a path that changes kind is read on its new side: no call is lost to what a name holds below it", () => {
  const BIG = "line of text\n".repeat(170000);
  const many = (/** @type {string} */ dir, /** @type {string} */ last) => Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`${dir}/f${i}.js`, i === 599 ? last : `${i}\n`]));
  /** @type {[string, (r: ReturnType<typeof repo>, last: string) => void][]} */
  const CASES = [
    ["a file past 1 MB becomes a directory", (r, last) => {
      r.stage({ data: BIG, "k.txt": "k\n" });
      assert.equal(r.commit("chore: held", "--no-verify").status, 0);
      rmSync(join(r.dir, "data"));
      r.stage({ "data/x.txt": last });
    }],
    ["a directory becomes a file past 1 MB", (r, last) => {
      r.stage({ "data/x.txt": "x\n", "k.txt": "k\n" });
      assert.equal(r.commit("chore: held", "--no-verify").status, 0);
      rmSync(join(r.dir, "data"), { recursive: true });
      r.stage({ data: BIG + last });
    }],
    ["a link becomes a directory of 600 files", (r, last) => {
      symlinkSync("real", join(r.dir, "lib"));
      r.stage({ "real/x.txt": "x\n" });
      assert.equal(r.commit("chore: held", "--no-verify").status, 0);
      rmSync(join(r.dir, "lib"));
      r.stage(many("lib", last));
    }],
    ["a submodule becomes 600 files", (r, last) => {
      r.stage({ "a.txt": "a\n" });
      assert.equal(r.commit("chore: held", "--no-verify").status, 0);
      git(["update-index", "--add", "--cacheinfo", `160000,${"b".repeat(40)},vendor/sub`], { cwd: r.dir });
      assert.equal(r.commit("chore: sub", "--no-verify").status, 0);
      git(["rm", "-q", "--cached", "vendor/sub"], { cwd: r.dir });
      r.stage(many("vendor/sub", last));
    }],
    ["the other side of a merge makes a file a directory", (r, last) => {
      r.stage({ data: BIG, "b.txt": "b\n" });
      assert.equal(r.commit("chore: held", "--no-verify").status, 0);
      git(["checkout", "-q", "-b", "other"], { cwd: r.dir });
      rmSync(join(r.dir, "data"));
      r.stage({ "data/x.txt": last });
      assert.equal(r.commit("chore: other", "--no-verify").status, 0);
      git(["checkout", "-q", "main"], { cwd: r.dir });
      r.stage({ "b.txt": "b2\n" });
      assert.equal(r.commit("chore: main", "--no-verify").status, 0);
      git(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-commit", "--no-ff", "other"], { cwd: r.dir });
    }],
  ];
  for (const [name, make] of CASES) {
    for (const [last, exit] of /** @type {[string, number][]} */ ([["x\n", 0], ["NEEDLE\n", 1]])) {
      const r = repo();
      r.stage({ ".ennyn/config.json": JSON.stringify(NEEDLE_RULE) });
      make(r, last);
      const hook = r.check("--hook");
      assert.equal(hook.status, exit, `${name}: ${hook.stderr.slice(0, 300)}`);
      assert.doesNotMatch(hook.stderr, /was not checked/, name);
      if (exit) assert.match(hook.stderr, /adds "NEEDLE"/, name);
    }
  }
});

test("gate scope: the index's listing is context: past its buffer it is said, and what the commit brings is still judged", () => {
  const env = fakeGit(`case " $* " in *" ls-files -z "*) head -c ${PAST_NAMES} /dev/zero; exit 0 ;; esac`);
  const hookOf = (/** @type {ReturnType<typeof repo>} */ r) => {
    writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
    return spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  };
  const clean = repo();
  clean.stage({ [WF]: PINNED });
  const said = hookOf(clean);
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stderr, /security\.ci could not read the workflows that may call the staged files/);
  const pwn = repo();
  pwn.stage({ ".github/workflows/pwn.yml": PWN_TEXT });
  const refused = hookOf(pwn);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pwn\.yml: a pull_request_target workflow checks out/);
  const lock = repo();
  lock.stage({ ".ennyn/config.json": JSON.stringify(OFFLINE), "package.json": '{"name":"x"}\n', "package-lock.json": '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n' });
  assert.equal(lock.commit("chore: held", "--no-verify").status, 0);
  lock.stage({ "package.json": '{"name":"x","version":"1.0.1"}\n' });
  const deps = hookOf(lock);
  assert.equal(deps.status, 0, deps.stderr);
  assert.match(deps.stderr, /security\.deps was not checked: the staged lock files could not be read/);
});

test("gate scope: a throw of our own code refuses a commit that brings that gate's file, and is said for one that only deletes it", () => {
  // Only where the CI check decides what text it can read: the secret scan asks the same of each line. Spelled in two
  // parts: a stack quotes this URL.
  const fault = `data:text/javascript,const real=Buffer.prototype.includes;Buffer.prototype.includes=function(v,...a){if(v===0&&real.call(this,"STOPHERE")&&new Error().stack.includes("at ci"+"Text"))throw new RangeError("stopped here");return real.call(this,v,...a)};`;
  const hookOf = (/** @type {ReturnType<typeof repo>} */ r) => {
    writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
    return spawnSync(process.execPath, ["--import", fault, CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  };
  const brought = repo();
  brought.stage({ [WF]: `${PINNED}# STOPHERE\n` });
  const refused = hookOf(brought);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /security\.ci was not checked, so this commit is refused: .*\(stopped here\)/);
  const held = repo();
  held.stage({ [WF]: `${PINNED}# STOPHERE\n` });
  assert.equal(held.commit("chore: held", "--no-verify").status, 0);
  git(["rm", "-q", WF], { cwd: held.dir });
  const deleted = hookOf(held);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.match(deleted.stderr, /security\.ci was not checked: the staged CI files could not be read \(stopped here\)/);
});

test("gate scope: a list of changes past its buffer is asked again without deletions: deletions past it are said, a commit bringing past it is refused", () => {
  const r = repo();
  r.stage({ ".github/workflows/pwn.yml": PWN_TEXT });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const run = (/** @type {NodeJS.ProcessEnv} */ env) => spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  const deletions = fakeGit(`case " $* " in *" --diff-filter=d "*) ;; *" --name-status "*) head -c ${PAST_NAMES} /dev/zero; exit 0 ;; esac`);
  const told = run(deletions);
  assert.equal(told.status, 1, told.stderr);
  assert.match(told.stderr, /pwn\.yml: a pull_request_target workflow checks out/, "what the commit brings is judged");
  assert.match(told.stderr, /could not name what this commit deletes/);
  assert.doesNotMatch(told.stderr, /every gate was not checked/);
  const brought = run(fakeGit(`case " $* " in *" --name-status "*) head -c ${PAST_NAMES} /dev/zero; exit 0 ;; esac`));
  assert.equal(brought.status, 1, brought.stderr);
  assert.match(brought.stderr, /every gate was not checked, so this commit is refused/);
});

test("gate scope: HEAD's listing past its buffer leaves that name with no HEAD version: judged as new, never refused for the read", () => {
  const r = repo();
  r.stage({ [WF]: PINNED, ".github/workflows/old.yml": PINNED.replace(`@${SHA} # v7.0.1`, "@v7") });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  r.stage({ [WF]: `${PINNED}# edited\n`, ".github/workflows/old.yml": `${PINNED.replace(`@${SHA} # v7.0.1`, "@v7")}# edited\n` });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  assert.equal(r.check("--hook").status, 0, "HEAD holds the tag");
  const env = fakeGit(`case " $* " in *" ls-tree -r -z "*) head -c ${65 * 1024 * 1024} /dev/zero; exit 0 ;; esac`);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.doesNotMatch(hook.stderr, /was not checked, so this commit is refused/, hook.stderr);
  assert.match(hook.stderr, /old\.yml: 1 new uses/);
  // A git that fails there is the machine's: said, and what HEAD holds is not read as new.
  const fails = fakeGit('case " $* " in *" ls-tree -r -z "*) echo "fatal: injected" >&2; exit 128 ;; esac');
  const machine = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: fails });
  assert.equal(machine.status, 0, machine.stderr);
  assert.match(machine.stderr, /security\.ci could not read .* \(fatal: injected\)/);
  // The deps check says what it lost: every entry counts as new.
  const lock = repo();
  lock.stage({ ".ennyn/config.json": JSON.stringify(OFFLINE), "package.json": '{"name":"x"}\n', "package-lock.json": '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n' });
  assert.equal(lock.commit("chore: held", "--no-verify").status, 0);
  lock.stage({ "package-lock.json": '{"name":"x","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n' });
  writeFileSync(join(lock.dir, ".git", "MSG"), "chore: ci\n");
  const said = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: lock.dir, encoding: "utf8", env });
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stderr, /package-lock\.json was not checked: HEAD's version could not be read/);
});

test("gate scope: a MERGE_HEAD that holds no commit costs the message's note, never the gate", () => {
  for (const [text, exit] of /** @type {[string, number][]} */ ([["x\n", 0], ["NEEDLE\n", 1]])) {
    const r = repo();
    r.stage({ ".ennyn/config.json": JSON.stringify(NEEDLE_RULE), "a.txt": text });
    writeFileSync(join(r.dir, ".git", "MERGE_HEAD"), "not a commit\n");
    const hook = r.check("--hook");
    assert.equal(hook.status, exit, hook.stderr);
    assert.doesNotMatch(hook.stderr, /review\.forbidden was not checked/);
  }
});

test("gate failure: the refusal says what was not read, by name, and that it could be Ennyn's own fault; it offers no way around the gate", () => {
  for (const [language, refused, ours] of [["en", /security\.ci was not checked, so this commit is refused: .*action\.yml/, /a bug in Ennyn/], ["tr", /security\.ci denetlenmedi, bu yüzden commit reddedildi: .*action\.yml/, /Ennyn'deki bir hata/]]) {
    const r = repo();
    r.stage({ ".ennyn/config.json": JSON.stringify({ language }) });
    stageNames(r.dir, [[`${PAST_ARGV}/action.yml`, "{}\n"]]);
    const hook = r.check("--hook");
    assert.equal(hook.status, 1);
    assert.match(hook.stderr, /** @type {RegExp} */ (refused));
    assert.match(hook.stderr, /** @type {RegExp} */ (ours));
    assert.doesNotMatch(hook.stderr, /except/);
  }
  const names = repo();
  stageNames(names.dir, [[BYTE_NAME(".github/workflows/p", ".yml"), "{}\n"]]);
  assert.match(names.check("--hook").stderr, /whose names are not UTF-8 .*so this commit is refused/);
});

test("gate scope: a read is weighed name by name: a machine's fault beside a failure the commit can pick hides no refusal", () => {
  const r = repo();
  r.stage({ ".github/workflows/a.yml": PINNED, ".github/workflows/b.yml": PINNED });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const env = fakeGit(`case " $* " in *" ls-files -s "*a.yml*) echo "fatal: injected" >&2; exit 128 ;; *" ls-files -s "*b.yml*) head -c ${65 * 1024 * 1024} /dev/zero; exit 0 ;; esac`);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /security\.ci was not checked, so this commit is refused: .*b\.yml/);
  assert.match(hook.stderr, /security\.ci could not read .*a\.yml.*\(fatal: injected\)/);
});

test("gate scope: a brought name and a tracked one past the limit in one read: the first refuses, the second is said", () => {
  const r = repo();
  stageNames(r.dir, [[`.github/workflows/z${PAST_ARGV}.yml`, "on: push\n"]]);
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  stageNames(r.dir, [[`.github/workflows/a${PAST_ARGV}.yml`, "on: push\n"]]);
  const hook = r.check("--hook");
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /security\.ci was not checked, so this commit is refused/);
  assert.match(hook.stderr, /security\.ci could not read/);
});

test("gate scope: a package.json that cannot be read stands unread, never as no dependencies; an .npmrc the commit leaves alone is said", () => {
  const lockOf = (/** @type {string} */ version) => JSON.stringify({ name: "x", version, lockfileVersion: 3, packages: { "": { name: "x", version, workspaces: ["w"] }, w: { name: "w", version: "1.0.0" }, "node_modules/w": { resolved: "w", link: true } } });
  const r = repo();
  r.stage({ ".ennyn/config.json": JSON.stringify(OFFLINE), "package.json": '{"name":"x","workspaces":["w"]}\n', "w/package.json": '{"name":"w","version":"1.0.0"}\n', "package-lock.json": lockOf("1.0.0") });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  r.stage({ "package-lock.json": lockOf("1.0.1") });
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const env = fakeGit(`case " $* " in *" ls-files -s "*w/package.json*) echo "fatal: injected" >&2; exit 128 ;; esac`);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /w\/package\.json \(git could not give it\)/);
  const bare = repo();
  bare.stage({ ".ennyn/config.json": JSON.stringify(OFFLINE), "package-lock.json": JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/bare": { version: "1.0.0", integrity: "sha512-AAAA" } } }) });
  writeFileSync(join(bare.dir, ".git", "MSG"), "chore: ci\n");
  const past = fakeGit(`case " $* " in *" ls-files -z -- . "*) head -c ${PAST_NAMES} /dev/zero; exit 0 ;; esac`);
  const npmrc = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: bare.dir, encoding: "utf8", env: past });
  assert.doesNotMatch(npmrc.stderr, /so this commit is refused/, npmrc.stderr);
});

test("gate scope: a throw of the deps check is said for a commit that adds and changes no file of it", () => {
  const r = repo();
  r.stage({ ".ennyn/config.json": JSON.stringify(OFFLINE), "package.json": '{"name":"x"}\n', "package-lock.json": REFUSED_LOCK });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  git(["rm", "-q", "package.json"], { cwd: r.dir });
  const fault = `data:text/javascript,const real=Object.entries;Object.entries=function(o){if(o&&o["node_modules/a"])throw new RangeError("stopped here");return real(o)};`;
  writeFileSync(join(r.dir, ".git", "MSG"), "chore: ci\n");
  const hook = spawnSync(process.execPath, ["--import", fault, CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /security\.deps was not checked: the staged lock files could not be read \(stopped here\)/);
});

/** A pull_request_target workflow and a local action that checks out what it is handed: `with` holds the step's inputs. */
const HAND = {
  wf: (/** @type {string} */ withText, on = "pull_request_target") => `on: ${on}\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: ./.github/actions/build\n        with:\n${withText}`,
  action: `inputs:\n  head:\n    required: true\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n      with:\n        ref: \${{ inputs.head }}\n    - run: npm ci && npm test\n      shell: bash\n`,
  head: "${{ github.event.pull_request.head.sha }}",
};
const PR = ".github/workflows/pr.yml";
const BUILD = ".github/actions/build/action.yml";

test("ci hand-off: the pull request's code handed to a local action or reusable workflow under any input's name is found, in every spelling the ref rule reads", () => {
  const pwnOf = (/** @type {Record<string, string>} */ files) => [...ciSet(new Map(Object.entries(files))).findings].flatMap(([p, f]) => f.pwn.map((x) => `${p}:${x.n} ${x.what}${x.to ? ` -> ${x.to}` : ""}`));
  const step = (/** @type {string} */ w, on = "pull_request_target") => ({ [PR]: HAND.wf(w, on), [BUILD]: HAND.action });
  const at11 = (/** @type {string} */ what) => [`${PR}:11 ./.github/actions/build with ${what} -> ./.github/actions/build`];
  assert.deepEqual(pwnOf(step(`          head: ${HAND.head}\n`)), at11(`head: ${HAND.head}`));
  assert.deepEqual(pwnOf(step(`          "head": '${HAND.head}'\n`)), at11(`head: ${HAND.head}`), "quoted key and value");
  assert.deepEqual(pwnOf(step(`          branch: \${{ github.head_ref }}\n`)), at11("branch: ${{ github.head_ref }}"));
  assert.deepEqual(pwnOf(step(`          head: \${{ format('refs/pull/{0}/head', github.event.number) }}\n`)).length, 1, "a ref built from the number");
  assert.deepEqual(pwnOf(step(`          head: \${{ GitHub.Event['pull_request']['head']['sha'] }}\n`)).length, 1, "a context in other case, indexed");
  assert.deepEqual(pwnOf(step(`          head: |\n            ${HAND.head}\n`)).length, 1, "a block scalar");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf("").replace("        with:\n", `        with: { head: "${HAND.head}" }\n`), [BUILD]: HAND.action }), [`${PR}:10 ./.github/actions/build with head: ${HAND.head} -> ./.github/actions/build`], "a flow mapping");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf("").replace("      - uses: ./.github/actions/build\n        with:\n", `      - with:\n          head: ${HAND.head}\n        uses: ./.github/actions/build\n`), [BUILD]: HAND.action }).length, 1, "with before uses");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf(`          head: *h\n`).replace("jobs:", `x: &h ${HAND.head}\njobs:`), [BUILD]: HAND.action }).length, 1, "an alias of an anchored value");
  // Through a name the file sets to the ref: an env, a $GITHUB_ENV line.
  assert.deepEqual(pwnOf(step(`          head: \${{ env['H'] }}\n`)).length, 0, "no env holds it");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf(`          head: \${{ env['H'] }}\n`).replace("jobs:", `env:\n  H: ${HAND.head}\njobs:`), [BUILD]: HAND.action }).length, 1, "an env of the file holds it");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf(`          head: \${{ env.H }}\n`).replace("      - uses: ./", `      - run: echo "H=${HAND.head}" >> "$GITHUB_ENV"\n      - uses: ./`), [BUILD]: HAND.action }).length, 1, "a $GITHUB_ENV name");
  // A job's with on a local reusable workflow.
  const job = `on: pull_request_target\npermissions:\n  contents: read\njobs:\n  build:\n    uses: ./.github/workflows/build.yml\n    with:\n      sha: ${HAND.head}\n    secrets: inherit\n`;
  const reusable = `on:\n  workflow_call:\n    inputs:\n      sha:\n        type: string\npermissions: {}\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ inputs.sha }}\n      - run: npm ci\n`;
  assert.deepEqual(pwnOf({ [PR]: job, ".github/workflows/build.yml": reusable }), [`${PR}:8 ./.github/workflows/build.yml with sha: ${HAND.head} -> ./.github/workflows/build.yml`]);
  // ref: keeps its one finding; a callee that forwards the ref deeper is refused as reached; one that forwards its input is not.
  assert.deepEqual(pwnOf(step(`          ref: ${HAND.head}\n`)), at11(`ref: ${HAND.head}`), "ref: on a local uses is one hand-off");
  const outer = (/** @type {string} */ value) => `inputs:\n  head: {}\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/build\n      with:\n        head: ${value}\n`;
  const deep = { [PR]: `on: pull_request_target\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/outer\n`, ".github/actions/outer/action.yml": outer(HAND.head), [BUILD]: HAND.action };
  assert.deepEqual(pwnOf(deep), [`.github/actions/outer/action.yml:8 ./.github/actions/build with head: ${HAND.head} (reached from ${PR}) -> ./.github/actions/build`]);
  assert.deepEqual(pwnOf({ ...deep, ".github/actions/outer/action.yml": outer("${{ inputs.head }}") }), [], "an input forwarded: the callee side is not read");
  // Not found: other triggers, a remote uses, a value naming no code, no uses.
  for (const on of ["pull_request", "push", "workflow_dispatch"]) assert.deepEqual(pwnOf(step(`          head: ${HAND.head}\n`, on)), [], on);
  for (const w of ["number: ${{ github.event.pull_request.number }}", "n: ${{ github.event.number }}", "base: ${{ github.event.pull_request.base.sha }}", "sha: ${{ github.sha }}", "url: ${{ github.event.pull_request.html_url }}"]) assert.deepEqual(pwnOf(step(`          ${w}\n`)), [], w);
  assert.deepEqual(pwnOf({ [PR]: HAND.wf(`          head: ${HAND.head}\n`).replace("./.github/actions/build", `some/action@${SHA}`) }), [], "a remote action");
  assert.deepEqual(pwnOf({ [PR]: job.replace("./.github/workflows/build.yml", `o/r/.github/workflows/build.yml@${SHA}`) }), [], "a remote reusable workflow");
  assert.deepEqual(pwnOf({ [PR]: HAND.wf(`          head: ${HAND.head}\n`).replace("      - uses: ./.github/actions/build\n", "      - name: no uses\n") }), [], "a with on a step that uses nothing");
  // A step's env is no with: a local action's run reading it is another rule's (not read).
  assert.deepEqual(pwnOf({ [PR]: HAND.wf("          x: 1\n").replace("        with:\n", `        env:\n          HEAD: ${HAND.head}\n        with:\n`), [BUILD]: HAND.action }), [], "a step's env");
});

test("ci hand-off hook: a commit that hands the pull request's code to a local callee is refused, saying where it goes and what to pass; other triggers and the number pass", async () => {
  const r = repo();
  r.stage({ [PR]: HAND.wf(`          head: ${HAND.head}\n`), [BUILD]: HAND.action });
  const step = r.check("--hook");
  assert.equal(step.status, 1);
  assert.match(step.stderr, /pr\.yml: a pull_request_target workflow hands the pull request's head or ref, or a value that may name them .*line 11 \(\.\/\.github\/actions\/build with head: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\); pass the number/);
  assert.doesNotMatch(step.stderr, /checks out the pull request's code/);
  // A checkout and a hand-off in one file: each is said once, under its own remedy.
  r.stage({ [PR]: HAND.wf(`          head: ${HAND.head}\n`).replace(`checkout@${SHA}\n`, `checkout@${SHA}\n        with:\n          ref: ${HAND.head}\n`) });
  const both = r.check("--hook").stderr.split("\n");
  assert.deepEqual(both.filter((l) => /checks out the pull request's code/.test(l)).map((l) => l.match(/line .*?\)/)?.[0]), ["line 10 (ref: ${{ github.event.pull_request.head.sha }})"]);
  assert.deepEqual(both.filter((l) => /hands the pull request's head or ref/.test(l)).map((l) => l.match(/line .*?\)/)?.[0]), ["line 13 (./.github/actions/build with head: ${{ github.event.pull_request.head.sha }})"]);
  // A job's with on a local reusable workflow.
  r.stage({ [PR]: `on: pull_request_target\npermissions:\n  contents: read\njobs:\n  build:\n    uses: ./.github/workflows/build.yml\n    with:\n      sha: ${HAND.head}\n`, ".github/workflows/build.yml": `on: workflow_call\npermissions: {}\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ inputs.sha }}\n` });
  assert.match(r.check("--hook").stderr, /pr\.yml: a pull_request_target workflow hands .*line 8 \(\.\/\.github\/workflows\/build\.yml with sha: /);
  git(["rm", "-q", "--cached", ".github/workflows/build.yml"], { cwd: r.dir });
  // Through an env of the file.
  r.stage({ [PR]: HAND.wf("          head: ${{ env.H }}\n").replace("jobs:", `env:\n  H: ${HAND.head}\njobs:`) });
  assert.match(r.check("--hook").stderr, /pr\.yml: a pull_request_target workflow hands .*\(\.\/\.github\/actions\/build with head: \$\{\{ env\.H \}\}\)/);
  // A callee that forwards the ref deeper: refused in its own file, as reached.
  r.stage({ [PR]: HAND.wf("").replace("./.github/actions/build\n        with:\n", "./.github/actions/outer\n"), ".github/actions/outer/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/build\n      with:\n        head: ${HAND.head}\n` });
  const reached = r.check("--hook");
  assert.equal(reached.status, 1);
  assert.match(reached.stderr, /outer\/action\.yml: a pull_request_target workflow hands .*line 6 \(\.\/\.github\/actions\/build with head: .*reached from \.github\/workflows\/pr\.yml\)/);
  git(["rm", "-q", "--cached", ".github/actions/outer/action.yml"], { cwd: r.dir });
  // The same caller under pull_request, and the number under pull_request_target, pass.
  r.stage({ [PR]: HAND.wf(`          head: ${HAND.head}\n`, "pull_request") });
  const plain = r.check("--hook");
  assert.equal(plain.status, 0, plain.stderr);
  r.stage({ [PR]: HAND.wf("          number: ${{ github.event.pull_request.number }}\n") });
  const number = r.check("--hook");
  assert.equal(number.status, 0, number.stderr);
  // What HEAD holds is not new: committed past the hook, the same line, moved, passes.
  r.stage({ [PR]: HAND.wf(`          head: ${HAND.head}\n`) });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  // doctor counts what the tracked files hold.
  assert.ok((await checkSetup({ cwd: r.dir, env: {} })).items.some((i) => i.key === "doctor.ciPwn" && i.level === "warn"));
  r.stage({ [PR]: HAND.wf(`          head: ${HAND.head}\n`).replace("      - uses: actions/checkout", "      - run: echo moved\n      - uses: actions/checkout") });
  const moved = r.check("--hook");
  assert.equal(moved.status, 0, moved.stderr);
});

test("ci pr fields: a number, count, flag, time, id or enum of the pull request names no code; the whole pull request or event in toJSON does", () => {
  const counted = (/** @type {string} */ x) => prExpression(`\${{ ${x} }}`);
  for (const f of ["id", "node_id", "additions", "deletions", "changed_files", "commits", "comments", "review_comments", "author_association", "merged", "mergeable", "mergeable_state", "rebaseable", "maintainer_can_modify", "locked", "active_lock_reason", "created_at", "updated_at", "closed_at", "merged_at", "user.id", "user.type", "base.sha", "number", "labels"]) assert.equal(counted(`github.event.pull_request.${f}`), false, f);
  for (const f of ["head.sha", "title", "body", "user.login", "merged_by.login", "assignees", "milestone", "idx", "user.idx", "user_id", "base_x", "merge_commit_sha", "comments_url"]) assert.equal(counted(`github.event.pull_request.${f}`), true, f);
  for (const x of ["toJSON(github.event.pull_request)", "toJSON(github.event)", "toJSON(github)", "ToJSON( GitHub['event'] )", "toJSON(github.event.pull_request.head)", "fromJSON(toJSON(github.event)).pull_request.head.sha"]) assert.equal(counted(x), true, x);
  for (const x of ["toJSON(github.event.pull_request.base)", "toJSON(github.event.pull_request.labels)", "github.event.pull_request != null", "github.event.pull_request", "toJSON(github.event.issue)"]) assert.equal(counted(x), false, x);
});

test("ci hand-off held: a hand-off HEAD holds is new when the commit brings a file its callee reaches, and stays held otherwise", () => {
  const SAFE = "inputs:\n  head: {}\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n";
  const handed = HAND.wf(`          head: ${HAND.head}\n`);
  const refused = (/** @type {{ check: (...f: string[]) => { status: number | null, stderr: string } }} */ r, /** @type {string} */ file) => {
    const out = r.check("--hook");
    assert.equal(out.status, 1, out.stderr);
    const line = out.stderr.split("\n").find((l) => l.includes("already hands")) ?? "";
    assert.match(line, /^\.github\/workflows\/pr\.yml: a pull_request_target workflow already hands .*\(line 11 \(\.\/\.github\/actions\/build with head: /, out.stderr);
    assert.ok(line.includes(`this commit brings ${file}, which that call reaches`), line);
    assert.doesNotMatch(out.stderr, /workflow hands/, "said once, as the reach's");
  };
  // The callee turns into a checkout, or comes new, or moves to action.yaml.
  const a = repo();
  a.stage({ [PR]: handed, [BUILD]: SAFE });
  assert.equal(a.commit("chore: held", "--no-verify").status, 0);
  a.stage({ [BUILD]: HAND.action });
  refused(a, BUILD);
  git(["rm", "-q", "-f", BUILD], { cwd: a.dir });
  a.stage({ ".github/actions/build/action.yaml": HAND.action });
  refused(a, ".github/actions/build/action.yaml");
  const b = repo();
  b.stage({ [PR]: handed });
  assert.equal(b.commit("chore: held", "--no-verify").status, 0);
  b.stage({ [BUILD]: HAND.action });
  refused(b, BUILD);
  // A deeper callee changed, the caller and the first callee held.
  const c = repo();
  const outer = "inputs:\n  head: {}\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/deep\n      with:\n        head: ${{ inputs.head }}\n";
  c.stage({ [PR]: handed, [BUILD]: outer, ".github/actions/deep/action.yml": SAFE });
  assert.equal(c.commit("chore: held", "--no-verify").status, 0);
  c.stage({ ".github/actions/deep/action.yml": HAND.action });
  refused(c, ".github/actions/deep/action.yml");
  // A commit that brings no file of the reach: the held hand-off stays held.
  git(["reset", "-q", "--hard"], { cwd: c.dir });
  c.stage({ ".github/workflows/other.yml": PINNED });
  const other = c.check("--hook");
  assert.equal(other.status, 0, other.stderr);
});

test("ci hand-off held ref key: a ref: handed to a local callee is a hand-off with its reach, so a held one is new when the commit turns the callee into a checkout", () => {
  const r = repo();
  const callee = (/** @type {string} */ body) => `inputs:\n  ref: {}\nruns:\n  using: composite\n  steps:\n${body}`;
  r.stage({ [PR]: HAND.wf(`          ref: ${HAND.head}\n`), [BUILD]: callee('    - run: echo "${{ inputs.ref }}"\n      shell: bash\n') });
  assert.equal(r.commit("chore: held", "--no-verify").status, 0);
  r.stage({ [BUILD]: callee(`    - uses: actions/checkout@${SHA}\n      with:\n        ref: \${{ inputs.ref }}\n    - run: npm ci\n      shell: bash\n`) });
  const out = r.check("--hook");
  assert.equal(out.status, 1, out.stderr);
  const lines = out.stderr.split("\n").filter((l) => l.includes("pull_request_target"));
  assert.deepEqual(lines.map((l) => l.match(/line \d+ \(\S+ with ref:/)?.[0]), ["line 11 (./.github/actions/build with ref:"], "one finding, the hand-off's");
  assert.ok(lines[0].includes(`this commit brings ${BUILD}, which that call reaches`), lines[0]);
  // A ref: on a remote uses stays a checkout's, with no reach: a callee changed beside it renews nothing.
  const remote = repo();
  remote.stage({ [PR]: HAND.wf("          x: 1\n").replace(`checkout@${SHA}\n`, `checkout@${SHA}\n        with:\n          ref: ${HAND.head}\n`), [BUILD]: HAND.action });
  assert.equal(remote.commit("chore: held", "--no-verify").status, 0);
  remote.stage({ [BUILD]: HAND.action.replace("npm ci", "npm ci --ignore-scripts") });
  const held = remote.check("--hook");
  assert.equal(held.status, 0, held.stderr);
});
