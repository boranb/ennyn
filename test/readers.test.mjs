/**
 * Every production module that reads another program's text is listed with that program and the test that holds its
 * reading to the program (READERS), or as a known gap with the node that would close it (GAPS); every other module is
 * listed with why it reads none (NOT_READERS). A module listed nowhere fails, so a new reader is decided when it lands.
 * The class: a reading of text stands in for running the program it answers for (`reader-drifts-from-program`), the
 * class that recurred most in cycles 15, 18, 20 and 23, each time caught by a reviewer's run of the real program.
 *
 * The rule, so the next module is classified the same way: a module reads another program's text when it parses text
 * that program reads or writes (a command line, a hook script, an ignore file, a commit message, git's printed output,
 * a lock file, a workflow, a Markdown file, a settings file, a transcript) and returns a verdict about what that
 * program does or did, instead of taking the verdict from the program. A module that hands a program its arguments and
 * takes the answer whole (an exit status, one value a line, a `-z` list of names) reads none; nor does one that reads
 * only Ennyn's own formats (config, graph, ledger, catalog, logs) or the values Claude Code hands a hook (its input
 * JSON, its environment); nor a hook's entry file, whose reading is its module's. One entry per program a module
 * answers for.
 *
 * A harness is a test where the input goes through the real program and the reader's verdict is compared with what
 * the program did: `live` (the test runs the program), `record` (test/reference/*: the program's answers, recorded and
 * replayed; `npm run test:reference` records them again), `runs` (the reader's own tests feed it the program's real
 * output on temporary repositories, the expected answers written by hand). A gap may only go: an entry that gains a
 * harness fails here until it moves to READERS, and the list has a ceiling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { testNames } from "./declarations.mjs";

const TOP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {"git" | "bash" | "sh" | "PowerShell" | "npm" | "Actions YAML" | "Markdown" | "Claude Code"} Program */
/** @typedef {{ module: string, program: Program, harness: string, test: string, kind: "live" | "record" | "runs" }} Reader `test`: the start of a top-level test's name in `harness` */
/** @typedef {{ module: string, program: Program, node: string, why: string }} Gap `node`: the work-graph node that would close it */

const CC_CELLS = "reference: every Claude Code cell compares as recorded";
const LOG_READERS = "oracle: the log readers return what git stores";

