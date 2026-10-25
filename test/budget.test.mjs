import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { ruleKey, instructionBudget, readBudgets, recordBudget, previousBudget } from "../setup/budget.mjs";
import { importsOf } from "../setup/scan.mjs";
import { lineKey } from "../plan/audit.mjs";
import { checkSetup } from "../setup/doctor.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const RULE = "Commit messages are written in English with a conventional type";

test("budget: the same rule under other list markers, numbering, quotes, pipes or emphasis is one rule", () => {
  const same = [`- **${RULE}**`, `1. ${RULE}`, `> ${RULE}`, `| \`${RULE}\` |`, `   * ${RULE.toUpperCase()}`, `${RULE}`];
  assert.equal(new Set(same.map(ruleKey)).size, 1);
  assert.notEqual(ruleKey(`${RULE}, except docs`), ruleKey(RULE));
});

test("budget: sizes by load kind; repeats across loaded files, marked when a copy loads every session; not headings, code or other agents' files", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-"));
  const HEADING = "## Commit messages and the rules for writing them well";
  const CODE = "npm run validate:fast -- --only the checks that touch this file";
  const claude = `# Rules\n${HEADING}\n- **${RULE}**\nA rule that is written in this one file only and nowhere else\n${CODE}\nshort line\n`;
  // In the other file the heading repeats, and the command sits inside a code block: neither is a repeated rule.
  const always = `${HEADING}\n1. ${RULE}\n\`\`\`sh\n${CODE}\n\`\`\`\n`;
  const scoped = (/** @type {string} */ name) => `---\npaths:\n  - src/${name}/**\n---\n- Every handler validates its input before it reads the database\n`;
  const files = { "CLAUDE.md": claude, ".claude/rules/always.md": always, ".claude/rules/a.md": scoped("a"), ".claude/rules/b.md": scoped("b"), "AGENTS.md": `- ${RULE}\n` };
  put(dir, files);
  const b = instructionBudget(dir, Object.keys(files));
  assert.equal(b.always, Buffer.byteLength(claude) + Buffer.byteLength(always));
  assert.equal(b.onDemand, 2 * Buffer.byteLength(scoped("a")));
  assert.equal(b.files, 4, "AGENTS.md is not loaded by Claude Code unless imported");
  // Rules for different paths may never load together: a repeat, but not one loaded twice every session.
  assert.deepEqual(b.repeated.map((r) => [r.files, r.everySession]), [
    [[".claude/rules/always.md", "CLAUDE.md"], true],
    [[".claude/rules/a.md", ".claude/rules/b.md"], false],
  ]);
  assert.deepEqual([b.repeatedLines, b.repeatedEverySession], [2, 1]);
  const empty = instructionBudget(mkdtempSync(join(tmpdir(), "en-budget0-")), []);
  assert.deepEqual([empty.always, empty.repeatedLines], [0, 0]);
});

test("budget audit: a metrics log that cannot be read is no empty log", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const dir = mkdtempSync(join(tmpdir(), "en-budget-log-"));
  const log = join(dir, "metrics.jsonl");
  writeFileSync(log, `${JSON.stringify({ kind: "budget", date: "2026-10-01", commit: "a".repeat(40), always: 1 })}\n`);
  chmodSync(log, 0o000);
  try {
    assert.throws(() => readBudgets(log), /EACCES/);
  } finally {
    chmodSync(log, 0o644);
  }
  assert.deepEqual(readBudgets(join(dir, "none.jsonl")), { records: [], skipped: 0, unusable: 0 }, "no log is still no records");
});

test("budget audit: an @ that names a directory imports nothing, and is no file it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-dir-"));
  const claude = "# Rules\n\nRead @docs/ and @src before a change.\n";
  put(dir, { "CLAUDE.md": claude, "docs/guide.md": "# Guide\n", "src/a.js": "export const a = 1;\n" });
  const b = instructionBudget(dir, ["CLAUDE.md", "docs/guide.md", "src/a.js"]);
  assert.deepEqual([b.always, b.files], [Buffer.byteLength(claude), 1]);
});

