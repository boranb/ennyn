/**
 * How often the commit-shape bypass was used: commits whose stored message
 * carries `commitMsg.allowMarker`, with the reason written. The marker only
 * checks that a reason exists; used often, it loosens the gate without anyone
 * deciding to (docs/evidence.md, Open questions). The cycle reports the count.
 *
 * Counted as the hook decides: a subject the check skips (a revert of a bypass
 * commit, a merge git named) is not a use, but a merge with a subject of its own
 * is checked and counts. An amend! uses the marker only in its own body: its
 * subject repeats the target's and its body replaces the target's message. A
 * squash! is checked with its target and keeps the subject. Only the messages that contain the
 * marker are read, NUL-separated (git messages cannot hold NUL), so a long history
 * or a control character in a message cannot break the count. The range is listed
 * by commit time alone, a few bytes per commit, and filtered here: git's --since
 * stops walking at a commit dated older, and a clock off by days hides the newer
 * commits behind it. A commit with no readable committer time is in no dated
 * range, and in every range that has no dates.
 *
 * `from` must still be an ancestor of HEAD: after the cycle's start commit is
 * amended or rebased, `<from>..HEAD` reaches back to the merge base and would
 * count commits from before the cycle. Commits merged in from another line do
 * count (node bypass-first-parent). A shallow clone has no commits before its
 * boundary: the result says so when one may be in the range.
 *
 * The same range answers which keys were loosened: each commit that touched the config, read against its parents as
 * the commit-msg hook reads it (checks/loosening.mjs), with its approval lines. It reads the configs, not the lines, so
 * what reached history with no hook (--no-verify, a rebase, a cherry-pick, a fixup! folded in) shows as a key with no
 * approval. A merge is read against its first parent, for what that line gained, by value: a key leaves the merge only
 * at the value a later parent holds, when a commit of the range that only that parent brings lists the key. So an
 * approved side branch shows once, on its own commit; any other value is the merge's own, and so is a tightening it
 * dropped, which the hook lets through as no parent is looser and which has no other record. A commit it could not
 * compare, one whose config entry names no blob among them, is listed as unread, never as loosening nothing. A config
 * new at its place, the commit deleting a file it is looser than, is a rename the hook would refuse: named, unmeasured.
 *
 * It reads tracked paths only and takes no key from the work tree: its marker, skip list and language come from the
 * commit at the range's end, and an edit never staged cannot hide a use. With a config tracked at its place ENNYN_CONFIG
 * is left out, as the hook leaves it out. What no commit holds cannot be read: with none there, a config untracked or
 * ignored, a variable naming such a file or one outside, a config that left its place in the range. Those are
 * `unmeasured`, by name, never a none. The caller runs it with replace refs and grafts off, as the hook does.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { blobAt, git, gitMaybe, headCommit } from "../core/git.mjs";
import { CONFIG_PATH, DEFAULTS, configFrom } from "../core/config.mjs";
import { present } from "../core/files.mjs";
import { allowMarkerReason, skippedSubject } from "../checks/commit-shape.mjs";
import { approvalLines, approvedKeys, configAt, inside, loaded, loosenedKeys, sameValue } from "../checks/loosening.mjs";
import { parseBound, shallowEdge } from "./szz.mjs";

/**
 * @typedef {{ hash: string, time: number, subject: string, reason: string }} BypassUse
 */

/**
 * @typedef {{ hash: string, time: number, subject: string, keys: string[], lines: string[], unapproved: string[] }} Loosening
 *   `keys`: what the commit loosens against its first parent; `lines`: its approval lines as written; `unapproved`: keys no line names
 */

/** @typedef {{ key: string, vars: Record<string, string> }} Said a catalog line, worded in the language of the commit read */

/** @param {string} s */
const timeOf = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);

/**
 * The files a commit deletes against `parent` that load as a config, as the hook reads a rename.
 * @param {string} cwd @param {string} parent @param {string} hash
 * @returns {{ path: string, cfg: any }[]}
 */
function deletedConfigsAt(cwd, parent, hash) {
  const gone = git(["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", "--diff-filter=D", "--name-only", parent, hash], { cwd, walk: true }).split("\0").filter(Boolean);
  return gone.flatMap((path) => {
    const bytes = blobAt(cwd, parent, path);
    const cfg = Buffer.isBuffer(bytes) ? loaded(bytes, cwd, join(cwd, path)).cfg : undefined;
    return cfg ? [{ path, cfg }] : [];
  });
}

/**
 * The commits of a range that loosened a key of the config in force.
 * @param {{ cwd: string, namedRel: string | null, range: string[], within: (time: number) => boolean, edge: Set<string> }} opts
 *   `edge`: a shallow clone's boundary commits, whose parents are not here
 * @returns {{ loosened: Loosening[], unread: { hash: string, reason: Said }[], moved: Said[] }}
 */
