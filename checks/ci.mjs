/**
 * CI files a commit brings (security.ci): GitHub Actions workflows and action files. Three rules, each a
 * measured way into a repository in 2026: an action named by a tag or branch runs whatever that name points
 * to when the job starts (tags of popular actions were moved to code that read the runners' secrets); a
 * pull_request_target workflow that checks out the pull request's code runs a stranger's code with this
 * repository's secrets and a write token, also through a reusable workflow or a local action it calls; a
 * workflow that sets no permissions gets the repository's default token, which may write.
 *
 * What is refused is what the commit adds: the staged CI files are compared with HEAD's, so what is already
 * there stays until it is touched, and `doctor` counts it. A file read as anything but UTF-8 text is said.
 *
 * The YAML is read without a parser, in one pass with no backtracking: block mappings and sequences by
 * indentation (a sequence at its key's column too), block scalars as text, comments, quoted and escaped keys and
 * values, a quoted value over several lines, tags, anchors and aliases (of a mapping too, and `<<` merges),
 * flow collections over one line or several, and every line break YAML has (LF, CR, CRLF, NEL, LS, PS). What it
 * cannot follow (an explicit `?` key, an alias with no anchor before it, a quote or a flow collection that does
 * not close) is refused, never passed: GitHub runs what it can parse.
 */

import { isUtf8 } from "node:buffer";
import { shown, t } from "../core/i18n.mjs";

/**
 * @typedef {{ n: number, path: string[], key: string | null, value: string | null, item: number, block?: string[], folded?: boolean, unread?: boolean }} Entry
 *   `key` null: a sequence item that is a scalar ("- push"); `value` null: a key whose value is a mapping or a
 *   sequence; `item`: the innermost sequence item the entry is in (0: none), so the keys of one step go together;
 *   `block`: the lines of a block scalar; `unread`: a value that is no scalar this reading can give
 */

/** YAML's line breaks: YAML 1.2 has CR, LF and CRLF; libyaml also breaks at NEL, LS and PS. */
const BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

/** Past these the reading stops and says so: items nested on one line, and entries aliases can multiply into. */
const MAX_DASHES = 64;
const MAX_ENTRIES = 200000;

/** @param {string} s */
const indentOf = (s) => s.length - s.trimStart().length;

/** @param {string} c */
const blank = (c) => c === " " || c === "\t";

/**
 * Where the quote opened before `from` closes in `s`, or -1. `"` takes backslash escapes, `'` doubles itself.
 * @param {string} s @param {number} from @param {string} q
 */
function closeAt(s, from, q) {
  for (let i = from; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i++;
    else if (q === "'" && s[i] === "'" && s[i + 1] === "'") i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

/** A double-quoted scalar's escapes. @param {string} s */
const unescape = (s) =>
  s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) =>
    /^[xuU]/.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ({ n: "\n", t: "\t", r: "\r", 0: "\0", " ": " ", "/": "/", N: "\u0085", L: "\u2028", P: "\u2029" })[/** @type {string} */ (e)] ?? e,
  );

/**
 * A line's text before its comment, the quote still open at its end (a quoted scalar that goes on) and the flow
 * collections still open. A `#` starts a comment at the start or after a space, outside quotes; a quote opens a
 * scalar only where one can start: the line start, after `: ` or `- `, and inside a flow collection after `[`,
 * `{` or `,` (in a block value a comma is a character: `IFS=',' read` holds no quote).
 * @param {string} line @param {string | null} [open] a quote left open by the line before
 * @param {number} [depth] flow collections left open by the line before
 * @returns {{ body: string, quote: string | null, flow: number }}
 */
function scan(line, open = null, depth = 0) {
  let quote = open;
  let flow = depth;
  let canOpen = open === null;
  // Still in the indentation and the leading dashes: only there does "- " start a scalar.
  let lead = open === null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (quote === "'" && c === "'" && line[i + 1] === "'") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "#" && (i === 0 || blank(line[i - 1]))) return { body: line.slice(0, i), quote: null, flow };
    if (blank(c)) {
      if (line[i - 1] === ":" || (lead && line[i - 1] === "-")) canOpen = true;
      continue;
    }
    if (c === "-" && lead && (i + 1 === line.length || blank(line[i + 1]))) {
      canOpen = false;
      continue;
    }
    lead = false;
    if ((c === '"' || c === "'") && canOpen) {
      quote = c;
      canOpen = false;
    } else if ((c === "!" || c === "&") && canOpen) {
      // A tag or an anchor where a scalar starts: the scalar may still start after it.
      while (i + 1 < line.length && !blank(line[i + 1])) i++;
    } else if ((c === "[" || c === "{") && (canOpen || flow > 0)) {
      flow++;
      canOpen = true;
    } else if ((c === "]" || c === "}") && flow > 0) {
      flow--;
      canOpen = false;
    } else canOpen = (c === "," || c === ":") && flow > 0;
  }
  return { body: line, quote, flow };
}

/** The line without its comment. @param {string} line */
export const stripComment = (line) => scan(line).body;

/**
 * Whether the flow collection at the start of `s` closes in it: brackets outside quotes, a quote opening only where
 * a scalar starts (after `[`, `{`, `,` or `: `), as scan reads it, so `[main, bob's-fix]` holds no quote.
 * @param {string} s
 */
function closes(s) {
  let depth = 0;
  let canOpen = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && canOpen) {
      const end = closeAt(s, i + 1, c);
      if (end === -1) return false;
      i = end;
      canOpen = false;
    } else if (c === "[" || c === "{") {
      depth++;
      canOpen = true;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return true;
      canOpen = false;
    } else if (c === ",") canOpen = true;
    else if (blank(c)) {
      if (s[i - 1] === ":") canOpen = true;
    } else canOpen = false;
  }
  return false;
}

/** Properties in front of a node: tags and an anchor. @param {string} s */
function props(s) {
  let v = s;
  /** @type {string | undefined} */
  let anchor;
  for (;;) {
    const p = /^([!&])(\S*)(?:[ \t]+|$)/.exec(v);
    if (!p) return { rest: v, anchor };
    if (p[1] === "&") anchor = p[2];
    v = v.slice(p[0].length);
  }
}

/**
 * The key at the start of a block line: a tag or an anchor in front dropped, a quoted key decoded, a plain key
 * read to the first colon followed by a space or the end. null when the line holds no key.
 * @param {string} rest
 * @returns {{ key: string, value: string, anchor?: string, alias?: string } | { explicit: true } | null}
 */
