import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

test("commit shape: an Impact line counts with a letter or a digit on it, and a refusal says the summary goes on that line", () => {
  const c = cfg({ review: { impactRequiredGlobs: ["src/auth/**"] } });
  const stagedPaths = ["src/auth/a.js"];
  const ok = (/** @type {string} */ message) => checkCommitShape(message, { config: c, stagedPaths }).ok;
  // Marks and characters that show as nothing fill the line and say nothing.
  for (const rest of ["-", ".", "#", "--", "…", "\u200b", "\u200d", "\u2060", "\u00ad", "\u180e", "\u0085", "\u001f", "\ufeff", " \u200b "]) assert.equal(ok(`feat: x\n\nImpact: ${rest}\n`), false, JSON.stringify(rest));
  // Hangul fillers are letters to Unicode and show as nothing: Default_Ignorable_Code_Point says so.
  for (const rest of ["\u3164", "\uffa0", "\u115f", "\u1160", "\u3164 \uffa0", "- \u3164"]) assert.equal(ok(`feat: x\n\nImpact: ${rest}\n`), false, JSON.stringify(rest));
  for (const rest of ["영향 없음", "\u3164영향"]) assert.equal(ok(`feat: x\n\nImpact: ${rest}\n`), true, JSON.stringify(rest));
  // A line in a legacy i18n.commitEncoding reads as replacement characters: bytes were there, and the rule is against empty lines.
  for (const rest of ["\ufffd", "\ufffd\ufffd \ufffd"]) assert.equal(ok(`feat: x\n\nImpact: ${rest}\n`), true, JSON.stringify(rest));
  // A word is a word: no reader can judge one, a person can.
  for (const rest of ["none", "n/a", "x", "7", "tablo değişmedi", "影響なし", "- the auth check", "\u200bthe auth check"]) assert.equal(ok(`feat: x\n\nImpact: ${rest}\n`), true, JSON.stringify(rest));
  assert.equal(ok("feat: x\n\nImpact:the auth check\n"), true);
  // The summary on the lines below the label stays refused, and the words say what to do: the line is already there.
  for (const body of ["Impact:\n  the auth check\n  and the session\n", "Impact:\n- the auth check\n", "Impact:\nthe auth check\n"]) {
    for (const [language, words] of /** @type {const} */ ([["en", /holds the summary on that same line/], ["tr", /özeti aynı satırda/]])) {
      const r = checkCommitShape(`feat: x\n\n${body}`, { config: cfg({ language, review: { impactRequiredGlobs: ["src/auth/**"] } }), stagedPaths });
      assert.equal(r.ok, false, body);
      assert.match(r.errors.join("\n"), words, body);
    }
  }
});

