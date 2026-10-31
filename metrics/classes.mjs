/**
 * The defect class registry (`paths.classes`, default .ennyn/classes.json): each class the project has named, with
 * a stable id, one sentence, a state, and the gates that act on it. `new: <name>` is how a class is born in a
 * finding; at a cycle's close it joins the registry or is linked to an entry (`linked`, since the ledger is only
 * appended to). The reader and the validator live here: doctor and `ennyn classes` read through this module, as
 * the findings ledger will.
 *
 * A `new:` name resolves to an entry when it folds to that entry's id (foldName) or stands in its `linked` list, and
 * it is never refused for that: a row's validity does not change with what a later close adds, and rows are not
 * rewritten. A look-alike in another script does not fold, and stays a plain new name; a one-word id takes any row that
 * names that word, which is accepted: no harm was measured.
 *
 * What is checked. The shape, as the config does it: unknown keys and values are refused with reasons, all at once. A
 * key written twice keeps its last value, as the config's does. Each state takes what DESIGN.md defines: `partial` and
 * `sensor-only` a gate above a written rule; `closed-gate` a gate of the action `past-defects` or stronger; `closed-design`
 * one of `remove-the-place`; a closing gate that removed nothing on a file that is no Markdown document. The level is the
 * place in ACTIONS; that the line falls there is the research's inference. A gate's file is a path from the repository's
 * top, and not the registry. Every gate's commit must be in HEAD's history.
 *
 * Those four states claim a gate, so each needs one standing: a row at that rung whose file is a file at HEAD or, for a
 * `remove-the-place` row, a file that existed at its commit or that commit's parent. Every other row is history: its
 * commit is checked, its file is not read. A count's source must be a tracked .json or .jsonl file, not the registry.
 *
 * That is all. `action` is a person's word: the extension check is a sanity check, and a rule in a file of any other
 * name passes it. Left to a person: whether the sentence is at class level, whether `action` tells the truth, whether
 * the gate covers the class, and whether the class stopped. A closed state says the file exists, not that it works.
 * `nodes` is checked for shape only.
 *
 * The file is data: nothing reads a sentence into a prompt as an instruction. A sentence, a proof or a judgement is
 * one plain line: doctor prints none of them, `ennyn classes` prints a sentence through `shown`, and a problem quotes
 * no such text at all, and any other value by its kind or cut short: no string conversion runs on a value of unknown
 * type. A file that does not parse gets Node's own message, which can show a few characters around the fault; every
 * line goes through tShown or `shown`.
 *
 * A count needs a source that can be recounted: a data file the repository tracks. A judgement is no count.
 */

import { isUtf8 } from "node:buffer";
import { resolve } from "node:path";
import { DEFAULTS } from "../core/config.mjs";
import { readRegular } from "../core/files.mjs";
import { batchCheck, git, gitBytes, gitMaybe, headCommit, HOOK_READ_ENV } from "../core/git.mjs";
import { UNSHOWN } from "../core/i18n.mjs";

export const CLASS_STATES = ["open", "partial", "closed-design", "closed-gate", "sensor-only", "superseded"];
/** What was done about a class, weakest first; the place in this list is the level the closing rule reads. */
export const ACTIONS = ["written-rule", "advice", "red-green", "past-defects", "real-program", "ban-list", "remove-the-place"];
/** The action that removed the place: a `closed-design` needs it, its file may be gone, and that file may be a document. */
const REMOVED = "remove-the-place";
/** The weakest action that can close a class. */
const CLOSING = ACTIONS.indexOf("past-defects");
/** States that say a gate stands, so they need one above a written rule. */
const GATED = ["partial", "sensor-only"];
/** The largest registry read: past it the file is refused. */
export const CLASSES_LIMIT = 1024 * 1024;
/** The longest sentence, proof or judgement. */
export const TEXT_MAX = 300;
/** The longest name after `new: `. */
export const NAME_MAX = 120;
/** The most classes one finding names: past it the row is refused before its values are read. */
export const CLASS_LIST_MAX = 20;
/** The most problems `ennyn classes` prints; the rest are counted. */
export const PROBLEMS_SHOWN = 50;
const ID_MAX = 64;
/** How much of a value a problem quotes. */
const QUOTED_MAX = 60;
const NEW = "new: ";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CYCLE = /^[1-9][0-9]*$/;
/** A Markdown document: a sanity check that refuses a closing by a gate that removed nothing, no more. The `action` label is a person's word. */
const DOCUMENT = /\.(?:md|mdx|markdown)$/i;
/** A file that holds data a script can recount. */
const DATA = /\.jsonl?$/i;
/** A line `cat-file --batch-check` writes for a blob. */
const BLOB = /^[0-9a-f]+ blob \d+$/;

