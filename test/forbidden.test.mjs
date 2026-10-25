import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { banLines, banMatches, scanProject } from "../setup/scan.mjs";
import { loadConfig, ConfigError } from "../core/config.mjs";
import { checkCommitShape, forbiddenHits } from "../checks/commit-shape.mjs";
import { addedLines, git, stagedAddedLines, stagedPaths, unquotePath } from "../core/git.mjs";
import { installHook } from "../setup/hook.mjs";
import { checkSetup } from "../setup/doctor.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const cfg = (/** @type {Record<string, unknown>} */ override = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-fb-")), env: {}, override });
const RULE = { text: "console.log", paths: ["src/**"], except: ["src/log.js"], note: "use the logger" };

/** A repository with a config; `stage` writes files and adds them. */
function repo(/** @type {Record<string, unknown>} */ config = { review: { forbidden: [RULE] } }) {
  const dir = mkdtempSync(join(tmpdir(), "en-fb-repo-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { ".ennyn/config.json": JSON.stringify(config) });
  const stage = (/** @type {Record<string, string>} */ files) => {
    put(dir, files);
    git(["add", "-A"], { cwd: dir });
  };
  const commit = (/** @type {string} */ message, /** @type {string[]} */ ...extra) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", ...extra, "-m", message], { cwd: dir, encoding: "utf8" });
  return { dir, stage, commit };
}

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

test("ban lines: a line that forbids and names a literal, in English and Turkish (accept corpus)", () => {
  const accept = [
    ["- Never use `console.log` in src/.", ["console.log"]],
    ["NEVER use `any` in TypeScript files", ["any"]],
    ["Do not import `lodash`; the helpers in `src/util` do the same.", ["lodash", "src/util"]],
    ["- Don't call `process.exit` from library code", ["process.exit"]],
    ["- Don’t leave `debugger` in a commit", ["debugger"]],
    ["`dangerouslySetInnerHTML` is forbidden.", ["dangerouslySetInnerHTML"]],
    ["Code must not read `process.env` directly", ["process.env"]],
    ["`eval` is not allowed anywhere.", ["eval"]],
    ["Raw `fetch(` calls are banned outside the API client.", ["fetch("]],
    ["| `innerHTML` | prohibited |", ["innerHTML"]],
    ["- `console.log` kullanma.", ["console.log"]],
    ["- Asla `any` yazma.", ["any"]],
    ["`eval` yasak.", ["eval"]],
    ["`print(` yasaktır", ["print("]],
    ["Hiçbir zaman `fetch`'i doğrudan çağırma", ["fetch"]],
    ["`TODO` bırakmayın", ["TODO"]],
    ["Test dosyalarında `.only` olmamalı", [".only"]],
    ["`setTimeout` kullanılmaz; `vi.useFakeTimers` var.", ["setTimeout", "vi.useFakeTimers"]],
    ["`moment` paketi eklenmemeli", ["moment"]],
    ["asla `git push --force` kullanmayin", ["git push --force"]],
    ["- No `console.log` in production code.", ["console.log"]],
    ["`console.log` is not permitted", ["console.log"]],
    ["You cannot use `eval` here", ["eval"]],
    ["Under no circumstances add `debugger`", ["debugger"]],
    ["`console.log` kalmasın", ["console.log"]],
    ["`any` kullanılmasın", ["any"]],
    ["`eval` kullanmayalım", ["eval"]],
    ["`console.log` kullanma, `logger` kullan.", ["console.log", "logger"]],
  ];
  for (const [line, literals] of accept) {
    assert.deepEqual(banLines(String(line)), [{ line: String(line).trim(), literals }], String(line));
  }
});

test("ban lines: a rule with no literal, a literal with no ban, code blocks and softer words are left out (reject corpus)", () => {
  const reject = [
    "- Never write a secret into a file that is tracked.",
    "Use `npm test` before every commit.",
    "Prefer `const` over `let`.",
    "Avoid `useEffect` for data fetching.",
    "`npm test` güncelleme sonrası koşar",
    "Bu bir hata değil: `x` kullan",
    "A `` ` `` alone is no literal",
    "Never use `a`.",
    "Whenever `config.json` changes, run `doctor`",
    "`nevermind` is a word, not a ban",
    "Do note that `xx` is slow",
    "Nevermind `xx`, it is fine",
    "Set `--never-cache` for `npm ci`",
    "Kullanma kılavuzu `docs/manual.md` içinde",
    "Bir `migration` ekleme adımı var",
  ];
  for (const line of reject) assert.deepEqual(banLines(line), [], line);
  const fenced = ["```sh", "# never run `rm -rf /`", "never `xx`", "```", "~~~", "do not use `yy`", "~~~", "Never use `zz` here."].join("\n");
  assert.deepEqual(banLines(fenced), [{ line: "Never use `zz` here.", literals: ["zz"] }]);
  // A fence of the other kind, or a shorter one, inside a block neither ends it nor opens one; nor does one with text after it.
  assert.deepEqual(banLines(["```md", "~~~", "never use `aa`", "```", "never use `bb`"].join("\n")), [{ line: "never use `bb`", literals: ["bb"] }]);
  assert.deepEqual(banLines(["````md", "```", "never use `aa`", "```js", "````", "never use `bb`"].join("\n")), [{ line: "never use `bb`", literals: ["bb"] }]);
});

test("ban lines: at most three literals a line, every line of a file; long lines are cut", () => {
  assert.deepEqual(banLines("Never use `a1`, `b2`, `c3` or `d4`.")[0].literals, ["a1", "b2", "c3"]);
  const many = Array.from({ length: 12 }, (_, i) => `- never use \`x${i}\``).join("\n");
  assert.equal(banLines(many).length, 12, "--json lists them all, as the text output says");
  const edge = `Never use \`x1\` ${"w".repeat(145)}`;
  assert.equal(edge.length, 160);
  assert.equal(banLines(edge)[0].line, edge, "160 characters stay whole");
  assert.equal(banLines(`${edge}w`)[0].line, `${edge.slice(0, 157)}…`);
  const long = `Never use \`x1\` ${"word ".repeat(60)}`;
  const [only] = banLines(long);
  assert.ok(only.line.length <= 160 && only.line.endsWith("…"), only.line);
  assert.deepEqual(only.literals, ["x1"]);
});

test("review.forbidden: a rule of the wrong shape is a config problem at load, every problem at once", () => {
  assert.deepEqual(cfg().review.forbidden, []);
  assert.deepEqual(cfg({ review: { forbidden: [RULE] } }).review.forbidden, [RULE]);
  let err;
  try {
    cfg({ review: { forbidden: [null, { text: "", paths: [] }, { text: "a\nb", paths: ["src/**"], except: "src/x", note: 3, extra: 1 }, { text: "x", paths: ["[z-a]"], except: ["{a,b"] }, { text: "  ", paths: ["a"] }, { text: "a\rb", paths: ["a"] }] } });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError);
  const problems = /** @type {ConfigError} */ (err).problems;
  for (const want of [
    /review\.forbidden"\[0\] must be an object/,
    /review\.forbidden"\[1\]\.text must be a non-empty string on one line/,
    /review\.forbidden"\[1\]\.paths must be a non-empty list of globs/,
    /review\.forbidden"\[2\]: unknown key "extra"/,
    /review\.forbidden"\[2\]\.text must be a non-empty string on one line/,
    /review\.forbidden"\[2\]\.except must be a list of globs/,
    /review\.forbidden"\[2\]\.note must be a string/,
    /review\.forbidden\[3\]\.paths": "\[z-a\]" is not a glob that compiles/,
    /review\.forbidden\[3\]\.except": "\{a,b" is not a glob that compiles/,
    /review\.forbidden"\[4\]\.text must be a non-empty string on one line/,
    /review\.forbidden"\[5\]\.text must be a non-empty string on one line/,
  ]) {
    assert.ok(problems.some((p) => want.test(p)), `${want} in ${problems.join(" | ")}`);
  }
});

test("review.forbidden: an added line with the text fails the commit in the rule's paths, not in except or elsewhere", () => {
  const config = cfg({ review: { forbidden: [RULE, { text: "debugger", paths: ["**/*.js"] }] } });
  const added = new Map([
    ["src/a.js", [{ line: 3, text: "  console.log(x);" }, { line: 9, text: "debugger;" }]],
    ["src/log.js", [{ line: 1, text: "console.log(msg); debugger;" }]],
    ["docs/a.md", [{ line: 1, text: "never call console.log" }]],
    ["src/b.js", [{ line: 2, text: "Console.Log(x)" }]],
  ]);
  assert.deepEqual(forbiddenHits(added, config.review.forbidden), [
    { rule: 0, path: "src/a.js", line: 3 },
    { rule: 1, path: "src/a.js", line: 9 },
    { rule: 1, path: "src/log.js", line: 1 },
  ]);
  const res = checkCommitShape("feat: x", { config, addedLines: added });
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, [
    'src/a.js:3 adds "console.log", which review.forbidden rule 1 keeps out (use the logger). Take it out, or name the file in that rule\'s except list in the config.',
    'src/a.js:9, src/log.js:1 adds "debugger", which review.forbidden rule 2 keeps out. Take it out, or name the file in that rule\'s except list in the config.',
  ]);
  // Without the lines (not read), only the shape is checked.
  assert.equal(checkCommitShape("feat: x", { config }).ok, true);
  assert.equal(checkCommitShape("feat: x", { config, addedLines: new Map([["src/a.js", [{ line: 1, text: "ok" }]]]) }).ok, true);
});

test("review.forbidden: content is checked whatever the subject, also for a message read as empty; the bypass marker loosens the shape only; the config is exempt", () => {
  const config = cfg({ commitMsg: { types: ["feat", "fix"] }, review: { forbidden: [RULE] } });
  const added = new Map([["src/a.js", Array.from({ length: 5 }, (_, i) => ({ line: i + 1, text: "console.log(1)" }))]]);
  for (const message of ["Merge branch 'x'", "Revert \"feat: y\"", "fixup! feat: y", "amend! feat: y\n\nfeat: y", "squash! feat: y\n\nmore", "wip [commit-shape-allow: notes only, no shape]"]) {
    const res = checkCommitShape(message, { config, addedLines: added });
    assert.equal(res.ok, false, message);
    assert.match(res.errors[0], /^src\/a\.js:1, src\/a\.js:2, src\/a\.js:3 and 2 more adds "console\.log"/, message);
  }
  // git commits an empty message with --allow-empty-message, and a "#" subject under a cleanup the hook cannot see.
  const empty = checkCommitShape("\n# only a comment\n", { config, addedLines: added });
  assert.equal(empty.ok, false);
  assert.equal(empty.skipped, "empty");
  assert.equal(checkCommitShape("feat: x", { config, addedLines: new Map([["src/a.js", [{ line: 1, text: "console.log" }]]]), exempt: ["src/a.js"] }).ok, true);
  const three = new Map([["src/a.js", added.get("src/a.js")?.slice(0, 3) ?? []]]);
  assert.match(checkCommitShape("feat: x", { config, addedLines: three }).errors[0], /^src\/a\.js:1, src\/a\.js:2, src\/a\.js:3 adds/);
  const tr = checkCommitShape("feat: x", { config: cfg({ language: "tr", review: { forbidden: [RULE] } }), addedLines: added });
  assert.match(tr.errors[0], /"console\.log" ekliyor; review\.forbidden kural 1/);
});

test("unquotePath: git's C quoting back to the name; a plain name stays", () => {
  assert.equal(unquotePath("b/plain name.js"), "b/plain name.js");
  assert.equal(unquotePath('"b/tab\\there.js"'), "b/tab\there.js");
  assert.equal(unquotePath('"b/a\\tb\\n\\"q\\\\.js"'), 'b/a\tb\n"q\\.js');
  assert.equal(unquotePath('"b/\\303\\274.js"'), "b/ü.js");
  assert.equal(unquotePath('"b/ü😀\\t.js"'), "b/ü😀\t.js");
});

test("addedLines: content that looks like a header is content; a path not asked for or a hunk header that does not parse throws", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1..2 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -3,0 +4,3 @@ ctx",
    "+++ b/elsewhere.js",
    "+diff text",
    "+",
    "@@ -9 +11 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "diff --git a/src/gone.js b/src/gone.js",
    "deleted file mode 100644",
    "--- a/src/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
  ].join("\n");
  const two = new Set(["src/a.js", "src/gone.js"]);
  assert.deepEqual(addedLines(diff, two, { complete: true }), new Map([["src/a.js", [{ line: 4, text: "++ b/elsewhere.js" }, { line: 5, text: "diff text" }, { line: 6, text: "" }, { line: 11, text: "new" }]]]));
  assert.throws(() => addedLines(diff, new Set(["src/gone.js"])), /named a path it was not asked for: "a\/src\/a\.js b\/src\/a\.js"/);
  assert.throws(() => addedLines(diff, new Set([...two, "src/never.js"]), { complete: true }), /did not show 1 staged path\(s\), so their lines were not read: "src\/never\.js"/);
  assert.equal(addedLines(diff, new Set([...two, "src/never.js"])).size, 1, "complete is asked for");
  assert.throws(() => addedLines("diff --git a/x b/x\n+++ x\n@@ -1 +1 @@\n+y", new Set(["x"])), /not asked for/);
  assert.throws(() => addedLines("diff --git a/x b/x\n+++ b/x\n@@ garbage @@\n+y", new Set(["x"])), /hunk header that does not parse/);
  assert.throws(() => addedLines("diff --git a/x b/y\n", new Set(["x"])), /not asked for/, "names that differ: no rename is asked for");
  // A quoted name with a space ends in a tab too.
  const quoted = 'diff --git "a/x y\\\\z.js" "b/x y\\\\z.js"\n--- /dev/null\n+++ "b/x y\\\\z.js"\t\n@@ -0,0 +1 @@\n+console.log';
  assert.deepEqual(addedLines(quoted, new Set(["x y\\z.js"]), { complete: true }), new Map([["x y\\z.js", [{ line: 1, text: "console.log" }]]]));
  // A file with many added lines reads in linear time.
  const big = `diff --git a/b.js b/b.js\n+++ b/b.js\n@@ -0,0 +1,100000 @@\n${"+x\n".repeat(100000)}`;
  const t0 = Date.now();
  assert.equal(addedLines(big, new Set(["b.js"])).get("b.js")?.length, 100000);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test("stagedAddedLines: real git; odd names, hunks, deletions, binary files, the first commit and a hostile diff config", () => {
  const { dir, stage, commit } = repo();
  const names = ["src/with space.js", "src/tab\there.js", 'src/q"uote.js', "src/ü.js", "src/back\\slash.js"];
  // The first commit: there is no HEAD to diff against.
  stage(Object.fromEntries(names.map((n) => [n, "one\ntwo\n"])));
  const first = stagedAddedLines(dir, stagedPaths(dir));
  for (const n of names) assert.deepEqual(first.get(n), [{ line: 1, text: "one" }, { line: 2, text: "two" }], n);
  assert.equal(commit("first", "--no-verify").status, 0);
  // Every config that reshapes a diff, set in the repository.
  for (const [k, v] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["color.diff", "always"], ["color.ui", "always"], ["diff.relative", "true"], ["diff.external", "false"], ["diff.submodule", "log"], ["diff.renames", "copies"], ["diff.context", "5"], ["core.quotePath", "true"], ["diff.suppressBlankEmpty", "true"], ["diff.t.textconv", "tr a-z A-Z"]]) {
    git(["config", k, v], { cwd: dir });
  }
  stage({ ".gitattributes": "*.js diff=t\n*.min.js -diff\n", "src/with space.js": "zero\none\ntwo\nthree\n", "src/ü.js": "one\n", "bin.dat": "\0\x01console.log\0", "src/new.js": "a\n\nconsole.log\n", "src/x.min.js": "console.log(1)\n" });
  git(["config", "core.bigFileThreshold", "1"], { cwd: dir });
  git(["rm", "-q", "src/tab\there.js"], { cwd: dir });
  // A move with diff.renames on: the new name is added in full, so a text the file already held is seen there.
  git(["mv", 'src/q"uote.js', "src/moved.js"], { cwd: dir });
  const lines = stagedAddedLines(dir, stagedPaths(dir));
  assert.deepEqual(lines.get("src/moved.js"), [{ line: 1, text: "one" }, { line: 2, text: "two" }]);
  assert.deepEqual(lines.get("src/with space.js"), [{ line: 1, text: "zero" }, { line: 4, text: "three" }]);
  assert.equal(lines.get("src/ü.js"), undefined, "only a deletion: no line added");
  // Binary to git (a NUL byte, -diff, past core.bigFileThreshold): read as text all the same, its bytes kept.
  assert.deepEqual(lines.get("bin.dat"), [{ line: 1, text: "\0\x01console.log\0", raw: Buffer.from("\0\x01console.log\0") }]);
  assert.deepEqual(lines.get("src/x.min.js"), [{ line: 1, text: "console.log(1)" }]);
  assert.deepEqual(lines.get("src/new.js"), [{ line: 1, text: "a" }, { line: 2, text: "" }, { line: 3, text: "console.log" }]);
  assert.equal(lines.get("src/tab\there.js"), undefined, "deleted");
  // A thousand paths and more: no argument list to outgrow.
  const many = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => [`m/f${i}.txt`, `line ${i}\n`]));
  stage(many);
  const read = stagedAddedLines(dir, stagedPaths(dir));
  assert.deepEqual(read.get("m/f1004.txt"), [{ line: 1, text: "line 1004" }]);
  // Only the paths asked for are read.
  assert.deepEqual([...stagedAddedLines(dir, ["m/f1.txt"]).keys()], ["m/f1.txt"]);
});