test("budget: imported files load with their importer; untracked files are this machine's; skill and agent descriptions count; a rule-dir CLAUDE.md counts once", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-imp-"));
  // A file that really exists next to the repository: an import that leaves the repository is not counted.
  const outside = `outside-${dir.split(/[\\/]/).pop()}.md`;
  writeFileSync(join(dirname(dir), outside), "not this repository\x27s\n");
  const claude = `@AGENTS.md is the rule set.\nSee \`@quoted.md\` too.\n\`\`\`\n@fenced.md\n\`\`\`\n@../${outside} and @~/home.md\n`;
  const files = {
    "CLAUDE.md": claude,
    "AGENTS.md": `- ${RULE}\n`,
    "quoted.md": "q\n",
    "fenced.md": "f\n",
    ".claude/rules/web/CLAUDE.md": "web rules, loaded every session\n",
    ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Reviews a change\n---\nlong body that only loads when the skill runs\n",
    ".claude/agents/checker.md": "---\nname: checker\ndescription: Checks it\n---\nbody\n",
  };
  put(dir, { ...files, "CLAUDE.local.md": "my own notes\n" });
  const b = instructionBudget(dir, Object.keys(files));
  const listings = Buffer.byteLength("review: Reviews a change") + Buffer.byteLength("checker: Checks it");
  assert.equal(b.listings, listings);
  assert.equal(b.always, Buffer.byteLength(claude) + Buffer.byteLength(`- ${RULE}\n`) + Buffer.byteLength("web rules, loaded every session\n") + listings);
  assert.deepEqual(b.untracked, ["CLAUDE.local.md"]);
  assert.equal(b.files, 3, "CLAUDE.md, the imported AGENTS.md and the rule-dir CLAUDE.md once");
  assert.deepEqual(importsOf("Read @../AGENTS.md, then @x.md.\n`@no.md`\n@../../escape.md @~/home.md @/etc/abs.md\n", "docs/CLAUDE.md"), ["AGENTS.md", "docs/x.md"]);
});

test("budget: one record per commit; the change is measured against another commit's record; broken lines are counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-log-"));
  const a = recordBudget(dir, ".ennyn/metrics.jsonl", { always: 100, onDemand: 5, repeatedLines: 1 }, { date: "2026-10-19", commit: "abc" });
  assert.deepEqual([a.path, a.replaced], [join(dir, ".ennyn", "metrics.jsonl"), false]);
  // Recording again at the same commit (after the cycle's own clean-up) replaces that record.
  assert.equal(recordBudget(dir, ".ennyn/metrics.jsonl", { always: 120, onDemand: 5, repeatedLines: 1 }, { date: "2026-10-19", commit: "abc" }).replaced, true);
  writeFileSync(a.path, readFileSync(a.path, "utf8") + '{"kind":"other","always":9}\n{ broken\n');
  recordBudget(dir, ".ennyn/metrics.jsonl", { always: 90, onDemand: 5, repeatedLines: 0 }, { date: "2026-10-20", commit: "def" });
  const log = readBudgets(a.path);
  assert.deepEqual([log.records.map((r) => [r.commit, r.always]), log.skipped], [[["abc", 120], ["def", 90]], 1]);
  assert.equal(previousBudget(log.records, "def")?.commit, "abc", "recording twice at def does not hide def's change");
  assert.equal(previousBudget(log.records, "zzz")?.commit, "def");
  assert.deepEqual(readBudgets(join(dir, "missing.jsonl")), { records: [], skipped: 0, unusable: 0 });
});

test("cli and doctor: budget --record keeps a number per cycle; growth warns with its bytes; a broken log line is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-cli-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { "CLAUDE.md": `${RULE}\n`, ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a" }] }) });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: x"], { cwd: dir });
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, "budget", ...args], { cwd: dir, encoding: "utf8" });
  assert.match(run().stdout, /no record yet\)/);
  const first = run("--record");
  assert.match(first.stdout, /first record\)/);
  assert.match(first.stdout, /Recorded in .*metrics\.jsonl/);
  assert.match(run("--record").stdout, /Replaced the record for [0-9a-f]{10} in .*metrics\.jsonl\./);
  const stored = JSON.parse(readFileSync(join(dir, ".ennyn", "metrics.jsonl"), "utf8").trim().split("\n").pop() ?? "");
  assert.equal(stored.commit, git(["rev-parse", "HEAD"], { cwd: dir }), "the full hash: a short one changes length between machines");
  const items = async () => (await checkSetup({ cwd: dir, env: {} })).items;
  assert.ok((await items()).some((i) => i.key === "doctor.budget"));
  writeFileSync(join(dir, "CLAUDE.md"), `${RULE}\n${"another rule that someone added to the file ".repeat(30)}\n`);
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: y"], { cwd: dir });
  assert.match(run().stdout, /\+1\.\d KB, 1\d\d\d bytes, since [0-9a-f]+\)/);
  const grew = (await items()).find((i) => i.key === "doctor.budgetGrew");
  assert.ok(grew && Number(grew.vars.bytes) > 1000);
  writeFileSync(join(dir, ".ennyn", "metrics.jsonl"), readFileSync(join(dir, ".ennyn", "metrics.jsonl"), "utf8") + "{ cut sho");
  assert.match(run().stdout, /1 lines in .*metrics\.jsonl do not parse and were left out\./);
  assert.ok((await items()).some((i) => i.key === "doctor.budgetLogBroken"));
});

