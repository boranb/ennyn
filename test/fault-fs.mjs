/**
 * Loaded with --import into a CLI run of test/fault-injection.test.mjs: counts the file system reads the
 * run makes outside Ennyn's own files (the project's config, graph, logs, instruction files, state) and
 * makes the k-th one fail, as a file without read permission (EACCES) or a directory in a file's place
 * (EISDIR). existsSync answers false, as Node does for any error. At exit
 * it writes the count and the calls it saw, one "<function> <path>" per line.
 *
 * ENNYN_FS_FAULT_DIR  where the count goes (no variable: nothing is wrapped)
 * ENNYN_FS_FAULT_AT   the call to fail, from 1 (0: none)
 * ENNYN_FS_FAULT      eacces | eisdir
 *
 * It also fails a git spawn with an errno, as the system gives one, before git runs: no fake git can stand for that.
 * ENNYN_SPAWN_FAULT_AT  the git spawn to fail, from 1 (0: none)
 * ENNYN_SPAWN_FAULT     the errno
 *
 * It also lowers the git call limits for a run whose fake git never ends, so a cell waits seconds, not minutes:
 * ENNYN_FAULT_GIT_LIMIT_MS  the limit of any git call; a call that walks the history gets twice that. Only this
 * file reads the variable: Ennyn's own limits come from no environment or config.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.ENNYN_FS_FAULT_DIR;
if (DIR) {
  const OWN = resolve(dirname(fileURLToPath(import.meta.url)), "..") + sep;
  const AT = Number(process.env.ENNYN_FS_FAULT_AT ?? 0);
  const KIND = process.env.ENNYN_FS_FAULT ?? "eacces";
  const writeFileSync = fs.writeFileSync;
  /** @type {string[]} */
  const seen = [];
  /** @param {unknown} p */
  const pathOf = (p) => (typeof p === "string" ? resolve(p) : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? resolve(p.toString()) : null);
  /**
   * @param {string} name @param {string} path
   * @returns {NodeJS.ErrnoException}
   */
  const failure = (name, path) => {
    const code = KIND === "eisdir" ? "EISDIR" : "EACCES";
    const text = { EACCES: "permission denied", EISDIR: "illegal operation on a directory" }[code];
    const syscall = { readdirSync: "scandir", statSync: "stat", lstatSync: "lstat", realpathSync: "realpath" }[name] ?? "open";
    return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, errno: code === "EACCES" ? -13 : -21, syscall, path });
  };
  /** Reads whose failure a project file can cause; `kinds` lists the faults that make sense for each. */
  const READS = /** @type {const} */ ({
    readFileSync: ["eacces", "eisdir"],
    openSync: ["eacces", "eisdir"],
    // A file in a directory's place is no directory: nothing there to list, which is no failure to report.
    readdirSync: ["eacces"],
    statSync: ["eacces"],
    lstatSync: ["eacces"],
    realpathSync: ["eacces"],
    existsSync: ["eacces"],
  });
  const f = /** @type {Record<string, any>} */ (fs);
  // readFileSync calls fs.openSync itself: one read is one call, the outer one.
  let inside = 0;
  for (const [name, kinds] of Object.entries(READS)) {
    const real = f[name];
    const wrapped = function (/** @type {any[]} */ ...args) {
      if (inside) return real.apply(this, args);
      const path = pathOf(args[0]);
      // A file descriptor, Ennyn's own files, or a write: not counted.
      // Flags as a number are a read unless they ask to write (O_RDONLY is 0; O_NONBLOCK and the like add no write).
      const flags = args[1];
      const write = name === "openSync" && flags !== undefined && (typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : flags !== "r");
      if (path === null || path.startsWith(OWN) || write || !(/** @type {readonly string[]} */ (kinds)).includes(KIND)) return real.apply(this, args);
      seen.push(`${name} ${path}`);
      if (seen.length === AT) {
        if (name === "existsSync") return false;
        throw failure(name, path);
      }
      inside++;
      try {
        return real.apply(this, args);
      } finally {
        inside--;
      }
    };
    // realpathSync.native and the like stay reachable.
    Object.assign(wrapped, real);
    f[name] = wrapped;
  }
  syncBuiltinESMExports();
  process.on("exit", () => {
    writeFileSync(join(DIR, "fs-count"), String(seen.length));
    writeFileSync(join(DIR, "fs-calls"), seen.join("\n"));
  });
}

const SPAWN_AT = Number(process.env.ENNYN_SPAWN_FAULT_AT ?? 0);
if (SPAWN_AT > 0) {
  const { default: cp } = await import("node:child_process");
  const code = process.env.ENNYN_SPAWN_FAULT;
  const { execFileSync, spawn, spawnSync } = cp;
  let n = 0;
  /** Whether this spawn is the one to fail. @param {string} file */
  const fails = (file) => (file === "git" || file.endsWith("/git")) && ++n === SPAWN_AT;
  /** As a spawn that fails throws. @param {string} file */
  const failure = (file) => Object.assign(new Error(`spawnSync ${file} ${code}`), { code, errno: -1, syscall: `spawnSync ${file}`, path: file, status: null, signal: null, stdout: null, stderr: null });
  const c = /** @type {any} */ (cp);
  c.execFileSync = (/** @type {string} */ file, /** @type {any[]} */ ...rest) => {
    if (fails(file)) throw failure(file);
    return /** @type {any} */ (execFileSync)(file, ...rest);
  };
  c.spawnSync = (/** @type {string} */ file, /** @type {any[]} */ ...rest) => {
    if (fails(file)) return { error: failure(file), status: null, signal: null, stdout: "", stderr: "", output: null, pid: 0 };
    return /** @type {any} */ (spawnSync)(file, ...rest);
  };
  c.spawn = (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ options) => {
    if (!fails(file)) return spawn(file, args, options);
    // A child that started no git, its error next, as a failed spawn reports it.
    const child = spawn(process.execPath, ["-e", ""], options);
    process.nextTick(() => child.emit("error", failure(file)));
    return child;
  };
  syncBuiltinESMExports();
}

const GIT_LIMIT = Number(process.env.ENNYN_FAULT_GIT_LIMIT_MS ?? 0);
if (GIT_LIMIT > 0) {
  const { GIT_LIMITS } = await import("../plugin/core/git.mjs");
  GIT_LIMITS.call = GIT_LIMIT;
  GIT_LIMITS.walk = 2 * GIT_LIMIT;
}
