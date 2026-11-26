/**
 * `ennyn agents`: per subagent of a Claude Code session, the model asked for beside the models that ran, read only.
 * The transcripts here are built in a temporary folder in the shapes measured on Claude Code 2.1.301 to 2.1.317
 * (the session's folder under `projects/`, `<session>/subagents/agent-<id>.jsonl` and `.meta.json`, a message on
 * several lines with its usage growing, `<synthetic>` lines, the Agent call also on an `api-request-blob` line) and
 * the folder name rule read from the 2.1.310 binary. Nothing of a transcript's text may reach the output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN, READ_LINE_MAX, agentFileFields, context, folderName, modelMatches, namedFolder } from "../plugin/adapters/claude-code/agent-usage.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "ennyn.mjs");
/** Text a transcript holds that the output must never show. */
const SECRET = "prompt-text-that-must-not-show";

/** @param {string} p @param {string} text */
const put = (p, text) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));
/** @param {string} p @param {unknown[]} lines */
const lines = (p, lines) => put(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");

/** @param {string} id @param {string} model @param {Record<string, number> | null} usage @param {unknown[]} [content] @param {string} [type] */
const said = (id, model, usage, content = [{ type: "text", text: SECRET }], type = "assistant") => ({
  type,
  timestamp: "2026-11-04T10:00:00.000Z",
  message: { id, model, ...(usage ? { usage } : {}), content },
});
/** @param {number} output @param {number} write @param {number} read */
const usage = (output, write, read) => ({ input_tokens: 3, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read });
/** @param {string} id @param {Record<string, unknown>} input */
const call = (id, input) => ({ type: "tool_use", id, name: "Agent", input: { description: SECRET, prompt: SECRET, ...input } });

/** A repository and a Claude Code config folder beside it; `long` makes the repository's path past 200 characters. */
function fixture({ long = false, base = "repo" } = {}) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-agents-")));
  const repo = long ? join(box, ...Array.from({ length: 8 }, (_, i) => `a-rather-long-folder-name-${i}`), base) : join(box, base);
  mkdirSync(repo, { recursive: true });
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  put(join(repo, ".ennyn", "config.json"), JSON.stringify({ language: "en" }));
  const config = join(box, "cfg");
  // Claude Code names the folder from the path in NFC (2.1.310).
  const name = folderName(repo.normalize("NFC"));
  const folder = join(config, "projects", long ? `${name.slice(0, 200)}-1x2y3z` : name);
  mkdirSync(folder, { recursive: true });
  /** @param {string[]} args @param {Record<string, string>} [env] */
  const run = (args, env = {}) => {
    // The session that runs the tests is not the fixture's: a test that wants one names it.
    const { CLAUDE_CODE_SESSION_ID: _, ...outer } = process.env;
    const res = spawnSync(process.execPath, [CLI, "agents", ...args], { cwd: repo, encoding: "utf8", env: { ...outer, CLAUDE_CONFIG_DIR: config, ...env } });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return { box, repo, config, folder, run };
}

/** The session the brief names: two subagents, one asked sonnet and ran opus, one asked nothing. */
function session(folder, id = "s1", cwd = "") {
  lines(join(folder, `${id}.jsonl`), [
    { type: "user", cwd, message: { content: SECRET } },
    said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "general-purpose", model: "sonnet" }), call("t2", { subagent_type: "general-purpose" })]),
    // The same call on another kind of line, with another model: not the call.
    { type: "api-request-blob", message: { content: [call("t2", { subagent_type: "general-purpose", model: "haiku" })] } },
  ]);
  const sub = join(folder, id, "subagents");
  put(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, description: SECRET, toolUseId: "t1", model: "sonnet" }));
  lines(join(sub, "agent-a1.jsonl"), [
    { type: "user", timestamp: "2026-11-04T10:00:00.000Z", message: { content: SECRET } },
    said("m1", "claude-opus-5-5", usage(5, 100, 1000)),
    said("m1", "claude-opus-5-5", usage(9, 100, 1000)),
    said("m1", "claude-opus-5-5", usage(12, 100, 1000)),
    said("m2", "claude-opus-5-5", usage(7, 0, 500)),
    said("m3", "<synthetic>", usage(0, 0, 0)),
    "{not json",
  ]);
  put(join(sub, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, toolUseId: "t2" }));
  // Its last call has no usage: its context is unmeasured, not the call before it.
  lines(join(sub, "agent-a2.jsonl"), [{ ...said("m5", "claude-opus-5-5", usage(1, 1, 1)), timestamp: "2026-11-04T11:00:00.000Z" }, said("m4", "claude-opus-5-5", null)]);
}

