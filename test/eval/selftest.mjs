/**
 * The eval checks' self-test: every check of test/eval/checks.mjs proven on its passing and failing references by
 * the machine's `claude plugin eval` itself, with no model call, before any paid run. Each reference is one case of
 * a plugin that holds nothing else (no hook, skill or server), graded by every check that names it; a stand-in for
 * the model on 127.0.0.1 answers each turn of the case's conversation from REFERENCES (a tool call a turn, then the
 * text), by the reference the prompt names and the turn its messages have reached. The eval tool's JSON report gives
 * each grader's verdict and the grader as it read the file; both go into the record.
 *
 * No command runs: the eval tool's run is in dontAsk mode, and Bash is granted only for commands that start with
 * NEVER, which none of CALLS does, so Claude Code refuses every call but the read-only ones of ALLOWED; the eval tool
 * starts an allowed Bash call under its own sandbox-exec, which cannot start inside the self-test's, so only the Glob
 * runs, in the run's own empty directory. The record holds what became of each call, from the run's trace, and fails
 * where that moves. The run is what runPlan builds: a key that is no key of Anthropic's; the run's own home, config
 * and temporary directories; an environment of PATH and those alone; publishing, scaffolds and real servers off; and
 * the whole eval under macOS's sandbox-exec (NO_NETWORK): no connection but to the stand-in's port, no local socket
 * and no write but in the recorder's own directory and the eval tool's run directories (/private/tmp/e-*; writes in
 * /dev too), so no name lookup either. Before each run a canary under the same profile must fail to reach a
 * documentation address (192.0.2.1) and to look a name up, and reach the stand-in. The eval tool makes its run
 * directories in /tmp whatever TMPDIR says (2.1.310, macOS); the ones that are new after the run, however it ended,
 * are removed. Not measured: a managed policy on the machine, and a process that outlives the run's kill. Without
 * sandbox-exec (Linux, Windows) nothing is recorded or checked, and `check` fails saying so.
 *
 * The git run, its own command and record (GIT_RECORD), never part of `check` or `record`: whether git commits and
 * pushes in an arm, which the eval tool's own sandbox decides (test/eval/git-path.mjs says why it fails by name). That
 * sandbox cannot start inside the self-test's, nor inside any profile with a filtered rule (measured with six one-rule
 * profiles; one that denies every connection lets it start but shuts out the stand-in too), so the git run has no outer
 * profile: gitRunPlan, the same environment with the git path first on PATH and HTTP and HTTPS proxies pointed at a
 * dead port (127.0.0.1:9), scaffolds on (each git cell's scaffold makes a work repository and a bare remote in the
 * run's cwd, outside the sandbox) and Bash granted. Its network: the arms' Bash is under the eval tool's sandbox with no
 * domain allowed, and the canary case must find it shut; Claude Code itself talks to the stand-in (nonessential
 * traffic, telemetry, error reports and the updater off, no publishing), its HTTP clients that honour a proxy reach
 * none, and a watch of the eval's process tree (lsof every 250 ms) fails the run on a connection past loopback, after
 * it has seen one to the stand-in. Measured as unseen by the watch (security review): 10 of 10 TCP connections of about
 * 5 ms, a grandchild that daemonizes, and a UDP sendto with no connect; a name lookup through mDNSResponder is unseen by
 * reasoning, not measured (eval-git-run-network). Stopped by SIGINT, SIGTERM or SIGHUP, the git run kills the eval's
 * tree and removes what it made before it dies of the signal. The cells are GIT_CELLS:
 * the arm's commit and push with the git path (each call's exit and whether the push landed, read from the ref files
 * of the run directory the eval tool kept, where no git is run), the same calls with the git path taken out of PATH
 * (whether it landed: a landing is a note, since it hangs on the machine's git as much as on Claude Code), two that
 * must read as denied, and a gap. Denied: the arm's Bash read of a canary file the recorder writes in the operator's
 * real home for the run and removes after (the eval is given that home as HOME, which its sandbox shuts to the arms'
 * Bash; a pass needs cat's refusal shown), and the instructions: no request the stand-in gets carries a marker the
 * recorder plants in the eval's own configuration (CLAUDE.md, rules, auto memory) or in a stand-in home a second eval
 * is given as HOME (.claude's CLAUDE.md and rules, auto memory, a settings env value, a settings grant of Read on every
 * path, settings hooks that log or echo, a .claude.json server): the arm's environment printed and its Read of the
 * stand-in home's canary go into the requests, and neither program runs; a plain Claude Code given the same places
 * must carry them (the controls). The gap: a third eval, its --allow-tools granting Read every path, whose arm's Read
 * reads the canary (2.1.310, 2.1.330): the sandbox holds Bash only. The eval's --allow-tools is what opens the home:
 * its path rule reaches every arm of that eval, whatever a case's allowed_tools says, and a path rule in a case's
 * allowed_tools reaches none (2.1.310); while the gap stands, a plugin-eval run must pass --allow-tools no path rule
 * for Read, Glob or Grep. What the layout leaves open: Bash reads outside HOME and its parent folder (/Volumes, /opt,
 * other folders of the disk), and the eval process reads the operator's git configuration, the files its include.path
 * names among them, though nothing of it reaches a request.
 *
 *   node test/eval/selftest.mjs check [--claude <bin>]                  exit 1 when a verdict, a grader's reading or a call's fate moved,
 *                                                                       or an eval cut off mid-run leaves a run directory or a process
 *   node test/eval/selftest.mjs record [--claude <bin>] [--new-version]  take the record again (another Claude Code: --new-version)
 *   node test/eval/selftest.mjs git [--record] [--claude <bin>] [--new-version]
 *                                                                       the git run: exit 1 when a git or gap cell moved; --record takes its record
 * The binary is `--claude`, else `claude` on PATH; `npm run test:reference` runs `check` through test/reference/claude.mjs,
 * which hands `--claude` to this and to claude-code.mjs alike.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CALLS, CHECKS, NEVER, REFERENCES, SUBAGENTS, fateOf, graderFile, traceCalls } from "./checks.mjs";
import { realGit, shq, writeGitPath } from "./git-path.mjs";
import { claudeBinary, safePath, versionOf } from "../reference/claude-bin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "selftest.json");
/** The git run's record. */
export const GIT_RECORD = join(HERE, "git-cell.json");

/**
 * @typedef {{ claudeCode: string, graders: Record<string, Record<string, unknown>>, said: Record<string, string>, runs: Record<string, Record<string, boolean>>, calls: Record<string, string[]> }} Recorded
 *   `graders`: each check's grader as the eval tool read it (`type` and its report's `config`); `said`: what the
 *   stand-in said in each reference (saidOf), so a reference edited after the record is seen; `runs`: each
 *   reference's verdicts, by the checks that name it; `calls`: what became of each call of a reference that makes
 *   one: `refused` (in the run's permission_denials), `unstarted` (let through, and its result is sandbox-exec's
 *   refusal to start) or `ran`
 */

/** Each reference some check names, with those checks, in the order of REFERENCES. */
export function plan() {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const ref of Object.keys(REFERENCES)) {
    const by = Object.entries(CHECKS).filter(([, c]) => c.pass.includes(ref) || c.fail.includes(ref)).map(([id]) => id);
    if (by.length) out.set(ref, by);
  }
  return out;
}

/** What the stand-in says in a reference, its calls' tools and inputs and its text, as a digest. @param {string} ref */
export function saidOf(ref) {
  const { calls, text } = REFERENCES[ref];
  return createHash("sha256").update(JSON.stringify({ calls: calls.map((k) => CALLS[k]), text })).digest("hex").slice(0, 16);
}

/** The verdict a check must get on a reference: its side (`pass` or `fail`), the other one where `limits` lists it. @param {string} check @param {string} ref */
export function expected(check, ref) {
  const c = CHECKS[check];
  return c.pass.includes(ref) !== Boolean(c.limits && ref in c.limits);
}

/**
 * Where the record and the checks part: a grader read otherwise than written, a verdict other than the one its
 * check must get, a call whose fate is not the one fateOf gives, a reference or check
 * missing from either side.
 * @param {Recorded} rec @returns {string[]}
 */
export function problems(rec) {
  const out = [];
  for (const [id, c] of Object.entries(CHECKS)) {
    if (JSON.stringify(rec.graders[id]) !== JSON.stringify(c.grader)) out.push(`${id}: the eval tool read the grader as ${JSON.stringify(rec.graders[id])}, written ${JSON.stringify(c.grader)}`);
  }
  for (const id of Object.keys(rec.graders)) if (!(id in CHECKS)) out.push(`${id}: recorded, no such check`);
  const want = plan();
  for (const [ref, checks] of want) {
    const got = rec.runs[ref];
    if (rec.said[ref] !== saidOf(ref)) out.push(`${ref}: the reference changed since the record`);
    if (!got) {
      out.push(`${ref}: not recorded`);
      continue;
    }
    for (const id of checks) {
      if (!(id in got)) out.push(`${ref}: ${id} not recorded`);
      else if (got[id] !== expected(id, ref)) out.push(`${ref}: ${id} ${got[id] ? "passed" : "failed"}, must ${expected(id, ref) ? "pass" : "fail"}${CHECKS[id].limits?.[ref] ? ` (limit: ${CHECKS[id].limits?.[ref]})` : ""}`);
    }
    for (const id of Object.keys(got)) if (!checks.includes(id)) out.push(`${ref}: ${id} recorded, the check does not name it`);
    const fates = traceCalls(ref).map(fateOf);
    if (JSON.stringify(rec.calls[ref] ?? []) !== JSON.stringify(fates)) out.push(`${ref}: calls ${JSON.stringify(rec.calls[ref] ?? [])}, must be ${JSON.stringify(fates)} (ALLOWED names the calls let through)`);
  }
  for (const ref of new Set([...Object.keys(rec.said), ...Object.keys(rec.runs), ...Object.keys(rec.calls)])) if (!want.has(ref)) out.push(`${ref}: recorded, no check names it`);
  return out;
}

