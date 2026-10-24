/**
 * Tests that read the user's git config failed on one machine and passed on another four times in one
 * cycle (a unit test reading ~/.gitconfig, a global ignore, ssh-keygen -Y, and the bypass, CLI and hook
 * tests). `npm test` now loads test/hermetic.mjs into every test file: it imports test/hostile.mjs, a
 * hostile machine, and then clears it. Here: the script still loads it, as one module, and this file,
 * like every other, sees none of the hostile values.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { exec, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostileHome } from "./hostile.mjs";
import { takeRefused } from "./hermetic.mjs";
import { hookCommitMode } from "../checks/commit-shape.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("hermetic: npm test loads the hostile machine, then the setup that clears it, into every test file", () => {
  const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test;
  // One --import: Node before 20.11 loads several at once, so their order is not the order written.
  assert.match(script, /^node --test --import \.\/test\/hermetic\.mjs test\/\*\.test\.mjs$/);
  const first = readFileSync(join(ROOT, "test", "hermetic.mjs"), "utf8").split("\n").find((l) => l.startsWith("import "));
  assert.equal(first, 'import "./hostile.mjs";', "the hostile machine is the setup's first import");
  // Started from a git hook, the run has a GIT_DIR of its own; the decoy repository is still made where it is named.
  process.env.GIT_DIR = join(mkdtempSync(join(tmpdir(), "en-hook-run-")), "elsewhere.git");
  let env;
  try {
    env = hostileHome(mkdtempSync(join(tmpdir(), "en-hostile-")));
  } finally {
    delete process.env.GIT_DIR;
  }
  assert.ok(existsSync(join(env.GIT_WORK_TREE, ".git", "HEAD")), "the decoy repository");
  for (const k of ["TMPDIR", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_DIR", "GIT_INDEX_FILE", "ENNYN_CONFIG", "TZ", "LC_ALL"]) {
    assert.ok(env[k], k);
  }
  const read = (/** @type {string} */ key) => spawnSync("git", ["config", "--file", env.GIT_CONFIG_GLOBAL, "--get", key], { encoding: "utf8" }).stdout.trim();
  assert.deepEqual([read("commit.gpgsign"), read("core.excludesFile").length > 0, read("core.hooksPath").length > 0], ["true", true, true]);
});

test("hermetic: after the hostile machine, git here reads no config but the repository's, and no GIT_* value", () => {
  const hostile = process.env.ENNYN_HOSTILE_HOME;
  assert.ok(hostile, "run the suite with npm test: it loads test/hermetic.mjs, which imports test/hostile.mjs");
  assert.ok(!(process.env.HOME ?? "").startsWith(join(hostile, "home")), "HOME");
  assert.ok(!(process.env.XDG_CONFIG_HOME ?? "").startsWith(join(hostile, "xdg")), "XDG_CONFIG_HOME");
  assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).sort(), ["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
  const global = /** @type {string} */ (process.env.GIT_CONFIG_GLOBAL);
  assert.equal(readFileSync(global, "utf8"), "[safe]\n\tdirectory = *\n");
  assert.equal(process.env.ENNYN_CONFIG, undefined);
  assert.deepEqual([process.env.TZ, process.env.LC_ALL], ["Asia/Kolkata", "C"]);
  assert.notEqual(new Date(Date.UTC(2026, 0, 1, 20)).getDate(), 1, "a local day is not a UTC day");
  // The temporary directory sits in the hostile machine's decoy repository; git does not find it.
  const outside = mkdtempSync(join(tmpdir(), "en-herm-out-"));
  assert.ok(realpathSync(outside).startsWith(realpathSync(hostile)));
  assert.notEqual(spawnSync("git", ["rev-parse", "--git-dir"], { cwd: outside }).status, 0);
  // Plain git, not the helper: its own -c values would read as "command line".
  const dir = mkdtempSync(join(tmpdir(), "en-herm-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const fields = spawnSync("git", ["config", "--list", "--show-origin", "-z"], { cwd: dir, encoding: "utf8" }).stdout.split("\0");
  assert.deepEqual([...new Set(fields.filter((f, i) => i % 2 === 0 && f))].sort(), [`file:${global}`, "file:.git/config"].sort());
});

test("hermetic: a child given its own environment that drops the setup is refused where the test makes it, and remembered", async () => {
  assert.deepEqual(takeRefused(), [], "nothing refused before this test");
  const { GIT_CONFIG_NOSYSTEM: _, ...stripped } = process.env;
  const refused = /got an env without GIT_CONFIG_NOSYSTEM=1; that child would read the machine's setup/;
  assert.throws(() => spawnSync("git", ["--version"], { env: stripped }), refused);
  assert.throws(() => execFileSync("git", ["--version"], { env: { PATH: process.env.PATH } }), /without GIT_CONFIG_NOSYSTEM=1, HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, GIT_CEILING_DIRECTORIES, TZ, LC_ALL;/);
  assert.throws(() => exec("git --version", { env: stripped }), refused);
  assert.throws(() => promisify(execFile)("git", ["--version"], { env: stripped }), refused);
  // git reads "0" as false; a dropped time zone is the machine's.
  assert.throws(() => spawnSync("git", ["--version"], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "0" } }), refused);
  const { TZ: __, ...noZone } = process.env;
  assert.throws(() => spawnSync("date", [], { env: noZone }), /without TZ;/);
  // Caught where it is made (code under test may catch a git failure and carry on) it is still on record,
  // and would fail this file at exit.
  const dir = mkdtempSync(join(tmpdir(), "en-herm-swallow-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  try {
    hookCommitMode({ cwd: dir, message: "feat: x\n", env: { PATH: process.env.PATH, GIT_EDITOR: ":" } });
    assert.fail("a refused git call is no unset key");
  } catch (e) {
    assert.match(String(/** @type {Error} */ (e).message), /got an env without GIT_CONFIG_NOSYSTEM=1, HOME/);
  }
  assert.equal(takeRefused().length, 6 + 1, "the six refused calls above, and the first git call inside hookCommitMode");
  // An inherited environment, or one built from process.env, runs.
  assert.equal(spawnSync("git", ["--version"]).status, 0);
  assert.equal(spawnSync("git", ["--version"], { env: { ...process.env, LC_ALL: "C" } }).status, 0);
  assert.match((await promisify(execFile)("git", ["--version"], { env: { ...process.env } })).stdout, /^git version/);
});

test("hermetic: a test file whose code swallows a refused call still fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-herm-file-"));
  const file = join(dir, "swallow.test.mjs");
  writeFileSync(file, [
    'import { test } from "node:test";',
    'import { spawnSync } from "node:child_process";',
    'test("swallows", () => { try { spawnSync("git", ["--version"], { env: { PATH: process.env.PATH } }); } catch {} });',
    "",
  ].join("\n"));
  // NODE_TEST_CONTEXT marks a process the runner started; with it the inner run would skip the file.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--test", "--import", pathToFileURL(join(ROOT, "test", "hermetic.mjs")).href, file], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout + run.stderr, /1 child process call\(s\) dropped the test setup/);
});

