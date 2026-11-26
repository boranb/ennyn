/**
 * docs/evidence.md's "Does it work yet?" holds, between its two markers, exactly what test/evidence-history.mjs
 * prints for the cycles the opening marker names, counted from this repository's ledger and history. The marker
 * names a closed range, so a later cycle's rows leave it as it is; what moves it is a closed cycle's row repaired, a
 * class linked or merged in the registry, or a test file a `test:` row names leaving the tree: then the page is
 * rewritten from the script's output. The section's prose outside the block and before its second project's own
 * Source line holds no digit, so every figure of it is one the script prints. The script needs the history
 * (test:linux clones a bundle of HEAD).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../plugin/core/git.mjs";
import { history, pageBlock } from "./evidence-history.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "test", "evidence-history.mjs");
const OPEN = /^<!-- evidence-history (\d+) (\d+) -->$/m;
const CLOSE = "<!-- /evidence-history -->";

/** The block the page holds, and the range its marker names. @param {string} page */
function block(page) {
  const open = OPEN.exec(page);
  assert.ok(open, "docs/evidence.md has no opening marker");
  const from = open.index + open[0].length;
  const to = page.indexOf(CLOSE, from);
  assert.ok(to > from, "docs/evidence.md has no closing marker after the opening one");
  return { first: Number(open[1]), last: Number(open[2]), text: page.slice(from, to).trim() };
}

/** What the script printed, by range: one count per range for the tests and their controls. @type {Map<string, ReturnType<typeof pageBlock>>} */
const printed = new Map();
/** @param {number} first @param {number} last */
const printedFor = (first, last) => {
  const key = `${first} ${last}`;
  if (!printed.has(key)) printed.set(key, pageBlock(ROOT, first, last));
  return /** @type {ReturnType<typeof pageBlock>} */ (printed.get(key));
};

/**
 * Why the page's block is not what the script prints for its range, or null when it is.
 * @param {string} page @returns {Promise<string | null>}
 */
async function differs(page) {
  const held = block(page);
  const { lines, problems } = await printedFor(held.first, held.last);
  if (problems.length) return problems.join("\n");
  if (lines.length <= 3) return "the script printed no table";
  return held.text === lines.join("\n") ? null : `docs/evidence.md differs from node test/evidence-history.mjs ${held.first} ${held.last}`;
}

const SECTION = "## Does it work yet?\n";
const SECOND = "**On the second project**";

/**
 * The lines of the section outside its block and before its second project that hold a digit, its Source line left
 * out: every figure stands in the block, where the script prints it, so no prose figure can drift from the value it
 * names. The second project's figures rest on their own Source line, which test/cited-numbers.test.mjs reads.
 * @param {string} page @returns {string[]}
 */
function proseFigures(page) {
  const at = page.indexOf(SECTION);
  const end = page.indexOf(SECOND, at);
  assert.ok(at >= 0 && end > at, "docs/evidence.md has no Does it work yet? section with its second-project part");
  const open = page.indexOf("<!-- evidence-history", at);
  const close = page.indexOf(CLOSE, open);
  assert.ok(open > at && close > open && close < end, "the block is not inside the section");
  return (page.slice(at, open) + page.slice(close + CLOSE.length, end)).split("\n").filter((l) => !l.startsWith("Source:") && /\d/.test(l));
}

test("evidence history: the section's prose names no figure; every one stands in the printed block", () => {
  const page = readFileSync(join(ROOT, "docs", "evidence.md"), "utf8");
  assert.deepEqual(proseFigures(page), []);
  // Control: a figure written into the prose after the block is found, with its line.
  const close = page.indexOf(CLOSE) + CLOSE.length;
  const changed = `${page.slice(0, close)}\n\nRework fell by 2.2%.\n${page.slice(close)}`;
  assert.deepEqual(proseFigures(changed), ["Rework fell by 2.2%."]);
});

