/**
 * Private text in what a commit brings (`security.privateText`): commit-check refuses a commit whose added lines, the
 * names of the files it adds, or its message hold a word of the clone's private list, a home directory path, an
 * e-mail address `commits.addresses` does not hold, or text shaped like a conversation with the user; and, in the
 * graph file, a node `source` the commit adds that names the user outside the closed provenance form. A refusal names
 * the place and the rule with a length, never the text it matched: a terminal, a log or an agent's transcript would
 * publish it again.
 *
 * The list of private words lives in the state dir (`paths.stateDir`, under `.git/`: never tracked), one SHA-256
 * digest a line, written by `ennyn private-text add` from stdin. A digest of a short word is reversed by trying a list
 * of names, so a digest in a tracked file names what it hides to anyone with such a list; the state dir keeps the
 * list on the machines that hold it, and a clone without the file checks no word: a second clone, a CI runner or a
 * fresh machine gets its own list, by hand.
 * Words are matched as test/hygiene.test.mjs matches them (it imports literalHits): each word whole, in its parts
 * (`name.md`, `name-server`, `NAME_HOME`) and in its ASCII runs, exactly or in lower case.
 *
 * The conversation shapes and the address exemptions are measured: the history kept from before the rewrite, every
 * added line, file name and message of its 348 commits, against the full read's findings and the rewrite's tables
 * (docs/evidence.md has the counts). A paraphrase of what the user said fits no shape and passes: the prose rule
 * against it stays.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { readRegular } from "../core/files.mjs";
import { resolveStateDir, stateRoot } from "../core/git.mjs";
import { shown, t } from "../core/i18n.mjs";
import { commitRule } from "./commit-identity.mjs";
import { masked } from "./secrets.mjs";

/** @typedef {{ exact: Set<string>, folded: Set<string>, lengths?: Set<number> }} Literals digests; `lengths`: of the strings hashed, to hash only words of those lengths */
/** @typedef {{ literals: Literals | null, home: boolean, addresses: string[] | null, conversation: boolean }} TextRules */
/** @typedef {"literal" | "home" | "address" | "conversation"} Rule */
/** @typedef {{ rule: Rule, at: number, end: number, length: number, shape?: string }} Hit `at`..`end`: the span to cut when shown; `length`: of what matched */

/**
 * A word as hygiene reads it: letters and digits, joined by `.`, `_` or `-`; a combining mark stays in its word, so a
 * letter written decomposed (`s` and U+0327) is read with the rest and composed (NFC) before it is hashed.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]*/gu;

/** A home directory: /Users/<name> or /home/<name>, C:\Users\ with any number of backslashes (prose, a JS string, JSON in a string). */
export const HOME_PATH = /(?<![\w.-])(\/(?:Users|home)\/[^\s/\\"'`<>]+|[A-Za-z]:\\+Users\\+[^\s\\"']+)/gu;

/** @param {string} s */
export const digest = (s) => createHash("sha256").update(s).digest("hex");

/**
 * A word in the one case `folded` entries are kept in: NFC, the four Turkish i's (I, ı, İ, i) as `i`, then lower
 * case, an `i` with a combining dot above as `i` (what `toLowerCase` makes of `İ`). `toLowerCase` alone keeps `ı` apart
 * from `I` and turns `İ` into `i` and a combining dot. A word with its
 * diacritics dropped (`isivetrup` for `ışıvetrup`) is another word.
 * @param {string} s
 */
export const foldCase = (s) => s.normalize("NFC").replace(/[Iıİ]/g, "i").toLowerCase().replace(/i\u0307/g, "i");

/**
 * The listed words a text holds: each word whole, in its parts and in its ASCII runs (a Turkish suffix written
 * without its apostrophe), composed (NFC), compared as written with `exact` and folded (foldCase) with `folded`. One
 * hit a candidate.
 * @param {string} text @param {Literals} list
 * @returns {Hit[]}
 */
export function literalHits(text, list) {
  /** @type {Hit[]} */
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].replace(/[._-]+$/, "");
    /** Each candidate once, where it first stands in the word. @type {Map<string, number>} */
    const at = new Map([[word, 0]]);
    for (const p of word.matchAll(/[^._-]+/g)) {
      if (!at.has(p[0])) at.set(p[0], p.index);
      for (const r of p[0].matchAll(/[A-Za-z0-9]+/g)) if (!at.has(r[0])) at.set(r[0], p.index + r.index);
    }
    for (const [w, i] of at) {
      const nfc = w.normalize("NFC");
      const low = foldCase(w);
      if (list.lengths && !list.lengths.has(nfc.length) && !list.lengths.has(low.length)) continue;
      if (list.exact.has(digest(nfc)) || list.folded.has(digest(low))) out.push({ rule: "literal", at: m.index + i, end: m.index + i + w.length, length: w.length });
    }
  }
  return out;
}

