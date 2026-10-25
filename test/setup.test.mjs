import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { git, parseVersion, versionAtLeast, GIT_FLOOR } from "../core/git.mjs";
import { DEFAULTS, loadConfig } from "../core/config.mjs";
import {
  FIX_CANDIDATES,
  MIN_HISTORY,
  proposeFixSubject,
  recentCommits,
  productionSubjects,
  pathPatterns,
  churnPaths,
  testLayout,
  riskyPaths,
  roadmapFiles,
  projectCommands,
  commitStyle,
  scanProject,
} from "../setup/scan.mjs";
import { checkSetup } from "../setup/doctor.mjs";
import { shown, t, tShown } from "../core/i18n.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const cfg = () => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-s-")), env: {} });
const pat = () => pathPatterns(DEFAULTS, []).re;

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** Temp repository; `commit` stages everything. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "en-setup-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  return {
    dir,
    /** @param {string} message @param {Record<string, string>} [files] */
    commit(message, files = {}) {
      put(dir, files);
      git(["add", "-A"], { cwd: dir });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
    },
  };
}

/** @param {number} n @param {(i: number) => string} f */
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("fix label: every candidate compiles without flags; the first is the default", () => {
  assert.equal(FIX_CANDIDATES[0].pattern, DEFAULTS.metrics.fixSubject);
  for (const c of FIX_CANDIDATES) assert.doesNotThrow(() => new RegExp(c.pattern), c.id);
});

test("fix label: too little history keeps the default", () => {
  const r = proposeFixSubject(many(MIN_HISTORY - 1, (i) => (i % 3 ? `feat: a${i}` : `fix: b${i}`)));
  assert.equal(r.reason, "tooFew");
  assert.equal(r.proposal, null);
});

test("fix label: conventional history picks the conventional pattern; a majority is flagged", () => {
  const some = proposeFixSubject(many(40, (i) => (i < 10 ? `fix(api): b${i}` : `feat: a${i}`)));
  assert.deepEqual([some.reason, some.pick, some.proposal], ["ok", "conventional", DEFAULTS.metrics.fixSubject]);
  assert.equal(some.candidates[0].matches, 10);
  assert.equal(some.conventionalShare, 1);
  const most = proposeFixSubject(many(40, (i) => (i < 25 ? `fix: b${i}` : `feat: a${i}`)));
  assert.equal(most.reason, "majority");
  assert.equal(most.proposal, DEFAULTS.metrics.fixSubject);
  // Exactly half is not a majority (the CLI's rework note uses the same rule).
  assert.equal(proposeFixSubject(many(40, (i) => (i < 20 ? `fix: b${i}` : `feat: a${i}`))).reason, "ok");
});

test("fix label: plain English and Turkish subjects pick an anchored pattern", () => {
  const en = proposeFixSubject(many(40, (i) => [`Fix login loop ${i}`, `Fixed crash ${i}`, `Add page ${i}`, `Prefix ids ${i}`][i % 4]));
  assert.equal(en.pick, "verb");
  assert.equal(en.candidates[1].matches, 20, "Fix / Fixed count, Prefix does not");
  assert.equal(en.candidates[3].matches, 20, "a mention needs a word boundary too");
  const tr = proposeFixSubject(many(40, (i) => (i % 4 ? `Ekran eklendi ${i}` : `Düzeltme: liste boş kalıyordu ${i}`)));
  assert.deepEqual([tr.pick, tr.reason], ["turkish", "ok"]);
  const ing = proposeFixSubject(many(40, (i) => (i % 2 ? `Fixing crash ${i}` : `Add page ${i}`)));
  assert.deepEqual([ing.pick, ing.reason], ["verb", "ok"]);
});

test("fix label: outside a conventional history the pattern covering the most fixes wins", () => {
  // 5 conventional fixes and 40 plain ones: picking the first pattern with any match would see 5 of 45.
  const r = proposeFixSubject(many(100, (i) => (i < 5 ? `fix: a${i}` : i < 45 ? `Fix crash ${i}` : `Add page ${i}`)));
  assert.deepEqual([r.pick, r.reason], ["verb", "ok"]);
  assert.equal(r.candidates.find((c) => c.id === "verb")?.matches, 45);
  assert.equal(r.matches, 45);
});

test("fix label: a project writing both fix(…) and düzeltme: gets one pattern covering both, diacritics optional", () => {
  // Mostly conventional-looking Turkish types; the repairs are spread over two labels.
  const subjects = many(40, (i) =>
    i === 0 ? "fix(grafik): eksen 1970 diyordu" : i < 3 ? `düzeltme: komisyon okunmuyordu ${i}` : i === 3 ? "duzeltme: kayit cift yaziliyordu" : `kapi: olcum ${i}`,
  );
  const r = proposeFixSubject(subjects);
  // conventional and verb match the same one subject here, so the narrower conventional stays.
  assert.deepEqual([r.pick, r.reason, r.matches], ["conventional+turkish", "ok", 4]);
  const re = new RegExp(/** @type {string} */ (r.proposal));
  assert.deepEqual(subjects.filter((s) => re.test(s)).length, 4);
  assert.ok(!re.test("kapi: olcum 9") && !re.test("yol haritasi: ilerleme duzeltildi"));
  // Neither label alone is a majority; together they are, and that is what the rework rate would count.
  const both = proposeFixSubject(many(40, (i) => (i < 12 ? `fix: a${i}` : i < 24 ? `düzeltme: b${i}` : `feat: c${i}`)));
  assert.deepEqual([both.reason, both.matches], ["majority", 24]);
});

test("fix label: a mention inside a subject is weak, never proposed; 'bugün' is not 'bug'", () => {
  const subjects = many(40, (i) => (i % 5 ? `Antrenman bugün tekrarlanabiliyor ${i}` : i % 2 ? `Kapı geri alınınca fix'i çalışıyor ${i}` : `Liste boştu, sayaç düzeltildi ${i}`));
  const r = proposeFixSubject(subjects);
  assert.deepEqual([r.reason, r.pick, r.proposal], ["weak", "mention", null]);
  assert.equal(r.candidates.find((c) => c.id === "mention")?.matches, 8);
  const none = proposeFixSubject(many(40, (i) => `Antrenman bugün tekrarlanabiliyor ${i}`));
  assert.equal(none.reason, "none");
});

test("churn: often rewritten production paths are listed; lockfiles, tests and rare paths are not", () => {
  const r = repo();
  for (let i = 0; i < MIN_HISTORY + 2; i++) {
    /** @type {Record<string, string>} */
    const files = {
      "public/out.html": `<!-- @generated by build -->\n<p>${i}</p>\n`,
      'public/a "q".js': `// @generated\nexport const v = ${i};\n`,
      "package-lock.json": `{"v":${i}}`,
      "src/a.test.js": `// ${i}\n`,
    };
    if (i % 8 === 0) files["src/app.js"] = `export const v = ${i};\n`;
    r.commit(`feat: step ${i}`, files);
  }
  const res = churnPaths(recentCommits(r.dir), r.dir, pat());
  assert.equal(res.commits, MIN_HISTORY + 2);
  assert.deepEqual(res.paths.map((p) => p.path), ['public/a "q".js', "public/out.html"]);
  assert.ok(res.paths.every((p) => p.generatedMarker), "a quoted name is read raw, so its file is found");
  // The exclusion alternative matches exactly its own path.
  const only = new RegExp(res.paths[1].excludePattern);
  assert.deepEqual(["public/out.html", "public/outxhtml", "x/public/out.html"].map((p) => only.test(p)), [true, false, false]);
  assert.ok(new RegExp(res.paths[0].excludePattern).test('public/a "q".js'));
  const short = repo();
  short.commit("feat: one", { "public/out.html": "x" });
  assert.deepEqual(churnPaths(recentCommits(short.dir), short.dir, pat()).paths, []);
});

test("fix label: measured over commits touching production code, as the rework rate counts them", async () => {
  const r = repo();
  put(r.dir, { ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a" }] }) });
  for (let i = 0; i < MIN_HISTORY + 2; i++) {
    r.commit(`fix: repair ${i}`, { "src/a.js": `export const v = ${i};\n` });
    r.commit(`docs: note ${i}`, { "README.md": `# ${i}\n` });
  }
  const commits = recentCommits(r.dir);
  assert.equal(commits.length, 2 * (MIN_HISTORY + 2));
  assert.equal(productionSubjects(commits, pat()).length, MIN_HISTORY + 2);
  const scan = scanProject({ cwd: r.dir, env: {} });
  assert.deepEqual([scan.fixSubject.reason, scan.fixSubject.commits], ["majority", MIN_HISTORY + 2]);
  const res = await checkSetup({ cwd: r.dir, env: {} });
  assert.ok(res.items.some((i) => i.key === "doctor.fixMajority"));
});

test("tests: layouts the default testRe misses are proposed, and the proposal matches them", () => {
  const files = ["tests/test_api.py", "src/api.py", "pkg/x_test.go", "src/b.test.ts", "app/LoginTests.swift", "lib/user_spec.rb", "spec/fooSpec.js"];
  const testRe = DEFAULTS.metrics.testRe;
  const res = testLayout(files, testRe);
  assert.equal(res.matched, 1);
  assert.deepEqual(res.alternatives.map((a) => a.id), ["testDir", "suffix", "pytest", "className"]);
  const re = new RegExp(/** @type {string} */ (res.proposal));
  assert.deepEqual(files.filter((f) => !re.test(f)), ["src/api.py"]);
  assert.equal(testLayout(["src/b.test.ts", "src/a.ts"], testRe).proposal, null);
  // Production names that end like a test class stay production in JS/TS.
  assert.equal(testLayout(["src/k8s/JobSpec.ts", "src/api/OpenApiSpec.ts", "src/ab/AbTest.ts"], testRe).proposal, null);
});

test("risky paths: top-most matching directory, or the file in a flat layout; whole names only, tests and docs left out", () => {
  const files = [
    "src/auth/login.ts",
    "src/auth/deep/token.ts",
    "server/migrations/001.sql",
    "src/authors/list.ts",
    "test/auth/login.test.ts",
    "docs/security/model.md",
    "README.md",
    "app/security.py",
    "app/routers/auth.py",
    "app/ledger.py",
    "app/authors.py",
    "app/riskless.py",
  ];
  assert.deepEqual(riskyPaths(files, pat()), [
    { path: "app/ledger.py", files: 1, glob: "app/ledger.py" },
    { path: "app/routers/auth.py", files: 1, glob: "app/routers/auth.py" },
    { path: "app/security.py", files: 1, glob: "app/security.py" },
    { path: "server/migrations", files: 1, glob: "server/migrations/**" },
    { path: "src/auth", files: 2, glob: "src/auth/**" },
  ]);
});

test("work sources: checkbox counts; a roadmap split into a directory counts; archives and unrelated files are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-road-"));
  put(dir, { "ROADMAP.md": "# Plan\n- [ ] a\n  - [x] b\n* [ ] c\n- plain\n", "docs/backlog.md": "one\ntwo\n", "docs/roadmap/phase-2.md": "- [ ] x\n- [x] y\n- [x] z\n" });
  const files = ["ROADMAP.md", "docs/backlog.md", "docs/roadmap/phase-2.md", "docs/archive/roadmap-old.md", "docs/roadmap/archive/phase-0.md", "src/plan.ts", "NOTES.md"];
  assert.deepEqual(roadmapFiles(dir, files), [
    { path: "ROADMAP.md", open: 2, done: 1, lines: 6 },
    { path: "docs/backlog.md", open: 0, done: 0, lines: 3 },
    { path: "docs/roadmap/phase-2.md", open: 1, done: 2, lines: 4 },
  ]);
});

