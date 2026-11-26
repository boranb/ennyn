/**
 * Index of Claude Code path-scoped rules: `.claude/rules/**\/*.md` files whose
 * front matter carries a `paths:` glob list. Claude Code loads such a rule only
 * when a tool touches a matching project-relative path; rules without `paths:`
 * load in every session and are not part of this index.
 *
 * The front matter reader handles the subset of YAML rule files use:
 *   paths:                       paths: ["src/**", "lib/*.{ts,tsx}"]
 *     - "src/lib/engine/**"      paths: src/**, lib/**
 *     - server/src/**
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { gone, readIfThere } from "../../core/files.mjs";
import { join, sep } from "node:path";
import { globToRegExp } from "../../core/glob.mjs";
import { t } from "../../core/i18n.mjs";

const MAX_DEPTH = 32;
/** Entries a walk reads at most, inside the repository too: past them it stops and says where. */
const MAX_ENTRIES = 10000;
/** Whether a walk's reason is one of its limits (depth, entries), a code reasonText renders. @param {string | undefined} reason */
export const isLimit = (reason) => typeof reason === "string" && reason.startsWith("limit:");

/**
 * A walk's reason in a reader's language: its limits are codes (`limit:depth`, `limit:entries:<directories left>`);
 * anything else (an error's own message) is as it is.
 * @param {string} reason @param {string} lang
 */
export function reasonText(reason, lang) {
  if (reason === "limit:depth") return t("walk.depth", { max: MAX_DEPTH }, lang);
  const m = /^limit:entries:(\d+)$/.exec(reason);
  if (!m) return reason;
  const left = Number(m[1]);
  return t(left === 0 ? "walk.entries" : left === 1 ? "walk.entriesLeftOne" : "walk.entriesLeft", { max: MAX_ENTRIES, left }, lang);
}

/** The reason a walk gives for a link whose real path leaves the repository. */
export const LEAVES = "a link out of the repository, not followed";

/**
 * @param {string} text
 * @returns {{ frontMatter: string | null, body: string }}
 */
export function splitFrontMatter(text) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") return { frontMatter: null, body: lines.join("\n") };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (l === "---" || l === "...") {
      return { frontMatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { frontMatter: null, body: lines.join("\n") };
}

/**
 * Read one quoted scalar starting at `s[i]` (a `"` or `'`).
 * @param {string} s
 * @param {number} i
 * @returns {{ value: string, end: number }} end = index after the closing quote
 */
function readQuoted(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (q === '"' && s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") {
        j += 2;
        continue;
      }
      break;
    }
    j += 1;
  }
  const raw = s.slice(i, j + 1);
  let value;
  if (q === '"') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = s.slice(i + 1, j);
    }
  } else {
    value = s.slice(i + 1, j).replace(/''/g, "'");
  }
  return { value, end: Math.min(j + 1, s.length) };
}

/**
 * One list item or scalar: quoted, or plain with a trailing ` # comment` removed.
 * @param {string} raw
 */
function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith("'")) return readQuoted(s, 0).value;
  // A comment starts at a `#` after a space; found by one scan (a pattern anchored at the end costs the square of a
  // run of spaces).
  for (let i = 1; i < s.length; i++) if (s[i] === "#" && /\s/.test(s[i - 1])) return s.slice(0, i).trim();
  return s;
}

/**
 * Split on commas outside quotes, `{...}` and `[...]`. When `flow` is true the
 * input starts after a `[` and scanning stops at the matching `]`.
 * @param {string} s
 * @param {boolean} flow
 * @returns {{ items: string[], closed: boolean }}
 */
function splitList(s, flow) {
  /** @type {string[]} */
  const items = [];
  let cur = "";
  // Whether `cur` holds only spaces so far: kept, not recomputed, so a run of quotes costs its length.
  let empty = true;
  let braces = 0;
  let brackets = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && empty) {
      const { end } = readQuoted(s, i);
      cur += s.slice(i, end);
      empty = false;
      i = end - 1;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1])) && braces === 0 && brackets === 0) {
      const nl = s.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === "{") braces += 1;
    else if (c === "}" && braces > 0) braces -= 1;
    else if (c === "[") brackets += 1;
    else if (c === "]") {
      if (brackets > 0) brackets -= 1;
      else if (flow) {
        items.push(cur);
        return { items: items.map(scalar).filter(Boolean), closed: true };
      }
    } else if (c === "," && braces === 0 && brackets === 0) {
      items.push(cur);
      cur = "";
      empty = true;
      continue;
    }
    cur += c;
    if (!/\s/.test(c)) empty = false;
  }
  items.push(cur);
  return { items: items.map(scalar).filter(Boolean), closed: !flow };
}

