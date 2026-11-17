/**
 * The convergence table of skills/cycle/report-formats.md, pointed at its tests. The "One row, one column" table
 * and its "By age" list are written here as data: each line's number, each condition its row names, the column it
 * gives, and the tests of test/findings.test.mjs that run that condition through the command on git. The text and
 * the data must match exactly, and so must the data and the tests' titles. A row or condition added, dropped,
 * reworded or renumbered fails until the data follows it, and the data cannot follow without the tests that run
 * it. Every test of that file's convergence sections (by its title's prefix) whose title names a line is tied by
 * the data to that line and no other, so a line renumbered in the text renames its tests too. Nothing here reads
 * meaning: findings.test.mjs runs the walk, and this file keeps it pointed at the text.
 *
 * Origin: procedure-leaves-case-open, method-rules-walked's second step (cycle 2026-11-05 (23)); the model is
 * test/method-walk.test.mjs, which pins task-brief.md's failure count the same way.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORMATS = "skills/cycle/report-formats.md";
const TESTS = "test/findings.test.mjs";
/** Where each block opens: the line that starts with this, then the table or the list after blank lines. */
const TABLE_LEAD = "**One row, one column.**";
const AGE_LEAD = "**By age**";
/** The tests every line of either block must be claimed by: the walk of the table, on git. */
const WALK = "convergence table: ";

/** The prefixes of findings.test.mjs's convergence sections: there `line N` is a line of the table or of By age. */
const SECTIONS = ["convergence table", "convergence", "convergence differential", "new classes per round", "recurring class"];
/** The six columns, as the command's report names them (i18n/en.json, `convergence.<key>`). */
const COLUMNS = ["foundInReview", "fixIntroduced", "preExisting", "gateCaught", "escapedNew", "escapedOld"];

// The tests of findings.test.mjs, by title. One name a test, so each tie below reads as one string.
const DUP = "convergence table: line 1: a duplicate or a refuted row counts nowhere, whatever else it says";
const DECLINED = "convergence table: a declined row is no refuted one: the defect is real, it counts in its column, and its id is said under the block";
const BRIEF = "convergence table: line 2: a brief row counts in no column, whatever caught it, and its id is said under the block";
const FIRST = "convergence table: line 3 comes before line 4: a pre-existing row a gate caught goes by its age";
const ORDER = "convergence table: lines 4 to 7, in order";
const UNTRACKED = "convergence table: a test that HEAD does not track is no gate, and the row reads as the lines below say";
const FAILS = "convergence table: a git that fails reads `?` in what it would have placed, and nowhere else";
const REFUSED = "convergence: a refused row makes every column and round `?`, prints why, and never a smaller number";
const NULL_BORN = "convergence table: by age, line 1: a null bornIn or one off the history leaves the table, and the others stay";
const REBASED = "convergence table: by age, line 1: a bornIn the rebase rewrote has no age until it is blamed again";
const NO_START = "convergence table: by age, line 1: no start noted reads `?` only where a row needs one";
const NO_ANCESTOR = "convergence: --from: empty is a usage error; one that is no ancestor reads as not noted, and bypass's sentence stands under the block";
const AMENDED = "convergence: the cycle's start amended away reads `?` where a row needs an age, and the words say why";
const NO_CONFIG = "convergence table: by age, line 1: HEAD with no config reads `?`, its absence from an older tree does not";
const SHALLOW = "convergence table: by age, line 1: a shallow clone reads `?`";
const PARTIAL = "convergence table: by age, line 1: a tree a partial clone does not hold reads `?`, and nothing is fetched";
const NO_TREE_CONFIG = "convergence table: by age, line 2: a tree with no config is pre-existing";
const LATE = "convergence table: a config committed late reads as the text says: code before it is pre-existing";
const ANCESTOR = "convergence table: by age, line 3: an ancestor of the start is old, the start itself too";
const REPLACED = "convergence table: a replace ref does not move a row's age, and neither does it move the start";
const THIS_CYCLE = "convergence table: by age, line 4: this cycle's code is gate-caught when a gate caught it, else escaped new";
const NEW_CLASSES = "new classes per round: a class counts once, in the first round that names it; round 0 and line 1 as the text says";
const RECURRING = "recurring class: a tie prints all, by id; nothing twice is none; line 1 leaves its rows out";

