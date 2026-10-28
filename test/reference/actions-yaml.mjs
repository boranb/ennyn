/**
 * Reference differential for security.ci's YAML reader (checks/ci.mjs `yamlRead`): what GitHub makes of a workflow
 * file, recorded by GitHub's own code, and what the hook refuses for, place by place. Cycle 2026-10-24 (9) found
 * nine reader defects in four review rounds, all after the first fix; cycle 13 found the same class twice more, and
 * the pin held only once the record ran the other program's own code. Here GitHub's parser gives the expected values.
 *
 * The parser is the workflow parser in actions/runner (src/Sdk/WorkflowParser, namespace GitHub.Actions.WorkflowParser,
 * added by PR 4092 in November 2025): `YamlObjectReader` on YamlDotNet's `Parser` (YamlDotNet.Signed 5.3.0, the SDK's
 * own reference), with anchors allowed, as github.com allows them since 2025-09-18 (changelog "Actions: YAML anchors
 * and non-public workflow templates"), and `WorkflowTemplateParser.LoadWorkflow` for the errors it finds in the file
 * as a workflow. It is pinned to the runner's release v2.338.0 (2026-10-06), by commit and by the git tree ids of the
 * files the build reads, which git checks as it fetches them; its NuGet packages by test/reference/actions-yaml/
 * packages.lock.json (restore in locked mode checks each package's hash); the .NET SDK image by its digest (the
 * release's src/global.json names 8.0.425). That github.com runs this same code is not provable from outside: the
 * runner ships it, the service does not say. Merge keys (`<<`), which YAML 1.2 does not have, are a plain key here,
 * and the workflow refuses one where a step or a job is read.
 *
 * Recording needs docker. The source is fetched with git (through core/git.mjs, no variable of a hook's environment)
 * into a new temporary directory. The probe (test/reference/actions-yaml/Program.cs, named Test: the SDK opens its
 * internals to that name) is restored in a container that may reach NuGet, built in one that reaches nothing, and run
 * in a third that reaches nothing, each with no capabilities and a read-only root, the volume read-only for the run:
 * it gets the texts on stdin and gives the readings back on stdout. NuGet's audit stays on; audit-suppress.targets
 * names the two advisories of the runner's own pins, so any other fails the restore. The test
 * (test/reference.test.mjs) reads the record and needs neither docker nor the network.
 *
 * Each cell is a workflow's text. GitHub's reading (`github`): `yaml` the document as the reader gives it (a mapping
 * `{l, m: [[key, value]…]}`, a sequence `{l, q: […]}`, a scalar `{l, t, v}`: t s string, b boolean, n number, 0
 * null; aliases replayed; l the line), or `yamlError` when it reads none; `workflow` the errors of the file as a
 * workflow (none: GitHub runs it). The comparison (`judge`) takes GitHub's side from the document alone
 * (`githubPlaces`: its structure walked here, with only the hook's tests on a text, a pinned uses, a pull request's
 * ref, a run's commands, shared) and Ennyn's from its reading and rules (`ennynPlaces`), place by place (a step by its
 * index in its job's steps), in both of the hook's modes: a workflow, and a callee a pull_request_target workflow
 * reaches. The five leaf tests on a text are one known shared blind spot: they read shell, which no YAML record
 * holds (GitHub gives a run's text, not what the shell does with it), so the record cannot judge them; they are
 * held by their own tests in test/ci.test.mjs and the verdicts, and fail closed (every shell's continuation joined, git's
 * own options skipped, Windows paths read). One relation:
 *   agree      the same places, and Ennyn's reading follows every form
 *   unparsed   GitHub reads no document: nothing runs, whatever Ennyn says
 *   refused    Ennyn's reading says a form it cannot follow: the hook refuses the file
 *   stricter   Ennyn's places hold all of GitHub's and more: refused where GitHub's reading would pass
 *   differs    GitHub's document gives a place Ennyn's does not: the hook passes what it should refuse
 * A cell whose relation is not agree or unparsed says why in `except`: `refused: …`, `stricter: …`, and for a
 * differs `gap: <open node>`, or `invalid: …` when GitHub refuses the workflow (it runs nothing).
 *
 *   node test/reference/actions-yaml.mjs add <probes.json>   record new cells ([{ id, from, text, except? }])
 *   node test/reference/actions-yaml.mjs show [id…]          each cell's comparison
 *   node test/reference/actions-yaml.mjs check               exit 1 when GitHub's parser reads a cell otherwise
 *   node test/reference/actions-yaml.mjs record              take every reading again
 * `npm run test:reference` runs `check`.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNNER_HEAD, ciFindingsOf, clones, holdsRef, localPath, pinnedUses, runFetches, workspaceDir, yamlRead } from "../../checks/ci.mjs";
import { git as gitCall } from "../../core/git.mjs";
import { shown } from "../../core/i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "actions-yaml.json");
const PROBE = join(HERE, "actions-yaml");
const CELL_KEYS = ["id", "from", "text", "github", "except"];
export const RELATIONS = /** @type {const} */ (["agree", "unparsed", "refused", "stricter", "differs"]);
/** A cell's id: plain words, so no id puts a control byte on the terminal. */
const ID = /^[a-z0-9][a-z0-9-]*$/;
/** The longest cell. */
const CELL_TEXT = 16 * 1024;

