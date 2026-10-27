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
 *   node test/eval/selftest.mjs check [--claude <bin>]                  exit 1 when a verdict, a grader's reading or a call's fate moved,
 *                                                                       or an eval cut off mid-run leaves a run directory or a process
 *   node test/eval/selftest.mjs record [--claude <bin>] [--new-version]  take the record again (another Claude Code: --new-version)
 * The binary is `--claude`, else `claude` on PATH; `npm run test:reference` runs `check` through test/reference/claude.mjs,
 * which hands `--claude` to this and to claude-code.mjs alike.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CALLS, CHECKS, NEVER, REFERENCES, SUBAGENTS, fateOf, graderFile, traceCalls } from "./checks.mjs";
import { claudeBinary, safePath, versionOf } from "../reference/claude-bin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "selftest.json");

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
const PROMPT = /selftest (reference|subagent) ([\w:.-]+)/;
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
 * (a case's) or the subagent (an Agent call's prompt), the assistant messages before it count the turn; the turn gets
 * that script's call of that turn, or its text. Any other request gets text. `served` counts, by script (`reference
 * <name>`, `subagent <name>`), the calls and texts given. `hold`: a turn of a case is never answered, so every run is
 * in flight when the eval is cut, and stays so until it is killed: closing takes no new connection, and only `drop`
 * ends the ones held.
 * @returns {Promise<{ port: number, served: Map<string, { calls: number, texts: number }>, close: () => void, drop: () => void }>}
 */
function standIn(hold = false) {
  /** @type {Map<string, { calls: number, texts: number }>} */
  const served = new Map();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
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
      const script = !named ? undefined : named[1] === "reference" ? REFERENCES[named[2]] : SUBAGENTS[named[2]];
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
          const call = CALLS[script.calls[turn]];
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
      resolve({ port: typeof address === "object" && address ? address.port : 0, served, close: () => server.close(), drop: () => server.closeAllConnections() });
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
 * (the system's resolver and a direct DNS query), the stand-in reached. @param {Record<string, string>} got @returns {string[]}
 */
export function canaryProblems(got) {
  const out = [];
  if (got.remote !== "EPERM") out.push(`a connection to ${CANARY_ADDRESS} was not refused (${got.remote})`);
  for (const k of ["lookup", "resolve"]) if (got[k] === undefined || got[k] === "resolved") out.push(`a name was looked up (${k}: ${got[k]})`);
  if (got.local !== "connected") out.push(`the stand-in was not reached (${got.local})`);
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
  const out = execFileSync(SANDBOX, ["-p", NO_NETWORK(port, root), process.execPath, "-e", CANARY, String(port)], { encoding: "utf8", env: { PATH: safePath() }, timeout: 30_000 });
  return JSON.parse(out);
}

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
    /** @type {{ code: number | null, err: string, timedOut: boolean }} */
    const run = await new Promise((resolve) => {
      const child = spawnRun(file, args, { cwd: join(R, "work"), env, stdio: ["ignore", "ignore", "pipe"], detached: true });
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => ((timedOut = true), killTree(child.pid)), timeoutMs);
      child.stderr?.on("data", (/** @type {Buffer} */ d) => (err += d));
      child.on("close", (/** @type {number | null} */ code) => (clearTimeout(timer), killTree(child.pid), resolve({ code, err, timedOut })));
    });
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
}

/** sandbox-exec's refusal to start a command, as the Bash tool gives it back (2.1.310: text, no exit code field). */
const UNSTARTED = "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted";

/**
 * What became of each tool call of a run, in order, from its trace (Claude Code's stream-json): `refused` when the
 * result's permission_denials names it, `unstarted` when its result is exactly sandbox-exec's refusal to start it,
 * else `ran`. The result has no field for an exit code, so `unstarted` reads that text whole; a text that moves
 * reads as `ran`, and the record fails.
 * @param {string} tracePath @returns {string[]}
 */
function callsOf(tracePath) {
  const events = readFileSync(tracePath, "utf8").split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const refused = new Set((events.find((e) => e.type === "result")?.permission_denials ?? []).map((/** @type {any} */ d) => d.tool_use_id));
  const blocks = (/** @type {string} */ type) => events.flatMap((e) => (e.type === type && Array.isArray(e.message?.content) ? e.message.content : []));
  const results = new Map(blocks("user").filter((/** @type {any} */ b) => b.type === "tool_result").map((/** @type {any} */ b) => [b.tool_use_id, b.content]));
  return blocks("assistant")
    .filter((/** @type {any} */ b) => b.type === "tool_use")
    .map((/** @type {any} */ b) => (refused.has(b.id) ? "refused" : results.get(b.id) === UNSTARTED ? "unstarted" : "ran"));
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
  /** @type {Map<number, number[]>} */
  const kids = new Map();
  try {
    for (const line of execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", env: {} }).split("\n")) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (p && pp >= 0) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    }
  } catch {}
  /** @type {number[]} */
  const all = [];
  /** @param {number} p */
  const walk = (p) => {
    all.push(p);
    for (const c of kids.get(p) ?? []) walk(c);
  };
  walk(pid);
  for (const p of all) {
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
  if (cmd !== "check" && cmd !== "record") {
    process.stderr.write("usage: node test/eval/selftest.mjs check | record [--new-version] [--claude <bin>]\n");
    process.exit(2);
  }
  if (!bin) {
    process.stderr.write("no claude binary found (node_modules/.bin folders on PATH are skipped): point at one with --claude <path>\n");
    process.exit(1);
  }
  try {
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
  } catch (e) {
    const { code, out, err } = exitOf(e, cmd);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exitCode = code;
  }
}
