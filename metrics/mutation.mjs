/**
 * Hand-picked mutants, run one at a time against the project's test command (`ennyn mutate`). A project
 * with no mutation tool has the cycle pick mutants of the changed lines by hand; this runs them.
 *
 * A mutant is `{ id, file, old, new }`; `old` occurs exactly once in the file. The tests first run with
 * no mutant and must pass, or every mutant would read as killed. Then, per mutant: apply, check that the
 * file still parses, run the tests, put the file back byte for byte. A mutant that does not parse is
 * invalid, never killed. Killed / total counts only files a parse check read: in a file none reads, a
 * failing run may be a mutant that does not parse, so its kills and survivors are counted apart. A
 * mutant still running at the timeout counts as killed once it ran out a second, doubled timeout too:
 * on a loaded machine a slow run is no kill.
 *
 * Why (cycle 2026-10-19): an ad-hoc runner split mutants on "|" and counted syntax errors as kills; two
 * commit Mutation lines were rewritten before push.
 *
 * Files change in place. While a run lasts, a journal in the state dir holds its pid and, while a mutant
 * is applied, the file's original bytes. Any way the process ends (a signal, an exit, a closed pipe) puts
 * the file back; a run killed outright is undone by the next one, or by `--restore`, but only while the
 * file still holds the mutant: a file changed since is left alone and reported. Each write moves the
 * file's mtime to a new whole second: caches keyed by size and mtime (Python's bytecode) would otherwise
 * run a mutant after the source is back.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { commonDir, resolveStateDir } from "../core/git.mjs";

/** @typedef {{ id: string, file: string, old: string, new: string }} Mutant */
/** @typedef {"killed" | "timeout" | "survived" | "invalid" | "unchecked" | "unapplied"} Outcome */
/** @typedef {{ key: string, vars?: Record<string, string | number> }} Reason */
/**
 * @typedef {{ id: string, file: string, outcome: Outcome, checked?: boolean, reason?: Reason, ms?: number, exit?: number | null, tail?: string }} MutantResult
 *   `checked`: a parse check read the mutant (killed, timeout and survived count only then)
 */
/** @typedef {{ exit: number | null, signal: string | null, timedOut: boolean, ms: number, tail: string, error?: string }} CommandRun */

/** setTimeout's ceiling: a longer delay fires at once. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class MutationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MutationError";
  }
}

/** A UTF-16 half without its other half: written to a file it becomes U+FFFD, bytes no mutant named. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The mutant list, every problem at once: a list that half loads would report a half run as the pass.
 * @param {string} text JSON
 * @returns {{ mutants: Mutant[], problems: string[] }}
 */
export function parseMutants(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { mutants: [], problems: [`not JSON: ${/** @type {Error} */ (e).message}`] };
  }
  if (!Array.isArray(data)) return { mutants: [], problems: ["the list must be a JSON array of { id, file, old, new }"] };
  if (!data.length) return { mutants: [], problems: ["the list holds no mutant"] };
  /** @type {string[]} */
  const problems = [];
  /** @type {Mutant[]} */
  const mutants = [];
  const seen = new Set();
  data.forEach((m, i) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) return problems.push(`[${i}] is not an object`);
    const at = typeof m.id === "string" && m.id ? `[${i}] ${m.id}` : `[${i}]`;
    const bad = [];
    for (const k of ["id", "file", "old"]) if (typeof m[k] !== "string" || m[k] === "") bad.push(`"${k}" must be a non-empty string`);
    if (typeof m.new !== "string") bad.push(`"new" must be a string`);
    for (const k of ["old", "new"]) if (typeof m[k] === "string" && LONE_SURROGATE.test(m[k])) bad.push(`"${k}" holds half of a character (a lone surrogate)`);
    if (!bad.length && m.new === m.old) bad.push(`"new" equals "old"`);
    if (!bad.length && seen.has(m.id)) bad.push(`id "${m.id}" is used twice`);
    if (bad.length) return problems.push(`${at}: ${bad.join("; ")}`);
    seen.add(m.id);
    mutants.push({ id: m.id, file: m.file, old: m.old, new: m.new });
  });
  return { mutants, problems };
}

/**
 * Killed / total over the mutants a parse check read; the others apart.
 * @param {MutantResult[]} results
 */