/**
 * The parser, pinned: the runner's release, its commit, the git ids of what the build reads, the SDK image by
 * digest. YamlDotNet's version is the SDK project's (src/Sdk/Sdk.csproj) and its hash the lock file's.
 */
export const PARSER = Object.freeze({
  repo: "https://github.com/actions/runner.git",
  release: "v2.338.0",
  commit: "197ca027b90de199464dee3bb9ff198a1db60967",
  trees: Object.freeze({
    "src/Sdk": "d38ee95dd3020f399b23b7ed927b26e78ba5b4df",
    "src/global.json": "5821cb3638a253fb2dff4284890faf4659f358a6",
    "src/Directory.Build.props": "9c069b12f6f6f872343b8d831871219ec923ffae",
    "src/NuGet.Config": "95143bd09a803cc97861d9c000a329e8cad323c5",
  }),
  yamlDotNet: "YamlDotNet.Signed 5.3.0",
  image: "mcr.microsoft.com/dotnet/sdk:8.0.425-bookworm-slim@sha256:ec9c0a0dc5f60adc2065762050638dd5ed5facfc53716d4580a42d86027c8e80",
});

/** The parser as the record names it. */
export const parserName = () => `actions/runner ${PARSER.release} (${PARSER.commit}) WorkflowParser, ${PARSER.yamlDotNet}`;

/**
 * @typedef {{ l: number, m?: [Node, Node][], q?: Node[], t?: string, v?: string }} Node
 * @typedef {{ yaml?: Node, yamlError?: string, workflow: string[] }} GitHubReading
 * @typedef {{ id: string, from: string, text: string, github?: GitHubReading, except?: string }} Cell
 * @typedef {{ parser: string, cells: Cell[] }} Record
 * @typedef {{ relation: typeof RELATIONS[number], ennyn: string, github: string }} Comparison
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A cell's name for a message: its id, or the id quoted when it is no plain id. @param {any} c */
const nameOf = (c) => (typeof c?.id === "string" && ID.test(c.id) ? c.id : JSON.stringify(c?.id));

// ---------------------------------------------------------------------------------------------------------
// The comparison.

/** @param {Node | undefined} x */
const isMap = (x) => x !== undefined && x.m !== undefined;
/** @param {Node | undefined} x */
const isSeq = (x) => x !== undefined && x.q !== undefined;
/** @param {Node | undefined} x */
const isScalar = (x) => x !== undefined && x.m === undefined && x.q === undefined;
/** A scalar's text, null for YAML's null, undefined for a collection. @param {Node | undefined} x */
const text = (x) => (isScalar(x) ? (/** @type {Node} */ (x).t === "0" ? null : String(/** @type {Node} */ (x).v)) : undefined);
/** Every value of `key` in a mapping, in order. @param {Node | undefined} m @param {string} key */
const all = (m, key) => (isMap(m) ? /** @type {[Node, Node][]} */ (/** @type {Node} */ (m).m).filter(([k]) => isScalar(k) && String(k.v) === key).map(([, v]) => v) : []);
/** A mapping's scalar keys with their values. @param {Node | undefined} m */
const pairsOf = (m) => (isMap(m) ? /** @type {[Node, Node][]} */ (/** @type {Node} */ (m).m).filter(([k]) => isScalar(k)).map(([k, v]) => /** @type {[string, Node]} */ ([String(k.v), v])) : []);
/**
 * Every key and value anywhere below `x`, with the keys above it.
 * @param {Node | undefined} x @param {string[]} [trail]
 * @returns {Generator<[string, Node, string[]]>}
 */
