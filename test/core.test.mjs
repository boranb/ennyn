import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, linkSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, delimiter, join, posix, win32 } from "node:path";
import { globToRegExp, literalGlob, matchAny } from "../core/glob.mjs";
import { loadConfig, ConfigError, DEFAULTS } from "../core/config.mjs";
import { alive, DIFF_GROUP, GIT_LIMITS, MISSING_OBJECT, addedLines, argBatches, batchCheck, diffGroups, git, gitMaybe, headCommit, indexNames, machineFault, nameText, parseTrailers, repoPath, stagedAddedLines, stagedBlobs, stagedChanges, stagedNames, stagedPaths, stagedVersions, stagedVersionsEach, unpushedCount, waitGone } from "../core/git.mjs";
import { shown, t } from "../core/i18n.mjs";
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

test("config audit: a registry list the project gives replaces the default one", () => {
  const c = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-scale-")), env: {}, override: { security: { deps: { registries: { "https://r.example": null } } } } });
  assert.deepEqual(c.security.deps.registries, { "https://r.example": null }, "no default left to be contacted");
  // Replaced, still checked.
  assert.throws(() => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-scale-")), env: {}, override: { security: { deps: { registries: { "https://r.example": 3 } } } } }), (e) => e instanceof ConfigError && /"security\.deps\.registries\.https:\/\/r\.example" must be string \| null, got number/.test(e.message));
});

test("config: a key lean-audit removed is an unknown key, said by name, with the rest of what is wrong", () => {
  const load = (/** @type {Record<string, unknown>} */ override) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cfg-gone-")), env: {}, override });
  /** @type {[Record<string, unknown>, string][]} */
  const gone = [
    [{ planner: { mechanizationSlots: 1 } }, "planner.mechanizationSlots"],
    [{ paths: { changelog: "CHANGELOG.md" } }, "paths.changelog"],
    [{ graph: { valueScale: { high: 3 } } }, "graph.valueScale"],
    [{ graph: { costScale: { S: 1 } } }, "graph.costScale"],
    [{ impact: { coChangeMin: 3 } }, "impact.coChangeMin"],
    [{ metrics: { reworkDays: 7 } }, "metrics.reworkDays"],
    [{ metrics: { maxFixFiles: 15 } }, "metrics.maxFixFiles"],
  ];
  for (const [override, key] of gone) assert.throws(() => load(override), (e) => e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `unknown key "${key}"`, key);
  assert.throws(() => load({ language: "xx", planner: { mechanizationSlots: 1 } }), (e) => e instanceof ConfigError && e.problems.length === 2, "said beside the rest");
  assert.deepEqual(Object.keys(DEFAULTS.planner), ["splitAbove"]);
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
  for (const key of ["handoff", "graph"]) {
    // The metrics log elsewhere: a key naming its file is refused (below).
    for (const p of inside) assert.equal(/** @type {any} */ (own({ paths: { [key]: p, metricsLog: ".ennyn/other.jsonl" } })()).paths[key], p, `${key} ${JSON.stringify(p)}`);
  }
  for (const key of ["handoff", "graph", "metricsLog", "findings", "stateDir"]) {
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
  for (const key of ["handoff", "graph", "metricsLog"]) {
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
    [{ paths: { graph: ".ennyn/graph.jsonl", metricsLog: ".ennyn/graph.jsonl" } }, "paths.graph", ".ennyn/graph.jsonl"],
    [{ paths: { graph: "./docs/G.jsonl", metricsLog: "docs/x/../g.jsonl" } }, "paths.graph", "./docs/G.jsonl"],
    [{ paths: { handoff: "docs\\h.jsonl", metricsLog: "docs/h.jsonl" } }, "paths.handoff", "docs\\h.jsonl"],
    [{ paths: { graph: "docs/e\u0301.jsonl", metricsLog: "docs/\u00e9.jsonl" } }, "paths.graph", "docs/e\u0301.jsonl"],
    [{ paths: { graph: "docs/g\u200c.jsonl", metricsLog: "docs/g.jsonl" } }, "paths.graph", "docs/g\u200c.jsonl"],
  ])) assert.throws(own(cfg), shared(cfg.paths.metricsLog, key, other), JSON.stringify(cfg));
  // A log that leads outside is said once, as leading outside: not also as shared.
  assert.throws(own({ paths: { handoff: "../h.jsonl", metricsLog: "../h.jsonl" } }), (e) => e instanceof ConfigError && e.problems.length === 2 && e.problems.every((p) => /leads outside/.test(p)));
  assert.equal(/** @type {any} */ (own({ paths: { handoff: ".ennyn/handoff.jsonl", graph: ".ennyn/graph.jsonl" } })()).paths.metricsLog, ".ennyn/metrics.jsonl");
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
  // A .git file that points to no repository: git 2.34 and 2.39 say "not a git repository: <target>", 2.56 "gitfile
  // does not point to a valid repository". The same folder, so the same answer on every git.
  const dangling = mkdtempSync(join(tmpdir(), "pl-head-gitfile-"));
  writeFileSync(join(dangling, ".git"), `gitdir: ${join(dangling, "nowhere")}\n`);
  for (const flag of ["--git-dir", "--show-toplevel"]) assert.equal(repoPath(flag, { cwd: dangling }), null, flag);
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
  // A file where a directory of the path should be: Node 22.0's statSync throwIfNoEntry still throws ENOTDIR.
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

test("config: commands.wholeTest is a command on one line or null; push.codeGlobs a list of globs, every path by default", () => {
  const load = (/** @type {unknown} */ v) => {
    const dir = mkdtempSync(join(tmpdir(), "en-wholetest-"));
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(v));
    try {
      return loadConfig({ cwd: dir, env: {} });
    } catch (e) {
      return /** @type {any} */ (e).problems;
    }
  };
  const plain = load({});
  assert.deepEqual([plain.commands.wholeTest, plain.push.codeGlobs], [null, ["**"]]);
  assert.equal(load({ commands: { wholeTest: "npm test" } }).commands.wholeTest, "npm test");
  assert.deepEqual(load({ push: { codeGlobs: ["**/*.mjs"] } }).push.codeGlobs, ["**/*.mjs"]);
  for (const bad of ["", "  ", "npm test\nrm -rf x"]) assert.deepEqual(load({ commands: { wholeTest: bad } }), ['"commands.wholeTest" must be a command on one line, or null'], JSON.stringify(bad));
  assert.match(String(load({ commands: { wholeTest: { none: "x" } } })), /commands\.wholeTest/);
  assert.deepEqual(load({ push: { codeGlobs: ["", "x"] } }), ['"push.codeGlobs" must be a list of globs']);
});

test("config: commands.fastTest is a command, or none with its reason; no typo reads as none", () => {
  const load = (/** @type {unknown} */ fastTest) => {
    const dir = mkdtempSync(join(tmpdir(), "en-fasttest-"));
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ language: "xx", commands: { fastTest: fastTest } }));
    try {
      return loadConfig({ cwd: dir, env: {} }).commands.fastTest;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // Said beside the rest of what is wrong: "language" is the other problem.
      assert.ok(e.problems.some((p) => p.startsWith('"language"')), e.message);
      return e.problems.filter((p) => !p.startsWith('"language"'));
    }
  };
  assert.equal(loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-fasttest-")), env: {} }).commands.fastTest, null, "unset by default");
  const accept = (/** @type {unknown} */ v) => {
    const dir = mkdtempSync(join(tmpdir(), "en-fasttest-"));
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commands: { fastTest: v } }));
    assert.deepEqual(loadConfig({ cwd: dir, env: {} }).commands.fastTest, v, JSON.stringify(v));
  };
  for (const ok of [null, "npm run test:short", "npm test -- --grep 'none'", "./none", "none-of-these.sh", { none: "a documentation site: nothing runs" }]) accept(ok);
  // The review's cells (cycle 20): commands as shells and other systems write them load; what a reader sees is doctor's.
  for (const ok of ["npm run build && npm test", "dotnet test --filter Category=Fast", ".\\scripts\\test.ps1", "pytest -k 'not slow' \"tests/unit\"", "npm\ttest", "'none'", "null", "npm test\u001b[31mRED", "npm test rm -rf x", { none: "1" }]) accept(ok);
  /** @type {[unknown, RegExp][]} */
  const reject = [
    ["", /^"commands\.fastTest" must be a command on one line, or \{ "none": "<why the project has no tests>" \}$/],
    ["   ", /must be a command on one line/],
    ["npm test\nrm -rf x", /must be a command on one line/],
    ["npm test\u0000", /must be a command on one line/],
    ["none", /^"commands\.fastTest": "none" names no command; a project with no tests writes \{ "none": "<why>" \}$/],
    [" None ", /" None " names no command/],
    ["NONE", /"NONE" names no command/],
    [" none ", /names no command/],
    ["npm test\r", /must be a command on one line/],
    ["npm test\n", /must be a command on one line/],
    [{}, /^"commands\.fastTest\.none" must say, on one line, why the project has no tests$/],
    [{ none: "" }, /"commands\.fastTest\.none" must say/],
    [{ none: "  " }, /"commands\.fastTest\.none" must say/],
    [{ none: 1 }, /"commands\.fastTest\.none" must say/],
    [{ none: "no\ntests" }, /"commands\.fastTest\.none" must say/],
    [{ none: true }, /"commands\.fastTest\.none" must say/],
    // A reason that shows nothing is no reason: it needs a letter or a digit, as the Impact line does.
    [{ none: "​" }, /"commands\.fastTest\.none" must say/],
    [{ none: " - " }, /"commands\.fastTest\.none" must say/],
    [{ none: null }, /"commands\.fastTest\.none" must say/],
    [{ none: { why: "x" } }, /"commands\.fastTest\.none" must say/],
    [3, /^"commands\.fastTest" must be string \| object, got number$/],
    [true, /must be string \| object, got boolean/],
    [[], /must be string \| object, got array/],
    [["npm test"], /must be string \| object, got array/],
  ];
  for (const [bad, re] of reject) {
    const got = load(bad);
    assert.ok(Array.isArray(got) && got.length === 1 && re.test(got[0]), `${JSON.stringify(bad)}: ${JSON.stringify(got)}`);
  }
  // A misspelt key in the object is no "none": the key is unknown, and the reason is missing.
  assert.deepEqual(load({ nnoe: "no tests yet" }), ['"commands.fastTest": unknown key "nnoe"', '"commands.fastTest.none" must say, on one line, why the project has no tests']);
  assert.deepEqual(load({ none: "no tests yet", command: "npm test" }), ['"commands.fastTest": unknown key "command"']);
  assert.deepEqual(load({ None: "x" }), ['"commands.fastTest": unknown key "None"', '"commands.fastTest.none" must say, on one line, why the project has no tests']);
  assert.deepEqual(load({ none: "x", $comment: "y" }), ['"commands.fastTest": unknown key "$comment"']);
  // The parent key: an object, and only the keys it has.
  for (const [commands, re] of /** @type {[unknown, RegExp][]} */ ([[null, /^"commands" must be object, got null$/], ["npm test", /^"commands" must be object, got string$/], [{ lint: "eslint" }, /^unknown key "commands\.lint"$/]])) {
    const d = mkdtempSync(join(tmpdir(), "en-fasttest-"));
    mkdirSync(join(d, ".ennyn"));
    writeFileSync(join(d, ".ennyn", "config.json"), JSON.stringify({ commands }));
    assert.throws(() => loadConfig({ cwd: d, env: {} }), (e) => e instanceof ConfigError && e.problems.length === 1 && re.test(e.problems[0]), JSON.stringify(commands));
  }
  assert.deepEqual(load({ fastTest: "npm test" }), ['"commands.fastTest": unknown key "fastTest"', '"commands.fastTest.none" must say, on one line, why the project has no tests'], "nested where the command goes");
  // An override replaces what the file set, as for any key that defaults to null: a command over none, none over a command.
  const dir = mkdtempSync(join(tmpdir(), "en-fasttest-"));
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commands: { fastTest: { none: "x" } } }));
  assert.equal(loadConfig({ cwd: dir, env: {}, override: { commands: { fastTest: "npm test" } } }).commands.fastTest, "npm test");
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commands: { fastTest: "npm test" } }));
  assert.deepEqual(loadConfig({ cwd: dir, env: {}, override: { commands: { fastTest: { none: "y" } } } }).commands.fastTest, { none: "y" });
  assert.throws(() => loadConfig({ cwd: dir, env: {}, override: { commands: { fastTest: { nnoe: "y" } } } }), /unknown key "nnoe"/);
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