test("commands: entry points and fast variants only; mutation from a stryker script or go/cargo markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-cmd-"));
  const scripts = { test: "node --test", "test:watch": "x", "validate:fast": "x", lint: "x", "check:foo": "x", mut: "stryker run" };
  put(dir, { "package.json": JSON.stringify({ scripts }), "go.mod": "module x\n", "scripts/validate.sh": "#!/bin/sh\n" });
  assert.deepEqual(projectCommands(dir), {
    commands: ["npm run lint", "npm test", "npm run validate:fast", "./scripts/validate.sh", "go test ./..."],
    mutation: "npm run mut",
    unreadable: [],
    unmeasured: {},
    outside: [],
  });
  // One that does not parse declares what is unknown, which is said; npm skips a byte order mark, and so does the scan.
  const empty = mkdtempSync(join(tmpdir(), "en-cmd0-"));
  put(empty, { "package.json": "{ broken" });
  assert.deepEqual(projectCommands(empty), { commands: [], mutation: null, unreadable: ["package.json"], unmeasured: { commands: [{ path: "package.json", reason: "notJson" }], mutation: [{ path: "package.json", reason: "notJson" }] }, outside: [] });
  // What the other files declare is still known (the review's case): only package.json's part is unmeasured.
  put(empty, { Makefile: "test:\n\ttrue\n", "go.mod": "module x\n", "stryker.conf.json": "{}" });
  assert.deepEqual(projectCommands(empty), { commands: ["make test", "go test ./..."], mutation: "npx stryker run", unreadable: ["package.json"], unmeasured: { commands: [{ path: "package.json", reason: "notJson" }] }, outside: [] });
  // A stryker script whose name npm would take for an option, or no shell could pass, names no command.
  const dash = mkdtempSync(join(tmpdir(), "en-cmd-dash-"));
  put(dash, { "package.json": JSON.stringify({ scripts: { "--prefix=/elsewhere": "stryker run" } }) });
  assert.equal(projectCommands(dash).mutation, null);
  assert.deepEqual(projectCommands(dash).unmeasured.mutation, [{ path: "package.json", reason: "scriptName", name: "--prefix=/elsewhere" }]);
  // A script name the shell would read as more than one word is quoted: `mutate; touch x` is one name.
  const shell = mkdtempSync(join(tmpdir(), "en-cmd-shell-"));
  put(shell, { "package.json": JSON.stringify({ scripts: { "mutate; touch x": "stryker run" } }) });
  assert.equal(projectCommands(shell).mutation, "npm run 'mutate; touch x'");
  put(shell, { "package.json": JSON.stringify({ scripts: { "it's": "stryker run" } }) });
  assert.equal(projectCommands(shell).mutation, "npm run 'it'\\''s'");
  put(shell, { "package.json": JSON.stringify({ scripts: { "test:mutation": "stryker run" } }) });
  assert.equal(projectCommands(shell).mutation, "npm run test:mutation");
  // Scripts as a list are no scripts: `["stryker run"]` named no `npm run 0`.
  const list = mkdtempSync(join(tmpdir(), "en-cmd-list-"));
  put(list, { "package.json": JSON.stringify({ scripts: ["stryker run", "test"] }) });
  assert.deepEqual(projectCommands(list), { commands: [], mutation: null, unreadable: [], unmeasured: {}, outside: [] });
  const blank = mkdtempSync(join(tmpdir(), "en-cmd-blank-"));
  put(blank, { "package.json": "" });
  assert.deepEqual(projectCommands(blank).unreadable, ["package.json"], "an empty package.json does not parse either");
  const bom = mkdtempSync(join(tmpdir(), "en-cmd-bom-"));
  put(bom, { "package.json": "\uFEFF" + JSON.stringify({ scripts: { test: "node --test" } }) });
  assert.deepEqual(projectCommands(bom), { commands: ["npm test"], mutation: null, unreadable: [], unmeasured: {}, outside: [] });
});

test("scan: outside a repository and with a broken config it reports, it does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-norepo-"));
  put(dir, { ".ennyn/config.json": JSON.stringify({ colour: "red" }) });
  const res = scanProject({ cwd: dir, env: {} });
  assert.equal(res.repository, false);
  assert.match(res.config.problems.join(), /unknown key "colour"/);
  assert.equal(res.config.loaded, false, "the values below are defaults, not the project's");
  assert.equal(res.fixSubject.reason, "tooFew");
  assert.equal(res.graph.exists, false);
  // A pattern that does not compile is a problem in the report; the default stands in.
  put(dir, { ".ennyn/config.json": JSON.stringify({ metrics: { excludeRe: "(^docs/" } }) });
  const bad = scanProject({ cwd: dir, env: {} });
  assert.match(bad.config.problems.join(), /"metrics\.excludeRe" is not a valid regular expression/);
  assert.equal(bad.metrics.excludeRe, DEFAULTS.metrics.excludeRe);
  assert.equal(bad.config.loaded, true, "the config loaded; only one pattern was replaced");
  put(dir, { ".ennyn/config.json": "null" });
  assert.match(scanProject({ cwd: dir, env: {} }).config.problems.join(), /must hold a JSON object/);
});

/** @param {Record<string, unknown>} config @param {unknown} graph */
function setup(config, graph) {
  const r = repo();
  put(r.dir, { ".ennyn/config.json": JSON.stringify(config), ...(graph === undefined ? {} : { ".ennyn/graph.json": JSON.stringify(graph) }) });
  r.commit("feat: setup");
  return r;
}

/** @param {Awaited<ReturnType<typeof checkSetup>>} res */
const keys = (res) => res.items.map((i) => `${i.level} ${i.key}`);

test("doctor: a valid setup passes and counts ready nodes", async () => {
  const graph = {
    nodes: [
      { id: "a", status: "planned", value: "high", cost: "S" },
      { id: "b", status: "planned", needs: ["a"] },
      { id: "m", status: "planned", mechanization: true, needs: "d" },
      { id: "g", status: "planned", gate: "waiting" },
    ],
    done: [{ id: "d", status: "done" }],
  };
  const r = setup({ language: "tr" }, graph);
  const res = await checkSetup({ cwd: r.dir, env: {} });
  assert.equal(res.ok, true, keys(res).join("\n"));
  assert.equal(res.language, "tr");
  const ready = res.items.find((i) => i.key === "doctor.ready");
  assert.deepEqual(ready?.vars, { core: 1, mech: 1 });
  assert.ok(keys(res).includes("unmeasured doctor.fixTooFew"), "too few commits to judge is no verdict");
});

test("doctor: bad regex, missing id, duplicate id and unknown need fail; nothing ready warns", async () => {
  const graph = {
    nodes: [{ id: "a", needs: ["ghost"] }, { id: "a", gate: "later" }, { title: "no id", gate: "later" }, { id: "c", gate: "later" }],
    done: [],
  };
  const r = setup({ metrics: { fixSubject: "fix(" } }, graph);
  const res = await checkSetup({ cwd: r.dir, env: {} });
  assert.equal(res.ok, false);
  const k = keys(res);
  for (const want of ["fail doctor.regexBad", "fail doctor.idMissing", "fail doctor.idDuplicate", "fail doctor.needsUnknown", "warn doctor.readyNone"]) {
    assert.ok(k.includes(want), `${want} in\n${k.join("\n")}`);
  }
  assert.ok(!k.some((x) => x.includes("doctor.fix")), "no fix-label check with a broken pattern");
});

test("doctor: a handoff reached through a symbolic link fails, its bytes in no line; none there, or a regular one, is fine (skill-reads-linked-handoff)", async () => {
  const away = mkdtempSync(join(tmpdir(), "pl-doc-away-"));
  writeFileSync(join(away, "profile"), "SECRET-TOKEN-BYTES\n");
  const graph = JSON.stringify({ nodes: [{ id: "a", mechanization: true }], done: [] });
  for (const [handoff, link] of [["HANDOFF.md", "HANDOFF.md"], [".ennyn/handoff.md", ".ennyn"], [".ennyn/handoff.md", null], ["HANDOFF.md", null]]) {
    const dir = mkdtempSync(join(tmpdir(), "pl-doc-handoff-"));
    put(dir, { "cfg/config.json": JSON.stringify({ paths: { handoff, graph: "cfg/graph.json" } }), "cfg/graph.json": graph });
    if (link === "HANDOFF.md") symlinkSync(join(away, "profile"), join(dir, "HANDOFF.md"));
    if (link === ".ennyn") {
      writeFileSync(join(away, "handoff.md"), "SECRET-TOKEN-BYTES\n");
      symlinkSync(away, join(dir, ".ennyn"));
    }
    if (!link && handoff === "HANDOFF.md") writeFileSync(join(dir, "HANDOFF.md"), "# handoff\n");
    const res = await checkSetup({ cwd: dir, env: { ENNYN_CONFIG: "cfg/config.json" } });
    const bad = res.items.filter((i) => i.key === "doctor.handoffBad");
    if (link) {
      assert.equal(res.ok, false, handoff);
      assert.match(String(bad[0]?.vars.error), new RegExp(`could not be read: ${link.replace(".", "\\.")} is a symbolic link$`), handoff);
      assert.doesNotMatch(JSON.stringify(res.items), /SECRET/);
    } else assert.deepEqual(bad, [], `${handoff}: none there or a regular file`);
  }
});

test("doctor audit: outside a repository the git checks are skipped and the fix label says unmeasured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-doc-out-"));
  put(dir, { ".ennyn/config.json": "{}", ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a", mechanization: true }], done: [] }) });
  const res = await checkSetup({ cwd: dir, env: {} });
  const k = keys(res);
  assert.ok(k.includes("unmeasured doctor.fixNoRepo"), k.join("\n"));
  assert.ok(k.includes("ok doctor.ready"));
  assert.ok(!k.some((x) => /doctor\.(fixTooFew|fixOk|fixNone|hook|budget)/.test(x)), "no git-based verdict outside a repository");
});

test("doctor: a missing graph and a broken config fail; a fix-label majority warns", async () => {
  const noGraph = setup({}, undefined);
  assert.ok(keys(await checkSetup({ cwd: noGraph.dir, env: {} })).includes("fail doctor.graphBad"));
  const badCfg = setup({ review: { maxRounds: "two" } }, { nodes: [] });
  const bad = await checkSetup({ cwd: badCfg.dir, env: {} });
  // The git version needs no config; nothing after the config is checked without one.
  assert.deepEqual(keys(bad), ["ok doctor.gitOk", "fail doctor.configBad"]);
  const r = setup({}, { nodes: [{ id: "a" }] });
  for (let i = 0; i < MIN_HISTORY; i++) r.commit(i % 3 ? `fix: repair ${i}` : `feat: add ${i}`, { "src/a.js": `export const v = ${i};\n` });
  assert.ok(keys(await checkSetup({ cwd: r.dir, env: {} })).includes("warn doctor.fixMajority"));
});

test("doctor: a null node or a module graph that does not load is a ✗ line, not a crash", async () => {
  const nullNode = setup({}, { nodes: [{ id: "a" }, null] });
  const res = await checkSetup({ cwd: nullNode.dir, env: {} });
  assert.deepEqual(keys(res).filter((k) => k.startsWith("fail")), ["fail doctor.graphBad"]);
  assert.match(String(res.items.find((i) => i.key === "doctor.graphBad")?.vars.error), /"nodes"\[1\] is not an object/);
  const broken = setup({ paths: { graph: ".ennyn/graph.mjs" } }, undefined);
  put(broken.dir, { ".ennyn/graph.mjs": "export const nodes = [\n" });
  const mod = await checkSetup({ cwd: broken.dir, env: {} });
  assert.match(String(mod.items.find((i) => i.key === "doctor.graphBad")?.vars.error), /cannot load .*graph\.mjs/);
});

test("git floor: versions as git words them parse, and compare part by part", () => {
  // Accept: what git, Apple's build, Git for Windows and a release candidate print, and a bare "X.Y".
  for (const [text, want] of /** @type {const} */ ([
    ["git version 2.34.1", [2, 34, 1]],
    ["git version 2.39.5 (Apple Git-154)", [2, 39, 5]],
    ["git version 2.45.1.windows.1", [2, 45, 1]],
    ["git version 2.34.0.rc1", [2, 34, 0]],
    ["git version 2.100.0\n", [2, 100, 0]],
    ["2.34", [2, 34, 0]],
  ])) assert.deepEqual(parseVersion(text), want, text);
  // Reject: no version where git puts it.
  for (const text of ["", "git version", "hub version 2.14.2", "git version two", "version 2", "git version 2"]) assert.equal(parseVersion(text), null, text);
  const floor = /** @type {number[]} */ (parseVersion(GIT_FLOOR));
  assert.deepEqual(floor, [2, 34, 0]);
  for (const v of ["2.34.0", "2.34.1", "2.35.0", "2.100.0", "3.0.0"]) assert.ok(versionAtLeast(/** @type {number[]} */ (parseVersion(v)), floor), v);
  for (const v of ["2.33.8", "2.30.2", "2.4.0", "1.99.99"]) assert.ok(!versionAtLeast(/** @type {number[]} */ (parseVersion(v)), floor), v);
});

