/**
 * Every CLI command, run with git failing under it. A fake git on PATH counts the calls of a run and
 * makes the k-th one fail (exit 128 with a message) or die (SIGKILL, as a timeout kills a child), for
 * every k a clean run makes (SIGKILL at the first and the last: the code takes the same branch for both
 * ways a git ends badly); then git is missing altogether. A run must fail (non-zero exit, a message,
 * no stack trace), print exactly what the clean run prints (the failed call changed nothing), or say so
 * in every part it changed ("unmeasured", "could not be read", "was not checked"; a part is a line, or a
 * piece of one between " · ", "<br>" or "|"): never a number read from a call that failed (a part the
 * clean run has with other numbers fails even when it says unmeasured; one count may move: doctor's count of
 * its "?" lines, up by exactly the "?" lines the faulted run adds), and never a pass where the clean run
 * fails unless it says it did not check. The commit-msg hook fails open: it may not fail where the
 * clean run passes.
 * A closed stdout must end a command without a stack trace. Every command in USAGE needs a case, and a
 * read whose failure would change the result needs a case that reaches it (a config value, a hook's
 * index, a fold target, a sparse checkout, a subdirectory).
 *
 * The same for files: test/fault-fs.mjs, loaded into every run, counts the file reads outside Ennyn's own
 * files and fails the k-th, as a file without permission (EACCES) and as a directory in its place (EISDIR),
 * for every k. The Claude Code hooks run here too, given their stdin; their JSON output is judged as the
 * text Claude Code shows, and exit 2 (blocking) is never right.
 *
 * Cycle 2026-10-20 (4) found this class 11 times, each by a reviewer or a loaded machine: a timeout, a
 * process that did not start, a check with no answer, a shallow range read as a result. The first run
 * of this matrix found 44 more: git calls that answered "nothing there" when they had failed. The first
 * run over file reads found 73: files that could not be read taken for files that are not there.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { USAGE } from "../scripts/ennyn.mjs";
import { TOKENS } from "./secret-shapes.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
/** Loaded into every run: counts the file reads, and fails the one a cell names. */
const FAULT_FS = join(dirname(fileURLToPath(import.meta.url)), "fault-fs.mjs");
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "claude-code", "hooks");
const NODE = JSON.stringify(process.execPath);
/** What a changed line says when a value could not be measured or an action could not be done (English: the fixture's language). */
// Named one by one: "could not be found" is the very claim a failed read must not make.
const SAYS = /unmeasured|could not be (measured|read|applied|reset)|was not checked/i;

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const BIN = mkdtempSync(join(tmpdir(), "en-fault-bin-"));
const FAKE = join(BIN, "fake");
const NONE = join(BIN, "none");
mkdirSync(FAKE);
mkdirSync(NONE);
writeFileSync(
  join(FAKE, "git"),
  [
    "#!/bin/sh",
    'n=$(( $(cat "$ENNYN_FAULT_DIR/count" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$ENNYN_FAULT_DIR/count"',
    'if [ "$n" = "$ENNYN_FAULT_AT" ]; then',
    '  case "$ENNYN_FAULT" in',
    '    fail) echo "fatal: injected failure" >&2; exit 128 ;;',
    "    kill) kill -KILL $$ ;;",
    "  esac",
    "fi",
    'exec "$ENNYN_REAL_GIT" "$@"',
    "",
  ].join("\n"),
);
chmodSync(join(FAKE, "git"), 0o755);

// ------------------------------------------------------------------------------------------- fixture --

