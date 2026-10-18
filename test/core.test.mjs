import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp, matchAny } from "../core/glob.mjs";
import { loadConfig, ConfigError, DEFAULTS } from "../core/config.mjs";
import { git, parseTrailers, stagedPaths, unpushedCount } from "../core/git.mjs";
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

test("config: ENNYN_CONFIG points elsewhere; broken JSON is a ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-"));
  writeFileSync(join(dir, "alt.json"), JSON.stringify({ language: "tr" }));
  assert.equal(loadConfig({ cwd: dir, env: { ENNYN_CONFIG: "alt.json" } }).language, "tr");
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: "bad.json" } }), ConfigError);
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