/**
 * The value of the `paths:` key at line `i`, whose text after the colon is `rest`.
 * @param {string[]} lines @param {number} i @param {string} rest
 * @returns {string[]}
 */
function pathsAt(lines, i, rest) {
  const inline = rest.trim();
  // Flow sequence, possibly spanning lines: read once, to its closing `]` or the end.
  if (inline.startsWith("[")) return splitList([inline.slice(1), ...lines.slice(i + 1)].join("\n"), true).items;
  if (inline && !inline.startsWith("#")) return splitList(inline, false).items;
  /** @type {string[]} */
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const item = /^\s*-(?:\s+(.*))?$/.exec(l);
    if (!item) break;
    const v = scalar(item[1] ?? "");
    if (v) out.push(v);
  }
  return out;
}

/**
 * `paths:` value of a front matter block, as Claude Code reads it (2.1.310, test/reference/claude-code.json): of two
 * top-level `paths:` keys the last, and a block indented as a whole is read at its own indentation; one with a line
 * left of its first is no YAML mapping, so no paths (Claude Code loads that rule in every session).
 * @param {string} frontMatter
 * @returns {string[] | null} null when there is no top-level `paths:` key
 */
export function parsePaths(frontMatter) {
  let lines = frontMatter.split("\n");
  const blank = (/** @type {string} */ l) => /^\s*(#.*)?$/.test(l);
  const first = lines.find((l) => !blank(l));
  const indent = first === undefined ? 0 : first.length - first.trimStart().length;
  if (indent) {
    if (!lines.every((l) => blank(l) || l.slice(0, indent).trim() === "")) return null;
    lines = lines.map((l) => (blank(l) ? "" : l.slice(indent)));
  }
  // The last key is the one read, once: reading each in turn costs the square of the lines, the cube of a list
  // that never closes.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^paths\s*:(.*)$/.exec(lines[i]);
    if (m) return pathsAt(lines, i, m[1]);
  }
  return null;
}

/**
 * The patterns Claude Code keeps of a rule's `paths` (2.1.310, test/reference/claude-code.json): each item split at
 * the commas outside braces and trimmed, its braces expanded (expanded), then of each a trailing `/**` dropped
 * (`src/**` names the folder `src`, `{src/**,lib/**}` both folders), empty ones left out. With none, or only `**`,
 * the rule has no path scope and loads in every session: null.
 * @param {string[] | null} items parsePaths's reading
 * @returns {string[] | null}
 */