export function summarizeMutants(results) {
  const n = (/** @type {(r: MutantResult) => boolean} */ f) => results.filter(f).length;
  const timeout = n((r) => r.outcome === "timeout");
  const killed = n((r) => r.outcome === "killed") + timeout;
  const survived = n((r) => r.outcome === "survived" && r.checked !== false);
  return {
    killed,
    total: killed + survived,
    timeout,
    survived,
    invalid: n((r) => r.outcome === "invalid"),
    unapplied: n((r) => r.outcome === "unapplied"),
    unchecked: n((r) => r.outcome === "unchecked"),
    uncheckedSurvived: n((r) => r.outcome === "survived" && r.checked === false),
  };
}

/** This user's own directory under the temporary one, for a journal outside a repository. */
const userDir = () => join(tmpdir(), `ennyn-${process.getuid?.() ?? "user"}`);

/**
 * The journal's directory, made if missing. The per-user one sits in a temporary directory other users can
 * write to: one of them could make it first and plant a journal naming any file, so it must be a directory
 * this user owns that no one else can write to, before a journal in it is read.
 * @param {string} path the journal
 */
function journalDir(path) {
  const dir = dirname(path);
  const own = dir === userDir();
  mkdirSync(dir, { recursive: true, ...(own ? { mode: 0o700 } : {}) });
  if (!own) return;
  if (process.platform === "win32") return;
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0) {
    throw new MutationError(`${dir} is not this user's alone (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)}): a journal in it could name any file. Remove it, or point TMPDIR at a directory of your own`);
  }
}

/**
 * One journal per working tree: two worktrees share the state dir, and each may run its own pass.
 * @param {string} cwd the project root
 * @param {string} stateDir config `paths.stateDir`
 */
export function journalPath(cwd, stateDir) {
  const tree = createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
  // Outside a repository a state dir under .git would create a .git directory that is no repository; the
  // temporary directory is shared on a multi-user machine, so the journal goes into one of this user's own.
  const underGit = /^\.git([\\/]|$)/.test(stateDir);
  const dir = underGit && !commonDir(cwd) ? userDir() : resolveStateDir(cwd, stateDir);
  return join(dir, `mutate-${tree}.json`);
}

