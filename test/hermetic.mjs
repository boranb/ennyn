/**
 * Loaded before every test file: `npm test` passes it to node with --import. Git reads the user's
 * ~/.gitconfig, the XDG config, ignore and attributes files, the system config and GIT_* variables; a
 * test that inherits them passes on one machine and fails on another (commit.gpgsign, a global ignore
 * of "*", a core.hooksPath hook, a GIT_DIR leaked from a hook). Each test file, and every process it
 * starts, gets an empty home and none of those instead. A child given an environment of its own that
 * drops one of these values would read the machine's setup again (the system config, which no variable
 * can stand in for): such a call throws where the test makes it, and the test file fails at its end even
 * when the code under test caught the throw.
 *
 * The time zone is fixed at +05:30 with no daylight saving: fixtures put commits at noon UTC, so their
 * day holds, and a local day still differs from a UTC day. The locale is C, as tests read git's English
 * messages. A test about either sets its own. Git stops looking for a repository at the temporary
 * directory, which may sit inside one. test/hostile.mjs, imported first, makes every run a run on a
 * hostile machine. It is imported here, not given as a second --import, so every runner names one file
 * and the order is the order of these imports.
 */

import "./hostile.mjs";
import childProcess from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// A test that reads a file by a path relative to the working directory (npm test starts at the top) reads the
// repository without saying so, and test/guards.mjs cannot see it. Every test file starts in an empty directory,
// and no variable names the repository (npm's INIT_CWD and npm_package_json, the shell's PWD, its
// node_modules/.bin on PATH): a test that needs a file of it finds it from its own place, which the guards see.
const top = realpathSync.native(dirname(dirname(fileURLToPath(import.meta.url))));
// Its real path, and the spelling without macOS's /private (/tmp and /var are links into it).
const tops = [...new Set([top, top.replace(/^\/private(?=\/(?:tmp|var|etc)\/)/, "")])];
const inTop = (/** @type {string} */ p) => tops.some((t) => p === t || p.startsWith(t + sep));
/** A path that names the repository as written, or once resolved (`x/../`, `//`, a link, another case on a disk that ignores case). */
const names = (/** @type {string} */ p) => {
  if (inTop(p)) return true;
  if (!isAbsolute(p)) return false;
  try {
    return inTop(realpathSync.native(p));
  } catch {
    return inTop(normalize(p));
  }
};
/** Its path inside other text (`--root=<repo>`, JSON), up to a separator or the end of a name. */
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentioned = new RegExp(`(?:${tops.map(esc).join("|")})(?=$|[/\\\\\\s"',;:}\\]])`);
const start = mkdtempSync(join(tmpdir(), "en-cwd-"));
process.chdir(start);
for (const [k, v = ""] of Object.entries(process.env)) {
  if (k === "PATH") process.env.PATH = v.split(delimiter).filter((p) => !names(p)).join(delimiter);
  else if (v.split(delimiter).some(names) || mentioned.test(v)) delete process.env[k];
}
process.env.PWD = start;

const home = mkdtempSync(join(tmpdir(), "en-home-"));
mkdirSync(join(home, ".config"));
// The one global setting: a CI checkout owned by another user is marked safe in a config dropped here.
writeFileSync(join(home, ".gitconfig"), "[safe]\n\tdirectory = *\n");
// ENNYN_CONFIG too: a developer's override would change which config every CLI test loads. ENNYN_PLUGIN_DATA and
// Claude Code's plugin variables: a suite run from a plugin session would write the developer's plugin record.
// CLAUDE_CONFIG_DIR: the block of a project's own hook (hookBlock) reads the developer's record through it.
const PLUGIN_VARS = ["ENNYN_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "CLAUDE_CONFIG_DIR"];
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_") || k === "ENNYN_CONFIG" || PLUGIN_VARS.includes(k)) delete process.env[k];
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: [...new Set([tmpdir(), realpathSync(tmpdir())])].join(delimiter),
  TZ: "Asia/Kolkata",
  LC_ALL: "C",
});

/** What a child's own environment must still hold; a test about the time zone or locale sets another value. */
const KEPT = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES", "TZ", "LC_ALL"];
/** Refused calls, kept: the code under test may catch the throw and carry on. */
const refused = /** @type {string[]} */ ([]);
/** Fetches off the machine, refused and kept: the code under test may catch the rejection too. */
const offline = /** @type {string[]} */ ([]);
process.on("exit", () => {
  if (!refused.length && !offline.length) return;
  if (refused.length) process.stderr.write(`test/hermetic.mjs: ${refused.length} child process call(s) dropped the test setup:\n${refused.join("\n")}\n`);
  if (offline.length) process.stderr.write(`test/hermetic.mjs: ${offline.length} fetch(es) off the machine refused:\n${offline.join("\n")}\n`);
  process.exitCode = 1;
});

