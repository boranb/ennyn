/**
 * package.json says which Node the CLI and its hooks run on, and core/git.mjs which git; only a run on them
 * shows it. For a cycle the suite failed on Node 20 and nothing said so, and a hand run on Node 20.11 missed
 * that Node before 20.11 loads two --import modules at the same time (the hostile machine then won over the
 * setup that clears it); on git 2.30 four tests failed. `npm run test:linux` (test/linux-run.mjs) runs the
 * suite on both floors first and fails when a container reports another version; this keeps the floors in
 * package.json, the lock file, the script, the workflow and both READMEs the same.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_FLOOR, git } from "../core/git.mjs";
import { DEFAULTS } from "../core/config.mjs";
import { matchAny } from "../core/glob.mjs";
import { ciFindings, ciKind } from "../checks/ci.mjs";
import { nodeFloor, versionIs, runs, pinned, NEWER, FLOOR_BASE } from "./linux-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

/**
 * The workflow, whole. Any other line could keep the floors from being tested (a condition, a second
 * setup-node, continue-on-error, a trigger filtered to no branch, a step that runs something else, a comment a
 * reader takes for the end of the job), so the test owns the text: a change to the workflow is made here too,
 * on purpose. Its one condition is on purpose: both jobs are skipped in a private repository unless started
 * by hand, so CI spends no metered minutes on what the Linux run before a release already ran.
 */
const WORKFLOW = `# The suite on Linux at the floors (git, and the Node of package.json's engines) and on newer Node majors:
# \`npm run test:linux\`, the script that also runs before a release. test/engines.test.mjs holds this text whole.
# In a private repository a push or pull request starts no job: a private repository's runs draw on
# metered Actions minutes, and the same script runs before a release (.claude/CLAUDE.md). Started by hand it
# runs anyway. Once the repository is public, every push and pull request runs it, at no cost.
# Each action is named by its full commit SHA (a tag can be moved to other code), the token only reads,
# checkout leaves no credential in .git/config, and npm ci runs no install script.
name: test

on:
  push:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    if: github.event_name == 'workflow_dispatch' || !github.event.repository.private
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # The hygiene test reads every commit message.
          fetch-depth: 0
          persist-credentials: false
      - run: npm run test:linux

  typecheck:
    if: github.event_name == 'workflow_dispatch' || !github.event.repository.private
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"
      - run: npm ci --ignore-scripts
      - run: npm run typecheck
`;

test("engines: the Node floor parses from the range forms package.json uses, and nothing else", () => {
  assert.equal(nodeFloor(">=20"), "20.0.0");
  assert.equal(nodeFloor(">=20.6"), "20.6.0");
  assert.equal(nodeFloor(">= 20.11.1"), "20.11.1");
  for (const other of ["^20", "20.x", ">=20 <25", "*", "", ">20"]) assert.equal(nodeFloor(other), null, other);
});

test("engines: a container's version is the one named in every part the name gives", () => {
  assert.ok(versionIs("v20.0.0", "20.0.0"));
  assert.ok(versionIs("v22.21.0", "22"));
  assert.ok(versionIs("2.34.1", "2.34"));
  for (const [reported, named] of [["v20.19.5", "20.0.0"], ["v24.1.0", "22"], ["2.39.5", "2.34"], ["2.3.4", "2.34"], ["", "22"], ["vnext", "22"]]) {
    assert.ok(!versionIs(reported, named), `${reported} is not ${named}`);
  }
});

test("engines: the Linux run starts at both floors, then newer Node majors, and CI runs that run", () => {
  const pkg = JSON.parse(read("package.json"));
  const floor = nodeFloor(pkg.engines?.node ?? "");
  assert.ok(floor, `engines.node "${pkg.engines?.node}" is not ">=X[.Y[.Z]]"`);
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.packages[""].engines?.node, pkg.engines.node, "package-lock.json carries the same range");

  const list = runs(floor);
  assert.deepEqual([list[0].node, list[0].git], [floor, GIT_FLOOR], "the first run is at both floors");
  assert.match(String(list[0].build), new RegExp(`^FROM node:${floor.replace(/\./g, "\\.")}@sha256:[0-9a-f]{64} AS node\nFROM ${FLOOR_BASE}@sha256:[0-9a-f]{64}\n`));
  // git itself; tzdata, or git reads the hostile machine's far time zone as UTC; ssh-keygen for the signing test.
  assert.match(String(list[0].build), /install .* git tzdata openssh-client /);
  assert.deepEqual(list.slice(1).map((r) => r.node), NEWER);
  // Pulled by digest, the one each tag named when it was pinned.
  for (const r of list.slice(1)) assert.match(r.image, new RegExp(`^node:${r.node}@sha256:[0-9a-f]{64}$`));
  assert.throws(() => pinned("node:99"), /node:99 has no digest/, "an image with no digest stops the run");
  const major = Number(floor.split(".")[0]);
  NEWER.forEach((v, i) => assert.ok(/^\d+$/.test(v) && Number(v) > (i ? Number(NEWER[i - 1]) : major), `${v} is a newer major than the one before it`));

  assert.equal(pkg.scripts["test:linux"], "node test/linux-run.mjs");
  assert.equal(read(".github/workflows/test.yml"), WORKFLOW);
});