test("doctor: a git older than the floor fails, one that says no version warns, the floor itself passes", () => {
  const r = setup({}, { nodes: [{ id: "a" }] });
  // A git that answers --version with the given text and runs the real git for everything else.
  const realGit = join(git(["--exec-path"], { cwd: r.dir }), "git");
  const doctor = (/** @type {string} */ said) => {
    const bin = mkdtempSync(join(tmpdir(), "en-gitv-"));
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --version ] && { printf '%s\\n' '${said}'; exit 0; }; done\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    return spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  };
  const old = doctor("git version 2.30.2");
  assert.equal(old.status, 1, old.stdout + old.stderr);
  assert.match(old.stdout, /^✗ git: 2\.30\.2 is older than 2\.34, the oldest git Ennyn's tests run on/m);
  const unknown = doctor("hub version 2.14.2");
  assert.equal(unknown.status, 0, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout, /^! git: no version in "hub version 2\.14\.2"; Ennyn's tests run on git 2\.34 and later$/m);
  // Only git's own words: a bare number is another program's.
  assert.match(doctor("2.30.2").stdout, /^! git: no version in "2\.30\.2"/m);
  const floor = doctor("git version 2.34.1");
  assert.equal(floor.status, 0, floor.stdout + floor.stderr);
  assert.match(floor.stdout, /^✓ git: 2\.34\.1$/m);
});

test("cli: init-scan --json is the scan; doctor prints marks and exits 1 on a problem", () => {
  const r = setup({}, { nodes: [{ id: "a" }, { id: "a" }] });
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, encoding: "utf8" });
  const scan = run("init-scan", "--json");
  assert.equal(scan.status, 0, scan.stderr);
  const json = JSON.parse(scan.stdout);
  assert.equal(json.repository, true);
  assert.equal(json.graph.exists, true);
  assert.equal(json.fixSubject.reason, "tooFew");
  const human = run("init-scan");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^Config: .*config\.json$/m);
  const doc = run("doctor");
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /^✗ work graph: duplicate ids: a$/m);
  // security.secrets is on by default, and only the hook checks it: with no hook, the one warning.
  assert.match(doc.stdout, /^! commit-msg hook: none, so these are rules on paper: security\.secrets; run ennyn install-hook$/m);
  assert.match(doc.stdout, /^problems: 1 · warnings: 1 · unmeasured: 1$/m, "the one unmeasured: too few commits for the fix label");
});

test("commit style: language guessed from subjects, also Turkish typed without diacritics; types counted, 'faz 8:' is not one", () => {
  const tr = commitStyle([
    "fix(grafik): mum zamani iki kez bolunuyordu, eksen 1970 diyordu",
    "faz 8: fren artik dugme",
    "devir: HANDOFF guncel",
    "devir: ara kayit ve yeni not",
    "düzeltme: komisyon okunmuyor",
    "kapi: islem tablosuna sekiz olcum",
    "denetim: bulgu yok, kapi icin olcum",
    "temizlik: olu oznitelik artik yok",
  ]);
  assert.deepEqual([tr.language.guess, tr.language.tr, tr.language.en], ["tr", 5, 0]);
  assert.deepEqual(tr.types.slice(0, 2), [{ type: "devir", n: 2 }, { type: "denetim", n: 1 }]);
  assert.ok(!tr.types.some((t) => t.type.startsWith("faz")));
  const en = commitStyle(["feat: add the parser", "fix: crash when the list is empty", "docs: note on config", "Add a page for users", "Fix the build"]);
  assert.deepEqual([en.language.guess, en.typedShare], ["en", 0.6]);
  assert.equal(commitStyle(["feat: x", "fix: y"]).language.guess, null, "too few readable subjects to guess");
});

test("doctor: declared commit types are reported; a fix label that misses the fix type warns", async () => {
  const types = { types: ["özellik", "düzeltme"], fixType: "düzeltme" };
  const misses = setup({ language: "tr", commitMsg: types }, { nodes: [{ id: "a" }] });
  const res = await checkSetup({ cwd: misses.dir, env: {} });
  assert.deepEqual(res.items.find((i) => i.key === "doctor.commitStyle")?.vars, { language: "tr", types: "özellik, düzeltme", type: "düzeltme" });
  assert.ok(keys(res).includes("warn doctor.fixTypeUnseen"));
  const sees = setup({ language: "tr", commitMsg: { ...types, language: "en" }, metrics: { fixSubject: "^düzeltme(\\(|:)" } }, { nodes: [{ id: "a" }] });
  const ok = await checkSetup({ cwd: sees.dir, env: {} });
  assert.ok(!keys(ok).includes("warn doctor.fixTypeUnseen"));
  assert.equal(ok.items.find((i) => i.key === "doctor.commitStyle")?.vars.language, "en", "commit language overrides the report language");
  const free = await checkSetup({ cwd: setup({}, { nodes: [{ id: "a" }] }).dir, env: {} });
  assert.ok(keys(free).includes("ok doctor.commitStyleFree"));
});

test("agent setup: cycle-like skills and reviewer agents by name, on a corpus of real names (accept and reject)", async () => {
  const { CYCLE_SKILL, REVIEWER } = await import("../setup/scan.mjs");
  const cycleYes = ["phase-run", "cycle", "faz-dongusu", "döngü", "sprint-plan", "dev-loop"];
  const cycleNo = ["strateji-ekle", "swiftui-engineering", "mobil-dogrulama", "hata-sonrasi", "post-fix", "phaser-game", "fazla", "loophole-scan", "codebase-design"];
  for (const n of cycleYes) assert.ok(CYCLE_SKILL.test(n), `cycle: ${n}`);
  for (const n of cycleNo) assert.ok(!CYCLE_SKILL.test(n), `not cycle: ${n}`);
  const reviewYes = ["code-reviewer", "security-reviewer", "kod-gozden-gecirici", "para-guvenligi-denetcisi", "mobil-ux-denetçisi", "data-correctness-checker", "api-contract-validator", "pentester", "nlq-prompt-auditor", "migration-checker", "veri-dogrulayici", "inceleme-ajani", "security-audit", "spec-verifier", "design-critic"];
  const reviewNo = ["planlayici", "planner", "architect", "debugger", "doc-updater", "e2e-runner", "refactor-cleaner", "marketing-strategist", "error-tracker", "preview-builder"];
  for (const n of reviewYes) assert.ok(REVIEWER.test(n), `reviewer: ${n}`);
  for (const n of reviewNo) assert.ok(!REVIEWER.test(n), `not reviewer: ${n}`);
});

test("agent setup: every instruction and rule file with size, load kind and commit-rule lines; skills, agents, commands, hooks, MCP", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-agents-"));
  const claude = "# Rules\nLanguage: Turkish in chat, commit and docs\n7. Sweep: fix every copy in the same commit\nnothing else\n- **Commit:** one line, Turkish\n9. COMMIT → one commit, Turkish subject\n";
  put(dir, {
    "CLAUDE.md": claude,
    "CLAUDE.local.md": "local notes\n",
    "server/CLAUDE.md": "await client.query('COMMIT') after the update\n",
    "AGENTS.md": "Commit messages in English\n",
    ".claude/rules/common/protocol.md": "9. COMMIT → TEK commit, Türkçe konu\n",
    ".claude/rules/web/ui.md": "---\npaths:\n  - src/ui/**\n---\nui rule\n",
    ".claude/skills/phase-run/SKILL.md": "---\nname: phase-run\n---\n",
    ".claude/skills/strateji-ekle/SKILL.md": "---\nname: strateji-ekle\n---\n",
    ".claude/skills/not-a-skill/README.md": "no SKILL.md here\n",
    ".claude/agents/kod-gozden-gecirici.md": "x",
    ".claude/agents/planlayici.md": "x",
    ".claude/commands/devir.md": "x",
    ".claude/commands/team/audit-cycle.md": "x",
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "y" }] }] } }),
    ".claude/settings.local.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "z" }] }] } }),
    ".mcp.json": "{ broken",
  });
  // Nested instruction files come from the tracked list; everything under .claude is read from disk.
  const res = agentSetup(dir, ["CLAUDE.md", "server/CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(res.instructions.map((i) => [i.path, i.loads, i.commitLines]), [
    // A line that is a commit rule comes before one that names commits among other things, whatever the order in the file.
    ["CLAUDE.md", "always", ["- **Commit:** one line, Turkish", "9. COMMIT → one commit, Turkish subject", "Language: Turkish in chat, commit and docs"]],
    ["CLAUDE.local.md", "always", []],
    [".claude/rules/common/protocol.md", "always", ["9. COMMIT → TEK commit, Türkçe konu"]],
    [".claude/rules/web/ui.md", "on-demand", []],
    ["server/CLAUDE.md", "on-demand", []],
    ["AGENTS.md", "other", ["Commit messages in English"]],
  ]);
  const bytes = (/** @type {string} */ t) => Buffer.byteLength(t);
  assert.deepEqual(res.size, {
    always: bytes(claude) + bytes("local notes\n") + bytes("9. COMMIT → TEK commit, Türkçe konu\n"),
    onDemand: bytes("---\npaths:\n  - src/ui/**\n---\nui rule\n") + bytes("await client.query('COMMIT') after the update\n"),
    other: bytes("Commit messages in English\n"),
  });
  assert.deepEqual([res.skills, res.agents, res.commands], [["phase-run", "strateji-ekle"], ["kod-gozden-gecirici", "planlayici"], ["devir", "team/audit-cycle"]]);
  assert.deepEqual([res.hooks, res.mcpServers, res.unreadable], [["PreToolUse", "SessionStart", "Stop"], [], [".mcp.json"]]);
  assert.deepEqual(res.overlaps, { cycle: ["phase-run", "/team/audit-cycle"], reviewers: ["kod-gozden-gecirici"] });
  // Valid JSON that is not an object is no settings file either.
  const arr = mkdtempSync(join(tmpdir(), "en-agents-arr-"));
  put(arr, { ".claude/settings.json": "[]" });
  assert.deepEqual(agentSetup(arr, []).unreadable, [".claude/settings.json"]);
  // Nothing there: empty lists, not errors.
  const empty = agentSetup(mkdtempSync(join(tmpdir(), "en-agents0-")), []);
  assert.deepEqual([empty.instructions, empty.skills, empty.hooks, empty.unreadable, empty.size], [[], [], [], [], { always: 0, onDemand: 0, other: 0 }]);
});

test("agent setup: linked skills and agents count; a decomposed (NFD) name is matched as written", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  // Linked from inside the repository: counted. Linked out of it: named, not read.
  const dir = mkdtempSync(join(tmpdir(), "en-agents-ln-"));
  put(dir, { "shared/cycle/SKILL.md": "x", "shared/code-reviewer.md": "x" });
  mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  symlinkSync(join(dir, "shared", "cycle"), join(dir, ".claude", "skills", "cycle"));
  symlinkSync(join(dir, "shared", "code-reviewer.md"), join(dir, ".claude", "agents", "code-reviewer.md"));
  put(dir, { [".claude/skills/" + "faz-döngü".normalize("NFD") + "/SKILL.md"]: "x" });
  const store = mkdtempSync(join(tmpdir(), "en-agents-store-"));
  put(store, { "loop/SKILL.md": "x", "security-reviewer.md": "x" });
  symlinkSync(join(store, "loop"), join(dir, ".claude", "skills", "loop"));
  symlinkSync(join(store, "security-reviewer.md"), join(dir, ".claude", "agents", "security-reviewer.md"));
  const res = agentSetup(dir, []);
  assert.deepEqual(res.skills, ["cycle", "faz-döngü"].sort());
  assert.deepEqual(res.agents, ["code-reviewer"]);
  assert.deepEqual(res.overlaps.cycle.sort(), ["cycle", "faz-döngü"].sort());
  assert.deepEqual(res.outside, [".claude/agents/security-reviewer.md", ".claude/skills/loop"]);
});

test("cli: init-scan prints the agent setup: sizes by load kind, the commit rule line and the overlaps", () => {
  const r = setup({}, { nodes: [{ id: "a" }] });
  put(r.dir, { "CLAUDE.md": "Commit: one line\n", ".claude/agents/code-reviewer.md": "x", ".claude/skills/phase-run/SKILL.md": "x" });
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Agent instructions: 0\.0 KB in every session \(CLAUDE\.md 0\.0 KB\), 0\.0 KB when a matching path is touched, 0\.0 KB for other agents\.$/m);
  assert.match(out.stdout, /^ {2}commit rule in CLAUDE\.md: "Commit: one line"$/m);
  assert.match(out.stdout, /^Overlaps with Ennyn: cycle-like skill or command phase-run; reviewer agents code-reviewer\.$/m);
});

