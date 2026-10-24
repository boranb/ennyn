/**
 * Text git splits where it is not split: a file stored in UTF-16 or UTF-32 holds NULs between its letters,
 * and git ends a line at every newline byte, also one inside another letter (U+010A "Ċ" is 0A 01 in
 * UTF-16LE, U+4E0A "上" is 0A 4E). The commit-msg hook reads such a file decoded: its encoding from the byte
 * order mark, else from where its NULs are; its lines are the decoded ones, numbered as an editor numbers them.
 *
 * Decoding only adds: git's own lines are read too. A file with NULs that is not recognized is searched for
 * the text's UTF-16 and UTF-32 bytes (wideForms); one with no NUL at all and no byte order mark (UTF-16 of
 * letters outside Latin, with no line end) is read as bytes alone (test/input-shapes.test.mjs pins one).
 */

/** @typedef {"utf-16le" | "utf-16be" | "utf-32le" | "utf-32be"} WideEncoding */
/** @typedef {{ encoding: WideEncoding, mark: number }} Wide `mark`: the length of the byte order mark */
/** @typedef {import("./git.mjs").AddedLine} AddedLine */

/** Byte order marks, UTF-32 first: UTF-32LE's starts with UTF-16LE's. */
const MARKS = /** @type {const} */ ([
  ["utf-32le", [0xff, 0xfe, 0, 0]],
  ["utf-32be", [0, 0, 0xfe, 0xff]],
  ["utf-16le", [0xff, 0xfe]],
  ["utf-16be", [0xfe, 0xff]],
]);

/**
 * Whether a line's bytes begin with a byte order mark of UTF-16 or UTF-32.
 * @param {Buffer} bytes
 */
export function startsWithMark(bytes) {
  return markLength(bytes) > 0;
}

/**
 * The length of the byte order mark a file's first bytes begin with, the longest that fits; 0 for none.
 * @param {Buffer} bytes
 */
export function markLength(bytes) {
  return MARKS.find(([, mark]) => mark.every((b, i) => bytes[i] === b))?.[1].length ?? 0;
}

/**
 * The encoding of a file that holds NULs, or null for one that is not text in UTF-16 or UTF-32 (a binary
 * file). The byte order mark decides (UTF-32's only when the rest reads as UTF-32: `FF FE 00 00` is also
 * UTF-16LE's mark and U+0000); without one, UTF-32 has every unit at most U+10FFFF and most in the BMP (a run
 * of four ASCII bytes rules it out), and UTF-16 has the NULs of its Latin letters, digits, spaces and line
 * ends on one side of every pair: a quarter of the pairs or more, and on the other side a sixteenth of that
 * or less.
 * @param {Buffer} blob
 * @returns {Wide | null}
 */
export function wideEncoding(blob) {
  for (const [encoding, mark] of MARKS) {
    if (blob.length < mark.length || !mark.every((b, i) => blob[i] === b)) continue;
    // FF FE 00 00 is also UTF-16LE's mark and U+0000: UTF-32 only when the rest reads as UTF-32.
    if (encoding.startsWith("utf-32") && !utf32(blob, mark.length, encoding === "utf-32le")) continue;
    return { encoding, mark: mark.length };
  }
  if (blob.length >= 4) {
    const le = utf32(blob, 0, true);
    const be = utf32(blob, 0, false);
    if (le !== be) return { encoding: le ? "utf-32le" : "utf-32be", mark: 0 };
  }
  if (blob.length >= 2 && blob.length % 2 === 0) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < blob.length; i++) if (blob[i] === 0) i % 2 ? odd++ : even++;
    const pairs = blob.length / 2;
    if (odd * 4 >= pairs && even * 16 <= odd) return { encoding: "utf-16le", mark: 0 };
    if (even * 4 >= pairs && odd * 16 <= even) return { encoding: "utf-16be", mark: 0 };
  }
  return null;
}

/**
 * Whether the bytes from `from` on read as UTF-32 text: whole units of at most U+10FFFF, most of them in the
 * BMP. UTF-16 text read four bytes at a time also stays under U+10FFFF, but outside the BMP ("x\n" in
 * UTF-16LE is the one unit U+A0078).
 * @param {Buffer} blob @param {number} from @param {boolean} le
 */
