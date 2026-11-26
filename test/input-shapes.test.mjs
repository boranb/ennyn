/**
 * The commit-msg hook fed every input shape it may not read: content git calls binary, text in UTF-16, UTF-32
 * or an encoding that is not UTF-8, decomposed letters, line ends; names with odd bytes, line breaks, quotes,
 * backslashes and glob characters, decomposed names under a glob written composed; links, submodules,
 * merges, a replace ref, a file past git()'s buffer, what a clean filter or working-tree-encoding puts in the
 * index; given by `-m`, `commit -a` and `commit -- <path>`. Every cell is a real `git commit` with the hook
 * installed. A cell whose commit would put a review.forbidden literal into
 * history (or a path that needs an Impact line, without one) must be refused, naming the path, or go
 * through saying it was not checked; a cell with nothing to refuse must land. A silent pass is the defect
 * this matrix exists for: a check that passes on an input shape it cannot read. A known one is a `gap`
 * cell: it must pass in silence until it is fixed, so the list of what is left stays true. Each cell's exact
 * verdict (refused, said, or a silent pass) is recorded in test/verdicts/input-shapes.json (test/verdicts.mjs):
 * a cell whose verdict moves fails, refused turned said too, until the record changes in the same commit.
 *
 * Cycle 2026-10-23 (7) found this class about 12 times, all by reviewers: binary attributes, NUL bytes,
 * core.bigFileThreshold, an empty message, a clean git cannot see, NFD and non-UTF-8 names, names with line
 * breaks, an index from outside, a config not in the work tree, UTF-16.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installHook } from "../plugin/setup/hook.mjs";
import { checkCommitShape, forbiddenScan } from "../plugin/checks/commit-shape.mjs";
import { loadConfig } from "../plugin/core/config.mjs";
import { decodeWide, wideEncoding, wideLines } from "../plugin/core/encoding.mjs";
import { git, gitBytes, gitError, stagedAddedLines, stagedPaths } from "../plugin/core/git.mjs";
import { matchAny } from "../plugin/core/glob.mjs";
import { shown } from "../plugin/core/i18n.mjs";
import { indexMatches } from "../plugin/setup/scan.mjs";
import { TOKENS, body, pem } from "./secret-shapes.mjs";
import { moves, movesText, readCells } from "./verdicts.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "ennyn.mjs");
const run = promisify(execFile);
/** What the hook says when it let a commit through unchecked: the fault matrix's words. */
export const SAYS = /unmeasured|could not be (measured|read|applied|reset)|was not checked/i;
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

const LOG = "console.log";
const CJK = "çöp";
const RULES = [
  { text: LOG, paths: ["src/**"], except: ["src/allowed/**"] },
  { text: CJK, paths: ["src/**"] },
  { text: LOG, paths: ["dök/**"] },
  { text: "\u4e00", paths: ["han/**"] },
  { text: "\u6f22\u5b57", paths: ["han/**"] },
  { text: LOG, paths: ["exc/**"], except: ["exc/ok/**"] },
  { text: "\u4e0a\u6d77", paths: ["sh/**"] },
];
const IMPACT = ["imp/**", "ımp-ü/**"];

/** @param {string} s @param {"utf16le" | "utf16be"} enc @param {boolean} bom */
function utf16(s, enc, bom) {
  const le = Buffer.from(s, "utf16le");
  const out = enc === "utf16le" ? le : Buffer.from(le).swap16();
  return Buffer.concat([bom ? Buffer.from(enc === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff]) : Buffer.alloc(0), out]);
}

/** @param {string} s @param {"utf32le" | "utf32be"} enc @param {boolean} bom */
function utf32(s, enc, bom) {
  const units = [...(bom ? "\ufeff" : ""), ...s].map((c) => {
    const b = Buffer.alloc(4);
    if (enc === "utf32le") b.writeUInt32LE(/** @type {number} */ (c.codePointAt(0)));
    else b.writeUInt32BE(/** @type {number} */ (c.codePointAt(0)));
    return b;
  });
  return Buffer.concat(units);
}

/**
 * A cell: files staged into the index (by name bytes, mode and content; `worktree` files go through
 * `git add`, so filters and attributes apply), the commit's verdict (`refused` with the text the refusal
 * must name, or `landed`, with the warning it must give in `warns`). `before`: files committed first, past
 * the hook, and unstaged again (a move). `side`: files a branch commits past the hook, merged in by
 * `git merge`, which runs the hook; `files` are then the merge's own resolution. `via`: the file is tracked
 * first and its change given by `commit -a` or `commit -- <path>` (a temporary index). `replace`: HEAD is
 * replaced (`git replace`) by a commit whose tree already holds the file, or (`"blob"`) HEAD's blob of the file
 * by one that holds its new text; `staged`: for `via`, what the main index holds, other than the work tree.
 * `base`: files committed first, past the hook, and kept. `env`: more environment for the commit. `gap`: a
 * known silent pass.
 * `strict`: refused, and saying what was not checked is not enough (the shape it holds beside the path is
 * no reason to stop checking the rest). `unsaid`: a text the hook must not print (a check that has nothing to
 * say about the cell, while another check says it).
 * @typedef {{ name: string | Buffer, data?: string | Buffer | (() => Buffer), mode?: "100644" | "120000" | "160000", worktree?: boolean }} CellFile
 * @typedef {{ id: string, files: CellFile[], want: "refused" | "landed", names?: string, warns?: string, before?: CellFile[], base?: CellFile[], side?: CellFile[], via?: "all" | "path", staged?: string | Buffer, replace?: "commit" | "blob", env?: Record<string, string>, gap?: boolean, strict?: boolean, unsaid?: string }} Cell
 */

/** @type {Cell[]} */
const CELLS = [];
/** @param {string} id @param {CellFile[]} files @param {string} [names] the path the refusal names @param {Partial<Cell>} [more] */
const refused = (id, files, names, more = {}) => CELLS.push({ id, files, want: "refused", names: names ?? String(files[0].name), ...more });
/** @param {string} id @param {CellFile[]} files @param {Partial<Cell>} [more] */
const landed = (id, files, more = {}) => CELLS.push({ id, files, want: "landed", ...more });