test("agents: asked sonnet and ran opus is a mismatch; nothing asked is default and not compared; a message counts once; the last call's context apart from the sums", () => {
  const f = fixture();
  session(f.folder);
  const json = f.run(["--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.ok(!json.stdout.includes(SECRET), "no transcript text");
  const report = JSON.parse(json.stdout);
  assert.equal(report.session, "s1");
  assert.deepEqual(report.agents, [
    { id: "a1", type: "general-purpose", asked: "sonnet", from: "call", ran: { "claude-opus-5-5": 2 }, calls: 2, usageMissing: 0, output: 19, cacheWrite: 100, cacheRead: 1500, lastContext: 503, mismatch: true },
    { id: "a2", type: "general-purpose", asked: "default", from: null, ran: { "claude-opus-5-5": 2 }, calls: 2, usageMissing: 1, output: 1, cacheWrite: 1, cacheRead: 1, lastContext: null, mismatch: null },
  ]);
  assert.equal(report.mismatches, 1);
  assert.equal(report.skipped, 1);
  const text = f.run([]);
  assert.equal(text.code, 0, text.stderr);
  assert.ok(!text.stdout.includes(SECRET), "no transcript text");
  assert.ok(!text.stdout.includes(f.box), "no path");
  const out = text.stdout.split("\n");
  assert.equal(out[0], "Session s1: 2 subagents.");
  assert.equal(out[1], "a1 · general-purpose · asked sonnet · ran claude-opus-5-5 ×2 · output 19 · cache write 100 · cache read 1500 · context at the last call 503 · mismatch");
  assert.equal(out[2], "a2 · general-purpose · asked default · ran claude-opus-5-5 ×2 · output 1 · cache write 1 · cache read 1 · context at the last call unmeasured · usage unmeasured on 1 of 2 calls");
  assert.equal(out[3], "Mismatch: 1 of the 1 agents that asked for a model ran another: a1.");
  assert.match(text.stdout, /^An alias asked for can be mapped to another model by ANTHROPIC_DEFAULT_SONNET_MODEL, _OPUS_, _HAIKU_ or _FABLE_MODEL, which the transcript does not record: such a setting is one possible cause\.$/m);
  assert.match(text.stdout, /^Not compared: 1 agents/m);
  assert.match(text.stdout, /^1 transcript lines skipped: not JSON, or longer than 16 MB\.$/m);
});

test("agents: the record's model, an agent file's (read now), inherit against the parent's model, and unknown", () => {
  const f = fixture();
  lines(join(f.folder, "s1.jsonl"), [
    { type: "user", cwd: f.repo, message: { content: SECRET } },
    said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "fork" }), call("t2", { subagent_type: "checker" }), call("t3", { subagent_type: "other" }), call("t4", { subagent_type: "general-purpose", model: 7 }), call("t5", { subagent_type: "general-purpose" }), call("t6", { subagent_type: "half" })]),
  ]);
  put(join(f.repo, ".claude", "agents", "checker.md"), "---\nname: checker\nmodel: haiku\ndescription: x\n---\n\nBody.\n");
  put(join(f.config, "agents", "other.md"), "---\nname: other\nmodel: sonnet\n---\n");
  put(join(f.repo, ".claude", "agents", "other.md"), "---\nname: other\nmodel: opus\n---\n");
  // One file names no model, the other one: which one Claude Code takes is not read here.
  put(join(f.repo, ".claude", "agents", "half.md"), "---\nname: half\n---\n");
  put(join(f.config, "agents", "half.md"), "---\nname: half\nmodel: haiku\n---\n");
  const sub = join(f.folder, "s1", "subagents");
  const agent = (/** @type {string} */ id, /** @type {any} */ meta, /** @type {string} */ ran, /** @type {string} */ at) => {
    if (meta) put(join(sub, `agent-${id}.meta.json`), JSON.stringify(meta));
    lines(join(sub, `agent-${id}.jsonl`), [{ ...said(`m-${id}`, ran, usage(1, 2, 3)), timestamp: at }]);
  };
  agent("b1", { agentType: "fork", toolUseId: "t1", model: "inherit" }, "claude-sonnet-5-5", "2026-11-04T10:00:01Z");
  agent("b2", { agentType: "checker", isBuiltIn: false, toolUseId: "t2" }, "claude-haiku-5-5", "2026-11-04T10:00:02Z");
  agent("b3", { agentType: "other", isBuiltIn: false, toolUseId: "t3" }, "claude-opus-5-5", "2026-11-04T10:00:03Z");
  agent("b4", { agentType: "general-purpose", toolUseId: "gone", model: "sonnet" }, "claude-sonnet-5-5", "2026-11-04T10:00:04Z");
  agent("b5", null, "claude-opus-5-5", "2026-11-04T10:00:05Z");
  // Built in, but no call to tell whether a model was passed (a record from before 2.1.312 names none).
  agent("b6", { agentType: "general-purpose", isBuiltIn: true, toolUseId: "gone" }, "claude-opus-5-5", "2026-11-04T10:00:06Z");
  // A model given that is no model name: not "nothing asked".
  agent("b7", { agentType: "general-purpose", isBuiltIn: true, toolUseId: "t4" }, "claude-opus-5-5", "2026-11-04T10:00:07Z");
  // Nothing asked, a record from before the built-in flag, a built-in name no file defines: default.
  agent("b9", { agentType: "general-purpose", toolUseId: "t5" }, "claude-opus-5-5", "2026-11-04T10:00:09Z");
  agent("b10", { agentType: "half", isBuiltIn: false, toolUseId: "t6" }, "claude-opus-5-5", "2026-11-04T10:00:10Z");
  // A built-in name the record says is not built in, and no file: its definition is not here.
  agent("b11", { agentType: "general-purpose", isBuiltIn: false, toolUseId: "t5" }, "claude-opus-5-5", "2026-11-04T10:00:11Z");
  // A workflow's agents in a folder below.
  put(join(sub, "workflows", "w1", "agent-b8.meta.json"), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, toolUseId: "t9" }));
  lines(join(sub, "workflows", "w1", "agent-b8.jsonl"), [
    { ...said("m-b8", "claude-opus-5-5", usage(1, 1, 1), [call("t9", { subagent_type: "general-purpose", model: "haiku" })]), timestamp: "2026-11-04T10:00:08Z" },
  ]);
  const r = f.run(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  const got = Object.fromEntries(JSON.parse(r.stdout).agents.map((/** @type {any} */ a) => [a.id, [a.asked, a.from, a.mismatch]]));
  assert.deepEqual(got, {
    b1: ["inherit", "record", true],
    b2: ["haiku", "file", false],
    b3: ["unknown", null, null],
    b4: ["sonnet", "record", false],
    b5: ["unknown", null, null],
    b6: ["unknown", null, null],
    b7: ["unknown", null, null],
    b8: ["haiku", "call", true],
    b9: ["default", null, null],
    b10: ["unknown", null, null],
    b11: ["unknown", null, null],
  });
  const text = f.run([]);
  assert.match(text.stdout, /^b2 · checker · asked haiku \(agent file, read now\) · ran claude-haiku-5-5 ×1 · /m);
  assert.match(text.stdout, /^b5 · \? · asked unknown · /m);
  assert.match(text.stdout, /^Mismatch: 2 of the 4 agents that asked for a model ran another: b1, b8\.$/m);
});

