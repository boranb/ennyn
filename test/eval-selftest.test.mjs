/**
 * The eval checks' self-test, replayed: every check plugin-eval's cases will use (test/eval/checks.mjs) passes on its
 * passing references and fails on its failing ones as `claude plugin eval` itself graded them, with no model call
 * (test/eval/selftest.mjs records it), and the eval tool read each grader as it is written. A check or grader edited
 * without taking the record again fails here; `node test/eval/selftest.mjs check` asks the machine's eval tool. What
 * no check reads honestly is judged, and the run the recorder starts is held shut here, piece by piece.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { ALLOWED, CALLS, CHECKS, JUDGED, NEVER, REFERENCES, SUBAGENTS, fateOf, graderFile, traceCalls } from "./eval/checks.mjs";
import { WRAPPERS, realGit, shq, writeGitPath } from "./eval/git-path.mjs";
import { CONFIG_INSTRUCTIONS, CONTROLS, GIT_CELLS, EVALS, HOME_INSTRUCTIONS, INSTRUCTIONS, NO_NETWORK, PROGRAMS, NotMeasured, RECORD, SANDBOX, callsOf, canaryProblems, exitOf, exitsOf, gitCases, gitMoves, gitPluginFiles, gitProblems, gitRunPlan, keptCwd, watchSockets, landedIn, newRunDirs, outboundOf, plan, plantedHome, plantedInstructions, pluginFiles, problems, readGitRecord, readRecord, readTrace, recordGit, recordRuns, runPlan, scaffolded, treeOf, unseal } from "./eval/selftest.mjs";

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

test("eval selftest: the git cells: with the git path an arm commits and pushes; a landing without it is a note; the operator's home and the planted instructions are denied", async () => {
  const rec = readGitRecord();
  assert.match(rec.claudeCode, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(gitProblems(rec.cells), []);
  assert.deepEqual(Object.keys(rec.cells), Object.keys(GIT_CELLS));
  const open = await openNodes();
  for (const [cell, c] of Object.entries(GIT_CELLS)) if (c.kind === "gap") assert.ok(open.has(String(c.gap)), `${cell}: ${c.gap} is no open node`);
  assert.deepEqual(Object.entries(GIT_CELLS).filter(([, c]) => c.kind === "deny").map(([cell]) => cell), ["home-read", "home-instructions"]);
  assert.deepEqual([rec.cells["home-read"], rec.cells["home-instructions"]], [{ readable: false }, { reached: [], ran: [] }], "the record says denied");
  assert.deepEqual(GIT_CELLS["home-read-tool"], { kind: "gap", gap: "eval-arm-read-tool-home" }, "the Read tool under the eval's path grant: a gap, recorded, naming the node that would close it");
  for (const [cell, c] of Object.entries(GIT_CELLS)) assert.notEqual(c.gap, "eval-arm-reads-home", `${cell}: no gap names the node this cell's task closes`);
  // The plain record holds no git cell: check and record keep the outer sandbox, the git run is its own command.
  assert.ok(!("git" in readRecord()), "selftest.json holds no git cell");
  const cells = () => JSON.parse(JSON.stringify(rec.cells));
  for (const wrapped of [{ exits: [0, 0], landed: false }, { exits: [0, 1], landed: true }, { exits: [0, "error"], landed: true }, { exits: [], landed: true }, { exits: [0], landed: true }]) {
    assert.match(gitProblems({ ...cells(), "git-wrapped": wrapped }).join("\n"), /^git-wrapped: exits .*: the arms' git does not commit and push through the git path$/m, JSON.stringify(wrapped));
  }
  assert.deepEqual(gitProblems({ ...cells(), "git-unwrapped": { landed: true } }), [], "a landing without the git path is no problem");
  // A deny cell fails whenever it reads otherwise than denied, whatever the record says.
  assert.match(gitProblems({ ...cells(), "home-read": { readable: true } }).join("\n"), /^home-read: \{"readable":true\}: an arm's Bash read the canary file in the operator's home$/m);
  for (const [reached, ran] of [[["claude-md"], []], [["memory", "memory-dir"], []], [["home-rules"], []], [[], ["mcp"]], [[], []]]) {
    const one = reached.length || ran.length ? { reached, ran } : { reached };
    assert.match(gitProblems({ ...cells(), "home-instructions": one }).join("\n"), /^home-instructions: \{.+\}: a request of an arm carried planted instructions, or a planted hook or server ran$/m, JSON.stringify(one));
  }
  for (const odd of [{}, { readable: "false" }, { readable: false, more: 1 }]) assert.equal(gitProblems({ ...cells(), "home-read": odd }).length, 1, JSON.stringify(odd));
  const missing = cells();
  delete missing["git-wrapped"];
  assert.match(gitProblems(missing).join("\n"), /^git-wrapped: not recorded$/m);
  assert.match(gitProblems({ ...cells(), "git-other": { landed: false } }).join("\n"), /^git-other: recorded, no such git cell$/m);
  // What moved against the record: a git or gap cell fails; the cell without the git path only notes, naming both causes.
  assert.deepEqual(gitMoves(rec.cells, rec.cells), { fail: [], notes: [] });
  const moved = gitMoves({ ...cells(), "git-wrapped": { exits: [0, 128], landed: false }, "home-read": { readable: true } }, rec.cells);
  assert.match(moved.fail.join("\n"), /^git-wrapped: the arm now gives \{"exits":\[0,128\],"landed":false\}, recorded \{"exits":\[0,0\],"landed":true\}$/m);
  assert.match(moved.fail.join("\n"), /^home-read: the arm now gives \{"readable":true\}, recorded \{"readable":false\}$/m);
  const landed = gitMoves({ ...cells(), "git-unwrapped": { landed: true } }, rec.cells);
  assert.deepEqual(landed.fail, []);
  assert.match(landed.notes.join("\n"), /^git-unwrapped: the push landed with no git path: Claude Code's credential-helper deny changed, or this git keeps its helpers outside the folders Claude Code scans/m);
  assert.equal(gitMoves({ ...cells(), "git-unwrapped": { landed: true } }, { ...rec.cells, "git-unwrapped": { landed: true } }).notes.length, 1, "said whenever it lands");
  assert.deepEqual(gitMoves(rec.cells, undefined).fail.length, Object.keys(GIT_CELLS).filter((c) => GIT_CELLS[c].kind !== "note").length, "no record: every judged cell is new");
});

test("eval selftest: the git run is the recorder's environment with the git path first, proxies to a dead port, the operator's home as HOME, scaffolds on and no outer profile", () => {
  const o = { bin: "claude", port: 4321, root: "/private/tmp/en-pg-x", plugin: "/private/tmp/en-pg-x/plugin", report: "/private/tmp/en-pg-x/out/report.json" };
  const { file, args, env } = gitRunPlan({ ...o, gitPath: "/private/tmp/en-pg-x/plugin/git-path", home: "/opt/op-home" });
  const shut = runPlan(o);
  assert.equal(file, "claude", "the eval tool's own sandbox cannot start under another");
  assert.deepEqual(args.slice(0, 3), ["plugin", "eval", "/private/tmp/en-pg-x/plugin"]);
  for (const a of ["--no-publish", "--scaffold", "--trust-plugin", "--keep-temp"]) assert.ok(args.includes(a), a);
  for (const [a, v] of [["--mocks", "record"], ["--allow-tools", "Bash"], ["--ablation", "none"], ["--runs", "1"]]) assert.equal(args[args.indexOf(a) + 1], v, a);
  // The eval's grant is the one lever a path rule reaches the arms by (a case's allowed_tools rule has none, 2.1.310): only
  // the eval that runs the Read tool's gap case is given one.
  const granted = gitRunPlan({ ...o, gitPath: "/private/tmp/en-pg-x/plugin/git-path", home: "/opt/op-home", allow: "Bash,Read(//**)" });
  assert.deepEqual(granted.args, args.map((a) => (a === "Bash" ? "Bash,Read(//**)" : a)));
  assert.deepEqual(EVALS.map((e) => [e.cases, e.home, e.allow]), [[["git-net", "git-wrapped", "git-unwrapped", "home-read"], "operator", "Bash"], [["home-instructions"], "stand-in", "Bash"], [["home-read-tool"], "operator", "Bash,Read(//**)"]]);
  for (const a of ["--no-scaffold", "--allow-real-servers", "--publish-report", "--model", "--judge-model"]) assert.ok(!args.includes(a), a);
  const own = { HTTPS_PROXY: undefined, HTTP_PROXY: undefined, NO_PROXY: undefined, HOME: undefined };
  assert.deepEqual({ ...env, PATH: shut.env.PATH, ...own }, { ...shut.env, ...own }, "the same key, base URL, directories and switches");
  // The eval denies its arms the HOME it is given: the operator's; its configuration stays the recorder's.
  assert.equal(env.HOME, "/opt/op-home");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/private/tmp/en-pg-x/cfg");
  assert.equal(shut.env.HOME, "/private/tmp/en-pg-x/home", "the plain run keeps a home of its own");
  assert.equal(env.PATH, `/private/tmp/en-pg-x/plugin/git-path:${shut.env.PATH}`);
  assert.deepEqual([env.HTTPS_PROXY, env.HTTP_PROXY, env.NO_PROXY], ["http://127.0.0.1:9", "http://127.0.0.1:9", "127.0.0.1,localhost"]);
  // The plain run is held where it was: under the profile, scaffolds off, no proxy.
  assert.equal(shut.file, SANDBOX);
  assert.ok(shut.args.includes("--no-scaffold") && !("HTTPS_PROXY" in shut.env));
  // A case a cell, in case.yaml with its scaffold; the canary's and the home read's have none.
  const gitPath = "/private/tmp/en-pg-x/plugin/git-path.x*[y]";
  const cases = gitCases({ gitPath, homeFile: "/private/tmp/en-pg-x/home/.en-eval-home-it's", standInCanary: "/private/tmp/en-pg-x/oph/.en-eval-canary" });
  assert.deepEqual(Object.keys(cases), ["git-net", ...Object.keys(GIT_CELLS)]);
  const { files, cases: names } = gitPluginFiles(cases);
  assert.deepEqual([...names.values()], Object.keys(cases));
  for (const path of Object.keys(files)) assert.match(path, /^(?:\.claude-plugin\/plugin\.json|evals\/g\d{3}\/(?:case\.yaml|scaffold\.sh))$/, path);
  for (const [name, cell] of names) {
    const yaml = files[`evals/${name}/case.yaml`];
    assert.ok(yaml.includes(`\n  prompt: "selftest git ${cell}"\n  max_turns: ${cases[cell].calls.length + 3}\n  allowed_tools: ["Bash"]\n`), cell);
    assert.equal(yaml.includes('scaffold_script: "scaffold.sh"'), Boolean(cases[cell].scaffold), cell);
    assert.equal(files[`evals/${name}/scaffold.sh`], cases[cell].scaffold || undefined, cell);
  }
  assert.equal(cases["home-read"].scaffold, "");
  assert.deepEqual(cases["home-instructions"], { scaffold: "", calls: ["sleep 2; env", { name: "Read", input: { file_path: "/private/tmp/en-pg-x/oph/.en-eval-canary" } }], text: "Done." }, "what it reads is the requests: the arm's environment and its Read of the stand-in home's canary go into them; its first call holds its eval open for the socket watch");
  // The planted instructions: the eval's own configuration, each file a marker of the run's token.
  const planted = plantedInstructions("/private/tmp/en-pg-x/cfg", "/private/tmp/en-pg-x/work", "0123abcd".padEnd(32, "f"));
  assert.deepEqual(Object.keys(planted.markers), CONFIG_INSTRUCTIONS);
  assert.deepEqual(INSTRUCTIONS, [...CONFIG_INSTRUCTIONS, ...HOME_INSTRUCTIONS]);
  for (const [name, word] of Object.entries(planted.markers)) assert.equal(word, `en-eval-${name}-0123abcd`);
  assert.deepEqual(Object.keys(planted.files), ["CLAUDE.md", "rules/en-eval.md", "projects/-private-tmp-en-pg-x-work/memory/MEMORY.md", "auto-memory/MEMORY.md", "settings.json"].map((p) => `/private/tmp/en-pg-x/cfg/${p}`));
  for (const name of CONFIG_INSTRUCTIONS) assert.equal(Object.values(planted.files).filter((t) => t.includes(planted.markers[name])).length, 1, name);
  // The stand-in home: its .claude's instructions, a hook and a server that log and speak, and the key approved.
  const ph = plantedHome("/private/tmp/en-pg-x/oph", "/private/tmp/en-pg-x/bin/log.sh", "/private/tmp/en-pg-x/ran.log", "0123abcd".padEnd(32, "f"), "/private/tmp/en-pg-x/work");
  assert.deepEqual(Object.keys(ph.markers), HOME_INSTRUCTIONS);
  assert.deepEqual(HOME_INSTRUCTIONS, ["home-claude-md", "home-rules", "home-memory", "home-env", "home-hook", "home-inline", "home-canary"]);
  assert.deepEqual(Object.keys(ph.files), [".claude/CLAUDE.md", ".claude/rules/en-eval.md", ".claude/projects/-private-tmp-en-pg-x-work/memory/MEMORY.md", ".claude/settings.json", ".claude.json", ".en-eval-canary"].map((p) => `/private/tmp/en-pg-x/oph/${p}`).concat("/private/tmp/en-pg-x/bin/log.sh"));
  for (const name of HOME_INSTRUCTIONS) assert.ok(Object.values(ph.files).some((t) => t.includes(ph.markers[name])), name);
  const settings = JSON.parse(ph.files["/private/tmp/en-pg-x/oph/.claude/settings.json"]);
  assert.deepEqual(settings.env, { EN_EVAL_HOME_ENV: "en-eval-home-env-0123abcd" });
  assert.deepEqual(settings.permissions, { allow: ["Read(//**)", "Read(~/**)"] }, "a grant that would hand an arm the home through Read");
  const hooks = settings.hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit"]);
  for (const at of Object.values(hooks)) assert.deepEqual(at[0].hooks.map((/** @type {any} */ h) => h.command), ["'/private/tmp/en-pg-x/bin/log.sh' hook", 'echo en-eval-home-inline-0123abcd "$EN_EVAL_HOME_ENV"'], "the logger, and an inline hook that needs no file");
  assert.equal(ph.files["/private/tmp/en-pg-x/oph/.en-eval-canary"], "en-eval-home-canary-0123abcd\n");
  const hj = JSON.parse(ph.files["/private/tmp/en-pg-x/oph/.claude.json"]);
  assert.deepEqual(hj.mcpServers, { "en-eval": { command: "/private/tmp/en-pg-x/bin/log.sh", args: ["mcp"] } });
  assert.match(ph.files["/private/tmp/en-pg-x/bin/log.sh"], /^#!\/bin\/sh\necho "\$1" >> '\/private\/tmp\/en-pg-x\/ran\.log'\necho en-eval-home-hook-0123abcd\n$/);
  assert.deepEqual(CONTROLS, { config: { reached: ["claude-md", "rules", "memory-dir"], ran: [] }, home: { reached: HOME_INSTRUCTIONS, ran: PROGRAMS } });
  assert.deepEqual(JSON.parse(planted.files["/private/tmp/en-pg-x/cfg/settings.json"]), { autoMemoryDirectory: "/private/tmp/en-pg-x/cfg/auto-memory" });
  const scaffold = cases["git-wrapped"].scaffold.split("\n");
  for (const line of ["set -e", "git init -q --bare --ref-format=files remote.git", "git init -q -b main --ref-format=files work", "git -C work remote add origin ../remote.git"]) assert.ok(scaffold.includes(line), line);
  assert.equal(cases["git-unwrapped"].scaffold, cases["git-wrapped"].scaffold);
  // Without the git path: the same calls, with the git path taken out of PATH by its value, wherever it stands.
  const [strip] = cases["git-unwrapped"].calls.map((c, i) => c.slice(0, c.length - cases["git-wrapped"].calls[i].length));
  assert.deepEqual(cases["git-unwrapped"].calls, cases["git-wrapped"].calls.map((c) => strip + c));
  for (const [before, after] of [[`${gitPath}:/usr/bin:/bin`, "/usr/bin:/bin"], [`/usr/bin:${gitPath}:/bin`, "/usr/bin:/bin"], ["/usr/bin:/private/tmp/en-pg-x/plugin/git-pathxzy:/bin", "/usr/bin:/private/tmp/en-pg-x/plugin/git-pathxzy:/bin"], [`/usr/bin:${gitPath}/sub:/bin`, `/usr/bin:${gitPath}/sub:/bin`]]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `${strip}printf %s "$PATH"`], { encoding: "utf8", env: { ...process.env, PATH: before } }), after, before);
  }
  assert.match(cases["git-net"].calls[0], /^node -e '[\s\S]*192\.0\.2\.1[\s\S]*' 1$/);
  assert.deepEqual(cases["home-read"].calls, [`cat '/private/tmp/en-pg-x/home/.en-eval-home-it'\\''s' 2>&1 || echo denied`]);
  assert.deepEqual(cases["home-read-tool"], { scaffold: "", calls: ["sleep 2", { name: "Read", input: { file_path: "/private/tmp/en-pg-x/home/.en-eval-home-it's" } }], text: "Done." });
  // An arm's canary need not reach the stand-in; every other way it fails is the same.
  assert.deepEqual(canaryProblems({ remote: "EPERM", lookup: "ENOTFOUND", resolve: "ECONNREFUSED", local: "EPERM" }, false), []);
  assert.match(canaryProblems({}, false).join(), /192\.0\.2\.1 was not refused \(undefined\)/);
});

