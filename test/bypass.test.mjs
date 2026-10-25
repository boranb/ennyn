import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "../core/git.mjs";
import { loadConfig } from "../core/config.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { allowMarkerReason, checkCommitShape } from "../checks/commit-shape.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const cfg = () => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-bp-")), env: {} });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-bypass-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  let n = 0;
  return {
    dir,
    /** @param {string} message @param {string} day YYYY-MM-DD */
    commit(message, day) {
      writeFileSync(join(dir, "a.txt"), String(n++));
      const date = `${day}T12:00:00`;
      git(["add", "-A"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--cleanup=verbatim", "-m", message], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
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
  assert.deepEqual(bypassUses({ cwd: r.dir, config: cfg(), since: "2026-03-05" }), { commits: 1, uses: [], shallow: false });
});

test("bypass: outside a repository it fails (unmeasured, not zero); an empty repository has no commits", () => {
  const outside = mkdtempSync(join(tmpdir(), "en-bypass-none-"));
  assert.throws(() => bypassUses({ cwd: outside, config: cfg() }));
  const empty = mkdtempSync(join(tmpdir(), "en-bypass-empty-"));
  git(["init", "-q"], { cwd: empty });
  assert.deepEqual(bypassUses({ cwd: empty, config: cfg() }), { commits: 0, uses: [], shallow: false });
});

test("cli: bypass prints the count and each use; --json is the result; a bad date is a usage error", () => {
  const r = repo();
  r.commit("feat: plain", "2026-03-01");
  r.commit("feat: long [commit-shape-allow: imported from upstream]", "2026-03-02");
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, encoding: "utf8" });
  const text = run("bypass");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Commit-shape bypass: 1 of 2 commits used it\.$/m);
  assert.match(text.stdout, /· 2026-03-02 · feat: long .* · reason: imported from upstream$/m);
  assert.equal(JSON.parse(run("bypass", "--json").stdout).uses.length, 1);
  assert.match(run("bypass", "--since", "2026-03-02", "--until", "2026-03-02").stdout, /1 of 1 commits/);
  assert.equal(run("bypass", "--since", "March").status, 2);
});

