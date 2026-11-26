import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig } from "../plugin/core/config.mjs";
import { git } from "../plugin/core/git.mjs";
import { reworkRate, deletedCodeLines, isCodeLine, parseBound, commitMessages, readLog } from "../plugin/metrics/szz.mjs";
import { parseConvergence, formatConvergence, MAX_ROUNDS } from "../plugin/metrics/convergence.mjs";
import { t } from "../plugin/core/i18n.mjs";
import { READ_LIMIT } from "../plugin/core/files.mjs";

const cfg = (override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-m-")), env: {}, override });
/** One-line fixtures: the strong-link floor is lowered so window, filter and range logic are under test. */
const loose = () => cfg({ metrics: { minLines: 1 } });

/**
 * Temp repository with dated commits.
 * @returns {{ dir: string, commit: (day: number, message: string, files: Record<string, string>) => string }}
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pl-szz-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  return {
    dir,
    commit(day, message, files) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      const date = new Date(Date.UTC(2026, 0, 1 + day, 12, 0, 0)).toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");
      const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      git(["add", "-A"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir, env });
      return git(["rev-parse", "HEAD"], { cwd: dir });
    },
  };
}

/**
 * A submodule that is not checked out, at the commit made of one digit: an empty folder, which git add -A leaves as it is.
 * @param {{ dir: string }} r @param {string} path @param {string} digit
 */
function gitlink(r, path, digit) {
  mkdirSync(join(r.dir, path), { recursive: true });
  git(["update-index", "--add", "--cacheinfo", `160000,${digit.repeat(40)},${path}`], { cwd: r.dir });
}

const ORIGIN = ["// adds two numbers", "export function add(a, b) {", "  return a + b;", "}", ""].join("\n");

test("szz: a fix 3 days later that changes the function's lines reworks the origin", () => {
  const r = repo();
  const origin = r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  const fix = r.commit(3, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const res = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-01", days: 7, config: loose() });
  assert.equal(res.commits, 1);
  assert.equal(res.reworked, 1);
  assert.equal(res.rate, 1);
  assert.deepEqual(res.pairs, [{ origin, fix, files: ["src/a.js"], lines: 1, share: 1, days: 3 }]);
});

test("szz: a fix 8 days later is outside a 7-day window", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  r.commit(8, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.equal(res.commits, 2);
  assert.equal(res.reworked, 0);
  assert.equal(res.rate, 0);
  assert.deepEqual(res.pairs, []);
  // The same history with a wider window counts it: the window, not the diff, decided.
  assert.equal(reworkRate({ cwd: r.dir, days: 8, config: loose() }).reworked, 1);
});

test("szz: a fix that only rewrites a comment line reworks nothing", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  r.commit(3, "fix: comment wording", { "src/a.js": ORIGIN.replace("// adds two numbers", "// adds two numeric values") });
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.equal(res.reworked, 0);
  assert.deepEqual(res.pairs, []);
});

test("szz: a fix touching only a test file reworks nothing", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN, "src/a.test.js": "assert(add(1, 2) === 3);\n" });
  r.commit(3, "fix: test expectation", { "src/a.test.js": "assert(add(2, 2) === 4);\n" });
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.equal(res.commits, 1, "the test-only fix is not a production candidate");
  assert.equal(res.reworked, 0);
});

test("szz: a non-fix subject never reworks; an origin outside [since, until] is not a candidate", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  const swap = r.commit(2, "feat: swap operands", { "src/a.js": ORIGIN.replace("return a + b;", "return b + a;") });
  assert.equal(reworkRate({ cwd: r.dir, days: 7, config: loose() }).reworked, 0);
  r.commit(3, "fix: again", { "src/a.js": ORIGIN.replace("return a + b;", "return a + b + 0;") });
  const all = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.equal(all.reworked, 1);
  assert.equal(all.pairs[0].origin, swap, "blame names the last writer of the line, not the first");
  // Window = day 0 only: the swap (day 2) is outside, so nothing in the window was reworked.
  const res = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-01", days: 7, config: loose() });
  assert.equal(res.commits, 1);
  assert.equal(res.reworked, 0);
});

test("szz: zero candidate commits gives a null rate, not zero", () => {
  const r = repo();
  r.commit(0, "docs: readme", { "README.md": "# x\n" });
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.deepEqual(res, { commits: 0, reworked: 0, rate: null, fixCommits: 0, censored: 0, skewed: 0, submoduleFixes: 0, shallow: false, pairs: [] });
  const empty = mkdtempSync(join(tmpdir(), "pl-szz-empty-"));
  git(["init", "-q"], { cwd: empty });
  assert.equal(reworkRate({ cwd: empty, days: 7, config: cfg() }).rate, null);
});

test("szz: fixCommits counts candidates whose subject is a fix (churn signal)", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  r.commit(1, "fix: one", { "src/a.js": ORIGIN + "export const one = 1;\n" });
  r.commit(2, "fix(scope): two", { "src/a.js": ORIGIN + "export const one = 1;\nexport const two = 2;\n" });
  r.commit(3, "fix: docs only", { "README.md": "x\n" });
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.equal(res.commits, 3);
  assert.equal(res.fixCommits, 2);
  assert.equal(res.reworked, 0, "pure additions name no origin");
});

test("szz: outside a repository it throws instead of reporting zero", () => {
  assert.throws(() => reworkRate({ cwd: mkdtempSync(join(tmpdir(), "pl-norepo-")), days: 7, config: cfg() }), /not a git repository|fatal/i);
});

test("szz: a window the rate cannot use is refused, none given included", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  for (const days of [undefined, -1, Infinity, NaN]) assert.throws(() => reworkRate({ cwd: r.dir, days: /** @type {number} */ (days), config: cfg() }), (e) => e instanceof RangeError && /days must be a non-negative number/.test(e.message), String(days));
  assert.equal(reworkRate({ cwd: r.dir, days: 0, config: cfg() }).commits, 1, "no window at all is a window");
});

test("szz helpers: comment and blank lines are not code; old-side line numbers", () => {
  for (const s of ["", "   ", "// x", "# x", " * x", "/* x */", "*/"]) assert.equal(isCodeLine(s), false, JSON.stringify(s));
  for (const s of ["x = 1", "return a;", "a // trailing comment"]) assert.equal(isCodeLine(s), true, s);
  const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3,3 +3,1 @@", "-a = 1", "-// note", "-b = 2", "+c", "@@ -10 +8,0 @@", "-z()"].join("\n");
  assert.deepEqual(deletedCodeLines(diff), [3, 5, 10]);
  assert.ok(parseBound("2026-01-02", "end") > parseBound("2026-01-02", "start"));
  assert.throws(() => parseBound("2026-02-30", "start"), RangeError);
});

test("convergence: parses English labels with either separator", () => {
  const text = [
    "## Cycle 12",
    "- Findings: real escape 2 · fix-introduced 1, pre-existing 4 · gate-caught 3",
    "- New classes per round: round 1 → 5 · round 2 → 1 · round 3+ → 0",
  ].join("\n");
  assert.deepEqual(parseConvergence(text, cfg()), { foundInReview: 2, fixIntroduced: 1, preExisting: 4, gateCaught: 3, escapedNew: null, escapedOld: null, perRound: [5, 1, 0] });
});

test("convergence: parses Turkish labels in a Turkish project, markdown emphasis ignored", () => {
  const text = [
    "**Bulgular:** gerçek kaçak 1 · düzeltmenin açtığı 0 · eski 2 · kapının yakaladığı 5",
    "Tur başına yeni sınıf: tur 1 → 3 · tur 2 → 2 · tur 3+ → 1",
  ].join("\n");
  assert.deepEqual(parseConvergence(text, cfg({ language: "tr" })), { foundInReview: 1, fixIntroduced: 0, preExisting: 2, gateCaught: 5, escapedNew: null, escapedOld: null, perRound: [3, 2, 1] });
});