test("budget: descriptions written as YAML blocks and command descriptions count", async () => {
  const { frontMatterField } = await import("../setup/budget.mjs");
  assert.equal(frontMatterField("name: x\ndescription: >\n  folded over\n  two lines\nother: y", "description"), "folded over two lines");
  assert.equal(frontMatterField("description: |\n  kept\n  apart\n", "description"), "kept\napart");
  assert.equal(frontMatterField("description: plain", "description"), "plain");
  const dir = mkdtempSync(join(tmpdir(), "en-budget-desc-"));
  const long = "x".repeat(500);
  const files = {
    ".claude/skills/big/SKILL.md": `---\nname: big\ndescription: >\n  ${long}\n---\nbody\n`,
    ".claude/commands/team/ship.md": "---\ndescription: Ships it\n---\nbody\n",
    ".claude/commands/plain.md": "no front matter: no listing counted\n",
    ".claude/commands/tools.md": "---\nallowed-tools: Bash\n---\nfront matter without a description: nothing listed\n",
  };
  put(dir, files);
  assert.equal(instructionBudget(dir, Object.keys(files)).listings, Buffer.byteLength(`big: ${long}`) + Buffer.byteLength("team/ship: Ships it"));
});

test("budget audit: a budget record with no commit is a line it skips, for doctor and the budget command, never a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-nocommit-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { "CLAUDE.md": `${RULE}\n`, ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "a" }] }) });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: x"], { cwd: dir });
  const log = join(dir, ".ennyn", "metrics.jsonl");
  const bad = [{ always: 1 }, { commit: 7, always: 1 }, { commit: "c", always: "1" }, { commit: "c", always: -5 }, { commit: "c", always: 207.5 }, { commit: "c", always: 1e300 }];
  const lines = [...bad.map((r) => JSON.stringify({ kind: "budget", ...r })), '{"kind":"budget","commit":"","always":1}', "{ cut"];
  writeFileSync(log, lines.join("\n") + "\n");
  const read = readBudgets(log);
  assert.deepEqual([read.records.length, read.unusable, read.skipped], [1, bad.length, 1], "no commit string, or a size that is not a whole number of bytes: no record; an empty commit is one (recorded outside a repository)");
  const run = spawnSync(process.execPath, [CLI, "budget"], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  // Each reason said as it is: a line that parses is not called one that does not.
  assert.match(run.stdout, /^1 lines in .*metrics\.jsonl do not parse and were left out\.$/m);
  assert.match(run.stdout, /^6 budget records in .*metrics\.jsonl have no commit or no whole size in bytes and were left out\.$/m);
  const items = async () => (await checkSetup({ cwd: dir, env: {} })).items.map((i) => `${i.level} ${i.key}`);
  for (const key of ["warn doctor.budgetLogBroken", "warn doctor.budgetLogUnusable", "warn doctor.budgetGrew"]) assert.ok((await items()).includes(key), `${key}\n${(await items()).join("\n")}`);
  // Measured against the newest record, not the first.
  writeFileSync(log, `${JSON.stringify({ kind: "budget", date: "2026-10-01", commit: "a", always: 1 })}\n${JSON.stringify({ kind: "budget", date: "2026-10-02", commit: "b", always: 1e6 })}\n`);
  assert.ok((await items()).includes("ok doctor.budget"), (await items()).join("\n"));
});

test("budget audit (review): a record after a torn last line starts a line of its own, so it is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-torn-"));
  const path = join(dir, ".ennyn", "metrics.jsonl");
  put(dir, { ".ennyn/metrics.jsonl": `${JSON.stringify({ kind: "budget", date: "2026-10-01", commit: "a", always: 5, onDemand: 0, repeatedLines: 0 })}\n{ cut sho` });
  recordBudget(dir, ".ennyn/metrics.jsonl", { always: 7, onDemand: 0, repeatedLines: 0 }, { date: "2026-10-02", commit: "b" });
  const log = readBudgets(path);
  assert.deepEqual([log.records.map((r) => r.commit), log.skipped], [["a", "b"], 1]);
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  // A log made by the first record holds that line alone.
  const fresh = recordBudget(dir, "new.jsonl", { always: 1, onDemand: 0, repeatedLines: 0 }, { date: "2026-10-03", commit: "c" });
  assert.equal(readFileSync(fresh.path, "utf8"), `${JSON.stringify(fresh.entry)}\n`);
});

