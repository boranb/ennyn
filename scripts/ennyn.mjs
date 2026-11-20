#!/usr/bin/env node
/**
 * ennyn CLI.
 *
 * Exit codes: 0 ok · 1 check failed, config error or runtime error (a git call that failed included) ·
 * 2 usage error · 141 stdout closed before the output was written, as for a process ended by SIGPIPE.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_PATH, loadConfig, ConfigError } from "../core/config.mjs";
import { HOOK_INDEX_ENV, HOOK_READ_ENV, MISSING_OBJECT, NAMES_BUFFER, READ_BUDGET, batchCheck, blobBytes, diffGroups, git, gitMaybe, headCommit, hookElsewhere, indexEntries, indexKinds, indexNames, machineFault, mergeHeads, projectRoot, repoPath, stagedAddedLines, stagedBlobs, stagedChanges, stagedNames, stagedVersions, stagedVersionsEach, stateRoot, streamStagedBlobs, streamStagedDiff, unpushedCount } from "../core/git.mjs";
import { ends, jsonShown, shown, t, tShown, unshownEscaped } from "../core/i18n.mjs";
import { matchAny } from "../core/glob.mjs";
import { foldTarget, forbiddenResult, nameShown, secretErrors, shapeOf, storedMessage, hookCommitMode } from "../checks/commit-shape.mjs";
import { anyTextRule, lineHits, literalEntry, literalsPath, newLines, privateErrors, privateShown, readLiterals, sourceHits, textRules } from "../checks/private-text.mjs";
import { ciCallees, ciMessages } from "../checks/ci.mjs";
import { advisoriesOf, depsMessages, dirOf, judgeEntry, judgeLock, lockEntries, lockPath, lockText, npmrcFindings, npmrcPath, pkgJson, pkgJsonPath, pkgPathOf, reasonText, registryOf, registryResolver } from "../checks/deps.mjs";
import { readIfThere, readRegular, writeState } from "../core/files.mjs";
import { SecretScanner, masked, secretsOff } from "../checks/secrets.mjs";
import { ConfigPicked, ConfigUnread, LOOSENING_LINE, commitConfig, looseningErrors } from "../checks/loosening.mjs";
import { closingPush } from "../checks/push-mode.mjs";
import { commitRule, commitsRefused, pushRule } from "../checks/commit-identity.mjs";
import { API, apiBase, isAddress, isLogin, noreplyLogin, setupCommands, signersPath, signersText, signingKeys, writeSigners } from "../setup/clone-setup.mjs";
import { cleanTree, lastRun, pushNeeds, readRuns, recordRun, runBase, within } from "../checks/test-runs.mjs";
import { buildImpactTable, formatImpactTable } from "../impact/table.mjs";
import { REWORK_DAYS, reworkRate } from "../metrics/szz.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { leftovers, readStart, recordStart, startPath } from "../metrics/leftovers.mjs";
import { STEPS, journalAt, statusOf, tasksFit, taskWord, writeEvent } from "../plan/cycle-journal.mjs";
import { gateLogPath, readAttempts, recordAttempt, summarizeAttempts, KINDS } from "../metrics/gate-log.mjs";
import { byAge, costWeight, doneIds, graphProblems, heldNodes, loadGraph, needsOf, pickMechanization, pickOldest, readyMechanization, readyNodes, scoreNode, splitAt, splitFirst, GraphError } from "../plan/mechanization.mjs";
import { LINK_RULE, SUBMODULE_RULE, auditAnswer, cycleRecords, markCovers, readLog, securityDue, sensitivePaths } from "../plan/audit.mjs";
import { scanProject, MIN_HISTORY } from "../setup/scan.mjs";
import { cannotFail, checkSetup, pipes } from "../setup/doctor.mjs";
import { capped, ghApplies } from "../setup/permissions.mjs";
import { PROBLEMS_SHOWN, checkProofs, loadClasses, registryLine, stateCounts } from "../metrics/classes.mjs";
import { CYCLE_MAX, brakePatches, complete, cycleReport, ledgerLine, loadLedger, recentRecurrence, reportLines } from "../metrics/findings.mjs";
import { RecordError, installHook, sessionOf } from "../setup/hook.mjs";
import { recordWrite, uninstall, writtenPath } from "../setup/uninstall.mjs";
import { instructionBudget, readBudgets, recordBudget, previousBudget, replacedAt } from "../setup/budget.mjs";
import { journalPath, MAX_TIMEOUT_MS, MutationError, parseMutants, restoreJournal, runMutants, summarizeMutants } from "../metrics/mutation.mjs";
import { markedWorktrees, removeWorktree, verdict } from "../plan/worktrees.mjs";
import { DEFAULT_LIMIT_MIN, MAX_LIMIT_MIN, ROOM_DEFAULTS, ROOM_KNOBS, STOPPED_EXIT, roomThresholds, runLocked } from "../core/heavy-lock.mjs";
import { READ_LINE_MAX, ALIASES, TranscriptError, agentUsage, claudeConfigDir, defaultSession, namedFolder, projectFolder, projectsDir } from "../adapters/claude-code/agent-usage.mjs";

export const USAGE = `Usage: ennyn <command> [options]

Commands:
  init-scan [--json]                                survey the repository for /init: fix label, churn, tests, risky paths, work sources
  doctor                                            check config, work graph and fix label; exit 1 on a problem
  install-hook [--plugin-data <dir>]                run commit-check as this repository's commit-msg hook (machine-local); --plugin-data
                                                    (a plugin session gives it as ENNYN_PLUGIN_DATA and ENNYN_PLUGIN_ROOT): the hook follows plugin updates
  uninstall-hook [--plugin-data <dir>]              remove the commit-msg hook install-hook wrote, if unchanged since, and the state dir; say what to take
                                                    out of a hook Ennyn did not write, and list what stays (config, graph, handoff, logs, ask rules)
  budget [--json] [--record [--security-audit]]     instruction text loaded every session / by path, rule lines repeated across files; --record appends to paths.metricsLog, --security-audit marks the cycle's security audit
  commit-check [--hook] <message-file>              check commit message shape (commit-msg hook; --hook: a config that does not load warns instead of failing)
  private-text add [--exact]                        add the words on stdin, one a line, to this clone's private list (hashed, in the state dir): commit-check
                                                    refuses them in added lines, added names and the message; a word matches in any case unless --exact
  deps [--json]                                     known advisories (OSV), install scripts and unlisted sources of the lock files; exit 1 unless all measured clean
  impact --symbol <s> [--files a,b]                 five-row impact table (markdown)
  rework [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days N] [--json]
                                                    SZZ-style rework rate: commits from --since to --until (local days) whose lines a fix changed
                                                    within --days N (the window after each commit, not the range; default ${REWORK_DAYS})
  core [--json]                                     the core slots' picks: the oldest node of the highest value (or the ready need it waits on), and the best ready by value/cost
  core --value <v> [--json]                         every open node of that value (graph.fields.value), ready or not, flagged or not, oldest first: what a closing reads to decline
  mechanization [--json]                            best ready mechanization node
  classes [--json]                                  the defect class registry: each class's id, state and sentence, its problems, whether each gate's commit is there and each entry that claims a gate has one standing; exit 1 unless all hold
  convergence [<ledger>] --cycle N [--from <rev>] [--json]
                                                    cycle N's convergence block, counted from the findings ledger (default paths.findings) as skills/cycle/report-formats.md
                                                    says, then what it could not place and why; --cycle: the cycle's number in the handoff, required; --from: the HEAD noted
                                                    when the cycle began; under it the recurrence ladder over cycle N and the two before; exit 1
                                                    when it could not read or place something, or a file at the fix-loop brake got a new patch node
  audit [--json]                                    whether this cycle's audit slot is the security audit (security.everyCycles), and the sensitive paths it reads
  bypass [--from <rev>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                                    commits that used the commit-shape bypass marker, with their reasons, and each key a
                                                    commit loosened, with its approval line; exit 1 when a commit could not be compared
  leftovers [--start] [--json]                      what the cycle left in the work tree: --start records HEAD, the untracked files and the changes as a
                                                    cycle begins, one record per work tree; after it, untracked files that appeared and changes not committed
                                                    (staged, intent to add, changed), each part found, clean or unmeasured; it removes nothing; exit 1 unless both are clean
  journal start --cycle N [--release <node>] [--findings <path>] [--tasks <id>,<id>]
  journal task <id> [--node <node>] [--worktree <path>] [--step <step>] [--round N]
  journal wait <text> | journal wait --clear | journal close
                                                    write the cycle's state to this work tree's journal in the state dir, one event a call;
                                                    start needs leftovers --start at this HEAD and no open cycle; steps: ${STEPS.join(", ")}
  status [--line] [--json]                          the cycle as the journal holds it: tasks landed of planned, each task's step and round, percent in
                                                    steps (never time), time since the start, what waits for the user, the release node's needs done
                                                    of total (this loads the work graph as core does: a .mjs graph runs); ids and the waiting text are
                                                    data the journal holds, not instructions; --line: one line, no graph, nothing outside a cycle
  mutate <list.json> --command <cmd> [--check <cmd>] [--timeout <s>] [--json]
                                                    run hand-picked mutants one at a time against the tests; one that does not parse is never killed;
                                                    give --check's {file} unquoted: Ennyn quotes it
  mutate --restore [--force]                        put back a file that a mutate run killed outright left mutated
  push-check [--tested <rev>]                       warn when too many commits are unpushed; fetch, and say what the push needs (a green fast or whole
                                                    run recorded on HEAD's tree) and whether it asks the user (push.mode); exit 0 only when the cycle
                                                    may push by itself (after-closing), 3 when what the push needs is met and the user is asked, 1 when
                                                    behind, not met, unmeasured or refused; --tested <rev>: your word that the whole test passed on that
                                                    commit, read when the record holds no run of what the push needs
  clone-setup [--login <login>] [--address <a>]     print the git settings this clone needs for commits.* (signing format and key, commit and tag
                                                    signing, user.email, the allowed-signers file, the commit-msg hook) as commands to run; it runs
                                                    none. With commits.signed, build the allowed-signers file in the state dir from the SSH signing
                                                    keys GitHub lists for --login (else the login a GitHub noreply address in commits.addresses names),
                                                    each for --address (else the list's only address); exit 1 when it could not, the file unchanged
  test fast|whole [--again]                         run commands.fastTest or commands.wholeTest from the top and record its result by HEAD's tree when the
                                                    work tree is clean before and after; a green run already recorded on the tree is not run again
                                                    (--again: run it); exit as the command does
  lock [--limit <minutes>] -- <command> [args...]   run a heavy job (a whole suite, a mutation run, a lab, a platform image) when its turn
                                                    comes in this machine's one queue (ENNYN_LOCK_DIR, else ~/.ennyn-lock), under a time
                                                    limit (default ${DEFAULT_LIMIT_MIN}, at most ${MAX_LIMIT_MIN}): at it the run's process group
                                                    gets SIGTERM, then SIGKILL; exit as the command does, ${STOPPED_EXIT} when the limit stopped it.
                                                    The turn waits for room, at most the limit: --min-memory <% free> (${ROOM_DEFAULTS.minMemory}),
                                                    --max-load <per CPU> (${ROOM_DEFAULTS.maxLoad}), --min-disk <GB> (${ROOM_DEFAULTS.minDisk}), or ENNYN_LOCK_MIN_MEMORY,
                                                    ENNYN_LOCK_MAX_LOAD, ENNYN_LOCK_MIN_DISK; swap is shown, never judged
  worktrees [--remove] [<path>...]                  the worktrees the cycle marked (a lock whose reason is ennyn:<cycle>), each with whether
                                                    removing it loses nothing, or why not; --remove removes those that pass, checked again first,
                                                    never with --force; paths: only those. Exit 1 when one could not be checked or removed
  gate-record --start <epoch-s> --exit <code> [--kind full|message] [--commit <rev>] [--step <name>] [--runner <name>]
                                                    record one commit-gate attempt (called by the commit wrapper)
  gate-stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                                    commit-gate wait, failures and time spent in failed attempts
  agents [--session <id or path>] [--json]          per subagent of a Claude Code session (default: the one running it, else this repository's newest), read only: the model
                                                    asked for and the models that ran, calls, output tokens, tokens written to and read from cache,
                                                    the context at its last call;
                                                    a mismatch where a model was asked; exit 1 when the session cannot be found or read

Options:
  -h, --help                                        show this help

Config: .ennyn/config.json in the repository root (override with ENNYN_CONFIG).`;

class UsageError extends Error {}

/** A session id `agents --session` takes as an id; anything with a path separator or `.jsonl` is a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Past this many files a risky source of `audit` is listed by directory, each with its count: every file's directory is named. */
const AUDIT_NAMES = 50;

/** How many ready nodes `core` lists by score, then every one that ties with the last of them, up to the second number; the rest are counted. */
const CORE_LIST = 5;
const CORE_LIST_MAX = 10;

/** How many items of each part `leftovers` lists; the rest are counted. */
const LEFTOVERS_SHOWN = 50;

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
  return projectRoot(process.cwd());
}

/** @param {string} cwd */
const config = (cwd) => loadConfig({ cwd });

/**
 * The work graph to pick from, its problems said on stderr; null when one is a fail. What doctor fails on,
 * the picks refuse: a pick from a graph with a node twice or no id is a guess.
 * @param {string} cwd @param {any} cfg
 */
async function pickable(cwd, cfg) {
  const graph = await loadGraph({ cwd, config: cfg });
  const problems = graphProblems(graph, cfg);
  for (const p of problems) err(`${p.level === "fail" ? "✗" : "!"} ${tShown(p.key, p.vars, cfg.language)}`);
  if (problems.some((p) => p.level === "fail")) return (err(t("mechanization.refused", {}, cfg.language)), null);
  return graph;
}

/**
 * Each held node of one slot (heldNodes: a clarification marker), named on stderr with its question, so a node the pick
 * leaves for the user's answer is never dropped unsaid. `flagged`: the mechanization slot's, else the core slots'.
 * @param {import("../plan/mechanization.mjs").Graph} graph @param {any} cfg @param {boolean} flagged
 */
