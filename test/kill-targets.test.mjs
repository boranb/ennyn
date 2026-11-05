/**
 * The reader behind the kill hook (adapters/claude-code/kill-targets.mjs): an accept and a reject corpus, written by
 * hand in the shapes agents use on Linux, macOS and Windows (Git Bash, PowerShell, cmd), each refusal with the reason
 * it gets. A refusal stalls an agent and a miss is a kill that may reach the user's own programs, so both directions
 * are held. Then the hook itself, as Claude Code runs it, on temporary projects; test/reference/pretooluse.json records
 * what Claude Code does with what it prints. Nothing here runs a kill: the hook is fed JSON.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killTarget } from "../adapters/claude-code/kill-targets.mjs";

/** A kill by a literal PID or process group, a job of this shell, a PID this text took from `$!` or Start-Process, and text that only names a kill. */
const PASS = [
  "kill 1234",
  "kill -9 1234",
  "kill -TERM 1234 5678",
  "kill -s TERM 1234",
  "kill -n 9 1234",
  "kill -- -1234",
  "kill -9 -- -1234",
  "kill -TERM -1234",
  "kill %1",
  "kill %%",
  "kill -l",
  "/bin/kill 1234",
  "sudo kill -9 1234",
  "timeout 5 kill 1234",
  "git stash list; kill 1234 && echo done",
  "taskkill /PID 1234 /T /F",
  "taskkill //PID 1234 //T //F",
  "taskkill /pid 1234 /f",
  "TASKKILL.EXE /PID 1234 /PID 5678",
  '"C:\\Windows\\System32\\taskkill.exe" /PID 1234 /F',
  "tskill 1234",
  "Stop-Process -Id 1234",
  "Stop-Process -Id 1234,5678 -Force",
  "Stop-Process -Id 1234 -ErrorAction SilentlyContinue",
  "Stop-Process 1234",
  "stop-process -id 1234 -Confirm:$false",
  "spps -Id 1234",
  "kill -Id 1234",
  "node server.js & pid=$!; sleep 2; kill $pid",
  'npm start > out.log 2>&1 &\nPID=$!\nnpm test\nkill "$PID"',
  "sleep 100 & kill $!",
  'kill "$(cat server.pid)"',
  "kill $(< /tmp/vite.pid)",
  'S=/tmp/run; P=$(cat "$S/app.pid"); taskkill //PID $P //T //F',
  'W=$(cat "$S/app.winpid" 2>/dev/null); [ -n "$W" ] && taskkill //PID "$W" //T //F',
  "P=$(cat a.pid); Q=$(netstat -ano | grep :5403 | awk '{print $NF}'); [ \"$P\" = \"$Q\" ] && taskkill //PID \"$P\" //F",
  '$w = Get-Content "$env:TEMP\\app.pid"; Stop-Process -Id $w -Force',
  '$p = [int](Get-Content "$env:TEMP\\app.pid"); taskkill /PID $p /T /F',
  '$id = (Get-Content $f).Trim(); if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
  "{ taskkill /PID 1234 /T /F }",
  "for p in 20144 2028 616; do taskkill //T //F //PID $p 2>&1 | tail -1; done",
  "if ($x) { Stop-Process -Id 1234 -Force } else { 'gone' }",
  "npm start & trap 'kill $(jobs -p)' EXIT; npm test",
  "kill $(jobs -pr)",
  "setsid node s.js & pid=$!; sleep 1; kill -- -$pid",
  "node s.js & pid=$!\nkill -TERM -${pid}",
  "$p = Start-Process node -ArgumentList s.js -PassThru; Start-Sleep 2; Stop-Process -Id $p.Id",
  "$srv = Start-Process -FilePath npm -PassThru -ArgumentList start\nStop-Process -Id $srv.Id -Force",
  'git commit -m "stop using pkill and taskkill /IM"',
  'echo "pkill node"',
  'grep -rn "taskkill /FI" .',
  "rg killall src",
  "git log --grep kill",
  "ps aux | grep node",
  "netstat -ano | findstr :3000",
  "Get-NetTCPConnection -LocalPort 3000",
  "lsof -i :3000",
  "pgrep -f vite",
  "Get-Process node",
  "cat <<'EOF' > notes.md\npkill node\nkill $(lsof -t -i:3000)\nEOF",
  "git commit -F - <<'EOF'\nfix: no more killall\nEOF",
  "npm run kill",
  "docker kill web-1",
  "kill",
];