test("stagedAddedLines: a name git does not match as a pathspec (not UTF-8; decomposed, on macOS) is no answer, never no lines", () => {
  const { dir, commit } = repo();
  assert.equal(commit("base", "--no-verify", "--allow-empty").status, 0);
  const add = (/** @type {Buffer} */ name, /** @type {string} */ text) => {
    const tmp = join(dir, ".git", "blob");
    writeFileSync(tmp, text);
    const hash = git(["hash-object", "-w", tmp], { cwd: dir });
    const r = spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: dir, input: Buffer.concat([Buffer.from(`100644 ${hash}\t`), name, Buffer.from("\n")]) });
    assert.equal(r.status, 0, String(r.stderr));
  };
  add(Buffer.from("src/u\u0308.js", "utf8"), "console.log(1)\n");
  add(Buffer.from([...Buffer.from("src/"), 0xff, ...Buffer.from(".js")]), "console.log(2)\n");
  const staged = stagedPaths(dir);
  assert.equal(staged.length, 2);
  const nfd = /** @type {string} */ (staged.find((p) => p.includes("u\u0308")));
  const bad = /** @type {string} */ (staged.find((p) => p !== nfd));
  // Bytes that are not UTF-8 come back as U+FFFD, a name git does not have.
  assert.throws(() => stagedAddedLines(dir, [bad]), /did not show 1 staged path\(s\)/);
  // A decomposed name: read where git takes the name as given, refused where it precomposes it (macOS).
  try {
    assert.deepEqual(stagedAddedLines(dir, [nfd]).get(nfd), [{ line: 1, text: "console.log(1)" }]);
  } catch (e) {
    assert.match(String(/** @type {Error} */ (e).message), /did not show 1 staged path\(s\)/);
  }
});

