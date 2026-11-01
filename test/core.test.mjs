import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, linkSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { globToRegExp, literalGlob, matchAny } from "../core/glob.mjs";
import { loadConfig, ConfigError, DEFAULTS } from "../core/config.mjs";
import { DIFF_GROUP, MISSING_OBJECT, batchCheck, diffGroups, git, headCommit, parseTrailers, repoPath, stagedAddedLines, stagedBlobs, stagedPaths, stagedVersions, unpushedCount } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import * as filesModule from "../core/files.mjs";
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

test("config: metrics.reworkDays is type-checked when it loads; its range is the rework command's, so a typo stops no commit gate", () => {
  const load = (/** @type {unknown} */ reworkDays) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-days-")), env: {}, override: { metrics: { reworkDays } } }).metrics.reworkDays;
  for (const value of [-1, Infinity, 3.5, 2 ** 53]) assert.equal(load(value), value);
  for (const value of ["7", null]) assert.throws(() => load(value), (e) => e instanceof ConfigError && /"metrics\.reworkDays" must be number/.test(e.message), String(value));
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

test("config: every path a config names stays in the project, whoever names the config", () => {
  // As POSIX and Windows read them: the inside ones resolve below the project directory on both.
  const inside = ["", ".", "HANDOFF.md", ".ennyn/metrics.jsonl", "./x", "a/../b", "a/b/..", ".git/../x", "~/x", "..x", "x..", "...", "a\\b", "file:///etc/x", "a/.../b"];
  const outside = ["..", "../x", "../../x", "a/../../x", ".git/../../x", ".git/ennyn/../../../x", "./../x", "/", "/abs/x", "//host/x", "\\\\host\\share\\x", "\\x", "C:\\x", "C:x", "c:/x", "..\\x", "a\\..\\..\\x", "a/..\\..\\x"];
  // The reference: Node's own reading on each system, the project on another drive than C: on Windows.
  const out = (/** @type {string} */ v) => {
    const p = posix.relative("/proj", posix.resolve("/proj", v));
    const w = win32.relative("D:\\proj", win32.resolve("D:\\proj", v));
    return p.split("/")[0] === ".." || posix.isAbsolute(p) || w.split("\\")[0] === ".." || win32.isAbsolute(w);
  };
  assert.deepEqual([inside.filter(out), outside.filter((v) => !out(v))], [[], []]);
  const dir = mkdtempSync(join(tmpdir(), "pl-cfg-in-"));
  mkdirSync(join(dir, ".ennyn"));
  const own = (/** @type {object} */ cfg) => {
    writeFileSync(join(dir, ".ennyn/config.json"), JSON.stringify(cfg));
    return () => loadConfig({ cwd: dir, env: {} });
  };
  const refused = (/** @type {string} */ key, /** @type {string} */ value) => (/** @type {unknown} */ e) =>
    e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `"${key}": ${JSON.stringify(value)} leads outside the project directory; every path a config names stays inside it`;
  // The metrics log has a rule of its own (below): a .jsonl file in .ennyn/.
  for (const key of ["handoff", "changelog", "graph"]) {
    // The metrics log elsewhere: a key naming its file is refused (below).
    for (const p of inside) assert.equal(/** @type {any} */ (own({ paths: { [key]: p, metricsLog: ".ennyn/other.jsonl" } })()).paths[key], p, `${key} ${JSON.stringify(p)}`);
  }
  for (const key of ["handoff", "changelog", "graph", "metricsLog", "findings", "stateDir"]) {
    for (const p of outside) assert.throws(own({ paths: { [key]: p } }), refused(`paths.${key}`, p), `${key} ${JSON.stringify(p)}`);
  }
  // The state dir lies in the git dir, however spelled: state a commit can write is never trusted
  // (journal-names-git-config, a work-tree journal naming .git/config).
  for (const p of [".git", ".git/ennyn", "./.git/ennyn", ".git\\ennyn", ".git/a/../b"]) assert.equal(own({ paths: { stateDir: p } })().paths.stateDir, p, p);
  for (const p of ["state", ".", "", "src/..", ".git/..", ".git/../state", ".gitx/a", "a/.git", "~/x"]) {
    assert.throws(own({ paths: { stateDir: p } }), (e) => e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `"paths.stateDir": ${JSON.stringify(p)} must lie under .git/: a commit can write the work tree, and Ennyn trusts its state`, JSON.stringify(p));
  }
  for (const p of outside) assert.throws(own({ impact: { ceilingRegistry: p } }), refused("impact.ceilingRegistry", p), JSON.stringify(p));
  assert.equal(own({ impact: { ceilingRegistry: "ceilings.json" } })().impact.ceilingRegistry, "ceilings.json");
  // impact.twins: each directory of a pair is looked up below the project (a presence probe).
  for (const p of outside) assert.throws(own({ impact: { twins: [["src", p]] } }), refused("impact.twins[0][1]", p), JSON.stringify(p));
  assert.deepEqual(own({ impact: { twins: [["src/lib/engine", "server/lib"]] } })().impact.twins, [["src/lib/engine", "server/lib"]]);
  // Every spelling up to four characters from the ones that matter, against the reference.
  own({});
  let spellings = [""];
  for (let n = 0; n < 4; n++) spellings = [...new Set([...spellings, ...spellings.flatMap((s) => [".", "/", "\\", "a", "C", ":"].map((c) => s + c))])];
  const differ = spellings.filter((v) => {
    try {
      loadConfig({ cwd: dir, env: {}, override: { paths: { graph: v } } });
      return out(v);
    } catch {
      return !out(v);
    }
  });
  assert.deepEqual([spellings.length, differ], [1555, []]);
  // A NUL names no file on any system.
  assert.throws(own({ paths: { graph: "a\u0000b" } }), (e) => e instanceof ConfigError && /"paths\.graph": "a\\u0000b" holds a NUL/.test(e.message));
  // Every key that leads out is named, not only the first.
  assert.throws(own({ paths: { metricsLog: "../m", stateDir: "/s" } }), (e) => e instanceof ConfigError && e.problems.length === 2);

  // A config ENNYN_CONFIG names is held to the same: outside the project, in it under another spelling (a case,
  // a hard link, a parent's path), through a link into it, or the project's own config linked out.
  const box = mkdtempSync(join(tmpdir(), "pl-cfg-out-"));
  writeFileSync(join(box, "machine.json"), JSON.stringify({ paths: { metricsLog: join(box, "m.jsonl") } }));
  assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: join(box, "machine.json") } }), refused("paths.metricsLog", join(box, "m.jsonl")));
  writeFileSync(join(dir, "alt.json"), JSON.stringify({ paths: { metricsLog: "../m" } }));
  symlinkSync(join(dir, "alt.json"), join(box, "link.json"));
  linkSync(join(dir, "alt.json"), join(box, "hard.json"));
  for (const named of ["alt.json", join(dir, "alt.json"), join(dir, "sub/../alt.json"), join(dir, "ALT.json"), join(box, "link.json"), join(box, "hard.json"), `../${basename(dir)}/alt.json`]) {
    // ALT.json reads only where the disk folds case.
    if (named.endsWith("ALT.json") && !existsSync(named)) continue;
    assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: named } }), refused("paths.metricsLog", "../m"), named);
  }
  writeFileSync(join(box, "linked.json"), JSON.stringify({ paths: { metricsLog: "../m" } }));
  symlinkSync(join(box, "linked.json"), join(dir, ".ennyn/config.json.link"));
  assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: ".ennyn/config.json.link" } }), refused("paths.metricsLog", "../m"));
  // The project's own config linked to a file outside (config-file-link): not read, its bytes in no message.
  writeFileSync(join(box, "secret"), "SECRET-TOKEN-BYTES");
  const linkedOwn = mkdtempSync(join(tmpdir(), "pl-cfg-link-"));
  mkdirSync(join(linkedOwn, ".ennyn"));
  symlinkSync(join(box, "secret"), join(linkedOwn, ".ennyn/config.json"));
  assert.throws(() => loadConfig({ cwd: linkedOwn, env: {} }), (e) => /config\.json could not be read: \.ennyn\/config\.json is a symbolic link$/.test(/** @type {Error} */ (e).message) && !/SECRET/.test(/** @type {Error} */ (e).message));
  // Only the state dir lies in a git dir, however spelled, whoever names the config: a metrics log named
  // .git/config or .git/hooks/commit-msg would be written into git's own files (cycle 12, budget audit review).
  const inGit = (/** @type {string} */ key, /** @type {string} */ value) => (/** @type {unknown} */ e) =>
    e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `"${key}": ${JSON.stringify(value)} lies in a git dir, where git reads and runs what it finds (its config, its hooks); only paths.stateDir may`;
  // As git refuses its own paths: the code points HFS+ ignores in a name, NTFS streams and short names.
  const gitDir = [".git/config", ".git/hooks/commit-msg", "./.git/ennyn/metrics.jsonl", ".git", "x/../.git/config", ".GIT/config", ".git./config", ".git /config", "GIT~1/config", "vendor/lib/.git/config", ".git\\config",
    ".g\u200cit/config", "\ufeff.git/config", ".g\u202eit/config", ".git\u206f/config", ".git::$INDEX_ALLOCATION/config", ".git:x", "GIT~2/config", "GI7EBA~1/config"];
  for (const key of ["handoff", "changelog", "graph", "metricsLog"]) {
    for (const p of gitDir) assert.throws(own({ paths: { [key]: p } }), inGit(`paths.${key}`, p), `${key} ${JSON.stringify(p)}`);
    if (key === "metricsLog") continue;
    for (const p of [".github/x.json", ".gitx/x.json", "a/.git/../b.json", ".gitignore.d/x", "git/x.json", "gitdata/x.json", ".git\t/x.json", "gi~1/x.json"]) assert.equal(/** @type {any} */ (own({ paths: { [key]: p } })()).paths[key], p, `${key} ${JSON.stringify(p)}`);
  }
  assert.throws(own({ impact: { ceilingRegistry: ".git/info/exclude" } }), inGit("impact.ceilingRegistry", ".git/info/exclude"));
  // The metrics log is a .jsonl file in the project, as POSIX and Windows read the path, once . and .. are applied: a
  // record appended to any other file could break it (a package.json, .claude/settings.json, the config itself: a
  // config that no longer loads turns the commit-msg hook off). Appended to another tool's .jsonl, a record leaves it
  // JSON lines. Cycle 14, security audit review rounds 1 and 2.
  const notOwn = (/** @type {string} */ value) => (/** @type {unknown} */ e) =>
    e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `"paths.metricsLog": ${JSON.stringify(value)} must name a .jsonl file in the project: a record appended to any other file could break it`;
  for (const p of [".ennyn/metrics.jsonl", "./.ennyn/metrics.jsonl", ".ennyn/logs/m.jsonl", ".ennyn//m.jsonl", ".ennyn/./m.jsonl", "src/../.ennyn/m.jsonl", ".ennyn/m.x.jsonl", ".ennyn/a\\b.jsonl", "docs/metrics/cycles.jsonl", "metrics.jsonl", ".ennyn.jsonl", ".Ennyn/m.jsonl", "x/.ennyn/m.jsonl", ".ennyn\\m.jsonl", ".ennyn/..\\m.jsonl", "a/b.jsonl"]) {
    assert.equal(/** @type {any} */ (own({ paths: { metricsLog: p } })()).paths.metricsLog, p, JSON.stringify(p));
  }
  for (const p of ["", ".", ".ennyn", ".ennyn/", ".ennyn/config.json", ".ennyn/metrics.json", "metrics.ndjson", "docs/metrics", ".ennyn/.jsonl", ".jsonl", ".ennyn/m.JSONL", ".ennyn/m.jsonl/", "package.json", ".claude/settings.json", ".ennyn/m.jsonl ", ".ennyn/m.jsonl‌", ".ennyn/․jsonl", "a\\.jsonl", "m.jsonl/x\\.."]) {
    assert.throws(own({ paths: { metricsLog: p } }), notOwn(p), JSON.stringify(p));
  }
  // Nor a file another path key names: the record would go into the handoff, the graph or the ceiling registry
  // (the data review's four cells), however either is spelled (case, a backslash, . and ..).
  const shared = (/** @type {string} */ value, /** @type {string} */ key, /** @type {string} */ other) => (/** @type {unknown} */ e) =>
    e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `"paths.metricsLog": ${JSON.stringify(value)} names the same file as "${key}" (${JSON.stringify(other)}): a record appended to it would break that file`;
  for (const [cfg, key, other] of /** @type {[any, string, string][]} */ ([
    [{ impact: { ceilingRegistry: ".ennyn/registry.jsonl" }, paths: { metricsLog: ".ennyn/registry.jsonl" } }, "impact.ceilingRegistry", ".ennyn/registry.jsonl"],
    [{ paths: { handoff: ".ennyn/handoff.jsonl", metricsLog: ".ennyn/handoff.jsonl" } }, "paths.handoff", ".ennyn/handoff.jsonl"],
    [{ paths: { changelog: ".ennyn/changes.jsonl", metricsLog: ".ennyn/changes.jsonl" } }, "paths.changelog", ".ennyn/changes.jsonl"],
    [{ paths: { graph: ".ennyn/graph.jsonl", metricsLog: ".ennyn/graph.jsonl" } }, "paths.graph", ".ennyn/graph.jsonl"],
    [{ paths: { graph: "./docs/G.jsonl", metricsLog: "docs/x/../g.jsonl" } }, "paths.graph", "./docs/G.jsonl"],
    [{ paths: { handoff: "docs\\h.jsonl", metricsLog: "docs/h.jsonl" } }, "paths.handoff", "docs\\h.jsonl"],
    [{ paths: { graph: "docs/e\u0301.jsonl", metricsLog: "docs/\u00e9.jsonl" } }, "paths.graph", "docs/e\u0301.jsonl"],
    [{ paths: { graph: "docs/g\u200c.jsonl", metricsLog: "docs/g.jsonl" } }, "paths.graph", "docs/g\u200c.jsonl"],
  ])) assert.throws(own(cfg), shared(cfg.paths.metricsLog, key, other), JSON.stringify(cfg));
  // A log that leads outside is said once, as leading outside: not also as shared.
  assert.throws(own({ paths: { handoff: "../h.jsonl", metricsLog: "../h.jsonl" } }), (e) => e instanceof ConfigError && e.problems.length === 2 && e.problems.every((p) => /leads outside/.test(p)));
  assert.equal(/** @type {any} */ (own({ paths: { handoff: ".ennyn/handoff.jsonl", graph: ".ennyn/graph.jsonl", changelog: "docs/metrics.jsonl" } })()).paths.metricsLog, ".ennyn/metrics.jsonl");
  writeFileSync(join(box, "local.json"), JSON.stringify({ paths: { metricsLog: ".git/ennyn/metrics.jsonl", stateDir: ".git/ennyn" } }));
  assert.throws(() => loadConfig({ cwd: dir, env: { ENNYN_CONFIG: join(box, "local.json") } }), inGit("paths.metricsLog", ".git/ennyn/metrics.jsonl"));
});

