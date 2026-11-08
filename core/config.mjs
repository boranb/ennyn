/**
 * Project config loader. One file per project (`.ennyn/config.json`,
 * override with ENNYN_CONFIG). Defaults are English; a project overrides
 * only what differs. Unknown keys and type mismatches are errors, reported all
 * at once: a silently ignored typo is a gate that never runs.
 */

import { readIfThere, readRegular } from "./files.mjs";
import { underGitDir } from "./git.mjs";
import { join, isAbsolute, posix } from "node:path";
import { globToRegExp } from "./glob.mjs";

/** The config's place in a repository, unless ENNYN_CONFIG names another. */
export const CONFIG_PATH = ".ennyn/config.json";

export const DEFAULTS = Object.freeze({
  language: "en",
  // How the agent talks: normal | focused | terse (styles/). Never files or commits.
  conversation: { style: "normal" },
  // Resolved against the project directory, and kept in it (see loadConfig).
  paths: {
    handoff: "HANDOFF.md",
    graph: ".ennyn/graph.json",
    metricsLog: ".ennyn/metrics.jsonl",
    classes: ".ennyn/classes.json",
    findings: ".ennyn/findings.jsonl",
    stateDir: ".git/ennyn",
  },
  graph: {
    exports: { open: "nodes", done: "done", declined: "declined" },
    fields: {
      id: "id",
      status: "status",
      needs: "needs",
      gate: "gate",
      value: "value",
      cost: "cost",
      cluster: "cluster",
      mechanization: "mechanization",
      source: "source",
      since: "since",
      reason: "reason",
    },
    openGateValue: null,
    doneStatus: "done",
  },
  // A core pick whose cost weighs more than this is split first (core says so); null: the middle of the cost words'
  // weights (plan/mechanization.mjs). Set it when costs are numbers such as hours.
  planner: { splitAbove: null },
  // The command the cycle runs as its fast test, from the project's top; null: unset (doctor fails when the project
  // declares no test command either). A project with no tests says why: { "none": "<why>" }. `wholeTest`: the whole
  // test command, which `ennyn test whole` runs and records for push-check (checks/test-runs.mjs); null: unset.
  commands: { fastTest: null, wholeTest: null },
  commitMsg: {
    // Language of commit text; null follows `language` (reports and conversation).
    language: null,
    // Subject types, `type(scope): text`; empty = free subject. Chosen at /ennyn:init.
    types: [],
    // Type of a commit that repairs an earlier one; metrics.fixSubject must match it.
    fixType: "fix",
    // normal | terse: terse leaves no prose in the body, only structured lines and trailers.
    style: "normal",
    subjectMax: 120,
    bodyMaxLines: 8,
    bodyMaxChars: 800,
    structuredLines: ["Root cause:", "Prevention added:", "Node:", "Mutation:"],
    structuredLineMax: 300,
    // Subjects git writes itself: merges, reverts, and fixup! commits that autosquash folds away whole.
    // (amend! and squash! carry text into history; commit-check checks that text.)
    skipSubjects: ["^Merge ", "^Revert ", "^fixup! "],
    allowMarker: "[commit-shape-allow:",
  },
  review: {
    // Reviewer agents the cycle uses, given the finding schema; empty = Ennyn's own three. Chosen at /ennyn:init.
    agents: [],
    maxRounds: 2,
    roundsLine: "Review-Rounds:",
    thirdRoundLine: "Third-round:",
    impactLine: "Impact:",
    impactRequiredGlobs: [],
    // Documents that move with code, [{ paths, docs, note? }]: commit-check warns when one of `paths` is
    // staged and none of `docs` is. A warning, not an error: not every change shows in its documents.
    cochange: [],
    // Literals kept out of files, [{ text, paths, except?, note? }]: commit-check fails a commit that adds a line
    // holding `text` to a staged path `paths` names and `except` does not. A prose "never X" rule, as a gate.
    forbidden: [],
    // A change that touches only tests next to a guarded file does not need an impact table.
    impactIgnoreGlobs: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__fixtures__/**"],
  },
  // ask: the cycle asks before its push. after-closing: it pushes by itself once the closing's checks passed on that
  // commit (skills/cycle/push.md); turning it on is a loosening the user approves (checks/loosening.mjs).
  // codeGlobs: a push whose commits change a path these match needs a green whole run on its tree, any other a fast
  // one (push-check); every path by default.
  push: { warnAtUnpushed: 20, mode: "ask", codeGlobs: ["**"] },
  security: {
    // Every this many cycles the audit slot is a security audit of the sensitive paths (plan/audit.mjs, `ennyn
    // audit`); 0 turns it off.
    everyCycles: 3,
    // CI files the commit-msg hook and doctor read (checks/ci.mjs): a `uses` by tag, a pull_request_target that
    // checks out the pull request's code, a workflow without permissions. [] turns the check off.
    ci: {
      paths: [".github/workflows/*.yml", ".github/workflows/*.yaml", "**/action.yml", "**/action.yaml"],
      except: [],
    },
    // Lock files the commit-msg hook reads (checks/deps.mjs): new entries with install scripts, younger than the
    // cooldown, used by few, or whose source has no one meaning the check can prove (another host, git, a path
    // outside the repository): `sources` holds the exact `resolved` values a project accepts from such places. Only the origins in `registries` are
    // contacted (registry → downloads API, null for none; a registry URL may hold a path); `advisories` is the OSV
    // API `ennyn deps` asks ("" for none), and only about packages from the public registries in
    // `advisoryRegistries`. `paths: []` turns the check off.
    deps: {
      paths: ["**/package-lock.json", "**/npm-shrinkwrap.json"],
      cooldownDays: 7,
      minShare: 0.01,
      minWeekly: 1000,
      allow: [],
      allowScripts: [],
      sources: [],
      online: true,
      timeout: 20,
      registries: { "https://registry.npmjs.org": "https://api.npmjs.org" },
      advisories: "https://api.osv.dev",
      advisoryRegistries: ["https://registry.npmjs.org"],
    },
    // Secret shapes kept out of commits: commit-check fails a commit that adds a line holding a credential in a
    // shape only its issuer writes (checks/secrets.mjs), in any staged path `except` does not name.
    secrets: { except: [] },
  },
  // Claude Code keeps a hook's added context to 10,000 characters; the rules and the list after them fit in it.
  sideCopy: { roots: [], maxInjectBytes: 9000 },
  // Whether the PreCompact hook runs: false turns it off, the hold and the summary's ask both (adapters/claude-code/compact-boundary.mjs).
  compaction: { defer: true },
  // What the closing does for the next cycle's context: fresh names /clear or a new chat, compact names /compact
  // (skills/cycle/handover.md). Read by the closing and doctor; never mid-cycle.
  context: { afterCycle: "fresh" },
  impact: {
    referenceCommand: null,
    // Seconds the reference command may run before it is stopped and S1's references are unmeasured.
    referenceTimeout: 120,
    twins: [],
    ceilingRegistry: null,
    fakeGlobs: ["**/*.test.*"],
    fixtureGlobs: ["**/__fixtures__/**"],
  },
  metrics: {
    // fix, fix(scope) and fix! (a breaking fix): every subject the commit gate admits as the fix type.
    fixSubject: "^fix(\\(|!?:)",
    // Generated output and lockfiles are rewritten by ordinary commits; counting them measures churn.
    excludeRe: "(^docs/|\\.md$|^\\.|(^|/)(generated|dist|build|vendor)/|(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$)",
    testRe: "(\\.test\\.|\\.spec\\.|/test/|/__tests__/|/__fixtures__/)",
    // Strong link (the SZZ variant the origin project validated by hand, 60-67% precision):
    // the origin owns >= minLines meaningful deleted lines AND >= minShare of the fix's
    // deleted lines, or the fix message names the origin's hash.
    minLines: 3,
    minShare: 0.1,
    // Origins whose subject says they moved code: blame names them for lines they did not write.
    moveSubject: "^refactor|\\b(rename[ds]?|move[ds]?|split|extract(ed)?|codemod|prettier|reformat(ted)?)\\b",
  },
});

