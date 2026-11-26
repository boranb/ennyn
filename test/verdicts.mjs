/**
 * Verdict corpora: the probes a gate was given, each kept as a cell with the exact verdict the gate gave it when
 * it was recorded (`refused`; `said`: let through, saying something; `pass`: let through in silence) and why.
 * test/verdicts.test.mjs replays every cell and fails on any verdict or reason that moved. A fix that narrows or
 * replaces a reading turns a refused or said cell into a silent pass: the move is a failing test, not a reviewer's
 * finding a round later. A move that is meant is an edit of the recorded verdict in the same commit, where its
 * diff shows it; `record` (`node test/verdicts.mjs add <gate> <probes.json>`) adds new cells that get the verdict
 * they `expect` (or pass in silence as the `gap` they name), and never rewrites a recorded line.
 *
 * The commit-msg hook's gates (ci, deps, secrets, forbidden) replay through the hook itself: each cell is a
 * repository with its files staged (names as bytes, `head` committed first), its config committed with `head` and
 * `commit-check --hook` run on its message, so what the hook does around the checks (which files it reads, the
 * names and the message it scans, the budget, a key's file read whole) is replayed too. Their why is each line
 * the hook prints, as its catalog key and the values in it (counts, places), sorted. The readers that are no
 * hook (init-scan's ban lines, doctor's hook reader, the guards test's declarations, the kill hook's reader) are called as their
 * callers call them. The push hook runs as Claude Code runs it, its input on stdin.
 *
 * Cycles 2026-10-24 (8) and (9) found this class about 80 times, nearly all fix-introduced and found by
 * reviewers re-running probes an earlier round had refused: NFC over raw bytes, decoded lines in place of git's
 * own, a string-stripping hook reader, a declaration reader rewritten, a run line read only at command
 * positions, a list of "safe" fields, a prefilter tuned for one consumer.
 *
 * A cell file (`test/verdicts/<gate>.json`) is a JSON array, one cell a line: `id`, the gate's input (`INPUTS`),
 * `verdict`, `why`, `from` (where the probe came from, never a project's name) and, for a known silent pass,
 * `gap`: the open graph node that closes it (test/verdicts.test.mjs checks the graph). Byte values (`bytesOf`)
 * are a string (UTF-8), `{ hex }`, `{ latin1 }`, `{ utf16le | utf16be | utf32le | utf32be, bom? }`, `{ json }` or
 * a list of these, joined; a file given as null is deleted, `{ symlink: "<target>" }` is a symbolic link and
 * `{ gitlink: "<commit>" }` a submodule's entry, as the index holds them. The secrets and deps gates read `{{name}}` in a cell
 * as a token of test/secret-shapes.mjs (`{{npm}}`, `{{begin:RSA PRIVATE KEY}}`, `{{end:…}}`,
 * `{{body:<lines>:<seed>[:escaped]}}`, `{{rand:<n>:<alphabet>:<seed>}}`, `{{b64pem:<label>:<lines>:<seed>[:<width>[:<indent>]]}}`),
 * the cell's registry (`{{registry}}`) or
 * a time that many seconds ago (`{{ago:<seconds>[:<±hh:mm>]}}`: the hook asks the clock), so no line here holds a
 * secret.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalog } from "../plugin/core/i18n.mjs";
import { killTarget } from "../plugin/adapters/claude-code/kill-targets.mjs";
import { banLines } from "../plugin/setup/scan.mjs";
import { hookBlock, namesCheck, printedCheck } from "../plugin/setup/hook.mjs";
import { accounting, declarations, testNames } from "./declarations.mjs";
import { B62, B64, B64URL, HEX, TOKENS, UPPER_DIGITS, body, pem, rand } from "./secret-shapes.mjs";

const ALPHABETS = { B62, B64, B64URL, UPPER_DIGITS, HEX };
const HERE = dirname(fileURLToPath(import.meta.url));
export const DIR = join(HERE, "verdicts");
const CLI = join(HERE, "..", "plugin", "scripts", "ennyn.mjs");
const PUSH_HOOK = join(HERE, "..", "plugin", "adapters", "claude-code", "hooks", "push-spellings.mjs");
export const VERDICTS = /** @type {const} */ (["refused", "said", "pass"]);

/** The keys of a cell beside its input. */
const CELL_KEYS = ["id", "from", "verdict", "why", "gap", "known"];
/** The input keys each gate's cells may hold; any other key is a typo the gate would not read. */
export const INPUTS = {
  ci: ["workflow", "files", "head", "config", "message"],
  deps: ["files", "head", "rule", "answers", "config", "message"],
  secrets: ["files", "head", "except", "config", "message"],
  forbidden: ["rules", "files", "head", "config", "message"],
  bans: ["text"],
  hook: ["text"],
  declarations: ["text"],
  kill: ["text"],
  push: ["text", "agent"],
  "input-shapes": [],
};

