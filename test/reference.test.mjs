/**
 * Reference differentials: a check that models another program's reading is replayed against that program's
 * recorded answers (test/reference/). The deps gate's reading of npm's lock and source spellings is compared,
 * place by place, with what npm 10 itself does with each cell (test/reference/npm.mjs records it); Ennyn's
 * readings of what Claude Code reads (the ask rules, the instruction files a session loads, the rules a path
 * loads, a plugin's files) with what Claude Code itself did with each cell (test/reference/claude-code.mjs). A
 * comparison that moved from the one the cell lists fails here. The records never ask the machine: each
 * recorder's `check` does, and fails when the machine's program reads a cell otherwise or is another version.
 * git's readings are replayed against git itself (test/git-oracle.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { t } from "../core/i18n.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { RECORD, RELATIONS, cellProblems, compare, moves, readRecord, unmeasuredOf } from "./reference/npm.mjs";
import * as cc from "./reference/claude-code.mjs";

/** The open nodes of the work graph: a `gap:` names one. */
async function openNodes() {
  const top = join(RECORD, "..", "..", "..");
  const config = loadConfig({ cwd: top, env: {} });
  const graph = await loadGraph({ cwd: top, config });
  const f = config.graph.fields;
  return new Set(graph.open.filter((n) => n[f.status] !== config.graph.doneStatus).map((n) => String(n[f.id])));
}

test("reference: every npm cell compares as recorded", async () => {
  const rec = readRecord();
  assert.ok(rec.cells.length > 0, "test/reference/npm.json holds no cell");
  const lines = moves(rec.cells, await openNodes());
  assert.equal(
    lines.join("\n"),
    "",
    `test/reference/npm.json: ${lines.length} comparison(s) moved. A gate that reads npm otherwise than npm does is fixed, or the place lists why ("unread: …", "extra: …", "differs: …", "gap: <open node>"), in the commit that moves it.`,
  );
});

test("reference: the npm record names its npm and holds well-formed cells, each with npm's reading", () => {
  const rec = readRecord();
  assert.match(String(rec.npm.npm), /^\d+\.\d+\.\d+$/);
  // The count `check` holds the machine to: the record's own, never more.
  assert.equal(rec.unmeasured, unmeasuredOf(rec.cells), "the record's unmeasured count");
  for (const m of ["arborist", "npm-package-arg", "pacote", "@npmcli/config"]) assert.match(String(rec.npm[m]), /^\d+\.\d+\.\d+$/, m);
  const ids = rec.cells.map((c) => c.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "an id twice");
  assert.deepEqual(rec.cells.flatMap(cellProblems), []);
  for (const c of rec.cells) assert.ok(c.npm && typeof c.npm.ci === "string" && c.npm.at && typeof c.npm.at === "object", `${c.id}: no npm reading`);
  // The record holds what the comparison needs on each side: npm installing something the gate refuses, reads
  // otherwise, or agrees with, at listed, inside, git and bundled places.
  const seen = new Set(rec.cells.flatMap((c) => [...compare(c).values()].map((r) => `${r.relation} ${r.claim?.verdict.split(" ")[0] ?? "-"} ${r.npm?.kind ?? "-"}`)));
  for (const want of ["agree listed remote", "agree listed registry", "agree inside file", "agree inside directory", "agree inside link", "agree refused git", "agree said bundled", "agree sourced git", "unread refused remote", "unread said registry", "extra listed -", "unmeasured listed -", "unmeasured listed remote", "agree spec remote", "stricter spec remote"]) assert.ok(seen.has(want), want);
});

