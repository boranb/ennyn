import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { checkCommitShape } from "../checks/commit-shape.mjs";

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
