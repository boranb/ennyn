/**
 * commit-check as the repository's commit-msg hook: the commit convention
 * becomes a gate instead of a line in CLAUDE.md. The hook names this
 * machine's CLI path, so it goes only into the repository's own hooks
 * directory: never into a tracked one (`core.hooksPath`), and never over a
 * hook it did not write.
 *
 * Installed from the Claude Code plugin, the hook names no version:
 * `${CLAUDE_PLUGIN_ROOT}` is one directory per plugin version, and Claude Code
 * deletes a replaced one 14 days after an update. The hook reads the version
 * from a record in the plugin's data directory, which survives updates and
 * goes with an uninstall; a SessionStart hook records the version each session
 * runs (adapters/claude-code/hooks/plugin-root.mjs) and tells the session's
 * commands where the record is (`ENNYN_PLUGIN_DATA`).
 *
 * Origin: commit messages drifted from the written convention until the whole
 * history had to be rewritten by hand (2026-10-18).
 */

import { accessSync, constants, lstatSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import { gone, present, readIfThere } from "../core/files.mjs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { git, gitMaybe, repoPath } from "../core/git.mjs";

export const HOOK_MARKER = "# ennyn commit-msg hook";

/** The record in the plugin's data directory: one line, the root of the plugin version a session last ran. */
export const PLUGIN_RECORD = "root";

/**
 * What Claude Code writes into a plugin version directory it has replaced (an update or an uninstall); it
 * deletes the directory 14 days later (code.claude.com/docs/en/plugins/loading, "Cleanup of previous versions").
 */
export const ORPHANED = ".orphaned_at";

/** The Ennyn root a CLI path belongs to (`<root>/scripts/ennyn.mjs`). @param {string} cliPath */
const rootOf = (cliPath) => dirname(dirname(cliPath));

/** The CLI below an Ennyn root. @param {string} root */
const cliOf = (root) => join(root, "scripts", "ennyn.mjs");

/** @param {string} s */
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The variables that name, to the commands of a plugin session, the plugin's data directory and the version the session runs. */
export const SESSION_DATA = "ENNYN_PLUGIN_DATA";
export const SESSION_ROOT = "ENNYN_PLUGIN_ROOT";

/**
 * The line a SessionStart hook adds to `$CLAUDE_ENV_FILE`, which Claude Code runs before the session's Bash commands.
 * @param {string} data @param {string} root
 */
export const sessionLine = (data, root) => `export ${SESSION_DATA}=${shQuote(data)} ${SESSION_ROOT}=${shQuote(root)}\n`;

/**
 * The plugin session a command runs in, as its SessionStart hook named it; null outside one (or with a value
 * that is no absolute path).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ data: string, root: string } | null}
 */
export function sessionOf(env) {
  const data = env[SESSION_DATA];
  const root = env[SESSION_ROOT];
  return data && root && isAbsolute(data) && isAbsolute(root) ? { data, root } : null;
}

/** A control character, which no path the record names may hold: the record is one line the hook reads. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/**
 * The one answer to "may the hook run this plugin root, and may the record name it": null when both, else why
 * not. `replaced` (Claude Code's `.orphaned_at`) is one the hook still runs (that version's checks, until Claude
 * Code deletes it) but no writer records and doctor warns about; every other reason refuses the commit, and the
 * hook script refuses the same spellings (hookScript). The writer, install-hook's choice of a data directory,
 * hookStatus, idleReason and doctor all read this one predicate.
 * @param {string} root
 * @returns {"control" | "relative" | "noCli" | "replaced" | null}
 */
export function rootProblem(root) {
  if (CONTROL.test(root)) return "control";
  if (!isAbsolute(root)) return "relative";
  if (!isFile(cliOf(root))) return "noCli";
  if (present(join(root, ORPHANED))) return "replaced";
  return null;
}

/**
 * The record in `data` as the hook reads it: nothing there (`none`: the data directory gone, or made again
 * empty), something there that is no regular file (`foreign`: a link, a directory, a FIFO; the hook refuses it
 * unread), or its first line and rootProblem's answer for it. A record that cannot be read throws.
 * @param {string} data
 * @returns {{ root: string | null, problem: "none" | "foreign" | ReturnType<typeof rootProblem> }}
 */
export function readRecord(data) {
  const path = join(data, PLUGIN_RECORD);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (gone(err)) return { root: null, problem: "none" };
    throw err;
  }
  if (!st.isFile()) return { root: null, problem: "foreign" };
  const root = readFileSync(path, "utf8").split("\n")[0];
  return { root, problem: rootProblem(root) };
}