/** The record as written: a line a grader and a reference, so a diff shows what moved. @param {Recorded} rec */
export function recordText(rec) {
  const lines = (/** @type {Record<string, unknown>} */ o) => Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
  return `{\n  "claudeCode": ${JSON.stringify(rec.claudeCode)},\n  "graders": {\n${lines(rec.graders)}\n  },\n  "said": {\n${lines(rec.said)}\n  },\n  "runs": {\n${lines(rec.runs)}\n  },\n  "calls": {\n${lines(rec.calls)}\n  }\n}\n`;
}

/** @returns {Recorded} */
export function readRecord(path = RECORD) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------------------------------------
// Recording: the machine's `claude plugin eval`, run here only.

const KEY = "sk-ant-stand-in-000000000000000000000000";
export const SANDBOX = "/usr/bin/sandbox-exec";
const PROMPT = /selftest (reference|subagent|git) ([\w:.-]+)/;
/** The address the canary tries: TEST-NET-1 (RFC 5737), routed nowhere. */
const CANARY_ADDRESS = "192.0.2.1";

/**
 * The sandbox profile the whole eval runs under: every network connection refused but to the stand-in's port; local
 * sockets and writes only in the recorder's own directory and the eval tool's run directories (and writes in /dev),
 * so no other program's socket is reached, the name service's neither, and no write lands elsewhere.
 * @param {number} port @param {string} root the recorder's directory, its real path
 */
export function NO_NETWORK(port, root) {
  const own = `(subpath ${JSON.stringify(root)}) (regex #"^/private/tmp/e-[A-Za-z0-9]+(/|$)")`;
  return `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))(allow network-outbound (remote unix-socket (require-any ${own})))(deny file-write* (require-not (require-any ${own} (subpath "/dev"))))`;
}

/**
 * The stand-in for the model. A request with tools is a turn of a conversation: its first message names the reference
 * (a case's), the subagent (an Agent call's prompt) or the git run's case, the assistant messages before it count the
 * turn; the turn gets that script's call of that turn (a git case's is a Bash call of its command), or its text. Any
 * other request gets text. `served` counts, by script (`reference <name>`, `subagent <name>`, `git <name>`), the calls
 * and texts given; a git case's script is one of `git` (gitCases). `hold`: a turn of a case is never answered, so every
 * run is in flight when the eval is cut, and stays so until it is killed: closing takes no new connection, and only
 * `drop` ends the ones held. `markers`: words by name; `seen` holds the name of each one some request's body carried,
 * whatever the request (the model's system prompt, messages and tools are all in it).
 * @param {boolean} [hold] @param {Record<string, { calls: (string | { name: string, input: object })[], text: string }>} [git] @param {Record<string, string>} [markers]
 * @returns {Promise<{ port: number, served: Map<string, { calls: number, texts: number }>, seen: Set<string>, close: () => void, drop: () => void }>}
 */
