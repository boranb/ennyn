#!/usr/bin/env node
/**
 * ennyn CLI.
 *
 * Exit codes: 0 ok · 1 check failed, config error or runtime error (a git call that failed included) ·
 * 2 usage error · 141 stdout closed before the output was written, as for a process ended by SIGPIPE.
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import { loadConfig, ConfigError } from "../core/config.mjs";
import { READ_BUDGET, git, headBlob, headCommit, hookIndexFile, indexKinds, indexNames, mergeHeads, repoPath, stagedAddedLines, stagedBlobs, stagedChanges, stagedNames, stagedVersions, streamStagedBlobs, streamStagedDiff, unpushedCount } from "../core/git.mjs";
import { ends, jsonShown, shown, t, tShown, unshownEscaped } from "../core/i18n.mjs";
import { globToRegExp, matchAny } from "../core/glob.mjs";
import { checkCommitShape, nameShown, secretErrors, storedMessage, hookCommitMode } from "../checks/commit-shape.mjs";
import { ciCallees, ciMessages } from "../checks/ci.mjs";
import { advisoriesOf, depsMessages, dirOf, judgeEntry, judgeLock, lockEntries, lockPath, lockText, npmrcFindings, npmrcPath, reasonText, registryOf, registryResolver } from "../checks/deps.mjs";
import { readIfThere } from "../core/files.mjs";
import { SecretScanner, masked, secretsOff } from "../checks/secrets.mjs";
import { buildImpactTable, formatImpactTable } from "../impact/table.mjs";
import { reworkRate } from "../metrics/szz.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { gateLogPath, readAttempts, recordAttempt, summarizeAttempts, KINDS } from "../metrics/gate-log.mjs";
import { graphProblems, loadGraph, pickMechanization, scoreNode, GraphError } from "../plan/mechanization.mjs";
import { auditAnswer, cycleRecords, markCovers, readLog, securityDue, sensitivePaths } from "../plan/audit.mjs";
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
  budget [--json] [--record [--security-audit]]     instruction text loaded every session / by path, rule lines repeated across files; --record appends to paths.metricsLog, --security-audit marks the cycle's security audit
  commit-check [--hook] <message-file>              check commit message shape (commit-msg hook; --hook: a config that does not load warns instead of failing)
  deps [--json]                                     known advisories (OSV), install scripts and unlisted sources of the lock files; exit 1 unless all measured clean
  impact --symbol <s> [--files a,b]                 five-row impact table (markdown)
  rework [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days N] [--json]
                                                    SZZ-style rework rate
  mechanization [--json]                            best ready mechanization node
  audit [--json]                                    whether this cycle's audit slot is the security audit (security.everyCycles), and the sensitive paths it reads
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

/** Past this many files a risky source of `audit` is listed by directory, each with its count: every file's directory is named. */
const AUDIT_NAMES = 50;

/** How many levels of local callees the commit-msg hook reads, one git round each; past it they are said unread. */
const CALLEE_ROUNDS = 20;

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
      // Given twice, the last would win without a word (an --exit 1 that a later --exit 0 turns into a pass).
      if ((flags.includes(name) || options.includes(name)) && Object.hasOwn(opts, name)) throw new UsageError(`--${name} given twice`);
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

/** Repository root when inside one, else the working directory; a git that fails stops the command. */
function projectDir() {
  return repoPath("--show-toplevel", { cwd: process.cwd() }) ?? process.cwd();
}

/** @param {string} cwd */
const config = (cwd) => loadConfig({ cwd });

/**
 * For an amend! / squash! message, the commit it folds into: the newest of the last 500 whose subject is
 * the one named, every leading fold prefix taken off as autosquash does ("squash! squash! x" folds into
 * x), with its message and paths; null when there is none (or the message is no fold). `missed`: no target
 * was found but the search did not see the whole history (500 commits read, or a shallow clone), so what
 * the target would require goes unchecked, and the caller says so.
 * @param {string} cwd @param {string} message @param {"strip" | "whitespace" | "verbatim" | "scissors"} cleanup @param {string} comment @param {boolean} cut
 * @returns {{ target: { message: string, paths: string[] } | null, missed: "depth" | "shallow" | null, subject: string }}
 */
function foldTarget(cwd, message, cleanup, comment, cut) {
  const fold = /^(?:amend|squash)! (.*)$/.exec(storedMessage(message, cleanup, comment, cut).split("\n")[0] ?? "");
  if (!fold) return { target: null, missed: null, subject: "" };
  const subject = fold[1].replace(/^(?:(?:amend|squash|fixup)! )+/, "");
  // No commit yet, or no repository: nothing to fold into. A git that fails is no "no target".
  if (!headCommit(cwd)) return { target: null, missed: null, subject };
  // One more than the search: 501 lines say the history goes on, 500 or fewer that it was all read.
  const log = git(["log", "-n501", "--format=%H%x00%s"], { cwd }).split("\n");
  const hit = log.slice(0, 500).find((l) => l.slice(l.indexOf("\0") + 1) === subject);
  if (!hit) {
    const missed = log.length > 500 ? "depth" : git(["rev-parse", "--is-shallow-repository"], { cwd }) === "true" ? "shallow" : null;
    return { target: null, missed, subject };
  }
  const hash = hit.slice(0, hit.indexOf("\0"));
  return {
    target: {
      message: git(["log", "-1", "--format=%B", hash, "--"], { cwd }),
      paths: git(["show", "-z", "--name-only", "--no-renames", "--format=", hash, "--"], { cwd }).split("\0").filter(Boolean),
    },
    missed: null,
    subject,
  };
}

/**
 * security.secrets.except as a config file holds it: the list, [] when unset, null when the file does not parse
 * or holds no list of globs that compile there.
 * @param {Buffer} bytes
 * @returns {string[] | null}
 */
function exceptIn(bytes) {
  try {
    const list = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))?.security?.secrets?.except;
    if (list === undefined) return [];
    if (!Array.isArray(list) || !list.every((g) => typeof g === "string" && g !== "")) return null;
    for (const g of list) globToRegExp(g);
    return list;
  } catch {
    return null;
  }
}

/**
 * The except list the commit's own config holds, when the config is tracked: one written in the work tree and
 * not staged does not loosen the scan, and a config the commit deletes means the defaults. `before`: HEAD's list
 * (null with none); a name is exempt only where both lists name it. `said`: what to tell (the work tree's list
 * is not the commit's; the commit changes the list so that it lets staged paths through; the commit's config
 * does not parse, or is deleted).
 * @param {string} cwd @param {any} cfg @param {string[]} staged @param {NodeJS.ProcessEnv} env
 * @returns {{ except: string[], before: string[] | null, said: string[] }}
 */
function committedExcept(cwd, cfg, staged, env) {
  const work = cfg.security.secrets.except;
  const rel = cfg.configPath ? relative(cwd, cfg.configPath).split(sep).join("/") : "";
  if (!rel || rel.startsWith("../")) return { except: work, before: null, said: [] };
  const lang = cfg.language;
  const blob = stagedBlobs(cwd, [rel], { env }).blobs.get(rel);
  const head = headBlob(cwd, rel);
  const before = head ? exceptIn(head) : null;
  // Not in the index: the work tree's config is the only one, unless HEAD holds one the commit deletes.
  if (!blob) return head ? { except: [], before, said: [t("cli.secretsConfigDeleted", { path: rel }, lang)] } : { except: work, before: null, said: [] };
  const own = exceptIn(blob);
  if (own === null) return { except: work, before, said: [t("cli.secretsConfigUnread", { path: rel }, lang)] };
  const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const said = same(own, work) ? [] : [t("cli.secretsExceptUnstaged", { path: rel }, lang)];
  if (before !== null && !same(own, before)) {
    const through = staged.filter((p) => matchAny(p, own) && !matchAny(p, before));
    if (through.length) said.push(t("cli.secretsExceptWidened", { n: through.length, paths: namesShown(through) }, lang));
  }
  return { except: own, before, said };
}

/** Up to three names as a message shows them: each quoted, a control character escaped, a secret cut. @param {string[]} list */
const namesShown = (list) => list.slice(0, 3).map(nameShown).join(", ");

/**
 * security.secrets for one commit. except as the commit's own config holds it (committedExcept); the names the
 * commit adds; the lines it adds, streamed through SecretScanner, smallest files first while their new sizes fit
 * READ_BUDGET, so a commit of large files costs a bounded time and memory (the scan keeps a window, not the lines), apart
 * from review.forbidden's own read; a file whose added lines look like part of a key read whole for the key
 * around them; in a merge, which hits the other side brings. What it cannot read is said by name, with why; run
 * by hand (`hook` false) that fails instead. `namesUnread` is said after the CI check, so a CI file's name gets
 * that check's words first.
 * @param {string} cwd @param {any} cfg @param {string[]} staged @param {string[]} notUtf8 @param {boolean} hook
 * @returns {Promise<{ errors: string[], said: string[], except: string[], namesUnread: string | null }>}
 */