test("convergence: no findings line → null; missing per-round line → []; unreported count → null", () => {
  assert.equal(parseConvergence("## Cycle\nnothing measured here", cfg()), null);
  assert.equal(parseConvergence("Bulgular: gerçek kaçak 1", cfg()), null, "an English project does not read Turkish labels");
  const partial = parseConvergence("Findings: real escape 1 · gate-caught ?", cfg());
  assert.deepEqual(partial, { foundInReview: 1, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
});

test("convergence: the first (newest) block wins and its own per-round line is used", () => {
  const text = [
    "Findings: real escape 0 · fix-introduced 0 · pre-existing 0 · gate-caught 1",
    "New classes per round: round 1 → 1",
    "",
    "Findings: real escape 9 · fix-introduced 9 · pre-existing 9 · gate-caught 9",
    "New classes per round: round 1 → 9 · round 2 → 9",
  ].join("\n");
  const c = parseConvergence(text, cfg());
  assert.equal(c?.foundInReview, 0);
  assert.deepEqual(c?.perRound, [1]);
});

test("convergence: format and parse round-trip in both languages", () => {
  const cases = [
    { foundInReview: 2, fixIntroduced: 0, preExisting: 7, gateCaught: 1, escapedNew: null, escapedOld: null, perRound: [4, 1, 0] },
    { foundInReview: 0, fixIntroduced: 3, preExisting: 0, gateCaught: 0, escapedNew: null, escapedOld: null, perRound: [] },
    { foundInReview: 1, fixIntroduced: null, preExisting: 2, gateCaught: 0, escapedNew: null, escapedOld: null, perRound: [2, 0] },
    { foundInReview: 1, fixIntroduced: 1, preExisting: 1, gateCaught: 1, escapedNew: null, escapedOld: null, perRound: [3, 2, 1, 1] },
  ];
  for (const language of ["en", "tr"]) {
    const c = cfg({ language });
    for (const counts of cases) assert.deepEqual(parseConvergence(formatConvergence(counts, c), c), counts, `${language} ${JSON.stringify(counts)}`);
  }
  assert.equal(
    formatConvergence(cases[0], cfg()),
    "Findings: found in review 2 · fix-introduced 0 · pre-existing 7 · gate-caught 1 · escaped past commit new ? · escaped past commit old ?\nNew classes per round: round 1 → 4 · round 2 → 1 · round 3+ → 0",
  );
  assert.match(formatConvergence(cases[0], cfg({ language: "tr" })), /^Bulgular: incelemede bulunan 2 · düzeltmenin açtığı 0 · eski 7 · kapının yakaladığı 1 · commit'ten kaçan yeni \? · commit'ten kaçan eski \?\nTur başına yeni sınıf: tur 1 → 4/);
});

const TOTAL = [
  "export function total(items) {",
  "  let sum = 0;",
  "  for (const it of items) sum += it.price;",
  "  const tax = sum * 0.2;",
  "  const rounded = Math.round(tax);",
  "  return sum + rounded;",
  "}",
  "",
].join("\n");
/** Rewrites the three middle lines: three meaningful deleted lines owned by the origin. */
const TOTAL_FIXED = TOTAL.replace("  const tax = sum * 0.2;\n  const rounded = Math.round(tax);\n  return sum + rounded;", "  const tax = Math.round(sum * 0.2 * 100) / 100;\n  const net = sum;\n  return net + tax;");

test("szz strong link: three owned lines that are at least 10% of the fix count; one line does not", () => {
  const r = repo();
  const origin = r.commit(0, "feat: total", { "src/cart.js": TOTAL });
  r.commit(2, "fix: tax rounding", { "src/cart.js": TOTAL_FIXED });
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.equal(res.reworked, 1);
  assert.equal(res.pairs[0].origin, origin);
  assert.equal(res.pairs[0].lines, 3);
  assert.equal(res.pairs[0].share, 1);

  const one = repo();
  one.commit(0, "feat: total", { "src/cart.js": TOTAL });
  one.commit(2, "fix: tax rate", { "src/cart.js": TOTAL.replace("sum * 0.2", "sum * 0.18") });
  assert.equal(reworkRate({ cwd: one.dir, days: 7, config: cfg() }).reworked, 0, "one line is below minLines");
});

test("szz strong link: a fix message naming the origin's hash counts below the line floor", () => {
  const r = repo();
  const origin = r.commit(0, "feat: total", { "src/cart.js": TOTAL });
  r.commit(2, `fix: tax rate introduced in ${origin.slice(0, 8)}`, { "src/cart.js": TOTAL.replace("sum * 0.2", "sum * 0.18") });
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.equal(res.reworked, 1);
  assert.equal(res.pairs[0].lines, 1);
});

test("szz strong link: an origin owning under minShare of the fix's deleted lines does not count", () => {
  const r = repo();
  const big = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
  const a = r.commit(0, "feat: constants", { "src/k.js": big });
  const b = r.commit(1, "feat: total", { "src/k.js": big + TOTAL });
  r.commit(3, "fix: rewrite module", { "src/k.js": "export const all = [];\n" });
  // b owns 6 of the 46 meaningful deleted lines ("}" is bracket-only): 13% clears the 10% floor, not 15%.
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.deepEqual(res.pairs.map((p) => p.origin).sort(), [a, b].sort());
  const pb = res.pairs.find((p) => p.origin === b);
  assert.equal(pb?.lines, 6);
  assert.equal(pb?.share, 0.13);
  const strict = reworkRate({ cwd: r.dir, days: 7, config: cfg({ metrics: { minShare: 0.15 } }) });
  assert.deepEqual(strict.pairs.map((p) => p.origin), [a]);
});

test("szz strong link: sweep fixes are skipped", () => {
  for (const [n, reworked] of [[16, 0], [15, 1]]) {
    const sweep = repo();
    const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${i}.js`, TOTAL]));
    sweep.commit(0, "feat: modules", files);
    const fixed = Object.fromEntries(Object.keys(files).map((f) => [f, TOTAL_FIXED]));
    sweep.commit(2, "fix: tax rounding everywhere", fixed);
    assert.equal(reworkRate({ cwd: sweep.dir, days: 7, config: cfg() }).reworked, reworked, `${n} production files, a sweep past 15`);
  }
});

test("szz: an origin whose subject says it moved code is skipped; blame follows a cut-and-paste move", () => {
  const ref = repo();
  ref.commit(0, "feat: total", { "src/cart.js": TOTAL });
  const rewrite = ref.commit(1, "refactor: name the tax step", { "src/cart.js": TOTAL_FIXED });
  ref.commit(3, "fix: tax rounding", { "src/cart.js": TOTAL_FIXED.replace("* 100) / 100", "* 1000) / 1000").replace("const net = sum;", "const net = sum - 0;").replace("return net + tax;", "return tax + net;") });
  assert.equal(reworkRate({ cwd: ref.dir, days: 7, config: cfg() }).reworked, 0, "the refactor owns the lines but its subject says it moved code");
  const counted = reworkRate({ cwd: ref.dir, days: 7, config: cfg({ metrics: { moveSubject: "^never$" } }) });
  assert.deepEqual(counted.pairs.map((p) => p.origin), [rewrite]);

  const moved = repo();
  const origin = moved.commit(0, "feat: total", { "src/a.js": TOTAL });
  moved.commit(1, "chore: move total to cart", { "src/a.js": "export {};\n", "src/cart.js": TOTAL });
  moved.commit(3, "fix: tax rounding", { "src/cart.js": TOTAL_FIXED });
  const res = reworkRate({ cwd: moved.dir, days: 7, config: cfg() });
  assert.deepEqual(res.pairs.map((p) => p.origin), [origin], "-M -C names the commit that wrote the lines, not the one that moved them");
});

test("szz: a commit whose window has not closed is censored, not counted as clean", () => {
  const r = repo();
  r.commit(0, "feat: total", { "src/cart.js": TOTAL });
  const day0 = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000);
  const open = reworkRate({ cwd: r.dir, days: 7, config: cfg(), now: day0 + 2 * 86400 });
  assert.equal(open.commits, 0);
  assert.equal(open.censored, 1);
  assert.equal(open.rate, null);
  const closed = reworkRate({ cwd: r.dir, days: 7, config: cfg(), now: day0 + 8 * 86400 });
  assert.equal(closed.commits, 1);
  assert.equal(closed.censored, 0);
});

test("szz: meaningful lines exclude imports, bracket-only lines and comments", () => {
  for (const line of ['import { a } from "./a.js";', "} from \"./x\";", "export { a, b } from './y';", "from os import path", "const fs = require('fs');", "});", "}", "  ];", "// note", "/* x */", " * doc", "# note", "-- sql comment", ""]) {
    assert.equal(isCodeLine(line), false, line);
  }
  for (const line of ["return a + b;", "const x = 1;", "#!/usr/bin/env node", "if (x) {", "x = y;"]) {
    assert.equal(isCodeLine(line), true, line);
  }
});

test("convergence: a round that is not written is null, not 0; trailing punctuation after a count is accepted", () => {
  const c = parseConvergence("Findings: real escape 1 · fix-introduced 2 · pre-existing 3 · gate-caught 4.\nNew classes per round: round 2 → 1", cfg());
  assert.equal(c?.gateCaught, 4);
  assert.deepEqual(c?.perRound, [null, 1]);
});

test("convergence: Turkish upper-case labels match (dotted and dotless i)", () => {
  const text = "BULGULAR: GERÇEK KAÇAK 1 · DÜZELTMENİN AÇTIĞI 2 · ESKİ 3 · KAPININ YAKALADIĞI 4";
  assert.deepEqual(parseConvergence(text, cfg({ language: "tr" })), { foundInReview: 1, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [] });
});

test("convergence: an explicit `?` round stays as null at the end too (round-trip keeps the length)", () => {
  const c = parseConvergence("Findings: real escape 1 · fix-introduced 0 · pre-existing 0 · gate-caught 0\nNew classes per round: round 1 → 2 · round 2 → ?", cfg());
  assert.deepEqual(c?.perRound, [2, null]);
  const again = parseConvergence(formatConvergence({ foundInReview: 1, fixIntroduced: 0, preExisting: 0, gateCaught: 0, escapedNew: null, escapedOld: null, perRound: [1, null] }, cfg()), cfg());
  assert.deepEqual(again?.perRound, [1, null]);
});

/** @param {string} line */
const roundsOf = (line) => parseConvergence(`Findings: real escape 1\nNew classes per round: ${line}`, { language: "en" })?.perRound;
/** @param {string} cell */
const countLine = (cell) => `Findings: real escape ${cell} · fix-introduced 2 · pre-existing 3 · gate-caught 4`;
/** A block nothing could be read from: unreported, which is not "no block" (null). */
const NULLS = { foundInReview: null, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] };

test("convergence audit: a cell is a count only when it is exactly one; anything else is null, in either line", () => {
  const en = { language: "en" };
  const exact = /** @type {[string, number][]} */ ([["3", 3], ["0", 0], ["007", 7], ["3.", 3], ["3;", 3], ["3,", 3], ["3.;", 3], ["**3**", 3], ["`3`", 3], ["_3_", 3], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]]);
  for (const [cell, n] of exact) {
    assert.deepEqual(parseConvergence(countLine(cell), en), { foundInReview: n, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [] }, cell);
    assert.deepEqual(roundsOf(`round 1 → ${cell}`), [n], cell);
  }
  for (const line of ["Findings: real escape: 3", "Findings: real escape : 3", "Findings: real escape=3", "Findings: real escape = 3", "Findings: real  escape\t3"]) assert.equal(parseConvergence(line, en)?.foundInReview, 3, line);
  for (const cell of ["round 1 → 3", "round 1 -> 3", "round 1: 3", "round 1 = 3", "round 1→3", "round  1  →  3"]) assert.deepEqual(roundsOf(cell), [3], cell);
  const unread = ["?", "~3", "≈3", "3+", "-1", "+1", "1.5", "0x10", "1e3", "NaN", "Infinity", "none", "٣", "３", "~~3~~", "~~3~~ 4", "3 (two in T1)", "9007199254740992", "9007199254740993", "9999999999999999", "1".padEnd(401, "0")];
  const separated = ["1.000", "1 000", "1 000", "1 000", "1'000", "1,000", "1·000", "1, 000", "1 · 000", "1_000", "5*2", "1`0", "5**2", "1__000", "5*_2"];
  for (const cell of [...unread, ...separated]) {
    assert.deepEqual(parseConvergence(countLine(cell), en), { foundInReview: null, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [] }, cell);
    assert.deepEqual(roundsOf(`round 1 → ${cell} · round 2 → 6`), [null, 6], cell);
  }
});

test("convergence audit: an estimate is unreported, not the figure and not a lost round: it keeps its place", () => {
  const tr = { language: "tr" };
  const block = (/** @type {string} */ rounds) => parseConvergence(`Bulgular: gerçek kaçak 1\nTur başına yeni sınıf: ${rounds}`, tr)?.perRound;
  assert.deepEqual(block("tur 1 → ~5 · tur 2 → 4 · tur 3+ → ~2 (yalnız T2, tek sinyal)"), [null, 4, null]);
  assert.deepEqual(block("tur 1 → ~5 · tur 2 → ~4 · tur 3+ → ~2"), [null, null, null]);
  assert.deepEqual(block("tur 1 → 7 · tur 2 → 3 · tur 3+ → yok (tur 2'den sonra kapandı)"), [7, 3, null]);
  assert.deepEqual(block("tur 1 → 7 · tur 2 → 3 · tur 3+ → 0"), [7, 3, 0]);
  assert.deepEqual(roundsOf("round 2 → ~1"), [null, null]);
  assert.deepEqual(roundsOf("round 1 → 5 · round 2 ⇒ 3"), [5, null], "a round whose arrow cannot be read is still written");
  assert.deepEqual(roundsOf("round 1 → 5 → 6"), [null]);
  assert.deepEqual(roundsOf("round 1 5"), [null]);
  assert.deepEqual(roundsOf("round 3+5"), [null, null, null], "no arrow, no count");
});

test("convergence audit: what a note in parentheses mentions is no cell of the report", () => {
  const en = { language: "en" };
  assert.deepEqual(roundsOf("round 1 → 5 (later, round 2 → 9, was dropped)"), [null]);
  assert.deepEqual(roundsOf("round 1 → 5 (later · round 2 → 9 · was dropped) · round 2 → 3"), [null, 3]);
  assert.deepEqual(parseConvergence("Findings: real escape 1 (not, gate-caught 9, at all) · pre-existing 2", en), { foundInReview: null, fixIntroduced: null, preExisting: 2, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
  // Nested: the note ends where its depth does.
  assert.deepEqual(parseConvergence("Findings: real escape 1 (a (b) · gate-caught 9 · c) · pre-existing 2", en), { foundInReview: null, fixIntroduced: null, preExisting: 2, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
  assert.deepEqual(roundsOf("round 1 → 5 (later (see), round 2 → 9, dropped)"), [null]);
  assert.deepEqual(roundsOf("round 1 → 5 (a ((b), round 2 → 9), round 3 → 8, c) · round 2 → 3"), [null, 3]);
  // Unclosed: it runs to the end of the line, and what follows reads null.
  assert.deepEqual(parseConvergence("Findings: pre-existing 2 · real escape 1 (see T2 · gate-caught 9", en), { foundInReview: null, fixIntroduced: null, preExisting: 2, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
  assert.deepEqual(roundsOf("round 1 → 5 · round 2 → 3 (see · round 3 → 9"), [5, null]);
  // A closing mark with no opening one opens nothing and closes nothing.
  assert.deepEqual(parseConvergence("Findings: real escape 1) · gate-caught 9 (a) · pre-existing 2 · fix-introduced 3", en), { foundInReview: null, fixIntroduced: 3, preExisting: 2, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
  assert.deepEqual(parseConvergence("Findings: real escape 1)) (a · gate-caught 9) · pre-existing 2", en), { foundInReview: null, fixIntroduced: null, preExisting: 2, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [] });
});

test("convergence audit: text of any kind, or a config with no catalog, ends in null or English, not a throw", () => {
  const en = { language: "en" };
  for (const text of [null, undefined, 12, { a: 1 }, ["Findings: real escape 1"], Buffer.from("Findings: real escape 1")]) assert.equal(parseConvergence(text, en), null);
  assert.equal(parseConvergence("", en), null);
  for (const config of [null, undefined, {}, { language: "de" }, { language: "../../package" }, { language: 1 }]) {
    assert.equal(parseConvergence(countLine("1"), config)?.foundInReview, 1, JSON.stringify(config));
    assert.match(formatConvergence({ foundInReview: 1 }, config), /^Findings: found in review 1 ·/, JSON.stringify(config));
  }
});

test("convergence audit: a count or a round written twice cannot be read, whichever values it holds", () => {
  const en = { language: "en" };
  assert.deepEqual(parseConvergence("Findings: real escape 1 · real escape 2 · gate-caught 4", en), { foundInReview: null, fixIntroduced: null, preExisting: null, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [] });
  assert.equal(parseConvergence("Findings: real escape 2 · real escape 2", en)?.foundInReview, null);
  assert.equal(parseConvergence("Findings: real escape 2 · real escape 2 · real escape 2", en)?.foundInReview, null);
  assert.equal(parseConvergence("Findings: real escape 2 · real escape", en)?.foundInReview, null, "a label with no value is written all the same");
  assert.deepEqual(roundsOf("round 1 → 5 · round 1 → 9 · round 2 → 3"), [null, 3]);
  assert.deepEqual(roundsOf("round 1 → 5 · round 1 → 5"), [null]);
  assert.deepEqual(roundsOf("round 1 → 5 · round 1 → 5 · round 1 → 5"), [null]);
  assert.deepEqual(roundsOf("round 2 → 5 · round 1 → 9"), [9, 5], "order alone is no repeat");
});

test("convergence audit: only the last round from round 3 up can be an aggregate", () => {
  assert.deepEqual(roundsOf("round 1 → 5 · round 2 → 4 · round 3+ → 3"), [5, 4, 3]);
  assert.deepEqual(roundsOf("round 1 → 5 · round 2 → 4 · round 3 → 3 · round 4+ → 2"), [5, 4, 3, 2]);
  assert.deepEqual(roundsOf("round 1 → 5 · round 2+ → 9"), [5, null]);
  assert.deepEqual(roundsOf("round 1+ → 9"), [null]);
  assert.deepEqual(roundsOf("round 3+ → 5 · round 4 → 2"), [null, null, null, 2], "an aggregate cannot be followed by a round it holds");
});

test("convergence audit: a round number is bounded; past MAX_ROUNDS it is not read, and it never sizes the list", () => {
  assert.deepEqual(roundsOf(`round ${MAX_ROUNDS} → 1`), [...Array(MAX_ROUNDS - 1).fill(null), 1]);
  assert.deepEqual(roundsOf(`round 1 → 5 · round ${MAX_ROUNDS + 1} → 1`), [5]);
  for (const n of ["0", String(MAX_ROUNDS + 1), "100000000", "4294967295", "4294967296", "9007199254740993", "1".padEnd(401, "0")]) assert.deepEqual(roundsOf(`round ${n} → 1`), [], n);
});

test("convergence audit: the first line holding the findings label decides, and only a report line gives numbers", () => {
  const en = { language: "en" };
  const real = "Findings: real escape 1 · fix-introduced 2 · pre-existing 3 · gate-caught 4";
  const want = { foundInReview: 1, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [] };
  // Accept: the shapes a report line takes.
  for (const line of [real, `- ${real}`, `* ${real}`, `+ ${real}`, `### ${real}`, `###### ${real}`, `1. ${real}`, `12) ${real}`, `   ${real}`, `  - ${real}`, `\uFEFF${real}`, real.replace("Findings:", "**Findings:**"), real.replace("Findings:", "_Findings:_"), `- ${real.replace("Findings:", "**Findings:**")}`, real.replace("Findings:", "Findings :")]) {
    assert.deepEqual(parseConvergence(line, en), want, line);
  }
  // Decide, and give no number: whatever stands below, the real block too, is not read.
  const decide = [
    "Review findings: real escape 9 · gate-caught 9",
    "We kept the findings: real escape 9",
    "2026-10-31 Findings: real escape 9",
    "Findings: see the table below",
    "Findings: real escapes were few, 9 at most",
    "### Findings: last cycle",
    "Findings:",
    "Findings: 9",
    "Findings: 🔴 0 · 🟠 1",
    "Findings: real escape N · fix-introduced N · pre-existing N · gate-caught N",
    "```md\nFindings: real escape 9 · gate-caught 9\n```",
    "~~~\nFindings: real escape 9\n~~~",
    "  ```\nFindings: real escape N · fix-introduced N\n  ```",
    "  ```\nFindings: real escape 9 · gate-caught 9\n  ```",
    "`Findings: real escape 9 · gate-caught 9` is the format",
    "`Findings: gate-caught 9 · real escape 9`",
    "    Findings: real escape 9",
    "\tFindings: real escape 9",
    "                  Findings: real escape 9",
    "~~Findings: real escape 9 · gate-caught 9~~",
    "> Findings: real escape 9",
    ">Findings: real escape 9",
    "<!-- Findings: real escape 9 · gate-caught 9 -->",
    "[Findings: real escape 9](x)",
    "| Findings: real escape 9 · gate-caught 9",
    "---- Findings: real escape 9",
    "#Findings: real escape 9",
    "####### Findings: real escape 9",
    "\uFEFF\uFEFFFindings: real escape 9",
  ];
  for (const before of decide) {
    assert.deepEqual(parseConvergence(`${before}\n${real}`, en), NULLS, before);
    assert.deepEqual(parseConvergence(`${before}\n\nFindings: real escape 11\nNew classes per round: round 1 → 15`, en), NULLS, before);
  }
  // Not the label: the search goes on.
  for (const before of ["Findings real escape 9", "Findings", "Refindings: real escape 9", "### Doğrulanan bulgular", "Findingsish: real escape 9"]) {
    assert.deepEqual(parseConvergence(`${before}\n${real}`, en), want, before);
  }
  assert.equal(parseConvergence(`Findings:real escape 9\n${real}`, en)?.foundInReview, 9, "the space after the label is optional");
  assert.deepEqual(parseConvergence("Findings: real escapes 9\nFindings: eski 9", en), NULLS, "a word that only starts like a label is no label");
  // A cell starts with its label.
  assert.deepEqual(parseConvergence("Findings: x real escape 3 · gate-caught 4", en), { ...NULLS, gateCaught: 4 });
  assert.deepEqual(roundsOf("x round 1 → 5"), []);
  assert.deepEqual(roundsOf("x round 1 → 5 · round 2 → 3"), [null, 3]);
  assert.deepEqual(parseConvergence("Findings: real escape 1\nNew classes per round round 1 → 5", en)?.perRound, [], "the per-round label needs its colon too");
});

test("convergence audit: an older block never answers for a newest one that cannot be read", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  const FULL_EN = "real escape 1 · fix-introduced 2 · pre-existing 3 · gate-caught 4";
  const FULL_TR = "gerçek kaçak 1 · düzeltmenin açtığı 2 · eski 3 · kapının yakaladığı 4";
  const OLDER_EN = "Findings: real escape 11 · fix-introduced 12 · pre-existing 13 · gate-caught 14\nNew classes per round: round 1 → 15";
  const OLDER_TR = "Bulgular: gerçek kaçak 11 · düzeltmenin açtığı 12 · eski 13 · kapının yakaladığı 14\nTur başına yeni sınıf: tur 1 → 15";
  const newest = /** @type {[string, { language: string }][]} */ ([
    ["Findings: none", en], ["Bulgular: yok", tr], ["Findings: ?", en], ["Findings: 0", en], ["Findings: not measured this cycle", en], ["Findings:", en],
    ["Findings:\n- real escape 1\n- fix-introduced 2", en],
    ["Findings: real-escape 1 · fix introduced 2 · preexisting 3 · gatecaught 4", en], ["Findings: real escapes 1 · gate-caughts 4", en],
    ["Bulgular: gercek kacak 1 · duzeltmenin actigi 2 · kapinin yakaladigi 4", tr],
    ["Findings: 1 real escape, 2 fix-introduced, 3 pre-existing, 4 gate-caught", en],
    [`Cycle 16 Findings: ${FULL_EN}`, en], [`Döngü 16 bulgular: ${FULL_TR}`, tr], [`Convergence, Findings: ${FULL_EN}`, en], [`T4 Findings: ${FULL_EN}`, en],
    [`${" ".repeat(18)}Findings: ${FULL_EN}`, en],
    [`\`\`\`\nFindings: ${FULL_EN}\n\`\`\``, en], [`\`\`\`md\nFindings: ${FULL_EN}\n\`\`\``, en], [`~~~\nFindings: ${FULL_EN}\n~~~`, en], [`\`\`\`md\nBulgular: ${FULL_TR}\n\`\`\``, tr],
    ["Findings: real escape ~3 · gate-caught ~2", en], ["Findings: real escape 3 (two in T1)", en], ["Findings: real escape", en],
  ]);
  for (const [text, config] of newest) {
    const older = config.language === "tr" ? OLDER_TR : OLDER_EN;
    assert.deepEqual(parseConvergence(`## Cycle 16\n\n${text}\n\n## Cycle 15\n\n${older}\n`, config), NULLS, text);
    assert.deepEqual(parseConvergence(`${text}\n\n${older}`, config), NULLS, `${text}, no heading between`);
    assert.deepEqual(parseConvergence(`## Cycle 16\n\n${text}\n`, config), NULLS, `${text}, alone`);
  }
  assert.equal(parseConvergence(`## Cycle 16\n\nFindings: ${FULL_EN}\n\n## Cycle 15\n\n${OLDER_EN}\n`, en)?.foundInReview, 1, "the control");
  assert.equal(parseConvergence("## Cycle\nnothing measured here", en), null, "null is for a text no line of which holds the label");
  // A line that gave nothing is a block of nulls, rounds too: the per-round line below it is no count of this block.
  const rounds = "New classes per round: round 1 → 99";
  for (const line of ["Findings: none", "Findings:", "Findings: real escapes 9", "```\nFindings: real escape 9\n```", "    Findings: real escape 9", "> Findings: real escape 9", "Review findings: real escape 9", "`Findings: real escape 9`"]) {
    assert.deepEqual(parseConvergence(`${line}\n${rounds}`, en), NULLS, line);
  }
  assert.deepEqual(parseConvergence(`Findings: real escape ~3\n${rounds}`, en)?.perRound, [99], "a line that names a count is the block, its value unread or not");
});

test("convergence audit: the per-round line is the block's own: the first after it, before a heading or another block", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  const rounds = (/** @type {string} */ text, config = en) => parseConvergence(text, config)?.perRound;
  assert.deepEqual(rounds("Findings: real escape 1\n\nSome text.\n\nNew classes per round: round 1 → 5"), [5], "text between the lines");
  assert.deepEqual(rounds("### Findings: real escape 1\n### New classes per round: round 1 → 5"), [5], "both as headings");
  assert.deepEqual(rounds("Findings: real escape 1\n#tag\nNew classes per round: round 1 → 5"), [5], "no heading: no space after the mark");
  assert.deepEqual(rounds("Findings: real escape 1\n```\n# a comment\n```\nNew classes per round: round 1 → 5"), [5], "no heading: in a code block");
  // A line above the block, or past it, is not its line: unreported, not wrong.
  assert.deepEqual(rounds("New classes per round: round 1 → 9\nFindings: real escape 0"), [], "a line above the block");
  assert.deepEqual(rounds("## 16\nFindings: real escape 1\n\n## 15\nNew classes per round: round 1 → 9"), [], "past a heading");
  assert.deepEqual(rounds("## 16\nFindings: real escape 1\n\n   ###### 15\nNew classes per round: round 1 → 9"), [], "past an indented heading");
  assert.deepEqual(rounds("## 16\nFindings: real escape 1\n\n#\nNew classes per round: round 1 → 9"), [], "past an empty heading");
  assert.deepEqual(rounds("Findings: real escape 0\n\nFindings: real escape 9\nNew classes per round: round 1 → 9"), [], "past a block");
  assert.deepEqual(rounds("Findings: real escape 1\n\nFindings: none\nNew classes per round: round 1 → 9"), [], "past a label that reads nothing");
  assert.deepEqual(rounds("Findings: real escape 1\n\nCycle 15 Findings: real escape 9\nNew classes per round: round 1 → 9"), [], "past a label with a word before it");
  assert.deepEqual(rounds("Findings: real escape 1\n```\nFindings: real escape 9\n```\nNew classes per round: round 1 → 9"), [], "past a fenced block");
  assert.deepEqual(rounds("Findings: real escape 1\n\nBulgular: gerçek kaçak 9\nNew classes per round: round 1 → 9", tr), [], "past a block in the other language");
  assert.deepEqual(rounds("Bulgular: gerçek kaçak 1\n\nFindings: real escape 7\nTur başına yeni sınıf: tur 1 → 9", tr), [], "past a block in the other language");
  // The first line holding the label decides, as for the findings line.
  assert.deepEqual(rounds("Findings: real escape 1\nNew classes per round: see below\nNew classes per round: round 1 → 5"), [], "a label with no rounds");
  assert.deepEqual(rounds("Findings: real escape 1\nCycle 16 new classes per round: round 1 → 5\nNew classes per round: round 1 → 9"), [], "a word before the label");
  assert.deepEqual(rounds("Findings: real escape 1\n```\nNew classes per round: round 1 → 9\n```\nNew classes per round: round 1 → 5"), [], "a code block");
  assert.deepEqual(rounds("Findings: real escape 1\n~~New classes per round: round 1 → 9~~\nNew classes per round: round 1 → 5"), [], "struck text");
  assert.deepEqual(rounds("Findings: real escape 1\n    New classes per round: round 1 → 9"), [], "indented code");
  assert.deepEqual(rounds("Findings: real escape 1\nNew classes per round: round 1 → 5\nNew classes per round: round 1 → 9"), [5], "the first of two");
});

test("convergence audit: a text past READ_LIMIT is not read: unreported, told from a text with no block", () => {
  const en = { language: "en" };
  const line = "Findings: real escape 1";
  assert.deepEqual(parseConvergence(`${line}${" ".repeat(READ_LIMIT)}`, en), NULLS);
  assert.deepEqual(parseConvergence(" ".repeat(READ_LIMIT + 1), en), NULLS, "whether it holds a block is not known");
  assert.equal(parseConvergence(" ".repeat(READ_LIMIT), en), null, "at the limit it is read");
  assert.equal(parseConvergence(`${" ".repeat(READ_LIMIT - line.length - 1)}\n${line}`, en)?.foundInReview, 1);
});

test("convergence audit: a Turkish project reads the first block in the document, in either language; labels match in any case", () => {
  const tr = { language: "tr" };
  assert.equal(parseConvergence("Findings: real escape 7\n\nBulgular: gerçek kaçak 1", tr)?.foundInReview, 7, "document order: newest on top");
  assert.equal(parseConvergence("Bulgular: gerçek kaçak 1\n\nFindings: real escape 7", tr)?.foundInReview, 1);
  assert.equal(parseConvergence("Bulgular: gerçek kaçak 1 · findings: 2", tr)?.foundInReview, 1, "one line holding both: the project's language reads it");
  assert.deepEqual(parseConvergence("Bulgular: real escape 7", tr), NULLS, "a Turkish label holds Turkish count labels");
  const want = { foundInReview: 1, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: null, escapedOld: null, perRound: [5] };
  const english = "FINDINGS: REAL ESCAPE 1 · FIX-INTRODUCED 2 · PRE-EXISTING 3 · GATE-CAUGHT 4\nNEW CLASSES PER ROUND: ROUND 1 → 5";
  assert.deepEqual(parseConvergence(english, tr), want);
  assert.deepEqual(parseConvergence(english, { language: "en" }), want);
  assert.deepEqual(parseConvergence("BULGULAR: GERÇEK KAÇAK 1 · DÜZELTMENİN AÇTIĞI 2 · ESKİ 3 · KAPININ YAKALADIĞI 4\nTUR BAŞINA YENİ SINIF: TUR 1 → 5", tr), want);
  assert.deepEqual(parseConvergence("Bulgular: Gerçek Kaçak 1 · Düzeltmenin Açtığı 2 · Eski 3 · Kapının Yakaladığı 4\nTur Başına Yeni Sınıf: Tur 1 → 5", tr), want);
  assert.deepEqual(parseConvergence("Bulgular: eskisi 5", tr), NULLS, "a suffix makes another word");
  assert.deepEqual(parseConvergence("Bulgular: eski5", tr), NULLS);
});

test("convergence audit: a repeated call answers the same, in either language", () => {
  const text = "Bulgular: gerçek kaçak 1\nTur başına yeni sınıf: tur 1 → 5";
  const tr = { language: "tr" };
  const first = parseConvergence(text, tr);
  assert.equal(parseConvergence(text, { language: "en" }), null);
  assert.deepEqual(parseConvergence(text, tr), first);
  assert.deepEqual(parseConvergence(text, tr), first);
  assert.equal(formatConvergence(first, tr), formatConvergence(first, tr));
});

test("convergence audit: any line end ends a line", () => {
  const want = { foundInReview: 1, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [5] };
  for (const end of ["\n", "\r\n", "\r"]) assert.deepEqual(parseConvergence(`Findings: real escape 1${end}New classes per round: round 1 → 5${end}`, { language: "en" }), want, JSON.stringify(end));
});

test("convergence audit: for any JSON-shaped value, and a number that is no count, the formatter prints a count or `?`", () => {
  const en = { language: "en" };
  const notCounts = [NaN, Infinity, -Infinity, -1, 1.5, 1e21, 2 ** 53, "3", 3n, undefined, null, true, {}];
  const all = "Findings: found in review ? · fix-introduced ? · pre-existing ? · gate-caught ? · escaped past commit new ? · escaped past commit old ?";
  for (const n of notCounts) {
    const counts = /** @type {any} */ ({ foundInReview: n, fixIntroduced: n, preExisting: n, gateCaught: n, escapedNew: n, escapedOld: n, perRound: [n, n] });
    const printed = formatConvergence(counts, en);
    assert.equal(printed, `${all}\nNew classes per round: round 1 → ? · round 2 → ?`, String(n));
    assert.deepEqual(parseConvergence(printed, en), { foundInReview: null, fixIntroduced: null, preExisting: null, gateCaught: null, escapedNew: null, escapedOld: null, perRound: [null, null] });
  }
  assert.equal(formatConvergence(/** @type {any} */ ({ foundInReview: -0 }), en).split(" · ")[0], "Findings: found in review 0");
  assert.equal(formatConvergence(/** @type {any} */ ({ foundInReview: Number.MAX_SAFE_INTEGER }), en).split(" · ")[0], `Findings: found in review ${Number.MAX_SAFE_INTEGER}`);
  for (const counts of [null, undefined, 3, "x", {}, { perRound: "abc" }, { perRound: { length: 2 } }, { perRound: 3 }, { perRound: null }, { perRound: [] }]) {
    assert.equal(formatConvergence(/** @type {any} */ (counts), en), all, JSON.stringify(counts));
  }
  // eslint-disable-next-line no-sparse-arrays
  const printed = formatConvergence(/** @type {any} */ ({ perRound: [1, , 3] }), en);
  assert.equal(printed, `${all}\nNew classes per round: round 1 → 1 · round 2 → ? · round 3+ → 3`, "a hole is an unmeasured round");
});

test("convergence audit: every shape the formatter prints parses back to what it was given", () => {
  const values = [0, 1, 7, 12345, Number.MAX_SAFE_INTEGER, null];
  for (const language of ["en", "tr"]) {
    const c = { language };
    for (const a of values) {
      for (const b of values) {
        for (const length of [0, 1, 2, 3, 4, 5, 6, MAX_ROUNDS - 1, MAX_ROUNDS]) {
          const counts = { foundInReview: a, fixIntroduced: b, preExisting: b, gateCaught: a, escapedNew: b, escapedOld: a, perRound: Array.from({ length }, (_, i) => values[(i * 5 + (a ?? 3)) % values.length]) };
          assert.deepEqual(parseConvergence(formatConvergence(counts, c), c), counts);
        }
      }
    }
    // Past the ceiling the last round printed says the rest is unmeasured: the parser reads every round it prints.
    const long = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => i);
    const printed = formatConvergence({ foundInReview: 1, fixIntroduced: 1, preExisting: 1, gateCaught: 1, escapedNew: null, escapedOld: null, perRound: long }, c);
    assert.match(printed, / 100\+ → \?$/);
    assert.deepEqual(parseConvergence(printed, c)?.perRound, [...long.slice(0, MAX_ROUNDS - 1), null]);
  }
});

/** A new report: every column, each with its own count. */
const NEW_EN = "Findings: found in review 1 · fix-introduced 2 · pre-existing 3 · gate-caught 4 · escaped past commit new 5 · escaped past commit old 6";
const NEW_TR = "Bulgular: incelemede bulunan 1 · düzeltmenin açtığı 2 · eski 3 · kapının yakaladığı 4 · commit'ten kaçan yeni 5 · commit'ten kaçan eski 6";
const SIX = { foundInReview: 1, fixIntroduced: 2, preExisting: 3, gateCaught: 4, escapedNew: 5, escapedOld: 6, perRound: [] };

test("convergence columns: a new report reads in both languages, in either project", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  assert.deepEqual(parseConvergence(NEW_EN, en), SIX);
  assert.deepEqual(parseConvergence(NEW_TR, tr), SIX);
  assert.deepEqual(parseConvergence(NEW_EN, tr), SIX, "every project reads English labels too");
  assert.deepEqual(parseConvergence(NEW_TR.toLocaleUpperCase("tr"), tr), SIX);
  assert.deepEqual(parseConvergence(NEW_EN.toUpperCase(), en), SIX);
  assert.deepEqual(parseConvergence(`${NEW_EN}\nNew classes per round: round 1 → 7`, en), { ...SIX, perRound: [7] });
  assert.deepEqual(parseConvergence(NEW_EN.replace("escaped past commit new 5", "escaped past commit new: 5").replace("escaped past commit old 6", "escaped past commit old=6"), en), SIX);
  assert.deepEqual(parseConvergence(NEW_EN.replace(" · ", ", "), en), SIX, "either separator");
});

test("convergence columns: an old report's first label maps to the new field, and its fifth column reads unreported, not 0", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  const old = { foundInReview: 46, fixIntroduced: 36, preExisting: 35, gateCaught: 46, escapedNew: null, escapedOld: null, perRound: [39, 26] };
  assert.deepEqual(parseConvergence("Findings: real escape 46 · fix-introduced 36 · pre-existing 35 · gate-caught 46\nNew classes per round: round 1 → 39 · round 2 → 26", en), old);
  assert.deepEqual(parseConvergence("Bulgular: gerçek kaçak 46 · düzeltmenin açtığı 36 · eski 35 · kapının yakaladığı 46\nTur başına yeni sınıf: tur 1 → 39 · tur 2 → 26", tr), old);
  assert.deepEqual(parseConvergence("Findings: real escape 46 · fix-introduced 36 · pre-existing 35 · gate-caught 46\nNew classes per round: round 1 → 39 · round 2 → 26", tr), old, "an English block in a Turkish project");
  assert.equal(parseConvergence("Bulgular: gerçek kaçak 1", en), null, "the old label belongs to its language, as the new one does");
  assert.deepEqual(parseConvergence("Findings: real escape 1 · gate-caught 2", en), { ...NULLS, foundInReview: 1, gateCaught: 2 }, "a line holding only the old label is a block");
});

test("convergence columns: an old and a new spelling of one column on a line are not one reading", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  assert.equal(parseConvergence("Findings: found in review 1 · real escape 2 · gate-caught 4", en)?.foundInReview, null);
  assert.equal(parseConvergence("Findings: real escape 1 · found in review 1", en)?.foundInReview, null, "the same number too");
  assert.equal(parseConvergence("Bulgular: incelemede bulunan 1 · gerçek kaçak 2 · eski 4", tr)?.foundInReview, null);
  assert.equal(parseConvergence("Findings: found in review 1 · real escape 2 · gate-caught 4", en)?.gateCaught, 4, "the other cells stand");
});

test("convergence columns: the fifth column is its two cells; a total, a note, or a split in another shape reads unreported", () => {
  const en = { language: "en" };
  const line = (/** @type {string} */ cell) => parseConvergence(`Findings: found in review 1 · ${cell}`, en);
  for (const cell of [
    "escaped past commit 3",
    "escaped past commit 3 (new 2, old 1)",
    "escaped past commit 3 · new 2 · old 1",
    "escaped past commit new 2, old 1",
    "escaped past commit (new) 2 · escaped past commit (old) 1",
    "escaped past commit 3: 2 new, 1 old",
    "escaped new 2 · escaped old 1",
    "new 2 · old 1",
  ]) {
    const c = line(cell);
    assert.equal(c?.escapedOld, null, cell);
    if (cell !== "escaped past commit new 2, old 1") assert.equal(c?.escapedNew, null, cell);
    assert.equal(c?.foundInReview, 1, cell);
  }
  assert.deepEqual(parseConvergence("Findings: escaped past commit 3", en), NULLS, "a line that names no column is unreported");
  assert.equal(parseConvergence("Findings: escaped past commit new 2 (T1)", en)?.escapedNew, null, "the note rule holds");
  assert.equal(parseConvergence("Findings: escaped past commit new ~2", en)?.escapedNew, null);
  assert.equal(parseConvergence("Findings: escaped past commit new ?", en)?.escapedNew, null);
  assert.deepEqual(parseConvergence("Findings: escaped past commit old 0", en), { ...NULLS, escapedOld: 0 }, "one cell alone: the other stays unreported, a written 0 stays 0");
  assert.equal(parseConvergence("Findings: escaped past commit new 1 · escaped past commit new 2", en)?.escapedNew, null, "written twice");
  assert.equal(parseConvergence("Bulgular: commit’ten kaçan yeni 2", { language: "tr" })?.escapedNew, null, "a curly apostrophe is another spelling: unreported, not guessed");
  const eski = parseConvergence("Bulgular: commit'ten kaçan eski 2 · eski 7", { language: "tr" });
  assert.deepEqual([eski?.escapedOld, eski?.preExisting], [2, 7], "a label that ends in another label's word is its own cell");
});

test("convergence columns: the formatter writes only the new labels, every column, and its block reads back", () => {
  for (const language of ["en", "tr"]) {
    const c = { language };
    const counts = { ...SIX, perRound: [7, 8, 9] };
    const printed = formatConvergence(counts, c);
    assert.doesNotMatch(printed, /real escape|gerçek kaçak/);
    assert.deepEqual(parseConvergence(printed, c), counts);
    assert.deepEqual(parseConvergence(`## Cycle\n\n${printed}\nRecurring class: x — 3\n`, c), counts);
    const old = formatConvergence({ foundInReview: 1, fixIntroduced: 2, preExisting: 3, gateCaught: 4 }, c);
    assert.equal(old.split(" · ").length, 6, "an absent column is printed as unmeasured, not left out");
    assert.equal(parseConvergence(old, c)?.escapedNew, null);
  }
  assert.equal(formatConvergence({ ...SIX, perRound: [] }, { language: "en" }), NEW_EN);
  assert.equal(formatConvergence({ ...SIX, perRound: [] }, { language: "tr" }), NEW_TR);
});

test("convergence columns: a catalog label starts with a letter, and no count label starts another", () => {
  // A separator before a digit is inside a number, so a label that starts with a digit is swallowed by the cell before it.
  assert.equal(parseConvergence("Findings: found in review 1 · 30-day escape 2", { language: "en" })?.foundInReview, null);
  for (const language of ["en", "tr"]) {
    const labels = ["foundInReview", "realEscape", "fixIntroduced", "preExisting", "gateCaught", "escapedNew", "escapedOld"].map((key) => t(`convergence.${key}`, {}, language));
    assert.equal(new Set(labels).size, labels.length, language);
    for (const label of labels) {
      assert.match(label, /^\p{L}/u, label);
      assert.doesNotMatch(label, /[·,()]/, `${label}: a separator or a note mark in a label cuts its cell`);
      for (const other of labels) if (other !== label) assert.ok(!other.startsWith(`${label} `), `${label} starts ${other}: a cell would read as the shorter label with a word for a value`);
    }
  }
});

test("convergence audit: reading takes time linear in the text, by run, by line and by cell, and a run of megabytes does not crash it", () => {
  const en = { language: "en" };
  const tr = { language: "tr" };
  // Growth, not a wall-clock bound (see the secret scan's test): four times the run costs about four times the time
  // if linear, 16 if quadratic, 64 if cubic. These took 5.6 s at 3000 spaces and 15 s at 160,000 dots. CPU time, the
  // best of five runs each.
  const best = (/** @type {string} */ text, config = en) => Math.min(...[0, 1, 2, 3, 4].map(() => {
    const t0 = process.cpuUsage();
    parseConvergence(text, config);
    const { user, system } = process.cpuUsage(t0);
    return (user + system) / 1000;
  }));
  const growth = (/** @type {(size: number) => string} */ make, /** @type {number} */ small, config = en) => (best(make(small * 4), config) + 5) / (best(make(small), config) + 5);
  const hostile = /** @type {[string, (size: number) => string, number, { language: string }?][]} */ ([
    ["spaces in a count cell", (n) => `Findings: real escape${" ".repeat(n)}x y`, 500],
    ["spaces in a count cell, with a repeat", (n) => `Findings: real escape 1 · ${`real escape${" ".repeat(n)}x y · `.repeat(2)}`, 500],
    ["dots after a count", (n) => `Findings: real escape ${".".repeat(n)}x`, 20000],
    ["dots after a round", (n) => `Findings: real escape 1\nNew classes per round: round 1 → ${".".repeat(n)}x`, 20000],
    ["a comma before spaces", (n) => `Findings: real escape 1${`,${" ".repeat(50)}`.repeat(n / 50)}x`, 20000],
    ["open parentheses", (n) => `Findings: real escape 1 ${"(".repeat(n)}`, 20000],
    ["one open parenthesis, long", (n) => `Findings: real escape 1 ${"(a".repeat(n / 2)}`, 20000],
    ["lines before the block", (n) => `${"prose line\n".repeat(n)}Findings: real escape 1`, 20000],
    ["lines after the block", (n) => `Findings: real escape 1\n${"prose line\n".repeat(n)}`, 20000],
    ["lines after the block, two languages", (n) => `Bulgular: gerçek kaçak 1\n${"prose line\n".repeat(n)}`, 20000, tr],
    ["fence lines", (n) => `Findings: real escape 1\n${"\`\`\`\n".repeat(n)}`, 20000],
    ["count cells", (n) => `Findings: ${"real escape 1 · ".repeat(n)}`, 5000],
    ["count cells holding no label", (n) => `Findings: ${"x · ".repeat(n)}`, 5000],
    ["round cells", (n) => `Findings: real escape 1\nNew classes per round: ${"round 1 → 5 · ".repeat(n)}`, 5000],
    ["notes", (n) => `Findings: ${"real escape 1 (a) · ".repeat(n)}`, 5000],
    ["deep notes", (n) => `Findings: real escape 1 ${"(".repeat(n)}${")".repeat(n)}`, 20000],
  ]);
  for (const [name, make, small, config] of hostile) {
    const g = growth(make, small, config);
    assert.ok(g < 10, `${name}: four times the run took ${g.toFixed(1)} times as long`);
  }
  // Past 8 MB of one run, an open repeat runs V8 out of stack.
  const huge = 9 * 1024 * 1024;
  const runs = [
    `Findings: real escape 1\nNew classes per round: round ${"1".repeat(huge)} → 1`,
    `Findings: real escape 1\nNew classes per round: round 1 → ${"1".repeat(huge)}`,
    `Findings: real escape 1\nNew classes per round: round 1 ${" ".repeat(huge)}→ 1`,
    `Findings: real escape 1\nNew classes per round: round 1 → ${".".repeat(huge)}`,
    `Findings: real escape 1 ${"1".repeat(huge)}`,
    `Findings: real escape 1${".".repeat(huge)}`,
    `Findings: real escape ${"*".repeat(huge)}1`,
    `${"-".repeat(huge)}Findings: real escape 1`,
    `${"😀".repeat(huge / 2)}Findings: real escape 1`,
    `Findings${" ".repeat(huge)}: real escape 1`,
    `Findings: real escape 1${",".repeat(huge)}`,
    `Findings: real escape 1,${" ".repeat(huge)}2`,
    `Findings: real escape 1 ${"(".repeat(huge)}`,
    `Findings: real escape 1 (${"a".repeat(huge)})`,
    "`".repeat(huge),
    "~".repeat(huge),
    `${" ".repeat(huge)}\`\`\``,
  ];
  for (const text of runs) assert.doesNotThrow(() => parseConvergence(text, en), text.slice(0, 60));
  assert.equal(parseConvergence(`${"prose line\n".repeat(200000)}Findings: real escape 1`, en)?.foundInReview, 1);
  assert.equal(parseConvergence(`Findings: ${"real escape 1 · ".repeat(20000)}`, en)?.foundInReview, null);
  assert.equal(formatConvergence({ foundInReview: 1, fixIntroduced: 1, preExisting: 1, gateCaught: 1, escapedNew: null, escapedOld: null, perRound: Array(100000).fill(1) }, en).split("\n")[1].split(" · ").length, MAX_ROUNDS);
});

test("szz audit: a file named with a quote or a tab is reworked like any other (paths are read raw)", () => {
  for (const name of ['src/a "q".js', "src/t\tb.js"]) {
    const r = repo();
    const origin = r.commit(0, "feat: add", { [name]: ORIGIN });
    const fix = r.commit(3, "fix: add handles strings", { [name]: ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
    const res = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-01", days: 7, config: loose() });
    assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix, p.files]), [[origin, fix, [name]]], JSON.stringify(name));
  }
});

test("szz audit: move subjects fold case by the commit language and by English, so İçe and SPLIT both match", () => {
  const tr = cfg({ commitMsg: { language: "tr" }, metrics: { minLines: 1, moveSubject: "^içe aktar|\\bsplit\\b" } });
  for (const subject of ["İçe aktarma: add taşındı", "SPLIT the adder out"]) {
    const r = repo();
    r.commit(0, subject, { "src/a.js": ORIGIN });
    r.commit(3, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
    const res = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-01", days: 7, config: tr });
    assert.deepEqual([res.commits, res.reworked], [1, 0], subject);
  }
});

test("szz audit: a control character in a fix message neither invents commits nor hides the hash it names", () => {
  const r = repo();
  const origin = r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  r.commit(3, `fix: a\x01b\x02c\n\nRepairs ${origin.slice(0, 7)}\x01`, { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  // The default floor (3 lines) is not met by a one-line fix: only the named hash links it.
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.equal(res.commits, 2);
  assert.deepEqual(res.pairs.map((p) => p.origin), [origin]);
});

test("szz audit: fix messages are read in chunks, and every chunk counts", () => {
  const r = repo();
  const hashes = ["one", "two", "three"].map((w, i) => r.commit(i, `fix: ${w}\n\nbody ${w}`, { [`src/${w}.js`]: `export const ${w} = ${i};\n` }));
  const all = commitMessages(r.dir, hashes, 1);
  assert.deepEqual(hashes.map((h) => all.get(h)?.trim()), ["fix: one\n\nbody one", "fix: two\n\nbody two", "fix: three\n\nbody three"]);
});

test("szz: a commit dated weeks early does not hide the commits behind it (no --since walk)", () => {
  const r = repo();
  const origin = r.commit(2, "feat: add", { "src/a.js": ORIGIN });
  // A clock a month behind: git's --since walk stops here and never reaches the origin.
  r.commit(-31, "feat: other", { "src/b.js": "export const b = 1;\n" });
  const fix = r.commit(4, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const res = reworkRate({ cwd: r.dir, since: "2026-01-02", until: "2026-01-03", days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked], [1, 1]);
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix]), [[origin, fix]]);
  // The early commit itself is outside the range by its own time, behind the origin or not.
  assert.equal(reworkRate({ cwd: r.dir, since: "2026-01-01", days: 7, config: loose() }).commits, 2);
  assert.equal(reworkRate({ cwd: r.dir, since: "2025-12-01", until: "2025-12-01", days: 7, config: loose() }).commits, 1);
});

test("szz: a fix dated before the origin it repairs (a clock off) is said, not read as no rework", () => {
  const r = repo();
  r.commit(2, "feat: add", { "src/a.js": ORIGIN });
  // A child commit whose clock is a month behind: blame still finds the origin behind it.
  r.commit(-29, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked, res.skewed], [1, 0, 1], "the origin is unmeasured, not a clean commit; the fix is one");
  // A link below the floor is no pair whatever the clocks say: not counted as skewed either.
  assert.equal(reworkRate({ cwd: r.dir, days: 7, config: cfg() }).skewed, 0);
});

test("szz audit: the log keeps what the filter keeps and reads every kept commit's paths, chunk by chunk", () => {
  const r = repo();
  const hashes = ["one", "two", "three"].map((w, i) => r.commit(i, `feat: ${w}`, { [`src/${w}.js`]: `export const ${w} = ${i};\n` }));
  for (const chunk of [1, 2, 500]) {
    const log = readLog(r.dir, () => true, chunk);
    assert.deepEqual(log.map((c) => [c.hash, c.subject, c.changes]), [2, 1, 0].map((i) => [hashes[i], `feat: ${["one", "two", "three"][i]}`, [{ status: "A", path: `src/${["one", "two", "three"][i]}.js` }]]), `chunk ${chunk}`);
  }
  const two = Date.UTC(2026, 0, 2, 12) / 1000;
  const kept = readLog(r.dir, (t) => t !== two, 1);
  assert.deepEqual(kept.map((c) => [c.hash, c.subject, c.changes.length]), [[hashes[2], "feat: three", 1], [hashes[0], "feat: one", 1]]);
  // A rename is both names (diff.renames is on by default): a status like R100 would read as no change.
  git(["mv", "src/one.js", "src/uno.js"], { cwd: r.dir });
  const moved = r.commit(3, "chore: rename", {});
  assert.deepEqual(readLog(r.dir, (t) => t === two + 2 * 86400).map((c) => [c.hash, c.changes]), [[moved, [{ status: "D", path: "src/one.js" }, { status: "A", path: "src/uno.js" }]]]);
});

test("szz audit: a file named like a commit's hash does not stop the log (the revisions end at --)", () => {
  const r = repo();
  const origin = r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  const fix = r.commit(3, `fix: add handles strings\n\nRepairs ${origin.slice(0, 7)}`, { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  for (const h of [origin, fix]) writeFileSync(join(r.dir, h), "");
  const res = reworkRate({ cwd: r.dir, days: 7, config: cfg() });
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix]), [[origin, fix]]);
  assert.equal(commitMessages(r.dir, [fix]).get(fix)?.split("\n")[0], "fix: add handles strings");
});

test("szz audit: a commit with no committer time is in no dated range, and unmeasured in a range with none", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  writeFileSync(join(r.dir, "src", "b.js"), "export const b = 1;\n");
  git(["add", "-A"], { cwd: r.dir });
  const tree = git(["write-tree"], { cwd: r.dir });
  // git refuses to write one; another tool can (hash-object --literally), and %ct is then empty.
  const raw = `tree ${tree}\nparent ${git(["rev-parse", "HEAD"], { cwd: r.dir })}\nauthor t <t@t> 1767355200 +0000\ncommitter t <t@t>\n\nfeat: no time\n`;
  const bare = spawnSync("git", ["hash-object", "-t", "commit", "--literally", "-w", "--stdin"], { cwd: r.dir, input: raw, encoding: "utf8" }).stdout.trim();
  git(["update-ref", "HEAD", bare], { cwd: r.dir });
  r.commit(3, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const log = readLog(r.dir, () => true);
  assert.deepEqual(log.filter((c) => c.hash === bare).map((c) => [Number.isNaN(c.time), c.subject, c.changes]), [[true, "feat: no time", [{ status: "A", path: "src/b.js" }]]]);
  const none = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([none.commits, none.censored, none.reworked], [2, 1, 1], "the origin and the fix count; the commit with no time is unmeasured");
  const dated = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-31", days: 7, config: loose() });
  assert.deepEqual([dated.commits, dated.censored, dated.reworked], [2, 0, 1]);
});

test("szz audit: a fix with no committer time links to its origin unmeasured, said in skewed", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  writeFileSync(join(r.dir, "src", "a.js"), ORIGIN.replace("return a + b;", "return Number(a) + Number(b);"));
  git(["add", "-A"], { cwd: r.dir });
  const raw = `tree ${git(["write-tree"], { cwd: r.dir })}\nparent ${git(["rev-parse", "HEAD"], { cwd: r.dir })}\nauthor t <t@t> 1767528000 +0000\ncommitter t <t@t>\n\nfix: add handles strings\n`;
  git(["update-ref", "HEAD", spawnSync("git", ["hash-object", "-t", "commit", "--literally", "-w", "--stdin"], { cwd: r.dir, input: raw, encoding: "utf8" }).stdout.trim()], { cwd: r.dir });
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked, res.skewed, res.censored], [0, 0, 1, 1], "the origin is unmeasured, the fix censored");
  assert.equal(res.rate, null);
});

