/**
 * Real git decides, the code must agree. The code's model of git drifted from git in two cycles running
 * (a missing -v case, a cut rule unlike git's, log output shaped by the user's config), each time with
 * hand-written fixtures that agreed with the code. Here git produces the expected values.
 *
 * 1. Commit messages: a matrix of how the message is given (-m, -F, the editor, -e), commit.cleanup, -v
 *    and commit.verbose, the comment marker and commit.status. The commit-msg hook runs hookCommitMode and
 *    storedMessage in its own environment; the result must equal what git stores. The cells a hook cannot
 *    see are listed with the reason, and each group must still diverge somewhere, or its entry goes.
 * 2. Log readers: each returns the same under a global config that reshapes git's output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { availableParallelism, tmpdir } from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "../core/git.mjs";
import { loadConfig } from "../core/config.mjs";
import { allowMarkerReason } from "../checks/commit-shape.mjs";
import { commitMessages, reworkRate } from "../metrics/szz.mjs";
import { bypassUses } from "../metrics/bypass.mjs";
import { recentCommits } from "../setup/scan.mjs";
import { buildImpactTable } from "../impact/table.mjs";

const run = promisify(execFile);
const SHAPE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "commit-shape.mjs")).href;
const ROOT = mkdtempSync(join(tmpdir(), "en-oracle-"));
const GLOBAL = join(ROOT, "gitconfig");
writeFileSync(GLOBAL, "");
mkdirSync(join(ROOT, "xdg"));
// No user or system config, no global ignore or attributes file, English hints: the matrix sets every
// value it depends on (test/hermetic.mjs cleared the rest). The readers take process.env, so it gets the same.
const CLEAN = { GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(ROOT, "xdg"), LC_ALL: "C" };
const ENV = { ...process.env, ...CLEAN };
Object.assign(process.env, CLEAN);
const [major, minor] = (/(\d+)\.(\d+)/.exec(git(["--version"], { cwd: ROOT, env: ENV })) ?? []).slice(1).map(Number);
/** core.commentString came with git 2.45; an older git ignores it. */
const COMMENT_STRING = major > 2 || (major === 2 && minor >= 45);

/** @param {string} s */
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** @param {string} path @param {string} body */
function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const SCISSORS = "------------------------ >8 ------------------------";

/**
 * Trailing spaces, blank runs, lines git may take for comments, and a scissors line typed by hand with
 * prose under it.
 * @param {string} marker @param {boolean} crlf
 */
function message(marker, crlf) {
  const m = `feat: subject  \n\n\nbody line\t\n# hash line\n; semi line\n// slash line\n\n\n${marker} ${SCISSORS}\nprose under a typed line\n`;
  return crlf ? m.replace(/\n/g, "\r\n") : m;
}

/**
 * source "tail": the editor types the message above git's template and a scissors line with text at the
 * end, under git's own line. status: the template is shown (true) or not (the config value, or the flag).
 * @typedef {{ source: "m" | "F" | "editor" | "m+e" | "tail", cleanup: string | null, verbose: "none" | "-v" | "config" | "config2" | "no-verbose", comment: "#" | ";" | "auto" | "AUTO" | "//" | "%@", status: true | "false" | "0" | "--no-status", crlf: boolean, empty?: boolean, locale?: string, template?: "plain" | "cut" }} Cell
 */