/** @param {string} s */
const quote = (s) => (process.platform === "win32" ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The command's whole process group: the shell, the test processes, and whatever they left running.
 * @param {number | undefined} pid
 * @param {boolean} running
 */
function killGroup(pid, running) {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      if (running) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * @param {string} command run by the shell
 * @param {{ cwd: string, timeoutMs?: number | null, onChild?: (c: import("node:child_process").ChildProcess | null) => void }} opts
 * @returns {Promise<CommandRun>}
 */
export function runCommand(command, { cwd, timeoutMs = null, onChild = () => {} }) {
  return new Promise((done) => {
    const start = Date.now();
    // Its own process group, so a timeout, a signal or the end of the run stops the test processes too.
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    onChild(child);
    let tail = "";
    const keep = (/** @type {Buffer} */ d) => (tail = (tail + d.toString("utf8")).slice(-4000));
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), killGroup(child.pid, true)), Math.min(timeoutMs, MAX_TIMEOUT_MS)) : null;
    let finished = false;
    /** @param {number | null} exit @param {string | null} signal @param {string} [error] */
    const finish = (exit, signal, error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      onChild(null);
      done({ exit, signal, timedOut, ms: Date.now() - start, tail, ...(error ? { error } : {}) });
    };
    child.on("error", (e) => finish(null, null, e.message));
    // What the tests left running would hold a port or a file for the next mutant: the group goes when the
    // shell does, while its id still names that group. It may hold the pipes open: the exit decides, the
    // output gets a moment.
    child.on("exit", (code, signal) => {
      killGroup(child.pid, false);
      setTimeout(() => finish(code, signal), 1000).unref();
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/**
 * How Node reads a JavaScript file: .mjs and .cjs say it; a .js file follows the nearest package.json
 * "type", and without "module" there it is CommonJS when it parses as such, else a module (a bundler's
 * ESM in a package without a type). node --check on the file itself would guess per run, and a module
 * that fails to parse as CommonJS passes it whatever follows.
 * @param {string} abs @param {Buffer} original
 * @returns {"module" | "commonjs"}
 */
function moduleGoal(abs, original) {
  const ext = extname(abs).toLowerCase();
  if (ext === ".mjs") return "module";
  if (ext === ".cjs") return "commonjs";
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).type === "module") return "module";
      } catch {
        // A package.json that does not parse says nothing about the type.
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return nodeParses(original, "commonjs") ? "commonjs" : "module";
}

/** @param {Buffer} source @param {"module" | "commonjs"} goal @returns {boolean | null} null: node did not answer */
function nodeParses(source, goal) {
  const r = spawnSync(process.execPath, [`--input-type=${goal}`, "--check"], { input: source, stdio: ["pipe", "ignore", "ignore"] });
  return r.error || r.signal ? null : r.status === 0;
}

/**
 * The file's parse check, or null when there is none: node --check (as the file's module type) for
 * JavaScript, JSON.parse for JSON, and for any other file the given command (`{file}` is replaced by the
 * quoted path; exit 0 = parses), given the tests' time limit: a Python check must not judge JSON. It
 * answers true, false, or null when the check itself gave no answer (it ran past its time, was killed or
 * did not start): no answer is never "does not parse".
 * @param {string} abs @param {string} rel @param {Buffer} original
 * @param {{ cwd: string, check: string | null, limit: number, onChild: (c: import("node:child_process").ChildProcess | null) => void }} opts
 * @returns {(() => Promise<boolean | null>) | null}
 */
function parseCheck(abs, rel, original, { cwd, check, limit, onChild }) {
  const ext = extname(abs).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    const goal = moduleGoal(abs, original);
    return async () => nodeParses(readFileSync(abs), goal);
  }
  if (ext === ".json") {
    return async () => {
      try {
        // A byte order mark is no part of the JSON, for this check as for Ennyn's own readers.
        JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
        return true;
      } catch {
        return false;
      }
    };
  }
  if (check) {
    return async () => {
      const run = await runCommand(check.split("{file}").join(quote(rel)), { cwd, timeoutMs: limit, onChild });
      return run.timedOut || run.error || run.signal ? null : run.exit === 0;
    };
  }
  return null;
}

/**
 * @param {string} path @param {Record<string, unknown>} data
 * Written whole and renamed: a journal is there complete or not at all.
 */
function writeJournal(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * Undo what a journal holds: the file goes back while it still holds the mutant, a file changed since is
 * refused (the journal keeps its original bytes), then the journal goes.
 * @param {string} cwd @param {string} path @param {any} j the journal's content
 * @returns {string | null} the file restored
 */
function undo(cwd, path, j) {
  /** @type {string | null} */
  let restored = null;
  if (typeof j?.file === "string") {
    const root = realpathSync(cwd);
    const abs = resolve(root, j.file);
    const rel = relative(root, abs);
    // A run journals a file inside this tree (prepare checked it); any other path was not written by one.
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new MutationError(`the mutation journal ${path} names ${j.file}, outside this tree: no run here wrote it. Check it, then delete it`);
    }
    const original = Buffer.from(String(j.original), "base64");
    const mutated = Buffer.from(String(j.mutated), "base64");
    const now = existsSync(abs) ? readFileSync(abs) : null;
    if (now && now.equals(mutated)) {
      const before = Math.floor(statSync(abs).mtimeMs / 1000);
      writeFileSync(abs, original);
      newerSecond(abs, before);
      restored = j.file;
    } else if (!now || !now.equals(original)) {
      throw new MutationError(`an interrupted run left a mutant in ${j.file}, and the file changed since; its original bytes are in ${path} (base64), the mutant was ${JSON.stringify(j.id)}`);
    }
  }
  unlinkSync(path);
  return restored;
}

/**
 * Give a file just written a whole-second mtime newer than `after` (its last one) and not older than now.
 * @param {string} abs @param {number} after
 * @returns {number} the mtime given
 */
function newerSecond(abs, after) {
  const t = Math.max(Math.floor(Date.now() / 1000), after + 1);
  try {
    utimesSync(abs, t, t);
  } catch {
    // Only the owner may set the times of a file others may write: it keeps the mtime the write gave it.
    return after;
  }
  return t;
}

/** @param {string} path */
function readJournal(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MutationError(`the mutation journal ${path} does not read; check the files of the last run by hand, then delete it`);
  }
}

/**
 * `ennyn mutate --restore`: undo the journal of a run that is gone. While its pid lives the run may be in a
 * mutant's tests, and writing the file back would turn a kill into a survivor: refused, unless `force` (a
 * pid reused by another process after a reboot).
 * @param {string} cwd @param {string} path @param {{ force?: boolean }} [opts]
 * @returns {{ restored: string | null, found: boolean }}
 */
