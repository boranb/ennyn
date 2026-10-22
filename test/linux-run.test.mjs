/**
 * The Linux run decides whether the floors pass, so its own decisions are tested here: what makes one
 * container's run fail, and the whole script run against a fake docker on PATH that answers as told
 * (docker down, an image that does not build, a container with the wrong version, a failure, a skip, a
 * run with fewer tests). A real run is `npm run test:linux`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeRun, summaryCount, failureDetails } from "./linux-run.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "linux-run.mjs");

/** @param {string} node @param {string} git @param {{ tests?: number, pass?: number, fail?: number, skipped?: number }} [n] */
const output = (node, git, { tests = 3, pass = tests, fail = 0, skipped = 0 } = {}) =>
  `versions: v${node} git version ${git}\nok 1 - a\n1..${tests}\n# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n`;

test("linux run: summary counts are the runner's own, the last at the start of a line, TAP or spec", () => {
  assert.equal(summaryCount("ok 1 - a\n1..284\n# tests 284\n# pass 284\n# fail 0\n", "pass"), "284");
  assert.equal(summaryCount("✔ a (1ms)\nℹ tests 284\nℹ pass 283\nℹ fail 1\n", "pass"), "283");
  // A failing test that quotes an inner run: its indented summary is not the run's.
  assert.equal(summaryCount("not ok 1 - x\n  ---\n  error: |-\n    # pass 0\n  ...\n# tests 5\n# pass 4\n", "pass"), "4");
  // A test that prints a line like the summary prints it before the runner does: the runner's comes last.
  assert.equal(summaryCount("# pass 99\nok 1 - a\n1..3\n# tests 3\n# pass 3\n", "pass"), "3");
  for (const out of ["", "npm ERR! missing script: test", "# passes 3", "ok 1 - pass 3", "  # pass 3"]) assert.equal(summaryCount(out, "pass"), undefined, out);
});

test("linux run: a container's run passes only with no failure, no skip, the named versions and exit 0", () => {
  const floor = { node: "20.0.0", git: "2.34" };
  assert.deepEqual(judgeRun({ out: output("20.0.0", "2.34.1"), status: 0, ...floor }).wrong, []);
  assert.equal(judgeRun({ out: output("22.21.0", "2.39.5"), status: 0, node: "22", git: null }).ok, true, "a newer major names no git");
  for (const [out, status, why] of /** @type {const} */ ([
    [output("20.0.0", "2.39.5"), 0, "git 2.39.5 is not 2.34"],
    [output("20.19.5", "2.34.1"), 0, "Node v20.19.5 is not 20.0.0"],
    [output("20.0.0", "2.34.1", { pass: 2, fail: 1 }), 1, "1 failed"],
    [output("20.0.0", "2.34.1", { pass: 2, skipped: 1 }), 0, "1 skipped"],
    [output("20.0.0", "2.34.1"), 1, "exit 1"],
    ["versions: v20.0.0 git version 2.34.1\nnpm ERR! missing script: test\n", 0, "no test summary in the output"],
    ["# tests 3\n# pass 3\n# fail 0\n# skipped 0\n", 0, "the container did not say its versions"],
    [output("20.0.0", "2.34.1").replace("# skipped 0\n", ""), 0, "an unknown number of skipped"],
  ])) {
    const verdict = judgeRun({ out, status, ...floor });
    assert.equal(verdict.ok, false, why);
    assert.ok(verdict.wrong.includes(why), `${why} in ${JSON.stringify(verdict.wrong)}`);
  }
  assert.ok(judgeRun({ out: output("20.0.0", "2.34.1"), status: null, signal: "SIGKILL", ...floor }).wrong.includes("exit SIGKILL"));
});

