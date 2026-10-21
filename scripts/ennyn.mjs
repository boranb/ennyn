#!/usr/bin/env node
/**
 * ennyn CLI.
 *
 * Exit codes: 0 ok · 1 check failed, config error or runtime error · 2 usage error.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, ConfigError } from "../core/config.mjs";
import { git, stagedPaths, unpushedCount } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { checkCommitShape, storedMessage, hookCommitMode } from "../checks/commit-shape.mjs";
import { buildImpactTable, formatImpactTable } from "../impact/table.mjs";
import { reworkRate } from "../metrics/szz.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { gateLogPath, readAttempts, recordAttempt, summarizeAttempts, KINDS } from "../metrics/gate-log.mjs";
import { loadGraph, pickMechanization, scoreNode, GraphError } from "../plan/mechanization.mjs";
import { scanProject, MIN_HISTORY } from "../setup/scan.mjs";
import { checkSetup } from "../setup/doctor.mjs";
import { installHook } from "../setup/hook.mjs";
import { instructionBudget, readBudgets, recordBudget, previousBudget } from "../setup/budget.mjs";
import { journalPath, MAX_TIMEOUT_MS, MutationError, parseMutants, restoreJournal, runMutants, summarizeMutants } from "../metrics/mutation.mjs";

export const USAGE = `Usage: ennyn <command> [options]

Commands:
  init-scan [--json]                                survey the repository for /init: fix label, churn, tests, risky paths, work sources
  doctor                                            check config, work graph and fix label; exit 1 on a problem
  install-hook                                      run commit-check as this repository's commit-msg hook (machine-local)
  budget [--json] [--record]                        instruction text loaded every session / by path, rule lines repeated across files; --record appends to paths.metricsLog
  commit-check [--hook] <message-file>              check commit message shape (commit-msg hook; --hook: a config that does not load warns instead of failing)
  impact --symbol <s> [--files a,b]                 five-row impact table (markdown)
  rework [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days N] [--json]
                                                    SZZ-style rework rate
  mechanization [--json]                            best ready mechanization node
  bypass [--from <rev>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                                    commits that used the commit-shape bypass marker, with their reasons
  mutate <list.json> --command <cmd> [--check <cmd>] [--timeout <s>] [--json]
                                                    run hand-picked mutants one at a time against the tests; one that does not parse is never killed
  mutate --restore [--force]                        put back a file that a mutate run killed outright left mutated
  push-check                                        warn when too many commits are unpushed
  gate-record --start <epoch-s> --exit <code> [--kind full|message] [--commit <rev>] [--step <name>] [--runner <name>]
                                                    record one commit-gate attempt (called by the commit wrapper)
  gate-stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                                    commit-gate wait, failures and time spent in failed attempts

Options:
  -h, --help                                        show this help

Config: .ennyn/config.json in the repository root (override with ENNYN_CONFIG).`;

class UsageError extends Error {}

/**
 * @param {string[]} args
 * @param {{ options?: string[], flags?: string[], positional?: number }} spec
 * @returns {{ positional: string[], opts: Record<string, string | true>, help: boolean }}
 */
function parseArgs(args, { options = [], flags = [], positional = 0 }) {
  /** @type {Record<string, string | true>} */
  const opts = {};
  const pos = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (flags.includes(name)) {
        if (eq !== -1) throw new UsageError(`--${name} takes no value`);
        opts[name] = true;
      } else if (options.includes(name)) {
        const value = eq === -1 ? args[++i] : a.slice(eq + 1);
        if (value === undefined || (eq === -1 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
        opts[name] = value;
      } else throw new UsageError(`unknown option --${name}`);
      continue;
    }
    pos.push(a);
  }
  if (!help && pos.length > positional) throw new UsageError(`unexpected argument "${pos[positional]}"`);
  return { positional: pos, opts, help };
}

/** Repository root when inside one, else the working directory. */
function projectDir() {
  return git(["rev-parse", "--show-toplevel"], { cwd: process.cwd(), allowFail: true }) || process.cwd();
}

/** @param {string} cwd */
const config = (cwd) => loadConfig({ cwd });