function* walk(x, trail = []) {
  for (const [k, v] of pairsOf(x)) {
    yield [k, v, trail];
    yield* walk(v, [...trail, k]);
  }
  for (const v of isSeq(x) ? /** @type {Node[]} */ (/** @type {Node} */ (x).q) : []) yield* walk(v, trail);
}

/**
 * What the hook refuses a workflow for, place by place, from GitHub's own document and nothing of Ennyn's reader
 * or rule but the leaf tests on a text (a pinned uses, a pull request's ref, a run's commands): the trigger; a job
 * with no permissions, a write-all; each step's or job's unpinned `uses` by its job and its place in the steps (a
 * local path counts as unpinned when an earlier step placed another repository's code over it); each local callee;
 * with the trigger, or `targeted` (a callee a pull_request_target workflow reaches), each place that checks out the
 * pull request's code. Places are `<job>#<step>`, the step's index in its job's steps, or the keys above it.
 * @param {Node} doc @param {{ targeted?: boolean }} [opts]
 */
export function githubPlaces(doc, { targeted: forced = false } = {}) {
  /** @type {Set<string>} */
  const out = new Set();
  const trigger = (/** @type {string | null | undefined} */ s) => /^pull_request_target$/i.test(s ?? "");
  let targeted = false;
  for (const on of all(doc, "on")) {
    if (trigger(text(on)) || (isSeq(on) && /** @type {Node[]} */ (on.q).some((x) => trigger(text(x)))) || pairsOf(on).some(([k]) => trigger(k))) targeted = true;
  }
  if (targeted && !forced) out.add("pull_request_target");
  const top = all(doc, "permissions");
  if (top.length && text(top[0]) === "write-all") out.add("write-all (top)");
  /** @type {Map<Node, string>} where each step's and job's places are */
  const where = new Map();
  const seen = new Set();
  for (const [job, j] of all(doc, "jobs").flatMap(pairsOf)) {
    where.set(j, `${job}#-`);
    if (!seen.has(job)) {
      seen.add(job);
      const own = all(j, "permissions");
      if (own.length && text(own[0]) === "write-all") out.add(`write-all ${job}`);
      if (!top.length && !own.length) out.add(`unpermitted ${job}`);
    }
    const steps = all(j, "steps").flatMap((s) => (isSeq(s) ? /** @type {Node[]} */ (s.q) : []));
    /** @type {{ k: number, dir: string }[]} */
    const loose = [];
    steps.forEach((st, k) => {
      where.set(st, `${job}#${k}`);
      for (const [key, v] of walk(st)) {
        if (key === "with") {
          const repo = text(all(v, "repository")[0]);
          if (repo && !/^\$\{\{\s*github\.(?:repository|event\.pull_request\.head\.repo\.full_name)\s*\}\}$/i.test(repo) && !/^[0-9a-f]{40}$/.test(text(all(v, "ref")[0]) ?? "")) {
            const dir = workspaceDir(text(all(v, "path")[0]) ?? "");
            if (dir !== null) loose.push({ k, dir });
          }
        }
        const run = key === "run" ? text(v) : null;
        if (run) for (const c of clones(run.split("\n"))) {
          const dir = workspaceDir(c.dir);
          if (dir !== null) loose.push({ k, dir });
        }
      }
    });
    const under = (/** @type {number} */ k, /** @type {string} */ p) => loose.some((l) => l.k < k && (l.dir === "" || p === l.dir || p.startsWith(`${l.dir}/`)));
    const uses = (/** @type {Node} */ u, /** @type {string} */ at, /** @type {number} */ k) => {
      const v = text(u) ?? null;
      if (v === null || !pinnedUses(v) || (k >= 0 && v.startsWith("./") && under(k, localPath(v)))) out.add(`unpinned ${at}`);
      if (v?.startsWith("./")) out.add(`callee ${localPath(v)}`);
    };
    for (const u of all(j, "uses")) uses(u, `${job}#-`, -1);
    steps.forEach((st, k) => all(st, "uses").forEach((u) => uses(u, `${job}#${k}`, k)));
  }
  if (targeted || forced) {
    const tainted = new Set(RUNNER_HEAD);
    for (const [key, v] of walk(doc)) if (key === "env") for (const [name, x] of pairsOf(v)) if (holdsRef(text(x) ?? "", new Set())) tainted.add(name);
    /** The step or job a value is in, else the keys above it. @param {Node} x @param {string[]} trail */
    const placeOf = (x, trail) => {
      for (const [node, at] of [...where].reverse()) if (node === x || [...walk(node)].some(([, v]) => v === x)) return at;
      return trail.join(".") || "(top)";
    };
    for (const [key, v, trail] of walk(doc)) {
      const s = text(v);
      if (!s) continue;
      if ((key === "ref" || key === "repository") && holdsRef(s, tainted)) out.add(`pwn ${placeOf(v, trail)} ${key}`);
      if (key === "allow-unsafe-pr-checkout" && /^(true|yes|on|y)$/i.test(s)) out.add(`pwn ${placeOf(v, trail)} ${key}`);
      if (key === "run" && runFetches(s.split("\n"), new Set(tainted)).length) out.add(`pwn ${placeOf(v, trail)} run`);
    }
  }
  return out;
}