/** @type {Cell[]} */
const CELLS = [];
const add = (/** @type {Partial<Cell> & Pick<Cell, "source" | "cleanup" | "verbose">} */ c) => {
  const cell = /** @type {Cell} */ ({ comment: "#", status: true, crlf: false, ...c });
  if (COMMENT_STRING || !["//", "%@"].includes(cell.comment)) CELLS.push(cell);
};
const CLEANUPS = [null, "default", "strip", "whitespace", "verbatim", "scissors"];
const VERBOSE = /** @type {const} */ (["none", "-v", "config", "no-verbose"]);
// How the message is given × cleanup × verbose, git's defaults otherwise. -F reads like -m to git and to a
// hook; it comes in with CRLF below. "default" is the unset mode spelled out.
for (const source of /** @type {const} */ (["m", "editor", "m+e"])) {
  for (const cleanup of CLEANUPS) for (const verbose of VERBOSE) if (cleanup !== "default" || verbose === "none") add({ source, cleanup, verbose });
}
// Other comment markers where they matter: what strip drops, which scissors line counts, what auto picks
// (with -e, from the -m text: git's template line shows it).
for (const comment of /** @type {const} */ ([";", "auto", "//"])) {
  const sources = /** @type {const} */ (comment === "auto" ? ["m", "editor", "m+e"] : ["m", "editor"]);
  for (const source of sources) for (const cleanup of [null, "strip", "whitespace", "scissors"]) for (const verbose of /** @type {const} */ (["none", "-v"])) add({ comment, source, cleanup, verbose });
}
// No status template in the editor: commit.status false or 0, or --no-status.
for (const status of /** @type {const} */ (["false", "--no-status"])) {
  for (const comment of /** @type {const} */ (["#", "auto"])) {
    for (const source of /** @type {const} */ (["editor", "m+e"])) for (const cleanup of [null, "scissors"]) for (const verbose of VERBOSE) add({ comment, source, cleanup, verbose, status });
  }
}
for (const verbose of /** @type {const} */ (["none", "config"])) add({ source: "editor", cleanup: null, verbose, status: "0" });
// A commit.template file with a line that is the marker alone, which the status template has too; one
// also ends in a scissors line with only a comment under it, as git's own has.
for (const status of /** @type {const} */ ([true, "false", "0"])) for (const comment of /** @type {const} */ (["#", "auto"])) add({ source: "editor", cleanup: null, verbose: "config", comment, status, template: "plain" });
for (const status of /** @type {const} */ ([true, "false"])) add({ source: "editor", cleanup: "whitespace", verbose: "none", status, template: "cut" });
// A scissors line typed under git's own: git cuts at the first line.
for (const cleanup of [null, "whitespace"]) for (const verbose of /** @type {const} */ (["none", "-v"])) add({ source: "tail", cleanup, verbose });
// "AUTO" is auto; of commentString and commentChar the last one set wins.
for (const source of /** @type {const} */ (["m", "editor", "m+e"])) for (const cleanup of [null, "strip"]) add({ comment: "AUTO", source, cleanup, verbose: "none" });
for (const source of /** @type {const} */ (["m", "editor"])) for (const cleanup of [null, "strip"]) for (const verbose of /** @type {const} */ (["none", "-v"])) add({ comment: "%@", source, cleanup, verbose });
// A translated template (where git has the translation; else git writes English and the cells still hold).
for (const comment of /** @type {const} */ (["#", "auto"])) {
  for (const source of /** @type {const} */ (["editor", "m+e"])) for (const verbose of /** @type {const} */ (["none", "-v"])) add({ comment, source, cleanup: null, verbose, locale: "tr_TR.UTF-8" });
}
// CRLF line ends, from a file or the editor.
for (const source of /** @type {const} */ (["F", "editor"])) for (const cleanup of [null, "strip", "whitespace", "verbatim", "scissors"]) add({ source, cleanup, verbose: "none", crlf: true });
for (const cleanup of ["strip", "whitespace"]) add({ source: "editor", cleanup, verbose: "-v", crlf: true });
// commit.verbose=2 (-vv), and -v on an empty commit: git's line with no diff under it.
for (const source of /** @type {const} */ (["m", "editor"])) add({ source, cleanup: "whitespace", verbose: "config2" });
for (const cleanup of [null, "whitespace"]) add({ source: "editor", cleanup, verbose: "-v", empty: true });

/** @param {Cell} c */
const usesEditor = (c) => c.source === "editor" || c.source === "m+e" || c.source === "tail";

/** What a hook cannot see. Each entry must still match a diverging cell. */
const UNSEEN = [
  {
    why: "-v or --no-verbose on the command line, with -m / -F or without the status template: neither the message nor the config shows it",
    when: (/** @type {Cell} */ c) => (c.verbose === "-v" || c.verbose === "no-verbose") && (!usesEditor(c) || c.status !== true),
  },
  {
    why: "core.commentChar=auto in the editor without the status template: git chose the marker before the editor, from text the hook does not see",
    when: (/** @type {Cell} */ c) => c.comment.toLowerCase() === "auto" && usesEditor(c) && c.status !== true,
  },
];