/**
 * A numbered line of a block. `when`: each condition its row names, in the text's order, with the tests that run
 * it; between two conditions the text holds only `, `, ` or ` or `, or `. `then`: what the line gives, as written
 * (the table's Column cell; a list item's words after its condition's colon). `columns`: the columns `then` names,
 * by key. `more`: the item's sentences after its first. `age`: the row that sends to By age.
 * @typedef {{ n: number, when: [string, string[]][], then: string, columns: string[], more?: [string, string[]][], age?: true }} Line
 * @typedef {{ lead: [string, string[]][], lines: Line[] }} Block
 */

/** @type {Block} */
const TABLE = {
  lead: [
    ["Count once every task has landed: a `test:<file>` row of an unlanded task reads as no gate.", [UNTRACKED]],
    ["A row the validator refuses makes the columns `?` until it is fixed, never a smaller number.", [REFUSED]],
    ["For any other, the first line of this table that holds decides:", [DUP, FIRST, ORDER]],
  ],
  lines: [
    { n: 1, when: [["`dupOf` is set", [DUP, NEW_CLASSES, RECURRING]], ["`outcome` is `refuted`", [DUP, DECLINED, NEW_CLASSES, RECURRING]]], then: "none", columns: [] },
    { n: 2, when: [["`source: brief`", [BRIEF]]], then: "none: its id is said under the block", columns: [] },
    { n: 3, when: [["`source: pre-existing`", [FIRST]]], then: "by age, below", columns: [], age: true },
    { n: 4, when: [["`caughtBy` is a gate", [FIRST, ORDER, UNTRACKED, FAILS]]], then: "gate-caught", columns: ["gateCaught"] },
    { n: 5, when: [["`source: previous-fix`", [ORDER]]], then: "fix-introduced", columns: ["fixIntroduced"] },
    { n: 6, when: [["`caughtBy: review`", [ORDER]]], then: "found in review", columns: ["foundInReview"] },
    { n: 7, when: [["any other row", [ORDER]]], then: "none: it stays in the ledger", columns: [] },
  ],
};

/** @type {Block} */
const AGE = {
  lead: [["(line 3), the first that holds:", [FIRST]]],
  lines: [
    {
      n: 1,
      when: [
        ["`bornIn` is null", [NULL_BORN]],
        ["not in HEAD's history", [NULL_BORN, REBASED]],
        ["the cycle's start was not noted", [NO_START]],
        ["is not an ancestor of HEAD", [NO_ANCESTOR, AMENDED]],
        ["HEAD holds no config", [NO_CONFIG]],
        ["the clone is shallow", [SHALLOW]],
        ["step 2's command exits other than 0", [PARTIAL]],
      ],
      then: "no age.",
      columns: [],
      more: [
        ["The row leaves the table here: pre-existing, gate-caught and both escaped columns read `?` until it is repaired.", [NULL_BORN]],
        ["A start given that names no commit or no ancestor reads as not noted, and the block prints with the reason under it.", [NO_ANCESTOR]],
      ],
    },
    {
      n: 2,
      when: [["`git ls-tree --full-tree --name-only <bornIn> -- .ennyn/config.json` prints nothing", [NO_TREE_CONFIG]]],
      then: "pre-existing.",
      columns: ["preExisting"],
      more: [["The tree held no config, read as not through the loop; a config moved in or committed late reads this way too.", [LATE]]],
    },
    { n: 3, when: [["`bornIn` is an ancestor of the cycle's start, the HEAD noted when the cycle began", [ANCESTOR, REPLACED]]], then: "escaped past commit old.", columns: ["escapedOld"] },
    { n: 4, when: [["Otherwise it is this cycle's code, already landed", [THIS_CYCLE, REPLACED, FAILS]]], then: "gate-caught if `caughtBy` is a gate, else escaped past commit new.", columns: ["gateCaught", "escapedNew"] },
  ],
};

/** Sentences, as method-walk.test.mjs splits them: after a full stop, before a capital. @param {string} text */
const sentences = (text) => text.split(/(?<=\.)\s+(?=[A-Z])/);