test("machineFault: by shape: git that exited, was killed or stopped and any errno are the machine's; the two errnos a commit can pick and any throw of ours are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-fault-"));
  git(["init", "-q"], { cwd: dir });
  /** @param {() => unknown} f */
  const thrown = (f) => {
    try {
      f();
    } catch (e) {
      return e;
    }
    throw new Error("it did not throw");
  };
  assert.equal(machineFault(thrown(() => git(["rev-parse", "--verify", "no-such-rev"], { cwd: dir }))), true, "git exited non-zero");
  assert.equal(machineFault(thrown(() => gitMaybe(["rev-parse", "--verify", "no-such-rev"], { cwd: dir, absent: [] }))), true, "git exited non-zero, through gitError");
  assert.equal(machineFault(thrown(() => git(["status"], { cwd: join(dir, "not-there") }))), true, "ENOENT: no directory to run in");
  assert.equal(machineFault(thrown(() => gitMaybe(["status"], { cwd: join(dir, "not-there"), absent: [] }))), true, "ENOENT, through gitError");
  assert.equal(machineFault(thrown(() => git(["status", "a\0b"], { cwd: dir }))), false, "an argument Node refuses");
  assert.equal(machineFault(thrown(() => git(["ls-files", "--", "z".repeat(1100 * 1024)], { cwd: dir }))), false, "E2BIG");
  for (const code of ["ENOENT", "EACCES", "EMFILE", "ENOMEM", "EAGAIN", "ETIMEDOUT", "ENFILE", "EPERM", "EIO", "ETXTBSY", "ENOEXEC", "EPIPE", "ENOSPC", "EDQUOT", "EBUSY", "ELOOP", "ENAMETOOLONG", "EINTR"]) assert.equal(machineFault(Object.assign(new Error("x"), { code })), true, code);
  for (const code of ["E2BIG", "ENOBUFS", "ERR_INVALID_ARG_VALUE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "EX", "E", "enoent", ""]) assert.equal(machineFault(Object.assign(new Error("x"), { code })), code === "EX", code);
  assert.equal(machineFault(Object.assign(new Error("x"), { code: "E2BIG", status: 1, signal: "SIGTERM" })), false, "E2BIG stays the content's, whatever else it holds");
  assert.equal(machineFault(Object.assign(new Error("killed"), { signal: "SIGKILL", status: null })), true);
  assert.equal(machineFault(Object.assign(new Error("past the buffer"), { code: "ENOBUFS", signal: "SIGTERM" })), false, "git stopped because of what it wrote");
  for (const e of [new Error("ours"), new RangeError("too much"), new SyntaxError("no"), Object.assign(new Error("x"), { status: 0 }), null, "text"]) assert.equal(machineFault(e), false, String(e));
});

