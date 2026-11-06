/**
 * The cycle's journal: the state of a cycle as it goes, in the state dir, one file per work tree (see treeFile), so a
 * session that compacted, or a new one, starts from a file and not from a summary. The orchestrator writes it with
 * `ennyn journal <event>`, never by hand: a hand edit is what compaction lost.
 *
 * It is a log of events, one JSON line each, appended in one write (core/files.mjs writeState `append`), and its state
 * is the fold of its lines. Two writers at once lose nothing (measured: 2 x 400 appends kept 800; a read, change and
 * rename of one JSON file kept 402). `start` begins a cycle and replaces the file whole; the HEAD and the time it
 * began are the tree's start record's (`ennyn leftovers --start`), never a second record: `start` refuses without one.
 * A line that does not read as an event is counted and said, never folded.
 */

import { READ_LIMIT, readRegular, readTail, writeState } from "../core/files.mjs";
import { gitMaybe, repoPath, stateRoot } from "../core/git.mjs";
import { UNSHOWN } from "../core/i18n.mjs";
import { readStart, startPath, treeFile } from "../metrics/leftovers.mjs";

/** The steps of a task, in order; the percent counts them, never time. */
export const STEPS = /** @type {const} */ (["planned", "brief", "author", "review", "landing", "landed"]);

/** The most bytes of a journal read: a cycle writes a few hundred lines. */
export const JOURNAL_LIMIT = 1024 * 1024;

/** The most bytes of the line the SessionStart hook gives after compaction (adapters/claude-code/hooks/conversation-style.mjs). */
export const CYCLE_LINE_MAX = 512;

/** A task or node id: what a line of the hook may name. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TEXT_MAX = 300;
const ROUND_MAX = 9;

/**
 * @typedef {{ node: string | null, worktree: string | null, step: typeof STEPS[number], round: number, at: string }} Task
 * @typedef {{ cycle: number, at: string, startAt: string, release: string | null, findings: string | null,
 *   order: string[], tasks: Record<string, Task>, waits: string | null, closed: string | null }} JournalState
 */

/** The journal of the work tree at `top`. @param {string} top @param {string} stateDir @param {NodeJS.ProcessEnv} [env] */
export const journalFile = (top, stateDir, env) => treeFile(top, stateDir, "cycle-journal", ".jsonl", env);

/** @param {unknown} v */
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= TEXT_MAX && !UNSHOWN.test(v);
/** @param {unknown} v */
const id = (v) => typeof v === "string" && ID.test(v);

/**
 * Why an event is no event of the journal; null when it is one. The writer and the reader ask the same.
 * @param {any} e
 * @returns {string | null}
 */
export function eventProblem(e) {
  if (!e || typeof e !== "object" || e.v !== 1 || typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return "no event of this version";
  if (e.ev === "start") {
    if (!Number.isInteger(e.cycle) || e.cycle < 1 || e.cycle > 9999) return "the cycle is a number from 1 to 9999";
    if (typeof e.startAt !== "string") return "start names no start record";
    if (e.release !== null && !id(e.release)) return "the release is a node id";
    if (e.findings !== null && !text(e.findings)) return `the findings path is text of at most ${TEXT_MAX} characters`;
    if (!Array.isArray(e.tasks) || !e.tasks.every(id) || new Set(e.tasks).size !== e.tasks.length) return "the tasks are distinct ids";
    return null;
  }
  if (e.ev === "task") {
    if (!id(e.id)) return "a task id is letters, digits, dot, dash and underscore, at most 80";
    if (e.node !== undefined && !id(e.node)) return "the node is a node id";
    if (e.worktree !== undefined && !text(e.worktree)) return `the worktree is a path of at most ${TEXT_MAX} characters`;
    if (e.step !== undefined && !STEPS.includes(e.step)) return `the step is one of ${STEPS.join(", ")}`;
    if (e.round !== undefined && !(Number.isInteger(e.round) && e.round >= 0 && e.round <= ROUND_MAX)) return `the round is a number from 0 to ${ROUND_MAX}`;
    return null;
  }
  if (e.ev === "wait") return e.text === null || text(e.text) ? null : `what waits is one line of at most ${TEXT_MAX} characters`;
  if (e.ev === "close") return null;
  return "no event of this version";
}

/**
 * The journal's state: null when there is none. `bad` counts the lines that did not read as events (a line cut short
 * by a write that failed, one written by hand); `error` says why the file could not be read at all.
 * @param {string} top @param {string} path
 * @returns {{ state: JournalState | null, bad: number, error?: string }}
 */
export function readJournal(top, path) {
  /** @type {Buffer | null} */
  let bytes;
  try {
    bytes = readRegular(stateRoot(top, path), path, { limit: JOURNAL_LIMIT });
  } catch (e) {
    return { state: null, bad: 0, error: /** @type {Error} */ (e).message };
  }
  if (bytes === null) return { state: null, bad: 0 };
  /** @type {JournalState | null} */
  let state = null;
  let bad = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line) continue;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      e = null;
    }
    // Events before the first start belong to no cycle.
    if (eventProblem(e) !== null || (!state && e.ev !== "start")) {
      bad++;
      continue;
    }
    if (e.ev === "start") {
      const tasks = Object.fromEntries(e.tasks.map((/** @type {string} */ t) => [t, { node: null, worktree: null, step: "planned", round: 0, at: e.at }]));
      state = { cycle: e.cycle, at: e.at, startAt: e.startAt, release: e.release, findings: e.findings, order: [...e.tasks], tasks, waits: null, closed: null };
    } else if (!state) continue;
    else if (e.ev === "task") {
      if (!Object.hasOwn(state.tasks, e.id)) {
        state.order.push(e.id);
        state.tasks[e.id] = { node: null, worktree: null, step: "planned", round: 0, at: e.at };
      }
      const t = state.tasks[e.id];
      for (const k of /** @type {const} */ (["node", "worktree", "step", "round"])) if (e[k] !== undefined) /** @type {any} */ (t)[k] = e[k];
      t.at = e.at;
    } else if (e.ev === "wait") state.waits = e.text;
    else if (e.ev === "close") state.closed = e.at;
  }
  return { state, bad };
}

