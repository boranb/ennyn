/**
 * The failure count of skills/cycle/task-brief.md, walked. The rule's states and what answers each event
 * are written here as data, one row per answer, and a walk from every way a task starts asserts: each
 * (state, event) pair it reaches has exactly one answer, no two rows answer one pair, every path ends
 * (landed or stopped) within a bound, and no state or row is left unreached.
 *
 * A pointer test ties the data to the prose, sentence by sentence: every sentence of the section is claimed
 * here, under the table row or paragraph that holds it, by the rows that answer from it or as narrative
 * that decides no pair; each state the section names in bold is in the data. A sentence added, dropped,
 * moved to another row or rewritten fails until the data follows it. Nothing here reads meaning.
 *
 * Origin: procedure-leaves-case-open, the ledger's most recurring class since cycle 2026-11-01 (16): method
 * rules that left a state with no answer, nearly all caught by review.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIEF = "skills/cycle/task-brief.md";
/** The section the data walks: from its heading to the consolidated brief, which is the restart's content. */
const FROM = "## The failure count";
const TO = "**The consolidated brief**";

/**
 * @typedef {"work" | "gate" | "landing" | "lost" | "landed" | "stopped"} Phase
 * @typedef {"session" | "cheaper" | "dropped"} Author `dropped`: put on a cheaper model, but `ennyn agents` shows only the session's ran
 * @typedef {{ phase: Phase, count: number, author: Author, others: boolean, tried: boolean, alone: boolean, rounds: number, reds: number, rebased: boolean, from: Phase | null }} State
 *   `others`: every other task has landed or stopped; `tried`: the one more try after that is taken;
 *   `alone`: the check is being rerun alone; `rounds`: the exempt review rounds behind it; `reds`: the
 *   agent's own red runs at one failure; `rebased`: it went back for a conflict after the others ended.
 * @typedef {{ phase?: Phase | "from", count?: number, author?: Author, others?: boolean, tried?: boolean, alone?: boolean, rounds?: number, reds?: number, rebased?: boolean, from?: "here" }} Next
 * @typedef {{ count?: number[], author?: Author[], others?: boolean, tried?: boolean, alone?: boolean, rounds?: number[], reds?: number[], rebased?: boolean }} When
 * @typedef {{ names?: string[], phase: Phase[], event: string[], when?: When, next: Next | null, why?: string, says?: string[], outside?: boolean }} Row
 *   `next: null` is "this cannot happen here", with `why`; `says`: the sentences it answers from (ids of
 *   SENTENCES); `outside`: repeats bounded by what is not this task (the other tasks' landings, the API
 *   coming back), left out of the bound.
 */

const AT_WORK = /** @type {Phase[]} */ (["work", "gate", "landing"]);
/**
 * What counts as a failed verification: its sources, each with the steps it comes at (each is an event of
 * the walk), the tries at one failure before the agent reports it cannot pass, the review rounds exempt.
 * @type {{ text: string, at: Phase[] }[]}
 */
const SOURCES = [
  { text: "a check the orchestrator reran", at: AT_WORK },
  { text: "a review round", at: ["work"] },
  { text: "the test that proves a fix after round two", at: ["work"] },
  { text: "the task's gate after the last round's fixes", at: ["gate"] },
  { text: "the landing suite", at: ["landing"] },
];
const REVIEW = "a review round";
const TRIES = 3;
const WORDS = ["no", "one", "two", "three", "four", "five"];
const EXEMPT_ROUNDS = 1;
/** The nth failure's word in the Sent back row, by the count before it. */
const NTH = ["First", "Second", "Third or later"];

/**
 * Every sentence of the section, by the unit that holds it (a table row's state, a paragraph's bold lead,
 * else its first three words), in order. `**` is dropped from the text.
 * @type {Record<string, [string, string]>}
 */