/**
 * For an amend! / squash! message, the commit it folds into: the newest of the last 500 whose subject is
 * the one named, every leading fold prefix taken off as autosquash does ("squash! squash! x" folds into
 * x), with its message and paths. null when there is none (or the message is no fold).
 * @param {string} cwd @param {string} message @param {"strip" | "whitespace" | "verbatim" | "scissors"} cleanup @param {string} comment @param {boolean} cut
 */
function foldTarget(cwd, message, cleanup, comment, cut) {
  const fold = /^(?:amend|squash)! (.*)$/.exec(storedMessage(message, cleanup, comment, cut).split("\n")[0] ?? "");
  if (!fold) return null;
  const log = git(["log", "-n500", "--format=%H%x00%s"], { cwd, allowFail: true });
  const subject = fold[1].replace(/^(?:(?:amend|squash|fixup)! )+/, "");
  const hit = log.split("\n").find((l) => l.slice(l.indexOf("\0") + 1) === subject);
  if (!hit) return null;
  const hash = hit.slice(0, hit.indexOf("\0"));
  return {
    message: git(["log", "-1", "--format=%B", hash], { cwd }),
    paths: git(["show", "-z", "--name-only", "--no-renames", "--format=", hash], { cwd }).split("\0").filter(Boolean),
  };
}

/** @param {string} s */
const out = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
/** @param {string} s */
const err = (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");

/**
 * Up to 60 characters of `s` around the first match of `re`, so a match deep in a long subject stays visible.
 * @param {string} s @param {RegExp | null} re
 */
function excerpt(s, re) {
  if (s.length <= 60) return s;
  const at = re ? Math.max(0, (re.exec(s)?.index ?? 0) - 20) : 0;
  const start = Math.min(at, s.length - 57);
  return (start > 0 ? "…" : "") + s.slice(start, start + 57) + (start + 57 < s.length ? "…" : "");
}

/** @param {string | true | undefined} v @param {string} name */
function dateOpt(v, name) {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`--${name} must be YYYY-MM-DD`);
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new UsageError(`--${name} is not a calendar date: ${v}`);
  return v;
}

