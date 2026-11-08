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
 * `git status` by hand does; a submodule whose own work tree changed, a stray in it too, is a change `M`), its ctime
 * trusted and its full stat read whatever the repository sets, so an edit of the same size with its time set back is
 * read; each entry flagged assume-unchanged or skip-worktree, which status never reads, is read by its bytes against
 * the index. Ignored files are left out: the project chose to ignore them, and no commit takes them. The record holds
 * what each entry's path holds on disk and, for a change, in the index and HEAD, what its code compares (contentIds,
 * changeIds); a folder or a file this process cannot read has none, is compared by path, and is named at both ends. At the closing an untracked file the record holds is not the cycle's, nor
 * a change of the same path under the same code, while its path holds the same; a record with no such ids (written
 * before them) is compared by path alone, and the closing says so. One the record holds untracked that HEAD now tracks is listed: a commit that
 * swept the work tree (`git add -A`) took it in, and the run after the closing's commit would read clean.
 */

import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { READ_LIMIT, gone, readRegular, removeState, writeState } from "../core/files.mjs";
import { git, gitBytes, gitMaybe, nameText, repoPath, resolveStateDir, stateRoot } from "../core/git.mjs";
import { quoted } from "../plan/worktrees.mjs";

/** The most bytes of a start record: the writer refuses past it what its reader would refuse. */
export const START_LIMIT = READ_LIMIT;

/**
 * @typedef {{ key: string, vars: Record<string, string | number> }} Said
 * @typedef {{ code: string, path: string, from?: string }} Change a status entry: its two-letter code, its path, and the source of a rename or copy
 * @typedef {{ v: 1, head: string, top: string, at: string, untracked: string[], changed: string[], untrackedIds?: (string | null)[], changedIds?: (string | null)[] }} StartRecord
 *   `changed`: each change as `<code> <path>`; the ids: what each entry's path held (contentIds), one an entry
 * @typedef {{
 *   start: { head: string, at: string } | null,
 *   byPath?: true,
 *   unread: string[],
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
  const stat = ["-c", "core.trustctime=true", "-c", "core.checkStat=default"];
  const fields = nulFields(gitBytes(["--no-optional-locks", ...stat, "status", "--porcelain=v1", "-z", `--untracked-files=${mode}`, "--ignore-submodules=none"], { cwd: top, env, walk: true }));
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
  // ls-files -v -s: each entry's tag, mode, blob and stage; a lower-case tag is assume-unchanged, S skip-worktree.
  /** @type {Map<string, string>} */
  const index = new Map();
  /** @type {Flagged[]} */
  const flagged = [];
  for (const e of nulFields(gitBytes(["ls-files", "-v", "-s", "-z"], { cwd: top, env, walk: true }))) {
    const m = /^(\S) (\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(e);
    if (!m) continue;
    index.set(m[5], `${index.has(m[5]) ? `${index.get(m[5])} ` : ""}${m[2]} ${m[3]} ${m[4]}`);
    if (/^[a-zS]$/.test(m[1]) && m[4] === "0") flagged.push({ tag: m[1], mode: m[2], oid: m[3], path: m[5] });
  }
  const listed = new Set(changes.map((c) => c.path));
  changes.push(...flaggedChanges(top, env, flagged.filter((f) => !listed.has(f.path))));
  return { untracked, changes, index };
}

/** @typedef {{ tag: string, mode: string, oid: string, path: string }} Flagged */

/** @param {Buffer} out */
const lines = (out) => out.toString("utf8").split("\n").filter(Boolean);

/** lstat, or null when nothing is there. @param {string} p */
function lookAt(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (gone(e)) return null;
    throw e;
  }
}