test("cli: bypass shows a subject and a reason from history as one line can show them (a terminal escape in them is escaped)", () => {
  const r = repo();
  r.commit("feat: long \x1b]0;title\x07 [commit-shape-allow: imported \x1b[2J upstream]", "2026-03-02");
  const text = spawnSync(process.execPath, [CLI, "bypass"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(!text.stdout.includes("\x1b"), "no escape reaches the terminal");
  assert.match(text.stdout, /· "feat: long \\u001b\]0;title\\u0007 .*" · reason: "imported \\u001b\[2J upstream"$/m);
});

test("bypass: counted as the hook decides — a revert of a bypass commit is not a use", () => {
  const r = repo();
  r.commit("feat: long [commit-shape-allow: imported from upstream]", "2026-03-02");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", "HEAD"], { cwd: r.dir });
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
  assert.deepEqual(bypassUses({ cwd: r.dir, config: cfg(), from: "HEAD" }), { commits: 0, uses: [], shallow: false });
  assert.throws(() => bypassUses({ cwd: r.dir, config: cfg(), from: "no-such-rev" }));
  // An empty revision (a lost cycle start) is an error, not the whole history.
  assert.throws(() => bypassUses({ cwd: r.dir, config: cfg(), from: "" }), /empty revision/);
  const cli = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, encoding: "utf8" });
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
  const env = { ...process.env, TZ: "Europe/Istanbul" };
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

test("bypass audit: a --from that history no longer holds (an amended or rebased cycle start) fails instead of counting older commits", () => {
  const r = repo();
  r.commit("feat: before the cycle", "2026-03-01");
  r.commit("feat: the cycle starts here", "2026-03-02");
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  // The start commit is rewritten: from..HEAD would now reach back to the merge base and count it.
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "-m", "feat: the cycle start, reworded [commit-shape-allow: rewritten before the cycle]"], { cwd: r.dir });
  r.commit("feat: in the cycle", "2026-03-03");
  assert.throws(() => bypassUses({ cwd: r.dir, config: cfg(), from: start }), /not an ancestor of HEAD/);
  const cli = spawnSync(process.execPath, [CLI, "bypass", "--from", start], { cwd: r.dir, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /not an ancestor of HEAD/);
  // A start that is still an ancestor counts as before.
  assert.deepEqual(bypassUses({ cwd: r.dir, config: cfg(), from: "HEAD~1" }).commits, 1);
});

test("bypass audit: a shallow clone says the count stops at its boundary; a --from past the boundary is named, not a bare git error", () => {
  const r = repo();
  for (const [i, m] of ["feat: a", "feat: b [commit-shape-allow: imported from upstream]", "feat: c", "feat: d"].entries()) r.commit(m, `2026-03-0${i + 1}`);
  const first = git(["rev-list", "--max-parents=0", "HEAD"], { cwd: r.dir });
  const shallow = mkdtempSync(join(tmpdir(), "en-bypass-shallow-"));
  git(["clone", "-q", "--depth", "2", pathToFileURL(r.dir).href, shallow], { cwd: tmpdir() });
  const res = bypassUses({ cwd: shallow, config: cfg() });
  assert.deepEqual([res.commits, res.uses.length, res.shallow], [2, 0, true]);
  assert.equal(bypassUses({ cwd: r.dir, config: cfg() }).shallow, false);
  // From a commit inside the clone the range is whole.
  assert.equal(bypassUses({ cwd: shallow, config: cfg(), from: "HEAD~1" }).shallow, false);
  assert.throws(() => bypassUses({ cwd: shallow, config: cfg(), from: first }), /not in this repository; the clone is shallow/);
  const text = spawnSync(process.execPath, [CLI, "bypass"], { cwd: shallow, encoding: "utf8" }).stdout;
  assert.match(text, /^This clone is shallow: commits before its boundary are not counted\.$/m);
});

test("bypass audit: a commit at the first or the last second of the range counts (local days, both ends)", () => {
  const r = repo();
  const at = (/** @type {string} */ message, /** @type {string} */ date) => {
    writeFileSync(join(r.dir, "a.txt"), date);
    git(["add", "-A"], { cwd: r.dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: r.dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  at("feat: before [commit-shape-allow: one second too early]", "2026-03-01T23:59:59");
  at("feat: first [commit-shape-allow: the first second of the day]", "2026-03-02T00:00:00");
  at("feat: last [commit-shape-allow: the last second of the day]", "2026-03-03T23:59:59");
  at("feat: after [commit-shape-allow: one second too late]", "2026-03-04T00:00:00");
  const res = bypassUses({ cwd: r.dir, config: cfg(), since: "2026-03-02", until: "2026-03-03" });
  assert.deepEqual([res.commits, res.uses.map((u) => u.subject.split(" [")[0])], [2, ["feat: last", "feat: first"]]);
});

/** A commit on whatever is checked out, with its own file, at a committer date. */
function commitAt(/** @type {string} */ dir, /** @type {string} */ message, /** @type {string} */ date, /** @type {string[]} */ extra = []) {
  writeFileSync(join(dir, `f-${Math.random().toString(36).slice(2)}.txt`), message);
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...extra, "-m", message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

test("bypass audit: a shallow clone with --from says so when a merge in the range reaches past the boundary", () => {
  const r = repo();
  commitAt(r.dir, "feat: a", "2026-03-01T12:00:00");
  commitAt(r.dir, "feat: b", "2026-03-02T12:00:00");
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  for (const n of [1, 2, 3]) commitAt(r.dir, `feat: s${n} [commit-shape-allow: side work ${n} imported]`, `2026-03-0${2 + n}T12:00:00`);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  commitAt(r.dir, "feat: c, the cycle starts here", "2026-03-06T12:00:00");
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side"], { cwd: r.dir });
  commitAt(r.dir, "feat: e", "2026-03-07T12:00:00");
  const full = bypassUses({ cwd: r.dir, config: cfg(), from: start });
  assert.deepEqual([full.commits, full.uses.length, full.shallow], [4, 3, false]);
  const clone = mkdtempSync(join(tmpdir(), "en-bypass-shallow-from-"));
  git(["clone", "-q", "--depth", "3", pathToFileURL(r.dir).href, clone], { cwd: tmpdir() });
  const cut = bypassUses({ cwd: clone, config: cfg(), from: start });
  assert.equal(cut.shallow, true, `${cut.commits} commits seen of 4`);
  // A range that stays inside the clone is whole.
  assert.equal(bypassUses({ cwd: clone, config: cfg(), from: "HEAD~1" }).shallow, false);
});

test("bypass audit: a commit dated days early does not hide the newer ones behind it from --since", () => {
  const r = repo();
  commitAt(r.dir, "feat: before", "2026-03-01T12:00:00");
  commitAt(r.dir, "feat: one [commit-shape-allow: in the range, first]", "2026-03-10T12:00:00");
  // A clock nine days behind.
  commitAt(r.dir, "feat: skewed", "2026-03-01T13:00:00");
  commitAt(r.dir, "feat: two [commit-shape-allow: in the range, second]", "2026-03-11T12:00:00");
  const res = bypassUses({ cwd: r.dir, config: cfg(), since: "2026-03-09" });
  assert.deepEqual([res.commits, res.uses.map((u) => u.subject.split(" [")[0])], [2, ["feat: two", "feat: one"]]);
});

test("bypass audit: a merge with a subject of its own is checked by the hook, so it counts; one git named does not", () => {
  const r = repo();
  commitAt(r.dir, "feat: base", "2026-03-01T12:00:00");
  for (const [branch, subject] of [["x", "feat: merge x [commit-shape-allow: upstream merge kept whole]"], ["y", "Merge branch 'y' [commit-shape-allow: git's own name]"]]) {
    git(["checkout", "-q", "-b", branch, "main"], { cwd: r.dir });
    commitAt(r.dir, `feat: on ${branch}`, "2026-03-02T12:00:00");
    git(["checkout", "-q", "main"], { cwd: r.dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", subject, branch], { cwd: r.dir, env: { ...process.env, GIT_COMMITTER_DATE: "2026-03-03T12:00:00" } });
  }
  const res = bypassUses({ cwd: r.dir, config: cfg() });
  // base, on x, on y, and the merge of x; the merge git named is skipped as the hook skips it.
  assert.deepEqual([res.commits, res.uses.map((u) => u.reason)], [4, ["upstream merge kept whole"]]);
});

test("bypass audit: an amend! uses the marker only in its own body, not in the target's subject it repeats", () => {
  const r = repo();
  commitAt(r.dir, "feat: x [commit-shape-allow: imported from upstream]", "2026-03-01T12:00:00");
  commitAt(r.dir, "amend! feat: x [commit-shape-allow: imported from upstream]\n\nfeat: x, reworded", "2026-03-02T12:00:00");
  commitAt(r.dir, "squash! feat: x [commit-shape-allow: imported from upstream]\n\nRoot cause: z", "2026-03-03T12:00:00");
  commitAt(r.dir, "amend! feat: x [commit-shape-allow: imported from upstream]\n\nfeat: x, again [commit-shape-allow: the reworded one is long too]", "2026-03-04T12:00:00");
  const res = bypassUses({ cwd: r.dir, config: cfg() });
  // The squash! is checked with its target, marker and all, and keeps the subject: a use, as the hook lets it through.
  assert.deepEqual([res.commits, res.uses.map((u) => u.subject.split(" ")[0] + " " + u.reason)], [4, ["amend! the reworded one is long too", "squash! imported from upstream", "feat: imported from upstream"]]);
});

test("bypass audit: a commit with no readable committer time is in neither the count nor the list", () => {
  const r = repo();
  commitAt(r.dir, "feat: dated", "2026-03-01T12:00:00");
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: r.dir });
  const parent = git(["rev-parse", "HEAD"], { cwd: r.dir });
  const object = join(r.dir, "..", `${r.dir.split(/[\\/]/).pop()}-object`);
  writeFileSync(object, `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1772366400 +0000\ncommitter t <t@t>\n\nfeat: no date [commit-shape-allow: a hand-made object]\n`);
  git(["update-ref", "HEAD", git(["hash-object", "-t", "commit", "-w", "--literally", object], { cwd: r.dir })], { cwd: r.dir });
  // With no dates the range is the graph's: it is there, as rev-list has it. A dated range cannot place it.
  const all = bypassUses({ cwd: r.dir, config: cfg() });
  assert.deepEqual([all.commits, all.uses.map((u) => u.reason)], [2, ["a hand-made object"]]);
  assert.match(spawnSync(process.execPath, [CLI, "bypass"], { cwd: r.dir, encoding: "utf8" }).stdout, / · — · feat: no date /);
  const dated = bypassUses({ cwd: r.dir, config: cfg(), since: "2026-01-01" });
  assert.deepEqual([dated.commits, dated.uses.length], [1, 0]);
});

test("bypass audit: a merge is judged by its first line, as the hook judges it", () => {
  const r = repo();
  commitAt(r.dir, "feat: base", "2026-03-01T12:00:00");
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  commitAt(r.dir, "feat: side", "2026-03-02T12:00:00");
  git(["checkout", "-q", "main"], { cwd: r.dir });
  // %s would join the paragraph into "Merge branch side ...", a subject the hook skips; its first line is "Merge".
  git(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "Merge\nbranch side [commit-shape-allow: kept as it came]", "side"], { cwd: r.dir });
  const res = bypassUses({ cwd: r.dir, config: cfg() });
  assert.deepEqual([res.commits, res.uses.map((u) => u.reason)], [3, ["kept as it came"]]);
});
