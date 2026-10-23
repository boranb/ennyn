/**
 * Setup check: is git as new as the one the suite runs on, does the config
 * load, do its patterns compile, does the work graph load with unique ids and
 * known needs, can a cycle pick anything, and does the fix label separate
 * repairs from ordinary work? Run after /init and whenever the config or the
 * graph is edited by hand.
 *
 * Returns message keys, not text: the CLI renders them in the config language.
 */

import { loadConfig, ConfigError } from "../core/config.mjs";
import { loadGraph, readyNodes, readyMechanization, graphProblems, GraphError } from "../plan/mechanization.mjs";
import { MIN_HISTORY, indexMatches, recentCommits, productionSubjects } from "./scan.mjs";
import { hookStatus } from "./hook.mjs";
import { instructionBudget, readBudgets } from "./budget.mjs";
import { relative, resolve, sep } from "node:path";
import { git, repoPath, gitVersion, parseVersion, versionAtLeast, GIT_FLOOR } from "../core/git.mjs";
import { matchAny } from "../core/glob.mjs";

/**
 * @typedef {{ level: "ok" | "warn" | "fail" | "unmeasured", key: string, vars: Record<string, string | number> }} DoctorItem
 *   `unmeasured`: a check that could not be made (a file or git that failed); counted apart from warnings.
 * @typedef {{ ok: boolean, items: DoctorItem[], language: string }} DoctorResult
 */

/** An error as one line of the report. @param {unknown} e */
const oneLine = (e) => String(/** @type {Error & { stderr?: unknown }} */ (e)?.stderr || /** @type {Error} */ (e)?.message || e).trim().split("\n")[0];

/** Config keys holding a regular expression (as metrics/szz.mjs and checks/commit-shape.mjs compile them). */
const REGEX_KEYS = /** @type {const} */ (["fixSubject", "excludeRe", "testRe", "moveSubject"]);

/**
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<DoctorResult>}
 */
