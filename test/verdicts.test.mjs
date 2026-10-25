/**
 * Every gate keeps the verdicts its probes were recorded with (test/verdicts.mjs): each cell of
 * test/verdicts/<gate>.json is replayed (the commit-msg hook's gates through the hook itself), and a verdict or
 * reason that moved fails here, a silent pass first. The input-shape matrix keeps its record the same way
 * (test/input-shapes.test.mjs). A known silent pass is a gap cell, named by an open node of the work graph.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIR, GATES, bytesOf, filled, hookOutcome, moves, movesText, readCells, reasonOf, record, run } from "./verdicts.mjs";

/** @param {string} gate */
async function replay(gate) {
  const cells = readCells(gate);
  assert.ok(cells.length > 0, `test/verdicts/${gate}.json holds no cell`);
  assert.equal(movesText(gate, moves(cells, await GATES[gate](cells))), "");
}

test("verdicts: every ci cell keeps its recorded verdict", () => replay("ci"));
test("verdicts: every deps cell keeps its recorded verdict", () => replay("deps"));
test("verdicts: every secrets cell keeps its recorded verdict", () => replay("secrets"));
test("verdicts: every forbidden cell keeps its recorded verdict", () => replay("forbidden"));
test("verdicts: every bans cell keeps its recorded verdict", () => replay("bans"));
test("verdicts: every hook cell keeps its recorded verdict", () => replay("hook"));
test("verdicts: every declarations cell keeps its recorded verdict", () => replay("declarations"));

test("verdicts: every cell file in test/verdicts/ is a gate's or the input-shape matrix's, and reads", () => {
  const files = readdirSync(DIR).sort();
  assert.deepEqual(files, [...Object.keys(GATES), "input-shapes"].map((g) => `${g}.json`).sort());
  for (const f of files) assert.ok(readCells(f.replace(/\.json$/, "")).length > 0, f);
});

test("verdicts: every gap and known limit names an open node of the work graph that names its cell file, or DESIGN.md's own words", async () => {
  const top = join(DIR, "..", "..");
  const config = loadConfig({ cwd: top, env: {} });
  const graph = await loadGraph({ cwd: top, config });
  const f = config.graph.fields;
  const doneStatus = config.graph.doneStatus;
  const open = new Map(graph.open.filter((n) => n[f.status] !== doneStatus).map((n) => [n[f.id], n]));
  const closed = new Set([...graph.done, ...graph.open.filter((n) => n[f.status] === doneStatus)].map((n) => n[f.id]));
  const design = readFileSync(join(top, "DESIGN.md"), "utf8");
  const wrong = [];
  let gaps = 0;
  let known = 0;
  for (const gate of [...Object.keys(GATES), "input-shapes"]) {
    for (const c of readCells(gate)) {
      for (const [kind, anchor] of /** @type {const} */ ([["gap", c.gap], ["known", c.known]])) {
        if (anchor === undefined) continue;
        if (kind === "gap") gaps++;
        else known++;
        if (kind === "known" && anchor.startsWith("DESIGN.md: ")) {
          if (!design.includes(anchor.slice("DESIGN.md: ".length))) wrong.push(`${gate}/${c.id}: DESIGN.md does not say ${JSON.stringify(anchor.slice(11))}`);
        } else if (closed.has(anchor)) wrong.push(`${gate}/${c.id}: ${anchor} is closed, and the cell still gets what it got: record what it gets now`);
        else if (!open.has(anchor)) wrong.push(`${gate}/${c.id}: ${anchor} is no open node of the work graph`);
        else if (!JSON.stringify([open.get(anchor).title, open.get(anchor)[f.source]]).includes(`test/verdicts/${gate}.json`)) wrong.push(`${gate}/${c.id}: node ${anchor} does not name test/verdicts/${gate}.json, so closing it would not lead to the cell`);
      }
    }
  }
  assert.ok(gaps > 0 && known > 0, "no gap or known limit is recorded: the check would read nothing");
  assert.deepEqual(wrong, []);
});

