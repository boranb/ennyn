/**
 * What Claude Code does with a PreToolUse hook, recorded: the push hook (adapters/claude-code/hooks/push-spellings.mjs)
 * and any hook that refuses a tool call stand on this. Whether a deny holds in bypassPermissions, over an allow rule
 * and from a subagent; what a hook that fails or does not finish does to the call; which tools a matcher must name;
 * where a hook's message goes; what the ask rule reads and where it stops. No document promises the last two of these, and
 * a Claude Code update that moves one is seen here, by `npm run test:reference`.
 *
 * Each cell runs the machine's Claude Code in print mode, as test/reference/precompact.mjs does: a directory of its own,
 * a stand-in for the model on 127.0.0.1, no key of Anthropic's, the home, config and temporary directories the cell's.
 * A plugin holds the hook, loaded with --plugin-dir, one cell from a local marketplace as a user installs it; a stand-in
 * `git` first on PATH writes its arguments and sends nothing, and the cell's repository has no remote. A cell names one of
 * HOOKS, the commands come from this file only. A `real` cell loads this repository as the plugin, the push hook
 * among its hooks, in a project with an Ennyn config: `check` is the hook's real run, in bypassPermissions.
 *
 * A reading's `calls` says what became of each tool call: `ran`, `hook`, `rule` (Claude Code held it, in the rule's words or
 * in those of the check that said no first) or `invalid` (Claude Code refused it before any hook). `reached` is whether the
 * stand-in git was asked to push, or the stand-in npm to publish. The rule's length cells carry a command of exactly that many
 * characters: a compound with its push last, or `git push` and one long word. The rule reads a compound only if Claude Code's
 * parser finishes: the cells past that are here, two commits of ordinary words, nesting, short substitutions repeated and, with
 * the parser finished, a comment holding an apostrophe after a redirect, each with its control and no hook but a silent one,
 * so the fact stands on its own. Two `real` cells hold text the reader sees no push in: only Claude Code's own checks stop
 * those, in words of the moment, and an update that stops holding them shows here. `real` cells that set `push.mode`
 * have no rule: under `ask` the hook's own ask stops a plain push; under an approved `after-closing` a bare `git push` runs,
 * and a push naming its branch, a force, a delete and a mirror are asked, as a bare push is with no approval line or from
 * a shell an earlier call moved into another repository.
 *
 *   node test/reference/pretooluse.mjs check [--claude <bin>]    exit 1 when Claude Code reads a cell otherwise
 *   node test/reference/pretooluse.mjs record [--claude <bin>]   take every reading again
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeBinary, safePath, versionOf } from "./claude-bin.mjs";
import { gitEnv } from "./claude-code.mjs";
import { standIn } from "./precompact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const RECORD = join(HERE, "pretooluse.json");
const KEY = "sk-ant-stand-in-000000000000000000000000";
const MARK = "EN-PRETOOLUSE";
const SPELLED = "git -C . push";
const SHELL_TOOLS = "Bash|Monitor|PowerShell";
const ASK = { ask: ["Bash(git push *)"] };
const MONITOR = { description: "stand-in", timeout_ms: 2000, persistent: false };
/** A push at the end of a compound of `n` characters. @param {number} n */
const compound = (n) => `: ${"a".repeat(n - 26)} && git push origin main`;
/** `git push` and one word, `n` characters. @param {number} n */
const sole = (n) => `git push origin ${"a".repeat(n - 16)}`;
/** `echo` of substitutions `k` deep, then a push. @param {number} k */
const nested = (k) => `echo ${"$(".repeat(k)}true${")".repeat(k)}; git push origin main`;
const COMMIT = "git commit -q --allow-empty";
/** A body line that starts with the delimiter and holds `)` ends the parser, in ordinary words. */
const BODY = `${COMMIT} -F - <<'E'\nEnd of the first pass (see below)\nE\ngit push origin main`;
const BODY_IN_SUBSTITUTION = `${COMMIT} -m "$(cat <<'EOF'\nEOFs are (not) fine\nEOF\n)" && git push origin main`;
/** After a redirect a comment holding an apostrophe ends what the rule reads, and the parser finishes. @param {string} say */
const COMMENT = (say) => `git add . > /dev/null # ${say}\n${COMMIT} -qm x\ngit push origin main`;
/** Short substitutions, repeated: the parser's budget is spent over the whole text, not on depth. @param {number} k */
const REPEATED = (k) => `${"$( (:));".repeat(k)}\ngit push origin main`;
const PUBLISH = { ask: ["Bash(npm publish *)"] };
/** A config that has the cycle push by itself: no ask rule, and the hook leaves a plain push. */
const AFTER = JSON.stringify({ push: { mode: "after-closing" } });
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const decide = (/** @type {string} */ what) => `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${what}","permissionDecisionReason":"${MARK}"}}'`;
/** What a hook of a cell does after its input is kept. @type {Record<string, string>} */
const HOOKS = {
  silent: "exit 0",
  deny: decide("deny"),
  "exit-2": `echo ${MARK} >&2; exit 2`,
  "exit-1": `echo ${MARK} >&2; exit 1`,
  "deny-exit-1": `${decide("deny")}; exit 1`,
  killed: "kill -9 $$",
  hang: "sleep 30",
  "no-json": "echo not-json",
  "bad-decision": decide("nope"),
  say: `echo '{"systemMessage":"${MARK}"}'`,
};
/** A hook's command other than the script that runs HOOKS: one that crashes, and one that is not there. @type {Record<string, string>} */
const ENTRIES = { crash: 'node "${CLAUDE_PLUGIN_ROOT}/crash.mjs"', missing: 'node "${CLAUDE_PLUGIN_ROOT}/gone.mjs"' };

