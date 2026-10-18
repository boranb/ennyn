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

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchAny } from "../../core/glob.mjs";

const MAX_DEPTH = 32;

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
  return s.replace(/\s+#.*$/, "").trim();
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
  let braces = 0;
  let brackets = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && cur.trim() === "") {
      const { end } = readQuoted(s, i);
      cur += s.slice(i, end);
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
      continue;
    }
    cur += c;
  }
  items.push(cur);
  return { items: items.map(scalar).filter(Boolean), closed: !flow };
}

/**
 * `paths:` value of a front matter block.
 * @param {string} frontMatter
 * @returns {string[] | null} null when there is no top-level `paths:` key
 */
export function parsePaths(frontMatter) {
  const lines = frontMatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^paths\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith("[")) {
      // Flow sequence, possibly spanning lines.
      let text = inline.slice(1);
      for (let j = i + 1; ; j++) {
        const r = splitList(text, true);
        if (r.closed || j >= lines.length) return r.items;
        text += "\n" + lines[j];
      }
    }
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
  return null;
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {Set<string>} seen real paths of visited directories (symlink cycles)
 * @param {number} depth
 */
function walk(dir, out, seen, depth) {
  if (depth > MAX_DEPTH) return;
  let real;
  try {
    real = realpathSync.native(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walk(p, out, seen, depth + 1);
    else if (isFile && e.name.endsWith(".md")) out.push(p);
  }
}

/**
 * @param {string} projectDir
 * @returns {Array<{ file: string, patterns: string[] }>} absolute rule file paths, sorted
 */
export function loadPathScopedRules(projectDir) {
  /** @type {string[]} */
  const files = [];
  walk(join(projectDir, ".claude", "rules"), files, new Set(), 0);
  /** @type {Array<{ file: string, patterns: string[] }>} */
  const rules = [];
  for (const file of files.sort()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { frontMatter } = splitFrontMatter(text);
    const patterns = frontMatter === null ? null : parsePaths(frontMatter);
    if (patterns && patterns.length) rules.push({ file, patterns });
  }
  return rules;
}

/**
 * @param {ReadonlyArray<{ file: string, patterns: string[] }>} rules
 * @param {string} relPath project-relative, "/" separated
 * @returns {string[]} files of the rules that apply to `relPath`
 */
export function rulesForPath(rules, relPath) {
  return rules.filter((r) => matchAny(relPath, r.patterns)).map((r) => r.file);
}

/**
 * Rule text without its front matter (what the model should read).
 * @param {string} file
 * @returns {string | null} null when the file cannot be read
 */
export function readRuleBody(file) {
  try {
    return splitFrontMatter(readFileSync(file, "utf8")).body.replace(/^\n+/, "").trimEnd();
  } catch {
    return null;
  }
}
