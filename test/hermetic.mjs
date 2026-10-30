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
 * hostile machine. It is imported here, not given as a second --import: Node before 20.11 loads
 * --import modules at the same time, and under load the hostile machine was set up after this setup
 * cleared it (15 of 60 parallel starts on Node 20.6 and 20.10).
 */

import "./hostile.mjs";
import childProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
const cp = /** @type {Record<string, any>} */ (childProcess);
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[name];
  const guarded = (/** @type {unknown[]} */ ...args) => (guard(name, args), original(...args));
  // util.promisify(execFile) calls the original through this symbol; it is guarded too.
  const custom = original[promisify.custom];
  if (custom) guarded[promisify.custom] = (/** @type {unknown[]} */ ...args) => (guard(name, args), custom(...args));
  cp[name] = guarded;
}
syncBuiltinESMExports();
