import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LINE_PATTERNS, SecretScanner, keyCandidates, masked, secretHits } from "../plugin/checks/secrets.mjs";
import { checkCommitShape, secretErrors } from "../plugin/checks/commit-shape.mjs";
import { loadConfig, ConfigError } from "../plugin/core/config.mjs";
import { git } from "../plugin/core/git.mjs";
import { installHook } from "../plugin/setup/hook.mjs";
import { checkSetup } from "../plugin/setup/doctor.mjs";
import { B62, B64, B64URL, HEX, KIND, PREFIX as P, TOKENS, UPPER_DIGITS, body, pem, rand } from "./secret-shapes.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "ennyn.mjs");
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/** The hits in one file's added lines, numbered from 1. @param {string[]} lines @param {string[]} [except] */
const scan = (lines, except = [], path = "src/a.txt") => secretHits(new Map([[path, lines.map((text, i) => ({ line: i + 1, text }))]]), { except });

/** How each token is written in a project: as a value, in a URL, in JSON, YAML and .npmrc. @param {string} t */
const contexts = (t) => [t, `token = "${t}"`, `export SOME_TOKEN=${t}`, `https://x-access-token:${t}@github.com/o/r.git`, `{"token":"${t}"}`, `token: ${t}`, `//registry.npmjs.org/:_authToken=${t}`, `${t} # rotate`];

test("secrets reject corpus: every token kind, in every way a project writes it, is found and named by kind", () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    if (name === "awsSecret") continue;
    for (const line of contexts(token)) {
      const hits = scan([line]);
      assert.equal(hits.length, 1, `${name}: ${line.slice(0, 40)}`);
      assert.equal(hits[0].kind, KIND[/** @type {keyof typeof KIND} */ (name)], name);
    }
  }
  // An AWS secret key is 40 characters anything could hold: only beside its key name.
  for (const line of [`aws_secret_access_key = ${TOKENS.awsSecret}`, `AWS_SECRET_ACCESS_KEY="${TOKENS.awsSecret}"`, `"SecretAccessKey": "${TOKENS.awsSecret}",`, `secret_access_key: '${TOKENS.awsSecret}'`]) {
    assert.deepEqual(scan([line]).map((h) => h.kind), ["aws-secret-access-key"], line);
  }
  // Two in one line, two lines: each one.
  assert.equal(scan([`${TOKENS.github} ${TOKENS.npm}`, TOKENS.stripe]).length, 3);
});

test("secrets reject corpus: a private key is its header with key material after it, on its lines or escaped in one", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const { begin, end } = pem(label);
    assert.deepEqual(scan([begin, ...body(3), end]).map((h) => [h.kind, h.line]), [["private-key", 1]], label);
    // YAML block scalars and heredocs indent it.
    assert.equal(scan(["key: |", `  ${begin}`, ...body(2).map((b) => `  ${b}`), `  ${end}`]).length, 1, `${label} indented`);
    // A service account's JSON, a string in code: the line breaks escaped.
    assert.equal(scan([`  "private_key": "${begin}\\n${body(1)[0]}\\n${end}\\n",`]).length, 1, `${label} escaped`);
    assert.equal(scan([`key = "${begin}\\\\n${body(1)[0]}"`]).length, 1, `${label} escaped twice`);
  }
  // Armor headers come between the header and the body.
  const pgp = pem("PGP PRIVATE KEY BLOCK");
  assert.equal(scan([pgp.begin, "Version: GnuPG v2", "", ...body(2), pgp.end]).length, 1);
  const rsa = pem("RSA PRIVATE KEY");
  assert.equal(scan([rsa.begin, "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF", "", ...body(2), rsa.end]).length, 1);
});

test("secrets accept corpus: placeholders, examples, references, patterns, hashes, public keys and prose are no secret", () => {
  const x = (/** @type {number} */ n, c = "x") => c.repeat(n);
  const accept = [
    // Placeholders: no random source writes a run of one letter, or letters in order.
    P.ghp + x(36),
    P.ghp + x(36, "X"),
    P.ghp + "1234567890abcdefghijklmnopqrstuvwxyz",
    P.ghp + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    P.npm + x(36, "0"),
    P.sk + x(24),
    P.akia + x(16, "X"),
    `${P.xoxb}your-bot-token`,
    `${P.xoxb}123-456-abcdef`,
    `${P.ghp}<your token>`,
    `${P.ghp}...`,
    `${P.ant}...`,
    `${P.pat}${x(82, "x")}`,
    // AWS's own documented examples (IAM user guide): a real id ends in "EXAMPLE" once in 36^7.
    P.akia + "IOSFODNN7EXAMPLE",
    P.akia + "I44QH8DHBEXAMPLE",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    // References to a secret, not the secret.
    "token: ${{ secrets.GITHUB_TOKEN }}",
    "const t = process.env.NPM_TOKEN;",
    "export AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY",
    "aws_secret_access_key = !Ref SecretKey",
    // Patterns that describe a token.
    "/gh[pousr]_[A-Za-z0-9]{36}/",
    `"${P.npm}[A-Za-z0-9]{36}"`,
    `${P.akia}[A-Z0-9]{16}`,
    "xox[bp]-\\d+-\\d+",
    // Hashes, ids, base64: long and random, but no issuer's shape.
    rand(40, HEX, 41),
    rand(64, HEX, 42),
    `"integrity": "sha512-${rand(86, B64, 43)}=="`,
    "550e8400-e29b-41d4-a716-446655440000",
    rand(64, B64, 44),
    `${rand(10, B62, 45)}${P.akia}${rand(16, UPPER_DIGITS, 46)}`,
    `${rand(10, B62, 47)}${TOKENS.npm}`,
    // A token kind's text inside a longer run is no token.
    `${P.ghp}${rand(40, B62, 48)}`,
    // Keys anyone may hold: Stripe's publishable and test keys.
    `pk_live_${rand(24, B62, 49)}`,
    `sk_test_${rand(24, B62, 50)}`,
    // Prose that names a prefix.
    "GitHub tokens start with ghp_, gho_ or github_pat_; npm's with npm_.",
    // A public key, a certificate.
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + rand(40, B64, 51) + " me@host",
  ];
  for (const line of accept) assert.deepEqual(scan([line]), [], line);
  for (const label of ["PUBLIC KEY", "CERTIFICATE", "PGP PUBLIC KEY BLOCK", "RSA PUBLIC KEY"]) {
    const { begin, end } = pem(label);
    assert.deepEqual(scan([begin, ...body(3), end]), [], label);
  }
  // A header with no key material: code that looks for one, a regular expression, a placeholder body.
  const { begin, end } = pem("PRIVATE KEY");
  for (const lines of [
    [`if (pem.startsWith("${begin}")) return decodePkcs8AndValidateTheKeyMaterialBeforeUse(pem);`],
    [`const RE = /${begin}([A-Za-z0-9+/=\\s]+)${end}/;`],
    [begin, "<your key here>", end],
    [begin, x(64, "A"), end],
    [begin],
    [begin, "const next = 1;", rand(64, B64, 52)],
  ]) {
    assert.deepEqual(scan(lines), [], lines.join(" / "));
  }
});