/** @param {string | true | undefined} v @param {string} name */
function intOpt(v, name) {
  if (v === undefined) throw new UsageError(`--${name} is required`);
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

/** @param {string | true | undefined} v */
const strOpt = (v) => (typeof v === "string" && v !== "" ? v : null);

/** @param {number | null} sec */
const minutes = (sec) => (sec === null ? "—" : (sec / 60).toFixed(1));

/** @param {number} b */
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
/** @param {number} b */
const signedKb = (b) => `${b > 0 ? "+" : b < 0 ? "−" : "±"}${(Math.abs(b) / 1024).toFixed(1)} KB`;

/** @param {number | null} share @param {string} lang */
const percent = (share, lang) => (share === null ? "—" : lang === "tr" ? `%${Math.round(share * 100)}` : `${Math.round(share * 100)}%`);

/** @type {Record<string, (args: string[]) => Promise<number> | number>} */
const COMMANDS = {
  "init-scan"(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const res = scanProject({ cwd });
    if (opts.json) return (out(JSON.stringify(res, null, 2)), 0);
    // A broken config is part of the report, not a reason to stop.
    let lang = "en";
    try {
      lang = config(cwd).language;
    } catch {
      // English until the config loads.
    }
    const say = (/** @type {string} */ key, /** @type {Record<string, string | number>} */ vars = {}) => out(t(key, vars, lang));
    if (!res.config.path) say("scan.configNone");
    else if (res.config.problems.length) say("scan.configProblems", { path: res.config.path, problems: res.config.problems.join("; ") });
    else say("scan.configOk", { path: res.config.path });
    say(res.graph.exists ? "scan.graphOk" : "scan.graphNone", { path: res.graph.path });
    if (!res.repository) say("scan.noRepo");
    else {
      const fx = res.fixSubject;
      if (fx.commits) say("scan.conventional", { commits: fx.commits, pct: percent(fx.conventionalShare, lang) });
      const cs = res.commitStyle;
      if (cs.language.guess) say("scan.commitLanguage", { guess: cs.language.guess, tr: cs.language.tr, en: cs.language.en });
      if (cs.types.length) say("scan.subjectTypes", { list: cs.types.map((x) => `${x.type} ${x.n}`).join(" · ") });
      // A weak result proposes nothing; its examples show the mentions.
      const pattern = fx.proposal ?? fx.candidates.find((c) => c.id === fx.pick)?.pattern ?? null;
      const vars = { commits: fx.commits, min: MIN_HISTORY, pattern: pattern ?? "", matches: fx.matches, pct: percent(fx.share, lang) };
      const examples = fx.examples.map((e) => `"${excerpt(e, pattern ? new RegExp(pattern) : null)}"`).join(", ");
      say({ ok: "scan.fixOk", majority: "scan.fixMajority", weak: "scan.fixWeak", none: "scan.fixNone", tooFew: "scan.fixTooFew" }[fx.reason], { ...vars, examples });
      if (res.churn.paths.length) {
        say("scan.churn", { min: res.churn.min ?? 0, commits: res.churn.commits });
        for (const p of res.churn.paths) say("scan.churnItem", { path: p.path, n: p.commits, marker: p.generatedMarker ? t("scan.generatedMarker", {}, lang) : "" });
      }
    }
    say("scan.tests", { n: res.tests.matched });
    if (res.tests.proposal) say("scan.testsProposal", { examples: res.tests.alternatives.flatMap((a) => a.examples).slice(0, 3).join(", "), pattern: res.tests.proposal });
    if (res.risky.length) say("scan.risky", { list: res.risky.map((r) => r.glob).join(", ") });
    if (res.roadmap.length) say("scan.roadmap", { list: res.roadmap.map((r) => (r.open + r.done ? t("scan.roadmapItem", { path: r.path, open: r.open, done: r.done }, lang) : t("scan.roadmapItemLines", { path: r.path, lines: r.lines }, lang))).join(" · ") });
    if (res.github) say("scan.github", { repo: res.github });
    if (res.commands.length) say("scan.commands", { list: res.commands.join(" · ") });
    else say("scan.commandsNone");
    if (res.mutation) say("scan.mutation", { command: res.mutation });
    else say("scan.mutationNone");
    if (res.pathScopedRules) say("scan.rules", { n: res.pathScopedRules });
    const ag = res.agentSetup;
    const kb = (/** @type {number} */ b) => `${(b / 1024).toFixed(1)} KB`;
    if (ag.instructions.length) {
      const biggest = ag.instructions.filter((i) => i.loads === "always").sort((a, b) => b.bytes - a.bytes).slice(0, 5);
      say("scan.instructions", {
        always: kb(ag.size.always),
        onDemand: kb(ag.size.onDemand),
        other: kb(ag.size.other),
        list: biggest.map((i) => `${i.path} ${kb(i.bytes)}`).join(" · ") || "—",
      });
      // Every-session files first: those are the rules the cycle would contradict each time.
      const order = { always: 0, "on-demand": 1, other: 2 };
      // At most two lines per file, so a rule file is not hidden behind a long CLAUDE.md; --json has them all.
      const files = [...ag.instructions].sort((a, b) => order[a.loads] - order[b.loads]);
      const all = files.reduce((n, i) => n + i.commitLines.length, 0);
      const shown = files.flatMap((i) => i.commitLines.slice(0, 2).map((line) => ({ path: i.path, line }))).slice(0, 8);
      for (const r of shown) say("scan.commitRule", r);
      if (all > shown.length) say("scan.commitRuleMore", { n: all - shown.length });
    }
    if (ag.skills.length || ag.agents.length || ag.commands.length) say("scan.agentParts", { skills: ag.skills.length, agents: ag.agents.length, commands: ag.commands.length });
    if (ag.overlaps.cycle.length || ag.overlaps.reviewers.length) {
      say("scan.overlaps", { cycle: ag.overlaps.cycle.join(", ") || "—", reviewers: ag.overlaps.reviewers.join(", ") || "—" });
    }
    if (ag.hooks.length) say("scan.hooks", { list: ag.hooks.join(", ") });
    if (ag.mcpServers.length) say("scan.mcp", { list: ag.mcpServers.join(", ") });
    if (ag.unreadable.length) say("scan.unreadable", { list: ag.unreadable.join(", ") });
    return 0;
  },

  "install-hook"(args) {
    const { help } = parseArgs(args, {});
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const res = installHook({ cwd, cliPath: fileURLToPath(import.meta.url) });
    const key = res.result === "hooksPath" ? `hook.hooksPath.${res.hooksKind}` : `hook.${res.result}`;
    out(t(key, { path: res.path, dir: res.hooksPath ?? "", line: res.line }, cfg.language));
    return res.result === "other" || res.result === "hooksPath" ? 1 : 0;
  },

  budget(args) {
    const { opts, help } = parseArgs(args, { flags: ["json", "record"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const files = git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd, allowFail: true }).split("\0").filter(Boolean);
    const b = instructionBudget(cwd, files);
    const head = git(["rev-parse", "HEAD"], { cwd, allowFail: true });
    const log = readBudgets(resolve(cwd, cfg.paths.metricsLog));
    // Measured against the newest record made at another commit: recording twice in a cycle hides nothing.
    const previous = previousBudget(log.records, head);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const recorded = opts.record ? recordBudget(cwd, cfg.paths.metricsLog, b, { date: today, commit: head }) : null;
    if (opts.json) return (out(JSON.stringify({ ...b, previous, skipped: log.skipped, recorded: recorded ? { ...recorded.entry, replaced: recorded.replaced } : null }, null, 2)), 0);
    const lang = cfg.language;
    const delta = previous
      ? t("budget.delta", { d: signedKb(b.always - previous.always), bytes: b.always - previous.always, commit: previous.commit.slice(0, 10) || "—" }, lang)
      : t(recorded ? "budget.first" : "budget.none", {}, lang);
    out(t("budget.summary", { always: kb(b.always), listings: kb(b.listings), onDemand: kb(b.onDemand), files: b.files, delta }, lang));
    if (b.repeatedLines) {
      out(t("budget.repeated", { n: b.repeatedLines, every: b.repeatedEverySession }, lang));
      for (const r of b.repeated.slice(0, 5)) out(t("budget.repeatedItem", { line: r.line, files: r.files.join(", ") }, lang));
    }
    if (b.untracked.length) out(t("budget.untracked", { list: b.untracked.join(", ") }, lang));
    if (log.skipped) out(t("budget.skipped", { n: log.skipped, path: resolve(cwd, cfg.paths.metricsLog) }, lang));
    if (recorded) out(t(recorded.replaced ? "budget.replaced" : "budget.recorded", { path: recorded.path, commit: recorded.entry.commit.slice(0, 10) }, lang));
    return 0;
  },

  async doctor(args) {
    const { help } = parseArgs(args, {});
    if (help) return (out(USAGE), 0);
    const res = await checkSetup({ cwd: projectDir() });
    const mark = { ok: "✓", warn: "!", fail: "✗" };
    for (const i of res.items) out(`${mark[i.level]} ${t(i.key, i.vars, res.language)}`);
    const count = (/** @type {string} */ level) => res.items.filter((i) => i.level === level).length;
    out(t("doctor.summary", { fail: count("fail"), warn: count("warn") }, res.language));
    return res.ok ? 0 : 1;
  },

  "commit-check"(args) {
    const { positional, opts, help } = parseArgs(args, { positional: 1, flags: ["hook"] });
    if (help) return (out(USAGE), 0);
    if (!positional[0]) throw new UsageError("commit-check needs a message file");
    const cwd = projectDir();
    let cfg;
    try {
      cfg = config(cwd);
    } catch (e) {
      // From the commit-msg hook a broken config must not lock every commit, the one that fixes it included.
      if (!(e instanceof ConfigError) || !opts.hook) throw e;
      err(t("cli.hookConfigBroken", { error: e.message }, "en"));
      return 0;
    }
    let message;
    try {
      message = readFileSync(positional[0], "utf8");
    } catch (e) {
      err(t("cli.cannotRead", { path: positional[0], error: /** @type {Error} */ (e).message }, cfg.language));
      return 1;
    }
    /** @type {string[]} */
    let staged = [];
    try {
      staged = stagedPaths(cwd, { env: process.env });
    } catch (e) {
      err(t("cli.stagedUnmeasured", { error: String(/** @type {Error} */ (e).message).split("\n")[0] }, cfg.language));
    }
    let res;
    try {
      const { cleanup, comment, cut } = hookCommitMode({ cwd, message, env: process.env });
      res = checkCommitShape(message, { config: cfg, stagedPaths: staged, cleanup, cut, comment, foldTarget: foldTarget(cwd, message, cleanup, comment, cut) });
    } catch (e) {
      // Any other tool failure (a pattern in the config that does not compile) is no reason to lock commits either.
      if (!opts.hook) throw e;
      err(t("cli.hookConfigBroken", { error: /** @type {Error} */ (e).message }, "en"));
      return 0;
    }
    for (const e of res.errors) err(e);
    for (const w of res.warnings ?? []) err(w);
    return res.ok ? 0 : 1;
  },

  impact(args) {
    const { opts, help } = parseArgs(args, { options: ["symbol", "files"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const files = typeof opts.files === "string" ? opts.files.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const symbol = typeof opts.symbol === "string" ? opts.symbol : null;
    out(formatImpactTable(buildImpactTable({ cwd, config: cfg, symbol, files }), cfg));
    return 0;
  },

  rework(args) {
    const { opts, help } = parseArgs(args, { options: ["since", "until", "days"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const since = dateOpt(opts.since, "since");
    const until = dateOpt(opts.until, "until");
    let days;
    if (opts.days !== undefined) {
      if (typeof opts.days !== "string" || !/^\d+$/.test(opts.days)) throw new UsageError("--days must be a whole number");
      days = Number(opts.days);
    }
    const cwd = projectDir();
    const cfg = config(cwd);
    const windowDays = days ?? cfg.metrics.reworkDays;
    const res = reworkRate({ cwd, since, until, days: windowDays, config: cfg });
    if (opts.json) return (out(JSON.stringify({ ...res, days: windowDays }, null, 2)), 0);
    const lang = cfg.language;
    if (res.rate === null) out(t("rework.none", {}, lang));
    else {
      const pct = `${(res.rate * 100).toFixed(1)}%`;
      out(t("rework.summary", { reworked: res.reworked, commits: res.commits, pct, days: windowDays }, lang));
      if (res.fixCommits * 2 > res.commits) out(t("rework.fixMajority", { fixes: res.fixCommits, commits: res.commits }, lang));
    }
    if (res.censored) out(t("rework.censored", { n: res.censored, days: windowDays }, lang));
    for (const p of res.pairs) {
      out(t("rework.pair", { origin: p.origin.slice(0, 10), fix: p.fix.slice(0, 10), files: p.files.join(", "), lines: p.lines, days: p.days }, lang));
    }
    return 0;
  },

  bypass(args) {
    const { opts, help } = parseArgs(args, { options: ["from", "since", "until"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const since = dateOpt(opts.since, "since");
    const until = dateOpt(opts.until, "until");
    // An empty --from (a lost cycle start) must not widen the count to the whole history.
    if (opts.from !== undefined && strOpt(opts.from) === null) throw new UsageError("--from needs a revision");
    const from = strOpt(opts.from) ?? undefined;
    const cwd = projectDir();
    const cfg = config(cwd);
    const res = bypassUses({ cwd, config: cfg, since, until, from });
    if (opts.json) return (out(JSON.stringify(res, null, 2)), 0);
    const lang = cfg.language;
    if (!res.commits) return (out(t("bypass.noCommits", {}, lang)), 0);
    out(t(res.uses.length ? "bypass.summary" : "bypass.none", { n: res.uses.length, commits: res.commits }, lang));
    for (const u of res.uses) {
      // The local day, as --since / --until read it.
      const d = new Date(u.time * 1000);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out(t("bypass.item", { hash: u.hash.slice(0, 10), date, subject: u.subject, reason: u.reason || t("bypass.noReason", {}, lang) }, lang));
    }
    return 0;
  },

  async mechanization(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const graph = await loadGraph({ cwd, config: cfg });
    const node = pickMechanization(graph, cfg);
    const score = node ? scoreNode(node, cfg) : null;
    if (opts.json) return (out(JSON.stringify(node ? { node, score } : null, null, 2)), 0);
    if (!node) out(t("mechanization.none", {}, cfg.language));
    else out(t("mechanization.pick", { id: String(node[cfg.graph.fields.id]), score: Number(score).toFixed(2) }, cfg.language));
    return 0;
  },

  async mutate(args) {
    const { positional, opts, help } = parseArgs(args, { positional: 1, options: ["command", "check", "timeout"], flags: ["json", "restore", "force"] });
    if (help) return (out(USAGE), 0);
    if (opts.restore) {
      if (positional[0] || opts.command || opts.check || opts.timeout || opts.json) throw new UsageError("mutate --restore takes no list and no option but --force");
      const cwd = projectDir();
      const cfg = config(cwd);
      const res = restoreJournal(cwd, journalPath(cwd, cfg.paths.stateDir), { force: Boolean(opts.force) });
      out(res.restored ? t("mutate.restored", { file: res.restored }, cfg.language) : t(res.found ? "mutate.restoreClean" : "mutate.restoreNone", {}, cfg.language));
      return 0;
    }
    if (opts.force) throw new UsageError("--force goes with --restore");
    if (!positional[0]) throw new UsageError("mutate needs a mutant list (JSON)");
    const command = strOpt(opts.command);
    if (!command) throw new UsageError("mutate needs --command <test command>");
    const timeout = opts.timeout === undefined ? null : intOpt(opts.timeout, "timeout");
    if (timeout !== null && (timeout === 0 || timeout * 1000 > MAX_TIMEOUT_MS)) throw new UsageError(`--timeout must be from 1 to ${Math.floor(MAX_TIMEOUT_MS / 1000)} seconds`);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    let text;
    try {
      text = readFileSync(positional[0], "utf8");
    } catch (e) {
      err(t("cli.cannotRead", { path: positional[0], error: /** @type {Error} */ (e).message }, lang));
      return 1;
    }
    const { mutants, problems } = parseMutants(text);
    if (problems.length) return (err(t("mutate.listProblems", { path: positional[0], problems: problems.join("\n- ") }, lang)), 1);
    const say = (/** @type {string} */ key, /** @type {Record<string, string | number>} */ vars = {}) => (opts.json ? undefined : out(t(key, vars, lang)));
    const res = await runMutants({
      cwd,
      mutants,
      command,
      check: strOpt(opts.check),
      journal: journalPath(cwd, cfg.paths.stateDir),
      timeoutMs: timeout === null ? null : timeout * 1000,
      onBaseline: (b, limit) => say("mutate.baseline", { s: (b.ms / 1000).toFixed(1), timeout: Math.ceil(limit / 1000), twice: Math.ceil((2 * limit) / 1000) }),
      onResult: (r) =>
        say("mutate.item", {
          id: r.id,
          outcome: t(`mutate.outcome.${r.outcome}`, {}, lang),
          file: r.file,
          reason: r.reason ? ` — ${t(r.reason.key, r.reason.vars, lang)}` : "",
        }),
    });
    if (res.restored) err(t("mutate.restored", { file: res.restored }, lang));
    if (res.baseline.exit !== 0) {
      const how = res.baseline.error ?? (res.baseline.exit === null ? res.baseline.signal : `exit ${res.baseline.exit}`);
      err(t("mutate.baselineFailed", { how: String(how), tail: res.baseline.tail.trimEnd().split("\n").slice(-15).join("\n") }, lang));
      return 1;
    }
    const sum = summarizeMutants(res.results);
    if (opts.json) return (out(JSON.stringify({ ...res, summary: sum }, null, 2)), 0);
    say("mutate.summary", sum);
    const survived = res.results.filter((r) => r.outcome === "survived").map((r) => r.id);
    if (survived.length) say("mutate.survivors", { list: survived.join(", ") });
    if (sum.unchecked || sum.uncheckedSurvived) say("mutate.uncheckedHint", { n: sum.unchecked + sum.uncheckedSurvived });
    return 0;
  },

  "push-check"(args) {
    const { help } = parseArgs(args, {});
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const n = unpushedCount(cwd);
    const max = cfg.push.warnAtUnpushed;
    if (n === null) out(t("push.unmeasured", {}, cfg.language));
    else if (n > max) out(t("push.warn", { n, max }, cfg.language));
    else out(t("push.ok", { n, max }, cfg.language));
    return 0;
  },

  "gate-record"(args) {
    const { opts, help } = parseArgs(args, { options: ["start", "exit", "kind", "commit", "step", "runner"] });
    if (help) return (out(USAGE), 0);
    const start = intOpt(opts.start, "start");
    const exit = intOpt(opts.exit, "exit");
    const kind = strOpt(opts.kind) ?? "full";
    if (!(/** @type {readonly string[]} */ (KINDS)).includes(kind)) throw new UsageError(`--kind must be ${KINDS.join(" | ")}`);
    const cwd = projectDir();
    const cfg = config(cwd);
    let res;
    try {
      res = recordAttempt({ cwd, config: cfg, start, exit, kind, commit: strOpt(opts.commit), step: strOpt(opts.step), runner: strOpt(opts.runner) });
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      err(t("gate.recordFailed", { error: e.message }, cfg.language));
      return 1;
    }
    out(t("gate.recorded", { result: t(`gate.result.${res.entry.result}`, {}, cfg.language), path: res.path }, cfg.language));
    return 0;
  },

  "gate-stats"(args) {
    const { opts, help } = parseArgs(args, { options: ["since", "until"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const since = dateOpt(opts.since, "since");
    const until = dateOpt(opts.until, "until");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const path = gateLogPath(cwd, cfg.paths.stateDir);
    const log = readAttempts(path);
    const sum = summarizeAttempts(log.attempts, { since, until });
    if (opts.json) return (out(JSON.stringify({ path, exists: log.exists, skipped: log.skipped, ...sum }, null, 2)), 0);
    if (!log.exists) return (out(t("gate.none", { path }, lang)), 0);
    if (log.skipped) out(t("gate.skipped", { n: log.skipped, path }, lang));
    if (!sum.attempts) return (out(t("gate.emptyWindow", {}, lang)), 0);
    const pct = sum.failRate === null ? "—" : `${(sum.failRate * 100).toFixed(0)}%`;
    out(t("gate.summary", { full: sum.full, passed: sum.passed, failed: sum.failed, pct, message: sum.message }, lang));
    if (sum.pass.n) out(t("gate.passTime", { median: minutes(sum.pass.median), p90: minutes(sum.pass.p90) }, lang));
    if (sum.fail.n) out(t("gate.failTime", { median: minutes(sum.fail.median), p90: minutes(sum.fail.p90), wasted: minutes(sum.wastedSeconds) }, lang));
    if (sum.steps.length) out(t("gate.steps", { list: sum.steps.map((s) => `${s.step} ${s.n}`).join(" · ") }, lang));
    if (sum.unmeasuredSteps) out(t("gate.stepsUnmeasured", { n: sum.unmeasuredSteps }, lang));
    return 0;
  },
};

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    out(USAGE);
    return 0;
  }
  if (!cmd || !Object.hasOwn(COMMANDS, cmd)) {
    err(cmd ? `unknown command "${cmd}"\n\n${USAGE}` : USAGE);
    return 2;
  }
  try {
    return await COMMANDS[cmd](rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ConfigError || e instanceof GraphError || e instanceof MutationError) {
      err(e.message);
      return 1;
    }
    const error = /** @type {Error & { stderr?: unknown }} */ (e);
    err(`ennyn ${cmd}: ${error.stderr ? String(error.stderr).trim() : error.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // A closed pipe (`ennyn rework | head`) ends the output, not the process with a stack trace.
  process.stdout.on("error", (e) => {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPIPE") process.exit(0);
    throw e;
  });
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
