/**
 * What Claude Code does with a PreCompact hook, recorded: the compaction hook (adapters/claude-code/hooks/compact-boundary.mjs)
 * stands on behaviour no document promises (stdout joined to the summary's instructions, a transcript written on a
 * timer, what a hold does on each path) and on numbers read from the binary. A Claude Code update that moves one of
 * them is seen here, by `npm run test:reference`.
 *
 * Each cell runs the machine's Claude Code in print mode, in a directory of its own, against a stand-in for the model
 * on 127.0.0.1, with no key of Anthropic's and the home, config and temporary directories the cell's, as
 * test/reference/claude-code.mjs does. The stand-in takes the conversation through some tool calls, reports a large
 * context, and answers a summary request with a summary, so Claude Code reaches compaction with no model call. A cell
 * names one of HOOKS: the commands come from this file only. Idle compaction is not a cell: it needs an interactive
 * session and half an hour of wall clock. What the rule takes from it is held by `idleNumbers`, read from the binary;
 * DESIGN.md says how it was measured on the real CLI.
 *
 *   node test/reference/precompact.mjs check [--claude <bin>]    exit 1 when Claude Code reads a cell otherwise
 *   node test/reference/precompact.mjs record [--claude <bin>]   take every reading again
 * `check` also holds MODEL_WINDOWS and IDLE_GAP_MS (adapters/claude-code/compact-boundary.mjs) to the binary.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IDLE_GAP_MS, MODEL_WINDOWS } from "../../plugin/adapters/claude-code/compact-boundary.mjs";
import { claudeBinary, safePath, versionOf } from "./claude-bin.mjs";
import { gitEnv } from "./claude-code.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "precompact.json");
const KEY = "sk-ant-stand-in-000000000000000000000000";
const SUMMARY = "<analysis>a</analysis><summary>s</summary>";
const MARK = "EN-PRECOMPACT-STDOUT";

/** What a hook of a cell does after its input and the transcript are kept. @type {Record<string, string>} */
const HOOKS = {
  print: `echo ${MARK}`,
  block: "echo held >&2; exit 2",
  json: 'echo \'{"decision":"block","reason":"held"}\'',
  fail: "exit 1",
  hang: "sleep 30; exit 2",
};

/** The opus model, whose window is 1M, unless a cell names another. */
const MODEL = "claude-opus-5-5";
const WINDOW_100K = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" };

/**
 * @typedef {{ i: number, summary: boolean, sub: boolean, json: any, reply: (content: object[], tokens: number, stop?: string) => void, refuse: () => void }} Turn
 * @typedef {{ hook: keyof typeof HOOKS, env?: Record<string, string>, timeout?: number, turns: (t: Turn) => void, varies?: string[] }} Cell
 */

/** @param {number} i */
const bash = (i) => [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: "true", description: "x" } }];
const text = (/** @type {string} */ t) => [{ type: "text", text: t }];

/** Eight tool rounds, the last reporting `tokens`, then text. @param {number} tokens @returns {Cell["turns"]} */
const reach = (tokens) => ({ i, summary, reply }) => {
  if (summary) return reply(text(SUMMARY), 500);
  if (i < 8) return reply(bash(i), i === 7 ? tokens : 1000, "tool_use");
  return reply(text("done"), 2000);
};

/** The same, and the API refuses the next request as too long. @param {number} tokens @returns {Cell["turns"]} */
const refused = (tokens) => ({ i, summary, reply, refuse }) => {
  if (summary) return reply(text(SUMMARY), 500);
  if (i < 8) return reply(bash(i), i === 7 ? tokens : 1000, "tool_use");
  if (i === 8) return refuse();
  return reply(text("done"), 2000);
};

/** A subagent that reaches compaction while the main thread sits at 1000 tokens. @returns {Cell["turns"]} */
function inSubagent() {
  let n = 0;
  return ({ summary, sub, reply, i }) => {
    if (summary) return reply(text(SUMMARY), 500);
    if (!sub) return i === 0 ? reply([{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "x", prompt: "stand-in-subagent", subagent_type: "general-purpose" } }], 1000, "tool_use") : reply(text("done"), 2000);
    n++;
    return n < 9 ? reply(bash(100 + n), n === 8 ? 90000 : 1000, "tool_use") : reply(text("sub done"), 2000);
  };
}

