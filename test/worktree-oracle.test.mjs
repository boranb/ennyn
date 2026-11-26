/**
 * As a harness this showed that a scratch work tree's real folders read 48 patterns with none wrong, where samples of tracked paths gave 4 false ok.
 *
 * Does doctor's "agent worktrees" line say what git does with a worktree of a name it never asked about? Each cell is a
 * repository in some ignore state. Doctor is asked with no worktree yet; then git answers, by real linked worktrees of
 * NAMES: here, and in a fresh clone of HEAD, on no config of this machine, which is what every clone gets; then doctor is
 * asked again with those worktrees here. No cell holds an expected answer but the few git cannot give, so a new
 * pattern is one line:
 *
 * - git here lists a worktree: the line warns that it does, Listed or Tracked, once it is there. Before, HEAD's lists
 *   are the question, so it may still be ok (the line taken out and not committed).
 * - a clone lists one: never ok, and with this checkout silent it warns Local.
 * - both are silent: ok, before and after.
 *
 * Needs a git at GIT_FLOOR or newer: below it this fails, it does not skip. No shell.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_FLOOR, gitVersion, parseVersion, versionAtLeast } from "../plugin/core/git.mjs";
import { AGENT_WORKTREES, checkSetup } from "../plugin/setup/doctor.mjs";
import { ownHome } from "./own-home.mjs";

const { root: ROOT, home: HOME } = ownHome("en-worktree-oracle-");
const FOLDER = AGENT_WORKTREES.slice(0, -1);
/** Names the reader does not ask about, of the shapes its own names stand for: a word, two letters, a digit first. */
const NAMES = ["fix-login", "ab", "7-up"];
/** A folder a cell tracks or embeds, so the clone's new worktrees have their own names. */
const OLD = `${FOLDER}/old`;
const LINE = `${FOLDER}/\n`;

// Every commit carries its own identity: macOS derives one, a container does not.
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
// A clone's git reads no ignore file and no config of this machine: what a cell puts there is no clone's.
const NOTHING = join(ROOT, "nothing");
const NO_MACHINE = { ...ENV, HOME: NOTHING, XDG_CONFIG_HOME: NOTHING, GIT_CONFIG_GLOBAL: join(NOTHING, "config") };

/** @param {string} cwd @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
const git = (cwd, args, env = ENV) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
/** @param {string} dir @param {Record<string, string>} files */
function commit(dir, files) {
  put(dir, files);
  git(dir, ["add", "-f", ...Object.keys(files)]);
  git(dir, ["commit", "-q", "-m", "chore: lists"]);
}

/** A checkout with sources, whose commits leave no maintenance running: a worktree of it holds a real checkout. A cell copies it. */
const BASE = join(ROOT, "base");
mkdirSync(BASE);
git(BASE, ["init", "-q", "-b", "main"]);
git(BASE, ["config", "gc.auto", "0"]);
git(BASE, ["config", "maintenance.auto", "false"]);
commit(BASE, { "src/app.py": "print(1)\n", "src/a.ts": "export {}\n", "README.md": "# r\n", Makefile: "x:\n\ttrue\n" });

/** @param {string} dir @param {NodeJS.ProcessEnv} env */
function addWorktrees(dir, env) {
  mkdirSync(join(dir, FOLDER), { recursive: true });
  for (const name of NAMES) git(dir, ["worktree", "add", "-q", "--detach", `${FOLDER}/${name}`, "HEAD"], env);
}
/** What git says of the worktrees and of a folder a cell embedded, nothing else in the folder. @param {string} out */
const lines = (out) => out.split("\n").filter((l) => l.includes(OLD) || NAMES.some((n) => l.includes(`${FOLDER}/${n}/`)));

/** What a fresh clone of HEAD lists of new worktrees. @param {string} dir */
function cloneLists(dir) {
  const clone = mkdtempSync(join(ROOT, "clone-"));
  git(ROOT, ["clone", "-q", dir, clone], NO_MACHINE);
  addWorktrees(clone, NO_MACHINE);
  return lines(git(clone, ["status", "--porcelain", "-uall"], NO_MACHINE));
}

