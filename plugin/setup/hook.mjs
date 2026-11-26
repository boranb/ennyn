/**
 * commit-check as the repository's commit-msg hook: the commit convention
 * becomes a gate instead of a line in CLAUDE.md. The hook names this
 * machine's CLI path, so it goes only into the repository's own hooks
 * directory: never into a tracked one (`core.hooksPath`), and never over a
 * hook it did not write. For a tracked one, or husky's, install-hook prints a
 * block the project puts first in its own hook (hookBlock): it names no path
 * of any machine.
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
import { join, resolve, dirname, basename, relative, isAbsolute, delimiter } from "node:path";
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

/** What the CLI's old place at the top of a clone or the npm package runs: the CLI below plugin/. */
export const FORWARDS_TO = "../plugin/scripts/ennyn.mjs";

/**
 * The CLI path a hook written without the plugin's data directory names. In a clone of Ennyn or its npm package, the
 * CLI below `plugin/` has a forwarder at the tree's top (`scripts/ennyn.mjs`, a regular file that imports
 * FORWARDS_TO): every version of that tree holds the forwarder's path, the CLI's before the move and the forwarder
 * after it, so a checkout of an older commit or a downgraded package still checks commits; a hook naming the moved
 * path would find nothing there and let every commit through. Anywhere else (an installed plugin, a copy without
 * the forwarder) the CLI's own path.
 * @param {string} cliPath absolute path of the CLI that runs
 */
export function hookCliPath(cliPath) {
  const pluginDir = dirname(dirname(cliPath));
  if (basename(cliPath) !== "ennyn.mjs" || basename(dirname(cliPath)) !== "scripts" || basename(pluginDir) !== "plugin") return cliPath;
  const forwarder = join(dirname(pluginDir), "scripts", "ennyn.mjs");
  try {
    if (!lstatSync(forwarder).isFile()) return cliPath;
    return readFileSync(forwarder, "utf8").includes(JSON.stringify(FORWARDS_TO)) ? forwarder : cliPath;
  } catch {
    return cliPath;
  }
}

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
 * hook script refuses the same spellings but for two bytes it cannot read the same way: a NUL (dash and ksh drop
 * it, and run the path that is left) and a C1 control (what `[[:cntrl:]]` holds is the shell's and the locale's).
 * The writer, install-hook's choice of a data directory, hookStatus, idleReason and doctor all read this one
 * predicate.
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
 * The version a plugin hook runs when no record is in `data`, as recordSteps takes it: the root the plugin session
 * names (`ENNYN_PLUGIN_ROOT`) when the session's data directory is `data` as text (both read with a backslash as a
 * slash), and the root is an installed version of this plugin: exactly `<cache>/<marketplace>/<plugin>/<version>`
 * beside `data`'s parent, with `<plugin>-<marketplace>` the data directory's own name (measured on Claude Code
 * 2.1.310: `<config>/plugins/data/<plugin>-<marketplace>` and `<config>/plugins/cache/<marketplace>/<plugin>/<version>`,
 * each name with what is not a letter, digit, `_` or `-` made `-`), no part empty, `.` or `..`, and one rootProblem
 * takes (an uninstall marks the version replaced; an install again at that version clears the mark). Measured on 2.1.310: an uninstall deletes the data directory, and an install again makes no record
 * until a session starts. null for anything else: the hook lets the commit through, as with no session.
 * @param {string} data @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function sessionRoot(data, env) {
  const given = env[SESSION_ROOT];
  if (!given || slashed(env[SESSION_DATA] ?? "") !== slashed(data)) return null;
  const root = slashed(given);
  const at = slashed(data);
  const parts = root.split("/");
  const [market, plugin, version] = parts.slice(-3);
  // As the shell's `${at%/*/*}` and `${at##*/}`: the last two parts off, and the last part, as text.
  if (parts.slice(0, -3).join("/") !== `${at.replace(/\/[^/]*\/[^/]*$/, "")}/cache` || `${plugin}-${market}` !== at.slice(at.lastIndexOf("/") + 1)) return null;
  if ([market, plugin, version].some((p) => p === "" || p === "." || p === "..")) return null;
  return rootProblem(root) === null ? root : null;
}

/** A backslash read as a slash: Claude Code names the data directory with slashes on Windows, and plugin-root the root with backslashes (resolve). @param {string} s */
const slashed = (s) => s.replace(/\\/g, "/");

/**
 * Whether a CLI path lies in npm's npx cache, where `npx ennyn` puts the package it fetches:
 * `<cache>/_npx/<hash>/node_modules/ennyn/…` (npm 10.9.9, under any cache folder: `npm_config_cache`, `--cache` or
 * the default). npm removes or replaces that folder (a cache clean, another version under another hash), and a hook
 * naming it then lets every commit through. Read from the path alone, slashes folded: the env npx sets is the same
 * for a project's own install run through `npx ennyn`, and `npm config get cache` is a child process that fails
 * with no npm on PATH.
 * @param {string} cliPath
 */
export const inNpxCache = (cliPath) => /(?:^|\/)_npx\/[^/]+\/node_modules\//.test(slashed(cliPath));

/**
 * The line a commit-msg hook runs; quoted for the shell, so a path with spaces, quotes or $ survives.
 * `--hook`: a config that does not load lets the commit through with a warning instead of locking it.
 * With the plugin's data directory, the line reads the version from its record: a record that names no
 * CLI fails the commit (node finds no module), never passes it. It goes first in a hook that may go on (printedCheck),
 * so it ends the hook on a refusal: a bare call's failure would be lost.
 * @param {string} cliPath
 * @param {string | null} [data]
 */