export function keptPaths(items) {
  if (items === null) return null;
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < item.length; i++) {
      if (item[i] === "{") depth++;
      else if (item[i] === "}") depth--;
      else if (item[i] === "," && depth === 0) {
        parts.push(item.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(item.slice(start));
    for (const part of parts) {
      for (const one of expanded(part.trim())) {
        const kept = one.endsWith("/**") ? one.slice(0, -3) : one;
        if (kept) out.push(kept);
      }
    }
  }
  return out.length && !out.every((p) => p === "**") ? out : null;
}

/**
 * Markdown files below a directory, linked directories and files followed while their real path stays inside
 * `root` (the repository: a link out of it is a file Claude Code may load or not, and these names reach the
 * model through a trusted channel, so it is said, not read), each directory once by its real path (a link back
 * to a parent, or two links to one directory, is read once), breadth first so a directory's depth is its own,
 * at most MAX_DEPTH levels and MAX_ENTRIES entries. One walk for the hook and init-scan, so the rules one counts
 * are the rules the other reads.
 * @param {string} dir
 * @param {string} root
 * @param {string[]} [unreadable] filled with what is there but was not read: could not be, past the depth or the
 *   entries, or a link out of `root`
 * @param {Map<string, string>} [why] filled with each unreadable path's reason
 * @returns {string[]} absolute paths, sorted
 */
export function markdownFiles(dir, root, unreadable = [], why = new Map()) {
  /** @param {string} path @param {string} reason */
  const cannot = (path, reason) => {
    unreadable.push(path);
    why.set(path, reason);
  };
  /** @type {string[]} */
  const files = [];
  let top;
  try {
    top = realpathSync.native(root);
  } catch (err) {
    cannot(dir, /** @type {Error} */ (err).message);
    return files;
  }
  const inside = (/** @type {string} */ real) => real === top || real.startsWith(top.endsWith(sep) ? top : top + sep);
  /** @type {Set<string>} real paths of the directories reached */
  const seen = new Set();
  /** @type {[string, number][]} */
  const queue = [[dir, 0]];
  let entries = 0;
  for (let q = 0; q < queue.length; q++) {
    const [at, depth] = queue[q];
    let real;
    try {
      real = realpathSync.native(at);
    } catch (err) {
      if (!gone(err)) cannot(at, /** @type {Error} */ (err).message);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (!inside(real)) {
      cannot(at, LEAVES);
      continue;
    }
    // Deeper than this is not read, which is said: what it holds is unknown, not nothing.
    if (depth > MAX_DEPTH) {
      cannot(at, "limit:depth");
      continue;
    }
    let list;
    try {
      list = readdirSync(at, { withFileTypes: true });
    } catch (err) {
      if (!gone(err)) cannot(at, /** @type {Error} */ (err).message);
      continue;
    }
    for (const e of list) {
      if (++entries > MAX_ENTRIES) {
        // The directories still waiting are not read either: said with this one, by count.
        const left = queue.length - q - 1;
        cannot(at, `limit:entries:${left}`);
        return files.sort();
      }
      const p = join(at, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
          // A linked directory is judged when it is reached; a linked file here.
          if (isFile && !inside(realpathSync.native(p))) {
            cannot(p, LEAVES);
            continue;
          }
        } catch (err) {
          // A link to nothing is no rule; one that cannot be looked at may be.
          if (!gone(err)) cannot(p, /** @type {Error} */ (err).message);
          continue;
        }
      }
      if (isDir) queue.push([p, depth + 1]);
      else if (isFile && e.name.endsWith(".md")) files.push(p);
    }
  }
  return files.sort();
}

/**
 * @param {string} projectDir
 * @param {string[]} [unreadable] filled with the rule files and directories that are there but could not be
 *   read: whether they apply is unknown, which the caller says
 * @param {Map<string, string>} [why] filled with each unreadable path's reason
 * @returns {Array<{ file: string, patterns: string[] }>} absolute rule file paths, sorted
 */
export function loadPathScopedRules(projectDir, unreadable = [], why = new Map()) {
  const files = markdownFiles(join(projectDir, ".claude", "rules"), projectDir, unreadable, why);
  /** @type {Array<{ file: string, patterns: string[] }>} */
  const rules = [];
  for (const file of files) {
    let text;
    try {
      // A regular file only, up to the read limit: a pipe put in a rule's place would hold the hook.
      text = readIfThere(file);
    } catch (err) {
      unreadable.push(file);
      why.set(file, /** @type {Error} */ (err).message);
      continue;
    }
    if (text === null) continue;
    const { frontMatter } = splitFrontMatter(text);
    const patterns = frontMatter === null ? null : keptPaths(parsePaths(frontMatter));
    if (patterns) rules.push({ file, patterns });
  }
  return rules;
}

/** Brace expansion's budget, as Claude Code's: past it the pattern is kept unexpanded. */
const EXPANSIONS = 1000;
const EXPANSION_BYTES = 4 * 1024 * 1024;

/**
 * A pattern's braces expanded as Claude Code expands them (2.1.310): the first `{…}` holding no `}`, its
 * alternatives split at commas and trimmed, again until none is left; past 1,000 results or 4 MB of text the
 * pattern is kept as written.
 * @param {string} pattern
 */
function expanded(pattern) {
  if (!pattern.includes("{")) return [pattern];
  /** @type {string[]} */
  const out = [];
  const stack = [pattern];
  let budget = EXPANSION_BYTES;
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    const open = p.indexOf("{");
    const close = open === -1 ? -1 : p.indexOf("}", open + 1);
    if (open === -1 || close === -1 || close === open + 1) {
      out.push(p);
      continue;
    }
    const alternatives = p.slice(open + 1, close).split(",").map((a) => a.trim());
    budget -= p.length;
    const count = out.length + stack.length + alternatives.length;
    if (budget < 0 || count > EXPANSIONS || count * pattern.length > budget) return [pattern];
    for (const a of alternatives.reverse()) stack.push(p.slice(0, open) + a + p.slice(close + 1));
  }
  return out;
}

/**
 * @typedef {{ segments: (RegExp | "**")[], anyDepth: boolean, foldersOnly: boolean }} Compiled one expanded pattern:
 *   its segments (`**` any number of path segments, else one segment's glob, letters without case)
 */
/** @type {Map<string, Compiled[]>} */
const compiled = new Map();

/**
 * A kept pattern compiled for pathRuleMatches: braces expanded, spaces at the end dropped, a leading `/` anchoring
 * it, a trailing `/` naming folders only, runs of `/` read as one, each segment its own expression with the case
 * flag (the pattern is not rewritten: lower case would turn `[A-_]` into no class). Throws on a segment no
 * expression can hold (past the engine's size, an unclosed brace across a `/`).
 * @param {string} pattern
 * @returns {Compiled[]}
 */