const SENTENCES = {
  intro: ["The orchestrator writes", "The orchestrator writes each task's state and count to a file in that folder at every change: context does not survive compaction."],
  "fail-def": ["A failed verification", `A failed verification is a result that sends the task back: ${SOURCES.map((s) => s.text).join(", ")}, or the agent's report that it cannot pass (still red after ${WORDS[TRIES]} tries at one failure).`],
  "fail-first-round": ["A failed verification", `The task's ${EXEMPT_ROUNDS === 1 ? "first review round does" : `first ${WORDS[EXEMPT_ROUNDS]} review rounds do`} not count: its findings are the work.`],
  "fail-exempt": ["A failed verification", "Nothing else is exempt, whatever the finding's Source."],
  "fail-own": ["A failed verification", "An agent's own red runs before it reports are no results."],
  "fail-timing": ["A failed verification", "A timing failure under load is rerun alone before anything counts, whoever runs the suite."],
  "sent-first": ["Sent back", "First failure: the agent corrects and amends, or a fresh agent does (see below); a task the brief put on a cheaper model is escalated instead, as Escalation says."],
  "sent-second": ["Sent back", "Second: restart."],
  "sent-third": ["Sent back", "Third or later: stopped."],
  "sent-resets": ["Sent back", "The count is the task's, and nothing resets it"],
  "gate-rerun": ["Last round fixed", "The orchestrator reruns the task's gate on the amended commit, before `Review-Rounds:` goes in."],
  "gate-red": ["Last round fixed", "Red in that rerun is a failed verification, and it counts"],
  "restart-once": ["Restart", "Once per task."],
  "restart-fresh": ["Restart", "The agent stops; a fresh agent on a new branch, on the session's model, takes the consolidated brief; the old branch stays."],
  "restart-reviewers": ["Restart", "The reviewers keep their context, and a reviewer or the orchestrator runs what they left."],
  "restart-design": ["Restart", "A new design is a first write nobody has read: it gets one narrow review, with the failures as step 7's signal"],
  "landing-order": ["Landing", "One task at a time: rebase, the fast test command and every slow gate the task touches (no command short of the whole suite: the whole test command), and the platform runs its brief names, whatever the agent ran, then the main branch moves; the whole test command waits for the closing (section 3 of `SKILL.md`)."],
  "landing-same-tree": ["Landing", "The fast test command runs as `ennyn.mjs test fast`, which records it by tree: on the tree of the author's last green run (a fast-forward, the base not moved) it is not run again and the skip is recorded; a moved base is a new tree, and the fast test command runs on it as on any tree, choosing what it runs from the change against the new base (the moved commits were tested at their own landing, and the whole suite runs at the closing)."],
  "landing-push": ["Landing", "Red there stops the push: a timing failure is rerun alone first; a real one is traced to the landing commit that brought it and fixed in a new `fix:` commit, written and reviewed as a first write, or the push waits."],
  "landing-repeat": ["Landing", "The whole run repeats on the fixed tree, and what follows the last edit is done again: the `fix:` commit's rows appended first, convergence run again (a new block), the graph, the budget record, leftovers, and `bypass` over the new commit."],
  "landing-closing": ["Landing", "A red closing run is a landed task's defect: it counts against no task (Landed), its `fix:` commit is written by a fresh agent on the session's model and reviewed as a first write, and no escalation applies."],
  "landing-clean": ["Landing", "A clean rebase is no change: it does not recheck meaning, and the suite is the net."],
  "landing-suite": ["Landing", "A red suite counts; a conflict goes to the agent uncounted; once the others have landed or stopped the main branch holds still, and one more conflict at most can come."],
  "landing-delta": ["Landing", "What either changes goes to the reviewers as a delta: that failure or conflict is step 7's signal, and `Third-round:` names it"],
  "landed-closed": ["Landed", "Closed: restart and stop no longer apply."],
  "landed-later": ["Landed", "A defect found later counts for nothing: a new `fix:` commit, written and reviewed as a first write, or a node"],
  "lost-none": ["Lost or waiting", "An agent lost to an API error, sleep or a restart, or a check or reviewer that is unavailable, is no failure."],
  "lost-resume": ["Lost or waiting", "Resume the agent, or start one on the same brief (its Model row too) from its branch and snapshot, with that round's open findings."],
  "lost-try": ["Lost or waiting", "Once the other tasks have landed or stopped it gets one more try: lost or waiting again, it stops; a result of that try goes by the count"],
  "stopped-ends": ["Stopped", "That task ends, the others go on."],
  "stopped-stays": ["Stopped", "It does not land; its branch and files stay."],
  "stopped-gate": ["Stopped", "Its node gets a `gate`, so the next cycle does not pick it alone."],
  "stopped-report": ["Stopped", "The report gives it a line ([report-formats.md](report-formats.md)) and the handoff names it."],
  "stopped-user": ["Stopped", "Only the user sends it round again"],
  unnamed: ["A state this", "A state this table does not name is the orchestrator's decision, written in the cycle report, never a silent wait."],
  "esc-applies": ["Escalation", "It applies only where the author is a subagent that the brief put, by its Model row and the Agent call's `model`, on a model cheaper than the session's (`sonnet` under a stronger session)."],
  "esc-stands": ["Escalation", "A task the brief put on the session's model, a host with no subagents, or one whose Agent call takes no model: the failure table stands as written."],
  "esc-reads": ["Escalation", "At the first failed verification the orchestrator reads the author's `ran` in `ennyn agents` (each model that ran, with its calls, most calls first)."],
  "esc-when": ["Escalation", "The task escalates when that list holds any model other than the session's, matched as `ennyn agents` matches an ask (an alias as a whole word of the id, an id with or without a provider's prefix, a date or a version suffix), with the session's model as the ask; or when it holds `unknown` or nothing, or the command is unmeasured (exit 1)."],
  "esc-dropped": ["Escalation", "A list of only the session's model, or of it and models stronger than it (named in the report), does not escalate: the call's `model` was dropped, and the task ran where escalation would send it."],
  "esc-goes": ["Escalation", "An escalated task goes to a fresh agent on the session's model, by the correction path below: same worktree and branch, the list applied on the existing commit, the count at one."],
  "esc-second": ["Escalation", "The second failure restarts, on the session's model too."],
  "esc-why": ["Escalation", "Why the first failure and not only the restart: the research behind the model split found up-front routers fail on software tasks and a gate after a cheap attempt works, and the verification is that gate; the cheaper agent's own reading of its failure is the one input that would steer a same-agent correction wrong."],
  "esc-brief": ["Escalation", "The escalated agent's brief holds verified facts only (the consolidated brief's rows say which) and its Agent call passes the session's model by name."],
  "corr-rule": ["A correction sent to a fresh agent", "The count is the rule: the first failure goes to the agent that wrote the task, escalation above excepted."],
  "corr-size": ["A correction sent to a fresh agent", "No size is a rule."],
  "corr-evidence": ["A correction sent to a fresh agent", "In Ennyn's own cycles 16 to 19, eight same-agent corrections at 258K to 540K tokens of context held on that try; eight lists went fresh at 561K to 723K, four held and four failed the next verification, none by a slip the list named."],
  "corr-picked": ["A correction sent to a fresh agent", "Both groups were picked by size, so nothing shows where a same-agent correction starts to fail."],
  "corr-judgment": ["A correction sent to a fresh agent", "When the author's context is large and the list is short and decided, the orchestrator may still send it fresh, past a size it names itself: a judgment, written in the cycle report with the author's size and the reason."],
  "corr-reads": ["A correction sent to a fresh agent", "It reads the size as the last assistant `usage` of the author's transcript (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`, in `subagents/agent-<id>.jsonl` under the session's transcript folder); `ennyn agents` prints it per agent, in its \"last call's context\" column."],
  "corr-place": ["A correction sent to a fresh agent", "The fresh agent takes the consolidated brief below, but for this case its Place row is the same worktree and branch, and the list is applied on the existing commit (amend, one commit): \"start from the base\" is the restart's freedom, not this one's."],
  "corr-count": ["A correction sent to a fresh agent", "It is not the restart: the count does not move, and the second failure still restarts the task (four of the eight went on to one)."],
};
/** Sentences that decide no (state, event) pair: what is written, who reads what, why. */
const NARRATIVE = ["intro", "restart-reviewers", "landing-same-tree", "landing-repeat", "landing-clean", "landing-delta", "stopped-ends", "stopped-stays", "stopped-gate", "stopped-report", "unnamed", "esc-reads", "esc-why", "esc-brief", "corr-size", "corr-evidence", "corr-picked", "corr-reads", "corr-place"];