function keyLine(rest) {
  const { rest: s, anchor } = props(rest);
  if (s === "?" || /^\?[ \t]/.test(s)) return { explicit: true };
  // An alias as a key: `*k : value` (a space before the colon, or the alias would end at it).
  const alias = /^\*(\S+)[ \t]+:(?:[ \t]+(.*))?$/.exec(s);
  if (alias) return { key: `*${alias[1]}`, value: (alias[2] ?? "").trim(), alias: alias[1] };
  if (s[0] === '"' || s[0] === "'") {
    const end = closeAt(s, 1, s[0]);
    if (end === -1) return null;
    const after = s.slice(end + 1).replace(/^[ \t]+/, "");
    if (!(after === ":" || /^:[ \t]/.test(after))) return null;
    return { key: s[0] === '"' ? unescape(s.slice(1, end)) : s.slice(1, end).replace(/''/g, "'"), value: after.slice(1).trim(), anchor };
  }
  if (!s || /^[{}[\],&*!|>%@`#]/.test(s) || /^-([ \t]|$)/.test(s)) return null;
  for (let i = 0; i < s.length; i++) if (s[i] === ":" && (i + 1 === s.length || blank(s[i + 1]))) return { key: s.slice(0, i).trimEnd(), value: s.slice(i + 1).trim(), anchor };
  return null;
}

/**
 * A scalar as YAML reads it: properties in front dropped (the anchor is given back), an alias looked up (one of a
 * mapping or a sequence is given back as `node`), quotes taken off.
 * @param {string} raw @param {Map<string, string>} scalars
 * @returns {{ value: string, unread?: boolean, anchor?: string, node?: string }}
 */
function scalar(raw, scalars) {
  const { rest, anchor } = props(raw.trim());
  const v = rest.trim();
  const alias = /^\*(\S+)$/.exec(v);
  if (alias) return scalars.has(alias[1]) ? { value: /** @type {string} */ (scalars.get(alias[1])) } : { value: v, node: alias[1] };
  if (v[0] === '"' || v[0] === "'") {
    const end = closeAt(v, 1, v[0]);
    if (end !== v.length - 1) return { value: v, unread: true, anchor };
    return { value: v[0] === '"' ? unescape(v.slice(1, end)) : v.slice(1, end).replace(/''/g, "'"), anchor };
  }
  return { value: v, anchor };
}

/**
 * Every mapping entry and scalar item of a YAML text, with its line, the keys above it and its sequence item;
 * `unread` lists what this reading cannot follow.
 * @param {string} text
 * @returns {{ entries: Entry[], unread: { n: number, what: string, text?: string }[] }}
 */
export function yamlRead(text) {
  const lines = text.replace(/^﻿/, "").split(BREAK);
  /** @type {Entry[]} */
  const entries = [];
  /** @type {{ n: number, what: string }[]} */
  const unread = [];
  /** @type {Map<string, string>} */
  const scalars = new Map();
  /** An anchored mapping or sequence: its entries, the path they hang from, and the first item id made in it. */
  /** @type {Map<string, { entries: Entry[], base: string[], firstItem: number }>} */
  const nodes = new Map();
  /** @type {{ indent: number, key: string | null, item: number, anchor?: string, start: number, base: string[], firstItem: number }[]} */
  let stack = [];
  let items = 0;
  const keys = () => /** @type {string[]} */ (stack.filter((f) => f.key !== null).map((f) => f.key));
  const itemNow = () => [...stack].reverse().find((f) => f.key === null)?.item ?? 0;
  const close = (/** @type {(typeof stack)[number]} */ f) => {
    if (f.anchor !== undefined) nodes.set(f.anchor, { entries: entries.slice(f.start), base: f.base, firstItem: f.firstItem });
  };
  // An anchor named again means the newest node: one of the other kind of that name is forgotten.
  const scalarAnchor = (/** @type {string} */ name, /** @type {string} */ value) => {
    // (Scalars are looked up first, so a node of this name needs no forgetting.)
    scalars.set(name, value);
  };
  const nodeAnchor = (/** @type {string} */ name) => {
    scalars.delete(name);
    nodes.delete(name);
  };
  const pop = (/** @type {(f: (typeof stack)[number]) => boolean} */ until) => {
    while (stack.length && until(/** @type {(typeof stack)[number]} */ (stack.at(-1)))) close(/** @type {(typeof stack)[number]} */ (stack.pop()));
  };
  /** An alias of a mapping or a sequence, read again where it stands: at `path`, in item `item`, on line `n`. */
  const expand = (/** @type {string} */ name, /** @type {string[]} */ path, /** @type {number} */ item, /** @type {number} */ n) => {
    const node = nodes.get(name);
    if (!node) return unread.push({ n, what: `*${name}, an alias with no anchor before it` });
    if (entries.length + node.entries.length > MAX_ENTRIES) return unread.push({ n, what: `*${name}, aliases that grow past ${MAX_ENTRIES} entries` });
    /** @type {Map<number, number>} */
    const fresh = new Map();
    for (const e of node.entries) {
      const own = e.item >= node.firstItem ? (fresh.get(e.item) ?? fresh.set(e.item, ++items).get(e.item)) : item;
      entries.push({ ...e, n, path: [...path, ...e.path.slice(node.base.length)], item: /** @type {number} */ (own) });
    }
  };
  /** A flow collection (`[…]`, `{…}`, nested) read into entries at `path`, in item `item`, on line `n`. */
  const flow = (/** @type {string} */ src, /** @type {string[]} */ path, /** @type {number} */ item, /** @type {number} */ n) => {
    let i = 0;
    const ws = () => {
      while (i < src.length && /\s/.test(src[i])) i++;
    };
    const token = (/** @type {string} */ stops) => {
      ws();
      const from = i;
      if (src[i] === '"' || src[i] === "'") {
        const end = closeAt(src, i + 1, src[i]);
        if (end === -1) throw new Error("a quote that does not close");
        i = end + 1;
      } else while (i < src.length && !stops.includes(src[i]) && !(src[i] === ":" && stops.includes(":") && (i + 1 === src.length || /[\s,\]}]/.test(src[i + 1])))) i++;
      return src.slice(from, i).trim();
    };
    const node = (/** @type {string[]} */ at, /** @type {number} */ it, /** @type {string | null} */ key) => {
      ws();
      const open = src[i];
      if (open === "[" || open === "{") {
        if (key !== null) entries.push({ n, path: at, key, value: null, item: it });
        i++;
        for (;;) {
          ws();
          if (src[i] === (open === "[" ? "]" : "}")) return i++;
          if (open === "[") {
            const id = ++items;
            ws();
            if (src[i] === "[" || src[i] === "{") node(at, id, null);
            else {
              const s = scalar(token(",]"), scalars);
              if (s.node) expand(s.node, at, id, n);
              else entries.push({ n, path: at, key: null, value: s.value, item: id, ...(s.unread ? { unread: true } : {}) });
            }
          } else {
            const k = scalar(token(":,}"), scalars).value;
            ws();
            if (src[i] === ":") {
              i++;
              ws();
              if (src[i] === "[" || src[i] === "{") node([...at, k], it, k);
              else {
                const s = scalar(token(",}"), scalars);
                if (s.node) {
                  entries.push({ n, path: [...at, k], key: k, value: null, item: it });
                  expand(s.node, [...at, k], it, n);
                } else entries.push({ n, path: [...at, k], key: k, value: s.value, item: it, ...(s.unread ? { unread: true } : {}) });
              }
            } else entries.push({ n, path: [...at, k], key: k, value: "", item: it });
          }
          ws();
          if (src[i] === ",") i++;
          else if (src[i] !== (open === "[" ? "]" : "}")) throw new Error(`"${src[i] ?? "the end"}" where a flow collection goes on`);
        }
      }
      throw new Error("no flow collection");
    };
    try {
      node(path, item, null);
      ws();
      if (i < src.length) throw new Error(`"${src.slice(i, i + 20)}" after it`);
    } catch (e) {
      unread.push({ n, what: `a flow collection this reading cannot follow (${/** @type {Error} */ (e).message})` });
    }
  };
  // A line that reads as a key or an item at or left of `col` ends a scalar or a flow collection for this
  // reading: YAML might read it either way, so what was being joined is refused, not swallowed.
  const structure = (/** @type {string} */ raw, /** @type {number} */ col) => {
    const t = scan(raw).body.trimEnd();
    if (!t.trim() || indentOf(t) > col) return false;
    const rest = t.trimStart().replace(/^(?:-[ \t]+)+/, "");
    return /^-([ \t]|$)/.test(t.trimStart()) || keyLine(rest) !== null;
  };
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    // A logical line: a quoted scalar that goes on is joined, folded to spaces as YAML folds it.
    let { body, quote } = scan(lines[i]);
    const start = indentOf(lines[i]);
    while (quote && i + 1 < lines.length && !structure(lines[i + 1], start)) {
      const next = scan(lines[++i], quote);
      body = `${body} ${next.body.trim()}`;
      quote = next.quote;
    }
    if (quote) {
      unread.push({ n, what: "a quote that does not close before the next key" });
      continue;
    }
    body = body.trimEnd();
    if (!body.trim()) continue;
    if (/^(---|\.\.\.)([ \t]|$)/.test(body)) {
      pop(() => true);
      continue;
    }
    let col = indentOf(body);
    let rest = body.trimStart();
    // The column a collection's lines must stay right of: the key's, or for an item the dash's.
    let dashCol = col;
    // Sequence items: each dash moves the content right; the item belongs to the nearest key at its column or left of it.
    let dashes = 0;
    while ((rest === "-" || /^-[ \t]/.test(rest)) && ++dashes <= MAX_DASHES) {
      dashCol = col;
      pop((f) => f.indent > col || (f.key === null && f.indent === col));
      stack.push({ indent: col, key: null, item: ++items, start: entries.length, base: keys(), firstItem: items });
      const after = rest.slice(1);
      col += 1 + indentOf(after);
      rest = after.trimStart();
    }
    if (dashes > MAX_DASHES) {
      unread.push({ n, what: `items nested more than ${MAX_DASHES} deep on one line` });
      continue;
    }
    if (!rest) continue;
    // A flow collection over several lines is read as one.
    const gather = (/** @type {string} */ v, at = col) => {
      let s = v;
      let depth = 1;
      while (!closes(s) && i + 1 < lines.length && !structure(lines[i + 1], at)) {
        const next = scan(lines[++i], null, depth);
        s = `${s} ${next.body.trim()}`;
        depth = Math.max(1, next.flow);
      }
      return s;
    };
    const k = keyLine(rest);
    if (k && "explicit" in k) {
      unread.push({ n, what: "an explicit key (?)" });
      continue;
    }
    // The value of an explicit key: as unreadable as its key, and its own text, so a change to it is new.
    if (rest === ":" || /^:[ \t]/.test(rest)) {
      unread.push({ n, what: "the value of an explicit key (:)" });
      continue;
    }
    if (!k) {
      // A scalar item (or a line that goes on from above): read as a value with no key.
      const p = props(rest);
      if (p.anchor !== undefined && !p.rest) {
        const f = stack.at(-1);
        if (f && f.key === null) (f.anchor = p.anchor), nodeAnchor(p.anchor);
        continue;
      }
      if (/^[[{]/.test(p.rest)) {
        flow(gather(p.rest, dashes ? dashCol : col), keys(), itemNow(), n);
        continue;
      }
      const s = scalar(rest, scalars);
      if (s.anchor !== undefined) scalarAnchor(s.anchor, s.value);
      if (s.node) expand(s.node, keys(), itemNow(), n);
      else entries.push({ n, path: keys(), key: null, value: s.value, item: itemNow(), ...(s.unread ? { unread: true } : {}) });
      continue;
    }
    pop((f) => f.indent >= col);
    // An anchor on a key names the key's text; an alias as a key is that text, or unreadable.
    if (k.anchor !== undefined) scalarAnchor(k.anchor, k.key);
    if (k.alias !== undefined) {
      const named = scalars.get(k.alias);
      if (named === undefined) {
        unread.push({ n, what: `${k.key}, an alias as a key with no anchor before it` });
        continue;
      }
      k.key = named;
    }
    const item = itemNow();
    const path = [...keys(), k.key];
    const p = props(k.value);
    // `<<: *a` merges the anchored mapping into this one.
    if (k.key === "<<") {
      const s = scalar(k.value, scalars);
      if (/^[{]/.test(p.rest)) flow(gather(p.rest), keys(), item, n);
      else if (s.node) expand(s.node, keys(), item, n);
      else unread.push({ n, what: "a merge key (<<) of something that is no alias of a mapping" });
      continue;
    }
    if (/^[[{]/.test(p.rest)) {
      entries.push({ n, path, key: k.key, value: null, item });
      flow(gather(p.rest), path, item, n);
      continue;
    }
    const s = scalar(k.value, scalars);
    if (s.anchor !== undefined && s.value !== "") scalarAnchor(s.anchor, s.value);
    else if (s.anchor !== undefined) nodeAnchor(s.anchor);
    if (s.node) {
      // An alias of a mapping or a sequence is read again here; one with no anchor keeps its name, unread.
      entries.push({ n, path, key: k.key, value: nodes.has(s.node) ? null : s.value, item, ...(nodes.has(s.node) ? {} : { unread: true }) });
      expand(s.node, path, item, n);
      continue;
    }
    if (/^[|>][0-9+-]*$/.test(s.value) && !/^["']/.test(p.rest)) {
      // A block scalar: the lines below that are blank or indented past the key.
      /** @type {string[]} */
      const block = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > col)) block.push(lines[++i]);
      entries.push({ n, path, key: k.key, value: block.map((l) => l.trim()).join("\n"), item, block, ...(s.value.startsWith(">") ? { folded: true } : {}) });
      continue;
    }
    if (s.value === "" && !s.unread) {
      // A plain scalar may start on the next line, indented past the key, when that line is no key and no item.
      let j = i + 1;
      while (j < lines.length && !scan(lines[j]).body.trim()) j++;
      const next = j < lines.length ? scan(lines[j]).body.trimEnd() : "";
      if (next && indentOf(next) > col && !keyLine(next.trimStart()) && !/^-([ \t]|$)/.test(next.trimStart())) {
        i = j;
        if (/^[[{]/.test(props(next.trim()).rest)) flow(gather(props(next.trim()).rest), path, item, j + 1);
        else {
          const v = scalar(next, scalars);
          if (v.node) expand(v.node, path, item, j + 1);
          else entries.push({ n: j + 1, path, key: k.key, value: v.value, item, ...(v.unread ? { unread: true } : {}) });
        }
        continue;
      }
      entries.push({ n, path, key: k.key, value: null, item });
      stack.push({ indent: col, key: k.key, item, anchor: s.anchor, start: entries.length, base: path, firstItem: items + 1 });
      continue;
    }
    entries.push({ n, path, key: k.key, value: s.value, item, ...(s.unread ? { unread: true } : {}) });
  }
  pop(() => true);
  // The line's own text goes with each: a change on a line the reading cannot follow is a new one.
  return { entries, unread: unread.map((u) => ({ ...u, text: (lines[u.n - 1] ?? "").trim() })) };
}

/**
 * Whether a `uses` value names fixed code: a local path in this repository (`./…`), a docker image by its
 * digest, or an action or reusable workflow by a full commit SHA (40 lower-case hex digits; a ref in capitals
 * is read by GitHub as a branch or tag name).
 * @param {string} value
 */
export function pinnedUses(value) {
  if (value.startsWith("./")) return true;
  if (value.startsWith("docker://")) return /@sha256:[0-9a-f]{64}$/.test(value);
  return /^[^\s@]+@[0-9a-f]{40}$/.test(value);
}

/** Keys below which a `uses` is no step's or job's: inputs, variables, a matrix, the services. */
const NOT_STEPS = new Set(["with", "env", "inputs", "outputs", "secrets", "vars", "strategy", "services", "container", "defaults", "concurrency", "permissions", "on", "environment", "branding"]);

/** A ref that names a pull request's code: `refs/pull/…`, `pull/N/head`, `pull/N/merge`. */
const PR_REF = /refs\/pull\/|(?:^|[^\w])pull\/(?:\$\{\{[^}\n]{0,400}\}\}|[^/\s]+)\/(?:head|merge)\b/i;

/**
 * Whether a text holds an expression on the pull request's own code: its head, number, merge commit or ref
 * (anything under `github.event.pull_request` but its base and the fields that name no code — number, state,
 * draft, labels, html_url: a branch called backport-<n> is not the pull request's; the author's login, title or
 * body still count, they can name a fork or a ref), `github.head_ref`, `github.event.after` (a synchronize event's
 * head), and the number where the expression builds a ref from it (`pull` in it, or format() or join()).
 * Contexts are read without case, `['x']` as `.x`. One
 * pass: an expression that does not close ends it.
 * @param {string} text
 */
export function prExpression(text) {
  for (let at = text.indexOf("${{"); at !== -1; at = text.indexOf("${{", at + 3)) {
    const end = text.indexOf("}}", at + 3);
    if (end === -1) return false;
    const e = text.slice(at + 3, end).toLowerCase().replace(/\[\s*(['"])([^'"\]]*)\1\s*\]/g, ".$2").replace(/\s+/g, "");
    // The number alone names no code (a branch called backport-<n> is not the pull request's): only inside
    // `pull/<n>/head` or `refs/pull/<n>`, which PR_REF reads.
    if (/github\.event\.pull_request\.(?!base\.|number\b|state\b|draft\b|labels\b|html_url\b)|github\.head_ref|github\.event\.after\b/.test(e)) return true;
    // A ref built from the number (`format('refs/{0}/{1}/merge', 'pull', github.event.number)`).
    if (/github\.event\.(?:pull_request\.)?number\b/.test(e) && /pull|format\(|join\(/.test(e.replace(/github\.event\.pull_request/g, ""))) return true;
  }
  return false;
}

/**
 * The kind of a CI file: every file directly in `.github/workflows/` is a workflow (GitHub runs each one, an
 * `action.yml` there too); an `action.yml` or `action.yaml` elsewhere is an action.
 * @param {string} path
 */
export const ciKind = (path) => (/^\.github\/workflows\/[^/]+$/.test(path) ? "workflow" : /(^|\/)action\.ya?ml$/.test(path) ? "action" : "workflow");

/**
 * @typedef {{ uses: { n: number, job: string, value: string, pinned: boolean, from?: string }[], pwn: { n: number, what: string }[], unpermitted: { job: string, n: number }[], writeAll: { where: string, n: number }[], unread: { n: number, what: string, text?: string }[], targeted: boolean, callees: { n: number, path: string }[], loose: { job: string, n: number, dir: string, from: string }[] }} Findings
 */

/** git commands that bring code into the work tree or the index. */
const GIT_FETCHES = new Set(["fetch", "checkout", "switch", "pull", "worktree", "clone", "am", "apply", "merge", "rebase", "reset", "restore", "cherry-pick"]);

/** Variables the runner itself sets to the pull request's code. */
const RUNNER_HEAD = ["GITHUB_HEAD_REF"];

/**
 * Whether a text names the pull request's code: a ref literal, an expression, or a variable in `names` (`$X`,
 * `${X}`, `${{ env.X }}`).
 * @param {string} text @param {Set<string>} names
 */
function holdsRef(text, names) {
  return PR_REF.test(text) || prExpression(text) || [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)|\$\{\{\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gi)].some((m) => names.has(m[1] ?? m[2] ?? m[3]));
}

/**
 * A run block's logical lines: a line ending in `\\` goes on in the next. `k` is the block line it starts on.
 * @param {string[]} lines
 */
function logicalLines(lines) {
  /** @type {{ k: number, text: string }[]} */
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const from = k;
    let text = lines[k];
    while (/\\\s*$/.test(text) && k + 1 < lines.length) text = `${text.replace(/\\\s*$/, " ")}${lines[++k]}`;
    out.push({ k: from, text });
  }
  return out;
}

/**
 * A local `uses` path as the repository's own: `./x/../y` is `y`, `./` is ""; one that leaves the repository is "..".
 * @param {string} v
 */
export function localPath(v) {
  /** @type {string[]} */
  const parts = [];
  for (const p of v.replace(/^\.\//, "").split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!parts.length) return "..";
      parts.pop();
    } else parts.push(p);
  }
  return parts.join("/");
}

/**
 * Placements of another repository, for looking up a step's local path: per job, per directory, the earliest. A
 * path is under one when the directory is the whole workspace ("") or one of the path's own prefixes, so a lookup
 * costs the path's depth, not the number of placements.
 * @param {{ job: string, n: number, dir: string, from: string }[]} loose
 */
function placements(loose) {
  /** @type {Map<string, Map<string, { n: number, from: string }>>} */
  const byJob = new Map();
  for (const l of loose) {
    const dirs = byJob.get(l.job) ?? byJob.set(l.job, new Map()).get(l.job);
    const had = /** @type {Map<string, { n: number, from: string }>} */ (dirs).get(l.dir);
    if (!had || l.n < had.n) /** @type {Map<string, { n: number, from: string }>} */ (dirs).set(l.dir, { n: l.n, from: l.from });
  }
  /** The placement a local path at line `n` of `job` lies under, if any. @param {string} job @param {number} n @param {string} path */
  return (job, n, path) => {
    const dirs = byJob.get(job);
    if (!dirs) return undefined;
    const parts = path.split("/");
    for (let k = 0; k <= parts.length; k++) {
      const hit = dirs.get(parts.slice(0, k).join("/"));
      if (hit && hit.n < n) return hit;
    }
    return undefined;
  };
}

/**
 * A folded block scalar's lines as YAML gives them to the shell: lines of one paragraph joined by a space, so
 * `git fetch origin` and the ref on the line below are one command. The first line of a paragraph keeps its place;
 * the lines joined into it are left empty, so every line still has its number.
 * @param {string[]} block
 */
function folded(block) {
  const out = block.map(() => "");
  for (let k = 0, at = -1; k < block.length; k++) {
    if (!block[k].trim()) at = -1;
    else if (at === -1) (at = k), (out[k] = block[k].trim());
    else out[at] = `${out[at]} ${block[k].trim()}`;
  }
  return out;
}

/**
 * A command's words, in one pass: an expression (`${{ runner.temp }}`) and a quoted string are part of one word,
 * the quotes taken off.
 * @param {string} c
 */
function words(c) {
  /** @type {string[]} */
  const out = [];
  let cur = "";
  for (let i = 0; i < c.length; ) {
    if (/\s/.test(c[i])) {
      if (cur) out.push(cur), (cur = "");
      i++;
    } else if (c.startsWith("${{", i)) {
      const end = c.indexOf("}}", i + 3);
      if (end === -1) return [...out, cur + c.slice(i)];
      cur += c.slice(i, end + 2);
      i = end + 2;
    } else if (c[i] === '"' || c[i] === "'") {
      const end = c.indexOf(c[i], i + 1);
      if (end === -1) return [...out, cur + c.slice(i + 1)];
      cur += c.slice(i + 1, end);
      i = end + 1;
    } else cur += c[i++];
  }
  return cur ? [...out, cur] : out;
}

/**
 * The directories a run block clones another repository into (`git clone <url> [dir]`, `gh repo clone <repo>
 * [dir]`): a clone is of a branch, so local actions there run code nobody pinned.
 * @param {string[]} lines
 */
function clones(lines) {
  /** @type {{ k: number, dir: string, from: string }[]} */
  const out = [];
  const valued = /^(?:-[bocujC]|--(?:branch|origin|config|depth|reference|reference-if-able|filter|template|upload-pack|jobs|separate-git-dir|shallow-since|shallow-exclude|server-option|bundle-uri))$/;
  for (const { k, text } of logicalLines(lines)) {
    for (const command of text.split(/;|&&|\|\||\|/)) {
      const w = words(command.trim());
      // Wherever the command stands: `GIT_TERMINAL_PROMPT=0 git clone …`, `timeout 60 gh repo clone …`.
      const g = w.findIndex((x, j) => (x === "git" || x.endsWith("/git")) && w[j + 1] === "clone");
      const h = w.findIndex((x, j) => x === "gh" && w[j + 1] === "repo" && w[j + 2] === "clone");
      const at = g !== -1 ? g + 2 : h !== -1 ? h + 3 : -1;
      if (at === -1) continue;
      /** @type {string[]} */
      const pos = [];
      for (let j = at; j < w.length; j++) {
        if (w[j] === "--") continue;
        if (w[j].startsWith("-")) {
          if (valued.test(w[j])) j++;
          continue;
        }
        pos.push(w[j]);
      }
      if (!pos.length) continue;
      const dir = pos[1] ?? (pos[0].split(/[/:]/).pop() ?? "").replace(/\.git$/, "");
      out.push({ k, dir, from: `${pos[0]} (cloned)` });
    }
  }
  return out;
}

/**
 * The lines of a `run` block that fetch or check out the pull request's code, as `{ k, what }` (k: the block line
 * it starts on). Read line by line, a line ending in `\\` joined to the next, wherever the command stands in the
 * line (`if git checkout …`, `timeout 60 git fetch …`, `$(git …)`, `bash -c '…'`): `gh pr checkout`; `gh pr diff`
 * with `git apply` or `git am`; `git` with a word that brings code in (GIT_FETCHES) and the pull request's ref on
 * the same line — a ref literal (PR_REF), an expression (prExpression), or a shell variable that holds one, set on
 * an earlier line, in an `env` of the file (`tainted`), or by the runner (GITHUB_HEAD_REF). A ref passed through a
 * file or a step's outputs is not followed.
 * @param {string[]} lines @param {Set<string>} names variables that hold the pull request's ref (added to as read)
 */
function runFetches(lines, names) {
  /** @type {{ k: number, what: string }[]} */
  const out = [];
  // A patch of the pull request kept in a file and applied on another line: the block holds both.
  const all = lines.join("\n");
  const flat = all.replace(/\s+/g, "");
  const patched =
    /\bgh\s+pr\s+diff\b/.test(all) ||
    /(?:patch|diff)_url\b|html_url\}\}\.(?:patch|diff)\b|\/pulls?\/[^"'|]{0,400}?\.(?:patch|diff)\b|application\/vnd\.github[\w.+-]{0,40}\.(?:diff|patch)\b/i.test(flat);
  // Shell functions that fetch or check out what they are given ($1, $@): a call with the pull request's ref is a fetch.
  /** @type {Set<string>} */
  const fetchers = new Set();
  for (const m of all.matchAll(/(?:^|\n)\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{([^}]*)\}/g)) {
    if (/(?:^|[^\w-])git(?![\w-])/.test(m[2]) && [...GIT_FETCHES].some((w) => new RegExp(`(?:^|[^\\w-])${w}(?![\\w-])`).test(m[2])) && /\$(?:\{?[1-9@*]\}?)/.test(m[2])) fetchers.add(m[1]);
  }
  for (const { k, text } of logicalLines(lines)) {
    const calls = [...fetchers].some((f) => new RegExp(`(?:^|[\\s;&|(])${f}(?![\\w-])\\s+\\S`).test(text) && !new RegExp(`${f}\\s*\\(\\s*\\)`).test(text));
    if (calls && holdsRef(text, names)) out.push({ k, what: text.trim() });
    const has = (/** @type {string} */ w) => new RegExp(`(?:^|[^\\w-])${w}(?![\\w-])`).test(text);
    const git = has("git");
    const hit = /\bgh\s+pr\s+checkout\b/.test(text) || (/\bgh\s+pr\s+diff\b/.test(text) && git && (has("apply") || has("am"))) || (git && [...GIT_FETCHES].some(has) && holdsRef(text, names));
    if (hit || (patched && /(?:^|[^\w-])git(?![\w-])/.test(text) && /(?:^|[^\w-])(?:apply|am)(?![\w-])/.test(text))) out.push({ k, what: text.trim() });
    // `for X in <ref>` and `read X <<< <ref>` taint X as an assignment does.
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]*)/g)) if (holdsRef(m[2], names)) names.add(m[1]);
    for (const m of text.matchAll(/\bread\s+(?:-\S+\s+)*([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*)\s*<<<\s*(.*)$/g)) if (holdsRef(m[2], names)) for (const n of m[1].split(/\s+/)) names.add(n);
    // An assignment taints its name for the lines after it.
    for (const m of text.matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+(?:-\S+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|(?:\$\{\{[^}]*\}\}|\S)+)/g)) if (holdsRef(m[2], names)) names.add(m[1]);
  }
  return out;
}

/**
 * What the rules see in one file. `uses`: every step's and job's `uses`; a step's local path is not pinned when an
 * earlier step of its job checks out another repository (a literal `owner/repo`) at a branch or tag into the
 * directory it names (`from` names that checkout; a job's own `uses: ./…` workflow comes from the caller's commit,
 * never from the workspace); `pwn`: when a pull_request_target trigger reaches the file (the word anywhere outside
 * comments and block scalars, or `targeted` for a file such a workflow calls), each place that checks out the pull
 * request's code; `unpermitted`: with no top-level `permissions`, each job with none of its own; `writeAll`;
 * `unread`: what the reading could not follow; `callees`: the local reusable workflows and actions it uses.
 * @param {string} text
 * @param {"workflow" | "action"} kind
 * @param {{ targeted?: boolean }} [opts]
 * @returns {Findings}
 */
export function ciFindings(text, kind, { targeted: forced = false } = {}) {
  const { entries, unread } = yamlRead(text);
  /** @type {Map<number, Entry[]>} */
  const byItem = new Map();
  for (const e of entries) {
    if (!e.item) continue;
    const list = byItem.get(e.item);
    if (list) list.push(e);
    else byItem.set(e.item, [e]);
  }
  const inItem = (/** @type {number} */ item, /** @type {string[]} */ tail) => byItem.get(item)?.find((e) => tail.every((k, j) => e.path.at(j - tail.length) === k));
  // Where a checkout or a clone puts code, as a directory of the workspace: `${{ github.workspace }}/x`, `./x` and
  // `x/.` are `x`; outside the workspace (an absolute path, the runner's temp) is null, no local action's; a place
  // this reading cannot resolve (another expression or variable, `..`) is the whole workspace.
  const place = (/** @type {string} */ p) => {
    const d = p.replace(/^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)\/?/i, "");
    // A runner's work directory spelled out is the workspace, somewhere this reading cannot place.
    if (/^\/home\/runner\/work\//.test(d)) return "";
    // Outside the workspace (an absolute path, the runner's temp or tool dirs): no `./` reaches it.
    if (/^\/|^(?:\$\{\{\s*runner\.(?:temp|tool_cache)\s*\}\}|\$\{?RUNNER_(?:TEMP|TOOL_CACHE)\}?|~)(?:\/|$)/i.test(d)) return null;
    if (/\$\{\{|\$/.test(d)) return "";
    const parts = d.split("/").filter((x) => x && x !== ".");
    return parts.includes("..") ? "" : parts.join("/");
  };
  // The job a step runs in: a workflow's `jobs.<id>`; an action's steps share one.
  const jobOf = (/** @type {Entry} */ e) => (kind === "workflow" && e.path[0] === "jobs" ? String(e.path[1]) : "");
  /** @type {{ job: string, n: number, dir: string, from: string }[]} */
  const loose = [];
  for (const e of entries) {
    if (e.key !== "repository" || e.path.at(-2) !== "with" || !e.value) continue;
    // This repository, or the pull request's own (what the default checkout of pull_request runs anyway), is not
    // another one; any other name, literal or an expression (`${{ vars.X }}`), is.
    if (/^\$\{\{\s*github\.(?:repository|event\.pull_request\.head\.repo\.full_name)\s*\}\}$/i.test(e.value)) continue;
    const ref = inItem(e.item, ["with", "ref"])?.value ?? "";
    if (/^[0-9a-f]{40}$/.test(ref)) continue;
    const dir = place(inItem(e.item, ["with", "path"])?.value ?? "");
    if (dir !== null) loose.push({ job: jobOf(e), n: e.n, dir, from: `${e.value}@${ref || "its default branch"}` });
  }
  for (const e of entries) {
    if (e.key !== "run" || e.value === null) continue;
    for (const c of clones(e.block ?? [e.value])) {
      const dir = place(c.dir);
      if (dir !== null) loose.push({ job: jobOf(e), n: e.block ? e.n + 1 + c.k : e.n, dir, from: c.from });
    }
  }
  const placedUnder = placements(loose);
  const uses = entries
    .filter((e) => e.key === "uses" && !e.path.slice(kind === "workflow" && e.path[0] === "jobs" ? 2 : 0, -1).some((k) => NOT_STEPS.has(k)))
    .map((e) => {
      const value = e.value ?? "";
      // A job's own `uses: ./…` workflow has no steps, so no checkout of its job comes before it.
      const under = value.startsWith("./") ? placedUnder(jobOf(e), e.n, localPath(value)) : undefined;
      return { n: e.n, job: jobOf(e), value, pinned: !e.unread && e.value !== null && pinnedUses(value) && !under, ...(under ? { from: under.from } : {}) };
    });
  const callees = uses.filter((u) => u.value.startsWith("./")).map((u) => ({ n: u.n, path: localPath(u.value) }));
  /** @type {{ n: number, what: string }[]} */
  const pwn = [];
  const targeted = forced || (kind === "workflow" && entries.some((e) => !e.block && [e.key, e.value].some((s) => s && /\bpull_request_target\b/.test(s))));
  if (targeted) {
    // Variables an `env` of the file sets to the pull request's code.
    const tainted = new Set([...RUNNER_HEAD, ...entries.filter((e) => e.path.includes("env") && e.key !== null && e.value !== null && (prExpression(e.value) || PR_REF.test(e.value))).map((e) => String(e.key))]);
    for (const e of entries) {
      if ((e.key === "ref" || e.key === "repository") && e.value && holdsRef(e.value, tainted)) pwn.push({ n: e.n, what: `${e.key}: ${e.value}` });
      if (e.key === "allow-unsafe-pr-checkout" && /^(true|yes|on|y)$/i.test(e.value ?? "")) pwn.push({ n: e.n, what: `allow-unsafe-pr-checkout: ${e.value}` });
      if (e.key === "run" && e.value !== null) for (const f of runFetches(e.block ? (e.folded ? folded(e.block) : e.block) : [e.value], new Set(tainted))) pwn.push({ n: e.block ? e.n + 1 + f.k : e.n, what: f.what });
    }
  }
  /** @type {{ job: string, n: number }[]} */
  const unpermitted = [];
  /** @type {{ where: string, n: number }[]} */
  const writeAll = [];
  if (kind === "workflow") {
    const topPermissions = entries.find((e) => e.path.length === 1 && e.key === "permissions");
    if (topPermissions?.value === "write-all") writeAll.push({ where: "", n: topPermissions.n });
    /** @type {Map<string, Entry>} */
    const own = new Map();
    for (const e of entries) if (e.path.length === 3 && e.path[0] === "jobs" && e.key === "permissions" && !own.has(String(e.path[1]))) own.set(String(e.path[1]), e);
    /** @type {Set<string>} */
    const seen = new Set();
    for (const job of entries) {
      if (job.path.length !== 2 || job.path[0] !== "jobs" || job.key === null || seen.has(job.key)) continue;
      seen.add(job.key);
      const mine = own.get(job.key);
      if (mine?.value === "write-all") writeAll.push({ where: job.key, n: mine.n });
      if (!topPermissions && !mine) unpermitted.push({ job: job.key, n: job.n });
    }
  }
  return { uses, pwn, unpermitted, writeAll, unread, targeted, callees, loose };
}

/**
 * The findings of a set of CI files read together: a pull_request_target workflow's local callees (reusable
 * workflows, local actions, and theirs, however deep) are read as reached by that trigger, and what they check
 * out counts in their own file, naming the caller. A callee the set does not hold is in `missing`.
 * @param {Map<string, string>} files path → text
 * @returns {{ findings: Map<string, Findings>, missing: { path: string, n: number, callee: string }[] }}
 */
export function ciSet(files) {
  /** @type {Map<string, Findings>} */
  const findings = new Map();
  for (const [path, text] of files) findings.set(path, ciFindings(text, ciKind(path)));
  /** @type {{ path: string, n: number, callee: string }[]} */
  const missing = [];
  const resolve = (/** @type {string} */ p) => calleeFiles(p).find((c) => files.has(c));
  // A local action that places another repository (a checkout by branch, a clone) does so in its caller's
  // workspace: the caller's later local actions in that job are that code too, however deep the calls go.
  /** @type {Map<Findings, Set<string>>} */
  const known = new Map([...findings.values()].map((f) => [f, new Set(f.loose.map((l) => `${l.job}\0${l.n}\0${l.dir}`))]));
  for (let changed = true, rounds = 0; changed && rounds <= files.size; rounds++) {
    changed = false;
    for (const f of findings.values()) {
      const seen = /** @type {Set<string>} */ (known.get(f));
      for (const u of f.uses) {
        if (!u.value.startsWith("./")) continue;
        const callee = resolve(localPath(u.value));
        for (const l of callee ? /** @type {Findings} */ (findings.get(callee)).loose : []) {
          const key = `${u.job}\0${u.n}\0${l.dir}`;
          if (seen.has(key)) continue;
          seen.add(key);
          f.loose.push({ job: u.job, n: u.n, dir: l.dir, from: l.from.includes(" (in ") ? l.from : `${l.from} (in ${callee})` });
          changed = true;
        }
      }
      if (!changed) continue;
      const placedUnder = placements(f.loose);
      for (const u of f.uses) {
        if (!u.pinned || !u.value.startsWith("./")) continue;
        const under = placedUnder(u.job, u.n, localPath(u.value));
        if (under) Object.assign(u, { pinned: false, from: under.from });
      }
    }
  }
  for (const [caller, f] of findings) {
    if (!f.targeted) continue;
    /** @type {Set<string>} */
    const visited = new Set([caller]);
    let wave = f.callees.map((c) => ({ from: caller, ...c }));
    // Every local call, however deep; a file is read once per caller, so a loop of calls ends.
    while (wave.length) {
      /** @type {typeof wave} */
      const next = [];
      for (const c of wave) {
        const path = resolve(c.path);
        if (!path) {
          missing.push({ path: c.from, n: c.n, callee: c.path });
          continue;
        }
        if (visited.has(path)) continue;
        visited.add(path);
        const reached = ciFindings(/** @type {string} */ (files.get(path)), ciKind(path), { targeted: true });
        const own = /** @type {Findings} */ (findings.get(path));
        const had = new Set(own.pwn.map((x) => x.what));
        for (const p of reached.pwn) {
          const what = `${p.what} (reached from ${caller})`;
          if (!had.has(what)) own.pwn.push({ n: p.n, what }), had.add(what);
        }
        next.push(...reached.callees.map((x) => ({ from: path, ...x })));
      }
      wave = next;
    }
  }
  return { findings, missing };
}

/**
 * The files a local `uses` path may name: a reusable workflow by its path, an action by its directory's
 * `action.yml` or `action.yaml` (`""`: the root's); none for a path that leaves the repository.
 * @param {string} path a localPath
 */
export function calleeFiles(path) {
  if (path === "..") return [];
  return /\.ya?ml$/.test(path) ? [path] : path === "" ? ["action.yml", "action.yaml"] : [`${path}/action.yml`, `${path}/action.yaml`];
}

/**
 * The files the local `uses` of a set of CI versions (staged and HEAD's) may name: a reusable workflow by its
 * path, an action by its directory's `action.yml` or `action.yaml` (`./` alone: the root's). The hook reads these
 * too, so a caller reaches its callees wherever they live, without listing the whole index.
 * @param {Map<string, { staged: Buffer | null, head: Buffer | null }>} versions
 */
export function ciCallees(versions) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const [path, v] of versions) {
    for (const bytes of [v.staged, v.head]) {
      const text = bytes ? ciText(bytes) : null;
      if (text === null) continue;
      for (const c of ciFindings(text, ciKind(path)).callees) for (const p of calleeFiles(c.path)) out.add(p);
    }
  }
  return [...out];
}

/**
 * The text of a file the rules can read: UTF-8 with no NUL (a byte order mark is dropped); null otherwise.
 * @param {Buffer} bytes
 */
export function ciText(bytes) {
  if (bytes.includes(0) || !isUtf8(bytes)) return null;
  return bytes.toString("utf8").replace(/^﻿/, "");
}

/**
 * The findings of `now` that `before` (HEAD's version) does not hold, counted: a second copy of something already
 * there is new, a moved line is not. With no HEAD version every finding is new.
 * @param {Findings} now @param {Findings | null} before
 */
export function ciIntroduced(now, before) {
  /**
   * @template T
   * @param {T[]} list @param {(x: T) => string} keyOf @param {T[] | undefined} old
   */
  const extra = (list, keyOf, old) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const x of old ?? []) counts.set(keyOf(x), (counts.get(keyOf(x)) ?? 0) + 1);
    return list.filter((x) => {
      const c = counts.get(keyOf(x)) ?? 0;
      if (c) counts.set(keyOf(x), c - 1);
      return !c;
    });
  };
  return {
    unpinned: extra(now.uses.filter((u) => !u.pinned), (u) => u.value, before?.uses.filter((u) => !u.pinned)),
    pwn: extra(now.pwn, (p) => p.what, before?.pwn),
    unpermitted: extra(now.unpermitted, (j) => j.job, before?.unpermitted),
    writeAll: extra(now.writeAll, (w) => w.where, before?.writeAll),
    unread: extra(now.unread, (u) => `${u.what}\0${u.text ?? ""}`, before?.unread),
  };
}

/** A value from a file, shown on one line as a terminal cannot misread: control and format characters escaped. @param {string} s */
const show = (s) => shown(s).text;

/**
 * The hook's errors and warnings for the CI files of a commit: one error per rule a file breaks, its first three
 * places, values shown escaped; a file that is not UTF-8 text, or cannot be read, is a warning that it was not
 * checked. `versions` (stagedVersions) holds every tracked CI file, so a caller's change reaches its callees.
 * @param {Map<string, { staged: Buffer | null, head: Buffer | null, unread?: string, headUnread?: string }>} versions
 * @param {string} lang
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function ciMessages(versions, lang) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const places = (/** @type {{ n: number }[]} */ list, /** @type {(x: any) => string} */ said) =>
    list.slice(0, 3).map((x) => `${x.n} (${show(said(x))})`).join(", ") + (list.length > 3 ? t("shape.cochangeMore", { n: list.length - 3 }, lang) : "");
  const name = (/** @type {string} */ p) => shown(p, { name: true }).text;
  /** @type {Map<string, string>} */
  const now = new Map();
  /** @type {Map<string, string>} */
  const before = new Map();
  for (const [path, v] of versions) {
    if (v.unread) {
      warnings.push(t("ci.unread", { path: name(path), reason: t(`ci.reason.${v.unread}`, {}, lang) }, lang));
      continue;
    }
    // Deleted: HEAD has it and the index does not. In neither, the name git was asked for is not the name it holds.
    if (!v.staged && !v.head && !v.headUnread) {
      warnings.push(t("ci.unread", { path: name(path), reason: t("ci.reason.notFound", {}, lang) }, lang));
      continue;
    }
    const staged = v.staged ? ciText(v.staged) : null;
    if (v.staged && staged === null) warnings.push(t("ci.unread", { path: name(path), reason: t("ci.reason.notText", {}, lang) }, lang));
    if (staged !== null) now.set(path, staged);
    // A HEAD version that cannot be read is no version (stagedVersions leaves it null): everything staged is new.
    const head = v.head ? ciText(v.head) : null;
    if (head !== null) before.set(path, head);
  }
  const a = ciSet(now);
  const b = ciSet(before);
  for (const [path, found] of a.findings) {
    const intro = ciIntroduced(found, b.findings.get(path) ?? null);
    const vars = { path: name(path) };
    if (intro.unpinned.length) errors.push(t("ci.unpinned", { ...vars, n: intro.unpinned.length, where: places(intro.unpinned, (u) => (u.from ? `${u.value} ← ${u.from}` : u.value)) }, lang));
    if (intro.pwn.length) errors.push(t("ci.pwn", { ...vars, where: places(intro.pwn, (p) => p.what.slice(0, 120)) }, lang));
    if (intro.unpermitted.length) errors.push(t("ci.permissions", { ...vars, where: places(intro.unpermitted, (j) => j.job) }, lang));
    if (intro.writeAll.length) errors.push(t("ci.writeAll", { ...vars, where: places(intro.writeAll, (w) => w.where || t("ci.top", {}, lang)) }, lang));
    if (intro.unread.length) errors.push(t("ci.forms", { ...vars, where: places(intro.unread, (u) => u.what) }, lang));
  }
  // Said whenever the set is read: a callee HEAD could not read either may hide what is added behind it.
  for (const m of a.missing) warnings.push(t("ci.calleeUnread", { path: name(m.path), n: m.n, callee: name(m.callee) }, lang));
  return { errors, warnings };
}
