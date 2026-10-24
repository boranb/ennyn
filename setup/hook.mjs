/**
 * commit-check as the repository's commit-msg hook: the commit convention
 * becomes a gate instead of a line in CLAUDE.md. The hook names this
 * machine's CLI path, so it goes only into the repository's own hooks
 * directory: never into a tracked one (`core.hooksPath`), and never over a
 * hook it did not write.
 *
 * Origin: commit messages drifted from the written convention until the whole
 * history had to be rewritten by hand (2026-10-18).
 */

import { accessSync, constants, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import { gone, present, readIfThere } from "../core/files.mjs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { git, gitMaybe, repoPath } from "../core/git.mjs";

export const HOOK_MARKER = "# ennyn commit-msg hook";

/** @param {string} s */
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The line a commit-msg hook runs; quoted for the shell, so a path with spaces, quotes or $ survives.
 * `--hook`: a config that does not load lets the commit through with a warning instead of locking it.
 * @param {string} cliPath
 */
export function hookLine(cliPath) {
  return `node ${shQuote(cliPath)} commit-check --hook "$1"`;
}

/**
 * The hook script. A missing CLI or a missing node lets the commit through with
 * a warning: a moved plugin must not lock every commit in the repository.
 * @param {string} cliPath absolute path of scripts/ennyn.mjs
 */
export function hookScript(cliPath) {
  return `#!/bin/sh
${HOOK_MARKER}: written by \`ennyn install-hook\`; delete this file to remove it.
cli=${shQuote(cliPath)}
if ! command -v node >/dev/null 2>&1; then
  echo "ennyn: node not found; commit message not checked." >&2
  exit 0
fi
if [ ! -f "$cli" ]; then
  echo "ennyn: $cli not found; commit message not checked. Run ennyn install-hook again." >&2
  exit 0
fi
exec node "$cli" commit-check --hook "$1"
`;
}

/**
 * The real path of p; for a path that does not exist yet, the real path of its nearest existing ancestor
 * with the rest appended (a hooks directory not created yet still compares correctly through a link).
 * @param {string} p
 */
function real(p) {
  /** @type {string[]} */
  const rest = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * A hook file's text; null when there is none. One that is there but cannot be read throws: read as "no
 * hook", doctor would say the commit types go unchecked, and install-hook might write over it.
 * @param {string} path
 */
const readOrNull = (path) => readIfThere(path);

/**
 * @param {string} cwd
 * @returns {{ path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, state: "none" | "ennyn" | "wired" | "other", there: boolean, runs: boolean, cli: string | null }}
 *   "wired": a hook Ennyn did not write that already runs commit-check (a project's own tracked hook,
 *   or husky's .husky/commit-msg behind its generated .husky/_ stubs): a line calls it (callsCommitCheck).
 *   hooksKind: where core.hooksPath points: inside the repository ("repo", usually tracked), husky's
 *   stub directory ("husky"), or outside it ("global", every repository on this machine).
 *   runs: git would run the file at `path` (it is there and executable; git skips one that is not, with a
 *   hint). cli: the CLI an Ennyn hook names, null for any other hook (one written from a copy of Ennyn that
 *   has moved since lets every commit through unchecked; doctor looks for it).
 */
export function hookStatus(cwd) {
  const hooksPath = gitMaybe(["config", "--get", "core.hooksPath"], { cwd, absent: [1] }) || null;
  const dir = resolve(cwd, git(["rev-parse", "--git-path", "hooks"], { cwd }));
  const path = join(dir, "commit-msg");
  const text = readOrNull(path);
  /** @type {"repo" | "husky" | "global" | null} */
  let hooksKind = null;
  if (hooksPath) {
    const top = repoPath("--show-toplevel", { cwd }) ?? cwd;
    // Both sides as real paths: git prints the real top level, while dir came through cwd (a link, /var → /private/var).
    const rel = relative(real(top), real(dir));
    // husky v9 keeps its stubs in a "_" directory (.husky/_, or one of the project's choosing) next to the
    // runner it writes there, "h"; a tracked directory named "_" without it is the repository's own.
    const husky = basename(dir) === "_" && (basename(dirname(dir)) === ".husky" || present(join(dir, "h")));
    hooksKind = rel.startsWith("..") || isAbsolute(rel) ? "global" : husky ? "husky" : "repo";
  }
  // husky v9: .husky/_/commit-msg is a generated stub that runs .husky/commit-msg.
  const userHook = hooksKind === "husky" ? readOrNull(join(dirname(dir), "commit-msg")) : null;
  const state =
    text !== null && text.includes(HOOK_MARKER)
      ? "ennyn"
      : [text, userHook].some((t) => t !== null && callsCommitCheck(t))
        ? "wired"
        : text === null && userHook === null
          ? "none"
          : "other";
  const cli = state === "ennyn" ? hookCli(/** @type {string} */ (text)) : null;
  return { path, hooksPath, hooksKind, state, there: text !== null, runs: executable(path), cli };
}

/** commit-check as a word of a command, quoted or not (`"commit-check"`, `SUB=commit-check`, `[cli, "commit-check"]`). */
const NAMES = /(^|[\s"'`=(\[,;&|])commit-check(?=$|[\s"'`)\],;&|\\])/;
/** A command that prints text: what it names, it does not run. Leading keywords and `!` are skipped. */
const TEXT_COMMAND = /^(?:(?:if|then|else|elif|do|while|until|!|\{|\()\s+)*(?:echo|printf|:)(?=\s|$)/;
/** What on the same line throws a failure away: the line checks nothing. */
const SWALLOW = /^(?:true|:|exit\s+0)\s*$/;

/**
 * Whether a hook script runs commit-check as a check (a hook that does not checks nothing, and doctor must not
 * show ✓), read line by line as the shell would run it. A line counts when one of its commands names
 * commit-check as a word, quoted or not (`node cli "commit-check"`, `sh -c "… commit-check …"`,
 * `SUB=commit-check`, a Node hook's `[cli, "commit-check", …]`), and that command is not text (echo, printf,
 * `:`). Not counted: a comment (`#`; `//` in a Node hook), a here-document's body, a call whose failure its
 * line throws away (`|| true`, `|| :`, `|| exit 0`), and anything after an `exit` that starts a line (at the
 * top level, where it always runs). Not seen at this level: a block that never runs (`if false; then …`), a
 * function never called, a Node hook's block comments. test/hook.test.mjs holds the corpus, with real git as
 * the judge (an untyped subject is refused only when the hook checks).
 * @param {string} text
 */
export function callsCommitCheck(text) {
  const lines = text.split(/\r?\n/);
  const js = /^#!.*\bnode\b/.test(lines[0] ?? "");
  /** @type {{ tag: string, dash: boolean } | null} */
  let heredoc = null;
  for (const line of lines) {
    if (heredoc) {
      if ((heredoc.dash ? line.replace(/^\t+/, "") : line) === heredoc.tag) heredoc = null;
      continue;
    }
    if (line.startsWith("#!")) continue;
    if (js) {
      if (NAMES.test(jsCode(line))) return true;
      continue;
    }
    if (/^exit(\s+\d+)?\s*;?\s*(#.*)?$/.test(line)) return false;
    const read = shellCommands(line);
    heredoc = read.heredoc;
    const cmds = read.commands;
    for (let i = 0; i < cmds.length; i++) {
      if (!NAMES.test(cmds[i].text) || TEXT_COMMAND.test(cmds[i].text)) continue;
      if (cmds[i].sep === "||" && SWALLOW.test(cmds[i + 1]?.text ?? "")) continue;
      return true;
    }
  }
  return false;
}

/**
 * One line of a shell script as its commands, each with the separator after it (`;`, `&&`, `||`, `|`, `&`),
 * quotes kept, a comment (a `#` that starts a word) dropped; and the here-document it opens, if any.
 * @param {string} line
 */
function shellCommands(line) {
  /** @type {{ text: string, sep: string }[]} */
  const commands = [];
  /** @type {{ tag: string, dash: boolean } | null} */
  let heredoc = null;
  let cur = "";
  let quote = "";
  const push = (/** @type {string} */ sep) => {
    commands.push({ text: cur.trim(), sep });
    cur = "";
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote !== "'") cur += line[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") {
      cur += c + (line[++i] ?? "");
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) break;
    if (line.startsWith("<<", i) && line[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line.slice(i));
      if (m) {
        heredoc ??= { tag: m[3], dash: m[1] === "-" };
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    const two = line.slice(i, i + 2);
    if (two === "||" || two === "&&") {
      push(two);
      i++;
    } else if (c === ";" || c === "|" || (c === "&" && line[i - 1] !== ">" && line[i + 1] !== ">")) push(c);
    else cur += c;
  }
  push("");
  return { commands, heredoc };
}

/** A line of a Node hook without its `//` comment. @param {string} line */
function jsCode(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (line.startsWith("//", i)) return line.slice(0, i);
  }
  return line;
}

/**
 * Why a hook that runs commit-check checks nothing: its file is not there (husky's stub before husky
 * installs), git would not run it (not executable), or the CLI an Ennyn hook names is no file (gone, or a
 * directory in its place: the hook's own `[ -f "$cli" ]`); null when it checks. doctor and installHook read
 * this one answer. A path that cannot be looked at throws.
 * @param {ReturnType<typeof hookStatus>} st
 * @returns {"absent" | "mode" | "cli" | null}
 */
export function idleReason(st) {
  if (!st.there) return "absent";
  if (!st.runs) return "mode";
  if (st.cli !== null && !isFile(st.cli)) return "cli";
  return null;
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (err) {
    if (gone(err)) return false;
    throw err;
  }
}

/**
 * The CLI path an Ennyn hook script names (`cli='…'`, quoted as hookScript quotes it); null when the
 * script holds no such line (written by another version).
 * @param {string} text
 */
export function hookCli(text) {
  const m = /^cli='((?:[^']|'\\'')*)'$/m.exec(text);
  return m ? m[1].split("'\\''").join("'") : null;
}

/**
 * Whether git would run the hook file: git asks access(X_OK) and skips the hook otherwise. On Windows
 * every file passes. A file that cannot be looked at throws.
 * @param {string} path
 */
function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (err) {
    if (gone(err) || /** @type {NodeJS.ErrnoException} */ (err).code === "EACCES") return false;
    throw err;
  }
}

/**
 * @param {{ cwd: string, cliPath: string }} opts
 * @returns {{ result: "installed" | "updated" | "unchanged" | "wired" | "notThere" | "notExecutable" | "cliGone" | "other" | "hooksPath", path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, line: string, cli: string | null, chmod: string, own: string }}
 *   `line`: what to add to a hook Ennyn does not write (shell-quoted); `chmod`: the command that makes the
 *   hook executable, quoted the same way; `own`: under husky, the file its stub runs. notThere /
 *   notExecutable / cliGone: a hook that runs commit-check and is not Ennyn's to write checks nothing
 *   (idleReason), as doctor says.
 */
export function installHook({ cwd, cliPath }) {
  const st = hookStatus(cwd);
  const own = st.hooksPath ? join(dirname(st.hooksPath), "commit-msg") : "";
  const base = { path: st.path, hooksPath: st.hooksPath, hooksKind: st.hooksKind, line: hookLine(cliPath), cli: st.cli, chmod: `chmod +x ${shQuote(st.path)}`, own };
  // A hook that runs commit-check but is not Ennyn's to write here (the project's own, husky's, or a copy of
  // Ennyn's script under core.hooksPath): nothing to do while it checks; when it checks nothing, why.
  if (st.state === "wired" || (st.state === "ennyn" && st.hooksPath)) {
    const idle = idleReason(st);
    return { result: idle === "absent" ? "notThere" : idle === "mode" ? "notExecutable" : idle === "cli" ? "cliGone" : "wired", ...base };
  }
  // A hooks path is someone else's arrangement: a tracked directory, husky's stubs, or a global directory
  // for every repository. Ennyn writes into none of them; the message says what to add where.
  if (st.hooksPath) return { result: "hooksPath", ...base };
  if (st.state === "other") return { result: "other", ...base };
  const script = hookScript(cliPath);
  // A hook that checks nothing (its mode lost in a copy or a chmod, its CLI moved) is written again, not called unchanged.
  if (st.state === "ennyn" && idleReason(st) === null && readFileSync(st.path, "utf8") === script) return { result: "unchanged", ...base };
  mkdirSync(resolve(st.path, ".."), { recursive: true });
  writeFileSync(st.path, script);
  chmodSync(st.path, 0o755);
  return { result: st.state === "ennyn" ? "updated" : "installed", ...base };
}
