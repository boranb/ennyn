import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, lstatSync, readlinkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitMaybe } from "../plugin/core/git.mjs";
import { secretHits } from "../plugin/checks/secrets.mjs";
import { LITERALS_FILE, homeHits, literalEntry, literalHits, parseLiterals, readLiterals } from "../plugin/checks/private-text.mjs";
import { loadConfig } from "../plugin/core/config.mjs";
import { TOKENS } from "./secret-shapes.mjs";

// No names, paths or data of the projects that use Ennyn go into this repository (.claude/CLAUDE.md).
// The names this test refuses are not in it, not even as digests: a digest of a short word is reversed by trying
// a list of names. They are the clone's private word list in the state dir (security.privateText,
// checks/private-text.mjs), the list the commit-msg hook reads, shared by the main checkout and its worktrees. A
// word is added with `node scripts/ennyn.mjs private-text add`, one a line on stdin; `--exact` for a word that is
// ordinary in lower case, matched only as written. A clone with no list (a fresh clone, a container, CI) checks the
// made-up controls alone, and the repository test says so. When the test points at a word, reword it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A made-up name, written in parts so the scan below does not find it here. */
const NAME = "Zor" + "blax";
/** The controls' list: the made-up name, whole and with a hyphen, in any case. */
const CONTROLS = parseLiterals([NAME, "zor" + "-" + "blax"].map((w) => literalEntry(w, true)).join("\n"));

/**
 * The names a scan of `root` refuses: the made-up controls and the clone's private list. With no list, or one that
 * holds no word, `missing` says so; a list that is there and cannot be read, or holds a line that is no entry,
 * throws (readLiterals): unread is never an empty list.
 * @param {string} root
 * @returns {{ list: import("../plugin/checks/private-text.mjs").Literals, missing: string | null }}
 */
export function namesOf(root) {
  const config = loadConfig({ cwd: root, env: {} });
  const own = readLiterals(root, config);
  const where = `${config.paths.stateDir}/${LITERALS_FILE}`;
  const how = "add them with: node scripts/ennyn.mjs private-text add [--exact], one a line on stdin";
  if (!own) return { list: CONTROLS, missing: `no private word list in this clone (${where}): no project name was checked, only the made-up controls; ${how}` };
  const list = {
    exact: new Set([...CONTROLS.exact, ...own.exact]),
    folded: new Set([...CONTROLS.folded, ...own.folded]),
    ...(own.lengths && CONTROLS.lengths ? { lengths: new Set([...CONTROLS.lengths, ...own.lengths]) } : {}),
  };
  return { list, missing: own.exact.size + own.folded.size ? null : `the private word list (${where}) holds no word: no project name was checked; ${how}` };
}

/**
 * Denied names and home paths in a text, as the commit-msg hook's private-text gate reads them (checks/private-text.mjs):
 * each word whole, in its parts (name.md, name-server, NAME_HOME) and its ASCII runs (a Turkish suffix written without
 * the apostrophe), as written for an exact entry and in lower case for a folded one; a home directory, /Users/<name> or
 * /home/<name>, C:\Users\ with any number of backslashes (prose, a JS string, JSON in a string).
 * @param {string} text @param {import("../plugin/checks/private-text.mjs").Literals} [list] the names, the controls by default
 */
export function findings(text, list = CONTROLS) {
  /** @type {string[]} */
  const out = [];
  for (const hit of literalHits(text, list)) out.push(`a project name (${hit.length} characters)`);
  const home = homeHits(text)[0];
  if (home) out.push(`a home path: ${text.slice(home.at, home.end)}`);
  return out;
}

/**
 * Every place a name can enter a repository: file contents (binary ones too: a name is still readable there),
 * file paths, symlink targets and commit messages. Tracked and new files, not ignored ones. The names are
 * `namesOf(root)`: `missing` says when no project name was checked.
 * @param {string} root
 */
export function scanRepo(root) {
  const { list, missing } = namesOf(root);
  const files = git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }).split("\0").filter(Boolean);
  /** @type {string[]} */
  const bad = [];
  /** @type {string[]} */
  const seen = [];
  for (const f of files) {
    for (const what of findings(f, list)) bad.push(`path ${f}: ${what}`);
    let text;
    try {
      text = lstatSync(join(root, f)).isSymbolicLink() ? readlinkSync(join(root, f)) : readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    seen.push(f);
    for (const what of findings(text, list)) bad.push(`${f}: ${what}`);
  }
  const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, absent: [1] });
  const log = head ? git(["log", "-z", "--format=%H%x00%B"], { cwd: root }).split("\0") : [];
  for (let i = 0; i + 1 < log.length; i += 2) for (const what of findings(log[i + 1], list)) bad.push(`commit ${log[i].replace(/^\n/, "").slice(0, 10)}: ${what}`);
  return { bad, read: seen.length, seen, commits: log.length / 2, missing };
}