const OK = "ok worktreesIgnored";
/** A line of any name at the level that says all is well. @param {string} line */
const reassures = (line) => line.startsWith("ok ");
/** Doctor's one "agent worktrees" line: its level and its name. @param {string} dir */
async function read(dir) {
  const items = (await checkSetup({ cwd: dir, env: {} })).items.filter((i) => i.key.startsWith("doctor.worktrees"));
  assert.equal(items.length, 1, JSON.stringify(items));
  return `${items[0].level} ${items[0].key.slice("doctor.".length)}`;
}

/**
 * @typedef {{ id: string, setup: (dir: string) => void, expect?: string, noWorktree?: boolean, after?: () => void }} Cell
 *   `expect`: the reader's word where git gives none; `noWorktree`: the cell's own folder stands for one; `after`: undoes what `setup` left outside the repository
 */

/** What is wrong with doctor's two answers, by git's. @param {Cell} cell @returns {Promise<string[]>} */
async function judge(cell) {
  const dir = mkdtempSync(join(ROOT, "cell-"));
  cpSync(BASE, dir, { recursive: true });
  cell.setup(dir);
  const before = await read(dir);
  if (cell.expect) return before === cell.expect ? [] : [`${cell.id}: doctor says ${before}, not ${cell.expect}`];
  const clone = cloneLists(dir).length > 0;
  if (!cell.noWorktree) addWorktrees(dir, ENV);
  const here = [...lines(git(dir, ["status", "--porcelain", "-uall"])), ...lines(git(dir, ["add", "-A", "--dry-run"]))].length > 0;
  const after = await read(dir);
  const shown = `before ${before}, after ${after}; git lists here ${here}, in a clone ${clone}`;
  const out = [];
  if (reassures(before) && clone) out.push(`false ok: ${cell.id}: ${shown}`);
  if (reassures(after) && (here || clone)) out.push(`false ok with worktrees here: ${cell.id}: ${shown}`);
  if (here && !["warn worktreesListed", "warn worktreesTracked"].includes(after)) out.push(`git lists them here, doctor does not say so: ${cell.id}: ${shown}`);
  if (clone && !here && before !== "warn worktreesLocal") out.push(`only a clone lists them, doctor does not say it is this machine: ${cell.id}: ${shown}`);
  if (!here && !clone && (before !== OK || after !== OK)) out.push(`false warning: ${cell.id}: ${shown}`);
  return out;
}

const MACHINE_CONFIG = join(HOME, ".gitconfig");
const MACHINE = readFileSync(MACHINE_CONFIG, "utf8");

/** A list HEAD holds as `.gitignore`. @param {string} text */
const held = (text) => (/** @type {string} */ d) => commit(d, { ".gitignore": text });
/** @param {string} id @param {string} text @returns {Cell} */
const list = (id, text) => ({ id, setup: held(text) });