/** @param {unknown} v */
const isRules = (v) => Array.isArray(v) && v.every((r) => isObject(r) && typeof r.text === "string");
/** What each input must be, and how the problem reads when it is not. @type {Record<string, [(v: unknown) => boolean, string]>} */
const TYPES = {
  workflow: [(v) => typeof v === "string", "is not a string"],
  message: [(v) => typeof v === "string", "is not a string"],
  text: [(v) => typeof v === "string", "is not a string"],
  agent: [(v) => typeof v === "string", "is not a string"],
  husky: [(v) => v === true, "is not true"],
  files: [(v) => isObject(v), "is not an object of names"],
  head: [(v) => isObject(v), "is not an object of names"],
  rules: [isRules, "is not a list of rules with a text"],
  rule: [(v) => isObject(v), "is not an object"],
  answers: [(v) => isObject(v), "is not an object"],
  config: [(v) => isObject(v), "is not an object"],
  except: [(v) => Array.isArray(v) && v.every((x) => typeof x === "string"), "is not a list of globs"],
};
/** A known limit's anchor: an open graph node's id, or DESIGN.md's own words after "DESIGN.md: " (the test reads both). @param {unknown} v */
const isAnchor = (v) => typeof v === "string" && (/^[a-z0-9][a-z0-9-]*$/.test(v) || (v.startsWith("DESIGN.md: ") && v.length > 20));

/**
 * The problems of one cell's inputs and markers: keys the gate does not read, values of the wrong kind.
 * @param {string} gate @param {Record<string, unknown>} c @param {string[]} [extra] keys a probe may also hold
 */
function inputProblems(gate, c, extra = []) {
  const inputs = INPUTS[/** @type {keyof typeof INPUTS} */ (gate)] ?? [];
  /** @type {string[]} */
  const out = [];
  const unknown = Object.keys(c).filter((k) => !CELL_KEYS.includes(k) && !extra.includes(k) && !inputs.includes(k));
  if (unknown.length) out.push(`${unknown.map((k) => JSON.stringify(k)).join(", ")} is no input of ${gate} (${inputs.join(", ") || "none"})`);
  const typed = inputs.filter((k) => c[k] !== undefined && !TYPES[k][0](c[k])).map((k) => `${JSON.stringify(k)} ${TYPES[k][1]}`);
  if (typed.length) out.push(typed.join(", "));
  if (c.known !== undefined && !isAnchor(c.known)) out.push('known names no anchor (a graph node, or "DESIGN.md: <its words>")');
  return out;
}

/**
 * @typedef {typeof VERDICTS[number]} Verdict
 * @typedef {{ verdict: Verdict, why?: string[] }} Outcome
 * @typedef {{ id: string, verdict: Verdict, why?: string[], from: string, gap?: string, known?: string, [input: string]: unknown }} Cell
 *   `known`: a recorded verdict that is a known limit (a false refusal, a false warning, a pass DESIGN.md says
 *   is not seen), anchored like a gap; when it moves, the failure says so instead of calling it a defect
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The cells of a gate, each checked for its shape: every problem at once, as a thrown error.
 * @param {string} gate @param {string} [dir]
 * @returns {Cell[]}
 */
export function readCells(gate, dir = DIR) {
  const path = join(dir, `${gate}.json`);
  const cells = JSON.parse(readFileSync(path, "utf8"));
  const problems = cellProblems(gate, cells);
  if (problems.length) throw new Error(`${path}:\n${problems.join("\n")}`);
  return cells;
}

/** @param {string} gate @param {unknown} cells */
function cellProblems(gate, cells) {
  if (!Array.isArray(cells)) return ["not a list of cells"];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  cells.forEach((c, i) => {
    if (!isObject(c)) return void out.push(`cell ${i + 1}: not an object`);
    const at = `cell ${i + 1}${typeof c.id === "string" ? ` (${c.id})` : ""}`;
    if (typeof c.id !== "string" || !c.id.trim()) out.push(`${at}: no id`);
    else if (seen.has(c.id)) out.push(`${at}: the id is there twice`);
    seen.add(c.id);
    if (!VERDICTS.includes(/** @type {any} */ (c.verdict))) out.push(`${at}: verdict is not one of ${VERDICTS.join(", ")}`);
    if (c.why !== undefined && !(Array.isArray(c.why) && c.why.every((w) => typeof w === "string"))) out.push(`${at}: why is not a list of strings`);
    if (typeof c.from !== "string" || !c.from.trim()) out.push(`${at}: no from`);
    if (c.gap !== undefined && (typeof c.gap !== "string" || !c.gap.trim() || c.verdict !== "pass")) out.push(`${at}: a gap is a silent pass named by the graph node that closes it`);
    for (const x of inputProblems(gate, c)) out.push(`${at}: ${x}`);
  });
  return out;
}

/**
 * The bytes a cell's value stands for.
 * @param {unknown} v
 * @returns {Buffer}
 */