test("agent setup: a real rule beats step headings that only start with commit; SQL is not a rule; nested and linked rule directories are read", async () => {
  const { commitRuleLines, agentSetup } = await import("../setup/scan.mjs");
  const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Commit öncesi adım ${i + 1}`);
  const lines = commitRuleLines([...steps, "- İngilizce commit mesajı YASAK (Türkçe)", "BEGIN; UPDATE t SET a = 1; COMMIT;", "COMMIT;"].join("\n"));
  assert.equal(lines[0], "- İngilizce commit mesajı YASAK (Türkçe)");
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((l) => /COMMIT;/.test(l)), "SQL left out");
  // On their own, too: no cap hides them here.
  assert.deepEqual(commitRuleLines("COMMIT;\nBEGIN; UPDATE t SET a = 1; COMMIT;\nROLLBACK the commit if the check fails"), []);
  // A linked directory inside the repository is read; one whose real path leaves it is named, not read.
  const dir = mkdtempSync(join(tmpdir(), "en-rules-ln-"));
  put(dir, { ".claude/rules/a/b/c.md": "plain rule\n", "shared/deep/more/commit.md": "Commit: one line\n" });
  symlinkSync(join(dir, "shared"), join(dir, ".claude", "rules", "linked"));
  const store = mkdtempSync(join(tmpdir(), "en-rules-store-"));
  put(store, { "elsewhere.md": "Commit: never read\n" });
  symlinkSync(store, join(dir, ".claude", "rules", "outside"));
  const res = agentSetup(dir, []);
  assert.deepEqual(res.instructions.map((i) => i.path), [".claude/rules/a/b/c.md", ".claude/rules/linked/deep/more/commit.md"]);
  assert.deepEqual(res.outside, [".claude/rules/outside"]);
});

test("cli: init-scan shows at most two commit-rule lines per file and says how many more --json has", () => {
  const r = setup({}, { nodes: [{ id: "a" }] });
  put(r.dir, {
    "CLAUDE.md": "Commit: one line\nCommit language: Turkish\nCommit: no co-author trailer\n",
    ".claude/rules/protocol.md": "9. COMMIT → one commit, Turkish subject\n",
  });
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.deepEqual(out.match(/^ {2}commit rule in .*$/gm), [
    '  commit rule in CLAUDE.md: "Commit: one line"',
    '  commit rule in CLAUDE.md: "Commit language: Turkish"',
    '  commit rule in .claude/rules/protocol.md: "9. COMMIT → one commit, Turkish subject"',
  ]);
  assert.match(out, /^ {2}…and 1 more commit-rule lines \(init-scan --json lists them all\)$/m);
});

test("doctor: a cochange glob that matches no tracked file warns (a typo would leave the rule silent)", async () => {
  const cochange = [
    { paths: ["src/**"], docs: ["README.md"] },
    { paths: ["scr/**", "src/*.js"], docs: ["DESIGN.md", "docs/**"] },
  ];
  const r = setup({ review: { cochange } }, { nodes: [{ id: "a" }] });
  r.commit("feat: files", { "src/a.js": "x", "README.md": "# x" });
  const res = await checkSetup({ cwd: r.dir, env: {} });
  const found = res.items.filter((i) => i.key === "doctor.cochangeUnmatched");
  assert.deepEqual(found.map((i) => [i.level, i.vars]), [["warn", { rule: 2, globs: ["scr/**", "DESIGN.md", "docs/**"] }]]);
  assert.match(t("doctor.cochangeUnmatched", found[0].vars, "en"), /^review\.cochange rule 2: scr\/\*\*, DESIGN\.md, docs\/\*\* match no tracked file/);
  const fine = await checkSetup({ cwd: setup({ review: { cochange: [{ paths: [".ennyn/*.json"], docs: [".ennyn/graph.json"] }] } }, { nodes: [{ id: "a" }] }).dir, env: {} });
  assert.ok(!keys(fine).includes("warn doctor.cochangeUnmatched"));
});

test("doctor: a cochange rule whose documents are all the files its paths name can never warn; no file list, no verdict", async () => {
  const r = setup({ review: { cochange: [{ paths: ["docs/**"], docs: ["docs/**"] }, { paths: ["src/**"], docs: ["README.md"] }] } }, { nodes: [{ id: "a" }] });
  r.commit("feat: files", { "docs/a.md": "x", "src/a.js": "x", "README.md": "# x" });
  const res = await checkSetup({ cwd: r.dir, env: {} });
  assert.deepEqual(res.items.filter((i) => i.key.startsWith("doctor.cochange")).map((i) => [i.level, i.key, i.vars]), [["warn", "doctor.cochangeSilent", { rule: 1 }]]);
  // Nothing tracked yet: no verdict on the globs.
  const empty = repo();
  put(empty.dir, { ".ennyn/config.json": JSON.stringify({ review: { cochange: [{ paths: ["src/**"], docs: ["README.md"] }] } }) });
  const none = await checkSetup({ cwd: empty.dir, env: {} });
  assert.deepEqual(none.items.filter((i) => i.key.startsWith("doctor.cochange")), []);
});

test("scan audit (after review): a directory git lists (a submodule) is no unreadable file; one unreadable check leaves doctor's other lines", (t) => {
  const r = setup({ commitMsg: { types: ["feat", "fix"] } }, { nodes: [{ id: "a" }] });
  // A gitlink named like a roadmap file, changed often enough to be a churn path, with its directory checked out.
  mkdirSync(join(r.dir, "todo"));
  for (let i = 0; i < 4; i++) {
    git(["update-index", "--add", "--cacheinfo", `160000,${String(i + 1).padStart(40, "a")},todo`], { cwd: r.dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `feat: todo ${i}`], { cwd: r.dir });
  }
  const scan = scanProject({ cwd: r.dir, env: {} });
  // Nothing read there, which is said (`absent`): a submodule's directory is no roadmap with zero lines.
  assert.deepEqual(scan.roadmap.find((f) => f.path === "todo"), { path: "todo", absent: true, open: 0, done: 0, lines: 0 });
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const run = () => spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, encoding: "utf8" });
  // A hook that is there but cannot be read is no missing hook.
  assert.equal(spawnSync(process.execPath, [CLI, "install-hook"], { cwd: r.dir, encoding: "utf8" }).status, 0);
  const hook = join(r.dir, ".git", "hooks", "commit-msg");
  chmodSync(hook, 0o000);
  try {
    const out = run().stdout;
    assert.match(out, /^\? commit-msg hook: unmeasured: .*commit-msg could not be read: EACCES/m);
    assert.match(out, /^problems: 0 · warnings: \d+ · unmeasured: 2$/m, "the hook, and the fix label with too few commits");
    assert.doesNotMatch(out, /hook: none/);
  } finally {
    chmodSync(hook, 0o755);
  }
  // A .claude directory that cannot be listed: the budget is unmeasured, every other line is still there.
  mkdirSync(join(r.dir, ".claude", "commands"), { recursive: true });
  chmodSync(join(r.dir, ".claude", "commands"), 0o000);
  try {
    const out = run().stdout;
    assert.match(out, /^\? instruction budget: unmeasured: .*EACCES/m);
    for (const line of [/^✓ git: /m, /^✓ config: /m, /^✓ work graph: /m, /^✓ commit-msg hook: /m]) assert.match(out, line);
  } finally {
    chmodSync(join(r.dir, ".claude", "commands"), 0o755);
  }
});

test("doctor audit: a metrics log it cannot read (a directory in its place, no permission) is said as unmeasured; the rest of the report stands", async (t) => {
  const r = setup({}, { nodes: [{ id: "a" }] });
  put(r.dir, { ".ennyn/metrics.jsonl": `${JSON.stringify({ kind: "budget", date: "2026-10-01", commit: "a".repeat(40), always: 1 })}\n` });
  /** @param {string[]} k */
  const after = (k) => k.slice(k.indexOf("unmeasured doctor.budgetLogUnmeasured") + 1);
  // paths.metricsLog naming a directory (an empty value resolves to the project directory itself).
  for (const metricsLog of ["", ".ennyn"]) {
    put(r.dir, { ".ennyn/config.json": JSON.stringify({ paths: { metricsLog } }) });
    const k = keys(await checkSetup({ cwd: r.dir, env: {} }));
    assert.ok(k.includes("unmeasured doctor.budgetLogUnmeasured"), `${JSON.stringify(metricsLog)}:\n${k.join("\n")}`);
    assert.ok(after(k).some((x) => x.includes("doctor.fix")), "the checks after it still run");
  }
  put(r.dir, { ".ennyn/config.json": "{}" });
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const log = join(r.dir, ".ennyn", "metrics.jsonl");
  chmodSync(log, 0o000);
  try {
    const res = await checkSetup({ cwd: r.dir, env: {} });
    const item = res.items.find((i) => i.key === "doctor.budgetLogUnmeasured");
    assert.match(String(item?.vars.error), /metrics\.jsonl could not be read: EACCES/);
    assert.match(t_(item), /could not be read/, "the line says the comparison was not made");
    const out = spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, encoding: "utf8" });
    assert.match(out.stdout, /^\? instruction budget: .*unmeasured/m);
    assert.match(out.stdout, /^\? fix label: \d+ commits, too few to judge$/m);
  } finally {
    chmodSync(log, 0o644);
  }
});

/** @param {{ key: string, vars: Record<string, string | number> } | undefined} item */
const t_ = (item) => (item ? t(item.key, item.vars, "en") : "");

test("doctor audit: tracked files or the recent history that git cannot list (past its buffer, or failing) are said as unmeasured; the rest stands", async () => {
  const r = setup({ review: { cochange: [{ paths: ["src/**"], docs: ["README.md"] }] } }, { nodes: [{ id: "a" }] });
  const bin = mkdtempSync(join(tmpdir(), "en-doc-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  /** @param {string} sub */
  const failing = (sub) => {
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${sub} "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    return spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: "utf8" });
  };
  const files = failing("ls-files");
  assert.match(files.stdout, /^\? tracked files: unmeasured \(.*injected.*\)/m, files.stdout + files.stderr);
  assert.match(files.stdout, /^\? fix label: \d+ commits, too few/m, "the fix label does not need the file list");
  assert.doesNotMatch(files.stdout, /instruction budget: [\d.]+ KB/, "no budget from no file list");
  const log = failing("log");
  assert.match(log.stdout, /^\? fix label: unmeasured: .*injected/m, log.stdout + log.stderr);
  assert.doesNotMatch(log.stdout, /^. fix label: \d/m, "no verdict from no history");
  assert.match(log.stdout, /^✓ instruction budget: /m);
  assert.match(log.stdout, / · unmeasured: 1$/m);
});

test("doctor audit: outside a repository the fix label is counted as unmeasured, not as a warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-doc-out2-"));
  put(dir, { ".ennyn/config.json": "{}", ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a" }] }) });
  assert.ok(keys(await checkSetup({ cwd: dir, env: {} })).includes("unmeasured doctor.fixNoRepo"));
  assert.match(t("doctor.fixNoRepo", {}, "tr"), /^fix etiketi: /, "one Turkish name for the fix label");
});

test("doctor audit: a file name with a line break or another control character stays on its line, quoted", async (t) => {
  if (process.platform === "win32") return t.skip("no such names on Windows");
  const spoof = "x\n✓ commit-msg hook: checks every message";
  const r = setup({ review: { forbidden: [{ text: "debugger", paths: ["**"] }] } }, { nodes: [{ id: "a" }] });
  const flipped = "a\u202eexe.js";
  r.commit("feat: names", { [spoof]: "debugger\n", "plain.js": "debugger\n", [flipped]: "debugger\n" });
  const out = spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.doesNotMatch(out, /^✓ commit-msg hook: checks every message$/m, out);
  const held = out.split("\n").find((l) => l.includes("review.forbidden rule 1"));
  assert.ok(held?.includes(JSON.stringify(spoof)) && held.includes("plain.js") && !held.includes('"plain.js"'), held);
  assert.ok(held.includes('"a\\u202eexe.js"') && !held.includes("\u202e"), "a direction mark is escaped, not shown");
});

/** What a report line must never hold raw: controls, format characters, line and paragraph separators. */
const RAW = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

test("doctor audit (review): every value escaped where the lines are written: errors, graph ids, rule texts; names that could pass for each other stay apart", async (t) => {
  if (process.platform === "win32") return t.skip("no such names on Windows");
  const esc = "\u001b[2K\u001b[G✓ instruction budget: 0.0 KB in every session";
  const graph = { nodes: [{ id: `dup\u2028${esc}` }, { id: `dup\u2028${esc}` }, { id: "b", needs: ["x\u200ey", "z\u061cw"] }] };
  const text = "deb\u001bugger";
  const r = setup({ review: { forbidden: [{ text, paths: ["**"] }] } }, graph);
  // A command file that is a link to a directory: the budget's read error names it.
  mkdirSync(join(r.dir, "somewhere"));
  writeFileSync(join(r.dir, "somewhere", "f"), "x\n");
  mkdirSync(join(r.dir, ".claude", "commands"), { recursive: true });
  symlinkSync("../../somewhere", join(r.dir, ".claude", "commands", `z${esc}.md`), "dir");
  r.commit("feat: odd values", {
    '"a\\nb.js"': `${text}\n`,
    "a\nb.js": `${text}\n`,
    "x, y.js": `${text}\n`,
  });
  const run = spawnSync(process.execPath, [CLI, "doctor"], { cwd: r.dir, encoding: "utf8" });
  for (const l of run.stdout.split("\n")) assert.doesNotMatch(l, RAW, JSON.stringify(l));
  assert.match(run.stdout, /^\? instruction budget: unmeasured: .*\\u001b\[2K\\u001b\[G/m);
  assert.match(run.stdout, /x\\u200ey/);
  assert.match(run.stdout, /z\\u061cw/);
  const held = run.stdout.split("\n").find((l) => l.includes("review.forbidden rule 1") && l.includes("already"));
  assert.ok(held, run.stdout);
  // The rule's text quoted once, escaped; the names each their own, the one holding ", " quoted.
  assert.ok(held.includes(`hold "deb\\u001bugger" already`), held);
  assert.ok(held.includes('"\\"a\\\\nb.js\\""') && held.includes('"a\\nb.js"') && held.includes('"x, y.js"'), held);
  const mech = spawnSync(process.execPath, [CLI, "mechanization"], { cwd: r.dir, encoding: "utf8" });
  for (const l of mech.stderr.split("\n")) assert.doesNotMatch(l, RAW, JSON.stringify(l));
});

test("doctor audit (review): an escaped value reads back as the value, astral format characters too", () => {
  for (const v of ["a\u{E0001}b", "x\u200ey", "\u2028", "q\"\\n", "\u0085\u007f"]) {
    const { text, quoted } = shown(v, { name: true });
    assert.ok(quoted && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) && JSON.parse(text) === v, JSON.stringify([v, text]));
  }
});

test("doctor audit (review round two): a path stays as a user copies it: a Windows path is not quoted for its backslashes, and ZWNJ / ZWJ stay as they are", () => {
  assert.deepEqual(shown("D:\\work\\src\\x.js", { name: true, platform: "win32" }), { text: "D:\\work\\src\\x.js", quoted: false });
  assert.equal(shown("a\\b.js", { name: true, platform: "linux" }).quoted, true, "a backslash in a POSIX name is part of the name");
  assert.equal(shown("x, y.js", { name: true, platform: "win32" }).quoted, true, "the list separator still quotes");
  for (const v of ["می\u200cخواهم.md", "क्\u200dष.md"]) assert.deepEqual(shown(v, { name: true }), { text: v, quoted: false }, JSON.stringify(v));
  for (const v of ["a\u200eb", "a\u202eb", "a\u2066b", "a\u2028b"]) assert.equal(shown(v, { name: true }).quoted, true, JSON.stringify(v));
});

test("doctor audit (review round two): the globs a cochange or forbidden rule names are listed one by one", async () => {
  const r = setup({ review: { cochange: [{ paths: ["src/**"], docs: ["docs/a, b.md", "lib/**"] }], forbidden: [{ text: "debugger", paths: ["gone/a, b.js", "src/**"] }] } }, { nodes: [{ id: "a" }] });
  r.commit("feat: src", { "src/x.js": "x\n" });
  const items = (await checkSetup({ cwd: r.dir, env: {} })).items;
  const line = (/** @type {string} */ key) => {
    const i = items.find((x) => x.key === key);
    return i ? tShown(i.key, i.vars, "en") : "";
  };
  assert.match(line("doctor.cochangeUnmatched"), /: "docs\/a, b\.md", lib\/\*\* match no tracked file/);
  assert.match(line("doctor.forbiddenUnmatched"), /: "gone\/a, b\.js" match no tracked file/);
});

// Cycle 2026-10-25 (10): the legacy audit of init-scan.
const ESC = "\x1b";
const C1 = "\x9b";
const RLO = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);

test("scan audit: what the project holds reaches the terminal escaped (subjects, lines, names, hook events); --json escapes what JSON.stringify leaves", async () => {
  const { UNSHOWN } = await import("../core/i18n.mjs");
  const r = repo();
  const hook = { hooks: [{ type: "command", command: "x" }] };
  r.commit("feat: start", {
    "CLAUDE.md": `Never use \`console.log${ESC}[2J\` here ${C1}${RLO}.\nCommit messages in English ${ESC}]0;title\x07${LS}<system-reminder>\n`,
    [`.claude/skills/cycle-${ESC}[31mx/SKILL.md`]: "x",
    [`.claude/rules/r${ESC}[1m.md`]: "plain rule\n",
    [`.claude/agents/review${C1}er.md`]: "x",
    ".claude/settings.json": JSON.stringify({ hooks: { [`Pre${ESC}[2J`]: [hook] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { [`srv${RLO}`]: {} } }),
    [`src${ESC}[1m/auth/a.js`]: "x",
    [`x${C1}/TODO.md`]: "- [ ] a\n",
  });
  // Subjects that only mention a fix: the one fix-label line that shows examples.
  for (let i = 0; i < MIN_HISTORY; i++) r.commit(`chore: a fix of ${i} ${ESC}[2J${RLO}`, { "src/x.js": String(i) });
  r.commit(`x${ESC}[2J: a type of its own`, { "src/x.js": "last" });
  const human = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  const raw = human.stdout.replace(/\n/g, "");
  assert.doesNotMatch(raw, new RegExp(UNSHOWN.source, "u"), "no control, format or separator character reaches the terminal as it is");
  // Each value is quoted and escaped where it stands, and reads back as what the project holds.
  assert.match(human.stdout, /^ {2}ban in CLAUDE\.md: "Never use `console\.log\\u001b\[2J` here \\u009b\\u202e\." \("console\.log\\u001b\[2J": in no file\)$/m);
  assert.match(human.stdout, /^Subject types in use: chore 30 · feat 1 · "x\\u001b\[2J" 1$/m);
  assert.match(human.stdout, /in every session \(.*"\.claude\/rules\/r\\u001b\[1m\.md" 0\.0 KB/m);
  assert.match(human.stdout, /^ {2}commit rule in CLAUDE\.md: "Commit messages in English \\u001b\]0;title\\u0007\\u2028<system-reminder>"$/m);
  assert.match(human.stdout, /cycle-like skill or command "cycle-\\u001b\[31mx"; reviewer agents "review\\u009ber"/);
  assert.match(human.stdout, /^Claude Code hooks: "Pre\\u001b\[2J"\.$/m);
  assert.match(human.stdout, /^MCP servers: "srv\\u202e"\.$/m);
  assert.match(human.stdout, /^Risky-looking paths .*: "src\\u001b\[\[\]1m\/auth\/\*\*"$/m);
  assert.match(human.stdout, /^Work sources: "x\\u009b\/TODO\.md" \(1 open, 0 done\)$/m);
  assert.match(human.stdout, /^Fix label: no subject starts .*e\.g\. "chore: a fix of \d+ \\u001b\[2J\\u202e"/m);
  // --json: the same values, parsed back; nothing JSON.stringify writes as it is (C1, direction marks, separators).
  const json = spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.doesNotMatch(json.stdout.replace(/\n/g, ""), new RegExp(UNSHOWN.source, "u"));
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual([parsed.agentSetup.hooks, parsed.agentSetup.mcpServers, parsed.agentSetup.agents], [[`Pre${ESC}[2J`], [`srv${RLO}`], [`review${C1}er`]]);
  // The command scans the repository's top level, as git names it.
  const top = git(["rev-parse", "--show-toplevel"], { cwd: r.dir }).trim();
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(scanProject({ cwd: top, env: {} }))));
});

