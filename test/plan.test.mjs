import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../plugin/core/config.mjs";
import { t, tShown } from "../plugin/core/i18n.mjs";
import { byAge, clarification, costWeight, heldNodes, sinceOf, splitAt, graphProblems, loadGraph, pickMechanization, pickOldest, rankMechanization, readyMechanization, readyNodes, scoreNode, splitFirst, GraphError } from "../plugin/plan/mechanization.mjs";
import { cycleRecords, folded, lineKey, markCovers, securityDue, sensitivePaths, uncovered } from "../plugin/plan/audit.mjs";

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

test("graph: one reached through a symbolic link a commit may hold is not read, a module not imported; its bytes reach no message", async () => {
  const away = mkdtempSync(join(tmpdir(), "pl-graph-away-"));
  writeFileSync(join(away, "secret.json"), "SECRET-TOKEN-BYTES not json");
  writeFileSync(join(away, "graph.mjs"), "globalThis.__graphImported = true; export const nodes = [];\n");
  for (const [name, at, to] of [["graph.json", ".ennyn/graph.json", "secret.json"], ["graph.mjs", ".ennyn/graph.mjs", "graph.mjs"], ["graph.json", ".ennyn", ""]]) {
    const dir = mkdtempSync(join(tmpdir(), "pl-graph-"));
    if (at !== ".ennyn") mkdirSync(join(dir, ".ennyn"));
    symlinkSync(join(away, to), join(dir, at));
    if (at === ".ennyn") writeFileSync(join(away, name), "SECRET-TOKEN-BYTES not json");
    await assert.rejects(loadGraph({ cwd: dir, config: cfg({ paths: { graph: `.ennyn/${name}` } }) }), (e) => e instanceof GraphError && /could not be read: \.ennyn(\/graph\.(json|mjs))? is a symbolic link$/.test(e.message) && !e.message.includes("SECRET"), `${at}`);
  }
  assert.equal(/** @type {any} */ (globalThis).__graphImported, undefined);
});

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

test("ready: configured field names and open gate value", () => {
  const c = cfg({
    graph: {
      fields: { status: "durum", gate: "kapi", value: "deger", cost: "maliyet", mechanization: "mekanizasyon" },
      openGateValue: "yok",
      doneStatus: "tamam",
    },
  });
  const graph = {
    open: [
      { id: "a", mekanizasyon: true, durum: "planli", kapi: "talep", deger: "high", maliyet: "S" },
      { id: "b", mekanizasyon: true, durum: "planli", kapi: "yok", deger: "medium", maliyet: "S" },
      { id: "c", mekanizasyon: true, durum: "planli", kapi: "yok", deger: "high", maliyet: "M" },
      { id: "d", mekanizasyon: true, durum: "tamam", kapi: "yok", deger: "high", maliyet: "S" },
    ],
    done: [],
  };
  assert.deepEqual(readyMechanization(graph, c).map((n) => n.id), ["b", "c"]);
});

/** Ready flagged nodes in the slot's order, by id, with a count per id (absent: no count). @param {any[]} open @param {Record<string, number | null>} counts */
const ranked = (open, counts, c = cfg()) => rankMechanization({ open, done: [] }, c, (n) => counts[String(n.id)] ?? null).map((n) => n.id);
const flagged = (/** @type {string} */ id, /** @type {string} */ value, /** @type {string} */ cost) => ({ id, mechanization: true, value, cost });

test("rank: a class that recurs more ranks above a node with the higher value/cost", () => {
  const open = [flagged("cheap-rare", "high", "S"), flagged("often", "low", "S")];
  assert.deepEqual(ranked(open, {}), ["cheap-rare", "often"], "no counts: today's value/cost order");
  assert.deepEqual(ranked(open, { "cheap-rare": 2, often: 5 }), ["often", "cheap-rare"]);
  assert.equal(pickMechanization({ open, done: [] }, cfg(), (n) => ({ "cheap-rare": 2, often: 5 })[String(n.id)] ?? null)?.id, "often");
  assert.equal(pickMechanization({ open, done: [] }, cfg())?.id, "cheap-rare", "no counts given: value/cost");
});

test("rank: the count is over the cost weight; equal rates go by value/cost, then id", () => {
  // 5 over M (2) is 2.5, under 3 over S (1).
  assert.deepEqual(ranked([flagged("m5", "high", "M"), flagged("s3", "low", "S")], { m5: 5, s3: 3 }), ["s3", "m5"]);
  // 4 over M and 2 over S tie at 2: value/cost puts the S node of high value first.
  assert.deepEqual(ranked([flagged("m4", "high", "M"), flagged("s2", "high", "S")], { m4: 4, s2: 2 }), ["s2", "m4"]);
  // Same count, cost and value: by id.
  assert.deepEqual(ranked([flagged("b", "low", "S"), flagged("a", "low", "S")], { a: 1, b: 1 }), ["a", "b"]);
});

test("rank: a node with no count, an unknown class or zero rows ranks after every counted one, by value/cost, and none disappears", () => {
  const open = [flagged("none", "high", "S"), flagged("zero", "medium", "S"), flagged("unknown", "low", "S"), flagged("one", "low", "XL"), flagged("gated", "high", "S")];
  open[4].gate = "user";
  assert.deepEqual(ranked(open, { zero: 0, unknown: null, one: 1 }), ["one", "none", "zero", "unknown"]);
});

/** The pick as [the node the slot works, the old node it serves]. @param {any[]} open @param {any[]} [done] */
const oldest = (open, done = [], c = cfg()) => {
  const p = pickOldest({ open, done }, c);
  return p && [p.node.id, p.oldest.id];
};

test("oldest: the first node of the highest value in the open list, however it scores", () => {
  // Accept: an old large node over a young small one of the same value (value/cost ranks it last).
  assert.deepEqual(oldest([{ id: "big", value: "high", cost: "L" }, { id: "small", value: "high", cost: "S" }]), ["big", "big"]);
  // The list's order, not the id's.
  assert.deepEqual(oldest([{ id: "z", value: "high", cost: "XL" }, { id: "a", value: "high", cost: "S" }]), ["z", "z"]);
  // The highest value first, then age: an old medium node waits for no young high one.
  assert.deepEqual(oldest([{ id: "old", value: "medium", cost: "S" }, { id: "young", value: "high", cost: "L" }]), ["young", "young"]);
  // A number is its own weight; a value the scale does not know weighs 1, as in the score.
  assert.deepEqual(oldest([{ id: "a", value: "low" }, { id: "b", value: 5, cost: "XL" }]), ["b", "b"]);
  assert.deepEqual(oldest([{ id: "a", value: "hgih" }, { id: "b", value: "low" }]), ["a", "a"]);
  // Reject: a gated node, a mechanization node (the other slot's), a node carrying the done status, each
  // passed over with a ready need of its own.
  assert.deepEqual(
    oldest([
      { id: "gated", value: "high", gate: "user", needs: ["n1"] },
      { id: "mech", value: "high", mechanization: true, needs: ["n2"] },
      { id: "finished", value: "high", status: "done", needs: ["n3"] },
      { id: "n1", value: "low" },
      { id: "n2", value: "low" },
      { id: "n3", value: "low" },
      { id: "plain", value: "high" },
    ]),
    ["plain", "plain"],
  );
  assert.deepEqual(
    oldest([
      { id: "gated", value: "high", gate: "user" },
      { id: "mech", value: "high", mechanization: true },
      { id: "finished", value: "high", status: "done" },
      { id: "plain", value: "low" },
    ]),
    ["plain", "plain"],
  );
  // Nothing open, or nothing that can start: no pick.
  assert.equal(oldest([]), null);
  assert.equal(oldest([{ id: "a", value: "high", gate: "user" }, { id: "m", mechanization: true }]), null);
});