/**
 * A block of the text: the lead line's words after its bold, and the lines after it up to the next blank line
 * (blank lines between the lead and them skipped). A list goes on past a blank line, as CommonMark reads one,
 * when the next line is an item or indented: those lines are the list's too, the blank ones left out. `null`
 * when no line starts with the lead.
 * @param {string} text @param {string} lead @param {boolean} [list]
 */
function block(text, lead, list = false) {
  const all = text.split(/\r?\n/);
  const at = all.findIndex((l) => l.startsWith(lead));
  if (at < 0) return null;
  let i = at + 1;
  while (i < all.length && all[i].trim() === "") i++;
  const body = [];
  for (;;) {
    while (i < all.length && all[i].trim() !== "") body.push(all[i++]);
    let next = i;
    while (next < all.length && all[next].trim() === "") next++;
    if (!list || next >= all.length || !/^(?:\d+[.)] |\s)/.test(all[next])) break;
    i = next;
  }
  return { lead: all[at].slice(lead.length).trim(), body };
}

/**
 * The numbered lines of a block's body, as written: a table row `| n | when | then |` (the header and its rule
 * left out), or a list item `n. when: then. More.` Any other line is `unread`.
 * @param {string[]} body @param {"table" | "list"} kind
 */
function numbered(body, kind) {
  /** @type {{ n: number, when: string, then: string, more: string[] }[]} */
  const lines = [];
  const unread = [];
  for (const line of body) {
    if (kind === "table") {
      if (/^\| *# *\|/.test(line) || /^\|[-| :]+\|$/.test(line)) continue;
      const cells = /^\| (\d+) \| (.*) \|$/.exec(line)?.slice(1) ?? [];
      const [when, then, ...rest] = (cells[1] ?? "").split(" | ");
      if (cells.length && then !== undefined && rest.length === 0) lines.push({ n: Number(cells[0]), when, then, more: [] });
      else unread.push(line);
    } else {
      const item = /^(\d+)\. (.*)$/.exec(line);
      const [first, ...more] = sentences(item?.[2] ?? "");
      const colon = first.indexOf(": ");
      if (item && colon > 0) lines.push({ n: Number(item[1]), when: first.slice(0, colon), then: first.slice(colon + 2), more });
      else unread.push(line);
    }
  }
  return { lines, unread };
}

/**
 * What a row's condition text holds that the data's conditions leave, in order: between two conditions only
 * `, `, ` or ` or `, or ` may stand, and nothing before the first or after the last.
 * @param {string} text @param {string[]} conditions
 */
function unnamed(text, conditions) {
  const wrong = [];
  let at = 0;
  for (const [i, c] of conditions.entries()) {
    const found = text.indexOf(c, at);
    if (found < 0) {
      wrong.push(`a condition of the data the text lacks: ${c}`);
      continue;
    }
    const between = text.slice(at, found);
    if (i === 0 ? between !== "" : !/^(?:, |,? or )$/.test(between)) wrong.push(`a condition the data does not name: ${between}`);
    at = found + c.length;
  }
  if (at < text.length) wrong.push(`a condition the data does not name: ${text.slice(at)}`);
  return wrong;
}

/**
 * The lines a test's title names, by block: `line N`, `lines N to M`, after `by age` (any case) the list's, else the
 * table's. Only a title of the convergence sections, by its prefix before `: `, names them: elsewhere in
 * findings.test.mjs a line is the ledger's.
 * @param {string} title
 */
function named(title) {
  const colon = title.indexOf(": ");
  if (colon < 0 || !SECTIONS.includes(title.slice(0, colon))) return { table: [], list: [] };
  const age = title.search(/\bby age\b/i);
  const numbers = (/** @type {string} */ s) =>
    [...s.matchAll(/\blines? (\d+)(?: to (\d+))?/g)].flatMap((m) => {
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      return Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);
    });
  return age < 0 ? { table: numbers(title), list: [] } : { table: numbers(title.slice(0, age)), list: numbers(title.slice(age)) };
}

/**
 * Each top-level test's title in a test file, in any quotes, on the line of `test(` or the next; a backslash keeps
 * the character after it. A template's `${…}` stays as written.
 * @param {string} source
 */
const titles = (source) => [...source.matchAll(/^test\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1\s*,/gm)].map((m) => m[2].replace(/\\(.)/g, "$1"));

