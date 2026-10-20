import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { checkCommitShape, storedMessage, gitCuts, commentMarker, hookCommitMode } from "../checks/commit-shape.mjs";
import { git } from "../core/git.mjs";

const cfg = (override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "pl-cs-")), env: {}, override });

test("subject: at the limit passes, one over fails", () => {
  const c = cfg({ commitMsg: { subjectMax: 10 } });
  assert.ok(checkCommitShape("a".repeat(10), { config: c }).ok);
  const r = checkCommitShape("a".repeat(11), { config: c });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /11 characters; the limit is 10/);
});

test("subject length counts characters, not UTF-16 units or bytes", () => {
  const c = cfg({ commitMsg: { subjectMax: 5 } });
  assert.ok(checkCommitShape("çğışü", { config: c }).ok);
  assert.ok(checkCommitShape("🙂🙂🙂🙂🙂", { config: c }).ok);
});

test("body: prose lines and chars are limited; structured lines and trailers are not counted", () => {
  const c = cfg({ commitMsg: { bodyMaxLines: 2, bodyMaxChars: 40 } });
  const ok = [
    "subject",
    "",
    "line one",
    "line two",
    "Root cause: " + "x".repeat(100),
    "Review-Rounds: 1",
    "Impact: S1 3 readers",
    "",
    "Signed-off-by: a <a@a>",
    "Co-authored-by: b <b@b>",
  ].join("\n");
  assert.deepEqual(checkCommitShape(ok, { config: c }).errors, []);
  const tooMany = "subject\n\na\nb\nc";
  assert.match(checkCommitShape(tooMany, { config: c }).errors[0], /3 prose lines; the limit is 2/);
  const tooLong = "subject\n\n" + "y".repeat(41);
  assert.match(checkCommitShape(tooLong, { config: c }).errors[0], /41 characters; the limit is 40/);
});

test("structured line has its own limit", () => {
  const c = cfg({ commitMsg: { structuredLineMax: 20 } });
  const r = checkCommitShape("s\n\nRoot cause: " + "x".repeat(20), { config: c });
  assert.match(r.errors.join(), /"Root cause:" line is 32 characters; the limit is 20/);
});

test("git comment lines are ignored", () => {
  const c = cfg({ commitMsg: { bodyMaxLines: 1 } });
  assert.ok(checkCommitShape("s\n\none\n# Please enter the commit message\n# Changes to be committed:", { config: c }).ok);
});

test("review rounds: integer required, above max needs a third-round signal with a reason", () => {
  const c = cfg();
  assert.ok(checkCommitShape("s\n\nReview-Rounds: 2", { config: c }).ok);
  assert.match(checkCommitShape("s\n\nReview-Rounds: two", { config: c }).errors[0], /whole number/);
  assert.match(checkCommitShape("s\n\nReview-Rounds: 3", { config: c }).errors[0], /exceed the limit of 2/);
  assert.match(checkCommitShape("s\n\nReview-Rounds: 3\nThird-round: test", { config: c }).errors[0], /exceed/);
  assert.ok(checkCommitShape("s\n\nReview-Rounds: 3\nThird-round: mutation — 4 survivors in new branch", { config: c }).ok);
});

test("impact line required only when staged paths match the globs", () => {
  const c = cfg({ review: { impactRequiredGlobs: ["server/src/lib/auth*/**", "src/lib/engine/**"] } });
  assert.ok(checkCommitShape("s", { config: c, stagedPaths: ["docs/a.md"] }).ok);
  const r = checkCommitShape("s", { config: c, stagedPaths: ["src/lib/engine/q.ts"] });
  assert.match(r.errors[0], /impact table \(src\/lib\/engine\/q\.ts\)/);
  assert.ok(checkCommitShape("s\n\nImpact: not needed — rename only", { config: c, stagedPaths: ["src/lib/engine/q.ts"] }).ok);
});

test("skip subjects and the allow marker (reason required)", () => {
  const c = cfg({ commitMsg: { subjectMax: 5 } });
  assert.ok(checkCommitShape("Merge branch 'x' into main", { config: c }).ok);
  assert.ok(checkCommitShape("very long subject [commit-shape-allow: imported upstream message]", { config: c }).ok);
  assert.match(checkCommitShape("very long subject [commit-shape-allow: x]", { config: c }).errors[0], /needs a reason/);
});

