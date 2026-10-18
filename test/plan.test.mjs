import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { loadGraph, pickMechanization, readyMechanization, scoreNode, GraphError } from "../plan/mechanization.mjs";

const cfg = (override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-p-")), env: {}, override });

const OPEN = [
  { id: "M-gated", mechanization: true, status: "planned", gate: "demand", value: "high", cost: "S" },
  { id: "M-blocked", mechanization: true, status: "planned", needs: ["X-open"], value: "high", cost: "S" },
  { id: "M-done", mechanization: true, status: "done", value: "high", cost: "S" },
  { id: "X-open", status: "planned", value: "high", cost: "S" },
  { id: "X-closed-here", status: "done" },
  { id: "M-feature", status: "planned", value: "high", cost: "S" },
  { id: "M-b", mechanization: true, status: "planned", needs: ["D1", "X-closed-here"], value: "medium", cost: "M" },
  { id: "M-a", mechanization: true, status: "planned", gate: null, value: "low", cost: "S" },
  { id: "M-best", mechanization: true, status: "partial", needs: ["D1"], value: 6, cost: 2 },
  { id: "M-unknown", mechanization: true, status: "planned", value: "huge", cost: "?" },
];
const DONE = [{ id: "D1" }];

/** @param {string} name @param {string} content */
function graphFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "pl-graph-"));
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", name), content);
  return dir;
}

test("ready: gate closed, need unmet, done status and unflagged nodes are excluded", () => {
  const ids = readyMechanization({ open: OPEN, done: DONE }, cfg()).map((n) => n.id);
  for (const id of ["M-gated", "M-blocked", "M-done", "M-feature", "X-open"]) assert.ok(!ids.includes(id), id);
});

test("ready: value/cost ordering, unknown weights count as 1, ties broken by id", () => {
  const c = cfg();
  const ids = readyMechanization({ open: OPEN, done: DONE }, c).map((n) => n.id);
  // M-best 6/2=3 · M-a 1/1=1 · M-b 2/2=1 · M-unknown 1/1=1 → ties sorted by id
  assert.deepEqual(ids, ["M-best", "M-a", "M-b", "M-unknown"]);
  assert.equal(scoreNode(OPEN[8], c), 3);
  assert.equal(pickMechanization({ open: OPEN, done: DONE }, c)?.id, "M-best");
  // Order of input does not change the pick.
  assert.deepEqual(readyMechanization({ open: [...OPEN].reverse(), done: DONE }, c).map((n) => n.id), ids);
});

test("ready: a need satisfied only by an open node carrying the done status", () => {
  const c = cfg();
  const graph = { open: [{ id: "A", status: "done" }, { id: "B", mechanization: true, status: "planned", needs: "A" }], done: [] };
  assert.equal(pickMechanization(graph, c)?.id, "B");
  assert.equal(pickMechanization({ open: [{ id: "B", mechanization: true, needs: ["A"] }], done: [] }, c), null);
});

test("ready: configured field names, open gate value and scales", () => {
  const c = cfg({
    graph: {
      fields: { status: "durum", gate: "kapi", value: "deger", cost: "maliyet", mechanization: "mekanizasyon" },
      openGateValue: "yok",
      doneStatus: "tamam",
      valueScale: { yuksek: 3, orta: 2, dusuk: 1 },
    },
  });
  const graph = {
    open: [
      { id: "a", mekanizasyon: true, durum: "planli", kapi: "talep", deger: "yuksek", maliyet: "S" },
      { id: "b", mekanizasyon: true, durum: "planli", kapi: "yok", deger: "orta", maliyet: "S" },
      { id: "c", mekanizasyon: true, durum: "planli", kapi: "yok", deger: "yuksek", maliyet: "M" },
      { id: "d", mekanizasyon: true, durum: "tamam", kapi: "yok", deger: "yuksek", maliyet: "S" },
    ],
    done: [],
  };
  assert.deepEqual(readyMechanization(graph, c).map((n) => n.id), ["b", "c"]);
});

test("loadGraph: JSON and module graphs with configured export names", async () => {
  const jsonDir = graphFile("graph.json", JSON.stringify({ nodes: OPEN, done: DONE }));
  const g1 = await loadGraph({ cwd: jsonDir, config: cfg() });
  assert.equal(g1.open.length, OPEN.length);
  assert.equal(pickMechanization(g1, cfg())?.id, "M-best");

  const modDir = graphFile("graph.mjs", `export const acik = ${JSON.stringify(OPEN)};\nexport const biten = ${JSON.stringify(DONE)};\n`);
  const c = cfg({ paths: { graph: ".ennyn/graph.mjs" }, graph: { exports: { open: "acik", done: "biten" } } });
  const g2 = await loadGraph({ cwd: modDir, config: c });
  assert.deepEqual(g2.done, DONE);
  assert.equal(pickMechanization(g2, c)?.id, "M-best");
});

test("loadGraph: missing file, missing open export, bad JSON are errors, not an empty graph", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pl-graph-none-"));
  await assert.rejects(loadGraph({ cwd: empty, config: cfg() }), GraphError);
  await assert.rejects(loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ done: [] })), config: cfg() }), /no "nodes" array/);
  await assert.rejects(loadGraph({ cwd: graphFile("graph.json", "{"), config: cfg() }), GraphError);
  const noDone = await loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ nodes: [] })), config: cfg() });
  assert.deepEqual(noDone, { open: [], done: [] });
});

test("loadGraph: a node that is not an object and a module that does not load are GraphErrors", async () => {
  // A null node crashed every reader; a string node was skipped without a word.
  for (const [nodes, done, where] of [[[{ id: "a" }, null], [], /"nodes"\[1\]/], [[{ id: "a" }], ["d"], /"done"\[0\]/], [[[1]], [], /"nodes"\[0\]/]]) {
    const dir = graphFile("graph.json", JSON.stringify({ nodes, done }));
    await assert.rejects(loadGraph({ cwd: dir, config: cfg() }), (e) => e instanceof GraphError && where.test(e.message) && /is not an object/.test(e.message));
  }
  const mod = graphFile("graph.mjs", "export const nodes = [\n");
  const c = cfg({ paths: { graph: ".ennyn/graph.mjs" } });
  await assert.rejects(loadGraph({ cwd: mod, config: c }), (e) => e instanceof GraphError && /cannot load .*graph\.mjs/.test(e.message));
});
