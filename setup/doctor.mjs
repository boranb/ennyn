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
import { MIN_HISTORY, indexMatches, recentCommits, productionSubjects, projectFiles, githubRemotes } from "./scan.mjs";
import { askRules, outwardCommands, GH_COMMANDS, SETTINGS, SETTINGS_LIMIT } from "./permissions.mjs";
import { ORPHANED, PLUGIN_RECORD, hookStatus, idleReason, replacedRoot, sessionOf, versionNote } from "./hook.mjs";
import { instructionBudget, readBudgets } from "./budget.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { present, readRegular } from "../core/files.mjs";
import { commonDir, git, gitBytes, repoPath, gitVersion, parseVersion, versionAtLeast, stagedVersions, headCommit, headFile, HOOK_READ_ENV, GIT_FLOOR } from "../core/git.mjs";
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
 * Which of the project's settings files holds an ask or deny rule for each command that leaves the machine, and
 * whether git holds that file as committed. It says what it read, not what Claude Code will do: the ok line
 * carries where Claude Code applies the file and what a rule does not match. A read or a git call that fails
 * is said with its error, and what it would have decided is unmeasured, never judged: a file not read is not
 * "missing", a HEAD not read is not "uncommitted", a remote list not read names the gh commands not checked.
 * `read` replaces the readers (tests).
 * @param {string} cwd @param {string[] | null} files tracked files; null when git could not list them
 * @param {(level: DoctorItem["level"], key: string, vars?: DoctorItem["vars"]) => void} add
 * @param {{ read?: (rel: string, opts?: { limit?: number }) => string | null | undefined, githubRemotes?: (cwd: string) => string[], headFile?: typeof headFile }} [readers]
 */
export function askReport(cwd, files, add, readers = {}) {
  const project = projectFiles(cwd);
  const read = readers.read ?? project.read;
  /** @type {Set<string>} */
  const failed = new Set();
  /** @type {string[]} */
  const errors = [];
  const pf = {
    read: (/** @type {string} */ rel, /** @type {{ limit?: number } | undefined} */ opts) => {
      try {
        return read(rel, opts);
      } catch (e) {
        // Too large is no failure: readSettings says it.
        if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "EFBIG") throw e;
        failed.add(rel);
        errors.push(oneLine(e));
        return undefined;
      }
    },
  };
  let github = false;
  /** @type {string | null} */
  let remotesError = null;
  try {
    github = (readers.githubRemotes ?? githubRemotes)(cwd).length > 0;
  } catch (e) {
    remotesError = oneLine(e);
  }
  const committed = (/** @type {string} */ path) => {
    try {
      return (readers.headFile ?? headFile)(cwd, path, SETTINGS_LIMIT);
    } catch (e) {
      errors.push(oneLine(e));
      return undefined;
    }
  };
  const { rules, unread, head } = askRules(pf, outwardCommands(files, github, (rel) => project.present(rel)), { committed, failed });
  const left = unread.filter((p) => !failed.has(p));
  if (left.length) add("unmeasured", "doctor.askUnread", { list: left });
  for (const error of errors) add("unmeasured", "doctor.askUnmeasured", { error });
  if (remotesError !== null) add("unmeasured", "doctor.askGithubUnmeasured", { error: remotesError, commands: GH_COMMANDS });
  if (head) add("unmeasured", "doctor.askHeadKind", { path: [SETTINGS[0]] });
  const at = (/** @type {string | null} */ where) => rules.filter((r) => r.where === where);
  const named = (/** @type {typeof rules} */ list) => list.map((r) => r.rule);
  if (at("unknown").length) add("unmeasured", "doctor.askUnknown", { rules: named(at("unknown")) });
  if (at(null).length) add("warn", "doctor.askMissing", { rules: named(at(null)) });
  if (at("uncommitted").length) add("warn", "doctor.askUncommitted", { rules: named(at("uncommitted")) });
  if (at("local").length) add("warn", "doctor.askLocal", { rules: named(at("local")) });
  if (at("shared").length) add("ok", "doctor.askOk", { rules: named(at("shared")) });
}

/**
 * Where Claude Code puts the worktrees of agents (`isolation: worktree`), --worktree and EnterWorktree: below the
 * main checkout's top (2.1.310; only a WorktreeCreate hook puts them elsewhere). Each is a whole checkout holding an
 * agent's unfinished code.
 */
