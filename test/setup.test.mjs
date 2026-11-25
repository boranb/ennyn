import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter, relative, sep } from "node:path";
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
import { askReport, checkSetup, pipes, worktreesIgnored } from "../setup/doctor.mjs";
import { shown, t, tShown } from "../core/i18n.mjs";
import { ownHome } from "./own-home.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
// The doctor tests write the global git ignore under the home: one of this file's own, or it refuses to run.
const { root: ROOT, home: HOME } = ownHome("en-setup-");
const SELF = join(dirname(CLI), "..", "test", "setup.test.mjs");
const cfg = () => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-s-")), env: {} });
const pat = () => pathPatterns(DEFAULTS, []).re;

/** @param {string} dir @param {Record<string, string>} files */
/** A repository's remote on another host: the gh commands are not asked about, in a test about something else. @param {{ dir: string }} r */
const elsewhere = (r) => (git(["remote", "add", "elsewhere", "https://gitlab.com/a/b.git"], { cwd: r.dir }), r);
/** A doctor ask-rules item, but the line elsewhere() brings (doctor.askNoGithub has its own test). @param {{ key: string }} i */
const askItem = (i) => i.key.startsWith("doctor.ask") && i.key !== "doctor.askNoGithub";

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
      git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
    },
  };
}

/** @param {number} n @param {(i: number) => string} f */
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("setup: run with a home outside the temporary folder it refuses, before any write", () => {
  const tmp = mkdtempSync(join(ROOT, "tmp-"));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test-name-pattern=^no such test$", SELF], { env: { ...env, HOME: join(sep, "no", "such", "home"), TMPDIR: tmp }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refuses to run: HOME/);
  assert.deepEqual(readdirSync(tmp), []);
});

test("setup: ownHome takes away every variable a write follows out of the home, so install-hook run from a plugin session leaves the session's record alone", () => {
  const top = dirname(dirname(CLI));
  const session = () => {
    const data = mkdtempSync(join(ROOT, "data-"));
    writeFileSync(join(data, "root"), "/sentinel/root\n");
    const vars = { ENNYN_PLUGIN_DATA: data, ENNYN_PLUGIN_ROOT: top, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: top, CLAUDE_ENV_FILE: join(data, "env"), CLAUDE_CONFIG_DIR: join(data, "config"), ENNYN_LOCK_DIR: join(data, "lock") };
    return { data, env: { ...process.env, HOME: mkdtempSync(join(ROOT, "inherited-")), ...vars } };
  };
  const install = (/** @type {NodeJS.ProcessEnv} */ env) => spawnSync(process.execPath, [CLI, "install-hook"], { cwd: repo().dir, encoding: "utf8", env });
  const read = (/** @type {string} */ data) => readFileSync(join(data, "root"), "utf8");
  // Kept, the session's variables make install-hook write the record: else what follows would prove nothing.
  const kept = session();
  install(kept.env);
  assert.notEqual(read(kept.data), "/sentinel/root\n");
  const taken = session();
  const git = { GIT_DIR: join(taken.data, "repo.git"), GIT_WORK_TREE: taken.data, GIT_INDEX_FILE: join(taken.data, "index"), GIT_CONFIG_PARAMETERS: "'core.hooksPath'='hooks'" };
  const env = { ...taken.env, ...git };
  ownHome("en-setup-session-", env);
  const names = ["ENNYN_PLUGIN_DATA", "ENNYN_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_ENV_FILE", "CLAUDE_CONFIG_DIR", "ENNYN_LOCK_DIR", ...Object.keys(git)];
  assert.deepEqual(names.filter((k) => k in env), []);
  assert.deepEqual([env.GIT_CONFIG_NOSYSTEM, env.GIT_CEILING_DIRECTORIES], [process.env.GIT_CONFIG_NOSYSTEM, process.env.GIT_CEILING_DIRECTORIES]);
  const r = install(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(taken.data), "/sentinel/root\n");
  assert.deepEqual(readdirSync(taken.data), ["root"]);
});

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

test("fix label: a commit that only moves a submodule is outside the denominator, as in the rework rate", () => {
  const r = repo();
  r.commit("feat: start", { "src/a.js": "export const a = 1;\n" });
  mkdirSync(join(r.dir, "lib", "sub"), { recursive: true });
  git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},lib/sub`], { cwd: r.dir });
  r.commit("chore: bump lib", {});
  const commits = recentCommits(r.dir);
  assert.deepEqual(commits.map((c) => [c.subject, c.paths]), [["chore: bump lib", []], ["feat: start", ["src/a.js"]]], "the commit stays, for the commit style");
  assert.deepEqual(productionSubjects(commits, pat()), ["feat: start"]);
});

test("fix label: a .gitmodules git cannot read does not stop the history a submodule's commit is in", async () => {
  const r = repo();
  put(r.dir, { ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a" }] }) });
  mkdirSync(join(r.dir, "lib", "sub"), { recursive: true });
  git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},lib/sub`], { cwd: r.dir });
  r.commit("feat: start", { "src/a.js": "export const a = 1;\n", ".gitmodules": "[[[ not a config\n" });
  git(["update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},lib/sub`], { cwd: r.dir });
  r.commit("chore: bump lib", {});
  assert.deepEqual(recentCommits(r.dir).map((c) => c.subject), ["chore: bump lib", "feat: start"]);
  const scan = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(scan.status, 0, scan.stderr);
  const doctor = await checkSetup({ cwd: r.dir, env: {} });
  assert.ok(!keys(doctor).some((k) => k.includes("doctor.fixUnmeasured")), keys(doctor).join(" "));
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
  // A file with no extension is a file: its own name is no directory to glob below.
  assert.deepEqual(riskyPaths(["bin/login"], pat()), [{ path: "bin/login", files: 1, glob: "bin/login" }]);
  // A dotted flat name is read by its first part, its subject (scan audit 54): the security audit's scope reads this list.
  const accept = ["src/app/auth.service.ts", "src/app/auth.guard.ts", "src/app/login.component.ts", "src/app/login.ts", "app/payments.controller.ts", "lib/auth.d.ts", "src/Auth.Service.cs", "views/login.html.erb"];
  const reject = ["src/app/author.service.ts", "src/app/authors.module.ts", "src/app/app.component.ts", "src/app/oauthless.ts", "src/user.service.ts", "src/order-list.component.ts", "src/vite.config.ts", "docs/auth.service.md", "src/auth.service.spec.ts"];
  assert.deepEqual(riskyPaths([...accept, ...reject], pat(), Infinity).map((r) => r.path), [...accept].sort());
});

test("risky paths (scan audit 54): init-scan proposes every one, whole: a flat app's files do not push its risky folders out", () => {
  const r = repo();
  const app = ["auth.service.ts", "auth.guard.ts", "auth.interceptor.ts", "login.component.ts", "login.component.html", "login.component.scss", "session.service.ts", "order.service.ts", "orders.component.ts", "orders.component.html", "orders.component.scss", "payment.service.ts", "app.component.ts"];
  r.commit("feat: app", { ...Object.fromEntries(app.map((n) => [`src/app/${n}`, "x\n"])), "src/migrations/001_init.sql": "x\n", "src/payments/stripe.ts": "x\n", "server/src/main.ts": "x\n" });
  const risky = scanProject({ cwd: r.dir, env: {} }).risky.map((x) => x.path);
  assert.equal(risky.length, 14, "twelve flat files and two folders");
  assert.ok(risky.includes("src/migrations") && risky.includes("src/payments"), risky.join(" "));
  // The printout init reads names each of them.
  const human = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  const line = human.stdout.split("\n").find((l) => l.startsWith("Risky-looking paths")) ?? "";
  assert.equal(line.split(", ").length, 14, line);
  assert.match(line, /src\/migrations\/\*\*.*src\/payments\/\*\*/);
});

test("fix label (scan audit 54): Hotfix, Hot fix and Onarıldı start a fix; a commit touching only tests is outside the count; the examples are the newest fixes whichever label", () => {
  const hot = proposeFixSubject(many(40, (i) => (i % 4 ? `Add page ${i}` : i % 8 ? `Hotfix crash ${i}` : `Hot fix login ${i}`)));
  assert.deepEqual([hot.pick, hot.reason, hot.matches], ["verb", "ok", 10]);
  const onar = proposeFixSubject(many(40, (i) => (i % 4 ? `Ekran eklendi ${i}` : i % 8 ? `Onarıldı: liste ${i}` : `onarildi sayac ${i}`)));
  assert.deepEqual([onar.pick, onar.reason, onar.matches], ["turkish", "ok", 10]);
  const commits = [
    { subject: "fix: only the test", paths: ["src/a.test.js"] },
    { subject: "fix: the code", paths: ["src/a.js", "src/a.test.js"] },
  ];
  assert.deepEqual(productionSubjects(commits, pat()), ["fix: the code"]);
  // Newest first: the three Turkish fixes are newer than the conventional ones, though the conventional label comes first.
  const mixed = proposeFixSubject(many(40, (i) => (i < 3 ? `düzeltme: a${i}` : i < 6 ? `fix: b${i}` : `feat: c${i}`)));
  assert.equal(mixed.pick, "conventional+turkish");
  assert.deepEqual(mixed.examples, ["düzeltme: a0", "düzeltme: a1", "düzeltme: a2"]);
});