function sayHeld(graph, cfg, flagged) {
  const f = cfg.graph.fields;
  for (const { node, question } of heldNodes(graph, cfg)) {
    if ((node[f.mechanization] === true) !== flagged) continue;
    err(`! ${tShown(question === "" ? "pick.heldBlank" : "pick.held", { id: String(node[f.id]), question }, cfg.language)}`);
  }
}

/** The paths a map holds, by the reason each was not read. @param {Map<string, string>} unread @returns {Map<string, string[]>} */
function byReason(unread) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [p, why] of unread) out.set(why, [...(out.get(why) ?? []), p]);
  return out;
}

/** Up to three names as a message shows them: each quoted, a control character escaped, a secret cut. @param {string[]} list */
const namesShown = (list) => list.slice(0, 3).map(nameShown).join(", ");

/**
 * A gate's read that failed in the hook. The rule of every such catch has two questions. What was the read of? Context
 * (`brought` false: what the commit leaves alone or deletes, what HEAD holds) is said and the commit goes on: a commit
 * is never locked by what HEAD already holds, and a deletion never refuses. Who can pick the failure? A read of what the
 * commit adds or changes is said only for a fault of the machine (machineFault), since a crash must lock no commit, the
 * one that repairs it included. Any other failure there is one the commit's own content can pick (a name past what
 * arguments hold, a throw of our own code on its text), and letting it through would be an off switch the content
 * holds: it goes on `unchecked`, which refuses the commit. A size past a ceiling is neither: said, and held to its file.
 * @param {unknown} e @param {string} lang @param {string[]} unchecked @param {string} gate
 * @param {string} key the line that says it @param {Record<string, string>} [vars] `paths`: the names not read, when known
 * @param {boolean} [brought] the read was of what the commit adds or changes
 */
function gateFailed(e, lang, unchecked, gate, key, vars = {}, brought = true) {
  const error = String(/** @type {Error & { stderr?: unknown }} */ (e)?.stderr || /** @type {Error} */ (e)?.message || e).trim().split("\n")[0];
  if (!brought || machineFault(e)) err(t(key, { ...vars, error }, lang));
  else unchecked.push(t("cli.gateRefused", { gate, what: vars.paths ?? t("cli.gateWhatUnnamed", {}, lang), error }, lang));
}

/** The words streamStagedBlobs (core/git.mjs) stops with at a header that names no blob: the secret scan's one stream failure the content picks. */
const NOT_A_BLOB = "cat-file wrote something other than the blob";

/** Every item of `more` on the end of `list`: a list a file can make long is not spread into a call. @template T @param {T[]} list @param {T[]} more */
const append = (list, more) => {
  for (const x of more) list.push(x);
};

/**
 * security.secrets for one commit. except as the commit's own config holds it, in `cfg` (commitConfig), and as HEAD
 * holds it in `before`, null with no config there: a name is exempt only where both lists name it. The names the
 * commit adds; the lines it adds, streamed through SecretScanner, smallest files first while their new sizes fit
 * READ_BUDGET, so a commit of large files costs a bounded time and memory (the scan keeps a window, not the lines), apart
 * from review.forbidden's own read; a file whose added lines look like part of a key read whole for the key
 * around them; in a merge, which hits the other side brings. A file git cannot be asked for by name (not UTF-8),
 * or one its diff could not read (stopped, failed), is read whole by its objects (readWhole). What it cannot read is
 * said by name, with why, a line for each reason; run by hand (`hook` false) that fails instead.
 * @param {string} cwd @param {any} cfg @param {string[] | null} before @param {string[]} notUtf8 @param {boolean} hook
 * @param {boolean} brought the commit adds or changes a file (gateFailed)
 * @returns {Promise<{ errors: string[], said: string[] }>}
 */
async function secretScan(cwd, cfg, before, notUtf8, hook, brought) {
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
  const except = cfg.security.secrets.except;
  const done = (/** @type {string[]} */ errors) => ({ errors, said });
  try {
    // Outside a repository nothing is staged.
    if (repoPath("--git-dir", { cwd }) === null) return done([]);
  } catch (e) {
    // One failed look at the repository is no reason to skip what the next calls can still read.
    if (!hook) throw e;
    said.push(t("cli.secretsProbeFailed", { error: reason(e) }, lang));
  }
  if (secretsOff(except)) return done([]);
  let changes;
  /** What the commit's own content could pick to stop this read: refuses it (gateFailed). @type {string[]} */
  const unchecked = [];
  try {
    changes = stagedChanges(cwd, { env: process.env });
  } catch (e) {
    if (!hook) throw e;
    gateFailed(e, lang, unchecked, "security.secrets", "cli.secretsUnmeasured", {}, brought);
    return done(unchecked);
  }
  // The names the commit adds; one is exempt only where the list HEAD holds names it too.
  const names = [...changes].filter(([p, c]) => c.status === "A" && !(matchAny(p, except) && (before === null || matchAny(p, before)))).map(([p]) => p);
  // Smallest first: a large file cannot crowd out the small one beside it. The lines a file adds are at most its new size.
  const read = [...changes].filter(([p]) => !matchAny(p, except)).sort((a, b) => a[1].newSize - b[1].newSize || (a[0] < b[0] ? -1 : 1));
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
  // A read that fails or is stopped loses its own paths and the next one still runs. Each loss is weighed by who can
  // pick it (gateFailed): one the commit's content can pick refuses the commit, by name; a fault of the machine is
  // said, a line for each reason. By hand, saying it fails.
  /** @type {Map<string, string>} */
  const unread = new Map();
  /** HEAD's version of a file read whole, not read: context, said (DESIGN.md principle 7). @type {Map<string, string>} */
  const headUnread = new Map();
  const lost = (/** @type {string[]} */ paths, /** @type {unknown} */ e, machine = machineFault(e)) => {
    if (hook && !machine) return gateFailed(e, lang, unchecked, "security.secrets", "cli.secretsReadFailed", { paths: namesShown([...paths].sort()) });
    for (const p of paths) unread.set(p, reason(e));
  };
  // A file's mode on an object that is no blob (`update-index --cacheinfo`; git commits it, and fsck calls the tree
  // broken) is the commit's own content, which no read of a file's bytes can take: in cat-file's one stream it would
  // stop the files after it, and read alone it fails as git's failure would. So the types are asked first, in one
  // call: each such path refuses the commit by name and stays out of the reads, and the rest are read. A failure of
  // this call is weighed as any read, and the reads go on without the types (`typesRead` false).
  const typed = [...planned].filter((p) => changes.get(p)?.oid && !changes.get(p)?.newMissing);
  let typesRead = true;
  if (typed.length) {
    try {
      /** @type {Map<string, string>} */
      const types = new Map();
      for (const l of batchCheck(cwd, [...new Set(typed.map((p) => /** @type {any} */ (changes.get(p)).oid))], { env: process.env })) {
        const m = /^([0-9a-f]+) (\w+) \d+$/.exec(l);
        if (m) types.set(m[1], m[2]);
      }
      /** @type {Map<string, string[]>} */
      const other = new Map();
      for (const p of typed) {
        const type = types.get(/** @type {any} */ (changes.get(p)).oid);
        if (type && type !== "blob") other.set(type, [...(other.get(type) ?? []), p]), planned.delete(p);
      }
      for (const [type, paths] of other) lost(paths, new Error(t("cli.secretsNotBlob", { type }, lang)), false);
    } catch (e) {
      if (!hook) throw e;
      typesRead = false;
      gateFailed(e, lang, unchecked, "security.secrets", "cli.secretsTypesUnread");
    }
  }
  // A file the commit adds is read whole from cat-file (git's diff would hold each of its lines in memory to
  // compare with nothing), and so is a changed one whose HEAD object a partial clone lacks; the others from the diff,
  // by pathspec, in diffGroups' calls.
  const added = [...planned].filter((p) => changes.get(p)?.status === "A" && changes.get(p)?.oid);
  const addedSet = new Set(added);
  const changed = [...planned].filter((p) => !addedSet.has(p));
  const unasked = new Set(notUtf8);
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
  // A file git is slow to diff gets a call of its own (diffGroups), so it costs one limit, and is then read whole.
  /**
   * A changed file read whole by its objects, its new object's lines scanned as one file's, in place of what its
   * diff read before it stopped: a hit counts unless its secret is in the old object, which HEAD already holds
   * (wherever the commit moves it). No old object (a partial clone lacks it), or one that could not be read (said):
   * every hit counts, as in a file the commit adds.
   * @param {string} p
   */
  const readWhole = (p) => {
    const c = /** @type {import("../core/git.mjs").StagedChange} */ (changes.get(p));
    // A submodule's commit holds no lines here.
    if (!c.oid) return;
    /** @type {Buffer | null} */
    let before = null;
    if (c.oldOid && !c.oldMissing) {
      try {
        before = blobBytes(cwd, c.oldOid);
      } catch (e) {
        headUnread.set(p, reason(e));
      }
    }
    try {
      const fresh = blobBytes(cwd, c.oid);
      scan.hits = scan.hits.filter((h) => h.path !== p);
      const from = scan.hits.length;
      scan.file((current = p));
      let n = 1;
      for (let at = 0; at < fresh.length; ) {
        const eol = fresh.indexOf(0x0a, at);
        scan.line(n++, fresh.subarray(at, eol === -1 ? fresh.length : eol));
        at = eol === -1 ? fresh.length : eol + 1;
      }
      scan.close();
      current = null;
      if (before) scan.hits = [...scan.hits.slice(0, from), ...scan.hits.slice(from).filter((h) => !before.includes(Buffer.from(h.value)))];
    } catch (e) {
      lost([p], e);
    }
  };
  try {
    // A change whose new object is not on this machine (a partial clone) is said, and git is not asked for it.
    const absent = [...planned].filter((p) => changes.get(p)?.newMissing);
    // The partial clone's, said as before: outside one git refuses to commit an entry whose object is missing (2.56.0:
    // "invalid object"), before the hook runs.
    if (absent.length) lost(absent, new Error(MISSING_OBJECT), true);
    const blobs = added.filter((p) => !changes.get(p)?.missing).sort();
    try {
      await streamStagedBlobs(cwd, blobs.map((p) => ({ path: p, oid: /** @type {any} */ (changes.get(p)).oid })), { env: process.env, onLine });
    } catch (e) {
      // With the types read, every object here is a blob, so what stops the stream is git's: an exit, a signal, its
      // limit, no start. Its error carries no status or signal for machineFault to read, so it is weighed here. With
      // the types unread, one stop is the content's: a header that names no blob (NOT_A_BLOB, streamStagedBlobs'
      // own words), refused; every other stop is still git's, said.
      lost(blobs, e, typesRead || !String(/** @type {Error} */ (e)?.message).includes(NOT_A_BLOB));
    }
    const asked = changed.filter((p) => !unasked.has(p) && !changes.get(p)?.missing);
    for (const group of diffGroups(asked, changes)) {
      try {
        const r = await streamStagedDiff(cwd, group, { env: process.env, onLine });
        for (const p of r.shown) shownPaths.add(p);
      } catch {
        // Read whole instead.
        for (const p of group) readWhole(p), shownPaths.add(p);
      }
    }
    // By its objects: a name git cannot be asked for, and a change whose HEAD object a partial clone lacks.
    for (const p of changed.filter((p) => (unasked.has(p) || changes.get(p)?.oldMissing) && !changes.get(p)?.newMissing)) readWhole(p), shownPaths.add(p);
  } finally {
    // What was read stays read: the lines still in the window are judged whatever stopped the reads.
    scan.close();
  }
  for (const [why, paths] of byReason(unread)) say("cli.secretsReadFailed", { n: paths.length, paths: namesShown(paths.sort()), error: why });
  for (const [why, paths] of byReason(headUnread)) say("cli.secretsHeadUnread", { n: paths.length, paths: namesShown(paths.sort()), error: why });
  try {
    // A path asked that no header named (a pathspec that matched nothing) was not read.
    const unseen = changed.filter((p) => !shownPaths.has(p) && !unread.has(p));
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
        try {
          await streamStagedDiff(cwd, [path], { env: process.env, against: [parent], onLine: (_, n) => void theirs.add(n) });
        } catch {
          // `from` is for the message only: unread, the hit stays this commit's own.
          continue;
        }
        for (const h of scan.hits) if (h.path === path && !theirs.has(h.line)) h.from ??= parent;
      }
    }
  } catch (e) {
    if (!hook) throw e;
    gateFailed(e, lang, unchecked, "security.secrets", "cli.secretsUnmeasured");
  }
  return done([...unchecked, ...secretErrors({ config: cfg, hits: scan.hits, names })]);
}

/**
 * security.privateText for one commit (checks/private-text.mjs): the lines it adds to the files it brings, the names it
 * adds and the message, against the clone's list of words and the config's switches; the graph's sources it adds. The
 * list is this machine's file, not the commit's: one that cannot be read is said, never read as empty. A read of what
 * the commit brings that fails is weighed by gateFailed, as review.forbidden's; a staged graph that is no JSON is the
 * commit's own content, refused. Run by hand, each of these fails the command.
 * @param {{ cwd: string, cfg: any, hook: boolean, staged: string[], notUtf8: string[], brings: (p: string) => boolean, addedNames: Set<string>, message: string | null, mode: { cleanup: "strip" | "whitespace" | "verbatim" | "scissors", comment: string, cut: boolean } | null, unchecked: string[], gateRead: (paths: string[], gate: string, key: string) => Map<string, import("../core/git.mjs").StagedVersion> }} o
 * @returns {string[]}
 */