test("eval selftest: the socket watch reads a connection past loopback from lsof, and the stand-in's to show it sees the run", () => {
  const text = [
    "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
    "claude  101 boran   20u  IPv4 0x1      0t0  TCP 127.0.0.1:50001->127.0.0.1:4321 (ESTABLISHED)",
    "claude  101 boran   21u  IPv6 0x2      0t0  TCP [::1]:50002->[::1]:8080 (ESTABLISHED)",
    "claude  101 boran   22u  IPv4 0x3      0t0  TCP 127.0.0.1:61567 (LISTEN)",
    "claude  102 boran   23u  IPv4 0x4      0t0  TCP 10.0.0.5:50003->160.79.104.10:443 (SYN_SENT)",
    "claude  102 boran   24u  IPv4 0x5      0t0  UDP 10.0.0.5:50004->192.168.1.1:53",
    "zsh     103 boran   25u  IPv4 0x6      0t0  TCP 127.0.0.2:50005->127.0.0.9:9",
  ].join("\n");
  assert.deepEqual(outboundOf(text, 4321), { standIn: true, others: ["claude 102 boran 23u IPv4 0x4 0t0 TCP 10.0.0.5:50003->160.79.104.10:443 (SYN_SENT)", "claude 102 boran 24u IPv4 0x5 0t0 UDP 10.0.0.5:50004->192.168.1.1:53"] });
  assert.deepEqual(outboundOf(text, 4322).standIn, false);
  assert.deepEqual(outboundOf("", 4321), { standIn: false, others: [] });
  assert.deepEqual(treeOf(1, " 1 0\n 2 1\n 3 2\n 4 9\n 5 1\n"), [1, 2, 3, 5]);
});