/** Where a task stands between events. `name` is bold in the prose, `says` a sentence id. */
const PHASES = /** @type {Record<Phase, { name?: string, says?: string }>} */ ({
  work: { says: "corr-rule" },
  gate: { name: "Last round fixed" },
  landing: { name: "Landing" },
  lost: { name: "Lost or waiting" },
  landed: { name: "Landed" },
  stopped: { name: "Stopped" },
});
const ENDS = new Set(["landed", "stopped"]);

/** A failed verification from one source: an event of the walk, counted; the nth failure is its state's count + 1. */
const failOf = (/** @type {string} */ text) => `fail: ${text}`;
/** The agent's own red run at one failure: no result, until the last of its tries is its report. */
const OWN_RED = "own-red";
/** What happens to a task besides a failed verification. */
const OTHER_EVENTS = /** @type {Record<string, { name?: string, says?: string }>} */ ({
  [OWN_RED]: { says: "fail-own" },
  green: { says: "landing-order" },
  lost: { says: "lost-none" },
  waiting: { says: "lost-none" },
  resumed: { says: "lost-resume" },
  others: { says: "lost-try" },
  timing: { says: "fail-timing" },
  conflict: { says: "landing-suite" },
  closing: { says: "landing-closing" },
  later: { says: "landed-later" },
});
/** @param {{ text: string }[]} sources */
const eventsOf = (sources) => [...sources.map((s) => failOf(s.text)), ...Object.keys(OTHER_EVENTS)];
const EVENTS = /** @type {Record<string, { name?: string, says?: string }>} */ ({
  ...Object.fromEntries(SOURCES.map((s, i) => [failOf(s.text), i === 0 ? { name: "A failed verification", says: "fail-def" } : { says: "fail-def" }])),
  ...OTHER_EVENTS,
});
const ALL = eventsOf(SOURCES);
const GONE = ["lost", "waiting"];
const OPEN = "restart-review-counts";

/**
 * The count's answer to a failed verification at the steps `phase`, by the count and the author.
 * @param {Phase[]} phase @param {string[]} event @param {When} when @param {Partial<Row>} third more for the third failure
 * @returns {Row[]}
 */
