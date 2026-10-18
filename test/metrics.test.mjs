import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { reworkRate, deletedCodeLines, isCodeLine, parseBound } from "../metrics/szz.mjs";
import { parseConvergence, formatConvergence } from "../metrics/convergence.mjs";

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
  assert.deepEqual(res, { commits: 0, reworked: 0, rate: null, fixCommits: 0, censored: 0, pairs: [] });
  const empty = mkdtempSync(join(tmpdir(), "pl-szz-empty-"));
  git(["init", "-q"], { cwd: empty });
  assert.equal(reworkRate({ cwd: empty, config: cfg() }).rate, null);
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
  assert.throws(() => reworkRate({ cwd: mkdtempSync(join(tmpdir(), "pl-norepo-")), config: cfg() }));
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
  assert.deepEqual(parseConvergence(text, cfg()), { realEscape: 2, fixIntroduced: 1, preExisting: 4, gateCaught: 3, perRound: [5, 1, 0] });
});

test("convergence: parses Turkish labels in a Turkish project, markdown emphasis ignored", () => {
  const text = [
    "**Bulgular:** gerçek kaçak 1 · düzeltmenin açtığı 0 · eski 2 · kapının yakaladığı 5",
    "Tur başına yeni sınıf: tur 1 → 3 · tur 2 → 2 · tur 3+ → 1",
  ].join("\n");
  assert.deepEqual(parseConvergence(text, cfg({ language: "tr" })), { realEscape: 1, fixIntroduced: 0, preExisting: 2, gateCaught: 5, perRound: [3, 2, 1] });
});

test("convergence: no findings line → null; missing per-round line → []; unreported count → null", () => {
  assert.equal(parseConvergence("## Cycle\nnothing measured here", cfg()), null);
  assert.equal(parseConvergence("Bulgular: gerçek kaçak 1", cfg()), null, "an English project does not read Turkish labels");
  const partial = parseConvergence("Findings: real escape 1 · gate-caught ?", cfg());
  assert.deepEqual(partial, { realEscape: 1, fixIntroduced: null, preExisting: null, gateCaught: null, perRound: [] });
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
  assert.equal(c?.realEscape, 0);
  assert.deepEqual(c?.perRound, [1]);
});

test("convergence: format and parse round-trip in both languages", () => {
  const cases = [
    { realEscape: 2, fixIntroduced: 0, preExisting: 7, gateCaught: 1, perRound: [4, 1, 0] },
    { realEscape: 0, fixIntroduced: 3, preExisting: 0, gateCaught: 0, perRound: [] },
    { realEscape: 1, fixIntroduced: null, preExisting: 2, gateCaught: 0, perRound: [2, 0] },
    { realEscape: 1, fixIntroduced: 1, preExisting: 1, gateCaught: 1, perRound: [3, 2, 1, 1] },
  ];
  for (const language of ["en", "tr"]) {
    const c = cfg({ language });
    for (const counts of cases) assert.deepEqual(parseConvergence(formatConvergence(counts, c), c), counts, `${language} ${JSON.stringify(counts)}`);
  }
  assert.equal(
    formatConvergence(cases[0], cfg()),
    "Findings: real escape 2 · fix-introduced 0 · pre-existing 7 · gate-caught 1\nNew classes per round: round 1 → 4 · round 2 → 1 · round 3+ → 0",
  );
  assert.match(formatConvergence(cases[0], cfg({ language: "tr" })), /^Bulgular: gerçek kaçak 2 · düzeltmenin açtığı 0 · eski 7 · kapının yakaladığı 1\nTur başına yeni sınıf: tur 1 → 4/);
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
  const sweep = repo();
  const files = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`src/m${i}.js`, TOTAL]));
  sweep.commit(0, "feat: modules", files);
  const fixed = Object.fromEntries(Object.keys(files).map((f) => [f, TOTAL_FIXED]));
  sweep.commit(2, "fix: tax rounding everywhere", fixed);
  assert.equal(reworkRate({ cwd: sweep.dir, days: 7, config: cfg() }).reworked, 0, "16 production files > maxFixFiles 15");
  assert.equal(reworkRate({ cwd: sweep.dir, days: 7, config: cfg({ metrics: { maxFixFiles: 16 } }) }).reworked, 1);
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
