/**
 * A number that docs/evidence.md or the skill text gives as evidence names where it was read, and this test
 * reads that place (graph node cited-number-check, class claim-outruns-evidence).
 *
 * The unit is a paragraph, a list item with its continuation lines, or one table row; fenced code, headings and
 * HTML comments are none. A unit that opens with "Source:" or "Sources:" is a Source line: its pointers count for
 * the units after it in its section (a heading to the next heading of any level), up to the next Source line.
 *
 * An evidence number, read with code spans, link targets, URLs and citations taken out: a percentage (N%, N
 * percent), a ratio N/M (not a pair of years), N of M (also N <plural or ONE> of M, N <…> out of M), a multiplier
 * N×, or a count: N, N-M or NK followed, directly or after one lower-case word, by a word of COUNTED. The lists
 * are closed: what they do not name is not read. Not read: a count in words ("eight", "twice", "half"), a decimal
 * with another unit ("1.98 bytes per token", "96.7 to 82.5"), a correlation ("ρ=+0.14"), N <singular word not in
 * ONE> of M, commit bodies.
 *
 * A pointer:
 * - a citation, for a source outside the repository, checked only for being there: a parenthesised group with
 *   a year and a word of three or more letters that is no month, a parenthesised group naming a cycle, an arXiv
 *   id, an issue reference (name#N) or a URL. Its words are not judged: "(we saw it in 2026)" passes.
 * - after a marker ("(source:", "; source:" or ", source:" in a sentence, or a Source line), code spans:
 *   - places, read: `path:N` or `path:N-M` (the lines exist), `path#anchor` (a heading with that slug), `path`
 *     (the file). The scan reads the place as it reads a unit; a number is held when the place has one of the
 *     same rule, the same values in the same order and, for a count, the same counted word ("21 (66%)" holds
 *     66%, not 21%; "18 of the 38" holds "18 of 38"). A count may stand in a line, a section or a file; a
 *     percentage, ratio, multiplier or N of M only in a line pointer's lines. The numbers of a unit that rest
 *     on places stand there in the unit's order, the places read in the order their pointers are written: a
 *     swapped pair or a value the place gives earlier, for another claim, fails;
 *   - names, resolved: `path` "name" (the file holds the name: a test or a cell);
 *   - commands, resolved but never run, so a citation: `ennyn <command>`, `node scripts/ennyn.mjs <command>`,
 *     `node <path>`, `npm run <script>`, `npm test` (each exists), `git <read-only command> … <revision>`.
 *   A marker that names nothing, or a span after it that resolves to nothing, fails.
 * A number is covered by a citation in its own sentence (or table cell), by a name or a command of its unit, or
 * by a citation, name or command of the Source line above it; else it stands as written in the text a place
 * pointer of its unit or of that Source line names.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Numbers that stand without a source, each with why, by place: the number inside the words `at` names, which
 * the file holds once. Another place of the same number is read as any other. An entry that matches no number,
 * or whose words the file holds other than once, fails: the list holds only what the scan uses.
 * @type {{ file: string, at: string, number: string, why: string }[]}
 */
const ALLOW = [
  { file: "plugin/skills/init/SKILL.md", at: "a security audit every 3 cycles", number: "3 cycles", why: "a default the setup step proposes (security.everyCycles), not a measurement" },
  { file: "plugin/skills/init/SKILL.md", at: "refused under 1% of its package's", number: "1%", why: "a default the setup step proposes (security.deps.minShare), not a measurement" },
  { file: "plugin/skills/init/graph.md", at: "5 to 15 open nodes", number: "15 open nodes", why: "a size the first graph aims at, not a measurement" },
  { file: "plugin/skills/cycle/task-brief.md", at: "a reported 0 of 8 was 4 of 8 on a rerun", number: "0 of 8", why: "a rerun's count first written in 084171f (2026-10-31); no record in the repository holds it" },
  { file: "plugin/skills/cycle/task-brief.md", at: "a reported 0 of 8 was 4 of 8 on a rerun", number: "4 of 8", why: "the same rerun as 0 of 8" },
  { file: "plugin/skills/cycle/task-brief.md", at: "at most 10 minutes in Claude Code 2.1.310", number: "10 minutes", why: "a limit of another program read in its version: the sibling node measured-claim-names-cell's" },
  { file: "plugin/skills/cycle/task-brief.md", at: "came back rejected 10 minutes after", number: "10 minutes", why: "cycle 36's loss, which the sentence names; the sentence is pinned word for word by test/plugin.test.mjs" },
  { file: "plugin/skills/cycle/task-brief.md", at: "stopped writing about 10 minutes after", number: "10 minutes", why: "cycle 36's other loss; the sentence is pinned word for word by test/plugin.test.mjs" },
  { file: "plugin/skills/cycle/task-brief.md", at: "each under 10 minutes and bounded", number: "10 minutes", why: "a bound the rule sets, not a measurement" },
  { file: "plugin/skills/cycle/task-brief.md", at: "no new line for 30 minutes", number: "30 minutes", why: "a bound the rule sets, not a measurement" },
  { file: "plugin/skills/cycle/task-brief.md", at: "run open 47 minutes", number: "47 minutes", why: "a run behind node cycle-wake-lock; no file in the repository holds the count, and test/plugin.test.mjs pins the sentence word for word" },
  { file: "plugin/skills/cycle/task-brief.md", at: "258K to 540K tokens", number: "540K tokens", why: "cycles 16 to 19, which the sentence names; test/method-walk.test.mjs pins it word for word" },
  { file: "plugin/skills/init/new-project.md", at: "after 60 s, 5 min or 10 min", number: "5 min", why: "a setting's values in Claude Code 2.1.310, not a measurement" },
  { file: "plugin/skills/init/new-project.md", at: "after 60 s, 5 min or 10 min", number: "10 min", why: "a setting's values in Claude Code 2.1.310, not a measurement" },
];