// Content: the literal present (refused) and absent (landed), one cell each.
/** @type {[string, (body: string) => string | Buffer, string][]} */
const CONTENT = [
  ["utf8", (b) => `a\n${b}\n`, "txt"],
  ["no-eol", (b) => `a\n${b}`, "txt"],
  ["crlf", (b) => `a\r\n${b}\r\n`, "txt"],
  ["nul", (b) => `\0\x01${b}\0\n`, "dat"],
  ["binary-attr", (b) => `a\n${b}\n`, "bin"],
  ["no-diff-attr", (b) => `a\n${b}\n`, "nodiff"],
  ["textconv", (b) => `a\n${b}\n`, "tc"],
  ["utf16le-bom", (b) => utf16(`a\n${b}\n`, "utf16le", true), "txt"],
  ["utf16le", (b) => utf16(`a\n${b}\n`, "utf16le", false), "txt"],
  ["utf16be-bom", (b) => utf16(`a\n${b}\n`, "utf16be", true), "txt"],
  ["utf16be", (b) => utf16(`a\n${b}\n`, "utf16be", false), "txt"],
  ["utf32le-bom", (b) => utf32(`a\n${b}\n`, "utf32le", true), "txt"],
  ["utf32le", (b) => utf32(`a\n${b}\n`, "utf32le", false), "txt"],
  ["utf32be-bom", (b) => utf32(`a\n${b}\n`, "utf32be", true), "txt"],
  ["utf32be", (b) => utf32(`a\n${b}\n`, "utf32be", false), "txt"],
  ["latin1", (b) => Buffer.from(`café\n${b}\n`, "latin1"), "txt"],
];
for (const [shape, make, ext] of CONTENT) {
  refused(`${shape}-ascii`, [{ name: `src/${shape}-ascii/f.${ext}`, data: make(`x(${LOG}(1))`) }]);
  landed(`${shape}-clean`, [{ name: `src/${shape}-clean/f.${ext}`, data: make("x(log(1))") }]);
}
// A literal with letters outside ASCII, in every encoding a file may be stored in.
for (const [shape, make, ext] of CONTENT.filter(([s]) => s !== "latin1")) refused(`${shape}-cjk`, [{ name: `src/${shape}-cjk/f.${ext}`, data: make(`bir ${CJK} daha`) }]);
refused("latin1-cjk", [{ name: "src/latin1-cjk/f.txt", data: Buffer.from(`bir ${CJK} daha\n`, "latin1") }]);
refused("cp1254-cjk", [{ name: "src/cp1254-cjk/f.txt", data: Buffer.from([0x62, 0x69, 0x72, 0x20, 0xe7, 0xf6, 0x70, 0x20, 0xfe, 0x0a]) }]);
// A secret (security.secrets, on for every path), in every encoding a file may be stored in, where no forbidden
// rule reads: every shape the scan reads is ASCII, so it is found in each, and none is said.
const SECRET = `t = ${TOKENS.npm}`;
for (const [shape, make, ext] of CONTENT) refused(`${shape}-secret`, [{ name: `lib/${shape}-secret/f.${ext}`, data: make(SECRET) }], undefined, { strict: true });
// Past the budget, the scan asks by pathspec for the files a commit changes: a name that is not UTF-8 cannot be
// asked, so that file is read by its objects instead (cycle 13), and the big file is said. (A file the commit adds
// is read by its object, whatever its name.)
refused("secret-name-not-utf8-asked", [{ name: "lib/big-s/blob.txt", data: () => Buffer.alloc(65 * 1024 * 1024, 0x61) }, { name: Buffer.from([...Buffer.from("lib/bad-s2/"), 0xff, ...Buffer.from(".js")]), data: `a\n${SECRET}\n` }], "lib/bad-s2/", { base: [{ name: Buffer.from([...Buffer.from("lib/bad-s2/"), 0xff, ...Buffer.from(".js")]), data: "a\n" }], warns: "past the 64 MB" });
landed("secret-past-budget", [{ name: "lib/past/big.txt", data: () => Buffer.alloc(65 * 1024 * 1024, 0x61) }], { warns: "security.secrets was not checked in 1 staged path" });
// A name that is not UTF-8: the diff with no pathspec reads it, so it is refused, not said.
refused("secret-name-not-utf8", [{ name: Buffer.from([...Buffer.from("lib/bad-s/"), 0xff, ...Buffer.from(".js")]), data: `${SECRET}\n` }], "lib/bad-s/", { strict: true });
refused("secret-merge-side", [], "lib/merge-s/a.js", { side: [{ name: "lib/merge-s/a.js", data: `${SECRET}\n` }], strict: true });
// A key replaced under the header the commit keeps: only its body lines are added, and the file is read whole.
const KEY = pem("RSA PRIVATE KEY");
refused("key-body-only", [{ name: "lib/key/k.pem", data: [KEY.begin, ...body(4, 61), KEY.end, ""].join("\n") }], "lib/key/k.pem:2", { base: [{ name: "lib/key/k.pem", data: [KEY.begin, ...body(4, 71), KEY.end, ""].join("\n") }], strict: true });
// A token beside NULs in a binary, as a compiler lays out its strings.
refused("secret-c-strings", [{ name: "lib/tool/a.out", data: Buffer.concat([Buffer.from("\x7fELF\0\0usage"), Buffer.from([0]), Buffer.from(TOKENS.github), Buffer.from([0]), Buffer.from("version\0")]) }], undefined, { strict: true });
// A commit that deletes a file past what the hook reads: it adds nothing, so nothing is said.
landed("delete-huge", [], { before: [{ name: "lib/del/big.txt", data: () => Buffer.alloc(70 * 1024 * 1024, 0x61) }], unsaid: "not checked" });

// Decomposed letters spell the same text, also mixed with composed ones in UTF-16; a match as written stays
// one where composing the line changes it (g and a combining breve, p and a combining acute).
refused("nfd-content", [{ name: "src/nfd-content/f.txt", data: `bir ${CJK.normalize("NFD")}\n` }]);
refused("mixed-nf-utf16", [{ name: "src/mixed-nf/f.txt", data: utf16("bir ço\u0308p\n", "utf16le", true) }]);
refused("raw-only", [{ name: "src/raw-only/f.txt", data: `x(console.log\u0306(1))\n` }]);
refused("raw-only-cjk", [{ name: "src/raw-only-cjk/f.txt", data: `bir ${CJK}\u0301\n` }]);
refused("raw-only-utf16", [{ name: "src/raw-only-utf16/f.txt", data: utf16("x(console.log\u0306(1))\n", "utf16le", true) }]);
// A UTF-16 line numbered as an editor numbers it: U+4E0A holds a newline byte, which git counts as a line.
refused("utf16-line", [{ name: "src/utf16-line/f.txt", data: utf16("\u4e0a\u6d77\u4e0a\u6d77\nconsole.log(1)\n", "utf16le", false) }], "src/utf16-line/f.txt:2 adds");
// UTF-16 read in one byte order: "NOTE" in UTF-16LE holds the bytes of U+4E00 in the other.
landed("utf16-one-order", [{ name: "han/note.txt", data: utf16("NOTE\n", "utf16le", true) }]);
// A byte order mark alone makes the file UTF-16, with no NUL in it.
refused("utf16-mark-han", [{ name: "han/b.txt", data: utf16("\u6f22\u5b57", "utf16le", true) }], "han/b.txt:1", { strict: true });
// Known gap: UTF-16 with no byte order mark, no NUL and no line end (letters outside Latin) is read as bytes.
refused("utf16-no-mark-han", [{ name: "han/a.txt", data: Buffer.from("\u6f22\u5b57", "utf16le") }], "han/a.txt", { gap: true });
// A binary file's NUL line says nothing about the 8-bit text in its other lines.
refused("binary-8bit", [{ name: "src/binary-8bit/f.pdf", data: Buffer.concat([Buffer.from("%PDF\n\0\x01\x02\n/Author ("), Buffer.from(CJK, "latin1"), Buffer.from(")\n")]) }]);
// Not this commit's lines: a deletion, an excepted path, a path no rule names.
landed("except", [{ name: "src/allowed/f.txt", data: `${LOG}\n` }]);
landed("outside", [{ name: "lib/f.txt", data: `${LOG}\n` }]);

// Names: the literal in a plain UTF-8 line, under names git quotes, splits or reads as a pathspec.
const NAMES = ["sp ace.js", "tab\there.js", 'q"uote.js', "back\\slash.js", "new\nline.js", "cr\r.js", "sep\u2028.js", "a b/c.js", "[id].js", "*.js", "-n.js", "ü.js", "x".repeat(200)];
NAMES.forEach((n, i) => refused(`name-${i}`, [{ name: `src/n${i}/${n}`, data: `${LOG}\n` }]));
// Names git may not hand back as it was given them.
refused("name-nfd", [{ name: "src/nfd/u\u0308.js", data: `${LOG}\n` }]);
// Each cell names the check it wants said, so the secret scan's line cannot hide it.
const FORBIDDEN_SAID = "review.forbidden was not checked";
// A name git cannot be asked for, under a rule's paths, refuses the commit: review.forbidden names it.
refused("name-not-utf8", [{ name: Buffer.from([...Buffer.from("src/bad/"), 0xff, 0xfe, ...Buffer.from(".js")]), data: `${LOG}\n` }], "src/bad/", { strict: true });
refused("glob-nfc-name-nfd", [{ name: "do\u0308k/a.js", data: `${LOG}\n` }], "dök/a.js".normalize("NFD"));
// Two names that read alike: one not UTF-8 holding the text, one spelled with U+FFFD itself.
refused("name-collision", [{ name: Buffer.from([...Buffer.from("src/bad2/"), 0xff, ...Buffer.from(".js")]), data: `${LOG}\n` }, { name: "src/bad2/\ufffd.js", data: "a\n" }], "src/bad2/", { strict: true });
// A name that is not UTF-8 where every rule that names it excepts it: nothing to say.
landed("name-not-utf8-excepted", [{ name: Buffer.from([...Buffer.from("exc/ok/"), 0xff, ...Buffer.from(".js")]), data: `${LOG}\n` }], { unsaid: "review.forbidden" });
// A name that is not UTF-8 beside a file that holds the text: the one is said, the other still refused.
refused("name-not-utf8-beside", [{ name: Buffer.from([...Buffer.from("src/bad3/"), 0xff, ...Buffer.from(".js")]), data: "a\n" }, { name: "src/bad3/b.js", data: `${LOG}\n` }], "src/bad3/b.js:1", { strict: true });
// A backslash is a character of a name outside Windows: this file is in src/, not in src/allowed/.
refused("backslash-except", [{ name: "src/allowed\\evil.js", data: `${LOG}\n` }]);
// Paths that need an Impact line: decomposed under a composed glob, bytes that are not UTF-8.
refused("impact-plain", [{ name: "imp/a.js", data: "a\n" }], "imp/a.js");
refused("impact-nfd", [{ name: "\u0131mp-u\u0308/a.js", data: "a\n" }], "Impact:");
refused("impact-not-utf8", [{ name: Buffer.from([...Buffer.from("imp/"), 0xff, ...Buffer.from(".js")]), data: "a\n" }], "Impact:");
// A code path whose document did not move with it warns, whatever the spelling of its name.
landed("cochange-nfd", [{ name: "cc-u\u0308/a.js", data: "a\n" }], { warns: "cc-doc.md" });

