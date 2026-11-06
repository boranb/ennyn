/**
 * Mechanization slot: one task per cycle turns a recurring defect class into a
 * gate, test, type or lint. This module loads the work graph and picks the
 * best ready node flagged `mechanization: true`, and for the core slots the
 * oldest node of the highest value (pickOldest).
 *
 * Ready = flagged, not done, not declined, gate open (or no gate field), every `needs` id done
 * (listed in the done export, or an open node carrying the done status).
 * Score = value / cost, value and cost words mapped to their weights;
 * ties break by id so the pick is deterministic.
 */

import { statSync } from "node:fs";
import { readRegular } from "../core/files.mjs";
import { UNSHOWN } from "../core/i18n.mjs";

/** Runs of what a report line cannot show (core/i18n.mjs), each made one space in a place a problem names. */
const UNSHOWN_RUN = new RegExp(`(?:${UNSHOWN.source})+`, "gu");
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {Record<string, unknown>} GraphNode */
/** @typedef {{ open: GraphNode[], done: GraphNode[], declined?: GraphNode[] }} Graph a graph built in code may have no declined list */

/** A byte order mark some editors write at the start of a file; JSON.parse rejects it. */
const BOM = /^\uFEFF/;

export class GraphError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GraphError";
  }
}

/**
 * @param {{ cwd: string, config: any }} opts
 * @returns {Promise<Graph>}
 */
export async function loadGraph({ cwd, config }) {
  const path = resolve(cwd, config.paths.graph);
  // Read as a regular file below the project through no link a commit may hold, a module too before it is imported.
  let bytes;
  try {
    bytes = readRegular(cwd, path);
  } catch (err) {
    throw new GraphError(`work graph ${/** @type {Error} */ (err).message}`);
  }
  if (bytes === null) throw new GraphError(`work graph not found: ${path}`);
  const { open: openName, done: doneName, declined: declinedName } = config.graph.exports;
  /** @type {Record<string, unknown>} */
  let data;
  const ext = extname(path);
  if (ext === ".json") {
    try {
      data = JSON.parse(bytes.toString("utf8").replace(BOM, ""));
    } catch (err) {
      throw new GraphError(`cannot parse ${path}: ${/** @type {Error} */ (err).message}`);
    }
  } else if (ext === ".mjs" || ext === ".js") {
    // The mtime query defeats the module cache when a long-lived process reloads an edited graph.
    const url = pathToFileURL(path);
    url.searchParams.set("mtime", String(statSync(path).mtimeMs));
    try {
      data = await import(url.href);
    } catch (err) {
      throw new GraphError(`cannot load ${path}: ${/** @type {Error} */ (err).message}`);
    }
    // Each array from its named export, else from the default export: `export default { … }`, or
    // module.exports in a CommonJS package, whose names Node detects only in part (`nodes` but not `done`).
    const fallback = /** @type {Record<string, unknown>} */ (data).default;
    if (fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)) {
      const own = /** @type {Record<string, unknown>} */ (data);
      const def = /** @type {Record<string, unknown>} */ (fallback);
      // An array only: a default export about something else (a title, a count) is not read as the graph.
      const pick = (/** @type {string} */ name) => own[name] ?? (Array.isArray(def[name]) ? def[name] : undefined);
      data = { [openName]: pick(openName), [doneName]: pick(doneName), [declinedName]: pick(declinedName) };
    }
  } else {
    throw new GraphError(`work graph must be .json, .mjs or .js: ${path}`);
  }
  const open = data?.[openName];
  if (!Array.isArray(open)) throw new GraphError(`work graph ${path} has no "${openName}" array (graph.exports.open)`);
  const done = data[doneName] ?? [];
  if (!Array.isArray(done)) throw new GraphError(`work graph ${path}: "${doneName}" must be an array (graph.exports.done)`);
  // The nodes refused, each with its reason: never picked, and none other may need one (graphProblems).
  const declined = data[declinedName] ?? [];
  if (!Array.isArray(declined)) throw new GraphError(`work graph ${path}: "${declinedName}" must be an array (graph.exports.declined)`);
  // A null or a string where a node belongs would crash every reader later; say where it is now.
  for (const [name, list] of [[openName, open], [doneName, done], [declinedName, declined]]) {
    const at = list.findIndex((/** @type {unknown} */ n) => n === null || typeof n !== "object" || Array.isArray(n));
    if (at !== -1) throw new GraphError(`work graph ${path}: "${name}"[${at}] is not an object`);
  }
  return { open: /** @type {GraphNode[]} */ (open), done: /** @type {GraphNode[]} */ (done), declined: /** @type {GraphNode[]} */ (declined) };
}