async function secretScan(cwd, cfg, staged, notUtf8, hook) {
  const lang = cfg.language;
  /** @type {string[]} */
  const said = [];
  const say = (/** @type {string} */ key, /** @type {Record<string, string | number>} */ vars) => {
    const text = t(key, vars, lang);
    if (!hook) throw new Error(text);
    said.push(text);
  };
  const reason = (/** @type {unknown} */ e) => String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];
  /** @type {string[]} */
  let except = cfg.security.secrets.except;
  /** @type {string[] | null} */
  let before = null;
  const done = (/** @type {string[]} */ errors, /** @type {string | null} */ namesUnread = null) => ({ errors, said, except, namesUnread });
  try {
    // Outside a repository nothing is staged.
    if (repoPath("--git-dir", { cwd }) === null) return done([]);
    const own = committedExcept(cwd, cfg, staged, process.env);
    ({ except, before } = own);
    said.push(...own.said);
  } catch (e) {
    if (!hook) throw e;
    said.push(t("cli.secretsConfigUnmeasured", { error: reason(e) }, lang));
  }
  if (secretsOff(except)) return done([]);
  let changes;
  try {
    changes = stagedChanges(cwd, { env: process.env });
  } catch (e) {
    if (!hook) throw e;
    said.push(t("cli.secretsUnmeasured", { error: reason(e) }, lang));
    return done([]);
  }
  // The names the commit adds; one is exempt only where the list HEAD holds names it too.
  const names = [...changes].filter(([p, c]) => c.status === "A" && !(matchAny(p, except) && (before === null || matchAny(p, before)))).map(([p]) => p);
  // Smallest first: a large file cannot crowd out the small one beside it. The lines a file adds are at most its new size.
  const kept = [...changes].filter(([, c]) => c.status !== "D");
  const read = kept.filter(([p]) => !matchAny(p, except)).sort((a, b) => a[1].newSize - b[1].newSize || (a[0] < b[0] ? -1 : 1));
  /** @type {Set<string>} */
  const planned = new Set();
  /** @type {string[]} */
  const past = [];
  let left = READ_BUDGET;
  for (const [p, c] of read) {
    if (c.newSize <= left) planned.add(p), (left -= c.newSize);
    else past.push(p);
  }
  if (past.length) say("cli.secretsPastBudget", { n: past.length, paths: namesShown(past), mb: READ_BUDGET / 1024 / 1024 });
  // A file the commit adds is read whole from cat-file (git's diff would hold each of its lines in memory to
  // compare with nothing); the others from the diff: with no pathspec when they are all there is and all are read,
  // which names that are not UTF-8 reach too, else by pathspec.
  const added = [...planned].filter((p) => changes.get(p)?.status === "A" && changes.get(p)?.oid);
  const addedSet = new Set(added);
  const changed = [...planned].filter((p) => !addedSet.has(p));
  const unasked = new Set(notUtf8);
  const whole = added.length === 0 && planned.size === kept.length;
  const unnamed = whole ? [] : changed.filter((p) => unasked.has(p));
  const namesUnread = unnamed.length ? t("cli.secretsNamesUnread", { n: unnamed.length, paths: namesShown(unnamed) }, lang) : null;
  const scan = new SecretScanner();
  /** @type {string | null} */
  let current = null;
  /** @type {Set<string>} */
  const shownPaths = new Set();
  const onLine = (/** @type {string} */ path, /** @type {number} */ n, /** @type {Buffer} */ bytes) => {
    if (!planned.has(path)) return;
    if (path !== current) scan.file((current = path));
    scan.line(n, bytes);
  };
  try {
    await streamStagedBlobs(cwd, added.sort().map((p) => ({ path: p, oid: /** @type {any} */ (changes.get(p)).oid })), { env: process.env, onLine });
    const asked = changed.filter((p) => !unasked.has(p));
    for (let at = 0; at < (whole ? 1 : asked.length); at += 500) {
      const r = await streamStagedDiff(cwd, whole ? null : asked.slice(at, at + 500), { env: process.env, onLine });
      for (const p of r.shown) shownPaths.add(p);
    }
    scan.close();
    // A path asked that no header named (a pathspec that matched nothing) was not read.
    const unseen = changed.filter((p) => !shownPaths.has(p) && !unasked.has(p));
    if (unseen.length) say("cli.secretsUnseen", { n: unseen.length, paths: namesShown(unseen) });
    // A key's header or material without the rest in the added lines: the file read whole for the key around them.
    const near = [...scan.near.keys()];
    if (near.length) {
      const whole = stagedBlobs(cwd, near, { env: process.env });
      for (const [p, blob] of whole.blobs) scan.around(p, blob);
      if (whole.unread.size) say("cli.secretsKeyUnread", { n: whole.unread.size, paths: namesShown([...whole.unread.keys()]), reason: String([...whole.unread.values()][0]) });
    }
    // In a merge, the hits the other side's commits bring (they may have run no hook), for the message only.
    const parents = scan.hits.length ? mergeHeads(cwd) : [];
    for (const path of [...new Set(scan.hits.map((h) => h.path))].slice(0, 20)) {
      for (const parent of parents) {
        /** @type {Set<number>} */
        const theirs = new Set();
        await streamStagedDiff(cwd, [path], { env: process.env, against: [parent], onLine: (_, n) => void theirs.add(n) });
        for (const h of scan.hits) if (h.path === path && !theirs.has(h.line)) h.from ??= parent;
      }
    }
  } catch (e) {
    if (!hook) throw e;
    said.push(t("cli.secretsUnmeasured", { error: reason(e) }, lang));
  }
  return done(secretErrors({ config: cfg, hits: scan.hits, names, secretsExcept: except }), namesUnread);
}

// Every line written passes unshownEscaped: a value that reached a line without tShown (an error that quotes a
// path, git's own words) still cannot drive the terminal. Line feeds the program put there stay.
/** @param {string} s */
const out = (s) => process.stdout.write(unshownEscaped(s.endsWith("\n") ? s : s + "\n", { keepLines: true }));
/** The longest line written to stderr: past it a line keeps its start and end, the cut said (an error naming thousands of paths). */
const ERROR_LINE_MAX = 4000;
/** @param {string} s */
const err = (s) =>
  process.stderr.write(
    unshownEscaped(s.endsWith("\n") ? s : s + "\n", { keepLines: true }).replace(/[^\n]+/g, (line) => {
      if (line.length <= ERROR_LINE_MAX) return line;
      const { head, tail, cut } = ends(line, ERROR_LINE_MAX);
      return `${head}…(${cut} characters cut)…${tail}`;
    }),
  );
/** A value in quotes; one shown quoted and escaped brings its own. @param {string} s */
const inQuotes = (s) => {
  const v = shown(s, { inQuotes: true });
  return v.quoted ? v.text : `"${v.text}"`;
};

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

/** An error message on one line: a message's parts are judged line by line. @param {string} s */
const oneLine = (s) => s.trim().replace(/\s*\n\s*(?:- )?/g, "; ");

/** @param {number | null} sec */
const minutes = (sec) => (sec === null ? "—" : (sec / 60).toFixed(1));

/** @param {number} b */
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
/** @param {number} b */
const signedKb = (b) => `${b > 0 ? "+" : b < 0 ? "−" : "±"}${(Math.abs(b) / 1024).toFixed(1)} KB`;

/** @param {number | null} share @param {string} lang */
const percent = (share, lang) => (share === null ? "—" : lang === "tr" ? `%${Math.round(share * 100)}` : `${Math.round(share * 100)}%`);

/**
 * The `.npmrc` npm reads in a directory, as the index holds it (`.npmrc` itself before another case of it), for
 * the registry of an entry with no resolved URL; undefined when the index holds none. A read that fails is a
 * file that could not be read, never no file.
 * @param {string} cwd @param {string} dir @param {NodeJS.ProcessEnv} [env]
 * @returns {{ staged: Buffer | null, unread?: string } | undefined}
 */
function npmrcHeld(cwd, dir, env) {
  try {
    const listed = indexNames(cwd, { env, paths: [dir || "."] });
    const names = listed.paths.filter((p) => npmrcPath(p) && dirOf(p) === dir && !listed.notUtf8.includes(p));
    const name = names.find((p) => p === ".npmrc" || p.endsWith("/.npmrc")) ?? names[0];
    return name === undefined ? undefined : stagedVersions(cwd, [name], { env }).get(name);
  } catch {
    return { staged: null, unread: "notBlob" };
  }
}