test("hermetic: every test file starts in an empty directory of its own, and no variable names the repository", () => {
  const top = realpathSync(ROOT);
  const inTop = (/** @type {string} */ p) => p === top || p.startsWith(top + sep) || p === ROOT || p.startsWith(ROOT + sep);
  const cwd = process.cwd();
  assert.ok(!inTop(cwd), `the working directory is the repository's: ${cwd}`);
  // A read by a path relative to the working directory finds nothing of the repository.
  assert.deepEqual([existsSync("package.json"), existsSync(join("test", "hermetic.mjs"))], [false, false]);
  assert.equal(realpathSync(String(process.env.PWD)), realpathSync(cwd), "PWD is where the file runs");
  const named = Object.entries(process.env).filter(([, v = ""]) => v.split(delimiter).some(inTop) || v.includes(top + sep) || v.includes(ROOT + sep));
  assert.deepEqual(named.map(([k]) => k), [], "variables that name the repository (npm sets INIT_CWD and npm_package_json, the shell PWD)");
  // Started as npm starts it (from the top, npm's variables, the repository's node_modules/.bin on PATH), and with
  // other spellings of its path (review round one): each variable listed as gone is gone, each kept one is kept.
  const parent = dirname(top);
  /** @type {Record<string, string>} */
  const gone = {
    INIT_CWD: ROOT,
    npm_package_json: join(ROOT, "package.json"),
    npm_config_local_prefix: ROOT,
    OLDPWD: ROOT,
    EN_DOTDOT: `${parent}/x/../${basename(top)}`,
    EN_DOUBLE: `${parent}//${basename(top)}`,
    EN_FLAG: `--root=${top}`,
    EN_JSON: JSON.stringify({ root: top }),
  };
  // macOS: /tmp and /var are links into /private.
  if (/^\/private\/(?:tmp|var)\//.test(top)) {
    gone.EN_ALIAS = top.replace(/^\/private/, "");
    gone.EN_ALIAS_FLAG = `--root=${gone.EN_ALIAS}`;
  }
  /** @type {Record<string, string>} */
  const kept = { EN_SIBLING: `${top}-other`, EN_PARENT: parent, EN_RELATIVE: "node_modules/.bin" };
  const dir = mkdtempSync(join(tmpdir(), "en-herm-cwd-"));
  const probe = join(dir, "probe.test.mjs");
  writeFileSync(probe, [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { realpathSync } from "node:fs";',
    'test("probe", () => {',
    `  assert.ok(!realpathSync(process.cwd()).startsWith(${JSON.stringify(top)}), process.cwd());`,
    `  assert.deepEqual(${JSON.stringify(Object.keys(gone))}.filter((k) => k in process.env), [], "left naming the repository");`,
    `  assert.deepEqual(${JSON.stringify(Object.keys(kept))}.filter((k) => !(k in process.env)), [], "removed though they name another place");`,
    `  assert.ok(!process.env.PATH.split(${JSON.stringify(delimiter)}).includes(${JSON.stringify(join(ROOT, "node_modules", ".bin"))}), "the repository's .bin on PATH");`,
    `  assert.ok(process.env.PATH.split(${JSON.stringify(delimiter)}).includes("node_modules/.bin"), "a relative PATH entry names no place");`,
    "});",
    "",
  ].join("\n"));
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const PATH = [join(ROOT, "node_modules", ".bin"), "node_modules/.bin", process.env.PATH].join(delimiter);
  const run = spawnSync(process.execPath, ["--test", "--import", pathToFileURL(join(ROOT, "test", "hermetic.mjs")).href, probe], { cwd: ROOT, env: { ...env, ...gone, ...kept, PWD: ROOT, PATH }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