/** Each with the reason it is refused: `name` a filter, name or title; `lookup` a PID found at run time; `port` a kill by port; `every` more than one process by number. */
const REFUSED = [
  ["pkill node", "name"],
  ['pkill -f "vite --port 3000"', "name"],
  ["pkill -P $$", "name"],
  ["killall node", "name"],
  ["killall5 -9", "name"],
  ["/usr/bin/pkill -9 node", "name"],
  ["sudo pkill -u me", "name"],
  ["nohup pkill node &", "name"],
  ["skill -KILL node", "name"],
  ["taskkill /F /IM node.exe", "name"],
  ["taskkill //F //IM node.exe", "name"],
  ["taskkill /im node.exe /f", "name"],
  ["taskkill -im node.exe", "name"],
  ['taskkill //F //FI "WINDOWTITLE eq *"', "name"],
  ['taskkill /FI "IMAGENAME eq node.exe" /F', "name"],
  ['TaskKill.exe /F /Fi "PID gt 0"', "name"],
  ["taskkill /PID 1234 /IM node.exe", "name"],
  ["taskkill /PID 1234 /FI", "name"],
  ["taskkill /F", "name"],
  ["tskill node", "name"],
  ["Stop-Process -Name node", "name"],
  ["Stop-Process -Name node -Force", "name"],
  ["stop-process -processname chrome", "name"],
  ["spps -n node", "name"],
  ["kill -Name node", "name"],
  ["kill -InputObject $p", "name"],
  ["kill -n node", "name"],
  ["killall -q node 2>/dev/null || true", "name"],
  ['cmd.exe /c "taskkill /F /IM node.exe"', "name"],
  ["Start-Process taskkill -ArgumentList '/F /IM node.exe'", "name"],
  ["& taskkill /IM node.exe", "name"],
  ["Stop-Process -InputObject $p", "name"],
  ["(Get-Process node).Kill()", "name"],
  ["[System.Diagnostics.Process]::GetProcessesByName('node') | ForEach-Object { $_.Kill() }", "name"],
  ['wmic process where name="node.exe" delete', "name"],
  ["wmic process where \"name='node.exe'\" call terminate", "name"],
  ["Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Invoke-CimMethod -MethodName Terminate", "name"],
  ["Get-Process node | Stop-Process", "lookup"],
  ["Get-Process -Name node | Stop-Process -Force", "lookup"],
  ["gps node | kill", "lookup"],
  ['Get-Process | Where-Object { $_.MainWindowTitle -like "*" } | Stop-Process', "lookup"],
  ["Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force", "lookup"],
  ["Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }", "lookup"],
  ["Stop-Process -Id $PID", "lookup"],
  ["kill $(lsof -t -i:3000)", "lookup"],
  ["kill -9 $(lsof -ti tcp:3000)", "lookup"],
  ["kill $(pgrep -f server)", "lookup"],
  ["kill `pgrep node`", "lookup"],
  ["kill -9 $(ps aux | grep node | awk '{print $2}')", "lookup"],
  ["kill $PID", "lookup"],
  ["kill $$", "lookup"],
  ["kill $PPID", "lookup"],
  ["kill ${pid:-$(pgrep node)}", "lookup"],
  ["kill 1234 $(pgrep node)", "lookup"],
  ["kill $(cat $(ls *.pid))", "lookup"],
  ["P=$(cat a.pid | head -1); kill $P", "lookup"],
  ["P=$(netstat -ano | grep :3000 | awk '{print $5}'); taskkill //PID $P //F", "lookup"],
  ["$p = Get-Content a.pid | Select-Object -First 1; Stop-Process -Id $p", "lookup"],
  ["$p = Get-Content a.pid; $p = (Get-NetTCPConnection -LocalPort 3000).OwningProcess; Stop-Process -Id $p", "lookup"],
  ["Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId }", "lookup"],
  ["$k = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite' }; foreach ($p in $k) { taskkill /PID $p.ProcessId /T /F }", "lookup"],
  ["pkill -TERM -P 4242", "name"],
  ["pid=$(pgrep node); kill $pid", "lookup"],
  ["node s.js & pid=$!; pid=$(pgrep node); kill $pid", "lookup"],
  ["for p in $(pgrep node); do kill $p; done", "lookup"],
  ["for p in 1234 $(pgrep node); do kill $p; done", "lookup"],
  ["for p in 1234; do kill $p; done; p=$(pgrep x); kill $p", "lookup"],
  ["P=$(cut -d' ' -f2 app.pid); taskkill //PID $P //F", "lookup"],
  ["pgrep node | while read pid; do kill $pid; done", "lookup"],
  ["node s.js & pid=$!; read pid < other.pid; kill $pid", "lookup"],
  ["$p = Get-Process node; Stop-Process -Id $p.Id", "lookup"],
  ["$p = Start-Process node -PassThru; $p = Get-Process node; Stop-Process -Id $p.Id", "lookup"],
  ["taskkill /PID $pid /F", "lookup"],
  ["for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :3000') do taskkill /F /PID %a", "lookup"],
  ["lsof -ti:3000 | xargs kill -9", "lookup"],
  ["pgrep node | xargs kill", "lookup"],
  ["xargs -a pids.txt kill -9", "lookup"],
  ["ps -ef | grep node | grep -v grep | awk '{print $2}' | xargs kill -9", "lookup"],
  ["kill $(jobs -l)", "lookup"],
  ["ps aux | grep '[n]ode' | awk '{print $2}' | xargs -r kill", "lookup"],
  ["echo 1234 | xargs taskkill /F /PID", "lookup"],
  ["fuser -k 3000/tcp", "port"],
  ["fuser -ki 8080/tcp", "port"],
  ["npx kill-port 3000", "port"],
  ["kill-port 3000 8080", "port"],
  ["npx fkill-cli :3000", "port"],
  ["kill -9 -1", "every"],
  ["kill -- -1", "every"],
  ["kill 0", "every"],
  ["kill -TERM 0", "every"],
  ['bash -c "pkill node"', "name"],
  ["bash -c 'kill $(pgrep node)'", "lookup"],
  ["cmd /c taskkill /IM node.exe /F", "name"],
  ['powershell -Command "Stop-Process -Name node"', "name"],
  ['pwsh -c "Get-Process node | Stop-Process"', "lookup"],
  ["wsl pkill node", "name"],
  ["ssh host pkill node", "name"],
  ['ssh host "kill $(pgrep node)"', "lookup"],
  ["eval pkill node", "name"],
];

