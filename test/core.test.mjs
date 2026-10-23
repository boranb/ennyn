import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp, matchAny } from "../core/glob.mjs";
import { loadConfig, ConfigError, DEFAULTS } from "../core/config.mjs";
import { git, headCommit, parseTrailers, repoPath, stagedPaths, unpushedCount } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("glob: ** matches zero or more segments", () => {
  assert.ok(matchAny("src/lib/engine/x.ts", ["src/lib/engine/**"]));
  assert.ok(matchAny("src/lib/engine/a/b/x.ts", ["src/lib/engine/**/*.ts"]));
  assert.ok(matchAny("src/lib/engine/x.ts", ["src/lib/engine/**/*.ts"]));
  assert.ok(matchAny("x.test.ts", ["**/*.test.*"]));
  assert.ok(matchAny("a/b/x.test.ts", ["**/*.test.*"]));
  assert.ok(!matchAny("src/lib/engines/x.ts", ["src/lib/engine/**"]));
});

test("glob: * stays within one segment, ? is one character", () => {
  assert.ok(matchAny("src/a.ts", ["src/*.ts"]));
  assert.ok(!matchAny("src/a/b.ts", ["src/*.ts"]));
  assert.ok(matchAny("v1.md", ["v?.md"]));
  assert.ok(!matchAny("v10.md", ["v?.md"]));
});

test("glob: alternation, classes, escaping, leading ./", () => {
  assert.ok(matchAny("server/src/x.mjs", ["{src,server/src}/*.{ts,mjs}"]));
  assert.ok(matchAny("src/x.ts", ["{src,server/src}/*.{ts,mjs}"]));
  assert.ok(matchAny("a1.txt", ["a[0-9].txt"]));
  assert.ok(!matchAny("ab.txt", ["a[0-9].txt"]));
  assert.ok(matchAny("ab.txt", ["a[!0-9].txt"]));
  assert.ok(!matchAny("aXmd", ["a.md"]));
  assert.ok(matchAny("./docs/a.md", ["docs/*.md"]));
  assert.equal(globToRegExp("a/**").source, globToRegExp("a/**").source);
});

test("config: defaults when no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-"));
  const cfg = loadConfig({ cwd: dir, env: {} });
  assert.equal(cfg.language, "en");
  assert.equal(cfg.commitMsg.subjectMax, DEFAULTS.commitMsg.subjectMax);
  assert.equal(cfg.configPath, null);
});

test("config audit: a scale the project gives replaces the default one", () => {
  const c = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-scale-")), env: {}, override: { graph: { costScale: { S: 1, M: 3, L: 8 } } } });
  assert.deepEqual(c.graph.costScale, { S: 1, M: 3, L: 8 }, "no XL: 5 left from the default to outrank L");
  assert.deepEqual(c.graph.valueScale, DEFAULTS.graph.valueScale, "a scale not given stays the default");
  // Replaced, still checked.
  assert.throws(() => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-scale-")), env: {}, override: { graph: { valueScale: { high: "3", low: null } } } }), (e) => e instanceof ConfigError && /"graph\.valueScale\.high" must be number, got string/.test(e.message) && /"graph\.valueScale\.low" must be number, got null/.test(e.message));
});

test("config audit: a byte order mark before the JSON is no parse error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-bom-"));
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), '\uFEFF{ "language": "tr" }');
  assert.equal(loadConfig({ cwd: dir, env: {} }).language, "tr");
});

test("config: overrides merge, unknown keys and type mismatches all reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-"));
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(
    join(dir, ".ennyn/config.json"),
    JSON.stringify({ language: "tr", commitMsg: { subjectMax: 90, typo: 1 }, review: { maxRounds: "2" }, bogus: true }),
  );
  assert.throws(
    () => loadConfig({ cwd: dir, env: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 3);
      assert.ok(err.problems.some((p) => p.includes('"commitMsg.typo"')));
      assert.ok(err.problems.some((p) => p.includes('"bogus"')));
      assert.ok(err.problems.some((p) => p.includes('"review.maxRounds" must be number')));
      return true;
    },
  );
  writeFileSync(join(dir, ".ennyn/config.json"), JSON.stringify({ language: "tr", commitMsg: { subjectMax: 90 } }));
  const cfg = loadConfig({ cwd: dir, env: {} });
  assert.equal(cfg.language, "tr");
  assert.equal(cfg.commitMsg.subjectMax, 90);
  assert.equal(cfg.commitMsg.bodyMaxLines, DEFAULTS.commitMsg.bodyMaxLines);
});