/**
 * The work tree's top, the journal's path and its state; outside a repository, throws.
 * @param {{ cwd: string, config: any, env?: NodeJS.ProcessEnv }} opts
 */
export function journalAt({ cwd, config, env = process.env }) {
  const top = repoPath("--show-toplevel", { cwd, env });
  if (!top) throw new Error("not in a git repository");
  const path = journalFile(top, config.paths.stateDir, env);
  return { top, path, ...readJournal(top, path) };
}

/**
 * Writes one event to the journal of the work tree at `cwd`. `start` needs no open cycle and a start record of this
 * cycle (noted at the current HEAD, newer than the one the last journal began from), and replaces the journal; every
 * other event needs an open cycle and is appended. An event that is not one, a journal that cannot be read, or a line
 * that would take the journal past JOURNAL_LIMIT writes nothing.
 * @param {{ cwd: string, config: any, event: Record<string, unknown>, env?: NodeJS.ProcessEnv, now?: Date }} opts
 * @returns {{ path: string, state: JournalState }}
 */
export function writeEvent({ cwd, config, event, env = process.env, now = new Date() }) {
  const { top, path, state, error } = journalAt({ cwd, config, env });
  /** @type {any} */
  const e = { v: 1, at: now.toISOString(), ...event };
  if (error) throw new Error(`the cycle journal could not be read: ${error}; nothing replaces it unseen: look at ${path}`);
  if (e.ev === "start") {
    // A cycle that runs keeps its journal: a second start (after a compaction) would erase every step and round.
    if (state && !state.closed) throw new RangeError(`cycle ${state.cycle} is open in this work tree: \`ennyn journal close\` ends it before a new start`);
    const start = readStart(top, startPath(top, config.paths.stateDir, env), READ_LIMIT);
    if (!start || !("record" in start) || start.record.top !== top) throw new RangeError("no start record for this work tree: run `ennyn leftovers --start` first, so the journal names the HEAD the cycle began at");
    // An earlier cycle's record: HEAD has moved since it was noted, or the last journal began from it.
    const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top, env, absent: [1] });
    if (start.record.head !== head || (state && Date.parse(start.record.at) <= Date.parse(state.startAt))) throw new RangeError(`the start record (HEAD ${start.record.head.slice(0, 10)}, ${start.record.at}) is an earlier cycle's: run \`ennyn leftovers --start\` again at this HEAD`);
    e.startAt = start.record.at;
  } else if (!state || state.closed) throw new RangeError("no open cycle in this work tree: `ennyn journal start` first");
  const problem = eventProblem(e);
  if (problem) throw new RangeError(problem);
  const line = JSON.stringify(e) + "\n";
  const root = stateRoot(top, path);
  // A line past the read cap would leave a journal no call can read: refused before it is written. Two writers at
  // once may both pass this look; the reader then says the file is past its cap, and nothing is lost.
  const size = e.ev === "start" ? 0 : (readTail(root, path, 0)?.size ?? 0);
  if (size + Buffer.byteLength(line) + 1 > JOURNAL_LIMIT) throw new RangeError(`the journal would pass its ${JOURNAL_LIMIT} bytes (${path} holds ${size})`);
  writeState(root, path, line, e.ev === "start" ? "replace" : "append");
  const after = readJournal(top, path).state;
  if (!after) throw new Error(`${path} holds no cycle after the write`);
  return { path, state: after };
}

/**
 * What `ennyn status` says, counted from files only: the journal, the start record, the release node's needs.
 * @param {{ state: JournalState, start: { head: string, at: string } | null, release: { done: number, total: number } | null, now: Date }} opts
 */
export function statusOf({ state, start, release, now }) {
  const tasks = state.order.map((t) => ({ id: t, ...state.tasks[t] }));
  const landed = tasks.filter((t) => t.step === "landed").length;
  const last = STEPS.length - 1;
  const percent = tasks.length ? Math.round((100 * tasks.reduce((n, t) => n + STEPS.indexOf(t.step), 0)) / (tasks.length * last)) : null;
  // The start record must be the one the journal began from: a later `leftovers --start` is another cycle's.
  const begun = start && start.at === state.startAt ? start : null;
  const end = state.closed ? Date.parse(state.closed) : now.getTime();
  const minutes = begun ? Math.max(0, Math.floor((end - Date.parse(begun.at)) / 60000)) : null;
  return { cycle: state.cycle, open: !state.closed, head: begun?.head ?? null, minutes, planned: tasks.length, landed, percent, tasks, waits: state.waits, release, findings: state.findings };
}

/**
 * One task as a line names it: its id, step and round.
 * @param {{ id: string, step: string, round: number }} t
 */
export const taskWord = (t) => `${t.id} ${t.step} r${t.round}`;

/**
 * The tasks not landed, as many as fit in `max` characters, and how many more there are.
 * @param {{ id: string, step: string, round: number }[]} tasks @param {number} max
 */
export function tasksFit(tasks, max) {
  const open = tasks.filter((t) => t.step !== "landed").map(taskWord);
  const shown = [];
  let used = 0;
  for (const w of open) {
    if (used + w.length + 2 > max) break;
    shown.push(w);
    used += w.length + 2;
  }
  return { list: shown.join(", "), more: open.length - shown.length };
}