test("oldest: a node waiting on open needs gives the slot the nearest ready one, so a step keeps its node's age", () => {
  // An L node split into a first step it needs: the step was written last, and still comes first.
  const split = [{ id: "eval", value: "high", cost: "L", needs: ["eval-step"] }, { id: "other", value: "high", cost: "S" }, { id: "eval-step", value: "high", cost: "S" }];
  assert.deepEqual(oldest(split), ["eval-step", "eval"]);
  // The step done (in the done list or by status): the node is ready again.
  assert.deepEqual(oldest(split.slice(0, 2), [{ id: "eval-step" }]), ["eval", "eval"]);
  assert.deepEqual(oldest([split[0], split[1], { ...split[2], status: "done" }]), ["eval", "eval"]);
  // Through a chain, nearest first, in the order the needs are listed; a need of any value serves.
  const chain = [
    { id: "p", value: "high", needs: ["q", "r"] },
    { id: "q", value: "low", needs: ["s"] },
    { id: "r", value: "low", needs: ["d"] },
    { id: "s", value: "low" },
  ];
  assert.deepEqual(oldest(chain, [{ id: "d" }]), ["r", "p"]);
  assert.deepEqual(oldest(chain), ["s", "p"], "r waits on d, which is not done: s is nearer than nothing");
  // A closed gate ends that way; with no other way the node is passed over.
  assert.deepEqual(oldest([{ id: "release", value: "high", needs: ["trial"] }, { id: "trial", value: "high", gate: "user" }, { id: "next", value: "high" }]), ["next", "next"]);
  assert.deepEqual(oldest([{ id: "p", value: "high", needs: ["g", "q"] }, { id: "g", gate: "user" }, { id: "q", value: "low" }]), ["q", "p"]);
  // Nor is the way walked on past it: what a gated need waits on does not serve the node above it.
  assert.deepEqual(oldest([{ id: "p", value: "high", needs: ["g"] }, { id: "g", gate: "user", needs: ["x"] }, { id: "x", value: "low" }, { id: "next", value: "high" }]), ["next", "next"]);
  // Two ready needs as near: the first listed.
  assert.deepEqual(oldest([{ id: "p", value: "high", needs: ["b", "a"] }, { id: "a", value: "low" }, { id: "b", value: "low" }]), ["b", "p"]);
  // Needs that wait on each other lead nowhere, and end.
  assert.deepEqual(oldest([{ id: "a", value: "high", needs: ["b"] }, { id: "b", needs: ["a"] }, { id: "c", value: "low" }]), ["c", "c"]);
});

test("oldest: a flagged node is the mechanization slot's, never the core pick, and doctor's core count agrees", () => {
  // Review round 1: X waits on a ready flagged node; core named it while mechanization picked it too.
  const open = [{ id: "X", value: "high", needs: ["M"] }, { id: "M", value: "low", mechanization: true }, { id: "Y", value: "medium" }];
  assert.deepEqual(oldest(open), ["Y", "Y"]);
  assert.equal(pickMechanization({ open, done: [] }, cfg())?.id, "M");
  // A way may pass a flagged node that waits on a core one.
  assert.deepEqual(oldest([{ id: "h", value: "high", needs: ["m"] }, { id: "m", mechanization: true, needs: ["x"] }, { id: "x", value: "low" }]), ["x", "h"]);
  // Doctor's "ready: N core" counts the ready nodes not flagged: a pick exactly when that count is not zero.
  const graphs = [open, [{ id: "a", value: "high", needs: ["m"] }, { id: "m", mechanization: true }], [{ id: "g", gate: "user" }], [{ id: "a" }, { id: "m", mechanization: true }]];
  for (const g of graphs) {
    const core = readyNodes({ open: g, done: [] }, cfg()).filter((n) => n.mechanization !== true).length;
    const p = pickOldest({ open: g, done: [] }, cfg());
    assert.equal(p !== null, core > 0, JSON.stringify(g));
    if (p) assert.notEqual(p.node.mechanization, true);
  }
});

test("oldest: a graph that dates its nodes is read by the date; undated ones count as the newest, and doctor says so", () => {
  // Review round 1: a module reading a roadmap that lists the newest first gives each node its date as a number.
  const roadmap = [
    { id: "newest-small", value: "high", cost: "S", since: Date.parse("2026-10-20") },
    { id: "newer-small", value: "high", cost: "S", since: Date.parse("2026-09-01") },
    { id: "old-large", value: "high", cost: "L", since: Date.parse("2026-03-15") },
  ];
  assert.deepEqual(oldest(roadmap), ["old-large", "old-large"]);
  // A cycle number the same way; equal dates keep the list's order.
  assert.deepEqual(oldest([{ id: "b", value: "high", since: 4 }, { id: "a", value: "high", since: 2 }, { id: "c", value: "high", since: 2 }]), ["a", "a"]);
  // Undated, or no number (text, blank, NaN, Infinity from a module): after every dated one, in list order.
  const uneven = [{ id: "u", value: "high" }, { id: "s", value: "high", since: 9 }, { id: "x", value: "high", since: NaN }, { id: "e", value: "high", since: "" }, { id: "t", value: "high", since: 1 }, { id: "y", value: "high", since: Infinity }];
  assert.deepEqual(byAge(uneven, cfg()).map((n) => n.id), ["t", "s", "u", "x", "e", "y"]);
  assert.deepEqual(sinceOf(uneven[1], cfg()), 9);
  assert.deepEqual(oldest(uneven), ["t", "t"]);
  assert.deepEqual(graphProblems({ open: uneven, done: [] }, cfg()).map((p) => [p.key, p.vars.n]), [["doctor.sinceUnread", 3], ["doctor.sinceUneven", 1]]);
  assert.match(tShown("doctor.sinceUneven", { n: 1, field: "since" }), /1 open core nodes have no since while others have one; the core pick reads each as the newest/);
  // No dates anywhere, or every core node dated: no warning; finished nodes are not counted.
  assert.deepEqual(graphProblems({ open: [{ id: "a" }, { id: "b", status: "done" }], done: [] }, cfg()), []);
  assert.deepEqual(graphProblems({ open: [{ id: "a", since: 3 }, { id: "b", status: "done" }], done: [{ id: "c" }] }, cfg()), []);
  // The field's name is configured.
  const c = cfg({ graph: { fields: { since: "eklendi" } } });
  assert.deepEqual(oldest([{ id: "y", value: "high", eklendi: 9 }, { id: "o", value: "high", eklendi: 1 }], [], c), ["o", "o"]);
});

test("oldest: split by weight, not by a cost name", () => {
  assert.deepEqual(["S", "M", "L", "XL", undefined, "?"].map((cost) => splitFirst({ cost }, cfg())), [false, false, true, true, false, false]);
  assert.equal(splitAt(cfg()), 2.5);
  const hours = cfg({ planner: { splitAbove: 16 } });
  assert.deepEqual([splitFirst({ cost: 8 }, hours), splitFirst({ cost: 40 }, hours), costWeight({ cost: 40 }, hours), splitAt(hours)], [false, true, 40, 16]);
});

test("oldest (review round 2): a date is a number; any other since is read as undated and said, even on every node", () => {
  const keys = (/** @type {any[]} */ open) => graphProblems({ open, done: [] }, cfg()).map((p) => [p.key, p.vars.n]);
  // Text compared as text put "10" before "9" and "2026-10-01" before "2026-9-1", silently.
  for (const [older, newer] of [["9", "10"], ["2026-9-1", "2026-10-01"], ["15.09.2026", "01.10.2026"], ["cycle 9", "cycle 10"]]) {
    const open = [{ id: "listed-first", value: "high", since: newer }, { id: "listed-second", value: "high", since: older }];
    assert.deepEqual(oldest(open), ["listed-first", "listed-first"], `${older} / ${newer}: no reading of text, the list's order`);
    assert.deepEqual(keys(open), [["doctor.sinceUnread", 2]]);
  }
  // A Date object on every node (a module's) is no date the pick reads either, and is said.
  const dates = [{ id: "newest", value: "high", since: new Date("2026-10-20") }, { id: "old", value: "high", since: new Date("2026-03-15") }];
  assert.deepEqual(keys(dates), [["doctor.sinceUnread", 2]]);
  assert.match(tShown("doctor.sinceUnread", graphProblems({ open: dates, done: [] }, cfg())[0].vars), /2 open core nodes have a since that is not a number, such as newest: "2026-10-20T00:00:00.000Z"; the core pick reads each as undated, the newest/);
  // As numbers (a cycle, or Date.getTime()), they are read.
  assert.deepEqual(oldest(dates.map((n) => ({ ...n, since: n.since.getTime() }))), ["old", "old"]);
  for (const since of [true, null, {}, [3]]) assert.deepEqual(keys([{ id: "a", since }, { id: "b", since: 2 }]), [["doctor.sinceUnread", 1]], JSON.stringify(since));
});

