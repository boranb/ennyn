#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (matcher "compact|clear"): forgets which
 * side-copy rules this session was given. The side-copy hook injects each rule
 * once per session; after the context is compacted or cleared the model no
 * longer holds them, and without this reset they would never come back.
 *
 * It acts on Ennyn's own state, not on the work tree: the lists live in the git dir and outlive a checkout of a
 * branch from before Ennyn, so with no config (../project.mjs) the default state dir is looked at, and a list
 * there is removed. A project that never used Ennyn has none: nothing is said or written.
 *
 * Exit 0 on every path, including malformed input; never 2. A reset that could not be done (a config that
 * does not load, a state file that cannot be removed) is said to the user (systemMessage): the rules would
 * otherwise never come back, and nobody would know. With no config it is not said: nothing shows the project
 * ever used Ennyn.
 */

import { basename, dirname, join } from "node:path";
import { listState, removeState } from "../../../core/files.mjs";
import { stateRoot } from "../../../core/git.mjs";
import { DEFAULTS } from "../../../core/config.mjs";
import { t } from "../../../core/i18n.mjs";
import { hookProjectDir, projectConfig } from "../project.mjs";
import { said, sideCopyStatePath } from "./side-copy-rules.mjs";

/** @param {unknown} err */
function notReset(err) {
  process.stdout.write(JSON.stringify({ systemMessage: t("sidecopy.notReset", { error: said(String(/** @type {Error} */ (err)?.message ?? err)) }, "en") }));
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
  const projectDir = hookProjectDir(input);
  let config;
  try {
    config = projectConfig(projectDir);
  } catch (err) {
    return notReset(err);
  }
  try {
    // The session's list and its subagents' (`<session>+agent-<id>.json`): a compacted or cleared
    // conversation ends the subagents in it, and their lists would only keep rules from them later.
    const main = sideCopyStatePath(projectDir, (config ?? DEFAULTS).paths.stateDir, input.session_id);
    const prefix = `${basename(main, ".json")}+agent-`;
    // Listed and removed below the state root with no link among the directories: a commit's link is not followed.
    const root = stateRoot(projectDir, main);
    const names = listState(root, dirname(main));
    for (const name of names.filter((n) => n === basename(main) || (n.startsWith(prefix) && n.endsWith(".json")))) removeState(root, join(dirname(main), name));
  } catch (err) {
    if (config) notReset(err);
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