test("szz audit: with log.showSignature on, signed commits are read like any other (no text in front of the fields)", (t) => {
  const keygen = spawnSync("ssh-keygen", ["-V"], { encoding: "utf8" });
  if (keygen.error) return t.skip("ssh-keygen not available");
  const r = repo();
  const key = join(r.dir, "..", `key-${r.dir.split(/[\\/]/).pop()}`);
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", key], ["commit.gpgsign", "true"], ["log.showSignature", "true"]]) git(["config", k, v], { cwd: r.dir });
  assert.equal(git(["config", "--get", "log.showSignature"], { cwd: r.dir }), "false", "every helper call overrides it");
  const signed = (/** @type {number} */ day, /** @type {string} */ message, /** @type {Record<string, string>} */ files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(r.dir, path)), { recursive: true });
      writeFileSync(join(r.dir, path), content);
    }
    const date = new Date(Date.UTC(2026, 0, 1 + day, 12, 0, 0)).toISOString();
    git(["add", "-A"], { cwd: r.dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-S", "-m", message], { cwd: r.dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return git(["rev-parse", "HEAD"], { cwd: r.dir });
  };
  const origin = signed(0, "feat: add", { "src/a.js": ORIGIN });
  const fix = signed(3, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  // A plain git log here does print signature text: the override is what keeps the parser right.
  assert.match(spawnSync("git", ["log", "-1"], { cwd: r.dir, encoding: "utf8" }).stdout + spawnSync("git", ["log", "-1"], { cwd: r.dir, encoding: "utf8" }).stderr, /signature|allowedSignersFile/i);
  const res = reworkRate({ cwd: r.dir, since: "2026-01-01", until: "2026-01-01", days: 7, config: loose() });
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix]), [[origin, fix]]);
});