test("secrets: a hit says where and what kind, never the secret; except names the files that may hold one", () => {
  const hits = scan(["a", `token = "${TOKENS.github}"`]);
  assert.deepEqual(hits.map(({ path, line, kind }) => ({ path, line, kind })), [{ path: "src/a.txt", line: 2, kind: "github-token" }]);
  assert.ok(!hits[0].shown.includes(TOKENS.github.slice(4, 10)), hits[0].shown);
  assert.match(hits[0].shown, /^github-token gh.{2}…, 40 characters$/);
  assert.match(scan([`aws_secret_access_key = ${TOKENS.awsSecret}`])[0].shown, /^aws-secret-access-key, 40 characters$/);
  assert.equal(scan([pem("RSA PRIVATE KEY").begin, ...body(1)])[0].shown, "private-key");
  assert.deepEqual(scan([TOKENS.npm], ["test/fixtures/**"], "test/fixtures/npmrc"), []);
  assert.equal(scan([TOKENS.npm], ["test/fixtures/**"], "src/npmrc").length, 1);
});

test("secrets: a line's bytes are read as they are, with NULs dropped (UTF-16, UTF-32) and 8-bit letters left alone", () => {
  const t = TOKENS.github;
  /** @param {Buffer} raw */
  const line = (raw) => ({ line: 1, text: raw.toString("utf8"), raw });
  const utf16le = Buffer.from(`k=${t}`, "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  const utf32 = Buffer.concat([...`k=${t}`].map((c) => Buffer.from([c.charCodeAt(0), 0, 0, 0])));
  const latin1 = Buffer.from(`café ${t}`, "latin1");
  for (const [name, raw] of Object.entries({ utf16le, utf16be, utf32, latin1, oddAligned: Buffer.concat([Buffer.from([0]), utf16le]) })) {
    assert.equal(secretHits(new Map([["f", [line(raw)]]])).length, 1, name);
  }
  // A decoded line and git's own line of the same file name one secret once, at the line an editor shows.
  const decoded = { line: 3, text: `k=${t}`, decoded: "utf-16le" };
  const hits = secretHits(new Map([["f", [line(utf16le), decoded]]]));
  assert.deepEqual(hits.map((h) => h.line), [3]);
});

test("secrets: security.secrets.except takes a list of globs, each one that compiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "en-sec-cfg-"));
  assert.deepEqual(loadConfig({ cwd: dir, env: {} }).security.secrets.except, []);
  assert.deepEqual(loadConfig({ cwd: dir, env: {}, override: { security: { secrets: { except: ["test/fixtures/**"] } } } }).security.secrets.except, ["test/fixtures/**"]);
  for (const bad of [{ except: "x" }, { except: [""] }, { except: [3] }, { except: ["[z-a]"] }, { other: [] }]) {
    assert.throws(() => loadConfig({ cwd: dir, env: {}, override: { security: { secrets: bad } } }), ConfigError, JSON.stringify(bad));
  }
});

test("secrets: checkCommitShape refuses for every subject, an empty message and the bypass marker, and names the merge's side", () => {
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-")), env: {} });
  const secretLines = new Map([["src/a.js", [{ line: 4, text: `t = "${TOKENS.npm}"` }]]]);
  for (const message of ["feat: add a client\n", "", "Merge branch 'x'\n", "fixup! feat: a\n", "feat: a\n\n[commit-shape-allow: the fixture needs it]\n"]) {
    const res = checkCommitShape(message, { config, stagedPaths: ["src/a.js"], cleanup: "whitespace", secretLines });
    assert.equal(res.ok, false, JSON.stringify(message));
    assert.match(res.errors[0], /src\/a\.js:4 \(npm-token np.{2}…, 40 characters\)/);
    assert.ok(!res.errors.join("\n").includes(TOKENS.npm.slice(4)), "the error holds no secret");
  }
  const merged = new Map([["src/a.js", [{ line: 4, text: TOKENS.npm, from: "abcdef1234567890" }]]]);
  assert.match(checkCommitShape("Merge branch 'x'\n", { config, stagedPaths: ["src/a.js"], secretLines: merged }).errors[0], /abcdef1234/);
  assert.equal(checkCommitShape("feat: a\n", { config, stagedPaths: ["src/a.js"], secretLines: new Map([["src/a.js", [{ line: 1, text: "plain" }]]]) }).ok, true);
});

test("secrets round two: a token right after an escape is at a boundary (\\n, \\t, %3D, \\x3d, \\u003d); a plain letter before it is not", () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    if (name === "awsSecret") continue;
    for (const line of [`{"log": "in\\n${token}\\n"}`, `"a\\t${token}"`, `next=cb%3Ftoken%3D${token}`, `s = "k\\x3d${token}"`, `"q": "k\\u003d${token}"`, `"a\\\\n${token}"`]) {
      assert.equal(scan([line]).length, 1, `${name}: ${line.slice(0, 30)}`);
    }
  }
  for (const line of [`xn${TOKENS.github}`, `%G1${TOKENS.npm}`, `\\q${TOKENS.github}`, `%4${TOKENS.npm}`, `abc${TOKENS.stripe}`]) assert.deepEqual(scan([line]), [], line);
});

test("secrets round two: a line with NULs is read as text with each NUL a boundary, with the NULs dropped, and as UTF-16 and UTF-32", () => {
  const t = TOKENS.github;
  /** @param {Buffer} raw */
  const one = (raw) => secretHits(new Map([["f", [{ line: 1, text: raw.toString("utf8"), raw }]]])).length;
  const b = (/** @type {(string | number[])[]} */ ...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
  // C strings in a compiled binary: the NUL ends one and starts the next.
  assert.equal(one(b("usage", [0], t, [0], "version", [0])), 1);
  assert.equal(one(b(" ", t, [0], "next")), 1);
  // UTF-16 and UTF-32 that were not decoded, a letter outside ASCII beside the token (its low byte a letter).
  assert.equal(one(Buffer.from(`\u0161${t}`, "utf16le").swap16()), 1, "UTF-16BE");
  assert.equal(one(Buffer.from(`${t}\u0161`, "utf16le")), 1, "UTF-16LE");
  const u32 = (/** @type {string} */ s, /** @type {boolean} */ le) => Buffer.concat([...s].map((c) => { const x = Buffer.alloc(4); le ? x.writeUInt32LE(/** @type {number} */ (c.codePointAt(0))) : x.writeUInt32BE(/** @type {number} */ (c.codePointAt(0))); return x; }));
  assert.equal(one(u32(`\u0161${t}\u0161`, true)), 1, "UTF-32LE");
  assert.equal(one(u32(`\u0161${t}\u0161`, false)), 1, "UTF-32BE");
  assert.equal(one(Buffer.concat([Buffer.from([0]), u32(`\u0161${t}`, false)])), 1, "UTF-32BE, one byte off");
});

test("secrets round two: every pattern runs in time linear in the line, on long lines built to make one backtrack", () => {
  // Growth, not a wall-clock bound: sixteen times the line costs about sixteen times the time if linear, 256 if
  // quadratic (these took 19 s and more at 512 KB; a quadratic cost past about 0.6 s at 512 KB fails). Measured in CPU time, the best of five runs each: wall time
  // counts the waits of a loaded machine, where eight times the line once measured 28.5 times (two full runs of
  // cycle 10, at load 8 to 40), and the file alone passed.
  const fill = (/** @type {string} */ unit, /** @type {number} */ size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const best = (/** @type {string[]} */ lines) => Math.min(...[0, 1, 2, 3, 4].map(() => {
    const t0 = process.cpuUsage();
    scan(lines);
    const { user, system } = process.cpuUsage(t0);
    return (user + system) / 1000;
  }));
  const growth = (/** @type {(size: number) => string[]} */ make) => (best(make(512 * 1024)) + 5) / (best(make(32 * 1024)) + 5);
  const hostile = [`-${P.ghs}1_eyJ`, `-${P.ghs}1_eyJa.b`, `-${P.pat}a`, ` ${P.glpat}aaaaaaaaaaaaaaaaaaaaa`, `.${P.xoxb}1-1-1`, `.${P.xoxb}${"1".repeat(50)}-`, ` ${P.sk}a`, `_${P.ant}${"a".repeat(80)}-`, ` ${P.pypi}a`, ` ${P.akia}A`, `secret_access_key=${" ".repeat(64)}`, "secret_access_key=", "\\", `${P.ghs}${"a.".repeat(20)}`];
  for (const unit of hostile) {
    const g = growth((size) => [fill(unit, size)]);
    assert.ok(g < 48, `${JSON.stringify(unit.slice(0, 20))}: sixteen times the line took ${g.toFixed(1)} times as long`);
  }
  // A key header, then a line of backslashes the body reader takes apart.
  const g = growth((size) => [pem("PRIVATE KEY").begin, "\\".repeat(size)]);
  assert.ok(g < 48, `header + backslashes: ${g.toFixed(1)} times`);
});

test("secrets round two: every repeat a line meets is bounded, so a run of megabytes does not crash the hook", () => {
  for (const re of LINE_PATTERNS) assert.doesNotMatch(re.source, /\{\d+,\}|(?<!\\)[\]).][*+]|\\[dDsSwW][*+]/, re.source);
  // Past 8 MB of one run, an open repeat ran V8 out of stack; the hook would crash, which refuses the commit.
  const huge = 9 * 1024 * 1024;
  const lines = [pem("PRIVATE KEY").begin, `${P.sk}${"A".repeat(huge)}`];
  assert.doesNotThrow(() => scan(lines));
  assert.doesNotThrow(() => keyCandidates(new Map([["f", lines.map((text, i) => ({ line: i + 1, text }))]])));
});