test("churn (scan audit 54): MIN_HISTORY commits are enough; a path counts from max(10, a quarter of the commits rounded up), the most rewritten first", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-churn-"));
  /** `n` commits, each path in the newest `counts[path]`. @param {number} n @param {Record<string, number>} counts */
  const commitsOf = (n, counts) => many(n, (i) => ({ subject: `feat: ${i}`, paths: Object.keys(counts).filter((p) => i < counts[p]) }));
  const at30 = churnPaths(commitsOf(MIN_HISTORY, { "src/ten.js": 10, "src/nine.js": 9, "src/twenty.js": 20 }), dir, pat());
  assert.equal(at30.min, 10, "a quarter of 30 is under ten");
  assert.deepEqual(at30.paths.map((p) => [p.path, p.commits]), [["src/twenty.js", 20], ["src/ten.js", 10]]);
  const at41 = churnPaths(commitsOf(41, { "src/ten.js": 10, "src/eleven.js": 11 }), dir, pat());
  assert.equal(at41.min, 11, "a quarter of 41 is 10.25, rounded up");
  assert.deepEqual(at41.paths.map((p) => p.path), ["src/eleven.js"]);
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
  // The name is the mutation tool's question: package.json was read whole, and what it declares as commands is known.
  assert.equal(projectCommands(dash).unmeasured.commands, undefined);
  // A folder linked out of the repository is named for what it holds: .cargo/mutants.toml's tool is unmeasured, not none.
  const cargoAway = mkdtempSync(join(tmpdir(), "en-cmd-cargo-"));
  writeFileSync(join(cargoAway, "mutants.toml"), "");
  const cargo = mkdtempSync(join(tmpdir(), "en-cmd-cargo-link-"));
  symlinkSync(cargoAway, join(cargo, ".cargo"));
  assert.deepEqual([projectCommands(cargo).mutation, projectCommands(cargo).unmeasured.mutation], [null, [{ path: ".cargo", reason: "outside" }]]);
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
  // Eight entry points are kept whatever they run; past them only those that run or may run tests.
  const lots = mkdtempSync(join(tmpdir(), "en-cmd-lots-"));
  const names = ["check", "check:ci", "check:fast", "check:quick", "check:unit", "lint", "lint:ci", "lint:fast", "lint:quick", "test"];
  put(lots, { "package.json": JSON.stringify({ scripts: Object.fromEntries(names.map((n) => [n, "x"])) }) });
  assert.deepEqual(projectCommands(lots).commands, [...names.slice(0, 8).map((n) => `npm run ${n}`), "npm test"]);
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

/** git's identity for a corpus commit, and nothing a user's setup could add. */
const WHO = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
/** A directory holding `files`, in no repository. @param {Record<string, string>} [files] @param {string} [at] */
function folder(files = {}, at = tmpdir()) {
  const dir = mkdtempSync(join(at, "en-new-"));
  put(dir, files);
  return dir;
}
/** Everything in `dir` committed. @param {string} dir @param {string} [message] */
function commitAll(dir, message = "c") {
  git(["add", "-A"], { cwd: dir });
  git([...WHO, "commit", "-q", "--allow-empty", "-m", message], { cwd: dir });
}
/** A folder made with its parents. @param {string} path */
function made(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
/** A repository whose one commit holds `files`. @param {Record<string, string>} files @param {string} [dir] */
function committed(files, dir = folder()) {
  put(dir, files);
  git(["init", "-q", "-b", "main"], { cwd: dir });
  commitAll(dir);
  return dir;
}
/**
 * A repository of `n` commits that each rewrite README.md, written by git fast-import, nothing checked out: the
 * oldest also adds `first`, the next removes them.
 * @param {number} n @param {string[]} [first]
 */
function history(n, first = []) {
  const dir = folder();
  git(["init", "-q", "-b", "main"], { cwd: dir });
  const data = (/** @type {string} */ s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const extra = (/** @type {number} */ i) => (i === 0 ? first.map((p) => `M 100644 inline ${p}\n${data("x\n")}`).join("") : i === 1 ? first.map((p) => `D ${p}\n`).join("") : "");
  const stream = many(n, (i) => `commit refs/heads/main\ncommitter t <t@t> ${1700000000 + i} +0000\n${data(`c${i}`)}M 100644 inline README.md\n${data(`${i}\n`)}${extra(i)}\n`).join("");
  git(["fast-import", "--quiet"], { cwd: dir, input: stream });
  return dir;
}
/**
 * test/hostile.mjs puts the temporary folder inside a repository, as a user's may be: the scan's walk up for a `.git`
 * stops below it here, so a folder in it can be outside every repository. The test of the walk itself passes none.
 */
const CEIL = realpathSync.native(tmpdir());
/**
 * The scan's new-project verdict with what it left unmeasured.
 * @param {string} dir @param {string} [from] @param {{ ceiling?: string | null, env?: Record<string, string> }} [opts] `ceiling` null: none
 */
const newVerdict = (dir, from, { ceiling = CEIL, env = {} } = {}) => {
  const res = scanProject({ cwd: dir, env, ...(from === undefined ? {} : { from }), ...(ceiling === null ? {} : { ceiling }) });
  return { ...res.newProject, unmeasured: res.unmeasured.newProject ?? [] };
};
const NEW = { new: true, found: [], more: 0, gitInit: false, noGitInit: null, within: null, unmeasured: [] };
/** Not new, for what was found. @param {string[]} found @param {number} [more] */
const notNew = (found, more = 0) => ({ new: false, found, more, gitInit: false, noGitInit: null, within: null, unmeasured: [] });
/** The folder above `dir` that holds a `.git`, found by a walk of the test's own; null: none up to the root. @param {string} dir */
function gitAboveHere(dir) {
  for (let d = dirname(realpathSync.native(dir)); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

test("new project: a README, a licence, .gitignore, agent instruction files, .claude/ settings and Markdown and .ennyn/ data are all a new project holds; any other name is not new (corpus, accept and reject)", async () => {
  const { newProjectPath } = await import("../setup/scan.mjs");
  // What `gh repo create --add-readme --license --gitignore` and a first agent session leave, in the spellings projects use.
  const yes = [
    "README", "README.md", "readme.md", "Readme.rst", "README.markdown", "readme.txt", "README.tr.md", "README_zh.md", "README-ja.md", "README.zh-CN.md", "README.MD", "README.TXT",
    "README.zh_CN.md", "README_zh-CN.md", "README.pt-BR.md", "README.zh-Hans.md", "README.adoc", "README.org", "README.textile", "README.rdoc", "README.pod",
    "LICENSE", "LICENSE.txt", "LICENSE-MIT", "LICENSE-APACHE", "LICENSE-APACHE-2.0", "LICENSE-APACHE-2.0.txt", "LICENSE-2.0.txt", "LICENSE-THIRD-PARTY", "LICENSE-MIT.txt", "LICENCE", "licence.md",
    "COPYING", "COPYING3", "COPYING.LESSER", "COPYING.LIB", "UNLICENSE", "UNLICENSE.txt",
    ".gitignore", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".cursorrules", "CONTRIBUTING.md",
    ".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md", ".claude/rules/a.md", ".claude/skills/x/SKILL.md", ".claude/agents/a.md", ".claude/commands/x/go.md",
    ".ennyn/config.json", ".ennyn/graph.json", ".ennyn/handoff.md", ".ennyn/metrics.jsonl",
  ];
  // Manifests and scaffolds of each ecosystem, source and test folders, and names a new project may hold but the rule cannot tell from work: unsure is not new.
  const no = [
    "package.json", "package-lock.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle.kts", "App.csproj", "CMakeLists.txt", "Makefile", "Dockerfile", ".python-version",
    "main.py", "index.js", "index.html", "src/main.rs", "lib/a.rb", "app/page.tsx", "docs/README.md", "test/a.test.js", "node_modules/a/index.js",
    ".github/workflows/ci.yml", ".github/copilot-instructions.md", ".vscode/settings.json", ".idea/workspace.xml", ".gitattributes", ".gitmodules", ".editorconfig", ".env", ".mcp.json", ".DS_Store", "notes.txt", "CHANGELOG.md",
    // An agent file in another case is no name the agent asks for; a stem that runs on, and an allowed name used as a folder.
    "claude.md", "Claude.md", "agents.md", "READMEFIRST", "THIRD_PARTY_LICENSE.txt", "MY-README.md", "LICENSES/MIT.txt", "readme/x.md", "README.md/x", ".claude", ".ennyn", "x/.gitignore", "x/CLAUDE.md", ".claudex/a", "a/.claude/b",
    // Source files named after their subject (review round 1): the stem with a word or an extension that is no text.
    "readme_generator.py", "license_check.go", "copying.c", "README.sh", "README.js", "LICENSE-checker.js", "readme.py", "README.txt.bak", "README.tr.html", "LICENSE.mit.js",
    // The same in upper case (review round 2), and a variant before a code extension.
    "README.SH", "README.BAT", "LICENSE.PY", "LICENSE-CHECK.PY", "README-GEN.JS", "COPYING.C", "README-2.JS", "LICENSE-MIT.PY",
    // Names a licence or README may have that the rule cannot tell from code by shape: unsure is not new.
    "LICENSE.MIT", "LICENSE.mit", "LICENSE.apache2", "README.mdx", "README.html", "COPYING3.LIB", "README_CN.md",
    // Code and data inside the agent folders: a hook, a skill's script, a manifest, a repository, an agent worktree's code, a graph module.
    ".claude/hooks/format.py", ".claude/skills/deploy/scripts/run.sh", ".claude/package.json", ".claude/.git", ".claude/worktrees/x/src/a.js", ".claude/.md", ".claude/settings.json.bak",
    ".ennyn/graph.mjs", ".ennyn/x/y.json", ".ennyn/.git",
  ];
  for (const p of yes) assert.equal(newProjectPath(p), true, `new: ${p}`);
  for (const p of no) assert.equal(newProjectPath(p), false, `not new: ${p}`);
});

test("new project: init-scan reads the disk, the index and the last commits of every ref; outside a repository it proposes git init (corpus)", () => {
  // Accept: nothing yet, or only what a new repository and a first agent session hold.
  assert.deepEqual(newVerdict(folder()), { ...NEW, gitInit: true });
  const empty = folder();
  git(["init", "-q"], { cwd: empty });
  assert.deepEqual(newVerdict(empty), NEW, "an empty git init");
  const made = committed({ "README.md": "# x\n", LICENSE: "MIT\n", ".gitignore": "node_modules/\n", "CLAUDE.md": "rules\n" });
  assert.deepEqual(newVerdict(made), NEW, "README, LICENSE, .gitignore, CLAUDE.md committed");
  const clone = join(folder(), "clone");
  git(["clone", "-q", made, clone], { cwd: made });
  assert.deepEqual(newVerdict(clone), NEW, "a clone: the remote's refs hold the same");
  const session = folder({ ".claude/settings.local.json": "{}", ".claude/agents/a.md": "a", "readme.md": "x", "LICENSE-MIT": "x", "COPYING.LESSER": "x", "AGENTS.md": "x", "GEMINI.md": "x", ".cursorrules": "x", "CONTRIBUTING.md": "x", "CLAUDE.local.md": "x", ".ennyn/config.json": "{}" });
  assert.deepEqual(newVerdict(session), { ...NEW, gitInit: true }, "every allowed name, in no repository");
  const again = committed({ "README.md": "# x\n", ".ennyn/graph.json": "{}", ".claude/rules/a.md": "a\n" });
  put(again, { "README.md": "# y\n" });
  commitAll(again);
  assert.deepEqual(newVerdict(again), NEW, "a README rewritten, init's own files committed");

  // Reject: a manifest, a source folder or a source file, now or only in the past, on any ref.
  assert.deepEqual(newVerdict(committed({ "README.md": "# x\n", "package.json": "{}" })), notNew(["package.json"]));
  assert.deepEqual(newVerdict(committed({ "src/main.py": "print(1)\n" })), notNew(["src/"]));
  assert.deepEqual(newVerdict(folder({ "main.py": "print(1)\n" })), { ...notNew(["main.py"]), gitInit: true }, "a source file at the top, in no repository");
  const gone = committed({ "README.md": "# x\n", "src/a.js": "x\n" });
  rmSync(join(gone, "src"), { recursive: true });
  commitAll(gone);
  assert.deepEqual(newVerdict(gone), notNew(["src/"]), "a folder only the history holds");
  const orphan = committed({ "src/a.js": "x\n" });
  git(["checkout", "-q", "--orphan", "fresh"], { cwd: orphan });
  git(["rm", "-r", "-q", "--cached", "."], { cwd: orphan });
  rmSync(join(orphan, "src"), { recursive: true });
  put(orphan, { "README.md": "# x\n" });
  commitAll(orphan);
  assert.deepEqual(newVerdict(orphan), notNew(["src/"]), "another branch holds code");
  // A merge's own change, read against its first parent: here only the merge ever held x.js.
  const merged = committed({ "README.md": "# x\n" });
  git(["checkout", "-q", "-b", "side"], { cwd: merged });
  put(merged, { LICENSE: "MIT\n" });
  commitAll(merged);
  git(["checkout", "-q", "main"], { cwd: merged });
  git([...WHO, "merge", "-q", "--no-ff", "--no-commit", "side"], { cwd: merged });
  put(merged, { "x.js": "x\n" });
  commitAll(merged, "merge");
  git(["rm", "-q", "--cached", "x.js"], { cwd: merged });
  rmSync(join(merged, "x.js"));
  assert.deepEqual(newVerdict(merged), notNew(["x.js"]), "a file only a merge brought");
  const ignored = committed({ "README.md": "# x\n", ".gitignore": "node_modules/\n" });
  put(ignored, { "node_modules/a/index.js": "x\n" });
  assert.deepEqual(newVerdict(ignored), notNew(["node_modules/"]), "an ignored folder is still there");
  const staged = committed({ "README.md": "# x\n" });
  put(staged, { "app.js": "x\n" });
  git(["add", "app.js"], { cwd: staged });
  rmSync(join(staged, "app.js"));
  assert.deepEqual(newVerdict(staged), notNew(["app.js"]), "staged, then gone from the disk: the index holds it");
  // Named in order, whichever reader found each: the disk's z.txt before the index's app.js.
  put(staged, { "z.txt": "x\n" });
  assert.deepEqual(newVerdict(staged), notNew(["app.js", "z.txt"]));
  // Once the folder or the index decides, the history is not read: its names are not listed.
  const decided = committed({ "package.json": "{}", "old.js": "x\n" });
  rmSync(join(decided, "old.js"));
  commitAll(decided);
  assert.deepEqual(newVerdict(decided), notNew(["package.json"]));
  // Unsure is not new; a folder is named with its slash, an allowed name that is a folder is a folder.
  const unsure = folder({ ".github/workflows/ci.yml": "on: push\n", ".vscode/settings.json": "{}", ".DS_Store": "", ".gitattributes": "* text\n", "notes.txt": "x", "claude.md": "x" });
  assert.deepEqual(newVerdict(unsure), { ...notNew([".DS_Store", ".gitattributes", ".github/", ".vscode/", "claude.md", "notes.txt"]), gitInit: true });
  const shapes = folder();
  mkdirSync(join(shapes, "README.md"));
  mkdirSync(join(shapes, "src"));
  assert.deepEqual(newVerdict(shapes), { ...notNew(["README.md/", "src/"]), gitInit: true }, "an empty src/ is a source folder");
  const many12 = folder(Object.fromEntries(many(12, (i) => [`${String.fromCharCode(97 + i)}.txt`, "x"])));
  assert.deepEqual(newVerdict(many12), { ...notNew(many(10, (i) => `${String.fromCharCode(97 + i)}.txt`), 2), gitInit: true }, "ten named, the rest counted");
});

test("new project: a folder inside another work tree that tracks nothing in it is no project of its own: no git init, the outer history not read as its own", () => {
  const outer = committed({ "package.json": "{}", "src/index.js": "x\n" });
  mkdirSync(join(outer, "new"));
  assert.deepEqual(newVerdict(outer, join(outer, "new")), { ...notNew([]), within: outer });
  put(outer, { "new/notes.md": "x\n" });
  assert.deepEqual(newVerdict(outer, join(outer, "new")), { ...notNew([]), within: outer }, "an untracked file there: still nothing tracked");
  // Started in a folder the tree tracks, or at its top: the tree is the project, read as it is.
  assert.deepEqual(newVerdict(outer, join(outer, "src")), notNew(["new/", "package.json", "src/"]));
  assert.deepEqual(newVerdict(outer), notNew(["new/", "package.json", "src/"]));
  // The CLI passes the folder the command started in.
  const scan = spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: join(outer, "new"), encoding: "utf8" });
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(JSON.parse(scan.stdout).newProject, { new: false, found: [], more: 0, gitInit: false, noGitInit: null, within: realpathSync.native(outer) });
});

test("new project: a .git above that git does not read, or does not look for, is another work tree: not new, no git init (review round 1)", () => {
  const within = (/** @type {string} */ dir) => ({ ...notNew([]), within: realpathSync.native(dir) });
  const code = { "package.json": "{}", "src/a.js": "x\n" };
  // A HEAD git cannot read (outer-garbage-head-*): at its top unmeasured, in a folder below it, at any depth, inside it.
  const garbage = committed(code);
  writeFileSync(join(garbage, ".git", "HEAD"), "garbage\n");
  mkdirSync(join(garbage, "new"));
  mkdirSync(join(garbage, "src", "deeper", "new"), { recursive: true });
  const unread = { ...notNew([]), noGitInit: { path: ".git", reason: "gitUnread" }, unmeasured: [{ path: ".git", reason: "gitUnread" }] };
  assert.deepEqual(newVerdict(garbage), unread);
  assert.deepEqual(newVerdict(join(garbage, "new")), within(garbage));
  assert.deepEqual(newVerdict(join(garbage, "src", "deeper", "new")), within(garbage));
  // A linked worktree whose main repository moved (broken-linked-worktree-*).
  const main = committed(code);
  const linked = join(dirname(main), `${main.split(/[\\/]/).pop()}-w`);
  git(["worktree", "add", "-q", linked, "-b", "w"], { cwd: main });
  renameSync(main, `${main}-moved`);
  mkdirSync(join(linked, "new"));
  assert.deepEqual(newVerdict(linked), unread);
  assert.deepEqual(newVerdict(join(linked, "new")), within(linked));
  // An empty .git folder, a .git file that points nowhere (empty-git-dir-*, dangling-gitfile-*).
  for (const [what, make] of /** @type {[string, (dir: string) => void][]} */ ([
    ["an empty .git folder", (dir) => mkdirSync(join(dir, ".git"))],
    ["a .git file that points nowhere", (dir) => writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/x\n")],
  ])) {
    const dir = folder(code);
    make(dir);
    mkdirSync(join(dir, "new"));
    assert.deepEqual(newVerdict(dir), unread, what);
    assert.deepEqual(newVerdict(join(dir, "new")), within(dir), what);
  }
  // A .git file git cannot parse stops the scan (garbage-gitfile).
  const parse = folder(code);
  writeFileSync(join(parse, ".git"), "garbage\n");
  mkdirSync(join(parse, "new"));
  for (const start of [parse, join(parse, "new")]) assert.throws(() => scanProject({ cwd: start, env: {}, ceiling: CEIL }), /invalid gitfile format/);
  // A sound tree above GIT_CEILING_DIRECTORIES (ceiling-above-healthy-tree): git does not look, the walk does.
  const sound = committed(code);
  mkdirSync(join(sound, "new"));
  const run = spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: join(sound, "new"), encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: sound } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).repository, false, "git did not look above the ceiling");
  assert.deepEqual(JSON.parse(run.stdout).newProject, { new: false, found: [], more: 0, gitInit: false, noGitInit: null, within: realpathSync.native(sound) });
  // With no ceiling given the walk goes to the root: the temporary folder test/hostile.mjs puts in a repository is in one.
  const plain = folder();
  const above = gitAboveHere(plain);
  assert.deepEqual(newVerdict(plain, undefined, { ceiling: null }), above ? within(above) : { ...NEW, gitInit: true });
});

test("new project: no git init over a repository below, at a filesystem root or in the home folder; past the entries looked at, none (review round 1)", async () => {
  const { NEW_DEPTH, NEW_ENTRIES } = await import("../setup/scan.mjs");
  // A folder holding repositories (folder-holding-repositories): not new, and git init would take them in.
  const holder = folder();
  committed({ "package.json": "{}" }, made(join(holder, "a")));
  git(["init", "-q"], { cwd: made(join(holder, "b")) });
  assert.deepEqual(newVerdict(holder), { ...notNew(["a/", "b/"]), noGitInit: { path: "a/", reason: "below" } });
  // As deep as NEW_DEPTH folders down, and no deeper.
  const deep = (/** @type {number} */ n) => {
    const dir = folder();
    const at = join(dir, ...many(n, (i) => `d${i}`));
    mkdirSync(join(at, ".git"), { recursive: true });
    return dir;
  };
  assert.deepEqual(newVerdict(deep(NEW_DEPTH)), { ...notNew(["d0/"]), noGitInit: { path: `${many(NEW_DEPTH, (i) => `d${i}`).join("/")}/`, reason: "below" } });
  assert.deepEqual(newVerdict(deep(NEW_DEPTH + 1)), { ...notNew(["d0/"]), gitInit: true });
  // Files are not what it looks for (review round 2): a thousand files below, or a node_modules, still get git init.
  const sources = folder({ "pyproject.toml": "", ...Object.fromEntries(many(NEW_ENTRIES + 200, (i) => [`src/m${i}.py`, ""])) });
  assert.deepEqual(newVerdict(sources), { ...notNew(["pyproject.toml", "src/"]), gitInit: true });
  const installed = folder({ "package.json": "{}", "src/i.js": "", ...Object.fromEntries(many(60 * 20, (i) => [`node_modules/p${i % 60}/f${i}.js`, ""])) });
  assert.deepEqual(newVerdict(installed), { ...notNew(["node_modules/", "package.json", "src/"]), gitInit: true });
  // The home folder holds the user's files and often a repository's: no git init there.
  const home = realpathSync.native(process.env.HOME ?? "");
  const atHome = newVerdict(home);
  assert.deepEqual([atHome.gitInit, atHome.noGitInit], [false, { reason: "home" }]);
});

test("new project: .claude/ holds settings and Markdown, .ennyn/ Ennyn's data; code in either is not new, and past the entries read it is unmeasured (review round 1)", async () => {
  const { NEW_ENTRIES } = await import("../setup/scan.mjs");
  // A Claude Code setup project (claude-folder-holds-code): hooks and skill scripts are code, committed or only on disk.
  const setup = committed({ "README.md": "# team agent setup\n", ".claude/hooks/format.py": "print(1)\n", ".claude/skills/deploy/scripts/run.sh": "echo\n", ".claude/settings.json": "{}", ".claude/commands/deploy.md": "deploy\n" });
  for (let i = 0; i < 3; i++) {
    put(setup, { ".claude/hooks/format.py": `print(${i})\n` });
    commitAll(setup, `feat(hooks): step ${i}`);
  }
  assert.deepEqual(newVerdict(setup), notNew([".claude/hooks/format.py", ".claude/skills/deploy/scripts/run.sh"]));
  const onDisk = folder({ ".claude/settings.local.json": "{}", ".claude/hooks/x.sh": "echo\n", ".ennyn/config.json": "{}", ".ennyn/graph.mjs": "export const nodes = [];\n" });
  assert.deepEqual(newVerdict(onDisk), { ...notNew([".claude/hooks/x.sh", ".ennyn/graph.mjs"]), gitInit: true });
  // A repository inside the agent folder is not new either.
  const nested = folder({ ".claude/skills/x/SKILL.md": "x\n" });
  git(["init", "-q"], { cwd: join(nested, ".claude", "skills", "x") });
  assert.deepEqual(newVerdict(nested), { ...notNew([".claude/skills/x/.git/"]), noGitInit: { path: ".claude/skills/x/", reason: "below" } });
  // Past NEW_ENTRIES entries in them, the rest is not read: unmeasured, never new; as many as that are all read.
  const rules = (/** @type {number} */ n) => Object.fromEntries(many(n, (i) => [`.claude/r${i}.md`, ""]));
  const whole = newVerdict(folder(rules(NEW_ENTRIES)));
  assert.deepEqual([whole.new, whole.found, whole.unmeasured], [true, [], []]);
  const cut = newVerdict(folder({ ...rules(NEW_ENTRIES + 1), ".ennyn/config.json": "{}" }));
  assert.deepEqual([cut.new, cut.found, cut.unmeasured], [false, [], [{ reason: "walkCap", n: NEW_ENTRIES }]], "said once for both folders");
  // What was not read is the reason: the history is not read past it, so a shallow one adds nothing.
  const shallow = committed({ "README.md": "# x\n" });
  put(shallow, rules(NEW_ENTRIES + 1));
  writeFileSync(join(shallow, ".git", "shallow"), `${git(["rev-parse", "HEAD"], { cwd: shallow })}\n`);
  assert.deepEqual(newVerdict(shallow), { ...notNew([]), unmeasured: [{ reason: "walkCap", n: NEW_ENTRIES }] });
  // Once a name outside them decides, the agent folders are not walked: code there would not change the verdict.
  const decided = folder({ "main.py": "print(1)\n", ".claude/hooks/x.sh": "echo\n" });
  assert.deepEqual(newVerdict(decided), { ...notNew(["main.py"]), gitInit: true });
});

test("new project: an unreadable folder below is said, the scan goes on; the walk below counts folders, not files; links are not followed (review round 2)", async (t) => {
  const { NEW_FOLDERS } = await import("../setup/scan.mjs");
  // As many folders below as are read: all read; one more, and a repository there is not ruled out.
  // Beside test/hostile.mjs's repository, so the CLI can walk below; the scan's own walk up stops at once.
  const outside = (/** @type {Record<string, string>} */ files = {}) => folder(files, process.env.ENNYN_HOSTILE_HOME ?? tmpdir());
  const here = (/** @type {string} */ dir) => newVerdict(dir, undefined, { ceiling: dirname(realpathSync.native(dir)) });
  const spread = (/** @type {number} */ n) => {
    const dir = outside();
    for (let i = 0; i < n - 1; i++) mkdirSync(join(dir, "w", `d${i}`), { recursive: true });
    return dir;
  };
  assert.deepEqual(here(spread(NEW_FOLDERS)), { ...notNew(["w/"]), gitInit: true });
  const capped = spread(NEW_FOLDERS + 1);
  const cap = { n: NEW_FOLDERS, reason: "belowCap" };
  assert.deepEqual(here(capped), { ...notNew(["w/"]), noGitInit: cap, unmeasured: [cap] });
  // As many files as that, in one folder, are not what it counts (non-git-big-subfolder): git init.
  const files = folder(Object.fromEntries(many(NEW_FOLDERS + 1, (i) => [`big/f${i}`, ""])));
  assert.deepEqual(newVerdict(files), { ...notNew(["big/"]), gitInit: true });
  // The CLI names what decides first, and says what it could not rule out.
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: capped, encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  const above = gitAboveHere(capped);
  if (above === null) {
    assert.match(text.stdout, /^New project: no; outside the names a new project holds: w\/\.$/m);
    assert.match(text.stdout, new RegExp(`^Git: no repository here; no git init proposed: more than ${NEW_FOLDERS} folders below, so a repository there is not ruled out\\.$`, "m"));
  } else assert.ok(text.stdout.includes(`this folder lies inside ${above}`), text.stdout);
  // Links are not followed (symlink-loops-below, claude-link-loop-and-md-link): a link is a name.
  const loops = folder({ "sub/a.txt": "x" });
  symlinkSync("..", join(loops, "sub", "up"));
  symlinkSync(".", join(loops, "self"));
  assert.deepEqual(newVerdict(loops), { ...notNew(["self", "sub/"]), gitInit: true });
  const agentLinks = folder({ "README.md": "# x\n", ".claude/settings.json": "{}" });
  symlinkSync("..", join(agentLinks, ".claude", "up"));
  symlinkSync("../README.md", join(agentLinks, ".claude", "x.md"));
  assert.deepEqual(newVerdict(agentLinks), { ...notNew([".claude/up"]), gitInit: true });
  // A folder that cannot be listed (unreadable-folder-*): said with its path and why, no git init, the rest stands.
  if (process.getuid?.() === 0) return t.skip("root lists any folder");
  /** @param {string} dir @param {string} rel */
  const shut = (dir, rel) => {
    mkdirSync(join(dir, rel), { recursive: true });
    chmodSync(join(dir, rel), 0o000);
    t.after(() => chmodSync(join(dir, rel), 0o755));
    return dir;
  };
  const unread = (/** @type {string} */ path, /** @type {string} */ reason) => ({ name: "EACCES", path, reason });
  const db = shut(outside({ "package.json": "{}", "src/i.js": "" }), "data/db");
  assert.deepEqual(here(db), { ...notNew(["data/", "package.json", "src/"]), noGitInit: unread("data/db/", "belowUnread"), unmeasured: [unread("data/db/", "belowUnread")] });
  const deep3 = shut(folder(), "x/y/z");
  assert.deepEqual(newVerdict(deep3), { ...notNew(["x/"]), noGitInit: unread("x/y/z/", "belowUnread"), unmeasured: [unread("x/y/z/", "belowUnread")] });
  assert.deepEqual(newVerdict(shut(folder(), "x/y/z/w")), { ...notNew(["x/"]), gitInit: true }, "deeper than the walk looks");
  const inRepo = committed({ "package.json": "{}" });
  shut(inRepo, "data/db");
  assert.deepEqual(newVerdict(inRepo), notNew(["data/", "package.json"]), "in a repository nothing below is walked");
  // In an agent folder the verdict cannot be told: unmeasured, never new.
  const agent = shut(folder({ "README.md": "# x\n", ".claude/settings.json": "{}" }), ".claude/hooks");
  assert.deepEqual(newVerdict(agent), { ...notNew([]), noGitInit: unread(".claude/hooks/", "belowUnread"), unmeasured: [unread(".claude/hooks", "walkUnread"), unread(".claude/hooks/", "belowUnread")] });
  // The CLI says it, and exits 0 with the report.
  const cli = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: db, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  if (gitAboveHere(db) === null) {
    assert.match(cli.stdout, /^New project: no; outside the names a new project holds: data\/, package\.json, src\/\.$/m);
    assert.match(cli.stdout, /^Git: no repository here; no git init proposed: data\/db\/ could not be read \(EACCES\), so a repository there is not ruled out\.$/m);
  }
});

test("new project: the stash reflog and nested notes read as git reads them; names below reach no terminal raw (review round 2)", () => {
  // A stash whose reflog is gone or holds a garbage line, a stash ref with no reflog (stash-reflog-*, stash-ref-without-reflog).
  const stashOf = () => {
    const dir = committed({ "README.md": "# x\n" });
    put(dir, { "README.md": "# y\n" });
    git([...WHO, "stash", "push", "-q"], { cwd: dir });
    return dir;
  };
  const noLog = stashOf();
  rmSync(join(noLog, ".git", "logs", "refs", "stash"));
  assert.deepEqual(newVerdict(noLog), NEW, "the stash reflog removed");
  const garbage = stashOf();
  writeFileSync(join(garbage, ".git", "logs", "refs", "stash"), "garbage line\n", { flag: "a" });
  assert.deepEqual(newVerdict(garbage), NEW, "a garbage line in the stash reflog");
  const bare = committed({ "README.md": "# x\n" });
  git(["update-ref", "refs/stash", "HEAD"], { cwd: bare });
  assert.deepEqual(newVerdict(bare), NEW, "a stash ref with no reflog");
  // Code stashed under a newer stash entry is read from the stash's reflog (scan audit 54).
  const older = committed({ "README.md": "# x\n" });
  put(older, { "src/a.js": "x\n" });
  git(["add", "src/a.js"], { cwd: older });
  git([...WHO, "stash", "push", "-q"], { cwd: older });
  put(older, { "README.md": "# y\n" });
  git([...WHO, "stash", "push", "-q"], { cwd: older });
  rmSync(join(older, "src"), { recursive: true, force: true });
  assert.deepEqual(newVerdict(older), notNew(["src/"]), "an older stash entry holds code");
  // Notes under nested refs (nested-notes-ref).
  const noted = committed({ "README.md": "# x\n" });
  git([...WHO, "notes", "--ref", "plain", "add", "-m", "n", "HEAD"], { cwd: noted });
  git([...WHO, "notes", "--ref", "review/deep", "add", "-m", "n", "HEAD"], { cwd: noted });
  assert.deepEqual(newVerdict(noted), NEW);
  // A name with control characters in .claude/ and on the path of a repository below (escape-claude-path, escape-below-path).
  const where = process.env.ENNYN_HOSTILE_HOME ?? tmpdir();
  const oddAgent = folder({ "README.md": "# x\n", ".claude/h\u001b[33m.py": "x" }, where);
  const oddBelow = folder({}, where);
  git(["init", "-q"], { cwd: made(join(oddBelow, "b\u001b[32mx")) });
  for (const [dir, says] of /** @type {[string, RegExp][]} */ ([[oddAgent, /claude\/h|lies inside/], [oddBelow, /below holds a repository|lies inside/]])) {
    for (const args of [[], ["--json"]]) {
      const r = spawnSync(process.execPath, [CLI, "init-scan", ...args], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes("\u001b"), `${args}: ${r.stdout}`);
      if (!args.length) assert.match(r.stdout, says);
    }
  }
});

test("new project: could not measure is never new: a shallow history, one past the commits read, a .git git does not read, GIT_DIR in the environment", async () => {
  const { NEW_HISTORY } = await import("../setup/scan.mjs");
  const shallow = committed({ "README.md": "# x\n" });
  writeFileSync(join(shallow, ".git", "shallow"), `${git(["rev-parse", "HEAD"], { cwd: shallow })}\n`);
  assert.deepEqual(newVerdict(shallow), { ...notNew([]), unmeasured: [{ reason: "shallow" }] });
  // What the shallow history holds still decides.
  const cut = committed({ "README.md": "# x\n", "src/a.js": "x\n" });
  git(["rm", "-r", "-q", "--cached", "src"], { cwd: cut });
  rmSync(join(cut, "src"), { recursive: true });
  writeFileSync(join(cut, ".git", "shallow"), `${git(["rev-parse", "HEAD"], { cwd: cut })}\n`);
  assert.deepEqual(newVerdict(cut), notNew(["src/"]));
  assert.deepEqual(newVerdict(history(NEW_HISTORY)), NEW, "as many commits as are read: all read");
  assert.deepEqual(newVerdict(history(NEW_HISTORY + 1)), { ...notNew([]), unmeasured: [{ reason: "historyCap", n: NEW_HISTORY }] });
  assert.deepEqual(newVerdict(history(NEW_HISTORY + 1, ["x.js"])), notNew(["x.js"]), "the oldest commit read still counts");
  // A HEAD git cannot read: git says no repository, and git init would go over one.
  const broken = folder();
  git(["init", "-q"], { cwd: broken });
  writeFileSync(join(broken, ".git", "HEAD"), "garbage\n");
  assert.deepEqual(newVerdict(broken), { ...notNew([]), noGitInit: { path: ".git", reason: "gitUnread" }, unmeasured: [{ path: ".git", reason: "gitUnread" }] });
  // GIT_DIR exported in the shell that runs git init (git-dir-exported): git init writes there, the folder stays empty.
  const other = committed({ "README.md": "# x\n" });
  const gitDir = { ...notNew([]), noGitInit: { name: "GIT_DIR", reason: "gitEnv" }, unmeasured: [{ name: "GIT_DIR", reason: "gitEnv" }] };
  assert.deepEqual(newVerdict(folder(), undefined, { env: { GIT_DIR: join(other, ".git") } }), gitDir);
  // GIT_WORK_TREE alone (git-work-tree-exported): git init refuses it (git 2.34.1), so nothing is written elsewhere.
  assert.deepEqual(newVerdict(folder(), undefined, { env: { GIT_WORK_TREE: other } }), { ...NEW, gitInit: true });
});

test("new project: the review's other probes (round 1): repositories git reads, names, the history of every ref, a user's config, what reaches the terminal", () => {
  const code = { "package.json": "{}", "src/a.js": "x\n" };
  const cli = (/** @type {string} */ cwd, /** @type {string[]} */ args = ["--json"], /** @type {Record<string, string>} */ env = {}) =>
    spawnSync(process.execPath, [CLI, "init-scan", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  // Inside .git, inside a bare repository (inside-dot-git, inside-bare): no work tree, the scan fails.
  const repo = committed(code);
  mkdirSync(join(repo, ".git", "newproj"));
  for (const at of [join(repo, ".git"), join(repo, ".git", "refs"), join(repo, ".git", "newproj")]) assert.equal(cli(at).status, 1, at);
  const bare = join(folder(), "b.git");
  git(["init", "-q", "--bare", bare], { cwd: dirname(bare) });
  mkdirSync(join(bare, "newproj"));
  for (const at of [bare, join(bare, "newproj")]) assert.equal(cli(at).status, 1, at);
  // A submodule is a repository of its own (submodule-*); one not initialized is a folder its tree tracks nothing in.
  const lib = committed({ "README.md": "# x\n", "lib.c": "int x;\n" });
  const sup = committed({ "README.md": "# x\n" });
  git([...WHO, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub"], { cwd: sup });
  commitAll(sup, "sub");
  const sub = join(sup, "sub");
  assert.deepEqual(newVerdict(sub), notNew(["lib.c"]));
  mkdirSync(join(sub, "new"));
  assert.deepEqual(newVerdict(sub, join(sub, "new")), { ...notNew([]), within: sub });
  const supClone = join(folder(), "clone");
  git(["clone", "-q", sup, supClone], { cwd: sup });
  assert.deepEqual(newVerdict(supClone, join(supClone, "sub")), { ...notNew([]), within: supClone });
  // A linked worktree (linked-worktree-subfolder); a .git file naming another repository's git dir (gitfile-to-other-repo).
  const linked = join(dirname(repo), `${repo.split(/[\\/]/).pop()}-w`);
  git(["worktree", "add", "-q", linked, "-b", "w"], { cwd: repo });
  mkdirSync(join(linked, "new"));
  assert.deepEqual(newVerdict(linked, join(linked, "new")), { ...notNew([]), within: linked });
  assert.deepEqual(newVerdict(linked), notNew(["new/", "package.json", "src/"]));
  const pointer = folder({ "README.md": "# x\n", ".git": `gitdir: ${join(repo, ".git")}\n` });
  assert.deepEqual(newVerdict(pointer), notNew(["package.json", "src/"]));
  // .git spelled .GIT (upper-case-git-dir-*): on a disk that tells case apart it is no repository, a folder of that name;
  // where the disk folds case git reads it, and the listing still names it (a stated limit, in the safe direction).
  const upper = committed({ "README.md": "# x\n" });
  renameSync(join(upper, ".git"), join(upper, ".GIT"));
  const folds = existsSync(join(upper, ".git"));
  assert.deepEqual(newVerdict(upper), { ...notNew([".GIT/"]), gitInit: !folds });
  // Source files named after their subject (stem-source-*).
  assert.deepEqual(newVerdict(committed({ "readme_generator.py": "import os\n", "README.md": "r\n", LICENSE: "MIT\n" })), notNew(["readme_generator.py"]));
  const stems = folder({ "license_check.go": "package main\n", "copying.c": "int main(){}\n", "README.sh": "#!/bin/sh\n", "LICENSE-checker.js": "x\n" });
  assert.deepEqual(newVerdict(stems), { ...notNew(["LICENSE-checker.js", "README.sh", "copying.c", "license_check.go"]), gitInit: true });
  // Notes are no project files (git-note-on-new-project); code only in an older stash entry is (code-only-in-older-stash).
  const noted = committed({ "README.md": "# x\n" });
  git([...WHO, "notes", "add", "-m", "note", "HEAD"], { cwd: noted });
  assert.deepEqual(newVerdict(noted), NEW);
  const stashed = committed({ "README.md": "# x\n" });
  put(stashed, { "src/a.js": "x\n" });
  git([...WHO, "stash", "push", "-q", "-u"], { cwd: stashed });
  put(stashed, { "README.md": "# y\n" });
  git([...WHO, "stash", "push", "-q"], { cwd: stashed });
  // git's `--literal-pathspecs`, which every Ennyn git call passes, makes `stash push -u` keep the stashed file on disk
  // (git 2.56.0, measured in scan audit 54): the verdict must come from the stash.
  rmSync(join(stashed, "src"), { recursive: true, force: true });
  assert.deepEqual(newVerdict(stashed), notNew(["src/"]));
  // A tag on a tree (tag-on-a-tree) names no commit.
  const tagged = committed({ "README.md": "# x\n" });
  git(["tag", "treetag", git(["rev-parse", "HEAD^{tree}"], { cwd: tagged })], { cwd: tagged });
  assert.deepEqual(newVerdict(tagged), NEW);
  // A user's config that colours and decorates the log, cuts the root's diff and makes paths relative (history-held-src-user-config).
  const held = committed({ "README.md": "# x\n", "src/a.js": "x\n" });
  rmSync(join(held, "src"), { recursive: true });
  commitAll(held);
  const config = join(folder(), "gitconfig");
  writeFileSync(config, "[safe]\n\tdirectory = *\n[color]\n\tui = always\n[log]\n\tdecorate = full\n\tshowRoot = false\n[diff]\n\trelative = true\n");
  const coloured = cli(held, ["--json"], { GIT_CONFIG_GLOBAL: config });
  assert.equal(coloured.status, 0, coloured.stderr);
  assert.deepEqual(JSON.parse(coloured.stdout).newProject.found, ["src/"]);
  // A README-only history may hold a convention (readme-only-typed-history): new, and its types are the survey's.
  const typed = committed({ "README.md": "0\n" });
  for (let i = 1; i <= 6; i++) {
    put(typed, { "README.md": `${i}\n` });
    commitAll(typed, `docs: readme ${i}`);
  }
  const typedScan = scanProject({ cwd: typed, env: {}, ceiling: CEIL });
  assert.deepEqual([typedScan.newProject.new, typedScan.commitStyle.types[0]], [true, { type: "docs", n: 6 }]);
  // Names holding control characters reach no terminal raw (control-bytes-in-*).
  const odd = folder({ "a\u001b[31mRED": "x", "c\nnl": "x" });
  for (const args of [[], ["--json"]]) assert.ok(!cli(odd, args).stdout.includes("\u001b"), `names, ${args}`);
  const oddOuter = committed({ "package.json": "{}" }, made(join(folder(), "o\u001b[31mx")));
  mkdirSync(join(oddOuter, "new"));
  for (const args of [[], ["--json"]]) {
    const r = cli(join(oddOuter, "new"), args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("\u001b") && /within|inside/.test(r.stdout), `within path, ${args}`);
  }
  // A branch that names a missing commit (broken-branch-ref): the history cannot be read, the scan fails.
  const missing = committed({ "README.md": "# x\n" });
  writeFileSync(join(missing, ".git", "refs", "heads", "broken"), `${"1".repeat(40)}\n`);
  assert.throws(() => scanProject({ cwd: missing, env: {}, ceiling: CEIL }), /bad object/);
  // Measured on Windows only (git 2.47.1), not run here: drive-root (no git init at a root), upper-case-git-dir-windows,
  // mixed-case-git-outer-windows, start-folder-other-case-windows, empty-folder. orphan-checkout-of-real-history is
  // the orphan case of the corpus test on a history of its own.
});

test("cli: init-scan says whether the project is new, what is not, what went unmeasured, and when it proposes git init", async () => {
  const { NEW_HISTORY } = await import("../setup/scan.mjs");
  const run = (/** @type {string} */ cwd) => {
    const r = spawnSync(process.execPath, [CLI, "init-scan"], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  // A folder outside every repository: under test/hostile.mjs's root, beside the repository it puts the temporary folder in.
  const outside = folder({}, process.env.ENNYN_HOSTILE_HOME ?? tmpdir());
  const plainAbove = gitAboveHere(outside);
  const plain = run(outside);
  if (plainAbove === null) {
    assert.match(plain, /^New project: yes; nothing here or in the history but a README, a licence, \.gitignore, agent instruction files, \.claude\/ and \.ennyn\/\.$/m);
    assert.match(plain, /^Git: no repository here or above; \/ennyn:init proposes git init\.$/m);
  } else assert.ok(plain.includes(`this folder lies inside ${plainAbove}`), plain);
  // In the temporary folder, which test/hostile.mjs puts inside a repository git is told not to look for.
  const inTmp = folder();
  const tmpAbove = gitAboveHere(inTmp);
  assert.ok(tmpAbove, "test/hostile.mjs puts the temporary folder in a repository");
  const hidden = run(inTmp);
  assert.ok(hidden.includes(`New project: no; this folder lies inside ${tmpAbove}, which holds a .git git does not read from here: no git init here, and nothing there is read as this project's.`), hidden);
  assert.doesNotMatch(hidden, /^Git:/m);
  const pkg = run(committed({ "package.json": "{}" }));
  assert.match(pkg, /^New project: no; outside the names a new project holds: package\.json\.$/m);
  assert.doesNotMatch(pkg, /^Git:/m, "a repository: no git init");
  assert.match(run(folder(Object.fromEntries(many(12, (i) => [`${String.fromCharCode(97 + i)}.txt`, "x"])), process.env.ENNYN_HOSTILE_HOME ?? tmpdir())), /^New project: no; outside the names a new project holds: a\.txt, b\.txt, .*, j\.txt and 2 more\.$/m);
  const holder = folder({}, process.env.ENNYN_HOSTILE_HOME ?? tmpdir());
  git(["init", "-q"], { cwd: made(join(holder, "a")) });
  if (gitAboveHere(holder) === null) assert.match(run(holder), /^Git: no repository here; no git init proposed: a\/ below holds a repository, which git init here would take in\.$/m);
  const outer = committed({ "package.json": "{}" });
  mkdirSync(join(outer, "new"));
  const nested = run(join(outer, "new"));
  assert.ok(nested.includes(`New project: no; this folder lies inside the work tree ${realpathSync.native(outer)}, which tracks nothing in it: no git init here, and that tree's history is not this project's.`), nested);
  assert.doesNotMatch(nested, /^Git:/m);
  const shallow = committed({ "README.md": "# x\n" });
  writeFileSync(join(shallow, ".git", "shallow"), `${git(["rev-parse", "HEAD"], { cwd: shallow })}\n`);
  assert.match(run(shallow), /^New project: unmeasured: a shallow clone, whose history is cut; read as not new\.$/m);
  assert.ok(run(history(NEW_HISTORY + 1)).includes(`New project: unmeasured: more than ${NEW_HISTORY} commits, so the history was not read whole; read as not new.\n`));
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
  const r = setup({ language: "tr", commands: { fastTest: "npm test" } }, graph);
  const res = await checkSetup({ cwd: r.dir, env: {} });
  assert.equal(res.ok, true, keys(res).join("\n"));
  assert.ok(keys(res).includes("ok doctor.fastTest"));
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

test("doctor: the fast test: set ✓, none with its reason !, unset with commands declared !, a declaring file not read ! saying unmeasured, nothing declared ✗", async () => {
  const graph = { nodes: [{ id: "a" }] };
  const fast = async (/** @type {string} */ dir) => {
    const res = await checkSetup({ cwd: dir, env: {} });
    const items = res.items.filter((i) => i.key.startsWith("doctor.fastTest"));
    assert.equal(items.length, 1, keys(res).join("\n"));
    return { ok: res.ok, fails: keys(res).filter((k) => k.startsWith("fail")), ...items[0] };
  };
  const set = await fast(setup({ commands: { fastTest: "npm run test:short" } }, graph).dir);
  assert.deepEqual(set, { ok: true, fails: [], level: "ok", key: "doctor.fastTest", vars: { command: "npm run test:short" } });
  assert.equal(tShown(set.key, set.vars, "en"), "fast test: npm run test:short");
  const none = await fast(setup({ commands: { fastTest: { none: "a documentation site" } } }, graph).dir);
  assert.deepEqual(none, { ok: true, fails: [], level: "warn", key: "doctor.fastTestNone", vars: { reason: "a documentation site" } });
  // Unset: what init-scan finds decides. Something declared is named, and the cycle still has a command to run.
  const declared = setup({}, graph);
  put(declared.dir, { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "x" } }) });
  const some = await fast(declared.dir);
  assert.deepEqual(some, { ok: true, fails: [], level: "warn", key: "doctor.fastTestUnset", vars: { list: ["npm test"] } });
  // Nothing declared: the cycle would reach its test and mutation steps with nothing to run.
  const empty = await fast(setup({}, graph).dir);
  assert.deepEqual(empty, { ok: false, fails: ["fail doctor.fastTestMissing"], level: "fail", key: "doctor.fastTestMissing", vars: { others: "" } });
  assert.match(t(empty.key, empty.vars, "en"), /^fast test: commands\.fastTest is unset and the project declares no test command: init-scan looks .*\{ "none": "<why>" \}$/);
  // With no config at all, as in a repository init has not reached: the graph and the fast test, two ✗.
  const bare = repo();
  bare.commit("feat: start", { "README.md": "# x\n" });
  assert.deepEqual(keys(await checkSetup({ cwd: bare.dir, env: {} })).filter((k) => k.startsWith("fail")), ["fail doctor.graphBad", "fail doctor.fastTestMissing"]);
  // A declaring file that could not be read is no "declares none": the warning for the unset key says it is unmeasured,
  // which and why. A ? in its place would take a warning off the count a fault moves (the fault matrix).
  const broken = setup({}, graph);
  put(broken.dir, { "package.json": "{ broken" });
  const unread = await fast(broken.dir);
  assert.deepEqual([unread.ok, unread.level, unread.key], [true, "warn", "doctor.fastTestUnread"]);
  assert.equal(tShown(unread.key, unread.vars, "en"), "fast test: commands.fastTest is unset, and what the project declares is unmeasured: package.json: not valid JSON");
  const away = mkdtempSync(join(tmpdir(), "en-fast-away-"));
  writeFileSync(join(away, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  const linked = setup({}, graph);
  symlinkSync(join(away, "package.json"), join(linked.dir, "package.json"));
  const out = await fast(linked.dir);
  assert.match(tShown(out.key, out.vars, "en"), /unmeasured: package\.json: leads out of the repository$/);
  // One that is there and cannot be read at all: the same, with the error.
  const dir = setup({}, graph);
  mkdirSync(join(dir.dir, "package.json"));
  const failed = await fast(dir.dir);
  assert.deepEqual([failed.ok, failed.level, failed.key], [true, "warn", "doctor.fastTestUnread"]);
  assert.match(String(failed.vars.why), /package\.json could not be read: EISDIR/);
  // What another file declares still counts: a warning naming it, never ✗.
  put(broken.dir, { Makefile: "test:\n\ttrue\n" });
  assert.deepEqual(await fast(broken.dir), { ok: true, fails: [], level: "warn", key: "doctor.fastTestUnset", vars: { list: ["make test"] } });
  // Each line in Turkish too, not the English fallback.
  for (const it of [set, none, some, empty, unread]) assert.notEqual(tShown(it.key, it.vars, "tr"), tShown(it.key, it.vars, "en"), it.key);
});

test("doctor: the fast test is a test command: lint or typecheck alone declares none, a check or gate script may run the tests, a command that cannot fail is ✗, and another reading's failure is not this one's", async () => {
  const graph = { nodes: [{ id: "a" }] };
  /** @param {Record<string, unknown>} config @param {Record<string, string>} files */
  const fast = async (config, files = {}, /** @type {(dir: string) => void} */ more = () => {}) => {
    const r = setup(config, graph);
    put(r.dir, files);
    more(r.dir);
    const res = await checkSetup({ cwd: r.dir, env: {} });
    const items = res.items.filter((i) => i.key.startsWith("doctor.fastTest"));
    assert.equal(items.length, 1, keys(res).join("\n"));
    return { ...items[0], text: tShown(items[0].key, items[0].vars, "en") };
  };
  // Only lint or typecheck: ✗, naming them as what does not count, so the user is not told to make lint the fast test.
  // The line does not say they are all the project declares: the scan lists entry points only (test:e2e is not one).
  for (const [files, others] of /** @type {[Record<string, string>, string][]} */ ([
    [{ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) }, "npm run lint"],
    [{ "package.json": JSON.stringify({ scripts: { typecheck: "tsc", build: "tsc" } }) }, "npm run typecheck"],
    [{ Makefile: "lint:\n\ttrue\n" }, "make lint"],
    [{ "package.json": JSON.stringify({ scripts: { "type-check": "x", "lint:fast": "x" } }) }, "npm run lint:fast, npm run type-check"],
    [{ "package.json": JSON.stringify({ scripts: { "test:e2e": "playwright test", lint: "eslint ." } }) }, "npm run lint"],
  ])) {
    const got = await fast({}, files);
    assert.deepEqual([got.level, got.key], ["fail", "doctor.fastTestMissing"], JSON.stringify(files));
    assert.ok(got.text.includes(`(lint and typecheck do not count: ${others})`), got.text);
    assert.doesNotMatch(got.text, /what it declares|runs no tests/, got.text);
  }
  // A check, verify or validate script, make check (the GNU and autotools test target) or a gate script may run the
  // tests: a warning naming them, never ✗ saying they run none.
  for (const [files, maybe] of /** @type {[Record<string, string>, string[]][]} */ ([
    [{ Makefile: "check:\n\t./run-tests\n" }, ["make check"]],
    [{ "scripts/ci.sh": "npm ci && npm test\n" }, ["./scripts/ci.sh"]],
    [{ "scripts/validate.sh": "pytest\n" }, ["./scripts/validate.sh"]],
    [{ "package.json": JSON.stringify({ scripts: { check: "vitest run" } }) }, ["npm run check"]],
    [{ "package.json": JSON.stringify({ scripts: { verify: "jest", lint: "x" } }) }, ["npm run verify"]],
    [{ "package.json": JSON.stringify({ scripts: { "validate:fast": "x", "check:ci": "x", typecheck: "x" } }) }, ["npm run check:ci", "npm run validate:fast"]],
    [{ "scripts/check.sh": "x", "scripts/ci.sh": "x", "scripts/validate.sh": "x" }, ["./scripts/validate.sh", "./scripts/check.sh", "./scripts/ci.sh"]],
  ])) {
    const got = await fast({}, files);
    assert.deepEqual([got.level, got.key, got.vars], ["warn", "doctor.fastTestMaybe", { list: maybe }], JSON.stringify(files));
    assert.match(got.text, /may run the tests: set it to the one that runs them/, got.text);
  }
  // One that may run them is named before a file not read: a candidate to set, and both are warnings.
  const maybeUnread = await fast({}, { "package.json": "{ broken", "scripts/ci.sh": "npm test\n" });
  assert.deepEqual([maybeUnread.level, maybeUnread.key, maybeUnread.vars], ["warn", "doctor.fastTestMaybe", { list: ["./scripts/ci.sh"] }]);
  // No verdict rests on the scan's cut at eight: a test command past it is still found, a check or gate script too.
  const cut = await fast({}, { "package.json": JSON.stringify({ scripts: { check: "x", "check:ci": "x", "check:fast": "x", "check:quick": "x", "check:unit": "x", lint: "x", "lint:ci": "x", "lint:fast": "x", test: "jest" } }) });
  assert.deepEqual([cut.level, cut.key, cut.vars], ["warn", "doctor.fastTestUnset", { list: ["npm test"] }]);
  const go = await fast({}, { "package.json": JSON.stringify({ scripts: { check: "x", lint: "x", typecheck: "x" } }), Makefile: "check:\n\tx\nlint:\n\tx\n", "scripts/validate.sh": "x", "scripts/check.sh": "x", "scripts/ci.sh": "x", "go.mod": "module x\n" });
  assert.deepEqual([go.level, go.key, go.vars], ["warn", "doctor.fastTestUnset", { list: ["go test ./..."] }]);
  const lints = Object.fromEntries(["lint", "lint:ci", "lint:fast", "lint:quick", "lint:unit", "typecheck", "typecheck:ci", "typecheck:fast", "type-check"].map((k) => [k, "x"]));
  const lateCheck = await fast({}, { "package.json": JSON.stringify({ scripts: { ...lints, verify: "jest" } }) });
  assert.deepEqual([lateCheck.level, lateCheck.key, lateCheck.vars], ["warn", "doctor.fastTestMaybe", { list: ["npm run verify"] }]);
  // Each form of a test command the scan lists is one: the warning names the tests, not the lint beside them.
  for (const [files, tests] of /** @type {[Record<string, string>, string[]][]} */ ([
    [{ "package.json": JSON.stringify({ scripts: { test: "x", lint: "x", typecheck: "x" } }) }, ["npm test"]],
    [{ "package.json": JSON.stringify({ scripts: { "test:unit": "x", "test:fast": "x", "test:quick": "x", "test:ci": "x", lint: "x" } }) }, ["npm run test:ci", "npm run test:fast", "npm run test:quick", "npm run test:unit"]],
    [{ Makefile: "lint:\n\ttrue\ntest:\n\ttrue\n" }, ["make test"]],
    [{ "scripts/test.sh": "#!/bin/sh\n", "scripts/check.sh": "#!/bin/sh\n" }, ["./scripts/test.sh"]],
    [{ "pyproject.toml": "[tool.pytest.ini_options]\n" }, ["pytest"]],
    [{ "go.mod": "module x\n" }, ["go test ./..."]],
    [{ "Cargo.toml": "[package]\n" }, ["cargo test"]],
  ])) {
    const got = await fast({}, files);
    assert.deepEqual([got.level, got.key, got.vars], ["warn", "doctor.fastTestUnset", { list: tests }], JSON.stringify(files));
  }
  // A declaring folder that leads out of the repository is unmeasured, as a declaring file that does: not "declares none".
  const away = mkdtempSync(join(tmpdir(), "en-fast-scripts-"));
  writeFileSync(join(away, "test.sh"), "#!/bin/sh\n");
  const linkedOut = await fast({}, {}, (dir) => symlinkSync(away, join(dir, "scripts")));
  assert.deepEqual([linkedOut.level, linkedOut.key], ["warn", "doctor.fastTestUnread"]);
  assert.match(linkedOut.text, /unmeasured: scripts: leads out of the repository$/);
  const fileOut = await fast({}, { "scripts/.keep": "" }, (dir) => symlinkSync(join(away, "test.sh"), join(dir, "scripts", "test.sh")));
  assert.deepEqual([fileOut.level, fileOut.key], ["warn", "doctor.fastTestUnread"]);
  assert.match(fileOut.text, /unmeasured: scripts\/test\.sh: leads out of the repository$/);
  // A mutation script's name npm cannot run is the mutation tool's question: package.json was read whole, and declares no test.
  const dash = await fast({}, { "package.json": JSON.stringify({ scripts: { "-mut": "stryker run" } }) });
  assert.deepEqual([dash.level, dash.key], ["fail", "doctor.fastTestMissing"]);
  // A command that exits 0 whatever runs makes every test and mutant pass: ✗. Read by shape, in the safe direction.
  // As dash and bash 5.2 read the status: a trailing ; ends nothing, a redirect is the echo's own, a background job
  // before the last command or at the end gives 0.
  for (const command of ["true", ":", "exit 0", "echo no tests", "echo", "/bin/true", "/usr/bin/true", "true --anything", "npm test || true", "npm test || :", "npm test; true", "npm test; echo done", "npm test || echo failed", "npm test ; exit 0", "npm test; echo 'done'", "npm test; echo $?", "echo $(npm test)", "make test || echo \"see log\" >&2", "npm test || echo failed 2>&1", "npm test || true;", "true;", "true ; ", "npm test & echo done", "npm test &", "npm test & true"]) {
    const got = await fast({ commands: { fastTest: command } });
    assert.deepEqual([got.level, got.key], ["fail", "doctor.fastTestNoop"], command);
    assert.match(got.text, /exits 0 whatever runs/, command);
  }
  // Not judged, or not a no-op: set changes what a status means; a redirect of the test's own output keeps its status.
  for (const command of ["npm test", "npm test && true", "true && npm test", "echo start && npm test", "echo start | npm test", "exit 1", "npm test;", "npm test || exit", "pytest -k \"a; true\"", "npm test -- --grep 'x; echo y'", "pytest -k \"a || echo b\"", "npm run build && npm test", "dotnet test --filter Category=Fast", ".\\scripts\\test.ps1", "truecheck", "echoes", "npm test && echo ok", "npm test; exit $?", "set -e; npm test; echo done", "set -eu; npm test; true", "npm test 2>&1", "npm test > log 2>&1", "npm test &> log", "npm run serve & npm test", "env true"]) {
    const got = await fast({ commands: { fastTest: command } });
    assert.deepEqual([got.level, got.key], ["ok", "doctor.fastTest"], command);
  }
});

test("doctor: a test command that holds a pipe outside quotes is said, the whole one unset too; pipes reads by shape", async () => {
  // A pipeline's status is its last program's (dash and bash alike; pipefail is bash's, and the shell may be dash).
  for (const command of ["a | tail", "a 2>&1 | tee x", "a |& b", "a|b", "npm test | tail -20", "set -o pipefail; npm test | tee log", "a || b | c", "echo \"x\" | y", "a | 'b'"]) assert.equal(pipes(command), true, command);
  for (const command of ["a || b", "echo \"x|y\"", "echo 'x|y'", "a >| log", "echo x\\|y", "npm test", "pytest -k \"a or b\" || exit 1", ""]) assert.equal(pipes(command), false, command);
  const graph = { nodes: [{ id: "a" }] };
  /** @param {Record<string, unknown>} config */
  const said = async (config) => {
    const res = await checkSetup({ cwd: setup(config, graph).dir, env: {} });
    return res.items.filter((i) => /^doctor\.(testPipe|wholeTest)/.test(i.key)).map((i) => [i.level, i.key, tShown(i.key, i.vars, "en")]);
  };
  assert.deepEqual(await said({ commands: { fastTest: "npm test | tail", wholeTest: "npm test" } }), [["warn", "doctor.testPipe", "fast test: commands.fastTest holds a pipe, and a pipeline's status is its last program's: ennyn test runs it and records no run; npm test | tail"]]);
  assert.deepEqual((await said({ commands: { fastTest: "npm test", wholeTest: "npm test 2>&1 | tee log" } })).map((i) => i.slice(0, 2)), [["warn", "doctor.testPipe"]]);
  assert.deepEqual((await said({ commands: { fastTest: "npm test" } })).map((i) => i.slice(0, 2)), [["warn", "doctor.wholeTestUnset"]]);
  assert.deepEqual(await said({ commands: { fastTest: "npm test", wholeTest: "npm test || echo failed >&2" } }), [["fail", "doctor.wholeTestNoop", "whole test: npm test || echo failed >&2 exits 0 whatever runs, so ennyn test whole records green for any push: set commands.wholeTest to the command that runs the tests"]]);
  // Turkish is its own text.
  for (const key of ["doctor.testPipe", "doctor.wholeTestUnset"]) assert.notEqual(tShown(key, { label: "x", key: "commands.fastTest", command: "a | b" }, "tr"), tShown(key, { label: "x", key: "commands.fastTest", command: "a | b" }, "en"), key);
});

test("doctor: a declaring folder git or the disk will not open is unmeasured, not \"declares none\"", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const r = setup({}, { nodes: [{ id: "a" }] });
  put(r.dir, { "scripts/test.sh": "#!/bin/sh\n" });
  chmodSync(join(r.dir, "scripts"), 0o000);
  try {
    const items = (await checkSetup({ cwd: r.dir, env: {} })).items.filter((i) => i.key.startsWith("doctor.fastTest"));
    assert.deepEqual(items.map((i) => [i.level, i.key]), [["warn", "doctor.fastTestUnread"]]);
    assert.match(String(items[0].vars.why), /EACCES/);
  } finally {
    chmodSync(join(r.dir, "scripts"), 0o755);
  }
});

test("doctor: a null node or a module graph that does not load is a ✗ line, not a crash", async () => {
  const nullNode = setup({ commands: { fastTest: "npm test" } }, { nodes: [{ id: "a" }, null] });
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
  const r = setup({ commands: { fastTest: "npm test" } }, { nodes: [{ id: "a" }] });
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
  const r = setup({ commands: { fastTest: "npm test" } }, { nodes: [{ id: "a" }, { id: "a" }] });
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
  // security.secrets is on by default, and only the hook checks it: with no hook, a warning; no ask rule for a
  // push, the other.
  assert.match(doc.stdout, /^! commit-msg hook: none, so these are rules on paper: security\.secrets; run ennyn install-hook$/m);
  assert.match(doc.stdout, /^! ask rules: no ask or deny rule for Bash\(git push \*\), PowerShell\(git push \*\), .*, \+\d+ in \.claude\/settings\.json; add them to permissions\.ask \(\/ennyn:init proposes them\)$/m);
  // No .gitignore: git does not ignore where Claude Code puts agent worktrees.
  assert.match(doc.stdout, /^! agent worktrees: git does not ignore \.claude\/worktrees\/, where Claude Code puts agent worktrees: .*; add \.claude\/worktrees\/ to \.gitignore and commit it \(\/ennyn:init proposes the line\)$/m);
  // No settings: the agent as it is, and no Read deny rule for .env*, ~/.ssh or ~/.aws (setup/secret-setup.mjs).
  assert.match(doc.stdout, /^✓ agent mode: as it is\. /m);
  assert.match(doc.stdout, /^! agent setup: no Read deny rule Read\(\.env\*\), Read\(~\/\.ssh\/\*\*\), Read\(~\/\.aws\/\*\*\) in the settings files; /m);
  // No whole test command: ennyn test whole would run nothing.
  assert.match(doc.stdout, /^! whole test: commands\.wholeTest is unset, /m);
  assert.match(doc.stdout, /^problems: 1 · warnings: 5 · unmeasured: 1$/m, "the one unmeasured: too few commits for the fix label");
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
  // As many Turkish as English subjects: English, the default language (scan audit 54).
  const tie = commitStyle(["fix: the crash", "feat: add the page", "docs: note for users", "düzeltme: liste", "ekle: yeni sayfa", "temizlik: eski kod"]);
  assert.deepEqual([tie.language.guess, tie.language.tr, tie.language.en], ["en", 3, 3]);
});

test("doctor: a fix label that misses a form the commit gate admits warns, naming that form (doctor-label-misses-bang, doctor-custom-label-misses-bang)", async () => {
  const graph = { nodes: [{ id: "a" }] };
  const checked = async (/** @type {any} */ commitMsg, /** @type {string} */ fixSubject) => {
    const res = await checkSetup({ cwd: setup({ commitMsg, metrics: { fixSubject } }, graph).dir, env: {} });
    return res.items.filter((i) => /fix(Type|Bang)Unseen/.test(i.key)).map((i) => [i.level, i.key, i.vars.forms]);
  };
  const bang = (/** @type {string[]} */ ...forms) => [["warn", "doctor.fixBangUnseen", forms]];
  const plain = (/** @type {string[]} */ ...forms) => [["warn", "doctor.fixTypeUnseen", forms]];
  const fix = { types: ["feat", "fix"], fixType: "fix" };
  const custom = { types: ["özellik", "düzeltme"], fixType: "düzeltme" };
  assert.deepEqual(await checked(fix, "^fix(\\(|:)"), bang("fix!: …"), "doctor-label-misses-bang");
  assert.deepEqual(await checked(custom, "^düzeltme(\\(|:)"), bang("düzeltme!: …"), "doctor-custom-label-misses-bang");
  // Each form is its own: these read fix!: and miss only fix(x)!:, and this one misses both.
  assert.deepEqual(await checked(fix, "^fix(!?:|\\([^)]*\\):)"), bang("fix(x)!: …"));
  assert.deepEqual(await checked(fix, "^fix!?:|^fix\\([^)]*\\):"), bang("fix(x)!: …"));
  assert.deepEqual(await checked(fix, "^fix(\\([^)]*\\))?:"), bang("fix!: …", "fix(x)!: …"));
  assert.deepEqual(await checked(fix, "^fix(\\(|!?:)"), [], "the default reads all four");
  assert.deepEqual(await checked(custom, "^düzeltme(\\(|!?:)"), [], "what /ennyn:init writes reads all four");
  // A label that misses a plain form is told that, once, and only what it misses.
  assert.deepEqual(await checked(fix, "^bug:"), plain("fix: …", "fix(x): …"));
  assert.deepEqual(await checked(fix, "^fix:"), plain("fix(x): …"));
  assert.deepEqual(await checked(fix, "^fix\\("), plain("fix: …"));
  const vars = { pattern: "^fix(!?:|\\([^)]*\\):)", forms: ["fix(x)!: …"] };
  assert.match(tShown("doctor.fixBangUnseen", vars, "en"), /does not match fix\(x\)!: …, which the commit gate admits/);
  assert.doesNotMatch(tShown("doctor.fixBangUnseen", vars, "en"), /fix!: …/, "no form the label reads");
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
  // The context the closing names for the next cycle, said as the config holds it.
  assert.deepEqual(free.items.find((i) => i.key === "doctor.afterCycle")?.vars, { mode: "fresh" });
  const compact = await checkSetup({ cwd: setup({ context: { afterCycle: "compact" } }, { nodes: [{ id: "a" }] }).dir, env: {} });
  assert.deepEqual(compact.items.find((i) => i.key === "doctor.afterCycle")?.vars, { mode: "compact" });
});

/** Claude Code's own name for an agent's worktree. */
const AGENT = "agent-a0123456789abcdef";
/** Names doctor does not ask about: what the next worktree may be called. */
const NEXT = ["agent-a1b2c3d4e5f60718", "fix-login", "ab", "7-Login"];
const LINE = ".claude/worktrees/\n";
/** A real linked worktree where Claude Code puts one. @param {string} dir @param {string} [name] */
function agentWorktree(dir, name = AGENT) {
  mkdirSync(join(dir, ".claude", "worktrees"), { recursive: true });
  git(["worktree", "add", "-q", "--detach", `.claude/worktrees/${name}`, "HEAD"], { cwd: dir });
}
/** Whether git shows anything of the folder: what `git add -A` would take. @param {string} dir */
const gitLists = (dir) => git(["status", "--porcelain", "-uall"], { cwd: dir }).split("\n").some((l) => l.startsWith("?? ") && l.includes(".claude/worktrees/"));
/** doctor's reading as its level. @param {string} dir */
const verdict = (dir) => (worktreesIgnored(dir).state === "ignored" ? "ok" : "warn");
/** A repository with the sources a worktree checks out, and `text` committed as its .gitignore. @param {string} [text] */
function ignoring(text) {
  const r = repo();
  r.commit("feat: start", { "src/app.py": "1\n", "src/a.ts": "1\n", "README.md": "r\n", Makefile: "x:\n\ttrue\n" });
  if (text === undefined) return r;
  put(r.dir, { ".gitignore": text });
  git(["add", "-f", ".gitignore"], { cwd: r.dir });
  r.commit("chore: ignore");
  return r;
}
/** `files` committed as they are, whatever the lists say of them. @param {string} dir @param {Record<string, string>} files */
function commitForced(dir, files) {
  put(dir, files);
  git(["add", "-f", "--", ...Object.keys(files)], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore: files"], { cwd: dir });
}
/** A worktree in a fresh clone of `dir`, with nothing of this repository's own: what the next checkout does. @param {string} dir */
function cloneLists(dir) {
  const clone = mkdtempSync(join(tmpdir(), "en-wt-clone-"));
  git(["clone", "-q", dir, "."], { cwd: clone });
  agentWorktree(clone, "fix-login");
  return gitLists(clone);
}
/** Every file below `dir`, with its time and bytes. @param {string} dir @returns {[string, string][]} */
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? snapshot(path) : [/** @type {[string, string]} */ ([path, `${statSync(path).mtimeMs} ${readFileSync(path).toString("base64")}`])];
  });
}
/** `read` with these variables set, as the process that runs doctor has them. @template T @param {Record<string, string>} vars @param {() => T} read */
function withEnv(vars, read) {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return read();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("doctor: HEAD's lists read as git treats the next worktree, of any name, before one is there and with some (agent-worktrees-ignored)", () => {
  const ignored = [
    ".claude/worktrees/\n", ".claude/worktrees\n", "/.claude/worktrees/\n", ".claude/worktrees/*\n", ".claude/worktrees/**\n", ".claude/worktrees/*/\n", ".claude/worktrees/**/*\n",
    ".claude/\n", ".claude/*\n!.claude/settings.json\n", ".claude/\n!.claude/worktrees/\n", "**/.claude/worktrees/\n", "worktrees/\n", "worktrees\n", ".*\n!.gitignore\n", "*\n!.gitignore\n!src/\n",
    ".claude/worktrees/*\n!.claude/worktrees/keep/\n", ".claude/worktrees/*\n!.claude/worktrees/x/\n", ".claude/**\n!.claude/*/\n", ".claude/worktrees/   \n", ".claude/worktrees/\r\n",
  ];
  const listed = [
    "", "# .claude/worktrees/\n", ".claude/worktrees/ # agents\n", "\\!.claude/worktrees/\n",
    // A name that hits a probe's own, not the folder.
    "x\n", "x/\n", "**/x\n", "?\n", "[a-z]\n", "x*\n", "*.log\n!x\n", ".claude/worktrees/x\n", ".claude/worktrees/x/\n", ".claude/**/x\n",
    // Allow lists: directories stay, so git lists a worktree whatever its files are.
    "*\n!*/\n", "*\n!*/\n!*.py\n!*.ts\n!*.md\n", "*\n!.gitignore\n!*/\n!*.py\n", "*\n!*.*\n!*/\n", "*\n!*/\n!Makefile\n", "*.py\n*.ts\n*.md\nMakefile\n",
    // The folder stays, only what it holds is named: a linked worktree holds a .git file, and git lists it whole.
    ".claude/worktrees/*/*\n", ".claude/worktrees/*/**\n", ".claude/worktrees/*\n!.claude/worktrees/*/\n", ".claude/worktrees/**\n!.claude/worktrees/**/\n",
    // Negations.
    ".claude/*\n!.claude/worktrees/\n", ".claude/worktrees/*\n!.claude/worktrees/agent-*\n",
    // Names and shapes of names: each holds some worktrees and leaves others out.
    "tmp/\n", "feature-one/\n", ".claude/worktrees/feature-one/\n", ".claude/worktrees/feature-*\n", ".claude/worktrees/agent-*\n", ".claude/worktrees/agent-*/\n", "agent-*/\n", ".claude/worktrees/a*\n",
    ".claude/worktrees/*-*\n", "*-*/\n", ".claude/worktrees/?????*\n", ".claude/worktrees/[a-z]*\n",
  ];
  for (const [texts, want, lists] of /** @type {[string[], string, boolean][]} */ ([[ignored, "ok", false], [listed, "warn", true]])) {
    for (const text of texts) {
      const r = ignoring(text);
      assert.equal(verdict(r.dir), want, `${JSON.stringify(text)}, no worktree yet`);
      for (const name of NEXT) agentWorktree(r.dir, name);
      assert.equal(gitLists(r.dir), lists, `${JSON.stringify(text)}: git itself`);
      assert.equal(verdict(r.dir), want, `${JSON.stringify(text)}, with worktrees`);
    }
  }
  // What is on the disk today stands for no other name: a worktree the pattern holds, then the next one.
  for (const [text, name] of [["tmp/\n", "tmp"], ["feature-*\n", "feature-one"], [".claude/worktrees/feature-*\n", "feature-one"], ["*-*\n", "feature-one"], [".claude/worktrees/agent-*\n", AGENT], [".claude/worktrees/?????*\n", "feature-one"]]) {
    const r = ignoring(text);
    agentWorktree(r.dir, name);
    assert.deepEqual([gitLists(r.dir), worktreesIgnored(r.dir).state], [false, "none"], `${text} with ${name} on the disk`);
    agentWorktree(r.dir, "ab");
    assert.deepEqual([gitLists(r.dir), worktreesIgnored(r.dir).state], [true, "listed"], `${text}, the next worktree`);
  }
  // A folder of the pattern's name, with no .git.
  const tmp = ignoring("tmp/\n");
  put(tmp.dir, { ".claude/worktrees/tmp/a.txt": "1\n" });
  assert.deepEqual([gitLists(tmp.dir), worktreesIgnored(tmp.dir).state], [false, "none"]);
  // The reverse: every name but one, with that one here. The list holds; what this checkout has is said.
  const kept = ignoring(".claude/worktrees/*\n!.claude/worktrees/feature-one/\n");
  assert.equal(verdict(kept.dir), "ok");
  agentWorktree(kept.dir, "feature-one");
  assert.deepEqual([gitLists(kept.dir), worktreesIgnored(kept.dir).state], [true, "listed"]);
  // The first folder the list leaves open is said: here one with no pattern at all.
  assert.equal(worktreesIgnored(ignoring(".claude/worktrees/agent-*\n!.claude/worktrees/agent-a0*\n").dir).state, "none");
  // A file in the folder is no worktree: it says nothing of the folders that will come.
  const stray = ignoring(".claude/worktrees/*.txt\n");
  put(stray.dir, { ".claude/worktrees/notes.txt": "n\n" });
  assert.deepEqual([gitLists(stray.dir), verdict(stray.dir)], [false, "warn"]);
  // A plain copy holds no .git, so git goes through its files; the lists are held to a worktree's rule.
  const copy = ignoring(".claude/worktrees/*/*\n");
  put(copy.dir, { ".claude/worktrees/copy/src/a.js": "1\n", ".claude/worktrees/copy/b.js": "1\n" });
  assert.deepEqual([gitLists(copy.dir), worktreesIgnored(copy.dir).state], [false, "none"]);
  // git reads no .gitignore through a link, on the disk or in HEAD; a link's blob holds its target, no pattern.
  for (const [at, target] of [[".gitignore", "ignore.txt"], [".gitignore", ".claude/worktrees/"], [".claude/.gitignore", "../ignore.txt"], [".claude/.gitignore", "worktrees/"], [".claude/worktrees/.gitignore", "../../ignore.txt"], [".claude/worktrees/.gitignore", "*"]]) {
    const linked = ignoring();
    put(linked.dir, { "ignore.txt": LINE });
    mkdirSync(dirname(join(linked.dir, at)), { recursive: true });
    symlinkSync(target, join(linked.dir, at));
    linked.commit("chore: a linked ignore file");
    assert.equal(worktreesIgnored(linked.dir).state, "none", at);
    assert.equal(cloneLists(linked.dir), true, at);
  }
});

test("doctor: only HEAD's lists count, whatever this checkout and this machine do with the file (agent-worktrees-ignored)", () => {
  const unstaged = (/** @type {string} */ bit) => (/** @type {ReturnType<typeof repo>} */ r) => {
    r.commit("chore: ignore", { ".gitignore": "dist/\n" });
    git(["update-index", bit, ".gitignore"], { cwd: r.dir });
    put(r.dir, { ".gitignore": `dist/\n${LINE}` });
  };
  /** @type {[string, (r: ReturnType<typeof repo>) => void][]} */
  const local = [
    ["a .gitignore git does not track", (r) => put(r.dir, { ".gitignore": LINE })],
    ["a new .gitignore, staged", (r) => (put(r.dir, { ".gitignore": LINE }), git(["add", ".gitignore"], { cwd: r.dir }))],
    ["the line only in the work tree", (r) => (r.commit("chore: ignore", { ".gitignore": "dist/\n" }), put(r.dir, { ".gitignore": `dist/\n${LINE}` }))],
    ["the line staged", (r) => (r.commit("chore: ignore", { ".gitignore": "dist/\n" }), put(r.dir, { ".gitignore": `dist/\n${LINE}` }), git(["add", ".gitignore"], { cwd: r.dir }))],
    ["a file in .claude/ with the line only here", (r) => (r.commit("chore: ignore", { ".claude/.gitignore": "dist/\n" }), put(r.dir, { ".claude/.gitignore": "dist/\nworktrees/\n" }))],
    ["skip-worktree, the line only on the disk", unstaged("--skip-worktree")],
    ["assume-unchanged, the line only on the disk", unstaged("--assume-unchanged")],
    [".git/info/exclude", (r) => writeFileSync(join(r.dir, ".git", "info", "exclude"), "# claude-code-runtime\n**/.claude/worktrees/\n")],
    ["a tracked .gitignore elsewhere, named by core.excludesFile", (r) => (r.commit("chore: list", { "tools/.gitignore": LINE }), git(["config", "core.excludesFile", "tools/.gitignore"], { cwd: r.dir }))],
    ["a tracked file by another name, named by core.excludesFile", (r) => (r.commit("chore: list", { "team.ignore": LINE }), git(["config", "core.excludesFile", "team.ignore"], { cwd: r.dir }))],
    ["a listed name, read as core.excludesFile", (r) => (commitForced(r.dir, { ".claude/.gitignore": LINE }), git(["config", "core.excludesFile", ".claude/.gitignore"], { cwd: r.dir }))],
    ["a .gitignore that ignores itself", (r) => put(r.dir, { ".gitignore": `.gitignore\n${LINE}` })],
    ["a .gitignore git does not track, where status is told to hide such files", (r) => (put(r.dir, { ".gitignore": LINE }), git(["config", "status.showUntrackedFiles", "no"], { cwd: r.dir }))],
  ];
  for (const [id, prepare] of local) {
    const r = ignoring();
    prepare(r);
    assert.equal(worktreesIgnored(r.dir).state, "local", `${id}, no worktree yet`);
    agentWorktree(r.dir);
    assert.deepEqual([gitLists(r.dir), cloneLists(r.dir)], [false, true], `${id}: ignored here, not in a clone`);
    assert.equal(worktreesIgnored(r.dir).state, "local", `${id}, with a worktree`);
  }
  // The other way: HEAD holds the line, whatever this checkout did to the file.
  /** @type {[string, (r: ReturnType<typeof repo>) => void][]} */
  const held = [
    ["another line, not staged", (r) => put(r.dir, { ".gitignore": `${LINE}*.tmp\n` })],
    ["another line, staged", (r) => (put(r.dir, { ".gitignore": `${LINE}*.tmp\n` }), git(["add", ".gitignore"], { cwd: r.dir }))],
    ["a comment above it", (r) => put(r.dir, { ".gitignore": `# agents\n${LINE}` })],
    ["the mode changed", (r) => chmodSync(join(r.dir, ".gitignore"), 0o755)],
    ["an untracked .gitignore below it that says the same", (r) => put(r.dir, { ".claude/.gitignore": "worktrees/\n" })],
    ["taken off the disk by a sparse checkout", (r) => (git(["update-index", "--skip-worktree", ".gitignore"], { cwd: r.dir }), rmSync(join(r.dir, ".gitignore")))],
    ["skip-worktree over a copy with no line", (r) => (git(["update-index", "--skip-worktree", ".gitignore"], { cwd: r.dir }), put(r.dir, { ".gitignore": "dist/\n" }))],
    ["the line taken out, not committed, and no worktree yet", (r) => put(r.dir, { ".gitignore": "\n" })],
    ["checked out with CRLF", (r) => {
      git(["config", "core.autocrlf", "true"], { cwd: r.dir });
      rmSync(join(r.dir, ".gitignore"));
      git(["checkout", "--", ".gitignore"], { cwd: r.dir });
      assert.equal(readFileSync(join(r.dir, ".gitignore"), "utf8"), ".claude/worktrees/\r\n");
    }],
  ];
  for (const [id, prepare] of held) {
    const r = ignoring(LINE);
    prepare(r);
    assert.deepEqual(worktreesIgnored(r.dir), { state: "ignored", source: ".gitignore", line: 1, pattern: ".claude/worktrees/" }, id);
    assert.equal(cloneLists(r.dir), false, id);
  }
  // Each of the three files a clone gets, with an edit that is not the line beside it.
  for (const [file, text, source] of [[".gitignore", LINE, ".gitignore"], [".claude/.gitignore", "worktrees/\n", ".claude/.gitignore"], [".claude/worktrees/.gitignore", "*\n", ".claude/worktrees/.gitignore"]]) {
    const r = ignoring();
    commitForced(r.dir, { [file]: text });
    put(r.dir, { [file]: `${text}# a note\n` });
    assert.deepEqual(worktreesIgnored(r.dir), { state: "ignored", source, line: 1, pattern: text.trim() }, file);
    agentWorktree(r.dir);
    assert.deepEqual([gitLists(r.dir), verdict(r.dir), cloneLists(r.dir)], [false, "ok", false], file);
  }
  // What this checkout lists is said even where HEAD's lists hold: the line taken out here, and a worktree here.
  const taken = ignoring(LINE);
  put(taken.dir, { ".gitignore": "\n" });
  agentWorktree(taken.dir);
  assert.deepEqual([gitLists(taken.dir), worktreesIgnored(taken.dir).state], [true, "listed"]);
  // A negation HEAD holds decides it, whatever this checkout did to it: a list below the top one has the last word.
  const gone = ignoring();
  commitForced(gone.dir, { ".gitignore": LINE, ".claude/.gitignore": "!worktrees/\n" });
  assert.deepEqual(worktreesIgnored(gone.dir), { state: "negated", source: ".claude/.gitignore", line: 1, pattern: "!worktrees/" });
  assert.equal(cloneLists(gone.dir), true);
  rmSync(join(gone.dir, ".claude", ".gitignore"));
  assert.equal(worktreesIgnored(gone.dir).state, "local", "ignored here with the negation gone, not by HEAD");
  const below = ignoring();
  commitForced(below.dir, { ".gitignore": ".claude/worktrees/*\n", ".claude/worktrees/.gitignore": "!*\n" });
  assert.deepEqual(worktreesIgnored(below.dir), { state: "negated", source: ".claude/worktrees/.gitignore", line: 1, pattern: "!*" });
  rmSync(join(below.dir, ".claude", "worktrees", ".gitignore"));
  assert.equal(worktreesIgnored(below.dir).state, "local", "ignored here with the negation gone, not by HEAD");
  // What HEAD holds, objects as they are: a replace ref reaches no clone.
  const replaced = ignoring("dist/\n");
  git(["replace", git(["rev-parse", "HEAD:.gitignore"], { cwd: replaced.dir }), git(["hash-object", "-w", "--stdin"], { cwd: replaced.dir, input: LINE })], { cwd: replaced.dir });
  assert.equal(worktreesIgnored(replaced.dir).state, "none");
  // No commit yet: HEAD holds no list, whatever is staged.
  const unborn = repo();
  assert.equal(worktreesIgnored(unborn.dir).state, "none");
  put(unborn.dir, { ".gitignore": LINE });
  assert.equal(worktreesIgnored(unborn.dir).state, "local");
  git(["add", ".gitignore"], { cwd: unborn.dir });
  assert.equal(worktreesIgnored(unborn.dir).state, "local");
  // A linked worktree: Claude Code's folder is at the main checkout's top, so its HEAD is the one read.
  const main = ignoring();
  const side = join(mkdtempSync(join(tmpdir(), "en-wt-side-")), "side");
  git(["worktree", "add", "-q", "-b", "side", side], { cwd: main.dir });
  commitForced(side, { ".gitignore": LINE });
  assert.equal(worktreesIgnored(side).state, "local", "the branch holds the line, the main checkout's HEAD does not");
  commitForced(main.dir, { ".gitignore": `dist/\n${LINE}` });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "-m", "chore: other", "--allow-empty"], { cwd: side });
  git(["rm", "-q", "-f", ".gitignore"], { cwd: side });
  assert.deepEqual(worktreesIgnored(side), { state: "ignored", source: ".gitignore", line: 2, pattern: ".claude/worktrees/" }, "the main checkout's HEAD holds it, this branch does not");
  assert.equal(worktreesIgnored(main.dir).state, "ignored");
  // The main checkout on a branch with no commit yet: its HEAD holds no list, whatever this branch holds.
  const orphan = ignoring(LINE);
  const sideOrphan = join(mkdtempSync(join(tmpdir(), "en-wt-side-")), "side");
  git(["worktree", "add", "-q", "-b", "side", sideOrphan], { cwd: orphan.dir });
  git(["checkout", "-q", "--orphan", "fresh"], { cwd: orphan.dir });
  assert.equal(worktreesIgnored(sideOrphan).state, "local");
  // Doctor's real listing is of this checkout: the main checkout's worktrees are not this one's to list.
  const open = ignoring();
  const sideOpen = join(mkdtempSync(join(tmpdir(), "en-wt-side-")), "side");
  git(["worktree", "add", "-q", "-b", "side", sideOpen], { cwd: open.dir });
  agentWorktree(open.dir);
  assert.equal(worktreesIgnored(open.dir).state, "listed");
  assert.equal(worktreesIgnored(sideOpen).state, "none");
  // A file where the folder would be: no worktree can come, and git still answers.
  for (const [file, text, state] of [[".claude", "", "none"], [".claude/worktrees", "", "none"], [".claude", LINE, "ignored"]]) {
    const r = ignoring(text || undefined);
    r.commit("chore: a file", { [file]: "a file\n" });
    assert.equal(worktreesIgnored(r.dir).state, state, file);
    const untracked = ignoring(text || undefined);
    put(untracked.dir, { [file]: "a file\n" });
    assert.equal(worktreesIgnored(untracked.dir).state, state, `${file}, untracked`);
  }
});

test("doctor: what the index holds in the folder: a worktree's files and a gitlink are said, a plain file directly in it holds no worktree (agent-worktrees-ignored)", () => {
  // One the rules cannot undo: git keeps tracking what it holds there, a line or not. A gitlink has no / below it.
  const link = ignoring();
  agentWorktree(link.dir);
  git(["add", "-A"], { cwd: link.dir });
  link.commit("feat: an agent's work", { ".gitignore": LINE });
  assert.deepEqual(worktreesIgnored(link.dir), { state: "tracked", paths: [`.claude/worktrees/${AGENT}`] });
  const file = ignoring();
  file.commit("feat: a file", { ".claude/worktrees/feature-one/a.js": "1\n" });
  file.commit("chore: ignore", { ".gitignore": LINE });
  assert.deepEqual(worktreesIgnored(file.dir), { state: "tracked", paths: [".claude/worktrees/feature-one/a.js"] });
  // The folder itself a submodule.
  const sub = ignoring();
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", ignoring().dir, ".claude/worktrees"], { cwd: sub.dir });
  sub.commit("feat: a submodule");
  assert.deepEqual(worktreesIgnored(sub.dir), { state: "tracked", paths: [".claude/worktrees"] });
  // A conflict lists a path by stage, and it is one path.
  const merged = ignoring();
  merged.commit("feat: a file", { ".claude/worktrees/a/f.js": "0\n" });
  git(["checkout", "-q", "-b", "other"], { cwd: merged.dir });
  merged.commit("feat: other", { ".claude/worktrees/a/f.js": "1\n" });
  git(["checkout", "-q", "main"], { cwd: merged.dir });
  merged.commit("feat: main", { ".claude/worktrees/a/f.js": "2\n" });
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "other"], { cwd: merged.dir }).status, 1);
  assert.deepEqual(worktreesIgnored(merged.dir), { state: "tracked", paths: [".claude/worktrees/a/f.js"] });
  // Plain files directly in the folder: the usual ways to keep it, each with its list.
  /** @type {[Record<string, string>, string, string, number][]} */
  const keeps = [
    [{ ".gitignore": ".claude/worktrees/*\n!.claude/worktrees/.gitkeep\n", ".claude/worktrees/.gitkeep": "" }, ".gitignore", ".claude/worktrees/*", 1],
    [{ ".gitignore": ".claude/worktrees/*\n!.claude/worktrees/README.md\n", ".claude/worktrees/README.md": "why\n" }, ".gitignore", ".claude/worktrees/*", 1],
    [{ ".gitignore": LINE, ".claude/worktrees/README.md": "why\n" }, ".gitignore", ".claude/worktrees/", 1],
    [{ ".claude/worktrees/.gitignore": "*\n!.gitignore\n" }, ".claude/worktrees/.gitignore", "*", 1],
  ];
  for (const [files, source, pattern, line] of keeps) {
    const r = ignoring();
    commitForced(r.dir, files);
    const want = { state: "ignored", source, line, pattern };
    assert.deepEqual(worktreesIgnored(r.dir), want, Object.keys(files).join());
    agentWorktree(r.dir);
    assert.deepEqual(worktreesIgnored(r.dir), want, `${Object.keys(files).join()}, with a worktree`);
    // A keep file changed is no listing.
    const keep = /** @type {string} */ (Object.keys(files).at(-1));
    put(r.dir, { [keep]: `${files[keep]}# changed\n` });
    assert.deepEqual(worktreesIgnored(r.dir), want, `${keep}, changed`);
  }
  // A keep file with no list: nothing ignores what comes next.
  const bare = ignoring();
  commitForced(bare.dir, { ".claude/worktrees/.gitkeep": "" });
  assert.equal(worktreesIgnored(bare.dir).state, "none");
  // A link directly in the folder holds no worktree either.
  const pointer = ignoring();
  mkdirSync(join(pointer.dir, ".claude", "worktrees"), { recursive: true });
  symlinkSync("../..", join(pointer.dir, ".claude", "worktrees", "top"));
  pointer.commit("chore: a link");
  assert.equal(worktreesIgnored(pointer.dir).state, "none");
});