/** @type {Record<string, () => Cell>} */
export const CELLS = {
  "stdout-joins-the-summary": () => ({ hook: "print", env: WINDOW_100K, turns: reach(90000) }),
  "exit-2-holds-and-the-turn-goes-on": () => ({ hook: "block", env: WINDOW_100K, turns: reach(90000) }),
  "exit-2-is-asked-again-every-turn": () => ({ hook: "block", env: WINDOW_100K, turns: ({ i, reply }) => (i < 11 ? reply(bash(i), i < 6 ? 1000 : 90000 + i, "tool_use") : reply(text("done"), 90100)) }),
  "exit-1-lets-it-through": () => ({ hook: "fail", env: WINDOW_100K, turns: reach(90000) }),
  "timeout-lets-it-through": () => ({ hook: "hang", timeout: 1, env: WINDOW_100K, turns: reach(90000) }),
  "stdout-json-is-a-verdict": () => ({ hook: "json", env: WINDOW_100K, turns: reach(90000) }),
  "block-under-the-hard-limit-at-1m": () => ({ hook: "block", turns: reach(970000) }),
  "block-past-the-hard-limit-at-1m": () => ({ hook: "block", turns: reach(980000) }),
  "block-on-a-413": () => ({ hook: "block", turns: refused(150000) }),
  "pass-on-a-413": () => ({ hook: "print", turns: refused(150000) }),
  // Whether the stream shows the subagent's boundary before the run ends differs between runs.
  "a-subagent-compacts": () => ({ hook: "print", env: WINDOW_100K, turns: inSubagent(), varies: ["compacted"] }),
};

/**
 * The stand-in. `summary`: the request is a summary request; `sub`: a subagent's; `json`: the request as sent.
 * @param {Cell["turns"]} turns
 * @returns {Promise<{ port: number, bodies: { summary: boolean, text: string }[], close: () => void }>}
 */
export function standIn(turns) {
  /** @type {{ summary: boolean, text: string }[]} */
  const bodies = [];
  let main = 0;
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
      const all = JSON.stringify(json.messages ?? []);
      const summary = /Your task is to create a detailed summary/.test(all.slice(-30000));
      const sub = all.includes("stand-in-subagent");
      bodies.push({ summary, text: all });
      /** @param {[string, object][]} events */
      const sse = (events) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.end();
      };
      const i = summary || sub ? -1 : main++;
      turns({
        i,
        summary,
        sub,
        json,
        refuse: () => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 205000 tokens > 200000 maximum" } }));
        },
        reply: (content, tokens, stop = "end_turn") => {
          const usage = { input_tokens: tokens, output_tokens: 1 };
          /** @type {[string, object]} */
          const start = ["message_start", { message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: json.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }];
          const blocks = content.flatMap((c, index) => {
            const block = /** @type {any} */ (c);
            /** @type {[string, object][]} */
            return block.type === "tool_use"
              ? [["content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }], ["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }], ["content_block_stop", { index }]]
              : [["content_block_start", { index, content_block: { type: "text", text: "" } }], ["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }], ["content_block_stop", { index }]];
          });
          sse([start, ...blocks, ["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage }], ["message_stop", {}]]);
        },
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, bodies, close: () => server.close() });
    });
  });
}

/** @param {number | undefined} pid */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/**
 * What Claude Code did in one cell.
 * @param {Cell} c @param {string} bin
 */
