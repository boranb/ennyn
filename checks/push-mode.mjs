/**
 * Whether the cycle may push by itself: the one decision the push hook and `ennyn push-check` share (push.mode
 * `after-closing`, skills/cycle/push.md). Everything here answers "ask" unless each of these holds:
 *
 * - the mode: HEAD's config at the repository's top and the work tree's both say `after-closing` (pushModeAt). A config
 *   only the work tree holds, one ENNYN_CONFIG names outside the repository, or one in a subfolder a session started in
 *   is no commit the guard judged, so it decides nothing;
 * - the checkout: with `project`, the folder the push runs in (the shell's, which an earlier `cd` moves) is in the same
 *   checkout, by top level and git dir, as the folder whose config decided;
 * - the approval (approvalLost): the latest commit on HEAD's first-parent line that moved the mode to `after-closing`
 *   carries `User-Approved-Loosening: push.mode`, and no commit HEAD reaches past it set it back to ask. A revert, a
 *   cherry-pick, a rebase, `commit-tree` or `--no-verify` reach HEAD with no commit-msg hook run, so the line is read
 *   here again. A replayed commit of the user's own keeps its line, and a reset past an unpushed move back leaves
 *   nothing to read: stated limits;
 * - what a bare `git push` sends (pushWidened): the current branch to the branch of its name on its upstream remote's
 *   one url, read by allowing. git config can make it send more or elsewhere (measured on git 2.56.0 and 2.34.1:
 *   `remote.<r>.mirror` deleted a remote branch and rewrote another, a `remote.<r>.push` refspec with `+` rewrote one,
 *   `push.default matching` pushed every branch of the same name; a pushurl, a second url and an insteadOf or
 *   pushInsteadOf rewrite each change what `git remote get-url --push --all` gives).
 *
 * Values come from git one key a call (`git config --get`), read as it reads them for the push in this environment;
 * an environment that differs at the push (another GIT_CONFIG_*) is not seen. A git that fails is said, and asks.
 */

import { join } from "node:path";
import { CONFIG_PATH, DEFAULTS, loadConfig } from "../core/config.mjs";
import { HOOK_READ_ENV, git, gitBytes, gitMaybe, headCommit, projectRoot } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { commitsRefused, pushRule } from "./commit-identity.mjs";
import { approvedKeys, configAt, inside, loaded } from "./loosening.mjs";
import { masked } from "./secrets.mjs";
import { pushNeeds } from "./test-runs.mjs";

/** @typedef {{ key: string, vars: Record<string, string> }} Line a catalog line */
/**
 * @typedef {{ key: string, vars: Record<string, string | number | Line> } | { commit: string, why: Line[] }} Said
 *   a line of push-check's verdict: a catalog line (a value may be a catalog line of its own), or a commit the commits
 *   rule refuses, by its short hash, with why
 */

/** @param {unknown} e */
const firstLine = (e) => String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];

/**
 * The push mode at HEAD and in the work tree: `after-closing` only when both hold it. No commit yet: the defaults. A
 * side that cannot be read or does not load is `unread`, its first error in `error`, and the mode is `ask`.
 * @param {string} cwd the repository's top @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: "ask" | "after-closing", head: string, work: string, error?: string }}
 */
export function pushModeAt(cwd, env = process.env) {
  /** @type {string[]} */
  const errors = [];
  const side = (/** @type {() => { cfg?: any, error?: string }} */ read) => {
    try {
      const { cfg, error } = read();
      if (cfg) return String(cfg.push.mode);
      errors.push(String(error));
    } catch (e) {
      errors.push(firstLine(e));
    }
    return "unread";
  };
  const named = env.ENNYN_CONFIG ? inside(cwd, env.ENNYN_CONFIG) : null;
  const head = side(() => {
    const at = headCommit(cwd);
    return at ? configAt(cwd, at, named) : { cfg: DEFAULTS };
  });
  const work = side(() => ({ cfg: loadConfig({ cwd, env }) }));
  return { mode: head === "after-closing" && work === "after-closing" ? "after-closing" : "ask", head, work, ...(errors.length ? { error: masked(errors[0]) } : {}) };
}

const AFTER = "after-closing";