/** @type {Record<string, (args: string[]) => Promise<number> | number>} */
const COMMANDS = {
  "init-scan"(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const res = scanProject({ cwd });
    if (opts.json) return (out(jsonShown(res)), 0);
    // A broken config is part of the report, not a reason to stop.
    let lang = "en";
    try {
      lang = config(cwd).language;
    } catch {
      // English until the config loads.
    }
    // Every value comes from the project (names, subjects, lines of its files): shown as one line can show it
    // (tShown), so a control or direction character neither drives the terminal nor passes for the report's own text.
    const say = (/** @type {string} */ key, /** @type {import("../core/i18n.mjs").Vars} */ vars = {}) => out(tShown(key, vars, lang));
    /** A name inside a value the line puts together itself. @param {string} name */
    const name = (name) => shown(name, { name: true }).text;
    /** A proposal for the config: escaped, never cut. @param {string} s */
    const whole = (s) => ({ shown: shown(s, { max: Infinity }).text });
    /** What was not measured and why, in the project's language. @param {{ path?: string, reason: string, name?: string }[]} list */
    const why = (list) => ({ shown: list.map((u) => tShown(`scan.why.${u.reason}`, { path: [u.path ?? ""], name: u.name ?? "" }, lang)).join("; ") });
    if (!res.config.path) say("scan.configNone");
    else if (res.config.problems.length) say("scan.configProblems", { path: [res.config.path], problems: res.config.problems.join("; ") });
    else say("scan.configOk", { path: [res.config.path] });
    say(res.graph.exists ? "scan.graphOk" : "scan.graphNone", { path: [res.graph.path] });
    if (!res.repository) say("scan.noRepo");
    else {
      const fx = res.fixSubject;
      if (fx.commits) say("scan.conventional", { commits: fx.commits, pct: percent(fx.conventionalShare, lang) });
      const cs = res.commitStyle;
      if (cs.language.guess) say("scan.commitLanguage", { guess: cs.language.guess, tr: cs.language.tr, en: cs.language.en });
      if (cs.types.length) say("scan.subjectTypes", { list: { shown: cs.types.map((x) => `${shown(x.type).text} ${x.n}`).join(" · ") } });
      // A weak result proposes nothing; its examples show the mentions.
      const pattern = fx.proposal ?? fx.candidates.find((c) => c.id === fx.pick)?.pattern ?? null;
      // A proposal is copied into the config: shown whole, never cut.
      const vars = { commits: fx.commits, min: MIN_HISTORY, pattern: whole(pattern ?? ""), matches: fx.matches, pct: percent(fx.share, lang) };
      const examples = { shown: fx.examples.map((e) => inQuotes(excerpt(e, pattern ? new RegExp(pattern) : null))).join(", ") };
      say({ ok: "scan.fixOk", majority: "scan.fixMajority", weak: "scan.fixWeak", none: "scan.fixNone", tooFew: "scan.fixTooFew" }[fx.reason], { ...vars, examples });
      if (res.churn.paths.length) {
        say("scan.churn", { min: res.churn.min ?? 0, commits: res.churn.commits });
        for (const p of res.churn.paths) say("scan.churnItem", { path: [p.path], n: p.commits, marker: p.generatedMarker ? t("scan.generatedMarker", {}, lang) : "" });
      }
    }
    say("scan.tests", { n: res.tests.matched });
    if (res.tests.proposal) say("scan.testsProposal", { examples: res.tests.alternatives.flatMap((a) => a.examples).slice(0, 3), pattern: whole(res.tests.proposal) });
    if (res.risky.length) say("scan.risky", { list: { shown: res.risky.map((r) => shown(r.glob, { name: true, max: Infinity }).text).join(", ") } });
    if (res.roadmap.length) {
      const item = (/** @type {typeof res.roadmap[number]} */ r) =>
        r.absent ? "scan.roadmapItemAbsent" : r.outside ? "scan.roadmapItemOutside" : r.open + r.done ? "scan.roadmapItem" : "scan.roadmapItemLines";
      say("scan.roadmap", { list: { shown: res.roadmap.map((r) => tShown(item(r), { path: [r.path], open: r.open, done: r.done, lines: r.lines }, lang)).join(" · ") } });
    }
    if (res.github) say("scan.github", { repo: res.github });
    // What a file not read declares is unknown, never "none"; what the others declare is listed.
    if (res.commands.length) say("scan.commands", { list: res.commands.join(" · ") });
    if (res.unmeasured.commands) say("scan.commandsUnmeasured", { reason: why(res.unmeasured.commands) });
    else if (!res.commands.length) say("scan.commandsNone");
    if (res.mutation) say("scan.mutation", { command: res.mutation });
    else if (res.unmeasured.mutation) say("scan.mutationUnmeasured", { reason: why(res.unmeasured.mutation) });
    else say("scan.mutationNone");
    if (res.pathScopedRules) say("scan.rules", { n: res.pathScopedRules });
    if (res.pathScopedRulesLinkedOut) say("scan.rulesLinkedOut", { linked: res.pathScopedRulesLinkedOut });
    const ag = res.agentSetup;
    const kb = (/** @type {number} */ b) => `${(b / 1024).toFixed(1)} KB`;
    if (ag.instructions.length) {
      const biggest = ag.instructions.filter((i) => i.loads === "always").sort((a, b) => b.bytes - a.bytes).slice(0, 5);
      say("scan.instructions", {
        always: kb(ag.size.always),
        onDemand: kb(ag.size.onDemand),
        other: kb(ag.size.other),
        list: { shown: biggest.map((i) => `${name(i.path)} ${kb(i.bytes)}`).join(" · ") || "—" },
      });
      // Every-session files first: those are the rules the cycle would contradict each time.
      const order = { always: 0, "on-demand": 1, other: 2 };
      // At most two lines per file, so a rule file is not hidden behind a long CLAUDE.md; --json has them all.
      const files = [...ag.instructions].sort((a, b) => order[a.loads] - order[b.loads]);
      const all = files.reduce((n, i) => n + i.commitLines.length, 0);
      const lines = files.flatMap((i) => i.commitLines.slice(0, 2).map((line) => ({ path: [i.path], line }))).slice(0, 8);
      for (const r of lines) say("scan.commitRule", r);
      if (all > lines.length) say("scan.commitRuleMore", { n: all - lines.length });
    }
    // Ban lines with what the index holds of each literal today; the same two-a-file, eight in all as above.
    if (res.bans?.length) {
      /** @type {Map<string, number>} */
      const perFile = new Map();
      const lines = res.bans.filter((b) => {
        const n = (perFile.get(b.path) ?? 0) + 1;
        perFile.set(b.path, n);
        return n <= 2;
      }).slice(0, 8);
      for (const b of lines) {
        const literals = {
          shown: b.literals
            .map((l) => tShown(l.lines ? "scan.banLiteral" : "scan.banLiteralNone", { text: l.text, lines: l.lines, files: l.files, examples: l.examples, gated: l.gated ? t("scan.banGated", {}, lang) : "" }, lang))
            .join("; "),
        };
        say("scan.ban", { path: [b.path], line: b.line, literals });
      }
      if (res.bans.length > lines.length) say("scan.banMore", { n: res.bans.length - lines.length });
    }
    if (res.unmeasured.bans) say("scan.bansUnmeasured", { reason: why(res.unmeasured.bans) });
    if (ag.skills.length || ag.agents.length || ag.commands.length) say("scan.agentParts", { skills: ag.skills.length, agents: ag.agents.length, commands: ag.commands.length });
    if (ag.overlaps.cycle.length || ag.overlaps.reviewers.length) {
      say("scan.overlaps", { cycle: ag.overlaps.cycle.length ? ag.overlaps.cycle : "—", reviewers: ag.overlaps.reviewers.length ? ag.overlaps.reviewers : "—" });
    }
    if (ag.hooks.length) say("scan.hooks", { list: ag.hooks });
    if (ag.mcpServers.length) say("scan.mcp", { list: ag.mcpServers });
    const unreadable = [...res.unreadable, ...ag.unreadable];
    if (unreadable.length) say("scan.unreadable", { list: unreadable });
    if (res.outside.length) say("scan.outside", { list: res.outside });
    return 0;
  },

  "install-hook"(args) {
    const { help } = parseArgs(args, {});
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const res = installHook({ cwd, cliPath: fileURLToPath(import.meta.url) });
    const key = res.result === "hooksPath" ? `hook.hooksPath.${res.hooksKind}` : `hook.${res.result}`;
    out(t(key, { path: res.path, dir: res.hooksPath ?? "", line: res.line, cli: res.cli ?? "", chmod: res.chmod, own: res.own }, cfg.language));
    // What doctor warns about is no "nothing to do": a hook left as it is, or one that checks nothing, exits 1.
    return ["other", "hooksPath", "notThere", "notExecutable", "cliGone"].includes(res.result) ? 1 : 0;
  },

  budget(args) {
    const { opts, help } = parseArgs(args, { flags: ["json", "record", "security-audit"] });
    if (help) return (out(USAGE), 0);
    if (opts["security-audit"] && !opts.record) throw new UsageError("--security-audit marks a record: give it with --record");
    const cwd = projectDir();
    const cfg = config(cwd);
    const files = git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd }).split("\0").filter(Boolean);
    const b = instructionBudget(cwd, files);
    // No commit yet: the record has no commit. A git that fails stops here, before anything is recorded.
    const head = headCommit(cwd) ?? "";
    // Only a mark reads the count; a plain record never depends on it. The count leaves out this cycle's own record
    // (the one at this commit, which the new record replaces), and the mark covers what no earlier mark did.
    /** @type {import("../plan/audit.mjs").SecurityDue | null} */
    let before = null;
    /** @type {string[] | undefined} */
    let covers;
    if (opts["security-audit"]) {
      const records = cycleRecords(readLog(cwd, resolve(cwd, cfg.paths.metricsLog)));
      const last = [...records].reverse().find((r) => r.budget);
      const kept = head && last?.commit === head ? records.filter((r) => r !== last) : records;
      before = securityDue(kept, cfg.security.everyCycles);
      if (before.due !== false) covers = markCovers(kept);
    }
    const refused = before?.due === false;
    const log = readBudgets(resolve(cwd, cfg.paths.metricsLog), cwd);
    // Measured against the newest record made at another commit: recording twice in a cycle hides nothing.
    const previous = previousBudget(log.records, head);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const recorded = opts.record ? recordBudget(cwd, cfg.paths.metricsLog, b, { date: today, commit: head, covers }) : null;
    const why = before?.reason === "off" ? t("budget.markOff", {}, cfg.language) : t("budget.markSince", { since: before?.since ?? 0, every: before?.every ?? 0 }, cfg.language);
    // A refused mark still records the cycle: the record is what counts it.
    if (refused) err(t("budget.markRefused", { why }, cfg.language));
    if (opts.json) return (out(jsonShown({ ...b, previous, skipped: log.skipped, unusable: log.unusable, recorded: recorded ? { ...recorded.entry, replaced: recorded.replaced } : null, markRefused: refused })), refused ? 1 : 0);
    const lang = cfg.language;
    const delta = previous
      ? t("budget.delta", { d: signedKb(b.always - previous.always), bytes: b.always - previous.always, commit: previous.commit.slice(0, 10) || "—" }, lang)
      : t(recorded ? "budget.first" : "budget.none", {}, lang);
    out(t("budget.summary", { always: kb(b.always), listings: kb(b.listings), onDemand: kb(b.onDemand), files: b.files, delta }, lang));
    if (b.repeatedLines) {
      out(t("budget.repeated", { n: b.repeatedLines, every: b.repeatedEverySession }, lang));
      // Names of the project's files, and a line of one: shown as one line each can show (tShown).
      for (const r of b.repeated.slice(0, 5)) out(tShown("budget.repeatedItem", { line: r.line, files: r.files }, lang));
    }
    if (b.untracked.length) out(tShown("budget.untracked", { list: b.untracked }, lang));
    if (b.outside.length) out(tShown("budget.outside", { list: b.outside }, lang));
    if (log.skipped) out(t("budget.skipped", { n: log.skipped, path: resolve(cwd, cfg.paths.metricsLog) }, lang));
    if (log.unusable) out(t("budget.unusable", { n: log.unusable, path: resolve(cwd, cfg.paths.metricsLog) }, lang));
    if (recorded) out(t(recorded.replaced ? "budget.replaced" : "budget.recorded", { path: recorded.path, commit: recorded.entry.commit.slice(0, 10) }, lang));
    // One record a commit. Recorded again today with the same mark is this cycle's step 6 again: silent. A mark
    // replaced by a plain record drops what it covered; anything else may be another cycle's record (one that made
    // no commit of its own), said with its date.
    const was = recorded?.replacedEntry;
    if (was && was.securityAudit === true && !recorded?.entry.securityAudit) out(t("budget.replacedMark", { n: Array.isArray(was.covers) ? was.covers.length : 0 }, lang));
    else if (was && (recorded?.replacedDate !== today || (was.securityAudit === true) !== Boolean(recorded?.entry.securityAudit))) out(t("budget.replacedNote", { date: recorded?.replacedDate || "?" }, lang));
    if (recorded?.entry.securityAudit) out(t("budget.securityAudit", {}, lang));
    return refused ? 1 : 0;
  },

  audit(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const due = auditAnswer(cwd, cfg);
    const rel = (/** @type {string} */ p) => relative(cwd, p).split(sep).join("/");
    const own = { configRel: cfg.configPath ? rel(cfg.configPath) : null, logRel: rel(resolve(cwd, cfg.paths.metricsLog)) };
    // Only a security audit reads the paths; a git that fails stops the command, as everywhere.
    const paths = due.due === false ? [] : sensitivePaths(git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd }).split("\0").filter(Boolean), cfg, own);
    const code = due.due === null ? 1 : 0;
    // Names a terminal would act on (direction overrides, C1 controls, line separators) as \u escapes: still JSON.
    if (opts.json) return (out(jsonShown({ slot: due.due === false ? "feature" : "security", ...due, log: cfg.paths.metricsLog, paths })), code);
    const lang = cfg.language;
    // The log's name as the config gives it, and an error's text, shown on one line (tShown).
    const vars = { every: due.every, cycles: due.cycles, since: due.since ?? 0, left: due.every - (due.since ?? 0) - 1, path: [cfg.paths.metricsLog], error: due.error ?? "" };
    if (due.due === false) out(t(due.reason === "off" ? "audit.off" : "audit.feature", vars, lang));
    else out(t("audit.security", { why: tShown(due.error ? "audit.why.error" : `audit.why.${due.reason}`, vars, lang) }, lang));
    if (due.due !== false) {
      if (!paths.length) out(t("audit.noPaths", {}, lang));
      // The cycle reads this list as the audit's scope: every name, or past AUDIT_NAMES every file's directory.
      const dirOf = (/** @type {string} */ f) => (f.includes("/") ? `${f.slice(0, f.lastIndexOf("/"))}/` : "./");
      const byName = (/** @type {[string, unknown]} */ [a], /** @type {[string, unknown]} */ [b]) => (a < b ? -1 : 1);
      for (const p of paths) {
        const source = p.off ? t("audit.sourceOff", { source: p.source }, lang) : p.source;
        if (p.rules) {
          // What runs on the machines is named file by file, each with the rule that named it, under its directory.
          /** @type {Map<string, string[]>} */
          const dirs = new Map();
          p.files.forEach((f, i) => dirs.set(dirOf(f), [...(dirs.get(dirOf(f)) ?? []), `${f.slice(f.lastIndexOf("/") + 1)} (${p.rules?.[i]})`]));
          out(t("audit.machine", { source, n: p.files.length }, lang));
          for (const [dir, list] of [...dirs].sort(byName)) out(tShown("audit.machineDir", { dir: [dir], list }, lang));
          continue;
        }
        // Only the risky sources, which can be large, are summarized: every file's directory, with its count.
        const summed = p.files.length > AUDIT_NAMES && ["review.impactRequiredGlobs", "init-scan risky"].includes(p.source);
        /** @type {Map<string, number>} */
        const dirs = new Map();
        for (const f of p.files) dirs.set(dirOf(f), (dirs.get(dirOf(f)) ?? 0) + 1);
        out(tShown(summed ? "audit.pathsDirs" : "audit.paths", { source, n: p.files.length, d: dirs.size, list: summed ? [...dirs].sort(byName).map(([d, n]) => `${d} (${n})`) : p.files }, lang));
      }
    }
    return code;
  },

  async doctor(args) {
    const { help } = parseArgs(args, {});
    if (help) return (out(USAGE), 0);
    const res = await checkSetup({ cwd: projectDir() });
    const mark = { ok: "✓", warn: "!", fail: "✗", unmeasured: "?" };
    // Every value shown as one line can show it: a tracked name or a graph id could otherwise print a line of its own.
    for (const i of res.items) out(`${mark[i.level]} ${tShown(i.key, i.vars, res.language)}`);
    const count = (/** @type {string} */ level) => res.items.filter((i) => i.level === level).length;
    // A check that could not be made is no warning: counted apart, and only when there is one.
    const unmeasured = count("unmeasured") ? t("doctor.summaryUnmeasured", { n: count("unmeasured") }, res.language) : "";
    out(t("doctor.summary", { fail: count("fail"), warn: count("warn") }, res.language) + unmeasured);
    return res.ok ? 0 : 1;
  },

  async "commit-check"(args) {
    const { positional, opts, help } = parseArgs(args, { positional: 1, flags: ["hook"] });
    if (help) return (out(USAGE), 0);
    if (!positional[0]) throw new UsageError("commit-check needs a message file");
    let cwd;
    try {
      cwd = projectDir();
    } catch (e) {
      // From the commit-msg hook a git that fails lets the commit through, saying so.
      if (!opts.hook) throw e;
      const error = /** @type {Error & { stderr?: unknown }} */ (e);
      err(t("cli.hookGitFailed", { error: String(error.stderr ?? error.message).trim().split("\n")[0] }, "en"));
      return 0;
    }
    let cfg;
    try {
      cfg = config(cwd);
    } catch (e) {
      // From the commit-msg hook a config that does not load (broken, or there but unreadable) must not lock
      // every commit, the one that fixes it included.
      if (!opts.hook) throw e;
      err(t("cli.hookConfigBroken", { error: oneLine(/** @type {Error} */ (e).message) }, "en"));
      return 0;
    }
    let message;
    try {
      message = readFileSync(positional[0], "utf8");
    } catch (e) {
      const error = oneLine(/** @type {Error} */ (e).message);
      // The hook lets the commit through when it cannot read what it would check, and says so.
      if (opts.hook) return (err(t("cli.hookMessageUnreadable", { path: positional[0], error }, cfg.language)), 0);
      err(t("cli.cannotRead", { path: positional[0], error }, cfg.language));
      return 1;
    }
    // A config git tracks that is not in the work tree (a sparse checkout without .ennyn/), or an ENNYN_CONFIG
    // naming no file: the defaults would check another project's rules, so the hook says nothing was checked.
    if (opts.hook && !cfg.configPath) {
      const named = process.env.ENNYN_CONFIG;
      let tracked = "";
      try {
        if (!named && repoPath("--git-dir", { cwd }) !== null) tracked = git(["ls-files", "-z", "--", ".ennyn/config.json"], { cwd });
      } catch (e) {
        const error = /** @type {Error & { stderr?: unknown }} */ (e);
        return (err(t("cli.hookGitFailed", { error: String(error.stderr || error.message).trim().split("\n")[0] }, "en")), 0);
      }
      if (named || tracked) return (err(t("cli.hookConfigAbsent", { path: named || ".ennyn/config.json" }, "en")), 0);
    }
    /** @type {string[]} */
    let staged = [];
    /** Staged names that are not UTF-8: git cannot be asked for them by name. */
    /** @type {string[]} */
    let notUtf8 = [];
    try {
      // An index git gave the hook that is not this repository's own (GIT_INDEX_FILE set outside its git dir):
      // the main index would be read instead, another commit's files.
      const given = process.env.GIT_INDEX_FILE;
      if (opts.hook && given && !hookIndexFile(cwd, process.env)) throw new Error(t("cli.hookIndexForeign", { path: given }, cfg.language));
      // Outside a repository nothing is staged: the message is all there is to check.
      if (repoPath("--git-dir", { cwd }) !== null) ({ paths: staged, notUtf8 } = stagedNames(cwd, { env: process.env }));
    } catch (e) {
      if (!opts.hook) throw e;
      err(t("cli.stagedUnmeasured", { error: String(/** @type {Error} */ (e).message).split("\n")[0] }, cfg.language));
    }
    // The config holds every rule's text: it names the literal without breaking the rule.
    const exempt = cfg.configPath ? [relative(cwd, cfg.configPath).split(sep).join("/")] : [];
    // The lines review.forbidden reads: those of the staged paths a rule names. Unread, the hook says so and the
    // rest of the check still runs; run by hand, the command fails.
    /** @type {Map<string, import("../core/git.mjs").AddedLine[]> | undefined} */
    let addedLines;
    /** Files that look like UTF-16 or UTF-32 and could not be read whole to be decoded, with why. */
    /** @type {Map<string, string>} */
    const wideUnread = new Map();
    const ruled = staged.filter((p) => !exempt.includes(p) && cfg.review.forbidden.some((/** @type {{ paths: string[] }} */ r) => matchAny(p, r.paths)));
    // A name that is not UTF-8 may read the same as another staged name: neither is asked for, both are said.
    const unnamed = [...new Set(ruled.filter((p) => notUtf8.includes(p) && cfg.review.forbidden.some((/** @type {{ paths: string[], except?: string[] }} */ r) => matchAny(p, r.paths) && !matchAny(p, r.except ?? []))))];
    if (unnamed.length) {
      const said = t("cli.forbiddenNamesUnread", { n: unnamed.length, paths: namesShown(unnamed) }, cfg.language);
      if (!opts.hook) throw new Error(said);
      err(said);
    }
    const named = ruled.filter((p) => !notUtf8.includes(p));
    if (named.length) {
      try {
        addedLines = stagedAddedLines(cwd, named, { env: process.env, wideUnread });
      } catch (e) {
        if (!opts.hook) throw e;
        const error = /** @type {Error & { stderr?: unknown }} */ (e);
        err(t("cli.forbiddenUnmeasured", { error: String(error.stderr || error.message).trim().split("\n")[0] }, cfg.language));
      }
    }
    // security.secrets: every file and name the commit adds, except as the commit's own config holds it, read
    // apart from review.forbidden and before the message: what the files bring stands when the message check fails.
    const secrets = await secretScan(cwd, cfg, staged, notUtf8, Boolean(opts.hook));
    for (const said of secrets.said) err(said);
    const namesUnread = secrets.namesUnread;
    // CI files (security.ci): the uses, triggers and permissions the commit brings, against HEAD's version. The
    // files under the directories `security.ci.paths` names are read with the staged ones, and every local callee
    // their `uses` name, by path: a caller's change can reach a reusable workflow or an action it calls. Reading
    // that context can fail, or stop at a depth, without turning the check of the staged files off: what it could
    // not read is said. Like review.forbidden it holds for every message, and what it cannot read is said, never
    // passed as clean.
    const ciRule = cfg.security.ci;
    const isCi = (/** @type {string} */ p) => matchAny(p, ciRule.paths) && !matchAny(p, ciRule.except);
    /** @type {{ errors: string[], warnings: string[] }} */
    let ci = { errors: [], warnings: [] };
    if (staged.some(isCi)) {
      try {
        const shownNames = (/** @type {string[]} */ list) => list.slice(0, 3).map((p) => shown(masked(p), { name: true }).text).join(", ");
        // Where callers live: each glob's directory before its first wildcard; an action-file glob ("**/action.yml")
        // names callees, which are read by path; any other glob with no directory means the whole index.
        const dirs = [...new Set(ciRule.paths.flatMap((/** @type {string} */ g) => {
          const at = g.search(/[*?[{]/);
          const lit = at === -1 ? g : g.slice(0, at);
          const dir = lit.includes("/") ? lit.slice(0, lit.lastIndexOf("/")) : "";
          return dir === "" && /(^|\/)action\.(?:ya?ml|\{[^}]*\})$/.test(g) ? [] : [dir];
        }))];
        /** @type {{ paths: string[], notUtf8: string[] }} */
        let callers = { paths: [], notUtf8: [] };
        try {
          if (dirs.length) callers = indexNames(cwd, { env: process.env, paths: dirs.includes("") ? [] : dirs });
        } catch (e) {
          if (!opts.hook) throw e;
          err(t("cli.ciCallersUnread", { error: String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0] }, cfg.language));
        }
        const all = [...new Set([...staged.filter(isCi), ...callers.paths.filter(isCi)])];
        const ciUnnamed = all.filter((p) => notUtf8.includes(p) || callers.notUtf8.includes(p));
        // A staged name git cannot be asked for fails a hand run; a tracked one the commit leaves alone is said.
        const stagedUnnamed = ciUnnamed.filter((p) => staged.includes(p));
        const trackedUnnamed = ciUnnamed.filter((p) => !staged.includes(p));
        if (stagedUnnamed.length) {
          const said = t("cli.ciNamesUnread", { n: stagedUnnamed.length, paths: shownNames(stagedUnnamed) }, cfg.language);
          if (!opts.hook) throw new Error(said);
          err(said);
        }
        if (trackedUnnamed.length) err(t("cli.ciTrackedUnread", { n: trackedUnnamed.length, paths: shownNames(trackedUnnamed) }, cfg.language));
        const versions = stagedVersions(cwd, all.filter((p) => !ciUnnamed.includes(p)), { env: process.env });
        // Callees by path, a level a round, each new file parsed once; a candidate in neither the index nor HEAD is
        // no file. Past CALLEE_ROUNDS levels, or when a read fails, what is left is said (ciSet names it missing).
        const tried = new Set(versions.keys());
        let fresh = new Map(versions);
        for (let round = 0; fresh.size && round < CALLEE_ROUNDS; round++) {
          const want = ciCallees(fresh).filter((p) => isCi(p) && !tried.has(p));
          fresh = new Map();
          if (!want.length) break;
          for (const p of want) tried.add(p);
          try {
            for (const [p, v] of stagedVersions(cwd, want, { env: process.env })) if (v.staged || v.head || v.unread || v.headUnread) versions.set(p, v), fresh.set(p, v);
          } catch (e) {
            if (!opts.hook) throw e;
            err(t("cli.ciCalleesUnread", { paths: shownNames(want), error: String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0] }, cfg.language));
            break;
          }
        }
        ci = ciMessages(versions, cfg.language);
      } catch (e) {
        if (!opts.hook) throw e;
        const error = /** @type {Error & { stderr?: unknown }} */ (e);
        err(t("cli.ciUnmeasured", { error: String(error.stderr || error.message).trim().split("\n")[0] }, cfg.language));
      }
    }
    // Lock files and .npmrc (security.deps): what the commit brings, against HEAD's version. Like review.forbidden
    // it holds for every message; what the registry does not answer is said, never passed as clean.
    const depsRule = cfg.security.deps;
    /** @type {{ errors: string[], warnings: string[] }} */
    let deps = { errors: [], warnings: [] };
    const stagedLocks = staged.filter((p) => lockPath(p, depsRule.paths));
    // An .npmrc counts where npm reads it for the project: at the top, or next to a lock file the paths name.
    const npmrcs = depsRule.paths.length ? staged.filter(npmrcPath) : [];
    let readNpmrc = npmrcs.filter((p) => dirOf(p) === "" || stagedLocks.some((l) => dirOf(l) === dirOf(p)));
    const besideNone = npmrcs.filter((p) => !readNpmrc.includes(p));
    if (besideNone.length) {
      try {
        const listed = indexNames(cwd, { env: process.env, paths: [...new Set(besideNone.map(dirOf))] }).paths;
        readNpmrc = [...readNpmrc, ...besideNone.filter((p) => listed.some((l) => dirOf(l) === dirOf(p) && lockPath(l, depsRule.paths)))];
      } catch (e) {
        if (!opts.hook) throw e;
        err(t("cli.depsUnmeasured", { error: String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0] }, cfg.language));
      }
    }
    const depsPaths = [...stagedLocks, ...readNpmrc];
    const depsUnnamed = depsPaths.filter((p) => notUtf8.includes(p));
    if (depsUnnamed.length) {
      // Shown as a report shows a name: a direction mark or a control character in it is escaped.
      const said = tShown("cli.depsNamesUnread", { n: depsUnnamed.length, paths: depsUnnamed.slice(0, 3) }, cfg.language);
      if (!opts.hook) throw new Error(said);
      err(said);
    }
    const depsNamed = depsPaths.filter((p) => !notUtf8.includes(p));
    if (depsNamed.length) {
      /** @type {ReturnType<typeof stagedVersions> | null} */
      let versions = null;
      try {
        versions = stagedVersions(cwd, depsNamed, { env: process.env });
      } catch (e) {
        if (!opts.hook) throw e;
        const error = /** @type {Error & { stderr?: unknown }} */ (e);
        err(t("cli.depsUnmeasured", { error: String(error.stderr || error.message).trim().split("\n")[0] }, cfg.language));
      }
      // The .npmrc beside a staged lock the commit leaves alone names the registry npm asks for an entry with no
      // resolved URL: read from the index, and only when such an entry asks for it.
      const beside = (/** @type {string} */ dir) => npmrcHeld(cwd, dir, process.env);
      const kinds = (/** @type {string[]} */ paths) => indexKinds(cwd, paths, { env: process.env });
      if (versions) deps = await depsMessages(versions, depsRule, cfg.language, { beside, kinds });
    }
    if (namesUnread) {
      if (!opts.hook) throw new Error(namesUnread);
      err(namesUnread);
    }
    let res;
    try {
      const { cleanup, comment, cut } = hookCommitMode({ cwd, message, env: process.env });
      const fold = foldTarget(cwd, message, cleanup, comment, cut);
      if (fold.missed) err(t("cli.foldNotFound", { subject: fold.subject, where: t(`cli.foldWhere.${fold.missed}`, {}, cfg.language) }, cfg.language));
      res = checkCommitShape(message, { config: cfg, stagedPaths: staged, cleanup, cut, comment, foldTarget: fold.target, addedLines, secretsExcept: secrets.except, exempt, wideUnread });
    } catch (e) {
      // A git that fails, or a pattern in the config that does not compile, is no reason to lock commits either:
      // the commit goes through, and the message says it was not checked.
      if (!opts.hook) throw e;
      const error = /** @type {Error & { stderr?: unknown }} */ (e);
      if (typeof error.stderr === "string") err(t("cli.hookGitFailed", { error: error.stderr.trim().split("\n")[0] }, cfg.language));
      else err(t("cli.hookConfigBroken", { error: error.message }, "en"));
      // What the files bring was read apart from the message: it still stands, the secrets they hold too.
      for (const x of [...ci.errors, ...ci.warnings, ...deps.errors, ...deps.warnings, ...secrets.errors]) err(x);
      return ci.errors.length || deps.errors.length || secrets.errors.length ? 1 : 0;
    }
    for (const e of [...ci.errors, ...deps.errors, ...secrets.errors, ...res.errors]) err(e);
    for (const w of [...(res.warnings ?? []), ...ci.warnings, ...deps.warnings]) err(w);
    return res.ok && !ci.errors.length && !deps.errors.length && !secrets.errors.length ? 0 : 1;
  },

  async deps(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const rule = /** @type {import("../checks/deps.mjs").DepsRule} */ (cfg.security.deps);
    // What npm installs from: the tracked lock files the paths name, and the lock files beside each package.json,
    // tracked or not (one that is ignored is still the one npm reads); the .npmrc npm reads beside them and at the
    // top. With the check off (paths []), nothing.
    const inRepo = repoPath("--git-dir", { cwd }) !== null;
    const tracked = inRepo ? git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd }).split("\0").filter(Boolean) : [];
    const off = !rule.paths.length;
    /** @type {{ path: string, reason: import("../checks/deps.mjs").Reason }[]} */
    const unreadFiles = [];
    const hasTopPackage = readIfThere(resolve(cwd, "package.json")) !== null;
    const pkgDirs = off ? [] : [...new Set([...tracked.filter((f) => /(^|\/)package\.json$/.test(f) && !f.split("/").includes("node_modules")).map(dirOf), ...(hasTopPackage ? [""] : [])])].sort();
    const near = pkgDirs.flatMap((dir) => {
      try {
        return readdirSync(resolve(cwd, dir || ".")).map((f) => (dir ? `${dir}/${f}` : f));
      } catch (e) {
        // A package.json git lists in a directory the work tree no longer has: nothing is installed there.
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") unreadFiles.push({ path: dir || ".", reason: { key: "readFailed", vars: { error: oneLine(/** @type {Error} */ (e).message) } } });
        return [];
      }
    });
    const locks = off ? [] : [...new Set([...tracked.filter((f) => lockPath(f, rule.paths)), ...near.filter((f) => lockPath(f, rule.paths))])].sort();
    const lockDirs = new Set(locks.map(dirOf));
    const npmrcs = off ? [] : [...new Set([...tracked, ...near].filter((f) => npmrcPath(f) && (dirOf(f) === "" || lockDirs.has(dirOf(f)))))].sort();
    const untracked = inRepo ? [...locks, ...npmrcs].filter((f) => !tracked.includes(f)) : [];
    /** @type {(import("../checks/deps.mjs").LockEntry & { path: string })[]} */
    const entries = [];
    /** @type {(import("../checks/deps.mjs").LockEntry & { path: string })[]} */
    const links = [];
    /** @type {{ path: string, line: string, reason?: import("../checks/deps.mjs").Reason, kind?: "registry" | "indirect" }[]} */
    const npmrcLines = [];
    const read = (/** @type {string} */ path) => {
      try {
        const text = lockText(readFileSync(resolve(cwd, path)));
        if (text === null) unreadFiles.push({ path, reason: { key: "notText" } });
        return text;
      } catch (e) {
        unreadFiles.push({ path, reason: { key: "readFailed", vars: { error: oneLine(/** @type {Error} */ (e).message) } } });
        return null;
      }
    };
    for (const path of locks) {
      const text = read(path);
      if (text === null) continue;
      const lock = lockEntries(text);
      if (lock.unread !== undefined) unreadFiles.push({ path, reason: lock.unread });
      else {
        // One line for each entry, however many places in the tree hold it.
        const seen = new Set();
        for (const e of lock.entries) {
          const k = `${e.name}@${e.version} ${e.resolved ?? ""} ${e.integrity ?? ""}`;
          if (!seen.has(k)) seen.add(k), entries.push({ ...e, path });
        }
        links.push(...lock.links.map((e) => ({ ...e, path })));
      }
    }
    /** @type {string[]} */
    const npmrcChanged = [];
    for (const path of npmrcs) {
      const text = rule.paths.length ? read(path) : null;
      if (text === null) continue;
      // The registry of an entry with no resolved URL is read from the .npmrc the index holds, as the hook reads it.
      if (inRepo && tracked.includes(path)) {
        const held = npmrcHeld(cwd, dirOf(path));
        if (held && held.staged && lockText(held.staged) !== text) npmrcChanged.push(path);
      }
      const f = npmrcFindings(text, rule);
      npmrcLines.push(...f.refuse.map((r) => ({ path, line: `${r.n}: ${r.line}`, kind: r.kind })), ...f.said.map((x) => ({ path, line: `${x.n}: ${x.line}`, reason: x.reason })));
    }
    // Where npm fetches each entry from, judged as the hook judges it (judgeLock): a source no list names, git, a
    // path out of the repository is a problem; an entry a listed registry proves is asked about as that registry's.
    // The .npmrc beside each lock and the paths inside the repository are read from the index.
    /** @type {Map<import("../checks/deps.mjs").LockEntry, ReturnType<typeof judgeEntry>>} */
    const judged = new Map();
    /** @type {{ entry: import("../checks/deps.mjs").LockEntry & { path: string }, reason: import("../checks/deps.mjs").Reason }[]} */
    const mismatched = [];
    /** @type {{ entry: import("../checks/deps.mjs").LockEntry & { path: string }, reason: import("../checks/deps.mjs").Reason, kind: "unlisted" | "git" }[]} */
    const refusedSources = [];
    /** @type {Map<string, (name: string) => { url: string } | { reason: import("../checks/deps.mjs").Reason }>} */
    const resolvers = new Map();
    /** @type {{ entry: import("../checks/deps.mjs").LockEntry & { path: string }, reason: import("../checks/deps.mjs").Reason }[]} */
    const unmeasuredHere = [];
    // Outside a repository there is no index: the .npmrc beside a lock is the work tree's (said below).
    const npmrcOnDisk = (/** @type {string} */ dir) => {
      const here = npmrcs.filter((p) => dirOf(p) === dir);
      const name = here.find((p) => p === ".npmrc" || p.endsWith("/.npmrc")) ?? here[0];
      if (name === undefined) return undefined;
      try {
        return { staged: readFileSync(resolve(cwd, name)) };
      } catch {
        return { staged: null, unread: "readFailed" };
      }
    };
    for (const path of locks) {
      const dir = dirOf(path);
      const registryFor = (/** @type {string} */ name) => {
        let r = resolvers.get(dir);
        if (!r) resolvers.set(dir, (r = registryResolver(inRepo ? npmrcHeld(cwd, dir) : npmrcOnDisk(dir))));
        return r(name);
      };
      const mine = links.filter((e) => e.path === path);
      const r = judgeLock(entries.filter((e) => e.path === path), mine, rule, { lockDir: dir, registryFor, kinds: inRepo ? (paths) => indexKinds(cwd, paths) : undefined });
      for (const [e, j] of r.judged) judged.set(e, j);
      const at = (/** @type {import("../checks/deps.mjs").LockEntry} */ e) => ({ ...e, path });
      // What the judgment could not measure and no advisory query will name: links, and reads that failed.
      unmeasuredHere.push(...r.unread.filter((u) => mine.includes(/** @type {any} */ (u.entry)) || ["indexUnread", "noResolvedUnread"].includes(u.reason.key)).map((u) => ({ entry: at(u.entry), reason: u.reason })));
      mismatched.push(...r.refused.mismatch.map((x) => ({ entry: at(x.entry), reason: x.reason })));
      refusedSources.push(...r.refused.unlisted.map((x) => ({ entry: at(x.entry), reason: x.reason, kind: /** @type {const} */ ("unlisted") })), ...r.refused.git.map((x) => ({ entry: at(x.entry), reason: x.reason, kind: /** @type {const} */ ("git") })));
    }
    const proven = entries.map((e) => {
      const j = judged.get(e);
      return j && "listed" in j ? { ...j.listed, path: e.path } : e;
    });
    const scripts = entries.filter((e, i) => e.scripts && !rule.allowScripts.includes(String(e.resolved)) && !("origin" in registryOf(proven[i], rule) && rule.allowScripts.includes(e.name)));
    const found = await advisoriesOf(proven.filter((_, i) => !("refuse" in (judged.get(entries[i]) ?? {}))), rule);
    // One name@version from two places: the place shows, so two lines never read alike.
    const originOf = (/** @type {import("../checks/deps.mjs").LockEntry} */ e) => {
      try {
        return e.resolved ? new URL(e.resolved).origin : "—";
      } catch {
        return e.resolved ?? "—";
      }
    };
    /** @type {Map<string, Set<string>>} */
    const sources = new Map();
    for (const e of entries) sources.set(`${e.path}\0${e.name}@${e.version}`, new Set([...(sources.get(`${e.path}\0${e.name}@${e.version}`) ?? []), originOf(e)]));
    const where = (/** @type {(import("../checks/deps.mjs").LockEntry & { path?: string }) | null} */ e) =>
      e ? `${e.version ? `${e.name}@${e.version}` : e.name} (${e.path}${(sources.get(`${e.path}\0${e.name}@${e.version}`)?.size ?? 0) > 1 ? `; ${originOf(e)}` : ""})` : "—";
    // A package.json with dependencies and no lock beside it or above it (a workspace's lock sits at its root):
    // what npm installs there is unmeasured. One it cannot read may have some.
    const hasDeps = (/** @type {string} */ dir) => {
      try {
        const pkg = JSON.parse(readFileSync(resolve(cwd, dir, "package.json"), "utf8"));
        return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((k) => pkg?.[k] && typeof pkg[k] === "object" && Object.keys(pkg[k]).length);
      } catch (e) {
        return /** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT";
      }
    };
    const lockless = pkgDirs.filter((d) => ![...lockDirs].some((l) => l === "" || l === d || d.startsWith(`${l}/`)) && hasDeps(d));
    const unchecked = found.unread.length + unreadFiles.length + npmrcLines.filter((l) => l.reason).length + lockless.length + unmeasuredHere.length;
    const problems = found.advisories.length + scripts.length + mismatched.length + refusedSources.length + npmrcLines.filter((l) => !l.reason).length;
    const clean = !problems && !unchecked;
    const summary = t("deps.summary", { files: locks.length, entries: entries.length, advisories: found.advisories.length, scripts: scripts.length, refused: mismatched.length + refusedSources.length, unchecked }, lang);
    if (opts.json) {
      const text = (/** @type {import("../checks/deps.mjs").Reason} */ r) => ({ code: r.key, reason: reasonText(r, lang) });
      out(jsonShown({ files: locks, npmrc: npmrcs, untracked, npmrcChanged, lockless: lockless.map((d) => (d ? `${d}/package.json` : "package.json")), entries: entries.length, advisories: found.advisories.map((a) => ({ ...a, entries: [...new Set(a.entries.map(where))], ...(a.unread ? { unread: text(a.unread) } : {}) })), scripts: scripts.map(where), mismatched: mismatched.map((m) => ({ entry: where(m.entry), ...text(m.reason) })), refused: refusedSources.map((r) => ({ entry: where(r.entry), kind: r.kind, ...text(r.reason) })), npmrcLines: npmrcLines.map((l) => ({ path: l.path, line: l.line, ...(l.reason ? text(l.reason) : { refused: true }) })), unchecked: [...found.unread.map((u) => ({ entry: where(u.entry), ...text(u.reason) })), ...unmeasuredHere.map((u) => ({ entry: where(u.entry), ...text(u.reason) }))], unread: unreadFiles.map((u) => ({ path: u.path, ...text(u.reason) })), clean }));
      // The exit code says it; so does a line on stderr, for a reader of the JSON who only sees the failure.
      if (!clean) err(summary);
      return clean ? 0 : 1;
    }
    if (off) out(t("deps.checkOff", {}, lang));
    else if (!locks.length && !lockless.length) out(t("deps.noLock", {}, lang));
    for (const d of lockless) out(`? ${tShown("deps.noneMeasured", { path: [d ? `${d}/package.json` : "package.json"] }, lang)}`);
    for (const f of untracked) out(`! ${tShown("deps.untracked", { path: [f] }, lang)}`);
    for (const f of npmrcChanged) out(`! ${tShown("deps.npmrcChanged", { path: [f] }, lang)}`);
    if (!inRepo && locks.length) out(`! ${t("deps.workTree", {}, lang)}`);
    for (const u of unmeasuredHere) out(`? ${tShown("deps.entryUnread", { where: [where(u.entry)], reason: reasonText(u.reason, lang) }, lang)}`);
    for (const u of unreadFiles) out(`? ${tShown("deps.lockUnread", { path: [u.path], reason: reasonText(u.reason, lang) }, lang)}`);
    for (const a of found.advisories) {
      const summaryText = a.unread ? t("deps.recordUnread", { reason: reasonText(a.unread, lang) }, lang) : a.summary;
      out(`✗ ${tShown("deps.advisory", { id: a.id, severity: a.severity || "—", aliases: a.aliases.join(", ") || "—", summary: summaryText, where: [...new Set(a.entries.map(where))] }, lang)}`);
    }
    for (const m of mismatched) out(`✗ ${tShown("deps.mismatchEntry", { where: [where(m.entry)], reason: reasonText(m.reason, lang) }, lang)}`);
    for (const r of refusedSources) out(`✗ ${tShown(r.kind === "git" ? "deps.gitEntry" : "deps.unlistedEntry", { where: [where(r.entry)], reason: reasonText(r.reason, lang) }, lang)}`);
    for (const e of scripts) out(`! ${tShown("deps.scriptEntry", { where: [where(e)] }, lang)}`);
    for (const l of npmrcLines) out(l.reason ? `? ${tShown("deps.npmrcSaid", { path: [l.path], where: [l.line], why: reasonText(l.reason, lang) }, lang)}` : `✗ ${tShown(l.kind === "indirect" ? "deps.npmrcIndirect" : "deps.npmrc", { path: [l.path], where: [l.line] }, lang)}`);
    /** @type {Map<string, string[]>} */
    const byReason = new Map();
    for (const u of found.unread) {
      const k = reasonText(u.reason, lang);
      byReason.set(k, [...(byReason.get(k) ?? []), where(u.entry)]);
    }
    for (const [reason, list] of [...byReason].sort(([a], [b]) => (a < b ? -1 : 1))) out(`? ${tShown("deps.unchecked", { n: list.length, reason, where: list.length > 3 ? [...list.slice(0, 3), t("deps.more", { n: list.length - 3 }, lang)] : list }, lang)}`);
    out(summary);
    return clean ? 0 : 1;
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
    if (opts.json) return (out(jsonShown({ ...res, days: windowDays })), 0);
    const lang = cfg.language;
    if (res.rate === null) out(t("rework.none", {}, lang));
    else {
      const pct = `${(res.rate * 100).toFixed(1)}%`;
      out(t("rework.summary", { reworked: res.reworked, commits: res.commits, pct, days: windowDays }, lang));
      if (res.fixCommits * 2 > res.commits) out(t("rework.fixMajority", { fixes: res.fixCommits, commits: res.commits }, lang));
    }
    if (res.censored) out(t("rework.censored", { n: res.censored, days: windowDays }, lang));
    if (res.skewed) out(t("rework.skewed", { n: res.skewed }, lang));
    if (res.shallow) out(t("rework.shallow", {}, lang));
    for (const p of res.pairs) {
      // File names from history: shown as one line can show them.
      out(tShown("rework.pair", { origin: p.origin.slice(0, 10), fix: p.fix.slice(0, 10), files: p.files, lines: p.lines, days: p.days }, lang));
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
    if (opts.json) return (out(jsonShown(res)), 0);
    const lang = cfg.language;
    if (res.shallow) out(t("bypass.shallow", {}, lang));
    if (!res.commits) return (out(t("bypass.noCommits", {}, lang)), 0);
    out(t(res.uses.length ? "bypass.summary" : "bypass.none", { n: res.uses.length, commits: res.commits }, lang));
    for (const u of res.uses) {
      // The local day, as --since / --until read it.
      const d = new Date(u.time * 1000);
      // A commit object with no committer time has no day.
      const date = Number.isFinite(u.time) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "—";
      // A subject and a reason from history: shown as one line can show them.
      out(tShown("bypass.item", { hash: u.hash.slice(0, 10), date, subject: u.subject, reason: u.reason || t("bypass.noReason", {}, lang) }, lang));
    }
    return 0;
  },

  async mechanization(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const graph = await loadGraph({ cwd, config: cfg });
    // What doctor fails on, this refuses: a pick from a graph with a node twice or no id is a guess.
    const problems = graphProblems(graph, cfg);
    for (const p of problems) err(`${p.level === "fail" ? "✗" : "!"} ${tShown(p.key, p.vars, cfg.language)}`);
    if (problems.some((p) => p.level === "fail")) return (err(t("mechanization.refused", {}, cfg.language)), 1);
    const node = pickMechanization(graph, cfg);
    const score = node ? scoreNode(node, cfg) : null;
    if (opts.json) return (out(jsonShown(node ? { node, score } : null)), 0);
    if (!node) out(t("mechanization.none", {}, cfg.language));
    else out(tShown("mechanization.pick", { id: String(node[cfg.graph.fields.id]), score: Number(score).toFixed(2) }, cfg.language));
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
    // One problem a line: each escaped on its own, so none starts a line the list did not.
    if (problems.length) return (err(t("mutate.listProblems", { path: positional[0], problems: { shown: problems.map((p) => unshownEscaped(p)).join("\n- ") } }, lang)), 1);
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
      err(t("mutate.baselineFailed", { how: String(how), tail: { shown: res.baseline.tail.trimEnd().split("\n").slice(-15).map((l) => unshownEscaped(l)).join("\n") } }, lang));
      return 1;
    }
    const sum = summarizeMutants(res.results);
    if (opts.json) return (out(jsonShown({ ...res, summary: sum })), 0);
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
    // An empty value is an unset variable in the wrapper. An empty --kind could be either kind; an empty
    // --commit with exit 0 would turn a pass into a failure. With a non-zero exit there is no commit to name.
    if (opts.kind !== undefined && strOpt(opts.kind) === null) throw new UsageError("--kind needs a value");
    if (opts.commit !== undefined && strOpt(opts.commit) === null && exit === 0) throw new UsageError("--commit needs a value with --exit 0");
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
    const result = t(`gate.result.${res.entry.result}`, {}, cfg.language);
    if (res.entry.seconds === null) out(t("gate.recordedUntimed", { result, path: res.path, start }, cfg.language));
    else out(t("gate.recorded", { result, path: res.path }, cfg.language));
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
    if (opts.json) return (out(jsonShown({ path, exists: log.exists, skipped: log.skipped, ...sum })), 0);
    if (!log.exists) return (out(t("gate.none", { path }, lang)), 0);
    if (log.skipped) out(t("gate.skipped", { n: log.skipped, path }, lang));
    if (!sum.attempts) return (out(t("gate.emptyWindow", {}, lang)), 0);
    const pct = sum.failRate === null ? "—" : `${(sum.failRate * 100).toFixed(0)}%`;
    out(t("gate.summary", { full: sum.full, passed: sum.passed, failed: sum.failed, pct, message: sum.message }, lang));
    if (sum.pass.n) out(t("gate.passTime", { median: minutes(sum.pass.median), p90: minutes(sum.pass.p90) }, lang));
    if (sum.fail.n) out(t("gate.failTime", { median: minutes(sum.fail.median), p90: minutes(sum.fail.p90), wasted: minutes(sum.wastedSeconds) }, lang));
    if (sum.unmeasuredDurations) out(t("gate.durationUnmeasured", { n: sum.unmeasuredDurations }, lang));
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
  // An error names what it read (a path, a key, git's words about a file): each is one line, a line feed in
  // a value escaped too, so a name cannot start a line of its own; a config's problems keep a line each.
  if (!cmd || !Object.hasOwn(COMMANDS, cmd)) {
    err(cmd ? `unknown command ${inQuotes(cmd)}\n\n${USAGE}` : USAGE);
    return 2;
  }
  try {
    return await COMMANDS[cmd](rest);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${unshownEscaped(e.message)}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ConfigError) {
      err(["Invalid ennyn config:", ...e.problems.map((p) => `- ${unshownEscaped(p)}`)].join("\n"));
      return 1;
    }
    if (e instanceof GraphError || e instanceof MutationError) {
      err(unshownEscaped(e.message));
      return 1;
    }
    const error = /** @type {Error & { stderr?: unknown }} */ (e);
    err(`ennyn ${cmd}: ${unshownEscaped(error.stderr ? String(error.stderr).trim() : error.message)}`);
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
  // A closed pipe (`ennyn rework | head`) ends the process without a stack trace, and with 141 as a process
  // ended by SIGPIPE has (git log | head): output that did not arrive, or a run cut short, is no pass.
  process.stdout.on("error", (e) => {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPIPE") process.exit(141);
    throw e;
  });
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // The commands that may ask the network: a request the budget gave up on can leave a lookup in flight (a DNS
    // answer that never comes), which would hold the commit. Once the work is done, the process ends a second
    // later at most; with nothing pending it ends at once, as any other command does.
    // The timer starts once stdout and stderr have taken all that was written to them: a reader that comes late
    // still gets every line.
    if (["commit-check", "deps"].includes(process.argv[2] ?? "")) {
      let open = 2;
      const drained = () => {
        if (--open === 0) setTimeout(() => process.exit(), 1000).unref();
      };
      process.stdout.write("", drained);
      process.stderr.write("", drained);
    }
  });
}