/**
 * The same places from Ennyn's reading and its rules (ciFindingsOf): a finding's step is the sequence item its
 * entry is in, counted among its job's steps in reading order.
 * @param {ReturnType<typeof yamlRead>} read @param {{ targeted?: boolean }} [opts]
 */
export function ennynPlaces(read, { targeted = false } = {}) {
  const f = ciFindingsOf(read, "workflow", { targeted });
  /** @type {Map<string, Map<number, number>>} each job's steps: item → index */
  const steps = new Map();
  for (const e of read.entries) {
    if (e.path[0] !== "jobs" || e.path[2] !== "steps" || !e.item) continue;
    if (!((e.path.length === 3 && e.key === null) || (e.path.length === 4 && e.key === e.path[3]))) continue;
    const own = steps.get(String(e.path[1])) ?? steps.set(String(e.path[1]), new Map()).get(String(e.path[1]));
    if (!own?.has(e.item)) own?.set(e.item, own.size);
  }
  const placeOf = (/** @type {number} */ at) => {
    const e = read.entries[at];
    if (e.path[0] !== "jobs" || e.path.length < 3) return e.path.slice(0, -1).join(".") || "(top)";
    const job = String(e.path[1]);
    if (e.path[2] !== "steps") return `${job}#-`;
    const k = steps.get(job)?.get(e.item);
    return `${job}#${k ?? "?"}`;
  };
  /** @type {Set<string>} */
  const out = new Set();
  if (f.targeted && !targeted) out.add("pull_request_target");
  for (const w of f.writeAll) out.add(w.where ? `write-all ${w.where}` : "write-all (top)");
  for (const j of f.unpermitted) out.add(`unpermitted ${j.job}`);
  for (const u of f.uses) if (!u.pinned) out.add(`unpinned ${placeOf(u.at)}`);
  for (const c of f.callees) out.add(`callee ${c.path}`);
  for (const p of f.pwn) out.add(`pwn ${placeOf(p.at)} ${read.entries[p.at].key}`);
  return out;
}

/**
 * A cell compared, in both of the hook's modes (a workflow, and a callee a pull_request_target workflow reaches):
 * GitHub's places from its document, Ennyn's from its reading.
 * @param {Cell} c @param {(text: string) => ReturnType<typeof yamlRead>} [read] Ennyn's reader
 * @returns {Comparison}
 */
export function judge(c, read = yamlRead) {
  const g = /** @type {GitHubReading} */ (c.github);
  const mine = read(c.text);
  const unread = mine.unread.map((u) => u.what);
  const list = (/** @type {Set<string>} */ s) => [...s].sort().join(", ") || "nothing";
  const modes = /** @type {const} */ ([false, true]).map((targeted) => ({ targeted, ours: ennynPlaces(mine, { targeted }), theirs: g.yaml ? githubPlaces(g.yaml, { targeted }) : new Set() }));
  const say = (/** @type {"ours" | "theirs"} */ side) => modes.map((m) => `${m.targeted ? "callee" : "workflow"}: ${list(m[side])}`).join("; ");
  const ennyn = unread.length ? `unread: ${unread.join("; ")}` : say("ours");
  if (!g.yaml) return { relation: "unparsed", ennyn, github: g.yamlError ?? "no document" };
  const github = say("theirs");
  if (unread.length) return { relation: "refused", ennyn, github };
  if (modes.some((m) => [...m.theirs].some((p) => !m.ours.has(p)))) return { relation: "differs", ennyn, github };
  return { relation: modes.some((m) => [...m.ours].some((p) => !m.theirs.has(p))) ? "stricter" : "agree", ennyn, github };
}

