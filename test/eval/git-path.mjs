/**
 * The git path: a folder put first on an eval's PATH so that git runs by name in the arms of `claude plugin eval`.
 *
 * Why (measured on macOS with 2.1.310, Homebrew git 2.56.0 and the Command Line Tools' 2.50.1): the eval tool's sandbox
 * denies reading git's credential helpers by their real path (`sandbox.credentials.files` of the run's settings), and
 * git-credential-store, -cache and -cache--daemon are links to the git binary itself (`../../bin/git`) in both, so both
 * git binaries are denied. The shell stats each PATH candidate before it runs one, the stat fails (EPERM), and it falls
 * to /usr/bin/git, the Xcode shim, whose own look-up of the Tools' git is denied the same way: exit 72. A git started by
 * its absolute path runs, but a push or fetch to a local remote still fails (exit 128): git starts git-receive-pack or
 * git-upload-pack by name through /bin/sh, and receive-pack starts git by name again, so naming receive-pack by its
 * path is not enough (measured in review).
 *
 * Each script here starts the real git by its absolute path. That adds nothing an arm cannot do itself: an arm can
 * write the same three scripts in its writable cwd and put that folder first on its own PATH (measured in review: the
 * commit and the push exit 0 and the push lands). Nor is the deny a protection the git path keeps: it blocks reads
 * only, and a helper started by its absolute path runs (eval-keychain-exec). The folder must be one the arms can read
 * and not write: the eval tool denies reads in
 * the temporary folders (/tmp, /private/tmp, TMPDIR), the HOME it is given and its own config and output, and lets the
 * arms read the plugin under test. What the git path does not change: an arm cannot write a `.git/config` or
 * `.git/hooks/` (the sandbox denies both), so `git init` and `git clone` of a work tree fail in an arm; a case's
 * repositories come from its scaffold, which runs outside the sandbox. No hook runs either (GIT_CONFIG_COUNT).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Each script of the git path: its name, and the git command it runs. */
export const WRAPPERS = /** @type {const} */ ([
  ["git", ""],
  ["git-receive-pack", "receive-pack"],
  ["git-upload-pack", "upload-pack"],
]);

/** A word for /bin/sh, single-quoted. @param {string} s */
export const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The git binary the first `git` on PATH runs: the `bin/git` beside the folder above its exec path (git's own layout,
 * <prefix>/libexec/git-core and <prefix>/bin), so the Xcode shim gives the Tools' git. It must print the same version
 * as `git` does. Asked with PATH alone by default, so no GIT_EXEC_PATH of the caller's moves the answer.
 * @param {string} path PATH @param {Record<string, string | undefined>} [env] @returns {string}
 */
export function realGit(path, env = { PATH: path }) {
  const run = (/** @type {string} */ file, /** @type {string[]} */ args) => execFileSync(file, args, { encoding: "utf8", env: { ...env, PATH: path }, timeout: 30_000, killSignal: "SIGKILL" }).trim();
  const execPath = run("git", ["--exec-path"]);
  if (!isAbsolute(execPath)) throw new Error(`git --exec-path printed ${JSON.stringify(execPath)}, no absolute path`);
  const git = join(dirname(dirname(execPath)), "bin", "git");
  if (!statSync(git, { throwIfNoEntry: false })?.isFile()) throw new Error(`no git at ${git} (git --exec-path: ${execPath})`);
  const [want, got] = [run("git", ["--version"]), run(git, ["--version"])];
  if (want !== got) throw new Error(`${git} is ${got}, git on PATH is ${want}`);
  return git;
}

/**
 * The git path written in `dir`, which must not exist yet: a script a name of WRAPPERS, each running `git` by its
 * absolute path. @param {string} dir @param {string} git an absolute path @returns {string} dir
 */
export function writeGitPath(dir, git) {
  if (!isAbsolute(git)) throw new Error(`git must be an absolute path, not ${JSON.stringify(git)}`);
  mkdirSync(dir);
  for (const [name, sub] of WRAPPERS) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nexec ${shq(git)}${sub ? ` ${sub}` : ""} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}
