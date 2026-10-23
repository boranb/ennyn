/**
 * Every gate test can fail. test/guards.mjs gives each one guard mutants that make what it guards false;
 * here each guard runs, in a clone of the tree as it is now (changes not committed included), against its
 * gate test, and must fail it. A gate test that reads the repository's own files and has no guards fails
 * here too: nothing would show its check can fail. The guards run with `runMutants` (metrics/mutation.mjs),
 * the gate test with no mutant first: a gate that fails in the clone shows nothing about its guards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { journalPath, runMutants } from "../metrics/mutation.mjs";
import { GATES, NOT_GATES } from "./guards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOP = join(HERE, "..");
const NODE = JSON.stringify(process.execPath);
/** A file a guard edits that no parser reads (Markdown, YAML): any text parses, so the check is a pass. */
const ANY_TEXT = `${NODE} -e "" {file}`;

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The verdict on a gate's guard runs: every guard killed, the gate passing with none. A timeout is no
 * failure the gate reported, and a guard that does not apply, or does not parse, tested nothing.
 * @param {Awaited<ReturnType<typeof runMutants>>} res
 * @param {import("./guards.mjs").Guard[]} guards
 * @returns {string[]}
 */
export function verdict(res, guards) {
  if (res.baseline.exit !== 0) return [`the gate test fails with no guard applied (${res.baseline.exit ?? res.baseline.signal}): ${res.baseline.tail.trim().split("\n").slice(-5).join(" | ")}`];
  const out = [];
  for (const g of guards) {
    const r = res.results.find((x) => x.id === g.id);
    if (!r) out.push(`${g.id}: not run`);
    else if (r.outcome !== "killed") out.push(`${g.id} (${g.why}): ${r.outcome}${r.reason ? ` (${r.reason.key})` : ""}; the gate passed with it, so its check cannot fail there`);
  }
  return out;
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

/** A line that finds the repository from the test's own place: import.meta's path, or an import of a data file above test/. */
const FINDS = /import\.meta\.(url|dirname|filename)|\bfrom\s+["']\.\.\/[^"']*\.json["']/;

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

/** The names of the top-level tests a file declares. @param {string} text */
const testNames = (text) => [...text.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));

test("guards: every test that reads this repository has guards; each guard changes one place and names the test that guards it", () => {
  const { readers, missing, overreach } = unguarded(HERE, GATES, NOT_GATES);
  assert.ok(readers.length >= 15, `tests that find the repository: ${readers}`);
  assert.deepEqual(missing, [], "a test that finds the repository, listed neither as a gate nor as no gate");
  assert.deepEqual(overreach, [], "a no-gate file that finds the repository on a line its allow does not name: a gate now");
  for (const f of Object.keys(NOT_GATES)) assert.ok(!GATES.some((g) => g.test === f), `${f}: a gate and no gate`);
  const ids = new Set();
  for (const gate of GATES) {
    assert.ok(gate.guards.length, `${gate.test}: no guards`);
    readFileSync(join(TOP, gate.test));
    const names = testNames(readFileSync(join(TOP, gate.test), "utf8"));
    for (const g of gate.guards) {
      assert.ok(g.pattern && names.some((n) => new RegExp(g.pattern).test(n)), `${g.id}: its pattern names no test of ${gate.test}`);
      assert.ok(!ids.has(g.id), `${g.id} twice`);
      ids.add(g.id);
      assert.ok(g.why, `${g.id}: why`);
      const text = readFileSync(join(TOP, g.file), "utf8");
      assert.equal(text.split(g.old).length - 1, 1, `${g.id}: "old" must occur once in ${g.file}`);
    }
  }
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

test("guards control: the verdict fails a guard that survived, did not apply, timed out or did not run, and a gate that fails alone", () => {
  /** @param {string} outcome */
  const r = (outcome) => ({ restored: null, timeoutMs: 1, baseline: { exit: 0, signal: null, ms: 1, tail: "" }, results: [{ id: "a", file: "f", outcome, checked: true }] });
  const g = [{ id: "a", why: "w", file: "f", old: "o", new: "n" }];
  assert.deepEqual(verdict(/** @type {any} */ (r("killed")), g), []);
  for (const outcome of ["survived", "unapplied", "invalid", "timeout", "unchecked"]) assert.match(verdict(/** @type {any} */ (r(outcome)), g).join(), new RegExp(`a \\(w\\): ${outcome}`));
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

test("guards: every guard makes its gate test fail", { timeout: 15 * 60 * 1000 }, async (t) => {
  // One clone a gate; a few gates at a time, each one's runs one after another (one journal a tree).
  const jobs = GATES.flatMap((gate) => {
    /** @type {Map<string, import("./guards.mjs").Guard[]>} */
    const byPattern = new Map();
    for (const g of gate.guards) byPattern.set(g.pattern, [...(byPattern.get(g.pattern) ?? []), g]);
    return [{ gate, groups: [...byPattern] }];
  });
  /** @type {string[]} */
  const problems = [];
  let next = 0;
  // The runner tells the test files it starts to report to it (NODE_TEST_CONTEXT): a gate test started here
  // with that value runs as its child and exits 0 whatever it found, so every guard survived. This file's own
  // report was set up when its first test started.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  });
  const worker = async () => {
    while (next < jobs.length) {
      const { gate, groups } = jobs[next++];
      const dir = cloneOfTree(TOP);
      for (const [pattern, guards] of groups) {
        const command = `${NODE} --test --import ./test/hermetic.mjs --test-name-pattern=${quote(pattern)} ${gate.test}`;
        const res = await runMutants({ cwd: dir, mutants: guards, command, check: ANY_TEXT, journal: journalPath(dir, ".git/ennyn") });
        for (const p of verdict(res, guards)) problems.push(`${gate.test} (${pattern}): ${p}`);
      }
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, availableParallelism() - 1)) }, worker));
  assert.deepEqual(problems, []);
});


test("guards control (review round two): every way a test finds the repository is seen, and a no-gate file that reads more than it says is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-guards-dir2-"));
  writeFileSync(join(dir, "url.test.mjs"), 'const t = readFileSync(new URL("../README.md", import.meta.url), "utf8");\n');
  writeFileSync(join(dir, "dirname.test.mjs"), 'const root = join(import.meta.dirname, "..");\n');
  writeFileSync(join(dir, "json.test.mjs"), 'import pkg from "../package.json" with { type: "json" };\n');
  writeFileSync(join(dir, "cli.test.mjs"), 'const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");\nconst ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");\n');
  writeFileSync(join(dir, "plain.test.mjs"), "const x = 1;\n");
  const res = unguarded(dir, [], { "test/cli.test.mjs": { reason: "runs the CLI", allow: '"scripts", "ennyn\\.mjs"' } });
  assert.deepEqual(res.readers, ["test/cli.test.mjs", "test/dirname.test.mjs", "test/json.test.mjs", "test/url.test.mjs"]);
  assert.deepEqual(res.missing, ["test/dirname.test.mjs", "test/json.test.mjs", "test/url.test.mjs"]);
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