export function hookLine(cliPath, data = null) {
  if (data !== null) return `node "$(cat ${shQuote(join(data, PLUGIN_RECORD))})/scripts/ennyn.mjs" commit-check --hook "$1" || exit $?`;
  return `node ${shQuote(cliPath)} commit-check --hook "$1" || exit $?`;
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
  if (data === null) {
    return `${head}cli=${shQuote(cliPath)}
${NODE}if [ ! -f "$cli" ]; then
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
${NODE}${recordSteps(`  ${absolute}) root=$line ;;\n`, {
    gone: "the ennyn plugin was uninstalled, or has not run since",
    none: `Run install-hook from the plugin again (/ennyn:init), or ${remove}.`,
    foreign: `Delete it, then run install-hook from the plugin again (/ennyn:init); or ${remove}.`,
    stale: `Run install-hook from the plugin again (/ennyn:init; any Claude Code session with the plugin also records its version); if the plugin is uninstalled, ${remove}.`,
    line: " ($line)",
    session: "To record it again, run ennyn install-hook from the plugin in this session (/ennyn:init), or start a new Claude Code session: until then a commit made outside this session is not checked.",
  })}`;
}

/** A missing node lets the commit through with a warning: hookScript's first step, and hookBlock's. */
const NODE = `if ! command -v node >/dev/null 2>&1; then
  echo "ennyn: node not found; commit message not checked." >&2
  exit 0
fi
`;

/**
 * A plugin hook's steps from the record (`$record`, in `$data`) to commit-check, hookScript's and hookBlock's
 * alike: nothing there lets the commit through (exit 0), a link or anything but a regular file, a first line
 * with a control character or that `absolute` (case arms that set `root`) does not take, or a version whose CLI
 * is gone refuses it (exit 1). With no record, a plugin session of this data directory checks the commit with the
 * version it runs (sessionRoot: an install again deletes the record, and only a session start writes it), when that
 * is an installed version of this plugin; any other leaves the commit through. `say`: why no record may be there
 * (`gone`), the step each message names (put between single quotes: no `'` in them), and how the refusal shows the
 * line it read (`line`). `gate`: the last step before the CLI runs.
 * @param {string} absolute @param {{ gone: string, none: string, foreign: string, stale: string, line: string, session: string }} say @param {string} [gate]
 */
function recordSteps(absolute, say, gate = "") {
  const none = `printf '%s\\n' "ennyn: no plugin version is recorded in $data (${say.gone}), so the commit message is not checked." '${say.none}' >&2
    exit 0`;
  return `line=
session=
if [ ! -e "$record" ] && [ ! -L "$record" ]; then
  # A backslash read as a slash, for a Windows spelling of either path: by the shell alone, every byte kept,
  # and no program found on PATH, which the repository can choose.
  slashed() {
    slashed_in=$1
    slashed=
    while :; do
      case $slashed_in in
        *\\\\*) slashed=$slashed\${slashed_in%%\\\\*}/ ; slashed_in=\${slashed_in#*\\\\} ;;
        *) break ;;
      esac
    done
    slashed=$slashed$slashed_in
  }
  slashed "\${${SESSION_DATA}:-}"
  given=$slashed
  slashed "$data"
  at=$slashed
  if [ -z "\${${SESSION_ROOT}:-}" ] || [ "$given" != "$at" ]; then
    ${none}
  fi
  slashed "$${SESSION_ROOT}"
  line=$slashed
  session=1
elif [ -L "$record" ] || [ ! -f "$record" ]; then
  printf '%s\\n' "ennyn: $record is no record Ennyn wrote (a link, or not a regular file), so this commit is refused." '${say.foreign}' >&2
  exit 1
else
  { IFS= read -r line < "$record"; } 2>/dev/null
fi
root=
case $line in
  *[[:cntrl:]]*) ;;
${absolute}esac
cli="$root/scripts/ennyn.mjs"
if [ -n "$session" ]; then
  version=\${root##*/}
  up=\${root%/*}
  plugin=\${up##*/}
  up=\${up%/*}
  market=\${up##*/}
  up=\${up%/*}
  [ "$up" = "\${at%/*/*}/cache" ] && [ "$plugin-$market" = "\${at##*/}" ] || root=
  case /$market/$plugin/$version/ in
    *//*|*/./*|*/../*) root= ;;
  esac
  if [ -z "$root" ] || [ ! -f "$cli" ] || [ -e "$root/${ORPHANED}" ] || [ -L "$root/${ORPHANED}" ]; then
    ${none}
  fi
  printf '%s\\n' "ennyn: no plugin version is recorded in $data (an install again deletes it), so this commit is checked with the version this Claude Code session runs." '${say.session}' >&2
elif [ -z "$root" ] || [ ! -f "$cli" ]; then
  printf '%s\\n' "ennyn: the plugin version recorded in $record${say.line} is no absolute path to a version that is there, so this commit is refused." '${say.stale}' >&2
  exit 1
fi
${gate}exec node "$cli" commit-check --hook "$1"
`;
}

/** The first line of hookBlock's block: how doctor finds the block in a project's own hook. */
export const BLOCK_MARKER = "# >>> ennyn commit-check";

/** The last line of hookBlock's block: how uninstall-hook says where the block ends. */
export const BLOCK_END = "# <<< ennyn commit-check";