test("files: state is written, removed and listed below its root through no symbolic link, the last component too", () => {
  const { writeState, removeState, listState, readRegular } = /** @type {any} */ (filesModule);
  const root = mkdtempSync(join(tmpdir(), "pl-state-"));
  const away = mkdtempSync(join(tmpdir(), "pl-state-away-"));
  writeFileSync(join(away, "victim"), "mine\n");
  const kept = () => [readdirSync(away).sort(), readFileSync(join(away, "victim"), "utf8")];
  // A link at the file (state-leaf-link), at a directory on the way (state-sidecopy-dir-link), at the root's own level.
  mkdirSync(join(root, "s"));
  symlinkSync(join(away, "victim"), join(root, "s/log.jsonl"));
  symlinkSync(away, join(root, "s/side-copy"));
  symlinkSync(join(away, "victim"), join(root, "top.jsonl"));
  for (const [path, how] of [["s/log.jsonl", "append"], ["s/side-copy/x.json", "replace"], ["s/side-copy/x.json", "create"], ["s/side-copy/x.json", "append"], ["top.jsonl", "append"]]) {
    assert.throws(() => writeState(root, join(root, path), "x\n", how), /was not written: .*is a symbolic link/, `${path} ${how}`);
  }
  // Create at a link: refused as a link (O_EXCL alone would take it for a file that is there, and not follow it).
  assert.throws(() => writeState(root, join(root, "s/log.jsonl"), "x\n", "create"), /was not written: s\/log\.jsonl is a symbolic link/);
  assert.deepEqual(kept(), [["victim"], "mine\n"]);
  assert.throws(() => readRegular(root, join(root, "s/side-copy/x.json")), /could not be read: s\/side-copy is a symbolic link/);
  assert.throws(() => removeState(root, join(root, "s/side-copy/victim")), /was not removed: s\/side-copy is a symbolic link/);
  assert.throws(() => listState(root, join(root, "s/side-copy")), /could not be read: s\/side-copy is a symbolic link/);
  // A path outside the root is refused, whatever it names.
  assert.throws(() => writeState(root, join(away, "victim"), "x\n", "append"), /was not written: it lies outside/);
  // A link planted at the temporary name a replace writes first is removed, never followed.
  symlinkSync(join(away, "victim"), join(root, `s/list.json.${process.pid}.tmp`));
  writeState(root, join(root, "s/list.json"), "{}\n", "replace");
  assert.deepEqual(kept(), [["victim"], "mine\n"]);
  assert.equal(readFileSync(join(root, "s/list.json"), "utf8"), "{}\n");
  // A directory at that name is said with the file it was for, and the file is left as it was.
  mkdirSync(join(root, `s/list.json.${process.pid}.tmp`));
  assert.throws(() => writeState(root, join(root, "s/list.json"), "[]\n", "replace"), /list\.json was not written: .*list\.json\.\d+\.tmp could not be removed: /);
  assert.equal(readFileSync(join(root, "s/list.json"), "utf8"), "{}\n");
  rmSync(join(root, `s/list.json.${process.pid}.tmp`), { recursive: true });
  // The link itself goes on a remove; what it named stays.
  removeState(root, join(root, "top.jsonl"));
  assert.deepEqual([existsSync(join(root, "top.jsonl")), kept()], [false, [["victim"], "mine\n"]]);
  // Append closes a last line cut short; create refuses what is there.
  writeFileSync(join(root, "s/torn.jsonl"), "{\"a\":1}\n{\"b\"");
  writeState(root, join(root, "s/torn.jsonl"), "{\"c\":3}\n", "append");
  assert.equal(readFileSync(join(root, "s/torn.jsonl"), "utf8"), '{"a":1}\n{"b"\n{"c":3}\n');
  assert.throws(() => writeState(root, join(root, "s/torn.jsonl"), "x", "create"), (e) => /** @type {any} */ (e).code === "EEXIST");
  assert.deepEqual(listState(root, join(root, "s/none")), []);
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
  // Inside .git there is no work tree: no project directory, not "outside a repository". A git from 2.38 to 2.43 refuses
  // the folder outright under safe.bareRepository=explicit: git's word differs, the read fails either way.
  assert.throws(() => repoPath("--show-toplevel", { cwd: join(dir, ".git") }), /must be run in a work tree|cannot use bare repository/);
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
  // Spelled another way, a .git value is still one: "./.git/ennyn" goes to the common dir, ".git/../x" is x.
  assert.equal(resolveStateDir(wt, "./.git/ennyn"), join(commonDir(repo), "ennyn"));
  assert.equal(resolveStateDir(wt, ".git/../state"), join(wt, "state"));
  // Its files are read and written below the common git dir for a .git value, below the project for another.
  const { stateRoot } = await import("../core/git.mjs");
  // In the git dir its own directory: no commit writes there, a link on the way is this machine's (user-git-state-link).
  assert.equal(stateRoot(wt, join(fromWorktree, "gate-attempts.jsonl")), fromWorktree);
  assert.equal(stateRoot(wt, join(wt, "state/x")), wt);
  assert.equal(stateRoot(repo, "/elsewhere/x"), "/elsewhere");
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

test("core: diffGroups splits a staged diff by size, in order: a file past DIFF_GROUP by the larger of its two sizes alone, the others together up to it and 500 paths", () => {
  const M = DIFF_GROUP;
  const changes = new Map([
    ["big", { oldSize: M + 1, newSize: 5 }],
    ["a", { oldSize: 10, newSize: 10 }],
    ["b", { oldSize: 0, newSize: M - 20 }],
    ["c", { oldSize: 30, newSize: 0 }],
  ]);
  // a and b come to M - 10; c would pass M; x, not in the map, counts as small.
  assert.deepEqual(diffGroups(["big", "a", "b", "c", "x"], changes), [["big"], ["a", "b"], ["c", "x"]]);
  assert.deepEqual(diffGroups(["a", "big", "c"], changes), [["a"], ["big"], ["c"]]);
  assert.deepEqual(diffGroups(Array.from({ length: 1001 }, (_, i) => `f${i}`), new Map()).map((g) => g.length), [500, 500, 1]);
  assert.deepEqual(diffGroups([], changes), []);
});

/**
 * A git that answers `cat-file --batch-check` as Debian 12's 2.39.5 does under GIT_NO_LAZY_FETCH: line by line, until
 * an object EN_LOST names, where it says it could not fetch it and exits 128 (EN_SAY and EN_EXIT change those; EN_END
 * dies after the last answer). Every other command is the real git. `vars(more)` puts it first on PATH; `calls()`
 * counts its batch-check runs since then.
 * @param {string} box
 */
function dyingGit(box) {
  const bin = join(box, "bin");
  mkdirSync(bin);
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const log = join(box, "calls");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in *" --batch-check "*)
  echo call >> '${log}'
  while IFS= read -r o; do
    case " $EN_LOST " in *" $o "*)
      echo "warning: lazy fetching disabled; some objects may not be available" >&2
      echo "fatal: \${EN_SAY:-could not fetch $o from promisor remote}" >&2
      exit "\${EN_EXIT:-128}" ;;
    esac
    printf '%s\\n' "$o" | '${real}' "$@" || exit $?
  done
  if [ -n "$EN_END" ]; then echo "fatal: $EN_END" >&2; exit 128; fi
  exit 0 ;;
esac
exec '${real}' "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return {
    vars: (/** @type {Record<string, string>} */ more) => (writeFileSync(log, ""), { PATH: `${bin}:${process.env.PATH}`, ...more }),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
  };
}