/** @type {Reader[]} */
export const READERS = [
  { module: "adapters/claude-code/compact-boundary.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: "reference: the PreCompact record holds what the compaction hook stands on", kind: "record" },
  { module: "adapters/claude-code/kill-targets.mjs", program: "bash", harness: "test/kill-targets.test.mjs", test: "kill reader: a real bash agrees", kind: "live" },
  { module: "adapters/claude-code/push-spellings.mjs", program: "bash", harness: "test/push-spellings.test.mjs", test: "push reader: a real shell and a real git agree", kind: "live" },
  { module: "adapters/claude-code/push-spellings.mjs", program: "bash", harness: "test/push-spellings.test.mjs", test: "push reader: on generated texts a real bash agrees", kind: "live" },
  { module: "adapters/claude-code/push-spellings.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: "reference: the PreToolUse record holds what the push hook stands on", kind: "record" },
  { module: "adapters/claude-code/rules-index.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: CC_CELLS, kind: "record" },
  { module: "checks/ci.mjs", program: "Actions YAML", harness: "test/reference.test.mjs", test: "reference: every Actions YAML cell compares as recorded", kind: "record" },
  { module: "checks/commit-shape.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: "oracle: the commit-msg hook computes the message git stores", kind: "live" },
  { module: "checks/deps.mjs", program: "npm", harness: "test/reference.test.mjs", test: "reference: every npm cell compares as recorded", kind: "record" },
  { module: "checks/push-mode.mjs", program: "git", harness: "test/cli.test.mjs", test: "cli: push-check reads git config as git push does", kind: "live" },
  { module: "checks/test-runs.mjs", program: "git", harness: "test/cli.test.mjs", test: "cli: test records a run by HEAD's tree on a clean work tree", kind: "live" },
  { module: "checks/loosening.mjs", program: "git", harness: "test/loosening.test.mjs", test: "loosening hook: git commit -a and git commit <path> are read as what they will commit", kind: "runs" },
  { module: "core/git.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: LOG_READERS, kind: "live" },
  { module: "core/git.mjs", program: "git", harness: "test/input-shapes.test.mjs", test: "input shapes: every staged content and name shape is refused, landed, or said to be unchecked", kind: "live" },
  { module: "impact/table.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: LOG_READERS, kind: "live" },
  { module: "metrics/bypass.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: LOG_READERS, kind: "live" },
  { module: "metrics/szz.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: LOG_READERS, kind: "live" },
  { module: "metrics/leftovers.mjs", program: "git", harness: "test/leftovers.test.mjs", test: "leftovers: changes not committed: modified, staged, deleted and renamed are listed", kind: "runs" },
  { module: "plan/worktrees.mjs", program: "git", harness: "test/worktrees.test.mjs", test: "worktrees: a marked worktree goes only when removing it loses nothing", kind: "runs" },
  { module: "plan/audit.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: CC_CELLS, kind: "record" },
  { module: "setup/budget.mjs", program: "Markdown", harness: "test/reference.test.mjs", test: "reference: every Markdown cell compares as recorded", kind: "record" },
  { module: "setup/doctor.mjs", program: "git", harness: "test/worktree-oracle.test.mjs", test: "worktree oracle: for the folder, its parents and the lists a clone gets", kind: "live" },
  { module: "setup/doctor.mjs", program: "sh", harness: "test/hook-oracle.test.mjs", test: "hook oracle: under /bin/sh, dash and bash, a ✓ is a secret refused by the check", kind: "live" },
  { module: "setup/doctor.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: "reference: doctor's ask line names as unmatched every spelling Claude Code ran under a rule", kind: "record" },
  { module: "setup/hook.mjs", program: "sh", harness: "test/hook-oracle.test.mjs", test: "hook oracle: the hooks install-hook writes stop a real secret", kind: "live" },
  { module: "setup/permissions.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: CC_CELLS, kind: "record" },
  { module: "setup/secret-setup.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: CC_CELLS, kind: "record" },
  { module: "setup/scan.mjs", program: "git", harness: "test/git-oracle.test.mjs", test: LOG_READERS, kind: "live" },
  { module: "setup/scan.mjs", program: "Markdown", harness: "test/reference.test.mjs", test: "reference: every Markdown cell compares as recorded", kind: "record" },
  { module: "setup/scan.mjs", program: "Claude Code", harness: "test/reference.test.mjs", test: CC_CELLS, kind: "record" },
  { module: "side-copy/map-path.mjs", program: "git", harness: "test/side-copy.test.mjs", test: "map-path: git worktree outside the roots maps by common git dir", kind: "runs" },
];

/** Readers with no harness yet. PowerShell is on neither this suite's Mac nor its Linux image. */
/** @type {Gap[]} */
export const GAPS = [
  { module: "adapters/claude-code/kill-targets.mjs", program: "PowerShell", node: "kill-reader-against-powershell", why: "PowerShell's grammar, measured by reviewers with pwsh 7.4 and 5.1, in no test" },
  { module: "adapters/claude-code/push-spellings.mjs", program: "PowerShell", node: "push-reader-against-powershell", why: "PowerShell's grammar, measured by reviewers with pwsh 7.4 and 5.1, in no test" },
  { module: "adapters/claude-code/agent-usage.mjs", program: "Claude Code", node: "agent-usage-against-claude-code", why: "transcripts and the project folder's name are built by hand in the shapes measured, not by a Claude Code run" },
  { module: "metrics/mutation.mjs", program: "git", node: "mutation-worktree-porcelain", why: "reads `git worktree list --porcelain` without -z, which git 2.34, the floor, does not have" },
  { module: "scripts/ennyn.mjs", program: "npm", node: "cli-npm-file-choice", why: "chooses the lock files and the .npmrc npm reads; the npm record holds only checks/deps.mjs's reading" },
];
/** GAPS may only shrink: lower this with each gap closed, never raise it. */
const GAP_CEILING = 5;

const HOOK_ENTRY = "a hook's entry file: the reading is its module's";
const OWN = "reads only Ennyn's own formats";
/** @type {Record<string, string>} */
export const NOT_READERS = {
  "adapters/claude-code/config-place.mjs": "finds the config by the folders Claude Code names a hook (its input and environment)",
  "adapters/claude-code/project.mjs": "finds the project's config; git through core/git.mjs, taken whole",
  "adapters/claude-code/hooks/compact-boundary.mjs": HOOK_ENTRY,
  "adapters/claude-code/hooks/conversation-style.mjs": HOOK_ENTRY,
  "adapters/claude-code/hooks/kill-targets.mjs": HOOK_ENTRY,
  "adapters/claude-code/hooks/plugin-root.mjs": "writes the plugin's version record from the values Claude Code hands a hook",
  "adapters/claude-code/hooks/push-spellings.mjs": HOOK_ENTRY,
  "adapters/claude-code/hooks/side-copy-reset.mjs": "removes Ennyn's own state",
  "adapters/claude-code/hooks/side-copy-rules.mjs": "a hook's entry file: the reading is rules-index.mjs's and map-path.mjs's",
  "checks/secrets.mjs": "secret shapes are their issuers' documented prefixes and lengths, no program's reading",
  "core/config.mjs": OWN,
  "core/encoding.mjs": "decodes Unicode encoding forms; what git splits is core/git.mjs's reading",
  "core/files.mjs": "file presence and reads through node:fs",
  "core/glob.mjs": "Ennyn's glob; where it stands for Claude Code's rule match, rules-index.mjs is the reader",
  "core/i18n.mjs": OWN,
  "core/style.mjs": OWN,
  "metrics/classes.mjs": `${OWN}; git's answers taken whole`,
  "metrics/convergence.mjs": OWN,
  "metrics/findings.mjs": `${OWN}; git's answers taken whole`,
  "metrics/gate-log.mjs": `${OWN}; git's answer taken whole`,
  "plan/mechanization.mjs": OWN,
  "plan/cycle-journal.mjs": `${OWN} (the cycle journal); git's answers taken whole`,
};

/** Production modules: every .mjs outside test/, tracked or not yet. @param {string} top */
function modules(top) {
  // core/git.mjs reads every pathspec literally, so the names are filtered here.
  return git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: top })
    .split("\0")
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("test/") && existsSync(join(top, f)))
    .sort();
}

/**
 * What the lists get wrong for these modules: one listed nowhere, one listed both as a reader (or gap) and as none,
 * one listed that is not there, a gap that READERS now holds, more gaps than the ceiling.
 * @param {string[]} found @param {Reader[]} readers @param {Gap[]} gaps @param {Record<string, string>} none @param {number} ceiling
 */
export function listProblems(found, readers, gaps, none, ceiling) {
  const reads = new Set([...readers, ...gaps].map((r) => r.module));
  const out = [];
  for (const m of found) if (!reads.has(m) && !(m in none)) out.push(`${m}: listed nowhere`);
  for (const m of reads) if (m in none) out.push(`${m}: a reader and none`);
  for (const m of [...reads, ...Object.keys(none)]) if (!found.includes(m)) out.push(`${m}: listed, not there`);
  for (const g of gaps) if (readers.some((r) => r.module === g.module && r.program === g.program)) out.push(`${g.module} (${g.program}): a gap with a harness`);
  if (gaps.length > ceiling) out.push(`${gaps.length} gaps, over ${ceiling}`);
  return out;
}

/**
 * The harnesses that do not hold: a file that is not there, or no top-level test whose name starts as written.
 * @param {Reader[]} readers @param {(file: string) => string | null} read
 */
export function harnessProblems(readers, read) {
  const out = [];
  for (const r of readers) {
    const text = read(r.harness);
    if (text === null) out.push(`${r.module}: ${r.harness} is not there`);
    else if (!testNames(text).some((n) => n.startsWith(r.test))) out.push(`${r.module}: no test in ${r.harness} starts ${JSON.stringify(r.test)}`);
  }
  return out;
}

/** The gaps whose node the work graph does not hold open. @param {Gap[]} gaps @param {Set<string>} open */
export const notOpen = (gaps, open) => gaps.filter((g) => !open.has(g.node)).map((g) => `${g.module} (${g.program}): ${g.node} is no open node`);

/** @param {string} file */
const readTop = (file) => (existsSync(join(TOP, file)) ? readFileSync(join(TOP, file), "utf8") : null);

test("readers: every production module is a reader with its program and harness, a known gap, or listed with why it reads none", () => {
  const found = modules(TOP);
  assert.ok(found.length >= 40, `${found.length} modules`);
  assert.deepEqual(listProblems(found, READERS, GAPS, NOT_READERS, GAP_CEILING), []);
});

test("readers: each harness is a test in its file, and each gap names an open node of the work graph", async () => {
  assert.deepEqual(harnessProblems(READERS, readTop), []);
  const config = loadConfig({ cwd: TOP, env: {} });
  const graph = await loadGraph({ cwd: TOP, config });
  const f = config.graph.fields;
  const open = new Set(graph.open.filter((n) => n[f.status] !== config.graph.doneStatus).map((n) => String(n[f.id])));
  assert.deepEqual(notOpen(GAPS, open), []);
});

test("readers control: an unlisted module, one listed twice or gone, a gap with a harness, a gap over the ceiling and a gap on no open node are named; a renamed harness test is named", () => {
  /** @type {Reader} */
  const r = { module: "a.mjs", program: "git", harness: "t.test.mjs", test: "t: one", kind: "live" };
  /** @type {Gap} */
  const g = { module: "b.mjs", program: "bash", node: "n", why: "w" };
  assert.deepEqual(listProblems(["a.mjs", "b.mjs", "c.mjs"], [r], [g], { "c.mjs": "x" }, 1), []);
  assert.deepEqual(listProblems(["a.mjs", "b.mjs", "c.mjs", "d.mjs"], [r], [g], { "c.mjs": "x" }, 1), ["d.mjs: listed nowhere"]);
  assert.deepEqual(listProblems(["a.mjs", "b.mjs"], [r], [g], { "a.mjs": "x" }, 1), ["a.mjs: a reader and none"]);
  assert.deepEqual(listProblems(["a.mjs"], [r], [], { "e.mjs": "x" }, 1), ["e.mjs: listed, not there"]);
  assert.deepEqual(listProblems(["a.mjs"], [r], [{ ...g, module: "a.mjs", program: "git" }], {}, 1), ["a.mjs (git): a gap with a harness"]);
  assert.deepEqual(listProblems(["a.mjs", "b.mjs"], [r], [g, g], {}, 1), ["2 gaps, over 1"]);
  const read = (/** @type {string} */ f) => (f === "t.test.mjs" ? 'test("t: one and two", () => {});\n' : null);
  assert.deepEqual(harnessProblems([r], read), []);
  assert.deepEqual(harnessProblems([{ ...r, test: "t: two" }], read), ['a.mjs: no test in t.test.mjs starts "t: two"']);
  assert.deepEqual(harnessProblems([{ ...r, harness: "u.test.mjs" }], read), ["a.mjs: u.test.mjs is not there"]);
  assert.deepEqual(notOpen([g], new Set(["n"])), []);
  assert.deepEqual(notOpen([g], new Set(["m"])), ["b.mjs (bash): n is no open node"]);
});
