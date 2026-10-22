/**
 * Every CLI command, run with git failing under it. A fake git on PATH counts the calls of a run and
 * makes the k-th one fail (exit 128 with a message) or die (SIGKILL, as a timeout kills a child), for
 * every k a clean run makes (SIGKILL at the first and the last: the code takes the same branch for both
 * ways a git ends badly); then git is missing altogether. A run must fail (non-zero exit, a message,
 * no stack trace), print exactly what the clean run prints (the failed call changed nothing), or say so
 * in every part it changed ("unmeasured", "could not be read", "was not checked"; a part is a line, or a
 * piece of one between " · ", "<br>" or "|"): never a number read from a call that failed (a part the
 * clean run has with other numbers fails even when it says unmeasured), and never a pass where the clean
 * run fails unless it says it did not check. The commit-msg hook fails open: it may not fail where the
 * clean run passes.
 * A closed stdout must end a command without a stack trace. Every command in USAGE needs a case, and a
 * read whose failure would change the result needs a case that reaches it (a config value, a hook's
 * index, a fold target, a sparse checkout, a subdirectory).
 *
 * Cycle 2026-10-20 (4) found this class 11 times, each by a reviewer or a loaded machine: a timeout, a
 * process that did not start, a check with no answer, a shallow range read as a result. The first run
 * of this matrix found 44 more: git calls that answered "nothing there" when they had failed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { USAGE } from "../scripts/ennyn.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const NODE = JSON.stringify(process.execPath);
/** What a changed line says when a value could not be measured (English: the fixture's language). */
const SAYS = /unmeasured|could not be (measured|read)|was not checked/i;

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
const ADD = "export function add(a, b) {\n  const sum = a + b;\n  const checked = Number(sum);\n  return checked;\n}\n";
git(["init", "-q", "-b", "main"], { cwd: REPO });
const FIRST = commit(0, "feat: add", {
  ".ennyn/config.json": JSON.stringify({
    language: "en",
    commitMsg: { types: ["feat", "fix", "chore"] },
    review: { impactRequiredGlobs: ["src/**"], cochange: [{ paths: ["src/**"], docs: ["README.md"] }] },
  }),
  ".ennyn/graph.json": JSON.stringify({
    nodes: [
      { id: "core-one", status: "planned", value: "high", cost: "S", needs: [] },
      { id: "gate-one", status: "planned", value: "medium", cost: "M", needs: [], mechanization: true },
    ],
    done: [{ id: "base", status: "done" }],
  }),
  "CLAUDE.md": "# Project\n\n- Every change keeps the tests green before it is committed.\n- Never write a secret into a file that is tracked.\n",
  "README.md": "# demo\n",
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
  ".git/mutants.json": JSON.stringify([{ id: "m1", file: "src/use.js", old: "add(2, 2)", new: "add(2, 3)" }]),
  ".git/check.mjs": 'import { readFileSync } from "node:fs";\nif (!readFileSync("src/use.js", "utf8").includes("add(2, 2)")) process.exit(1);\n',
});
// gate-record refuses a start more than a day before now: a minute ago.
const START = String(Math.floor(Date.now() / 1000) - 60);
for (const args of [["gate-record", "--start", START, "--exit", "1", "--step", "lint"], ["budget", "--record"]]) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: REPO, stdio: "ignore" });
}

// --------------------------------------------------------------------------------------------- cases --

/**
 * @typedef {{ args: string[], cwd?: string, writes?: boolean, setup?: (repo: string) => void, env?: Record<string, string>, first?: boolean, outside?: boolean }} Case
 *   `cwd` is relative to the repository; a case that writes, or has a setup, runs in a copy of its own.
 *   `env` values are paths relative to the repository. `first`: only the first git call is faulted (the
 *   one that finds the project directory; the case without `cwd` sweeps the rest). `outside`: the
 *   repository's files without its .git, so in no repository. A `--hook` case fails open.
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
  { args: ["mutate", ".git/mutants.json", "--command", `${NODE} .git/check.mjs`], writes: true },
  { args: ["mutate", "--restore"], writes: true },
  { args: ["push-check"] },
  { args: ["gate-record", "--start", START, "--exit", "0", "--commit", "HEAD"], writes: true },
  { args: ["gate-record", "--start", START, "--exit", "1"], writes: true },
  { args: ["gate-stats"] },
  { args: ["gate-stats", "--json"] },
];

test("fault matrix: every command in USAGE has a case", () => {
  const commands = [...USAGE.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 13, `commands read from USAGE: ${commands}`);
  const covered = new Set(CASES.map((c) => c.args[0]));
  assert.deepEqual(commands.filter((c) => !covered.has(c)), []);
});

/**
 * @typedef {{ code: number | null, signal: string | null, stdout: string, stderr: string, calls: number }} Run
 * @typedef {{ at?: number, kind?: "fail" | "kill", noGit?: boolean, closed?: boolean }} Fault
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
  };
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...c.args], { cwd: join(repo, c.cwd ?? ""), env, stdio: ["ignore", "pipe", "pipe"] });
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
      done({ code, signal, stdout: norm(stdout), stderr: norm(stderr), calls });
    });
  });
}

/** The parts of an output: its lines, each cut at " · ", "<br>" and "|" (table cells). @param {Run} r */
const parts = (r) => [r.stdout, r.stderr].join("\n").split("\n").flatMap((l) => l.split(/ · |<br>|\|/)).map((p) => p.trim()).filter(Boolean);
/** @param {string} s */
const digits = (s) => s.replace(/\d+(\.\d+)?/g, "#");

/**
 * What is wrong with a faulted run, measured against the clean one; null when nothing is.
 * @param {Run} clean @param {Run} got @param {boolean} hook a commit-msg hook run, which fails open
 */
function judge(clean, got, hook) {
  if (/^\s+at .+:\d+:\d+\)?$/m.test(got.stderr)) return "a stack trace";
  const same = got.stdout === clean.stdout && got.stderr === clean.stderr && got.code === clean.code;
  if (same) return null;
  if (got.code !== 0 && !hook) return got.stderr.trim() ? null : "a failure with no message";
  // The hook may still reject what it measured without git, and say what it could not read.
  if (got.code !== 0 && clean.code === 0) return `the hook fails (exit ${got.code}) where the clean run passes: a failure must let the commit through`;
  const before = new Set(parts(clean));
  const after = new Set(parts(got));
  const shapes = new Set([...before].map(digits));
  const changed = [...after].filter((p) => !before.has(p));
  for (const p of changed) {
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
  for (const [i, c] of CASES.entries()) assert.ok(clean[i].calls > 0, `${c.args.join(" ")} calls git`);
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