test("reference control: the judge finds a reading that moved", () => {
  const rec = readRecord();
  const cell = rec.cells.find((c) => [...compare(c).values()].some((r) => r.relation === "agree" && r.claim?.verdict === "listed" && r.npm?.kind === "remote"));
  assert.ok(cell, "no cell where the gate lists what npm fetches");
  const [place] = [...compare(cell)].find(([, r]) => r.relation === "agree" && r.claim?.verdict === "listed") ?? [];
  assert.equal(moves([cell]).length, 0);
  // npm fetching another URL than the one the gate proves: a hole.
  const elsewhere = { ...cell, npm: { ...cell.npm, at: { ...cell.npm.at, [place]: { kind: "remote", url: "https://evil.example/x.tgz", spec: "x" } } } };
  assert.match(moves([elsewhere]).join("\n"), /differs, recorded agree/);
  // npm installing something the gate never saw.
  const unseen = { ...cell, npm: { ...cell.npm, at: { ...cell.npm.at, "node_modules/unseen": { kind: "git", spec: "unseen@github:u/x" } } } };
  assert.match(moves([unseen]).join("\n"), /node_modules\/unseen: differs, recorded agree — gate has no entry/);
  // A listed difference that no longer holds, one with no why, a gap that names no open node, a place neither has.
  assert.match(moves([{ ...cell, except: { [place]: "unread: x" } }]).join("\n"), /agree, recorded unread/);
  assert.match(moves([{ ...cell, except: { [place]: "extra:" } }]).join("\n"), /gives no why/);
  assert.match(moves([{ ...cell, except: { [place]: "gap: no-such-node" } }], new Set(["other"])).join("\n"), /gap names no open graph node: no-such-node/);
  assert.match(moves([{ ...cell, except: { "node_modules/nowhere": "extra: x" } }]).join("\n"), /neither npm nor the gate has this location/);
  assert.match(moves([{ ...cell, except: { "*": "extra: x" } }]).join("\n"), /\*: listed, but every other place agrees/);
  // npm fetching a place anew from another source than the gate reads: a hole, whatever the gate read there.
  const anew = { ...cell, npm: { ...cell.npm, at: { ...cell.npm.at, [place]: { ...cell.npm.at[place], refetch: true, url: "https://evil.example/x.tgz" } } } };
  assert.match(moves([anew]).join("\n"), /differs, recorded agree/);
  // Where the stand-in stopped npm, a place is unmeasured, never an agreement and never what npm left out.
  const stopped = rec.cells.find((c) => c.npm?.ci.startsWith("stand-in") && [...compare(c).values()].some((r) => r.relation === "unmeasured"));
  assert.ok(stopped, "no cell where the stand-in stopped npm");
  assert.equal(moves([stopped]).length, 0);
  assert.match(moves([{ ...stopped, npm: { ...stopped.npm, ci: "ok" } }]).join("\n"), /extra, recorded unmeasured/);
  assert.deepEqual(RELATIONS, ["agree", "unread", "extra", "differs", "unmeasured", "stricter"]);
  // A cell whose paths could leave the recorder's directory is no cell.
  for (const bad of [{ files: { "../x": "" } }, { files: { "/abs/x": "" } }, { lockDir: "a/../../b" }, { lockName: "../package-lock.json" }, { lockName: "a/package-lock.json" }, { files: { "a\\b": "" } }, { files: { "a\u0000b": "" } }]) {
    assert.notDeepEqual(cellProblems({ id: "x", from: "control", lock: {}, ...bad }), [], JSON.stringify(bad));
  }
  assert.deepEqual(cellProblems({ id: "x", from: "control", lock: {}, lockDir: "app/sub", lockName: "npm-shrinkwrap.json", files: { "vendor/a/package.json": "{}" } }), []);
});