/**
 * @typedef {{ hook?: string, entry?: string, real?: true, noConfig?: true, config?: string, closing?: "approved" | "unapproved", command?: string, then?: string, tool?: string, input?: object, matcher?: string, rules?: object, localRules?: object, settings?: object, env?: Record<string, string>, timeout?: number, skipFlag?: true, install?: true, subagent?: true, keeps?: string[] }} Cell
 *   `then`: a second call, what an agent writes after a refusal; `keeps`: the input's fields, which the cell records;
 *   `localRules`: rules held only in .claude/settings.local.json; `config`: the Ennyn config's text in a `real` cell (`{}` else); `closing`: that config committed, with or without
 *   the approval line, and the branch given an upstream, as the closing's push needs
 */

/** @type {Record<string, Cell>} */
export const CELLS = {
  "a-silent-hook-lets-it-run": { hook: "silent", keeps: ["input"] },
  "deny-stops-the-call": { hook: "deny" },
  "deny-holds-over-an-allow-rule": { hook: "deny", rules: { allow: [`Bash(${SPELLED})`, `Bash(${SPELLED} *)`, "Bash(git *)"] } },
  "deny-holds-with-the-skip-flag": { hook: "deny", skipFlag: true },
  "deny-holds-from-an-installed-plugin": { hook: "deny", install: true },
  "deny-holds-in-a-subagent": { hook: "deny", subagent: true, keeps: ["agent"] },
  "a-subagent-runs-past-a-silent-hook": { hook: "silent", subagent: true, keeps: ["agent"] },
  "exit-2-stops-the-call": { hook: "exit-2" },
  "a-printed-deny-holds-over-exit-1": { hook: "deny-exit-1" },
  "exit-1-runs-the-call": { hook: "exit-1" },
  "a-crash-runs-the-call": { entry: "crash" },
  "a-missing-script-runs-the-call": { entry: "missing" },
  "a-killed-hook-runs-the-call": { hook: "killed" },
  "a-timeout-runs-the-call": { hook: "hang", timeout: 1 },
  "output-no-json-runs-the-call": { hook: "no-json" },
  "a-bad-decision-runs-the-call": { hook: "bad-decision" },
  "a-message-reaches-the-session-not-the-model": { hook: "say", command: "git status", keeps: ["said"] },
  "a-call-with-no-command-reaches-no-hook": { hook: "silent", input: { description: "stand-in" } },
  "the-settings-env-reaches-the-hook": { hook: "silent", command: "git status", settings: { env: { GIT_CONFIG_KEY_0: "alias.save", GIT_CONFIG_VALUE_0: "push" } }, keeps: ["env"] },
  "monitor-runs-past-a-bash-matcher": { hook: "silent", matcher: "Bash", tool: "Monitor", input: { ...MONITOR, command: SPELLED }, rules: ASK },
  "monitor-stopped-by-a-hook-that-names-it": { hook: "deny", tool: "Monitor", input: { ...MONITOR, command: SPELLED }, keeps: ["input"] },
  "monitor-asks-under-a-bash-rule": { hook: "silent", tool: "Monitor", input: { ...MONITOR, command: "git push" }, rules: ASK },
  "powershell-reaches-a-hook-that-names-it": { hook: "silent", tool: "PowerShell", env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, keeps: ["input"] },
  "the-hook-refuses-a-spelling": { real: true, rules: ASK },
  "the-hook-passes-a-plain-command": { real: true, command: "git status" },
  "the-hook-leaves-a-plain-push-to-the-rule": { real: true, command: "git push origin main", rules: ASK },
  "the-hook-leaves-a-push-in-a-compound": { real: true, command: "true && git push origin main", rules: ASK },
  "the-hook-leaves-a-commit-then-a-push-and-a-pipe": { real: true, command: `git add . && ${COMMIT} -qm x && git push origin main 2>&1 | tail -3`, rules: ASK, env: IDENTITY },
  "the-hook-leaves-the-folder-it-advises": { real: true, command: "cd . && git push origin main 2>&1 | tail -3", rules: ASK },
  "the-hook-leaves-the-folder-it-advises-in-a-subagent": { real: true, subagent: true, command: "cd . && git push origin main", rules: ASK },
  "the-rule-in-the-local-file-asks-the-same": { real: true, command: "cd . && git push origin main", localRules: ASK },
  "the-hook-refuses-what-the-rule-cannot-read": { real: true, command: BODY, rules: ASK, env: IDENTITY },
  "the-hook-refuses-a-compound-the-rule-cannot-read": { real: true, command: compound(10001), rules: ASK },
  "a-config-name-nothing-holds-does-not-switch-it-off": { real: true, rules: ASK, settings: { env: { ENNYN_CONFIG: "nope.json" } } },
  "the-hook-refuses-in-monitor": { real: true, tool: "Monitor", input: { ...MONITOR, command: SPELLED }, rules: ASK },
  "refused-then-written-plain-is-asked": { real: true, rules: ASK, then: "git push origin main" },
  "the-hook-ends-at-once-with-no-config": { real: true, noConfig: true },
  "the-rule-reads-a-compound-of-10000-characters": { hook: "silent", command: compound(10000), rules: ASK },
  "the-rule-does-not-read-a-compound-of-10001": { hook: "silent", command: compound(10001), rules: ASK },
  "the-rule-asks-about-a-sole-push-of-10001": { hook: "silent", command: sole(10001), rules: ASK },
  "the-rule-reads-a-commit-with-those-words-in-a-quoted-message": { hook: "silent", command: `${COMMIT} -m "End of the first pass (see below)" && git push origin main`, rules: ASK, env: IDENTITY },
  "the-rule-does-not-read-past-a-commit-body": { hook: "silent", command: BODY, rules: ASK, env: IDENTITY },
  "the-rule-does-not-read-past-a-body-in-a-substitution": { hook: "silent", command: BODY_IN_SUBSTITUTION, rules: ASK, env: IDENTITY },
  "the-rule-reads-past-13-substitutions": { hook: "silent", command: nested(13), rules: ASK },
  "the-rule-does-not-read-past-14-substitutions": { hook: "silent", command: nested(14), rules: ASK },
  "a-push-first-is-read-past-14-substitutions": { hook: "silent", command: `git push origin main; ${nested(14)}`, rules: ASK },
  "the-rule-does-not-read-past-a-comment-after-a-redirect": { hook: "silent", command: COMMENT("don't show it"), rules: ASK, env: IDENTITY },
  "the-rule-reads-past-that-comment-with-no-apostrophe": { hook: "silent", command: COMMENT("do not show it"), rules: ASK, env: IDENTITY },
  "the-rule-does-not-read-past-repeated-substitutions": { hook: "silent", command: REPEATED(12), rules: ASK },
  "the-rule-reads-past-three-repeated-substitutions": { hook: "silent", command: REPEATED(3), rules: ASK },
  "the-publish-rule-does-not-read-past-that-comment": { hook: "silent", command: "npm test > out.log 2>&1 # it's slow\nnpm publish", rules: PUBLISH },
  "the-publish-rule-reads-past-a-comment-with-no-apostrophe": { hook: "silent", command: "npm test > out.log 2>&1 # slow\nnpm publish", rules: PUBLISH },
  "the-hook-refuses-a-push-after-a-comment": { real: true, command: COMMENT("don't show it"), rules: ASK, env: IDENTITY },
  "the-hook-refuses-a-push-after-repeated-substitutions": { real: true, command: REPEATED(12), rules: ASK },
  "the-hook-leaves-lines-of-plain-words-to-the-rule": { real: true, command: "git fetch origin\ngit push origin main > out 2>&1", rules: ASK },
  "the-hook-leaves-a-compound-of-8999-characters-to-the-rule": { real: true, command: compound(8999), rules: ASK },
  "claude-code-holds-a-brace-zsh-counts": { real: true, command: "echo ${x:-{}; # }; git push origin main", rules: ASK },
  "claude-code-holds-a-numeric-glob-before-a-hash": { real: true, command: "echo <1-2># | git push origin main", rules: ASK },
  "push-mode-ask-the-hook-asks-a-plain-push-with-no-rule": { real: true, command: "git push origin main" },
  "push-mode-after-closing-a-bare-push-runs-with-no-rule": { real: true, command: "git push", config: AFTER, closing: "approved" },
  "push-mode-after-closing-asks-a-push-that-names-its-branch": { real: true, command: "git push origin main", config: AFTER, closing: "approved" },
  "push-mode-after-closing-asks-a-force-push": { real: true, command: "git push --force origin main", config: AFTER, closing: "approved" },
  "push-mode-after-closing-asks-a-delete": { real: true, command: "git push origin :main", config: AFTER, closing: "approved" },
  "push-mode-after-closing-asks-a-mirror": { real: true, command: "git push --mirror", config: AFTER, closing: "approved" },
  "push-mode-after-closing-unapproved-asks-a-bare-push": { real: true, command: "git push", config: AFTER, closing: "unapproved" },
  "push-mode-after-closing-asks-a-bare-push-after-cd-into-another-repository": { real: true, command: "git init -q nested && cd nested", then: "git push", config: AFTER, closing: "approved" },
  "push-mode-after-closing-the-hook-still-refuses-a-spelling": { real: true, config: AFTER },
};