export function bytesOf(v) {
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (Array.isArray(v)) return Buffer.concat(v.map(bytesOf));
  if (isObject(v)) {
    const keys = Object.keys(v).filter((k) => k !== "bom");
    const [k] = keys;
    const text = v[k];
    if (keys.length === 1 && k === "json") return Buffer.from(`${JSON.stringify(text, null, 2)}\n`);
    if (keys.length === 1 && typeof text === "string") {
      if (k === "hex" && /^(?:[0-9a-f]{2})*$/i.test(text)) return Buffer.from(text, "hex");
      if (k === "latin1" && !/[^\x00-\xff]/.test(text)) return Buffer.from(text, "latin1");
      const wide = /^utf(16|32)(le|be)$/.exec(k);
      if (wide) return encode(`${v.bom === true ? "﻿" : ""}${text}`, Number(wide[1]), wide[2] === "le");
    }
  }
  throw new Error(`not a byte value: ${JSON.stringify(v)?.slice(0, 80)}`);
}

/** @param {string} s @param {number} bits @param {boolean} le */
function encode(s, bits, le) {
  if (bits === 16) {
    const out = Buffer.from(s, "utf16le");
    return le ? out : out.swap16();
  }
  return Buffer.concat(
    [...s].map((c) => {
      const b = Buffer.alloc(4);
      const cp = /** @type {number} */ (c.codePointAt(0));
      if (le) b.writeUInt32LE(cp);
      else b.writeUInt32BE(cp);
      return b;
    }),
  );
}

/**
 * A cell with its `{{name}}` places filled: the tokens of test/secret-shapes.mjs, `{{ago:<seconds>}}` and `more`
 * (the cell's registry). A name nothing fills is left as written.
 * @template T
 * @param {T} cell @param {Record<string, string>} [more]
 * @returns {T}
 */
export function filled(cell, more = {}) {
  const json = JSON.stringify(cell).replace(/\{\{(\w+)(?::([^{}]*))?\}\}/g, (all, name, arg) => {
    const value =
      name === "begin" && arg ? pem(arg).begin
      : name === "end" && arg ? pem(arg).end
      : name === "body" && /^\d+:\d+(:escaped)?$/.test(arg ?? "") ? body(Number(arg.split(":")[0]), Number(arg.split(":")[1])).join(arg.endsWith(":escaped") ? "\\n" : "\n")
      : name === "rand" && /^\d+:(B62|B64|B64URL|UPPER_DIGITS|HEX):\d+$/.test(arg ?? "") ? rand(Number(arg.split(":")[0]), ALPHABETS[/** @type {keyof typeof ALPHABETS} */ (arg.split(":")[1])], Number(arg.split(":")[2]))
      : name === "b64pem" && /^[A-Z ]+:\d+:\d+(:\d+(:\d+)?)?$/.test(arg ?? "") ? b64pem(.../** @type {[string, ...string[]]} */ (arg.split(":")))
      : name === "ago" && /^-?\d+(:[+-]\d\d:\d\d)?$/.test(arg ?? "") ? ago(Number(arg.split(":")[0]), arg.slice(arg.indexOf(":") + 1 || arg.length))
      : arg === undefined && Object.hasOwn(more, name) ? more[name]
      : arg === undefined && Object.hasOwn(TOKENS, name) ? TOKENS[/** @type {keyof typeof TOKENS} */ (name)]
      : null;
    return value === null ? all : JSON.stringify(value).slice(1, -1);
  });
  return JSON.parse(json);
}

/**
 * A private key's PEM (its header, `lines` of key material, its footer) as base64, on one line or wrapped at
 * `width` with each line indented, as a Kubernetes Secret or a kubeconfig holds one.
 * @param {string} label @param {string} lines @param {string} seed @param {string} [width] @param {string} [indent]
 */
function b64pem(label, lines, seed, width, indent = "0") {
  const k = pem(label);
  const b64 = Buffer.from(`${k.begin}\n${body(Number(lines), Number(seed)).join("\n")}\n${k.end}\n`).toString("base64");
  return width ? (b64.match(new RegExp(`.{1,${width}}`, "g")) ?? []).map((l) => " ".repeat(Number(indent)) + l).join("\n") : b64;
}

/**
 * The time `seconds` ago, as ISO 8601 in UTC or, with an offset (`+03:00`), in that offset's local time.
 * @param {number} seconds @param {string} offset
 */