/**
 * The line a commit-msg hook runs; quoted for the shell, so a path with spaces, quotes or $ survives.
 * `--hook`: a config that does not load lets the commit through with a warning instead of locking it.
 * With the plugin's data directory, the line reads the version from its record: a record that names no
 * CLI fails the commit (node finds no module), never passes it.
 * @param {string} cliPath
 * @param {string | null} [data]
 */
export function hookLine(cliPath, data = null) {
  if (data !== null) return `node "$(cat ${shQuote(join(data, PLUGIN_RECORD))})/scripts/ennyn.mjs" commit-check --hook "$1"`;
  return `node ${shQuote(cliPath)} commit-check --hook "$1"`;
}

/**
 * The hook script. A missing node lets the commit through with a warning. So does a missing CLI: a moved
 * copy of Ennyn must not lock every commit in the repository.
 *
 * Installed from the plugin (`data`), the hook reads the plugin version from the record in the plugin's data
 * directory, refusing what rootProblem and readRecord refuse: nothing there (the plugin uninstalled: Claude Code
 * deletes the directory, and may make it again empty while an old session runs) lets the commit through,
 * saying how to put the hook back or remove it; a link or anything but a regular file at the record's place,
 * a first line with a control character or that is no absolute path (this platform's spelling), or a version
 * whose CLI is gone refuses the commit: passing would turn the gate off with one stderr line, and running a
 * relative path would run the repository's own file. Each message names a step that works.
 * @param {string} cliPath absolute path of scripts/ennyn.mjs (unused for a plugin hook)
 * @param {string | null} [data] the plugin's data directory, for a hook installed from the plugin
 */
export function hookScript(cliPath, data = null) {
  const head = `#!/bin/sh
${HOOK_MARKER}: written by \`ennyn install-hook\`; delete this file to remove it.
`;
  const node = `if ! command -v node >/dev/null 2>&1; then
  echo "ennyn: node not found; commit message not checked." >&2
  exit 0
fi
`;
  if (data === null) {
    return `${head}cli=${shQuote(cliPath)}
${node}if [ ! -f "$cli" ]; then
  echo "ennyn: $cli not found; commit message not checked. Run ennyn install-hook again." >&2
  exit 0
fi
exec node "$cli" commit-check --hook "$1"
`;
  }
  // What an absolute path looks like where the hook is written: a drive path only on Windows.
  const absolute = process.platform === "win32" ? "/*|[A-Za-z]:[\\\\/]*" : "/*";
  const remove = "delete this hook (git rev-parse --git-path hooks/commit-msg names it)";
  return `${head}data=${shQuote(data)}
record="$data/${PLUGIN_RECORD}"
${node}if [ ! -e "$record" ] && [ ! -L "$record" ]; then
  printf '%s\\n' "ennyn: no plugin version is recorded in $data (the ennyn plugin was uninstalled, or has not run since), so the commit message is not checked." 'Run install-hook from the plugin again (/ennyn:init), or ${remove}.' >&2
  exit 0
fi
if [ -L "$record" ] || [ ! -f "$record" ]; then
  printf '%s\\n' "ennyn: $record is no record Ennyn wrote (a link, or not a regular file), so this commit is refused." 'Delete it, then run install-hook from the plugin again (/ennyn:init); or ${remove}.' >&2
  exit 1
fi
line=
{ IFS= read -r line < "$record"; } 2>/dev/null
root=
case $line in
  *[[:cntrl:]]*) ;;
  ${absolute}) root=$line ;;
esac
cli="$root/scripts/ennyn.mjs"
if [ -z "$root" ] || [ ! -f "$cli" ]; then
  printf '%s\\n' "ennyn: the plugin version recorded in $record ($line) is no absolute path to a version that is there, so this commit is refused." 'Run install-hook from the plugin again (/ennyn:init; any Claude Code session with the plugin also records its version); if the plugin is uninstalled, ${remove}.' >&2
  exit 1
fi
exec node "$cli" commit-check --hook "$1"
`;
}

