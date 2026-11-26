/**
 * A sentence that names another program at a version says what that program does there, and it names where
 * that was measured, which this test resolves (graph node measured-claim-names-cell, class
 * claim-outruns-evidence).
 *
 * Read: DESIGN.md, SECURITY.md, docs/*.md, and the leading comment block of every .mjs file under core/,
 * checks/, metrics/, impact/, plan/, setup/, side-copy/, adapters/ and scripts/. A unit is a paragraph, a list
 * item with its continuation lines or a table row (in a comment block, a paragraph); fenced code, headings and
 * HTML comments are none. A sentence ends at ".", "?" or "!" before a space or the end, and a table cell at "|",
 * outside code spans and parentheses.
 *
 * A version claim, read with whitespace (a line break, a no-break space) as one space and with code spans, link
 * targets, URLs and the quoted name after a pointer left out:
 * - every number of three or more dot-parted parts (a "p1" suffix kept), or of two with a program named in its
 *   sentence or earlier in its unit, or with an x part or a leading v ("2.1.330", "2.56", "2.1.x", "v0.1"),
 *   wherever it stands: after its program, after "version", in parentheses, in bold, in a list or a range, or
 *   sentences after the program;
 * - a one-part version right after a program of PROGRAMS, its possessive or "version" between ("Node 22",
 *   "npm 10", "Windows' 11", "husky 6 to 8").
 * Its program is the nearest one named before it in the sentence, else the last named earlier in the unit, else
 * none; "node" in lower case names Node only right before a version (elsewhere it is the graph's word). No word
 * beside a version ("measured", "in", "on", "since") decides: a word list may decide only in the safe direction.
 * The forms that are no claim, each in the reject corpus: a two-part number before a unit or size word that
 * starts no verb phrase (%, ×, "times the", s, ms, min, MB, bytes, "per cent", "per CPU", million), or whose first
 * part is 0 (a fraction: no program here has a version 0.x); after a sign or "=" ("+0.08", "ρ=0.14"); an arXiv
 * id; a four-part address ("127.0.0.1"); a two-part number in a unit that names no program ("a median 2.5"); a
 * one-part number before a unit. Three parts are a version whatever follows ("2.1.330 times out"). A sentence
 * that claims nothing measured (advice, an outside report, a project's own release) is on ALLOW by its place,
 * with why. Not read: a one-part version after a program the list does not name, a program misspelled.
 *
 * A pointer, a code span in the claim's own sentence:
 * - `test/<path>.test.mjs` "<title>": the file holds one test whose title, a plain string with its backticks left
 *   out, is or starts with it;
 * - `test/<path>.json`, alone or with "<cell id>": a record kept in the repository, which parses as JSON, and
 *   with an id holds that cell (a key of its `cells` object, or the `id` of an entry of its `cells` list or of
 *   the file's own list);
 * - `docs/evidence.md#<anchor>`: a section of docs/evidence.md.
 * A record holds a version only as a version value of its program: a string of dot-parted digits under the
 * program's key (`claudeCode`, `npm`, `git`, `node`), or under `version` inside it; a section holds the claims it
 * makes itself. A claim is held as written or as its family ("2.1" and "2.1.x" by "2.1.310", "npm 10" by
 * "10.9.9"; "2.1.330" not by "2.1.310"), and only for its own program. A claim whose program a record or section
 * of its sentence holds a version of must be held there: a test beside it does not lift that. Otherwise a test
 * holds a claim only when the test's body, from its title to the next top-level test, holds that version as
 * written or as its family (a test gated on that version, or one whose comments say it was measured there): a
 * test runs whatever version the machine has, so a body that only names the program holds no version. Its limit:
 * a version in a comment of the body is taken as said, not run.
 * An open range ("2.1 and later", "2.38+", "≥ 2.38") is held by nothing: it is written as a limit or allowed.
 * Or the sentence writes its limit, outside code spans, as "(not by a test: <where>)", <where> starting with
 * "no record" (nothing kept says how it was seen), a cycle from 1 up ("cycle 22": that cycle's commits hold the
 * measurement) or a code span naming a file under test/ (a record, the Linux run's script). A limit covers the
 * claims before it in its sentence; a pointer beside it is still resolved.
 * A claim held by none of these fails, and so does every pointer of these shapes in it that resolves to nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sentences that name a version and claim no measurement, each with why, by place: the sentence that holds the
 * words `at`, which the file holds once. An entry whose words the file holds other than once, or whose sentence
 * names no version, fails: the list holds only what the scan uses.
 * @type {{ file: string, at: string, why: string }[]}
 */
