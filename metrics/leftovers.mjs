/**
 * What a cycle leaves in the work tree, listed at its closing and never removed: untracked files that appeared since
 * the cycle began, and changes not committed (a new file staged or added with intent to add, a tracked file changed,
 * staged, deleted or renamed). Each item is a question for the user. Only what git says exactly: whether a committed
 * file is still used is a question for a tool that reads the project's language (the handoff's leftover command).
 *
 * `ennyn leftovers --start` records the start in the state dir, one file per work tree (linked worktrees share the
 * state dir, and each runs cycles of its own: see startPath): HEAD, the tree's top, its untracked files and its changes as
 * `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none` gives them (no
 * index is written; a file whose stat changed goes through the clean filter the repository's own config names, as
 * `git status` by hand does; a submodule whose own work tree changed, a stray in it too, is a change `M`).
 * Ignored files are left out: the project chose to ignore them, and no commit takes them. At the closing an untracked
 * file the record holds is not the cycle's, nor a change of the same path under the same code; a file still changed but
 * further is, by that test, the start's. One the record holds untracked that HEAD now tracks is listed: a commit that
 * swept the work tree (`git add -A`) took it in, and the run after the closing's commit would read clean.
 */

import { realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { READ_LIMIT, readRegular, removeState, writeState } from "../core/files.mjs";
import { git, gitBytes, gitMaybe, nameText, repoPath, resolveStateDir, stateRoot } from "../core/git.mjs";

/** The most bytes of a start record: the writer refuses past it what its reader would refuse. */
export const START_LIMIT = READ_LIMIT;

/**
 * @typedef {{ key: string, vars: Record<string, string | number> }} Said
 * @typedef {{ code: string, path: string, from?: string }} Change a status entry: its two-letter code, its path, and the source of a rename or copy
 * @typedef {{ v: 1, head: string, top: string, at: string, untracked: string[], changed: string[] }} StartRecord
 *   `changed`: each change as `<code> <path>`
 * @typedef {{
 *   start: { head: string, at: string } | null,
 *   untracked: { state: "found" | "clean" | "unmeasured", why?: Said, items: { path: string, files: number, committed?: true }[] },
 *   uncommitted: { state: "found" | "clean", items: Change[] },
 * }} Leftovers
 */

/**
 * The record of the work tree at `top`: `cycle-start.json` for the main tree, `cycle-start-<name>.json` for a linked
 * worktree, by the name git gives its folder under `worktrees/` (unique while it lives). A worktree made later under
 * a removed one's name finds that record, and the top it holds says whose it is.
 * @param {string} top @param {string} stateDir config `paths.stateDir` @param {NodeJS.ProcessEnv} [env]
 */
export const startPath = (/** @type {string} */ top, /** @type {string} */ stateDir, env = process.env) => treeFile(top, stateDir, "cycle-start", ".json", env);

/**
 * A state file of the work tree at `top`, named as startPath names the start record: `<stem><ext>` for the main tree,
 * `<stem>-<name><ext>` for a linked worktree (the cycle journal too).
 * @param {string} top @param {string} stateDir @param {string} stem @param {string} ext @param {NodeJS.ProcessEnv} [env]
 */
export function treeFile(top, stateDir, stem, ext, env = process.env) {
  const [gitDir, common] = git(["rev-parse", "--git-dir", "--git-common-dir"], { cwd: top, env }).split("\n");
  const own = resolve(top, gitDir) === resolve(top, common) ? "" : `-${basename(gitDir)}`;
  return join(resolveStateDir(top, stateDir), `${stem}${own}${ext}`);
}

/**
 * NUL-separated names as git wrote them, each as nameText reads it (a name that is not UTF-8 keeps its bytes).
 * @param {Buffer} out
 */
function nulFields(out) {
  /** @type {string[]} */
  const fields = [];
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf(0, at);
    fields.push(nameText(out.subarray(at, end === -1 ? out.length : end)));
    at = end === -1 ? out.length : end + 1;
  }
  return fields;
}

/**
 * The work tree's status: untracked files (every file of an untracked folder with `all`, the folder itself with
 * `normal`), and every other entry as a change. Ignored files are left out.
 * @param {string} top @param {NodeJS.ProcessEnv} env @param {"all" | "normal"} [mode]
 */
export function workTreeStatus(top, env, mode = "all") {
  const fields = nulFields(gitBytes(["--no-optional-locks", "status", "--porcelain=v1", "-z", `--untracked-files=${mode}`, "--ignore-submodules=none"], { cwd: top, env, walk: true }));
  /** @type {string[]} */
  const untracked = [];
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i].slice(0, 2);
    const path = fields[i].slice(3);
    if (code === "??") untracked.push(path);
    // A rename or a copy carries its source as the next field.
    else if (/[RC]/.test(code)) changes.push({ code, path, from: fields[++i] });
    else changes.push({ code, path });
  }
  return { untracked, changes };
}

/** @param {Change} c */
const changeKey = (c) => `${c.code} ${c.path}`;

/**
 * The work tree's top; outside one, throws. So does a top that lies in its own git dir: that is a bare-looking folder a
 * clone brought in, whose config names its work tree inside it. git 2.38 and later refuse such a folder; a lower git,
 * the floor 2.34.1 too, reads it, and `git status` there runs the clean filter its config names (measured).
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 */
function topOf(cwd, env) {
  const top = repoPath("--show-toplevel", { cwd, env });
  if (!top) throw new Error("not in a git repository");
  const [dir, at] = [/** @type {string} */ (repoPath("--absolute-git-dir", { cwd: top, env })), top].map((p) => realpathSync.native(p));
  if (at === dir || at.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)) throw new Error(`the work tree ${top} lies in its own git dir ${dir}: a folder a clone brought in that git below 2.38 reads as a repository, whose config can name programs; nothing was read`);
  return top;
}

