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
import { hookStatus, idleReason } from "./hook.mjs";
import { instructionBudget, readBudgets } from "./budget.mjs";
import { relative, resolve, sep } from "node:path";
import { readRegular } from "../core/files.mjs";
import { git, repoPath, gitVersion, parseVersion, versionAtLeast, stagedVersions, GIT_FLOOR } from "../core/git.mjs";
import { ciSet, ciText } from "../checks/ci.mjs";
import { t } from "../core/i18n.mjs";
import { literalGlob, matchAny } from "../core/glob.mjs";
import { secretsOff } from "../checks/secrets.mjs";

/**
 * @typedef {{ level: "ok" | "warn" | "fail" | "unmeasured", key: string, vars: import("../core/i18n.mjs").Vars }} DoctorItem
 *   `unmeasured`: a check that could not be made (a file or git that failed); counted apart from warnings.
 *   A list in `vars` is names (paths, ids): the CLI shows each one on its own (tShown).
 * @typedef {{ ok: boolean, items: DoctorItem[], language: string }} DoctorResult
 */

/** An error as one line of the report. @param {unknown} e */
const oneLine = (e) => String(/** @type {Error & { stderr?: unknown }} */ (e)?.stderr || /** @type {Error} */ (e)?.message || e).trim().split("\n")[0];

/** Config keys holding a regular expression (as metrics/szz.mjs and checks/commit-shape.mjs compile them). */
const REGEX_KEYS = /** @type {const} */ (["fixSubject", "excludeRe", "testRe", "moveSubject"]);

/**
 * What the CI files the index holds today bring (security.ci), read together as the hook reads them: the hook
 * refuses new ones, these stay until the file is fixed. A file that cannot be read is unmeasured, never clean; a
 * file security.ci.except skips is named, so a skipped file is not taken for a clean one.
 * @param {string} cwd @param {string[]} tracked @param {any} config
 * @param {(level: DoctorItem["level"], key: string, vars?: DoctorItem["vars"]) => void} add
 */
function ciReport(cwd, tracked, config, add) {
  const rule = config.security.ci;
  const lang = config.language;
  const files = tracked.filter((f) => matchAny(f, rule.paths) && !matchAny(f, rule.except));
  const skipped = tracked.filter((f) => matchAny(f, rule.paths) && matchAny(f, rule.except));
  if (skipped.length) add("warn", "doctor.ciExcepted", { list: skipped });
  if (!files.length) return;
  let versions;
  try {
    versions = stagedVersions(cwd, files);
  } catch (e) {
    return add("unmeasured", "doctor.ciUnmeasured", { error: oneLine(e) });
  }
  /** @type {Map<string, string>} */
  const texts = new Map();
  /** @type {Map<string, string[]>} */
  const unread = new Map();
  const skip = (/** @type {string} */ reason, /** @type {string} */ path) => unread.set(reason, [...(unread.get(reason) ?? []), path]);
  for (const [path, v] of versions) {
    // A tracked name the index does not list as asked (one that is not UTF-8) was not read.
    const text = v.staged ? ciText(v.staged) : null;
    if (v.unread) skip(t(`ci.reason.${v.unread}`, {}, lang), path);
    else if (!v.staged) skip(t("ci.reason.notFound", {}, lang), path);
    else if (text === null) skip(t("ci.reason.notText", {}, lang), path);
    else texts.set(path, text);
  }
  const { findings, missing } = ciSet(texts);
  /** @type {{ path: string, value: string }[]} */
  const unpinned = [];
  /** @type {Set<string>} */
  const pwn = new Set();
  /** @type {{ path: string, job: string }[]} */
  const unpermitted = [];
  /** @type {Set<string>} */
  const writeAll = new Set();
  /** @type {Set<string>} */
  const forms = new Set();
  for (const [path, f] of findings) {
    unpinned.push(...f.uses.filter((u) => !u.pinned).map((u) => ({ path, value: u.value })));
    if (f.pwn.length) pwn.add(path);
    unpermitted.push(...f.unpermitted.map((j) => ({ path, job: j.job })));
    if (f.writeAll.length) writeAll.add(path);
    if (f.unread.length) forms.add(path);
  }

  const fileCount = (/** @type {{ path: string }[]} */ list) => new Set(list.map((x) => x.path)).size;
  if (unpinned.length) add("warn", "doctor.ciUnpinned", { n: unpinned.length, files: fileCount(unpinned), examples: unpinned.slice(0, 3).map((u) => `${u.path}: ${u.value}`) });
  if (pwn.size) add("warn", "doctor.ciPwn", { list: [...pwn] });
  if (unpermitted.length) add("warn", "doctor.ciPermissions", { n: unpermitted.length, list: [...new Set(unpermitted.map((j) => j.path))] });
  if (writeAll.size) add("warn", "doctor.ciWriteAll", { list: [...writeAll] });
  if (forms.size) add("warn", "doctor.ciForms", { list: [...forms] });
  for (const [reason, paths] of unread) add("unmeasured", "doctor.ciUnread", { list: paths, reason });
  // The caller was read; what its callee checks out was not.
  for (const m of missing) add("unmeasured", "doctor.ciCalleeMissing", { path: [m.path], callee: [m.callee || "./"] });
  if (!unpinned.length && !pwn.size && !unpermitted.length && !writeAll.size && !forms.size && !unread.size && !missing.length) add("ok", "doctor.ciClean", { files: files.length });
}

