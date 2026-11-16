/**
 * As a harness this found 82 false ✓ per git in the third reader of hand-written hooks, and none after the exact-print rule.
 *
 * Does doctor call a commit-msg hook wired only when the check really runs and stops the commit? Each cell is a
 * repository of its own, the hook in its place and `ennyn doctor` run as a user runs it. Behind a ✓ comes a real
 * `git commit` of a real token (made at run time, test/secret-shapes.mjs) in a file and in the message, with its own
 * identity: the secret must stay out of HEAD and the refusal must name it in both places, so a hook that fails for
 * another reason, or whose check loses the message or the files, is no pass. A `wired` cell is
 * what install-hook printed and must read ✓: without those nothing here would be tried. Any other cell warns today; a
 * warning is never a false ✓ and stops no commit, so it costs a doctor run, and its commit runs only once a reader
 * starts to pass it (test/guards.mjs shows that each group fails then). A known landing is a gap cell: it names an open
 * node of the work graph and must land as recorded, and the test fails when it stops, saying the gap closed.
 *
 * Needs, on every machine the suite runs on: /bin/sh, /bin/dash and /bin/bash, whatever /bin/sh is there; /usr/bin/env;
 * `true` in /usr/bin or /bin; a git at GIT_FLOOR or newer. One that is missing fails the first test: nothing here skips.
 * The reader also allows zsh, ksh and ash; they run in no cell, so what they do with the printed text is not measured here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative as relativePath, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../core/config.mjs";
import { GIT_FLOOR, gitVersion, parseVersion, versionAtLeast } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { HOOK_MARKER, hookBlock, hookLine, hookScript, printedCheck, recordPluginRoot } from "../setup/hook.mjs";
import { ownHome } from "./own-home.mjs";
import { KIND, TOKENS } from "./secret-shapes.mjs";
import { pool } from "./verdicts.mjs";

const { root: ROOT, home: HOME } = ownHome("en-hook-oracle-");
const SELF = fileURLToPath(import.meta.url);
const TOP = join(dirname(SELF), "..");
const CLI = join(TOP, "scripts", "ennyn.mjs");
const run = promisify(execFile);

/** What the harness runs by these exact paths: each must be there and be what it is called. */
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"];
/** A program that is no shell, by the path this machine has it. */
const TRUE = ["/usr/bin/true", "/bin/true"].find((path) => existsSync(path)) ?? "true: not in /usr/bin or /bin";
const TOOLS = ["/usr/bin/env", TRUE];