/**
 * Each `<rev>:<path>` as one `git cat-file --batch` reads it: its bytes, null when the commit holds nothing there,
 * "other" for an object of another type. One git call, however many there are.
 * @param {string} cwd @param {string[]} specs
 * @returns {(Buffer | null | "other")[]}
 */
function blobsAt(cwd, specs) {
  if (!specs.length) return [];
  const out = gitBytes(["cat-file", "--batch"], { cwd, env: { ...process.env, ...HOOK_READ_ENV }, input: specs.map((s) => `${s}\n`).join(""), walk: true });
  /** @type {(Buffer | null | "other")[]} */
  const found = [];
  let at = 0;
  for (const spec of specs) {
    const end = out.indexOf(10, at);
    const head = out.subarray(at, end).toString("utf8");
    at = end + 1;
    if (head === `${spec} missing`) {
      found.push(null);
      continue;
    }
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(head);
    if (!m) throw new Error(`git cat-file --batch answered ${JSON.stringify(head.slice(0, 80))} for ${spec}`);
    found.push(m[1] === "blob" ? out.subarray(at, at + Number(m[2])) : "other");
    at += Number(m[2]) + 1;
  }
  return found;
}

/**
 * Whether the approval stands: the latest commit on HEAD's first-parent line that moved push.mode to after-closing
 * (against its first parent; a root against the defaults) holds the approval line, and no commit HEAD reaches that the
 * approval does not, on any line, moved the mode from after-closing back to ask. A merge `-s ours` keeps a branch's
 * after-closing past the user's own move back, and a first-parent reading would not see it. Read in four git calls, the
 * history's length aside: the config's commits with their parents and messages, the first-parent ones, every version
 * of the config in one batch, and what HEAD reaches past the approval. A shallow clone has no history to read: it asks.
 * @param {string} cwd @param {string | null} named
 * @returns {Line | null} why the approval does not stand
 */
function approvalLost(cwd, named) {
  if (gitMaybe(["rev-parse", "--is-shallow-repository"], { cwd, absent: [] }) === "true") return { key: "push.modeShallow", vars: {} };
  const paths = named && named !== CONFIG_PATH ? [CONFIG_PATH, named] : [CONFIG_PATH];
  if (paths.some((p) => /[\n\0]/.test(p))) return { key: "push.modeUnread", vars: { error: "a config path no git batch can name" } };
  const env = { ...process.env, ...HOOK_READ_ENV };
  /** @type {Map<string, { parents: string[], message: string }>} */
  const commits = new Map();
  for (const record of git(["log", "--full-history", "--format=%H %P%n%B%x00", "HEAD", "--", ...paths], { cwd, env, walk: true }).split("\0")) {
    const text = record.replace(/^\n/, "");
    if (!text) continue;
    const [first, ...body] = text.split("\n");
    const [hash, ...parents] = first.split(" ").filter(Boolean);
    commits.set(hash, { parents, message: body.join("\n") });
  }
  const line = git(["log", "--first-parent", "--format=%H", "HEAD", "--", ...paths], { cwd, env, walk: true }).split("\n").filter(Boolean);
  const revs = [...new Set([...commits.keys(), ...[...commits.values()].flatMap((c) => c.parents)])];
  const blobs = blobsAt(cwd, revs.flatMap((r) => paths.map((p) => `${r}:${p}`)));
  /** @type {Map<string, string>} */
  const parsed = new Map();
  /** @type {Map<string, string>} */
  const modes = new Map();
  revs.forEach((rev, k) => {
    const found = paths.map((_, n) => blobs[k * paths.length + n]).find((b) => b !== null);
    if (found === undefined) return modes.set(rev, String(DEFAULTS.push.mode));
    if (found === "other") return modes.set(rev, "unread");
    const key = found.toString("base64");
    if (!parsed.has(key)) parsed.set(key, String(loaded(found, cwd, join(cwd, CONFIG_PATH)).cfg?.push.mode ?? "unread"));
    modes.set(rev, /** @type {string} */ (parsed.get(key)));
  });
  const mode = (/** @type {string | undefined} */ rev) => (rev === undefined ? String(DEFAULTS.push.mode) : modes.get(rev) ?? "unread");
  const setter = line.find((h) => mode(h) === AFTER && mode(commits.get(h)?.parents[0]) !== AFTER);
  if (!setter || !approvedKeys(commits.get(setter)?.message ?? "").has("push.mode")) return { key: "push.modeUnapproved", vars: { hash: setter ? setter.slice(0, 12) : "none" } };
  const past = git(["rev-list", "--full-history", "HEAD", `^${setter}`, "--", ...paths], { cwd, env, walk: true }).split("\n").filter(Boolean);
  const back = past.find((h) => mode(h) !== AFTER && (commits.get(h)?.parents ?? []).some((p) => mode(p) === AFTER));
  return back ? { key: "push.modeTakenBack", vars: { hash: back.slice(0, 12) } } : null;
}

