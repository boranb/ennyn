import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readlinkSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitMaybe } from "../core/git.mjs";

// No names, paths or data of the projects that use Ennyn go into this repository (.claude/CLAUDE.md).
// The names are listed as SHA-256 digests, so this list does not name them either. EXACT holds a word
// that is ordinary in lower case, in the spellings that mean the project; FOLDED holds the other names in
// lower case and matches them in any case. One of those is an ordinary English word this repository does
// not use: when the test points at a word, reword it.
// To add one: node -e 'console.log(require("crypto").createHash("sha256").update("name").digest("hex"))'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXACT = new Set(["2bc5084013a95ce5594f8d93037e93e1bd661b5c61ac583ddf2fbb0bf59b1f50", "a6d24d2a929f55462c22be133cadf5fe00b4523c9fabe79f42be609a33a7843a"]);
const FOLDED = new Set([
  "95a24757aecd068e294bbd2df88af8bd013708cdf2e16028c2f67c166ed499ed",
  "3248f3d6fcb264860cafee58bc011ad8be8b1bd7b6ab05230bd37ea5c9568cfd",
  "dc59655e06691baafd1225faf1e2758fcb001cd2752d4ffcec4599e4642fbdb6",
  // made-up words, for the controls below
  "433c2a9842d736c0562080ceb58620096eb3846eee56557ff63dd275d12c92c6",
  "e7b4b7621a6844f25669d8dc097a5572c450f32d12c7b32784783ecb245543b0",
]);
// A home directory: /Users/<name> or /home/<name> (any characters but separators), C:\Users\ with any number of backslashes (prose, a JS string, JSON in a string).
const HOME = /(?<![\w.-])(\/(?:Users|home)\/[^\s/\\"'`<>]+|[A-Za-z]:\\+Users\\+[^\s\\"']+)/u;

/** @param {string} s */
const digest = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Denied names and home paths in a text: each word is checked whole and in its parts (name.md, name-server,
 * NAME_HOME), as written for EXACT and in lower case for FOLDED.
 * @param {string} text
 */
export function findings(text) {
  /** @type {string[]} */
  const out = [];
  for (const raw of text.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []) {
    const word = raw.replace(/[._-]+$/, "");
    const parts = word.split(/[._-]+/);
    // A Turkish suffix written without the apostrophe (Nameın): the ASCII run before it.
    const runs = parts.flatMap((p) => p.match(/[A-Za-z0-9]+/g) ?? []);
    for (const w of new Set([word, ...parts, ...runs])) {
      if (w && (EXACT.has(digest(w)) || FOLDED.has(digest(w.toLowerCase())))) out.push(`a project name (${w.length} characters)`);
    }
  }
  const home = HOME.exec(text);
  if (home) out.push(`a home path: ${home[1]}`);
  return out;
}

/**
 * Every place a name can enter a repository: file contents (binary ones too: a name is still readable there),
 * file paths, symlink targets and commit messages. Tracked and new files, not ignored ones.
 * @param {string} root
 */
export function scanRepo(root) {
  const files = git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }).split("\0").filter(Boolean);
  /** @type {string[]} */
  const bad = [];
  let read = 0;
  for (const f of files) {
    for (const what of findings(f)) bad.push(`path ${f}: ${what}`);
    let text;
    try {
      text = lstatSync(join(root, f)).isSymbolicLink() ? readlinkSync(join(root, f)) : readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    read++;
    for (const what of findings(text)) bad.push(`${f}: ${what}`);
  }
  const head = gitMaybe(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, absent: [1] });
  const log = head ? git(["log", "-z", "--format=%H%x00%B"], { cwd: root }).split("\0") : [];
  for (let i = 0; i + 1 < log.length; i += 2) for (const what of findings(log[i + 1])) bad.push(`commit ${log[i].replace(/^\n/, "").slice(0, 10)}: ${what}`);
  return { bad, read, commits: log.length / 2 };
}

test("hygiene: a name is found whole, as part of a word, in any case it is listed for; a home path in its usual forms", () => {
  const name = "Zor" + "blax";
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
  const name = "Zor" + "blax";
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.md"), `about ${name}\n`);
  writeFileSync(join(dir, "docs", `${name.toLowerCase()}-notes.md`), "plain\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from(`\0\0${name}\0`));
  symlinkSync("/" + "Users/someone/notes.md", join(dir, "link.md"));
  git(["add", "-A"], { cwd: dir });
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `docs: from ${name}`], { cwd: dir });
  const res = scanRepo(dir);
  assert.equal(res.bad.length, 5, res.bad.join("\n"));
});

test("hygiene: no file, path, symlink or commit message here names a project that uses Ennyn or holds a home path", () => {
  const res = scanRepo(ROOT);
  assert.ok(res.read > 50 && res.commits > 10, `read ${res.read} files and ${res.commits} commits: a scan that reads nothing finds nothing`);
  assert.deepEqual(res.bad, []);
});