test("oldest (review round 2): the age and its warnings read only open core nodes", () => {
  // A dated flagged node listed first set the kind for the core nodes; an undated one was said to be read as the newest.
  assert.deepEqual(oldest([{ id: "m", value: "high", mechanization: true, since: "2026-01-01" }, { id: "b", value: "high", since: 12 }, { id: "a", value: "high", since: 3 }]), ["a", "a"]);
  assert.deepEqual(graphProblems({ open: [{ id: "m", mechanization: true }, { id: "s", mechanization: true, since: "x" }, { id: "a", since: 3 }, { id: "b", since: 4 }], done: [] }, cfg()), []);
  // Done nodes neither.
  assert.deepEqual(graphProblems({ open: [{ id: "d", status: "done", since: "x" }, { id: "a", since: 3 }, { id: "e", status: "done" }], done: [{ id: "f" }] }, cfg()), []);
});

test("oldest (review round 2): a step at the smallest cost is never split", () => {
  const split = (/** @type {any} */ over = {}) => ["S", "M", "L", "XL"].filter((cost) => splitFirst({ cost }, cfg(over)));
  assert.deepEqual(split(), ["L", "XL"]);
  // An override below the smallest weight still never splits that weight.
  assert.deepEqual(split({ planner: { splitAbove: 0.5 } }), ["M", "L", "XL"]);
  for (const v of [0, -1, "M", Infinity]) assert.throws(() => cfg({ planner: { splitAbove: v } }), /planner\.splitAbove/, JSON.stringify(v));
  // Costs given as numbers (hours) with no threshold of their own: said; with one, not.
  const hours = [{ id: "a", cost: 8 }, { id: "b", cost: 40 }, { id: "m", mechanization: true, cost: 3 }];
  assert.deepEqual(graphProblems({ open: hours, done: [] }, cfg()).map((p) => [p.key, p.vars.n, p.vars.at]), [["doctor.splitAboveUnset", 2, 2.5]]);
  assert.deepEqual(graphProblems({ open: hours, done: [] }, cfg({ planner: { splitAbove: 16 } })), []);
  assert.deepEqual([splitFirst({ cost: 8 }, cfg({ planner: { splitAbove: 16 } })), splitFirst({ cost: 40 }, cfg({ planner: { splitAbove: 16 } }))], [false, true]);
});

test("oldest: configured field names and open gate value", () => {
  const c = cfg({
    graph: {
      fields: { id: "kimlik", status: "durum", gate: "kapi", value: "deger", needs: "gerekir", mechanization: "mekanizasyon" },
      openGateValue: "yok",
      doneStatus: "tamam",
    },
  });
  const open = [
    { kimlik: "a", deger: "high", kapi: "talep" },
    { kimlik: "b", deger: "high", kapi: "yok", gerekir: ["c"] },
    { kimlik: "c", deger: "low", kapi: "yok", durum: "tamam" },
    { kimlik: "d", deger: "high", kapi: "yok", mekanizasyon: true },
  ];
  const p = pickOldest({ open, done: [] }, c);
  assert.deepEqual(p && [p.node.kimlik, p.oldest.kimlik], ["b", "b"]);
});

test("oldest: a chain tens of thousands long, every node a candidate and its end gated, is walked once", { timeout: 30_000 }, () => {
  // Walked again from each node it would be n²/2 steps; a node already walked to no ready one is not walked again.
  const n = 50_000;
  const open = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, value: "high", needs: i + 1 < n ? [`n${i + 1}`] : [], ...(i + 1 === n ? { gate: "user" } : {}) }));
  assert.equal(oldest(open), null);
  open.push({ id: "free", value: "high" });
  assert.deepEqual(oldest(open), ["free", "free"]);
  open[n - 1] = { id: `n${n - 1}`, value: "high" };
  assert.deepEqual(oldest(open), [`n${n - 1}`, "n0"]);
  // Many nodes that need the head of one long chain to nowhere: the chain is walked for the first only.
  const m = 30_000;
  const chain = Array.from({ length: m }, (_, i) => ({ id: `c${i}`, value: "low", needs: i + 1 < m ? [`c${i + 1}`] : [], ...(i + 1 === m ? { gate: "user" } : {}) }));
  const fan = Array.from({ length: m }, (_, i) => ({ id: `h${i}`, value: "high", needs: ["c0"] }));
  assert.equal(oldest([...fan, ...chain]), null);
  // Review round 1: a value of its own on every node, the high ones blocked: each node is grouped once, not
  // rescanned for each value.
  const values = Array.from({ length: m }, (_, i) => ({ id: `n${i}`, value: m - i + 1, needs: i + 1 < m ? [`n${i + 1}`] : [], ...(i + 1 === m ? { gate: "user" } : {}) }));
  assert.deepEqual(oldest([...values, { id: "free", value: 0.5 }]), ["free", "free"]);
  const onto = Array.from({ length: 20_000 }, (_, i) => ({ id: `f${i}`, value: 20_000 - i + 1, needs: ["G"] }));
  assert.deepEqual(oldest([...onto, { id: "G", gate: "user", value: 1 }, { id: "free", value: 0.5 }]), ["free", "free"]);
});

// The clarification marker: a request that reads two ways puts [NEEDS CLARIFICATION: <the question>] in its node,
// and the node waits on the user's answer: held, never picked, named with its question. A near spelling, which the
// folded reading finds (NFKC, any case), holds too, the safe side, and is marked near so doctor can name it.
/** Held: the marker, in any string the node holds, and the question it carries. */
const HELD = [
  ["in the title", { id: "t", title: "Export the report [NEEDS CLARIFICATION: CSV or JSON?]" }, "CSV or JSON?"],
  ["in the source", { id: "s", title: "Export the report", source: "the user, 2026-11-19: a request [NEEDS CLARIFICATION: which report?]" }, "which report?"],
  ["the empty question", { id: "e", title: "Export [NEEDS CLARIFICATION: ]" }, ""],
  ["no space after the colon", { id: "n", title: "[NEEDS CLARIFICATION:before or after the sync?]" }, "before or after the sync?"],
  ["in a field of the project's own", { id: "f", notes: "[NEEDS CLARIFICATION: who runs it?]" }, "who runs it?"],
  ["in a string of a list", { id: "a", tags: ["ui", "[NEEDS CLARIFICATION: which screen?]"] }, "which screen?"],
  ["deep in an object", { id: "o", meta: { ask: { text: "[NEEDS CLARIFICATION: deep?]" } } }, "deep?"],
  ["two markers: the first in field order", { id: "2", title: "[NEEDS CLARIFICATION: first?]", source: "[NEEDS CLARIFICATION: second?]" }, "first?"],
  ["the question up to the first closing bracket", { id: "b", title: "[NEEDS CLARIFICATION: a [b] c?]" }, "a [b"],
];
/** Held on the folded reading only: a near spelling, the question as the folded text gives it. */
const NEAR = [
  ["lower case", { id: "lc", title: "[needs clarification: which?]" }, "which?"],
  ["mixed case", { id: "mc", title: "[Needs Clarification: which?]" }, "which?"],
  ["Turkish capital dotted I, as caps lock types it", { id: "ti", title: "[NEEDS CLAR\u0130F\u0130CAT\u0130ON: hang\u0131 dosya?]" }, "hang\u0131 dosya?"],
  ["Turkish dotless i in lower case", { id: "tl", title: "[needs clar\u0131f\u0131cat\u0131on: \u0130ki mi?]" }, "\u0130ki mi?"],
  ["the dotted I as I and a combining dot", { id: "td", title: "[NEEDS CLARI\u0307FI\u0307CATI\u0307ON: which?]" }, "which?"],
  ["the question trimmed at both ends", { id: "tr", title: "[needs clarification:  which? \u3000]" }, "which?"],
  ["a full-width colon", { id: "fc", title: "[NEEDS CLARIFICATION\uFF1A which?]" }, "which?"],
  ["full-width brackets", { id: "fb", title: "\uFF3BNEEDS CLARIFICATION: which?\uFF3D" }, "which?"],
  ["full-width letters", { id: "fl", title: "[\uFF2EEEDS CLARIFICATION: which?]" }, "which?"],
  ["a no-break space between the words", { id: "nb", title: "[NEEDS\u00A0CLARIFICATION: which?]" }, "which?"],
  ["lower case, an empty question", { id: "le", source: "[needs clarification:]" }, ""],
];
/** Not held: near spellings, and what holds no string. */
const FREE = [
  ["no brackets", { id: "nb", title: "NEEDS CLARIFICATION: which?" }],
  ["no colon", { id: "nc", title: "[NEEDS CLARIFICATION which?]" }],
  ["no colon, lower case", { id: "nl", title: "[needs clarification which?]" }],
  ["another letter for the i", { id: "oi", title: "[NEEDS CLAR\u00CDF\u00CDCAT\u00CDON: which?]" }],
  ["another colon NFKC keeps", { id: "rc", title: "[NEEDS CLARIFICATION\u2236 which?]" }],
  ["prose that names it", { id: "p", title: "the node holds the clarification marker until the user answers" }],
  ["prose with the words and a colon", { id: "pc", source: "it needs clarification: which report" }],
  ["not closed", { id: "uc", title: "[NEEDS CLARIFICATION: which?" }],
  ["the words alone", { id: "w", title: "the ask needs clarification" }],
  ["a key, not a value", { id: "k", "[NEEDS CLARIFICATION: key?]": 1 }],
  ["no string but the id", { id: "nm", value: 3, cost: 1, mechanization: false, needs: [] }],
];

