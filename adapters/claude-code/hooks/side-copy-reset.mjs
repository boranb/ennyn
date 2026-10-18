#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (matcher "compact|clear"): forgets which
 * side-copy rules this session was given. The side-copy hook injects each rule
 * once per session; after the context is compacted or cleared the model no
 * longer holds them, and without this reset they would never come back.
 *
 * Exit 0 on every path, including malformed input; never 2.
 */

import { rmSync } from "node:fs";
import { loadConfig } from "../../../core/config.mjs";
import { sideCopyStatePath } from "./side-copy-rules.mjs";

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
  } catch {
    return;
  }
  rmSync(sideCopyStatePath(projectDir, config.paths.stateDir, input.session_id), { force: true });
}

main().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 0;
  },
);