test("agents: the newest session by default, one by id or by path; a missing folder or session says so with exit 1", () => {
  const f = fixture();
  assert.equal(f.run([]).code, 1, "an empty folder holds no session");
  assert.match(f.run([]).stderr, /^No Claude Code session transcript for this repository/);
  session(f.folder, "old");
  session(f.folder, "new");
  utimesSync(join(f.folder, "old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  assert.match(f.run([]).stdout, /^Session new: /);
  assert.match(f.run(["--session", "old"]).stdout, /^Session old: /);
  assert.match(f.run(["--session", join(f.folder, "old.jsonl")]).stdout, /^Session old: /);
  const none = f.run(["--session", "nope"]);
  assert.equal(none.code, 1);
  assert.equal(none.stderr, "No session transcript nope in this repository's Claude Code folder.\n");
  for (const bad of ["", "a b", "x;y"]) assert.equal(f.run(["--session", bad]).code, 2, JSON.stringify(bad));
  const elsewhere = f.run([], { CLAUDE_CONFIG_DIR: join(f.box, "nothing") });
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /^No Claude Code session transcript for this repository/);
});

test("agents: a path given by link reads the subagents beside the transcript it names; a missing path is no folder's (legacy audit)", () => {
  const f = fixture();
  session(f.folder);
  const link = join(f.box, "kept", "copy.jsonl");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(f.folder, "s1.jsonl"), link);
  const r = f.run(["--session", link, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.session, "s1");
  assert.deepEqual(report.agents.map((/** @type {{ id: string }} */ a) => a.id), ["a1", "a2"]);
  const none = f.run(["--session", join(f.box, "nope.jsonl")]);
  assert.equal(none.code, 1);
  assert.equal(none.stderr, "No session transcript nope at the path given.\n");
});

test("agents: with no --session, the session that runs the command (CLAUDE_CODE_SESSION_ID), else the newest, and the output says which (review round 1)", () => {
  const f = fixture();
  session(f.folder, "running");
  session(f.folder, "side");
  utimesSync(join(f.folder, "running.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  const mine = f.run(["--json"], { CLAUDE_CODE_SESSION_ID: "running" });
  assert.equal(mine.code, 0, mine.stderr);
  assert.equal(JSON.parse(mine.stdout).session, "running");
  assert.equal(JSON.parse(mine.stdout).chosen, "running");
  assert.match(f.run([], { CLAUDE_CODE_SESSION_ID: "running" }).stderr, /^Read: the session that runs this command \(CLAUDE_CODE_SESSION_ID\)\.$/m);
  // A running session whose transcript is not here (another folder's, or a link to nothing) is not the newest one.
  symlinkSync(join(f.box, "nothing.jsonl"), join(f.folder, "dangling.jsonl"));
  for (const id of ["elsewhere", "dangling"]) {
    const r = f.run([], { CLAUDE_CODE_SESSION_ID: id });
    assert.equal(r.code, 1, id);
    assert.equal(r.stdout, "", id);
    assert.equal(r.stderr, "The session that runs this command (CLAUDE_CODE_SESSION_ID) has no transcript in this repository's Claude Code folder. Give --session <id or path>.\n", id);
  }
  for (const [env, why] of [[{}, "is not set"], [{ CLAUDE_CODE_SESSION_ID: "../running" }, "is no session id"]]) {
    const r = f.run(["--json"], /** @type {Record<string, string>} */ (env));
    assert.equal(JSON.parse(r.stdout).session, "side", JSON.stringify(env));
    assert.equal(JSON.parse(r.stdout).chosen, "newest");
    assert.match(f.run([], /** @type {Record<string, string>} */ (env)).stderr, new RegExp(`^Read: the newest transcript in this repository's folder; CLAUDE_CODE_SESSION_ID ${why.replace(/[.()]/g, "\\$&")}\\.$`, "m"));
  }
  const given = f.run(["--session", "running", "--json"], { CLAUDE_CODE_SESSION_ID: "side" });
  assert.equal(JSON.parse(given.stdout).session, "running");
  assert.equal(JSON.parse(given.stdout).chosen, "given");
});

test("agents: a link kept with its subagents folder beside it reads that folder; without one, the target's (review round 1)", () => {
  const f = fixture();
  session(f.folder);
  const kept = join(f.box, "kept");
  mkdirSync(join(kept, "copy", "subagents"), { recursive: true });
  symlinkSync(join(f.folder, "s1.jsonl"), join(kept, "copy.jsonl"));
  writeFileSync(join(kept, "copy", "subagents", "agent-k1.jsonl"), JSON.stringify(said("k1m", "claude-opus-5-5", usage(1, 1, 1))) + "\n");
  const r = JSON.parse(f.run(["--session", join(kept, "copy.jsonl"), "--json"]).stdout);
  assert.equal(r.session, "copy");
  assert.deepEqual(r.agents.map((/** @type {{ id: string }} */ a) => a.id), ["k1"]);
});

test("agents: a path past 200 characters finds its folder by the prefix; two such folders are refused", () => {
  const f = fixture({ long: true });
  session(f.folder);
  const r = f.run([]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Session s1: 2 subagents\.$/m);
  mkdirSync(`${f.folder}9`);
  const two = f.run([]);
  assert.equal(two.code, 1);
  assert.match(two.stderr, /2 project folders share this repository's long name; give --session/);
});

test("agents: a line past the bound is skipped and counted, and the lines after it are read", () => {
  const f = fixture();
  session(f.folder);
  const path = join(f.folder, "s1", "subagents", "agent-a2.jsonl");
  put(path, `${JSON.stringify(said("big", "claude-opus-5-5", usage(1, 1, 1)))}${" ".repeat(READ_LINE_MAX)}\n${JSON.stringify(said("m4", "claude-opus-5-5", usage(2, 0, 0)))}\n`);
  const report = JSON.parse(f.run(["--json"]).stdout);
  assert.equal(report.skipped, 2, "the long line and the malformed one");
  assert.deepEqual(report.agents[1].ran, { "claude-opus-5-5": 1 });
  assert.equal(report.agents[1].output, 2);
});

test("agents: a call's context is its input, cache read and cache write, unmeasured when one is no count", () => {
  assert.equal(context(usage(7, 20, 500)), 523);
  assert.equal(context({ input_tokens: 1, cache_read_input_tokens: 2 }), null);
  assert.equal(context({ input_tokens: 1, cache_read_input_tokens: -2, cache_creation_input_tokens: 3 }), null);
});

test("agents: a fork's copy of the line that spawned it is the parent's call, not the fork's (review round 1)", () => {
  const f = fixture();
  const spawn = said("p1", "claude-opus-5-5", usage(40, 900, 9000), [call("t1", { subagent_type: "fork" })]);
  lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd: f.repo, message: { content: SECRET } }, spawn]);
  const sub = join(f.folder, "s1", "subagents");
  put(join(sub, "agent-f1.meta.json"), JSON.stringify({ agentType: "fork", toolUseId: "t1", model: "inherit" }));
  // Every fork transcript measured starts with the parent's spawning line, same message id and usage.
  lines(join(sub, "agent-f1.jsonl"), [spawn, said("m1", "claude-opus-5-5", usage(3, 10, 100))]);
  // A fork of an agent: the copy is of that agent's line.
  const inner = said("q1", "claude-opus-5-5", usage(50, 800, 8000), [call("t2", { subagent_type: "fork" })]);
  put(join(sub, "agent-g9.meta.json"), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, toolUseId: "t9" }));
  lines(join(sub, "agent-g9.jsonl"), [inner]);
  put(join(sub, "agent-g2.meta.json"), JSON.stringify({ agentType: "fork", toolUseId: "t2", model: "inherit" }));
  lines(join(sub, "agent-g2.jsonl"), [inner, said("m2", "claude-opus-5-5", usage(4, 20, 200))]);
  const agents = Object.fromEntries(JSON.parse(f.run(["--json"]).stdout).agents.map((/** @type {any} */ a) => [a.id, [a.calls, a.output, a.cacheWrite, a.cacheRead, a.lastContext]]));
  assert.deepEqual(agents.f1, [1, 3, 10, 100, 113]);
  assert.deepEqual(agents.g2, [1, 4, 20, 200, 223]);
  assert.deepEqual(agents.g9, [1, 50, 800, 8000, 8803], "the agent's own line stays its own");
});