const COUNTED = "rows|runs|cells|findings|defects|commits|tasks|sessions|cases|turns|entries|hits|messages|cycles|rounds|lines|tests|nodes|inspections|repositories|sources|claims|mutants|studies|reviews|proposals|files|tokens|agents|escapes|minutes|min";
/** A counted thing named in the singular, between N and "of" ("1 run of 3"). */
const ONE = "row|run|cell|finding|defect|commit|task|session|case|turn|entry|hit|message|cycle|round|line|test|node|file|agent|escape|mutant";
const N = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/** What counts as an evidence number; each rule a name for the corpus and the report. */
const NUMBER_RULES = [
  { rule: "percentage", re: new RegExp(String.raw`(?<![\w.,])(?:${N})(?:\s?[-–]\s?(?:${N}))?(?:\s?%|\s?percent\b)`, "g") },
  { rule: "ratio", re: new RegExp(String.raw`(?<![\w.,/-])(?:${N})\s?/\s?(?:${N})(?![\w/-]|\.\d)`, "g") },
  { rule: "of", re: new RegExp(String.raw`(?<![\w.,-])(?:${N})\s+(?:(?:[a-z]+s|${ONE})\s+)?(?:out\s+)?of\s+(?:the\s+)?(?:${N})(?![\w-]|\.\d)`, "g") },
  { rule: "multiplier", re: new RegExp(String.raw`(?<![\w.,])(?:${N})(?:\s?[-–]\s?(?:${N}))?\s?×`, "g") },
  { rule: "count", re: new RegExp(String.raw`(?<![\w.,-])(?:${N})(?:[-–](?:${N}))?K?\s+(?:[a-z-]+\s+)?(?:${COUNTED})\b`, "g") },
];
const YEAR = /\b(?:19|20)\d\d\b/;
const MONTH = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/;
const PAREN = /\((?:[^()]|\([^()]*\))*\)/g;
const SPAN = /`[^`\n]+`/g;
const LINK = /\]\([^)\n]*\)/g;
const URL = /<?https?:\/\/[^\s)>]+>?/g;
const ARXIV = /\barXiv:?\s?\d{4}\.\d{4,5}\b/g;
const ISSUE = /(?<![\w/#.-])[A-Za-z][\w.-]*(?:\/[\w.-]+)?#\d+\b/g;
/** A source marker: "(source:", "; source:" or ", source:" inside a sentence, or "Source:" opening a unit. */
const MARKER = /(?<=\(\s*)[Ss]ources?:|(?<=[;,]\s)[Ss]ources?:|^\s*Sources?:/g;

const GIT_READS = ["log", "show", "ls-tree", "blame", "rev-list", "diff", "cat-file"];
/** @typedef {{ name: string, line: boolean, keys: string[] }} Place a place pointer: its span, whether it names lines, the numbers there in order */
/** A text of the same length with every character but line ends blank. @param {string} s */
const blank = (s) => s.replace(/[^\n]/g, " ");
/** Code spans blanked, so the rest keeps its places. @param {string} text */
const mask = (text) => text.replace(SPAN, blank);

/**
 * Whether a parenthesised group (with its parentheses) names a source outside the repository.
 * @param {string} group
 */
function citationGroup(group) {
  const inner = group.slice(1, -1);
  if (/\bcycles? \d/.test(inner)) return true;
  if (!YEAR.test(inner)) return false;
  return (inner.match(/[A-Za-z][A-Za-z'’-]{2,}/g) ?? []).some((w) => !MONTH.test(w));
}

/**
 * Where a unit's citations stand, code spans and link targets left out (a URL counts in either).
 * @param {string} text
 * @returns {{ at: number, end: number }[]}
 */
function citations(text) {
  const plain = mask(text).replace(LINK, (l) => `]${blank(l.slice(1))}`);
  const at = (/** @type {RegExpMatchArray} */ m) => ({ at: /** @type {number} */ (m.index), end: /** @type {number} */ (m.index) + m[0].length });
  return [...[...plain.matchAll(PAREN)].filter((m) => citationGroup(m[0])), ...text.matchAll(URL), ...plain.matchAll(ARXIV), ...plain.matchAll(ISSUE)].map(at);
}

/**
 * The sentences of a unit, as places: a sentence ends at ".", "?" or "!" before a space or the end, and a table
 * cell at "|", outside code spans and parentheses.
 * @param {string} text
 * @returns {{ at: number, end: number }[]}
 */
function sentences(text) {
  const masked = mask(text);
  const out = [];
  let from = 0;
  for (let i = 0, depth = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0 && (c === "|" || (/[.?!]/.test(c) && /^\s?$/.test(masked.slice(i + 1, i + 2))))) {
      out.push({ at: from, end: i + 1 });
      from = i + 1;
    }
  }
  out.push({ at: from, end: masked.length });
  return out;
}

/**
 * The evidence numbers a unit's text holds, each with its place in the text.
 * @param {string} text
 * @returns {{ rule: string, text: string, at: number, end: number }[]}
 */
function numbersIn(text) {
  const plain = mask(text)
    .replace(LINK, (l) => `]${blank(l.slice(1))}`)
    .replace(URL, blank)
    .replace(PAREN, (g) => (citationGroup(g) ? blank(g) : g))
    .replace(ARXIV, blank)
    .replace(ISSUE, blank);
  /** @type {{ rule: string, text: string, at: number, end: number }[]} */
  const found = [];
  for (const { rule, re } of NUMBER_RULES) {
    for (const m of plain.matchAll(re)) {
      const [at, end] = [/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length];
      if (rule === "ratio" && m[0].split("/").every((n) => /^\s*(?:19|20)\d\d\s*$/.test(n))) continue;
      // One place, one number: a span another rule already took is not counted again.
      if (found.some((f) => at < f.end && f.at < end)) continue;
      found.push({ rule, text: m[0].replace(/\s+/g, " "), at, end });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * The units of a markdown text.
 * @param {string} text
 * @returns {{ line: number, text: string, section: number, lead: boolean }[]}
 */
function units(text) {
  /** @type {{ line: number, text: string, section: number, lead: boolean }[]} */
  const out = [];
  /** @type {{ line: number, text: string, section: number, lead: boolean } | null} */
  let cur = null;
  let section = 0;
  let fence = "";
  let comment = false;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line, i) => {
      const f = /^ *(```|~~~)/.exec(line)?.[1];
      if (fence) {
        if (f === fence) fence = "";
        return;
      }
      if (f) return flush(), void (fence = f);
      if (comment) {
        if (line.includes("-->")) comment = false;
        return;
      }
      if (/^\s*<!--/.test(line)) return flush(), void (comment = !line.includes("-->"));
      if (/^#{1,6} /.test(line)) return flush(), void section++;
      if (!line.trim()) return flush();
      const unit = { line: i + 1, text: line, section, lead: false };
      // A table row is a unit of its own; a separator row holds nothing the scan reads.
      if (/^\s*\|/.test(line)) return flush(), void out.push(unit);
      if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) return flush(), void (cur = unit);
      if (cur) cur.text += `\n${line}`;
      else cur = unit;
    });
  flush();
  for (const u of out) u.lead = /^Sources?:/.test(u.text.trim());
  return out;
}

