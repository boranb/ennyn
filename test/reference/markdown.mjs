/**
 * Reference differentials for Markdown: what a Markdown parser makes of an instruction file, recorded, and Ennyn's
 * Markdown readings replayed against it. Ennyn reads instruction files line by line (setup/scan.mjs):
 * `outsideFenceLines` decides which lines are code blocks for the ban lines (`banLinesAt`), the imports (`importsOf`)
 * and the budget's rule lines (setup/budget.mjs `ruleLines`, which also leaves headings out), and `importsOf` which
 * words are imports. Cycle 2026-10-26 (12) found the fence reader drifting from a parser twice (CommonMark's indent,
 * then list items), each time by a reviewer who ran one. Here the parser gives the expected values.
 *
 * The parser is the one Claude Code 2.1.310 reads instruction files with: marked 15.0.6, bundled in its binary and
 * run as `new Lexer({ gfm: false })` on a file's text once its front matter is cut off (the text the model gets). The
 * pin is held to the binary, not claimed. `steps` keeps a hash of the bundled marked (from its defaults to its `lexer`
 * export): of its regular expressions, which the pinned package must hold, and of all its code, so any change Claude
 * Code ships there fails until it is looked at again. `check` and `record` take that section out of the binary as a
 * module and lex every cell with it and with the pinned package: a text the two read otherwise ends the run (the
 * string rules cannot be compared by text: the bundle's minifier folded them). 15.0.5 to 15.0.9 read every cell
 * alike; 15.0.6's trailing-character helper and its second inline-delimiter rule are the bundle's. Around the parser,
 * Claude Code's own steps, as its binary holds them (`steps` finds each by its shape and keeps a hash of it, its
 * literals taken out and its minified names numbered by first use, so a change of data flow moves it):
 *   read         a file whose extension is not one of its text extensions (`textExtensions`) is skipped; the front
 *                matter is cut; the text is lexed when it holds `<!--` or `@`
 *   frontMatter  /^---\s*\n([\s\S]*?)---\s*\n?/ on the text without a byte order mark, when it holds another `---`
 *                past its start; the rest is the text, which keeps its byte order mark when nothing was cut
 *   comments     in a text that holds `<!--`, the text is its top-level tokens joined: an HTML token whose text starts
 *                with `<!--` and holds `-->` loses its comments, and a link reference definition, no token, is gone
 *   walk         an import is a word after `@` (at a token's start or after a space) in a text token or what a
 *                top-level comment token keeps, never in code or a code span, cut at `#`, `\ ` read as a space, and
 *                kept when it starts `./`, `~/`, `/` or a letter, digit, `.`, `_` or `-` (a path check Claude Code
 *                makes after this, on device and network paths, is not modelled: no cell holds such a path)
 *
 * Recording fetches marked's tarball from the public registry (identity encoding only, at most PARSER.bytes, a time
 * limit on the whole answer), checks it against the integrity pinned here, and runs the parser in a child node under
 * the permission model (Node 22.13 or later: the experimental one before let a process start) and macOS's sandbox with
 * the network denied (Node's model does not cover the network: a local socket, the Docker API's, answered without it),
 * with an empty environment: it gets the module's source and the texts on stdin and gives the tokens back on stdout,
 * and can read no file, start no process and open no connection. Where nothing shuts the network (no sandbox-exec)
 * the parser is not run. Nothing is installed or written.
 * The test (test/reference.test.mjs) reads the record and needs neither the network nor the parser.
 *
 * Each line of a cell (its text split at "\n") is one of: t prose, # a heading, c code (a fenced or indented code
 * block, in any container), f front matter, h hidden: text Claude Code takes out (a top-level comment, and in a text
 * that holds `<!--` a link reference definition). A prose line part of which is hidden has what the model gets of it
 * in `shown`. The recorder finds a block's lines by their text, in order, a container's markers (`>`, a list marker)
 * and white space aside; a cell where a block's lines also stand elsewhere is refused. Ennyn's readings are those of
 * the whole text, by line (each reader gives the index of the lines it takes). Blank lines are compared nowhere. The
 * places:
 *   line:N    the line is prose (t, #) or not, and Ennyn's outsideFenceLines keeps it or not
 *   rule:N    a line both read as prose, long enough to be a rule line: Ennyn's budget takes it, unless it is a
 *             heading, with the words the model gets of it
 *   ban:N     a line both read as prose: the literals Ennyn's ban lines take from it, against those its heuristic
 *             (`banLiterals`) finds in what the model gets of it
 *   import:P  a file Claude Code imports from the cell at the top (CLAUDE.md), and Ennyn's importsOf
 * Each place compares to one of:
 *   agree    Ennyn reads what the parser does
 *   extra    Ennyn takes what the parser does not give: code, front matter or hidden text read as prose, a heading
 *            read as a rule line, an import Claude Code does not make
 *   differs  Ennyn misses what the parser gives: prose read as code, a rule line read as a heading, an import
 * A cell lists every place that does not agree in `except`, each with why: `extra: … (<open node>)`, `differs: …`
 * (meant) or `gap: <open node>`; `ennyn` pins Ennyn's reading there.
 *
 *   node test/reference/markdown.mjs add <probes.json>             record new cells
 *   node test/reference/markdown.mjs show [id…]                    each place's comparison
 *   node test/reference/markdown.mjs check                         exit 1 when the parser reads a cell otherwise, or
 *                                                                  is not the one Claude Code bundles
 *   node test/reference/markdown.mjs record                        take every reading again
 *   node test/reference/markdown.mjs steps [--claude <bin>] [--record]   the binary's steps against the record's
 * `npm run test:reference` runs `check`; test/reference/claude-code.mjs `check` runs `steps` with its binary.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { banLinesAt, banLiterals, importsOf, outsideFenceLines } from "../../setup/scan.mjs";
import { MIN_RULE, ruleKey, ruleLines } from "../../setup/budget.mjs";
import { claudeBinary, versionOf } from "./claude-bin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "markdown.json");
const CELL_KEYS = ["id", "from", "text", "md", "except", "ennyn"];
export const RELATIONS = /** @type {const} */ (["agree", "extra", "differs"]);
/** A cell's id: plain words, so no id puts a control byte on the terminal. */
const ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The parser, pinned: the version Claude Code's bundle matches, its tarball on the public registry, the integrity
 * the registry gives for it (2025-01-06; marked has no dependency and no install script), the most bytes taken.
 */