/** Whether this process may read the file. @param {string} p */
function readable(p) {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Blob ids git gives the files at `paths`, with the filters `git add` runs or with none. @param {string} top @param {NodeJS.ProcessEnv} env @param {string[]} paths @param {boolean} filters */
function hashes(top, env, paths, filters) {
  const oids = paths.length ? lines(gitBytes(["hash-object", ...(filters ? [] : ["--no-filters"]), "--stdin-paths"], { cwd: top, env, walk: true, input: paths.map(quoted).join("\n") + "\n" })) : [];
  if (oids.length !== paths.length) throw new Error(`git hash-object named ${oids.length} objects for ${paths.length} files`);
  return oids;
}

/**
 * The flagged entries that differ from the index, which status never reads. Gone from disk, an assume-unchanged entry
 * is a deletion and a skip-worktree one what sparse checkout leaves. Another kind, a link to another target, a file of
 * another mode (where core.fileMode keeps one), one that cannot be read, or other bytes is a change. A file is the
 * index's when its raw bytes or the bytes `git add` would store are its blob: a text attribute added after a CRLF
 * commit stores otherwise, which status, trusting the stat, does not say either.
 * @param {string} top @param {NodeJS.ProcessEnv} env @param {Flagged[]} flagged
 * @returns {Change[]}
 */
function flaggedChanges(top, env, flagged) {
  if (!flagged.length) return [];
  const modes = process.platform !== "win32" && gitMaybe(["config", "--type=bool", "--get", "core.fileMode"], { cwd: top, env, absent: [1] }) !== "false";
  /** @type {Change[]} */
  const out = [];
  /** @type {Flagged[]} */
  const files = [];
  for (const f of flagged) {
    const at = join(top, f.path);
    const st = lookAt(at);
    if (st === null) {
      if (!/[sS]/.test(f.tag)) out.push({ code: " D", path: f.path });
    } else if (st.isSymbolicLink()) {
      const oid = gitBytes(["hash-object", "--stdin"], { cwd: top, env, input: readlinkSync(at, { encoding: "buffer" }) }).toString("utf8").trim();
      if (f.mode !== "120000" || oid !== f.oid) out.push({ code: " M", path: f.path });
    } else if (st.isFile() && /^100(644|755)$/.test(f.mode) && readable(at) && !(modes && (st.mode & 0o100 ? "100755" : "100644") !== f.mode)) files.push(f);
    else if (!(st.isDirectory() && f.mode === "160000")) out.push({ code: " M", path: f.path });
  }
  const raw = hashes(top, env, files.map((f) => f.path), false);
  const stored = hashes(top, env, files.map((f) => f.path), true);
  files.forEach((f, i) => raw[i] !== f.oid && stored[i] !== f.oid && out.push({ code: " M", path: f.path }));
  return out;
}

/**
 * What each path below `top` holds: a regular file its blob id with no filter and its executable bit, a link a hash of
 * its target, nothing there `gone`; a folder, a file this process cannot read or anything else null, which is compared
 * by path alone and said.
 * @param {string} top @param {NodeJS.ProcessEnv} env @param {string[]} paths
 * @returns {(string | null)[]}
 */
export function contentIds(top, env, paths) {
  /** @type {(string | null)[]} */
  const ids = paths.map((p) => {
    const st = lookAt(join(top, p));
    if (st === null) return "gone";
    if (st.isSymbolicLink()) return `l ${createHash("sha256").update(readlinkSync(join(top, p), { encoding: "buffer" })).digest("hex")}`;
    return st.isFile() && !p.endsWith("/") && readable(join(top, p)) ? (st.mode & 0o100 ? "x" : "f") : null;
  });
  const oids = hashes(top, env, paths.filter((_, i) => ids[i] === "x" || ids[i] === "f"), false);
  let at = 0;
  return ids.map((id) => (id === "x" || id === "f" ? `${id} ${oids[at++]}` : id));
}

/**
 * What each change's path holds on disk, in the index and in HEAD: what its status code compares. null where the disk
 * part is.
 * @param {string} top @param {NodeJS.ProcessEnv} env @param {Change[]} changes @param {Map<string, string>} index @param {Map<string, string>} head
 */
const changeIds = (top, env, changes, index, head) =>
  contentIds(top, env, changes.map((c) => c.path)).map((d, i) => (d === null ? null : `${d} ${index.get(changes[i].path) ?? "-"} ${head.get(changes[i].path) ?? "-"}`));

/** HEAD's entries, path to `<mode> <oid>`. @param {string} top @param {NodeJS.ProcessEnv} env */
function headEntries(top, env) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const e of nulFields(gitBytes(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: top, env, walk: true }))) {
    const tab = e.indexOf("\t");
    const [mode, , oid] = e.slice(0, tab).split(" ");
    out.set(e.slice(tab + 1), `${mode} ${oid}`);
  }
  return out;
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
  // Absent in a record written before them; else one an entry, each a string or null.
  const ids = (/** @type {unknown} */ v, /** @type {unknown[]} */ of) => v === undefined || (Array.isArray(v) && v.length === of.length && v.every((p) => p === null || typeof p === "string"));
  const ok = r && r.v === 1 && typeof r.head === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(r.head) && typeof r.top === "string" && typeof r.at === "string" && strings(r.untracked) && strings(r.changed) && ids(r.untrackedIds, r.untracked) && ids(r.changedIds, r.changed);
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
  const { untracked, changes, index } = workTreeStatus(top, env);
  const untrackedIds = contentIds(top, env, untracked);
  const changedIds = changeIds(top, env, changes, index, headEntries(top, env));
  /** @type {StartRecord} */
  const record = { v: 1, head, top, at: now.toISOString(), untracked, changed: changes.map(changeKey), untrackedIds, changedIds };
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
  const unread = [...untracked.filter((_, i) => untrackedIds[i] === null), ...changes.filter((_, i) => changedIds[i] === null).map((c) => c.path)];
  return { path, head, untracked: untracked.length, changed: changes.length, unread, replaced: old && "record" in old ? { head: old.record.head, at: old.record.at } : null };
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

  // An entry of the start whose path holds the same is the start's; a record with no ids, any entry of the same path.
  const byPath = record !== null && (!record.untrackedIds || !record.changedIds);
  // An entry the start holds with no id (a folder, a file it could not read) is compared by path, and named.
  /** @type {string[]} */
  const unread = [];
  /**
   * Which of `keys` are the start's: `idsOf` gives the ids of the entries at the indexes it is given.
   * @param {string[]} entries @param {(string | null)[] | undefined} was @param {string[]} keys @param {string[]} paths @param {(at: number[]) => (string | null)[]} idsOf
   */
  const ofStart = (entries, was, keys, paths, idsOf) => {
    const id = new Map(entries.map((e, i) => [e, was?.[i] ?? null]));
    const read = keys.flatMap((k, i) => (id.get(k) ? [i] : []));
    if (!byPath) keys.forEach((k, i) => id.has(k) && id.get(k) === null && unread.push(paths[i]));
    const now = idsOf(read);
    const other = new Set(read.filter((i, j) => now[j] !== id.get(keys[i])));
    return keys.map((k, i) => id.has(k) && !other.has(i));
  };
  const head = headEntries(top, env);
  const same = ofStart(record?.changed ?? [], record?.changedIds, now.changes.map(changeKey), now.changes.map((c) => c.path), (at) =>
    changeIds(top, env, at.map((i) => now.changes[i]), now.index, head),
  );
  const changes = now.changes.filter((_, i) => !same[i]).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /** @type {Leftovers["untracked"]} */
  let untracked = { state: "unmeasured", why: /** @type {Said} */ (why), items: [] };
  if (record) {
    const kept = ofStart(record.untracked, record.untrackedIds, now.untracked, now.untracked, (at) => contentIds(top, env, at.map((i) => now.untracked[i])));
    const appeared = now.untracked.filter((_, i) => !kept[i]);
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
    const tracked = [...head.keys()];
    const trackedSet = new Set(tracked);
    for (const p of record.untracked) {
      const files = p.endsWith("/") ? tracked.filter((q) => q.startsWith(p)).length : trackedSet.has(p) ? 1 : 0;
      if (files) items.push({ path: p, files, committed: true });
    }
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    untracked = { state: state(items.length), items };
  }
  return { start: record ? { head: record.head, at: record.at } : null, ...(byPath ? { byPath: /** @type {const} */ (true) } : {}), unread: unread.sort(), untracked, uncommitted: { state: state(changes.length), items: changes } };
}