const ALLOW = [
  { file: "SECURITY.md", at: "the test suite passes on Ubuntu 22.04 with git 2.34.1", why: "a support statement: the whole suite's run on the floor image (npm run test:linux, before a release), which no file in the repository records" },
  { file: "SECURITY.md", at: "Measured there instead, by hand (cycle 23", why: "a hand measurement on Windows that the sentence names as one, with its cycle and commit; no test runs on native Windows" },
  { file: "SECURITY.md", at: "Use git 2.38 or newer in a clone you do not trust.", why: "advice resting on the sentence before it, which names its test" },
  { file: "docs/modules.md", at: "Not seen: what runs before the file (husky 9's runner", why: "a list of what the hook does not see: it claims nothing husky 9 was measured to do" },
  { file: "SECURITY.md", at: "in such a folder on 2.34.1 that is unmeasured", why: "the sentence says the case is unmeasured; it claims nothing measured" },
  { file: "DESIGN.md", at: "caveman's 3.1.0 release notes", why: "another project's release, an outside report the sentence names as one" },
  { file: "DESIGN.md", at: "- **v0.1** — core modules", why: "Ennyn's own planned release, no program measured" },
  { file: "DESIGN.md", at: "- **v0.2** — Codex manifest", why: "Ennyn's own planned release, no program measured" },
  { file: "DESIGN.md", at: "- **v1.0** — stable config", why: "Ennyn's own planned release, no program measured" },
  { file: "docs/acceptance.md", at: "the second half of 0.1.0", why: "Ennyn's own release, no program measured" },
  { file: "plugin/checks/deps.mjs", at: "react 19.0.9 0.00%", why: "a package version in a download sample, the data the calibration read, not a program's behaviour" },
  { file: "docs/modules.md", at: "Not seen: `GIT_EDITOR=:` set by the user", why: "a list of what the reader does not see: it claims nothing measured" },
  { file: "docs/modules.md", at: "a drive letter's case and an 8.3 name are one folder on Windows", why: "an 8.3 name is the short file-name form, no version" },
  { file: "docs/related-work.md", at: "did nothing from v1.65.0 until v2.2.4", why: "another project's releases, from its public history, an outside report" },
  { file: "docs/related-work.md", at: "Secondary sources report it fixed in Claude Code 2.1.179", why: "an outside report the sentence gives as one, beside the changelog that does not say it; no measurement is claimed" },
];

/** Programs a one-part version may follow; the longer name first, so "Git for Windows 10" is not "Git". */
const PROGRAMS = ["Claude Code", "Git for Windows", "Windows PowerShell", "PowerShell", "git", "Git", "Node.js", "Node", "npm", "OpenSSH", "ssh-keygen", "macOS", "pwsh", "Windows", "Ubuntu", "Debian", "bash", "zsh", "gpg", "gh", "husky", "Husky"];
/** A program named anywhere, for the program of a version: the list, "gits", and "node" in lower case right before a version. */
const NAMED = new RegExp(String.raw`(?<![\w.-])(${[...PROGRAMS, "gits"].join("|").replace(/\./g, "\\.")}|node(?= v?\d))(?![\w-])`, "g");
/** The one name a program goes by. @param {string} name */
const canon = (name) => ({ Git: "git", gits: "git", "Node.js": "Node", node: "Node", Husky: "husky" })[name] ?? name;
/** A dot-parted number: not inside a word, a path, an address or a signed number; a hyphen between two is a range. */
const DOTTED = /(?<![A-Za-z0-9.\/@#:=+−~±])(?<!(?<!\d)-)v?\d+(?:\.(?:\d+|x))+(?:p\d+)?(?![A-Za-z0-9\/]|-(?!\d)|\.\d)/g;
const ONE_PART = new RegExp(String.raw`(?<![\w.-])(?:${PROGRAMS.join("|").replace(/\./g, "\\.")})(?: |\*\*|['’]s?)*(?:version |v)?(\d+(?:(?:,? and |, | to | or | through |[–-])\d+)*)(?![\w.-]|\.\d)`, "g");
/** What makes a two-part number no version: a unit or a size word after it that starts no verb phrase. */
const UNIT = /^\s?(?:%|×|times (?:the|as|more|less|larger|smaller|faster|slower)\b|s\b|ms\b|min\b|h\b|[KMGT]i?B\b|bytes?\b|per cent\b|per (?:logical )?CPU\b|percent\b|seconds?\b|minutes?\b|hours?\b|million\b|billion\b|thousand\b)/;
/** An open range after a version, or before it. */
const OPEN_AFTER = /^\**\s?(?:\+(?!\d)|and later\b|or later\b|and newer\b|or newer\b|and above\b|or above\b)/;
const OPEN_BEFORE = /(?:≥|>=)\s?$/;
/** The written limit, in a sentence with its code spans blank: its <where> is checked apart. */
const LIMIT = /\(not by a test: ([^()]*(?:\([^()]*\)[^()]*)*)\)/;
const SPAN = /`[^`\n]+`/g;
/** A code span with the quoted name a pointer may carry. */
const POINTED = /`[^`\n]+`(?:\s*"[^"\n]*")?/g;
const LINK = /\]\([^)\n]*\)/g;
const URL = /<?https?:\/\/[^\s)>]+>?/g;

/** A text of the same length with every character but line ends blank. @param {string} s */
const blank = (s) => s.replace(/[^\n]/g, " ");
/** Code spans blanked, so the rest keeps its places. @param {string} text */
const mask = (text) => text.replace(SPAN, blank);

/** @typedef {{ version: string, program: string | null, open: boolean, at: number }} Claim */

/**
 * The versions a sentence claims, each with its program and whether it opens a range.
 * @param {string} text the sentence
 * @param {string} [before] the unit's text before the sentence, where an earlier program may stand
 * @returns {Claim[]}
 */
