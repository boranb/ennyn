import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { t } from "../core/i18n.mjs";
import { graphProblems, loadGraph, pickMechanization, readyMechanization, scoreNode, GraphError } from "../plan/mechanization.mjs";

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

test("loadGraph audit: a byte order mark, an unreadable file, and arrays in a module's default export", async (t) => {
  // An editor that writes a BOM made the graph "cannot parse".
  const bom = await loadGraph({ cwd: graphFile("graph.json", `﻿${JSON.stringify({ nodes: [{ id: "a" }], done: [] })}`), config: cfg() });
  assert.deepEqual(bom.open, [{ id: "a" }]);
  // export default, and module.exports in a CommonJS package: Node gives no named "nodes" for either.
  for (const [name, text] of [["graph.mjs", 'export default { nodes: [{ id: "a" }], done: [{ id: "d" }] };\n'], ["graph.js", 'module.exports = { nodes: [{ id: "a" }], done: [{ id: "d" }] };\n']]) {
    const g = await loadGraph({ cwd: graphFile(name, text), config: cfg({ paths: { graph: `.ennyn/${name}` } }) });
    assert.deepEqual([g.open, g.done], [[{ id: "a" }], [{ id: "d" }]], name);
  }
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const locked = graphFile("graph.json", "{}");
  chmodSync(join(locked, ".ennyn", "graph.json"), 0o000);
  await assert.rejects(loadGraph({ cwd: locked, config: cfg() }), (e) => e instanceof GraphError && /^work graph .* could not be read: .*EACCES/.test(e.message));
});

test("graphProblems: a problem in the items says where each item comes from, by its source field", () => {
  const c = cfg();
  const at = (/** @type {{ open: any[], done: any[] }} */ g, config = c) => graphProblems(g, config).map((p) => [p.key, p.vars.where]);
  // A roadmap the graph module reads: the same id on two lines, a need no item has, an item with no id.
  assert.deepEqual(
    at({
      open: [
        { id: "a", source: "ROADMAP.md:12" },
        { id: "a", source: "ROADMAP.md:40" },
        { id: "b", needs: ["ghost"], source: "ROADMAP.md:41" },
        { title: "no id", source: "docs/roadmap/phase-2.md:3" },
      ],
      done: [{ id: "a", source: "CHANGELOG.md:9" }],
    }),
    [
      ["doctor.idMissing", " (docs/roadmap/phase-2.md:3)"],
      ["doctor.idDuplicate", " (a: ROADMAP.md:12 · ROADMAP.md:40 · CHANGELOG.md:9)"],
      ["doctor.needsUnknown", " (ROADMAP.md:41)"],
    ],
  );
  // Each id its own places, at most three each and four ids; an item with no source is a "?".
  const two = at({ open: [{ id: "a", source: "R.md:1" }, { id: "b", source: "R.md:7" }, { id: "a", source: "R.md:2" }, { id: "b" }], done: [] });
  assert.deepEqual(two, [["doctor.idDuplicate", " (a: R.md:1 · R.md:2; b: ? · R.md:7)"]]);
  const many = Array.from({ length: 5 }, (_, i) => ({ id: "x", source: `R.md:${i + 1}` }));
  assert.deepEqual(at({ open: many, done: [] }), [["doctor.idDuplicate", " (x: R.md:1 · R.md:2 · R.md:3 · +2)"]]);
  const ids = ["p", "q", "r", "s", "u"].flatMap((id) => [{ id, source: `${id}.md:1` }, { id, source: `${id}.md:2` }]);
  assert.match(String(at({ open: ids, done: [] })[0][1]), /^ \(p: .*; s: s\.md:1 · s\.md:2; …\)$/);
  // The same place twice: the module read one item twice. Said as such, so it is not taken for the roadmap's.
  const item = { id: "x", status: "done", source: "ROADMAP.md:7" };
  assert.deepEqual(at({ open: [item], done: [item] }), [["doctor.idDuplicate", " (x: ROADMAP.md:7 ×2)"]]);
  // No source at all, or one that is not text: nothing to point at.
  assert.deepEqual(at({ open: [{ id: "a" }, { id: "a", source: 12 }, { id: "a", source: "  " }], done: [] }), [["doctor.idDuplicate", ""]]);
  // A cycle names its items' places too.
  assert.deepEqual(at({ open: [{ id: "a", needs: ["b"], source: "R.md:1" }, { id: "b", needs: ["a"], source: "R.md:2" }], done: [] }), [["doctor.needsCycle", " (a: R.md:1; b: R.md:2)"]]);
  // A source is one line of reasonable length; one with a comma keeps its comma (" · " parts places).
  assert.deepEqual(at({ open: [{ id: "a", source: "R.md:1\n✓ all good" }, { id: "a", source: `docs/evidence.md, Open questions ${"w".repeat(200)}` }], done: [] }), [
    ["doctor.idDuplicate", ` (a: R.md:1 ✓ all good · docs/evidence.md, Open questions ${"w".repeat(86)}…)`],
  ]);
  // The field is the project's own name for it.
  const named = cfg({ graph: { fields: { source: "from" } } });
  assert.deepEqual(at({ open: [{ id: "a", from: "TODO.md:2" }, { id: "a", from: "TODO.md:5" }], done: [] }, named), [["doctor.idDuplicate", " (a: TODO.md:2 · TODO.md:5)"]]);
  assert.match(t("doctor.idDuplicate", { list: "a", where: " (a: TODO.md:2 · TODO.md:5)" }, "tr"), /yinelenen kimlikler: a \(a: TODO\.md:2 · TODO\.md:5\)$/);
  assert.match(t("doctor.needsCycle", { cycle: "a → b → a", where: " (a: R.md:1; b: R.md:2)" }, "en"), /a → b → a \(a: R\.md:1; b: R\.md:2\)$/);
});

