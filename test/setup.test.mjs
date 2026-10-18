import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
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

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !["ENNYN_CONFIG", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_EDITOR"].includes(k)),
);
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
  git(["init", "-q", "-b", "main"], { cwd: dir, env: ENV });
  return {
    dir,
    /** @param {string} message @param {Record<string, string>} [files] */
    commit(message, files = {}) {
      put(dir, files);
      git(["add", "-A"], { cwd: dir, env: ENV });
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir, env: ENV });
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
  });
  const empty = mkdtempSync(join(tmpdir(), "en-cmd0-"));
  put(empty, { "package.json": "{ broken" });
  assert.deepEqual(projectCommands(empty), { commands: [], mutation: null });
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
  assert.ok(keys(res).includes("ok doctor.fixTooFew"));
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

test("doctor: a missing graph and a broken config fail; a fix-label majority warns", async () => {
  const noGraph = setup({}, undefined);
  assert.ok(keys(await checkSetup({ cwd: noGraph.dir, env: {} })).includes("fail doctor.graphBad"));
  const badCfg = setup({ review: { maxRounds: "two" } }, { nodes: [] });
  const bad = await checkSetup({ cwd: badCfg.dir, env: {} });
  assert.deepEqual(keys(bad), ["fail doctor.configBad"]);
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

test("cli: init-scan --json is the scan; doctor prints marks and exits 1 on a problem", () => {
  const r = setup({}, { nodes: [{ id: "a" }, { id: "a" }] });
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: r.dir, env: ENV, encoding: "utf8" });
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
  assert.match(doc.stdout, /^problems: 1 · warnings: 0$/m);
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