test("hygiene: a name is found whole, as part of a word, in any case it is listed for; a home path in its usual forms", () => {
  const name = NAME;
  for (const s of [`see ${name}.`, `${name}.md`, `${name}-server`, `${name.toUpperCase()}_HOME`, `the ${name}'in notes`, `${name}ın raporu`, `https://x.io/${name.toLowerCase()}/a`]) {
    assert.equal(findings(s).length, 1, s);
  }
  // A name with a hyphen is checked whole, also at the end of a sentence.
  assert.equal(findings(`see ${"zor"}-${"blax"}.`).length, 1);
  assert.deepEqual(findings("zorblaxes and blax"), [], "a longer word is not the name");
  const u = "/" + "Users";
  for (const s of [`${u}/someone`, `file://${u}/someone/x`, `>${u}/a/b`, `cd /` + `home/dev/app`, `${u}/ömer/x`, "C:" + "\\" + "Users" + "\\" + "dev", "C:" + "\\\\" + "Users" + "\\\\" + "dev", `"C:` + "\\\\\\\\" + "Users" + "\\\\\\\\" + `dev"`]) {
    assert.equal(findings(s).length, 1, s);
  }
  assert.deepEqual(findings("tmpdir() and /opt/tool and ~/notes and /usr/local and /Users alone"), []);
});