test("agents: the project's agent files are read only for a session that ran at this repository's top (review round 1)", () => {
  const f = fixture();
  put(join(f.repo, ".claude", "agents", "checker.md"), "---\nname: checker\nmodel: sonnet\n---\n");
  const sub = join(f.folder, "s1", "subagents");
  put(join(sub, "agent-c1.meta.json"), JSON.stringify({ agentType: "checker", toolUseId: "t1" }));
  lines(join(sub, "agent-c1.jsonl"), [said("m1", "claude-opus-5-5", usage(1, 1, 1))]);
  put(join(sub, "agent-c2.meta.json"), JSON.stringify({ agentType: "general-purpose", toolUseId: "t2" }));
  lines(join(sub, "agent-c2.jsonl"), [said("m2", "claude-opus-5-5", usage(1, 1, 1))]);
  const asked = (/** @type {string} */ cwd) => {
    lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd, message: { content: SECRET } }, said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "checker" }), call("t2", { subagent_type: "general-purpose" })])]);
    return JSON.parse(f.run(["--json"]).stdout).agents.map((/** @type {any} */ a) => [a.id, a.asked, a.from]);
  };
  assert.deepEqual(asked(f.repo), [["c1", "sonnet", "file"], ["c2", "default", null]]);
  // Another project's session, read with --session from here: this repository's files say nothing of it.
  assert.deepEqual(asked(join(f.box, "elsewhere")), [["c1", "unknown", null], ["c2", "unknown", null]]);
  assert.deepEqual(asked(""), [["c1", "unknown", null], ["c2", "unknown", null]], "no cwd on any line");
  // The session's folder is where it started: a later line in another folder (a cd) does not move it.
  lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd: f.repo }, { type: "user", cwd: join(f.box, "elsewhere") }, said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "checker" }), call("t2", { subagent_type: "general-purpose" })])]);
  assert.deepEqual(JSON.parse(f.run(["--json"]).stdout).agents.map((/** @type {any} */ a) => a.asked), ["sonnet", "default"]);
});