export const PARSER = Object.freeze({
  version: "15.0.6",
  tarball: "https://registry.npmjs.org/marked/-/marked-15.0.6.tgz",
  integrity: "sha512-Y07CUOE+HQXbVDCGl3LXggqJDbXDP2pArc2C1N1RRMN0ONiShoSsIInMd5Gsxupe7fKLpgimTV+HOJ9r7bA+pg==",
  file: "package/lib/marked.esm.js",
  bytes: 1024 * 1024,
});

/** Claude Code's front matter rule (its binary's own expression). */
const FRONT_MATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;
/** The longest cell. */
const CELL_TEXT = 16 * 1024;
const NAMES = /** @type {const} */ ({ t: "prose", "#": "heading", c: "code", f: "front matter", h: "hidden" });

/**
 * @typedef {{ lines: string, shown?: Record<string, string>, imports: string[] }} MdReading each line's class, one
 *   character a line; what the model gets of a line part of which is hidden, by line number; the words Claude Code's
 *   walk imports, in its order
 * @typedef {{ id: string, from: string, text: string, md?: MdReading, except?: Record<string, string>, ennyn?: Record<string, string> }} Cell
 * @typedef {{ relation: typeof RELATIONS[number], ennyn: string, md: string }} Comparison
 * @typedef {{ version: string, read: string, frontMatter: string, bom: string, comments: string, walk: string, parserRules: string, parserCode: string, textExtensions: string[] }} Steps
 *   Claude Code's version, a hash of each of its steps, of its bundled parser's rules and of all its code, and the
 *   extensions it reads an import of
 * @typedef {{ parser: string, claudeCode: Steps, cells: Cell[] }} Record
 * @typedef {{ tokens: any[], defs: string[] }} Lexed a text's top-level tokens, and the link reference definitions the
 *   lexer kept as no token, in order
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A cell's name for a message: its id, or the id quoted when it is no plain id. @param {any} c */
const nameOf = (c) => (typeof c?.id === "string" && ID.test(c.id) ? c.id : JSON.stringify(c?.id));

// ---------------------------------------------------------------------------------------------------------
// The parser's reading, as Claude Code takes it.

/**
 * The words Claude Code's walk imports from a token list, in its order, each once.
 * @param {any[]} tokens
 */