/** Text that does not close, or past what the pass reads: judged by the kill word. */
const UNREAD = ['kill $(pgrep "node', `kill 1 ${"$(".repeat(5000)}`];

test("kill reader: the accept corpus passes", () => {
  const wrong = PASS.filter((c) => killTarget(c) !== null).map((c) => `${JSON.stringify(c)}: ${JSON.stringify(killTarget(c))}`);
  assert.deepEqual(wrong, []);
});

test("kill reader: the reject corpus is refused, each for its reason", () => {
  const wrong = REFUSED.filter(([c, why]) => killTarget(c)?.why !== why).map(([c, why]) => `${JSON.stringify(c)}: wanted ${why}, got ${JSON.stringify(killTarget(c))}`);
  assert.deepEqual(wrong, []);
});

test("kill reader: text it cannot read whole is judged by the kill word", () => {
  for (const c of UNREAD) assert.equal(killTarget(c)?.why, "unread", c.slice(0, 40));
  assert.equal(killTarget('echo "unclosed'), null, "no kill word, no refusal");
});

test("kill reader: what it names is the command refused, its substitutions shown as $…", () => {
  assert.equal(killTarget("ls && kill -9 $(lsof -t -i:3000)")?.part, "kill -9 $…");
  assert.equal(killTarget("echo a; pkill -f vite")?.part, "pkill -f vite");
});