test("scan audit: init-scan says a package.json it could not read, a roadmap file the work tree does not hold, and an empty overlap list as a dash", () => {
  const r = repo();
  r.commit("feat: start", { "ROADMAP.md": "- [ ] a\n", "x.js": "1" });
  // As a sparse checkout leaves it: in the index, out of the work tree.
  git(["update-index", "--skip-worktree", "ROADMAP.md"], { cwd: r.dir });
  rmSync(join(r.dir, "ROADMAP.md"));
  put(r.dir, { "package.json": "{ broken", ".claude/agents/code-reviewer.md": "x" });
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Work sources: ROADMAP\.md \(listed by git, no file here to read\)$/m);
  assert.match(out.stdout, /^Not read \(.*\): package\.json\.$/m);
  // What a file not read declares is unknown, never "none".
  assert.match(out.stdout, /^Commands not measured from package\.json: not valid JSON: what those files declare is unknown\.$/m);
  assert.match(out.stdout, /^Mutation: not measured: package\.json: not valid JSON\.$/m);
  assert.doesNotMatch(out.stdout, /no test command found|no tool configured/);
  assert.match(out.stdout, /^Overlaps with Ennyn: cycle-like skill or command —; reviewer agents code-reviewer\.$/m);
});

test("scan audit: a hooks or mcpServers value that is no object is said as not read, not listed as events \"0\"…; an event with no hook is none", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-agents-shape-"));
  const hook = { hooks: [{ type: "command", command: "x" }] };
  put(dir, {
    ".claude/settings.json": JSON.stringify({ hooks: "PreToolUse" }),
    ".claude/settings.local.json": JSON.stringify({ hooks: { Stop: [], PostToolUse: null, Notification: [{ matcher: "x", hooks: [] }], SessionStart: [hook] } }),
    ".mcp.json": JSON.stringify({ mcpServers: ["a", "b"] }),
  });
  const res = agentSetup(dir, []);
  // An event of the wrong shape (null here) is said by its name, as a hooks value of the wrong type is.
  assert.deepEqual([res.hooks, res.mcpServers, res.unreadable], [["SessionStart"], [], [".claude/settings.json", ".claude/settings.local.json hooks.PostToolUse", ".mcp.json"]]);
  put(dir, { ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: { matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, Stop: "y", Notification: [{ matcher: "x" }], SessionStart: [hook] } }) });
  assert.deepEqual(agentSetup(dir, []).unreadable.slice(0, 3), [".claude/settings.json hooks.PreToolUse", ".claude/settings.json hooks.Stop", ".claude/settings.json hooks.Notification"]);
  // A list where an object belongs, and a null, are no hooks either.
  put(dir, { ".claude/settings.json": JSON.stringify({ hooks: [hook] }), ".claude/settings.local.json": JSON.stringify({ hooks: null }), ".mcp.json": JSON.stringify({ mcpServers: { a: {} } }) });
  const again = agentSetup(dir, []);
  assert.deepEqual([again.hooks, again.mcpServers, again.unreadable], [[], ["a"], [".claude/settings.json", ".claude/settings.local.json"]]);
  // No hooks key at all: nothing to read, nothing said.
  put(dir, { ".claude/settings.json": JSON.stringify({ permissions: {} }), ".claude/settings.local.json": "{}" });
  assert.deepEqual(agentSetup(dir, []).unreadable, []);
});

test("scan audit: a subject holding \\x01, an empty commit, and files named like a hash or a status letter are read as git holds them", () => {
  const r = repo();
  const hex = "a".repeat(40);
  r.commit("feat: a\x01fix: injected", { [hex]: "1", M: "1" });
  r.commit("chore: nothing");
  r.commit("docs: b", { "b c.md": "1" });
  assert.deepEqual(recentCommits(r.dir), [
    { subject: "docs: b", paths: ["b c.md"] },
    { subject: "chore: nothing", paths: [] },
    { subject: "feat: a\x01fix: injected", paths: ["M", hex] },
  ]);
});

