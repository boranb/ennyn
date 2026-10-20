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
 * directory, which may sit inside one. test/hostile.mjs, loaded just before, makes every run a run on a
 * hostile machine.
 */

import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const home = mkdtempSync(join(tmpdir(), "en-home-"));
mkdirSync(join(home, ".config"));
// The one global setting: a CI checkout owned by another user is marked safe in a config dropped here.
writeFileSync(join(home, ".gitconfig"), "[safe]\n\tdirectory = *\n");
// ENNYN_CONFIG too: a developer's override would change which config every CLI test loads.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_") || k === "ENNYN_CONFIG") delete process.env[k];
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
/** Refused calls, kept: the code under test may catch the throw (git's allowFail) and carry on. */
const refused = /** @type {string[]} */ ([]);
process.on("exit", () => {
  if (!refused.length) return;
  process.stderr.write(`test/hermetic.mjs: ${refused.length} child process call(s) dropped the test setup:\n${refused.join("\n")}\n`);
  process.exitCode = 1;
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