const TEMPLATE = realpathSync(mkdtempSync(join(tmpdir(), "en-fault-tpl-")));
const REPO = join(TEMPLATE, "repo");
mkdirSync(REPO);
/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
/** @param {number} day @param {string} message @param {Record<string, string>} files */
function commit(day, message, files) {
  put(REPO, files);
  const date = `2026-01-${String(1 + day).padStart(2, "0")} 12:00:00 +0000`;
  git(["add", "-A"], { cwd: REPO });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], {
    cwd: REPO,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(["rev-parse", "HEAD"], { cwd: REPO });
}
// A local OSV that knows no advisory: `ennyn deps` has an answer to lose, and nothing leaves the machine.
const OSV = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: JSON.parse(body || '{"queries":[]}').queries.map(() => ({})) })));
});
await new Promise((r) => OSV.listen(0, "127.0.0.1", () => r(undefined)));
// It must not hold the file open: Node 20.0.0's runner does not reach the file's after hook here, and the file
// never ended (the Linux run waited on it for 40 minutes).
OSV.unref();
const OSV_ORIGIN = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (OSV.address()).port}`;
after(() => (OSV.closeAllConnections(), OSV.close()));
const LOCK = (/** @type {Record<string, unknown>} */ extra = {}) =>
  `${JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" }, "node_modules/left": { version: "1.0.0", resolved: `${OSV_ORIGIN}/left/-/left-1.0.0.tgz`, integrity: "sha512-x" }, ...extra } }, null, 2)}\n`;
const ADD = "export function add(a, b) {\n  const sum = a + b;\n  const checked = Number(sum);\n  return checked;\n}\n";
git(["init", "-q", "-b", "main"], { cwd: REPO });
const FIRST = commit(0, "feat: add", {
  ".ennyn/config.json": JSON.stringify({
    language: "en",
    commitMsg: { types: ["feat", "fix", "chore"] },
    review: { impactRequiredGlobs: ["src/**"], cochange: [{ paths: ["src/**"], docs: ["README.md"] }], forbidden: [{ text: "console.log", paths: ["src/**"] }] },
    // No request leaves the machine: the hook asks no registry, and `deps` asks the local OSV above.
    security: { deps: { online: false, registries: { [OSV_ORIGIN]: null }, advisories: OSV_ORIGIN, advisoryRegistries: [OSV_ORIGIN] } },
  }),
  // A lock file the hook and `deps` read: a read that fails there must be said.
  "package-lock.json": LOCK(),
  ".ennyn/graph.json": JSON.stringify({
    nodes: [
      { id: "core-one", status: "planned", value: "high", cost: "S", needs: [] },
      { id: "gate-one", status: "planned", value: "medium", cost: "M", needs: [], mechanization: true },
    ],
    done: [{ id: "base", status: "done" }],
  }),
  "CLAUDE.md": "# Project\n\n- Every change keeps the tests green before it is committed.\n- Never write a secret into a file that is tracked.\n- Never call `console.log` in src/.\n",
  // A literal the ban line names, held by a file: init-scan's count of it has an answer to lose.
  "scripts/debug.js": "console.log(process.argv);\n",
  "README.md": "# demo\n",
  // What init-scan, budget and the hooks look for: a read that fails there must change the output, not hide.
  "AGENTS.md": "# Agents\n\n- Run the tests before every commit, and keep them green.\n",
  "package.json": JSON.stringify({ name: "demo", scripts: { test: "node test/add.test.js" } }),
  ".claude/rules/src.md": '---\npaths:\n  - "src/**"\n---\n# Source\n\nKeep add pure.\n',
  ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review a change before it is committed.\n---\n\nRead the diff.\n",
  ".claude/agents/checker.md": "---\nname: checker\ndescription: Checks a change for correctness.\n---\n\nCheck it.\n",
  ".claude/commands/ship.md": "---\ndescription: Ship the change.\n---\n\nShip it.\n",
  // A CI file doctor reads, and one a commit can change: a read that fails there must be said.
  ".github/workflows/ci.yml": `on: push\npermissions:\n  contents: read\njobs:\n  a:\n    steps:\n      - uses: a/b@${"0".repeat(40)}\n`,
  "src/add.js": ADD,
  "src/use.js": 'import { add } from "./add.js";\nexport const three = add(1, 2);\n',
  "test/add.test.js": 'import { add } from "../src/add.js";\nif (add(1, 2) !== 3) throw new Error("add");\n',
});
const FIX = commit(3, "fix: add keeps numbers", { "src/add.js": ADD.replace("const checked = Number(sum);", "const checked = Number.isFinite(sum) ? sum : 0;") });
commit(4, "chore: notes [commit-shape-allow: notes only]", { "NOTES.md": "notes\n" });
// An upstream one commit behind.
const BARE = join(TEMPLATE, "origin.git");
git(["init", "-q", "--bare", BARE], { cwd: TEMPLATE });
git(["remote", "add", "origin", BARE], { cwd: REPO });
git(["push", "-q", "-u", "origin", "main"], { cwd: REPO });
commit(5, "feat: use add twice", { "src/use.js": 'import { add } from "./add.js";\nexport const three = add(1, 2);\nexport const four = add(2, 2);\n' });
// src/add.js and src/use.js change together three times: impact's co-change has an answer to lose.
for (const [day, n] of [[6, 5], [7, 6]]) {
  commit(day, `feat: step ${n}`, { "src/add.js": `${ADD}export const step${n} = ${n};\n`, "src/use.js": `import { add } from "./add.js";\nexport const three = add(1, 2);\nexport const n${n} = add(${n}, 0);\n` });
}
// A staged change; messages for commit-check; a mutant list and its test; then a gate log and a budget record.
put(REPO, { "src/add.js": ADD.replace("a + b", "b + a"), "README.md": "# demo\n\nadd\n" });
git(["add", "src/add.js", "README.md"], { cwd: REPO });
put(REPO, {
  ".git/MSG": "feat: add in either order\n\nImpact: S1 one reader\n",
  ".git/BARE": "feat: add in either order\n",
  ".git/LONG": `feat: add in either order\n\nbody\n${"#kept by verbatim\n".repeat(9)}\nImpact: S1 one reader\n`,
  ".git/AMEND": "amend! feat: add\n\nfeat: add, reworded\n",
  ".git/CUT": "feat: add in either order\n\n# ------------------------ >8 ------------------------\nImpact: S1 one reader\n",
  // A mutant the check kills, in the src/use.js the steps above left: the run reaches the journal and undo.
  ".git/mutants.json": JSON.stringify([{ id: "m1", file: "src/use.js", old: "add(1, 2)", new: "add(1, 3)" }]),
  ".git/check.mjs": 'import { readFileSync } from "node:fs";\nif (!readFileSync("src/use.js", "utf8").includes("add(1, 2)")) process.exit(1);\n',
});
// gate-record refuses a start more than a day before now: a minute ago.
const START = String(Math.floor(Date.now() / 1000) - 60);
// The commit-msg hook installed, so doctor reads it: a hook that cannot be read must not read as none.
for (const args of [["gate-record", "--start", START, "--exit", "1", "--step", "lint"], ["budget", "--record"], ["install-hook"]]) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: REPO, stdio: "ignore" });
}