const counted = (phase, event, when = {}, third = {}) => [
  { names: ["Sent back", "A correction sent to a fresh agent"], phase, event, when: { ...when, count: [0], author: ["session", "dropped"] }, next: { phase: "work", count: 1, reds: 0 }, says: ["fail-def", "fail-exempt", "sent-first", "esc-stands", "esc-dropped", "corr-rule", "corr-judgment", "corr-count"] },
  { names: ["Escalation"], phase, event, when: { ...when, count: [0], author: ["cheaper"] }, next: { phase: "work", count: 1, author: "session", reds: 0 }, says: ["fail-def", "sent-first", "esc-applies", "esc-when", "esc-goes"] },
  { names: ["Restart"], phase, event, when: { ...when, count: [1] }, next: { phase: "work", count: 2, author: "session", reds: 0 }, says: ["fail-def", "sent-second", "restart-once", "restart-fresh", "esc-second"] },
  { phase, event, when: { ...when, count: [2] }, next: { phase: "stopped" }, says: ["fail-def", "sent-third", "sent-resets", ...(third.says ?? [])], ...(third.why ? { why: third.why } : {}) },
];

/**
 * The rows, built from what counts as a failed verification.
 * @param {{ text: string, at: Phase[] }[]} sources @param {number} exempt review rounds that do not count @param {number} tries at one failure
 * @returns {Row[]}
 */
function rowsFor(sources, exempt, tries) {
  const fails = sources.map((s) => failOf(s.text));
  /** @type {Row[]} */
  const rows = [];
  // Each source counts at the steps it comes at; the first review rounds are the work.
  for (const s of sources) {
    const event = [failOf(s.text)];
    for (const p of s.at) {
      if (s.text !== REVIEW) {
        rows.push(...counted([p], event).map((r) => (p === "gate" ? { ...r, says: [...(r.says ?? []), "gate-red"] } : r)));
        continue;
      }
      for (let r = 0; r < exempt; r++) rows.push({ phase: [p], event, when: { rounds: [r] }, next: { rounds: r + 1 }, says: ["fail-first-round"] });
      // The plain reading: the count is the task's, so a restart's one narrow review is a later round and a
      // finding in it is the third failure. Left open for the user, as its node.
      rows.push(...counted([p], event, { rounds: [exempt] }, { says: ["restart-design"], why: `plain reading, open as node ${OPEN}: the restart's narrow review counts` }));
    }
    const elsewhere = AT_WORK.filter((p) => !s.at.includes(p));
    if (elsewhere.length) rows.push({ phase: elsewhere, event, next: null, why: "this source comes at another step" });
  }
  // The agent's own red runs are no results; the last of its tries is its report that it cannot pass.
  for (let r = 0; r < tries - 1; r++) rows.push({ phase: ["work"], event: [OWN_RED], when: { reds: [r] }, next: { reds: r + 1 }, says: ["fail-own"] });
  rows.push(...counted(["work"], [OWN_RED], { reds: [tries - 1] }));
  rows.push({ phase: ["gate", "landing"], event: [OWN_RED], next: null, why: "the agent's own runs are its work" });
  rows.push(
    // The way forward.
    { phase: ["work"], event: ["green"], next: { phase: "gate" }, says: ["gate-rerun"] },
    { phase: ["gate"], event: ["green"], next: { phase: "landing" }, says: ["landing-order"] },
    { phase: ["landing"], event: ["green"], next: { phase: "landed" }, says: ["landing-order"] },
    // No failure.
    { phase: AT_WORK, event: ["timing"], when: { alone: false }, next: { alone: true }, says: ["fail-timing"] },
    { phase: AT_WORK, event: ["timing"], when: { alone: true }, next: null, why: "a run alone is under no load: its red is a failed verification" },
    { phase: ["landing"], event: ["conflict"], when: { others: false }, next: { phase: "work" }, outside: true, says: ["landing-suite"] },
    { phase: ["landing"], event: ["conflict"], when: { others: true, rebased: false }, next: { phase: "work", rebased: true }, says: ["landing-suite"] },
    { phase: ["landing"], event: ["conflict"], when: { others: true, rebased: true }, next: null, why: "the main branch holds still: the one more conflict has come" },
    { phase: ["work", "gate"], event: ["conflict"], next: null, why: "a conflict comes from the rebase, at landing" },
    { phase: AT_WORK, event: GONE, when: { others: false }, next: { phase: "lost", from: "here" }, outside: true, says: ["lost-none"] },
    { phase: AT_WORK, event: GONE, when: { others: true, tried: false }, next: { phase: "lost", from: "here" }, says: ["lost-none"] },
    { phase: AT_WORK, event: GONE, when: { others: true, tried: true }, next: { phase: "stopped" }, says: ["lost-try"] },
    { phase: ["lost"], event: ["resumed"], when: { others: false }, next: { phase: "from" }, outside: true, says: ["lost-resume"] },
    { phase: ["lost"], event: ["resumed"], when: { others: true }, next: { phase: "from", tried: true }, says: ["lost-try"] },
    // The last other task can stop while this one lands, as well as while it works or waits.
    { phase: [...AT_WORK, "lost"], event: ["others"], when: { others: false }, next: { others: true }, says: ["lost-try"] },
    { phase: [...AT_WORK, "lost"], event: ["others"], when: { others: true }, next: null, why: "the others have ended already" },
    { phase: ["lost"], event: [...fails, OWN_RED, "green", "timing", "conflict"], next: null, why: "no agent at work, no result" },
    { phase: ["lost"], event: GONE, next: null, why: "already lost or waiting" },
    { phase: AT_WORK, event: ["resumed"], next: null, why: "nothing was lost" },
    { phase: [...AT_WORK, "lost"], event: ["closing"], next: null, why: "the closing runs after every task has landed or stopped" },
    { phase: [...AT_WORK, "lost"], event: ["later"], next: null, why: "before it lands a defect is a finding of its round" },
    // Closed.
    { phase: ["landed"], event: ["closing"], next: { phase: "landed" }, says: ["landing-closing"] },
    { phase: ["landed"], event: ["timing"], next: { phase: "landed" }, says: ["landing-push"] },
    { phase: ["landed"], event: [...fails, "later"], next: { phase: "landed" }, says: ["landed-closed", "landed-later"] },
    { phase: ["landed"], event: [OWN_RED, "green", "lost", "waiting", "resumed", "others", "conflict"], next: null, why: "a landed task has no agent and no step left" },
    { phase: ["stopped"], event: eventsOf(sources), next: { phase: "stopped" }, says: ["stopped-user"] },
  );
  return rows;
}
const ROWS = rowsFor(SOURCES, EXEMPT_ROUNDS, TRIES);

