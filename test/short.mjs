/**
 * `npm run test:short`: the suite an author runs during a task. Every test file runs but the slow ones SLOW names,
 * and a slow file comes back when the branch changed one of its listed paths, against the main branch, committed or
 * not. The whole suite (`npm test`) is not replaced: it runs once at a cycle's closing, before the push, slow files
 * included; a landing runs this and the slow files the task touches. A path list here decides how early a slow
 * file's failure is seen, never whether it runs.
 *
 * The lists are narrow on purpose. The import closure of scripts/ennyn.mjs is nearly the whole tree, and a list that
 * matches every code change would make this the whole suite. Each one names what its file guards. With guards left
 * out, its one test that needs no mutant (ACCOUNTING) still runs: seconds, against minutes for the rest.
 *
 * When what changed cannot be read (no repository, a tree that is not the repository's top, no main branch, a git
 * that fails or answers with nothing), or on the main branch itself, or on no branch, it runs every test file and says
 * why: a skipped gate is never silent. The files left out are printed before the run and again after it, then one
 * line per run, and the last line says passed or failed.
 *
 * The reading trusts git's index and the name `main`: an edit an index flag or a filter hides, a change a reverted
 * landing leaves below the merge base, or a main known only by another spelling reads as no change, and what it
 * misses waits for landing.
 *
 * Node 20.0.0's `node --test` takes no pattern that leaves files out, so the file list is built here;
 * test/short.test.mjs keeps it true.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIfThere } from "../core/files.mjs";
import { git, gitMaybe } from "../core/git.mjs";
import { matchAny } from "../core/glob.mjs";
import { GATES } from "./guards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = "main";
const GUARDS = "test/guards.test.mjs";
/** The guards file's test that needs no mutant: every repository reader listed, every test of a gate decided, each guard's `old` once. */
export const ACCOUNTING = "^guards: every test that reads this repository has guards";

/** Loaded into every test file: a change there moves all of them. */
const EVERY_FILE = { paths: ["test/hermetic.mjs", "test/hostile.mjs"], why: "loaded into every test file" };

/**
 * The slow files, each with the paths that bring it back and why. Guards has more ways back than paths: see reasons.
 *
 * Hook: what installs it, what a commit runs through (core/git.mjs's staged reads, the CLI's commit-check and fold
 * target) and doctor, which says what the hook does. Each fails test/hook.test.mjs when edited.
 * Fault matrix: what every git call and file read goes through, the code that most often changed with the matrix,
 * and the lists it must hold a case for. Its test of a new read in any other module waits for landing.
 * @type {Record<string, { paths: string[], why: string }[]>}
 */
export const SLOW = {
  [GUARDS]: [EVERY_FILE, { paths: ["test/guards.mjs", GUARDS, "test/declarations.mjs", "metrics/mutation.mjs"], why: "the guards, and what runs and reads them" }],
  "test/hook.test.mjs": [
    EVERY_FILE,
    { paths: ["test/hook.test.mjs"], why: "the file itself" },
    { paths: ["setup/hook.mjs", "setup/doctor.mjs", "checks/commit-shape.mjs", "core/git.mjs", "scripts/ennyn.mjs"], why: "what installs the hook, what it runs and what reports on it" },
    { paths: ["adapters/claude-code/hooks/plugin-root.mjs"], why: "writes the record a hook installed from the plugin follows" },
  ],
  "test/fault-injection.test.mjs": [
    EVERY_FILE,
    { paths: ["test/fault-injection.test.mjs", "test/fault-fs.mjs"], why: "the matrix and its preload" },
    { paths: ["core/git.mjs", "core/files.mjs"], why: "every git call and file read goes through them" },
    { paths: ["core/config.mjs", "setup/doctor.mjs"], why: "the code that most often changed with the matrix" },
    { paths: ["scripts/ennyn.mjs", "hooks/hooks.json", "adapters/claude-code/hooks/*.mjs"], why: "every command and hook needs a case" },
  ],
};

/** Every test file, as the shell's `test/*.test.mjs` lists it. @param {string} root @returns {string[]} */
export function testFiles(root) {
  return readdirSync(join(root, "test"))
    .filter((f) => /^[^.].*\.test\.mjs$/s.test(f))
    .map((f) => `test/${f}`)
    .sort();
}

/**
 * What the branch changed against the main branch: the tree and the index against their merge base, and untracked
 * files by the repository's own .gitignore files (a machine's ignore or .git/info/exclude can hide anything). `unread`
 * says why there is no answer.
 * @param {string} cwd @param {NodeJS.ProcessEnv} [env]
 * @returns {{ paths: string[], added: string[], base: string, branch: string } | { unread: string }}
 */
export function whatChanged(cwd, env = process.env) {
  try {
    // The lists name paths from the top of this tree, and git names them from the top of the repository.
    const top = git(["rev-parse", "--show-toplevel"], { cwd, env });
    if (!top || realpathSync(top) !== realpathSync(cwd)) return { unread: `the repository's top is ${JSON.stringify(top)}, not this tree` };
    // The full name: --short prints heads/main when a tag is called main too.
    const ref = gitMaybe(["symbolic-ref", "--quiet", "HEAD"], { cwd, env, absent: [1] });
    if (ref === null) return { unread: "HEAD is on no branch" };
    if (ref === `refs/heads/${MAIN}`) return { unread: `on ${MAIN} itself` };
    if (!/^refs\/heads\/./.test(ref)) return { unread: `HEAD names ${JSON.stringify(ref)}, no branch` };
    const base = git(["merge-base", "HEAD", `refs/heads/${MAIN}`], { cwd, env });
    if (!/^[0-9a-f]{40,64}$/.test(base)) return { unread: `git named ${JSON.stringify(base)} as the merge base` };
    const diff = (/** @type {string[]} */ ...how) => git(["diff", ...how, "--name-status", "--no-renames", "-z", base, "--"], { cwd, env, walk: true }).split("\0").filter(Boolean);
    const fields = [...diff(), ...diff("--cached")];
    const untracked = git(["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"], { cwd, env, walk: true }).split("\0").filter(Boolean);
    const paths = new Set(untracked);
    const added = new Set(untracked);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      paths.add(fields[i + 1]);
      if (fields[i] === "A") added.add(fields[i + 1]);
    }
    return { paths: [...paths], added: [...added], base, branch: ref.replace("refs/heads/", "") };
  } catch (err) {
    return { unread: `git could not say what changed (${/** @type {Error} */ (err).message})` };
  }
}