test("config: open maps accept new keys, nullable fields accept their kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-"));
  const cfg = loadConfig({
    cwd: dir,
    env: {},
    override: { graph: { fields: { status: "durum" }, openGateValue: "yok" }, impact: { referenceCommand: "node x.mjs" } },
  });
  assert.equal(cfg.graph.fields.status, "durum");
  assert.equal(cfg.graph.fields.id, "id");
  assert.equal(cfg.graph.openGateValue, "yok");
  assert.throws(() => loadConfig({ cwd: dir, env: {}, override: { impact: { referenceCommand: 3 } } }), ConfigError);
  assert.throws(() => loadConfig({ cwd: dir, env: {}, override: { language: "de" } }), ConfigError);
});

test("config: commit language, types and fix type are checked together", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-commit-"));
  const load = (/** @type {Record<string, unknown>} */ commitMsg) => loadConfig({ cwd: dir, env: {}, override: { commitMsg } });
  const tr = load({ language: "tr", types: ["özellik", "düzeltme"], fixType: "düzeltme" });
  assert.deepEqual([tr.commitMsg.language, tr.commitMsg.fixType], ["tr", "düzeltme"]);
  assert.equal(load({}).commitMsg.language, null, "null follows the top-level language");
  /** @param {Record<string, unknown>} commitMsg @param {RegExp} re */
  const bad = (commitMsg, re) => assert.throws(() => load(commitMsg), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(commitMsg));
  bad({ language: "de" }, /"commitMsg\.language" must be "en", "tr" or null/);
  bad({ types: ["özellik", "faz 8"] }, /entries must be single words.*faz 8/);
  bad({ types: ["feat", "fix:"] }, /entries must be single words.*fix:/);
  // Turkish types with the default fix type: the repair type would never match a subject.
  bad({ types: ["özellik", "düzeltme"] }, /"commitMsg\.fixType" "fix" must be one of commitMsg\.types \(özellik, düzeltme\)/);
  bad({ fixType: "fix it" }, /"commitMsg\.fixType" must be a single word/);
  // review.agents names the reviewers the cycle uses; an empty or non-string entry is a typo.
  const dir2 = mkdtempSync(join(tmpdir(), "pl-cfg-rev-"));
  assert.deepEqual(loadConfig({ cwd: dir2, env: {}, override: { review: { agents: ["kod-gozden-gecirici"] } } }).review.agents, ["kod-gozden-gecirici"]);
  assert.throws(() => loadConfig({ cwd: dir2, env: {}, override: { review: { agents: [""] } } }), /"review\.agents" entries must be agent names/);
});

test("config: ENNYN_CONFIG points elsewhere; broken JSON is a ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-"));
  writeFileSync(join(dir, "alt.json"), JSON.stringify({ language: "tr" }));
  assert.equal(loadConfig({ cwd: dir, env: { ENNYN_CONFIG: "alt.json" } }).language, "tr");
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: "bad.json" } }), ConfigError);
  // A root that is not an object was a TypeError (null) or silently the defaults ([], 3).
  for (const root of ["null", "[]", "3"]) {
    writeFileSync(join(dir, "root.json"), root);
    assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: "root.json" } }), (e) => e instanceof ConfigError && /must hold a JSON object/.test(e.message), root);
  }
});

