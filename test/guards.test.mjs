/**
 * Every gate test can fail. test/guards.mjs gives each one guard mutants that make what it guards false;
 * here each guard runs, in a clone of the tree as it is now (changes not committed included), against its
 * gate test, and must fail it: its runner reports that test as failed (TAP, written to a file per run). A gate
 * test that reads the repository's own files and has no guards fails here too: nothing would show its check can
 * fail. The guards run with `runMutants` (metrics/mutation.mjs), the gate test with no mutant first: a gate that
 * fails in the clone, or a pattern that runs no test, shows nothing about its guards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// By namespace: Node before 22.15 has no registerHooks, and a named import of it fails this file's load.
import * as nodeModule from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIfThere } from "../core/files.mjs";
import { git } from "../core/git.mjs";
import { journalPath, runMutants } from "../metrics/mutation.mjs";
import { accounting, testNames } from "./declarations.mjs";
import { GATES, NOT_GATES, guardRuns } from "./guards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOP = join(HERE, "..");
const NODE = JSON.stringify(process.execPath);
/** A file a guard edits that no parser reads (Markdown, YAML): any text parses, so the check is a pass. */
const ANY_TEXT = `${NODE} -e "" {file}`;

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The verdict on a gate's guard runs: every guard killed, the gate passing with none. A timeout is no
 * failure the gate reported, and a guard that does not apply, or does not parse, tested nothing. With `tap`
 * (each run's TAP report, and the one test the pattern names), the named test must pass with no guard and be
 * reported failed under each: a run that failed otherwise (another test, a file that never ran it, a death by a
 * signal, which the shell reports as an exit of 128 and more) is no kill.
 * @param {Awaited<ReturnType<typeof runMutants>>} res
 * @param {import("./guards.mjs").Guard[]} guards
 * @param {{ name: string, baseline: string | null, runs: Map<string, string | null> } | null} [tap]
 * @returns {string[]}
 */
export function verdict(res, guards, tap = null) {
  if (res.baseline.exit !== 0) return [`the gate test fails with no guard applied (${res.baseline.exit ?? res.baseline.signal}): ${res.baseline.tail.trim().split("\n").slice(-5).join(" | ")}`];
  const base = tap && testOutcome(tap.baseline, tap.name);
  if (tap && base !== "ok") return [`with no guard applied, "${tap.name}" ${base ? `reported ${base}` : "did not run"}: the pattern runs no test, so its guards show nothing`];
  const limit = `${((res.timeoutMs ?? 0) / 1000).toFixed(1)} s`;
  /** @type {Record<string, string>} */
  const means = {
    survived: "the gate passed with it, so its check cannot fail there",
    timeout: `it ran past ${limit}, then past twice that: no failure the gate reported (a loaded machine, or a guard that makes the gate hang)`,
    unapplied: "it changed nothing, so it tested nothing",
    invalid: "it does not parse, so it tested nothing",
  };
  // An unchecked run, by what its parse check did: here every guard has a check (ANY_TEXT), so one was asked.
  /** @type {Record<string, string>} */
  const unchecked = {
    "mutate.reason.noCheck": "no check read the file, so its failure may be one that does not parse",
    "mutate.reason.checkNoAnswer": "its parse check gave no answer (it ran past its limit, was killed or did not start), so the run shows nothing",
    "mutate.reason.originalFails": "its parse check fails on the file as it is, so it cannot tell a broken guard from a sound one",
  };
  const out = [];
  for (const g of guards) {
    const r = res.results.find((x) => x.id === g.id);
    if (!r) out.push(`${g.id}: not run`);
    else if (r.outcome !== "killed") {
      const what = r.outcome === "unchecked" ? unchecked[r.reason?.key ?? ""] : means[r.outcome];
      out.push(`${g.id} (${g.why}): ${r.outcome}${r.reason ? ` (${r.reason.key})` : ""}; ${what ?? "no kill"}`);
    } else if (tap) {
      const named = testOutcome(tap.runs.get(g.id) ?? null, tap.name);
      const signal = r.exit === null || r.exit === undefined || r.exit >= 128;
      if (signal) out.push(`${g.id} (${g.why}): its run ended by a signal (exit ${r.exit ?? "none"}): no failure the gate reported`);
      else if (named !== "not ok") out.push(`${g.id} (${g.why}): the run failed (exit ${r.exit}), but "${tap.name}" ${named ? `reported ${named}` : "did not run"}: something else failed, not the test that guards it`);
    }
  }
  return out;
}

/**
 * How a top-level test ended in a TAP report: "ok", "not ok", "skipped" (a SKIP or TODO directive), "hook
 * failed" (not ok because a before or beforeEach hook threw: `failureType: 'hookFailed'` in its block), or
 * null when the report holds no line for it (the file failed before it ran, or there is no report). Node's
 * reporter writes \\ and \# for a backslash and a hash in a name; a directive follows an unescaped "#".
 * @param {string | null} report @param {string} name
 * @returns {"ok" | "not ok" | "skipped" | "hook failed" | null}
 */
export function testOutcome(report, name) {
  const lines = (report ?? "").split("\n");
  for (const [i, line] of lines.entries()) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!m) continue;
    const directive = /(?<!\\)# (?:SKIP|TODO)\b/i.exec(m[2]);
    const title = (directive ? m[2].slice(0, directive.index).trimEnd() : m[2]).replace(/\\([\\#])/g, "$1");
    if (title !== name) continue;
    if (directive) return "skipped";
    if (m[1] === "ok") return "ok";
    // Its YAML block: indented, up to its "  ..." line.
    const end = lines.findIndex((l, k) => k > i && /^ {2}\.\.\.$/.test(l));
    const block = lines.slice(i + 1, end === -1 ? undefined : end);
    return block.some((l) => /^ {2}failureType: '?hookFailed'?$/.test(l)) ? "hook failed" : "not ok";
  }
  return null;
}

/**
 * The tree as it is now, in a clone that shares the objects (the history the hygiene gate reads): every file
 * git lists, tracked or not, copied over the checkout, and the tracked files gone from the work tree removed.
 * @param {string} top
 * @returns {string}
 */
export function cloneOfTree(top) {
  const dir = join(mkdtempSync(join(tmpdir(), "en-guards-")), "tree");
  git(["clone", "-q", "--shared", "--no-checkout", top, dir], { cwd: top });
  git(["checkout", "-q", "--detach", "HEAD"], { cwd: dir });
  const listed = git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: top }).split("\0").filter(Boolean);
  /** @type {Set<string>} */
  const here = new Set();
  for (const f of listed) {
    // An untracked repository or directory git lists ("sub/"): not the tree's files, and not cloned.
    if (f.endsWith("/")) continue;
    let st;
    try {
      st = lstatSync(join(top, f));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") continue; // tracked, deleted in the work tree
      throw err;
    }
    if (st.isDirectory()) continue;
    here.add(f);
    const to = join(dir, f);
    mkdirSync(dirname(to), { recursive: true });
    // A link stays a link, with its target as now: writing through one would write where it points.
    rmSync(to, { force: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(join(top, f)), to);
    else {
      writeFileSync(to, readFileSync(join(top, f)));
      chmodSync(to, st.mode & 0o777);
    }
  }
  for (const f of git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: dir }).split("\0").filter(Boolean)) {
    if (!here.has(f)) rmSync(join(dir, f), { force: true });
  }
  return dir;
}