test("scan audit: a risky directory holding glob syntax is proposed as a glob that names its own files, and the impact gate then holds them", () => {
  const r = repo();
  r.commit("feat: start", { "app/[locale]/auth/x.ts": "1", "src/{legacy}/payments/y.ts": "1", "app/[locale]/security.ts": "1" });
  const risky = riskyPaths(["app/[locale]/auth/x.ts", "src/{legacy}/payments/y.ts", "lib/[id]/session.ts"], pat());
  assert.deepEqual(risky.map((x) => x.glob), ["app/[[]locale]/auth/**", "lib/[[]id]/session.ts", "src/[{]legacy[}]/payments/**"]);
  // Through commit-check, as review.impactRequiredGlobs: the proposed glob holds the file; the name as written
  // (`[locale]` a class, `{legacy}` an alternation) let it through.
  const check = (/** @type {string[]} */ globs) => {
    put(r.dir, { ".ennyn/config.json": JSON.stringify({ review: { impactRequiredGlobs: globs } }), "app/[locale]/auth/x.ts": `${Math.random()}`, "src/{legacy}/payments/y.ts": `${Math.random()}` });
    git(["add", "-A"], { cwd: r.dir });
    put(r.dir, { ".git/MSG": "feat: change\n" });
    return spawnSync(process.execPath, [CLI, "commit-check", join(r.dir, ".git", "MSG")], { cwd: r.dir, encoding: "utf8" });
  };
  const held = check(risky.filter((x) => x.glob.endsWith("/**")).map((x) => x.glob));
  assert.equal(held.status, 1, held.stderr);
  assert.match(held.stderr, /impact table \(.*app\/\[locale\]\/auth\/x\.ts/);
  assert.match(held.stderr, /src\/\{legacy\}\/payments\/y\.ts/);
  assert.equal(check(["app/[locale]/auth/**", "src/{legacy}/payments/**"]).status, 0, "as written, the names match nothing of their own");
});

test("scan audit: a git log field that is no commit fails the scan, never a list shifted by one", () => {
  const r = repo();
  r.commit("feat: a", { "a.js": "1" });
  const realGit = join(git(["--exec-path"], { cwd: r.dir }), "git");
  const bin = mkdtempSync(join(tmpdir(), "en-gitlog-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --name-status ] && { printf 'not-a-hash\\000subject\\000'; exit 0; }; done\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.notEqual(out.status, 0, out.stdout);
  assert.match(out.stderr, /git log printed a field that is no commit: "not-a-hash"/);
});

test("scan audit: links back to a parent list a rule once, as the side-copy hook reads it; a directory past the depth is said, not dropped", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const { loadPathScopedRules } = await import("../adapters/claude-code/rules-index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-rules-loop-"));
  put(dir, { ".claude/rules/r.md": "Never use `eval`.\n", ".claude/commands/c.md": "x" });
  // Seven links to the rules directory itself: each walk of its own read 7^8 paths and ran out of stack.
  for (let i = 0; i < 7; i++) symlinkSync(".", join(dir, ".claude", "rules", `l${i}`));
  symlinkSync("..", join(dir, ".claude", "commands", "up"));
  const res = agentSetup(dir, []);
  assert.deepEqual(res.instructions.map((i) => i.path), [".claude/rules/r.md"]);
  // The link up reaches .claude: its commands directory is the one being read, its rules are new.
  assert.deepEqual(res.commands, ["c", "up/rules/r"]);
  // Thirty-three levels down: what is there is unknown, which the hook says and the scan fails on.
  const deep = mkdtempSync(join(tmpdir(), "en-rules-deep-"));
  put(deep, { [`.claude/rules/${Array.from({ length: 33 }, () => "d").join("/")}/x.md`]: "---\npaths: ['**']\n---\nx\n" });
  /** @type {string[]} */
  const unreadable = [];
  assert.deepEqual(loadPathScopedRules(deep, unreadable), []);
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0], /(\/d){33}$/);
  assert.throws(() => agentSetup(deep, []), /(\/d){33} could not be read: more than 32 directories down/);
});

test("scan audit: the fence reader, the roadmap checkboxes and the commit-rule start take time linear in the text; they answer as before", async (t) => {
  const { importsOf, banLines, outsideFences, commitRuleLines } = await import("../setup/scan.mjs");
  // One reader of code blocks for the imports and the ban lines: a block ends at its own character, at least
  // as many, nothing after; one left open runs to the end.
  const text = ["````", "```", "@in-block.md", "never use `a1`", "````", "@after.md never use `b2`", "~~~js", "@tilde.md", "```", "@other-char.md", "~~~ not a close", "@still.md", "~~~", "see ` @span.md ` here", "```", "@open.md", "never use `c3`"].join("\n");
  assert.deepEqual(importsOf(text, "CLAUDE.md"), ["after.md"]);
  assert.deepEqual(banLines(text).map((b) => b.literals), [["b2"]]);
  assert.deepEqual(outsideFences("a\n```\nb\n```\nc"), ["a", "c"]);
  // Trailing punctuation is no part of the name; an import named twice is listed once.
  assert.deepEqual(importsOf("see @a.md. and @b.md), then @a.md;", "docs/CLAUDE.md"), ["docs/a.md", "docs/b.md"]);
  // The commit-rule start: markers, a number, emphasis, then "commit" (accepted only for it, no rule word in the line).
  const accept = ["1. Commit", "**Commit** step", "> - `commit` step", "## 2) commit step", "_commit_ step", "| commit | step", "* * * commit step"];
  const reject = ["Before the commit run tests", "x commit step", "_-commit step", "1 commit step", "a. commit step"];
  assert.deepEqual(commitRuleLines([...accept, ...reject].join("\n")), accept);
  // Growth, not a wall-clock bound (see the secrets test): eight times the text costs about eight times the
  // time if linear, sixty-four if quadratic; these took 25 s and more at 200,000 blank lines.
  const best = (/** @type {() => void} */ f) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  }));
  const growth = (/** @type {(size: number) => () => void} */ make) => (best(make(128 * 1024)) + 5) / (best(make(16 * 1024)) + 5);
  const dir = mkdtempSync(join(tmpdir(), "en-roadmap-time-"));
  const roadmap = (/** @type {number} */ n) => {
    // The item first: a pattern that runs over line breaks backtracks at every blank line after it.
    put(dir, { [`${n}/TODO.md`]: "- [ ] a\n" + " \n".repeat(n) });
    return () => assert.equal(roadmapFiles(dir, [`${n}/TODO.md`])[0].open, 1);
  };
  for (const [name, make] of /** @type {[string, (n: number) => () => void][]} */ ([
    ["imports over blank lines", (n) => () => importsOf(" \n".repeat(n), "CLAUDE.md")],
    // The trailing punctuation an import loses, and the imports kept once each (the review's inputs).
    ["an import with a long run of dots before a letter", (n) => () => importsOf(`@${".".repeat(n)}x`, "CLAUDE.md")],
    ["many distinct imports", (n) => () => importsOf(Array.from({ length: n / 4 }, (_, i) => `@f${i}.md`).join("\n"), "CLAUDE.md")],
    ["roadmap checkboxes over blank lines", roadmap],
    ["commit-rule start over a run of markers", (n) => () => commitRuleLines("*".repeat(n) + " x commit step")],
  ])) {
    const g = growth(make);
    t.diagnostic(`${name}: ${g.toFixed(1)}`);
    assert.ok(g < 24, `${name}: eight times the text took ${g.toFixed(1)} times as long`);
  }
});