/**
 * The record of a cycle's start; null when there is none. A file that does not hold one is `bad`, with why.
 * @param {string} top @param {string} path @param {number} [limit]
 * @returns {{ record: StartRecord } | { bad: string } | null}
 */
export function readStart(top, path, limit = START_LIMIT) {
  const bytes = readRegular(stateRoot(top, path), path, { limit });
  if (bytes === null) return null;
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return { bad: /** @type {Error} */ (e).message };
  }
  const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((p) => typeof p === "string");
  const ok = r && r.v === 1 && typeof r.head === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(r.head) && typeof r.top === "string" && typeof r.at === "string" && strings(r.untracked) && strings(r.changed);
  return ok ? { record: r } : { bad: "not a start record of this version" };
}

/**
 * Records the cycle's start of the work tree at `cwd`, replacing that tree's record, which it returns. A record past
 * `limit` bytes is refused before anything is written: its reader would refuse it at every closing.
 * @param {{ cwd: string, config: any, env?: NodeJS.ProcessEnv, now?: Date, limit?: number }} opts
 */
export function recordStart({ cwd, config, env = process.env, now = new Date(), limit = START_LIMIT }) {
  const top = topOf(cwd, env);
  const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top, env, absent: [1] });
  if (!head) throw new RangeError("HEAD names no commit yet: a cycle starts at a commit");
  const { untracked, changes } = workTreeStatus(top, env);
  /** @type {StartRecord} */
  const record = { v: 1, head, top, at: now.toISOString(), untracked, changed: changes.map(changeKey) };
  const text = JSON.stringify(record) + "\n";
  const size = Buffer.byteLength(text);
  const path = startPath(top, config.paths.stateDir, env);
  if (size > limit) {
    // An earlier cycle's record must not stand as this one's start: the closing says unmeasured instead.
    removeState(stateRoot(top, path), path);
    throw new RangeError(`HEAD ${head} is the cycle's start, but its record would be ${size} bytes, past the ${limit} bytes a closing reads (${untracked.length} untracked files, ${changes.length} changes): no record was written and this work tree's earlier one was removed; a folder of untracked files that belongs in .gitignore makes most of it`);
  }
  const old = readStart(top, path, limit);
  writeState(stateRoot(top, path), path, text, "replace");
  return { path, head, untracked: untracked.length, changed: changes.length, replaced: old && "record" in old ? { head: old.record.head, at: old.record.at } : null };
}

/**
 * The closing's list for the work tree at `cwd`, against its recorded start.
 * @param {{ cwd: string, config: any, env?: NodeJS.ProcessEnv }} opts
 * @returns {Leftovers}
 */
export function leftovers({ cwd, config, env = process.env }) {
  const top = topOf(cwd, env);
  const path = startPath(top, config.paths.stateDir, env);
  const read = readStart(top, path);
  /** @type {Said | null} */
  let why = null;
  if (read === null) why = { key: "leftovers.why.noRecord", vars: { path } };
  else if ("bad" in read) why = { key: "leftovers.why.badRecord", vars: { path, error: read.bad } };
  else if (read.record.top !== top) why = { key: "leftovers.why.otherTree", vars: { top: read.record.top } };
  const record = read && "record" in read && !why ? read.record : null;
  const now = workTreeStatus(top, env);
  const state = (/** @type {number} */ n) => (n ? /** @type {const} */ ("found") : /** @type {const} */ ("clean"));

  const changedBefore = new Set(record?.changed ?? []);
  const changes = now.changes.filter((c) => !changedBefore.has(changeKey(c))).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /** @type {Leftovers["untracked"]} */
  let untracked = { state: "unmeasured", why: /** @type {Said} */ (why), items: [] };
  if (record) {
    const before = new Set(record.untracked);
    const appeared = now.untracked.filter((p) => !before.has(p));
    /** @type {Leftovers["untracked"]["items"]} */
    const items = [];
    if (appeared.length) {
      // A folder git shows whole that held nothing untracked at the start is one item.
      const folders = workTreeStatus(top, env, "normal").untracked.filter((p) => p.endsWith("/") && !record.untracked.some((q) => q.startsWith(p)));
      const left = new Set(appeared);
      for (const f of folders) {
        const under = appeared.filter((p) => p.startsWith(f));
        if (!under.length) continue;
        items.push({ path: f, files: under.length });
        for (const p of under) left.delete(p);
      }
      for (const p of left) items.push({ path: p, files: 1 });
    }
    // Untracked at the start, tracked by HEAD now: a sweep took it in. A folder entry (a nested repository) counts the
    // files HEAD tracks below it.
    const tracked = nulFields(gitBytes(["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"], { cwd: top, env, walk: true }));
    const trackedSet = new Set(tracked);
    for (const p of record.untracked) {
      const files = p.endsWith("/") ? tracked.filter((q) => q.startsWith(p)).length : trackedSet.has(p) ? 1 : 0;
      if (files) items.push({ path: p, files, committed: true });
    }
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    untracked = { state: state(items.length), items };
  }
  return { start: record ? { head: record.head, at: record.at } : null, untracked, uncommitted: { state: state(changes.length), items: changes } };
}
