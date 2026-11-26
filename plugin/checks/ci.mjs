/**
 * CI files a commit brings (security.ci): GitHub Actions workflows and action files. Three rules, each a
 * measured way into a repository in 2026: an action named by a tag or branch runs whatever that name points
 * to when the job starts (tags of popular actions were moved to code that read the runners' secrets); a
 * pull_request_target workflow that checks out the pull request's code runs a stranger's code with this
 * repository's secrets and a write token, also through a reusable workflow or a local action it calls or hands that
 * code to in a `with:` input of any name (the callee is judged on its own text, where `inputs.<name>` is unread); a
 * workflow that sets no permissions gets the repository's default token, which may write.
 *
 * What is refused is what the commit adds: the staged CI files are compared with HEAD's, so what is already
 * there stays until it is touched, and `doctor` counts it. A file the commit brings that cannot be read is refused,
 * so a text cannot take itself out of the check: one that is not UTF-8, a symbolic link or a file past 16 MB (the
 * runner reads an action file through a link, and up to 10 MB), one whose reading throws. A failure stays with its
 * file: every other file's findings stand, and a call into the file is said.
 *
 * The YAML is read without a parser, in one pass with no backtracking, and fails closed: GitHub's parser cannot run
 * at commit time, so this reading takes only the forms below, exactly, and refuses (`unread`) everything else.
 *   - one document: a `---` alone on its line before any node, a `...` alone after it with nothing after that;
 *     no directive (`%`); a block mapping at its root
 *   - block mappings and sequences by indentation, every key of one mapping and every item of one sequence at the
 *     column the first one took; spaces as indentation, never a tab; keys plain, quoted or escaped; no explicit key
 *     (`?`), no merge key (`<<`, which GitHub reads as a key named so)
 *   - scalars on their key's line or their dash's: plain (its lines below, indented past the key, folded in), quoted
 *     over lines (one joiner folds them; an escaped line break joins with no space), block scalars (`|`, `>`,
 *     chomped and folded as YAML does; none with an indentation indicator); no value on the line below its key; an
 *     escape that names no character (too few digits, past 10FFFF, half a surrogate pair) refused, the file read on
 *   - flow collections, nested, of scalars, pairs and aliases, with no tag or anchor in or on them and no `?`
 *   - anchors on a scalar, a key, or a mapping or sequence below its key or dash; each name defined once. An alias of
 *     a scalar or of a mapping or sequence that holds no alias; never of a block scalar or a node that holds one,
 *     which GitHub reads again where it is replayed
 *   - tags: `!!str` and `!<tag:yaml.org,2002:str>` on a scalar
 *   - comments, blank lines, every line break YAML has; a byte order mark at the start; at most 100 levels; at most
 *     GitHub's 1 MiB
 * White space is a space or a tab, as for YamlDotNet. A refusal is known by the text it covers (the block it opens,
 * the anchored node an alias names, the rest of the file after a second document, the whole file past the limit),
 * so an edit inside it is a new one. Each form is a cell of test/reference/actions-yaml.json with GitHub's own reading
 * (actions/runner's workflow parser, on YamlDotNet); test/reference.test.mjs fails where GitHub's document gives a
 * finding this reading misses.
 */

import { isUtf8 } from "node:buffer";
import { shown, t } from "../core/i18n.mjs";

/**
 * @typedef {{ n: number, path: string[], key: string | null, value: string | null, item: number, block?: string[], folded?: boolean, unread?: boolean }} Entry
 *   `key` null: a sequence item that is a scalar ("- push"); `value` null: a key whose value is a mapping or a
 *   sequence; `item`: the innermost sequence item the entry is in (0: none), so the keys of one step go together;
 *   `block`: the lines of a block scalar; `unread`: a value that is no scalar this reading can give
 */

/** YAML's line breaks: YAML 1.2 has CR, LF and CRLF; YamlDotNet, GitHub's parser, also breaks at NEL, LS and PS. */
const BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

/**
 * Past these the reading stops and says so: the text GitHub reads at most (actions/runner
 * src/Sdk/WorkflowParser/ParseOptions.cs: MaxFileSize, 1024 * 1024 characters; a longer workflow is not run),
 * items nested on one line, levels nested (GitHub's MaxDepth is 50), and entries aliases can multiply into.
 */
export const MAX_TEXT = 1024 * 1024;
const MAX_DASHES = 64;
const MAX_DEPTH = 100;
const MAX_ENTRIES = 200000;

/** YAML's white space is a space or a tab (YamlDotNet's IsWhite); any other space is text. @param {string | undefined} c */
const blank = (c) => c === " " || c === "\t";

/** @param {string} s */
const indentOf = (s) => {
  let i = 0;
  while (i < s.length && blank(s[i])) i++;
  return i;
};

/** The text without the white space YAML drops around it: spaces and tabs, never another space. @param {string} s */
const trimStartW = (s) => s.slice(indentOf(s));
/** @param {string} s */
const trimEndW = (s) => {
  let e = s.length;
  while (e > 0 && blank(s[e - 1])) e--;
  return s.slice(0, e);
};
/** @param {string} s */
const trimW = (s) => trimEndW(trimStartW(s));

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

/** What a form with an escape that names no character is refused as. */
const BAD_ESCAPE = "an escape that names no character (too few digits, past 10FFFF, or half a surrogate pair)";

/** The character a `\x`, `\u` or `\U` escape names; null for one that names none. @param {string} e */
const escaped = (e) => {
  const c = parseInt(e.slice(1), 16);
  return c <= 0x10ffff && (c < 0xd800 || c > 0xdfff) ? String.fromCodePoint(c) : null;
};

/**
 * A double-quoted scalar's escapes. One that names no character stays as written, and `bad` says so.
 * @param {string} s
 */
const unescape = (s) => {
  let bad = false;
  const text = s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, e) => {
    if (!/^[xuU]/.test(e)) return ({ n: "\n", t: "\t", r: "\r", 0: "\0", " ": " ", "/": "/", N: "\u0085", L: "\u2028", P: "\u2029" })[/** @type {string} */ (e)] ?? e;
    const c = escaped(e);
    bad ||= c === null;
    return c ?? all;
  });
  return { text, bad };
};

/** Whether a line ends in an odd run of backslashes: in a double-quoted scalar, an escaped line break. @param {string} s */
const escapedBreak = (s) => {
  let k = 0;
  while (k < s.length && s[s.length - 1 - k] === "\\") k++;
  return k % 2 === 1;
};

/**
 * A line's text before its comment, the quote still open at its end (a quoted scalar that goes on) and the flow
 * collections still open. A `#` starts a comment at the start or after a space or a tab, outside quotes; a quote
 * opens a scalar only where one can start: the line start, after `: ` or `- `, and inside a flow collection after
 * `[`, `{` or `,` (in a block value a comma is a character: `IFS=',' read` holds no quote).
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

/** The tags this reading takes: a string's, short and verbatim. Any other tag is refused. */
const STR_TAGS = new Set(["!!str", "!<tag:yaml.org,2002:str>"]);

/** Properties in front of a node: its tags and its anchor. @param {string} s */
function props(s) {
  let v = s;
  /** @type {string | undefined} */
  let anchor;
  /** @type {string[]} */
  const tags = [];
  for (;;) {
    const p = /^([!&])([^ \t]*)(?:[ \t]+|$)/.exec(v);
    if (!p) return { rest: v, anchor, tags };
    if (p[1] === "&") anchor = p[2];
    else tags.push(`!${p[2]}`);
    v = v.slice(p[0].length);
  }
}

/** A block scalar's header: `|` or `>`, then its indentation and chomping indicators. */
const BLOCK = /^[|>][0-9+-]*$/;

/**
 * The key at the start of a block line: a tag or an anchor in front dropped, a quoted key decoded, a plain key
 * read to the first colon followed by white space or the end. null when the line holds no key.
 * @param {string} rest
 * @returns {{ key: string, value: string, anchor?: string, tags: string[], alias?: string, bad?: boolean } | { explicit: true } | null}
 */
