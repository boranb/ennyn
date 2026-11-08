/**
 * Which command text stops a process the agent did not start: a kill chosen by a filter, a name, a window title, a
 * port or a PID looked up at run time. The PreToolUse hook (hooks/kill-targets.mjs) refuses what this names, in every
 * permission mode. It reads text and runs nothing. A reviewer once ran `taskkill //F //FI "WINDOWTITLE eq *"` to stop
 * its own hung process: that filter matches every window on the desktop, and the user's programs were open.
 *
 * The text goes through the push reader's one pass (push-spellings.mjs `commandsOf`): simple commands, those of
 * substitutions among them, each word with what built it and how it is spelt, and every redirection. A program's name
 * stands at a command's head and at the head after each block's `{` (`function f {`, `ForEach-Object {`), each past
 * assignments, shell grammar and PowerShell's `$x =`, and after such a head that runs its words (a wrapper, a shell,
 * `xargs`, `ssh`, `npx`, `find`, `coproc`: then at any word), one rule (programs), read two ways, each matched whole: past its folder and the extension Windows runs
 * it by, and as the last `\` or `/` segment of the word as written (`C:\Windows\System32\cmd.exe`,
 * `$env:SystemRoot\System32\taskkill.exe`). A shell's text (`bash -c "…"`, `powershell -Command "…"`) is read again.
 * A shell's word with `$` or a backtick in it is read again too (`bash -c 'pkill${IFS}node'`). Where a text can turn a
 * word into a program (TURNS where a program's name stands, here or in a shell's text read again: `eval`, `trap`,
 * `source`, `.`, `set`, `xargs`, `alias`, `declare`, `function`, `export -f`; a definition `name ()`; any expansion at a
 * program's place; `BASH_FUNC_` anywhere; shell text past the depth read), a kill word anywhere in it, in any quoting and
 * inside a word (`pkill${IFS}node`), refuses it unread unless it is a kill program's name the reader judged and passed:
 * `retry() { "$@"; }; retry pkill node`, `bash -c "$(echo pkill) node"`, `set -- pkill node; "$@"`, `echo pkill node |
 * xargs env`. The refusal names the word and the construct (`word`, `beside`), so the agent can split the command. A
 * quoted here-document's body is data here; `skill` counts only as a word of its own; a program's name a run joins to
 * letters (`$(echo pk)ill`) is refused unread.
 * The rule is bound to the program and its option's place; a word list only ever refuses.
 *
 * - Passes: `kill` of literal PIDs (`kill -9 1234`), of a process group (`kill -- -1234`, `kill -TERM -1234`), of the
 *   shell's own jobs (`%1`, `kill $(jobs -p)`: `jobs` names only this shell's children), `kill -l`;
 *   `taskkill /PID 1234 /T /F` (`//PID` as Git Bash writes it, `-pid`, any case), `tskill 1234`,
 *   `Stop-Process -Id 1234,5678` and `Stop-Process 1234`; a PID this same text started, `kill $!`; and a PID file read
 *   whole, `kill $(cat app.pid)` or `$(< app.pid)`, its name a word with no substitution in it. A name passes when every
 *   word of the text that sets or names it is one of those reads: bash's `pid=$!`, `pid=$(cat app.pid)` or a loop
 *   over literal PIDs (`for pid in 1234 5678`), then
 *   `kill $pid` (`"$pid"`, `${pid}`, `-$pid`); PowerShell's `$p = Start-Process …`, then `Stop-Process -Id $p.Id`, or
 *   `$p = Get-Content app.pid` (`[int](…)`, `(…).Trim()`), then `$p`. Decided so: `$!` is the last job this shell put
 *   in the background, and a PID file is the record an agent writes when it starts a process (a replay of 50,179 shell
 *   calls on one machine held 100 or so such kills, each by its PID); a name set in an earlier call is not in this text,
 *   and any other word naming it (`for pid in`, `read pid`, `export pid`, a pipe after `cat`) counts as another setting.
 * - Refused, `name`: `pkill`, `killall`, `killall5`, `skill`; `taskkill` with `/FI` or `/IM`, or with no `/PID`;
 *   `tskill` of a name; `Stop-Process` and PowerShell's `kill` with `-Name`, `-ProcessName`, `-InputObject` (any
 *   prefix PowerShell takes); `kill` of a word that is no number; `wmic process … delete` or `call terminate`; and,
 *   by a word list, `.Kill(` whose statement, or one that set a variable it names, looks a process up (`Get-Process`,
 *   `GetProcessesByName`, … but not `GetProcessById(1234)`), a kill method named as a string (`.ForEach('Kill')`,
 *   `.Methods['Kill']`), and a CIM or WMI method on `Win32_Process` or `Terminate`.
 * - Refused, `lookup`: a PID built at run time, a substitution (`kill $(lsof -t -i:3000)`, backticks), a variable not
 *   set as above (`$PID`, `$$`, `$_`, `%a` of a cmd loop, `P=$(netstat …)`), an `-Id` or `/PID` whose value is not in
 *   the command (`-Id (Get-NetTCPConnection …).OwningProcess`); a kill program after `xargs` or `parallel`; and
 *   `Stop-Process`, or a `kill` with no PID, fed by a pipe (`Get-Process node | Stop-Process`).
 * - Refused, `port`: `fuser -k`, `kill-port`, `fkill`. Refused, `every`: PID 0 or -1, the caller's group or every
 *   process the user may signal.
 * - Refused, `unread`: text it cannot read whole (not closed, over the ceiling, deeper than the stack) with a kill word;
 *   with a kill word in the text (backslashes, quotes, carets out), a shell fed by a pipe or a here-document
 *   (`echo 'pkill x' | sh`) or given its whole text by a run (`sh <(…)`, `bash -c "$(…)"`) and a program's name built
 *   by a run wherever a name stands (`"$(echo pkill)" x`, `env $(echo pkill) x`, PowerShell's backtick); an encoded command in any spelling PowerShell takes, after
 *   `powershell` or `pwsh` anywhere in the text, whatever it holds.
 * - A PID file is resolved (pidFile) and trusted only where every mention of it reads, tests or removes it or writes it
 *   in a listed shape from what this text trusts (trust). PowerShell's braces are set apart wherever they sit in a word
 *   (`ForEach-Object{Stop-Process`), and a kill whose target is a parenthesis (`Stop-Process (Get-Process x)`) is a
 *   lookup.
 *
 * What it refuses that is no kill of another's process, accepted: a word that names a kill program after a wrapper
 * (`sudo grep pkill f`), a word built by a run after a wrapper, a shell or another runner and before any kill program
 * (one after an option counts not), in a text with a kill word (`sudo -u $(whoami) kill 1234`, `sudo -E kill $(cat
 * a.pid)`, `nohup node s.js --port $(cat p) & kill $!`; after `npm`, `npx`, `yarn`, `find` and `ssh` only where the
 * program's name stands; none of 88,740 commands in one machine's transcripts), `.Kill(` and `Get-Process` both in one statement that only mentions them, a PID file read
 * through a pipe or by any program but `cat`, `<` and `Get-Content`, one named with a variable inside its path
 * (`$S/eg-$d.winpid`) or mentioned by any program but those that read, test or remove it (`node s.js --pidfile a.pid`),
 * and a PID file the agent's earlier call filled from a port lookup (`netstat … > app.winpid`).
 *
 * Stated limits, not chased: a script the agent writes and then runs, an interpreter (`python -c`, `node -e`), a
 * program's name a variable joins to letters (`${x}ill`),
 * an alias or a function defined earlier, a `$cmd` variable at a command's head, PowerShell's grammar past what is
 * listed (`"$(…)"` as an argument, splatting, `&` on a variable), a PID read in an earlier call and written here as a
 * number, a PID file of the same name another session wrote, and a PID file
 * gone stale, its process ended and its number given to another (the hook cannot know whose a number is), a command
 * held in a variable, a substitution in an unquoted here-document's body, text that becomes a program only when it runs
 * (`printf '\x70kill' | sh`, `base64 -d | sh`, `rev | bash`, a string joined for `iex`), a program that kills and no
 * list here holds, an MCP tool, and a hook that crashes or times out: Claude Code runs the call.
 */