// --------------------------------------------------------------------------------------------- cases --

/** Stages a src/use.js line that review.forbidden keeps out, in the main index or the one `env` names. @param {string} repo @param {NodeJS.ProcessEnv} [env] */
function stageLog(repo, env) {
  if (env) git(["read-tree", "HEAD"], { cwd: repo, env, keepIndex: true });
  writeFileSync(join(repo, "src", "use.js"), `${readFileSync(join(repo, "src", "use.js"), "utf8")}console.log(three);\n`);
  git(["add", "src/use.js", ...(env ? ["README.md"] : [])], { cwd: repo, ...(env ? { env, keepIndex: true } : {}) });
}

/** Stages a workflow step that names an action by its tag, which security.ci keeps out. @param {string} repo */
function stageWorkflow(repo) {
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `${readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8")}      - uses: a/b@v1\n`);
  git(["add", ".github/workflows/ci.yml"], { cwd: repo });
}

/** Stages a lock file whose new package runs an install script, which security.deps refuses. @param {string} repo */
function stageLock(repo) {
  writeFileSync(join(repo, "package-lock.json"), LOCK({ "node_modules/nat": { version: "1.0.0", resolved: `${OSV_ORIGIN}/nat/-/nat-1.0.0.tgz`, integrity: "sha512-x", hasInstallScript: true } }));
  git(["add", "package-lock.json"], { cwd: repo });
}

/** Stages a line that holds a secret, with a config that has no review.forbidden rule. @param {string} repo */
function stageSecret(repo) {
  const path = join(repo, ".ennyn", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...config, review: { ...config.review, forbidden: [] } }));
  writeFileSync(join(repo, "deploy.sh"), `export NPM_TOKEN=${TOKENS.npm}\n`);
  git(["add", "deploy.sh", ".ennyn/config.json"], { cwd: repo });
}

/**
 * @typedef {{ args: string[], cwd?: string, writes?: boolean, setup?: (repo: string) => void, env?: Record<string, string>, first?: boolean, outside?: boolean, hook?: string, input?: (repo: string) => unknown }} Case
 *   `cwd` is relative to the repository; a case that writes, or has a setup, runs in a copy of its own.
 *   `env` values are paths relative to the repository. `first`: only the first git call is faulted (the
 *   one that finds the project directory; the case without `cwd` sweeps the rest). `outside`: the
 *   repository's files without its .git, so in no repository. A `--hook` case fails open. `hook`: a Claude
 *   Code hook (adapters/claude-code/hooks), given `input` on stdin and the copy as CLAUDE_PROJECT_DIR; it may
 *   fail with a message (exit 1), never with exit 2, which Claude Code reads as blocking.
 * @type {Case[]}
 */
