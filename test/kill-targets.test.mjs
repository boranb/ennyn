/**
 * The reader behind the kill hook (adapters/claude-code/kill-targets.mjs): an accept and a reject corpus, written by
 * hand in the shapes agents use on Linux, macOS and Windows (Git Bash, PowerShell, cmd), each refusal with the reason
 * it gets. A refusal stalls an agent and a miss is a kill that may reach the user's own programs, so both directions
 * are held. Then the hook itself, as Claude Code runs it, on temporary projects; test/reference/pretooluse.json records
 * what Claude Code does with what it prints. Generated texts run through a real bash against stand-ins, and bash's
 * answer is held against the reader's. Nothing here runs a kill: the hook is fed JSON, and bash's kills reach stand-ins;
 * one test runs the real kill inside the box's boundary, toward a sleeper it started.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killTarget } from "../adapters/claude-code/kill-targets.mjs";
import { FIRST_PID_NS, PROFILE, UNSHARE_ARGS, fenceExit, fenceName, fencedArgv, inFence, inRoot, namespaceArgv, pickFence, refusedExit, shellBox, unsafeTexts } from "./shell-box.mjs";

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

test("kill reader: 64 KB of the shapes its PID-file trust and its program places once read in more than linear time is read well inside the hook's 10 s, with the verdict each needs", () => {
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
    // Where a program's name stands, read once per block opening or per place: review measured 60 to 186 s at 64 KB.
    [`pkill node${fill(() => " {env", "")}`, "name"],
    [`pkill node${fill(() => " {", "")}`, "name"],
    [`pkill node${fill(() => " { env", "")}`, "name"],
    [`pkill node${fill(() => " {ssh", "")}`, "name"],
    [`env${fill(() => " a", "; pkill node")}`, "name"],
    [`env sh${fill(() => " sh", " $(echo x); pkill node")}`, "unread"],
    [`ForEach-Object${fill(() => " { kill 1234 }", "; pkill node")}`, "name"],
    [`ssh h${fill(() => " a", "; pkill node")}`, "name"],
    // A kill word beside what turns a word into a program: each kill judged and passed is counted off once, not searched for.
    [`f() { :; }; ${fill(() => "kill -9 1234\n", "echo")}`, null],
    [`eval x; ${fill(() => "echo kill; ", "echo")}`, "unread"],
  ];
  for (const [text, why] of shapes) {
    const t0 = performance.now();
    const r = killTarget(/** @type {string} */ (text));
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${String(text).slice(0, 40)}…: ${Math.round(ms)} ms`);
    assert.equal(r?.why ?? null, why, String(text).slice(0, 60));
  }
});

/**
 * A real bash, on generated texts: each stop of a bounded grammar put in each context the shell gives it, and its
 * program's name written each way the shell reads alike, runs as `bash -c` in a box (test/shell-box.mjs) where every
 * kill program, lookup and starter is a stand-in on PATH and the `kill` builtin is off, so nothing is signalled. Every
 * number here is past any PID limit (Linux's 2^22, macOS's 99,999), and no text stops PID 0 or -1, so a builtin that
 * stayed would signal nothing that is there; a context where it stays fails the test before any text runs. Measured
 * first without that: bash 3.2 started by node read no BASH_ENV, and the builtin signalled.
 *
 * What bash did is read off the stand-ins' words: a kill program by name or filter is `name`, one by port `port`; a
 * PID that `kill`, `taskkill /PID` or `tskill` gets is the text's own when it is written in the text as a number, or is
 * a process the text's shells started (it is in the top shell's process group and is not that shell, or it is gone: a lookup's answer is a
 * number no process has); any other is `lookup`; a word that is no number, `name`. The program's own meaning of its words is
 * this table, not measured; the shell's part, which words reach which program, is. The reader may refuse what bash
 * does not stop (the price of reading text) and must not pass what bash stops another's process with.
 */
const KILL_STOPS = [
  "kill 9999991", "kill -9 9999991", "kill -s TERM 9999991", "kill -- -9999991", "kill -l",
  "sleep 1 & kill $!", "sleep 1 & pid=$!; kill $pid", "sleep 1 & echo $! > a.pid; kill $(cat a.pid)", "sleep 1 & pid=$!; kill -- -$pid", "sleep 1 & kill %1",
  "pkill node", "pkill -f node", "killall node", "killall5 -9", "skill node",
  "kill $(pgrep node)", "kill `pgrep node`", "pgrep node | xargs kill", "kill $(lsof -ti :3000)", "kill -9 $(ps -o pid= -C node)", "pid=$(pgrep node); kill $pid",
  "for p in $(pgrep node); do kill $p; done", "for p in 9999991 9999992; do kill $p; done", "pgrep node | while read p; do kill $p; done",
  "echo $((9999990 + 3)) | xargs kill",
  "fuser -k 3000/tcp", "npx kill-port 3000", "kill-port 3000", "kill $$",
  "taskkill //F //IM node.exe", "taskkill //PID 9999991 //F", "tskill node", "tskill 9999991", "kill node",
];
/** @type {[string, (s: string) => string | null][]} */
const KILL_CONTEXTS = (() => {
  const simple = (/** @type {string} */ s) => !/[;&|]/.test(s);
  return [
    ["plain", (s) => s], ["seq", (s) => `true; ${s}`], ["and", (s) => `echo x && ${s}`], ["or", (s) => `false || ${s}`], ["sub", (s) => `( ${s} )`], ["group", (s) => `{ ${s}; }`],
    ["if", (s) => `if true; then ${s}; fi`], ["func", (s) => `f() { ${s}; }; f`], ["function", (s) => `function f { ${s}; }; f`], ["for", (s) => `for i in 1; do ${s}; done`],
    // A wrapper inside a block: the program's place is past the brace and past the wrapper both.
    ["function-env", (s) => (simple(s) ? `function f { env ${s}; }; f` : null)], ["group-nohup", (s) => (simple(s) ? `{ nohup ${s}; }` : null)], ["if-time", (s) => (simple(s) ? `if true; then time ${s}; fi` : null)],
    ["bash-c", (s) => (s.includes("'") ? null : `bash -c '${s}'`)], ["sh-c", (s) => (/["`]/.test(s) ? null : `sh -c "${s}"`)], ["cmdsub", (s) => `echo "$(${s})"`], ["assign", (s) => `x=$(${s})`],
    ["env", (s) => (simple(s) ? `env ${s}` : null)], ["command", (s) => (simple(s) ? `command ${s}` : null)], ["nohup", (s) => (simple(s) ? `nohup ${s}` : null)], ["exec", (s) => (simple(s) ? `exec ${s}` : null)],
    ["echo", (s) => `echo ${s}`], ["comment", (s) => `# ${s}`], ["colon", (s) => (s.includes("'") ? null : `: '${s}'`)], ["heredoc", (s) => `cat <<'EOF'\n${s}\nEOF`],
    ["pipe-sh", (s) => (s.includes("'") ? null : `printf '%s\\n' '${s}' | bash`)], ["file", (s) => (s.includes("'") ? null : `echo '${s}' > note.txt`)],
    // bash 4 and later: macOS's bash 3.2 runs neither (coproc is no command there, `|&` no syntax), Linux's bash 5 both.
    ["coproc", (s) => (simple(s) ? `coproc ${s}` : null)], ["coproc-named", (s) => `coproc P { ${s}; }`], ["pipe-err", (s) => `true |& ${s}`],
    // A helper the same text defines that runs its arguments: its arguments stand where a wrapper's do.
    ["helper", (s) => (simple(s) ? `r() { "$@"; }; r ${s}` : null)], ["helper-function", (s) => (simple(s) ? `function r { "$1" "\${@:2}"; }; r ${s}` : null)],
  ];
})();
/** What a lookup stand-in answers: a number no process has. */
const LOOKED_UP = "9999990";