/** @param {string} text @returns {Hit[]} */
export function homeHits(text) {
  return [...text.matchAll(HOME_PATH)].map((m) => ({ rule: /** @type {Rule} */ ("home"), at: m.index, end: m.index + m[0].length, length: m[0].length }));
}

/**
 * An e-mail address: a local part that starts the word (after a space, a mark, or an escape such as `\n` in a
 * quoted string: `\n@a.md` is no address), a domain whose last label is letters.
 */
const ADDRESS = /(?<=^|[^\w.%+\\-]|\\[nrt])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

/** The names RFC 2606 (sections 2, 3) and RFC 6761 (6.2-6.5) reserve for tests and examples, and every name below them. */
const RESERVED = /(?:^|\.)(?:test|example|invalid|localhost|example\.com|example\.net|example\.org)$/i;

/**
 * A domain that names no mail host: a last label that is a file's extension and no mail host's (`logo@2x.png`,
 * `icon@1.5x.webp`, `.md`, `.js`; `.md` is also a country's, and an address there is missed; a density on a mail host,
 * `<name>@2x.com`, is an address), or `openssh.com`, under which OpenSSH names its algorithms
 * (`chacha20-poly1305@openssh.com`, `sk-ssh-ed25519@openssh.com`: RFC 4251, section 6).
 */
const NOT_MAIL_HOST = /^(?:.*\.(?:png|jpe?g|gif|webp|svg|avif|heic|heif|jxl|ico|bmp|tiff?|md|mdx|js|mjs|cjs|ts|tsx|jsx|json|css|scss|html?|txt)$|openssh\.com$)/i;

/**
 * Whether an address match is no mailbox: a URL's user (`https://tok@host/`, `git+ssh://git@host/o/r`), a host
 * followed by a path (`git@host:o/r`, scp's form; `user:pw@host/o/r`), or a domain that names no mail host.
 * @param {string} text @param {number} at @param {number} end @param {string} domain
 */
const notMailbox = (text, at, end, domain) => NOT_MAIL_HOST.test(domain) || /:\/\/[^\s/@]*$/.test(text.slice(Math.max(0, at - 512), at)) || /^(?::[\w~./-]|\/)/.test(text.slice(end, end + 2));

/**
 * The addresses a text holds that `allowed` does not, folded as commits.addresses is (commitRule), past reserved
 * names and what is no mailbox.
 * @param {string} text @param {string[]} allowed in lower case, as commitRule gives them
 * @returns {Hit[]}
 */
export function addressHits(text, allowed) {
  /** @type {Hit[]} */
  const out = [];
  for (const m of text.matchAll(ADDRESS)) {
    const end = m.index + m[0].length;
    const domain = m[0].slice(m[0].indexOf("@") + 1);
    if (RESERVED.test(domain) || notMailbox(text, m.index, end, domain)) continue;
    if (allowed.includes(folded(m[0]))) continue;
    out.push({ rule: "address", at: m.index, end, length: m[0].length });
  }
  return out;
}

/** An address folded by commits.addresses' own rule, so the two never differ. @param {string} address */
const folded = (address) => /** @type {string[]} */ (/** @type {import("./commit-identity.mjs").Rule} */ (commitRule({ commits: { addresses: [address], signed: false } })).addresses)[0];

/** The closed provenance form a graph node names the user in (skills/cycle/report-formats.md, **An ask of the user**). */
const FORM = String.raw`(?:the )?user, \d{4}-\d{2}-\d{2}: (?:a request|approved|left to the session)`;

/** A mark that opens a quote: straight, curly, or a code span's. */
const OPENS = String.raw`["“‘'\x60]`;