function standIn(hold = false, git = {}, markers = {}) {
  /** @type {Map<string, { calls: number, texts: number }>} */
  const served = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      for (const [name, word] of Object.entries(markers)) if (body.includes(word)) seen.add(name);
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      /** @type {any} */
      let json = {};
      try {
        json = JSON.parse(body);
      } catch {}
      const messages = Array.isArray(json.messages) ? json.messages : [];
      const named = Array.isArray(json.tools) && json.tools.length ? PROMPT.exec(JSON.stringify(messages[0] ?? "")) : null;
      const ref = named ? `${named[1]} ${named[2]}` : undefined;
      const script = !named ? undefined : named[1] === "reference" ? REFERENCES[named[2]] : named[1] === "git" ? git[named[2]] : SUBAGENTS[named[2]];
      if (hold && script) return;
      const turn = messages.filter((/** @type {any} */ m) => m?.role === "assistant").length;
      const usage = { input_tokens: 1, output_tokens: 1 };
      /** A message of one block: a tool call (`input` given) or text. @param {string} stop @param {object} block @param {object} [input] */
      const say = (stop, block, input) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = input ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: /** @type {any} */ (block).text };
        const events = [
          ["message_start", { message: { id: `msg_selftest_${turn}`, type: "message", role: "assistant", model: json.model ?? "stand-in", content: [], stop_reason: null, stop_sequence: null, usage } }],
          ["content_block_start", { index: 0, content_block: input ? block : { ...block, text: "" } }],
          ["content_block_delta", { index: 0, delta }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage }],
          ["message_stop", {}],
        ];
        for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(/** @type {object} */ (data)) })}\n\n`);
        res.end();
      };
      if (script && ref !== undefined) {
        const n = served.get(ref) ?? { calls: 0, texts: 0 };
        served.set(ref, n);
        if (turn < script.calls.length) {
          n.calls++;
          const k = script.calls[turn];
          const call = named?.[1] !== "git" ? CALLS[/** @type {string} */ (k)] : typeof k === "string" ? { name: "Bash", input: { command: k, description: "selftest" } } : k;
          return say("tool_use", { type: "tool_use", id: `toolu_selftest_${ref.replace(/\W/g, "_")}_${turn}`, name: call.name, input: {} }, call.input);
        }
        n.texts++;
        return say("end_turn", { type: "text", text: script.text });
      }
      say("end_turn", { type: "text", text: "Done." });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, served, seen, close: () => server.close(), drop: () => server.closeAllConnections() });
    });
  });
}

/**
 * The eval's run: the program, its arguments and its environment, built from nothing but PATH.
 * @param {{ bin: string, port: number, root: string, plugin: string, report: string }} o
 */
export function runPlan({ bin, port, root, plugin, report }) {
  const args = ["-p", NO_NETWORK(port, root), bin, "plugin", "eval", plugin, "--no-publish", "--no-scaffold", "--mocks", "record", "--json", report, "--report", join(dirname(report), "report.html"), "--output-dir", join(dirname(report), "results"), "--runs", "1", "--ablation", "none", "--threshold", "0", "--trust-plugin", "--allow-tools", `Bash(${NEVER}:*)`, "--keep-temp", "-j", "4"];
  const env = {
    PATH: safePath(),
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    CLAUDE_CODE_TMPDIR: join(root, "tmp"),
    CLAUDE_CONFIG_DIR: join(root, "cfg"),
    XDG_RUNTIME_DIR: join(root, "run"),
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { file: SANDBOX, args, env };
}

/**
 * The files of the plugin under test, by path: a manifest and one case a reference (an index for a name, since two
 * references may differ only in case), each graded by the checks that name it.
 * @param {Map<string, string[]>} work @returns {{ files: Record<string, string>, cases: Map<string, string> }}
 */
export function pluginFiles(work) {
  /** @type {Record<string, string>} */
  const files = { ".claude-plugin/plugin.json": JSON.stringify({ name: "en-selftest", version: "0.0.0" }) };
  /** @type {Map<string, string>} */
  const cases = new Map();
  for (const [ref, checks] of work) {
    const name = `r${String(cases.size).padStart(3, "0")}`;
    cases.set(name, ref);
    files[`evals/${name}/prompt.md`] = `---\nmax_turns: ${REFERENCES[ref].calls.length + 3}\nruns: 1\nallowed_tools: ["Read", "Glob", "Agent", "Bash(${NEVER}:*)"]\n---\n\nselftest reference ${ref}\n`;
    for (const id of checks) files[`evals/${name}/graders/${id}.md`] = graderFile(CHECKS[id].grader);
  }
  return { files, cases };
}

/**
 * What the canary must find under the profile: the documentation address refused, a name lookup failing both ways
 * (the system's resolver and a direct DNS query), the stand-in reached (`standIn`; an arm's canary need not reach it).
 * @param {Record<string, string>} got @param {boolean} [standIn] @returns {string[]}
 */
export function canaryProblems(got, standIn = true) {
  const out = [];
  if (got.remote !== "EPERM") out.push(`a connection to ${CANARY_ADDRESS} was not refused (${got.remote})`);
  for (const k of ["lookup", "resolve"]) if (got[k] === undefined || got[k] === "resolved") out.push(`a name was looked up (${k}: ${got[k]})`);
  if (standIn && got.local !== "connected") out.push(`the stand-in was not reached (${got.local})`);
  return out;
}

/** The canary's script: each answer as an error code, or `connected` / `resolved`. */
const CANARY = `
const net = require("node:net"), dns = require("node:dns");
const tryConnect = (o) => new Promise((r) => { const s = net.connect(o); const t = setTimeout(() => (s.destroy(), r("timeout")), 3000); s.on("connect", () => (clearTimeout(t), s.destroy(), r("connected"))); s.on("error", (e) => (clearTimeout(t), r(e.code || String(e)))); });
(async () => process.stdout.write(JSON.stringify({
  remote: await tryConnect({ host: "${CANARY_ADDRESS}", port: 443 }),
  lookup: await new Promise((r) => dns.lookup("example.com", (e) => r(e ? e.code : "resolved"))),
  resolve: await new Promise((r) => dns.resolve4("example.com", (e) => r(e ? e.code : "resolved"))),
  local: await tryConnect({ host: "127.0.0.1", port: Number(process.argv[1]) }),
})))();
`;

/** The canary run under the profile. @param {number} port @param {string} root @returns {Record<string, string>} */
function canary(port, root) {
  const out = execFileSync(SANDBOX, ["-p", NO_NETWORK(port, root), process.execPath, "-e", CANARY, String(port)], { encoding: "utf8", env: { PATH: safePath() }, timeout: 30_000, killSignal: "SIGKILL" });
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------------------------------------
// The git run: its own command, with no outer profile (see the head of this file).

/** What the scaffold makes in the run's cwd, outside the sandbox: a work repository on main with an identity, and a bare remote, both with ref files. */
const SCAFFOLD = ["set -e", "git init -q --bare --ref-format=files remote.git", "git init -q -b main --ref-format=files work", "git -C work config user.name selftest", "git -C work config user.email selftest@example.com", "git -C work remote add origin ../remote.git", ""].join("\n");
const GIT_CALLS = ["git -C work commit -q --allow-empty -m selftest", "git -C work push -q origin HEAD:refs/heads/main"];

/**
 * The git run's cells, each a case (gitCases builds its calls): `land`, the arm's commit and push with the git path,
 * which must exit 0 and land; `note`, the same without it, whose landing is said and never fails (it hangs on where the
 * machine's git keeps its credential helpers as much as on Claude Code); `deny`, what an arm must not get, which must
 * read as `denied` (`says` what it means when it does not); `gap`, a reading that names the open node which would
 * close it, recorded so a move either way shows.
 * @type {Record<string, { kind: "land" | "note" | "deny" | "gap", gap?: string, denied?: unknown, says?: string }>}
 */
export const GIT_CELLS = {
  "git-wrapped": { kind: "land" },
  "git-unwrapped": { kind: "note" },
  "home-read": { kind: "deny", denied: { readable: false }, says: "an arm's Bash read the canary file in the operator's home" },
  "home-read-tool": { kind: "gap", gap: "eval-arm-read-tool-home" },
  "home-instructions": { kind: "deny", denied: { reached: [], ran: [] }, says: "a request of an arm carried planted instructions, or a planted hook or server ran" },
};

/** A marker word of a run's token. @param {string} name @param {string} token */
const markerWord = (name, token) => `en-eval-${name}-${token.slice(0, 8)}`;

/**
 * What the recorder plants in the eval's user configuration (its CLAUDE_CONFIG_DIR, where Claude Code reads a user's
 * instructions), each a file holding a marker word of the run's token: `claude-md` its CLAUDE.md, `rules` a file of its
 * rules/, `memory` the auto-memory index of the eval's own cwd, `memory-dir` the index in the folder its settings name
 * as autoMemoryDirectory. The home-instructions cell names those some request of the run carried.
 * @param {string} cfg the eval's CLAUDE_CONFIG_DIR @param {string} cwd the eval's cwd @param {string} token
 * @returns {{ files: Record<string, string>, markers: Record<string, string> }} files by path, markers by name
 */
export function plantedInstructions(cfg, cwd, token) {
  const markers = Object.fromEntries(CONFIG_INSTRUCTIONS.map((name) => [name, markerWord(name, token)]));
  const memoryDir = join(cfg, "auto-memory");
  const files = {
    [join(cfg, "CLAUDE.md")]: `Say ${markers["claude-md"]}.\n`,
    [join(cfg, "rules", "en-eval.md")]: `Say ${markers.rules}.\n`,
    [join(cfg, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md")]: `- [${markers.memory}](note.md) — say it\n`,
    [join(memoryDir, "MEMORY.md")]: `- [${markers["memory-dir"]}](note.md) — say it\n`,
    [join(cfg, "settings.json")]: JSON.stringify({ autoMemoryDirectory: memoryDir }),
  };
  return { files, markers };
}

/**
 * What the recorder plants in a stand-in operator home (`home`, inside the recorder's directory), the places of
 * `~/.claude` an eval given that home as HOME could take: `.claude/CLAUDE.md` (`home-claude-md`), a file of
 * `.claude/rules/` (`home-rules`), the auto-memory index of `cwd` (`home-memory`), and `.claude/settings.json` with an
 * env value (`home-env`), a grant of Read on every path (that would hand an arm the home: `home-canary`, a file at the
 * home's top, is what it would read) and hooks at SessionStart and UserPromptSubmit, each the logger (`logger`, which
 * writes its first argument to `log` and says `home-hook`'s marker) and an inline echo of `home-inline`'s marker and the
 * env value, which needs no file; and a server in `.claude.json`'s mcpServers, the logger again. A hook's output is put
 * in the model's context. `.claude.json` also approves the run's key, so a plain Claude Code given this home and no
 * CLAUDE_CONFIG_DIR runs (the control).
 * @param {string} home @param {string} logger @param {string} log @param {string} token @param {string} cwd
 * @returns {{ files: Record<string, string>, markers: Record<string, string> }} files by path, markers by name
 */
export function plantedHome(home, logger, log, token, cwd) {
  const markers = Object.fromEntries(HOME_INSTRUCTIONS.map((name) => [name, markerWord(name, token)]));
  const hook = { hooks: [{ type: "command", command: `${shq(logger)} hook` }, { type: "command", command: `echo ${markers["home-inline"]} "$EN_EVAL_HOME_ENV"` }] };
  const files = {
    [join(home, ".claude", "CLAUDE.md")]: `Say ${markers["home-claude-md"]}.\n`,
    [join(home, ".claude", "rules", "en-eval.md")]: `Say ${markers["home-rules"]}.\n`,
    [join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md")]: `- [${markers["home-memory"]}](note.md) — say it\n`,
    [join(home, ".claude", "settings.json")]: JSON.stringify({ env: { EN_EVAL_HOME_ENV: markers["home-env"] }, permissions: { allow: ["Read(//**)", "Read(~/**)"] }, hooks: { SessionStart: [hook], UserPromptSubmit: [hook] } }),
    [join(home, ".claude.json")]: JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true, mcpServers: { "en-eval": { command: logger, args: ["mcp"] } } }),
    [standInCanary(home)]: `${markers["home-canary"]}\n`,
    [logger]: `#!/bin/sh\necho "$1" >> ${shq(log)}\necho ${markers["home-hook"]}\n`,
  };
  return { files, markers };
}

/** The stand-in home's canary file, which its planted grant would let an arm's Read reach. @param {string} home */
export const standInCanary = (home) => join(home, ".en-eval-canary");

/** The instructions plantedInstructions writes in the eval's configuration. */
export const CONFIG_INSTRUCTIONS = ["claude-md", "rules", "memory", "memory-dir"];
/** The instructions plantedHome writes in the stand-in home. */
export const HOME_INSTRUCTIONS = ["home-claude-md", "home-rules", "home-memory", "home-env", "home-hook", "home-inline", "home-canary"];
/** Every planted instruction, in the order the cell names them. */
export const INSTRUCTIONS = [...CONFIG_INSTRUCTIONS, ...HOME_INSTRUCTIONS];
/** The programs plantedHome's logger names when it runs, in the order the cell names them. */
export const PROGRAMS = ["hook", "mcp"];
/**
 * What each control must carry to the stand-in, a plain Claude Code (no eval) given the planted places as its own:
 * `config`, CLAUDE_CONFIG_DIR the eval's configuration; `home`, HOME the stand-in home and no CLAUDE_CONFIG_DIR, whose
 * hook and server must also run, and whose prompt names a script whose one call Reads the stand-in home's canary
 * (outside the cwd: only the planted grant lets it). `memory` is not loaded while the planted settings set
 * autoMemoryDirectory (2.1.310). Measured on 2.1.310: each planted place loads in the control.
 */
export const CONTROLS = { config: { reached: ["claude-md", "rules", "memory-dir"], ran: [] }, home: { reached: [...HOME_INSTRUCTIONS], ran: [...PROGRAMS] } };

/**
 * Every case of the git run, by name, its calls built for this run: the arms' canary (CANARY by the arm's own Bash and
 * node; its port is never read there), the git cells (git-unwrapped's calls take the git path out of PATH by its
 * value first), the home read by Bash (the canary file's text, or cat's refusal and "denied") and by the Read tool
 * (the gap: the eval tool's sandbox holds Bash only, and its eval's grant gives Read every path), and the instructions
 * case, whose prompt is what shows the stand-in read its requests, whose arm prints its environment (a planted env
 * value must not be in it) and Reads the stand-in home's canary (the planted grant must not let it). Alone in its eval,
 * a case's first call waits, so the socket watch sees its eval reach the stand-in (a case with no call ended before
 * the watch's first look, 2.1.310). A call is a Bash command, or a tool call by name; every case allows Bash only, which
 * keeps no tool from an arm: what a case's allowed_tools says reaches no grant (2.1.310), the eval's --allow-tools does.
 * @param {{ gitPath: string, homeFile: string, standInCanary: string }} o
 * @returns {Record<string, GitCase>}
 */