test("rework audit: a shallow file that is there but cannot be read is no full clone", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const { shallowEdge } = await import("../plugin/metrics/szz.mjs");
  const r = repo();
  r.commit(0, "feat: one", { "a.js": "a\n" });
  assert.deepEqual([...shallowEdge(r.dir)], [], "no shallow file: a full clone");
  const shallow = join(r.dir, ".git", "shallow");
  writeFileSync(shallow, `${git(["rev-parse", "HEAD"], { cwd: r.dir })}\n`);
  assert.equal(shallowEdge(r.dir).size, 1);
  chmodSync(shallow, 0o000);
  try {
    assert.throws(() => shallowEdge(r.dir), /shallow could not be read: EACCES/);
  } finally {
    chmodSync(shallow, 0o644);
  }
});

test("rework audit: a fix that also moves a submodule's commit is measured; the gitlink is no line blame can read", () => {
  const r = repo();
  gitlink(r, "lib/sub", "1");
  const origin = r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  gitlink(r, "lib/sub", "2");
  const fix = r.commit(3, "fix: add handles strings, and the submodule's fix", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  assert.equal(git(["ls-tree", fix, "lib/sub"], { cwd: r.dir }).split(/\s/)[0], "160000", "the fix moves a gitlink");
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix, p.files]), [[origin, fix, ["src/a.js"]]]);
  assert.equal(res.submoduleFixes, 0, "the fix's file was read");
});