/**
 * Why bash's run of `text` stops a process the text did not start, or null, from the stand-ins' calls.
 * @param {string} text @param {string[][]} calls each `[pid, name, ...words]`, an `@own` line after a kill's
 * @returns {string | null}
 */
function stopped(text, calls) {
  for (const [pid, name, ...args] of calls) {
    if (/^(pkill|killall5?|skill)$/.test(name)) return "name";
    if (/^(kill-port|fkill)$/.test(name) || (name === "fuser" && args.some((a) => /^-\w*k/.test(a)))) return "port";
    const own = new Set(calls.find((c) => c[0] === pid && c[1] === "@own")?.slice(2) ?? []);
    /** @param {string} t */
    const target = (t) => {
      if (t.startsWith("%")) return null;
      if (!/^-?\d+$/.test(t)) return "name";
      const n = t.replace(/^-/, "");
      if (new RegExp(`(^|\\D)${n}(\\D|$)`).test(text)) return null;
      // A number past every PID limit is gone because no process ever had it: no start of the text's.
      return Number(n) < Number(LOOKED_UP) && own.has(n) ? null : "lookup";
    };
    /** @type {string[]} */
    let targets = [];
    if (name === "taskkill") {
      const flags = args.map((a) => a.replace(/^(\/\/|\/|-)/, "").toLowerCase());
      if (flags.some((a) => a === "im" || a === "fi") || !flags.includes("pid")) return "name";
      targets = flags.flatMap((a, k) => (a === "pid" ? [args[k + 1] ?? ""] : []));
    } else if (name === "tskill") targets = args.slice(0, 1);
    else if (name === "kill" && !["-l", "-L"].includes(args[0])) {
      let k = 0;
      for (; k < args.length; k++) {
        if (args[k] === "--") { k++; break; }
        if (args[k] === "-s" || args[k] === "-n") k++;
        else if (!/^-[A-Za-z]/.test(args[k])) break;
      }
      targets = args.slice(k);
    }
    for (const t of targets) {
      const why = target(t);
      if (why) return why;
    }
  }
  return null;
}

/**
 * The stand-ins of the differential run. A process the text started is in the top shell's process group: the box
 * starts bash in a session of its own, and a shell with no job control keeps its children in its group. Its parent is
 * no anchor: on bash 5 a coproc's shell outlives the top shell and is reparented (measured on 5.1 and 5.2), so a walk
 * up from the kill never met the top shell. The top shell leads that group and is no start of the text's; a process
 * outside the box, the test runner's own, is in another group. In the box's own PID namespace a process outside is
 * not there at all, as a gone one is not: a number past the PID a new process gets now was never one of the text's.
 * Not the stand-in's own PID, which can be the top shell's (bash runs a text's last command in its own process), and
 * not ns_last_pid: dash reads a file a byte at a time, and that file gives its first digit only (measured: 4 for 45).
 * @param {Record<string, string>} [lookups] a lookup stand-in's lines, in place of the answer no process has
 */
function killStands(lookups = {}) {
  // ps is set-user-ID on macOS, and the box's sandbox refuses to start it: perl's getpgrp asks the kernel itself.
  const perl = existsSync("/proc/self/stat") ? null : "/usr/bin/perl";
  const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
  assert.ok(sleep && (perl === null || existsSync(perl)), "this harness needs sleep, and perl where there is no /proc");
  // A PID's process group, from /proc on Linux, from the kernel by perl elsewhere; nothing when it is gone.
  const pgid = `pgid() { if [ -r /proc/$1/stat ]; then read -r _ _ _ _ g _ < /proc/$1/stat; echo "$g"; else '${perl}' -e '$p = shift; $g = $p > 0 ? getpgrp($p) : -1; print $g if $g >= 0' "$1" 2>/dev/null; fi; }`;
  const kill = [
    pgid,
    'own=""',
    'last=; [ -r /proc/self/stat ] && last=$(/bin/sh -c \'echo "$$"\')',
    'for a in "$@"; do t=${a#-}; case "$t" in \'\'|*[!0-9]*) continue;; esac; g=$(pgid "$t"); [ "$g" = "$BOX_TOP" ] && [ "$t" != "$BOX_TOP" ] && own="$own $t"; [ -z "$g" ] && { [ -z "$last" ] || [ "$t" -le "$last" ]; } && own="$own $t"; done',
    // One write, as the stand-ins' own lines.
    "line=$(printf '%s\\037@own%s' \"$$\" \"$own\" | tr ' ' '\\037'); printf '%s\\n' \"$line\" >> \"$LOG\"",
  ].join("\n");
  const answer = `echo ${LOOKED_UP}`;
  const starts = `exec '${sleep}' 1 </dev/null >/dev/null 2>&1`;
  return { kill, pkill: "", killall: "", killall5: "", skill: "", "kill-port": "", fkill: "", taskkill: "", tskill: "", fuser: answer, pgrep: answer, pidof: answer, lsof: answer, ps: answer, sleep: starts, npx: 'exec "$@"', ...lookups };
}

