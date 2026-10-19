/**
 * How often the commit-shape bypass was used: commits whose stored message
 * carries `commitMsg.allowMarker`, with the reason written. The marker only
 * checks that a reason exists; used often, it loosens the gate without anyone
 * deciding to (docs/evidence.md, Open questions). The cycle reports the count.
 *
 * Counted as the hook decides: a subject the check skips (a revert of a bypass
 * commit, a merge) is not a use. Only the messages that contain the marker are
 * read, NUL-separated (git messages cannot hold NUL), so a long history or a
 * control character in a message cannot break the count.
 */

import { git } from "../core/git.mjs";
import { allowMarkerReason, skippedSubject } from "../checks/commit-shape.mjs";
import { parseBound, gitSince } from "./szz.mjs";

/**
 * @typedef {{ hash: string, time: number, subject: string, reason: string }} BypassUse
 */

/**
 * @param {{ cwd: string, config: any, since?: string, until?: string, from?: string }} opts
 *   `since` / `until`: "YYYY-MM-DD" (local days, inclusive) or any Date.parse string; committer time.
 *   `from`: a revision; only commits after it count (`<from>..HEAD`), e.g. the HEAD a cycle started at.
 * @returns {{ commits: number, uses: BypassUse[] }} uses newest first
 */
export function bypassUses({ cwd, config, since, until, from }) {
  const lo = parseBound(since, "start");
  const hi = parseBound(until, "end");
  // Throws outside a repository: unmeasured is not zero.
  git(["rev-parse", "--git-dir"], { cwd });
  if (!git(["rev-parse", "--verify", "-q", "HEAD"], { cwd, allowFail: true })) return { commits: 0, uses: [] };
  // A bad revision throws too: a typo must not read as "no bypass since then".
  if (from !== undefined && !from) throw new RangeError("from: empty revision");
  const range = from ? [`${git(["rev-parse", "--verify", `${from}^{commit}`], { cwd })}..HEAD`] : [];
  const scope = ["--no-merges", ...(lo !== null ? [gitSince(lo)] : []), ...range];

  /** @type {Map<string, number>} */
  const inRange = new Map();
  for (const line of git(["log", "--format=%H %ct", ...scope], { cwd }).split("\n")) {
    const [hash, ct] = line.split(" ");
    const time = Number(ct);
    if (!hash || !Number.isFinite(time) || (lo !== null && time < lo) || (hi !== null && time > hi)) continue;
    inRange.set(hash, time);
  }

  const marker = config.commitMsg.allowMarker;
  const fields = git(["log", "-z", "-F", `--grep=${marker}`, "--format=%H%x00%B", ...scope], { cwd }).split("\0");
  /** @type {BypassUse[]} */
  const uses = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const hash = fields[i].replace(/^\n/, "");
    const body = fields[i + 1];
    const time = inRange.get(hash);
    if (time === undefined) continue;
    const subject = body.split("\n")[0];
    if (skippedSubject(subject, config)) continue;
    const reason = allowMarkerReason(body, marker);
    if (reason !== null) uses.push({ hash, time, subject, reason });
  }
  return { commits: inRange.size, uses };
}