/** A quote that opens words: the mark, then a letter or a digit. A quote then `,`, `}` or the end closes a string. */
const OPENING = String.raw`\s*${OPENS}[\w\u00C0-\uFFFF]`;

/**
 * Where the form ends, in a value and in a line: the end, `;`, a `.` before a space or the end, a clarification marker.
 * None with a quote right after it: a quote there is the user's words after the label (`…: a request; "<words>"`).
 * The rest of the text after an end is read as any text is: for the user named again and for every shape.
 */
const ENDS = String.raw`\s*$|\s*;(?!${OPENING})|\.(?:$|\s(?!${OPENING}))|\s+\[NEEDS CLARIFICATION:`;

/** The form in a value (a graph source, parsed). */
const CLOSED_VALUE = new RegExp(`${FORM}(?=${ENDS})`, "iy");

/**
 * The form in a value that opened a bracket before it (`(the user, <date>: a request)`): the bracket's close ends it too.
 * A quote after the close is the line reading's to refuse (closedSource reads the value's shapes as a line's).
 */
const CLOSED_BRACKETED = new RegExp(`${FORM}(?=${ENDS}|\\s*[)\\]])`, "iy");

/**
 * The form in a line of a file, where the value sits in its quotes or a code span: also a bracket's close, and a quote
 * or a code span closed right after the label (`",`, `` ` in the node``, `."`), each but with a quote opening after it.
 */
const CLOSED_LINE = new RegExp(`${FORM}(?=${ENDS}|\\s*[)\\]](?!${OPENING})|\\.?\\\\?["'\x60’”](?!${OPENING}))`, "iy");

/**
 * The user named in a source: `user` (`the user`, `user's`, `User`), never `users` or `user-…`. The name is an
 * attribution when it opens the closed form, or when what stands at it says who asked: a mark after it (`user:`,
 * `user,`, a bracketed date), a verb or noun of asking or deciding after it (`user asked`, `the user's call`,
 * `user request`), `by`, `from` or `per` before it (`requested by user`, `per the user`), or a date within the clause after it. None of these
 * holds for a role: a user in general (`a user`, `per user`, `each user`), the user as the object of a verb (`asks the
 * user:`, `waits for the user,`), or what the user has (`from the user's own machine`).
 */
