/**
 * The eval checks' self-test, replayed: every check plugin-eval's cases will use (test/eval/checks.mjs) passes on its
 * passing references and fails on its failing ones as `claude plugin eval` itself graded them, with no model call
 * (test/eval/selftest.mjs records it), and the eval tool read each grader as it is written. A check or grader edited
 * without taking the record again fails here; `node test/eval/selftest.mjs check` asks the machine's eval tool. What
 * no check reads honestly is judged, and the run the recorder starts is held shut here, piece by piece.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { ALLOWED, CALLS, CHECKS, JUDGED, NEVER, REFERENCES, SUBAGENTS, fateOf, graderFile, traceCalls } from "./eval/checks.mjs";
import { NO_NETWORK, NotMeasured, RECORD, SANDBOX, canaryProblems, exitOf, newRunDirs, plan, pluginFiles, problems, readRecord, recordRuns, runPlan, unseal } from "./eval/selftest.mjs";

/** The open nodes of the work graph: a `gap:` or an `until` names one. */
async function openNodes() {
  const top = join(RECORD, "..", "..", "..");
  const config = loadConfig({ cwd: top, env: {} });
  const graph = await loadGraph({ cwd: top, config });
  const f = config.graph.fields;
  return new Set(graph.open.filter((n) => n[f.status] !== config.graph.doneStatus).map((n) => String(n[f.id])));
}

test("eval selftest: every check grades its references as it must, reading each grader as written", () => {
  const lines = problems(readRecord());
  assert.equal(lines.join("\n"), "", `test/eval/selftest.json: ${lines.length} problem(s). A check whose grader or references changed is recorded again (node test/eval/selftest.mjs record); a reference it reads the other way goes into its limits, with why.`);
});

test("eval selftest: every check has a passing and a failing reference it reads right, and every reference is a check's", () => {
  assert.match(readRecord().claudeCode, /^\d+\.\d+\.\d+$/);
  const named = new Set();
  for (const [id, c] of Object.entries(CHECKS)) {
    const limits = Object.keys(c.limits ?? {});
    assert.ok(c.pass.some((r) => !limits.includes(r)), `${id}: no passing reference it reads right`);
    assert.ok(c.fail.some((r) => !limits.includes(r)), `${id}: no failing reference it reads right`);
    assert.deepEqual(c.pass.filter((r) => c.fail.includes(r)), [], `${id}: a reference on both sides`);
    assert.deepEqual(limits.filter((r) => !c.pass.includes(r) && !c.fail.includes(r)), [], `${id}: a limit on no side`);
    assert.ok(["regex", "tool_used"].includes(c.grader.type), `${id}: ${c.grader.type} is not a grader read here with no model call`);
    // The file the record was taken from: front matter of one field a line, each value JSON text.
    const lines = graderFile(c.grader).split("\n");
    assert.deepEqual([lines[0], ...lines.slice(-2)], ["---", "---", ""], `${id}: not front matter alone`);
    assert.deepEqual(Object.fromEntries(lines.slice(1, -2).map((l) => [l.slice(0, l.indexOf(": ")), JSON.parse(l.slice(l.indexOf(": ") + 2))])), c.grader, `${id}: a field not written as JSON text`);
    for (const r of [...c.pass, ...c.fail]) {
      assert.ok(r in REFERENCES, `${id}: no reference ${r}`);
      named.add(r);
    }
  }
  assert.deepEqual(Object.keys(REFERENCES).filter((r) => !named.has(r)), [], "a reference no check names");
  for (const [r, ref] of Object.entries({ ...REFERENCES, ...SUBAGENTS })) for (const k of ref.calls) assert.ok(k in CALLS, `${r}: no call ${k}`);
  const reached = new Set(Object.values(CALLS).flatMap((c) => (c.sub ? [c.sub] : [])));
  for (const sub of reached) assert.ok(sub in SUBAGENTS, `no subagent ${sub}`);
  assert.deepEqual(Object.keys(SUBAGENTS).filter((s) => !reached.has(s)), [], "a subagent no call starts");
  // A signal only the plugin's own text can give (Ennyn's name) is shown for the with-arm and never scored.
  for (const [id, c] of Object.entries(CHECKS)) if (/ennyn/i.test(JSON.stringify(c.grader))) assert.equal(/** @type {any} */ (c.grader).arm, "with-only", `${id}: names Ennyn, so only the with-arm can pass it`);
});