test("review.forbidden through the commit-msg hook: a commit that adds the text is refused, the index a partial commit gets is read", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [RULE] } });
  stage({ "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "src/log.js": "export const log = (m) => console.log(m);\n" });
  assert.equal(commit("first").status, 0, "no hook yet; the logger is excepted anyway");
  installHook({ cwd: dir, cliPath: CLI });
  stage({ "src/a.js": "export const a = 1;\nconsole.log(a);\n" });
  const refused = commit("add a log");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /src\/a\.js:2 adds "console\.log", which review\.forbidden rule 1 keeps out \(use the logger\)/);
  // The same file staged, but a partial commit of another one: the temporary index holds only that one.
  put(dir, { "src/b.js": "export const b = 2;\n" });
  const partial = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add b", "--", "src/b.js"], { cwd: dir, encoding: "utf8" });
  assert.equal(partial.status, 0, partial.stderr);
  stage({ "src/a.js": "export const a = 1;\nlog(a);\n" });
  assert.equal(commit("use the logger").status, 0);
  // The hook reads what the commit will hold, not the main index: `commit -- <path>` takes the work tree's file.
  stage({ "src/a.js": "export const a = 1;\nconsole.log(a);\n" });
  put(dir, { "src/a.js": "export const a = 2;\n" });
  const clean = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a is 2", "--", "src/a.js"], { cwd: dir, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  git(["reset", "-q"], { cwd: dir });
  put(dir, { "src/a.js": "export const a = 3;\nconsole.log(a);\n" });
  const dirty = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a is 3", "--", "src/a.js"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(dirty.status, 0, "the staged index held no log; the commit does");
  assert.match(dirty.stderr, /src\/a\.js:2 adds "console\.log"/);
  // An empty message that git takes (--allow-empty-message) is no way past the lines.
  const empty = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty-message", "-m", "", "--", "src/a.js"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /adds "console\.log"/);
});