/** How a task starts: who wrote it, and whether it is the last of the cycle's tasks (a run of one). */
const STARTS = /** @type {State[]} */ (
  ["session", "cheaper", "dropped"].flatMap((author) =>
    [false, true].map((others) => ({ phase: "work", count: 0, author, others, tried: false, alone: false, rounds: 0, reds: 0, rebased: false, from: null })),
  )
);
/** The longest path to an end, `outside` repeats left out: measured; a change to the rows that moves it moves this. */
const BOUND = 43;

/** @param {State} s */
const key = (s) => (ENDS.has(s.phase) ? s.phase : JSON.stringify(s));

/** @param {Row} r @param {State} s @param {string} e */
function matches(r, s, e) {
  if (!r.phase.includes(s.phase) || !r.event.includes(e)) return false;
  const w = r.when ?? {};
  for (const k of /** @type {const} */ (["count", "rounds", "reds"])) if (w[k] && !w[k].includes(s[k])) return false;
  if (w.author && !w.author.includes(s.author)) return false;
  for (const k of /** @type {const} */ (["others", "tried", "alone", "rebased"])) if (k in w && w[k] !== s[k]) return false;
  return true;
}

/** @param {State} s @param {Next} n @returns {State} */
function apply(s, n) {
  /** @type {State} */
  const out = { ...s, alone: false, ...n, phase: s.phase, from: s.phase === "lost" ? s.from : null };
  if (n.phase === "from") out.phase = /** @type {Phase} */ (s.from), out.from = null;
  else if (n.phase) out.phase = n.phase;
  if (n.from === "here") out.from = s.phase;
  return out;
}

/**
 * Walks the rows from the starts; returns what is open, one line each.
 * @param {Row[]} rows @param {State[]} starts @param {{ phases: string[], events: string[], late: string[], bound: number }} o `late`: events that come only after the task ended
 */
function walk(rows, starts, o) {
  const problems = [];
  /** @type {Map<string, State>} */
  const seen = new Map();
  /** @type {Map<string, { to: string, outside: boolean }[]>} */
  const edges = new Map();
  const used = new Set();
  /** Events some state before an end answers with a step: an event answered nowhere never happens. */
  const happens = new Set();
  const queue = [...starts];
  for (const s of starts) seen.set(key(s), s);
  while (queue.length) {
    const s = /** @type {State} */ (queue.shift());
    const out = [];
    for (const e of o.events) {
      const hit = rows.map((r, i) => ({ r, i })).filter(({ r }) => matches(r, s, e));
      if (hit.length === 0) problems.push(`no answer: ${key(s)} × ${e}`);
      else if (hit.length > 1) {
        const answers = new Set(hit.map(({ r }) => (r.next ? key(apply(s, r.next)) : "none")));
        problems.push(`${answers.size > 1 ? "two answers" : "answered twice"}: ${key(s)} × ${e}, rows ${hit.map(({ i }) => i).join(", ")}`);
      }
      for (const { r, i } of hit) {
        used.add(i);
        if (!r.next) continue;
        const n = apply(s, r.next);
        const k = key(n);
        if (!ENDS.has(s.phase)) out.push({ to: k, outside: Boolean(r.outside) }), happens.add(e);
        if (!seen.has(k)) seen.set(k, n), queue.push(n);
      }
    }
    edges.set(key(s), out);
  }
  rows.forEach((r, i) => used.has(i) || problems.push(`dead row: ${i}`));
  for (const e of o.events) if (!happens.has(e) && !o.late.includes(e)) problems.push(`never happens: ${e}`);
  const reached = new Set([...seen.values()].map((s) => s.phase));
  for (const p of o.phases) if (!reached.has(/** @type {Phase} */ (p))) problems.push(`unreachable: ${p}`);
  // Every state reaches an end, by any edges.
  for (const k of edges.keys()) {
    if (ENDS.has(/** @type {State} */ (seen.get(k)).phase)) continue;
    const look = [k];
    const been = new Set(look);
    let ends = false;
    while (look.length && !ends) {
      for (const { to } of edges.get(/** @type {string} */ (look.pop())) ?? []) {
        if (ENDS.has(to)) ends = true;
        else if (!been.has(to)) been.add(to), look.push(to);
      }
    }
    if (!ends) problems.push(`no end: ${k}`);
  }
  // Without the outside repeats no path loops, and the longest is within the bound.
  /** @type {Map<string, number>} */
  const depth = new Map();
  const onPath = new Set();
  /** @param {string} k @returns {number} */
  const longest = (k) => {
    if (ENDS.has(k)) return 0;
    const known = depth.get(k);
    if (known !== undefined) return known;
    if (onPath.has(k)) return problems.push(`a loop: ${k}`), 0;
    onPath.add(k);
    let most = 0;
    for (const { to, outside } of edges.get(k) ?? []) if (!outside) most = Math.max(most, 1 + longest(to));
    onPath.delete(k);
    depth.set(k, most);
    return most;
  };
  const most = Math.max(0, ...starts.map((s) => longest(key(s))), ...[...edges.keys()].map(longest));
  if (most > o.bound) problems.push(`longer than ${o.bound}: ${most} steps`);
  return { problems, most, states: seen.size };
}

