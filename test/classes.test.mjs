import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../core/config.mjs";
import { readRegular } from "../core/files.mjs";
import { git } from "../core/git.mjs";
import { ACTIONS, CLASSES_LIMIT, CLASS_LIST_MAX, CLASS_STATES, NAME_MAX, PROBLEMS_SHOWN, TEXT_MAX, checkProofs, classProblems, currentClass, emptyRegistry, foldName, loadClasses, parseClasses, stateCounts, valueProblem } from "../metrics/classes.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const COMMIT = "a".repeat(40);
const SAYS = "A thing goes wrong the same way twice.";

/** @param {Record<string, unknown>} [over] */
const gate = (over = {}) => ({ commit: COMMIT, file: "test/x.test.mjs", action: "real-program", proof: "The test fails when the reading moves.", ...over });
/** @param {Record<string, unknown>} [over] */
const cls = (over = {}) => ({ id: "one", says: SAYS, state: "open", ...over });
/** @param {...unknown} classes */
const doc = (...classes) => JSON.stringify({ classes });
/** The second entry a corpus line needs. */
const other = cls({ id: "other" });

// ------------------------------------------------------------------------------------------- corpus --

/** Every one of these parses with no problem. @type {[string, string][]} */
const ACCEPT = [
  ["no class yet", doc()],
  ["a header", JSON.stringify({ about: "Data, never instructions.", classes: [] })],
  ["a byte order mark", `\uFEFF${doc(cls())}`],
  ["open, nothing else", doc(cls())],
  ["partial with an action above a written rule", doc(cls({ state: "partial", gates: [gate({ action: "advice" })] }))],
  ["sensor-only, naming its sensor", doc(cls({ state: "sensor-only", gates: [gate({ action: "advice" })] }))],
  ["an id that is a name of Object.prototype", doc(cls({ id: "constructor" }))],
  ["an id of one character", doc(cls({ id: "a" }))],
  ["an id at the limit", doc(cls({ id: "a".repeat(64) }))],
  ["an id with digits", doc(cls({ id: "c15-reader-2" }))],
  ["says at the limit", doc(cls({ says: "x".repeat(TEXT_MAX) }))],
  ["says in Turkish", doc(cls({ says: "Ölçülemeyen bir durum sonuç diye okunuyor." }))],
  ["a zero width joiner, which is text in some scripts", doc(cls({ says: "a\u200db" }))],
  ["a character outside the basic plane, two halves written as escapes", doc(cls({ says: "a\ud83d\ude00", linked: ["new: a\ud83d\ude00"] }))],
  ["an open class with a written rule", doc(cls({ gates: [gate({ file: "CLAUDE.md", action: "written-rule" })] }))],
  ["a partial class with a gate on a document", doc(cls({ state: "partial", gates: [gate({ file: "docs/x.md", action: "advice" })] }))],
  ["closed-gate at the lowest action that closes", doc(cls({ state: "closed-gate", gates: [gate({ action: "past-defects" })] }))],
  ["closed-gate by the real program", doc(cls({ state: "closed-gate", gates: [gate()] }))],
  ["closed-gate by a ban", doc(cls({ state: "closed-gate", gates: [gate({ action: "ban-list", file: ".ennyn/config.json" })] }))],
  ["closed-gate by the removal itself", doc(cls({ state: "closed-gate", gates: [gate({ action: "remove-the-place" })] }))],
  ["closed-design", doc(cls({ state: "closed-design", gates: [gate({ action: "remove-the-place" })] }))],
  ["closed by a build file that ends in txt", doc(cls({ state: "closed-gate", gates: [gate({ action: "ban-list", file: "CMakeLists.txt" })] }))],
  ["closed by a pin list that ends in txt", doc(cls({ state: "closed-gate", gates: [gate({ action: "ban-list", file: "requirements.txt" })] }))],
  ["closed by a doctest in rst", doc(cls({ state: "closed-gate", gates: [gate({ file: "docs/api.rst" })] }))],
  ["closed on a file with no extension: the label is a person's word", doc(cls({ state: "closed-gate", gates: [gate({ file: "Makefile" })] }))],
  ["closed, a written rule beside the gate", doc(cls({ state: "closed-gate", gates: [gate({ file: "CLAUDE.md", action: "written-rule" }), gate()] }))],
  ["a sha-256 commit", doc(cls({ gates: [gate({ commit: "b".repeat(64) })] }))],
  ["superseded", doc(cls({ state: "superseded", by: "other" }), other)],
  ["a chain that ends", doc(cls({ state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "other" }), other)],
  ["two entries superseded by one", doc(cls({ state: "superseded", by: "other" }), cls({ id: "two", state: "superseded", by: "other" }), other)],
  ["linked names", doc(cls({ linked: ["new: a thing goes wrong", "new: the same thing again"] }))],
  ["graph nodes", doc(cls({ nodes: ["some-node", "other2"] }))],
  ["a judgement", doc(cls({ judged: "Research of 2026-10-31, about 30% either way." }))],
  ["counts from a tracked ledger", doc(cls({ counts: { source: ".ennyn/findings.jsonl", cycles: { 16: 3, 17: 0 } } }))],
  ["counts from a tracked json file", doc(cls({ counts: { source: "data/counts.json", cycles: { 1: 1 } } }))],
  ["a linked name that folds to its own id: it needs no link, and does no harm", doc(cls({ linked: ["new: One"] }))],
  ["a linked name that folds to an entry superseded by this one: both routes end here", doc(cls({ linked: ["new: other"] }), cls({ id: "other", state: "superseded", by: "one" }))],
  ["the same two routes through a longer chain", doc(cls({ linked: ["new: Other"] }), cls({ id: "other", state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "one" }))],
  ["a superseded entry's name linked on the entry both of them lead to", doc(cls({ state: "superseded", by: "two", linked: ["new: other"] }), cls({ id: "other", state: "superseded", by: "two" }), cls({ id: "two" }))],
  ["closed-design by removing a document: that is a real removal", doc(cls({ state: "closed-design", gates: [gate({ action: "remove-the-place", file: "docs/rules.md" })] }))],
  ["closed-gate by removing a document", doc(cls({ state: "closed-gate", gates: [gate({ action: "remove-the-place", file: "README.MD" })] }))],
  ["a path whose name only starts with dots", doc(cls({ gates: [gate({ file: "..a/.b/c..d" })] }))],
  ["the largest count a file can hold exactly", doc(cls({ counts: { source: "a.jsonl", cycles: { 1: Number.MAX_SAFE_INTEGER } } }))],
  ["empty lists", doc(cls({ gates: [], nodes: [], linked: [] }))],
];