/**
 * A line that finds the repository from the test's own place: import.meta's path, the test file's own path in
 * process.argv[1], or an import of a data file above test/.
 */
const FINDS = /\bimport\.meta\b|\bprocess\.argv\b(?!\s*\[\s*[02-9])(?!\s*\.\s*slice\(\s*[2-9])|(?<![\w.$])argv\s*(?:\[\s*1\s*\]|\.\s*at\(\s*1\s*\))|\bfrom\s+["']\.\.\/[^"']*\.json["']/;

/**
 * The test files in `dir` that find the repository from their own place, those listed neither as a gate nor
 * as no gate (`missing`), and the lines of a no-gate file that find it outside its `allow` (`overreach`,
 * "file:line"). This file is left out: it runs the others' guards, and its own controls are below.
 * @param {string} dir @param {{ test: string }[]} gates @param {Record<string, { reason: string, allow: string }>} notGates
 */
export function unguarded(dir, gates, notGates) {
  const listed = new Set([...gates.map((g) => g.test), ...Object.keys(notGates)]);
  /** @type {string[]} */
  const readers = [];
  /** @type {string[]} */
  const overreach = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".test.mjs") || f === "guards.test.mjs") continue;
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    if (!lines.some((l) => FINDS.test(l))) continue;
    readers.push(`test/${f}`);
    const no = notGates[`test/${f}`];
    if (no) lines.forEach((l, i) => FINDS.test(l) && !new RegExp(no.allow).test(l) && overreach.push(`test/${f}:${i + 1}`));
  }
  return { readers, missing: readers.filter((f) => !listed.has(f)), overreach };
}

