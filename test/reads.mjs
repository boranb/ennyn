/**
 * The preload `test:short --record` gives every process of a recording run: it notes each file of the repository a
 * process opens, lists, copies, stats or loads as a module, against the test file that started it. Inert unless
 * ENNYN_READS names the run's folder, which holds `root` (the repository's real path) and `bin/node` (a node that
 * loads this file first, put first on PATH). The run copies this file there and names it in NODE_OPTIONS too, so it
 * imports nothing of the repository and no path of it rides in the environment (test/hermetic.mjs drops those).
 *
 * Not seen: a read through a file descriptor another process opened. Not measured: what a worker thread reads (no test starts one).
 *
 * A process writes `p-<pid>-<n>` in the folder, a line at a time as it reads, so a killed process keeps what it
 * read: `test\t<file>` first (the test file node --test started, inherited by every child through
 * ENNYN_READS_TEST), then `r\t<path>` for a file and `d\t<path>` for a listing or a tree copied whole. A read this
 * process cannot see is `*\t<why>`: a child started without this file (an environment without it, a PATH whose
 * first node is another), or a program that is not node working in the repository or handed a path in it (git reads
 * the tree, `sh -c 'cat "$F"'` a file; the recording cannot see what they read). The run reads `*` as every file. A
 * path read is named by its real target when it lies outside the tree as written (a link into it).
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.ENNYN_READS;
if (dir) start(dir);

/** @param {string} dir */
function start(dir) {
  const real = { ...fs };
  const top = real.readFileSync(join(dir, "root"), "utf8").trim();
  const tops = [...new Set([top, top.replace(/^\/private(?=\/(?:tmp|var|etc)\/)/, "")])];
  const self = join(dir, "reads.mjs");
  const bin = join(dir, "bin");

  /** The repository-relative spelling of a path, or null for a path outside it. @param {unknown} p */
  const inside = (p) => {
    let s;
    if (typeof p === "string") s = p;
    else if (p instanceof URL) s = p.protocol === "file:" ? fileURLToPath(p) : null;
    else if (Buffer.isBuffer(p)) s = p.toString();
    if (!s) return null;
    const abs = resolve(s);
    const named = within(abs);
    if (named !== null) return named;
    // A link from outside the tree into it: its real target decides.
    if (!real.existsSync(abs)) return null;
    try {
      return within(real.realpathSync.native(abs));
    } catch {
      return null;
    }
  };
  /** @param {string} abs */
  const within = (abs) => {
    for (const t of tops) {
      if (abs === t) return "";
      if (abs.startsWith(t + sep)) return abs.slice(t.length + 1).split(sep).join("/");
    }
    return null;
  };

  let test = process.env.ENNYN_READS_TEST;
  if (!test) {
    const named = inside(process.argv[1]);
    if (named && /^test\/[^/]+\.test\.mjs$/.test(named)) process.env.ENNYN_READS_TEST = test = named;
  }
  const out = real.openSync(join(dir, `p-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`), "a");
  real.writeSync(out, `test\t${test ?? ""}\n`);
  const seen = new Set();
  /** @param {string} kind @param {string} what */
  const say = (kind, what) => {
    const line = `${kind}\t${what}\n`;
    if (seen.has(line)) return;
    seen.add(line);
    real.writeSync(out, line);
  };
  /** @param {string} kind @param {unknown} p */
  const note = (kind, p) => {
    const rel = inside(p);
    if (rel === null || rel === ".git" || rel.startsWith(".git/")) return;
    if (kind === "r" && seen.has(`d\t${rel}\n`)) return;
    if (kind === "r" && !seen.has(`r\t${rel}\n`)) {
      // A folder, or a path not there yet, answers otherwise once something comes to lie below it: a listing. The top
      // answers the same on every branch.
      const st = real.statSync(join(top, rel), { throwIfNoEntry: false });
      if (!st || st.isDirectory()) {
        if (rel !== "") say("d", rel);
        return;
      }
    }
    say(kind, rel);
  };

  // Module loads, by import or require.
  if (typeof registerHooks !== "function") say("*", `node ${process.version} has no module.registerHooks`);
  else {
    registerHooks({
      load(url, context, next) {
        if (url.startsWith("file:")) note("r", new URL(url));
        return next(url, context);
      },
    });
  }

  /** @param {Record<string, any>} on @param {string[]} names @param {(args: unknown[]) => string} kind */
  const wrap = (on, names, kind) => {
    for (const name of names) {
      const original = on[name];
      if (typeof original !== "function") continue;
      const wrapped = function (/** @type {unknown[]} */ ...args) {
        note(kind(args), args[0]);
        return original.apply(this, args);
      };
      for (const key of Object.keys(original)) /** @type {any} */ (wrapped)[key] = original[key];
      on[name] = wrapped;
    }
  };
  const file = () => "r";
  const listing = () => "d";
  wrap(fs, ["readFileSync", "readFile", "existsSync", "exists", "statSync", "stat", "lstatSync", "lstat", "accessSync", "access", "openSync", "open", "createReadStream", "copyFileSync", "copyFile", "readlinkSync", "readlink", "realpathSync", "realpath", "openAsBlob"], file);
  wrap(fs, ["watch", "watchFile"], file);
  wrap(fs.realpathSync, ["native"], file);
  wrap(fs.realpath, ["native"], file);
  wrap(fs, ["readdirSync", "readdir", "opendirSync", "opendir", "cpSync", "cp", "globSync", "glob"], listing);
  wrap(fs.promises, ["readFile", "stat", "lstat", "access", "open", "copyFile", "readlink", "realpath", "watch"], file);
  wrap(fs.promises, ["readdir", "opendir", "cp", "glob"], listing);

  // Children: each one that runs this file records itself; one that cannot is said.
  const firstNode = new Map();
  /** The first directory on PATH that holds a node, or "" for none. @param {string} path */
  const nodeOn = (path) => {
    if (!firstNode.has(path)) {
      let found = "";
      for (const d of path.split(delimiter)) {
        if (!d) continue;
        try {
          real.accessSync(join(d, "node"), fs.constants.X_OK);
          found = d;
          break;
        } catch {
          // not here
        }
      }
      firstNode.set(path, found);
    }
    return firstNode.get(path);
  };
  /**
   * Where a child works: its cwd, or for git the directory its leading -C options name, and none when --git-dir and
   * --work-tree both name another place.
   * @param {string} program @param {string[]} list @param {string} cwd @returns {string | null}
   */
  const where = (program, list, cwd) => {
    if (basename(program) !== "git") return cwd;
    let at = cwd;
    /** @type {Record<string, string>} */
    const named = {};
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === "-C" && i + 1 < list.length) at = resolve(at, list[++i]);
      else if ((a === "--git-dir" || a === "--work-tree") && i + 1 < list.length) named[a] = resolve(at, list[++i]);
      else if (/^--(git-dir|work-tree)=/.test(a)) named[a.slice(0, a.indexOf("="))] = resolve(at, a.slice(a.indexOf("=") + 1));
      else if (a === "-c" && i + 1 < list.length) i++;
      else if (!a.startsWith("-")) break;
    }
    if (named["--git-dir"] && named["--work-tree"] && inside(named["--git-dir"]) === null && inside(named["--work-tree"]) === null) return null;
    return at;
  };
  const SHELL_SET = /^(?:PWD|OLDPWD|INIT_CWD|npm_.*)$/;
  /** @param {string} name @param {unknown[]} args */
  const child = (name, args) => {
    const shell = name === "exec" || name === "execSync";
    const program = shell ? "/bin/sh" : name === "fork" ? process.execPath : String(args[0]);
    const list = shell ? [String(args[0])] : Array.isArray(args[1]) ? args[1].map(String) : [];
    const opts = /** @type {{ env?: NodeJS.ProcessEnv, cwd?: unknown, shell?: unknown } | undefined} */ (args.slice(1).find((a) => a !== null && typeof a === "object" && !Array.isArray(a)));
    const env = opts?.env ?? process.env;
    const isNode = program === process.execPath || basename(program) === "node" || name === "fork";
    const why = [];
    if (env.ENNYN_READS !== dir) why.push("no ENNYN_READS");
    if (isNode && !(env.NODE_OPTIONS ?? "").includes(self) && !(program === join(bin, "node"))) why.push("node without the preload");
    const first = nodeOn(env.PATH ?? "");
    if (first && first !== bin) why.push("a PATH whose first node is another");
    if (!isNode && (inside(where(program, list, opts?.cwd === undefined ? process.cwd() : String(opts.cwd))) !== null || list.some((a) => tops.some((t) => a.includes(t))) || tops.some((t) => program.includes(t)))) why.push(`${basename(program)} in the repository`);
    // A program that is not node reads what it is handed: a path in the tree written whole in an environment value, or
    // an argument word that names one, as it is or from the child's working directory. What the shell and npm set for
    // where a run started is no input: test/hostile.mjs starts git before test/hermetic.mjs clears it.
    const at = opts?.cwd === undefined ? process.cwd() : String(opts.cwd);
    const words = (/** @type {string} */ v) => v.split(/[\s'"=:;|&<>()`]+/).filter((w) => w.includes("/") || w.startsWith("."));
    if (!isNode && (Object.entries(env).some(([k, v]) => !SHELL_SET.test(k) && typeof v === "string" && words(v).some((w) => isAbsolute(w) && inside(w) !== null)) || list.some((a) => words(a).some((w) => inside(resolve(at, w)) !== null)))) why.push(`${basename(program)} handed a path in the repository`);
    if (why.length) say("*", `${name} ${basename(program)}: ${why.join(", ")}`);
  };
  const cp = /** @type {Record<string, any>} */ (childProcess);
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = cp[name];
    const wrapped = (/** @type {unknown[]} */ ...args) => (child(name, args), original(...args));
    const custom = original[Symbol.for("nodejs.util.promisify.custom")];
    if (custom) wrapped[Symbol.for("nodejs.util.promisify.custom")] = (/** @type {unknown[]} */ ...args) => (child(name, args), custom(...args));
    cp[name] = wrapped;
  }
  syncBuiltinESMExports();
}