test("agents: a built-in name in a record without the flag is default only while no agent file takes that name (review round 1)", () => {
  const f = fixture();
  lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd: f.repo, message: { content: SECRET } }, said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "Explore" })])]);
  const sub = join(f.folder, "s1", "subagents");
  put(join(sub, "agent-e1.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "t1" }));
  lines(join(sub, "agent-e1.jsonl"), [said("m1", "claude-opus-5-5", usage(1, 1, 1))]);
  const asked = () => JSON.parse(f.run(["--json"]).stdout).agents[0].asked;
  assert.equal(asked(), "default");
  put(join(f.config, "agents", "explore.md"), "---\nname: Explore\nmodel: haiku\n---\n");
  assert.equal(asked(), "haiku");
});

test("agents: the folder is named from the path in NFC, or by CLAUDE_CODE_PROJECT_DIR_NAME with a config folder set (review round 1)", () => {
  const f = fixture({ base: "cafe\u0301-repo" });
  session(f.folder, "s1", f.repo);
  const r = f.run([]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Session s1: 2 subagents\.$/m);
  session(join(f.config, "projects", "named-1"), "s2", f.repo);
  assert.match(f.run([], { CLAUDE_CODE_PROJECT_DIR_NAME: "named-1" }).stdout, /^Session s2: /);
  // A name Claude Code refuses (its shape, a device name of Windows) is no name: the path's folder is read.
  for (const bad of ["named/1", "con", "a".repeat(65)]) assert.match(f.run([], { CLAUDE_CODE_PROJECT_DIR_NAME: bad }).stdout, /^Session s1: /, bad);
  assert.equal(namedFolder({ CLAUDE_CODE_PROJECT_DIR_NAME: "named-1" }), null, "only with a config folder set");
  assert.equal(namedFolder({ CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "a".repeat(64) }), "a".repeat(64));
  // The session's cwd in the other normalization is still this top: its agent file is read.
  put(join(f.repo, ".claude", "agents", "checker.md"), "---\nname: checker\nmodel: sonnet\n---\n");
  for (const cwd of [f.repo.normalize("NFC"), f.repo.normalize("NFD")]) {
    lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd, message: { content: SECRET } }, said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "checker" })])]);
    put(join(f.folder, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "checker", toolUseId: "t1" }));
    assert.equal(JSON.parse(f.run(["--json"]).stdout).agents.find((/** @type {any} */ a) => a.id === "a1").asked, "sonnet", cwd === f.repo ? "as written" : "the other form");
  }
});