/** @typedef {{ scaffold: string, calls: (string | { name: string, input: Record<string, unknown> })[], text: string }} GitCase */

/**
 * The git run's evals, in order: the cases each runs, its HOME (the operator's, or the stand-in home) and its
 * --allow-tools. Only the Read tool's gap case runs under a path grant, since the eval's grant reaches every arm of it.
 * @type {{ cases: string[], home: "operator" | "stand-in", allow: string }[]}
 */
export const EVALS = [
  { cases: ["git-net", "git-wrapped", "git-unwrapped", "home-read"], home: "operator", allow: "Bash" },
  { cases: ["home-instructions"], home: "stand-in", allow: "Bash" },
  { cases: ["home-read-tool"], home: "operator", allow: "Bash,Read(//**)" },
];

export function gitCases({ gitPath, homeFile, standInCanary }) {
  const strip = `PATH="$(printf %s "$PATH" | tr : '\\n' | grep -vxF ${shq(gitPath)} | paste -sd: -)"; `;
  return {
    "git-net": { scaffold: "", calls: [`node -e ${shq(CANARY)} 1`], text: "Done." },
    "git-wrapped": { scaffold: SCAFFOLD, calls: GIT_CALLS, text: "Done." },
    "git-unwrapped": { scaffold: SCAFFOLD, calls: GIT_CALLS.map((c) => strip + c), text: "Done." },
    "home-read": { scaffold: "", calls: [`cat ${shq(homeFile)} 2>&1 || echo denied`], text: "Done." },
    "home-read-tool": { scaffold: "", calls: ["sleep 2", { name: "Read", input: { file_path: homeFile } }], text: "Done." },
    "home-instructions": { scaffold: "", calls: ["sleep 2; env", { name: "Read", input: { file_path: standInCanary } }], text: "Done." },
  };
}

/**
 * Where a git run parts from what its cells show: the land cell's every call (one each of GIT_CALLS) exited 0 and its
 * push landed; a deny cell reads as denied. A note or gap cell is not judged. A cell missing from either side.
 * @param {Record<string, any>} cells @returns {string[]}
 */
export function gitProblems(cells) {
  const out = [];
  for (const [cell, { kind, denied, says }] of Object.entries(GIT_CELLS)) {
    const got = cells[cell];
    if (!got) out.push(`${cell}: not recorded`);
    else if (kind === "land" && (!got.landed || got.exits.length !== GIT_CALLS.length || got.exits.some((/** @type {unknown} */ e) => e !== 0))) out.push(`${cell}: exits ${JSON.stringify(got.exits)}, landed ${got.landed}: the arms' git does not commit and push through the git path`);
    else if (kind === "deny" && JSON.stringify(got) !== JSON.stringify(denied)) out.push(`${cell}: ${JSON.stringify(got)}: ${says}`);
  }
  for (const cell of Object.keys(cells)) if (!(cell in GIT_CELLS)) out.push(`${cell}: recorded, no such git cell`);
  return out;
}

/**
 * A git run against its record: a land, deny or gap cell that moved fails (`fail`); the note cell only says (`notes`), and
 * whenever its push landed it says what that can mean.
 * @param {Record<string, any>} cells @param {Record<string, any> | undefined} old
 * @returns {{ fail: string[], notes: string[] }}
 */
export function gitMoves(cells, old) {
  /** @type {{ fail: string[], notes: string[] }} */
  const out = { fail: [], notes: [] };
  for (const [cell, { kind, gap }] of Object.entries(GIT_CELLS)) {
    if (kind === "note" && cells[cell]?.landed) out.notes.push(`${cell}: the push landed with no git path: Claude Code's credential-helper deny changed, or this git keeps its helpers outside the folders Claude Code scans (2.1.310: PATH and nine git-core folders); either way the git path is not needed here (eval-git-macos)`);
    if (JSON.stringify(cells[cell]) === JSON.stringify(old?.[cell])) continue;
    const line = `${cell}: the arm now gives ${JSON.stringify(cells[cell])}, recorded ${JSON.stringify(old?.[cell])}${gap ? ` (gap: ${gap})` : ""}`;
    (kind === "note" ? out.notes : out.fail).push(line);
  }
  return out;
}

/** @returns {{ claudeCode: string, cells: Record<string, any> }} */
export function readGitRecord(path = GIT_RECORD) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The git run: runPlan's environment with the git path first on PATH and the HTTP and HTTPS proxies at a dead port
 * (the stand-in, on 127.0.0.1, is no proxy's), under no outer profile, scaffolds run, Bash granted (the stand-in gives
 * no command but its cases'), `allow` its --allow-tools (Bash by default; the eval's grant reaches every arm of the
 * eval, whatever a case's allowed_tools says, 2.1.310). HOME is the operator's home (`home`): the eval tool's sandbox
 * denies its arms' Bash reads under the HOME it is given and its parent folder, and gives each arm and each scaffold a
 * HOME and config of its own (2.1.310), so the operator's home is shut to the arms' Bash. It holds Bash only: given a
 * path rule in --allow-tools, Read, Glob and Grep read that home (2.1.310, 2.1.330); without one dontAsk refuses them
 * outside the cwd, in either layout. Folders outside HOME's parent (/Volumes, /opt) stay open to Bash. CLAUDE_CONFIG_DIR stays the recorder's, so the eval reads and writes no file
 * of the operator's ~/.claude (with it unset, the eval writes its config backups there). The eval itself reads the
 * operator's git configuration (~/.gitconfig, ~/.config/git/config and the files their include.path names; measured
 * by access times, whether or not GIT_CONFIG_GLOBAL is set) and runs none of its programs; nothing of it reaches a
 * request.
 * @param {{ bin: string, port: number, root: string, plugin: string, report: string, gitPath: string, home: string, allow?: string }} o
 */
export function gitRunPlan({ bin, port, root, plugin, report, gitPath, home, allow = "Bash" }) {
  const { env } = runPlan({ bin, port, root, plugin, report });
  const args = ["plugin", "eval", plugin, "--no-publish", "--scaffold", "--mocks", "record", "--json", report, "--report", join(dirname(report), "report.html"), "--output-dir", join(dirname(report), "results"), "--runs", "1", "--ablation", "none", "--threshold", "0", "--trust-plugin", "--allow-tools", allow, "--keep-temp", "-j", "4"];
  return { file: bin, args, env: { ...env, HOME: home, PATH: `${gitPath}${delimiter}${env.PATH}`, HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, NO_PROXY: "127.0.0.1,localhost" } };
}

/** A proxy address nothing listens on. */
const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * The git run's plugin: a manifest and a case a git case, each in case.yaml (prompt.md takes no scaffold) with its
 * scaffold beside it and one grader the eval tool asks for.
 * @param {Record<string, { scaffold: string, calls: unknown[] }>} cases
 * @returns {{ files: Record<string, string>, cases: Map<string, string> }}
 */
export function gitPluginFiles(cases) {
  /** @type {Record<string, string>} */
  const files = { ".claude-plugin/plugin.json": JSON.stringify({ name: "en-selftest-git", version: "0.0.0" }) };
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const [cell, { scaffold, calls }] of Object.entries(cases)) {
    const name = `g${String(names.size).padStart(3, "0")}`;
    names.set(name, cell);
    const context = scaffold ? ["context:", '  scaffold_script: "scaffold.sh"'] : [];
    files[`evals/${name}/case.yaml`] = ['schema_version: "1.0"', `name: "${name}"`, ...context, "execution:", `  prompt: "selftest git ${cell}"`, `  max_turns: ${calls.length + 3}`, '  allowed_tools: ["Bash"]', "runs: 1", "graders:", '  - type: "regex"', '    name: "answered"', '    target: "last_message"', '    pattern: "Done"', '    match: "contains"', ""].join("\n");
    if (scaffold) files[`evals/${name}/scaffold.sh`] = scaffold;
  }
  return { files, cases: names };
}

/**
 * The cwd of the run a trace belongs to, in the run directory the eval tool kept (2.1.310: `<run>/out/trace.jsonl`,
 * the cwd in `<run>/sealed/home/cwd`, sealed mode 000), opened to its owner for reading; null for a trace not in a
 * run directory of `runRoot`. @param {string} tracePath @param {string} runRoot
 */
export function keptCwd(tracePath, runRoot) {
  const run = dirname(dirname(tracePath));
  if (dirname(run) !== runRoot || !RUN_DIR.test(basename(run))) return null;
  try {
    chmodSync(join(run, "sealed"), 0o500);
  } catch {}
  return join(run, "sealed", "home", "cwd");
}

/** A ref file's text: one object name and a newline, in a regular file; else null. @param {string} file */
function refAt(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 128) return null;
    const text = readFileSync(file, "utf8");
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Whether the scaffold's two repositories are in a cwd: each one's HEAD, a regular file. @param {string} cwd */
export function scaffolded(cwd) {
  return ["work/.git/HEAD", "remote.git/HEAD"].every((p) => {
    try {
      return lstatSync(join(cwd, p)).isFile();
    } catch {
      return false;
    }
  });
}

