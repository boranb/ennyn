#!/usr/bin/env node
/**
 * Claude Code SessionStart hook: gives the session the project's conversation
 * style (`conversation.style`, in `language`). It runs at startup and resume,
 * and again after compaction or /clear, when the earlier injection is gone.
 * "normal", or no config (../project.mjs): nothing is injected. A config that does not load (broken, or there but unreadable)
 * injects nothing either, and says so to the user (systemMessage): the session runs without its style.
 *
 * After a compaction it also gives one fixed line, after the style: if a task is in progress, re-read the files it
 * changed and its impact table before the next edit. Claude Code 2.1.310 runs this hook for a subagent's compaction
 * too, and its text reaches that agent, but the input is the main thread's: its `cwd` is the session's folder, not a
 * task's worktree, so the line names no file and says how to list them. Where that folder is the agent's own (the main
 * thread, an agent run with `isolation: "worktree"`), the PreCompact hook's summary request already lists the files
 * changed since the last commit. `compaction.defer: false` turns the line off, with the rest of Ennyn's compaction
 * handling.
 *
 * Exit 0 on every path, including malformed input; never 2.
 */

import { styleRules } from "../../../core/style.mjs";
import { shown, t } from "../../../core/i18n.mjs";
import { hookProjectDir, projectConfig } from "../project.mjs";

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  /** @type {any} */
  let input = null;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // The project directory may still come from the environment.
  }
  let config;
  try {
    config = projectConfig(hookProjectDir(input));
  } catch (err) {
    // One line, and no control character a terminal would act on: the config is the project's text.
    const error = shown(String(/** @type {Error} */ (err).message).trim().replace(/\s*\n\s*(?:- )?/g, "; ")).text;
    process.stdout.write(JSON.stringify({ systemMessage: t("style.notApplied", { error }, "en") }));
    return;
  }
  // Not a project Ennyn works in (../project.mjs).
  if (!config) return;
  const rules = styleRules(config.conversation.style, config.language);
  const reread = input?.source === "compact" && config.compaction.defer ? t("compact.reread", {}, config.language) : null;
  const context = rules && reread ? `${rules.trimEnd()}\n\n${reread}` : rules ?? reread;
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
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
