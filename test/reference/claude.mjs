/**
 * `npm run test:reference`'s Claude Code half: the eval checks' self-test (test/eval/selftest.mjs), the Claude Code
 * record (claude-code.mjs) and the PreCompact record (precompact.mjs), each checked against the machine, with the same claude handed to each by its path
 * (npm hands a script's arguments to its last command alone). Both run whatever the first says; the exit is 1 when
 * either fails. Where the self-test cannot run (no sandbox-exec) it says it was not measured and the record is still
 * checked.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeBinary } from "./claude-bin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// The binary, found once (`--claude`, else the first claude on PATH outside a node_modules/.bin, where npm run puts
// every ancestor's) and handed to both by its path.
const argv = process.argv.slice(2);
const at = argv.indexOf("--claude");
const found = claudeBinary(at === -1 ? "claude" : argv[at + 1]);
if (!found) {
  process.stderr.write("no claude binary found (node_modules/.bin folders on PATH are skipped): point at one with --claude <path>\n");
  process.exit(1);
}
process.stdout.write(`claude: ${found.path}${found.file === found.path ? "" : ` (${found.file})`}\n`);
const rest = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
let failed = false;
for (const script of [join(HERE, "..", "eval", "selftest.mjs"), join(HERE, "claude-code.mjs"), join(HERE, "precompact.mjs")]) {
  const r = spawnSync(process.execPath, [script, "check", "--claude", found.path, ...rest], { stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