/**
 * The cells whose comparison is not what the cell says, each as a line; none when the record holds. A relation
 * other than agree or unparsed is listed in `except` with its why; a differs names the open graph node that will
 * close it (`gap: <node>`), or says GitHub refuses the workflow (`invalid: …`, only where it does).
 * @param {Cell[]} cells @param {Set<string>} [openNodes] the graph's open node ids
 * @param {(text: string) => ReturnType<typeof yamlRead>} [read]
 */
export function moves(cells, openNodes, read = yamlRead) {
  /** @type {string[]} */
  const out = [];
  // Quoted, control and format characters escaped: the texts come from the cells.
  const q = (/** @type {unknown} */ x) => `"${shown(String(x)).text}"`;
  for (const c of cells) {
    const id = nameOf(c);
    const got = judge(c, read);
    const [rel, ...rest] = (c.except ?? "agree").split(":");
    const why = rest.join(":").trim();
    if (c.except !== undefined && !why) out.push(`${id}: ${q(c.except)} gives no why`);
    if (rel === "gap" && openNodes && !openNodes.has(why)) out.push(`${id}: names no open graph node: ${q(why)}`);
    if (rel === "invalid" && !c.github?.workflow.length) out.push(`${id}: invalid, but GitHub runs the workflow`);
    const want = rel === "gap" || rel === "invalid" ? "differs" : rel;
    if (got.relation === "unparsed" && c.except === undefined) continue;
    if (want !== got.relation) out.push(`${id}: ${got.relation}, recorded ${want} — Ennyn ${q(got.ennyn)}, GitHub ${q(got.github)}`);
  }
  return out;
}

/** What a cell must hold; each problem as a line. @param {any} c */
export function cellProblems(c) {
  /** @type {string[]} */
  const out = [];
  if (!isObject(c)) return ["a cell is an object"];
  if (typeof c.id !== "string" || !ID.test(c.id)) return [`id ${JSON.stringify(c.id)} is no plain id (a-z, 0-9, -)`];
  if (typeof c.from !== "string" || !c.from) out.push(`${c.id}: no from`);
  if (typeof c.text !== "string") out.push(`${c.id}: text is the workflow's text`);
  else if (c.text.length > CELL_TEXT) out.push(`${c.id}: text past ${CELL_TEXT} characters`);
  for (const k of Object.keys(c)) if (!CELL_KEYS.includes(k)) out.push(`${c.id}: ${JSON.stringify(k)} is no key of a cell (${CELL_KEYS.join(", ")})`);
  const g = c.github;
  if (g !== undefined && !(isObject(g) && Array.isArray(g.workflow) && g.workflow.every((/** @type {unknown} */ e) => typeof e === "string") && (isObject(g.yaml) !== (typeof g.yamlError === "string")))) out.push(`${c.id}: github is { yaml | yamlError, workflow: [errors] }`);
  if (c.except !== undefined && !(typeof c.except === "string" && ["refused", "stricter", "gap", "invalid"].includes(c.except.split(":")[0]))) out.push(`${c.id}: except is "refused: …", "stricter: …", "gap: <node>" or "invalid: …"`);
  return out;
}

