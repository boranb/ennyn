/**
 * The reader behind the kill hook (adapters/claude-code/kill-targets.mjs): an accept and a reject corpus, written by
 * hand in the shapes agents use on Linux, macOS and Windows (Git Bash, PowerShell, cmd), each refusal with the reason
 * it gets. A refusal stalls an agent and a miss is a kill that may reach the user's own programs, so both directions
 * are held. Then the hook itself, as Claude Code runs it, on temporary projects; test/reference/pretooluse.json records
 * what Claude Code does with what it prints. Generated texts run through a real bash against stand-ins, and bash's
 * answer is held against the reader's. Nothing here runs a kill: the hook is fed JSON, and bash's kills reach stand-ins.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killTarget } from "../adapters/claude-code/kill-targets.mjs";
import { shellBox, unsafeTexts } from "./shell-box.mjs";

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
 * outside the box, the test runner's own, is in another group.
 * @param {Record<string, string>} [lookups] a lookup stand-in's lines, in place of the answer no process has
 */
function killStands(lookups = {}) {
  const ps = existsSync("/proc/self/stat") ? null : "/bin/ps";
  const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
  assert.ok(sleep && (ps === null || existsSync(ps)), "this harness needs sleep, and ps where there is no /proc");
  // A PID's process group, from /proc on Linux, from ps elsewhere; nothing when it is gone.
  const pgid = `pgid() { if [ -r /proc/$1/stat ]; then read -r _ _ _ _ g _ < /proc/$1/stat; echo "$g"; else '${ps}' -o pgid= -p "$1" 2>/dev/null | tr -d ' '; fi; }`;
  const kill = [
    pgid,
    'own=""',
    'for a in "$@"; do t=${a#-}; case "$t" in \'\'|*[!0-9]*) continue;; esac; g=$(pgid "$t"); [ "$g" = "$BOX_TOP" ] && [ "$t" != "$BOX_TOP" ] && own="$own $t"; [ -z "$g" ] && own="$own $t"; done',
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
    const checks = KILL_CONTEXTS.map(([, put]) => put("{}")).filter((t) => t !== null);
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
  // The test's own sleep, outside the box; the stand-in kill signals nothing, and the texts ask for signal 0.
  const outside = spawn(sleep, ["30"], { stdio: "ignore" });
  const box = shellBox("en-kill-judge-", { stands: killStands({ pgrep: `echo ${outside.pid}` }), real: ["cat", "tr"] });
  try {
    const texts = ["kill -0 $(pgrep x)", "sleep 1 & kill -0 $!", "coproc P { kill -0 $(pgrep x); }", "coproc P { sleep 1 & kill -0 $!; }", "coproc P { sleep 1 & pid=$!; kill -- -$pid; }", "kill -0 $$", 'sh -c "kill -0 $$"', "bash -c 'kill -0 $PPID'"];
    assert.deepEqual(unsafeTexts(texts), []);
    assert.deepEqual(box.builtins("kill", ["{}", "coproc P { {}; }"]), [], "a context where the kill builtin is still on");
    const judged = texts.map((text) => {
      const { calls } = box.run(text);
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
    box.close();
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