const NAMED = /\buser(?:'s)?\b(?!-)/gi;
const MARKED = /^(?:'s)?\s*(?::|,|\(\s*\d{4}-\d{2}-\d{2})/;
const ASKING = /^(?:'s)?\s+(?:ask|asks|asked|request|requests|requested|want|wants|wanted|say|says|said|word|words|call|decision|decided|delegation|delegated|choice|chose|rule|left|prefers?|preferred|declined|approved|agreed|told|typed|messages?)\b/i;
const BY = /\b(?:by|from|per)\s+(?:the\s+)?$/i;
const DATED_AFTER = /^[^.;\n]{0,40}?\b\d{4}-\d{2}-\d{2}\b/;
const GENERIC = /\b(?:a|an|any|each|every|one|per|no|some)\s+$/i;
const OBJECT = /\b(?:asks?|asked|asking|prompts?|prompted|tells?|told|shows?|showed|gives?|gave|lets?|warns?|warned|notif(?:y|ies|ied)|for|to|with)\s+(?:the\s+)?$/i;

/**
 * Whether a graph source names the user as its provenance only in the closed form: every attribution (NAMED) opens
 * the form, and the source holds no conversation shape. A role is no provenance.
 * @param {string} text
 */
export function closedSource(text) {
  // A curly apostrophe is the straight one (`the user’s call`), one character for one.
  const source = text.replace(/\u2019/g, "'");
  for (const m of source.matchAll(NAMED)) {
    const before = source.slice(Math.max(0, m.index - 24), m.index);
    // The form opens with `the` or without it, so it is tried where `user` stands; a bracket before it may close it.
    const closed = /[([]\s*(?:the\s+)?$/i.test(before) ? CLOSED_BRACKETED : CLOSED_VALUE;
    closed.lastIndex = m.index;
    if (closed.test(source)) continue;
    if (GENERIC.test(before)) continue;
    const after = source.slice(m.index + 4);
    const owned = after.startsWith("'s");
    if ((MARKED.test(after) && !OBJECT.test(before)) || ASKING.test(after) || (BY.test(before) && !owned) || DATED_AFTER.test(after)) return false;
  }
  // A shape the attributions above leave (the user's messages counted). Each shape that opens with the user is one of them
  // first, so the line's ending of the form, read here, decides nothing the value's has not.
  return !conversationHits(source).length;
}

/** Where a clause starts: a line's start, after a mark that ends a sentence or opens a quote, a list marker. */
const CLAUSE = String.raw`(?<=^\s*(?:[-*>]\s+)?|[.;:!?]\s+|["'“‘(\[]|\s[—–]\s)`;

/**
 * Conversation shapes, each bound to a structure (docs/evidence.md counts them on the pre-rewrite history):
 * `dated`: the user and a date in one clause, in any order, outside the closed form; `act`: the user as a clause's subject with a
 * verb of asking, deciding or saying in the past; `word`: the user's word, ask or decision named as a step's reason; `messages`: the
 * user's messages counted or quoted; `speaker`: a line opened by a speaker's label.
 */
const SHAPES = /** @type {[string, RegExp][]} */ ([
  ["dated", /\b(?:the )?user, \d{4}-\d{2}-\d{2}\b|\bthe user(?:'s)?\b[^.;\n"]{0,40}?\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2},? the user\b/gi],
  ["act", new RegExp(`${CLAUSE}the user (?:asked|wanted|said|declined|delegated|left|chose|moved|typed|told|preferred|decided|requested|insisted|wants|prefers)\\b`, "gi")],
  ["word", /\b(?:on|by|at) the user's (?:word|ask|decision|request|delegation|rule)\b|\bthe user's delegation\b/gi],
  ["messages", /\b(?:messages?|words) the user (?:typed|sent|wrote)\b|\bthe user's \d+ messages\b/gi],
  ["speaker", /^\s*(?:[-*>]\s*)*(?:\*\*|__)?(?:User|Human|Assistant|AI)(?:\*\*|__)?\s*:\s+\S/g],
]);

/** @param {string} raw one line @returns {Hit[]} */
export function conversationHits(raw) {
  // A curly apostrophe is the straight one, one character for one: the spans stand.
  const text = raw.replace(/\u2019/g, "'");
  /** @type {Hit[]} */
  const out = [];
  for (const [shape, re] of SHAPES) {
    for (const m of text.matchAll(re)) {
      if (shape === "dated" && /^(?:the )?user/i.test(m[0])) {
        CLOSED_LINE.lastIndex = m.index;
        if (CLOSED_LINE.test(text)) continue;
      }
      out.push({ rule: "conversation", shape, at: m.index, end: m.index + m[0].length, length: m[0].length });
    }
  }
  return out;
}

/**
 * Every hit of the rules that are on in one line of text.
 * @param {string} line @param {TextRules} rules
 * @returns {Hit[]}
 */
export function lineHits(line, rules) {
  return [
    ...(rules.literals ? literalHits(line, rules.literals) : []),
    ...(rules.home ? homeHits(line) : []),
    ...(rules.addresses ? addressHits(line, rules.addresses) : []),
    ...(rules.conversation ? conversationHits(line) : []),
  ];
}

/**
 * The rules a commit is held to: the config's switches, the list of words (null: none read), and the allowed addresses
 * from commits.addresses, read through commitRule; with that list unset the address rule does not run, since every
 * address would be outside it.
 * @param {any} config @param {Literals | null} literals
 * @returns {TextRules}
 */
export function textRules(config, literals) {
  const p = config.security.privateText;
  return {
    literals: literals && (literals.exact.size || literals.folded.size) ? literals : null,
    home: p.home,
    addresses: (p.addresses && commitRule(config)?.addresses) || null,
    conversation: p.conversation,
  };
}

/** Whether any rule on a text is on. @param {TextRules} rules */
export const anyTextRule = (rules) => Boolean(rules.literals || rules.home || rules.addresses || rules.conversation);

/** The file of the list in the state dir. */
export const LITERALS_FILE = "private-literals";

/**
 * A line of the list: `exact` or `folded`, the length of the string hashed, its SHA-256. The length may be left out
 * (a digest from elsewhere, as those taken over from the hygiene test): then every word is hashed.
 */
const ENTRY = /^(exact|folded) (?:(\d{1,4}) )?([0-9a-f]{64})$/;

/**
 * The list from the file's text. A line that is no entry throws, naming its number: a list read in part is no list.
 * `#` lines and blank lines are passed over.
 * @param {string} text
 * @returns {Literals}
 */
export function parseLiterals(text) {
  /** @type {Literals} */
  const list = { exact: new Set(), folded: new Set(), lengths: new Set() };
  let everyLength = true;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) return;
    const m = ENTRY.exec(line);
    if (!m) throw new Error(`line ${i + 1} is not "exact|folded <length> <sha256>"`);
    (m[1] === "exact" ? list.exact : list.folded).add(m[3]);
    if (m[2] === undefined) everyLength = false;
    else /** @type {Set<number>} */ (list.lengths).add(Number(m[2]));
  });
  if (!everyLength) delete list.lengths;
  return list;
}

/** The list's file: in the state dir, which the main checkout and its worktrees share. @param {string} cwd @param {any} config */
export const literalsPath = (cwd, config) => join(resolveStateDir(cwd, config.paths.stateDir), LITERALS_FILE);

/**
 * The clone's list, null when it has none. A file that is there and cannot be read, or holds a line that is no
 * entry, throws: unread is never an empty list.
 * @param {string} cwd @param {any} config
 * @returns {Literals | null}
 */
export function readLiterals(cwd, config) {
  const path = literalsPath(cwd, config);
  const bytes = readRegular(stateRoot(cwd, path), path);
  return bytes === null ? null : parseLiterals(bytes.toString("utf8"));
}

/**
 * The entry for a word: one word as the matcher reads it (no space, no mark at its ends), else null. `folded`
 * holds it in any case.
 * @param {string} word @param {boolean} fold
 */
export function literalEntry(word, fold) {
  const w = word.trim().normalize("NFC");
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}._-]*[\p{L}\p{M}\p{N}])?$/u.test(w)) return null;
  const s = fold ? foldCase(w) : w.normalize("NFC");
  return `${fold ? "folded" : "exact"} ${s.length} ${digest(s)}`;
}

/**
 * JSON.parse with an error that quotes nothing of the text: V8's message shows the characters around the fault, which
 * may hold a private word. The line and column only, when the parser gives a position.
 * @param {string} text
 */
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const at = /\bposition (\d+)/.exec(String(/** @type {Error} */ (e).message));
    if (!at) throw new SyntaxError("it does not parse");
    const before = text.slice(0, Number(at[1])).split("\n");
    throw new SyntaxError(`it does not parse at line ${before.length}, column ${before[before.length - 1].length + 1}`);
  }
}