export function walk(tokens) {
  /** @type {string[]} */
  const out = [];
  const scan = (/** @type {string} */ text) => {
    for (const m of text.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
      let word = m[1];
      const hash = word.indexOf("#");
      if (hash !== -1) word = word.slice(0, hash);
      if (!word) continue;
      word = word.replaceAll("\\ ", " ");
      const kept = word.startsWith("./") || word.startsWith("~/") || (word.startsWith("/") && word !== "/") || (!word.startsWith("@") && !/^[#%^&*()]+/.test(word) && /^[a-zA-Z0-9._-]/.test(word));
      if (kept && !out.includes(word)) out.push(word);
    }
  };
  const visit = (/** @type {any[]} */ list) => {
    for (const t of list) {
      if (t.type === "code" || t.type === "codespan") continue;
      if (t.type === "html") {
        const raw = t.raw || "";
        const lead = raw.trimStart();
        if (lead.startsWith("<!--") && lead.includes("-->")) {
          const kept = raw.replace(/<!--[\s\S]*?-->/g, "");
          if (kept.trim().length > 0) scan(kept);
        }
        continue;
      }
      if (t.type === "text") scan(t.text || "");
      if (t.tokens) visit(t.tokens);
      if (t.items) visit(t.items);
    }
  };
  visit(tokens);
  return out;
}

/** A line's text without spaces, tabs and carriage returns: what a container's indentation changes. @param {string} s */
const bare = (s) => s.replace(/[ \t\r]/g, "");
/** Whether source line `src` holds a block's line `line`, a container's markers before it. @param {string} src @param {string} line */
function holds(src, line) {
  const s = bare(src);
  const l = bare(line);
  return s.endsWith(l) && /^(?:>|[-+*]|\d{1,9}[.)])*$/.test(s.slice(0, s.length - l.length));
}

/**
 * Claude Code's front matter cut: the text the parser gets, the line of the cell it starts on, and whether the cut
 * ends inside that line (the model then gets only the rest of it).
 * @param {string} text
 */
export function frontCut(text) {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const front = unmarked.indexOf("---", 3) < 0 ? null : FRONT_MATTER.exec(unmarked);
  return { content: front ? unmarked.slice(front[0].length) : text, first: front ? (front[0].match(/\n/g) ?? []).length : 0, mid: Boolean(front && !front[0].endsWith("\n")) };
}

/**
 * The parser's reading of a cell's text: each line's class, what the model gets of a line part of which is hidden,
 * and the words Claude Code imports. `lex` gives the parser's tokens of the text the front matter cut leaves.
 * Throws when the text is no cell (a lone carriage return) or a block's lines cannot be told apart.
 * @param {string} text @param {(content: string) => Lexed} lex
 * @returns {MdReading}
 */
export function mdReading(text, lex) {
  if (/\r(?!\n)/.test(text)) throw new Error("a lone carriage return ends a line for the parser and none for Ennyn");
  const lines = text.split("\n");
  const { content, first, mid } = frontCut(text);
  const cls = lines.map((_, i) => (i < first ? "f" : "t"));
  const body = content.replace(/\r\n/g, "\n");
  const bodyLines = body.split("\n");
  const { tokens, defs } = lex(content);

  // What Claude Code takes out, in a text that holds `<!--`: the comments of top-level HTML tokens, and the link
  // reference definitions, which the lexer keeps as no token (it joins the tokens' text). The tokens cover the text
  // in order but for those definitions, which the lexer's own tokenizer read.
  const hidden = new Uint8Array(body.length);
  const joined = content.includes("<!--");
  const left = [...defs];
  let at = 0;
  for (const t of tokens) {
    while (!body.startsWith(t.raw, at)) {
      const def = left.shift();
      if (def === undefined || !def || !body.startsWith(def, at)) throw new Error(`top-level tokens do not cover the text at ${at}`);
      if (joined) hidden.fill(1, at, at + def.length);
      at += def.length;
    }
    const lead = t.raw.trimStart();
    if (t.type === "html" && lead.startsWith("<!--") && lead.includes("-->")) {
      for (const m of t.raw.matchAll(/<!--[\s\S]*?-->/g)) hidden.fill(1, at + /** @type {number} */ (m.index), at + /** @type {number} */ (m.index) + m[0].length);
    }
    at += t.raw.length;
  }
  /** @type {Record<string, string>} */
  const shown = {};
  let start = 0;
  bodyLines.forEach((l, j) => {
    // By UTF-16 offset, as the mask is.
    let kept = "";
    let any = false;
    for (let k = 0; k < l.length; k++) {
      if (hidden[start + k]) any = true;
      else kept += l[k];
    }
    // A line part of which is hidden, or the rest of a line a front matter cut ends in.
    if (l.trim() && (any || (mid && j === 0))) {
      if (kept.trim()) shown[String(first + j + 1)] = kept;
      else cls[first + j] = "h";
    }
    start += l.length + 1;
  });

  // Code blocks and headings, in document order, found by their lines.
  /** @type {{ cls: string, seq: string[] }[]} */
  const blocks = [];
  const collect = (/** @type {any[]} */ list) => {
    for (const t of list) {
      if (t.type === "code" || t.type === "heading") {
        const seq = t.raw.split("\n");
        while (seq.length && !seq[seq.length - 1].trim()) seq.pop();
        if (seq.length) blocks.push({ cls: t.type === "code" ? "c" : "#", seq });
      }
      if (t.tokens && t.type !== "paragraph" && t.type !== "text" && t.type !== "heading") collect(t.tokens);
      if (t.items) collect(t.items);
    }
  };
  collect(tokens);
  const starts = (/** @type {string[]} */ seq, /** @type {number} */ from) => {
    /** @type {number[]} */
    const out = [];
    for (let p = from; p + seq.length <= bodyLines.length; p++) {
      if (seq.every((l, k) => holds(bodyLines[p + k], l))) {
        out.push(p);
        p += seq.length - 1;
      }
    }
    return out;
  };
  let cursor = 0;
  blocks.forEach((b, i) => {
    const found = starts(b.seq, cursor);
    const same = blocks.slice(i).filter((o) => o.seq.join("\n") === b.seq.join("\n")).length;
    if (!found.length) throw new Error(`a block's lines were not found in the text: ${JSON.stringify(b.seq.join("\n").slice(0, 80))}`);
    if (found.length > same) throw new Error(`a block's lines stand elsewhere in the cell too: write them apart: ${JSON.stringify(b.seq.join("\n").slice(0, 80))}`);
    for (let k = 0; k < b.seq.length; k++) cls[first + found[0] + k] = b.cls;
    cursor = found[0] + b.seq.length;
  });
  return { lines: cls.join(""), ...(Object.keys(shown).length ? { shown } : {}), imports: walk(tokens) };
}

// ---------------------------------------------------------------------------------------------------------
// Ennyn's readings and the comparison.

/**
 * Ennyn's readings of a cell's whole text, by line index: the lines outsideFenceLines keeps, the budget's rule lines
 * and their keys, the ban lines' literals, and the files importsOf names from the top. Each reader reads the whole
 * text, so a reading that looks ahead (a closer further on, an underline) is the one compared.
 * @param {string} text @param {typeof READERS} [readers]
 */
export function readings(text, readers = READERS) {
  return {
    prose: new Set(readers.outsideFenceLines(text)),
    rules: new Map(readers.ruleLines(text).map((r) => [r.at, r.key])),
    bans: new Map(readers.banLinesAt(text).map((b) => [b.at, b.literals])),
    imports: new Set(readers.importsOf(text, "CLAUDE.md")),
  };
}

/** Ennyn's readers the replay reads. */
export const READERS = Object.freeze({ outsideFenceLines, ruleLines, banLinesAt, importsOf });

/**
 * A word Claude Code imports, as a path of the repository read from the top; null for one outside it or one it
 * skips (an extension that is not one of its text extensions).
 * @param {string} word @param {Set<string>} text the extensions it reads
 */
function inRepository(word, text) {
  if (word.startsWith("~/") || word.startsWith("/")) return null;
  const path = posix.normalize(word.split("\\").join("/"));
  const ext = posix.extname(path).toLowerCase();
  return path.startsWith("..") || (ext && !text.has(ext)) ? null : path;
}

/** Two lists of literals as one reading. @param {string[]} a */
const literals = (a) => (a.length ? a.join(" ") : "none");

/**
 * Each place's comparison: Ennyn's readings against the parser's recorded one.
 * @param {Cell} c @param {string[]} textExtensions the extensions Claude Code reads an import of
 * @param {ReturnType<typeof readings>} [mine]
 * @returns {Map<string, Comparison>}
 */
export function compare(c, textExtensions, mine = readings(c.text)) {
  const md = /** @type {MdReading} */ (c.md);
  const lines = c.text.replace(/^\uFEFF/, "").split("\n");
  /** @type {Map<string, Comparison>} */
  const out = new Map();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const ref = /** @type {keyof typeof NAMES} */ (md.lines[i]);
    const prose = ref === "t" || ref === "#";
    const kept = mine.prose.has(i);
    const shown = md.shown?.[String(i + 1)];
    const seen = shown ?? line;
    out.set(`line:${i + 1}`, { relation: kept === prose ? "agree" : kept ? "extra" : "differs", ennyn: kept ? "prose" : "code", md: NAMES[ref] ?? `unknown ${ref}` });
    if (!kept || !prose) return;
    if (ruleKey(line).length >= MIN_RULE || ruleKey(seen).length >= MIN_RULE) {
      const rule = ref === "t" && ruleKey(seen).length >= MIN_RULE;
      const taken = mine.rules.get(i);
      const same = taken === undefined || !rule || taken === ruleKey(seen);
      const relation = Boolean(taken) === rule ? (same ? "agree" : "extra") : taken ? "extra" : "differs";
      out.set(`rule:${i + 1}`, { relation, ennyn: taken === undefined ? "heading" : shown === undefined ? "rule line" : `rule line: ${taken}`, md: ref === "#" ? "heading" : !rule ? "short" : shown === undefined ? "prose" : `prose: ${ruleKey(seen)}` });
    }
    const theirs = banLiterals(seen);
    const ours = mine.bans.get(i) ?? [];
    if (theirs.length || ours.length) {
      const relation = ours.join("\n") === theirs.join("\n") ? "agree" : theirs.every((x) => ours.includes(x)) ? "extra" : "differs";
      out.set(`ban:${i + 1}`, { relation, ennyn: literals(ours), md: literals(theirs) });
    }
  });
  const ext = new Set(textExtensions);
  const theirs = new Set(md.imports.map((w) => inRepository(w, ext)).filter((p) => p !== null));
  for (const p of new Set([...theirs, ...mine.imports])) {
    const a = theirs.has(p);
    const b = mine.imports.has(p);
    out.set(`import:${p}`, { relation: a === b ? "agree" : b ? "extra" : "differs", ennyn: b ? "imports" : "no import", md: a ? "imports" : "no import" });
  }
  return out;
}