/**
 * The ids of the declined nodes.
 * @param {Graph} graph
 * @param {any} config
 */
const declinedIds = (graph, config) => new Set((graph.declined ?? []).map((n) => n[config.graph.fields.id]));

/** What a value word weighs; a number is its own weight. */
const VALUE_WEIGHTS = { high: 3, medium: 2, low: 1 };
/** What a cost word weighs; a number is its own weight. */
const COST_WEIGHTS = { S: 1, M: 2, L: 3, XL: 5 };
/** The middle of the cost words' weights: L and XL are split first. */
const SPLIT_AT = 2.5;

/**
 * A value or cost as a positive weight; null when it is neither a positive number nor a word the scale gives one.
 * @param {unknown} v
 * @param {Record<string, number>} scale
 * @returns {number | null}
 */
function known(v, scale) {
  const n = typeof v === "number" ? v : typeof v === "string" && Object.hasOwn(scale, v) ? scale[v] : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {unknown} v @param {Record<string, number>} scale */
const weight = (v, scale) => known(v, scale) ?? 1;

/**
 * value / cost. Unknown or non-positive weights count as 1 (graphProblems warns about each).
 * @param {GraphNode} node
 * @param {any} config
 */
export function scoreNode(node, config) {
  const f = config.graph.fields;
  return weight(node[f.value], VALUE_WEIGHTS) / weight(node[f.cost], COST_WEIGHTS);
}

/**
 * A node's cost as a weight (unknown counts as 1, as in the score).
 * @param {GraphNode} node
 * @param {any} config
 */
export function costWeight(node, config) {
  return weight(node[config.graph.fields.cost], COST_WEIGHTS);
}

/**
 * The weight above which a core pick is split first: planner.splitAbove when set (costs given as numbers,
 * such as hours), else SPLIT_AT.
 * @param {any} config
 */
export const splitAt = (config) => config.planner.splitAbove ?? SPLIT_AT;

/**
 * Whether a core pick is split first: its cost weighs more than splitAt, and more than S, so a step written at
 * the smallest cost is never told to split again.
 * @param {GraphNode} node
 * @param {any} config
 */
export function splitFirst(node, config) {
  const w = costWeight(node, config);
  return w > splitAt(config) && w > COST_WEIGHTS.S;
}

/**
 * A node's `needs` as a list (a single id is allowed).
 * @param {GraphNode} node
 * @param {any} config
 * @returns {unknown[]}
 */
export function needsOf(node, config) {
  const raw = node[config.graph.fields.needs] ?? [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Open nodes that can start now (not done, not declined, gate open, every need done), best first.
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphNode[]}
 */
export function readyNodes(graph, config) {
  const f = config.graph.fields;
  const { doneStatus, openGateValue } = config.graph;
  const doneIds = new Set(graph.done.map((n) => n[f.id]));
  for (const n of graph.open) if (n[f.status] === doneStatus) doneIds.add(n[f.id]);
  const declined = declinedIds(graph, config);

  const ready = graph.open.filter((n) => {
    if (n[f.status] === doneStatus || declined.has(n[f.id])) return false;
    const gate = n[f.gate];
    if (gate !== undefined && gate !== openGateValue) return false;
    return needsOf(n, config).every((id) => doneIds.has(id));
  });

  const scored = ready.map((node) => ({ node, score: scoreNode(node, config), id: String(node[f.id]) }));
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.map((s) => s.node);
}

/**
 * @typedef {{ level: "fail" | "warn", key: string, vars: import("../core/i18n.mjs").Vars }} GraphProblem
 */

/**
 * What makes the graph unfit to pick from, and what the pick reads on a guess. The pick reads the open
 * nodes that are not done: a problem there that could change it is a `fail` (a node with no id, an id
 * twice, as when a finished node stays open or a declined one is listed elsewhere too, a need no node has, a
 * need on a declined node, needs that wait on each other). The same kind of problem among finished nodes only
 * is a `warn`, and so is a declined node with no reason, and a guess: a value or cost the scales do not know,
 * or a node with no value or cost where others have one (each scored as 1), among the core nodes a date that
 * is no number or none where others have one (the core pick reads each as the newest) and a cost given as a
 * number with no planner.splitAbove, a mechanization flag that is not a boolean, and a gate that looks like
 * "no gate" (null, false, "", 0, "false") but is not the open value, unless the open value is a boolean (then
 * false is that project's closed value). doctor lists every one; the core and mechanization commands refuse a
 * graph with a fail, so they never disagree on what can be picked. Message keys, rendered by the caller.
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphProblem[]}
 */
export function graphProblems(graph, config) {
  const f = config.graph.fields;
  const { doneStatus, openGateValue } = config.graph;
  /** @type {GraphProblem[]} */
  const out = [];
  const named = (/** @type {GraphNode} */ n) => {
    const id = n[f.id];
    return (typeof id === "string" && id.trim() !== "") || (typeof id === "number" && Number.isFinite(id));
  };
  // Where the items come from (graph.fields.source, "ROADMAP.md:12"): a graph module reads the project's own
  // files, and the cause of a problem in its items is there, not in the module. One line each, cut at 120
  // characters; "?" for an item with no source, each its own; the same place twice is "×2" (the module read it
  // twice, or two items share it). Those marks come first, so the cut at three places never hides them.
  // " · " parts the places: a source written as text may hold a comma.
  const line = (/** @type {unknown} */ v) => {
    const one = [...String(v).replace(UNSHOWN_RUN, " ").trim()];
    return one.length > 120 ? `${one.slice(0, 119).join("")}…` : one.join("");
  };
  const place = (/** @type {GraphNode} */ n) => (typeof n[f.source] === "string" ? line(n[f.source]) : "");
  const has = (/** @type {GraphNode} */ n) => place(n) !== "";
  const places = (/** @type {GraphNode[]} */ nodes) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const n of nodes.filter(has)) seen.set(place(n), (seen.get(place(n)) ?? 0) + 1);
    const twice = [...seen].filter(([, k]) => k > 1).map(([p, k]) => `${p} ×${k}`);
    const parts = [...twice, ...nodes.filter((n) => !has(n)).map(() => "?"), ...[...seen].filter(([, k]) => k === 1).map(([p]) => p)];
    return [...parts.slice(0, 3), ...(parts.length > 3 ? [`+${parts.length - 3}`] : [])].join(" · ");
  };
  const where = (/** @type {GraphNode[]} */ nodes) => (nodes.some(has) ? ` (${places(nodes)})` : "");
  /** Per id, its places: at most four ids. @param {unknown[]} ids @param {GraphNode[]} nodes */
  const whereById = (ids, nodes) => {
    if (!nodes.some(has)) return "";
    const each = ids.slice(0, 4).map((id) => `${line(id)}: ${places(nodes.filter((n) => n[f.id] === id))}`);
    return ` (${[...each, ...(ids.length > 4 ? ["…"] : [])].join("; ")})`;
  };
  const waitingNodes = graph.open.filter((n) => n[f.status] !== doneStatus);
  const finished = [...graph.done, ...graph.open.filter((n) => n[f.status] === doneStatus)];
  const declined = graph.declined ?? [];
  for (const [list, level] of /** @type {const} */ ([[waitingNodes, "fail"], [[...finished, ...declined], "warn"]])) {
    const missing = list.filter((n) => !named(n));
    if (missing.length) out.push({ level, key: "doctor.idMissing", vars: { n: missing.length, field: f.id, where: where(missing) } });
  }
  /** @type {Map<unknown, number>} */
  const seen = new Map();
  const all = [...waitingNodes, ...finished, ...declined];
  for (const n of all) if (named(n)) seen.set(n[f.id], (seen.get(n[f.id]) ?? 0) + 1);
  // A declined id elsewhere too, or twice, says both "refused" and something else: the pick cannot tell which.
  const refused = declinedIds(graph, config);
  const waitingIds = new Set(waitingNodes.filter(named).map((n) => n[f.id]));
  const dupes = [...seen].filter(([, c]) => c > 1).map(([id]) => id);
  const pickReads = (/** @type {unknown} */ id) => waitingIds.has(id) || refused.has(id);
  for (const [ids, level] of /** @type {const} */ ([[dupes.filter(pickReads), "fail"], [dupes.filter((id) => !pickReads(id)), "warn"]])) {
    const holders = all.filter((n) => named(n) && ids.includes(n[f.id]));
    if (ids.length) out.push({ level, key: "doctor.idDuplicate", vars: { list: ids.map(String), where: whereById(ids, holders) } });
  }
  // A need on a declined node never opens, and dropping it would start the node with no word: refused, by name.
  for (const n of waitingNodes) {
    const needs = needsOf(n, config);
    const gone = needs.filter((id) => refused.has(id));
    if (gone.length) out.push({ level: "fail", key: "doctor.needsDeclined", vars: { id: String(n[f.id]), list: gone.map(String), where: where([n]) } });
    const unknown = needs.filter((id) => !seen.has(id));
    if (unknown.length) out.push({ level: "fail", key: "doctor.needsUnknown", vars: { id: String(n[f.id]), list: unknown.map(String), where: where([n]) } });
  }
  const reasoned = (/** @type {unknown} */ r) => typeof r === "string" && r.trim() !== "";
  const unreasoned = declined.filter((n) => named(n) && !reasoned(n[f.reason]));
  if (unreasoned.length) out.push({ level: "warn", key: "doctor.declinedReason", vars: { n: unreasoned.length, field: f.reason, list: unreasoned.map((n) => String(n[f.id])) } });
  // A cycle among waiting nodes never opens. Depth first with a stack of its own: a needs chain thousands
  // long would overflow the call stack.
  const waiting = new Map(waitingNodes.filter(named).map((n) => [n[f.id], n]));
  /** @type {Map<unknown, "open" | "closed">} */
  const state = new Map();
  /** @type {unknown[] | null} */
  let cycle = null;
  for (const root of waiting.keys()) {
    if (cycle || state.has(root)) continue;
    /** @type {{ id: unknown, needs: unknown[], next: number }[]} */
    const stack = [{ id: root, needs: needsOf(/** @type {GraphNode} */ (waiting.get(root)), config), next: 0 }];
    state.set(root, "open");
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      if (top.next >= top.needs.length) {
        state.set(top.id, "closed");
        stack.pop();
        continue;
      }
      const need = top.needs[top.next++];
      // A done node, or one that is not there, ends the path.
      if (!waiting.has(need) || state.get(need) === "closed") continue;
      if (state.get(need) === "open") {
        cycle = [...stack.slice(stack.findIndex((s) => s.id === need)).map((s) => s.id), need];
        break;
      }
      state.set(need, "open");
      stack.push({ id: need, needs: needsOf(/** @type {GraphNode} */ (waiting.get(need)), config), next: 0 });
    }
  }
  if (cycle) {
    const ring = [...new Set(cycle)];
    out.push({ level: "fail", key: "doctor.needsCycle", vars: { cycle: cycle.map(String).join(" → "), where: whereById(ring, ring.map((id) => /** @type {GraphNode} */ (waiting.get(id)))) } });
  }
  for (const [field, scale] of /** @type {[string, Record<string, number>][]} */ ([[f.value, VALUE_WEIGHTS], [f.cost, COST_WEIGHTS]])) {
    for (const n of waitingNodes) {
      const v = n[field];
      if (v !== undefined && known(v, scale) === null) out.push({ level: "warn", key: "doctor.weightUnknown", vars: { id: String(n[f.id]), field, value: String(v), words: Object.keys(scale).join(", ") } });
    }
    // A graph that never names a cost compares values alone; one that names it for some nodes guesses for the rest.
    const absent = waitingNodes.filter((n) => n[field] === undefined).length;
    if (absent && absent < waitingNodes.length) out.push({ level: "warn", key: "doctor.weightAbsent", vars: { n: absent, field } });
  }
  // What the core pick reads on a guess, among the nodes it reads: a date that is no number (said even when
  // every node has one), no date where others have one, a cost in numbers with no split threshold set.
  const core = waitingNodes.filter((n) => n[f.mechanization] !== true);
  const unread = core.filter((n) => n[f.since] !== undefined && sinceOf(n, config) === null);
  if (unread.length) {
    const v = unread[0][f.since];
    out.push({ level: "warn", key: "doctor.sinceUnread", vars: { n: unread.length, field: f.since, id: String(unread[0][f.id]), value: JSON.stringify(v) ?? String(v) } });
  }
  const absent = core.filter((n) => n[f.since] === undefined).length;
  if (absent && core.some((n) => sinceOf(n, config) !== null)) out.push({ level: "warn", key: "doctor.sinceUneven", vars: { n: absent, field: f.since } });
  const hours = core.filter((n) => known(n[f.cost], {}) !== null).length;
  if (hours && config.planner.splitAbove === null) out.push({ level: "warn", key: "doctor.splitAboveUnset", vars: { n: hours, field: f.cost, at: splitAt(config) } });
  for (const n of waitingNodes) {
    if (f.mechanization in n && typeof n[f.mechanization] !== "boolean") {
      out.push({ level: "warn", key: "doctor.flagNotBoolean", vars: { id: String(n[f.id]), field: f.mechanization, value: JSON.stringify(n[f.mechanization]) } });
    }
    // These read as "no gate" to a person and as a closed gate to the pick. Where the open value is a
    // boolean, false is that project's plain closed value.
    const gate = n[f.gate];
    if (typeof openGateValue !== "boolean" && gate !== openGateValue && (gate === null || gate === false || gate === "" || gate === 0 || gate === "false")) {
      out.push({ level: "warn", key: "doctor.gateFalse", vars: { id: String(n[f.id]), field: f.gate, value: JSON.stringify(gate), open: JSON.stringify(openGateValue) } });
    }
  }
  return out;
}