/** The graph's sources, in its open, done and declined lists. @param {string} text @param {any} config */
function sourcesOf(text, config) {
  const { exports: lists, fields } = config.graph;
  const data = parsed(text.replace(/^\uFEFF/, ""));
  /** @type {string[]} */
  const out = [];
  for (const name of [lists.open, lists.done, lists.declined]) {
    const list = data?.[name];
    if (!Array.isArray(list)) continue;
    for (const node of list) if (typeof node?.[fields.source] === "string") out.push(node[fields.source]);
  }
  return out;
}

/**
 * The sources a commit adds to the graph that name the user outside the closed form, each with the line its text
 * is on in the staged file (0 when it is not found as written there). Only a source HEAD's graph does not hold is
 * judged: an old node is not the commit's to fix. A staged graph that is no JSON throws (the commit's own content);
 * a HEAD graph that is none holds no source.
 * @param {string} staged @param {string | null} head @param {any} config
 * @returns {{ line: number, length: number }[]}
 */
export function sourceHits(staged, head, config) {
  /** @type {Set<string>} */
  let before = new Set();
  try {
    if (head !== null) before = new Set(sourcesOf(head, config));
  } catch {
    // HEAD's graph unread as JSON: every staged source is judged.
  }
  const lines = staged.split("\n");
  return [...new Set(sourcesOf(staged, config))]
    .filter((s) => !before.has(s) && !closedSource(s))
    .map((s) => {
      const at = lines.findIndex((l) => l.includes(JSON.stringify(s)));
      return { line: at + 1, length: s.length };
    });
}