export async function checkSetup({ cwd, env = process.env }) {
  /** @type {DoctorItem[]} */
  const items = [];
  /** @param {DoctorItem["level"]} level @param {string} key @param {Record<string, string | number>} [vars] */
  const add = (level, key, vars = {}) => items.push({ level, key, vars });
  const done = (/** @type {string} */ language) => ({ ok: !items.some((i) => i.level === "fail"), items, language });

  // A git older than the suite runs on gives numbers nobody checked, with no error to say so.
  const installed = gitVersion({ cwd });
  const floor = /** @type {number[]} */ (parseVersion(GIT_FLOOR));
  if (!installed.version) add("warn", "doctor.gitVersionUnknown", { text: installed.text.split("\n")[0].slice(0, 80), floor: GIT_FLOOR });
  else if (!versionAtLeast(installed.version, floor)) add("fail", "doctor.gitOld", { version: installed.version.join("."), floor: GIT_FLOOR });
  else add("ok", "doctor.gitOk", { version: installed.version.join(".") });

  /** @type {any} */
  let config;
  try {
    config = loadConfig({ cwd, env });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    add("fail", "doctor.configBad", { problems: e.problems.join("; ") });
    return done("en");
  }
  if (config.configPath) add("ok", "doctor.configOk", { path: config.configPath });
  else add("warn", "doctor.configDefault", { path: env.ENNYN_CONFIG || ".ennyn/config.json" });

  // Claude Code keeps a hook's added context to 10,000 characters: a larger budget is held to that.
  if (config.sideCopy.maxInjectBytes > 10000) add("warn", "doctor.injectAboveCap", { n: config.sideCopy.maxInjectBytes });

  /** @type {Record<string, RegExp>} */
  const compiled = {};
  const patterns = [
    ...REGEX_KEYS.map((k) => [`metrics.${k}`, config.metrics[k]]),
    ...config.commitMsg.skipSubjects.map((/** @type {string} */ p, /** @type {number} */ i) => [`commitMsg.skipSubjects[${i}]`, p]),
  ];
  for (const [key, pattern] of patterns) {
    try {
      compiled[key] = new RegExp(pattern);
    } catch (e) {
      add("fail", "doctor.regexBad", { key, error: /** @type {Error} */ (e).message });
    }
  }

  let graph;
  try {
    graph = await loadGraph({ cwd, config });
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    add("fail", "doctor.graphBad", { error: e.message });
  }
  if (graph) {
    add("ok", "doctor.graphOk", { open: graph.open.length, done: graph.done.length, path: config.paths.graph });
    const f = config.graph.fields;
    // The same list the mechanization command refuses a graph by.
    for (const p of graphProblems(graph, config)) add(p.level, p.key, p.vars);
    const core = readyNodes(graph, config).filter((n) => n[f.mechanization] !== true).length;
    const mech = readyMechanization(graph, config).length;
    if (core + mech === 0) add("warn", "doctor.readyNone");
    else add("ok", "doctor.ready", { core, mech });
  }

  const cm = config.commitMsg;
  const commitLanguage = cm.language ?? config.language;
  if (cm.types.length) add("ok", "doctor.commitStyle", { language: commitLanguage, types: cm.types.join(", "), type: cm.fixType });
  else add("ok", "doctor.commitStyleFree", { language: commitLanguage });

  // Declared types, or literals kept out, with no hook to check them are a rule on paper again.
  const repo = repoPath("--git-dir", { cwd }) !== null;
  const forbidden = config.review.forbidden;
  if ((cm.types.length || forbidden.length) && repo) {
    /** @type {ReturnType<typeof hookStatus> | null} */
    let hook = null;
    try {
      hook = hookStatus(cwd);
    } catch (e) {
      // One check that cannot be made is said on its own line; the rest of the report stands.
      add("unmeasured", "doctor.hookUnmeasured", { error: oneLine(e) });
    }
    if (!hook) {
      // said above
    } else if (hook.state === "ennyn" || hook.state === "wired") add("ok", "doctor.hookOk", { path: hook.path });
    else if (hook.hooksPath) add("warn", "doctor.hookPath", { dir: hook.hooksPath });
    else if (hook.state === "other") add("warn", "doctor.hookOther", { path: hook.path });
    else add("warn", cm.types.length ? "doctor.hookMissing" : "doctor.hookMissingForbidden");
  }

  // Text loaded in every session only shrinks: growth since the last recorded budget is a warning.
  if (repo) {
    const files = git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd }).split("\0").filter(Boolean);
    /** @type {ReturnType<typeof instructionBudget> | null} */
    let b = null;
    try {
      b = instructionBudget(cwd, files);
    } catch (e) {
      add("unmeasured", "doctor.budgetUnmeasured", { error: oneLine(e) });
    }
    const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KB`;
    const log = readBudgets(resolve(cwd, config.paths.metricsLog));
    const last = log.records.at(-1);
    if (!b) {
      // said above
    } else if (last && b.always > last.always) add("warn", "doctor.budgetGrew", { now: kb(b.always), before: kb(last.always), bytes: b.always - last.always, commit: last.commit.slice(0, 10) || "—" });
    else add("ok", "doctor.budget", { always: kb(b.always), repeated: b.repeatedLines });
    if (log.skipped) add("warn", "doctor.budgetLogBroken", { n: log.skipped, path: config.paths.metricsLog });
    // A glob that names no file: in `paths` the rule never warns, in `docs` it warns on every change. A rule whose
    // documents are all the files its paths name can never warn. No file list (git failed): nothing to judge by.
    if (files.length) {
      config.review.cochange.forEach((/** @type {{ paths: string[], docs: string[] }} */ rule, /** @type {number} */ i) => {
        const unmatched = [...rule.paths, ...rule.docs].filter((g) => !files.some((f) => matchAny(f, [g])));
        if (unmatched.length) add("warn", "doctor.cochangeUnmatched", { rule: i + 1, globs: unmatched.join(", ") });
        else if (!files.some((f) => matchAny(f, rule.paths) && !matchAny(f, rule.docs))) add("warn", "doctor.cochangeSilent", { rule: i + 1 });
      });
      // What each rule covers holds today: new lines fail the commit, these stay until the file is touched.
      const configRel = config.configPath ? relative(cwd, config.configPath).split(sep).join("/") : null;
      /** @type {Map<string, { path: string, n: number }[]> | null} */
      let all = null;
      /** @type {unknown} */
      let failed = null;
      try {
        if (forbidden.length) all = indexMatches(cwd, forbidden.map((/** @type {{ text: string }} */ r) => r.text));
      } catch (e) {
        failed = e;
      }
      forbidden.forEach((/** @type {{ text: string, paths: string[], except?: string[] }} */ rule, /** @type {number} */ i) => {
        const unmatched = [...rule.paths, ...(rule.except ?? [])].filter((g) => !files.some((f) => matchAny(f, [g])));
        if (unmatched.length) add("warn", "doctor.forbiddenUnmatched", { rule: i + 1, globs: unmatched.join(", ") });
        if (!all) return add("unmeasured", "doctor.forbiddenUnmeasured", { rule: i + 1, text: rule.text, error: oneLine(failed) });
        const held = (all.get(rule.text) ?? []).filter((h) => h.path !== configRel && matchAny(h.path, rule.paths) && !matchAny(h.path, rule.except ?? []));
        const lines = held.reduce((a, h) => a + h.n, 0);
        if (lines) add("warn", "doctor.forbiddenHeld", { rule: i + 1, text: rule.text, lines, files: held.length, examples: held.slice(0, 3).map((h) => h.path).join(", ") });
        else add("ok", "doctor.forbiddenClean", { rule: i + 1, text: rule.text });
      });
    }
  }

  // Same denominator as the rework rate: recent commits touching a production path.
  const fixRe = compiled["metrics.fixSubject"];
  // With declared types, a repair is written "<fixType>: …"; a label that misses it hides every new repair.
  if (fixRe && cm.types.length && !(fixRe.test(`${cm.fixType}: x`) && fixRe.test(`${cm.fixType}(x): x`))) {
    add("warn", "doctor.fixTypeUnseen", { pattern: config.metrics.fixSubject, type: cm.fixType });
  }
  const exclude = compiled["metrics.excludeRe"];
  const test = compiled["metrics.testRe"];
  if (fixRe && exclude && test && !repo) add("warn", "doctor.fixNoRepo");
  else if (fixRe && exclude && test) {
    const subjects = productionSubjects(recentCommits(cwd), { exclude, test });
    const matches = subjects.filter((s) => fixRe.test(s)).length;
    const vars = { pattern: config.metrics.fixSubject, matches, commits: subjects.length };
    if (subjects.length < MIN_HISTORY) add("ok", "doctor.fixTooFew", vars);
    else if (matches === 0) add("warn", "doctor.fixNone", vars);
    else if (matches * 2 > subjects.length) add("warn", "doctor.fixMajority", vars);
    else add("ok", "doctor.fixOk", vars);
  }
  return done(config.language);
}