/** The folder, its parents and children, the other files a clone gets, and syntax git reads otherwise than the eye. @type {Cell[]} */
const FOLDER_CELLS = [
  { id: "no list", setup: () => {} },
  list("the folder", LINE),
  list("the folder, no slash", `${FOLDER}\n`),
  list("anchored", `/${LINE}`),
  list("its children", `${FOLDER}/*\n`),
  list("all below, **", `${FOLDER}/**\n`),
  list("its children, folders only", `${FOLDER}/*/\n`),
  list("the parent", ".claude/\n"),
  list("the parent's children, one kept", ".claude/*\n!.claude/settings.json\n"),
  list("the parent's children, the folder kept", `.claude/*\n!${LINE}`),
  list("the parent, a negation that cannot work", `.claude/\n!${LINE}`),
  list("any depth", `**/${LINE}`),
  list("the bare name", "worktrees/\n"),
  list("the bare name, no slash", "worktrees\n"),
  list("all dotfiles", ".*\n!.gitignore\n"),
  list("everything", "*\n!.gitignore\n!src/\n"),
  list("everything at the top", "/*\n!/.gitignore\n!/src/\n"),
  list("a negation of another file", "*.log\n!x\n"),
  list("its children, a name kept", `${FOLDER}/*\n!${FOLDER}/x/\n`),
  list("its children, keep kept", `${FOLDER}/*\n!${FOLDER}/keep/\n`),
  list("negated whole", `${FOLDER}/**\n!${FOLDER}/**\n`),
  list("an escaped bang", `\\!${LINE}`),
  list("a comment", `#${LINE}`),
  list("trailing spaces", `${FOLDER}/   \n`),
  list("CRLF", `${FOLDER}/\r\n`),
  list("a BOM", `\uFEFF${LINE}`),
  list("a trailing comment", `${FOLDER}/ # agents\n`),
  list("another case", ".Claude/Worktrees/\n"),
  { id: "in .claude/.gitignore", setup: (d) => commit(d, { ".claude/.gitignore": "worktrees/\n" }) },
  { id: "in the folder's own .gitignore", setup: (d) => commit(d, { [`${FOLDER}/.gitignore`]: "*\n" }) },
  { id: "the folder's own list, empty", setup: (d) => commit(d, { [`${FOLDER}/.gitignore`]: "" }) },
  { id: "the folder's own list negates the top's", setup: (d) => commit(d, { ".gitignore": LINE, [`${FOLDER}/.gitignore`]: "!*\n" }) },
  { id: "a kept file beside its children", setup: (d) => commit(d, { ".gitignore": `${FOLDER}/*\n!${FOLDER}/.gitkeep\n`, [`${FOLDER}/.gitkeep`]: "" }) },
];

/** What the folders hold, not the folders: git takes a worktree whole, so none of these ignores one. And patterns that hold some names, not every name. @type {Cell[]} */
const HOLDS_CELLS = [
  list("an allow list that keeps directories", "*\n!*/\n!*.py\n!*.ts\n!*.md\n"),
  list("an allow list by extension", "*\n!.gitignore\n!*/\n!*.py\n"),
  list("all files, directories kept", "*\n!*/\n"),
  list("by extension", "*.py\n*.ts\n*.md\nMakefile\n"),
  list("two levels down", `${FOLDER}/*/*\n`),
  list("two levels down, **", `${FOLDER}/*/**\n`),
  list("all below, **/*", `${FOLDER}/**/*\n`),
  list("one name", "x\n"),
  list("one character", "?\n"),
  list("letters first", `${FOLDER}/[a-z]*\n`),
  list("a prefix", "x*\n"),
  list("one name in the folder", `${FOLDER}/x\n`),
  list("agents' names only", `${FOLDER}/agent-*\n`),
  list("one branch's names", `${FOLDER}/feature-*\n`),
  list("names with a dash", `${FOLDER}/*-*\n`),
  list("any folder with a dash", "*-*/\n"),
  list("five letters or more", `${FOLDER}/?????*\n`),
  list("a tool's name", ".claude/**/x\n"),
];

