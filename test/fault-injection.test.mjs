/**
 * Every CLI command, run with git failing under it. A fake git on PATH counts the calls of a run and
 * makes the k-th one fail (exit 128 with a message) or die (SIGKILL), for every k a clean run makes
 * (SIGKILL at the first and the last: the code takes the same branch for both ways a git ends badly), or
 * never end (at the first and the last: a process it started holds its output, and the run's limits are
 * lowered to seconds); then git is missing altogether. A run must fail (non-zero exit, a message,
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
 * A git that cannot start is the system's answer, so it comes from the preload, not from the fake git: the k-th
 * spawn fails with an errno, for every k of the commit-msg hook's runs, and the two errnos a commit can pick refuse.
 *
 * The same for files: test/fault-fs.mjs, loaded into every run, counts the file reads outside Ennyn's own
 * files and fails the k-th, as a file without permission (EACCES) and as a directory in its place (EISDIR),
 * for every k. The Claude Code hooks run here too, given their stdin; their JSON output is judged as the
 * text Claude Code shows, and exit 2 (blocking) is right only where the clean run holds a compaction: a fault
 * never makes a hook block.
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
    // ENNYN_FAULT_MATCH: the call whose arguments hold it never ends, wherever it comes.
    'if [ -n "$ENNYN_FAULT_MATCH" ]; then case " $* " in *"$ENNYN_FAULT_MATCH"*) sleep 3600 & echo $! >> "$ENNYN_FAULT_DIR/held"; wait ;; esac; fi',
    'n=$(( $(cat "$ENNYN_FAULT_DIR/count" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$ENNYN_FAULT_DIR/count"',
    'if [ "$n" = "$ENNYN_FAULT_AT" ]; then',
    '  case "$ENNYN_FAULT" in',
    '    fail) echo "fatal: injected failure" >&2; exit 128 ;;',
    "    kill) kill -KILL $$ ;;",
    // Never ends: a process it starts holds its output, and it waits on that process.
    '    hang) sleep 3600 & echo $! >> "$ENNYN_FAULT_DIR/held"; wait ;;',
    "  esac",
    "fi",
    'exec "$ENNYN_REAL_GIT" "$@"',
    "",
  ].join("\n"),
);
chmodSync(join(FAKE, "git"), 0o755);
/** A hung git's limit in a run (test/fault-fs.mjs lowers Ennyn's to it); a call that walks the history gets twice that. */
const HANG_LIMIT_MS = 2000;
/** A run with a hung git still going after this was never stopped: it is killed, and its cell fails. */
const HANG_WATCHDOG_MS = 120_000;
const NOT_STOPPED = "fault matrix: the run still waited on its hung git when the watchdog killed it";

/** Ends the processes the hung fake gits of a run left holding their output. @param {string} box @returns {number} how many */
function endHeld(box) {
  let pids = /** @type {number[]} */ ([]);
  try {
    pids = readFileSync(join(box, "held"), "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    // No git hung.
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return pids.length;
}

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
// An entry with no resolved URL (its registry from the .npmrc beside the lock) and a link into the project (the
// index asked for what it holds): both reads have an answer to lose.
const LOCK = (/** @type {Record<string, unknown>} */ extra = {}) =>
  `${JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" }, "node_modules/left": { version: "1.0.0", resolved: `${OSV_ORIGIN}/left/-/left-1.0.0.tgz`, integrity: "sha512-x" }, "node_modules/bare": { version: "1.0.0", integrity: "sha512-x" }, "node_modules/ws": { resolved: "packages/ws", link: true }, ...extra } }, null, 2)}\n`;
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
  ".npmrc": `registry=${OSV_ORIGIN}/\n`,
  "packages/ws/package.json": "{}\n",
  "packages/ws2/package.json": "{}\n",
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
  // Ask rules doctor finds committed: a read or a git call that fails there must be said, never judged.
  ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)", "PowerShell(git push *)", "Bash(npm publish *)", "PowerShell(npm publish *)"] } }),
  // Agent worktrees ignored by a tracked .gitignore, which doctor finds: a git call that fails there must be said.
  ".gitignore": ".claude/worktrees/\n",
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
commit(5, "feat: use add twice", {
  "src/use.js": 'import { add } from "./add.js";\nexport const three = add(1, 2);\nexport const four = add(2, 2);\n',
  // A class registry whose gates doctor checks against the history, the tree and a removal's commit: a read or a git call that fails there must be said.
  ".ennyn/classes.json": JSON.stringify({ classes: [
    { id: "add-loses-numbers", says: "A sum is no number.", state: "closed-gate", gates: [{ commit: FIX, file: "test/add.test.js", action: "past-defects", proof: "The test adds." }] },
    { id: "add-had-a-place", says: "A place held the mistake.", state: "closed-design", gates: [{ commit: FIX, file: "test/add.test.js", action: "remove-the-place", proof: "The place went." }] },
  ] }),
  // A findings ledger whose rows need every git call the count makes: a row with an age past the start, a test the tree must hold.
  ".ennyn/findings.jsonl": `${[
    { round: 1, id: "c1-add-1", source: "first-write", caughtBy: "test:test/add.test.js", fingerprint: "sum read as a number", bornIn: null },
    { round: 1, id: "c1-add-2", source: "pre-existing", caughtBy: "test:test/add.test.js", fingerprint: "sum not checked", bornIn: FIX },
  ].map((row) => JSON.stringify({ cycle: 1, task: "add", severity: "low", class: ["add-loses-numbers"], dupOf: null, trigger: "a word for a number", escapePoint: "none", outcome: "open", commit: null, file: "src/add.js", line: 1, ...row })).join("\n")}\n`,
});
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

/**
 * A transcript of the session, in the shape Claude Code writes, whose last Edit lies `after` seconds past HEAD's
 * commit time; nothing else in the copy is newer than that commit by more than the fixture's own changes.
 * @param {string} repo @param {string} file @param {number} after
 */
function compactCase(repo, file, after) {
  // The session reads as idle: its last reply lies more than the gap ago, and the tree is clean. Held, the commit lies
  // two hours back, so the reply's Edit is later than it; at a boundary the commit stays where it is, later than the reply.
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "a clean tree"], { cwd: repo });
  const now = Math.floor(Date.now() / 1000);
  if (after > 0) git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "--no-edit", "--no-verify", "--date", `${now - 7200} +0000`], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: `${now - 7200} +0000` } });
  const timestamp = new Date((now - 7200 + after) * 1000).toISOString();
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 299000, output_tokens: 0 };
  writeFileSync(join(repo, ".git", "s1.jsonl"), `${JSON.stringify({ isSidechain: false, type: "user", promptId: "p1", message: { role: "user", content: "go" } })}\n${JSON.stringify({ isSidechain: false, type: "assistant", timestamp, message: { model: "claude-opus-5-5", stop_reason: "end_turn", usage, content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] } })}\n`);
}