test("review.forbidden through the hook: the config holding the text commits; a merge's own line and the other side's are both refused", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [{ text: "debugger", paths: ["**"] }] } });
  installHook({ cwd: dir, cliPath: CLI });
  stage({});
  assert.equal(commit("first").status, 0, "the config holds the text and is exempt");
  put(dir, { ".ennyn/config.json": JSON.stringify({ review: { forbidden: [{ text: "debugger", paths: ["**"], note: "no stops" }] } }) });
  git(["add", "-A"], { cwd: dir });
  assert.equal(commit("note").status, 0);
  stage({ "a.js": "a\n" });
  assert.equal(commit("a").status, 0);
  // A side branch whose commit skipped the hook, merged with a line of the merge's own.
  git(["checkout", "-q", "-b", "side"], { cwd: dir });
  stage({ "a.js": "a\ndebugger;\n" });
  assert.equal(commit("side", "--no-verify").status, 0);
  git(["checkout", "-q", "main"], { cwd: dir });
  stage({ "b.js": "b\n" });
  assert.equal(commit("b").status, 0);
  // git needs an identity to merge, and a container has none it can guess.
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-commit", "side"], { cwd: dir, encoding: "utf8" }).status, 0);
  put(dir, { "b.js": "b\ndebugger; // resolved here\n" });
  git(["add", "b.js"], { cwd: dir });
  const evil = commit("merge side");
  assert.notEqual(evil.status, 0);
  assert.match(evil.stderr, /^a\.js:2, b\.js:2 adds "debugger".* The merge brings 1 of these lines from [0-9a-f]+/m);
});

