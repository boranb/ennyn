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
 */

import { git, gitMaybe, headCommit } from "../core/git.mjs";
import { allowMarkerReason, skippedSubject } from "../checks/commit-shape.mjs";
import { parseBound, shallowEdge } from "./szz.mjs";

/**
 * @typedef {{ hash: string, time: number, subject: string, reason: string }} BypassUse
 */

/** @param {string} s */
const timeOf = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);

/**
 * @param {{ cwd: string, config: any, since?: string, until?: string, from?: string }} opts
 *   `since` / `until`: "YYYY-MM-DD" (local days, inclusive) or any Date.parse string; committer time.
 *   `from`: a revision; only commits after it count (`<from>..HEAD`), e.g. the HEAD a cycle started at.
 * @returns {{ commits: number, uses: BypassUse[], shallow: boolean }} uses newest first; `shallow`: commits
 *   before a shallow clone's boundary could be in the range and are not counted
 */
export function bypassUses({ cwd, config, since, until, from }) {
  const lo = parseBound(since, "start");
  const hi = parseBound(until, "end");
  // Throws outside a repository: unmeasured is not zero.
  git(["rev-parse", "--git-dir"], { cwd });
  const isShallow = git(["rev-parse", "--is-shallow-repository"], { cwd }) === "true";
  if (!headCommit(cwd)) return { commits: 0, uses: [], shallow: false };
  // A bad revision throws too: a typo must not read as "no bypass since then".
  if (from !== undefined && !from) throw new RangeError("from: empty revision");
  /** @type {string[]} */
  let range = [];
  let shallow = isShallow;
  if (from) {
    const start = gitMaybe(["rev-parse", "--verify", "-q", `${from}^{commit}`], { cwd, absent: [1] });
    if (!start) throw new RangeError(`from: "${from}" is not in this repository${isShallow ? "; the clone is shallow, it may lie past the boundary" : ""}`);
    if (gitMaybe(["merge-base", "--is-ancestor", start, "HEAD"], { cwd, absent: [1] }) === null) {
      throw new RangeError(`from: "${from}" is not an ancestor of HEAD (amended or rebased since?); the range would count commits from before it`);
    }
    range = [`${start}..HEAD`];
    // Inside the range a merge can still reach past the boundary: then commits of the range are missing.
    if (isShallow) {
      const edge = shallowEdge(cwd);
      shallow = git(["rev-list", ...range], { cwd }).split("\n").some((h) => edge.has(h));
    }
  }
  const within = (/** @type {number} */ time) => (lo === null && hi === null) || (Number.isFinite(time) && (lo === null || time >= lo) && (hi === null || time <= hi));

  let commits = 0;
  // One line per commit, marked: a commit with no committer time prints an empty %ct, an empty range nothing.
  for (const line of git(["log", "--no-merges", "--format=x%ct", ...range], { cwd }).split("\n")) if (line.startsWith("x") && within(timeOf(line.slice(1)))) commits++;
  // Merges are few: those the hook checks (a first line of their own) count as commits.
  const merges = git(["log", "--merges", "-z", "--format=%ct%x00%B", ...range], { cwd }).split("\0");
  for (let i = 0; i + 1 < merges.length; i += 2) if (within(timeOf(merges[i].replace(/^\n/, ""))) && !skippedSubject(merges[i + 1].split("\n")[0], config)) commits++;

  const marker = config.commitMsg.allowMarker;
  const fields = git(["log", "-z", "-F", `--grep=${marker}`, "--format=%H%x00%ct%x00%B", ...range], { cwd }).split("\0");
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
  return { commits, uses, shallow };
}