/** What the hook prints on every pass that read the tree: a fault that only stops the hold still has to say so, on stderr. */
const COMPACT_ASK = /^Ennyn asks this of the summary: /;

/** @param {string} repo */
const compactInput = (repo) => ({ trigger: "auto", session_id: "s1", prompt_id: "p1", cwd: repo, transcript_path: join(repo, ".git", "s1.jsonl") });

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
  writeFileSync(join(repo, "package-lock.json"), LOCK({ "node_modules/nat": { version: "1.0.0", resolved: `${OSV_ORIGIN}/nat/-/nat-1.0.0.tgz`, integrity: "sha512-x", hasInstallScript: true }, "node_modules/bare2": { version: "1.0.0", integrity: "sha512-x" }, "node_modules/ws2": { resolved: "packages/ws2", link: true } }));
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
 * The cycle's worktrees, in the run's copy under its ignored .claude/worktrees/, so its path names them: one that can
 * go, one kept for an untracked file, one without the mark. A read or a git call that fails must keep a worktree.
 * @param {string} repo
 */
function worktrees(repo) {
  const at = (/** @type {string} */ name) => join(repo, ".claude", "worktrees", name);
  for (const [name, mark] of [["go", true], ["kept", true], ["plain", false]]) {
    git(["worktree", "add", "-q", "--detach", ...(mark ? ["--lock", "--reason", "ennyn:1"] : []), at(String(name))], { cwd: repo });
  }
  writeFileSync(join(at("kept"), "new.txt"), "n\n");
}

/**
 * A Claude Code session of the run's copy, in a config folder inside its git dir (CLAUDE_CONFIG_DIR): two subagents,
 * one asked sonnet and ran opus, one of the project's agent file (`checker`, which names no model). Every read of it
 * that fails must stop the command, saying so.
 * @param {string} repo
 */
function agentsSession(repo) {
  const folder = join(repo, ".git", "claude", "projects", realpathSync(repo).replace(/[^a-zA-Z0-9]/g, "-"));
  const said = (/** @type {string} */ id, /** @type {unknown[]} */ content) => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", usage: { output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, content } });
  const call = (/** @type {string} */ id, /** @type {Record<string, string>} */ input) => ({ type: "tool_use", id, name: "Agent", input });
  put(folder, {
    // The session ran at the copy's top: the project's agent file is read.
    "s1.jsonl": `${JSON.stringify({ type: "user", cwd: realpathSync(repo) })}\n${said("p1", [call("t1", { subagent_type: "general-purpose", model: "sonnet" }), call("t2", { subagent_type: "checker" })])}\n`,
    "s1/subagents/agent-a1.meta.json": JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, toolUseId: "t1" }),
    "s1/subagents/agent-a1.jsonl": `${said("m1", [])}\n`,
    "s1/subagents/agent-a2.meta.json": JSON.stringify({ agentType: "checker", isBuiltIn: false, toolUseId: "t2" }),
    "s1/subagents/agent-a2.jsonl": `${said("m2", [])}\n`,
  });
}

/**
 * A start record and the journal events `calls` gives, written by the CLI as the orchestrator writes them; the start
 * record's time and each event's time are set to one value, so every run reads the same.
 * @param {string} repo @param {string[][]} calls
 */
function journal(repo, calls) {
  for (const args of [["leftovers", "--start"], ...calls.map((c) => ["journal", ...c])]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  }
  const at = "2026-01-01T00:00:00.000Z";
  const dir = join(repo, ".git", "ennyn");
  const record = join(dir, "cycle-start.json");
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), at }));
  const log = join(dir, "cycle-journal.jsonl");
  if (calls.length) {
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => ({ ...JSON.parse(l), at, ...(l.includes('"startAt"') ? { startAt: at } : {}) }));
    writeFileSync(log, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  }
}