test("doctor: the worktrees line says what git said, its source, its remedy; a question git does not answer is unmeasured (agent-worktrees-ignored)", async (c) => {
  /** The line in English. @param {{ key: string, vars: import("../core/i18n.mjs").Vars }} item */
  const words = (item) => t(item.key, item.vars, "en");
  /** The one worktrees line of a doctor run. @param {string} dir */
  const line = async (dir) => {
    const items = (await checkSetup({ cwd: dir, env: {} })).items.filter((i) => i.key.startsWith("doctor.worktrees"));
    assert.equal(items.length, 1, JSON.stringify(items));
    return items[0];
  };
  const path = [".claude/worktrees/"];
  const at = (/** @type {string} */ source, /** @type {number} */ n, /** @type {string} */ pattern) => ({ path, source: [source], line: n, pattern: [pattern] });
  const fresh = () => setup({}, { nodes: [{ id: "a" }] });

  // No .claude folder, and none made: HEAD's lists are asked in a repository of their own.
  const none = fresh();
  assert.deepEqual(await line(none.dir), { level: "warn", key: "doctor.worktreesNotIgnored", vars: { path } });
  assert.equal(existsSync(join(none.dir, ".claude")), false);
  assert.match(words(await line(none.dir)), /add \.claude\/worktrees\/ to \.gitignore and commit it/);

  // The ✓ says HEAD's list, and promises nothing of a clone: the commit may not be pushed.
  const committed = fresh();
  committed.commit("chore: ignore", { ".gitignore": "node_modules/\n.claude/worktrees/\n" });
  assert.deepEqual(await line(committed.dir), { level: "ok", key: "doctor.worktreesIgnored", vars: at(".gitignore", 2, ".claude/worktrees/") });
  assert.match(words(await line(committed.dir)), /^agent worktrees: \.gitignore:2 \(\.claude\/worktrees\/\), as HEAD holds it, ignores \.claude\/worktrees\/, whatever a worktree there is called$/);
  const nested = fresh();
  nested.commit("chore: ignore", { ".claude/.gitignore": "worktrees/\n" });
  assert.deepEqual(await line(nested.dir), { level: "ok", key: "doctor.worktreesIgnored", vars: at(".claude/.gitignore", 1, "worktrees/") });

  const untracked = fresh();
  put(untracked.dir, { ".gitignore": LINE });
  assert.deepEqual(await line(untracked.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(".gitignore", 1, ".claude/worktrees/") });
  assert.match(words(await line(untracked.dir)), /^agent worktrees: only this machine ignores .*: the \.gitignore files HEAD holds do not.*; put \.claude\/worktrees\/ in \.gitignore and commit it$/);
  // The source as git names it, in the real repository.
  const exclude = fresh();
  writeFileSync(join(exclude.dir, ".git", "info", "exclude"), "**/.claude/worktrees/\n");
  assert.deepEqual(await line(exclude.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(".git/info/exclude", 1, "**/.claude/worktrees/") });
  agentWorktree(exclude.dir);
  assert.deepEqual(await line(exclude.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(".git/info/exclude", 1, "**/.claude/worktrees/") });
  // A list for folders only is read as one: a made-up name is asked as a directory.
  const folders = fresh();
  writeFileSync(join(folders.dir, ".git", "info", "exclude"), ".claude/worktrees/*/\n");
  assert.equal((await line(folders.dir)).key, "doctor.worktreesLocal");
  // Of a folder that is not there git says too much: what HEAD's lists answer in the same words is no rule of this
  // machine's, so a committed allow list reads as what it is, and a pattern for what the folders hold.
  const allow = fresh();
  allow.commit("chore: ignore", { ".gitignore": "*\n!*/\n!*.json\n!.gitignore\n" });
  assert.deepEqual(await line(allow.dir), { level: "warn", key: "doctor.worktreesNegated", vars: at(".gitignore", 2, "!*/") });
  const inside = fresh();
  inside.commit("chore: ignore", { ".gitignore": ".claude/worktrees/*/*\n" });
  assert.equal((await line(inside.dir)).key, "doctor.worktreesNotIgnored");
  writeFileSync(join(inside.dir, ".git", "info", "exclude"), "**/.claude/worktrees/\n");
  assert.deepEqual(await line(inside.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(".git/info/exclude", 1, "**/.claude/worktrees/") });
  // A rule of this machine's that un-ignores is no reason to say it ignores.
  const back = fresh();
  put(back.dir, { ".gitignore": ".claude/worktrees/*\n!.claude/worktrees/**\n" });
  assert.equal((await line(back.dir)).key, "doctor.worktreesNotIgnored");
  // A list that holds some names only is no answer for the next one.
  const some = fresh();
  writeFileSync(join(some.dir, ".git", "info", "exclude"), ".claude/worktrees/agent-*\n");
  assert.equal((await line(some.dir)).key, "doctor.worktreesNotIgnored");

  // core.excludesFile however it is named, a .gitignore by name among them: none of them reaches another clone.
  const named = join(mkdtempSync(join(tmpdir(), "en-excludes-")), ".gitignore");
  writeFileSync(named, ".claude/\n");
  const excludes = fresh();
  git(["config", "core.excludesFile", named], { cwd: excludes.dir });
  assert.deepEqual(await line(excludes.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(named, 1, ".claude/") });
  git(["config", "core.excludesFile", relative(excludes.dir, named)], { cwd: excludes.dir });
  assert.deepEqual(await line(excludes.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(relative(excludes.dir, named), 1, ".claude/") });
  // The global ignore file core.excludesFile defaults to.
  const global = join(HOME, ".config", "git", "ignore");
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(global, ".claude/worktrees\n");
  c.after(() => rmSync(global, { force: true }));
  assert.deepEqual(await line(none.dir), { level: "warn", key: "doctor.worktreesLocal", vars: at(global, 1, ".claude/worktrees") });
  // A negation there is no rule of HEAD's.
  writeFileSync(global, "!.claude/worktrees/*/\n");
  assert.equal((await line(none.dir)).key, "doctor.worktreesNotIgnored");
  rmSync(global);

  // A negation: said with its line, of a name or of the folder itself; a pattern below a negation is not one.
  const negated = fresh();
  negated.commit("chore: ignore", { ".gitignore": ".claude/worktrees/*\n!.claude/worktrees/agent-*\n" });
  assert.deepEqual(await line(negated.dir), { level: "warn", key: "doctor.worktreesNegated", vars: at(".gitignore", 2, "!.claude/worktrees/agent-*") });
  assert.match(words(await line(negated.dir)), /and commit it/);
  const folder = fresh();
  folder.commit("chore: ignore", { ".gitignore": ".claude/*\n!.claude/worktrees/\n" });
  assert.deepEqual(await line(folder.dir), { level: "warn", key: "doctor.worktreesNegated", vars: at(".gitignore", 2, "!.claude/worktrees/") });
  // A pattern that names no worktree and a negation of something else: no negation decided this.
  const other = fresh();
  other.commit("chore: ignore", { ".gitignore": "*.log\n!keep.log\n" });
  assert.equal((await line(other.dir)).key, "doctor.worktreesNotIgnored");

  // What git lists: a worktree, a stray file; the folder empty is no measurement.
  const present = fresh();
  agentWorktree(present.dir);
  put(present.dir, { ".claude/worktrees/notes.txt": "n\n" });
  assert.deepEqual(await line(present.dir), { level: "warn", key: "doctor.worktreesListed", vars: { path, n: 2, examples: [`.claude/worktrees/${AGENT}/`, ".claude/worktrees/notes.txt"] } });
  assert.match(words(await line(present.dir)), /git lists .*and commit it/);
  // A setting that hides them from status does not hide them from this line; a plain copy's files are only counted.
  git(["config", "status.showUntrackedFiles", "no"], { cwd: present.dir });
  assert.equal((await line(present.dir)).key, "doctor.worktreesListed");
  put(present.dir, Object.fromEntries(many(5, (i) => [`.claude/worktrees/copy/${i}.js`, "1\n"])));
  const counted = await line(present.dir);
  assert.deepEqual([counted.vars.n, /** @type {string[]} */ (counted.vars.examples).length], [7, 3]);
  const empty = fresh();
  mkdirSync(join(empty.dir, ".claude", "worktrees", "left-over"), { recursive: true });
  assert.equal((await line(empty.dir)).key, "doctor.worktreesNotIgnored");

  // What git tracks there; a line does not undo it, and the remedy says what does.
  const tracked = fresh();
  tracked.commit("feat: files", { ".claude/worktrees/.gitignore": "", ...Object.fromEntries(many(4, (i) => [`.claude/worktrees/a/${i}.js`, "1\n"])) });
  tracked.commit("chore: ignore", { ".gitignore": LINE });
  assert.deepEqual(await line(tracked.dir), { level: "warn", key: "doctor.worktreesTracked", vars: { path, n: 4, examples: [0, 1, 2].map((i) => `.claude/worktrees/a/${i}.js`) } });
  assert.match(words(await line(tracked.dir)), /git rm -r --cached/);

  // A link where the folder would be: with HEAD's line nothing more is asked; without it git does not answer for
  // the machine there, which is unmeasured, never "not ignored".
  const linked = fresh();
  symlinkSync(mkdtempSync(join(tmpdir(), "en-claude-elsewhere-")), join(linked.dir, ".claude"));
  const said = await line(linked.dir);
  assert.equal(`${said.level} ${said.key}`, "unmeasured doctor.worktreesUnmeasured");
  assert.match(String(said.vars.error), /beyond a symbolic link/);
  linked.commit("chore: ignore", { ".gitignore": LINE });
  assert.equal((await line(linked.dir)).key, "doctor.worktreesIgnored");

  /** doctor's line of `dir` as the CLI prints it, with these variables. @param {string} dir @param {NodeJS.ProcessEnv} [vars] */
  const printed = (dir, vars = {}) => spawnSync(process.execPath, [CLI, "doctor"], { cwd: dir, env: { ...process.env, ...vars }, encoding: "utf8" }).stdout;
  const scratchLeft = () => readdirSync(tmpdir()).filter((f) => f.startsWith("ennyn-worktrees-"));
  assert.deepEqual(scratchLeft(), []);

  // No scratch repository: said, naming what failed, and what git lists here is still a warning.
  const blocked = mkdtempSync(join(tmpdir(), "en-wt-blocked-"));
  const places = [["a file", join(blocked, "file"), /ENOTDIR/], ["missing", join(blocked, "missing"), /ENOENT/]];
  writeFileSync(join(blocked, "file"), "");
  if (process.getuid?.() !== 0) {
    mkdirSync(join(blocked, "read-only"));
    chmodSync(join(blocked, "read-only"), 0o555);
    c.after(() => chmodSync(join(blocked, "read-only"), 0o755));
    places.push(["read-only", join(blocked, "read-only"), /EACCES/]);
  }
  const held = fresh();
  held.commit("chore: ignore", { ".gitignore": LINE });
  const real = fresh();
  agentWorktree(real.dir);
  for (const [id, dir, why] of /** @type {[string, string, RegExp][]} */ (places)) {
    const out = printed(held.dir, { TMPDIR: dir });
    assert.match(out, /^\? agent worktrees: whether git ignores \.claude\/worktrees\/ is unmeasured: the scratch repository in .* failed: /m, id);
    assert.match(out.split("\n").find((l) => l.includes("agent worktrees")) ?? "", why, id);
    assert.match(printed(real.dir, { TMPDIR: dir }), /^! agent worktrees: git lists 1 paths in \.claude\/worktrees\//m, id);
  }

  // A git that fails says so on the line, whichever call it is; no failure reads as "not ignored". The scratch
  // repository goes on every exit.
  const r = fresh();
  r.commit("chore: ignore", { ".gitignore": LINE });
  const bin = mkdtempSync(join(tmpdir(), "en-wt-bin-"));
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  for (const sub of ["ls-files", "status", "ls-tree", "cat-file", "init", "check-ignore"]) {
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${sub} "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const out = printed(r.dir, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    assert.match(out, /^\? agent worktrees: whether git ignores \.claude\/worktrees\/ is unmeasured: .*injected/m, `${sub}: ${out}`);
    assert.deepEqual(scratchLeft(), [], sub);
  }
  // The real repository's check-ignore is asked only when HEAD's lists do not hold: it says this machine's part.
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" check-ignore "*" -n "*) case " $PWD/ " in *ennyn-worktrees-*) ;; *) echo "fatal: injected" >&2; exit 128 ;; esac ;; esac\nexec "${realGit}" "$@"\n`);
  assert.match(printed(fresh().dir, { PATH: `${bin}${delimiter}${process.env.PATH}` }), /^\? agent worktrees: .*injected/m);
  assert.match(printed(r.dir, { PATH: `${bin}${delimiter}${process.env.PATH}` }), /^✓ agent worktrees: /m);

  // A reading: the real git dir stays as it was, though a file with a new time would have status refresh the index,
  // and no fsmonitor of the project's runs: the scratch repository reads no config of it, and the calls here turn
  // it off (an empty value: the floor's git takes `false` for a program's name).
  const quiet = ignoring();
  put(quiet.dir, { ".gitignore": LINE });
  const log = join(mkdtempSync(join(tmpdir(), "en-wt-fsmonitor-")), "log");
  const hook = `${log}.sh`;
  writeFileSync(hook, `#!/bin/sh\necho ran >> "${log}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  git(["config", "core.fsmonitor", hook], { cwd: quiet.dir });
  utimesSync(join(quiet.dir, "README.md"), new Date(1), new Date(1));
  const before = snapshot(join(quiet.dir, ".git"));
  assert.equal(worktreesIgnored(quiet.dir).state, "local", "every real call made: the index, the listing, the machine's rule");
  assert.deepEqual(snapshot(join(quiet.dir, ".git")), before, "the git dir was written");
  // The floor's git would run this one for `core.fsmonitor=false`.
  const programs = mkdtempSync(join(tmpdir(), "en-wt-false-"));
  writeFileSync(join(programs, "false"), `#!/bin/sh\necho ran >> "${log}"\nexit 1\n`);
  chmodSync(join(programs, "false"), 0o755);
  assert.equal(withEnv({ PATH: `${programs}${delimiter}${process.env.PATH}` }, () => worktreesIgnored(quiet.dir).state), "local");
  assert.equal(existsSync(log), false, "the project's fsmonitor ran");
  // Plain git: core/git.mjs's calls carry the guard this is the control of.
  spawnSync("git", ["status"], { cwd: quiet.dir });
  assert.equal(existsSync(log), true, "the hook is wired: a plain status runs it");

  // Nothing of this machine's reaches HEAD's lists: git's own variables, a template, a global config.
  const clean = ignoring();
  const ignoreAll = join(mkdtempSync(join(tmpdir(), "en-wt-all-")), "all");
  writeFileSync(ignoreAll, "*\n");
  const template = mkdtempSync(join(tmpdir(), "en-wt-template-"));
  put(template, { "info/exclude": "**/.claude/worktrees/\n" });
  const config = join(template, "config");
  writeFileSync(config, `[core]\n\texcludesFile = ${ignoreAll}\n`);
  assert.equal(withEnv({ GIT_TEMPLATE_DIR: template }, () => worktreesIgnored(clean.dir).state), "none", "a template's info/exclude");
  // The machine's own default template, which a test cannot write: a git that finds this one first stands for it.
  const finds = mkdtempSync(join(tmpdir(), "en-wt-finds-"));
  writeFileSync(join(finds, "git"), `#!/bin/sh\nGIT_TEMPLATE_DIR="${template}" exec "${realGit}" "$@"\n`);
  chmodSync(join(finds, "git"), 0o755);
  assert.equal(withEnv({ PATH: `${finds}${delimiter}${process.env.PATH}` }, () => worktreesIgnored(clean.dir).state), "none", "a default template");
  for (const [id, vars] of /** @type {[string, Record<string, string>][]} */ ([
    ["a variable naming a key", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: ignoreAll }],
    ["git's own -c variable", { GIT_CONFIG_PARAMETERS: `'core.excludesFile=${ignoreAll}'` }],
    ["a global config", { GIT_CONFIG_GLOBAL: config }],
  ])) {
    assert.deepEqual(withEnv(vars, () => worktreesIgnored(clean.dir)), { state: "local", source: ignoreAll, line: 1, pattern: "*" }, id);
  }

  // Outside a repository there is nothing to ask.
  const outside = mkdtempSync(join(tmpdir(), "en-wt-norepo-"));
  assert.ok(!(await checkSetup({ cwd: outside, env: {} })).items.some((i) => i.key.startsWith("doctor.worktrees")));
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