/** A line as a move leaves it: the indent and a list's trailing comma are the place's, not the line's. @param {string} line */
const moved = (line) => line.trim().replace(/,$/, "");

/**
 * The added lines HEAD's version of their file does not already hold, wherever the commit moves them: a node moved from
 * one list of the graph to another, or a line that gains a trailing comma, is no new text, and not the commit's to fix.
 * A path with no HEAD version (`heads` without it, or null) keeps every line.
 * @param {Map<string, import("../core/git.mjs").AddedLine[]>} added @param {Map<string, string | null>} heads
 */
export function newLines(added, heads) {
  /** @type {Map<string, import("../core/git.mjs").AddedLine[]>} */
  const out = new Map();
  for (const [path, lines] of added) {
    const head = heads.get(path);
    const held = head ? new Set(head.split("\n").map(moved)) : null;
    out.set(path, held ? lines.filter((l) => !held.has(moved(l.text))) : lines);
  }
  return out;
}

/** A name as the gate's lines show it: every span a rule matches cut. @param {string} path @param {TextRules} rules */
export const privateShown = (path, rules) => cutShown(path, lineHits(path, rules));

/** A text with every span cut, shown as a name: what a hit matched is never printed. @param {string} text @param {Hit[]} hits */
const cutShown = (text, hits) => {
  let out = text;
  for (const h of [...hits].sort((a, b) => b.at - a.at)) out = `${out.slice(0, h.at)}…${out.slice(h.end)}`;
  return shown(masked(out), { name: true }).text;
};

/** The words for a place's hits: each rule once, with the lengths it matched. @param {Hit[]} hits @param {string} lang */
const ruleWords = (hits, lang) => {
  /** @type {Map<string, number[]>} */
  const by = new Map();
  for (const h of hits) {
    const key = h.rule === "conversation" ? `conversation.${h.shape}` : h.rule;
    by.set(key, [...(by.get(key) ?? []), h.length]);
  }
  return [...by].map(([key, n]) => t(`shape.privateRule.${key}`, { n: n.join(", ") }, lang)).join("; ");
};

/** At most this many places are named, one line each; the rest are counted. */
const PLACES = 10;

/**
 * The private text a commit brings: a line for each place (up to PLACES, the rest counted), with its rules and
 * lengths, then the remedy once. A place a line apart, so a read that fails costs its own places and leaves every other
 * line as it was. `lines`: the added lines, per staged path; `names`: the names of the files the commit adds;
 * `message`: the message as git will store it (storedMessage); `graph`: its path and its sources' hits.
 * @param {{ rules: TextRules, lang: string, lines?: Map<string, import("../core/git.mjs").AddedLine[]>, names?: string[], message?: string, graph?: { path: string, hits: { line: number, length: number }[] } }} opts
 * @returns {string[]}
 */
export function privateErrors({ rules, lang, lines = new Map(), names = [], message, graph }) {
  /** @type {string[]} */
  const places = [];
  const pathOf = (/** @type {string} */ p) => privateShown(p, rules);
  for (const [path, added] of lines) {
    for (const l of added) {
      const hits = lineHits(l.text, rules);
      if (hits.length) places.push(`${pathOf(path)}:${l.line} (${ruleWords(hits, lang)})`);
    }
  }
  for (const name of names) {
    const hits = lineHits(name, rules);
    if (hits.length) places.push(t("shape.privateName", { path: cutShown(name, hits), rules: ruleWords(hits, lang) }, lang));
  }
  if (message !== undefined) {
    message.split("\n").forEach((l, i) => {
      const hits = lineHits(l, rules);
      if (hits.length) places.push(t("shape.privateMessage", { line: i + 1, rules: ruleWords(hits, lang) }, lang));
    });
  }
  for (const h of graph?.hits ?? []) places.push(`${pathOf(/** @type {{ path: string }} */ (graph).path)}${h.line ? `:${h.line}` : ""} (${t("shape.privateRule.provenance", { n: h.length }, lang)})`);
  if (!places.length) return [];
  return [
    ...places.slice(0, PLACES).map((where) => t("shape.private", { where }, lang)),
    ...(places.length > PLACES ? [t("shape.privateMore", { n: places.length - PLACES }, lang)] : []),
    t("shape.privateRemedy", {}, lang),
  ];
}