test("eval selftest: the git path runs the real git by its absolute path, for git and the two programs git starts by name", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-gp-")));
  // A git whose layout is git's own: <prefix>/bin/git and <prefix>/libexec/git-core.
  const prefix = join(tmp, "it's here");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "libexec", "git-core"), { recursive: true });
  const real = join(prefix, "bin", "git");
  writeFileSync(real, `#!/bin/sh\nif [ "$1" = --version ]; then echo "git version 9.9"; else printf '%s|' "$0" "$@"; fi\n`);
  chmodSync(real, 0o755);
  const onPath = join(tmp, "path");
  mkdirSync(onPath);
  /** @param {string} execPath @param {string} version */
  const shim = (execPath, version) => {
    writeFileSync(join(onPath, "git"), `#!/bin/sh\ncase "$1" in --exec-path) echo '${execPath.replace(/'/g, `'\\''`)}';; --version) echo '${version}';; esac\n`);
    chmodSync(join(onPath, "git"), 0o755);
  };
  shim(join(prefix, "libexec", "git-core"), "git version 9.9");
  assert.equal(realGit(`${onPath}:/usr/bin:/bin`, process.env), real);
  shim(join(prefix, "libexec", "git-core"), "git version 1.0");
  assert.throws(() => realGit(`${onPath}:/usr/bin:/bin`, process.env), /is git version 9\.9, git on PATH is git version 1\.0/);
  shim("libexec/git-core", "git version 9.9");
  assert.throws(() => realGit(`${onPath}:/usr/bin:/bin`, process.env), /no absolute path/);
  shim(join(tmp, "elsewhere", "libexec", "git-core"), "git version 9.9");
  assert.throws(() => realGit(`${onPath}:/usr/bin:/bin`, process.env), /no git at /);
  mkdirSync(join(tmp, "elsewhere", "bin", "git"), { recursive: true });
  assert.throws(() => realGit(`${onPath}:/usr/bin:/bin`, process.env), /no git at /, "a folder named git");
  // Each script starts the real git by its path, quoted, with the command it stands for.
  const dir = writeGitPath(join(tmp, "git-path"), real);
  assert.deepEqual(readdirSync(dir).sort(), WRAPPERS.map(([name]) => name).sort());
  for (const [name, sub] of WRAPPERS) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o755, name);
    const out = execFileSync(join(dir, name), ["a b", "c"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
    assert.equal(out, [real, ...(sub ? [sub] : []), "a b", "c", ""].join("|"), name);
  }
  assert.deepEqual(WRAPPERS, [["git", ""], ["git-receive-pack", "receive-pack"], ["git-upload-pack", "upload-pack"]]);
  assert.throws(() => writeGitPath(dir, real), /EEXIST/, "never into a folder that is there");
  mkdirSync(join(tmp, "empty"));
  assert.throws(() => writeGitPath(join(tmp, "empty"), real), /EEXIST/, "nor into an empty one");
  assert.throws(() => writeGitPath(join(tmp, "other"), "git"), /absolute path/);
  assert.ok(!existsSync(join(tmp, "other")));
});

test("eval selftest: a git cell's exits are read from the trace, its landing from the kept run directory's ref files", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-gc-")));
  /** @param {string} id */
  const use = (id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
  /** @param {string} id @param {unknown} content @param {boolean} [error] */
  const result = (id, content, error) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(error === undefined ? {} : { is_error: error }) }] } });
  const events = [
    use("a"), result("a", "Exit code 72\nxcode-select: Failed to locate 'git'", true),
    use("b"), result("b", "(Bash completed with no output)"),
    use("c"), result("c", "<tool_use_error>Blocked</tool_use_error>", true),
    use("d"),
    use("e"),
    use("f"), result("f", [{ type: "text", text: "Exit code 1" }], true),
    use("g"), result("g", "Exit code 12abc"),
    { type: "result", permission_denials: [{ tool_use_id: "d" }] },
  ];
  writeFileSync(join(tmp, "trace.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`);
  assert.deepEqual(exitsOf(readTrace(join(tmp, "trace.jsonl"))), [72, 0, "error", "refused", "unanswered", 1, 0]);
  // The plain run's fates read as they did: only sandbox-exec's refusal as the whole text is `unstarted`.
  const UN = "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted";
  const forms = [UN, [{ type: "text", text: UN }], [{ type: "text", text: "Exit code 71\n" }, { type: "text", text: "sandbox-exec: sandbox_apply: Operation not permitted" }], [{ type: "image", source: {} }, { type: "text", text: UN }]];
  writeFileSync(join(tmp, "fates.jsonl"), forms.flatMap((c, i) => [use(`u${i}`), result(`u${i}`, c, true)]).map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual(callsOf(join(tmp, "fates.jsonl")), ["unstarted", "ran", "ran", "ran"]);
  // The kept run directory: <run>/out/trace.jsonl, the cwd sealed in <run>/sealed/home/cwd.
  const runRoot = join(tmp, "runs");
  const run = join(runRoot, "e-Ab12Cd");
  const cwd = join(run, "sealed", "home", "cwd");
  const commit = `${"a1".repeat(20)}\n`;
  for (const [path, text] of [["work/.git/HEAD", "ref: refs/heads/main\n"], ["remote.git/HEAD", "ref: refs/heads/main\n"], ["work/.git/refs/heads/main", commit], ["remote.git/refs/heads/main", commit]]) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  mkdirSync(join(run, "out"));
  chmodSync(join(run, "sealed"), 0);
  assert.equal(keptCwd(join(run, "out", "trace.jsonl"), runRoot), cwd);
  assert.ok(scaffolded(cwd) && landedIn(cwd), "the sealed cwd is opened for reading");
  assert.equal(keptCwd(join(run, "out", "trace.jsonl"), tmp), null, "a run directory of another root");
  assert.equal(keptCwd(join(runRoot, "e-x_y", "out", "trace.jsonl"), runRoot), null, "a name the eval tool does not give");
  const remote = join(cwd, "remote.git", "refs", "heads", "main");
  for (const [text, landed] of [[`${"b2".repeat(20)}\n`, false], [`${"a1".repeat(20)}`, false], [`${"a1".repeat(32)}\n`, false], [commit, true]]) {
    writeFileSync(remote, /** @type {string} */ (text));
    assert.equal(landedIn(cwd), landed, JSON.stringify(text));
  }
  const work = join(cwd, "work", ".git", "refs", "heads", "main");
  for (const f of [work, remote]) writeFileSync(f, commit.trim());
  assert.equal(landedIn(cwd), false, "refs not written as git writes them (no newline)");
  writeFileSync(work, commit);
  execFileSync("/bin/rm", [remote]);
  assert.equal(landedIn(cwd), false, "no remote ref");
  symlinkSync("../../../work/.git/refs/heads/main", remote);
  assert.equal(readFileSync(remote, "utf8"), commit, "a link short enough to pass the size limit");
  assert.equal(landedIn(cwd), false, "a ref that is a link is no ref read");
  execFileSync("/bin/rm", [join(cwd, "remote.git", "HEAD")]);
  assert.equal(scaffolded(cwd), false);
  assert.equal(scaffolded(join(tmp, "nowhere")), false);
  chmodSync(join(run, "sealed"), 0o700);
});

