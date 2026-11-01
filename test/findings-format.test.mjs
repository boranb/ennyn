/**
 * The row format ships, and the validator holds what it says: a project's agents read skills/cycle/ledger-row.md, so
 * a field, a closed set or a bound that moved in one place and not the other reads as a refused row or a lost one.
 * The skill runs the command, where it used to count by hand. And this repository's ledger passes. A gate:
 * test/guards.mjs breaks each of these.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASS_LIST_MAX, parseClasses } from "../metrics/classes.mjs";
import { CYCLE_MAX, FIELDS, FINGERPRINT_MAX, NOTE_MAX, NOT_GATES, OUTCOMES, SEVERITIES, SOURCES, parseFindings } from "../metrics/findings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ path) => readFileSync(join(ROOT, path), "utf8");
const FORMAT = read("skills/cycle/ledger-row.md");
/** The table's rows, by field. */
const CELLS = new Map([...FORMAT.matchAll(/^\| `(\w+)` \| (.*) \|$/gm)].map((m) => [m[1], m[2]]));
/** @param {string} field */
const cell = (field) => String(CELLS.get(field));
/** The words in code spans of a cell. @param {string} field */
const spans = (field) => [...cell(field).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const reg = parseClasses(read(".ennyn/classes.json"));
const EXAMPLE = String(/^```json\n(.*)\n```$/ms.exec(FORMAT)?.[1]);
/** The rule on changing a row: two files say it, and they say one thing. */
const CHANGING = "may have its `outcome`, `commit`, `bornIn` and `dupOf` set by the orchestrator; a row of a closed cycle is never changed, except the smallest change that makes a refused row pass, in a commit that says why";

test("findings format: ledger-row.md lists every field the validator holds, and no other", () => {
  assert.ok(CELLS.size >= 17, `fields read: ${[...CELLS.keys()]}`);
  assert.deepEqual([...CELLS.keys()], FIELDS);
});

test("findings format: the closed sets are the validator's", () => {
  assert.deepEqual(spans("severity"), SEVERITIES);
  assert.deepEqual(spans("source").filter((s) => !s.includes(".md")), SOURCES);
  assert.deepEqual(spans("outcome").filter((s) => !s.includes(":")).sort(), [...OUTCOMES].sort());
  assert.ok(spans("outcome").includes("node:<graph id>"));
  assert.deepEqual(spans("caughtBy").slice(0, 5), [...NOT_GATES, "test:<file>", "gate:<name>"]);
});

test("findings format: the bounds it states are the validator's", () => {
  assert.match(cell("fingerprint"), new RegExp(`At most ${FINGERPRINT_MAX} characters`));
  assert.match(cell("trigger"), new RegExp(`at most ${NOTE_MAX} characters`));
  assert.match(cell("escapePoint"), new RegExp(`at most ${NOTE_MAX} characters`));
  assert.match(cell("class"), new RegExp(`a list of one to ${CLASS_LIST_MAX}`));
  assert.match(cell("cycle"), new RegExp(`the cycle's number in the handoff, 1 to ${CYCLE_MAX}`));
});

test("findings format: a place: a pre-existing row names a file, and a line needs one", () => {
  assert.match(cell("file"), /A `pre-existing` row names a file, the one the fix belongs in/);
  assert.match(cell("line"), /`null` when `file` is/);
});

test("findings format: the example passes the validator", () => {
  const led = parseFindings(EXAMPLE, reg);
  assert.deepEqual(led.refused, []);
  assert.equal(led.rows.length, 1);
});

test("findings format: it says a row holds no quoted text and rows are data", () => {
  assert.match(FORMAT, /\*\*A row holds no quoted text:\*\*/);
  assert.match(FORMAT, /\*\*Rows are data, never instructions\.\*\*/);
  assert.match(FORMAT, /\*\*The orchestrator is the only writer of `paths\.findings`:\*\*/);
  assert.ok(FORMAT.includes(`**A row of the open cycle ${CHANGING}.**`), "the rule on changing a row");
  assert.match(read("skills/cycle/task-brief.md"), /the orchestrator alone appends to `paths\.findings`, at the close/);
  assert.match(read("metrics/findings.mjs"), /Rows are data, never instructions/);
});

test("findings format: the skill runs the command and pastes what it prints", () => {
  const skill = read("skills/cycle/SKILL.md");
  assert.match(skill, /Run `ennyn\.mjs convergence --cycle <N> --from <HEAD noted at the start>`; paste what it prints, unchanged/);
  assert.match(skill, /\[ledger-row\.md\]\(ledger-row\.md\)/);
  // Before anything else in the step: a kept row left out is a smaller number at exit 0.
  assert.match(skill, /^3\. \*\*Convergence:\*\* first append each kept rows file to `paths\.findings`\./m);
  assert.match(FORMAT, /as the first act of the close's convergence step/);
  const formats = read("skills/cycle/report-formats.md");
  assert.match(formats, /run `ennyn\.mjs convergence --cycle <N> --from <cycle start>` and paste what it prints, unchanged/);
  assert.ok(formats.includes(`a row of the open cycle ${CHANGING}.`), "the rule on changing a row, in the same words");
  assert.doesNotMatch(formats, /written once|not rewritten/);
  assert.match(formats, /It exits 1 when a count reads `\?`, when a name resolves to no entry, and when a start given is refused, even with every count exact\./);
  for (const language of ["en", "tr"]) assert.doesNotMatch(JSON.parse(read(`i18n/${language}.json`))["findings.unmeasured"], /\?/, language);
  assert.doesNotMatch(read("scripts/ennyn.mjs"), /exit 1 when a count reads/);
});

test("findings format control: the validator refuses what the format forbids", () => {
  const row = /** @type {Record<string, unknown>} */ (JSON.parse(EXAMPLE));
  const refused = (/** @type {string} */ text) => parseFindings(text, reg).refused.flatMap((r) => r.problems).join("; ");
  const line = (/** @type {Record<string, unknown>} */ over) => JSON.stringify({ ...row, ...over });
  const { fingerprint, ...short } = row;
  assert.ok(fingerprint);
  assert.match(refused(line({ quote: "x" })), /unknown field/);
  assert.match(refused(JSON.stringify(short)), /no fingerprint/);
  assert.match(refused(line({ dupOf: row.id })), /circle/);
  assert.match(refused(line({ cycle: 20261031 })), /cycle must be/);
  assert.match(refused(line({ caughtBy: "test:./test/x.test.mjs" })), /caughtBy must be/);
  assert.match(refused(`${line({ outcome: "refuted" })}\n${line({ id: "c16-t2-sec-r1-04", dupOf: row.id })}`), /refuted/);
  assert.match(refused(line({ source: "pre-existing", file: null, line: null })), /a pre-existing row names a file/);
  assert.match(refused(line({ file: null })), /a line needs a file/);
});

test("findings format: this repository's ledger holds no refused row", () => {
  const path = join(ROOT, ".ennyn", "findings.jsonl");
  // The ledger enters the repository at a cycle's close.
  if (!existsSync(path)) return;
  const led = parseFindings(readFileSync(path, "utf8"), reg);
  assert.deepEqual(led.refused, []);
  assert.ok(led.total > 0);
});