test("kill reader: a real bash agrees on generated texts: nothing it passes stops another's process, and what it refuses that bash does not stop is counted", () => {
  const box = shellBox("en-kill-bash-", { stands: killStands(), real: ["cat", "xargs", "env", "nohup", "tr"] });
  try {
    const checks = [...KILL_CONTEXTS.map(([, put]) => put("{}")), 'eval "{}"', 'bash -c "env {}"'].filter((t) => t !== null);
    assert.deepEqual(box.builtins("kill", [...checks, "{} | cat", "echo | while read x; do {}; done"]), [], "a context where the kill builtin is still on");
    /** @type {string[]} */
    const texts = [];
    for (const s of KILL_STOPS) for (const [, put] of KILL_CONTEXTS) {
      const t = put(s);
      if (t !== null) texts.push(t);
    }
    for (const s of KILL_STOPS) {
      const [w] = s.split(" ");
      if (!/^[a-z][a-z-]*\d?$/.test(w) || w === "for" || w === "sleep") continue;
      for (const spell of [`'${w}'`, `"${w}"`, `\\${w}`, `${w[0]}''${w.slice(1)}`]) texts.push(spell + s.slice(w.length));
      // The name built at run time, at the head, after a wrapper and after a wrapper in a block.
      const rest = s.slice(w.length);
      for (const built of [`$(echo ${w})`, `"$(echo ${w})"`, `\`echo ${w}\``]) {
        texts.push(built + rest);
        // An option and its value before the name, the value named like a kill program (`exec -a fuser`).
        for (const wrap of ["env", "nohup", "command", "exec", "time", "exec -a fuser", "time -p"]) texts.push(`${wrap} ${built}${rest}`);
        if (!/[;&|]/.test(rest)) texts.push(`function f { env ${built}${rest}; }; f`);
      }
      // Inside double-quoted text another shell reads: the outer shell runs the substitution, the inner one gets the name.
      if (!/["`\\]/.test(rest)) {
        for (const shell of ["bash -c", "sh -c", "eval"]) texts.push(`${shell} "$(echo ${w})${rest}"`);
        texts.push(`eval "\`echo ${w}\`${rest}"`, `bash -c "env $(echo ${w})${rest}"`);
      }
    }
    // Before any text runs: none reaches the real program or names a number a process can have.
    const control = ["kill 1234", "kill -9 -1", "kill -1; echo x", "kill 0", "/bin/kill 9999991", "command -p kill 9999991", "PATH=/bin:/usr/bin kill 9999991", "taskkill //PID 4242 //F", "enable kill; kill 9999991", "builtin kill 9999991", "env -i kill 9999991"];
    assert.equal(unsafeTexts(control).length, control.length, "the safety check misses a text it must refuse");
    assert.deepEqual(unsafeTexts(["kill -9 9999991", "kill -9 $(pgrep x)", "kill -- -9999991", "sleep 1 & kill $!", "tskill 9999991"]), []);
    assert.deepEqual(unsafeTexts(texts), [], "a generated text could reach a real process");
    /** @type {string[]} */
    const looser = [];
    let stricter = 0;
    let stops = 0;
    for (const text of texts) {
      const why = stopped(text, box.run(text).calls);
      const said = killTarget(text);
      if (why) stops++;
      if (why && !said) looser.push(`${JSON.stringify(text)}: bash stops by ${why}`);
      if (!why && said) stricter++;
    }
    assert.deepEqual(looser, [], "passed, and a real bash stops a process the text did not start");
    assert.ok(texts.length >= 700, `${texts.length} texts`);
    assert.ok(stops >= texts.length / 3, `${stops} texts bash stops by`);
    // bash 3.2 runs no bash 4 shape, so there the reader refusing one is strict: a quarter at most, on either bash.
    assert.ok(stricter <= texts.length / 4, `${stricter} of ${texts.length} refused that bash does not stop by`);
  } finally {
    box.close();
  }
});

test("kill reader: the differential judge counts a process outside the box as a lookup, and a sleep the text started, coproc or not, as its own", () => {
  const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
  assert.ok(sleep, "this harness needs sleep");
  // The test's own sleep, outside the box; the stand-in kill signals nothing, and the texts ask for signal 0. The box
  // is made inside the sleeper's try: where it throws, the sleeper is stopped.
  const outside = spawn(sleep, ["30"], { stdio: "ignore" });
  /** @type {ReturnType<typeof shellBox> | undefined} */
  let box;
  try {
    box = shellBox("en-kill-judge-", { stands: killStands({ pgrep: `echo ${outside.pid}` }), real: ["cat", "tr"] });
    const texts = ["kill -0 $(pgrep x)", "sleep 1 & kill -0 $!", "coproc P { kill -0 $(pgrep x); }", "coproc P { sleep 1 & kill -0 $!; }", "coproc P { sleep 1 & pid=$!; kill -- -$pid; }", "kill -0 $$", 'sh -c "kill -0 $$"', "bash -c 'kill -0 $PPID'"];
    assert.deepEqual(unsafeTexts(texts), []);
    assert.deepEqual(box.builtins("kill", ["{}", "coproc P { {}; }"]), [], "a context where the kill builtin is still on");
    const judged = texts.map((text) => {
      const { calls } = /** @type {ReturnType<typeof shellBox>} */ (box).run(text);
      return [text, calls.some((c) => c[1] === "kill") ? stopped(text, calls) : "no kill ran"];
    });
    // macOS's bash 3.2 has no coproc; Linux's bash 5 runs it, and there the coproc's shell outlives the top shell.
    const coproc = existsSync("/proc/self/stat") ? null : "no kill ran";
    assert.deepEqual(judged, [
      [texts[0], "lookup"], [texts[1], null], [texts[2], coproc ?? "lookup"], [texts[3], coproc], [texts[4], coproc],
      // The top shell is in its own group, and the text did not start it.
      [texts[5], "lookup"], [texts[6], "lookup"], [texts[7], "lookup"],
    ]);
  } finally {
    box?.close();
    outside.kill();
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
  const r = spawnSync(process.execPath, [...before, hook], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, cwd: neutral, encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
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

test("kill reader: each piece of the beside rule decides: export -f, a definition's body, BASH_FUNC_, a kill counted once, a built kill name, quotes out, a quoted here-document, the last segment, the depth", () => {
  const deep = 'bash -c \'bash -c "bash -c \'"\'"\'bash -c \\"bash -c \\\\\\"pkill node\\\\\\"\\"\'"\'"\'"\'';
  for (const [text, why, beside] of [
    ["export -f r; bash -c 'r pkill node'", "unread", "export"],
    ['env \'BASH_FUNC_r%%=() { "$@"; }\' bash -c \'r pkill node\'', "unread", "BASH_FUNC_"],
    // One passed kill accounts for one kill word, not for every word of its spelling.
    ["set -e; kill 1234; echo kill", "unread", "set"],
    // A kill program's name a variable builds is no kill judged and passed: bash runs `killall` when x is `all`.
    ["x=all; kill$x 1234", "unread", "kill$x"],
    ['r() { "$@"; }; r p\'\'kill node', "unread", "r ()"],
    // Found only with backslashes out: bash reads `pk\\ill` as pkill.
    ['r() { "$@"; }; r pk\\ill node', "unread", "r ()"],
    [deep, "unread", "5 shells deep"],
  ]) {
    const r = killTarget(text);
    assert.equal(r?.why, why, text);
    assert.equal(r?.beside, beside, text);
  }
  // A name and `()` with no body is no definition (PowerShell's call); a quoted here-document is data; a run joined to
  // letters before the last `/` leaves the program's own name.
  for (const text of ['Get-Date(); Write-Host "kill"', "set -e; cat <<'EOF' > n.md\nkill it\nEOF", "$(pwd)bin/tool x"]) assert.equal(killTarget(text), null, text);
});

test("kill hook: a kill word beside what can turn a word into a program is denied with both named and how to split the command", () => {
  const dir = project("{}\n");
  const out = JSON.parse(run(dir, call('set -e; grep -rn "kill" src')).stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /^ennyn: the kill word `kill` stands in a command that also holds `set`/);
  assert.match(out.permissionDecisionReason, /Split it: run the part that names `kill`/);
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

test("kill reader: a kill word beside what can turn a word into a program is refused unless it is a kill judged and passed; the refusal names both", () => {
  // Each ran pkill or killall in bash 3.2 (test/shell-box.mjs); the reason given is the one this reader gives now.
  const refused = [
    ['bash -c "$(echo pkill) node"', "unread"], ['sh -c "$(echo pkill) node"', "unread"], ['eval "$(echo pkill) node"', "unread"],
    ['bash -c "`echo pkill` node"', "unread"], ['eval "`echo pkill` node"', "unread"], ['sh -c "env $(echo pkill) node"', "unread"],
    ['sudo sh -c "$(echo pkill) node"', "unread"], ['bash -c "true; $(echo pkill) node"', "unread"], ['bash -c "x=1 $(echo pkill) node"', "unread"],
    ['bash -c "\\"$(echo pkill)\\" node"', "unread"], ['find . -maxdepth 0 -exec sh -c "$(echo pkill) node" \\;', "unread"],
    ['retry() { for i in 1 2 3; do "$@" && break; done; }; retry pkill node', "name"], ['run() { echo "+ $*"; "$@"; }; run pkill -f node', "name"],
    ['quiet() { "$@" >/dev/null 2>&1; }; quiet killall node', "name"], ['function r { "$@"; }; r pkill node', "name"], ['function r() { "$@"; }; r pkill node', "name"],
    ['r () { "$@"; }; r pkill node', "name"], ['r() ( "$@" ); r pkill node', "name"], ['r() { "$1" node; }; r pkill', "name"], ['r() { "${1}" node; }; r pkill', "name"],
    ['r() { $*; }; r pkill node', "name"], ['r() { "$*"; }; r pkill', "name"], ['r() { shift; "$@"; }; r x pkill node', "name"], ['r() { env "$@"; }; r pkill node', "name"],
    ['r() { eval "$*"; }; r pkill node', "name"], ['r() { eval "$1"; }; r "pkill node"', "name"], ['r() { "$@"; }; r sudo pkill node', "name"],
    ['a() { "$@"; }; b() { a "$@"; }; b pkill node', "name"], ['function r {\n"$@"\n}\nr pkill node', "name"], ["bash -c 'r() { \"$@\"; }; r pkill node'", "name"],
    ['r() { "$@"; }; eval "r pkill node"', "name"], ['r() { "$@"; }; export -f r; bash -c "r pkill node"', "name"], ['r() { "$@"; }; r kill node', "name"],
    ['r() { "$@"; }; r kill $(pgrep node)', "lookup"],
    // A helper's name over a program's: bash runs the function.
    ['find() { "$@"; }; find pkill node', "name"], ['ssh() { "$@"; }; ssh pkill node', "name"],
    ['find() { "$@"; }; find $(echo pkill) node', "unread"], ['ssh() { "$@"; }; ssh $(echo pkill) node', "unread"],
  ];
  const wrong = refused.filter(([c]) => killTarget(c) === null).map(([c]) => JSON.stringify(c));
  assert.deepEqual(wrong, []);
  assert.deepEqual(killTarget('set -- pkill node; "$@"'), { why: "unread", part: 'set -- pkill node; "$@"', word: "pkill", beside: "set" });
  assert.equal(killTarget('retry() { "$@"; }; retry pkill node')?.beside, "retry ()");
  assert.equal(killTarget('grep -n "function kill" a.mjs'), null, "a construct's name inside an argument is no construct");
  assert.equal(killTarget("$(echo pk)ill node")?.why, "unread", "a name a run joins to letters");
  assert.equal(killTarget("bash -c 'pkill${IFS}node'")?.word, "pkill", "a shell's word with an expansion only it expands");
  assert.equal(killTarget(". lib.sh; grep kill a")?.beside, ".");
  assert.equal(killTarget("pkill${IFS}node")?.word, "pkill", "a kill word inside a word");
  assert.equal(killTarget('eval "$(echo pkill) node"')?.why, "unread");
  // Passes: every kill word a kill judged and passed; the construct elsewhere in the text, or in a quoted here-document.
  for (const c of ['bash -c "cd $(pwd) && kill 1234"', "set -e; node s.js & kill $!", "npm start & trap 'kill $(jobs -p)' EXIT; npm test", "f() { echo hi; }; f; kill 1234", "cat <<'EOF' > n.md\nset -- pkill x\nEOF", "source .venv/bin/activate && pytest", "ls skills/x/SKILL.md; set -e", "[System.Diagnostics.Process]::GetProcessById(1234).Kill(); function f { }"]) {
    assert.equal(killTarget(c), null, c);
  }
  // Refused that kill nothing (stated in the header): a kill word only named beside such a construct.
  for (const c of ['set -e; grep -n "kill(" a.mjs', 'r() { "$@"; }; r kill 1234', 'bash -c "echo $(echo pkill) node"']) assert.equal(killTarget(c)?.why, "unread", c);
});

test("shell box: a login or interactive shell, a startup file of its own or a PATH of its own is refused before it runs, by the check and by the box", () => {
  // A login shell reads /etc/profile, whose path_helper on macOS put /usr/bin before the stand-ins: the real pkill ran.
  const unsafe = [
    'bash -lc "$(echo pkill) node"', "bash -l -c 'pkill node'", "bash -il -c x", "bash -i -c x", "sh -l -c x", "bash --login -c x", "bash --rcfile r -c x",
    "bash --init-file r -c x", "bash -o login -c x", "exec -l bash", "exec -a -bash bash -c x", "exec -la x bash", "'-bash' -c x", "sudo -i pkill node", "sudo -s x",
    "su - root", "su -l", "env -S 'bash -l'", "PATH+=:/usr/bin pkill node", "export PATH; pkill node", "hash -p /usr/bin/pkill pkill; pkill node",
    "BASH_ENV=/dev/null bash -c 'kill 1'", "unset BASH_ENV; bash -c x", ". /etc/profile; pkill node", "source ~/.bashrc", "bash -c 'bash -l -c x'",
  ];
  assert.deepEqual(unsafe.filter((t) => unsafeTexts([t]).length === 0), [], "a text that can leave the box passes the check");
  const safe = ["bash -c 'kill -l'", 'sh -c "kill 9999991"', "bash -c 'pkill -f node'", "f() { kill -l; }; f", "eval 'kill -9 9999991'", "kill -l; echo i"];
  assert.deepEqual(safe.filter((t) => unsafeTexts([t]).length > 0), []);
  const box = shellBox("en-kill-safe-", { stands: { pkill: "" }, real: [] });
  try {
    // Texts that harm nothing if the guard were gone: the box's own refusal is what fails here.
    assert.throws(() => box.run("bash -lc true"), /refused/);
    assert.throws(() => box.builtins("kill", ["bash -l -c 'echo {}'"]), /refused/);
  } finally {
    box.close();
  }
});

test("shell box: a text past the word check runs the real kill, and the box's boundary keeps it from a process outside", async () => {
  // In POSIX mode bash reads no BASH_ENV, so the builtin kill is on: cycle 27's review ran texts like this one past the check.
  const text = `bash --posix -c 'kill -TERM $(cat "$HOME/pid")'`;
  assert.deepEqual(unsafeTexts([text]), []);
  const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
  assert.ok(sleep, "this harness needs sleep");
  // The box first: where it throws, this test has started nothing.
  const box = shellBox("en-kill-fence-", { stands: {}, real: ["cat"] });
  const outside = spawn(sleep, ["30"], { stdio: "ignore" });
  try {
    writeFileSync(join(box.box, "pid"), String(outside.pid));
    const { status } = box.run(text);
    // Long enough for node to reap a child that was stopped.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (box.fence === "sandbox") {
      // macOS: the kill is refused (status 1), the sleeper outside the sandbox lives.
      assert.equal(status, 1);
      assert.deepEqual([outside.exitCode, outside.signalCode], [null, null], "a signal left the sandbox");
      // A box made inside such a sandbox already: the inner one let a signal to the outer one's processes through
      // (measured on macOS 26.6.2), so the box's own check must find it and refuse to run anything.
      const nested = spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, process.execPath, "--input-type=module", "-e", `import { shellBox } from ${JSON.stringify(new URL("./shell-box.mjs", import.meta.url).href)}; shellBox("en-kill-nested-", { stands: {}, real: [] }).close();`], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
      assert.match(nested.stderr, /a signal left the sandbox/);
      assert.notEqual(nested.status, 0);
    } else if (box.fence === "namespace") {
      // Linux outside a container: the sleeper is in no PID namespace the box's shell sees, so the kill finds no such
      // process (status 1) and the sleeper lives.
      assert.equal(status, 1);
      assert.deepEqual([outside.exitCode, outside.signalCode], [null, null], "a signal left the namespace");
    } else {
      // A container: the boundary is the container's, and the test's own sleeper is inside it, so the same text reaches it.
      assert.equal(box.fence, "container");
      assert.equal(status, 0);
      assert.equal(outside.signalCode, "SIGTERM");
    }
  } finally {
    outside.kill();
    box.close();
  }
});

test("shell box: what a text past the word check reaches over a Unix socket, a TCP port or a named pipe is its boundary's", async () => {
  const perl = ["/usr/bin/perl", "/bin/perl"].find((p) => existsSync(p));
  assert.ok(perl, "this harness needs perl");
  // The box first: where it throws, this test has opened no server.
  const box = shellBox("en-kill-chan-", { stands: {}, real: [] });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-kill-chan-")));
  const sock = join(dir, "s");
  /** @type {string[]} */
  const got = [];
  /** @type {string[]} */
  const tcpGot = [];
  const server = createServer((c) => c.on("data", (d) => got.push(String(d))).on("end", () => c.end()));
  const tcp = createServer((c) => c.on("data", (d) => tcpGot.push(String(d))).on("end", () => c.end()));
  // screen's server on macOS listens on a named pipe in SCREENDIR; asked to quit from a box text, it quit (cycle 28's review).
  const screen = process.platform === "darwin" ? "/usr/bin/screen" : null;
  const name = `enchan${process.pid}`;
  const screenDir = join(dir, "screens");
  const ask = (/** @type {string[]} */ args) => spawnSync(/** @type {string} */ (screen), args, { env: { ...process.env, SCREENDIR: screenDir }, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
  try {
    // A socket's path has a short limit (104 bytes on macOS), and the temporary root is deep: each side names it relatively.
    await new Promise((resolve) => server.listen(relative(process.cwd(), sock), () => resolve(undefined)));
    await new Promise((resolve) => tcp.listen(0, "127.0.0.1", () => resolve(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (tcp.address()).port;
    if (screen) {
      mkdirSync(screenDir, { mode: 0o700 });
      assert.equal(ask(["-dmS", name, perl, "-e", "select(undef,undef,undef,30)"]).status, 0);
    }
    const text = `${perl} -MIO::Socket::UNIX -e '$c = IO::Socket::UNIX->new(Peer => shift) or exit 7; print $c "reached\\n"' ${relative(box.cwd, sock)}`;
    const tcpText = `${perl} -MIO::Socket::INET -e '$c = IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => shift, Timeout => 3) or exit 7; print $c "reached\\n"' ${port}`;
    assert.deepEqual(unsafeTexts([text, tcpText]), []);
    const { status } = box.run(text);
    const tcpStatus = box.run(tcpText).status;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (box.fence === "sandbox") {
      assert.deepEqual([status, got], [7, []], "a connection left the sandbox");
      const quit = `SCREENDIR=${screenDir} ${screen} -S ${name} -X quit`;
      assert.deepEqual(unsafeTexts([quit]), []);
      box.run(quit);
      assert.match(ask(["-ls"]).stdout, new RegExp(`\\.${name}\\s`), "a screen server outside quit at a box text's word");
    } else if (box.fence === "namespace") {
      // The namespace's root holds no path outside the box's folders, so the socket's path is not there; its own
      // network has no route to a port outside.
      assert.deepEqual([status, got], [7, []], "a Unix socket outside the box's folders was reached");
      assert.deepEqual([tcpStatus, tcpGot], [7, []], "a TCP connection left the namespace");
    } else {
      // A container: the boundary is the container's, and these servers are inside it, so the same texts reach them.
      assert.equal(box.fence, "container");
      assert.deepEqual([status, got.join("")], [0, "reached\n"]);
      assert.deepEqual([tcpStatus, tcpGot.join("")], [0, "reached\n"]);
    }
  } finally {
    if (screen) ask(["-S", name, "-X", "quit"]);
    server.close();
    tcp.close();
    box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shell box: the boundary check reads a refused signal only, never a sleeper that is gone or a shell function that stands for kill", async () => {
  const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
  assert.ok(sleep, "this harness needs sleep");
  const gone = spawn(sleep, ["30"], { stdio: "ignore" });
  gone.kill();
  await new Promise((resolve) => gone.on("exit", resolve));
  const live = spawn(sleep, ["30"], { stdio: "ignore" });
  const saved = process.env;
  try {
    const fence = fencedArgv(["/bin/sh", "-c", "x"]);
    if (process.platform === "darwin") {
      // macOS: a signal to a sleeper that is gone fails as well, and is no refusal.
      assert.notEqual(refusedExit(gone.pid), 0, "a gone sleeper read as fenced");
      assert.equal(fenceExit("sandbox", gone.pid), 5, "a gone sleeper read as fenced");
      // An exported function named kill that succeeds would read as a signal let out; the check runs without it.
      process.env = { ...saved, "BASH_FUNC_kill%%": "() { return 0; }" };
      assert.equal(refusedExit(live.pid), 0, "a shell function stood for kill in the check");
      process.env = saved;
      assert.equal(fenceExit("sandbox", live.pid), 0, "the sandbox let the signal out");
      // A test's own shell goes in the same sandbox.
      assert.deepEqual(fence, ["/usr/bin/sandbox-exec", "-p", PROFILE, "/bin/sh", "-c", "x"]);
    } else if (fence.length > 3) {
      // Linux outside a container: the namespace answers no such process for a sleeper that is gone too, so the check
      // asks the sleeper itself, before and after.
      assert.equal(fenceExit("namespace", gone.pid), 5, "a gone sleeper read as fenced");
      assert.equal(fenceExit("namespace", undefined), 5, "a sleeper that did not start read as fenced");
      // A sleeper that ends during the check (here the stand-in check stops it by its PID) is no refusal, though node
      // has not reaped it yet.
      const dies = spawn(sleep, ["30"], { stdio: "ignore" });
      assert.equal(fenceExit("namespace", dies.pid, ["/bin/sh", "-c", `kill ${dies.pid}; exit 0`, "check"]), 7, "a sleeper gone during the check read as fenced");
      // Without the namespace the signal goes: the check's own reading, not the namespace's absence, says fenced.
      assert.equal(fenceExit("namespace", live.pid, []), 3, "a signal that went read as fenced");
      process.env = { ...saved, "BASH_FUNC_kill%%": "() { return 0; }" };
      assert.equal(refusedExit(live.pid, "namespace"), 0, "a shell function stood for kill in the check");
      process.env = { ...saved, "BASH_FUNC_kill%%": '() { echo "No such process" >&2; return 1; }' };
      assert.equal(refusedExit(live.pid, "namespace", []), 3, "a shell function read a signal that went as refused");
      // Nor a kill a startup file defines: the check's shell reads none (BASH_ENV, ENV), and the namespace's PID 1 is a
      // bash in POSIX mode, which reads none either.
      const startup = join(realpathSync(mkdtempSync(join(tmpdir(), "en-kill-env-"))), "env");
      writeFileSync(startup, 'kill() { [ "$2" = "$$" ] && return 0; echo "No such process" >&2; return 1; }\n');
      process.env = { ...saved, BASH_ENV: startup, ENV: startup };
      assert.equal(refusedExit(live.pid, "namespace", []), 3, "a startup file's kill read a signal that went as refused");
      assert.equal(fenceExit("namespace", live.pid), 0, "a startup file broke the namespace's check");
      // The namespace's PID 1 reads none for a test's own command either: a cd of a startup file's would leave the
      // machine's root in place (the new root's step fails, 125).
      writeFileSync(startup, "cd() { :; }\n");
      assert.equal(inFence(["/bin/sh", "-c", "exit 0"], { env: { ...saved, BASH_ENV: startup }, encoding: "utf8" }).status, 0, "the namespace's PID 1 read a startup file");
      process.env = saved;
      rmSync(dirname(startup), { recursive: true, force: true });
      assert.equal(fenceExit("namespace", live.pid), 0, "the namespace let the signal out");
      // A PID namespace with the machine's root: the signal stays in, but a file made outside is there (9).
      assert.equal(fenceExit("namespace", live.pid, [fence[0], ...UNSHARE_ARGS]), 9, "a namespace that shows the files outside read as fenced");
      // A test's own shell goes in the same namespace.
      assert.deepEqual(fence, [...namespaceArgv(fence[0]), "--", "/bin/sh", "-c", "x"]);
      assert.deepEqual(fence.slice(1, UNSHARE_ARGS.length + 1), UNSHARE_ARGS);
    } else {
      // Elsewhere there is no sandbox to check: every exit but a refusal read from a live sleeper throws.
      for (const refused of [3, 4, 6, 7]) assert.throws(() => pickFence({ platform: "darwin", sandboxExec: true, refused }), /signal left the sandbox/);
      // In a container a test's own shell runs as it is: the container is the boundary.
      assert.deepEqual(fence, ["/bin/sh", "-c", "x"]);
    }
  } finally {
    process.env = saved;
    live.kill();
  }
});

test("shell box: the boundary is picked from what the machine says, and where none holds the box throws, naming what it tried", () => {
  const ns = "pid:[4026532001]";
  const unshare = "/usr/bin/unshare";
  assert.equal(pickFence({ platform: "darwin", sandboxExec: true, refused: 0 }).name, "sandbox");
  assert.deepEqual(pickFence({ platform: "darwin", sandboxExec: true, refused: 0 }).argv.slice(0, 2), ["/usr/bin/sandbox-exec", "-p"]);
  assert.throws(() => pickFence({ platform: "darwin", sandboxExec: false, refused: 0 }), /needs \/usr\/bin\/sandbox-exec/);
  // The check's signal to the outside sleeper went through (3), its sleeper did not start (5), the sandbox did not start
  // (65, 71), or it timed out.
  for (const refused of [3, 5, 65, 71, null]) assert.throws(() => pickFence({ platform: "darwin", sandboxExec: true, refused }), /signal left the sandbox/, String(refused));
  assert.deepEqual(pickFence({ platform: "linux", pidNs: ns, engineFile: true }), { name: "container", argv: [] });
  // A container wins over a namespace that would hold too.
  assert.deepEqual(pickFence({ platform: "linux", pidNs: ns, engineFile: true, unshare, refused: 0 }), { name: "container", argv: [] });
  for (const m of [{ platform: "linux", pidNs: FIRST_PID_NS, engineFile: false, unshare, refused: 0 }, { platform: "linux", pidNs: ns, engineFile: false, unshare, refused: 0 }, { platform: "linux", pidNs: null, engineFile: true, unshare, refused: 0 }]) {
    assert.deepEqual(pickFence(m), { name: "namespace", argv: namespaceArgv(unshare) }, JSON.stringify(m));
    assert.deepEqual(pickFence(m).argv.slice(0, UNSHARE_ARGS.length + 1), [unshare, ...UNSHARE_ARGS]);
  }
  for (const m of [
    { platform: "linux", pidNs: FIRST_PID_NS, engineFile: true },
    { platform: "linux", pidNs: ns, engineFile: false },
    { platform: "linux", pidNs: null, engineFile: true },
    { platform: "win32", pidNs: ns, engineFile: true, sandboxExec: true, refused: 0 },
    { platform: "win32", pidNs: ns, engineFile: false, unshare, refused: 0 },
    { platform: "freebsd", sandboxExec: true, refused: 0 },
  ]) assert.throws(() => pickFence(m), /no boundary keeps a signal/, JSON.stringify(m));
  // The namespace's check failed (the signal went: 3; the sleeper was gone or never started: 5, 7; unshare refused, as
  // under a restriction on unprivileged user namespaces: 1; it timed out: null), or there is no unshare.
  for (const refused of [1, 3, 5, 7, null]) {
    assert.throws(() => pickFence({ platform: "linux", pidNs: FIRST_PID_NS, engineFile: false, unshare, refused }), new RegExp(`no container .*no PID namespace of its own \\(/usr/bin/unshare: the check's exit ${refused}\\)`), String(refused));
  }
  assert.throws(() => pickFence({ platform: "linux", pidNs: FIRST_PID_NS, engineFile: false, unshare: null, refused: 0 }), /no container \(PID namespace pid:\[4026531836\], no engine file\), no unshare/);
});

test("shell box: a run in the boundary has no terminal of the caller's: a session of its own, and no /dev/tty in the namespace's root", () => {
  const box = shellBox("en-kill-tty-", { stands: {}, real: [] });
  try {
    // The session a command runs in, from /proc where there is one: a session of its own holds no controlling terminal
    // of the test runner's, so no text writes to the developer's terminal or pushes input into it.
    const session = "read -r _ _ _ _ _ s _ < /proc/self/stat; echo \"$s\"";
    if (existsSync("/proc/self/stat")) {
      const own = readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /s, "").split(" ")[3];
      const sid = inFence(["/bin/sh", "-c", session], { encoding: "utf8" }).stdout.trim();
      assert.notEqual(sid, own, "a fenced command ran in the test runner's session");
      if (box.fence === "namespace") {
        // The namespace's PID 1 leads a session of its own, and every run is in it.
        assert.equal(sid, "1");
        assert.equal(box.run(`${session} > sid`).status, 0);
        assert.equal(readFileSync(join(box.cwd, "sid"), "utf8").trim(), "1");
        assert.equal(box.run("test -e /dev/tty").status, 1, "the namespace's root holds the machine's /dev/tty");
        // A root the namespace's PID 1 could not build throws, said; a text's own exit 125 stays the text's.
        assert.throws(() => inFence(["/bin/sh", "-c", "exit 0"], { keep: [join(box.box, "missing")] }), /the namespace's root was not built: [^]*box-init: keep /);
        assert.equal(box.run("exit 125").status, 125);
      }
    }
  } finally {
    box.close();
  }
});

test("shell box: a program the namespace's root does not hold is refused when the box is made, by name", () => {
  // As a Homebrew, ~/.local/bin or /opt program would be: on PATH outside, in no folder the new root holds.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-kill-prog-")));
  writeFileSync(join(dir, "hello"), "#!/bin/sh\necho hello\n", { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    if (fenceName() === "namespace") {
      assert.throws(() => shellBox("en-kill-prog-", { stands: {}, real: ["hello"] }).close(), new RegExp(`hello: ${dir}/hello is in no folder the namespace's root holds`));
      assert.equal(inRoot(join(dir, "hello")), false);
      assert.equal(inRoot("/bin/sh"), true);
    } else {
      const box = shellBox("en-kill-prog-", { stands: {}, real: ["hello"] });
      try {
        assert.equal(box.run("hello > out").status, 0);
        assert.equal(readFileSync(join(box.cwd, "out"), "utf8"), "hello\n");
      } finally {
        box.close();
      }
    }
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shell box: a run past its time limit is stopped, and every process it started with it", async () => {
  const box = shellBox("en-kill-limit-", { stands: {}, real: ["sleep"], limit: 1000 });
  try {
    const text = "(sleep 2; echo late > late) & sleep 30";
    assert.deepEqual(unsafeTexts([text]), []);
    const start = Date.now();
    assert.throws(() => box.run(text), /did not end/);
    assert.ok(Date.now() - start < 8000, `${Date.now() - start} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // unshare ignores SIGTERM: the limit's SIGKILL ends it, and with it the namespace's PID 1 and the background job.
    // The sandbox and a container: the SIGKILL reaches the shell only, and the box then ends the run's process group.
    assert.equal(existsSync(join(box.cwd, "late")), false, `a process of a stopped run went on (${box.fence})`);
    // A test's own command run in the boundary has the same limit: SIGKILL, which holds under unshare too.
    const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
    assert.ok(sleep, "this harness needs sleep");
    const t = Date.now();
    const r = inFence([sleep, "30"], { limit: 500, encoding: "utf8" });
    assert.equal(r.signal, "SIGKILL");
    assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
  } finally {
    box.close();
  }
});

test("shell box: what a text sees of the files outside the box's folders is its boundary's", () => {
  const box = shellBox("en-kill-files-", { stands: {}, real: [] });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "en-kill-files-")));
  try {
    // What a box text may reach on the machine: the Docker, PostgreSQL, D-Bus and WSL interop sockets, the Windows
    // drive, the user's home; each looked at only, where the machine has it.
    const machine = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/postgresql", "/run/dbus/system_bus_socket", "/run/WSL", "/mnt/c", "/mnt/wsl", "/home", "/root"].filter((p) => existsSync(p));
    const seen = (/** @type {string} */ p) => box.run(`test -e '${p}'`).status === 0;
    const wrote = box.run(`echo x > '${join(outside, "w")}'`).status === 0;
    if (box.fence === "namespace") {
      assert.deepEqual([...machine, outside].filter(seen), [], "a path outside the box's folders is there inside");
      // Nor the machine's root under another name: the root holds what the namespace's PID 1 put there, nothing else.
      assert.equal(box.run("printf '%s\\n' /* /.[!.]* > roots").status, 0);
      const roots = readFileSync(join(box.cwd, "roots"), "utf8").split("\n").filter(Boolean);
      const put = ["/bin", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/sbin", "/tmp", "/usr", "/.[!.]*", `/${box.box.split("/")[1]}`];
      assert.deepEqual(roots.filter((r) => !put.includes(r)), [], "the root holds a folder the namespace did not put there");
      assert.deepEqual([wrote, existsSync(join(outside, "w"))], [false, false], "a box text wrote outside its folders");
      // Its own folders and a /tmp of its own are there to write; /tmp's files stay inside.
      const name = `en-kill-files-${process.pid}`;
      assert.equal(box.run(`test -w '${box.box}' && : > '/tmp/${name}' && test -e '/tmp/${name}'`).status, 0);
      assert.equal(existsSync(join("/tmp", name)), false, "the box's /tmp is the machine's");
      // WSL: a Windows program on the drive is not there to run (WSL_INTEROP set or not, its socket is gone too).
      if (existsSync("/mnt/c/Windows/System32/whoami.exe")) assert.equal(box.run("/mnt/c/Windows/System32/whoami.exe").status, 127);
    } else {
      // The sandbox and a container share the file system: a text sees and writes what the test runner's user does.
      assert.deepEqual([seen(outside), wrote, existsSync(join(outside, "w"))], [true, true, true]);
    }
  } finally {
    box.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("kill reader's harness: with no boundary every test that makes a box ends, failing on the throw, with nothing left open", () => {
  // Each test file as node runs it alone: a server or a sleeper a test opened before the box threw and never closed
  // keeps the file from ending (main 12097c8 in WSL: kill-targets sat on an open server until stopped).
  const top = fileURLToPath(new URL("..", import.meta.url));
  for (const [file, pattern] of [
    ["test/kill-targets.test.mjs", "^shell box|^kill reader: (a real bash agrees|the differential judge)"],
    ["test/push-spellings.test.mjs", "^push reader: (a real shell and a real git|on generated texts a real bash)"],
  ]) {
    // Not as a subtest of this run: node:test would then write its results in its own binary form.
    const env = { ...process.env, ENNYN_SHELL_BOX: "none" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--import", "./test/hermetic.mjs", "--test-reporter=tap", `--test-name-pattern=${pattern}`, file], { cwd: top, env, encoding: "utf8", timeout: 25000, killSignal: "SIGKILL" });
    assert.equal(r.signal, null, `${file} did not end with the box throwing`);
    const count = (/** @type {string} */ word) => Number(new RegExp(`^# ${word} (\\d+)$`, "m").exec(r.stdout)?.[1]);
    // Every box test ran and failed on the throw; the one that only reads pickFence passes.
    const thrown = r.stdout.split("ENNYN_SHELL_BOX=none").length - 1;
    assert.ok(count("fail") >= (file.includes("kill") ? 6 : 2), `${file}: ${count("fail")} failed\n${r.stdout.slice(-2000)}`);
    assert.ok(thrown >= count("fail"), `${file}: a test failed on something other than the throw\n${r.stdout.slice(-2000)}`);
    assert.equal(count("cancelled"), 0, file);
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