/** Each is refused, and the reasons hold the text given. @type {[string, string, RegExp][]} */
const REJECT = [
  // The file.
  ["not JSON", "{", /does not parse/],
  ["empty", "", /does not parse/],
  ["an array", "[]", /must hold a JSON object/],
  ["null", "null", /must hold a JSON object/],
  ["a number", "3", /must hold a JSON object/],
  ["no list", "{}", /"classes" must be a list/],
  ["a list that is no list", JSON.stringify({ classes: {} }), /"classes" must be a list/],
  ["an unknown key at the top", JSON.stringify({ classes: [], extra: 1 }), /unknown key "extra"/],
  ["a misspelt key at the top", JSON.stringify({ class: [] }), /unknown key "class"/],
  ["a header of another kind", JSON.stringify({ about: 1, classes: [] }), /"about" must be text/],
  // An entry.
  ["an entry that is no object", doc("x"), /classes\[0\] must be an object/],
  ["null for an entry", doc(null), /classes\[0\] must be an object/],
  ["a list for an entry", doc([]), /classes\[0\] must be an object/],
  ["an unknown key", doc(cls({ status: "open" })), /unknown key "status"/],
  ["__proto__ as a key", `{"classes":[{"id":"one","says":"x","state":"open","__proto__":{"state":"closed-gate"}}]}`, /unknown key "__proto__"/],
  ["no id", doc({ says: SAYS, state: "open" }), /classes\[0\]\.id must be/],
  ["an id in capitals", doc(cls({ id: "One" })), /\.id must be/],
  ["an id with a space", doc(cls({ id: "one two" })), /\.id must be/],
  ["an id with a leading dash", doc(cls({ id: "-one" })), /\.id must be/],
  ["an id with two dashes", doc(cls({ id: "a--b" })), /\.id must be/],
  ["an id with a trailing dash", doc(cls({ id: "a-" })), /\.id must be/],
  ["an id with a line break", doc(cls({ id: "one\ntwo" })), /\.id must be/],
  ["an id with a line break at its end", doc(cls({ id: "one\n" })), /\.id must be/],
  ["an id past the limit", doc(cls({ id: "a".repeat(65) })), /\.id must be/],
  ["an id that is a number", doc(cls({ id: 1 })), /\.id must be/],
  ["__proto__ as an id", doc(cls({ id: "__proto__" })), /\.id must be/],
  ["the same id twice", doc(cls(), cls()), /id "one" is there twice/],
  ["no sentence", doc({ id: "one", state: "open" }), /\.says must be/],
  ["an empty sentence", doc(cls({ says: "" })), /\.says must be/],
  ["a blank sentence", doc(cls({ says: "   " })), /\.says must be/],
  ["a sentence of two lines", doc(cls({ says: "one\ntwo" })), /\.says must be/],
  ["a carriage return", doc(cls({ says: "one\rtwo" })), /\.says must be/],
  ["an escape sequence", doc(cls({ says: "\u001b]52;c;x\u0007" })), /\.says must be/],
  ["a direction mark", doc(cls({ says: "a\u202eb" })), /\.says must be/],
  ["a line separator", doc(cls({ says: "a\u2028b" })), /\.says must be/],
  ["a sentence past the limit", doc(cls({ says: "x".repeat(TEXT_MAX + 1) })), /\.says must be/],
  ["a sentence of another kind", doc(cls({ says: 1 })), /\.says must be/],
  ["no state", doc({ id: "one", says: SAYS }), /\.state must be one of/],
  ["an unknown state", doc(cls({ state: "closed" })), /\.state must be one of .*got "closed"/],
  ["a state in capitals", doc(cls({ state: "Open" })), /\.state must be one of/],
  ["a state of another kind", doc(cls({ state: 1 })), /\.state must be one of/],
  // A gate.
  ["gates that are no list", doc(cls({ gates: {} })), /\.gates must be a list/],
  ["a gate that is no object", doc(cls({ gates: ["x"] })), /\.gates\[0\] must be an object/],
  ["an unknown gate key", doc(cls({ gates: [gate({ note: "x" })] })), /\.gates\[0\]: unknown key "note"/],
  ["an abbreviated commit", doc(cls({ gates: [gate({ commit: "abcdef1" })] })), /\.commit must be a full commit hash/],
  ["a commit in capitals", doc(cls({ gates: [gate({ commit: "A".repeat(40) })] })), /\.commit must be a full commit hash/],
  ["a commit that is no hash", doc(cls({ gates: [gate({ commit: "HEAD" })] })), /\.commit must be a full commit hash/],
  ["an option for a commit", doc(cls({ gates: [gate({ commit: "--output=x" })] })), /\.commit must be a full commit hash/],
  ["a hash of a length no hash has", doc(cls({ gates: [gate({ commit: "a".repeat(41) })] })), /\.commit must be a full commit hash/],
  ["a commit with a line break", doc(cls({ gates: [gate({ commit: `${COMMIT}\n` })] })), /\.commit must be a full commit hash/],
  ["no commit", doc(cls({ gates: [{ file: "x", action: "advice", proof: "x" }] })), /\.commit must be a full commit hash/],
  ["no file", doc(cls({ gates: [{ commit: COMMIT, action: "advice", proof: "x" }] })), /\.file must be/],
  ["an empty file", doc(cls({ gates: [gate({ file: "" })] })), /\.file must be/],
  ["a file of two lines", doc(cls({ gates: [gate({ file: "a\nb" })] })), /\.file must be/],
  ...["/etc/passwd", "/", "C:/Windows/x", "C:\\Windows\\x", "\\\\host\\x", "~/x", "../x", "a/../../x", "a/..", "./a", "a/./b", ".", "..", "a//b", "a/", "..\\x"].map((file) => /** @type {[string, string, RegExp]} */ ([`a file that is no path from the top: ${file}`, doc(cls({ gates: [gate({ file })] })), /\.file must be a path from the repository's top/])),
  ["the registry as a gate of an open entry", doc(cls({ gates: [gate({ file: ".ennyn/classes.json" })] })), /\.file must not be the registry/],
  ["the registry as its own gate", doc(cls({ state: "closed-gate", gates: [gate({ file: ".ennyn/classes.json" })] })), /\.file must not be the registry/],
  ["the registry as what a partial entry leans on", doc(cls({ state: "partial", gates: [gate({ file: ".ennyn/classes.json" })] })), /\.file must not be the registry/],
  ["an unknown action", doc(cls({ gates: [gate({ action: "strong" })] })), /\.action must be one of/],
  ["no action", doc(cls({ gates: [{ commit: COMMIT, file: "x", proof: "x" }] })), /\.action must be one of/],
  ["no proof", doc(cls({ gates: [{ commit: COMMIT, file: "x", action: "advice" }] })), /\.proof must be/],
  ["an empty proof", doc(cls({ gates: [gate({ proof: "" })] })), /\.proof must be/],
  ["a proof of two lines", doc(cls({ gates: [gate({ proof: "a\nb" })] })), /\.proof must be/],
  // What closed takes.
  ["closed-gate with no gate", doc(cls({ state: "closed-gate" })), /cannot be closed/],
  ["closed-design with no gate", doc(cls({ state: "closed-design" })), /cannot be closed/],
  ["closed with an empty list", doc(cls({ state: "closed-gate", gates: [] })), /cannot be closed/],
  ["closed by a written rule alone", doc(cls({ state: "closed-gate", gates: [gate({ action: "written-rule", file: "CLAUDE.md" })] })), /cannot be closed/],
  ["closed by a written rule in code's clothes", doc(cls({ state: "closed-design", gates: [gate({ action: "written-rule" })] })), /cannot be closed/],
  ["closed by advice", doc(cls({ state: "closed-gate", gates: [gate({ action: "advice" })] })), /cannot be closed/],
  ["closed by a red-green proof", doc(cls({ state: "closed-gate", gates: [gate({ action: "red-green" })] })), /cannot be closed/],
  ["closed by a document that says it is a ban", doc(cls({ state: "closed-gate", gates: [gate({ action: "ban-list", file: "CLAUDE.md" })] })), /cannot be closed/],
  ["closed by a skill", doc(cls({ state: "closed-gate", gates: [gate({ file: "skills/cycle/SKILL.md" })] })), /cannot be closed/],
  ["closed by a document in capitals", doc(cls({ state: "closed-gate", gates: [gate({ file: "README.MD" })] })), /cannot be closed/],
  ["closed by an mdx document", doc(cls({ state: "closed-gate", gates: [gate({ file: "rules.mdx" })] })), /cannot be closed/],
  ["closed by a markdown document", doc(cls({ state: "closed-gate", gates: [gate({ file: "rules.markdown" })] })), /cannot be closed/],
  ["closed-design on a corpus: nothing was removed", doc(cls({ state: "closed-design", gates: [gate({ action: "past-defects" })] })), /cannot be closed/],
  ["closed-design on a ban: nothing was removed", doc(cls({ state: "closed-design", gates: [gate({ action: "ban-list" })] })), /cannot be closed/],
  // What the other states take.
  ["partial with no gate", doc(cls({ state: "partial" })), /state partial needs a gate/],
  ["partial with an empty list", doc(cls({ state: "partial", gates: [] })), /state partial needs a gate/],
  ["partial on a written rule alone", doc(cls({ state: "partial", gates: [gate({ action: "written-rule", file: "CLAUDE.md" })] })), /state partial needs a gate/],
  ["sensor-only naming no sensor", doc(cls({ state: "sensor-only" })), /state sensor-only needs a gate/],
  ["sensor-only on a written rule alone", doc(cls({ state: "sensor-only", gates: [gate({ action: "written-rule" })] })), /state sensor-only needs a gate/],
  ["gates set to null", doc(cls({ gates: null })), /\.gates must be a list/],
  ["nodes set to null", doc(cls({ nodes: null })), /\.nodes must be a list/],
  ["linked set to null", doc(cls({ linked: null })), /\.linked must be a list/],
  ["closed with gates set to null", doc(cls({ state: "closed-gate", gates: null })), /\.gates must be a list/],
  ["counts set to null", doc(cls({ counts: null })), /\.counts must be an object/],
  ["a judgement set to null", doc(cls({ judged: null })), /\.judged must be/],
  ["a pointer set to null", doc(cls({ by: null })), /\.by belongs only to a superseded entry/],
  ["a hash past 64", doc(cls({ gates: [gate({ commit: "a".repeat(65) })] })), /\.commit must be a full commit hash/],
  ["a hash in a list", doc(cls({ gates: [gate({ commit: [COMMIT] })] })), /\.commit must be a full commit hash/],
  ["a count past what a number holds exactly", doc(cls({ counts: { source: "a.jsonl", cycles: { 1: Number.MAX_SAFE_INTEGER + 1 } } })), /must be a whole number/],
  ["a control byte in a node", doc(cls({ nodes: ["a\u0007b"] })), /\.nodes must be a list/],
  ["half a character in a sentence, written as an escape", doc(cls({ says: "a\ud800" })), /\.says must be one plain line/],
  ["half a character in a linked name", doc(cls({ linked: ["new: a\udc00"] })), /\.linked\[0\]/],
  // Superseded.
  ["superseded by nothing", doc(cls({ state: "superseded" })), /\.by must name the entry/],
  ["a pointer on a live entry", doc(cls({ by: "other" }), other), /\.by belongs only to a superseded entry/],
  ["a pointer to no entry", doc(cls({ state: "superseded", by: "nobody" })), /\.by: no entry "nobody"/],
  ["a pointer of another kind", doc(cls({ state: "superseded", by: 1 })), /\.by must name the entry/],
  ["a pointer to itself", doc(cls({ state: "superseded", by: "one" })), /superseded entries lead in a circle/],
  ["two that point at each other", doc(cls({ state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "one" })), /superseded entries lead in a circle/],
  ["a longer circle", doc(cls({ state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "three" }), cls({ id: "three", state: "superseded", by: "one" })), /superseded entries lead in a circle/],
  ["a chain into a circle", doc(cls({ id: "in", state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "three" }), cls({ id: "three", state: "superseded", by: "two" })), /superseded entries lead in a circle/],
  // Lists.
  ["nodes that are no list", doc(cls({ nodes: "x" })), /\.nodes must be a list/],
  ["a node of another shape", doc(cls({ nodes: ["a b"] })), /\.nodes must be a list/],
  ["linked that is no list", doc(cls({ linked: "new: x" })), /\.linked must be a list/],
  ["a linked value that is no new: name", doc(cls({ linked: ["one"] })), /\.linked\[0\]/],
  ["a linked name with a line break", doc(cls({ linked: ["new: a\nb"] })), /\.linked\[0\]/],
  ["a name linked twice", doc(cls({ linked: ["new: x"] }), cls({ id: "two", linked: ["new: x"] })), /"new: x" is linked twice/],
  ["a name linked twice in one entry", doc(cls({ linked: ["new: x", "new: x"] })), /"new: x" is linked twice/],
  ["a linked name that is another entry's id", doc(cls({ linked: ["new: other"] }), other), /\.linked\[0\].*another entry's id/],
  ["a linked name that folds to another entry's id", doc(cls({ linked: ["new: Other"] }), other), /\.linked\[0\].*another entry's id/],
  ["a linked name that folds to an entry superseded by a third: two classes", doc(cls({ linked: ["new: other"] }), cls({ id: "other", state: "superseded", by: "two" }), cls({ id: "two" })), /\.linked\[0\].*another entry's id/],
  // Counts.
  ["counts that are no object", doc(cls({ counts: [] })), /\.counts must be an object/],
  ["an unknown count key", doc(cls({ counts: { source: "a.jsonl", cycles: {}, by: 1 } })), /\.counts: unknown key "by"/],
  ["counts with no source", doc(cls({ counts: { cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from a document", doc(cls({ counts: { source: ".ennyn/handoff.md", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from a code file", doc(cls({ counts: { source: "metrics/x.mjs", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from a file with no extension", doc(cls({ counts: { source: "NOTES", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from the registry itself", doc(cls({ counts: { source: ".ennyn/classes.json", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from a name that only holds .json", doc(cls({ counts: { source: "a.json.bak", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts from a name of two lines", doc(cls({ counts: { source: "a\nb.jsonl", cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["a source that is a list", doc(cls({ counts: { source: ["a.jsonl"], cycles: { 1: 1 } } })), /\.counts\.source must be/],
  ["counts with no cycles", doc(cls({ counts: { source: "a.jsonl" } })), /\.counts\.cycles must be an object/],
  ["a cycle that is no number", doc(cls({ counts: { source: "a.jsonl", cycles: { x: 1 } } })), /\.counts\.cycles: "x" is no cycle/],
  ["a cycle zero", doc(cls({ counts: { source: "a.jsonl", cycles: { 0: 1 } } })), /\.counts\.cycles: "0" is no cycle/],
  ["a cycle with a leading zero", doc(cls({ counts: { source: "a.jsonl", cycles: { "01": 1 } } })), /\.counts\.cycles: "01" is no cycle/],
  ["a count below zero", doc(cls({ counts: { source: "a.jsonl", cycles: { 1: -1 } } })), /\.counts\.cycles\["1"\] must be a whole number/],
  ["a count that is an estimate", doc(cls({ counts: { source: "a.jsonl", cycles: { 1: 1.5 } } })), /\.counts\.cycles\["1"\] must be a whole number/],
  ["a count of another kind", doc(cls({ counts: { source: "a.jsonl", cycles: { 1: "~30" } } })), /\.counts\.cycles\["1"\] must be a whole number/],
  ["a judgement of another kind", doc(cls({ judged: 1 })), /\.judged must be/],
  ["a judgement of two lines", doc(cls({ judged: "a\nb" })), /\.judged must be/],
];

test("classes corpus: every accepted text parses with no problem, and its entries are all there", () => {
  for (const [why, text] of ACCEPT) {
    const reg = parseClasses(text);
    assert.deepEqual(reg.problems, [], why);
    assert.equal(reg.entries.length, reg.size, why);
  }
});

test("classes corpus: every refused text is refused, with its reason", () => {
  for (const [why, text, reason] of REJECT) {
    const { problems } = parseClasses(text);
    assert.ok(problems.length > 0, `${why}: refused nothing`);
    assert.ok(problems.some((p) => reason.test(p)), `${why}: ${JSON.stringify(problems)}`);
  }
});

test("classes: the corpus holds both answers for every state and action that decide a closing", () => {
  assert.deepEqual(CLASS_STATES, ["open", "partial", "closed-design", "closed-gate", "sensor-only", "superseded"]);
  // Weakest first, as the table of actions the research ranks; the level is the place in this list.
  assert.deepEqual(ACTIONS, ["written-rule", "advice", "red-green", "past-defects", "real-program", "ban-list", "remove-the-place"]);
  for (const action of ACTIONS) {
    const gates = [gate({ action })];
    assert.equal(parseClasses(doc(cls({ state: "closed-gate", gates }))).problems.length === 0, ACTIONS.indexOf(action) >= 3, `closed-gate by ${action}`);
    assert.equal(parseClasses(doc(cls({ state: "closed-design", gates }))).problems.length === 0, action === "remove-the-place", `closed-design by ${action}`);
    for (const state of ["partial", "sensor-only"]) assert.equal(parseClasses(doc(cls({ state, gates }))).problems.length === 0, action !== "written-rule", `${state} by ${action}`);
  }
});

test("classes: an entry that holds a problem stays out of the index, and the size counts every entry", () => {
  const reg = parseClasses(doc(cls(), cls({ id: "bad id" }), cls({ id: "two", state: "nope" })));
  assert.equal(reg.size, 3);
  assert.deepEqual(reg.entries.map((e) => e.id), ["one"]);
  assert.equal(reg.byId.has("two"), false);
});

test("classes: all the problems of a file are said at once, as the config says them", () => {
  const { problems } = parseClasses(JSON.stringify({ extra: 1, classes: [cls({ id: "A" }), cls({ state: "x" })] }));
  assert.equal(problems.length, 3, problems.join("\n"));
});

test("classes: a value of any kind is said by its kind: no string conversion runs on it, and every problem of the file is said", () => {
  const deep = (/** @type {number} */ n) => "[".repeat(n) + "]".repeat(n);
  const texts = /** @type {[string, RegExp][]} */ ([
    [doc(cls({ state: { toString: 1 } })), /state must be one of .*got an object/],
    [doc(cls({ state: { toString: 1, valueOf: 2 } })), /state must be one of .*got an object/],
    [doc(cls({ state: [{ toString: 1 }] })), /state must be one of .*got a list/],
    [doc(cls({ state: null })), /state must be one of .*got null/],
    [doc(cls({ state: 7 })), /state must be one of .*got 7/],
    [doc({ id: "one", says: SAYS }), /state must be one of .*got nothing/],
    [`{"classes":[{"id":"one","says":"x","state":${deep(200000)}}]}`, /state must be one of .*got a list/],
    [doc(cls({ id: "A" }), cls({ state: { toString: null } })), /classes\[1\]\.state must be one of/],
  ]);
  for (const [text, reason] of texts) {
    const { problems } = parseClasses(text);
    assert.ok(problems.some((p) => reason.test(p)), `${text.slice(0, 60)}: ${problems}`);
  }
  assert.match(String(valueProblem(emptyRegistry(), { toString: 1 })), /must be text, not an object/);
  const o = JSON.parse('{"toString":1}');
  assert.equal(classProblems(emptyRegistry(), [o, o]).length, 3);
});

test("classes: a problem quotes no sentence, and cuts a long value", () => {
  const long = "k".repeat(5000);
  const { problems } = parseClasses(doc(cls({ says: "secret words\nof a hostile sentence", state: long, [long]: 1 })));
  assert.ok(!problems.some((p) => p.includes("secret words")), problems.join("\n"));
  assert.ok(problems.every((p) => p.length < 300), problems.map((p) => p.length).join(" "));
});

test("classes: a long chain is walked once, in whatever order its entries stand", () => {
  const n = 2000;
  const links = Array.from({ length: n }, (_, i) => cls({ id: `c${i}`, state: "superseded", by: i + 1 === n ? "end" : `c${i + 1}` }));
  for (const order of [links, [...links].reverse()]) {
    const real = Map.prototype.get;
    let calls = 0;
    Map.prototype.get = function (/** @type {unknown} */ key) {
      calls++;
      return real.call(this, key);
    };
    let reg;
    try {
      reg = parseClasses(doc(...order, cls({ id: "end" })));
    } finally {
      Map.prototype.get = real;
    }
    assert.deepEqual(reg.problems, []);
    assert.ok(calls <= 3 * n, `${calls} lookups for ${n} entries`);
  }
});

test("classes: an id seen twice is said though the first of them was refused for something else", () => {
  const { problems } = parseClasses(doc(cls({ state: "nope" }), cls()));
  assert.ok(problems.some((p) => /id "one" is there twice/.test(p)), problems.join("\n"));
});

// --------------------------------------------------------------------------------------- the answers --

const REG = parseClasses(
  doc(
    cls({ id: "live", says: "It says this.", linked: ["new: old name"] }),
    cls({ id: "gone", says: "It said that.", state: "superseded", by: "middle", linked: ["new: older name"] }),
    cls({ id: "middle", says: "Between.", state: "superseded", by: "live" }),
  ),
);

test("classes: the index holds what each id says, and no name of Object.prototype is an id", () => {
  assert.deepEqual(REG.problems, []);
  assert.equal(REG.byId.get("live")?.says, "It says this.");
  assert.equal(REG.byId.get("gone")?.says, "It said that.");
  for (const id of ["live", "gone"]) assert.equal(valueProblem(REG, id), null, id);
  for (const id of ["nobody", "constructor", "toString", "__proto__", ""]) assert.match(String(valueProblem(REG, id)), /unknown class/, id);
});

test("classes: a class value is a known id or a new: name, and nothing else", () => {
  for (const value of ["live", "gone", "new: old name", "new: x", "new: a name, with: punctuation (and) more", "new: ölçülemeyen durum", `new: ${"x".repeat(NAME_MAX)}`, "new: live", "new: gone", "new: LIVE", "new: Middle"]) {
    assert.equal(valueProblem(REG, value), null, value);
  }
  for (const [value, reason] of /** @type {[unknown, RegExp][]} */ ([
    ["nobody", /unknown class/],
    ["constructor", /unknown class/],
    ["", /unknown class/],
    ["Live", /unknown class/],
    [" live", /unknown class/],
    ["new:x", /unknown class/],
    ["NEW: x", /unknown class/],
    ["new: ", /new: name/],
    ["new:  x", /new: name/],
    ["new: x ", /new: name/],
    ["new: a\nb", /new: name/],
    ["new: a\u202eb", /new: name/],
    ["new: \u001b[31mx", /new: name/],
    [`new: ${"x".repeat(NAME_MAX + 1)}`, /new: name/],
    [1, /must be text/],
    [null, /must be text/],
    [["live"], /must be text/],
  ])) {
    const said = valueProblem(REG, /** @type {any} */ (value));
    assert.ok(said !== null && reason.test(said), `${JSON.stringify(value)}: ${said}`);
  }
});

const CYRILLIC_A = String.fromCodePoint(0x430);
const FULLWIDTH = (/** @type {string} */ s) => [...s].map((c) => String.fromCodePoint(c.codePointAt(0) - 0x61 + 0xff41)).join("");

test("classes: a new: name resolves to the entry whose id it folds to, with no edit and no refusal", () => {
  const reg = parseClasses(doc(cls({ id: "vacuous-gate" }), cls({ id: "unmeasured-read" }), cls({ id: "old-name", state: "superseded", by: "vacuous-gate" })));
  assert.deepEqual(reg.problems, []);
  assert.equal(foldName("Vacuous Gate"), "vacuous-gate");
  assert.equal(foldName("vacuous_gate"), "vacuous-gate");
  assert.equal(foldName("vacuous __ gate"), "vacuous-gate", "a run of them is one dash");
  assert.equal(foldName(FULLWIDTH("vacuous")), "vacuous", "NFKC");
  assert.equal(foldName("a\u00a0b"), "a-b", "a no-break space is a space once NFKC has read it");
  for (const value of ["new: vacuous-gate", "new: Vacuous-Gate", "new: VACUOUS-GATE", "new: vacuous gate", "new: vacuous_gate", "new: Vacuous Gate", `new: ${FULLWIDTH("vacuous")}-gate`, "new: Old Name", "new: old_name"]) {
    assert.equal(valueProblem(reg, value), null, value);
    assert.deepEqual(classProblems(reg, [value]), [], value);
    assert.equal(currentClass(reg, value), "vacuous-gate", value);
  }
  assert.equal(currentClass(reg, "new: Unmeasured Read"), "unmeasured-read");
});

test("classes: a linked name resolves to the one class both its routes end at", () => {
  const merged = parseClasses(doc(cls({ linked: ["new: other"] }), cls({ id: "other", state: "superseded", by: "one" })));
  assert.deepEqual(merged.problems, []);
  assert.equal(currentClass(merged, "new: other"), "one");
  // The order of the entries changes nothing.
  assert.deepEqual(parseClasses(doc(cls({ id: "other", state: "superseded", by: "one" }), cls({ linked: ["new: other"] }))).problems, []);
  // Two routes that part stay refused, and the entry that holds the name is the one named.
  const parted = parseClasses(doc(cls({ linked: ["new: other"] }), cls({ id: "other", state: "superseded", by: "two" }), cls({ id: "two" })));
  assert.match(parted.problems.join(), /classes\[0\]\.linked\[0\]/);
});

test("classes: a look-alike stays a plain new name: accepted, and resolved to nothing", () => {
  const reg = parseClasses(doc(cls({ id: "vacuous-gate" })));
  for (const value of [`new: v${CYRILLIC_A}cuous-gate`, "new: vacuous\u2011gate", "new: vacuous\u200d-gate", "new: vacuous--gate", "new: vacuous-gates"]) {
    assert.equal(valueProblem(reg, value), null, value);
    assert.equal(currentClass(reg, value), null, value);
  }
  // Only a new: name folds: an id is written as it is.
  for (const value of ["Vacuous-Gate", "vacuous_gate", "vacuous gate"]) assert.match(String(valueProblem(reg, value)), /unknown class/, value);
});

test("classes: a row's validity does not change with what a close later adds", () => {
  const names = ["new: truncation", "new: Truncation", "new: bound left open", "new: truncation of a line"];
  const before = parseClasses(doc());
  // The class joins with the id the name suggests; a linked name goes beside it; a later entry supersedes it.
  const stages = [
    doc(cls({ id: "truncation" })),
    doc(cls({ id: "truncation", linked: ["new: bound left open", "new: truncation of a line"] })),
    doc(cls({ id: "truncation", state: "superseded", by: "cut-short", linked: ["new: bound left open", "new: truncation of a line"] }), cls({ id: "cut-short" })),
  ].map((t) => parseClasses(t));
  for (const name of names) {
    assert.equal(valueProblem(before, name), null, name);
    for (const reg of stages) assert.deepEqual([reg.problems, valueProblem(reg, name)], [[], null], name);
  }
  assert.equal(currentClass(stages[0], "new: truncation"), "truncation");
  assert.equal(currentClass(stages[0], "new: bound left open"), null, "not linked yet");
  assert.equal(currentClass(stages[1], "new: bound left open"), "truncation");
  assert.equal(currentClass(stages[2], "new: bound left open"), "cut-short", "linked, then the chain");
  assert.equal(currentClass(stages[2], "new: Truncation"), "cut-short", "folded, then the chain");
});

test("classes: a finding names a bounded list of classes, and the duplicate check is one pass", () => {
  const reg = emptyRegistry();
  assert.deepEqual(classProblems(reg, Array.from({ length: CLASS_LIST_MAX }, (_, i) => `new: ${i}`)), []);
  const over = classProblems(reg, Array.from({ length: CLASS_LIST_MAX + 1 }, (_, i) => `new: ${i}`));
  assert.equal(over.length, 1);
  assert.match(over[0], /at most/);
  const huge = classProblems(reg, Array.from({ length: 200_000 }, () => "new: x"));
  assert.equal(huge.length, 1, "refused by its length before any value is read");
  const real = Array.prototype.indexOf;
  let calls = 0;
  Array.prototype.indexOf = function (/** @type {any} */ ...args) {
    calls++;
    return real.apply(this, /** @type {[any]} */ (args));
  };
  try {
    classProblems(reg, Array.from({ length: CLASS_LIST_MAX }, (_, i) => `new: ${i}`));
  } finally {
    Array.prototype.indexOf = real;
  }
  assert.equal(calls, 0);
});

test("classes: a finding may carry several classes, at least one, each once", () => {
  assert.deepEqual(classProblems(REG, ["live"]), []);
  assert.deepEqual(classProblems(REG, ["live", "new: x", "gone"]), []);
  assert.match(classProblems(REG, [])[0], /at least one/);
  assert.match(classProblems(REG, /** @type {any} */ ("live"))[0], /must be a list/);
  assert.match(classProblems(REG, ["live", "live"])[0], /twice/);
  assert.equal(classProblems(REG, ["nobody", "live", "new:x"]).length, 2);
});

test("classes: a value leads to the live class it now counts under", () => {
  assert.equal(currentClass(REG, "live"), "live");
  assert.equal(currentClass(REG, "gone"), "live", "through the chain");
  assert.equal(currentClass(REG, "middle"), "live");
  assert.equal(currentClass(REG, "new: old name"), "live", "a linked name");
  assert.equal(currentClass(REG, "new: older name"), "live", "a linked name, then the chain");
  assert.equal(currentClass(REG, "new: nobody knows"), null, "not linked yet");
  assert.equal(currentClass(REG, "nobody"), null);
  assert.equal(currentClass(REG, /** @type {any} */ (1)), null);
  assert.equal(currentClass(REG, "new: Live"), "live", "a name that folds to an id");
  assert.equal(currentClass(REG, "new: Gone"), "live", "folded, then the chain");
  assert.equal(currentClass(REG, "new:x"), null, "no new: name");
  // A circle in a file doctor refuses still ends here.
  assert.equal(currentClass(parseClasses(doc(cls({ state: "superseded", by: "two" }), cls({ id: "two", state: "superseded", by: "one" }))), "one"), null);
  assert.equal(currentClass(parseClasses(doc(cls({ state: "superseded", by: "one" }))), "one"), null);
});

test("classes: with no registry a new: name is valid and no id is known", () => {
  const reg = emptyRegistry();
  assert.equal(valueProblem(reg, "new: x"), null);
  assert.match(String(valueProblem(reg, "one")), /unknown class/);
  assert.equal(reg.byId.has("one"), false);
  assert.deepEqual(stateCounts(reg), []);
});

test("classes: the counts by state keep the order of the states and leave out none that is there", () => {
  const reg = parseClasses(doc(cls({ id: "a", state: "partial", gates: [gate()] }), cls({ id: "b" }), cls({ id: "c", state: "partial", gates: [gate()] }), cls({ id: "d", state: "superseded", by: "b" })));
  assert.deepEqual(stateCounts(reg), [["open", 1], ["partial", 2], ["superseded", 1]]);
});

// ------------------------------------------------------------------------------------------ the proof --

/** @param {string} dir @param {string} message @returns {string} */
function commit(dir, message) {
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
  return git(["rev-parse", "HEAD"], { cwd: dir });
}

/** A repository holding one gate file at HEAD, with a second commit that deleted another. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "x.test.mjs"), "x\n");
  writeFileSync(join(dir, "test", "gone.test.mjs"), "x\n");
  const first = commit(dir, "feat: one");
  rmSync(join(dir, "test", "gone.test.mjs"));
  symlinkSync("x.test.mjs", join(dir, "test", "link.test.mjs"));
  const second = commit(dir, "feat: two");
  return { dir, first, second };
}

/** @param {string} dir @param {unknown[]} gates @param {Record<string, unknown>} [over] */
const proofs = (dir, gates, over = {}) => {
  const reg = parseClasses(doc(cls({ gates, ...over }), other));
  // An entry the file refuses is not checked: a test that met one would pass on nothing.
  assert.deepEqual(reg.problems, []);
  return checkProofs(reg, { cwd: dir });
};

test("classes proof: a commit in HEAD's history and a file tracked at HEAD hold", () => {
  const { dir, first, second } = repository();
  assert.deepEqual(proofs(dir, [gate({ commit: first }), gate({ commit: second })]), { problems: [], unmeasured: null });
});

test("classes proof: a commit that is not there, or lies off HEAD's history, is refused", () => {
  const { dir, second } = repository();
  git(["checkout", "-q", "-b", "side"], { cwd: dir });
  const side = commit(dir, "feat: side");
  git(["checkout", "-q", "main"], { cwd: dir });
  git(["cat-file", "-e", `${side}^{commit}`], { cwd: dir });
  const offHistory = proofs(dir, [gate({ commit: side })]);
  assert.equal(offHistory.unmeasured, null);
  assert.match(offHistory.problems[0], /is not in HEAD's history/);
  assert.match(proofs(dir, [gate({ commit: "0".repeat(40) })]).problems[0], /is not in HEAD's history/);
  // A blob's or a tree's hash is no commit.
  const blob = git(["rev-parse", "HEAD:test/x.test.mjs"], { cwd: dir });
  assert.match(proofs(dir, [gate({ commit: blob })]).problems[0], /is not in HEAD's history/);
  assert.deepEqual(proofs(dir, [gate({ commit: second })]).problems, []);
});

test("classes proof: the history is the one the objects hold, whatever a replace ref shows", () => {
  const { dir, first, second } = repository();
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: dir });
  const orphan = git(["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", "chore: no parent"], { cwd: dir });
  git(["replace", second, orphan], { cwd: dir });
  assert.deepEqual(proofs(dir, [gate({ commit: first })]), { problems: [], unmeasured: null });
  // A removal is read the same way: the commit as it is keeps the parent that held the file.
  assert.deepEqual(proofs(dir, [gate({ commit: second, file: "test/gone.test.mjs", action: "remove-the-place" })], { state: "closed-design" }), { problems: [], unmeasured: null });
});

test("classes proof: a closed state's file not tracked at HEAD, as a regular file, is refused", () => {
  const { dir, second } = repository();
  writeFileSync(join(dir, "test", "new.test.mjs"), "x\n");
  git(["add", "test/new.test.mjs"], { cwd: dir });
  for (const file of ["test/none.mjs", "test/gone.test.mjs", "test/new.test.mjs", "test", "TEST/X.TEST.MJS", "test/link.test.mjs"]) {
    const res = proofs(dir, [gate({ commit: second, file })], { state: "closed-gate" });
    assert.equal(res.problems.length, 1, file);
    assert.match(res.problems[0], /is not a file tracked at HEAD/, file);
    assert.equal(res.unmeasured, null);
  }
});

test("classes proof: a state that claims no gate keeps its history: its rows' files are not read", () => {
  const { dir, first } = repository();
  const retired = [gate({ commit: first, file: "test/gone.test.mjs" })];
  assert.deepEqual(proofs(dir, retired, { state: "open" }), { problems: [], unmeasured: null });
  assert.deepEqual(proofs(dir, retired, { state: "superseded", by: "other" }), { problems: [], unmeasured: null });
  // The commit is held on every state: history is what the row keeps.
  assert.match(proofs(dir, [gate({ commit: "0".repeat(40), file: "test/gone.test.mjs" })], { state: "open" }).problems[0], /is not in HEAD's history/);
});

test("classes proof: a state that claims a gate needs one standing, and a gate whose file is gone is none", () => {
  const { dir, first, second } = repository();
  const gone = gate({ commit: first, file: "test/gone.test.mjs" });
  const never = gate({ commit: second, file: "no/such/file.js" });
  const standing = gate({ commit: second });
  for (const state of ["partial", "sensor-only", "closed-gate"]) {
    for (const row of [gone, never]) {
      const res = proofs(dir, [row], { state });
      assert.equal(res.unmeasured, null);
      assert.equal(res.problems.length, 1, state);
      assert.match(res.problems[0], /is not a file tracked at HEAD.*no standing gate/, state);
    }
    // Each row that could stand is named; the one that stands makes the others history.
    assert.equal(proofs(dir, [gone, never], { state }).problems.length, 2, state);
    assert.deepEqual(proofs(dir, [gone, standing, never], { state }), { problems: [], unmeasured: null }, state);
  }
});

test("classes proof: a row stands only at the rung its state asks", () => {
  const { dir, second } = repository();
  const rule = gate({ commit: second, action: "written-rule" });
  const advice = gate({ commit: second, action: "advice" });
  const gone = gate({ commit: second, file: "test/gone.test.mjs" });
  // A written rule is no gate on any state, tracked or not.
  for (const state of ["partial", "sensor-only", "closed-gate"]) assert.match(proofs(dir, [rule, gone], { state }).problems[0], /no standing gate/, state);
  // Above a written rule is enough for the two states that do not close.
  assert.deepEqual(proofs(dir, [advice, gone], { state: "partial" }).problems, []);
  assert.deepEqual(proofs(dir, [advice, gone], { state: "sensor-only" }).problems, []);
  // A closed state stands at the closing rung: advice on a tracked file does not hold it up.
  assert.match(proofs(dir, [advice, gone], { state: "closed-gate" }).problems[0], /no standing gate/);
  assert.equal(proofs(dir, [advice, gone], { state: "closed-gate" }).problems.length, 1, "only the row that could stand is named");
  // A document stands for what does not close: partial on a rule the tests read is the person's word.
  writeFileSync(join(dir, "rule.md"), "x\n");
  const added = commit(dir, "chore: a document");
  const document = gate({ commit: added, file: "rule.md", action: "advice" });
  assert.deepEqual(proofs(dir, [document], { state: "partial" }).problems, []);
  assert.match(proofs(dir, [gate({ commit: added, file: "rule.md" }), gone], { state: "closed-gate" }).problems[0], /test\/gone\.test\.mjs/, "a document cannot close, so only the other row is named");
});

test("classes proof: a retired row of any action is history beside a gate that stands, on a closed state too", () => {
  const { dir, first, second } = repository();
  for (const action of ["written-rule", "advice", "red-green", "past-defects", "ban-list"]) {
    assert.deepEqual(proofs(dir, [gate({ commit: first, file: "test/gone.test.mjs", action }), gate({ commit: second })], { state: "closed-gate" }), { problems: [], unmeasured: null }, action);
  }
  // A row that is history still holds its commit.
  assert.match(proofs(dir, [gate({ commit: "0".repeat(40), file: "test/gone.test.mjs", action: "advice" }), gate({ commit: second })], { state: "closed-gate" }).problems[0], /is not in HEAD's history/);
});

test("classes proof: a removal names a file that existed at its commit or that commit's parent", () => {
  const { dir, first, second } = repository();
  const row = (/** @type {string} */ c, /** @type {string} */ file) => [gate({ commit: c, file, action: "remove-the-place" })];
  for (const state of ["closed-design", "closed-gate", "partial", "sensor-only"]) {
    // Gone at the commit, there at its parent: the removal itself.
    assert.deepEqual(proofs(dir, row(second, "test/gone.test.mjs"), { state }), { problems: [], unmeasured: null }, state);
    // There at the commit: a reading cut, and at a first commit, which has no parent.
    assert.deepEqual(proofs(dir, row(second, "test/x.test.mjs"), { state }), { problems: [], unmeasured: null }, state);
    assert.deepEqual(proofs(dir, row(first, "test/gone.test.mjs"), { state }), { problems: [], unmeasured: null }, state);
  }
  const third = commit(dir, "chore: nothing");
  for (const state of ["closed-design", "closed-gate", "partial", "sensor-only"]) {
    for (const [c, file] of [[second, "no/such/file.js"], [third, "test/gone.test.mjs"], [first, "test/none.mjs"], [second, "test"]]) {
      const res = proofs(dir, row(c, file), { state });
      assert.equal(res.unmeasured, null, `${state} ${file}`);
      assert.equal(res.problems.length, 1, `${state} ${file}`);
      assert.match(res.problems[0], /is not a file at its commit or that commit's parent.*no standing gate/, `${state} ${file}`);
    }
  }
  // Any name a tree can hold, from any folder of the repository: the name goes to git whole.
  const odd = "test/a b:c ş.mjs";
  writeFileSync(join(dir, odd), "x\n");
  const added = commit(dir, "feat: an odd name");
  assert.deepEqual(checkProofs(parseClasses(doc(cls({ state: "closed-design", gates: row(added, odd) }))), { cwd: join(dir, "test") }), { problems: [], unmeasured: null });
  // A commit no history holds is its own problem, and names no file either.
  const off = proofs(dir, row("0".repeat(40), "test/gone.test.mjs"), { state: "closed-design" });
  assert.match(off.problems[0], /is not in HEAD's history/);
  assert.match(off.problems[1], /no standing gate/);
  assert.equal(off.unmeasured, null);
});

test("classes proof: removing a document is a real removal and closes a class; a document that stands is still no closing", () => {
  const { dir } = repository();
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "rule.md"), "x\n");
  commit(dir, "docs: a rule");
  rmSync(join(dir, "docs", "rule.md"));
  const removed = commit(dir, "refactor: the rule goes");
  const row = gate({ commit: removed, file: "docs/rule.md", action: "remove-the-place" });
  assert.deepEqual(proofs(dir, [row], { state: "closed-design" }), { problems: [], unmeasured: null });
  assert.deepEqual(proofs(dir, [row], { state: "closed-gate" }), { problems: [], unmeasured: null });
  assert.match(parseClasses(doc(cls({ state: "closed-gate", gates: [gate({ file: "docs/rule.md", action: "ban-list" })] }))).problems[0], /cannot be closed/);
});

test("classes proof: a removal beside a row that stands asks git nothing, so a git that cannot answer changes nothing", () => {
  const { dir, second } = repository();
  const row = gate({ commit: second, file: "no/such/file.js", action: "remove-the-place" });
  const res = withGit("cat-file", () => proofs(dir, [row, gate({ commit: second })], { state: "closed-gate" }));
  assert.deepEqual(res, { problems: [], unmeasured: null });
});

test("classes proof: a git that cannot answer of a removal is unmeasured in its own words, and the problems found stand beside it", () => {
  const { dir, second } = repository();
  const row = gate({ commit: second, file: "test/gone.test.mjs", action: "remove-the-place" });
  const res = withGit("cat-file", () => proofs(dir, [row, gate({ commit: "0".repeat(40) })], { state: "closed-design" }));
  assert.match(String(res.unmeasured), /stopped by this test/);
  assert.doesNotMatch(String(res.unmeasured), /\n/);
  assert.equal(res.problems.length, 1, res.problems.join("\n"));
  assert.match(res.problems[0], /is not in HEAD's history/);
  // The question that says which clone this is fails too: no answer, never no file.
  const none = gate({ commit: second, file: "no/such/file.js", action: "remove-the-place" });
  const asked = withGit("--get-regexp", () => proofs(dir, [none], { state: "closed-design" }));
  assert.deepEqual(asked.problems, []);
  assert.match(String(asked.unmeasured), /stopped by this test/);
  // After the first failure no other removal is asked: a git that hangs costs one limit, not one for each row.
  const log = join(dir, ".git", "cat-file-calls");
  const twice = withGit("cat-file", () => checkProofs(parseClasses(doc(cls({ state: "closed-design", gates: [row] }), cls({ id: "two", state: "closed-design", gates: [row] }))), { cwd: dir }), log);
  assert.match(String(twice.unmeasured), /stopped by this test/);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
});

test("classes proof: a clone that may lack the objects leaves a removal unmeasured, never refused, and a file it does hold stands", () => {
  const { dir, first } = repository();
  // Bytes no file at HEAD holds, so a clone with no blobs lacks them.
  writeFileSync(join(dir, "test", "only.mjs"), "held by this file alone\n");
  commit(dir, "feat: only");
  rmSync(join(dir, "test", "only.mjs"));
  const removed = commit(dir, "refactor: only goes");
  git(["config", "uploadpack.allowFilter", "true"], { cwd: dir });
  const clone = (/** @type {string[]} */ ...how) => {
    const to = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
    git(["clone", "-q", ...how, `file://${dir}`, to], { cwd: dir });
    return to;
  };
  const removal = (/** @type {string} */ c, /** @type {string} */ file) => [gate({ commit: c, file, action: "remove-the-place" })];
  // git says `missing` of a blob a partial clone lacks, as of a path that never was: measured on 2.56. Others die at it,
  // and a git that reads no GIT_NO_LAZY_FETCH would fetch it: so the promisor remote leads nowhere.
  for (const filter of ["blob:none", "tree:0"]) {
    const partial = clone(`--filter=${filter}`);
    git(["remote", "set-url", "origin", join(partial, "no-such-remote")], { cwd: partial });
    const res = proofs(partial, removal(removed, "test/only.mjs"), { state: "closed-design" });
    assert.deepEqual(res.problems, [], filter);
    assert.ok(res.unmeasured, filter);
  }
  const shallow = clone("--depth", "1");
  // A commit at the boundary shows no parent, so the removal it made cannot be seen.
  const atEdge = proofs(shallow, removal(removed, "test/only.mjs"), { state: "closed-design" });
  assert.deepEqual(atEdge.problems, []);
  assert.match(String(atEdge.unmeasured), /this clone may not hold/);
  // Past the boundary the commit is already said, once.
  const past = proofs(shallow, removal(first, "test/gone.test.mjs"), { state: "closed-design" });
  assert.deepEqual(past.problems, []);
  assert.match(String(past.unmeasured), /^1 past the boundary of a shallow clone/);
  // An entry that stands by one removal is measured, whatever this clone cannot say of another.
  assert.deepEqual(proofs(shallow, [...removal(removed, "test/only.mjs"), ...removal(removed, "test/x.test.mjs")], { state: "closed-design" }), { problems: [], unmeasured: null });
  // What the clone does hold is an answer.
  assert.deepEqual(proofs(shallow, removal(removed, "test/x.test.mjs"), { state: "closed-design" }), { problems: [], unmeasured: null });
});

test("classes proof: the file is read from the top of the repository, wherever the command stands", () => {
  const { dir, second } = repository();
  const res = checkProofs(parseClasses(doc(cls({ state: "closed-gate", gates: [gate({ commit: second })] }))), { cwd: join(dir, "test") });
  assert.deepEqual(res.problems, []);
});

test("classes proof: a submodule is no file", () => {
  const { dir, second } = repository();
  git(["update-index", "--add", "--cacheinfo", `160000,${second},mod`], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: a submodule"], { cwd: dir });
  assert.match(proofs(dir, [gate({ commit: second, file: "mod" })], { state: "closed-gate" }).problems[0], /is not a file tracked at HEAD/);
});

test("classes proof: a count's source must be tracked at HEAD too", () => {
  const { dir, second } = repository();
  writeFileSync(join(dir, "findings.jsonl"), "{}\n");
  const counts = (/** @type {string} */ source) => ({ counts: { source, cycles: { 1: 1 } } });
  assert.match(proofs(dir, [gate({ commit: second })], counts("findings.jsonl")).problems[0], /\.counts\.source .*is not a file tracked at HEAD/);
  assert.match(proofs(dir, [], counts("none.jsonl")).problems[0], /\.counts\.source .*is not a file tracked at HEAD/);
  git(["add", "findings.jsonl"], { cwd: dir });
  commit(dir, "chore: a ledger");
  assert.deepEqual(proofs(dir, [gate({ commit: second })], counts("findings.jsonl")).problems, []);
  assert.deepEqual(proofs(dir, [], counts("findings.jsonl")).problems, []);
});

/**
 * Runs `fn` with a git on PATH that fails each call naming `word`, in git's own way, and logs the call to `log`.
 * @template T @param {string} word @param {() => T} fn @param {string} [log] @returns {T}
 */
function withGit(word, fn, log = "/dev/null") {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${word} "*) echo x >> "${log}"; echo "fatal: stopped by this test" >&2; echo "second line" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return fn();
  } finally {
    process.env.PATH = path;
  }
}

test("classes proof: nothing to check asks git nothing, and is measured", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  assert.deepEqual(checkProofs(parseClasses(doc(cls())), { cwd: outside }), { problems: [], unmeasured: null });
});

test("classes proof: no repository and no commit are unmeasured, never no problems", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  const none = proofs(outside, [gate()]);
  assert.deepEqual(none.problems, []);
  assert.match(String(none.unmeasured), /no commit/);
  git(["init", "-q", "-b", "main"], { cwd: outside });
  const unborn = proofs(outside, [gate()]);
  assert.deepEqual(unborn.problems, []);
  assert.match(String(unborn.unmeasured), /no commit/);
});

test("classes proof: past a shallow boundary a commit is unmeasured, a file not tracked is still named, and a row that stands holds", () => {
  const { dir, first, second } = repository();
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  git(["clone", "-q", "--depth", "1", `file://${dir}`, clone], { cwd: dir });
  assert.equal(git(["rev-parse", "--is-shallow-repository"], { cwd: clone }), "true");
  const res = proofs(clone, [gate({ commit: first, file: "test/none.mjs" }), gate({ commit: second, file: "test/gone.test.mjs" })], { state: "closed-gate" });
  assert.match(String(res.unmeasured), /shallow/);
  assert.equal(res.problems.length, 2, res.problems.join("\n"));
  assert.match(res.problems[0], /test\/none\.mjs/);
  assert.deepEqual(proofs(clone, [gate({ commit: first }), gate({ commit: second, file: "test/none.mjs" })], { state: "closed-gate" }).problems, []);
  assert.deepEqual(proofs(clone, [gate({ commit: second })]), { problems: [], unmeasured: null });
});

test("classes proof: a history git cannot walk is unmeasured, in git's own words, never no problems", () => {
  const { dir, first, second } = repository();
  // HEAD and its tree stand, so the walk itself fails: the catch, not the no-commit branch.
  const object = join(dir, ".git", "objects", first.slice(0, 2), first.slice(2));
  chmodSync(object, 0o644);
  rmSync(object);
  const res = proofs(dir, [gate({ commit: second })]);
  assert.deepEqual(res.problems, []);
  assert.ok(res.unmeasured && !/no commit/.test(res.unmeasured), String(res.unmeasured));
  assert.doesNotMatch(String(res.unmeasured), /\n/);
  assert.equal(withGit("rev-list", () => proofs(dir, [gate({ commit: second })])).unmeasured, "fatal: stopped by this test");
});

test("classes proof: a HEAD git cannot read is unmeasured too", () => {
  const { dir, second } = repository();
  writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
  const res = proofs(dir, [gate({ commit: second })]);
  assert.deepEqual(res.problems, []);
  assert.ok(res.unmeasured);
});

test("classes proof: entries left out by a problem are not checked, and a value that reaches git is a hash", () => {
  const { dir } = repository();
  const res = checkProofs(parseClasses(doc(cls({ gates: [gate({ commit: "--output=/x" })] }))), { cwd: dir });
  assert.deepEqual(res, { problems: [], unmeasured: null });
});

// ---------------------------------------------------------------------------------- the file on disk --

/** @param {Record<string, unknown>} [config] */
function project(config = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ language: "en", ...config }));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

/** @param {string} cwd @param {...string} args */
function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The doctor line about the registry: exactly one. @param {string} stdout */
function doctorLine(stdout) {
  const lines = stdout.split("\n").filter((l) => /class registry/.test(l));
  assert.equal(lines.length, 1, stdout);
  return lines[0];
}

/** @param {string} dir @param {string} text */
const put = (dir, text) => writeFileSync(join(dir, ".ennyn", "classes.json"), text);
/** @param {string} dir */
const load = (dir) => loadClasses({ cwd: dir, config: loadConfig({ cwd: dir }) });

test("classes file: none there is no registry yet: no failure, on either command", () => {
  const dir = project();
  assert.deepEqual({ there: load(dir).there, problems: load(dir).problems }, { there: false, problems: [] });
  const doctor = run(dir, "doctor");
  assert.match(doctorLine(doctor.stdout), /^✓ no class registry yet \(\.ennyn\/classes\.json\)/);
  assert.equal(doctor.code === 0 || !/✗.*class registry/.test(doctor.stdout), true);
  assert.equal(run(dir, "classes").code, 0);
  assert.match(run(dir, "classes").stdout, /no class registry yet/);
  assert.deepEqual(JSON.parse(run(dir, "classes", "--json").stdout), { path: ".ennyn/classes.json", there: false, total: 0, states: {}, classes: [], problems: [], moreProblems: 0, unmeasured: null });
});

test("classes file: a link, a directory, a pipe or a file past the limit is refused, naming the path, and nothing past a link is read", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  const outside = join(box, "outside.json");
  writeFileSync(outside, doc(cls({ says: "From outside the project." })));
  const dir = project();
  const path = join(dir, ".ennyn", "classes.json");
  const read = (/** @type {string} */ root) => {
    for (const r of [run(root, "doctor"), run(root, "classes")]) {
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes("From outside"), r.stdout);
      assert.match(r.stdout + r.stderr, /could not be read/);
    }
    assert.match(doctorLine(run(root, "doctor").stdout), /^✗ class registry: .*could not be read/);
    assert.throws(() => load(root), /could not be read/);
  };
  symlinkSync(outside, path);
  read(dir);
  rmSync(path);
  mkdirSync(path);
  read(dir);
  rmSync(path, { recursive: true });
  execFileSync("mkfifo", [path]);
  read(dir);
  rmSync(path);
  writeFileSync(path, " ".repeat(CLASSES_LIMIT + 1));
  read(dir);
  writeFileSync(path, " ".repeat(CLASSES_LIMIT - 2) + "{}");
  assert.match(load(dir).problems.join(), /"classes" must be a list/, "at the limit it is read");
  rmSync(path);
  // A directory of the path that is a link.
  const moved = project({ paths: { classes: "in/classes.json" } });
  mkdirSync(join(box, "in"));
  writeFileSync(join(box, "in", "classes.json"), doc(cls({ says: "From outside the project." })));
  symlinkSync(join(box, "in"), join(moved, "in"));
  read(moved);
});

test("classes file: bytes that are not UTF-8 are refused, on every command, and a replacement character is not taken for text", () => {
  const dir = project();
  const path = join(dir, ".ennyn", "classes.json");
  writeFileSync(path, Buffer.concat([Buffer.from('{"classes":[{"id":"one","says":"a'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('b","state":"open"}]}')]));
  const res = load(dir);
  assert.equal(res.there, true);
  assert.deepEqual(res.entries, []);
  assert.match(res.problems[0], /not valid UTF-8/);
  assert.match(doctorLine(run(dir, "doctor").stdout), /^✗ class registry .*not valid UTF-8/);
  assert.equal(run(dir, "classes").code, 1);
});

test("classes file: a count may not come from the registry where the config moved it", () => {
  const dir = project({ paths: { classes: "docs/classes.json" } });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "classes.json"), doc(cls({ counts: { source: "docs/classes.json", cycles: { 1: 1 } } })));
  assert.match(load(dir).problems.join(), /\.counts\.source must be/);
  writeFileSync(join(dir, "docs", "classes.json"), doc(cls({ gates: [gate({ file: "docs/classes.json" })] })));
  assert.match(load(dir).problems.join(), /\.file must not be the registry/);
  // The default path is no registry here, and a gate may name it.
  writeFileSync(join(dir, "docs", "classes.json"), doc(cls({ gates: [gate({ file: ".ennyn/classes.json" })] })));
  assert.deepEqual(load(dir).problems, []);
});

test("classes file: a registry that does not parse is a problem, not a throw", () => {
  const dir = project();
  put(dir, "{");
  const res = load(dir);
  assert.equal(res.there, true);
  assert.match(res.problems[0], /does not parse/);
  assert.equal(res.path, ".ennyn/classes.json");
});

test("readRegular: a limit reads up to it, and past it refuses, naming the path; with none it reads all", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-classes-")));
  const path = join(dir, "f");
  writeFileSync(path, "x".repeat(10));
  assert.equal(readRegular(dir, path, { limit: 10 })?.length, 10);
  assert.equal(readRegular(dir, path)?.length, 10);
  assert.throws(() => readRegular(dir, path, { limit: 9 }), (/** @type {NodeJS.ErrnoException} */ e) => e.code === "EFBIG" && e.message.startsWith(`${path} could not be read: `) && /larger than 9 bytes/.test(e.message));
  assert.equal(readRegular(dir, join(dir, "none"), { limit: 9 }), null);
  writeFileSync(path, "");
  assert.equal(readRegular(dir, path, { limit: 0 })?.length, 0);
});

test("config: paths.classes has a default and may move, and meets the rules of every path a config names", () => {
  assert.equal(loadConfig({ cwd: project() }).paths.classes, ".ennyn/classes.json");
  const moved = project({ paths: { classes: "docs/classes.json" } });
  assert.equal(loadConfig({ cwd: moved }).paths.classes, "docs/classes.json");
  const refused = (/** @type {unknown} */ classes, /** @type {RegExp} */ reason) =>
    assert.throws(() => loadConfig({ cwd: project({ paths: { classes } }) }), (/** @type {unknown} */ e) => e instanceof ConfigError && e.problems.some((p) => reason.test(p)), String(classes));
  refused("../outside.json", /"paths\.classes": .* leads outside the project directory/);
  refused("/etc/passwd", /"paths\.classes": .* leads outside the project directory/);
  refused(".git/classes.json", /"paths\.classes": .* lies in a git dir/);
  refused(".ennyn/metrics.jsonl", /"paths\.metricsLog": .* names the same file as "paths\.classes"/);
  refused("a\0b", /"paths\.classes": .* holds a NUL/);
  refused(1, /"paths\.classes" must be string/);
});

// ----------------------------------------------------------------------------------- the two commands --

test("classes: a registry that holds: one doctor line, every state counted, no failure", () => {
  const dir = project();
  writeFileSync(join(dir, "gate.test.mjs"), "x\n");
  const first = commit(dir, "feat: a gate");
  put(dir, doc(cls({ id: "a", state: "partial", gates: [gate({ commit: first, file: "gate.test.mjs" })] }), cls({ id: "b", state: "closed-gate", gates: [gate({ commit: first, file: "gate.test.mjs" })] }), cls({ id: "c" }), cls({ id: "d", state: "superseded", by: "c" })));
  const doctor = run(dir, "doctor");
  assert.equal(doctorLine(doctor.stdout), "✓ class registry .ennyn/classes.json: total 4 (open 1, partial 1, closed-gate 1, superseded 1), no problems");
  const list = run(dir, "classes");
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^class registry \.ennyn\/classes\.json: total 4 \(open 1, partial 1, closed-gate 1, superseded 1\), no problems$/m);
  assert.match(list.stdout, new RegExp(`^a · partial · ${SAYS}$`, "m"));
  assert.match(list.stdout, /^d · superseded → c · /m);
  const json = JSON.parse(run(dir, "classes", "--json").stdout);
  assert.equal(json.total, 4);
  assert.deepEqual(json.states, { open: 1, partial: 1, "closed-gate": 1, superseded: 1 });
  assert.equal(json.classes[0].id, "a");
  assert.deepEqual(json.problems, []);
  assert.equal(json.unmeasured, null);
});

test("classes: the file may move by its config key", () => {
  const dir = project({ paths: { classes: "docs/classes.json" } });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "classes.json"), doc(cls()));
  assert.match(doctorLine(run(dir, "doctor").stdout), /^✓ class registry docs\/classes\.json: total 1 \(open 1\), no problems$/);
  assert.equal(JSON.parse(run(dir, "classes", "--json").stdout).path, "docs/classes.json");
});

test("classes: problems fail both commands, doctor on one line with the first of them, the list with all", () => {
  const dir = project();
  writeFileSync(join(dir, "x.mjs"), "x\n");
  const first = commit(dir, "feat: x");
  put(dir, doc(cls({ id: "a", state: "closed-gate", gates: [gate({ commit: "0".repeat(40), file: "x.mjs", action: "advice" }), gate({ commit: first, file: "nothing.mjs" })] }), cls({ id: "b", state: "closed-gate" })));
  const doctor = run(dir, "doctor");
  assert.equal(doctor.code, 1);
  const line = doctorLine(doctor.stdout);
  assert.match(line, /^✗ class registry \.ennyn\/classes\.json: total 2 \(closed-gate 1\), problems 3, first: /);
  assert.match(line, /cannot be closed/);
  const list = run(dir, "classes");
  assert.equal(list.code, 1);
  assert.equal(list.stdout.split("\n").filter((l) => l.startsWith("✗ ")).length, 3, list.stdout);
  assert.equal(JSON.parse(run(dir, "classes", "--json").stdout).problems.length, 3);
});

test("classes: a file none of whose entries passed says so where the counts would stand", () => {
  const dir = project();
  put(dir, doc(cls({ state: "nope" })));
  assert.match(doctorLine(run(dir, "doctor").stdout), /^✗ class registry \.ennyn\/classes\.json: total 1 \(—\), problems 1, first: /);
});

test("classes: the list says the first problems and the count of the rest, in text and in JSON", () => {
  const dir = project();
  const n = PROBLEMS_SHOWN + 7;
  put(dir, doc(...Array.from({ length: n }, (_, i) => cls({ id: `c${i}`, state: "nope" }))));
  const list = run(dir, "classes");
  assert.equal(list.code, 1);
  assert.equal(list.stdout.split("\n").filter((l) => l.startsWith("✗ ")).length, PROBLEMS_SHOWN);
  assert.match(list.stdout, /^and 7 more problems$/m);
  const json = JSON.parse(run(dir, "classes", "--json").stdout);
  assert.equal(json.problems.length, PROBLEMS_SHOWN);
  assert.equal(json.moreProblems, 7);
  assert.match(doctorLine(run(dir, "doctor").stdout), new RegExp(`problems ${n}, first: `));
  put(dir, doc(...Array.from({ length: PROBLEMS_SHOWN }, (_, i) => cls({ id: `c${i}`, state: "nope" }))));
  assert.doesNotMatch(run(dir, "classes").stdout, /more problem/);
  assert.equal(JSON.parse(run(dir, "classes", "--json").stdout).moreProblems, 0);
});

test("classes: a git that cannot answer is said on doctor's one line and fails the list", () => {
  const dir = project();
  put(dir, doc(cls({ gates: [gate()] })));
  const doctor = run(dir, "doctor");
  const line = doctorLine(doctor.stdout);
  assert.match(line, /^\? class registry \.ennyn\/classes\.json: total 1 \(open 1\); its commits and files unmeasured: /);
  const list = run(dir, "classes");
  assert.equal(list.code, 1);
  assert.match(list.stdout, /unmeasured/);
  assert.match(JSON.parse(run(dir, "classes", "--json").stdout).unmeasured, /no commit/);
  // Problems of the file stand beside it: failed, and still said.
  put(dir, doc(cls({ gates: [gate()] }), cls({ id: "b", state: "closed-gate" })));
  const both = doctorLine(run(dir, "doctor").stdout);
  assert.match(both, /^✗ .*problems 1, first: .*; its commits and files unmeasured: /);
});

test("classes: a hostile registry stays one plain line on doctor, and drives no terminal on the list", () => {
  const dir = project();
  const evil = "x\u001b]52;c;aGk=\u0007\n✓ all clear\u202e";
  put(dir, JSON.stringify({ classes: [cls({ id: evil, says: evil }), cls({ id: "two", says: evil, state: evil, [evil]: 1, gates: [gate({ file: evil, commit: evil })] })] }));
  const doctor = run(dir, "doctor");
  assert.equal(doctor.code, 1);
  const line = doctorLine(doctor.stdout);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(doctor.stdout), JSON.stringify(doctor.stdout));
  assert.ok(!doctor.stdout.split("\n").some((l) => l.includes("all clear") && l !== line), doctor.stdout);
  for (const args of [["classes"], ["classes", "--json"]]) {
    const r = run(dir, ...args);
    assert.equal(r.code, 1);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(r.stdout + r.stderr), JSON.stringify(r.stdout));
    assert.ok(!(r.stdout + r.stderr).split("\n").some((l) => l.startsWith("✓ all clear")), r.stdout);
  }
});

test("classes: doctor prints no sentence of an entry", () => {
  const dir = project();
  put(dir, doc(cls({ says: "Words that only the list prints." })));
  assert.ok(!run(dir, "doctor").stdout.includes("Words that only"));
  assert.ok(run(dir, "classes").stdout.includes("Words that only"));
});

test("classes: the report reads in the project's language", () => {
  const dir = project({ language: "tr" });
  assert.match(run(dir, "classes").stdout, /henüz sınıf kaydı yok/);
  put(dir, doc(cls()));
  assert.match(run(dir, "classes").stdout, /^sınıf kaydı \.ennyn\/classes\.json: toplam 1 \(open 1\), sorun yok$/m);
});

test("classes: a flag it does not know is refused", () => {
  const dir = project();
  assert.equal(run(dir, "classes", "--nope").code, 2);
});
