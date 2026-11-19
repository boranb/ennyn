/**
 * The record of test runs, by tree hash, and what a push needs from it (push-check, skills/cycle/push.md).
 *
 * `ennyn test fast|whole` runs the project's command (`commands.fastTest`, `commands.wholeTest`) and appends one line
 * to `<stateDir>/test-runs.jsonl`: the tree it ran on, the kind, the exit status, when. The state dir lies under the
 * common git dir, so the main checkout reads what a run in a linked worktree wrote. The tree is HEAD's, and a run is
 * written only when the work tree was clean (no change, staged or not, no untracked file) before it and still is,
 * on the same HEAD, after it: `git write-tree` and HEAD's tree both miss an unstaged edit and an untracked file, so a
 * run on a dirty tree would read as a run on HEAD (measured on git 2.56.0). An ignored file is in no tree hash.
 *
 * A green run already on the tree is not run again: the line that says so (`skipOf`) is a record too. The record is
 * a fact push-check reads, never an approval: any process that can write the git dir can write a line, so it is the
 * caller's word, as `push-check --tested` is, and no line turns push.mode ask into a push.
 */

import { join } from "node:path";
import { appendBounded, readRegular } from "../core/files.mjs";
import { commonDir, git, gitMaybe, gitRun, resolveStateDir, stateRoot } from "../core/git.mjs";
import { matchAny } from "../core/glob.mjs";

const RUNS_FILE = "test-runs.jsonl";
/** The log is cut to its newer half past this many bytes; a line is about 200. */
const MAX_BYTES = 1024 * 1024;
export const KINDS = /** @type {const} */ (["fast", "whole"]);

/**
 * @typedef {{ v: 1, kind: "fast" | "whole", tree: string, head: string, base?: string | null, exit: number, start: string, end: string, skipOf?: string }} Run
 *   `base`: a fast run's, the commit its selection could have been read against (runBase); `skipOf`: not run again,
 *   the end of the green run on this tree it rests on
 */

/** @param {string} cwd @param {string} stateDir config `paths.stateDir` */
export function runsPath(cwd, stateDir) {
  if (commonDir(cwd) === null) throw new RangeError("no git repository here");
  return join(resolveStateDir(cwd, stateDir), RUNS_FILE);
}

/**
 * HEAD and its tree when the work tree holds nothing HEAD does not (untracked files included), else why not.
 * @param {string} cwd
 * @returns {{ head: string, tree: string } | { dirty: string }}
 */
export function cleanTree(cwd) {
  const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd, absent: [1] });
  if (!head) return { dirty: "no commit yet" };
  // --ignore-submodules=none: a submodule whose content or commit differs reads clean under `.gitmodules`
  // `ignore = all|dirty` or `diff.ignoreSubmodules`, and the run tested it.
  if (git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], { cwd, walk: true }) !== "") return { dirty: "the work tree holds changes or untracked files" };
  // git status reads neither a file the sparse checkout leaves out nor an entry marked skip-worktree or
  // assume-unchanged: a run there tested part of the tree, or another file than HEAD holds.
  if (gitMaybe(["config", "--type=bool", "--get", "core.sparseCheckout"], { cwd, absent: [1] }) === "true") return { dirty: "sparse checkout is on" };
  const flagged = git(["ls-files", "-v", "-z"], { cwd, walk: true }).split("\0").filter((e) => e && !e.startsWith("H ")).length;
  if (flagged) return { dirty: `the index marks ${flagged} entries skip-worktree or assume-unchanged` };
  return { head, tree: git(["rev-parse", `${head}^{tree}`], { cwd }) };
}

/**
 * The commit a fast run's selection could have been read against, read without knowing the project's command: the
 * merge base of HEAD with the branch's upstream, else with the main branch (Ennyn's test/short.mjs reads
 * `refs/heads/main`); null when there is neither. A fast run counts for a push only when its base is the push's
 * upstream commit or an ancestor of it: a run whose selection began later saw less than the push sends.
 * @param {string} cwd
 */
export function runBase(cwd) {
  const ref = gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd, absent: [1] });
  const upstream = ref ? git(["for-each-ref", "--format=%(upstream)", ref], { cwd }) : "";
  for (const other of [upstream, "refs/heads/main"]) {
    if (!other || !gitMaybe(["rev-parse", "--verify", "-q", `${other}^{commit}`], { cwd, absent: [1] })) continue;
    return gitMaybe(["merge-base", "HEAD", other], { cwd, absent: [1] });
  }
  return null;
}