const CASES = [
  { args: ["init-scan"] },
  { args: ["init-scan", "--json"] },
  // The origin's URL is part of the report.
  { args: ["init-scan"], setup: (repo) => git(["remote", "set-url", "origin", "https://github.com/acme/demo.git"], { cwd: repo }) },
  { args: ["doctor"] },
  // The project directory comes from git; from a subdirectory a fallback reads no config.
  { args: ["doctor"], cwd: "src", first: true },
  { args: ["install-hook"], writes: true },
  // core.hooksPath set: the command writes nothing and fails.
  { args: ["install-hook"], setup: (repo) => git(["config", "core.hooksPath", ".hooks"], { cwd: repo }) },
  { args: ["budget"] },
  { args: ["budget"], cwd: "src", first: true },
  { args: ["budget", "--json"] },
  { args: ["budget", "--record"], writes: true },
  { args: ["commit-check", ".git/MSG"] },
  { args: ["commit-check", "--hook", ".git/MSG"] },
  // commit.cleanup=verbatim keeps the # lines: the body is too long. Read as unset, the message would pass.
  { args: ["commit-check", "--hook", ".git/LONG"], setup: (repo) => git(["config", "commit.cleanup", "verbatim"], { cwd: repo }) },
  // The index a hook is given stages a guarded path; the main index does not.
  {
    args: ["commit-check", "--hook", ".git/BARE"],
    env: { GIT_INDEX_FILE: ".git/index.hook" },
    setup: (repo) => {
      git(["reset", "-q", "src/add.js"], { cwd: repo });
      const env = { ...process.env, GIT_INDEX_FILE: join(repo, ".git", "index.hook") };
      git(["read-tree", "HEAD"], { cwd: repo, env, keepIndex: true });
      git(["add", "src/add.js"], { cwd: repo, env, keepIndex: true });
    },
  },
  // A staged line review.forbidden keeps out: read as no line, the commit would pass.
  { args: ["commit-check", ".git/MSG"], setup: (repo) => stageLog(repo) },
  { args: ["commit-check", "--hook", ".git/MSG"], setup: (repo) => stageLog(repo) },
  { args: ["commit-check", "--hook", ".git/MSG"], env: { GIT_INDEX_FILE: ".git/index.hook" }, setup: (repo) => stageLog(repo, { ...process.env, GIT_INDEX_FILE: join(repo, ".git", "index.hook") }) },
  // A uses by tag in a staged workflow: read as nothing staged, the commit would pass.
  { args: ["commit-check", ".git/MSG"], setup: (repo) => stageWorkflow(repo) },
  { args: ["commit-check", "--hook", ".git/MSG"], setup: (repo) => stageWorkflow(repo) },
  // A new package with an install script in the staged lock file: read as nothing staged, the commit would pass.
  { args: ["commit-check", ".git/MSG"], setup: (repo) => stageLock(repo) },
  { args: ["commit-check", "--hook", ".git/MSG"], setup: (repo) => stageLock(repo) },
  { args: ["deps"] },
  { args: ["deps", "--json"] },
  // A staged secret where no forbidden rule reads: only the secret scan reads the lines, and says a read that failed.
  { args: ["commit-check", ".git/MSG"], setup: (repo) => stageSecret(repo) },
  { args: ["commit-check", "--hook", ".git/MSG"], setup: (repo) => stageSecret(repo) },
  // An amend! that drops the Impact line its target needs; the target is read from the log.
  { args: ["commit-check", "--hook", ".git/AMEND"], setup: (repo) => git(["reset", "-q"], { cwd: repo }) },
  // The same past a shallow boundary: the target cannot be found, and the hook says what went unchecked.
  {
    args: ["commit-check", "--hook", ".git/AMEND"],
    setup: (repo) => {
      git(["reset", "-q"], { cwd: repo });
      writeFileSync(join(repo, ".git", "shallow"), `${FIX}\n`);
    },
  },
  // commit.verbose cuts at the scissors line, and the Impact line under it goes: read as unset, it would stay.
  { args: ["commit-check", "--hook", ".git/CUT"], setup: (repo) => git(["config", "commit.verbose", "true"], { cwd: repo }) },
  // In no repository: the git checks are skipped or unmeasured, not a failure of the whole command.
  { args: ["doctor"], outside: true },
  { args: ["init-scan"], outside: true },
  { args: ["mechanization"], outside: true },
  { args: ["commit-check", "--hook", "AMEND"], outside: true },
  { args: ["impact", "--symbol", "add", "--files", "src/add.js"] },
  // A sparse checkout: the readers outside it come from the index.
  {
    args: ["impact", "--symbol", "add", "--files", "src/add.js"],
    setup: (repo) => {
      git(["reset", "-q", "--hard"], { cwd: repo });
      git(["sparse-checkout", "set", "test"], { cwd: repo });
    },
  },
  { args: ["rework"] },
  { args: ["rework", "--since", "2026-01-01", "--json"] },
  { args: ["rework"], cwd: "src", first: true },
  { args: ["bypass"] },
  { args: ["bypass", "--from", FIRST, "--json"] },
  { args: ["mechanization"] },
  { args: ["mechanization"], cwd: "src", first: true },
  // The metrics log holds one budget record with no mark: the security audit is due, and the paths are read.
  { args: ["audit"] },
  { args: ["audit", "--json"] },
  // A mark reads the count first: a failed read there must not mark, or pass unsaid.
  { args: ["budget", "--record", "--security-audit"], writes: true },
  { args: ["mutate", ".git/mutants.json", "--command", `${NODE} .git/check.mjs`], writes: true },
  { args: ["mutate", "--restore"], writes: true },
  { args: ["push-check"] },
  { args: ["gate-record", "--start", START, "--exit", "0", "--commit", "HEAD"], writes: true },
  { args: ["gate-record", "--start", START, "--exit", "1"], writes: true },
  { args: ["gate-stats"] },
  { args: ["gate-stats", "--json"] },
  // The Claude Code hooks: a side copy (a linked worktree) reading a file a path-scoped rule covers, the
  // conversation style at session start, and the reset after compaction.
  {
    args: ["hook:side-copy-rules"],
    hook: "side-copy-rules.mjs",
    setup: (repo) => git(["worktree", "add", "-q", "--detach", `${repo}-side`], { cwd: repo }),
    input: (repo) => ({ tool_name: "Read", tool_input: { file_path: `${repo}-side/src/add.js` }, session_id: "s1", cwd: `${repo}-side` }),
  },
  {
    args: ["hook:conversation-style"],
    hook: "conversation-style.mjs",
    setup: (repo) => {
      const path = join(repo, ".ennyn", "config.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), conversation: { style: "terse" } }));
    },
    input: (repo) => ({ source: "startup", session_id: "s1", cwd: repo }),
  },
  {
    args: ["hook:side-copy-reset"],
    hook: "side-copy-reset.mjs",
    setup: (repo) => put(repo, { ".git/ennyn/side-copy/s1.json": '{"emitted":[]}\n' }),
    input: (repo) => ({ source: "compact", session_id: "s1", cwd: repo }),
  },
];

test("fault matrix: every Claude Code hook in hooks/hooks.json has a case", () => {
  const listed = [...readFileSync(join(HOOKS, "..", "..", "..", "hooks", "hooks.json"), "utf8").matchAll(/hooks\/([a-z-]+\.mjs)/g)].map((m) => m[1]);
  assert.ok(listed.length >= 3, `hooks read from hooks.json: ${listed}`);
  const covered = new Set(CASES.map((c) => c.hook));
  assert.deepEqual(listed.filter((h) => !covered.has(h)), []);
});

test("fault matrix: every command in USAGE has a case", () => {
  const commands = [...USAGE.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 13, `commands read from USAGE: ${commands}`);
  const covered = new Set(CASES.map((c) => c.args[0]));
  assert.deepEqual(commands.filter((c) => !covered.has(c)), []);
});

/**
 * @typedef {{ code: number | null, signal: string | null, stdout: string, stderr: string, calls: number, reads: string[] }} Run
 * @typedef {{ at?: number, kind?: "fail" | "kill", noGit?: boolean, closed?: boolean, read?: { at: number, kind: "eacces" | "eisdir" } }} Fault
 * @param {Case} c @param {Fault} fault
 * @returns {Promise<Run>}
 */
function run(c, fault) {
  const box = mkdtempSync(join(tmpdir(), "en-fault-run-"));
  let repo = REPO;
  if (c.outside) {
    repo = join(box, "plain");
    cpSync(REPO, repo, { recursive: true, filter: (from) => !from.split(/[\\/]/).includes(".git") });
    writeFileSync(join(repo, "AMEND"), readFileSync(join(REPO, ".git", "AMEND")));
  } else if (c.writes || c.setup) {
    repo = join(box, "repo");
    cpSync(REPO, repo, { recursive: true });
    c.setup?.(repo);
  }
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, join(repo, v)])),
    // Concurrent runs read the template: no refresh of its index.
    GIT_OPTIONAL_LOCKS: "0",
    PATH: fault.noGit ? NONE : `${FAKE}${delimiter}${process.env.PATH}`,
    ENNYN_FAULT_DIR: box,
    ENNYN_FAULT_AT: String(fault.at ?? 0),
    ENNYN_FAULT: fault.kind ?? "",
    ENNYN_REAL_GIT: REAL_GIT,
    ENNYN_FS_FAULT_DIR: box,
    ENNYN_FS_FAULT_AT: String(fault.read?.at ?? 0),
    ENNYN_FS_FAULT: fault.read?.kind ?? "eacces",
    ...(c.hook ? { CLAUDE_PROJECT_DIR: repo } : {}),
  };
  return new Promise((done) => {
    const argv = c.hook ? ["--import", FAULT_FS, join(HOOKS, c.hook)] : ["--import", FAULT_FS, CLI, ...c.args];
    const child = spawn(process.execPath, argv, { cwd: join(repo, c.cwd ?? ""), env, stdio: [c.hook ? "pipe" : "ignore", "pipe", "pipe"] });
    if (c.hook) child.stdin?.end(JSON.stringify(c.input?.(repo) ?? {}));
    let stdout = "";
    let stderr = "";
    if (fault.closed) child.stdout.destroy();
    else child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      let calls = 0;
      try {
        calls = Number(readFileSync(join(box, "count"), "utf8"));
      } catch {
        // No git call.
      }
      // A copy's own path and the mutate timings differ from run to run.
      const norm = (/** @type {string} */ s) => s.split(repo).join("<repo>").replace(/^Tests pass without mutants in .*$/gm, "<baseline>");
      let reads = "";
      try {
        reads = readFileSync(join(box, "fs-calls"), "utf8");
      } catch {
        // Killed before its exit handler.
      }
      done({ code, signal, stdout: norm(stdout), stderr: norm(stderr), calls, reads: norm(reads).split("\n").filter(Boolean) });
    });
  });
}