test("argBatches: 500 names a call and under Linux's floor for arguments, a name past it alone; no name, no call", () => {
  assert.deepEqual(argBatches([]), []);
  assert.deepEqual(argBatches(Array.from({ length: 1001 }, (_, i) => String(i))).map((b) => b.length), [500, 500, 1]);
  // 500 names of 200 bytes pass 64 KiB: a stack under 1 MiB leaves execve 128 KiB, the environment included.
  assert.deepEqual(argBatches(Array.from({ length: 500 }, (_, i) => `${String(i).padStart(3, "0")}${"b".repeat(197)}`)).map((b) => b.length), [326, 174]);
  assert.deepEqual(argBatches(["a".repeat(40000), "b".repeat(40000), "c".repeat(20000), "d"]).map((b) => b.length), [1, 3]);
  assert.deepEqual(argBatches(["a", "z".repeat(1 << 20), "b"]).map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(argBatches(["\u00e9".repeat(20000), "\u00e9".repeat(20000)]).map((b) => b.length), [1, 1], "bytes, not characters");
});

test("stagedNames: what the commit deletes is told from what it brings, with no pathspec; indexNames with no path lists the index", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-names-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  for (const [p, text] of [["gone", "g\n"], ["kept", "k\n"], ["data", "d\n"]]) writeFileSync(join(dir, p), text);
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], { cwd: dir });
  rmSync(join(dir, "gone"));
  rmSync(join(dir, "data"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data", "x"), "x\n");
  writeFileSync(join(dir, "kept"), "k2\n");
  writeFileSync(join(dir, "new"), "n\n");
  git(["add", "-A"], { cwd: dir });
  const read = stagedNames(dir);
  assert.deepEqual([...read.paths].sort(), ["data", "data/x", "gone", "kept", "new"]);
  assert.deepEqual([...read.deleted].sort(), ["data", "gone"]);
  assert.equal(read.deletedUnread, false);
  assert.deepEqual(stagedPaths(dir), read.paths);
  assert.deepEqual([...stagedChanges(dir).keys()].sort(), ["data/x", "kept", "new"], "what the commit deletes brings nothing to read");
  assert.deepEqual([...indexNames(dir, { paths: [] }).paths].sort(), ["data/x", "kept", "new"]);
  assert.deepEqual(indexNames(dir, { paths: ["data"] }).paths, ["data/x"]);
});