/**
 * @typedef {{ args: string[], noReads?: boolean, cwd?: string, writes?: boolean, setup?: (repo: string) => void, env?: Record<string, string>, first?: boolean, outside?: boolean, hook?: string, input?: (repo: string) => unknown, everyPass?: RegExp }} Case
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
  // Nothing on disk and an empty index on a branch with no commit: whether the project is new is read from the log of every ref.
  {
    args: ["init-scan"],
    setup: (repo) => {
      git(["checkout", "-q", "--orphan", "fresh"], { cwd: repo });
      git(["rm", "-r", "-q", "--cached", "."], { cwd: repo });
      git(["clean", "-f", "-d", "-x", "-q"], { cwd: repo });
    },
  },
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
  { args: ["core"], outside: true },
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
  { args: ["bypass"], noReads: true },
  { args: ["bypass", "--from", FIRST, "--json"], noReads: true },
  // No start recorded: the untracked part is unmeasured, the changes not committed are read; then a record is written,
  // and read back by the closing.
  { args: ["leftovers"] },
  { args: ["leftovers", "--json"] },
  { args: ["leftovers", "--start"], writes: true },
  {
    args: ["leftovers"],
    setup: (repo) => {
      const r = spawnSync(process.execPath, [CLI, "leftovers", "--start", "--json"], { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`leftovers --start: ${r.stderr}`);
      // The record's time is the setup's, which differs from run to run: one time for all.
      const record = String(JSON.parse(r.stdout).path);
      writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), at: "2026-01-01T00:00:00.000Z" }));
      writeFileSync(join(repo, "stray.txt"), "\n");
    },
  },
  // The cycle journal: a start needs the start record; status reads the journal, the record and the graph. A closed
  // cycle's time runs to its close, so it reads the same in every run; --line names no time.
  { args: ["journal", "start", "--cycle", "1", "--tasks", "T1"], writes: true, setup: (repo) => journal(repo, []) },
  { args: ["journal", "task", "T1", "--step", "review"], writes: true, setup: (repo) => journal(repo, [["start", "--cycle", "1", "--tasks", "T1"]]) },
  { args: ["status"], setup: (repo) => journal(repo, [["start", "--cycle", "1", "--release", "rel", "--tasks", "T1,T2"], ["task", "T1", "--step", "landed"], ["wait", "push"], ["close"]]) },
  { args: ["status", "--json"], setup: (repo) => journal(repo, [["start", "--cycle", "1", "--tasks", "T1"], ["close"]]) },
  { args: ["status", "--line"], setup: (repo) => journal(repo, [["start", "--cycle", "1", "--tasks", "T1"], ["task", "T1", "--round", "1"]]) },
  { args: ["status"] },
  { args: ["status"], outside: true },
  { args: ["mechanization"] },
  { args: ["mechanization"], cwd: "src", first: true },
  { args: ["classes"] },
  { args: ["classes", "--json"] },
  { args: ["classes"], cwd: "src", first: true },
  { args: ["classes"], outside: true },
  { args: ["convergence", "--cycle", "1", "--from", FIRST] },
  { args: ["convergence", "--cycle", "1", "--from", FIRST, "--json"] },
  { args: ["convergence", "--cycle", "1", "--from", FIRST], cwd: "src", first: true },
  { args: ["convergence", "--cycle", "1"], outside: true },
  { args: ["core", "--json"] },
  // The metrics log holds one budget record with no mark: the security audit is due, and the paths are read.
  { args: ["audit"] },
  { args: ["audit", "--json"] },
  // A mark reads the count first: a failed read there must not mark, or pass unsaid.
  { args: ["budget", "--record", "--security-audit"], writes: true },
  { args: ["mutate", ".git/mutants.json", "--command", `${NODE} .git/check.mjs`], writes: true },
  { args: ["mutate", "--restore"], writes: true },
  // The fetch writes the copy's git dir. Ahead of its upstream by a commit that changes code: the record holds no run.
  { args: ["push-check"], writes: true },
  // A run recorded by HEAD's tree: each read of the tree before and after it must be said, never recorded.
  {
    args: ["test", "fast"],
    writes: true,
    setup: (repo) => {
      const path = join(repo, ".ennyn", "config.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), commands: { fastTest: `${NODE} -e 0` } }));
      git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-am", "chore: fast test"], { cwd: repo });
    },
  },
  { args: ["worktrees"], setup: (repo) => worktrees(repo) },
  { args: ["worktrees", "--remove"], writes: true, setup: (repo) => worktrees(repo) },
  { args: ["gate-record", "--start", START, "--exit", "0", "--commit", "HEAD"], writes: true },
  { args: ["gate-record", "--start", START, "--exit", "1"], writes: true },
  { args: ["gate-stats"] },
  { args: ["gate-stats", "--json"] },
  { args: ["agents"], setup: agentsSession, env: { CLAUDE_CONFIG_DIR: ".git/claude" } },
  { args: ["agents", "--json"], setup: agentsSession, env: { CLAUDE_CONFIG_DIR: ".git/claude" } },
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
  // The PreCompact hook: holding a compaction in the clean run, so a fault must let it through and say so; and at a
  // commit boundary, where a fault may never hold one.
  {
    args: ["hook:compact-boundary", "mid-task"],
    hook: "compact-boundary.mjs",
    setup: (repo) => compactCase(repo, join(repo, "src", "add.js"), 60),
    input: compactInput,
    everyPass: COMPACT_ASK,
  },
  {
    args: ["hook:compact-boundary", "boundary"],
    hook: "compact-boundary.mjs",
    setup: (repo) => {
      git(["reset", "-q", "--hard"], { cwd: repo });
      compactCase(repo, join(repo, "src", "add.js"), -3600);
    },
    input: compactInput,
    everyPass: COMPACT_ASK,
  },
  // The push hook: refused in the clean run, reading no file of the project and asking git nothing, so no fault may turn it into a pass.
  {
    args: ["hook:push-spellings"],
    hook: "push-spellings.mjs",
    input: (repo) => ({ tool_name: "Bash", tool_input: { command: "git -C . push", description: "x" }, session_id: "s1", cwd: repo }),
  },
  // The kill hook: the same, refused in the clean run, reading no file of the project.
  {
    args: ["hook:kill-targets"],
    hook: "kill-targets.mjs",
    input: (repo) => ({ tool_name: "Bash", tool_input: { command: 'taskkill //F //FI "WINDOWTITLE eq *"', description: "x" }, session_id: "s1", cwd: repo }),
  },
  // The plugin's version record and the session's variable: a plugin version, a data directory and an env file
  // of their own in each run's copy.
  {
    args: ["hook:plugin-root"],
    hook: "plugin-root.mjs",
    setup: (repo) => put(repo, { ".git/plugin/scripts/ennyn.mjs": "\n", ".git/session-env": "" }),
    env: { CLAUDE_PLUGIN_ROOT: ".git/plugin", CLAUDE_PLUGIN_DATA: ".git/plugin-data", CLAUDE_ENV_FILE: ".git/session-env" },
    input: (repo) => ({ source: "startup", session_id: "s1", cwd: repo }),
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
 * @typedef {{ code: number | null, signal: string | null, stdout: string, stderr: string, calls: number, reads: string[], hung: number }} Run
 * @typedef {{ at?: number, kind?: "fail" | "kill" | "hang", match?: string, noGit?: boolean, closed?: boolean, read?: { at: number, kind: "eacces" | "eisdir" }, spawn?: { at: number, code: string } }} Fault
 *   `match`: with kind "hang", the call whose arguments hold it hangs instead of the at-th. `spawn`: the at-th git
 *   spawn fails with the errno `code` (test/fault-fs.mjs).
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
    ENNYN_SPAWN_FAULT_AT: String(fault.spawn?.at ?? 0),
    ENNYN_SPAWN_FAULT: fault.spawn?.code ?? "",
    ...(fault.kind === "hang" ? { ENNYN_FAULT_GIT_LIMIT_MS: String(HANG_LIMIT_MS) } : {}),
    ...(fault.match ? { ENNYN_FAULT_MATCH: fault.match } : {}),
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
    // A run that waits on its hung git past every limit would hold the matrix for an hour.
    const watchdog = fault.kind === "hang" ? setTimeout(() => ((stderr += `\n${NOT_STOPPED}`), child.kill("SIGKILL")), HANG_WATCHDOG_MS) : null;
    child.on("close", (code, signal) => {
      if (watchdog) clearTimeout(watchdog);
      const hung = endHeld(box);
      let calls = 0;
      try {
        calls = Number(readFileSync(join(box, "count"), "utf8"));
      } catch {
        // No git call.
      }
      // A copy's own path, the mutate timings and the side-copy hook's rule markers (a token drawn for each text)
      // differ from run to run.
      const norm = (/** @type {string} */ s) =>
        s
          .split(repo)
          .join("<repo>")
          .replace(/^Tests pass without mutants in .*$/gm, "<baseline>")
          .replace(/(<\/?rule-)[0-9a-f]{12}\b/g, "$1<token>");
      let reads = "";
      try {
        reads = readFileSync(join(box, "fs-calls"), "utf8");
      } catch {
        // Killed before its exit handler.
      }
      done({ code, signal, stdout: norm(stdout), stderr: norm(stderr), calls, reads: norm(reads).split("\n").filter(Boolean), hung });
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
 * @param {RegExp} [everyPass] a line the command prints on any run that passes, and so says nothing of a fault
 */