/**
 * A hook's JSON output as the text Claude Code shows: the context it gives the model and the message it
 * gives the user. Anything else stays as printed.
 * @param {string} out
 */
function shown(out) {
  try {
    const o = JSON.parse(out);
    // Only a hook's output: a --json report is judged line by line, numbers and all.
    if (o && typeof o === "object" && ("hookSpecificOutput" in o || "systemMessage" in o)) {
      return [o.hookSpecificOutput?.additionalContext, o.systemMessage].filter((x) => typeof x === "string").join("\n");
    }
  } catch {
    // Not JSON: as printed.
  }
  return out;
}
/** The parts of an output: its lines, each cut at " · ", "<br>" and "|" (table cells). @param {Run} r */
const parts = (r) => [shown(r.stdout), r.stderr].join("\n").split("\n").flatMap((l) => l.split(/ · |<br>|\|/)).map((p) => p.trim()).filter(Boolean);
/** @param {string} s */
const digits = (s) => s.replace(/\d+(\.\d+)?/g, "#");
/** The part of doctor's summary line that counts its "?" lines (the fixture's language is English). */
const UNMEASURED_COUNT = /^unmeasured: (\d+)$/;
/** doctor's "?" lines. @param {Run} r */
const marks = (r) => r.stdout.split("\n").filter((l) => l.startsWith("? ")).length;
/** The count on doctor's summary line, 0 without one. @param {Set<string>} parts */
const counted = (parts) => Number([...parts].map((p) => UNMEASURED_COUNT.exec(p)?.[1]).find((n) => n !== undefined) ?? 0);

/**
 * What is wrong with a faulted run, measured against the clean one; null when nothing is.
 * @param {Run} clean @param {Run} got @param {boolean} hook a commit-msg hook run, which fails open
 */