function ago(seconds, offset) {
  const at = Date.now() - seconds * 1000;
  if (!offset) return new Date(at).toISOString();
  const minutes = (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(at + minutes * 60000).toISOString().replace("Z", offset);
}

/** Every English template as a pattern whose groups are its variables; a value repeated is a back reference. */
const TEMPLATES = Object.entries(catalog("en")).map(([key, text]) => {
  const names = new Set();
  const parts = String(text).split(/\{(\w+)\}/);
  const source = parts
    .map((p, i) => {
      if (i % 2 === 0) return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (names.has(p)) return `\\k<${p}>`;
      names.add(p);
      return `(?<${p}>[\\s\\S]*?)`;
    })
    .join("");
  return { key, re: new RegExp(`^${source}$`), weight: parts.filter((_, i) => i % 2 === 0).join("").length };
});

/**
 * A message as its catalog key and the values in it, the key whose literal text it holds most of; a value that
 * is itself a message (a reason) is its key too. A line no template makes is `? <line>`.
 * @param {string} line
 * @returns {string}
 */
export function reasonOf(line) {
  const of = (/** @type {string} */ s, /** @type {number} */ min) => {
    const m = TEMPLATES.filter((x) => x.weight >= min && x.re.test(s)).sort((a, b) => b.weight - a.weight)[0];
    return m ? { key: m.key, vars: /** @type {Record<string, string>} */ ({ ...m.re.exec(s)?.groups }) } : null;
  };
  const top = of(line, 1);
  if (!top) return `? ${line}`;
  for (const [k, v] of Object.entries(top.vars)) {
    // git's or the engine's own words: they change with the machine, not with the reading.
    if (k === "error") {
      top.vars[k] = "…";
      continue;
    }
    const inner = of(v, 8);
    if (inner) top.vars[k] = Object.keys(inner.vars).length ? `${inner.key} ${JSON.stringify(inner.vars)}` : inner.key;
  }
  return Object.keys(top.vars).length ? `${top.key} ${JSON.stringify(top.vars)}` : top.key;
}

/**
 * The environment of a cell's git and hook: this process's, less every variable that points git or Ennyn at
 * another repository, index or config (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ENNYN_CONFIG…, as inside a git
 * hook), with no git config but the repository's own (a cell's repository is this process's, so it needs no
 * safe.directory) and git's C locale.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cellEnv(env = process.env) {
  const keep = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES"];
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("GIT_") && !keep.includes(k)) continue;
    if (k.startsWith("ENNYN_") && k !== "ENNYN_HOSTILE_HOME") continue;
    out[k] = v;
  }
  return { ...out, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, LC_ALL: out.LC_ALL ?? "C" };
}

const CONFIG_FILE = ".ennyn/config.json";

/** How long a cell's hook may run: some 300 times what it takes on a quiet machine, so a hook that hangs fails the cell, not the run. */
const HOOK_LIMIT = 60_000;

/**
 * A process run to its end, or stopped past `limit` ms: exit code, stdout and stderr as text.
 * @param {string} cmd @param {string[]} args @param {{ cwd: string, input?: Buffer | string, env?: NodeJS.ProcessEnv, limit?: number }} opts
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(cmd, args, { cwd, input, env = cellEnv(), limit = HOOK_LIMIT }) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limit);
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => (clearTimeout(timer), fail(e)));
    child.on("close", (code) => (clearTimeout(timer), done({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut })));
    // A child that ends before it reads what it was given (a git that failed) is no write error here: its exit says it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** git in a cell's repository; a git that fails throws: a cell is never read as clean for it. @param {string} cwd @param {string[]} args @param {Buffer | string} [input] */
async function g(cwd, args, input) {
  const r = await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, input });
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** @param {unknown} name */
const plainName = (name) => typeof name === "string" && name.split("/").every((p) => p && p !== "." && p !== ".." && !p.includes("\0"));

/**
 * The files of a cell, staged into the index by name bytes (as git was given them, no file system between: a
 * decomposed name stays decomposed); null removes one.
 * @param {string} dir @param {unknown} files
 */
async function stage(dir, files) {
  if (!isObject(files)) return;
  const entries = Object.entries(files);
  for (const [name] of entries) if (!plainName(name)) throw new Error(`${JSON.stringify(name)} is no plain relative name`);
  const link = (/** @type {unknown} */ v) => (isObject(v) && Object.keys(v).length === 1 && typeof v.symlink === "string" ? v.symlink : null);
  const gitlink = (/** @type {unknown} */ v) => (isObject(v) && Object.keys(v).length === 1 && typeof v.gitlink === "string" && /^[0-9a-f]{40}$/.test(v.gitlink) ? v.gitlink : null);
  const blobs = entries.filter(([, v]) => v !== null && gitlink(v) === null);
  blobs.forEach(([, v], k) => writeFileSync(join(dir, ".git", `cell-${k}`), link(v) !== null ? Buffer.from(/** @type {string} */ (link(v))) : bytesOf(v)));
  const oids = blobs.length ? (await g(dir, ["hash-object", "-w", "--no-filters", "--stdin-paths"], blobs.map((_, k) => join(dir, ".git", `cell-${k}`)).join("\n") + "\n")).trim().split("\n") : [];
  const mode = (/** @type {string} */ name, /** @type {unknown} */ v) => (gitlink(v) !== null ? `160000 ${gitlink(v)}` : `${link(v) !== null ? "120000" : "100644"} ${oids[blobs.findIndex(([n]) => n === name)]}`);
  const info = entries.map(([name, v]) => Buffer.concat([Buffer.from(v === null ? `0 ${"0".repeat(40)}\t` : `${mode(name, v)}\t`), Buffer.from(name), Buffer.from([0])]));
  await g(dir, ["update-index", "--add", "-z", "--index-info"], Buffer.concat(info));
}