function judge(clean, got, hook, everyPass) {
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
  const changed = [...after].filter((p) => !before.has(p) && !everyPass?.test(p));
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

test("fault matrix: with any git call failing, killed or never ending, or no git at all, a command fails or says so; a closed pipe is no crash", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const clean = await pool(CASES.map((c) => () => run(c, {})), width);
  for (const [i, c] of CASES.entries()) assert.ok(c.hook || clean[i].calls > 0, `${c.args.join(" ")} calls git`);
  /** @type {{ c: Case, i: number, fault: Fault }[]} */
  const cells = [];
  for (const [i, c] of CASES.entries()) {
    const last = c.first ? 1 : clean[i].calls;
    for (let at = 1; at <= last; at++) cells.push({ c, i, fault: { at, kind: "fail" } });
    for (const at of new Set([1, last])) cells.push({ c, i, fault: { at, kind: "kill" } }, { c, i, fault: { at, kind: "hang" } });
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
      if (got.stderr.includes(NOT_STOPPED)) return { cell, why: "git was never stopped: the run still waited on it" };
      return { cell, why: judge(clean[cell.i], got, cell.c.args.includes("--hook"), cell.c.everyPass) };
    })
    .filter((r) => r.why)
    .map((r) => `${where(r.cell.c)} · ${r.cell.fault.noGit ? "no git" : r.cell.fault.closed ? "closed stdout" : `git call ${r.cell.fault.at} ${r.cell.fault.kind}`}: ${r.why}`);
  assert.deepEqual(bad, [], `${bad.length} of ${cells.length} cells`);
});

test("fault matrix: a git that cannot start, for any errno but the two a commit can pick, lets the commit through, saying so", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const hooks = CASES.filter((c) => c.args?.includes("--hook"));
  const clean = await pool(hooks.map((c) => () => run(c, {})), width);
  /** @type {{ c: Case, i: number, fault: Fault }[]} */
  const cells = [];
  for (const [i, c] of hooks.entries()) {
    for (let at = 1; at <= clean[i].calls; at++) cells.push({ c, i, fault: { spawn: { at, code: "EPERM" } } });
    for (const code of ["ENFILE", "EIO", "ETXTBSY", "ENOEXEC", "ENOSPC"]) for (const at of new Set([1, clean[i].calls])) cells.push({ c, i, fault: { spawn: { at, code } } });
  }
  const results = await pool(cells.map((cell) => () => run(cell.c, cell.fault)), width);
  const bad = cells
    .map((cell, k) => ({ cell, why: judge(clean[cell.i], results[k], true, cell.c.everyPass) }))
    .filter((r) => r.why)
    .map((r) => `${r.cell.c.args.join(" ")} · spawn ${r.cell.fault.spawn?.at} ${r.cell.fault.spawn?.code}: ${r.why}`);
  assert.deepEqual(bad, [], `${bad.length} of ${cells.length} cells`);
  // The control: E2BIG at the same calls refuses, so these faults reach the gates' reads.
  const i = hooks.findIndex((c) => clean[hooks.indexOf(c)].calls > 0 && clean[hooks.indexOf(c)].code === 0);
  const picked = await pool(Array.from({ length: clean[i].calls }, (_, k) => () => run(hooks[i], { spawn: { at: k + 1, code: "E2BIG" } })), width);
  assert.ok(picked.some((r) => r.code === 1 && /so this commit is refused/.test(r.stderr)), "no call refused for E2BIG");
});

/** The reads a directory in a file's place fails; the rest fail only as EACCES. */
const DIR_READS = /^(readFileSync|openSync) /;