test("kill reader: a variable is a PID this text started only when every setting of it is `name=$!`", () => {
  // The decision: `$!` is the last job this shell put in the background, so a name set from it, and from nothing else
  // in the same text, holds a PID the agent started. A name set in an earlier call is not seen here: refused.
  assert.equal(killTarget("a & pid=$!; b & pid=$!; kill $pid $pid"), null);
  assert.equal(killTarget("a & x=$!; kill $y")?.why, "lookup");
  assert.equal(killTarget("a & pid=$!; export pid; kill $pid")?.why, "lookup", "any other word naming it counts as a setting");
  assert.equal(killTarget("a & pid=$!; kill $pid$pid")?.why, "lookup", "one expansion and nothing else in the word");
  assert.equal(killTarget("a & pid=$!; kill ${pid}x")?.why, "lookup");
  assert.equal(killTarget("a & pid=$!x; kill $pid")?.why, "lookup");
});

test("kill reader: 64 KB of the shapes its PID-file trust once read in cubic time is read well inside the hook's 10 s, with the verdict each needs", () => {
  // Review round 2 measured 15 KB of the first shape at 11.2 s: past the hook's limit, where Claude Code runs the call.
  /** @param {(i: number) => string} unit @param {string} end */
  const fill = (unit, end) => {
    let s = "";
    for (let i = 0; s.length + end.length < 65000; i++) s += unit(i);
    return s + end;
  };
  const shapes = [
    [fill((i) => `p${i}=$(cat a.pid); echo $p${i} > a.pid; `, "pkill node"), "name"],
    [fill((i) => `p${i}=$(cat a.pid); echo $p${i} > a.pid; `, "kill $(cat a.pid)"), null],
    [`pgrep -f x > f0; ${fill((i) => `N${i}=$(cat f${i}); echo $N${i} > f${i + 1}; `, "kill $(cat f0)")}`, "lookup"],
    [fill((i) => `$p${i} = Get-Content a.pid; `, "Stop-Process -Id $p1"), null],
    [fill(() => "$p = Start-Process n -PassThru; $p.Id | Out-File a.pid; ", "$q = Get-Content a.pid; Stop-Process -Id $q"), null],
    [fill((i) => `$a${i + 1} = $a${i}; `, "$a0 = Get-Process x; $a9.Kill()"), "name"],
  ];
  for (const [text, why] of shapes) {
    const t0 = performance.now();
    const r = killTarget(/** @type {string} */ (text));
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${String(text).slice(0, 40)}…: ${Math.round(ms)} ms`);
    assert.equal(r?.why ?? null, why, String(text).slice(0, 60));
  }
});

const HOOK = fileURLToPath(new URL("../adapters/claude-code/hooks/kill-targets.mjs", import.meta.url));
const neutral = mkdtempSync(join(tmpdir(), "en-kill-cwd-"));

/** A repository, with an Ennyn config as `config` says: its text, or nothing. @param {string | null} config */
function project(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-kill-hook-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (config !== null) {
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), config);
  }
  return dir;
}

/** The hook as Claude Code runs it. @param {string} dir @param {unknown} input @param {string[]} [before] @param {string} [hook] */
function run(dir, input, before = [], hook = HOOK) {
  const r = spawnSync(process.execPath, [...before, hook], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, cwd: neutral, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  return r;
}
const call = (/** @type {string} */ command, tool = "Bash") => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command, description: "x" }, cwd: neutral });

test("kill hook: with a config it denies a kill by name on each tool that runs a command, says what to do instead, and exits 0", () => {
  const dir = project("{}\n");
  for (const [tool, command, named] of [["Bash", 'taskkill //F //FI "WINDOWTITLE eq *"', "taskkill //F //FI WINDOWTITLE eq *"], ["Monitor", "pkill -f vite", "pkill -f vite"], ["PowerShell", "Get-Process node | Stop-Process", ": Stop-Process. "]]) {
    const out = JSON.parse(run(dir, call(command, tool)).stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny", `${tool}: ${command}`);
    assert.match(out.permissionDecisionReason, /^ennyn: /);
    assert.ok(out.permissionDecisionReason.includes(named), "names the command it refused");
    assert.match(out.permissionDecisionReason, /the user's own programs/);
    assert.match(out.permissionDecisionReason, /a process you started, by its PID or process group/);
    assert.match(out.permissionDecisionReason, /`kill <pid>`, `kill -- -<pgid>`, `taskkill \/PID <pid> \/T \/F`, `Stop-Process -Id <pid>`/);
    assert.match(out.permissionDecisionReason, /ask the user/);
  }
});

test("kill hook: a kill by PID and every other command pass, printing nothing; what it names is one line, cut", () => {
  const dir = project("{}\n");
  for (const c of ["kill 1234", "taskkill //PID 1234 //T //F", "Stop-Process -Id 1234", "node s.js & pid=$!; kill $pid", "ls", "git push origin main"]) assert.equal(run(dir, call(c)).stdout, "", c);
  const reason = (/** @type {string} */ c) => JSON.parse(run(dir, call(c)).stdout).hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(reason("pkill -f 'a\nb'"), /\n/);
  assert.ok(reason(`pkill ${"x ".repeat(5000)}`).length < 900);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(reason("pkill \u001b[2J"), /\u001b/);
});

test("kill hook: with no config it ends at once, printing nothing, on a kill by name and on input it cannot read", () => {
  const dir = project(null);
  for (const input of [call("pkill node"), "not json", {}, { tool_input: {} }]) assert.equal(run(dir, input).stdout, "", JSON.stringify(input));
});

test("kill hook: input it cannot read leaves the call and says so; a Monitor on a socket holds no command and passes", () => {
  const dir = project("{}\n");
  for (const input of ["not json", "", "null", "[]", "{}", { tool_input: {} }, { tool_input: { command: 1 } }, { tool_input: null }]) {
    const out = JSON.parse(run(dir, input).stdout);
    assert.deepEqual(Object.keys(out), ["systemMessage"], JSON.stringify(input));
    assert.match(out.systemMessage, /kill hook could not read/);
  }
  assert.equal(run(dir, { tool_name: "Monitor", tool_input: { ws: "ws://127.0.0.1:1" } }).stdout, "");
});

test("kill hook: a reader that fails is input it cannot read: the call runs and it is said, never a silent pass", () => {
  const dir = project("{}\n");
  const fault = join(neutral, "reader-fault.mjs");
  writeFileSync(fault, 'const split = String.prototype.split;\nString.prototype.split = function (a, ...r) {\n  if (a === "\\u0000") throw new Error("reader fault");\n  return split.call(this, a, ...r);\n};\n');
  const out = JSON.parse(run(dir, call("pkill node"), ["--import", fault]).stdout);
  assert.deepEqual(Object.keys(out), ["systemMessage"]);
});

test("kill hook: a broken or missing catalog still refuses, with a plain English line", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-kill-copy-")));
  const top = fileURLToPath(new URL("..", import.meta.url));
  for (const d of ["adapters", "core", "i18n"]) cpSync(join(top, d), join(box, d), { recursive: true });
  const repo = project("{}\n");
  for (const damage of [() => writeFileSync(join(box, "i18n", "en.json"), "{ broken"), () => rmSync(join(box, "i18n", "en.json"))]) {
    damage();
    const out = JSON.parse(run(repo, call("pkill node"), [], join(box, "adapters/claude-code/hooks/kill-targets.mjs")).stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^ennyn: .*by its PID/);
  }
});

test("kill hook: the header and SECURITY.md name what gets past it", () => {
  const header = readFileSync(fileURLToPath(new URL("../adapters/claude-code/kill-targets.mjs", import.meta.url)), "utf8").split("*/")[0];
  const security = readFileSync(fileURLToPath(new URL("../SECURITY.md", import.meta.url)), "utf8");
  for (const limit of ["a script the agent writes and then runs", "an interpreter", "an alias", "a PID read in an earlier call"]) {
    assert.ok(header.includes(limit), `header: ${limit}`);
    assert.ok(security.includes(limit), `SECURITY.md: ${limit}`);
  }
});