/** The record. @returns {Record} */
export function readRecord(path = RECORD) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The record as written: its header, then one cell a line, so a diff shows the cells that moved. @param {Record} rec */
export function recordText(rec) {
  const cells = rec.cells.map((c) => `    ${JSON.stringify(Object.fromEntries(CELL_KEYS.filter((k) => k in c).map((k) => [k, /** @type {any} */ (c)[k]])))}`);
  return `{\n  "parser": ${JSON.stringify(rec.parser)},\n  "cells": [\n${cells.join(",\n")}\n  ]\n}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// Recording: GitHub's parser, built from its pinned source and run where it can reach nothing.

/** @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [opts] */
const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000, ...opts });

/**
 * A git call of the recorder's, through core/git.mjs: with no GIT_DIR, GIT_WORK_TREE or other variable a hook's
 * environment leaks into it, no prompt, and a time limit. @param {string[]} args @param {string} cwd
 */
const git = (args, cwd) => gitCall(args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, walk: true });

/**
 * The pinned source in `dir`/runner: only the files the build reads, each held to its git id.
 * @param {string} dir
 */
export function fetchSource(dir) {
  const repo = join(dir, "runner");
  git(["init", "-q", repo], dir);
  git(["remote", "add", "origin", PARSER.repo], repo);
  git(["-c", "protocol.version=2", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", PARSER.commit], repo);
  git(["sparse-checkout", "set", "--no-cone", ...Object.keys(PARSER.trees).map((p) => `/${p}${p.includes(".") ? "" : "/"}`)], repo);
  git(["checkout", "-q", PARSER.commit], repo);
  for (const [p, id] of Object.entries(PARSER.trees)) {
    const got = git(["rev-parse", `${PARSER.commit}:${p}`], repo);
    if (got !== id) throw new Error(`${p} at ${PARSER.commit} is ${got}, pinned ${id}`);
  }
  rmSync(join(repo, ".git"), { recursive: true, force: true });
}

/**
 * GitHub's reading of each text, by the pinned parser: built in a container that may reach NuGet, run in one that
 * reaches nothing. Throws when docker, the build or the run fails.
 * @param {{ id: string, text: string }[]} cells
 * @returns {Map<string, GitHubReading>}
 */
export function readAll(cells) {
  const up = docker(["version", "--format", "{{.Server.Version}}"]);
  if (up.status !== 0) throw new Error(`docker is not running, so nothing was read: ${(up.stderr || up.error?.message || "").trim().split("\n")[0]}`);
  const dir = mkdtempSync(join(tmpdir(), "ennyn-actions-yaml-"));
  const volume = `ennyn-actions-yaml-${process.pid}-${Date.now()}`;
  const env = ["-e", "DOTNET_CLI_TELEMETRY_OPTOUT=1", "-e", "DOTNET_NOLOGO=1", "-e", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"];
  try {
    fetchSource(dir);
    cpSync(PROBE, join(dir, "probe"), { recursive: true });
    const tar = spawnSync("tar", ["--no-xattrs", "-C", dir, "-cf", "-", "runner", "probe"], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    if (tar.status !== 0) throw new Error(`tar: ${String(tar.stderr).trim()}`);
    if (docker(["volume", "create", volume]).status !== 0) throw new Error(`docker volume create ${volume} failed`);
    // Only the restore reaches the network (NuGet, in locked mode); the build and the probe reach nothing. Every
    // container has no capabilities and a read-only root. NuGet's audit stays on: audit-suppress.targets names
    // the two advisories of the runner's own pins, so a new one fails the build.
    const box = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp", "-e", "HOME=/tmp", "-e", "DOTNET_CLI_HOME=/tmp", "-e", "NUGET_PACKAGES=/work/nuget", ...env];
    const suppress = "-p:CustomBeforeMicrosoftCommonTargets=/work/probe/audit-suppress.targets";
    const restored = docker(["run", "--rm", "-i", ...box, "-v", `${volume}:/work`, PARSER.image, "sh", "-c", `cd /work && tar --no-same-owner -xf - && cd probe && dotnet restore --locked-mode ${suppress}`], { input: tar.stdout, encoding: "buffer" });
    if (restored.status !== 0) throw new Error(`the restore failed: ${shown(String(restored.stdout).trim().split("\n").slice(-5).join(" | ")).text}`);
    const built = docker(["run", "--rm", "--network", "none", ...box, "-v", `${volume}:/work`, PARSER.image, "sh", "-c", `cd /work/probe && dotnet build -c Release --no-restore ${suppress}`], { encoding: "buffer" });
    if (built.status !== 0) throw new Error(`the build failed: ${shown(String(built.stdout).trim().split("\n").slice(-5).join(" | ")).text}`);
    const run = docker(["run", "--rm", "-i", "--network", "none", ...box, "-v", `${volume}:/work:ro`, PARSER.image, "dotnet", "/work/probe/bin/Release/net8.0/Test.dll"], { input: JSON.stringify(cells.map(({ id, text }) => ({ id, text }))) });
    if (run.status !== 0) throw new Error(`the probe failed: ${(run.stderr || "").trim().split("\n").slice(0, 5).join("\n")}`);
    /** @type {Map<string, GitHubReading>} */
    const out = new Map();
    for (const r of JSON.parse(run.stdout)) out.set(r.id, { ...(r.yaml ? { yaml: r.yaml } : { yamlError: r.yamlError }), workflow: r.workflow });
    if (out.size !== new Set(cells.map((c) => c.id)).size) throw new Error(`the probe read ${out.size} of ${cells.length} cell(s)`);
    return out;
  } finally {
    docker(["volume", "rm", "-f", volume]);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  /** A cell's text on one line, control and format characters escaped. @param {string} s */
  const say = (s) => shown(s).text;
  /** @type {Record} */
  const rec = readRecord();
  const write = (/** @type {Cell[]} */ cells) => writeFileSync(RECORD, recordText({ parser: parserName(), cells }));
  const problems = rec.cells.flatMap(cellProblems);
  if (rec.parser !== parserName()) problems.push(`the record names ${JSON.stringify(rec.parser)}, the pin ${JSON.stringify(parserName())}: take the record again`);
  if (problems.length && cmd !== "record") {
    process.stderr.write(`${say(problems.join(" | "))}\n`);
    process.exit(1);
  }
  const read = (/** @type {Cell[]} */ cells) => {
    try {
      return readAll(cells);
    } catch (e) {
      process.stderr.write(`${say(/** @type {Error} */ (e).message)}\n`);
      process.exit(1);
    }
  };
  if (cmd === "add" && args[0]) {
    const probes = JSON.parse(readFileSync(args[0], "utf8"));
    const ids = new Set(rec.cells.map((c) => c.id));
    const texts = new Set(rec.cells.map((c) => c.text));
    const refused = (Array.isArray(probes) ? probes : [null]).flatMap((p) => [...cellProblems(p), ...(p && ids.has(p.id) ? [`${nameOf(p)}: recorded already`] : []), ...(p && texts.has(p.text) ? [`${nameOf(p)}: its text is recorded already`] : []), ...(p && "github" in p ? [`${nameOf(p)}: GitHub's reading is recorded, never given`] : [])]);
    if (refused.length) {
      process.stderr.write(`${say(refused.join(" | "))}\n`);
      process.exit(1);
    }
    const got = read(probes);
    const cells = probes.map((/** @type {Cell} */ p) => ({ ...p, github: got.get(p.id) }));
    write([...rec.cells, ...cells]);
    for (const c of cells) {
      const r = judge(c);
      process.stdout.write(`${say(`added ${c.id}: ${r.relation}  Ennyn: ${r.ennyn}  GitHub: ${r.github}${c.github?.workflow.length ? `  (workflow: ${c.github.workflow[0]})` : ""}`)}\n`);
    }
  } else if (cmd === "show") {
    for (const c of rec.cells.filter((x) => !args.length || args.includes(x.id))) {
      const r = judge(c);
      if (r.relation !== "agree" || args.length) process.stdout.write(`${say(`${c.id} ${r.relation}${c.except ? ` [${c.except}]` : ""}`)}\n  Ennyn: ${say(r.ennyn)}\n  GitHub: ${say(r.github)}${c.github?.workflow.length ? `\n  workflow: ${say(c.github.workflow.join(" | "))}` : ""}\n`);
    }
  } else if (cmd === "check" || cmd === "record") {
    const got = read(rec.cells);
    const moved = rec.cells.filter((c) => JSON.stringify(got.get(c.id)) !== JSON.stringify(c.github));
    if (cmd === "record") {
      write(rec.cells.map((c) => ({ ...c, github: got.get(c.id) })));
      process.stdout.write(`recorded ${rec.cells.length} cell(s) with ${parserName()}; ${moved.length} reading(s) moved: ${say(moved.map((c) => c.id).join(", ")) || "none"}\n`);
    } else {
      for (const c of moved) process.stdout.write(`${say(c.id)}: GitHub's parser now reads ${say(JSON.stringify(got.get(c.id)))}\n  recorded ${say(JSON.stringify(c.github))}\n`);
      process.stdout.write(moved.length ? "take the record again (node test/reference/actions-yaml.mjs record), then run test/reference.test.mjs: it shows the comparisons that moved\n" : `${parserName()} reads all ${rec.cells.length} cell(s) as recorded\n`);
      process.exitCode = moved.length ? 1 : 0;
    }
  } else {
    process.stderr.write("usage: node test/reference/actions-yaml.mjs add <probes.json> | show [id…] | check | record\n");
    process.exit(2);
  }
}