const ENTRY_KEYS = ["id", "says", "state", "gates", "by", "nodes", "linked", "counts", "judged"];
const GATE_KEYS = ["commit", "file", "action", "proof"];

/**
 * @typedef {{ commit: string, file: string, action: string, proof: string }} ClassGate
 * @typedef {{ source: string, cycles: Record<string, number> }} ClassCounts
 * @typedef {{ id: string, says: string, state: string, gates?: ClassGate[], by?: string, nodes?: string[], linked?: string[], counts?: ClassCounts, judged?: string }} ClassEntry
 * @typedef {{ entries: ClassEntry[], byId: Map<string, ClassEntry>, byName: Map<string, string>, size: number, problems: string[] }} Registry
 *   `entries` holds what passed its checks, `size` counts every entry of the file, `byName` a linked `new:` value's id.
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * A value in a problem, by its type: text quoted and cut, a number or a truth value as it is, anything else by its
 * kind. No string conversion runs on it: an object from a file can hold a toString that is no function, and a list
 * nested deep enough overflows the stack.
 * @param {unknown} v
 */
export function quoted(v) {
  if (typeof v === "string") return JSON.stringify(v.slice(0, QUOTED_MAX));
  if (typeof v === "number" || typeof v === "boolean" || v === null) return JSON.stringify(v);
  return Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : "nothing";
}
/** One plain line. @param {unknown} v @param {number} [max] @returns {v is string} */
export const plain = (v, max = TEXT_MAX) => typeof v === "string" && v.length <= max && v.trim() !== "" && !UNSHOWN.test(v);
/** @param {unknown} v @returns {v is string} */
export const isId = (v) => typeof v === "string" && v.length <= ID_MAX && ID.test(v);
/** The name of a `new:` value, or null. @param {unknown} v */
function newName(v) {
  if (typeof v !== "string" || !v.startsWith(NEW)) return null;
  const name = v.slice(NEW.length);
  return plain(name, NAME_MAX) && name === name.trim() ? name : null;
}
/**
 * What a name reads as beside the ids: NFKC, lower case, each run of spaces and underscores one dash.
 * @param {string} name
 */
export const foldName = (name) => name.normalize("NFKC").toLowerCase().replace(/[ _]+/g, "-");
/**
 * A path as a tree holds it, from the repository's top: nothing absolute, no empty, `.` or `..` part. Asked of a
 * commit, git reads `./x` from the working directory, and `../x` ends the call for every row after it.
 * @param {unknown} v
 */
const isTopPath = (v) => plain(v) && !/^~|^[A-Za-z]:/.test(v) && !v.split(/[\\/]/).some((part) => ["", ".", ".."].includes(part));
/** Whether a row is a gate at all: an action above a written rule. @param {unknown} g */
const isGate = (g) => isObject(g) && ACTIONS.indexOf(/** @type {string} */ (g.action)) > 0;
/**
 * Whether a gate can close a class in `state`: a strong enough action, on a file that is no document unless the action
 * removed it.
 * @param {string} state @returns {(g: unknown) => boolean}
 */