function compile(pattern) {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  const out = expanded(pattern).map((one) => {
    let end = one.length;
    while (end > 0 && one[end - 1] === " ") end--;
    let p = one.slice(0, end).replace(/\/{2,}/g, "/");
    const anchored = p.startsWith("/");
    if (anchored) p = p.slice(1);
    const foldersOnly = p.endsWith("/");
    if (foldersOnly) p = p.slice(0, -1);
    const anyDepth = !anchored && !p.includes("/");
    /** @type {(RegExp | "**")[]} */
    const segments = p === "" ? [] : p.split("/").map((s) => (s === "**" ? "**" : new RegExp(globToRegExp(s).source, "i")));
    return { segments, anyDepth, foldersOnly };
  });
  compiled.set(pattern, out);
  return out;
}

/**
 * Whether one compiled pattern names a path given as its segments: the pattern's segments against the path's from
 * the top (from any depth for a name with no `/`), `**` taking any number of them; it names a folder on the way or
 * the path itself (a folder pattern, only a folder). A table, one row a pattern segment from the last: each pair
 * of positions is decided once, so the time is the pattern's segments times the path's whatever stars the pattern
 * holds, with no recursion a deep path could exhaust.
 * @param {Compiled} c @param {string[]} parts
 */
function namesPath(c, parts) {
  const { segments, foldersOnly } = c;
  if (!segments.length) return false;
  const pattern = c.anyDepth ? /** @type {(RegExp | "**")[]} */ (["**", ...segments]) : segments;
  const S = parts.length;
  // The row past the pattern: what is matched so far names a folder on the way, or the path itself.
  let next = new Uint8Array(S + 1);
  for (let j = 0; j <= S; j++) next[j] = foldersOnly ? Number(j < S) : Number(j > 0);
  for (let i = pattern.length - 1; i >= 0; i--) {
    const row = new Uint8Array(S + 1);
    const seg = pattern[i];
    for (let j = S; j >= 0; j--) {
      if (seg === "**") row[j] = next[j] || (j < S && row[j + 1]) ? 1 : 0;
      else row[j] = j < S && next[j + 1] && seg.test(parts[j]) ? 1 : 0;
    }
    next = row;
  }
  return next[0] === 1;
}

/**
 * Whether a kept pattern (keptPaths) names `relPath` as Claude Code matches it (2.1.310, test/reference/claude-code.json):
 * as a .gitignore line names a path, with braces expanded, letters compared without case. Spaces at the end are
 * dropped; a leading `/` anchors the pattern at the top; one with no other `/` names a file or folder at any depth;
 * a folder it names covers what the folder holds, and a trailing `/` names folders only. A name and the pattern are
 * also compared composed (NFC), as core/glob.mjs compares them. Throws on a pattern no expression can hold.
 * @param {string} pattern @param {string} relPath project-relative, "/" separated
 */
export function pathRuleMatches(pattern, relPath) {
  const parts = relPath.split("/");
  if (compile(pattern).some((c) => namesPath(c, parts))) return true;
  const ascii = (/** @type {string} */ s) => !/[^\x00-\x7f]/.test(s);
  if (ascii(pattern) && ascii(relPath)) return false;
  const composed = relPath.normalize("NFC").split("/");
  return compile(pattern.normalize("NFC")).some((c) => namesPath(c, composed));
}

/**
 * @param {ReadonlyArray<{ file: string, patterns: string[] }>} rules
 * @param {string} relPath project-relative, "/" separated
 * @param {{ file: string, pattern: string }[]} [bad] filled with each pattern no expression can hold: it is skipped,
 *   as Claude Code skips it, and its rule still applies by its other patterns, in whatever order they stand
 * @returns {string[]} files of the rules that apply to `relPath`
 */
export function rulesForPath(rules, relPath, bad = []) {
  return rules
    .filter((r) => {
      let hit = false;
      for (const p of r.patterns) {
        try {
          if (pathRuleMatches(p, relPath)) hit = true;
        } catch {
          bad.push({ file: r.file, pattern: p });
        }
      }
      return hit;
    })
    .map((r) => r.file);
}

/**
 * Rule text without its front matter (what the model should read).
 * @param {string} file
 * @returns {string | null} null when the file cannot be read
 */
export function readRuleBody(file) {
  try {
    const text = readIfThere(file);
    return text === null ? null : splitFrontMatter(text).body.replace(/^\n+/, "").trimEnd();
  } catch {
    return null;
  }
}