test("reference control: each reading is compared in full: the URL, the origin, the path, the registry, and every key of one place", () => {
  const cells = readRecord().cells;
  /** The first cell whose place `pick` takes, and that place. @param {(r: ReturnType<typeof compare> extends Map<string, infer R> ? R : never) => boolean} pick */
  const find = (pick) => {
    for (const c of cells) for (const [place, r] of compare(c)) if (pick(r)) return { c, place };
    throw new Error("no such place in the record");
  };
  /** The moves of a cell when npm reads `at` at its place. @param {{ c: any, place: string }} x @param {object} at */
  const movedTo = (x, at) => moves([{ ...x.c, npm: { ...x.c.npm, at: { ...x.c.npm.at, [x.place]: at } } }]).join("\n");
  const from = find((r) => r.relation === "agree" && r.claim?.verdict === "refused from");
  assert.match(movedTo(from, { kind: "remote", url: "https://other.example/x.tgz", spec: "x" }), /differs, recorded agree/);
  const inside = find((r) => r.relation === "agree" && r.claim?.verdict === "inside" && r.npm?.kind === "directory");
  assert.match(movedTo(inside, { kind: "directory", path: "elsewhere/x" }), /differs, recorded agree/);
  const listed = find((r) => r.relation === "agree" && r.claim?.verdict === "listed" && r.npm?.kind === "registry");
  assert.match(movedTo(listed, { ...listed.c.npm.at[listed.place], registry: "https://other.example/" }), /differs, recorded agree/);
  const unlisted = find((r) => r.relation === "agree" && r.claim?.verdict === "refused noResolvedUnlisted");
  assert.match(movedTo(unlisted, { ...unlisted.c.npm.at[unlisted.place], registry: "https://other.example/" }), /differs, recorded agree/);
  // Two keys of one place: the claim further from npm's reading speaks, whichever key comes first.
  const twice = {
    id: "twice",
    from: "control",
    lock: { lockfileVersion: 3, packages: { "": {}, "node_modules/a/": { version: "1.0.0", resolved: "https://evil.example/a.tgz", integrity: "sha512-x" }, "node_modules/a": { version: "1.0.0", resolved: "{{registry}}/a/-/a-1.0.0.tgz", integrity: "sha512-x" } } },
    npm: { ci: "ok", at: { "node_modules/a": { kind: "remote", url: "https://evil.example/a.tgz", spec: "a@https://evil.example/a.tgz" } } },
  };
  assert.match(moves([twice]).join("\n"), /twice node_modules\/a: differs, recorded agree — gate listed/);
  // npm fetching a tag anew from the registry, which the gate lets through: a hole; a version or range there npm ci refuses (extra).
  const tagged = { ...listed.c, npm: { ...listed.c.npm, at: { ...listed.c.npm.at, [listed.place]: { kind: "registry", name: "evilpkg", version: "latest", registry: "https://registry.npmjs.org/", spec: "a@npm:evilpkg@latest", refetch: true } } } };
  assert.match(moves([tagged]).join("\n"), /differs, recorded agree/);
  const ranged = { ...listed.c, npm: { ...listed.c.npm, at: { ...listed.c.npm.at, [listed.place]: { kind: "registry", name: "a", version: "^2.0.0", registry: "https://registry.npmjs.org/", spec: "a@^2.0.0", refetch: true } } } };
  assert.match(moves([ranged]).join("\n"), /extra, recorded agree/);
});

test("reference: every Claude Code cell compares as recorded", async () => {
  const rec = cc.readRecord();
  assert.ok(rec.cells.length > 0, "test/reference/claude-code.json holds no cell");
  const lines = cc.moves(cc.compareAll(rec.cells, rec.caseFolds), await openNodes());
  assert.equal(
    lines.join("\n"),
    "",
    `test/reference/claude-code.json: ${lines.length} comparison(s) moved. A reader that reads a settings file, a rule or an instruction or plugin file otherwise than Claude Code does is fixed, or the place lists why ("stricter: …", "extra: …", "differs: …", "gap: <open node>"), in the commit that moves it.`,
  );
});