test("engines: both READMEs name the Node floor's major version and the git floor", () => {
  const major = nodeFloor(JSON.parse(read("package.json")).engines.node)?.split(".")[0];
  const git = GIT_FLOOR.replace(/\./g, "\\.");
  assert.match(read("README.md"), new RegExp(`needs Node ${major} or later and git ${git} or later`));
  assert.match(read("README.tr.md"), new RegExp(`Node ${major} ya da üstünü ve git ${git} ya da üstünü ister`));
});

test("engines: the repository's own CI files name every action by a commit, check out no pull request code and set permissions", () => {
  const files = git(["ls-files", "-z"], { cwd: ROOT }).split("\0").filter((f) => matchAny(f, DEFAULTS.security.ci.paths));
  assert.ok(files.includes(".github/workflows/test.yml"), "the workflow is read");
  for (const f of files) {
    const found = ciFindings(read(f), ciKind(f));
    assert.ok(found.uses.length || ciKind(f) === "action", `${f}: no uses read`);
    assert.deepEqual(
      { unpinned: found.uses.filter((u) => !u.pinned), pwn: found.pwn, unpermitted: found.unpermitted, writeAll: found.writeAll, unread: found.unread },
      { unpinned: [], pwn: [], unpermitted: [], writeAll: [], unread: [] },
      f,
    );
  }
});

/**
 * Builtin exports the Node floor lacks, from a run of every tracked file's named imports on the floor image
 * (Node 22.0.0). An import of one by name fails the whole file's load there, before any check of the version
 * runs: test:short could not start on the floor for a cycle. Such a name is read through a namespace import.
 */
const LATE = { module: ["registerHooks"] };

/** @param {string} text @returns {string[]} each late name the text imports or re-exports by name */
const lateImports = (text) =>
  [...text.matchAll(/\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?([\w/]+)["']/g)].flatMap((m) => {
    // Comments in the braces are dropped and a quoted name read as the name it quotes, as the parser reads them.
    const names = m[1]
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0].replace(/^(["'])(.*)\1$/, "$2"));
    return (LATE[/** @type {keyof typeof LATE} */ (m[2])] ?? []).filter((name) => names.includes(name)).map((name) => `${name} from node:${m[2]}`);
  });

test("engines: no tracked file imports by name a builtin export the Node floor lacks", () => {
  const named = [
    'import { registerHooks } from "node:module";',
    "import { a, registerHooks as hooks } from 'module';",
    'import m, {\n  registerHooks,\n} from "node:module";',
    'export { registerHooks } from "node:module";',
    'import {\n  // the hooks\n  registerHooks,\n} from "node:module";',
    'import { /* 22.15 */ registerHooks } from "node:module";',
    'import {\n  syncBuiltinESMExports, // x\n  registerHooks,\n} from "node:module";',
    'import { "registerHooks" as rh } from "node:module";',
    "import { 'registerHooks' as rh } from 'node:module';",
    'import { /* a */ registerHooks /* b */ } from "node:module";',
    'import { registerHooks/* x */as hooks } from "node:module";',
  ];
  for (const text of named) assert.deepEqual(lateImports(text), ["registerHooks from node:module"], text);
  const not = [
    'import * as nodeModule from "node:module";',
    'import { registerHooksLater, syncBuiltinESMExports } from "node:module";',
    'import { registerHooks } from "./module.mjs";',
    'import { registerHooks } from "node:modules";',
    'const { registerHooks } = nodeModule;',
  ];
  for (const text of not) assert.deepEqual(lateImports(text), [], text);
  // This file is left out: its lines above are text, not imports.
  const files = git(["ls-files", "-z"], { cwd: ROOT }).split("\0").filter((f) => /\.[cm]?js$/.test(f) && f !== "test/engines.test.mjs");
  assert.ok(files.includes("test/short.mjs"), "the test files are read");
  assert.deepEqual(files.flatMap((f) => lateImports(read(f)).map((late) => `${f}: ${late}`)), []);
});
