import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../core/git.mjs";
import { loadConfig } from "../core/config.mjs";
import { LOOSENING_LINE, gateKeyKind, loosenedKeys } from "../checks/loosening.mjs";
import { installHook } from "../setup/hook.mjs";
import { addressHits, closedSource, conversationHits, digest, foldCase, homeHits, lineHits, literalEntry, literalHits, newLines, parseLiterals, privateErrors, sourceHits, textRules } from "../checks/private-text.mjs";

// Every fixture that a rule refuses is built from parts at run time, as test/hygiene.test.mjs builds its own: this
// file holds no word, path, address or shape the gate refuses, so a commit that changes it passes the gate.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const NAME = "Vex" + "moorle";
const HOME = "/" + "Users/" + "someone";
const HOME_WIN = "C:" + "\\" + "Users" + "\\" + "dev";
const MAILBOX = "carol" + "@" + "mailhost" + ".co" + "m";
const U = "the " + "user";
const DAY = "2026-01-" + "02";
const list = parseLiterals(literalEntry(NAME, true) ?? "");
const ALL = { literals: list, home: true, addresses: ["me@x.test"], conversation: true };
/** The rules a line breaks, as names. @param {string} line */
const rulesOf = (line) => lineHits(line, ALL).map((h) => (h.rule === "conversation" ? `conversation.${h.shape}` : h.rule));
const eff = (/** @type {Record<string, unknown>} */ over = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-pt-cfg-")), env: {}, override: over });

test("private text: a listed word is found whole, in its parts and runs, in the case it is listed for; a longer word is not", () => {
  for (const s of [`see ${NAME}.`, `${NAME}.md`, `${NAME}-server`, `the-${NAME}`, `docs.${NAME}.md`, `x_${NAME.toLowerCase()}ın`, `${NAME.toUpperCase()}_HOME`, `the ${NAME}'in notes`, `${NAME}ın raporu`, `https://x.io/${NAME.toLowerCase()}/a`]) {
    assert.equal(literalHits(s, list).length, 1, s);
  }
  assert.deepEqual(literalHits(`${NAME}es and moorle`, list), [], "a longer word, and a part of the word, are not it");
  const exact = parseLiterals(literalEntry(NAME, false) ?? "");
  assert.equal(literalHits(NAME, exact).length, 1);
  assert.deepEqual(literalHits(NAME.toLowerCase(), exact), [], "an exact word in another case");
  // A digest with no length (the form of those taken over from the hygiene test): every word is hashed.
  const bare = parseLiterals(`folded ${digest(NAME.toLowerCase())}\n`);
  assert.equal(bare.lengths, undefined);
  assert.equal(literalHits(`x ${NAME} y`, bare).length, 1);
  // The length filter keeps the hash to words of a listed length, and still finds the word.
  assert.deepEqual([...(list.lengths ?? [])], [NAME.length]);
});

test("private text: a folded word matches across the Turkish i's, both ways; an ASCII word in any case; a word without its diacritics does not", () => {
  // Made-up words: one holding the dotless ı and capital I, one opening with the dotted İ.
  const dotless = "I" + "şıvetrup";
  const dotted = "\u0130" + "mprazelk";
  for (const [listed, written] of [[dotless, "ışıvetrup"], [dotless, "IŞIVETRUP"], ["ışıvetrup", dotless], [dotted, "imprazelk"], [dotted, "\u0130MPRAZELK"], ["imprazelk", dotted], [dotted, `${"imprazelk"}-notes.md`], [NAME, NAME.toUpperCase()]]) {
    assert.equal(literalHits(`about ${written} here`, parseLiterals(literalEntry(listed, true) ?? "")).length, 1, `${listed} / ${written}`);
  }
  // NFC first: a decomposed ş is the same letter.
  assert.equal(literalHits("about ı" + "s\u0327" + "ıvetrup", parseLiterals(literalEntry(dotless, true) ?? "")).length, 1);
  assert.equal(foldCase("ABC"), "abc");
  // What toLowerCase makes of the dotted İ: an i and a combining dot above.
  assert.equal(literalHits("about i\u0307mprazelk", parseLiterals(literalEntry(dotted, true) ?? "")).length, 1);
  assert.equal(literalHits("about IMPRAZELK", parseLiterals(literalEntry("i\u0307mprazelk", true) ?? "")).length, 1);
  // An exact entry is composed too: the same word written decomposed is it.
  assert.equal(literalHits("about ı" + "s\u0327" + "ıvetrup", parseLiterals(literalEntry("ışıvetrup", false) ?? "")).length, 1);
  assert.deepEqual(literalHits("about isivetrup here", parseLiterals(literalEntry(dotless, true) ?? "")), [], "a limit: diacritics dropped make another word");
  assert.deepEqual(literalHits(`about ${dotted.toLowerCase()} here`.replace("i\u0307", "x"), parseLiterals(literalEntry(dotted, false) ?? "")), [], "an exact entry stays exact");
});

test("private text: the list's file reads only whole entries; a word to add is one word", () => {
  assert.throws(() => parseLiterals(`# mine\n\n${literalEntry(NAME, true)}\nfolded 7 nothex\n`), /line 4 is not/);
  assert.throws(() => parseLiterals(`plain ${digest("x")}\n`), /line 1 is not/);
  assert.equal(parseLiterals(`# only a note\n\n`).exact.size, 0);
  for (const w of ["two words", "-lead", "trail.", "", "a/b"]) assert.equal(literalEntry(w, true), null, w);
  assert.match(String(literalEntry(" Word-x.y ", false)), /^exact 8 [0-9a-f]{64}$/);
  assert.equal(literalEntry("ABC", true), `folded 3 ${digest("abc")}`);
});

test("private text: a home path in its usual forms; other absolute paths and a tilde are not one", () => {
  for (const s of [HOME, `file://${HOME}/x`, `cd /` + `home/dev/app`, HOME_WIN, "C:" + "\\\\" + "Users" + "\\\\" + "dev"]) assert.equal(homeHits(s).length, 1, s);
  assert.deepEqual(homeHits("tmpdir() and /opt/tool and ~/notes and /usr/local and /Users alone"), []);
});

test("private text: an address outside the list is refused; reserved names, the list, a URL's user and scp's form are not", () => {
  const allowed = ["me@x.test", "61+login@" + "users.noreply.github.com"];
  for (const s of [`write to ${MAILBOX}.`, `<${MAILBOX}>`, `"${MAILBOX}"`, `a\\n${MAILBOX}`, `mailto:${MAILBOX}`, `Co-Authored-By: Someone <${MAILBOX}>`, "carol@" + "mail2x.com", "carol@" + "pngs.org", "dev@" + "openssh.org", "jane@2x" + ".com", "jane@10x" + ".dev", "jane@1.5x" + ".io"]) assert.equal(addressHits(s, allowed).length, 1, s);
  const accepted = [
    "a@x.test", "b@host.example", "c@nowhere.invalid", "d@box.localhost", "e@example" + ".com", "f@mail.example.org", "g@example" + ".net",
    "ME@X.Test", "61+Login@" + "users.noreply.github.com",
    "https://tok@github" + ".com/o/r", "git+ssh://git@github" + ".com/o/r.git", "https://user:pw@registry.npmjs" + ".org/x",
    // A URL's user with nothing after the host: only the scheme says it is no mailbox.
    "https://tok@" + "github.com", "see git+ssh://git@" + "github.com.", "https://user:pw@" + "registry.npmjs.org?x=1",
    "git@github" + ".com:o/r.git", "user:pw@github" + ".com/o/r",
    "\\n@x.md", "\\t@m.md", "t@t", "name@1.2.3",
    // An image's density, a file's extension, OpenSSH's algorithm names, npm's versions: no mailbox.
    '<img src="img/logo@2x.png">', "img/logo@2x.png", ".x{background:url(icon@3x.webp)}", "icon@1.5x.png", "mail@l.md", "see notes@v2.js", "banner@2x.heic", "shot@3x.heif",
    "Ciphers chacha20-poly1305@openssh" + ".com,aes256-gcm@openssh" + ".com", "A key of type `sk-ssh-ed25519@openssh" + ".com` works too.",
    "npm i lodash@4.17.21 react@18.3.1 @types/node@22.0.0",
  ];
  for (const s of accepted) assert.deepEqual(addressHits(s, allowed), [], s);
  // commits.addresses unset: the rule does not run (every address would be outside it); set, it runs.
  assert.equal(textRules(eff(), null).addresses, null);
  assert.deepEqual([textRules(eff(), null).home, textRules(eff(), null).conversation], [false, false], "home and conversation are opt-in");
  assert.deepEqual(textRules(eff({ commits: { addresses: ["Me@X.test"] } }), null).addresses, ["me@x.test"]);
  assert.equal(textRules(eff({ commits: { addresses: ["me@x.test"] }, security: { privateText: { addresses: false } } }), null).addresses, null);
});

test("private text: conversation shapes refuse a retelling and pass the user named as a role", () => {
  const refused = [
    [`${U}, ${DAY}: some words they wrote`, "conversation.dated"],
    [`${U}, ${DAY} (a quote): split`, "conversation.dated"],
    [`${U}, ${DAY}: a request after a long wait`, "conversation.dated"],
    [`${U}, ${DAY}: left to the session: then more`, "conversation.dated"],
    [`decided ${DAY}, ${U}: go on`, "conversation.dated"],
    [`${U} also asked on ${DAY} whether it runs`, "conversation.dated"],
    [`Value not lowered: ${U} asked for it`, "conversation.act"],
    [`${U[0].toUpperCase()}${U.slice(1)} declined the plan, so it waits`, "conversation.act"],
    [`- ${U} wants no prose there`, "conversation.act"],
    [`stopped on ${U}'s word`, "conversation.word"],
    [`moved there by ${U}'s decision`, "conversation.word"],
    [`every message ${U} typed here`, "conversation.messages"],
    [`8 of ${U}'s 9 messages`, "conversation.messages"],
    ["User" + ": please do it", "conversation.speaker"],
    ["> **Assistant**" + ": done", "conversation.speaker"],
    // A quote after the label opens one: on a Markdown line, and escaped inside a JSON string.
    [`- ${U}, ${DAY}: a request "make the loop faster, now"`, "conversation.dated"],
    [`"note": "${U}, ${DAY}: approved \\"ship it tonight\\""`, "conversation.dated"],
    [`"${U}, ${DAY}: a request" "make it faster"`, "conversation.dated"],
    // A quote right after the form's end mark is the user's words.
    [`- ${U}, ${DAY}: a request; "make the loop faster"`, "conversation.dated"],
    [`- (${U}, ${DAY}: a request) "make it faster"`, "conversation.dated"],
    [`- ${U}, ${DAY}: approved. "ship it tonight"`, "conversation.dated"],
    // A curly apostrophe is the straight one.
    [`stopped on ${U}\u2019s word`, "conversation.word"],
  ];
  for (const [s, rule] of refused) assert.ok(rulesOf(s).includes(rule), `${s} -> ${rulesOf(s).join(",")}`);
  const passed = [
    `${U}, ${DAY}: a request`,
    `${U}, ${DAY}: a request; release preparation`,
    `"${U}, ${DAY}: approved",`,
    `  "source": "${U}, ${DAY}: a request"`,
    `{ "source": "${U}, ${DAY}: a request", "x": 1 }`,
    `x = "${U}, ${DAY}: a request.";`,
    `(${U}, ${DAY}: a request): then`,
    // A code span or a quote closed right after the label, words after it: the form ended.
    `source \`${U}, ${DAY}: a request\` in the node`,
    `      "source": "(${U}, ${DAY}: a request)",`,
    `      "source": "[${U}, ${DAY}: approved]"`,
    `"${U}, ${DAY}: a request" make it faster`,
    `(${U}, ${DAY}: a request) make it so`,
    `(${U}, ${DAY}: left to the session).`,
    `${U}, ${DAY}: a request [NEEDS CLARIFICATION: which one?]`,
    `user, ${DAY}: a request. Measured later`,
    `the user, <YYYY-MM-DD>: a request`,
    `a fix ${U} asked for`,
    `what ${U} said stays out`,
    `a line ${U} agreed to`,
    `${U}'s own settings`,
    `any step that needs ${U}'s word`,
    `asks ${U}, then waits`,
    `${U}s of the tool`,
    `user-invoked skills`,
    `Username: x`,
  ];
  for (const s of passed) assert.deepEqual(rulesOf(s), [], s);
  assert.equal(conversationHits(`${U} asked`).length, 1);
});

test("private text: a graph source names the user only in the closed form; a role is no provenance", () => {
  for (const s of [
    `${U}, ${DAY}: a request`, `cycle 3; ${U}, ${DAY}: approved; amended: ${U}, ${DAY}: a request`, `${U}, ${DAY}: a request [NEEDS CLARIFICATION: ]`, `${U}, ${DAY}: a request. Docs read later`,
    `the flip waits for ${U}`, `docs read; ${U}'s own environment`, "review, cycle 2", `a finding ${U}'s own settings expose`, "a user of the tool", `the flip waits for ${U} (a note); x`,
    `left for ${U} to decide; decided ${DAY} by the session`,
    // A user in general, the user as an object, what the user has; the form in brackets.
    "cycle 30 audit: one lock per user", `a report from ${U}'s own machine`, `a hook prompt asks ${U}: allow or deny`, `waits for ${U}, then retries`, "a user request path in the server", `the view ${U} (on a phone) sees`,
    `(${U}, ${DAY}: a request)`, `[${U}, ${DAY}: approved]`, `${U}, ${DAY}: a request; claude-code#1: 'an issue quoted' later`, `Codex asks ${U} to trust a plugin's hooks`, "user-invoked skills", "a non-root user with a PATH", "hit the per-user limit",
  ]) {
    assert.ok(closedSource(s), s);
  }
  for (const s of [
    `${U}, ${DAY}: their words`, `user, ${DAY}, on a thing: a request`, `${U}, after a run: a request`, `audit: ${U}'s call`, `decisions on ${U} ask (a retelling)`, `on ${U}'s word`, `review; ${U} asked for it`, `decided ${DAY}, ${U}: go on`, `every message ${U} typed`,
    // A quote after the label is no end of the form.
    `${U}, ${DAY}: a request "make the loop faster, now"`, `${U}, ${DAY}: approved 'ship it tonight'`, `${U}, ${DAY}: a request) more`,
    // The user named as who asked, with no comma after the name.
    `${U}: make the loop faster, now`, `cycle ${DAY} (50), user: keep it short`, `user request (${DAY}): make it faster`, `User ask ${DAY}: make it faster`,
    `requested by user on ${DAY}`, `cycle (50): user asked for it`, `${U} (${DAY}): a request`, `from ${U}: keep it`, `${U} said so`,
    `requested by ${U}`, `changed per ${U}`, `user on ${DAY} keep it short`, `8 of ${U}'s 9 messages`, `${U}, ${DAY}: a request.Make it faster`,
    // A quote right after the form's end mark: the user's words after the label.
    `${U}, ${DAY}: a request; "make the loop faster, now"`, `${U}, ${DAY}: approved. "ship it tonight"`, `${U}, ${DAY}: a request; \u201cmake it\u201d`, `(${U}, ${DAY}: a request) "make it"`,
    `audit: ${U}\u2019s call`,
    // A quote that would end a JSON string in a line ends nothing in a parsed value.
    `${U}, ${DAY}: a request", make the loop faster`, `${U}, ${DAY}: a request."make it faster"`,
  ]) {
    assert.equal(closedSource(s), false, s);
  }
  const config = eff();
  const node = (/** @type {string} */ id, /** @type {string} */ source) => ({ id, title: "t", source });
  const head = JSON.stringify({ nodes: [node("a", `${U}, ${DAY}: old words`)] }, null, 2);
  const staged = JSON.stringify({ nodes: [node("a", `${U}, ${DAY}: old words`), node("b", `${U}, ${DAY}: a request`)], done: [node("c", `${U}, ${DAY}: new words`)] }, null, 2);
  // Only a source HEAD does not hold is judged, with the line it is on.
  const hits = sourceHits(staged, head, config);
  assert.equal(hits.length, 1);
  assert.equal(staged.split("\n")[hits[0].line - 1].includes("new words"), true);
  assert.equal(sourceHits(staged, null, config).length, 2, "no HEAD graph: every source is new");
  assert.equal(sourceHits(staged, "{ not json", config).length, 2, "a HEAD graph that is no JSON holds no source");
  assert.equal(sourceHits(`﻿${staged}`, head, config).length, 1, "a byte order mark");
  assert.throws(() => sourceHits("{ nodes: [", head, config), /^SyntaxError: it does not parse at line 1, column 3$/);
  // The parser's own message quotes the text around the fault: never passed on.
  for (const bad of [`{\n  "nodes": [\n    { "id": "n", "source": "notes from ${NAME}" },\n  ]\n}\n`, `{ "nodes": [ { "id": "n", "source": ${NAME} } ] }`]) {
    assert.throws(() => sourceHits(bad, head, config), (/** @type {Error} */ e) => !e.message.includes(NAME) && /^it does not parse/.test(e.message));
  }
  // The field and the lists the config names.
  const renamed = eff({ graph: { exports: { open: "items" }, fields: { source: "from" } } });
  assert.equal(sourceHits(JSON.stringify({ items: [{ id: "x", from: `${U}, ${DAY}: words` }] }), null, renamed).length, 1);
});

test("private text: a refusal names each place and rule with a length and never the text it matched", () => {
  const lines = new Map([
    [`docs/${NAME}.md`, [{ line: 3, text: `see ${HOME}/notes` }]],
    ["b.txt", [{ line: 1, text: "clean" }, { line: 2, text: `mail ${MAILBOX}` }]],
  ]);
  const out = privateErrors({ rules: ALL, lang: "en", lines, names: [`docs/${NAME}.md`], message: `feat: x\n\n${U}, ${DAY}: words\n`, graph: { path: ".ennyn/graph.json", hits: [{ line: 9, length: 31 }] } });
  // A line a place, so a read that fails costs its own places only; the remedy once, last.
  assert.equal(out.length, 6);
  assert.match(out[5], /^Take the private text out/);
  const e = out.join("\n");
  for (const secret of [NAME, NAME.toLowerCase(), HOME, MAILBOX, DAY]) assert.ok(!e.includes(secret), `${secret} echoed: ${e}`);
  assert.match(e, /docs\/….md:3 \(a home path, 14 characters\)/);
  assert.match(e, /b\.txt:2 \(an address commits\.addresses does not hold, 18 characters\)/);
  assert.match(e, /the name docs\/….md \(a word of this clone's private list, 9 characters\)/);
  assert.match(e, /the commit message, line 3 \(the user and a date outside/);
  assert.match(e, /\.ennyn\/graph\.json:9 \(a graph source that names the user/);
  assert.deepEqual(privateErrors({ rules: ALL, lang: "en", lines: new Map([["a", [{ line: 1, text: "clean" }]]]), names: ["a"], message: "feat: x" }), []);
  // Past five places, the rest is counted.
  const many = new Map([["m.txt", Array.from({ length: 13 }, (_, i) => ({ line: i + 1, text: HOME }))]]);
  const capped = privateErrors({ rules: ALL, lang: "en", lines: many });
  assert.equal(capped.length, 12);
  assert.match(capped[10], /^3 more place\(s\) hold private text/);
});

test("private text: a line HEAD's file already holds, moved or given a trailing comma, is not the commit's; a new one is", () => {
  const old = `  "source": "${U}, ${DAY}: old words"`;
  const added = new Map([
    ["g.json", [{ line: 4, text: `${old},` }, { line: 5, text: `    "source": "${U}, ${DAY}: new words"` }]],
    ["new.txt", [{ line: 1, text: old }]],
  ]);
  const kept = newLines(added, new Map([["g.json", `{\n${old}\n}`], ["new.txt", null]]));
  assert.deepEqual(kept.get("g.json")?.map((l) => l.line), [5]);
  assert.deepEqual(kept.get("new.txt")?.map((l) => l.line), [1], "no HEAD version: every line is new");
});

test("private text: the switches are loosened only when turned off, and the places the gate reads count on any change", () => {
  for (const k of ["home", "conversation", "addresses", "provenance", "listExpected"]) {
    assert.equal(gateKeyKind(`security.privateText.${k}`), "gate");
    const on = eff({ security: { privateText: { [k]: true } } });
    const off = eff({ security: { privateText: { [k]: false } } });
    assert.deepEqual(loosenedKeys(on, off), [`security.privateText.${k}`]);
    assert.deepEqual(loosenedKeys(off, on), []);
  }
  const off = { security: { privateText: { provenance: false } } };
  for (const [key, over] of /** @type {[string, Record<string, unknown>][]} */ ([["paths.graph", { paths: { graph: "plan.json" } }], ["paths.stateDir", { paths: { stateDir: ".git/other" } }], ["graph.fields.source", { graph: { fields: { source: "from" } } }], ["graph.exports.done", { graph: { exports: { done: "closed" } } }], ["graph.exports.open", { graph: { exports: { open: "items" } } }], ["graph.exports.declined", { graph: { exports: { declined: "no" } } }]])) {
    assert.deepEqual(loosenedKeys(eff(), eff(over)), [key]);
    // With provenance off in both versions no rule reads the graph's place; the list's place is read whatever the switches.
    assert.deepEqual(loosenedKeys(eff(off), eff({ ...off, ...over })), key === "paths.stateDir" ? [key] : [], `${key}, provenance off in both`);
    // On in either version, the move counts: turned on with it, or turned off with it.
    assert.deepEqual(loosenedKeys(eff(off), eff(over)), [key], `${key}, provenance turned on`);
    assert.ok(loosenedKeys(eff(), eff({ ...off, ...over })).includes(key), `${key}, provenance turned off with it`);
  }
  const d = eff().security.privateText;
  assert.deepEqual(d, { home: false, conversation: false, addresses: true, provenance: true, listExpected: false });
  // Removed, the key merges to its default: a key that was on is turned off.
  assert.deepEqual(loosenedKeys(eff({ security: { privateText: { listExpected: true } } }), eff()), ["security.privateText.listExpected"]);
});

/** A repository whose first commit holds `config`, with the real commit-msg hook. @param {Record<string, unknown>} config */
function repo(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-pt-repo-")));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify(config));
  writeFileSync(join(dir, ".ennyn", "graph.json"), JSON.stringify({ nodes: [{ id: "old", title: "t", source: `${U}, ${DAY}: old words` }] }, null, 2));
  git(["add", "-A"], { cwd: dir });
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  git([...id, "commit", "-q", "--no-verify", "-m", "chore: base"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  /** Stage `files`, commit with `message`, then leave the tree as HEAD has it. @param {Record<string, string>} files @param {string} [message] */
  const attempt = (files, message = "feat: probe") => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git(["add", "-A"], { cwd: dir });
    const r = spawnSync("git", [...id, "commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      git(["reset", "-q", "--hard", "HEAD"], { cwd: dir });
      for (const p of Object.keys(files)) if (existsSync(join(dir, p))) rmSync(join(dir, p));
    }
    return r;
  };
  const add = (/** @type {string} */ input, /** @type {string[]} */ flags = []) => spawnSync(process.execPath, [CLI, "private-text", "add", ...flags], { cwd: dir, input, encoding: "utf8" });
  return { dir, attempt, add };
}

test("private text hook: each rule refuses a commit by place and rule, never the text; a clean commit passes", () => {
  const r = repo({ commits: { addresses: ["me@x.test"] }, security: { privateText: { home: true, conversation: true } } });
  const added = r.add(`${NAME}\n`);
  assert.equal(added.status, 0, added.stderr);
  const file = readFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "utf8");
  assert.ok(!file.toLowerCase().includes(NAME.toLowerCase()), "the list holds digests, not the word");
  const cases = /** @type {[string, Record<string, string>, string, RegExp][]} */ ([
    ["a listed word in a line", { "a.txt": `about ${NAME.toUpperCase()}\n` }, "feat: probe", /a\.txt:1 \(a word of this clone's private list, 9 characters\)/],
    ["a listed word in a name", { [`docs/${NAME.toLowerCase()}-notes.md`]: "plain\n" }, "feat: probe", /the name "?docs\/…-notes\.md"? \(a word of this clone's private list/],
    ["a home path", { "b.txt": `cd ${HOME}/app\n` }, "feat: probe", /b\.txt:1 \(a home path/],
    ["an address", { "c.txt": `ask ${MAILBOX}\n` }, "feat: probe", /c\.txt:1 \(an address commits\.addresses does not hold/],
    ["a conversation shape", { "d.txt": `ok\nValue kept: ${U} asked for it\n` }, "feat: probe", /d\.txt:2 \(an act of the user retold/],
    ["the message", { "e.txt": "plain\n" }, `feat: probe\n\nsee ${HOME}/x\n`, /the commit message, line 3 \(a home path/],
    ["a graph source", { ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "old", title: "t", source: `${U}, ${DAY}: old words` }, { id: "new", title: "t", source: `audit: ${U}'s call` }] }, null, 2) }, "feat: probe", /\.ennyn\/graph\.json:\d+ \(a graph source that names the user/],
  ]);
  for (const [what, files, message, place] of cases) {
    const c = r.attempt(files, message);
    assert.equal(c.status, 1, `${what}: ${c.stderr}`);
    assert.match(c.stderr, place, what);
    assert.match(c.stderr, /private text \(security\.privateText\)/, what);
    for (const secret of [NAME, NAME.toLowerCase(), NAME.toUpperCase(), HOME, MAILBOX, `${U} asked`, `${U}'s call`]) assert.ok(!c.stderr.includes(secret), `${what}: echoed`);
  }
  // A node HEAD already holds is not the commit's to fix; a new one in the closed form passes, and so does clean text.
  const graph = JSON.stringify({ nodes: [{ id: "old", title: "t", source: `${U}, ${DAY}: old words`, status: "planned" }, { id: "new", title: "t", source: `${U}, ${DAY}: a request` }, { id: "br", title: "t", source: `(${U}, ${DAY}: a request)` }] }, null, 2);
  const clean = r.attempt({ ".ennyn/graph.json": graph, "f.txt": `mail a@x.test, me@X.test; ${U}'s own settings\n` }, "feat: clean");
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stderr, /private/);
  // The old node moved to another list, its source line given a comma: the line is HEAD's; a new line with a hit is not.
  const moved = JSON.stringify({ nodes: [{ id: "new", title: "t", source: `${U}, ${DAY}: a request` }, { id: "br", title: "t", source: `(${U}, ${DAY}: a request)` }], done: [{ id: "old", title: "t", source: `${U}, ${DAY}: old words`, status: "done" }] }, null, 2);
  const move = r.attempt({ ".ennyn/graph.json": moved }, "chore: move");
  assert.equal(move.status, 0, move.stderr);
  const beside = r.attempt({ "g.txt": `${U}, ${DAY}: old words, again\n` });
  assert.equal(beside.status, 1, "the same words in a new line");
});

test("private text hook: the defaults run provenance alone; a broken list is said and the rest still runs", () => {
  const r = repo({});
  const home = r.attempt({ "a.txt": `${HOME} ${U} asked ${MAILBOX}\nKept: ${U} asked for it\n` });
  assert.equal(home.status, 0, home.stderr);
  const source = r.attempt({ ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "n", title: "t", source: `${U}, ${DAY}: words` }] }) });
  assert.equal(source.status, 1, source.stderr);
  assert.match(source.stderr, /\.ennyn\/graph\.json:1 \(a graph source/);
  const notJson = r.attempt({ ".ennyn/graph.json": "{ nodes: [" });
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /was not checked for the graph's sources: the staged \.ennyn\/graph\.json is no JSON \(it does not parse at line 1, column 3\)/);
  for (const bad of [`{\n  "nodes": [\n    { "id": "n", "source": "notes from ${NAME}" },\n  ]\n}\n`, `{ "nodes": [ { "id": "n", "source": ${NAME} } ] }`]) {
    const c = r.attempt({ ".ennyn/graph.json": bad });
    assert.equal(c.status, 1);
    assert.ok(!c.stderr.includes(NAME), "the parser's excerpt is not printed");
  }
  mkdirSync(join(r.dir, ".git", "ennyn"), { recursive: true });
  writeFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "folded nothex\n");
  const said = r.attempt({ "b.txt": "plain\n" });
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stderr, /list of private words was not checked: it could not be read \(line 1 is not/);
  // By hand a list that does not read fails the command.
  writeFileSync(join(r.dir, ".git", "MSG"), "feat: x\n");
  const byHand = spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.notEqual(byHand.status, 0);
  assert.match(byHand.stderr, /list of private words was not checked/);
});

test("private text hook: with provenance off a graph source passes; with it on the same source is refused", () => {
  const graph = { ".ennyn/graph.json": JSON.stringify({ nodes: [{ id: "n", title: "t", source: `audit: ${U}'s call` }] }) };
  assert.equal(repo({ security: { privateText: { provenance: false } } }).attempt(graph).status, 0);
  assert.equal(repo({}).attempt(graph).status, 1);
});

test("private text hook: the message is read as git stores it: a template line git strips holds no private text; a line it keeps does", () => {
  const r = repo({});
  r.add(`${NAME}\n`);
  git(["checkout", "-q", "-b", `feature/${NAME.toLowerCase()}-x`], { cwd: r.dir });
  const editor = join(r.dir, ".git", "editor.sh");
  // The editor writes a subject above git's template and keeps the template, as a person typing does.
  writeFileSync(editor, `#!/bin/sh\nf="$1"\n{ printf 'feat: from the editor\\n\\n%s\\n' "$EXTRA"; cat "$f"; } > "$f.new" && mv "$f.new" "$f"\n`);
  chmodSync(editor, 0o755);
  writeFileSync(join(r.dir, "a.txt"), "plain\n");
  git(["add", "a.txt"], { cwd: r.dir });
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const run = (/** @type {string} */ extra) => spawnSync("git", [...id, "commit", "-q"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, GIT_EDITOR: editor, EXTRA: extra } });
  const kept = run(`about ${NAME}`);
  assert.equal(kept.status, 1, "a line git keeps");
  assert.match(kept.stderr, /the commit message, line 3 \(a word of this clone's private list/);
  const stripped = run("plain body");
  assert.equal(stripped.status, 0, stripped.stderr);
  assert.match(git(["log", "-1", "--format=%B"], { cwd: r.dir }), /^feat: from the editor\n\nplain body\n/);
  assert.ok(!git(["log", "-1", "--format=%B"], { cwd: r.dir }).includes(NAME.toLowerCase()), "git stored no template line");
});

test("private text add: words from stdin, one a line, hashed; no word is printed; a line that is no word adds nothing", () => {
  const r = repo({});
  const bad = r.add(`${NAME}\ntwo words\n`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /line\(s\) 2 of the input are no single word/);
  assert.ok(!bad.stderr.includes("two words") && !bad.stderr.includes(NAME));
  assert.equal(existsSync(join(r.dir, ".git", "ennyn", "private-literals")), false, "nothing written");
  assert.equal(r.add("\n\n").status, 1, "no word");
  const ok = r.add(`${NAME}\n${NAME}\nOther\n`, ["--exact"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Added 2 word\(s\) to .*private-literals, hashed; 1 already there/);
  assert.ok(!ok.stdout.includes(NAME) && !ok.stderr.includes(NAME));
  const again = r.add(`${NAME}\n`, ["--exact"]);
  assert.match(again.stdout, /Added 0 word\(s\).*1 already there/);
  const text = readFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "utf8");
  assert.deepEqual(text.trim().split("\n"), [`exact 9 ${digest(NAME)}`, `exact 5 ${digest("Other")}`]);
  writeFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "broken\n");
  const refused = r.add("Another\n");
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "utf8"), "broken\n", "a broken list is not added to");
});

const EXPECTED = { security: { privateText: { listExpected: true } } };
/** The missing-list line of commit-check, as it opens. */
const MISSING = /security\.privateText: no word of a private list was checked/;
/** doctor's lines on the list, as `<mark> <text>`. @param {string} dir */
const doctorList = (dir) => {
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: dir, encoding: "utf8" });
  return r.stdout.split("\n").filter((l) => /private words/.test(l));
};

test("private list expected: with the key on and no list, each commit and doctor say no word was checked, and the commit passes", () => {
  const r = repo(EXPECTED);
  const c = r.attempt({ "a.txt": "plain\n" });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, MISSING);
  assert.match(c.stderr, /\.git\/ennyn\/private-literals/, "the place, as the config spells it");
  assert.match(c.stderr, /copy the file from another clone's state dir over a private channel, or run ennyn private-text add/);
  assert.ok(!c.stderr.includes(r.dir), "no machine's path");
  // Every commit, not the first only.
  const again = r.attempt({ "b.txt": "plain\n" });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, MISSING);
  // By hand too, and it fails nothing.
  writeFileSync(join(r.dir, ".git", "MSG"), "feat: x\n");
  const byHand = spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(byHand.status, 0, byHand.stderr);
  assert.match(byHand.stderr, MISSING);
  const said = doctorList(r.dir);
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /^! security\.privateText: the clone .* has no list of private words at \.git\/ennyn\/private-literals/);
  // A file with no entry checks no word either.
  mkdirSync(join(r.dir, ".git", "ennyn"), { recursive: true });
  writeFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "# none yet\n");
  assert.match(r.attempt({ "c.txt": "plain\n" }).stderr, MISSING, "an empty list");
  assert.match(doctorList(r.dir)[0] ?? "", /^! /, "doctor, an empty list");
});