/** A plain object's keys merged into another's, objects within objects too. @param {Record<string, any>} a @param {Record<string, any>} b */
const merged = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, isObject(a[k]) && isObject(b[k]) ? merged(a[k], b[k]) : Object.hasOwn(b, k) ? b[k] : a[k]]));

/**
 * One cell through the commit-msg hook: a repository with `head` committed and `files` staged, the gate's config
 * committed with `head`, `commit-check --hook` on the message as `git commit -m` gives it. A cell whose `head` or
 * `files` holds the config itself says what the commit holds, and its gate config is an edit left in the work tree.
 * A hook that dies (a stack trace, an exit other than 0 and 1) throws.
 * @param {string} gate @param {Cell} raw
 * @returns {Promise<Outcome>}
 */
async function hookCell(gate, raw) {
  /** @type {Record<string, any>} */
  let answers = {};
  const server = gate === "deps" ? createServer((req, res) => {
    const m = /^\/(?:versions\/(.+)\/last-week|(.+))$/.exec(req.url ?? "");
    const name = m ? decodeURIComponent(m[1] ?? m[2]) : "";
    const answer = m && Object.hasOwn(answers, name) ? answers[name][m[1] ? "downloads" : "packument"] : undefined;
    if (answer === undefined) res.writeHead(404).end("{}");
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  }) : null;
  // Absolute: git resolves the blob paths from inside the repository.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-verdicts-")));
  try {
    let registry = "";
    if (server) {
      await new Promise((up) => server.listen(0, "127.0.0.1", () => up(null)));
      // A server left listening keeps a test file from ending on Node 20.0.0, whatever closes it later.
      server.unref();
      registry = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    }
    const c = gate === "deps" || gate === "secrets" ? filled(raw, { registry }) : raw;
    answers = isObject(c.answers) ? c.answers : {};
    /** @type {Record<string, any>} */
    const base =
      gate === "forbidden" ? { review: { forbidden: /** @type {any[]} */ (c.rules ?? []).map((r) => ({ ...r, paths: r.paths ?? ["**"] })) } }
      : gate === "deps" ? { security: { deps: { registries: { [registry]: registry }, ...(isObject(c.rule) ? c.rule : {}) } } }
      : gate === "secrets" && c.except !== undefined ? { security: { secrets: { except: c.except } } }
      : {};
    const config = JSON.stringify(merged(base, isObject(c.config) ? c.config : {}));
    const own = (/** @type {unknown} */ files) => isObject(files) && Object.hasOwn(files, CONFIG_FILE);
    await g(dir, ["init", "-q"]);
    await stage(dir, own(c.head) || own(c.files) ? c.head : { ...(isObject(c.head) ? c.head : {}), [CONFIG_FILE]: config });
    await g(dir, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "head"]);
    await stage(dir, c.workflow === undefined ? c.files : { ".github/workflows/w.yml": c.workflow, ...(isObject(c.files) ? c.files : {}) });
    // A cell that stages nothing (no files, or files HEAD already holds) gives the hook nothing to read but a message.
    if ((await run("git", ["diff", "--cached", "--quiet"], { cwd: dir })).code === 0 && typeof c.message !== "string") throw new Error(`${raw.id}: stages nothing (no files, or files equal to head): a dead cell`);
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, CONFIG_FILE), config);
    writeFileSync(join(dir, ".git", "CELL_MSG"), typeof c.message === "string" ? c.message : "feat: a cell\n");
    const r = await run(process.execPath, [CLI, "commit-check", "--hook", ".git/CELL_MSG"], { cwd: dir, env: { ...cellEnv(), GIT_EDITOR: ":" } });
    // The cell's registry is a port of this run: a line that names it says {{registry}}, as the cell does.
    return hookOutcome(raw.id, r.code, registry ? r.stderr.split(registry).join("{{registry}}") : r.stderr, r.timedOut);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the hook did with a cell: exit 1 refused, exit 0 said when it printed a line, else a silent pass; why
 * each line's catalog key and values, sorted. A hook that died is no verdict: it throws (a stack trace, an exit
 * other than 0 and 1, or the line of the CLI's catch-all, `ennyn commit-check: <error>`, which no refusal
 * prints); so does one stopped past its limit.
 * @param {string} id @param {number | null} code @param {string} stderr @param {boolean} [timedOut]
 * @returns {Outcome}
 */
export function hookOutcome(id, code, stderr, timedOut = false) {
  if (timedOut) throw new Error(`${id}: the hook ran past ${HOOK_LIMIT / 1000} s: ${stderr.slice(0, 2000)}`);
  if ((code !== 0 && code !== 1) || /^\s+at /m.test(stderr) || /^ennyn commit-check: /m.test(stderr)) throw new Error(`${id}: the hook died (exit ${code}): ${stderr.slice(0, 2000)}`);
  const lines = stderr.split("\n").filter(Boolean);
  const verdict = code === 1 ? "refused" : lines.length ? "said" : "pass";
  return verdict === "pass" ? { verdict } : { verdict, why: [...new Set(lines.map(reasonOf))].sort() };
}