/** The last part of a data directory the block can hold: what Claude Code makes of a plugin's id, and no `.`, `..` or quote. */
export const BLOCK_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/**
 * hookBlock's text for a plugin's data directory named `id`. It finds the directory as Claude Code 2.1.310 keeps it
 * (`<config>/plugins/data/<id>`, the config `CLAUDE_CONFIG_DIR` or `~/.claude`), or the one a plugin session names
 * (`ENNYN_PLUGIN_DATA`, which also finds a directory `CLAUDE_CODE_PLUGIN_CACHE_DIR` moved), and then runs what
 * hookScript runs, in a subshell: an exit there ends the block, not the hook, except a refusal, which the hook
 * returns. So the project's own early exits after it (exempt subjects, a marker) skip only the project's checks.
 *
 * Git runs a commit-msg hook at the work tree's top, and what the repository holds must not decide the check, so
 * the block trusts nothing under it: PATH loses every empty, relative or in-tree entry, compared as real paths
 * (husky 9 puts `node_modules/.bin` first, and a package with no install script can link a `node` there), filtered
 * and never refused, so a project that depends on the `node` package still commits; nothing left is a PATH naming no
 * directory, as an empty one means the current directory to sh, dash and zsh. A data directory or a record's CLI in
 * the work tree refuses the commit: install-hook's own refusal holds only when it runs. A real path is what the
 * kernel finds, `cd -P` and then /bin/pwd: a logical cd takes `link/..` as text, and the builtin pwd of bash and ksh
 * keeps the spelling it was given (a volume that folds case, a firmlink, `PWD`). node runs with no NODE_OPTIONS or
 * NODE_PATH, which a tracked .npmrc gets into the environment through npm run. `uname` says what counts as absolute,
 * read after the filter: a drive path only on Git for Windows and Cygwin. A refusal prints no byte it refuses.
 * hookScript has the same exposures: hook-node-in-repo.
 * @param {string} id
 */
function blockText(id) {
  const remove = "take this block out of the hook";
  const outside = "Keep the data directory and the version of the plugin outside the repository";
  const inTree = (/** @type {string} */ what) => `printf '%s\\n' "ennyn: ${what}, where the repository could choose what runs, so this commit is refused." '${outside}; or ${remove}.' >&2`;
  const body = `id=${shQuote(id)}
physical() {
  cd -P "$1" 2>/dev/null && { /bin/pwd -P 2>/dev/null || pwd -P; }
}
top=$(physical .)
kept=
rest=\${PATH:-}:
while [ -n "$rest" ]; do
  dir=\${rest%%:*}
  rest=\${rest#*:}
  case $dir in
    /*) ;;
    *) continue ;;
  esac
  real=$(physical "$dir") || continue
  case $real/ in
    "$top"/*) continue ;;
  esac
  kept=\${kept:+$kept:}$dir
done
PATH=\${kept:-/nonexistent}
${NODE}windows=
case $(uname -s 2>/dev/null) in
  MINGW*|MSYS*|CYGWIN*) windows=1 ;;
esac
if [ -n "\${ENNYN_PLUGIN_DATA:-}" ]; then
  data=$ENNYN_PLUGIN_DATA
elif [ -n "\${CLAUDE_CONFIG_DIR:-}" ]; then
  data=$CLAUDE_CONFIG_DIR/plugins/data/$id
elif [ -n "\${HOME:-}" ]; then
  data=$HOME/.claude/plugins/data/$id
else
  printf '%s\\n' "ennyn: HOME is not set, so the plugin's data directory is unknown and this commit is refused." 'Set HOME, or ENNYN_PLUGIN_DATA to the data directory of the plugin; or ${remove}.' >&2
  exit 1
fi
absolute=
case $data in
  *[[:cntrl:]]*) ;;
  /*) absolute=1 ;;
  [A-Za-z]:[\\\\/]*) [ -z "$windows" ] || absolute=1 ;;
esac
if [ -z "$absolute" ]; then
  printf '%s\\n' "ennyn: the plugin's data directory is no absolute path, or holds a control character, so this commit is refused." 'Set CLAUDE_CONFIG_DIR as Claude Code has it, or ENNYN_PLUGIN_DATA to the data directory; or ${remove}.' >&2
  exit 1
fi
if [ -d "$data" ]; then
  real=$(physical "$data")
  if [ -z "$real" ]; then
    printf '%s\\n' "ennyn: the plugin's data directory $data cannot be read, so this commit is refused." 'Make it readable; or ${remove}.' >&2
    exit 1
  fi
  case $real/ in
    "$top"/*)
      ${inTree("the plugin's data directory $data lies inside this work tree")}
      exit 1 ;;
  esac
fi
record="$data/${PLUGIN_RECORD}"
${recordSteps(
  `  /*) root=$line ;;\n  [A-Za-z]:[\\\\/]*) [ -z "$windows" ] || root=$line ;;\n`,
  {
    gone: "the ennyn plugin is not installed for this user, was uninstalled, or has not run since",
    none: `A Claude Code session with the plugin records it; or ${remove}.`,
    foreign: `Delete it, then start a Claude Code session with the plugin, which records its version; or ${remove}.`,
    stale: `Start a Claude Code session with the plugin, which records the version it runs; if the plugin is uninstalled, ${remove}.`,
    line: "",
    session: "To record it again, run ennyn install-hook from the plugin in this session (/ennyn:init), or start a new Claude Code session: until then a commit made outside this session is not checked.",
  },
  `real=$(physical "$root/scripts")
case $real/ in
  "$top"/*) real= ;;
esac
if [ -z "$real" ] || [ -L "$cli" ]; then
  ${inTree("the plugin version recorded in $record lies inside this work tree, or its CLI is a link")}
  exit 1
fi
unset NODE_OPTIONS NODE_PATH
`,
)}`;
  // Indented as the subshell's body.
  const inner = body.replace(/^(?=.)/gm, "  ");
  return `${BLOCK_MARKER}: keep this block first in the hook, before any other command.
# Printed by ennyn install-hook. It checks every commit this hook sees, whatever the rest of the hook skips.
(
${inner}) || exit $?
${BLOCK_END}
`;
}

/**
 * The block install-hook prints for a project's own commit-msg hook in a tracked hooks directory or husky's, where
 * Ennyn writes nothing: the file is the project's, shared by every clone, so the block names no path of this
 * machine (blockText). doctor reads it as wired only exact and first (printedCheck).
 * @param {string} data the plugin's data directory install-hook was given or the session names
 */
export function hookBlock(data) {
  return blockText(basename(data));
}

/**
 * A `#!` line printed text is read under: a shell of the sh family in a system or Homebrew directory, or one of those
 * names through /usr/bin/env, the block's syntax running under each. A path elsewhere can be the repository's
 * (`/proc/self/cwd/tools/sh`), and a bare name is relative. Its one word of flags is made of e, u and x: others run
 * nothing (-n, -s, -c), and env's own (-S, -i) change what follows.
 */
const SH_SHEBANG = /^#![ \t]*(?:\/(?:usr\/(?:local\/)?)?bin\/|\/opt\/homebrew\/bin\/|\/usr\/bin\/env[ \t]+)(?:ba|da|k|z|a)?sh(?:[ \t]+-[eux]+)?[ \t]*$/;

/** A line that may stand before printed text: blank, a comment, or a `set` of those flags. `set -n` runs nothing, and `set --` changes the message's path. */
const QUIET = /^[ \t]*(?:#.*|set(?:[ \t]+-[eux]+)+[ \t]*)?$/;

/** A path as shQuote prints it. @param {string} quoted what stands between the outer quotes */
const unquoted = (quoted) => quoted.split("'\\''").join("'");

/** hookLine's two forms: the CLI's path, or the path of the record that names it. */
const PRINTED_LINE = /^node (?:'((?:[^']|'\\'')*)'|"\$\(cat '((?:[^']|'\\'')*)'\)\/scripts\/ennyn\.mjs") commit-check --hook "\$1" \|\| exit \$\?$/;

/**
 * The line, if `line` is what hookLine prints for a path install-hook could name: absolute, with no control character,
 * a CLI or a record by its place.
 * @param {string} line
 * @returns {{ id: null, path: string } | null}
 */
function printedLine(line) {
  const m = PRINTED_LINE.exec(line);
  if (m === null) return null;
  const path = unquoted(m[1] ?? m[2]);
  const printed = m[1] !== undefined ? hookLine(cliOf(rootOf(path))) : hookLine("", dirname(path));
  return printed === line && isAbsolute(path) && !CONTROL.test(path) ? { id: null, path } : null;
}

/**
 * The block, if `text` starts with it exactly as hookBlock prints it, the id read from it.
 * @param {string} text
 * @returns {{ id: string, path: null } | null}
 */
function printedBlock(text) {
  const id = /^ {2}id='([^'\n]*)'$/m.exec(text)?.[1];
  if (id === undefined || !BLOCK_ID.test(id)) return null;
  const want = blockText(id).trimEnd();
  return text === want || text.startsWith(`${want}\n`) ? { id, path: null } : null;
}