import { ASSIGNMENT, GAP, KEYWORD, RUNS, SSH_VALUE, WRAPS, commandsOf, nameOf } from "./push-spellings.mjs";

/** Programs that kill by name or filter, whatever their words. */
const BY_NAME = /^(pkill|killall5?|skill)$/i;
/** Programs that kill whatever holds a port. */
const BY_PORT = /^(kill-port|fkill|fkill-cli)$/i;
/** Every program judgeAt reads: a name that is one of these is taken before another reading of the same word. */
const JUDGED = /^(pkill|killall5?|skill|kill-port|fkill|fkill-cli|fuser|wmic|kill|taskkill|tskill|stop-process|spps)$/i;
/**
 * Programs that run their words: after one, a kill program may stand at any word, and a word of it holding a space is
 * read again as text. A WSL distribution's launcher (`ubuntu.exe run …`), an elevation or remote runner (`gsudo`,
 * `psexec`, `runas`), PowerShell's `Invoke-Expression` and `Invoke-Command`, and bash's `coproc` (bash 4 and later
 * run its command, with a name before it or none; the push reader's keyword list stays as it is).
 */
const OPENS = /^(coproc|ssh|npx|pnpx|bunx|npm|pnpm|yarn|bun|find|gsudo|sudo|psexec(64)?|paexec|runas|iex|invoke-expression|invoke-command|icm|start-job|ubuntu[\d.]*|debian|kali(-linux)?|opensuse[\w.-]*|sles[\w.-]*|fedora[\w.-]*|alpine[\w.-]*|arch(linux)?|oraclelinux[\w.-]*|pengwin)$/i;
/** Programs that hand their words input from a pipe: a kill program after one kills PIDs read at run time. */
const FEEDS = /^(xargs|parallel)$/i;
/** A kill word, for text it cannot read whole and for text it sees go to a shell unread. */
const KILL_WORD = /(?<![\w-])(kill|pkill|killall5?|skill|taskkill|tskill|stop-process|spps|fuser|kill-port|fkill(-cli)?|wmic|icim|rcim|invoke-cimmethod|remove-ciminstance|invoke-wmimethod|remove-wmiobject)(?![\w-])|\.(kill|terminate|closemainwindow)\s*\(/i;
/** By a word list, toward refusal: a process object's Kill() beside a lookup, a CIM or WMI terminate. */
const LOOKS_UP = /\b(get-process|gps|ps|getprocesses(byname)?|getprocessbyid|get-ciminstance|gcim|get-wmiobject|gwmi|get-nettcpconnection|netstat|win32_process)\b/i;
/** A process looked up by a literal number is that PID: `[Diagnostics.Process]::GetProcessById(1234)`. */
const BY_LITERAL_ID = /getprocessbyid\s*\(\s*\d+\s*\)/gi;
const OBJECT_KILL = /\.(kill|terminate|closemainwindow)\s*\(/i;
/** A member a pipeline calls on each process: `| % Kill`, `ForEach-Object -MemberName Kill`. */
const MEMBER_KILL = /(^|[|;{(\s])(%|foreach-object|foreach)\s+(-membername\s+)?['"]?(kill|terminate|closemainwindow)\b/i;
/** A kill method named as a string: `.ForEach('Kill')`, `.psobject.Methods['Kill'].Invoke()`, `.InvokeMember('Kill', …)`. */
const NAMED_KILL = /\.(foreach|invokemember)\s*\(\s*['"](kill|terminate|closemainwindow)['"]|\.methods\s*\[\s*['"](kill|terminate|closemainwindow)['"]\s*\]/i;
const CIM_KILL = /\b(invoke-cimmethod|icim|invoke-wmimethod|remove-ciminstance|rcim|remove-wmiobject|rwmi)\b[^\n]*\b(terminate|win32_process)\b|\bwin32_process\b[^\n]*\b(invoke-cimmethod|icim|invoke-wmimethod|remove-ciminstance|rcim|remove-wmiobject|rwmi)\b/i;
/** A PowerShell anywhere in the text: then an encoded-command flag after it, whatever stands between, is text no reader sees. */
const POWERSHELL = /(?<![\w-])(pwsh|powershell)(\.exe)?(?![\w-])/i;
/**
 * `-EncodedCommand` in every spelling PowerShell takes (measured: Windows PowerShell 5.1.19041 and PowerShell 7.4.22 run
 * `-e`, `-ec`, `-en` … `-EncodedCommand` and `/e`, `/ec`, `/enc`; PowerShell 7 also `--EncodedCommand`, `--enc`, `--ec`),
 * and the Base64 after it (`-ArgumentList '-enc','UwB0…'` puts quotes and a comma between): `grep -E`, `node -e '…'`
 * and `wsl -e` in a text that also names PowerShell are no such flag.
 */
const FLAG = /(?:^|[\s'",;(|&{])(?:--?|\/)([A-Za-z]+)[\s'",:=]+[A-Za-z0-9+/]{12,}={0,2}(?=$|[\s'",;)|&}])/g;
/** @param {string} text */
const encoded = (text) => {
  const at = text.search(POWERSHELL);
  return at >= 0 && [...text.slice(at).matchAll(FLAG)].some((m) => m[1].toLowerCase() === "ec" || "encodedcommand".startsWith(m[1].toLowerCase()));
};
/** PowerShell's common parameters that take a value, so the value is no target. */
const PS_VALUE = /^(erroraction|ea|warningaction|wa|informationaction|infa|errorvariable|ev|warningvariable|wv|informationvariable|iv|outvariable|ov|outbuffer|ob|pipelinevariable|pv)$/i;
/** The PIDs of this shell's own jobs: `$(jobs -p)`, `-pr`, `-rp`, as a trap writes it. */
const JOBS = /^\$\(\s*jobs\s+-(p|pr|rp)\s*\)$/;
/** `$!`, the last job this shell put in the background. */
const BANG = /^\$(!|\{!\})$/;
/**
 * One file read whole by `cat` or `<`, its name a word with no substitution: `$(cat app.pid)`, `$(< "$S/app.pid")`.
 */
const READ = /^\$\(\s*(?:cat\s+|<\s*)("[^"`()]*"|'[^']*'|[^\s"'`|;&<>()]+)(?:\s+2>\s*\/dev\/null)?\s*\)$/;
/** Git Bash's Windows PID of a process: `/proc/$P/winpid`, `$P` a name, `$!` or another. */
const WINPID = /^\/proc\/\$\{?(!|[A-Za-z_]\w*)\}?\/winpid$/;
/** PowerShell's read of a PID file: `Get-Content <file>`, `[int](…)`, `(…).Trim()`, nothing piped or chained. */
const PS_FILE = /^\s*(\[int\]\s*)?\(?\s*get-content\s+("[^"]*"|'[^']*'|[^\s|;()]+)[^|;\n()]*\)?(\.trim\(\))?\s*$/i;
/** Programs whose mention of a PID file neither writes it nor points it elsewhere: they read, test or remove it. */
const LEAVES = /^(cat|rm|unlink|test|\[\[?|ls|stat|echo|printf|get-content|gc|type|remove-item|ri|del|erase|test-path|write-host|write-output)$/i;
/** PowerShell's writers of a PID file: `$p.Id | Out-File <file>`, `Set-Content <file> $p.Id`. */
const PS_WRITES = /^(out-file|set-content|sc|add-content|ac)$/i;
/**
 * Programs that can turn a word into a program when the text runs, judged where a program's name stands, in the text
 * or a shell's text read again: `eval`, `trap`, `source` and `.`, `set` (positional parameters), `xargs` and
 * `parallel`, `alias`, `declare`, `typeset`, `function`, `shopt`, and `export` with `-f`. With them, a definition
 * `name ()` (found from the pass) and an exported function in the environment (`BASH_FUNC_`, anywhere).
 */
const TURNS = /^(eval|trap|source|\.|set|xargs|parallel|alias|declare|typeset|function|shopt)$/i;
/**
 * The kill words looked for anywhere in such a text, a method's name after `x.` aside (`$p.Kill()` is objectKill's):
 * procps' `skill` only as a word of its own, since `SKILL.md`, `skills/` and `skill|eval` patterns are everywhere.
 */
const ANY_KILL = /(?<![\w-])(?<![\w)\]]\.)(kill|pkill|killall5?|taskkill|tskill|stop-process|spps|fuser|kill-port|fkill(-cli)?)(?![\w-])/i;
const SKILL = /(?<![^\s'"`;&(/=])skill(?=$|[\s'"`;&)])/;
const ANY_KILL_ALL = new RegExp(ANY_KILL.source, "gi");
const SKILL_ALL = new RegExp(SKILL.source, "g");
/** The first kill word of a text, quotes, backslashes and carets out if need be. @param {string} text */
const killWordOf = (text) => (KILL_WORD.exec(text) ?? KILL_WORD.exec(text.replace(/[\^`'"\\]/g, "")))?.[0];
/** A here-document's body under a quoted delimiter: data, unless a shell reads it, which its own rule refuses. */
const QUOTED_DOC = /<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;
/** How deep a shell's text is read again. */
const DEPTH = 4;

/**
 * @typedef {import("./push-spellings.mjs").Word} Word
 * @typedef {import("./push-spellings.mjs").Cmd} Cmd
 * @typedef {{ op: string, word: Word, cmd: Cmd }} Redir
 * @typedef {"name" | "lookup" | "port" | "every"} Why
 * @typedef {{ bang: Set<string>, read: Set<string>, started: Set<string>, reads: (exp: string) => boolean }} Own the names
 *   this text set, and set only so: bash's from `$!`, a PID file or a loop over literal PIDs (`bang`), PowerShell's from a
 *   PID file (`read`) or Start-Process (`started`), PowerShell's lower case; `reads`: whether an expansion reads a PID
 *   this text started or recorded
 */

/** A program's names: its word read past its folder and the extension Windows runs it by, and the last segment of the word as the source spells it (a Windows path whose backslashes the shell would drop, `$env:SystemRoot\…`). @param {Word} w */
const names = (w) => {
  const seg = (w.raw ?? "").replace(/["']/g, "").split(/[\\/]/).pop() ?? "";
  // procps' `skill` is no Windows program: `C:\tools\skill.exe` is another.
  const exe = /\.exe["']?$/i.test(w.raw ?? "");
  return [...new Set([nameOf(w), seg.replace(/\.(exe|cmd|bat|com)$/i, "")].map((n) => n.toLowerCase()))].map((n) => (n === "skill" && exe ? "skill.exe" : n));
};
/** Whether a program's name, either reading, passes `re`. @param {Word} w @param {RegExp} re */
const is = (w, re) => names(w).some((n) => re.test(n));

/**
 * How many words at `k` stand before a program's name: assignments, shell grammar, a PowerShell block's opening and
 * `[type]` (1), PowerShell's `$x =` (2), none (0). A word a run built is a program's name before `=` (`$(echo pkill) =
 * node` runs pkill in bash).
 * @param {Word[]} words @param {number} k
 */
const before = (words, k) => {
  const t = words[k].text;
  if (ASSIGNMENT.test(t) || KEYWORD.test(t) || BLOCK.test(t) || /^\[\w+\]$/.test(t)) return 1;
  return /^\u0000+$/.test(t) && words[k + 1]?.text === "=" && !ranAt(words[k]) ? 2 : 0;
};

/** The first word from `from` that is a program's, or -1. @param {Word[]} words */
const headAt = (words, from = 0) => {
  for (let k = from; k < words.length; ) {
    const n = before(words, k);
    if (!n) return k;
    k += n;
  }
  return -1;
};

/** Openers whose next word is no program: the program comes after `-exec` (find), after the destination (ssh). */
const FIND = /^find$/i;
const SSH = /^ssh$/i;
/** Package runners: the first word that is no option, or the one after `exec`, `x`, `dlx`, names what runs; a script's words follow. */
const PACKAGES = /^(npm|pnpm|yarn|bun|npx|pnpx|bunx)$/i;
const SUB = /^(exec|x|dlx)$/i;

/**
 * Where a program's name stands in a command's words, the one rule the reading takes, in one pass: the head, and the
 * head again after each block's opening (`{ …`, `function f { …`, `ForEach-Object { …`); after a head that runs its
 * words (a wrapper, a shell, an opener), every word that follows it. `built`: the places where a name built at run
 * time would be the program's: each head; after a wrapper, a shell or another runner every word up to a program
 * judgeAt reads, options and assignments out, and past a kill program's name too when it follows an option (it may be
 * the option's value: `exec -a fuser $(echo pkill)`); after a package runner, its first word that is no option and no
 * option's value (and the one after `exec`, `x`, `dlx`); after `find`, the words after `-exec` (`-execdir`, `-ok`);
 * after ssh, the words after its destination.
 * @param {Word[]} words @returns {{ at: number[], built: number[] }}
 */
function programs(words) {
  const n = words.length;
  // The head that starts at each word, read backwards once.
  const next = new Array(n + 2).fill(-1);
  for (let k = n - 1; k >= 0; k--) {
    const b = before(words, k);
    next[k] = b ? next[k + b] : k;
  }
  /** @type {Set<number>} */
  const heads = new Set();
  if (next[0] >= 0) heads.add(next[0]);
  words.forEach((w, k) => {
    if (BLOCK.test(w.text) && w.literal && next[k + 1] >= 0) heads.add(next[k + 1]);
  });
  /** @type {number[]} */
  const at = [];
  /** @type {number[]} */
  const built = [];
  let open = false;
  /** @type {"wrap" | "package" | "find" | "ssh" | null} */
  let mode = null;
  let afterOption = false;
  let sshHost = false;
  let sshEnded = false;
  for (let k = 0; k < n; k++) {
    const w = words[k];
    if (heads.has(k)) {
      at.push(k);
      built.push(k);
      if (is(w, WRAPS) || is(w, RUNS) || is(w, OPENS)) {
        open = true;
        mode = is(w, FIND) ? "find" : is(w, SSH) ? "ssh" : is(w, PACKAGES) ? "package" : "wrap";
        afterOption = false;
        sshHost = false;
        sshEnded = false;
      }
      continue;
    }
    if (!open) continue;
    at.push(k);
    const t = w.text;
    const option = /^-./s.test(t) && t !== "--";
    if (mode === "find") {
      if (/^-(exec|execdir|ok|okdir)$/.test(t)) mode = "wrap";
      continue;
    }
    if (mode === "ssh") {
      // OpenSSH's options, before and after the destination until `--` (push-spellings.mjs sshCommand).
      if (afterOption) afterOption = false;
      else if (!sshEnded && t === "--") sshEnded = true;
      else if (!sshEnded && option) afterOption = [...t.slice(1)].findIndex((c) => SSH_VALUE.includes(c)) === t.length - 2;
      else if (sshHost) {
        mode = "wrap";
        built.push(k);
        afterOption = false;
        if (is(w, JUDGED)) mode = null;
      } else sshHost = true;
      continue;
    }
    if (mode === null) continue;
    if (t === "--") {
      afterOption = false;
      continue;
    }
    if (option) {
      afterOption = true;
      continue;
    }
    if (ASSIGNMENT.test(t)) continue;
    const value = afterOption;
    afterOption = false;
    if (mode === "package") {
      if (value) {
        if (ranAt(w)) built.push(k);
        continue;
      }
      built.push(k);
      if (!SUB.test(t)) mode = null;
      continue;
    }
    built.push(k);
    if (is(w, JUDGED) && !value) mode = null;
  }
  return { at, built };
}

/**
 * The lower-case segments a word names a file by: its text and its spelling with its expansions taken out (a
 * substitution's own words are its command's), split at folders, `=`, `:`, `,` and quotes.
 * @param {Word} w
 */
const segments = (w) => {
  /** @param {string[]} exps */
  const without = (exps) => {
    let s = w.raw ?? "";
    for (const e of [...exps].sort((a, b) => b.length - a.length)) s = s.split(e).join(" ");
    return s.replace(/`[^`]*`?/g, " ");
  };
  const raw = without(w.exps);
  // And the word whole, its substitutions out, split only at what ends a word: a key that is a variable's name (`$f`)
  // is found so.
  const whole = without(w.exps.filter((e) => /^[$<>=]\(/.test(e))).replace(/["'{}]/g, "").toLowerCase().split(/[\s;|&<>()=,]+/);
  return new Set([...`${w.text} ${raw}`.split(/[\s/\\=:,;'"()[\]{}<>|&\u0000]+/).map((s) => s.toLowerCase()), ...whole].filter(Boolean));
};

/**
 * The names this text set, and set only from what it started or recorded, in one pass over its words and its
 * redirections and one walk of what depends on what: linear in the text. A PID file is trusted by its name, resolved
 * (pidFile), when every mention of that name in the text reads, tests or removes it, or writes it from `$!` or a trusted
 * name in one of the shapes listed (`echo $! >`, `>>`, `printf '%s' $P >`, `cat /proc/$P/winpid >`, `: >`, PowerShell's
 * `$p.Id | Out-File`, `Set-Content <file> $p.Id`); any other mention (`&>`, `>|`, `tee`, `cp`, `ln`, `New-Item`,
 * `[IO.File]::Write…`, a writer the text pipes or substitutes) makes it untrusted. A bash name is trusted when every
 * word that sets it is `name=$!`, `name=$(cat <trusted file>)`, `name=$(cat /proc/$P/winpid)` of a trusted `P`, or a loop
 * over literal PIDs, and no other word names it (`read pid`, `export pid`, `${pid:=…}`, a `declare -n` that binds it).
 * PowerShell's: every assignment of one kind (`= Get-Content <trusted file>`, `= Start-Process …`) and every other
 * mention a use, `$name` or `$name.Id`. What one trusts hangs on another (`P=$!; echo $P > a.pid; Q=$(cat a.pid)`): each
 * starts trusted and is dropped, with what hangs on it, once something it needs is not, until nothing changes.
 * @param {Cmd[]} cmds @param {Redir[]} redirs @param {string} text @returns {Own}
 */
function trust(cmds, redirs, text) {
  /** @type {Map<string, { local: boolean, deps: string[] }>} what each trusted thing needs: `b:` bash name, `f:` PID file, `s:`/`r:` PowerShell's */
  const nodes = new Map();
  const need = (/** @type {string} */ id) => nodes.get(id) ?? (nodes.set(id, { local: true, deps: [] }), /** @type {{ local: boolean, deps: string[] }} */ (nodes.get(id)));
  const drop = (/** @type {string} */ id) => {
    need(id).local = false;
  };
  /** @type {Map<string, Array<string | null>>} each bash name's values, null for one that is no literal */
  const bashValues = new Map();
  /** @type {Map<string, Array<string | null>>} each PowerShell name's values, lower case, `env:temp` among them */
  const psValues = new Map();
  for (const m of text.matchAll(/\$(?:\{)?((?:env:)?[A-Za-z_]\w*)\}?\s*=(?!=)\s*([^;\n]*)/gi)) {
    const v = /^(?:'([^']*)'|"((?:\$env:\w+)?[^"$`]*)")\s*$/i.exec(m[2]);
    const list = psValues.get(m[1].toLowerCase()) ?? [];
    list.push(v ? (v[1] ?? v[2]) : null);
    psValues.set(m[1].toLowerCase(), list);
  }
  /** @type {Array<{ word: Word, cmd: Cmd, k: number }>} */
  const all = cmds.flatMap((cmd) => cmd.words.map((word, k) => ({ word, cmd, k })));
  const loops = new Set(cmds.filter((c) => c.words[0]?.text === "for" && c.words[2]?.text === "in" && c.words.length > 3 && c.words.slice(3).every((w) => w.literal && /^\d+$/.test(w.text))).map((c) => c.words[1]));
  for (const w of loops) need(`b:${w.text}`);
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {Array<[string, string]>} each bash name set from a PID file, and the file */
  const fromFiles = [];
  /** @type {Array<[string, string]>} each name set from `/proc/$P/winpid`, and `P` */
  const fromWin = [];
  for (const { word: w, cmd, k } of all) {
    const set = /^([A-Za-z_]\w*)(\+?)=/.exec(w.text);
    if (set) {
      const [, name, plus] = set;
      const list = bashValues.get(name) ?? [];
      list.push(!plus && w.exps.length === 0 ? w.text.slice(name.length + 1) : null);
      bashValues.set(name, list);
      const exp = w.text === `${name}=${GAP}` && w.exps.length === 1 ? w.exps[0] : null;
      const file = exp === null ? null : READ.exec(exp);
      const win = file && WINPID.exec(unquote(file[1]));
      if (plus || exp === null) drop(`b:${name}`);
      else if (BANG.test(exp)) need(`b:${name}`);
      else if (win) fromWin.push([name, win[1]]);
      else if (file) fromFiles.push([name, file[1]]);
      else drop(`b:${name}`);
    } else if (/^[A-Za-z_]\w*$/.test(w.text) && !loops.has(w)) named.add(w.text);
    for (const e of w.exps) {
      const m = /^\$\{([A-Za-z_]\w*):?=/.exec(e);
      if (m) named.add(m[1]);
    }
    // `declare -n r=pid`: every name it binds is set unseen.
    if (k === 0 && /^(declare|typeset|local)$/.test(w.text) && cmd.words.some((x) => /^-\w*n/.test(x.text))) for (const x of cmd.words.slice(1)) for (const n of x.text.split("=")) if (/^[A-Za-z_]\w*$/.test(n)) named.add(n);
  }
  for (const name of named) drop(`b:${name}`);
  /** The values a variable at a path's start holds in this text: undefined when the text sets none. @param {string} start */
  const valuesOf = (start) => {
    const m = /^\$\{?((?:env:)?[A-Za-z_]\w*)\}?$/i.exec(start);
    if (!m) return undefined;
    return bashValues.get(m[1]) ?? psValues.get(m[1].toLowerCase());
  };
  /** @type {Map<string, string | null>} */
  const keys = new Map();
  /** A PID file's key, its name as written resolved, or null when it is none. @param {string} file */
  const keyOf = (file) => {
    if (!keys.has(file)) keys.set(file, pidFile(file, valuesOf));
    return /** @type {string | null} */ (keys.get(file));
  };
  for (const [name, file] of fromFiles) {
    const key = keyOf(file);
    if (key === null) drop(`b:${name}`);
    else need(`b:${name}`).deps.push(need(`f:${key}`) && `f:${key}`);
  }
  for (const [name, p] of fromWin) need(`b:${name}`).deps.push(p === "!" ? "!" : `b:${p}`);
  // PowerShell's names: each assignment's kind, the files it reads.
  /** @type {Map<string, Set<string>>} */
  const kinds = new Map();
  for (const m of text.matchAll(/\$([A-Za-z_]\w*)\s*=(?!=)([^;\n]*)|\$([A-Za-z_]\w*)\s+in\b/gi)) {
    const name = (m[1] ?? m[3]).toLowerCase();
    const file = m[2] === undefined ? null : PS_FILE.exec(m[2]);
    const key = file ? keyOf(file[2]) : null;
    const kind = m[3] ? "loop" : /^\s*start-process\b/i.test(m[2]) ? "started" : key !== null ? "read" : "other";
    kinds.set(name, (kinds.get(name) ?? new Set()).add(kind));
    if (kind === "read") need(`r:${name}`).deps.push(need(`f:${key}`) && `f:${key}`);
  }
  // A PowerShell name is trusted only where every other mention of it is a use, `$name` or `$name.Id`: `-OutVariable p`,
  // `Set-Variable p`, `Tee-Object -Variable p`, `-OutVariable:p`, `${p} =`, `$script:p =` and `$p +=` set it unseen: a
  // word that is the bare name (quoted or not), a braced or scoped spelling of it, an operator assignment. A name in a
  // string of several words (`"old $p stopped"`) is text. One scan of the words.
  /** @type {Set<string>} */
  const unseen = new Set();
  for (const { word: w, cmd, k } of all) {
    const t = w.text.toLowerCase();
    const bare = /^(?:-[\w-]+:)?([a-z_]\w*)$/.exec(t);
    if (bare && kinds.has(bare[1])) unseen.add(bare[1]);
    for (const m of (w.raw ?? "").matchAll(/\$\{([A-Za-z_]\w*)\}|\$(?:script|global|local|private|variable):([A-Za-z_]\w*)/gi)) unseen.add((m[1] ?? m[2]).toLowerCase());
    const own = w.exps.length > 0 ? /^\$([A-Za-z_]\w*)$/.exec(w.exps[0]) : null;
    if (own && (/^\u0000[-+*/%]=/.test(w.text) || (/^\u0000$/.test(w.text) && /^[-+*/%]=/.test(cmd.words[k + 1]?.text ?? "")))) unseen.add(own[1].toLowerCase());
  }
  for (const [name, k] of kinds) {
    const only = k.size === 1 && !unseen.has(name);
    need(`s:${name}`);
    need(`r:${name}`);
    if (!(only && k.has("started"))) drop(`s:${name}`);
    if (!(only && k.has("read"))) drop(`r:${name}`);
  }
  // Every PID file read is found by its key; its mentions, by the segments of every word and redirection.
  for (const { word: w } of all) for (const e of w.exps) {
    const m = READ.exec(e);
    if (m && !WINPID.test(unquote(m[1]))) {
      const key = keyOf(m[1]);
      if (key !== null) need(`f:${key}`);
    }
  }
  const files = new Set([...nodes.keys()].filter((id) => id.startsWith("f:")).map((id) => id.slice(2)));
  if (files.size) {
    // A variable set to a PID file's name (`F=app.pid`, `$f = "$env:TEMP\app.pid"`) names it: a mention of `$F` is one
    // of the file, and the setting itself is none.
    /** @type {Map<string, string>} */
    const by = new Map([...files].map((key) => [key, key]));
    /** @type {Set<Word>} */
    const naming = new Set();
    for (const cmd of cmds) {
      const [w0, w1] = cmd.words;
      const ps = w0 && w1 && cmd.words.length === 3 && /^\u0000$/.test(w0.text) && w1.text === "=" ?/^\$([A-Za-z_]\w*)$/.exec(w0.exps[0] ?? "")?.[1] : undefined;
      cmd.words.forEach((w, k) => {
        const name = ps !== undefined && k >= 2 ? ps : /^([A-Za-z_]\w*)=/.exec(w.text)?.[1];
        if (name === undefined || (ps !== undefined && k < 2) || w.exps.some((e) => /^[$<>=]\(/.test(e))) return;
        const key = [...segments(w)].find((s) => files.has(s));
        if (key === undefined) return;
        by.set(`$${name.toLowerCase()}`, key);
        naming.add(w);
        if (ps !== undefined) naming.add(w0);
      });
    }
    /** @param {Word} w @param {(key: string) => void} each */
    const mentions = (w, each) => {
      for (const s of segments(w)) {
        const key = by.get(s);
        if (key !== undefined) each(key);
      }
    };
    cmds.forEach((cmd, c) => {
      const head = headAt(cmd.words);
      cmd.words.forEach((w, k) =>
        naming.has(w) ? undefined : mentions(w, (key) => {
          const id = `f:${key}`;
          const prog = head >= 0 && k > head ? cmd.words[head] : null;
          if (prog && is(prog, LEAVES)) return;
          if (prog && is(prog, PS_WRITES)) {
            const from = psWriter(cmd, head, cmds[c - 1]);
            if (from !== null) return void need(id).deps.push(`s:${from}`);
          }
          drop(id);
        }),
      );
    });
    for (const r of redirs) {
      mentions(r.word, (key) => {
        const id = `f:${key}`;
        if (r.op === "<") return;
        const from = r.op === ">" || r.op === ">>" ? writer(r.cmd.words) : null;
        if (from === null) drop(id);
        else if (from !== "") need(id).deps.push(from);
      });
    }
  }
  // Each is trusted while all it needs is; an untrusted one drops what hangs on it, once.
  /** @type {Map<string, string[]>} */
  const users = new Map();
  for (const [id, n] of nodes) for (const d of n.deps) users.set(d, users.get(d) ?? []).get(d)?.push(id);
  const ok = new Map([...nodes].map(([id, n]) => [id, n.local && n.deps.every((d) => d === "!" || nodes.has(d))]));
  const work = [...ok].filter(([, v]) => !v).map(([id]) => id);
  while (work.length) {
    for (const u of users.get(/** @type {string} */ (work.pop())) ?? []) {
      if (ok.get(u)) {
        ok.set(u, false);
        work.push(u);
      }
    }
  }
  const trusted = (/** @type {string} */ prefix) => new Set([...ok].filter(([id, v]) => v && id.startsWith(prefix)).map(([id]) => id.slice(prefix.length)));
  const bang = trusted("b:");
  return {
    bang,
    read: trusted("r:"),
    started: trusted("s:"),
    reads: (exp) => {
      if (BANG.test(exp)) return true;
      const m = READ.exec(exp);
      if (!m) return false;
      const win = WINPID.exec(unquote(m[1]));
      if (win) return win[1] === "!" || bang.has(win[1]);
      const key = keyOf(m[1]);
      return key !== null && ok.get(`f:${key}`) === true;
    },
  };
}

/** A word as written, its outer quotes off. @param {string} s */
const unquote = (s) => s.replace(/^(["'])(.*)\1$/s, "$2");

/**
 * A PID file's name as the text writes it, resolved: `//`, `/./` and `..` read, `\` as `/`, a variable or `~` only at
 * its start, a variable this text sets replaced by each value it sets (none may be other than a literal). Its key, the
 * last segment in lower case, or null when it is no PID file: a glob, stdin (`-`, `/dev/stdin`), a device, a process's
 * or another tool's folder (`/dev/`, `/proc/`, `/sys/`, `/run/`, `/var/run/`), a `..` above a start that is no root, a
 * name that is a variable.
 * @param {string} file @param {(start: string) => Array<string | null> | undefined} valuesOf
 * @returns {string | null}
 */
function pidFile(file, valuesOf) {
  const f = unquote(file);
  if (/[*?[\]`]/.test(f) || f === "-") return null;
  const start = /^(?:\$\{?(?:env:)?[A-Za-z_]\w*\}?|~)/i.exec(f)?.[0];
  const rest = f.slice(start?.length ?? 0);
  // A `~` after the start is a letter: Windows' short names hold one (`PROGRA~1`).
  if (rest.includes("$")) return null;
  const values = start === undefined || start === "~" ? undefined : valuesOf(start);
  if (values?.includes(null)) return null;
  // A variable the text does not set, with no folder after it (`$f`, `$env:TEMPapp.pid`): the name as written is its
  // key, and a mention is a word spelt so.
  if (start !== undefined && start !== "~" && values === undefined && !/^[\\/]/.test(rest)) return /[\\/]/.test(rest) ? null : f.replace(/[{}]/g, "").toLowerCase();
  let key = null;
  for (const head of values ?? [start === undefined ? "" : null]) {
    // A value that starts at an environment variable's folder (`$s = "$env:TEMP\x"`) is a folder no text here names.
    const env = head === null ? null : /^\$env:\w+/i.exec(head);
    const k = env ? resolve(null, `${(head ?? "").slice(env[0].length)}${rest}`) : resolve(head === null ? null : `${head}${rest}`, rest);
    if (k === null || (key !== null && k !== key)) return null;
    key = k;
  }
  return key;
}

/**
 * The key of a path, or null. `path` null: the path starts at a folder no text here names, and `rest` follows it.
 * @param {string | null} path @param {string} rest
 */
function resolve(path, rest) {
  const p = (path ?? `\u0000${rest}`).replace(/\\/g, "/");
  const root = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  /** @type {string[]} */
  const out = [];
  const segs = p.split("/");
  const base = /^[A-Za-z]:$/.test(segs[0]) || segs[0] === "\u0000" ? 1 : 0;
  for (const [i, s] of segs.entries()) {
    if (i < base) out.push(s);
    else if (s === "" || s === ".") continue;
    else if (s === "..") {
      if (out.length > base) out.pop();
      else if (!root || segs[0] === "\u0000") return null;
    } else out.push(s);
  }
  const shown = `/${out.slice(base).join("/")}`;
  if (path !== null && p.startsWith("/") && /^\/(dev|proc|sys|run|var\/run)(\/|$)/.test(shown)) return null;
  const last = out.length > base ? out[out.length - 1].toLowerCase() : null;
  return last === null || /^(stdin|stdout|stderr|tty|null)$/.test(last) ? null : last;
}

/**
 * What a command that writes a PID file by `>` or `>>` writes into it: `""` nothing (`:` or `true`), `!` or `b:<name>`
 * the PID `echo $!`, `echo "$P"`, `printf '%s\n' $P` or `cat /proc/$P/winpid` gives, null anything else (a command
 * with no words: `(pgrep x) > f` is one).
 * @param {Word[]} words @returns {string | null}
 */
function writer(words) {
  const [a, b] = words.map((w) => w.text);
  if (words.length === 1 && (a === ":" || a === "true")) return "";
  /** @param {Word | undefined} w */
  const pid = (w) => {
    const m = w && w.exps.length === 1 && /^\u0000+$/.test(w.text) ? /^\$\{?(!|[A-Za-z_]\w*)\}?$/.exec(w.exps[0]) : null;
    return m ? (m[1] === "!" ? "!" : `b:${m[1]}`) : null;
  };
  if (a === "echo" && words.length === 2) return pid(words[1]);
  if (a === "echo" && words.length === 3 && b === "-n") return pid(words[2]);
  if (a === "printf" && words.length === 3 && words[1].exps.length === 0 && /^%s(\\n)?$/.test(b)) return pid(words[2]);
  if (a === "cat" && words.length === 2 && words[1].exps.length === 1) {
    const m = WINPID.exec(unquote(words[1].raw ?? ""));
    return m ? (m[1] === "!" ? "!" : `b:${m[1]}`) : null;
  }
  return null;
}

/**
 * PowerShell's write of a PID file from a process it started: `$p.Id | Out-File <file>` (the command before it in the
 * pipe is `$p.Id` alone) or `Set-Content <file> $p.Id` (`-Value $p.Id`). The name, lower case, or null.
 * @param {Cmd} cmd @param {number} head @param {Cmd | undefined} before
 */
function psWriter(cmd, head, before) {
  /** @param {Word | undefined} w */
  const id = (w) => (w && w.exps.length === 1 && w.text.toLowerCase() === `${GAP}.id` ? (/^\$([A-Za-z_]\w*)$/.exec(w.exps[0])?.[1].toLowerCase() ?? null) : null);
  const rest = cmd.words.slice(head + 1);
  const args = rest.filter((w, k) => !w.text.startsWith("-") && !/^-(encoding|en|width)$/i.test(rest[k - 1]?.text ?? ""));
  if (cmd.fed) return args.length === 1 && before?.words.length === 1 ? id(before.words[0]) : null;
  const ids = args.map(id).filter((n) => n !== null);
  return args.length === 2 && ids.length === 1 ? ids[0] : null;
}

/** Whether PowerShell reads `opt` (no dash, any case) as one of the parameters that pick processes by name or object. @param {string} opt @param {number} min */
const byName = (opt, min) => opt.length >= min && ["name", "processname", "inputobject"].some((p) => p.startsWith(opt));

/**
 * Whether a target word is a PID this text started or recorded. One expansion and nothing else in the word, a `-`
 * before it for a group: `$!`, a PID file read whole (`$(cat x.pid)`), `$name` or `${name}` of a name trust
 * gives, or `$name.Id` of a name set from Start-Process.
 * @param {Word} w @param {string} text the word's text, or the value after `:` @param {Own} own
 */
function started(w, text, own) {
  if (w.exps.length !== 1) return false;
  const shape = text.replace(/\u0000+/g, GAP);
  const exp = w.exps[0];
  if (shape === GAP || shape === `-${GAP}`) {
    if (own.reads(exp) || (shape === GAP && JOBS.test(exp))) return true;
    const m = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(exp);
    const name = m?.[1] ?? m?.[2];
    return Boolean(name && (own.bang.has(name) || own.read.has(name.toLowerCase())));
  }
  const m = /^\$([A-Za-z_]\w*)$/.exec(exp);
  return shape.toLowerCase() === `${GAP}.id` && Boolean(m && own.started.has(m[1].toLowerCase()));
}

/**
 * What a target is: null for a PID, a group or (with `jobs`) a job of this shell; else why it is refused.
 * @param {Word} w @param {string} text @param {Own} own @param {boolean} jobs
 * @returns {Why | null}
 */
function target(w, text, own, jobs) {
  if (text.includes(GAP)) return started(w, text, own) ? null : "lookup";
  if (text.startsWith("%")) return jobs ? null : "lookup";
  if (/^(\d+,)*\d+,?$/.test(text)) return text.split(",").some((n) => n !== "" && Number(n) === 0) ? "every" : null;
  // -0 is group 0, the caller's own, as 0 is.
  if (/^-\d+$/.test(text)) return Number(text) === -1 || Number(text) === 0 ? "every" : null;
  return "name";
}

/**
 * `kill`, bash's and util-linux's, and PowerShell's alias of Stop-Process: one signal option first, `--`, then
 * targets; after the signal a negative number is a group. PowerShell's `-Name` family refuses, its `-Id` takes the
 * next word or the value after `:`.
 * @param {Word[]} args @param {Own} own @param {boolean} fed
 * @returns {Why | null}
 */
function kill(args, own, fed, paren = false) {
  /** @type {Array<[Word, string]>} */
  const targets = [];
  let ended = false;
  let signal = false;
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    if (!ended && t === "--") ended = true;
    // After the signal, a negative number or a `-` before an expansion (`-$(pgrep x)`, `-${PGID}`) is a group.
    else if (!ended && t.startsWith("-") && t !== "-" && !(signal && (/^-\d+$/.test(t) || t.includes(GAP) || args[j].exps.length > 0))) {
      const [opt, ...rest] = t.slice(1).split(":");
      const o = opt.toLowerCase();
      if (byName(o, 2)) return "name";
      if (o === "l" || o === "-list") return null;
      if (opt === "n" && !/^\d+$/.test(args[j + 1]?.text ?? "")) return "name";
      if (o === "i" || o === "id") {
        if (rest.length) targets.push([args[j], rest.join(":")]);
        else if (j + 1 >= args.length) return "lookup";
      } else if (opt === "s" || opt === "n" || o === "-signal") j++;
      signal = true;
    } else targets.push([args[j], t]);
  }
  // No target in its words and a pipe or a parenthesis gives it one: PowerShell's `kill (Get-Process x).Id`.
  if (!targets.length) return fed || paren ? "lookup" : null;
  for (const [w, t] of targets) {
    const why = target(w, t, own, true);
    if (why) return why;
  }
  return null;
}

/**
 * `taskkill`: options as `/X`, `//X` (Git Bash) or `-X`, any case. `/FI` and `/IM` refuse, and so does no `/PID`.
 * @param {Word[]} args @param {Own} own @returns {Why | null}
 */
function taskkill(args, own) {
  let pid = false;
  for (let j = 0; j < args.length; j++) {
    const m = /^(?:\/\/?|-)([a-z?]+)$/i.exec(args[j].text);
    const o = m?.[1].toLowerCase();
    if (!o) return args[j].text.includes(GAP) ? "lookup" : "name";
    if (o === "fi" || o === "im") return "name";
    if (o === "pid") {
      const v = args[++j];
      if (!v) return "lookup";
      const why = target(v, v.text, own, false);
      if (why) return why;
      pid = true;
    } else if (o === "s" || o === "u" || o === "p") j++;
  }
  return pid ? null : "name";
}

/**
 * `Stop-Process` and `spps`: `-Id` (or `-i`, `-Id:`) or positional PIDs; the `-Name` family refuses at any prefix; a
 * pipe feeds it process objects.
 * @param {Word[]} args @param {Own} own @param {boolean} fed @returns {Why | null}
 */
function stopProcess(args, own, fed, paren = false) {
  if (fed) return "lookup";
  /** @type {Array<[Word, string]>} */
  const targets = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    if (t.startsWith("-") && !/^-\d/.test(t)) {
      const [opt, ...rest] = t.slice(1).split(":");
      const o = opt.toLowerCase();
      if (o === "i" || o === "id") {
        if (rest.length) targets.push([args[j], rest.join(":")]);
        else if (args[j + 1]) targets.push([args[j + 1], args[++j].text]);
        else return "lookup";
      } else if (byName(o, 1)) return "name";
      else if (PS_VALUE.test(o) && !rest.length) j++;
    } else targets.push([args[j], t]);
  }
  if (!targets.length && paren) return "lookup";
  for (const [w, t] of targets) {
    const why = target(w, t, own, false);
    if (why) return why;
  }
  return null;
}

/**
 * `tskill`: a PID or a name, options as `/x` or `/x:value`.
 * @param {Word[]} args @param {Own} own @returns {Why | null}
 */
function tskill(args, own) {
  const first = args.find((w) => !w.text.startsWith("/"));
  return first ? target(first, first.text, own, false) : null;
}

/**
 * Why the program at `k` refuses this command, or null. `feed`: the first word from the command's head that names a
 * program feeding its words from a pipe (`xargs`), or the words' length.
 * @param {Word[]} words @param {number} k @param {Cmd} cmd @param {Own} own @param {number} feed @returns {Why | null}
 */
function judgeAt(words, k, cmd, own, feed) {
  const all = names(words[k]);
  const name = all.find((n) => JUDGED.test(n)) ?? all[0];
  if (!JUDGED.test(name)) return null;
  // A PowerShell block's `}` ends the command's words: `{ taskkill /PID 1234 /F }`.
  let close = k + 1;
  while (close < words.length && !(words[close].text === "}" && words[close].literal)) close++;
  if (close === words.length) close = -1;
  const args = words.slice(k + 1, close < 0 ? words.length : close);
  const viaFeed = feed < k;
  if (BY_NAME.test(name)) return "name";
  if (BY_PORT.test(name)) return "port";
  if (name === "fuser") return args.some((w) => /^-\w*k|^--kill$/.test(w.text)) ? "port" : null;
  if (name === "wmic") return args.some((w) => /^(process|win32_process)$/i.test(w.text)) && args.some((w) => /^(delete|terminate)$/i.test(w.text)) ? "name" : null;
  const kills = name === "kill" || name === "taskkill" || name === "tskill" || name === "stop-process" || name === "spps";
  if (!kills) return null;
  if (viaFeed) return "lookup";
  // A `(` after the words gives the argument only when nothing closed the words before it.
  const paren = Boolean(cmd.paren) && close < 0;
  if (name === "kill") return kill(args, own, cmd.fed, paren);
  if (name === "taskkill") return taskkill(args, own);
  if (name === "tskill") return tskill(args, own);
  return stopProcess(args, own, cmd.fed, paren);
}

/** A word that opens a PowerShell block: the word after it stands where a program's name stands. */
const BLOCK = /^[%&.]?\{$/;
/** Shells that run text fed to them by a pipe, a here-document, a process substitution or a substitution as their whole text. */
const SHELLS = /^((ba|z|da|k|c|tc|fi|a|rba)?sh|pwsh|powershell|cmd|wsl|iex|invoke-expression|source|\.)$/i;

/**
 * Whether a word was built by running something: a `$(…)` in it (with `procs`, a process substitution too), or a
 * backtick (a GAP no `$` expansion accounts for: PowerShell's escape reads as one). A variable alone is no such word:
 * `if ($id)` and `foreach ($p in $k)` hold one; nor is bash's array, `PG=(…)`.
 * @param {Word} w @param {boolean} [procs]
 */
const ranAt = (w, procs = false) => w.exps.some((e) => (procs ? /^[$<>]\(/ : /^\$\(/).test(e)) || w.text.split(GAP).length - 1 > w.exps.reduce((n, e) => n + (e.startsWith("${") ? 2 : 1), 0);

/** Whether a text names a kill anywhere, quotes, backslashes, cmd's caret and PowerShell's backtick out. @param {string} text */
const killish = (text) => KILL_WORD.test(text) || KILL_WORD.test(text.replace(/[\^`'"\\]/g, ""));

/**
 * The words with a PowerShell block's braces set apart wherever they sit in a word with no space in it:
 * `ForEach-Object{Stop-Process` is `ForEach-Object`, `{` and `Stop-Process`, `$_}` is `$_` and `}`, `.{Stop-Process` is
 * `.`, `{`, `Stop-Process`. A brace keeps its word's quoting: a quoted one opens no block. A word with a space in it is
 * text (a shell's, read again whole) and stays as it is.
 * @param {Word[]} words @returns {Word[]}
 */
const unglued = (words) =>
  words.flatMap((w) => {
    if (!/[{}]/.test(w.text) || /\s/.test(w.text) || /^[{}]$/.test(w.text)) return [w];
    const parts = w.text.split(/([{}])/).filter((p) => p !== "");
    const gaps = parts.filter((p) => p.includes(GAP)).length;
    return parts.map((p) => ({ ...w, text: p, raw: p, exps: p.includes(GAP) ? (gaps === 1 ? w.exps : [...w.exps, ...w.exps]) : [] }));
  });

/**
 * Whether a `.Kill()` on a process object reaches one looked up: in its statement (split at `;`, a line, `&&`, `||`), or
 * in the statement that set a variable it names, and so on back. `GetProcessById(1234)` is that PID, no lookup.
 * @param {string} command
 */
function objectKill(command) {
  if (!OBJECT_KILL.test(command)) return false;
  const statements = command.split(/;|\n|&&|\|\|/);
  /** @type {Map<string, number[]>} each variable, the statements it is named in */
  const namedIn = new Map();
  const looks = statements.map((s) => LOOKS_UP.test(s.replace(BY_LITERAL_ID, "")));
  const sets = statements.map((s) => /\$([A-Za-z_]\w*)\s*=(?!=)|foreach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b/i.exec(s)?.slice(1).find(Boolean)?.toLowerCase() ?? null);
  statements.forEach((s, i) => {
    for (const m of s.matchAll(/\$([A-Za-z_]\w*)/g)) namedIn.set(m[1].toLowerCase(), namedIn.get(m[1].toLowerCase()) ?? []).get(m[1].toLowerCase())?.push(i);
  });
  // A variable is a lookup when a statement that sets it looks one up or names such a variable: one walk.
  /** @type {Set<string>} */
  const tainted = new Set();
  const work = statements.flatMap((_, i) => (looks[i] && sets[i] ? [/** @type {string} */ (sets[i])] : []));
  while (work.length) {
    const v = /** @type {string} */ (work.pop());
    if (tainted.has(v)) continue;
    tainted.add(v);
    for (const i of namedIn.get(v) ?? []) if (sets[i] && !tainted.has(/** @type {string} */ (sets[i]))) work.push(/** @type {string} */ (sets[i]));
  }
  return statements.some((s, i) => OBJECT_KILL.test(s) && (looks[i] || [...s.matchAll(/\$([A-Za-z_]\w*)/g)].some((m) => tainted.has(m[1].toLowerCase()))));
}

/**
 * @param {string} command @param {number} depth @param {{ turns: string | null, proven: string[] }} seen of the whole
 *   text: what can turn a word into a program (an expansion at a program's place, a shell's text past DEPTH), and the
 *   spelling of each kill program's name judged and passed
 * @returns {{ why: Why | "unread", part: string, word?: string, beside?: string } | null}
 */
function read(command, depth, seen) {
  const parsed = commandsOf(command);
  const said = killish(command);
  if (!parsed) return said ? { why: "unread", part: command.slice(0, 200) } : null;
  // A PowerShell given an encoded command, anywhere in the text: no reader here sees what it runs.
  if (encoded(command)) return { why: "unread", part: command.slice(0, 200) };
  const { cmds, redirs } = parsed;
  const own = trust(cmds, redirs, command);
  for (const cmd of cmds) {
    const words = unglued(cmd.words);
    const { at, built } = programs(words);
    if (!at.length) continue;
    const placed = at.find((k) => words[k].text.includes(GAP) || is(words[k], TURNS) || (is(words[k], /^export$/i) && words.some((w) => /^-\w*f/.test(w.text))));
    if (placed !== undefined) seen.turns ??= words[placed].raw.slice(0, 40);
    // `name () {`: the pass leaves the name a command of its own, the parenthesis and the body after it in the text
    // (PowerShell's `.Kill()` has no body).
    if (cmd.words.length === 1 && /^\s*\(\s*\)\s*[{(]/.test(command.slice(cmd.at + (cmd.words[0].raw ?? "").length))) seen.turns ??= `${cmd.words[0].raw} ()`;
    const head = words[at[0]];
    const part = () => cmd.words.map((w) => w.text.split(GAP).join("$…")).join(" ");
    // A name a run joins to letters is no name the text holds: `$(echo pk)ill`, `pk$(echo ill)`, in the word's last
    // segment (`$(npm bin)/eslint` names eslint). A variable joined so (`node-v$v`) is a stated limit.
    if (built.some((k) => ranAt(words[k]) && /\w\u0000|\u0000\w/.test(words[k].text.split("/").pop() ?? ""))) return { why: "unread", part: part() };
    const runs = at.some((k) => is(words[k], WRAPS) || is(words[k], OPENS)) || words.slice(at[0]).some((w) => is(w, RUNS) || is(w, /^ssh$/i));
    // Text no reader here sees, with a kill word in the text: a shell fed by a pipe or a here-document, or given its text
    // whole by a run (`sh <(…)`, `source <(…)`, `bash -c "$(…)"`), and a program's name built at run time
    // (`"$(echo pkill)" node`, `env $(echo pkill) node`, PowerShell's backtick).
    let lastRun = -1;
    words.forEach((w, k) => {
      if (ranAt(w, true) && /^\u0000+$/.test(w.text)) lastRun = k;
    });
    const fed = said ? at.find((k) => is(words[k], SHELLS) && (cmd.fed || lastRun > k)) : undefined;
    if (fed !== undefined) return { why: "unread", part: part(), word: killWordOf(command), beside: words[fed].raw.slice(0, 40) };
    // A name with a space in it is no program: PowerShell writes a string (`"left: $($k.Count)"`) where bash would run one.
    const ran = said ? built.find((k) => ranAt(words[k]) && !/\s/.test(words[k].text)) : undefined;
    if (ran !== undefined) return { why: "unread", part: part(), word: killWordOf(command), beside: words[ran].raw.slice(0, 40) };
    let feed = at[0];
    while (feed < words.length && !is(words[feed], FEEDS)) feed++;
    for (const k of at) {
      const why = judgeAt(words, k, cmd, own, feed);
      if (why) return { why, part: part() };
      if (is(words[k], JUDGED) && !words[k].text.includes(GAP)) seen.proven.push(words[k].raw);
    }
    // A shell's text, read again: `bash -c "pkill x"`, `pwsh -c "…"`, ssh's command words, cmd's with its caret out. An
    // expansion here stands as one there.
    if (runs && depth < DEPTH) {
      for (const w of cmd.words.slice(cmd.words.indexOf(head) + 1)) {
        // A word with a space, or with an expansion only that shell expands (`'pkill${IFS}node'`).
        if (!/[\s$`]/.test(w.text)) continue;
        const text = w.text.split(GAP).join("${E}");
        const inner = read(text, depth + 1, seen) ?? (text.includes("^") ? read(text.replace(/\^(.)/g, "$1"), depth + 1, seen) : null);
        if (inner) return inner;
      }
    } else if (runs && cmd.words.some((w) => /\s/.test(w.text))) seen.turns ??= `${DEPTH + 1} shells deep`;
  }
  if (objectKill(command)) return { why: "name", part: command.slice(0, 200) };
  if (MEMBER_KILL.test(command) || NAMED_KILL.test(command) || CIM_KILL.test(command)) return { why: "name", part: command.slice(0, 200) };
  return null;
}

/**
 * Why `command` stops a process it did not start, and the part refused, or null. A kill word beside what can turn a
 * word into a program (TURNS) says both: `word`, and `beside`, the construct as written.
 * @param {string} command what the tool will run
 * @returns {{ why: Why | "unread", part: string, word?: string, beside?: string } | null}
 */
export function killTarget(command) {
  const data = command.replace(QUOTED_DOC, " ");
  /** @type {{ turns: string | null, proven: string[] }} */
  const seen = { turns: /BASH_FUNC_/.test(data) ? "BASH_FUNC_" : null, proven: [] };
  const why = read(command, 0, seen);
  if (why || seen.turns === null) return why;
  // Each kill program's name judged and passed accounts for one kill word of its spelling; a kill word left over is one
  // no place here proves. One pass over the text for each reading, so the cost stays linear.
  const bare = data.replace(/[\^`'"\\]/g, "");
  /** @type {Map<string, number>} */
  const passed = new Map();
  for (const raw of seen.proven) {
    const w = (ANY_KILL.exec(raw) ?? SKILL.exec(raw) ?? ANY_KILL.exec(raw.replace(/[\^`'"\\]/g, "")))?.[0].toLowerCase();
    if (w) passed.set(w, (passed.get(w) ?? 0) + 1);
  }
  /** @param {string} text @param {RegExp} re */
  const left = (text, re) => {
    const have = new Map(passed);
    for (const m of text.matchAll(re)) {
      const n = have.get(m[0].toLowerCase()) ?? 0;
      if (!n) return m[0];
      have.set(m[0].toLowerCase(), n - 1);
    }
    return null;
  };
  const word = left(data, ANY_KILL_ALL) ?? left(bare, ANY_KILL_ALL) ?? left(data, SKILL_ALL) ?? left(bare, SKILL_ALL);
  return word ? { why: "unread", part: command.slice(0, 200), word, beside: seen.turns } : null;
}