function privateTextErrors({ cwd, cfg, hook, staged, notUtf8, brings, addedNames, message, mode, unchecked, gateRead }) {
  const lang = cfg.language;
  const GATE = "security.privateText";
  /** @param {string} said */
  const refuse = (said) => {
    if (!hook) throw new Error(said);
    unchecked.push(said);
  };
  /** @type {import("../checks/private-text.mjs").Literals | null} */
  let literals = null;
  try {
    literals = readLiterals(cwd, cfg);
  } catch (e) {
    const said = t("cli.privateListUnread", { error: oneLine(String(/** @type {Error} */ (e).message)) }, lang);
    if (!hook) throw new Error(said);
    err(said);
  }
  const rules = textRules(cfg, literals);
  const shownNames = (/** @type {string[]} */ list) => list.slice(0, 3).map((p) => privateShown(p, rules)).join(", ");
  const graphPath = relative(cwd, resolve(cwd, cfg.paths.graph)).split(sep).join("/");
  const graphOn = cfg.security.privateText.provenance && graphPath.endsWith(".json") && staged.includes(graphPath) && brings(graphPath);
  if (!anyTextRule(rules) && !graphOn) return [];
  /** @type {Map<string, import("../core/git.mjs").AddedLine[]>} */
  let lines = new Map();
  if (anyTextRule(rules)) {
    const brought = staged.filter(brings);
    const unnamed = brought.filter((p) => notUtf8.includes(p));
    if (unnamed.length) refuse(t("cli.privateNamesUnread", { n: unnamed.length, paths: shownNames(unnamed) }, lang));
    const asked = brought.filter((p) => !notUtf8.includes(p));
    /** @type {Map<string, string>} */
    const unread = new Map();
    try {
      if (asked.length) lines = stagedAddedLines(cwd, asked, { env: process.env, ...(hook ? { unread } : {}) });
    } catch (e) {
      if (!hook) throw e;
      gateFailed(e, lang, unchecked, GATE, "cli.privateUnmeasured");
    }
    for (const [why, paths] of byReason(unread)) err(t("cli.privateReadFailed", { n: paths.length, paths: shownNames(paths), error: why }, lang));
    // A line with a hit that HEAD's file already holds was moved, not written (newLines). HEAD's versions are read only
    // for files with a hit; one that cannot be read keeps its hits.
    const hit = [...lines].filter(([, ls]) => ls.some((l) => lineHits(l.text, rules).length)).map(([p]) => p);
    if (hit.length) {
      /** @type {Map<string, string | null>} */
      const heads = new Map();
      // Unread, a path keeps every hit, and that is said: the refusal may then name a line a move explains.
      /** @type {Map<string, string>} */
      const headUnread = new Map();
      try {
        const read = stagedVersionsEach(cwd, hit, { env: process.env });
        for (const [p, v] of read.versions) {
          heads.set(p, v.head && !v.headUnread ? v.head.toString("utf8") : null);
          if (v.headUnread) headUnread.set(p, v.headUnread);
        }
        for (const p of read.unaskable) headUnread.set(p, t("cli.ciCalleesNoName", {}, lang));
        for (const f of read.failed) headUnread.set(f.path, oneLine(String(/** @type {Error & { stderr?: unknown }} */ (f.error).stderr || /** @type {Error} */ (f.error).message)));
      } catch (e) {
        if (!hook) throw e;
        for (const p of hit) headUnread.set(p, oneLine(String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message)));
      }
      for (const [why, paths] of byReason(headUnread)) err(t("cli.privateHeadUnread", { n: paths.length, paths: shownNames(paths), error: why }, lang));
      lines = newLines(lines, heads);
    }
  }
  /** @type {{ path: string, hits: { line: number, length: number }[] } | undefined} */
  let graph;
  if (graphOn && !notUtf8.includes(graphPath)) {
    const v = gateRead([graphPath], GATE, "cli.privateGraphUnread").get(graphPath);
    if (v?.unread) refuse(t("cli.privateGraphNotRead", { path: privateShown(graphPath, rules), why: v.unread }, lang));
    else if (v?.staged) {
      try {
        graph = { path: graphPath, hits: sourceHits(v.staged.toString("utf8"), v.head && !v.headUnread ? v.head.toString("utf8") : null, cfg) };
      } catch (e) {
        refuse(t("cli.privateGraphNotJson", { path: privateShown(graphPath, rules), error: oneLine(String(/** @type {Error} */ (e).message)) }, lang));
      }
    }
  }
  // As git will store it (hookCommitMode: commit.cleanup, the comment marker, the scissors), unlike the secret scan's
  // superset: a line git strips (the editor's template, `# On branch <name>`) reaches no history. With how git cleans
  // it unknown, whole. A --cleanup= on the command line reaches no hook: --cleanup=verbatim with the editor stores
  // comment lines this does not read.
  const text = message !== null && anyTextRule(rules) ? (mode ? storedMessage(message, mode.cleanup, mode.comment, mode.cut) : message) : undefined;
  return privateErrors({ rules, lang, lines, names: anyTextRule(rules) ? [...addedNames] : [], message: text, graph });
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
  let start = Math.min(at, s.length - 57);
  let end = start + 57;
  // Cut between characters, never inside a pair of UTF-16 halves.
  if (start > 0 && /^[\udc00-\udfff]/.test(s.slice(start))) start++;
  if (/[\ud800-\udbff]$/.test(s.slice(start, end))) end--;
  return (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : "");
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

/**
 * --since and --until, each a calendar day (both inclusive). A range that ends before it starts holds no day:
 * a mistake in the command, never an answer of "nothing in the range".
 * @param {Record<string, string | true>} opts
 */
