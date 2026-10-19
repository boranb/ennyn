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

import { readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { git } from "../core/git.mjs";

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

/** @param {string} path */
function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @returns {{ path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, state: "none" | "ennyn" | "wired" | "other" }}
 *   "wired": a hook Ennyn did not write that already runs commit-check (a project's own tracked hook,
 *   or husky's .husky/commit-msg behind its generated .husky/_ stubs).
 *   hooksKind: where core.hooksPath points: inside the repository ("repo", usually tracked), husky's
 *   stub directory ("husky"), or outside it ("global", every repository on this machine).
 */
export function hookStatus(cwd) {
  const hooksPath = git(["config", "--get", "core.hooksPath"], { cwd, allowFail: true }) || null;
  const dir = resolve(cwd, git(["rev-parse", "--git-path", "hooks"], { cwd }));
  const path = join(dir, "commit-msg");
  const text = readOrNull(path);
  /** @type {"repo" | "husky" | "global" | null} */
  let hooksKind = null;
  if (hooksPath) {
    const top = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true }) || cwd;
    // Both sides as real paths: git prints the real top level, while dir came through cwd (a link, /var → /private/var).
    const rel = relative(real(top), real(dir));
    hooksKind = rel.startsWith("..") || isAbsolute(rel) ? "global" : basename(dir) === "_" && basename(dirname(dir)) === ".husky" ? "husky" : "repo";
  }
  // husky v9: .husky/_/commit-msg is a generated stub that runs .husky/commit-msg.
  const userHook = hooksKind === "husky" ? readOrNull(join(dirname(dir), "commit-msg")) : null;
  const state =
    text !== null && text.includes(HOOK_MARKER)
      ? "ennyn"
      : [text, userHook].some((t) => t !== null && /commit-check/.test(t))
        ? "wired"
        : text === null && userHook === null
          ? "none"
          : "other";
  return { path, hooksPath, hooksKind, state };
}

/**
 * @param {{ cwd: string, cliPath: string }} opts
 * @returns {{ result: "installed" | "updated" | "unchanged" | "wired" | "other" | "hooksPath", path: string, hooksPath: string | null, hooksKind: "repo" | "husky" | "global" | null, line: string }}
 *   `line`: what to add to a hook Ennyn does not write (shell-quoted).
 */
export function installHook({ cwd, cliPath }) {
  const st = hookStatus(cwd);
  const base = { path: st.path, hooksPath: st.hooksPath, hooksKind: st.hooksKind, line: hookLine(cliPath) };
  if (st.state === "wired") return { result: "wired", ...base };
  // A hooks path is someone else's arrangement: a tracked directory, husky's stubs, or a global directory
  // for every repository. Ennyn writes into none of them; the message says what to add where.
  if (st.hooksPath) return { result: "hooksPath", ...base };
  if (st.state === "other") return { result: "other", ...base };
  const script = hookScript(cliPath);
  if (st.state === "ennyn" && readFileSync(st.path, "utf8") === script) return { result: "unchanged", ...base };
  mkdirSync(resolve(st.path, ".."), { recursive: true });
  writeFileSync(st.path, script);
  chmodSync(st.path, 0o755);
  return { result: st.state === "ennyn" ? "updated" : "installed", ...base };
}
