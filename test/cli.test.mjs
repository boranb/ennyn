import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MISSING_OBJECT, git, gitMaybe, gitVersion, stagedAddedLines, versionAtLeast } from "../core/git.mjs";
import { TOKENS } from "./secret-shapes.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

/** @param {string} cwd @param {string[]} args */
function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @param {Record<string, unknown>} [config]
 * @returns {{ dir: string, commit: (files: Record<string, string>, message: string, day?: number) => void }}
 */
function project(config) {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  if (config) {
    mkdirSync(join(dir, ".ennyn"), { recursive: true });
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
  }
  return {
    dir,
    commit(files, message, day = 0) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      const date = `2026-01-${String(1 + day).padStart(2, "0")} 12:00:00 +0000`;
      git(["add", "-A"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    },
  };
}

const SRC = "export function add(a, b) {\n  return a + b;\n}\n";

test("cli: --help, no command and an unknown command", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-help-"));
  const help = run(dir, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: ennyn <command>/);
  const none = run(dir);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /Usage: ennyn/);
  const unknown = run(dir, "frobnicate");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
  assert.match(unknown.stderr, /Usage: ennyn/);
  assert.equal(unknown.stdout, "");
});

test("cli: commit-check passes a good message, fails a long subject, reads staged paths", () => {
  const p = project({ review: { impactRequiredGlobs: ["src/**"] } });
  git(["add", ".ennyn/config.json"], { cwd: p.dir });
  const msg = join(p.dir, ".git", "MSG");
  writeFileSync(msg, "feat: short subject\n");
  assert.deepEqual(run(p.dir, "commit-check", msg), { code: 0, stdout: "", stderr: "" });

  writeFileSync(msg, "x".repeat(130) + "\n");
  const long = run(p.dir, "commit-check", msg);
  assert.equal(long.code, 1);
  assert.match(long.stderr, /Subject is 130 characters; the limit is 120/);

  // Staged paths come from git: an engine path without an Impact line fails.
  mkdirSync(join(p.dir, "src"));
  writeFileSync(join(p.dir, "src", "a.js"), SRC);
  git(["add", "src/a.js"], { cwd: p.dir });
  writeFileSync(msg, "feat: add\n");
  const impact = run(p.dir, "commit-check", msg);
  assert.equal(impact.code, 1);
  assert.match(impact.stderr, /impact table \(src\/a\.js\)/);
  writeFileSync(msg, "feat: add\n\nImpact: not needed — new file, no readers\n");
  assert.equal(run(p.dir, "commit-check", msg).code, 0);

  assert.equal(run(p.dir, "commit-check").code, 2, "missing message file argument is a usage error");
  assert.equal(run(p.dir, "commit-check", join(p.dir, "nope")).code, 1, "unreadable file");
});

test("cli: impact prints the five-row table; an unknown option is a usage error", () => {
  const p = project();
  p.commit({ "src/a.js": SRC, "src/routes/sum.js": 'import { add } from "../a.js";\nadd(1, 2);\n' }, "feat: add");
  const ok = run(p.dir, "impact", "--symbol", "add", "--files", "src/a.js");
  assert.equal(ok.code, 0, ok.stderr);
  const lines = ok.stdout.trim().split("\n");
  assert.equal(lines.length, 7);
  assert.match(ok.stdout, /\| S2 \| [^|]+ \| entry points referencing add: src\/routes\/sum\.js \|/);
  const bad = run(p.dir, "impact", "--bogus");
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option --bogus/);
});

test("cli: rework reports JSON and text; a bad date is a usage error", () => {
  // One-line fixture: the strong-link floor is lowered so the CLI path, not the criterion, is under test.
  const p = project({ metrics: { minLines: 1 } });
  p.commit({ "src/a.js": SRC }, "feat: add", 0);
  p.commit({ "src/a.js": SRC.replace("a + b", "Number(a) + Number(b)") }, "fix: numbers", 2);
  const json = run(p.dir, "rework", "--since", "2026-01-01", "--until", "2026-01-01", "--json");
  assert.equal(json.code, 0, json.stderr);
  const res = JSON.parse(json.stdout);
  assert.equal(res.commits, 1);
  assert.equal(res.reworked, 1);
  assert.equal(res.days, 7);
  assert.deepEqual(res.pairs[0].files, ["src/a.js"]);
  const text = run(p.dir, "rework", "--days", "1");
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^Rework: 0 of 2 commits \(0\.0%\) had lines changed by a fix within 1 days\./);
  assert.ok(!text.stdout.includes("Note:"), "1 fix of 2 commits is not a majority");
  p.commit({ "src/a.js": SRC + "export const z = 0;\n" }, "fix: more", 3);
  assert.match(run(p.dir, "rework").stdout, /Note: 2 of 3 candidate commits are fixes\. When most work is labelled fix, this rate measures churn/);
  const bad = run(p.dir, "rework", "--since", "2026-13-01");
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--since is not a calendar date/);
  assert.equal(run(p.dir, "rework", "--days", "seven").code, 2);
});

test("cli audit: a range that ends before it starts is a usage error, never an empty answer; a window past any number too", () => {
  const p = project({ metrics: { minLines: 1 } });
  p.commit({ "src/a.js": SRC }, "feat: add", 0);
  p.commit({ "src/a.js": SRC.replace("a + b", "Number(a) + Number(b)") }, "fix: numbers", 2);
  for (const command of ["rework", "bypass", "gate-stats"]) {
    const bad = run(p.dir, command, "--since", "2026-02-01", "--until", "2026-01-01");
    assert.equal(bad.code, 2, `${command}: ${bad.stdout}`);
    assert.match(bad.stderr, /^--until 2026-01-01 is before --since 2026-02-01$/m, command);
    assert.equal(run(p.dir, command, "--since", "2026-01-01", "--until", "2026-01-01").code, 0, `${command}: one day is a range`);
  }
  assert.match(run(p.dir, "rework", "--since", "2026-01-01", "--until", "2026-01-01").stdout, /^Rework: 1 of 1 commits/);
  // 2^53 + 1 reads as 2^53; 400 digits read as Infinity.
  for (const days of ["9007199254740993", "9".repeat(400)]) {
    const huge = run(p.dir, "rework", "--days", days);
    assert.equal(huge.code, 2, huge.stderr);
    assert.match(huge.stderr, /^--days must be a whole number up to 9007199254740991$/m);
  }
  assert.equal(run(p.dir, "rework", "--days", "9007199254740991").code, 0, "the largest exact whole number is a window");
});

test("cli audit: rework says a fix that moved only a submodule, in the report and in --json; the note on fixes counts commits with lines", () => {
  const p = project({ metrics: { minLines: 1 } });
  const link = (/** @type {string} */ digit) => {
    mkdirSync(join(p.dir, "lib", "sub"), { recursive: true });
    git(["update-index", "--add", "--cacheinfo", `160000,${digit.repeat(40)},lib/sub`], { cwd: p.dir });
  };
  link("1");
  p.commit({ "src/a.js": SRC }, "feat: add", 0);
  link("2");
  p.commit({}, "fix: bump lib", 2);
  const text = run(p.dir, "rework");
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Rework: 0 of 1 commits/);
  assert.match(text.stdout, /^Fix commits that moved only a submodule: 1\. A submodule's commit holds no line to read, so what they repaired is not measured\.$/m);
  assert.equal(JSON.parse(run(p.dir, "rework", "--json").stdout).submoduleFixes, 1);
  const none = project({ metrics: { minLines: 1 } });
  none.commit({ "src/a.js": SRC }, "feat: add", 0);
  assert.doesNotMatch(run(none.dir, "rework").stdout, /submodule/);
  assert.equal(JSON.parse(run(none.dir, "rework", "--json").stdout).submoduleFixes, 0);
  // Ten bumps beside four commits: the note still counts three fixes of four.
  const q = project({ metrics: { minLines: 1 } });
  q.commit({ "src/a.js": SRC }, "feat: add", 0);
  for (const day of [1, 2, 3]) q.commit({ [`src/f${day}.js`]: `export const f = ${day};\n` }, `fix: file ${day}`, day);
  mkdirSync(join(q.dir, "lib", "sub"), { recursive: true });
  for (const digit of "123456789a") {
    git(["update-index", "--add", "--cacheinfo", `160000,${digit.repeat(40)},lib/sub`], { cwd: q.dir });
    q.commit({}, `chore: bump ${digit}`, 4);
  }
  assert.match(run(q.dir, "rework").stdout, /^Note: 3 of 4 candidate commits are fixes\./m);
});