test("fault matrix: with any file read failing (no permission, a directory in its place), a command fails or says so", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const clean = await pool(CASES.map((c) => () => run(c, {})), width);
  // A preload that stopped counting would leave no cells, and a green test.
  // And a command that reads none is held to that: `bypass` takes nothing from the work tree.
  for (const [i, c] of CASES.entries()) assert.equal(clean[i].reads.length > 0, !c.noReads, `${c.args.join(" ")} ${c.noReads ? "reads no file" : "reads files"}`);
  /** @type {{ c: Case, i: number, fault: Fault, call: string }[]} */
  const cells = [];
  for (const [i, c] of CASES.entries()) {
    clean[i].reads.forEach((call, k) => cells.push({ c, i, fault: { read: { at: k + 1, kind: "eacces" } }, call }));
    clean[i].reads.filter((call) => DIR_READS.test(call)).forEach((call, k) => cells.push({ c, i, fault: { read: { at: k + 1, kind: "eisdir" } }, call }));
  }
  const results = await pool(cells.map((cell) => () => run(cell.c, cell.fault)), width);
  const where = (/** @type {Case} */ c) => `${c.args.join(" ")}${c.cwd ? ` (in ${c.cwd}/)` : ""}${c.setup ? " (set up)" : ""}${c.outside ? " (no repository)" : ""}`;
  const bad = cells
    .map((cell, k) => ({ cell, why: judge(clean[cell.i], results[k], cell.c.args.includes("--hook"), cell.c.everyPass) }))
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

/**
 * The calls that walk the history or the whole tree, by the command that makes them and the arguments that tell the
 * call apart: each gets the longer limit (GIT_LIMITS.walk). The commit path's reads of the log are bounded (500 and
 * 300 commits) and keep the call limit: a commit waits on them.
 * @type {[Case, string, "walk" | "call"][]}
 */
const LIMITED = [
  [{ args: ["rework"] }, " log --no-merges --format=%ct %H ", "walk"],
  [{ args: ["rework"] }, " blame ", "walk"],
  // Asked of a shallow clone's edge.
  [{ args: ["rework"], setup: (repo) => writeFileSync(join(repo, ".git", "shallow"), `${FIX}\n`) }, " merge-base --is-ancestor ", "walk"],
  [{ args: ["bypass", "--from", FIRST] }, " merge-base --is-ancestor ", "walk"],
  [{ args: ["bypass", "--from", FIRST] }, " log --no-merges --format=x%ct ", "walk"],
  [{ args: ["bypass", "--from", FIRST] }, " log --merges ", "walk"],
  [{ args: ["bypass", "--from", FIRST] }, " --grep=", "walk"],
  // Asked of a shallow clone, from its edge: whether the range reaches past it.
  [{ args: ["bypass", "--from", FIX], setup: (repo) => writeFileSync(join(repo, ".git", "shallow"), `${FIX}\n`) }, " rev-list ", "walk"],
  [{ args: ["impact", "--symbol", "add", "--files", "src/add.js"] }, " grep --no-color ", "walk"],
  [{ args: ["impact", "--symbol", "add", "--files", "src/add.js"] }, " log --no-merges --full-diff ", "walk"],
  [{ args: ["init-scan"] }, " grep --cached ", "walk"],
  [{ args: ["push-check"], writes: true }, " rev-list --count ", "walk"],
  [{ args: ["push-check"], writes: true }, " fetch ", "walk"],
  [{ args: ["commit-check", "--hook", ".git/AMEND"], setup: (repo) => git(["reset", "-q"], { cwd: repo }) }, " log -n501 ", "call"],
  [{ args: ["doctor"] }, " log -z --no-merges ", "call"],
];

test("fault matrix: a call that walks the history or the whole tree gets the longer limit, the commit path's reads of the log the shorter one", async () => {
  const width = Math.max(2, Math.min(8, availableParallelism()));
  const runs = await pool(
    LIMITED.map(([c, match]) => () => run(c, { kind: "hang", match })),
    width,
  );
  const wrong = LIMITED.flatMap(([c, match, limit], k) => {
    const r = runs[k];
    const text = `${r.stdout}\n${r.stderr}`;
    const want = `did not finish in ${(limit === "walk" ? 2 * HANG_LIMIT_MS : HANG_LIMIT_MS) / 1000} s and was stopped`;
    if (!r.hung) return [`${c.args.join(" ")} ·${match}: no such call`];
    return text.includes(want) ? [] : [`${c.args.join(" ")} ·${match}: wanted "${want}", got ${JSON.stringify(text.split("\n").filter((l) => l.includes("was stopped")))}`];
  });
  assert.deepEqual(wrong, []);
});

test("fault matrix: a file git is slow to diff is named unread, and every other file is still scanned and judged", async () => {
  // git computes a file's whole diff before it writes any of it: 4 MB of short lines reordered took 5.8 s at load 7
  // and 50 s at load 75, past the 2 s limit of this run. Real git, real content.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "en-fault-slow-")));
  git(["init", "-q", "-b", "main"], { cwd: repo });
  const lines = Array.from({ length: 600_000 }, (_, i) => `L${i.toString(36).padStart(5, "0")}`);
  // A secret HEAD already holds, which the reordering moves: no new one.
  lines.push(`const old = "${TOKENS.npm}";`);
  put(repo, {
    ".ennyn/config.json": JSON.stringify({ language: "en", review: { forbidden: [{ text: "BANNED", paths: ["**"] }] } }),
    "a.txt": "one\n",
    "big.txt": `${lines.join("\n")}\n`,
    "y.txt": "one\n",
    "z.txt": "one\n",
  });
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "feat: start"], { cwd: repo });
  let seed = 7;
  for (let i = lines.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = Math.floor((seed / 2147483648) * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  // A token before the slow file, one in it and one after it, one in a file the commit adds, a ban after it.
  put(repo, {
    "a.txt": `one\nconst a = "${TOKENS.github}";\n`,
    "big.txt": `${lines.join("\n")}\nconst big = "${TOKENS.github}";\n`,
    "new.txt": `const n = "${TOKENS.npm}";\n`,
    "y.txt": "one\nBANNED\n",
    "z.txt": `one\nconst z = "${TOKENS.github}";\n`,
  });
  git(["add", "-A"], { cwd: repo });
  writeFileSync(join(repo, "MSG"), "feat: add a thing\n");
  const hook = () => {
    const r = spawnSync(process.execPath, ["--import", FAULT_FS, CLI, "commit-check", "--hook", "MSG"], {
      cwd: repo,
      env: { ...process.env, ENNYN_FAULT_GIT_LIMIT_MS: String(HANG_LIMIT_MS) },
      encoding: "utf8",
      timeout: 300_000,
      killSignal: "SIGKILL",
    });
    return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
  };
  const { status, text } = hook();
  assert.equal(status, 1, `refused:\n${text}`);
  assert.doesNotMatch(text, /did not show/);
  // review.forbidden names the slow file unread, with the limit that stopped it. The secret scan reads it whole
  // instead, old and new objects: the token it adds is refused, the one HEAD already held is not.
  assert.match(text, /review\.forbidden was not checked in 1 staged path\(s\) \("big\.txt"\): git diff: did not finish in 2 s and was stopped/);
  assert.doesNotMatch(text, /security\.secrets was not checked/);
  // Four places, three shown: the slow file's is checked on the run below.
  assert.match(text, /and 1 more adds what reads as a secret/);
  // Every other file judged: the tokens before and after it and in the added file, the ban after it.
  for (const path of ["a.txt", "z.txt", "new.txt"]) assert.match(text, new RegExp(`${path.replace(".", "\\.")}:\\d+`), `${path}: a token refused\n${text}`);
  assert.match(text, /y\.txt:2 adds "BANNED"/, `y.txt: the ban refused\n${text}`);
  // With only changed files, all past one call's size: still a call of its own for the slow one.
  git(["rm", "-q", "--cached", "new.txt"], { cwd: repo });
  const changed = hook();
  assert.equal(changed.status, 1, `refused:\n${changed.text}`);
  assert.match(changed.text, /big\.txt:600002 \(github-token/);
  assert.doesNotMatch(changed.text, /big\.txt:\d+ \(npm-token/);
  assert.match(changed.text, /z\.txt:2 \(github-token/);
});

test("fault matrix: a diff that stops after its output is read again whole, and each secret it held is named once", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "en-fault-again-")));
  git(["init", "-q", "-b", "main"], { cwd: repo });
  put(repo, { ".ennyn/config.json": JSON.stringify({ language: "en" }), "a.txt": "one\n", "b.txt": "two\n" });
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "feat: start"], { cwd: repo });
  put(repo, { "a.txt": `one\nconst a = "${TOKENS.github}";\n`, "b.txt": `two\nconst b = "${TOKENS.npm}";\n` });
  git(["add", "-A"], { cwd: repo });
  writeFileSync(join(repo, "MSG"), "feat: add a thing\n");
  // The streamed diff writes all it has, then a process it started holds the output.
  const bin = mkdtempSync(join(tmpdir(), "en-fault-again-bin-"));
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    'case " $* " in *" -U0 --src-prefix=a/ "*) "$ENNYN_REAL_GIT" "$@"; sleep 3600 & echo $! >> "$ENNYN_FAULT_DIR/held"; wait; exit 0 ;; esac',
    'exec "$ENNYN_REAL_GIT" "$@"',
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const r = spawnSync(process.execPath, ["--import", FAULT_FS, CLI, "commit-check", "--hook", "MSG"], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ENNYN_REAL_GIT: REAL_GIT, ENNYN_FAULT_DIR: bin, ENNYN_FAULT_GIT_LIMIT_MS: String(HANG_LIMIT_MS) },
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  assert.ok(endHeld(bin) > 0, "the streamed diff was held");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.split("a.txt:2 (github-token").length - 1, 1, r.stderr);
  assert.equal(r.stderr.split("b.txt:2 (npm-token").length - 1, 1, r.stderr);
});

