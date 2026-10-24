/**
 * Secret shapes kept out of commits (`security.secrets`): an added line that holds a credential in a shape only
 * its issuer writes. review.forbidden matches a literal as written; a secret has a shape, not a spelling.
 *
 * High confidence only: each kind is a prefix its issuer documents, with the length and characters the issuer
 * states where it states them, and a boundary on each side, so a hash, a UUID or a base64 blob is no token. A
 * letter before the prefix is a boundary when it ends an escape (`\n`, `\x3d`, `\u003d`; `%3D` is read through
 * the decoded view): a token is often written right after one. Two structural rules let through what no random source writes: a body of
 * fewer than 8 distinct characters (or a third of its length) and one whose letters mostly run in order
 * (`xxxx`, `abcd…`). AWS's documented examples end in "EXAMPLE" (a real key id does once in 36^7). Out, with
 * why: Google API keys (AIza), which Google documents as public identifiers for client code; OpenAI keys, whose
 * format OpenAI does not document; Stripe test-mode and publishable keys; generic passwords and high-entropy
 * strings, which are guesses.
 *
 * Every view of a line is read (`views`): its UTF-8 text, where a NUL is a boundary; for a line that holds a
 * NUL whose bytes with the NULs dropped hold text worth the patterns (an ASCII token survives the drop), the
 * line decoded as UTF-16 and UTF-32 at each alignment and byte order (a letter outside ASCII beside a token
 * too); a line with percent escapes, decoded; and a base64 run that starts as a PEM header does, decoded. A view that holds line
 * breaks is read as lines of its own. Every kind is ASCII, so no file needs to be said unread for its
 * encoding. Each pattern runs in time linear in the line.
 */

import { matchAny } from "../core/glob.mjs";
import { decodeWide, wideEncoding } from "../core/encoding.mjs";

/** @typedef {import("../core/git.mjs").AddedLine} AddedLine */
/** @typedef {{ path: string, line: number, kind: string, shown: string, value: string, from?: string }} SecretHit */

/** The letters that end an escape: a token right after one is at a boundary. */
const ESCAPED = String.raw`(?<=\\[nrtbfv])|(?<=\\[0-7]{1,3})|(?<=\\x[0-9A-Fa-f]{2})|(?<=\\u[0-9A-Fa-f]{4})`;
/** @param {string} cls the characters a token's alphabet has, none of which may stand before it @param {string} body */
const token = (cls, body) => new RegExp(String.raw`(?:(?<![${cls}])|${ESCAPED})` + body, "g");

/** A JWT in compact form (RFC 7519): three base64url parts, two dots, a JSON header ("eyJ"). */
const JWT = /^(?:[0-9]+_)?eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The kinds read in one line. `re` is global; `body` gives the random part the placeholder rules judge, or
 * null when the match is no token after all; `kind` may depend on the match; `prefix` says the first four
 * characters are the issuer's prefix, not the secret, and may be shown.
 * @type {{ kind: string | ((m: RegExpExecArray) => string), re: RegExp, body: (m: RegExpExecArray) => string | null, prefix: boolean, example?: RegExp, value?: (m: RegExpExecArray) => string }[]}
 */