/** Whether `a` is `b` or an ancestor of it; a commit that is not there is neither. @param {string} cwd @param {string} a @param {string} b */
export function within(cwd, a, b) {
  return gitRun(["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;
}

/** @param {unknown} o @returns {o is Run} */
function isRun(o) {
  if (!o || typeof o !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (o);
  const hash = (/** @type {unknown} */ v) => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);
  const date = (/** @type {unknown} */ v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  return r.v === 1 && (/** @type {readonly unknown[]} */ (KINDS)).includes(r.kind) && hash(r.tree) && hash(r.head) && (r.base === undefined || r.base === null || hash(r.base)) && Number.isInteger(r.exit) && date(r.start) && date(r.end) && (r.skipOf === undefined || date(r.skipOf));
}

/**
 * Every run recorded, oldest first; lines that are no run counted in `skipped`. A record that is there and cannot be
 * read throws.
 * @param {string} cwd @param {any} config
 * @returns {{ runs: Run[], skipped: number }}
 */
export function readRuns(cwd, config) {
  const path = runsPath(cwd, config.paths.stateDir);
  const bytes = readRegular(stateRoot(cwd, path), path);
  /** @type {Run[]} */
  const runs = [];
  let skipped = 0;
  for (const line of (bytes?.toString("utf8") ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (isRun(o)) runs.push(o);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { runs, skipped };
}

/** @param {string} cwd @param {any} config @param {Run} run */
export function recordRun(cwd, config, run) {
  const path = runsPath(cwd, config.paths.stateDir);
  appendBounded(stateRoot(cwd, path), path, `${JSON.stringify(run)}\n`, MAX_BYTES);
  return path;
}

/**
 * The last run on `tree` of a kind that answers for `kind`: a whole run answers for a fast one too. The last decides,
 * so a red run after a green one on the same tree is red, whatever its base; a green fast run counts only when `fits`
 * takes its base, and one that does not is passed over.
 * @param {Run[]} runs @param {string} tree @param {"fast" | "whole"} kind @param {(base: string) => boolean} fits
 */
export function lastRun(runs, tree, kind, fits) {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.tree !== tree || (r.kind !== kind && r.kind !== "whole")) continue;
    if (r.exit === 0 && r.kind === "fast" && !(r.base && fits(r.base))) continue;
    return r;
  }
  return null;
}

/**
 * What a push of HEAD needs, read from the commits it sends (`@{upstream}..HEAD`, by their net change): a path the
 * code globs match needs a green whole run on HEAD's tree, any other change a green fast (or whole) one. It fetches
 * the upstream remote first, unless `fetch` is false, and a branch behind its upstream gets no need: it rebases first.
 * @param {string} cwd the repository's top @param {any} config @param {{ fetch?: boolean }} [opts]
 * @returns {{ unmeasured: string } | { upstream: string, fetched: string | null, behind: number, ahead: number, need: "fast" | "whole" | null, code: string | null, tree: string, last: Run | null, red: Run | null, met: boolean }}
 *   `upstream`: the full ref the push goes to, whose `..HEAD` is what it sends (commits.* reads the same range);
 *   `fetched`: null when the fetch ran, else why not; `need` null with nothing to push; `red`: the last red run on the tree
 */
export function pushNeeds(cwd, config, { fetch = true } = {}) {
  const ref = gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd, absent: [1] });
  if (!ref) return { unmeasured: "HEAD is on no branch" };
  const branch = ref.replace(/^refs\/heads\//, "");
  const remote = gitMaybe(["config", "--get", `branch.${branch}.remote`], { cwd, absent: [1] });
  const upstream = git(["for-each-ref", "--format=%(upstream)", ref], { cwd });
  if (!upstream || !remote) return { unmeasured: "the branch has no upstream" };
  // What a bare push sends is read against where it goes: another remote (remote.pushDefault, branch.<b>.pushRemote)
  // or a destination git cannot name leaves the upstream saying nothing of it.
  const goes = gitMaybe(["rev-parse", "--symbolic-full-name", "@{push}"], { cwd, absent: [128] });
  if (goes !== upstream) return { unmeasured: `a bare git push goes ${goes ? `to ${goes}` : "where git cannot name (@{push})"}, not to the upstream ${upstream}` };
  /** @type {string | null} */
  let fetched = fetch ? null : "not asked";
  // A local upstream (remote ".") has nothing to fetch.
  if (fetch && remote !== ".") {
    try {
      git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, walk: true });
    } catch (e) {
      fetched = String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];
    }
  }
  if (!gitMaybe(["rev-parse", "--verify", "-q", upstream], { cwd, absent: [1] })) return { unmeasured: `the upstream ${upstream} is not there` };
  const count = (/** @type {string} */ range) => {
    const n = git(["rev-list", "--count", range], { cwd, walk: true });
    if (!/^\d+$/.test(n)) throw new Error(`git rev-list --count printed no count: ${JSON.stringify(n.slice(0, 80))}`);
    return Number(n);
  };
  const behind = count(`HEAD..${upstream}`);
  const ahead = count(`${upstream}..HEAD`);
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd });
  const paths = ahead ? git(["diff", "--no-renames", "--name-only", "-z", upstream, "HEAD", "--"], { cwd, walk: true }).split("\0").filter(Boolean) : [];
  const code = paths.find((p) => matchAny(p, config.push.codeGlobs)) ?? null;
  // Commits whose net change is nothing still send commits: a fast run on that tree.
  const need = behind || !ahead ? null : code === null ? "fast" : "whole";
  const runs = need ? readRuns(cwd, config).runs : [];
  const at = git(["rev-parse", `${upstream}^{commit}`], { cwd });
  const last = need ? lastRun(runs, tree, need, (base) => within(cwd, base, at)) : null;
  // Any red run on this tree, of either kind and whatever its base: the caller's --tested word does not stand against it.
  const red = runs.filter((r) => r.tree === tree && r.exit !== 0).at(-1) ?? null;
  return { upstream, fetched, behind, ahead, need, code, tree, last, red, met: need !== null && last !== null && last.exit === 0 };
}
