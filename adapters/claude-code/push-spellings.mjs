/**
 * Which command text is a push outside the shape Claude Code's ask rule reads for certain. The PreToolUse hook
 * (hooks/push-spellings.mjs) refuses what this names, in every permission mode. It reads text and runs nothing.
 *
 * This stops a push written another way by habit. It is no boundary: hand-crafted shapes pass and always will, and a
 * program set on pushing gets through. Following each route to a push is a race against a shell, so it does not: it looks
 * for a push word, then asks what could run it.
 *
 * - No push word, no refusal. A push word is a whole word `push`, `send-pack`, `http-push` or `git-push` and the like,
 *   in the command's words with quotes and backslashes removed: `push-spellings.mjs`, `feat/git-push-hook` and
 *   `# no push` are none. The one exception is an alias: a git verb that names an alias set in the session's environment
 *   or by a word of the command (`-c`, `--config-env`, `GIT_CONFIG_*`) is judged a push, whatever it expands to, chains and
 *   subsections included. A name a message only mentions sets nothing. PowerShell's splat at a word's head (`git @args`)
 *   is a built word, as `"$@"` is.
 * - A text that may define a shell alias is read by its structure, not by the alias: it holds the word `alias`, `sal` or
 *   `nal` anywhere but in git's `alias.x` key, quotes and backslashes removed (bash's `alias`, however called:
 *   `builtin`, `command`, `eval`; PowerShell's `Set-Alias`, `New-Alias`, `Set-Item alias:g`, `New-Item -Path alias:g`,
 *   `${alias:g}`, colon parameters).
 *   Then every command with a push word whose program is not git by its own name is refused (`alias g=git; g push`,
 *   `alias h=git; alias g=h; g push`, `Set-Alias -Name:g -Value:git; g push`): following each way to define one missed a
 *   spelling each round. The cost, accepted: a push word that is no push under an alias is refused too (`g stash push`,
 *   `g log --grep push`, `g commit -m 'push later'`, `alias ll='ls -la'; ll push`). A command git heads by its name is
 *   read as everywhere else.
 * - A push is left alone, to the rule, when every push in the text is `git push` and literal words, read from the source,
 *   at the head of a simple command of the top-level list, with nothing before it in that command and only redirects to
 *   literal places after it; and the whole text is under 9,000 characters and holds nothing but plain words, space, newline,
 *   `;`, `|`, `>`, `&&` and the token `2>&1`. So `cd x && git push`,
 *   `git add . && git commit -qm x && git push origin main 2>&1 | tail -3` and `git fetch origin` + newline +
 *   `git push > out 2>&1` are left. `git commit -m "x" && git push` is refused once, and so is any text with a quote, a `$`
 *   or a comment, wherever it stands: write the push in a call of its own, `git push …`, or `cd <folder> && git push …` from
 *   another folder, with the commit in the call before.
 * - Why that narrow: the rule reads a compound only if Claude Code's parser finishes. When it gives up, on length, nodes, a
 *   deadline, a stack, a budget spent over the whole text or a here-document case, only a match on the whole text is left,
 *   and a push later in the text runs unasked in bypass. A comment holding an apostrophe after a redirect does the same,
 *   with the parser finished (test/reference/pretooluse.json). The reader does not copy the parser's rules: tests of what the parser might give up
 *   on were each passed by a text it did not finish. It leaves only text with nothing to misread.
 * - A push word that is data stays left: a here-document to a program that does not run it, an argument of a program
 *   that runs nothing (INERT, `git commit -m`, `git log --grep`), and other programs' push (`docker push`, `npm run push`,
 *   `git stash push`, `adb push`). A word list here only ever leaves: a program no list holds is judged by its words.
 * - Text that runs text is not followed: a shell, `eval`, `source`, `xargs`, `env -S`, `find -exec`, a built word where a
 *   program's name stands, a substitution in an unquoted here-document, a built word at git's verb place: with a push word
 *   in any text it can reach, refused. Its options are not read, so `bash -euo pipefail -c` hides nothing. `runuser` and
 *   util-linux `script` (`-c`), `wsl` with no `--exec`, a WSL launcher's `run` or `-c` (`ubuntu.exe run …`) and
 *   `Start-Process` (`start`, `saps`) give text to a shell or a command line too, and the push word is looked for with
 *   cmd's caret out. A program's name stands at the head and, after a wrapper (WRAPS), at any word, and is read past its
 *   folder, a `/` or a `\` (a quoted Windows path), without the extension Windows runs it by:
 *   `"C:\Program Files\Git\cmd\git.exe" push` is git and `powershell.exe -c` a shell (measured on Windows).
 * - A word is read once, as the shell passes it: `"g\it"` names a program `it` in a folder, `git -C "C:\x" log` holds a
 *   path. A second reading is made where a second shell reads the words: ssh joins its command words with one space and
 *   the other machine's shell reads the line, so that line is read here as a shell's text, `;`, `&&`, quotes and
 *   backslashes as there (`ssh host "true;git" push`, `ssh host git "\-C" dir push`). ssh's options are read past (each
 *   letter's value as OpenSSH 8.9p1, 9.5p1 and 9.9p1 take it), its own words run here (`-o ProxyCommand=…`, a push word
 *   there refuses), and with no command the shell there reads what ssh is fed. An expansion here is a built word there
 *   (`ssh host "$(echo git push)"`), and an ssh inside that line runs text.
 * - A name that only reads (INERT) has no folder and no extension off but `.exe`: `./echo` may be a program the work tree
 *   brought, and a `.bat` or a `.cmd` is no builtin.
 * - Every word named git is looked at, not the first, and an option before the verb that TAKES_VALUE and PLAIN_OPTION do
 *   not know is taken to hide the verb.
 * - Text that does not close, or past what can be read (over CEILING, deeper than the stack), is judged by the push word.
 *
 * What it refuses that is no push, accepted: `"$DOCKER" push x`, `timeout 5 echo git -C . push`, `ssh host git push`,
 * `/bin/echo git push`, `ls git push`, a function that forwards to git with a push word anywhere in the text, an argument
 * `push` to a script run by a shell, `Start-Process git "stash push"`. One push word anywhere arms what is fed text and a
 * built word at git's verb place, an unrelated command's included (`git log --grep push; ls | xargs echo`). A shift
 * outside `$((…))` reads as a here-document, and what then does not close is judged by the word (`((x = 1 << 2))`). A
 * `#` right after `)` is read as text, since zsh's glob `(a)#` is one word, so a real comment there is read too
 * (`(echo a)# git push`). What it refuses that is a push the rule would ask about: every push in a text outside the plain
 * language, however simple the rest of it is.
 *
 * Stated limits, not chased:
 * - text whose shell grammar the reader does not read, so it sees no push at all: the left-alone line is consulted only for
 *   a push the reader sees. Claude Code's own checks hold these two today, which is no promise, and
 *   test/reference/pretooluse.json rereads them: `echo ${x:-{}; # }; git push origin main`, where zsh counts the braces and
 *   the reader reads a comment, and `echo <1-2># | git push origin main`, where zsh reads a glob and the reader a redirect
 *   and a comment;
 * - Claude Code's 50 ms parser deadline on a loaded machine: unmeasured under load, for a left text as for any other;
 * - a script the agent writes and runs, an interpreter (`python -c`, `node -e`), any other program that runs text it is
 *   given (`awk`, `make`, `man -P`), an MCP tool, `gh api`, a command a container or another machine runs, sent by a
 *   program other than ssh (`docker exec`, `vagrant ssh -c`), and what an ssh config file runs (`RemoteCommand`);
 * - text fed to a group, a function or a shell later in the session (`exec 0<<<…`): a feed reaches the next simple command;
 * - a command held whole in a variable, a head and a verb in two, and a shell that evaluates text later (an array
 *   subscript, `PS4`, zsh's `(e)`);
 * - encoded words (`$'g\x69t'`, base64), and a word a run puts together (`pu$(echo sh)`, `pu?h`, `xargs -I@ git @sh`,
 *   `${X/x/push}`);
 * - a link or copy of git under another name, a shell's name table (`hash g=…`), a program that calls it (`hub`), and
 *   an alias in a config file or one whose name holds a space;
 * - a git option or setting that runs a command (`--upload-pack`, `--exec`, `-x`, `core.sshCommand`, `core.pager`,
 *   `GIT_EDITOR`);
 * - PowerShell's own spellings (`iex`, its backtick escape, a Windows path written unquoted, which a POSIX shell reads
 *   as escapes, a call on an expression, `& (Get-Command git).Source push`): a PowerShell command is read as shell text;
 * - a program that runs another one and no list here holds (`conhost`, `wt`, `winpty`), and a WSL launcher whose
 *   name no pattern holds (`Manjaro.exe run`: wsldl names are the user's);
 * - a Skill's shell block, for which no hook fires, `disableAllHooks`, and `NODE_OPTIONS` or `PATH` in a settings `env`,
 *   which run the repository's code in the hook's place;
 * - a config an earlier call moved away, and a hook that crashes, is killed or times out: Claude Code runs the call.
 */