export async function reading(c, bin) {
  const R = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-pc-")));
  try {
    const P = join(R, "p");
    const OUT = join(R, "out");
    for (const d of ["p/.claude", "cfg", "home", "run", "tmp", "out", "hooks"]) mkdirSync(join(R, d), { recursive: true });
    const { env: git, args: quiet } = gitEnv(R);
    execFileSync("git", [...quiet, "init", "-q"], { cwd: P, env: git });
    execFileSync("git", [...quiet, "commit", "-qm", "cell", "--allow-empty", "--no-verify"], { cwd: P, env: git });
    // The hook keeps its input and, past the transcript's write interval, the transcript as it was at that moment.
    const keep = `n=$$; cat > "${OUT}/stdin.$n"; sleep 0.4; t=$(sed -n 's/.*"transcript_path":"\\([^"]*\\)".*/\\1/p' "${OUT}/stdin.$n"); cp "$t" "${OUT}/lines.$n"`;
    writeFileSync(join(R, "hook.sh"), `#!/bin/sh\n${keep}\n${HOOKS[c.hook]}\n`, { mode: 0o755 });
    writeFileSync(join(P, ".claude", "settings.json"), JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: `sh ${join(R, "hook.sh")}`, ...(c.timeout ? { timeout: c.timeout } : {}) }] }] } }));
    writeFileSync(join(R, "cfg", ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true }));
    const server = await standIn(c.turns);
    const env = {
      PATH: safePath(),
      HOME: join(R, "home"),
      TMPDIR: join(R, "tmp"),
      CLAUDE_CODE_TMPDIR: join(R, "tmp"),
      CLAUDE_CONFIG_DIR: join(R, "cfg"),
      XDG_RUNTIME_DIR: join(R, "run"),
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      ...c.env,
    };
    const args = ["-p", "--model", MODEL, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "stand-in"];
    /** @type {{ out: string, code: number | null, timedOut: boolean }} */
    const run = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: P, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => ((timedOut = true), killGroup(child.pid)), 90_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", () => {});
      child.on("close", (code) => (clearTimeout(timer), killGroup(child.pid), resolve({ out, code, timedOut })));
    });
    server.close();
    const events = run.out.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const result = events.find((e) => e.type === "result");
    const kept = readdirSync(OUT);
    const inputs = kept.filter((f) => f.startsWith("stdin.")).map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")));
    const copies = kept.filter((f) => f.startsWith("lines.")).map((f) => readFileSync(join(OUT, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    const session = inputs[0]?.session_id;
    const transcript = session ? join(R, "cfg", "projects", readdirSync(join(R, "cfg", "projects"))[0], `${session}.jsonl`) : "";
    const lines = transcript && existsSync(transcript) ? readFileSync(transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    const reply = lines.find((o) => o.type === "assistant" && o.message?.usage);
    const failure = lines.find((o) => o.isApiErrorMessage === true);
    /** @type {Record<string, unknown>} */
    const out = {
      ended: run.timedOut ? "unmeasured: the run did not end" : result?.terminal_reason ?? result?.stop_reason ?? `no result (exit ${run.code})`,
      isError: result?.is_error === true,
      hookRuns: inputs.length,
      summaries: server.bodies.filter((b) => b.summary).length,
      marked: server.bodies.filter((b) => b.text.includes(MARK)).map((b) => (b.summary ? "summary" : "other")),
      compacted: events.some((e) => e.subtype === "compact_boundary"),
      input: inputs[0] ? Object.keys(inputs[0]).sort() : [],
      trigger: inputs[0]?.trigger ?? null,
      unansweredAtHook: copies.length ? copies[0].filter((o) => o.type === "api-request" || (o.type === "assistant" && o.message?.usage)).at(-1)?.type === "api-request" : null,
      promptIsTheTurns: copies.length ? copies[0].filter((o) => o.type === "user" && !o.isSidechain).at(-1)?.promptId === inputs[0].prompt_id : null,
      replyShape: reply ? { usage: Object.keys(reply.message.usage).filter((k) => /tokens$/.test(k)).sort(), model: typeof reply.message.model, timestamp: typeof reply.timestamp, sidechain: reply.isSidechain } : null,
      failure: failure ? { model: failure.message?.model, error: failure.error, text: failure.message?.content?.[0]?.text } : null,
      mainTranscriptNamed: inputs[0] ? inputs[0].transcript_path === realTranscript(inputs[0].transcript_path, transcript) : null,
    };
    for (const k of c.varies ?? []) delete out[k];
    return out;
  } finally {
    rmSync(R, { recursive: true, force: true });
  }
}

/** The transcript named, when it is the session's main file. @param {string} named @param {string} main */
const realTranscript = (named, main) => (named === main ? named : "");

/**
 * The model table in the binary: each model's id, the id the API writes, and its window; a model with no `context` has
 * none.
 * @param {string} file the binary's real file
 * @returns {Map<string, number>}
 */
export function binaryWindows(file) {
  const bytes = readFileSync(file);
  const at = bytes.indexOf('{id:"claude-3-5-haiku",family:');
  if (at === -1) throw new Error("the model table was not found in the binary");
  const text = bytes.subarray(at, at + 64 * 1024).toString("latin1");
  /** @type {Map<string, number>} */
  const out = new Map();
  const heads = [...text.matchAll(/\{id:"(claude-[a-z0-9-]+)",family:"/g)];
  heads.forEach((m, i) => {
    const part = text.slice(m.index, heads[i + 1]?.index ?? text.length);
    const context = /context:\{window:([0-9e]+)/.exec(part);
    if (!context) return;
    const window = Number(context[1]);
    out.set(m[1], window);
    const first = /first_party:"([^"]+)"/.exec(part);
    if (first) out.set(first[1], window);
  });
  return out;
}

/**
 * Idle compaction's numbers in the binary: the context it starts at and that number's floor, and the fraction of the
 * prompt cache's lifetime it fires at, with that fraction's floor and top. Only the first fraction is the default.
 * @param {string} file the binary's real file
 * @returns {{ minTokens: number, tokensFloor: number, fraction: number, fractionFloor: number, fractionTop: number, hourMs: number }}
 */
export function idleNumbers(file) {
  const text = readFileSync(file).toString("latin1");
  const set = /var [\w$]+=(\d+),[\w$]+=(1e5),[\w$]+=(0\.\d+),[\w$]+=(0\.\d+),[\w$]+=(0\.\d+),[\w$]+=[\w$]+\*([\w$]+),[\w$]+=60000,[\w$]+=`[^`]*turn off with "idleCompaction"/.exec(text);
  if (!set) throw new Error("idle compaction's numbers were not found in the binary");
  const hour = new RegExp(`[,; ]${set[6].replace(/\$/g, "\\$")}=3600000[,;]`).test(text);
  return { minTokens: Number(set[1]), tokensFloor: Number(set[2]), fraction: Number(set[3]), fractionFloor: Number(set[4]), fractionTop: Number(set[5]), hourMs: hour ? 3_600_000 : 0 };
}

/** IDLE_GAP_MS against the binary's numbers, one line for a difference. @param {ReturnType<typeof idleNumbers>} idle @param {number} [gap] */
export const idleMoved = (idle, gap = IDLE_GAP_MS) => (idle.fractionFloor * idle.hourMs === gap ? [] : [`IDLE_GAP_MS is ${gap}, the binary's earliest idle compaction is ${idle.fractionFloor * idle.hourMs} ms after the last request`]);

/** The differences between two id tables, one line each. @param {Map<string, number>} ours @param {Map<string, number>} theirs */
export function windowsMoved(ours, theirs) {
  return [...new Set([...ours.keys(), ...theirs.keys()])].sort().flatMap((id) => (ours.get(id) === theirs.get(id) ? [] : [`${id}: MODEL_WINDOWS says ${ours.get(id) ?? "nothing"}, the binary ${theirs.get(id) ?? "nothing"}`]));
}

/** @returns {{ claudeCode: string, idle: ReturnType<typeof idleNumbers>, cells: Record<string, any> }} */
export const readRecord = () => JSON.parse(readFileSync(RECORD, "utf8"));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude");
  const [cmd] = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const found = claudeBinary(at === -1 ? "claude" : argv[at + 1]);
  if (!found || (cmd !== "check" && cmd !== "record")) {
    process.stderr.write(found ? "usage: node test/reference/precompact.mjs check | record [--claude <bin>]\n" : "no claude binary found: point at one with --claude <path>\n");
    process.exit(found ? 2 : 1);
  }
  const version = versionOf(found.path);
  const rec = existsSync(RECORD) ? readRecord() : { claudeCode: "", idle: undefined, cells: {} };
  if (cmd === "check" && version !== rec.claudeCode) {
    process.stdout.write(`the record is Claude Code ${rec.claudeCode}, ${found.path} is ${version}: take it again with node test/reference/precompact.mjs record --claude <path>\n`);
    process.exit(1);
  }
  /** @type {Record<string, any>} */
  const cells = {};
  for (const [id, make] of Object.entries(CELLS)) cells[id] = await reading(make(), found.path);
  const moved = Object.keys(cells).filter((id) => JSON.stringify(cells[id]) !== JSON.stringify(rec.cells[id]));
  const idle = idleNumbers(found.file);
  const table = [...windowsMoved(MODEL_WINDOWS, new Map([...binaryWindows(found.file)].filter(([, window]) => window === 1_000_000))), ...idleMoved(idle)];
  if (JSON.stringify(idle) !== JSON.stringify(rec.idle) && cmd === "check") table.push(`idle compaction's numbers moved: ${JSON.stringify(idle)}, recorded ${JSON.stringify(rec.idle)}`);
  if (cmd === "record") {
    writeFileSync(RECORD, `${JSON.stringify({ claudeCode: version, idle, cells }, null, 2)}\n`);
    process.stdout.write(`recorded ${Object.keys(cells).length} cell(s) with Claude Code ${version}; ${moved.length} reading(s) moved: ${moved.join(", ") || "none"}\n`);
  } else {
    for (const id of moved) process.stdout.write(`${id}: Claude Code now reads ${JSON.stringify(cells[id])}\n  recorded ${JSON.stringify(rec.cells[id])}\n`);
    if (!moved.length) process.stdout.write(`Claude Code ${version} treats all ${Object.keys(cells).length} PreCompact cell(s) as recorded\n`);
  }
  for (const line of table) process.stdout.write(`${line}\n`);
  if (table.length) process.stdout.write("the binary moved: change MODEL_WINDOWS or IDLE_GAP_MS in adapters/claude-code/compact-boundary.mjs, and take the record again\n");
  process.exitCode = (cmd === "check" && moved.length) || table.length ? 1 : 0;
}
