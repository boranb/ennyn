/**
 * Shell text Ennyn builds in JavaScript templates, parsed by the shells that run it. A template is never read as
 * shell where it is written: a quote or an escape left by the template breaks the text only when it runs, on a
 * commit. Each text here comes from the real function (the hook and its plugin form, the block for a project's own
 * hook, the line install-hook prints, the chmod it advises, the env-file line of the SessionStart hook, the commands
 * clone-setup prints, the mutation command scan finds in a stryker script, the commands of the impact table), with a
 * value that holds what a shell reads (a quote, a line feed, a `$`, a backslash, letters past ASCII) wherever a value
 * lands in it, and goes through `sh -n`, `dash -n` and `bash -n`: they read, and run nothing. A hostile value must
 * expand nothing: its render expands the names and substitutions the plain render does, no more. Then the template's
 * residue: a `\$`, a `${` that holds no shell name or stands in single quotes (an expression left unfilled), a line
 * feed in single quotes (an escape the template lost), a doubled backslash, a name expanded outside single quotes that
 * neither the text sets nor the environment gives. Last, the lines a person pastes (clone-setup's, the hook line, the
 * chmod, the env-file line, scan's mutation command) run in test/shell-box.mjs's box with stand-ins: each value must
 * reach the program as one word, unchanged.
 *
 * Needs /bin/sh, /bin/dash and /bin/bash, whatever /bin/sh is there: one that is missing fails the first test, never
 * skips (as test/hook-oracle.test.mjs). Running the hooks is test/hook-oracle.test.mjs's and test/hook.test.mjs's work.
 *
 * Not measured here: the Windows forms (hookScript's drive-path arm is chosen by process.platform); zsh and ksh, which
 * this gate does not parse with (every text parsed under zsh 5.9 and ksh 93u+ with -n when the gate was written, in a
 * review's lab), nor ash. A value holding a control character is printed through a message (t()) as a `\u` escape, by
 * that function's own rule, so the printed line or chmod then names another path; the block is printed raw. The impact
 * table prints its symbol and file names unquoted (a known gap, left for its own fix): its commands are parsed here
 * with names that hold nothing a shell reads, so only its own template text is checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { git } from "../core/git.mjs";
import { catalog, t as message } from "../core/i18n.mjs";
import { buildImpactTable } from "../impact/table.mjs";
import { setupCommands } from "../setup/clone-setup.mjs";
import { hookBlock, hookLine, hookScript, installHook, sessionLine } from "../setup/hook.mjs";
import { projectCommands } from "../setup/scan.mjs";
import { ownHome } from "./own-home.mjs";
import { shellBox } from "./shell-box.mjs";

const { root: ROOT } = ownHome("en-shell-templates-");

/** The shells each text goes through, by these exact paths. */
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"];

/** One path segment each: what a shell reads in a value. No `/` (a folder is made by each), no NUL (no path holds one). */
const HOSTILE = [
  ["plain", "plain"],
  ["a single quote", "it's"],
  ["a double quote", 'say "x"'],
  // Names nothing sets or gives: a value that expands is seen by name, not only by its substitution.
  ["a dollar", "$EN_HOSTILE ${EN_HOSTILE2} $(false)"],
  ["a backtick", "`false`"],
  ["a backslash", "back\\slash\\"],
  ["a line feed", "new\nline"],
  ["letters past ASCII", "çğüş Ünï"],
  ["message placeholders", "{line} {chmod}"],
  ["glob, space and hash", "sp ace *?[x] #no"],
  ["separators", "a;b&c|d<e>f(g"],
  ["history, tilde, tab", "!bang ~tilde\tx"],
  // One shape alone each: a helper that stops quoting just that shape is seen (another value's quote would hide it).
  ["a space alone", "Application Support"],
  ["a dollar name alone", "$EN_HOSTILE3@${EN_HOSTILE4}"],
];