test("commit shape: an Impact line with nothing on it says nothing, so it does not count", () => {
  const c = cfg({ review: { impactRequiredGlobs: ["src/auth/**"] } });
  const stagedPaths = ["src/auth/a.js"];
  const ok = (/** @type {string} */ message) => checkCommitShape(message, { config: c, stagedPaths }).ok;
  assert.equal(ok("feat: x\n\nImpact:\n"), false);
  assert.equal(ok("feat: x\n\nImpact:   \n"), false);
  assert.equal(ok("feat: x\n\n  Impact:\t\n"), false);
  // commit.cleanup=verbatim keeps a line's end: the one mode that reaches the check with spaces after the label.
  assert.equal(checkCommitShape("feat: x\n\nImpact:   \n", { config: c, stagedPaths, cleanup: "verbatim" }).ok, false);
  assert.equal(checkCommitShape("feat: x\n\nImpact: said\n", { config: c, stagedPaths, cleanup: "verbatim" }).ok, true);
  assert.equal(ok("feat: x\n\nImpact: the auth check\n"), true);
  assert.equal(ok("feat: x\n\n  Impact: indented, as a body may be\n"), true);
  assert.equal(ok("feat: x\n\nImpact: not needed: a local rename\n"), true);
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

test("types: a subject with a byte order mark, or a UTF-16 message, is refused saying why, not only for its type", () => {
  // Measured on Windows (Git for Windows 2.47.1): Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM, which
  // git keeps at the subject's head, and its Out-File writes UTF-16LE, whose NULs git refuses.
  const c = cfg({ commitMsg: { types: ["docs", "fix"] } });
  const why = /byte order mark.*UTF-16/;
  const utf16 = Buffer.from("\uFEFFdocs: add a note\r\n", "utf16le").toString("utf8");
  for (const bad of ["\uFEFFdocs: add a note\n", utf16]) {
    const r = checkCommitShape(bad, { config: c });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /commitMsg\.types/);
    assert.match(r.errors.join(" "), why, JSON.stringify(bad));
  }
  // A wrong type with no BOM at its head says nothing of it, nor does a CRLF message; with no types the BOM is not this check's.
  for (const plain of ["Added stuff", "Added \uFEFFstuff"]) assert.doesNotMatch(checkCommitShape(plain, { config: c }).errors.join(" "), why, plain);
  assert.deepEqual(checkCommitShape("docs: add a note\r\n", { config: c }).errors, []);
  assert.ok(checkCommitShape("\uFEFFanything", { config: cfg() }).ok);
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
  git(["init", "-q"], { cwd: dir });
  git(["config", "commit.cleanup", "verbatim"], { cwd: dir });
  const message = "feat: x\n\n# ------------------------ >8 ------------------------\nprose\n";
  const mode = (/** @type {string} */ params) => hookCommitMode({ cwd: dir, message, env: { ...process.env, GIT_EDITOR: ":", GIT_CONFIG_PARAMETERS: params } });
  assert.deepEqual(mode(""), { cleanup: "verbatim", comment: "#", cut: false });
  assert.deepEqual(mode("'commit.cleanup'='strip' 'commit.verbose'='2'"), { cleanup: "strip", comment: "#", cut: true });
});

test("cochange: a staged path whose documents are not staged warns, never fails; a document staged with it is enough", () => {
  const c = cfg({
    review: {
      cochange: [
        { paths: ["README.md"], docs: ["README.tr.md"], note: "the twins" },
        { paths: ["src/**"], docs: ["docs/**", "CHANGELOG.md"] },
      ],
    },
  });
  const check = (/** @type {string[]} */ stagedPaths, message = "feat: x") => checkCommitShape(message, { config: c, stagedPaths });
  const readme = check(["README.md"]);
  assert.deepEqual([readme.ok, readme.errors], [true, []]);
  assert.deepEqual(readme.warnings, ["Warning: README.md changed, but not README.tr.md (the twins). If the change shows there, update it in this commit."]);
  assert.deepEqual(check(["README.md", "README.tr.md"]).warnings, []);
  assert.deepEqual(check(["README.tr.md"]).warnings, [], "the rule is one way");
  assert.deepEqual(check(["src/a.js", "docs/api/b.md"]).warnings, [], "any one document is enough");
  assert.deepEqual(check(["src/a.js", "CHANGELOG.md"]).warnings, []);
  assert.deepEqual(check(["lib/a.js", "test/a.test.js"]).warnings, [], "no rule names these");
  assert.deepEqual(check([]).warnings, []);
  // Both rules, the list cut at three.
  const both = check(["README.md", "src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"]).warnings;
  assert.equal(both.length, 2);
  assert.match(both[1], /^Warning: src\/a\.js, src\/b\.js, src\/c\.js and 2 more changed, but not docs\/\*\*, CHANGELOG\.md\. /);
  assert.match(check(["src/a.js", "src/b.js", "src/c.js"]).warnings?.[0] ?? "", /^Warning: src\/a\.js, src\/b\.js, src\/c\.js changed, /, "three fit");
  // A failing message keeps its warnings; the bypass marker loosens the shape, not the documents.
  const long = check(["README.md"], "x".repeat(130));
  assert.deepEqual([long.ok, long.warnings?.length], [false, 1]);
  const marked = check(["README.md"], "x".repeat(130) + " [commit-shape-allow: imported upstream file]");
  assert.deepEqual([marked.ok, marked.skipped, marked.warnings?.length], [true, "marker", 1]);
  // What git writes itself is not checked at all.
  assert.equal(check(["README.md"], "Merge branch 'x'").warnings, undefined);
  // An amend! carries the target's paths: its README change still has no twin.
  const amend = checkCommitShape("amend! feat: x\n\nfeat: x, reworded", { config: c, stagedPaths: [], foldTarget: { message: "feat: x", paths: ["README.md"] } });
  assert.equal(amend.warnings?.length, 1);
  // In the project language.
  const tr = cfg({ language: "tr", review: { cochange: [{ paths: ["a/**"], docs: ["b.md"] }] } });
  assert.deepEqual(checkCommitShape("feat: x", { config: tr, stagedPaths: ["a/1", "a/2", "a/3", "a/4"] }).warnings, [
    "Uyarı: a/1, a/2, a/3 ve 1 tane daha değişti ama b.md değişmedi. Değişiklik orada görünüyorsa bu commit'te güncelle.",
  ]);
});

test("cochange: rules are checked when the config loads, every problem at once", () => {
  const bad = [null, [], { paths: [], docs: ["a.md"] }, { paths: ["a"], docs: "b.md" }, { paths: ["a"], docs: [""] }, { paths: ["a"], docs: ["b"], note: 3 }, { paths: ["a"], docs: ["b"], why: "x" }];
  assert.throws(
    () => cfg({ review: { cochange: bad } }),
    (/** @type {any} */ e) => {
      assert.deepEqual(e.problems, [
        '"review.cochange"[0] must be an object { paths, docs, note? }',
        '"review.cochange"[1] must be an object { paths, docs, note? }',
        '"review.cochange"[2].paths must be a non-empty list of globs',
        '"review.cochange"[3].docs must be a non-empty list of globs',
        '"review.cochange"[4].docs must be a non-empty list of globs',
        '"review.cochange"[5].note must be a string',
        '"review.cochange"[6]: unknown key "why"',
      ]);
      return true;
    },
  );
  assert.throws(() => cfg({ review: { cochange: {} } }), /"review.cochange" must be array/);
});

test("cochange: a glob that does not compile is a config problem at load, in every glob list", () => {
  assert.throws(
    () => cfg({ review: { impactRequiredGlobs: ["src/{a,b"], cochange: [{ paths: ["[z-a]"], docs: ["ok.md"] }] }, impact: { fakeGlobs: ["{a,{b}}"] } }),
    (/** @type {any} */ e) => {
      assert.deepEqual(
        e.problems.map((/** @type {string} */ p) => p.replace(/ \(.*\)$/, "")),
        ['"review.impactRequiredGlobs": "src/{a,b" is not a glob that compiles', '"impact.fakeGlobs": "{a,{b}}" is not a glob that compiles', '"review.cochange[0].paths": "[z-a]" is not a glob that compiles'],
      );
      return true;
    },
  );
});

test("cochange: a squash! target's documents count; an amend! lists each path once", () => {
  const c = cfg({ review: { cochange: [{ paths: ["core/**"], docs: ["DESIGN.md"] }] } });
  const target = { message: "feat: module a", paths: ["core/a.mjs", "DESIGN.md"] };
  assert.deepEqual(checkCommitShape("squash! feat: module a\n\nand b", { config: c, stagedPaths: ["core/a.mjs"], foldTarget: target }).warnings, []);
  // The target's code alone does not warn on the squash: it was checked when it was committed.
  assert.deepEqual(checkCommitShape("squash! feat: module a\n\nand b", { config: c, stagedPaths: ["README.md"], foldTarget: { message: "feat: module a", paths: ["core/a.mjs"] } }).warnings, []);
  const amend = checkCommitShape("amend! feat: module a\n\nfeat: module a, renamed", { config: c, stagedPaths: ["core/a.mjs", "core/b.mjs"], foldTarget: { message: "feat: module a", paths: ["core/a.mjs"] } });
  assert.match(amend.warnings?.[0] ?? "", /^Warning: core\/a\.mjs, core\/b\.mjs changed, /);
});