test("guards: every test that reads this repository has guards; each guard changes one place and names the test that guards it", () => {
  const { readers, missing, overreach } = unguarded(HERE, GATES, NOT_GATES);
  assert.ok(readers.length >= 15, `tests that find the repository: ${readers}`);
  assert.deepEqual(missing, [], "a test that finds the repository, listed neither as a gate nor as no gate");
  assert.deepEqual(overreach, [], "a no-gate file that finds the repository on a line its allow does not name: a gate now");
  for (const f of Object.keys(NOT_GATES)) assert.ok(!GATES.some((g) => g.test === f), `${f}: a gate and no gate`);
  const ids = new Set();
  /** @type {string[]} */
  const undecided = [];
  for (const gate of GATES) {
    assert.ok(gate.guards.length, `${gate.test}: no guards`);
    undecided.push(...accounting(gate, readFileSync(join(TOP, gate.test), "utf8")));
    for (const g of gate.guards) {
      assert.ok(!ids.has(g.id), `${g.id} twice`);
      ids.add(g.id);
      assert.ok(g.why, `${g.id}: why`);
      const text = readFileSync(join(TOP, g.file), "utf8");
      assert.equal(text.split(g.old).length - 1, 1, `${g.id}: "old" must occur once in ${g.file}`);
    }
  }
  assert.deepEqual(undecided, [], "a test of a gate file that no guard names and others does not list, or a pattern that names not one test");
});

test("guards control: a guard's lowest Node is a full version; at or above it the guard runs, below it it is left out", () => {
  const floored = GATES.flatMap((gate) => gate.guards.filter((g) => g.node !== undefined));
  for (const g of floored) assert.match(String(g.node), /^\d+\.\d+\.\d+$/, `${g.id}: node is X.Y.Z`);
  // short.test.mjs's --record test checks only where module.registerHooks is (Node 22.15 on).
  assert.deepEqual(floored.map((g) => `${g.id} ${g.node}`).sort(), ["failed", "git", "handed", "link", "missing", "node", "path"].map((k) => `short-record-${k} 22.15.0`));
  const g = floored[0];
  for (const [version, runs] of /** @type {const} */ ([["22.15.0", true], ["22.15.1", true], ["22.16.0", true], ["24.0.0", true], ["v24.11.0", true], ["22.14.9", false], ["22.0.0", false], ["20.19.5", false], ["", false], ["x", false]])) {
    assert.equal(guardRuns(g, version), runs, version);
  }
  assert.equal(guardRuns({ ...g, node: undefined }, "1.0.0"), true, "a guard with no lowest Node runs on any");
  // On this Node they run exactly when the --record test checks: on 22.15 and later all of them must kill.
  assert.equal(guardRuns(g, process.versions.node), typeof nodeModule.registerHooks === "function", process.version);
});

test("guards control: a test that finds the repository and is listed nowhere is named; a test name is read as written", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-guards-dir-"));
  writeFileSync(join(dir, "a.test.mjs"), 'const here = dirname(fileURLToPath(import.meta.url));\n');
  writeFileSync(join(dir, "b.test.mjs"), "const root = 1; // no path from here\n");
  writeFileSync(join(dir, "c.test.mjs"), "export const ROOT = join(dirname(fileURLToPath( import.meta.url )), '..');\n");
  writeFileSync(join(dir, "d.test.mjs"), "const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');\n");
  assert.deepEqual(unguarded(dir, [{ test: "test/c.test.mjs" }], { "test/d.test.mjs": { reason: "runs the CLI", allow: "cli\\.mjs" } }), { readers: ["test/a.test.mjs", "test/c.test.mjs", "test/d.test.mjs"], missing: ["test/a.test.mjs"], overreach: [] });
  assert.deepEqual(testNames('test("a: \\"q\\" one", () => {});\n  test("nested is no top-level test");\ntest("b", () => {});\n'), ['a: "q" one', "b"]);
});