function judge(clean, got, hook) {
  if (/^\s+at .+:\d+:\d+\)?$/m.test(got.stderr)) return "a stack trace";
  if (got.code === 2 && clean.code !== 2) return "exit 2, which a Claude Code hook reads as blocking";
  const same = got.stdout === clean.stdout && got.stderr === clean.stderr && got.code === clean.code;
  if (same) return null;
  // A failure says why: on stderr, or (doctor's ✗ lines) in a new part of its report that says so.
  if (got.code !== 0 && !hook) {
    if (got.stderr.trim()) return null;
    const was = new Set(parts(clean));
    return parts(got).some((p) => !was.has(p) && SAYS.test(p)) ? null : "a failure with no message";
  }
  // The hook may still reject what it measured without git, and say what it could not read.
  if (hook && got.code !== 0 && clean.code === 0) return `the hook fails (exit ${got.code}) where the clean run passes: a failure must let the commit through`;
  const before = new Set(parts(clean));
  const after = new Set(parts(got));
  const shapes = new Set([...before].map(digits));
  const changed = [...after].filter((p) => !before.has(p));
  for (const p of changed) {
    // doctor counts its "?" lines on the summary line; with one in the clean run already (too few commits for
    // the fix label) the count moves with each line a fault leaves unmeasured. It may rise by exactly the "?"
    // lines the faulted run adds, each of which says why; no other number may move.
    if (UNMEASURED_COUNT.test(p) && marks(got) > marks(clean) && counted(after) - counted(before) === marks(got) - marks(clean)) continue;
    if (shapes.has(digits(p))) return `a number changed: ${JSON.stringify(p)}`;
    if (!SAYS.test(p)) return `changed without saying so: ${JSON.stringify(p)}`;
  }
  // One part that says so may stand for several that depend on the same read (staged paths: the Impact
  // rule and the cochange warning). Whether its reason is the true one, the judge cannot tell.
  if (!changed.length) return got.code === 0 && clean.code !== 0 ? `exit 0 where the clean run exits ${clean.code}, saying nothing` : "parts dropped without saying so";
  return null;
}

/** @template T @param {(() => Promise<T>)[]} jobs @param {number} n */
async function pool(jobs, n) {
  /** @type {T[]} */
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

test("fault matrix: with any git call failing or killed, or no git at all, a command fails or says so; a closed pipe is no crash", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const clean = await pool(CASES.map((c) => () => run(c, {})), width);
  for (const [i, c] of CASES.entries()) assert.ok(c.hook || clean[i].calls > 0, `${c.args.join(" ")} calls git`);
  /** @type {{ c: Case, i: number, fault: Fault }[]} */
  const cells = [];
  for (const [i, c] of CASES.entries()) {
    const last = c.first ? 1 : clean[i].calls;
    for (let at = 1; at <= last; at++) cells.push({ c, i, fault: { at, kind: "fail" } });
    for (const at of new Set([1, last])) cells.push({ c, i, fault: { at, kind: "kill" } });
    cells.push({ c, i, fault: { noGit: true } }, { c, i, fault: { closed: true } });
  }
  const results = await pool(cells.map((cell) => () => run(cell.c, cell.fault)), width);
  const where = (/** @type {Case} */ c) => `${c.args.join(" ")}${c.cwd ? ` (in ${c.cwd}/)` : ""}${c.setup ? " (set up)" : ""}${c.outside ? " (no repository)" : ""}`;
  const bad = cells
    .map((cell, k) => {
      const got = results[k];
      if (cell.fault.closed) {
        // Output that did not arrive is no pass: the clean run's code, or 141 as from SIGPIPE.
        const why = /^\s+at .+:\d+:\d+\)?$/m.test(got.stderr) ? "a stack trace" : got.code !== clean[cell.i].code && got.code !== 141 ? `exit ${got.code}` : null;
        return { cell, why };
      }
      return { cell, why: judge(clean[cell.i], got, cell.c.args.includes("--hook")) };
    })
    .filter((r) => r.why)
    .map((r) => `${where(r.cell.c)} · ${r.cell.fault.noGit ? "no git" : r.cell.fault.closed ? "closed stdout" : `git call ${r.cell.fault.at} ${r.cell.fault.kind}`}: ${r.why}`);
  assert.deepEqual(bad, [], `${bad.length} of ${cells.length} cells`);
});

/** The reads a directory in a file's place fails; the rest fail only as EACCES. */
const DIR_READS = /^(readFileSync|openSync) /;

test("fault matrix: with any file read failing (no permission, a directory in its place), a command fails or says so", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const clean = await pool(CASES.map((c) => () => run(c, {})), width);
  // A preload that stopped counting would leave no cells, and a green test.
  for (const [i, c] of CASES.entries()) assert.ok(clean[i].reads.length > 0, `${c.args.join(" ")} reads files`);
  /** @type {{ c: Case, i: number, fault: Fault, call: string }[]} */
  const cells = [];
  for (const [i, c] of CASES.entries()) {
    clean[i].reads.forEach((call, k) => cells.push({ c, i, fault: { read: { at: k + 1, kind: "eacces" } }, call }));
    clean[i].reads.filter((call) => DIR_READS.test(call)).forEach((call, k) => cells.push({ c, i, fault: { read: { at: k + 1, kind: "eisdir" } }, call }));
  }
  const results = await pool(cells.map((cell) => () => run(cell.c, cell.fault)), width);
  const where = (/** @type {Case} */ c) => `${c.args.join(" ")}${c.cwd ? ` (in ${c.cwd}/)` : ""}${c.setup ? " (set up)" : ""}${c.outside ? " (no repository)" : ""}`;
  const bad = cells
    .map((cell, k) => ({ cell, why: judge(clean[cell.i], results[k], cell.c.args.includes("--hook")) }))
    .filter((r) => r.why)
    .map((r) => `${where(r.cell.c)} · ${r.cell.fault.read?.kind} ${r.cell.call}: ${r.why}`);
  assert.deepEqual(bad, [], `${bad.length} of ${cells.length} cells`);
});