// A test reaches no network: fetch goes to a loopback host only (the deps tests' registries listen on 127.0.0.1).
// node:http and node:https are not watched, nor a child's own connections.
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (LOOPBACK.includes(url.hostname)) return realFetch(input, init);
  const message = `test/hermetic.mjs: a fetch of ${JSON.stringify(url.host)} refused: a test reaches no network`;
  offline.push(message);
  return Promise.reject(new TypeError(message));
};

// Every temporary directory of the file lies under the hostile root (TMPDIR points into it, and the start and home
// directories above were made there): it goes when the file ends. Left in place, each run of the suite kept some
// 15 MB a file in the system's temporary folder; cycle 2026-10-24 (9) found 160 GB of them, and a full disk.
const hostileRoot = process.env.ENNYN_HOSTILE_HOME;
process.on("exit", () => {
  if (!hostileRoot) return;
  try {
    rmSync(hostileRoot, { recursive: true, force: true });
  } catch {
    // A fault test left a directory it made unreadable: open the tree up, then remove it.
    const open = (/** @type {string} */ d) => {
      try {
        chmodSync(d, 0o700);
        for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(join(d, e.name));
      } catch {
        // as much as can be opened
      }
    };
    open(hostileRoot);
    try {
      rmSync(hostileRoot, { recursive: true, force: true });
    } catch {
      // what is left stays; the test's result does not change for it
    }
  }
});

/** The refused calls so far, cleared: for a test that makes them on purpose. */
export function takeRefused() {
  return refused.splice(0);
}

/** @param {string} name @param {unknown[]} args */
function guard(name, args) {
  const opts = /** @type {{ env?: NodeJS.ProcessEnv } | undefined} */ (args.slice(1).find((a) => a !== null && typeof a === "object" && !Array.isArray(a)));
  if (!opts?.env) return;
  const env = opts.env;
  const missing = [...(env.GIT_CONFIG_NOSYSTEM === "1" ? [] : ["GIT_CONFIG_NOSYSTEM=1"]), ...KEPT.filter((k) => !env[k])];
  if (!missing.length) return;
  const at = (new Error().stack ?? "").split("\n").find((l) => l.includes("file://") && !l.includes("/test/hermetic.mjs")) ?? "";
  const message = `test/hermetic.mjs: ${name} got an env without ${missing.join(", ")}; that child would read the machine's setup. Spread process.env into it. ${at.trim()}`;
  refused.push(message);
  throw new Error(message);
}
// The sync calls hand `input` to the child through a pipe node writes and then shuts down. Under load on macOS
// the shutdown was lost about once in 100,000 calls: the child sat in read() on its stdin, node in kevent holding
// the write end, with no timeout (cycle 2026-11-06 (24): two short suites hung over an hour in ci.test.mjs). The
// input goes through a file instead, so the child reads it to its end with nothing left for node to finish. With
// stdio now given, an exec*Sync call no longer copies the child's stderr to this process's; it still captures it.
// Only a call a file under test/ makes: product code under test runs its children as in production (a pipe gives
// EPIPE to a child that exits unread and ESPIPE to one that seeks), and bounds them with a timeout of its own. The
// caller is read from V8's call sites, not the stack's text (a path may hold `(`, `%`, `#`; a CommonJS file is a
// plain path), with this file's own limit and format. A caller that cannot be read (no file: eval, new Function)
// gets a file too: a test call misread as product code would hang, a product call misread loses only the pipe.
const testDir = dirname(fileURLToPath(import.meta.url)) + sep;
/** Whether the frame that called child_process, past this file's own, is known to lie outside test/. */
function outsideTest() {
  const limit = Error.stackTraceLimit;
  const prepare = Error.prepareStackTrace;
  /** @type {NodeJS.CallSite[]} */
  let sites = [];
  try {
    Error.stackTraceLimit = 20;
    Error.prepareStackTrace = (_, s) => s;
    const holder = /** @type {{ stack?: unknown }} */ ({});
    Error.captureStackTrace(holder);
    sites = Array.isArray(holder.stack) ? holder.stack : [];
  } finally {
    Error.stackTraceLimit = limit;
    Error.prepareStackTrace = prepare;
  }
  const file = sites.map((c) => c.getFileName()).find((f) => f !== import.meta.url);
  if (!file) return false;
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  return isAbsolute(path) && !path.startsWith(testDir);
}
let inputDir = "";
let inputs = 0;
/** The call with its input as a file on stdin, or null where node would pipe nothing. @param {unknown[]} args */
function inputFile(args) {
  const at = args.findIndex((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a));
  const opts = /** @type {{ input?: unknown, encoding?: BufferEncoding, stdio?: unknown }} */ (args[at]);
  if (at < 0 || !opts.input) return null;
  const stdio = opts.stdio ?? "pipe";
  const first = Array.isArray(stdio) ? stdio[0] : stdio;
  if (first != null && first !== "pipe" && first !== "overlapped") return null;
  const { input } = opts;
  let bytes;
  try {
    if (typeof input === "string") bytes = Buffer.from(input, opts.encoding);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } catch {
    // node refuses the call itself
  }
  if (!bytes) return null;
  const path = join((inputDir ||= mkdtempSync(join(tmpdir(), "en-input-"))), String(inputs++));
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  const { input: _, ...rest } = opts;
  const call = [...args];
  call[at] = { ...rest, stdio: [fd, ...(Array.isArray(stdio) ? stdio.slice(1) : [stdio, stdio])] };
  return { call, fd, path };
}
const cp = /** @type {Record<string, any>} */ (childProcess);
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[name];
  const guarded = (/** @type {unknown[]} */ ...args) => {
    guard(name, args);
    const file = name.endsWith("Sync") && !outsideTest() ? inputFile(args) : null;
    if (!file) return original(...args);
    try {
      return original(...file.call);
    } finally {
      closeSync(file.fd);
      rmSync(file.path, { force: true });
    }
  };
  // util.promisify(execFile) calls the original through this symbol; it is guarded too.
  const custom = original[promisify.custom];
  if (custom) guarded[promisify.custom] = (/** @type {unknown[]} */ ...args) => (guard(name, args), custom(...args));
  cp[name] = guarded;
}
syncBuiltinESMExports();