test("agent setup: AGENTS.md loads in place of a folder's CLAUDE.md files when it has none, untracked ones counted from disk", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const kinds = (/** @type {Record<string, string>} */ files, /** @type {string[]} */ tracked) => {
    const dir = mkdtempSync(join(tmpdir(), "en-agents-md-"));
    put(dir, files);
    return Object.fromEntries(agentSetup(dir, tracked).instructions.map((i) => [i.path, i.loads]));
  };
  // Untracked, at the top: AGENTS.md and .claude/AGENTS.md load in every session (Claude Code 2.1.310).
  assert.deepEqual(kinds({ "AGENTS.md": "a", ".claude/AGENTS.md": "b" }, []), { "AGENTS.md": "always", ".claude/AGENTS.md": "always" });
  // An untracked CLAUDE.local.md is one of the folder's files: AGENTS.md is then not loaded.
  assert.deepEqual(kinds({ "AGENTS.md": "a", "CLAUDE.local.md": "l" }, ["AGENTS.md"]), { "CLAUDE.local.md": "always", "AGENTS.md": "other" });
  // With the top's CLAUDE.md, no AGENTS.md below loads either; a nested CLAUDE.local.md loads on demand.
  assert.deepEqual(kinds({ "CLAUDE.md": "c", "a/AGENTS.md": "a", "b/AGENTS.md": "b", "b/CLAUDE.local.md": "l", "c/.claude/AGENTS.md": "c" }, ["CLAUDE.md", "a/AGENTS.md", "b/AGENTS.md", "b/CLAUDE.local.md", "c/.claude/AGENTS.md"]), { "CLAUDE.md": "always", "b/CLAUDE.local.md": "on-demand", "a/AGENTS.md": "other", "b/AGENTS.md": "other", "c/.claude/AGENTS.md": "other" });
  // With none at the top, below it on demand where the folder holds none of its own; a rule stops nothing.
  assert.deepEqual(kinds({ ".claude/rules/r.md": "r", "a/AGENTS.md": "a", "b/AGENTS.md": "b", "b/CLAUDE.local.md": "l", "c/.claude/AGENTS.md": "c" }, ["a/AGENTS.md", "b/AGENTS.md", "b/CLAUDE.local.md", "c/.claude/AGENTS.md"]), { ".claude/rules/r.md": "always", "b/CLAUDE.local.md": "on-demand", "a/AGENTS.md": "on-demand", "b/AGENTS.md": "other", "c/.claude/AGENTS.md": "on-demand" });
  // A CLAUDE.md with no text once its HTML comments are out, or a folder of that name, is none: not loaded, and
  // AGENTS.md loads in its place.
  for (const files of [{ "CLAUDE.md": "" }, { "CLAUDE.md": " \n\n" }, { "CLAUDE.md": "<!-- note -->\n" }, { "CLAUDE.local.md": "" }, { "CLAUDE.md/x.txt": "x" }]) {
    assert.deepEqual(kinds({ ...files, "AGENTS.md": "a" }, ["AGENTS.md"]), { "AGENTS.md": "always" }, JSON.stringify(files));
  }
  // An AGENTS.md with no text loads nothing either.
  assert.deepEqual(kinds({ "AGENTS.md": "<!-- note -->\n" }, ["AGENTS.md"]), { "AGENTS.md": "other" });
  // Front matter is no text, and neither is a closed comment; a comment left open is text (Claude Code 2.1.310).
  for (const claude of ["---\nname: x\n---\n", "---\n---\n", "\uFEFF---\r\nname: x\r\n---\r\n  \r\n", "<!-- a --> \n <!-- b -->"]) {
    assert.deepEqual(kinds({ "CLAUDE.md": claude, "AGENTS.md": "a" }, ["AGENTS.md"]), { "AGENTS.md": "always" }, JSON.stringify(claude));
  }
  for (const claude of ["<!-- open\ntext", "---\nname: x\n---\nbody", "<!-- a -->b"]) {
    assert.deepEqual(kinds({ "CLAUDE.md": claude, "AGENTS.md": "a" }, ["AGENTS.md"]), { "CLAUDE.md": "always", "AGENTS.md": "other" }, JSON.stringify(claude));
  }
  // A CLAUDE.md that leads out of the repository is not read, and named; Claude Code loads it, so it keeps AGENTS.md
  // out, its bytes uncounted.
  const away = mkdtempSync(join(tmpdir(), "en-agents-away-"));
  writeFileSync(join(away, "shared.md"), "rules kept elsewhere\n");
  const linked = mkdtempSync(join(tmpdir(), "en-agents-linked-"));
  put(linked, { "AGENTS.md": "a" });
  symlinkSync(join(away, "shared.md"), join(linked, "CLAUDE.md"));
  const out = agentSetup(linked, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(out.instructions.map((i) => [i.path, i.loads]), [["AGENTS.md", "other"]]);
  assert.deepEqual(out.outside, ["CLAUDE.md"]);
  // Tracked only, for the budget every clone shares: an untracked CLAUDE.local.md keeps AGENTS.md out on this
  // machine, not in the count.
  const dir = mkdtempSync(join(tmpdir(), "en-agents-tracked-"));
  put(dir, { "AGENTS.md": "a", "CLAUDE.local.md": "l" });
  const loads = (/** @type {boolean} */ tracked) => Object.fromEntries(agentSetup(dir, ["AGENTS.md"], { tracked }).instructions.map((i) => [i.path, i.loads]));
  assert.equal(loads(false)["AGENTS.md"], "other");
  assert.equal(loads(true)["AGENTS.md"], "always");
});