/** @param {string} n */
const norm = (n) => n.replace(/,(?=\d{3}(?!\d))/g, "");
/**
 * A number as the comparison reads it: its rule, its values in order and, for a count, what it counts. "21 (66%)"
 * holds 66% and no 21%; "18 of the 38" is "18 of 38"; "5,593 lines" is "5593 lines".
 * @param {{ rule: string, text: string }} n
 */
const key = (n) => `${n.rule}:${(n.text.match(/\d+(?:[.,]\d+)*K?/g) ?? []).map(norm).join(",")}${n.rule === "count" ? `:${n.text.split(" ").at(-1)}` : ""}`;

/** A heading's anchor as GitHub writes it. @param {string} heading */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

/**
 * The text a markdown section holds, from its heading to the next heading of the same or a higher level.
 * @param {string} text @param {string} anchor
 */
function sectionText(text, anchor) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => {
    const h = /^(#{1,6}) (.*)$/.exec(l);
    return h !== null && slug(h[2]) === anchor;
  });
  if (at < 0) return null;
  const level = /** @type {RegExpExecArray} */ (/^(#{1,6}) /.exec(lines[at]))[1].length;
  const end = lines.findIndex((l, i) => i > at && /^(#{1,6}) /.test(l) && /** @type {RegExpExecArray} */ (/^(#{1,6}) /.exec(l))[1].length <= level);
  return lines.slice(at, end < 0 ? lines.length : end).join("\n");
}

/**
 * A repository file a pointer names, or why it names none.
 * @param {string} root @param {string} path
 */
function fileAt(root, path) {
  if (path.startsWith("/") || path.split("/").includes("..")) return { why: `${path} is not a path in the repository` };
  const full = join(root, path);
  if (!existsSync(full) || !statSync(full).isFile()) return { why: `${path} does not exist` };
  return { text: readFileSync(full, "utf8") };
}

/**
 * Resolve one code span after a source marker: a place (its text), a name or command (covers), or why it
 * names nothing.
 * @param {string} root @param {string} span @param {string} after the text after the span
 * @returns {{ place?: string, line?: boolean, covers?: boolean, why?: string }}
 */
function resolve(root, span, after) {
  const line = /^([\w./-]+):(\d+)(?:-(\d+))?$/.exec(span);
  if (line) {
    const f = fileAt(root, line[1]);
    if (!f.text) return { why: f.why };
    const all = f.text.replace(/\r\n/g, "\n").split("\n");
    const [from, to] = [Number(line[2]), Number(line[3] ?? line[2])];
    if (from < 1 || to < from || to > all.length) return { why: `${span}: ${line[1]} has ${all.length} lines` };
    return { place: all.slice(from - 1, to).join("\n"), line: true };
  }
  const command = /^(ennyn|node|npm|git)(?:\s+(\S+))?(?:\s+(\S+))?/.exec(span);
  if (command) {
    const [, program, first, second] = command;
    // A command is not run (a copy without history could not): it names where the number is read, a citation.
    // A git command names a read-only subcommand and the revision it reads.
    if (program === "git") return GIT_READS.includes(first ?? "") && /\b[0-9a-f]{7,40}\b/.test(span) ? { covers: true } : { why: `${span}: a git pointer names a read-only command (${GIT_READS.join(", ")}) and a revision` };
    const cli = (/** @type {string | undefined} */ sub) => {
      const f = fileAt(root, "plugin/scripts/ennyn.mjs");
      return !!(sub && f.text && new RegExp(`^  (?:async )?"?${sub.replace(/[^a-z-]/g, "")}"?\\(`, "m").test(f.text));
    };
    if (program === "ennyn") return cli(first) ? { covers: true } : { why: `${span}: no such ennyn command` };
    if (program === "node" && (first === "scripts/ennyn.mjs" || first === "plugin/scripts/ennyn.mjs")) return cli(second) ? { covers: true } : { why: `${span}: no such ennyn command` };
    if (program === "node") return first && fileAt(root, first).text !== undefined ? { covers: true } : { why: `${span}: no such script` };
    const pkg = fileAt(root, "package.json");
    const scripts = pkg.text ? JSON.parse(pkg.text).scripts ?? {} : {};
    const script = first === "run" ? second : first;
    return script && Object.hasOwn(scripts, script) ? { covers: true } : { why: `${span}: no such npm script` };
  }
  const file = /^([\w./-]*[./][\w./-]*?)(?:#([\w-]+))?$/.exec(span);
  if (file) {
    const f = fileAt(root, file[1]);
    if (f.text === undefined) return { why: f.why };
    const name = /^\s*"([^"\n]+)"/.exec(after);
    if (name) return f.text.includes(name[1]) ? { covers: true } : { why: `${file[1]} holds no "${name[1]}"` };
    if (!file[2]) return { place: f.text };
    const section = sectionText(f.text, file[2]);
    return section === null ? { why: `${span}: no heading has that anchor` } : { place: section };
  }
  return { why: `\`${span}\` is no pointer the test can read` };
}

/**
 * The pointers after each source marker of a unit.
 * @param {string} root @param {string} text
 * @returns {{ places: Place[], covers: boolean, problems: string[] }}
 */
function marked(root, text) {
  const masked = mask(text);
  /** @type {{ places: Place[], covers: boolean, problems: string[] }} */
  const out = { places: [], covers: false, problems: [] };
  for (const m of masked.matchAll(MARKER)) {
    // The marker's list ends at a parenthesis it did not open, at a sentence's end or at the unit's end.
    let end = m.index + m[0].length;
    for (let depth = 0; end < masked.length; end++) {
      const c = masked[end];
      if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) break;
      else if (c === "." && depth === 0 && /^\.(?:\s|$)/.test(masked.slice(end, end + 2))) break;
    }
    const list = text.slice(m.index + m[0].length, end);
    const spans = [...list.matchAll(SPAN)];
    if (spans.length === 0 && citations(list).length === 0) out.problems.push(`"${m[0]}" names nothing the test can read`);
    for (const s of spans) {
      const got = resolve(root, s[0].slice(1, -1), list.slice(/** @type {number} */ (s.index) + s[0].length));
      if (got.why) out.problems.push(got.why);
      if (got.place !== undefined) out.places.push({ name: s[0].slice(1, -1), line: !!got.line, keys: numbersIn(got.place).map(key) });
      if (got.covers) out.covers = true;
    }
  }
  return out;
}

/**
 * Every number without a source the test can read, in the given files of a root.
 * @param {string} root @param {string[]} files @param {{ file: string, at: string, number: string }[]} allow
 */
function check(root, files, allow = []) {
  /** @type {string[]} */
  const problems = [];
  const used = new Set();
  for (const file of files) {
    const all = units(readFileSync(join(root, file), "utf8"));
    const read = new Map(all.map((u) => [u, { ...marked(root, u.text), cited: citations(u.text) }]));
    all.forEach((u, i) => {
      const own = /** @type {{ places: Place[], covers: boolean, problems: string[], cited: { at: number, end: number }[] }} */ (read.get(u));
      for (const p of own.problems) problems.push(`${file}:${u.line}: ${p}`);
      // A Source line covers the units after it in its section, up to the next one.
      const lead = all.slice(0, i).findLast((l) => l.lead && l.section === u.section);
      const theirs = lead ? read.get(lead) : undefined;
      // A name or a command covers its unit, a lead's citation its section, a citation its own sentence.
      const covered = own.covers || !!(theirs && (theirs.cited.length > 0 || theirs.covers));
      const places = [...own.places, ...(theirs?.places ?? [])];
      // The places' numbers in pointer order; the unit's numbers that rest on them must stand there in its order.
      const held = places.flatMap((p) => p.keys.map((k) => ({ k, line: p.line })));
      const names = places.map((p) => p.name).join(", ");
      let from = 0;
      const said = sentences(u.text);
      for (const n of numbersIn(u.text)) {
        const allowed = allow.find((a) => {
          const at = a.file === file ? u.text.indexOf(a.at) : -1;
          return at >= 0 && a.number === n.text && at <= n.at && n.end <= at + a.at.length;
        });
        if (allowed) {
          used.add(allowed);
          continue;
        }
        if (covered) continue;
        const sentence = said.find((x) => x.at <= n.at && n.at < x.end);
        if (sentence && own.cited.some((c) => sentence.at <= c.at && c.at < sentence.end)) continue;
        if (places.length === 0) {
          problems.push(`${file}:${u.line}: "${n.text}" (${n.rule}) names no source`);
          continue;
        }
        // A count is held by a line, a section or a file; any other number by a line pointer only.
        const at = held.findIndex((h, j) => j >= from && h.k === key(n) && (h.line || n.rule === "count"));
        if (at >= 0) from = at + 1;
        else problems.push(`${file}:${u.line}: "${n.text}" (${n.rule}) is not, as written and in order, in ${names}: a percentage, ratio, multiplier or N of M is held by a line pointer only`);
      }
    });
  }
  for (const a of allow) {
    const text = files.includes(a.file) ? readFileSync(join(root, a.file), "utf8") : "";
    if (text.split(a.at).length !== 2) problems.push(`${a.file}: the allowed place "${a.at}" is there ${text.split(a.at).length - 1} times, not once`);
    else if (!used.has(a)) problems.push(`${a.file}: the allowed "${a.number}" is no number there any more`);
  }
  return problems;
}

/** The files the gate reads: docs/evidence.md and every markdown file under plugin/skills/. @param {string} root */
function scope(root) {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".md") ? [`${dir}/${e.name}`] : []));
  return ["docs/evidence.md", ...walk("plugin/skills").sort()];
}