export function restoreJournal(cwd, path, { force = false } = {}) {
  if (dirname(path) === userDir() && existsSync(dirname(path))) journalDir(path);
  if (!existsSync(path)) return { restored: null, found: false };
  const j = readJournal(path);
  if (!force && typeof j?.pid === "number" && j.pid !== process.pid && alive(j.pid)) {
    throw new MutationError(`pid ${j.pid} of the journal is alive: an ennyn mutate may be running in this tree. If that pid is no such run (reused after a reboot), add --force`);
  }
  return { restored: undo(cwd, path, j), found: true };
}

/**
 * Take the journal for this tree. A journal left by a run that is gone is undone first.
 * @param {string} cwd @param {string} path
 * @returns {{ restored: string | null }}
 */
function takeJournal(cwd, path) {
  /** @type {string | null} */
  let restored = null;
  journalDir(path);
  if (existsSync(path)) {
    const j = readJournal(path);
    if (typeof j?.pid === "number" && j.pid !== process.pid && alive(j.pid)) {
      const held = typeof j.file === "string" ? `; it holds the original bytes of ${j.file}` : "";
      throw new MutationError(`another ennyn mutate (pid ${j.pid}) is running in this tree${held}. If it is not, run ennyn mutate --restore --force (never delete the journal)`);
    }
    restored = undo(cwd, path, j);
  }
  // wx: of two runs that start together, one gets the journal. A state dir in the repository keeps the
  // repository's own modes, also when the repository sits under the temporary directory (/tmp on Linux).
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") throw new MutationError(`another ennyn mutate started in this tree at the same time (${path})`);
    throw e;
  }
  return { restored };
}

/** Every position `old` starts at, overlapping ones too ("aa" is twice in "aaa"). @param {string} text @param {string} old */
function occurrences(text, old) {
  let n = 0;
  for (let at = text.indexOf(old); at !== -1; at = text.indexOf(old, at + 1)) n++;
  return n;
}

/**
 * @param {string} cwd @param {Mutant} m
 * @returns {{ abs: string, rel: string, original: Buffer, mutated: Buffer } | { reason: Reason }}
 */
function prepare(cwd, m) {
  const root = realpathSync(cwd);
  const abs = resolve(root, m.file);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { reason: { key: "mutate.reason.missing" } };
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return { reason: { key: "mutate.reason.outside" } };
  if (!statSync(real).isFile()) return { reason: { key: "mutate.reason.missing" } };
  const original = readFileSync(real);
  const text = original.toString("utf8");
  // Written back as text, a file that is not UTF-8 would change in bytes the mutant never named.
  if (!Buffer.from(text, "utf8").equals(original)) return { reason: { key: "mutate.reason.notText" } };
  const n = occurrences(text, m.old);
  if (n !== 1) return { reason: { key: "mutate.reason.occurs", vars: { n } } };
  const at = text.indexOf(m.old);
  const mutated = Buffer.from(text.slice(0, at) + m.new + text.slice(at + m.old.length), "utf8");
  return { abs: real, rel: rel.split(sep).join("/"), original, mutated };
}

/**
 * @param {{
 *   cwd: string, mutants: Mutant[], command: string, check?: string | null, journal: string,
 *   timeoutMs?: number | null, onResult?: (r: MutantResult) => void, onBaseline?: (b: CommandRun, timeoutMs: number) => void
 * }} opts
 *   `timeoutMs`: per mutant; default three times the baseline, at least the baseline plus 30 s; one shorter
 *   than one and a half times the baseline is refused. A run that reaches it runs once more with twice the
 *   time before it counts as a timeout. A test run that cannot start ends the pass: no number from it.
 * @returns {Promise<{ restored: string | null, baseline: CommandRun, timeoutMs: number | null, results: MutantResult[] }>}
 *   no results when the baseline fails
 */