test("eval selftest: the git run writes the git path into its plugin and a canary in the home, is spawned as gitRunPlan builds it, reads each cell and leaves nothing", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-grec-")));
  const runRoot = join(tmp, "runs");
  const home = join(tmp, "home");
  mkdirSync(join(runRoot, "e-before1"), { recursive: true });
  mkdirSync(home);
  /** @type {any[]} */
  const spawned = [];
  /**
   * An eval that plays each case against the stand-in, keeps a run directory a case (sealed, as 2.1.310 leaves it) and
   * reports. `landed`: the cells whose push lands; `net`: the canary's output; `home`: the home read's output (else the
   * canary file's text, read as the arm would); `skip`: a cell left out of the report; `short`: a cell whose run stops a
   * turn early; `jump`: a cell whose second turn the arm skips, so its text comes after one call; `bare`: a cell with no
   * scaffolded repositories in its cwd; `drop`: a cell whose trace loses its last call.
   * `homeRead`: the home read's output from the canary file's path; `readTool`: the Read tool's result. `leak`: files of
   * the eval's configuration (`~/` of its HOME) whose text every request carries, as a system prompt would; `hooks`: the
   * HOME's planted hook runs in the eval. `escape`: a cell whose requests write each dash as a JSON escape, which the
   * stand-in parses as the same text and a scan of the body's bytes does not see. A control (sandbox-exec, claude -p)
   * sends one request carrying what Claude Code loads from its configuration, or its HOME's .claude with the hook's and
   * the server's output, unless `deaf` names it; `controlRuns`: what of the logger the home control runs. The home control
   * also runs the inline hook with the settings' env and reads the canary its prompt's script names. `envOut`: the
   * instructions case's env output; `homeTool`: its Read of the stand-in home's canary.
   * @param {{ net?: string, home?: string, homeRead?: (file: string) => string, readTool?: { content: string, is_error?: boolean }, envOut?: string, homeTool?: { content: string, is_error?: boolean }, landed?: Record<string, boolean>, skip?: string, short?: string, bare?: string, jump?: string, drop?: string, leak?: string[], hooks?: boolean, escape?: string, deaf?: string, controlRuns?: string[] }} play
   */
  const evalWith = (play) => (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const cfg = opts.env.CLAUDE_CONFIG_DIR;
    const child = Object.assign(new EventEmitter(), { pid: undefined, stderr: Object.assign(new EventEmitter(), { setEncoding() {} }) });
    const runLogger = (/** @type {string} */ h, /** @type {string} */ what) => {
      const settings = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
      const command = what === "mcp" ? shq(JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")).mcpServers["en-eval"].command) + " mcp" : settings.hooks.SessionStart[0].hooks[0].command;
      return execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    };
    if (file === SANDBOX) {
      const name = cfg ? "config" : "home";
      controls.push([args, opts.env]);
      const runs = play.controlRuns ?? ["hook", "mcp"];
      // A control whose hook does not run still carries its marker (the logger's text), so only what ran differs.
      const logger = cfg ? "" : JSON.parse(readFileSync(join(opts.env.HOME, ".claude.json"), "utf8")).mcpServers["en-eval"].command;
      const h = opts.env.HOME;
      const homeSide = () => {
        const settings = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
        const memory = join(h, ".claude", "projects", String(opts.cwd).replace(/[^A-Za-z0-9]/g, "-"));
        return [
          ...[".claude/CLAUDE.md", ".claude/rules/en-eval.md"].map((f) => readFileSync(join(h, f), "utf8")),
          ...readdirSync(memory, { recursive: true }).map(String).filter((f) => f.endsWith("MEMORY.md")).map((f) => readFileSync(join(memory, f), "utf8")),
          ...runs.map((r) => runLogger(h, r)),
          runs.includes("hook") ? "" : readFileSync(logger, "utf8"),
          execFileSync("/bin/sh", ["-c", settings.hooks.SessionStart[0].hooks[1].command], { encoding: "utf8", env: { ...process.env, ...settings.env } }),
          readFileSync(join(h, ".en-eval-canary"), "utf8"),
        ];
      };
      const loaded = play.deaf === name ? [] : cfg ? ["CLAUDE.md", "rules/en-eval.md", "auto-memory/MEMORY.md"].map((f) => readFileSync(join(cfg, f), "utf8")) : homeSide();
      fetch(`${opts.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", system: loaded.join("\n"), tools: [{ name: "Bash" }], messages: [{ role: "user", content: args[4] }] }) }).then((r) => r.text()).then(() => child.emit("close", 0), () => child.emit("close", 1));
      return child;
    }
    const which = Number(/out(\d?)/.exec(args[args.indexOf("--json") + 1])?.[1] || 1) - 1;
    const second = which === 1;
    spawned.push([file, args, opts.env, readFileSync(join(opts.env.PATH.split(":")[0], "git"), "utf8"), readdirSync(home).map((f) => [f, statSync(join(home, f)).mode & 0o777]), readdirSync(cfg, { recursive: true }).map(String).sort(), which]);
    const key = join(args[2], "..", "work").replace(/[^A-Za-z0-9]/g, "-");
    const system = (play.leak ?? []).filter((f) => second || !f.startsWith("~/")).map((f) => readFileSync(f.startsWith("~/") ? join(opts.env.HOME, f.slice(2).replace("{cwd}", key)) : join(cfg, f.replace("{work}", key)), "utf8")).join("\n");
    if (second && play.hooks) runLogger(opts.env.HOME, "hook");
    // A planted env or permission that reached the second eval's arm: its env output or its Read carries the marker.
    (async () => {
      const report = args[args.indexOf("--json") + 1];
      const evals = join(args[2], "evals");
      const cases = [];
      for (const name of readdirSync(evals).sort()) {
        const cell = /prompt: "selftest git ([\w-]+)"/.exec(readFileSync(join(evals, name, "case.yaml"), "utf8"))?.[1] ?? "";
        if (cell === play.skip) continue;
        /** @type {any[]} */
        const messages = [{ role: "user", content: `selftest git ${cell}` }];
        const events = [];
        for (let turn = 0; ; turn++) {
          const json = JSON.stringify({ model: "m", system, tools: [{ name: "Bash" }], messages });
          const res = await fetch(`${opts.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: cell === play.escape ? json.replace(/-/g, "\\u002d") : json });
          const command = /"partial_json":"((?:[^"\\]|\\.)*)"/.exec(await res.text());
          if (!command) break;
          const input = JSON.parse(JSON.parse(`"${command[1]}"`));
          const c = input.command ?? "";
          const id = `${cell}-${turn}`;
          const read = /^cat '([^']+)'/.exec(c);
          const tool = !input.file_path ? undefined : cell === "home-read-tool" ? (play.readTool ?? { content: readFileSync(input.file_path, "utf8") }) : (play.homeTool ?? { content: "<tool_use_error>refused</tool_use_error>", is_error: true });
          const text = tool ? tool.content : cell === "home-instructions" ? (play.envOut ?? "HOME=/h\nPATH=/bin\n") : cell === "home-read-tool" ? "" : cell === "git-net" ? (play.net ?? JSON.stringify({ remote: "EPERM", lookup: "ENOTFOUND", resolve: "ECONNREFUSED", local: "EPERM" })) : cell === "home-read" ? (play.home ?? (read ? (play.homeRead ?? ((f) => readFileSync(f, "utf8")))(read[1]) : "")) : play.landed?.[cell] ? "" : "Exit code 72\nxcode-select";
          events.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: tool ? "Read" : "Bash", input: {} }] } });
          events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(tool?.is_error ? { is_error: true } : {}) }] } });
          messages.push({ role: "assistant", content: "x" }, { role: "user", content: [{ type: "tool_result", content: text }] });
          if (cell === play.jump && turn === 0) messages.push({ role: "assistant", content: "x" });
          if (cell === play.short && turn === 1) break;
        }
        if (cell === play.drop) events.splice(-2);
        const run = join(runRoot, `e-${["", "h", "t"][which]}${name}x`);
        const cwd = join(run, "sealed", "home", "cwd");
        mkdirSync(join(run, "out"), { recursive: true });
        if (["git-wrapped", "git-unwrapped"].includes(cell) && cell !== play.bare) {
          const commit = `${"c3".repeat(20)}\n`;
          const files = { "work/.git/HEAD": "ref: refs/heads/main\n", "remote.git/HEAD": "ref: refs/heads/main\n", ...(play.landed?.[cell] ? { "work/.git/refs/heads/main": commit, "remote.git/refs/heads/main": commit } : {}) };
          for (const [path, text] of Object.entries(files)) {
            mkdirSync(join(cwd, path, ".."), { recursive: true });
            writeFileSync(join(cwd, path), text);
          }
          chmodSync(join(run, "sealed"), 0);
        }
        writeFileSync(join(run, "out", "trace.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
        cases.push({ name, arms: { with: [{ error: null, tracePath: join(run, "out", "trace.jsonl") }] } });
      }
      writeFileSync(report, JSON.stringify({ cases }));
      child.emit("close", 0);
    })().catch((e) => child.emit("close", (spawned.push(["error", e]), 1)));
    return child;
  };
  /** A socket watch that saw `seen`. @param {{ others: string[], standIn: boolean, stuck?: boolean }} seen */
  const watching = (seen) => () => ({ stop: async () => seen });
  /** @type {any[]} */
  const controls = [];
  const o = { git: () => "/opt/x/bin/git", hasSandbox: () => true, stray: () => [], tmp, runRoot, home, watch: watching({ others: [], standIn: true }) };
  const listening = () => ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => process.listenerCount(sig));
  const before = listening();
  const cells = await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true } }) });
  assert.deepEqual(listening(), before, "no signal handler is left behind");
  assert.deepEqual(cells, { "git-wrapped": { exits: [0, 0], landed: true }, "git-unwrapped": { landed: false }, "home-read": { readable: true }, "home-read-tool": { readable: true }, "home-instructions": { reached: [], ran: [] } });
  assert.equal(spawned.length, 3, "three evals");
  const [file, args, env, script, inHome, inCfg] = spawned[0];
  const root = join(args[2], "..");
  const port = Number(new URL(env.ANTHROPIC_BASE_URL).port);
  assert.deepEqual([file, args, env], Object.values(gitRunPlan({ bin: "claude", port, root, plugin: join(root, "plugin"), report: join(root, "out", "report.json"), gitPath: join(root, "plugin", "git-path"), home })));
  assert.equal(env.HOME, home, "the eval's HOME is the home the canary is in");
  // The second eval: the instructions case alone, HOME the stand-in home in the recorder's directory, the same stand-in;
  // the third: the Read tool's gap case alone, the only eval granted a path rule.
  assert.deepEqual(spawned[1].slice(0, 3), Object.values(gitRunPlan({ bin: "claude", port, root, plugin: join(root, "plugin2"), report: join(root, "out2", "report.json"), gitPath: join(root, "plugin", "git-path"), home: join(root, "oph") })));
  assert.deepEqual(spawned[2].slice(0, 3), Object.values(gitRunPlan({ bin: "claude", port, root, plugin: join(root, "plugin3"), report: join(root, "out3", "report.json"), gitPath: join(root, "plugin", "git-path"), home, allow: "Bash,Read(//**)" })));
  for (const s of spawned) assert.equal(s[4].length, 1, "the canary stays in the operator's home while every eval runs");
  // The controls: a plain claude -p under the recorder's profile, given the configuration, then the stand-in home alone.
  assert.equal(controls.length, 2);
  for (const [i, [cargs, cenv]] of controls.entries()) {
    const cport = Number(new URL(cenv.ANTHROPIC_BASE_URL).port);
    assert.notEqual(cport, port, "a stand-in of its own");
    assert.deepEqual(cargs, ["-p", NO_NETWORK(cport, root), "claude", "-p", i ? "selftest git control-home" : "selftest control", "--setting-sources", "user"]);
    assert.deepEqual([cenv.HOME, cenv.CLAUDE_CONFIG_DIR], i ? [join(root, "oph"), undefined] : [join(root, "home"), join(root, "cfg")]);
  }
  for (const p of ["CLAUDE.md", "rules/en-eval.md", "auto-memory/MEMORY.md", "settings.json", `projects/${join(root, "work").replace(/[^A-Za-z0-9]/g, "-")}/memory/MEMORY.md`]) assert.ok(inCfg.includes(p), `${p} planted in the eval's configuration: ${inCfg.join(", ")}`);
  assert.equal(script, "#!/bin/sh\nexec '/opt/x/bin/git' \"$@\"\n", "the git path in the plugin, the arms can read it");
  assert.equal(inHome.length, 1, "one canary file in the home while the eval runs");
  assert.match(inHome[0][0], /^\.en-eval-home-[0-9a-f]{8}$/);
  assert.equal(inHome[0][1], 0o600, "readable by its owner alone");
  assert.deepEqual(readdirSync(home), [], "the canary file is removed after");
  assert.deepEqual(readdirSync(runRoot), ["e-before1"], "every run directory the git run made is removed, one that was there before is kept");
  assert.ok(!existsSync(root), "the recorder's own directory is removed");
  // Readable when the output holds this run's token, whatever Claude Code adds after it; denied only on cat's refusal by
  // the sandbox and the echo after it; any other output measured nothing, and the run is not recorded.
  const violations = "\n<sandbox_violations>\nfile-read-data /x\n</sandbox_violations>";
  const refused = "cat: /h/.en-eval-home-x: Operation not permitted\ndenied";
  for (const home of [`${refused}\n`, `${refused}${violations}`]) {
    assert.deepEqual((await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, home }) }))["home-read"], { readable: false }, JSON.stringify(home));
  }
  for (const home of ["denied\n", `denied${violations}`, "cat: x: No such file or directory\ndenied\n", "", "cat: x: Operation not permitted\n"]) {
    await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, home }) }), /^home-read: the arm's read neither printed the canary nor showed the sandbox's refusal: /m, JSON.stringify(home));
  }
  // The Read tool's gap: readable on the token, not on a refusal or an error; any other result measured nothing.
  for (const [readTool, readable] of /** @type {[any, boolean][]} */ ([[{ content: "<tool_use_error>File is in a directory that is denied</tool_use_error>", is_error: true }, false]])) {
    assert.deepEqual((await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, readTool }) }))["home-read-tool"], { readable }, JSON.stringify(readTool));
  }
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, readTool: { content: "" } }) }), /^home-read-tool: the Read call neither gave the canary nor was refused: ""$/m);
  const withToken = (/** @type {string} */ f) => readFileSync(f, "utf8") + violations;
  assert.deepEqual((await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, homeRead: withToken }) }))["home-read"], { readable: true });
  // Each planted file whose text a request carried is named, in INSTRUCTIONS' order; a run with none names none; a
  // planted hook that ran in an eval is named by what it logged and by its output, if a request carried it.
  for (const [leak, reached] of /** @type {[string[], string[]][]} */ ([[["CLAUDE.md"], ["claude-md"]], [["auto-memory/MEMORY.md", "rules/en-eval.md"], ["rules", "memory-dir"]], [["projects/{work}/memory/MEMORY.md"], ["memory"]], [["~/.claude/CLAUDE.md", "~/.claude/rules/en-eval.md"], ["home-claude-md", "home-rules"]], [["settings.json"], []], [["~/.claude/settings.json"], ["home-env", "home-inline"]], [["~/.claude/projects/{cwd}/memory/MEMORY.md"], ["home-memory"]]])) {
    assert.deepEqual((await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, leak }) }))["home-instructions"], { reached, ran: [] }, JSON.stringify(leak));
  }
  assert.deepEqual((await recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, hooks: true }) }))["home-instructions"], { reached: [], ran: ["hook"] });
  // The planted env in the arm's environment, the planted grant letting the arm's Read reach the stand-in home's canary.
  const word = (/** @type {string} */ n) => `en-eval-${n}-0123abcd`;
  const t = { ...o, token: "0123abcd".padEnd(32, "e") };
  assert.deepEqual((await recordGit("claude", { ...t, spawnRun: evalWith({ landed: { "git-wrapped": true }, envOut: `HOME=/h\nEN_EVAL_HOME_ENV=${word("home-env")}\n` }) }))["home-instructions"], { reached: ["home-env"], ran: [] });
  assert.deepEqual((await recordGit("claude", { ...t, spawnRun: evalWith({ landed: { "git-wrapped": true }, homeTool: { content: `${word("home-canary")}\n` } }) }))["home-instructions"], { reached: ["home-canary"], ran: [] });
  // Either call that measured nothing: the run is not recorded.
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, envOut: "" }) }), /^home-instructions: the arm's env printed no environment: ""$/m);
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({ landed: { "git-wrapped": true }, homeTool: { content: "" } }) }), /^home-instructions: the arm's Read of the stand-in home's canary neither gave it nor was refused: ""$/m);
  // A canary name already taken: the run stops, and the file it did not write stays.
  writeFileSync(join(home, ".en-eval-home-0123abcd"), "someone else's\n");
  await assert.rejects(recordGit("claude", { ...o, token: "0123abcd".padEnd(32, "0"), spawnRun: evalWith({}) }), /EEXIST/);
  assert.equal(readFileSync(join(home, ".en-eval-home-0123abcd"), "utf8"), "someone else's\n");
  execFileSync("/bin/rm", [join(home, ".en-eval-home-0123abcd")]);
  // Each way a run cannot be recorded: nothing is recorded, and nothing is left.
  const fails = /** @type {[object, RegExp][]} */ ([
    [{ net: JSON.stringify({ remote: "timeout", lookup: "ENOTFOUND", resolve: "ECONNREFUSED" }) }, /the arms' network is not shut: a connection to 192\.0\.2\.1 was not refused \(timeout\)/],
    [{ net: "zsh: command not found: node" }, /^git-net: the arms' canary did not run: zsh: command not found: node$/m],
    [{ net: "42" }, /^git-net: the arms' canary did not run: 42$/m],
    [{ skip: "git-net" }, /^git-net: no case in the report$/m],
    [{ skip: "git-unwrapped" }, /^Error: the git run cannot be recorded:\ngit-unwrapped: no case in the report$/m],
    [{ short: "git-wrapped" }, /^git-wrapped: the run did not follow the script \(2 of 2 calls, 0 texts\)$/m],
    [{ jump: "git-wrapped" }, /^git-wrapped: the run did not follow the script \(1 of 2 calls, 1 texts\)$/m],
    [{ drop: "git-wrapped", landed: { "git-wrapped": true } }, /^git-wrapped: the trace holds 1 of 2 calls$/m],
    [{ bare: "git-unwrapped" }, /^git-unwrapped: no work repository and remote where the scaffold makes them \(.*\/e-g002x\/sealed\/home\/cwd\)$/m],
    [{ escape: "home-instructions", landed: { "git-wrapped": true } }, /^home-instructions: the stand-in did not see the case's prompt in a request, so it read no request's body$/m],
    [{ deaf: "config", landed: { "git-wrapped": true } }, /^control config: a plain Claude Code given the planted configuration carried \{"reached":\[\],"ran":\[\]\}, must carry \{"reached":\["claude-md","rules","memory-dir"\],"ran":\[\]\}: what is planted is not shown to load/m],
    [{ controlRuns: [], landed: { "git-wrapped": true } }, /^control home: a plain Claude Code given the planted home carried \{"reached":\["home-claude-md","home-rules","home-memory","home-env","home-hook","home-inline","home-canary"\],"ran":\[\]\}/m],
    // A hook that ran in an eval is no proof the control ran it: only the control's own lines count.
    [{ hooks: true, controlRuns: ["mcp"], landed: { "git-wrapped": true } }, /^control home: .*"ran":\["mcp"\]\}, must carry/m],
    [{ deaf: "home", landed: { "git-wrapped": true } }, /^control home: a plain Claude Code given the planted home carried \{"reached":\[\],"ran":\[\]\}, must carry \{"reached":\["home-claude-md","home-rules","home-memory","home-env","home-hook","home-inline","home-canary"\],"ran":\["hook","mcp"\]\}/m],
  ]);
  for (const [play, why] of fails) await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith(play) }), why, JSON.stringify(play));
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({}), watch: watching({ others: ["claude 1 u 3u IPv4 TCP 10.0.0.5:1->160.79.104.10:443"], standIn: true }) }), /^the eval's processes opened connections past loopback \(the git run\):\nclaude 1 u 3u IPv4 TCP 10\.0\.0\.5:1->160\.79\.104\.10:443$/m);
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({}), watch: watching({ others: [], standIn: false }) }), /^the socket watch saw no connection to the stand-in, so it did not see the run's sockets \(the git run\)$/m);
  await assert.rejects(recordGit("claude", { ...o, spawnRun: evalWith({}), watch: watching({ others: [], standIn: true, stuck: true }) }), /^the socket watch's last look did not end in time, so what it saw last is unread \(the git run\)$/m);
  assert.deepEqual(readdirSync(runRoot), ["e-before1"]);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(listening(), before, "nor after a run that failed");
  const firsts = spawned.filter((s) => s[0] !== "error" && s[6] === 0);
  assert.notEqual(firsts[0][4][0][0], firsts[1][4][0][0], "each run names its canary anew");
  await assert.rejects(recordGit("claude", { ...o, hasSandbox: () => false, spawnRun: evalWith({}) }), NotMeasured);
  assert.equal(spawned.filter((s) => s[0] === "error").length, 0, spawned.filter((s) => s[0] === "error").map((s) => s[1]).join("\n"));
});

