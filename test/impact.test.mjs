import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { buildImpactTable, formatImpactTable, specifierRefersTo } from "../impact/table.mjs";

const cfg = (override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-i-")), env: {}, override });

/** @param {string} dir @param {Record<string, string>} files @param {string} message */
function commit(dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir });
}

const PARSE = [
  "export const MAX_ROWS = 1000;",
  "export function parseRow(line) {",
  "  try {",
  "    return JSON.parse(line);",
  "  } catch (err) {",
  "    return null;",
  "  }",
  "}",
  "export async function parseAll(lines) {",
  "  if (!lines) return [];",
  "  return Promise.all(lines.map(parseRow)).catch(() => []);",
  "}",
  "",
].join("\n");

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pl-impact-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  commit(
    dir,
    {
      "src/lib/engine/parse.js": PARSE,
      "server/lib/parse.js": "export function parseRow(l) { return l; }\n",
      "src/routes/rows.js": 'import { parseRow } from "../lib/engine/parse.js";\nexport const get = (l) => parseRow(l);\n',
      "src/jobs/nightly.js": 'import { parseRow } from "../lib/engine/parse.js";\nparseRow("{}");\n',
      "src/ui/view.js": 'import { parseRow } from "../lib/engine/parse.js";\nexport const v = parseRow;\n',
      "src/ui/parseRowLike.js": "export const parseRowish = 1; // not a whole-word reference\n",
      "src/routes/rows.test.js": [
        'import { vi, test } from "vitest";',
        'vi.mock("../lib/engine/parse.js", () => ({ parseRow: () => ({ ok: true }) }));',
        'import { get } from "./rows.js";',
        'test("get", () => get("x"));',
        "",
      ].join("\n"),
      "src/lib/engine/parse.test.js": [
        'import { readFileSync } from "node:fs";',
        'import { vi, test } from "vitest";',
        'import { parseRow } from "./parse.js";',
        'const rows = readFileSync(new URL("./__fixtures__/rows.jsonl", import.meta.url), "utf8");',
        "const spy = vi.fn();",
        'test("parseRow", () => rows.split("\\n").map(parseRow));',
        "",
      ].join("\n"),
      "src/lib/engine/__fixtures__/rows.jsonl": '{"a":1}\n',
      // Another module's recording in the shared fixture directory.
      "src/lib/engine/__fixtures__/unrelated-parity.json": "{}\n",
      "ceilings.json": JSON.stringify({
        registered: {
          "src/lib/engine/parse.js#MAX_ROWS": { whenFull: "rejects", test: "src/lib/engine/parse.test.js" },
          "src/other.js#LIMIT": { whenFull: "drops" },
        },
        inherited: ["src/lib/engine/parse.js#INHERITED_CAP", "src/other.js#OLD"],
      }),
      "README.md": "# x\n",
    },
    "feat: initial",
  );
  commit(
    dir,
    { "src/lib/engine/parse.js": PARSE + "// v2\n", "src/ui/view.js": 'import { parseRow } from "../lib/engine/parse.js";\nexport const v = parseRow; // v2\n' },
    "feat: v2",
  );
  commit(dir, { "src/lib/engine/parse.js": PARSE + "// v3\n", "README.md": "# y\n" }, "docs: v3");
  return dir;
}

const IMPACT = {
  impact: { twins: [["src/lib/engine", "server/lib"]], coChangeMin: 2, ceilingRegistry: "ceilings.json" },
};