// ----------------------------------------------------------------------------------- positive controls --

test("fault matrix control: a git call that never ends is stopped at its limit and fails naming the command and the limit, also when a process it started holds its output; one that keeps writing is not stopped", async (t) => {
  // A git that starts a process holding its output, then waits on it, or exits with ENNYN_HANG_EXIT and leaves the
  // output held (cycle 11: a cat-file whose stdin never ended held the commit for 16 minutes). ENNYN_HANG_SAY is
  // written first; ENNYN_HANG_TRAP ignores SIGTERM; ENNYN_HANG_DRIP leaves a mark in "dripped", writes a line every 0.1 s
  // for 1.5 s to stdout (out) or stderr (err), and ends; ENNYN_HANG_FIRST ends it at once; ENNYN_HANG_SLOW makes the first
  // run of its value wait in silence, as a git that has not started does.
  const hang = join(BIN, "hang");
  mkdirSync(hang, { recursive: true });
  writeFileSync(
    join(hang, "git"),
    [
      "#!/bin/sh",
      'if [ -n "$ENNYN_HANG_FIRST" ]; then exit 0; fi',
      'if [ -n "$ENNYN_HANG_SLOW" ] && [ ! -e "$ENNYN_FAULT_DIR/slow-$ENNYN_HANG_SLOW" ]; then : > "$ENNYN_FAULT_DIR/slow-$ENNYN_HANG_SLOW"; exec sleep 3600; fi',
      `if [ -n "$ENNYN_HANG_DRIP" ]; then exec perl -e '$| = 1; open(my $m, ">>", "$ENV{ENNYN_FAULT_DIR}/dripped"); print $m "x"; close $m; my $to = $ENV{ENNYN_HANG_DRIP} eq "err" ? *STDERR : *STDOUT; for (1 .. 15) { print $to "line $_\\n"; select(undef, undef, undef, 0.1) }'; fi`,
      "if [ -n \"$ENNYN_HANG_TRAP\" ]; then trap '' TERM; fi",
      "printf '%b' \"$ENNYN_HANG_SAY\"",
      "sleep 3600 &",
      'echo $! >> "$ENNYN_FAULT_DIR/held"',
      'if [ -n "$ENNYN_HANG_EXIT" ]; then exit "$ENNYN_HANG_EXIT"; fi',
      "wait",
      "",
    ].join("\n"),
  );
  chmodSync(join(hang, "git"), 0o755);
  // macOS holds the first run of a new file until a system check has read it (cycle 17): 0.2 to 0.9 s alone, 7 s behind
  // 25 other new files at load 15, 17 s behind 60, 4 ms from then on. Beside the suite's own new files the limits below
  // fell on a git whose shell had not reached its first line. So that run is had here, under no limit.
  const firstAt = performance.now();
  const first = spawnSync(join(hang, "git"), [], { env: { ...process.env, ENNYN_HANG_FIRST: "1" }, timeout: HANG_WATCHDOG_MS, killSignal: "SIGKILL" });
  assert.equal(first.status, 0, "the hung git did not start");
  t.diagnostic(`the first run of the hung git took ${Math.round(performance.now() - firstAt)} ms`);
  const box = mkdtempSync(join(tmpdir(), "en-fault-hang-"));
  const gitModule = JSON.stringify(new URL("../core/git.mjs", import.meta.url).href);
  // Each call alone, timed, with its own variables. A line handed on after a call failed is counted. The probe ends
  // by itself, and says what it still holds: a pipe, a child or a timer left behind. A limit that falls on a git that
  // has not started shows nothing about the call, and with processes slow to start it does (cycle 17: 2 of 12 runs at
  // load 71-91, the first run already had). So a git that did not reach its hang, or a steady one that was stopped, runs
  // again, up to five runs, and each run dropped is judged below: it must be that lost start and nothing else. Each call
  // is noted in "calls" as it goes, for a probe that does not end.
  const probe = `
    import { appendFileSync, readFileSync } from "node:fs";
    import { git, gitBytes, gitRun, gitMaybe, streamStagedBlobs, streamStagedDiff } from ${gitModule};
    const cwd = process.cwd();
    const out = {};
    let settled = false;
    let late = 0;
    const dropped = [];
    const onLine = () => void (settled && late++);
    const size = (file) => {
      try {
        return readFileSync(file, "utf8").length;
      } catch {
        return 0;
      }
    };
    const note = (text) => appendFileSync("calls", (performance.now() / 1000).toFixed(1) + " s: " + text + "\\n");
    async function once(name, vars, f) {
      note("on " + name);
      for (const k of ["ENNYN_HANG_EXIT", "ENNYN_HANG_SAY", "ENNYN_HANG_TRAP", "ENNYN_HANG_DRIP"]) delete process.env[k];
      Object.assign(process.env, vars);
      settled = false;
      const start = performance.now();
      try {
        const r = await f();
        out[name] = r && r.error
          ? { ms: performance.now() - start, said: r.error.message, message: r.error.message }
          : { ms: performance.now() - start, said: "answered: " + JSON.stringify(r, (k, v) => (v instanceof Set ? [...v] : v)) };
      } catch (e) {
        out[name] = { ms: performance.now() - start, said: String(e.stderr || e.message).split("\\n")[0], message: e.message, status: e.status ?? null };
      }
      settled = true;
      await new Promise((r) => setTimeout(r, 50));
      note(name + ": " + out[name].said);
    }
    async function call(name, vars, f) {
      for (let run = 1; run <= 5; run++) {
        const pids = size("held");
        const marks = size("dripped");
        await once(name, vars, f);
        if (vars.ENNYN_HANG_DRIP ? out[name].said.startsWith("answered") : size("held") > pids) return;
        dropped.push({ name, ...out[name], started: size("dripped") > marks });
      }
    }
    await call("bytes", {}, () => gitBytes(["cat-file", "--batch-check"], { cwd, input: "x\\n" }));
    await call("bytes, git exits 0", { ENNYN_HANG_EXIT: "0" }, () => gitBytes(["-c", "a.b=c", "ls-files", "-z"], { cwd }));
    await call("bytes, a walk", {}, () => git(["log"], { cwd, walk: true }));
    await call("bytes, git ignores SIGTERM", { ENNYN_HANG_TRAP: "1" }, () => gitBytes(["rev-parse", "HEAD"], { cwd }));
    await call("bytes, a walk, git exits 1", { ENNYN_HANG_EXIT: "1" }, () => git(["merge-base", "--is-ancestor", "a", "b"], { cwd, walk: true }));
    await call("run, a walk", {}, () => gitRun(["grep", "-e", "x"], { cwd, walk: true }));
    await call("run, git ignores SIGTERM", { ENNYN_HANG_TRAP: "1" }, () => gitRun(["grep", "-e", "x"], { cwd }));
    await call("run, git exits 1", { ENNYN_HANG_EXIT: "1" }, () => gitRun(["grep", "-e", "x"], { cwd }));
    await call("maybe, git exits with the absent code", { ENNYN_HANG_EXIT: "1" }, () => gitMaybe(["config", "--get", "x.y"], { cwd, absent: [1] }));
    await call("blobs", {}, () => streamStagedBlobs(cwd, [{ path: "a", oid: "0".repeat(40) }], { onLine }));
    await call("blobs, git ignores SIGTERM", { ENNYN_HANG_TRAP: "1" }, () => streamStagedBlobs(cwd, [{ path: "a", oid: "0".repeat(40) }], { onLine }));
    await call("diff, git exits 0", { ENNYN_HANG_EXIT: "0" }, () => streamStagedDiff(cwd, null, { onLine }));
    await call("diff, a line with no end, then silence", { ENNYN_HANG_EXIT: "0", ENNYN_HANG_SAY: "diff --git a/x b/x\\\\n+++ b/x\\\\n@@ -0,0 +1 @@\\\\n+partial" }, () => streamStagedDiff(cwd, null, { onLine }));
    await call("diff, steady output", { ENNYN_HANG_DRIP: "out" }, () => streamStagedDiff(cwd, null, { onLine }));
    await call("diff, steady warnings", { ENNYN_HANG_DRIP: "err" }, () => streamStagedDiff(cwd, null, { onLine }));
    await call("bytes, a first run that does not start", { ENNYN_HANG_SLOW: "hang" }, () => gitBytes(["show"], { cwd }));
    await call("diff, steady output, a first run that does not start", { ENNYN_HANG_SLOW: "steady", ENNYN_HANG_DRIP: "out" }, () => streamStagedDiff(cwd, null, { onLine }));
    out.late = late;
    out.dropped = dropped;
    out.held = process.getActiveResourcesInfo();
    process.stdout.write(JSON.stringify(out));
  `;
  const env = { ...process.env, PATH: `${hang}${delimiter}${process.env.PATH}`, ENNYN_FAULT_DIR: box, ENNYN_FAULT_GIT_LIMIT_MS: "1000" };
  writeFileSync(join(box, "calls"), "");
  /** @type {{ code: number | null, stdout: string, stderr: string }} */
  const got = await new Promise((done) => {
    const child = spawn(process.execPath, ["--import", FAULT_FS, "--input-type=module", "-e", probe], { cwd: box, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // Under the guard runner's own limit (three times its baseline, at least the baseline plus 30 s): a guard that makes
    // a call hang fails here. A slow machine can end here too: what it got through tells the two apart.
    const watchdog = setTimeout(() => ((stderr += "\nthe probe had not ended after 45 s, and was killed"), child.kill("SIGKILL")), 45_000);
    child.on("close", (code) => (clearTimeout(watchdog), done({ code, stdout, stderr })));
  });
  const held = endHeld(box);
  const calls = readFileSync(join(box, "calls"), "utf8");
  assert.equal(got.code, 0, `${got.stderr}\nits calls, the last line where it was:\n${calls}`);
  const { late, held: resources, dropped, ...out } = JSON.parse(got.stdout);
  for (const d of dropped) t.diagnostic(`ran again: ${d.name}: ${d.said}, after ${Math.round(d.ms)} ms`);
  // Two lines a run, whatever a load did to how many ran.
  assert.equal(calls.split("\n").length - 1, 2 * (Object.keys(out).length + dropped.length), calls);
  /** @type {Record<string, string>} */
  const said = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, /** @type {{ said: string }} */ (v).said]));
  /** @type {Record<string, string>} */
  const wanted = {
    bytes: "git cat-file: did not finish in 1 s and was stopped",
    "bytes, git exits 0": "git ls-files: did not finish in 1 s and was stopped",
    "bytes, a walk": "git log: did not finish in 2 s and was stopped",
    "bytes, git ignores SIGTERM": "git rev-parse: did not finish in 1 s and was stopped",
    "bytes, a walk, git exits 1": "git merge-base: did not finish in 2 s and was stopped",
    "run, a walk": "git grep: did not finish in 2 s and was stopped",
    "run, git ignores SIGTERM": "git grep: did not finish in 1 s and was stopped",
    "run, git exits 1": "git grep: did not finish in 1 s and was stopped",
    "maybe, git exits with the absent code": "git config: did not finish in 1 s and was stopped",
    blobs: "git cat-file: wrote nothing for 1 s and was stopped",
    "blobs, git ignores SIGTERM": "git cat-file: wrote nothing for 1 s and was stopped",
    "diff, git exits 0": "git diff: wrote nothing for 1 s and was stopped",
    "diff, a line with no end, then silence": "git diff: wrote nothing for 1 s and was stopped",
    "diff, steady output": 'answered: {"shown":[],"stopped":false}',
    "diff, steady warnings": 'answered: {"shown":[],"stopped":false}',
    "bytes, a first run that does not start": "git show: did not finish in 1 s and was stopped",
    "diff, steady output, a first run that does not start": 'answered: {"shown":[],"stopped":false}',
  };
  assert.deepEqual(said, wanted);
  /** @param {string} k */
  const floor = (k) => (/a walk/.test(k) ? 1900 : 900);
  // Each waited out its limit: none failed early on something else.
  for (const [k, v] of Object.entries(out)) if (!k.startsWith("diff, steady")) assert.ok(/** @type {{ ms: number }} */ (v).ms >= floor(k), `${k}: ${JSON.stringify(v)}`);
  // The stop is the message too; a thrown error has no exit status to read as an answer (merge-base's 1 is "not an
  // ancestor"). gitRun hands back `error` beside git's own status, and its readers look at `error` first.
  for (const [k, v] of Object.entries(out)) {
    if (k.startsWith("diff, steady")) continue;
    const { said: text, message, status } = /** @type {{ said: string, message: string, status?: number | null }} */ (v);
    assert.deepEqual({ message, status }, { message: text, status: k.startsWith("run") ? undefined : null }, k);
  }
  // A run dropped was a limit that fell on a start, and shows it: the call's words, its whole limit, no exit status, and
  // for a steady git no mark, or a stream stopped while it wrote would pass on the next run.
  /** @param {{ name: string, said: string, message: string, status?: number | null, ms: number, started: boolean }} d */
  const fault = (d) => {
    const words = d.name.startsWith("diff, steady") ? "git diff: wrote nothing for 1 s and was stopped" : wanted[d.name];
    if (d.said !== words || d.message !== words) return "other words";
    if (d.status !== (d.name.startsWith("run") ? undefined : null)) return "an exit status";
    if (d.ms < floor(d.name)) return "before its limit";
    return d.started ? "it had started" : null;
  };
  const lost = { name: "blobs", said: wanted.blobs, message: wanted.blobs, status: null, ms: 1000, started: false };
  assert.deepEqual([{}, { said: "x" }, { message: "x" }, { status: 1 }, { ms: 5 }, { started: true }].map((o) => fault({ ...lost, ...o })), [null, "other words", "other words", "an exit status", "before its limit", "it had started"]);
  for (const d of dropped) assert.equal(fault(d), null, `a dropped run: ${JSON.stringify(d)}`);
  assert.equal(late, 0, "a line handed on after its call failed");
  // Its own stdout and stderr are pipes; a child, a timer or a pipe of a stopped git is held.
  assert.ok(resources.every((/** @type {string} */ r) => r === "PipeWrap") && resources.length <= 2, `the probe still holds ${resources}`);
  assert.equal(held, 14, "every call that should hang reached the hung git");
});

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
  const R = (r) => ({ code: 0, signal: null, stdout: "", stderr: "", calls: 1, reads: [], hung: 0, ...r });
  const clean = R({ stdout: "Rework: 2 of 10 lines (20%)\nCo-change: src/a.js (3 commits)\n" });
  assert.equal(judge(clean, clean, false), null);
  assert.match(String(judge(clean, R({ stdout: "Rework: 0 of 10 lines (0%)\nCo-change: src/a.js (3 commits)\n" }), false)), /a number changed/);
  assert.match(String(judge(clean, R({ stdout: "Rework: 2 of 10 lines (20%)\n" }), false)), /parts dropped without saying so/);
  // A line a pass always prints is no change, and says nothing: the fault must still be said.
  const held = R({ code: 2 });
  assert.equal(judge(held, R({ stdout: "Ask.\n", stderr: "could not be measured\n" }), false, /^Ask\./), null);
  assert.match(String(judge(held, R({ stdout: "Ask.\n" }), false, /^Ask\./)), /saying nothing/);
  assert.match(String(judge(held, R({ stdout: "Ask.\n", stderr: "could not be measured\n" }), false)), /changed without saying so/);
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
