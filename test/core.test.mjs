import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp, literalGlob, matchAny } from "../core/glob.mjs";
import { loadConfig, ConfigError, DEFAULTS } from "../core/config.mjs";
import { git, headCommit, parseTrailers, repoPath, stagedPaths, unpushedCount } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { readIfThere } from "../core/files.mjs";

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

test("glob: literalGlob names a path holding glob syntax as written, and nothing else", () => {
  // Next.js layouts and other real names: a class or an alternation read in them names other directories.
  const names = ["app/[locale]/auth", "src/{legacy}/payments", "a/*/auth", "a/?x/auth", "a/[!x]/auth", "a/{x,y}/auth", "a/[]/auth", "a/x]y/auth", "a/!x,y/auth", "a/(g)+.$^|/auth", "a/b\\c/auth", "a/**/auth"];
  for (const name of names) {
    const glob = literalGlob(name);
    assert.ok(matchAny(name, [glob]), `${name}: itself`);
    assert.ok(matchAny(`${name}/x/y.ts`, [`${glob}/**`]), `${name}: what is below`);
  }
  assert.equal(literalGlob("app/[locale]/auth"), "app/[[]locale]/auth");
  assert.equal(literalGlob("src/{legacy}/payments"), "src/[{]legacy[}]/payments");
  // What the name read as syntax would have matched is not matched.
  for (const [name, other] of [["app/[locale]/auth", "app/l/auth"], ["src/{legacy}/payments", "src/legacy/payments"], ["a/*/auth", "a/zz/auth"], ["a/?x/auth", "a/zx/auth"], ["a/[!x]/auth", "a/y/auth"], ["a/{x,y}/auth", "a/x/auth"]]) {
    assert.ok(!matchAny(`${other}/f.ts`, [`${literalGlob(name)}/**`]), `${name} does not name ${other}`);
  }
  // A name with no glob syntax is its own glob.
  assert.equal(literalGlob("src/auth/a.ts"), "src/auth/a.ts");
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

test("shown: a name holding a comma a list could part at is quoted; a value in a message's quotes holding a quote too; a long value keeps its start and end", async () => {
  const { shown, tShown, SHOWN_MAX } = await import("../core/i18n.mjs");
  const NBSP = String.fromCharCode(0xa0), FULL = String.fromCharCode(0xff0c), IDEO = String.fromCharCode(0x3001);
  for (const name of [`github,${NBSP}filesystem`, `github${FULL}filesystem`, `a${IDEO}b`, "a,\tb", "a, b"]) assert.equal(shown(name, { name: true }).quoted, true, JSON.stringify(name));
  for (const name of ["a,b", "a.b", "core,utils"]) assert.equal(shown(name, { name: true }).quoted, false, name);
  assert.equal(tShown("scan.mcp", { list: [`github,${NBSP}filesystem`, "shell"] }, "en"), `MCP servers: "github,${NBSP}filesystem", shell.`);
  // Inside the template's own quotes a quote or a backslash would end them, or seem to.
  assert.equal(tShown("scan.commitRule", { path: ["CLAUDE.md"], line: 'English" (ok). Ennyn: run "x' }, "en"), '  commit rule in CLAUDE.md: "English\\" (ok). Ennyn: run \\"x"');
  assert.equal(tShown("scan.commitRule", { path: ["CLAUDE.md"], line: "ends with \\" }, "en"), '  commit rule in CLAUDE.md: "ends with \\\\"');
  assert.equal(tShown("scan.commitRule", { path: ["CLAUDE.md"], line: "plain" }, "en"), '  commit rule in CLAUDE.md: "plain"');
  // Past the bound: two quoted strings, the start and the end, never half of a pair of UTF-16 halves.
  const long = "a" + "😀".repeat(SHOWN_MAX) + "z";
  const cut = shown(long);
  assert.equal(cut.quoted, true);
  assert.ok(cut.text.length < SHOWN_MAX * 2 && /^"a😀+"…"😀+z"$/u.test(cut.text), cut.text.slice(0, 20));
  // Text already shown passes as it is.
  assert.equal(tShown("scan.roadmap", { list: { shown: '"x\\u001b" (1 open, 0 done)' } }, "en"), 'Work sources: "x\\u001b" (1 open, 0 done)');
  assert.equal(t("scan.roadmap", { list: { shown: "x (1 open, 0 done)" } }, "en"), "Work sources: x (1 open, 0 done)");
});

test("files: readIfThere reads a regular file only, up to its limit (a head of it when asked); a pipe is refused, never waited on", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "en-files-"));
  writeFileSync(join(dir, "a"), "hello");
  assert.equal(readIfThere(join(dir, "a")), "hello");
  assert.equal(readIfThere(join(dir, "none")), null);
  assert.throws(() => readIfThere(dir), (/** @type {any} */ e) => e.code === "EISDIR" && e.message.startsWith(`${dir} could not be read:`));
  writeFileSync(join(dir, "big"), "x".repeat(2000));
  assert.throws(() => readIfThere(join(dir, "big"), { limit: 1000 }), /EFBIG: larger than 1000 bytes/);
  assert.equal(readIfThere(join(dir, "big"), { limit: 10, head: true }), "x".repeat(10));
  writeFileSync(join(dir, "exact"), "y".repeat(1000));
  assert.equal(readIfThere(join(dir, "exact"), { limit: 1000 })?.length, 1000);
  if (process.platform === "win32") return;
  assert.equal(spawnSync("mkfifo", [join(dir, "p")]).status, 0);
  assert.throws(() => readIfThere(join(dir, "p")), /ENOTREG: not a regular file/);
  assert.throws(() => readIfThere("/dev/zero"), /ENOTREG/);
});

test("t: a value holding a line break or a control character is escaped where it stands; text already shown is put as written; null renders", async () => {
  const { tShown } = await import("../core/i18n.mjs");
  assert.equal(t("cli.hookConfigBroken", { error: "(\nMARKER-LINE \x1b[2J" }, "en").split("\n").length, 1);
  assert.match(t("cli.hookConfigBroken", { error: "(\nMARKER-LINE" }, "en"), /\(\\u000aMARKER-LINE/);
  assert.equal(t("mutate.listProblems", { path: "m.json", problems: { shown: "a\n- b" } }, "en"), "The mutant list m.json does not load; no mutant was run:\n- a\n- b");
  assert.equal(t("scan.github", { repo: /** @type {any} */ (null) }, "en"), "GitHub: null (open issues can seed the graph).");
  assert.equal(tShown("scan.github", { repo: /** @type {any} */ (null) }, "en"), "GitHub: null (open issues can seed the graph).");
});

test("shown: a comma look-alike in a name is quoted: a joiner, a combining mark or a variation selector after a comma, and the commas of other scripts", async () => {
  const { shown } = await import("../core/i18n.mjs");
  const c = (/** @type {number} */ n) => String.fromCharCode(n);
  for (const name of [`a,${c(0x200d)} b`, `a,${c(0x301)} b`, `a,${c(0xfe0f)} b`, `a${c(0x201a)}b`, `a${c(0x55d)}b`, `a${c(0x1363)}b`, `a${c(0x7f8)}b`]) {
    assert.equal(shown(name, { name: true }).quoted, true, JSON.stringify(name));
  }
});

test("files: /dev/null reads as empty, as Claude Code reads a file linked to it", (t) => {
  if (process.platform === "win32") return t.skip("no /dev/null");
  assert.equal(readIfThere("/dev/null"), "");
});