/**
 * The comparisons that differ from what the cell lists, each as a line; none when the record holds. A place `except`
 * lists has its why: `differs: …` (meant), and for a hole `gap: <node>` or `extra: … (<node>)`, the open graph node
 * that will close it; `ennyn` pins Ennyn's reading there, so a move from one wrong value to another is seen. Places
 * and readings are quoted: they come from the cells' text.
 * @param {{ cell: Cell, got: Map<string, Comparison> }[]} compared @param {Set<string>} [openNodes] the graph's open node ids
 */
export function moves(compared, openNodes) {
  /** @type {string[]} */
  const out = [];
  const q = JSON.stringify;
  for (const { cell: c, got } of compared) {
    const id = nameOf(c);
    const except = c.except ?? {};
    const pinned = c.ennyn ?? {};
    for (const [k, why] of Object.entries(except)) {
      const [rel, ...rest] = why.split(":");
      const text = rest.join(":").trim();
      if (!text) out.push(`${id} ${q(k)}: ${q(why)} gives no why`);
      const node = rel === "gap" ? text : rel === "extra" ? /\(([a-z0-9]+(?:-[a-z0-9]+)+)\)$/.exec(text)?.[1] : undefined;
      if (rel === "extra" && node === undefined) out.push(`${id} ${q(k)}: an extra names no graph node, in parentheses at its end`);
      if (node !== undefined && openNodes && !openNodes.has(node)) out.push(`${id} ${q(k)}: names no open graph node: ${q(node)}`);
      const r = got.get(k);
      if (!r) out.push(`${id} ${q(k)}: listed, but neither the parser nor Ennyn has this place`);
      else if (!(k in pinned)) out.push(`${id} ${q(k)}: Ennyn's reading is not pinned (${q(r.ennyn)})`);
      else if (pinned[k] !== r.ennyn) out.push(`${id} ${q(k)}: Ennyn reads ${q(r.ennyn)}, recorded ${q(pinned[k])}`);
    }
    for (const k of Object.keys(pinned)) if (!(k in except)) out.push(`${id} ${q(k)}: Ennyn's reading pinned where except lists nothing`);
    for (const [k, r] of got) {
      const rel = (except[k] ?? "agree").split(":")[0];
      const want = rel === "gap" ? "differs" : rel;
      if (want !== r.relation) out.push(`${id} ${q(k)}: ${r.relation}, recorded ${want} — Ennyn ${q(r.ennyn)}, the parser ${q(r.md)}`);
    }
  }
  return out;
}

/**
 * Every cell compared. Nothing a cell holds is written or run: Ennyn's readers read its text.
 * @param {Cell[]} cells @param {string[]} textExtensions
 */
export const compareAll = (cells, textExtensions) => cells.map((cell) => ({ cell, got: compare(cell, textExtensions) }));

/**
 * What the model gets from each ban-lines cell's text (test/verdicts/bans.json), by Ennyn's own heuristic on the
 * prose the parser gives: "said" with the literals, or "pass". Null when the record holds no cell of that text.
 * @param {Cell[]} cells @param {string} text
 */
export function modelBans(cells, text) {
  const c = cells.find((x) => x.text === text && x.md);
  if (!c?.md) return null;
  const md = c.md;
  const found = text
    .replace(/^\uFEFF/, "")
    .split("\n")
    .flatMap((line, i) => (md.lines[i] === "t" || md.lines[i] === "#" ? banLiterals(md.shown?.[String(i + 1)] ?? line) : []));
  return found.length ? { verdict: "said", why: found } : { verdict: "pass" };
}

/**
 * Ban cells of test/verdicts/bans.json that hold no text of this record, each with why: none today.
 * @type {Readonly<Record<string, string>>}
 */
export const NO_TWIN = Object.freeze({});

/**
 * The ban lines corpus against the record: each ban cell's text must be a cell's here (or be named in `noTwin` with
 * why), and the model must get from it what the ban cell records, or the ban cell names why (`known`, `gap`).
 * @param {{ id: string, text: string, verdict: string, why?: string[], known?: string, gap?: string }[]} bans
 * @param {Cell[]} cells @param {Readonly<Record<string, string>>} [noTwin]
 */
export function twinProblems(bans, cells, noTwin = NO_TWIN) {
  const sorted = (/** @type {string[] | undefined} */ a) => JSON.stringify([...(a ?? [])].sort());
  return bans.flatMap((b) => {
    const m = modelBans(cells, b.text);
    if (!m) return b.id in noTwin ? [] : [`${b.id}: no cell of test/reference/markdown.json holds its text: add one, or name it in NO_TWIN with why`];
    const same = m.verdict === b.verdict && sorted(m.why) === sorted(b.why);
    return same || b.known || b.gap ? [] : [`${b.id}: bans.json says ${b.verdict} ${sorted(b.why)}, the model gets ${m.verdict} ${sorted(m.why)}: anchor it (known, gap) or fix the reader`];
  });
}