function claimsIn(text, before = "") {
  const plain = text.replace(POINTED, blank).replace(LINK, blank).replace(URL, blank).replace(/\s/g, " ");
  const prior = before.replace(POINTED, blank).replace(/\s/g, " ");
  const named = [...plain.matchAll(NAMED)];
  const earlier = [...prior.matchAll(NAMED)].at(-1);
  /** @param {number} at */
  const programOf = (at) => {
    const own = named.filter((n) => /** @type {number} */ (n.index) + n[0].length <= at).at(-1);
    return own ? canon(own[1]) : earlier ? canon(earlier[1]) : null;
  };
  /** @type {Claim[]} */
  const out = [];
  for (const m of plain.matchAll(DOTTED)) {
    const at = /** @type {number} */ (m.index);
    const after = plain.slice(at + m[0].length);
    const parts = m[0].replace(/^v/, "").split(".");
    if ((parts.length === 2 && UNIT.test(after)) || /arXiv\s?$/.test(plain.slice(0, at))) continue;
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)) continue;
    if (parts.length === 2 && !m[0].startsWith("v") && !parts.includes("x") && (parts[0] === "0" || (named.length === 0 && !earlier))) continue;
    out.push({ version: parts.join("."), program: programOf(at), open: OPEN_AFTER.test(after) || OPEN_BEFORE.test(plain.slice(0, at)), at });
  }
  for (const m of plain.matchAll(ONE_PART)) {
    const at = /** @type {number} */ (m.index) + m[0].length - m[1].length;
    if (UNIT.test(plain.slice(at + m[1].length))) continue;
    for (const v of m[1].split(/,? and |, | to | or | through |[–-]/)) {
      out.push({ version: v, program: programOf(at), open: OPEN_AFTER.test(plain.slice(at + m[1].length)), at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Where a sentence writes its limit: each "(not by a test: <where>)" outside code spans whose <where> starts with
 * "no record", a cycle ("cycle 27", from 1 up) or a code span naming a file under test/ (a record, the Linux
 * run's script). Each covers the claims before it in the sentence.
 * @param {string} root @param {string} text
 * @returns {number[]} where each limit ends
 */
function limitsIn(root, text) {
  const flat = text.replace(/\s/g, " ");
  /** @type {number[]} */
  const out = [];
  for (const m of mask(flat).matchAll(new RegExp(LIMIT.source, "g"))) {
    const at = /** @type {number} */ (m.index);
    const where = flat.slice(at + "(not by a test: ".length, at + m[0].length - 1);
    const span = /^`([^`]+)`/.exec(where)?.[1];
    const named = span !== undefined && /^test\/[\w./-]+$/.test(span) && !span.split("/").includes("..") && existsSync(join(root, span)) && statSync(join(root, span)).isFile();
    if (/^no record\b|^cycle [1-9]\d*\b/.test(m[1]) || named) out.push(at + m[0].length);
  }
  return out;
}

/**
 * The sentences of a unit: a sentence ends at ".", "?" or "!" before a space or the end, and a table cell at
 * "|", outside code spans and parentheses.
 * @param {string} text
 * @returns {string[]}
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
      out.push(text.slice(from, i + 1));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.filter((s) => s.trim());
}

/**
 * The units of a markdown text.
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
function units(text) {
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  /** @type {{ line: number, text: string } | null} */
  let cur = null;
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
      if (/^#{1,6} /.test(line) || !line.trim()) return flush();
      const unit = { line: i + 1, text: line };
      if (/^\s*\|/.test(line)) return flush(), void out.push(unit);
      if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) return flush(), void (cur = unit);
      if (cur) cur.text += `\n${line}`;
      else cur = unit;
    });
  flush();
  return out;
}

/**
 * The paragraphs of a module's leading comment block (after a shebang), with their lines; a module whose first
 * text is no `/*` comment has none.
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
function header(text) {
  const m = /^(#![^\n]*\n)?(\s*)\/\*\*?([\s\S]*?)\*\//.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return [];
  const first = (m[1] ? 1 : 0) + (m[2].match(/\n/g) ?? []).length + 1;
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  /** @type {{ line: number, text: string } | null} */
  let cur = null;
  m[3].split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s*\* ?/, "");
    if (!line.trim()) {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) cur.text += `\n${line}`;
    else cur = { line: first + i, text: line };
  });
  if (cur) out.push(cur);
  return out;
}

/** A heading's anchor as GitHub writes it. @param {string} heading */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

/**
 * The text of a markdown section, from its heading to the next heading of the same or a higher level, or null.
 * @param {string} text @param {string} anchor
 */
function sectionText(text, anchor) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const level = (/** @type {string} */ l) => /^(#{1,6}) /.exec(l)?.[1].length ?? 0;
  const at = lines.findIndex((l) => level(l) > 0 && slug(l.replace(/^#+ /, "")) === anchor);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && level(l) > 0 && level(l) <= level(lines[at]));
  return lines.slice(at, end < 0 ? lines.length : end).join("\n");
}

/**
 * The tests of a test file: each title, as a plain string (a template with a placeholder is none), and its body,
 * from the title to the next top-level test.
 * @param {string} text
 */
function tests(text) {
  const re = /(?<![\w$])(?:\w+\.)?(?:test|it|describe)\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`)/g;
  return [...text.matchAll(re)].map((m) => {
    const at = /** @type {number} */ (m.index);
    const next = text.slice(at + 1).search(/\n(?:test|describe)\(/);
    return { title: (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, "$1").replace(/`/g, ""), body: text.slice(at, next < 0 ? text.length : at + 1 + next) };
  });
}

/** Whether a test's body holds a version as written (a test gated on it or reading its record); an x part stands for any number. @param {string} body @param {string} version */
const inBody = (body, version) => new RegExp(String.raw`(?<![\w.])${version.replace(/\./g, "\\.").replace(/x/g, "\\d+")}(?![\w])`).test(body);
/** The record key that names a program's version. */
const KEY = /** @type {Record<string, string>} */ ({ claudeCode: "Claude Code", npm: "npm", git: "git", node: "Node" });

/**
 * The versions a record holds as version values: a string of dot-parted digits under a program's key, or under
 * `version` inside it.
 * @param {unknown} data
 * @returns {{ version: string, program: string }[]}
 */
function recordVersions(data) {
  /** @type {{ version: string, program: string }[]} */
  const out = [];
  /** @param {unknown} v @param {string} key @param {string} parent */
  const walk = (v, key, parent) => {
    if (typeof v === "string" && /^v?\d+(?:\.\d+)+$/.test(v)) {
      const program = KEY[key] ?? (key === "version" ? KEY[parent] : undefined);
      if (program) out.push({ version: v.replace(/^v/, ""), program });
    } else if (v && typeof v === "object") for (const [k, w] of Object.entries(v)) walk(w, Array.isArray(v) ? key : k, Array.isArray(v) ? parent : key);
  };
  walk(data, "", "");
  return out;
}