/** The values that hold none of a template's residue shapes (a `$`, a backslash, a backtick, a control character). */
const TAME = HOSTILE.filter(([, s]) => !/[$\\`\x00-\x1f]/.test(s));

/** Plugin data directory names the block can hold (BLOCK_ID); install-hook refuses any other before printing one. */
const IDS = ["ennyn-ennyn", "a.b_c-1"];

/** What the environment gives a hook text, and the shell's own parameters. */
const GIVEN = new Set(["PATH", "HOME", "ENNYN_PLUGIN_DATA", "ENNYN_PLUGIN_ROOT", "CLAUDE_CONFIG_DIR", ..."0123456789@*#?$!-"]);

/**
 * Every hook text with `seg` where a value lands.
 * @param {string} seg
 * @returns {[string, string][]}
 */
function hookTexts(seg) {
  const p = `/opt/${seg}/en`;
  return [
    ["hookLine by path", hookLine(`${p}/scripts/ennyn.mjs`)],
    ["hookLine by record", hookLine("/opt/en/scripts/ennyn.mjs", `${p}/data`)],
    ["hookScript by path", hookScript(`${p}/scripts/ennyn.mjs`)],
    ["hookScript by record", hookScript("/opt/en/scripts/ennyn.mjs", `${p}/data`)],
    // One value hostile at a time: two of them can pair their quotes and parse.
    ["sessionLine, the data directory", sessionLine(`${p}/data`, "/opt/en/cache/m/en/1.0.0")],
    ["sessionLine, the root", sessionLine("/opt/en/data", `${p}/cache/m/en/1.0.0`)],
    ...IDS.map((id) => /** @type {[string, string]} */ ([`hookBlock ${id}`, hookBlock(`${p}/${id}`)])),
    // The block quotes its id all the same: one install-hook refuses (BLOCK_ID) still parses.
    ["hookBlock, the value as its id", hookBlock(`${p}/${seg}`)],
  ];
}

/**
 * What clone-setup prints with `seg` in every value, each line and the lines as pasted together; and with nothing
 * known (no address, no signing key: its fill-in line).
 * @param {string} seg
 * @returns {[string, string][]}
 */
function setupTexts(seg) {
  const p = `/opt/${seg}/en`;
  const known = setupCommands({ address: `${seg}@x.test`, signed: true, signingKey: `${p}/key.pub`, signers: `${p}/allowed`, cli: `${p}/scripts/ennyn.mjs`, pluginData: `${p}/data` });
  const unknown = setupCommands({ address: null, signed: true, signingKey: null, signers: `${p}/allowed`, cli: `${p}/scripts/ennyn.mjs` });
  return [...known, ...unknown].map((line, i) => /** @type {[string, string]} */ ([`clone-setup line ${i + 1}`, line])).concat([
    ["clone-setup, all lines", known.join("\n")],
    ["clone-setup, no key, all lines", unknown.join("\n")],
  ]);
}

/**
 * The mutation command scan finds for a stryker script named `seg` (npm runs any name: it is quoted for the shell).
 * @param {string} seg
 * @returns {[string, string][]}
 */
function scanTexts(seg) {
  const dir = mkdtempSync(join(ROOT, "scan-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { [seg]: "stryker run" } }));
  return [["scan's mutation command", projectCommands(dir).mutation ?? `no command for ${JSON.stringify(seg)}`]];
}

/** @type {string[] | null} */
let impactCommands = null;

/**
 * The commands the impact table prints, for a symbol and a file that hold nothing a shell reads (the header).
 * @returns {[string, string][]}
 */
function impactTexts() {
  if (impactCommands === null) {
    const dir = mkdtempSync(join(ROOT, "impact-"));
    git(["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "parse.mjs"), "export function parseRow(l) {\n  try {\n    return JSON.parse(l);\n  } catch {\n    return null;\n  }\n}\n");
    writeFileSync(join(dir, "src", "parse.test.mjs"), 'import { parseRow } from "./parse.mjs";\nparseRow("{}");\n');
    git(["add", "-A"], { cwd: dir });
    git(["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"], { cwd: dir });
    const { rows } = buildImpactTable({ cwd: dir, config: loadConfig({ cwd: dir, env: {} }), symbol: "parseRow", files: ["src/parse.mjs"] });
    impactCommands = rows.flatMap((r) => r.commands);
  }
  return impactCommands.map((c, i) => /** @type {[string, string]} */ ([`impact command ${i + 1}`, c]));
}

/** Every text whose values a person or a program can choose, with `seg` in each value. @param {string} seg */
const valued = (seg) => [...hookTexts(seg), ...setupTexts(seg), ...scanTexts(seg), ["install-hook's chmod", chmodIn(seg)]];

/**
 * Each shell that does not take `text`, with what it said.
 * @param {string} text
 */
function unparsed(text) {
  return SHELLS.flatMap((shell) => {
    const r = spawnSync(shell, ["-n"], { input: text, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    return r.status === 0 && !r.error ? [] : [`${shell}: ${r.error?.message ?? r.stderr.trim().split("\n")[0]}`];
  });
}

/**
 * What `text` expands where a shell expands: the names (not in single quotes, not after a backslash, not in a
 * comment), the command substitutions (`$(` and backticks there), the single-quoted spans, as written, and the control
 * and redirection operators (`|`, `&`, `;`, `<`, `>`) outside quotes and substitutions. A reading for these checks, no
 * parser: the shells parse above.
 * @param {string} text
 */
function reading(text) {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const quoted = [];
  let subs = 0;
  let ops = 0;
  /** @type {("top" | "dq" | "sub")[]} */
  const at = ["top"];
  let wordStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const here = at[at.length - 1];
    if (c === "\\") {
      i++;
      wordStart = false;
    } else if (here !== "dq" && c === "'") {
      const end = text.indexOf("'", i + 1);
      quoted.push(text.slice(i + 1, end === -1 ? text.length : end));
      i = end === -1 ? text.length : end;
      wordStart = false;
    } else if (c === "`") {
      subs++;
      wordStart = false;
    } else if (here !== "dq" && c === "#" && wordStart) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
    } else if (here === "sub" && c === ")") {
      at.pop();
      wordStart = false;
    } else if (c === '"') {
      if (here === "dq") at.pop();
      else at.push("dq");
      wordStart = false;
    } else if (c === "$" && text[i + 1] === "(") {
      subs++;
      at.push("sub");
      i++;
      wordStart = true;
    } else if (c === "$") {
      const m = /^\$(?:\{#?([A-Za-z_]\w*|[0-9@*#?$!-])|([A-Za-z_]\w*|[0-9@*#?$!-]))/.exec(text.slice(i, i + 200));
      if (m) names.push(m[1] ?? m[2]);
      wordStart = false;
    } else {
      if (here === "top" && /[|&;<>]/.test(c)) ops++;
      wordStart = /[\s;&|()]/.test(c);
    }
  }
  return { names, subs, quoted, ops };
}

/** The names `text` expands, in order. @param {string} text */
const expanded = (text) => reading(text).names;

/** The names `text` sets: an assignment, `read`'s last word, a `for` loop's name, a function. @param {string} text */
function setNames(text) {
  const set = [
    ...text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g),
    ...text.matchAll(/\bread(?:[ \t]+-r)?[ \t]+([A-Za-z_]\w*)/g),
    ...text.matchAll(/\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/g),
    ...text.matchAll(/(?:^|\n)[ \t]*([A-Za-z_]\w*)\(\)/g),
  ];
  return new Set(set.map((m) => m[1]));
}