const closes = (state) => (g) => isObject(g) && (state === "closed-design" ? g.action === REMOVED : ACTIONS.indexOf(/** @type {string} */ (g.action)) >= CLOSING) && typeof g.file === "string" && (g.action === REMOVED || !DOCUMENT.test(g.file));
/** @param {string} state */
const isClosed = (state) => state === "closed-design" || state === "closed-gate";
/** Whether a state claims a gate stands. @param {string} state */
const claimsGate = (state) => GATED.includes(state) || isClosed(state);

/** @param {Record<string, unknown>} obj @param {string[]} keys @param {string} at @param {string[]} problems */
function unknownKeys(obj, keys, at, problems) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) problems.push(`${at}: unknown key ${quoted(k)}`);
}

/** @param {unknown} raw @param {string} at @param {string} registry the registry's own path @param {string[]} problems */
function gateProblems(raw, at, registry, problems) {
  if (!isObject(raw)) return problems.push(`${at} must be an object { commit, file, action, proof }`);
  unknownKeys(raw, GATE_KEYS, at, problems);
  if (typeof raw.commit !== "string" || !HASH.test(raw.commit)) problems.push(`${at}.commit must be a full commit hash`);
  if (!isTopPath(raw.file)) problems.push(`${at}.file must be a path from the repository's top, on one line`);
  else if (raw.file === registry) problems.push(`${at}.file must not be the registry: it cannot be its own gate`);
  if (!ACTIONS.includes(/** @type {string} */ (raw.action))) problems.push(`${at}.action must be one of ${ACTIONS.join(", ")}`);
  if (!plain(raw.proof)) problems.push(`${at}.proof must be one plain line of at most ${TEXT_MAX} characters`);
}

/** @param {unknown} raw @param {string} at @param {string} registry the registry's own path @param {string[]} problems */
function countProblems(raw, at, registry, problems) {
  if (!isObject(raw)) return problems.push(`${at} must be an object { source, cycles }`);
  unknownKeys(raw, ["source", "cycles"], at, problems);
  if (!plain(raw.source) || !DATA.test(raw.source) || raw.source === registry) problems.push(`${at}.source must be a .json or .jsonl file the repository tracks, other than the registry: a count has to be one a script can recount`);
  if (!isObject(raw.cycles)) return problems.push(`${at}.cycles must be an object of cycle and count`);
  for (const [cycle, n] of Object.entries(raw.cycles)) {
    if (!CYCLE.test(cycle)) problems.push(`${at}.cycles: ${quoted(cycle)} is no cycle`);
    else if (!Number.isSafeInteger(n) || /** @type {number} */ (n) < 0) problems.push(`${at}.cycles[${quoted(cycle)}] must be a whole number, 0 or more`);
  }
}

/**
 * What is wrong with one entry on its own, ids and names of other entries aside.
 * @param {Record<string, unknown>} raw @param {string} at @param {string} registry the registry's own path @param {string[]} problems
 */
function entryProblems(raw, at, registry, problems) {
  unknownKeys(raw, ENTRY_KEYS, at, problems);
  if (!isId(raw.id)) problems.push(`${at}.id must be lower-case words and digits parted by single dashes, at most ${ID_MAX} characters`);
  if (!plain(raw.says)) problems.push(`${at}.says must be one plain line of at most ${TEXT_MAX} characters`);
  if (!CLASS_STATES.includes(/** @type {string} */ (raw.state))) problems.push(`${at}.state must be one of ${CLASS_STATES.join(", ")}, got ${quoted(raw.state)}`);
  // An absent list is an empty one; null is no list.
  const gates = raw.gates === undefined ? [] : raw.gates;
  if (!Array.isArray(gates)) problems.push(`${at}.gates must be a list`);
  else {
    gates.forEach((g, i) => gateProblems(g, `${at}.gates[${i}]`, registry, problems));
    const state = /** @type {string} */ (raw.state);
    if (isClosed(state) && !gates.some(closes(state))) problems.push(`${at} cannot be closed: ${state} needs a gate of the action ${state === "closed-design" ? REMOVED : `${ACTIONS[CLOSING]} or stronger, on a file that is no document unless the action removed it`}`);
    if (GATED.includes(state) && !gates.some(isGate)) problems.push(`${at}: state ${state} needs a gate above a written rule`);
  }
  if (raw.state === "superseded" && !isId(raw.by)) problems.push(`${at}.by must name the entry that takes its place`);
  if (raw.state !== "superseded" && raw.by !== undefined) problems.push(`${at}.by belongs only to a superseded entry`);
  const nodes = raw.nodes === undefined ? [] : raw.nodes;
  if (!Array.isArray(nodes) || !nodes.every((n) => plain(n) && !/\s/.test(n))) problems.push(`${at}.nodes must be a list of graph node ids`);
  const linked = raw.linked === undefined ? [] : raw.linked;
  if (!Array.isArray(linked)) problems.push(`${at}.linked must be a list of new: names`);
  else linked.forEach((v, i) => newName(v) === null && problems.push(`${at}.linked[${i}] must be a new: name on one plain line`));
  if (raw.counts !== undefined) countProblems(raw.counts, `${at}.counts`, registry, problems);
  if (raw.judged !== undefined && !plain(raw.judged)) problems.push(`${at}.judged must be one plain line of at most ${TEXT_MAX} characters`);
}