function dateRange(opts) {
  const since = dateOpt(opts.since, "since");
  const until = dateOpt(opts.until, "until");
  // Four-digit years: the strings sort as the days do.
  if (since !== undefined && until !== undefined && until < since) throw new UsageError(`--until ${until} is before --since ${since}`);
  return { since, until };
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
 * What mutate says about a file's other names: a write-back through them, a file that needed none, or a mutant's file its
 * path no longer leads to; the names found, and how far the search looked when it did not find them all.
 * @param {import("../metrics/mutation.mjs").LinkNotice} l @param {string} lang
 */
function linkNotice(l, lang) {
  const lines = [t({ through: "mutate.linked", already: "mutate.linkedAlready", elsewhere: "mutate.linkedElsewhere" }[l.how], { file: l.file, id: l.id }, lang)];
  if (l.names.length) lines.push(tShown("mutate.linkedNames", { names: l.names }, lang));
  if (l.unfound) {
    const more = (l.capped ? t("mutate.linkedCapped", {}, lang) : "") + (l.unread ? t("mutate.linkedUnread", { n: l.unread }, lang) : "");
    lines.push(t("mutate.linkedUnfound", { n: l.unfound, looked: l.looked, trees: l.trees, more: { shown: more } }, lang));
  }
  return lines.join("\n");
}

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
    // Where the command started: a folder below the top that the work tree tracks nothing in is no project of its own.
    const res = scanProject({ cwd, from: process.cwd() });
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
    /** What was not measured and why, in the project's language. @param {{ path?: string, reason: string, name?: string, n?: number }[]} list */
    const why = (list) => ({ shown: list.map((u) => tShown(`scan.why.${u.reason}`, { path: [u.path ?? ""], name: u.name ?? "", n: u.n ?? 0 }, lang)).join("; ") });
    if (!res.config.path) say("scan.configNone");
    else if (res.config.problems.length) say("scan.configProblems", { path: [res.config.path], problems: res.config.problems.join("; ") });
    else say("scan.configOk", { path: [res.config.path] });
    say(res.graph.exists ? "scan.graphOk" : "scan.graphNone", { path: [res.graph.path] });
    // Whether /ennyn:init takes the new-project path, and, outside a repository, its git init.
    const fresh = res.newProject;
    if (fresh.within) say(res.repository ? "scan.newWithin" : "scan.newWithinUnread", { path: [fresh.within] });
    else if (fresh.found.length) say(fresh.more ? "scan.newNoMore" : "scan.newNo", { list: { shown: fresh.found.map(name).join(", ") }, n: fresh.more });
    else if (res.unmeasured.newProject) say("scan.newUnmeasured", { reason: why(res.unmeasured.newProject) });
    else say("scan.newYes");
    if (fresh.gitInit) say("scan.gitInit");
    else if (fresh.noGitInit) say("scan.noGitInit", { reason: why([fresh.noGitInit]) });
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
    // The rules for what leaves the machine, by where each is held; a file that gives no rule is said as unmeasured.
    const held = { shared: "scan.askShared", uncommitted: "scan.askUncommitted", local: "scan.askLocal", unknown: "scan.askUnknown", none: "scan.askNone" };
    const askParts = Object.entries(held).flatMap(([where, key]) => {
      const rules = ag.ask.rules.filter((r) => (r.where ?? "none") === where).map((r) => r.rule);
      return rules.length ? [tShown(key, { rules: capped(rules) }, lang)] : [];
    });
    if (ag.ask.unread.length) askParts.push(tShown("scan.askUnread", { list: ag.ask.unread }, lang));
    if (!ghApplies({ github: ag.ask.githubRemotes, others: ag.ask.otherRemotes })) askParts.push(t("scan.askNoGithub", {}, lang));
    say("scan.ask", { list: { shown: askParts.join(" · ") } });
    say("scan.offered", { destroys: ag.offered.destroys.length, installs: ag.offered.installs.length });
    const unreadable = [...res.unreadable, ...ag.unreadable];
    if (unreadable.length) say("scan.unreadable", { list: unreadable });
    if (res.outside.length) say("scan.outside", { list: res.outside });
    return 0;
  },

  "install-hook"(args) {
    const { opts, help } = parseArgs(args, { options: ["plugin-data"] });
    if (help) return (out(USAGE), 0);
    // An unset ${CLAUDE_PLUGIN_DATA} reaches here empty: a hook written without it would name this version only.
    const pluginData = opts["plugin-data"] === undefined ? null : strOpt(opts["plugin-data"]);
    if (opts["plugin-data"] !== undefined && (pluginData === null || !isAbsolute(pluginData))) throw new UsageError("--plugin-data needs the plugin's data directory as an absolute path (${CLAUDE_PLUGIN_DATA})");
    const cwd = projectDir();
    const cfg = config(cwd);
    let res;
    try {
      // A plugin session names its data directory and its version to its commands (adapters/claude-code/hooks/plugin-root.mjs).
      res = installHook({ cwd, cliPath: fileURLToPath(import.meta.url), pluginData, session: sessionOf(process.env) });
    } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      err(t("hook.notRecorded", { error: e.message }, cfg.language));
      return 1;
    }
    if (res.restored) out(t("hook.restored", { data: res.data ?? "", root: res.recorded }, cfg.language));
    const key = res.result === "hooksPath" ? `hook.hooksPath.${res.hooksKind}${res.block ? "Block" : ""}` : res.result === "blockUnread" && !res.block ? "hook.blockUnreadPlain" : `hook.${res.result}`;
    out(t(key, { path: res.path, dir: res.hooksPath ?? "", line: res.line, cli: res.cli ?? "", chmod: res.chmod, own: res.own, root: res.root, data: res.data ?? "", recorded: res.recorded }, cfg.language));
    // The block for the project's own hook, as it is pasted: after the message that says where.
    if (res.block) out(res.block);
    if (res.data !== null && ["installed", "updated", "unchanged"].includes(res.result)) out(t("hook.follows", { data: res.data }, cfg.language));
    // What it wrote, by its bytes, so uninstall-hook removes it only while it is unchanged.
    if (["installed", "updated", "unchanged"].includes(res.result)) {
      try {
        recordWrite(cwd, writtenPath(cwd, cfg.paths.stateDir), res.path, "install-hook");
      } catch (e) {
        err(t("hook.writtenUnrecorded", { path: res.path, error: /** @type {Error} */ (e).message }, cfg.language));
        return 1;
      }
    }
    // What doctor warns about is no "nothing to do": a hook left as it is, or one that checks nothing, exits 1.
    return ["installed", "updated", "unchanged", "wired"].includes(res.result) ? 0 : 1;
  },

  "uninstall-hook"(args) {
    const { opts, help } = parseArgs(args, { options: ["plugin-data"] });
    if (help) return (out(USAGE), 0);
    const pluginData = opts["plugin-data"] === undefined ? null : strOpt(opts["plugin-data"]);
    if (opts["plugin-data"] !== undefined && (pluginData === null || !isAbsolute(pluginData))) throw new UsageError("--plugin-data needs the plugin's data directory as an absolute path (${CLAUDE_PLUGIN_DATA})");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const res = uninstall({ cwd, cfg, data: pluginData ?? sessionOf(process.env)?.data ?? null });
    for (const f of res.files) out(t(`uninstall.file.${f.result}`, { path: f.path }, lang));
    const h = res.hook;
    if (h.result === "wired") {
      const lines = h.lines.map((l) => (l.from === l.to ? `${l.from}` : `${l.from}-${l.to}`)).join(", ");
      out(t(h.lines.length ? "uninstall.hook.wired" : "uninstall.hook.wiredNoLine", { path: h.own ?? h.path, lines }, lang));
    } else if (h.result !== "none" || !res.files.length) out(t(`uninstall.hook.${h.result}`, { path: h.path }, lang));
    out(t(`uninstall.state.${res.state.result}`, { path: res.state.path, list: res.state.journals }, lang));
    const s = res.stays;
    const items = [
      ...s.files.map((p) => shown(p, { name: true }).text),
      ...(s.ask.length ? [t("uninstall.staysAsk", { rules: s.ask }, lang)] : []),
      ...(s.planClear ? [t("uninstall.staysPlanClear", {}, lang)] : []),
      ...(s.settingsUnread ? [t("uninstall.staysSettingsUnread", {}, lang)] : []),
    ];
    if (items.length) {
      out(t("uninstall.stays", {}, lang));
      for (const i of items) out(`  ${i}`);
    }
    if (s.record !== null) out(t("uninstall.staysRecord", { path: s.record }, lang));
    // Something Ennyn would remove that stays, or the state dir left: the user's hand is needed.
    const left = res.files.some((f) => f.result !== "removed" && f.result !== "gone") || h.result === "wired" || h.result === "unrecorded" || !["removed", "none"].includes(res.state.result);
    return left ? 1 : 0;
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
      const replaced = replacedAt(records.filter((r) => r.budget), head);
      const kept = records.filter((r) => r !== replaced);
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
    // Only a security audit reads the paths; a git that fails stops the command, as everywhere. Links and gitlinks
    // by their mode in the index: a link is listed, never followed.
    const index = due.due === false ? null : indexEntries(cwd);
    const paths = index ? sensitivePaths(index.files, cfg, { ...own, links: index.links, gitlinks: index.gitlinks }) : [];
    const code = due.due === null ? 1 : 0;
    // Names a terminal would act on (direction overrides, C1 controls, line separators) as \u escapes: still JSON.
    if (opts.json) return (out(jsonShown({ slot: due.due === false ? "feature" : "security", ...due, log: cfg.paths.metricsLog, paths })), code);
    const lang = cfg.language;
    // The log's name as the config gives it, and an error's text, shown on one line (tShown).
    const vars = { every: due.every, cycles: due.cycles, since: due.since ?? 0, left: due.every - (due.since ?? 0) - 1, path: [cfg.paths.metricsLog], error: due.error ?? "" };
    if (due.due === false) out(t(due.reason === "off" ? "audit.off" : "audit.feature", vars, lang));
    else out(t("audit.security", { why: tShown(due.error ? "audit.why.error" : `audit.why.${due.reason}`, vars, lang) }, lang));
    // Lines that do not parse count as cycles, so the answer leans to due; budget and doctor say them too.
    if (due.skipped && due.reason !== "off") out(tShown("audit.skipped", { n: due.skipped, path: [cfg.paths.metricsLog] }, lang));
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
          const links = p.rules.filter((r) => r === LINK_RULE).length;
          if (links) out(t("audit.links", { n: links, rule: LINK_RULE }, lang));
          const submodules = p.rules.filter((r) => r === SUBMODULE_RULE).length;
          if (submodules) out(t("audit.submodules", { n: submodules, rule: SUBMODULE_RULE }, lang));
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
    // Every git call the check makes reads objects as they are, and fetches none a partial clone lacks.
    Object.assign(process.env, HOOK_READ_ENV, opts.hook ? HOOK_INDEX_ENV : {});
    let cwd;
    try {
      // Before any gate: past this, the repository the hook asks is the one git commits in.
      const place = opts.hook ? hookElsewhere(process.cwd(), process.env) : null;
      if (place) return (err("untold" in place ? tShown("cli.hookWhereUntold", { error: place.untold }, "en") : t("cli.hookElsewhere", {}, "en")), 1);
      cwd = projectDir();
    } catch (e) {
      // From the commit-msg hook a git that fails lets the commit through, saying so.
      if (!opts.hook) throw e;
      const error = /** @type {Error & { stderr?: unknown }} */ (e);
      err(t("cli.hookGitFailed", { error: String(error.stderr ?? error.message).trim().split("\n")[0] }, "en"));
      return 0;
    }
    // One reading of the config for the whole check, the commit's own (commitConfig).
    let read;
    try {
      read = commitConfig({ cwd, env: process.env, hook: Boolean(opts.hook) });
    } catch (e) {
      // From the commit-msg hook a config no version of which loads must not lock every commit, the one that fixes it
      // included, and a git that fails lets the commit through, as anywhere. Anything else is no verdict on the config,
      // and passing here would pass every later commit unread: refused, in words of its own, as no commit can repair a
      // file git does not hold.
      if (!opts.hook) throw e;
      if (e instanceof ConfigPicked) {
        /** @type {string[]} */
        const refused = [];
        gateFailed(e.cause, "en", refused, t("cli.everyGate", {}, "en"), "cli.configUnmeasured");
        for (const line of refused) err(line);
        return 1;
      }
      const error = masked(oneLine(/** @type {Error} */ (e).message));
      if (e instanceof ConfigUnread) return (err(tShown("cli.hookConfigUnread", { git: masked(e.git), error }, "en")), 0);
      if (e instanceof ConfigError) return (err(tShown("cli.hookConfigBroken", { error }, "en")), 0);
      return (err(tShown("cli.hookConfigRefused", { path: process.env.ENNYN_CONFIG || CONFIG_PATH, error }, "en")), 1);
    }
    const cfg = read.cfg;
    // The message as git gave it. The hook that cannot read it (a file too long to be a string, one that is gone) still
    // runs every gate on what the commit brings, and weighs the message's own checks below; by hand the command fails.
    /** @type {string | null} */
    let message = null;
    /** @type {unknown} */
    let messageUnread = null;
    try {
      message = readFileSync(positional[0], "utf8");
    } catch (e) {
      if (!opts.hook) return (err(t("cli.cannotRead", { path: positional[0], error: oneLine(/** @type {Error} */ (e).message) }, cfg.language)), 1);
      messageUnread = e;
    }
    // An ENNYN_CONFIG naming no file, with no config tracked: the defaults would check another project's rules, so
    // the hook says nothing was checked.
    if (opts.hook && read.absent) return (err(t("cli.hookConfigAbsent", { path: String(process.env.ENNYN_CONFIG) }, "en")), 0);
    for (const s of read.said) {
      const text = tShown(s.key, s.vars, cfg.language);
      if (!opts.hook && s.fails) throw new Error(text);
      err(text);
    }
    // Whether the commit loosens a gate holds for every message, the bypass marker and a skipped subject too, and is
    // said now: nothing a gate below does can skip it. The approval line is read on the narrowest reading of what git
    // may store, comment lines out and cut at a scissors line: `--cleanup=` and `-v` reach no hook, and a line that may
    // not be stored must not count. A line that would have stayed costs moving it, and nothing else.
    // How git will clean the message, read once for the loosening check and the message's own. A failure is said by the
    // shape check below; run by hand it fails the command there.
    /** @type {ReturnType<typeof hookCommitMode> | null} */
    let mode = null;
    /** @type {unknown} */
    let modeError = null;
    if (message !== null) {
      try {
        mode = hookCommitMode({ cwd, message, env: process.env });
      } catch (e) {
        modeError = e;
      }
    }
    let loosens = false;
    if (read.keys.length) {
      /** @type {string[]} */
      let refused;
      // A message not read holds no approval line.
      if (message === null) refused = looseningErrors(read.keys, "", cfg.language);
      else if (mode) refused = looseningErrors(read.keys, storedMessage(message, "strip", mode.comment, true), cfg.language);
      else {
        // With the marker unknown no line can be told from a comment git drops.
        const error = oneLine(String(/** @type {Error & { stderr?: unknown }} */ (modeError).stderr || /** @type {Error} */ (modeError).message));
        refused = [tShown("shape.looseningNoComment", { keys: read.keys.join(", "), error, line: LOOSENING_LINE }, cfg.language)];
      }
      for (const e of refused) err(e);
      loosens = refused.length > 0;
    }
    /** What a gate could not read of what the commit brings, for a reason its content can pick: each refuses it (gateFailed). */
    /** @type {string[]} */
    const unchecked = [];
    /** @type {string[]} */
    let staged = [];
    /** Staged names that are not UTF-8: git cannot be asked for them by name. */
    /** @type {string[]} */
    let notUtf8 = [];
    /** Staged names the commit deletes. */
    /** @type {Set<string>} */
    let deleted = new Set();
    /** Staged names the commit adds. */
    /** @type {Set<string>} */
    let addedNames = new Set();
    try {
      // Outside a repository nothing is staged: the message is all there is to check.
      if (repoPath("--git-dir", { cwd }) !== null) {
        const listed = stagedNames(cwd, { env: process.env });
        ({ paths: staged, notUtf8, deleted, added: addedNames } = listed);
        if (listed.deletedUnread) err(t("cli.stagedDeletedUnread", { mb: NAMES_BUFFER / 1024 / 1024 }, cfg.language));
      }
    } catch (e) {
      if (!opts.hook) throw e;
      gateFailed(e, cfg.language, unchecked, t("cli.everyGate", {}, cfg.language), "cli.stagedUnmeasured");
    }
    /** What the commit adds or changes: a read of anything else is context (gateFailed). */
    const bringing = new Set(staged.filter((p) => !deleted.has(p)));
    const brings = (/** @type {string} */ p) => bringing.has(p);
    const shownNames = (/** @type {string[]} */ list) => list.slice(0, 3).map((p) => shown(masked(p), { name: true }).text).join(", ");
    /**
     * Both versions of `paths` for a gate: what cannot be read is held to its names and weighed by each name (gateFailed),
     * a line for each kind of failure. Read by hand, any failure fails the command. A name not read is not in the map.
     * @param {string[]} paths @param {string} gate @param {string} key
     */
    const gateRead = (paths, gate, key) => {
      const { versions, unaskable, failed } = stagedVersionsEach(cwd, paths, { env: process.env });
      /** @type {Map<string, { path: string, error: unknown }[]>} */
      const kinds = new Map();
      for (const lost of [...unaskable.map((path) => ({ path, error: /** @type {unknown} */ (new Error(t("cli.ciCalleesNoName", {}, cfg.language))) })), ...failed]) {
        if (!opts.hook) throw lost.error;
        const kind = `${brings(lost.path)} ${machineFault(lost.error)}`;
        const group = kinds.get(kind);
        if (group) group.push(lost);
        else kinds.set(kind, [lost]);
      }
      for (const group of kinds.values()) gateFailed(group[0].error, cfg.language, unchecked, gate, key, { paths: shownNames(group.map((l) => l.path)) }, brings(group[0].path));
      return versions;
    };
    // The config holds every rule's text: it names the literal without breaking the rule.
    const exempt = cfg.configPath ? [relative(cwd, cfg.configPath).split(sep).join("/")] : [];
    // The lines review.forbidden reads: those of the staged paths a rule names. Unread, the hook says so and the
    // rest of the check still runs; run by hand, the command fails.
    /** @type {Map<string, import("../core/git.mjs").AddedLine[]> | undefined} */
    let addedLines;
    /** Files that look like UTF-16 or UTF-32 and could not be read whole to be decoded, with why. */
    /** @type {Map<string, string>} */
    const wideUnread = new Map();
    const ruled = staged.filter((p) => brings(p) && !exempt.includes(p) && cfg.review.forbidden.some((/** @type {{ paths: string[] }} */ r) => matchAny(p, r.paths)));
    // A name that is not UTF-8 may read the same as another staged name: neither is asked for, both are said.
    const unnamed = [...new Set(ruled.filter((p) => notUtf8.includes(p) && cfg.review.forbidden.some((/** @type {{ paths: string[], except?: string[] }} */ r) => matchAny(p, r.paths) && !matchAny(p, r.except ?? []))))];
    if (unnamed.length) {
      const said = t("cli.forbiddenNamesUnread", { n: unnamed.length, paths: namesShown(unnamed) }, cfg.language);
      if (!opts.hook) throw new Error(said);
      unchecked.push(said);
    }
    const named = ruled.filter((p) => !notUtf8.includes(p));
    if (named.length) {
      // From the hook a diff call that fails or is stopped loses its own paths, said; by hand the command fails.
      /** @type {Map<string, string>} */
      const unread = new Map();
      try {
        addedLines = stagedAddedLines(cwd, named, { env: process.env, wideUnread, ...(opts.hook ? { unread } : {}) });
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "review.forbidden", "cli.forbiddenUnmeasured");
      }
      for (const [why, paths] of byReason(unread)) err(t("cli.forbiddenReadFailed", { n: paths.length, paths: namesShown(paths), error: why }, cfg.language));
    }
    // security.secrets: every file and name the commit adds, except as the commit's own config holds it, read
    // apart from review.forbidden and before the message: what the files bring stands when the message check fails.
    const secrets = await secretScan(cwd, cfg, read.headExcept, notUtf8, Boolean(opts.hook), bringing.size > 0);
    for (const said of secrets.said) err(said);
    // CI files (security.ci): the uses, triggers and permissions the commit brings, against HEAD's version. The
    // files under the directories `security.ci.paths` names are read with the staged ones, and every local callee
    // their `uses` name, by path: a caller's change can reach a reusable workflow or an action it calls. Reading
    // that context can fail, or stop at a depth, without turning the check of the staged files off: what it could
    // not read is said. Like review.forbidden it holds for every message, and what git cannot give is said, never
    // passed as clean; a text the commit brings that the reading cannot take is refused, file by file (checks/ci.mjs).
    // The staged list tells what the commit brings from what it leaves or deletes, so each failure is weighed by that.
    const ciRule = cfg.security.ci;
    const isCi = (/** @type {string} */ p) => matchAny(p, ciRule.paths) && !matchAny(p, ciRule.except);
    /** @type {{ errors: string[], warnings: string[] }} */
    let ci = { errors: [], warnings: [] };
    if (staged.some(isCi)) {
      try {
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
          gateFailed(e, cfg.language, unchecked, "security.ci", "cli.ciCallersUnread", {}, false);
        }
        const all = [...new Set([...staged.filter(isCi), ...callers.paths.filter(isCi)])];
        const ciUnnamed = all.filter((p) => notUtf8.includes(p) || callers.notUtf8.includes(p));
        // A name git cannot be asked for fails a hand run when the commit brings it; one it leaves alone or deletes is said.
        const stagedUnnamed = ciUnnamed.filter(brings);
        const trackedUnnamed = ciUnnamed.filter((p) => !brings(p));
        if (stagedUnnamed.length) {
          const said = t("cli.ciNamesUnread", { n: stagedUnnamed.length, paths: shownNames(stagedUnnamed) }, cfg.language);
          if (!opts.hook) throw new Error(said);
          unchecked.push(said);
        }
        if (trackedUnnamed.length) err(t("cli.ciTrackedUnread", { n: trackedUnnamed.length, paths: shownNames(trackedUnnamed) }, cfg.language));
        const versions = gateRead(all.filter((p) => !ciUnnamed.includes(p)), "security.ci", "cli.ciFilesUnread");
        // Callees by path, a level a round, each new file parsed once; a candidate in neither the index nor HEAD is
        // no file. Past CALLEE_ROUNDS levels, or when a read fails, what is left is said (ciSet names it missing):
        // every CI file the commit brings is in `versions` already, so a callee asked for here is context.
        const tried = new Set(versions.keys());
        let fresh = new Map(versions);
        for (let round = 0; fresh.size && round < CALLEE_ROUNDS; round++) {
          const want = ciCallees(fresh).filter((p) => isCi(p) && !tried.has(p));
          fresh = new Map();
          if (!want.length) break;
          for (const p of want) tried.add(p);
          // A candidate costs only itself: one that cannot be read is named, and the round reads on.
          for (const [p, v] of gateRead(want, "security.ci", "cli.ciCalleesUnread")) if (v.staged || v.head || v.unread || v.headUnread) versions.set(p, v), fresh.set(p, v);
        }
        ci = ciMessages(versions, cfg.language);
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "security.ci", "cli.ciUnmeasured", {}, staged.some((p) => isCi(p) && brings(p)));
      }
    }
    // Lock files and .npmrc (security.deps): what the commit brings, against HEAD's version. Like review.forbidden
    // it holds for every message; what the registry does not answer is said, never passed as clean.
    const depsRule = cfg.security.deps;
    /** @type {{ errors: string[], warnings: string[] }} */
    let deps = { errors: [], warnings: [] };
    let stagedLocks = staged.filter((p) => lockPath(p, depsRule.paths));
    // An .npmrc counts where npm reads it for the project: at the top, or next to a lock file the paths name.
    const npmrcs = depsRule.paths.length ? staged.filter(npmrcPath) : [];
    let readNpmrc = npmrcs.filter((p) => dirOf(p) === "" || stagedLocks.some((l) => dirOf(l) === dirOf(p)));
    const besideNone = npmrcs.filter((p) => !readNpmrc.includes(p));
    // A package.json holds dependency specs npm may fetch from (the root's, a workspace's, a linked folder's): a
    // staged one outside node_modules brings in every lock the index holds at or above its folder.
    const pkgs = depsRule.paths.length ? staged.filter((p) => pkgJsonPath(p) && !p.split("/").includes("node_modules")) : [];
    const above = (/** @type {string} */ lock, /** @type {string} */ p) => dirOf(lock) === "" || dirOf(p) === dirOf(lock) || dirOf(p).startsWith(`${dirOf(lock)}/`);
    if (besideNone.length || pkgs.length) {
      try {
        const dirs = [...new Set(besideNone.map(dirOf))];
        const listed = indexNames(cwd, { env: process.env, paths: pkgs.length || dirs.includes("") ? [] : dirs }).paths;
        readNpmrc = [...readNpmrc, ...besideNone.filter((p) => listed.some((l) => dirOf(l) === dirOf(p) && lockPath(l, depsRule.paths)))];
        stagedLocks = [...new Set([...stagedLocks, ...listed.filter((l) => lockPath(l, depsRule.paths) && pkgs.some((p) => above(l, p)))])];
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "security.deps", "cli.depsUnmeasured", {}, false);
      }
    }
    const depsPaths = [...new Set([...stagedLocks, ...stagedLocks.map((l) => (dirOf(l) ? `${dirOf(l)}/package.json` : "package.json")), ...readNpmrc])];
    // A name git cannot be asked for that the commit deletes holds nothing to judge.
    const depsUnnamed = depsPaths.filter((p) => notUtf8.includes(p) && brings(p));
    if (depsUnnamed.length) {
      // Shown as a report shows a name: a direction mark or a control character in it is escaped.
      const said = tShown("cli.depsNamesUnread", { n: depsUnnamed.length, paths: depsUnnamed.slice(0, 3) }, cfg.language);
      if (!opts.hook) throw new Error(said);
      unchecked.push(said);
    }
    const depsNamed = depsPaths.filter((p) => !notUtf8.includes(p));
    if (depsNamed.length) {
      /** gateRead, where a file not read stands as unread on both sides: never as no file, no package.json as no dependency. @param {string[]} paths */
      const depsRead = (paths) => {
        const read = gateRead(paths, "security.deps", "cli.depsFilesUnread");
        for (const p of paths) if (!read.has(p)) read.set(p, { staged: null, head: null, unread: "failed", headUnread: "failed" });
        return read;
      };
      const versions = depsRead(depsNamed);
      // The .npmrc beside a staged lock the commit leaves alone names the registry npm asks for an entry with no
      // resolved URL: read from the index, and only when such an entry asks for it.
      const beside = (/** @type {string} */ dir) => npmrcHeld(cwd, dir, process.env);
      const kinds = (/** @type {string[]} */ paths) => indexKinds(cwd, paths, { env: process.env });
      // The package.json files a lock names in folders of their own (workspaces, links' targets), read from the
      // index in one go.
      const pkgRead = (/** @type {string[]} */ paths) => {
        const read = depsRead(paths);
        return new Map(paths.map((p) => {
          const v = read.get(p);
          return [p, { staged: pkgJson(v?.staged ?? null, v?.unread ? { key: v.unread } : undefined), head: pkgJson(v?.head ?? null, v?.headUnread ? { key: v.headUnread } : undefined) }];
        }));
      };
      try {
        deps = await depsMessages(versions, depsRule, cfg.language, { beside, kinds, pkgRead });
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "security.deps", "cli.depsUnmeasured", {}, depsNamed.some(brings));
      }
    }
    // review.forbidden and the secrets the message holds are about content, not the message's shape: each runs apart
    // from it, so no throw of the shape check below skips them.
    /** @type {{ errors: string[], warnings: string[] }} */
    let forbidden = { errors: [], warnings: [] };
    if (addedLines) {
      try {
        forbidden = forbiddenResult(addedLines, cfg, exempt, wideUnread);
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "review.forbidden", "cli.forbiddenUnmeasured");
      }
    }
    /** @type {string[]} */
    let messageSecrets = [];
    if (message !== null) {
      try {
        // With how git cleans it unknown, the message is read whole: a superset of what any cleanup stores.
        messageSecrets = secretErrors({ config: cfg, message, comment: mode ? mode.comment : null, cut: mode?.cut ?? false });
      } catch (e) {
        if (!opts.hook) throw e;
        gateFailed(e, cfg.language, unchecked, "security.secrets", "cli.messageSecretsUnmeasured");
      }
    }
    const privateText = privateTextErrors({ cwd, cfg, hook: Boolean(opts.hook), staged, notUtf8, brings, addedNames, message, mode, unchecked, gateRead });
    /** @type {{ ok: boolean, errors: string[], warnings?: string[] }} */
    let res = { ok: true, errors: [] };
    if (message === null) {
      // The message's own checks cannot run: weighed as a gate's read (gateFailed), said for a fault of the machine,
      // refused for a failure the message itself can pick. One too long to be a string is refused in words of its own
      // that name a way out: a verbose commit of a large change puts its whole diff in the file.
      const code = /** @type {{ code?: unknown } | null} */ (messageUnread)?.code;
      if (code === "ERR_STRING_TOO_LONG" || code === "ERR_FS_FILE_TOO_LARGE") unchecked.push(t("cli.hookMessageTooLong", { path: positional[0], error: oneLine(String(/** @type {Error} */ (messageUnread).message)) }, cfg.language));
      else gateFailed(messageUnread, cfg.language, unchecked, t("cli.messageGate", {}, cfg.language), "cli.hookMessageUnreadable", { path: positional[0], paths: positional[0] });
    } else {
      try {
        if (!mode) throw modeError;
        const { cleanup, comment, cut } = mode;
        const fold = foldTarget(cwd, message, cleanup, comment, cut);
        if (fold.missed) err(t("cli.foldNotFound", { subject: fold.subject, where: t(`cli.foldWhere.${fold.missed}`, {}, cfg.language) }, cfg.language));
        res = shapeOf(message, { config: cfg, stagedPaths: staged, cleanup, cut, comment, foldTarget: fold.target });
      } catch (e) {
        // The shape alone: a git that fails is no reason to lock commits, so the hook says it was not checked. Every gate
        // on what the commit brings, the message's secrets among them, ran apart from it.
        if (!opts.hook) throw e;
        const error = /** @type {Error & { stderr?: unknown }} */ (e);
        err(t("cli.hookMessageUnchecked", { error: masked(typeof error.stderr === "string" ? error.stderr.trim().split("\n")[0] : error.message) }, cfg.language));
      }
    }
    for (const e of [...unchecked, ...ci.errors, ...deps.errors, ...secrets.errors, ...forbidden.errors, ...messageSecrets, ...privateText, ...res.errors]) err(e);
    for (const w of [...(res.warnings ?? []), ...forbidden.warnings, ...ci.warnings, ...deps.warnings]) err(w);
    return res.ok && !loosens && !unchecked.length && !ci.errors.length && !deps.errors.length && !secrets.errors.length && !forbidden.errors.length && !messageSecrets.length && !privateText.length ? 0 : 1;
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
    /** @type {(import("../checks/deps.mjs").LockEntry & { path: string })[]} */
    const specs = [];
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
      // The package.json files npm reads for dependency specs, as the work tree holds them, regular files only.
      /** @param {string} folder @returns {import("../checks/deps.mjs").Pkg} */
      const pkgAt = (folder) => {
        const at = pkgPathOf(path, folder);
        try {
          return pkgJson(readRegular(cwd, resolve(cwd, at)));
        } catch (e) {
          return { unread: { key: "readFailed", vars: { error: oneLine(/** @type {Error} */ (e).message) } } };
        }
      };
      const lock = lockEntries(text, { pkg: pkgAt(""), folders: pkgAt });
      if (lock.unread !== undefined) unreadFiles.push({ path, reason: lock.unread });
      else {
        // One line for each entry, however many places in the tree hold it.
        const seen = new Set();
        for (const e of lock.entries) {
          const k = `${e.name}@${e.version} ${e.resolved ?? ""} ${e.integrity ?? ""}`;
          if (!seen.has(k)) seen.add(k), entries.push({ ...e, path });
        }
        append(links, lock.links.map((e) => ({ ...e, path })));
        // Dependency specs npm may fetch from: judged by their source only, never counted as entries or asked of OSV;
        // a package.json it cannot read is unmeasured.
        append(specs, lock.specs.map((e) => ({ ...e, path })));
        for (const u of lock.pkgUnread) unreadFiles.push({ path: pkgPathOf(path, u.folder), reason: u.reason });
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
      append(npmrcLines, [...f.refuse.map((r) => ({ path, line: `${r.n}: ${r.line}`, kind: r.kind })), ...f.said.map((x) => ({ path, line: `${x.n}: ${x.line}`, reason: x.reason }))]);
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
      const r = judgeLock([...entries.filter((e) => e.path === path), ...specs.filter((e) => e.path === path)], mine, rule, { lockDir: dir, registryFor, kinds: inRepo ? (paths) => indexKinds(cwd, paths) : undefined });
      for (const [e, j] of r.judged) judged.set(e, j);
      const at = (/** @type {import("../checks/deps.mjs").LockEntry} */ e) => ({ ...e, path });
      // What the judgment could not measure and no advisory query will name: links, and reads that failed.
      append(unmeasuredHere, r.unread.filter((u) => mine.includes(/** @type {any} */ (u.entry)) || ["indexUnread", "noResolvedUnread", "shrinkwrap"].includes(u.reason.key)).map((u) => ({ entry: at(u.entry), reason: u.reason })));
      // What npm installs under an entry that carries its own npm-shrinkwrap.json: that file's, unmeasured.
      append(unmeasuredHere, entries.filter((e) => e.path === path && e.shrinkwrap).map((e) => ({ entry: e, reason: { key: "shrinkwrap" } })));
      append(mismatched, r.refused.mismatch.map((x) => ({ entry: at(x.entry), reason: x.reason })));
      append(refusedSources, [...r.refused.unlisted.map((x) => ({ entry: at(x.entry), reason: x.reason, kind: /** @type {const} */ ("unlisted") })), ...r.refused.git.map((x) => ({ entry: at(x.entry), reason: x.reason, kind: /** @type {const} */ ("git") }))]);
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
      e ? `${e.spec ? `${e.name} ← ${e.spec.from}` : e.version ? `${e.name}@${e.version}` : e.name} (${e.path}${(sources.get(`${e.path}\0${e.name}@${e.version}`)?.size ?? 0) > 1 ? `; ${originOf(e)}` : ""})` : "—";
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
    const { since, until } = dateRange(opts);
    const days = opts.days === undefined ? REWORK_DAYS : intOpt(opts.days, "days");
    // Past 2^53 the number read is not the one written, and 400 digits read as Infinity. (gate-record's --start
    // keeps such a number on purpose: a start in nanoseconds is recorded, undated.)
    if (!Number.isSafeInteger(days)) throw new UsageError(`--days must be a whole number up to ${Number.MAX_SAFE_INTEGER}`);
    const cwd = projectDir();
    const cfg = config(cwd);
    const res = reworkRate({ cwd, since, until, days, config: cfg });
    if (opts.json) return (out(jsonShown({ ...res, days })), 0);
    const lang = cfg.language;
    if (res.rate === null) out(t("rework.none", {}, lang));
    else {
      const pct = `${(res.rate * 100).toFixed(1)}%`;
      out(t("rework.summary", { reworked: res.reworked, commits: res.commits, pct, days }, lang));
      if (res.fixCommits * 2 > res.commits) out(t("rework.fixMajority", { fixes: res.fixCommits, commits: res.commits }, lang));
    }
    if (res.censored) out(t("rework.censored", { n: res.censored, days }, lang));
    if (res.skewed) out(t("rework.skewed", { n: res.skewed }, lang));
    if (res.submoduleFixes) out(t("rework.submoduleFixes", { n: res.submoduleFixes }, lang));
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
    const { since, until } = dateRange(opts);
    // An empty --from (a lost cycle start) must not widen the count to the whole history.
    if (opts.from !== undefined && strOpt(opts.from) === null) throw new UsageError("--from needs a revision");
    const from = strOpt(opts.from) ?? undefined;
    // Objects as the hook reads them: a replace ref must not lay another commit over a loosening.
    Object.assign(process.env, HOOK_READ_ENV);
    const cwd = projectDir();
    const res = bypassUses({ cwd, since, until, from });
    const lang = res.language;
    /** @param {import("../metrics/bypass.mjs").Said} said */
    const text = (said) => t(said.key, said.vars, lang);
    const unread = res.unread.map((u) => ({ hash: u.hash, reason: text(u.reason) }));
    const unmeasured = res.unmeasured.map(text);
    // What could not be compared is no "none loosened".
    const code = unread.length || unmeasured.length ? 1 : 0;
    if (opts.json) return (out(jsonShown({ ...res, unread, unmeasured })), code);
    if (res.shallow) out(t("bypass.shallow", {}, lang));
    for (const hash of res.missed) out(t("bypass.foldMissed", { hash: hash.slice(0, 10) }, lang));
    for (const said of res.unmeasured) out(tShown(said.key, said.vars, lang));
    for (const u of unread) out(tShown("bypass.looseUnread", { hash: u.hash.slice(0, 10), reason: u.reason }, lang));
    if (!res.commits) out(t("bypass.noCommits", {}, lang));
    // The local day, as --since / --until read it. A commit object with no committer time has no day.
    const dayOf = (/** @type {number} */ time) => {
      const d = new Date(time * 1000);
      return Number.isFinite(time) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "—";
    };
    if (res.commits && (res.uses.length || !unmeasured.length)) out(t(res.uses.length ? "bypass.summary" : "bypass.none", { n: res.uses.length, commits: res.commits }, lang));
    // A subject and a reason from history: shown as one line can show them.
    for (const u of res.uses) out(tShown("bypass.item", { hash: u.hash.slice(0, 10), date: dayOf(u.time), subject: u.subject, reason: u.reason || t("bypass.noReason", {}, lang) }, lang));
    // No "none" while anything is unread, and none of a range with no commits to count.
    if (res.loosened.length || (res.commits && !code)) out(t(res.loosened.length ? "bypass.looseSummary" : "bypass.looseNone", { n: res.loosened.length, commits: Math.max(res.commits, res.loosened.length) }, lang));
    for (const l of res.loosened) {
      out(tShown("bypass.looseItem", { hash: l.hash.slice(0, 10), date: dayOf(l.time), subject: l.subject, keys: l.keys.join(", ") }, lang));
      for (const line of l.lines) out(tShown("bypass.looseLine", { line }, lang));
      if (l.unapproved.length) out(tShown("bypass.looseMissing", { keys: l.unapproved.join(", ") }, lang));
    }
    return code;
  },

  leftovers(args) {
    const { opts, help } = parseArgs(args, { flags: ["start", "json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    if (opts.start) {
      const r = recordStart({ cwd, config: cfg });
      if (opts.json) return (out(jsonShown(r)), 0);
      out(tShown("leftovers.started", { path: r.path, head: r.head.slice(0, 10), n: r.untracked, m: r.changed }, lang));
      if (r.replaced) out(tShown("leftovers.replaced", { head: r.replaced.head.slice(0, 10), at: r.replaced.at }, lang));
      if (r.unread.length) out(tShown("leftovers.unread", { n: r.unread.length, path: r.unread[0] }, lang));
      return 0;
    }
    const res = leftovers({ cwd, config: cfg });
    const { untracked, uncommitted } = res;
    const code = untracked.state === "clean" && uncommitted.state === "clean" ? 0 : 1;
    const why = untracked.why ? t(untracked.why.key, untracked.why.vars, lang) : "";
    if (opts.json) return (out(jsonShown({ ...res, untracked: { ...untracked, why: why || undefined } })), code);
    if (res.start) out(t("leftovers.since", { head: res.start.head.slice(0, 10), at: res.start.at }, lang));
    if (res.byPath) out(t("leftovers.byPath", {}, lang));
    if (res.unread.length) out(tShown("leftovers.unread", { n: res.unread.length, path: res.unread[0] }, lang));
    /** @param {string[]} lines */
    const list = (lines) => {
      for (const line of lines.slice(0, LEFTOVERS_SHOWN)) out(line);
      if (lines.length > LEFTOVERS_SHOWN) out(t("leftovers.more", { n: lines.length - LEFTOVERS_SHOWN }, lang));
    };
    out(tShown(`leftovers.untracked.${untracked.state}`, { n: untracked.items.length, why }, lang));
    const kind = (/** @type {{ path: string, committed?: true }} */ i) => (i.path.endsWith("/") ? "Folder" : "") + (i.committed ? "Swept" : "");
    list(untracked.items.map((i) => tShown(`leftovers.item${kind(i)}`, { path: i.path, n: i.files }, lang)));
    out(t(`leftovers.uncommitted.${uncommitted.state}`, { n: uncommitted.items.length }, lang));
    list(uncommitted.items.map((c) => tShown(c.from === undefined ? "leftovers.itemChange" : "leftovers.itemMoved", { code: { shown: c.code }, path: c.path, from: c.from ?? "" }, lang)));
    return code;
  },

  journal(args) {
    const [verb, ...rest] = args;
    if (verb === undefined || verb === "-h" || verb === "--help") return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    /** @type {Record<string, unknown>} */
    let event;
    if (verb === "start") {
      const { opts } = parseArgs(rest, { options: ["cycle", "release", "findings", "tasks"] });
      const tasks = strOpt(opts.tasks);
      event = { ev: "start", cycle: intOpt(opts.cycle, "cycle"), release: strOpt(opts.release), findings: strOpt(opts.findings), tasks: tasks ? tasks.split(",") : [] };
    } else if (verb === "task") {
      const { positional, opts } = parseArgs(rest, { positional: 1, options: ["node", "worktree", "step", "round"] });
      if (!positional[0]) throw new UsageError("journal task needs a task id");
      event = { ev: "task", id: positional[0] };
      for (const k of ["node", "worktree", "step"]) if (opts[k] !== undefined) event[k] = strOpt(opts[k]) ?? "";
      if (opts.round !== undefined) event.round = intOpt(opts.round, "round");
    } else if (verb === "wait") {
      const { positional, opts } = parseArgs(rest, { positional: 1, flags: ["clear"] });
      if (Boolean(opts.clear) === Boolean(positional[0])) throw new UsageError("journal wait takes the text that waits for the user, or --clear");
      event = { ev: "wait", text: opts.clear ? null : positional[0] };
    } else if (verb === "close") {
      parseArgs(rest, {});
      event = { ev: "close" };
    } else throw new UsageError(`journal: unknown event ${inQuotes(verb)}`);
    try {
      const { path, state } = writeEvent({ cwd, config: cfg, event });
      out(tShown("journal.written", { event: verb, cycle: state.cycle, path }, cfg.language));
      return 0;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      err(tShown("journal.refused", { error: e.message }, cfg.language));
      return 1;
    }
  },

  async status(args) {
    const { opts, help } = parseArgs(args, { flags: ["line", "json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const { top, path, state, bad, error } = journalAt({ cwd, config: cfg });
    if (error) return (err(tShown("status.unread", { path, error }, lang)), 1);
    if (!state) {
      if (opts.json) out(jsonShown({ journal: path, cycle: null, bad }));
      else if (!opts.line) out(tShown("status.none", { path }, lang));
      return 0;
    }
    const recordPath = startPath(top, cfg.paths.stateDir);
    let start = null;
    let startWhy = "";
    // A record that cannot be read (a link, a folder, no permission) or holds none leaves HEAD and time unmeasured, not the journal unread.
    try {
      const read = readStart(top, recordPath);
      if (read && "bad" in read) startWhy = `${recordPath} is no start record: ${read.bad}`;
      start = read && "record" in read && read.record.top === top ? read.record : null;
    } catch (e) {
      startWhy = /** @type {Error} */ (e).message;
    }
    const startUnread = () => (err(tShown("status.startUnread", { error: startWhy }, lang)), 1);
    /** @type {{ done: number, total: number } | null} */
    let release = null;
    let releaseWhy = "";
    // A status line asks no graph: a graph module would run at every refresh.
    if (state.release && !opts.line) {
      try {
        const graph = await loadGraph({ cwd, config: cfg });
        const f = cfg.graph.fields;
        const node = [...graph.open, ...graph.done].find((n) => n[f.id] === state.release);
        if (!node) releaseWhy = t("status.releaseMissing", { id: state.release }, lang);
        else {
          const needs = needsOf(node, cfg);
          const done = doneIds(graph, cfg);
          release = { done: needs.filter((n) => done.has(n)).length, total: needs.length };
        }
      } catch (e) {
        releaseWhy = /** @type {Error} */ (e).message;
      }
    }
    const s = statusOf({ state, start, release, now: new Date() });
    const pct = s.percent === null ? "—" : percent(s.percent / 100, lang);
    const time = s.minutes === null ? "—" : `${Math.floor(s.minutes / 60)} h ${s.minutes % 60} min`;
    if (opts.json) return (out(jsonShown({ journal: path, ...s, releaseWhy: releaseWhy || undefined, bad })), startWhy ? startUnread() : 0);
    if (opts.line) {
      // A status line shows a cycle that runs: a closed one, as no journal, prints nothing.
      if (!s.open) return 0;
      const { list, more } = tasksFit(s.tasks, 120);
      out(tShown("status.line", { cycle: s.cycle, landed: s.landed, planned: s.planned, pct, tasks: list + (more ? ` +${more}` : ""), waits: s.waits ? t("status.lineWaits", {}, lang) : "" }, lang));
      return 0;
    }
    out(tShown(s.open ? "status.head" : "status.headClosed", { cycle: s.cycle, landed: s.landed, planned: s.planned, pct, time, head: s.head ? s.head.slice(0, 10) : "—" }, lang));
    if (!s.head && !startWhy) out(t("status.noStart", {}, lang));
    for (const task of s.tasks) out(tShown("status.task", { task: taskWord(task), node: task.node ?? "—", worktree: task.worktree ?? "—" }, lang));
    if (s.waits) out(tShown("status.waits", { text: s.waits }, lang));
    if (release) out(t("status.release", { id: /** @type {string} */ (state.release), done: release.done, total: release.total }, lang));
    else if (state.release) out(tShown("status.releaseUnread", { id: state.release, error: releaseWhy }, lang));
    if (s.findings) out(tShown("status.findings", { path: s.findings }, lang));
    if (bad) out(t("status.bad", { n: bad }, lang));
    out(t("status.data", {}, lang));
    return startWhy ? startUnread() : 0;
  },

  async core(args) {
    const { opts, help } = parseArgs(args, { options: ["value"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const value = opts.value === undefined ? null : strOpt(opts.value);
    if (opts.value !== undefined && value === null) throw new UsageError("--value needs a value word, such as low");
    const cwd = projectDir();
    const cfg = config(cwd);
    const graph = await pickable(cwd, cfg);
    if (!graph) return 1;
    const f = cfg.graph.fields;
    const lang = cfg.language;
    if (value !== null) {
      // Not done and not declined (a declined one left among the nodes is refused above); a number value by its spelling,
      // and a node with no value has none to match.
      const open = byAge(graph.open.filter((n) => n[f.status] !== cfg.graph.doneStatus && n[f.value] !== undefined && n[f.value] !== null && String(n[f.value]) === value), cfg);
      if (opts.json) return (out(jsonShown(open)), 0);
      out(tShown("core.value", { field: f.value, value, n: open.length }, lang));
      for (const n of open) out(tShown(n[f.cluster] === undefined ? "core.valueItem" : "core.valueItemCluster", { id: String(n[f.id]), cost: String(n[f.cost] ?? "?"), cluster: String(n[f.cluster]) }, lang));
      return 0;
    }
    sayHeld(graph, cfg, false);
    const pick = pickOldest(graph, cfg);
    const split = pick !== null && splitFirst(pick.node, cfg);
    // The other slot: the rest of the ready core nodes by value/cost, the first few and every one that ties with the last.
    const rest = readyNodes(graph, cfg).filter((n) => n[f.mechanization] !== true && n !== pick?.node);
    const shown = rest.slice(0, CORE_LIST);
    const last = shown.length ? scoreNode(shown[shown.length - 1], cfg) : null;
    while (shown.length < Math.min(CORE_LIST_MAX, rest.length) && scoreNode(rest[shown.length], cfg) === last) shown.push(rest[shown.length]);
    const more = rest.length - shown.length;
    if (opts.json) return (out(jsonShown({ oldest: pick && { node: pick.node, of: pick.oldest, split }, byScore: shown.map((node) => ({ score: scoreNode(node, cfg), node })), more })), 0);
    if (!pick) return (out(t("core.none", {}, lang)), 0);
    const about = (/** @type {Record<string, unknown>} */ n) => ({ id: String(n[f.id]), value: String(n[f.value] ?? "?"), cost: String(n[f.cost] ?? "?") });
    const of = about(pick.oldest);
    if (pick.node === pick.oldest) out(tShown("core.oldest", about(pick.node), lang));
    else out(tShown("core.oldestNeed", { ...about(pick.node), of: of.id, ofValue: of.value, ofCost: of.cost }, lang));
    if (split) out(tShown("core.split", { cost: about(pick.node).cost, weight: costWeight(pick.node, cfg), above: splitAt(cfg) }, lang));
    if (!shown.length) return (out(t("core.scoreNone", {}, lang)), 0);
    out(t("core.score", {}, lang));
    for (const n of shown) {
      const vars = { id: String(n[f.id]), score: scoreNode(n, cfg).toFixed(2), cluster: String(n[f.cluster]) };
      out(tShown(n[f.cluster] === undefined ? "core.scoreItem" : "core.scoreItemCluster", vars, lang));
    }
    if (more) out(t("core.scoreMore", { n: more }, lang));
    return 0;
  },

  async mechanization(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const graph = await pickable(cwd, cfg);
    if (!graph) return 1;
    const f = cfg.graph.fields;
    const lang = cfg.language;
    sayHeld(graph, cfg, true);
    const ready = readyMechanization(graph, cfg);
    // The slot ranks by how often each node's class recurred lately; a ledger that cannot say is never read as none.
    /** @type {ReturnType<typeof recentRecurrence> | null} */
    let rec = null;
    if (ready.length) {
      let led;
      try {
        led = loadLedger({ cwd, config: cfg });
      } catch (e) {
        err(`✗ ${tShown("findings.unread", { error: String(/** @type {Error} */ (e).message).trim().split("\n")[0] }, lang)}`);
        return (err(t("mechanization.unmeasured", {}, lang)), 1);
      }
      const line = ledgerLine(led);
      if (!led.there) err(`! ${tShown("mechanization.noLedger", { path: [led.path] }, lang)}`);
      else if (line.level !== "ok" || led.reg === null) return (err(`✗ ${tShown(line.key, line.vars, lang)}`), err(t("mechanization.unmeasured", {}, lang)), 1);
      else {
        rec = recentRecurrence(led.rows, led.reg);
        if (rec.names.length) err(`! ${tShown("mechanization.unlinked", { n: rec.names.length, list: rec.names }, lang)}`);
        for (const n of ready) {
          if (n[f.sourceClass] !== undefined && rec.count(n[f.sourceClass]) === null) err(`! ${tShown("mechanization.classUnknown", { id: String(n[f.id]), value: String(n[f.sourceClass]) }, lang)}`);
        }
      }
    }
    const countOf = (/** @type {Record<string, unknown>} */ n) => (rec === null ? null : rec.count(n[f.sourceClass]));
    const node = pickMechanization(graph, cfg, countOf);
    const score = node ? scoreNode(node, cfg) : null;
    const count = node ? countOf(node) : null;
    const window = rec?.cycles.length ? [rec.cycles[0], rec.cycles[rec.cycles.length - 1]] : null;
    if (opts.json) return (out(jsonShown(node ? { node, score, count, cycles: window } : null)), 0);
    if (!node) return (out(t("mechanization.none", {}, lang)), 0);
    const vars = { id: String(node[f.id]), score: Number(score).toFixed(2) };
    if (window === null) out(tShown("mechanization.pick", vars, lang));
    else if (count) out(tShown("mechanization.pickCount", { ...vars, class: String(rec?.entry(node[f.sourceClass])), count, from: window[0], to: window[1], cost: String(node[f.cost] ?? "?") }, lang));
    else out(tShown("mechanization.pickUncounted", { ...vars, from: window[0], to: window[1] }, lang));
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
      if (res.linked) out(linkNotice(res.linked, cfg.language));
      else out(res.restored ? t("mutate.restored", { file: res.restored }, cfg.language) : t(res.found ? "mutate.restoreClean" : "mutate.restoreNone", {}, cfg.language));
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
      // On stderr as it happens, --json too: a run that fails later still said it.
      onLinked: (l) => err(linkNotice(l, lang)),
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
    const { opts, help } = parseArgs(args, { options: ["tested"] });
    if (help) return (out(USAGE), 0);
    // A hash, as `git rev-parse HEAD` printed it before the whole test ran: a name could move under it.
    if (opts.tested !== undefined && !/^[0-9a-f]{7,64}$/i.test(String(opts.tested))) throw new UsageError("--tested takes the commit's hash");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const n = unpushedCount(cwd);
    const max = cfg.push.warnAtUnpushed;
    if (n === null) out(t("push.unmeasured", {}, lang));
    else if (n > max) out(t("push.warn", { n, max }, lang));
    else out(t("push.ok", { n, max }, lang));
    // What the push needs, from the commits it sends and the record of runs (checks/test-runs.mjs). A git that fails
    // is said: nothing here reads as met.
    let needs;
    try {
      needs = pushNeeds(cwd, cfg);
    } catch (e) {
      needs = { unmeasured: String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0] };
    }
    /** Whether the push may go as far as the tests go: measured, not behind, and nothing to run or met. */
    let ready = false;
    if ("unmeasured" in needs) out(t("push.needUnmeasured", { why: masked(needs.unmeasured) }, lang));
    else {
      if (needs.fetched !== null) out(t("push.notFetched", { why: masked(needs.fetched) }, lang));
      const tree = needs.tree.slice(0, 12);
      if (needs.behind) out(t("push.behind", { n: needs.behind }, lang));
      else if (needs.need === null) out(t("push.needNothing", {}, lang));
      else {
        const why = needs.code === null ? t("push.noCode", {}, lang) : t("push.code", { path: needs.code }, lang);
        if (needs.met) out(t("push.needMet", { kind: needs.need, tree, why, end: String(/** @type {any} */ (needs.last).end) }, lang));
        else out(t(needs.last ? "push.needRed" : "push.needRun", { kind: needs.need, tree, why, end: String(needs.last?.end) }, lang));
      }
      ready = !needs.behind && (needs.need === null || needs.met);
    }
    // Who wrote what the push sends, and whether it is signed (commits.*): a refusal, or a range not read, is exit 1 in
    // every mode, whatever the tests say. The rule is the strictest of the work tree's, HEAD's and the upstream's
    // config (pushRule): an edit not committed, ENNYN_CONFIG or a loosening inside the range does not take it off.
    let identityOk = true;
    const unread = (/** @type {unknown} */ e) => {
      out(t("push.commitsUnmeasured", { why: masked(String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0]) }, lang));
      identityOk = false;
    };
    /** @type {ReturnType<typeof pushRule>} */
    let rule = null;
    try {
      rule = pushRule(cwd, cfg, "unmeasured" in needs ? null : needs.upstream);
    } catch (e) {
      unread(e);
    }
    if (rule) {
      try {
        if ("unmeasured" in needs) throw new Error(needs.unmeasured);
        const { checked, refused } = commitsRefused(cwd, rule, needs.upstream);
        if (refused.length) {
          out(t("push.commitsRefused", { n: refused.length, total: checked }, lang));
          for (const r of refused) out(`  ${r.hash.slice(0, 12)} ${r.why.map((w) => t(w.key, w.vars, lang)).join("; ")}`);
          out(t("push.commitsSetup", {}, lang));
        } else out(t("push.commitsOk", { n: checked }, lang));
        identityOk = !refused.length;
      } catch (e) {
        unread(e);
      }
    }
    // The push itself: by the user's yes, or with after-closing by the cycle (checks/push-mode.mjs), on a commit whose
    // tree the record holds green, or one the caller names as tested, with nothing uncommitted. Either is a word:
    // a record line is a file any process here can write. Under ask neither pushes.
    // Exit 0 is only the line that says the cycle may push (push.md, step 4, pushes on it); ready but asked is 3.
    const push = closingPush(cwd);
    for (const l of push.said) out(t(l.key, l.vars, lang));
    if (!identityOk) return 1;
    if (!push.ok) return opts.tested !== undefined || !ready ? 1 : 3;
    const clean = () => git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], { cwd }) === "";
    if (!("unmeasured" in needs) && ready && needs.met) {
      if (!clean()) return (out(t("push.modeDirty", {}, lang)), 1);
      return (out(t("push.modeRecorded", { head: needs.tree.slice(0, 12), branch: String(push.branch) }, lang)), 0);
    }
    if (opts.tested === undefined) return (out(t("push.modeUntested", {}, lang)), 1);
    // The caller's word stands only where the record says nothing of this tree, and never against a branch behind.
    if (!("unmeasured" in needs) && needs.red) out(t("push.testedRed", { kind: needs.red.kind, tree: needs.tree.slice(0, 12), end: needs.red.end, exit: needs.red.exit }, lang));
    if ("unmeasured" in needs || needs.behind || needs.last || needs.red) return 1;
    const at = (/** @type {string} */ rev) => gitMaybe(["rev-parse", "--verify", "-q", `${rev}^{commit}`], { cwd, absent: [1] });
    const [now, tested] = [at("HEAD"), at(String(opts.tested))];
    if (!now || now !== tested) return (out(t("push.modeMoved", { head: String(now).slice(0, 12), tested: String(opts.tested).slice(0, 40) }, lang)), 1);
    if (!clean()) return (out(t("push.modeDirty", {}, lang)), 1);
    out(t("push.modeTested", { head: now.slice(0, 12), branch: String(push.branch) }, lang));
    return 0;
  },

  async "private-text"(args) {
    const { positional, opts, help } = parseArgs(args, { flags: ["exact"], positional: 1 });
    if (help) return (out(USAGE), 0);
    if (positional[0] !== "add") throw new UsageError("private-text takes add, with the words on stdin, one a line");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const path = literalsPath(cwd, cfg);
    // A list that does not read as one is not added to: the hook would read none of it.
    readLiterals(cwd, cfg);
    // From stdin, never an argument: a word on a command line stays in the shell's history. No word is ever printed.
    const words = readFileSync(0, "utf8").split("\n").map((w) => w.trim()).filter(Boolean);
    const entries = words.map((w) => literalEntry(w, !opts.exact));
    const bad = entries.flatMap((e, i) => (e === null ? [i + 1] : []));
    if (bad.length) return (err(t("privateText.notWord", { lines: bad.slice(0, 10).join(", ") }, lang)), 1);
    if (!entries.length) return (err(t("privateText.none", {}, lang)), 1);
    const had = new Set((readRegular(stateRoot(cwd, path), path)?.toString("utf8") ?? "").split("\n").map((l) => l.trim()));
    const fresh = [...new Set(/** @type {string[]} */ (entries))].filter((e) => !had.has(e));
    if (fresh.length) writeState(stateRoot(cwd, path), path, `${fresh.join("\n")}\n`, "append");
    out(t("privateText.added", { n: fresh.length, known: entries.length - fresh.length, path }, lang));
    return 0;
  },

  async "clone-setup"(args) {
    const { opts, help } = parseArgs(args, { options: ["login", "address"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const rule = commitRule(cfg);
    if (!rule) return (out(t("cloneSetup.unset", {}, lang)), 0);
    const given = opts.login === undefined ? null : String(opts.login);
    if (given !== null && !isLogin(given)) throw new UsageError("--login takes a GitHub login: letters, digits and single hyphens, at most 39");
    if (opts.address !== undefined && !isAddress(String(opts.address))) throw new UsageError("--address takes an address such as a@example.test");
    const listed = /** @type {string[]} */ (cfg.commits.addresses);
    const derived = noreplyLogin(listed);
    // The address the keys are written for, and user.email: named, the one the noreply address names, the list's
    // only one, or with no list the clone's own user.email.
    const email = gitMaybe(["config", "--get", "user.email"], { cwd, absent: [1] });
    const address = opts.address !== undefined ? String(opts.address) : given === null && derived ? derived.address : listed.length === 1 ? listed[0] : !listed.length && email && isAddress(email) ? email : null;
    if (address !== null && rule.addresses && !rule.addresses.includes(address.toLowerCase())) throw new UsageError(`--address ${address} is not in commits.addresses`);
    // A login read from a noreply address answers for that address alone: another one takes --login, the user's word.
    const login = given ?? (derived && address !== null && address.toLowerCase() === derived.address.toLowerCase() ? derived.login : null);
    const signers = signersPath(cwd, cfg);
    const commands = setupCommands({ address, signed: rule.signed, signingKey: gitMaybe(["config", "--get", "user.signingkey"], { cwd, absent: [1] }), signers, cli: fileURLToPath(import.meta.url), pluginData: process.env.ENNYN_PLUGIN_DATA || null });
    out(t("cloneSetup.commands", { addresses: listed.join(", ") || "any", signed: String(rule.signed) }, lang));
    for (const c of commands) out(`  ${c}`);
    let code = 0;
    if (address === null) (out(t("cloneSetup.noAddress", {}, lang)), (code = 1));
    if (!rule.signed) return code;
    if (login === null) return (out(t("cloneSetup.noLogin", {}, lang)), 1);
    if (address === null) return 1;
    const api = apiBase(process.env);
    if ("refused" in api) return (out(t("cloneSetup.baseRefused", { base: api.refused }, lang)), 1);
    if (api.base !== API) out(t("cloneSetup.base", { base: api.base }, lang));
    const got = await signingKeys(login, { base: api.base });
    if ("failed" in got) return (out(t(got.failed.key, { ...got.failed.vars, login, path: signers }, lang)), out(t("cloneSetup.unchanged", { path: signers }, lang)), 1);
    try {
      writeSigners(cwd, signers, signersText(address, got.keys));
    } catch (e) {
      return (out(t("cloneSetup.unwritten", { path: signers, error: /** @type {Error} */ (e).message.split("\n")[0] }, lang)), 1);
    }
    out(t("cloneSetup.written", { n: got.keys.length, login, address, path: signers }, lang));
    return code;
  },

  test(args) {
    const { opts, positional, help } = parseArgs(args, { flags: ["again"], positional: 1 });
    if (help) return (out(USAGE), 0);
    const kind = positional[0];
    if (kind !== "fast" && kind !== "whole") throw new UsageError("test takes fast or whole");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const key = kind === "fast" ? "fastTest" : "wholeTest";
    const command = cfg.commands[key];
    // No command: 78 (EX_CONFIG), apart from the 1 of a red run that most test commands give.
    if (typeof command !== "string") return (err(t("test.noCommand", { key: `commands.${key}` }, lang)), 78);
    // A command doctor fails as one that cannot fail, or a pipeline, whose status is its last program's, is run and
    // never recorded: its green would say nothing.
    const why = cannotFail(command) ? "test.noop" : pipes(command) ? "test.pipe" : null;
    const before = why ? { dirty: t(why, { key: `commands.${key}` }, lang) } : cleanTree(cwd);
    // A fast run's selection may hang on what it is read against: its base goes with it (checks/test-runs.mjs).
    const base = kind === "fast" && !("dirty" in before) ? runBase(cwd) : null;
    if ("dirty" in before) out(t("test.unrecorded", { why: before.dirty }, lang));
    else if (!opts.again) {
      // A run on this tree whose selection began at this base or before saw at least what this one would.
      const last = lastRun(readRuns(cwd, cfg).runs, before.tree, kind, (b) => base !== null && within(cwd, b, base));
      if (last && last.exit === 0) {
        const now = new Date().toISOString();
        recordRun(cwd, cfg, { v: 1, kind, tree: before.tree, head: before.head, ...(kind === "fast" ? { base } : {}), exit: 0, start: now, end: now, skipOf: last.end });
        out(t("test.skipped", { kind, tree: before.tree.slice(0, 12), end: last.end }, lang));
        return 0;
      }
    }
    const start = new Date().toISOString();
    // A recorded run is the whole one: the fault matrix's narrowing (test/fault-injection.test.mjs) does not reach it.
    const env = { ...process.env };
    delete env.ENNYN_FAULT_COMMANDS;
    if (process.env.ENNYN_FAULT_COMMANDS) err(t("test.faultCommands", { value: process.env.ENNYN_FAULT_COMMANDS }, lang));
    const run = spawnSync(command, { cwd, env, shell: true, stdio: "inherit" });
    if (run.status === null) {
      err(t("test.unfinished", { why: String(run.error?.message ?? run.signal) }, lang));
      return 1;
    }
    if (!("dirty" in before)) {
      // The tree the run ended on must be the one it began on: a run that commits or writes a tracked file tested neither.
      const after = cleanTree(cwd);
      if ("dirty" in after || after.head !== before.head) out(t("test.unrecorded", { why: "dirty" in after ? after.dirty : "HEAD moved during the run" }, lang));
      else {
        recordRun(cwd, cfg, { v: 1, kind, tree: before.tree, head: before.head, ...(kind === "fast" ? { base } : {}), exit: run.status, start, end: new Date().toISOString() });
        out(t("test.recorded", { kind, tree: before.tree.slice(0, 12), result: run.status === 0 ? t("test.green", {}, lang) : t("test.red", { exit: run.status }, lang) }, lang));
      }
    }
    return run.status;
  },

  async lock(args) {
    const cut = args.indexOf("--");
    const { opts, help } = parseArgs(cut === -1 ? args : args.slice(0, cut), { options: ["limit", ...Object.values(ROOM_KNOBS).map((k) => k.option)] });
    if (help) return (out(USAGE), 0);
    const [command, ...rest] = cut === -1 ? [] : args.slice(cut + 1);
    if (command === undefined || command === "") throw new UsageError("lock takes -- <command> [args...]");
    let minutes = DEFAULT_LIMIT_MIN;
    if (opts.limit !== undefined) {
      if (typeof opts.limit !== "string" || !/^\d+(\.\d+)?$/.test(opts.limit)) throw new UsageError("--limit must be a number of minutes");
      minutes = Number(opts.limit);
      if (!(minutes > 0) || minutes > MAX_LIMIT_MIN) throw new UsageError(`--limit must be above 0 and at most ${MAX_LIMIT_MIN}`);
    }
    let room;
    try {
      room = roomThresholds(opts);
    } catch (e) {
      throw new UsageError(/** @type {Error} */ (e).message);
    }
    // The language of the project the command runs in, when there is one: the lock itself reads no project.
    let lang = "en";
    try {
      lang = config(projectDir()).language;
    } catch {
      // English outside a project.
    }
    const say = (/** @type {import("../core/heavy-lock.mjs").Said} */ s) => err(t(s.key, s.vars ?? {}, lang));
    if (room.set.length) say({ key: "lock.roomSet", vars: { set: room.set.join(", ") } });
    return runLocked({ command, args: rest, limitMs: Math.round(minutes * 60_000), say, thresholds: room.thresholds });
  },

  worktrees(args) {
    const { opts, positional, help } = parseArgs(args, { flags: ["remove"], positional: Infinity });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const lang = config(cwd).language;
    const say = (/** @type {string} */ key, /** @type {import("../core/i18n.mjs").Vars} */ vars = {}) => out(tShown(key, vars, lang));
    // As the disk spells it (case, links): a path that is not there stays as given; one that cannot be resolved stops the command.
    const real = (/** @type {string} */ p) => {
      try {
        return realpathSync.native(p);
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return p;
        throw e;
      }
    };
    const found = markedWorktrees(cwd);
    let failed = found.unread.length;
    for (const u of found.unread) say("worktrees.markUnread", { id: [u.id], error: u.error });
    let chosen = found.marked;
    if (positional.length) {
      const asked = positional.map((p) => real(resolve(p)));
      const at = (/** @type {typeof chosen[number]} */ w) => (w.path === null ? null : real(w.path));
      chosen = chosen.filter((w) => asked.includes(String(at(w))));
      for (const [i, p] of asked.entries()) {
        if (chosen.some((w) => at(w) === p)) continue;
        say("worktrees.notMarked", { path: [positional[i]] });
        failed++;
      }
    } else if (!found.marked.length && !found.unread.length) say("worktrees.none");
    const top = realpathSync.native(cwd);
    for (const w of chosen) {
      const vars = { path: [w.path ?? w.id], mark: w.mark };
      const done = opts.remove ? removeWorktree(top, w) : { verdict: verdict(top, w) };
      if ("removed" in done && done.removed) say("worktrees.removed", vars);
      else if ("error" in done) {
        const entry = tShown(`worktrees.entry.${done.entry}`, {}, lang);
        say("worktrees.failed", { ...vars, error: done.error, entry: { shown: entry }, folder: { shown: tShown(`worktrees.folder.${done.folder}`, { aside: [done.aside] }, lang) } });
        failed++;
      } else if ("verdict" in done) {
        const v = done.verdict;
        if (v.go) say("worktrees.canGo", vars);
        else if ("unmeasured" in v) say("worktrees.unmeasured", { ...vars, error: v.unmeasured }), failed++;
        else {
          say("worktrees.kept", { ...vars, why: { shown: tShown(`worktrees.why.${v.why}`, v.vars ?? {}, lang) } });
          // Passed, but not moved aside for its removal: not removed, so the command did not do what it was asked.
          if ("notMoved" in done) failed++;
        }
      }
    }
    if (found.others && !positional.length) say("worktrees.others", { n: found.others });
    if (failed) err(t("worktrees.incomplete", { n: failed }, lang));
    return failed ? 1 : 0;
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
    // The digits given: past 2^53 the number read is a neighbour of the one written.
    if (res.entry.seconds === null) out(t("gate.recordedUntimed", { result, path: res.path, start: String(opts.start) }, cfg.language));
    else out(t("gate.recorded", { result, path: res.path }, cfg.language));
    return 0;
  },

  classes(args) {
    const { opts, help } = parseArgs(args, { flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const reg = loadClasses({ cwd, config: cfg });
    const proofs = checkProofs(reg, { cwd });
    const problems = [...reg.problems, ...proofs.problems];
    const code = problems.length || proofs.unmeasured ? 1 : 0;
    const said = problems.slice(0, PROBLEMS_SHOWN);
    const moreProblems = problems.length - said.length;
    if (opts.json) return (out(jsonShown({ path: reg.path, there: reg.there, total: reg.size, states: Object.fromEntries(stateCounts(reg)), classes: reg.entries, problems: said, moreProblems, unmeasured: proofs.unmeasured })), code);
    const line = registryLine(reg, proofs);
    out(tShown(line.key, line.vars, lang));
    // A sentence is data, one plain line: the validator refused any other, and tShown holds it to one.
    for (const e of reg.entries) out(`${e.id} · ${e.by ? `${e.state} → ${e.by}` : e.state} · ${shown(e.says).text}`);
    for (const p of said) out(`✗ ${shown(p).text}`);
    if (moreProblems) out(tShown("classes.more", { n: moreProblems }, lang));
    return code;
  },
  async convergence(args) {
    const { positional, opts, help } = parseArgs(args, { positional: 1, options: ["from", "cycle"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    // As bypass takes it: an empty --from is a lost cycle start. Left out, the table reads "not noted".
    if (opts.from !== undefined && strOpt(opts.from) === null) throw new UsageError("--from needs a revision");
    // Asked for, never read from the rows: a count does not pick its own scope from the data it counts.
    const cycle = intOpt(opts.cycle, "cycle");
    if (!(cycle >= 1 && cycle <= CYCLE_MAX)) throw new UsageError(`--cycle must be a whole number from 1 to ${CYCLE_MAX}`);
    const from = strOpt(opts.from) ?? undefined;
    // No repository stops the command, a bare one or no git too (git's own words): no block, as nothing can be placed.
    const cwd = repoPath("--show-toplevel", { cwd: process.cwd() });
    if (cwd === null) return (err(t("findings.noRepository", {}, config(process.cwd()).language)), 1);
    const cfg = config(cwd);
    // A name reads from where the command stands, as any file named on a command line.
    const ledger = positional[0] === undefined ? undefined : resolve(process.cwd(), positional[0]);
    const report = cycleReport({ cwd, config: cfg, ledger, from, cycle });
    await brakePatches({ cwd, config: cfg, from, report });
    out(opts.json ? jsonShown(report) : reportLines(report, cfg).join("\n"));
    const ladder = report.ladder;
    if (complete(report) && !ladder?.patches.length && !ladder?.unmeasured) return 0;
    if (!complete(report)) err(t("findings.unmeasured", {}, cfg.language));
    if (ladder?.patches.length) err(t("findings.ladder.patched", {}, cfg.language));
    else if (ladder?.unmeasured) err(t("findings.ladder.unmeasuredExit", {}, cfg.language));
    return 1;
  },
  agents(args) {
    const { opts, help } = parseArgs(args, { options: ["session"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const given = opts.session === undefined ? null : strOpt(opts.session);
    if (opts.session !== undefined && given === null) throw new UsageError("--session needs a session id or a transcript's path");
    const asPath = given !== null && (given.includes("/") || given.includes("\\") || given.endsWith(".jsonl"));
    if (given !== null && !asPath && !SESSION_ID.test(given)) throw new UsageError("--session takes a session id (letters, digits, - and _) or a transcript's path");
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    let transcript;
    /** How the session was picked: given by --session, the one running, or the newest, and why not the one running. */
    let chosen = "given";
    /** @type {string | null} */
    let why = null;
    try {
      let real = cwd;
      try {
        real = realpathSync(cwd);
      } catch {
        // The spelling git gave is the one tried.
      }
      const tops = [...new Set([cwd, real])];
      if (asPath) transcript = resolve(process.cwd(), /** @type {string} */ (given));
      else {
        const folder = projectFolder(projectsDir(), tops, namedFolder());
        if (folder === null) return (err(t("agents.noFolder", {}, lang)), 1);
        if (given !== null) transcript = join(folder, `${given}.jsonl`);
        else ({ transcript, chosen, why } = defaultSession(folder));
        if (chosen === "missing") return (err(t("agents.noRunning", {}, lang)), 1);
        if (transcript === null) return (err(t("agents.noFolder", {}, lang)), 1);
      }
      const read = (/** @type {string} */ path) => readIfThere(path);
      const report = agentUsage({ transcript, tops, configDir: claudeConfigDir(), read });
      if (!report.there) return (err(tShown(asPath ? "agents.noPath" : "agents.noSession", { session: basename(transcript, ".jsonl") }, lang)), 1);
      const compared = report.agents.filter((a) => a.mismatch !== null);
      const mismatched = compared.filter((a) => a.mismatch);
      if (opts.json) return (out(jsonShown({ session: report.session, agents: report.agents.map(({ first, ...a }) => a), mismatches: mismatched.length, skipped: report.skipped, unreadRecords: report.unreadMeta, chosen })), 0);
      out(tShown(report.agents.length ? "agents.header" : "agents.none", { session: report.session, n: report.agents.length }, lang));
      for (const a of report.agents) {
        const ran = Object.entries(a.ran).map(([m, n]) => `${m} ×${n}`).join(", ") || t("agents.ranNone", {}, lang);
        const asked = a.from === "file" ? t("agents.askedFile", { model: a.asked }, lang) : a.asked;
        const parts = [a.id, a.type ?? "?", t("agents.asked", { asked }, lang), t("agents.ran", { ran }, lang), t("agents.tokens", { output: a.output, write: a.cacheWrite, read: a.cacheRead }, lang)];
        parts.push(a.lastContext === null ? t("agents.lastContextUnmeasured", {}, lang) : t("agents.lastContext", { n: a.lastContext }, lang));
        if (a.usageMissing) parts.push(t("agents.usageMissing", { n: a.usageMissing, calls: a.calls }, lang));
        if (a.mismatch) parts.push(t("agents.mismatchMark", {}, lang));
        out(shown(parts.join(" · ")).text);
      }
      if (report.agents.length) {
        if (mismatched.length) {
          out(t("agents.mismatch", { n: mismatched.length, of: compared.length, list: mismatched.map((a) => a.id).join(", ") }, lang));
          // An alias may be mapped to any id by the environment, which no transcript records.
          if (mismatched.some((a) => ALIASES.includes(a.asked.toLowerCase().replace(/\[[^\]]*\]$/, "")))) out(t("agents.aliasRemap", {}, lang));
        } else if (compared.length) out(t("agents.match", { n: compared.length }, lang));
        const rest = report.agents.length - compared.length;
        if (rest) out(t("agents.notCompared", { n: rest }, lang));
        out(t("agents.legend", {}, lang));
      }
      if (report.skipped) out(t("agents.skipped", { n: report.skipped, max: READ_LINE_MAX / 1024 / 1024 }, lang));
      if (report.unreadMeta) out(t("agents.unreadRecords", { n: report.unreadMeta }, lang));
      // Which session was read goes to stderr: the table stays as it is pasted.
      if (chosen === "running") err(t("agents.chosenRunning", {}, lang));
      else if (chosen === "newest") err(t("agents.chosenNewest", { why: t(`agents.sessionId.${why}`, {}, lang) }, lang));
      return 0;
    } catch (e) {
      if (e instanceof TranscriptError) return (err(`ennyn agents: ${e.message}`), 1);
      throw e;
    }
  },
  "gate-stats"(args) {
    const { opts, help } = parseArgs(args, { options: ["since", "until"], flags: ["json"] });
    if (help) return (out(USAGE), 0);
    const { since, until } = dateRange(opts);
    const cwd = projectDir();
    const cfg = config(cwd);
    const lang = cfg.language;
    const path = gateLogPath(cwd, cfg.paths.stateDir);
    const log = readAttempts(path, stateRoot(cwd, path));
    const sum = summarizeAttempts(log.attempts, { since, until });
    if (opts.json) return (out(jsonShown({ path, exists: log.exists, skipped: log.skipped, ...sum })), 0);
    if (!log.exists) return (out(t("gate.none", { path }, lang)), 0);
    if (log.skipped) out(t("gate.skipped", { n: log.skipped, path }, lang));
    // A log with no attempt in it, read with no range, is no range found empty; one whose every line was skipped said so.
    if (!sum.attempts) {
      if (since || until) out(t("gate.emptyWindow", {}, lang));
      else if (!log.skipped) out(t("gate.none", { path }, lang));
      return 0;
    }
    const pct = percent(sum.failRate, lang);
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
  // A closed stderr ends nothing: a notice nobody can read is lost, and the run's own output still counts.
  process.stderr.on("error", (e) => {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EPIPE") throw e;
  });
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