test("verdicts control: a moved verdict fails, silent passes first, then new refusals, refused and said swapped, another reason, and cells on one side only", () => {
  const cells = /** @type {const} */ ([
    { id: "a", verdict: "refused", why: ["x"] },
    { id: "b", verdict: "said", why: ["y"] },
    { id: "c", verdict: "pass" },
    { id: "d", verdict: "refused", why: ["x"] },
    { id: "e", verdict: "refused", why: ["x"] },
    { id: "f", verdict: "pass", gap: "node-1" },
    { id: "g", verdict: "said" },
  ]);
  /** @type {Map<string, import("./verdicts.mjs").Outcome>} */
  const got = new Map([
    ["a", { verdict: "pass" }],
    ["b", { verdict: "pass" }],
    ["c", { verdict: "refused", why: ["z"] }],
    ["d", { verdict: "said", why: ["x"] }],
    ["e", { verdict: "refused", why: ["x", "w"] }],
    ["f", { verdict: "refused", why: ["v"] }],
    ["h", { verdict: "pass" }],
  ]);
  const m = moves([...cells], got);
  assert.deepEqual(m, {
    silent: ["a: recorded refused, now pass", "b: recorded said, now pass"],
    refusals: ['c: recorded pass, now refused ["z"]', 'f: recorded pass, now refused ["v"] (the gap node-1 closed: record it)'],
    swapped: ['d: recorded refused, now said ["x"]'],
    reasons: ['e: refused, recorded why ["x"], now ["x","w"]'],
    known: [],
    unrun: ["g"],
    unrecorded: ["h: pass []"],
  });
  const text = movesText("x", m);
  assert.match(text, /^test\/verdicts\/x\.json: 8 cell\(s\) moved\nnow pass in silence/);
  assert.ok(text.indexOf("in silence") < text.indexOf("recorded as passing") && text.indexOf("recorded as passing") < text.indexOf("swapped"), text);
  assert.match(text, /in the same commit[\s\S]*retired with a reason/);
  assert.equal(movesText("x", moves([{ id: "a", verdict: "pass" }], new Map([["a", { verdict: "pass" }]]))), "");
  // A known limit that moves is its own group, with its anchor, not "the defect this corpus exists for".
  const known = moves([{ id: "k", verdict: "pass", known: "DESIGN.md: x" }, { id: "j", verdict: "refused", known: "node-2" }, { id: "i", verdict: "said", why: ["a"], known: "node-3" }, { id: "h", verdict: "said", why: ["a"], known: "node-3" }], new Map([["k", { verdict: "refused" }], ["j", { verdict: "pass" }], ["i", { verdict: "said", why: ["b"] }], ["h", { verdict: "said", why: ["a"] }]]));
  assert.deepEqual([known.silent, known.refusals, known.reasons, known.known], [[], [], [], ["k: recorded pass, now refused [] (a known limit: DESIGN.md: x)", "j: recorded refused, now pass [] (a known limit: node-2)", 'i: recorded said, now said ["b"] (a known limit: node-3)']]);
  assert.match(movesText("x", known), /^test\/verdicts\/x\.json: 3 cell\(s\) moved\na known limit moved/);
  // why is compared in the order the replay gives it (sorted there).
  assert.equal(moves([{ id: "a", verdict: "refused", why: ["x", "y"] }], new Map([["a", { verdict: "refused", why: ["y", "x"] }]])).reasons.length, 1);
});