/** HEAD holds the line, whatever this checkout did to the file; or only this machine or this checkout holds it. @type {Cell[]} */
const CHECKOUT_CELLS = [
  { id: "another list beside it, not committed", setup: (d) => (held(LINE)(d), put(d, { ".claude/.gitignore": "worktrees/\n" })) },
  { id: "the same line in info/exclude", setup: (d) => (held(LINE)(d), put(d, { ".git/info/exclude": `**/${LINE}` })) },
  { id: "another line, not staged", setup: (d) => (held(LINE)(d), appendFileSync(join(d, ".gitignore"), "*.tmp\n")) },
  { id: "the mode changed", setup: (d) => (held(LINE)(d), chmodSync(join(d, ".gitignore"), 0o755)) },
  { id: "off the disk, a sparse checkout", setup: (d) => (held(LINE)(d), git(d, ["update-index", "--skip-worktree", ".gitignore"]), rmSync(join(d, ".gitignore"))) },
  { id: "the line taken out, not committed", setup: (d) => (held(LINE)(d), writeFileSync(join(d, ".gitignore"), "\n")) },
  { id: "a .gitignore git does not track", setup: (d) => put(d, { ".gitignore": LINE }) },
  { id: "a new .gitignore, staged", setup: (d) => (put(d, { ".gitignore": LINE }), git(d, ["add", ".gitignore"])) },
  { id: "the line not staged", setup: (d) => (held("node_modules/\n")(d), appendFileSync(join(d, ".gitignore"), LINE)) },
  { id: "the line staged", setup: (d) => (held("node_modules/\n")(d), appendFileSync(join(d, ".gitignore"), LINE), git(d, ["add", ".gitignore"])) },
  { id: "assume-unchanged, the line only on the disk", setup: (d) => (held("*.log\n")(d), appendFileSync(join(d, ".gitignore"), LINE), git(d, ["update-index", "--assume-unchanged", ".gitignore"])) },
  { id: "skip-worktree, the line only on the disk", setup: (d) => (held("*.log\n")(d), git(d, ["update-index", "--skip-worktree", ".gitignore"]), appendFileSync(join(d, ".gitignore"), LINE)) },
  { id: "skip-worktree, the file replaced", setup: (d) => (held("*.log\n")(d), git(d, ["update-index", "--skip-worktree", ".gitignore"]), writeFileSync(join(d, ".gitignore"), LINE)) },
  { id: "a clean filter takes the line out of what is committed", setup: (d) => (commit(d, { ".gitignore": "*.log\n", ".gitattributes": ".gitignore filter=strip\n" }), git(d, ["config", "filter.strip.clean", "grep -v worktrees"]), appendFileSync(join(d, ".gitignore"), LINE)) },
  { id: "a tracked list, core.excludesFile", setup: (d) => (commit(d, { "tools/.gitignore": LINE }), git(d, ["config", "core.excludesFile", "tools/.gitignore"])) },
  { id: "a .gitignore that ignores itself", setup: (d) => put(d, { ".gitignore": `${LINE}.gitignore\n` }) },
  { id: "a .gitignore info/exclude ignores", setup: (d) => put(d, { ".gitignore": LINE, ".git/info/exclude": ".gitignore\n" }) },
  { id: "info/exclude", setup: (d) => put(d, { ".git/info/exclude": `**/${LINE}` }) },
  { id: "the machine's ignore file", setup: () => put(HOME, { ".config/git/ignore": LINE }), after: () => rmSync(join(HOME, ".config", "git"), { recursive: true, force: true }) },
  {
    id: "core.excludesFile in the machine's config",
    setup: () => (put(ROOT, { "machine-ignore": LINE }), appendFileSync(MACHINE_CONFIG, `[core]\n\texcludesFile = ${join(ROOT, "machine-ignore")}\n`)),
    after: () => writeFileSync(MACHINE_CONFIG, MACHINE),
  },
  { id: "the folder's list, * only on the disk", setup: (d) => (commit(d, { [`${FOLDER}/.gitignore`]: "# nothing\n" }), writeFileSync(join(d, FOLDER, ".gitignore"), "*\n")) },
  // Its target is spelled as the line: a reader that took a link's text for a list would read it as held.
  { id: "a .gitignore that is a link", setup: (d) => (symlinkSync(LINE.trim(), join(d, ".gitignore")), git(d, ["add", "."]), git(d, ["commit", "-q", "-m", "chore: lists"])) },
];