/**
 * What of the two blocks the data does not claim, what of the data they do not hold, and where the data and the
 * tests' titles part, one line each.
 * @param {string} text report-formats.md @param {string} source findings.test.mjs @param {Record<string, string>} labels
 * @param {{ table: Block, age: Block }} [data]
 */
function pointers(text, source, labels, data = { table: TABLE, age: AGE }) {
  const wrong = [];
  const known = new Set(titles(source));
  /** @type {Map<string, { table: Set<number>, list: Set<number> }>} */
  const ties = new Map();
  const tie = (/** @type {string[]} */ tests, /** @type {"table" | "list" | null} */ where, /** @type {number} */ n, /** @type {string} */ what) => {
    if (tests.length === 0) wrong.push(`no test runs it: ${what}`);
    for (const t of tests) {
      if (!known.has(t)) wrong.push(`a test the data names that ${TESTS} lacks: ${t}`);
      const seen = ties.get(t) ?? { table: new Set(), list: new Set() };
      if (where) seen[where].add(n);
      ties.set(t, seen);
    }
  };
  for (const [name, lead, kind, d] of /** @type {const} */ ([["table", TABLE_LEAD, "table", data.table], ["By age", AGE_LEAD, "list", data.age]])) {
    const got = block(text, lead, kind === "list");
    if (got === null) {
      wrong.push(`${FORMATS} has no line that starts with ${lead}`);
      continue;
    }
    const said = sentences(got.lead);
    const claimed = d.lead.map(([s]) => s);
    for (const s of said) if (!claimed.includes(s)) wrong.push(`${name}: a sentence of the lead the data does not claim: ${s}`);
    for (const s of claimed) if (!said.includes(s)) wrong.push(`${name}: a sentence of the data the lead lacks: ${s}`);
    for (const [s, tests] of d.lead) tie(tests, null, 0, `${name}'s lead: ${s}`);
    const { lines, unread } = numbered(got.body, kind);
    for (const line of unread) wrong.push(`${name}: a line the data cannot read: ${line}`);
    for (let i = 0; i < Math.max(lines.length, d.lines.length); i++) {
      const [p, w] = [lines[i], d.lines[i]];
      if (!w) {
        wrong.push(`${name}: a line the data lacks: ${p.n}`);
        continue;
      }
      if (!p) {
        wrong.push(`${name}: a line of the data the text lacks: ${w.n}`);
        continue;
      }
      if (p.n !== i + 1 || w.n !== p.n) wrong.push(`${name}: line ${i + 1} is numbered ${p.n} in the text and ${w.n} in the data`);
      for (const u of unnamed(p.when, w.when.map(([c]) => c))) wrong.push(`${name} line ${w.n}: ${u}`);
      if (p.then !== w.then) wrong.push(`${name} line ${w.n}: it gives "${p.then}" in the text and "${w.then}" in the data`);
      for (const key of w.columns) if (!labels[key] || !p.then.includes(labels[key])) wrong.push(`${name} line ${w.n}: it does not say the column ${key}`);
      const more = w.more ?? [];
      if (p.more.join("\n") !== more.map(([s]) => s).join("\n")) wrong.push(`${name} line ${w.n}: its sentences after the first are "${p.more.join(" ")}" in the text and "${more.map(([s]) => s).join(" ")}" in the data`);
      for (const [c, tests] of [...w.when, ...more]) tie(tests, kind, w.n, `${name} line ${w.n}: ${c}`);
    }
  }
  // The row that sends to By age is the line By age's lead names.
  const sends = data.table.lines.filter((l) => l.age).map((l) => l.n);
  const lead = block(text, AGE_LEAD)?.lead ?? "";
  const back = /^\(line (\d+)\)/.exec(lead)?.[1];
  if (sends.length !== 1 || String(sends[0]) !== back) wrong.push(`By age's lead names line ${back ?? "none"}, and the data sends to it from ${sends.join(", ") || "no line"}`);
  // Every column is a line's, as the command names it.
  for (const key of COLUMNS) if (![data.table, data.age].some((d) => d.lines.some((l) => l.columns.includes(key)))) wrong.push(`a column no line gives: ${key}`);
  // The tests: each walk test is claimed, and every title of the file or the data that names lines (a title of the
  // convergence sections) is tied to those lines, no other.
  for (const t of known) if (t.startsWith(WALK) && !ties.has(t)) wrong.push(`a walk test no line claims: ${t}`);
  for (const t of new Set([...known, ...ties.keys()])) {
    const seen = ties.get(t) ?? { table: new Set(), list: new Set() };
    const says = named(t);
    for (const where of /** @type {const} */ (["table", "list"])) {
      const want = [...says[where]].sort((a, b) => a - b).join(", ");
      const have = [...seen[where]].sort((a, b) => a - b).join(", ");
      if (says[where].length && want !== have) wrong.push(`"${t}" names ${where} line ${want}, and the data ties it to ${have || "none"}`);
      if (!says[where].length && have && says.table.length + says.list.length) wrong.push(`"${t}" names no ${where} line, and the data ties it to ${have}`);
    }
  }
  for (const [where, d] of /** @type {const} */ ([["table", data.table], ["list", data.age]])) {
    for (const l of d.lines) if (![...ties].some(([t, seen]) => seen[where].has(l.n) && named(t)[where].includes(l.n))) wrong.push(`${where} line ${l.n}: no test the data ties to it names it`);
  }
  return wrong;
}