test("git: hook environment does not leak into helpers", () => {
  const a = mkdtempSync(join(tmpdir(), "pl-git-a-"));
  const b = mkdtempSync(join(tmpdir(), "pl-git-b-"));
  git(["init", "-q"], { cwd: a });
  git(["init", "-q"], { cwd: b });
  writeFileSync(join(a, "only-a.txt"), "x");
  git(["add", "only-a.txt"], { cwd: a });
  // A hook in repo b exports GIT_DIR / GIT_INDEX_FILE; the helper must still read repo a.
  const leaky = { ...process.env, GIT_DIR: join(b, ".git"), GIT_INDEX_FILE: join(b, ".git", "index") };
  assert.deepEqual(git(["diff", "--cached", "--name-only"], { cwd: a, env: leaky }).split("\n"), ["only-a.txt"]);
  assert.deepEqual(stagedPaths(a), ["only-a.txt"]);
});

test("git audit: headCommit is null with no commit or no repository, and throws for a branch git cannot read", () => {
  const outside = mkdtempSync(join(tmpdir(), "pl-head-out-"));
  assert.equal(headCommit(outside), null);
  assert.equal(repoPath("--show-toplevel", { cwd: outside }), null);
  const dir = mkdtempSync(join(tmpdir(), "pl-head-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  assert.equal(headCommit(dir), null, "no commit yet");
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
  assert.equal(headCommit(dir), git(["rev-parse", "HEAD"], { cwd: dir }));
  // Inside .git there is no work tree: no project directory, not "outside a repository".
  assert.throws(() => repoPath("--show-toplevel", { cwd: join(dir, ".git") }), /must be run in a work tree/);
  // rev-parse --verify -q exits 1 here as for a branch with no commit; it is no "no commits".
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "garbage\n");
  assert.throws(() => headCommit(dir), /appears to be broken/);
});

test("git: unpushedCount is null without upstream, counts commits with one", () => {
  const origin = mkdtempSync(join(tmpdir(), "pl-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  const work = mkdtempSync(join(tmpdir(), "pl-work-"));
  git(["init", "-q", "-b", "main"], { cwd: work });
  const commit = (n) => {
    writeFileSync(join(work, `f${n}.txt`), String(n));
    git(["add", "."], { cwd: work });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `c${n}`], { cwd: work });
  };
  commit(1);
  assert.equal(unpushedCount(work), null);
  git(["remote", "add", "origin", origin], { cwd: work });
  git(["push", "-q", "-u", "origin", "main"], { cwd: work });
  assert.equal(unpushedCount(work), 0);
  commit(2);
  commit(3);
  assert.equal(unpushedCount(work), 2);
});

test("git: parseTrailers reads only a trailer-only last paragraph", () => {
  const m = parseTrailers("subject\n\nbody line\n\nReview-Rounds: 2\nSigned-off-by: a <a@a>");
  assert.deepEqual(m.get("Review-Rounds"), ["2"]);
  assert.equal(parseTrailers("subject\n\nbody: not a trailer block\nplain line").size, 0);
  assert.equal(parseTrailers("subject only").size, 0);
});

test("i18n: every English key exists in every catalog, vars interpolate, fallback works", () => {
  const en = JSON.parse(readFileSync(join(here, "../i18n/en.json"), "utf8"));
  const tr = JSON.parse(readFileSync(join(here, "../i18n/tr.json"), "utf8"));
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  assert.match(t("shape.subjectTooLong", { len: 130, max: 120 }, "tr"), /130 karakter; sınır 120/);
  assert.throws(() => t("no.such.key"));
});

test("git: state dir under .git resolves through the common dir in a linked worktree", async () => {
  const { resolveStateDir, commonDir } = await import("../core/git.mjs");
  const repo = mkdtempSync(join(tmpdir(), "pl-sd-"));
  git(["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "a");
  git(["add", "."], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"], { cwd: repo });
  const wt = join(mkdtempSync(join(tmpdir(), "pl-sd-wt-")), "wt");
  git(["worktree", "add", "-q", wt], { cwd: repo });
  const fromWorktree = resolveStateDir(wt, ".git/ennyn");
  assert.equal(fromWorktree, join(commonDir(repo), "ennyn"));
  assert.ok(!fromWorktree.startsWith(join(wt, ".git") + "/"));
  assert.equal(resolveStateDir(repo, "state/x"), join(repo, "state/x"));
  assert.equal(resolveStateDir(repo, "/abs/dir"), "/abs/dir");
});

test("git: stagedPaths reads the index a hook was given, but only from the same repository", async () => {
  const { hookIndexFile } = await import("../core/git.mjs");
  const repo = mkdtempSync(join(tmpdir(), "pl-idx-"));
  git(["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "x");
  git(["add", "."], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "a");
  git(["add", "a.txt"], { cwd: repo });
  // `git commit -- b.txt` builds a temporary index from HEAD plus the named path and exports it to hooks.
  const tmpIndex = join(repo, ".git", "next-index-1.lock");
  writeFileSync(join(repo, "b.txt"), "b");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  execFileSync("git", ["read-tree", "HEAD"], { cwd: repo, env });
  execFileSync("git", ["add", "b.txt"], { cwd: repo, env });
  assert.deepEqual(stagedPaths(repo), ["a.txt"], "without the hook env: the main index");
  assert.deepEqual(stagedPaths(repo, { env: { GIT_INDEX_FILE: tmpIndex } }), ["b.txt"], "absolute temporary index");
  assert.deepEqual(stagedPaths(repo, { env: { GIT_INDEX_FILE: ".git/index" } }), ["a.txt"], "relative main index");
  const other = mkdtempSync(join(tmpdir(), "pl-idx-other-"));
  git(["init", "-q"], { cwd: other });
  assert.equal(hookIndexFile(repo, { GIT_INDEX_FILE: join(other, ".git", "index") }), null, "another repository's index is ignored");
  assert.deepEqual(stagedPaths(repo, { env: { GIT_INDEX_FILE: join(other, ".git", "index") } }), ["a.txt"]);
  // A linked worktree's index lives under the main git dir but belongs to the worktree.
  mkdirSync(join(repo, ".git", "worktrees", "w1"), { recursive: true });
  assert.equal(hookIndexFile(repo, { GIT_INDEX_FILE: join(repo, ".git", "worktrees", "w1", "index") }), null);
});

test("files: nothing there is false or null; there but not readable throws, on every Node the engines allow", async (t) => {
  const { present, readIfThere } = await import("../core/files.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-files-"));
  writeFileSync(join(dir, "f"), "x");
  assert.equal(present(join(dir, "f")), true);
  assert.equal(present(join(dir, "nope")), false);
  // A file where a directory of the path should be: Node 20.0's statSync throwIfNoEntry still throws ENOTDIR.
  assert.equal(present(join(dir, "f", "x")), false);
  assert.equal(readIfThere(join(dir, "f", "x")), null);
  assert.equal(readIfThere(join(dir, "nope")), null);
  assert.equal(readIfThere(join(dir, "f")), "x");
  assert.throws(() => readIfThere(dir), (/** @type {Error} */ e) => e.message.startsWith(`${dir} could not be read: EISDIR`), "a directory in a file's place is no missing file, and the path is named");
  // A link that leads back to itself, and a name no file system allows: nothing there.
  symlinkSync(join(dir, "loop"), join(dir, "loop"));
  assert.equal(present(join(dir, "loop")), false);
  assert.equal(present(join(dir, "n".repeat(5000))), false);
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "locked", "c"), "x");
  chmodSync(join(dir, "locked"), 0o000);
  try {
    assert.throws(() => present(join(dir, "locked", "c")), /EACCES/);
    assert.throws(() => readIfThere(join(dir, "locked", "c")), /EACCES/);
  } finally {
    chmodSync(join(dir, "locked"), 0o755);
  }
});

test("config: impact.referenceTimeout is whole seconds from 1 to 3600", () => {
  const at = (/** @type {unknown} */ v) => {
    const dir = mkdtempSync(join(tmpdir(), "en-reftimeout-"));
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ impact: { referenceTimeout: v } }));
    return () => loadConfig({ cwd: dir, env: {} });
  };
  for (const ok of [1, 120, 3600]) assert.equal(at(ok)().impact.referenceTimeout, ok);
  for (const bad of [0, 0.5, 3601, -5]) assert.throws(at(bad), ConfigError, String(bad));
});