/**
 * What a template left in `text`, by kind.
 * @param {string} text
 */
function residue(text) {
  /** @type {string[]} */
  const found = [];
  if (text.includes("\\$")) found.push("a literal \\$");
  if (/\\{3,}/.test(text)) found.push("three backslashes or more in a row");
  if (/\\\\[A-Za-z0-9'"]/.test(text)) found.push("a doubled backslash before a letter or a quote");
  for (const m of text.matchAll(/\$\{/g)) {
    if (!/^\$\{#?(?:[A-Za-z_]\w*|[0-9@*#?$!-])(?:\}|:?[-=?+]|%%?|##?)/.test(text.slice(m.index, m.index + 200))) found.push(`\${ that opens no shell name: ${JSON.stringify(text.slice(m.index, m.index + 24))}`);
  }
  const { quoted } = reading(text);
  // A shell expands nothing in single quotes: a `${` there is a template's expression left unfilled.
  if (quoted.some((q) => q.includes("${"))) found.push("a ${ in single quotes");
  if (quoted.some((q) => q.includes("\n"))) found.push("a line feed in single quotes (an escape the template lost)");
  const set = setNames(text);
  for (const name of new Set(expanded(text))) if (!set.has(name) && !GIVEN.has(name)) found.push(`$${name}: neither set by the text nor given by the environment`);
  return found;
}

/** @type {Map<string, string>} */
const chmods = new Map();
/** The hook's path in each repository chmodIn made, as installHook names it. @type {Map<string, string>} */
const hookPaths = new Map();

/**
 * The chmod install-hook advises in a new repository whose path holds `seg`, from installHook itself.
 * @param {string} seg
 */
function chmodIn(seg) {
  const had = chmods.get(seg);
  if (had !== undefined) return had;
  const dir = mkdtempSync(join(ROOT, `${seg}-`));
  git(["init", "-q"], { cwd: dir });
  const { chmod, path } = installHook({ cwd: dir, cliPath: "/opt/en/scripts/ennyn.mjs" });
  chmods.set(seg, chmod);
  hookPaths.set(seg, path);
  return chmod;
}

test("shell templates: /bin/sh, /bin/dash and /bin/bash are here, each the shell it is called, and -n reads without running", (t) => {
  /** @type {string[]} */
  const wrong = [];
  for (const shell of SHELLS) {
    const r = spawnSync(shell, ["-c", "echo ${BASH_VERSION-no bash}; exit 7"], { encoding: "utf8" });
    if (r.status !== 7) wrong.push(`${shell}: ${r.error?.message ?? `exit ${r.status}`}`);
    else t.diagnostic(`${shell}: ${r.stdout.trim()}`);
    if (shell === "/bin/bash" && /no bash/.test(r.stdout)) wrong.push(`${shell} is no bash`);
    if (shell === "/bin/dash" && !/no bash/.test(r.stdout)) wrong.push(`${shell} is bash, so nothing here is read by dash`);
    // -n runs nothing (an exit is not taken), and refuses what does not parse.
    if (spawnSync(shell, ["-n"], { input: "exit 3\n" }).status !== 0) wrong.push(`${shell} -n ran the text`);
    if (spawnSync(shell, ["-n"], { input: "if true; then\n" }).status === 0) wrong.push(`${shell} -n took a text that does not parse`);
  }
  assert.deepEqual(wrong, []);
});

test("shell templates: every hook text parses under sh, dash and bash, with a hostile value wherever one lands", () => {
  /** @type {string[]} */
  const wrong = [];
  for (const [what, seg] of HOSTILE) for (const [name, text] of hookTexts(seg)) for (const why of unparsed(text)) wrong.push(`${name}, ${what}: ${why}`);
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: what clone-setup prints parses, its fill-in line too, with a hostile value wherever one lands", () => {
  /** @type {string[]} */
  const wrong = [];
  for (const [what, seg] of HOSTILE) for (const [name, text] of setupTexts(seg)) for (const why of unparsed(text)) wrong.push(`${name}, ${what}: ${why}`);
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: scan's mutation command and the impact table's commands parse", () => {
  /** @type {string[]} */
  const wrong = [];
  for (const [what, seg] of HOSTILE) for (const [name, text] of scanTexts(seg)) for (const why of unparsed(text)) wrong.push(`${name}, ${what}: ${why}`);
  const impact = impactTexts();
  if (impact.length < 5) wrong.push(`the impact table gave ${impact.length} commands`);
  for (const [name, text] of impact) for (const why of unparsed(text)) wrong.push(`${name}: ${why}`);
  // Each is one command: a quote the template lost can leave a pipeline that parses.
  for (const [name, text] of [...impact, ...scanTexts("plain"), ...setupTexts("plain").filter(([n]) => !n.includes("all lines"))]) {
    if (reading(text).ops) wrong.push(`${name}: a control or redirection operator outside quotes: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: the chmod install-hook advises parses, for a repository whose path holds what a shell reads", () => {
  /** @type {string[]} */
  const wrong = [];
  for (const [what, seg] of HOSTILE) {
    const chmod = chmodIn(seg);
    if (!chmod.startsWith("chmod +x '")) wrong.push(`${what}: no chmod of a quoted path: ${JSON.stringify(chmod)}`);
    for (const why of unparsed(chmod)) wrong.push(`${what}: ${why}`);
  }
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: no template residue in any text: no \\$, no unfilled ${…}, no doubled backslash, no name nothing sets", () => {
  /** @type {string[]} */
  const wrong = [];
  // The residue is the template's: the values here hold none of its shapes.
  for (const [what, seg] of TAME) for (const [name, text] of valued(seg)) for (const r of residue(text)) wrong.push(`${name}, ${what}: ${r}`);
  for (const [name, text] of impactTexts()) for (const r of residue(text)) wrong.push(`${name}: ${r}`);
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: a hostile value expands nothing: each text expands the names and substitutions its plain render does", () => {
  /** @type {string[]} */
  const wrong = [];
  const plain = valued("plain").map(([, text]) => reading(text));
  for (const [what, seg] of HOSTILE) {
    valued(seg).forEach(([name, text], i) => {
      const { names, subs } = reading(text);
      if (names.join(" ") !== plain[i].names.join(" ") || subs !== plain[i].subs) wrong.push(`${name}, ${what}: expands ${names.join(" ") || "no name"} and ${subs} substitutions`);
    });
  }
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates control: the residue reading finds each residue it names, and passes the texts' own forms", () => {
  const found = (/** @type {string} */ text) => residue(text).length > 0;
  for (const bad of [
    'echo "costs \\$5"\n',
    "printf '%s\\n' '${say.none}'\n",
    'x="${shQuote(data)}"\n',
    "printf '%s\\\\n' x\n",
    "case $x in *\\\\\\*) ;; esac\n",
    'node "$cliPath" commit-check\n',
    'line=1\necho "${root:-x}"\n',
    'echo "$(cat "$record")"\n',
    "printf '%s\\n' 'or ${remove}.' >&2\n",
    "printf '%s\n' x\n",
  ])
    assert.ok(found(bad), JSON.stringify(bad));
  for (const good of [
    "line=\nIFS= read -r line < /dev/null\necho \"$line\" '$notexpanded'\n",
    "slashed() {\n  slashed_in=$1\n  slashed=${slashed_in%%\\\\*}/\n}\nslashed \"${HOME:-}\"\n",
    "# a comment names $nothing\nfor dir in a b; do echo \"$dir\"; done\n",
    "data='/x'\nnode \"$(cat '/a/$b')/s\" \"$data\" || exit $?\n",
  ])
    assert.deepEqual(residue(good), [], JSON.stringify(good));
  assert.equal(reading("a | b && c; d < e > f '|' \"&\" $(g; h) \\;").ops, 6);
  assert.deepEqual(reading("a=1 '$b' \"$c\" \\$d $(e '$f' \"$g\") # $h\n${i%x} $ `k` \"`l`\" '`m`'"), { names: ["c", "g", "i"], subs: 5, quoted: ["$b", "$f", "`m`"], ops: 0 });
});

test("shell templates: a hook message prints the line and the chmod as they stand, and ${CLAUDE_PLUGIN_DATA} stays whole, in every language", () => {
  /** @type {string[]} */
  const wrong = [];
  for (const lang of ["en", "tr"]) {
    const keys = Object.keys(catalog(lang)).filter((k) => k.startsWith("hook."));
    const printing = keys.filter((k) => /\{(?:line|chmod)\}/.test(catalog(lang)[k]));
    const literal = keys.filter((k) => catalog(lang)[k].includes("${CLAUDE_PLUGIN_DATA}"));
    if (printing.length < 9 || literal.length < 5) wrong.push(`${lang}: ${printing.length} messages print a line or a chmod, ${literal.length} name \${CLAUDE_PLUGIN_DATA}`);
    // A control character is t()'s to escape (the header): those values are not printed as they stand.
    for (const [what, seg] of HOSTILE.filter(([, s]) => !/[\x00-\x1f]/.test(s))) {
      const line = hookLine(`/opt/${seg}/en/scripts/ennyn.mjs`);
      const chmod = chmodIn(seg);
      // As scripts/ennyn.mjs passes them to every hook.* message.
      const vars = { path: `/r/${seg}/.git/hooks/commit-msg`, dir: `/r/${seg}/hooks`, line, cli: `/opt/${seg}/cli`, chmod, own: `/r/${seg}/own`, root: `/opt/${seg}`, data: `/d/${seg}`, recorded: `/opt/${seg}` };
      for (const k of printing) {
        const out = message(k, vars, lang);
        if (catalog(lang)[k].includes("{line}") && !out.includes(line)) wrong.push(`${lang} ${k}, ${what}: the line is not printed as it stands`);
        if (catalog(lang)[k].includes("{chmod}") && !out.includes(chmod)) wrong.push(`${lang} ${k}, ${what}: the chmod is not printed as it stands`);
      }
      for (const k of literal) if (!message(k, vars, lang).includes('"${CLAUDE_PLUGIN_DATA}"') && !message(k, vars, lang).includes("(${CLAUDE_PLUGIN_DATA})")) wrong.push(`${lang} ${k}, ${what}: \${CLAUDE_PLUGIN_DATA} is not whole`);
    }
  }
  assert.deepEqual(wrong.slice(0, 20), []);
});

test("shell templates: what a person pastes, or mutate runs, hands each value to the program as one word, unchanged (the box, bash)", () => {
  const box = shellBox("en-shell-templates-box-", { stands: { git: "", node: "", chmod: "", show: "", npm: "" }, real: [] });
  try {
    /** @type {string[]} */
    const wrong = [];
    /** @param {string} what @param {string} text @param {string[][]} want */
    const same = (what, text, want) => {
      const got = box.run(text).calls.map((c) => c.slice(2));
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${what}: ${JSON.stringify(got)}`);
    };
    // The box's log holds one line a call: a value with a line feed cannot be read back there (parsed above).
    for (const [what, seg] of HOSTILE.filter(([, s]) => !s.includes("\n"))) {
      const p = `/opt/${seg}/en`;
      const v = { address: `${seg}@x.test`, signingKey: `${p}/k.pub`, signers: `${p}/s`, cli: `${p}/c.mjs`, pluginData: `${p}/d` };
      same(`clone-setup, ${what}`, setupCommands({ signed: true, ...v }).join("\n"), [
        ["config", "user.email", v.address],
        ["config", "gpg.format", "ssh"],
        ["config", "user.signingkey", v.signingKey],
        ["config", "commit.gpgsign", "true"],
        ["config", "tag.gpgsign", "true"],
        ["config", "gpg.ssh.allowedSignersFile", v.signers],
        [v.cli, "install-hook", "--plugin-data", v.pluginData],
      ]);
      same(`hookLine, ${what}`, `set -- MSG\n${hookLine(`${p}/scripts/ennyn.mjs`)}`, [[`${p}/scripts/ennyn.mjs`, "commit-check", "--hook", "MSG"]]);
      same(`sessionLine, ${what}`, `${sessionLine(`${p}/d`, `${p}/r`)}show "$ENNYN_PLUGIN_DATA" "$ENNYN_PLUGIN_ROOT"`, [[`${p}/d`, `${p}/r`]]);
      same(`chmod, ${what}`, chmodIn(seg), [["+x", hookPaths.get(seg) ?? ""]]);
      same(`scan's mutation command, ${what}`, scanTexts(seg)[0][1], [["run", seg]]);
    }
    // git keeps a signing key as written, `~` too (it expands it as a path when it reads it): printed, it stays `~`.
    const home = setupCommands({ address: null, signed: true, signingKey: "~/keys/k.pub", signers: "/s", cli: "/c" });
    same("clone-setup, a key file under ~", home.join("\n"), [["config", "gpg.format", "ssh"], ["config", "user.signingkey", "~/keys/k.pub"], ["config", "commit.gpgsign", "true"], ["config", "tag.gpgsign", "true"], ["config", "gpg.ssh.allowedSignersFile", "/s"], ["/c", "install-hook"]]);
    const none = setupCommands({ address: null, signed: true, signingKey: null, signers: "/s", cli: "/c" });
    same("clone-setup's fill-in", none.join("\n"), [["config", "gpg.format", "ssh"], ["config", "user.signingkey", "<your SSH public key file>"], ["config", "commit.gpgsign", "true"], ["config", "tag.gpgsign", "true"], ["config", "gpg.ssh.allowedSignersFile", "/s"], ["/c", "install-hook"]]);
    assert.deepEqual(wrong.slice(0, 20), []);
  } finally {
    box.close();
  }
});
