import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const ENV = Object.fromEntries(
  // GIT_EDITOR too: inside a commit hook git sets it to ":" and the CLI would read -m mode.
  Object.entries(process.env).filter(([k]) => !["ENNYN_CONFIG", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_EDITOR"].includes(k)),
);

/** @param {string} cwd @param {string[]} args */
function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: "utf8" });
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
        env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
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
    spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: { ...ENV, ...extra }, encoding: "utf8" });
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
  const run = () => spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: ENV, encoding: "utf8" });
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
  const r = spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: ENV, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /terse/);
  // No "#" anywhere: git keeps "#", and nothing here is a comment either way.
  writeFileSync(msg, "s\n");
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", msg], { cwd: dir, env: ENV }).status, 0);
});