export const SECRET_KINDS = [
  // docs.github.com, "GitHub's token formats" (the prefixes); github.blog 2021-04-05, "Behind GitHub's new
  // authentication token formats": 40 characters as before, Base62, a CRC32 in the last six.
  { kind: "github-token", re: token("A-Za-z0-9_", "gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])"), body: (m) => m[0].slice(4), prefix: true },
  // github.blog changelog 2026-05-15: a stateless installation token is a `ghs_`-prefixed JWT, ~520 characters,
  // two dots; GitHub's own pattern for both forms is `ghs_[A-Za-z0-9\.\-_]{36,}`. Matched by it, kept when the
  // run is a JWT (docs.github.com writes it `ghs_APPID_JWT`); the opaque form is the line above.
  {
    kind: "github-token",
    re: token("A-Za-z0-9_", String.raw`ghs_[A-Za-z0-9._-]{36,1024}`),
    body: (m) => {
      const run = m[0].slice(4).replace(/[._-]+$/, "");
      return JWT.test(run) ? run : null;
    },
    value: (m) => `ghs_${m[0].slice(4).replace(/[._-]+$/, "")}`,
    prefix: true,
  },
  // docs.github.com: fine-grained personal access tokens start "github_pat_"; their length is not documented.
  { kind: "github-token", re: token("A-Za-z0-9_", "github_pat_[A-Za-z0-9_]{50,255}"), body: (m) => m[0].slice(11), prefix: true },
  // docs.gitlab.com/security/tokens: personal, project and group access tokens start "glpat-" (an
  // administrator can change it); 20 characters after it, or 37 to 310 for routable tokens (gitlab-org/gitlab!169322).
  { kind: "gitlab-token", re: token("A-Za-z0-9_-", "glpat-[A-Za-z0-9_-]{20}[A-Za-z0-9_.-]{0,290}"), body: (m) => m[0].slice(6), prefix: true },
  // github.blog 2021-09-23, "Announcing npm's new access token format": "npm_", GitHub's format, 178 bits:
  // 30 Base62 characters and a six-character CRC32.
  { kind: "npm-token", re: token("A-Za-z0-9_", "npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])"), body: (m) => m[0].slice(4), prefix: true },
  // docs.slack.dev/authentication/tokens: bot tokens "xoxb-", user tokens "xoxp-"; its example is the prefix,
  // three numbers and 32 hex digits, each part after a dash.
  { kind: "slack-token", re: token("A-Za-z0-9_.-", "xox[bp]-[0-9]{1,32}-[0-9]{1,32}(?:-[0-9]{1,32})?-[A-Za-z0-9]{20,255}"), body: (m) => m[0].slice(m[0].lastIndexOf("-") + 1), prefix: true },
  // docs.slack.dev/authentication/using-token-rotation: rotated tokens "xoxe.xoxb-1-", "xoxe.xoxp-1-",
  // "xoxe.xapp-1-", refresh tokens "xoxe-1-"; the rest is not shown, so at least 40 of its characters.
  { kind: "slack-token", re: token("A-Za-z0-9_.-", "xoxe(?:\\.xox[bp]|\\.xapp)?-1-[A-Za-z0-9-]{40,1024}"), body: (m) => m[0].slice(m[0].indexOf("-1-") + 3).replace(/-/g, ""), prefix: true },
  // docs.stripe.com/keys: live secret keys "sk_live_", live restricted keys "rk_live_", neither safe to expose.
  { kind: "stripe-key", re: token("A-Za-z0-9_", "[sr]k_live_[A-Za-z0-9]{20,255}"), body: (m) => m[0].slice(8), prefix: true },
  // The rule Anthropic gave GitLab's secret detection (gitlab-org/security-products/analyzers/secrets!319).
  { kind: "anthropic-key", re: token("A-Za-z0-9_-", "sk-ant-[a-z]{3}[0-9]{2}-[A-Za-z0-9_-]{86}-[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])"), body: (m) => m[0].slice(13), prefix: true },
  // docs.anthropic.com/en/api/administration-api: Admin API keys start "sk-ant-admin"; their length is not
  // documented, so at least 60 characters after the version.
  { kind: "anthropic-key", re: token("A-Za-z0-9_-", "sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{60,255}"), body: (m) => m[0].slice(m[0].indexOf("-", 12) + 1), prefix: true },
  // docs.pypi.org/api/secrets: "pypi-" and a base64 macaroon of at least 85 characters.
  { kind: "pypi-token", re: token("A-Za-z0-9_-", "pypi-[A-Za-z0-9_-]{85,4096}"), body: (m) => m[0].slice(5), prefix: true },
  // IAM user guide, "Understanding unique ID prefixes": AKIA an access key, ASIA a temporary one;
  // "AKIAIOSFODNN7EXAMPLE", 20 characters.
  { kind: "aws-access-key-id", re: token("A-Za-z0-9", "(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"), body: (m) => m[0].slice(4), prefix: true, example: /EXAMPLE$/ },
  // IAM user guide, "Manage access keys": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", 40 characters; any 40
  // characters could look like it, so only beside a secret key's name, as the CLI, its credentials file,
  // configure-aws-credentials, Terraform and the SDKs spell it: aws_secret_access_key, --aws-secret-access-key,
  // SecretAccessKey, AWS_SECRET_KEY, secret_key; after "=", ":", "=>" or a space. One with no "aws" or "access"
  // in its name is a secret key all the same (a framework's signing key), and is named so.
  {
    kind: (m) => (/aws|access/i.test(m[1]) ? "aws-secret-access-key" : "secret-key"),
    re: /(?<![A-Za-z0-9])((?:aws[_-]?)?secret[_-]?(?:access[_-]?)?key)["']?(?:[ \t]{0,16}(?:=>|[:=])[ \t]{0,16}|[ \t]{1,16})["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    body: (m) => m[2],
    prefix: false,
    example: /EXAMPLEKEY$/,
  },
];

/**
 * A private key's header: PKCS#8 (RFC 7468: PRIVATE KEY, ENCRYPTED PRIVATE KEY), the PKCS#1 and SEC 1 labels
 * OpenSSL writes (RSA, EC, DSA), OpenSSH's (PROTOCOL.key), OpenPGP's armor (RFC 4880 §6.2), the ssh.com key
 * PuTTYgen exports, and PuTTY's own file (the PuTTY manual, appendix C, "PPK file format").
 */
const KEY_HEADER = /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----|PuTTY-User-Key-File-[23]: /;
/** Key material on the header's own line: after quotes, spaces and escaped line breaks, a base64 run. */
const INLINE_BODY = /^(?:\\[rn]|[\s"'+,\\]){0,64}([A-Za-z0-9+/]{40,4096})/;
/** A line of key material: at least this many base64 characters, once its marker and what code puts around it are off. */
const BODY_MIN = 40;
/** An armor header (RFC 4880 §6.2, RFC 1421's Proc-Type and DEK-Info): skipped between the header and the material. */
const ARMOR = /^[A-Za-z][A-Za-z0-9-]{0,64}: /;
/** How many armor headers and blank lines may come between the header and the material. */
const ARMOR_MAX = 16;
/** A key file's last line: the block ends there. */
const KEY_FOOTER = /-----END [A-Z0-9 ]{0,64}-----|---- END SSH2 ENCRYPTED PRIVATE KEY ----|^Private-MAC: /;
/** A base64 run that starts as a PEM header does ("-----BEGIN" in base64): a kubeconfig's client-key-data. */
const PEM_BASE64 = /LS0tLS1CRUdJTi[A-Za-z0-9+/]{0,65536}={0,2}/g;
/** Text worth the patterns: a line with none of these holds no kind (case-folded, so a superset). */
const NEAR = /gh[pousr]_|github_pat_|glpat-|npm_|xox[bpe]|xapp|k_live_|sk-ant-|pypi-|akia|asia|secret|-----begin|---- begin ssh2|putty-user-key-file|ls0tls1crudjti/i;
/**
 * Every pattern a line meets, for the test that each repeat in them is bounded: V8 runs out of stack on a run
 * of megabytes under an open repeat (`{40,}`), and a hook that crashes refuses the commit.
 */
export const LINE_PATTERNS = [...SECRET_KINDS.map((k) => k.re), KEY_HEADER, INLINE_BODY, ARMOR, KEY_FOOTER, PEM_BASE64, NEAR];

/** The globs that name every path, and so turn the scan off. */
const CATCH_ALL = ["**", "**/*", "**/**"];
/**
 * Whether except names every path, so the scan is off: only a list that holds a catch-all glob. A list of globs
 * that together reach far (`a*`, `a/**`) leaves the scan on; judged by samples it could turn it off unseen.
 * @param {string[]} except
 */
export const secretsOff = (except) => except.some((g) => CATCH_ALL.includes(g));

/**
 * Whether a body is a placeholder no random source writes: few distinct characters, or letters that mostly
 * run in order (each the one after the last).
 * @param {string} body
 */
export function placeholder(body) {
  const chars = [...body];
  if (new Set(chars).size < Math.min(8, Math.floor(chars.length / 3))) return true;
  let up = 0;
  for (let i = 1; i < chars.length; i++) if (chars[i].charCodeAt(0) === chars[i - 1].charCodeAt(0) + 1) up++;
  return up * 2 >= chars.length - 1;
}

/**
 * A line with its comment or quote marker off (`#`, `//`, ` * `, `> `, `- `, `;`). One class repeated whole is
 * safe on a run of megabytes (measured: V8 keeps no stack for it); a repeat with a floor (`{40,}`) is not.
 * @param {string} text
 */
const unmarked = (text) => text.replace(/^[\s#*>;%!/-]+/, "");

/** The characters a string or a continuation puts around a line of code: quotes, `,`, `+`, `\\`, spaces. */
const AROUND = new Set([..."\"',+\\ \t\r"]);

/** A body line's base64, or null: one run, with its marker, escaped line breaks and what code puts around it off. @param {string} text */
function bodyLine(text) {
  // A key's line holds a run of 40 base64 characters; most lines hold none, and cost no more.
  if (!/[A-Za-z0-9+/]{40}/.test(text)) return null;
  const line = unmarked(text).replace(/\\[rn]/g, "");
  // Trimmed a character at a time: a run of them costs its length.
  let start = 0;
  let end = line.length;
  while (start < end && AROUND.has(line[start])) start++;
  while (end > start && AROUND.has(line[end - 1])) end--;
  while (end > start && line[end - 1] === "=") end--;
  const bare = line.slice(start, end);
  // A search for one letter that is not base64, not a run matched whole: V8 runs out of stack on a run of megabytes.
  return bare.length >= BODY_MIN && !/[^A-Za-z0-9+/]/.test(bare) && !placeholder(bare) ? bare : null;
}

/** A line that is base64 and nothing else, once what code puts around it is off, or null. @param {string[] | undefined} views */
function base64Run(views) {
  for (const v of views ?? []) {
    const bare = unmarked(v).replace(/^[\s"']{1,64}|[\s"',+\\]{1,64}$/g, "");
    if (bare.length >= 4 && bare.length <= 4096 && !/[^A-Za-z0-9+/=]/.test(bare)) return bare;
  }
  return null;
}

/** Whether a line may stand between a key's header and its material: blank, or an armor header. @param {string} text */
const between = (text) => {
  const bare = unmarked(text).replace(/^["']{1,8}/, "");
  return bare.replace(/\\[rn]|["'+,\s\\]/g, "") === "" || ARMOR.test(bare);
};

/** What a hit shows: the kind, the issuer's prefix when the kind has one, and the length. @param {string} kind @param {string} value @param {boolean} prefix */
const shownAs = (kind, value, prefix) => `${kind}${prefix ? ` ${value.slice(0, 4)}…` : ""}, ${value.length} characters`;

/**
 * The material after a key header at `at` in `text`: on its own line, or on the first line after it that is
 * not blank or an armor header (`next(n)`: the views of the line n after this one, if there is one).
 * @param {string} text @param {RegExpExecArray} header @param {(n: number) => string[] | undefined} next
 */
function keyMaterial(text, header, next) {
  const inline = INLINE_BODY.exec(text.slice(header.index + header[0].length))?.[1];
  if (inline && !placeholder(inline)) return inline;
  for (let n = 1; n <= ARMOR_MAX + 1; n++) {
    const views = next(n);
    if (!views) return null;
    for (const v of views) {
      const b = bodyLine(v);
      if (b) return b;
    }
    if (!views.some(between)) return null;
  }
  return null;
}

/**
 * The secrets in one view of a line: each match of a kind, and a private key header with its material.
 * @param {string} text @param {(n: number) => string[] | undefined} next
 * @returns {{ kind: string, value: string, shown: string }[]}
 */
function lineSecrets(text, next) {
  /** @type {{ kind: string, value: string, shown: string }[]} */
  const out = [];
  if (!NEAR.test(text)) return out;
  for (const k of SECRET_KINDS) {
    k.re.lastIndex = 0;
    for (let m; (m = k.re.exec(text)); ) {
      const body = k.body(m);
      if (body === null || placeholder(body) || k.example?.test(body)) continue;
      const kind = typeof k.kind === "function" ? k.kind(m) : k.kind;
      const value = k.value ? k.value(m) : k.prefix ? m[0] : body;
      out.push({ kind, value, shown: shownAs(kind, value, k.prefix) });
    }
  }
  const header = KEY_HEADER.exec(text);
  if (header) {
    const material = keyMaterial(text, header, next);
    if (material) out.push({ kind: "private-key", value: material, shown: "private-key" });
  }
  // All runs first: reading one reads the patterns again, this one too. A run that ends the line goes on in the
  // lines after it while they are base64 alone (GNU base64 and Python wrap at 76 columns, openssl at 64).
  for (let run of text.match(PEM_BASE64) ?? []) {
    if (text.trimEnd().endsWith(run)) {
      for (let n = 1, more; run.length < 65536 && (more = base64Run(next(n))); n++) run += more;
    }
    out.push(...linesSecrets(Buffer.from(run, "base64").toString("latin1")));
  }
  // One token matched by two kinds' patterns (an opaque prefix of a longer one) is the longer one.
  return out.filter((s) => !out.some((o) => o !== s && o.kind === s.kind && o.value.length > s.value.length && o.value.includes(s.value)));
}

/** The secrets in a text that holds line breaks, each line read with the ones after it. @param {string} text */
function linesSecrets(text) {
  const lines = text.split(/\r?\n|\r/);
  return lines.flatMap((l, i) => lineSecrets(l, (n) => (i + n < lines.length ? [lines[i + n]] : undefined)));
}

/** UTF-32 at one alignment and byte order, a letter for each four bytes. @param {Buffer} b @param {number} at @param {boolean} le */
function utf32(b, at, le) {
  let out = "";
  for (let i = at; i + 4 <= b.length; i += 4) {
    const cp = le ? b.readUInt32LE(i) : b.readUInt32BE(i);
    out += cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "�";
  }
  return out;
}

/**
 * Every view of a line the scan reads. The text (a NUL in it is a boundary); for a line that holds a NUL whose
 * bytes with the NULs dropped hold text worth the patterns, the line as UTF-16 and UTF-32 at every alignment
 * and byte order; with percent escapes, the line decoded.
 * @param {AddedLine} l
 * @returns {string[]}
 */
export function views(l) {
  const out = [l.text];
  const raw = l.raw;
  if (raw?.length && raw.includes(0)) {
    // Decoded for the kinds' prefixes and for key material alike: a gate tuned for the one would hide the other.
    const dropped = raw.toString("latin1").replace(/\0/g, "");
    if (NEAR.test(dropped) || /[A-Za-z0-9+/]{40}/.test(dropped)) {
      for (const at of [0, 1]) {
        const even = raw.subarray(at, raw.length - ((raw.length - at) % 2));
        out.push(even.toString("utf16le"), Buffer.from(even).swap16().toString("utf16le"));
      }
      if (raw.includes(Buffer.from([0, 0, 0]))) for (const at of [0, 1, 2, 3]) out.push(utf32(raw, at, true), utf32(raw, at, false));
    }
  }
  // Percent escapes decoded, and again for one escaped twice (%253D), three times at most.
  for (let v = l.text, k = 0; k < 3 && v.includes("%") && /%[0-9A-Fa-f]{2}/.test(v); k++) out.push((v = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))));
  return out;
}

/** How many lines after one the scan keeps to read it with: a key's armor headers and material, a base64-wrapped key. */
const LOOKAHEAD = 256;
/** A line longer than this is read in pieces that overlap by a token's length or more: its views stay bounded. */
const PIECE = 1024 * 1024;
const OVERLAP = 16 * 1024;
/** The shortest text any kind, key header or line of key material is ("AKIA" and 16 letters). */
const SHORTEST = 20;
/** The most bytes of lines the scan keeps ahead: past them it reads the oldest with fewer lines after it. */
const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * The secret scan over lines as they come, file by file, keeping only what a later line needs: the hits, the
 * last LOOKAHEAD lines' views (a key's header is read with the lines after it), and the numbers of the lines
 * that look like part of a key in a file where no key was found (`near`: the hook reads those files whole,
 * keysAround). Memory is bounded by LOOKAHEAD lines and WINDOW_BYTES, whatever the commit adds. A hit
 * says where and what kind; `value` is the secret, for masking, never for output.
 */
export class SecretScanner {
  constructor() {
    /** @type {SecretHit[]} */
    this.hits = [];
    /** @type {Map<string, { line: number, decoded?: string }[]>} */
    this.near = new Map();
    /** @type {string | null} */
    this.path = null;
    /** @type {{ line: number, views: string[], bytes: number, from?: string, decoded?: string }[]} */
    this.window = [];
    /** Where the lines kept start in `window` (a shift of the array would cost its length). */
    this.start = 0;
    this.windowBytes = 0;
    /** @type {{ kind: string, value: string }[]} */
    this.seen = [];
    this.keyFound = false;
    /** @type {{ line: number, decoded?: string }[]} */
    this.keyLines = [];
  }

  /** Starts a file's lines. @param {string} path */
  file(path) {
    this.close();
    this.path = path;
    this.seen = [];
    this.keyFound = false;
    this.keyLines = [];
  }

  /** Starts another numbering of the same file (its decoded lines, then git's): what was found stays found. */
  view() {
    while (this.kept) this.shift();
  }

  /** How many lines are kept ahead. */
  get kept() {
    return this.window.length - this.start;
  }

  /** Reads the oldest line kept. */
  shift() {
    const entry = this.window[this.start++];
    if (this.start > 1024 && this.start * 2 > this.window.length) (this.window = this.window.slice(this.start)), (this.start = 0);
    this.windowBytes -= entry.bytes;
    this.process(entry);
  }

  /**
   * One added line, as git wrote it (`raw`), or decoded (`decoded`: the encoding, `text` the line).
   * @param {number} line @param {Buffer | null} raw @param {{ text?: string, decoded?: string, from?: string }} [more]
   */
  line(line, raw, { text, decoded, from } = {}) {
    if (raw && raw.length > PIECE) {
      // Each piece on its own, read with no line after it.
      for (let at = 0; at < raw.length; at += PIECE - OVERLAP) this.process({ line, views: views(this.added(line, raw.subarray(at, at + PIECE))), ...(from ? { from } : {}) }, true);
      return;
    }
    const l = raw ? this.added(line, raw) : { line, text: String(text) };
    const bytes = raw ? raw.length : l.text.length;
    this.window.push({ line, views: views(l), bytes, ...(from ? { from } : {}), ...(decoded ? { decoded } : {}) });
    this.windowBytes += bytes;
    while (this.kept > LOOKAHEAD || (this.windowBytes > WINDOW_BYTES && this.kept > 1)) this.shift();
  }

  /** A line's bytes as the views read them: the text, and the bytes when they hold a NUL. @param {number} line @param {Buffer} raw */
  added(line, raw) {
    return raw.includes(0) ? { line, text: raw.toString("utf8"), raw } : { line, text: raw.toString("utf8") };
  }

  /**
   * @param {{ line: number, views: string[], bytes?: number, from?: string, decoded?: string }} entry
   * @param {boolean} [alone] read with no line after it
   */
  process(entry, alone = false) {
    const next = (/** @type {number} */ n) => {
      const after = alone || n > this.kept ? undefined : this.window[this.start + n - 1];
      return after && after.line === entry.line + n ? after.views : undefined;
    };
    // No kind, header or key line is shorter than SHORTEST: most lines cost a length check.
    if (!entry.views.some((v) => v.length >= SHORTEST)) return;
    for (const view of entry.views) {
      if (view.length < SHORTEST) continue;
      // A CR that ends the line (CRLF) is no line break inside it; one a decoded view holds is.
      const v = view.endsWith("\r") ? view.slice(0, -1) : view;
      for (const s of /[\r\n]/.test(v) ? linesSecrets(v) : lineSecrets(v, next)) this.push(entry.line, s, entry.from);
    }
    if (entry.views.some((v) => v.length >= SHORTEST && (KEY_HEADER.test(v) || bodyLine(v) !== null))) this.keyLines.push({ line: entry.line, ...(entry.decoded ? { decoded: entry.decoded } : {}) });
  }

  /** @param {number} line @param {{ kind: string, value: string, shown: string }} s @param {string} [from] */
  push(line, s, from) {
    // One secret read in two views, where one view's letter after it joins a token of no fixed length.
    if (this.seen.some((o) => o.kind === s.kind && (o.value.includes(s.value) || s.value.includes(o.value)))) return;
    this.seen.push(s);
    if (s.kind === "private-key") this.keyFound = true;
    this.hits.push({ path: /** @type {string} */ (this.path), line, kind: s.kind, shown: s.shown, value: s.value, ...(from ? { from } : {}) });
  }

  /** Reads what is left of the file. */
  close() {
    this.view();
    if (this.path !== null && !this.keyFound && this.keyLines.length) this.near.set(this.path, this.keyLines);
    this.path = null;
  }

  /**
   * The keys around a file's added lines, from the file read whole (keysAround), added to the hits.
   * @param {string} path @param {Buffer} blob
   */
  around(path, blob) {
    const lines = this.near.get(path);
    if (!lines) return;
    this.path = path;
    this.seen = this.hits.filter((h) => h.path === path);
    for (const k of keysAround(blob, lines)) this.push(k.line, k.secret);
    this.path = null;
  }
}

/**
 * The secrets the added lines hold, per path `except` does not name: one hit per secret and file (a decoded
 * line and git's own line of the same text are one), at the line an editor shows when the file was decoded.
 * `files`: the staged files read whole, where a private key whose header or material the commit leaves in place
 * is found around the lines it adds. The hook streams git's lines through SecretScanner itself.
 * @param {Map<string, AddedLine[]>} added
 * @param {{ except?: string[], files?: Map<string, Buffer> }} [opts]
 * @returns {SecretHit[]}
 */
export function secretHits(added, { except = [], files = new Map() } = {}) {
  const scan = new SecretScanner();
  for (const [path, lines] of added) {
    if (matchAny(path, except)) continue;
    scan.file(path);
    // Decoded lines first: numbered as an editor numbers them. Each view has its own numbering.
    for (const l of lines.filter((x) => x.decoded)) scan.line(l.line, null, { text: l.text, decoded: l.decoded, from: l.from });
    scan.view();
    for (const l of lines.filter((x) => !x.decoded)) scan.line(l.line, l.raw ?? Buffer.from(l.text, "utf8"), { from: l.from });
    scan.close();
    const whole = files.get(path);
    if (whole) scan.around(path, whole);
  }
  return scan.hits;
}

/**
 * The private keys of a staged file that hold a line the commit adds, header to footer: a key regenerated
 * under a header the commit keeps, material added under a header committed before.
 * @param {Buffer} blob @param {{ line: number, decoded?: string }[]} lines
 */
function keysAround(blob, lines) {
  // Decoded as the added lines were; any other file is read as git splits it, at its newline bytes, NULs dropped.
  const decoded = lines.some((l) => l.decoded);
  const wide = decoded ? wideEncoding(blob) : null;
  const text = wide ? decodeWide(blob, wide) : blob.toString("latin1").replace(/\0/g, "");
  const file = text.split("\n");
  const mine = lines.filter((l) => Boolean(l.decoded) === Boolean(wide));
  /** @type {{ line: number, secret: { kind: string, value: string, shown: string } }[]} */
  const out = [];
  file.forEach((row, i) => {
    const header = KEY_HEADER.exec(row);
    if (!header) return;
    const material = keyMaterial(row, header, (n) => (i + n < file.length ? [file[i + n]] : undefined));
    if (!material) return;
    let end = i + 1;
    while (end < file.length && end - i < 10000 && !KEY_FOOTER.test(file[end])) end++;
    // Header to footer, numbered from 1.
    const inside = mine.find((l) => l.line >= i + 1 && l.line <= end + 1);
    if (inside) out.push({ line: inside.line, secret: { kind: "private-key", value: material, shown: "private-key" } });
  });
  return out;
}

/**
 * The paths whose added lines look like part of a private key (a header, or key material) where no key was
 * found in the added lines alone: the hook reads these whole from the index for keysAround.
 * @param {Map<string, AddedLine[]>} added
 * @param {{ except?: string[] }} [opts]
 */
export function keyCandidates(added, { except = [] } = {}) {
  const scan = new SecretScanner();
  for (const [path, lines] of [...added].filter(([p]) => !matchAny(p, except))) {
    scan.file(path);
    for (const l of lines) scan.line(l.line, l.raw ?? Buffer.from(l.text, "utf8"));
  }
  scan.close();
  return [...scan.near.keys()];
}

/**
 * The secrets a text holds (a staged name, the commit message), each with the line it is on.
 * @param {string} text
 */
export function textSecrets(text) {
  const lines = text.split("\n");
  return lines.flatMap((l, i) => lineSecrets(l, (n) => (i + n < lines.length ? [lines[i + n]] : undefined)).map((s) => ({ ...s, line: i + 1 })));
}

/**
 * A text with every secret it holds cut to what a hit shows of it (an issuer's prefix), for output.
 * @param {string} text
 */
export function masked(text) {
  let out = text;
  for (const s of textSecrets(text)) out = out.split(s.value).join(s.shown.includes("…") ? `${s.value.slice(0, 4)}…` : "…");
  return out;
}