test("output language follows config", () => {
  const c = cfg({ language: "tr", commitMsg: { subjectMax: 3 } });
  assert.match(checkCommitShape("abcd", { config: c }).errors[0], /Konu satırı 4 karakter; sınır 3/);
});

test("Turkish line labels via config", () => {
  const c = cfg({ language: "tr", review: { roundsLine: "Tur:", thirdRoundLine: "Üçüncü tur:", impactLine: "Etki:" } });
  assert.ok(checkCommitShape("s\n\nTur: 2\nEtki: S1 4 okuyan", { config: c }).ok);
  assert.match(checkCommitShape("s\n\nTur: 3", { config: c }).errors[0], /Üçüncü tur:/);
});

test("cleanup: with -m / -F git keeps `#` lines, so they count; with the editor they are dropped", () => {
  const c = cfg({ commitMsg: { bodyMaxLines: 2 } });
  const msg = "s\n\none\n# hidden 1\n# hidden 2\n# hidden 3";
  assert.ok(checkCommitShape(msg, { config: c, cleanup: "strip" }).ok);
  assert.match(checkCommitShape(msg, { config: c, cleanup: "whitespace" }).errors[0], /4 prose lines/);
});

test("cleanup: a scissors line ends the message only in editor mode; with -m / -F git stores what follows it", () => {
  const c = cfg({ commitMsg: { bodyMaxLines: 1 } });
  const msg = "s\n\none\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+a\n+b";
  assert.ok(checkCommitShape(msg, { config: c, cleanup: "strip" }).ok);
  const kept = checkCommitShape(msg, { config: c, cleanup: "whitespace" });
  assert.equal(kept.ok, false, "with -m / -F the scissors line and the lines below it land in history");
  assert.match(kept.errors[0], /5 prose lines/);
});

test("cleanup: a whitespace-only line still separates the trailer paragraph, as in the stored message", () => {
  const c = cfg({ commitMsg: { bodyMaxLines: 1 } });
  const msg = "s\n\none  \n   \nSigned-off-by: a <a@a>\nAcked-by: b <b@b>\n";
  assert.deepEqual(checkCommitShape(msg, { config: c, cleanup: "whitespace" }).errors, []);
});

test("impact: a change touching only tests next to a guarded path needs no impact line", () => {
  const c = cfg({ review: { impactRequiredGlobs: ["src/auth/**"] } });
  assert.ok(checkCommitShape("s", { config: c, stagedPaths: ["src/auth/login.test.ts"] }).ok);
  assert.equal(checkCommitShape("s", { config: c, stagedPaths: ["src/auth/login.ts", "src/auth/login.test.ts"] }).ok, false);
});

test("types: with commitMsg.types set, the subject must start with one; scope and ! are allowed", () => {
  const c = cfg({ commitMsg: { types: ["özellik", "düzeltme", "belge"], fixType: "düzeltme" } });
  for (const ok of ["düzeltme: liste boş kalıyordu", "özellik(grafik): eksen", "belge!: yeni biçim"]) assert.deepEqual(checkCommitShape(ok, { config: c }).errors, [], ok);
  for (const bad of ["fix: liste", "düzeltme liste", "düzeltme:liste", "Düzeltme: liste", "düzeltmeler: liste", "liste düzeltildi"]) {
    const r = checkCommitShape(bad, { config: c });
    assert.equal(r.ok, false, bad);
    assert.match(r.errors.join(), /commitMsg\.types \(özellik, düzeltme, belge\)/);
  }
  // Merge / Revert subjects and the allow marker still pass.
  assert.ok(checkCommitShape("Merge branch 'x'", { config: c }).ok);
  assert.ok(checkCommitShape("liste [commit-shape-allow: imported history]", { config: c }).ok);
  // No types: any subject.
  assert.ok(checkCommitShape("liste düzeltildi", { config: cfg() }).ok);
});