const OPTIONS = { phases: Object.keys(PHASES), events: ALL, late: ["closing", "later"], bound: BOUND };

test("method walk: the failure count's data answers every pair it reaches once, and every path ends within the bound", () => {
  const { problems, most } = walk(ROWS, STARTS, OPTIONS);
  assert.deepEqual(problems, []);
  assert.equal(most, BOUND, "the bound is the measured longest path: a change that shortens it moves BOUND too");
});

/**
 * The section's sentences by unit, in order: a table row's state, a paragraph's bold lead, else its first
 * three words. The bold names, as written, are kept apart.
 * @param {string} section
 */
function units(section) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const line of section.split(/\r?\n/).slice(1)) {
    if (!line.trim() || /^\| *(State *\||-)/.test(line)) continue;
    const row = /^\| \*\*([^*]+)\*\* \| (.*) \|$/.exec(line);
    const lead = /^\*\*([^*]+)\.\*\* (.*)$/.exec(line);
    const bold = /^\*\*([^*]+)\*\* /.exec(line);
    const [unit, text] = row ? [row[1], row[2]] : lead ? [lead[1], lead[2]] : bold ? [bold[1], line] : [line.split(" ").slice(0, 3).join(" "), line];
    out.set(unit, [...(out.get(unit) ?? []), ...text.replace(/\*\*/g, "").split(/(?<=\.)\s+(?=[A-Z])/)]);
  }
  return out;
}

/**
 * What of the section the data does not claim, and what of the data the section does not hold, one line each.
 * @param {string} section @param {Row[]} rows @param {Record<string, [string, string]>} sentences @param {string[]} narrative
 */
function pointers(section, rows, sentences = SENTENCES, narrative = NARRATIVE) {
  const wrong = [];
  const prose = units(section);
  /** @type {Map<string, string[]>} */
  const data = new Map();
  for (const [unit, text] of Object.values(sentences)) data.set(unit, [...(data.get(unit) ?? []), text]);
  for (const [unit, said] of prose) {
    const claimed = data.get(unit) ?? [];
    for (const s of said) if (!claimed.includes(s)) wrong.push(`a sentence the data does not claim: ${unit}: ${s}`);
    for (const s of claimed) if (!said.includes(s)) wrong.push(`a sentence of the data not in the prose: ${unit}: ${s}`);
    if (claimed.every((s) => said.includes(s)) && said.every((s) => claimed.includes(s)) && claimed.join("\n") !== said.join("\n")) wrong.push(`the sentences of ${unit} stand in another order`);
  }
  for (const unit of data.keys()) if (!prose.has(unit)) wrong.push(`a unit of the data the prose lacks: ${unit}`);
  // Each sentence is read by a row, a phase or an event, or is narrative; never both, never neither.
  const kinds = [...Object.values(PHASES), ...Object.values(EVENTS)];
  const read = new Set([...rows.flatMap((r) => r.says ?? []), ...kinds.flatMap((x) => (x.says ? [x.says] : []))]);
  for (const id of read) if (!(id in sentences)) wrong.push(`a row reads a sentence that is not there: ${id}`);
  for (const id of Object.keys(sentences)) {
    if (read.has(id) === narrative.includes(id)) wrong.push(`${read.has(id) ? "a narrative sentence a row reads" : "a sentence neither read nor narrative"}: ${id}`);
  }
  // The states: each bold name of the section is in the data, and each the data names is bold there.
  const named = new Set([...section.matchAll(/\*\*([^*\n]+?)\.?\*\*/g)].map((m) => m[1]));
  const names = new Set([...rows.flatMap((r) => r.names ?? []), ...kinds.flatMap((x) => (x.name ? [x.name] : []))]);
  for (const n of named) if (!names.has(n)) wrong.push(`the prose names a state the data lacks: ${n}`);
  for (const n of names) if (!named.has(n)) wrong.push(`the data names a state the prose does not: ${n}`);
  // The count's numbers: the fail row at count n reads the sentence that opens with the nth word.
  for (const r of rows.filter((r) => r.next && r.event.some((e) => e.startsWith("fail: ") || e === OWN_RED) && r.when?.count)) {
    for (const c of r.when?.count ?? []) if (!(r.says ?? []).some((id) => sentences[id]?.[1].startsWith(`${NTH[c]}${c === 0 ? " failure" : ""}:`))) wrong.push(`the fail row at count ${c} does not read "${NTH[c]}"`);
  }
  return wrong;
}