test("review.forbidden through the hook: an index from outside the git dir, or a config not in the work tree, is said, not checked as clean", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [RULE] } });
  stage({ "src/a.js": "1\n" });
  assert.equal(commit("first").status, 0);
  installHook({ cwd: dir, cliPath: CLI });
  // git builds the commit from the index GIT_INDEX_FILE names; the hook cannot tell it from a leaked one.
  const alt = join(mkdtempSync(join(tmpdir(), "en-fb-idx-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: alt };
  spawnSync("git", ["read-tree", "HEAD"], { cwd: dir, env });
  put(dir, { "src/a.js": "1\nconsole.log(1);\n" });
  spawnSync("git", ["add", "src/a.js"], { cwd: dir, env });
  const foreign = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "alt"], { cwd: dir, env, encoding: "utf8" });
  assert.match(foreign.stderr, /Staged paths could not be read \(the hook was given an index outside this repository's git dir/);
  assert.match(foreign.stderr, /review\.forbidden(,? (?:and )?\S+)* checks ran without them/);
  // The config named by ENNYN_CONFIG is not there: the defaults would check nothing of this project.
  stage({ "src/a.js": "2\nconsole.log(2);\n" });
  const named = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "named"], { cwd: dir, env: { ...process.env, ENNYN_CONFIG: join(dir, "nope.json") }, encoding: "utf8" });
  assert.equal(named.status, 0);
  assert.match(named.stderr, /nope\.json is not in the work tree .* so this commit was not checked/);
  // A sparse checkout that leaves .ennyn/ out.
  stage({ "src/a.js": "3\nconsole.log(3);\n" });
  git(["update-index", "--skip-worktree", ".ennyn/config.json"], { cwd: dir });
  rmSync(join(dir, ".ennyn"), { recursive: true });
  const sparse = commit("sparse");
  assert.equal(sparse.status, 0);
  assert.match(sparse.stderr, /\.ennyn\/config\.json is not in the work tree/);
});