/**
 * Superseded entries point at an entry that exists, and each chain ends: one pass, each entry walked once.
 * @param {{ entry: ClassEntry, at: string }[]} rows @param {Map<string, ClassEntry>} byId @param {string[]} problems
 */
function chainProblems(rows, byId, problems) {
  /** @type {Set<string>} */
  const walked = new Set();
  for (const { entry, at } of rows) {
    if (entry.state !== "superseded") continue;
    if (!byId.has(/** @type {string} */ (entry.by))) problems.push(`${at}.by: no entry ${quoted(entry.by)}`);
    /** @type {Set<string>} */
    const here = new Set();
    /** @type {ClassEntry | undefined} */
    let on = entry;
    while (on?.state === "superseded" && !walked.has(on.id) && !here.has(on.id)) {
      here.add(on.id);
      on = byId.get(/** @type {string} */ (on.by));
    }
    if (on && here.has(on.id)) problems.push(`${at}: superseded entries lead in a circle at ${quoted(on.id)}`);
    for (const id of here) walked.add(id);
  }
}

/** A registry with nothing in it: what a project with no file has. @returns {Registry} */
export function emptyRegistry() {
  return { entries: [], byId: new Map(), byName: new Map(), size: 0, problems: [] };
}

/**
 * Reads a registry's text. Every problem is said; an entry that holds one stays out of the index, so no reader
 * takes its id or its state for good.
 * @param {string} text
 * @param {{ path?: string }} [opts] `path`: the registry's own path, which no count may name
 * @returns {Registry}
 */
export function parseClasses(text, { path = DEFAULTS.paths.classes } = {}) {
  const reg = emptyRegistry();
  const { problems } = reg;
  /** @type {unknown} */
  let data;
  try {
    // A byte order mark some editors write is no part of the JSON.
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    problems.push(`the file does not parse: ${/** @type {Error} */ (e).message}`);
    return reg;
  }
  if (!isObject(data)) return problems.push("the file must hold a JSON object { about?, classes }"), reg;
  unknownKeys(data, ["about", "classes"], "the file", problems);
  if (data.about !== undefined && typeof data.about !== "string") problems.push(`"about" must be text`);
  if (!Array.isArray(data.classes)) return problems.push(`"classes" must be a list`), reg;
  reg.size = data.classes.length;
  /** @type {{ entry: ClassEntry, at: string }[]} */
  const rows = [];
  /** @type {Set<unknown>} */
  const ids = new Set();
  data.classes.forEach((raw, i) => {
    const at = `classes[${i}]`;
    if (!isObject(raw)) return problems.push(`${at} must be an object`);
    /** @type {string[]} */
    const own = [];
    entryProblems(raw, at, path, own);
    problems.push(...own);
    if (isId(raw.id) && ids.has(raw.id)) problems.push(`${at}: id ${quoted(raw.id)} is there twice`);
    else if (!own.length) {
      const entry = /** @type {ClassEntry} */ (/** @type {unknown} */ (raw));
      reg.byId.set(entry.id, entry);
      reg.entries.push(entry);
      rows.push({ entry, at });
    }
    ids.add(raw.id);
  });
  chainProblems(rows, reg.byId, problems);
  for (const { entry, at } of rows) {
    for (const [i, value] of (entry.linked ?? []).entries()) {
      const owner = reg.byId.get(foldName(/** @type {string} */ (newName(value))));
      // It would count under two classes: where the id it folds to ends, and where this entry ends. One end does no harm.
      if (owner && currentClass(reg, owner.id) !== currentClass(reg, entry.id)) problems.push(`${at}.linked[${i}]: ${quoted(value)} folds to another entry's id, ${quoted(owner.id)}`);
      else if (reg.byName.has(value)) problems.push(`${at}.linked[${i}]: ${quoted(value)} is linked twice`);
      else reg.byName.set(value, entry.id);
    }
  }
  return reg;
}