/** What a cell must hold; each problem as a line. @param {any} c */
export function cellProblems(c) {
  /** @type {string[]} */
  const out = [];
  if (!isObject(c)) return ["a cell is an object"];
  if (typeof c.id !== "string" || !ID.test(c.id)) return [`id ${JSON.stringify(c.id)} is no plain id (a-z, 0-9, -)`];
  if (typeof c.from !== "string" || !c.from) out.push(`${c.id}: no from`);
  if (typeof c.text !== "string") out.push(`${c.id}: text is the file's text`);
  else {
    if (c.text.length > CELL_TEXT) out.push(`${c.id}: text past ${CELL_TEXT} characters`);
    if (/\r(?!\n)/.test(c.text)) out.push(`${c.id}: a lone carriage return ends a line for the parser and none for Ennyn`);
  }
  for (const k of Object.keys(c)) if (!CELL_KEYS.includes(k)) out.push(`${c.id}: ${JSON.stringify(k)} is no key of a cell (${CELL_KEYS.join(", ")})`);
  if (c.md !== undefined && !(isObject(c.md) && typeof c.md.lines === "string" && typeof c.text === "string" && c.md.lines.length === c.text.split("\n").length && /^[t#cfh]*$/.test(c.md.lines) && Array.isArray(c.md.imports) && c.md.imports.every((/** @type {unknown} */ w) => typeof w === "string") && (c.md.shown === undefined || (isObject(c.md.shown) && Object.values(c.md.shown).every((v) => typeof v === "string"))))) out.push(`${c.id}: md is { lines: a class (t # c f h) for each line, shown?: { line: text }, imports: [words] }`);
  if (c.except !== undefined && (!isObject(c.except) || !Object.values(c.except).every((v) => typeof v === "string" && ["extra", "differs", "gap"].includes(v.split(":")[0])))) out.push(`${c.id}: except maps a place to "extra: … (<node>)", "differs: …" or "gap: <node>"`);
  if (c.ennyn !== undefined && (!isObject(c.ennyn) || !Object.values(c.ennyn).every((v) => typeof v === "string"))) out.push(`${c.id}: ennyn maps a place to Ennyn's reading there`);
  return out;
}

/** The record. @returns {Record} */
export function readRecord(path = RECORD) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The record as written: its header, then one cell a line, so a diff shows the cells that moved. @param {Record} rec */
export function recordText(rec) {
  const cells = rec.cells.map((c) => `    ${JSON.stringify(Object.fromEntries(CELL_KEYS.filter((k) => k in c).map((k) => [k, /** @type {any} */ (c)[k]])))}`);
  return `{\n  "parser": ${JSON.stringify(rec.parser)},\n  "claudeCode": ${JSON.stringify(rec.claudeCode)},\n  "cells": [\n${cells.join(",\n")}\n  ]\n}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// Recording: the pinned parser, fetched here only and run in a child that can read nothing.

/** One file of a tar archive (ustar names), or null. @param {Buffer} tar @param {string} name */
export function fileInTar(tar, name) {
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return null;
    const field = (/** @type {number} */ from, /** @type {number} */ len) => header.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("a tar header whose size does not parse");
    if (path === name && (header[156] === 0x30 || header[156] === 0)) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * The pinned parser's source: its tarball fetched with no content encoding, at most `parser.bytes` of it, within
 * `ms`, checked against the pinned integrity, its module taken out in memory. Any other answer is refused.
 * @param {{ fetch?: typeof fetch, parser?: { tarball: string, integrity: string, file: string, version: string, bytes: number }, ms?: number }} [opts]
 */
export async function loadParser({ fetch: get = globalThis.fetch, parser = PARSER, ms = 60_000 } = {}) {
  const signal = AbortSignal.timeout(ms);
  const late = () => new Error(`${parser.tarball}: timed out after ${ms} ms`);
  /** @type {Response} */
  let res;
  try {
    res = await get(parser.tarball, { redirect: "error", headers: { "accept-encoding": "identity" }, signal });
  } catch (err) {
    throw signal.aborted ? late() : err;
  }
  const refuse = async (/** @type {string} */ why) => {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${parser.tarball}: ${why}`);
  };
  if (res.status !== 200) return refuse(`answered ${res.status}`);
  const encoding = res.headers.get("content-encoding");
  if (encoding && encoding !== "identity") return refuse(`content encoding ${JSON.stringify(encoding)} refused`);
  if (Number(res.headers.get("content-length")) > parser.bytes) return refuse(`more than ${parser.bytes} bytes`);
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  // The time limit holds for the body too, whatever the fetch does with its signal: the read is cancelled.
  const reader = res.body?.getReader();
  const stop = () => void reader?.cancel(late()).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
      if (done) break;
      size += value.length;
      if (size > parser.bytes) {
        await reader?.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw late();
  if (size > parser.bytes) throw new Error(`${parser.tarball}: more than ${parser.bytes} bytes`);
  const tgz = Buffer.concat(chunks);
  const got = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  if (got !== parser.integrity) throw new Error(`marked ${parser.version}: the tarball's integrity is ${got}, pinned ${parser.integrity}`);
  const file = fileInTar(gunzipSync(tgz, { maxOutputLength: 16 * parser.bytes }), parser.file);
  if (!file) throw new Error(`marked ${parser.version}: no ${parser.file} in its tarball`);
  return { source: file.toString("utf8") };
}

/**
 * Whether this Node's permission model holds (`--permission`, 22.13 and 23.5 on): the experimental one before it let
 * a child process start (Node 20.0.0 ran `execFileSync` under it).
 */
export function permissionHolds(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

/** What the child runs: the module from its source, each text lexed, the definitions found where no token stands. */
const CHILD = `let s = "";
for await (const c of process.stdin) s += c;
const { source, contents } = JSON.parse(s);
const { Lexer } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
process.stdout.write(JSON.stringify(contents.map((content) => {
  try {
    const lexer = new Lexer({ gfm: false });
    const tokens = lexer.lex(content);
    const body = content.replace(/\\r\\n/g, "\\n");
    const defs = [];
    let at = 0;
    for (const t of tokens) {
      for (let d; !body.startsWith(t.raw, at) && (d = lexer.tokenizer.def(body.slice(at))); at += d.raw.length) defs.push(d.raw);
      at += t.raw.length;
    }
    return { tokens, defs };
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
})));
`;

/** macOS's sandbox, and its profile with the network denied: Node's permission model does not cover the network. */
const SANDBOX = "/usr/bin/sandbox-exec";
const NO_NETWORK = "(version 1)(allow default)(deny network*)";

/**
 * Each text lexed by the parser in a child node under the permission model (no file read or written, no process
 * started) and macOS's sandbox with the network denied (no connection, a local socket's either), with only `env`:
 * the module's source and the texts go in on stdin, the tokens come back on stdout. Where nothing shuts the network
 * (no sandbox-exec) the parser is not run. Node's own words for its model: a seat belt, not a sandbox; the pinned
 * integrity comes first.
 * @param {string} source @param {string[]} contents
 * @param {{ env?: NodeJS.ProcessEnv, ms?: number, run?: typeof spawnSync }} [opts]
 * @returns {(Lexed | { error: string })[]}
 */
export function lexInChild(source, contents, { env = {}, ms = 120_000, run = spawnSync } = {}) {
  if (!permissionHolds()) throw new Error(`the parser runs only under a Node whose permission model holds (22.13, 23.5 or later); this is ${process.versions.node}`);
  if (!existsSync(SANDBOX)) throw new Error(`nothing here shuts the parser's network (no ${SANDBOX}, which macOS has): the parser is not run`);
  const r = run(SANDBOX, ["-p", NO_NETWORK, process.execPath, "--permission", "--input-type=module", "-e", CHILD], { input: JSON.stringify({ source, contents }), env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: ms });
  if (r.error || r.status !== 0) throw new Error(`the parser's child failed (${r.error?.message ?? `exit ${r.status}`}): ${JSON.stringify((r.stderr ?? "").slice(0, 400))}`);
  const out = JSON.parse(r.stdout);
  if (!Array.isArray(out) || out.length !== contents.length) throw new Error("the parser's child gave another number of readings than texts");
  return out;
}

/**
 * Every cell read again with the parser; a cell the recorder refuses keeps no reading and says why.
 * @param {Cell[]} cells @param {(contents: string[]) => (Lexed | { error: string })[]} lexAll
 */
export function readAll(cells, lexAll) {
  const contents = cells.map((c) => (typeof c.text === "string" && !/\r(?!\n)/.test(c.text) ? frontCut(c.text).content : ""));
  const lexed = lexAll(contents);
  /** @type {string[]} */
  const refused = [];
  const out = cells.map((c, i) => {
    try {
      return {
        ...c,
        md: mdReading(c.text, () => {
          const r = lexed[i];
          if ("error" in r) throw new Error(`the parser threw: ${JSON.stringify(r.error.slice(0, 200))}`);
          return r;
        }),
      };
    } catch (err) {
      refused.push(`${nameOf(c)}: ${/** @type {Error} */ (err).message}`);
      return c;
    }
  });
  return { cells: out, refused };
}

// ---------------------------------------------------------------------------------------------------------
// Claude Code's steps around the parser, found in its binary.

/** Text read by offset: a string, or a Buffer read as latin1 without making one string of all of it. @param {string | Buffer} b */
function textOf(b) {
  return typeof b === "string"
    ? { indexOf: (/** @type {string} */ s, /** @type {number} */ from = 0) => b.indexOf(s, from), slice: (/** @type {number} */ a, /** @type {number} */ z) => b.slice(Math.max(0, a), z) }
    : { indexOf: (/** @type {string} */ s, /** @type {number} */ from = 0) => b.indexOf(s, from, "latin1"), slice: (/** @type {number} */ a, /** @type {number} */ z) => b.toString("latin1", Math.max(0, a), Math.min(b.length, z)) };
}

/** Every offset of `needle`. @param {ReturnType<typeof textOf>} t @param {string} needle */
function offsets(t, needle) {
  /** @type {number[]} */
  const out = [];
  for (let at = t.indexOf(needle); at !== -1; at = t.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** A function's text from `at` (its `function` keyword) to its closing brace; none of these holds a brace in a string. @param {ReturnType<typeof textOf>} t @param {number} at */
function functionAt(t, at) {
  const s = t.slice(at, at + 8000);
  let depth = 0;
  for (let i = s.indexOf("{"); i !== -1 && i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(0, i + 1);
  }
  return null;
}

/** The definition of `name` nearest `near`. @param {ReturnType<typeof textOf>} t @param {string} name @param {number} near */
function nearestFunction(t, name, near) {
  let best = -1;
  for (const at of offsets(t, `function ${name}(`)) if (best === -1 || Math.abs(at - near) < Math.abs(best - near)) best = at;
  return best === -1 ? null : functionAt(t, best);
}

const KEYWORDS = new Set(["let", "var", "new", "for", "of", "if", "do", "in", "try"]);

/**
 * Code with its string, template and regular expression literals taken out (each left as \0<n>\0), and those
 * literals: a `/` starts a regular expression where a value is expected (after an operator or punctuation).
 * @param {string} code
 */
function literalsOut(code) {
  /** @type {string[]} */
  const kept = [];
  let out = "";
  let prev = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    let end = -1;
    if (c === '"' || c === "'" || c === "`") {
      end = i + 1;
      while (end < code.length && code[end] !== c) end += code[end] === "\\" ? 2 : 1;
      end++;
    } else if (c === "/" && code[i + 1] !== "/" && code[i + 1] !== "*" && /[(,=:[!&|?{};+\-*%<>~^]/.test(prev || "(")) {
      let inClass = false;
      for (end = i + 1; end < code.length && code[end] !== "\n" && (inClass || code[end] !== "/"); end++) {
        if (code[end] === "\\") end++;
        else if (code[end] === "[") inClass = true;
        else if (code[end] === "]") inClass = false;
      }
      end++;
      while (/[a-z]/.test(code[end] ?? "")) end++;
    }
    if (end > i) {
      out += `\0${kept.length}\0`;
      kept.push(code.slice(i, end));
      prev = "x";
      i = end;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c;
    i++;
  }
  return { out, kept };
}

/**
 * A hash of code with its short (minified) names numbered by first use: another build of the same code hashes the
 * same, and code that hands another value along (`content:s` for `content:e`) does not. Literals are taken out first,
 * so a letter in one (`\s` in a regular expression) is no name.
 * @param {string} code
 */
export function codeHash(code) {
  const { out, kept } = literalsOut(code);
  /** @type {Map<string, string>} */
  const names = new Map();
  const renamed = out.replace(/(?<![\w$.])[A-Za-z_$][\w$]{0,2}(?![\w$])/g, (w) => {
    if (KEYWORDS.has(w)) return w;
    if (!names.has(w)) names.set(w, `_${names.size}`);
    return /** @type {string} */ (names.get(w));
  });
  return createHash("sha256")
    .update(renamed.replace(/\0(\d+)\0/g, (_, n) => kept[Number(n)]))
    .digest("hex")
    .slice(0, 16);
}

/** The regular expressions of a module's text, as a set: what a bundler keeps of a parser's rules. @param {string} text */
export function ruleLiterals(text) {
  const rx = /\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])*)\/([dgimsuy]*)(?=[.,;)\]}])/g;
  return [...new Set([...text.matchAll(rx)].map((m) => m[0]).filter((x) => x.length >= 10 && /[\\^$(]/.test(x)))].sort();
}

/** The hash of a rule set. @param {string[]} rules */
export const rulesHash = (rules) => createHash("sha256").update(rules.join("\n")).digest("hex").slice(0, 16);

const READ_STEP = /function [\w$]+\([\w$]+,([\w$]+),[\w$]+,([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\1\)\.toLowerCase\(\);if\(\3&&!([\w$]+)\.has\(\3\)\)return [\w$]+\(`Skipping non-text file in @include: \$\{\1\}`\),\{info:null,includePaths:\[\]\};let\{content:([\w$]+),paths:[\w$]+\}=([\w$]+)\([\w$]+\),([\w$]+)=\6\.includes\("<!--"\),([\w$]+)=\2!==void 0&&\6\.includes\("@"\),([\w$]+)=\8\|\|\9\?new ([\w$]+)\(\{gfm:!1\}\)\.lex\(\6\):void 0,[\w$]+=\8&&\10\?([\w$]+)\(\10\)\.content:\6,[\w$]+=\10&&\2!==void 0\?([\w$]+)\(\10,\2\):\[\]/;
const FRONT_STEP = /function ([\w$]+)\(([\w$]+),[\w$]+,[\w$]+\)\{let ([\w$]+)=\2;\2=([\w$]+)\(\2\);let ([\w$]+)=\2\.indexOf\("---",3\)<0\?null:\2\.match\(([\w$]+)\);if\(!\5\)return\{frontmatter:\{\},frontmatterAsWritten:\{\},content:\3\};let [\w$]+=\5\[1\]\|\|"",[\w$]+=\2\.slice\(\5\[0\]\.length\);/;
const DEFAULTS = "{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}";
const NOT_FOUND = /** @type {const} */ ({ read: "not found", frontMatter: "not found", bom: "not found", comments: "not found", walk: "not found", parserRules: "not found", parserCode: "not found", textExtensions: [] });

/**
 * Where the bundled parser lies in a binary: from the function that gives its defaults to the `lexer` export after its
 * Lexer class, which `lexer` names. Null when it is not one such stretch.
 * @param {ReturnType<typeof textOf>} t @param {string} lexer
 */
function lexerSection(t, lexer) {
  const defaults = offsets(t, DEFAULTS);
  const lexerAt = t.indexOf(`class ${lexer}{tokens;options;state;tokenizer;inlineQueue;constructor(`);
  if (defaults.length !== 1 || lexerAt === -1) return null;
  const head = t.slice(defaults[0] - 200, defaults[0]);
  const from = defaults[0] - 200 + head.lastIndexOf("function ");
  const tail = new RegExp(`\\.lexer=${lexer.replace(/\$/g, "\\$")}\\.lex[;,]`).exec(t.slice(lexerAt, lexerAt + 200_000));
  return head.includes("function ") && tail && lexerAt > from && lexerAt - from < 400_000 ? t.slice(from, lexerAt + /** @type {number} */ (tail.index) + tail[0].length) : null;
}

/** The instruction reader's match in a binary, the one there is, or null. @param {ReturnType<typeof textOf>} t */
function readStep(t) {
  const reads = offsets(t, "Skipping non-text file in @include: ${").flatMap((at) => {
    const m = READ_STEP.exec(t.slice(at - 600, at + 1200));
    return m ? [{ m, at }] : [];
  });
  return reads.length === 1 ? reads[0] : null;
}

/**
 * The parser Claude Code bundles, taken out of its binary as a module whose Lexer is the bundle's: what `check` lexes
 * every cell with beside the pinned package. Null when the binary holds no such section.
 * @param {string | Buffer} binary
 */
export function bundledLexer(binary) {
  const t = textOf(binary);
  const read = readStep(t);
  const section = read && lexerSection(t, read.m[11]);
  return section ? `${section}\nexport { ${/** @type {NonNullable<typeof read>} */ (read).m[11]} as Lexer };` : null;
}

/**
 * The texts two parsers read otherwise, quoted: their tokens or their errors differ.
 * @param {string[]} contents @param {unknown[]} a @param {unknown[]} b
 */
export const lexersDisagree = (contents, a, b) => contents.flatMap((c, i) => (JSON.stringify(a[i]) === JSON.stringify(b[i]) ? [] : [JSON.stringify(c)]));

/**
 * Claude Code's steps around the parser in a binary, each a hash, or "not found": the instruction reader (its text
 * extensions, the front matter cut, the lexing with gfm off when the text holds `<!--` or `@`, the comment step, the
 * walk), the front matter function (a single one in the binary, with its expression), the byte order mark it drops,
 * the comment and the walk functions, and the bundled parser (from its defaults to its `lexer` export): its rules (its
 * regular expressions, which the pinned package must hold) and all of its code.
 * @param {string | Buffer} binary the binary, or its text read as latin1
 * @returns {Omit<Steps, "version">}
 */
export function stepsOf(binary) {
  const t = textOf(binary);
  const found = readStep(t);
  if (!found) return { ...NOT_FOUND, textExtensions: [] };
  const { m: read, at: near } = found;
  const [, , , , extname, textSet, , split, , , , lexer, comments, walkFn] = read;
  const lexerAt = t.indexOf(`class ${lexer}{tokens;options;state;tokenizer;inlineQueue;constructor(`);
  const splitFn = nearestFunction(t, split, near);
  const sets = offsets(t, `${textSet}=new Set([`);
  const setAt = sets.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0];
  /** @type {string[]} */
  let textExtensions = [];
  if (setAt !== undefined) {
    const list = /^[\w$]+=new Set\((\[[^\]]*\])\)/.exec(t.slice(setAt, setAt + 8000))?.[1];
    try {
      const parsed = JSON.parse(list ?? "null");
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) textExtensions = [...parsed].sort();
    } catch {
      // not found
    }
  }
  const extnameOk = t.slice(near - 200_000, near + 200_000).includes(`extname as ${extname},`) || t.slice(near - 200_000, near + 200_000).includes(`extname as ${extname}}`);
  const fronts = offsets(t, `.indexOf("---",3)<0?null:`).flatMap((at) => {
    const w = t.slice(at - 300, at + 400);
    const m = FRONT_STEP.exec(w);
    return m ? [{ m, at: at - 300 + Math.max(0, /** @type {number} */ (m.index)) }] : [];
  });
  const front = fronts.length === 1 ? fronts[0] : null;
  const expr = front ? new RegExp(`[,;\\s]${front.m[6].replace(/\$/g, "\\$")}=(/\\^---[^\\n]{0,40}?/),`).exec(t.slice(front.at - 400, front.at))?.[1] : undefined;
  const bomFn = front ? nearestFunction(t, front.m[4], front.at) : null;
  const comment = nearestFunction(t, comments, near);
  const walked = nearestFunction(t, walkFn, near);
  // The bundled parser: its rules, compared with the pinned package's, and all of its code, with names numbered.
  const section = lexerSection(t, lexer);
  return {
    read: lexerAt !== -1 && extnameOk && splitFn && front && splitFn.includes(`=${front.m[1]}(`) ? codeHash(`${read[0]}\n${splitFn}`) : "not found",
    frontMatter: front && expr === FRONT_MATTER.toString() ? codeHash(`${front.m[0]}\n${expr}`) : "not found",
    bom: bomFn ? codeHash(bomFn) : "not found",
    comments: comment ? codeHash(comment) : "not found",
    walk: walked ? codeHash(walked) : "not found",
    parserRules: section ? rulesHash(ruleLiterals(section)) : "not found",
    parserCode: section ? codeHash(section) : "not found",
    textExtensions,
  };
}

/**
 * The binary's steps against the record's: lines that say what moved, none when they hold.
 * @param {string} file the binary @param {string} version its version @param {Steps} recorded
 */
export function stepsMoved(file, version, recorded) {
  const now = { version, ...stepsOf(readFileSync(file)) };
  return Object.entries(now).flatMap(([k, v]) => {
    const was = recorded[/** @type {keyof Steps} */ (k)];
    return JSON.stringify(v) === JSON.stringify(was) ? [] : [`${k}: ${JSON.stringify(v)}, recorded ${JSON.stringify(was)}`];
  });
}

/** The parser's rules against the ones Claude Code's bundle holds (the record's): a line when they differ. @param {string} source @param {Steps} recorded */
export function rulesMoved(source, recorded) {
  const mine = rulesHash(ruleLiterals(source));
  return mine === recorded.parserRules ? [] : [`marked ${PARSER.version}'s rules hash ${mine}; Claude Code's bundle holds ${recorded.parserRules}: pin the version whose rules are the bundle's`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude");
  const [cmd, ...args] = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  /** @type {Record} */
  const rec = readRecord();
  const write = (/** @type {Cell[]} */ cells, /** @type {Steps} */ claudeCode = rec.claudeCode) => writeFileSync(RECORD, recordText({ parser: `marked@${PARSER.version}`, claudeCode, cells }));
  /** The claude binary, said where it was found, or the run ends saying none was. */
  const claude = () => {
    const bin = claudeBinary(at === -1 ? "claude" : argv[at + 1]);
    if (!bin) {
      process.stderr.write(`no claude binary found (node_modules/.bin folders on PATH are skipped): point at one with --claude <path>\n`);
      process.exit(1);
    }
    return bin;
  };
  // The pinned package, its rules the bundle's, and every text lexed by it and by the parser the binary bundles: the
  // record is taken only where the two read alike.
  const parse = async () => {
    const { source } = await loadParser();
    const moved = rulesMoved(source, rec.claudeCode);
    if (moved.length) {
      process.stderr.write(`${moved.join("\n")}\n`);
      process.exit(1);
    }
    const bin = claude();
    const bundled = bundledLexer(readFileSync(bin.file));
    process.stdout.write(`claude: ${bin.path}${bin.file === bin.path ? "" : ` (${bin.file})`}\n`);
    if (!bundled) {
      process.stderr.write(`no bundled parser found in ${bin.file}: the pinned one was not compared with it\n`);
      process.exit(1);
    }
    return (/** @type {string[]} */ contents) => {
      const ours = lexInChild(source, contents);
      const off = lexersDisagree(contents, ours, lexInChild(bundled, contents));
      if (off.length) {
        process.stderr.write(`marked ${PARSER.version} reads ${off.length} text(s) otherwise than the parser ${bin.file} bundles: ${off.slice(0, 5).join(", ")}\n`);
        process.exit(1);
      }
      return ours;
    };
  };
  const problems = rec.cells.flatMap(cellProblems);
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  if (cmd === "add" && args[0]) {
    const probes = JSON.parse(readFileSync(args[0], "utf8"));
    const ids = new Set(rec.cells.map((c) => c.id));
    const refusedProbes = (Array.isArray(probes) ? probes : [null]).flatMap((p) => [...cellProblems(p), ...(p && ids.has(p.id) ? [`${nameOf(p)}: recorded already`] : []), ...(p && "md" in p ? [`${nameOf(p)}: the parser's reading is recorded, never given`] : [])]);
    if (refusedProbes.length) {
      process.stderr.write(`${refusedProbes.join("\n")}\n`);
      process.exit(1);
    }
    const { cells, refused } = readAll(probes, await parse());
    if (refused.length) {
      process.stderr.write(`${refused.join("\n")}\n`);
      process.exit(1);
    }
    write([...rec.cells, ...cells]);
    for (const c of cells) process.stdout.write(`added ${c.id}: ${JSON.stringify(c.md)}\n`);
  } else if (cmd === "show") {
    for (const { cell, got } of compareAll(rec.cells.filter((x) => !args.length || args.includes(x.id)), rec.claudeCode.textExtensions)) {
      process.stdout.write(`${cell.id} ${JSON.stringify(cell.md)}\n`);
      for (const [k, r] of got) if (r.relation !== "agree" || args.length) process.stdout.write(`  ${r.relation.padEnd(8)} ${JSON.stringify(k)}  Ennyn: ${JSON.stringify(r.ennyn)}  parser: ${JSON.stringify(r.md)}${cell.except?.[k] ? `  [${JSON.stringify(cell.except[k])}]` : ""}\n`);
    }
  } else if (cmd === "check" || cmd === "record") {
    const { cells, refused } = readAll(rec.cells, await parse());
    const moved = cells.filter((c, i) => JSON.stringify(c.md) !== JSON.stringify(rec.cells[i].md));
    if (refused.length) process.stderr.write(`${refused.join("\n")}\n`);
    if (cmd === "record") {
      if (refused.length) process.exit(1);
      write(cells);
      process.stdout.write(`recorded ${cells.length} cell(s) with marked ${PARSER.version}; ${moved.length} reading(s) moved: ${moved.map((c) => c.id).join(", ") || "none"}\n`);
    } else {
      for (const c of moved) process.stdout.write(`${c.id}: the parser now reads ${JSON.stringify(c.md)}\n  recorded ${JSON.stringify(rec.cells.find((x) => x.id === c.id)?.md)}\n`);
      process.stdout.write(moved.length ? "take the record again (node test/reference/markdown.mjs record), then run test/reference.test.mjs: it shows the comparisons that moved\n" : `marked ${PARSER.version} reads all ${cells.length} cell(s) as recorded, as the parser Claude Code bundles does\n`);
      process.exitCode = moved.length || refused.length ? 1 : 0;
    }
  } else if (cmd === "steps") {
    const bin = claude();
    const version = versionOf(bin.path);
    process.stdout.write(`claude: ${bin.path}${bin.file === bin.path ? "" : ` (${bin.file})`}, ${version}\n`);
    if (args.includes("--record")) {
      const now = { version, ...stepsOf(readFileSync(bin.file)) };
      if (Object.values(now).includes("not found") || !now.textExtensions.length) {
        process.stderr.write(`a step was not found in ${bin.file}: ${JSON.stringify(now)}\n`);
        process.exit(1);
      }
      write(rec.cells, now);
      process.stdout.write(`recorded Claude Code ${version}'s steps: ${JSON.stringify(now)}\n`);
    } else {
      const lines = stepsMoved(bin.file, version, rec.claudeCode);
      process.stdout.write(lines.length ? `${lines.join("\n")}\nClaude Code reads Markdown otherwise than the record models: compare its steps with mdReading and walk in test/reference/markdown.mjs, then node test/reference/markdown.mjs steps --record\n` : `Claude Code ${version}'s Markdown steps are the record's\n`);
      process.exitCode = lines.length ? 1 : 0;
    }
  } else {
    process.stderr.write("usage: node test/reference/markdown.mjs add <probes.json> | show [id…] | check | record | steps [--claude <bin>] [--record]\n");
    process.exit(2);
  }
}