test("budget audit (review round two): the files a repeated rule sits in are shown as names, one line each", (t) => {
  if (process.platform === "win32") return t.skip("no such names on Windows");
  const dir = mkdtempSync(join(tmpdir(), "en-budget-names-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  const odd = ".claude/rules/r\u001b[2K\u001b[G✓ fine.md";
  put(dir, { "CLAUDE.md": `${RULE}\n`, [odd]: `${RULE}\n`, ".claude/rules/x, y.md": `${RULE}\n` });
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: x"], { cwd: dir });
  // An untracked rule file, this machine's own, is listed by name too.
  put(dir, { ".claude/rules/u\u001b[2K.md": "a rule of this machine's own\n" });
  const out = spawnSync(process.execPath, [CLI, "budget"], { cwd: dir, encoding: "utf8" }).stdout;
  for (const l of out.split("\n")) assert.doesNotMatch(l, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, JSON.stringify(l));
  assert.match(out, /untracked\): ".*u\\u001b\[2K\.md"/);
  assert.match(out, /"\.claude\/rules\/r\\u001b\[2K\\u001b\[G✓ fine\.md"/);
  assert.match(out, /"\.claude\/rules\/x, y\.md"/);
});

/** A repository for the audit commands; the metrics log stays untracked, so every branch writes into one log. */
function auditRepo(/** @type {Record<string, string>} */ files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "en-audit-cli-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { "README.md": "x\n", ...files });
  git(["add", "-A"], { cwd: dir });
  const commit = (/** @type {string} */ m) => git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", m], { cwd: dir });
  commit("feat: x");
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
  const json = () => JSON.parse(run("audit", "--json").stdout);
  return { dir, commit, run, json, log: join(dir, ".ennyn", "metrics.jsonl") };
}

/** The key of one line of a log. @param {string} line */
const keyOf = (line) => lineKey(Buffer.from(line));

test("cli: audit counts the cycles no mark covers; --security-audit lists the keys it covers, and records the cycle unmarked when the audit was not due", () => {
  const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/f${String(i).padStart(2, "0")}.js`, "x\n"]));
  const { dir, commit, run, json, log } = auditRepo({ ".ennyn/config.json": JSON.stringify({ review: { impactRequiredGlobs: ["src/**"] } }), "src/a.js": "x\n", ...many });
  // No log, so no audit recorded: it is due, and every path it reads is named.
  const first = run("audit");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Audit slot: the security audit of the sensitive paths, with a path table\. Due: no security audit is recorded in \.ennyn\/metrics\.jsonl \(0 cycles recorded\)\.$/m);
  assert.match(first.stdout, /^ {2}review\.impactRequiredGlobs: 12 files · src\/a\.js, (src\/f\d\d\.js, ){10}src\/f10\.js$/m);
  assert.match(first.stdout, /^ {2}ennyn: 1 files · \.ennyn\/config\.json$/m);
  // The cycle that held it marks its record, which covers what came before it (nothing yet) and itself.
  assert.match(run("budget", "--record", "--security-audit").stdout, /^The record marks this cycle's security audit\.$/m);
  const again = run("budget", "--record", "--security-audit");
  assert.equal(again.status, 0, "marked again at the same commit: its own record is left out of the count");
  assert.doesNotMatch(again.stdout, /record replaced/, "the same commit, today, the same mark: this cycle recording again, silent");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()).covers, []);
  assert.deepEqual([json().slot, json().since, json().paths], ["feature", 0, []]);
  assert.match(run("audit").stdout, /^Audit slot: a finished feature\. The security audit is due in 2 cycles \(0 cycles no security audit covered; security\.everyCycles: 3\)\.$/m);
  commit("feat: y");
  // A mark the audit rules out: the cycle is recorded without it, exit 1, and the message says what happened.
  const refused = run("budget", "--record", "--security-audit");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^Recorded without the security-audit mark: ennyn audit, leaving out this cycle's own record \(the one at this commit\), says the security audit is not due \(0 cycles no security audit covered; security\.everyCycles: 3\)\. The cycle is counted; if it did hold the security audit, the audit comes back early\.$/m);
  const y = readFileSync(log, "utf8").trim().split("\n").pop() ?? "";
  assert.deepEqual([JSON.parse(y).commit, JSON.parse(y).securityAudit], [git(["rev-parse", "HEAD"], { cwd: dir }), undefined]);
  assert.deepEqual([json().due, json().since], [false, 1]);
  commit("feat: z");
  run("budget", "--record");
  const z = readFileSync(log, "utf8").trim().split("\n").pop() ?? "";
  assert.deepEqual([json().due, json().reason, json().since, json().cycles], [true, "since", 2, 3]);
  // The next mark covers the two cycles no mark covered, by their keys, and the count starts again.
  commit("feat: w");
  assert.equal(run("budget", "--record", "--security-audit").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop() ?? "").covers, [keyOf(y), keyOf(z)]);
  assert.deepEqual([json().due, json().since], [false, 0]);
  // A line that does not parse is a cycle no mark covers.
  writeFileSync(log, `${readFileSync(log, "utf8")}{ cut\n`);
  assert.deepEqual([json().due, json().since, run("audit").status], [false, 1, 0]);
  assert.equal(run("budget", "--security-audit").status, 2, "without --record the flag is a usage error");
  // A commit check turned off: its files are still listed, by the default globs, and it says so.
  put(dir, { ".ennyn/config.json": JSON.stringify({ security: { ci: { paths: [] }, everyCycles: 1 } }), ".github/workflows/ci.yml": "on: push\n" });
  git(["add", ".github/workflows/ci.yml"], { cwd: dir });
  assert.match(run("audit").stdout, /^ {2}security\.ci\.paths \(its commit check is off; the default paths\): 1 files · \.github\/workflows\/ci\.yml$/m);
  // security.everyCycles 0: the slot is off, and a mark is refused, but the cycle is still recorded.
  put(dir, { ".ennyn/config.json": JSON.stringify({ security: { everyCycles: 0 } }) });
  assert.deepEqual([run("audit").stdout.trim(), run("audit").status], ["Audit slot: a finished feature. security.everyCycles is 0: no security audit is scheduled.", 0]);
  commit("feat: off");
  const off = run("budget", "--record", "--security-audit");
  assert.deepEqual([off.status, /security\.everyCycles is 0/.test(off.stderr), readFileSync(log, "utf8").includes(git(["rev-parse", "HEAD"], { cwd: dir }))], [1, true, true]);
  const offJson = run("budget", "--record", "--security-audit", "--json");
  assert.deepEqual([offJson.status, JSON.parse(offJson.stdout).markRefused, JSON.parse(offJson.stdout).recorded.securityAudit], [1, true, undefined]);
});

/** Cycles on a tracked log: each asks the audit at its start, records at its last work commit, and closes with a commit that adds the line. */
function trackedRepo(/** @type {Record<string, string>} */ files = {}) {
  const r = auditRepo(files);
  const close = (/** @type {string} */ m) => {
    git(["add", "-f", ".ennyn/metrics.jsonl"], { cwd: r.dir });
    r.commit(m);
  };
  /** @param {number} n @returns {boolean | null} what the audit said at the cycle's start */
  const cycle = (n) => {
    const at = r.json();
    r.commit(`feat: work ${n}`);
    const rec = r.run("budget", "--record", ...(at.due !== false ? ["--security-audit"] : []));
    assert.equal(rec.status, 0, rec.stderr);
    close(`chore: cycle ${n} closed`);
    return at.due;
  };
  return { ...r, close, cycle };
}
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
const TWELVE = Array.from({ length: 12 }, (_, i) => i + 1);
const audits = (/** @type {(boolean | null)[]} */ dues) => dues.flatMap((d, i) => (d !== false ? [i + 1] : []));

test("cli: twelve cycles audit at 1, 4, 7 and 10 on the main line, squash-merged, rebase-merged and amended alike", () => {
  const plain = trackedRepo();
  assert.deepEqual(audits(TWELVE.map(plain.cycle)), [1, 4, 7, 10], "on main");
  const squash = trackedRepo();
  const squashed = TWELVE.map((n) => {
    git(["checkout", "-q", "-b", `f${n}`], { cwd: squash.dir });
    const due = squash.cycle(n);
    git(["checkout", "-q", "main"], { cwd: squash.dir });
    git(["merge", "-q", "--squash", `f${n}`], { cwd: squash.dir });
    git([...ID, "commit", "-q", "-m", `feat: f${n}`], { cwd: squash.dir });
    return due;
  });
  assert.deepEqual(audits(squashed), [1, 4, 7, 10], "squash merge");
  // Rebase and merge: every commit made again on main (main moved, so none comes out the same).
  const rebase = trackedRepo();
  const rebased = TWELVE.map((n) => {
    git(["checkout", "-q", "-b", `r${n}`], { cwd: rebase.dir });
    const due = rebase.cycle(n);
    git(["checkout", "-q", "main"], { cwd: rebase.dir });
    rebase.commit(`feat: main moved ${n}`);
    git([...ID, "cherry-pick", "--allow-empty", `main..r${n}`], { cwd: rebase.dir });
    return due;
  });
  assert.deepEqual(audits(rebased), [1, 4, 7, 10], "rebase merge, cherry-pick");
  const amend = trackedRepo();
  const amended = TWELVE.map((n) => {
    const due = amend.cycle(n);
    git([...ID, "commit", "-q", "--amend", "--allow-empty", "-m", `chore: cycle ${n} closed, amended`], { cwd: amend.dir });
    return due;
  });
  assert.deepEqual(audits(amended), [1, 4, 7, 10], "amend");
});

test("cli: a branch's audit covers only what its log held: landed by squash or by a merge, the two cycles main ran meanwhile stay due", () => {
  for (const land of ["squash", "merge"]) {
    const r = trackedRepo({ ".gitattributes": ".ennyn/metrics.jsonl merge=union\n" });
    assert.equal(r.cycle(1), true);
    git(["checkout", "-q", "-b", "audit"], { cwd: r.dir });
    // The branch runs its own security audit (every cycle is due there).
    put(r.dir, { ".ennyn/config.json": JSON.stringify({ security: { everyCycles: 1 } }) });
    r.commit("feat: branch work");
    assert.equal(r.run("budget", "--record", "--security-audit").status, 0);
    rmSync(join(r.dir, ".ennyn", "config.json"));
    r.close("chore: branch audit closed");
    git(["checkout", "-q", "main"], { cwd: r.dir });
    assert.deepEqual([r.cycle(2), r.cycle(3)], [false, false]);
    if (land === "squash") {
      git(["merge", "-q", "--squash", "audit"], { cwd: r.dir });
      git([...ID, "commit", "-q", "-m", "feat: the branch, squashed"], { cwd: r.dir });
    } else git([...ID, "merge", "-q", "--no-edit", "audit"], { cwd: r.dir });
    assert.deepEqual([r.json().due, r.json().since], [true, 2], land);
  }
});

test("cli: a revert of a revert, a moved line, a byte order mark or CRLF changes no key; an edited record counts again; a mark with no covers covers only itself", () => {
  const r = trackedRepo();
  assert.deepEqual(audits([1, 2, 3, 4].map(r.cycle)), [1, 4]);
  assert.deepEqual([r.json().due, r.json().since], [false, 0]);
  const lines = readFileSync(r.log, "utf8").trim().split("\n");
  // The newest mark's line removed by a commit, and that commit reverted: the same line, the same key.
  writeFileSync(r.log, `${lines.slice(0, -1).join("\n")}\n`);
  r.close("chore: drop the mark");
  assert.deepEqual([r.json().due, r.json().since], [true, 2], "without the mark the two cycles count");
  git([...ID, "revert", "--no-edit", "HEAD"], { cwd: r.dir });
  assert.deepEqual([r.json().due, r.json().since], [false, 0], "the revert brings the same line back");
  // Moved lines, a byte order mark and CRLF: the same keys.
  writeFileSync(r.log, `\uFEFF${[lines[3], lines[1], lines[0], lines[2]].join("\r\n")}\r\n`);
  assert.deepEqual([r.json().due, r.json().since, r.json().cycles], [false, 0, 4]);
  // An old record edited: another key, a cycle no mark covers.
  const edited = { ...JSON.parse(lines[1]), always: JSON.parse(lines[1]).always + 1 };
  writeFileSync(r.log, `${[lines[0], JSON.stringify(edited), lines[2], lines[3]].join("\n")}\n`);
  assert.deepEqual([r.json().since, r.json().cycles], [1, 4]);
  // A mark with no covers (or with entries that are no key) covers only itself.
  const bare = JSON.stringify({ kind: "budget", date: "2026-10-25", commit: "c".repeat(40), always: 1, onDemand: 0, repeatedLines: 0, securityAudit: true, covers: ["not a key", 7] });
  writeFileSync(r.log, `${[lines[0], JSON.stringify(edited), lines[2], lines[3], bare].join("\n")}\n`);
  assert.deepEqual([r.json().since, r.json().marks], [1, 3]);
});

test("cli: a shallow clone, a graft or a replace ref changes nothing: the count reads the log alone", () => {
  const r = trackedRepo();
  assert.deepEqual(audits([1, 2, 3].map(r.cycle)), [1]);
  const full = r.json();
  assert.deepEqual([full.due, full.since], [true, 2]);
  const box = mkdtempSync(join(tmpdir(), "en-audit-shallow-"));
  git(["clone", "-q", "--depth", "1", `file://${r.dir}`, join(box, "c")], { cwd: box });
  const shallow = JSON.parse(spawnSync(process.execPath, [CLI, "audit", "--json"], { cwd: join(box, "c"), encoding: "utf8" }).stdout);
  assert.deepEqual([shallow.due, shallow.since], [true, 2], "shallow clone");
  const root = git(["rev-list", "--max-parents=0", "HEAD"], { cwd: r.dir });
  writeFileSync(join(r.dir, ".git", "info", "grafts"), `${git(["rev-parse", "HEAD"], { cwd: r.dir })} ${root}\n`);
  git(["replace", "--graft", "HEAD", root], { cwd: r.dir });
  assert.deepEqual([r.json().due, r.json().since], [true, 2], "a graft and a replace ref");
});

/** Runs the CLI with stdin a pipe left open, as an agent's shell may: a read of /dev/stdin would wait for ever. @param {string} cwd @param {string[]} args */
function runOpenStdin(cwd, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      done({ status, signal, stdout, stderr });
    });
  });
}

