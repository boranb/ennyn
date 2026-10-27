import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  assert.match(inside.stderr, /must be run in a work tree/);
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
  assert.match(guess.stderr, /^! work graph: G1 has value "hgih", which graph\.valueScale does not know; it is scored as 1$/m);
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

test("cli: push-check says unmeasured without upstream, warns above the threshold, always exits 0", () => {
  const p = project({ push: { warnAtUnpushed: 1 } });
  p.commit({ "a.txt": "1" }, "c1");
  const none = run(p.dir, "push-check");
  assert.equal(none.code, 0);
  assert.match(none.stdout, /could not be measured \(no upstream branch\)/);

  const origin = mkdtempSync(join(tmpdir(), "pl-cli-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git(["remote", "add", "origin", origin], { cwd: p.dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: p.dir });
  p.commit({ "a.txt": "2" }, "c2");
  const under = run(p.dir, "push-check");
  assert.equal(under.code, 0);
  assert.match(under.stdout, /^1 commits are waiting to be pushed \(threshold 1\)\.$/m);
  p.commit({ "a.txt": "3" }, "c3");
  const over = run(p.dir, "push-check");
  assert.equal(over.code, 0);
  assert.match(over.stdout, /2 commits are waiting to be pushed \(threshold 1\)\. Ask for push approval/);
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
  assert.equal(sub.code, 0);
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
  git(["add", "README.md"], { cwd: p.dir });
  const msg = join(p.dir, ".git", "MSG");
  writeFileSync(msg, "feat: readme\n");
  const r = run(p.dir, "commit-check", msg);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^Warning: README\.md changed, but not README\.tr\.md\. /m);
  writeFileSync(join(p.dir, "README.tr.md"), "# x\n");
  git(["add", "README.tr.md"], { cwd: p.dir });
  assert.equal(run(p.dir, "commit-check", msg).stderr, "");
});

test("cli: in a partial clone the commit-msg hook fetches nothing from git 2.44 on: a change whose object is not here is said unread, the files that are here are still read", () => {
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
  const { version } = gitVersion({ cwd: box });
  const fetches = !(version && versionAtLeast(version, [2, 44, 0]));
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
    // Older git ignores GIT_NO_LAZY_FETCH (SECURITY.md says so): the blobs are fetched and read.
    assert.notEqual(readFileSync(log, "utf8"), "", "older git fetches the missing blob");
    assert.ok(secrets.includes("a.txt:2 (github-token"), r.stderr);
  }
});

test("cli: in a clone without trees the commit-msg hook's amend! lookup fetches nothing from git 2.44 on", () => {
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
  const { version } = gitVersion({ cwd: box });
  if (version && versionAtLeast(version, [2, 44, 0])) assert.equal(readFileSync(log, "utf8"), "", `no connection to the promisor remote\n${r.stderr}`);
  // Older git ignores GIT_NO_LAZY_FETCH (SECURITY.md says so) and fetches the tree.
  else assert.notEqual(readFileSync(log, "utf8"), "", "older git fetches the tree");
});
