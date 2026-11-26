#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (matcher `Bash|Monitor|PowerShell`, beside the push hook): refuses a kill chosen by a
 * filter, a name, a window title, a port or a PID looked up at run time, in every permission mode, and says to stop
 * only a process the agent started, by its PID or process group. ../kill-targets.mjs is the reader and has the shape
 * and the limits. It is no boundary: a script the agent writes and runs gets past it, and test/reference/pretooluse.json
 * records that a hook that crashes or times out lets the call run.
 *
 * The push hook's order and paths: no config at its place (../config-place.mjs), the hook ends, printing and writing
 * nothing; then the reader, on the command's text. It asks git nothing, does not load the project, reads text, runs
 * none of it, and makes no network call. Exit 0 on every path, the refusal included: the printed deny stops the call.
 * Input it cannot read leaves the call and says so (systemMessage), to the person, not the model; a Monitor on a
 * socket holds no command and passes.
 */

import { hookProjectDir, mayHold } from "../config-place.mjs";
import { killTarget } from "../kill-targets.mjs";

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** The refusal when its catalog cannot be read: a broken file of the plugin must not turn a refusal into a pass. */
const PLAIN_REFUSAL = "ennyn: this kill is refused: it may reach the user's own programs. Stop only a process you started, by its PID or process group, written as a number.";

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
  /** @type {{ why: string, part: string, word?: string, beside?: string } | null} */
  let refused = null;
  let read = typeof command === "string";
  if (read) {
    try {
      refused = killTarget(command);
    } catch {
      read = false;
    }
  }
  if (read && refused === null) return;
  if (!read) {
    process.stdout.write(JSON.stringify({ systemMessage: await text("killTargets.unread") }));
    return;
  }
  // Cut: what the refusal names may be long. t escapes what a line cannot hold.
  const { part, word, beside } = /** @type {{ part: string, word?: string, beside?: string }} */ (refused);
  // A kill word beside what turns a word into a program: both are named, so the agent can split the command.
  const reason = await (word && beside ? text("killTargets.beside", { word, beside, command: part.slice(0, 200) }) : text("killTargets.refused", { command: part.slice(0, 200) })).catch(() => PLAIN_REFUSAL);
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