// Links, submodules: what git stores.
refused("link-target", [{ name: "src/link/l", data: `${LOG}`, mode: "120000" }]);
landed("link-clean", [{ name: "src/link2/l", data: "../a.js", mode: "120000" }]);
landed("gitlink", [{ name: "src/sub", data: "1234567890abcdef1234567890abcdef12345678", mode: "160000" }]);
// What the index holds is what history holds: a clean filter's output, UTF-8 from working-tree-encoding.
refused("filter-adds", [{ name: "src/filter/a.flt", data: "a\nLOG\n", worktree: true }]);
landed("filter-removes", [{ name: "src/filter2/a.rmf", data: `a\n${LOG}\n`, worktree: true }]);
refused("wte-utf16", [{ name: "src/wte/a.w16", data: utf16(`a\n${LOG}\n`, "utf16le", true), worktree: true }]);
// Past git()'s 64 MB buffer, inside a rule's paths.
refused("huge", [{ name: "src/huge/blob.txt", data: () => Buffer.concat([Buffer.alloc(65 * 1024 * 1024, 0x61), Buffer.from(`\n${LOG}\n`)]) }], undefined, { warns: FORBIDDEN_SAID });
// A move into a rule's paths: the new name is added in full, whatever diff.renames says.
refused("moved-in", [{ name: "src/moved/f.txt", data: `${LOG}\n` }], "src/moved/f.txt", { before: [{ name: "lib/moved.txt", data: `${LOG}\n` }] });
// Merges: the other side's lines count (its commits may have run no hook), and so does the resolution's own.
refused("merge-side", [], "src/merge1/a.js", { side: [{ name: "src/merge1/a.js", data: `${LOG}\n` }] });
refused("merge-own", [{ name: "src/merge2/b.js", data: `${LOG}\n` }], "src/merge2/b.js", { side: [{ name: "src/merge2/a.js", data: "a\n" }] });
refused("merge-utf16", [], "src/merge3/a.txt", { side: [{ name: "src/merge3/a.txt", data: utf16(`a\n${LOG}\n`, "utf16le", true) }] });
landed("merge-clean", [], { side: [{ name: "src/merge4/a.js", data: "a\n" }] });
// The same shapes given by commit -a and commit -- <path>: the hook reads the index git built for the commit.
for (const via of /** @type {const} */ (["all", "path"])) {
  refused(`via-${via}-utf16`, [{ name: `src/via-${via}-utf16/f.txt`, data: utf16(`a\n${LOG}\n`, "utf16le", true) }], undefined, { via });
  refused(`via-${via}-latin1`, [{ name: `src/via-${via}-latin1/f.txt`, data: Buffer.from(`bir ${CJK}\n`, "latin1") }], undefined, { via });
}
// HEAD replaced by a commit whose tree holds the line already: the line is still added to history.
refused("replace-ref", [{ name: "src/replace/a.js", data: `a\n${LOG}\n` }], undefined, { replace: "commit" });
refused("replace-blob", [{ name: "src/replace-blob/a.js", data: `a\n${LOG}\n` }], undefined, { replace: "blob" });
// The main index and the work tree differ: commit -- <path> commits the work tree's file.
refused("via-path-worktree", [{ name: "src/via-wt/a.js", data: `a\n${LOG}\n` }], undefined, { via: "path", staged: "a\nb\n", strict: true });
landed("via-path-index", [{ name: "src/via-ix/a.js", data: "a\nb\n" }], { via: "path", staged: `a\n${LOG}\n` });