function utf32(blob, from, le) {
  if ((blob.length - from) % 4) return false;
  let bmp = 0;
  for (let i = from; i < blob.length; i += 4) {
    const [plane, top] = le ? [blob[i + 2], blob[i + 3]] : [blob[i + 1], blob[i]];
    if (top !== 0 || plane > 0x10) return false;
    if (plane === 0) bmp++;
  }
  return bmp * 2 > (blob.length - from) / 4;
}

/**
 * The bytes of a text in UTF-16 and UTF-32, either byte order, composed and decomposed: what git's lines of a
 * file with NULs are searched for. With `encoding`, only that encoding's (a decoded file: the other byte
 * order would find letters that are not there, UTF-16LE "NOTE" holds U+4E00 big-endian).
 * @param {string} text @param {string} [encoding]
 * @returns {Buffer[]}
 */
export function wideForms(text, encoding) {
  return [...new Set([text.normalize("NFC"), text.normalize("NFD")])].flatMap((t) => {
    const le16 = Buffer.from(t, "utf16le");
    const le32 = Buffer.concat([...t].map((c) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(/** @type {number} */ (c.codePointAt(0)));
      return b;
    }));
    /** @type {Record<string, Buffer>} */
    const forms = { "utf-16le": le16, "utf-16be": Buffer.from(le16).swap16(), "utf-32le": le32, "utf-32be": Buffer.from(le32).swap32() };
    return encoding ? [forms[encoding]].filter(Boolean) : Object.values(forms);
  });
}

/**
 * The text of a file in a wide encoding, without its byte order mark; a unit that is no character (a lone
 * UTF-16 half, a UTF-32 value past U+10FFFF) becomes U+FFFD, and a byte left over at the end is dropped.
 * @param {Buffer} blob @param {Wide} wide
 * @returns {string}
 */
export function decodeWide(blob, { encoding, mark }) {
  const body = blob.subarray(mark);
  if (encoding === "utf-16le") return body.subarray(0, body.length - (body.length % 2)).toString("utf16le");
  if (encoding === "utf-16be") return Buffer.from(body.subarray(0, body.length - (body.length % 2))).swap16().toString("utf16le");
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i + 4 <= body.length; i += 4) {
    const cp = encoding === "utf-32le" ? body.readUInt32LE(i) : body.readUInt32BE(i);
    out.push(cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "�");
  }
  return out.join("");
}

/** The number of sorted values at or below `x`. @param {number[]} sorted @param {number} x */
function atOrBelow(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A wide file's added lines as the decoded lines they are part of. git numbers a line by the newline bytes
 * before it; each such line lies inside one decoded line, the one that holds the newline byte ending it (a
 * decoded line end holds one too), and that decoded line is added whole, numbered as an editor numbers it.
 * In a merge, a decoded line comes from the other side (`from`) when every part of it does.
 * @param {Buffer} blob the staged file @param {Wide} wide @param {AddedLine[]} lines as git numbers them
 * @returns {AddedLine[]}
 */
export function wideLines(blob, wide, lines) {
  const width = wide.encoding.startsWith("utf-16") ? 2 : 4;
  const le = wide.encoding.endsWith("le");
  /** Where each decoded line starts, in bytes. */
  const starts = [0];
  for (let at = wide.mark; at + width <= blob.length; at += width) {
    const unit = width === 2 ? (le ? blob.readUInt16LE(at) : blob.readUInt16BE(at)) : le ? blob.readUInt32LE(at) : blob.readUInt32BE(at);
    if (unit === 0x0a) starts.push(at + width);
  }
  /** Where each of git's lines starts, in bytes. */
  const gitStarts = [0];
  for (let at = blob.indexOf(0x0a); at !== -1; at = blob.indexOf(0x0a, at + 1)) gitStarts.push(at + 1);
  const text = decodeWide(blob, wide).split("\n");
  /** @type {Map<number, { from: (string | undefined)[] }>} */
  const parts = new Map();
  for (const l of lines) {
    // The newline byte that ends git's line; the last line ends with the file.
    const end = Math.min((gitStarts[l.line] ?? blob.length + 1) - 1, blob.length - 1);
    const n = atOrBelow(starts, end);
    const p = parts.get(n) ?? { from: [] };
    p.from.push(l.from);
    parts.set(n, p);
  }
  return [...parts]
    .sort(([a], [b]) => a - b)
    .map(([n, p]) => {
      const from = p.from.every((f) => f !== undefined && f === p.from[0]) ? p.from[0] : undefined;
      return { line: n, text: text[n - 1] ?? "", ...(from ? { from } : {}) };
    });
}