test("guards control: the verdict fails a guard that survived, did not apply, timed out or did not run, and a gate that fails alone; the time report puts the slowest gate first", () => {
  // Each result as runMutants writes it (metrics/mutation.mjs, where it builds the MutantResult).
  const run = { ms: 5, tail: "" };
  /** @type {Record<string, object>} */
  const shapes = {
    killed: { outcome: "killed", checked: true, ...run, exit: 1 },
    survived: { outcome: "survived", checked: true, ...run, exit: 0 },
    timeout: { outcome: "timeout", checked: true, ...run, exit: null },
    unapplied: { outcome: "unapplied", reason: { key: "mutate.reason.occurs", vars: { n: 0 } } },
    invalid: { outcome: "invalid", checked: true, reason: { key: "mutate.reason.parse" } },
    unchecked: { outcome: "unchecked", checked: false, reason: { key: "mutate.reason.checkNoAnswer" }, ...run, exit: 1 },
    "unchecked-original": { outcome: "unchecked", checked: false, reason: { key: "mutate.reason.originalFails" }, ...run, exit: 1 },
  };
  /** @param {string} shape */
  const r = (shape) => ({ restored: null, timeoutMs: 1, baseline: { exit: 0, signal: null, ms: 1, tail: "" }, results: [{ id: "a", file: "f", ...shapes[shape] }] });
  const g = [{ id: "a", why: "w", file: "f", old: "o", new: "n" }];
  assert.deepEqual(verdict(/** @type {any} */ (r("killed")), g), []);
  for (const outcome of ["survived", "unapplied", "invalid", "timeout", "unchecked"]) assert.match(verdict(/** @type {any} */ (r(outcome)), g).join(), new RegExp(`a \\(w\\): ${outcome}`));
  // Only a survivor says the gate passed: a slow run, or a guard that changed nothing, is no pass of the gate.
  assert.match(verdict(/** @type {any} */ (r("survived")), g).join(), /the gate passed with it/);
  for (const outcome of ["unapplied", "invalid", "timeout", "unchecked"]) assert.doesNotMatch(verdict(/** @type {any} */ (r(outcome)), g).join(), /passed/, outcome);
  // An unchecked run says what its check did: here a check always ran.
  assert.match(verdict(/** @type {any} */ (r("unchecked")), g).join(), /checkNoAnswer\); its parse check gave no answer/);
  assert.match(verdict(/** @type {any} */ (r("unchecked-original")), g).join(), /originalFails\); its parse check fails on the file as it is/);
  assert.doesNotMatch(verdict(/** @type {any} */ (r("unchecked")), g).join(), /no check read the file/);
  assert.match(verdict(/** @type {any} */ ({ ...r("timeout"), timeoutMs: 42_000 }), g).join(), /ran past 42\.0 s, then past twice that/);
  assert.deepEqual(slowestFirst([{ test: "a", ms: 1500 }, { test: "b", ms: 61_000 }, { test: "c", ms: 40 }]), ["b: 61.0 s", "a: 1.5 s", "c: 0.0 s"]);
  assert.match(verdict(/** @type {any} */ ({ ...r("killed"), results: [] }), g).join(), /a: not run/);
  assert.match(verdict(/** @type {any} */ ({ ...r("killed"), baseline: { exit: 1, signal: null, ms: 1, tail: "not ok 1\n" } }), g).join(), /fails with no guard applied/);
});

test("guards control: a gate whose check cannot fail lets its guard survive, and the verdict says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "en-guards-ctl-"));
  git(["init", "-q"], { cwd: dir });
  // A gate that reads the file and checks nothing it could find there.
  writeFileSync(join(dir, "doc.md"), "clean\n");
  writeFileSync(join(dir, "gate.mjs"), 'import { readFileSync } from "node:fs";\nconst t = readFileSync("doc.md", "utf8");\nif (t.includes("bad") && false) process.exit(1);\n');
  const guards = [{ id: "bad-doc", why: "a bad word in the doc", file: "doc.md", old: "clean\n", new: "bad\n" }];
  const res = await runMutants({ cwd: dir, mutants: guards, command: `${NODE} gate.mjs`, check: ANY_TEXT, journal: journalPath(dir, ".git/ennyn") });
  assert.match(verdict(res, guards).join(), /bad-doc \(a bad word in the doc\): survived/);
  writeFileSync(join(dir, "gate.mjs"), 'import { readFileSync } from "node:fs";\nif (readFileSync("doc.md", "utf8").includes("bad")) process.exit(1);\n');
  assert.deepEqual(verdict(await runMutants({ cwd: dir, mutants: guards, command: `${NODE} gate.mjs`, check: ANY_TEXT, journal: journalPath(dir, ".git/ennyn") }), guards), []);
});