test("eval selftest: what no check reads is judged, and each limit says why in the reference grammar, naming open nodes", async () => {
  const open = await openNodes();
  for (const [id, c] of Object.entries(CHECKS)) {
    for (const [r, why] of Object.entries(c.limits ?? {})) {
      const m = /^(?:gap: ([\w-]+)$|meant: \S)/.exec(why);
      assert.ok(m, `${id} ${r}: a limit is "gap: <open node>" or "meant: …", not ${JSON.stringify(why)}`);
      if (m[1]) assert.ok(open.has(m[1]), `${id} ${r}: ${m[1]} is no open node`);
    }
  }
  for (const [id, j] of Object.entries(JUDGED)) {
    assert.ok(!(id in CHECKS), `${id}: judged and a check`);
    assert.match(j.why, /^measured on [^:]{4,}: \S/, `${id}: a reason says what it was measured on`);
    for (const node of j.until ?? []) assert.ok(open.has(node), `${id}: ${node} is no open node`);
  }
  // A hook's deny exists only in the with-arm, and a refusal given is the agent's words: no node makes it a check.
  assert.equal(JUDGED["call-refused"].until, undefined);
});

test("eval selftest: the calls let through are the read-only ones it names, and no Bash call started", () => {
  const rec = readRecord();
  for (const k of ALLOWED) assert.ok(k in CALLS, `ALLOWED: no call ${k}`);
  for (const [k, call] of Object.entries(CALLS)) assert.ok(!String(call.input.command ?? "").trimStart().startsWith(NEVER), `${k}: a command the self-test grants`);
  for (const ref of plan().keys()) {
    const calls = traceCalls(ref);
    if (!calls.length) assert.ok(!(ref in rec.calls), `${ref}: a call recorded for a reference that makes none`);
    else assert.deepEqual(rec.calls[ref], calls.map(fateOf), `${ref}: ${calls.join(", ")}`);
    for (const [i, k] of calls.entries()) if (CALLS[k].name === "Bash") assert.notEqual(rec.calls[ref][i], "ran", `${ref}: ${k} started`);
  }
  assert.deepEqual(Object.keys(rec.calls).filter((r) => !plan().has(r)), [], "a call recorded for no reference");
});