test("rework audit: a fix that moved only a submodule is said, not read as a fix that found no origin", () => {
  const r = repo();
  gitlink(r, "lib/sub", "1");
  r.commit(0, "feat: use lib", { "src/a.js": ORIGIN });
  gitlink(r, "lib/sub", "2");
  r.commit(3, "fix: bump lib to the repaired release", {});
  const moved = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([moved.commits, moved.reworked, moved.fixCommits, moved.submoduleFixes], [1, 0, 0, 1]);
  // Dropping the submodule is the same shape: no side of the change holds a file.
  git(["update-index", "--force-remove", "lib/sub"], { cwd: r.dir });
  r.commit(4, "fix: drop lib", {});
  assert.equal(reworkRate({ cwd: r.dir, days: 7, config: loose() }).submoduleFixes, 2);
  // A path the rate does not read is no unread fix, and an ordinary bump is no fix.
  const other = repo();
  gitlink(other, "vendor/sub", "1");
  other.commit(0, "feat: use lib", { "src/a.js": ORIGIN });
  gitlink(other, "vendor/sub", "2");
  other.commit(3, "fix: bump the vendored lib", {});
  gitlink(other, "lib/sub", "3");
  other.commit(4, "chore: bump lib", {});
  assert.equal(reworkRate({ cwd: other.dir, days: 7, config: loose() }).submoduleFixes, 0);
});

