import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { loadConfig } from "../core/config.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { allowMarkerReason, checkCommitShape } from "../checks/commit-shape.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ENNYN_CONFIG" && !k.startsWith("GIT_")));
const cfg = () => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-bp-")), env: {} });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-bypass-"));
  git(["init", "-q", "-b", "main"], { cwd: dir, env: ENV });
  let n = 0;
  return {
    dir,
    /** @param {string} message @param {string} day YYYY-MM-DD */
    commit(message, day) {
      writeFileSync(join(dir, "a.txt"), String(n++));
      const date = `${day}T12:00:00`;
      git(["add", "-A"], { cwd: dir, env: ENV });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--cleanup=verbatim", "-m", message], {
        cwd: dir,
        env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    },
  };
}

test("bypass: one parser for the marker reason, shared with commit-check", () => {
  const m = "[commit-shape-allow:";
  assert.equal(allowMarkerReason("feat: x", m), null);
  assert.equal(allowMarkerReason("feat: x [commit-shape-allow:  imported upstream ]", m), "imported upstream");
  assert.equal(allowMarkerReason("feat: x\n\n[commit-shape-allow: never closed", m), "");
  // commit-check accepts exactly when the shared parser finds a reason of 8+ characters.
  const c = cfg();
  assert.ok(checkCommitShape("x".repeat(200) + " [commit-shape-allow: imported upstream]", { config: c }).ok);
  assert.equal(checkCommitShape("x".repeat(200) + " [commit-shape-allow: short]", { config: c }).ok, false);
  // The limit is 8 characters: 7 fails, 8 passes.
  assert.equal(checkCommitShape("x".repeat(200) + " [commit-shape-allow: 7 chars]", { config: c }).ok, false);
  assert.ok(checkCommitShape("x".repeat(200) + " [commit-shape-allow: 8 chars!]", { config: c }).ok);
});

test("bypass: uses in subject or body are counted with their reason; the range is inclusive, by committer day", () => {
  const r = repo();
  r.commit("feat: plain", "2026-03-01");
  r.commit("feat: long [commit-shape-allow: imported from upstream]", "2026-03-02");
  r.commit("fix: y\n\nBody line.\n[commit-shape-allow: generated changelog]", "2026-03-03");
  r.commit("docs: z\n\n[commit-shape-allow: unclosed", "2026-03-04");
  r.commit("feat: later", "2026-03-05");
  const all = bypassUses({ cwd: r.dir, config: cfg() });
  assert.equal(all.commits, 5);
  assert.deepEqual(all.uses.map((u) => [u.subject, u.reason]), [
    ["docs: z", ""],
    ["fix: y", "generated changelog"],
    ["feat: long [commit-shape-allow: imported from upstream]", "imported from upstream"],
  ]);
  const mid = bypassUses({ cwd: r.dir, config: cfg(), since: "2026-03-02", until: "2026-03-03" });
  assert.deepEqual([mid.commits, mid.uses.length], [2, 2]);
  assert.deepEqual(bypassUses({ cwd: r.dir, config: cfg(), since: "2026-03-05" }), { commits: 1, uses: [] });
});

test("bypass: outside a repository it fails (unmeasured, not zero); an empty repository has no commits", () => {
  const outside = mkdtempSync(join(tmpdir(), "en-bypass-none-"));
  assert.throws(() => bypassUses({ cwd: outside, config: cfg() }));
  const empty = mkdtempSync(join(tmpdir(), "en-bypass-empty-"));
  git(["init", "-q"], { cwd: empty, env: ENV });
  assert.deepEqual(bypassUses({ cwd: empty, config: cfg() }), { commits: 0, uses: [] });
});

test("cli: bypass prints the count and each use; --json is the result; a bad date is a usage error", () => {
  const r = repo();
  r.commit("feat: plain", "2026-03-01");
  r.commit("feat: long [commit-shape-allow: imported from upstream]", "2026-03-02");
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, env: ENV, encoding: "utf8" });
  const text = run("bypass");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Commit-shape bypass: 1 of 2 commits used it\.$/m);
  assert.match(text.stdout, /· 2026-03-02 · feat: long .* · reason: imported from upstream$/m);
  assert.equal(JSON.parse(run("bypass", "--json").stdout).uses.length, 1);
  assert.match(run("bypass", "--since", "2026-03-02", "--until", "2026-03-02").stdout, /1 of 1 commits/);
  assert.equal(run("bypass", "--since", "March").status, 2);
});

test("bypass: counted as the hook decides — a revert of a bypass commit is not a use", () => {
  const r = repo();
  r.commit("feat: long [commit-shape-allow: imported from upstream]", "2026-03-02");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", "HEAD"], { cwd: r.dir, env: ENV });
  const res = bypassUses({ cwd: r.dir, config: cfg() });
  assert.equal(res.commits, 2);
  assert.deepEqual(res.uses.map((u) => u.subject), ["feat: long [commit-shape-allow: imported from upstream]"]);
});

test("bypass: --from counts only the commits after a revision; a bad revision fails instead of reading as none", () => {
  const r = repo();
  r.commit("feat: start", "2026-03-01");
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.commit("feat: a [commit-shape-allow: before the cycle? no, after]", "2026-03-01");
  r.commit("fix: b", "2026-03-01");
  const res = bypassUses({ cwd: r.dir, config: cfg(), from: start });
  assert.deepEqual([res.commits, res.uses.length], [2, 1]);
  assert.deepEqual(bypassUses({ cwd: r.dir, config: cfg(), from: "HEAD" }), { commits: 0, uses: [] });
  assert.throws(() => bypassUses({ cwd: r.dir, config: cfg(), from: "no-such-rev" }));
  // An empty revision (a lost cycle start) is an error, not the whole history.
  assert.throws(() => bypassUses({ cwd: r.dir, config: cfg(), from: "" }), /empty revision/);
  const cli = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, env: ENV, encoding: "utf8" });
  assert.equal(cli("bypass", "--from", "").status, 2);
  assert.equal(cli("bypass", "--from=").status, 2);
});

test("bypass: a control character in a message neither splits the commit nor hides its marker", () => {
  const r = repo();
  r.commit("fix: a\x01b\n\n[commit-shape-allow: hidden behind a separator]", "2026-03-01");
  r.commit("feat: c", "2026-03-01");
  const res = bypassUses({ cwd: r.dir, config: cfg() });
  assert.deepEqual([res.commits, res.uses.map((u) => u.reason)], [2, ["hidden behind a separator"]]);
});

test("cli: the printed date is the local day that --since / --until select", () => {
  const r = repo();
  const env = { ...ENV, TZ: "Europe/Istanbul" };
  writeFileSync(join(r.dir, "a.txt"), "x");
  git(["add", "-A"], { cwd: r.dir, env });
  const date = "2026-03-02T01:30:00+03:00";
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: x [commit-shape-allow: imported from upstream]"], {
    cwd: r.dir,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, env, encoding: "utf8" });
  const out = run("bypass", "--since", "2026-03-02", "--until", "2026-03-02");
  assert.match(out.stdout, /1 of 1 commits/);
  assert.match(out.stdout, /· 2026-03-02 ·/);
  assert.match(run("bypass", "--until", "2026-03-01").stdout, /no commits in the range/);
});