test("budget: recordBudget writes only a regular file reached through no link inside the repository, and a refusal writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-budget-link-"));
  const box = mkdtempSync(join(tmpdir(), "en-budget-out-"));
  const target = join(box, "config");
  writeFileSync(target, "kept\n");
  mkdirSync(join(dir, ".ennyn"));
  symlinkSync(target, join(dir, ".ennyn", "metrics.jsonl"));
  const record = () => recordBudget(dir, ".ennyn/metrics.jsonl", { always: 1, onDemand: 0, repeatedLines: 0 }, { date: "2026-10-25", commit: "a".repeat(40) });
  assert.throws(record, /metrics\.jsonl was not written: \.ennyn\/metrics\.jsonl is a symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "kept\n");
  rmSync(join(dir, ".ennyn"), { recursive: true });
  symlinkSync(box, join(dir, ".ennyn"));
  assert.throws(record, /was not written: \.ennyn is a symbolic link/);
  rmSync(join(dir, ".ennyn"));
  mkdirSync(join(dir, ".ennyn"));
  execFileSync("mkfifo", [join(dir, ".ennyn", "metrics.jsonl")]);
  assert.throws(record, /was not written: it is no regular file/);
  rmSync(join(dir, ".ennyn", "metrics.jsonl"));
  assert.equal(record().replaced, false, "a regular file, or none yet: written");
});