/**
 * What install-hook printed, when a hook holds it first, byte for byte: the block (`id`) or the line (`path`); null for
 * every other text. Hand-written shell is not read: a word search for `exit`, then a list of words that run a program,
 * each read a real commit landing a secret as ✓, and a false warning stops no commit. Before it stand only a shebang
 * (SH_SHEBANG) and QUIET lines, husky's own `. "$(dirname …)/_/husky.sh"` not among them: it runs a program PATH
 * chooses and a file beside the hook, so the block goes above it. What follows it is not read: a line after it can
 * rewrite the message, unchecked. A CR at a line's end is no exact text: the shell hands --hook a path with the CR in it.
 * @param {string} text
 * @returns {{ id: string | null, path: string | null } | null}
 */
export function printedCheck(text) {
  const lines = text.split("\n");
  if (text.startsWith("#!") && !SH_SHEBANG.test(lines[0])) return null;
  const at = lines.findIndex((l) => l.startsWith(BLOCK_MARKER) || !QUIET.test(l));
  if (at === -1) return null;
  return lines[at].startsWith(BLOCK_MARKER) ? printedBlock(lines.slice(at).join("\n")) : printedLine(lines[at]);
}

/** commit-check as a word of a hook's text, whatever the word does there: what names it is told `doctor.hookUnread`. */
const NAMES = /(?<![\w-])commit-check(?![\w-])/;

/** @param {string} text */
export const namesCheck = (text) => NAMES.test(text);