/** Whether the push landed: the remote's main is the work repository's main, both read as ref files. @param {string} cwd */
export function landedIn(cwd) {
  const work = refAt(join(cwd, "work", ".git", "refs", "heads", "main"));
  return work !== null && work === refAt(join(cwd, "remote.git", "refs", "heads", "main"));
}

/** A process and every process under it, from `ps -o pid=,ppid=` text. @param {number} root @param {string} text @returns {number[]} */
export function treeOf(root, text) {
  /** @type {Map<number, number[]>} */
  const kids = new Map();
  for (const line of text.split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p && pp >= 0) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  /** @type {number[]} */
  const all = [];
  /** @param {number} p */
  const walk = (p) => {
    all.push(p);
    for (const c of kids.get(p) ?? []) walk(c);
  };
  walk(root);
  return all;
}

/**
 * What `lsof -nP -i` text shows of a run's connections: those whose far end is no loopback address (`others`, a line
 * each, spaces folded), and whether one reaches the stand-in's port on 127.0.0.1 (`standIn`). A socket with no far end
 * (listening, or UDP not connected) is no connection. @param {string} text @param {number} port
 */
export function outboundOf(text, port) {
  const others = new Set();
  let standIn = false;
  for (const line of text.split("\n")) {
    const far = /->(\S+)(?:\s+\(\w+\))?\s*$/.exec(line)?.[1];
    if (!far) continue;
    if (far === `127.0.0.1:${port}`) standIn = true;
    else if (!/^(?:127\.\d+\.\d+\.\d+|\[::1\]):\d+$/.test(far)) others.add(line.replace(/\s+/g, " ").trim());
  }
  return { standIn, others: [...others].sort() };
}

/**
 * A watch of a process tree's connections: ps and lsof every `every` ms while the run lasts, each look waiting for the
 * last and cut at `lookMs` (what a cut look printed is not read). `stop` waits for a look under way for `stopMs` at
 * most, then gives up and says so (`stuck`). `ps`, `lsof` and their environment are given for a test.
 * @param {number | undefined} pid @param {number} port
 * @param {{ every?: number, lookMs?: number, stopMs?: number, ps?: string, lsof?: string, env?: Record<string, string | undefined> }} [o]
 * @returns {{ stop: () => Promise<{ others: string[], standIn: boolean, stuck: boolean }> }}
 */