test("private list expected: with a list, or with the key off, neither line; an unread list is said as before, never as missing", () => {
  const r = repo(EXPECTED);
  assert.equal(r.add(`${NAME}\n`).status, 0);
  const c = r.attempt({ "a.txt": "plain\n" });
  assert.equal(c.status, 0, c.stderr);
  assert.doesNotMatch(c.stderr, MISSING);
  const listed = doctorList(r.dir);
  assert.equal(listed.length, 1, listed.join("\n"));
  assert.match(listed[0], /^✓ security\.privateText: this clone holds a list of private words/);
  const off = repo({});
  const plain = off.attempt({ "a.txt": "plain\n" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stderr, MISSING);
  assert.deepEqual(doctorList(off.dir), [], "the key off: doctor reads no list");
  writeFileSync(join(r.dir, ".git", "ennyn", "private-literals"), "folded nothex\n");
  const broken = r.attempt({ "b.txt": "plain\n" });
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stderr, /list of private words was not checked: it could not be read/);
  assert.doesNotMatch(broken.stderr, MISSING);
  const unread = doctorList(r.dir);
  assert.equal(unread.length, 1, unread.join("\n"));
  assert.match(unread[0], /^✗ security\.privateText: the list of private words could not be read \(line 1 is not/);
});

test("private list expected: turning the key off, or removing it, is a loosening the hook refuses without the approval line", () => {
  const r = repo(EXPECTED);
  const KEY = "security.privateText.listExpected";
  for (const [what, config] of /** @type {[string, Record<string, unknown>][]} */ ([["turned off", { security: { privateText: { listExpected: false } } }], ["removed", {}]])) {
    const refused = r.attempt({ ".ennyn/config.json": JSON.stringify(config) }, "chore: drop the list");
    assert.equal(refused.status, 1, `${what}: ${refused.stderr}`);
    assert.match(refused.stderr, /This commit loosens security\.privateText\.listExpected\b/, what);
  }
  const approved = r.attempt({ ".ennyn/config.json": JSON.stringify({}) }, `chore: drop the list\n\n${LOOSENING_LINE} ${KEY}\n`);
  assert.equal(approved.status, 0, approved.stderr);
  // Turned on again: a tightening, no line asked.
  const on = r.attempt({ ".ennyn/config.json": JSON.stringify(EXPECTED) }, "chore: expect the list");
  assert.equal(on.status, 0, on.stderr);
});