/** @param {Cell} c */
function settings(c) {
  const out = [];
  if (c.cleanup) out.push(`commit.cleanup=${c.cleanup}`);
  if (c.verbose === "config" || c.verbose === "no-verbose") out.push("commit.verbose=true");
  if (c.verbose === "config2") out.push("commit.verbose=2");
  if (c.comment === "//") out.push("core.commentString=//");
  else if (c.comment === "%@") out.push("core.commentString=%", "core.commentChar=@");
  else if (c.comment !== "#") out.push(`core.commentChar=${c.comment}`);
  if (c.status === "false" || c.status === "0") out.push(`commit.status=${c.status}`);
  if (c.template) out.push(`commit.template=${TEMPLATES[c.template]}`);
  return out;
}

const TEMPLATES = { plain: join(ROOT, "template-plain.txt"), cut: join(ROOT, "template-cut.txt") };
writeFileSync(TEMPLATES.plain, "# <type>: <subject>\n#\n# Why\n");
writeFileSync(TEMPLATES.cut, `# <type>: <subject>\n#\n# ${SCISSORS}\n# Nothing below this line.\n`);

/** The marker the user types: git's, or "#" when git picks it. @param {Cell} c */
const typed = (c) => ({ auto: "#", AUTO: "#", "%@": "@" })[c.comment] ?? c.comment;

/**
 * One repository; commits the cells in order. The commit-msg hook writes what Ennyn's hook would decide.
 * @param {Cell[]} cells
 */