test("agent setup: a tracked claude.md or agents.md is the file Claude Code loads, by its own name, where the disk ignores case, and no file it asks for where the disk tells case apart", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-agents-case-"));
  put(dir, { "claude.md": "c", "x/agents.md": "a" });
  if (!existsSync(join(dir, "CLAUDE.md"))) {
    // A disk that tells case apart: CLAUDE.md beside a tracked claude.md is its own file, the one Claude Code reads.
    put(dir, { "CLAUDE.md": "upper" });
    assert.deepEqual(agentSetup(dir, ["claude.md"]).instructions.map((i) => [i.path, i.loads]), [["CLAUDE.md", "always"]]);
    // And a nested claude.md or agents.md is no file Claude Code asks for there.
    const lower = mkdtempSync(join(tmpdir(), "en-agents-case-"));
    put(lower, { "x/claude.md": "c", "y/agents.md": "a", "CLAUDE.md": "@DOCS/s.md", "docs/s.md": "s" });
    assert.deepEqual(agentSetup(lower, ["x/claude.md", "y/agents.md", "CLAUDE.md", "docs/s.md"]).instructions.map((i) => i.path), ["CLAUDE.md"]);
    return;
  }
  // The top's claude.md keeps the nested agents.md out, as CLAUDE.md would.
  assert.deepEqual(agentSetup(dir, ["claude.md", "x/agents.md"]).instructions.map((i) => [i.path, i.loads]), [["claude.md", "always"], ["x/agents.md", "other"]]);
  const other = mkdtempSync(join(tmpdir(), "en-agents-case-"));
  put(other, { "agents.md": "a" });
  assert.deepEqual(agentSetup(other, ["agents.md"], { tracked: true }).instructions.map((i) => [i.path, i.loads]), [["agents.md", "always"]]);
  // An import in another case is the tracked file it is served by, by that file's name.
  const imported = mkdtempSync(join(tmpdir(), "en-agents-case-"));
  put(imported, { "CLAUDE.md": "@DOCS/s.md", "docs/s.md": "s" });
  assert.deepEqual(agentSetup(imported, ["CLAUDE.md", "docs/s.md"]).instructions.map((i) => [i.path, i.loads]), [["CLAUDE.md", "always"], ["docs/s.md", "always"]]);
  // Below the top too: Claude Code loads x/claude.md and y/agents.md on a Read below them (2.1.310 on macOS).
  const nested = mkdtempSync(join(tmpdir(), "en-agents-case-"));
  put(nested, { "x/claude.md": "c", "x/claude.local.md": "l", "y/agents.md": "a", "x/notes.md": "n" });
  assert.deepEqual(agentSetup(nested, ["x/claude.md", "x/claude.local.md", "x/notes.md", "y/agents.md"]).instructions.map((i) => [i.path, i.loads]), [["x/claude.md", "on-demand"], ["x/claude.local.md", "on-demand"], ["y/agents.md", "on-demand"]]);
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
  const r = setup({ commitMsg: { types: ["feat", "fix"] }, commands: { fastTest: "npm test" } }, { nodes: [{ id: "a" }] });
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
  // paths.metricsLog naming a directory (a config can name no other file than a .jsonl in .ennyn/: a directory there).
  mkdirSync(join(r.dir, ".ennyn", "dir.jsonl"), { recursive: true });
  for (const metricsLog of [".ennyn/dir.jsonl"]) {
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
  // An event of the wrong shape (null here) is said by its name, as a hooks value of the wrong type is (Claude
  // Code drops that field and keeps the file).
  assert.deepEqual([res.hooks, res.mcpServers, res.unreadable], [["SessionStart"], [], [".claude/settings.json hooks", ".claude/settings.local.json hooks.PostToolUse", ".mcp.json"]]);
  put(dir, { ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: { matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, Stop: "y", Notification: [{ matcher: "x" }], SessionStart: [hook] } }) });
  assert.deepEqual(agentSetup(dir, []).unreadable.slice(0, 3), [".claude/settings.json hooks.PreToolUse", ".claude/settings.json hooks.Stop", ".claude/settings.json hooks.Notification"]);
  // A list where an object belongs, and a null, are no hooks either.
  put(dir, { ".claude/settings.json": JSON.stringify({ hooks: [hook] }), ".claude/settings.local.json": JSON.stringify({ hooks: null }), ".mcp.json": JSON.stringify({ mcpServers: { a: {} } }) });
  const again = agentSetup(dir, []);
  assert.deepEqual([again.hooks, again.mcpServers, again.unreadable], [[], ["a"], [".claude/settings.json hooks", ".claude/settings.local.json hooks"]]);
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
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --raw ] && { printf 'not-a-hash\\000subject\\000'; exit 0; }; done\nexec '${realGit}' "$@"\n`);
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
  // The whole word is the path, trailing punctuation too, as Claude Code reads it (test/reference/claude-code.json);
  // an import named twice is listed once.
  assert.deepEqual(importsOf("see @a.md. and @b.md) then @a.md.", "docs/CLAUDE.md"), ["docs/a.md.", "docs/b.md)"]);
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
    // A long word ending in dots, and the imports kept once each (the review's inputs).
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
  const scan = () => spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
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
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", join(r.dir, ".git", "MSG")], { cwd: r.dir, encoding: "utf8", timeout: 20000, killSignal: "SIGKILL", env: { ...process.env, ENNYN_CONFIG: fifo } });
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

// push-approval-gate: a Claude Code ask rule as the backstop to the cycle's push approval. Cells named as the
// reviewers' probes of round one.
test("ask rules: a content rule counts in the forms whose reading the docs fix; a tool-wide rule and any other form do not", async () => {
  const { ruleCovers } = await import("../setup/permissions.mjs");
  // ask-plain-shared, ask-deny-colon-form, ask-nospace-star: each matches every command that starts with "git push".
  const accept = ["Bash(git push *)", "Bash(git push:*)", "Bash(git *)", "Bash(git:*)", "Bash(git push*)", "Bash(git p*)", "Bash(g*)"];
  // ask-bare-bash-*: a tool-wide rule is skipped for a sandboxed command; ask-empty-parens. The rest: an exact rule
  // (bare `git push` only), a narrower prefix, a wildcard before the end, another tool or spelling, spaces Claude
  // Code may or may not trim, a `*` tool glob, no string.
  const reject = [
    "Bash",
    "Bash(*)",
    "Bash(:*)",
    "Bash()",
    "Bash(git push)",
    "Bash(git push origin *)",
    "Bash(git push -*)",
    "Bash(git * push)",
    "Bash(git * push *)",
    "Bash(* push *)",
    "Bash(git push :*)",
    "Bash(git  push *)",
    "Bash(git pushx *)",
    "bash(git push *)",
    "Bash (git push *)",
    " Bash(git push *)",
    "Bash(git push *) ",
    "Bash(git push *",
    "Bash(git push **",
    "PowerShell(git push *)",
    "Bash(npm publish *)",
    "*",
    "",
    42,
    null,
    ["Bash(git push *)"],
  ];
  for (const r of accept) assert.equal(ruleCovers(r, "git push"), true, `accept ${r}`);
  for (const r of reject) assert.equal(ruleCovers(r, "git push"), false, `reject ${String(r)}`);
  // A push through PowerShell is checked against PowerShell rules only.
  assert.equal(ruleCovers("PowerShell(git push *)", "git push", "PowerShell"), true);
  assert.equal(ruleCovers("Bash(git push *)", "git push", "PowerShell"), false);
  assert.equal(ruleCovers("PowerShell", "git push", "PowerShell"), false);
  assert.equal(ruleCovers("Bash(npm *)", "npm publish"), true);
  assert.equal(ruleCovers("Bash(npm publish --dry-run *)", "npm publish"), false);
  assert.equal(ruleCovers("Bash(gh release create *)", "gh release"), false, "gh release upload is not asked about");
});

// destructive-ask-rules. Each accept and reject here is a reading of Claude Code's: test/reference/claude-code.json
// holds them (ask-gh-*, ask-reset-*), and compare() holds ruleCovers to them.
test("ask rules: a command that holds its own wildcard counts only under a rule Claude Code stops it with", async () => {
  const { ruleCovers, ruleFor } = await import("../setup/permissions.mjs");
  const post = "gh api *-X POST*";
  const accept = ["Bash(gh api *-X POST*)", "Bash(gh api *)", "Bash(gh api:*)", "Bash(gh *)", "Bash(gh api *-X*)", "Bash(gh api *-X *)"];
  // `gh api repos/x -X POST`: a ` *` at the end of a rule with another `*` in it does not match the bare end, and a
  // method named first or after a space misses the method placed after the path.
  const reject = ["Bash(gh api * -X POST *)", "Bash(gh api -X POST *)", "Bash(gh api *-X POST *)", "Bash(gh api *-X POST:*)", "Bash(gh api * -X POST*)", "Bash(gh api *-X POST* *)", "Bash(gh api *-X*POST*)"];
  for (const r of accept) assert.equal(ruleCovers(r, post), true, `accept ${r}`);
  for (const r of reject) assert.equal(ruleCovers(r, post), false, `reject ${r}`);
  assert.equal(ruleCovers("PowerShell(gh api *-X POST*)", post, "PowerShell"), true);
  assert.equal(ruleCovers("Bash(gh api *-X POST*)", post, "PowerShell"), false);
  // A plain command keeps its prefix reading; the wildcard forms change nothing for it.
  assert.equal(ruleCovers("Bash(git * push *)", "git push"), false);
  assert.equal(ruleCovers("Bash(git push)", "git push"), false, "matches one exact command, not every push");
  // A shell at the end of a pipe is matched whole: `sh` alone, never `sh -c` or a script.
  assert.equal(ruleCovers("Bash(sh)", "sh"), true);
  assert.equal(ruleCovers("Bash(sh *)", "sh"), true);
  assert.equal(ruleCovers("Bash(s)", "sh"), false);
  assert.equal(ruleCovers("Bash(bash)", "sh"), false);
  assert.equal(ruleFor("git push", "Bash"), "Bash(git push *)");
  assert.equal(ruleFor(post, "PowerShell"), "PowerShell(gh api *-X POST*)");
  assert.equal(ruleFor("sh", "Bash"), "Bash(sh)");
});

test("ask rules: a `:*` after another wildcard stops nothing, so it is never read as held", async () => {
  const { askRules, ruleCovers } = await import("../setup/permissions.mjs");
  const { projectFiles } = await import("../setup/scan.mjs");
  // Corpus c1, c2 of the review: with a wildcard before it Claude Code reads the colon as text (ask-colon-*).
  const nothing = [["Bash(gh api *-X:*)", "gh api *-X POST*"], ["Bash(gh api *--method:*)", "gh api *--method DELETE*"], ["Bash(gh api *-X POST:*)", "gh api *-X POST*"], ["Bash(git checkout *--:*)", "git checkout *-- *"], ["Bash(docker compose down *-v:*)", "docker compose down *-v*"], ["Bash(git reset *--hard:*)", "git reset *--hard*"]];
  for (const [rule, command] of nothing) assert.equal(ruleCovers(rule, command), false, rule);
  // With no other wildcard it stays the trailing ` *` written the older way.
  for (const [rule, command] of [["Bash(gh api:*)", "gh api *-X POST*"], ["Bash(gh:*)", "gh api *-X POST*"], ["Bash(git push:*)", "git push"], ["Bash(git checkout:*)", "git checkout *-- *"]]) assert.equal(ruleCovers(rule, command), true, rule);
  // Through what doctor reads, and doctor itself: it counts the push rules and no colon rule.
  const r = setup({}, { nodes: [{ id: "a" }] });
  r.commit("feat: ask", { ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)", "PowerShell(git push *)", "Bash(gh api *-X:*)", "Bash(gh api *--method:*)", "Bash(git checkout *--:*)"] } }) });
  const { rules } = askRules(projectFiles(r.dir), ["gh api *-X POST*", "gh api *--method DELETE*", "git checkout *-- *"]);
  assert.deepEqual(rules.filter((x) => x.tool === "Bash").map((x) => x.where), [null, null, null]);
  assert.deepEqual((await checkSetup({ cwd: r.dir, env: {} })).items.find((i) => i.key === "doctor.askOk")?.vars, { n: 2 });
});

test("ask rules: the gh commands come with a GitHub remote or with no remote at all; a project whose remotes are all elsewhere is told what that leaves", async () => {
  const { GH_COMMANDS, ghApplies, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const graph = { nodes: [{ id: "a" }] };
  const rules = (/** @type {string} */ dir) => JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: dir, encoding: "utf8" }).stdout).agentSetup.ask.rules.map((/** @type {any} */ x) => x.command);
  const missing = async (/** @type {string} */ dir) => (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.askMissing")?.vars.rules;
  assert.deepEqual([ghApplies({ github: [], others: [] }), ghApplies({ github: ["a"], others: [] }), ghApplies({ github: ["a"], others: ["b"] }), ghApplies({ github: [], others: ["b"] })], [true, true, true, false]);
  // No remote: `gh repo create x --source . --push` runs before there is one.
  const none = setup({}, graph);
  assert.deepEqual(rules(none.dir), ["git push", ...GH_COMMANDS].flatMap((c) => [c, c]));
  assert.ok((await missing(none.dir)).includes(ruleFor("gh pr merge", TOOLS[0])), "doctor follows");
  assert.doesNotMatch(spawnSync(process.execPath, [CLI, "init-scan"], { cwd: none.dir, encoding: "utf8" }).stdout, /gh commands not proposed/, "nothing to say: they are");
  // Every remote elsewhere: none proposed, none missing, and the limit said.
  const elsewhere = setup({}, graph);
  git(["remote", "add", "origin", "https://gitlab.com/a/b.git"], { cwd: elsewhere.dir });
  assert.deepEqual(rules(elsewhere.dir), ["git push", "git push"]);
  assert.deepEqual(await missing(elsewhere.dir), ["Bash(git push *)", "PowerShell(git push *)"]);
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: elsewhere.dir, encoding: "utf8" }).stdout;
  assert.match(text, /· the gh commands not proposed: every remote is on another host \(an SSH alias or an Enterprise host the scan cannot recognize reads as one\), so gh repo create and gh api run unasked\.$/m);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: elsewhere.dir, encoding: "utf8" }).stdout).agentSetup.ask.otherRemotes, ["origin"]);
  // One remote on GitHub among others is enough; so is a push URL there.
  git(["remote", "add", "up", "git@github.com:a/b.git"], { cwd: elsewhere.dir });
  assert.ok(rules(elsewhere.dir).includes("gh repo create"));
  const pushOnly = setup({}, graph);
  git(["remote", "add", "origin", "https://gitlab.com/a/b.git"], { cwd: pushOnly.dir });
  git(["remote", "set-url", "--push", "origin", "git@github.com:a/b.git"], { cwd: pushOnly.dir });
  assert.ok(rules(pushOnly.dir).includes("gh repo create"));
  const both = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: pushOnly.dir, encoding: "utf8" }).stdout).agentSetup.ask;
  assert.deepEqual([both.githubRemotes, both.otherRemotes], [["origin"], []], "one remote is on one side");
  // What the sentence says of a host it cannot recognize: an SSH alias reads as another host, and the gh rules go.
  const alias = setup({}, graph);
  git(["remote", "add", "origin", "git@gh-work:a/b.git"], { cwd: alias.dir });
  assert.deepEqual(rules(alias.dir), ["git push", "git push"]);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: alias.dir, encoding: "utf8" }).stdout).agentSetup.ask.otherRemotes, ["origin"]);
  assert.ok(t("scan.askNoGithub", {}, "tr").includes("SSH takma adı ya da Enterprise hostu"), "the Turkish line says it too");
});

test("ask rules: what leaves the machine is proposed; what destroys local work or installs outside the project is offered apart", async () => {
  const { GH_COMMANDS, OFFERED, outwardCommands, ruleFor } = await import("../setup/permissions.mjs");
  const gh = outwardCommands([], true);
  for (const c of ["gh repo create", "gh repo edit", "gh repo delete", "gh repo rename", "gh repo archive", "gh gist create"]) assert.ok(gh.includes(c), c);
  assert.deepEqual(gh.filter((c) => c.startsWith("gh api")), ["-X", "--method"].flatMap((f) => ["POST", "PATCH", "PUT", "DELETE"].map((m) => `gh api *${f} ${m}*`)));
  assert.deepEqual(gh, ["git push", ...GH_COMMANDS]);
  assert.equal(outwardCommands([], false).some((c) => c.startsWith("gh")), false, "the gh commands stay under a GitHub remote");
  // None of them is proposed as a default: outwardCommands holds no offered command, whatever the repository.
  const outward = new Set(outwardCommands(null, true));
  for (const c of [...OFFERED.destroys, ...OFFERED.installs]) assert.equal(outward.has(c), false, c);
  assert.deepEqual(OFFERED.destroys.filter((c) => OFFERED.installs.includes(c)), []);
  // The node's lists, by what a rule must stop.
  const rules = (/** @type {string[]} */ list) => list.map((c) => ruleFor(c, "Bash"));
  for (const r of ["Bash(git clean *)", "Bash(git reset *--hard*)", "Bash(git checkout *-- *)", "Bash(git restore *)", "Bash(git branch -D *)", "Bash(git worktree remove *)", "Bash(git stash drop *)", "Bash(git stash clear *)", "Bash(docker system prune *)", "Bash(docker volume prune *)", "Bash(docker network prune *)", "Bash(docker image prune *)", "Bash(docker volume rm *)", "Bash(docker compose down *-v*)", "Bash(dropdb *)", "Bash(terraform destroy *)", "Bash(prisma migrate reset *)", "Bash(npx prisma migrate reset *)", "Bash(prisma db push --force-reset *)", "Bash(npx prisma db push --force-reset *)"]) assert.ok(rules(OFFERED.destroys).includes(r), r);
  for (const r of ["Bash(npm install -g *)", "Bash(npm i -g *)", "Bash(pnpm add -g *)", "Bash(pip install *)", "Bash(pip3 install *)", "Bash(brew install *)", "Bash(cargo install *)", "Bash(go install *)", "Bash(sh)", "Bash(bash)"]) assert.ok(rules(OFFERED.installs).includes(r), r);
  // What the review measured as closing a spelling, each with a cell that says so and a cell it leaves alone.
  for (const r of ["Bash(docker-compose down *-v*)", "Bash(git checkout . *)", "Bash(git branch -d -f *)"]) assert.ok(rules(OFFERED.destroys).includes(r), r);
  for (const r of ["Bash(npm install * -g*)", "Bash(npm install *--global*)", "Bash(pnpm add * -g*)", "Bash(pnpm add *--global*)", "Bash(sh -s*)", "Bash(bash -s*)"]) assert.ok(rules(OFFERED.installs).includes(r), r);
});

test("ask rules: init-scan names the offered rules apart from the outward ones, and doctor says nothing of one declined", async () => {
  const { OFFERED, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const r = elsewhere(setup({}, { nodes: [{ id: "a" }] }));
  const both = (/** @type {string} */ c) => TOOLS.map((tool) => ruleFor(c, tool));
  r.commit("feat: ask", { ".claude/settings.json": JSON.stringify({ permissions: { ask: [...both("git push"), ...both("git clean")] } }) });
  const scan = () => JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: r.dir, encoding: "utf8" }).stdout);
  const json = scan();
  assert.deepEqual(json.agentSetup.ask.rules.map((/** @type {any} */ x) => x.command), ["git push", "git push"], "no offered command among the outward rules");
  assert.deepEqual(json.agentSetup.offered.installs, OFFERED.installs.flatMap(both));
  // What the project holds is not offered again.
  assert.deepEqual(json.agentSetup.offered.destroys, OFFERED.destroys.filter((c) => c !== "git clean").flatMap(both));
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.match(text, new RegExp(`^Ask rules to offer, never written unasked: ${json.agentSetup.offered.destroys.length} for what destroys local work or data, ${json.agentSetup.offered.installs.length} for what installs outside the project \\(init-scan --json lists them\\)\\.$`, "m"));
  // Declined, all of them: nothing to act on, nothing said.
  const items = (await checkSetup({ cwd: r.dir, env: {} })).items.filter(askItem);
  assert.deepEqual(items.map((i) => `${i.level} ${i.key}`), ["ok doctor.askOk"]);
  assert.deepEqual(items[0].vars, { n: 2 }, "the rules doctor asks for, counted: a held offered rule is not one");
  // Held in the local file, or written and not committed: still held, so not offered.
  put(r.dir, { ".claude/settings.local.json": JSON.stringify({ permissions: { ask: both("brew install") } }) });
  assert.deepEqual(scan().agentSetup.offered.installs, OFFERED.installs.filter((c) => c !== "brew install").flatMap(both));
  put(r.dir, { ".claude/settings.json": JSON.stringify({ permissions: { ask: [...both("git push"), ...both("git clean"), ...both("dropdb")] } }) });
  assert.deepEqual(scan().agentSetup.offered.destroys, OFFERED.destroys.filter((c) => c !== "git clean" && c !== "dropdb").flatMap(both));
  rmSync(join(r.dir, ".claude", "settings.local.json"));
  r.commit("feat: back", { ".claude/settings.json": JSON.stringify({ permissions: { ask: [...both("git push"), ...both("git clean")] } }) });
  // Their lists are the same in a repository with a GitHub remote: the condition is the outward list's alone.
  git(["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: r.dir });
  assert.deepEqual(scan().agentSetup.offered.installs, OFFERED.installs.flatMap(both));
});

test("ask rules: doctor counts what it holds and caps what it names, whatever the number of rules", async () => {
  const { capped, GH_COMMANDS, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const setupGithub = () => {
    const made = setup({}, { nodes: [{ id: "a" }] });
    git(["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: made.dir });
    return made;
  };
  const r = setupGithub();
  const all = ["git push", ...GH_COMMANDS].flatMap((c) => TOOLS.map((tool) => ruleFor(c, tool)));
  assert.equal(all.length, 36);
  const ask = async () => (await checkSetup({ cwd: r.dir, env: {} })).items.filter(askItem);
  // Nothing held: the first rules by name, the rest as a number.
  const [missing] = await ask();
  assert.equal(missing.key, "doctor.askMissing");
  assert.deepEqual(missing.vars.rules, [...all.slice(0, 8), "+28"]);
  // All held: a number, and the line stays the limits it says.
  r.commit("feat: ask", { ".claude/settings.json": JSON.stringify({ permissions: { ask: all } }) });
  const held = await ask();
  assert.deepEqual(held.map((i) => [i.key, i.vars]), [["doctor.askOk", { n: 36 }]]);
  const line = tShown(held[0].key, held[0].vars, "en");
  assert.match(line, /^ask rules: 36 held in \.claude\/settings\.json, as committed\. Claude Code applies them only in a session started at the repository's top/);
  assert.ok(line.length < 900, `${line.length}: the line stays readable`);
  // Eight is said in full; the ninth is the first counted.
  const names = Array.from({ length: 9 }, (_, i) => `r${i}`);
  assert.deepEqual(capped(names.slice(0, 8)), names.slice(0, 8));
  assert.deepEqual(capped(names), [...names.slice(0, 8), "+1"]);
  // init-scan's line keeps to the same cap, whatever the list.
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: setupGithub().dir, encoding: "utf8" }).stdout;
  const line2 = String(text.split("\n").find((l) => l.startsWith("Ask rules before what leaves the machine:")));
  assert.match(line2, /none: Bash\(git push \*\), .*, \+\d+\.$/, line2);
  assert.equal(line2.split("Bash(").length - 1 + line2.split("PowerShell(").length - 1, 8, line2);
  const r2 = elsewhere(setup({}, { nodes: [{ id: "a" }] }));
  r2.commit("feat: ask", { "package.json": "{}", ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(npm publish *)"] } }) });
  assert.deepEqual((await checkSetup({ cwd: r2.dir, env: {} })).items.find((i) => i.key === "doctor.askMissing")?.vars.rules, ["Bash(git push *)", "PowerShell(git push *)", "PowerShell(npm publish *)"]);
});

test("ask rules: what is asked about, and where each rule is: committed, uncommitted, local; a file Claude Code skips gives none", async () => {
  const { askRules, GH_COMMANDS, outwardCommands, parseSettings, SETTINGS_LIMIT } = await import("../setup/permissions.mjs");
  const { projectFiles } = await import("../setup/scan.mjs");
  // ask-monorepo-private-root: a package.json anywhere proposes npm publish; a GitHub remote, the gh commands.
  assert.deepEqual(outwardCommands([], false), ["git push"]);
  assert.deepEqual(outwardCommands(["packages/a/package.json"], false), ["git push", "npm publish"]);
  assert.deepEqual(outwardCommands(["package.json"], true), ["git push", "npm publish", ...GH_COMMANDS]);
  assert.deepEqual(outwardCommands(["xpackage.json", "package.jsonx"], false), ["git push"]);
  assert.deepEqual(outwardCommands(null, false), ["git push", "npm publish"], "files git could not list: asked about");

  const at = (/** @type {Record<string, string>} */ files, /** @type {string | null} */ head = null) => {
    const dir = mkdtempSync(join(tmpdir(), "en-ask-"));
    put(dir, files);
    // HEAD as core/git.mjs headFile gives it: a file over 2 MB is no text.
    return askRules(projectFiles(dir), ["git push"], { committed: () => (head === null ? null : Buffer.byteLength(head) > SETTINGS_LIMIT ? { kind: "large" } : { text: head }) });
  };
  const where = (/** @type {ReturnType<typeof at>} */ r) => r.rules.map((x) => `${x.tool} ${x.where}`);
  const shared = JSON.stringify({ permissions: { ask: ["Bash(git push *)"], deny: ["PowerShell(git push:*)"] } });
  // ask-empty-settings: no file, no rule, nothing unread.
  assert.deepEqual(at({}), { rules: [{ command: "git push", tool: "Bash", rule: "Bash(git push *)", where: null }, { command: "git push", tool: "PowerShell", rule: "PowerShell(git push *)", where: null }], unread: [], head: null });
  // ask-plain-shared: committed, as HEAD holds it. ask-gitignored-shared: the work tree's file only.
  assert.deepEqual(where(at({ ".claude/settings.json": shared }, shared)), ["Bash shared", "PowerShell shared"]);
  assert.deepEqual(where(at({ ".claude/settings.json": shared })), ["Bash uncommitted", "PowerShell uncommitted"]);
  assert.deepEqual(where(at({ ".claude/settings.json": shared }, JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }))), ["Bash shared", "PowerShell uncommitted"]);
  // In both files: the shared one says where every clone has it.
  assert.deepEqual(where(at({ ".claude/settings.json": shared, ".claude/settings.local.json": shared }, shared)), ["Bash shared", "PowerShell shared"]);
  // HEAD's file holds the rule, the work tree's does not: this machine does not have it.
  assert.deepEqual(where(at({}, shared)), ["Bash null", "PowerShell null"]);
  // allow is no ask; ask-local-only.
  assert.deepEqual(where(at({ ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(git push *)"] } }) })), ["Bash null", "PowerShell null"]);
  assert.deepEqual(where(at({ ".claude/settings.local.json": shared })), ["Bash local", "PowerShell local"]);
  // A settings file with no permissions gives no rule and is no problem; an entry that is no string is skipped.
  assert.deepEqual(at({ ".claude/settings.json": JSON.stringify({ hooks: {} }), ".claude/settings.local.json": "{}" }).unread, []);
  assert.deepEqual(where(at({ ".claude/settings.local.json": JSON.stringify({ permissions: { ask: [7, { x: 1 }, "Bash(git push *)"] } }) })), ["Bash local", "PowerShell null"]);
  // ask-bom-applies: Claude Code skips a byte order mark, and so does the reader.
  assert.deepEqual(where(at({ ".claude/settings.local.json": `\uFEFF${shared}` })), ["Bash local", "PowerShell local"]);
  // Shapes of the keys Ennyn reads that Claude Code rejects: the file gives nothing, and is named.
  const shapes = at({ ".claude/settings.json": JSON.stringify({ permissions: { ask: "Bash(git push *)" } }), ".claude/settings.local.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"], deny: {} } }) });
  assert.deepEqual([where(shapes), shapes.unread], [["Bash null", "PowerShell null"], [".claude/settings.json permissions.ask", ".claude/settings.local.json permissions.deny"]]);
  const roots = at({ ".claude/settings.json": "[]", ".claude/settings.local.json": JSON.stringify({ permissions: ["Bash(git push *)"] }) });
  assert.deepEqual([where(roots), roots.unread], [["Bash null", "PowerShell null"], [".claude/settings.json", ".claude/settings.local.json permissions"]]);
  // A hooks value that is no object Claude Code drops and keeps the file: its rules count.
  const hooks = at({ ".claude/settings.local.json": JSON.stringify({ hooks: "x", permissions: { ask: ["Bash(git push *)"] } }) });
  assert.deepEqual([where(hooks), hooks.unread], [["Bash local", "PowerShell null"], []]);
  // Other keys are not checked (Ennyn does not mirror the schema; doctor's line says a file with any setting
  // Claude Code rejects is skipped whole). A key the secret setup reads is (permissions.mjs KEPT): a mode Claude Code
  // does not take leaves the file unread (settings-default-mode-bogus, recorded).
  assert.deepEqual(where(at({ ".claude/settings.local.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"], allow: "x" }, model: 5 }) })), ["Bash local", "PowerShell null"]);
  const mode = at({ ".claude/settings.local.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"], defaultMode: "yolo" } }) });
  assert.deepEqual([where(mode), mode.unread], [["Bash null", "PowerShell null"], [".claude/settings.local.json permissions.defaultMode"]]);
  // A file over 2 MB is skipped by Claude Code, and named; HEAD's copy over 2 MB gives nothing.
  const big = JSON.stringify({ permissions: { ask: ["Bash(git push *)"] }, pad: "x".repeat(SETTINGS_LIMIT) });
  const large = at({ ".claude/settings.json": big }, big);
  assert.deepEqual([where(large), large.unread], [["Bash null", "PowerShell null"], [".claude/settings.json (over 2 MB)"]]);
  // HEAD's copy is no regular file of at most 2 MB: not judged, and said.
  const headLarge = at({ ".claude/settings.json": shared }, big);
  assert.deepEqual([where(headLarge), headLarge.head], [["Bash unknown", "PowerShell unknown"], "large"]);
  assert.deepEqual(parseSettings(`\uFEFF{"permissions":{}}`, "p"), { json: { permissions: {} } });
  assert.deepEqual(parseSettings("{", "p"), { unread: "p" });
  // A read that fails throws, as every read of the scan does (doctor says it on its own line).
  const dirInPlace = mkdtempSync(join(tmpdir(), "en-ask-dir-"));
  mkdirSync(join(dirInPlace, ".claude", "settings.json"), { recursive: true });
  assert.throws(() => askRules(projectFiles(dirInPlace), ["git push"]), /settings\.json could not be read: EISDIR/);
  // A .claude that leads out of the repository is not read: its rules are not the repository's.
  const out = mkdtempSync(join(tmpdir(), "en-ask-out-"));
  put(out, { "settings.json": shared });
  const linked = mkdtempSync(join(tmpdir(), "en-ask-link-"));
  symlinkSync(out, join(linked, ".claude"));
  const pf = projectFiles(linked);
  const res = askRules(pf, ["git push"]);
  assert.deepEqual([where(res), res.unread, [...pf.outside]], [["Bash null", "PowerShell null"], [".claude/settings.json"], [".claude"]]);
});

test("ask rules: init-scan's hooks reader and the ask rules count the same files (one predicate): a file Claude Code skips runs no hook", async () => {
  const { agentSetup } = await import("../setup/scan.mjs");
  const dir = mkdtempSync(join(tmpdir(), "en-ask-hooks-"));
  const hook = { hooks: [{ type: "command", command: "x" }] };
  put(dir, {
    ".claude/settings.json": JSON.stringify({ permissions: "x", hooks: { Stop: [hook] } }),
    ".claude/settings.local.json": `\uFEFF${JSON.stringify({ hooks: { SessionStart: [hook] } })}`,
  });
  const res = agentSetup(dir, []);
  assert.deepEqual([res.hooks, res.unreadable], [["SessionStart"], [".claude/settings.json permissions"]]);
});

test("push.mode: doctor names the mode both ways; with after-closing no git push rule is missing, one held is said, and init-scan proposes none", async () => {
  const graph = { nodes: [{ id: "a" }] };
  const push = (/** @type {Awaited<ReturnType<typeof checkSetup>>} */ res) => res.items.filter((i) => /^doctor\.(pushMode|askMissing)/.test(i.key)).map((i) => [i.level, i.key, i.vars]);
  const scanned = (/** @type {string} */ dir) => JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: dir, encoding: "utf8" }).stdout).agentSetup.ask.rules.map((/** @type {{ rule: string }} */ r) => r.rule);
  const both = ["Bash(git push *)", "PowerShell(git push *)"];
  const asks = elsewhere(setup({}, graph));
  assert.deepEqual(push(await checkSetup({ cwd: asks.dir, env: {} })), [["ok", "doctor.pushModeAsk", {}], ["warn", "doctor.askMissing", { rules: both }]]);
  assert.deepEqual(scanned(asks.dir), both);
  const after = elsewhere(setup({ push: { mode: "after-closing" } }, graph));
  // Set with no approval line and no upstream: named, and what holds the closing's push back is said.
  const held = push(await checkSetup({ cwd: after.dir, env: {} }));
  assert.deepEqual(held.map(([level, key]) => [level, key]), [["ok", "doctor.pushModeAfter"], ["warn", "doctor.pushModeHeld"]]);
  // It reads the mode's part of push-check's verdict, and says which parts it leaves to the push.
  assert.match(tShown("doctor.pushModeAfter", {}, "en"), /This line reads the mode, its approval, the checkout and what git config makes a bare push send; the commits rule, the test record, what the push sends and the work tree are read at the push, by push-check and the push hook$/);
  assert.match(tShown("doctor.pushModeAfter", {}, "en"), /--tested, which the push hook does not take/);
  assert.match(tShown("doctor.pushModeHeld", held[1][2], "en"), /^push\.mode is after-closing, but the closing would still ask: push\.mode is after-closing, but the commit that set it \([0-9a-f]{12}\) holds no User-Approved-Loosening: push\.mode line/);
  assert.deepEqual(scanned(after.dir), []);
  // A rule left on push stops the closing's own push: said, in either file.
  after.commit("chore: rule", { ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }), ".claude/settings.local.json": JSON.stringify({ permissions: { deny: ["PowerShell(git push:*)"] } }) });
  assert.deepEqual(push(await checkSetup({ cwd: after.dir, env: {} })).filter(([, key]) => key !== "doctor.pushModeHeld"), [["ok", "doctor.pushModeAfter", {}], ["warn", "doctor.pushModeRule", { rules: both }]]);
  // The work tree set back to ask, not committed: the closing asks, and the split is said.
  put(after.dir, { ".ennyn/config.json": "{}" });
  assert.deepEqual(push(await checkSetup({ cwd: after.dir, env: {} })).slice(0, 2), [["warn", "doctor.pushModeSplit", { head: "after-closing", work: "ask" }], ["ok", "doctor.pushModeAsk", {}]]);
  // Turned on in the work tree only: no commit holds it, so the closing still asks.
  put(asks.dir, { ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing" } }) });
  assert.deepEqual(push(await checkSetup({ cwd: asks.dir, env: {} })).slice(0, 2), [["warn", "doctor.pushModeSplit", { head: "ask", work: "after-closing" }], ["ok", "doctor.pushModeAsk", {}]]);
});

test("ask rules: doctor says which file holds each rule and whether it is committed, with where Claude Code applies it; init-scan lists them", async () => {
  const { GH_COMMANDS, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const graph = { nodes: [{ id: "a" }] };
  const ask = (/** @type {Awaited<ReturnType<typeof checkSetup>>} */ res) => res.items.filter(askItem).map((i) => ({ level: i.level, key: i.key, vars: i.vars }));
  const both = (/** @type {string} */ c) => [`Bash(${c} *)`, `PowerShell(${c} *)`];
  const none = elsewhere(setup({}, graph));
  assert.deepEqual(ask(await checkSetup({ cwd: none.dir, env: {} })), [{ level: "warn", key: "doctor.askMissing", vars: { rules: both("git push") } }]);
  const r = elsewhere(setup({}, graph));
  r.commit("feat: ask", { "packages/p/package.json": JSON.stringify({ name: "p" }), ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)", "PowerShell(git push *)"] } }) });
  assert.deepEqual(ask(await checkSetup({ cwd: r.dir, env: {} })), [
    { level: "warn", key: "doctor.askMissing", vars: { rules: both("npm publish") } },
    { level: "ok", key: "doctor.askOk", vars: { n: 2 } },
  ]);
  // Written but not committed; only in the local file.
  put(r.dir, { ".claude/settings.json": JSON.stringify({ permissions: { ask: [...both("git push"), "Bash(npm publish *)"] } }), ".claude/settings.local.json": JSON.stringify({ permissions: { deny: ["PowerShell(npm publish:*)"] } }) });
  assert.deepEqual(ask(await checkSetup({ cwd: r.dir, env: {} })), [
    { level: "warn", key: "doctor.askUncommitted", vars: { rules: ["Bash(npm publish *)"] } },
    { level: "warn", key: "doctor.askLocal", vars: { rules: ["PowerShell(npm publish *)"] } },
    { level: "ok", key: "doctor.askOk", vars: { n: 2 } },
  ]);
  // The ✓ line says what was read and where Claude Code applies it, not that a push is asked about.
  const okLine = tShown("doctor.askOk", { n: 2 }, "en");
  assert.match(okLine, /^ask rules: 2 held in \.claude\/settings\.json, as committed\. Claude Code applies them only in a session started at the repository's top/);
  assert.match(okLine, /skips the file whole and shows a Settings Error/);
  assert.match(okLine, /not matched: a git option before push \(git -C <dir> push, git -c k=v push\), a quoted or escaped push \(git "push"\), a command fed to a shell or another program \(sh -c, eval, xargs, find -exec\), a command word built as it runs \(\$\(…\), `…`\), an alias, a script that pushes, gh api with no method or one written otherwise \(-f, -XPOST, -iX POST, --method=POST, -X post, -X "POST"\), an MCP tool, and on older versions a full path \(before 2\.1\.309\) or a subshell \(2\.1\.207\)$/);
  assert.doesNotMatch(okLine, /unasked|in every permission mode/);
  // The hook is a line of its own, right after, and only where it says something true: with a config, the hook's gate, and a
  // rule on push, whatever file holds it.
  const sayings = (await checkSetup({ cwd: r.dir, env: {} })).items.map((i) => i.key);
  assert.equal(sayings[sayings.indexOf("doctor.askOk") + 1], "doctor.pushHook");
  assert.match(tShown("doctor.pushHook", {}, "en"), /^push hook: an ask rule reads a compound command only if Claude Code's parser finishes/);
  const hookLine = (/** @type {Record<string, string>} */ files, /** @type {boolean} */ configured) => {
    /** @type {string[]} */
    const keys = [];
    askReport(r.dir, [], (_level, key) => keys.push(key), { configured, read: (rel) => files[rel], remotes: () => ({ github: ["origin"], others: [] }), headFile: (_cwd, rel) => (files[rel] === undefined ? null : { text: files[rel] }) });
    return keys.includes("doctor.pushHook");
  };
  const push = JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } });
  const other = JSON.stringify({ permissions: { ask: ["Bash(gh release *)"] } });
  assert.equal(hookLine({ ".claude/settings.json": push }, true), true);
  assert.equal(hookLine({ ".claude/settings.local.json": push }, true), true);
  assert.equal(hookLine({ ".claude/settings.json": push }, false), false, "no config: the hook ends at once");
  assert.equal(hookLine({ ".claude/settings.json": other }, true), false, "no rule on push");
  assert.equal(hookLine({}, true), false);
  // A file that gives no rule is said; a read that fails is said once, with its error.
  r.commit("feat: broken", { ".claude/settings.json": "{" });
  rmSync(join(r.dir, ".claude", "settings.local.json"));
  mkdirSync(join(r.dir, ".claude", "settings.local.json"));
  const broken = ask(await checkSetup({ cwd: r.dir, env: {} }));
  // A file that cannot be read might hold the rule: unmeasured, not missing.
  assert.deepEqual(broken.map((i) => `${i.level} ${i.key}`), ["unmeasured doctor.askUnread", "unmeasured doctor.askUnmeasured", "unmeasured doctor.askUnknown"]);
  assert.deepEqual(broken[0].vars, { list: [".claude/settings.json"] });
  assert.match(String(broken[1].vars.error), /settings\.local\.json could not be read: EISDIR/);
  // A file over 2 MB is no failed read: Claude Code skips it, and doctor names it as giving no rule.
  rmSync(join(r.dir, ".claude", "settings.local.json"), { recursive: true });
  const { SETTINGS_LIMIT } = await import("../setup/permissions.mjs");
  put(r.dir, { ".claude/settings.local.json": JSON.stringify({ pad: "x".repeat(SETTINGS_LIMIT) }) });
  assert.deepEqual(ask(await checkSetup({ cwd: r.dir, env: {} }))[0], { level: "unmeasured", key: "doctor.askUnread", vars: { list: [".claude/settings.json", ".claude/settings.local.json (over 2 MB)"] } });
  // Outside a repository there is no push to ask about.
  const dir = mkdtempSync(join(tmpdir(), "en-ask-norepo-"));
  put(dir, { ".ennyn/config.json": "{}", ".ennyn/graph.json": JSON.stringify(graph) });
  assert.deepEqual(ask(await checkSetup({ cwd: dir, env: {} })), []);

  const scan = setup({}, graph);
  scan.commit("feat: ask", { ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }), "package.json": JSON.stringify({ name: "p" }) });
  git(["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: scan.dir });
  put(scan.dir, { ".claude/settings.local.json": JSON.stringify({ permissions: { ask: ["PowerShell(git push *)"] } }) });
  const json = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: scan.dir, encoding: "utf8" }).stdout);
  assert.deepEqual(json.agentSetup.ask.rules.map((/** @type {any} */ x) => `${x.rule} ${x.where}`), [
    "Bash(git push *) shared",
    "PowerShell(git push *) local",
    ...["npm publish", ...GH_COMMANDS].flatMap((c) => TOOLS.map((tool) => `${ruleFor(c, tool)} null`)),
  ]);
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: scan.dir, encoding: "utf8" }).stdout;
  assert.match(text, /^Ask rules before what leaves the machine: committed in \.claude\/settings\.json: Bash\(git push \*\) · only in \.claude\/settings\.local\.json \(this machine\): PowerShell\(git push \*\) · none: Bash\(npm publish \*\), /m);
  // A settings file that does not parse: the hooks reader names it, and the ask line says it as unmeasured.
  put(scan.dir, { ".claude/settings.json": "{" });
  const bad = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: scan.dir, encoding: "utf8" }).stdout;
  assert.match(bad, /· unmeasured: \.claude\/settings\.json gives no rule\.$/m);
  assert.match(bad, /^Not read \(.*\): \.claude\/settings\.json\.$/m);
});

// Review round two of push-approval-gate.
test("ask rules (review two): a HEAD that cannot be read, or holds no regular file, is unmeasured, never uncommitted", async () => {
  const graph = { nodes: [{ id: "a" }] };
  const all = JSON.stringify({ permissions: { ask: ["Bash(git push *)", "PowerShell(git push *)"] } });
  const items = (/** @type {string} */ cwd, /** @type {any} */ read) => {
    /** @type {{ level: string, key: string, vars: any }[]} */
    const out = [];
    askReport(cwd, [], (level, key, vars = {}) => out.push({ level, key, vars }), read);
    return out.filter(askItem);
  };
  const r = elsewhere(setup({}, graph));
  r.commit("feat: ask", { ".claude/settings.json": all });
  // A git that fails on HEAD: said, and the rules are neither ✓ nor "commit the file".
  const failing = items(r.dir, { headFile: () => { throw Object.assign(new Error("x"), { stderr: "fatal: ls-tree failed" }); } });
  assert.deepEqual(failing.map((i) => `${i.level} ${i.key}`), ["unmeasured doctor.askUnmeasured", "unmeasured doctor.askUnknown"]);
  assert.deepEqual([failing[0].vars.error, failing[1].vars.rules], ["fatal: ls-tree failed", ["Bash(git push *)", "PowerShell(git push *)"]]);
  // A committed symbolic link: clones have the file through it; HEAD holds no regular file there, not judged.
  const link = elsewhere(setup({}, graph));
  put(link.dir, { "shared/settings.json": all });
  mkdirSync(join(link.dir, ".claude"));
  symlinkSync("../shared/settings.json", join(link.dir, ".claude", "settings.json"));
  link.commit("feat: linked settings");
  const linked = (await checkSetup({ cwd: link.dir, env: {} })).items.filter(askItem);
  assert.deepEqual(linked.map((i) => `${i.level} ${i.key}`), ["unmeasured doctor.askHeadKind", "unmeasured doctor.askUnknown"]);
  // A link in HEAD on the way to the file is the same.
  const dirLink = elsewhere(setup({}, graph));
  put(dirLink.dir, { "conf/settings.json": all });
  symlinkSync("conf", join(dirLink.dir, ".claude"));
  dirLink.commit("feat: linked directory");
  assert.ok((await checkSetup({ cwd: dirLink.dir, env: {} })).items.some((i) => i.key === "doctor.askHeadKind"));
  // init-scan says it in the ask line too.
  const linkScan = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: link.dir, encoding: "utf8" }).stdout;
  assert.match(linkScan, /^Ask rules before what leaves the machine: in \.claude\/settings\.json, unmeasured whether committed \(HEAD holds no regular file there\): Bash\(git push \*\), PowerShell\(git push \*\) · /m);
  // HEAD is read only when the work tree's file holds a rule: with none, a HEAD that cannot be read says nothing.
  const bare = elsewhere(setup({}, graph));
  assert.deepEqual(items(bare.dir, { headFile: () => { throw new Error("no"); } }).map((i) => i.key), ["doctor.askMissing"]);
  // headFile: a regular file (executable too), a link (itself or a directory on its way), something else, past
  // the limit, nothing there, no commit yet.
  const { headFile } = await import("../core/git.mjs");
  assert.deepEqual(headFile(link.dir, ".claude/settings.json", 1e6), { kind: "link" });
  assert.deepEqual(headFile(dirLink.dir, ".claude/settings.json", 1e6), { kind: "link" });
  assert.deepEqual(headFile(link.dir, "shared/settings.json", 1e6), { text: all });
  assert.deepEqual(headFile(link.dir, "shared/settings.json", 10), { kind: "large" });
  assert.deepEqual(headFile(link.dir, "shared", 1e6), { kind: "other" });
  assert.equal(headFile(link.dir, ".claude/nothing.json", 1e6), null);
  chmodSync(join(link.dir, "shared", "settings.json"), 0o755);
  link.commit("chore: executable");
  assert.deepEqual(headFile(link.dir, "shared/settings.json", 1e6), { text: all });
  const unborn = mkdtempSync(join(tmpdir(), "en-ask-unborn-"));
  git(["init", "-q"], { cwd: unborn });
  assert.equal(headFile(unborn, ".claude/settings.json", 1e6), null);
  // A settings file that cannot be read: what it holds is unknown, not missing.
  const { projectFiles } = await import("../setup/scan.mjs");
  const pf = projectFiles(r.dir);
  const unread = items(r.dir, {
    read: (/** @type {string} */ rel, /** @type {any} */ opts) => {
      if (rel === ".claude/settings.json") throw Object.assign(new Error(".claude/settings.json could not be read: EACCES"), { code: "EACCES" });
      return pf.read(rel, opts);
    },
  });
  assert.deepEqual(unread.map((i) => `${i.level} ${i.key}`), ["unmeasured doctor.askUnmeasured", "unmeasured doctor.askUnknown"]);
});

test("ask rules (review two): doctor reads every remote for a GitHub host; a remote read that fails names the gh commands not checked", async () => {
  const { urlHost, isGithubHost } = await import("../setup/permissions.mjs");
  const graph = { nodes: [{ id: "a" }] };
  const { GH_COMMANDS: gh, capped, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const r = setup({}, graph);
  // A GitHub Enterprise remote not named origin.
  git(["remote", "add", "upstream", "git@github.mycorp.com:org/repo.git"], { cwd: r.dir });
  const missing = (await checkSetup({ cwd: r.dir, env: {} })).items.find((i) => i.key === "doctor.askMissing");
  assert.deepEqual(missing?.vars.rules, capped(["git push", ...gh].flatMap((c) => TOOLS.map((tool) => ruleFor(c, tool)))));
  /** @type {{ level: string, key: string, vars: any }[]} */
  const out = [];
  askReport(r.dir, [], (level, key, vars = {}) => out.push({ level, key, vars }), { remotes: () => { throw Object.assign(new Error("x"), { stderr: "fatal: remote failed" }); } });
  assert.deepEqual(out.find((i) => i.key === "doctor.askGithubUnmeasured")?.vars, { error: "fatal: remote failed", commands: capped(gh) });
  assert.deepEqual(out.find((i) => i.key === "doctor.askMissing")?.vars.rules, ["Bash(git push *)", "PowerShell(git push *)"]);
  // Hosts: github.com, ssh.github.com and github.<domain>, in every URL form git takes.
  const hosts = {
    "https://github.com/a/b.git": "github.com",
    "git@github.com:a/b.git": "github.com",
    "ssh://git@ssh.github.com:443/a/b.git": "ssh.github.com",
    "git@github.mycorp.com:org/repo.git": "github.mycorp.com",
    "https://user@GitHub.com/a/b": "github.com",
    "git://github.com/a/b": "github.com",
    "/srv/git/a.git": null,
    "../a.git": null,
    "file:///srv/a.git": "",
    "https://gitlab.com/a/b": "gitlab.com",
  };
  for (const [url, host] of Object.entries(hosts)) assert.equal(urlHost(url), host, url);
  for (const h of ["github.com", "ssh.github.com", "github.mycorp.com", "GITHUB.com"]) assert.equal(isGithubHost(h), true, h);
  for (const h of ["gitlab.com", "notgithub.com", "github.com.evil.net.", "mygithub.com", "", null]) assert.equal(isGithubHost(h), false, String(h));
});

test("permissions audit: a GitHub Enterprise Cloud remote on a ghe.com subdomain is GitHub, so its gh commands are asked about; lookalikes stay out", async () => {
  const { urlHost, isGithubHost } = await import("../setup/permissions.mjs");
  // GitHub's documented forms: the tenant is the SSH user, and every host under ghe.com is GitHub's.
  for (const url of ["octo@octo.ghe.com:org/repo.git", "https://octo.ghe.com/org/repo.git", "ssh://octo@Octo.GHE.com/org/repo.git"]) assert.equal(isGithubHost(urlHost(url)), true, url);
  for (const h of ["ghe.com", "evilghe.com", "octo.ghe.com.evil.test", "octo.ghe.co", "octo-ghe.com", "octo.ghe.com."]) assert.equal(isGithubHost(h), false, h);
  // End to end: the only remote is on ghe.com, and doctor asks for the gh rules as it does for github.com.
  const { GH_COMMANDS: gh, capped, ruleFor, TOOLS } = await import("../setup/permissions.mjs");
  const r = setup({}, { nodes: [{ id: "a" }] });
  git(["remote", "add", "origin", "octo@octo.ghe.com:org/repo.git"], { cwd: r.dir });
  const missing = (await checkSetup({ cwd: r.dir, env: {} })).items.find((i) => i.key === "doctor.askMissing");
  assert.deepEqual(missing?.vars.rules, capped(["git push", ...gh].flatMap((c) => TOOLS.map((tool) => ruleFor(c, tool)))));
});

test("permissions audit (review): the proposed sandbox opens each GitHub remote's own host and the API host gh 2.92.0 sends to, not github.com for every one", () => {
  const hostsFor = (/** @type {string[]} */ urls) => {
    const r = setup({}, { nodes: [{ id: "a" }] });
    urls.forEach((url, i) => git(["remote", "add", `r${i}`, url], { cwd: r.dir }));
    return scanProject({ cwd: r.dir, env: {} }).agentSetup.secrets.proposal.sandbox.network.allowedDomains;
  };
  // gh 2.92.0 (GH_DEBUG=api): github.com → api.github.com, <tenant>.ghe.com → api.<tenant>.ghe.com, a server → <host>/api/v3.
  assert.deepEqual(hostsFor(["git@github.com:o/r.git"]), ["github.com", "api.github.com"]);
  assert.deepEqual(hostsFor(["octo@octo.ghe.com:org/repo.git"]), ["octo.ghe.com", "api.octo.ghe.com"]);
  assert.deepEqual(hostsFor(["git@github.mycorp.test:o/r.git"]), ["github.mycorp.test"]);
  // An SSH alias of github.com for a second account (Host github.com-work, HostName github.com): no DNS name ends in a
  // label like com-work, so it is github.com, and the alias, no host anyone connects to, is not opened.
  assert.deepEqual(hostsFor(["git@github.com-work:o/r.git"]), ["github.com", "api.github.com"]);
  assert.deepEqual(hostsFor(["git@github.com-work:o/r.git", "https://github.com/o/f.git"]), ["github.com", "api.github.com"]);
  assert.deepEqual(hostsFor(["ssh://git@ssh.github.com:443/o/r.git"]), ["ssh.github.com", "api.github.com"]);
  // Each host once, in the order the remotes are listed; a remote elsewhere opens nothing.
  assert.deepEqual(hostsFor(["https://github.com/o/r.git", "git@github.com:o/f.git", "git@gitlab.test:o/r.git", "octo@octo.ghe.com:o/r.git"]), ["github.com", "api.github.com", "octo.ghe.com", "api.octo.ghe.com"]);
  assert.deepEqual(hostsFor(["git@gitlab.test:o/r.git"]), []);
  // Two hosts that share an API host give it once.
  assert.deepEqual(hostsFor(["git@github.com:o/r.git", "ssh://git@ssh.github.com:443/o/f.git"]), ["github.com", "api.github.com", "ssh.github.com"]);
});

test("permissions audit (review, mutation): remotesByHost lists the GitHub hosts only, and githubHosts gives none for another host, in any case", async () => {
  const { remotesByHost } = await import("../setup/scan.mjs");
  const { githubHosts } = await import("../setup/permissions.mjs");
  const r = setup({}, { nodes: [{ id: "a" }] });
  for (const [name, url] of [["a", "git@gitlab.test:o/r.git"], ["b", "https://GitHub.com/o/r.git"]]) git(["remote", "add", name, url], { cwd: r.dir });
  assert.deepEqual(remotesByHost(r.dir), { github: ["b"], others: ["a"], hosts: ["github.com"] });
  assert.deepEqual(githubHosts("GitHub.COM"), ["github.com", "api.github.com"]);
  assert.deepEqual(githubHosts("OCTO.ghe.com"), ["octo.ghe.com", "api.octo.ghe.com"]);
  for (const h of ["gitlab.test", "notgithub.com", "", null]) assert.deepEqual(githubHosts(h), [], String(h));
  // Aliases of github.com map to it; a server, a server with a dash and lookalikes keep their own reading.
  for (const h of ["github.com-work", "GitHub.com-Second-Account"]) assert.deepEqual(githubHosts(h), ["github.com", "api.github.com"], h);
  for (const h of ["github.mycorp.test", "github.com-work.example.test", "github.company-x.test", "github.github.com-work"]) assert.deepEqual(githubHosts(h), [h.toLowerCase()], h);
  for (const h of ["notgithub.com-work", "github-work"]) assert.deepEqual(githubHosts(h), [], h);
});

test("permissions audit (review): with remotes and none on a GitHub host, doctor says the gh commands were not checked, as init-scan says they were not proposed", async () => {
  const { GH_COMMANDS: gh, capped } = await import("../setup/permissions.mjs");
  const items = async (/** @type {string | null} */ url) => {
    const r = setup({}, { nodes: [{ id: "a" }] });
    if (url) git(["remote", "add", "origin", url], { cwd: r.dir });
    return (await checkSetup({ cwd: r.dir, env: {} })).items;
  };
  // An SSH alias gh resolves to github.com (Host github-work, HostName github.com) reads as another host.
  const alias = (await items("git@github-work:o/r.git")).find((i) => i.key === "doctor.askNoGithub");
  assert.deepEqual(alias && [alias.level, alias.vars], ["unmeasured", { commands: capped(gh) }]);
  assert.match(tShown("doctor.askNoGithub", alias.vars, "en"), /SSH alias/);
  assert.match(tShown("doctor.askNoGithub", alias.vars, "tr"), /SSH/);
  // With a GitHub remote, or with none at all, the gh commands are checked and the line is not there.
  for (const url of ["git@github.com:o/r.git", null]) assert.equal((await items(url)).some((i) => i.key === "doctor.askNoGithub"), false, String(url));
});

test("permissions audit (mutation): a settings file that leads out of the repository reads as undefined, not as unread; a scheme git takes no transport for names no host", async () => {
  const { readSettings, urlHost } = await import("../setup/permissions.mjs");
  // init-scan's hooks reader says a link out under its own line, not among the files Claude Code skips.
  assert.equal(readSettings({ read: () => undefined }, ".claude/settings.json"), undefined);
  assert.equal(readSettings({ read: () => null }, ".claude/settings.json"), null);
  // Not a scheme (an underscore, a leading digit) and not scp-like either: the `//` after the colon is no path.
  for (const url of ["my_scheme://github.com/a/b", "1git://github.com/a/b"]) assert.equal(urlHost(url), null, url);
});