test("agents: the summary says a mismatch of a full id, of inherit and of an alias, the remap only for the alias, and no mismatch only when there is none (review round 2)", () => {
  const f = fixture();
  const summary = (/** @type {Record<string, unknown>} */ input, /** @type {Record<string, unknown>} */ meta, /** @type {string} */ ran) => {
    lines(join(f.folder, "s1.jsonl"), [{ type: "user", cwd: f.repo }, said("p1", "claude-opus-5-5", usage(1, 1, 1), [call("t1", { subagent_type: "general-purpose", ...input })])]);
    put(join(f.folder, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, toolUseId: "t1", ...meta }));
    lines(join(f.folder, "s1", "subagents", "agent-a1.jsonl"), [said("m1", ran, usage(1, 1, 1))]);
    const r = f.run([]);
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.split("\n").slice(2, -2);
  };
  const MISMATCH = "Mismatch: 1 of the 1 agents that asked for a model ran another: a1.";
  const REMAP = /^An alias asked for can be mapped/;
  const full = summary({ model: "claude-sonnet-5-5" }, {}, "claude-opus-5-5");
  assert.deepEqual(full, [MISMATCH], "a full id");
  const inherit = summary({}, { model: "inherit" }, "claude-sonnet-5-5");
  assert.deepEqual(inherit, [MISMATCH], "inherit");
  const alias = summary({ model: "sonnet" }, {}, "claude-opus-5-5");
  assert.equal(alias.length, 2, "an alias");
  assert.equal(alias[0], MISMATCH);
  assert.match(alias[1], REMAP);
  assert.deepEqual(summary({ model: "sonnet" }, {}, "claude-sonnet-5-5"), ["No mismatch: each of the 1 agents that asked for a model ran it."], "none");
});