test("eval selftest: the recorder's run is shut: its profile, arguments, environment, plugin and canary", () => {
  const profile = NO_NETWORK(4321, "/private/tmp/en-pe-x");
  const own = '(subpath "/private/tmp/en-pe-x") (regex #"^/private/tmp/e-[A-Za-z0-9]+(/|$)")';
  assert.equal(profile, `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:4321"))(allow network-outbound (remote unix-socket (require-any ${own})))(deny file-write* (require-not (require-any ${own} (subpath "/dev"))))`);
  const { file, args, env } = runPlan({ bin: "claude", port: 4321, root: "/private/tmp/en-pe-x", plugin: "/private/tmp/en-pe-x/plugin", report: "/private/tmp/en-pe-x/out/report.json" });
  assert.equal(file, SANDBOX);
  assert.deepEqual(args.slice(0, 6), ["-p", profile, "claude", "plugin", "eval", "/private/tmp/en-pe-x/plugin"]);
  for (const a of ["--no-publish", "--no-scaffold", "--trust-plugin", "--keep-temp"]) assert.ok(args.includes(a), a);
  for (const [a, v] of [["--mocks", "record"], ["--allow-tools", `Bash(${NEVER}:*)`], ["--ablation", "none"], ["--runs", "1"]]) assert.equal(args[args.indexOf(a) + 1], v, a);
  for (const a of ["--scaffold", "--allow-real-servers", "--publish-report", "--model", "--judge-model"]) assert.ok(!args.includes(a), a);
  assert.equal(args.filter((a) => a === "--allow-tools").length, 1, "one grant");
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "GIT_CONFIG_NOSYSTEM", "HOME", "PATH", "TMPDIR", "XDG_RUNTIME_DIR"]);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4321");
  assert.match(env.ANTHROPIC_API_KEY, /^sk-ant-stand-in-0+$/);
  for (const k of /** @type {const} */ (["HOME", "TMPDIR", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR", "XDG_RUNTIME_DIR"])) assert.ok(env[k].startsWith("/private/tmp/en-pe-x/"), k);
  // The plugin holds a manifest and the cases: no hook, skill, agent, server or scaffold.
  const { files, cases } = pluginFiles(plan());
  assert.equal(cases.size, plan().size);
  for (const path of Object.keys(files)) assert.match(path, /^(?:\.claude-plugin\/plugin\.json|evals\/r\d{3}\/(?:prompt\.md|graders\/[\w-]+\.md))$/, path);
  assert.deepEqual(JSON.parse(files[".claude-plugin/plugin.json"]), { name: "en-selftest", version: "0.0.0" });
  for (const [path, text] of Object.entries(files)) if (path.endsWith("prompt.md")) assert.match(text, /\nallowed_tools: \["Read", "Glob", "Agent", "Bash\(en-selftest-never:\*\)"\]\n/, path);
  // The canary's judge: what the profile measured on this machine (2.1.310 era, macOS), and each way it fails.
  const shut = { remote: "EPERM", lookup: "ENOTFOUND", resolve: "ECONNREFUSED", local: "connected" };
  assert.deepEqual(canaryProblems(shut), []);
  assert.match(canaryProblems({ ...shut, remote: "timeout" }).join(), /192\.0\.2\.1 was not refused/);
  assert.match(canaryProblems({ ...shut, lookup: "resolved" }).join(), /a name was looked up \(lookup/);
  assert.match(canaryProblems({ ...shut, resolve: "resolved" }).join(), /a name was looked up \(resolve/);
  assert.match(canaryProblems({ ...shut, local: "EPERM" }).join(), /the stand-in was not reached/);
});

test("eval selftest control: a moved verdict or call, a grader read otherwise, an edited reference and a missing or extra entry are found", () => {
  const rec = readRecord();
  const copy = () => JSON.parse(JSON.stringify(rec));
  const moved = copy();
  moved.runs.quiet["doctor-called"] = !moved.runs.quiet["doctor-called"];
  assert.match(problems(moved).join("\n"), /^quiet: doctor-called passed, must fail$/m);
  const limit = copy();
  limit.runs["grep-doctor"]["doctor-called"] = false;
  assert.match(problems(limit).join("\n"), /^grep-doctor: doctor-called failed, must pass \(limit: meant: /m);
  const read = copy();
  read.graders["doctor-called"].min = 0;
  assert.match(problems(read).join("\n"), /^doctor-called: the eval tool read the grader as /m);
  const gone = copy();
  delete gone.runs["three-calls"];
  assert.match(problems(gone).join("\n"), /^three-calls: not recorded$/m);
  const check = copy();
  delete check.runs.core["doctor-called"];
  assert.match(problems(check).join("\n"), /^core: doctor-called not recorded$/m);
  const fate = copy();
  fate.calls.status = ["ran"];
  assert.match(problems(fate).join("\n"), /^status: calls \["ran"\], must be \["unstarted"\]/m);
  const said = copy();
  said.said.quiet = "0000000000000000";
  assert.match(problems(said).join("\n"), /^quiet: the reference changed since the record$/m);
  const extra = copy();
  extra.graders.nothing = { type: "regex" };
  extra.runs["two-calls"]["doctor-called"] = false;
  extra.runs.nobody = {};
  assert.match(problems(extra).join("\n"), /^two-calls: doctor-called recorded, the check does not name it$/m);
  assert.match(problems(extra).join("\n"), /^nobody: recorded, no check names it$/m);
  assert.match(problems(extra).join("\n"), /^nothing: recorded, no such check$/m);
});

test("eval selftest: the recorder runs the canary first, spawns only what runPlan builds, and leaves no run directory a killed eval made", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-rec-")));
  const runRoot = join(tmp, "runs");
  mkdirSync(join(runRoot, "e-before1"), { recursive: true });
  const shut = () => ({ remote: "EPERM", lookup: "ENOTFOUND", resolve: "ECONNREFUSED", local: "connected" });
  /** @type {any[][]} */
  const order = [];
  /** An eval that makes its run directories, seals one with a session file in it, and dies before it says anything. @param {string} file @param {string[]} args @param {any} opts */
  const dies = (file, args, opts) => {
    order.push(["spawn", file, args, opts.env]);
    for (const name of ["e-Ab12Cd", "e-Ef34Gh"]) mkdirSync(join(runRoot, name, "sealed", "home"), { recursive: true });
    writeFileSync(join(runRoot, "e-Ab12Cd", "sealed", "home", "session.jsonl"), "{}\n");
    chmodSync(join(runRoot, "e-Ab12Cd", "sealed"), 0);
    chmodSync(join(runRoot, "e-Ab12Cd"), 0o500);
    const child = Object.assign(new EventEmitter(), { pid: undefined, stderr: Object.assign(new EventEmitter(), { setEncoding() {} }) });
    setImmediate(() => child.emit("close", null));
    return child;
  };
  const o = { version: () => "2.1.310", hasSandbox: () => true, stray: () => [], tmp, runRoot };
  await assert.rejects(recordRuns("claude", { ...o, spawnRun: dies, runCanary: (/** @type {number} */ port, /** @type {string} */ root) => (order.push(["canary", port, root]), shut()) }), /exited null/);
  assert.deepEqual(order.map((x) => x[0]), ["canary", "spawn"], "the canary runs before the eval");
  const [, port, root] = order[0];
  const { file, args, env } = runPlan({ bin: "claude", port, root, plugin: join(root, "plugin"), report: join(root, "out", "report.json") });
  assert.deepEqual(order[1].slice(1), [file, args, env], "the eval is spawned as runPlan builds it");
  assert.deepEqual(readdirSync(runRoot), ["e-before1"], "a run directory the eval made is removed, one that was there before is kept");
  assert.ok(!existsSync(root), "the recorder's own directory is removed");
  // A profile the canary finds open: the eval never starts.
  order.length = 0;
  await assert.rejects(recordRuns("claude", { ...o, spawnRun: dies, runCanary: () => ({ ...shut(), remote: "timeout" }) }), /does not shut the run off: a connection to 192\.0\.2\.1/);
  assert.deepEqual(order, []);
  await assert.rejects(recordRuns("claude", { ...o, hasSandbox: () => false, spawnRun: dies, runCanary: shut }), NotMeasured);
  // A run directory that cannot be removed fails the run, saying so.
  /** @param {string} file @param {string[]} args @param {any} opts */
  const locks = (file, args, opts) => {
    const child = dies(file, args, opts);
    chmodSync(runRoot, 0o500);
    return child;
  };
  try {
    await assert.rejects(recordRuns("claude", { ...o, spawnRun: locks, runCanary: shut }), /exited null[\s\S]*\nrun directories left in .*: e-Ab12Cd, e-Ef34Gh$/);
  } finally {
    chmodSync(runRoot, 0o700);
  }
});

test("eval selftest: a run directory is one the eval made during the run, and unsealing removes it whole", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "en-runs-")));
  for (const name of ["e-old123", "notes", "e-x.y"]) mkdirSync(join(root, name));
  const before = new Set(readdirSync(root));
  const since = Date.now() - 1000;
  for (const name of ["e-new456", "e-x_z"]) mkdirSync(join(root, name, "sealed", "home"), { recursive: true });
  writeFileSync(join(root, "e-new456", "f"), "x");
  assert.deepEqual(newRunDirs(root, before, since), ["e-new456"], "a new name the eval tool gives (e- and letters or digits), not one there before");
  assert.deepEqual(newRunDirs(root, before, Date.now() + 60_000), [], "made before the run began");
  chmodSync(join(root, "e-new456", "sealed"), 0);
  chmodSync(join(root, "e-new456"), 0o500);
  unseal(join(root, "e-new456"));
  unseal(join(root, "notes"));
  assert.deepEqual(readdirSync(root).sort(), ["e-old123", "e-x.y", "e-x_z", "notes"]);
});

test("eval selftest: a machine with no sandbox-exec fails check, saying it did not measure", () => {
  assert.deepEqual(exitOf(new NotMeasured("not measured: no sandbox-exec"), "check"), { code: 1, out: "not measured: no sandbox-exec\n" });
  assert.deepEqual(exitOf(new Error("boom"), "record"), { code: 1, err: "boom\n" });
});
