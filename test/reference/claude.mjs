/**
 * `npm run test:reference`'s Claude Code half: the eval checks' self-test (test/eval/selftest.mjs) and the Claude
 * Code record (claude-code.mjs), each checked against the machine, with the same `--claude <bin>` handed to both
 * (npm hands a script's arguments to its last command alone). Both run whatever the first says; the exit is 1 when
 * either fails. Where the self-test cannot run (no sandbox-exec) it says it was not measured and the record is still
 * checked.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = false;
for (const script of [join(HERE, "..", "eval", "selftest.mjs"), join(HERE, "claude-code.mjs")]) {
  const r = spawnSync(process.execPath, [script, "check", ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