test("clarification: the accept and reject corpus, the marker in any string a node holds", () => {
  const c = cfg();
  for (const [why, node, question] of HELD) {
    assert.equal(clarification(node), question, why);
    assert.deepEqual(readyNodes({ open: [node], done: [] }, c), [], `${why}: never ready`);
    assert.deepEqual(heldNodes({ open: [node], done: [] }, c).map((h) => [h.node, h.question, h.near]), [[node, question, false]], why);
  }
  for (const [why, node, question] of NEAR) {
    assert.equal(clarification(node), question, why);
    assert.deepEqual(readyNodes({ open: [node], done: [] }, c), [], `${why}: never ready`);
    assert.deepEqual(heldNodes({ open: [node], done: [] }, c).map((h) => [h.node, h.question, h.near]), [[node, question, true]], why);
  }
  // In one string the exact marker is read first; in two, the first in field order, exact or near.
  assert.deepEqual(heldNodes({ open: [{ id: "x", title: "[needs clarification: near?] [NEEDS CLARIFICATION: exact?]" }], done: [] }, c).map((h) => [h.question, h.near]), [["exact?", false]]);
  assert.deepEqual(heldNodes({ open: [{ id: "y", title: "[needs clarification: near?]", source: "[NEEDS CLARIFICATION: exact?]" }], done: [] }, c).map((h) => [h.question, h.near]), [["near?", true]]);
  for (const [why, node] of FREE) {
    assert.equal(clarification(node), null, why);
    assert.deepEqual(readyNodes({ open: [node], done: [] }, c), [node], `${why}: ready`);
    assert.deepEqual(heldNodes({ open: [node], done: [] }, c), [], why);
  }
});

test("clarification: a held node is no ready node of either slot, and doctor's counts agree with the picks", () => {
  const c = cfg();
  const open = [
    { id: "h", value: "high", cost: "S", title: "[NEEDS CLARIFICATION: which file?]" },
    { id: "m", value: "high", cost: "S", mechanization: true, source: "[NEEDS CLARIFICATION: which class?]" },
    { id: "a", value: "low", cost: "S" },
    { id: "n", value: "low", cost: "S", mechanization: true },
  ];
  assert.deepEqual(readyNodes({ open, done: [] }, c).map((n) => n.id), ["a", "n"]);
  assert.deepEqual(readyMechanization({ open, done: [] }, c).map((n) => n.id), ["n"]);
  assert.equal(pickMechanization({ open, done: [] }, c)?.id, "n");
  assert.deepEqual(rankMechanization({ open, done: [] }, c, (n) => (n.id === "m" ? 9 : 0)).map((n) => n.id), ["n"], "a recurring class does not lift a held node");
  assert.deepEqual(oldest(open), ["a", "a"]);
  assert.deepEqual(heldNodes({ open, done: [] }, c).map((h) => [h.node.id, h.question]), [["h", "which file?"], ["m", "which class?"]]);
  // Only held nodes left: nothing to pick, and each is named.
  assert.equal(oldest(open.slice(0, 2)), null);
  assert.equal(pickMechanization({ open: open.slice(0, 2), done: [] }, c), null);
  assert.deepEqual(heldNodes({ open: open.slice(0, 2), done: [] }, c).map((h) => h.node.id), ["h", "m"]);
});

test("clarification: a marker on a done or declined node holds nothing, and a node that needs a done one is ready", () => {
  const c = cfg();
  const mark = "[NEEDS CLARIFICATION: was it?]";
  const graph = {
    open: [{ id: "d", status: "done", title: mark }, { id: "x", needs: ["d", "e"] }, { id: "r", title: mark }],
    done: [{ id: "e", title: mark }],
    declined: [{ id: "r", reason: "no", title: mark }],
  };
  assert.deepEqual(readyNodes(graph, c).map((n) => n.id), ["x"]);
  assert.deepEqual(heldNodes(graph, c), [], "a finished or refused node waits on no answer");
});

test("clarification: a node that needs a held node waits, and the oldest way ends at a held node", () => {
  const c = cfg();
  const mark = (/** @type {string} */ q) => `[NEEDS CLARIFICATION: ${q}]`;
  // A need held: the node waits, as on any open need; the held node is named, the waiting one is not.
  const open = [{ id: "p", value: "high", needs: ["h"] }, { id: "h", value: "low", title: mark("which?") }, { id: "q", value: "low" }];
  assert.deepEqual(readyNodes({ open, done: [] }, c).map((n) => n.id), ["q"]);
  assert.deepEqual(heldNodes({ open, done: [] }, c).map((h) => h.node.id), ["h"]);
  assert.deepEqual(oldest(open), ["q", "q"], "p's way ends at h");
  // Nor is the way walked on past a held need: what it needs does not serve the node above it.
  const past = [{ id: "p", value: "high", needs: ["h"] }, { id: "h", title: mark("which?"), needs: ["x"] }, { id: "x", value: "low" }, { id: "next", value: "high" }];
  assert.deepEqual(oldest(past), ["next", "next"]);
  assert.deepEqual(oldest(past.map((n) => (n.id === "h" ? { id: "h", needs: ["x"] } : n))), ["x", "p"], "the control: no marker, the way goes through");
  // The oldest node itself held: never the slot's old node, nor served through a ready need of its own.
  const own = [{ id: "old", value: "high", source: mark("for whom?"), needs: ["step"] }, { id: "step", value: "low" }, { id: "young", value: "high" }];
  assert.deepEqual(oldest(own), ["young", "young"]);
  assert.deepEqual(oldest(own.map((n) => (n.id === "old" ? { id: "old", value: "high", needs: ["step"] } : n))), ["step", "old"], "the control: no marker");
  // A held node on the way to a ready node by another need: the other need serves.
  assert.deepEqual(oldest([{ id: "p", value: "high", needs: ["h", "r"] }, { id: "h", title: mark("?") }, { id: "r", value: "low" }]), ["r", "p"]);
});

test("clarification: configured field names; held nodes in the list's order", () => {
  const c = cfg({ graph: { fields: { id: "kimlik", status: "durum", title: "baslik", mechanization: "mekanizasyon" }, doneStatus: "tamam" } });
  const open = [
    { kimlik: "b", baslik: "[NEEDS CLARIFICATION: iki?]" },
    { kimlik: "a", baslik: "[NEEDS CLARIFICATION: bir?]", mekanizasyon: true },
    { kimlik: "t", baslik: "[NEEDS CLARIFICATION: bitti?]", durum: "tamam" },
    { kimlik: "z" },
  ];
  assert.deepEqual(heldNodes({ open, done: [] }, c).map((h) => [h.node.kimlik, h.question]), [["b", "iki?"], ["a", "bir?"]]);
  assert.deepEqual(readyNodes({ open, done: [] }, c).map((n) => n.kimlik), ["z"]);
});

test("clarification: a node a module builds with a loop or a deep nest is read without the call stack", { timeout: 30_000 }, () => {
  /** @type {any} */
  const loop = { id: "l", title: "plain" };
  loop.self = loop;
  loop.list = [loop, { back: loop }];
  assert.equal(clarification(loop), null);
  loop.list.push("[NEEDS CLARIFICATION: found?]");
  assert.equal(clarification(loop), "found?");
  /** @type {any} */
  let deep = { text: "[NEEDS CLARIFICATION: bottom?]" };
  for (let i = 0; i < 100_000; i++) deep = { next: deep };
  assert.equal(clarification({ id: "d", deep }), "bottom?");
  const wide = { id: "w", list: Array.from({ length: 300_000 }, (_, i) => String(i)) };
  assert.equal(clarification(wide), null);
});