// node first, as a hook finds it; the system's directories last, for `#!/usr/bin/env dash`.
const PATH = [dirname(process.execPath), process.env.PATH, "/usr/bin", "/bin"].join(delimiter);
// Every commit carries its own identity: macOS derives one, a container does not.
const ENV = { ...process.env, PATH, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

/** @param {string} path @param {string} text @param {number} [mode] */
function write(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
}

/** One commit that holds a config with rules, no template, and no maintenance a commit leaves running: a cell copies it. */
const BASE = join(ROOT, "base");
write(join(BASE, ".ennyn", "config.json"), JSON.stringify({ commitMsg: { types: ["feat", "fix"], fixType: "fix" } }));
for (const args of [["init", "-q", "--template=", "-b", "main"], ["config", "gc.auto", "0"], ["config", "maintenance.auto", "false"], ["add", "-A"], ["commit", "-q", "--no-verify", "-m", "feat: start"]]) {
  const r = spawnSync("git", args, { cwd: BASE, env: ENV, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args[0]}: ${r.stderr}`);
}

/** The plugin's data directory as the block finds it, its record naming this tree. */
const DATA = join(HOME, ".claude", "plugins", "data", "ennyn-ennyn");
recordPluginRoot(DATA, TOP);

const SH = "#!/bin/sh\n";
const LINE = hookLine(CLI);
const RECORD = hookLine(CLI, DATA);
const BLOCK = hookBlock(DATA);
const CALL = LINE.slice(0, -" || exit $?".length);

/**
 * @typedef {{
 *   name: string,
 *   text: string | ((dir: string) => string),
 *   wired?: boolean,
 *   gap?: string,
 *   file?: string,
 *   hooksPath?: string | null | ((dir: string) => string),
 *   prepare?: (dir: string) => void | string | Promise<void | string>,
 *   front?: (dir: string) => string,
 *   control?: boolean,
 * }} Cell
 *   `file`: where the hook stands, `hooks/commit-msg` by default; `hooksPath`: core.hooksPath, `hooks` by default, null for
 *   none; `prepare`: what else the cell needs, and the directory doctor and the commit run in if it is not the cell's;
 *   `front`: a PATH entry that stands first; `control`: the commit runs whatever doctor says, to try the judge.
 */

/** A `node` of the tree's that exits 0 and leaves a mark: what a package with no install script can link. */
const TREE_NODE = '#!/bin/sh\n: > "$0.ran"\nexit 0\n';
/** @param {string} dir */
const plant = (dir) => write(join(dir, "node_modules", ".bin", "node"), TREE_NODE, 0o755);
/** The mark that node leaves when it runs. @param {string} dir */
const planted = (dir) => join(dir, "node_modules", ".bin", "node.ran");
/** A program in the tree under a shell's name: it runs nothing. @param {string} dir */
const toolSh = (dir) => {
  mkdirSync(join(dir, "tools"), { recursive: true });
  cpSync(TRUE, join(dir, "tools", "sh"));
};

/** @param {string} name @param {Cell["text"]} text @param {Partial<Cell>} [more] @returns {Cell} */
const wired = (name, text, more = {}) => ({ name, text, wired: true, ...more });
/** @param {string} name @param {Cell["text"]} text @param {Partial<Cell>} [more] @returns {Cell} */
const warned = (name, text, more = {}) => ({ name, text, ...more });

/** A real commit's limit, in seconds. It is far past what a loaded machine takes: it is there for a hook that never ends. */
const COMMIT_LIMIT_S = 180;

/**
 * `sh`'s arguments for a command in a group that kills itself past `seconds`. The clock is in the group, not in this
 * file: whoever kills the file does not reach a group of its own, and `git` killed alone leaves a looping hook running.
 * `ulimit -t` is no such limit: on macOS a hook that re-runs itself, as `#!/bin/sh -c` does, passed 60 s of CPU at 3:11.
 * @param {number} seconds @param {string[]} command
 */
const watched = (seconds, command) => ["-c", `(sleep ${seconds}; kill -s KILL -- -$$) </dev/null >/dev/null 2>&1 & exec "$@"`, "sh", ...command];

/**
 * A command under `watched`; what is left of its group goes when it ends, the clock too.
 * @param {number} seconds @param {string[]} command @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ stderr: string, limited: boolean }>}
 */
function limited(seconds, command, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", watched(seconds, command), { ...opts, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", () => {
      try {
        process.kill(-Number(child.pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    child.on("close", (code, signal) => resolve({ stderr, limited: signal === "SIGKILL" }));
  });
}

/**
 * A real commit of the token in the message too (line 3, below the subject and a blank line), within the limit.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>} what git said
 */
async function realCommit(cwd, env) {
  const r = await limited(COMMIT_LIMIT_S, ["git", "commit", "-q", "-m", "feat: add token", "-m", TOKENS.github], { cwd, env });
  return r.limited ? `git commit ran past its limit of ${COMMIT_LIMIT_S} s` : r.stderr.trim();
}

/**
 * The token's two places as the check names them when it refuses: the staged file's, and the message's from the catalog.
 * A check that lost either one names only the other.
 */
const REFUSED = [`src/token.js:1 (${KIND.github}`, `${t("shape.secretMessage", { line: 3 }).split("{shown}")[0]}${KIND.github}`];

/** @typedef {Awaited<ReturnType<typeof attempt>>} Attempt */

let made = 0;
/**
 * A cell's repository, doctor's word on it, and behind a ✓ (or for a gap) a real commit of a token.
 * @param {Cell} cell
 * @returns {Promise<{ cell: Cell, reads: boolean, landed: boolean | null, stopped: boolean | null, ran: boolean, said: string }>}
 */
async function attempt(cell) {
  const dir = join(ROOT, `c${++made}`);
  cpSync(BASE, dir, { recursive: true });
  const { text, file = "hooks/commit-msg", hooksPath = "hooks" } = cell;
  write(join(dir, file), typeof text === "function" ? text(dir) : text, 0o755);
  /** @param {string} cwd @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
  const git = (cwd, args, env = ENV) => run("git", args, { cwd, env, encoding: "utf8" });
  if (hooksPath !== null) await git(dir, ["config", "core.hooksPath", typeof hooksPath === "function" ? hooksPath(dir) : hooksPath]);
  const cwd = (await cell.prepare?.(dir)) || dir;
  const env = cell.front ? { ...ENV, PATH: `${cell.front(dir)}${delimiter}${PATH}` } : ENV;
  // doctor exits 1 on a ✗: its words are the answer, as they are a user's.
  const doctor = await run(process.execPath, [CLI, "doctor"], { cwd, env, encoding: "utf8" }).catch((e) => e);
  const reads = /^✓ commit-msg hook: checks every message/m.test(doctor.stdout ?? "");
  if (!reads && !cell.gap && !cell.control) return { cell, reads, landed: null, stopped: null, ran: false, said: String(doctor.stdout ?? doctor.message).split("\n").filter((l) => /commit-msg hook/.test(l)).join(" ") };
  write(join(cwd, "src", "token.js"), `export const token = "${TOKENS.github}";\n`);
  await git(cwd, ["add", "src/token.js"]);
  const ran = planted(dir);
  rmSync(ran, { force: true });
  const said = await realCommit(cwd, env);
  const landed = (await git(cwd, ["ls-tree", "HEAD", "src/token.js"])).stdout.trim() !== "";
  return { cell, reads, landed, stopped: !landed && REFUSED.every((r) => said.includes(r)), ran: existsSync(ran), said };
}

/** What is wrong with one cell's run: a false ✓, or printed text that reads no ✓. @param {Attempt} r */
function wrong({ cell, reads, landed, stopped, said }) {
  if (cell.wired && !reads) return [`${cell.name}: what install-hook printed reads no ✓ (${said})`];
  if (!reads || stopped) return [];
  return [`false ✓: ${cell.name}: doctor reads it as wired, and a real commit ${landed ? "landed the secret" : `was not refused by the check in the file and in the message (${said.slice(0, 160)})`}`];
}

/** @param {Cell[]} cells */
async function judge(cells) {
  assert.deepEqual((await pool(cells, 4, attempt)).flatMap(wrong), []);
}

test("hook oracle: the shells and the git this harness needs are here; one that is missing is a failure, never a skip", (t) => {
  /** @type {string[]} */
  const missing = [];
  for (const shell of SHELLS) {
    const r = spawnSync(shell, ["-c", "echo ${BASH_VERSION-no bash}; exit 7"], { encoding: "utf8" });
    if (r.status !== 7) missing.push(`${shell}: ${r.error?.message ?? `exit ${r.status}`}`);
    else t.diagnostic(`${shell}: bash here: ${r.stdout.trim()}`);
    if (shell === "/bin/bash" && /no bash/.test(r.stdout)) missing.push(`${shell} is no bash`);
    if (shell === "/bin/dash" && !/no bash/.test(r.stdout)) missing.push(`${shell} is bash, so nothing here runs under dash`);
  }
  for (const tool of TOOLS) if (!existsSync(tool)) missing.push(`${tool}: not there`);
  const { text, version } = gitVersion({ cwd: ROOT });
  const floor = /** @type {number[]} */ (parseVersion(GIT_FLOOR));
  if (version === null || !versionAtLeast(version, floor)) missing.push(`git ${GIT_FLOOR} or newer: found ${text}`);
  assert.deepEqual(missing, []);
});

test("hook oracle: under /bin/sh, dash and bash, a ✓ is a secret refused by the check; a shebang that runs nothing, or that the repository chooses, reads no ✓", () => {
  const starts = /** @type {const} */ ([
    ["no shebang", ""],
    ["sh", SH],
    ["sh -e", "#!/bin/sh -e\n"],
    ["sh -eu", "#!/bin/sh -eu\n"],
    ["sh -x", "#!/bin/sh -x\n"],
    ["dash", "#!/bin/dash\n"],
    ["bash", "#!/bin/bash\n"],
    ["bash -eux", "#!/bin/bash -eux\n"],
    ["env sh", "#!/usr/bin/env sh\n"],
    ["env bash", "#!/usr/bin/env bash\n"],
    ["env dash", "#!/usr/bin/env dash\n"],
    ["a space before the path", "#! /bin/sh\n"],
  ]);
  const few = starts.filter(([name]) => ["no shebang", "sh", "dash", "bash"].includes(name));
  return judge([
    ...starts.map(([name, head]) => wired(`the line under ${name}`, `${head}${LINE}\n`)),
    ...few.map(([name, head]) => wired(`the record's line under ${name}`, `${head}${RECORD}\n`)),
    ...few.map(([name, head]) => wired(`the block under ${name}`, `${head}${BLOCK}`)),
    warned("a shebang that runs a program of no shell", `#!${TRUE}\n${LINE}\n`),
    warned("sh -n: reads, runs nothing", `#!/bin/sh -n\n${LINE}\n`),
    warned("sh -s: reads stdin, runs nothing", `#!/bin/sh -s\n${LINE}\n`),
    warned("sh -c: the path is the command", `#!/bin/sh -c\n${LINE}\n`),
    warned("env's own flag", `#!/usr/bin/env -i sh\n${LINE}\n`),
    warned("a CR on the shebang", `#!/bin/sh\r\n${LINE}\r\n`),
    warned("a shebang relative to the tree", `#!tools/sh\n${LINE}\n`, { prepare: toolSh }),
    warned("a shebang absolute into the tree", (d) => `#!${join(d, "tools", "sh")}\n${LINE}\n`, { prepare: toolSh }),
  ]);
});

test("hook oracle: what may stand before the printed text leaves it running; what may not reads no ✓", () => {
  const before = /** @type {const} */ ([
    ["a blank line", "\n"],
    ["blank lines with spaces", "\n\t\n  \n"],
    ["a comment", "# ours\n"],
    ["a comment that ends in a backslash", "# not a continuation \\\n"],
    ["a comment that says exit", "# exit 0\n"],
    ["set -e", "set -e\n"],
    ["set -u", "set -u\n"],
    ["set -x", "set -x\n"],
    ["set -eux", "set -eux\n"],
    ["set -e -u", "set -e -u\n"],
    ["a comment that reads as a shebang", "# no shebang here\n#!/usr/bin/python3\n"],
    ["an indented comment", "  # x\n"],
    ["a comment with a quote", "# it's\n"],
    ["a comment with a substitution", "# $(exit 0)\n"],
  ]);
  return judge([
    ...before.map(([name, text]) => wired(`the line after ${name}`, `${SH}${text}${LINE}\n`)),
    wired("the block after a comment", `${SH}# ours\n${BLOCK}`),
    wired("the block after set -e", `${SH}set -e\n${BLOCK}`),
    warned("exit 0 first", `${SH}exit 0\n${LINE}\n`),
    warned("set -n first: reads, runs nothing", `${SH}set -n\n${LINE}\n`),
    warned("set -- first: the message's path gone", `${SH}set --\n${LINE}\n`),
    warned("set -e, then exit 0, on one line", `${SH}set -e; exit 0\n${LINE}\n`),
    warned("set -o noexec", `${SH}set -o noexec\n${LINE}\n`),
    warned("shift first: the message's path gone", `${SH}shift\n${LINE}\n`),
    warned("a trap that rewrites the refusal", `${SH}trap 'exit 0' EXIT\n${LINE}\n`),
    warned("cd away first: the message's relative path lost", `${SH}cd tools\n${LINE}\n`, { prepare: toolSh }),
    warned("PATH on a line of its own", `${SH}PATH=node_modules/.bin:$PATH\n${LINE}\n`, { prepare: plant }),
    warned("husky's source line first", `${SH}. "$(dirname -- "$0")/_/husky.sh"\n${LINE}\n`),
    warned("a function named node first", `${SH}node() { :; }\n${LINE}\n`),
    warned("inside an if that never runs", `${SH}if false; then\n${LINE}\nfi\n`),
    warned("inside a function never called", `${SH}f() {\n${LINE}\n}\n`),
    warned("inside a here-document", `${SH}: <<'E'\n${LINE}\nE\n`),
    warned("inside a quoted string", `${SH}X='\n${LINE}\n'\n`),
    warned("the block with its exit taken out", `${SH}${BLOCK.replace(") || exit $?", ") || true")}`),
  ]);
});

test("hook oracle: what follows the printed text is not reached on a refusal, under each shell, whatever it is", () => {
  const after = /** @type {const} */ ([
    ["exit 0", "exit 0\n"],
    ["a quote left open", "'unclosed\n"],
    ["a closing brace", "}\n"],
    ["a fi", "fi\n"],
    ["bash's own test", "[[ -n x ]] && exit 0\n"],
    ["a second shebang", '#!/bin/bash\n[[ -n "$SKIP" ]] && exit 0\n'],
    ["husky's source line", '. "$(dirname -- "$0")/_/husky.sh"\n'],
    ["a line with a CR", "exit 0\r\n"],
  ]);
  const shells = /** @type {const} */ ([["dash", "#!/bin/dash\n"], ["bash", "#!/bin/bash\n"]]);
  return judge([
    ...after.map(([name, text]) => wired(`the line, then ${name}`, `${SH}${LINE}\n${text}`)),
    ...after.slice(1, 4).flatMap(([name, text]) => shells.map(([shell, head]) => wired(`the line, then ${name}, under ${shell}`, `${head}${LINE}\n${text}`))),
    wired("the block, then exit 0", `${SH}${BLOCK}exit 0\n`),
    wired("the block, then a quote left open", `${SH}${BLOCK}'unclosed\n`),
  ]);
});

test("hook oracle: the printed line holds under paths a shell would split; words around it on its own line read no ✓", () => {
  const cli = (/** @type {string} */ name) => {
    const path = join(ROOT, "paths", name.replace(/\W/g, "_"), name, "scripts", "ennyn.mjs");
    write(path, `import { spawnSync } from "node:child_process";\nprocess.exit(spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);\n`);
    return path;
  };
  // No backslash in a name: Node runs no .mjs from such a path, so every commit fails closed before the check.
  const names = ["with space", "qu'ote", "dollar$HOME", "back`tick", "semi;colon"];
  const data = join(ROOT, "data", "with space");
  write(join(data, "root"), `${dirname(dirname(cli("with space")))}\n`);
  const lax = join(ROOT, "lax.mjs");
  write(lax, "process.exit(0);\n");
  const elsewhere = join(ROOT, "elsewhere");
  write(join(elsewhere, "root"), `${join(ROOT, "lax")}\n`);
  write(join(ROOT, "lax", "scripts", "ennyn.mjs"), "process.exit(0);\n");
  return judge([
    ...names.map((name) => wired(`the line naming [${name}]`, `${SH}${hookLine(cli(name))}\n`)),
    wired("the record's line naming a path with a space", `${SH}${hookLine(CLI, data)}\n`),
    warned("true in front", `${SH}true ${LINE}\n`),
    warned(": in front", `${SH}: ${LINE}\n`),
    warned("! in front", `${SH}! ${LINE}\n`),
    warned("an assignment in front", `${SH}X=1 ${LINE}\n`),
    warned("another config in front", `${SH}ENNYN_CONFIG=/nonexistent/x.json ${LINE}\n`),
    warned("another index in front", `${SH}GIT_INDEX_FILE=/dev/null ${LINE}\n`),
    warned("|| true on the end", `${SH}${CALL} || true\n`),
    warned("the call alone, then exit 0", `${SH}${CALL}\nexit 0\n`),
    warned("in the background", `${SH}${CALL} &\n`),
    warned("in a substitution of :", `${SH}$(: ${CALL})\n`),
    warned("&> under dash", `#!/bin/dash\n${CALL} &>/dev/null\n`),
    warned("a CR on the call alone", `${SH}${CALL}\r\n`),
    warned("the path not quoted as printed", `${SH}${LINE.replaceAll("'", "")}\n`),
    warned("a relative CLI", `${SH}node 'tools/scripts/ennyn.mjs' commit-check --hook "$1" || exit $?\n`, { file: ".git/hooks/commit-msg", hooksPath: null, prepare: (d) => write(join(d, "tools", "scripts", "ennyn.mjs"), "process.exit(0);\n") }),
    warned("another script in the CLI's place", `${SH}node '${lax}' commit-check --hook "$1" || exit $?\n`),
    warned("a block whose id walks out of the data directory", `${SH}${BLOCK.replace("id='ennyn-ennyn'", `id='${relativePath(dirname(DATA), elsewhere)}'`)}`),
  ]);
});

const relative = () => join("node_modules", ".bin");
/** @param {string} dir */
const absolute = (dir) => join(dir, "node_modules", ".bin");

/** What husky 9.1.7 writes as .husky/_/commit-msg, and the two lines of its .husky/_/h that matter here (test/hook.test.mjs). */
const HUSKY_STUB = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';
const HUSKY_RUNNER = '#!/usr/bin/env sh\ns=$(dirname "$(dirname "$0")")/$(basename "$0")\nexport PATH="node_modules/.bin:$PATH"\nsh -e "$s" "$@"\n';
/** @param {string} dir */
const husky = (dir) => {
  write(join(dir, ".husky", "_", "commit-msg"), HUSKY_STUB, 0o755);
  write(join(dir, ".husky", "_", "h"), HUSKY_RUNNER, 0o755);
  write(join(dir, ".husky", "_", ".gitignore"), "*\n");
};
const UNDER_HUSKY = { file: ".husky/commit-msg", hooksPath: ".husky/_" };

const OWN_HOOK = { file: ".git/hooks/commit-msg", hooksPath: null };

test("hook oracle: the hooks install-hook writes stop a real secret; a hook git does not run, or one that only looks like them, reads no ✓", () =>
  judge([
    wired("the own script", hookScript(CLI), OWN_HOOK),
    wired("the plugin's script", hookScript(CLI, DATA), OWN_HOOK),
    warned("the marker in a tracked hook", `${SH}${HOOK_MARKER}\nexit 0\n`),
    warned("the marker, naming the check", `${SH}${HOOK_MARKER}: commit-check\nexit 0\n`),
    warned("the block behind a tracked stub that exits 0", BLOCK, {
      ...UNDER_HUSKY,
      prepare: async (d) => {
        husky(d);
        write(join(d, ".husky", "_", "commit-msg"), `${SH}exit 0\n`, 0o755);
        await run("git", ["add", "-f", ".husky/_/commit-msg"], { cwd: d, env: ENV });
      },
    }),
    warned("an empty core.hooksPath, the file at the top", `${SH}${LINE}\n`, { file: "commit-msg", hooksPath: "" }),
    warned("a hook not executable", `${SH}${LINE}\n`, { prepare: (d) => chmodSync(join(d, "hooks", "commit-msg"), 0o644) }),
    warned("doctor in a subdirectory, a hook of that relative name there", `${SH}exit 0\n`, { prepare: (d) => (write(join(d, "sub", "hooks", "commit-msg"), `${SH}${LINE}\n`, 0o755), join(d, "sub")) }),
  ]));

test("hook oracle: a ✓ holds where a layout changes what runs: husky's runner, a CLI in the work tree, a linked worktree, a node in the tree the block filters out", () => {
  /** @param {string} dir */
  const inTree = (dir) => join(dir, "tools", "scripts", "ennyn.mjs");
  /** @param {string} dir */
  const stub = (dir) => write(inTree(dir), "process.exit(0);\n");
  /** @param {string} dir */
  const linked = async (dir) => {
    await run("git", ["worktree", "add", "-q", "--detach", `${dir}-linked`, "HEAD"], { cwd: dir, env: ENV });
    return `${dir}-linked`;
  };
  return judge([
    wired("the block under husky", BLOCK, { ...UNDER_HUSKY, prepare: husky }),
    wired("the block under husky, a node in the tree", BLOCK, { ...UNDER_HUSKY, prepare: (d) => (husky(d), plant(d)) }),
    warned("the line under husky, a node in the tree", `${LINE}\n`, { ...UNDER_HUSKY, prepare: (d) => (husky(d), plant(d)) }),
    warned("the record's line under husky, a node in the tree", `${RECORD}\n`, { ...UNDER_HUSKY, prepare: (d) => (husky(d), plant(d)) }),
    wired("the block, a relative entry to a node of the tree first", `${SH}${BLOCK}`, { prepare: plant, front: relative }),
    wired("the block, an absolute entry to a node of the tree first", `${SH}${BLOCK}`, { prepare: plant, front: absolute }),
    wired("from a linked worktree, the line in the main checkout's hooks", `${SH}${LINE}\n`, { hooksPath: (d) => join(d, "hooks"), prepare: linked }),
    warned("the line naming a CLI in the work tree", (d) => `${SH}${hookLine(inTree(d))}\n`, { prepare: stub }),
    warned("the record's line, the record in the work tree", (d) => `${SH}${hookLine(CLI, join(d, "data"))}\n`, {
      prepare: (d) => {
        write(join(d, "data", "root"), `${join(d, "tools")}\n`);
        stub(d);
      },
    }),
    warned("from a linked worktree, the line naming a CLI in the main checkout", (d) => `${SH}${hookLine(inTree(d))}\n`, {
      hooksPath: (d) => join(d, "hooks"),
      prepare: (d) => (stub(d), linked(d)),
    }),
  ]);
});

/** The node that closes the landings below: the same record as a gap cell of test/verdicts/. */
const NODE = "hook-node-in-repo";
/** Doctor reads each as wired and a real commit lands the secret: an in-tree `node` first on PATH runs instead of the real one. */
const GAPS = /** @type {const} */ ([
  ["the printed line", `${SH}${LINE}\n`, {}],
  ["the record's line", `${SH}${RECORD}\n`, {}],
  ["the own script", hookScript(CLI), OWN_HOOK],
  ["the plugin's script", hookScript(CLI, DATA), OWN_HOOK],
]).flatMap(([name, text, where]) => [
  wired(`${name}, a relative in-tree entry first`, text, { ...where, gap: NODE, prepare: plant, front: relative }),
  wired(`${name}, an absolute in-tree entry first`, text, { ...where, gap: NODE, prepare: plant, front: absolute }),
]);

test("hook oracle: each known landing lands as recorded, named by an open node of the work graph; one that stops says its gap closed", async () => {
  const config = loadConfig({ cwd: TOP, env: {} });
  const graph = await loadGraph({ cwd: TOP, config });
  const f = config.graph.fields;
  const open = new Set(graph.open.filter((n) => n[f.status] !== config.graph.doneStatus).map((n) => n[f.id]));
  const closed = new Set([...graph.done, ...graph.open.filter((n) => n[f.status] === config.graph.doneStatus)].map((n) => n[f.id]));
  const out = [];
  for (const r of await pool(GAPS, 4, attempt)) {
    const { cell, reads, landed, ran, said } = r;
    if (closed.has(cell.gap)) out.push(`${cell.name}: ${cell.gap} is closed, and the cell still names it`);
    else if (!open.has(cell.gap)) out.push(`${cell.name}: ${cell.gap} is no open node of the work graph`);
    if (!reads || !landed) out.push(`${cell.name}: the gap ${cell.gap} closed: doctor ${reads ? "reads ✓" : "warns"} and the secret ${landed ? "landed" : `did not land (${said.slice(0, 120)})`}: make it a plain cell`);
    else if (!ran) out.push(`${cell.name}: the secret landed and the planted node did not run: another cause, not the recorded gap`);
    // The judge of every other cell, on the landings it must call false.
    else if (!wrong(r).length) out.push(`${cell.name}: the judge passes a known landing`);
  }
  // A hook that fails by itself keeps the secret out too, and the judge does not take that for the check.
  const empty = join(ROOT, "empty");
  write(join(empty, "root"), "");
  const failed = await attempt(wired("a record with nothing in it", `${SH}${hookLine(CLI, empty)}\n`));
  assert.deepEqual([failed.reads, failed.landed, failed.stopped, wrong(failed).length], [true, false, false, 1], failed.said);
  // A check that loses the message, or the files, refuses the token in the other place: no stop, if doctor read it as wired.
  for (const [name, text, more] of /** @type {const} */ ([
    ["cd away first: the message lost", `${SH}cd tools\n${LINE}\n`, { prepare: toolSh }],
    ["another index in front: the files lost", `${SH}GIT_INDEX_FILE=/dev/null ${LINE}\n`, {}],
  ])) {
    const lost = await attempt(warned(name, text, { ...more, control: true }));
    assert.deepEqual([lost.landed, lost.stopped, lost.said.includes(KIND.github), wrong({ ...lost, reads: true }).length], [false, false, true, 1], `${name}: ${lost.said}`);
  }
  assert.deepEqual(out, []);
});

/**
 * The wrappers a hand-written hook puts around `c`, each of them a shape some reader once took for wired. The reader
 * refuses them all but the printed line; a text it refuses needs no run, so the list costs nothing until one passes.
 * @param {string} c
 */
const wrappers = (c) => [
  c, `exec ${c}`, `X=1 ${c}`, `X="a b" ${c}`, `if ${c}; then :; fi`, `if ! ${c}; then exit 1; fi`, `! ${c}`, `${c} || exit $?`, `${c} || exit 1`, `${c} && :`, `${c}; exit $?`,
  `(${c})`, `( ${c} )`, `{ ${c}; }`, `time ${c}`, `command ${c}`, `env ${c}`, `eval '${c}'`, `sh -c '${c}' sh "$1"`, `nice ${c}`, `>/dev/null ${c}`, `2>/dev/null ${c}`, `\`${c}\``, `$(${c})`, `x=$(${c})`, `x=\`${c}\``,
  `true && ${c}`, `false || ${c}`, `: && ${c}`, `[ -n "$S" ] || ${c}`, `[ -z "$S" ] && ${c}`, `case x in x) ${c} ;; esac`, `case $S in y) ${c} ;; esac`, `case $S in n) ${c} ;; esac`, `case $S in [!y]*) ${c} ;; esac`,
  `for i in 1; do ${c}; done`, `for i in; do ${c}; done`, `while false; do ${c}; done`, `until true; do ${c}; done`, `if false; then ${c}; fi`, `if true; then ${c}; fi`, `if [ -z "$S" ]; then ${c}; fi`,
  `f() { ${c}; }`, `f() { ${c}; }; f "$1"`, `f () { ${c}; }`, `f ( ) { ${c}; }`, `f() (${c})`, `function f { ${c}; }`, `alias c='${c}'`, `X='${c}'`, `X="${c}"`, `export X='${c}'`, `readonly X='${c}'`, `trap '${c}' EXIT`, `trap "${c}" INT`,
  `exit 0; ${c}`, `exec true; ${c}`, `true; ${c}`, `true ${c}`, `false ${c}`, `: ${c}`, `echo ${c}`, `printf '%s' ${c}`, `test ${c}`, `[ ${c} ]`, `type ${c}`, `which ${c}`, `command -v ${c}`, `command -V ${c}`, `hash ${c}`,
  `${c} &`, `${c} | cat`, `S=n ${c}`, `S=n; ${c}`, `S=n && ${c}`, `{ exit 0; }; ${c}`, `(exit 0) && ${c}`, `if [ -n "$S" ]; then exit 0; fi; ${c}`, `case $S in y) exit 0 ;; esac; ${c}`, `[ "$S" = y ] && exit 0; ${c}`,
  `exec 2>&1; ${c}`, `cd .; ${c}`, `read -r l < "$1"; ${c}`, `IFS= read -r l < "$1" || ${c}`, `shift; ${c}`, `sleep 0 ${c}`, `cat ${c}`, `exec echo ${c}`, `exec true ${c}`, `X=1 echo ${c}`, `X=1 true ${c}`, `if true ${c}; then :; fi`, `! true ${c}`,
  `# ${c}`, `  ${c}`, `\t${c}`, `\\\n${c}`, `${c} \\\n  || exit 1`, `if\n  ${c}\nthen\n  :\nfi`, `case x in\n  x) ${c} ;;\nesac`, `{\n  ${c}\n}`, `(\n  ${c}\n)`, `f() {\n  ${c}\n}\nf "$1"`, `cat <<'E'\n${c}\nE`, `: <<'E'\n${c}\nE`, `X='\n${c}\n'`, `if false; then\n  ${c}\nfi`,
];

test("hook oracle: no wrapper of the check reads as wired unless each shell stops on it, a stand-in for the CLI refusing", () => {
  const dir = join(ROOT, "wrappers");
  const mark = join(dir, "ran");
  const hook = join(dir, "commit-msg");
  const message = join(dir, "message");
  write(join(dir, "_", "husky.sh"), "");
  write(message, 'Revert "x"\n');
  write(join(dir, "bin", "node"), `#!/bin/sh\n: > '${mark}'\nexit 1\n`, 0o755);
  /** Whether this shell runs the check in `text` and stops when it refuses. @param {string} shell @param {string} text */
  const stops = (shell, text) => {
    rmSync(mark, { force: true });
    writeFileSync(hook, text);
    const r = spawnSync(shell, [hook, message], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}${delimiter}/usr/bin${delimiter}/bin`, S: "y" }, input: "", timeout: 60_000, killSignal: "SIGKILL" });
    return existsSync(mark) && r.status !== 0;
  };
  const line = hookLine("/opt/ennyn/scripts/ennyn.mjs");
  const call = line.slice(0, -" || exit $?".length);
  // The judge, both ways, before it judges anything.
  for (const shell of SHELLS) assert.deepEqual([stops(shell, `${line}\n`), stops(shell, "exit 0\n"), stops(shell, `true ${line}\n`)], [true, false, false], shell);
  const heads = ["", SH, '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n'];
  const texts = heads.flatMap((head) => [call, line].flatMap(wrappers).map((body) => `${head}${body}\n`));
  const read = texts.filter((text) => printedCheck(text) !== null);
  assert.ok(read.length > 0, "the reader passes no text, so nothing here was tried");
  const out = read.flatMap((text) => SHELLS.filter((shell) => !stops(shell, text)).map((shell) => `false ✓ under ${shell}: ${JSON.stringify(text)}`));
  assert.deepEqual(out, []);
});

test("hook oracle: run with a home outside the temporary folder it refuses, before any write", () => {
  const tmp = mkdtempSync(join(ROOT, "tmp-"));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test-name-pattern=^no such test$", SELF], { env: { ...env, HOME: join(sep, "no", "such", "home"), TMPDIR: tmp }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refuses to run: HOME/);
  assert.deepEqual(readdirSync(tmp), []);
});

test("hook oracle: a hook that never ends is killed with its group at the limit, by the group itself: a killed test file leaves nothing running", async () => {
  const beat = join(ROOT, "beat");
  // A loop under the shell, as a hook's is, that writes as long as it lives; bounded, so a broken limit leaves nothing running.
  const loop = ["/bin/sh", "-c", `(i=0; while [ $i -lt 300 ]; do : > '${beat}'; sleep 0.1; i=$((i + 1)); done) 2>/dev/null & wait`];
  // Started and left, with no listener and no clean-up: what a killed test file leaves. The clock is long enough for a
  // first beat to land, on a loaded machine too: silence counts only after one, and only once the clock has run.
  const clock = 5;
  const started = performance.now();
  spawn("/bin/sh", watched(clock, loop), { env: ENV, detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 100 && !existsSync(beat); i++) await delay(100);
  assert.equal(existsSync(beat), true, "the loop never beat, so its silence would prove nothing");
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    rmSync(beat, { force: true });
    await delay(1000);
    alive = existsSync(beat);
  }
  assert.equal(alive, false, "the loop under the shell is still running");
  assert.ok(performance.now() - started >= clock * 1000, "the loop stopped before the clock ran: it died by itself, and the kill is not shown");
  const r = await limited(1, loop, { env: ENV });
  assert.equal(r.limited, true);
});
