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

export const DEFAULTS = Object.freeze({
  language: "en",
  // How the agent talks: normal | focused | terse (styles/). Never files or commits.
  conversation: { style: "normal" },
  // Resolved against the project directory, and kept in it (see loadConfig).
  paths: {
    handoff: "HANDOFF.md",
    changelog: "CHANGELOG.md",
    graph: ".ennyn/graph.json",
    metricsLog: ".ennyn/metrics.jsonl",
    stateDir: ".git/ennyn",
  },
  graph: {
    exports: { open: "nodes", done: "done" },
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
    },
    openGateValue: null,
    doneStatus: "done",
    valueScale: { high: 3, medium: 2, low: 1 },
    costScale: { S: 1, M: 2, L: 3, XL: 5 },
  },
  // A core pick whose cost weighs more than this is split first (core says so); null: the middle weight of
  // graph.costScale. Set it when costs are numbers such as hours.
  planner: { mechanizationSlots: 1, splitAbove: null },
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
  push: { warnAtUnpushed: 20 },
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
  impact: {
    referenceCommand: null,
    // Seconds the reference command may run before it is stopped and S1's references are unmeasured.
    referenceTimeout: 120,
    twins: [],
    coChangeMin: 3,
    ceilingRegistry: null,
    fakeGlobs: ["**/*.test.*"],
    fixtureGlobs: ["**/__fixtures__/**"],
  },
  metrics: {
    reworkDays: 7,
    fixSubject: "^fix(\\(|:)",
    // Generated output and lockfiles are rewritten by ordinary commits; counting them measures churn.
    excludeRe: "(^docs/|\\.md$|^\\.|(^|/)(generated|dist|build|vendor)/|(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$)",
    testRe: "(\\.test\\.|\\.spec\\.|/test/|/__tests__/|/__fixtures__/)",
    // Strong link (the SZZ variant the origin project validated by hand, 60-67% precision):
    // the origin owns >= minLines meaningful deleted lines AND >= minShare of the fix's
    // deleted lines, or the fix message names the origin's hash.
    minLines: 3,
    minShare: 0.1,
    // A fix touching more production files than this is a sweep, not a defect repair.
    maxFixFiles: 15,
    // Origins whose subject says they moved code: blame names them for lines they did not write.
    moveSubject: "^refactor|\\b(rename[ds]?|move[ds]?|split|extract(ed)?|codemod|prettier|reformat(ted)?)\\b",
  },
});

/** Conversation styles; every one but "normal" has rules in styles/<style>.<lang>.md. */
export const CONVERSATION_STYLES = ["normal", "focused", "terse"];

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
const OPEN_MAPS = new Set(["graph.exports", "graph.fields", "graph.valueScale", "graph.costScale", "security.deps.registries"]);
/**
 * Maps the project gives in place of the default one, with the kinds their values take: a default name left in
 * a scale (XL: 5) would outrank its own, and a registry left in the list would still be contacted.
 */
const REPLACED_MAPS = new Map([
  ["graph.valueScale", ["number"]],
  ["graph.costScale", ["number"]],
  ["security.deps.registries", ["string", "null"]],
]);
// Keys whose default is null but accept a value of this kind.
const NULLABLE = new Map([
  ["commitMsg.language", ["string"]],
  ["graph.openGateValue", ["string", "boolean", "number"]],
  ["impact.referenceCommand", ["string"]],
  ["impact.ceilingRegistry", ["string"]],
  ["planner.splitAbove", ["number"]],
]);

