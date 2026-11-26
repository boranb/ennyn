import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError, CONVERSATION_STYLES } from "../plugin/core/config.mjs";
import { styleRules } from "../plugin/core/style.mjs";
import { t } from "../plugin/core/i18n.mjs";
import { checkCommitShape } from "../plugin/checks/commit-shape.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "plugin", "adapters", "claude-code", "hooks", "conversation-style.mjs");
const cfg = (/** @type {Record<string, unknown>} */ override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-st-")), env: {}, override });

test("config: conversation.style and commitMsg.style take only their listed values", () => {
  assert.equal(cfg().conversation.style, "normal");
  assert.equal(cfg().commitMsg.style, "normal");
  for (const style of CONVERSATION_STYLES) assert.equal(cfg({ conversation: { style } }).conversation.style, style);
  assert.throws(() => cfg({ conversation: { style: "caveman-ultra" } }), (e) => e instanceof ConfigError && /"conversation\.style" must be "normal", "focused", "terse"/.test(e.message));
  assert.throws(() => cfg({ commitMsg: { style: "focused" } }), (e) => e instanceof ConfigError && /"commitMsg\.style" must be "normal" or "terse"/.test(e.message));
});

test("styles: every style but normal has rules in both languages, each keeping the never-shorten list and the conversation-only scope", () => {
  assert.equal(styleRules("normal", "tr"), null);
  const files = readdirSync(join(ROOT, "plugin", "styles")).sort();
  const expected = CONVERSATION_STYLES.filter((s) => s !== "normal").flatMap((s) => [`${s}.en.md`, `${s}.tr.md`]).sort();
  assert.deepEqual(files, expected, "no style without both languages, no stray file");
  for (const style of CONVERSATION_STYLES.filter((s) => s !== "normal")) {
    const en = /** @type {string} */ (styleRules(style, "en"));
    const tr = /** @type {string} */ (styleRules(style, "tr"));
    for (const must of ["Never shorten:", "numbers and units", "negations", "data loss", "money", "decide", "conversation only", "commits"]) assert.ok(en.includes(must), `${style}.en: ${must}`);
    for (const must of ["Asla kısaltma:", "sayılar ve birimler", "olumsuzluk", "veri kaybı", "para", "karar", "yalnız konuşma", "commit'ler"]) assert.ok(tr.includes(must), `${style}.tr: ${must}`);
  }
  // Turkish terse must not tell the model to trim suffixes: negation lives in one (sil / silme).
  assert.match(/** @type {string} */ (styleRules("terse", "tr")), /Ekleri kırpma: olumsuzluk/);
});

test("commit style terse: no prose in the body; structured lines, trailers, Merge and the allow marker pass", () => {
  const c = cfg({ commitMsg: { style: "terse" } });
  const ok = ["fix: empty list kept the old total", "", "Review-Rounds: 1", "Mutation: first 4/5 · last 5/5", "", "Signed-off-by: a <a@a>"].join("\n");
  assert.deepEqual(checkCommitShape(ok, { config: c }).errors, []);
  assert.deepEqual(checkCommitShape("fix: one line only", { config: c }).errors, []);
  const prose = checkCommitShape("fix: x\n\nThe list kept the old total because…\nReview-Rounds: 1", { config: c });
  assert.equal(prose.ok, false);
  assert.match(prose.errors.join(), /terse.*1 prose lines/);
  assert.ok(checkCommitShape("fix: x\n\nprose [commit-shape-allow: imported from upstream]", { config: c }).ok);
  // normal keeps the line limit, not zero.
  assert.ok(checkCommitShape("fix: x\n\nThe list kept the old total.", { config: cfg() }).ok);
});

/** @param {Record<string, unknown> | null} config @param {string} [stdin] */
function runHook(config, stdin = JSON.stringify({ session_id: "s", source: "startup", hook_event_name: "SessionStart" })) {
  const project = mkdtempSync(join(tmpdir(), "en-hook-"));
  if (config) {
    mkdirSync(join(project, ".ennyn"));
    writeFileSync(join(project, ".ennyn", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return spawnSync(process.execPath, [HOOK], { input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: project }, encoding: "utf8" });
}

test("hook: injects the style in the config language; nothing for normal or no config; a broken one is said; exit 0 always", () => {
  const tr = runHook({ language: "tr", conversation: { style: "terse" } });
  assert.equal(tr.status, 0);
  const out = JSON.parse(tr.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /^Konuşma üslubu: kısa/);
  const en = JSON.parse(runHook({ conversation: { style: "focused" } }).stdout);
  assert.match(en.hookSpecificOutput.additionalContext, /^Conversation style: focused/);
  for (const config of [{ conversation: { style: "normal" } }, null]) {
    const r = runHook(config);
    assert.deepEqual([r.status, r.stdout], [0, ""], JSON.stringify(config));
  }
  // A config that does not load: the session runs without its style, and the user is told.
  // A key holding a terminal control sequence reaches the message escaped: the config is the project's text.
  for (const config of [/** @type {any} */ ("{ broken"), { conversation: { style: "loud" } }, { "\u001b]0;owned\u0007": 1 }, /** @type {any} */ ("\u001b[2J")]) {
    const r = runHook(config);
    assert.equal(r.status, 0);
    const said = JSON.parse(r.stdout).systemMessage;
    assert.match(said, /^ennyn: the config does not load, so the conversation style could not be applied \(/, JSON.stringify(config));
    assert.doesNotMatch(said, /[\u0000-\u001f\u2028]/, JSON.stringify(said));
  }
  // Malformed input: the project still comes from CLAUDE_PROJECT_DIR.
  const bad = runHook({ conversation: { style: "terse" } }, "not json");
  assert.equal(bad.status, 0);
  assert.match(JSON.parse(bad.stdout).hookSpecificOutput.additionalContext, /^Conversation style: terse/);
});

test("hook: after a compaction, the re-read line in the config language, after the style; no other source; `compaction.defer: false` turns it off", () => {
  // The input Claude Code 2.1.310 sent at a compaction against a stand-in model, the main thread's and a subagent's
  // alike: the main thread's session, transcript and folder, so the line can name no file of a task's worktree.
  const input = (/** @type {unknown} */ source) => JSON.stringify({ session_id: "s", transcript_path: "/p/s.jsonl", cwd: "/p", prompt_id: "q", hook_event_name: "SessionStart", source, model: "claude-opus-5-5" });
  /** @param {any} config @param {unknown} source */
  const context = (config, source) => {
    const r = runHook(config, input(source));
    assert.equal(r.status, 0);
    return r.stdout === "" ? null : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const [en, tr, terse] = [t("compact.reread", {}, "en"), t("compact.reread", {}, "tr"), /** @type {string} */ (styleRules("terse", "en"))];
  assert.equal(context({}, "compact"), en);
  assert.equal(context({ language: "tr" }, "compact"), tr);
  assert.equal(context({ conversation: { style: "terse" } }, "compact"), `${terse.trimEnd()}\n\n${en}`);
  for (const source of ["startup", "resume", "clear", undefined, "Compact"]) {
    assert.equal(context({}, source), null, String(source));
    assert.equal(context({ conversation: { style: "terse" } }, source), terse, String(source));
  }
  // The compaction switch: the style alone.
  assert.equal(context({ compaction: { defer: false } }, "compact"), null);
  assert.equal(context({ compaction: { defer: false }, conversation: { style: "terse" } }, "compact"), terse);
  // No config: nothing. A config that does not load: no language and no switch, so the system message alone.
  assert.deepEqual([runHook(null, input("compact")).status, runHook(null, input("compact")).stdout], [0, ""]);
  const broken = runHook(/** @type {any} */ ("{ broken"), input("compact"));
  assert.deepEqual(Object.keys(JSON.parse(broken.stdout)), ["systemMessage"]);
  // One line each, no file name: where to look, by command, and the impact table. The diff runs from the merge base
  // with the branch the task lands on, which a rebase onto it keeps right (a start commit goes stale at the first
  // rebase and then lists other tasks' files), and the status lists each untracked file, whatever
  // `status.showUntrackedFiles` says.
  for (const line of [en, tr]) {
    assert.doesNotMatch(line, /[\n\r]/);
    assert.match(line, /`git diff --name-only --merge-base <[^>]+>` \([^)]+\) .* `git status --short --untracked-files=all`/);
    assert.doesNotMatch(line, /<start>|start commit|başlangıç commit/);
  }
  assert.match(en, /impact table/);
  assert.match(en, /`git diff --name-only --merge-base <base branch>` \(the branch it rebases onto and lands on\)/);
  assert.match(tr, /etki tablosu/);
  assert.match(tr, /`git diff --name-only --merge-base <taban dal>` \(görevin üzerine rebase edildiği ve indiği dal\)/);
});

test("brief: a task agent re-reads its changed files and impact table after a compaction, by the commands the hook's line names", () => {
  // The rule stands in the brief too, for an agent whose hook is off or was never installed.
  const brief = readFileSync(join(ROOT, "plugin", "skills", "cycle", "task-brief.md"), "utf8");
  assert.match(brief, /After a compaction, before its next edit, it re-reads the files the task changed \(`git diff --name-only --merge-base <base branch>` and `git status --short --untracked-files=all`, in its worktree\) and its impact table/);
  // The brief names that branch, the first brief and the one a restart gets; no start commit, which a rebase leaves behind.
  assert.match(brief, /\| \*\*Place\*\* \| worktree, branch, the base branch \(the branch it rebases onto and lands on\), /);
  assert.match(brief, /\| \*\*Place\*\* \| worktree, new branch, the base branch, /);
  assert.doesNotMatch(brief, /start commit/);
  for (const lang of ["en", "tr"]) for (const command of ["git diff --name-only --merge-base <", "git status --short --untracked-files=all"]) assert.ok(t("compact.reread", {}, lang).includes(command), `${lang}: ${command}`);
});

test("docs: the re-read line's limits are said as they are: the summary names files changed since the last commit, and the session-start list stays one list", () => {
  // Where the hook's folder is the agent's own, the PreCompact request names what git shows changed since the last
  // commit: not a task's files committed before it.
  for (const path of ["docs/modules.md", "CHANGELOG.md", "plugin/adapters/claude-code/hooks/conversation-style.mjs"]) {
    const text = readFileSync(join(ROOT, path), "utf8").replace(/\n \* /g, " ");
    assert.match(text, /already lists the files changed since the last commit/, path);
    assert.doesNotMatch(text, /already lists its changed files/, path);
  }
  // SECURITY.md's hooks line: what runs at session start is one list, up to the env file, with no sentence inside it.
  const security = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
  assert.match(security, /at session start, (?:(?!\. )[^;])*the version the session runs is recorded(?:(?!\. )[^;])*\(`\$CLAUDE_ENV_FILE`\)/);
  assert.match(security, /\(`\$CLAUDE_ENV_FILE`\)[.;] [^\n]*`git status` and `git diff` in its worktree/);
});
