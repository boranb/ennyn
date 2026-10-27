/**
 * Reference differentials for npm: what npm itself does with a lock file, recorded, and the deps gate's reading
 * (checks/deps.mjs) replayed against it. The gate re-reads npm's lock and its source spellings to judge them;
 * each time that reading drifted from npm's, a reviewer found it a round later. Cycle 2026-10-25 (10) found the
 * class about 21 times, 14 of them here (the lock's shape, `name@spec`, a version that is a spec, v1
 * precedence, hosted URLs, scp-like specs, bundles twice), most by reviewers who ran npm. Here npm gives the
 * expected values.
 *
 * Recording runs `npm ci`'s own steps (lib/commands/ci.js) with the machine's npm, on the cell's lock and
 * `.npmrc` only: npm's config loader with no user, global or builtin config and no npm_config_ variable,
 * offline, validated as npm validates it; arborist's loadVirtual, buildIdealTree and the lock check; then reify,
 * with pacote's extract and metadata calls replaced by a stand-in. What npm would fetch at a location is the
 * spec reify hands pacote; a link, the path it points at; an entry inside a dependency's tarball is fetched by
 * nobody. The stand-in never answers from the input under test: a metadata question that is not an entry's own
 * is npm fetching that place anew from the spec's source (`refetch`), and there the recording stops. Nothing is
 * downloaded and no script runs. npm's modules are loaded from the machine at record time only: the test
 * (test/reference.test.mjs) reads the record and never asks the machine.
 *
 * The gate's reading of a location is what judgeLock's verdict on it claims: a listed tarball, the URL npm
 * fetches (with no resolved: the name, version and registry); a path inside the repository, a file, directory
 * or link there; a git refusal, git; a bundled entry, one nobody fetches; another refusal, the source it names.
 * A refusal that names no reading (a spelling with no one meaning, a field of the wrong kind) reads nothing.
 * Each location compares to one of:
 *   agree    the gate reads what npm does
 *   unread   the gate refuses or says a spelling it does not read, where npm installs something: stricter on purpose
 *   extra    the gate judges an entry npm installs nothing at (pruned, removed, or the whole lock refused)
 *   differs     the gate reads another source than npm's, or does not see what npm installs
 *   unmeasured  npm was not measured there: past the stand-in's stop, or under an entry with its own shrinkwrap;
 *               never an agreement
 * A cell lists every location that does not agree in `except` ("*" for every other one that does not), each with why:
 * `unread: …`, `extra: …`, `unmeasured: …`, and for `differs` either `gap: <open graph node>` (a hole to close)
 * or `differs: …` (meant). npm's version is in the record: `check` re-reads every cell with the machine's npm and
 * fails when the version or a reading moved, and counts the cells with unmeasured places as not clean; `record`
 * then takes the record again and the test shows which comparisons moved.
 *
 *   node test/reference/npm.mjs add <probes.json>   record npm's reading of new cells (id, from, lock, …)
 *   node test/reference/npm.mjs show [id…]          each location's comparison, with both readings
 *   node test/reference/npm.mjs check               exit 1 when the machine's npm reads a cell otherwise
 *   node test/reference/npm.mjs record              take every reading again (after an npm upgrade)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_REGISTRY, exactVersion, judgeLock, specTag, lockEntries, pathFromLock, registryResolver, sourceForm } from "../../checks/deps.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "npm.json");
/** The input keys a cell may hold beside its id, from, npm reading and except. */
const INPUTS = ["lock", "lockName", "lockDir", "package", "npmrc", "files", "rule"];
const CELL_KEYS = ["id", "from", ...INPUTS, "npm", "except"];
export const RELATIONS = /** @type {const} */ (["agree", "unread", "extra", "differs", "unmeasured", "stricter"]);
/** A path npm reads outside the repository: where exactly depends on the machine, so it is not kept. */
const OUTSIDE = "<outside>";
/** The registry a cell's `{{registry}}` stands for, and the one listed when a cell lists none. */
const REGISTRY = "http://127.0.0.1:4873";

