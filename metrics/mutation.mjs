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
 * the file back; a run killed outright is undone by the next one, or by `--restore`. Either way only while
 * the file still holds the mutant: a file changed since (an edit made while the mutant was in) is left
 * alone and reported, and the journal keeps its original bytes. Each write moves the
 * file's mtime to a new whole second: caches keyed by size and mtime (Python's bytecode) would otherwise
 * run a mutant after the source is back.
 *
 * A file with a second name is never mutated: a write in place reaches every name. One that got a second name while
 * the mutant was in it (seen four times in 2026-10, each by the run that wrote the mutant; what made the name is
 * unknown) goes back in that run alone, which knows the file by device and inode and the mutant's bytes in memory. A
 * journal proves neither, for anyone who can write the state dir can plant one: after a kill such a file is put
 * right by hand. Other names are searched for only after the write, when the journal holds no bytes: a search decides
 * nothing, and a kill there loses a notice, never a byte. The run holds the file read-only from the mutant write until
 * then, so what it says of a file its path no longer leads to rests on that file's own link count.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, futimesSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { gone, linkBelow, present, readRegular, removeState, writeState } from "../core/files.mjs";
import { shown, unshownEscaped } from "../core/i18n.mjs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { commonDir, gitRun, resolveStateDir, stateRoot, underGitDir } from "../core/git.mjs";

/** @typedef {{ id: string, file: string, old: string, new: string }} Mutant */
/** @typedef {"killed" | "timeout" | "survived" | "invalid" | "unchecked" | "unapplied"} Outcome */
/** @typedef {{ key: string, vars?: Record<string, string | number> }} Reason */
/** @typedef {{ dev: bigint, ino: bigint }} Inode a file, known by a run that wrote it and kept nowhere else */
/**
 * @typedef {{ how: "through" | "already" | "elsewhere", file: string, id: string, names: string[], unfound: number, looked: number, trees: number, capped: boolean, unread: number }} LinkNotice
 *   what a write-back says about other names of `file`. `through`: the original went back through them; `already`: the file
 *   held the original, nothing was written; `elsewhere`: `file` is no longer the file mutant `id` went into, which still has
 *   names. `names` relative to the tree inside it, else absolute; `unfound`: how many the link count left unfound; the rest
 *   as otherNames says, all empty when no search ran
 */
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

/**
 * Whether a path relative to the tree has a ".git" component in any case: a git dir, or a gitdir file that names
 * one. Git tracks no such path, so no mutant names one, and a journal that does would write git's config or hooks.
 * @param {string} rel
 */
const inGit = (rel) => rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");

/** This user's own directory under the temporary one, for a journal outside a repository. */
const userDir = () => join(tmpdir(), `ennyn-${process.getuid?.() ?? "user"}`);

/**
 * The per-user journal directory, made if missing. It sits in a temporary directory other users can write to:
 * one of them could make it first and plant a journal naming any file, so it must be a directory this user owns
 * that no one else can write to, before a journal in it is read. A state dir is made by writeState, through no link.
 * @param {string} path the journal
 */
function journalDir(path) {
  const dir = dirname(path);
  if (dir !== userDir()) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  const underGit = underGitDir(stateDir) !== null;
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
    if (present(pkg)) {
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
 * did not start): no answer is never "does not parse". `command`: the check is the given command, which
 * could write the file it reads (the built-in two read it only).
 * @param {string} abs @param {string} rel @param {Buffer} original
 * @param {{ cwd: string, check: string | null, limit: number, onChild: (c: import("node:child_process").ChildProcess | null) => void }} opts
 * @returns {{ run: () => Promise<boolean | null>, command: boolean } | null}
 */
function parseCheck(abs, rel, original, { cwd, check, limit, onChild }) {
  const ext = extname(abs).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    const goal = moduleGoal(abs, original);
    return { run: async () => nodeParses(readFileSync(abs), goal), command: false };
  }
  if (ext === ".json") {
    const run = async () => {
      try {
        // A byte order mark is no part of the JSON, for this check as for Ennyn's own readers.
        JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
        return true;
      } catch {
        return false;
      }
    };
    return { run, command: false };
  }
  if (check) {
    const run = async () => {
      // A name that starts with "-" would reach the check as an option.
      const done = await runCommand(check.split("{file}").join(quote(rel.startsWith("-") ? `./${rel}` : rel)), { cwd, timeoutMs: limit, onChild });
      return done.timedOut || done.error || done.signal ? null : done.exit === 0;
    };
    return { run, command: true };
  }
  return null;
}

