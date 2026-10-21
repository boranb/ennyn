/**
 * Imported by test/hermetic.mjs before that module's own code runs, it stands in for the machine of
 * a user whose setup once broke a test. The user config, the XDG and system config, the ignore and
 * attributes files and GIT_* variables each hold a value that did (signing, verbose commits, a global
 * ignore of "*", hooks that reject every commit, another comment marker, signatures and colour in the
 * log, a GIT_DIR leaked from a hook), and the time zone and locale are far from UTC and English.
 * test/hermetic.mjs must clear all of it: a test that still reads the user's setup fails on every run,
 * not on someone else's machine.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * @param {string} root an empty directory
 * @returns {Record<string, string>} the environment that points git and Ennyn at it
 */
export function hostileHome(root) {
  const reject = (/** @type {string} */ dir) => {
    mkdirSync(dir, { recursive: true });
    for (const name of ["pre-commit", "commit-msg"]) {
      writeFileSync(join(dir, name), "#!/bin/sh\necho hostile hook >&2\nexit 1\n");
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  };
  writeFileSync(join(root, "ignore"), "*\n");
  writeFileSync(join(root, "template"), "hostile template line\n");
  const config = [
    "[user]\n\tuseConfigOnly = true",
    `[commit]\n\tgpgsign = true\n\tverbose = true\n\tcleanup = verbatim\n\tstatus = false\n\ttemplate = ${join(root, "template")}`,
    "[gpg]\n\tprogram = false",
    `[core]\n\tcommentChar = ";"\n\thooksPath = ${reject(join(root, "hooks"))}\n\texcludesFile = ${join(root, "ignore")}\n\tautocrlf = true\n\tquotePath = false\n\tabbrev = 4`,
    `[init]\n\tdefaultBranch = trunk\n\ttemplateDir = ${dirname(reject(join(root, "template-dir", "hooks")))}`,
    "[log]\n\tshowSignature = true\n\tdecorate = full\n\tdate = relative\n\tabbrevCommit = true",
    "[format]\n\tpretty = oneline",
    "[color]\n\tui = always",
    "[diff]\n\tnoprefix = true\n\trenames = copies\n\tcontext = 9",
    "[status]\n\tshowUntrackedFiles = no",
    "[i18n]\n\tcommitEncoding = ISO-8859-1",
    `[blame]\n\tignoreRevsFile = ${join(root, "missing-revs")}`,
    "[grep]\n\tlineNumber = true\n\tpatternType = perl",
  ].join("\n") + "\n";
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  for (const dir of [join(home, ".config", "git"), join(xdg, "git")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config"), config);
    writeFileSync(join(dir, "ignore"), "*\n");
    writeFileSync(join(dir, "attributes"), "* -text\n");
  }
  writeFileSync(join(home, ".gitconfig"), config);
  writeFileSync(join(root, "system"), config);
  writeFileSync(join(root, "ennyn.json"), `{ "language": "tr", "commitMsg": { "types": ["x"] } }\n`);
  // A leaked GIT_DIR names a repository that exists, so a git call that obeys it succeeds in the wrong place.
  const other = join(root, "other");
  mkdirSync(other);
  // Named on the command line: a GIT_DIR in the environment that runs the tests would win over a plain path.
  spawnSync("git", ["--git-dir", join(other, ".git"), "--work-tree", other, "init", "-q"]);
  mkdirSync(join(other, "tmp"));
  return {
    ENNYN_HOSTILE_HOME: root,
    // Temporary directories inside a repository: a test of "outside a repository" finds one.
    TMPDIR: join(other, "tmp"),
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_SYSTEM: join(root, "system"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_PARAMETERS: "'commit.gpgsign'='true'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.commentChar",
    GIT_CONFIG_VALUE_0: ";",
    GIT_DIR: join(other, ".git"),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: join(other, ".git", "index"),
    GIT_EDITOR: "false",
    GIT_TEMPLATE_DIR: join(root, "template-dir"),
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00",
    ENNYN_CONFIG: join(root, "ennyn.json"),
    TZ: "Pacific/Kiritimati",
    LANG: "tr_TR.UTF-8",
    LC_ALL: "tr_TR.UTF-8",
  };
}

Object.assign(process.env, hostileHome(mkdtempSync(join(tmpdir(), "en-hostile-"))));