test("secrets round two: key material spelled as code writes it, after its armor headers, in base64 or percent escapes", () => {
  const { begin, end } = pem("RSA PRIVATE KEY");
  const b = body(4, 100);
  for (const [name, lines] of /** @type {[string, string[]][]} */ ([
    ["Rust continuation", [`const KEY: &str = "${begin}\\n\\`, ...b.map((l) => `${l}\\n\\`), `${end}";`]],
    ["Python continuation", [`KEY = "${begin}\\n" \\`, ...b.map((l) => `      "${l}\\n" \\`), `      "${end}\\n"`]],
    ["# comments", [`# ${begin}`, ...b.map((l) => `# ${l}`), `# ${end}`]],
    ["C comment", ["/*", ` * ${begin}`, ...b.map((l) => ` * ${l}`), ` * ${end}`, " */"]],
    ["markdown quote", [`> ${begin}`, ...b.map((l) => `> ${l}`)]],
    ["YAML list", ["key:", `  - ${begin}`, ...b.map((l) => `  - ${l}`)]],
    ["CRLF", [`${begin}\r`, ...b.map((l) => `${l}\r`), `${end}\r`]],
    ["percent escapes", [`key=${encodeURIComponent([begin, ...b, end].join("\n"))}`]],
    ["base64 (a kubeconfig's client-key-data)", [`    client-key-data: ${Buffer.from([begin, ...b, end, ""].join("\n")).toString("base64")}`]],
    ["ssh.com, exported by PuTTYgen", ["---- " + "BEGIN SSH2 ENCRYPTED PRIVATE KEY ----", 'Comment: "rsa-key-20200101"', ...b, "---- END SSH2 ENCRYPTED PRIVATE KEY ----"]],
    ["PuTTY", ["PuTTY-User-Key-File-3: ssh-ed25519", "Encryption: none", "Comment: k", "Public-Lines: 2", ...b.slice(0, 2), "Private-Lines: 1", b[2]]],
  ])) {
    assert.deepEqual(scan(lines).map((h) => h.kind), ["private-key"], name);
  }
  // OpenPGP: a Comment line per user ID (sq), so armor headers past any small count.
  const g = pem("PGP PRIVATE KEY BLOCK");
  assert.equal(scan([g.begin, "Comment: AAAA BBBB CCCC DDDD", "Comment: Alice <a@example.org>", "Comment: Alice <alice@work.example>", "Comment: Alice <a3@example.org>", "", ...b, g.end]).length, 1);
});

test("secrets round two: issuers' other documented prefixes (Anthropic admin keys, Slack rotated and refresh tokens, GitHub's JWT installation tokens)", () => {
  for (const name of /** @type {(keyof typeof TOKENS)[]} */ (["anthropicAdmin", "slackRotated", "slackRefresh", "githubJwt"])) assert.deepEqual(scan([`t = ${TOKENS[name]}`]).map((h) => h.kind), [KIND[name]], name);
  // Their placeholders, and a name that only looks like the prefix.
  for (const line of [`${P.xoxe}-1-Your-Refresh-Token`, `${P.ghs}some_long_identifier_name_here_v2.json`, `${P.ghs}${rand(40, B64URL, 3)}.${rand(20, B64URL, 4)}`, `${P.antAdmin}...`]) assert.deepEqual(scan([line]), [], line);
});

test("secrets round two: an AWS secret key under every name the tools spell it, and a framework's secret key; not a name with no value", () => {
  const s = TOKENS.awsSecret;
  for (const line of [`aws-secret-access-key: ${s}`, `--aws-secret-access-key ${s}`, `aws configure set aws_secret_access_key ${s}`, `AWS_SECRET_KEY=${s}`, `aws_secret_access_key=${encodeURIComponent(s)}`]) {
    assert.deepEqual(scan([line]).map((h) => h.kind), ["aws-secret-access-key"], line);
  }
  assert.deepEqual(scan([`secret_key = "${s}"`]).map((h) => h.kind), ["secret-key"]);
  for (const line of ['secret_key = os.environ["SECRET_KEY"]', `secret_key_sha1 = ${rand(40, HEX, 9)}`, `aws_secret_access_key = ${rand(41, B62, 9)}`]) assert.deepEqual(scan([line]), [], line);
});

test("secrets round two: a private key whose header the commit keeps is found in the staged file, around the lines it adds", () => {
  const { begin, end } = pem("RSA PRIVATE KEY");
  const blob = Buffer.from([begin, ...body(4, 71), end, ""].join("\n"));
  const added = new Map([["k.pem", [2, 3, 4, 5].map((line) => ({ line, text: body(4, 71)[line - 2] }))]]);
  assert.deepEqual(keyCandidates(added), ["k.pem"]);
  assert.deepEqual(secretHits(added), [], "the lines alone hold no header");
  assert.deepEqual(secretHits(added, { files: new Map([["k.pem", blob]]) }).map((h) => [h.kind, h.line]), [["private-key", 2]]);
  // A certificate's body is no key; a key elsewhere in the file that the commit does not touch is not this commit's.
  const cert = pem("CERTIFICATE");
  const two = Buffer.from([cert.begin, ...body(2, 5), cert.end, begin, ...body(2, 9), end, ""].join("\n"));
  assert.deepEqual(secretHits(new Map([["c.pem", [{ line: 2, text: body(2, 5)[0] }]]]), { files: new Map([["c.pem", two]]) }), []);
  // A header added with no material on its lines is a candidate too.
  assert.deepEqual(keyCandidates(new Map([["h.pem", [{ line: 1, text: begin }]]])), ["h.pem"]);
});

