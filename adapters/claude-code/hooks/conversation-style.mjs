#!/usr/bin/env node
/**
 * Claude Code SessionStart hook: gives the session the project's conversation
 * style (`conversation.style`, in `language`). It runs at startup and resume,
 * and again after compaction or /clear, when the earlier injection is gone.
 * "normal" or no config: nothing is injected. A config that does not load (broken, or there but unreadable)
 * injects nothing either, and says so to the user (systemMessage): the session runs without its style.
 *
 * Exit 0 on every path, including malformed input; never 2.
 */

import { loadConfig } from "../../../core/config.mjs";
import { styleRules } from "../../../core/style.mjs";
import { t } from "../../../core/i18n.mjs";

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
  const cwd = input && typeof input === "object" && typeof input.cwd === "string" ? input.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  let config;
  try {
    config = loadConfig({ cwd: projectDir });
  } catch (err) {
    const error = String(/** @type {Error} */ (err).message).trim().replace(/\s*\n\s*(?:- )?/g, "; ");
    process.stdout.write(JSON.stringify({ systemMessage: t("style.notApplied", { error }, "en") }));
    return;
  }
  const rules = styleRules(config.conversation.style, config.language);
  if (!rules) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rules } }));
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