function configMoves({ cwd, namedRel, range, within, edge }) {
  /** @typedef {{ cfg: any, brought: Set<string> }} Side a parent past the first: its config, and the commits only it brings */
  /** @type {(Loosening & { merge: boolean, cfg?: any, sides: Side[] })[]} */
  const found = [];
  /** @type {{ hash: string, reason: Said }[]} */
  const unread = [];
  /** @type {Said[]} */
  const moved = [];
  const defaults = configFrom(null, { cwd, configPath: join(cwd, CONFIG_PATH) });
  const paths = namedRel && namedRel !== CONFIG_PATH ? [CONFIG_PATH, namedRel] : [CONFIG_PATH];
  // --full-history: a commit a merge's simpler side leaves out still changed the config.
  for (const line of git(["log", "--full-history", "--format=%H %ct %P", ...range, "--", ...paths], { cwd, walk: true }).split("\n").filter(Boolean)) {
    // A root commit's %P is empty, and so is a commit's %ct with no committer time: by position, then.
    const [hash, ct, ...rest] = line.split(" ");
    const parents = rest.filter(Boolean);
    const time = timeOf(ct);
    if (!within(time)) continue;
    if (edge.has(hash)) {
      unread.push({ hash, reason: { key: "bypass.reason.shallow", vars: {} } });
      continue;
    }
    try {
      const before = parents.length ? parents.map((p) => configAt(cwd, p, namedRel)) : [{ rel: null, cfg: defaults }];
      const after = configAt(cwd, hash, namedRel);
      const [first] = before;
      const short = hash.slice(0, 10);
      if (first.rel && first.rel !== after.rel) moved.push(after.rel ? { key: "bypass.looseMoved", vars: { from: first.rel, to: after.rel, hash: short } } : { key: "bypass.looseLeft", vars: { path: first.rel, hash: short } });
      if (!first.cfg) {
        unread.push({ hash, reason: { key: "bypass.reason.parent", vars: { error: String(first.error) } } });
        continue;
      }
      if (after.wrongType) {
        unread.push({ hash, reason: { key: "bypass.reason.failed", vars: { error: String(after.error) } } });
        continue;
      }
      if (parents.length && !first.rel && after.rel && after.cfg) {
        for (const { path, cfg } of deletedConfigsAt(cwd, parents[0], hash)) if (loosenedKeys(cfg, after.cfg).length) moved.push({ key: "bypass.looseMoved", vars: { from: path, to: after.rel, hash: short } });
      }
      const keys = after.cfg ? loosenedKeys(first.cfg, after.cfg) : [String(after.rel)];
      if (!keys.length) continue;
      const message = git(["log", "-1", "--format=%B", hash, "--"], { cwd });
      const named = approvedKeys(message, keys);
      const sides = before.flatMap((b, i) => (i > 0 && b.cfg ? [{ cfg: b.cfg, brought: new Set(git(["rev-list", parents[i], `^${parents[0]}`], { cwd, walk: true }).split("\n")) }] : []));
      found.push({ hash, time, subject: message.split("\n")[0], keys, lines: approvalLines(message), unapproved: keys.filter((k) => !named.has(k)), merge: parents.length > 1, cfg: after.cfg, sides });
    } catch (e) {
      const error = /** @type {Error & { stderr?: unknown }} */ (e);
      unread.push({ hash, reason: { key: "bypass.reason.failed", vars: { error: String(error.stderr || error.message).trim().split("\n")[0] } } });
    }
  }
  const listed = new Map(found.filter((f) => !f.merge).map((f) => [f.hash, f.keys]));
  const loosened = found.flatMap(({ merge, cfg, sides, ...f }) => {
    const covered = (/** @type {string} */ key) => Boolean(cfg) && sides.some((s) => sameValue(key, s.cfg, cfg) && [...s.brought].some((h) => listed.get(h)?.includes(key)));
    const keys = merge ? f.keys.filter((k) => !covered(k)) : f.keys;
    return keys.length ? [{ ...f, keys, unapproved: f.unapproved.filter((k) => keys.includes(k)) }] : [];
  });
  return { loosened, unread, moved };
}

/**
 * The commit a cycle started at, by the revision noted then. A revision that names no commit, or one that is no
 * longer an ancestor of HEAD, throws RangeError with why: a typo must not read as "nothing since then", and after an
 * amend or a rebase `<from>..HEAD` reaches back to the merge base. Any other failure is git's, and throws as such.
 * @param {string} cwd @param {string} from @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the full hash
 */
export function cycleStart(cwd, from, env = process.env) {
  const start = gitMaybe(["rev-parse", "--verify", "-q", `${from}^{commit}`], { cwd, env, absent: [1] });
  if (!start) {
    const shallow = git(["rev-parse", "--is-shallow-repository"], { cwd, env }) === "true";
    throw new RangeError(`from: "${from}" is not in this repository${shallow ? "; the clone is shallow, it may lie past the boundary" : ""}`);
  }
  if (gitMaybe(["merge-base", "--is-ancestor", start, "HEAD"], { cwd, env, absent: [1], walk: true }) === null) {
    throw new RangeError(`from: "${from}" is not an ancestor of HEAD (amended or rebased since?); the range would count commits from before it`);
  }
  return start;
}