/** Whether a version held stands for the one claimed, as written or in its family. @param {Claim} c @param {{ version: string, program: string | null }} h */
const holds = (c, h) => c.program !== null && h.program === c.program && new RegExp(String.raw`^${c.version.replace(/\./g, "\\.").replace(/x/g, "\\d+")}(?:\.|$)`).test(h.version);

/**
 * Resolve one code span of a claim's sentence: not a pointer (null), a test (its body), a place (the versions
 * it holds), or why it names nothing.
 * @param {string} root @param {string} span @param {string} after the text after the span
 * @returns {{ why?: string, body?: string, held?: { version: string, program: string | null }[] } | null}
 */
function resolve(root, span, after) {
  const named = /^\s*"([^"\n]+)"/.exec(after)?.[1];
  const read = (/** @type {string} */ path) => {
    if (path.split("/").includes("..")) return null;
    const full = join(root, path);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
  };
  if (/^test\/[\w./-]+\.test\.mjs$/.test(span)) {
    const text = read(span);
    if (text === null) return { why: `${span} does not exist` };
    if (!named) return { why: `${span} names no test: write its title after it in quotes` };
    const hit = tests(text).filter((t) => t.title.startsWith(named));
    return hit.length === 1 ? { body: hit[0].body } : { why: `${span}: "${named}" starts ${hit.length} test titles, not one` };
  }
  if (/^test\/[\w./-]+\.json$/.test(span)) {
    const text = read(span);
    if (text === null) return { why: `${span} does not exist` };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { why: `${span} is no JSON` };
    }
    if (named !== undefined) {
      const cells = Array.isArray(data) ? data : data?.cells;
      const has = Array.isArray(cells) ? cells.some((c) => c?.id === named) : !!cells && typeof cells === "object" && Object.hasOwn(cells, named);
      if (!has) return { why: `${span} holds no cell "${named}"` };
    }
    return { held: recordVersions(data) };
  }
  const evidence = /^docs\/evidence\.md(?:#([\w-]+))?$/.exec(span);
  if (evidence) {
    const text = read("docs/evidence.md");
    if (text === null) return { why: "docs/evidence.md does not exist" };
    if (!evidence[1]) return { why: `${span} names no section: write its anchor` };
    const section = sectionText(text, evidence[1]);
    if (section === null) return { why: `${span}: no heading has that anchor` };
    return { held: units(section).flatMap((u) => sentences(u.text).flatMap((s) => claimsIn(s))) };
  }
  return null;
}

/**
 * Every claim no pointer of its sentence holds, in the given files of a root.
 * @param {string} root @param {string[]} files @param {{ file: string, at: string }[]} allow
 */
function check(root, files, allow = []) {
  /** @type {string[]} */
  const problems = [];
  const used = new Set();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const u of file.endsWith(".md") ? units(text) : header(text)) {
      let before = "";
      for (const s of sentences(u.text)) {
        const claims = claimsIn(s, before);
        before += s;
        if (claims.length === 0) continue;
        const where = `${file}:${u.line}`;
        const said = s.replace(/\s+/g, " ").trim().slice(0, 90);
        const allowed = allow.find((a) => a.file === file && s.replace(/\s+/g, " ").includes(a.at));
        if (allowed) {
          used.add(allowed);
          continue;
        }
        /** @type {{ version: string, program: string | null }[]} */
        const held = [];
        /** @type {string[]} */
        const bodies = [];
        let wrong = false;
        for (const m of s.matchAll(SPAN)) {
          const got = resolve(root, m[0].slice(1, -1), s.slice(/** @type {number} */ (m.index) + m[0].length));
          if (got === null) continue;
          if (got.why) {
            problems.push(`${where}: ${got.why}`);
            wrong = true;
          } else if (got.body !== undefined) bodies.push(got.body);
          else held.push(...(got.held ?? []));
        }
        if (wrong) continue;
        const limits = limitsIn(root, s);
        for (const c of claims) {
          if (limits.some((end) => end > c.at)) continue;
          const name = `${c.program ?? "no program"} ${c.version}`;
          if (c.open) problems.push(`${where}: ${name} opens a range no test or record holds: write its limit: "${said}"`);
          else if (held.some((h) => h.program === c.program)) {
            if (!held.some((h) => holds(c, h))) problems.push(`${where}: ${name} is not the version the record or section beside it holds: "${said}"`);
          } else if (!bodies.some((b) => inBody(b, c.version))) {
            problems.push(`${where}: ${name} is held by no test, record or evidence section the sentence names: "${said}"`);
          }
        }
      }
    }
  }
  for (const a of allow) {
    const text = files.includes(a.file) ? readFileSync(join(root, a.file), "utf8").replace(/\s+/g, " ") : "";
    if (text.split(a.at).length !== 2) problems.push(`${a.file}: the allowed place "${a.at}" is there ${text.split(a.at).length - 1} times, not once`);
    else if (!used.has(a)) problems.push(`${a.file}: the allowed "${a.at}" is in no sentence that names a version`);
  }
  return problems;
}