// Keys that name a file or directory Ennyn reads or writes, resolved against the project directory.
const PATH_KEYS = ["paths.handoff", "paths.changelog", "paths.graph", "paths.metricsLog", "paths.stateDir", "impact.ceilingRegistry"];

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
    const kinds = REPLACED_MAPS.get(path);
    if (bk === "object" && vk === "object" && kinds) {
      // Replaced, and still checked: each value is of a kind the default's values are (a weight is a number).
      for (const [sk, sv] of Object.entries(/** @type {Record<string, unknown>} */ (v))) if (!kinds.includes(kind(sv))) problems.push(`"${path}.${sk}" must be ${kinds.join(" | ")}, got ${kind(sv)}`);
      out[k] = { .../** @type {object} */ (v) };
      continue;
    }
    if (bk === "object" && vk === "object") {
      out[k] = merge(/** @type {any} */ (base[k]), /** @type {any} */ (v), path, problems);
      continue;
    }
    if (bk === "null") {
      const ok = NULLABLE.get(path) ?? [];
      if (vk !== "null" && !ok.includes(vk)) problems.push(`"${path}" must be ${ok.join(" | ") || "null"}, got ${vk}`);
      else out[k] = v;
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
  const rel = env.ENNYN_CONFIG || ".ennyn/config.json";
  const configPath = isAbsolute(rel) ? rel : join(cwd, rel);
  /** @type {Record<string, unknown>} */
  let user = {};
  let found = null;
  // A config that is there but cannot be read is no config problem to report and go on from: it throws. One
  // the user named (ENNYN_CONFIG) is read whatever it is (`<(…)`, /dev/stdin); the project's own as a regular
  // file through no link a commit may hold (core/files.mjs), so no file outside reaches a parse error.
  const own = env.ENNYN_CONFIG ? null : readRegular(cwd, configPath);
  const text = env.ENNYN_CONFIG ? readIfThere(configPath, { given: true }) : own && own.toString("utf8");
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
  // Every config's paths stay in the project, whoever names the config: a commit writes the project's, and one
  // ENNYN_CONFIG names may be the project's under another spelling (a case, a hard link, a parent's path). The
  // state dir lies in the git dir, where no commit writes: Ennyn trusts what it finds there (a mutation journal).
  // No other path does: a metrics log named .git/config or .git/hooks/commit-msg would be written into git's own files.
  // impact.twins: pairs of directories, each looked up below the project like a path key.
  const twins = /** @type {unknown[]} */ (/** @type {any} */ (cfg).impact.twins);
  const twinPaths = twins.flatMap((pair, i) => (Array.isArray(pair) ? pair.map((v, j) => [`impact.twins[${i}][${j}]`, v]) : []));
  for (const [key, value] of [...PATH_KEYS.map((k) => [k, k.split(".").reduce((o, n) => o[n], /** @type {any} */ (cfg))]), ...twinPaths]) {
    if (typeof value !== "string") continue;
    if (value.includes("\0")) problems.push(`"${key}": ${JSON.stringify(value)} holds a NUL, which names no file`);
    else if (leaves(value)) problems.push(`"${key}": ${JSON.stringify(value)} leads outside the project directory; every path a config names stays inside it`);
    else if (key === "paths.stateDir" && underGitDir(value) === null) problems.push(`"${key}": ${JSON.stringify(value)} must lie under .git/: a commit can write the work tree, and Ennyn trusts its state`);
    else if (key !== "paths.stateDir" && inGitDir(value)) problems.push(`"${key}": ${JSON.stringify(value)} lies in a git dir, where git reads and runs what it finds (its config, its hooks); only paths.stateDir may`);
  }
  if (!["en", "tr"].includes(/** @type {string} */ (cfg.language))) problems.push(`"language" must be "en" or "tr"`);
  const cm = /** @type {any} */ (cfg).commitMsg;
  if (cm.language !== null && !["en", "tr"].includes(cm.language)) problems.push(`"commitMsg.language" must be "en", "tr" or null`);
  if (!["normal", "terse"].includes(cm.style)) problems.push(`"commitMsg.style" must be "normal" or "terse"`);
  const timeout = /** @type {any} */ (cfg).impact.referenceTimeout;
  if (typeof timeout === "number" && !(timeout >= 1 && timeout <= 3600)) problems.push(`"impact.referenceTimeout" must be seconds from 1 to 3600`);
  const style = /** @type {any} */ (cfg).conversation.style;
  if (!CONVERSATION_STYLES.includes(style)) problems.push(`"conversation.style" must be ${CONVERSATION_STYLES.map((s) => `"${s}"`).join(", ")}`);
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