export const AGENT_WORKTREES = ".claude/worktrees/";
/**
 * The names asked about, each a real folder. A pattern may hold a name, a shape of one (`*-*`, `?????*`) or a first
 * letter (`[a-z]*`), so no name stands for the next: two letters with no hyphen; a long one with a hyphen, a dot, a
 * capital and a digit first; Claude Code's own for an agent, `agent-a` and 16 hexadecimal digits.
 */
const WORKTREE_NAMES = ["qx", "7-Ennyn.no_pattern-names-this", "agent-a0123456789abcdef"];
/** The names as made-up directories, for check-ignore: the / has git read a pattern for directories. */
const WORKTREES_AS_DIRECTORIES = WORKTREE_NAMES.map((name) => `${AGENT_WORKTREES}${name}/`);
/** The lists above the folder that a checkout of a commit holds: any other reads as this machine's. */
const WORKTREES_GITIGNORES = [".gitignore", ".claude/.gitignore", `${AGENT_WORKTREES}.gitignore`];
/**
 * For a call that reads the project's index: any such read runs its core.fsmonitor hook or starts its daemon. Empty,
 * as git 2.34 takes `false` for the name of a program.
 */
const NO_FSMONITOR = ["-c", "core.fsmonitor="];

/**
 * The rule that decides each path, from `check-ignore -v -n`: the empty pattern when none does.
 * @param {string} cwd @param {string[]} paths @param {NodeJS.ProcessEnv} [env]
 * @returns {IgnoreRule[]}
 * @typedef {{ source: string, line: number, pattern: string }} IgnoreRule
 */
function ignoreRules(cwd, paths, env = process.env) {
  // check-ignore refuses literal pathspecs, which every call gets; these paths hold no glob or magic either way.
  const args = ["--no-literal-pathspecs", ...NO_FSMONITOR, "check-ignore", "--stdin", "-z", "-v", "-n"];
  /** @type {string} */
  let out;
  try {
    out = gitBytes(args, { cwd, env, input: paths.map((p) => `${p}\0`).join("") }).toString("utf8");
  } catch (e) {
    // Exit 1 is git's "none of them is ignored"; a git stopped at its limit has no status.
    if (/** @type {{ status?: number | null }} */ (e).status !== 1) throw e;
    return paths.map(() => ({ source: "", line: 0, pattern: "" }));
  }
  const fields = out.split("\0");
  return paths.map((_, i) => ({ source: fields[i * 4], line: Number(fields[i * 4 + 1]), pattern: fields[i * 4 + 2] }));
}

/**
 * The lists of WORKTREES_GITIGNORES that the main checkout's HEAD holds, as bytes: Claude Code puts the folder at
 * that checkout's top, whichever one doctor runs in. None with no commit yet. A symbolic link gives none: git follows
 * no .gitignore through one.
 * @param {string} cwd
 * @returns {[string, Buffer][]}
 */
function headLists(cwd) {
  const head = headCommit(cwd, { gitDir: /** @type {string} */ (commonDir(cwd)) });
  if (!head) return [];
  const env = { ...process.env, ...HOOK_READ_ENV };
  return git(["ls-tree", "-z", head, "--", ...WORKTREES_GITIGNORES], { cwd, env }).split("\0").flatMap((entry) => {
    const m = /^100\d{3} blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
    return m ? [/** @type {[string, Buffer]} */ ([m[2], gitBytes(["cat-file", "blob", m[1]], { cwd, env })])] : [];
  });
}

/**
 * What HEAD's lists do with a worktree of any name, with nothing of this machine's: `git status` in a scratch
 * repository of its own that holds those lists and a folder of each of WORKTREE_NAMES, shaped as a linked worktree.
 * The .git file must lead to a real git dir: git then takes the folder whole and asks only whether it is excluded,
 * as it does a worktree. With no such .git it goes through the files: of 46 patterns 7 read as ignored, an allow list
 * that keeps directories or a pattern for what the folders hold; an empty folder read 26 wrong. `ignored` when git
 * lists none of them; `rule` is the first it lists, or the folder's when no rule names that one; `asked` is what
 * these lists alone answer for made-up names, before any folder of those names is there.
 *
 * Its git reads no config, ignore file or template of this machine or of the project: no git variable, no global or
 * system config, an XDG folder with nothing in it, an empty template. So no hook or fsmonitor of the project runs.
 * @param {string} cwd
 * @returns {{ ignored: boolean, rule: IgnoreRule, asked: IgnoreRule[] }}
 */