test("graphProblems audit: what doctor fails and warns on, and the pick refuses", () => {
  const c = cfg();
  const keys = (/** @type {{ open: any[], done: any[] }} */ g, config = c) => graphProblems(g, config).map((p) => `${p.level} ${p.key}`);
  assert.deepEqual(keys({ open: OPEN, done: DONE }), ["warn doctor.weightUnknown", "warn doctor.weightUnknown"], "OPEN's M-unknown has value huge and cost ?");
  // A finished node left in the open list: its id twice, and the pick could take it.
  assert.deepEqual(keys({ open: [{ id: "a", status: "planned", mechanization: true }], done: [{ id: "a" }] }), ["fail doctor.idDuplicate"]);
  // Twice among finished nodes only: said, but it cannot change the pick.
  assert.deepEqual(keys({ open: [{ id: "a", status: "done" }, { id: "b" }], done: [{ id: "a" }, { id: "c" }, { id: "c" }] }), ["warn doctor.idDuplicate"]);
  assert.deepEqual(graphProblems({ open: [{ mechanization: true }, { id: "" }, { id: " " }], done: [{ title: "old" }] }, c), [
    { level: "fail", key: "doctor.idMissing", vars: { n: 3, field: "id", where: "" } },
    { level: "warn", key: "doctor.idMissing", vars: { n: 1, field: "id", where: "" } },
  ], "an empty or blank id is no id");
  assert.deepEqual(graphProblems({ open: [{ id: "a", needs: ["b"] }, { id: "b", needs: "c" }, { id: "c", needs: ["a"] }, { id: "d", needs: ["d"], status: "done" }], done: [] }, c).map((p) => p.vars.cycle ?? p.key), ["a → b → c → a"]);
  assert.deepEqual(keys({ open: [{ id: "a", needs: ["ghost"] }], done: [] }), ["fail doctor.needsUnknown"]);
  // A finished node's stale need changes no pick.
  assert.deepEqual(keys({ open: [{ id: "old", status: "done", needs: ["gone"] }, { id: "m", mechanization: true }], done: [] }), []);
  // Two nodes that need the same one are no cycle.
  assert.deepEqual(keys({ open: [{ id: "a", needs: ["c"] }, { id: "b", needs: ["c", "a"] }, { id: "c" }], done: [] }), []);
  const warns = graphProblems({ open: [{ id: "a", value: "hgih", cost: 0 }, { id: "b", mechanization: "true", value: "low", cost: "S" }, { id: "c", gate: false, value: "low", cost: "S" }, { id: "e", value: "high", cost: "XL" }, { id: "f", mechanization: false, value: "low", cost: "S" }], done: [] }, c);
  assert.deepEqual(warns.map((p) => [p.level, p.key, p.vars.id ?? p.vars.field, p.vars.value ?? ""]), [
    ["warn", "doctor.weightUnknown", "a", "hgih"],
    ["warn", "doctor.weightUnknown", "a", "0"],
    ["warn", "doctor.flagNotBoolean", "b", '"true"'],
    ["warn", "doctor.gateFalse", "c", "false"],
  ]);
  // A cost on one node and none on another: the second is scored as cost 1, a guess. No cost anywhere: none.
  assert.deepEqual(graphProblems({ open: [{ id: "a", value: "high" }, { id: "b", value: "high", cost: "M" }], done: [] }, c), [{ level: "warn", key: "doctor.weightAbsent", vars: { n: 1, field: "cost" } }]);
  assert.deepEqual(keys({ open: [{ id: "a", value: "high" }, { id: "b", value: "low" }], done: [] }), []);
  // What reads as "no gate" to a person and closes the node; where true is open, false is the plain closed value.
  for (const gate of ["", 0, "false"]) assert.deepEqual(keys({ open: [{ id: "a", gate }], done: [] }), ["warn doctor.gateFalse"], JSON.stringify(gate));
  assert.deepEqual(keys({ open: [{ id: "a", gate: false }, { id: "b", gate: "demand" }], done: [] }, cfg({ graph: { openGateValue: true } })), []);
  // Where the open value is a word, false and null are no word for it.
  assert.deepEqual(keys({ open: [{ id: "a", gate: false }, { id: "b", gate: null }, { id: "c", gate: "open" }, { id: "d", gate: "demand" }], done: [] }, cfg({ graph: { openGateValue: "open" } })), ["warn doctor.gateFalse", "warn doctor.gateFalse"]);
  // Done nodes are not judged by weight or flags.
  assert.deepEqual(keys({ open: [{ id: "a", status: "done", value: "x", mechanization: 1 }], done: [] }), []);
});

