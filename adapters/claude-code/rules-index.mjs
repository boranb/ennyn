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
import { matchAny } from "../../core/glob.mjs";
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
    const text = readIfThere(file);
    return text === null ? null : splitFrontMatter(text).body.replace(/^\n+/, "").trimEnd();
  } catch {
    return null;
  }
}
