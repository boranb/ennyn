import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitMaybe } from "../core/git.mjs";

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