test("clarification: the walk stops at a value that is another node of the graph, so a shared object holds only its own node", async () => {
  const c = cfg();
  // A module graph whose nodes share objects: b links to a, which holds the marker; d links to a done node with one.
  /** @type {any} */
  const a = { id: "a", title: "[NEEDS CLARIFICATION: for a?]" };
  const done = { id: "z", title: "[NEEDS CLARIFICATION: was it?]" };
  const gone = { id: "r", reason: "no", title: "[NEEDS CLARIFICATION: why?]" };
  const b = { id: "b", parent: a };
  const d = { id: "d", from: [done, { via: gone }] };
  a.child = b;
  const graph = { open: [a, b, d], done: [done], declined: [gone] };
  assert.deepEqual(heldNodes(graph, c).map((h) => [h.node.id, h.question]), [["a", "for a?"]], "b and d hold no marker of their own");
  assert.deepEqual(readyNodes(graph, c).map((n) => n.id), ["b", "d"]);
  // The control: the same objects outside the graph's lists are the node's own text, and hold it.
  assert.deepEqual(heldNodes({ open: [b, d], done: [] }, c).map((h) => [h.node.id, h.question]), [["b", "for a?"], ["d", "was it?"]]);
  // An object two nodes share that is no node is each node's own text: both held.
  const meta = { ask: "[NEEDS CLARIFICATION: shared?]" };
  assert.deepEqual(heldNodes({ open: [{ id: "m1", meta }, { id: "m2", meta }], done: [] }, c).map((h) => [h.node.id, h.question]), [["m1", "shared?"], ["m2", "shared?"]]);
  // A node that holds itself is still read.
  /** @type {any} */
  const self = { id: "s", text: "[NEEDS CLARIFICATION: me?]" };
  self.me = self;
  assert.deepEqual(heldNodes({ open: [self], done: [] }, c).map((h) => h.question), ["me?"]);
  // As a module graph loads it.
  const dir = graphFile("graph.mjs", 'const a = { id: "a", title: "[NEEDS CLARIFICATION: for a?]" };\nconst b = { id: "b", parent: a };\nexport const nodes = [a, b];\nexport const done = [];\n');
  const loaded = await loadGraph({ cwd: dir, config: cfg({ paths: { graph: ".ennyn/graph.mjs" } }) });
  assert.deepEqual(heldNodes(loaded, c).map((h) => h.node.id), ["a"]);
  assert.deepEqual(readyNodes(loaded, c).map((n) => n.id), ["b"]);
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
  assert.deepEqual(noDone, { open: [], done: [], declined: [] });
});

test("declined: a third list, read from JSON, a named export or the default one; none is an empty list; a bad one is a GraphError", async () => {
  const declined = [{ id: "x", title: "an idea", reason: "no user asks for it", since: 25 }];
  const json = await loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ nodes: [{ id: "a" }], done: [], declined })), config: cfg() });
  assert.deepEqual(json.declined, declined);
  for (const [name, text] of [["graph.mjs", `export const nodes = [{ id: "a" }];\nexport const refused = ${JSON.stringify(declined)};\n`], ["graph.mjs", `export default { nodes: [{ id: "a" }], refused: ${JSON.stringify(declined)} };\n`], ["graph.js", `module.exports = { nodes: [{ id: "a" }], refused: ${JSON.stringify(declined)} };\n`]]) {
    const g = await loadGraph({ cwd: graphFile(name, text), config: cfg({ paths: { graph: `.ennyn/${name}` }, graph: { exports: { declined: "refused" } } }) });
    assert.deepEqual(g.declined, declined, text);
  }
  assert.deepEqual((await loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ nodes: [] })), config: cfg() })).declined, []);
  await assert.rejects(loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ nodes: [], declined: {} })), config: cfg() }), (e) => e instanceof GraphError && /"declined" must be an array \(graph\.exports\.declined\)/.test(e.message));
  await assert.rejects(loadGraph({ cwd: graphFile("graph.json", JSON.stringify({ nodes: [], declined: [{ id: "x" }, "y"] })), config: cfg() }), (e) => e instanceof GraphError && /"declined"\[1\] is not an object/.test(e.message));
});