test("verdicts control: the recorder adds a probe that gets what it expects or passes as the gap it names, keeps every recorded line as written, and refuses the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "en-verdicts-rec-"));
  const before = '[\n  { "id": "old", "text": "#!/bin/sh\\nexit 0\\n", "from": "by hand",   "verdict": "said" }\n]\n';
  writeFileSync(join(dir, "hook.json"), before);
  const wired = '#!/bin/sh\nnode /x/ennyn.mjs commit-check "$1"\n';
  const idle = "#!/bin/sh\necho hi\n";
  const r = await record(
    "hook",
    [
      { id: "new", text: wired, from: "a probe", expect: "pass" },
      { id: "plain", text: idle, from: "a probe", expect: "said" },
      { id: "gap", text: wired, from: "a probe", gap: "node-3" },
      { id: "old", text: wired, from: "again", expect: "pass" },
      { id: "missed", text: wired, from: "a probe", expect: "said" },
      { id: "no-expect", text: idle, from: "a probe" },
      { id: "laundered", text: wired, from: "a probe", verdict: "pass" },
      { id: "with-why", text: wired, from: "a probe", expect: "pass", why: ["x"] },
      { id: "typo", txt: wired, from: "a probe", expect: "said" },
      { id: "odd-expect", text: wired, from: "a probe", expect: "maybe" },
      { id: "nofrom", text: wired, expect: "pass" },
      { id: "fake-gap", text: idle, from: "a probe", gap: "node-2" },
      { id: "empty-gap", text: wired, from: "a probe", gap: " " },
      { id: "why-missed", text: "Never use `eval`.", from: "a probe", expect: "said", expectWhy: "exit" },
      { id: "text-list", text: ["x"], from: "a probe", expect: "said" },
      { id: "why-number", text: "x", from: "a probe", expect: "pass", expectWhy: 3 },
    ],
    { dir },
  );
  assert.deepEqual(r.added.map((c) => [c.id, c.verdict, c.gap ?? null]), [["new", "pass", null], ["plain", "said", null], ["gap", "pass", "node-3"]]);
  const says = r.refused.join("\n");
  for (const re of [/old: recorded already/, /missed: expected said, got pass/, /no-expect: expect is not one of/, /laundered: a probe's verdict is what it expects: name it "expect"/, /with-why: a probe gives no why/, /typo: "txt" is no input of hook/, /odd-expect: expect is not one of/, /needs an id and a from/, /fake-gap: not a gap, it gets said/, /empty-gap: a gap names the graph node/]) assert.match(says, re);
  assert.match(says, /why-missed: expected a why holding "exit"/);
  assert.match(says, /text-list: "text" is not a string/);
  assert.match(says, /why-number: expectWhy is a key or words of a line/);
  assert.equal(r.refused.length, 13, says);
  const after = readFileSync(join(dir, "hook.json"), "utf8");
  assert.ok(after.startsWith(before.slice(0, before.lastIndexOf("\n]"))), "the recorded line is kept as written");
  assert.deepEqual(readCells("hook", dir).map((c) => c.id), ["old", "new", "plain", "gap"]);
  assert.ok(!after.includes('"expect"'), "what a probe expects is not recorded");
  // Into an empty list too; a gate that does not exist is an error.
  writeFileSync(join(dir, "bans.json"), "[\n]\n");
  await record("bans", [{ id: "b", text: "Never use `eval`.", from: "p", expect: "said", expectWhy: ["eval"] }], { dir });
  assert.deepEqual(readCells("bans", dir).map((c) => [c.id, c.verdict, c.why]), [["b", "said", ["eval"]]]);
  // A cell is replayed twice: one whose why differs between the runs is refused.
  let call = 0;
  const flaky = async (/** @type {any[]} */ cells) => new Map(cells.map((c) => [c.id, { verdict: /** @type {const} */ ("said"), why: [`run ${call++}`] }]));
  const twice = await record("bans", [{ id: "f", text: "x", from: "p", expect: "said" }], { dir, replay: flaky });
  assert.match(twice.refused.join(), /f: its why differs between two runs/);
  // A probe the replay gives no verdict for (a dead cell, a hook that died) is refused; the others are still recorded.
  const dies = async (/** @type {any[]} */ cells) => {
    if (cells.some((c) => c.id === "dead")) throw new Error("dead: stages nothing (no files, or files equal to head): a dead cell");
    return new Map(cells.map((c) => [c.id, { verdict: /** @type {const} */ ("pass") }]));
  };
  const some = await record("bans", [{ id: "dead", text: "x", from: "p", expect: "pass" }, { id: "alive", text: "x", from: "p", expect: "pass" }], { dir, replay: dies });
  assert.deepEqual([some.added.map((c) => c.id), some.refused], [["alive"], ["dead: no verdict: dead: stages nothing (no files, or files equal to head): a dead cell"]]);
  await assert.rejects(record("nope", [], { dir }), /no gate "nope"/);
});

test("verdicts control: a byte value reads as its encoding, a place is filled, a hook line is its catalog key and values, and a cell of the wrong shape is refused", () => {
  assert.deepEqual(bytesOf("é"), Buffer.from([0xc3, 0xa9]));
  assert.deepEqual(bytesOf({ latin1: "é" }), Buffer.from([0xe9]));
  assert.deepEqual(bytesOf({ hex: "00ff" }), Buffer.from([0, 0xff]));
  assert.deepEqual(bytesOf({ utf16le: "a", bom: true }), Buffer.from([0xff, 0xfe, 0x61, 0]));
  assert.deepEqual(bytesOf({ utf16be: "a" }), Buffer.from([0, 0x61]));
  assert.deepEqual(bytesOf({ utf32le: "\u{1f600}" }), Buffer.from([0, 0xf6, 1, 0]));
  assert.deepEqual(bytesOf({ utf32be: "a", bom: true }), Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61]));
  assert.deepEqual(bytesOf(["a", { hex: "00" }]), Buffer.from([0x61, 0]));
  assert.equal(bytesOf({ json: { a: 1 } }).toString(), '{\n  "a": 1\n}\n');
  for (const bad of [{ hex: "0g" }, { hex: "abc" }, { latin1: "ş" }, { utf8: "a" }, { hex: "00", latin1: "a" }, 3, null]) assert.throws(() => bytesOf(bad), /not a byte value/, JSON.stringify(bad));
  const f = filled({ a: "{{npm}} {{nope}} ${{ github.x }} {{rand:4:HEX:1}} {{begin:RSA PRIVATE KEY}} {{body:2:3:escaped}} {{registry}}" }, { registry: "http://r" });
  assert.match(f.a, /^npm_\w{36} \{\{nope\}\} \$\{\{ github\.x \}\} [0-9a-f]{4} -----BEGIN RSA PRIVATE KEY----- [\w+/]{64}\\n[\w+/]{64} http:\/\/r$/);
  const before = Date.now();
  const t = filled({ a: "{{ago:3600}}", b: "{{ago:608400:+03:00}}", c: "{{b64pem:EC PRIVATE KEY:2:5:10:2}}" });
  assert.ok(Math.abs(Date.parse(t.a) - (before - 3600e3)) < 60e3, t.a);
  assert.match(t.b, /\+03:00$/);
  assert.ok(Math.abs(Date.parse(t.b) - (before - 608400e3)) < 60e3, t.b);
  assert.match(t.c, /^ {2}LS0tLS1CRU\n {2}[\w+/=]{1,10}(\n|$)/);
  assert.equal(Buffer.from(t.c.replace(/\s/g, ""), "base64").toString().split("\n")[0], "-----BEGIN EC PRIVATE KEY-----");
  // A hook line: its key and values; a reason inside it is its key; a line no template makes is said as it is.
  assert.equal(reasonOf(".github/workflows/w.yml: permissions: write-all gives every scope: line 3"), 'ci.writeAll {"path":".github/workflows/w.yml","where":"3"}');
  assert.equal(reasonOf("package-lock.json was not checked: not JSON"), 'deps.lockUnread {"path":"package-lock.json","reason":"deps.reason.notJson"}');
  assert.equal(reasonOf("package-lock.json was not checked: a reason no catalog has"), 'deps.lockUnread {"path":"package-lock.json","reason":"a reason no catalog has"}');
  assert.equal(reasonOf("something else"), "? something else");
  // A value that is git's or the engine's own text is not kept: it changes with the machine, not the reading.
  assert.equal(reasonOf("ennyn: git failed (fatal: bad object), so this commit was not checked: not its message, not its lines."), 'cli.hookGitFailed {"error":"…"}');
  // The hook's exit and lines: refused, said, a silent pass; a hook that died is no verdict.
  assert.deepEqual(hookOutcome("x", 1, "something else\n"), { verdict: "refused", why: ["? something else"] });
  assert.deepEqual(hookOutcome("x", 0, "b\na\na\n"), { verdict: "said", why: ["? a", "? b"] });
  assert.deepEqual(hookOutcome("x", 0, ""), { verdict: "pass" });
  assert.throws(() => hookOutcome("x", 1, "TypeError: boom\n    at main (scripts/ennyn.mjs:1:1)\n"), /x: the hook died \(exit 1\)/);
  assert.throws(() => hookOutcome("x", 134, ""), /the hook died \(exit 134\)/);
  assert.throws(() => hookOutcome("x", null, ""), /the hook died \(exit null\)/);
  const dir = mkdtempSync(join(tmpdir(), "en-verdicts-shape-"));
  writeFileSync(join(dir, "forbidden.json"), JSON.stringify([{ id: "a", verdict: "maybe", from: "p" }, { id: "a", verdict: "pass" }, { verdict: "pass", from: "p", why: "w" }, { id: "g", verdict: "refused", from: "p", gap: "n" }, { id: "t", verdict: "pass", from: "p", rule: [] }, { id: "l", verdict: "pass", from: "p", files: ["f.txt"], rules: {}, known: 3 }, { id: "w", verdict: "pass", from: "p", known: "just some words that are long enough", rules: [{ paths: ["**"] }] }]));
  assert.throws(() => readCells("forbidden", dir), (/** @type {Error} */ e) => {
    assert.deepEqual(e.message.split("\n").slice(1), [
      "cell 1 (a): verdict is not one of refused, said, pass",
      "cell 2 (a): the id is there twice",
      "cell 2 (a): no from",
      "cell 3: no id",
      "cell 3: why is not a list of strings",
      "cell 4 (g): a gap is a silent pass named by the graph node that closes it",
      'cell 5 (t): "rule" is no input of forbidden (rules, files, head, config, message)',
      'cell 6 (l): "rules" is not a list of rules with a text, "files" is not an object of names',
      'cell 6 (l): known names no anchor (a graph node, or "DESIGN.md: <its words>")',
      'cell 7 (w): "rules" is not a list of rules with a text',
      'cell 7 (w): known names no anchor (a graph node, or "DESIGN.md: <its words>")',
    ]);
    return true;
  });
});