/** Where an expansion stands inside a word's text. */
export const GAP = "\u0000";
/** A whole push word: `push-spellings.mjs` and `feat/git-push-hook` are none, `/opt/git-core/git-push` is one. */
const PUSH_WORD = /(?<![\w./-])(push|send-pack|http-push)(?![\w./?*[-])|(?<![\w.-])git-(push|send-pack|http-push)(?![\w./?*[-])/;
/**
 * What a shell removes on its way to a word, cmd's caret too, and what it fills in: looked through apart, since what it
 * fills in may hold the push.
 */
const QUOTES = /\\\n|[\\"'\u0000{},^]/g;
const FILLED = /\$\{\w*\}|\$\([^()]*\)|`[^`]*`/g;
/** A simple command left alone, read from the source: git push and literal words, then redirects to literal places. */
const PLAIN = /^git push( [\w@%+=:,./~^-]+)*( \d?>>? ?[\w./-]+| 2>&1)* *$/;
/** Over this no push is left: Claude Code's parser stops at 10,000 characters, and the largest real push left is 5,285. */
const RULE_READS = 9000;
/** Text left alone: plain words (the characters PLAIN allows), space, newline, `;`, `|`, `>`, `&&`, `2>&1`. No other character, anywhere. */
const NOTHING_TO_MISREAD = /^(?:[\w@%+=:,./~^-]|[ \n;|>]|&&|2>&1)*$/;
/** Words at a command's head that open and close a block: a push inside one is no command of the top-level list. */
const OPENS = /^(if|for|while|until|case|select|function)$/;
const CLOSES = /^(fi|done|esac)$/;
/** Past this the text is not read: the largest real command in the replay is 53,646 bytes. */
const CEILING = 65536;
/**
 * Programs that run text they are given, by the names nameOf reads. A shell's options are not read: none of them hides
 * what it runs. `runuser` and util-linux `script` take a shell's text after `-c`, as `su` does, `wsl` with no `--exec`
 * gives the rest of its line to a Linux shell as text, which reads its quotes and backslashes again, and `Start-Process`
 * (`start`, `saps`) joins its words into a command line the program splits again.
 */
export const RUNS = /^((ba|z|da|k|c|tc|fi|a|rba)?sh|eval|source|xargs|parallel|watch|trap|alias|su|runuser|script|wsl|flock|pwsh|powershell|cmd|start-process|start|saps)$/i;
/**
 * ssh's option letters whose value is the rest of the word or the next word, the same in OpenSSH 8.9p1, 9.5p1 and 9.9p1
 * (`ssh -G -<letter> a b` names b as the host); `-P` is one in 9.5p1 and 9.9p1, not in 8.9p1.
 */
const SSH_VALUE = "BbcDEeFIiJLlmOopQRSWw";
/** Programs that run the rest of their words: after one, any word may stand where a program's name stands. */
export const WRAPS = /^(env|command|builtin|exec|nohup|nice|ionice|time|timeout|gtimeout|sudo|doas|stdbuf|caffeinate|setsid|busybox|toybox|chroot|noglob|nocorrect)$/i;
/**
 * A WSL distribution's own launcher (`ubuntu.exe`, `ubuntu2204.exe`, `debian.exe` …): its `run` gives the rest of the
 * line to the distribution's shell as text (`ubuntu.exe help`, measured), so with a `run` after it, it runs text.
 */
const LAUNCHER = /^(ubuntu[\d.]*|debian|kali(-linux)?|opensuse[\w.-]*|sles[\w.-]*|suse[\w.-]*|fedora[\w.-]*|alpine[\w.-]*|arch(linux)?|oraclelinux[\w.-]*|almalinux[\w.-]*|rockylinux[\w.-]*|centos[\w.-]*|pengwin)$/i;
/** find's way to run a command, and env's way to split one word into a command. */
const SPLITS = /^-(exec|ok)(dir)?$|^-\w*S|^--split-string/;
/** git's verbs that send commits, in the dashed name each has as a program. */
const DASHED = /^git-(push|send-pack|http-push)$/i;
const GIT = /^=?git$/i;
/** git's verbs that take a command or a push of their own. */
const RUNS_VERB = /^(subtree|submodule|rebase|bisect)$/;
/** A command's first word that is shell grammar. */
export const KEYWORD = /^(if|then|elif|else|while|until|do|!|\{)$/;
/** Their words go nowhere, or are no command. A list that only ever leaves: what it does not hold is judged by its words. */
const INERT = /^(echo|printf|grep|egrep|fgrep|rg|man|for|case|select|\[\[?|test|:|export|local|declare|readonly|typeset)$/;
export const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;
/** A word that sets a git setting for the command it stands in, the value after `-c` apart. */
const SETS_ALIAS = /^(--config-env=|GIT_CONFIG_(KEY_\d+|PARAMETERS)=)/;
const REDIRECT = /^(<<<|<<-?|&>>?|>>|>&|<&|>\||<>|<|>)/;
/** git's options whose value is the next word. */
const TAKES_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source)$/;
/** git's other options before a verb; one neither table knows may take a value, so it hides the verb. */
const PLAIN_OPTION = /^(-[pPvh]|--|--paginate|--no-pager|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--bare|--(literal|glob|noglob|icase)-pathspecs|--version|--help|--(exec|html|man|info)-path|--(git-dir|work-tree|namespace|super-prefix|config-env|attr-source|exec-path)=.*)$/s;
/** A word that may define a shell alias: bash's `alias`, PowerShell's `*-Alias`, `sal`, `nal` and its `alias:` drive; git's `alias.x` key is none. */
const DEFINES_ALIAS = /(?<!\w)(alias|sal|nal)(?![\w.])/i;
/** A parameter's name and operator: `${X:-value}` leaves the value. */
const VALUE = /^[#!]?[\w@*]*:?[-=+?]?/;

/**
 * @typedef {{ text: string, literal: boolean, built: boolean, args: boolean, exps: string[], raw: string }} Word `literal`: no
 *   quote or escape touched it; `built`: an expansion or a spread made it; `args`: the expansion is of positional
 *   parameters; `exps`: the source of each `$` expansion in it, an inner one first (kill-targets.mjs reads `$!` and
 *   `$name` there); `raw`: the word as the source spells it, quotes and backslashes in (kill-targets.mjs reads a Windows path there)
 * @typedef {{ words: Word[], fed: boolean, push: boolean, at: number, plain: boolean, paren?: boolean }} Cmd `fed`: a pipe, a
 *   redirection or a function's arguments give it text from elsewhere; `push`: a push word stands in its words, substitutions
 *   included; `at`: where it starts in the source; `plain`: it is a plain push outside any block; `paren`: its words end at
 *   a `(` (kill-targets.mjs reads it)
 * @typedef {{ cmds: Cmd[], pushes: number, aliases: Set<string>, aliased: boolean, redirs?: Array<{ op: string, word: Word, cmd: Cmd }> }} Seen
 *   what a pass found: `pushes`: how many texts hold a push word; `aliased`: the text may define a shell alias; `redirs`:
 *   each redirection, a here-document's apart, with its command, one with no words too (kill-targets.mjs reads them)
 */

/** @param {string} text */
const holdsPush = (text) => [text, text.replace(QUOTES, ""), text.replace(FILLED, "").replace(QUOTES, "")].some((t) => PUSH_WORD.test(t));

/**
 * What a shell runs in an unquoted here-document: from the first open that no backslash stops to the last close.
 * @param {string} body @param {RegExp} open @param {string} close
 */
const ranIn = (body, open, close) => (body.search(open) < 0 ? "" : body.slice(body.search(open), body.lastIndexOf(close) + 1));

/**
 * The names set as aliases in a text: `alias.save=push`, `alias.save`, the subsection form `alias.save.command`.
 * @param {string} text
 */
const aliasNames = (text) => [...text.matchAll(/(?:^|[\s='"])alias\.([^\s=']+?)(?:\.command)?(?=[\s='"]|$)/gi)].map((m) => m[1].toLowerCase());

/**
 * Every name an environment sets as an alias, whatever it expands to: GIT_CONFIG_KEY_n, GIT_CONFIG_PARAMETERS. A
 * committed settings file's `env` reaches the hook's own environment as it reaches a command's, so git is not asked.
 * @param {Record<string, string | undefined>} env @returns {Set<string>}
 */
export const pushAliases = (env) => new Set(Object.keys(env).filter((name) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)$/.test(name)).flatMap((name) => aliasNames(env[name] ?? "")));

/**
 * The simple commands of a text, those of its substitutions among them, in one forward pass, so a quote in a
 * here-document is never read as the shell's. Whatever does not close leaves i past the text's end.
 * @param {string} src @param {Seen} seen
 * @returns {boolean} whether something did not close
 */
function parse(src, seen) {
  let i = 0;
  let blocks = 0;
  /** The first unescaped `c` from `from`, or the text's end or past it. @param {string} c @param {number} from */
  const until = (c, from) => {
    let j = from;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j;
  };
  /** One escape, quote or expansion at i, into `word`; false when the character is a plain one. @param {Word} word @param {boolean} quoted */
  const part = (word, quoted) => {
    const c = src[i];
    const d = src[i + 1] ?? "";
    if (c === "\\") {
      // In double quotes it stays unless it escapes `$`, a backtick, `"`, `\` or a line feed: a Windows path's.
      word.text += d === "\n" ? "" : quoted && !"$`\"\\".includes(d) ? c + d : d;
      word.literal &&= d === "\n";
      i += 2;
    } else if (c === "`") {
      const end = until("`", i + 1);
      const broken = parse(src.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"), seen);
      word.text += GAP;
      word.built = true;
      i = (broken ? src.length : end) + 1;
    } else if (c === '"' && !quoted) {
      word.literal = false;
      for (i++; i < src.length && src[i] !== '"'; ) if (!part(word, true)) word.text += src[i++];
      i++;
    } else if ((c === "'" || (c === "$" && d === "'")) && !quoted) {
      const from = i + (c === "$" ? 2 : 1);
      const close = c === "$" ? until("'", from) : src.indexOf("'", from);
      const end = close < 0 ? src.length : close;
      word.text += src.slice(from, end);
      word.literal = false;
      word.built ||= c === "$";
      i = end + 1;
    } else if (c === "$" && /[\w@*#?$!({-]/.test(d) || (/[<>=]/.test(c) && d === "(" && !quoted)) {
      const from = i;
      word.built = true;
      word.args ||= /[@*\d]/.test(d === "{" ? (src[i + 2] ?? "") : d);
      word.text += GAP;
      i += 2;
      if (d === "(") list(")", [], c === ">");
      else if (d === "{") {
        i += VALUE.exec(src.slice(i))?.[0].length ?? 0;
        while (i < src.length && src[i] !== "}") if (!part(word, quoted)) word.text += src[i++];
        word.text += GAP;
        i++;
      } else while (/[A-Za-z_]/.test(d) && /\w/.test(src[i] ?? "")) i++;
      word.exps.push(src.slice(from, i));
    } else return false;
    return true;
  };
  /** @param {{ cmd: Cmd, delim: string, strip: boolean, quoted: boolean }} doc */
  const hereDoc = ({ cmd, delim, strip, quoted }) => {
    let body = "";
    let closed = false;
    while (i < src.length && !closed) {
      const nl = src.indexOf("\n", i);
      const line = src.slice(i, nl < 0 ? src.length : nl);
      i = nl < 0 ? src.length : nl + 1;
      closed = (strip ? line.replace(/^\t+/, "") : line) === delim;
      if (!closed) body += `${line}\n`;
    }
    cmd.fed = true;
    if (holdsPush(body)) seen.pushes++;
    // A substitution in an unquoted body runs, and is not followed: like text that does not close, it is judged by the word.
    if (!closed || (!quoted && (holdsPush(ranIn(body, /(^|[^\\])(\\\\)*\$\(/, ")")) || holdsPush(ranIn(body, /(^|[^\\])(\\\\)*`/, "`"))))) i = src.length + 1;
  };
  /**
   * @param {string | null} close @param {{ cmd: Cmd, delim: string, strip: boolean, quoted: boolean }[]} [docs] a subshell's run
   * on past it @param {boolean} [fed]
   */
  const list = (close, docs = [], fed = false) => {
    /** @type {Cmd} */
    let cmd = { words: [], fed, push: false, at: -1, plain: false };
    let mark = seen.pushes;
    /** @type {Word | null} */
    let word = null;
    let after = "";
    let wordAt = i;
    const endWord = () => {
      if (word && (word.text || !word.literal)) {
        word.raw = src.slice(wordAt, i);
        if (after && after !== "<<" && after !== "<<-") seen.redirs?.push({ op: after, word, cmd });
        if (after === "<<" || after === "<<-") docs.push({ cmd, delim: word.text, strip: after === "<<-", quoted: !word.literal });
        else if (after[0] === "<") {
          cmd.fed = true;
          if (holdsPush(word.text)) seen.pushes++;
        } else if (!after) cmd.words.push(word);
        after = "";
      }
      word = null;
    };
    const endCmd = (piped = false) => {
      endWord();
      if (cmd.words.length) {
        const text = cmd.words.map((w) => w.text).join(" ");
        cmd.push = seen.pushes > mark || holdsPush(text);
        if (cmd.push) seen.pushes++;
        cmd.fed ||= cmd.words.some((w) => w.args);
        for (const name of aliasNames(cmd.words.filter((w, k) => SETS_ALIAS.test(w.text) || cmd.words[k - 1]?.text === "-c").map((w) => w.text).join(" "))) seen.aliases.add(name);
        cmd.plain = !blocks && PLAIN.test(src.slice(cmd.at, i));
        blocks += OPENS.test(cmd.words[0].text) ? 1 : CLOSES.test(cmd.words[0].text) ? -1 : 0;
        seen.cmds.push(cmd);
      }
      cmd = { words: [], fed: piped, push: false, at: -1, plain: false };
      after = "";
      mark = seen.pushes;
    };
    while (i < src.length && src[i] !== close) {
      const c = src[i];
      const d = src[i + 1];
      if (cmd.at < 0 && !" \t\r\n;".includes(c)) cmd.at = i;
      if (!word) wordAt = i;
      /** @type {Word} */
      const w = word ?? { text: "", literal: true, built: false, args: false, exps: [], raw: "" };
      if (part(w, false)) word = w;
      else if (c === "#" && !word && src[i - 1] !== ")") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      else if (c === "\n") {
        endCmd();
        i++;
        docs.splice(0).forEach(hereDoc);
        mark = seen.pushes;
      } else if (" \t\r;)(".includes(c)) {
        const feeds = cmd.fed;
        if (c === " " || c === "\t" || c === "\r") endWord();
        else {
          // PowerShell's `Stop-Process (Get-Process x)`: the words stop at a parenthesis that is their argument.
          cmd.paren = c === "(" && cmd.words.length > 0;
          endCmd();
        }
        i++;
        if (c === "(") list(")", docs, feeds);
      } else if (c === "|" || (c === "&" && d !== ">")) {
        endCmd(c === "|" && d !== "|");
        i += d === c || (c === "|" && d === "&") ? 2 : 1;
      } else if (c === "<" || c === ">" || c === "&") {
        const op = REDIRECT.exec(src.slice(i, i + 3))?.[0] ?? c;
        if (word?.literal && /^\d+$/.test(word.text)) word = null;
        endWord();
        i += op.length;
        after = op;
      } else {
        word = w;
        // PowerShell's splat at a word's head (`git @args`): the arguments a function was given, as `"$@"` is.
        if (c === "@" && !word.text && /[A-Za-z_]/.test(d ?? "")) word.built = word.args = true;
        word.text += c;
        word.built ||= "*?[{".includes(c);
        i++;
      }
    }
    endCmd();
    i += docs.length && close === null ? 2 : 1;
  };
  list(null);
  return i > src.length + 1;
}

/**
 * Whether a text was read whole into `seen`: no longer than CEILING, closed, and no deeper than the stack.
 * @param {string} text @param {Seen} seen
 */
const readWhole = (text, seen) => {
  try {
    return text.length <= CEILING && !parse(text, seen);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return false;
  }
};

/**
 * The simple commands of a text, those of its substitutions among them, and its redirections, or null when it is not
 * read whole (over CEILING, not closed, deeper than the stack). The kill reader (kill-targets.mjs) judges these.
 * @param {string} text @returns {{ cmds: Cmd[], redirs: Array<{ op: string, word: Word, cmd: Cmd }> } | null}
 */
export function commandsOf(text) {
  /** @type {Required<Seen>} */
  const seen = { cmds: [], pushes: 0, aliases: new Set(), aliased: false, redirs: [] };
  return readWhole(text, seen) ? { cmds: seen.cmds, redirs: seen.redirs } : null;
}

/** The extensions Windows runs a program by; a builtin has none of them but `.exe` (Git for Windows' echo.exe). */
const RUN_BY = /\.(exe|cmd|bat|com)$/i;
const EXE = /\.exe$/i;

/**
 * A program's name, from the word as the shell passes it: past its folder, a POSIX path's or a Windows path's, and without
 * the extension `ext`. One reading: a second shell's is read where one reads the words (ssh), or not at all (RUNS).
 * @param {Word} w @param {RegExp} [ext]
 */
export const nameOf = (w, ext = RUN_BY) => w.text.split(GAP).join("").replace(/^.*[/\\]/s, "").replace(ext, "");

/** Whether the word's name, any extension off, passes `re`. @param {Word | undefined} w @param {RegExp} re */
const named = (w, re) => (w ? re.test(nameOf(w)) : false);

/**
 * Where ssh's command starts among the words after its name: past its options, the destination, and options again unless
 * `--` ended them (OpenSSH reads options after the destination too). `takes`: the letters whose value is the rest of the
 * word or, at its end, the next word.
 * @param {Word[]} words @param {string} takes
 */
const sshCommand = (words, takes) => {
  let host = false;
  let ended = false;
  for (let k = 0; k < words.length; k++) {
    const t = words[k].text;
    if (!ended && t === "--") ended = true;
    else if (!ended && /^-./s.test(t)) {
      if ([...t.slice(1)].findIndex((c) => takes.includes(c)) === t.length - 2) k++;
    } else if (host) return k;
    else host = true;
  }
  return words.length;
};

/**
 * Whether what ssh hands to the other machine reaches a push. OpenSSH joins the command words with one space and that
 * machine's shell reads the line (`man ssh`), so the joined text is read here as a shell's: `ssh host "true;git" push`
 * and `ssh host "cd x && git" push` are pushes there. ssh's own words run here: `-o ProxyCommand=…` goes to a shell. With
 * no command, the login shell there reads what ssh is fed; with one, that command is fed.
 * @param {Word[]} words those after ssh's name @param {Cmd} cmd @param {Seen} seen
 */
function remote(words, cmd, seen) {
  // `-P` takes a value in OpenSSH 9.5p1 and 9.9p1, none in 8.9p1: both are read.
  for (const start of new Set([sshCommand(words, SSH_VALUE), sshCommand(words, `${SSH_VALUE}P`)])) {
    // A built word among ssh's own may be options and a destination both: where the command starts is not known.
    if (words.slice(0, start).some((w) => holdsPush(w.text) || (w.built && cmd.push))) return true;
    if (start === words.length) {
      if (cmd.fed && seen.pushes > 0) return true;
      continue;
    }
    // What a word's expansion holds is not known there either: it stands as one, and a push word only an expansion here
    // holds (`ssh host "$(echo git push)"`) counts there.
    const text = words.slice(start).map((w) => w.text.split(GAP).join("${E}")).join(" ");
    const filled = cmd.push && !holdsPush(text);
    /** @type {Seen} */
    const inner = { cmds: [], pushes: seen.pushes, aliases: new Set(seen.aliases), aliased: seen.aliased };
    if (!readWhole(text, inner)) {
      if (cmd.push || inner.aliases.size) return true;
    } else if (inner.cmds.some((c) => judge({ ...c, fed: c.fed || cmd.fed, push: c.push || filled }, inner, true))) return true;
  }
  return false;
}

/**
 * Whether a simple command reaches a push, a plain one apart.
 * @param {Cmd} cmd @param {Seen} seen @param {boolean} [there] read as ssh's command: an ssh in it is not read again
 * @returns {boolean}
 */
function judge(cmd, seen, there = false) {
  const first = cmd.words.findIndex((w) => !ASSIGNMENT.test(w.text) && !KEYWORD.test(w.text));
  // Where an alias may be defined, a push word under any program but git by its own name is refused: `echo` too may be one.
  if (seen.aliased && cmd.push && first >= 0 && !named(cmd.words[first], GIT)) return true;
  // A name with an expansion glued to it is no name this list knows, nor is one with a folder: a program planted in the
  // work tree (`./echo.exe`, `./echo`) runs its words. Only `.exe` comes off: `./test.bat` is a batch file.
  if (first < 0 || (INERT.test(nameOf(cmd.words[first], EXE)) && !/[/\\\u0000]/.test(cmd.words[first].text))) return false;
  const words = cmd.words.slice(first);
  const live = seen.pushes > 0;
  const reach = cmd.push || (cmd.fed && live);
  // What stands where a program's name stands, by its place in `words`.
  const at = named(words[0], WRAPS) ? words.map((_, k) => k) : [0];
  const heads = at.map((k) => words[k]);
  if (heads.some((w) => (cmd.push && w.built && !ASSIGNMENT.test(w.text)) || named(w, DASHED) || (reach && (named(w, RUNS) || named(w, /^\.$/))))) return true;
  if (reach && at.some((k) => named(words[k], LAUNCHER) && /^(run|-c)$/i.test(words[k + 1]?.text ?? ""))) return true;
  const ssh = at.find((k) => named(words[k], /^ssh$/i));
  if (ssh !== undefined && (there ? reach : remote(words.slice(ssh + 1), cmd, seen))) return true;
  if (cmd.push && heads.some((w) => named(w, /^(env|find)$/i)) && words.some((w) => SPLITS.test(w.text))) return true;
  for (let k = 0; k < words.length; k++) {
    if (!named(words[k], GIT)) continue;
    let v = k + 1;
    let hidden = false;
    for (; words[v]?.text.startsWith("-") && !hidden; v++) {
      if (TAKES_VALUE.test(words[v].text)) v++;
      else hidden = !PLAIN_OPTION.test(words[v].text);
    }
    const verb = words[v];
    if (hidden ? cmd.push : verb?.built ? live : verb && (DASHED.test(`git-${verb.text}`) || seen.aliases.has(verb.text.toLowerCase()) || (cmd.push && RUNS_VERB.test(verb.text)))) return true;
    if (k === 0) return false;
    k = v - 1;
  }
  return false;
}

/**
 * The part of `command` that reaches a push outside the shape the ask rule reads for certain, or null.
 * @param {string} command what the tool will run @param {Record<string, string | undefined>} [env] the session's environment
 * @returns {string | null}
 */
export function pushSpelling(command, env = {}) {
  /** @type {Seen} */
  const seen = { cmds: [], pushes: 0, aliases: pushAliases(env), aliased: [command, command.replace(QUOTES, "")].some((t) => DEFINES_ALIAS.test(t)) };
  if (!readWhole(command, seen)) return holdsPush(command) || seen.aliases.size ? command.slice(0, 200) : null;
  const left = command.length < RULE_READS && NOTHING_TO_MISREAD.test(command);
  const hit = seen.cmds.find((c) => !(left && c.plain) && judge(c, seen));
  return hit ? hit.words.map((w) => w.text.split(GAP).join("$…")).join(" ") : null;
}