// A test file's process that ends at exit 0 before node's run in it ended never ran the tests it had yet to register
// or run, and node --test passes it. Where no file sends a summary of its own (Node before 22.12, the floor), every
// test it had queued may have ended, so test/tally.mjs cannot see it either. Two ends are refused here:
// - before the file finished loading (a process.exit after a top-level await): the file's main module is imported by
//   its URL, which node shares with its own load of the entry (the file is evaluated once, after this setup), and
//   until that import settles the file has not loaded;
// - by an explicit exit once it loaded, before the event loop drained (no beforeExit came): a process.exit(0) in a
//   timer, a callback or a test while tests were still to be registered or run. A run node --test ends itself
//   (--test-force-exit, which no runner passes) has no beforeExit either, and only the first is refused there.
// A file that throws as it loads keeps node's own failure; an end with a code of its own is left to node. Not seen: a
// process whose loop drains with tests still to register (an unref'd timer), and a file's own exit listener that
// sets the code back to 0 after this one. A second --import named after this file runs
// after the file has loaded.
// Only a test file's own process: node --test starts it with NODE_TEST_CONTEXT=child-v8, which every process the file
// starts inherits too, so the file's process leaves TEST_FILE_MARK for them, and a process that finds it is no test
// file. A run started from inside a test file (a test of the runner) reaches its files' processes only when it drops
// the mark, as it drops NODE_TEST_CONTEXT.
export const TEST_FILE_MARK = "ENNYN_TEST_FILE_PID";
const entry = process.argv[1];
if (process.env.NODE_TEST_CONTEXT === "child-v8" && !process.env[TEST_FILE_MARK] && entry) {
  process.env[TEST_FILE_MARK] = String(process.pid);
  // node refuses --test-force-exit in NODE_OPTIONS (exit 9): on the command line only.
  const forced = process.execArgv.includes("--test-force-exit");
  let loaded = false;
  let drained = false;
  const settled = () => {
    loaded = true;
  };
  import(pathToFileURL(entry).href).then(settled, settled);
  process.on("beforeExit", () => {
    drained = true;
  });
  process.on("exit", (code) => {
    if (code !== 0) return;
    let why = "";
    if (!loaded) why = "its process ended at exit 0 before the file finished loading, so the tests it registers after that point never ran";
    else if (!drained && !forced) why = "its process ended at exit 0 by an explicit exit before its run did, so the tests it had yet to register or run never ran";
    if (!why) return;
    process.stderr.write(`test/hermetic.mjs: ${entry}: ${why}\n`);
    process.exitCode = 1;
  });
}
