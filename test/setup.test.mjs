import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
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
import { t } from "../core/i18n.mjs";

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

test("doctor audit: outside a repository the git checks are skipped and the fix label says unmeasured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-doc-out-"));
  put(dir, { ".ennyn/config.json": "{}", ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a", mechanization: true }], done: [] }) });
  const res = await checkSetup({ cwd: dir, env: {} });
  const k = keys(res);
  assert.ok(k.includes("warn doctor.fixNoRepo"), k.join("\n"));
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
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [], PreToolUse: [] } }),
    ".claude/settings.local.json": JSON.stringify({ hooks: { SessionStart: [] } }),
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
  const store = mkdtempSync(join(tmpdir(), "en-agents-store-"));
  put(store, { "cycle/SKILL.md": "x", "code-reviewer.md": "x" });
  const dir = mkdtempSync(join(tmpdir(), "en-agents-ln-"));
  mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  symlinkSync(join(store, "cycle"), join(dir, ".claude", "skills", "cycle"));
  symlinkSync(join(store, "code-reviewer.md"), join(dir, ".claude", "agents", "code-reviewer.md"));
  put(dir, { [".claude/skills/" + "faz-döngü".normalize("NFD") + "/SKILL.md"]: "x" });
  const res = agentSetup(dir, []);
  assert.deepEqual(res.skills, ["cycle", "faz-döngü"].sort());
  assert.deepEqual(res.agents, ["code-reviewer"]);
  assert.deepEqual(res.overlaps.cycle.sort(), ["cycle", "faz-döngü"].sort());
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
  const store = mkdtempSync(join(tmpdir(), "en-rules-store-"));
  put(store, { "deep/more/commit.md": "Commit: one line\n" });
  const dir = mkdtempSync(join(tmpdir(), "en-rules-ln-"));
  put(dir, { ".claude/rules/a/b/c.md": "plain rule\n" });
  symlinkSync(store, join(dir, ".claude", "rules", "linked"));
  assert.deepEqual(agentSetup(dir, []).instructions.map((i) => i.path), [".claude/rules/a/b/c.md", ".claude/rules/linked/deep/more/commit.md"]);
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
  assert.deepEqual(found.map((i) => [i.level, i.vars]), [["warn", { rule: 2, globs: "scr/**, DESIGN.md, docs/**" }]]);
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