// Review round one of the init-scan audit.
test("scan audit (review): an error that names a path reaches stderr on one line, escaped (ESC, LF, LS, RLO); config problems keep a line each", () => {
  const LS = String.fromCharCode(0x2028), RLO = String.fromCharCode(0x202e);
  const hostile = `e\x1b[2J\n${LS}${RLO}x`;
  const dir = mkdtempSync(join(tmpdir(), "en-err-"));
  git(["init", "-q"], { cwd: dir });
  put(dir, { [`.claude/commands/${Array.from({ length: 32 }, () => "d").join("/")}/${hostile}/c.md`]: "x" });
  const scan = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8" });
  assert.equal(scan.status, 1, scan.stdout);
  const body = scan.stderr.replace(/\n$/, "");
  assert.ok(!body.includes("\n"), "one line");
  assert.ok(!/[\x1b\u2028\u202e]/u.test(scan.stderr), "nothing reaches the terminal as it is");
  assert.match(scan.stderr, /e\\u001b\[2J\\u000a\\u2028\\u202ex could not be read: more than 32 directories down/);
  // A config key holding an escape and a line feed: each problem on its own line, the key escaped.
  put(dir, { ".ennyn/config.json": JSON.stringify({ [`x\x1b[2J\nfake`]: 1 }) });
  const cfg = spawnSync(process.execPath, [CLI, "mechanization"], { cwd: dir, encoding: "utf8" });
  assert.equal(cfg.status, 1);
  assert.match(cfg.stderr, /^Invalid ennyn config:\n- .*x\\u001b\[2J\\u000afake/);
  assert.equal(cfg.stderr.trimEnd().split("\n").length, 2);
  // A graph module that fails to load: its error names what it read, escaped, on one line.
  put(dir, { ".ennyn/config.json": JSON.stringify({ paths: { graph: ".ennyn/graph.mjs" } }), ".ennyn/graph.mjs": `throw new Error("x\\u001b[2J\\nfake");\n` });
  const graph = spawnSync(process.execPath, [CLI, "mechanization"], { cwd: dir, encoding: "utf8" });
  assert.equal(graph.status, 1);
  assert.match(graph.stderr, /^cannot load .*graph\.mjs: x\\u001b\[2J\\u000afake\n$/);
  // An unknown command or option is the user's word, shown as written.
  const cmd = spawnSync(process.execPath, [CLI, `x\x1b[2J\nfake`], { cwd: dir, encoding: "utf8" });
  assert.match(cmd.stderr, /^unknown command "x\\u001b\[2J\\nfake"\n/);
  const opt = spawnSync(process.execPath, [CLI, "init-scan", `--x\x1b[2J\nfake`], { cwd: dir, encoding: "utf8" });
  assert.equal(opt.status, 2);
  assert.ok(!opt.stderr.includes("\x1b"), opt.stderr);
  assert.match(opt.stderr.split("\n")[0], /x\\u001b\[2J\\u000afake/);
  // Lines no tShown wrote still pass the last guard: a message file named with an escape (stderr), a
  // mutant id (stdout).
  const clean = mkdtempSync(join(tmpdir(), "en-err-clean-"));
  git(["init", "-q"], { cwd: clean });
  const named = spawnSync(process.execPath, [CLI, "commit-check", join(clean, `m\x1b[2J`)], { cwd: clean, encoding: "utf8" });
  assert.equal(named.status, 1, named.stderr);
  assert.ok(!named.stderr.includes("\x1b") && /m\\u001b\[2J/.test(named.stderr), named.stderr);
  writeFileSync(join(clean, "mutants.json"), JSON.stringify([{ id: `m\x1b[2J`, file: "none.js", old: "a", new: "b" }]));
  const mut = spawnSync(process.execPath, [CLI, "mutate", "mutants.json", "--command", `"${process.execPath}" -e 0`], { cwd: clean, encoding: "utf8" });
  assert.ok(/m\\u001b\[2J/.test(mut.stdout) && !mut.stdout.includes("\x1b"), mut.stdout + mut.stderr);
});

test("scan audit (review): a directory is as deep as its own place, not the first path that reaches it; a link out of the repository is named, not read, by the hook and the scan", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const { loadPathScopedRules, LEAVES } = await import("../adapters/claude-code/rules-index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-walk-"));
  // The review's case: a link thirty levels down reaches b before b's own path does, walking depth first.
  const deep = Array.from({ length: 30 }, () => "d").join("/");
  put(dir, { [`.claude/rules/a/${deep}/x.md`]: "x\n", ".claude/rules/b/one/two/three/r.md": "---\npaths: ['src/**']\n---\nr\n" });
  symlinkSync(join(dir, ".claude", "rules", "b"), join(dir, ".claude", "rules", "a", deep, "lnk"));
  /** @type {string[]} */
  const unreadable = [];
  assert.deepEqual(loadPathScopedRules(dir, unreadable).map((r) => r.file.slice(dir.length)), ["/.claude/rules/b/one/two/three/r.md"]);
  assert.deepEqual(unreadable, []);
  assert.ok(agentSetup(dir, []).instructions.some((i) => i.path === ".claude/rules/b/one/two/three/r.md"));
  // The same with the deep link under a name read last: whichever order a depth-first walk takes, one of the
  // two reaches b deep first.
  const late = mkdtempSync(join(tmpdir(), "en-walk-late-"));
  put(late, { [`.claude/rules/z/${deep}/x.md`]: "x\n", ".claude/rules/b/one/two/three/r.md": "---\npaths: ['src/**']\n---\nr\n" });
  symlinkSync(join(late, ".claude", "rules", "b"), join(late, ".claude", "rules", "z", deep, "lnk"));
  assert.deepEqual(loadPathScopedRules(late).map((r) => r.file.slice(late.length)), ["/.claude/rules/b/one/two/three/r.md"]);
  // Out of the repository: a linked directory and a linked file, each named with the reason; nothing read there.
  const home = mkdtempSync(join(tmpdir(), "en-walk-home-"));
  put(home, { "notes.md": "---\npaths: ['**']\n---\nnever use `ghp-like-literal`\n" });
  symlinkSync(home, join(dir, ".claude", "rules", "home"));
  symlinkSync(join(home, "notes.md"), join(dir, ".claude", "rules", "notes.md"));
  /** @type {string[]} */
  const out = [];
  /** @type {Map<string, string>} */
  const why = new Map();
  assert.deepEqual(loadPathScopedRules(dir, out, why).map((r) => r.file.slice(dir.length)), ["/.claude/rules/b/one/two/three/r.md"]);
  assert.deepEqual(out.map((p) => [p.slice(dir.length), why.get(p)]).sort(), [["/.claude/rules/home", LEAVES], ["/.claude/rules/notes.md", LEAVES]]);
  // A sibling whose name starts with the repository's is outside it too.
  mkdirSync(`${dir}-sibling`);
  put(`${dir}-sibling`, { "s.md": "Never use `sibling-literal`.\n" });
  symlinkSync(`${dir}-sibling`, join(dir, ".claude", "rules", "sibling"));
  const res = agentSetup(dir, []);
  assert.deepEqual(res.outside, [".claude/rules/home", ".claude/rules/notes.md", ".claude/rules/sibling"]);
  assert.ok(!res.instructions.some((i) => i.banLines.length), "no line of the home file reaches the scan");
  git(["init", "-q"], { cwd: dir });
  const said = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8" });
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stdout, /^Not read, they lead out of the repository: \.claude\/rules\/home, \.claude\/rules\/notes\.md, \.claude\/rules\/sibling\./m);
  // Counted as rules that are there, flagged: Claude Code loads them once external imports are approved.
  // The rule of b with paths, and the three links out counted apart: their rules are not given, which is said.
  assert.match(said.stdout, /^1 path-scoped rule files under \.claude\/rules: the side-copy hook applies\.$/m);
  assert.match(said.stdout, /^3 rule links under \.claude\/rules point outside the project, so the side-copy hook does not give their rules\.$/m);
  assert.doesNotMatch(said.stdout, /approve external imports/);
  // The rules directory itself linked out: named, nothing read.
  const linked = mkdtempSync(join(tmpdir(), "en-walk-linked-"));
  mkdirSync(join(linked, ".claude"));
  symlinkSync(home, join(linked, ".claude", "rules"));
  assert.deepEqual(agentSetup(linked, []).outside, [".claude/rules"]);
});

test("scan audit (review): a walk stops at its entry ceiling inside the repository too, and says where", async () => {
  const { loadPathScopedRules } = await import("../adapters/claude-code/rules-index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-walk-many-"));
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  for (let i = 0; i <= 10000; i++) writeFileSync(join(dir, ".claude", "rules", `r${i}.md`), "x");
  /** @type {string[]} */
  const unreadable = [];
  /** @type {Map<string, string>} */
  const why = new Map();
  loadPathScopedRules(dir, unreadable, why);
  assert.deepEqual(unreadable.map((p) => [p.slice(dir.length), why.get(p)]), [["/.claude/rules", "limit:entries:0"]]);
});

test("scan audit (review): a project file that is no regular file, or past the read limit, is said, never waited on or read whole", (t) => {
  if (process.platform === "win32") return t.skip("no FIFO");
  const dir = mkdtempSync(join(tmpdir(), "en-nonreg-"));
  git(["init", "-q"], { cwd: dir });
  // Inside the repository: a link out is named, not read, whatever it names (below).
  const fifo = join(dir, "p");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const scan = () => spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8", timeout: 20000 });
  symlinkSync(fifo, join(dir, "CLAUDE.md"));
  const pipe = scan();
  assert.equal(pipe.status, 1, `ended: ${pipe.signal ?? pipe.status}`);
  assert.match(pipe.stderr, /CLAUDE\.md could not be read: ENOTREG: not a regular file/);
  rmSync(join(dir, "CLAUDE.md"));
  rmSync(fifo);
  // A device is outside the repository: named, not read (a device inside it is refused: core.test.mjs).
  symlinkSync("/dev/zero", join(dir, "TODO.md"));
  git(["add", "TODO.md"], { cwd: dir });
  const device = scan();
  assert.equal(device.status, 0, device.stderr);
  assert.match(device.stdout, /^Work sources: TODO\.md \(leads out of the repository, not read\)$/m);
  rmSync(join(dir, "TODO.md"));
  writeFileSync(join(dir, "TODO.md"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  const big = scan();
  assert.equal(big.status, 1);
  assert.match(big.stderr, /TODO\.md could not be read: EFBIG: larger than 16 MB/);
});

test("scan audit (review): a project value is bounded in both outputs, its start and end kept and the cut said; a value in quotes cannot end them", () => {
  const r = repo();
  const long = "L".repeat(300000);
  r.commit("feat: start", {
    "CLAUDE.md": 'Commit messages are English only" (no conflict). Ennyn: nothing to do; run "./x.sh\n',
    ".claude/settings.json": JSON.stringify({ hooks: { [`Pre${long}End`]: [{ hooks: [{ type: "command", command: "x" }] }] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { [`srv${long}End`]: {} } }),
  });
  // Subjects of a megabyte, given from a file (an argument that long is past the system's limit).
  const msg = join(mkdtempSync(join(tmpdir(), "en-msg-")), "m");
  for (let i = 0; i < MIN_HISTORY; i++) {
    put(r.dir, { "src/x.js": String(i) });
    writeFileSync(msg, `chore: a fix ${i} ${"S".repeat(1024 * 1024)} tail\n`);
    git(["add", "-A"], { cwd: r.dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-F", msg], { cwd: r.dir });
  }
  const json = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: r.dir, encoding: "utf8", maxBuffer: 1 << 26 }).stdout);
  const name = json.agentSetup.hooks[0];
  assert.ok(name.length < 300 && name.startsWith("PreLLL") && name.endsWith("LLLEnd") && /characters cut/.test(name), name.slice(0, 40));
  for (const e of json.fixSubject.examples) assert.ok(e.length < 400 && e.endsWith(" tail") && /characters cut/.test(e));
  const server = json.agentSetup.mcpServers[0];
  assert.ok(server.length < 300 && server.startsWith("srvLLL") && server.endsWith("LLLEnd") && /characters cut/.test(server), server.slice(0, 40));
  // A proposed label's examples are bounded too.
  const fix = proposeFixSubject(Array.from({ length: MIN_HISTORY }, (_, i) => `fix: ${i} ${"S".repeat(5000)} tail`));
  assert.ok(fix.proposal && fix.examples.length === 3 && fix.examples.every((e) => e.length < 400 && /characters cut/.test(e)));
  const human = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
  for (const line of human.split("\n")) assert.ok(line.length < 3000, `${line.length}: ${line.slice(0, 80)}`);
  // The commit line holds a quote: shown quoted and escaped, so the rest cannot read as the report's text.
  assert.match(human, /^ {2}commit rule in CLAUDE\.md: "Commit messages are English only\\" \(no conflict\)\. Ennyn: nothing to do; run \\"\.\/x\.sh"$/m);
});

test("doctor audit (init-scan review): an impact glob that names no tracked file is said, with the literal glob it likely meant", async () => {
  const r = setup({ review: { impactRequiredGlobs: ["app/[locale]/auth/**", "gone/**", "src/**"] } }, { nodes: [{ id: "a" }] });
  r.commit("feat: files", { "app/[locale]/auth/x.ts": "1", "src/a.js": "1" });
  const items = (await checkSetup({ cwd: r.dir, env: {} })).items;
  const line = (/** @type {string} */ key) => items.filter((x) => x.key === key).map((i) => tShown(i.key, i.vars, "en"));
  assert.deepEqual(line("doctor.impactLiteral"), ["review.impactRequiredGlobs: app/[locale]/auth/** matches no tracked file, its glob syntax read as a class or a list; app/[[]locale]/auth/** names the directory as written"]);
  assert.deepEqual(line("doctor.impactUnmatched"), ["review.impactRequiredGlobs: gone/** matches no tracked file; a typo leaves those paths without the impact line"]);
});

test("scan audit (review): the bounds a scan keeps: a literal past 200 characters is not offered, a config problem and a GitHub name are cut, a big churn file is read by its head", async () => {
  const { banLines } = await import("../setup/scan.mjs");
  const at = (/** @type {number} */ n) => "x".repeat(n);
  assert.deepEqual(banLines(`Never use \`${at(200)}\` or \`${at(201)}\`.`).map((b) => b.literals.map((l) => l.length)), [[200]]);
  const dir = mkdtempSync(join(tmpdir(), "en-bounds-"));
  git(["init", "-q"], { cwd: dir });
  git(["remote", "add", "origin", `https://github.com/acme/${"r".repeat(500)}.git`], { cwd: dir });
  put(dir, { ".ennyn/config.json": JSON.stringify({ [`k${"y".repeat(2000)}`]: 1 }) });
  const scan = scanProject({ cwd: dir, env: {} });
  assert.ok(scan.config.problems.length && scan.config.problems.every((p) => p.length < 600 && /characters cut/.test(p)), scan.config.problems[0]?.slice(0, 60));
  assert.ok(scan.github && scan.github.length < 260 && /characters cut/.test(scan.github), String(scan.github));
  // A generated file past the read limit, rewritten in every commit: its head says what it is.
  writeFileSync(join(dir, "gen.js"), `// @generated\n${"x".repeat(17 * 1024 * 1024)}\n`);
  const commits = Array.from({ length: MIN_HISTORY + 10 }, (_, i) => ({ subject: `feat: ${i}`, paths: ["gen.js"] }));
  assert.deepEqual(churnPaths(commits, dir, pat()).paths.map((p) => [p.path, p.generatedMarker]), [["gen.js", true]]);
});

test("scan audit (review): a rule file that cannot be read fails the scan with its reason", async (t) => {
  const { loadPathScopedRules } = await import("../adapters/claude-code/rules-index.mjs");
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const dir = mkdtempSync(join(tmpdir(), "en-rule-unread-"));
  put(dir, { ".claude/rules/r.md": "---\npaths: ['**']\n---\nr\n" });
  chmodSync(join(dir, ".claude", "rules", "r.md"), 0o000);
  try {
    assert.throws(() => scanProject({ cwd: dir, env: {} }), /r\.md could not be read: EACCES/);
    /** @type {string[]} */
    const unreadable = [];
    /** @type {Map<string, string>} */
    const why = new Map();
    loadPathScopedRules(dir, unreadable, why);
    assert.deepEqual(unreadable.map((p) => p.slice(dir.length)), ["/.claude/rules/r.md"]);
    assert.match(String(why.get(unreadable[0])), /could not be read: EACCES/);
  } finally {
    chmodSync(join(dir, ".claude", "rules", "r.md"), 0o644);
  }
});

// Review round two of the init-scan audit.
test("scan audit (review two): what leads out of the repository, by any reader, is named and never read: .claude, package.json, CLAUDE.md, AGENTS.md, .mcp.json, a roadmap, an import", () => {
  const out = mkdtempSync(join(tmpdir(), "en-out-"));
  const mark = "OUTSIDE-MARK";
  put(out, {
    ".claude/CLAUDE.md": `Commit messages: ${mark}\n`,
    ".claude/skills/loop/SKILL.md": "x",
    ".claude/agents/reviewer.md": "x",
    ".claude/commands/run.md": "x",
    ".claude/settings.json": JSON.stringify({ hooks: { [`${mark}Event`]: [{ hooks: [{ type: "command", command: "x" }] }] } }),
    "package.json": JSON.stringify({ scripts: { test: `echo ${mark}` } }),
    "CLAUDE.md": `Commit messages in English, never \`${mark}\`.\n`,
    "AGENTS.md": `Commit message format: ${mark}\n`,
    "mcp.json": JSON.stringify({ mcpServers: { [`${mark}-server`]: {} } }),
    "TODO.md": `- [ ] ${mark}\n`,
    "docs/imported.md": `Commit rule: ${mark}\n`,
  });
  const dir = mkdtempSync(join(tmpdir(), "en-out-repo-"));
  git(["init", "-q"], { cwd: dir });
  for (const [name, target] of [[".claude", ".claude"], ["package.json", "package.json"], ["CLAUDE.md", "CLAUDE.md"], ["AGENTS.md", "AGENTS.md"], [".mcp.json", "mcp.json"], ["TODO.md", "TODO.md"], ["docs", "docs"]]) {
    symlinkSync(join(out, target), join(dir, name));
  }
  // An import of a file through a linked directory, from an instruction file of the repository's own.
  put(dir, { "CLAUDE.local.md": "Read @docs/imported.md\n" });
  git(["add", "-A"], { cwd: dir });
  const scan = scanProject({ cwd: dir, env: {} });
  assert.ok(!JSON.stringify(scan).includes(mark), "nothing from outside the repository is shown");
  // Each named by the link that leads out, not every file under it.
  assert.deepEqual(scan.outside, [".claude", ".mcp.json", "AGENTS.md", "CLAUDE.md", "TODO.md", "docs", "package.json"]);
  assert.deepEqual(scan.agentSetup.instructions.map((i) => i.path), ["CLAUDE.local.md"]);
  assert.deepEqual([scan.agentSetup.skills, scan.agentSetup.agents, scan.agentSetup.commands, scan.agentSetup.hooks, scan.agentSetup.mcpServers], [[], [], [], [], []]);
  assert.deepEqual(scan.unmeasured.commands, [{ path: "package.json", reason: "outside" }]);
  assert.deepEqual(scan.roadmap, [{ path: "TODO.md", outside: true, open: 0, done: 0, lines: 0 }]);
  const human = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  assert.ok(!human.stdout.includes(mark));
  assert.match(human.stdout, /^Not read, they lead out of the repository: \.claude, \.mcp\.json, AGENTS\.md, CLAUDE\.md, TODO\.md, docs, package\.json\./m);
  // CLAUDE.local.md linked to /dev/null (Claude Code reads it as empty): named, the scan and budget go on.
  rmSync(join(dir, "CLAUDE.local.md"));
  symlinkSync("/dev/null", join(dir, "CLAUDE.local.md"));
  assert.equal(spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8" }).status, 0);
  const budget = spawnSync(process.execPath, [CLI, "budget"], { cwd: dir, encoding: "utf8" });
  assert.equal(budget.status, 0, budget.stderr);
  assert.match(budget.stdout, /^Not counted, as they lead out of the repository: .*CLAUDE\.local\.md/m);
});

test("scan audit (review two): a config the user names is read whatever it is, a pipe or /dev/stdin; the project's own files are read regular-only", async (t) => {
  if (process.platform === "win32") return t.skip("no FIFO");
  const r = repo();
  r.commit("feat: start", { "a.txt": "1" });
  put(r.dir, { ".git/MSG": "no type here\n" });
  const cfg = JSON.stringify({ commitMsg: { types: ["feat", "fix"] } });
  // From stdin (`cat cfg | ENNYN_CONFIG=/dev/stdin ennyn commit-check`): read, so the message is checked and refused. Through
  // a shell's pipe: Node's `input` is a socket pair, which Linux will not open by /dev/stdin (ENXIO).
  const stdin = spawnSync("sh", ["-c", 'printf "%s" "$CFG" | ENNYN_CONFIG=/dev/stdin "$NODE" "$CLI_PATH" commit-check "$MSG"'], { cwd: r.dir, encoding: "utf8", env: { ...process.env, CFG: cfg, NODE: process.execPath, CLI_PATH: CLI, MSG: join(r.dir, ".git", "MSG") } });
  assert.equal(stdin.status, 1, stdin.stderr);
  assert.match(stdin.stderr, /^Subject must start with a type from commitMsg\.types \(feat, fix\)/m);
  // From a pipe a writer fills, as `<(cat cfg)` gives: the hook waits for it and checks the commit.
  const fifo = join(mkdtempSync(join(tmpdir(), "en-cfg-fifo-")), "cfg");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const { spawn } = await import("node:child_process");
  const writer = spawn("sh", ["-c", `printf '%s' '${cfg}' > '${fifo}'`]);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", join(r.dir, ".git", "MSG")], { cwd: r.dir, encoding: "utf8", timeout: 20000, env: { ...process.env, ENNYN_CONFIG: fifo } });
  writer.kill();
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /^Subject must start with a type from commitMsg\.types \(feat, fix\)/m);
});

test("scan audit (review two): no value carries a line break into a line: the hook's config error, gate-stats' state path, a mutant list's problems", () => {
  const r = repo();
  r.commit("feat: start", { "a.txt": "1" });
  const lines = (/** @type {string} */ text) => text.split("\n");
  // A skip pattern that does not compile, holding a line feed: the error is one line.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ commitMsg: { skipSubjects: ["(\nMARKER-LINE second line"] } }), ".git/MSG": "feat: x\n" });
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", join(r.dir, ".git", "MSG")], { cwd: r.dir, encoding: "utf8" });
  assert.ok(!lines(hook.stderr).some((l) => l.startsWith("MARKER-LINE")), hook.stderr);
  assert.match(hook.stderr, /\\u000aMARKER-LINE/);
  // A state directory named with a line feed and a line of its own.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ paths: { stateDir: "s\n✓ all gates passed, nothing to do" } }) });
  const stats = spawnSync(process.execPath, [CLI, "gate-stats"], { cwd: r.dir, encoding: "utf8" });
  assert.ok(!lines(stats.stdout).some((l) => l.startsWith("✓")), stats.stdout);
  // A mutant list whose id holds a line feed: each problem keeps a line of its own.
  rmSync(join(r.dir, ".ennyn", "config.json"));
  writeFileSync(join(r.dir, "m.json"), JSON.stringify([{ id: "a\nMARKER-LINE", file: "x.js" }]));
  const mut = spawnSync(process.execPath, [CLI, "mutate", "m.json", "--command", "true"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(mut.status, 1);
  assert.ok(!lines(mut.stderr).some((l) => l.startsWith("MARKER-LINE")), mut.stderr);
  assert.match(mut.stderr, /^- /m);
});

test("scan audit (review two): `unmeasured` names what was not measured with why; null means none", () => {
  const r = repo();
  r.commit("feat: start", { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const plain = scanProject({ cwd: r.dir, env: {} });
  assert.deepEqual(plain.unmeasured, {});
  assert.equal(plain.mutation, null, "none configured");
  put(r.dir, { "package.json": "{ broken" });
  assert.deepEqual(Object.keys(scanProject({ cwd: r.dir, env: {} }).unmeasured).sort(), ["commands", "mutation"]);
  const none = mkdtempSync(join(tmpdir(), "en-unm-"));
  assert.deepEqual(scanProject({ cwd: none, env: {} }).unmeasured, { bans: [{ reason: "noRepo" }] });
});

test("scan audit (review two): at the entry ceiling the directories still waiting are counted; a proposal is shown whole; an error line is bounded", async () => {
  const { loadPathScopedRules } = await import("../adapters/claude-code/rules-index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-ceiling-"));
  mkdirSync(join(dir, ".claude", "rules", "a-assets"), { recursive: true });
  for (let i = 0; i < 10050; i++) writeFileSync(join(dir, ".claude", "rules", "a-assets", `f${i}.png`), "");
  put(dir, { ".claude/rules/z/r.md": "---\npaths: ['**']\n---\nr\n" });
  /** @type {string[]} */
  const unreadable = [];
  /** @type {Map<string, string>} */
  const why = new Map();
  loadPathScopedRules(dir, unreadable, why);
  assert.deepEqual(unreadable.map((p) => [p.slice(dir.length), why.get(p)]), [["/.claude/rules/a-assets", "limit:entries:1"]]);
  // A test pattern of nearly a thousand characters: the proposal built on it is copied into the config whole.
  const r = setup({ metrics: { testRe: `(${Array.from({ length: 200 }, (_, i) => `x${i}y`).join("|")}|\\.test\\.)` } }, { nodes: [{ id: "a" }] });
  r.commit("feat: tests", { "tests/a.py": "x" });
  const json = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: r.dir, encoding: "utf8" }).stdout);
  assert.ok(json.tests.proposal.length > 1000);
  const human = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.ok(human.includes(`Proposed: ${json.tests.proposal}`), "the proposal whole");
  // An error line past its bound keeps its start and end: a config key of ten thousand characters.
  put(r.dir, { ".ennyn/config.json": JSON.stringify({ [`k${"y".repeat(10000)}z`]: 1 }) });
  const long = spawnSync(process.execPath, [CLI, "mechanization"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(long.status, 1);
  const line = long.stderr.split("\n")[1];
  assert.ok(line.length < 4200 && /characters cut/.test(line) && line.includes("kyyy") && line.includes("yyz"), line.slice(0, 80));
});

test("scan audit (review two): an empty directory linked out is named too; a churn path that leads out is named, its marker not read", () => {
  const out = mkdtempSync(join(tmpdir(), "en-out2-"));
  mkdirSync(join(out, "skills"));
  const dir = mkdtempSync(join(tmpdir(), "en-out2-repo-"));
  git(["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".claude"));
  symlinkSync(join(out, "skills"), join(dir, ".claude", "skills"));
  // A link rewritten in every commit to a generated file outside: a churn path, its head never read.
  for (let i = 0; i < MIN_HISTORY + 2; i++) {
    writeFileSync(join(out, `gen${i}.js`), `// @generated OUTSIDE-MARK ${i}\n`);
    rmSync(join(dir, "gen.js"), { force: true });
    symlinkSync(join(out, `gen${i}.js`), join(dir, "gen.js"));
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `feat: ${i}`], { cwd: dir });
  }
  const scan = scanProject({ cwd: dir, env: {} });
  assert.deepEqual(scan.churn.paths.map((p) => [p.path, p.generatedMarker, p.outside]), [["gen.js", false, true]]);
  assert.deepEqual(scan.outside, [".claude/skills", "gen.js"]);
});

// Review round three of the init-scan audit.
test("scan audit (review three): budget reads a listing as the scan does: one linked out of the repository is neither counted nor read", () => {
  const out = mkdtempSync(join(tmpdir(), "en-b-out-"));
  put(out, { "a.md": `---\nname: a\ndescription: ${"d".repeat(1500)}\n---\nx\n` });
  const r = repo();
  r.commit("feat: start", { "CLAUDE.md": "x\n" });
  mkdirSync(join(r.dir, ".claude", "agents"), { recursive: true });
  symlinkSync(join(out, "a.md"), join(r.dir, ".claude", "agents", "a.md"));
  r.commit("feat: link");
  const json = JSON.parse(spawnSync(process.execPath, [CLI, "budget", "--json"], { cwd: r.dir, encoding: "utf8" }).stdout);
  assert.equal(json.listings, 0, "not counted");
  assert.deepEqual(json.outside, [".claude/agents/a.md"]);
});

test("scan audit (review three): what was not measured, and a walk's limit, read in the project's language", async () => {
  const { reasonText } = await import("../adapters/claude-code/rules-index.mjs");
  const r = setup({ language: "tr" }, { nodes: [{ id: "a" }] });
  put(r.dir, { "package.json": "{ broken" });
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.match(out, /^Komutlar şuradan ölçülmedi: package\.json: geçerli JSON değil; o dosyaların tanımladığı bilinmiyor\.$/m);
  assert.match(out, /^Kırma: ölçülmedi: package\.json: geçerli JSON değil\.$/m);
  assert.doesNotMatch(out, /not valid JSON/);
  assert.equal(reasonText("limit:entries:1", "tr"), "10000 girdiden fazla; bir dizin daha okunmadı");
  assert.equal(reasonText("limit:entries:3", "en"), "more than 10000 entries; 3 more directories not read");
  assert.equal(reasonText("limit:entries:0", "en"), "more than 10000 entries");
  assert.equal(reasonText("limit:depth", "tr"), "32 dizinden daha derinde");
  assert.equal(reasonText("EACCES: permission denied", "tr"), "EACCES: permission denied");
});
