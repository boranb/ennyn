#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (matcher `Bash|Monitor|PowerShell`, the tools that run a command): refuses every push but
 * a plain `git push` the ask rule reads for certain, in every permission mode, and says how to write it. That plain push
 * it asks about (`ask`), so the user is asked with no rule too, unless it is a bare `git push` and the config's
 * `push.mode` lets the cycle push by itself on the verdict push-check gives (../../../checks/push-mode.mjs). In a
 * subagent (the input's `agent_id`) it refuses that push too, never asks, and gives the fetch form a lab's upstream takes.
 * ../push-spellings.mjs is the reader and has the shape and the limits. This stops a push written another way by habit.
 * It is no boundary: a program set on pushing gets through, and test/reference/pretooluse.json records that a hook that
 * crashes or times out lets the call run.
 *
 * Every Bash call pays for this, so the order is by cost. No config at its place (../config-place.mjs): the hook ends,
 * printing and writing nothing. The reader, on the command's text: most calls end here. It asks git nothing and does not
 * load the project, on a refusal too: a git answer is the repository's to move or stall, and a config that does not load
 * is a project that asked for Ennyn. Only a plain push it leaves loads the config and asks git, for push-check's
 * verdict. A config at .ennyn/config.json or at ENNYN_CONFIG's path: either one means Ennyn's project, so a settings
 * `env` that names a file nothing holds does not switch this off. It reads text, runs none of it, and makes no network
 * call.
 *
 * Exit 0 on every path, the refusal included: it is the printed deny that stops a call, and a printed deny stops it
 * over any exit code. Input it cannot read leaves the call and says so (systemMessage): the crash it would otherwise be
 * runs the call too, a deny would stall every shell command of every project after one Claude Code update, and the ask
 * rule still stands. Claude Code itself refuses a shell call with no command, before any hook, so this is a change of
 * shape, not a bad call; a Monitor on a socket holds no command and runs none, and passes. The message reaches the
 * person (the session's stream, the terminal), not the model.
 */

import { hookProjectDir, mayHold } from "../config-place.mjs";
import { pushReading } from "../push-spellings.mjs";

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** The refusal when its catalog cannot be read: a broken file of the plugin must not turn a refusal into a pass. */
const PLAIN_REFUSAL = "ennyn: this push is refused: write it in a call of its own, git push <remote> <branch>, with the commit in the call before.";
/** The ask when its catalog cannot be read. */
const PLAIN_ASK = "ennyn: this push waits for the user's yes.";
/** The refusal in a subagent when its catalog cannot be read. */
const PLAIN_SUBAGENT = "ennyn: a subagent does not push: this push is refused. Leave it to the main thread.";

/** A call made in a subagent: Claude Code's input names it with `agent_id`, absent on the main thread. @param {any} input */
const inSubagent = (input) => input?.agent_id !== undefined && input?.agent_id !== null && input?.agent_id !== "";

/** The decision's whole run, git calls included, well inside the hook's 10 s: a hook that times out lets the call run. */
const DECIDE_MS = 5000;

/**
 * Why a plain push it leaves waits for the user, or null to let it run: only a bare `git push`, when the one verdict
 * `ennyn push-check` gives (../../../checks/push-mode.mjs, hookVerdict) lets the cycle push by itself: the mode, the
 * commits rule on what the push sends, and a green run of what it needs recorded on HEAD's tree with nothing
 * uncommitted. Taken where the shell stands (the input's `cwd`, which an earlier `cd` moved) and in the checkout of the
 * project the config was found in, without push-check's fetch (no hook makes a network call; a lazy fetch is off too):
 * behind and ahead are read against the last fetch. That asks git, so it runs in a child stopped at DECIDE_MS;
 * anything that fails, does not finish or prints what it cannot read asks.
 * @param {string} project the session's folder @param {unknown} shell the input's cwd @param {string} command
 * @returns {Promise<string | null>}
 */
async function waits(project, shell, command) {
  try {
    const { spawnSync } = await import("node:child_process");
    const module = new URL("../../../checks/push-mode.mjs", import.meta.url).href;
    if (typeof shell !== "string" || shell === "") return await text("pushSpellings.ask", { why: await text("push.modeElsewhere", { cwd: "?" }) });
    const bare = /^[ \t\n]*git push[ \t\n]*$/.test(command);
    const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { hookVerdict } = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(hookVerdict(process.cwd(), process.env, { project: ${JSON.stringify(project)}, bare: ${bare} })));`], { cwd: shell, encoding: "utf8", timeout: DECIDE_MS, killSignal: "SIGKILL", env });
    if (run.status !== 0) return PLAIN_ASK;
    /** @type {{ ok: unknown, lines: unknown }} */
    const push = JSON.parse(run.stdout);
    if (!Array.isArray(push.lines) || !push.lines.every((l) => typeof l === "string")) return PLAIN_ASK;
    if (push.ok === true && bare) return null;
    const why = push.ok === true ? [await text("pushSpellings.notBare")] : push.lines;
    return await text("pushSpellings.ask", { why: why.join(" ") });
  } catch {
    return PLAIN_ASK;
  }
}

/** @param {string} key @param {Record<string, string>} [vars] */
async function text(key, vars) {
  const { t } = await import("../../../core/i18n.mjs");
  return t(key, vars, "en");
}

async function main() {
  const raw = await readStdin();
  /** @type {any} */
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    // Said below, in a project with a config.
  }
  const projectDir = hookProjectDir(input);
  let possible = true;
  try {
    possible = [".ennyn/config.json", process.env.ENNYN_CONFIG].some((place) => place && mayHold(projectDir, place, true));
  } catch {
    // A place that cannot be looked at may hold one.
  }
  if (!possible) return;
  const command = input?.tool_input?.command;
  if (input?.tool_name === "Monitor" && input?.tool_input?.ws !== undefined && command === undefined) return;
  /** @type {string | null} */
  let refused = null;
  let left = false;
  let read = typeof command === "string";
  if (read) {
    try {
      ({ refused, left } = pushReading(command, process.env));
    } catch {
      read = false;
    }
  }
  if (read && refused === null) {
    // A push left in a subagent is refused, never asked: Claude Code 2.1.330 routes a subagent's ask to the session's
    // prompt, where it waits with nobody there. Claude Code names a subagent with agent_id, absent on the main thread,
    // where the closing's push runs.
    if (left && inSubagent(input)) {
      const reason = await text("pushSpellings.subagent").catch(() => PLAIN_SUBAGENT);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
      return;
    }
    const ask = left ? await waits(projectDir, input?.cwd, /** @type {string} */ (command)) : null;
    if (ask === null) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: ask } }));
    return;
  }
  if (!read) {
    process.stdout.write(JSON.stringify({ systemMessage: await text("pushSpellings.unread") }));
    return;
  }
  // Cut: what the refusal names may be long. t escapes what a line cannot hold.
  const reason = await text("pushSpellings.refused", { command: /** @type {string} */ (refused).slice(0, 200) }).catch(() => PLAIN_REFUSAL);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

// Claude Code stopped reading: end without a stack trace, as a process ended by SIGPIPE.
process.stdout.on("error", (e) => {
  if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPIPE") process.exit(141);
  throw e;
});

main().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 0;
  },
);