test("audit: subjects git writes itself pass a typed convention; an empty message is left to git; spaces after the colon are free", () => {
  const c = cfg({ commitMsg: { types: ["feat", "fix"], style: "terse" } });
  // A fixup! (and an empty squash!) disappears in autosquash; it is not checked.
  for (const s of ["fixup! feat: a page", "squash! feat: a page"]) {
    assert.deepEqual(checkCommitShape(s, { config: c }), { ok: true, errors: [], skipped: "subject" }, s);
  }
  // amend! and squash! carry text into history, folded in without the hook: that text is checked now.
  assert.ok(checkCommitShape("amend! feat: a page\n\nfeat: a better page", { config: c }).ok, "amend!: the body is the new message");
  assert.equal(checkCommitShape("amend! feat: a page\n\na better page", { config: c }).ok, false, "untyped new message");
  assert.match(checkCommitShape("amend! feat: a page\n\nfeat: a better page\n\nwhy it changed", { config: c }).errors.join(), /terse/);
  assert.match(checkCommitShape("squash! feat: a page\n\nwhy it changed", { config: c }).errors.join(), /terse/);
  assert.ok(checkCommitShape("squash! feat: a page\n\nMutation: first 1/1 · last 1/1", { config: c }).ok, "structured lines may be added");
  assert.equal(checkCommitShape("fixups: not git's", { config: c }).ok, false);
  assert.equal(checkCommitShape("fixup!feat: no space", { config: c }).ok, false);
  // Only comments in editor mode: an empty stored message, which git aborts with its own message.
  assert.deepEqual(checkCommitShape("# Please enter the commit message\n#\n", { config: c }), { ok: true, errors: [], skipped: "empty" });
  assert.deepEqual(checkCommitShape("   \n\n", { config: c }), { ok: true, errors: [], skipped: "empty" });
  // With -m a "#" line is kept, so this is not empty.
  assert.equal(checkCommitShape("# not a comment with -m", { config: c, cleanup: "whitespace" }).ok, false);
  assert.ok(checkCommitShape("feat:  two spaces", { config: c }).ok);
  assert.equal(checkCommitShape("feat:no space", { config: c }).ok, false);
});

test("cleanup: git's comment marker is core.commentChar, not always #", () => {
  assert.equal(storedMessage("feat: x\n; Please enter the commit message\n# kept with ;\n", "strip", ";"), "feat: x\n# kept with ;");
  assert.equal(storedMessage("feat: x\n; ------------------------ >8 ------------------------\ndiff --git a b\n", "strip", ";"), "feat: x");
  assert.equal(storedMessage("feat: x\n// two-char marker\n", "strip", "//"), "feat: x");
  const c = cfg({ commitMsg: { types: ["feat", "fix"], style: "terse" } });
  const template = "feat: x\n\n; Please enter the commit message for your changes.\n; On branch main\n; Changes to be committed:\n;\tmodified: a.txt\n";
  assert.deepEqual(checkCommitShape(template, { config: c, comment: ";" }).errors, []);
  assert.equal(checkCommitShape(template, { config: c }).ok, false, "read with # the template is prose");
});

test("cleanup: commit.cleanup verbatim stores the message as given; scissors cuts at the scissors line but keeps # lines", () => {
  const msg = "feat: x  \n\n# kept as text\n\n\n# ------------------------ >8 ------------------------\ndiff --git a b\n";
  assert.equal(storedMessage(msg, "verbatim"), msg);
  assert.equal(storedMessage(msg, "scissors"), "feat: x\n\n# kept as text");
  assert.equal(storedMessage(msg, "whitespace"), "feat: x\n\n# kept as text\n\n# ------------------------ >8 ------------------------\ndiff --git a b");
  assert.equal(storedMessage(msg, "strip"), "feat: x");
});