/** Why a plugin version cannot be recorded; `reason` names the check that refused it. */
export class RecordError extends Error {
  /** @param {"relative" | "control" | "replaced" | "noCli" | "foreign" | "link"} reason @param {string} message */
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
 * The real path of p, what the kernel finds: `link/..` is not read as text, and a volume that folds case gives the
 * spelling on disk (realpathSync's own walk does neither). For a path that does not exist yet, the real path of
 * its nearest existing ancestor with the rest appended (a hooks directory not created yet still compares
 * correctly through a link).
 * @param {string} p
 */
function real(p) {
  /** @type {string[]} */
  const rest = [];
  let cur = isAbsolute(p) ? p : resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest);
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
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] what the hook's block reads its data directory from
 * @returns {{ path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, state: "none" | "ennyn" | "wired" | "other", there: boolean, runs: boolean, cli: string | null, data: string | null, recorded: string | null, problem: ReturnType<typeof readRecord>["problem"] | "inRepository" | "noData" | "noNode", fromSession: boolean, unread: string | null, late: string | null, block: string | null }}
 *   "ennyn": a hook holding HOOK_MARKER, in the repository's own hooks directory or one outside the repository: what is
 *   there took a write on this machine, which can do anything. Ennyn writes into no tracked directory and no husky's, so
 *   there the marker is any other text. "wired": a hook Ennyn did not write that names commit-check (a project's own
 *   tracked hook, or husky's .husky/commit-msg behind its generated .husky/_ stubs); it counts only as printed (`unread`).
 *   hooksPath: the value, "" for an empty one, with which git runs no hook. hooksKind: where core.hooksPath points:
 *   inside the repository, or inside the main checkout from a linked worktree ("repo", usually tracked), husky's stub
 *   directory ("husky"), or outside it ("global", every repository on this machine).
 *   runs: git would run the file at `path` (it is there and executable; git skips one that is not, with a
 *   hint). cli: the CLI an Ennyn hook names, null for any other hook (one written from a copy of Ennyn that
 *   has moved since lets every commit through unchecked; doctor looks for it); for a hook installed from the
 *   plugin, the CLI its record names when the hook would run it. data: the plugin's data directory such a
 *   hook reads its record from, null for any other hook; recorded and problem: readRecord's answer for it, or with
 *   no record there, the plugin session's version the hook runs instead (`fromSession`: sessionRoot, in `env`).
 *   unread: the file that names commit-check (husky's: the one its stub runs) when it is not what install-hook printed,
 *   first, for a hook of this kind (printedCheck; the line counts neither under husky nor, in a hooks directory of the
 *   repository, naming one of its work trees); null otherwise. late: the file git runs, when the index holds anything in husky's stub directory;
 *   null otherwise. block: the file that holds hookBlock's block exact and first; cli, data, recorded and problem are
 *   then what the block reads in `env`: `noNode` where the filter leaves no node, `noData` where it finds no directory
 *   it may read, `inRepository` for a record naming the work tree or a CLI that is a link.
 */
export function hookStatus(cwd, env = process.env) {
  const hooksPath = gitMaybe(["config", "--get", "core.hooksPath"], { cwd, absent: [1] });
  const dir = resolve(cwd, git(["rev-parse", "--git-path", "hooks"], { cwd }));
  const path = join(dir, "commit-msg");
  // An empty value: git runs no hook, and answers `./` for the directory.
  const off = hooksPath === "";
  const text = off ? null : readOrNull(path);
  /** @type {"repo" | "husky" | "global" | null} */
  let hooksKind = null;
  if (hooksPath) {
    const top = repoPath("--show-toplevel", { cwd }) ?? cwd;
    // Both sides as real paths: git prints the real top level, while dir came through cwd (a link, /var → /private/var).
    const rel = relative(real(top), real(dir));
    const inside = !(rel.startsWith("..") || isAbsolute(rel)) || sameRepository(cwd, dir);
    // husky v9 keeps its stubs in a "_" directory (.husky/_, or one of the project's choosing) next to the
    // runner it writes there, "h"; a tracked directory named "_" without it is the repository's own.
    const husky = basename(dir) === "_" && (basename(dirname(dir)) === ".husky" || present(join(dir, "h")));
    hooksKind = !inside ? "global" : husky ? "husky" : "repo";
  }
  // husky v9: .husky/_/commit-msg is a generated stub that runs .husky/commit-msg.
  const userPath = hooksKind === "husky" ? join(dirname(dir), "commit-msg") : null;
  const userHook = userPath !== null ? readOrNull(userPath) : null;
  const named = (/** @type {string | null} */ t) => t !== null && namesCheck(t);
  const state =
    text !== null && text.includes(HOOK_MARKER) && (hooksKind === null || hooksKind === "global")
      ? "ennyn"
      : named(text) || named(userHook)
        ? "wired"
        : text === null && userHook === null
          ? "none"
          : "other";
  // The project's file that names commit-check, and what of it install-hook printed.
  const own = state !== "wired" ? null : named(text) ? { text: /** @type {string} */ (text), at: path } : { text: /** @type {string} */ (userHook), at: /** @type {string} */ (userPath) };
  const printed = own !== null ? printedCheck(own.text) : null;
  // The line trusts PATH and its path, as the block does not: under husky, whose runner puts node_modules/.bin first, a
  // dependency's bin answers for `node`, and a tracked hook naming a work tree runs the repository's own file.
  const chosen = printed !== null && printed.path !== null && (hooksKind === "husky" || (hooksKind === "repo" && sameRepository(cwd, printed.path)));
  const counts = printed !== null && !chosen;
  const unread = own !== null && !counts ? own.at : null;
  const late = counts && hooksKind === "husky" && stubsTracked(dir) ? path : null;
  const read = printed?.id ? blockRecord(printed.id, cwd, env) : null;
  const data = state === "ennyn" ? quoted(/** @type {string} */ (text), "data") : (read?.data ?? null);
  const kept = read?.record ?? (data !== null ? readRecord(data) : null);
  // No record: the plugin session's version, where the hook would take it (sessionRoot).
  const session = read === null && data !== null && kept?.problem === "none" ? sessionRoot(data, env) : null;
  const record = session !== null ? { root: session, problem: null } : kept;
  const fromSession = session !== null || read?.fromSession === true;
  // The CLI the hook runs: one its record names only when the hook would run it (a replaced version still runs).
  const runnable = record !== null && (record.problem === null || record.problem === "replaced");
  const cli = record !== null ? (runnable ? cliOf(/** @type {string} */ (record.root)) : null) : state === "ennyn" ? hookCli(/** @type {string} */ (text)) : null;
  return { path, hooksPath, hooksKind, state, there: text !== null, runs: !off && executable(path), cli, data, recorded: record?.root ?? null, problem: record?.problem ?? null, fromSession, unread, late, block: read !== null ? /** @type {{ at: string }} */ (own).at : null };
}

/**
 * Whether `dir` (a hooks directory, or what is there of it) lies in a work tree of the repository at `cwd`: the main
 * checkout of a linked worktree, whatever its layout: Claude Code's agent-worktree setup makes a relative value
 * absolute, in the config every worktree shares. git is asked from there, as `git worktree list` cannot say: its
 * first entry is the git directory for a --separate-git-dir repository and for a submodule (2.34.1 and 2.56.0).
 * `dir` in no repository git reads (no repository, one it refuses) is no repository of this.
 * @param {string} cwd @param {string} dir
 */
function sameRepository(cwd, dir) {
  let at = real(dir);
  while (!isDir(at)) at = dirname(at);
  const there = gitMaybe(["rev-parse", "--is-inside-work-tree", "--path-format=absolute", "--git-common-dir"], { cwd: at, absent: [128] });
  if (there === null) return false;
  const [worktree, common] = there.split("\n");
  return worktree === "true" && real(common) === real(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }));
}

/**
 * Whether the index holds husky's stub directory, or anything in it under any spelling: a file, a link, a submodule.
 * husky's own `.gitignore` there keeps out all it generates, so what the index holds is the repository's, and git
 * runs it before the file a stub would run.
 * @param {string} dir the hooks directory
 */
const stubsTracked = (dir) => git(["ls-files", "--", basename(dir)], { cwd: dirname(dir) }) !== "";

/**
 * The plugin's data directory as hookBlock's block finds it, in its order; null with nothing to find it by.
 * @param {string} id @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function blockData(id, env) {
  if (env[SESSION_DATA]) return /** @type {string} */ (env[SESSION_DATA]);
  // As text, as the block joins them: `link/..` is the kernel's to read.
  if (env.CLAUDE_CONFIG_DIR) return `${env.CLAUDE_CONFIG_DIR}/plugins/data/${id}`;
  return env.HOME ? `${env.HOME}/.claude/plugins/data/${id}` : null;
}