/** Why a plugin version cannot be recorded; `reason` names the check that refused it. */
export class RecordError extends Error {
  /** @param {"relative" | "control" | "replaced" | "noCli" | "foreign"} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = "RecordError";
    this.reason = reason;
  }
}

/**
 * Records `root` as the plugin version the hook runs; false when the record already names it. The one writer
 * of the record (install-hook and the SessionStart hook): absolute paths, and a root rootProblem accepts (no
 * control character, a CLI in it, not a version Claude Code has replaced: a session or install-hook still on
 * the old version after an update would point every repository's hook back at it). The record is a regular
 * file written whole under a name made new (a link planted there is removed, not followed) and renamed into
 * place: on POSIX a commit that reads it meanwhile reads the old line or the new one, and on Windows a file,
 * unlike a link to a directory, can be replaced. Something at the record's place that is no regular file is
 * not Ennyn's: it is refused.
 * @param {string} data the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`)
 * @param {string} root the plugin's root (`${CLAUDE_PLUGIN_ROOT}`)
 */
export function recordPluginRoot(data, root) {
  if (!isAbsolute(data) || !isAbsolute(root)) throw new RecordError("relative", `the plugin's data directory and root must be absolute paths: ${data}, ${root}`);
  // One spelling, with the platform's separators and no trailing one (Claude Code gives forward slashes on Windows).
  const at = resolve(root);
  const problem = rootProblem(at);
  if (problem === "replaced") throw new RecordError("replaced", `${at} is a plugin version Claude Code has replaced`);
  if (problem === "noCli") throw new RecordError("noCli", `${at} holds no scripts/ennyn.mjs`);
  if (problem !== null) throw new RecordError(problem, `the plugin root cannot be recorded (${problem}): ${JSON.stringify(at)}`);
  const record = join(data, PLUGIN_RECORD);
  const now = readRecord(data);
  if (now.problem === "foreign") throw new RecordError("foreign", `${record} is no regular file; Ennyn replaces only its own record there`);
  if (now.root !== null && readFileSync(record, "utf8") === `${at}\n`) return false;
  mkdirSync(data, { recursive: true });
  const tmp = `${record}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${at}\n`, { flag: "wx" });
  renameSync(tmp, record);
  return true;
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
 * @returns {{ path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, state: "none" | "ennyn" | "wired" | "other", there: boolean, runs: boolean, cli: string | null, data: string | null, recorded: string | null, problem: ReturnType<typeof readRecord>["problem"] }}
 *   "wired": a hook Ennyn did not write that already runs commit-check (a project's own tracked hook,
 *   or husky's .husky/commit-msg behind its generated .husky/_ stubs): a line calls it (callsCommitCheck).
 *   hooksKind: where core.hooksPath points: inside the repository ("repo", usually tracked), husky's
 *   stub directory ("husky"), or outside it ("global", every repository on this machine).
 *   runs: git would run the file at `path` (it is there and executable; git skips one that is not, with a
 *   hint). cli: the CLI an Ennyn hook names, null for any other hook (one written from a copy of Ennyn that
 *   has moved since lets every commit through unchecked; doctor looks for it); for a hook installed from the
 *   plugin, the CLI its record names when the hook would run it. data: the plugin's data directory such a
 *   hook reads its record from, null for any other hook; recorded and problem: readRecord's answer for it.
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
  const data = state === "ennyn" ? quoted(/** @type {string} */ (text), "data") : null;
  const record = data !== null ? readRecord(data) : null;
  // The CLI the hook runs: one its record names only when the hook would run it (a replaced version still runs).
  const runnable = record !== null && (record.problem === null || record.problem === "replaced");
  const cli = record !== null ? (runnable ? cliOf(/** @type {string} */ (record.root)) : null) : state === "ennyn" ? hookCli(/** @type {string} */ (text)) : null;
  return { path, hooksPath, hooksKind, state, there: text !== null, runs: executable(path), cli, data, recorded: record?.root ?? null, problem: record?.problem ?? null };
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
 * directory in its place: the hook's own `[ -f "$cli" ]`); null when it checks. For a hook installed from the
 * plugin, readRecord's answer: `unrecorded` when no record is there (the hook lets every commit through),
 * `foreign` when something that is no regular file is at its place, `stale` when its line names no root the
 * hook runs (both refuse every commit). doctor and installHook read this one answer. A path that cannot be
 * looked at throws.
 * @param {ReturnType<typeof hookStatus>} st
 * @returns {"absent" | "mode" | "cli" | "stale" | "unrecorded" | "foreign" | null}
 */
export function idleReason(st) {
  if (!st.there) return "absent";
  if (!st.runs) return "mode";
  if (st.data !== null) return st.problem === "none" ? "unrecorded" : st.problem === "foreign" ? "foreign" : st.cli === null ? "stale" : null;
  if (st.cli !== null && !isFile(st.cli)) return "cli";
  return null;
}

/**
 * The plugin version directory the CLI of an Ennyn hook belongs to, when Claude Code has replaced it (its
 * `.orphaned_at` marker): the hook checks with that version's rules until Claude Code deletes it. null for
 * a CLI that is not there, any other copy of Ennyn, or a hook that is not Ennyn's.
 * @param {ReturnType<typeof hookStatus>} st
 */
export function replacedRoot(st) {
  if (st.cli === null) return null;
  let real;
  try {
    real = realpathSync(st.cli);
  } catch (err) {
    if (gone(err)) return null;
    throw err;
  }
  const root = rootOf(real);
  return present(join(root, ORPHANED)) ? root : null;
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

/** Whether two paths name one directory, compared as real paths; false when either is not there. @param {string} a @param {string} b */
function sameRoot(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
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
  return quoted(text, "cli");
}

/** The value of a `name='…'` line hookScript wrote, unquoted; null without one. @param {string} text @param {string} name */
function quoted(text, name) {
  const m = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, "m").exec(text);
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
 * In a plugin session, what neither idleReason nor replacedRoot sees about an Ennyn hook that checks: one that
 * names a plugin version by its path, the session's or the one the session's record names (`pinned`: from
 * before hooks followed updates, or installed without the data directory; it stops checking once Claude Code
 * replaces that version), or one that reads the session's record while the record names another version than
 * the session's (`other`: installs of the plugin in two scopes share one record, and the session that started
 * last decides). doctor and installHook read this one answer; null outside a session.
 * @param {ReturnType<typeof hookStatus>} st
 * @param {{ data: string, root: string } | null} session
 * @returns {"pinned" | "other" | null}
 */
export function versionNote(st, session) {
  if (session === null || st.state !== "ennyn" || st.cli === null) return null;
  const record = readRecord(session.data);
  const recorded = record.problem === null ? /** @type {string} */ (record.root) : null;
  if (st.data === null) {
    const at = rootOf(st.cli);
    return sameRoot(at, session.root) || (recorded !== null && sameRoot(at, recorded)) ? "pinned" : null;
  }
  return sameRoot(st.data, session.data) && recorded !== null && !sameRoot(recorded, session.root) ? "other" : null;
}

/** Whether `path` lies inside the repository's top level, as real paths. @param {string} cwd @param {string} path */
function inRepository(cwd, path) {
  const top = repoPath("--show-toplevel", { cwd });
  if (top === null) return false;
  const rel = relative(real(top), real(path));
  return !(rel.startsWith("..") || isAbsolute(rel));
}

/**
 * @param {{ cwd: string, cliPath: string, pluginData?: string | null, session?: { data: string, root: string } | null }} opts
 *   `pluginData`: the plugin's data directory given (`--plugin-data "${CLAUDE_PLUGIN_DATA}"`, as the init skill
 *   runs it). `session`: the plugin session this runs in (sessionOf). The hook reads the record of: the data
 *   directory given; the session's, when this copy is the version the session runs (install-hook run from the
 *   plugin as any advice says: it records this version over a record naming another or none it can run); the
 *   hook's own, when its record names this copy. A hook that reads a record is never turned into one that names
 *   this copy by its path: with a record naming another version, or none it can run, and no session to say
 *   this copy is the plugin, install-hook writes nothing and says how to go on (`followsRecord`). Otherwise the
 *   hook names `cliPath`. A data directory inside the repository is refused (`dataInRepository`): a record
 *   there would be the repository's own file.
 * @returns {{ result: "installed" | "updated" | "unchanged" | "wired" | "notThere" | "notExecutable" | "cliGone" | "cliUnrecorded" | "cliRefused" | "cliForeign" | "cliReplaced" | "cliPinned" | "cliOtherVersion" | "replacedCopy" | "followsRecord" | "dataInRepository" | "other" | "hooksPath", path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, line: string, cli: string | null, data: string | null, root: string, recorded: string, chmod: string, own: string }}
 *   `line`: what to add to a hook Ennyn does not write (shell-quoted); `chmod`: the command that makes the
 *   hook executable, quoted the same way; `own`: under husky, the file its stub runs. notThere /
 *   notExecutable / cliGone / cliUnrecorded / cliRefused / cliForeign: a hook that runs commit-check and is not
 *   Ennyn's to write checks nothing or refuses every commit (idleReason), as doctor says; cliReplaced: it
 *   checks with a plugin version Claude Code has replaced (`root`); cliPinned / cliOtherVersion: versionNote.
 *   replacedCopy: this copy of Ennyn is such a version (`root`); a hook naming it, or a record of it, would
 *   stop checking when Claude Code deletes it, so nothing is written. `data`: the data directory the hook
 *   reads its record from; `recorded`: what that record names. The record is written only with Ennyn's own
 *   hook: a run that writes no hook moves no other repository's.
 */
export function installHook({ cwd, cliPath, pluginData = null, session = null }) {
  const st = hookStatus(cwd);
  const self = rootOf(cliPath);
  const own = st.hooksPath ? join(dirname(st.hooksPath), "commit-msg") : "";
  const base = { path: st.path, hooksPath: st.hooksPath, hooksKind: st.hooksKind, cli: st.cli, chmod: `chmod +x ${shQuote(st.path)}`, own, root: "", recorded: st.recorded ?? "", line: hookLine(cliPath), data: st.data };
  if (present(join(self, ORPHANED))) return { ...base, result: "replacedCopy", root: self };
  const fromSession = session !== null && sameRoot(session.root, self) ? session.data : null;
  const kept = st.data !== null && st.problem === null && sameRoot(/** @type {string} */ (st.recorded), self) ? st.data : null;
  const data = pluginData ?? fromSession ?? kept;
  if (data !== null && inRepository(cwd, data)) return { ...base, result: "dataInRepository", data };
  const line = hookLine(cliPath, data);
  // A hook that runs commit-check but is not Ennyn's to write here (the project's own, husky's, or a copy of
  // Ennyn's script under core.hooksPath): nothing to do while it checks; when it checks nothing, with a
  // replaced or pinned version, or with another scope's, why.
  if (st.state === "wired" || (st.state === "ennyn" && st.hooksPath)) {
    const idle = idleReason(st);
    /** @type {Record<string, "notThere" | "notExecutable" | "cliGone" | "cliUnrecorded" | "cliRefused" | "cliForeign">} */
    const why = { absent: "notThere", mode: "notExecutable", cli: "cliGone", unrecorded: "cliUnrecorded", stale: "cliRefused", foreign: "cliForeign" };
    if (idle !== null) return { ...base, result: why[idle], line };
    const replaced = replacedRoot(st);
    if (replaced !== null) return { ...base, result: "cliReplaced", line, root: replaced };
    const note = versionNote(st, session);
    return { ...base, result: note === "pinned" ? "cliPinned" : note === "other" ? "cliOtherVersion" : "wired", line, root: session?.root ?? "" };
  }
  // A hooks path is someone else's arrangement: a tracked directory, husky's stubs, or a global directory
  // for every repository. Ennyn writes into none of them; the message says what to add where.
  if (st.hooksPath) return { ...base, result: "hooksPath", line };
  if (st.state === "other") return { ...base, result: "other", line };
  // A hook that follows the plugin, about to name this copy by its path: no session says this copy is the plugin.
  if (data === null && st.data !== null) return { ...base, result: "followsRecord", line, root: self };
  // The record first: a version it refuses leaves the hook as it was.
  const moved = data !== null && recordPluginRoot(data, self);
  const script = hookScript(cliPath, data);
  // A hook that checks nothing (its mode lost in a copy or a chmod, its CLI moved) is written again, not called unchanged.
  if (st.state === "ennyn" && !moved && idleReason(st) === null && readFileSync(st.path, "utf8") === script) return { ...base, result: "unchanged", line, data };
  mkdirSync(resolve(st.path, ".."), { recursive: true });
  writeFileSync(st.path, script);
  chmodSync(st.path, 0o755);
  return { ...base, result: st.state === "ennyn" ? "updated" : "installed", line, data };
}