// The bytes as git has them are read even where a file also reads as UTF-16 or UTF-32: decoding only adds.
/** @param {number} n @param {Buffer} [comment] an INFO text of even length @param {string} [chunk] */
const wav = (n, comment = Buffer.from(`${LOG}(1);\0`), chunk = "ICMT") => {
  const samples = Buffer.alloc(n);
  for (let i = 0; i < n; i += 2) samples[i] = 1 + (i % 9);
  const list = Buffer.concat([Buffer.from(`INFO${chunk}`), Buffer.from([comment.length, 0, 0, 0]), comment]);
  const u32 = (/** @type {number} */ v) => Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24]);
  const fmt = Buffer.concat([Buffer.from("fmt "), u32(16), Buffer.from([1, 0, 1, 0]), u32(8000), u32(16000), Buffer.from([2, 0, 16, 0])]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, Buffer.from("data"), u32(n), samples, Buffer.from("LIST"), u32(list.length), list]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
};
const BYTE_VIEW = [
  ["mark-utf8", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x\n${LOG}(1);\n`)])],
  ["mark32-utf8", Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from(`x\n${LOG}(1);\n`)])],
  ["utf16-then-utf8", Buffer.concat([utf16("a\n", "utf16le", true), Buffer.from(`${LOG}(1);\n`)])],
  ["utf8-then-utf16", Buffer.concat([Buffer.from(`${LOG}(1);\n`), utf16(`${"abcdefgh".repeat(20)}\n`, "utf16le", false)])],
  ["utf8-nul-pairs", Buffer.concat([Buffer.from(`${LOG}(1);\n`), Buffer.from("a\0".repeat(100))])],
  ["nul-list", Buffer.from(`a\0b\0c\0${LOG}\0d\0`)],
  ["wav", wav(4000)],
];
for (const [id, data] of BYTE_VIEW) refused(String(id), [{ name: `src/${id}/f.bin`, data }], undefined, { strict: true });
// A decoded file's own lines are still judged: 8-bit text after UTF-16 (a cmd append on Turkish Windows), after
// a byte order mark, in a WAV's INFO name; and UTF-16 that an ANSI line put at the other byte alignment.
refused("utf16-then-latin1", [{ name: "src/utf16-latin1/f.txt", data: Buffer.concat([utf16("a\n", "utf16le", true), Buffer.from(`bir ${CJK} daha\n`, "latin1")]) }]);
refused("mark-latin1", [{ name: "src/mark-latin1/f.txt", data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`bir ${CJK} daha\n`, "latin1")]) }]);
refused("wav-latin1", [{ name: "src/wav-latin1/f.wav", data: wav(4000, Buffer.from(`bir ${CJK}\0`, "latin1"), "INAM") }]);
refused("utf16-realigned", [{ name: "src/realigned/f.txt", data: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16("a\r\n", "utf16le", false), Buffer.from("x\r\n"), utf16(`${LOG}(1)\r\n`, "utf16le", false)]) }], undefined, { strict: true });
refused("utf16be-realigned", [{ name: "src/realigned-be/f.txt", data: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16("a\r\n", "utf16be", false), Buffer.from("x\r\n"), utf16(`${LOG}(1)\r\n`, "utf16be", false)]) }], undefined, { strict: true });
// Only the byte order the file was decoded in finds big-endian UTF-16 at its very end, with nothing after it.
refused("utf16be-realigned-end", [{ name: "src/realigned-be-end/f.txt", data: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16("a\r\n", "utf16be", false), Buffer.from("x\r\n"), utf16(LOG, "utf16be", false)]) }], undefined, { strict: true });
// git's trace sent to stdout would be read as git's answers: it is not passed to the hook's git calls.
refused("trace-stdout", [{ name: "src/trace/a.js", data: `${LOG}\n` }], undefined, { env: { GIT_TRACE: "/dev/stdout", GIT_TRACE2: "/dev/stdout" }, strict: true });
// A file with NULs that does not read as UTF-16 or UTF-32 is still searched for the text's wide bytes.
refused("utf16le-japanese", [{ name: "src/jp-le/f.txt", data: utf16(`${"\u65e5\u672c\u8a9e".repeat(50)}\n${LOG}(1)\n`, "utf16le", false) }], undefined, { strict: true });
refused("utf16be-japanese", [{ name: "src/jp-be/f.txt", data: utf16(`${"\u65e5\u672c\u8a9e".repeat(50)}\n${LOG}(1)\n`, "utf16be", false) }], undefined, { strict: true });
refused("utf16-odd-length", [{ name: "src/odd/f.txt", data: Buffer.concat([utf16(`x(${LOG}(1))`, "utf16le", false), Buffer.from("\n")]) }], undefined, { strict: true });
refused("utf16-nuls-other-side", [{ name: "src/other-side/f.txt", data: utf16(`${"\u4e00".repeat(20)}${LOG}(1)\n`, "utf16le", false) }], undefined, { strict: true });
// A byte order mark followed by U+0000 reads as UTF-32LE's mark; a UTF-16LE file that starts with U+0000.
refused("mark-then-nul", [{ name: "src/mark-nul/f.txt", data: utf16(`\0x\n${LOG}(1)\n`, "utf16le", true) }], "src/mark-nul/f.txt:2", { strict: true });
refused("nul-first-utf16", [{ name: "src/nul-first/f.txt", data: utf16(`\0x\n${LOG}(1)\n`, "utf16le", false) }], undefined, { strict: true });
// NUL and 8-bit text on one line (a gettext catalog in ISO-8859): said, not passed.
refused("nul-and-8bit", [{ name: "src/mo/f.mo", data: Buffer.concat([Buffer.from("msgid\0"), Buffer.from(`bir ${CJK} daha\0`, "latin1")]) }]);
// A binary file under a text with letters outside ASCII is counted, not named: it may hold an 8-bit spelling.
landed("binary-counted", [{ name: "src/png/a.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0xe7, 0xf6, 0x9a]) }]);
// A large binary changed a little, beside a file that holds the text: the text is still refused.
/** Made when the cell runs, not when a unit test loads the file. @param {boolean} edited */
const big = (edited) => {
  const b = Buffer.alloc(65 * 1024 * 1024, 0x61);
  for (let i = 63; i < b.length; i += 64) b[i] = 0x0a;
  for (let i = 0; i < b.length; i += 4096) b[i] = 0;
  if (edited) b.write("changed", 1024 * 1024 + 8);
  return b;
};
// A file past git()'s buffer where no forbidden rule reads stops neither check of the other files; it is said.
refused("huge-outside", [{ name: "lib/huge-outside/blob.txt", data: () => Buffer.concat([Buffer.alloc(65 * 1024 * 1024, 0x61), Buffer.from("\n")]) }, { name: "src/huge-outside/b.js", data: `${LOG}\n` }], "src/huge-outside/b.js:1", { strict: true });
// A UTF-16 file too large to decode still has its secret found: git's lines with the NULs dropped are ASCII.
refused("wide-large-secret", [{ name: "lib/wide-large-s/f.txt", data: () => utf16(`${"ab".repeat(4 * 1024 * 1024 + 1)}\n${SECRET}\n`, "utf16le", true) }], undefined, { strict: true });
// A UTF-16 file too large to decode, with nothing to refuse in its own lines: said, not passed.
landed("wide-large", [{ name: "src/wide-large/f.txt", data: () => utf16("ab".repeat(4 * 1024 * 1024 + 1), "utf16le", true) }], { warns: "as UTF-16 or UTF-32 text: past 16 MB" });
// Past 16 MB, a UTF-16 file one line of which is edited: a text only its decoding finds ("\u4e0a" is 0A 4E,
// which git splits) is said, though the line looks like neither UTF-16 nor 8-bit text.
/** Lines of letters whose UTF-16 bytes are printable ASCII, built once a run; the edit is one line's bytes. */
/** @type {Buffer | null} */
let wideBase = null;
/** @param {boolean} edited */
const wideBig = (edited) => {
  wideBase ??= utf16(`${"\u4e2d\u672c".repeat(31)}\n`.repeat(133200), "utf16le", true);
  if (!edited) return wideBase;
  const out = Buffer.from(wideBase);
  utf16(`\u4e0a\u6d77\u6f22\u5b57${"\u4e2d\u672c".repeat(29)}\n`, "utf16le", false).copy(out, 2 + 1000 * 126);
  return out;
};
refused("wide-past-limit", [{ name: "sh/f.txt", data: () => wideBig(true) }], undefined, { base: [{ name: "sh/f.txt", data: () => wideBig(false) }], warns: "as UTF-16 or UTF-32 text: past 16 MB" });
refused("big-binary-small-diff", [{ name: "src/big/big.bin", data: () => big(true) }, { name: "src/big/b.js", data: `${LOG}\n` }], "src/big/b.js:1", { base: [{ name: "src/big/big.bin", data: () => big(false) }], strict: true });

/** @typedef {{ status: number | null, stderr: string, moved: boolean }} CellRun */

/**
 * The verdict on one cell's commit: null when the hook did what the cell wants, else the problem.
 * `said`: the commit went through and the hook said what it did not check.
 * @param {Pick<Cell, "want" | "names" | "warns" | "strict" | "unsaid">} cell @param {CellRun} r
 * @returns {{ problem: string | null, said: boolean }}
 */
export function judge(cell, r) {
  const said = r.status === 0 && SAYS.test(r.stderr);
  if (r.status === 0 && !r.moved) return { problem: "exit 0, but no commit was made", said };
  if (r.status !== 0 && r.moved) return { problem: "a commit was made, but the hook failed", said };
  if (cell.unsaid && r.stderr.includes(cell.unsaid)) return { problem: `said ${cell.unsaid}, which has nothing to say here`, said };
  if (cell.want === "landed" && r.status !== 0) return { problem: `refused with nothing to refuse: ${r.stderr.trim().split("\n")[0]}`, said };
  if (cell.want === "landed") return { problem: cell.warns && !r.stderr.includes(cell.warns) ? `landed without the warning that names ${cell.warns}` : null, said };
  if (r.status === 0 && said && cell.strict) return { problem: "said it did not check, where it could and had to refuse", said };
  if (r.status === 0 && said && cell.warns && !r.stderr.includes(cell.warns)) return { problem: `said, but not ${cell.warns}`, said };
  if (r.status === 0) return { problem: said ? null : "a silent pass: committed, and nothing said it was not checked", said };
  // A name with a control character, a quote or a backslash is printed quoted and escaped, as doctor prints it.
  const names = String(cell.names);
  if (!r.stderr.includes(names) && !r.stderr.includes(shown(names, { name: true }).text)) return { problem: `refused, but not for the path: ${JSON.stringify(r.stderr.trim().slice(0, 200))}`, said };
  return { problem: null, said };
}

/**
 * The cells' exact verdicts against their record (test/verdicts/input-shapes.json): "" when none moved.
 * @param {Map<string, { verdict: "refused" | "said" | "pass" }>} got
 */
export function recordMoves(got) {
  return movesText("input-shapes", moves(readCells("input-shapes"), got));
}

/** @param {string} dir @param {string[]} args @param {Buffer | string} [input] */
async function g(dir, args, input) {
  if (input === undefined) return (await run("git", args, { cwd: dir, env: { ...process.env }, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })).stdout.toString("utf8").trim();
  const tmp = join(dir, ".git", "cell-blob");
  writeFileSync(tmp, input);
  return (await run("git", [...args, tmp], { cwd: dir, env: { ...process.env } })).stdout.trim();
}

/** A repository with the rules, the attributes and filters the cells use, a first commit and the hook. */
async function repository() {
  const dir = mkdtempSync(join(tmpdir(), "en-shapes-"));
  await g(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ review: { forbidden: RULES, impactRequiredGlobs: IMPACT, cochange: [{ paths: ["cc-ü/**"], docs: ["cc-doc.md"] }] } }));
  writeFileSync(join(dir, ".git", "info", "attributes"), "*.bin binary\n*.nodiff -diff\n*.tc diff=tc\n*.flt filter=addlog\n*.rmf filter=droplog\n*.w16 working-tree-encoding=UTF-16\n");
  for (const [k, v] of [["core.bigFileThreshold", "1"], ["diff.tc.textconv", "tr a-z A-Z"], ["filter.addlog.clean", `sed -e s/LOG/${LOG}/`], ["filter.droplog.clean", `sed -e s/${LOG}/x/`], ["core.precomposeUnicode", "true"]]) await g(dir, ["config", k, v]);
  await g(dir, ["add", "-A"]);
  await g(dir, [...ID, "commit", "-q", "-m", "first"]);
  installHook({ cwd: dir, cliPath: CLI });
  return dir;
}

/** @param {CellFile} f */
const content = (f) => (typeof f.data === "function" ? f.data() : f.data ?? "");

/** @param {string} dir @param {CellFile[]} files */
async function stage(dir, files) {
  for (const f of files) {
    if (f.worktree) {
      const path = String(f.name);
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content(f));
      await g(dir, ["add", "--", path]);
      continue;
    }
    const hash = f.mode === "160000" ? String(f.data) : await g(dir, ["hash-object", "-w"], content(f));
    const line = Buffer.concat([Buffer.from(`${f.mode ?? "100644"} ${hash}\t`), Buffer.isBuffer(f.name) ? f.name : Buffer.from(f.name), Buffer.from("\0")]);
    const tmp = join(dir, ".git", "cell-index-info");
    writeFileSync(tmp, line);
    await run("sh", ["-c", `git update-index --add -z --index-info < '${tmp}'`], { cwd: dir, env: { ...process.env } });
  }
}

/** @param {string} dir @param {Cell} cell @returns {Promise<CellRun>} */
async function commitCell(dir, cell) {
  if (cell.side) return mergeCell(cell, cell.side);
  if (cell.via || cell.replace) return trackedCell(cell);
  if (cell.base) {
    await stage(dir, cell.base);
    await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", `base ${cell.id}`]);
  }
  if (cell.before) {
    await stage(dir, cell.before);
    await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", `before ${cell.id}`]);
    await g(dir, ["rm", "-q", "--cached", "--", String(cell.before[0].name)]);
  }
  await stage(dir, cell.files);
  const head = await g(dir, ["rev-parse", "HEAD"]);
  const r = await commit(dir, ["-m", `cell ${cell.id}`], cell.env);
  const moved = (await g(dir, ["rev-parse", "HEAD"])) !== head;
  if (!moved) await g(dir, ["reset", "-q"]);
  return { ...r, moved };
}

/** A commit through the hook. @param {string} dir @param {string[]} args @param {Record<string, string>} [env] @returns {Promise<{ status: number | null, stderr: string }>} */
function commit(dir, args, env = {}) {
  return run("git", [...ID, "commit", "-q", ...args], { cwd: dir, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }).then(
    (x) => ({ status: 0, stderr: x.stderr }),
    (/** @type {any} */ e) => ({ status: typeof e.code === "number" ? e.code : null, stderr: String(e.stderr ?? e.message) }),
  );
}

/**
 * A tracked file changed in the work tree and committed by `commit -a` or `commit -- <path>`, in a repository
 * of its own; or one staged on a HEAD that a replace ref stands in for.
 * @param {Cell} cell
 * @returns {Promise<CellRun>}
 */
async function trackedCell(cell) {
  const dir = await repository();
  const f = cell.files[0];
  const path = String(f.name);
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  if (cell.replace === "blob") {
    // HEAD's blob of the file reads as one that holds the new text.
    writeFileSync(join(dir, path), "a\n");
    await g(dir, ["add", "--", path]);
    await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", "tracked"]);
    const old = await g(dir, ["rev-parse", `HEAD:${path}`]);
    const now = await g(dir, ["hash-object", "-w"], content(f));
    await g(dir, ["replace", old, now]);
    writeFileSync(join(dir, path), content(f));
    await g(dir, ["add", "--", path]);
  } else if (cell.replace) {
    // The commit HEAD's object will read as: one whose tree already holds the file.
    writeFileSync(join(dir, path), content(f));
    await g(dir, ["add", "--", path]);
    await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", "holds it"]);
    const holds = await g(dir, ["rev-parse", "HEAD"]);
    await g(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    await g(dir, ["replace", "HEAD", holds]);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content(f));
    await g(dir, ["add", "--", path]);
  } else {
    writeFileSync(join(dir, path), Buffer.isBuffer(f.data) && f.data[0] === 0xff ? Buffer.from([0xff, 0xfe, 0x61, 0, 0x0a, 0]) : "a\n");
    await g(dir, ["add", "--", path]);
    await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", "tracked"]);
    if (cell.staged !== undefined) {
      writeFileSync(join(dir, path), cell.staged);
      await g(dir, ["add", "--", path]);
    }
    writeFileSync(join(dir, path), content(f));
  }
  const head = await g(dir, ["rev-parse", "HEAD"]);
  // Under the replace ref git sees no change against HEAD, so it needs --allow-empty to commit the tree.
  const r = await commit(dir, cell.via === "all" ? ["-a", "-m", `cell ${cell.id}`] : cell.via === "path" ? ["-m", `cell ${cell.id}`, "--", path] : cell.replace === "commit" ? ["--allow-empty", "-m", `cell ${cell.id}`] : ["-m", `cell ${cell.id}`]);
  return { ...r, moved: (await g(dir, ["rev-parse", "HEAD"])) !== head };
}

/**
 * A merge, in a repository of its own: a branch switch would meet the other cells' files, which are only in the index.
 * @param {Cell} cell @param {CellFile[]} side
 * @returns {Promise<CellRun>}
 */
async function mergeCell(cell, side) {
  const dir = await repository();
  await g(dir, ["checkout", "-q", "-b", "side"]);
  await stage(dir, side.map((f) => ({ ...f, worktree: true })));
  await g(dir, [...ID, "commit", "-q", "--no-verify", "-m", "side"]);
  await g(dir, ["checkout", "-q", "main"]);
  writeFileSync(join(dir, "main.txt"), "main\n");
  await g(dir, ["add", "main.txt"]);
  await g(dir, [...ID, "commit", "-q", "-m", "main"]);
  const head = await g(dir, ["rev-parse", "HEAD"]);
  await g(dir, [...ID, "merge", "-q", "--no-commit", "--no-ff", "side"]);
  await stage(dir, cell.files.map((f) => ({ ...f, worktree: true })));
  const r = await commit(dir, ["--no-edit"]);
  return { ...r, moved: (await g(dir, ["rev-parse", "HEAD"])) !== head };
}

test("input shapes: every staged content and name shape is refused, landed, or said to be unchecked; none passes in silence", async () => {
  const dirs = await Promise.all([0, 1, 2, 3].map(() => repository()));
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const gaps = [];
  /** Each cell's exact verdict. @type {Map<string, { verdict: "refused" | "said" | "pass" }>} */
  const got = new Map();
  let next = 0;
  await Promise.all(
    dirs.map(async (dir) => {
      while (next < CELLS.length) {
        const cell = CELLS[next++];
        const r = await commitCell(dir, cell);
        const v = judge(cell, r);
        if (cell.gap && v.problem?.startsWith("a silent pass")) gaps.push(cell.id);
        else if (v.problem) problems.push(`${cell.id}: ${v.problem}`);
        got.set(cell.id, { verdict: r.status !== 0 ? "refused" : v.said ? "said" : "pass" });
      }
    }),
  );
  // The cells' files, some of 65 MB and more, are not left in the temporary directory.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  // Each said cell is a shape the hook cannot read: the record's said cells are what is left of the class.
  assert.deepEqual({ problems, gaps: gaps.sort(), moved: recordMoves(got) }, { problems: [], gaps: ["utf16-no-mark-han"], moved: "" });
});

test("input shapes control: the judge flags a silent pass, a refusal with nothing to refuse, a refusal for another reason, and a hook that lies about the commit", () => {
  const want = { want: /** @type {const} */ ("refused"), names: "src/a.js" };
  assert.equal(judge(want, { status: 1, stderr: 'src/a.js:2 adds "console.log"', moved: false }).problem, null);
  assert.match(String(judge(want, { status: 0, stderr: "", moved: true }).problem), /silent pass/);
  assert.deepEqual(judge(want, { status: 0, stderr: "ennyn: review.forbidden was not checked: x", moved: true }), { problem: null, said: true });
  assert.match(String(judge(want, { status: 1, stderr: "the subject is too long", moved: false }).problem), /not for the path/);
  assert.match(String(judge({ want: "landed" }, { status: 1, stderr: "src/a.js:1 adds", moved: false }).problem), /refused with nothing/);
  assert.equal(judge({ want: "landed" }, { status: 0, stderr: "", moved: true }).problem, null);
  assert.match(String(judge({ want: "landed" }, { status: 0, stderr: "", moved: false }).problem), /no commit was made/);
  assert.match(String(judge(want, { status: 1, stderr: "src/a.js", moved: true }).problem), /the hook failed/);
  assert.match(String(judge({ want: "landed", warns: "doc.md" }, { status: 0, stderr: "", moved: true }).problem), /without the warning/);
  assert.equal(judge({ want: "landed", warns: "doc.md" }, { status: 0, stderr: "a.js changed without doc.md", moved: true }).problem, null);
  assert.match(String(judge({ ...want, strict: true }, { status: 0, stderr: "ennyn: review.forbidden was not checked: x", moved: true }).problem), /had to refuse/);
  assert.match(String(judge({ want: "landed", unsaid: "review.forbidden" }, { status: 0, stderr: "review.forbidden was not checked in 1", moved: true }).problem), /nothing to say/);
  // The record holds the exact verdict: a said cell that passes, a refused cell that is only said, moved.
  const recorded = new Map(readCells("input-shapes").map((c) => [c.id, { verdict: c.verdict }]));
  assert.equal(recordMoves(recorded), "");
  assert.match(recordMoves(new Map([...recorded, ["latin1-clean", { verdict: "pass" }]])), /latin1-clean: recorded said, now pass/);
  assert.match(recordMoves(new Map([...recorded, ["utf8-ascii", { verdict: "said" }]])), /utf8-ascii: recorded refused, now said/);
});

test("input shapes: a line holds a text as written or composed; an 8-bit line is said where a text has no one spelling, a NUL line is binary", () => {
  /** @param {string} text @param {[string, import("../plugin/core/git.mjs").AddedLine[]][]} files */
  const scan = (text, ...files) => forbiddenScan(new Map(files), [{ text, paths: ["**"] }]);
  const line = (/** @type {string} */ text, n = 1) => ({ line: n, text });
  const bytes = (/** @type {Buffer} */ raw, n = 1) => ({ line: n, text: raw.toString("utf8"), raw });
  // As written or composed: decomposed letters either side, a combining mark that composing would swallow
  // ("g" and a breve), marks in another order.
  assert.equal(scan(CJK, ["a", [line(`x ${CJK.normalize("NFD")}`)]]).hits.length, 1);
  assert.equal(scan(CJK.normalize("NFD"), ["a", [line(`x ${CJK}`)]]).hits.length, 1);
  assert.equal(scan(LOG, ["a", [line("x(console.log\u0306(1))")]]).hits.length, 1);
  assert.equal(scan("e\u0323\u0302", ["a", [line("e\u0302\u0323")]]).hits.length, 1);
  assert.equal(scan(CJK, ["a", [line("cop")]]).hits.length, 0);
  // An 8-bit line: an ASCII text is found as is; one with other letters cannot be, and is said, not passed.
  const latin = Buffer.from("café console.log", "latin1");
  assert.deepEqual(scan(LOG, ["a", [bytes(latin)]]), { hits: [{ rule: 0, path: "a", line: 1 }], unread: [] });
  assert.deepEqual(scan(CJK, ["a", [bytes(latin)]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "text" }] });
  assert.deepEqual(scan(LOG, ["a", [bytes(Buffer.from("café", "latin1"))]]), { hits: [], unread: [] }, "an ASCII text is read in any 8-bit line");
  assert.deepEqual(scan(CJK, ["a", [line("café, valid UTF-8")]]), { hits: [], unread: [] });
  // A path the text was found in is refused; that another of its lines cannot be compared adds nothing.
  assert.deepEqual(scan(CJK, ["a", [line(CJK), bytes(Buffer.from("café", "latin1"), 2)]]), { hits: [{ rule: 0, path: "a", line: 1 }], unread: [] });
  // A file with NULs in its added lines is binary: an 8-bit line in it (once its NULs are out) is counted, not
  // named; a file with none is 8-bit text, named. A NUL line that is UTF-8 without its NULs says nothing.
  assert.deepEqual(scan(CJK, ["a", [bytes(Buffer.from([0, 1, 2])), bytes(Buffer.from("café", "latin1"), 2)]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "binary" }] });
  assert.deepEqual(scan(CJK, ["a", [bytes(Buffer.concat([Buffer.from("msgid\0"), Buffer.from("bir çöp\0", "latin1")]))]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "binary" }] });
  assert.deepEqual(scan(CJK, ["a", [bytes(Buffer.from("a\0b\0"))]]), { hits: [], unread: [] });
  assert.deepEqual(scan(CJK, ["a", [bytes(Buffer.from("café", "latin1"))]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "text" }] });
  // Only a byte order mark is taken off the first line: 8-bit text in its first bytes still counts.
  assert.deepEqual(scan(CJK, ["a", [bytes(Buffer.from([0xe7, 0x61]))]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "text" }] });
  // A file with NULs that was not decoded: the text's UTF-16 and UTF-32 bytes, either order, are searched.
  for (const wide of [utf16(`${LOG}`, "utf16le", false), utf16(`${LOG}`, "utf16be", false), utf32(`${LOG}`, "utf32le", false), utf32(`${LOG}`, "utf32be", false)]) {
    assert.equal(scan(LOG, ["a", [bytes(Buffer.concat([Buffer.from("\0\0"), wide]))]]).hits.length, 1, wide.toString("hex").slice(0, 16));
  }
  assert.equal(scan(LOG, ["a", [bytes(Buffer.from("\0")), bytes(utf16(LOG, "utf16le", false), 2)]]).hits.length, 1);
  // A line of the file that is UTF-8 with no NUL ("漢字" in UTF-16LE is '"oW[') is searched too, and decomposed.
  assert.equal(scan("\u6f22\u5b57", ["a", [bytes(Buffer.from("\0")), line(Buffer.from("\u6f22\u5b57", "utf16le").toString("latin1"), 2)]]).hits.length, 1);
  assert.equal(scan(CJK, ["a", [bytes(Buffer.concat([Buffer.from("\0\0"), utf16(CJK.normalize("NFD"), "utf16le", false)]))]]).hits.length, 1);
  // Decoded lines and git's own lines are both searched; a decoded file's byte lines say nothing unread.
  const decoded = [{ line: 2, text: "decoded console.log", decoded: "utf-16le" }, bytes(Buffer.from("\0x\0"), 1)];
  assert.deepEqual(scan(LOG, ["a", /** @type {any} */ (decoded)]), { hits: [{ rule: 0, path: "a", line: 2 }], unread: [] });
  assert.deepEqual(scan(LOG, ["a", [{ line: 1, text: "nothing", decoded: "utf-16le" }, bytes(Buffer.from(`\0${LOG}`), 3)]]).hits, [{ rule: 0, path: "a", line: 3 }]);
  // A decoded file's own lines are judged too: 8-bit text in them is said, and they are searched for the
  // text's bytes in the decoded byte order only (UTF-16LE "NOTE" holds U+4E00 in the other).
  assert.deepEqual(scan(CJK, ["a", [{ line: 1, text: "x", decoded: "utf-16le" }, bytes(Buffer.from([0, 0xe7]), 1)]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "binary" }] });
  assert.deepEqual(scan(CJK, ["a", [{ line: 1, text: "x", decoded: "utf-16le" }, bytes(Buffer.from([0x62, 0xe7]), 1)]]), { hits: [], unread: [{ rule: 0, path: "a", kind: "text" }] });
  assert.equal(scan(LOG, ["a", [{ line: 1, text: "x", decoded: "utf-16le" }, bytes(Buffer.concat([Buffer.from("x\0"), utf16(LOG, "utf16le", false)]), 3)]]).hits.length, 1);
  assert.equal(scan("\u4e00", ["a", [{ line: 1, text: "NOTE", decoded: "utf-16le" }, bytes(utf16("NOTE", "utf16le", false), 1)]]).hits.length, 0);
  // A file not decoded: said for a text the byte search cannot find (letters outside ASCII, or a newline byte
  // in its UTF-16), not for one it can.
  const wideUnread = new Map([["a", "past 16 MB"]]);
  const big = /** @type {[string, any[]]} */ (["a", [bytes(Buffer.from([0, 0x41]))]]);
  assert.deepEqual(forbiddenScan(new Map([big]), [{ text: LOG, paths: ["**"] }], [], wideUnread).unread, []);
  assert.deepEqual(forbiddenScan(new Map([big]), [{ text: CJK, paths: ["**"] }], [], wideUnread).unread, [{ rule: 0, path: "a", kind: "wide" }]);
  assert.deepEqual(forbiddenScan(new Map([big]), [{ text: "x\u010ay", paths: ["**"] }], [], wideUnread).unread, [{ rule: 0, path: "a", kind: "wide" }]);
  // What could not be compared is a warning that says so, naming three paths and how many more.
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-shapes-cfg-")), env: {}, override: { review: { forbidden: [{ text: CJK, paths: ["**"] }] } } });
  const four = new Map(["a", "b", "c", "d"].map((p) => [p, [bytes(Buffer.from("café", "latin1"))]]));
  const res = checkCommitShape("feat: x", { config, addedLines: four });
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, [`review.forbidden rule 1 ("${CJK}") was not checked in a, b, c and 1 more: those lines are not UTF-8, and a text with letters outside ASCII has no single spelling there.`]);
  // Binary files are counted in one line, so a text file is not lost among them; a file not read as wide text is named.
  const many = new Map([...Array.from({ length: 1000 }, (_, i) => [`b${i}.png`, [bytes(Buffer.from([0, 0xe7]))]]), ["src.c", [bytes(Buffer.from("café", "latin1"))]], ["w.txt", [bytes(Buffer.from([0, 0x41]))]]]);
  const loud = checkCommitShape("feat: x", { config, addedLines: /** @type {any} */ (many), wideUnread: new Map([["w.txt", "past 16 MB"]]) });
  assert.deepEqual(loud.warnings, [
    `review.forbidden rule 1 ("${CJK}") was not checked in src.c: those lines are not UTF-8, and a text with letters outside ASCII has no single spelling there.`,
    `review.forbidden rule 1 ("${CJK}") was not checked in 1000 file(s) with NULs (binary, UTF-16 or UTF-32) for its spellings in 8-bit encodings.`,
    `review.forbidden rule 1 ("${CJK}") was not checked in w.txt as UTF-16 or UTF-32 text: past 16 MB.`,
  ]);
});

test("input shapes: a wide file's encoding comes from its mark, else from its NULs; it is decoded in one byte order, its lines numbered as an editor numbers them", () => {
  const le16 = (/** @type {string} */ s, bom = false) => utf16(s, "utf16le", bom);
  const be16 = (/** @type {string} */ s, bom = false) => utf16(s, "utf16be", bom);
  const le32 = (/** @type {string} */ s, bom = false) => utf32(s, "utf32le", bom);
  const be32 = (/** @type {string} */ s, bom = false) => utf32(s, "utf32be", bom);
  assert.deepEqual([le16("a\n", true), be16("a\n", true), le32("a\n", true), be32("a\n", true)].map(wideEncoding), [
    { encoding: "utf-16le", mark: 2 },
    { encoding: "utf-16be", mark: 2 },
    { encoding: "utf-32le", mark: 4 },
    { encoding: "utf-32be", mark: 4 },
  ]);
  assert.deepEqual([le16("abc\n"), be16("abc\n"), le32("abc\n"), be32("abc\n")].map((b) => wideEncoding(b)?.encoding), ["utf-16le", "utf-16be", "utf-32le", "utf-32be"]);
  // FF FE 00 00 is UTF-16LE's mark and U+0000 unless the rest reads as UTF-32LE.
  assert.deepEqual(wideEncoding(le16("\0x\n", true)), { encoding: "utf-16le", mark: 2 });
  assert.deepEqual(wideEncoding(Buffer.concat([le16("\0", true), Buffer.from("ab")])), { encoding: "utf-16le", mark: 2 });
  // A binary file with a few NULs, or NULs on both sides, is no wide text.
  assert.equal(wideEncoding(Buffer.from("%PDF\n\0\x01\x02\n/Author (x)\n")), null);
  assert.equal(wideEncoding(Buffer.alloc(64)), null);
  assert.equal(wideEncoding(Buffer.from("abc")), null);
  // One byte order: "NOTE" in UTF-16LE holds the bytes of U+4E00 in the other, and reads as "NOTE".
  const note = le16("NOTE", true);
  assert.equal(decodeWide(note, /** @type {any} */ (wideEncoding(note))), "NOTE");
  // A UTF-32 value past U+10FFFF and a lone UTF-16 half are U+FFFD.
  assert.equal(decodeWide(Buffer.from([0x61, 0, 0, 0, 0, 0, 0x11, 0, 0, 0xd8, 0, 0]), { encoding: "utf-32le", mark: 0 }), "a\ufffd\ufffd");
  // git's lines split at every newline byte (U+4E0A is 0A 4E); the decoded lines are an editor's.
  /** @param {Buffer} blob */
  const gitLines = (blob) => {
    const out = [];
    for (let at = 0, n = 1; at < blob.length; n++) {
      let end = blob.indexOf(0x0a, at);
      if (end === -1) end = blob.length;
      out.push({ line: n, text: blob.subarray(at, end).toString("utf8") });
      at = end + 1;
    }
    return out;
  };
  for (const make of [le16, be16, le32, be32]) {
    const blob = make("\u4e0a\u6d77\u4e0a\u6d77\nconsole.log(1)\n");
    const wide = /** @type {any} */ (wideEncoding(blob));
    assert.ok(gitLines(blob).length > 2, "git counts more lines than there are");
    assert.deepEqual(wideLines(blob, wide, gitLines(blob)).map((l) => [l.line, l.text]), [[1, "\u4e0a\u6d77\u4e0a\u6d77"], [2, "console.log(1)"]], wide.encoding);
    // Only the decoded lines git's added lines are part of: the piece that holds "console" is in line 2.
    const piece = gitLines(blob).filter((l) => l.text.replace(/\0/g, "").includes("console"));
    assert.deepEqual(wideLines(blob, wide, piece).map((l) => l.line), [2], wide.encoding);
  }
  // In a merge, a decoded line comes from the other side when every part of it does.
  const up = le16("\u4e0a\n");
  const wide = { encoding: /** @type {const} */ ("utf-16le"), mark: 0 };
  assert.deepEqual(wideLines(up, wide, [{ line: 1, text: "", from: "p" }, { line: 2, text: "", from: "p" }]), [{ line: 1, text: "\u4e0a", from: "p" }]);
  assert.deepEqual(wideLines(up, wide, [{ line: 1, text: "", from: "p" }, { line: 2, text: "" }]), [{ line: 1, text: "\u4e0a" }]);
});

test("input shapes: a glob matches a name as written or composed; a backslash is a character outside Windows; ? is one letter outside the BMP too", () => {
  assert.ok(matchAny("do\u0308k/a.js", ["dök/**"]));
  assert.ok(matchAny("dök/a.js", ["do\u0308k/**"]));
  assert.ok(!matchAny("dok/a.js", ["dök/**"]));
  // A combining mark after glob syntax: composing the pattern changes nothing, the name as written matches.
  for (const glob of ["{e,o}\u0301.md", "*\u0301.md", "?\u0301.md", "[ae]\u0301.md"]) assert.ok(matchAny("e\u0301.md", [glob]), glob);
  assert.equal(matchAny("src/allowed\\evil.js", ["src/allowed/**"]), process.platform === "win32");
  assert.ok(matchAny("src/allowed\\evil.js", ["src/**"]));
  assert.ok(matchAny("\ud83d\ude00.md", ["?.md"]));
  assert.ok(!matchAny("ab.md", ["?.md"]));
  assert.ok(!matchAny("a/b.md", ["?.md"]));
});

test("input shapes: git errors name the command past -c; commit-check by hand fails on a name it cannot read; one cat-file reads the wide files, beside git's own lines, and one past the limit is said", () => {
  const killed = gitError(["-c", "core.precomposeUnicode=false", "grep", "x"], { status: null, signal: "SIGKILL", stdout: "", stderr: "" });
  assert.equal(killed.stderr, "git grep: killed by SIGKILL");
  // By hand, a staged name that cannot be read is a failure, as the lines that cannot be read are.
  const dir = mkdtempSync(join(tmpdir(), "en-shapes-hand-"));
  git(["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ review: { forbidden: [{ text: LOG, paths: ["**"] }] } }));
  const blob = git(["hash-object", "-w", join(dir, ".ennyn", "config.json")], { cwd: dir });
  spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, env: { ...process.env }, input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x61, 0xff]), Buffer.from("\0")]) });
  writeFileSync(join(dir, "MSG"), "x\n");
  const byHand = spawnSync(process.execPath, [CLI, "commit-check", "MSG"], { cwd: dir, env: { ...process.env }, encoding: "utf8" });
  assert.equal(byHand.status, 1, byHand.stderr);
  assert.match(byHand.stderr, /names are not UTF-8/);
  // Thirty binaries with NULs: their blobs are read by one cat-file --batch, sized by one --batch-check.
  const bin = mkdtempSync(join(tmpdir(), "en-shapes-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const log = join(bin, "calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const repo = mkdtempSync(join(tmpdir(), "en-shapes-many-"));
  git(["init", "-q"], { cwd: repo });
  for (let i = 0; i < 30; i++) writeFileSync(join(repo, `b${i}.bin`), Buffer.from([0, i, 0, 1, 0x0a]));
  git(["add", "-A"], { cwd: repo });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    stagedAddedLines(repo, stagedPaths(repo));
  } finally {
    process.env.PATH = path;
  }
  // One --batch-check more sizes the staged files for the diff calls (diffGroups): still none per file.
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => / cat-file /.test(` ${l} `));
  assert.ok(calls.length <= 3, calls.join("\n"));
  // A decoded file keeps git's own lines: a UTF-8 line after a byte order mark is still there.
  writeFileSync(join(repo, "w16.txt"), utf16(`x\n${LOG}(1)\n`, "utf16le", true));
  writeFileSync(join(repo, "mark.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x\n${LOG}(1);\n`)]));
  git(["add", "-A"], { cwd: repo });
  const read = stagedAddedLines(repo, ["w16.txt", "mark.txt"]);
  assert.deepEqual(read.get("w16.txt")?.filter((l) => l.decoded).map((l) => [l.line, l.text]), [[1, "x"], [2, `${LOG}(1)`]]);
  assert.ok(read.get("mark.txt")?.some((l) => !l.decoded && l.text === `${LOG}(1);`), "git's line, beside the decoded ones");
  // A file too large to read whole is said, not read, and the others are read.
  writeFileSync(join(repo, "large.txt"), utf16("ab".repeat(4 * 1024 * 1024 + 1), "utf16le", true));
  git(["add", "-A"], { cwd: repo });
  /** @type {Map<string, string>} */
  const wideUnread = new Map();
  const both = stagedAddedLines(repo, ["large.txt", "w16.txt"], { wideUnread });
  assert.deepEqual([...wideUnread], [["large.txt", "past 16 MB"]]);
  assert.ok(both.get("w16.txt")?.some((l) => l.decoded));
  // Any file not decoded goes into wideUnread, whatever its lines look like; the scan decides per rule. At
  // exactly 16 MB a file is decoded.
  const noise = Buffer.alloc(17 * 1024 * 1024, 0x61);
  for (let i = 0; i < noise.length; i += 997) noise[i] = 0;
  writeFileSync(join(repo, "large.bin"), noise);
  writeFileSync(join(repo, "limit.txt"), utf16("a".repeat(8 * 1024 * 1024 - 1), "utf16le", true));
  git(["add", "-A"], { cwd: repo });
  /** @type {Map<string, string>} */
  const noisy = new Map();
  const atLimit = stagedAddedLines(repo, ["large.bin", "limit.txt"], { wideUnread: noisy });
  assert.deepEqual([...noisy], [["large.bin", "past 16 MB"]]);
  assert.ok(atLimit.get("limit.txt")?.some((l) => l.decoded));
  // A cat-file that fails costs only the files it was to read: they are said, the rest is read.
  for (const fail of ["--batch-check", "--batch"]) {
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${fail} "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec '${real}' "$@"\n`);
    process.env.PATH = `${bin}${delimiter}${path}`;
    /** @type {Map<string, string>} */
    const failed = new Map();
    let lines;
    try {
      lines = stagedAddedLines(repo, ["w16.txt", "b1.bin"], { wideUnread: failed });
    } finally {
      process.env.PATH = path;
    }
    assert.deepEqual([...failed].sort(), [["b1.bin", "fatal: injected"], ["w16.txt", "fatal: injected"]], fail);
    assert.ok(lines.get("b1.bin")?.length, fail);
  }
});