/** What may stand under the upstream remote: what fetches, and its one url. Anything else there changes the push. */
const REMOTE_KEYS = new Set(["url", "fetch", "tagopt", "prune", "prunetags", "skipdefaultupdate", "skipfetchall", "promisor", "partialclonefilter", "followremotehead"]);

/**
 * What in git config makes a bare `git push` of `branch` send other than that branch to the branch of its name on its
 * upstream remote's one url, or null. An allow reading: the remote holds only what REMOTE_KEYS names and one url, which
 * `git remote get-url --push --all` gives back unchanged (no pushurl, no second url, no insteadOf or pushInsteadOf
 * rewrite, measured on git 2.56.0 and 2.34.1); push.default simple, upstream or current; no other push remote, no
 * followTags, no submodule push.
 * @param {string} cwd @param {string} branch
 * @returns {string | null} the setting, as git names it
 */
function pushWidened(cwd, branch) {
  const get = (/** @type {string} */ key, /** @type {string[]} */ type = []) => gitMaybe(["config", ...type, "--get", key], { cwd, absent: [1] });
  const remote = get(`branch.${branch}.remote`);
  if (!remote || remote === ".") return `branch.${branch}.remote`;
  if (get(`branch.${branch}.merge`) !== `refs/heads/${branch}`) return `branch.${branch}.merge`;
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
    const other = get(key);
    if (other !== null && other !== remote) return key;
  }
  const section = `remote.${remote}.`;
  const names = gitMaybe(["config", "--name-only", "--get-regexp", `^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], { cwd, absent: [1] }) ?? "";
  const odd = names.split("\n").find((n) => n && !(n.startsWith(section) && REMOTE_KEYS.has(n.slice(section.length).toLowerCase())));
  if (odd) return odd;
  const urls = (gitMaybe(["config", "--get-all", `${section}url`], { cwd, absent: [1] }) ?? "").split("\n").filter(Boolean);
  if (urls.length !== 1 || gitMaybe(["remote", "get-url", "--push", "--all", remote], { cwd, absent: [2] }) !== urls[0]) return `${section}url`;
  if (!["simple", "upstream", "tracking", "current", null].includes(get("push.default"))) return "push.default";
  if (get("push.followTags", ["--type=bool"]) === "true") return "push.followTags";
  if (![null, "no", "false", "check"].includes(get("push.recurseSubmodules"))) return "push.recurseSubmodules";
  if (get("submodule.recurse", ["--type=bool"]) === "true") return "submodule.recurse";
  return null;
}

/**
 * Whether the cycle may push by itself here, and the lines that say why not.
 * @param {string} cwd the folder the push runs in @param {NodeJS.ProcessEnv} [env]
 * @param {{ project?: string }} [opts] `project`: the session's folder, whose config decided: unless `cwd` is in the same
 *   checkout (top level and git dir), it asks
 * @returns {{ ok: boolean, mode: "ask" | "after-closing", head: string, work: string, error?: string, branch: string | null, said: Line[] }}
 */
export function closingPush(cwd, env = process.env, { project } = {}) {
  const top = projectRoot(cwd);
  // The push runs where the shell stands: a decision taken for another checkout says nothing of it.
  if (project !== undefined) {
    const where = (/** @type {string} */ dir) => gitMaybe(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: dir, absent: [128] });
    let same = false;
    try {
      same = where(cwd) !== null && where(cwd) === where(project);
    } catch {
      same = false;
    }
    if (!same) return { mode: /** @type {const} */ ("ask"), head: "unread", work: "unread", ok: false, branch: null, said: [{ key: "push.modeElsewhere", vars: { cwd } }] };
  }
  const m = pushModeAt(top, env);
  /** @type {Line[]} */
  const said = [];
  const no = () => ({ ...m, ok: false, branch: null, said });
  if (m.error !== undefined) said.push({ key: "push.modeUnread", vars: { error: m.error } });
  else if (m.head !== m.work) said.push({ key: "push.modeSplit", vars: { head: m.head, work: m.work } });
  if (m.mode === "ask") return (said.push({ key: "push.modeAsk", vars: {} }), no());
  try {
    const lost = approvalLost(top, env.ENNYN_CONFIG ? inside(top, env.ENNYN_CONFIG) : null);
    if (lost) return (said.push(lost), no());
    const branch = gitMaybe(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: top, absent: [1] });
    if (!branch) return (said.push({ key: "push.modeDetached", vars: {} }), no());
    const wide = pushWidened(top, branch);
    if (wide) return (said.push({ key: "push.modeWidened", vars: { setting: wide } }), no());
    return { ...m, ok: true, branch, said };
  } catch (e) {
    said.push({ key: "push.modeUnread", vars: { error: masked(firstLine(e)) } });
    return no();
  }
}

/**
 * The verdict of `ennyn push-check`: what the push needs from the test record and whether it is met (pushNeeds), the
 * commits rule on what it sends (pushRule, commitsRefused), the mode (closingPush), and the exit that sums them. One
 * verdict, which push-check prints and the push hook reads (hookVerdict): exit 0 only where the cycle may push by
 * itself, on a green run the record holds on HEAD's tree with nothing uncommitted, or on `tested`; 3 where the tests
 * are met and the push is asked; 1 for the rest, a commit the rule refuses or a range it cannot read in every mode.
 * @param {string} cwd the repository's top @param {any} config
 * @param {{ tested?: string, fetch?: boolean, env?: NodeJS.ProcessEnv, closing?: ReturnType<typeof closingPush> }} [opts]
 *   `tested`: the hash the caller names as tested (its word); `fetch`: false reads the upstream as the last fetch left
 *   it; `closing`: closingPush's answer when the caller already took it
 * @returns {{ exit: 0 | 1 | 3, branch: string | null, said: Said[] }}
 */
export function pushVerdict(cwd, config, { tested, fetch = true, env = process.env, closing } = {}) {
  /** @type {Said[]} */
  const said = [];
  const say = (/** @type {string} */ key, /** @type {Record<string, string | number | Line>} */ vars = {}) => said.push({ key, vars });
  // What the push needs, from the commits it sends and the record of runs (checks/test-runs.mjs). A git that fails
  // is said: nothing here reads as met.
  /** @type {ReturnType<typeof pushNeeds>} */
  let needs;
  try {
    needs = pushNeeds(cwd, config, { fetch });
  } catch (e) {
    needs = { unmeasured: firstLine(e) };
  }
  /** Whether the push may go as far as the tests go: measured, not behind, and nothing to run or met. */
  let ready = false;
  if ("unmeasured" in needs) say("push.needUnmeasured", { why: masked(needs.unmeasured) });
  else {
    if (fetch && needs.fetched !== null) say("push.notFetched", { why: masked(needs.fetched) });
    const tree = needs.tree.slice(0, 12);
    if (needs.behind) say("push.behind", { n: needs.behind });
    else if (needs.need === null) say("push.needNothing");
    else {
      /** @type {Line} */
      const why = needs.code === null ? { key: "push.noCode", vars: {} } : { key: "push.code", vars: { path: needs.code } };
      if (needs.met) say("push.needMet", { kind: needs.need, tree, why, end: String(/** @type {any} */ (needs.last).end) });
      else say(needs.last ? "push.needRed" : "push.needRun", { kind: needs.need, tree, why, end: String(needs.last?.end) });
    }
    ready = !needs.behind && (needs.need === null || needs.met);
  }
  // Who wrote what the push sends, and whether it is signed (commits.*): a refusal, or a range not read, is exit 1 in
  // every mode, whatever the tests say. The rule is the strictest of the work tree's, HEAD's and the upstream's
  // config (pushRule): an edit not committed, ENNYN_CONFIG or a loosening inside the range does not take it off.
  let identityOk = true;
  const unread = (/** @type {unknown} */ e) => {
    say("push.commitsUnmeasured", { why: masked(firstLine(e)) });
    identityOk = false;
  };
  /** @type {ReturnType<typeof pushRule>} */
  let rule = null;
  try {
    rule = pushRule(cwd, config, "unmeasured" in needs ? null : needs.upstream);
  } catch (e) {
    unread(e);
  }
  if (rule) {
    try {
      if ("unmeasured" in needs) throw new Error(needs.unmeasured);
      const { checked, refused } = commitsRefused(cwd, rule, needs.upstream);
      if (refused.length) {
        say("push.commitsRefused", { n: refused.length, total: checked });
        for (const r of refused) said.push({ commit: r.hash.slice(0, 12), why: r.why });
        say("push.commitsSetup");
      } else say("push.commitsOk", { n: checked });
      identityOk = !refused.length;
    } catch (e) {
      unread(e);
    }
  }
  // The push itself: by the user's yes, or with after-closing by the cycle, on a commit whose tree the record holds
  // green, or one the caller names as tested, with nothing uncommitted. Either is a word: a record line is a file any
  // process here can write. Under ask neither pushes.
  const push = closing ?? closingPush(cwd, env);
  said.push(...push.said);
  const end = (/** @type {0 | 1 | 3} */ exit) => ({ exit, branch: push.branch, said });
  if (!identityOk) return end(1);
  if (!push.ok) return end(tested !== undefined || !ready ? 1 : 3);
  const clean = () => git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], { cwd }) === "";
  if (!("unmeasured" in needs) && ready && needs.met) {
    if (!clean()) return (say("push.modeDirty"), end(1));
    return (say("push.modeRecorded", { head: needs.tree.slice(0, 12), branch: String(push.branch) }), end(0));
  }
  if (tested === undefined) return (say("push.modeUntested"), end(1));
  // The caller's word stands only where the record says nothing of this tree, and never against a branch behind.
  if (!("unmeasured" in needs) && needs.red) say("push.testedRed", { kind: needs.red.kind, tree: needs.tree.slice(0, 12), end: needs.red.end, exit: needs.red.exit });
  if ("unmeasured" in needs || needs.behind || needs.last || needs.red) return end(1);
  const at = (/** @type {string} */ rev) => gitMaybe(["rev-parse", "--verify", "-q", `${rev}^{commit}`], { cwd, absent: [1] });
  const [now, named] = [at("HEAD"), at(tested)];
  if (!now || now !== named) return (say("push.modeMoved", { head: String(now).slice(0, 12), tested: tested.slice(0, 40) }), end(1));
  if (!clean()) return (say("push.modeDirty"), end(1));
  return (say("push.modeTested", { head: now.slice(0, 12), branch: String(push.branch) }), end(0));
}

/**
 * The verdict's lines as text: a value that is a catalog line is put as its own text, a refused commit as its short
 * hash and why, indented.
 * @param {Said[]} said @param {string} lang @returns {string[]}
 */
export function saidText(said, lang) {
  return said.map((s) => {
    if ("commit" in s) return `  ${s.commit} ${s.why.map((w) => t(w.key, w.vars, lang)).join("; ")}`;
    /** @type {Record<string, string | number>} */
    const vars = {};
    for (const [k, v] of Object.entries(s.vars)) vars[k] = typeof v === "object" ? t(v.key, v.vars, lang) : v;
    return t(s.key, vars, lang);
  });
}

/**
 * What the push hook reads for a push it leaves under after-closing, in the folder the shell stands in (`cwd`), for the
 * session's folder `project`: closingPush, and for a bare `git push` past it push-check's own verdict (pushVerdict),
 * taken without its fetch, since no hook makes a network call: behind and ahead are read against the last fetch. `ok`:
 * the mode allows the push (for a push that is not bare), or the verdict is exit 0 (for a bare one); `lines`: why not,
 * in `lang`.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @param {{ project: string, bare: boolean, lang?: string }} opts
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function hookVerdict(cwd, env, { project, bare, lang = "en" }) {
  const push = closingPush(cwd, env, { project });
  if (!push.ok || !bare) return { ok: push.ok, lines: saidText(push.said, lang) };
  const top = projectRoot(cwd);
  const verdict = pushVerdict(top, loadConfig({ cwd: top, env }), { fetch: false, env, closing: push });
  return { ok: verdict.exit === 0, lines: verdict.exit === 0 ? [] : saidText(verdict.said, lang) };
}