test("eval selftest: the git run stopped by SIGINT, SIGTERM or SIGHUP kills its eval and leaves no canary, folder or run directory, then dies of the signal", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-gsig-")));
  const child = join(tmp, "child.mjs");
  // A recorder whose eval runs on (a detached sleep in a group of its own, as the eval tool's runs are) and has made a run directory.
  writeFileSync(child, `import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const [url, dir, runRoot, home] = process.argv.slice(2);
const { recordGit } = await import(url);
const spawnRun = () => {
  mkdirSync(join(runRoot, "e-Held1", "sealed"), { recursive: true });
  const eval_ = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore", env: process.env });
  process.stdout.write("started " + eval_.pid + "\\n");
  return eval_;
};
recordGit("claude", { spawnRun, git: () => "/opt/x/bin/git", hasSandbox: () => true, stray: () => [], tmp: dir, runRoot, home, watch: () => ({ stop: async () => ({ others: [], standIn: true }) }) }).then(() => process.stdout.write("resolved\\n"), (e) => process.stdout.write("rejected " + e.message + "\\n"));
`);
  const url = pathToFileURL(join(RECORD, "..", "selftest.mjs")).href;
  for (const sig of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    const [dir, runRoot, home] = ["d", "runs", "home"].map((n) => join(tmp, `${sig}-${n}`));
    for (const d of [dir, runRoot, home]) mkdirSync(d);
    const run = spawn(process.execPath, [child, url, dir, runRoot, home], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const started = await new Promise((resolve, reject) => {
      run.stdout.on("data", (d) => {
        out += d;
        const m = /started (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      run.on("exit", () => reject(new Error(`the recorder ended first: ${out}`)));
    });
    assert.equal(readdirSync(home).length, 1, "the canary is in the home while the run lasts");
    run.kill(sig);
    const [code, signal] = await once(run, "exit");
    assert.deepEqual([code, signal], [null, sig], `${sig}: dies of the signal it got (${out})`);
    assert.deepEqual(readdirSync(home), [], `${sig}: the canary is removed`);
    assert.deepEqual(readdirSync(dir), [], `${sig}: the recorder's folder is removed`);
    assert.deepEqual(readdirSync(runRoot), [], `${sig}: the run directory is removed`);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(started, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    assert.ok(!alive, `${sig}: the eval is killed`);
  }
});

test("eval selftest: the socket watch gives each look a time limit, and its stop gives up on a look that will not end", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "en-gw-")));
  const ps = join(tmp, "ps");
  const lsof = join(tmp, "lsof");
  writeFileSync(ps, "#!/bin/sh\necho '  7 1'\n");
  writeFileSync(lsof, "#!/bin/sh\necho 'node 7 u 3u IPv4 0x1 0t0 TCP 127.0.0.1:1->127.0.0.1:4321 (ESTABLISHED)'\nexec sleep 30\n");
  for (const f of [ps, lsof]) chmodSync(f, 0o755);
  const env = { ...process.env };
  // stop waits for the look under way, which ends at its limit; what it printed is not read.
  const cut = watchSockets(7, 4321, { ps, lsof, env, every: 60_000, lookMs: 400, stopMs: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  let t = Date.now();
  assert.deepEqual(await cut.stop(), { others: [], standIn: false, stuck: false });
  assert.ok(Date.now() - t < 2000, `stop waited ${Date.now() - t} ms`);
  // A look that outlasts stop's limit: stop gives up and says so.
  const held = watchSockets(7, 4321, { ps, lsof, env, lookMs: 20_000, stopMs: 300 });
  await new Promise((r) => setTimeout(r, 200));
  t = Date.now();
  assert.deepEqual(await held.stop(), { others: [], standIn: false, stuck: true });
  assert.ok(Date.now() - t < 2000, `stop waited ${Date.now() - t} ms`);
  // A look that ends reads what lsof said.
  writeFileSync(lsof, "#!/bin/sh\necho 'node 7 u 3u IPv4 0x1 0t0 TCP 127.0.0.1:1->127.0.0.1:4321 (ESTABLISHED)'\necho 'node 7 u 4u IPv4 0x2 0t0 TCP 10.0.0.5:2->192.0.2.1:443 (SYN_SENT)'\n");
  const seen = watchSockets(7, 4321, { ps, lsof, env, every: 50 });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await seen.stop(), { others: ["node 7 u 4u IPv4 0x2 0t0 TCP 10.0.0.5:2->192.0.2.1:443 (SYN_SENT)"], standIn: true, stuck: false });
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