test("cli: a metrics log reached through a symbolic link inside the repository is neither read nor written", async () => {
  const { dir, run, json, log, commit } = auditRepo();
  run("budget", "--record", "--security-audit");
  const real = readFileSync(log, "utf8");
  const box = mkdtempSync(join(tmpdir(), "en-audit-out-"));
  // The log replaced by a link to a file outside (a user's config, say): nothing appended or rewritten there.
  const target = join(box, "outside-target.conf");
  writeFileSync(target, "[user]\n\tname = someone\n");
  rmSync(log);
  symlinkSync(target, log);
  commit("feat: next");
  for (const args of [["--record"], ["--record", "--security-audit"]]) {
    const r = run("budget", ...args);
    assert.equal(r.status, 1, args.join(" "));
    // budget reads the log before it writes: either refusal names the link, and nothing is written.
    assert.match(r.stderr, /metrics\.jsonl (could not be read|was not written): \.ennyn\/metrics\.jsonl is a symbolic link/);
    assert.equal(readFileSync(target, "utf8"), "[user]\n\tname = someone\n", args.join(" "));
  }
  // A link to a file outside that holds a mark: audit does not read it.
  writeFileSync(target, real);
  const a = run("audit");
  assert.equal(a.status, 1);
  assert.match(a.stdout, /Due: unmeasured: .*metrics\.jsonl could not be read: \.ennyn\/metrics\.jsonl is a symbolic link; taken as due\.$/m);
  assert.equal(json().due, null);
  // A directory of its path that links out: the same.
  rmSync(join(dir, ".ennyn"), { recursive: true });
  mkdirSync(join(box, "ennyn"));
  writeFileSync(join(box, "ennyn", "metrics.jsonl"), real);
  symlinkSync(join(box, "ennyn"), join(dir, ".ennyn"));
  assert.deepEqual([json().due, run("budget", "--record").status, readFileSync(join(box, "ennyn", "metrics.jsonl"), "utf8")], [null, 1, real]);
  assert.match(run("audit").stdout, /could not be read: \.ennyn is a symbolic link/);
  // doctor reads it the same way: unmeasured, not read through the link.
  assert.ok((await checkSetup({ cwd: dir, env: {} })).items.some((i) => i.key === "doctor.budgetLogUnmeasured" && /\.ennyn is a symbolic link/.test(String(i.vars.error))));
});