test("graphProblems audit: a needs chain thousands long is walked without the call stack, and its cycle found", () => {
  const n = 20_000;
  const open = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, needs: i + 1 < n ? [`n${i + 1}`] : [] }));
  assert.deepEqual(graphProblems({ open, done: [] }, cfg()), []);
  open[n - 1].needs = ["n0"];
  const [p] = graphProblems({ open, done: [] }, cfg());
  assert.equal(p.key, "doctor.needsCycle");
  assert.match(String(p.vars.cycle), /^n0 → n1 → .* → n19999 → n0$/);
  // The cycle, not the path that led to it.
  assert.deepEqual(graphProblems({ open: [{ id: "x", needs: ["a"] }, { id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }], done: [] }, cfg()).map((q) => q.vars.cycle), ["a → b → a"]);
  // Each node needs the two before it: a node already walked is not walked again (that would be 2^60 paths).
  const dense = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, needs: i ? [`d${i - 1}`, ...(i > 1 ? [`d${i - 2}`] : [])] : [] }));
  assert.deepEqual(graphProblems({ open: dense, done: [] }, cfg()), []);
});

test("loadGraph audit: a module whose names Node detects only in part keeps every array", async () => {
  // Node turns `nodes` (a name it can see) into an export, and stops at `done: [`.
  const cjs = graphFile("graph.js", 'const nodes = [{ id: "m", mechanization: true, needs: ["d"] }];\nmodule.exports = { nodes, done: [{ id: "d" }] };\n');
  const g = await loadGraph({ cwd: cjs, config: cfg({ paths: { graph: ".ennyn/graph.js" } }) });
  assert.deepEqual([g.open.map((n) => n.id), g.done.map((n) => n.id)], [["m"], ["d"]]);
  const esm = graphFile("graph.mjs", 'export const nodes = [{ id: "m" }];\nexport default { nodes, done: [{ id: "d" }] };\n');
  const e = await loadGraph({ cwd: esm, config: cfg({ paths: { graph: ".ennyn/graph.mjs" } }) });
  assert.deepEqual(e.done, [{ id: "d" }], "the named export first, then the default, for each array");
  // A default export about something else is not the graph's done list.
  const other = graphFile("graph.mjs", 'export const nodes = [{ id: "m" }];\nexport default { title: "roadmap", done: 3 };\n');
  assert.deepEqual((await loadGraph({ cwd: other, config: cfg({ paths: { graph: ".ennyn/graph.mjs" } }) })).done, []);
});

test("graphProblems (after review round two): ? is never merged, marks come before the cut, ids and sources are one clean line", () => {
  const c = cfg();
  const at = (/** @type {{ open: any[], done: any[] }} */ g) => graphProblems(g, c).map((p) => p.vars.where);
  // Two items with no source are two unknown places, not one place read twice.
  assert.deepEqual(at({ open: [{ id: "a", source: "R.md:1" }, { id: "a", source: "R.md:2" }, { id: "b" }, { id: "b" }], done: [] }), [" (a: R.md:1 · R.md:2; b: ? · ?)"]);
  // A mark past the third place is not folded into the count.
  assert.deepEqual(at({ open: [{ id: "a", source: "R.md:1" }, { id: "a", source: "R.md:2" }, { id: "a", source: "R.md:3" }, { id: "a" }], done: [] }), [" (a: ? · R.md:1 · R.md:2 · +1)"]);
  const twice = { id: "a", status: "done", source: "R.md:9" };
  assert.deepEqual(at({ open: [{ id: "a", source: "R.md:1" }, { id: "a", source: "R.md:2" }, { id: "a", source: "R.md:3" }, twice], done: [twice] }), [" (a: R.md:9 ×2 · R.md:1 · R.md:2 · +1)"]);
  // C1 controls and direction overrides go too; a source of nothing but them is no source.
  assert.deepEqual(at({ open: [{ id: "a", source: "R.md:1\u0085x‮" }, { id: "a", source: "\u0007\u0007" }], done: [] }), [" (a: ? · R.md:1 x)"]);
  // An id is cleaned the same way inside the places.
  assert.deepEqual(at({ open: [{ id: "a\n✓ ok", source: "R.md:1" }, { id: "a\n✓ ok", source: "R.md:2" }], done: [] }), [" (a ✓ ok: R.md:1 · R.md:2)"]);
});