/**
 * @param {{ cwd: string, since?: string, until?: string, from?: string, env?: NodeJS.ProcessEnv }} opts
 *   `since` / `until`: "YYYY-MM-DD" (local days, inclusive) or any Date.parse string; committer time.
 *   `from`: a revision; only commits after it count (`<from>..HEAD`), e.g. the HEAD a cycle started at.
 * @returns {{ commits: number, uses: BypassUse[], shallow: boolean, loosened: Loosening[], unread: { hash: string, reason: Said }[], unmeasured: Said[], language: string }}
 *   uses and loosened newest first; `shallow`: commits before a shallow clone's boundary could be in the range and
 *   are not counted; `unread`: commits that touched the config and could not be compared; `unmeasured`: what the range's
 *   config rests on that no commit holds; `language`: the end commit's
 */
export function bypassUses({ cwd, since, until, from, env = process.env }) {
  const lo = parseBound(since, "start");
  const hi = parseBound(until, "end");
  // Throws outside a repository: unmeasured is not zero.
  git(["rev-parse", "--git-dir"], { cwd });
  const isShallow = git(["rev-parse", "--is-shallow-repository"], { cwd }) === "true";
  if (!headCommit(cwd)) return { commits: 0, uses: [], shallow: false, loosened: [], unread: [], unmeasured: [], language: DEFAULTS.language };
  // A bad revision throws too: see cycleStart.
  if (from !== undefined && !from) throw new RangeError("from: empty revision");
  /** @type {string[]} */
  let range = [];
  let shallow = isShallow;
  if (from) {
    const start = cycleStart(cwd, from);
    range = [`${start}..HEAD`];
    // Inside the range a merge can still reach past the boundary: then commits of the range are missing.
    if (isShallow) {
      const edge = shallowEdge(cwd);
      shallow = git(["rev-list", ...range], { cwd, walk: true }).split("\n").some((h) => edge.has(h));
    }
  }
  const within = (/** @type {number} */ time) => (lo === null && hi === null) || (Number.isFinite(time) && (lo === null || time >= lo) && (hi === null || time <= hi));

  // As the hook reads it: with a config tracked at its place the variable decides nothing.
  const given = blobAt(cwd, "HEAD", CONFIG_PATH) === null ? env.ENNYN_CONFIG || null : null;
  const namedRel = given ? inside(cwd, given) : null;
  const end = configAt(cwd, "HEAD", namedRel);
  /** @type {any} */
  const config = end.cfg ?? configFrom(null, { cwd, configPath: join(cwd, CONFIG_PATH) });
  /** @type {Said[]} */
  const unmeasured = [];
  const notHeld = (/** @type {string} */ path) => unmeasured.push({ key: "bypass.looseNotHeld", vars: { path } });
  if (given && namedRel === null) unmeasured.push({ key: "bypass.looseOutside", vars: {} });
  else if (namedRel !== null && blobAt(cwd, "HEAD", namedRel) === null) notHeld(namedRel);
  else if (end.rel === null && present(join(cwd, CONFIG_PATH), lstatSync)) notHeld(CONFIG_PATH);
  if (end.error) unmeasured.push({ key: "bypass.looseEnd", vars: { path: String(end.rel), error: end.error } });

  let commits = 0;
  // One line per commit, marked: a commit with no committer time prints an empty %ct, an empty range nothing.
  for (const line of git(["log", "--no-merges", "--format=x%ct", ...range], { cwd, walk: true }).split("\n")) if (line.startsWith("x") && within(timeOf(line.slice(1)))) commits++;
  // Merges are few: those the hook checks (a first line of their own) count as commits.
  const merges = git(["log", "--merges", "-z", "--format=%ct%x00%B", ...range], { cwd, walk: true }).split("\0");
  for (let i = 0; i + 1 < merges.length; i += 2) if (within(timeOf(merges[i].replace(/^\n/, ""))) && !skippedSubject(merges[i + 1].split("\n")[0], config)) commits++;

  const marker = config.commitMsg.allowMarker;
  const fields = git(["log", "-z", "-F", `--grep=${marker}`, "--format=%H%x00%ct%x00%B", ...range], { cwd, walk: true }).split("\0");
  /** @type {BypassUse[]} */
  const uses = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const hash = fields[i].replace(/^\n/, "");
    const time = timeOf(fields[i + 1]);
    const body = fields[i + 2];
    if (!within(time)) continue;
    const subject = body.split("\n")[0];
    if (skippedSubject(subject, config)) continue;
    const own = /^amend! /.test(subject) ? body.slice(subject.length) : body;
    const reason = allowMarkerReason(own, marker);
    if (reason !== null) uses.push({ hash, time, subject, reason });
  }
  const { moved, ...keys } = configMoves({ cwd, namedRel, range, within, edge: isShallow ? shallowEdge(cwd) : new Set() });
  return { commits, uses, shallow, ...keys, unmeasured: [...unmeasured, ...moved], language: config.language };
}