test("guards control: the clone holds the tree as it is, changes not committed included", (t) => {
  const top = mkdtempSync(join(tmpdir(), "en-guards-top-"));
  git(["init", "-q"], { cwd: top });
  for (const [f, text] of [["kept.md", "one\n"], ["edited.md", "old\n"], ["deleted.md", "x\n"]]) writeFileSync(join(top, f), text);
  symlinkSync("kept.md", join(top, "tracked.md"));
  git(["add", "-A"], { cwd: top });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"], { cwd: top });
  writeFileSync(join(top, "edited.md"), "new\n");
  mkdirSync(join(top, "sub"));
  writeFileSync(join(top, "sub", "untracked.md"), "u\n");
  rmSync(join(top, "deleted.md"));
  // A tracked link pointed elsewhere since its commit: the clone's link moves too, nothing is written through it.
  rmSync(join(top, "tracked.md"));
  symlinkSync("edited.md", join(top, "tracked.md"));
  const dir = cloneOfTree(top);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== ".git").sort(), ["edited.md", "kept.md", "sub", "tracked.md"]);
  assert.deepEqual([readlinkSync(join(dir, "tracked.md")), readFileSync(join(dir, "kept.md"), "utf8")], ["edited.md", "one\n"]);
  assert.deepEqual([readFileSync(join(dir, "edited.md"), "utf8"), readFileSync(join(dir, "sub", "untracked.md"), "utf8")], ["new\n", "u\n"]);
  assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: dir }), "1", "the history is there");
  // A link, retargeted since its commit, and one to a directory: links as they are now, nothing written through.
  writeFileSync(join(top, "b.md"), "b\n");
  symlinkSync("b.md", join(top, "now.md"));
  symlinkSync("sub", join(top, "dirlink"));
  const linked = cloneOfTree(top);
  assert.deepEqual([readlinkSync(join(linked, "now.md")), readlinkSync(join(linked, "dirlink")), readFileSync(join(linked, "now.md"), "utf8")], ["b.md", "sub", "b\n"]);
  // A repository inside the tree that git does not track is left out, as git lists it ("inner/").
  mkdirSync(join(top, "inner"));
  git(["init", "-q"], { cwd: join(top, "inner") });
  writeFileSync(join(top, "inner", "x.md"), "x\n");
  assert.ok(!readdirSync(cloneOfTree(top)).includes("inner"));
  // A file that is there but cannot be read is no deleted file: the clone would test another tree.
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  writeFileSync(join(top, "locked.md"), "l\n");
  chmodSync(join(top, "locked.md"), 0o000);
  try {
    assert.throws(() => cloneOfTree(top), /EACCES/);
  } finally {
    chmodSync(join(top, "locked.md"), 0o644);
  }
});

// No time limit of its own. A node:test timeout marks the test cancelled and stops none of the runs, which go on
// to their end; all it did was fail the suite on a loaded machine (cycle 2026-10-23 (7): 18 minutes under load
// 30-44, 18 s idle). Each guard run has its own limit, three times its gate's run without guards, then twice that.
test("guards: every guard makes its gate test fail", async (t) => {
  // A guard whose gate test checks only from a newer Node than this one is left out, and named once.
  const below = GATES.flatMap((gate) => gate.guards.filter((g) => !guardRuns(g, process.versions.node)).map((g) => `${g.id} (Node ${g.node})`));
  if (below.length) t.diagnostic(`left out on Node ${process.versions.node}, below their lowest Node: ${below.join(", ")}`);
  // One clone a gate; a few gates at a time, each one's runs one after another (one journal a tree).
  const jobs = GATES.flatMap((gate) => {
    /** @type {Map<string, import("./guards.mjs").Guard[]>} */
    const byPattern = new Map();
    for (const g of gate.guards) if (guardRuns(g, process.versions.node)) byPattern.set(g.pattern, [...(byPattern.get(g.pattern) ?? []), g]);
    return [{ gate, groups: [...byPattern] }];
  });
  /** @type {string[]} */
  const problems = [];
  /** @type {{ test: string, ms: number }[]} */
  const spent = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { gate, groups } = jobs[next++];
      const started = performance.now();
      const dir = cloneOfTree(TOP);
      for (const [pattern, guards] of groups) for (const p of await runGuards(dir, gate.test, pattern, guards)) problems.push(`${gate.test} (${pattern}): ${p}`);
      rmSync(dirname(dir), { recursive: true, force: true });
      spent.push({ test: gate.test, ms: performance.now() - started });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, availableParallelism() - 1)) }, worker));
  for (const line of slowestFirst(spent)) t.diagnostic(line);
  assert.equal(spent.length, jobs.length, "every gate's guards ran");
  assert.deepEqual(problems, []);
});