test("linux run: a failure shows each failing test with why, else the end of the output", () => {
  const out = "ok 1 - a\nnot ok 2 - b\n  ---\n  error: boom\n  ...\nok 3 - c\n# tests 3\n";
  assert.deepEqual(failureDetails(out), ["not ok 2 - b", "  ---", "  error: boom", "  ..."]);
  assert.deepEqual(failureDetails("a\nb\n"), ["a", "b"]);
  // A test inside a describe: its own reason, indented above the suite's "1 subtest failed".
  const nested = "# Subtest: s\n    not ok 1 - inner\n      ---\n      error: the real reason\n      ...\n    1..1\nnot ok 1 - s\n  ---\n  error: '1 subtest failed'\n  ...\n";
  assert.ok(failureDetails(nested).includes("      error: the real reason"), JSON.stringify(failureDetails(nested)));
});

/**
 * The script with a fake docker: `spec.up` false is a docker that is not running; `build` the build's exit
 * code; `runs` per image the output and exit code of the container.
 * @param {{ up?: boolean, build?: number, runs?: Record<string, { out: string, status: number }> }} spec
 * @param {string} [script]
 */
function linuxRun(spec, script = SCRIPT) {
  const bin = mkdtempSync(join(tmpdir(), "en-fake-docker-"));
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const spec = JSON.parse(process.env.FAKE_DOCKER);
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "version") {
  if (spec.up === false) { process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1); }
  process.stdout.write("27.0.0\\n");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => {
  if (cmd === "build") process.exit(spec.build ?? 0);
  const run = spec.runs[rest[rest.indexOf("--user") + 2]];
  process.stdout.write(run.out);
  process.exit(run.status);
});
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_DOCKER: JSON.stringify(spec) } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const GOOD = {
  "ennyn-linux-floor:20.0.0": { out: output("20.0.0", "2.34.1"), status: 0 },
  "node:22": { out: output("22.21.0", "2.39.5"), status: 0 },
  "node:24": { out: output("24.11.0", "2.39.5"), status: 0 },
};

test("linux run: the script passes only when every run passes, floor first, and fails or stops otherwise", () => {
  const good = linuxRun({ runs: GOOD });
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.deepEqual(good.stdout.split("\n").filter((l) => /^[✓✗]/.test(l)), ["✓ node v20.0.0 · git 2.34.1: 3/3", "✓ node v22.21.0 · git 2.39.5: 3/3", "✓ node v24.11.0 · git 2.39.5: 3/3"]);

  const down = linuxRun({ up: false, runs: GOOD });
  assert.equal(down.code, 2);
  assert.match(down.stderr, /^docker is not running, so nothing was tested: Cannot connect/);
  assert.doesNotMatch(down.stdout, /✓/);

  for (const [runs, build, why] of /** @type {const} */ ([
    [{ ...GOOD, "ennyn-linux-floor:20.0.0": { out: output("20.0.0", "2.39.5"), status: 0 } }, 0, /^✗ node v20\.0\.0 · git 2\.39\.5: git 2\.39\.5 is not 2\.34; 3\/3 passed$/m],
    [{ ...GOOD, "node:22": { out: "ok 1 - a\nnot ok 2 - b\n  ---\n  error: boom\n  ...\n" + output("22.21.0", "2.39.5", { pass: 2, fail: 1 }), status: 1 } }, 0, /^ {4}error: boom$/m],
    [{ ...GOOD, "node:24": { out: output("24.11.0", "2.39.5", { pass: 2, skipped: 1 }), status: 0 } }, 0, /: 1 skipped; 2\/3 passed$/m],
    [{ ...GOOD, "node:24": { out: output("24.11.0", "2.39.5", { tests: 2 }), status: 0 } }, 0, /^✗ the runs ran different numbers of tests: 3, 2$/m],
    [GOOD, 1, /did not build/],
  ])) {
    const r = linuxRun({ runs, build });
    assert.equal(r.code, 1, String(why));
    assert.match(r.stdout + r.stderr, why);
  }
});

test("linux run: run through a link to the script, it still runs (macOS: /tmp is /private/tmp)", () => {
  const link = join(mkdtempSync(join(tmpdir(), "en-link-")), "linux-run.mjs");
  symlinkSync(SCRIPT, link);
  const r = linuxRun({ up: false, runs: GOOD }, link);
  assert.equal(r.code, 2, "it ran, and found docker down");
});