/** Why a file with another name is not written: what openInPlace says, and what a write-back says that may not go through one. */
const HARD_LINKED = "it has another name (a hard link), which a write would reach too";

/**
 * The most directory entries a search for a file's other names looks at, over every work tree: some 2.5 s at the
 * 40 entries a millisecond measured on a Mac's SSD (2026-10-29).
 */
const NAME_SEARCH_LIMIT = 100_000;

/**
 * The repository's work trees git lists, the main one first (it holds agents' worktrees, .claude/worktrees/ in
 * Claude Code); none when git cannot list them. A bare repository's directory is no work tree.
 * @param {string} tree
 */
function workTrees(tree) {
  const r = gitRun(["worktree", "list", "--porcelain"], { cwd: tree });
  if (r.error || r.status !== 0) return [];
  return r.stdout
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => !lines.includes("bare"))
    .flatMap((lines) => lines.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length)));
}

/**
 * Where else the file `dev`/`ino` (a bigint stat's) has a name: a search of this tree and of every work tree git lists
 * for its repository, through no link, git directories left out (git keeps no work-tree file there), directories on
 * another device left out (a hard link stays on its file's), at most `limit` entries in all. A name outside them
 * is not found: the caller counts those from the link count.
 * @param {string} tree the project's real path @param {{ dev: bigint, ino: bigint, self: string }} file `self`: the name the mutant went in by
 * @param {{ limit?: number }} [opts]
 * @returns {{ names: string[], looked: number, trees: number, capped: boolean, unread: number }} `names` relative to the tree
 *   inside it, else absolute; `trees` the work trees searched; `capped` the search stopped at `limit`; `unread` folders it could not read
 */
export function otherNames(tree, { dev, ino, self }, { limit = NAME_SEARCH_LIMIT } = {}) {
  // The spelling readdir gives (a case-insensitive disk keeps a name's own case), so the file's own name is known as such.
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const home = real(tree);
  const me = real(self);
  const roots = [...new Set([home, ...workTrees(tree).map(real)])];
  /** @type {string[]} */
  const names = [];
  /** The directories searched, by inode: all on the file's device. */
  const seen = new Set();
  /** The tops of the work trees searched, by inode: one inside another is searched there, and counted once. */
  const tops = new Set();
  let looked = 0;
  let capped = false;
  let unread = 0;
  for (const root of roots) {
    const stack = [root];
    while (stack.length && !capped) {
      const dir = /** @type {string} */ (stack.pop());
      let entries;
      try {
        const st = lstatSync(dir, { bigint: true });
        if (!st.isDirectory() || st.dev !== dev) continue;
        if (dir === root) tops.add(st.ino);
        // A directory met twice (a work tree inside another, .claude/worktrees/) is searched once.
        if (seen.has(st.ino)) continue;
        seen.add(st.ino);
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (!gone(e)) unread++;
        continue;
      }
      /** A name listed here could not be looked at (a folder that may be read, not searched): the folder is unread. */
      let blind = false;
      for (const d of entries) {
        if (looked === limit) {
          capped = true;
          break;
        }
        looked++;
        const path = join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name.toLowerCase() !== ".git") stack.push(path);
        } else if (d.isFile() && path !== me) {
          try {
            const st = lstatSync(path, { bigint: true });
            if (st.dev === dev && st.ino === ino) names.push(path);
          } catch (e) {
            // Gone since it was listed is no name of the file now; anything else is a name not looked at.
            if (!gone(e)) blind = true;
          }
        }
      }
      if (blind) unread++;
    }
  }
  const shown = (/** @type {string} */ p) => {
    const rel = relative(home, p);
    return rel.startsWith(`..${sep}`) || isAbsolute(rel) ? p : rel.split(sep).join("/");
  };
  return { names: names.map(shown), looked, trees: tops.size, capped, unread };
}

