/**
 * package.json says which Node the CLI and its hooks run on; only a run on that Node shows it. For a
 * cycle the suite failed on Node 20 and nothing said so, and a hand run on Node 20.11 missed that Node
 * before 20.11 loads two --import modules at the same time (the hostile machine then won over the setup
 * that clears it). The CI workflow runs the suite on the floor first; this keeps the floor in
 * package.json, the lock file, the workflow and both READMEs the same.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

/**
 * The floor of a ">=X[.Y[.Z]]" range as [X, Y, Z]; any other range form has no single floor to run.
 * @param {string} range
 */
function floorOf(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/**
 * The Node versions of the workflow's test matrix, in order, from its one `node: [...]` line.
 * @param {string} yaml
 */
function matrixNodes(yaml) {
  const lines = yaml.split("\n").filter((l) => /^\s+node:\s*\[/.test(l));
  if (lines.length !== 1) return null;
  const list = /\[(.*)\]/.exec(lines[0])?.[1] ?? "";
  return list.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * The workflow, whole, for a floor and the newer majors. Any other line could keep the floor from being
 * tested (a condition, a matrix exclude, a second setup-node, continue-on-error, a trigger filtered to no
 * branch, a comment a reader takes for the end of the job), so the test owns the text: a change to the
 * workflow is made here too, on purpose. Its one condition is on purpose: both jobs, every Node alike, are
 * skipped in a private repository unless started by hand, so CI spends no metered minutes
 * on what the Linux run before each push already ran.
 * @param {string} floor @param {string[]} newer
 */
function workflow(floor, newer) {
  return `# The suite on the oldest Node that package.json's engines allows, and on current ones.
# test/engines.test.mjs keeps the first matrix entry equal to that floor, and holds this text whole.
# In a private repository a push or pull request starts no job: a private repository's runs draw on
# metered Actions minutes, and the same suite runs on Linux before each push (.ennyn/handoff.md). Started by
# hand it runs anyway. Once the repository is public, every push and pull request runs it, at no cost.
name: test

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    if: github.event_name == 'workflow_dispatch' || !github.event.repository.private
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [${[floor, ...newer].map((v) => `"${v}"`).join(", ")}]
    steps:
      - uses: actions/checkout@v4
        with:
          # The hygiene test reads every commit message.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: node --version && git --version
      - run: npm test

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
}

test("engines: the floor parses from the range forms package.json uses, and nothing else", () => {
  assert.deepEqual(floorOf(">=20"), [20, 0, 0]);
  assert.deepEqual(floorOf(">=20.6"), [20, 6, 0]);
  assert.deepEqual(floorOf(">= 20.11.1"), [20, 11, 1]);
  for (const other of ["^20", "20.x", ">=20 <25", "*", "", ">20"]) assert.equal(floorOf(other), null, other);
  assert.deepEqual(matrixNodes('    strategy:\n      matrix:\n        node: ["20.0.0", "22", \'24\']\n'), ["20.0.0", "22", "24"]);
  assert.equal(matrixNodes("node: 20"), null, "no list, no matrix");
  assert.equal(matrixNodes('        node: ["20"]\n        node: ["22"]\n'), null, "two lists are ambiguous");
});

test("engines: CI runs the suite first on the exact floor of package.json, then on newer majors", () => {
  const pkg = JSON.parse(read("package.json"));
  const floor = floorOf(pkg.engines?.node ?? "");
  assert.ok(floor, `engines.node "${pkg.engines?.node}" is not ">=X[.Y[.Z]]"`);
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.packages[""].engines?.node, pkg.engines.node, "package-lock.json carries the same range");

  const yaml = read(".github/workflows/test.yml");
  const nodes = matrixNodes(yaml);
  assert.ok(nodes?.length, "the workflow has one node: [...] matrix");
  // An exact version: "20" would install the newest 20.x, which is not the floor.
  assert.equal(nodes[0], floor.join("."), "the first matrix entry is the floor, written in full");
  for (const v of nodes.slice(1)) assert.ok(/^\d+$/.test(v) && Number(v) > floor[0], `${v} is a newer major than the floor`);
  // The rest of the file, line for line: setup-node installs the matrix entry, the test job runs npm test on
  // a full clone (the hygiene test reads every commit message), on every push of a public repository and on
  // every run started by hand, with nothing to skip a Node.
  assert.equal(yaml, workflow(nodes[0], nodes.slice(1)));
});

test("engines: both READMEs name the floor's major version", () => {
  const major = floorOf(JSON.parse(read("package.json")).engines.node)?.[0];
  assert.match(read("README.md"), new RegExp(`needs Node ${major} or later`));
  assert.match(read("README.tr.md"), new RegExp(`Node ${major} ya da üstünü ister`));
});