function keyLine(rest) {
  const { rest: s, anchor, tags } = props(rest);
  if (s === "?" || /^\?[ \t]/.test(s)) return { explicit: true };
  // An alias as a key: `*k : value`, or `*k: value`, where the name ends at the colon: GitHub's parser (YamlDotNet,
  // as libyaml) reads an anchor's name as letters, digits, `-` and `_` only, and refuses any other after it.
  const alias = /^\*([0-9A-Za-z_-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(s) ?? /^\*([^ \t]+)[ \t]+:(?:[ \t]+(.*))?$/.exec(s);
  if (alias) return { key: `*${alias[1]}`, value: trimW(alias[2] ?? ""), alias: alias[1], tags };
  if (s[0] === '"' || s[0] === "'") {
    const end = closeAt(s, 1, s[0]);
    if (end === -1) return null;
    const after = trimStartW(s.slice(end + 1));
    if (!(after === ":" || /^:[ \t]/.test(after))) return null;
    const q = s[0] === '"' ? unescape(s.slice(1, end)) : { text: s.slice(1, end).replace(/''/g, "'"), bad: false };
    return { key: q.text, value: trimW(after.slice(1)), anchor, tags, bad: q.bad };
  }
  if (!s || /^[{}[\],&*!|>%@`#]/.test(s) || /^-([ \t]|$)/.test(s)) return null;
  for (let i = 0; i < s.length; i++) if (s[i] === ":" && (i + 1 === s.length || blank(s[i + 1]))) return { key: trimEndW(s.slice(0, i)), value: trimW(s.slice(i + 1)), anchor, tags };
  return null;
}

/**
 * A scalar as YAML reads it: properties in front dropped (the anchor and the tags are given back), quotes taken off,
 * an alias named (`alias`: the caller follows it). `unread`: a quote with text after it; `bad`: an escape that names
 * no character.
 * @param {string} raw
 * @returns {{ value: string, unread?: boolean, anchor?: string, tags: string[], alias?: string, quoted?: boolean, bad?: boolean }}
 */
function scalar(raw) {
  const { rest, anchor, tags } = props(trimW(raw));
  const v = trimW(rest);
  const alias = /^\*([^ \t]+)$/.exec(v);
  if (alias) return { value: v, alias: alias[1], anchor, tags };
  if (v[0] === '"' || v[0] === "'") {
    const end = closeAt(v, 1, v[0]);
    if (end !== v.length - 1) return { value: v, unread: true, anchor, tags };
    const q = v[0] === '"' ? unescape(v.slice(1, end)) : { text: v.slice(1, end).replace(/''/g, "'"), bad: false };
    return { value: q.text, anchor, tags, quoted: true, bad: q.bad };
  }
  return { value: v, anchor, tags };
}

/**
 * A block scalar's value as YAML gives it: its lines (those below the header that are blank or indented past the
 * key) without the indentation of its first line, a literal (`|`) kept line by line, a folded one (`>`) joined by
 * spaces where lines of the same indentation follow each other, a final line break clipped, stripped (`-`) or
 * kept (`+`). The caller refuses a header with an indentation indicator.
 * @param {string} header @param {string[]} lines @param {boolean} last the block runs to the end of the text
 */
function blockValue(header, lines, last) {
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  // The text's last "line" after a final line break is no line.
  const body = last && lines.length && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const ending = last && lines.at(-1) !== "" ? 0 : 1;
  let end = body.length;
  while (end > 0 && !trimW(body[end - 1])) end--;
  const content = body.slice(0, end);
  const trailing = body.length - end;
  const first = content.find((l) => trimW(l));
  const ind = first === undefined ? 0 : indentOf(first);
  const own = content.map((l) => (indentOf(l) >= ind ? l.slice(ind) : trimStartW(l)));
  let out = "";
  if (header[0] === "|") out = own.join("\n");
  else {
    /** @type {string[]} */
    const parts = [];
    let breaks = 0;
    let started = false;
    let more = false;
    for (const l of own) {
      if (!trimW(l) && !/^[ \t]/.test(l)) {
        breaks++;
        continue;
      }
      const deeper = /^[ \t]/.test(l);
      if (!started) parts.push("\n".repeat(breaks), l);
      else if (!breaks && !deeper && !more) parts.push(" ", l);
      else parts.push(deeper || more ? "\n" : "", "\n".repeat(breaks), l);
      started = true;
      more = deeper;
      breaks = 0;
    }
    out = parts.join("");
  }
  if (!content.length) return chomp === "keep" ? "\n".repeat(trailing + (ending && body.length ? 1 : 0)) : "";
  if (chomp === "strip") return out;
  if (chomp === "keep") return out + "\n".repeat(trailing + ending);
  return out + (ending || trailing ? "\n" : "");
}

/** Past this many forms a reading cannot follow, it stops: the file is refused whole. */
const MAX_UNREAD = 100;

/**
 * Every mapping entry and scalar item of a YAML text, with its line, the keys above it and its sequence item;
 * `unread` lists what this reading cannot follow, each with the text it covers (`text`: the node it hides, the
 * anchored node an alias names, the rest of the text after a second document), so an edit inside a refused form is
 * a new one. It reads only the forms of this module's header, exactly, and refuses the rest.
 * @param {string} text
 * @returns {{ entries: Entry[], unread: { n: number, what: string, text?: string }[] }}
 */
export function yamlRead(text) {
  if (text.length > MAX_TEXT) return { entries: [], unread: [{ n: 1, what: `a file past ${MAX_TEXT} characters, more than GitHub reads`, text }] };
  const lines = text.replace(/^\uFEFF/, "").split(BREAK);
  /** @type {Entry[]} */
  const entries = [];
  /** @type {{ n: number, what: string, from: number, to: number, covers: number[], rest: boolean }[]} */
  const unread = [];
  /** @type {Map<string, string>} */
  const scalars = new Map();
  /** An anchored mapping or sequence: its entries, the path they hang from, and the first item id made in it. */
  /** @type {Map<string, { entries: Entry[], base: string[], firstItem: number }>} */
  const nodes = new Map();
  /**
   * Anchors whose node this reading does not follow: a block scalar's, and a node that holds an alias, which
   * GitHub's parser reads again when the outer alias is replayed, so a later anchor of that name changes it.
   * @type {Set<string>}
   */
  const unfollowed = new Set();
  /** Where each anchor is defined: its line, whose block holds the node. @type {Map<string, number>} */
  const defined = new Map();
  // Aliases followed so far: a node whose span followed one holds an alias.
  let followed = 0;
  /** @type {{ indent: number, key: string | null, item: number, anchor?: string, start: number, base: string[], firstItem: number, followed: number, inner?: number }[]} */
  let stack = [];
  // The column of the document's own keys, set by its first.
  /** @type {number | undefined} */
  let rootInner;
  let items = 0;
  let i = 0;
  let ended = false;
  /** The last line of the block a line opens: the lines below it that are blank or indented past it. @param {number} s */
  const extent = (s) => {
    const col = indentOf(lines[s]);
    let e = s;
    while (e + 1 < lines.length && (!trimW(lines[e + 1]) || indentOf(lines[e + 1]) > col)) e++;
    return e;
  };
  /**
   * A form this reading does not follow, on line `n`: it covers that line's block (and the lines joined to it), the
   * blocks of the lines in `covers` (an anchored node it names), or with `rest` the text to the end.
   * @param {number} n @param {string} what @param {{ covers?: (number | undefined)[], rest?: boolean }} [opts]
   */
  const refuse = (n, what, { covers = [], rest = false } = {}) => {
    if (unread.length >= MAX_UNREAD) return;
    unread.push({ n, what, from: n - 1, to: Math.max(i, extent(n - 1)), covers: /** @type {number[]} */ (covers.filter((c) => c !== undefined)), rest: rest || unread.length + 1 === MAX_UNREAD });
  };
  const keys = () => /** @type {string[]} */ (stack.filter((f) => f.key !== null).map((f) => f.key));
  const itemNow = () => [...stack].reverse().find((f) => f.key === null)?.item ?? 0;
  /** An anchor's definition on line `n`: a name defined twice is refused, both nodes covered. @param {string} name @param {number} n */
  const define = (name, n) => {
    if (defined.has(name)) refuse(n, `&${name}, an anchor named twice`, { covers: [defined.get(name)] });
    defined.set(name, n - 1);
  };
  // An anchor named again means the newest node: one of the other kind of that name is forgotten.
  const anchorScalar = (/** @type {string} */ name, /** @type {string} */ value) => {
    nodes.delete(name);
    unfollowed.delete(name);
    scalars.set(name, value);
  };
  const anchorUnfollowed = (/** @type {string} */ name) => {
    nodes.delete(name);
    scalars.delete(name);
    unfollowed.add(name);
  };
  const close = (/** @type {(typeof stack)[number]} */ f) => {
    if (f.anchor === undefined) return;
    if (followed > f.followed) return anchorUnfollowed(f.anchor);
    scalars.delete(f.anchor);
    unfollowed.delete(f.anchor);
    nodes.set(f.anchor, { entries: entries.slice(f.start), base: f.base, firstItem: f.firstItem });
  };
  const push = (/** @type {(typeof stack)[number]} */ f, /** @type {number} */ n) => {
    if (stack.length >= MAX_DEPTH) return void refuse(n, `levels nested past ${MAX_DEPTH}`);
    stack.push(f);
  };
  const pop = (/** @type {(f: (typeof stack)[number]) => boolean} */ until) => {
    while (stack.length && until(/** @type {(typeof stack)[number]} */ (stack.at(-1)))) close(/** @type {(typeof stack)[number]} */ (stack.pop()));
  };
  /**
   * A node's place among its siblings: every key of a mapping, and every item of a sequence, at the column the first
   * one took. false (and refused) for one at another column.
   * @param {number} col @param {number} n
   */
  const sibling = (col, n) => {
    const f = stack.at(-1);
    const inner = f ? f.inner : rootInner;
    if (inner === undefined) {
      if (f) f.inner = col;
      else rootInner = col;
      return true;
    }
    if (inner === col) return true;
    refuse(n, "a line at a column its mapping or sequence does not use");
    return false;
  };
  /** Tags other than a string's are refused. @param {string[]} tags @param {number} n */
  const tagsOk = (tags, n) => {
    if (tags.every((x) => STR_TAGS.has(x))) return true;
    refuse(n, `a tag this reading does not take (${tags.find((x) => !STR_TAGS.has(x))})`);
    return false;
  };
  /** A scalar alias's text, or undefined when it names no scalar this reading follows. @param {string} name @param {number} n */
  const scalarOf = (name, n) => {
    if (unfollowed.has(name)) return void refuse(n, `*${name}, an alias of a node this reading does not follow (a block scalar, or one that holds an alias)`, { covers: [defined.get(name)] });
    const v = scalars.get(name);
    if (v !== undefined) followed++;
    return v;
  };
  /** An alias of a mapping or a sequence, read again where it stands: at `path`, in item `item`, on line `n`. */
  const expand = (/** @type {string} */ name, /** @type {string[]} */ path, /** @type {number} */ item, /** @type {number} */ n) => {
    if (unfollowed.has(name)) return refuse(n, `*${name}, an alias of a node this reading does not follow (a block scalar, or one that holds an alias)`, { covers: [defined.get(name)] });
    const node = nodes.get(name);
    if (!node) return refuse(n, `*${name}, an alias with no anchor before it`);
    if (entries.length + node.entries.length > MAX_ENTRIES) return refuse(n, `*${name}, aliases that grow past ${MAX_ENTRIES} entries`, { covers: [defined.get(name)] });
    followed++;
    /** @type {Map<number, number>} */
    const fresh = new Map();
    for (const e of node.entries) {
      const own = e.item >= node.firstItem ? (fresh.get(e.item) ?? fresh.set(e.item, ++items).get(e.item)) : item;
      entries.push({ ...e, n, path: [...path, ...e.path.slice(node.base.length)], item: /** @type {number} */ (own) });
    }
  };
  /**
   * A scalar value at `path` (`key` null: an item): an alias followed, a quote with text after it refused.
   * @param {string} raw @param {string[]} path @param {string | null} key @param {number} item @param {number} n
   * @param {(s: ReturnType<typeof scalar>) => string} [more] the plain value's lines below
   */
  const value = (raw, path, key, item, n, more) => {
    const s = scalar(raw);
    if (!tagsOk(s.tags, n)) return;
    if (s.unread) refuse(n, "a quote with text after it");
    if (s.bad) refuse(n, BAD_ESCAPE);
    if (s.alias !== undefined) {
      const v = scalarOf(s.alias, n);
      if (v !== undefined) return void entries.push({ n, path, key, value: v, item });
      // A mapping or a sequence is read again here; any other alias keeps its name, unread.
      if (key !== null) entries.push({ n, path, key, value: nodes.has(s.alias) ? null : s.value, item, ...(nodes.has(s.alias) ? {} : { unread: true }) });
      if (!unfollowed.has(s.alias)) expand(s.alias, path, item, n);
      return;
    }
    const v = more && !s.quoted && !s.unread ? more(s) : s.value;
    if (s.anchor !== undefined) {
      define(s.anchor, n);
      anchorScalar(s.anchor, v);
    }
    entries.push({ n, path, key, value: v, item, ...(s.unread || s.bad ? { unread: true } : {}) });
  };
  /** A flow collection (`[…]`, `{…}`, nested) read into entries at `path`, in item `item`, on line `n`. */
  const flow = (/** @type {string} */ src, /** @type {string[]} */ path, /** @type {number} */ item, /** @type {number} */ n) => {
    let i = 0;
    const ws = () => {
      while (i < src.length && blank(src[i])) i++;
    };
    const token = (/** @type {string} */ stops) => {
      ws();
      const from = i;
      // In a flow collection this reading takes no properties: a tag or an anchor on a node there is refused.
      if (src[i] === "&" || src[i] === "!") throw new Error("a tag or an anchor in a flow collection");
      if (src[i] === '"' || src[i] === "'") {
        const end = closeAt(src, i + 1, src[i]);
        if (end === -1) throw new Error("a quote that does not close");
        i = end + 1;
        return src.slice(from, i);
      }
      while (i < src.length && !stops.includes(src[i]) && !(src[i] === ":" && stops.includes(":") && (i + 1 === src.length || /[ \t,\]}]/.test(src[i + 1])))) i++;
      const t = trimW(src.slice(from, i));
      // GitHub's parser reads `?` in a flow collection as the explicit key, whatever follows it.
      if (t.includes("?")) throw new Error("a ? in a flow collection");
      return t;
    };
    const keyOf = (/** @type {string} */ raw) => {
      const s = scalar(raw);
      if (s.alias === undefined) {
        if (s.value === "<<" && !s.quoted) throw new Error("a merge key (<<)");
        if (s.bad) throw new Error(BAD_ESCAPE);
        return s.value;
      }
      const v = scalarOf(s.alias, n);
      if (v === undefined) throw new Error(`*${s.alias} as a key`);
      return v;
    };
    // A key's value after its colon, up to `stops`: a collection, an alias, a scalar.
    const after = (/** @type {string[]} */ at, /** @type {number} */ it, /** @type {string} */ k, /** @type {string} */ stops) => {
      i++;
      ws();
      if (src[i] === "[" || src[i] === "{") return node([...at, k], it, k);
      value(token(stops), [...at, k], k, it, n);
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
              const raw = token(":,]");
              ws();
              // `[uses: x]`: a single pair is a mapping of one key, the item.
              if (src[i] === ":") after(at, id, keyOf(raw), ",]");
              else value(raw, at, null, id, n);
            }
          } else {
            const k = keyOf(token(":,}"));
            ws();
            if (src[i] === ":") after(at, it, k, ",}");
            else entries.push({ n, path: [...at, k], key: k, value: "", item: it });
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
      refuse(n, `a flow collection this reading cannot follow (${/** @type {Error} */ (e).message})`);
    }
  };
  // A line that reads as a key or an item at or left of `col` ends a scalar or a flow collection for this
  // reading: YAML might read it either way, so what was being joined is refused, not swallowed.
  const structure = (/** @type {string} */ raw, /** @type {number} */ col) => {
    const t = trimEndW(scan(raw).body);
    if (!trimW(t) || indentOf(t) > col) return false;
    const rest = trimStartW(t).replace(/^(?:-[ \t]+)+/, "");
    return /^-([ \t]|$)/.test(trimStartW(t)) || keyLine(rest) !== null;
  };
  /**
   * The one joiner of lines: from line `from`, a quote or a flow collection left open goes on into the lines
   * below until it closes, each added line read once (a double-quoted line ending in an escaped line break goes on
   * with no space and no indent; any other is folded to a space). It stops at a line that reads as a key or an item
   * at or left of the first line's column, leaving the quote or the collection open.
   * @param {number} from
   */
  const joined = (from) => {
    let { body, quote, flow: depth } = scan(lines[from]);
    const parts = [body];
    let last = body;
    let to = from;
    const start = indentOf(lines[from]);
    while ((quote || depth > 0) && to + 1 < lines.length && !structure(lines[to + 1], start)) {
      const next = scan(lines[++to], quote, depth);
      if (quote === '"' && escapedBreak(last)) parts[parts.length - 1] = /** @type {string} */ (parts.at(-1)).slice(0, -1);
      else parts.push(" ");
      parts.push(trimStartW(next.body));
      last = next.body;
      quote = next.quote;
      depth = next.flow;
    }
    body = parts.join("");
    return { body: trimEndW(body), open: Boolean(quote) || depth > 0, quote, to };
  };
  /**
   * A plain scalar's lines below line `from`, indented past `at` (a dash, a quote or a `?` at their start too), as
   * YAML folds them: a space between lines, a line break for each blank line. A comment ends it; a line that reads
   * as a key ends it, in a file YAML refuses. Gives the value and the last line taken.
   * @param {string} v @param {number} from @param {number} at
   */
  const plainOn = (v, from, at) => {
    if (scan(lines[from]).body.length < lines[from].length) return { v, to: from };
    const parts = [v];
    let to = from;
    for (let j = from + 1, blanks = 0; j < lines.length; j++) {
      const raw = lines[j];
      if (!trimW(raw)) {
        blanks++;
        continue;
      }
      const t = trimStartW(raw);
      const key = keyLine(t);
      if (indentOf(raw) <= at || t[0] === "#" || (key !== null && !("explicit" in key))) break;
      let hash = -1;
      for (let k = 1; k < t.length && hash === -1; k++) if (t[k] === "#" && blank(t[k - 1])) hash = k;
      parts.push(blanks ? "\n".repeat(blanks) : " ", trimEndW(hash === -1 ? t : t.slice(0, hash)));
      blanks = 0;
      to = j;
      if (hash !== -1) break;
    }
    return { v: parts.join(""), to };
  };
  /** A block scalar's lines below line `from`: blank, or indented past `col`. @param {number} from @param {number} col */
  const blockLines = (from, col) => {
    let to = from;
    while (to + 1 < lines.length && (!trimW(lines[to + 1]) || indentOf(lines[to + 1]) > col)) to++;
    return { block: lines.slice(from + 1, to + 1), to };
  };
  /**
   * A block scalar whose header is `header`, below line `i` and indented past `col`: refused with an indentation
   * indicator; its anchor is never followed.
   * @param {string} header @param {string | undefined} anchor @param {string[]} path @param {string | null} key @param {number} item @param {number} n @param {number} col
   */
  const block = (header, anchor, path, key, item, n, col) => {
    const b = blockLines(i, col);
    i = b.to;
    if (anchor !== undefined) {
      define(anchor, n);
      anchorUnfollowed(anchor);
    }
    if (/[0-9]/.test(header)) return refuse(n, "a block scalar with an indentation indicator");
    entries.push({ n, path, key, value: blockValue(header, b.block, b.to === lines.length - 1), item, block: b.block, ...(header[0] === ">" ? { folded: true } : {}) });
  };
  for (i = 0; i < lines.length && unread.length < MAX_UNREAD; i++) {
    const n = i + 1;
    // A logical line: a quote or a flow collection that goes on is joined.
    const line = joined(i);
    i = line.to;
    if (line.open) {
      refuse(n, line.quote ? "a quote that does not close before the next key" : "a flow collection that does not close before the next key");
      continue;
    }
    const body = line.body;
    if (!trimW(body)) continue;
    if (ended) {
      refuse(n, "text after the document's end (...)", { rest: true });
      break;
    }
    // Document markers stand alone on their line, the first before any node; a directive is refused.
    if (/^(---|\.\.\.)([ \t]|$)/.test(body)) {
      if (trimW(body.slice(3)) || (body.startsWith("---") && (entries.length || stack.length || rootInner !== undefined))) {
        refuse(n, "a document marker with a node after it, or a second document", { rest: true });
        break;
      }
      if (body.startsWith("...")) ended = true;
      continue;
    }
    if (body[0] === "%") {
      refuse(n, "a directive (%)", { rest: true });
      break;
    }
    // Indentation is spaces: a tab in it is refused.
    if (/^ *\t/.test(body)) {
      refuse(n, "a tab in the indentation");
      continue;
    }
    let col = indentOf(body);
    let rest = trimStartW(body);
    // The column a collection's lines must stay right of: the key's, or for an item the dash's.
    let dashCol = col;
    // Sequence items: each dash moves the content right; the item belongs to the nearest key at its column or left of it.
    let dashes = 0;
    let placed = true;
    while ((rest === "-" || /^-[ \t]/.test(rest)) && ++dashes <= MAX_DASHES) {
      dashCol = col;
      pop((f) => f.indent > col || (f.key === null && f.indent === col));
      placed = sibling(col, n);
      if (!placed) break;
      push({ indent: col, key: null, item: ++items, start: entries.length, base: keys(), firstItem: items, followed }, n);
      const after = rest.slice(1);
      col += 1 + indentOf(after);
      rest = trimStartW(after);
    }
    if (!placed) continue;
    if (dashes > MAX_DASHES) {
      refuse(n, `items nested more than ${MAX_DASHES} deep on one line`);
      continue;
    }
    if (!rest) continue;
    const k = keyLine(rest);
    if (k && "explicit" in k) {
      refuse(n, "an explicit key (?)");
      continue;
    }
    // The value of an explicit key: as unreadable as its key, and its own text, so a change to it is new.
    if (rest === ":" || /^:[ \t]/.test(rest)) {
      refuse(n, "the value of an explicit key (:)");
      continue;
    }
    if (!k) {
      // An item's own node: a scalar, a block scalar, a flow collection, an alias, an anchor for the node below.
      if (!dashes) {
        refuse(n, stack.length || rootInner !== undefined ? "a line that is no key and no item" : "a document that is no block mapping");
        continue;
      }
      const p = props(rest);
      if (!tagsOk(p.tags, n)) continue;
      if (!p.rest && p.tags.length) {
        refuse(n, "properties with no node on their line");
        continue;
      }
      if (p.anchor !== undefined && !p.rest) {
        const f = stack.at(-1);
        if (f && f.key === null) {
          define(p.anchor, n);
          f.anchor = p.anchor;
          f.followed = followed;
          anchorUnfollowed(p.anchor);
        } else refuse(n, "an anchor with no node on its line");
        continue;
      }
      if (/^[[{]/.test(p.rest)) {
        if (p.anchor !== undefined || p.tags.length) refuse(n, "a tag or an anchor on a flow collection");
        else flow(p.rest, keys(), itemNow(), n);
        continue;
      }
      if (BLOCK.test(p.rest)) {
        block(p.rest, p.anchor, keys(), null, itemNow(), n, dashCol);
        continue;
      }
      value(rest, keys(), null, itemNow(), n, (s) => {
        const on = plainOn(s.value, i, dashCol);
        i = on.to;
        return on.v;
      });
      continue;
    }
    pop((f) => f.indent >= col);
    if (!sibling(col, n) || !tagsOk(k.tags, n)) continue;
    if (k.bad) refuse(n, BAD_ESCAPE);
    // An anchor on a key names the key's text; an alias as a key is that text, or unreadable.
    if (k.anchor !== undefined) {
      define(k.anchor, n);
      anchorScalar(k.anchor, k.key);
    }
    if (k.alias !== undefined) {
      const named = scalarOf(k.alias, n);
      if (named === undefined) {
        if (!unfollowed.has(k.alias)) refuse(n, `${k.key}, an alias as a key with no anchor before it`);
        continue;
      }
      k.key = named;
    }
    if (k.key === "<<" && !/^["']/.test(trimStartW(props(rest).rest))) {
      refuse(n, "a merge key (<<), which GitHub reads as a key named so");
      continue;
    }
    const item = itemNow();
    const path = [...keys(), k.key];
    const p = props(k.value);
    if (!tagsOk(p.tags, n)) continue;
    if (/^[[{]/.test(p.rest)) {
      if (p.anchor !== undefined || p.tags.length) {
        refuse(n, "a tag or an anchor on a flow collection");
        continue;
      }
      entries.push({ n, path, key: k.key, value: null, item });
      flow(p.rest, path, item, n);
      continue;
    }
    if (BLOCK.test(p.rest)) {
      // A block scalar: the lines below that are blank or indented past the key. Its anchor is not followed.
      block(p.rest, p.anchor, path, k.key, item, n, col);
      continue;
    }
    if (p.rest === "") {
      // No value on the key's line: a mapping or a sequence below. A value on the line below its key is refused.
      let j = i + 1;
      while (j < lines.length && !trimW(scan(lines[j]).body)) j++;
      const next = j < lines.length ? trimEndW(scan(lines[j]).body) : "";
      if (next && indentOf(next) > col && !keyLine(trimStartW(next)) && !/^-([ \t]|$)/.test(trimStartW(next))) {
        refuse(n, "a value on the line below its key");
        i = blockLines(i, col).to;
        continue;
      }
      if (p.tags.length) {
        refuse(n, "a tag on a mapping or a sequence");
        continue;
      }
      if (p.anchor !== undefined) define(p.anchor, n);
      entries.push({ n, path, key: k.key, value: null, item });
      push({ indent: col, key: k.key, item, anchor: p.anchor, start: entries.length, base: path, firstItem: items + 1, followed }, n);
      if (p.anchor !== undefined) anchorUnfollowed(p.anchor);
      continue;
    }
    value(k.value, path, k.key, item, n, (s) => {
      const on = plainOn(s.value, i, col);
      i = on.to;
      return on.v;
    });
  }
  pop(() => true);
  if (unread.length >= MAX_UNREAD) unread[unread.length - 1].rest = true;
  // Each refusal is known by the text it covers: an edit inside it, or in the anchored node it names, is a new one.
  const region = (/** @type {number} */ from, /** @type {number} */ to) => lines.slice(from, to + 1).join("\n");
  return {
    entries,
    unread: unread.map((u) => ({ n: u.n, what: u.what, text: [u.rest ? lines.slice(u.from).join("\n") : region(u.from, u.to), ...u.covers.map((c) => region(c, extent(c)))].join("\n\0") })),
  };
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
 * The fields of `github.event.pull_request` that name no code: its base, and those GitHub gives as a number, a
 * count, a flag, a time, an id or an enum (the pull_request webhook payload's schema, octokit/webhooks
 * payload-schemas common/pull-request, user and author_association), and state, labels, html_url. A branch called
 * backport-<n> is not the pull request's. Any other field counts, an object holding a login or text too.
 */
const NO_CODE = ["base", "number", "state", "draft", "labels", "html_url", "id", "node_id", "additions", "deletions", "changed_files", "commits", "comments", "review_comments", "author_association", "merged", "mergeable", "mergeable_state", "rebaseable", "maintainer_can_modify", "locked", "active_lock_reason", "created_at", "updated_at", "closed_at", "merged_at", "user.id", "user.type"];
const PR_FIELD = new RegExp(`github\\.event\\.pull_request\\.(?!(?:${NO_CODE.map((f) => f.replace(".", "\\.")).join("|")})\\b)`);

/**
 * Whether a text holds an expression on the pull request's own code: its head, number, merge commit or ref
 * (any field of `github.event.pull_request` but those NO_CODE names: the author's login, title or body still count,
 * they can name a fork or a ref), the whole of it in `toJSON` (of `github`, `github.event` or the pull request: the
 * text holds the head), `github.head_ref`, `github.event.after` (a synchronize event's head), and the number where
 * the expression builds a ref from it (`pull` in it, or format() or join()). Contexts are read without case, `['x']`
 * as `.x`. One pass: an expression that does not close ends it.
 * @param {string} text
 */
export function prExpression(text) {
  // Each expression read once: the next one is looked for past this one's end, so a text costs its length.
  for (let at = text.indexOf("${{"), end = 0; at !== -1; at = text.indexOf("${{", end + 2)) {
    end = text.indexOf("}}", at + 3);
    if (end === -1) return false;
    const e = text.slice(at + 3, end).toLowerCase().replace(/\[\s*(['"])([^'"\]]*)\1\s*\]/g, ".$2").replace(/\s+/g, "");
    // The number alone names no code (a branch called backport-<n> is not the pull request's): only inside
    // `pull/<n>/head` or `refs/pull/<n>`, which PR_REF reads.
    if (PR_FIELD.test(e) || /github\.head_ref|github\.event\.after\b|tojson\(github(?:\.event(?:\.pull_request)?)?\)/.test(e)) return true;
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
 * @typedef {{ uses: { n: number, at: number, job: string, value: string, pinned: boolean, from?: string }[], pwn: { n: number, at: number, what: string, to?: string, reach?: string[] }[], unpermitted: { job: string, n: number }[], writeAll: { where: string, n: number }[], unread: { n: number, what: string, text?: string }[], targeted: boolean, callees: { n: number, path: string }[], loose: { job: string, n: number, at: number, dir: string, from: string }[], stopped?: boolean }} Findings
 *   `at`: the entry's place in the reading, the order steps run in (a line holds several in a flow collection);
 *   `stopped`: the reading threw (fileFindings); a `pwn`'s `to`: the local callee a `with:` hands the pull request's code to, `reach` (ciSet): the
 *   files of the set that callee reaches, itself included
 */

/** git commands that bring code into the work tree or the index. */
const GIT_FETCHES = new Set(["fetch", "checkout", "switch", "pull", "worktree", "clone", "am", "apply", "merge", "rebase", "reset", "restore", "cherry-pick"]);

/** Variables the runner itself sets to the pull request's code. */
export const RUNNER_HEAD = ["GITHUB_HEAD_REF"];

/**
 * Whether a text names the pull request's code: a ref literal, an expression, or a variable in `names` (`$X`,
 * `${X}`, `${{ env.X }}`).
 * @param {string} text @param {Set<string>} names
 */
export function holdsRef(text, names) {
  return PR_REF.test(text) || prExpression(text) || [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)|\$\{\{\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gi)].some((m) => names.has(m[1] ?? m[2] ?? m[3]));
}

/**
 * Where a line goes on in the next: a `\` (sh, bash), a backtick (PowerShell) or a `^` (cmd) at its end, before any
 * white space. Joined whatever the step's shell: joining more lines only finds more. The index of that character, or -1.
 * @param {string} line
 */
function continuation(line) {
  let e = line.length;
  while (e > 0 && /\s/.test(line[e - 1])) e--;
  return e > 0 && "\\`^".includes(line[e - 1]) ? e - 1 : -1;
}

/**
 * A run block's logical lines: a line ending in a continuation goes on in the next. `k` is the block line it starts on.
 * @param {string[]} lines
 */
function logicalLines(lines) {
  /** @type {{ k: number, text: string }[]} */
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const from = k;
    const parts = [];
    let line = lines[k];
    for (let at = continuation(line); at !== -1 && k + 1 < lines.length; at = continuation(line)) {
      parts.push(line.slice(0, at), " ");
      line = lines[++k];
    }
    parts.push(line);
    out.push({ k: from, text: parts.join("") });
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
 * Where a checkout or a clone puts code, as a directory of the workspace (a backslash, Windows', read as `/`):
 * `${{ github.workspace }}/x`, `./x` and `x/.` are `x`; outside the workspace (an absolute path, the runner's temp) is null, no local action's; a place
 * this reading cannot resolve (another expression or variable, `..`) is the whole workspace.
 * @param {string} p
 */
export function workspaceDir(p) {
  const d = p.replace(/\\/g, "/").replace(/^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)\/?/i, "");
  // A runner's work directory spelled out is the workspace, somewhere this reading cannot place.
  if (/^\/home\/runner\/work\//.test(d)) return "";
  // Outside the workspace (an absolute path, the runner's temp or tool dirs): no `./` reaches it.
  if (/^\/|^(?:\$\{\{\s*runner\.(?:temp|tool_cache)\s*\}\}|\$\{?RUNNER_(?:TEMP|TOOL_CACHE)\}?|~)(?:\/|$)/i.test(d)) return null;
  if (/\$\{\{|\$/.test(d)) return "";
  const parts = d.split("/").filter((x) => x && x !== ".");
  return parts.includes("..") ? "" : parts.join("/");
}

/**
 * Placements of another repository, for looking up a step's local path: per job, per directory, the earliest by its
 * place in the reading. A path is under one when the directory is the whole workspace ("") or one of the path's own
 * prefixes, so a lookup costs the path's depth, not the number of placements.
 * @param {{ job: string, at: number, dir: string, from: string }[]} loose
 */
function placements(loose) {
  /** @type {Map<string, Map<string, { at: number, from: string }>>} */
  const byJob = new Map();
  for (const l of loose) {
    const dirs = byJob.get(l.job) ?? byJob.set(l.job, new Map()).get(l.job);
    const had = /** @type {Map<string, { at: number, from: string }>} */ (dirs).get(l.dir);
    if (!had || l.at < had.at) /** @type {Map<string, { at: number, from: string }>} */ (dirs).set(l.dir, { at: l.at, from: l.from });
  }
  /** The placement a local path at place `at` of `job` lies under, if any. @param {string} job @param {number} at @param {string} path */
  return (job, at, path) => {
    const dirs = byJob.get(job);
    if (!dirs) return undefined;
    const parts = path.split("/");
    for (let k = 0; k <= parts.length; k++) {
      const hit = dirs.get(parts.slice(0, k).join("/"));
      if (hit && hit.at < at) return hit;
    }
    return undefined;
  };
}

/**
 * The names a line sets with `NAME=` anywhere in it (inside quotes too, as `echo "NAME=…" >> $GITHUB_ENV` writes them).
 * @param {string} text
 */
function envNames(text) {
  /** @type {string[]} */
  const out = [];
  for (let eq = text.indexOf("="); eq !== -1; eq = text.indexOf("=", eq + 1)) {
    let s = eq;
    while (s > 0 && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
    if (s < eq && /[A-Za-z_]/.test(text[s])) out.push(text.slice(s, eq));
  }
  return out;
}

/**
 * The `read X Y <<< word` of a line, in one pass: each `<<<` found by indexOf, the command before it back to the
 * last separator or here-string read as words, and the text after it up to the next here-string. The first `read`
 * followed only by options and names to the `<<<` is the one (the most names).
 * @param {string} text
 */
function hereStrings(text) {
  /** @type {{ names: string[], ref: string }[]} */
  const out = [];
  const ident = (/** @type {string} */ w) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w);
  for (let at = text.indexOf("<<<"), from = 0; at !== -1; ) {
    const next = text.indexOf("<<<", at + 3);
    let s = at;
    while (s > from && !";&|(\n".includes(text[s - 1])) s--;
    const w = text.slice(s, at).split(/[ \t]+/).filter(Boolean);
    // From the end: where a tail of names begins, and where options then names begin, word by word.
    const tail = Array(w.length + 1).fill(false);
    for (let j = w.length - 1; j >= 0; j--) tail[j] = ident(w[j]) && (j === w.length - 1 || tail[j + 1]);
    const ok = Array(w.length + 1).fill(false);
    for (let j = w.length - 1; j >= 0; j--) ok[j] = w[j].startsWith("-") ? ok[j + 1] : tail[j];
    const r = w.findIndex((x, j) => x === "read" && ok[j + 1]);
    if (r !== -1) out.push({ names: w.slice(r + 1).filter((x) => !x.startsWith("-")), ref: text.slice(at + 3, next === -1 ? text.length : next) });
    from = at + 3;
    at = next;
  }
  return out;
}

/**
 * The next index of `needle` at or after `from`, for scans that only move forward: a search past the last answer runs
 * again, one before it reuses it, so a scan of a text costs its length.
 * @param {string} text @param {string} needle
 */
function seeker(text, needle) {
  let last = -2;
  let asked = -1;
  return (/** @type {number} */ from) => {
    if (last === -1 && from >= asked) return -1;
    if (last >= from && from >= asked) return last;
    asked = from;
    last = text.indexOf(needle, from);
    return last;
  };
}

/**
 * The shell assignments of a line, in one pass: `NAME=value` where NAME starts the line or follows white space or
 * `;`, `&`, `|`, `(`; the value a quoted string, else its characters up to white space, an expression (`${{ … }}`)
 * taken whole.
 * @param {string} text
 */
function assignments(text) {
  /** @type {{ name: string, value: string }[]} */
  const out = [];
  const dq = seeker(text, '"');
  const sq = seeker(text, "'");
  const ex = seeker(text, "}}");
  for (let eq = text.indexOf("="), done = 0; eq !== -1; eq = text.indexOf("=", Math.max(eq + 1, done))) {
    let s = eq;
    while (s > done && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
    if (s === eq || !/[A-Za-z_]/.test(text[s]) || (s > 0 && !/[\s;&|(]/.test(text[s - 1]))) continue;
    let e = eq + 1;
    const q = text[e];
    const close = q === '"' ? dq(e + 1) : q === "'" ? sq(e + 1) : -1;
    if (close !== -1) e = close + 1;
    else
      while (e < text.length && !/\s/.test(text[e])) {
        const end = text.startsWith("${{", e) ? ex(e + 3) : -1;
        e = end === -1 ? e + 1 : end + 2;
      }
    out.push({ name: text.slice(s, eq), value: text.slice(eq + 1, e) });
    done = e;
  }
  return out;
}

/**
 * Shell functions a text defines that fetch or check out what they are given (`$1`, `$@`), in one pass: a line
 * `[function] name() {`, its body to the next `}`. Definitions that share that `}` (one inside another's body) are
 * judged once, by the outermost: the inner body is part of it.
 * @param {string} all
 */
function fetchFunctions(all) {
  /** @type {Set<string>} */
  const out = new Set();
  const closeOf = seeker(all, "}");
  let judgedClose = -2;
  let judged = false;
  for (let at = 0; at < all.length; ) {
    const eol = all.indexOf("\n", at);
    const line = all.slice(at, eol === -1 ? all.length : eol);
    const m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/.exec(line);
    if (m) {
      const open = at + m[0].length;
      const close = closeOf(open);
      if (close === -1) break;
      if (close !== judgedClose) {
        const body = all.slice(open, close);
        judged = /(?:^|[^\w-])git(?![\w-])/.test(body) && [...GIT_FETCHES].some((w) => new RegExp(`(?:^|[^\\w-])${w}(?![\\w-])`).test(body)) && /\$(?:\{?[1-9@*]\}?)/.test(body);
        judgedClose = close;
      }
      if (judged) out.add(m[1]);
    }
    if (eol === -1) break;
    at = eol + 1;
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
export function clones(lines) {
  /** @type {{ k: number, dir: string, from: string }[]} */
  const out = [];
  const valued = /^(?:-[bocujC]|--(?:branch|origin|config|depth|reference|reference-if-able|filter|template|upload-pack|jobs|separate-git-dir|shallow-since|shallow-exclude|server-option|bundle-uri))$/;
  for (const { k, text } of logicalLines(lines)) {
    for (const command of text.split(/;|&&|\|\||\|/)) {
      const w = words(command.trim());
      // Wherever the command stands: `GIT_TERMINAL_PROMPT=0 git clone …`, `timeout 60 gh repo clone …`; git's own
      // options before `clone` skipped (`git -c http.extraheader=… clone`), its `-C <dir>` the directory cloned from.
      let cwd = "";
      let g = -1;
      for (let j = 0; j < w.length && g === -1; j++) {
        if (w[j] !== "git" && !w[j].endsWith("/git")) continue;
        let o = j + 1;
        let dir = "";
        while (o < w.length && w[o].startsWith("-") && w[o] !== "--") {
          if (/^(?:-[Cc]|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--exec-path)$/.test(w[o])) {
            if (w[o] === "-C") dir = dir ? `${dir}/${w[o + 1] ?? ""}` : (w[o + 1] ?? "");
            o += 2;
          } else o++;
        }
        if (w[o] === "clone") (g = o), (cwd = dir);
      }
      const h = w.findIndex((x, j) => x === "gh" && w[j + 1] === "repo" && w[j + 2] === "clone");
      const at = g !== -1 ? g + 1 : h !== -1 ? h + 3 : -1;
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
      const own = pos[1] ?? (pos[0].split(/[/:\\]/).pop() ?? "").replace(/\.git$/, "");
      const dir = cwd && cwd !== "." && !/^[/\\]/.test(own) ? `${cwd}/${own}` : own;
      out.push({ k, dir, from: `${pos[0]} (cloned)` });
    }
  }
  return out;
}

/**
 * Whether a text holds `name`, then `(` and `)`, white space around them: a function's definition. Read by hand: a
 * name comes from the file, and a regular expression built from one past V8's size throws. Each search moves on.
 * @param {string} text @param {string} name
 */
function defines(text, name) {
  const space = (/** @type {number} */ at) => {
    while (at < text.length && /\s/.test(text[at])) at++;
    return at;
  };
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const open = space(at + name.length);
    if (text[open] === "(" && text[space(open + 1)] === ")") return true;
  }
  return false;
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
export function runFetches(lines, names) {
  /** @type {{ k: number, what: string }[]} */
  const out = [];
  // A patch of the pull request kept in a file and applied on another line: the block holds both.
  const all = lines.join("\n");
  const flat = all.replace(/\s+/g, "");
  const patched =
    /\bgh\s+pr\s+diff\b/.test(all) ||
    /(?:patch|diff)_url\b|html_url\}\}\.(?:patch|diff)\b|\/pulls?\/[^"'|]{0,400}?\.(?:patch|diff)\b|application\/vnd\.github[\w.+-]{0,40}\.(?:diff|patch)\b/i.test(flat);
  // Shell functions that fetch or check out what they are given ($1, $@): a call with the pull request's ref is a fetch.
  const fetchers = fetchFunctions(all);
  for (const { k, text } of logicalLines(lines)) {
    // A call: a defined fetcher's name where a command starts, an argument after it, and not its definition.
    const calls = fetchers.size > 0 && [...text.matchAll(/(?:^|[\s;&|(])([A-Za-z_][\w-]*)(?=[ \t]+\S)/g)].some((m) => fetchers.has(m[1]) && !defines(text, m[1]));
    if (calls && holdsRef(text, names)) out.push({ k, what: text.trim() });
    const has = (/** @type {string} */ w) => new RegExp(`(?:^|[^\\w-])${w}(?![\\w-])`).test(text);
    const git = has("git");
    const hit = /\bgh\s+pr\s+checkout\b/.test(text) || (/\bgh\s+pr\s+diff\b/.test(text) && git && (has("apply") || has("am"))) || (git && [...GIT_FETCHES].some(has) && holdsRef(text, names));
    if (hit || (patched && /(?:^|[^\w-])git(?![\w-])/.test(text) && /(?:^|[^\w-])(?:apply|am)(?![\w-])/.test(text))) out.push({ k, what: text.trim() });
    // `for X in <ref>` and `read X <<< <ref>` taint X as an assignment does.
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]*)/g)) if (holdsRef(m[2], names)) names.add(m[1]);
    for (const r of hereStrings(text)) if (holdsRef(r.ref, names)) for (const n of r.names) names.add(n);
    // An assignment taints its name for the lines after it.
    for (const a of assignments(text)) if (holdsRef(a.value, names)) names.add(a.name);
  }
  return out;
}

/**
 * What the rules see in one file. `uses`: every step's and job's `uses`; a step's local path is not pinned when an
 * earlier step of its job checks out another repository (a literal `owner/repo`) at a branch or tag into the
 * directory it names (`from` names that checkout; a job's own `uses: ./…` workflow comes from the caller's commit,
 * never from the workspace); `pwn`: when a pull_request_target trigger reaches the file (the word anywhere outside
 * comments and block scalars, or `targeted` for a file such a workflow calls), each place that checks out the pull
 * request's code, and each value holding it that a `with:` hands to a local callee under any input's name, `ref`
 * and `repository` too (`to`: that callee's `uses`); `unpermitted`: with no top-level `permissions`, each job with none of its own; `writeAll`;
 * `unread`: what the reading could not follow; `callees`: the local reusable workflows and actions it uses.
 * @param {string} text
 * @param {"workflow" | "action"} kind
 * @param {{ targeted?: boolean }} [opts]
 * @returns {Findings}
 */
export const ciFindings = (text, kind, opts) => ciFindingsOf(yamlRead(text), kind, opts);

/**
 * The rules of ciFindings on a reading already made: yamlRead's, or another program's put in its shape (the
 * reference record of test/reference/actions-yaml.mjs gives GitHub's).
 * @param {{ entries: Entry[], unread: { n: number, what: string, text?: string }[] }} read
 * @param {"workflow" | "action"} kind
 * @param {{ targeted?: boolean }} [opts]
 * @returns {Findings}
 */
export function ciFindingsOf({ entries, unread }, kind, { targeted: forced = false } = {}) {
  /** @type {Map<number, Entry[]>} */
  const byItem = new Map();
  for (const e of entries) {
    if (!e.item) continue;
    const list = byItem.get(e.item);
    if (list) list.push(e);
    else byItem.set(e.item, [e]);
  }
  const inItem = (/** @type {number} */ item, /** @type {string[]} */ tail) => byItem.get(item)?.find((e) => tail.every((k, j) => e.path.at(j - tail.length) === k));
  const place = workspaceDir;
  // The job a step runs in: a workflow's `jobs.<id>`; an action's steps share one.
  const jobOf = (/** @type {Entry} */ e) => (kind === "workflow" && e.path[0] === "jobs" ? String(e.path[1]) : "");
  /** @type {{ job: string, n: number, at: number, dir: string, from: string }[]} */
  const loose = [];
  for (const [at, e] of entries.entries()) {
    if (e.key !== "repository" || e.path.at(-2) !== "with" || !e.value) continue;
    // This repository, or the pull request's own (what the default checkout of pull_request runs anyway), is not
    // another one; any other name, literal or an expression (`${{ vars.X }}`), is.
    if (/^\$\{\{\s*github\.(?:repository|event\.pull_request\.head\.repo\.full_name)\s*\}\}$/i.test(e.value)) continue;
    const ref = inItem(e.item, ["with", "ref"])?.value ?? "";
    if (/^[0-9a-f]{40}$/.test(ref)) continue;
    const dir = place(inItem(e.item, ["with", "path"])?.value ?? "");
    if (dir !== null) loose.push({ job: jobOf(e), n: e.n, at, dir, from: `${e.value}@${ref || "its default branch"}` });
  }
  for (const [at, e] of entries.entries()) {
    if (e.key !== "run" || e.value === null) continue;
    for (const c of clones(e.value.split("\n"))) {
      const dir = place(c.dir);
      if (dir !== null) loose.push({ job: jobOf(e), n: e.block ? e.n + 1 + c.k : e.n, at, dir, from: c.from });
    }
  }
  const placedUnder = placements(loose);
  const uses = [...entries.entries()]
    .filter(([, e]) => e.key === "uses" && !e.path.slice(kind === "workflow" && e.path[0] === "jobs" ? 2 : 0, -1).some((k) => NOT_STEPS.has(k)))
    .map(([at, e]) => {
      const value = e.value ?? "";
      // A job's own `uses: ./…` workflow has no steps, so no checkout of its job comes before it.
      const under = value.startsWith("./") ? placedUnder(jobOf(e), at, localPath(value)) : undefined;
      return { n: e.n, at, job: jobOf(e), value, pinned: !e.unread && e.value !== null && pinnedUses(value) && !under, ...(under ? { from: under.from } : {}) };
    });
  const callees = uses.filter((u) => u.value.startsWith("./")).map((u) => ({ n: u.n, path: localPath(u.value) }));
  /** @type {Findings["pwn"]} */
  const pwn = [];
  // The trigger's name in any case (GitHub's parser takes `on:` as any text), in a block scalar too under `on`.
  const targeted = forced || (kind === "workflow" && entries.some((e) => (!e.block || e.path[0] === "on") && [e.key, e.value].some((s) => s && /\bpull_request_target\b/i.test(s))));
  if (targeted) {
    // Variables an `env` of the file sets to the pull request's code.
    const tainted = new Set([...RUNNER_HEAD, ...entries.filter((e) => e.path.includes("env") && e.key !== null && e.value !== null && (prExpression(e.value) || PR_REF.test(e.value))).map((e) => String(e.key))]);
    // A line that writes the pull request's ref to $GITHUB_ENV taints the names it sets for every later step: read
    // without order, over the whole file, until no new name comes.
    for (let pass = 0, grew = true; grew && pass < 5; pass++) {
      grew = false;
      for (const e of entries) {
        if (e.key !== "run" || !e.value?.includes("GITHUB_ENV")) continue;
        for (const { text } of logicalLines(e.value.split("\n"))) {
          if (!text.includes("GITHUB_ENV") || !holdsRef(text, tainted)) continue;
          for (const name of envNames(text)) if (!tainted.has(name)) tainted.add(name), (grew = true);
        }
      }
    }
    // The local actions and reusable workflows a step or a job calls, by the sequence item and the keys of its `uses`:
    // a `with:` of that step or job hands its values to that callee.
    /** @type {Map<string, string>} */
    const handedTo = new Map();
    for (const u of uses) if (u.value.startsWith("./")) handedTo.set(JSON.stringify([entries[u.at].item, ...entries[u.at].path.slice(0, -1)]), u.value);
    for (const [at, e] of entries.entries()) {
      // The pull request's code handed to a local callee under any input's name, `ref` and `repository` too: the callee
      // is judged on its own text, where `${{ inputs.<name> }}` names nothing of the pull request, so the hand-off is
      // refused here, and carries its callee (ciSet gives it the files that callee reaches). Elsewhere a `ref:` or a
      // `repository:` holding the ref is a checkout's.
      const callee = e.key !== null && e.value && e.path.at(-2) === "with" ? handedTo.get(JSON.stringify([e.item, ...e.path.slice(0, -2)])) : undefined;
      if (e.value && (callee !== undefined || e.key === "ref" || e.key === "repository") && holdsRef(e.value, tainted)) {
        pwn.push(callee !== undefined ? { n: e.n, at, what: `${callee} with ${e.key}: ${e.value}`, to: callee } : { n: e.n, at, what: `${e.key}: ${e.value}` });
      }
      if (e.key === "allow-unsafe-pr-checkout" && /^(true|yes|on|y)$/i.test(e.value ?? "")) pwn.push({ n: e.n, at, what: `allow-unsafe-pr-checkout: ${e.value}` });
      // A run's lines as YAML gives them to the shell (a folded block joined, a literal one kept).
      if (e.key === "run" && e.value !== null) for (const f of runFetches(e.value.split("\n"), new Set(tainted))) pwn.push({ n: e.block ? e.n + 1 + f.k : e.n, at, what: f.what });
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
 * ciFindings held to its file: a reading that throws gives the whole file as one form it cannot follow, known by its
 * text, so a file's failure takes nothing from the others. The texts that reached this were each fixed where they
 * threw (a malformed escape, a regular expression built from a long function name); no input is known to reach it now,
 * and that was said of both before they were found: this stands between the next such text and the others' refusals.
 * @param {string} text @param {"workflow" | "action"} kind @param {{ targeted?: boolean }} [opts]
 * @returns {Findings}
 */
function fileFindings(text, kind, opts) {
  try {
    return ciFindings(text, kind, opts);
  } catch (e) {
    return { uses: [], pwn: [], unpermitted: [], writeAll: [], unread: [{ n: 1, what: `a file this reading stopped on (${/** @type {Error} */ (e).message})`, text }], targeted: false, callees: [], loose: [], stopped: true };
  }
}

/**
 * The findings of a set of CI files read together: a pull_request_target workflow's local callees (reusable
 * workflows, local actions, and theirs, however deep) are read as reached by that trigger, and what they check
 * out counts in their own file, naming the caller. A callee the set does not hold, or whose reading stopped, is in
 * `missing`. Each hand-off (`pwn.to`) gets its `reach`: the files of the set its callee reaches, however deep.
 * @param {Map<string, string>} files path → text
 * @returns {{ findings: Map<string, Findings>, missing: { path: string, n: number, callee: string }[] }}
 */
export function ciSet(files) {
  /** @type {Map<string, Findings>} */
  const findings = new Map();
  for (const [path, text] of files) findings.set(path, fileFindings(text, ciKind(path)));
  /** @type {{ path: string, n: number, callee: string }[]} */
  const missing = [];
  const resolve = (/** @type {string} */ p) => calleeFiles(p).find((c) => files.has(c));
  // A local action that places another repository (a checkout by branch, a clone) does so in its caller's
  // workspace: the caller's later local actions in that job are that code too, however deep the calls go.
  /** @type {Map<Findings, Set<string>>} */
  const known = new Map([...findings.values()].map((f) => [f, new Set(f.loose.map((l) => `${l.job}\0${l.at}\0${l.dir}`))]));
  for (let changed = true, rounds = 0; changed && rounds <= files.size; rounds++) {
    changed = false;
    for (const f of findings.values()) {
      const seen = /** @type {Set<string>} */ (known.get(f));
      for (const u of f.uses) {
        if (!u.value.startsWith("./")) continue;
        const callee = resolve(localPath(u.value));
        for (const l of callee ? /** @type {Findings} */ (findings.get(callee)).loose : []) {
          const key = `${u.job}\0${u.at}\0${l.dir}`;
          if (seen.has(key)) continue;
          seen.add(key);
          f.loose.push({ job: u.job, n: u.n, at: u.at, dir: l.dir, from: l.from.includes(" (in ") ? l.from : `${l.from} (in ${callee})` });
          changed = true;
        }
      }
      if (!changed) continue;
      const placedUnder = placements(f.loose);
      for (const u of f.uses) {
        if (!u.pinned || !u.value.startsWith("./")) continue;
        const under = placedUnder(u.job, u.at, localPath(u.value));
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
        const reached = fileFindings(/** @type {string} */ (files.get(path)), ciKind(path), { targeted: true });
        const own = /** @type {Findings} */ (findings.get(path));
        if (reached.stopped) {
          missing.push({ path: c.from, n: c.n, callee: c.path });
          // A text's exit is not picked by the mode that reads it: stopped when reached is the form stopped alone is.
          if (!own.stopped) own.unread.push(reached.unread[0]), (own.stopped = true);
          continue;
        }
        const had = new Set(own.pwn.map((x) => x.what));
        for (const p of reached.pwn) {
          const what = `${p.what} (reached from ${caller})`;
          if (!had.has(what)) own.pwn.push({ ...p, what }), had.add(what);
        }
        for (const x of reached.callees) next.push({ from: path, ...x });
      }
      wave = next;
    }
  }
  // A hand-off's reach: the callee it names and every local callee read from there, as the files of the set; what
  // runs the code handed is any of them, so a commit that brings one makes the hand-off new (ciMessages).
  /** @type {Map<string, string[]>} */
  const reaches = new Map();
  const reachOf = (/** @type {string} */ to) => {
    const known = reaches.get(to);
    if (known) return known;
    /** @type {Set<string>} */
    const seen = new Set();
    for (let wave = [localPath(to)]; wave.length; ) {
      /** @type {string[]} */
      const next = [];
      for (const c of wave) {
        const path = resolve(c);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        for (const x of /** @type {Findings} */ (findings.get(path)).callees) next.push(x.path);
      }
      wave = next;
    }
    reaches.set(to, [...seen]);
    return [...seen];
  };
  for (const f of findings.values()) for (const p of f.pwn) if (p.to) p.reach = reachOf(p.to);
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
      for (const c of fileFindings(text, ciKind(path)).callees) for (const p of calleeFiles(c.path)) out.add(p);
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
 * Whether the commit brings what the index holds under a name: its bytes, its object or its kind differ from HEAD's.
 * @param {import("../core/git.mjs").StagedVersion} v
 */
export const brings = (v) => (v.staged && v.head ? !v.staged.equals(v.head) : v.oid === undefined || v.oid !== v.headOid || v.unread !== v.headUnread);

/**
 * The hook's errors and warnings for the CI files of a commit: one error per rule a file breaks, its first three
 * places, values shown escaped; a file the runner may read and the check cannot (not UTF-8 text, a symbolic link, past
 * 16 MB) is an error when the commit brings it, else a warning that it was not checked; a submodule, or a file git
 * cannot give, is that warning. `versions` (stagedVersions) holds every tracked CI file, so a caller's change reaches
 * its callees.
 * @param {Map<string, import("../core/git.mjs").StagedVersion>} versions
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
  /** What the check cannot read: refused when the commit brings it, as a form it cannot follow is; left a warning, a byte or a link would take a file out of the check. @param {string} path @param {import("../core/git.mjs").StagedVersion} v @param {string} reason */
  const unread = (path, v, reason) => {
    const refused = reason === "notText" || reason === "symlink" || reason === "large" ? brings(v) : false;
    (refused ? errors : warnings).push(t(refused ? "ci.unreadNew" : "ci.unread", { path: name(path), reason: t(`ci.reason.${reason}`, {}, lang) }, lang));
  };
  for (const [path, v] of versions) {
    if (v.unread) {
      unread(path, v, v.unread);
      continue;
    }
    // Deleted: HEAD has it and the index does not. In neither, the name git was asked for is not the name it holds.
    if (!v.staged && !v.head && !v.headUnread) {
      warnings.push(t("ci.unread", { path: name(path), reason: t("ci.reason.notFound", {}, lang) }, lang));
      continue;
    }
    const staged = v.staged ? ciText(v.staged) : null;
    if (v.staged && staged === null) unread(path, v, "notText");
    if (staged !== null) now.set(path, staged);
    // A HEAD version that cannot be read is no version (stagedVersions leaves it null): everything staged is new.
    const head = v.head ? ciText(v.head) : null;
    if (head !== null) before.set(path, head);
  }
  const a = ciSet(now);
  const b = ciSet(before);
  for (const [path, found] of a.findings) {
    const intro = ciIntroduced(found, b.findings.get(path) ?? null);
    // A hand-off HEAD holds is new when the commit brings a file of its callee's reach: that file makes it run the code.
    // Said apart, naming the files brought, since the line it points at is one the commit did not touch.
    const fresh = new Set(intro.pwn);
    const brought = (/** @type {string} */ r) => {
      const v = versions.get(r);
      return v !== undefined && brings(v);
    };
    const renewed = found.pwn.filter((p) => !fresh.has(p) && p.reach?.some(brought));
    const vars = { path: name(path) };
    if (intro.unpinned.length) errors.push(t("ci.unpinned", { ...vars, n: intro.unpinned.length, where: places(intro.unpinned, (u) => (u.from ? `${u.value} ← ${u.from}` : u.value)) }, lang));
    // A checkout, and a hand-off to a local callee, each with its own remedy.
    for (const [key, to] of /** @type {const} */ ([["ci.pwn", false], ["ci.pwnInput", true]])) {
      const list = intro.pwn.filter((p) => Boolean(p.to) === to);
      if (list.length) errors.push(t(key, { ...vars, where: places(list, (p) => p.what.slice(0, 120)) }, lang));
    }
    if (renewed.length) {
      const files = [...new Set(renewed.flatMap((p) => (p.reach ?? []).filter(brought)))];
      errors.push(t("ci.pwnReach", { ...vars, where: places(renewed, (p) => p.what.slice(0, 120)), files: files.slice(0, 3).map(name).join(", ") + (files.length > 3 ? t("shape.cochangeMore", { n: files.length - 3 }, lang) : "") }, lang));
    }
    if (intro.unpermitted.length) errors.push(t("ci.permissions", { ...vars, where: places(intro.unpermitted, (j) => j.job) }, lang));
    if (intro.writeAll.length) errors.push(t("ci.writeAll", { ...vars, where: places(intro.writeAll, (w) => w.where || t("ci.top", {}, lang)) }, lang));
    // A text HEAD holds brings no form, whichever mode's reading stopped on it.
    const forms = now.get(path) === before.get(path) ? [] : intro.unread;
    if (forms.length) errors.push(t("ci.forms", { ...vars, where: places(forms, (u) => u.what) }, lang));
    else if (found.stopped) warnings.push(t("ci.unread", { ...vars, reason: t("ci.reason.stopped", {}, lang) }, lang));
  }
  // Said whenever the set is read: a callee HEAD could not read either may hide what is added behind it.
  for (const m of a.missing) warnings.push(t("ci.calleeUnread", { path: name(m.path), n: m.n, callee: name(m.callee) }, lang));
  return { errors, warnings };
}