test("impact: every row is answered from the repository", () => {
  const dir = fixtureRepo();
  const { rows } = buildImpactTable({ cwd: dir, config: cfg(IMPACT), symbol: "parseRow", files: ["src/lib/engine/parse.js"] });
  assert.deepEqual(rows.map((r) => r.id), ["S1", "S2", "S3", "S4", "S5"]);
  for (const r of rows) {
    assert.ok(r.question.length > 0, r.id);
    assert.ok(r.answer.trim().length > 0, r.id);
    assert.ok(!/unmeasured/.test(r.answer), `${r.id}: ${r.answer}`);
  }
  const [s1, s2, s3, s4, s5] = rows.map((r) => r.answer);

  // S1: references outside tests, the twin, co-change above the threshold (docs excluded).
  assert.match(s1, /references: 7 references in 4 files \(tests and metrics\.excludeRe paths left out\)/);
  assert.match(s1, /src\/routes\/rows\.js:1,2/);
  assert.match(s1, /server\/lib\/parse\.js:1/);
  assert.ok(!s1.includes("src/lib/engine/parse.js:"), "the input file is not 'someone else'");
  assert.ok(!s1.includes("rows.test.js"), "test files are not readers");
  assert.ok(!s1.includes("parseRowLike"), "whole-word match only");
  assert.match(s1, /twins: src\/lib\/engine\/parse\.js ↔ server\/lib\/parse\.js/);
  assert.match(s1, /co-change: src\/ui\/view\.js \(2 commits\)$/m);
  assert.ok(!s1.includes("README"), "excluded paths do not count as co-change");
  assert.ok(rows[0].commands.some((c) => c.startsWith("git grep")));

  // S2: entry points only, the input file itself is not "another path".
  assert.match(s2, /src\/routes\/rows\.js/);
  assert.match(s2, /src\/jobs\/nightly\.js/);
  assert.ok(!s2.includes("src/ui/view.js"));

  // S3: the adjacent test and its fixture.
  assert.match(s3, /src\/lib\/engine\/parse\.test\.js/);
  assert.match(s3, /src\/lib\/engine\/__fixtures__\/rows\.jsonl/);
  assert.ok(!s3.includes("unrelated-parity"), "a shared fixture directory's other recordings are not this file's corpus");

  // S4: the registry entry naming the file, and the fallback count.
  assert.match(s4, /2 entries mention the input files: src\/lib\/engine\/parse\.js#MAX_ROWS, src\/lib\/engine\/parse\.js#INHERITED_CAP/);
  assert.ok(!s4.includes("src/other.js"));
  assert.match(s4, /src\/lib\/engine\/parse\.js: 2 catch, 2 fallback returns/);

  // S5: the mock without a fixture is listed explicitly; the fixture-backed test is not.
  assert.match(s5, /src\/routes\/rows\.test\.js mocks the module — no recorded fixture/);
  assert.match(s5, /src\/lib\/engine\/parse\.test\.js imports the module and builds fakes — recorded fixture: src\/lib\/engine\/__fixtures__\/rows\.jsonl/);
  assert.match(s5, /fakes without a recorded source: src\/routes\/rows\.test\.js$/m);
});

test("impact: without a symbol S1/S2 say unmeasured, never empty", () => {
  const dir = fixtureRepo();
  const c = cfg(IMPACT);
  const noSymbol = buildImpactTable({ cwd: dir, config: c, files: ["src/lib/engine/parse.js"] }).rows;
  assert.match(noSymbol[0].answer, /references: unmeasured: no symbol given/);
  assert.match(noSymbol[0].answer, /twins: src\/lib\/engine\/parse\.js ↔ server\/lib\/parse\.js/);
  assert.equal(noSymbol[1].answer, "unmeasured: no symbol given");

  const nothing = buildImpactTable({ cwd: dir, config: c }).rows;
  for (const r of nothing) assert.match(r.answer, /^unmeasured: \S/, r.id);
  assert.match(nothing[0].answer, /^unmeasured: references: no symbol given; twins: no files given; co-change: no files given$/);
});

test("impact: a missing twin, no adjacent test, and an unconfigured registry are reported, not hidden", () => {
  const dir = fixtureRepo();
  commit(
    dir,
    {
      "src/lib/solo/lonely.js": "export function lonely() { return 0; }\n",
      "src/lib/solo/other.js": "export const other = 1;\n",
      // A neighbour's test does not make lonely.js covered.
      "src/lib/solo/other.test.js": 'import { other } from "./other.js";\n',
    },
    "feat: lonely",
  );
  const c = cfg({ impact: { twins: [["src/lib/solo", "server/solo"]] } });
  const rows = buildImpactTable({ cwd: dir, config: c, symbol: "lonely", files: ["src/lib/solo/lonely.js"] }).rows;
  assert.match(rows[0].answer, /src\/lib\/solo\/lonely\.js: no twin at server\/solo\/lonely\.js/);
  assert.match(rows[2].answer, /^no test or corpus next to the input files: build an accept \+ reject corpus/);
  assert.match(rows[3].answer, /ceiling registry: unmeasured: no ceiling registry configured/);
  assert.match(rows[3].answer, /lonely\.js: 0 catch, 1 fallback returns/);
  assert.equal(rows[4].answer, "no test mocks or imports the input files");
});

test("impact: tests that import without faking do not claim 'every fake is sourced'", () => {
  const dir = fixtureRepo();
  commit(dir, { "src/lib/plain/sum.js": "export const sum = (a, b) => a + b;\n", "src/lib/plain/sum.test.js": 'import { sum } from "./sum.js";\nsum(1, 2);\n' }, "feat: sum");
  const s5 = buildImpactTable({ cwd: dir, config: cfg(), files: ["src/lib/plain/sum.js"] }).rows[4].answer;
  assert.match(s5, /src\/lib\/plain\/sum\.test\.js imports the module \(no fakes\) — no recorded fixture/);
  assert.match(s5, /no test builds fakes of the input files$/);
  assert.ok(!s5.includes("every fake"));
});

test("impact: referenceCommand output replaces git grep (first 40 lines), failure is unmeasured", () => {
  const dir = fixtureRepo();
  writeFileSync(join(dir, "refs.mjs"), "const s = process.argv[2]; for (let i = 1; i <= 45; i++) console.log(`${s} line ${i}`);\n");
  const ok = buildImpactTable({ cwd: dir, config: cfg({ impact: { referenceCommand: "node refs.mjs {symbol}" } }), symbol: "parseRow" }).rows[0];
  assert.deepEqual(ok.commands, ["node refs.mjs parseRow"]);
  assert.match(ok.answer, /references: parseRow line 1\n/);
  assert.match(ok.answer, /parseRow line 40\n…and 5 more lines/);
  assert.ok(!ok.answer.includes("line 41"));
  const bad = buildImpactTable({ cwd: dir, config: cfg({ impact: { referenceCommand: "node no-such-file.mjs {symbol}" } }), symbol: "x", files: ["src/lib/engine/parse.js"] }).rows[0];
  assert.match(bad.answer, /references: unmeasured: reference command failed: /);
});

test("impact: outside a git repository the git-based rows are unmeasured", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-impact-norepo-"));
  writeFileSync(join(dir, "a.js"), "try {} catch {}\n");
  const rows = buildImpactTable({ cwd: dir, config: cfg(), symbol: "a", files: ["a.js"] }).rows;
  assert.match(rows[0].answer, /^unmeasured: references: git could not read the repository/);
  assert.match(rows[1].answer, /^unmeasured: git could not read the repository/);
  assert.match(rows[2].answer, /^unmeasured: /);
  assert.match(rows[3].answer, /a\.js: 1 catch, 0 fallback returns/);
  assert.match(rows[4].answer, /^unmeasured: /);
});