/** A notice with no search behind it. */
const NOT_SEARCHED = { names: [], unfound: 0, looked: 0, trees: 0, capped: false, unread: 0 };

/**
 * What a put-back says about a file with other names, searched after the fact: it decides nothing.
 * @param {"through" | "already"} how @param {string} tree @param {string} self the file's path @param {Inode} inode
 * @param {number} links its link count at the put-back @param {string} file @param {string} id
 * @returns {LinkNotice}
 */
function namesNotice(how, tree, self, inode, links, file, id) {
  const found = otherNames(tree, { ...inode, self });
  return { how, file, id, ...found, unfound: Math.max(0, links - 1 - found.names.length) };
}

/**
 * A read-only descriptor on the file a mutant just went into, held until what is left of it can be said: its link count
 * tells how many names it has, wherever they are, and while it is open its number goes to no new file. Read-only: a
 * file open for writing cannot be run on Linux (ETXTBSY), and the tests may run it. Null when the path no longer leads
 * to the file: only a notice is lost.
 * @param {string} abs @param {Inode} inode
 * @returns {number | null}
 */
function holdOn(abs, inode) {
  try {
    const held = openSync(abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(held, { bigint: true });
    if (st.dev === inode.dev && st.ino === inode.ino) return held;
    closeSync(held);
  } catch {
    // Only a notice is lost.
  }
  return null;
}

/**
 * What is left of the file a mutant went into when its path no longer leads to it (moved, or replaced with a name kept),
 * and closes the descriptor. Null when it has no name left, or the path is still that file. Report only.
 * @param {string} tree @param {string} self the file's path @param {number | null} held see holdOn @param {string} file @param {string} id
 * @returns {LinkNotice | null}
 */
function leftBehind(tree, self, held, file, id) {
  if (held === null) return null;
  try {
    const st = fstatSync(held, { bigint: true });
    if (st.nlink === 0n) return null;
    try {
      const at = lstatSync(self, { bigint: true });
      if (at.dev === st.dev && at.ino === st.ino) return null;
    } catch (e) {
      // Nothing there: moved. A path that could not be looked at may still be that file, and this says nothing it cannot tell.
      if (!gone(e)) return null;
    }
    const found = otherNames(tree, { dev: st.dev, ino: st.ino, self });
    return { how: "elsewhere", file, id, ...found, unfound: Math.max(0, Number(st.nlink) - found.names.length) };
  } finally {
    closeSync(held);
  }
}

/**
 * What a refusal adds for the hand that puts a file with other names right: those names, and the one repair that reaches them.
 * @param {string} tree @param {string} self the file's path @param {number} fd the file, open
 */
function byHand(tree, self, fd) {
  const st = fstatSync(fd, { bigint: true });
  const found = otherNames(tree, { dev: st.dev, ino: st.ino, self });
  const names = found.names.map((name) => shown(name, { name: true }).text);
  const unfound = Math.max(0, Number(st.nlink) - 1 - names.length);
  const where = names.length ? `Its other names: ${names.join(", ")}${unfound ? `, and ${unfound} the search did not find` : ""}` : `Its ${unfound} other names lie outside what the search looked at`;
  return `${where}. Write the journal's bytes through the file in place (with > in a shell, say): a tool that replaces the file (git restore, an editor's save) leaves the other names as they are`;
}

/**
 * Opens the file a mutant goes into or comes out of, so that it is read, compared and written through this one
 * descriptor: below `tree` through no link (each directory looked at, the file opened with O_NOFOLLOW), not
 * waiting (a FIFO never answers), a regular file with no other name (a write would reach a hard link's other
 * names too) unless `named`, and once open still the file at its path: its device and inode are the path's, looked at
 * again through no link, so a directory swapped for a link while it was opened is caught. Null when nothing is
 * there; any other refusal throws, saying why, with `moved` when the path no longer leads to the file.
 * @param {string} tree the project's real path @param {string} abs
 * @param {{ named?: boolean }} [opts] `named`: let other names through, for a write-back, which reads the bytes and decides
 * @returns {number | null}
 */
function openInPlace(tree, abs, { named = false } = {}) {
  const rel = relative(tree, abs).split(sep).join("/");
  const moved = (/** @type {string} */ why) => Object.assign(new Error(why), { moved: true });
  const noLink = () => {
    const link = linkBelow(tree, abs, { last: false });
    if (link) throw moved(`${link} is a symbolic link`);
  };
  noLink();
  let fd;
  try {
    fd = openSync(abs, constants.O_RDWR | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    // O_NOFOLLOW meets a link as ELOOP (EMLINK on some BSDs).
    if (err.code === "ELOOP" || err.code === "EMLINK") throw moved(`${rel} is a symbolic link`);
    if (gone(err)) return null;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("it is no regular file");
    if (st.nlink > 1 && !named) throw new Error(HARD_LINKED);
    noLink();
    const at = lstatSync(abs);
    if (at.dev !== st.dev || at.ino !== st.ino) throw moved(`${rel} led to another file while it was opened`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * Replaces a file's bytes through `fd`: cut to nothing, then written whole from the start; a write that stops
 * short goes on from where it stopped, so the failure that follows is thrown.
 * @param {number} fd @param {Buffer} bytes
 */
function writeAt(fd, bytes) {
  ftruncateSync(fd, 0);
  for (let done = 0; done < bytes.length; ) {
    const n = writeSync(fd, bytes, done, bytes.length - done, done);
    if (n === 0) throw new Error("the file took no more bytes");
    done += n;
  }
}

/**
 * @param {string} root the directory it is written below with no link (stateRoot) @param {string} path
 * @param {Record<string, unknown>} data
 * Written whole and renamed: a journal is there complete or not at all.
 */
function writeJournal(root, path, data) {
  writeState(root, path, JSON.stringify(data), "replace");
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
 * refused (the journal keeps its original bytes), then the journal goes. A file with another name is never written:
 * a journal proves nothing about it. It needs no write when it already holds the original.
 * @param {string} cwd @param {string} at the journal's state root @param {string} path @param {any} j the journal's content
 * @returns {{ restored: string | null, linked: LinkNotice | null }} the file restored; what there is to say about one that needed nothing
 */
function undo(cwd, at, path, j) {
  /** @type {string | null} */
  let restored = null;
  /** @type {LinkNotice | null} */
  let linked = null;
  if (typeof j?.file === "string") {
    const root = realpathSync(cwd);
    const abs = resolve(root, j.file);
    const rel = relative(root, abs);
    // A run journals a file inside this tree (prepare checked it); any other path was not written by one.
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new MutationError(`the mutation journal ${path} names ${j.file}, outside this tree: no run here wrote it. Check it, then delete it`);
    }
    if (inGit(rel)) throw new MutationError(`the mutation journal ${path} names ${j.file}, in a git directory: no run here wrote it. Check it, then delete it`);
    const original = Buffer.from(String(j.original), "base64");
    const mutated = Buffer.from(String(j.mutated), "base64");
    const left = `its original bytes are in ${path} (base64), the mutant was ${JSON.stringify(j.id)}`;
    /** @type {number | null} */
    let fd;
    try {
      fd = openInPlace(root, abs, { named: true });
    } catch (e) {
      // A run journals the file's real path (prepare): a link on the way now leads somewhere else, and the
      // mutant, if a run wrote it, is in the file that was there.
      const err = /** @type {Error & { moved?: boolean }} */ (e);
      if (err.moved) throw new MutationError(`the mutation journal ${path} names ${j.file}, and ${err.message}: nothing is written through it. If a run wrote the journal, the mutant is in the file that was at ${j.file}; ${left}: put that file right by hand, then delete the journal`);
      throw new MutationError(`${j.file} could not be put back (${err.message}); ${left}: put the file right by hand, then delete the journal`);
    }
    try {
      const now = fd === null ? null : readFileSync(fd);
      if (fd !== null && fstatSync(fd).nlink > 1) {
        if (!now?.equals(original)) throw new MutationError(`${j.file} could not be put back (${HARD_LINKED}); ${left}: put the file right by hand, then delete the journal. ${byHand(root, abs, fd)}`);
        linked = { how: "already", file: j.file, id: String(j.id), ...NOT_SEARCHED };
      } else if (fd !== null && now?.equals(mutated)) {
        const before = Math.floor(fstatSync(fd).mtimeMs / 1000);
        writeAt(fd, original);
        newerSecond(fd, before);
        restored = j.file;
      } else if (!now) {
        throw new MutationError(`an interrupted run left a mutant in ${j.file}, and the file was deleted since; ${left}: write them back by hand if the file should be there, then delete the journal`);
      } else if (!now.equals(original)) {
        throw new MutationError(`an interrupted run left a mutant in ${j.file}, and the file changed since; ${left}: put the file right by hand, then delete the journal`);
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  removeState(at, path);
  return { restored, linked };
}

/**
 * Give a file just written a whole-second mtime newer than `after` (its last one) and not older than now.
 * @param {number} fd the file, open @param {number} after
 * @returns {number} the mtime given
 */
function newerSecond(fd, after) {
  const t = Math.max(Math.floor(Date.now() / 1000), after + 1);
  try {
    futimesSync(fd, t, t);
  } catch {
    // Only the owner may set the times of a file others may write: it keeps the mtime the write gave it.
    return after;
  }
  return t;
}

/**
 * The journal's content, read below `root` with no link; undefined when there is none.
 * @param {string} root @param {string} path
 */
function readJournal(root, path) {
  /** @type {Buffer | null} */
  let bytes;
  try {
    bytes = readRegular(root, path);
  } catch (e) {
    throw new MutationError(`${/** @type {Error} */ (e).message}; check the files of the last run by hand`);
  }
  if (bytes === null) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new MutationError(`the mutation journal ${path} does not read; check the files of the last run by hand, then delete it`);
  }
}

/**
 * `ennyn mutate --restore`: undo the journal of a run that is gone. While its pid lives the run may be in a
 * mutant's tests, and writing the file back would turn a kill into a survivor: refused, unless `force` (a
 * pid reused by another process after a reboot).
 * @param {string} cwd @param {string} path @param {{ force?: boolean }} [opts]
 * @returns {{ restored: string | null, found: boolean, linked?: LinkNotice }} `linked`: a file with other names that needed nothing
 */
export function restoreJournal(cwd, path, { force = false } = {}) {
  if (dirname(path) === userDir() && present(dirname(path))) journalDir(path);
  const root = stateRoot(cwd, path);
  const j = readJournal(root, path);
  if (j === undefined) return { restored: null, found: false };
  if (!force && typeof j?.pid === "number" && j.pid !== process.pid && alive(j.pid)) {
    throw new MutationError(`pid ${j.pid} of the journal is alive: an ennyn mutate may be running in this tree. If that pid is no such run (reused after a reboot), add --force`);
  }
  const { restored, linked } = undo(cwd, root, path, j);
  return { restored, found: true, ...(linked ? { linked } : {}) };
}

/**
 * Take the journal for this tree. A journal left by a run that is gone is undone first.
 * @param {string} cwd @param {string} path @param {(l: LinkNotice) => void} onLinked
 * @returns {{ restored: string | null }}
 */
function takeJournal(cwd, path, onLinked) {
  /** @type {string | null} */
  let restored = null;
  journalDir(path);
  const root = stateRoot(cwd, path);
  const j = readJournal(root, path);
  if (j !== undefined) {
    if (typeof j?.pid === "number" && j.pid !== process.pid && alive(j.pid)) {
      const held = typeof j.file === "string" ? `; it holds the original bytes of ${j.file}` : "";
      throw new MutationError(`another ennyn mutate (pid ${j.pid}) is running in this tree${held}. If it is not, run ennyn mutate --restore --force (never delete the journal)`);
    }
    const undone = undo(cwd, root, path, j);
    restored = undone.restored;
    if (undone.linked) onLinked(undone.linked);
  }
  // wx: of two runs that start together, one gets the journal. A state dir in the repository keeps the
  // repository's own modes, also when the repository sits under the temporary directory (/tmp on Linux).
  try {
    writeState(root, path, JSON.stringify({ pid: process.pid }), "create");
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
  } catch (err) {
    // No such file is a mutant that cannot apply; one that cannot be looked at stops the run, saying why.
    if (gone(err)) return { reason: { key: "mutate.reason.missing" } };
    throw err;
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return { reason: { key: "mutate.reason.outside" } };
  if (inGit(rel)) return { reason: { key: "mutate.reason.gitDir" } };
  const st = statSync(real);
  if (!st.isFile()) return { reason: { key: "mutate.reason.missing" } };
  // A write in place reaches every name of the file, wherever the others are.
  if (st.nlink > 1) return { reason: { key: "mutate.reason.hardLinked" } };
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
 *   timeoutMs?: number | null, onResult?: (r: MutantResult) => void, onBaseline?: (b: CommandRun, timeoutMs: number) => void,
 *   onLinked?: (l: LinkNotice) => void
 * }} opts
 *   `timeoutMs`: per mutant; default three times the baseline, at least the baseline plus 30 s; one shorter
 *   than one and a half times the baseline is refused. A run that reaches it runs once more with twice the
 *   time before it counts as a timeout. A test run that cannot start ends the pass: no number from it.
 *   `onLinked`: what there is to say about other names of a file a mutant was in, as soon as it can be said.
 * @returns {Promise<{ restored: string | null, baseline: CommandRun, timeoutMs: number | null, results: MutantResult[] }>}
 *   no results when the baseline fails
 */
export async function runMutants({ cwd, mutants, command, check = null, journal, timeoutMs = null, onResult = () => {}, onBaseline = () => {}, onLinked = () => {} }) {
  const { restored } = takeJournal(cwd, journal, onLinked);
  const root = stateRoot(cwd, journal);
  const tree = realpathSync(cwd);
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /**
   * The mutant in a file, `written` once its write returned: from then on bytes that are neither the mutant
   * nor the original are someone's edit. Before, they are what a write cut short left: the run's own. `ran`:
   * the run's commands that read the file while the mutant was in, and so could have written it. `inode`: the file
   * the mutant went into, the proof a write through a name it got meanwhile needs. `held`: see holdOn.
   * @type {{ abs: string, rel: string, id: string, original: Buffer, mutated: Buffer, written: boolean, ran: string[], inode: Inode, held: number | null } | null}
   */
  let applied = null;
  /** The journal holds the original bytes of a file not yet back: it stays. */
  let keep = false;
  /** What put-backs left to say: searches, run once the journal holds no bytes. @type {(() => LinkNotice | null)[]} */
  const unsaid = [];
  const sayNames = () => {
    for (const search of unsaid.splice(0)) {
      const notice = search();
      if (notice) onLinked(notice);
    }
  };
  /** The last whole-second mtime given to each file, first its own before the run: every write gets a newer one. */
  const stamps = new Map();
  /** @param {string} abs @param {number} fd the file, open */
  const stamp = (abs, fd) => stamps.set(abs, newerSecond(fd, stamps.get(abs)));
  /** @param {string} how the way out */
  const kept = (how) => `its original bytes are in ${journal} (base64): ${how}, then delete the journal`;
  /** Who may have changed a file: an edit, or the run's own commands that read it meanwhile. @param {string[]} ran */
  const writers = (ran) => `an edit${ran.length ? `, or ${ran.join(" or ")} writing it` : ""}`;
  // The file goes back while it holds the mutant, as undo puts back a file a killed run left: an edit made
  // while the mutant was in (an agent working on beside the run) is never written over. It is read and
  // written through one descriptor (openInPlace): a link swapped in since may lead anywhere, a FIFO would
  // never answer. A hard link would take the write too: it goes through one only into the very file the mutant
  // went into, over exactly its bytes, and nothing slow stands between the read and the write.
  const putBack = () => {
    if (!applied) return;
    const { abs, rel, id, original, mutated, written, ran, inode, held } = applied;
    applied = null;
    keep = true;
    unsaid.push(() => leftBehind(tree, abs, held, rel, id));
    const left = (/** @type {string} */ why) => new MutationError(`mutant ${JSON.stringify(id)} is left in ${rel}: ${why}; ${kept("put the file right by hand")}`);
    /** @type {number | null} */
    let fd;
    try {
      fd = openInPlace(tree, abs, { named: true });
    } catch (e) {
      const err = /** @type {Error & { moved?: boolean }} */ (e);
      if (err.moved) throw new MutationError(`mutant ${JSON.stringify(id)} is left in the file that was at ${rel}: ${err.message}, and nothing is written through it; ${kept("put that file right by hand")}`);
      throw left(`it could not be written back (${err.message})`);
    }
    try {
      const now = fd === null ? null : readFileSync(fd);
      if (written && !now) throw new MutationError(`${rel} was deleted while mutant ${JSON.stringify(id)} was in it: nothing is written there; ${kept("write them back by hand if the file should be there")}`);
      if (fd === null || !now) {
        keep = false;
        return;
      }
      const st = fstatSync(fd, { bigint: true });
      const named = st.nlink > 1n;
      const back = !now.equals(original);
      const same = st.dev === inode.dev && st.ino === inode.ino;
      if (named && back && !(same && now.equals(mutated))) throw left(`it could not be written back (${HARD_LINKED})`);
      if (written && !now.equals(mutated) && !now.equals(original)) {
        throw new MutationError(`${rel} changed while mutant ${JSON.stringify(id)} was in it (${writers(ran)}): it is left as it is, the mutant with it; ${kept("take the mutant out by hand")}`);
      }
      if (back) {
        try {
          writeAt(fd, original);
        } catch (e) {
          throw left(`it could not be written back (${/** @type {Error} */ (e).message})`);
        }
      }
      // A file the tests put back themselves gets a newer second too: a cache keyed by mtime and size would keep the mutant's.
      // Not one with other names that the mutant never went into: the stamp would reach a file this run never wrote.
      if ((back || written) && (same || !named)) stamp(abs, fd);
      if (named) unsaid.push(() => namesNotice(back ? "through" : "already", tree, abs, { dev: st.dev, ino: st.ino }, Number(st.nlink), rel, id));
    } finally {
      if (fd !== null) closeSync(fd);
    }
    keep = false;
  };
  const release = () => {
    for (const s of signals) process.off(s, onSignal);
    process.off("exit", onExit);
    if (keep) return;
    try {
      removeState(root, journal);
    } catch {
      // Already gone.
    }
  };
  // However the process ends mid-run (a signal, process.exit on a closed pipe), the tests stop, the file
  // goes back and the journal goes. A signal then ends the process as it would have. Nothing is thrown
  // here: the process is ending, and what it could not put back is said on stderr.
  const onExit = () => {
    if (child) killGroup(child.pid, true);
    try {
      putBack();
    } catch (e) {
      try {
        writeSync(2, `${unshownEscaped(/** @type {Error} */ (e).message)}\n`);
      } catch {
        // No stderr to write to: the journal and the next run still say it.
      }
    }
    release();
    try {
      sayNames();
    } catch {
      // The process is ending: a notice lost, never a byte.
    }
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
        const pc = parseCheck(p.abs, p.rel, p.original, { cwd, check, limit, onChild });
        const parses = pc?.run ?? null;
        /** The run's commands that read the file from here on, and so could have written it. @type {string[]} */
        const ran = [];
        // A check that fails on the file as it is cannot tell a broken mutant from a sound one.
        if (parses && !originalParses.has(p.abs)) {
          if (pc?.command) ran.push("the parse check");
          originalParses.set(p.abs, await parses());
        }
        const answer = parses ? originalParses.get(p.abs) : undefined;
        /** @type {Reason | null} */
        let noCheck = !parses ? { key: "mutate.reason.noCheck" } : answer === null ? { key: "mutate.reason.checkNoAnswer" } : answer ? null : { key: "mutate.reason.originalFails" };
        /** @param {unknown} e */
        const notWritten = (e) => new MutationError(`mutant ${JSON.stringify(m.id)} was not written to ${p.rel} (${/** @type {Error} */ (e).message}): the file is as it was; no count from this run`);
        // The file still as prepare read it, read and written through one descriptor (openInPlace): an edit
        // made since (while its parse check ran) is not built over, a link swapped in is not written through.
        /** @type {number | null} */
        let fd;
        try {
          fd = openInPlace(tree, p.abs);
        } catch (e) {
          throw notWritten(e);
        }
        const changed = () => new MutationError(`${p.rel} changed while mutant ${JSON.stringify(m.id)} was being prepared (${writers(ran)}): nothing was written to it; run again`);
        if (fd === null) throw changed();
        /** @type {Inode} */
        let inode;
        try {
          if (!readFileSync(fd).equals(p.original)) throw changed();
          const st = fstatSync(fd, { bigint: true });
          inode = { dev: st.dev, ino: st.ino };
          writeJournal(root, journal, { pid: process.pid, id: m.id, file: p.rel, original: p.original.toString("base64"), mutated: p.mutated.toString("base64") });
        } catch (e) {
          closeSync(fd);
          throw e;
        }
        applied = { abs: p.abs, rel: p.rel, id: m.id, original: p.original, mutated: p.mutated, written: false, ran, inode, held: null };
        try {
          try {
            if (!stamps.has(p.abs)) stamps.set(p.abs, Math.floor(fstatSync(fd).mtimeMs / 1000));
            try {
              writeAt(fd, p.mutated);
            } catch (e) {
              throw notWritten(e);
            }
            applied.written = true;
            stamp(p.abs, fd);
            applied.held = holdOn(p.abs, inode);
          } finally {
            closeSync(fd);
          }
          if (pc?.command && !noCheck && !ran.includes("the parse check")) ran.push("the parse check");
          const verdict = parses && !noCheck ? await parses() : null;
          if (parses && !noCheck && verdict === null) noCheck = { key: "mutate.reason.checkNoAnswer" };
          if (verdict === false) r = { id: m.id, file: p.rel, outcome: "invalid", checked: true, reason: { key: "mutate.reason.parse" } };
          else {
            ran.push("the test command");
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
          writeJournal(root, journal, { pid: process.pid });
          sayNames();
        }
      }
      results.push(r);
      onResult(r);
    }
    return { restored, baseline, timeoutMs: limit, results };
  } finally {
    putBack();
    release();
    sayNames();
  }
}