test("agents: web-fetch and teammate are built in (Claude Code 2.1.310) (review round 2)", () => {
  assert.ok(BUILT_IN.includes("web-fetch") && BUILT_IN.includes("teammate"));
});

test("agents: an agent file's front matter gives its name and model", () => {
  assert.deepEqual(agentFileFields("---\nname: a\nmodel: 'sonnet'\n---\n"), { name: "a", model: "sonnet" });
  assert.deepEqual(agentFileFields("---\nname: \"a\"\n---\nmodel: opus\n"), { name: "a", model: null });
  assert.deepEqual(agentFileFields("---\nmodel:\n---\n"), { name: null, model: null });
  assert.equal(agentFileFields("model: opus\n"), null);
});

/**
 * The alias rule's corpus: [asked, ran, parent, expected]. Aliases are the Agent call's (2.1.310: opus, sonnet,
 * haiku, fable); ids as transcripts and providers spell them.
 */
const CORPUS = /** @type {const} */ ([
  // accept
  ["sonnet", "claude-sonnet-5-5", null, true],
  ["haiku", "claude-haiku-5-5", null, true],
  ["opus", "claude-opus-5-5", null, true],
  ["opus", "claude-opus-4-8", null, true],
  ["fable", "claude-fable-5", null, true],
  ["sonnet", "claude-3-5-sonnet-20241022", null, true],
  ["sonnet", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", null, true],
  ["Sonnet", "claude-sonnet-5-5", null, true],
  ["sonnet[1m]", "claude-sonnet-4-5", null, true],
  ["claude-sonnet-5-5", "claude-sonnet-5-5", null, true],
  ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", null, true],
  ["claude-sonnet-4-5", "claude-sonnet-4-5@20250929", null, true],
  ["claude-sonnet-4-5-20250929", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", null, true],
  ["claude-opus-5-5[1m]", "claude-opus-5-5", null, true],
  ["CLAUDE-OPUS-5-5", "claude-opus-5-5", null, true],
  ["inherit", "claude-opus-5-5", "claude-opus-5-5", true],
  // reject
  ["sonnet", "claude-opus-5-5", null, false],
  ["haiku", "claude-sonnet-5-5", null, false],
  ["opus", "claude-sonnet-5-5", null, false],
  ["opus", "claude-opusplan-5", null, false],
  ["sonnet", "claude-sonnets-5", null, false],
  ["claude-sonnet-4-5", "claude-sonnet-4-6", null, false],
  ["claude-sonnet-4", "claude-sonnet-4-5", null, false],
  ["claude-opus-5-5", "claude-opus-5-5-fast", null, false],
  ["claude-opus-5-5", "claude-opus-4-8", null, false],
  ["inherit", "claude-sonnet-5-5", "claude-opus-5-5", false],
  // not compared
  ["default", "claude-opus-5-5", null, null],
  ["unknown", "claude-opus-5-5", null, null],
  ["opusplan", "claude-opus-5-5", null, null],
  ["inherit", "claude-opus-5-5", null, null],
  ["inherit", "claude-opus-5-5", "inherit", null],
]);

test("agents: a model that ran matches the one asked by its alias as a whole word, by its id, or by the parent's for inherit", () => {
  const wrong = CORPUS.filter(([asked, ran, parent, want]) => modelMatches(asked, ran, parent) !== want);
  assert.deepEqual(wrong, []);
});