/** Git already holds something in the folder, and no ignore line undoes that; the last two are where git gives no answer to compare. @type {Cell[]} */
const HELD_CELLS = [
  { id: "a tracked file in a folder, changed", setup: (d) => (commit(d, { [`${OLD}/a.js`]: "1\n" }), held(LINE)(d), put(d, { [`${OLD}/a.js`]: "2\n" })) },
  {
    id: "an embedded worktree with new commits",
    noWorktree: true,
    setup: (d) => {
      git(d, ["worktree", "add", "-q", "--detach", OLD, "HEAD"]);
      git(d, ["add", "-A"]);
      git(d, ["commit", "-q", "-m", "chore: embed"]);
      held(LINE)(d);
      put(join(d, OLD), { "agent.txt": "1\n" });
      git(join(d, OLD), ["add", "-A"]);
      git(join(d, OLD), ["commit", "-q", "-m", "feat: agent work"]);
    },
  },
  { id: "a .gitignore one level down", expect: "warn worktreesTracked", setup: (d) => commit(d, { ".gitignore": LINE, [`${FOLDER}/feature-one/.gitignore`]: "*\n" }) },
  { id: ".claude is a link", expect: "unmeasured worktreesUnmeasured", setup: (d) => (mkdirSync(join(d, "real")), symlinkSync("real", join(d, ".claude"))) },
];

test("worktree oracle: the git this harness needs is here; one too old is a failure, never a skip", () => {
  const { text, version } = gitVersion({ cwd: ROOT });
  assert.ok(version !== null && versionAtLeast(version, /** @type {number[]} */ (parseVersion(GIT_FLOOR))), `needs git ${GIT_FLOOR} or newer: found ${text}`);
});

/** @param {Cell[]} cells */
async function agree(cells) {
  const out = [];
  for (const cell of cells) {
    try {
      out.push(...(await judge(cell)));
    } finally {
      cell.after?.();
    }
  }
  assert.deepEqual(out, []);
}

test("worktree oracle: for the folder, its parents and the lists a clone gets, the reader says what git does with worktrees of names it never asked about", () => agree(FOLDER_CELLS));
test("worktree oracle: a pattern for what a folder holds, or for some names, is no ok, though a folder with no .git would read as ignored", () => agree(HOLDS_CELLS));
test("worktree oracle: HEAD's lists are what counts, whatever this checkout and this machine do, and the reader says which of them it is", () => agree(CHECKOUT_CELLS));
test("worktree oracle: what git already holds in the folder is said, and no ignore line reads as undoing it", () => agree(HELD_CELLS));

test("worktree oracle: from a linked worktree doctor answers for the main checkout's HEAD, whose folder Claude Code uses, not for this checkout's", async () => {
  /** @param {(dir: string) => string} link the linked worktree, made from the main checkout */
  const inMain = async (link) => {
    const dir = mkdtempSync(join(ROOT, "cell-"));
    cpSync(BASE, dir, { recursive: true });
    const from = link(dir);
    const line = await read(from);
    addWorktrees(dir, ENV);
    return [line, lines(git(dir, ["status", "--porcelain", "-uall"])).length > 0];
  };
  // Its branch lacks the line, the main checkout's HEAD holds it.
  assert.deepEqual(
    await inMain((d) => {
      held(LINE)(d);
      git(d, ["worktree", "add", "-q", "--detach", `${d}-linked`, "HEAD~1"]);
      return `${d}-linked`;
    }),
    [OK, false],
  );
  // Its branch alone holds the line: the main checkout's next worktree is listed.
  const [line, listed] = await inMain((d) => {
    git(d, ["worktree", "add", "-q", "-b", "side", `${d}-linked`]);
    commit(`${d}-linked`, { ".gitignore": LINE });
    return `${d}-linked`;
  });
  assert.equal(listed, true);
  assert.notEqual(line, OK);
});

test("worktree oracle: run with a home outside the temporary folder it refuses, before any write", () => {
  const tmp = mkdtempSync(join(ROOT, "tmp-"));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test-name-pattern=^no such test$", fileURLToPath(import.meta.url)], { env: { ...env, HOME: join(sep, "no", "such", "home"), TMPDIR: tmp }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refuses to run: HOME/);
  assert.deepEqual(readdirSync(tmp), []);
});