export function watchSockets(pid, port, { every = 250, lookMs = 5000, stopMs = 15_000, ps = "/bin/ps", lsof = "/usr/sbin/lsof", env = {} } = {}) {
  const others = new Set();
  let standIn = false;
  let busy = false;
  const opts = { env, timeout: lookMs, killSignal: "SIGKILL" };
  const look = () => {
    if (busy || pid === undefined) return;
    busy = true;
    execFile(ps, ["-A", "-o", "pid=,ppid="], opts, (e, out) => {
      if (e) return void (busy = false);
      execFile(lsof, ["-nP", "-a", "-i", "-p", treeOf(pid, String(out)).join(",")], opts, (f, text) => {
        // lsof exits 1 when it finds nothing; a look cut at its limit is not read.
        if (!f?.killed) {
          const seen = outboundOf(String(text ?? ""), port);
          for (const o of seen.others) others.add(o);
          standIn ||= seen.standIn;
        }
        busy = false;
      });
    });
  };
  const timer = setInterval(look, every);
  look();
  return {
    stop: async () => {
      clearInterval(timer);
      const until = Date.now() + stopMs;
      while (busy && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      return { others: [...others].sort(), standIn, stuck: busy };
    },
  };
}

/**
 * The git run's cells: each one's reading, after the arms' canary found their network shut and the socket watch saw
 * no connection past loopback. The evals of EVALS, each as gitRunPlan builds it: the first and third given the
 * operator's home as HOME (`home`, the real one by default: os.userInfo, not HOME), in which a canary file named by the
 * run's token (`token`, random by default) lies while they run, the third alone granted a path rule; the second given
 * a stand-in home in the recorder's directory that holds plantedHome's files. The eval's own configuration holds
 * plantedInstructions' files in all. Then the controls:
 * a plain Claude Code (no eval) under the recorder's NO_NETWORK profile, once given that configuration and once that
 * home with no CLAUDE_CONFIG_DIR, must carry what CONTROLS names to a stand-in of its own, or nothing planted is shown
 * to load and the run cannot be recorded. Removed after, however it ended, as recordRuns removes its run; on SIGINT,
 * SIGTERM or SIGHUP the running tree is killed and what this run made (the canary if it wrote it, its folder, the run
 * directories) removed before the signal is raised again.
 * @param {string} bin
 * @param {{ spawnRun?: (file: string, args: string[], opts: object) => any, git?: (path: string) => string, home?: string, token?: string, watch?: (pid: number | undefined, port: number) => { stop: () => Promise<{ others: string[], standIn: boolean, stuck?: boolean }> }, hasSandbox?: () => boolean, stray?: typeof processesNaming, tmp?: string, runRoot?: string, timeoutMs?: number }} [o]
 * @returns {Promise<Record<string, any>>}
 */
export async function recordGit(bin, o = {}) {
  const { spawnRun = spawn, git = realGit, home = userInfo().homedir, token = randomBytes(16).toString("hex"), watch = watchSockets, hasSandbox = () => existsSync(SANDBOX), stray: running = processesNaming, tmp = existsSync("/tmp") ? "/tmp" : tmpdir(), runRoot = RUN_ROOT, timeoutMs = 10 * 60_000 } = o;
  if (!hasSandbox()) throw new NotMeasured(`not measured: no ${SANDBOX}; the git run is recorded on macOS`);
  const R = realpathSync(mkdtempSync(join(tmp, "en-pg-")));
  const homeFile = join(home, `.en-eval-home-${token.slice(0, 8)}`);
  const before = new Set(readdirSync(runRoot));
  const since = Date.now() - 1000;
  /** @type {Awaited<ReturnType<typeof standIn>> | undefined} */
  let server;
  /** @type {Awaited<ReturnType<typeof standIn>>[]} */
  const others = [];
  /** @type {unknown} */
  let failure;
  /** Whether this run wrote the canary: only then is it removed. */
  let wrote = false;
  /** @type {number | undefined} */
  let evalPid;
  const signals = /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
  /** @param {NodeJS.Signals} sig */
  const onSignal = (sig) => {
    for (const s of signals) process.off(s, onSignal);
    killTree(evalPid);
    for (const pid of running(R)) killTree(pid);
    for (const sv of [server, ...others]) sv?.close(), sv?.drop();
    if (wrote) rmSync(homeFile, { force: true });
    rmSync(R, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    for (const name of newRunDirs(runRoot, before, since)) unseal(join(runRoot, name));
    process.kill(process.pid, sig);
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    writeFileSync(homeFile, token, { flag: "wx", mode: 0o600 });
    wrote = true;
    const P = join(R, "plugin");
    const H = join(R, "oph");
    for (const d of ["cfg", "home", "tmp", "run", "work", "out", "out2", "out3", "bin", "oph"]) mkdirSync(join(R, d));
    // In the plugin: the eval tool lets the arms read it, and not write it.
    const gitPath = join(P, "git-path");
    const scripts = gitCases({ gitPath, homeFile, standInCanary: standInCanary(H) });
    /** @type {[string, Record<string, GitCase>][]} */
    const plugins = EVALS.map((e, i) => [i ? join(R, `plugin${i + 1}`) : P, Object.fromEntries(Object.entries(scripts).filter(([c]) => e.cases.includes(c)))]);
    /** @type {Map<string, string>[]} */
    const names = [];
    for (const [dir, some] of plugins) {
      const { files, cases } = gitPluginFiles(some);
      names.push(cases);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
    writeGitPath(gitPath, git(safePath()));
    writeFileSync(join(R, "cfg", ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true }));
    const log = join(R, "ran.log");
    const planted = [plantedInstructions(join(R, "cfg"), join(R, "work"), token), plantedHome(H, join(R, "bin", "log.sh"), log, token, join(R, "work"))];
    for (const [path, text] of planted.flatMap((p) => Object.entries(p.files))) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    chmodSync(join(R, "bin", "log.sh"), 0o755);
    const markers = Object.assign({}, ...planted.map((p) => p.markers));
    const logLines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    /** The programs the logger named in the log from its line `from` on, in PROGRAMS' order. */
    const ran = (from = 0) => {
      const lines = logLines().slice(from);
      return PROGRAMS.filter((name) => lines.includes(name));
    };
    // The instructions case's prompt, seen as the markers are: proof the stand-in read the requests' bodies.
    server = await standIn(false, scripts, { ...markers, [PROMPT_SEEN]: "selftest git home-instructions" });
    const port = server.port;
    /** @type {any[]} */
    const reports = [];
    const wrong = [];
    for (const [i, [plugin]] of plugins.entries()) {
      const report = join(R, `out${i ? i + 1 : ""}`, "report.json");
      const { file, args, env } = gitRunPlan({ bin, port, root: R, plugin, report, gitPath, home: EVALS[i].home === "stand-in" ? H : home, allow: EVALS[i].allow });
      /** @type {ReturnType<typeof watchSockets> | undefined} */
      let watcher;
      const run = await runEval(spawnRun, file, args, { cwd: join(R, "work"), env }, timeoutMs, (pid) => ((evalPid = pid), (watcher = watch(pid, port))));
      const seen = await watcher?.stop();
      const which = ["the git run", "the git run's stand-in home eval", "the git run's Read grant eval"][i];
      if (run.timedOut || run.code !== 0 || !existsSync(report)) throw new Error(`claude plugin eval (${which}) ${run.timedOut ? "ran out of time" : `exited ${run.code}`}: ${run.err.slice(-2000)}`);
      reports.push(JSON.parse(readFileSync(report, "utf8")));
      if (seen?.others.length) wrong.push(`the eval's processes opened connections past loopback (${which}):\n${seen.others.join("\n")}`);
      if (!seen?.standIn) wrong.push(`the socket watch saw no connection to the stand-in, so it did not see the run's sockets (${which})`);
      if (seen?.stuck) wrong.push(`the socket watch's last look did not end in time, so what it saw last is unread (${which})`);
    }
    const ranInEvals = ran();
    // The controls: each planted place, given to a plain Claude Code as its own, must load.
    const { env: base } = runPlan({ bin, port: 0, root: R, plugin: P, report: join(R, "out", "report.json") });
    for (const [name, want] of Object.entries(CONTROLS)) {
      const sv = await standIn(false, { "control-home": { calls: [{ name: "Read", input: { file_path: standInCanary(H) } }], text: "Done." } }, markers);
      others.push(sv);
      const { CLAUDE_CONFIG_DIR, ...rest } = { ...base, ANTHROPIC_BASE_URL: `http://127.0.0.1:${sv.port}` };
      const env = name === "home" ? { ...rest, HOME: H } : { ...rest, CLAUDE_CONFIG_DIR };
      const from = logLines().length;
      const run = await runEval(spawnRun, SANDBOX, ["-p", NO_NETWORK(sv.port, R), bin, "-p", name === "home" ? "selftest git control-home" : "selftest control", "--setting-sources", "user"], { cwd: join(R, "work"), env }, timeoutMs, (pid) => (evalPid = pid));
      const got = { reached: INSTRUCTIONS.filter((m) => sv.seen.has(m)), ran: ran(from) };
      sv.close();
      if (run.timedOut || run.code !== 0) wrong.push(`control ${name}: claude -p ${run.timedOut ? "ran out of time" : `exited ${run.code}`}: ${run.err.slice(-500)}`);
      else if (want.reached.some((m) => !got.reached.includes(m)) || want.ran.some((p) => !got.ran.includes(p))) wrong.push(`control ${name}: a plain Claude Code given the planted ${name === "home" ? "home" : "configuration"} carried ${JSON.stringify(got)}, must carry ${JSON.stringify(want)}: what is planted is not shown to load, so its absence in the arms says nothing`);
    }
    /** @type {Record<string, any>} */
    const got = {};
    /** The cases read, the canary's among them. */
    const read = new Set();
    for (const [i, json] of reports.entries()) {
      for (const c of json.cases ?? []) {
        const cell = names[i].get(c.name);
        if (cell === undefined) {
          wrong.push(`${c.name}: a case not written here`);
          continue;
        }
        const arm = c.arms?.with ?? [];
        const n = server.served.get(`git ${cell}`);
        const calls = scripts[cell].calls.length;
        if (arm.length !== 1 || arm[0].error !== null) wrong.push(`${cell}: ${arm.length} run(s), error ${JSON.stringify(arm[0]?.error)}`);
        else if (!n || n.calls !== calls || n.texts !== 1) wrong.push(`${cell}: the run did not follow the script (${n?.calls ?? 0} of ${calls} calls, ${n?.texts ?? 0} texts)`);
        else {
          const trace = readTrace(String(arm[0].tracePath));
          const id = trace.uses[0]?.id;
          const result = trace.results.get(id);
          const said = (result?.text ?? "").trim();
          if (trace.uses.length !== calls) wrong.push(`${cell}: the trace holds ${trace.uses.length} of ${calls} calls`);
          else if (cell === "git-net") {
            /** @type {Record<string, string> | undefined} */
            let net;
            try {
              net = JSON.parse(said);
            } catch {}
            if (!net || typeof net !== "object") wrong.push(`git-net: the arms' canary did not run: ${said.slice(0, 200)}`);
            else {
              read.add(cell);
              const open = canaryProblems(net, false);
              if (open.length) wrong.push(`the arms' network is not shut: ${open.join("; ")}`);
            }
          } else if (cell === "home-read") {
            // The token anywhere in the output: Claude Code may add a <sandbox_violations> block after it. Denied only
            // on the sandbox's own refusal of cat and the echo after it: an empty or other output measured nothing.
            if (said.includes(token)) (got[cell] = { readable: true }), read.add(cell);
            else if (/Operation not permitted/.test(said) && /^denied$/m.test(said)) (got[cell] = { readable: false }), read.add(cell);
            else wrong.push(`${cell}: the arm's read neither printed the canary nor showed the sandbox's refusal: ${JSON.stringify(said.slice(0, 200))}`);
          } else if (cell === "home-read-tool") {
            // Its Read is the case's last call (the first waits for the socket watch).
            const last = trace.uses[calls - 1]?.id;
            const text = (trace.results.get(last)?.text ?? "").trim();
            if (text.includes(token)) (got[cell] = { readable: true }), read.add(cell);
            else if (trace.refused.has(last) || trace.results.get(last)?.isError) (got[cell] = { readable: false }), read.add(cell);
            else wrong.push(`${cell}: the Read call neither gave the canary nor was refused: ${JSON.stringify(text.slice(0, 200))}`);
          } else if (cell === "home-instructions") {
            // The env and the Read must have run: their output goes into the next request, where the scan reads it.
            const second = trace.uses[1]?.id;
            const readText = trace.results.get(second)?.text ?? "";
            if (!server.seen.has(PROMPT_SEEN)) wrong.push(`${cell}: the stand-in did not see the case's prompt in a request, so it read no request's body`);
            else if (!/^HOME=/m.test(said)) wrong.push(`${cell}: the arm's env printed no environment: ${JSON.stringify(said.slice(0, 200))}`);
            else if (!(trace.refused.has(second) || trace.results.get(second)?.isError || readText.includes(markers["home-canary"]))) wrong.push(`${cell}: the arm's Read of the stand-in home's canary neither gave it nor was refused: ${JSON.stringify(readText.trim().slice(0, 200))}`);
            else (got[cell] = { reached: INSTRUCTIONS.filter((name) => server?.seen.has(name)), ran: ranInEvals }), read.add(cell);
          } else {
            const cwd = keptCwd(String(arm[0].tracePath), runRoot);
            if (cwd === null || !scaffolded(cwd)) wrong.push(`${cell}: no work repository and remote where the scaffold makes them (${cwd ?? arm[0].tracePath})`);
            else (got[cell] = GIT_CELLS[cell].kind === "land" ? { exits: exitsOf(trace), landed: landedIn(cwd) } : { landed: landedIn(cwd) }), read.add(cell);
          }
        }
      }
    }
    for (const cell of Object.keys(scripts)) if (!read.has(cell) && !wrong.some((w) => w.startsWith(`${cell}:`))) wrong.push(`${cell}: no case in the report`);
    if (wrong.length) throw new Error(`the git run cannot be recorded:\n${wrong.join("\n")}`);
    return Object.fromEntries(Object.keys(GIT_CELLS).map((cell) => [cell, got[cell]]));
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    for (const s of signals) process.off(s, onSignal);
    for (const sv of others) sv.close(), sv.drop();
    if (wrote) rmSync(homeFile, { force: true });
    await sweep({ R, server, failure, runRoot, before, since, running });
  }
}

/** The stand-in's name for the instructions case's prompt among the markers it looks for. */
const PROMPT_SEEN = "prompt";

/** The run directories' parent: the eval tool makes them in /tmp on macOS, whatever TMPDIR says (2.1.310). */
const RUN_ROOT = "/private/tmp";
/** A run directory's name, as the eval tool gives it. */
const RUN_DIR = /^e-[A-Za-z0-9]+$/;

/**
 * The run directories the eval tool made during a run: names it gives, owned by this user, not there before and made
 * since the run began. Another eval of this user's running at the same time would have its own counted too.
 * @param {string} root @param {Set<string>} before @param {number} since
 */
export function newRunDirs(root, before, since) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return readdirSync(root)
    .filter((name) => RUN_DIR.test(name) && !before.has(name))
    .filter((name) => {
      try {
        const st = lstatSync(join(root, name));
        return st.isDirectory() && (uid === undefined || st.uid === uid) && (st.birthtimeMs || st.ctimeMs) >= since;
      } catch {
        return false;
      }
    })
    .sort();
}

/** No sandbox-exec: nothing is recorded or checked here. */
export class NotMeasured extends Error {}

/**
 * The eval tool's verdicts on every reference, in a directory of its own, removed after with every run directory the
 * eval tool made, however the run ended. What it starts and checks can be given (a test does): the eval is spawned
 * only as runPlan builds it, after the canary.
 * @param {string} bin
 * `hold` and `settleMs` are for a cut run: the stand-in answers no turn, and after the sweep the recorder waits, then
 * fails on any process or run directory that came back.
 * @param {{ spawnRun?: (file: string, args: string[], opts: object) => any, runCanary?: typeof canary, version?: (bin: string) => string, hasSandbox?: () => boolean, stray?: typeof processesNaming, tmp?: string, runRoot?: string, timeoutMs?: number, hold?: boolean, settleMs?: number }} [o]
 * @returns {Promise<Recorded>}
 */
export async function recordRuns(bin, o = {}) {
  const { spawnRun = spawn, runCanary = canary, version = versionOf, hasSandbox = () => existsSync(SANDBOX), stray: running = processesNaming, tmp = existsSync("/tmp") ? "/tmp" : tmpdir(), runRoot = RUN_ROOT, timeoutMs = 20 * 60_000, hold = false, settleMs = 0 } = o;
  if (!hasSandbox()) throw new NotMeasured(`not measured: no ${SANDBOX}, so no run here can be shut off from the network (the self-test is recorded and checked on macOS)`);
  const claudeCode = version(bin);
  const work = plan();
  // Short: the eval tool keeps sockets under it.
  const R = realpathSync(mkdtempSync(join(tmp, "en-pe-")));
  const before = new Set(readdirSync(runRoot));
  const since = Date.now() - 1000;
  /** @type {Awaited<ReturnType<typeof standIn>> | undefined} */
  let server;
  /** @type {unknown} */
  let failure;
  try {
    const P = join(R, "plugin");
    for (const d of ["cfg", "home", "tmp", "run", "work", "out"]) mkdirSync(join(R, d));
    const { files, cases } = pluginFiles(work);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(P, path)), { recursive: true });
      writeFileSync(join(P, path), text);
    }
    writeFileSync(join(R, "cfg", ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true }));
    server = await standIn(hold);
    const shut = canaryProblems(runCanary(server.port, R));
    if (shut.length) throw new Error(`the sandbox profile does not shut the run off: ${shut.join("; ")}`);
    const report = join(R, "out", "report.json");
    const { file, args, env } = runPlan({ bin, port: server.port, root: R, plugin: P, report });
    const run = await runEval(spawnRun, file, args, { cwd: join(R, "work"), env }, timeoutMs);
    if (run.timedOut || run.code !== 0 || !existsSync(report)) throw new Error(`claude plugin eval ${run.timedOut ? "ran out of time" : `exited ${run.code}`}: ${run.err.slice(-2000)}`);
    const json = JSON.parse(readFileSync(report, "utf8"));
    /** @type {Recorded} */
    const rec = { claudeCode, graders: {}, said: Object.fromEntries([...work.keys()].map((ref) => [ref, saidOf(ref)])), runs: {}, calls: {} };
    const wrong = [];
    for (const c of json.cases ?? []) {
      const ref = cases.get(c.name);
      if (ref === undefined) {
        wrong.push(`${c.name}: a case not written here`);
        continue;
      }
      for (const g of c.graders ?? []) {
        const read = { type: g.type, ...g.config };
        const seen = rec.graders[g.name];
        if (seen && JSON.stringify(seen) !== JSON.stringify(read)) wrong.push(`${g.name}: read otherwise in ${ref}`);
        rec.graders[g.name] = read;
      }
      const arm = c.arms?.with ?? [];
      const n = server.served.get(`reference ${ref}`);
      const calls = REFERENCES[ref].calls.length;
      const traced = traceCalls(ref);
      if (arm.length !== 1 || arm[0].error !== null) wrong.push(`${ref}: ${arm.length} run(s), error ${JSON.stringify(arm[0]?.error)}`);
      else if (!n || n.calls !== calls || n.texts !== 1 || arm[0].turns !== calls + 1) wrong.push(`${ref}: the run did not follow the reference (${n?.calls ?? 0} of ${calls} calls, ${n?.texts ?? 0} texts, ${arm[0].turns} turns)`);
      else {
        rec.runs[ref] = Object.fromEntries((arm[0].graders ?? []).map((/** @type {any} */ g) => [g.name, g.passed === true]));
        const outcome = callsOf(String(arm[0].tracePath));
        if (outcome.length !== traced.length) wrong.push(`${ref}: the trace holds ${outcome.length} of ${traced.length} calls`);
        else if (traced.length) rec.calls[ref] = outcome;
      }
    }
    for (const ref of work.keys()) if (!rec.runs[ref] && !wrong.some((w) => w.startsWith(`${ref}:`))) wrong.push(`${ref}: no case in the report`);
    if (wrong.length) throw new Error(`the eval tool's report cannot be recorded:\n${wrong.join("\n")}`);
    rec.graders = Object.fromEntries(Object.keys(CHECKS).filter((id) => id in rec.graders).map((id) => [id, rec.graders[id]]));
    rec.runs = Object.fromEntries([...work.keys()].map((ref) => [ref, Object.fromEntries(Object.keys(CHECKS).filter((id) => id in rec.runs[ref]).map((id) => [id, rec.runs[ref][id]]))]));
    rec.calls = Object.fromEntries([...work.keys()].filter((ref) => ref in rec.calls).map((ref) => [ref, rec.calls[ref]]));
    return rec;
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    await sweep({ R, server, failure, runRoot, before, since, running, settleMs });
  }
}