test("fault matrix: a reference command that fails, is killed, is not found or runs too long leaves S1's references unmeasured, saying how it ended", async () => {
  assert.ok(!/\s/.test(process.execPath), "the node path splits as one word");
  const node = process.execPath;
  /** @param {string} command @param {number} [timeout] @returns {Case} */
  const withReference = (command, timeout = 30) => ({
    args: ["impact", "--symbol", "add", "--files", "src/add.js"],
    setup: (repo) => {
      const path = join(repo, ".ennyn", "config.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...config, impact: { referenceCommand: command, referenceTimeout: timeout } }));
    },
  });
  const cases = /** @type {const} */ ([
    [`${node} -e process.exit(3)`, 30, /exit 3/],
    [`${node} -e process.stderr.write("index\\x20missing");process.exit(4)`, 30, /exit 4: index missing/],
    [`${node} -e process.kill(process.pid,9)`, 30, /killed by SIGKILL/],
    [`${node} -e setTimeout(()=>{},20000)`, 1, /timed out after 1 s/],
    ["no-such-reference-tool {symbol}", 30, /no-such-reference-tool: not found/],
  ]);
  const runs = await pool(cases.map(([command, timeout]) => () => run(withReference(command, timeout), {})), 4);
  cases.forEach(([command], k) => {
    const r = runs[k];
    assert.equal(r.code, 0, `${command}: ${r.stderr}`);
    const s1 = r.stdout.split("\n").find((l) => l.startsWith("| S1 "));
    assert.match(String(s1), /unmeasured: reference command failed: /, command);
    assert.match(String(s1), cases[k][2], command);
  });
  // One that works is read as references.
  const works = await run(withReference(`${node} -e console.log("src/use.js:1")`), {});
  assert.match(String(works.stdout.split("\n").find((l) => l.startsWith("| S1 "))), /references: src\/use\.js:1</);
});

// ----------------------------------------------------------------------------------- positive controls --

test("fault matrix control: the preload fails the read a cell names, counts only reads outside Ennyn's files, and nothing without its variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-fault-ctl-"));
  const file = join(dir, "x.txt");
  writeFileSync(file, "x");
  const own = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const probe = `import fs from "node:fs"; const r = []; for (const p of ${JSON.stringify([own, file, file])}) { try { fs.readFileSync(p); r.push("read"); } catch (e) { r.push(e.code); } } r.push(fs.existsSync(${JSON.stringify(file)})); console.log(JSON.stringify(r));`;
  const go = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync(process.execPath, ["--import", FAULT_FS, "--input-type=module", "-e", probe], { encoding: "utf8", env: { ...process.env, ...env } });
    return { out: JSON.parse(r.stdout), count: env.ENNYN_FS_FAULT_DIR ? readFileSync(join(env.ENNYN_FS_FAULT_DIR, "fs-count"), "utf8") : null };
  };
  const box = () => mkdtempSync(join(tmpdir(), "en-fault-ctl-box-"));
  assert.deepEqual(go({}), { out: ["read", "read", "read", true], count: null }, "no variable: nothing wrapped");
  assert.deepEqual(go({ ENNYN_FS_FAULT_DIR: box(), ENNYN_FS_FAULT_AT: "0" }), { out: ["read", "read", "read", true], count: "3" }, "Ennyn's own file is not counted");
  assert.deepEqual(go({ ENNYN_FS_FAULT_DIR: box(), ENNYN_FS_FAULT_AT: "2", ENNYN_FS_FAULT: "eacces" }).out, ["read", "read", "EACCES", true]);
  assert.deepEqual(go({ ENNYN_FS_FAULT_DIR: box(), ENNYN_FS_FAULT_AT: "1", ENNYN_FS_FAULT: "eisdir" }).out, ["read", "EISDIR", "read", true]);
  assert.deepEqual(go({ ENNYN_FS_FAULT_DIR: box(), ENNYN_FS_FAULT_AT: "3", ENNYN_FS_FAULT: "eacces" }).out, ["read", "read", "read", false], "existsSync says false");
});