/**
 * The project's registry. Nothing there is no registry yet, which is no problem. A file that is there but cannot be
 * read, or is refused (a link, a directory, past CLASSES_LIMIT), throws, naming it (core/files.mjs readRegular). Bytes
 * that are not UTF-8 are a problem: decoded, they would read as text no one wrote.
 * @param {{ cwd: string, config: { paths: { classes: string } } }} opts
 * @returns {Registry & { path: string, there: boolean }}
 */
export function loadClasses({ cwd, config }) {
  const path = config.paths.classes;
  const bytes = readRegular(cwd, resolve(cwd, path), { limit: CLASSES_LIMIT });
  if (bytes === null) return { path, there: false, ...emptyRegistry() };
  if (!isUtf8(bytes)) return { path, there: true, ...emptyRegistry(), problems: ["the file is not valid UTF-8"] };
  return { path, there: true, ...parseClasses(bytes.toString("utf8"), { path }) };
}

/** Whether a class id is in the registry. @param {Registry} reg @param {unknown} id */
export const isKnown = (reg, id) => reg.byId.has(/** @type {string} */ (id));

/** What a class says, as data; null for an id the registry does not hold. @param {Registry} reg @param {unknown} id */
export const saysOf = (reg, id) => reg.byId.get(/** @type {string} */ (id))?.says ?? null;

/**
 * What is wrong with a class value of a finding, or null when it is valid: a known id, a superseded one too (a
 * ledger is only appended to), or `new: <name>`, whatever that name resolves to: what a later close adds never
 * refuses a row.
 * @param {Registry} reg @param {unknown} value
 * @returns {string | null}
 */
export function valueProblem(reg, value) {
  if (typeof value !== "string") return `a class must be text, not ${quoted(value)}`;
  if (reg.byId.has(value)) return null;
  if (!value.startsWith(NEW)) return `unknown class ${quoted(value)}: a class is an id of the registry, or new: <name>`;
  return newName(value) === null ? `${quoted(value)}: a new: name is one plain line of at most ${NAME_MAX} characters, no space at either end` : null;
}

/**
 * What is wrong with a finding's classes: one or more, at most CLASS_LIST_MAX, each valid, each once. Once means the
 * value as written: two values that lead to one entry stay valid, as a later link must not refuse a row.
 * @param {Registry} reg @param {unknown} list
 * @returns {string[]}
 */
export function classProblems(reg, list) {
  if (!Array.isArray(list)) return ["a finding's class must be a list"];
  if (!list.length) return ["a finding needs at least one class"];
  if (list.length > CLASS_LIST_MAX) return [`a finding names at most ${CLASS_LIST_MAX} classes`];
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  const twice = new Set();
  for (const v of list) {
    const problem = valueProblem(reg, v);
    if (problem !== null) problems.push(problem);
    if (seen.has(v)) twice.add(v);
    seen.add(v);
  }
  return [...problems, ...[...twice].map((v) => `${quoted(v)} is there twice`)];
}

