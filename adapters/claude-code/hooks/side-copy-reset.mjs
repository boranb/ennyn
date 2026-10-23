#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (matcher "compact|clear"): forgets which
 * side-copy rules this session was given. The side-copy hook injects each rule
 * once per session; after the context is compacted or cleared the model no
 * longer holds them, and without this reset they would never come back.
 *
 * Exit 0 on every path, including malformed input; never 2. A reset that could not be done (a config that
 * does not load, a state file that cannot be removed) is said to the user (systemMessage): the rules would
 * otherwise never come back, and nobody would know.
 */

import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gone } from "../../../core/files.mjs";
import { loadConfig } from "../../../core/config.mjs";
import { t } from "../../../core/i18n.mjs";
import { sideCopyStatePath } from "./side-copy-rules.mjs";

/** @param {unknown} err */
function notReset(err) {
  const error = String(/** @type {Error} */ (err)?.message ?? err).trim().replace(/\s*\n\s*(?:- )?/g, "; ");
  process.stdout.write(JSON.stringify({ systemMessage: t("sidecopy.notReset", { error }, "en") }));
}

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!input || typeof input !== "object" || !["compact", "clear"].includes(input.source)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  let config;
  try {
    config = loadConfig({ cwd: projectDir });
  } catch (err) {
    return notReset(err);
  }
  try {
    // The session's list and its subagents' (`<session>+agent-<id>.json`): a compacted or cleared
    // conversation ends the subagents in it, and their lists would only keep rules from them later.
    const main = sideCopyStatePath(projectDir, config.paths.stateDir, input.session_id);
    const prefix = `${basename(main, ".json")}+agent-`;
    /** @type {string[]} */
    let names = [];
    try {
      names = readdirSync(dirname(main));
    } catch (err) {
      if (!gone(err)) throw err;
    }
    for (const name of [basename(main), ...names.filter((n) => n.startsWith(prefix) && n.endsWith(".json"))]) rmSync(join(dirname(main), name), { force: true });
  } catch (err) {
    notReset(err);
  }
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