/**
 * Whether the block's PATH filter leaves a node: an absolute entry that is no part of the work tree, as real paths,
 * holding an executable file of that name. An entry the block cannot enter is dropped there too.
 * @param {string} cwd @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function blockNode(cwd, env) {
  const name = process.platform === "win32" ? "node.exe" : "node";
  return (env.PATH ?? "").split(delimiter).some((entry) => {
    if (!isAbsolute(entry) || inRepository(cwd, entry)) return false;
    try {
      accessSync(join(entry, name), constants.X_OK);
      return statSync(join(entry, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * What the block finds in `env`, as it reads it and in its order: no node left on PATH (`noNode`: the commit passes,
 * whatever else is wrong), no directory it may read (`noData`: nothing to find it by, no absolute path, a control
 * character, a directory in the work tree or one it cannot enter; none there at that path holds no record, so the
 * commit passes), or readRecord's answer, with a version it runs in the work tree, or a CLI that is a link, as
 * `inRepository`, which it refuses: a replaced version too, which only a hook of Ennyn's own still runs.
 * @param {string} id @param {string} cwd @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * With no record, the session's version when sessionRoot gives one (`fromSession`).
 * @returns {{ data: string | null, fromSession?: boolean, record: { root: string | null, problem: ReturnType<typeof readRecord>["problem"] | "inRepository" | "noData" | "noNode" } }}
 */
function blockRecord(id, cwd, env) {
  if (!blockNode(cwd, env)) return { data: null, record: { root: null, problem: "noNode" } };
  const data = blockData(id, env);
  const noData = { data: null, record: { root: null, problem: /** @type {const} */ ("noData") } };
  if (data === null || CONTROL.test(data) || !isAbsolute(data)) return noData;
  const there = isDir(data);
  if (there && (inRepository(cwd, data) || !searchable(data))) return noData;
  // The record through the directory's real path: `link/..` is what the kernel finds, as the block's cd -P reads it.
  const kept = readRecord(there ? realpathSync.native(data) : data);
  const session = kept.problem === "none" ? sessionRoot(data, env) : null;
  /** @type {{ root: string | null, problem: ReturnType<typeof readRecord>["problem"] }} */
  const record = session !== null ? { root: session, problem: null } : kept;
  const runs = record.root !== null && (record.problem === null || record.problem === "replaced");
  return { data, fromSession: session !== null, record: runs && (lstatOrNull(cliOf(/** @type {string} */ (record.root)))?.isSymbolicLink() || inRepository(cwd, cliOf(/** @type {string} */ (record.root)))) ? { root: record.root, problem: "inRepository" } : record };
}

/**
 * Why a hook that runs commit-check checks nothing: its file is not there (husky's stub before husky
 * installs), git would not run it (not executable), or the CLI an Ennyn hook names is no file (gone, or a
 * directory in its place: the hook's own `[ -f "$cli" ]`); null when it checks. For a hook installed from the
 * plugin, readRecord's answer: `unrecorded` when no record is there (the hook lets every commit through),
 * `foreign` when something that is no regular file is at its place, `stale` when its line names no root the
 * hook runs (both refuse every commit). `unread`: a project's own hook names it, but is not what install-hook printed,
 * first (printedCheck); `late`: the index holds a file of husky's stub directory, which git runs first.
 * For the block, the same answers from the record it reads, `noNode` where its PATH filter leaves no node (it lets
 * every commit through) and `noData` where it finds no directory it may read (it refuses every commit). doctor and
 * installHook read this one answer. A path that cannot be looked at throws.
 * @param {ReturnType<typeof hookStatus>} st
 * @returns {"absent" | "mode" | "unread" | "late" | "noNode" | "noData" | "cli" | "stale" | "unrecorded" | "foreign" | null}
 */