/**
 * The entry a value names, before any `by`: an id, a name in a `linked` list, or a name that folds to an id.
 * @param {Registry} reg @param {unknown} value
 * @returns {ClassEntry | undefined}
 */
function entryOf(reg, value) {
  if (typeof value !== "string") return undefined;
  const id = reg.byName.get(value);
  if (id !== undefined) return reg.byId.get(id);
  const name = newName(value);
  return reg.byId.get(name === null ? value : foldName(name));
}

/**
 * The id of the live class a value counts under: a resolved `new:` name leads to its entry, a superseded entry to
 * the one that took its place. null for a value that leads to none: unknown, not resolved yet, or a circle.
 * @param {Registry} reg @param {unknown} value
 * @returns {string | null}
 */
export function currentClass(reg, value) {
  let on = entryOf(reg, value);
  /** @type {Set<string>} */
  const seen = new Set();
  while (on?.state === "superseded") {
    if (seen.has(on.id)) return null;
    seen.add(on.id);
    on = reg.byId.get(/** @type {string} */ (on.by));
  }
  return on?.id ?? null;
}

/** Entries by state, in the order of CLASS_STATES, the states with none left out. @param {Registry} reg @returns {[string, number][]} */
export function stateCounts(reg) {
  const n = (/** @type {string} */ s) => reg.entries.filter((e) => e.state === s).length;
  return CLASS_STATES.map((s) => /** @type {[string, number]} */ ([s, n(s)])).filter(([, count]) => count > 0);
}

/**
 * The files HEAD's tree holds as regular files, by their full path from the repository's top, bytes as they are.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @returns {Set<string>}
 */