test("impact: Turkish output and the markdown table", () => {
  const dir = fixtureRepo();
  const c = cfg({ language: "tr", ...IMPACT });
  const table = buildImpactTable({ cwd: dir, config: c, symbol: "parseRow", files: ["src/lib/engine/parse.js"] });
  const md = formatImpactTable(table, c);
  const lines = md.split("\n");
  assert.equal(lines[0], "| # | Soru | Yanıt | Komutlar |");
  assert.equal(lines.length, 7);
  assert.match(lines[2], /^\| S1 \| Bu kararı başka kim okuyor ya da veriyor\? \| başvurular: /);
  assert.ok(lines.slice(2).every((l) => l.startsWith("| S") && l.endsWith(" |")), "one line per row: newlines become <br>");
  assert.match(md, /<br>ikizler: /);
  const empty = formatImpactTable(buildImpactTable({ cwd: dir, config: c }), c);
  assert.match(empty, /\| S2 \| [^|]+ \| ölçülmedi: sembol verilmedi \|/);
  // A pipe in an answer does not split the cell.
  const piped = formatImpactTable({ rows: [{ id: "S1", question: "q", answer: "a | b", commands: ["x|y"] }] }, cfg());
  assert.match(piped, /\| S1 \| q \| a \\\| b \| `x\\\|y` \|/);
});

test("impact: module specifiers resolve relative paths and aliases, never bare packages", () => {
  assert.ok(specifierRefersTo("../lib/engine/parse.js", "src/routes/rows.test.js", "src/lib/engine/parse.js"));
  assert.ok(specifierRefersTo("./parse", "src/lib/engine/parse.test.ts", "src/lib/engine/parse.ts"));
  assert.ok(specifierRefersTo("@/lib/engine/parse", "src/x.test.ts", "src/lib/engine/parse.ts"));
  assert.ok(specifierRefersTo("./engine", "src/lib/a.test.ts", "src/lib/engine/index.ts"));
  assert.ok(!specifierRefersTo("parse", "src/x.test.ts", "src/lib/parse.ts"), "bare package name");
  assert.ok(!specifierRefersTo("./parse", "src/other/x.test.ts", "src/lib/parse.ts"), "relative to a different directory");
});