test("core: batchCheck reads an object a partial clone lacks as missing where git dies at it (the May 2024 maintenance releases), asking for the rest again; any other failure throws", () => {
  const box = mkdtempSync(join(tmpdir(), "en-batch-"));
  const repo = join(box, "r");
  mkdirSync(repo);
  git(["init", "-q"], { cwd: repo });
  const oid = (/** @type {string} */ text) => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: text, encoding: "utf8" }).trim();
  const [a, b, c, d] = ["a\n", "bb\n", "ccc\n", "dddd\n"].map(oid);
  const dying = dyingGit(box);
  const ask = (/** @type {string[]} */ oids, /** @type {Record<string, string>} */ more) => {
    const lines = batchCheck(repo, oids, { env: { ...process.env, ...dying.vars(more) } });
    return { lines, calls: dying.calls() };
  };
  assert.deepEqual(ask([a, b, c], { EN_LOST: "" }), { lines: [`${a} blob 2`, `${b} blob 3`, `${c} blob 4`], calls: 1 });
  assert.deepEqual(ask([a, b, c, d], { EN_LOST: `${b} ${d}` }), { lines: [`${a} blob 2`, `${b} missing`, `${c} blob 4`, `${d} missing`], calls: 2 });
  assert.deepEqual(ask([b, a], { EN_LOST: b }), { lines: [`${b} missing`, `${a} blob 2`], calls: 2 });
  // Another death is no missing object, nor one naming an object not next in line, nor another exit.
  assert.throws(() => ask([a, b], { EN_LOST: b, EN_EXIT: "1" }), new RegExp(`could not fetch ${b}`));
  assert.throws(() => ask([a, b], { EN_LOST: "", EN_END: "died after the last answer" }), /died after the last answer/);
  assert.throws(() => ask([a, b], { EN_LOST: b, EN_SAY: "unable to read the object" }), /unable to read the object/);
  assert.throws(() => ask([a, b], { EN_LOST: b, EN_SAY: `could not fetch ${c} from promisor remote` }), new RegExp(`could not fetch ${c}`));
  // git that says missing itself (2.45 and later) is asked once.
  assert.deepEqual(batchCheck(repo, [a, "0".repeat(39) + "1"]), [`${a} blob 2`, `${"0".repeat(39)}1 missing`]);
  rmSync(box, { recursive: true, force: true });
});