function trackedFiles(cwd, env) {
  const out = gitBytes(["-c", "core.precomposeUnicode=false", "ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd, env, walk: true }).toString("utf8");
  /** @type {Set<string>} */
  const files = new Set();
  for (const line of out.split("\0")) {
    const m = /^100\d{3} blob [0-9a-f]+\t(.*)$/s.exec(line);
    if (m) files.add(m[1]);
  }
  return files;
}

/**
 * Whether `path` was a file at `commit` or at its parent, as a removal claims. null when this clone may not hold the
 * answer: at a shallow boundary a commit shows no parent, and a partial clone says `missing` of a file it lacks as of
 * one that never was (git 2.56, blob:none and tree:0), so there only a file found is an answer.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @param {string} commit @param {string} path @param {boolean} shallow
 * @returns {boolean | null}
 */
function existedAt(cwd, env, commit, path, shallow) {
  if (batchCheck(cwd, [`${commit}:${path}`, `${commit}^:${path}`], { env }).some((line) => BLOB.test(line))) return true;
  return shallow || gitMaybe(["config", "--get-regexp", "^remote\\..*\\.promisor$"], { cwd, env, absent: [1] }) !== null ? null : false;
}

/** What git said of a call that failed, on one line. @param {unknown} e */
function gitSaid(e) {
  const err = /** @type {Error & { stderr?: unknown }} */ (e);
  return String(err.stderr || err.message).trim().split("\n")[0];
}

/**
 * What a script can check of a registry: every gate's commit is in HEAD's history, every count's source a file tracked
 * at HEAD, and each entry whose state claims a gate has one standing (see the top of this file). It reads git only when
 * there is something to check; what git cannot answer (no commit, a call that failed, a commit past a shallow boundary,
 * a removal this clone may not hold) is `unmeasured`, never no problem. Objects as HOOK_READ_ENV reads them: nothing is
 * fetched. One call lists the history and one the tree, however many rows; a removal costs one `cat-file` of its own,
 * and only when no row git need not be asked about stands.
 * @param {Registry} reg @param {{ cwd: string }} opts
 * @returns {{ problems: string[], unmeasured: string | null }}
 */
export function checkProofs(reg, { cwd }) {
  const entries = reg.entries.filter((e) => e.gates?.length || e.counts);
  if (!entries.length) return { problems: [], unmeasured: null };
  const env = { ...process.env, ...HOOK_READ_ENV };
  /** @type {boolean} */
  let shallow;
  /** @type {Set<string>} */
  let history;
  /** @type {Set<string>} */
  let tracked;
  try {
    if (!headCommit(cwd)) return { problems: [], unmeasured: "no commit to check them against" };
    shallow = git(["rev-parse", "--is-shallow-repository"], { cwd, env }) === "true";
    history = new Set(git(["rev-list", "HEAD"], { cwd, env, walk: true }).split("\n"));
    tracked = trackedFiles(cwd, env);
  } catch (e) {
    return { problems: [], unmeasured: gitSaid(e) };
  }
  /** @type {string[]} */
  const problems = [];
  let past = 0;
  let thin = 0;
  for (const e of entries) {
    for (const [i, g] of (e.gates ?? []).entries()) {
      if (history.has(g.commit)) {
        // In the history: nothing to say.
      } else if (shallow) past++;
      else problems.push(`${quoted(e.id)}.gates[${i}].commit ${g.commit} is not in HEAD's history`);
    }
    if (e.counts && !tracked.has(e.counts.source)) problems.push(`${quoted(e.id)}.counts.source ${quoted(e.counts.source)} is not a file tracked at HEAD`);
  }
  /**
   * Whether a row stands: yes, no, or null when this clone cannot say. A commit off the history is its own problem.
   * @param {ClassGate} g @returns {boolean | null}
   */
  const stands = (g) => (g.action === REMOVED ? existedAt(cwd, env, g.commit, g.file, shallow) : tracked.has(g.file));
  /** @type {string | null} */
  let failed = null;
  try {
    for (const e of entries.filter((entry) => claimsGate(entry.state))) {
      const can = isClosed(e.state) ? closes(e.state) : isGate;
      // The rows git need not be asked about go first: one that stands makes the removals history.
      const rows = [...(e.gates ?? []).entries()].filter(([, g]) => can(g)).sort(([, a], [, b]) => Number(a.action === REMOVED) - Number(b.action === REMOVED));
      /** @type {(boolean | null)[]} */
      const answers = [];
      for (const [, g] of rows) {
        answers.push(stands(g));
        if (answers.at(-1)) break;
      }
      if (answers.at(-1)) continue;
      if (answers.includes(null)) thin++;
      else for (const [i, g] of rows) problems.push(`${quoted(e.id)}.gates[${i}].file ${quoted(g.file)} is not a file ${g.action === REMOVED ? "at its commit or that commit's parent" : "tracked at HEAD"}: state ${e.state} has no standing gate`);
    }
  } catch (e) {
    failed = gitSaid(e);
  }
  const unmeasured = [past ? `${past} past the boundary of a shallow clone` : "", thin ? `gates this clone may not hold: ${thin}` : "", failed ?? ""].filter(Boolean).join("; ");
  return { problems, unmeasured: unmeasured || null };
}

/**
 * The registry's one line of a report: its key, values and level, for doctor and `ennyn classes`. It holds no
 * sentence of an entry.
 * @param {ReturnType<typeof loadClasses>} reg @param {ReturnType<typeof checkProofs>} proofs
 * @returns {{ level: "ok" | "fail" | "unmeasured", key: string, vars: Record<string, string | number | string[]> }}
 */
export function registryLine(reg, proofs) {
  const path = [reg.path];
  if (!reg.there) return { level: "ok", key: "classes.none", vars: { path } };
  const problems = [...reg.problems, ...proofs.problems];
  const vars = { path, total: reg.size, states: stateCounts(reg).map(([s, n]) => `${s} ${n}`).join(", ") || "—" };
  const error = proofs.unmeasured ?? "";
  if (problems.length) return { level: "fail", key: error ? "classes.badUnmeasured" : "classes.bad", vars: { ...vars, count: problems.length, first: problems[0], error } };
  return error ? { level: "unmeasured", key: "classes.unmeasured", vars: { ...vars, error } } : { level: "ok", key: "classes.ok", vars };
}