/**
 * Why each slow file comes back for these changes: its own paths; for guards also a gate test (a test added to one
 * is decided, and one rewritten may lose its kill), a new test file (GATES or NOT_GATES must list it when it finds
 * the repository), and a guarded line (a guard's `old` no longer once in its file).
 * @param {{ paths: string[], added: string[] }} changed
 * @param {(file: string) => string | null} read the file as it is now; null when it is gone
 * @param {typeof GATES} [gates]
 * @returns {Map<string, string[]>} an entry for every slow file, empty when nothing brings it back
 */
export function reasons({ paths, added }, read, gates = GATES) {
  /** @type {Map<string, string[]>} */
  const back = new Map();
  for (const [file, rules] of Object.entries(SLOW)) {
    /** @type {string[]} */
    const says = [];
    for (const { paths: globs, why } of rules) {
      const hit = paths.find((p) => matchAny(p, globs));
      if (hit !== undefined) says.push(`${hit}: ${why}`);
    }
    back.set(file, says);
  }
  const guards = /** @type {string[]} */ (back.get(GUARDS));
  const gate = gates.find((g) => paths.includes(g.test));
  if (gate) guards.push(`${gate.test}: a gate test, whose tests are decided and whose guards must still kill`);
  const fresh = added.find((p) => /^test\/[^/]+\.test\.mjs$/.test(p));
  if (fresh !== undefined) guards.push(`${fresh}: a new test file, decided in GATES or NOT_GATES`);
  for (const { guards: list } of gates) {
    for (const g of list) {
      if (!paths.includes(g.file)) continue;
      if ((read(g.file) ?? "").split(g.old).length !== 2) guards.push(`${g.file}: the line guard ${g.id} applies to`);
    }
  }
  return back;
}

/**
 * The files to run for these changes, whether guards' accounting test runs too, and what to say about them.
 * @param {string[]} all @param {{ paths: string[], added: string[], base: string, branch: string }} changed
 * @param {(file: string) => string | null} read
 * @returns {{ files: string[], accounting: boolean, says: string[] }}
 */
export function choose(all, changed, read) {
  const back = reasons(changed, read);
  const left = all.filter((f) => back.get(f)?.length === 0);
  const files = all.filter((f) => !left.includes(f));
  return {
    files,
    accounting: left.includes(GUARDS),
    says: [
      `short suite, ${files.length} of ${all.length} test files (changed on ${changed.branch} since ${MAIN} at ${changed.base.slice(0, 7)}: ${changed.paths.length})`,
      ...files.flatMap((file) => (back.get(file) ?? []).map((why) => `added ${file}: ${why}`)),
      ...left.map((file) => `left out ${file}: none of its listed paths changed, and it runs at the closing${file === GUARDS ? "; its accounting test runs now" : ""}`),
    ],
  };
}

/**
 * What to run and say in this tree.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 * @returns {{ files: string[], accounting: boolean, says: string[] }}
 */
export function decide(root, env = process.env) {
  const all = testFiles(root);
  /** @param {string} why */
  const everything = (why) => ({ files: all, accounting: false, says: [`whole suite, ${all.length} test files: ${why}`] });
  const changed = whatChanged(root, env);
  if ("unread" in changed) return everything(changed.unread);
  try {
    return choose(all, changed, (file) => readIfThere(join(root, file)));
  } catch (err) {
    return everything(`a guarded file could not be read (${/** @type {Error} */ (err).message})`);
  }
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  const list = argv[0] === "--list";
  if (argv.length > (list ? 1 : 0)) {
    console.error("usage: node test/short.mjs [--list]");
    return 2;
  }
  const { files, accounting, says } = decide(ROOT);
  const say = () => console.log(says.join("\n"));
  say();
  if (list) {
    console.log(files.join("\n"));
    return 0;
  }
  const runs = [{ name: "test files", args: files }, ...(accounting ? [{ name: "guards' accounting test", args: [`--test-name-pattern=${ACCOUNTING}`, GUARDS] }] : [])];
  const ended = runs.map(({ name, args }) => ({ name, ...spawnSync(process.execPath, ["--test", "--import", "./test/hermetic.mjs", ...args], { cwd: ROOT, stdio: "inherit" }) }));
  // Again at the end: the run's output pushes the first copy out of a reader's tail.
  say();
  // The words carry the verdict: a later run's summary hides an earlier failure, and a pipe into tail loses the exit code.
  for (const run of ended) console.log(`${run.name}: ${run.status === 0 ? "passed" : run.status === null ? `did not finish, ${run.error?.message ?? run.signal}` : `failed, exit ${run.status}`}`);
  const bad = ended.find((run) => run.status !== 0);
  console.log(`test:short ${bad ? "failed" : "passed"}`);
  return bad ? (bad.status ?? 1) : 0;
}

// Run as a script, also through a link (macOS: /tmp is /private/tmp, where import.meta.url is the real path).
const invoked = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