test("declined: never picked, an id in two lists is refused, and a node that needs a declined one is refused, not left waiting", () => {
  const c = cfg();
  const keys = (/** @type {any} */ g) => graphProblems(g, c).map((p) => `${p.level} ${p.key}`);
  const declined = [{ id: "x", reason: "no user asks for it" }];
  assert.deepEqual(keys({ open: [{ id: "a" }], done: [], declined }), []);
  // Left in the open list too: refused, and the library picks still pass it by.
  const twice = { open: [{ id: "x", value: "high", cost: "S" }, { id: "m", mechanization: true, value: "high", cost: "S" }, { id: "a", value: "low", cost: "S" }], done: [], declined: [{ id: "x", reason: "r" }, { id: "m", reason: "r" }] };
  assert.deepEqual(keys(twice), ["fail doctor.idDuplicate"]);
  assert.deepEqual(graphProblems(twice, c)[0].vars.list, ["x", "m"]);
  assert.deepEqual(readyNodes(twice, c).map((n) => n.id), ["a"]);
  assert.equal(pickMechanization(twice, c), null);
  assert.equal(pickOldest(twice, c)?.node.id, "a");
  assert.equal(pickOldest({ open: [{ id: "h", value: "high", needs: ["x"] }, { id: "x", value: "low" }, { id: "l", value: "low" }], done: [], declined: [{ id: "x", reason: "r" }] }, c)?.node.id, "l", "no way through a declined node");
  assert.equal(pickOldest({ open: [{ id: "x", value: "high", needs: ["r"] }, { id: "r", value: "low" }], done: [], declined: [{ id: "x", reason: "r" }] }, c)?.oldest.id, "r", "a declined node is no old node the pick serves");
  // Declined and done, or declined twice: which is it? Refused too.
  assert.deepEqual(keys({ open: [], done: [{ id: "x" }], declined }), ["fail doctor.idDuplicate"]);
  assert.deepEqual(keys({ open: [{ id: "x", status: "done" }], done: [], declined }), ["fail doctor.idDuplicate"]);
  assert.deepEqual(keys({ open: [], done: [], declined: [...declined, ...declined] }), ["fail doctor.idDuplicate"]);
  // A waiting node that needs a declined one: its own fail, never "does not exist", never a need dropped.
  const needs = graphProblems({ open: [{ id: "r", needs: ["x", "ghost"] }], done: [], declined }, c);
  assert.deepEqual(needs.map((p) => [p.level, p.key, p.vars.list]), [["fail", "doctor.needsDeclined", ["x"]], ["fail", "doctor.needsUnknown", ["ghost"]]]);
  assert.match(tShown("doctor.needsDeclined", needs[0].vars, "en"), /^work graph: r needs declined nodes: x; drop the need or keep the node$/);
  assert.deepEqual(readyNodes({ open: [{ id: "r", needs: ["x"] }], done: [], declined }, c), []);
  // A finished node's need on a declined one changes no pick.
  assert.deepEqual(keys({ open: [{ id: "r", status: "done", needs: ["x"] }], done: [], declined }), []);
  // An entry with no id, or no reason: said, as a guess the pick does not read.
  assert.deepEqual(keys({ open: [], done: [], declined: [{ reason: "r" }, { id: "y" }, { id: "z", reason: " " }] }), ["warn doctor.idMissing", "warn doctor.declinedReason"]);
  assert.deepEqual(graphProblems({ open: [], done: [], declined: [{ id: "y" }, { id: "z", reason: " " }] }, c).at(-1)?.vars.list, ["y", "z"], "a blank reason is none");
  assert.deepEqual(keys({ open: [], done: [], declined: [{}] }), ["warn doctor.idMissing"], "no id is said once, not as a node with no reason too");
  assert.deepEqual(graphProblems({ open: [], done: [], declined: [{ id: "y" }, { id: "z", reason: 3 }] }, c).at(-1)?.vars, { n: 2, field: "reason", list: ["y", "z"] });
  // Configured names: the reason field, and a graph built in code with no declined list at all.
  assert.deepEqual(keys({ open: [], done: [], declined: [{ id: "y", neden: "r" }] }), ["warn doctor.declinedReason"]);
  assert.deepEqual(graphProblems({ open: [], done: [], declined: [{ id: "y", neden: "r" }] }, cfg({ graph: { fields: { reason: "neden" } } })), []);
  assert.deepEqual(keys({ open: [{ id: "a", needs: ["x"] }], done: [] }), ["fail doctor.needsUnknown"]);
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

test("graphProblems (doctor audit, review): a source loses every character a line cannot show; ids are listed as names, each its own", () => {
  const c = cfg();
  // Direction and format marks a source written as text can hold: the left-to-right and Arabic letter marks, a soft hyphen.
  const dup = [{ id: "a", source: "‎ROADMAP.md:1" }, { id: "a", source: "ROAD؜MAP.md:2­" }];
  const where = String(graphProblems({ open: dup, done: [] }, c).find((p) => p.key === "doctor.idDuplicate")?.vars.where);
  assert.doesNotMatch(where, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, JSON.stringify(where));
  // An id holding the ", " that joins the list stays one id.
  const ids = [{ id: "x, y" }, { id: "x, y" }, { id: "z" }, { id: "z" }];
  const p = graphProblems({ open: ids, done: [] }, c).find((q) => q.key === "doctor.idDuplicate");
  assert.match(tShown(String(p?.key), p?.vars, "en"), /duplicate ids: "x, y", z/);
});

test("graphProblems (doctor audit, review round two): ZWNJ and ZWJ in a source stay, as in Persian and Indic names", () => {
  const dup = [{ id: "a", source: "نقشه\u200cراه.md:1" }, { id: "a", source: "x\u200e\u200cy.md:2" }];
  const where = String(graphProblems({ open: dup, done: [] }, cfg()).find((p) => p.key === "doctor.idDuplicate")?.vars.where);
  assert.ok(where.includes("نقشه\u200cراه.md:1"), JSON.stringify(where));
  assert.ok(where.includes("x \u200cy.md:2"), `a mark before it goes, the ZWNJ stays: ${JSON.stringify(where)}`);
});

test("audit slot: a record's key is a digest of its line, CR and byte order mark dropped; budget records and lines that do not parse are cycles, other JSON is not", () => {
  const rec = (/** @type {object} */ more = {}) => JSON.stringify({ kind: "budget", date: "2026-10-01", commit: "a".repeat(40), always: 1, onDemand: 0, repeatedLines: 0, ...more });
  const k = (/** @type {string} */ line) => lineKey(Buffer.from(line));
  assert.match(k(rec()), /^[0-9a-f]{16}$/);
  assert.equal(k(rec()), k(`${rec()}\r`), "a trailing CR");
  assert.equal(k(rec()), k(`\uFEFF${rec()}`), "a leading byte order mark");
  assert.notEqual(k(rec()), k(rec({ always: 2 })), "an edited record is another key");
  const mark = rec({ commit: "b".repeat(40), securityAudit: true, covers: ["0123456789abcdef", "NOT-A-KEY", 7, "0123456789ABCDEF"] });
  const text = [`\uFEFF${rec()}\r`, mark, "{ cut", "", "   ", "null", "[]", JSON.stringify({ kind: "gate" }), rec({ commit: "c".repeat(40), securityAudit: "true", covers: ["0123456789abcdef"] }), rec({ commit: 5 })].join("\n");
  // A line that is not UTF-8 keeps its own key.
  const bytes = Buffer.concat([Buffer.from(`${text}\n`), Buffer.from([0xff, 0xfe, 0x0a, 0xff, 0xfd, 0x0a])]);
  const records = cycleRecords(bytes);
  assert.deepEqual(
    records.map((r) => [r.budget, r.commit, r.mark, r.covers]),
    [
      [true, "a".repeat(40), false, []],
      [true, "b".repeat(40), true, ["0123456789abcdef"]],
      [false, null, false, []],
      [true, "c".repeat(40), false, []],
      [true, null, false, []],
      [false, null, false, []],
      [false, null, false, []],
    ],
  );
  assert.equal(records[0].key, k(rec()));
  assert.notEqual(records[5].key, records[6].key, "two lines that are not UTF-8 are two keys");
  assert.deepEqual(cycleRecords(null), []);
  // The log is only appended to: a record another names in `replaces` is replaced by it, wherever the two lines stand
  // (merge=union orders them as it likes); two records of one commit that name nothing both count (a log from before).
  const plainB = rec({ commit: "b".repeat(40), replaces: k(mark) });
  for (const lines of [[rec(), mark, plainB], [plainB, mark, rec()]]) {
    const again = cycleRecords(Buffer.from(lines.join("\n")));
    assert.deepEqual(new Set(again.map((r) => [r.key, r.mark, r.replaces].join(" "))), new Set([`${k(rec())} false `, `${k(plainB)} false ${k(mark)}`]));
  }
  const both = cycleRecords(Buffer.from([rec(), rec({ always: 2 }), rec({ replaces: "NOT-A-KEY" })].join("\n")));
  assert.equal(both.length, 3, "no key named, nothing replaced");
});

test("audit slot: due with no mark, or every N cycles no mark covers; a mark covers what it lists and itself; copies are one cycle", () => {
  /** @param {string} key @param {string[] | null} [covers] a mark when given */
  const r = (key, covers = null) => ({ key, budget: true, commit: null, mark: covers !== null, covers: covers ?? [] });
  const due = (/** @type {ReturnType<typeof r>[]} */ records, every = 3) => {
    const d = securityDue(records, every);
    return [d.due, d.reason, d.since];
  };
  assert.deepEqual(due([]), [true, "never", 0], "no audit recorded: the first is due");
  assert.deepEqual(due([r("a"), r("b"), r("c")]), [true, "never", 3]);
  assert.deepEqual(due([r("m", [])]), [false, "since", 0]);
  assert.deepEqual(due([r("m", []), r("a")]), [false, "since", 1]);
  assert.deepEqual(due([r("m", []), r("a"), r("b")]), [true, "since", 2]);
  // What a mark covers stops counting; what it does not list (a branch's audit that never saw them) keeps counting.
  assert.deepEqual(due([r("a"), r("b"), r("m", ["a", "b"])]), [false, "since", 0]);
  assert.deepEqual(due([r("a"), r("b"), r("x"), r("y"), r("m", ["a", "b"])]), [true, "since", 2]);
  // The order of the lines decides nothing; a line twice is one cycle; a mark without covers covers only itself.
  assert.deepEqual(due([r("m", ["a"]), r("a")]), [false, "since", 0]);
  assert.deepEqual(due([r("m", []), r("a"), r("a")]), [false, "since", 1]);
  assert.deepEqual(due([r("a"), r("b"), r("m", [])]), [true, "since", 2]);
  // 1: every cycle; 0: off.
  assert.deepEqual(due([r("m", [])], 1), [true, "since", 0]);
  assert.deepEqual(due([r("m", []), r("a"), r("b")], 0), [false, "off", 2]);
  assert.equal(securityDue([r("a"), r("a"), r("m", ["a"])], 3).cycles, 2);
  // A new mark lists each key no earlier mark covers, once.
  assert.deepEqual(markCovers([r("a"), r("m", ["a"]), r("b"), r("b"), r("c")]), ["b", "c"]);
  assert.deepEqual([...uncovered([r("a"), r("m", ["a"]), r("n", [])])], []);
});

test("audit slot: the sensitive paths are the risky globs, init-scan's risky paths, CI and lock files whether their check is on or not, the code that runs on the machines with its rule, and Ennyn's own files", () => {
  const c = cfg({ review: { impactRequiredGlobs: ["src/app.js"] } });
  const files = ["src/auth/login.js", "src/app.js", ".github/workflows/ci.yml", "sub/Package-Lock.json", "sub/.NPMRC", ".npmrc", ".ennyn/config.json", ".ennyn/metrics.jsonl", "docs/x.md", ".claude/settings.json", "package.json", ".husky/pre-commit", "Dockerfile", "go.sum", ".env.production"];
  const own = { configRel: ".ennyn/config.json", logRel: ".ennyn/metrics.jsonl" };
  const machine = [".github/workflows/ci.yml", "sub/Package-Lock.json", "sub/.NPMRC", ".npmrc", ".claude/settings.json", "package.json", ".husky/pre-commit", "Dockerfile", "go.sum", ".env.production"];
  const rules = [".github/**", "**/package-lock.json", "**/.npmrc", "**/.npmrc", ".claude/**", "**/package.json", ".husky/**", "**/Dockerfile", "**/go.sum", "**/.env.*"];
  assert.deepEqual(sensitivePaths(files, c, own), [
    { source: "review.impactRequiredGlobs", files: ["src/app.js"] },
    { source: "init-scan risky", files: ["src/auth/login.js"] },
    { source: "security.ci.paths", files: [".github/workflows/ci.yml"] },
    { source: "security.deps.paths", files: ["sub/Package-Lock.json", "sub/.NPMRC", ".npmrc"] },
    { source: "machine", files: machine, rules },
    { source: "ennyn", files: [".ennyn/config.json", ".ennyn/metrics.jsonl"] },
  ]);
  // A commit check turned off still has its files read, by the default globs, and says so.
  const off = cfg({ security: { ci: { paths: [] }, deps: { paths: [] } } });
  assert.deepEqual(sensitivePaths(files, off, { configRel: "elsewhere.json" }).filter((s) => s.source.startsWith("security.")), [
    { source: "security.ci.paths", files: [".github/workflows/ci.yml"], off: true },
    { source: "security.deps.paths", files: ["sub/Package-Lock.json", "sub/.NPMRC", ".npmrc"], off: true },
  ]);
  // A config git does not track is no path, and a source with no file is left out.
  assert.deepEqual(sensitivePaths(["docs/x.md"], c, own), []);
  // Every directory init-scan calls risky, past the ten its report lists, matched as written: glob characters too.
  const risky = ["auth", "billing", "crypto", "ledger", "login", "migrations", "oauth", "payments", "rbac", "secrets", "sessions"].map((d) => `src/${d}/a.js`);
  const literal = ["app/[locale]/auth/login.tsx", "src/{legacy}/payments/charge.js", "app/[locale]/login.tsx", "src/authx/a.js"];
  assert.deepEqual(sensitivePaths([...risky, ...literal], cfg(), {}).find((s) => s.source === "init-scan risky")?.files, [...risky, ...literal.slice(0, 3)]);
  // A file system that ignores case serves these as names the list holds: case, compatibility forms, full folding.
  const cased = [".Claude/settings.json", "claude.md", "Package.json", "makefile", "GNUmakefile", "api.Dockerfile", "Containerfile", "server.PEM", ".vscode/ta\u017fks.json", ".hu\u017fky/pre-commit", "\u017fcripts/x.sh", "Make\ufb01le"];
  assert.deepEqual(sensitivePaths(cased, cfg(), {}).find((s) => s.source === "machine")?.files, cased);
  assert.deepEqual(["Stra\u00dfe", "\ufb01le", "A\u017f"].map(folded), ["strasse", "file", "as"]);
});

test("audit slot: a plugin root at any depth names what Claude Code loads from it, the programs it runs and the text every session reads", () => {
  const root = [".claude-plugin/plugin.json", "skills/cycle/SKILL.md", "agents/r.md", ".lsp.json", "monitors/monitors.json", "settings.json", "commands/x.md", "output-styles/t.md", "workflows/w.js"];
  const nested = ["plugins/p/.claude-plugin/plugin.json", "plugins/p/hooks/hooks.json", "plugins/p/.mcp.json", "plugins/p/.lsp.json", "plugins/p/bin/tool", "plugins/p/skills/s/SKILL.md", "plugins/p/monitors/monitors.json"];
  // A case-insensitive file system serves plugins/q/agents/ from the folder the manifest names Plugins/Q/.
  const cased = ["Plugins/Q/.Claude-Plugin/plugin.json", "plugins/q/agents/a.md"];
  const not = ["src/a.js", "plugins/p/README.md", "other/skills/s/SKILL.md", "other/hooks/hooks.json", "other/.lsp.json", "elsewhere/skills/x.md"];
  const got = sensitivePaths([...root, ...nested, ...cased, ...not], cfg(), {}).find((s) => s.source === "machine");
  assert.deepEqual(got?.files, [...root, ...nested, ...cased]);
  assert.deepEqual(got?.rules, [
    "**/.claude-plugin/**", "skills/**", "agents/**", ".lsp.json", "monitors/monitors.json", "settings.json", "commands/**", "output-styles/**", "workflows/**",
    "**/.claude-plugin/**", "plugins/p/hooks/**", "plugins/p/.mcp.json", "plugins/p/.lsp.json", "plugins/p/bin/**", "plugins/p/skills/**", "plugins/p/monitors/**",
    "**/.claude-plugin/**", "Plugins/Q/agents/**",
  ]);
  // With no manifest a folder is no plugin root: a project's own skills/ or settings.json is no session's text.
  assert.deepEqual(sensitivePaths(["skills/s/SKILL.md", "settings.json", "agents/a.md", "x.claude-plugin/plugin.json"], cfg(), {}), []);
  // A plugin whose marketplace entry is its manifest keeps its servers at the top all the same.
  assert.deepEqual(sensitivePaths([".lsp.json", "monitors/monitors.json"], cfg(), {}), [{ source: "machine", files: [".lsp.json", "monitors/monitors.json"], rules: [".lsp.json", "monitors/monitors.json"] }]);
});

/**
 * Probe cells for the machine source, from the cycle 11 security review: `said` lists the probe files, `pass`
 * lists none of them (only the scaffolding a cell needs, such as a manifest). `listed` is the whole answer, file
 * and rule; a `gap` cell holds today's answer and names the node that would list the rest, so the cell changes
 * with that node. `links` are the index's symbolic links, by mode; `text` is what the review's link held, for the
 * record only: no link is resolved, each is listed under its own rule and audited by hand. `gitlinks` are
 * submodule entries.
 * @type {{ id: string, expect: "said" | "pass", files: string[], links?: string[], text?: Record<string, string>, gitlinks?: string[], config?: object, listed: [string, string][], gap?: string }[]}
 */
const MACHINE_CELLS = [
  {
    // A link named .claude-plugin makes its folder a plugin root by its name: the root's skills are listed.
    id: "link-root-manifest-hooks", expect: "said",
    files: [".claude-plugin", "meta/plugin.json", "meta/marketplace.json", "hooks", "cfg/h/hooks.json", "skills/s/SKILL.md", "src/a.js"], links: [".claude-plugin", "hooks"], text: { ".claude-plugin": "meta", hooks: "cfg/h" },
    listed: [[".claude-plugin", "symlink"], ["hooks", "symlink"], ["skills/s/SKILL.md", "skills/**"]],
  },
  {
    id: "link-nested-hooks", expect: "said",
    files: ["plugins/p/.claude-plugin/plugin.json", "plugins/p/hooks", "cfg/h2/hooks.json"], links: ["plugins/p/hooks"], text: { "plugins/p/hooks": "../../cfg/h2/" },
    listed: [["plugins/p/.claude-plugin/plugin.json", "**/.claude-plugin/**"], ["plugins/p/hooks", "symlink"]],
  },
  {
    id: "link-nested-manifest-folder", expect: "said",
    files: ["plugins/p/.Claude-Plugin", "plugins/p/skills/x.md", "plugins/q/.claude-plugin", "plugins/q/agents/a.md"], links: ["plugins/p/.Claude-Plugin"],
    listed: [["plugins/p/.Claude-Plugin", "symlink"], ["plugins/p/skills/x.md", "plugins/p/skills/**"]],
  },
  {
    id: "link-skill-target", expect: "said",
    files: ["plugins/p/.claude-plugin/plugin.json", "plugins/p/skills/foo", "docs/foo/SKILL.md", "docs/other.md"], links: ["plugins/p/skills/foo"], text: { "plugins/p/skills/foo": "../../../docs/foo" },
    listed: [["plugins/p/.claude-plugin/plugin.json", "**/.claude-plugin/**"], ["plugins/p/skills/foo", "symlink"]],
  },
  {
    id: "link-out", expect: "said",
    files: [".claude-plugin/plugin.json", "skills/up", "skills/abs"], links: ["skills/up", "skills/abs"], text: { "skills/up": "../../outside", "skills/abs": "/etc" },
    listed: [[".claude-plugin/plugin.json", "**/.claude-plugin/**"], ["skills/up", "symlink"], ["skills/abs", "symlink"]],
  },
  {
    // Whatever its name and depth: a link no rule names is listed too.
    id: "link-any-name", expect: "said",
    files: ["src/lib/data", "src/lib/a.js", ".mcp.json"], links: ["src/lib/data", ".mcp.json"],
    listed: [["src/lib/data", "symlink"], [".mcp.json", "symlink"]],
  },
  {
    // The kernel reads x/.. after following x (deep/real), a lexical reading real/: neither is guessed.
    id: "link-dotdot-after-link", expect: "said",
    files: ["hooks", "x", "real/hooks.json", "deep/real/hooks.json"], links: ["hooks", "x"], text: { hooks: "x/../real", x: "deep/y" },
    listed: [["hooks", "symlink"], ["x", "symlink"]],
  },
  {
    // Claude Code clones a marketplace into marketplaces/<name>/: a link can re-enter the clone by that name.
    id: "link-reenter-by-name", expect: "said",
    files: ["hooks", "cfg/h/hooks.json"], links: ["hooks"], text: { hooks: "../mkt/cfg/h" },
    listed: [["hooks", "symlink"]],
  },
  {
    id: "link-to-top", expect: "said",
    files: [".claude-plugin", "hooks", "skills/s/SKILL.md"], links: [".claude-plugin", "hooks"], text: { ".claude-plugin": ".", hooks: "." },
    listed: [[".claude-plugin", "symlink"], ["hooks", "symlink"], ["skills/s/SKILL.md", "skills/**"]],
  },
  {
    id: "link-to-top-dotdot", expect: "said",
    files: ["hooks", "cfg/x.json"], links: ["hooks"], text: { hooks: "cfg/.." },
    listed: [["hooks", "symlink"]],
  },
  {
    // Many links, none of them followed: each keeps its own rule, with no cap to spend.
    id: "alias-cap-own-rule", expect: "said",
    files: [...Array.from({ length: 50 }, (_, i) => `vendor/l${i}`), "hooks"], links: [...Array.from({ length: 50 }, (_, i) => `vendor/l${i}`), "hooks"],
    listed: [...Array.from({ length: 50 }, (_, i) => /** @type {[string, string]} */ ([`vendor/l${i}`, "symlink"])), ["hooks", "symlink"]],
  },
  {
    id: "link-target-case", expect: "said",
    files: ["hooks", "Cfg/H/hooks.json"], links: ["hooks"], text: { hooks: "cfg/h" },
    listed: [["hooks", "symlink"]],
  },
  {
    id: "link-target-nfd", expect: "said",
    files: ["hooks", "cfg/hä/hooks.json"], links: ["hooks"], text: { hooks: "cfg/hä" },
    listed: [["hooks", "symlink"]],
  },
  {
    id: "link-in-target", expect: "said",
    files: ["hooks", "cfg/hooks.json", "deep/x.json"], links: ["hooks", "cfg/hooks.json"], text: { hooks: "cfg", "cfg/hooks.json": "../deep/x.json" },
    listed: [["hooks", "symlink"], ["cfg/hooks.json", "symlink"]],
  },
  {
    // A conflict whose other side is a link: the name is a link (indexEntries; real git in test/budget.test.mjs).
    id: "conflict-theirs-link", expect: "said",
    files: ["src/conf.js"], links: ["src/conf.js"],
    listed: [["src/conf.js", "symlink"]],
  },
  {
    id: "root-skill-md", expect: "said",
    files: [".claude-plugin/plugin.json", "SKILL.md", "plugins/p/.claude-plugin/plugin.json", "plugins/p/SKILL.md", "docs/SKILL.md"],
    listed: [[".claude-plugin/plugin.json", "**/.claude-plugin/**"], ["SKILL.md", "SKILL.md"], ["plugins/p/.claude-plugin/plugin.json", "**/.claude-plugin/**"], ["plugins/p/SKILL.md", "plugins/p/SKILL.md"]],
  },
  {
    id: "themes", expect: "said",
    files: [".claude-plugin/plugin.json", "themes/dracula.json"],
    listed: [[".claude-plugin/plugin.json", "**/.claude-plugin/**"], ["themes/dracula.json", "themes/**"]],
  },
  {
    id: "submodule-gitlink", expect: "said",
    files: [".gitmodules", "plugins/r", "scripts/vendored", "src/a.js"], gitlinks: ["plugins/r", "scripts/vendored"],
    listed: [[".gitmodules", ".gitmodules"], ["plugins/r", "submodule"], ["scripts/vendored", "submodule"]],
  },
  {
    // A submodule named .claude-plugin makes its folder a plugin root, as a link of that name does: a recursive
    // clone brings the manifest in.
    id: "gitlink-named-manifest-dir", expect: "said",
    files: [".claude-plugin", ".gitmodules", "agents/a.md", "plugins/p/.claude-plugin", "plugins/p/skills/t/SKILL.md", "settings.json", "skills/s/SKILL.md"], gitlinks: [".claude-plugin", "plugins/p/.claude-plugin"],
    listed: [[".claude-plugin", "submodule"], [".gitmodules", ".gitmodules"], ["agents/a.md", "agents/**"], ["plugins/p/.claude-plugin", "submodule"], ["plugins/p/skills/t/SKILL.md", "plugins/p/skills/**"], ["settings.json", "settings.json"], ["skills/s/SKILL.md", "skills/**"]],
  },
  {
    id: "nested-lock-narrowed", expect: "said",
    files: ["plugins/p/package-lock.json", "plugins/p/npm-shrinkwrap.json"], config: { security: { deps: { paths: ["package-lock.json"] } } },
    listed: [["plugins/p/package-lock.json", "**/package-lock.json"], ["plugins/p/npm-shrinkwrap.json", "**/npm-shrinkwrap.json"]],
  },
  {
    id: "mcp-server-script", expect: "said", gap: "machine-named-paths",
    files: ["plugins/q/.claude-plugin/plugin.json", "plugins/q/.mcp.json", "plugins/q/server.js"],
    listed: [["plugins/q/.claude-plugin/plugin.json", "**/.claude-plugin/**"], ["plugins/q/.mcp.json", "plugins/q/.mcp.json"]],
  },
  {
    id: "hook-read-styles", expect: "said", gap: "machine-named-paths",
    files: [".claude-plugin/plugin.json", "hooks/hooks.json", "styles/terse.en.md", "i18n/en.json"],
    listed: [[".claude-plugin/plugin.json", "**/.claude-plugin/**"], ["hooks/hooks.json", "hooks/**"]],
  },
  {
    id: "neg-siblings", expect: "pass",
    files: ["plugins/p/.claude-plugin/plugin.json", "plugins/p/skillsx/a.md", "plugins/p/sub/skills/a.md", "plugins/p2/skills/a.md"],
    listed: [["plugins/p/.claude-plugin/plugin.json", "**/.claude-plugin/**"]],
  },
  {
    // A plain file named hooks is no folder of hooks; a plain file named .claude-plugin, or a link named
    // x.claude-plugin, makes no root (the link itself is listed, as every link is).
    id: "neg-root-elsewhere", expect: "pass",
    files: [".claude-plugin/plugin.json", "docs/skills/x.md", "hooks", "other/.claude-plugin", "other/skills/y.md", "docs/x.claude-plugin"], links: ["docs/x.claude-plugin"],
    listed: [[".claude-plugin/plugin.json", "**/.claude-plugin/**"], ["docs/x.claude-plugin", "symlink"]],
  },
];

test("audit slot: the machine source's probe cells, links, submodules and gaps among them", () => {
  for (const cell of MACHINE_CELLS) {
    const got = sensitivePaths(cell.files, cfg(cell.config ?? {}), { links: cell.links ?? [], gitlinks: cell.gitlinks ?? [] }).find((s) => s.source === "machine");
    const pairs = got ? got.files.map((f, i) => [f, got.rules?.[i]]) : [];
    assert.deepEqual(pairs, cell.listed, cell.id);
  }
});

test("config: security.everyCycles is a whole number from 0 to 100", () => {
  assert.equal(cfg().security.everyCycles, 3);
  for (const v of [0, 1, 100]) assert.equal(cfg({ security: { everyCycles: v } }).security.everyCycles, v);
  for (const v of [-1, 101, 2.5, "3", null]) assert.throws(() => cfg({ security: { everyCycles: v } }), /security\.everyCycles/, JSON.stringify(v));
});