test("cli: a metrics log that is no regular file (a link to /dev/stdin or /dev/zero, a FIFO) holds no command", async () => {
  const { dir, run, log } = auditRepo();
  run("budget", "--record");
  for (const device of ["/dev/stdin", "/dev/zero"]) {
    rmSync(log, { force: true });
    symlinkSync(device, log);
    for (const args of [["audit"], ["budget", "--record"]]) {
      const r = await runOpenStdin(dir, args);
      assert.equal(r.signal, null, `${device} ${args.join(" ")}: it ended by itself`);
      assert.equal(r.status, 1, `${device} ${args.join(" ")}`);
    }
  }
  rmSync(log);
  execFileSync("mkfifo", [log]);
  const a = await runOpenStdin(dir, ["audit"]);
  assert.deepEqual([a.signal, a.status], [null, 1]);
  assert.match(a.stdout, /could not be read: it is no regular file; taken as due\.$/m);
  const b = await runOpenStdin(dir, ["budget", "--record"]);
  assert.deepEqual([b.signal, b.status, /(could not be read|was not written): it is no regular file/.test(b.stderr)], [null, 1, true]);
});

test("cli: a metrics log the config places outside the repository is the config's choice: recorded there every time, read as a regular file", (t) => {
  const box = mkdtempSync(join(tmpdir(), "en-audit-cfg-"));
  const outside = join(box, "m.jsonl");
  const { run, json, commit } = auditRepo({ ".ennyn/config.json": JSON.stringify({ paths: { metricsLog: outside } }) });
  assert.equal(run("budget", "--record", "--security-audit").status, 0);
  for (const n of [1, 2]) {
    commit(`feat: o${n}`);
    assert.equal(run("budget", "--record").status, 0);
  }
  assert.deepEqual([readFileSync(outside, "utf8").trim().split("\n").length, json().since], [3, 2]);
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  chmodSync(outside, 0o000);
  try {
    const unread = run("audit");
    assert.equal(unread.status, 1);
    assert.match(unread.stdout, /Due: unmeasured: .*m\.jsonl could not be read: EACCES.*; taken as due\.$/m);
    assert.equal(json().due, null);
    const mark = run("budget", "--record", "--security-audit");
    assert.deepEqual([mark.status, /could not be read/.test(mark.stderr)], [1, true]);
  } finally {
    chmodSync(outside, 0o644);
  }
});