test("ask rules (review two): a hooks value Claude Code drops leaves the file counting; a package.json git does not list still brings npm publish; init-scan says why no gh rule", async () => {
  const { parseSettings, outwardCommands } = await import("../setup/permissions.mjs");
  const { agentSetup } = await import("../setup/scan.mjs");
  // 2.1.207 deletes a hooks value that is no object ("This field was ignored") and keeps the file.
  assert.deepEqual(parseSettings(JSON.stringify({ hooks: "x", permissions: { ask: ["Bash(git push *)"] } }), "p"), { json: { permissions: { ask: ["Bash(git push *)"] } }, dropped: ["p hooks"] });
  assert.deepEqual(parseSettings(JSON.stringify({ hooks: null }), "p"), { json: {}, dropped: ["p hooks"] });
  const dir = mkdtempSync(join(tmpdir(), "en-ask-drop-"));
  put(dir, { ".claude/settings.json": JSON.stringify({ hooks: ["x"], permissions: { ask: ["Bash(git push *)"] } }) });
  assert.deepEqual([agentSetup(dir, []).hooks, agentSetup(dir, []).unreadable], [[], [".claude/settings.json hooks"]]);
  assert.deepEqual(outwardCommands([], false, (/** @type {string} */ p) => p === "package.json"), ["git push", "npm publish"]);
  assert.deepEqual(outwardCommands([], false, () => false), ["git push"]);
  // doctor: a package.json git does not list, in a repository.
  const untracked = elsewhere(setup({}, { nodes: [{ id: "a" }] }));
  put(untracked.dir, { "package.json": "{}" });
  const doc = (await checkSetup({ cwd: untracked.dir, env: {} })).items.find((i) => i.key === "doctor.askMissing");
  assert.deepEqual(doc?.vars.rules, ["git push", "npm publish"].flatMap((c) => [`Bash(${c} *)`, `PowerShell(${c} *)`]));
  // init-scan outside a repository: the work tree's package.json counts.
  const out = mkdtempSync(join(tmpdir(), "en-ask-norepo-scan-"));
  put(out, { "package.json": "{}", ".ennyn/config.json": "{}" });
  const json = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: out, encoding: "utf8" }).stdout);
  assert.deepEqual([...new Set(json.agentSetup.ask.rules.map((/** @type {any} */ x) => x.command))], ["git push", "npm publish", ...(await import("../setup/permissions.mjs")).GH_COMMANDS]);
  // Every remote on another host: the gh rules are not proposed, and init-scan says what that leaves.
  const r = setup({}, { nodes: [{ id: "a" }] });
  git(["remote", "add", "origin", "https://gitlab.com/a/b.git"], { cwd: r.dir });
  const text = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: r.dir, encoding: "utf8" }).stdout;
  assert.match(text, /^Ask rules before what leaves the machine: .* · the gh commands not proposed: every remote is on another host \(an SSH alias or an Enterprise host the scan cannot recognize reads as one\), so gh repo create and gh api run unasked\.$/m);
  // A push URL on GitHub counts as well as a fetch URL.
  const push = setup({}, { nodes: [{ id: "a" }] });
  git(["remote", "add", "up", "https://gitlab.com/a/b.git"], { cwd: push.dir });
  git(["remote", "set-url", "--push", "up", "git@github.com:a/b.git"], { cwd: push.dir });
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: push.dir, encoding: "utf8" }).stdout).agentSetup.ask.githubRemotes, ["up"]);
  git(["remote", "add", "fork", "ssh://git@ssh.github.com:443/a/b.git"], { cwd: r.dir });
  const scan = JSON.parse(spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: r.dir, encoding: "utf8" }).stdout);
  assert.deepEqual([scan.agentSetup.ask.githubRemotes, scan.agentSetup.ask.rules.some((/** @type {any} */ x) => x.command === "gh release")], [["fork"], true]);
});

