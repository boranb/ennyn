/**
 * Project config loader. One file per project (`.ennyn/config.json`,
 * override with ENNYN_CONFIG). Defaults are English; a project overrides
 * only what differs. Unknown keys and type mismatches are errors, reported all
 * at once: a silently ignored typo is a gate that never runs.
 */

import { readIfThere } from "./files.mjs";
import { join, isAbsolute } from "node:path";
import { globToRegExp } from "./glob.mjs";

export const DEFAULTS = Object.freeze({
  language: "en",
  // How the agent talks: normal | focused | terse (styles/). Never files or commits.
  conversation: { style: "normal" },
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
    },
    openGateValue: null,
    doneStatus: "done",
    valueScale: { high: 3, medium: 2, low: 1 },
    costScale: { S: 1, M: 2, L: 3, XL: 5 },
  },
  planner: { mechanizationSlots: 1 },
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
  sideCopy: { roots: [], maxInjectBytes: 24000 },
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
const OPEN_MAPS = new Set(["graph.exports", "graph.fields", "graph.valueScale", "graph.costScale"]);
/** A scale the project gives replaces the default one: a default name left in it (XL: 5) would outrank its own. */
const REPLACED_MAPS = new Set(["graph.valueScale", "graph.costScale"]);
// Keys whose default is null but accept a value of this kind.
const NULLABLE = new Map([
  ["commitMsg.language", ["string"]],
  ["graph.openGateValue", ["string", "boolean", "number"]],
  ["impact.referenceCommand", ["string"]],
  ["impact.ceilingRegistry", ["string"]],
]);

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
    if (bk === "object" && vk === "object" && REPLACED_MAPS.has(path)) {
      // Replaced, and still checked: each weight is a number, as each default one is.
      for (const [sk, sv] of Object.entries(/** @type {Record<string, unknown>} */ (v))) if (kind(sv) !== "number") problems.push(`"${path}.${sk}" must be number, got ${kind(sv)}`);
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
  // A config that is there but cannot be read is no config problem to report and go on from: it throws.
  const text = readIfThere(configPath);
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
  // A glob compiles when a path is first matched; one that cannot would fail there, in the hook or in doctor.
  const c = /** @type {any} */ (cfg);
  const globLists = [
    ["review.impactRequiredGlobs", c.review.impactRequiredGlobs],
    ["review.impactIgnoreGlobs", c.review.impactIgnoreGlobs],
    ["impact.fakeGlobs", c.impact.fakeGlobs],
    ["impact.fixtureGlobs", c.impact.fixtureGlobs],
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