test("verdicts control: a cell's git and hook see none of the outer repository's environment", async () => {
  // As inside a git hook: GIT_DIR and the rest point at another repository; ENNYN_CONFIG at another config.
  const decoy = mkdtempSync(join(tmpdir(), "en-verdicts-decoy-"));
  git(["init", "-q"], { cwd: decoy });
  writeFileSync(join(decoy, "a.txt"), "a\n");
  git(["add", "a.txt"], { cwd: decoy });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "decoy"], { cwd: decoy });
  writeFileSync(join(decoy, "config.json"), JSON.stringify({ security: { secrets: { except: ["**"] } } }));
  const before = git(["log", "--format=%H %s", "--all"], { cwd: decoy });
  const index = readFileSync(join(decoy, ".git", "index"));
  const outer = { GIT_DIR: join(decoy, ".git"), GIT_INDEX_FILE: join(decoy, ".git", "index"), GIT_WORK_TREE: decoy, GIT_PREFIX: "sub/", ENNYN_CONFIG: join(decoy, "config.json") };
  const saved = Object.fromEntries(Object.keys(outer).map((k) => [k, process.env[k]]));
  Object.assign(process.env, outer);
  let got;
  try {
    got = await GATES.secrets([{ id: "decoy", files: { "a.txt": "t = {{npm}}\n" }, from: "control", verdict: "refused" }]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(got.get("decoy")?.verdict, "refused", JSON.stringify(got.get("decoy")));
  assert.equal(git(["log", "--format=%H %s", "--all"], { cwd: decoy }), before, "the outer repository gained a commit");
  assert.deepEqual(readFileSync(join(decoy, ".git", "index")), index, "the outer index changed");
  // A hook line that names the cell's own registry keeps the place, not the run's port.
  const own = await GATES.deps([{ id: "own", files: { ".npmrc": "registry={{registry}}/evil/\n" }, rule: { registries: { "https://registry.npmjs.org": null } }, from: "control", verdict: "refused" }]);
  assert.match(JSON.stringify(own.get("own")), /\{\{registry\}\}\/evil\//);
  assert.doesNotMatch(JSON.stringify(own.get("own")), /127\.0\.0\.1/);
});

test("verdicts control: a hook that crashes, hangs or is given a cell that stages nothing gives no verdict", async () => {
  // main()'s catch-all: an error with no stack and exit 1, which no refusal prints.
  assert.throws(() => hookOutcome("x", 1, "ennyn commit-check: Cannot read properties of null (reading 'x')\n"), /x: the hook died/);
  assert.throws(() => hookOutcome("x", 0, "a.txt: something\nennyn commit-check: boom\n"), /x: the hook died/);
  assert.throws(() => hookOutcome("x", null, "", true), /x: the hook ran past/);
  // run() stops a process past its limit.
  const t0 = Date.now();
  const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: tmpdir(), limit: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 20000, "the process was not stopped");
  // A cell whose files equal HEAD's, or give none, stages nothing: no verdict.
  const wf = "on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: a/b@v1\n";
  await assert.rejects(GATES.ci([{ id: "same", files: { "w.yml": wf }, head: { "w.yml": wf }, from: "control", verdict: "pass" }]), /same: stages nothing/);
  await assert.rejects(GATES.forbidden([{ id: "none", rules: [{ text: "x" }], from: "control", verdict: "pass" }]), /none: stages nothing/);
});