/**
 * One pattern's guards in `dir` (a git work tree): the gate test alone with no guard, then with each one, the
 * runner's TAP report of each run kept in the git dir and taken before the next run writes its own.
 * @param {string} dir @param {string} file the gate test, relative to dir @param {string} pattern
 * @param {import("./guards.mjs").Guard[]} guards
 * @returns {Promise<string[]>} the verdict's problems
 */
export async function runGuards(dir, file, pattern, guards) {
  const names = testNames(readFileSync(join(dir, file), "utf8"));
  const report = join(dir, ".git", "ennyn-guard.tap");
  const take = () => {
    const text = readIfThere(report);
    rmSync(report, { force: true });
    return text;
  };
  const tap = { name: names.find((n) => new RegExp(pattern).test(n)) ?? pattern, baseline: /** @type {string | null} */ (null), runs: new Map() };
  const reporters = `--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=${quote(report)}`;
  // The file runs directly, not under `node --test`: there a parent re-reads the file's TAP, and Node 20.0.0's
  // parser gives up on a control character a failing assertion prints (the whole file is then one "not ok"). A
  // file started with the runner's NODE_TEST_CONTEXT reports to a parent instead and exits 0 whatever it found.
  const command = `unset NODE_TEST_CONTEXT; ${NODE} --import ./test/hermetic.mjs ${reporters} --test-name-pattern=${quote(pattern)} ${file}`;
  rmSync(report, { force: true });
  const res = await runMutants({
    cwd: dir,
    mutants: guards,
    command,
    check: ANY_TEXT,
    journal: journalPath(dir, ".git/ennyn"),
    onBaseline: () => (tap.baseline = take()),
    onResult: (r) => tap.runs.set(r.id, take()),
  });
  return verdict(res, guards, tap);
}

/**
 * Where the guard runs' time went, slowest gate first: on a loaded machine the report names the gates it waited on.
 * @param {{ test: string, ms: number }[]} spent
 */
export function slowestFirst(spent) {
  return [...spent].sort((a, b) => b.ms - a.ms).map((s) => `${s.test}: ${(s.ms / 1000).toFixed(1)} s`);
}


test("guards control (review round two): every way a test finds the repository is seen, and a no-gate file that reads more than it says is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-guards-dir2-"));
  writeFileSync(join(dir, "url.test.mjs"), 'const t = readFileSync(new URL("../README.md", import.meta.url), "utf8");\n');
  writeFileSync(join(dir, "dirname.test.mjs"), 'const root = join(import.meta.dirname, "..");\n');
  writeFileSync(join(dir, "json.test.mjs"), 'import pkg from "../package.json" with { type: "json" };\n');
  writeFileSync(join(dir, "cli.test.mjs"), 'const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");\nconst ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");\n');
  writeFileSync(join(dir, "plain.test.mjs"), "const x = 1;\n");
  // The test file's own path, as node gives it (cycle 2026-10-24 (8)); a child's arguments are no such path.
  writeFileSync(join(dir, "argv.test.mjs"), "const root = join(dirname(process.argv[1]), \"..\");\n");
  writeFileSync(join(dir, "argv2.test.mjs"), "const [, self] = process.argv;\n");
  writeFileSync(join(dir, "argv3.test.mjs"), "const self = process.argv.at(1);\n");
  writeFileSync(join(dir, "meta.test.mjs"), "const { url } = import.meta;\n");
  writeFileSync(join(dir, "argv4.test.mjs"), 'import { argv } from "node:process";\nconst root = dirname(argv[1]);\n');
  writeFileSync(join(dir, "child.test.mjs"), "const script = 'const f = process.argv[2];';\n");
  const res = unguarded(dir, [], { "test/cli.test.mjs": { reason: "runs the CLI", allow: '"scripts", "ennyn\\.mjs"' } });
  const finding = ["test/argv.test.mjs", "test/argv2.test.mjs", "test/argv3.test.mjs", "test/argv4.test.mjs"];
  assert.deepEqual(res.readers, [...finding, "test/cli.test.mjs", "test/dirname.test.mjs", "test/json.test.mjs", "test/meta.test.mjs", "test/url.test.mjs"]);
  assert.deepEqual(res.missing, [...finding, "test/dirname.test.mjs", "test/json.test.mjs", "test/meta.test.mjs", "test/url.test.mjs"]);
  assert.deepEqual(res.overreach, ["test/cli.test.mjs:2"]);
});