const text = (/** @type {string} */ t) => [{ type: "text", text: t }];
const toolCall = (/** @type {number} */ n, /** @type {string} */ name, /** @type {object} */ input) => [{ type: "tool_use", id: `toolu_call_${n}`, name, input }];

/** The cell's tool calls, in order. @param {Cell} c @returns {[string, object][]} */
function callsOf(c) {
  const name = c.tool ?? "Bash";
  const first = c.input ?? { command: c.command ?? SPELLED, description: "stand-in" };
  return c.then ? [[name, first], [name, { command: c.then, description: "stand-in" }]] : [[name, first]];
}

/** @param {number | undefined} pid */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/** What became of a call, from the result the model is given. @param {unknown} content */
function outcome(content) {
  const t = JSON.stringify(content ?? "");
  if (t.includes(MARK) || t.includes("ennyn: ")) return "hook";
  if (/requested permissions|requires? approval|Approve only if|can't be checked before it runs|could not be checked|numeric-range glob|Redirect has multiple targets|Permission to use \w+ has been denied/.test(t)) return "rule";
  return /InputValidationError/.test(t) ? "invalid" : "ran";
}

/**
 * What Claude Code did in one cell.
 * @param {Cell} c @param {string} bin
 */
export async function reading(c, bin) {
  const R = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-pt-")));
  try {
    const P = join(R, "p");
    const OUT = join(R, "out");
    const PLUGIN = join(R, "market", "plug");
    for (const d of ["p/.claude", "cfg", "home", "run", "tmp", "out", "hooks", "bin", "market/.claude-plugin", "market/plug/.claude-plugin", "market/plug/hooks"]) mkdirSync(join(R, d), { recursive: true });
    const { env: git, args: quiet } = gitEnv(R);
    execFileSync("git", [...quiet, "init", "-q"], { cwd: P, env: git });
    execFileSync("git", [...quiet, "commit", "-qm", "cell", "--allow-empty", "--no-verify"], { cwd: P, env: git });
    const real = execFileSync("sh", ["-c", "command -v git"], { env: { PATH: safePath() }, encoding: "utf8" }).trim();
    writeFileSync(join(R, "bin", "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${join(OUT, "argv")}\nfor a in "$@"; do [ "$a" = push ] && exit 0; done\nexec ${real} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(R, "bin", "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${join(OUT, "argv")}\n`, { mode: 0o755 });
    writeFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug", version: "1.0.0", description: "stand-in" }));
    writeFileSync(join(R, "market", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mk", owner: { name: "x" }, plugins: [{ name: "plug", source: "./plug", description: "stand-in", version: "1.0.0" }] }));
    // The hook keeps its input and its environment, then does what the cell says.
    writeFileSync(join(PLUGIN, "hook.sh"), `n=$$; cat > "${OUT}/stdin.$n"; env > "${OUT}/env.$n"\n${HOOKS[c.hook ?? "silent"]}\n`);
    writeFileSync(join(PLUGIN, "crash.mjs"), "throw new Error('stand-in crash');\n");
    const command = c.entry ? ENTRIES[c.entry] : 'sh "${CLAUDE_PLUGIN_ROOT}/hook.sh"';
    writeFileSync(join(PLUGIN, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: c.matcher ?? SHELL_TOOLS, hooks: [{ type: "command", command, ...(c.timeout ? { timeout: c.timeout } : {}) }] }] } }));
    if (c.real && !c.noConfig) {
      mkdirSync(join(P, ".ennyn"));
      writeFileSync(join(P, ".ennyn", "config.json"), c.config ?? "{}\n");
      if (c.closing) {
        const at = { cwd: P, env: { ...git, ...IDENTITY } };
        execFileSync("git", [...quiet, "add", ".ennyn/config.json"], at);
        execFileSync("git", [...quiet, "commit", "-qm", `chore: mode${c.closing === "approved" ? "\n\nUser-Approved-Loosening: push.mode" : ""}`, "--no-verify"], at);
        const branch = execFileSync("git", [...quiet, "symbolic-ref", "--short", "HEAD"], { ...at, encoding: "utf8" }).trim();
        for (const [k, v] of [["remote.origin.url", join(R, "remote.git")], [`branch.${branch}.remote`, "origin"], [`branch.${branch}.merge`, `refs/heads/${branch}`]]) execFileSync("git", [...quiet, "config", k, v], at);
      }
    }
    writeFileSync(join(P, ".claude", "settings.json"), JSON.stringify({ ...(c.rules ? { permissions: c.rules } : {}), ...c.settings }));
    if (c.localRules) writeFileSync(join(P, ".claude", "settings.local.json"), JSON.stringify({ permissions: c.localRules }));
    writeFileSync(join(R, "cfg", ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true }));
    const calls = callsOf(c);
    /** @type {string[]} */
    const seen = [];
    const server = await standIn(({ json, reply }) => {
      const all = JSON.stringify(json.messages ?? []);
      seen.push(JSON.stringify(json));
      const next = calls.findIndex((_, n) => !all.includes(`toolu_call_${n}`));
      const mine = !c.subagent || JSON.stringify(json.messages?.[0] ?? "").includes("stand-in-subagent");
      if (!mine) return all.includes("toolu_agent") ? reply(text("done"), 10) : reply([{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "x", prompt: "stand-in-subagent", subagent_type: "general-purpose" } }], 10, "tool_use");
      return next < 0 ? reply(text("done"), 10) : reply(toolCall(next, calls[next][0], calls[next][1]), 10, "tool_use");
    });
    const env = {
      PATH: `${join(R, "bin")}:${safePath()}`,
      HOME: join(R, "home"),
      TMPDIR: join(R, "tmp"),
      CLAUDE_CODE_TMPDIR: join(R, "tmp"),
      CLAUDE_CONFIG_DIR: join(R, "cfg"),
      XDG_RUNTIME_DIR: join(R, "run"),
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      ...c.env,
    };
    if (c.install) {
      const quietly = { cwd: P, env, stdio: "ignore", timeout: 60_000 };
      execFileSync(bin, ["plugin", "marketplace", "add", join(R, "market")], /** @type {any} */ (quietly));
      execFileSync(bin, ["plugin", "install", "plug@mk", "--scope", "user"], /** @type {any} */ (quietly));
    }
    const plugin = c.install ? [] : ["--plugin-dir", c.real ? ROOT : PLUGIN];
    const mode = c.skipFlag ? ["--dangerously-skip-permissions"] : ["--permission-mode", "bypassPermissions"];
    const args = ["-p", "--model", "claude-opus-5-5", ...mode, ...plugin, "--output-format", "stream-json", "--verbose", "stand-in"];
    /** @type {{ out: string, code: number | null, timedOut: boolean }} */
    const run = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: P, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => ((timedOut = true), killGroup(child.pid)), 90_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", () => {});
      child.on("close", (code) => (clearTimeout(timer), killGroup(child.pid), resolve({ out, code, timedOut })));
    });
    server.close();
    const events = run.out.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const results = events.flatMap((e) => (e.type === "user" && Array.isArray(e.message?.content) ? e.message.content : [])).filter((x) => x.type === "tool_result" && String(x.tool_use_id).startsWith("toolu_call_"));
    const kept = readdirSync(OUT);
    const inputs = kept.filter((f) => f.startsWith("stdin.")).map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")));
    const argv = kept.includes("argv") ? readFileSync(join(OUT, "argv"), "utf8") : "";
    /** @type {Record<string, unknown>} */
    const out = {
      ended: run.timedOut ? "unmeasured: the run did not end" : events.find((e) => e.type === "result")?.subtype ?? `no result (exit ${run.code})`,
      calls: [...new Set(results.map((r) => r.tool_use_id))].sort().map((id) => outcome(results.find((r) => r.tool_use_id === id).content)),
      reached: /(^|\s)(push|publish)(\s|$)/m.test(argv),
      hookRuns: c.real ? null : inputs.length,
    };
    for (const k of c.keeps ?? []) {
      if (k === "input") Object.assign(out, { tool: inputs[0]?.tool_name, input: Object.keys(inputs[0] ?? {}).sort(), toolInput: Object.keys(inputs[0]?.tool_input ?? {}).sort() });
      if (k === "agent") Object.assign(out, { agentId: typeof inputs[0]?.agent_id, mode: inputs[0]?.permission_mode });
      if (k === "env") out.envSeen = kept.filter((f) => f.startsWith("env.")).some((f) => readFileSync(join(OUT, f), "utf8").includes("GIT_CONFIG_KEY_0=alias.save"));
      if (k === "said") {
        const line = events.find((e) => JSON.stringify(e).includes(MARK));
        Object.assign(out, { stream: line ? { type: line.type, subtype: line.subtype, content: line.content, level: line.level } : null, model: seen.some((s) => s.includes(MARK)) });
      }
    }
    return out;
  } finally {
    rmSync(R, { recursive: true, force: true });
  }
}

/** @returns {{ claudeCode: string, cells: Record<string, any> }} */
export const readRecord = () => JSON.parse(readFileSync(RECORD, "utf8"));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude");
  const [cmd] = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const found = claudeBinary(at === -1 ? "claude" : argv[at + 1]);
  if (!found || (cmd !== "check" && cmd !== "record")) {
    process.stderr.write(found ? "usage: node test/reference/pretooluse.mjs check | record [--claude <bin>]\n" : "no claude binary found: point at one with --claude <path>\n");
    process.exit(found ? 2 : 1);
  }
  const version = versionOf(found.path);
  const rec = existsSync(RECORD) ? readRecord() : { claudeCode: "", cells: {} };
  if (cmd === "check" && version !== rec.claudeCode) {
    process.stdout.write(`the record is Claude Code ${rec.claudeCode}, ${found.path} is ${version}: take it again with node test/reference/pretooluse.mjs record --claude <path>\n`);
    process.exit(1);
  }
  /** @type {Record<string, any>} */
  const cells = {};
  for (const [id, c] of Object.entries(CELLS)) cells[id] = await reading(c, found.path);
  const moved = Object.keys(cells).filter((id) => JSON.stringify(cells[id]) !== JSON.stringify(rec.cells[id]));
  if (cmd === "record") {
    writeFileSync(RECORD, `${JSON.stringify({ claudeCode: version, cells }, null, 2)}\n`);
    process.stdout.write(`recorded ${Object.keys(cells).length} cell(s) with Claude Code ${version}; ${moved.length} reading(s) moved: ${moved.join(", ") || "none"}\n`);
  } else {
    for (const id of moved) process.stdout.write(`${id}: Claude Code now reads ${JSON.stringify(cells[id])}\n  recorded ${JSON.stringify(rec.cells[id])}\n`);
    if (!moved.length) process.stdout.write(`Claude Code ${version} treats all ${Object.keys(cells).length} PreToolUse cell(s) as recorded\n`);
  }
  process.exitCode = cmd === "check" && moved.length ? 1 : 0;
}