test("evidence history: the page's table is what the script prints for its range", async () => {
  const page = readFileSync(join(ROOT, "docs", "evidence.md"), "utf8");
  assert.equal(await differs(page), null);
  // Control: one count changed in the page's first table row is a difference.
  const row = /^\| \d+-\d+ \| (\d+) \|/m.exec(block(page).text);
  assert.ok(row, "the block holds no table row");
  const changed = page.replace(row[0], row[0].replace(`| ${row[1]} |`, `| ${Number(row[1]) + 1} |`));
  assert.notEqual(changed, page);
  assert.match(String(await differs(changed)), /differs from node test\/evidence-history\.mjs/);
});

test("evidence history: a cycle the ledger cannot place, or arguments it cannot read, fail the run", () => {
  const none = history(ROOT, 1, 1);
  assert.deepEqual(none.lines, []);
  assert.match(none.problems.join("\n"), /^cycle 1: no row names a commit/);
  for (const [args, status] of /** @type {[string[], number][]} */ ([
    [["1", "1"], 1],
    [["57", "16"], 2],
    [["16"], 2],
    [["16", "x"], 2],
    [["16", "57", "58"], 2],
  ])) {
    const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(run.status, status, `${args.join(" ")}: ${run.stderr}`);
    assert.equal(run.stdout, "", args.join(" "));
  }
});

/** The number of classes a run's gate line counts. @param {ReturnType<typeof history>} run */
const gated = (run) => Number(/landed by cycle \d+: (\d+)\./.exec(run.lines.join("\n"))?.[1]);

test("evidence history: what each cycle is counted from, which gates count, and a count it cannot place", () => {
  // Two starts the closings noted (closing handoffs of cycles 47 and 51): the commit before each cycle's first landing.
  for (const [cycle, noted] of /** @type {[number, string][]} */ ([
    [47, "d86f8b5"],
    [51, "58893c0"],
  ])) {
    const run = history(ROOT, cycle, cycle);
    assert.deepEqual(run.problems, []);
    assert.ok(run.starts.get(cycle)?.startsWith(noted), `cycle ${cycle}: ${run.starts.get(cycle)}`);
  }
  // The registry is the one the range's last closing left (cycle 53's closing commit), not HEAD's, so a gate
  // that landed later is not in it (one landed in cycle 54).
  const before = history(ROOT, 50, 53);
  const after = history(ROOT, 50, 57);
  assert.deepEqual([...before.problems, ...after.problems], []);
  assert.ok(before.lines.includes("- Class registry at cycle 53's closing (69299d3): 54 classes, 40 open, 14 partial."), before.lines.join("\n"));
  assert.ok(gated(before) < gated(after), `${gated(before)} classes by cycle 53, ${gated(after)} by cycle 57`);
  // A count convergence cannot place (an old defect with no age) fails the run, never prints.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-evidence-history-")));
  const g = (/** @type {string[]} */ ...args) => git(["-c", "user.name=t", "-c", "user.email=t@x.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), '{ "language": "en" }\n');
  g("add", "-A");
  g("commit", "-q", "-m", "adopt");
  writeFileSync(join(dir, "code.js"), "x\n");
  g("add", "-A");
  g("commit", "-q", "-m", "landing");
  const landing = g("rev-parse", "HEAD");
  const row = { cycle: 3, task: "t", round: 1, id: "c3-t1-r1-01", severity: "low", class: ["new: a made-up class"], source: "pre-existing", caughtBy: "review", dupOf: null, fingerprint: "a made-up defect", outcome: "fixed", commit: landing, bornIn: null, file: "code.js", line: 1 };
  writeFileSync(join(dir, ".ennyn", "findings.jsonl"), `${JSON.stringify(row)}\n`);
  const run = history(dir, 3, 3);
  assert.deepEqual(run.lines, []);
  assert.match(run.problems.join("\n"), /^cycle 3: .*read \?/);
});