/**
 * The eval run: spawned detached as given, its stderr kept, its whole process tree killed when it ends or at the time
 * limit; `onStart` is given its pid. @param {(file: string, args: string[], opts: object) => any} spawnRun @param {string} file
 * @param {string[]} args @param {{ cwd: string, env: Record<string, string> }} opts @param {number} timeoutMs
 * @param {(pid: number | undefined) => void} [onStart]
 * @returns {Promise<{ code: number | null, err: string, timedOut: boolean }>}
 */
function runEval(spawnRun, file, args, { cwd, env }, timeoutMs, onStart) {
  return new Promise((resolve) => {
    const child = spawnRun(file, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: true });
    onStart?.(child.pid);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), killTree(child.pid)), timeoutMs);
    child.stderr?.on("data", (/** @type {Buffer} */ d) => (err += d));
    child.on("close", (/** @type {number | null} */ code) => (clearTimeout(timer), killTree(child.pid), resolve({ code, err, timedOut })));
  });
}

/**
 * After a recorder's run, however it ended: the stand-in closed, the recorder's directory removed, every process that
 * names it killed and every run directory the eval tool made unsealed and removed (again after `settleMs`, failing on
 * any that came back). What is left fails the run: added to `failure`'s message, or thrown.
 * @param {{ R: string, server?: { close: () => void, drop: () => void }, failure: unknown, runRoot: string, before: Set<string>, since: number, running: typeof processesNaming, settleMs?: number }} o
 */
async function sweep({ R, server, failure, runRoot, before, since, running, settleMs = 0 }) {
  server?.close();
  rmSync(R, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // A run of the eval tool still alive names the recorder's directory: it would write its run directory again.
  const stray = running(R);
  for (const pid of stray) killTree(pid);
  for (const name of newRunDirs(runRoot, before, since)) unseal(join(runRoot, name));
  let back = /** @type {string[]} */ ([]);
  if (settleMs) {
    await new Promise((r) => setTimeout(r, settleMs));
    back = newRunDirs(runRoot, before, since);
    const late = running(R);
    for (const pid of late) killTree(pid);
    for (const name of newRunDirs(runRoot, before, since)) unseal(join(runRoot, name));
    stray.push(...late);
  }
  server?.drop();
  // A run directory or a process still there, or one that came back, fails the run, whatever else did.
  const left = [...new Set([...back, ...newRunDirs(runRoot, before, since)])].sort();
  const text = [left.length ? `run directories left in ${runRoot}: ${left.join(", ")}` : "", stray.length ? `processes left running: ${stray.length}` : ""].filter(Boolean).join("\n");
  if (text) {
    if (failure instanceof Error) failure.message += `\n${text}`;
    else throw new Error(text);
  }
}

/** sandbox-exec's refusal to start a command, as the Bash tool gives it back (2.1.310: text, no exit code field). */
const UNSTARTED = "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted";

/**
 * A run's trace (Claude Code's stream-json, one event a line): its tool calls in order, each call's result (its content
 * as given, its text with text blocks joined, and whether it is marked an error) and the calls the result's
 * permission_denials names.
 * @param {string} tracePath
 * @returns {{ uses: { id: string }[], results: Map<string, { content: unknown, text: string | undefined, isError: boolean }>, refused: Set<string> }}
 */
export function readTrace(tracePath) {
  const events = readFileSync(tracePath, "utf8").split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const refused = new Set((events.find((e) => e.type === "result")?.permission_denials ?? []).map((/** @type {any} */ d) => d.tool_use_id));
  const blocks = (/** @type {string} */ type) => events.flatMap((e) => (e.type === type && Array.isArray(e.message?.content) ? e.message.content : []));
  /** @param {unknown} c */
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? String(b.text) : "")).join("") : undefined);
  const results = new Map(blocks("user").filter((/** @type {any} */ b) => b.type === "tool_result").map((/** @type {any} */ b) => [b.tool_use_id, { content: b.content, text: text(b.content), isError: b.is_error === true }]));
  return { uses: blocks("assistant").filter((/** @type {any} */ b) => b.type === "tool_use"), results, refused };
}

/**
 * What became of each tool call of a run, in order, from its trace: `refused` when the result's permission_denials
 * names it, `unstarted` when its result's content is exactly sandbox-exec's refusal to start it, a string, else `ran`.
 * The result has no field for an exit code, so `unstarted` reads that text whole; a text that moves, or comes in
 * blocks, reads as `ran`, and the record fails.
 * @param {string} tracePath @returns {string[]}
 */