function headReading(cwd) {
  const lists = headLists(cwd);
  let scratch = "";
  try {
    scratch = mkdtempSync(join(tmpdir(), "ennyn-worktrees-"));
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
      XDG_CONFIG_HOME: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: dirname(scratch),
    };
    git(["init", "-q", "--template="], { cwd: scratch, env });
    mkdirSync(join(scratch, AGENT_WORKTREES), { recursive: true });
    for (const [path, bytes] of lists) writeFileSync(join(scratch, path), bytes);
    const asked = ignoreRules(scratch, WORKTREES_AS_DIRECTORIES, env);
    const folders = WORKTREE_NAMES.map((name) => `${AGENT_WORKTREES}${name}`);
    for (const folder of folders) {
      mkdirSync(join(scratch, folder));
      writeFileSync(join(scratch, folder, ".git"), "gitdir: ../../../.git\n");
      // A checkout's file: a git that did not take the .git for a worktree still lists the folder.
      writeFileSync(join(scratch, folder, "README.md"), "");
    }
    const listed = git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: scratch, env }).split("\0");
    const open = folders.findIndex((folder) => listed.some((e) => e.slice(3).startsWith(`${folder}/`)));
    const rules = ignoreRules(scratch, [...folders, AGENT_WORKTREES.slice(0, -1)], env);
    if (open === -1) return { ignored: true, rule: rules[0], asked };
    return { ignored: false, rule: rules[open].pattern ? rules[open] : rules[rules.length - 1], asked };
  } catch (e) {
    throw new Error(`the scratch repository in ${tmpdir()} failed: ${oneLine(e)}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What git does with what Claude Code puts in AGENT_WORKTREES. `tracked`: the index holds a worktree's files or a
 * gitlink there, which no ignore line undoes; a plain file directly in the folder (.gitkeep, a README, its own
 * .gitignore) holds no worktree. `listed`: git lists something untracked there, in this checkout. `ignored`: HEAD's
 * lists ignore a worktree of any name (headReading), which is the question: not what this checkout or machine does
 * with today's folders, and not what status says of the file. Otherwise `local`: this machine ignores it, asked of
 * the real repository with made-up names, each as a directory; `negated`: a negation in HEAD's lists decided it;
 * `none`. A git that fails, or a scratch repository that cannot be made, throws.
 * @param {string} cwd the repository's top
 * @returns {{ state: "tracked", paths: string[] } | { state: "listed", paths: string[] } | { state: "none" } | { state: "negated" | "local" | "ignored", source: string, line: number, pattern: string }}
 */
export function worktreesIgnored(cwd) {
  const entries = (/** @type {string} */ out) => out.split("\0").filter(Boolean);
  const name = (/** @type {string} */ entry) => entry.slice(entry.indexOf("\t") + 1);
  const index = entries(git([...NO_FSMONITOR, "ls-files", "-s", "-z", "--", AGENT_WORKTREES], { cwd }));
  const held = index.filter((e) => e.startsWith("160000 ") || name(e).slice(AGENT_WORKTREES.length).includes("/"));
  // A conflict lists a path once for each stage.
  if (held.length) return { state: "tracked", paths: [...new Set(held.map(name))] };
  // A read: status takes no lock to refresh the index. A tracked file changed is no listing, so only `??`.
  const status = git([...NO_FSMONITOR, "status", "--porcelain", "-z", "--untracked-files=all", "--", AGENT_WORKTREES], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const listed = entries(status).filter((e) => e.startsWith("?? ")).map((e) => e.slice(3));
  if (listed.length) return { state: "listed", paths: listed };
  const { ignored, rule, asked } = headReading(cwd);
  if (ignored) return { state: "ignored", ...rule };
  const here = ignoreRules(cwd, WORKTREES_AS_DIRECTORIES);
  // Of a folder that is not there git cannot say all: an allow list or a pattern for what the folders hold reads as
  // ignored (of 46 patterns, 8). So what HEAD's lists answer in the same words is no rule of this machine's.
  const own = here.find((r, i) => r.pattern !== asked[i].pattern);
  if (own && here.every((r) => r.pattern && !r.pattern.startsWith("!"))) return { state: "local", ...own };
  return rule.pattern.startsWith("!") ? { state: "negated", ...rule } : { state: "none" };
}

/**
 * The worktrees line: a warning for each way a worktree is not ignored. Never a ✗: no reading or gate of
 * Ennyn's depends on it; what reads the agents' code is git status, git add -A and the project's own tools.
 * @param {string} cwd @param {(level: DoctorItem["level"], key: string, vars?: DoctorItem["vars"]) => void} add
 */
function worktreesReport(cwd, add) {
  const path = [AGENT_WORKTREES];
  /** @type {ReturnType<typeof worktreesIgnored>} */
  let found;
  try {
    found = worktreesIgnored(cwd);
  } catch (e) {
    return add("unmeasured", "doctor.worktreesUnmeasured", { path, error: oneLine(e) });
  }
  if (found.state === "tracked" || found.state === "listed") {
    return add("warn", found.state === "tracked" ? "doctor.worktreesTracked" : "doctor.worktreesListed", { path, n: found.paths.length, examples: found.paths.slice(0, 3) });
  }
  if (found.state === "none") return add("warn", "doctor.worktreesNotIgnored", { path });
  const vars = { path, source: [found.source], line: found.line, pattern: [found.pattern] };
  if (found.state === "negated") add("warn", "doctor.worktreesNegated", vars);
  else if (found.state === "local") add("warn", "doctor.worktreesLocal", vars);
  else add("ok", "doctor.worktreesIgnored", vars);
}

/** The Ennyn root this doctor runs from. */
const OWN_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

/**
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, self?: string }} opts `self`: the Ennyn root doctor runs
 *   from (this file's own; a test gives a plugin version of its making)
 * @returns {Promise<DoctorResult>}
 */
export async function checkSetup({ cwd, env = process.env, self = OWN_ROOT }) {
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
    /** @type {string | null} */
    let replaced = null;
    /** @type {ReturnType<typeof versionNote>} */
    let version = null;
    let selfReplaced = false;
    try {
      hook = hookStatus(cwd);
      if (hook.state === "ennyn" || hook.state === "wired") idle = idleReason(hook);
      if (hook.state === "ennyn" && idle === null) replaced = replacedRoot(hook);
      // Run from a version Claude Code has replaced (an old session): its view of "this session's version" is stale.
      selfReplaced = present(join(self, ORPHANED));
      if (hook.state === "ennyn" && idle === null && replaced === null && !selfReplaced) version = versionNote(hook, sessionOf(env));
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
      // Installed from the plugin: uninstalled (every commit passes) or the version its link names deleted (every commit is refused).
      else if (idle === "unrecorded") add("warn", "doctor.hookPluginUnrecorded", { path: [hook.path], data: [String(hook.data)] });
      else if (idle === "stale") add("warn", "doctor.hookPluginStale", { path: [hook.path], data: [String(hook.data)], root: [String(hook.recorded)] });
      else if (idle === "foreign") add("warn", "doctor.hookRecordForeign", { path: [hook.path], record: [join(String(hook.data), PLUGIN_RECORD)] });
      else if (replaced !== null) add("warn", "doctor.hookReplaced", { path: [hook.path], root: [replaced] });
      else if (selfReplaced && hook.state === "ennyn") add("warn", "doctor.hookSelfReplaced", { path: [hook.path], own: [self] });
      else if (version === "pinned") add("warn", "doctor.hookPinned", { path: [hook.path], cli: [String(hook.cli)] });
      else if (version === "other") add("warn", "doctor.hookOtherVersion", { path: [hook.path], root: [String(hook.recorded)], own: [String(sessionOf(env)?.root)] });
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
    // The cycle asks the user before any push; an ask rule is the harness's backstop.
    askReport(cwd, files, add);
    worktreesReport(cwd, add);
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
  // With declared types, a repair is written as the commit gate admits it; a label that misses a form hides those repairs.
  if (fixRe && cm.types.length) {
    const missed = (/** @type {string[]} */ forms) => forms.filter((f) => !fixRe.test(`${cm.fixType}${f}: x`)).map((f) => `${cm.fixType}${f}: …`);
    const [plain, breaking] = [missed(["", "(x)"]), missed(["!", "(x)!"])];
    if (plain.length) add("warn", "doctor.fixTypeUnseen", { pattern: config.metrics.fixSubject, forms: plain });
    else if (breaking.length) add("warn", "doctor.fixBangUnseen", { pattern: config.metrics.fixSubject, forms: breaking });
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