test("cli audit: rework's help says the range is in local days and --days is the window, not the range", () => {
  const help = run(mkdtempSync(join(tmpdir(), "pl-cli-help-")), "rework", "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--since to --until \(local days\)/);
  assert.match(help.stdout, /--days N \(the window after each commit, not the range;/);
});

test("cli: rework shows a file name from history as one line can show it (a terminal escape in it is escaped)", () => {
  const p = project({ metrics: { minLines: 1 } });
  const name = "src/a\x1b[2J.js";
  p.commit({ [name]: SRC }, "feat: add", 0);
  p.commit({ [name]: SRC.replace("a + b", "Number(a) + Number(b)") }, "fix: numbers", 2);
  const text = run(p.dir, "rework", "--since", "2026-01-01", "--until", "2026-01-01");
  assert.equal(text.code, 0, text.stderr);
  assert.ok(!text.stdout.includes("\x1b"), "no escape reaches the terminal");
  assert.match(text.stdout, /· "src\/a\\u001b\[2J\.js" ·/);
});

test("cli audit: an amend! whose target is past a shallow boundary says what went unchecked", () => {
  const p = project({ review: { impactRequiredGlobs: ["src/**"] } });
  p.commit({ "src/a.js": SRC }, "feat: add", 0);
  p.commit({ "README.md": "# x\n" }, "feat: docs", 1);
  const msg = join(p.dir, ".git", "MSG");
  writeFileSync(msg, "amend! feat: add\n\nfeat: add, reworded\n");
  // The whole history: the target is found, and the Impact line it needs is missing.
  const full = run(p.dir, "commit-check", "--hook", msg);
  assert.equal(full.code, 1);
  assert.match(full.stderr, /impact table/);
  writeFileSync(join(p.dir, ".git", "shallow"), `${git(["rev-parse", "HEAD"], { cwd: p.dir })}\n`);
  const cut = run(p.dir, "commit-check", "--hook", msg);
  assert.equal(cut.code, 0);
  assert.match(cut.stderr, /^ennyn: "feat: add" was not found in this shallow clone, so what that commit requires was not checked\.$/m);
  rmSync(join(p.dir, ".git", "shallow"));
});

test("cli audit: a fold target absent from a history of exactly 500 commits is no unchecked part; of 501, it is", () => {
  const p = project();
  const stream = (/** @type {number} */ n) =>
    Array.from({ length: n }, (_, i) => [`commit refs/heads/main`, `committer t <t@t> ${1767268800 + i} +0000`, `data <<EOF`, `chore: c${i + 1}`, "EOF", i ? "" : "deleteall", ""].join("\n")).join("\n");
  spawnSync("git", ["fast-import", "--quiet"], { cwd: p.dir, input: stream(500), encoding: "utf8" });
  const msg = join(p.dir, ".git", "MSG");
  writeFileSync(msg, "amend! chore: never was\n\nchore: never was, reworded\n");
  assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: p.dir }), "500");
  assert.doesNotMatch(run(p.dir, "commit-check", "--hook", msg).stderr, /was not checked/, "the whole history was read");
  writeFileSync(join(p.dir, "f.txt"), "x\n");
  git(["add", "f.txt"], { cwd: p.dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: one more"], { cwd: p.dir });
  assert.match(run(p.dir, "commit-check", "--hook", msg).stderr, /"chore: never was" was not found in the last 500 commits, so what that commit requires was not checked\./);
});

test("cli audit: a tracked instruction file that cannot be read fails budget; inside .git is no project", (t) => {
  const p = project();
  p.commit({ "CLAUDE.md": "# Rules\n\n- Every change keeps the tests green before it is committed.\n" }, "docs: rules", 0);
  const inside = run(join(p.dir, ".git"), "budget");
  assert.equal(inside.code, 1);
  // A git from 2.38 to 2.43 refuses the folder itself under safe.bareRepository=explicit: both are git's words for no project.
  assert.match(inside.stderr, /must be run in a work tree|cannot use bare repository/);
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  chmodSync(join(p.dir, "CLAUDE.md"), 0o000);
  const locked = run(p.dir, "budget");
  chmodSync(join(p.dir, "CLAUDE.md"), 0o644);
  assert.equal(locked.code, 1, "0.0 KB would be a number read from nothing");
  assert.match(locked.stderr, /EACCES/);
});

test("cli: rework says when a fix is dated before the commit it repairs", () => {
  const p = project({ metrics: { minLines: 1 } });
  p.commit({ "src/a.js": SRC }, "feat: add", 5);
  // A month behind: the project helper dates commits in January, this fix lands in December.
  writeFileSync(join(p.dir, "src", "a.js"), SRC.replace("a + b", "Number(a) + Number(b)"));
  git(["add", "-A"], { cwd: p.dir });
  const date = "2025-12-06 12:00:00 +0000";
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fix: numbers"], { cwd: p.dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const text = run(p.dir, "rework");
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Rework: 0 of 1 commits/, "the origin is left out, not counted clean");
  assert.match(text.stdout, /^Commits whose fix is dated before them \(a clock was off\): 1\. They are left out unmeasured, not counted as clean\.$/m);
  assert.doesNotMatch(text.stdout, /shallow/);
});

test("cli: mechanization refuses a graph doctor fails, and says what it picks on a guess", () => {
  const p = project();
  mkdirSync(join(p.dir, ".ennyn"));
  const write = (/** @type {unknown} */ graph) => writeFileSync(join(p.dir, ".ennyn", "graph.json"), JSON.stringify(graph));
  // A finished node left in the open list was picked again.
  write({ nodes: [{ id: "G1", mechanization: true, status: "planned" }], done: [{ id: "G1", status: "done" }] });
  const twice = run(p.dir, "mechanization");
  assert.deepEqual([twice.code, twice.stdout], [1, ""]);
  assert.match(twice.stderr, /^✗ work graph: duplicate ids: G1$/m);
  assert.match(twice.stderr, /nothing is picked from it/);
  assert.equal(run(p.dir, "mechanization", "--json").code, 1);
  // A node with no id was printed as "undefined".
  write({ nodes: [{ mechanization: true }], done: [] });
  assert.doesNotMatch(run(p.dir, "mechanization").stdout, /undefined/);
  // A value the scale does not know is scored as 1, and the pick says so.
  write({ nodes: [{ id: "G1", mechanization: true, value: "hgih", cost: "S" }, { id: "G2", mechanization: true, value: "low", cost: "M" }], done: [] });
  const guess = run(p.dir, "mechanization");
  assert.equal(guess.code, 0);
  assert.equal(guess.stdout.trim(), "G1 (score 1.00)");
  assert.match(guess.stderr, /^! work graph: G1 has value "hgih", which is no positive number and none of high, medium, low; it is scored as 1$/m);
  // Zero is a number, and no weight.
  write({ nodes: [{ id: "G1", mechanization: true, value: 0, cost: "S" }], done: [] });
  assert.match(run(p.dir, "mechanization").stderr, /^! work graph: G1 has value "0", which is no positive number and none of high, medium, low; it is scored as 1$/m);
});

test("cli: mechanization picks from the graph; a missing graph is an error", () => {
  const p = project();
  assert.equal(run(p.dir, "mechanization").code, 1, "no graph yet");
  assert.match(run(p.dir, "mechanization").stderr, /work graph not found/);
  mkdirSync(join(p.dir, ".ennyn"));
  writeFileSync(join(p.dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [], done: [] }));
  assert.equal(run(p.dir, "mechanization").stdout.trim(), "No ready mechanization node.");
  writeFileSync(
    join(p.dir, ".ennyn", "graph.json"),
    JSON.stringify({
      nodes: [
        { id: "G1", mechanization: true, status: "planned", value: "high", cost: "M" },
        { id: "G2", mechanization: true, status: "planned", value: "high", cost: "S", gate: "demand" },
      ],
      done: [],
    }),
  );
  const ok = run(p.dir, "mechanization");
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "G1 (score 1.50)");
  const json = JSON.parse(run(p.dir, "mechanization", "--json").stdout);
  assert.equal(json.node.id, "G1");
  assert.equal(json.score, 1.5);
});

test("cli: core --value lists every open node of that value for a closing to decline; declined ones are out, and doctor counts them", () => {
  const p = project();
  mkdirSync(join(p.dir, ".ennyn"));
  const write = (/** @type {unknown} */ graph) => writeFileSync(join(p.dir, ".ennyn", "graph.json"), JSON.stringify(graph));
  write({
    nodes: [
      { id: "new", value: "low", cost: "S", since: 9 },
      { id: "old", value: "low", cost: "M", cluster: "c", since: 2, needs: ["h"] },
      { id: "h", value: "high", cost: "S", since: 1 },
      { id: "bare", cost: "S", gate: "user", since: 7 },
      { id: "flag", value: "low", mechanization: true, gate: "user", since: 5 },
      { id: "fin", value: "low", status: "done", since: 0 },
    ],
    done: [],
    declined: [{ id: "gone", title: "an idea", reason: "no user asks for it", since: 3 }],
  });
  const low = run(p.dir, "core", "--value", "low");
  assert.equal(low.code, 0, low.stderr);
  assert.equal(low.stdout, "open nodes with value low, oldest first: 3\n  old (M, c)\n  flag (?)\n  new (S)\n");
  assert.deepEqual(JSON.parse(run(p.dir, "core", "--value=low", "--json").stdout).map((/** @type {any} */ n) => n.id), ["old", "flag", "new"]);
  assert.equal(run(p.dir, "core", "--value", "huge").stdout, "open nodes with value huge, oldest first: 0\n");
  // A node with no value has none to match, not the word "undefined".
  assert.equal(run(p.dir, "core", "--value", "undefined").stdout, "open nodes with value undefined, oldest first: 0\n");
  for (const bad of [["--value"], ["--value="]]) assert.equal(run(p.dir, "core", ...bad).code, 2, bad.join(" "));
  assert.equal(run(p.dir, "core").stdout.split("\n")[0], "oldest: h (high, S)");
  assert.match(run(p.dir, "doctor").stdout, /^✓ work graph: 6 open, 0 done, 1 declined \(\.ennyn\/graph\.json\)$/m);
  // Declined and still among the nodes, or needed by one: refused, the list too.
  write({ nodes: [{ id: "gone", value: "low" }, { id: "r", value: "high", needs: ["gone2"] }], done: [], declined: [{ id: "gone", reason: "r" }, { id: "gone2", reason: "r" }] });
  for (const args of [["core"], ["core", "--value", "low"], ["mechanization"]]) {
    const refused = run(p.dir, ...args);
    assert.deepEqual([refused.code, refused.stdout], [1, ""], args.join(" "));
    assert.match(refused.stderr, /^✗ work graph: duplicate ids: gone$/m);
    assert.match(refused.stderr, /^✗ work graph: r needs declined nodes: gone2; drop the need or keep the node$/m);
  }
});

