/**
 * Project config loader. One file per project (`.ennyn/config.json`,
 * override with ENNYN_CONFIG). Defaults are English; a project overrides
 * only what differs. Unknown keys and type mismatches are errors, reported all
 * at once: a silently ignored typo is a gate that never runs.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const DEFAULTS = Object.freeze({
  language: "en",
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
    subjectMax: 120,
    bodyMaxLines: 8,
    bodyMaxChars: 800,
    structuredLines: ["Root cause:", "Prevention added:", "Node:"],
    structuredLineMax: 300,
    skipSubjects: ["^Merge ", "^Revert "],
    allowMarker: "[commit-shape-allow:",
  },
  review: {
    maxRounds: 2,
    roundsLine: "Review-Rounds:",
    thirdRoundLine: "Third-round:",
    impactLine: "Impact:",
    impactRequiredGlobs: [],
  },
  push: { warnAtUnpushed: 20 },
  sideCopy: { roots: [], maxInjectBytes: 24000 },
  impact: {
    referenceCommand: null,
    twins: [],
    coChangeMin: 3,
    ceilingRegistry: null,
    fakeGlobs: ["**/*.test.*"],
    fixtureGlobs: ["**/__fixtures__/**"],
  },
  metrics: {
    reworkDays: 7,
    fixSubject: "^fix(\\(|:)",
    excludeRe: "(^docs/|\\.md$|^\\.)",
    testRe: "(\\.test\\.|\\.spec\\.|/test/|/__tests__/)",
  },
});

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
// Keys whose default is null but accept a value of this kind.
const NULLABLE = new Map([
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
  if (existsSync(configPath)) {
    found = configPath;
    try {
      user = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ConfigError([`cannot parse ${configPath}: ${/** @type {Error} */ (err).message}`]);
    }
  }
  const problems = [];
  let cfg = merge(/** @type {any} */ (DEFAULTS), user, "", problems);
  if (override) cfg = merge(cfg, override, "", problems);
  if (!["en", "tr"].includes(/** @type {string} */ (cfg.language))) problems.push(`"language" must be "en" or "tr"`);
  if (problems.length) throw new ConfigError(problems);
  return /** @type {any} */ ({ ...cfg, projectDir: cwd, configPath: found });
}