test("cited numbers: every evidence number in docs/evidence.md and the skills names a source the test reads", (t) => {
  const files = scope(ROOT);
  assert.ok(files.includes("plugin/skills/cycle/SKILL.md") && files.includes("plugin/skills/init/SKILL.md") && files.length > 10, `the scope read ${files.length} files`);
  const problems = check(ROOT, files, ALLOW);
  for (const p of problems) t.diagnostic(p);
  assert.equal(problems.length, 0, `${problems.length} numbers or pointers fail: the diagnostics name each`);
});

test("cited numbers: what counts as an evidence number", () => {
  /** @type {[string, string[]][]} */
  const accept = [
    ["the prompts asked it in 57% of reviews", ["57%"]],
    ["links were 60-67% precise", ["60-67%"]],
    ["a pass rate of 87/90 against 86/90", ["87/90", "86/90"]],
    ["1,149 of 1,371 subagents ran on the parent's", ["1,149 of 1,371"]],
    ["done 8 times out of 11", ["8 times out of 11"]],
    ["October was 3.07× slower, 4-5× at all thresholds", ["3.07×", "4-5×"]],
    ["a ledger of 539 rows", ["539 rows"]],
    ["ran for nearly 700 sessions in 21 cycles", ["700 sessions", "21 cycles"]],
    ["in the 9 commits since the rewrite", ["9 commits"]],
    ["done within 1-4 cycles", ["1-4 cycles"]],
    ["| Review agents | 263 (49%) |", ["49%"]],
    ["the median was 72 min (n=62) with a 12.7% saving", ["72 min", "12.7%"]],
    ["57 percent of reviews asked it", ["57 percent"]],
    ["it stood at about 652K tokens after it read 412 files", ["652K tokens", "412 files"]],
    ["8 production escapes and 38 agents", ["8 production escapes", "38 agents"]],
    ["only 1 run of 3 ended clean", ["1 run of 3"]],
    ["the gate turned red on 15 open nodes", ["15 open nodes"]],
    ["5 of 9 cells failed", ["5 of 9"]],
  ];
  /** @type {string[]} */
  const reject = [
    "measured with Node 22.23.4 and git 2.34",
    "on 2026-11-25 the tree moved",
    "cycle 54 closed it",
    "reach line 4 or line 6 of the table",
    "as Faros 2025/2026 and GitClear 2025/2026 report",
    "run it with `--limit 90 of 120 runs`",
    "see [the table](docs/a-1/2-3.md)",
    "the task c55-t3 at step 7",
    "Porter et al., TSE 1997",
    "as read (Porter et al., TSE 1997, 88 inspections)",
    "arXiv 2503.15223 and claude-code#100082",
    "see https://example.test/a/10/20 for it",
    "after routes 2 and 3 the session starts",
    "husky 6 to 8 then run the check twice",
    "skip the rest of 3 and of 4",
    "a 1 row table",
    "after step 2 then all tests ran",
  ];
  for (const [text, want] of accept)
    assert.deepEqual(
      numbersIn(text).map((n) => n.text),
      want,
      text,
    );
  for (const text of reject) assert.deepEqual(numbersIn(text), [], text);
  const fenced = units("# T\n\n```\n57% of runs\n```\n\n## 2. A heading with 5 runs\n\nText.\n");
  assert.deepEqual(
    fenced.map((u) => u.text),
    ["Text."],
    "fenced code and headings are no unit",
  );
});