test("cli: core names the oldest node of the highest value and the best of the rest by score, and refuses what mechanization refuses", () => {
  const p = project();
  mkdirSync(join(p.dir, ".ennyn"));
  const write = (/** @type {unknown} */ graph) => writeFileSync(join(p.dir, ".ennyn", "graph.json"), JSON.stringify(graph));
  write({ nodes: [{ id: "G1", status: "planned" }], done: [{ id: "G1", status: "done" }] });
  const twice = run(p.dir, "core");
  assert.deepEqual([twice.code, twice.stdout], [1, ""]);
  assert.match(twice.stderr, /^✗ work graph: duplicate ids: G1$/m);
  assert.match(twice.stderr, /nothing is picked from it/);
  write({ nodes: [{ id: "M", mechanization: true }, { id: "G", gate: "user" }], done: [] });
  assert.deepEqual([run(p.dir, "core").code, run(p.dir, "core").stdout.trim()], [0, "No ready core node."]);
  // The large old node, said to be split first; then the rest by score: five, every node that ties with the
  // fifth (at most ten), the rest counted; each with its score and its cluster when it has one.
  const small = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, value: "high", cost: "S", ...(i % 2 ? { cluster: "c" } : {}) }));
  const mech = { id: "m", value: "high", cost: "S", mechanization: true };
  write({ nodes: [{ id: "eval", value: "high", cost: "L" }, mech, ...small, { id: "low", value: "low", cost: "S" }], done: [] });
  const ok = run(p.dir, "core");
  assert.equal(ok.code, 0);
  const items = (/** @type {string[]} */ ids) => ids.map((id) => `  ${id} (3.00${Number(id.slice(1)) % 2 ? ", c" : ""})\n`).join("");
  const split = "split first: its cost L weighs 3, more than 2.5; write its first step as a node it needs, dated like the others, then run core again\n";
  // Ids sort as strings among equal scores: s0, s1, s10, s11, s2, ...
  assert.equal(ok.stdout, `oldest: eval (high, L)\n${split}by score:\n${items(["s0", "s1", "s10", "s11", "s2", "s3", "s4", "s5", "s6", "s7"])}  +3 more\n`, "the mechanization node is the other slot's");
  // Below the tie: five named, the rest counted; the next score is not named.
  write({ nodes: [{ id: "a", value: "high", cost: "S" }, { id: "b", value: "medium", cost: "S" }, { id: "c", value: "low", cost: "S" }, { id: "d", value: "low", cost: "S" }, { id: "e", value: "low", cost: "M" }, { id: "f", value: "low", cost: "L" }, { id: "g", value: "low", cost: "XL" }], done: [] });
  assert.equal(run(p.dir, "core").stdout, "oldest: a (high, S)\nby score:\n  b (2.00)\n  c (1.00)\n  d (1.00)\n  e (0.50)\n  f (0.33)\n  +1 more\n");
  const listed = JSON.parse(run(p.dir, "core", "--json").stdout);
  assert.deepEqual([listed.byScore.map((/** @type {any} */ e) => e.node.id), listed.more], [["b", "c", "d", "e", "f"], 1]);
  // Split into a first step it needs: the step is the slot's, for the node it serves; it leaves the score list.
  write({ nodes: [{ id: "eval", value: "high", cost: "L", needs: ["eval-1"] }, { id: "a", value: "high", cost: "M" }, { id: "eval-1", value: "high", cost: "S" }], done: [] });
  assert.equal(run(p.dir, "core").stdout, "oldest: eval-1 (high, S), for eval (high, L), which waits on it\nby score:\n  a (1.50)\n");
  const json = JSON.parse(run(p.dir, "core", "--json").stdout);
  assert.deepEqual([json.oldest.node.id, json.oldest.of.id, json.oldest.split, json.byScore.map((/** @type {any} */ e) => [e.node.id, e.score]), json.more], ["eval-1", "eval", false, [["a", 1.5]], 0]);
  // One ready node: it is the oldest, and no other is left to score.
  write({ nodes: [{ id: "only" }], done: [] });
  assert.equal(run(p.dir, "core").stdout, "oldest: only (?, ?)\nby score: no other ready core node\n");
  const one = JSON.parse(run(p.dir, "core", "--json").stdout);
  assert.deepEqual([one.byScore, one.more, one.oldest.split], [[], 0, false]);
});