/**
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<DoctorResult>}
 */
export async function checkSetup({ cwd, env = process.env }) {
  /** @type {DoctorItem[]} */
  const items = [];
  /** @param {DoctorItem["level"]} level @param {string} key @param {DoctorItem["vars"]} [vars] */
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
  if (config.configPath) add("ok", "doctor.configOk", { path: [config.configPath] });
  else add("warn", "doctor.configDefault", { path: [env.ENNYN_CONFIG || ".ennyn/config.json"] });

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
    add("ok", "doctor.graphOk", { open: graph.open.length, done: graph.done.length, path: [config.paths.graph] });
    const f = config.graph.fields;
    // The same list the mechanization command refuses a graph by.
    for (const p of graphProblems(graph, config)) add(p.level, p.key, p.vars);
    const core = readyNodes(graph, config).filter((n) => n[f.mechanization] !== true).length;
    const mech = readyMechanization(graph, config).length;
    if (core + mech === 0) add("warn", "doctor.readyNone");
    else add("ok", "doctor.ready", { core, mech });
  }
  // The cycle reads the handoff, and writes it at its end: a link a commit holds would lead that read and that
  // write anywhere. Looked at as the graph is read; none there yet is fine.
  try {
    readRegular(cwd, resolve(cwd, config.paths.handoff));
  } catch (e) {
    add("fail", "doctor.handoffBad", { error: /** @type {Error} */ (e).message });
  }

  const cm = config.commitMsg;
  const commitLanguage = cm.language ?? config.language;
  if (cm.types.length) add("ok", "doctor.commitStyle", { language: commitLanguage, types: cm.types.join(", "), type: cm.fixType });
  else add("ok", "doctor.commitStyleFree", { language: commitLanguage });

  // The rules only the commit-msg hook checks: set, with no hook to check them, they are rules on paper again.
  const repo = repoPath("--git-dir", { cwd }) !== null;
  const forbidden = config.review.forbidden;
  const onPaper = [
    ...(cm.types.length ? ["commitMsg.types"] : []),
    ...(cm.style === "terse" ? ["commitMsg.style"] : []),
    ...(forbidden.length ? ["review.forbidden"] : []),
    ...(config.review.impactRequiredGlobs.length ? ["review.impactRequiredGlobs"] : []),
    ...(config.review.cochange.length ? ["review.cochange"] : []),
    // On by default: off only when except names every path.
    ...(secretsOff(config.security.secrets.except) ? [] : ["security.secrets"]),
  ];
  if (onPaper.length && repo) {
    /** @type {ReturnType<typeof hookStatus> | null} */
    let hook = null;
    /** @type {ReturnType<typeof idleReason>} */
    let idle = null;
    try {
      hook = hookStatus(cwd);
      if (hook.state === "ennyn" || hook.state === "wired") idle = idleReason(hook);
    } catch (e) {
      // One check that cannot be made is said on its own line; the rest of the report stands.
      hook = null;
      add("unmeasured", "doctor.hookUnmeasured", { error: oneLine(e) });
    }
    if (!hook) {
      // said above
    } else if (hook.state === "ennyn" || hook.state === "wired") {
      // A hook git skips (husky's stub not generated yet, not executable) or one whose CLI moved checks nothing.
      if (idle === "absent") add("warn", "doctor.hookAbsent", { path: [hook.path] });
      else if (idle === "mode") add("warn", "doctor.hookNotRun", { path: [hook.path] });
      else if (idle === "cli") add("warn", "doctor.hookCliGone", { path: [hook.path], cli: [String(hook.cli)] });
      else add("ok", "doctor.hookOk", { path: [hook.path] });
    } else if (hook.hooksPath) add("warn", "doctor.hookPath", { dir: [hook.hooksPath] });
    else if (hook.state === "other") add("warn", "doctor.hookOther", { path: [hook.path] });
    else add("warn", "doctor.hookMissing", { rules: onPaper });
  }

  // Text loaded in every session only shrinks: growth since the last recorded budget is a warning.
  if (repo) {
    // The file list the budget, cochange and forbidden checks read: one git cannot give (it failed, or its
    // output passed git()'s buffer) is said once, and those checks are skipped.
    /** @type {string[] | null} */
    let files = null;
    try {
      files = git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd }).split("\0").filter(Boolean);
    } catch (e) {
      add("unmeasured", "doctor.filesUnmeasured", { error: oneLine(e) });
    }
    /** @type {ReturnType<typeof instructionBudget> | null} */
    let b = null;
    try {
      if (files) b = instructionBudget(cwd, files);
    } catch (e) {
      add("unmeasured", "doctor.budgetUnmeasured", { error: oneLine(e) });
    }
    const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KB`;
    /** @type {ReturnType<typeof readBudgets> | null} */
    let log = null;
    try {
      log = readBudgets(resolve(cwd, config.paths.metricsLog), cwd);
    } catch (e) {
      // A log that is there but cannot be read is no empty log: growth since its last record is unmeasured.
      add("unmeasured", "doctor.budgetLogUnmeasured", { error: oneLine(e) });
    }
    const last = log?.records.at(-1);
    if (!b) {
      // said above
    } else if (last && b.always > last.always) add("warn", "doctor.budgetGrew", { now: kb(b.always), before: kb(last.always), bytes: b.always - last.always, commit: last.commit.slice(0, 10) || "—" });
    else add("ok", "doctor.budget", { always: kb(b.always), repeated: b.repeatedLines });
    if (log?.skipped) add("warn", "doctor.budgetLogBroken", { n: log.skipped, path: [config.paths.metricsLog] });
    if (log?.unusable) add("warn", "doctor.budgetLogUnusable", { n: log.unusable, path: [config.paths.metricsLog] });
    // A glob that names no file: in `paths` the rule never warns, in `docs` it warns on every change. A rule whose
    // documents are all the files its paths name can never warn. No file list: nothing to judge by.
    if (files?.length) {
      const tracked = files;
      config.review.cochange.forEach((/** @type {{ paths: string[], docs: string[] }} */ rule, /** @type {number} */ i) => {
        const unmatched = [...rule.paths, ...rule.docs].filter((g) => !tracked.some((f) => matchAny(f, [g])));
        if (unmatched.length) add("warn", "doctor.cochangeUnmatched", { rule: i + 1, globs: unmatched });
        else if (!tracked.some((f) => matchAny(f, rule.paths) && !matchAny(f, rule.docs))) add("warn", "doctor.cochangeSilent", { rule: i + 1 });
      });
      // An impact glob that names no file never asks for the line. One written from a directory holding glob
      // syntax (init-scan proposed `app/[locale]/auth/**` so before it escaped it) reads as a class: when the
      // glob read as a path names files, that literal glob is named with it.
      for (const g of config.review.impactRequiredGlobs) {
        if (tracked.some((f) => matchAny(f, [g]))) continue;
        const below = g.endsWith("/**");
        const meant = below ? `${literalGlob(g.slice(0, -3))}/**` : literalGlob(g);
        if (meant !== g && tracked.some((f) => matchAny(f, [meant]))) add("warn", "doctor.impactLiteral", { glob: [g], meant: [meant] });
        else add("warn", "doctor.impactUnmatched", { glob: [g] });
      }
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
        const unmatched = [...rule.paths, ...(rule.except ?? [])].filter((g) => !tracked.some((f) => matchAny(f, [g])));
        if (unmatched.length) add("warn", "doctor.forbiddenUnmatched", { rule: i + 1, globs: unmatched });
        if (!all) return add("unmeasured", "doctor.forbiddenUnmeasured", { rule: i + 1, text: rule.text, error: oneLine(failed) });
        const held = (all.get(rule.text) ?? []).filter((h) => h.path !== configRel && matchAny(h.path, rule.paths) && !matchAny(h.path, rule.except ?? []));
        const lines = held.reduce((a, h) => a + h.n, 0);
        if (lines) add("warn", "doctor.forbiddenHeld", { rule: i + 1, text: rule.text, lines, files: held.length, examples: held.slice(0, 3).map((h) => h.path) });
        else add("ok", "doctor.forbiddenClean", { rule: i + 1, text: rule.text });
      });
      ciReport(cwd, tracked, config, add);
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
  if (fixRe && exclude && test && !repo) add("unmeasured", "doctor.fixNoRepo");
  else if (fixRe && exclude && test) {
    /** @type {string[]} */
    let subjects;
    try {
      subjects = productionSubjects(recentCommits(cwd), { exclude, test });
    } catch (e) {
      add("unmeasured", "doctor.fixUnmeasured", { error: oneLine(e) });
      return done(config.language);
    }
    const matches = subjects.filter((s) => fixRe.test(s)).length;
    const vars = { pattern: config.metrics.fixSubject, matches, commits: subjects.length };
    // Too few commits to judge is no verdict.
    if (subjects.length < MIN_HISTORY) add("unmeasured", "doctor.fixTooFew", vars);
    else if (matches === 0) add("warn", "doctor.fixNone", vars);
    else if (matches * 2 > subjects.length) add("warn", "doctor.fixMajority", vars);
    else add("ok", "doctor.fixOk", vars);
  }
  return done(config.language);
}