test("reference: the Claude Code record names its version and holds well-formed cells, each with its reading", () => {
  const rec = cc.readRecord();
  assert.match(String(rec.claudeCode), /^\d+\.\d+\.\d+$/);
  // The disk the readings were taken on: whether it folds case, which the case cells' answers hang on.
  assert.equal(typeof rec.caseFolds, "boolean");
  const ids = rec.cells.map((c) => c.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "an id twice");
  assert.deepEqual(rec.cells.flatMap(cc.cellProblems), []);
  for (const c of rec.cells) {
    assert.ok(c.cc && Array.isArray(c.cc.start), `${c.id}: no reading`);
    // A record holds no cell Claude Code was not measured on: `check` fails on one.
    if (c.call) assert.match(String(c.cc.call), /^(ran|stopped: (ask|deny|other))$/, `${c.id}: the call was not measured`);
  }
  // The record holds what each reader's comparison needs on both sides.
  const seen = new Set(cc.compareAll(rec.cells, rec.caseFolds).flatMap(({ got }) => [...got].map(([k, r]) => `${r.relation} ${k.split(":")[0]} ${r.cc.split(":")[0]}`)));
  for (const want of ["agree call stopped", "agree call ran", "stricter call stopped", "differs call ran", "agree start loaded", "agree after loaded", "agree load loaded", "agree load ran"]) assert.ok(seen.has(want), want);
});