test("cli: push-check says unmeasured without upstream and warns above the threshold; it exits 1 while what the push needs is unmeasured or not met", () => {
  const p = project({ push: { warnAtUnpushed: 1 } });
  p.commit({ "a.txt": "1" }, "c1");
  const none = run(p.dir, "push-check");
  assert.equal(none.code, 1);
  assert.match(none.stdout, /could not be measured \(no upstream branch\)/);

  const origin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git(["remote", "add", "origin", origin], { cwd: p.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: p.dir });
  p.commit({ "a.txt": "2" }, "c2");
  const under = run(p.dir, "push-check");
  assert.equal(under.code, 1);
  assert.match(under.stdout, /needs a green whole run on HEAD's tree .* \(a\.txt matches push\.codeGlobs\): none is recorded/, "every path is code by default");
  assert.match(under.stdout, /^1 commits are waiting to be pushed \(threshold 1\)\.$/m);
  p.commit({ "a.txt": "3" }, "c3");
  const over = run(p.dir, "push-check");
  assert.equal(over.code, 1);
  assert.match(over.stdout, /2 commits are waiting to be pushed \(threshold 1\)\. Ask for push approval/);
});

/**
 * A project on main with a bare upstream, whose commit sets `config` (after-closing by default) with the approval line
 * unless `line` is false.
 * @param {{ config?: Record<string, unknown>, line?: boolean }} [o]
 */
function closing({ config = { push: { mode: "after-closing" } }, line = true } = {}) {
  const p = project(config);
  p.commit({ "a.txt": "1" }, `chore: push by itself${line ? "\n\nUser-Approved-Loosening: push.mode" : ""}`);
  const origin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git(["remote", "add", "origin", origin], { cwd: p.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: p.dir });
  const head = () => git(["rev-parse", "HEAD"], { cwd: p.dir }).trim();
  return { ...p, origin, head };
}

test("cli: push-check --tested exits 0 only on the approved after-closing, HEAD the named commit on a branch, nothing uncommitted; else it asks", () => {
  const p = closing();
  const head = p.head();
  const untested = run(p.dir, "push-check");
  assert.equal(untested.code, 1);
  assert.match(untested.stdout, /run push-check --tested .*That the test ran is your word: push-check does not check it\./);
  for (const h of [head, head.slice(0, 7)]) {
    const ok = run(p.dir, "push-check", "--tested", h);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, new RegExp(`HEAD ${head.slice(0, 12)} is the commit you name as tested \\(push-check does not check that a test ran\\), with nothing uncommitted: push main with a bare git push`));
  }
  for (const bad of ["HEAD", "main", "-x", `${head}x`]) assert.notEqual(run(p.dir, "push-check", "--tested", bad).code, 0, bad);
  // Anything uncommitted, an untracked file too, is not the tested commit; an ignored one is no change.
  writeFileSync(join(p.dir, "new.txt"), "x");
  assert.match(run(p.dir, "push-check", "--tested", head).stdout, /holds changes or untracked files/);
  writeFileSync(join(p.dir, ".git", "info", "exclude"), "new.txt\n");
  assert.equal(run(p.dir, "push-check", "--tested", head).code, 0);
  writeFileSync(join(p.dir, "a.txt"), "changed");
  const dirty = run(p.dir, "push-check", "--tested", head);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /holds changes or untracked files/);
  git(["checkout", "-q", "--", "a.txt"], { cwd: p.dir });
  p.commit({ "a.txt": "2" }, "c2");
  const moved = run(p.dir, "push-check", "--tested", head);
  assert.equal(moved.code, 1);
  assert.match(moved.stdout, /is not the tested commit .*: ask the user before the push/);
  const now = p.head();
  git(["checkout", "-q", "--detach"], { cwd: p.dir });
  assert.match(run(p.dir, "push-check", "--tested", now).stdout, /HEAD is on no branch: ask the user/);
  git(["checkout", "-q", "main"], { cwd: p.dir });
  // Set back to ask in the work tree, not committed: it asks.
  writeFileSync(join(p.dir, ".ennyn", "config.json"), "{}");
  const split = run(p.dir, "push-check", "--tested", now);
  assert.equal(split.code, 1);
  assert.match(split.stdout, /HEAD's config holds after-closing, the work tree's ask/);
  assert.match(split.stdout, /push\.mode is ask: ask the user before the push\./);
  // Ask in the commit, after-closing only in the work tree: no commit the hook checked says so, so it asks.
  const q = project({});
  q.commit({ "a.txt": "1" }, "c1");
  writeFileSync(join(q.dir, ".ennyn", "config.json"), JSON.stringify({ push: { mode: "after-closing" } }));
  const unsaid = run(q.dir, "push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: q.dir }).trim());
  assert.equal(unsaid.code, 1);
  assert.match(unsaid.stdout, /push\.mode is ask/);
  // HEAD's config does not load: that side is no after-closing, and it is said.
  const broken = project({ push: { mode: "later" } });
  broken.commit({ "a.txt": "1" }, "c1");
  writeFileSync(join(broken.dir, ".ennyn", "config.json"), JSON.stringify({ push: { mode: "after-closing" } }));
  const unread = run(broken.dir, "push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: broken.dir }).trim());
  assert.equal(unread.code, 1);
  assert.match(unread.stdout, /push\.mode could not be read \(.*"push\.mode" must be "ask" or "after-closing".*\), so the push asks the user\./);
  // No commit yet: HEAD holds the defaults, so a work tree that says after-closing still asks.
  const unborn = run(project({ push: { mode: "after-closing" } }).dir, "push-check");
  assert.match(unborn.stdout, /HEAD's config holds ask, the work tree's after-closing/);
  assert.match(unborn.stdout, /push\.mode is ask: ask the user before the push\./);
});

test("cli: push-check asks unless the commit that set after-closing carries the approval line, a revert's or one past --no-verify included", () => {
  const unapproved = closing({ line: false });
  const r = run(unapproved.dir, "push-check", "--tested", unapproved.head());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /the commit that set it \([0-9a-f]{12}\) holds no User-Approved-Loosening: push\.mode line/);
  // Approved, set back to ask, and that commit reverted: the revert set it, with no line.
  const p = closing();
  p.commit({ ".ennyn/config.json": "{}" }, "chore: ask again");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", "HEAD"], { cwd: p.dir });
  assert.match(run(p.dir, "push-check", "--tested", p.head()).stdout, /holds no User-Approved-Loosening: push\.mode line/);
  // A later commit that changes another key keeps the approved one as the setter.
  const q = closing();
  q.commit({ ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing", warnAtUnpushed: 5 } }) }, "chore: threshold");
  git(["push", "-q"], { cwd: q.dir });
  assert.equal(run(q.dir, "push-check", "--tested", q.head()).code, 0);
});

test("cli: push-check asks when a commit HEAD reaches took after-closing back after the approval, on any line, and in a shallow clone", () => {
  const g = (/** @type {string} */ dir, /** @type {string[]} */ ...args) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  // The user sets it back to ask; a branch from before that merges main with -s ours and is fast-forwarded.
  const p = closing();
  p.commit({ ".ennyn/config.json": "{}" }, "chore: the user sets it back to ask");
  g(p.dir, "checkout", "-q", "-b", "side", "HEAD~1");
  p.commit({ "b.txt": "b" }, "chore: side work");
  g(p.dir, "merge", "-q", "-s", "ours", "-m", "chore: merge main", "main");
  g(p.dir, "checkout", "-q", "main");
  g(p.dir, "merge", "-q", "--ff-only", "side");
  assert.equal(JSON.parse(readFileSync(join(p.dir, ".ennyn", "config.json"), "utf8")).push.mode, "after-closing", "the merge kept the branch's mode");
  const r = run(p.dir, "push-check", "--tested", p.head());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /a commit HEAD reaches \([0-9a-f]{12}\) set it back to ask after the approval/);
  // A merged branch that never touched the mode is no move back.
  const q = closing();
  g(q.dir, "checkout", "-q", "-b", "old", "HEAD~0");
  q.commit({ "c.txt": "c" }, "chore: old work");
  g(q.dir, "checkout", "-q", "main");
  q.commit({ "d.txt": "d" }, "chore: main work");
  g(q.dir, "merge", "-q", "--no-edit", "old");
  assert.equal(run(q.dir, "push-check", "--tested", q.head()).code, 0);
  // A merge that keeps a branch's ask over the approval it brings takes it back, by its second parent: the branch
  // forked before the approval, merged main -s ours, and main took that merge in with -s ours too.
  const m = project({});
  m.commit({ "a.txt": "1" }, "c1");
  g(m.dir, "branch", "old");
  m.commit({ ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing" } }) }, "chore: on\n\nUser-Approved-Loosening: push.mode");
  g(m.dir, "checkout", "-q", "old");
  g(m.dir, "merge", "-q", "-s", "ours", "-m", "chore: keep ask", "main");
  g(m.dir, "checkout", "-q", "main");
  g(m.dir, "merge", "-q", "-s", "ours", "-m", "chore: keep after-closing", "old");
  const origin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git(["remote", "add", "origin", origin], { cwd: m.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: m.dir });
  assert.match(run(m.dir, "push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: m.dir }).trim()).stdout, /set it back to ask after the approval/);
  // A first commit with no config holds the defaults: the approved commit after it set the mode.
  const late = project(undefined);
  late.commit({ "a.txt": "1" }, "c1");
  late.commit({ ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing" } }) }, "chore: on\n\nUser-Approved-Loosening: push.mode");
  const lateOrigin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: lateOrigin });
  git(["remote", "add", "origin", lateOrigin], { cwd: late.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: late.dir });
  assert.equal(run(late.dir, "push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: late.dir }).trim()).code, 0);
  // A shallow clone has no history to read.
  const shallow = mkdtempSync(join(tmpdir(), "pl-cli-shallow-"));
  g(shallow, "clone", "-q", "--depth", "1", `file://${q.dir}`, "c");
  const c = join(shallow, "c");
  assert.match(run(c, "push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: c }).trim()).stdout, /this clone is shallow/);
});

test("cli: push-check reads the config's history in a fixed number of git calls, however long it is", () => {
  const bin = mkdtempSync(join(tmpdir(), "pl-cli-git-"));
  const log = join(bin, "calls");
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho x >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const calls = (/** @type {number} */ n) => {
    const p = closing();
    for (let i = 0; i < n; i++) p.commit({ ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing", warnAtUnpushed: 10 + i } }) }, `chore: threshold ${i}`);
    writeFileSync(log, "");
    const r = spawnSync(process.execPath, [CLI, "push-check", "--tested", p.head()], { cwd: p.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  };
  assert.equal(calls(30), calls(2));
});

test("cli: push-check reads git config as git push does: what makes a bare push send more asks, and the real push agrees", () => {
  /** @param {string} origin */
  const heads = (origin) => git([`--git-dir=${origin}`, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], { cwd: origin }).trim();
  // Each setting, then the real bare push it would have allowed: it sends more than main to its upstream.
  for (const [key, value] of [["remote.origin.mirror", "true"], ["remote.origin.push", "+refs/heads/*:refs/heads/*"], ["push.default", "matching"]]) {
    const p = closing();
    git(["push", "-q", "origin", "main:keep"], { cwd: p.dir });
    git(["branch", "side"], { cwd: p.dir });
    git(["push", "-q", "origin", "side"], { cwd: p.dir });
    git(["branch", "-f", "side", "HEAD"], { cwd: p.dir });
    p.commit({ "a.txt": "2" }, "c2");
    git(["checkout", "-q", "side"], { cwd: p.dir });
    p.commit({ "b.txt": "s" }, "side moves");
    git(["checkout", "-q", "main"], { cwd: p.dir });
    git(["config", key, value], { cwd: p.dir });
    const r = run(p.dir, "push-check", "--tested", p.head());
    assert.equal(r.code, 1, key);
    assert.match(r.stdout, new RegExp(`git config ${key.replace(/\./g, "\\.")} makes a bare git push send more than the current branch`), key);
    const before = heads(p.origin);
    git(["push", "-q"], { cwd: p.dir });
    const after = heads(p.origin);
    assert.notEqual(after.split("\n").filter((l) => !l.startsWith("main ")).join("\n"), before.split("\n").filter((l) => !l.startsWith("main ")).join("\n"), `${key}: the real push changed a branch other than main`);
  }
  for (const [key, value] of [["push.followTags", "true"], ["remote.pushDefault", "other"], ["branch.main.pushRemote", "other"], ["push.recurseSubmodules", "on-demand"]]) {
    const p = closing();
    git(["config", key, value], { cwd: p.dir });
    assert.match(run(p.dir, "push-check", "--tested", p.head()).stdout, new RegExp(`git config ${key.replace(/\./g, "\\.")} makes`), key);
  }
  // Where the push goes is read by allowing, not by naming what widens it: a push url, a second url, a rewrite of
  // either, a remote setting no fetch needs, a submodule push.
  for (const [setting, ...change] of [
    ["remote.origin.pushurl", "remote.origin.pushurl", "/elsewhere.git"],
    ["remote.origin.url", "--add", "remote.origin.url", "/elsewhere.git"],
    ["remote.origin.url", "url./elsewhere/.pushInsteadOf", "/"],
    ["remote.origin.url", "url./elsewhere/.insteadOf", "/"],
    ["remote.origin.receivepack", "remote.origin.receivepack", "git-receive-pack"],
    ["submodule.recurse", "submodule.recurse", "true"],
    ["push.recurseSubmodules", "push.recurseSubmodules", "yes"],
  ]) {
    const p = closing();
    git(["config", ...change], { cwd: p.dir });
    assert.match(run(p.dir, "push-check", "--tested", p.head()).stdout, new RegExp(`git config ${setting.replace(/\./g, "\\.")} makes`), change.join(" "));
  }
  // A push url sends the real push to another remote: the reading agrees.
  const elsewhere = mkdtempSync(join(tmpdir(), "pl-cli-elsewhere-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: elsewhere });
  const pu = closing();
  pu.commit({ "a.txt": "2" }, "c2");
  git(["config", "remote.origin.pushurl", elsewhere], { cwd: pu.dir });
  git(["push", "-q"], { cwd: pu.dir });
  assert.equal(heads(elsewhere), `main ${pu.head()}`);
  assert.notEqual(heads(pu.origin), `main ${pu.head()}`);
  // Fetch settings change no push: allowed.
  const fetches = closing();
  for (const [k, v] of [["remote.origin.prune", "true"], ["remote.origin.tagOpt", "--no-tags"]]) git(["config", k, v], { cwd: fetches.dir });
  assert.equal(run(fetches.dir, "push-check", "--tested", fetches.head()).code, 0);
  // No upstream, a local one, or one of another name: no bare push of main to main.
  for (const [setting, change] of [["branch.main.remote", ["branch", "--unset-upstream"]], ["branch.main.remote", ["config", "branch.main.remote", "."]], ["branch.main.merge", ["config", "branch.main.merge", "refs/heads/other"]]]) {
    const p = closing();
    git(change, { cwd: p.dir });
    assert.match(run(p.dir, "push-check", "--tested", p.head()).stdout, new RegExp(`git config ${setting.replace(/\./g, "\\.")} makes`), change.join(" "));
  }
  // The control: allowed, and the real bare push sends main alone.
  const p = closing();
  git(["push", "-q", "origin", "main:keep"], { cwd: p.dir });
  git(["branch", "side"], { cwd: p.dir });
  p.commit({ "a.txt": "2" }, "c2");
  for (const v of [null, "simple", "upstream", "current"]) {
    if (v) git(["config", "push.default", v], { cwd: p.dir });
    assert.equal(run(p.dir, "push-check", "--tested", p.head()).code, 0, String(v));
  }
  git(["push", "-q"], { cwd: p.dir });
  assert.deepEqual(heads(p.origin).split("\n").map((l) => l.split(" ")[0]), ["keep", "main"]);
  assert.notEqual(git([`--git-dir=${p.origin}`, "rev-parse", "keep"], { cwd: p.origin }).trim(), p.head(), "keep untouched");
});

/**
 * A project with a bare upstream whose fast and whole commands are node one-liners: each appends its kind to the file
 * T_LOG names and exits with T_EXIT. `.mjs` is code (push.codeGlobs), anything else is not.
 * @param {Record<string, unknown>} [extra] more config
 */
function recorded(extra = {}) {
  const cmd = (/** @type {string} */ kind) => `"${process.execPath}" -e "require('fs').appendFileSync(process.env.T_LOG, '${kind} '); process.exit(Number(process.env.T_EXIT || 0))"`;
  const p = project({ commands: { fastTest: cmd("fast"), wholeTest: cmd("whole") }, push: { codeGlobs: ["**/*.mjs"] }, ...extra });
  p.commit({ "a.txt": "1" }, "c1\n\nUser-Approved-Loosening: push.mode");
  const origin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git(["remote", "add", "origin", origin], { cwd: p.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: p.dir });
  const log = join(mkdtempSync(join(tmpdir(), "pl-cli-log-")), "runs");
  writeFileSync(log, "");
  /** @param {string} cwd @param {string[]} args @param {string} [exit] */
  const go = (cwd, args, exit = "0") => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, T_LOG: log, T_EXIT: exit } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { ...p, origin, log, ran: () => readFileSync(log, "utf8").trim(), go, tree: () => git(["rev-parse", "HEAD^{tree}"], { cwd: p.dir }).trim().slice(0, 12) };
}

test("cli: test records a run by HEAD's tree on a clean work tree; push-check says what the push needs, met only by a green run on that tree", () => {
  const p = recorded();
  p.commit({ "notes.txt": "1" }, "c2");
  const before = p.go(p.dir, ["push-check"]);
  assert.equal(before.code, 1, before.stdout);
  assert.match(before.stdout, new RegExp(`needs a green fast run on HEAD's tree ${p.tree()} \\(no path the push changes matches push\\.codeGlobs\\): none is recorded\\. Run ennyn test fast on a clean work tree, or ask the user\\.`));
  const fast = p.go(p.dir, ["test", "fast"]);
  assert.equal(fast.code, 0, fast.stdout + fast.stderr);
  assert.match(fast.stdout, new RegExp(`Recorded: fast run on tree ${p.tree()}, green\\.`));
  const met = p.go(p.dir, ["push-check"]);
  assert.equal(met.code, 0, met.stdout);
  assert.match(met.stdout, new RegExp(`needs a green fast run on HEAD's tree ${p.tree()} .*: met, recorded at `));
  assert.match(met.stdout, /push\.mode is ask: ask the user before the push\./, "a record never turns ask into a push");
  // The same tree again: not run, and the skip is recorded.
  const again = p.go(p.dir, ["test", "fast"]);
  assert.match(again.stdout, /is recorded at .*: not run again/);
  assert.equal(p.ran(), "fast");
  assert.equal(p.go(p.dir, ["test", "fast", "--again"]).code, 0);
  assert.equal(p.ran(), "fast fast");
  // A code path: a whole run is needed, and a fast one does not answer for it.
  p.commit({ "src/x.mjs": "export {};\n" }, "c3");
  assert.equal(p.go(p.dir, ["test", "fast"]).code, 0);
  const code = p.go(p.dir, ["push-check"]);
  assert.equal(code.code, 1);
  assert.match(code.stdout, /needs a green whole run on HEAD's tree .* \(src\/x\.mjs matches push\.codeGlobs\): none is recorded\. Run ennyn test whole/);
  assert.equal(p.go(p.dir, ["test", "whole"]).code, 0);
  assert.equal(p.go(p.dir, ["push-check"]).code, 0);
  // A record on another tree does not count.
  p.commit({ "notes.txt": "2" }, "c4");
  assert.match(p.go(p.dir, ["push-check"]).stdout, /none is recorded/);
  // A dirty tree records nothing: an untracked file, a staged change, an unstaged edit.
  for (const dirty of [() => writeFileSync(join(p.dir, "loose.txt"), "x"), () => git(["add", "loose.txt"], { cwd: p.dir }), () => (git(["rm", "-q", "--cached", "loose.txt"], { cwd: p.dir }), rmSync(join(p.dir, "loose.txt")), writeFileSync(join(p.dir, "notes.txt"), "edited"))]) {
    dirty();
    const r = p.go(p.dir, ["test", "fast"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /This run is not recorded: the work tree holds changes or untracked files\./);
  }
  git(["checkout", "-q", "--", "notes.txt"], { cwd: p.dir });
  assert.match(p.go(p.dir, ["push-check"]).stdout, /none is recorded/);
  // A red run is recorded, and the push is not met; the exit is the command's.
  const red = p.go(p.dir, ["test", "whole"], "3");
  assert.equal(red.code, 3);
  assert.match(red.stdout, /whole run on tree .*, red, exit 3\./);
  const after = p.go(p.dir, ["push-check"]);
  assert.equal(after.code, 1);
  assert.match(after.stdout, /the last one, at .*, failed/);
  // A run that commits tested no tree it can name.
  const commits = project({ commands: { fastTest: `git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x` } });
  commits.commit({ "a.txt": "1" }, "c1");
  assert.match(run(commits.dir, "test", "fast").stdout, /This run is not recorded: HEAD moved during the run\./);
  // Unset: said, nothing runs.
  const unset = project({});
  unset.commit({ "a.txt": "1" }, "c1");
  const none = run(unset.dir, "test", "whole");
  assert.equal(none.code, 78);
  assert.match(none.stderr, /commands\.wholeTest names no command/);
  assert.equal(run(unset.dir, "test", "slow").code, 2);
});

test("cli: a run recorded in a linked worktree counts for the main checkout after a fast-forward; a branch behind its upstream is refused", async () => {
  const p = recorded();
  const wt = join(mkdtempSync(join(tmpdir(), "pl-cli-wt-")), "wt");
  git(["worktree", "add", "-q", "-b", "task", wt], { cwd: p.dir });
  writeFileSync(join(wt, "doc.txt"), "task");
  git(["add", "doc.txt"], { cwd: wt });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "task"], { cwd: wt });
  assert.equal(p.go(wt, ["test", "fast"]).code, 0);
  git(["merge", "-q", "--ff-only", "task"], { cwd: p.dir });
  const landed = p.go(p.dir, ["push-check"]);
  assert.equal(landed.code, 0, landed.stdout);
  assert.match(landed.stdout, /: met, recorded at /);
  // The landing's own run on that tree is not run again.
  assert.match(p.go(p.dir, ["test", "fast"]).stdout, /not run again/);
  assert.equal(p.ran(), "fast");
  // Someone else pushed: push-check fetches and refuses the branch behind.
  const other = mkdtempSync(join(tmpdir(), "pl-cli-other-"));
  git(["clone", "-q", p.origin, other], { cwd: other });
  writeFileSync(join(other, "theirs.txt"), "x");
  git(["add", "theirs.txt"], { cwd: other });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "theirs"], { cwd: other });
  git(["push", "-q"], { cwd: other });
  const behind = p.go(p.dir, ["push-check"]);
  assert.equal(behind.code, 1, behind.stdout);
  assert.match(behind.stdout, /The branch is 1 commits behind its upstream: rebase/);
  assert.doesNotMatch(behind.stdout, /: met/);
  // Behind and ahead at once: no need is named, whatever the record holds.
  const { pushNeeds } = await import("../checks/test-runs.mjs");
  const { loadConfig } = await import("../core/config.mjs");
  const both = pushNeeds(p.dir, loadConfig({ cwd: p.dir, env: {} }));
  assert.ok(!("unmeasured" in both) && both.behind === 1 && both.ahead === 1 && both.need === null && !both.met, JSON.stringify(both));
  // No upstream: unmeasured, and it asks.
  git(["branch", "-q", "--unset-upstream"], { cwd: p.dir });
  const lone = p.go(p.dir, ["push-check"]);
  assert.equal(lone.code, 1);
  assert.match(lone.stdout, /What the push needs is unmeasured \(the branch has no upstream\)/);
});

test("cli: under after-closing a green record on HEAD's tree lets push-check say push; a red one refuses --tested, which counts only where the record is silent", () => {
  const p = recorded({ push: { mode: "after-closing", codeGlobs: ["**/*.mjs"] } });
  p.commit({ "src/y.mjs": "export {};\n" }, "c2");
  const untested = p.go(p.dir, ["push-check"]);
  assert.equal(untested.code, 1);
  assert.match(untested.stdout, /the record holds no green run of what the push needs/);
  assert.equal(p.go(p.dir, ["test", "whole"], "1").code, 1);
  const red = p.go(p.dir, ["push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: p.dir }).trim()]);
  assert.equal(red.code, 1, red.stdout);
  assert.match(red.stdout, /failed\. Fix it/);
  // A red last run is no reason to skip: it runs again.
  assert.equal(p.go(p.dir, ["test", "whole"]).code, 0);
  assert.equal(p.ran(), "whole whole");
  const ok = p.go(p.dir, ["push-check"]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /push\.mode is after-closing and the record holds what the push needs on HEAD's tree .*: push main with a bare git push/);
  writeFileSync(join(p.dir, "loose.txt"), "x");
  assert.equal(p.go(p.dir, ["push-check"]).code, 1, "nothing uncommitted");
  rmSync(join(p.dir, "loose.txt"));
  // The record says nothing of a new tree: --tested is the word, as before.
  p.commit({ "src/z.mjs": "export {};\n" }, "c3");
  assert.equal(p.go(p.dir, ["push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: p.dir }).trim()]).code, 0);
});

test("cli: test runs but records nothing on a sparse checkout, a skip-worktree or assume-unchanged entry, or a command that cannot fail", () => {
  const p = recorded();
  p.commit({ "docs/a.txt": "1", "notes.txt": "1" }, "c2");
  const unrecorded = (/** @type {RegExp} */ why) => {
    const r = p.go(p.dir, ["test", "fast"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, why);
    assert.doesNotMatch(r.stdout, /Recorded:/);
  };
  git(["sparse-checkout", "set", "--no-cone", "/notes.txt", "/.ennyn/"], { cwd: p.dir });
  unrecorded(/This run is not recorded: sparse checkout is on\./);
  git(["sparse-checkout", "disable"], { cwd: p.dir });
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
    git(["update-index", flag, "notes.txt"], { cwd: p.dir });
    writeFileSync(join(p.dir, "notes.txt"), "edited, and git status does not say so");
    unrecorded(/This run is not recorded: the index marks 1 entries skip-worktree or assume-unchanged\./);
    git(["update-index", flag.replace("--", "--no-"), "notes.txt"], { cwd: p.dir });
    git(["checkout", "-q", "--", "notes.txt"], { cwd: p.dir });
  }
  assert.equal(p.ran(), "fast fast fast", "each ran");
  // A whole command doctor fails as one that cannot fail: run, never recorded, and doctor says so.
  const noop = project({ commands: { fastTest: "npm test", wholeTest: "npm test || true" } });
  noop.commit({ "a.txt": "1" }, "c1");
  const r = run(noop.dir, "test", "whole");
  assert.match(r.stdout, /This run is not recorded: commands\.wholeTest exits 0 whatever runs \(doctor fails it\)/);
  assert.match(run(noop.dir, "doctor").stdout, /✗ whole test: npm test \|\| true exits 0 whatever runs/);
});

test("cli: a red run of either kind on HEAD's tree stops --tested; a fast run counts only when its base is the push's upstream or before it", async () => {
  const p = recorded({ push: { mode: "after-closing", codeGlobs: ["**/*.mjs"] } });
  p.commit({ "src/y.mjs": "export {};\n" }, "c2");
  assert.equal(p.go(p.dir, ["test", "fast"], "1").code, 1);
  const head = git(["rev-parse", "HEAD"], { cwd: p.dir }).trim();
  const red = p.go(p.dir, ["push-check", "--tested", head]);
  assert.equal(red.code, 1, red.stdout);
  // Two landings between pushes: the second task's fast run began at the first landing, after the upstream.
  const q = recorded();
  q.commit({ "one.txt": "1" }, "task one");
  const wt = join(mkdtempSync(join(tmpdir(), "pl-cli-wt-")), "wt");
  git(["worktree", "add", "-q", "-b", "two", wt, "main"], { cwd: q.dir });
  writeFileSync(join(wt, "two.txt"), "2");
  git(["add", "two.txt"], { cwd: wt });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "task two"], { cwd: wt });
  assert.equal(q.go(wt, ["test", "fast"]).code, 0);
  git(["merge", "-q", "--ff-only", "two"], { cwd: q.dir });
  const later = q.go(q.dir, ["push-check"]);
  assert.equal(later.code, 1, later.stdout);
  assert.match(later.stdout, /none is recorded/);
  // On main the run's base is the upstream: it runs again, and then counts.
  const again = q.go(q.dir, ["test", "fast"]);
  assert.match(again.stdout, /Recorded: fast run/);
  assert.equal(q.ran(), "fast fast");
  assert.equal(q.go(q.dir, ["push-check"]).code, 0);
  const { readRuns } = await import("../checks/test-runs.mjs");
  const { loadConfig } = await import("../core/config.mjs");
  const runs = readRuns(q.dir, loadConfig({ cwd: q.dir, env: {} })).runs;
  assert.deepEqual(runs.map((r) => r.base), [git(["rev-parse", "HEAD~1"], { cwd: q.dir }).trim(), git(["rev-parse", "origin/main"], { cwd: q.dir }).trim()]);
  // A bare push that goes to another remote: the upstream says nothing of it.
  const other = mkdtempSync(join(tmpdir(), "pl-cli-other-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: other });
  git(["remote", "add", "other", other], { cwd: q.dir });
  git(["config", "remote.pushDefault", "other"], { cwd: q.dir });
  const elsewhere = q.go(q.dir, ["push-check"]);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stdout, /What the push needs is unmeasured \(a bare git push goes .*, not to the upstream refs\/remotes\/origin\/main\)/);
  // Once git can name where it goes, another remote's branch, the answer is the same (simple names none here).
  git(["config", "push.default", "current"], { cwd: q.dir });
  git(["push", "-q", "other", "main"], { cwd: q.dir });
  git(["fetch", "-q", "other"], { cwd: q.dir });
  assert.equal(git(["rev-parse", "--symbolic-full-name", "@{push}"], { cwd: q.dir }).trim(), "refs/remotes/other/main");
  const named = q.go(q.dir, ["push-check"]);
  assert.equal(named.code, 1, named.stdout);
  assert.match(named.stdout, /a bare git push goes to refs\/remotes\/other\/main, not to the upstream refs\/remotes\/origin\/main/);
});

test("cli: test records nothing of a pipeline or of a submodule that differs from HEAD, whatever hides it", () => {
  // A pipeline's status is its last program's: the test's red would read green.
  const pipe = project({ commands: { fastTest: `"${process.execPath}" -e "process.exit(1)" 2>&1 | cat` } });
  pipe.commit({ "a.txt": "1" }, "c1");
  const piped = run(pipe.dir, "test", "fast");
  assert.equal(piped.code, 0, "the pipeline's own status");
  assert.match(piped.stdout, /This run is not recorded: commands\.fastTest holds a pipe, and a pipeline's status is its last program's\./);
  assert.doesNotMatch(piped.stdout, /Recorded:/);
  assert.match(run(pipe.dir, "doctor").stdout, /! fast test: commands\.fastTest holds a pipe/);
  // A submodule whose content differs from what HEAD records: .gitmodules ignore = all, or the config's diff.ignoreSubmodules.
  const p = recorded({ push: { mode: "after-closing", codeGlobs: ["**/*.mjs"] } });
  const lib = mkdtempSync(join(tmpdir(), "pl-cli-lib-"));
  git(["init", "-q", "-b", "main"], { cwd: lib });
  writeFileSync(join(lib, "verdict.txt"), "fail\n");
  git(["add", "-A"], { cwd: lib });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lib"], { cwd: lib });
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"], { cwd: p.dir });
  git(["config", "-f", ".gitmodules", "submodule.lib.ignore", "all"], { cwd: p.dir });
  p.commit({}, "lib");
  writeFileSync(join(p.dir, "lib", "verdict.txt"), "pass\n");
  const hidden = p.go(p.dir, ["test", "fast"]);
  assert.match(hidden.stdout, /This run is not recorded: the work tree holds changes or untracked files\./);
  git(["config", "-f", ".gitmodules", "--unset", "submodule.lib.ignore"], { cwd: p.dir });
  p.commit({}, "lib seen");
  git(["config", "diff.ignoreSubmodules", "all"], { cwd: p.dir });
  const local = p.go(p.dir, ["test", "fast"]);
  assert.match(local.stdout, /This run is not recorded: the work tree holds changes or untracked files\./);
  assert.equal(p.ran(), "fast fast", "each ran");
  assert.equal(existsSync(join(p.dir, ".git", "ennyn", "test-runs.jsonl")), false);
  // A green run on the clean tree, then the submodule edited: push-check under after-closing does not read it clean.
  git(["checkout", "-q", "--", "verdict.txt"], { cwd: join(p.dir, "lib") });
  assert.match(p.go(p.dir, ["test", "fast"]).stdout, /Recorded: fast run/);
  writeFileSync(join(p.dir, "lib", "verdict.txt"), "pass\n");
  const dirty = p.go(p.dir, ["push-check"]);
  assert.equal(dirty.code, 1, dirty.stdout);
  assert.match(dirty.stdout, /push\.mode is after-closing, but the work tree holds changes or untracked files/);
});

test("cli: the last run on the tree decides: a red one whatever its base stops met; --tested over a red run is said with the run", () => {
  const p = recorded({ push: { mode: "after-closing", codeGlobs: ["**/*.mjs"] } });
  p.commit({ "b.txt": "2" }, "text change");
  assert.equal(p.go(p.dir, ["test", "fast"]).code, 0, "green, its base the upstream");
  // The same tree on a branch whose base is past the upstream: red.
  git(["checkout", "-q", "-b", "side"], { cwd: p.dir });
  git(["config", "branch.side.remote", "."], { cwd: p.dir });
  git(["config", "branch.side.merge", "refs/heads/main"], { cwd: p.dir });
  assert.equal(p.go(p.dir, ["test", "fast", "--again"], "1").code, 1);
  git(["checkout", "-q", "main"], { cwd: p.dir });
  const after = p.go(p.dir, ["push-check"]);
  assert.equal(after.code, 1, after.stdout);
  assert.match(after.stdout, /the last one, at .*, failed/);
  const head = git(["rev-parse", "HEAD"], { cwd: p.dir }).trim();
  const tested = p.go(p.dir, ["push-check", "--tested", head]);
  assert.equal(tested.code, 1, tested.stdout);
  assert.match(tested.stdout, /--tested does not stand: the record holds a red fast run on HEAD's tree [0-9a-f]{12}, at \d{4}-\d\d-\d\dT[^ ]+, exit 1\./);
  // A red run of the smaller kind under a code push: the need is a whole run, and the line names the fast one.
  p.commit({ "src/z.mjs": "export {};\n" }, "code");
  assert.equal(p.go(p.dir, ["test", "fast"], "1").code, 1);
  const code = p.go(p.dir, ["push-check", "--tested", git(["rev-parse", "HEAD"], { cwd: p.dir }).trim()]);
  assert.equal(code.code, 1, code.stdout);
  assert.match(code.stdout, /none is recorded/);
  assert.match(code.stdout, /--tested does not stand: the record holds a red fast run on HEAD's tree/);
});

test("cli: test whole with no command set exits 78, apart from a red run; doctor warns", () => {
  const unset = project({ commands: { fastTest: "npm test" } });
  unset.commit({ "a.txt": "1" }, "c1");
  const none = run(unset.dir, "test", "whole");
  assert.equal(none.code, 78);
  assert.match(none.stderr, /commands\.wholeTest names no command/);
  assert.match(run(unset.dir, "doctor").stdout, /! whole test: commands\.wholeTest is unset/);
});

test("cli: config errors exit 1 with the message; config is found from a subdirectory; Turkish output", () => {
  const bad = project({ review: { maxRounds: "two" }, bogus: 1 });
  const r = run(bad.dir, "push-check");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid ennyn config/);
  assert.match(r.stderr, /"bogus"/);

  const tr = project({ language: "tr" });
  mkdirSync(join(tr.dir, "deep", "er"), { recursive: true });
  const sub = run(join(tr.dir, "deep", "er"), "push-check");
  assert.equal(sub.code, 1);
  assert.match(sub.stdout, /Gönderilmemiş commit sayısı ölçülemedi/);
});

test("cli: commit-check counts kept `#` lines when git says the message came from -m / -F", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-ged-"));
  git(["init", "-q"], { cwd: dir });
  const msg = join(dir, "MSG");
  writeFileSync(msg, "s\n\n" + Array.from({ length: 12 }, (_, i) => `# hidden ${i}`).join("\n") + "\n");
  const r = (/** @type {Record<string, string>} */ extra) =>
    spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: { ...process.env, ...extra }, encoding: "utf8" });
  assert.equal(r({}).status, 0, "editor commit: git drops `#` lines");
  const kept = r({ GIT_EDITOR: ":" });
  assert.equal(kept.status, 1);
  assert.match(kept.stderr, /12 prose lines/);
});

test("cli: commit-check reads git's comment marker (core.commentChar / commentString, auto from the template)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-cc-"));
  git(["init", "-q"], { cwd: dir });
  const msg = join(dir, "MSG");
  writeFileSync(msg, "s\n\n" + Array.from({ length: 12 }, (_, i) => `; Please enter the commit message ${i}`).join("\n") + "\n");
  const run = () => spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, encoding: "utf8" });
  assert.equal(run().status, 1, "with # the ; lines are prose");
  git(["config", "core.commentChar", ";"], { cwd: dir });
  assert.equal(run().status, 0, run().stderr);
  git(["config", "core.commentChar", "auto"], { cwd: dir });
  assert.equal(run().status, 0, "auto: the marker git put before its own template line");
  git(["config", "--unset", "core.commentChar"], { cwd: dir });
  git(["config", "core.commentString", ";"], { cwd: dir });
  assert.equal(run().status, 0, "commentString wins");
});

test("cli: commit-check with core.commentChar=auto and no template line follows git's choice", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-auto-"));
  git(["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { style: "terse" } }));
  git(["config", "core.commentChar", "auto"], { cwd: dir });
  const msg = join(dir, "MSG");
  // A line starts with "#", so git picks ";" and stores "#12 referenced" as prose (git commit --no-status).
  writeFileSync(msg, "s\n\n#12 referenced\n");
  const r = spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /terse/);
  // No "#" anywhere: git keeps "#", and nothing here is a comment either way.
  writeFileSync(msg, "s\n");
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir }).status, 0);
});

test("cli: commit-check follows commit.cleanup (strip, whitespace, verbatim, scissors) over the -m / editor default", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cli-cleanup-"));
  git(["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { style: "terse" } }));
  const msg = join(dir, "MSG");
  writeFileSync(msg, "s\n\n# a comment line\n# ------------------------ >8 ------------------------\ndiff --git a b\n");
  const run = (/** @type {Record<string, string>} */ extra) => spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: { ...process.env, ...extra }, encoding: "utf8" }).status;
  const set = (/** @type {string | null} */ v) => (v ? git(["config", "commit.cleanup", v], { cwd: dir }) : gitMaybe(["config", "--unset", "commit.cleanup"], { cwd: dir, absent: [5] }));
  // Default: the editor strips "#" lines and cuts at the scissors line; -m keeps them as text.
  set(null);
  assert.deepEqual([run({}), run({ GIT_EDITOR: ":" })], [0, 1]);
  // strip strips "#" lines even with -m, but only an edited message is cut: the diff line stays with -m.
  set("strip");
  assert.deepEqual([run({}), run({ GIT_EDITOR: ":" })], [0, 1]);
  set("whitespace");
  assert.deepEqual([run({}), run({ GIT_EDITOR: ":" })], [1, 1]);
  set("verbatim");
  assert.equal(run({}), 1);
  // git commit -v: an edited message is cut at the scissors line in every mode, whitespace and verbatim too.
  writeFileSync(msg, "s\n\n# ------------------------ >8 ------------------------\ndiff --git a b\n");
  for (const mode of ["whitespace", "verbatim"]) {
    set(mode);
    assert.equal(run({}), 0, mode);
  }
  // strip with -m drops the "#" lines but cuts nothing: the diff after it is stored as text.
  set("strip");
  assert.equal(run({ GIT_EDITOR: ":" }), 1);
  writeFileSync(msg, "s\n\n# a comment line\n");
  assert.equal(run({ GIT_EDITOR: ":" }), 0);
  // scissors: the cut happens only when the editor ran; the "#" line before it stays text.
  writeFileSync(msg, "s\n\n# ------------------------ >8 ------------------------\ndiff --git a b\n");
  set("scissors");
  assert.deepEqual([run({}), run({ GIT_EDITOR: ":" })], [0, 1]);
  // Without -v git keeps a scissors line typed by hand and the prose under it, in every mode.
  writeFileSync(msg, "s\n\n# ------------------------ >8 ------------------------\nprose under the line\n");
  for (const mode of ["strip", "whitespace", "verbatim"]) {
    set(mode);
    assert.equal(run({}), 1, mode);
  }
  // The scissors mode cuts it when the editor ran, -v or not.
  set("scissors");
  assert.deepEqual([run({}), run({ GIT_EDITOR: ":" })], [0, 1]);
  // commit.verbose: git cuts a -m message at the line too.
  set(null);
  git(["config", "commit.verbose", "true"], { cwd: dir });
  assert.equal(run({ GIT_EDITOR: ":" }), 0);
});

test("cli: commit-check prints a cochange warning on stderr and still passes", () => {
  const p = project({ review: { cochange: [{ paths: ["README.md"], docs: ["README.tr.md"] }] } });
  writeFileSync(join(p.dir, "README.md"), "# x\n");
  git(["add", "README.md", ".ennyn/config.json"], { cwd: p.dir });
  const msg = join(p.dir, ".git", "MSG");
  writeFileSync(msg, "feat: readme\n");
  const r = run(p.dir, "commit-check", msg);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^Warning: README\.md changed, but not README\.tr\.md\. /m);
  writeFileSync(join(p.dir, "README.tr.md"), "# x\n");
  git(["add", "README.tr.md"], { cwd: p.dir });
  assert.equal(run(p.dir, "commit-check", msg).stderr, "");
});

/**
 * Whether this git reads GIT_NO_LAZY_FETCH, asked of a partial clone of its own: with the variable set, a blob the
 * clone lacks is fetched or not. Its version does not say: git reads it from 2.45 and in the maintenance releases of
 * May 2024 (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1), not in 2.44.0, and distributions took that fix into
 * older ones (Ubuntu 22.04's 2.34.1 and Debian 12's 2.39.5, the Linux run's, read it).
 * @param {string} box
 */
function readsNoLazyFetch(box) {
  const src = join(box, "probe-src");
  mkdirSync(src);
  git(["init", "-q", "-b", "main"], { cwd: src });
  writeFileSync(join(src, "f.txt"), "probe\n");
  git(["add", "f.txt"], { cwd: src });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "probe"], { cwd: src });
  git(["config", "uploadpack.allowFilter", "true"], { cwd: src });
  const clone = join(box, "probe-clone");
  git(["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, clone], { cwd: box });
  assert.match(git(["rev-list", "--objects", "--missing=print", "HEAD"], { cwd: clone }), /^\?/m, "the probe's clone lacks its blob");
  const r = spawnSync("git", ["cat-file", "-e", "HEAD:f.txt"], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
  return r.status !== 0;
}

test("cli: in a partial clone the commit-msg hook fetches nothing where git reads GIT_NO_LAZY_FETCH: a change whose object is not here is said unread, the files that are here are still read", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pl-cli-partial-")));
  const src = join(box, "src");
  mkdirSync(src);
  git(["init", "-q", "-b", "main"], { cwd: src });
  writeFileSync(join(src, "a.txt"), "one\n");
  // Contents of their own: a blob fetched for one is no other's.
  writeFileSync(join(src, "x.txt"), "two\n");
  writeFileSync(join(src, "w.txt"), "four\n");
  // A committed config: the hook reads HEAD's version of it too.
  mkdirSync(join(src, ".ennyn"));
  writeFileSync(join(src, ".ennyn", "config.json"), JSON.stringify({ language: "en", commitMsg: { types: ["feat", "fix"] } }));
  git(["add", "-A"], { cwd: src });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: src });
  git(["config", "uploadpack.allowFilter", "true"], { cwd: src });
  // Each connection to the promisor remote leaves a line.
  const log = join(box, "connections.log");
  writeFileSync(join(box, "up.sh"), `#!/bin/sh\necho connect >> '${log}'\nexec git-upload-pack "$@"\n`);
  chmodSync(join(box, "up.sh"), 0o755);
  const clone = join(box, "clone");
  git(["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, clone], { cwd: box });
  git(["config", "remote.origin.uploadpack", join(box, "up.sh")], { cwd: clone });
  git(["reset", "-q"], { cwd: clone });
  // x.txt's HEAD blob is fetched now; a.txt's never is.
  git(["cat-file", "-p", "HEAD:x.txt"], { cwd: clone });
  mkdirSync(join(clone, ".ennyn"), { recursive: true });
  writeFileSync(join(clone, ".ennyn", "config.json"), JSON.stringify({ language: "en", review: { forbidden: [{ text: "BANNED", paths: ["*.txt"] }] } }));
  writeFileSync(join(clone, "a.txt"), `one\nconst a = "${TOKENS.github}";\nBANNED\n`);
  writeFileSync(join(clone, "x.txt"), `two\nconst x = "${TOKENS.github}";\nBANNED\n`);
  writeFileSync(join(clone, "c.txt"), `const c = "${TOKENS.npm}";\nBANNED\n`);
  git(["add", "a.txt", "x.txt", "c.txt", ".ennyn/config.json"], { cwd: clone });
  // d.txt: a new path staged with an object this clone does not hold.
  git(["update-index", "--add", "--cacheinfo", `100644,${git(["rev-parse", "HEAD:a.txt"], { cwd: clone })},d.txt`], { cwd: clone });
  // w.txt: a change to an object this clone does not hold either.
  git(["update-index", "--cacheinfo", `100644,${git(["rev-parse", "HEAD:a.txt"], { cwd: clone })},w.txt`], { cwd: clone });
  writeFileSync(join(clone, "MSG"), "feat: add a thing\n");
  writeFileSync(log, "");
  const r = run(clone, "commit-check", "--hook", "MSG");
  assert.equal(r.code, 1, `refused\n${r.stderr}`);
  // What is here is read whatever is missing beside it: the new file and the modified one whose objects are here.
  // a.txt's HEAD version is not here, its staged one is: the secret scan reads that whole, as a file the commit adds.
  const line = (/** @type {string} */ text, /** @type {string} */ mark) => text.split("\n").find((l) => l.includes(mark)) ?? "";
  const secrets = line(r.stderr, "adds what reads as a secret");
  const bans = line(r.stderr, 'adds "BANNED"');
  for (const at of ["c.txt:1 (npm-token", "x.txt:2 (github-token"]) assert.ok(secrets.includes(at), `${at}\n${r.stderr}`);
  for (const at of ["c.txt:2", "x.txt:3"]) assert.ok(bans.includes(at), `${at}\n${r.stderr}`);
  const fetches = !readsNoLazyFetch(box);
  const { version } = gitVersion({ cwd: box });
  if (version && versionAtLeast(version, [2, 45, 0])) assert.ok(!fetches, `git ${version} reads GIT_NO_LAZY_FETCH`);
  if (!fetches) {
    assert.equal(readFileSync(log, "utf8"), "", "no connection to the promisor remote");
    assert.ok(r.stderr.includes(`security.secrets was not checked in 2 staged path(s) ("d.txt", "w.txt"): ${MISSING_OBJECT}`), r.stderr);
    assert.ok(r.stderr.includes(`review.forbidden was not checked in 3 staged path(s) ("a.txt", "d.txt", "w.txt"): ${MISSING_OBJECT}`), r.stderr);
    assert.doesNotMatch(r.stderr, /did not show/);
    assert.ok(secrets.includes("a.txt:2 (github-token"), r.stderr);
    assert.ok(!bans.includes("a.txt"), "review.forbidden did not read a.txt");
    // Each reason on a line of its own, with its own paths: every cat-file read but the sizes fails here.
    const bin = join(box, "bin");
    mkdirSync(bin);
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --batch-check "*) ;; *" cat-file "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const failing = spawnSync(process.execPath, [CLI, "commit-check", "--hook", "MSG"], { cwd: clone, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    for (const want of [
      `security.secrets was not checked in 2 staged path(s) ("d.txt", "w.txt"): ${MISSING_OBJECT}`,
      'security.secrets was not checked in 1 staged path(s) ("c.txt"): git cat-file: fatal: injected',
      'security.secrets was not checked in 2 staged path(s) (".ennyn/config.json", "a.txt"): fatal: injected',
    ])
      assert.ok(failing.stderr.includes(want), `${want}\n${failing.stderr}`);
    // stagedAddedLines run by hand fails on it; given a map, it names it there.
    assert.throws(() => stagedAddedLines(clone, ["a.txt", "x.txt"]), new RegExp(MISSING_OBJECT.replace(/[()]/g, "\\$&")));
    const unread = new Map();
    assert.deepEqual([...stagedAddedLines(clone, ["a.txt", "x.txt"], { unread }).keys()], ["x.txt"]);
    assert.deepEqual([...unread], [["a.txt", MISSING_OBJECT]]);
    // With only changed files, one call could read them all: the missing one still stays out of it.
    git(["rm", "-q", "--cached", "c.txt", "d.txt"], { cwd: clone });
    git(["reset", "-q", "--", "w.txt"], { cwd: clone });
    writeFileSync(log, "");
    const changed = run(clone, "commit-check", "--hook", "MSG");
    assert.ok(line(changed.stderr, "adds what reads as a secret").includes("x.txt:2 (github-token"), changed.stderr);
    assert.equal(readFileSync(log, "utf8"), "", "no connection on the run with changed files only");
  } else {
    // A git that does not read GIT_NO_LAZY_FETCH (SECURITY.md names them) fetches the blobs, and they are read.
    assert.notEqual(readFileSync(log, "utf8"), "", "a git that does not read GIT_NO_LAZY_FETCH fetches the missing blob");
    assert.ok(secrets.includes("a.txt:2 (github-token"), r.stderr);
  }
});

test("cli: in a clone without trees the commit-msg hook's amend! lookup fetches nothing where git reads GIT_NO_LAZY_FETCH", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pl-cli-treeless-")));
  const src = join(box, "src");
  mkdirSync(src);
  git(["init", "-q", "-b", "main"], { cwd: src });
  const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  for (const [name, text] of [["a.txt", "one\n"], ["b.txt", "two\n"], ["c.txt", "three\n"]]) {
    writeFileSync(join(src, name), text);
    git(["add", name], { cwd: src });
    git([...ID, "commit", "-q", "-m", `feat: add ${name}`], { cwd: src });
  }
  git(["config", "uploadpack.allowFilter", "true"], { cwd: src });
  const log = join(box, "connections.log");
  writeFileSync(join(box, "up.sh"), `#!/bin/sh\necho connect >> '${log}'\nexec git-upload-pack "$@"\n`);
  chmodSync(join(box, "up.sh"), 0o755);
  const clone = join(box, "clone");
  // HEAD's trees come with the checkout; the older commits' do not.
  git(["clone", "-q", "--filter=tree:0", `file://${src}`, clone], { cwd: box });
  git(["config", "remote.origin.uploadpack", join(box, "up.sh")], { cwd: clone });
  mkdirSync(join(clone, ".ennyn"));
  writeFileSync(join(clone, ".ennyn", "config.json"), JSON.stringify({ language: "en" }));
  writeFileSync(join(clone, "a.txt"), "one\nmore\n");
  git(["add", "a.txt", ".ennyn/config.json"], { cwd: clone });
  // The target is the first commit: its paths come from its tree.
  writeFileSync(join(clone, "MSG"), "amend! feat: add a.txt\n\nfeat: add a.txt, and more\n");
  writeFileSync(log, "");
  const r = run(clone, "commit-check", "--hook", "MSG");
  const reads = readsNoLazyFetch(box);
  const { version } = gitVersion({ cwd: box });
  if (version && versionAtLeast(version, [2, 45, 0])) assert.ok(reads, `git ${version} reads GIT_NO_LAZY_FETCH`);
  if (reads) assert.equal(readFileSync(log, "utf8"), "", `no connection to the promisor remote\n${r.stderr}`);
  // A git that does not read GIT_NO_LAZY_FETCH (SECURITY.md names them) fetches the tree.
  else assert.notEqual(readFileSync(log, "utf8"), "", "a git that does not read GIT_NO_LAZY_FETCH fetches the tree");
});

/**
 * A repository whose commit holds a bare-looking folder `sub`, cloned for real: its config names its own folder as the
 * work tree and a file-system monitor in it, which any read of its index runs. No `.git` entry is involved, so a commit
 * carries all of it.
 * @returns {{ sub: string, ran: string }} the clone's folder, and the file the monitor makes
 */
function plantedFolder() {
  const origin = project({ language: "en" });
  const box = mkdtempSync(join(tmpdir(), "pl-cli-plant-"));
  const ran = join(box, "ran");
  const folder = join(origin.dir, "sub");
  mkdirSync(join(folder, "objects"), { recursive: true });
  mkdirSync(join(folder, "refs"));
  mkdirSync(join(folder, ".ennyn"));
  writeFileSync(join(folder, "objects", ".keep"), "");
  writeFileSync(join(folder, "refs", ".keep"), "");
  writeFileSync(join(folder, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(folder, ".ennyn", "config.json"), JSON.stringify({ language: "en" }));
  writeFileSync(join(folder, "mon.sh"), `#!/bin/sh\n: > ${JSON.stringify(ran)}\n`);
  chmodSync(join(folder, "mon.sh"), 0o755);
  writeFileSync(join(folder, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ./mon.sh\n");
  // git's own env, not core/git.mjs's: that one drops GIT_INDEX_FILE.
  assert.equal(spawnSync("git", ["read-tree", "--empty"], { cwd: origin.dir, env: { ...process.env, GIT_INDEX_FILE: join(folder, "index") } }).status, 0);
  origin.commit({}, "feat: a bare-looking folder");
  const clone = join(box, "clone");
  assert.equal(spawnSync("git", ["clone", "-q", origin.dir, clone]).status, 0);
  return { sub: join(clone, "sub"), ran };
}

test("cli: a bare-looking folder a clone brought in runs nothing its config names, and a command there stops on git's words", () => {
  const { sub, ran } = plantedFolder();
  // The control: plain git reads that folder as a repository and runs its monitor, so the commands below are asked of a live plant.
  assert.equal(spawnSync("git", ["ls-files"], { cwd: sub }).status, 0);
  assert.ok(existsSync(ran), "plain git runs the planted monitor");
  rmSync(ran);
  const { version } = gitVersion({ cwd: sub });
  const explicit = version !== null && versionAtLeast(version, [2, 38]);
  for (const args of [["audit"], ["budget"], ["init-scan", "--json"], ["impact", "--symbol", "x"], ["deps"], ["doctor"]]) {
    const r = run(sub, ...args);
    assert.ok(!existsSync(ran), `${args[0]} ran the planted monitor`);
    // Below 2.38 git ignores the setting, so only the monitor's guard stands there.
    if (explicit) assert.match(`${r.stderr}${r.stdout}`, /bare repository/, args[0]);
  }
});

test("cli: a linked worktree of a bare clone is read as any checkout, under the same guard", () => {
  const origin = project({ language: "en" });
  origin.commit({ "a.txt": "a\n" }, "feat: a");
  const box = mkdtempSync(join(tmpdir(), "pl-cli-bare-"));
  assert.equal(spawnSync("git", ["clone", "-q", "--bare", origin.dir, join(box, "repo.git")]).status, 0);
  assert.equal(spawnSync("git", ["worktree", "add", "-q", join(box, "wt"), "main"], { cwd: join(box, "repo.git") }).status, 0);
  const r = run(join(box, "wt"), "audit");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /security audit/);
});