test("input shapes: git() and gitBytes() fail with git's message as text, as every caller reads it; a trace sent to stdout is not read as git's answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-shapes-err-"));
  const traced = mkdtempSync(join(tmpdir(), "en-shapes-trace-"));
  git(["init", "-q"], { cwd: traced });
  assert.equal(git(["rev-parse", "--git-dir"], { cwd: traced, env: { ...process.env, GIT_TRACE_PERFORMANCE: "/dev/stdout" } }), ".git");
  assert.equal(git(["rev-parse", "--git-dir"], { cwd: traced, env: { ...process.env, GIT_TRACE: "/dev/stdout", GIT_TRACE2: "/dev/stdout" } }), ".git");
  // On Linux git cannot open /dev/stdout when it is the socket node gives it (ENXIO), so the lines above hold there
  // whatever the helper does: a trace sent to a file shows on every platform whether the variable reached git.
  for (const k of ["GIT_TRACE", "GIT_TRACE_PERFORMANCE", "GIT_TRACE2", "GIT_TRACE2_EVENT"]) {
    const file = join(traced, `${k}.log`);
    assert.equal(git(["rev-parse", "--git-dir"], { cwd: traced, env: { ...process.env, [k]: file } }), ".git");
    assert.ok(!existsSync(file), `${k} reached git`);
  }
  for (const call of [git, gitBytes]) {
    try {
      call(["rev-parse", "--verify", "no-such-ref"], { cwd: dir });
      assert.fail("git did not fail");
    } catch (err) {
      const stderr = /** @type {{ stderr?: unknown }} */ (err).stderr;
      assert.equal(typeof stderr, "string", call.name);
      assert.match(String(stderr), /not a git repository|needed a single revision|fatal/);
    }
  }
});

test("input shapes: doctor and init-scan count a decomposed text in the index as the hook reads it; UTF-16 is not counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-shapes-count-"));
  git(["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "nfd.txt"), `bir ${CJK.normalize("NFD")}\n`);
  writeFileSync(join(dir, "nfc.txt"), `bir ${CJK}\n`);
  writeFileSync(join(dir, "wide.txt"), utf16(`${LOG}\n`, "utf16le", true));
  git(["add", "-A"], { cwd: dir });
  // Each form asked for alone: the count asks git for the other form itself.
  const files = (/** @type {string} */ t) => (indexMatches(dir, [t]).get(t) ?? []).map((h) => `${h.path}:${h.n}`).sort();
  assert.deepEqual([files(CJK), files(CJK.normalize("NFD"))], [["nfc.txt:1", "nfd.txt:1"], ["nfc.txt:1", "nfd.txt:1"]]);
  assert.deepEqual(files(LOG), [], "unlike the hook: a graph node, not a silent claim (DESIGN.md says what the count reads)");
});
