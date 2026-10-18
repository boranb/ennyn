/**
 * Mechanization slot: one task per cycle turns a recurring defect class into a
 * gate, test, type or lint. This module loads the work graph and picks the
 * best ready node flagged `mechanization: true`.
 *
 * Ready = flagged, not done, gate open (or no gate field), every `needs` id done
 * (listed in the done export, or an open node carrying the done status).
 * Score = value / cost, categorical values mapped through the configured scales;
 * ties break by id so the pick is deterministic.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {Record<string, unknown>} GraphNode */
/** @typedef {{ open: GraphNode[], done: GraphNode[] }} Graph */

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
  if (!existsSync(path)) throw new GraphError(`work graph not found: ${path}`);
  const { open: openName, done: doneName } = config.graph.exports;
  /** @type {Record<string, unknown>} */
  let data;
  const ext = extname(path);
  if (ext === ".json") {
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
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
  } else {
    throw new GraphError(`work graph must be .json, .mjs or .js: ${path}`);
  }
  const open = data?.[openName];
  if (!Array.isArray(open)) throw new GraphError(`work graph ${path} has no "${openName}" array (graph.exports.open)`);
  const done = data[doneName] ?? [];
  if (!Array.isArray(done)) throw new GraphError(`work graph ${path}: "${doneName}" must be an array (graph.exports.done)`);
  // A null or a string where a node belongs would crash every reader later; say where it is now.
  for (const [name, list] of [[openName, open], [doneName, done]]) {
    const at = list.findIndex((/** @type {unknown} */ n) => n === null || typeof n !== "object" || Array.isArray(n));
    if (at !== -1) throw new GraphError(`work graph ${path}: "${name}"[${at}] is not an object`);
  }
  return { open: /** @type {GraphNode[]} */ (open), done: /** @type {GraphNode[]} */ (done) };
}

/**
 * @param {unknown} v
 * @param {Record<string, number>} scale
 * @returns {number}
 */
function weight(v, scale) {
  const n = typeof v === "number" ? v : typeof v === "string" && Object.hasOwn(scale, v) ? scale[v] : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * value / cost. Unknown or non-positive weights count as 1.
 * @param {GraphNode} node
 * @param {any} config
 */
export function scoreNode(node, config) {
  const f = config.graph.fields;
  return weight(node[f.value], config.graph.valueScale) / weight(node[f.cost], config.graph.costScale);
}

/**
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphNode[]} ready mechanization nodes, best first
 */
export function readyMechanization(graph, config) {
  const f = config.graph.fields;
  const { doneStatus, openGateValue } = config.graph;
  const doneIds = new Set(graph.done.map((n) => n[f.id]));
  for (const n of graph.open) if (n[f.status] === doneStatus) doneIds.add(n[f.id]);

  const ready = graph.open.filter((n) => {
    if (n[f.mechanization] !== true) return false;
    if (n[f.status] === doneStatus) return false;
    const gate = n[f.gate];
    if (gate !== undefined && gate !== openGateValue) return false;
    const raw = n[f.needs] ?? [];
    const needs = Array.isArray(raw) ? raw : [raw];
    return needs.every((id) => doneIds.has(id));
  });

  const scored = ready.map((node) => ({ node, score: scoreNode(node, config), id: String(node[f.id]) }));
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.map((s) => s.node);
}

/**
 * @param {Graph} graph
 * @param {any} config
 * @returns {GraphNode | null}
 */
export function pickMechanization(graph, config) {
  return readyMechanization(graph, config)[0] ?? null;
}