test("core: where git dies at an object a partial clone lacks, the hook's readers read the rest: HEAD's version of a lock file, files read whole, added lines", () => {
  const box = mkdtempSync(join(tmpdir(), "en-batch-readers-"));
  const repo = join(box, "r");
  mkdirSync(repo);
  git(["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  git(["add", "package-lock.json"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo });
  const headLock = git(["rev-parse", "HEAD:package-lock.json"], { cwd: repo });
  writeFileSync(join(repo, "package-lock.json"), '{"x":1}\n');
  const utf16 = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  writeFileSync(join(repo, "u.txt"), utf16("never use qq here\n"));
  writeFileSync(join(repo, "v.txt"), utf16("never use vv here\n"));
  git(["add", "package-lock.json", "u.txt", "v.txt"], { cwd: repo });
  const u = git(["rev-parse", ":u.txt"], { cwd: repo });
  const dying = dyingGit(box);
  const saved = { PATH: process.env.PATH, EN_LOST: process.env.EN_LOST };
  const lose = (/** @type {string} */ oid) => Object.assign(process.env, dying.vars({ EN_LOST: oid }));
  try {
    lose(headLock);
    const lock = stagedVersions(repo, ["package-lock.json"]).get("package-lock.json");
    assert.deepEqual({ staged: lock?.staged?.toString(), head: lock?.head, headUnread: lock?.headUnread }, { staged: '{"x":1}\n', head: null, headUnread: "notBlob" });
    lose(u);
    const whole = stagedBlobs(repo, ["u.txt", "v.txt"]);
    assert.deepEqual([...whole.unread], [["u.txt", `${u} is not a blob git can read`]]);
    assert.deepEqual([...whole.blobs.keys()], ["v.txt"]);
    // The added lines: the lost file named missing, the other read and its UTF-16 decoded.
    lose(u);
    const unread = new Map();
    const lines = stagedAddedLines(repo, ["u.txt", "v.txt"], { unread });
    assert.deepEqual([...unread], [["u.txt", MISSING_OBJECT]]);
    assert.ok(JSON.stringify(lines.get("v.txt") ?? []).includes("never use vv here"), JSON.stringify([...lines]));
  } finally {
    Object.assign(process.env, saved);
    if (saved.EN_LOST === undefined) delete process.env.EN_LOST;
    rmSync(box, { recursive: true, force: true });
  }
});