const read = (/** @type {string} */ path) => readFileSync(join(ROOT, path), "utf8");
const catalog = /** @type {Record<string, string>} */ (JSON.parse(read("i18n/en.json")));
const LABELS = Object.fromEntries(COLUMNS.map((key) => [key, catalog[`convergence.${key}`]]));

test("report formats walk: every line of the convergence table and of By age is claimed by the data, each condition tied to the findings tests that run it", (t) => {
  for (const key of COLUMNS) assert.ok(LABELS[key], `i18n/en.json has no label for ${key}`);
  const wrong = pointers(read(FORMATS), read(TESTS), LABELS);
  for (const w of wrong) t.diagnostic(w);
  assert.equal(wrong.length, 0, `${wrong.length} line(s) part; the first: ${wrong[0]}`);
});

test("report formats walk pointer control: a row, a condition or a column changed, a line renumbered, a test renamed or unclaimed are each reported", () => {
  const text = read(FORMATS);
  const source = read(TESTS);
  const says = (/** @type {string} */ t = text, /** @type {string} */ s = source, data = { table: TABLE, age: AGE }) => pointers(t, s, LABELS, data);
  const has = (/** @type {string[]} */ got, /** @type {string} */ start) => got.some((w) => w.startsWith(start));
  assert.deepEqual(says(), []);
  // A checkout with CRLF line ends reads the same.
  assert.deepEqual(says(text.replace(/\n/g, "\r\n")), []);
  // A row added, a row dropped.
  assert.ok(has(says(text.replace("| 7 | any other row |", "| 7 | `caughtBy: measurement` | none |\n| 8 | any other row |")), "table: a line the data lacks: 8"));
  assert.ok(has(says(text.replace(/\| 7 \| any other row \|.*\n/, "")), "table: a line of the data the text lacks: 7"));
  // A condition added to a row, one reworded, one dropped.
  assert.ok(says(text.replace("the clone is shallow, or", "the clone is shallow, the repository is a worktree, or")).includes("By age line 1: a condition the data does not name: , the repository is a worktree, or "));
  assert.ok(says(text.replace("| `dupOf` is set, or", "| `dupOf` is set, `round` is 0, or")).includes("table line 1: a condition the data does not name: , `round` is 0, or "));
  assert.ok(says(text.replace("HEAD holds no config,", "HEAD holds no config file,")).includes("By age line 1: a condition the data does not name:  file, "));
  assert.ok(says(text.replace("| `caughtBy: review` |", "| `caughtBy: review`, or `caughtBy: measurement` |")).includes("table line 6: a condition the data does not name: , or `caughtBy: measurement`"));
  assert.ok(says(text.replace(" or `outcome` is `refuted`", "")).includes("table line 1: a condition of the data the text lacks: `outcome` is `refuted`"));
  // An item whose condition has no colon after it cannot be read: its words are no condition and no column.
  assert.ok(has(says(text.replace("the HEAD noted when the cycle began: escaped", "the HEAD noted when the cycle began, escaped")), "By age: a line the data cannot read: 3. `bornIn` is an ancestor"));
  assert.ok(says(text.replace("`bornIn` is null or not in HEAD's history", "`bornIn` is null and not in HEAD's history")).includes("By age line 1: a condition the data does not name:  and "));
  // A column changed, a column word the command does not print.
  assert.ok(says(text.replace("| `source: previous-fix` | fix-introduced |", "| `source: previous-fix` | found in review |")).includes('table line 5: it gives "found in review" in the text and "fix-introduced" in the data'));
  const lines = (/** @type {Line[]} */ ls, /** @type {number} */ n, /** @type {Partial<Line>} */ over) => ls.map((l) => (l.n === n ? { ...l, ...over } : l));
  assert.ok(says(text, source, { table: { ...TABLE, lines: lines(TABLE.lines, 5, { columns: ["foundInReview"] }) }, age: AGE }).includes("table line 5: it does not say the column foundInReview"));
  assert.ok(says(text, source, { table: { ...TABLE, lines: TABLE.lines.map((l) => ({ ...l, columns: l.columns.filter((c) => c !== "fixIntroduced") })) }, age: AGE }).includes("a column no line gives: fixIntroduced"));
  // Lines swapped or renumbered; a sentence added after an item's first; a lead sentence added.
  assert.ok(has(says(text.replace("| 5 | `source: previous-fix` |", "| 9 | `source: previous-fix` |")), "table: line 5 is numbered 9 in the text and 5 in the data"));
  assert.ok(has(says(text.replace("escaped past commit old.\n", "escaped past commit old. A tag counts as a start.\n")), "By age line 3: its sentences after the first are"));
  assert.ok(has(says(text.replace("For any other, the first line", "Rows of a stopped task count too. For any other, the first line")), "table: a sentence of the lead the data does not claim: Rows of a stopped task"));
  assert.ok(has(says(text.replace("|---|---|---|\n| 1 |", "|---|---|---|\n| 1 | a | b | c |\n| 1 |")), "table: a line the data cannot read"));
  assert.ok(has(says(text.replace("**By age** (line 3)", "**By age** (line 4)")), "By age's lead names line 4, and the data sends to it from 3"));
  assert.ok(has(says(text.replace(TABLE_LEAD, "**One row.**")), `${FORMATS} has no line that starts with ${TABLE_LEAD}`));
  // A test renamed, a test the data names gone, a walk test no line claims, a title's line not the data's.
  assert.ok(has(says(text, source.replace(`test("${ORDER}"`, `test("${ORDER} and more"`)), `a test the data names that ${TESTS} lacks: ${ORDER}`));
  assert.ok(has(says(text, `${source}\ntest("${WALK}line 8: a new row", () => {});\n`), `a walk test no line claims: ${WALK}line 8`));
  const renamed = ORDER.replace("lines 4 to 7", "lines 4 to 6");
  assert.ok(says(text, source.replace(`test("${ORDER}"`, `test("${renamed}"`), { table: { ...TABLE, lines: TABLE.lines.map((l) => ({ ...l, when: l.when.map(([c, ts]) => /** @type {[string, string[]]} */ ([c, ts.map((t) => (t === ORDER ? renamed : t))])) })) }, age: AGE }).includes(`"${renamed}" names table line 4, 5, 6, and the data ties it to 4, 5, 6, 7`));
  assert.ok(has(says(text, source, { table: { ...TABLE, lines: lines(TABLE.lines, 6, { when: [["`caughtBy: review`", [REFUSED]]] }) }, age: AGE }), `"${ORDER}" names table line 4, 5, 6, 7, and the data ties it to 4, 5, 7`));
  assert.ok(says(text, source, { table: { ...TABLE, lines: lines(TABLE.lines, 6, { when: [["`caughtBy: review`", [REFUSED]]] }) }, age: AGE }).includes("table line 6: no test the data ties to it names it"));
  assert.ok(says(text, source, { table: TABLE, age: { ...AGE, lines: lines(AGE.lines, 3, { when: [[AGE.lines[2].when[0][0], [ANCESTOR, THIS_CYCLE]]] }) } }).includes(`"${THIS_CYCLE}" names list line 4, and the data ties it to 3, 4`));
  assert.ok(says(text, source, { table: { ...TABLE, lines: lines(TABLE.lines, 2, { when: [["`source: brief`", [BRIEF, NULL_BORN]]] }) }, age: AGE }).includes(`"${NULL_BORN}" names no table line, and the data ties it to 2`));
  assert.ok(says(text, source, { table: { ...TABLE, lines: lines(TABLE.lines, 7, { when: [["any other row", []]] }) }, age: AGE }).includes("no test runs it: table line 7: any other row"));
  // Review round one: the list goes on past a blank line, as CommonMark reads it: an item after one is read, an
  // indented paragraph is a line the data cannot read, and a blank line between two items changes nothing.
  const tail = "else escaped past commit new.\n";
  assert.ok(has(says(text.replace(tail, `${tail}\n5. \`caughtBy\` is \`measurement\`: found in review.\n`)), "By age: a line the data lacks: 5"));
  assert.ok(has(says(text.replace(tail, `${tail}\n   A row of a reverted commit is escaped past commit old.\n`)), "By age: a line the data cannot read:    A row of a reverted"));
  assert.ok(has(says(text.replace(tail, `${tail}\n\n6) A row of a reverted commit is old.\n`)), "By age: a line the data cannot read: 6) A row"));
  assert.deepEqual(says(text.replace("too.\n3. `bornIn`", "too.\n\n3. `bornIn`")), []);
  // Review round one: every title of the file that names a line is held to the data, whatever its prefix or quotes.
  const before = `test("${ORDER}"`;
  for (const q of ["'", "`"]) assert.ok(has(says(text, source.replace(before, `test(${q}${WALK}line 8: a new row${q}, () => {});\n\n${before}`)), `a walk test no line claims: ${WALK}line 8`));
  assert.ok(has(says(text, source.replace(before, `test(\n  "${WALK}line 8: a new row",\n  () => {},\n);\n\n${before}`)), `a walk test no line claims: ${WALK}line 8`));
  assert.ok(says(text, source.replace(before, `test("convergence: line 8: a new row", () => {});\n\n${before}`)).includes('"convergence: line 8: a new row" names table line 8, and the data ties it to none'));
  const moved = NEW_CLASSES.replace("line 1 as", "line 5 as");
  const tied = { table: { ...TABLE, lines: TABLE.lines.map((l) => ({ ...l, when: l.when.map(([c, ts]) => /** @type {[string, string[]]} */ ([c, ts.filter((t) => t !== NEW_CLASSES)])) })) }, age: AGE };
  assert.ok(says(text, source.replace(NEW_CLASSES, moved), tied).includes(`"${moved}" names table line 5, and the data ties it to none`));
  // Review round two: only a title of the convergence sections names the table's lines; elsewhere a line is the
  // ledger's. Inside one, By age is named in any case, with or without its comma.
  for (const title of ["findings: a refused row names its line 3 in the ledger", "findings ledger: line 2 of a ledger is read"]) assert.deepEqual(says(text, source.replace(before, `test("${title}", () => {});\n\n${before}`)), [], title);
  assert.ok(says(text, source.replace(before, `test("${WALK}By age line 9: a new item", () => {});\n\n${before}`)).includes(`"${WALK}By age line 9: a new item" names list line 9, and the data ties it to none`));
  assert.ok(says(text, source.replace(before, `test("recurring class: line 6 leaves a row", () => {});\n\n${before}`)).includes('"recurring class: line 6 leaves a row" names table line 6, and the data ties it to none'));
  // Titles as the reader takes them.
  assert.deepEqual(named(ORDER), { table: [4, 5, 6, 7], list: [] });
  assert.deepEqual(named(FIRST), { table: [3, 4], list: [] });
  assert.deepEqual(named(NULL_BORN), { table: [], list: [1] });
  assert.deepEqual(named("convergence: by age line 2 and table line 3"), { table: [], list: [2, 3] });
  assert.deepEqual(named("convergence: line 3, then by age line 2"), { table: [3], list: [2] });
  assert.deepEqual(named("findings: its line 3"), { table: [], list: [] });
  assert.deepEqual(named("convergence table line 3"), { table: [], list: [] });
  assert.deepEqual(titles('test("a \\"quoted\\" one", () => {});\n  test("nested", () => {});\ntest("b", () => {});'), ['a "quoted" one', "b"]);
  assert.deepEqual(titles("test('it\\'s', () => {});\ntest(`a ${x}`, () => {});\ntest(\n  \"wrapped\",\n  () => {},\n);"), ["it's", "a ${x}", "wrapped"]);
});
