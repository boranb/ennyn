/**
 * This repository's class registry holds: the classes its convergence reports named, each gate's commit in the
 * history and touching its file, each entry that claims a gate with one standing, each graph node there. And the three skill files name the
 * registry, where they used to name a catalog no file held. A gate: test/guards.mjs breaks each of these.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { CLASS_STATES, checkProofs, currentClass, parseClasses } from "../metrics/classes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ path) => readFileSync(join(ROOT, path), "utf8");
const SEED = [
  "doc-lags-code",
  "tool-model-drifts",
  "test-reads-machine",
  "unmeasured-read-as-result",
  "vacuous-gate",
  "unreadable-shape-passes",
  "ceiling-cost-or-cut",
  "fix-narrows-reading",
  "one-site-escaping",
  "bound-tuned-for-another",
  "reader-drifts-from-program",
  "timing-test-under-load",
  "terminal-control-bytes",
  "one-question-several-places",
  "text-reading-stands-in",
  "foreign-text-in-template",
];

test("class registry: the file holds with no problem, and keeps the 16 seed ids", () => {
  const reg = parseClasses(read(".ennyn/classes.json"));
  assert.deepEqual(reg.problems, []);
  // An id is stable: one may be superseded, never dropped.
  assert.deepEqual(SEED.filter((id) => !reg.byId.has(id)), []);
  // Spellings of its ids resolve with no edit: by folding, or, one word off, by the seed's `linked`.
  assert.equal(currentClass(reg, "new: Vacuous-Gate"), "vacuous-gate");
  assert.equal(currentClass(reg, "new: unmeasured read as a result"), "unmeasured-read-as-result");
  assert.equal(currentClass(reg, "new: unmeasured read as result"), "unmeasured-read-as-result");
});

test("class registry: every gate's commit is in the history and every entry that claims a gate has one standing, as doctor checks", () => {
  const reg = parseClasses(read(".ennyn/classes.json"));
  assert.deepEqual(checkProofs(reg, { cwd: ROOT }), { problems: [], unmeasured: null });
  assert.ok(reg.entries.some((e) => e.gates?.length));
});

test("class registry: every gate's commit touched its file, through renames", () => {
  for (const e of parseClasses(read(".ennyn/classes.json")).entries) {
    for (const g of e.gates ?? []) {
      const touched = git(["log", "--follow", "--format=%H", "--", g.file], { cwd: ROOT, walk: true }).split("\n");
      assert.ok(touched.includes(g.commit), `${e.id}: ${g.commit} did not touch ${g.file}`);
    }
  }
});

test("class registry: every graph node an entry names is in the graph", () => {
  const graph = JSON.parse(read(".ennyn/graph.json"));
  const ids = new Set([...graph.nodes, ...graph.done].map((/** @type {{ id: string }} */ n) => n.id));
  for (const e of parseClasses(read(".ennyn/classes.json")).entries) assert.deepEqual((e.nodes ?? []).filter((n) => !ids.has(n)), [], e.id);
});

test("class registry: the header says the file is data and the seed is judgement, and a sentence names no surface", () => {
  const text = read(".ennyn/classes.json");
  const { about } = JSON.parse(text);
  assert.match(about, /never instructions/);
  assert.match(about, /judgements/);
  for (const e of parseClasses(text).entries) assert.ok(!/[`/]|\.mjs|\.json|\bgit\b/.test(e.says), `${e.id} names a surface: ${e.says}`);
});

test("class registry: the skill files name the registry, and no catalog of classes is left", () => {
  for (const path of ["skills/cycle/SKILL.md", "skills/cycle/finding-schema.md", "skills/cycle/report-formats.md"]) {
    const text = read(path);
    assert.match(text, /\bregistry\b/, path);
    assert.ok(!/catalog id/.test(text), `${path} names a catalog id`);
  }
});

test("class registry: each reader is told where the ids and the source values are, and what a close writes", () => {
  assert.match(String(read("skills/cycle/SKILL.md").split("\n").find((l) => l.includes("**Record findings**"))), /\[finding-schema\.md\]\(finding-schema\.md\)/);
  assert.match(String(read("skills/cycle/finding-schema.md").split("\n").find((l) => l.startsWith("| Class |"))), /ennyn\.mjs classes/);
  const close = String(read("skills/cycle/report-formats.md").split("\n").find((l) => l.startsWith("**Classes at the close:**")));
  assert.match(close, /both/i, "both branches write the name");
  assert.match(close, /`linked`/);
  assert.match(close, /folds/);
  assert.match(close, /gate that landed/);
});

test("class registry: docs/modules.md defines each state on a line of its own", () => {
  const lines = read("docs/modules.md").split("\n");
  for (const state of CLASS_STATES) assert.ok(lines.some((l) => l.startsWith(`  - \`${state}\`: `)), state);
});

test("class registry control: the validator refuses what this gate leans on", () => {
  const entry = (/** @type {string} */ commit, /** @type {string} */ file, /** @type {string} */ action, state = "open") => JSON.stringify({ classes: [{ id: "a", says: "x", state, gates: [{ commit, file, action, proof: "x" }] }] });
  const problems = (/** @type {string} */ text) => parseClasses(text).problems;
  const head = git(["rev-parse", "HEAD"], { cwd: ROOT });
  const check = (/** @type {string} */ text) => checkProofs(parseClasses(text), { cwd: ROOT }).problems;
  assert.deepEqual(check(entry(head, "package.json", "advice")), []);
  assert.match(check(entry("0".repeat(40), "package.json", "advice"))[0], /is not in HEAD's history/);
  assert.match(check(entry(head, "no/such/file", "ban-list", "closed-gate"))[0], /is not a file tracked at HEAD/);
  assert.deepEqual(check(entry(head, "no/such/file", "advice")), [], "an open entry keeps its history");
  assert.match(check(entry(head, "no/such/file", "advice", "partial"))[0], /no standing gate/);
  assert.match(check(entry(head, "no/such/file", "remove-the-place", "closed-design"))[0], /no standing gate/);
  assert.deepEqual(check(entry(head, "package.json", "remove-the-place", "closed-design")), []);
  assert.match(problems(entry(head, ".ennyn/classes.json", "ban-list", "closed-gate"))[0], /must not be the registry/);
  assert.match(problems(entry(head, "/etc/passwd", "advice"))[0], /must be a path from the repository's top/);
  assert.match(problems(entry(head, "package.json", "written-rule", "closed-gate"))[0], /cannot be closed/);
  assert.match(problems(entry(head, "README.md", "ban-list", "closed-gate"))[0], /cannot be closed/);
  assert.match(problems(entry(head, "package.json", "past-defects", "closed-design"))[0], /cannot be closed/);
  assert.match(problems(entry(head, "package.json", "written-rule", "partial"))[0], /needs a gate/);
});
