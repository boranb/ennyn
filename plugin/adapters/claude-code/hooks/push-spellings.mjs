#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (matcher `Bash|Monitor|PowerShell`, the tools that run a command): refuses every push but
 * a plain `git push` the ask rule reads for certain, in every permission mode, and says how to write it. That plain push
 * it asks about (`ask`), so the user is asked with no rule too, unless it is a bare `git push` and the config's
 * `push.mode` lets the cycle push by itself on the verdict push-check gives (../../../checks/push-mode.mjs). In a
 * subagent (the input's `agent_id`) it refuses that push too, never asks, and gives the fetch form a lab's upstream takes;
 * a spelling it refuses there gets that fetch form too, not the advice to write a plain push.
 * ../push-spellings.mjs is the reader and has the shape and the limits. This stops a push written another way by habit.
 * It is no boundary: a program set on pushing gets through, and test/reference/pretooluse.json records that a hook that
 * crashes or times out lets the call run.
 *
 * Every Bash call pays for this, so the order is by cost. No config at its place (../config-place.mjs): the hook ends,
 * printing and writing nothing. The reader, on the command's text: most calls end here. It asks git nothing and does not
 * load the project, on a refusal too: a git answer is the repository's to move or stall, and a config that does not load
 * is a project that asked for Ennyn. Only a plain push it leaves loads the config and asks git, for push-check's
 * verdict. A config at .ennyn/config.json or at ENNYN_CONFIG's path: either one means Ennyn's project, so a settings
 * `env` that names a file nothing holds does not switch this off. It reads text, runs none of it, and makes no network
 * call: the verdict's git calls run with no lazy fetch and no transport, and start no OpenPGP or x509 verifier
 * (READ_ONLY_CONFIG, NO_TRANSPORT).
 *
 * Exit 0 on every path, the refusal included: it is the printed deny that stops a call, and a printed deny stops it
 * over any exit code. Input it cannot read leaves the call and says so (systemMessage): the crash it would otherwise be
 * runs the call too, a deny would stall every shell command of every project after one Claude Code update, and the ask
 * rule still stands. Claude Code itself refuses a shell call with no command, before any hook, so this is a change of
 * shape, not a bad call; a Monitor on a socket holds no command and runs none, and passes. The message reaches the
 * person (the session's stream, the terminal), not the model.
 */

import { hookProjectDir, mayHold } from "../config-place.mjs";
import { pushReading } from "../push-spellings.mjs";

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** The refusal when its catalog cannot be read: a broken file of the plugin must not turn a refusal into a pass. */
const PLAIN_REFUSAL = "ennyn: this push is refused: write it in a call of its own, git push <remote> <branch>, with the commit in the call before.";
/** The ask when its catalog cannot be read. */
const PLAIN_ASK = "ennyn: this push waits for the user's yes.";
/** The refusal in a subagent when its catalog cannot be read. */
const PLAIN_SUBAGENT = "ennyn: a subagent does not push: this push is refused. Leave it to the main thread.";

/** A call made in a subagent: Claude Code's input names it with `agent_id`, absent on the main thread. @param {any} input */
const inSubagent = (input) => input?.agent_id !== undefined && input?.agent_id !== null && input?.agent_id !== "";

/** The decision's whole run, git calls included, well inside the hook's 10 s: a hook that times out lets the call run. */
const DECIDE_MS = 5000;

/** A program path no system holds: a directory under the null device (as HOOK_READ_ENV's graft file). */
const NO_PROGRAM = "/dev/null/ennyn-no-verifier";
/**
 * Config the verdict's git calls run with, given after every file git reads (command scope), so no repository's own
 * config takes it back. The two signature verifiers that may reach a network (an OpenPGP keyserver, an x509 CRL or
 * transparency log) name a program that cannot start: git 2.56.0 and 2.34.1 start `gpg.program` (or
 * `gpg.openpgp.program`, which the later key overrides) for an OpenPGP header and `gpg.x509.program` for an x509 one
 * under `%G?`; with these, neither starts, git says `fatal: cannot exec` on stderr, prints N and exits 0. The commits
 * rule refuses such a commit anyway, by its raw header. The SSH verifier (`gpg.ssh.program`, ssh-keygen by default,
 * which verifies against the allowed-signers file on this machine) still runs: the rule needs its answer.
 */
const READ_ONLY_CONFIG = [
  ["gpg.program", NO_PROGRAM],
  ["gpg.x509.program", NO_PROGRAM],
];
/**
 * No transport at all: a git that does not read GIT_NO_LAZY_FETCH (below 2.45 and its May 2024 backports, vanilla
 * 2.34.1 measured) fetches a missing object from a partial clone's promisor remote. GIT_ALLOW_PROTOCOL replaces every
 * protocol.* key, where `protocol.allow never` loses to a config file's `protocol.file.allow always` (git reads the
 * per-protocol key first; measured on 2.34.1). No protocol is named `none`.
 */
const NO_TRANSPORT = { GIT_ALLOW_PROTOCOL: "none" };

/**
 * `pairs` added to the GIT_CONFIG_COUNT list git reads from the environment, after any the environment holds. A count
 * that is not one is left as it is: git then fails every call (`bogus count`), and the push is asked.
 * @param {NodeJS.ProcessEnv} env @param {string[][]} pairs @returns {Record<string, string>}
 */
function withConfig(env, pairs) {
  const had = env.GIT_CONFIG_COUNT;
  if (had !== undefined && had !== "" && !/^\d+$/.test(had)) return {};
  const from = had ? Number(had) : 0;
  /** @type {Record<string, string>} */
  const out = { GIT_CONFIG_COUNT: String(from + pairs.length) };
  pairs.forEach(([key, value], k) => {
    out[`GIT_CONFIG_KEY_${from + k}`] = key;
    out[`GIT_CONFIG_VALUE_${from + k}`] = value;
  });
  return out;
}

/**
 * Why a plain push it leaves waits for the user, or null to let it run: only a bare `git push`, when the one verdict
 * `ennyn push-check` gives (../../../checks/push-mode.mjs, hookVerdict) lets the cycle push by itself: the mode, the
 * commits rule on what the push sends, and a green run of what it needs recorded on HEAD's tree with nothing
 * uncommitted. Taken where the shell stands (the input's `cwd`, which an earlier `cd` moved) and in the checkout of the
 * project the config was found in, without push-check's fetch (no hook makes a network call; a lazy fetch, a transport
 * and the network-reaching verifiers are off too, NO_TRANSPORT and READ_ONLY_CONFIG): behind and ahead are read against the last fetch,
 * so a remote moved back since then is not seen (a stated limit). That asks git, so it runs in a child stopped at DECIDE_MS;
 * anything that fails, does not finish or prints what it cannot read asks.
 * @param {string} project the session's folder @param {unknown} shell the input's cwd @param {string} command
 * @returns {Promise<string | null>}
 */
async function waits(project, shell, command) {
  try {
    const { spawnSync } = await import("node:child_process");
    const module = new URL("../../../checks/push-mode.mjs", import.meta.url).href;
    if (typeof shell !== "string" || shell === "") return await text("pushSpellings.ask", { why: await text("push.modeElsewhere", { cwd: "?" }) });
    const bare = /^[ \t\n]*git push[ \t\n]*$/.test(command);
    const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...NO_TRANSPORT, ...withConfig(process.env, READ_ONLY_CONFIG) };
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { hookVerdict } = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(hookVerdict(process.cwd(), process.env, { project: ${JSON.stringify(project)}, bare: ${bare} })));`], { cwd: shell, encoding: "utf8", timeout: DECIDE_MS, killSignal: "SIGKILL", env });
    if (run.status !== 0) return PLAIN_ASK;
    /** @type {{ ok: unknown, lines: unknown }} */
    const push = JSON.parse(run.stdout);
    if (!Array.isArray(push.lines) || !push.lines.every((l) => typeof l === "string")) return PLAIN_ASK;
    if (push.ok === true && bare) return null;
    const why = push.ok === true ? [await text("pushSpellings.notBare")] : push.lines;
    return await text("pushSpellings.ask", { why: why.join(" ") });
  } catch {
    return PLAIN_ASK;
  }
}

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
  /** @type {string | null} */
  let refused = null;
  let left = false;
  let read = typeof command === "string";
  if (read) {
    try {
      ({ refused, left } = pushReading(command, process.env));
    } catch {
      read = false;
    }
  }
  if (read && refused === null) {
    // A push left in a subagent is refused, never asked: Claude Code 2.1.330 routes a subagent's ask to the session's
    // prompt, where it waits with nobody there. Claude Code names a subagent with agent_id, absent on the main thread,
    // where the closing's push runs.
    if (left && inSubagent(input)) {
      const reason = await text("pushSpellings.subagent").catch(() => PLAIN_SUBAGENT);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
      return;
    }
    const ask = left ? await waits(projectDir, input?.cwd, /** @type {string} */ (command)) : null;
    if (ask === null) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: ask } }));
    return;
  }
  if (!read) {
    process.stdout.write(JSON.stringify({ systemMessage: await text("pushSpellings.unread") }));
    return;
  }
  // Cut: what the refusal names may be long. t escapes what a line cannot hold. In a subagent the plain push the main
  // thread's refusal advises is refused too: that reason gives the fetch form a lab's upstream takes instead.
  const named = { command: /** @type {string} */ (refused).slice(0, 200) };
  const reason = inSubagent(input)
    ? await text("pushSpellings.refusedSubagent", named).catch(() => PLAIN_SUBAGENT)
    : await text("pushSpellings.refused", named).catch(() => PLAIN_REFUSAL);
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