test("fault matrix control: the judge flags each way a run can hide a failure", () => {
  /** @param {Partial<Run>} r @returns {Run} */
  const R = (r) => ({ code: 0, signal: null, stdout: "", stderr: "", calls: 1, reads: [], ...r });
  const clean = R({ stdout: "Rework: 2 of 10 lines (20%)\nCo-change: src/a.js (3 commits)\n" });
  assert.equal(judge(clean, clean, false), null);
  assert.match(String(judge(clean, R({ stdout: "Rework: 0 of 10 lines (0%)\nCo-change: src/a.js (3 commits)\n" }), false)), /a number changed/);
  assert.match(String(judge(clean, R({ stdout: "Rework: 2 of 10 lines (20%)\n" }), false)), /parts dropped without saying so/);
  assert.match(String(judge(clean, R({ stdout: "Rework: 2 of 10 lines (20%)\nCo-change: none\n" }), false)), /changed without saying so/);
  assert.match(String(judge(clean, R({ stdout: "Rework: 2 of 10 lines (20%)\nCo-change: the log could not be found\n" }), false)), /changed without saying so/);
  assert.equal(judge(clean, R({ stdout: "Rework: 2 of 10 lines (20%)\nCo-change: unmeasured: git log failed\n" }), false), null);
  // doctor's count of its ? lines may rise by the ? lines the fault adds, and by nothing else. Any other number
  // that moves fails, also in a part that says unmeasured: a sentence's count, a --json field.
  const one = R({ stdout: "✓ budget: 1.0 KB\n? fix label: 3 commits, too few to judge\nproblems: 0 · warnings: 0 · unmeasured: 1\n" });
  assert.equal(judge(one, R({ stdout: "? budget: unmeasured: git failed\n? fix label: 3 commits, too few to judge\nproblems: 0 · warnings: 0 · unmeasured: 2\n" }), false), null, "one ? line more, the count one up");
  assert.match(String(judge(one, R({ stdout: "✓ budget: 1.0 KB\n? fix label: 3 commits, too few to judge\n? x: unmeasured: y\nproblems: 0 · warnings: 0 · unmeasured: 3\n" }), false)), /a number changed: "unmeasured: 3"/, "up by more than the ? lines added");
  assert.match(String(judge(one, R({ stdout: "✓ budget: 0.0 KB\n? fix label: 3 commits, too few to judge\nproblems: 0 · warnings: 0 · unmeasured: 2\n" }), false)), /a number changed: "✓ budget: 0\.0 KB"/);
  // Only the summary's own part is the count: a ? line may hold "unmeasured: <n>" of its own.
  assert.equal(judge(one, R({ stdout: "✓ budget: 1.0 KB\n? fix label: 3 commits, too few to judge\n? rules: unmeasured: 5 files could not be read\nproblems: 0 · warnings: 0 · unmeasured: 2\n" }), false), null);
  const two = R({ stdout: "? budget: unmeasured: x\n? fix label: 3 commits, too few to judge\nproblems: 0 · warnings: 0 · unmeasured: 2\n" });
  assert.match(String(judge(two, R({ stdout: "? budget: unmeasured: x\nproblems: 0 · warnings: 0 · unmeasured: 1\n" }), false)), /a number changed: "unmeasured: 1"/, "a ? line dropped, the count down");
  const left = (/** @type {number} */ n) => R({ stdout: `Rework: 2 of 10 lines (20%)\n${n} commits were left out unmeasured: their 30-day window has not closed.\n` });
  assert.match(String(judge(left(3), left(0), false)), /a number changed: "0 commits were left out unmeasured/);
  const steps = (/** @type {number} */ n) => R({ stdout: `Attempts: 9\n${n} failed attempts did not name the failing step (unmeasured, not clean).\n` });
  assert.match(String(judge(steps(5), steps(2), false)), /a number changed: "2 failed attempts/);
  const stats = (/** @type {number} */ n) => R({ stdout: JSON.stringify({ attempts: 4, unmeasuredDurations: n }, null, 2) });
  assert.match(String(judge(stats(1), stats(0), false)), /a number changed: "\\"unmeasuredDurations\\": 0"/);
  assert.match(String(judge(clean, R({ code: 1 }), false)), /a failure with no message/);
  assert.equal(judge(clean, R({ code: 1, stderr: "ennyn rework: git log failed" }), false), null);
  assert.equal(judge(clean, R({ code: 1, stdout: "✗ work graph: work graph g.json could not be read: EACCES\n" }), false), null, "doctor's ✗ line");
  assert.match(String(judge(clean, R({ code: 1, stdout: "✗ problems: 1\n" }), false)), /a failure with no message/, "a ✗ that does not say why");
  assert.match(String(judge(clean, R({ code: 2, stderr: "boom" }), false)), /exit 2/);
  assert.match(String(judge(R({}), R({ code: 1, stderr: "ennyn: cannot" }), true)), /the hook fails/);
  assert.match(String(judge(R({ code: 1, stderr: "x" }), R({ code: 0 }), false)), /exit 0 where the clean run exits 1/);
  assert.match(String(judge(clean, R({ stderr: "x\n    at f (file.mjs:1:2)" }), false)), /a stack trace/);
  // A hook's JSON is judged as the text Claude Code shows.
  const ctx = (/** @type {string} */ text) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
  const hook = R({ stdout: ctx("Rules that apply to src/a.js:\n\nKeep add pure.") });
  assert.match(String(judge(hook, R({ stdout: "" }), false)), /parts dropped without saying so/);
  assert.equal(judge(hook, R({ stdout: ctx("These rule files could not be read, so whether they apply to src/a.js was not checked: r.md") }), false), null);
  // A --json report is judged line by line: a number that changes is caught even when stderr says why.
  const json = R({ stdout: JSON.stringify({ attempts: 4, failed: 1 }, null, 2) });
  assert.match(String(judge(json, R({ stdout: JSON.stringify({ attempts: 0, failed: 0 }, null, 2), stderr: "log could not be read" }), false)), /a number changed/);
});
