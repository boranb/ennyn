import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { ruleKey, instructionBudget, readBudgets, recordBudget, previousBudget } from "../setup/budget.mjs";
import { importsOf } from "../setup/scan.mjs";
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
  assert.deepEqual(readBudgets(join(dir, "none.jsonl")), { records: [], skipped: 0 }, "no log is still no records");
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
  assert.deepEqual(readBudgets(join(dir, "missing.jsonl")), { records: [], skipped: 0 });
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