test("addedLines: a deleted path below an asked name is that name's old directory, no misread diff; one outside what was asked still throws", () => {
  const below = "diff --git a/data/x b/data/x\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/data/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
  const asked = "diff --git a/data b/data\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/data\n@@ -0,0 +1 @@\n+d\n";
  assert.deepEqual(addedLines(asked + below, new Set(["data"]), { complete: true }), new Map([["data", [{ line: 1, text: "d" }]]]));
  assert.throws(() => addedLines(asked + below.replaceAll("data/x", "database"), new Set(["data"])), /not asked for/, "a name that only starts alike is not below it");
  assert.throws(() => addedLines(asked + below, new Set(["data/y"])), /not asked for/);
  assert.deepEqual(addedLines(below.replaceAll("data/x", "deep/data/x"), new Set(["deep/data"])), new Map(), "a name at any depth");
});

test("waitGone: a process that stays alive is waited for until the limit and reads not gone; one that goes reads gone at once (win-kill-waits-exit)", () => {
  let asked = 0;
  const started = Date.now();
  assert.equal(waitGone(4242, 300, () => (asked++, true)), false);
  const took = Date.now() - started;
  assert.ok(took >= 300 && took < 3000, `waited ${took} ms`);
  assert.ok(asked > 2, "asked again while waiting");
  asked = 0;
  assert.equal(waitGone(4242, 60_000, () => ++asked < 3), true);
  assert.equal(asked, 3);
  assert.equal(waitGone(4242, 0, () => false), true);
  // The real probe: this process runs; a child that has exited and been reaped does not.
  assert.equal(alive(process.pid), true);
  const ended = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(ended.status, 0);
  assert.equal(waitGone(ended.pid, 2000), true);
});