function section() {
  const text = readFileSync(join(ROOT, BRIEF), "utf8");
  const start = text.indexOf(FROM);
  const end = text.indexOf(TO, start);
  assert.ok(start >= 0 && end > start, `${BRIEF}: no section from "${FROM}" to "${TO}"`);
  return text.slice(start, end);
}

test("method walk: every sentence of task-brief.md's failure count is claimed by the data under its row, and each state it names is in the data", () => {
  assert.deepEqual(pointers(section(), ROWS), []);
});

test("method walk pointer control: a sentence or clause added, a sentence gone or moved, a state either side lacks, a count word unread are each reported", () => {
  const real = section();
  const says = (/** @type {string} */ s, /** @type {Row[]} */ rows = ROWS) => pointers(s, rows);
  const has = (/** @type {string[]} */ got, /** @type {string} */ start) => got.some((w) => w.startsWith(start));
  // Review round two: a checkout with CRLF line ends reads as the same section.
  assert.deepEqual(says(real.replace(/\n/g, "\r\n")), []);
  // Review round one: rules added to the section passed when only known phrases were looked for.
  assert.ok(has(says(real.replace("A red suite counts;", "A red suite counts, and a second red suite stops it;")), "a sentence the data does not claim: Landing: A red suite counts, and a second"));
  assert.ok(has(says(real.replace("Closed: restart and stop no longer apply.", "Closed: restart and stop no longer apply. A revert reopens it at its count.")), "a sentence the data does not claim: Landed: A revert reopens"));
  assert.ok(has(says(real.replace("still red after three tries", "still red after five tries")), "a sentence the data does not claim: A failed verification: A failed verification is"));
  assert.ok(has(says(real.replace("Once per task.", "Twice per task.")), "a sentence of the data not in the prose: Restart: Once per task."));
  // A sentence moved to another row: the same words, under another state.
  assert.ok(has(says(real.replace(" Once per task. ", " ").replace("Closed: restart", "Once per task. Closed: restart")), "a sentence the data does not claim: Landed: Once per task."));
  assert.ok(has(says(real.replace("Second: restart. Third or later: stopped.", "Third or later: stopped. Second: restart.")), "the sentences of Sent back stand in another order"));
  assert.ok(says(real.replace("| **Stopped** |", "| **Parked** | waits |\n| **Stopped** |")).includes("the prose names a state the data lacks: Parked"));
  assert.ok(says(real.replaceAll("**Stopped**", "Stopped")).includes("the data names a state the prose does not: Stopped"));
  const shifted = ROWS.map((r) => (r.names?.includes("Restart") && r.event.includes(failOf(REVIEW)) ? { ...r, says: (r.says ?? []).filter((id) => id !== "sent-second") } : r));
  assert.ok(says(real, shifted).includes('the fail row at count 1 does not read "Second"'));
  const inside = ROWS.map((r) => (r.names?.includes("Restart") ? { ...r, says: [...(r.says ?? []).filter((id) => id !== "sent-second"), "x"] } : r));
  assert.ok(pointers(real, inside, { ...SENTENCES, x: ["Sent back", "Then Second: restart."] }).includes('the fail row at count 1 does not read "Second"'));
  assert.ok(says(real, [...ROWS, { phase: ["stopped"], event: [], next: null, says: ["no-such"] }]).includes("a row reads a sentence that is not there: no-such"));
  assert.ok(says(real.replace(/\| \*\*Landed\*\* \|.*\n/, "")).includes("a unit of the data the prose lacks: Landed"));
  assert.ok(pointers(real, ROWS, SENTENCES, [...NARRATIVE, "sent-third"]).includes("a narrative sentence a row reads: sent-third"));
  assert.ok(pointers(real, ROWS, SENTENCES, NARRATIVE.filter((id) => id !== "intro")).includes("a sentence neither read nor narrative: intro"));
});

