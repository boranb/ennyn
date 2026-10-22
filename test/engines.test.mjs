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
import { GIT_FLOOR } from "../core/git.mjs";
import { nodeFloor, versionIs, runs, NEWER, FLOOR_BASE } from "./linux-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

/**
 * The workflow, whole. Any other line could keep the floors from being tested (a condition, a second
 * setup-node, continue-on-error, a trigger filtered to no branch, a step that runs something else, a comment a
 * reader takes for the end of the job), so the test owns the text: a change to the workflow is made here too,
 * on purpose. Its one condition is on purpose: both jobs are skipped in a private repository unless started
 * by hand, so CI spends no metered minutes on what the Linux run before each push already ran.
 */
const WORKFLOW = `# The suite on Linux at the floors (git, and the Node of package.json's engines) and on newer Node majors:
# \`npm run test:linux\`, the script that also runs before each push. test/engines.test.mjs holds this text whole.
# In a private repository a push or pull request starts no job: a private repository's runs draw on
# metered Actions minutes, and the same script runs before each push (.claude/CLAUDE.md). Started by hand it
# runs anyway. Once the repository is public, every push and pull request runs it, at no cost.
name: test

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    if: github.event_name == 'workflow_dispatch' || !github.event.repository.private
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The hygiene test reads every commit message.
          fetch-depth: 0
      - run: npm run test:linux

  typecheck:
    if: github.event_name == 'workflow_dispatch' || !github.event.repository.private
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm ci
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
  assert.match(String(list[0].build), new RegExp(`^FROM node:${floor.replace(/\./g, "\\.")} AS node\nFROM ${FLOOR_BASE}\n`));
  // git itself; tzdata, or git reads the hostile machine's far time zone as UTC; ssh-keygen for the signing test.
  assert.match(String(list[0].build), /install .* git tzdata openssh-client /);
  assert.deepEqual(list.slice(1).map((r) => r.node), NEWER);
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