test("stagedVersionsEach: a git stopped at its limit is not asked again, by name or by the next call, and every name stands failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-each-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  const bin = mkdtempSync(join(tmpdir(), "en-each-git-"));
  const log = join(bin, "asked");
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ls-files -s "*) echo x >> "${log}"; exec sleep 30 ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const saved = { path: process.env.PATH, call: GIT_LIMITS.call };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  GIT_LIMITS.call = 3000;
  try {
    const { versions, failed } = stagedVersionsEach(dir, Array.from({ length: 600 }, (_, i) => `f${i}`), {});
    assert.equal(versions.size, 0);
    assert.equal(failed.length, 600);
    assert.equal(/** @type {NodeJS.ErrnoException} */ (failed[599].error).code, "ETIMEDOUT");
    assert.ok(readFileSync(log, "utf8").trim().split("\n").length <= 1, "one call stopped");
  } finally {
    process.env.PATH = saved.path;
    GIT_LIMITS.call = saved.call;
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("nameText: UTF-8 as it is; a name that is not keeps its bytes apart from any UTF-8 name, the valid letters in it readable", () => {
  assert.equal(nameText(Buffer.from("caf\u00e9/\u{1f600}.js")), "caf\u00e9/\u{1f600}.js");
  const bad = nameText(Buffer.from([0x70, 0xff, 0x2e, 0x79]));
  assert.notEqual(bad, "p\ufffd.y");
  assert.equal(bad.toWellFormed(), "p\ufffd.y");
  assert.notEqual(nameText(Buffer.from([0xff])), nameText(Buffer.from([0xfe])));
  assert.equal(nameText(Buffer.from([0xc3, 0xa9, 0xff])).toWellFormed(), "\u00e9\ufffd");
  assert.equal(nameText(Buffer.from([0xe2, 0x82])).toWellFormed(), "\ufffd\ufffd", "a cut sequence, a byte at a time");
  assert.equal(shown(nameText(Buffer.from([0x70, 0xff, 0x22])), { name: true }).text, '"p\ufffd\\""', "shown as U+FFFD, in quotes too");
});