export function idleReason(st) {
  if (!st.there) return "absent";
  if (!st.runs) return "mode";
  if (st.unread !== null) return "unread";
  if (st.late !== null) return "late";
  if (st.problem === "noNode" || st.problem === "noData") return st.problem;
  if (st.data !== null) return st.problem === "none" ? "unrecorded" : st.problem === "foreign" ? "foreign" : st.cli === null ? "stale" : null;
  if (st.cli !== null && !isFile(st.cli)) return "cli";
  return null;
}

/**
 * Whether an Ennyn script names, on its `cli=` line, a CLI in npm's npx cache (inNpxCache): written by install-hook
 * run through npx before it refused that, it checks until npm cleans the folder, then lets every commit through. A
 * plugin hook's CLI comes from its record, and is not read here. doctor and installHook read this one answer.
 * @param {ReturnType<typeof hookStatus>} st
 */
export const npxHook = (st) => st.state === "ennyn" && st.data === null && st.cli !== null && inNpxCache(st.cli);

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

/** @param {string} path */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    if (gone(err)) return false;
    throw err;
  }
}

/** What is at `path` itself, a link not followed; null with nothing there. @param {string} path */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (gone(err)) return null;
    throw err;
  }
}

/** Whether a directory can be entered, as `cd` asks. @param {string} dir */
function searchable(dir) {
  try {
    accessSync(dir, constants.X_OK);
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EACCES") return false;
    throw err;
  }
}

/**
 * Whether two paths name one directory, compared as the kernel's real paths: on Windows `c:\…` and an 8.3 name are the
 * spelling on disk, which realpathSync's own walk keeps as given (measured, Node 22). False when either is not there,
 * and when either cannot be looked at (EACCES, EPERM): no proof of one folder, so install-hook names this copy.
 * @param {string} a @param {string} b
 */
