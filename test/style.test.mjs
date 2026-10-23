import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError, CONVERSATION_STYLES } from "../core/config.mjs";
import { styleRules } from "../core/style.mjs";
import { checkCommitShape } from "../checks/commit-shape.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "adapters", "claude-code", "hooks", "conversation-style.mjs");
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
  const files = readdirSync(join(ROOT, "styles")).sort();
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
  for (const config of [/** @type {any} */ ("{ broken"), { conversation: { style: "loud" } }]) {
    const r = runHook(config);
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /^ennyn: the config does not load, so the conversation style could not be applied \(/, JSON.stringify(config));
  }
  // Malformed input: the project still comes from CLAUDE_PROJECT_DIR.
  const bad = runHook({ conversation: { style: "terse" } }, "not json");
  assert.equal(bad.status, 0);
  assert.match(JSON.parse(bad.stdout).hookSpecificOutput.additionalContext, /^Conversation style: terse/);
});