test("hygiene: the repository scan finds a name in a file, a path, a symlink target and a commit message", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-hygiene-"));
  const name = NAME;
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.md"), `about ${name}\n`);
  writeFileSync(join(dir, "docs", `${name.toLowerCase()}-notes.md`), "plain\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from(`\0\0${name}\0`));
  // An image made of text, as the README's demo is: what it shows is read like any other file.
  writeFileSync(join(dir, "shot.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">~/${name.toLowerCase()} $ ennyn core</text></svg>\n`);
  symlinkSync("/" + "Users/someone/notes.md", join(dir, "link.md"));
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `docs: from ${name}`], { cwd: dir });
  const res = scanRepo(dir);
  assert.equal(res.bad.length, 6, res.bad.join("\n"));
  assert.ok(res.bad.includes("shot.svg: a project name (7 characters)"), res.bad.join("\n"));
});

/**
 * The repository test on `root`: no name, no home path, a scan that read something, and a line through `t` when no
 * project name was checked (a clone with no list passes, and must not read as one that checked the names).
 * @param {{ diagnostic: (s: string) => void }} t @param {string} root
 */
export function repoCheck(t, root) {
  const res = scanRepo(root);
  if (res.missing) t.diagnostic(res.missing);
  assert.ok(res.read > 50 && res.commits > 10, `read ${res.read} files and ${res.commits} commits: a scan that reads nothing finds nothing`);
  assert.deepEqual(res.bad, []);
  return res;
}

test("hygiene: no file, path, symlink or commit message here names a project that uses Ennyn or holds a home path", (t) => {
  const res = repoCheck(t, ROOT);
  // The README's demo is an image a script writes from a sample project: the scan reads its text too.
  assert.ok(res.seen.includes("docs/assets/demo.svg"), "the demo image was not read");
});

test("hygiene: the repository check says so when the clone has no list, and says nothing when it has one", () => {
  const repo = mkdtempSync(join(tmpdir(), "en-hygiene-say-"));
  git(["init", "-q", "-b", "main"], { cwd: repo });
  for (let i = 0; i < 51; i++) writeFileSync(join(repo, `f${i}.md`), "plain\n");
  git(["add", "-A"], { cwd: repo });
  for (let i = 0; i < 11; i++) git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", `docs: note ${i}`], { cwd: repo });
  /** @type {string[]} */
  const said = [];
  repoCheck({ diagnostic: (s) => said.push(s) }, repo);
  assert.equal(said.length, 1);
  assert.match(said[0], /^no private word list in this clone .*: no project name was checked/);
  mkdirSync(join(repo, ".git", "ennyn"));
  writeFileSync(join(repo, ".git", "ennyn", LITERALS_FILE), `${literalEntry("Quel" + "varin", true)}\n`);
  said.length = 0;
  repoCheck({ diagnostic: (s) => said.push(s) }, repo);
  assert.deepEqual(said, []);
});

test("hygiene: the scan reads the clone's private word list, shared with its worktrees, says when there is none and fails on one it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-hygiene-list-"));
  const repo = join(dir, "repo");
  // A made-up name only the list holds, of a length no control has, beside the controls' own.
  const other = "Quel" + "varin";
  /** What a scan found, a commit named without its hash. @param {string} at */
  const found = (at) => {
    const res = scanRepo(at);
    return { bad: res.bad.map((b) => b.replace(/^commit [0-9a-f]+:/, "commit:")).sort(), missing: res.missing };
  };
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "a.md"), `about ${other} and ${NAME}\n`);
  writeFileSync(join(repo, `notes-${other.toLowerCase()}.md`), "plain\n");
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `docs: about ${other}`], { cwd: repo });
  const controls = ["a.md: a project name (7 characters)"];
  const all = ["a.md: a project name (7 characters)", "a.md: a project name (9 characters)", "commit: a project name (9 characters)", `path notes-${other.toLowerCase()}.md: a project name (9 characters)`];
  let res = found(repo);
  assert.deepEqual(res.bad, controls, "with no list, the controls alone");
  assert.match(String(res.missing), /^no private word list in this clone \(\.git\/ennyn\/private-literals\): no project name was checked.*private-text add/);
  const state = join(repo, ".git", "ennyn");
  const file = join(state, LITERALS_FILE);
  mkdirSync(state);
  // As `ennyn private-text add` writes it.
  writeFileSync(file, `${literalEntry(other, true)}\n`);
  res = found(repo);
  assert.deepEqual(res.bad, all);
  assert.equal(res.missing, null);
  // A worktree reads the list of the clone it belongs to.
  git(["worktree", "add", "-q", join(dir, "wt")], { cwd: repo });
  assert.deepEqual(found(join(dir, "wt")).bad, all);
  // An entry with no length (as those taken over from an older list) is found whatever the controls' lengths.
  writeFileSync(file, `${literalEntry(other, true).replace(/ \d+ /, " ")}\n`);
  assert.deepEqual(found(repo).bad, all);
  // An exact entry is found only as written.
  writeFileSync(file, `${literalEntry(other.toLowerCase(), false)}\n`);
  assert.deepEqual(found(repo).bad, [...controls, `path notes-${other.toLowerCase()}.md: a project name (9 characters)`]);
  writeFileSync(file, `${literalEntry(other, false)}\n`);
  assert.deepEqual(found(repo).bad, all.slice(0, 3));
  writeFileSync(file, "# no word yet\n");
  res = found(repo);
  assert.deepEqual(res.bad, controls);
  assert.match(String(res.missing), /holds no word: no project name was checked/);
  // A list that is there and is not read is no empty list.
  writeFileSync(file, `${literalEntry(other, true)}\nnot an entry\n`);
  assert.throws(() => scanRepo(repo), /line 2 is not/);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => scanRepo(repo), /private-literals/);
});

/**
 * Every line of every file `scanRepo` reads, as the commit-msg hook reads an added line: its UTF-8 text, and
 * its bytes when it holds a NUL or is not UTF-8.
 * @param {string} root
 */
export function repoLines(root) {
  const files = git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }).split("\0").filter(Boolean);
  /** @type {Map<string, import("../plugin/core/git.mjs").AddedLine[]>} */
  const out = new Map();
  for (const f of files) {
    let bytes;
    try {
      bytes = lstatSync(join(root, f)).isSymbolicLink() ? Buffer.from(readlinkSync(join(root, f))) : readFileSync(join(root, f));
    } catch {
      continue;
    }
    /** @type {import("../plugin/core/git.mjs").AddedLine[]} */
    const lines = [];
    for (let at = 0, n = 1; at <= bytes.length; n++) {
      let end = bytes.indexOf(0x0a, at);
      if (end === -1) end = bytes.length;
      const raw = bytes.subarray(at, end);
      const text = raw.toString("utf8");
      lines.push(raw.includes(0) || Buffer.from(text, "utf8").compare(raw) !== 0 ? { line: n, text, raw: Buffer.from(raw) } : { line: n, text });
      at = end + 1;
    }
    out.set(f, lines);
  }
  return out;
}

test("hygiene: no tracked file holds a secret shape the commit-msg hook refuses, with no except", () => {
  // A control first: a scan that finds nothing proves nothing.
  assert.equal(secretHits(new Map([["control", [{ line: 1, text: `t = ${TOKENS.github}` }]]])).length, 1);
  const lines = repoLines(ROOT);
  assert.ok(lines.size > 50, `read ${lines.size} files: a scan that reads nothing finds nothing`);
  assert.deepEqual(secretHits(lines).map((h) => `${h.path}:${h.line} ${h.shown}`), []);
});