test("reference control: the Claude Code judge finds a reading that moved", () => {
  const rec = cc.readRecord();
  const at = (/** @type {string} */ id) => {
    const c = rec.cells.find((x) => x.id === id);
    assert.ok(c?.cc, id);
    return /** @type {cc.Cell & { cc: cc.CcReading }} */ (c);
  };
  const judged = (/** @type {cc.Cell[]} */ cells, /** @type {Set<string> | undefined} */ open = undefined) => cc.moves(cc.compareAll(cells, rec.caseFolds), open).join("\n");
  // A push Ennyn reads as asked about that Claude Code runs: a hole. A call not measured is never an agreement.
  const plain = at("settings-plain");
  assert.equal(judged([plain]), "");
  assert.match(judged([{ ...plain, cc: { ...plain.cc, call: "ran" } }]), /call: differs, recorded agree — Ennyn asks, Claude Code ran/);
  assert.match(judged([{ ...plain, cc: { ...plain.cc, call: "unmeasured: the run did not end" } }]), /call: unmeasured, recorded agree/);
  // A push Claude Code stops where Ennyn says no rule: stricter, never an agreement.
  const exact = at("rule-exact-args");
  assert.match(judged([{ ...exact, cc: { ...exact.cc, call: "stopped: ask" } }]), /call: stricter, recorded agree/);
  // An instruction file Claude Code loads that Ennyn does not count in every session, and one it counts that Claude Code does not load.
  const all = at("instructions-all");
  assert.equal(judged([all]), "");
  assert.match(judged([{ ...all, cc: { start: [...all.cc.start, "GEMINI.md"] } }]), /start:GEMINI\.md: differs, recorded agree — Ennyn other/);
  assert.match(judged([{ ...all, cc: { start: all.cc.start.filter((p) => p !== "CLAUDE.md") } }]), /start:CLAUDE\.md: extra, recorded agree/);
  // A rule the side-copy hook gives that Claude Code did not load after the Read, and one it loaded that the hook does not give.
  const forms = at("read-path-forms-top");
  assert.match(judged([{ ...forms, cc: { ...forms.cc, after: (forms.cc.after ?? []).filter((p) => p !== ".claude/rules/any-ts.md") } }]), /after:\.claude\/rules\/any-ts\.md: extra, recorded agree/);
  assert.match(judged([{ ...forms, cc: { ...forms.cc, after: [...(forms.cc.after ?? []), ".claude/rules/single-star.md"] } }]), /after:\.claude\/rules\/single-star\.md: differs, recorded agree — Ennyn not given/);
  // Both ways for the files a Read loads with its folders: one Ennyn counts there that Claude Code did not load is
  // extra, an import too (it loads with the file importing it).
  const agents = at("read-nested-agents");
  assert.equal(judged([agents]), "");
  assert.match(judged([{ ...agents, cc: { ...agents.cc, after: (agents.cc.after ?? []).filter((p) => p !== "src/a/AGENTS.md") } }]), /after:src\/a\/AGENTS\.md: extra, recorded agree — Ennyn on-demand/);
  const imports = at("rv-read-nested-imports");
  assert.match(judged([{ ...imports, cc: { ...imports.cc, after: (imports.cc.after ?? []).filter((p) => p !== "sub/d/2.md") } }]), /after:sub\/d\/2\.md: extra, recorded agree/);
  // A spelling doctor's line names nowhere, run by Claude Code under a rule: the line is short of it.
  const env = at("spelling-env");
  assert.match(judged([{ ...env, cc: { ...env.cc, call: "ran" } }]), /call: differs, recorded agree — Ennyn asks, Claude Code ran/);
  // A spelling in a class the line names, stopped: stricter, never an agreement.
  const option = at("spelling-dash-C");
  assert.match(judged([{ ...option, cc: { ...option.cc, call: "stopped: ask" } }]), /call: stricter, recorded agree/);
  // A Read Claude Code did not run loaded nothing to compare: unmeasured, never an agreement.
  assert.match(judged([{ ...forms, cc: { ...forms.cc, call: "unmeasured: no call" } }]), /after: unmeasured, recorded agree/);
  // A plugin file that ran or reached the model but the audit does not list.
  const standard = at("plugin-standard");
  assert.equal(judged([standard]), "");
  assert.match(judged([{ ...standard, cc: { ...standard.cc, ran: [...(standard.cc.ran ?? []), "plug/README.md"] } }]), /load:plug\/README\.md: differs, recorded agree — Ennyn not listed, Claude Code ran/);
  // A listed place with no why, a gap or an extra naming no open node, a place neither has.
  assert.match(judged([{ ...plain, except: { call: "stricter:" } }]), /gives no why/);
  assert.match(judged([{ ...plain, except: { call: "gap: no-such-node" } }], new Set(["other"])), /names no open graph node: no-such-node/);
  assert.match(judged([{ ...plain, except: { "start:nowhere.md": "extra: x (no-such-node)" } }], new Set(["other"])), /names no open graph node: no-such-node/);
  assert.match(judged([{ ...plain, except: { "start:nowhere.md": "extra: x" } }]), /an extra names no graph node/);
  assert.match(judged([{ ...plain, except: { "start:nowhere.md": "extra: x (other)" } }]), /neither Claude Code nor Ennyn has this place/);
  // An accepted difference pins Ennyn's reading there: a move to another wrong value is seen, a pin missing or
  // left where nothing is listed too.
  const pinned = rec.cells.find((c) => c.ennyn && Object.values(c.except ?? {}).some((v) => v.startsWith("gap: ")));
  assert.ok(pinned?.except && pinned.ennyn);
  assert.equal(judged([pinned]), "");
  const [place, value] = /** @type {[string, string]} */ (Object.entries(pinned.ennyn)[0]);
  assert.match(judged([{ ...pinned, ennyn: { ...pinned.ennyn, [place]: `${value} once` } }]), new RegExp(`${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: Ennyn reads "${value}", recorded "${value} once"`));
  const { [place]: _, ...rest } = pinned.ennyn;
  assert.match(judged([{ ...pinned, ennyn: rest }]), /Ennyn's reading is not pinned/);
  assert.match(judged([{ ...pinned, ennyn: { ...pinned.ennyn, "start:elsewhere.md": "none" } }]), /pinned where except lists nothing/);
  // A file written with no marker cannot show whether Claude Code loaded it: no place is compared for it.
  const nomark = at("rv2-agents-unclosed-comment-claude");
  assert.ok(nomark.files["CLAUDE.md"].includes("{{nomark}}"));
  assert.equal([...cc.compareAll([nomark], rec.caseFolds)[0].got.keys()].includes("start:CLAUDE.md"), false);
  assert.equal([...cc.compareAll([{ ...nomark, files: { ...nomark.files, "CLAUDE.md": "<!-- x {{mark}}" } }], rec.caseFolds)[0].got.keys()].includes("start:CLAUDE.md"), true);
  // A case cell is compared only on a disk that folds case as the record's did; elsewhere it is said, and moves nothing.
  const lower = at("rev-agents-lower");
  assert.equal(lower.case, true);
  const elsewhere = cc.compareAll([{ ...lower, cc: { start: [] } }], !rec.caseFolds)[0];
  const here = cc.compareAll([{ ...lower, cc: { start: [] } }], rec.caseFolds)[0];
  const folds = cc.foldsCase(mkdtempSync(join(tmpdir(), "en-ref-case-")));
  assert.equal(Boolean((folds === rec.caseFolds ? elsewhere : here).skipped), true);
  assert.equal(cc.moves([folds === rec.caseFolds ? elsewhere : here]).length, 0);
  assert.deepEqual(cc.RELATIONS, ["agree", "stricter", "extra", "differs", "unmeasured"]);
  // A cell whose paths could leave the recorder's directory, or that a marker cannot spell back whole, is no cell.
  for (const bad of [{ files: { "../x": "" } }, { files: { "/abs/x": "" } }, { files: { "a/./b": "" } }, { files: { "a b": "" } }, { files: { "a\\b": "" } }, { call: { Read: "../x" } }, { cwd: ".." }, { plugin: "/p" }, { call: { Bash: "x", Read: "y" } }, { call: { Bash: 1 } }, { call: { Bash: "git push" } }, { call: { Bash: "toString" } }, { except: { "*": "extra: x (other)" } }, { case: false }, { ennyn: { call: 1 } }]) {
    assert.notDeepEqual(cc.cellProblems({ id: "x", from: "control", files: {}, ...bad }), [], JSON.stringify(bad));
  }
  assert.deepEqual(cc.cellProblems({ id: "x", from: "control", files: { ".claude/rules/a.md": "" }, call: { Read: "src/x.ts" }, cwd: "sub", plugin: "." }), []);
  assert.notDeepEqual(cc.cellProblems({ id: "x", from: "control", files: { "a.json": "{{bytes:4194305}}" } }), []);
  // One marker a file: where `{{mark}}` puts it, else at the end of a Markdown file; none in other files.
  assert.deepEqual(cc.rendered({ id: "x", from: "control", files: { "a.md": "d: {{mark}}", "b.md": "b", "c.json": "{}", "d.json": "{{bytes:3}}" } }, "/d"), { "a.md": "d: MARK:a.md", "b.md": "b\nMARK:b.md\n", "c.json": "{}", "d.json": "aaa" });
});

test("reference: doctor's ask line names as unmatched every spelling Claude Code ran under a rule, and only those", () => {
  const rec = cc.readRecord();
  // The cells of the push spellings, each under Bash(git push *), with its class (cc.SPELLINGS).
  const cells = rec.cells.filter((c) => c.id.startsWith("spelling-"));
  const classOf = (/** @type {cc.Cell} */ c) => cc.SPELLINGS[/** @type {keyof typeof cc.SPELLINGS} */ (/** @type {{ Bash: string }} */ (c.call).Bash)].class;
  assert.ok(cells.length > 30);
  for (const c of cells) assert.equal(c.files[".claude/settings.json"], '{"permissions":{"ask":["Bash(git push *)"]}}', c.id);
  // Every spelling Claude Code ran is in a class the line names; one it stopped in such a class is listed as
  // stricter with why; each class the line names has a spelling Claude Code ran.
  for (const c of cells) {
    if (c.cc?.call === "ran") assert.ok(cc.UNMATCHED.includes(classOf(c)), `${c.id}: Claude Code ${rec.claudeCode} ran it, class ${classOf(c)}`);
    else if (cc.UNMATCHED.includes(classOf(c))) assert.match(String(c.except?.call), /^stricter: /, `${c.id}: stopped, in the class ${classOf(c)} the line names`);
  }
  for (const k of cc.UNMATCHED) assert.ok(cells.some((c) => classOf(c) === k && c.cc?.call === "ran"), `${k}: no spelling of it ran`);
  // Each class the line names, by its words; the items no cell measures, named; the older versions apart.
  /** @type {Record<string, string>} */
  const phrases = { option: "a git option before push", quoted: "a quoted or escaped push", shell: "a command fed to a shell or another program", built: "a command word built as it runs" };
  const unmeasured = ["an alias", "a script that pushes", "gh api", "an MCP tool"];
  const line = t("doctor.askOk", { rules: "x" }, "en");
  const list = line.slice(line.indexOf("not matched: ") + "not matched: ".length);
  // Commas inside parentheses part no items.
  const items = list.split(/, (?![^(]*\))/);
  // A full path and a subshell are named only for the versions that did not match them: the record's stops both.
  assert.equal(items.pop(), "and on older versions a full path (before 2.1.309) or a subshell (2.1.207)");
  for (const id of ["spelling-full-path", "spelling-subshell"]) assert.match(String(rec.cells.find((c) => c.id === id)?.cc?.call), /^stopped/, id);
  const named = items.filter((i) => !unmeasured.includes(i)).map((i) => Object.keys(phrases).find((k) => i.startsWith(phrases[k])) ?? `none: ${i}`);
  assert.deepEqual(named.sort(), [...cc.UNMATCHED].sort(), "the line's classes, against the classes the record measures as unmatched");
  assert.deepEqual(items.filter((i) => unmeasured.includes(i)), unmeasured);
  // The Turkish line names the same.
  const tr = t("doctor.askOk", { rules: "x" }, "tr");
  for (const text of ["push'tan önce bir git seçeneği", "tırnaklı ya da kaçışlı bir push", "bir kabuğa ya da başka bir programa verilen komut", "çalışırken kurulan bir komut sözcüğü", "eski sürümlerde tam yol (2.1.309'dan önce) ya da alt kabuk (2.1.207)"]) assert.ok(tr.includes(text), `tr: ${text}`);
});

test("reference control: a cell runs no command of its own and reaches nothing outside it: the recorder refuses each way the review found", () => {
  const base = { from: "review", files: { "x.txt": "x" } };
  /** @type {Record<string, object>} */
  const probes = {
    "rec-call-any-command": { call: { Bash: "env > /tmp/x; id -un" } },
    "rec-settings-hook-command": { files: { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/x" }] }] } }) } },
    "rec-settings-http-hook": { files: { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/x" }] }] } }) } },
    "rec-api-key-helper": { files: { ".claude/settings.json": JSON.stringify({ apiKeyHelper: "touch /tmp/x; echo k" }) } },
    "rec-status-line": { files: { ".claude/settings.json": JSON.stringify({ statusLine: { type: "command", command: "touch /tmp/x" } }) } },
    "rec-project-mcp-file": { files: { ".mcp.json": JSON.stringify({ mcpServers: { m: { command: "sh", args: ["-c", "{{ran}}"] } } }) } },
    "rec-settings-other-key": { files: { ".claude/settings.json": JSON.stringify({ includeCoAuthoredBy: false }) } },
    "rec-project-mcp": { files: { ".claude/settings.json": JSON.stringify({ enableAllProjectMcpServers: true }), ".mcp.json": JSON.stringify({ mcpServers: { m: { command: "sh", args: ["-c", "{{ran}}"] } } }) } },
    "rec-settings-base-url": { files: { ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }) } },
    "rec-settings-proxy": { files: { ".claude/settings.json": JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:1" } }) } },
    "rec-settings-loose": { files: { ".claude/settings.json": "// x\n{\"apiKeyHelper\": \"touch /tmp/x\"}" } },
    "rec-git-hook": { files: { ".git/hooks/pre-commit": "#!/bin/sh\ntouch /tmp/x\n", "x.txt": "x" } },
    "rec-git-fsmonitor": { files: { ".git/config": "[core]\n\tfsmonitor = touch /tmp/x\n" } },
    "rec-git-case": { files: { ".GIT/config": "[core]\n\tfsmonitor = touch /tmp/x\n" } },
    "rec-bytes-many": { files: { "a.txt": "{{bytes:4194304}}", "b.txt": "{{bytes:4194304}}", "c.txt": "{{bytes:1}}" } },
    "rec-bytes-file": { files: { "a.txt": "{{bytes:4194304}}{{bytes:1}}" } },
    "rec-plugin-hook": { plugin: "p", files: { "p/.claude-plugin/plugin.json": "{}", "p/hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/x" }] }] } }) } },
    "rec-plugin-mcp-env": { plugin: "p", files: { "p/.mcp.json": JSON.stringify({ mcpServers: { m: { command: "sh", args: ["-c", "{{ran}}"], env: { BASH_ENV: "/tmp/x" } } } }) } },
    "rec-plugin-bin": { plugin: "p", files: { "p/bin/git": "#!/bin/sh\ntouch /tmp/x\n" } },
    "rec-plugin-dependency": { plugin: "p", files: { "p/.claude-plugin/plugin.json": JSON.stringify({ name: "p", dependencies: ["x@y"] }) } },
    "rec-plugin-path-out": { plugin: "p", files: { "p/.claude-plugin/plugin.json": JSON.stringify({ name: "p", hooks: "../../x.json" }) } },
    "rec-skill-bang": { files: { "CLAUDE.md": "run !`touch /tmp/x`" } },
    "rec-import-home": { files: { "CLAUDE.md": "@~/.ssh/id_rsa" } },
    "rec-import-absolute": { files: { "CLAUDE.md": "@/etc/hosts" } },
    "rec-project-skill": { files: { ".claude/skills/s/SKILL.md": "---\nname: s\n---\nx" } },
  };
  for (const [id, probe] of Object.entries(probes)) assert.notDeepEqual(cc.cellProblems({ id, ...base, ...probe }), [], id);
  // What the record's cells hold stays allowed: the run marker, sh running it, a script that is only it, EN_PROBE_ names.
  assert.deepEqual(cc.cellProblems({ id: "ok", from: "control", plugin: "p", call: { Bash: "push" }, files: {
    ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push *)"] }, env: { EN_PROBE_A: 5 }, en_probe_pad: "{{bytes:2097162}}", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "{{ran}}" }] }] } }),
    "p/.claude-plugin/plugin.json": JSON.stringify({ name: "p", version: "1", hooks: "./conf/h.json", skills: ["./custom/skills/"] }),
    "p/conf/h.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "{{ran}}" }] }] } }),
    "p/.mcp.json": JSON.stringify({ mcpServers: { m: { command: "sh", args: ["-c", "{{ran}}"] } } }),
    "p/bin/en-probe-bin": "#!/bin/sh\n{{ran}}\n",
    ".claude/rules/r.md": "---\npaths: [\"src/**\"]\n---\nr",
  } }), []);
  // Every cell of the record passes the same refusals.
  assert.deepEqual(cc.readRecord().cells.flatMap(cc.cellProblems), []);
  // The recorder's own git: nothing of the parent's environment but PATH, its hooks and monitor off.
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", SSH_AUTH_SOCK: "/agent", EN_SECRET: "canary" });
  try {
    const { env, args } = cc.gitEnv("/cell");
    assert.deepEqual(Object.keys(env).filter((k) => !["PATH", "HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TEMPLATE_DIR"].includes(k) && !/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/.test(k)), []);
    assert.equal(env.HOME, join("/cell", "home"));
    assert.deepEqual(args, ["-c", `core.hooksPath=${join("/cell", "hooks")}`, "-c", "core.fsmonitor=false"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
  // Another version of Claude Code: the message names the record's and how to point at a binary.
  assert.match(cc.otherVersion("2.1.310", "claude", "2.1.207"), /record is Claude Code 2\.1\.310, claude is 2\.1\.207: point at a 2\.1\.310 binary \(npm run test:reference -- --claude <path>/);
});