/** How a cycle's push is decided: `ask` the user, or `after-closing`, by itself once the closing's checks passed. */
export const PUSH_MODES = ["ask", "after-closing"];

/** Conversation styles; every one but "normal" has rules in styles/<style>.<lang>.md. */
export const CONVERSATION_STYLES = ["normal", "focused", "terse"];
/** What `context.afterCycle` may be: the context the next cycle starts in (skills/cycle/handover.md). */
export const AFTER_CYCLE = ["fresh", "compact"];

/**
 * The lists a config holds as strings, each of them. A member of any other kind is a config that does not load: a gate
 * would skip it, or throw on it and check nothing. `review.cochange`, `review.forbidden` and `impact.twins` hold rules
 * and pairs, each with a check of its own in configFrom. test/loosening.test.mjs fails on a list in neither group.
 */
export const STRING_LISTS = new Set([
  "commitMsg.types",
  "commitMsg.structuredLines",
  "commitMsg.skipSubjects",
  "review.agents",
  "review.impactRequiredGlobs",
  "review.impactIgnoreGlobs",
  "security.ci.paths",
  "security.ci.except",
  "security.deps.paths",
  "security.deps.allow",
  "security.deps.allowScripts",
  "security.deps.sources",
  "security.deps.advisoryRegistries",
  "security.secrets.except",
  "push.codeGlobs",
  "sideCopy.roots",
  "impact.fakeGlobs",
  "impact.fixtureGlobs",
]);

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super("Invalid ennyn config:\n- " + problems.join("\n- "));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** @param {unknown} v */
function kind(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Keys whose value is a free-form map (any key allowed below them).
const OPEN_MAPS = new Set(["graph.exports", "graph.fields", "security.deps.registries"]);
/** Maps the project gives in place of the default one, with the kinds their values take: a registry left in the list would still be contacted. */
const REPLACED_MAPS = new Map([["security.deps.registries", ["string", "null"]]]);
// Keys whose default is null but accept a value of this kind.
const NULLABLE = new Map([
  ["commitMsg.language", ["string"]],
  ["graph.openGateValue", ["string", "boolean", "number"]],
  ["impact.referenceCommand", ["string"]],
  ["impact.ceilingRegistry", ["string"]],
  ["planner.splitAbove", ["number"]],
  ["commands.fastTest", ["string", "object"]],
  ["commands.wholeTest", ["string"]],
]);

// Keys that name a file or directory Ennyn reads or writes, resolved against the project directory.
const PATH_KEYS = ["paths.handoff", "paths.graph", "paths.metricsLog", "paths.classes", "paths.findings", "paths.stateDir", "impact.ceilingRegistry"];
/** The files appended to, a record a line: each a .jsonl file of its own. */
const LOG_KEYS = ["paths.metricsLog", "paths.findings"];

/**
 * Whether a path leaves the directory it is resolved against, by its spelling as POSIX and Windows read it:
 * absolute (/x, \x, C:\x, a drive-relative C:x, \\host\x) or climbing above it (../x, a/../../x, a\..\..\x).
 * @param {string} p
 */
function leaves(p) {
  if (/^[\\/]|^[A-Za-z]:/.test(p)) return true;
  let depth = 0;
  for (const part of p.split(/[\\/]+/)) {
    if (part === "..") depth--;
    else if (part !== "" && part !== ".") depth++;
    if (depth < 0) return true;
  }
  return false;
}

/** Code points HFS+ ignores in a name (git's list, CVE-2014-9390): `.g<U+200C>it` is `.git` there. */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Whether a path names a file in a git dir, once `..` is applied, read in the safe direction as git reads its own
 * paths: a part that is `.git` as a file system that ignores case, HFS+ or Windows serves it (`.GIT`, `.g<U+200C>it`,
 * `.git.`, `.git `, a stream `.git:x` or `.git::$INDEX_ALLOCATION`, a short name `GIT~2` or `GI7EBA~1`), at any
 * depth (a nested repository's too). A git dir of another name (--separate-git-dir inside the work tree) is not
 * seen.
 * @param {string} p
 */
function inGitDir(p) {
  return posix
    .normalize(p.replace(/\\/g, "/"))
    .split("/")
    .map((part) => part.replace(HFS_IGNORED, "").toLowerCase().split(":")[0].replace(/[. ]+$/, ""))
    .some((name) => name === ".git" || /^gi(t|[0-9a-f]{4})~\d+$/.test(name));
}

/** A .jsonl file, once `.` and `..` are applied (a path that leads outside is refused before). */
const OWN_LOG = /^(?:[^/]+\/)*[^/]+\.jsonl$/;

/** A path as POSIX and as Windows read it: a backslash is part of a name on one and a separator on the other. @param {string} p */
const readings = (p) => [posix.normalize(p), posix.normalize(p.replace(/\\/g, "/"))];

/**
 * Whether a path names a .jsonl file, under both readings: a log is appended to, and a record appended to any other
 * file (a package.json, .claude/settings.json, the config itself) could break it; another tool's .jsonl stays JSON
 * lines.
 * @param {string} p
 */
const ownLog = (p) => readings(p).every((r) => OWN_LOG.test(r));

/** @param {any} cfg @param {string} key */
const valueOf = (cfg, key) => key.split(".").reduce((o, n) => o[n], cfg);

/**
 * The first other path key that names the same file as a log, as [key, value]; null when none does. Read in the
 * safe direction: either reading of one equal to either reading of the other, in any case and Unicode form, the
 * code points HFS+ ignores left out (a disk that folds them serves one file).
 * @param {any} cfg
 * @param {string} logKey one of LOG_KEYS
 * @returns {[string, string] | null}
 */
function sharesLog(cfg, logKey) {
  const fold = (/** @type {string} */ p) => readings(p).map((r) => r.normalize("NFC").replace(HFS_IGNORED, "").toLowerCase());
  const log = valueOf(cfg, logKey);
  if (typeof log !== "string") return null;
  const mine = fold(log);
  for (const key of PATH_KEYS) {
    if (key === logKey || key === "paths.stateDir") continue;
    const value = valueOf(cfg, key);
    if (typeof value === "string" && fold(value).some((r) => mine.includes(r))) return [key, value];
  }
  return null;
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 * @param {string} prefix
 * @param {string[]} problems
 */
function merge(base, over, prefix, problems) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in base)) {
      if (OPEN_MAPS.has(prefix)) {
        out[k] = v;
        continue;
      }
      problems.push(`unknown key "${path}"`);
      continue;
    }
    const bk = kind(base[k]);
    const vk = kind(v);
    // A key that defaults to null takes any of its kinds over another, whole: an override's command replaces a file's none.
    if (bk === "null" || NULLABLE.has(path)) {
      const ok = NULLABLE.get(path) ?? [];
      if (vk !== "null" && !ok.includes(vk)) problems.push(`"${path}" must be ${ok.join(" | ") || "null"}, got ${vk}`);
      else out[k] = v;
      continue;
    }
    const kinds = REPLACED_MAPS.get(path);
    if (bk === "object" && vk === "object" && kinds) {
      // Replaced, and still checked: each value is of a kind the default's values are.
      for (const [sk, sv] of Object.entries(/** @type {Record<string, unknown>} */ (v))) if (!kinds.includes(kind(sv))) problems.push(`"${path}.${sk}" must be ${kinds.join(" | ")}, got ${kind(sv)}`);
      out[k] = { .../** @type {object} */ (v) };
      continue;
    }
    if (bk === "object" && vk === "object") {
      out[k] = merge(/** @type {any} */ (base[k]), /** @type {any} */ (v), path, problems);
      continue;
    }
    if (bk !== vk) {
      problems.push(`"${path}" must be ${bk}, got ${vk}`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, override?: Record<string, unknown> }} opts
 * @returns {typeof DEFAULTS & { projectDir: string, configPath: string | null }}
 */
export function loadConfig({ cwd, env = process.env, override }) {
  const rel = env.ENNYN_CONFIG || CONFIG_PATH;
  const configPath = isAbsolute(rel) ? rel : join(cwd, rel);
  // A config that is there but cannot be read is no config problem to report and go on from: it throws. One
  // the user named (ENNYN_CONFIG) is read whatever it is (`<(…)`, /dev/stdin); the project's own as a regular
  // file through no link a commit may hold (core/files.mjs), so no file outside reaches a parse error.
  const own = env.ENNYN_CONFIG ? null : readRegular(cwd, configPath);
  const text = env.ENNYN_CONFIG ? readIfThere(configPath, { given: true }) : own && own.toString("utf8");
  return configFrom(text, { cwd, configPath, override });
}

/**
 * A config from its text, wherever that was read (a file, a commit, the index), held to everything loadConfig
 * holds a file to; null text is no config, the defaults.
 * @param {string | null} text
 * @param {{ cwd: string, configPath: string, override?: Record<string, unknown> }} opts
 * @returns {typeof DEFAULTS & { projectDir: string, configPath: string | null }}
 */
export function configFrom(text, { cwd, configPath, override }) {
  /** @type {Record<string, unknown>} */
  let user = {};
  let found = null;
  if (text !== null) {
    found = configPath;
    try {
      // A byte order mark some editors write is no part of the JSON.
      user = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new ConfigError([`cannot parse ${configPath}: ${/** @type {Error} */ (err).message}`]);
    }
    if (user === null || typeof user !== "object" || Array.isArray(user)) throw new ConfigError([`${configPath} must hold a JSON object`]);
  }
  /** @type {string[]} */
  const problems = [];
  let cfg = merge(/** @type {any} */ (DEFAULTS), user, "", problems);
  if (override) cfg = merge(cfg, override, "", problems);
  // First: every check below reads these members as strings, and one that is not can throw there. The config fails
  // either way, so they go on without it, and what else is wrong is said with it. `cfg` holds its own copy of any list
  // a user wrote, down the path merge() walked.
  for (const key of STRING_LISTS) {
    const path = key.split(".");
    const list = /** @type {unknown[]} */ (valueOf(cfg, key));
    if (list.every((v) => typeof v === "string")) continue;
    problems.push(`"${key}" must be a list of strings`);
    /** @type {any} */ (path.slice(0, -1).reduce((/** @type {any} */ o, k) => o[k], cfg))[String(path.at(-1))] = list.filter((v) => typeof v === "string");
  }
  // Every config's paths stay in the project, whoever names the config: a commit writes the project's, and one
  // ENNYN_CONFIG names may be the project's under another spelling (a case, a hard link, a parent's path). The
  // state dir lies in the git dir, where no commit writes: Ennyn trusts what it finds there (a mutation journal).
  // No other path does: a metrics log named .git/config or .git/hooks/commit-msg would be written into git's own files.
  // impact.twins: pairs of directories, each looked up below the project like a path key.
  const twins = /** @type {unknown[]} */ (/** @type {any} */ (cfg).impact.twins);
  const twinPaths = twins.flatMap((pair, i) => (Array.isArray(pair) ? pair.map((v, j) => [`impact.twins[${i}][${j}]`, v]) : []));
  // A log is appended to: no other path key may name its file (the handoff, the graph, the ceiling registry, the other log).
  for (const [key, value] of [...PATH_KEYS.map((k) => [k, valueOf(cfg, k)]), ...twinPaths]) {
    if (typeof value !== "string") continue;
    if (value.includes("\0")) problems.push(`"${key}": ${JSON.stringify(value)} holds a NUL, which names no file`);
    else if (leaves(value)) problems.push(`"${key}": ${JSON.stringify(value)} leads outside the project directory; every path a config names stays inside it`);
    else if (key === "paths.stateDir" && underGitDir(value) === null) problems.push(`"${key}": ${JSON.stringify(value)} must lie under .git/: a commit can write the work tree, and Ennyn trusts its state`);
    else if (key !== "paths.stateDir" && inGitDir(value)) problems.push(`"${key}": ${JSON.stringify(value)} lies in a git dir, where git reads and runs what it finds (its config, its hooks); only paths.stateDir may`);
    else if (LOG_KEYS.includes(key) && !ownLog(value)) problems.push(`"${key}": ${JSON.stringify(value)} must name a .jsonl file in the project: a record appended to any other file could break it`);
    else if (LOG_KEYS.includes(key)) {
      const shared = sharesLog(cfg, key);
      if (shared) problems.push(`"${key}": ${JSON.stringify(value)} names the same file as "${shared[0]}" (${JSON.stringify(shared[1])}): a record appended to it would break that file`);
    }
  }
  if (!["en", "tr"].includes(/** @type {string} */ (cfg.language))) problems.push(`"language" must be "en" or "tr"`);
  const cm = /** @type {any} */ (cfg).commitMsg;
  if (cm.language !== null && !["en", "tr"].includes(cm.language)) problems.push(`"commitMsg.language" must be "en", "tr" or null`);
  if (!["normal", "terse"].includes(cm.style)) problems.push(`"commitMsg.style" must be "normal" or "terse"`);
  const timeout = /** @type {any} */ (cfg).impact.referenceTimeout;
  if (typeof timeout === "number" && !(timeout >= 1 && timeout <= 3600)) problems.push(`"impact.referenceTimeout" must be seconds from 1 to 3600`);
  const style = /** @type {any} */ (cfg).conversation.style;
  if (!CONVERSATION_STYLES.includes(style)) problems.push(`"conversation.style" must be ${CONVERSATION_STYLES.map((s) => `"${s}"`).join(", ")}`);
  if (!AFTER_CYCLE.includes(/** @type {any} */ (cfg).context.afterCycle)) problems.push(`"context.afterCycle" must be ${AFTER_CYCLE.map((s) => `"${s}"`).join(" or ")}`);
  if (!PUSH_MODES.includes(/** @type {any} */ (cfg).push.mode)) problems.push(`"push.mode" must be ${PUSH_MODES.map((s) => `"${s}"`).join(" or ")}`);
  // A type is the word before "(scope):" or ":"; spaces, colons and brackets would never match a subject.
  const badTypes = cm.types.filter((/** @type {unknown} */ t) => typeof t !== "string" || !/^[^\s:()!]+$/.test(t));
  if (badTypes.length) problems.push(`"commitMsg.types" entries must be single words without ":", "(", ")" or "!": ${badTypes.map(String).join(", ")}`);
  const reviewers = /** @type {any} */ (cfg).review.agents;
  if (reviewers.some((/** @type {unknown} */ a) => typeof a !== "string" || a === "")) problems.push(`"review.agents" entries must be agent names`);
  /** @type {unknown[]} */ (/** @type {any} */ (cfg).review.cochange).forEach((r, i) => {
    const at = `"review.cochange"[${i}]`;
    if (r === null || typeof r !== "object" || Array.isArray(r)) return problems.push(`${at} must be an object { paths, docs, note? }`);
    const rule = /** @type {Record<string, unknown>} */ (r);
    for (const k of Object.keys(rule)) if (!["paths", "docs", "note"].includes(k)) problems.push(`${at}: unknown key "${k}"`);
    for (const k of ["paths", "docs"]) {
      const list = rule[k];
      if (!Array.isArray(list) || !list.length || list.some((g) => typeof g !== "string" || g === "")) problems.push(`${at}.${k} must be a non-empty list of globs`);
    }
    if (rule.note !== undefined && typeof rule.note !== "string") problems.push(`${at}.note must be a string`);
  });
  /** @type {unknown[]} */ (/** @type {any} */ (cfg).review.forbidden).forEach((r, i) => {
    const at = `"review.forbidden"[${i}]`;
    if (r === null || typeof r !== "object" || Array.isArray(r)) return problems.push(`${at} must be an object { text, paths, except?, note? }`);
    const rule = /** @type {Record<string, unknown>} */ (r);
    for (const k of Object.keys(rule)) if (!["text", "paths", "except", "note"].includes(k)) problems.push(`${at}: unknown key "${k}"`);
    // A literal holds no line break: a diff is read line by line, and such a text would never match.
    if (typeof rule.text !== "string" || rule.text.trim() === "" || /[\r\n]/.test(rule.text)) problems.push(`${at}.text must be a non-empty string on one line`);
    const isGlobs = (/** @type {unknown} */ list) => Array.isArray(list) && list.every((g) => typeof g === "string" && g !== "");
    if (!isGlobs(rule.paths) || !(/** @type {unknown[]} */ (rule.paths)).length) problems.push(`${at}.paths must be a non-empty list of globs`);
    if (rule.except !== undefined && !isGlobs(rule.except)) problems.push(`${at}.except must be a list of globs`);
    if (rule.note !== undefined && typeof rule.note !== "string") problems.push(`${at}.note must be a string`);
  });
  // The fast test: a command on one line, or { "none": "<why>" }. "none" as a command would run a program of that
  // name, and a misspelt key in the object would leave no reason: both are refused, so no typo reads as "no tests".
  const fast = /** @type {any} */ (cfg).commands.fastTest;
  if (typeof fast === "string") {
    if (fast.trim() === "" || /[\r\n\0]/.test(fast)) problems.push(`"commands.fastTest" must be a command on one line, or { "none": "<why the project has no tests>" }`);
    else if (/^none$/i.test(fast.trim())) problems.push(`"commands.fastTest": ${JSON.stringify(fast)} names no command; a project with no tests writes { "none": "<why>" }`);
  } else if (fast !== null) {
    for (const k of Object.keys(fast)) if (k !== "none") problems.push(`"commands.fastTest": unknown key "${k}"`);
    // A reason that shows nothing (a zero-width space, a dash) is none: it holds a letter or a digit, as the Impact line does.
    if (typeof fast.none !== "string" || !/[\p{L}\p{N}]/u.test(fast.none) || /[\r\n\0]/.test(fast.none)) problems.push(`"commands.fastTest.none" must say, on one line, why the project has no tests`);
  }
  const wholeTest = /** @type {any} */ (cfg).commands.wholeTest;
  if (typeof wholeTest === "string" && (wholeTest.trim() === "" || /[\r\n\0]/.test(wholeTest))) problems.push(`"commands.wholeTest" must be a command on one line, or null`);
  if (!/** @type {any} */ (cfg).push.codeGlobs.every((/** @type {unknown} */ g) => typeof g === "string" && g !== "")) problems.push(`"push.codeGlobs" must be a list of globs`);
  const split = /** @type {any} */ (cfg).planner.splitAbove;
  if (split !== null && !(Number.isFinite(split) && split > 0)) problems.push(`"planner.splitAbove" must be a number above 0, or null`);
  const every = /** @type {any} */ (cfg).security.everyCycles;
  if (!(Number.isInteger(every) && every >= 0 && every <= 100)) problems.push(`"security.everyCycles" must be a whole number from 0 to 100`);
  const ci = /** @type {any} */ (cfg).security.ci;
  for (const k of ["paths", "except"]) if (ci[k].some((/** @type {unknown} */ g) => typeof g !== "string" || g === "")) problems.push(`"security.ci.${k}" must be a list of globs`);
  const deps = /** @type {any} */ (cfg).security.deps;
  const inRange = (/** @type {string} */ k, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {boolean} */ whole) => {
    const n = deps[k];
    if (!(n >= lo && n <= hi) || (whole && !Number.isInteger(n))) problems.push(`"security.deps.${k}" must be ${whole ? "a whole number" : "a number"} from ${lo} to ${hi}`);
  };
  inRange("cooldownDays", 0, 365, false);
  inRange("minShare", 0, 1, false);
  inRange("minWeekly", 0, 1e9, true);
  inRange("timeout", 1, 600, false);
  for (const k of ["paths", "allowScripts", "sources"]) if (deps[k].some((/** @type {unknown} */ g) => typeof g !== "string" || g === "")) problems.push(`"security.deps.${k}" must be a list of ${k === "paths" ? "globs" : k === "sources" ? "resolved values" : "package names"}`);
  if (deps.allow.some((/** @type {unknown} */ a) => typeof a !== "string" || !/^.+@[^@]+$/.test(a))) problems.push(`"security.deps.allow" entries must be "name@version"`);
  // An origin, as a URL's own origin reads: a path or a trailing slash would never equal one.
  const isOrigin = (/** @type {unknown} */ u) => {
    try {
      return typeof u === "string" && /^https?:$/.test(new URL(u).protocol) && new URL(u).origin === u;
    } catch {
      return false;
    }
  };
  // A registry: an origin, or an origin and a path (Artifactory, Nexus), written as a URL reads it, with no
  // trailing slash, credentials, query or fragment: what a tarball's `resolved` starts with.
  const isRegistry = (/** @type {unknown} */ u) => {
    try {
      const x = new URL(String(u));
      return typeof u === "string" && /^https?:$/.test(x.protocol) && !x.username && !x.password && !x.search && !x.hash && u === `${x.origin}${x.pathname === "/" ? "" : x.pathname}` && !u.endsWith("/");
    } catch {
      return false;
    }
  };
  for (const [k, v] of Object.entries(deps.registries)) {
    if (!isRegistry(k)) problems.push(`"security.deps.registries": "${k}" must be a registry URL such as https://registry.npmjs.org or https://acme.jfrog.io/artifactory/api/npm/npm (no trailing slash)`);
    if (v !== null && !isOrigin(v)) problems.push(`"security.deps.registries.${k}" must be an origin such as https://api.npmjs.org, or null`);
  }
  if (deps.advisories !== "" && !isOrigin(deps.advisories)) problems.push(`"security.deps.advisories" must be an origin such as https://api.osv.dev, or ""`);
  if (deps.advisoryRegistries.some((/** @type {unknown} */ o) => !isRegistry(o))) problems.push(`"security.deps.advisoryRegistries" entries must be registry URLs such as https://registry.npmjs.org`);
  const secretsExcept = /** @type {any} */ (cfg).security.secrets.except;
  if (!secretsExcept.every((/** @type {unknown} */ g) => typeof g === "string" && g !== "")) problems.push(`"security.secrets.except" must be a list of globs`);
  // A glob compiles when a path is first matched; one that cannot would fail there, in the hook or in doctor.
  const c = /** @type {any} */ (cfg);
  const globLists = [
    ["review.impactRequiredGlobs", c.review.impactRequiredGlobs],
    ["review.impactIgnoreGlobs", c.review.impactIgnoreGlobs],
    ["impact.fakeGlobs", c.impact.fakeGlobs],
    ["impact.fixtureGlobs", c.impact.fixtureGlobs],
    ["security.ci.paths", c.security.ci.paths],
    ["security.ci.except", c.security.ci.except],
    ["security.deps.paths", c.security.deps.paths],
    ["security.secrets.except", c.security.secrets.except],
    ["push.codeGlobs", c.push.codeGlobs],
    ...c.review.cochange.flatMap((/** @type {any} */ r, /** @type {number} */ i) =>
      r && typeof r === "object" ? [[`review.cochange[${i}].paths`, r.paths], [`review.cochange[${i}].docs`, r.docs]] : [],
    ),
    ...c.review.forbidden.flatMap((/** @type {any} */ r, /** @type {number} */ i) =>
      r && typeof r === "object" ? [[`review.forbidden[${i}].paths`, r.paths], [`review.forbidden[${i}].except`, r.except]] : [],
    ),
  ];
  for (const [key, list] of globLists) {
    for (const g of Array.isArray(list) ? list : []) {
      if (typeof g !== "string") continue;
      try {
        globToRegExp(g);
      } catch (e) {
        problems.push(`"${key}": "${g}" is not a glob that compiles (${/** @type {Error} */ (e).message})`);
      }
    }
  }
  if (!/^[^\s:()!]+$/.test(cm.fixType)) problems.push(`"commitMsg.fixType" must be a single word without ":", "(", ")" or "!"`);
  else if (cm.types.length && !cm.types.includes(cm.fixType)) problems.push(`"commitMsg.fixType" "${cm.fixType}" must be one of commitMsg.types (${cm.types.join(", ")})`);
  if (problems.length) throw new ConfigError(problems);
  return /** @type {any} */ ({ ...cfg, projectDir: cwd, configPath: found });
}