test("cited numbers: what counts as a source, and what the test reads at it", () => {
  const root = mkdtempSync(join(tmpdir(), "cited-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(root, "docs", "s.md"), "# S\n\n## A section\n\nIt held 57% and 87/90.\n\n## Other\n\n12 rows.\n");
  writeFileSync(join(root, "docs", "t.md"), "Read 1149 of 1371.\n");
  writeFileSync(join(root, "docs", "r.md"), "The ladder cut code by 53% over 38 tasks. The code of 18 of the 38 was run: there the cut was 30% (87/90 against 86/90).\nAnother run wrote 53% fewer statements.\n");
  writeFileSync(join(root, "docs", "q.md"), "# Q\n\n## Part\n\n- 41% of tasks (22/54).\n- Of 32 findings, 21 (66%) were side effects.\n");
  writeFileSync(join(root, "docs", "g.md"), "It grew from 5593 lines and stood at 652 tokens.\n");
  writeFileSync(join(root, "docs", "f.md"), "Of 32 findings, 21 (66%) were fixes; 18 of them came in 38 tasks.\n");
  writeFileSync(join(root, "test", "a.test.mjs"), 'test("a named check", () => {});\n');
  writeFileSync(join(root, "plugin", "scripts", "ennyn.mjs"), "const COMMANDS = {\n  convergence(args) {},\n  async core(args) {},\n};\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "x", "test:short": "y" } }));
  const one = (/** @type {string} */ text) => {
    writeFileSync(join(root, "docs", "u.md"), text);
    return check(root, ["docs/u.md"]);
  };
  /** @type {string[]} */
  const accept = [
    "A drop of 39% (Laban et al. 2025).",
    "Recall +0.08, false positives +62% (Song 2026, preprint).",
    "A count went from 0 of 8 to 4 of 8 (cycle 44).",
    "1,149 of 1,371 subagents ran on the parent's (claude-code#100082).",
    "57% of reviews asked it (arXiv 2505.06120).",
    "57% of reviews asked it, as https://example.test/report says.",
    "57% of reviews asked it (source: `docs/s.md:5`).",
    "57% and 87/90 (source: `docs/s.md:5-5`).",
    "It held 12 rows (source: `docs/s.md#other`).",
    "It held 12 rows (source: `docs/s.md`).",
    "Source: `docs/s.md#other`; 12 rows.",
    '5 of 9 cells fail (source: `test/a.test.mjs` "a named check").',
    "5 of 9 cells fail (source: `ennyn convergence`).",
    "5 of 9 cells fail (source: `node scripts/ennyn.mjs core --json`).",
    "5 of 9 cells fail (source: `npm run test:short`; `npm test`).",
    "5 of 9 cells fail (source: `git log --oneline 4d6c50d`).",
    "5 of 9 cells fail (source: `git ls-tree -r --name-only ac098a1 | wc -l`).",
    "66% of findings were fixes (source: `docs/f.md:1`).",
    "5,593 lines and 38 tasks (source: `docs/g.md:1`; `docs/f.md:1`).",
    "The scan reads two sources: the ledger and the graph.",
    "On 18 of the 38 tasks the cut was 30% (87/90 against 86/90); another run wrote 53% fewer (sources: `docs/r.md:1`, `docs/r.md:2`).",
    "66% were side effects (source: `docs/q.md:6`).",
    "There were 32 findings (source: `docs/q.md#part`).",
    "Open source: a license that lets anyone read it.",
    "# H\n\n## One\n\nFirst unit.\n\nSource: (origin project, October 2026).\n\n- 41% of tasks.\n",
    "# H\n\n## One\n\nSource: (origin project, October 2026).\n\nA long paragraph.\n\nAnother.\n\n- 99% of tasks.\n",
    "# H\n\n## Part\n\nSource: the origin project's study (origin project, October 2026).\n\n- 41% of tasks.\n\n| a | 66% |\n",
    "No number here, nor a source.",
    "1,149 of 1,371 subagents (source: `docs/t.md:1`).",
    "57% of runs (see the table. It counts them) were cited (Laban et al. 2025).",
    "# H\n\n## Part\n\nSource: `docs/s.md:5`.\n\n- 57% of tasks.\n",
    "57% of runs (source: `docs/s.md:5`), as `--flag` says.",
    "# H\n\n## One\n\nSource: `docs/s.md#other`.\n\n- 12 rows.\n\nSource: `docs/s.md:5`.\n\n- 57% of tasks.\n",
    "Source: `docs/s.md:5`. The `--flag` is code, 57% of runs.",
    "The `5%` threshold is code, as `--limit 90` is.",
  ];
  /** @type {[string, RegExp][]} */
  const reject = [
    ["57% of reviews asked it.", /"57%" \(percentage\) names no source/],
    ["It was measured in October (October 2026): 57% of runs.", /names no source/],
    ["57% of runs (precision, n=15).", /names no source/],
    ["57% of runs (source: memory).", /"source:" names nothing/],
    ["57% of runs (source: `docs/s.md:99`).", /docs\/s\.md has 10 lines/],
    ["57% of runs (source: `docs/s.md:1`).", /"57%" \(percentage\) is not, as written and in order/],
    ["12 rows (source: `docs/s.md#a-section`).", /"12 rows" \(count\) is not, as written and in order/],
    ["57% of runs (source: `docs/missing.md`).", /docs\/missing\.md does not exist/],
    ["57% of runs (source: `docs/s.md#no-such`).", /no heading has that anchor/],
    ['5 of 9 cells (source: `test/a.test.mjs` "another check").', /holds no "another check"/],
    ["5 of 9 cells (source: `ennyn nosuch`).", /no such ennyn command/],
    ["5 of 9 cells (source: `npm run nosuch`).", /no such npm script/],
    ["5 of 9 cells (source: `../outside.md`).", /not a path in the repository/],
    ["5 of 9 cells (source: `whatever it printed`).", /no pointer the test can read/],
    ["Text (source: `docs/missing.md`), no number.", /does not exist/],
    ["# H\n\n## One\n\nSource: (origin project, October 2026).\n\n## Two\n\n- 41% of tasks.\n", /"41%" \(percentage\) names no source/],
    ["A drop of 39% (Laban et al. 2025). Another 57% of runs.", /"57%" \(percentage\) names no source/],
    ["| Topic | 17% (Wang 2018) | 62% |", /"62%" \(percentage\) names no source/],
    ["# H\n\n## One\n\n- 41% of tasks.\n\nSource: (origin project, October 2026).\n", /"41%" \(percentage\) names no source/],
    ["# H\n\n## One\n\nSource: (origin project, October 2026).\n\n### Sub\n\n- 41% of tasks.\n", /"41%" \(percentage\) names no source/],
    ["21% of findings were fixes (source: `docs/f.md:1`).", /"21%" \(percentage\) is not, as written and in order/],
    ["18 of 38 tasks were read (source: `docs/f.md:1`).", /"18 of 38" \(of\) is not, as written and in order/],
    ["38 commits (source: `docs/f.md:1`).", /"38 commits" \(count\) is not, as written and in order/],
    ["5,593 lines and 38 tasks (source: `docs/f.md:1`; `docs/g.md:1`).", /"38 tasks" \(count\) is not, as written and in order/],
    ["87 of 90 runs (source: `docs/s.md:5`).", /"87 of 90" \(of\) is not, as written and in order/],
    ["It stood at 652K tokens (source: `docs/g.md:1`).", /"652K tokens" \(count\) is not, as written and in order/],
    ["57% of runs; source: memory.", /"source:" names nothing/],
    ["77% of runs (Laban et al. 2025); Source: `docs/missing.md`.", /docs\/missing\.md does not exist/],
    ["41% of findings were side effects (source: `docs/q.md#part`).", /"41%" \(percentage\) is not, as written and in order, in docs\/q\.md#part: a percentage, ratio, multiplier or N of M is held by a line pointer only/],
    ["On 18 of the 38 tasks the cut was 53% (source: `docs/r.md:1`).", /"53%" \(percentage\) is not, as written and in order, in docs\/r\.md:1/],
    ["On 18 of the 38 tasks the cut was 30% (86/90 against 87/90) (source: `docs/r.md:1`).", /"87\/90" \(ratio\) is not, as written and in order/],
    ["On 18 of the 38 tasks the cut was 30%; another run wrote 30% fewer (sources: `docs/r.md:1`, `docs/r.md:2`).", /"30%" \(percentage\) is not, as written and in order, in docs\/r\.md:1, docs\/r\.md:2/],
    ["57% of runs (source: `git log`).", /a git pointer names a read-only command/],
    ["57% of runs (source: `git frobnicate ac098a1`).", /a git pointer names a read-only command/],
  ];
  for (const text of accept) assert.deepEqual(one(text), [], text);
  for (const [text, want] of reject) {
    const got = one(text);
    assert.ok(
      got.some((p) => want.test(p)),
      `${text}: ${got.join(" | ") || "accepted"}`,
    );
  }
  writeFileSync(join(root, "docs", "u.md"), "1% of downloads.\n\nLater 1% of runs failed.\n");
  const allow = { file: "docs/u.md", at: "1% of downloads", number: "1%" };
  assert.deepEqual(check(root, ["docs/u.md"], [allow]), ['docs/u.md:3: "1%" (percentage) names no source'], "an entry allows its place only");
  writeFileSync(join(root, "docs", "u.md"), "1% of downloads, then 1% of runs.\n");
  assert.deepEqual(check(root, ["docs/u.md"], [allow]), ['docs/u.md:1: "1%" (percentage) names no source'], "an entry allows its words only, in its unit too");
  writeFileSync(join(root, "docs", "u.md"), "1% of downloads.\n\n1% of downloads.\n");
  assert.deepEqual(check(root, ["docs/u.md"], [allow]), ['docs/u.md: the allowed place "1% of downloads" is there 2 times, not once'], "a place the file holds twice");
  writeFileSync(join(root, "docs", "u.md"), "1% of downloads.\n");
  assert.deepEqual(check(root, ["docs/u.md"], [allow]), [], "an allowed number");
  assert.deepEqual(check(root, ["docs/u.md"], [{ ...allow, file: "docs/other.md" }]), ['docs/u.md:1: "1%" (percentage) names no source', 'docs/other.md: the allowed place "1% of downloads" is there 0 times, not once'], "another file's entry allows nothing here");
  assert.deepEqual(check(root, ["docs/u.md"], [allow, { file: "docs/u.md", at: "1% of downloads", number: "2%" }]), ['docs/u.md: the allowed "2%" is no number there any more'], "a stale entry");
  assert.deepEqual(check(root, ["docs/u.md"], [{ file: "docs/u.md", at: "of runs", number: "1%" }]), ['docs/u.md:1: "1%" (percentage) names no source', 'docs/u.md: the allowed place "of runs" is there 0 times, not once'], "a place the file lacks");
});