test("rework audit: a commit that only moves a submodule is no candidate and no window to wait for", () => {
  const r = repo();
  r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  r.commit(1, "feat: b", { "src/b.js": "export const b = 1;\n" });
  r.commit(2, "feat: c", { "src/c.js": "export const c = 1;\n" });
  r.commit(3, "fix: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  for (const digit of "123456789") {
    gitlink(r, "lib/sub", digit);
    r.commit(4, `chore: bump lib ${digit}`, {});
  }
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked, res.rate], [4, 1, 0.25]);
  assert.equal(reworkRate({ cwd: r.dir, days: 7, config: loose(), now: Math.floor(Date.UTC(2026, 0, 6) / 1000) }).censored, 4, "the bumps wait for nothing");
});

test("rework audit: a gitlink is no file of a sweep; a file a gitlink replaced is still a change", () => {
  const files = (/** @type {number} */ n, /** @type {string} */ text) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${i}.js`, text]));
  for (const [n, reworked] of [[15, 1], [16, 0]]) {
    const r = repo();
    gitlink(r, "lib/sub", "1");
    r.commit(0, "feat: modules", files(Number(n), TOTAL));
    gitlink(r, "lib/sub", "2");
    r.commit(2, "fix: tax rounding everywhere", files(Number(n), TOTAL_FIXED));
    assert.equal(reworkRate({ cwd: r.dir, days: 7, config: cfg() }).reworked, reworked, `${n} files and a gitlink, a sweep past 15`);
  }
  // The commit took the file's lines away, so it stays a commit with a change (status T, a fix reads no such file).
  const r = repo();
  r.commit(0, "feat: add", { "lib/sub": ORIGIN });
  git(["rm", "-q", "--cached", "lib/sub"], { cwd: r.dir });
  rmSync(join(r.dir, "lib", "sub"));
  gitlink(r, "lib/sub", "1");
  r.commit(3, "fix: use the module", {});
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked, res.submoduleFixes], [2, 0, 0]);
});

test("rework audit: a file that replaced a gitlink is a candidate like any other, and a later fix names it", () => {
  const r = repo();
  gitlink(r, "lib/sub", "1");
  r.commit(0, "feat: use lib", { "src/a.js": ORIGIN });
  git(["rm", "-q", "--cached", "lib/sub"], { cwd: r.dir });
  rmSync(join(r.dir, "lib", "sub"), { recursive: true });
  const origin = r.commit(1, "feat: keep lib as a file", { "lib/sub": ORIGIN });
  const fix = r.commit(3, "fix: add handles strings", { "lib/sub": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  assert.deepEqual(readLog(r.dir, () => true).find((c) => c.hash === origin)?.changes, [{ status: "T", path: "lib/sub" }]);
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.commits, res.reworked, res.submoduleFixes], [3, 1, 0]);
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix, p.files]), [[origin, fix, ["lib/sub"]]]);
});

test("rework audit: the log tells a submodule's commit from a file by its mode; a name spelled like a raw line stays a name", () => {
  const r = repo();
  gitlink(r, "lib/sub", "1");
  const name = ":160000 160000 1 2 M";
  const first = r.commit(0, "feat: add", { [name]: "x\n", "src/a.js": ORIGIN });
  const log = readLog(r.dir, () => true);
  assert.deepEqual(log.map((c) => [c.hash, c.changes.map((ch) => ch.path).sort(), c.submodules]), [[first, [name, "src/a.js"].sort(), ["lib/sub"]]]);
});

test("rework audit: diff.ignoreSubmodules and submodule.<name>.ignore do not hide a fix that moved only a submodule", () => {
  const r = repo();
  r.commit(0, "chore: modules", { ".gitmodules": '[submodule "sub"]\n\tpath = lib/sub\n\turl = ../sub\n' });
  gitlink(r, "lib/sub", "1");
  r.commit(1, "feat: use lib", { "src/a.js": ORIGIN });
  gitlink(r, "lib/sub", "2");
  r.commit(3, "fix: bump lib", {});
  const read = () => reworkRate({ cwd: r.dir, days: 7, config: loose() }).submoduleFixes;
  assert.equal(read(), 1);
  for (const key of ["diff.ignoreSubmodules", "submodule.sub.ignore"]) {
    git(["config", key, "all"], { cwd: r.dir });
    assert.equal(read(), 1, key);
    git(["config", "--unset", key], { cwd: r.dir });
  }
});

test("rework audit: a textconv driver in the config does not change the lines read", () => {
  const r = repo();
  // A driver that drops the first line and shows the rest as comments: read through it, the fix deletes no
  // code line, and the line the commit changes (the last) is past the end of what blame would read.
  git(["config", "diff.hide.textconv", "sed -e 1d -e s,^,//,"], { cwd: r.dir });
  r.commit(0, "chore: attributes", { ".gitattributes": "*.js diff=hide\n" });
  const origin = r.commit(1, "feat: rate", { "src/a.js": "// rates\nexport const rate = 0.2;\n" });
  const fix = r.commit(3, "fix: rate", { "src/a.js": "// rates\nexport const rate = 0.18;\n" });
  assert.match(spawnSync("git", ["diff", `${fix}^`, fix], { cwd: r.dir, encoding: "utf8" }).stdout, /^-\/\/export const rate = 0\.2;$/m, "git diff applies the driver");
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual(res.pairs.map((p) => [p.origin, p.fix, p.lines]), [[origin, fix, 1]]);
});

test("rework audit: the default fix label reads every subject the commit gate admits as the fix type, and no other type, autosquash marker or longer word", async () => {
  const { checkCommitShape } = await import("../plugin/checks/commit-shape.mjs");
  const { DEFAULTS } = await import("../plugin/core/config.mjs");
  const label = new RegExp(DEFAULTS.metrics.fixSubject);
  const gate = cfg({ commitMsg: { types: ["feat", "fix"], fixType: "fix" } });
  const fixes = ["fix: a", "fix(ui): a", "fix!: a", "fix(ui)!: a"];
  for (const s of fixes) {
    assert.ok(checkCommitShape(s, { config: gate }).ok, `the gate admits ${s}`);
    assert.ok(label.test(s), `the label reads ${s}`);
  }
  // Other types, autosquash markers and words that only start like the type.
  for (const s of ["feat: a", "feat!: a", "fixup! fix: a", "squash! fix: a", "amend! fix: a", "fix a", "fixes: a", "fix!a", "fix!!: a", "Fix: a", "prefix: a", "hotfix: a"]) {
    assert.ok(!label.test(s), `the label does not read ${s}`);
  }
  // The rate counts it: a breaking fix repairs an earlier commit like any other.
  const r = repo();
  const origin = r.commit(0, "feat: add", { "src/a.js": ORIGIN });
  const fix = r.commit(3, "fix!: add handles strings", { "src/a.js": ORIGIN.replace("return a + b;", "return Number(a) + Number(b);") });
  const res = reworkRate({ cwd: r.dir, days: 7, config: loose() });
  assert.deepEqual([res.fixCommits, res.pairs.map((p) => [p.origin, p.fix])], [1, [[origin, fix]]]);
});