export async function runMutants({ cwd, mutants, command, check = null, journal, timeoutMs = null, onResult = () => {}, onBaseline = () => {} }) {
  const { restored } = takeJournal(cwd, journal);
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /** @type {{ abs: string, original: Buffer } | null} */
  let applied = null;
  /** The last whole-second mtime given to each file, first its own before the run: every write gets a newer one. */
  const stamps = new Map();
  /** @param {string} abs */
  const stamp = (abs) => stamps.set(abs, newerSecond(abs, stamps.get(abs)));
  const putBack = () => {
    if (!applied) return;
    const { abs, original } = applied;
    writeFileSync(abs, original);
    applied = null;
    stamp(abs);
  };
  const release = () => {
    for (const s of signals) process.off(s, onSignal);
    process.off("exit", onExit);
    try {
      unlinkSync(journal);
    } catch {
      // Already gone.
    }
  };
  // However the process ends mid-run (a signal, process.exit on a closed pipe), the tests stop, the file
  // goes back and the journal goes. A signal then ends the process as it would have.
  const onExit = () => {
    if (child) killGroup(child.pid, true);
    putBack();
    release();
  };
  /** @param {NodeJS.Signals} sig */
  const onSignal = (sig) => {
    onExit();
    process.kill(process.pid, sig);
  };
  const signals = /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
  for (const s of signals) process.on(s, onSignal);
  process.on("exit", onExit);
  try {
    const onChild = (/** @type {import("node:child_process").ChildProcess | null} */ c) => (child = c);
    const baseline = await runCommand(command, { cwd, onChild });
    if (baseline.exit !== 0) return { restored, baseline, timeoutMs: null, results: [] };
    if (timeoutMs !== null && timeoutMs < 1.5 * baseline.ms) {
      throw new MutationError(`a timeout of ${(timeoutMs / 1000).toFixed(1)} s is under one and a half times the run without mutants (${(baseline.ms / 1000).toFixed(1)} s): every mutant would count as killed`);
    }
    const limit = Math.min(timeoutMs ?? Math.max(3 * baseline.ms, baseline.ms + 30_000), MAX_TIMEOUT_MS);
    onBaseline(baseline, limit);
    /** @type {MutantResult[]} */
    const results = [];
    /** @type {Map<string, boolean | null>} */
    const originalParses = new Map();
    for (const m of mutants) {
      const p = prepare(cwd, m);
      /** @type {MutantResult} */
      let r;
      if ("reason" in p) r = { id: m.id, file: m.file, outcome: "unapplied", reason: p.reason };
      else {
        const parses = parseCheck(p.abs, p.rel, p.original, { cwd, check, limit, onChild });
        // A check that fails on the file as it is cannot tell a broken mutant from a sound one.
        if (parses && !originalParses.has(p.abs)) originalParses.set(p.abs, await parses());
        const answer = parses ? originalParses.get(p.abs) : undefined;
        /** @type {Reason | null} */
        let noCheck = !parses ? { key: "mutate.reason.noCheck" } : answer === null ? { key: "mutate.reason.checkNoAnswer" } : answer ? null : { key: "mutate.reason.originalFails" };
        writeJournal(journal, { pid: process.pid, id: m.id, file: p.rel, original: p.original.toString("base64"), mutated: p.mutated.toString("base64") });
        applied = { abs: p.abs, original: p.original };
        if (!stamps.has(p.abs)) stamps.set(p.abs, Math.floor(statSync(p.abs).mtimeMs / 1000));
        try {
          writeFileSync(p.abs, p.mutated);
          stamp(p.abs);
          const verdict = parses && !noCheck ? await parses() : null;
          if (parses && !noCheck && verdict === null) noCheck = { key: "mutate.reason.checkNoAnswer" };
          if (verdict === false) r = { id: m.id, file: p.rel, outcome: "invalid", checked: true, reason: { key: "mutate.reason.parse" } };
          else {
            let run = await runCommand(command, { cwd, timeoutMs: limit, onChild });
            if (run.timedOut) run = await runCommand(command, { cwd, timeoutMs: 2 * limit, onChild });
            if (run.error) throw new MutationError(`the test command did not start for mutant ${m.id} (${run.error}); no count from this run`);
            // Without a parse check a failure, or a hang, may be a mutant that does not parse.
            /** @type {Outcome} */
            const outcome = run.exit === 0 && !run.timedOut ? "survived" : noCheck ? "unchecked" : run.timedOut ? "timeout" : "killed";
            r = { id: m.id, file: p.rel, outcome, checked: !noCheck, ...(noCheck ? { reason: noCheck } : {}), ms: run.ms, exit: run.exit, tail: run.tail };
          }
        } finally {
          putBack();
          writeJournal(journal, { pid: process.pid });
        }
      }
      results.push(r);
      onResult(r);
    }
    return { restored, baseline, timeoutMs: limit, results };
  } finally {
    putBack();
    release();
  }
}