test("commit-check run by hand fails when the staged lines cannot be read; the hook says so and goes on", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [RULE] } });
  stage({ "src/a.js": "1\n" });
  assert.equal(commit("first").status, 0);
  stage({ "src/a.js": "1\n2\n" });
  put(dir, { ".git/MSG": "add two\n" });
  const bin = mkdtempSync(join(tmpdir(), "en-fb-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" -U0 "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const byHand = spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(byHand.status, 0);
  assert.match(byHand.stderr, /injected/);
  const hook = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(hook.status, 0);
  assert.match(hook.stderr, /review\.forbidden was not checked: .*injected/);
});

test("init-scan: ban lines with what the index holds of each literal, the instruction files left out; outside a repository unmeasured", () => {
  const { dir, stage } = repo({ review: { forbidden: [{ text: "debugger", paths: ["src/**"] }] } });
  stage({
    "CLAUDE.md": "# Rules\n\n- Never use `console.log` in src/.\n- Never commit `debugger`.\n",
    "AGENTS.md": "- Do not call `console.log`.\n",
    "src/a.js": "console.log(1);\nconsole.log(2);\n",
    "src/b.js": "console.log(3);\n",
    "src/sparse.js": "console.log(4);\n",
  });
  // In the index, not the work tree: a file a sparse checkout leaves out still counts.
  git(["update-index", "--skip-worktree", "src/sparse.js"], { cwd: dir });
  put(dir, { "src/sparse.js": "" });
  const res = scanProject({ cwd: dir, env: {} });
  assert.deepEqual(res.bans, [
    { path: "CLAUDE.md", line: "- Never use `console.log` in src/.", literals: [{ text: "console.log", lines: 4, files: 3, examples: ["src/a.js", "src/b.js", "src/sparse.js"], gated: false }] },
    { path: "CLAUDE.md", line: "- Never commit `debugger`.", literals: [{ text: "debugger", lines: 0, files: 0, examples: [], gated: true }] },
    { path: "AGENTS.md", line: "- Do not call `console.log`.", literals: [{ text: "console.log", lines: 4, files: 3, examples: ["src/a.js", "src/b.js", "src/sparse.js"], gated: false }] },
  ]);
  const out = spawnSync(process.execPath, [CLI, "init-scan"], { cwd: dir, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^ {2}ban in CLAUDE\.md: "- Never use `console\.log` in src\/\." \(console\.log: 4 lines in 3 files, e\.g\. src\/a\.js, src\/b\.js, src\/sparse\.js\)$/m);
  assert.match(out.stdout, /^ {2}ban in CLAUDE\.md: "- Never commit `debugger`\." \(debugger: in no file, a review\.forbidden gate already\)$/m);
  const plain = mkdtempSync(join(tmpdir(), "en-fb-plain-"));
  put(plain, { "CLAUDE.md": "- Never use `eval`.\n" });
  const outside = scanProject({ cwd: plain, env: {} });
  assert.deepEqual(outside.bans, []);
  assert.deepEqual(outside.unmeasured.bans, [{ reason: "noRepo" }]);
  assert.deepEqual(outside.agentSetup.instructions[0].banLines, [{ line: "- Never use `eval`.", literals: ["eval"] }]);
});

test("init-scan: a git grep that says something on stderr is no count, whatever its exit (exit 1 is no match only when silent)", () => {
  const { dir, stage } = repo({});
  stage({ "src/a.js": "x\n" });
  const bin = mkdtempSync(join(tmpdir(), "en-fb-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const instructions = [{ path: "CLAUDE.md", loads: "always", banLines: [{ line: "- never use `eval`", literals: ["eval"] }] }];
  const PATH = process.env.PATH;
  try {
    for (const code of [0, 1]) {
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" grep "*) echo "warning: unable to read src/a.js" >&2; exit ${code} ;; esac\nexec "${real}" "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
      process.env.PATH = `${bin}${delimiter}${PATH}`;
      assert.throws(() => banMatches(dir, instructions, []), /unable to read src\/a\.js/, `exit ${code}`);
    }
  } finally {
    process.env.PATH = PATH;
  }
  assert.deepEqual(banMatches(dir, instructions, [])[0].literals[0], { text: "eval", lines: 0, files: 0, examples: [], gated: false });
  // A file name with a newline in it: git grep's NUL ends the name, not the line.
  stage({ "src/new\nline.js": "eval(1)\neval(2)\n", "src/b.js": "eval(3)\n" });
  assert.deepEqual(banMatches(dir, instructions, [])[0].literals[0], { text: "eval", lines: 3, files: 2, examples: ["src/b.js", "src/new\nline.js"], gated: false });
});

test("init-scan: every-session files' ban lines come first, a path-scoped rule's after", () => {
  const { dir, stage } = repo({});
  stage({ ".claude/rules/a.md": "---\npaths:\n  - src/**\n---\n- never use `aa`\n", ".claude/rules/b.md": "- never use `bb`\n" });
  assert.deepEqual(scanProject({ cwd: dir, env: {} }).bans?.map((b) => b.path), [".claude/rules/b.md", ".claude/rules/a.md"]);
});

test("doctor: review.forbidden with no hook warns; a glob in paths or except that names no tracked file warns", async () => {
  const { dir, stage } = repo({ review: { forbidden: [{ text: "x1", paths: ["src/**", "lib/**"], except: ["src/gone.js"] }] } });
  stage({ "src/a.js": "1\n" });
  const res = await checkSetup({ cwd: dir, env: {} });
  const keys = res.items.map((i) => [i.level, i.key]);
  assert.ok(keys.some(([l, k]) => l === "warn" && k === "doctor.hookMissing"), JSON.stringify(keys));
  assert.deepEqual(res.items.find((i) => i.key === "doctor.hookMissing")?.vars.rules, ["review.forbidden", "security.secrets"]);
  const dead = res.items.find((i) => i.key === "doctor.forbiddenUnmatched");
  assert.deepEqual(dead?.vars, { rule: 1, globs: ["lib/**", "src/gone.js"] });
  installHook({ cwd: dir, cliPath: CLI });
  assert.ok((await checkSetup({ cwd: dir, env: {} })).items.some((i) => i.key === "doctor.hookOk"));
});

test("doctor: per rule, the lines inside its paths that hold the text today, outside except and the config", async () => {
  const { dir, stage } = repo({ review: { forbidden: [{ text: "console.log", paths: ["src/**"], except: ["src/log.js"] }, { text: "debugger", paths: ["src/**"] }] } });
  stage({ "src/a.js": "console.log(1);\nconsole.log(2);\n", "src/log.js": "console.log(m);\n", "scripts/x.js": "console.log(3);\n", "CLAUDE.md": "- never use `console.log`\n" });
  const items = (await checkSetup({ cwd: dir, env: {} })).items.filter((i) => i.key.startsWith("doctor.forbidden"));
  assert.deepEqual(items, [
    { level: "warn", key: "doctor.forbiddenHeld", vars: { rule: 1, text: "console.log", lines: 2, files: 1, examples: ["src/a.js"] } },
    { level: "ok", key: "doctor.forbiddenClean", vars: { rule: 2, text: "debugger" } },
  ]);
});

// ------------------------------------------------------------- after review round two --

test("round two: a merge is checked whole; the other side's lines fail too, saying where to fix them, and a forged MERGE_HEAD changes no verdict", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [{ text: "debugger", paths: ["**"] }] } });
  installHook({ cwd: dir, cliPath: CLI });
  stage({ "a.js": "a\n" });
  assert.equal(commit("a").status, 0);
  git(["checkout", "-q", "-b", "side"], { cwd: dir });
  stage({ "a.js": "a\ndebugger;\n" });
  assert.equal(commit("side", "--no-verify").status, 0, "a commit no hook read");
  const side = git(["rev-parse", "--short", "HEAD"], { cwd: dir });
  git(["checkout", "-q", "main"], { cwd: dir });
  stage({ "b.js": "b\n" });
  assert.equal(commit("b").status, 0);
  const merge = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "side"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(merge.status, 0);
  assert.match(merge.stderr, /a\.js:2 adds "debugger".* The merge brings 1 of these lines from [0-9a-f]+: fix them on that branch, then merge again\./s);
  assert.ok(merge.stderr.includes(side) || /from [0-9a-f]{7,}/.test(merge.stderr));
  git(["merge", "--abort"], { cwd: dir });
  // A MERGE_HEAD written by hand that names an older commit holding the line: the line still counts.
  const old = git(["rev-parse", "side"], { cwd: dir });
  stage({ "a.js": "a\ndebugger;\n" });
  writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${old}\n`);
  const forged = commit("restore a");
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /a\.js:2 adds "debugger"/);
});

test("round two: only the files a rule names are diffed, so a big file elsewhere cannot turn the check off", () => {
  const { dir, stage, commit } = repo({ review: { forbidden: [RULE] } });
  stage({ "src/a.js": "1\n" });
  assert.equal(commit("first").status, 0);
  installHook({ cwd: dir, cliPath: CLI });
  // One line past git()'s 64 MB buffer, outside every rule's paths.
  put(dir, { "assets/blob.bin": Buffer.alloc(65 * 1024 * 1024, 0x61).toString("latin1") });
  stage({ "src/a.js": "1\nconsole.log(1);\n" });
  const r = commit("with a big file");
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /src\/a\.js:2 adds "console\.log"/);
  assert.doesNotMatch(r.stderr, /review\.forbidden was not checked/);
  // The secret scan reads every staged file: the big one alone is said, by name.
  assert.match(r.stderr, /security\.secrets was not checked in 1 staged path\(s\) \("assets\/blob\.bin"\): the lines they add are past the 64 MB the hook reads of a commit/);
});

test("round two: a glob's ** reaches names that hold a line break or a line separator", async () => {
  const { matchAny } = await import("../core/glob.mjs");
  for (const p of ["src/a\nb.js", "src/a\r.js", "src/util /a.js", "src/x y.js"]) {
    assert.ok(matchAny(p, ["src/**"]), JSON.stringify(p));
    assert.ok(matchAny(p, ["**"]), JSON.stringify(p));
  }
  assert.ok(!matchAny("lib/a\nb.js", ["src/**"]));
  assert.ok(!matchAny("src/a\nb.js", ["src/*.ts"]));
});

test("round two: with no config, a git that fails while the hook looks for one lets the commit through, saying so", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-fb-nocfg-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { ".git/MSG": "anything\n" });
  const bin = mkdtempSync(join(tmpdir(), "en-fb-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ls-files "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const r = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: dir, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /git failed \(.*injected.*\), so this commit was not checked/);
});

test("round two: doctor and the scan count lines in files git calls binary, as the hook reads them", async () => {
  const { dir, stage } = repo({ review: { forbidden: [{ text: "console.log", paths: ["src/**"] }] } });
  stage({ ".gitattributes": "*.min.js -diff\n", "src/lib.min.js": "console.log(1)\n", "src/mod.wasm": "\0asm console.log\n", "CLAUDE.md": "- never use `console.log`\n" });
  const held = (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key.startsWith("doctor.forbidden"));
  assert.deepEqual(held?.vars, { rule: 1, text: "console.log", lines: 2, files: 2, examples: ["src/lib.min.js", "src/mod.wasm"] });
  assert.deepEqual(scanProject({ cwd: dir, env: {} }).bans?.[0].literals[0], { text: "console.log", lines: 2, files: 2, examples: ["src/lib.min.js", "src/mod.wasm"], gated: true });
});

test("round two: many literals are counted in a few git calls, each its own count", () => {
  const { dir, stage } = repo({});
  const rules = Array.from({ length: 250 }, (_, i) => `- never use \`lit${i}x\``).join("\n");
  stage({ "CLAUDE.md": `${rules}\n`, "src/a.js": "lit7x lit7x\nlit8x lit7x\n", "src/b.js": "lit7x\nlit249x\n" });
  const bin = mkdtempSync(join(tmpdir(), "en-fb-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const log = join(bin, "calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" grep "*) echo x >> "${log}" ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const out = spawnSync(process.execPath, [CLI, "init-scan", "--json"], { cwd: dir, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const bans = JSON.parse(out.stdout).bans;
  assert.equal(bans.length, 250);
  const count = (/** @type {string} */ text) => bans.find((/** @type {any} */ b) => b.literals[0].text === text).literals[0];
  // A line that holds two literals counts for each.
  assert.deepEqual([count("lit7x").lines, count("lit7x").files, count("lit8x").lines, count("lit249x").files, count("lit0x").lines], [3, 2, 1, 1, 0]);
  assert.ok(readFileSync(log, "utf8").split("\n").filter(Boolean).length <= 3, "a few calls, not one a literal");
});

test("round two: commit-check run by hand outside a repository checks the message alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-fb-plain-"));
  put(dir, { MSG: "anything at all\n" });
  const r = spawnSync(process.execPath, [CLI, "commit-check", "MSG"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
});