export function callsOf(tracePath) {
  const { uses, results, refused } = readTrace(tracePath);
  return uses.map((b) => (refused.has(b.id) ? "refused" : results.get(b.id)?.content === UNSTARTED ? "unstarted" : "ran"));
}

/**
 * Each tool call's exit, in order: `refused` when permission_denials names it, `unanswered` with no result, the
 * number of an "Exit code N" line that begins its result (how the Bash tool gives a failure, 2.1.310), `error` for
 * another result marked an error, else 0.
 * @param {ReturnType<typeof readTrace>} trace @returns {(number | string)[]}
 */
export function exitsOf({ uses, results, refused }) {
  return uses.map((b) => {
    if (refused.has(b.id)) return "refused";
    const r = results.get(b.id);
    if (!r) return "unanswered";
    const m = /^Exit code (\d+)(?:\n|$)/.exec(r.text ?? "");
    return m ? Number(m[1]) : r.isError ? "error" : 0;
  });
}

/**
 * A run directory the eval tool made, which it may leave read-only with its run's home sealed (mode 000), removed: each
 * directory opened to its owner from the top down (no link followed, no program run), then the whole removed.
 * @param {string} dir
 */
export function unseal(dir) {
  if (!RUN_DIR.test(basename(dir))) return;
  /** @param {string} d */
  const open = (d) => {
    try {
      if (!lstatSync(d).isDirectory()) return;
      chmodSync(d, 0o700);
      for (const e of readdirSync(d)) open(join(d, e));
    } catch {}
  };
  open(dir);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

/**
 * How the command ends on an error: a machine with no sandbox-exec says it did not measure, and fails, as the npm and
 * Claude Code records do; any other error fails with its message.
 * @param {unknown} e @param {string} cmd @returns {{ code: number, out?: string, err?: string }}
 */
export function exitOf(e, cmd) {
  if (e instanceof NotMeasured && cmd === "check") return { code: 1, out: `${e.message}\n` };
  return { code: 1, err: `${e instanceof Error ? e.message : String(e)}\n` };
}

/** The processes whose command line names a path, this one aside (ps; none where ps cannot be read). @param {string} path @returns {number[]} */
function processesNaming(path) {
  try {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", env: {} })
      .split("\n")
      .filter((l) => l.includes(path))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => pid && pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * The cleanup proven where it is hardest: the same eval, every run in flight (the stand-in answers no turn), cut off
 * must leave no run directory and no process, nor have one come back within a few seconds.
 * @param {string} bin @param {number} [afterMs] @returns {Promise<string[]>} what went wrong
 */
export async function cutRun(bin, afterMs = 4000) {
  try {
    await recordRuns(bin, { timeoutMs: afterMs, hold: true, settleMs: 3000 });
    return [`not measured: the eval ended before it was cut at ${afterMs} ms`];
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!/ran out of time/.test(text)) return [`the cut run failed otherwise: ${text.split("\n")[0]}`];
    return text.split("\n").filter((l) => /^(?:run directories left|processes left running)/.test(l)).map((l) => `cut at ${afterMs} ms: ${l}`);
  }
}

/**
 * A process, everything it started and its group, gone: the eval tool starts each run in a process group of its own,
 * which a kill of the eval's group misses (measured: killed at 1.5 s and 3 s, its runs went on making run directories
 * after the recorder had removed the ones it saw). The tree is read from ps while the process lives.
 * @param {number | undefined} pid
 */
function killTree(pid) {
  if (pid === undefined) return;
  let ps = "";
  try {
    ps = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", env: {} });
  } catch {}
  for (const p of treeOf(pid, ps)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude");
  // The first claude outside a node_modules/.bin, as the Claude Code record finds it (claude.mjs hands a path).
  const bin = claudeBinary(at === -1 ? "claude" : argv[at + 1])?.path ?? "";
  const rest = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const cmd = rest[0];
  if (cmd !== "check" && cmd !== "record" && cmd !== "git") {
    process.stderr.write("usage: node test/eval/selftest.mjs check | record [--new-version] | git [--record] [--new-version] [--claude <bin>]\n");
    process.exit(2);
  }
  if (!bin) {
    process.stderr.write("no claude binary found (node_modules/.bin folders on PATH are skipped): point at one with --claude <path>\n");
    process.exit(1);
  }
  try {
    if (cmd === "git") await gitCommand(bin, rest);
    else await plainCommand(bin, cmd, rest);
  } catch (e) {
    const { code, out, err } = exitOf(e, cmd === "git" ? "check" : cmd);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exitCode = code;
  }
}

/**
 * `check` and `record`: the plain run under the outer profile, and for `check` the cut run.
 * @param {string} bin @param {string} cmd @param {string[]} rest
 */
async function plainCommand(bin, cmd, rest) {
  const old = existsSync(RECORD) ? readRecord() : undefined;
  const version = existsSync(SANDBOX) ? versionOf(bin) : "";
  if (old && version && version !== old.claudeCode && !(cmd === "record" && rest.includes("--new-version"))) {
    process.stdout.write(`the record is Claude Code ${old.claudeCode}, ${bin} is ${version}: point at a ${old.claudeCode} binary (node test/eval/selftest.mjs check --claude <path>, or npm run test:reference -- --claude <path>), or take the record again with this one (node test/eval/selftest.mjs record --new-version --claude <path>) and run test/eval-selftest.test.mjs to see what moved\n`);
    process.exit(1);
  }
  const rec = await recordRuns(bin);
  const moved = old ? Object.keys(rec.runs).filter((ref) => JSON.stringify([rec.said[ref], rec.runs[ref], rec.calls[ref]]) !== JSON.stringify([old.said?.[ref], old.runs[ref], old.calls?.[ref]])) : Object.keys(rec.runs);
  const graders = old ? Object.keys(rec.graders).filter((id) => JSON.stringify(rec.graders[id]) !== JSON.stringify(old.graders[id])) : [];
  const wrong = problems(rec);
  for (const w of wrong) process.stdout.write(`${w}\n`);
  if (cmd === "record") {
    if (wrong.length) {
      process.stdout.write("not recorded: the checks read these references otherwise than they say; fix the check or its limits first\n");
      process.exit(1);
    }
    writeFileSync(RECORD, recordText(rec));
    process.stdout.write(`recorded ${Object.keys(rec.runs).length} reference(s) with Claude Code ${rec.claudeCode}; moved: ${moved.join(", ") || "none"}\n`);
  } else {
    for (const ref of moved) process.stdout.write(`${ref}: the eval tool now gives ${JSON.stringify(rec.runs[ref])}, calls ${JSON.stringify(rec.calls[ref] ?? [])}\n  recorded ${JSON.stringify(old?.runs[ref])}, calls ${JSON.stringify(old?.calls?.[ref] ?? [])}\n`);
    for (const id of graders) process.stdout.write(`${id}: the eval tool now reads ${JSON.stringify(rec.graders[id])}\n`);
    if (!moved.length && !graders.length) process.stdout.write(`Claude Code ${rec.claudeCode} grades all ${Object.keys(rec.runs).length} reference(s) as recorded\n`);
    const cut = await cutRun(bin);
    for (const c of cut) process.stdout.write(`${c}\n`);
    if (!cut.length) process.stdout.write("an eval cut off mid-run left no run directory and no process\n");
    process.exitCode = wrong.length || moved.length || graders.length || cut.length ? 1 : 0;
  }
}

/**
 * `git`: the git run against its record (a git or gap cell that moved fails, a note is said), or with `--record` its
 * record taken again.
 * @param {string} bin @param {string[]} rest
 */
async function gitCommand(bin, rest) {
  const old = existsSync(GIT_RECORD) ? readGitRecord() : undefined;
  const version = existsSync(SANDBOX) ? versionOf(bin) : "";
  const record = rest.includes("--record");
  if (old && version && version !== old.claudeCode && !(record && rest.includes("--new-version"))) {
    process.stdout.write(`the git record is Claude Code ${old.claudeCode}, ${bin} is ${version}: point at a ${old.claudeCode} binary (--claude <path>), or take it again with this one (node test/eval/selftest.mjs git --record --new-version --claude <path>)\n`);
    process.exit(1);
  }
  const cells = await recordGit(bin);
  const wrong = gitProblems(cells);
  const { fail, notes } = gitMoves(cells, old?.cells);
  for (const line of [...wrong, ...notes]) process.stdout.write(`${line}\n`);
  if (record) {
    if (wrong.length) {
      process.stdout.write("not recorded: a git or deny cell reads otherwise than it must (above)\n");
      process.exit(1);
    }
    const lines = Object.entries(cells).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
    writeFileSync(GIT_RECORD, `{\n  "claudeCode": ${JSON.stringify(version)},\n  "cells": {\n${lines}\n  }\n}\n`);
    process.stdout.write(`recorded ${Object.keys(cells).length} git cell(s) with Claude Code ${version}; moved: ${fail.map((l) => l.split(":")[0]).join(", ") || "none"}\n`);
  } else {
    for (const line of fail) process.stdout.write(`${line}\n`);
    if (!fail.length) process.stdout.write(`Claude Code ${version} runs git in its arms and keeps the operator's home and instructions from them, as recorded\n`);
    process.exitCode = wrong.length || fail.length ? 1 : 0;
  }
}