/**
 * Tasks run at most `n` at a time, results in their order.
 * @template T, R
 * @param {T[]} items @param {number} n @param {(item: T) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function pool(items, n, task) {
  /** @type {R[]} */
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await task(items[k]);
      }
    }),
  );
  return out;
}

/** @param {string} gate @returns {(cells: Cell[]) => Promise<Map<string, Outcome>>} */
const throughHook = (gate) => async (cells) => {
  const got = await pool(cells, Math.max(4, availableParallelism()), (c) => hookCell(gate, c));
  return new Map(cells.map((c, k) => [c.id, got[k]]));
};

/**
 * The gates and how each replays its cells. Each returns an outcome per cell id.
 * @type {Record<string, (cells: Cell[]) => Promise<Map<string, Outcome>>>}
 */
export const GATES = {
  /** security.ci: `workflow` (.github/workflows/w.yml), `files`, `head`, `config`, `message`, through the hook. */
  ci: throughHook("ci"),
  /** security.deps: `files`, `head` (a lock as `{ json }`), `rule` (security.deps keys over a registry of the cell's own at 127.0.0.1, listed), `answers` (per package name, the `packument` and `downloads` it gives), through the hook. */
  deps: throughHook("deps"),
  /** security.secrets: `files`, `head`, `except`, `message`, through the hook. */
  secrets: throughHook("secrets"),
  /** review.forbidden: `rules` (`paths` defaults to every file), `files`, `head`, through the hook. */
  forbidden: throughHook("forbidden"),

  /** init-scan's ban lines: `text`, an instruction file. Said: a "never `X`" line found, why its literals. */
  async bans(cells) {
    return new Map(
      cells.map((c) => {
        const found = banLines(String(c.text));
        return [c.id, found.length ? { verdict: /** @type {Verdict} */ ("said"), why: found.flatMap((b) => b.literals) } : { verdict: /** @type {Verdict} */ ("pass") }];
      }),
    );
  },

  /**
   * doctor's hook reader: `text`, a commit-msg hook, `{{block}}` in it standing for the block install-hook prints
   * (so a cell of the printed block follows the text; an edited one holds its own). Pass: what install-hook printed,
   * first (printedCheck); said: doctor warns, why `doctor.hookUnread` when it names commit-check.
   */
  async hook(cells) {
    return new Map(
      cells.map((c) => {
        const text = String(c.text).replaceAll("{{block}}", hookBlock("/x/plugins/data/ennyn-ennyn"));
        if (printedCheck(text) !== null) return [c.id, { verdict: /** @type {Verdict} */ ("pass") }];
        return [c.id, namesCheck(text) ? { verdict: /** @type {Verdict} */ ("said"), why: ["doctor.hookUnread"] } : { verdict: /** @type {Verdict} */ ("said") }];
      }),
    );
  },

  /**
   * The guards test's declaration reader: `text`, a gate file. Said: accounting finds a test declared in a form
   * it does not read as a top-level test; why: the calls counted, the names read, and a renamed import.
   */
  async declarations(cells) {
    return new Map(
      cells.map((c) => {
        const text = String(c.text);
        const names = testNames(text);
        const problems = accounting({ test: "t", guards: [], others: Object.fromEntries(names.map((n) => [n, "decided"])) }, text);
        const d = declarations(text);
        const why = [`declared ${d.calls}`, `read ${names.length}`, ...(d.renamed ? ["renamed"] : [])];
        return [c.id, { verdict: /** @type {Verdict} */ (problems.length ? "said" : "pass"), why }];
      }),
    );
  },

  /** The kill hook's reader: `text`, a shell command. Refused: it stops a process the text did not start, why its reason (name, lookup, port, every, unread). */
  async kill(cells) {
    return new Map(
      cells.map((c) => {
        const r = killTarget(String(c.text));
        return [c.id, r ? { verdict: /** @type {Verdict} */ ("refused"), why: [r.why] } : { verdict: /** @type {Verdict} */ ("pass") }];
      }),
    );
  },

  /**
   * The push hook (adapters/claude-code/hooks/push-spellings.mjs) as Claude Code runs it: `text`, a Bash call's command,
   * and `agent`, the input's agent_id (a call made in a subagent; none on the main thread), from the top of a repository
   * whose config is `{}` (push.mode ask). Refused: it denies; said: it asks, or says it cannot read the input; why the
   * reason as its catalog key.
   */
  async push(cells) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-verdicts-push-")));
    try {
      await g(dir, ["init", "-q"]);
      mkdirSync(join(dir, ".ennyn"));
      writeFileSync(join(dir, CONFIG_FILE), "{}\n");
      const got = await pool(cells, Math.max(4, availableParallelism()), async (c) => {
        const input = { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c.text, description: "x" }, cwd: dir, ...(c.agent === undefined ? {} : { agent_id: c.agent }) };
        const r = await run(process.execPath, [PUSH_HOOK], { cwd: dir, input: JSON.stringify(input), env: { ...cellEnv(), CLAUDE_PROJECT_DIR: dir } });
        if (r.timedOut || r.code !== 0 || r.stderr) throw new Error(`${c.id}: the hook died (exit ${r.code}): ${r.stderr.slice(0, 2000)}`);
        if (!r.stdout) return { verdict: /** @type {Verdict} */ ("pass") };
        const out = JSON.parse(r.stdout);
        const said = out.hookSpecificOutput?.permissionDecisionReason ?? out.systemMessage;
        const decision = out.hookSpecificOutput?.permissionDecision;
        return { verdict: /** @type {Verdict} */ (decision === "deny" ? "refused" : "said"), why: [reasonOf(String(said))] };
      });
      return new Map(cells.map((c, k) => [c.id, got[k]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/**
 * The recorded verdicts that moved, in four groups: silent passes (a refused or said cell now passes), new
 * refusals (a passing cell now refused or said), refused and said swapped, and the same verdict for another
 * reason; a known limit that moved, apart; and the cells of one side only (recorded but not run, run but not
 * recorded).
 * @param {Pick<Cell, "id" | "verdict" | "why" | "gap" | "known">[]} cells @param {Map<string, Outcome>} got
 */
export function moves(cells, got) {
  /** @type {Record<"silent" | "refusals" | "swapped" | "reasons" | "known" | "unrun" | "unrecorded", string[]>} */
  const out = { silent: [], refusals: [], swapped: [], reasons: [], known: [], unrun: [], unrecorded: [] };
  const recorded = new Set(cells.map((c) => c.id));
  for (const c of cells) {
    const g = got.get(c.id);
    if (!g) {
      out.unrun.push(c.id);
      continue;
    }
    const was = `${c.id}: recorded ${c.verdict}, now ${g.verdict}`;
    const moved = c.verdict !== g.verdict || JSON.stringify(c.why ?? []) !== JSON.stringify(g.why ?? []);
    if (c.known && moved) out.known.push(`${was} ${JSON.stringify(g.why ?? [])} (a known limit: ${c.known})`);
    else if (c.verdict !== "pass" && g.verdict === "pass") out.silent.push(was);
    else if (c.verdict === "pass" && g.verdict !== "pass") out.refusals.push(`${was} ${JSON.stringify(g.why ?? [])}${c.gap ? ` (the gap ${c.gap} closed: record it)` : ""}`);
    else if (c.verdict !== g.verdict) out.swapped.push(`${was} ${JSON.stringify(g.why ?? [])}`);
    else if (JSON.stringify(c.why ?? []) !== JSON.stringify(g.why ?? [])) out.reasons.push(`${c.id}: ${c.verdict}, recorded why ${JSON.stringify(c.why ?? [])}, now ${JSON.stringify(g.why ?? [])}`);
  }
  for (const [id, g] of got) if (!recorded.has(id)) out.unrecorded.push(`${id}: ${g.verdict} ${JSON.stringify(g.why ?? [])}`);
  return out;
}

/**
 * The moves as the failure says them, silent passes first; "" when nothing moved.
 * @param {string} gate @param {ReturnType<typeof moves>} m
 */
export function movesText(gate, m) {
  const groups = [
    ["a known limit moved (read its anchor, then record what it gets now)", m.known],
    ["now pass in silence (the defect this corpus exists for)", m.silent],
    ["now refused or said, recorded as passing", m.refusals],
    ["refused and said swapped", m.swapped],
    ["the same verdict for another reason", m.reasons],
    ["recorded, but not run", m.unrun],
    ["run, but no verdict recorded", m.unrecorded],
  ].filter(([, list]) => list.length);
  if (!groups.length) return "";
  const lines = groups.flatMap(([title, list]) => [`${title}:`, ...[...list].map((x) => `  ${x}`)]);
  return [
    `test/verdicts/${gate}.json: ${groups.reduce((n, [, list]) => n + list.length, 0)} cell(s) moved`,
    ...lines,
    "A move that is meant: change the recorded verdict (and why) in the same commit, so the diff shows it; a cell is retired with a reason in the commit, not dropped; a new cell: node test/verdicts.mjs add.",
  ].join("\n");
}

/**
 * Probes added to a gate's cells: each names the verdict it `expect`s, or the `gap` it is (an open graph node; a
 * gap passes in silence), and may name what its why must hold (`expectWhy`: a key or words of a line); a probe
 * may carry a `known` anchor. Each is replayed twice. A probe that does not get what it expects, gets a why that
 * differs between the runs, gives no verdict (a dead cell, a hook that died), has a recorded id, gives a verdict
 * or why itself, or an input the gate does not read or of the wrong kind: each is refused, never recorded. The
 * new cells go before the closing bracket, one a line; every line already there is kept as written.
 * @param {string} gate @param {unknown} probes @param {{ dir?: string, replay?: (cells: Cell[]) => Promise<Map<string, Outcome>> }} [opts]
 * @returns {Promise<{ added: Cell[], refused: string[] }>}
 */
export async function record(gate, probes, { dir = DIR, replay = GATES[gate] } = {}) {
  if (!GATES[gate]) throw new Error(`no gate ${JSON.stringify(gate)}: ${Object.keys(GATES).join(", ")}`);
  if (!Array.isArray(probes)) throw new Error("the probes are not a list");
  const path = join(dir, `${gate}.json`);
  const text = readFileSync(path, "utf8");
  const cells = readCells(gate, dir);
  const ids = new Set(cells.map((c) => c.id));
  /** @type {string[]} */
  const refused = [];
  /** @type {Record<string, any>[]} */
  const fresh = [];
  for (const p of probes) {
    const problems = isObject(p) ? inputProblems(gate, p, ["expect", "expectWhy"]) : [];
    const whyList = isObject(p) && p.expectWhy !== undefined ? [p.expectWhy].flat() : [];
    if (!isObject(p) || typeof p.id !== "string" || !p.id.trim() || typeof p.from !== "string" || !p.from.trim()) refused.push(`${JSON.stringify(p).slice(0, 80)}: a probe needs an id and a from`);
    else if (ids.has(p.id)) refused.push(`${p.id}: recorded already; change a recorded verdict by hand, in the commit that moves it`);
    else if ("verdict" in p) refused.push(`${p.id}: a probe's verdict is what it expects: name it "expect"`);
    else if ("why" in p) refused.push(`${p.id}: a probe gives no why; the gate gives it (name what it must hold "expectWhy")`);
    else if (problems.length) refused.push(`${p.id}: ${problems.join("; ")}`);
    else if (!whyList.every((w) => typeof w === "string" && w)) refused.push(`${p.id}: expectWhy is a key or words of a line, or a list of them`);
    else if (p.gap !== undefined && (typeof p.gap !== "string" || !p.gap.trim())) refused.push(`${p.id}: a gap names the graph node that closes it`);
    else if (p.gap === undefined && !VERDICTS.includes(/** @type {any} */ (p.expect))) refused.push(`${p.id}: expect is not one of ${VERDICTS.join(", ")}: a probe says what the gate should do`);
    else {
      ids.add(p.id);
      fresh.push(p);
    }
  }
  const runs = await pool(fresh, 4, async (p) => {
    try {
      const [a, b] = [(await replay(/** @type {Cell[]} */ ([p]))).get(p.id), (await replay(/** @type {Cell[]} */ ([p]))).get(p.id)];
      return { a: /** @type {Outcome} */ (a), b: /** @type {Outcome} */ (b) };
    } catch (e) {
      return { error: /** @type {Error} */ (e).message.split("\n")[0] };
    }
  });
  /** @type {Cell[]} */
  const added = [];
  fresh.forEach((p, k) => {
    const r = runs[k];
    const { expect, expectWhy, ...cell } = p;
    const why = r.a?.why ?? [];
    if (r.error || !r.a || !r.b) refused.push(`${p.id}: no verdict: ${r.error ?? "the replay gave none"}`);
    else if (r.a.verdict !== r.b.verdict || JSON.stringify(why) !== JSON.stringify(r.b.why ?? [])) refused.push(`${p.id}: its why differs between two runs: ${JSON.stringify(why)} and ${JSON.stringify(r.b.why ?? [])}`);
    else if (p.gap !== undefined && r.a.verdict !== "pass") refused.push(`${p.id}: not a gap, it gets ${r.a.verdict} ${JSON.stringify(why)}`);
    else if (p.gap === undefined && r.a.verdict !== expect) refused.push(`${p.id}: expected ${expect}, got ${r.a.verdict} ${JSON.stringify(why)}`);
    else if (expectWhy !== undefined && ![expectWhy].flat().every((w) => why.some((x) => x.includes(w)))) refused.push(`${p.id}: expected a why holding ${[expectWhy].flat().map((w) => JSON.stringify(w)).join(" and ")}, got ${JSON.stringify(why)}`);
    else added.push(/** @type {Cell} */ ({ ...cell, verdict: r.a.verdict, ...(r.a.why ? { why: r.a.why } : {}) }));
  });
  if (added.length) {
    // The file parsed as a list: its last "]" closes it.
    const head = text.slice(0, text.lastIndexOf("]")).replace(/\s*$/, "");
    const lines = added.map((c) => `  ${JSON.stringify(c)}`).join(",\n");
    writeFileSync(path, `${head}${cells.length ? "," : ""}\n${lines}\n]\n`);
  }
  return { added, refused };
}

// node test/verdicts.mjs add <gate> <probes.json>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, gate, file] = process.argv.slice(2);
  if (cmd !== "add" || !gate || !file) {
    process.stderr.write("usage: node test/verdicts.mjs add <gate> <probes.json>\n");
    process.exit(2);
  }
  const r = await record(gate, JSON.parse(readFileSync(file, "utf8")));
  for (const c of r.added) process.stdout.write(`added ${c.id}: ${c.verdict} ${JSON.stringify(c.why ?? [])}\n`);
  for (const x of r.refused) process.stderr.write(`refused ${x}\n`);
  process.exitCode = r.refused.length ? 1 : 0;
}