test("secrets round two: the commit message git will store is scanned, and a name the commit adds; output masks a secret a name holds", () => {
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-msg-")), env: {} });
  const res = checkCommitShape(`feat: publish\n\nRan npm publish with NPM_TOKEN=${TOKENS.npm} set.\n`, { config, cleanup: "whitespace" });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /the commit message, line 3 \(npm-token np.{2}…, 40 characters\)/);
  assert.ok(!res.errors[0].includes(TOKENS.npm.slice(4)));
  // A comment line is read too: --cleanup=verbatim on the command line, which the hook cannot see, stores it.
  // What a scissors line cuts is not stored, and the status template's file lines are git's list of names.
  assert.equal(checkCommitShape(`feat: publish\n# ${TOKENS.npm}\n`, { config, cleanup: "strip" }).ok, false);
  assert.equal(checkCommitShape(`feat: publish\n#\n# Changes to be committed:\n#\tdeleted:    tokens/${TOKENS.npm}.json\n#\n`, { config, cleanup: "strip" }).ok, true);
  assert.equal(checkCommitShape(`feat: publish\n# ------------------------ >8 ------------------------\n${TOKENS.npm}\n`, { config, cleanup: "strip", cut: true }).ok, true);
  // A name: refused, the token cut in what is printed; a path with a control character is escaped.
  const name = `tokens/${TOKENS.github}.json`;
  const named = checkCommitShape("feat: cache\n", { config, secretLines: new Map([[name, []]]) });
  assert.match(named.errors[0], /the name tokens\/gh.{2}….json \(github-token/);
  assert.ok(!named.errors[0].includes(TOKENS.github.slice(4)));
  assert.equal(masked(`a/${TOKENS.npm}/b`), `a/${TOKENS.npm.slice(0, 4)}…/b`);
  const esc = checkCommitShape("feat: x\n", { config, secretLines: new Map([["lib/x\x1b[2Kok.txt", [{ line: 1, text: TOKENS.npm }]]]) });
  assert.ok(!esc.errors[0].includes("\x1b"), esc.errors[0]);
  assert.match(esc.errors[0], /"lib\/x\\u001b\[2Kok\.txt":1/);
  // Off only when except names every path, the message too.
  assert.equal(checkCommitShape(`feat: x\n\n${TOKENS.npm}\n`, { config: loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-off-")), env: {}, override: { security: { secrets: { except: ["**"] } } } }), cleanup: "whitespace" }).ok, true);
});

test("secrets: with how git cleans the message unknown, the message is scanned whole: no template line left out, no cut at a scissors line", () => {
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-raw-")), env: {} });
  const template = `feat: publish\n#\n# Changes to be committed:\n#\tdeleted:    tokens/${TOKENS.npm}.json\n#\n`;
  const scissors = `feat: publish\n# ------------------------ >8 ------------------------\n${TOKENS.npm}\n`;
  assert.deepEqual([secretErrors({ config, message: template }), secretErrors({ config, message: scissors, cut: true })], [[], []]);
  // No marker is taken for one: not even a scissors line written with "null" for it.
  const spelled = `feat: publish\nnull ------------------------ >8 ------------------------\n${TOKENS.npm}\n`;
  for (const message of [template, scissors, spelled]) assert.match(secretErrors({ config, message, comment: null, cut: true })[0] ?? "", /the commit message, line \d \(npm-token/);
});

test("secrets round two: a review.forbidden error escapes a path's control characters too", () => {
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-fb-")), env: {}, override: { review: { forbidden: [{ text: "debugger", paths: ["**"] }] } } });
  const res = checkCommitShape("feat: x\n", { config, addedLines: new Map([["lib/x\x1b[2Kok.js", [{ line: 1, text: "debugger" }]]]) });
  assert.equal(res.ok, false);
  assert.ok(!res.errors[0].includes("\x1b"), res.errors[0]);
});

/** A repository with Ennyn's hook and the given config. @param {Record<string, unknown>} [config] */
function repo(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "en-sec-repo-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
  git(["add", "-A"], { cwd: dir });
  git([...ID, "commit", "-q", "--no-verify", "-m", "first"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  const put = (/** @type {Record<string, string>} */ files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(["add", "-A"], { cwd: dir });
  };
  const commit = (/** @type {string[]} */ ...args) => spawnSync("git", [...ID, "commit", "-q", ...args], { cwd: dir, encoding: "utf8" });
  return { dir, put, commit };
}

test("secrets: the commit-msg hook refuses a commit that adds a secret, in any file, the config too; except lets a fixture through", () => {
  // A forbidden rule that reads the fixtures too: the files both checks read come in one map, and except holds in it.
  const { put, commit } = repo({ security: { secrets: { except: ["test/fixtures/**"] } }, review: { forbidden: [{ text: "debugger", paths: ["test/**"] }] } });
  put({ "deploy/env.sh": `export NPM_TOKEN=${TOKENS.npm}\n` });
  for (const args of [["-m", "feat: deploy script"], ["--allow-empty-message", "-m", ""], ["-m", "feat: x\n\n[commit-shape-allow: the fixture needs it]"]]) {
    const r = commit(...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /deploy\/env\.sh:1 \(npm-token/);
    assert.ok(!r.stderr.includes(TOKENS.npm.slice(4)), "the hook prints no secret");
  }
  put({ "deploy/env.sh": "export NPM_TOKEN=$NPM_TOKEN\n" });
  assert.equal(commit("-m", "feat: deploy script").status, 0);
  put({ "test/fixtures/npmrc": `//registry.npmjs.org/:_authToken=${TOKENS.npm}\n` });
  assert.equal(commit("-m", "test: a fixture").status, 0);
  // A secret in the config is still a secret: the config is exempt from its own review.forbidden rules only.
  put({ ".ennyn/config.json": JSON.stringify({ security: { secrets: { except: ["test/fixtures/**"] } }, review: { forbidden: [{ text: "debugger", paths: ["test/**"], note: TOKENS.github }] } }) });
  const r = commit("-m", "chore: config");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\.ennyn\/config\.json:1 \(github-token/);
});

test("secrets: a staged name that is not UTF-8 is read, by the hook and by hand: the diff that reads every staged path needs no name to ask git for", () => {
  const { dir, commit } = repo();
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: `t = ${TOKENS.npm}\n`, encoding: "utf8" }).stdout.trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${hash}\t`), Buffer.from([...Buffer.from("lib/"), 0xff, ...Buffer.from(".js")]), Buffer.from("\0")]);
  assert.equal(spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: entry }).status, 0);
  writeFileSync(join(dir, "msg"), "feat: a file\n");
  const byHand = spawnSync(process.execPath, [CLI, "commit-check", "msg"], { cwd: dir, encoding: "utf8" });
  assert.equal(byHand.status, 1, byHand.stderr);
  assert.match(byHand.stderr, /lib\/\ufffd\.js:1 \(npm-token/);
  const r = commit("-m", "feat: a file");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /lib\/\ufffd\.js:1 \(npm-token/);
  // A file the commit adds is read by its object, whatever its name, and so is one it changes, beside a file past
  // the budget or files past one diff call (cycle 13: a name that is not UTF-8 was said and let through there). A
  // secret its HEAD version already holds is no new one.
  assert.equal(commit("--no-verify", "-m", "feat: a file").status, 0);
  // Two files of 600 KB: past one diff call together.
  const lines = (/** @type {string} */ tag) => Array.from({ length: 80_000 }, (_, i) => `${tag}${i}`).join("\n") + "\n";
  writeFileSync(join(dir, "big1.txt"), lines("a"));
  writeFileSync(join(dir, "big2.txt"), lines("b"));
  git(["add", "big1.txt", "big2.txt"], { cwd: dir });
  assert.equal(commit("--no-verify", "-m", "feat: two files").status, 0);
  const changed = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: `t = ${TOKENS.npm}\nu = ${TOKENS.github}\n`, encoding: "utf8" }).stdout.trim();
  assert.equal(spawnSync("git", ["update-index", "-z", "--index-info"], { cwd: dir, input: Buffer.concat([Buffer.from(`100644 ${changed}\t`), Buffer.from([...Buffer.from("lib/"), 0xff, ...Buffer.from(".js")]), Buffer.from("\0")]) }).status, 0);
  writeFileSync(join(dir, "big1.txt"), `${lines("a")}one more\n`);
  writeFileSync(join(dir, "big2.txt"), `${lines("b")}one more\n`);
  git(["add", "big1.txt", "big2.txt"], { cwd: dir });
  const past = commit("-m", "feat: a file");
  assert.equal(past.status, 1, past.stderr);
  assert.match(past.stderr, /lib\/\ufffd\.js:2 \(github-token/);
  assert.doesNotMatch(past.stderr, /npm-token|not UTF-8/);
  writeFileSync(join(dir, "big.bin"), "y".repeat(65 * 1024 * 1024));
  git(["add", "big.bin"], { cwd: dir });
  const asked = commit("-m", "feat: a file");
  assert.equal(asked.status, 1, asked.stderr);
  assert.match(asked.stderr, /lib\/\ufffd\.js:2 \(github-token/);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets: a submodule's new commit is no object this repository should hold: the bump is not said unread, and the files beside it are read", () => {
  // A rule over every path: review.forbidden asks about the bump too.
  const { dir, commit } = repo({ review: { forbidden: [{ text: "BANNED", paths: ["**"] }] } });
  const gitlink = (/** @type {string} */ sha) => assert.equal(spawnSync("git", ["update-index", "--add", "--cacheinfo", `160000,${sha},sub`], { cwd: dir }).status, 0);
  gitlink("1".repeat(40));
  assert.equal(commit("--no-verify", "-m", "feat: sub").status, 0);
  gitlink("2".repeat(40));
  // Staged alone: `add -A` would stage the gitlink's removal, with no folder in its place.
  writeFileSync(join(dir, "a.txt"), `t = ${TOKENS.npm}\n`);
  git(["add", "a.txt"], { cwd: dir });
  const r = commit("-m", "feat: bump");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /a\.txt:1 \(npm-token/);
  assert.doesNotMatch(r.stderr, /not checked|not on this machine/);
  // With its diff failing, the bump is still no file to read whole.
  const bin = mkdtempSync(join(tmpdir(), "en-sec-sub-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" -U0 "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(dir, "msg"), "feat: bump\n");
  const failing = spawnSync(process.execPath, [CLI, "commit-check", "--hook", "msg"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.match(failing.stderr, /a\.txt:1 \(npm-token/);
  assert.doesNotMatch(failing.stderr, /security\.secrets was not checked/);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets: a staged file entry that names no blob is the commit's own content: refused by name, the files beside it still read; a git that fails is said; HEAD's version unread cancels no hit", () => {
  const { dir, commit } = repo();
  const head = () => git(["rev-parse", "HEAD"], { cwd: dir });
  const first = head();
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: dir });
  const index = (/** @type {string} */ mode, /** @type {string} */ oid, /** @type {Buffer} */ name) =>
    assert.equal(spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: Buffer.concat([Buffer.from(`${mode} ${oid}\t`), name, Buffer.from("\0")]) }).status, 0);
  // The audit's fixture: a new entry `a` that names a tree, sorted before a new file with a token. git commits it.
  index("100644", tree, Buffer.from("a"));
  writeFileSync(join(dir, "z.txt"), `t = ${TOKENS.github}\n`);
  git(["add", "z.txt"], { cwd: dir });
  const added = commit("-m", "feat: x");
  assert.equal(added.status, 1, added.stderr);
  assert.match(added.stderr, /security\.secrets was not checked, so this commit is refused: "a" could not be read \(an object of type tree is staged there, not a file\)/);
  assert.match(added.stderr, /z\.txt:1 \(github-token/);
  assert.doesNotMatch(added.stderr, /not checked in \d+ staged path/);
  assert.equal(head(), first, "nothing was committed");
  // Changed to a commit object under a name git cannot be asked for: read by its objects, where git's own failure
  // would read as the machine's.
  git(["rm", "-q", "--cached", "a", "z.txt"], { cwd: dir });
  const odd = Buffer.from([...Buffer.from("lib/"), 0xff, ...Buffer.from(".js")]);
  const blob = (/** @type {string} */ text) => spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: text, encoding: "utf8" }).stdout.trim();
  const one = blob("one\n");
  index("100644", one, odd);
  assert.equal(commit("--no-verify", "-m", "feat: a file").status, 0);
  index("100644", first, odd);
  const changed = commit("-m", "feat: x");
  assert.equal(changed.status, 1, changed.stderr);
  assert.match(changed.stderr, /refused: "lib\/\ufffd\.js" could not be read \(an object of type commit is staged there, not a file\)/);
  // Control: a git whose cat-file --batch fails, with every object a blob, is the machine's: said, the commit goes on.
  index("100644", one, odd);
  writeFileSync(join(dir, "z.txt"), `t = ${TOKENS.github}\n`);
  git(["add", "z.txt"], { cwd: dir });
  const bin = mkdtempSync(join(tmpdir(), "en-sec-type-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const fake = (/** @type {string} */ when) => writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in ${when}) echo "fatal: injected" >&2; exit 128 ;; esac\nexec '${real}' "$@"\n`);
  fake('*" --batch "*');
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(dir, "msg"), "feat: x\n");
  const hook = () => spawnSync(process.execPath, [CLI, "commit-check", "--hook", "msg"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const machine = hook();
  assert.equal(machine.status, 0, machine.stderr);
  assert.match(machine.stderr, /security\.secrets was not checked in 1 staged path\(s\) \("z\.txt"\): git cat-file: fatal: injected/);
  assert.doesNotMatch(machine.stderr, /refused/);
  // HEAD's version of a file read by its objects fails: every hit of the new version counts (cycle 44's audit lead: the
  // whole file was said unread at exit 0).
  git(["rm", "-q", "--cached", "z.txt"], { cwd: dir });
  index("100644", blob(`one\nt = ${TOKENS.npm}\n`), odd);
  fake(`*" cat-file blob ${one} "*`);
  const unread = hook();
  assert.equal(unread.status, 1, unread.stderr);
  assert.match(unread.stderr, /lib\/\ufffd\.js:2 \(npm-token/);
  assert.match(unread.stderr, /HEAD's version of 1 staged path\(s\) \("lib\/\ufffd\.js"\) could not be read \(fatal: injected\)/);
  // The types' own call failing: said by the hook, the files still read; by hand the command fails.
  const plain = repo();
  plain.put({ "y.txt": "one\n" });
  assert.equal(plain.commit("--no-verify", "-m", "feat: y").status, 0);
  plain.put({ "y.txt": "two\n" });
  const asked = git(["rev-parse", ":y.txt"], { cwd: plain.dir });
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --batch-check "*) in=$(cat); if [ "$in" = "${asked}" ]; then echo "fatal: injected" >&2; exit 128; fi; printf '%s\\n' "$in" | exec '${real}' "$@" ;; esac\nexec '${real}' "$@"\n`);
  writeFileSync(join(plain.dir, "msg"), "feat: y\n");
  const types = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, "commit-check", ...args, "msg"], { cwd: plain.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const typesHook = types("--hook");
  assert.equal(typesHook.status, 0, typesHook.stderr);
  assert.match(typesHook.stderr, /security\.secrets was not checked for staged entries that name no file: the objects' types could not be read \(fatal: injected\); the files were still read\./);
  const typesHand = types();
  assert.equal(typesHand.status, 1, typesHand.stderr);
  assert.match(typesHand.stderr, /fatal: injected/);
  // With the types unread, an entry naming a tree sorted before a secret stops the stream: the content's failure,
  // refused, not taken for the machine's (cycle 44 review). The fake fails every batch-check but stagedChanges', which
  // asks for y.txt's HEAD object too.
  const yOld = git(["rev-parse", "HEAD:y.txt"], { cwd: plain.dir });
  plain.put({ "z.txt": `t = ${TOKENS.github}\n` });
  git(["update-index", "--add", "--cacheinfo", `100644,${git(["rev-parse", "HEAD^{tree}"], { cwd: plain.dir })},a`], { cwd: plain.dir });
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --batch-check "*) in=$(cat); case "$in" in *"${yOld}"*) ;; *) echo "fatal: injected" >&2; exit 128 ;; esac; printf '%s\\n' "$in" | exec '${real}' "$@" ;; esac\nexec '${real}' "$@"\n`);
  const blind = types("--hook");
  assert.equal(blind.status, 1, blind.stderr);
  assert.match(blind.stderr, /the objects' types could not be read \(fatal: injected\)/);
  assert.match(blind.stderr, /security\.secrets was not checked, so this commit is refused: "a", "msg", "z\.txt" could not be read \(git cat-file: cat-file wrote something other than the blob/);
  // With the types unread and nothing but blobs staged, a stream git killed (memory pressure) is the machine's: said.
  git(["rm", "-q", "--cached", "a"], { cwd: plain.dir });
  plain.put({ "z.txt": "plain\n" });
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --batch-check "*) in=$(cat); case "$in" in *"${yOld}"*) ;; *) echo "fatal: injected" >&2; exit 128 ;; esac; printf '%s\\n' "$in" | exec '${real}' "$@" ;; *" --batch "*) kill -9 $$ ;; esac\nexec '${real}' "$@"\n`);
  const killed = types("--hook");
  assert.equal(killed.status, 0, killed.stderr);
  assert.match(killed.stderr, /the objects' types could not be read \(fatal: injected\)/);
  assert.match(killed.stderr, /security\.secrets was not checked in 2 staged path\(s\) \("msg", "z\.txt"\): git cat-file: killed by SIGKILL/);
  assert.doesNotMatch(killed.stderr, /refused/);
  // With the types read, a header the stream rejects after all (an object gone between the two calls) is git's: said.
  const zNew = git(["rev-parse", ":z.txt"], { cwd: plain.dir });
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --batch "*) in=$(cat); case "$in" in *"${zNew}"*) for o in $in; do echo "$o missing"; done; exit 0 ;; esac; printf '%s\\n' "$in" | exec '${real}' "$@" ;; esac\nexec '${real}' "$@"\n`);
  const gone = types("--hook");
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stderr, /security\.secrets was not checked in 2 staged path\(s\) \("msg", "z\.txt"\): git cat-file: cat-file wrote something other than the blob: "[0-9a-f]+ missing"/);
  assert.doesNotMatch(gone.stderr, /refused|types could not be read/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(plain.dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test("secrets: doctor counts security.secrets among the rules only the hook checks, unless except names every path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "en-sec-doc-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), "{}");
  const missing = async () => (await checkSetup({ cwd: dir, env: {} })).items.find((i) => i.key === "doctor.hookMissing");
  assert.deepEqual((await missing())?.vars.rules, ["security.secrets"]);
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ security: { secrets: { except: ["**"] } } }));
  assert.equal(await missing(), undefined);
});

test("secrets round two: the hook reads except from the config the commit holds, says when the work tree's differs, and refuses a list the commit widens", () => {
  const { dir, put, commit } = repo();
  // Widened in the work tree, not staged: the commit's own list holds, and the hook says so.
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ security: { secrets: { except: ["**"] } } }));
  writeFileSync(join(dir, "deploy.sh"), `export NPM_TOKEN=${TOKENS.npm}\n`);
  git(["add", "deploy.sh"], { cwd: dir });
  let r = commit("-m", "feat: deploy script");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\.ennyn\/config\.json in the work tree is not what this commit holds/);
  assert.match(r.stderr, /deploy\.sh:1 \(npm-token/);
  // Widened in the commit itself: refused until the message names the key; the commit's own list then holds.
  git(["reset", "-q"], { cwd: dir });
  rmSync(join(dir, "deploy.sh"));
  put({ ".ennyn/config.json": JSON.stringify({ security: { secrets: { except: ["deploy/**"] } } }), "deploy/env.sh": `export NPM_TOKEN=${TOKENS.npm}\n` });
  r = commit("-m", "feat: deploy script");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /This commit loosens security\.secrets\.except,/);
  assert.doesNotMatch(r.stderr, /deploy\/env\.sh/);
  r = commit("-m", "feat: deploy script\n\nUser-Approved-Loosening: security.secrets.except\n");
  assert.equal(r.status, 0, r.stderr);
});

test("secrets round two: the hook finds a private key replaced under the header the commit keeps, and material added under a header committed before", () => {
  const { dir, put, commit } = repo();
  const { begin, end } = pem("RSA PRIVATE KEY");
  put({ "certs/dev.key": [begin, ...body(4, 61), end, ""].join("\n"), "k.pem": [begin, end, ""].join("\n") });
  assert.equal(commit("--no-verify", "-m", "chore: keys before the hook").status, 0);
  put({ "certs/dev.key": [begin, ...body(4, 71), end, ""].join("\n") });
  let r = commit("-m", "chore: new dev key");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /certs\/dev\.key:2 \(private-key\)/);
  git(["reset", "-q", "--hard"], { cwd: dir });
  put({ "k.pem": [begin, ...body(3, 5), end, ""].join("\n") });
  r = commit("-m", "chore: fill the key");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /k\.pem:2 \(private-key\)/);
});

test("secrets round two: the hook refuses a token in the message and in a file name, printing neither", () => {
  const { put, commit } = repo();
  put({ "a.txt": "a\n" });
  let r = commit("-m", `feat: publish step\n\nRan npm publish with NPM_TOKEN=${TOKENS.npm} set.`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the commit message, line 3 \(npm-token/);
  put({ [`tokens/${TOKENS.github}.json`]: "{}\n" });
  r = commit("-m", "feat: cache");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the name tokens\/gh.{2}….json/);
  assert.ok(!r.stderr.includes(TOKENS.github.slice(4)) && !r.stderr.includes(TOKENS.npm.slice(4)), "no secret printed");
});

test("secrets round two: what the hook reads is bounded by the lines files add: a deletion is not read, a file whose added lines are past the budget is said, the rest is read", () => {
  const { dir, put, commit } = repo();
  // 25 MB that become 25 other MB: its -U0 diff is 75 MB, but the lines it adds are 25 MB, and those are read.
  const lines = (/** @type {string} */ c) => `${c}\n`.repeat(12.5 * 1024 * 1024);
  put({ "big.txt": lines("a"), "gone.txt": "x".repeat(70 * 1024 * 1024) });
  assert.equal(commit("--no-verify", "-m", "chore: big files").status, 0);
  put({ "big.txt": lines("b"), "deploy.sh": `export NPM_TOKEN=${TOKENS.npm}\n` });
  git(["rm", "-q", "gone.txt"], { cwd: dir });
  const r = commit("-m", "feat: deploy");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /deploy\.sh:1 \(npm-token/);
  assert.doesNotMatch(r.stderr, /not checked/, "the big file was read, the deleted one adds nothing");
  // Past the budget: said, and the commit is not refused for it.
  git(["reset", "-q", "--hard"], { cwd: dir });
  put({ "huge.bin": "y".repeat(65 * 1024 * 1024) });
  const big = commit("-m", "chore: data");
  assert.equal(big.status, 0, big.stderr);
  assert.match(big.stderr, /security\.secrets was not checked in 1 staged path\(s\) \("huge\.bin"\): the lines they add are past the 64 MB the hook reads of a commit, the smallest files first/);
  // Some 300 MB of objects: not left in the temporary directory.
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round two (mutation): a body line's floor is 40 characters; one secret read in two views is one; a key found in the lines is no candidate", () => {
  const { begin } = pem("PRIVATE KEY");
  assert.equal(scan([begin, rand(40, B64, 70)]).length, 1, "40 characters of material");
  assert.deepEqual(scan([begin, rand(39, B64, 71)]), [], "39 are too few");
  // Base64 and nothing else: a line that is base64 but for one letter (a colon) is no material.
  assert.deepEqual(scan([begin, `data:${rand(60, B64, 76)}`]), [], "a colon");
  // A percent escape of a letter after a token of no fixed length: the decoded view's token is longer.
  assert.equal(scan([`${TOKENS.stripe}%41`]).length, 1);
  // A JWT installation token whose first part is 36 letters is also the opaque shape: one token, in the message too.
  const jwt = `${P.ghs}eyJ${rand(33, B62, 72)}.${rand(80, B64URL, 73)}.${rand(43, B64URL, 74)}`;
  assert.equal(scan([jwt]).length, 1);
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-jwt-")), env: {} });
  assert.doesNotMatch(checkCommitShape(`feat: x\n\n${jwt}\n`, { config, cleanup: "whitespace" }).errors[0], /, the commit message/);
  const { end } = pem("PRIVATE KEY");
  assert.deepEqual(keyCandidates(new Map([["k.pem", [begin, ...body(2, 75), end].map((text, i) => ({ line: i + 1, text }))]])), []);
});

test("secrets round two (mutation): the budget is spent as files are read, and whole-file reads have one too", async () => {
  const { stagedBlobs } = await import("../plugin/core/git.mjs");
  const { dir, put, commit } = repo();
  // Two files that each fit the budget, together not: the second is said.
  put({ "a.bin": "a".repeat(40 * 1024 * 1024), "b.bin": "b".repeat(40 * 1024 * 1024) });
  const r = commit("-m", "chore: data");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /security\.secrets was not checked in 1 staged path\(s\) \("b\.bin"\): the lines they add are past/);
  put({ "c.txt": "c".repeat(2048) });
  const read = stagedBlobs(dir, [".ennyn/config.json", "c.txt", "a.bin"], { total: 1024 });
  assert.deepEqual([[...read.blobs.keys()], [...read.unread].sort()], [[".ennyn/config.json"], [["a.bin", "past 16 MB"], ["c.txt", "past the 0.0009765625 MB read in all"]]]);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round two: when the message's shape check fails, the secrets the files and the message hold still refuse the commit", () => {
  const { dir, put } = repo();
  put({ "deploy.sh": `export NPM_TOKEN=${TOKENS.npm}\n` });
  // How git cleans the message cannot be read: the message is scanned whole.
  const bin = mkdtempSync(join(tmpdir(), "en-sec-git-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --get-regexp "*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  // git puts its own directory first on a hook's PATH: the check is run as the hook runs it, with the git above.
  writeFileSync(join(dir, ".git", "MSG"), `feat: deploy\n\n# ${TOKENS.github}\n`);
  const r = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /shape was not checked \(fatal: injected\)/);
  assert.match(r.stderr, /deploy\.sh:1 \(npm-token/);
  assert.match(r.stderr, /the commit message, line 3 \(github-token/);
});

test("secrets round three: review.forbidden reads as on main, under no budget: a 40 MB file under its paths with one line changed is refused", () => {
  const { dir, put, commit } = repo({ review: { forbidden: [{ text: "console.log", paths: ["src/**"] }] } });
  const rows = Array.from({ length: 400 * 1024 }, (_, i) => `const v${i} = ${i}; // ${"x".repeat(80)}`);
  put({ "src/data.js": `${rows.join("\n")}\n` });
  assert.equal(commit("--no-verify", "-m", "chore: data").status, 0);
  rows[50] = "console.log(1);";
  put({ "src/data.js": `${rows.join("\n")}\n` });
  const r = commit("-m", "feat: log");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /src\/data\.js:51 adds "console\.log"/);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round three: the budget is spent on the smallest files first, and each file unread is named with its own reason", () => {
  const { dir, put, commit } = repo();
  put({ "a.bin": "a".repeat(32 * 1024 * 1024 - 8), "b.bin": "b".repeat(32 * 1024 * 1024 - 8), "z/deploy.sh": `export NPM_TOKEN=${TOKENS.npm}\n`, "c.bin": "c".repeat(1024) });
  const r = commit("-m", "feat: deploy");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /z\/deploy\.sh:1 \(npm-token/);
  assert.match(r.stderr, /not checked in 1 staged path\(s\) \("b\.bin"\)/, "the largest goes when the budget runs out");
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round three: every name the commit adds is scanned, unread files' too; a name already in history is not; a name is printed with its secret cut", () => {
  const { dir, put, commit } = repo();
  // Past the budget, so its lines are not read: its name still is.
  put({ [`data/${TOKENS.npm}.bin`]: "y".repeat(65 * 1024 * 1024) });
  let r = commit("-m", "feat: data");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the name data\/np.{2}….bin \(npm-token/);
  assert.ok(!r.stderr.includes(TOKENS.npm.slice(4)), r.stderr.slice(0, 300));
  git(["reset", "-q"], { cwd: dir });
  rmSync(join(dir, "data"), { recursive: true });
  // A name with a byte that is not UTF-8 beside the token.
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: "{}\n", encoding: "utf8" }).stdout.trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${hash}\t`), Buffer.from(`f/${TOKENS.github}`), Buffer.from([0xff]), Buffer.from(".json\0")]);
  assert.equal(spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: entry }).status, 0);
  r = commit("-m", "feat: cache");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the name "?f\/gh.{2}…/);
  assert.ok(!r.stderr.includes(TOKENS.github.slice(4)), r.stderr.slice(0, 300));
  // A name history holds already: its content edited, a mode changed; the commit adds no name.
  git(["reset", "-q"], { cwd: dir });
  put({ [`fixtures/${TOKENS.awsId}.json`]: "{}\n" });
  assert.equal(commit("--no-verify", "-m", "test: fixture").status, 0);
  put({ [`fixtures/${TOKENS.awsId}.json`]: '{"a":1}\n' });
  assert.equal(commit("-m", "test: fixture data").status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round three: a committed except that does not compile, or a deleted config, does not turn the scan off or break every commit", () => {
  const { dir, put, commit } = repo({ security: { secrets: { except: ["test/**"] } } });
  // The work tree's list is valid; the one staged does not compile.
  put({ ".ennyn/config.json": JSON.stringify({ security: { secrets: { except: ["[z-a]"] } } }), "deploy.sh": `export NPM_TOKEN=${TOKENS.npm}\n` });
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ security: { secrets: { except: ["test/**"] } } }));
  let r = commit("-m", "feat: deploy");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /as this commit holds it does not load/);
  assert.match(r.stderr, /This commit loosens \.ennyn\/config\.json,/);
  assert.match(r.stderr, /deploy\.sh:1 \(npm-token/);
  git(["reset", "-q"], { cwd: dir });
  rmSync(join(dir, "deploy.sh"));
  // The config deleted from the index: the defaults, not the work tree's list.
  put({ "test/t.env": `T=${TOKENS.npm}\n` });
  git(["rm", "-q", "--cached", ".ennyn/config.json"], { cwd: dir });
  r = commit("-m", "test: env");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /test\/t\.env:1/);
  rmSync(dir, { recursive: true, force: true });
});

test("secrets round three: a key in UTF-16 with a byte order mark and CRLF, regenerated in place where no forbidden rule reads, is refused", () => {
  const { dir, put, commit } = repo();
  const { begin, end } = pem("RSA PRIVATE KEY");
  const utf16 = (/** @type {string[]} */ rows) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.join("\r\n") + "\r\n", "utf16le")]);
  writeFileSync(join(dir, "k.pem"), utf16([begin, ...body(4, 61), end]));
  git(["add", "k.pem"], { cwd: dir });
  assert.equal(commit("--no-verify", "-m", "chore: key").status, 0);
  writeFileSync(join(dir, "k.pem"), utf16([begin, ...body(4, 71), end]));
  git(["add", "k.pem"], { cwd: dir });
  const r = commit("-m", "chore: new key");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /k\.pem:2 \(private-key\)/);
  void put;
});

test("secrets round three: a base64-wrapped key split into lines, octal and twice-percent escapes before a token, and an except of globs that reach far", () => {
  const { begin, end } = pem("RSA PRIVATE KEY");
  const wrapped = Buffer.from([begin, ...body(4, 81), end, ""].join("\n")).toString("base64");
  for (const width of [76, 64]) {
    const rows = wrapped.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
    assert.deepEqual(scan(["client-key-data: |", ...rows.map((r) => `  ${r}`)]).map((h) => h.kind), ["private-key"], `${width} columns`);
  }
  assert.equal(scan([`s = "k\\075${TOKENS.github}"`]).length, 1, "octal");
  assert.equal(scan([`next=cb%253Ftoken%253D${TOKENS.github}`]).length, 1, "percent, twice");
  const config = loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-sec-off-")), env: {}, override: { security: { secrets: { except: ["a*", "a/**", ".a/**", "a b/**"] } } } });
  assert.equal(checkCommitShape(`feat: x\n\n${TOKENS.npm}\n`, { config, cleanup: "whitespace" }).ok, false, "globs that reach far leave the scan on");
});

test("secrets round three: the scan keeps a bounded window, whatever the lines: megabytes of empty lines, or of short ones", () => {
  const scanner = new SecretScanner();
  scanner.file("f");
  const empty = Buffer.alloc(0);
  for (let i = 1; i <= 2_000_000; i++) scanner.line(i, empty);
  for (let i = 1; i <= 300; i++) scanner.line(2_000_000 + i, Buffer.alloc(1024 * 1024, 0x61));
  assert.ok(scanner.kept <= 256 && scanner.windowBytes <= 5 * 1024 * 1024, `${scanner.kept} lines, ${scanner.windowBytes} bytes kept`);
  scanner.close();
  assert.deepEqual([scanner.hits.length, scanner.near.size, scanner.kept], [0, 0, 0], "nothing is kept of lines that hold nothing");
});

test("secrets round three (mutation): a widened except exempts no name; a changed file whose name is not UTF-8 is read; a last line with no newline is read; a merge names the side that brings a secret", () => {
  const { dir, put, commit } = repo();
  // except widened in this commit names the file: its content goes unscanned, said; its name is still scanned.
  put({ ".ennyn/config.json": JSON.stringify({ security: { secrets: { except: ["fx/**"] } } }), [`fx/${TOKENS.github}.json`]: "{}\n" });
  let r = commit("-m", "test: fixture");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the name fx\/gh.{2}….json/);
  git(["reset", "-q", "--hard"], { cwd: dir });
  // A file the commit adds whose last line has no newline.
  put({ "deploy.env": `NPM_TOKEN=${TOKENS.npm}` });
  r = commit("-m", "feat: env");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /deploy\.env:1 \(npm-token/);
  git(["reset", "-q", "--hard"], { cwd: dir });
  rmSync(join(dir, "deploy.env"), { force: true });
  // A file the commit changes, whose name is not UTF-8, with nothing past the budget: the diff with no pathspec reads it.
  const blob = (/** @type {string} */ text) => spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: text, encoding: "utf8" }).stdout.trim();
  const stage = (/** @type {string} */ oid) => spawnSync("git", ["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from([...Buffer.from("lib/"), 0xff, ...Buffer.from(".js")]), Buffer.from("\0")]) });
  assert.equal(stage(blob("a\n")).status, 0);
  assert.equal(commit("--no-verify", "-m", "feat: lib").status, 0);
  assert.equal(stage(blob(`a\nt = ${TOKENS.npm}\n`)).status, 0);
  r = commit("-m", "feat: lib");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /lib\/\ufffd\.js:2 \(npm-token/);
  // The index only: macOS cannot write that name into the work tree.
  git(["reset", "-q"], { cwd: dir });
  // A merge: the side's commit ran no hook; the refusal says which side brings it.
  git(["checkout", "-q", "-b", "side"], { cwd: dir });
  put({ "side.env": `T=${TOKENS.npm}\n` });
  assert.equal(commit("--no-verify", "-m", "side").status, 0);
  git(["checkout", "-q", "main"], { cwd: dir });
  put({ "main.txt": "m\n" });
  assert.equal(commit("-m", "chore: main").status, 0);
  spawnSync("git", [...ID, "merge", "-q", "--no-commit", "--no-ff", "side"], { cwd: dir });
  r = commit("--no-edit");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /side\.env:1 \(npm-token.*The merge brings 1 of these lines from [0-9a-f]{10}/s);
  rmSync(dir, { recursive: true, force: true });
});