test("uninstall: install-hook records its hook by sha256; uninstall-hook removes it while unchanged, then the state dir, and lists what stays", async () => {
  const { WRITTEN } = await import("../setup/uninstall.mjs");
  const cli = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" } });
  for (const plugin of [false, true]) {
    const r = repo();
    const data = plugin ? mkdtempSync(join(tmpdir(), "en-un-data-")) : null;
    const hook = join(r.dir, ".git", "hooks", "commit-msg");
    assert.equal(cli(r.dir, "install-hook", ...(data ? ["--plugin-data", data] : [])).status, 0);
    const record = JSON.parse(readFileSync(join(r.dir, ".git", "ennyn", WRITTEN), "utf8"));
    assert.deepEqual(record.files.map((/** @type {any} */ f) => [f.path, f.by]), [[join(realpathSync(join(r.dir, ".git", "hooks")), "commit-msg"), "install-hook"]]);
    assert.match(record.files[0].sha256, /^[0-9a-f]{64}$/);
    // Running it again on an unchanged hook keeps one entry.
    assert.equal(cli(r.dir, "install-hook", ...(data ? ["--plugin-data", data] : [])).status, 0);
    assert.equal(JSON.parse(readFileSync(join(r.dir, ".git", "ennyn", WRITTEN), "utf8")).files.length, 1);
    // A hook written before there was a record: a run that finds it unchanged records it.
    rmSync(join(r.dir, ".git", "ennyn", WRITTEN));
    assert.match(cli(r.dir, "install-hook", ...(data ? ["--plugin-data", data] : [])).stdout, /unchanged|already/i);
    assert.equal(JSON.parse(readFileSync(join(r.dir, ".git", "ennyn", WRITTEN), "utf8")).files.length, 1);
    put(r.dir, { ".ennyn/config.json": "{}", "HANDOFF.md": "# h\n", ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)", "PowerShell(git push *)", "Bash(make deploy *)"] } }) });
    const un = cli(r.dir, "uninstall-hook", ...(data ? ["--plugin-data", data] : []));
    assert.equal(un.status, 0, un.stdout + un.stderr);
    assert.equal(existsSync(hook), false);
    assert.equal(existsSync(join(r.dir, ".git", "ennyn")), false);
    assert.match(un.stdout, /^Removed .*commit-msg: install-hook wrote it, and it is unchanged since\.$/m);
    assert.match(un.stdout, /^Removed the state dir .*ennyn\.$/m);
    assert.match(un.stdout, /^ {2}\.ennyn\/config\.json$/m);
    assert.match(un.stdout, /^ {2}HANDOFF\.md$/m);
    assert.match(un.stdout, /^ {2}\.claude\/settings\.json: the ask rules init proposes: Bash\(git push \*\), PowerShell\(git push \*\)$/m);
    assert.doesNotMatch(un.stdout, /make deploy/);
    // The plugin's version record is every repository's: named, never removed.
    if (data) {
      assert.equal(existsSync(join(data, "root")), true);
      assert.match(un.stdout, /^The plugin's version record .*root stays/m);
    }
    // A second run finds nothing to remove and says so.
    const again = cli(r.dir, "uninstall-hook");
    assert.equal(again.status, 0);
    assert.match(again.stdout, /^commit-msg hook: nothing of Ennyn's in .*commit-msg\.$/m);
    assert.match(again.stdout, /^No state dir at /m);
    // The config and the files the agent wrote stay.
    assert.equal(existsSync(join(r.dir, ".ennyn", "config.json")), true);
  }
});

test("uninstall: a hook edited since, one with the marker and no record, a link in its place, another hook and a record naming a place outside the git dir all stay", async () => {
  const { WRITTEN } = await import("../setup/uninstall.mjs");
  const { HOOK_MARKER } = await import("../setup/hook.mjs");
  const cli = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" } });
  const hookOf = (/** @type {string} */ dir) => join(dir, ".git", "hooks", "commit-msg");
  // Edited since install-hook wrote it.
  const edited = repo();
  assert.equal(cli(edited.dir, "install-hook").status, 0);
  writeFileSync(hookOf(edited.dir), `${readFileSync(hookOf(edited.dir), "utf8")}# mine\n`);
  const e = cli(edited.dir, "uninstall-hook");
  assert.equal(e.status, 1);
  assert.match(e.stdout, /^.*commit-msg stays: install-hook wrote it, but it was edited since/m);
  assert.doesNotMatch(e.stdout, /carries Ennyn's hook marker/);
  assert.match(readFileSync(hookOf(edited.dir), "utf8"), /# mine/);
  // The state dir goes all the same; a second run, with no record, still leaves the hook.
  assert.equal(existsSync(join(edited.dir, ".git", "ennyn")), false);
  const e2 = cli(edited.dir, "uninstall-hook");
  assert.equal(e2.status, 1);
  assert.match(e2.stdout, /^.*commit-msg stays: it carries Ennyn's hook marker, but no record says/m);
  assert.equal(existsSync(hookOf(edited.dir)), true);
  // The marker, written by hand, with no record.
  const hand = repo();
  put(hand.dir, { ".git/hooks/commit-msg": `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n` });
  assert.equal(cli(hand.dir, "uninstall-hook").status, 1);
  assert.equal(existsSync(hookOf(hand.dir)), true);
  // A link where the recorded file was: not followed, not removed.
  const linked = repo();
  assert.equal(cli(linked.dir, "install-hook").status, 0);
  const target = join(mkdtempSync(join(tmpdir(), "en-un-target-")), "commit-msg");
  renameSync(hookOf(linked.dir), target);
  symlinkSync(target, hookOf(linked.dir));
  const l = cli(linked.dir, "uninstall-hook");
  assert.equal(l.status, 1);
  assert.match(l.stdout, /stays: it is no longer the regular file install-hook wrote/);
  assert.equal(existsSync(target), true);
  // Another hook: untouched, and nothing to say but that.
  const other = repo();
  put(other.dir, { ".git/hooks/commit-msg": "#!/bin/sh\necho mine\n" });
  const o = cli(other.dir, "uninstall-hook");
  assert.equal(o.status, 0);
  assert.match(o.stdout, /^.*commit-msg is another hook, not Ennyn's; it was not touched\.$/m);
  assert.equal(readFileSync(hookOf(other.dir), "utf8"), "#!/bin/sh\necho mine\n");
  // A record that names a file outside the git dir, with its true bytes: the record is not trusted for it.
  const outside = repo();
  const far = join(mkdtempSync(join(tmpdir(), "en-un-far-")), "f");
  writeFileSync(far, "x");
  const { createHash } = await import("node:crypto");
  put(outside.dir, { [`.git/ennyn/${WRITTEN}`]: JSON.stringify({ files: [{ path: realpathSync(far), sha256: createHash("sha256").update("x").digest("hex"), by: "install-hook" }] }) });
  const f = cli(outside.dir, "uninstall-hook");
  assert.equal(f.status, 1);
  assert.match(f.stdout, /stays: the record names it, but install-hook writes only the commit-msg hook git runs/);
  assert.equal(existsSync(far), true);
});

test("uninstall: under a tracked hooks directory the lines that call commit-check are named, and nothing is removed", async () => {
  const { hookBlock } = await import("../setup/hook.mjs");
  const { checkLines } = await import("../setup/uninstall.mjs");
  const r = repo();
  const block = hookBlock(join(tmpdir(), "ennyn-ennyn"));
  const text = `#!/bin/sh\n${block}echo mine\n`;
  r.commit("hooks", { "hooks/commit-msg": text });
  chmodSync(join(r.dir, "hooks", "commit-msg"), 0o755);
  git(["config", "core.hooksPath", "hooks"], { cwd: r.dir });
  const n = block.split("\n").length - 1;
  assert.deepEqual(checkLines(text), [{ from: 2, to: n + 1 }]);
  const un = spawnSync(process.execPath, [CLI, "uninstall-hook"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" } });
  assert.equal(un.status, 1);
  assert.match(un.stdout, new RegExp(`^.*hooks/commit-msg is your own hook and calls commit-check in lines 2-${n + 1}; Ennyn writes nothing there\\.`, "m"));
  assert.equal(readFileSync(join(r.dir, "hooks", "commit-msg"), "utf8"), text);
  // A hand-written call is named by its line.
  assert.deepEqual(checkLines("#!/bin/sh\nset -e\nnode x/scripts/ennyn.mjs commit-check --hook \"$1\"\n"), [{ from: 3, to: 3 }]);
  assert.deepEqual(checkLines("#!/bin/sh\necho commit-checker\n"), []);
});

test("uninstall: the state dir goes only when paths.stateDir names a folder called ennyn in the git dir, and not while a mutation journal is there (corpus)", async () => {
  const { ownStateDir } = await import("../setup/uninstall.mjs");
  for (const yes of [".git/ennyn", "./.git/ennyn", ".git\\ennyn", ".git/ennyn/sub", ".git//ennyn/"]) assert.equal(ownStateDir(yes), true, yes);
  for (const no of [".git", ".git/", ".git/hooks", ".git/objects", ".git/ennyn/..", ".git/ennyn-x", ".git/x/ennyn", "ennyn", ".ennyn", "/abs/.git/ennyn"]) assert.equal(ownStateDir(no), false, no);
  const cli = (/** @type {string} */ cwd) => spawnSync(process.execPath, [CLI, "uninstall-hook"], { cwd, encoding: "utf8", env: { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" } });
  // .git/hooks as the state dir: git's own folder stays, whatever it holds.
  const hooks = repo();
  put(hooks.dir, { ".ennyn/config.json": JSON.stringify({ paths: { stateDir: ".git/hooks" } }), ".git/hooks/pre-commit": "#!/bin/sh\n" });
  const h = cli(hooks.dir);
  assert.equal(h.status, 1);
  assert.match(h.stdout, /^The state dir .*hooks stays: paths\.stateDir names no folder called ennyn/m);
  assert.equal(existsSync(join(hooks.dir, ".git", "hooks", "pre-commit")), true);
  // A mutation journal: a file a mutate run left changed; its original is in the journal.
  const mut = repo();
  put(mut.dir, { ".git/ennyn/mutate-0123456789ab.json": "{}" });
  const m = cli(mut.dir);
  assert.equal(m.status, 1);
  assert.match(m.stdout, /holds a mutation journal \(mutate-0123456789ab\.json\)/);
  assert.equal(existsSync(join(mut.dir, ".git", "ennyn", "mutate-0123456789ab.json")), true);
  // A link in the state dir's place stays, and what it points at too.
  const link = repo();
  const away = mkdtempSync(join(tmpdir(), "en-un-away-"));
  writeFileSync(join(away, "keep"), "x");
  symlinkSync(away, join(link.dir, ".git", "ennyn"));
  assert.equal(cli(link.dir).status, 1);
  assert.equal(existsSync(join(away, "keep")), true);
});

test("uninstall (review round 1): only the commit-msg hook git runs is removed on the record's word, re-read at the removal; a link on the way to the state dir keeps it", async () => {
  const { WRITTEN } = await import("../setup/uninstall.mjs");
  const { createHash } = await import("node:crypto");
  const sha = (/** @type {string} */ p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const env = { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" };
  const cli = (/** @type {string} */ cwd, /** @type {Record<string, string>} */ more = {}) => spawnSync(process.execPath, [CLI, "uninstall-hook"], { cwd, encoding: "utf8", env: { ...env, ...more } });
  const install = (/** @type {string} */ cwd) => assert.equal(spawnSync(process.execPath, [CLI, "install-hook"], { cwd, encoding: "utf8", env }).status, 0);
  const common = (/** @type {string} */ dir) => realpathSync(join(dir, ".git"));
  // A record that names a file of git's own, with its true bytes: kept.
  for (const name of ["config", "index"]) {
    const r = repo();
    r.commit("one", { f: "x" });
    install(r.dir);
    const target = join(common(r.dir), name);
    writeFileSync(join(r.dir, ".git", "ennyn", WRITTEN), JSON.stringify({ files: [{ path: target, sha256: sha(target), by: "install-hook" }] }));
    assert.equal(cli(r.dir).status, 1, name);
    assert.equal(existsSync(target), true, name);
  }
  // A file reached through a link inside .git/hooks: kept, and what the link points at too.
  const l = repo();
  install(l.dir);
  const away = mkdtempSync(join(tmpdir(), "en-un-away-"));
  writeFileSync(join(away, "precious"), "keep");
  symlinkSync(away, join(l.dir, ".git", "hooks", "out"));
  const through = join(common(l.dir), "hooks", "out", "precious");
  writeFileSync(join(l.dir, ".git", "ennyn", WRITTEN), JSON.stringify({ files: [{ path: through, sha256: sha(through), by: "install-hook" }] }));
  assert.equal(cli(l.dir).status, 1);
  assert.equal(existsSync(join(away, "precious")), true);
  // The hook rewritten while the command runs (a git on PATH stands in for another program writing it): kept.
  const w = repo();
  install(w.dir);
  const hook = join(w.dir, ".git", "hooks", "commit-msg");
  const shim = mkdtempSync(join(tmpdir(), "en-un-shim-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const flag = join(shim, "armed");
  writeFileSync(flag, "");
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase "$*" in *hooks*) if [ -f '${flag}' ]; then rm -f '${flag}'; printf '#!/bin/sh\\n# edited\\n' > '${hook}'; fi;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const rw = cli(w.dir, { PATH: `${shim}${delimiter}${process.env.PATH}` });
  assert.equal(existsSync(flag), false, "the stand-in wrote the hook");
  assert.equal(rw.status, 1, rw.stdout);
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\n# edited\n");
  // .git/ennyn a link to a folder elsewhere, the state dir below it: kept, and the folder elsewhere too.
  const s = repo();
  put(s.dir, { ".ennyn/config.json": JSON.stringify({ paths: { stateDir: ".git/ennyn/sub" } }) });
  const elsewhere = mkdtempSync(join(tmpdir(), "en-un-else-"));
  put(elsewhere, { "sub/precious": "keep" });
  symlinkSync(elsewhere, join(s.dir, ".git", "ennyn"));
  const st = cli(s.dir);
  assert.equal(st.status, 1, st.stdout);
  assert.equal(existsSync(join(elsewhere, "sub", "precious")), true);
  // The same with the link's target inside the git dir: the link alone keeps it.
  const inside = repo();
  put(inside.dir, { ".ennyn/config.json": JSON.stringify({ paths: { stateDir: ".git/ennyn/sub" } }), ".git/other/sub/precious": "keep" });
  symlinkSync(join(common(inside.dir), "other"), join(inside.dir, ".git", "ennyn"));
  assert.equal(cli(inside.dir).status, 1);
  assert.equal(existsSync(join(inside.dir, ".git", "other", "sub", "precious")), true);
  // A file in the state dir's place: kept, and said.
  const plain = repo();
  put(plain.dir, { ".git/ennyn": "x" });
  const pl = cli(plain.dir);
  assert.equal(pl.status, 1);
  assert.match(pl.stdout, /^The state dir .*ennyn stays: it is no folder/m);
  // A file named commit-msg in the git dir that git does not run as the hook: kept.
  const named = repo();
  install(named.dir);
  put(named.dir, { ".git/x/commit-msg": "#!/bin/sh\n" });
  const x = join(common(named.dir), "x", "commit-msg");
  writeFileSync(join(named.dir, ".git", "ennyn", WRITTEN), JSON.stringify({ files: [{ path: x, sha256: sha(x), by: "install-hook" }] }));
  assert.equal(cli(named.dir).status, 1);
  assert.equal(existsSync(x), true);
  // .git/hooks a link to a folder elsewhere: install-hook writes through it, and uninstall-hook keeps what is there.
  const linked = repo();
  const hooksAway = mkdtempSync(join(tmpdir(), "en-un-hooks-"));
  rmSync(join(linked.dir, ".git", "hooks"), { recursive: true, force: true });
  symlinkSync(hooksAway, join(linked.dir, ".git", "hooks"));
  install(linked.dir);
  assert.equal(existsSync(join(hooksAway, "commit-msg")), true);
  assert.equal(cli(linked.dir).status, 1);
  assert.equal(existsSync(join(hooksAway, "commit-msg")), true);
});

test("uninstall (review round 1): the hook is moved aside and hashed again before it goes; one that no longer matches goes back", async () => {
  const { removeIfSame } = await import("../setup/uninstall.mjs");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "en-un-aside-"));
  const p = join(dir, "commit-msg");
  writeFileSync(p, "mine");
  assert.equal(removeIfSame(p, createHash("sha256").update("ennyn").digest("hex")), "changed");
  assert.equal(readFileSync(p, "utf8"), "mine");
  assert.deepEqual(readdirSync(dir), ["commit-msg"]);
  // A read that fails: the file is back in place, and the error goes on.
  assert.throws(() => removeIfSame(p, "0", () => { throw new Error("EACCES: no read"); }), /EACCES/);
  assert.equal(readFileSync(p, "utf8"), "mine");
  assert.deepEqual(readdirSync(dir), ["commit-msg"]);
  assert.equal(removeIfSame(p, createHash("sha256").update("mine").digest("hex")), "removed");
  assert.deepEqual(readdirSync(dir), []);
});

test("uninstall (review round 2): no hard links puts the hook back by rename; a missing hooks folder reads as gone; a recorded hook git no longer runs is said; a path recorded twice is read once", async () => {
  const { removeIfSame, WRITTEN } = await import("../setup/uninstall.mjs");
  const { createHash } = await import("node:crypto");
  const noLink = () => { throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }); };
  // A file system with no hard links: the edited hook goes back by rename, nothing left aside.
  const dir = mkdtempSync(join(tmpdir(), "en-un-nolink-"));
  const p = join(dir, "commit-msg");
  writeFileSync(p, "mine");
  assert.equal(removeIfSame(p, "0", readFileSync, noLink), "changed");
  assert.equal(readFileSync(p, "utf8"), "mine");
  assert.deepEqual(readdirSync(dir), ["commit-msg"]);
  // The same with a failed read: back, then the error.
  assert.throws(() => removeIfSame(p, "0", () => { throw new Error("EIO: no read"); }, noLink), /EIO/);
  assert.deepEqual(readdirSync(dir), ["commit-msg"]);
  // Something new at the hook's place: the old one stays aside.
  assert.equal(removeIfSame(p, "0", (a) => (writeFileSync(p, "new"), readFileSync(a)), noLink), "aside");
  assert.equal(readFileSync(p, "utf8"), "new");
  assert.equal(readdirSync(dir).length, 2);
  // A matching hook still goes.
  const q = join(mkdtempSync(join(tmpdir(), "en-un-nolink-")), "commit-msg");
  writeFileSync(q, "ennyn");
  assert.equal(removeIfSame(q, createHash("sha256").update("ennyn").digest("hex"), readFileSync, noLink), "removed");
  const env = { ...process.env, ENNYN_PLUGIN_DATA: "", ENNYN_PLUGIN_ROOT: "" };
  const run = (/** @type {string} */ cwd, /** @type {string} */ cmd) => spawnSync(process.execPath, [CLI, cmd], { cwd, encoding: "utf8", env });
  // The hooks folder deleted by hand: the hook is gone, the state dir goes, exit 0, and so on every run.
  const h = repo();
  assert.equal(run(h.dir, "install-hook").status, 0);
  rmSync(join(h.dir, ".git", "hooks"), { recursive: true });
  const hu = run(h.dir, "uninstall-hook");
  assert.equal(hu.status, 0, hu.stdout + hu.stderr);
  assert.match(hu.stdout, /commit-msg: install-hook wrote it, and it is gone already\./);
  assert.equal(existsSync(join(h.dir, ".git", "ennyn")), false);
  assert.equal(run(h.dir, "uninstall-hook").status, 0);
  // core.hooksPath set after the install: the recorded hook is unchanged, but git no longer runs it.
  const m = repo();
  assert.equal(run(m.dir, "install-hook").status, 0);
  git(["config", "core.hooksPath", ".git/myhooks"], { cwd: m.dir });
  const mu = run(m.dir, "uninstall-hook");
  assert.equal(mu.status, 1);
  assert.match(mu.stdout, /commit-msg stays: install-hook wrote it and it is unchanged, but git no longer runs it/);
  assert.equal(existsSync(join(m.dir, ".git", "hooks", "commit-msg")), true);
  // A record that names the hook twice: one entry, removed once.
  const d = repo();
  assert.equal(run(d.dir, "install-hook").status, 0);
  const rec = join(d.dir, ".git", "ennyn", WRITTEN);
  const j = JSON.parse(readFileSync(rec, "utf8"));
  j.files.push(j.files[0]);
  writeFileSync(rec, JSON.stringify(j));
  const du = run(d.dir, "uninstall-hook");
  assert.equal(du.status, 0, du.stdout);
  assert.equal(du.stdout.match(/^Removed .*commit-msg/gm)?.length, 1);
});

// scan-design-decision (cycle 56): each question scan.mjs shares with another module has one site that answers it.
test("scan design decision: origin names a GitHub repository exactly when isGithubHost reads the remote's host GitHub", async () => {
  const scan = await import("../setup/scan.mjs");
  const { isGithubHost, urlHost } = await import("../setup/permissions.mjs");
  /** @type {Record<string, string | null>} remote URL → the repository the scan names */
  const remotes = {
    "https://github.com/o/r.git": "o/r",
    "git@github.com:o/r.git": "o/r",
    "ssh://git@github.com/o/r": "o/r",
    "git://github.com/o/r": "o/r",
    "https://github.com/o/r/": "o/r",
    "https://github.com/o/r.git/": "o/r",
    "https://user@GitHub.com/O/R.git": "O/R",
    "https://github.com:443/o/r.git": "o/r",
    "ssh://git@ssh.github.com:443/o/r.git": "o/r",
    "git@ssh.github.com:o/r.git": "o/r",
    "git@github.com-work:o/r.git": "o/r",
    "https://octo.ghe.com/o/r.git": "o/r",
    "octo@octo.ghe.com:o/r.git": "o/r",
    "git@github.example.test:o/r.git": "o/r",
    "https://notgithub.test/o/r.git": null,
    "https://notgithub.com/o/r.git": null,
    "https://evil.test/github.com/o/r": null,
    "https://gitlab.test/github.com/r.git": null,
    "https://www.github.com/o/r.git": null,
    "/srv/github.com/o/r.git": null,
    "../github.com/o/r": null,
    "file:///srv/github.com/o/r.git": null,
  };
  for (const [url, name] of Object.entries(remotes)) {
    assert.equal(scan.githubName(url), name, url);
    // One question, one answer: the scan names a repository on exactly the hosts the permission rules call GitHub.
    const host = urlHost(url);
    assert.equal(name !== null, host !== null && isGithubHost(host), url);
  }
  // On a GitHub host, a path that is no owner/repo names none.
  for (const url of ["https://github.com/o", "https://github.com/o/r/extra", "git@github.com:o", "https://github.com/"]) assert.equal(scan.githubName(url), null, url);
  // End to end, through the origin remote.
  const r = repo();
  r.commit("feat: start", { "a.txt": "1" });
  git(["remote", "add", "origin", "octo@octo.ghe.com:o/r.git"], { cwd: r.dir });
  assert.equal(scanProject({ cwd: r.dir, env: {} }).github, "o/r");
  git(["remote", "set-url", "origin", "https://evil.test/github.com/o/r"], { cwd: r.dir });
  assert.equal(scanProject({ cwd: r.dir, env: {} }).github, null);
});

test("scan design decision: one parser cuts git log -z --raw, and scan.mjs reads the log only through it", async () => {
  const { rawLog } = await import("../core/git.mjs");
  const r = repo();
  r.commit("feat: one", { a: "1", [`${"a".repeat(40)}`]: "1" });
  // An empty commit whose subject is shaped like a change field.
  r.commit(":000000 100644 0000000 1111111 A");
  mkdirSync(join(r.dir, "sub"), { recursive: true });
  git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`], { cwd: r.dir });
  r.commit("feat: sub and b", { b: "1" });
  const hashes = git(["rev-list", "HEAD"], { cwd: r.dir }).split("\n");
  const changes = [
    [{ status: "A", submodule: false, path: "b" }, { status: "A", submodule: true, path: "sub" }],
    [],
    [{ status: "A", submodule: false, path: "a" }, { status: "A", submodule: false, path: "a".repeat(40) }],
  ];
  const subjects = ["feat: sub and b", ":000000 100644 0000000 1111111 A", "feat: one"];
  const log = (/** @type {string} */ format) => git(["log", "-z", "--no-renames", "--ignore-submodules=none", "--raw", `--format=${format}`], { cwd: r.dir });
  assert.deepEqual(rawLog(log("%H%x00%s"), { subject: true }), hashes.map((hash, i) => ({ hash, subject: subjects[i], changes: changes[i] })));
  assert.deepEqual(rawLog(log("%H")), hashes.map((hash, i) => ({ hash, subject: null, changes: changes[i] })));
  assert.deepEqual(rawLog(""), []);
  assert.throws(() => rawLog("not a hash\0"), /git log printed a field that is no commit/);
  // The second reading is gone: scan.mjs reads no change field itself, and every --raw log it runs goes through rawLog.
  const src = readFileSync(join(dirname(CLI), "..", "setup", "scan.mjs"), "utf8");
  assert.doesNotMatch(src, /\brawChange\b/);
  assert.equal((src.match(/"--raw"/g) ?? []).length, (src.match(/\brawLog\(/g) ?? []).length);
});

test("scan design decision: the risky list's two views, init's glob and the audit's path, select the same files", async () => {
  const { sensitivePaths } = await import("../plan/audit.mjs");
  const { matchAny } = await import("../core/glob.mjs");
  const files = [
    "src/auth/login.ts", "src/auth/deep/x.ts", "app/[locale]/auth/page.tsx", "src/{legacy}/payments/y.ts", "lib/[id]/session.ts",
    "src/a*b/auth/z.ts", "src/q?/security/k.py", "src/a,b/auth/x.ts", "src/x!/auth/y.ts", "app/security.py", "src/auth.service.ts",
    "auth.d.ts", "src/Auth/X.ts", "src/AUTH.ts", "migrations/001.sql", "db/migrations/002.sql", "src/ledger.ts", "src/ledger/a.ts",
    // Not risky, or under no risky folder: both views leave them out.
    "src/authx/y.ts", "src/auth-x/y.ts", "src/payments!/a.ts", "src/.auth/x", "src/auth.d/x.ts", "src/authors.ts", "test/auth/x.test.ts",
    "src/auth2/a.ts", "app/[locale]/page.tsx", "lib/[id]/other.ts", "src/a*b/z.ts", "README.md",
  ];
  const risky = riskyPaths(files, pat());
  assert.ok(risky.length >= 15, String(risky.length));
  const byGlob = files.filter((f) => matchAny(f, risky.map((x) => x.glob)));
  const byPath = sensitivePaths(files, DEFAULTS).find((s) => s.source === "init-scan risky")?.files ?? [];
  assert.deepEqual(byPath, byGlob);
  assert.ok(byGlob.includes("src/q?/security/k.py") && !byGlob.includes("src/a*b/z.ts") && !byGlob.includes("app/[locale]/page.tsx"), byGlob.join(" "));
});

test("scan design decision: the history a new project is judged by counts empty commits and a submodule's path, through rawLog", async () => {
  const { NEW_HISTORY } = await import("../setup/scan.mjs");
  /** A repository written by git fast-import, nothing checked out: commit i holds ops[i]. @param {string[]} ops */
  const imported = (ops) => {
    const dir = folder();
    git(["init", "-q", "-b", "main"], { cwd: dir });
    const data = (/** @type {string} */ s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
    git(["fast-import", "--quiet"], { cwd: dir, input: ops.map((op, i) => `commit refs/heads/main\ncommitter t <t@t> ${1700000000 + i} +0000\n${data(`c${i}`)}${op}\n`).join("") });
    return dir;
  };
  const readme = `M 100644 inline README.md\ndata 4\n# x\n\n`;
  // Past the commits read, though all but the first change nothing: an empty commit is a commit read.
  assert.deepEqual(newVerdict(imported([readme, ...many(NEW_HISTORY, () => "")])), { ...notNew([]), unmeasured: [{ reason: "historyCap", n: NEW_HISTORY }] });
  assert.deepEqual(newVerdict(imported([readme, ...many(NEW_HISTORY - 1, () => "")])), NEW);
  // A submodule the history added and removed is no file, but its path is one the project held.
  assert.deepEqual(newVerdict(imported([readme, `M 160000 ${"1".repeat(40)} lib/sub\n`, "D lib/sub\n"])), notNew(["lib/"]));
});