/**
 * @typedef {({ kind: "remote", url: string, spec: string } | { kind: "git", spec: string } | { kind: "file" | "directory" | "link", path: string }
 *   | { kind: "registry", name: string, version: string, registry: string, spec: string } | { kind: "bundled" }) & { refetch?: boolean }} NpmAt
 *   what npm does at a location; `refetch`: it fetches the place anew from that spec, not from the lock's entry
 * @typedef {{ ci: string, at: Record<string, NpmAt>, wrapped?: string[], asked?: string[] }} NpmReading `ci` "ok", the step npm stopped at, or
 *   "stand-in: …" where the stand-in could not answer and npm was not measured further; `wrapped`: entries that carry their own npm-shrinkwrap.json
 * @typedef {{ id: string, from: string, lock: unknown, lockName?: string, lockDir?: string, package?: Record<string, unknown> | string, npmrc?: string, files?: Record<string, string>, rule?: { registries?: Record<string, string | null>, sources?: string[] }, npm?: NpmReading, except?: Record<string, string> }} Cell
 * @typedef {{ kind: string, url?: string, origin?: string, path?: string, name?: string, version?: string, registry?: string, reads: boolean, verdict: string, inner?: Claim, accepts?: boolean }} Claim
 *   `spec`: a dependency's spec judged by its source (`inner`), which the gate `accepts` or not
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `{{registry}}` filled, in any string of a value. @param {any} v @returns {any} */
export function filled(v) {
  if (typeof v === "string") return v.split("{{registry}}").join(REGISTRY);
  if (Array.isArray(v)) return v.map(filled);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [filled(k), filled(x)]));
  return v;
}

/** The lock's text as the cell gives it: a string as written, anything else as JSON. @param {Cell} c */
const lockTextOf = (c) => (typeof c.lock === "string" ? filled(c.lock) : JSON.stringify(filled(c.lock), null, 2));

/** The rule the gate judges with: the cell's registries (else its own, listed) and sources. @param {Cell} c */
function ruleOf(c) {
  const r = filled(c.rule ?? {});
  return /** @type {import("../../checks/deps.mjs").DepsRule} */ ({
    paths: [], cooldownDays: 0, minShare: 0, minWeekly: 0, allow: [], allowScripts: [], online: false, timeout: 1, advisories: "", advisoryRegistries: [],
    registries: r.registries ?? { [REGISTRY]: null },
    sources: r.sources ?? [],
  });
}

/** A URL as WHATWG reads it, or the text when it is none. @param {string} s */
const href = (s) => {
  try {
    return new URL(s).href;
  } catch {
    return s;
  }
};
const bare = (/** @type {string} */ s) => s.replace(/\/+$/, "");
/** @param {string} s */
const originOf = (s) => {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
};

/**
 * A lock key as the place npm installs it: npm normalizes a key (`./`, `//`, `..`, a trailing `/`), and npm on
 * Windows, as the gate everywhere, reads `\` as `/`; a package in install-strategy=linked's store is the place of
 * its name. @param {string} k
 */