test("cli: a re-record in the same cycle is silent; a mark replaced by a plain record says the coverage it held is dropped; any other replacement is said", () => {
  const { run, log, commit } = auditRepo();
  run("budget", "--record");
  commit("feat: a");
  run("budget", "--record");
  // Same commit, today, same mark state: step 6 recording again after the last edit.
  assert.doesNotMatch(run("budget", "--record").stdout, /record replaced|coverage/);
  // A plain record replacing this commit's mark: what the mark covered counts again, and it says so.
  commit("feat: b");
  run("budget", "--record");
  commit("feat: c");
  assert.equal(run("budget", "--record", "--security-audit").status, 0);
  const plain = run("budget", "--record");
  assert.match(plain.stdout, /^The record replaced was this commit's security-audit mark, covering 3 cycles: that coverage is dropped, and those cycles count again\.$/m);
  // A record from another day at this commit: maybe another cycle's (one that made no commit of its own).
  const lines = readFileSync(log, "utf8").trim().split("\n");
  writeFileSync(log, `${[...lines.slice(0, -1), JSON.stringify({ ...JSON.parse(lines.at(-1) ?? ""), date: "2026-01-01" })].join("\n")}\n`);
  assert.match(run("budget", "--record").stdout, /^The record replaced was made on 2026-01-01\. One record a commit: if it was another cycle's/m);
});

test("cli: audit names every file up to fifty a source, then every file's directory with its count; --json escapes every UTF-16 unit of a name's control, format and separator characters", () => {
  const sixty = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/${i < 30 ? "a" : "b"}/f${i}.js`, "x\n"]));
  const flows = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`.github/workflows/w${String(i).padStart(2, "0")}.yml`, "on: push\n"]));
  const names = { "src/a\u202eb\u2028c\u009bd\u200be\u007ff.js": "x\n", "src/t\u{e0041}g.js": "x\n" };
  const { run } = auditRepo({ ".ennyn/config.json": JSON.stringify({ review: { impactRequiredGlobs: ["src/**"] } }), ...sixty, ...names, ".claude/a\nb.json": "{}\n", ...flows });
  // Only the risky sources are summed up: the CI files keep every name past fifty.
  assert.match(run("audit").stdout, /^ {2}security\.ci\.paths: 51 files · (\.github\/workflows\/w\d\d\.yml, ){50}\.github\/workflows\/w50\.yml$/m);
  // A machine name with a line break stays on its directory's line, escaped, with its rule.
  assert.match(run("audit").stdout, /^ {4}\.claude\/ "a\\nb\.json \(\.claude\/\*\*\)"$/m);
  assert.match(run("audit").stdout, /^ {2}review\.impactRequiredGlobs: 62 files in 3 directories · src\/ \(2\), src\/a\/ \(30\), src\/b\/ \(30\)$/m);
  const out = run("audit", "--json").stdout;
  assert.doesNotMatch(out, /[\u007f-\u009f\u200b\u2028\u202e]|[\u{e0000}-\u{e007f}]/u);
  assert.match(out, /a\\u202eb\\u2028c\\u009bd\\u200be\\u007ff\.js/);
  assert.match(out, /t\\udb40\\udc41g\.js/);
  const files = JSON.parse(out).paths[0].files;
  for (const n of Object.keys(names)) assert.ok(files.includes(n), `${JSON.stringify(n)} parses back`);
});

