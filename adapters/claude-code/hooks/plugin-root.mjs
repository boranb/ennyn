#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (matcher "startup|resume"): records the plugin version this session runs
 * (`${CLAUDE_PLUGIN_ROOT}`) in the plugin's data directory (`${CLAUDE_PLUGIN_DATA}/root`), and names that
 * directory and that version to the session's Bash commands (`ENNYN_PLUGIN_DATA`, `ENNYN_PLUGIN_ROOT`, a line in
 * `$CLAUDE_ENV_FILE`, added once). A commit-msg
 * hook installed from the plugin reads the record, so it follows plugin updates: `${CLAUDE_PLUGIN_ROOT}` is
 * one directory per version, and Claude Code deletes a replaced one 14 days after an update
 * (code.claude.com/docs/en/plugins/loading). install-hook and doctor, run from the plugin as any advice says,
 * find the record by the variable. A session still on a version Claude Code has replaced (an update that
 * finished after the session loaded) records nothing: the record stays on the newer version.
 *
 * Exit 0 on every path; never 2. A record or a variable that could not be written is said to the user
 * (systemMessage): the commit-msg hook would go on running the version recorded before, and nobody would know.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { readIfThere } from "../../../core/files.mjs";
import { shown, t } from "../../../core/i18n.mjs";
import { RecordError, recordPluginRoot, sessionLine } from "../../../setup/hook.mjs";

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** One line, and no control character a terminal would act on: the paths are the machine's. @param {unknown} err */
const said = (err) => shown(String(/** @type {Error} */ (err)?.message ?? err).trim().replace(/\s*\n\s*/g, "; ")).text;

async function main() {
  // The input says nothing this hook needs; read to its end, as Claude Code writes it whole.
  await readStdin();
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  // Not run by Claude Code as a plugin hook, or a version that gives no data directory: nothing to record.
  if (!root || !data) return;
  /** @type {string[]} */
  const errors = [];
  try {
    recordPluginRoot(data, root);
  } catch (err) {
    if (!(err instanceof RecordError && err.reason === "replaced")) errors.push(said(err));
  }
  const envFile = process.env.CLAUDE_ENV_FILE;
  // Only a shell Claude Code runs gets the file (not a PowerShell hook): without it, install-hook needs --plugin-data.
  // The variables name the version this session runs, as given: install-hook compares it with its own copy.
  if (envFile) {
    try {
      const line = sessionLine(data, resolve(root));
      if (!(readIfThere(envFile) ?? "").split("\n").includes(line.trimEnd())) appendFileSync(envFile, line);
    } catch (err) {
      errors.push(said(err));
    }
  }
  if (errors.length) process.stdout.write(JSON.stringify({ systemMessage: t("pluginRoot.notRecorded", { error: errors.join("; ") }, "en") }));
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