/**
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphNode[]} ready mechanization nodes, best first
 */
export function readyMechanization(graph, config) {
  return readyNodes(graph, config).filter((n) => n[config.graph.fields.mechanization] === true);
}

/**
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphNode | null}
 */
export function pickMechanization(graph, config) {
  return readyMechanization(graph, config)[0] ?? null;
}

/**
 * A node's date, when the graph dates its nodes (graph.fields.since): a finite number, such as a cycle or
 * Date.getTime(); smaller is older. Anything else is no date: text has no one order (graphProblems says so).
 * @param {GraphNode} node
 * @param {any} config
 * @returns {number | null}
 */
export function sinceOf(node, config) {
  const v = node[config.graph.fields.since];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Nodes oldest first, as `pickOldest` reads them: the dated by their date, then the undated as the newest;
 * between equal dates and among the undated, the list's order, as a graph is written by appending.
 * @param {GraphNode[]} nodes
 * @param {any} config
 * @returns {GraphNode[]}
 */
export function byAge(nodes, config) {
  const at = nodes.map((n, i) => ({ n, i, d: sinceOf(n, config) }));
  at.sort((a, b) => (a.d === null || b.d === null ? (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) : a.d - b.d) || a.i - b.i);
  return at.map((e) => e.n);
}

/**
 * The core slot that ages: value/cost never picks a large node while small ones score as well (replayed
 * at the start of Ennyn's cycles 1-12, plugin-eval, high and L, sank from 5th to 92nd of the ready core
 * nodes). This slot takes the oldest node (byAge) of the highest value. A node that waits on open needs
 * gives the slot the nearest ready one, the needs in their listed order, so a first step split from a large
 * node and needed by it keeps that node's age. Flagged nodes are the mechanization slot's: never a pick,
 * though a way may pass one; a closed gate ends a way. Each node is grouped by value once, and one already
 * walked to nothing is not walked again: the pick is linear in the graph.
 * @param {Graph} graph
 * @param {any} config
 * @returns {{ node: GraphNode, oldest: GraphNode } | null} the node to work, and the old node it serves (the same one when it is ready)
 */
export function pickOldest(graph, config) {
  const f = config.graph.fields;
  const { doneStatus, openGateValue } = config.graph;
  const core = (/** @type {GraphNode} */ n) => n[f.mechanization] !== true;
  const ready = new Set(readyNodes(graph, config).filter(core));
  const declined = declinedIds(graph, config);
  const waiting = graph.open.filter((n) => n[f.status] !== doneStatus && !declined.has(n[f.id]));
  const byId = new Map(waiting.map((n) => [n[f.id], n]));
  const gateOpen = (/** @type {GraphNode} */ n) => n[f.gate] === undefined || n[f.gate] === openGateValue;
  /** @type {Map<number, GraphNode[]>} */
  const levels = new Map();
  for (const n of byAge(waiting, config)) {
    if (!core(n) || !gateOpen(n)) continue;
    const w = weight(n[f.value], VALUE_WEIGHTS);
    const level = levels.get(w);
    if (level) level.push(n);
    else levels.set(w, [n]);
  }
  /** @type {Set<GraphNode>} */
  const dead = new Set();
  for (const w of [...levels.keys()].sort((a, b) => b - a)) {
    for (const oldest of /** @type {GraphNode[]} */ (levels.get(w))) {
      // Breadth first with a queue of its own: the nearest ready need, and no call stack for a long chain.
      const queue = [oldest];
      const seen = new Set(queue);
      for (let i = 0; i < queue.length; i++) {
        if (ready.has(queue[i])) return { node: queue[i], oldest };
        for (const id of needsOf(queue[i], config)) {
          const need = byId.get(id);
          if (need && !seen.has(need) && !dead.has(need) && gateOpen(need)) seen.add(need), queue.push(need);
        }
      }
      for (const n of queue) dead.add(n);
    }
  }
  return null;
}