const place = (k) => posix.normalize(k.replace(/\\/g, "/")).replace(/\/$/, "").replace(/^node_modules\/\.store\/[^/]+\/node_modules\//, "node_modules/");

/**
 * What the gate's verdict on each location claims npm does there (see the head of this file); two keys of one
 * place give two claims.
 * @param {Cell} c @returns {Map<string, Claim[]> | { unread: string }}
 */
export function claims(c) {
  const lockDir = c.lockDir ?? "";
  // The package.json files npm reads: the cell's root one (with none, the lock's root entry), and each folder's
  // the cell's files hold.
  const files = filled(c.files ?? {});
  const folders = (/** @type {string} */ k) => files[[lockDir, k, "package.json"].filter(Boolean).join("/")];
  const pkg = c.package === undefined ? undefined : typeof c.package === "string" ? filled(c.package) : JSON.stringify(filled(c.package));
  const read = lockEntries(lockTextOf(c), { pkg, folders });
  if (read.unread) return { unread: read.unread.key };
  const rule = ruleOf(c);
  const npmrc = c.npmrc === undefined ? undefined : { staged: Buffer.from(filled(c.npmrc)) };
  const registryFor = registryResolver(npmrc);
  const { judged } = judgeLock([...read.entries, ...(read.specs ?? [])], read.links, rule, { lockDir, registryFor });
  /** @type {Map<string, Claim[]>} */
  const out = new Map();
  for (const [entry, j] of judged) {
    const link = read.links.includes(entry);
    // A spec npm may fetch from claims its source, read from the folder that asks.
    const e = entry.spec ? { ...entry, spec: undefined } : entry;
    const dir = entry.spec?.dir ? [lockDir, entry.spec.dir].filter(Boolean).join("/") : lockDir;
    /** @type {Claim} */
    let claim;
    if ("listed" in j) {
      claim = e.resolved === null ? { kind: "registry", name: j.listed.name, version: j.listed.version, registry: bare(/** @type {string} */ (j.listed.resolved).slice(0, -`/${j.listed.name}/-/${j.listed.name.replace(/^@[^/]+\//, "")}-${j.listed.version}.tgz`.length)), reads: true, verdict: "listed" } : { kind: "remote", url: /** @type {string} */ (e.resolved), reads: true, verdict: "listed" };
    } else if ("sourced" in j) {
      const s = /** @type {string} */ (e.resolved);
      const form = sourceForm(s);
      const p = s.startsWith("file:") ? s.slice(5) : s;
      claim = form === "git" ? { kind: "git", reads: true, verdict: "sourced" } : form === "tarball" ? { kind: "remote", url: s, reads: true, verdict: "sourced" } : { kind: link ? "link" : /\.(?:tgz|tar\.gz|tar)$/i.test(s) ? "file" : "directory", path: pathFromLock(p, dir) ?? OUTSIDE, reads: true, verdict: "sourced" };
    } else if ("inside" in j) {
      claim = { kind: link ? "link" : j.tarball ? "file" : "directory", path: j.inside, reads: true, verdict: "inside" };
    } else {
      const reason = "said" in j ? j.said : j.reason;
      const verdict = "said" in j ? `said ${reason.key}` : `refused ${reason.key}`;
      // A spec's refusal names its source's reason first (`inner`), then the remedy.
      const k = (reason.inner ?? reason).key;
      if (k === "bundled") claim = { kind: "bundled", reads: true, verdict };
      else if (k === "git" || k === "gitMoving") claim = { kind: "git", reads: true, verdict };
      else if (k === "outside") claim = { kind: link ? "link" : "path", path: OUTSIDE, reads: true, verdict };
      else if (k === "from") claim = { kind: "remote", origin: new URL(/** @type {string} */ (e.resolved)).origin, reads: true, verdict };
      else if (["mismatch", "noExactVersion", "notName", "unproven", "unlisted", "noVersion"].includes(k) && e.resolved !== null) claim = { kind: "remote", url: e.resolved, reads: true, verdict };
      // An exact version and a name the registry serves, from a registry the .npmrc names and no list does.
      else if (k === "noResolvedUnlisted") {
        const where = registryFor(e.name);
        claim = { kind: "registry", name: e.name, version: e.version, registry: "url" in where ? where.url : "", reads: true, verdict };
      }
      else claim = { kind: "none", reads: false, verdict };
    }
    if (entry.spec) claim = { kind: "spec", inner: claim, accepts: !("refuse" in j) && !("said" in j), reads: true, verdict: `spec ${claim.verdict}` };
    out.set(place(e.key), [...(out.get(place(e.key)) ?? []), claim]);
  }
  return out;
}

/**
 * Whether npm does at a location what the gate's claim says.
 * @param {Claim} claim @param {NpmAt} at
 */
function same(claim, at) {
  if (claim.kind === "path") return (at.kind === "file" || at.kind === "directory") && at.path === OUTSIDE;
  // install-links copies the directory a link would point at: the same source.
  if (claim.kind === "link" && at.kind === "directory") return at.path === claim.path;
  if (claim.kind !== at.kind) return false;
  if (at.kind === "remote") return claim.origin !== undefined ? originOf(at.url) === claim.origin : href(at.url) === href(/** @type {string} */ (claim.url));
  if (at.kind === "file" || at.kind === "directory" || at.kind === "link") return at.path === claim.path;
  // A registry is a URL npm joins a path to and fetches: compared as WHATWG reads it (case, default port, dot segments).
  if (at.kind === "registry") return at.name === claim.name && (!claim.version || at.version === claim.version) && (!claim.registry || bare(href(at.registry)) === bare(href(claim.registry)));
  return true;
}

/**
 * Each location's comparison: the gate's claims against npm's recorded reading.
 * @param {Cell} c @returns {Map<string, { relation: typeof RELATIONS[number], claim?: Claim, npm?: NpmAt }>}
 */
export function compare(c) {
  const npm = /** @type {NpmReading} */ (c.npm);
  // install-strategy=linked fetches each package into node_modules/.store and links node_modules/<name> to it:
  // the fetch is the place's reading.
  const at = new Map(Object.entries(npm.at).filter(([, v]) => !(v.kind === "link" && v.path.startsWith("node_modules/.store/"))).map(([k, v]) => [place(k), v]));
  // Where the stand-in stopped npm, or under an entry that carries its own shrinkwrap, npm was not measured.
  const stopped = npm.ci.startsWith("stand-in");
  const wrapped = (/** @type {string} */ k) => (npm.wrapped ?? []).some((w) => k.startsWith(`${place(w)}/node_modules/`));
  const mine = claims(c);
  /** @type {Map<string, { relation: typeof RELATIONS[number], claim?: Claim, npm?: NpmAt }>} */
  const out = new Map();
  if (!(mine instanceof Map)) {
    for (const [k, v] of at) out.set(k, { relation: wrapped(k) ? "unmeasured" : "unread", npm: v });
    return out;
  }
  for (const k of new Set([...at.keys(), ...mine.keys()])) {
    const all = mine.get(k) ?? [];
    const n = at.get(k);
    // A spec npm may fetch from, judged by its source: npm fetching from a non-registry spec meets a refusal of that
    // source (or the same source accepted); npm keeping the entry where the gate refuses a spec is stricter on
    // purpose; a registry spec npm fetches anew goes to the configured registry, its version held to the lock's.
    const specs = all.filter((x) => x.kind === "spec");
    const list = all.filter((x) => x.kind !== "spec");
    const refusing = specs.find((x) => !x.accepts);
    if (n?.refetch && n.kind !== "registry") {
      // Met by a refused spec, a spec of that same source, or the entry's own reading of it (a version 1 version).
      const met = refusing ?? specs.find((x) => x.inner && same(x.inner, n)) ?? list.find((x) => x.reads && same(x, n));
      out.set(k, { relation: met ? "agree" : "differs", claim: met ?? list[0], npm: n });
      continue;
    }
    // From the registry: a tag npm fetches anew must meet a refusal (what it names, nothing checked); a version or
    // range validateLockfile holds to the lock's version, which the entry did not satisfy, so npm ci stops there.
    if (n?.refetch) {
      const refused = refusing ?? list.find((x) => x.verdict.startsWith("refused"));
      out.set(k, refused ? { relation: "agree", claim: refused, npm: n } : n.kind === "registry" && specTag(n.version) ? { relation: "differs", claim: list[0], npm: n } : { relation: "extra", claim: list[0], npm: n });
      continue;
    }
    // Two claims of one place: the one furthest from npm's reading speaks for it.
    const rank = (/** @type {Claim} */ x) => (!n ? 0 : !x.reads ? 1 : same(x, n) ? 0 : 2);
    const claim = [...list].sort((a, b) => rank(b) - rank(a))[0];
    if (wrapped(k) || (!n && stopped)) out.set(k, { relation: "unmeasured", claim: claim ?? refusing, npm: n });
    else if (!n) out.set(k, { relation: "extra", claim: claim ?? refusing });
    else if (!claim) out.set(k, { relation: "differs", npm: n });
    else if (!claim.reads) out.set(k, { relation: "unread", claim, npm: n });
    // The entry read as npm does and let through, but a spec there refused: stricter than npm on purpose.
    else if (refusing && same(claim, n) && !claim.verdict.startsWith("refused")) out.set(k, { relation: "stricter", claim: refusing, npm: n });
    else out.set(k, { relation: same(claim, n) ? "agree" : "differs", claim, npm: n });
  }
  return out;
}

/**
 * The comparisons that differ from what the cell lists, each as a line; none when the record holds.
 * @param {Cell[]} cells @param {Set<string>} [openNodes] the graph's open node ids, which a `gap:` must name
 */
export function moves(cells, openNodes) {
  /** @type {string[]} */
  const out = [];
  for (const c of cells) {
    const except = c.except ?? {};
    const got = compare(c);
    for (const [k, why] of Object.entries(except)) {
      const [rel, ...rest] = why.split(":");
      const text = rest.join(":").trim();
      if (!text) out.push(`${c.id} ${k}: "${why}" gives no why`);
      if (rel === "gap" && openNodes && !openNodes.has(text)) out.push(`${c.id} ${k}: gap names no open graph node: ${text}`);
      if (k !== "*" && !got.has(k)) out.push(`${c.id} ${k}: listed, but neither npm nor the gate has this location`);
    }
    // "*" speaks for every place not listed by name that does not agree, and must speak for one.
    const star = except["*"]?.split(":")[0];
    if (star && ![...got].some(([k, r]) => !(k in except) && r.relation !== "agree")) out.push(`${c.id} *: listed, but every other place agrees`);
    for (const [k, r] of got) {
      const listed = except[k] ?? (r.relation === "agree" ? "agree" : except["*"]) ?? "agree";
      const rel = listed.split(":")[0];
      const want = rel === "gap" ? "differs" : rel;
      if (want !== r.relation) out.push(`${c.id} ${k}: ${r.relation}, recorded ${want} — gate ${r.claim ? `${r.claim.verdict} ${JSON.stringify({ ...r.claim, verdict: undefined, reads: undefined })}` : "has no entry"}, npm ${r.npm ? JSON.stringify(r.npm) : "installs nothing"}`);
    }
  }
  return out;
}

/** The cells of the record, with the npm the readings came from. */
export function readRecord(path = RECORD) {
  const rec = JSON.parse(readFileSync(path, "utf8"));
  return /** @type {{ npm: Record<string, string>, unmeasured?: number, cells: Cell[] }} */ (rec);
}

/** The record as written: its header, then one cell a line, so a diff shows the cells that moved. @param {{ npm: Record<string, string>, unmeasured?: number, cells: Cell[] }} rec */
export function recordText(rec) {
  const cells = rec.cells.map((c) => `    ${JSON.stringify(Object.fromEntries(CELL_KEYS.filter((k) => k in c).map((k) => [k, /** @type {any} */ (c)[k]])))}`);
  return `{\n  "npm": ${JSON.stringify(rec.npm)},\n  "unmeasured": ${unmeasuredOf(rec.cells)},\n  "cells": [\n${cells.join(",\n")}\n  ]\n}\n`;
}

/** The places npm was not measured at, over every cell: `check` fails when they grow past the record's count. @param {Cell[]} cells */
export const unmeasuredOf = (cells) => cells.reduce((n, c) => n + [...compare(c).values()].filter((r) => r.relation === "unmeasured").length, 0);

/** What a cell must hold; each problem as a line. @param {any} c */
export function cellProblems(c) {
  /** @type {string[]} */
  const out = [];
  if (!isObject(c)) return ["a cell is an object"];
  // A plain id: messages print it, and a control byte in it would reach the terminal.
  if (typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(c.id)) return [`id ${JSON.stringify(c.id)} is no plain id (letters, digits, -)`];
  if (typeof c.from !== "string" || !c.from) out.push(`${c.id}: no from`);
  if (!("lock" in c)) out.push(`${c.id}: no lock`);
  // The recorder writes each path under a directory of its own: one that could leave it is no cell's.
  const safe = (/** @type {unknown} */ p, oneName = false) => typeof p === "string" && p !== "" && !/[\0\\:]/.test(p) && !p.startsWith("/") && p.split("/").every((x) => x !== "" && x !== "." && x !== "..") && (!oneName || !p.includes("/"));
  if (c.lockDir !== undefined && c.lockDir !== "" && !safe(c.lockDir)) out.push(`${c.id}: lockDir is a relative path of plain names`);
  if (c.lockName !== undefined && !safe(c.lockName, true)) out.push(`${c.id}: lockName is a plain file name`);
  if (c.files !== undefined && (!isObject(c.files) || !Object.entries(c.files).every(([k, v]) => safe(k) && typeof v === "string"))) out.push(`${c.id}: files maps relative paths of plain names to text`);
  for (const k of Object.keys(c)) if (!CELL_KEYS.includes(k)) out.push(`${c.id}: ${k} is no key of a cell (${CELL_KEYS.join(", ")})`);
  if (c.except !== undefined && (!isObject(c.except) || !Object.values(c.except).every((v) => typeof v === "string" && ["unread", "extra", "differs", "gap", "unmeasured", "stricter"].includes(v.split(":")[0])))) out.push(`${c.id}: except maps a location to "unread: …", "extra: …", "unmeasured: …", "stricter: …", "differs: …" or "gap: <node>"`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Recording: the machine's npm, loaded here only.

/** npm's own modules, from the npm on PATH. */
function npmModules() {
  const root = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "npm");
  const req = createRequire(join(root, "package.json"));
  const version = (/** @type {string} */ m) => JSON.parse(readFileSync(req.resolve(`${m}/package.json`), "utf8")).version;
  return {
    root,
    req,
    versions: { npm: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, arborist: version("@npmcli/arborist"), "npm-package-arg": version("npm-package-arg"), pacote: version("pacote"), "@npmcli/config": version("@npmcli/config") },
  };
}

/** The root package.json npm ci checks the lock against: the cell's, else the lock's root entry (v1: its top level). @param {Cell} c @param {any} lock */
function rootPackage(c, lock) {
  if (c.package !== undefined) return filled(c.package);
  if (!isObject(lock)) return {};
  const fields = ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "workspaces"];
  if (isObject(lock.packages)) {
    const top = isObject(lock.packages[""]) ? lock.packages[""] : {};
    return Object.fromEntries(fields.filter((f) => f in top).map((f) => [f, top[f]]));
  }
  /** @type {Record<string, Record<string, string>>} */
  const deps = {};
  for (const [name, v] of Object.entries(isObject(lock.dependencies) ? lock.dependencies : {})) {
    if (!isObject(v)) continue;
    const field = v.dev ? "devDependencies" : v.optional ? "optionalDependencies" : "dependencies";
    (deps[field] ??= {})[name] = typeof v.version === "string" ? v.version : "*";
  }
  return { name: typeof lock.name === "string" ? lock.name : "root", version: "1.0.0", ...deps };
}

/**
 * npm's reading of one cell, in a directory of its own.
 * @param {Cell} c @param {ReturnType<typeof npmModules>} m @returns {Promise<NpmReading>}
 */
async function npmReading(c, m) {
  const problems = cellProblems(c);
  if (problems.length) throw new Error(problems.join("; "));
  const R = realpathSync(mkdtempSync(join(tmpdir(), "en-ref-npm-")));
  try {
    const P = join(R, ...(c.lockDir ?? "").split("/").filter(Boolean));
    mkdirSync(P, { recursive: true });
    const text = lockTextOf(c);
    /** @type {any} */
    let lock = null;
    try {
      lock = JSON.parse(text);
    } catch {}
    writeFileSync(join(P, c.lockName ?? "package-lock.json"), text);
    // A cell's package.json given as text is written as it is (a byte order mark, an odd spacing).
    const pkg = rootPackage(c, lock);
    writeFileSync(join(P, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
    if (c.npmrc !== undefined) writeFileSync(join(P, ".npmrc"), filled(c.npmrc));
    for (const [path, body] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(R, path)), { recursive: true });
      writeFileSync(join(R, path), filled(body));
    }
    for (const f of ["user", "global"]) writeFileSync(join(R, `.${f}rc`), "");
    mkdirSync(join(R, ".npm-root"));
    const Config = m.req("@npmcli/config");
    const { definitions, flatten, shorthands } = m.req("@npmcli/config/lib/definitions");
    const argv = ["node", "npm", "ci", "--userconfig", join(R, ".userrc"), "--globalconfig", join(R, ".globalrc"), "--cache", join(R, ".cache"), "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
    const config = new Config({ npmPath: join(R, ".npm-root"), definitions, flatten, shorthands, argv, env: {}, cwd: P, execPath: process.execPath, platform: process.platform });
    /** @type {Record<string, NpmAt>} */
    const at = {};
    /** @type {string[]} */
    const asked = [];
    const npa = m.req("npm-package-arg");
    const { pickRegistry } = m.req("npm-registry-fetch");
    const pacote = m.req("pacote");
    const where = (/** @type {string} */ p) => {
      const r = relative(R, p).split(sep).join("/");
      return r.startsWith("..") || isAbsolute(r) ? OUTSIDE : r;
    };
    /** @type {Record<string, any>} */
    let opts = {};
    const saved = { extract: pacote.extract, manifest: pacote.manifest, packument: pacote.packument };
    /** A spec as kept: a path of this machine as the repository's (`<repo>/…`) or `<outside>`. @param {string} spec */
    const shown = (spec) => {
      const s = npa(spec);
      return s.type === "file" || s.type === "directory" ? `${s.name ?? ""}@${s.type}:${where(s.fetchSpec)}` : spec;
    };
    /** What npm reads in a spec it hands pacote (as npm parsed it, where it did). @param {any} spec @returns {NpmAt} */
    const reading = (spec) => {
      const s = typeof spec === "string" ? npa(spec) : spec;
      spec = String(s.raw);
      const real = s.type === "alias" ? s.subSpec : s;
      return real.type === "remote" ? { kind: "remote", url: real.fetchSpec, spec }
        : real.type === "git" ? { kind: "git", spec }
        : real.type === "file" || real.type === "directory" ? { kind: real.type, path: where(real.fetchSpec) }
        : { kind: "registry", name: real.name, version: real.fetchSpec, registry: pickRegistry(real, opts), spec };
    };
    /** @type {string[]} */
    let wrapped = [];
    pacote.extract = async (/** @type {string} */ spec, /** @type {string} */ dest) => {
      at[relative(P, dest).split(sep).join("/")] = reading(spec);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "package.json"), "{}");
      return {};
    };
    // npm asks for a manifest while it builds the tree: for every entry of a lock below version 2
    // (#inflateAncientLockfile), and for a dependency its entry does not satisfy (dep-valid.js). Asked of no
    // registry, and never answered from the input under test but where the question is the entry's own: its own
    // resolved, or a registry version or range of a registry entry its version satisfies, which is what the entry
    // was fetched as. Any other question is npm fetching the place anew from the spec's own source: that is its
    // reading of the place (`refetch`), and past it npm was not measured (`ci` "stand-in: …"). Each question is
    // kept in `asked`.
    /** @type {Map<string, any>} */
    let virtual = new Map();
    const semver = m.req("semver");
    /** Whether a question is the entry's own. @param {any} s @param {any} n */
    const own = (s, n) => {
      const real = s.type === "alias" ? s.subSpec : s;
      const held = n.resolved ? npa(n.resolved) : null;
      if (real.type === "version" || real.type === "range") return n.packageName === real.name && (!held || held.type === "remote") && semver.satisfies(n.version, real.fetchSpec, true);
      if (!held || held.type !== real.type) return false;
      if (real.type === "git") return (held.hosted && real.hosted ? held.hosted.ssh() === real.hosted.ssh() : held.fetchSpec === real.fetchSpec) && (held.gitCommittish ?? "") === (real.gitCommittish ?? "");
      return held.fetchSpec === real.fetchSpec;
    };
    /** @type {string[]} */
    let stood = [];
    pacote.manifest = async (/** @type {any} */ spec, /** @type {any} */ options) => {
      const s = typeof spec === "string" ? npa(spec) : spec;
      const raw = String(s.raw ?? spec);
      asked.push(shown(raw));
      // The question names the folder, not the place: one entry of the lock with that folder name is the place.
      const named = [...virtual.values()].filter((n) => !n.isProjectRoot && !n.isLink && n.name === s.name);
      const n = named.length === 1 ? named[0] : undefined;
      if (n && own(s, n)) return { ...n.package, name: n.packageName, version: n.version, _resolved: n.resolved, _integrity: n.integrity };
      // A directory in the repository is its own source: npm reads its package.json, and so does pacote here.
      if (s.type === "directory" && where(s.fetchSpec) !== OUTSIDE) return saved.manifest.call(pacote, spec, options);
      // A link's target is read at the link's place, where the gate judges it.
      if (n) for (const loc of n.linksIn?.size ? [...n.linksIn].map((l) => l.location) : [n.location]) at[loc] = { ...reading(s), refetch: true };
      stood = [...stood, shown(raw)];
      throw Object.assign(new Error("the stand-in does not answer"), { code: "ESTANDIN" });
    };
    pacote.packument = async (/** @type {any} */ spec) => {
      const raw = String(spec?.raw ?? spec);
      asked.push(shown(raw));
      stood = [...stood, shown(raw)];
      throw Object.assign(new Error("the stand-in does not answer"), { code: "ESTANDIN" });
    };
    let ci = "config";
    try {
      await config.load();
      // npm reads its flat options while it loads (lib/npm.js) and keeps them; it validates the config after, before
      // any command runs (lib/base-cmd.js), which cleans what it finds but changes nothing read already.
      opts = { ...config.flat, packageLock: true, path: P, save: false, workspaces: [] };
      config.validate();
      const Arborist = m.req("@npmcli/arborist");
      const validateLockfile = m.req("./lib/utils/validate-lockfile.js");
      const arb = new Arborist(opts);
      ci = "loadVirtual";
      await arb.loadVirtual();
      virtual = new Map(arb.virtualTree.inventory);
      for (const n of virtual.values()) if (n.inDepBundle) at[n.location] = { kind: "bundled" };
      // An entry that carries its own npm-shrinkwrap.json has npm install what that file names under it, from the
      // tarball the stand-in does not have: past it, nothing is measured.
      wrapped = [...virtual.values()].filter((n) => n.hasShrinkwrap && !n.isProjectRoot).map((n) => n.location).sort();
      ci = "buildIdealTree";
      await arb.buildIdealTree();
      const errors = validateLockfile(virtual, arb.idealTree.inventory);
      ci = "validateLockfile";
      if (errors.length) throw new Error(errors[0]);
      ci = "reify";
      await arb.reify(opts);
      for (const n of arb.actualTree.inventory.values()) if (n.isLink) at[n.location] = { kind: "link", path: where(n.realpath) };
      // npm went on past a question the stand-in did not answer (an optional dependency): not npm's own run.
      if (stood.length) throw Object.assign(new Error("the stand-in does not answer"), { code: "ESTANDIN" });
      ci = "ok";
    } catch (e) {
      if (/** @type {any} */ (e)?.code === "ESTANDIN" || stood.length) {
        // The stand-in stopped npm, not npm: what was read before (bundles, the place fetched anew) is kept.
        for (const [k, v] of Object.entries(at)) if (v.kind !== "bundled" && !v.refetch) delete at[k];
        ci = `stand-in: ${ci}: ${stood[0] ?? "no answer"}`;
      } else {
        // npm stopped: what it would have installed is nothing; the step and the error's first line are kept.
        for (const k of Object.keys(at)) delete at[k];
        ci = `${ci}: ${String(/** @type {any} */ (e)?.code ?? /** @type {Error} */ (e)?.message ?? e).split("\n")[0].replace(R, "<repo>")}`;
      }
    } finally {
      Object.assign(pacote, saved);
    }
    return { ci, at: Object.fromEntries(Object.entries(at).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), ...(wrapped.length ? { wrapped } : {}), ...(asked.length ? { asked: [...new Set(asked)].sort() } : {}) };
  } finally {
    rmSync(R, { recursive: true, force: true });
  }
}