/** The files the gate reads. @param {string} root */
function scope(root) {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".mjs") ? [`${dir}/${e.name}`] : []));
  const docs = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`);
  const modules = ["core", "checks", "metrics", "impact", "plan", "setup", "side-copy", "adapters", "scripts"].map((d) => `plugin/${d}`).flatMap(walk);
  return ["DESIGN.md", "SECURITY.md", ...docs, ...modules].sort();
}

test("measured claims: every sentence in DESIGN.md, SECURITY.md, docs and module headers that names a program at a version names where it was measured", (t) => {
  const files = scope(ROOT);
  assert.ok(files.includes("docs/modules.md") && files.includes("plugin/core/git.mjs") && files.length > 40, `the scope read ${files.length} files`);
  const problems = check(ROOT, files, ALLOW);
  for (const p of problems) t.diagnostic(p);
  assert.equal(problems.length, 0, `${problems.length} sentences or pointers fail: the diagnostics name each`);
});

test("measured claims: what counts as a version claim", () => {
  const read = (/** @type {string} */ text, before = "") => claimsIn(text, before).map((c) => `${c.program ?? "-"} ${c.version}${c.open ? "+" : ""}`);
  /** @type {[string, string[]][]} */
  const accept = [
    ["measured on git 2.56.0 and 2.34.1 with OpenSSH 10.5", ["git 2.56.0", "git 2.34.1", "OpenSSH 10.5"]],
    ["In Claude Code 2.1.310 a hold of idle compaction removes that compaction", ["Claude Code 2.1.310"]],
    ["(git 2.34.1, 2.39.5 and 2.56.0, measured)", ["git 2.34.1", "git 2.39.5", "git 2.56.0"]],
    ["read as npm 10 reads them", ["npm 10"]],
    ["Git for Windows 2.47.1 deletes through a junction", ["Git for Windows 2.47.1"]],
    ["Node 22.23 on Windows 10 and on Linux", ["Node 22.23", "Windows 10"]],
    ["any Claude Code 2.1.x does it", ["Claude Code 2.1.x"]],
    ["Windows PowerShell 5.1 and PowerShell 7.4 take it", ["Windows PowerShell 5.1", "PowerShell 7.4"]],
    ["husky 6 to 8 run it twice", ["husky 6", "husky 8"]],
    ["the macOS 15 sandbox", ["macOS 15"]],
    ["git v2.45.0 reads it", ["git 2.45.0"]],
    // The program earlier in the sentence, or in an earlier sentence of the unit; the version in any wording.
    ["Claude Code keeps a file with these values, measured on 2.1.310 and 2.1.319.", ["Claude Code 2.1.310", "Claude Code 2.1.319"]],
    ["That holds on the gits measured, 2.39.5, 2.50 and 2.56.", ["git 2.39.5", "git 2.50", "git 2.56"]],
    ["Claude Code, in the version measured (2.1.207), runs npm ci.", ["Claude Code 2.1.207"]],
    ["Claude Code's 2.1.330 binary stops it.", ["Claude Code 2.1.330"]],
    ["Claude Code (2.1.330) stops it.", ["Claude Code 2.1.330"]],
    ["git version 2.56.0 refuses it.", ["git 2.56.0"]],
    ["node 22.0 hides ENOENT.", ["Node 22.0"]],
    ["Claude Code\n2.1.330 stops it.", ["Claude Code 2.1.330"]],
    ["Claude Code 2.1.330 stops it.", ["Claude Code 2.1.330"]],
    ["Claude Code **2.1.330** stops it.", ["Claude Code 2.1.330"]],
    ["git 2.34.1 through 2.99.0 refuse it", ["git 2.34.1", "git 2.99.0"]],
    ["git 2.34–2.56 refuse it", ["git 2.34", "git 2.56"]],
    ["git 2.34-2.56 refuse it", ["git 2.34", "git 2.56"]],
    ["(70 cells, 2.1.310) hold it", ["- 2.1.310"]],
    ["Claude Code 2.1 and later stop it", ["Claude Code 2.1+"]],
    ["git 2.38+ refuses it", ["git 2.38+"]],
    ["git ≥ 2.38 refuses it", ["git 2.38+"]],
    ["the roadmap's **v0.1** item", ["- 0.1"]],
    ["one call took 1.3 on git", ["- 1.3"]],
    ["Node\n22 hides it", ["Node 22"]],
    ["npm\u00a010 reads it", ["npm 10"]],
    ["Claude Code version 22 runs", ["Claude Code 22"]],
    ["Claude Code starts the hook with node, and 2.1.999 stops it", ["Claude Code 2.1.999"]],
    ["Claude Code 2.1.330 times out the hook after a minute.", ["Claude Code 2.1.330"]],
    ["Claude Code 2.1.330 per session keeps one transcript.", ["Claude Code 2.1.330"]],
    ["Windows' 11 build deletes it.", ["Windows 11"]],
    ["Debian 12 git reads it.", ["Debian 12"]],
    ["OpenSSH 10.5p1 refuses it.", ["OpenSSH 10.5p1"]],
    ["Husky 9 runs it.", ["husky 9"]],
    ["git reads it in 2024.05 builds.", ["git 2024.05"]],
    ["the 1-minute load over 1.5 on macOS hosts", ["- 1.5"]],
  ];
  for (const [text, want] of accept) assert.deepEqual(read(text), want, text);
  assert.deepEqual(read("Measured on 2.1.330.", "Claude Code stops it. "), ["Claude Code 2.1.330"], "a program of an earlier sentence of the unit");
  assert.deepEqual(read("That holds on 2.50 and 2.56.", "Git does not delete the folder. "), ["git 2.50", "git 2.56"], "a two-part version whose program an earlier sentence names");
  /** @type {string[]} */
  const reject = [
    "the `node:22` container",
    "run `git 2.34.1` there",
    "Claude Code's changelog does not mention it",
    "arXiv 2503.15223 says so",
    "see [the notes](https://example.test/git 2.34.1)",
    "the graph node 22 holds it",
    "legit 2.3 is no program",
    "Node's `rmSync` unlinks a link",
    "git 2-way merges",
    "see [the notes](docs/git 2.34.1.md)",
    "see https://example.test/git/2.34.1 there",
    // The forms that are no version: a unit or a size word, a sign, an address, a two-part number with no program.
    "a record 3.25 times the size",
    "git took 1.3 s",
    "1.98 bytes per token",
    "git ran a median 27.3 million tokens",
    "a git run 3.5 times the size",
    "git load over 1.5 per logical CPU",
    "git keeps 0.9 of the hour",
    "a diff past git's 64 MB buffer",
    "12.7% of git runs",
    "recall +0.08 and ρ=0.14 on git",
    "served from 127.0.0.1 by npm",
    "clamped to 0.5 to 0.95",
    "robustness fell from 96.7 to 82.5",
    "`test/a.test.mjs` \"husky 9.1.7's stub\" names it",
    "arXiv 2503.15223 on git",
    "a change of -0.14 on git",
  ];
  for (const text of reject) assert.deepEqual(read(text), [], text);
  assert.deepEqual(
    units("# T\n\n```\ngit 2.34.1 does it\n```\n\n## git 2.56.0 heading\n\n<!-- git 2.39 -->\n\nText.\n").map((u) => u.text),
    ["Text."],
    "fenced code, headings and comments are no unit",
  );
  assert.deepEqual(
    header("#!/usr/bin/env node\n/**\n * First, git 2.34.1 does it.\n *\n * Second\n * line.\n */\n/** not the header, git 2.56.0 */\n"),
    [
      { line: 3, text: "First, git 2.34.1 does it." },
      { line: 5, text: "Second\nline." },
    ],
    "the leading block alone, by paragraph, with its lines",
  );
  assert.deepEqual(header('import x from "y";\n/** git 2.34.1 */\n'), [], "a module whose first text is code has no header");
  assert.deepEqual(sentences("One (git 2.34.1. Two) three. `a. b` four | five"), ["One (git 2.34.1. Two) three.", " `a. b` four |", " five"]);
});

test("measured claims: what counts as a pointer, and what the test reads at it", () => {
  const root = mkdtempSync(join(tmpdir(), "claims-"));
  for (const d of ["docs", "test", "test/reference"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(
    join(root, "test", "a.test.mjs"),
    [
      'test("a: git refuses a bare folder", () => { if (versionAtLeast("2.38")) git(["init"]); });',
      "test('a: git refuses another', () => { git([\"status\"]); }); // from 2.38",
      "t.test(`a: inner case`, () => { git([\"log\"]); }); // 2.38",
      "test(`a: ${x} templated`, () => {});",
      'test("a: the `-c` flag is empty", () => { git(["-c", "core.fsmonitor="]); }); // 2.38',
      'test("a: machineFault: by shape", () => { git(["rev-parse"]); });',
      'test("a: rules-index: a rule\'s paths name a path as Claude Code matches them", () => { match(); });',
      'test("a: husky 9.1.7\'s stub", () => { husky(); });',
      'test("a: the claude record", () => { readFileSync("claude.json"); });',
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "test", "core.test.mjs"), 'test("files: nothing there is false or null", () => { statSync("x"); });\ntest("files: Node 22.0 throws ENOTDIR", () => { statSync("x"); });\n');
  writeFileSync(join(root, "test", "reference", "npm.json"), JSON.stringify({ npm: { npm: "10.9.9", arborist: "8.0.5" }, cells: [{ id: "c", resolved: "other-evil-6.6.6.tgz" }] }));
  writeFileSync(join(root, "test", "reference", "pretooluse.json"), JSON.stringify({ claudeCode: "2.1.310", cells: { "deny-stops": { n: "15" } } }));
  writeFileSync(join(root, "test", "reference", "md.json"), JSON.stringify({ claudeCode: { version: "2.1.310" }, cells: [] }));
  writeFileSync(join(root, "test", "reference", "list.json"), JSON.stringify([{ id: "plain-push", text: "git push" }]));
  writeFileSync(join(root, "test", "reference", "broken.json"), "{");
  writeFileSync(join(root, "docs", "x.json"), "{}");
  writeFileSync(join(root, "docs", "evidence.md"), "# E\n\n## Git floor\n\nRun on git 2.34.1 and 2.56.0.\n\n## Floor only\n\nRun on git 2.34.1.\n\n## Other\n\nNothing, 2.1.310.\n");
  const one = (/** @type {string} */ text) => {
    writeFileSync(join(root, "docs", "u.md"), text);
    return check(root, ["docs/u.md"]);
  };
  const NONE = /is held by no test, record or evidence section/;
  const OTHER = /is not the version the record or section beside it holds/;
  /** @type {string[]} */
  const accept = [
    'git 2.38 refuses a bare folder (`test/a.test.mjs` "a: git refuses a bare folder").',
    'git 2.38 refuses a bare folder (`test/a.test.mjs` "a: git refuses a bare").',
    'git 2.38 refuses it (`test/a.test.mjs` "a: git refuses another").',
    'git 2.38 refuses it (`test/a.test.mjs` "a: inner case").',
    'git 2.38 refuses it (`test/a.test.mjs` "a: the -c flag is empty").',
    'husky 9 puts it first (`test/a.test.mjs` "a: husky 9.1.7\'s stub").',
    'Node 22.0 hides ENOENT (`test/core.test.mjs` "files: Node 22.0").',
    'Node 22 hides ENOENT (`test/core.test.mjs` "files: Node 22.0").',
    "Claude Code 2.1.310 stops the call (`test/reference/pretooluse.json`).",
    'Claude Code 2.1.310 stops the call (`test/reference/pretooluse.json` "deny-stops").',
    "Claude Code 2.1.310 stops the call (`test/reference/md.json`).",
    "Claude Code 2.1.x stops the call (`test/reference/pretooluse.json`).",
    "Claude Code 2.1 stops the call (`test/reference/pretooluse.json`).",
    "npm 10 reads it (`test/reference/npm.json`).",
    "Claude Code 2.1.310 stops it (`test/reference/list.json`; `test/reference/pretooluse.json`).",
    'Claude Code 2.1.310 stops it (`test/reference/pretooluse.json`; `test/a.test.mjs` "a: the claude record").',
    "Claude Code stops it. Measured on 2.1.310 (`test/reference/pretooluse.json`).",
    "Claude Code\n2.1.310 stops it (`test/reference/pretooluse.json`).",
    "git 2.34.1 and 2.56.0 both do it (`docs/evidence.md#git-floor`).",
    "git 2.34.1 does it (not by a test: no record).",
    "git 2.34.1 does it (not by a test: no record kept of the run).",
    "git 2.34.1 does it (not by a test: cycle 9 review).",
    "git 2.34.1 does it (not by a test:\nno record).",
    "git 2.34.1 does it (not by a test: `test/reference/list.json` holds the run).",
    "Claude Code 2.1.310 and 2.1.330 stop the call (`test/reference/pretooluse.json`; 2.1.330 (not by a test: no record)).",
    "git 2.56.0 refuses it (not by a test: no record), and git 2.34.1 too (not by a test: cycle 4).",
    "No version here, `test/missing.test.mjs` nor a pointer.",
    'Two sentences. git 2.38 refuses it (`test/a.test.mjs` "a: git refuses another"). A third with `test/a.test.mjs` alone.',
    '| key | git 2.38 refuses it, `test/a.test.mjs` "a: inner case" | other cell |',
    "The `git 2.34.1` code span claims nothing.",
    "A median of 2.5 runs, 3.25 times the size.",
  ];
  /** @type {[string, RegExp][]} */
  const reject = [
    ["git 2.38 refuses a bare folder.", NONE],
    ["git 2.38 refuses it, measured in cycle 23.", NONE],
    ["git 2.38 refuses it (`checks/deps.mjs`).", NONE],
    ["git 2.38 refuses it (`test/a.test.mjs`).", /test\/a\.test\.mjs names no test/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: no such test").', /"a: no such test" starts 0 test titles/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: git refuses").', /"a: git refuses" starts 2 test titles/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: ").', /starts 8 test titles/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: x templated").', /starts 0 test titles/],
    ['git 2.38 refuses it (`test/missing.test.mjs` "a").', /test\/missing\.test\.mjs does not exist/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: husky 9.1.7").', NONE],
    ['npm 10 refuses it (`test/a.test.mjs` "a: git refuses another").', NONE],
    ['Windows 10 refuses it (`test/a.test.mjs` "a: git refuses another").', NONE],
    ["Claude Code 2.1.310 stops it (`test/reference/missing.json`).", /does not exist/],
    ["Claude Code 2.1.310 stops it (`test/reference/broken.json`).", /is no JSON/],
    ['Claude Code 2.1.310 stops it (`test/reference/pretooluse.json` "no-such-cell").', /holds no cell "no-such-cell"/],
    ['Claude Code 2.1.310 stops it (`test/reference/list.json` "no-such-cell").', /holds no cell "no-such-cell"/],
    ["Claude Code 2.1.310 and 2.1.330 stop it (`test/reference/pretooluse.json`).", /Claude Code 2\.1\.330 is not the version/],
    ['Claude Code 2.1.310 stops it (`test/reference/list.json` "plain-push").', NONE],
    ["Claude Code 2.1.31 stops it (`test/reference/pretooluse.json`).", OTHER],
    ["npm 10.8 reads it (`test/reference/npm.json`).", OTHER],
    ["npm 8 reads it (`test/reference/npm.json`).", OTHER],
    ["npm 6 reads it (`test/reference/npm.json`).", OTHER],
    ["git 2.39.5 does it (`docs/evidence.md#git-floor`).", OTHER],
    ["git 2.34.1 does it (`docs/evidence.md#other`).", NONE],
    ["Claude Code 2.1.310 does it (`docs/evidence.md#other`).", NONE],
    ["git 2.34.1 does it (`docs/evidence.md#no-such`).", /no heading has that anchor/],
    ["git 2.34.1 does it (`docs/evidence.md`).", /names no section/],
    ["git 2.34.1 does it (`test/../docs/x.json`).", /does not exist/],
    ["| a | b |\n| git 2.38 refuses it | c |", /^docs\/u\.md:2: git 2\.38 is held by no/],
    ['git 2.38 refuses it (`test/a.test.mjs` "a: git refuses another"; `test/reference/missing.json`).', /does not exist/],
    ["Measured (`test/reference/pretooluse.json`). Then git 2.34.1 does it.", NONE],
    ["git 2.34.1 does it, not by a test.", NONE],
    ["git 2.34.1 does it, not by a test: by hand.", NONE],
    ["git 2.34.1 does it (read so, not by a test: by hand).", NONE],
    ["Claude Code 2.1.330 stops it (`(not by a test: by hand)`).", NONE],
    ["Claude Code 2.1.330 stops it (`(not by a test: no record)`).", NONE],
    ['Claude Code 2.1.310 stops it (`test/a.test.mjs` "a: husky 9.1.7").', NONE],
    ["git 2.34.1 does it. Not by a test, the next one.", NONE],
    ["git 2.34.1 does it (not by a test: somewhere).", NONE],
    ["git 2.34.1 does it (not by a test: by hand).", NONE],
    ["git 2.34.1 does it (not by a test: `docs/x.json`).", NONE],
    ["git 2.34.1 does it (not by a test: `test/reference/missing.json`).", /does not exist/],
    ["git 2.34.1 does it (not by a test: `test/missing-run.mjs`).", NONE],
    ['git 9.9.9 deletes the home folder (`test/a.test.mjs` "a: machineFault: by shape").', NONE],
    ['Claude Code 9.9.9 deletes the home folder (`test/a.test.mjs` "a: rules-index: a rule\'s paths").', NONE],
    ['Node 99.1 deletes the home folder (`test/core.test.mjs` "files: nothing there").', NONE],
    ['Claude Code starts the hook with node, and 2.1.999 stops it (`test/core.test.mjs` "files: nothing there").', NONE],
    ["Claude Code 2.1.330 times out the hook after a minute.", NONE],
    ["Claude Code 2.1.330 per session keeps one transcript.", NONE],
    ["Git does not delete the folder. That holds on 2.50 and 2.56.", NONE],
    ["Claude Code 2.1.330 stops it (not by a test: `README.md`).", NONE],
    ["Claude Code 2.1.330 stops it (not by a test: nobody checked by hand).", NONE],
    ["Claude Code 2.1.330 stops it (not by a test: cycle 0).", NONE],
    ["git 2.56.0 refuses it (not by a test: no record), and Claude Code 9.9.9 deletes the home folder.", /Claude Code 9\.9\.9 is held by no/],
    ["Windows' 11 build deletes it.", NONE],
    ["OpenSSH 10.5p1 refuses it.", NONE],
    ["Husky 9 runs it.", NONE],
    ["npm 8 does it (not by a test: `test/a.test.mjs`).", /names no test/],
    ["git 2.34.1 does it (not by a test: `docs/missing.md`).", NONE],
    ["Claude Code 2.1.310 stops it (`test/reference/pretooluse.json`; `test/reference/missing.json`) (not by a test: by hand).", /missing\.json does not exist/],
  ];
  /** The review's cells (cycle 56, T3, round 1): each refused, or said as an open range. @type {[string, "refused" | "said"][]} */
  const review = [
    ["Claude Code keeps a file with these values, measured on 2.1.310 and 2.1.319.", "refused"],
    ["Git does not delete it. That holds on the gits measured, 2.39.5, 2.50 and 2.56.", "refused"],
    ["Claude Code, in the version measured (2.1.207), runs npm ci.", "refused"],
    ["Claude Code's 2.1.330 binary stops it.", "refused"],
    ["Claude Code (2.1.330) stops it.", "refused"],
    ["git version 2.56.0 refuses it.", "refused"],
    ["node 22.0 hides ENOENT.", "refused"],
    ["Claude Code\n2.1.330 stops it.", "refused"],
    ["- Claude Code stops it at\n  2.1.330.", "refused"],
    ["Claude Code 2.1.330 stops it.", "refused"],
    ["Claude Code **2.1.330** stops it.", "refused"],
    ["git 2.34.1 through 2.99.0 refuse it (`docs/evidence.md#floor-only`).", "refused"],
    ['Claude Code 9.9.9 deletes the home folder (`test/core.test.mjs` "files: nothing there").', "refused"],
    ['Claude Code 2.1.999 stops it (`test/reference/pretooluse.json`; `test/core.test.mjs` "files: nothing there").', "refused"],
    ["git 2.1.310 refuses it (`test/reference/pretooluse.json`).", "refused"],
    ["Claude Code 2.1 and later stop it (`test/reference/pretooluse.json`).", "said"],
    ["Claude Code 2.1.330 stops it (`not by a test`).", "refused"],
    ["It is not by a test alone that we know Claude Code 2.1.330 stops it.", "refused"],
    ["| Claude Code 2.1.330 | stops |", "refused"],
    ["macOS 15 blocks it (`test/reference/pretooluse.json`).", "refused"],
  ];
  for (const text of accept) assert.deepEqual(one(text), [], text);
  for (const [text, want] of reject) {
    const got = one(text);
    assert.ok(
      got.some((p) => want.test(p)),
      `${text}: ${got.join(" | ") || "accepted"}`,
    );
  }
  for (const [text, want] of review) {
    const got = one(text);
    assert.ok(got.length > 0 && (want === "refused" || got.some((p) => /opens a range/.test(p))), `${text}: ${got.join(" | ") || "accepted"}`);
  }
  writeFileSync(join(root, "docs", "u.md"), "Use git 2.38 or newer.\n\nLater git 2.38 refuses it.\n");
  const allow = { file: "docs/u.md", at: "Use git 2.38 or newer" };
  assert.deepEqual(check(root, ["docs/u.md"], [allow]).length, 1, "an entry allows its sentence only");
  assert.match(check(root, ["docs/u.md"], [allow])[0], /^docs\/u\.md:3: git 2\.38 is held by no/);
  writeFileSync(join(root, "docs", "u.md"), "Use git 2.38 or newer.\n\nUse git 2.38 or newer.\n");
  assert.deepEqual(check(root, ["docs/u.md"], [allow]), ['docs/u.md: the allowed place "Use git 2.38 or newer" is there 2 times, not once'], "a place the file holds twice");
  writeFileSync(join(root, "docs", "u.md"), "Use git or newer.\n");
  assert.deepEqual(check(root, ["docs/u.md"], [{ file: "docs/u.md", at: "Use git or newer" }]), ['docs/u.md: the allowed "Use git or newer" is in no sentence that names a version'], "a stale entry");
  writeFileSync(join(root, "docs", "u.md"), "Use git 2.38 or newer.\n");
  assert.equal(check(root, ["docs/u.md"], [{ ...allow, file: "docs/other.md" }]).length, 2, "another file's entry allows nothing here");
  writeFileSync(join(root, "m.mjs"), "/**\n * Measured on git 2.56.0.\n */\nconst x = 1;\n");
  assert.deepEqual(check(root, ["m.mjs"]), ['m.mjs:2: git 2.56.0 is held by no test, record or evidence section the sentence names: "Measured on git 2.56.0."'], "a module header is read, with its line");
});