test("cleanup: git cuts only at its own scissors line, only with -v or in the scissors mode; a line typed by hand stays", () => {
  const LINE = "# ------------------------ >8 ------------------------";
  const typed = `feat: x\n\n${LINE}\nprose under the line\n`;
  const verbose = `feat: x\n\n${LINE}\n# Do not modify or remove the line above.\ndiff --git a/f b/f\n`;
  const submodule = `feat: x\n\n${LINE}\n# Everything below it will be ignored.\nSubmodule sub 1e7be83..d7cd6ab:\n`;
  const editor = { editor: true };
  // Without -v git keeps a hand-typed line and the prose under it, in every mode.
  for (const cleanup of /** @type {const} */ (["strip", "whitespace", "verbatim"])) assert.equal(gitCuts(typed, { cleanup, ...editor }), false, cleanup);
  assert.equal(storedMessage(typed, "strip"), "feat: x\n\nprose under the line");
  // git commit -v: its diff (or a submodule summary) follows the line; the scissors mode cuts anyway; commit.verbose cuts -m too.
  assert.deepEqual([gitCuts(verbose, { cleanup: "whitespace", ...editor }), gitCuts(submodule, { cleanup: "strip", ...editor })], [true, true]);
  // The scissors mode cuts only an edited message: with -m git uses whitespace.
  assert.deepEqual([gitCuts(typed, { cleanup: "scissors", ...editor }), gitCuts(typed, { cleanup: "scissors", editor: false })], [true, false]);
  assert.deepEqual([gitCuts(verbose, { cleanup: "whitespace", editor: false }), gitCuts(typed, { cleanup: "whitespace", editor: false, verbose: true })], [false, true]);
  // Only the exact line: 24 dashes on each side, then a line end (not CRLF, not the end of the text).
  for (const near of [verbose.replace("------------------------ >8", "---- >8"), verbose.replace(/>8 -+\n/, ">8 ---\r\n"), `feat: x\n${LINE}`]) {
    assert.equal(gitCuts(near, { cleanup: "strip", ...editor, verbose: true }), false, JSON.stringify(near));
  }
  // The line can open the text: then nothing is left and git aborts the commit.
  assert.equal(storedMessage(verbose.slice(verbose.indexOf(LINE)), "strip"), "");
});

test("comment marker auto: only a line git wrote names it; without the editor, git's rule over the message", () => {
  const HINT = "Please enter the commit message for your changes. Lines starting";
  // A hint typed by hand above git's template: the last one is git's.
  assert.equal(commentMarker("auto", `feat: x\n\n# ${HINT}\n\n@ ${HINT}\n@ On branch main\n`, true), "@");
  // -m / -F: no template, so a hint-like line is just text; "#" starts a line, so git takes ";".
  assert.equal(commentMarker("auto", `feat: x\n# ${HINT}\n`, false), ";");
  // A translated template: no English hint, but its lines that are the marker alone; AUTO is auto.
  assert.equal(commentMarker("AUTO", "feat: x\n\n# typed\n\n; Lütfen bir işleme iletisi girin.\n;\n; Dal main\n;\n", true), ";");
  assert.deepEqual([commentMarker("", "x", true), commentMarker("%", "x", false)], ["#", "%"]);
  // commit.status off: no status template, so a commit.template line that is "#" alone names nothing.
  assert.equal(commentMarker("auto", "# <type>: <subject>\n#\n# Why\nfeat: x\n", true, false), ";");
});

test("hookCommitMode: the last value of a key wins (git -c over the repository's config), and commit.verbose=2 cuts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-mode-"));
  // No user config: a commit.verbose in ~/.gitconfig would decide here.
  const global = join(dir, "..", `${dir.split(/[\\/]/).pop()}.gitconfig`);
  writeFileSync(global, "");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" };
  git(["init", "-q"], { cwd: dir, env });
  git(["config", "commit.cleanup", "verbatim"], { cwd: dir, env });
  const message = "feat: x\n\n# ------------------------ >8 ------------------------\nprose\n";
  const mode = (/** @type {string} */ params) => hookCommitMode({ cwd: dir, message, env: { ...env, GIT_EDITOR: ":", GIT_CONFIG_PARAMETERS: params } });
  assert.deepEqual(mode(""), { cleanup: "verbatim", comment: "#", cut: false });
  assert.deepEqual(mode("'commit.cleanup'='strip' 'commit.verbose'='2'"), { cleanup: "strip", comment: "#", cut: true });
});