test("guards control (review round two): the clone keeps a file's mode", () => {
  const top = mkdtempSync(join(tmpdir(), "en-guards-mode-"));
  git(["init", "-q"], { cwd: top });
  writeFileSync(join(top, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(top, "run.sh"), 0o755);
  git(["add", "-A"], { cwd: top });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"], { cwd: top });
  writeFileSync(join(top, "new.sh"), "#!/bin/sh\n");
  chmodSync(join(top, "new.sh"), 0o755);
  const dir = cloneOfTree(top);
  assert.deepEqual([lstatSync(join(dir, "run.sh")).mode & 0o777, lstatSync(join(dir, "new.sh")).mode & 0o777], [0o755, 0o755]);
});

test("guards control: every test of a gate file is decided once, each pattern names one test, and every declaration is read", () => {
  const file = ['test("a: one", () => {});', 'test("a: two", () => {});', 'test("b: three", () => {});', "test('quoted', () => {});", ""].join("\n");
  const guard = (/** @type {string} */ id, /** @type {string} */ pattern) => ({ id, why: "w", file: "f", old: "o", new: "n", pattern });
  assert.deepEqual(accounting({ test: "test/x.test.mjs", guards: [guard("g1", "a: ")], others: { "b: three": "a unit", gone: "stale" } }, file), [
    'test/x.test.mjs: 4 tests declared, 3 read as a top-level test("…"): declare each so',
    "g1: its pattern names 2 tests of test/x.test.mjs, not one: a: one | a: two",
    'test/x.test.mjs: others names "gone", no test of the file',
  ]);
  const plain = file.replace("test('quoted', () => {});\n", "");
  assert.deepEqual(accounting({ test: "t", guards: [guard("g1", "a: one"), guard("g2", "a: two")], others: { "b: three": "a unit" } }, plain), []);
  // Declared but not as a top-level test("…"): each is counted, so none is left undecided (review round one).
  for (const form of [
    "for (const c of [1, 2]) test(`case ${c}`, () => {});",
    "if (process.env.X) {\n  test(\"in a block\", () => {});\n}",
    "await test(\"awaited\", () => {});",
    "test.skip(\"skipped\", () => {});",
    "describe(\"group\", () => {});",
    "it(\"an it\", () => {});",
    // Round two: a space before the parenthesis, and a glob in a string that is no comment.
    "test (\"spaced\", () => {});",
    "test.skip (\"spaced skip\", () => {});",
    "const g = \"docs/*.md\";\nfor (const c of [1, 2]) test(`v ${c}`, () => {});\n/** a comment */",
    "test?.(\"optional call\", () => {});",
    "test[\"skip\"](\"by key\", () => {});",
    "test\n(\"next line\", () => {});",
  ]) assert.match(accounting({ test: "t", guards: [guard("g1", "a: one"), guard("g2", "a: two")], others: { "b: three": "a unit" } }, `${plain}${form}\n`).join(), /4 tests declared, 3 read/, form);
  for (const imports of ['import { test as check } from "node:test";', 'import t from "node:test";', 'import * as nt from "node:test";']) {
    assert.match(accounting({ test: "t", guards: [guard("g1", "a: one"), guard("g2", "a: two")], others: { "b: three": "a unit" } }, `${imports}\n${plain}`).join(), /imported under another name/, imports);
  }
  // Not a declaration: a subtest, quoted text, a comment, a longer name.
  const quiet = `import { test } from "node:test";\n${plain}  await t.test("sub", () => {});\nconst s = 'test("in a string")';\n// test("in a comment")\n/* test("a block comment") */\nmytest("x");\nconst m = "a test (x)";\nconst r = /test\\(/g;\nconst q = a / b / c;\nconst n = \`\${x ? \`test(\` : "test ("} b\`;\n`;
  assert.deepEqual(accounting({ test: "t", guards: [guard("g1", "a: one"), guard("g2", "a: two")], others: { "b: three": "a unit" } }, quiet), []);
  assert.deepEqual(accounting({ test: "t", guards: [guard("g1", "a: one")], others: { "a: one": "x", "b: three": " " } }, plain), [
    't: "a: one" has a guard and is in others',
    't: "a: two" has no guard, and others does not say why',
    't: others gives no reason for "b: three"',
  ]);
});

test("guards control: a kill is the named test reported failed by its runner; a run that failed otherwise is none", async () => {
  // The runner's own TAP: a name with a hash and a backslash, a subtest, a test the pattern leaves out.
  const dir = mkdtempSync(join(tmpdir(), "en-guards-tap-"));
  git(["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "hermetic.mjs"), "");
  const gateFile = [
    'import { before, test } from "node:test";',
    'import { readFileSync } from "node:fs";',
    "const doc = readFileSync(new URL(\"../doc.md\", import.meta.url), \"utf8\");",
    'if (doc.includes("crash")) throw new Error("the file fails before its tests");',
    'test("named # \\\\ one", async (t) => {',
    '  await t.test("inner", () => {});',
    '  if (doc.includes("bad")) throw new Error("bad");',
    '  // A line the test prints that looks like a result: written to its output, not to the runner\'s report.',
    '  if (doc.includes("print")) (console.log("not ok 1 - named \\\\# \\\\\\\\ one"), (process.exitCode = 1));',
    '});',
    'test("other", () => {});',
    '// Something other than the named test fails the run (on every Node from 22.0.0): the file sets its exit code.',
    'if (doc.includes("other")) process.exitCode = 1;',
    'before(() => { if (doc.includes("hook")) throw new Error("a hook, not the test"); });',
    "",
  ].join("\n");
  writeFileSync(join(dir, "test", "gate.test.mjs"), gateFile);
  writeFileSync(join(dir, "doc.md"), "clean\n");
  const g = (/** @type {string} */ id, /** @type {string} */ to) => ({ id, why: id, file: "doc.md", old: "clean\n", new: to, pattern: "^named" });
  const problems = await runGuards(dir, "test/gate.test.mjs", "^named", [g("kills", "bad\n"), g("other-fails", "other\n"), g("load-fails", "crash\n"), g("hook-fails", "hook\n"), g("prints", "print\n")]);
  assert.equal(problems.length, 4, JSON.stringify(problems));
  assert.match(problems[0], /^other-fails \(other-fails\): the run failed \(exit 1\), but "named # \\ one" reported ok/);
  assert.match(problems[1], /^load-fails \(load-fails\): the run failed \(exit 1\), but "named # \\ one" did not run/);
  // A before hook that throws: the test is "not ok" with failureType hookFailed.
  assert.match(problems[2], /^hook-fails \(hook-fails\): the run failed \(exit 1\), but "named # \\ one" reported hook failed/);
  assert.match(problems[3], /^prints \(prints\): the run failed \(exit 1\), but "named # \\ one" reported ok/);
  // A pattern that runs no test: its guards show nothing.
  assert.match((await runGuards(dir, "test/gate.test.mjs", "^nothing", [g("kills", "bad\n")])).join(), /the pattern runs no test/);
  // Read from the runner's report: a subtest is no top-level test, a SKIP is no pass, escapes are undone.
  const report = "ok 1 - a \\# b\n    not ok 1 - inner\nok 2 - s # SKIP test name does not match pattern\nnot ok 3 - back \\\\ slash\n  ---\n  failureType: 'testCodeFailure'\n  ...\nnot ok 4 - h\n  ---\n  failureType: 'hookFailed'\n  ...\n";
  assert.deepEqual(
    [testOutcome(report, "a # b"), testOutcome(report, "inner"), testOutcome(report, "s"), testOutcome(report, "back \\ slash"), testOutcome(report, "h"), testOutcome(null, "a # b")],
    ["ok", null, "skipped", "not ok", "hook failed", null],
  );
  // A kill whose run the shell reports as ended by a signal.
  const res = { restored: null, timeoutMs: 1, baseline: { exit: 0, signal: null, ms: 1, tail: "" }, results: [{ id: "k", file: "f", outcome: "killed", checked: true, ms: 1, exit: 137, tail: "" }] };
  const tap = { name: "a # b", baseline: "ok 1 - a \\# b\n", runs: new Map([["k", null]]) };
  assert.match(verdict(/** @type {any} */ (res), [{ id: "k", why: "w", file: "f", old: "o", new: "n", pattern: "a" }], tap).join(), /k \(w\): its run ended by a signal \(exit 137\)/);
});