test("method walk control: the walk reports a pair with no answer, two answers, a loop, an unreachable state and a dead row", () => {
  const got = (/** @type {Row[]} */ rows, /** @type {Partial<typeof OPTIONS>} */ o = {}) => walk(rows, STARTS, { ...OPTIONS, ...o }).problems;
  // An unanswered pair: the lost task after its one more try.
  const unanswered = got(ROWS.filter((r) => !(r.event.includes("lost") && r.when?.tried === true)));
  assert.ok(unanswered.some((p) => p.startsWith("no answer:") && p.endsWith("× lost")), unanswered.join("\n"));
  // Two rows that answer one pair differently, and one that answers it the same way twice.
  const two = got([...ROWS, { phase: ["landing"], event: ["conflict"], next: { phase: "stopped" } }]);
  assert.ok(two.some((p) => p.startsWith("two answers:") && p.includes("× conflict")), two.join("\n"));
  const twice = got([...ROWS, { phase: ["landing"], event: ["conflict"], when: { others: false }, next: { phase: "work" }, outside: true }]);
  assert.ok(twice.some((p) => p.startsWith("answered twice:")), twice.join("\n"));
  // A loop that no outside cause bounds: a conflict the walk must count. Review round one: a conflict
  // marked outside after the others ended hid the loop it makes.
  const loop = got(ROWS.map((r) => (r.event.includes("conflict") && r.outside ? { ...r, outside: false } : r)));
  assert.ok(loop.some((p) => p.startsWith("a loop:")), loop.join("\n"));
  const held = got(ROWS.map((r) => (r.event.includes("conflict") && r.when?.rebased === false ? { ...r, next: { phase: /** @type {Phase} */ ("work") } } : r)));
  assert.ok(held.some((p) => p.startsWith("a loop:")), held.join("\n"));
  // A state no path reaches, and a row no state matches.
  const unreached = got(ROWS, { phases: [...OPTIONS.phases, "parked"] });
  assert.ok(unreached.includes("unreachable: parked"), unreached.join("\n"));
  const dead = got([...ROWS, { phase: ["landed"], event: ["fail"], when: { count: [7] }, next: { phase: "landed" } }]);
  assert.ok(dead.some((p) => p.startsWith("dead row:")), dead.join("\n"));
  // A state with no way to an end: a lost task that only waits, and a path past the bound.
  const nowhere = got(ROWS.map((r) => (r.event.includes("resumed") && r.next ? { ...r, next: { phase: /** @type {Phase} */ ("lost") } } : r)));
  assert.ok(nowhere.some((p) => p.startsWith("no end:")), nowhere.join("\n"));
  assert.ok(got(ROWS, { bound: BOUND - 1 }).includes(`longer than ${BOUND - 1}: ${BOUND} steps`));
});

test("method walk sources control: the counts and sources of a failed verification drive the walk", () => {
  const loose = { ...OPTIONS, bound: Infinity };
  const base = walk(rowsFor(SOURCES, EXEMPT_ROUNDS, TRIES), STARTS, OPTIONS).most;
  for (const [exempt, tries] of [[EXEMPT_ROUNDS + 1, TRIES], [EXEMPT_ROUNDS, TRIES + 1]]) {
    const other = walk(rowsFor(SOURCES, exempt, tries), STARTS, loose);
    assert.deepEqual(other.problems, []);
    assert.ok(other.most > base);
  }
  // One path, step by step: the tries-th own red run is the report and counts, and the tries start again
  // at the next failure; the exempt rounds pass uncounted and the next round counts.
  for (const tries of [TRIES, TRIES + 1]) {
    const rows = rowsFor(SOURCES, EXEMPT_ROUNDS, tries);
    let s = STARTS[0];
    const step = (/** @type {string} */ e) => {
      const hit = rows.filter((r) => matches(r, s, e));
      assert.equal(hit.length, 1, `${key(s)} × ${e}`);
      s = apply(s, /** @type {Next} */ (hit[0].next));
    };
    for (let i = 1; i < tries; i++) step(OWN_RED), assert.equal(s.count, 0);
    step(OWN_RED);
    assert.equal(s.count, 1);
    for (let i = 1; i < tries; i++) step(OWN_RED), assert.equal(s.count, 1);
    for (let i = 0; i < EXEMPT_ROUNDS; i++) step(failOf(REVIEW)), assert.equal(s.count, 1);
    step(failOf(REVIEW));
    assert.equal(s.count, 2);
  }
  // A source the walk takes at no step never happens; one left out of the rows is answered nowhere.
  const lone = [...SOURCES, { text: "a lint warning", at: /** @type {Phase[]} */ ([]) }];
  assert.ok(walk(rowsFor(lone, EXEMPT_ROUNDS, TRIES), STARTS, { ...OPTIONS, events: eventsOf(lone) }).problems.includes("never happens: fail: a lint warning"));
  assert.ok(walk(rowsFor(SOURCES.slice(0, -1), EXEMPT_ROUNDS, TRIES), STARTS, OPTIONS).problems.some((p) => p.startsWith("no answer:") && p.endsWith("× fail: the landing suite")));
});