async function commitAll(cells) {
  const dir = mkdtempSync(join(ROOT, "repo-"));
  const g = (/** @type {string[]} */ ...args) => git(args, { cwd: dir, env: ENV });
  g("init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) g("config", k, v);
  writeFileSync(join(dir, "f.txt"), "0\n");
  g("add", "f.txt");
  g("commit", "-q", "-m", "base");
  // The hook is the node script itself when the shebang can name node (no space in the path), else sh runs it.
  // Dynamic imports: Node 20 reads the extensionless hook as CommonJS.
  const hook = join(dir, ".git", "hooks", "commit-msg");
  const direct = !/\s/.test(process.execPath);
  const view = direct ? hook : join(dir, ".git", "view.mjs");
  writeFileSync(
    view,
    [
      ...(direct ? [`#!${process.execPath}`] : []),
      `Promise.all([import("node:fs"), import(${JSON.stringify(SHAPE)})]).then(([{ readFileSync, writeFileSync }, { hookCommitMode, storedMessage }]) => {`,
      `  const message = readFileSync(process.argv[2], "utf8");`,
      `  const mode = hookCommitMode({ cwd: process.cwd(), message, env: process.env });`,
      `  writeFileSync(process.env.CAPTURE ?? "", JSON.stringify({ mode, stored: storedMessage(message, mode.cleanup, mode.comment, mode.cut) }));`,
      `});`,
    ].join("\n"),
  );
  if (direct) chmodSync(hook, 0o755);
  else script(hook, `exec ${q(process.execPath)} ${q(view)} "$1"`);
  // The editor types the message above git's template; with -e it saves what -m gave (true, not ":").
  const prepend = script(join(dir, ".git", "prepend.sh"), `cat "$MSG" "$1" > "$1.new" && mv "$1.new" "$1"`);
  const tail = script(join(dir, ".git", "tail.sh"), `cat "$MSG" "$1" "$TAIL" > "$1.new" && mv "$1.new" "$1"`);
  const keep = "true";
  const file = join(dir, ".git", "message.txt");
  const out = [];
  for (const [i, c] of cells.entries()) {
    if (!c.empty) writeFileSync(join(dir, "f.txt"), `${i + 1}\n`);
    const text = message(typed(c), c.crlf);
    writeFileSync(file, text);
    writeFileSync(join(dir, ".git", "tail.txt"), `${typed(c)} ${SCISSORS}\ntyped under git's line\n`);
    const given = { m: ["-m", text], F: ["-F", file], editor: [], "m+e": ["-e", "-m", text], tail: [] }[c.source];
    const flags = [
      ...(c.verbose === "-v" ? ["-v"] : c.verbose === "no-verbose" ? ["--no-verbose"] : []),
      ...(c.status === "--no-status" ? ["--no-status"] : []),
      ...(c.empty ? ["--allow-empty"] : []),
    ];
    const capture = join(dir, ".git", `cell-${i}.json`);
    const args = [...settings(c).flatMap((s) => ["-c", s]), "commit", "-q", "-a", ...flags, ...given];
    const editor = { editor: prepend, tail }[/** @type {string} */ (c.source)] ?? keep;
    const env = { ...ENV, MSG: file, TAIL: join(dir, ".git", "tail.txt"), CAPTURE: capture, GIT_EDITOR: editor, ...(c.locale ? { LC_ALL: c.locale } : {}) };
    await run("git", args, { cwd: dir, env });
    const { stdout } = await run("git", ["cat-file", "commit", "HEAD"], { cwd: dir, env: ENV });
    out.push({ cell: c, stored: stdout.slice(stdout.indexOf("\n\n") + 2), hook: JSON.parse(readFileSync(capture, "utf8")) });
  }
  return out;
}

test("oracle: the commit-msg hook computes the message git stores, in every cell a hook can see", async () => {
  const n = Math.max(1, Math.min(8, availableParallelism()));
  const parts = Array.from({ length: n }, (_, k) => CELLS.filter((_, i) => i % n === k));
  const results = (await Promise.all(parts.map(commitAll))).flat();
  assert.equal(results.length, CELLS.length);
  // git ends a stored message with a newline; storedMessage leaves it off.
  const diverges = (/** @type {{ stored: string, hook: { stored: string } }} */ r) => r.hook.stored.replace(/\n$/, "") !== r.stored.replace(/\n$/, "");
  const wrong = results
    .filter((r) => !UNSEEN.some((u) => u.when(r.cell)) && diverges(r))
    .map((r) => `${JSON.stringify(r.cell)} ${JSON.stringify(r.hook.mode)}\n  hook: ${JSON.stringify(r.hook.stored)}\n  git:  ${JSON.stringify(r.stored)}`);
  assert.deepEqual(wrong, []);
  for (const u of UNSEEN) assert.ok(results.some((r) => u.when(r.cell) && diverges(r)), `no cell diverges any more, drop the entry: ${u.why}`);
});

/** Settings that reshape what git prints; each one has misled a parser here or in another tool. */
const HOSTILE = {
  "log.showSignature": "true",
  "i18n.logOutputEncoding": "ISO-8859-9",
  "diff.interHunkContext": "3",
  "color.ui": "always",
  "core.quotePath": "true",
  "diff.noprefix": "true",
  "diff.mnemonicPrefix": "true",
  "diff.renames": "copies",
  "diff.relative": "true",
  "diff.suppressBlankEmpty": "true",
  "log.decorate": "full",
  "log.abbrevCommit": "true",
  "log.date": "relative",
  "format.pretty": "fuller",
  "blame.markIgnoredLines": "true",
  "blame.markUnblamableLines": "true",
  "diff.algorithm": "histogram",
  "diff.indentHeuristic": "false",
  "log.follow": "true",
  "log.showRoot": "false",
};
/** The same through the environment. */
const HOSTILE_ENV = { GIT_DIFF_OPTS: "-u3", GIT_ICASE_PATHSPECS: "1" };

test("oracle: the log readers return what git stores, under a global config that reshapes git's output", () => {
  const dir = mkdtempSync(join(ROOT, "readers-"));
  const g = (/** @type {string[]} */ ...args) => git(args, { cwd: dir, env: ENV });
  g("init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) g("config", k, v);
  // Signed commits, so log.showSignature has something to print (an ssh-keygen that can sign: OpenSSH 8.1+).
  const key = join(ROOT, "signing-key");
  writeFileSync(join(ROOT, "probe.txt"), "x");
  if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status === 0 && spawnSync("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", key, join(ROOT, "probe.txt")]).status === 0) {
    for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", key], ["commit.gpgsign", "true"]]) g("config", k, v);
  }
  let day = 0;
  /** @param {string} text @param {Record<string, string>} files @param {string} [cleanup] */
  const commit = (text, files, cleanup = "verbatim") => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const date = new Date(Date.UTC(2026, 0, 1 + day++, 12, 0, 0)).toISOString();
    writeFileSync(join(dir, ".git", "message.txt"), text);
    g("add", "-A");
    git(["commit", "-q", `--cleanup=${cleanup}`, "-F", join(dir, ".git", "message.txt")], { cwd: dir, env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return g("rev-parse", "HEAD");
  };
  const A = ["export const one = 1;", "export const two = 2;", "export const three = 3;"];
  const a = commit("feat: one to three\n\nTürkçe gövde: ışık, şey, İki", { "src/a.js": [...A, ""].join("\n") });
  const b = commit("feat: four\r\n\r\ncommit 0123456789abcdef0123456789abcdef01234567\r\n", { "src/a.js": [...A, "export const four = 4;", ""].join("\n"), "src/use.js": 'import { one } from "./a.js";\nexport const y = one;\n' });
  // A commit a blame.ignoreRevsFile list would skip.
  const fmt = commit("chore: name two", { "src/a.js": [A[0], "export const two = 2; // two", A[2], "export const four = 4;", ""].join("\n") });
  // Two hunks, one unchanged line apart: inter-hunk context would join them.
  const fix = commit("düzeltme: bir, iki ve dört", { "src/a.js": ["export const one = 10;", "export const two = 20;", A[2], "export const four = 40;", ""].join("\n") }, "strip");
  // A file name that is a glob unless the pathspec is literal: "src/[id].js" also matches "src/i.js".
  const c = commit("feat: id", { "src/[id].js": "export const id = 1;\n" });
  const d = commit("feat: i", { "src/i.js": "export const i = 1;\n" });
  const fix2 = commit("fix: id and i", { "src/[id].js": "export const id = 2;\n", "src/i.js": "export const i = 2;\n" });
  // Diffs that git's default algorithm and heuristic read one way and histogram / no indent heuristic
  // another: myers deletes only brackets here, histogram a code line; the heuristic picks line 1 over line 4.
  const e = commit("feat: h", { "src/h.js": ["return a + b;", "}", "export const a = 1;", "}", ""].join("\n") });
  const fix3 = commit("fix: h", { "src/h.js": ["return a + b;", "return a + b;", "export const a = 1;", "return a + b;", "}", ""].join("\n") });
  const F = "export function f() {";
  const g1 = commit("feat: k", { "src/k.js": [F, "  }", "}", ""].join("\n") });
  const g2 = commit("feat: k more", { "src/k.js": [F, "  }", "}", F, F, ""].join("\n") });
  const fix4 = commit("fix: k", { "src/k.js": [F, F, ""].join("\n") });
  const allowed = commit("feat: shape\n\n[commit-shape-allow: İngilizce değil, gerekçe burada]\n\n\n", { "b.txt": "1\n" });
  const odd = commit("feat: control \x01\x1e\x1f characters\n\n", { "c.txt": "1\n" });
  const hashes = [a, b, fmt, fix, c, d, fix2, e, fix3, g1, g2, fix4, allowed, odd];
  // Every byte git stored: the git helper drops the last newline of its output.
  const raw = (/** @type {string} */ h) => {
    const text = spawnSync("git", ["cat-file", "commit", h], { cwd: dir, env: ENV, encoding: "utf8" }).stdout;
    return text.slice(text.indexOf("\n\n") + 2);
  };
  const config = loadConfig({ cwd: mkdtempSync(join(ROOT, "cfg-")), env: {}, override: { metrics: { minLines: 1, fixSubject: "^(fix|düzeltme)(\\(|:)" }, impact: { coChangeMin: 1 } } });
  const read = () => ({
    messages: Object.fromEntries(commitMessages(dir, hashes)),
    bypass: bypassUses({ cwd: dir, config }).uses.map((u) => [u.hash, u.subject, u.reason]),
    rework: reworkRate({ cwd: dir, days: 7, config }).pairs.map((p) => [p.origin, p.fix, p.lines, Number(p.share.toFixed(3))]),
    scan: recentCommits(dir),
    impact: buildImpactTable({ cwd: dir, config, symbol: "one", files: ["src/a.js"] }).rows.map((r) => r.answer),
  });

  const clean = read();
  // The readers against git itself: cat-file holds the stored bytes.
  assert.deepEqual(clean.messages, Object.fromEntries(hashes.map((h) => [h, raw(h)])));
  assert.deepEqual(clean.bypass, [[allowed, "feat: shape", allowMarkerReason(raw(allowed), config.commitMsg.allowMarker)]]);
  // origin, fix, lines blamed on the origin, their share of the fix's deleted lines
  const pair = (/** @type {unknown[]} */ p) => p.join(" ");
  const third = 0.333;
  assert.deepEqual(new Set(clean.rework.map(pair)), new Set([`${a} ${fix} 1 ${third}`, `${fmt} ${fix} 1 ${third}`, `${b} ${fix} 1 ${third}`, `${c} ${fix2} 1 0.5`, `${d} ${fix2} 1 0.5`, `${g1} ${fix4} 1 1`]));
  assert.deepEqual(clean.scan.at(-1), { subject: "feat: one to three", paths: ["src/a.js"] });
  assert.match(clean.impact[0], /^references: 2 references in 1 files .*: src\/use\.js:1,2\n.*\nco-change: src\/use\.js \(1 commit/);

  const hostile = join(ROOT, "hostile-gitconfig");
  const ignored = join(ROOT, "ignore-revs");
  writeFileSync(ignored, `${fmt}\n`);
  for (const [k, v] of Object.entries({ ...HOSTILE, "blame.ignoreRevsFile": ignored, "diff.alg.algorithm": "histogram" })) git(["config", "--file", hostile, k, v], { cwd: dir, env: ENV });
  // A diff driver with its own algorithm, named by the repository's attributes.
  writeFileSync(join(dir, ".git", "info", "attributes"), "*.js diff=alg\n");
  Object.assign(process.env, HOSTILE_ENV, { GIT_CONFIG_GLOBAL: hostile });
  try {
    assert.deepEqual(read(), clean);
    // A list that names a missing file stops git blame itself: an error, never a rate without those lines.
    git(["config", "--file", hostile, "blame.ignoreRevsFile", join(ROOT, "missing-revs")], { cwd: dir, env: ENV });
    assert.throws(() => reworkRate({ cwd: dir, days: 7, config }), /could not open object name list/);
  } finally {
    for (const k of Object.keys(HOSTILE_ENV)) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = GLOBAL;
  }
});

test("oracle: in a shallow clone the rework rate blames no commit at its edge", () => {
  const src = mkdtempSync(join(ROOT, "deep-"));
  const g = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => git(args, { cwd, env: ENV });
  g(src, "init", "-q", "-b", "main");
  const commit = (/** @type {number} */ day, /** @type {string} */ message, /** @type {Record<string, string>} */ files) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(src, path), content);
    const date = new Date(Date.UTC(2026, 0, 1 + day, 12, 0, 0)).toISOString();
    g(src, "add", "-A");
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: src, env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return g(src, "rev-parse", "HEAD");
  };
  const origin = commit(0, "feat: rule", { "rule.js": "export const limit = 1;\nexport const other = 2;\n" });
  commit(1, "feat: unrelated", { "other.js": "export const x = 1;\n" });
  const fix = commit(2, "fix: limit", { "rule.js": "export const limit = 5;\nexport const other = 2;\n" });
  const config = loadConfig({ cwd: mkdtempSync(join(ROOT, "cfg-")), env: {}, override: { metrics: { minLines: 1 } } });
  assert.deepEqual(reworkRate({ cwd: src, days: 7, config }).pairs.map((p) => [p.origin, p.fix]), [[origin, fix]]);
  // Two commits deep: "feat: unrelated" is the edge, and git blames the old line on it. The edge is
  // censored, not a clean candidate.
  const shallow = join(mkdtempSync(join(ROOT, "shallow-")), "clone");
  git(["clone", "-q", "--depth", "2", pathToFileURL(src).href, shallow], { cwd: ROOT, env: ENV });
  const res = reworkRate({ cwd: shallow, days: 7, config });
  assert.deepEqual([res.pairs, res.commits, res.censored, res.shallow], [[], 1, 1, true], "the result says the clone is shallow");
  assert.equal(reworkRate({ cwd: src, days: 7, config }).shallow, false);
  // A full clone of main with another branch fetched one commit deep: HEAD's history is whole.
  g(src, "checkout", "-q", "-b", "side");
  commit(3, "feat: side", { "side.js": "export const s = 1;\n" });
  g(src, "checkout", "-q", "-");
  const mixed = join(mkdtempSync(join(ROOT, "mixed-")), "clone");
  git(["clone", "-q", "--single-branch", pathToFileURL(src).href, mixed], { cwd: ROOT, env: ENV });
  git(["fetch", "-q", "--depth", "1", "origin", "side:side"], { cwd: mixed, env: ENV });
  assert.ok(readFileSync(join(mixed, ".git", "shallow"), "utf8").trim(), "the side branch is shallow");
  assert.equal(reworkRate({ cwd: mixed, days: 7, config }).shallow, false);
});