/** Every cell read by the machine's npm, one at a time. @param {Cell[]} cells */
export async function readAll(cells) {
  const m = npmModules();
  /** @type {Cell[]} */
  const out = [];
  for (const c of cells) out.push({ ...c, npm: await npmReading(c, m) });
  return { versions: m.versions, cells: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  const rec = readRecord();
  if (cmd === "add" && args[0]) {
    const probes = JSON.parse(readFileSync(args[0], "utf8"));
    const ids = new Set(rec.cells.map((c) => c.id));
    const problems = (Array.isArray(probes) ? probes : [null]).flatMap((p) => [...cellProblems(p), ...(p && ids.has(p.id) ? [`${p.id}: recorded already`] : []), ...(p && "npm" in p ? [`${p.id}: npm's reading is recorded, never given`] : [])]);
    if (problems.length) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exit(1);
    }
    const { versions, cells } = await readAll(probes);
    if (rec.cells.length && JSON.stringify(versions) !== JSON.stringify(rec.npm)) {
      process.stderr.write(`the record is npm ${JSON.stringify(rec.npm)}, this machine's ${JSON.stringify(versions)}: take the record again first (record)\n`);
      process.exit(1);
    }
    writeFileSync(RECORD, recordText({ npm: versions, cells: [...rec.cells, ...cells] }));
    for (const c of cells) process.stdout.write(`added ${c.id}: ${c.npm?.ci}\n`);
  } else if (cmd === "show") {
    for (const c of rec.cells.filter((x) => !args.length || args.includes(x.id))) {
      process.stdout.write(`${c.id} (npm ci: ${c.npm?.ci})\n`);
      for (const [k, r] of compare(c)) process.stdout.write(`  ${r.relation.padEnd(7)} ${k}  gate: ${r.claim ? `${r.claim.verdict} ${JSON.stringify({ ...r.claim, verdict: undefined, reads: undefined })}` : "—"}  npm: ${r.npm ? JSON.stringify(r.npm) : "—"}${c.except?.[k] ?? c.except?.["*"] ? `  [${c.except?.[k] ?? c.except?.["*"]}]` : ""}\n`);
    }
  } else if (cmd === "check" || cmd === "record") {
    const { versions, cells } = await readAll(rec.cells);
    const moved = cells.filter((c, i) => JSON.stringify(c.npm) !== JSON.stringify(rec.cells[i].npm));
    const bumped = JSON.stringify(versions) !== JSON.stringify(rec.npm);
    if (cmd === "record") {
      writeFileSync(RECORD, recordText({ npm: versions, cells }));
      process.stdout.write(`recorded ${cells.length} cell(s) with npm ${versions.npm}; ${moved.length} reading(s) moved: ${moved.map((c) => c.id).join(", ") || "none"}\n`);
    } else {
      if (bumped) process.stdout.write(`the record is npm ${JSON.stringify(rec.npm)}, this machine has ${JSON.stringify(versions)}\n`);
      for (const c of moved) process.stdout.write(`${c.id}: npm now reads ${JSON.stringify(c.npm)}\n  recorded ${JSON.stringify(rec.cells[rec.cells.indexOf(rec.cells.find((x) => x.id === c.id) ?? c)].npm)}\n`);
      // The places npm was not measured at are counted, never clean: more than the record holds fails.
      const unmeasured = unmeasuredOf(cells);
      const grew = unmeasured > (rec.unmeasured ?? 0);
      process.stdout.write(bumped || moved.length ? "take the record again (node test/reference/npm.mjs record), then run test/reference.test.mjs: it shows the comparisons that moved\n" : `npm ${versions.npm} reads all ${cells.length} cell(s) as recorded\n`);
      process.stdout.write(`${unmeasured} place(s) npm was not measured at (the stand-in could not answer, or an entry carries its own shrinkwrap), ${grew ? `more than the ${rec.unmeasured ?? 0} the record holds` : `as many as the record holds`}: those are not checked\n`);
      process.exitCode = bumped || moved.length || grew ? 1 : 0;
    }
  } else {
    process.stderr.write("usage: node test/reference/npm.mjs add <probes.json> | show [id…] | check | record\n");
    process.exit(2);
  }
}