function sameRoot(a, b) {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (gone(err) || code === "EACCES" || code === "EPERM") return false;
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
  return m ? unquoted(m[1]) : null;
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

/** Whether a data directory, when there is one, ends in an id the block can hold. @param {string | null} data */
const blockIdNames = (data) => data === null || BLOCK_ID.test(basename(data));

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
 * `restored`: no record was there, and install-hook wrote it from this plugin session (sessionRoot).
 * @returns {{ restored: boolean, result: "installed" | "updated" | "unchanged" | "wired" | "notThere" | "notExecutable" | "blockUnread" | "late" | "hooksOff" | "blockUnrecorded" | "blockStale" | "blockNoData" | "blockNoNode" | "cliGone" | "cliUnrecorded" | "cliRefused" | "cliForeign" | "cliReplaced" | "cliPinned" | "cliOtherVersion" | "cliNpxCache" | "replacedCopy" | "npxCopy" | "followsRecord" | "dataInRepository" | "dataName" | "other" | "hooksPath", path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, line: string, block: string, cli: string | null, data: string | null, root: string, recorded: string, chmod: string, own: string }}
 *   `line`: what to add to a hook Ennyn does not write (shell-quoted); `block`: with the plugin's data directory
 *   known, hookBlock's block for the project's own hook, for a tracked hooks directory, husky's, or a hook doctor
 *   cannot read (else ""); dataName: that directory's last part is no id the block can hold (BLOCK_ID), so
 *   nothing is printed. `chmod`: the command that makes the hook executable, quoted the same way; `own`: under
 *   husky, the file its stub runs; for the results below that start with `block`, the project's file. notThere /
 *   notExecutable / cliGone / cliUnrecorded / cliRefused / cliForeign: a hook that runs commit-check and is not
 *   Ennyn's to write checks nothing or refuses every commit (idleReason), as doctor says; blockUnread: it names the
 *   check, but is not what install-hook printed, first (printedCheck); late: the index holds a file of husky's stub
 *   directory (`own`: the file git runs); hooksOff: core.hooksPath is empty, so git runs no hook; blockUnrecorded / blockStale / blockNoData / blockNoNode: the block, exact and first,
 *   finds no record (every commit passes), one it cannot run, no directory it may read (every commit is refused),
 *   or no node once it has filtered PATH (every commit passes). cliReplaced: it
 *   checks with a plugin version Claude Code has replaced (`root`); cliPinned / cliOtherVersion: versionNote.
 *   replacedCopy: this copy of Ennyn is such a version (`root`); a hook naming it, or a record of it, would
 *   stop checking when Claude Code deletes it, so nothing is written. npxCopy: this copy runs from npm's npx cache
 *   (inNpxCache, `root`), which npm cleans, so nothing is written either; cliNpxCache: an Ennyn script under
 *   core.hooksPath names such a copy (npxHook). `data`: the data directory the hook
 *   reads its record from; `recorded`: what that record names. The record is written only with Ennyn's own
 *   hook: a run that writes no hook moves no other repository's.
 */
export function installHook({ cwd, cliPath, pluginData = null, session = null }) {
  const st = hookStatus(cwd);
  const res = installWith(st, { cwd, cliPath, pluginData, session });
  // No record, and the hook checks with this session's version: on a run that goes through, and only then, the record
  // written again, as the session's start writes it, so a commit outside the session is checked too. A refused run
  // writes nothing, and a fallback is never read as a record.
  const through = ["installed", "updated", "unchanged", "wired"].includes(res.result);
  const restored = through && st.fromSession && st.data !== null && st.recorded !== null && readRecord(st.data).problem === "none" ? restoreRecord(st.data, st.recorded) : false;
  return { ...res, restored };
}

/**
 * Records the session's version `root` in `data` for installHook, once its real path is the same version folder in
 * Claude Code's cache beside `data`, the cache resolved too: a link there to anywhere else would have every commit
 * with no session run its target. sessionRoot has read the text already.
 * @param {string} data @param {string} root
 */
function restoreRecord(data, root) {
  const [market, plugin, version] = slashed(root).split("/").slice(-3);
  const cache = join(dirname(dirname(data)), "cache");
  if (real(root) !== join(real(cache), market, plugin, version)) throw new RecordError("link", `${root} is no version folder of ${cache} once links are followed, so it is not recorded`);
  return recordPluginRoot(data, root);
}

/**
 * installHook's answer for the hook as `st` reads it.
 * @param {ReturnType<typeof hookStatus>} st
 * @param {{ cwd: string, cliPath: string, pluginData: string | null, session: { data: string, root: string } | null }} opts
 * @returns {Omit<ReturnType<typeof installHook>, "restored">}
 */
function installWith(st, { cwd, cliPath, pluginData, session }) {
  const self = rootOf(cliPath);
  const own = st.hooksPath ? join(dirname(st.hooksPath), "commit-msg") : "";
  const base = { path: st.path, hooksPath: st.hooksPath, hooksKind: st.hooksKind, cli: st.cli, chmod: `chmod +x ${shQuote(st.path)}`, own, root: "", recorded: st.recorded ?? "", line: hookLine(cliPath), block: "", data: st.data };
  if (present(join(self, ORPHANED))) return { ...base, result: "replacedCopy", root: self };
  // Run through npx: a hook, a record or a printed line naming this copy would stop checking once npm cleans its cache.
  if (inNpxCache(cliPath)) return { ...base, result: "npxCopy", root: self };
  if (st.hooksPath === "") return { ...base, result: "hooksOff" };
  const fromSession = session !== null && sameRoot(session.root, self) ? session.data : null;
  const kept = st.data !== null && st.problem === null && sameRoot(/** @type {string} */ (st.recorded), self) ? st.data : null;
  const data = pluginData ?? fromSession ?? kept;
  if (data !== null && inRepository(cwd, data)) return { ...base, result: "dataInRepository", data };
  // A hook with no data directory names a path every version of this tree holds, whatever the session (hookCliPath).
  const written = data === null ? hookCliPath(cliPath) : cliPath;
  const line = hookLine(written, data);
  // A hook that names commit-check but is not Ennyn's to write here (the project's own, husky's, or a copy of
  // Ennyn's script in a hooks directory outside the repository): nothing to do while it checks; when it checks
  // nothing, with a replaced or pinned version, or with another scope's, why.
  if (st.state === "wired" || (st.state === "ennyn" && st.hooksPath)) {
    const idle = idleReason(st);
    /** @type {Record<string, "notThere" | "notExecutable" | "cliGone" | "cliUnrecorded" | "cliRefused" | "cliForeign">} */
    const why = { absent: "notThere", mode: "notExecutable", cli: "cliGone", unrecorded: "cliUnrecorded", stale: "cliRefused", foreign: "cliForeign" };
    // The hook is the project's to change: the message names its file, with the block to put first.
    if (idle === "unread") return blockIdNames(data) ? { ...base, result: "blockUnread", line, own: /** @type {string} */ (st.unread), block: data !== null ? hookBlock(data) : "" } : { ...base, result: "dataName", data };
    if (idle === "late") return { ...base, result: "late", line, own: /** @type {string} */ (st.late) };
    if (st.block !== null) {
      /** @type {Record<string, "blockUnrecorded" | "blockStale" | "blockNoData" | "blockNoNode">} */
      const block = { unrecorded: "blockUnrecorded", stale: "blockStale", foreign: "blockStale", noData: "blockNoData", noNode: "blockNoNode" };
      if (idle !== null && idle in block) return { ...base, result: block[idle], line, own: st.block };
    }
    // A CLI in npm's npx cache, there or already cleaned, as doctor reads it.
    if ((idle === null || idle === "cli") && npxHook(st)) return { ...base, result: "cliNpxCache", line };
    if (idle !== null) return { ...base, result: why[idle], line };
    const replaced = st.block === null ? replacedRoot(st) : null;
    if (replaced !== null) return { ...base, result: "cliReplaced", line, root: replaced };
    const note = versionNote(st, session);
    return { ...base, result: note === "pinned" ? "cliPinned" : note === "other" ? "cliOtherVersion" : "wired", line, root: session?.root ?? "" };
  }
  // A hooks path is someone else's arrangement: a tracked directory, husky's stubs, or a global directory
  // for every repository. Ennyn writes into none of them; the message says what to add where: in a tracked
  // one, from the plugin, a block that names no path of this machine.
  if (st.hooksPath) {
    const tracked = st.hooksKind !== "global";
    if (tracked && !blockIdNames(data)) return { ...base, result: "dataName", data };
    return { ...base, result: "hooksPath", line, block: tracked && data !== null ? hookBlock(data) : "" };
  }
  if (st.state === "other") return { ...base, result: "other", line };
  // A hook that follows the plugin, about to name this copy by its path: no session says this copy is the plugin.
  if (data === null && st.data !== null) return { ...base, result: "followsRecord", line, root: self };
  // The record first: a version it refuses leaves the hook as it was.
  const moved = data !== null && recordPluginRoot(data, self);
  const script = hookScript(written, data);
  // A hook that checks nothing (its mode lost in a copy or a chmod, its CLI moved) is written again, not called unchanged.
  if (st.state === "ennyn" && !moved && idleReason(st) === null && readFileSync(st.path, "utf8") === script) return { ...base, result: "unchanged", line, data };
  mkdirSync(resolve(st.path, ".."), { recursive: true });
  writeFileSync(st.path, script);
  chmodSync(st.path, 0o755);
  return { ...base, result: st.state === "ennyn" ? "updated" : "installed", line, data };
}
