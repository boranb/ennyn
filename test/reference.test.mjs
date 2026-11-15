/**
 * Reference differentials: a check that models another program's reading is replayed against that program's
 * recorded answers (test/reference/). The deps gate's reading of npm's lock and source spellings is compared,
 * place by place, with what npm 10 itself does with each cell (test/reference/npm.mjs records it); Ennyn's
 * readings of what Claude Code reads (the ask rules, the instruction files a session loads, the rules a path
 * loads, a plugin's files) with what Claude Code itself did with each cell (test/reference/claude-code.mjs). A
 * comparison that moved from the one the cell lists fails here. The records never ask the machine: each
 * recorder's `check` does, and fails when the machine's program reads a cell otherwise or is another version.
 * Ennyn's Markdown readings (code blocks, headings, imports) are compared with the parser Claude Code reads
 * instruction files with, and the steps around it (test/reference/markdown.mjs).
 * git's readings are replayed against git itself (test/git-oracle.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadConfig } from "../core/config.mjs";
import { t } from "../core/i18n.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { RECORD, RELATIONS, cellProblems, compare, moves, readRecord, unmeasuredOf } from "./reference/npm.mjs";
import * as cc from "./reference/claude-code.mjs";
import * as precompact from "./reference/precompact.mjs";
import * as pretooluse from "./reference/pretooluse.mjs";
import * as md from "./reference/markdown.mjs";
import * as ay from "./reference/actions-yaml.mjs";
import { MIN_RULE, ruleKey, ruleLines } from "../setup/budget.mjs";
import { banLiterals, outsideFenceLines } from "../setup/scan.mjs";
import { noBypassBlock } from "../setup/secret-setup.mjs";

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
  for (const want of ["agree listed remote", "agree listed registry", "agree inside file", "agree inside directory", "agree inside link", "agree refused git", "agree said bundled", "agree sourced git", "unread refused remote", "unread refused registry", "extra listed -", "unmeasured listed -", "unmeasured listed remote", "agree spec remote", "stricter spec remote"]) assert.ok(seen.has(want), want);
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

test("reference: the PreCompact record holds what the compaction hook stands on", () => {
  const { claudeCode, cells } = precompact.readRecord();
  assert.match(claudeCode, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(cells), Object.keys(precompact.CELLS));
  const holds = { ended: "completed", isError: false, summaries: 0, compacted: false };
  /** @param {string} id @param {object} want */
  const is = (id, want) => assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, cells[id][k]])), want, id);
  // stdin: no agent field, no tokens, no model. A plain stdout goes to the summary request and nowhere else.
  assert.deepEqual(cells["stdout-joins-the-summary"].input, ["custom_instructions", "cwd", "hook_event_name", "prompt_id", "session_id", "transcript_path", "trigger"]);
  is("stdout-joins-the-summary", { trigger: "auto", summaries: 1, marked: ["summary"], compacted: true, unansweredAtHook: false, promptIsTheTurns: true });
  // What holds, and what ending a block can come to. Past the hard limit no request goes out and the turn ends.
  is("exit-2-holds-and-the-turn-goes-on", holds);
  is("stdout-json-is-a-verdict", holds);
  is("block-under-the-hard-limit-at-1m", holds);
  is("exit-2-is-asked-again-every-turn", { ...holds, hookRuns: 5 });
  is("block-past-the-hard-limit-at-1m", { ended: "blocking_limit", isError: true, summaries: 0, failure: { model: "<synthetic>", error: "invalid_request", text: "Prompt is too long" } });
  is("block-on-a-413", { ended: "prompt_too_long", isError: true, unansweredAtHook: true });
  is("pass-on-a-413", { ended: "completed", isError: false, compacted: true, unansweredAtHook: true });
  // A hook that fails or is killed lets the compaction through.
  is("exit-1-lets-it-through", { summaries: 1, compacted: true });
  is("timeout-lets-it-through", { summaries: 1, compacted: true });
  // A subagent's compaction: the same input, the main transcript. The stream's boundary line races the end of the
  // run, so the cell does not hold it.
  is("a-subagent-compacts", { input: cells["stdout-joins-the-summary"].input, mainTranscriptNamed: true, summaries: 1, marked: ["summary"] });
  assert.equal("compacted" in cells["a-subagent-compacts"], false);
  // The fields tailFacts reads off a reply.
  assert.deepEqual(cells["stdout-joins-the-summary"].replyShape, { usage: ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens"], model: "string", timestamp: "string", sidechain: false });
});

test("reference: the PreToolUse record holds what the push hook stands on", () => {
  const { claudeCode, cells } = pretooluse.readRecord();
  assert.match(claudeCode, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(cells), Object.keys(pretooluse.CELLS));
  /** @param {string} id @param {object} want */
  const is = (id, want) => assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, cells[id][k]])), want, id);
  const stopped = { ended: "success", calls: ["hook"], reached: false };
  const ran = { ended: "success", calls: ["ran"], reached: true };
  // The claim the hook stands on: a deny holds in bypassPermissions, over an allow rule, from an installed plugin and a subagent.
  for (const id of ["deny-stops-the-call", "deny-holds-over-an-allow-rule", "deny-holds-with-the-skip-flag", "deny-holds-from-an-installed-plugin", "deny-holds-in-a-subagent", "exit-2-stops-the-call", "a-printed-deny-holds-over-exit-1"]) is(id, stopped);
  // A silent hook is the control; every way a hook can fail to answer runs the call: the fault direction rests on this.
  for (const id of ["a-silent-hook-lets-it-run", "a-subagent-runs-past-a-silent-hook", "exit-1-runs-the-call", "a-crash-runs-the-call", "a-missing-script-runs-the-call", "a-killed-hook-runs-the-call", "a-timeout-runs-the-call", "output-no-json-runs-the-call", "a-bad-decision-runs-the-call"]) is(id, ran);
  is("deny-holds-in-a-subagent", { agentId: "string", mode: "bypassPermissions" });
  // The input the hook reads, on each tool.
  for (const id of ["a-silent-hook-lets-it-run", "monitor-stopped-by-a-hook-that-names-it", "powershell-reaches-a-hook-that-names-it"]) assert.ok(cells[id].toolInput.includes("command") && cells[id].input.includes("tool_input"), id);
  is("powershell-reaches-a-hook-that-names-it", { tool: "PowerShell", hookRuns: 1 });
  // No command, no hook: what reaches the hook in a shape it cannot read is a change of Claude Code's.
  is("a-call-with-no-command-reaches-no-hook", { calls: ["invalid"], hookRuns: 0 });
  // A systemMessage reaches the session, not the model.
  is("a-message-reaches-the-session-not-the-model", { stream: { type: "system", subtype: "informational", content: "PreToolUse:Bash says: EN-PRETOOLUSE", level: "notice" }, model: false, calls: ["ran"] });
  // Monitor shares Bash's rule and not its matcher.
  is("monitor-runs-past-a-bash-matcher", { ...ran, hookRuns: 0 });
  is("monitor-stopped-by-a-hook-that-names-it", { ...stopped, tool: "Monitor", hookRuns: 1 });
  is("monitor-asks-under-a-bash-rule", { calls: ["rule"], reached: false, hookRuns: 1 });
  is("the-settings-env-reaches-the-hook", { envSeen: true });
  // The real hook, in bypassPermissions: a spelling refused, on Monitor too, a plain command run, a plain push left to the
  // rule, in a compound too, a config name nothing holds changing nothing; a push written as the refusal says is asked about,
  // the folder it advises in one call among them, from a subagent too; with no config the hook does nothing.
  is("the-hook-refuses-a-spelling", stopped);
  is("the-hook-refuses-in-monitor", stopped);
  is("the-hook-passes-a-plain-command", { calls: ["ran"], reached: false });
  is("the-hook-leaves-a-plain-push-to-the-rule", { calls: ["rule"], reached: false });
  for (const id of ["the-hook-leaves-a-push-in-a-compound", "the-hook-leaves-a-commit-then-a-push-and-a-pipe", "the-hook-leaves-the-folder-it-advises", "the-hook-leaves-the-folder-it-advises-in-a-subagent", "the-rule-in-the-local-file-asks-the-same"]) is(id, { calls: ["rule"], reached: false });
  is("a-config-name-nothing-holds-does-not-switch-it-off", stopped);
  is("refused-then-written-plain-is-asked", { calls: ["hook", "rule"], reached: false });
  is("the-hook-ends-at-once-with-no-config", ran);
  // Why only some compounds are left: the rule reads one only if Claude Code's parser finishes. At 10,001 characters, on a
  // body line that starts with the here-document's delimiter and holds a `)`, at 14 levels of substitutions, it gives up, and
  // a push later in the text runs unasked, past the rule and in bypassPermissions. Each has its control: one character
  // less, the same words in a quoted message, one level less, the push first. No hook but a silent one: a `check` rereads
  // this on each Claude Code version.
  is("the-rule-reads-a-compound-of-10000-characters", { calls: ["rule"], reached: false });
  is("the-rule-does-not-read-a-compound-of-10001", ran);
  is("the-rule-asks-about-a-sole-push-of-10001", { calls: ["rule"], reached: false });
  is("the-rule-reads-a-commit-with-those-words-in-a-quoted-message", { calls: ["rule"], reached: false });
  is("the-rule-does-not-read-past-a-commit-body", ran);
  is("the-rule-does-not-read-past-a-body-in-a-substitution", ran);
  is("the-rule-reads-past-13-substitutions", { calls: ["rule"], reached: false });
  is("the-rule-does-not-read-past-14-substitutions", ran);
  // Text of no hostile kind. After a redirect a comment holding an apostrophe ends what the rule reads, the parser finished,
  // and twelve short substitutions spend the parser's budget; each with its control, under another rule too.
  is("the-rule-does-not-read-past-a-comment-after-a-redirect", ran);
  is("the-rule-reads-past-that-comment-with-no-apostrophe", { calls: ["rule"], reached: false });
  is("the-rule-does-not-read-past-repeated-substitutions", ran);
  is("the-rule-reads-past-three-repeated-substitutions", { calls: ["rule"], reached: false });
  is("the-publish-rule-does-not-read-past-that-comment", ran);
  is("the-publish-rule-reads-past-a-comment-with-no-apostrophe", { calls: ["rule"], reached: false });
  // The hook refuses those two, and leaves what holds nothing to misread, at its longest too.
  for (const id of ["the-hook-refuses-a-push-after-a-comment", "the-hook-refuses-a-push-after-repeated-substitutions"]) is(id, stopped);
  for (const id of ["the-hook-leaves-lines-of-plain-words-to-the-rule", "the-hook-leaves-a-compound-of-8999-characters-to-the-rule"]) is(id, { calls: ["rule"], reached: false });
  // The reader sees no push in these two. Claude Code's own checks hold them, and an update that stops is seen here.
  for (const id of ["claude-code-holds-a-brace-zsh-counts", "claude-code-holds-a-numeric-glob-before-a-hash"]) is(id, { calls: ["rule"], reached: false });
  is("a-push-first-is-read-past-14-substitutions", { calls: ["rule"], reached: false });
  // The hook refuses those.
  is("the-hook-refuses-a-compound-the-rule-cannot-read", stopped);
  is("the-hook-refuses-what-the-rule-cannot-read", stopped);
});

test("reference: the gap the compaction hook waits for is the earliest idle compaction in the record", () => {
  const { idle } = precompact.readRecord();
  assert.deepEqual(idle, { minTokens: 200000, tokensFloor: 100000, fraction: 0.9, fractionFloor: 0.5, fractionTop: 0.95, hourMs: 3600000 });
  assert.deepEqual(precompact.idleMoved(idle), []);
  assert.equal(precompact.idleMoved({ ...idle, fractionFloor: 0.4 }).length, 1, "a lower floor is seen");
  assert.equal(precompact.idleMoved({ ...idle, hourMs: 300000 }).length, 1, "a shorter cache is seen");
});

test("reference: the model table is compared both ways", () => {
  const ours = new Map([["a", 200000], ["b", 1000000], ["c", 200000]]);
  assert.deepEqual(precompact.windowsMoved(ours, new Map(ours)), []);
  assert.deepEqual(precompact.windowsMoved(ours, new Map([["a", 1000000], ["b", 1000000], ["d", 200000]])), ["a: MODEL_WINDOWS says 200000, the binary 1000000", "c: MODEL_WINDOWS says 200000, the binary nothing", "d: MODEL_WINDOWS says nothing, the binary 200000"]);
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

test("reference: the no-bypass block /ennyn:init writes is the one Claude Code kept the project's settings with, ask rules applied", () => {
  // A value Claude Code rejects makes it skip the file whole (the settings-bypass-*, settings-sandbox-* and
  // settings-credentials-* cells): the block init writes is held to the recorded one, in either file.
  const rec = cc.readRecord();
  const block = noBypassBlock({ worktrees: "~/en-probe-worktrees", hosts: ["registry.npmjs.org"], vars: ["EN_PROBE_TOKEN"] });
  const shared = rec.cells.find((c) => c.id === "settings-no-bypass-block");
  const local = rec.cells.find((c) => c.id === "settings-no-bypass-block-local");
  assert.deepEqual(JSON.parse(String(shared?.files[".claude/settings.json"])), { ...block, permissions: { ...block.permissions, ask: ["Bash(git push *)"] } });
  assert.deepEqual(JSON.parse(String(local?.files[".claude/settings.local.json"])), block);
  for (const c of [shared, local]) assert.equal(c?.cc?.call, "stopped: ask", c?.id);
  // What the block keeps out, against controls with no settings: a Read outside the project, under bypassPermissions,
  // with no mode flag and with --dangerously-skip-permissions; ~/.ssh, ~/.aws and a denied variable from a sandboxed command.
  const cell = (/** @type {string} */ id) => rec.cells.find((c) => c.id === id)?.cc;
  assert.deepEqual([cell("read-outside-control")?.call, cell("read-outside-control")?.seen], ["ran", ["home:outside.txt"]]);
  for (const id of ["block-outside", "block-outside-no-mode-flag", "block-outside-skip-permissions"]) assert.deepEqual([cell(id)?.call, cell(id)?.seen], ["stopped: ask", []], id);
  assert.deepEqual(cell("secret-read-control")?.seen, ["env:EN_PROBE_TOKEN", "home:.aws/credentials", "home:.ssh/id_x"]);
  for (const id of ["block-leak", "block-leak-no-mode-flag"]) assert.deepEqual([cell(id)?.call, cell(id)?.seen], ["ran", []], id);
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
  for (const bad of [{ files: { "../x": "" } }, { files: { "/abs/x": "" } }, { files: { "a/./b": "" } }, { files: { "a b": "" } }, { files: { "a\\b": "" } }, { call: { Read: "../x" } }, { cwd: ".." }, { plugin: "/p" }, { worktree: "x" }, { agent: "foreground" }, { agent: "other", call: { Bash: "push" } }, { agent: "background", call: { Read: "x.txt" } }, { call: { Bash: "x", Read: "y" } }, { call: { Bash: 1 } }, { call: { Bash: "git push" } }, { call: { Bash: "toString" } }, { except: { "*": "extra: x (other)" } }, { case: false }, { ennyn: { call: 1 } }]) {
    assert.notDeepEqual(cc.cellProblems({ id: "x", from: "control", files: {}, ...bad }), [], JSON.stringify(bad));
  }
  assert.deepEqual(cc.cellProblems({ id: "x", from: "control", files: { ".claude/rules/a.md": "" }, call: { Read: "src/x.ts" }, cwd: "sub", plugin: "." }), []);
  assert.deepEqual(cc.cellProblems({ id: "x", from: "control", files: {}, call: { Bash: "push" }, worktree: true, agent: "background" }), []);
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
  const unmeasured = ["an alias", "a script that pushes", "gh api with no method or one written otherwise (-f, -XPOST, -iX POST, --method=POST, -X post, -X \"POST\")", "an MCP tool"];
  const line = t("doctor.askOk", { rules: "x" }, "en");
  const list = line.slice(line.indexOf("not matched: ") + "not matched: ".length);
  // What the rule does not read, as the record holds it, and what the hook takes off the list: a line apart, so the list stays the rule's.
  const hook = t("doctor.pushHook", {}, "en");
  assert.match(hook, /^push hook: an ask rule reads a compound command only if Claude Code's parser finishes; when it gives up, on length, nodes, a deadline, a stack, a budget spent over the text or a here-document case, a command later in the text runs unasked in bypassPermissions, a push among them, and a comment holding an apostrophe after a redirect does the same\. In a plugin session/);
  assert.match(hook, /\. In a plugin session a hook refuses every push but a plain git push with literal words at the head of a top-level command, .* an alias in a config file, a script that pushes, an interpreter, gh api and an MCP tool, and it is no boundary\b/);
  assert.doesNotMatch(hook, /10,000/, "the length is one way the parser gives up");
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
  for (const text of ["yalnız Claude Code'un ayrıştırıcısı işini bitirirse okur", "üst düzey bir komutun başındaki düz sözcüklü git push dışında her push'u reddeder"]) assert.ok(t("doctor.pushHook", {}, "tr").includes(text), text);
});

test("reference: what the ask rules' reports claim rests on Claude Code's recorded run", () => {
  const rec = cc.readRecord();
  const call = (/** @type {string} */ id) => {
    const c = rec.cells.find((x) => x.id === id);
    assert.ok(c, id);
    return String(c.cc?.call);
  };
  const stops = (/** @type {string[]} */ ...ids) => ids.forEach((id) => assert.match(call(id), /^stopped/, id));
  const runs = (/** @type {string[]} */ ...ids) => ids.forEach((id) => assert.equal(call(id), "ran", id));
  // A rule on the command stops it at the top and after a cd into a worktree alike, and in a subagent, which is why
  // the list is offered: the same call with no rule runs. No rule stops the one and passes the other.
  stops("ask-worktree-top", "ask-worktree-cd", "ask-worktree-subagent-foreground", "ask-worktree-subagent-background");
  runs("ask-worktree-control", "ask-worktree-subagent-control");
  stops("ask-worktree-exact-top", "ask-worktree-exact-cd", "ask-worktree-allow-narrow");
  // A rule reads text, not a place: one option gets past it, and a rule naming a path or a compound holds that text alone.
  runs("ask-worktree-dash-C", "ask-worktree-dash-C-top");
  stops("ask-worktree-path-rule-text", "ask-worktree-compound-rule");
  runs("ask-worktree-path-rule-same-place", "ask-worktree-compound-semi", "ask-worktree-compound-slash", "ask-worktree-compound-top");
  // gh api: the proposed form stops a write method anywhere, and a search for a word; the forms it replaced miss the
  // real spelling. It reads text, so a read whose text holds `-X POST` stops too, a grep after a pipe among them.
  stops("ask-gh-end", "ask-gh-first", "ask-gh-middle", "ask-gh-word-end", "ask-gh-repo-delete", "ask-gh-gist-create");
  runs("ask-gh-search", "ask-gh-read", "ask-gh-form-spaced", "ask-gh-form-first", "ask-gh-form-colon", "ask-gh-form-space-end");
  stops("ask-gh-glob-stops-search", "ask-gh-search-phrase", "ask-gh-grep-after", "ask-gh-repo-create-push");
  // A `:*` after a wildcard stops nothing: doctor must not read one as held.
  runs("ask-colon-after-flag", "ask-colon-after-method", "ask-colon-checkout");
  // The limits doctor's line and gates.md name.
  runs("ask-gh-glued", "ask-gh-equals", "ask-gh-lower", "ask-gh-field", "ask-gh-group", "ask-gh-quoted", "ask-pipe-sh-s", "ask-npm-global-after");
  // The offered spellings, and what each plain form would miss.
  stops("ask-reset-hard", "ask-reset-hard-rev", "ask-reset-rev-hard", "ask-checkout-dashes", "ask-checkout-rev", "ask-compose-v", "ask-compose-volumes", "ask-npx-rule", "ask-npm-global", "ask-pipe-sh", "ask-pipe-bash");
  runs("ask-reset-soft", "ask-checkout-new", "ask-compose-plain", "ask-sh-c-plain", "ask-reset-plain-rule", "ask-checkout-plain-rule", "ask-npx-plain-rule");
  // What the review measured as closing a spelling, and what each leaves alone. A rule on a shell stops a pipe; with no rule it runs.
  stops("ask-offered-sh-s", "ask-offered-bash-s", "ask-offered-npm-after", "ask-offered-npm-global", "ask-offered-npm-global-after", "ask-offered-pnpm-after", "ask-offered-pnpm-global", "ask-offered-compose-v1", "ask-offered-checkout-dot", "ask-offered-branch-d-f");
  runs("ask-pipe-control", "ask-offered-npm-local", "ask-offered-npm-dev", "ask-offered-pnpm-local", "ask-offered-compose-v1-plain", "ask-offered-checkout-dotfile", "ask-offered-branch-d", "ask-offered-bash-script");
  // The script the rule leaves alone is the recorder's, and it ran: the run shows more than a call no rule stopped.
  assert.deepEqual(rec.cells.find((c) => c.id === "ask-offered-bash-script")?.cc?.ran, ["x.txt"]);
  // What gates.md's report says of harmless commands: a word that holds the flag, and a pipe, which is read as one text.
  stops("ask-offered-compose-service", "ask-offered-compose-pipe", "ask-offered-npm-global-style");
  // Leaving a quoted method open is a decision: a rule that holds the quotes stops it, and none of these reads `"-X" POST`.
  stops("ask-gh-quoted-rule");
  runs("ask-gh-quoted-flag");
  // A subagent's call is the subagent's: the run says so, in both modes, and each has a control with no rule.
  for (const id of ["ask-worktree-subagent-foreground", "ask-worktree-subagent-background", "ask-worktree-subagent-control", "ask-worktree-subagent-foreground-control"]) assert.equal(rec.cells.find((c) => c.id === id)?.cc?.by, "subagent", id);
  runs("ask-worktree-subagent-foreground-control");
  // A cell that ran a program reaching outside ran the stand-in, and a spelling of a program outside names one.
  for (const c of rec.cells) {
    const spelling = c.call && "Bash" in c.call ? cc.SPELLINGS[c.call.Bash] : undefined;
    const program = spelling && cc.STUBBED.find((p) => new RegExp(`(^|[;&|] *)${p} `).test(spelling.command));
    if (program && c.cc?.call === "ran") assert.deepEqual(c.cc.ran, [program], c.id);
  }
  for (const [name, s] of Object.entries(cc.SPELLINGS)) {
    if (name === "plugin-bin" || !(s.about || s.class === "none")) continue;
    // `cat` reads the cell's own home only (secret-read).
    for (const part of s.command.split(/&&|\||;/)) assert.ok(["git", "cd", "echo", "grep", "sh", "bash", "cat", ...cc.STUBBED].includes(part.trim().split(" ")[0]), `${name}: ${part}`);
  }
});

test("reference control: a cell runs no command of its own and reaches nothing outside it: the recorder refuses each way the review found", async () => {
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
    // A folder git takes for a repository, with no .git in any path: its config runs a command in any spelling that reads the index.
    "rec-embedded-bare": { cwd: "sub", call: { Bash: "clean-top" }, files: { "sub/HEAD": "ref: refs/heads/main\n", "sub/config": "[core]\n\tfsmonitor = touch /tmp/x\n", "sub/objects/k": "k", "sub/refs/k": "k" } },
    "rec-embedded-bare-case": { cwd: "sub", call: { Bash: "reset-hard" }, files: { "sub/head": "ref: refs/heads/main\n", "sub/config": "[core]\n\tfsmonitor = touch /tmp/x\n", "sub/objects/k": "k", "sub/refs/k": "k" } },
    "rec-embedded-commondir": { cwd: "sub", call: { Bash: "clean-top" }, files: { "sub/HEAD": "ref: refs/heads/main\n", "sub/commondir": "../x\n", "x/config": "[core]\n\tfsmonitor = touch /tmp/x\n", "x/objects/k": "k", "x/refs/k": "k" } },
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
    // The file a spelling hands to a shell is the recorder's: bash reads it from the call's folder, a disk that folds case opens it in any case.
    "rec-run-own-file": { call: { Bash: "bash-script" }, files: { "x.txt": "touch /tmp/x\n" } },
    "rec-run-own-file-case": { call: { Bash: "bash-script" }, files: { "X.TXT": "touch /tmp/x\n" } },
    "rec-run-own-file-below": { cwd: "sub", call: { Bash: "bash-script" }, files: { "sub/x.txt": "touch /tmp/x\n" } },
    // A plugin's bin/ in another case is the same folder on such a disk, and on PATH.
    "rec-plugin-bin-case": { plugin: "p", call: { Bash: "plugin-bin" }, files: { "p/BIN/en-probe-bin": "{{nomark}}#!/bin/sh\ntouch /tmp/x\n" } },
    // A cell's home is data only: a .gitconfig's filter runs on the recorder's git add, a .zshrc in Claude Code's shell.
    "rec-home-gitconfig-filter": { files: { ".gitattributes": "*.txt filter=en\n", "x.txt": "x\n" }, home: { ".gitconfig": "[filter \"en\"]\n\tclean = touch /tmp/x && cat\n" } },
    "rec-home-zshrc": { call: { Bash: "secret-read" }, home: { ".zshrc": "touch /tmp/x\n" } },
    "rec-home-zshenv": { home: { ".zshenv": "touch /tmp/x\n" } },
    "rec-home-ssh-config": { home: { ".ssh/config": "Host *\n\tProxyCommand touch /tmp/x\n" } },
    "rec-home-aws-config": { home: { ".aws/config": "[default]\ncredential_process = touch /tmp/x\n" } },
  };
  for (const [id, probe] of Object.entries(probes)) assert.notDeepEqual(cc.cellProblems({ id, ...base, ...probe }), [], id);
  // The refusal is of the file a call runs: that spelling with no such file passes, and so does the name under a spelling that runs nothing.
  assert.deepEqual(cc.cellProblems({ id: "ok", from: "control", call: { Bash: "bash-script" }, files: {} }), []);
  assert.deepEqual(cc.cellProblems({ id: "ok", from: "control", call: { Bash: "push" }, files: { "x.txt": "touch /tmp/x\n" } }), []);
  // Every spelling that hands a shell a file names it in `runs`, so that a new one cannot pass the refusal above unread.
  const handsAFile = (/** @type {string} */ command) => /(^|[;&|(] *)(\S*\/)?((ba|da|k|z)?sh|source|\.) +[^-<\s]/.test(command);
  for (const command of ["sh y.sh", "true && /bin/bash y", "x | zsh y", ". ./y", "cd z; source y"]) assert.ok(handsAFile(command), command);
  for (const command of ["sh -c true", "echo x | sh", "echo x | bash -s -- -y", 'sh <<< "x"', "cd . && git push"]) assert.ok(!handsAFile(command), command);
  const names = (/** @type {(s: { command: string, runs?: string }) => boolean} */ pick) => Object.entries(cc.SPELLINGS).filter(([, s]) => pick(s)).map(([name]) => name);
  assert.deepEqual(names((s) => s.runs !== undefined), names((s) => handsAFile(s.command)));
  // Only the marker script is written runnable: a placeholder before `#!` leaves a file no PATH lookup runs, in any folder.
  const modes = mkdtempSync(join(tmpdir(), "en-ref-modes-"));
  cc.writeCell({ id: "x", from: "control", files: { "p/bin/en-probe-bin": "#!/bin/sh\n{{ran}}\n", "a.txt": "{{nomark}}#!/bin/sh\ntouch /tmp/x\n", "b.txt": "{{bytes:0}}#!/bin/sh\ntouch /tmp/x\n" } }, modes);
  assert.deepEqual(["p/bin/en-probe-bin", "a.txt", "b.txt"].map((f) => statSync(join(modes, f)).mode & 0o100), [0o100, 0, 0]);
  // The recorder stops at such a cell before anything runs, and writes the file a spelling runs itself: the run marker.
  const own = { id: "own", from: "control", call: { Bash: "bash-script" }, files: { "x.txt": "touch /tmp/x\n" } };
  await assert.rejects(cc.ccReading(own, "unused"), /the recorder writes it/);
  const run = mkdtempSync(join(tmpdir(), "en-ref-run-"));
  cc.writeCell({ ...own, files: {} }, run);
  assert.equal(readFileSync(join(run, "x.txt"), "utf8"), `echo x.txt >> ${run}/.ran\n`);
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
    assert.equal(env.GIT_CONFIG_GLOBAL, devNull, "no config from the cell's home");
    assert.equal(env.HOME, join("/cell", "home"));
    assert.deepEqual(args, ["-c", `core.hooksPath=${join("/cell", "hooks")}`, "-c", "core.fsmonitor=false"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
  // The recorder's git steps on a cell whose home names a filter: the filter never runs. With the home's file read as
  // the global config, it does: the probe reaches.
  const filtered = (/** @type {boolean} */ global) => {
    const R = realpathSync(mkdtempSync(join(tmpdir(), "en-ref-home-")));
    const P = join(R, "p");
    mkdirSync(join(R, "home"), { recursive: true });
    mkdirSync(join(R, "hooks"));
    mkdirSync(P);
    const marker = join(R, "ran");
    writeFileSync(join(R, "home", ".gitconfig"), `[filter "en"]\n\tclean = touch '${marker}' && cat\n`);
    writeFileSync(join(P, ".gitattributes"), "*.txt filter=en\n");
    writeFileSync(join(P, "x.txt"), "x\n");
    const { env, args } = cc.gitEnv(R);
    // XDG_CONFIG_HOME, TZ, LC_ALL and the ceiling for test/hermetic.mjs; git reads no XDG config while GIT_CONFIG_GLOBAL is set.
    const git = { ...env, XDG_CONFIG_HOME: join(R, "xdg"), TZ: "UTC", LC_ALL: "C", GIT_CEILING_DIRECTORIES: R, ...(global ? { GIT_CONFIG_GLOBAL: join(R, "home", ".gitconfig") } : {}) };
    for (const step of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "cell", "--no-verify"]]) assert.equal(spawnSync("git", [...args, ...step], { cwd: P, env: git }).status, 0, step.join(" "));
    return existsSync(marker);
  };
  assert.equal(filtered(false), false, "a filter in the cell's home ran");
  assert.equal(filtered(true), true, "the control: a filter read as global config runs");
  // Another version of Claude Code: the message names the record's and how to point at a binary.
  assert.match(cc.otherVersion("2.1.310", "claude", "2.1.207"), /record is Claude Code 2\.1\.310, claude is 2\.1\.207: point at a 2\.1\.310 binary \(npm run test:reference -- --claude <path>/);
});


/** The extensions the Markdown judge's controls read an import of. */
const EXT = [".md", ".txt"];

test("reference: every Markdown cell compares as recorded", async () => {
  const rec = md.readRecord();
  assert.ok(rec.cells.length > 0, "test/reference/markdown.json holds no cell");
  const lines = md.moves(md.compareAll(rec.cells, rec.claudeCode.textExtensions), await openNodes());
  assert.equal(
    lines.join("\n"),
    "",
    `test/reference/markdown.json: ${lines.length} comparison(s) moved. A Markdown reader that reads a code block, a heading, hidden text or an import otherwise than the parser does is fixed, or the place lists why ("extra: … (<open node>)", "differs: …", "gap: <open node>"), in the commit that moves it.`,
  );
});

test("reference: the Markdown record names its parser and Claude Code's steps, and holds well-formed cells, each with the parser's reading", () => {
  const rec = md.readRecord();
  assert.equal(rec.parser, `marked@${md.PARSER.version}`);
  assert.match(md.PARSER.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(md.PARSER.tarball, `https://registry.npmjs.org/marked/-/marked-${md.PARSER.version}.tgz`);
  assert.match(rec.claudeCode.version, /^\d+\.\d+\.\d+$/);
  for (const k of /** @type {const} */ (["read", "frontMatter", "bom", "comments", "walk", "parserRules"])) assert.match(rec.claudeCode[k], /^[0-9a-f]{16}$/, k);
  assert.ok(rec.claudeCode.textExtensions.includes(".md") && rec.claudeCode.textExtensions.includes(".txt") && !rec.claudeCode.textExtensions.includes(".png"));
  const ids = rec.cells.map((c) => c.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "an id twice");
  assert.deepEqual(rec.cells.flatMap(md.cellProblems), []);
  for (const c of rec.cells) assert.ok(c.md, `${c.id}: no reading`);
  // The record holds what each reader's comparison needs on both sides.
  const seen = new Set(
    md.compareAll(rec.cells, rec.claudeCode.textExtensions).flatMap(({ got }) =>
      [...got].map(([k, r]) => {
        const kind = k.split(":")[0];
        return kind === "ban" ? `${r.relation} ban` : `${r.relation} ${kind} ${r.md.split(":")[0]}`;
      }),
    ),
  );
  for (const want of ["agree line prose", "agree line code", "agree line heading", "agree line front matter", "extra line code", "extra line front matter", "extra line hidden", "differs line prose", "agree rule prose", "agree rule heading", "extra rule heading", "extra rule short", "differs rule prose", "agree ban", "extra ban", "agree import imports", "extra import no import", "differs import imports"]) assert.ok(seen.has(want), want);
});

test("reference control: the Markdown judge finds a reading that moved", () => {
  const judged = (/** @type {md.Cell} */ c, /** @type {Set<string> | undefined} */ open = undefined) => md.moves([{ cell: c, got: md.compare(c, EXT) }], open).join("\n");
  /** @type {md.Cell} */
  const cell = { id: "x", from: "control", text: "```\nNever use `zz` in code.\n```\nAfter the block, never use `yy` in this repository at all.\nsee @docs/a.md\n", md: { lines: "ccctt" + "t", imports: ["docs/a.md"] } };
  assert.equal(judged(cell), "");
  // A line the parser reads as prose that Ennyn drops, and one it reads as code that Ennyn keeps.
  assert.match(judged({ ...cell, md: { ...cell.md, lines: "ctcttt" } }), /x "line:2": differs, recorded agree — Ennyn "code", the parser "prose"/);
  assert.match(judged({ ...cell, md: { ...cell.md, lines: "cccctt" } }), /x "line:4": extra, recorded agree — Ennyn "prose", the parser "code"/);
  // A rule line the parser reads as a heading; a heading Ennyn takes for one (a prose line in Ennyn's reading, heading in the parser's).
  assert.match(judged({ ...cell, md: { ...cell.md, lines: "ccc#tt" } }), /x "rule:4": extra, recorded agree — Ennyn "rule line", the parser "heading"/);
  const hashtag = { id: "h", from: "control", text: "#tag never use the `hb` helper in any module of this repository\n", md: { lines: "tt", imports: [] } };
  assert.match(judged(hashtag), /h "rule:1": differs, recorded agree — Ennyn "heading", the parser "prose"/);
  // A line whose key is just long enough is a rule line on both sides; one character shorter is no rule line at all.
  const edge = (/** @type {number} */ n) => ({ id: "e", from: "control", text: `${"a".repeat(n)}\n`, md: { lines: "tt", imports: [] } });
  assert.deepEqual([...md.compare(edge(MIN_RULE), EXT).keys()], ["line:1", "rule:1"]);
  assert.deepEqual([...md.compare(edge(MIN_RULE - 1), EXT).keys()], ["line:1"]);
  assert.deepEqual(ruleLines(`${"b".repeat(MIN_RULE)}\n${"c".repeat(MIN_RULE - 1)}`).map((r) => r.key), ["b".repeat(MIN_RULE)]);
  assert.deepEqual(ruleLines(`\uFEFF${"d".repeat(MIN_RULE)}`), [{ at: 0, line: "d".repeat(MIN_RULE), key: "d".repeat(MIN_RULE) }]);
  assert.deepEqual(banLiterals("Never use `aa`, `bb`, `cc` or `dd`."), ["aa", "bb", "cc"]);
  // What the model gets of a line part of which is hidden: a ban literal or rule words only Ennyn takes, a literal only the model gets.
  const half = { id: "p", from: "control", text: "<!-- Never use `qa` here --> See the docs, and never use the `qb` helper again.\n", md: { lines: "tt", shown: { 1: " See the docs, and never use the `qb` helper again." }, imports: [] } };
  assert.match(judged(half), /p "ban:1": extra, recorded agree — Ennyn "qa qb", the parser "qb"/);
  assert.match(judged(half), /p "rule:1": extra, recorded agree — Ennyn "rule line: <!-- never use qa here --> see the docs, and never use the qb helper again\.", the parser "prose: see the docs, and never use the qb helper again\."/);
  const split = { id: "s", from: "control", text: "Never use <!-- ` --> `zz` x\n", md: { lines: "tt", shown: { 1: "Never use  `zz` x" }, imports: [] } };
  assert.match(judged(split), /s "ban:1": differs, recorded agree — Ennyn "-->", the parser "zz"/);
  // An import Claude Code makes that Ennyn misses, one Ennyn reads that Claude Code does not, one outside the repository,
  // and one of a file Claude Code reads no text of (its extension).
  assert.match(judged({ ...cell, md: { ...cell.md, imports: ["docs/a.md", "docs/b.md"] } }), /x "import:docs\/b\.md": differs, recorded agree — Ennyn "no import", the parser "imports"/);
  assert.match(judged({ ...cell, md: { ...cell.md, imports: [] } }), /x "import:docs\/a\.md": extra, recorded agree — Ennyn "imports", the parser "no import"/);
  assert.equal(judged({ ...cell, md: { ...cell.md, imports: ["docs/a.md", "~/x.md", "/etc/x.md", "../x.md", "./docs/a.md", "k.png", "m.MD."] } }), "");
  assert.match(judged({ ...cell, md: { ...cell.md, imports: ["docs/a.md", "l.TXT"] } }), /x "import:l\.TXT": differs/);
  // Blank lines are compared nowhere.
  assert.equal([...md.compare(cell, EXT).keys()].some((k) => k === "line:6"), false);
  // A listed place with no why, a gap or an extra naming no open node, a place neither has, a pin missing or moved.
  const hole = { ...cell, md: { ...cell.md, lines: "ctcttt" }, except: { "line:2": "gap: some-node" }, ennyn: { "line:2": "code" } };
  assert.equal(judged(hole, new Set(["some-node"])), "");
  assert.match(judged(hole, new Set(["other"])), /names no open graph node: "some-node"/);
  assert.match(judged({ ...hole, ennyn: { "line:2": "prose" } }), /"line:2": Ennyn reads "code", recorded "prose"/);
  assert.match(judged({ ...hole, ennyn: {} }), /Ennyn's reading is not pinned/);
  assert.match(judged({ ...hole, ennyn: { ...hole.ennyn, "line:1": "code" } }), /"line:1": Ennyn's reading pinned where except lists nothing/);
  assert.match(judged({ ...hole, except: { "line:2": "gap:" } }), /gives no why/);
  assert.match(judged({ ...hole, except: { "line:2": "extra: x" } }), /an extra names no graph node/);
  assert.match(judged({ ...hole, except: { "line:2": "extra: x (some-node)" } }, new Set(["some-node"])), /"line:2": differs, recorded extra/);
  assert.match(judged({ ...cell, except: { "line:9": "differs: x" }, ennyn: { "line:9": "x" } }), /"line:9": listed, but neither the parser nor Ennyn has this place/);
  // A place from a cell's text reaches the terminal quoted: no control byte of it.
  const control = judged({ id: "c", from: "control", text: "see @a\u001b]52;c;eA==\u0007.md\n", md: { lines: "tt", imports: [] } });
  assert.ok(control.includes("\\u001b") && !control.includes("\u001b"));
  assert.deepEqual(md.RELATIONS, ["agree", "extra", "differs"]);
  // Ennyn's lines are placed by their index: the same text inside and outside a block is two lines.
  assert.deepEqual([...md.readings("x\n```\nx\n```\nx").prose], [0, 4]);
  // What a cell must hold.
  for (const bad of [{ text: 1 }, { text: "a\rb" }, { text: "a".repeat(16 * 1024 + 1) }, { md: { lines: "t", imports: [] } }, { md: { lines: "tz", imports: [] } }, { md: { lines: "tt", imports: [1] } }, { md: { lines: "tt", imports: [], shown: { 1: 2 } } }, { except: { "line:1": "agree: x" } }, { ennyn: { "line:1": 1 } }, { files: {} }]) {
    assert.notDeepEqual(md.cellProblems({ id: "x", from: "control", text: "a\nb", ...bad }), [], JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(md.cellProblems({ id: "x", from: "control", text: "a\r\nb", md: { lines: "tt", shown: { 1: "a" }, imports: [] }, except: { "line:1": "differs: x" }, ennyn: { "line:1": "code" } }), []);
});

test("reference control: the replay reads each reader's reading of the whole text, so a fix that looks ahead is seen and a regression is caught", () => {
  const rec = md.readRecord();
  const at = (/** @type {string} */ id) => /** @type {md.Cell} */ (rec.cells.find((c) => c.id === id));
  const replay = (/** @type {md.Cell} */ c, /** @type {typeof md.READERS} */ readers) => md.moves([{ cell: c, got: md.compare(c, rec.claudeCode.textExtensions, md.readings(c.text, readers)) }]).join("\n");
  const front = at("rv-front-matter-then-body-rule");
  const setext = at("rv-setext-rule-under-fix");
  assert.equal(replay(front, md.READERS) + replay(setext, md.READERS), "");
  // A fence reader that cuts front matter (its closer comes further on): the front matter's places agree now.
  const cutting = { ...md.READERS, outsideFenceLines: (/** @type {string} */ t) => outsideFenceLines(t).filter((i) => i >= md.frontCut(t).first) };
  assert.match(replay(front, cutting), /"line:1": agree, recorded extra/);
  // A budget that reads a setext heading (its underline is the next line): the heading's place agrees now.
  const underline = { ...md.READERS, ruleLines: (/** @type {string} */ t) => ruleLines(t).filter((r) => !/^ {0,3}(=+|-+)[ \t]*$/.test(t.split("\n")[r.at + 1] ?? "")) };
  assert.match(replay(setext, underline), /"rule:1": agree, recorded extra/);
  // A budget that drops a rule line before a blank line: caught, mid-text too.
  const dropping = { ...md.READERS, ruleLines: (/** @type {string} */ t) => ruleLines(t).filter((r) => (t.split("\n")[r.at + 1] ?? "").trim() !== "") };
  assert.match(replay(setext, dropping), /"rule:4": differs, recorded agree/);
  assert.match(replay(at("rv2-two-rule-paragraphs"), dropping), /"rule:1": differs, recorded agree[^]*"rule:3": differs, recorded agree/);
  // A heading after a byte order mark is prose to the parser; the budget's own heading test reads it as a heading
  // after it drops the mark. A budget that tests the line as written closes it; a fence reader that keeps the mark
  // does not: the place is the budget's.
  const bom = at("rv-bom-no-front-matter-heading");
  assert.match(String(bom.except?.["rule:1"]), /^gap: budget-heading-rule$/);
  const asWritten = {
    ...md.READERS,
    ruleLines: (/** @type {string} */ t) =>
      outsideFenceLines(t).flatMap((i) => {
        const line = t.split("\n")[i];
        return /^[ \t]*#/.test(line) || ruleKey(line).length < MIN_RULE ? [] : [{ at: i, line, key: ruleKey(line) }];
      }),
  };
  assert.match(replay(bom, asWritten), /"rule:1": agree, recorded differs/);
  const allProse = { ...md.READERS, outsideFenceLines: (/** @type {string} */ t) => t.split("\n").map((_, i) => i) };
  assert.doesNotMatch(replay(bom, allProse), /rule:1/);
});

test("reference: the ban lines corpus and the Markdown record agree on every text they share, or the ban cell names why", () => {
  const cells = md.readRecord().cells;
  /** @type {{ id: string, text: string, verdict: string, why?: string[], known?: string, gap?: string }[]} */
  const bans = JSON.parse(readFileSync(new URL("./verdicts/bans.json", import.meta.url), "utf8"));
  assert.deepEqual(md.twinProblems(bans, cells), []);
  // A ban cell with no twin in the record fails, unless the list of cells with none names it with why; one that
  // disagrees and names no anchor fails.
  const lone = { id: "lone", text: "\uFEFF~~~\nNever use `zo` in a rule line of this file.\n~~~\n", verdict: "pass" };
  assert.match(md.twinProblems([...bans, lone], cells).join("\n"), /lone: no cell of test\/reference\/markdown\.json holds its text/);
  assert.deepEqual(md.twinProblems([...bans, lone], cells, { lone: "a text the parser cannot be given" }), []);
  const twin = /** @type {typeof bans[number]} */ (bans.find((b) => b.id === "fence-bom-then"));
  const { gap: _, ...unanchored } = twin;
  assert.match(md.twinProblems([unanchored], cells).join("\n"), /fence-bom-then: bans\.json says pass \[\], the model gets said \["zz"\]/);
  const said = /** @type {typeof bans[number]} */ (bans.find((b) => b.id === "never-ever"));
  assert.match(md.twinProblems([{ ...said, why: ["other"] }], cells).join("\n"), /never-ever: bans\.json says said \["other"\], the model gets said \["eval"\]/);
  assert.deepEqual(md.modelBans(cells, "no such text"), null);
  // What the model never gets is no ban: a comment's, and the hidden part of a line.
  assert.deepEqual(md.modelBans(cells, "<!-- never use `eval` -->"), { verdict: "pass" });
  assert.deepEqual(md.modelBans(cells, "<!-- Never use `qa` here --> See the docs.\n"), { verdict: "pass" });
  // Nor the part of a line a front matter cut ends in: the model gets only what follows the closer.
  assert.deepEqual(md.modelBans(cells, "---\ndescription: never use `qb` in any file---x\nBody line.\n"), { verdict: "pass" });
});

test("reference control: the Markdown recorder cuts front matter, takes out comments and places blocks as the record's steps say, and refuses a cell it cannot place", () => {
  /** @type {string[]} */
  const seen = [];
  /** A parser that gives `tokens` (and the definitions it kept as none) for any text, and keeps the texts it was given. @param {any[]} tokens @param {string[]} [defs] */
  const lexer = (tokens, defs = []) => (/** @type {string} */ content) => (seen.push(content), { tokens, defs });
  const para = (/** @type {string} */ raw) => ({ type: "paragraph", raw, tokens: [{ type: "text", raw: raw.trim(), text: raw.trim() }] });
  // Front matter as Claude Code cuts it: the lines up to the closer, and the blank lines after it, are front matter.
  assert.equal(md.mdReading("---\nk: v\n---\n\nbody\n", lexer([para("body\n")])).lines, "fffftt");
  assert.equal(seen.at(-1), "body\n");
  assert.deepEqual(md.frontCut("---\nk: v\n---\nbody"), { content: "body", first: 3, mid: false });
  // A closer inside a line: the rest of that line is the text, its class the line's, and what the model gets of it.
  assert.deepEqual(md.mdReading("---\nk: a---b\nc\n", lexer([para("b\nc\n")])), { lines: "fttt", shown: { 2: "b" }, imports: [] });
  assert.equal(seen.at(-1), "b\nc\n");
  // No other `---`: nothing is cut, and a byte order mark stays in the text the parser gets.
  md.mdReading("---\nk: v\n", lexer([{ type: "hr", raw: "---\n" }, para("k: v\n")]));
  assert.equal(seen.at(-1), "---\nk: v\n");
  md.mdReading("﻿x\n", lexer([para("﻿x\n")]));
  assert.equal(seen.at(-1), "﻿x\n");
  assert.equal(md.mdReading("﻿---\nk\n---\nx\n", lexer([para("x\n")])).lines, "ffftt");
  assert.equal(seen.at(-1), "x\n");
  // A top-level comment's lines are hidden; text beside it is what the model gets of that line; a comment in a list item is not taken out.
  assert.equal(md.mdReading("<!-- a\nb -->\ntext\n", lexer([{ type: "html", raw: "<!-- a\nb -->\n" }, para("text\n")])).lines, "hhtt");
  assert.deepEqual(md.mdReading("<!-- a --> rest\n", lexer([{ type: "html", raw: "<!-- a --> rest\n" }])), { lines: "tt", shown: { 1: " rest" }, imports: [] });
  assert.equal(md.mdReading("<div>\n<!-- a -->\n</div>\n", lexer([{ type: "html", raw: "<div>\n<!-- a -->\n</div>\n" }])).lines, "tttt");
  const item = { type: "list", raw: "- a\n  <!-- b -->\n", items: [{ type: "list_item", raw: "- a\n  <!-- b -->", tokens: [{ type: "text", raw: "a\n", text: "a" }, { type: "html", raw: "<!-- b -->" }] }] };
  assert.equal(md.mdReading("- a\n  <!-- b -->\n", lexer([item])).lines, "ttt");
  // Characters outside the BMP before a comment's end: the mask is read by UTF-16 offset.
  const astral = "<!--\n😀😀😀 --> Never use `qv` here.\n";
  assert.deepEqual(md.mdReading(astral, lexer([{ type: "html", raw: astral }])), { lines: "htt", shown: { 2: " Never use `qv` here." }, imports: [] });
  // A link reference definition is no token: it is the lexer's definition there, and hidden where the text holds a comment.
  assert.equal(md.mdReading("[r]: /u\ntext\n", lexer([para("text\n")], ["[r]: /u\n"])).lines, "ttt");
  assert.equal(md.mdReading("[r]: /u\n<!-- c -->\n", lexer([{ type: "html", raw: "<!-- c -->\n" }], ["[r]: /u\n"])).lines, "hht");
  assert.throws(() => md.mdReading("[q]: /u\ntext\n", lexer([para("text\n")], ["[r]: /u\n"])), /do not cover/);
  assert.throws(() => md.mdReading("[q]: /u\ntext\n", lexer([para("text\n")])), /do not cover/);
  // A block's lines found by their text, a container's markers and white space aside.
  const fenced = { type: "list", raw: "- a\n\n  ```\n  code\n  ```\n", items: [{ type: "list_item", raw: "- a\n\n  ```\n  code\n  ```", tokens: [{ type: "text", raw: "a", text: "a" }, { type: "space", raw: "\n\n" }, { type: "code", raw: "```\ncode\n```" }] }] };
  assert.equal(md.mdReading("- a\n\n  ```\n  code\n  ```\n", lexer([fenced])).lines, "ttccct");
  const quoted = { type: "blockquote", raw: "> ## h\n> ```\n> q\n", tokens: [{ type: "heading", raw: "## h\n", tokens: [] }, { type: "code", raw: "```\nq\n" }] };
  assert.equal(md.mdReading("> ## h\n> ```\n> q\n", lexer([quoted])).lines, "#cct");
  // Two blocks with the same lines, each placed once; a block's lines that also stand outside any block, refused.
  const two = [{ type: "code", raw: "    same\n" }, { type: "space", raw: "\n" }, { type: "code", raw: "    same\n" }];
  assert.equal(md.mdReading("    same\n\n    same\n", lexer(two)).lines, "ctct");
  assert.throws(() => md.mdReading("same\n\n    same\n", lexer([para("same\n\n"), { type: "code", raw: "    same\n" }])), /stand elsewhere in the cell too/);
  assert.throws(() => md.mdReading("x\n", lexer([{ type: "code", raw: "x\n" }, { type: "code", raw: "    y\n" }])), /do not cover/);
  assert.throws(() => md.mdReading("x\n", lexer([{ type: "list", raw: "x\n", items: [{ type: "list_item", raw: "x", tokens: [{ type: "code", raw: "zz" }] }] }])), /not found in the text/);
  // A first line with a byte order mark is no container marker: a block on it is not found there.
  assert.equal(md.mdReading("﻿```\nx\n```\n", lexer([para("﻿```\nx\n"), { type: "code", raw: "```\n" }])).lines, "ttct");
  assert.throws(() => md.mdReading("a\rb", lexer([])), /lone carriage return/);
  // readAll: each cell's text after the cut goes to the parser once; a text the parser threw on is that cell's refusal.
  /** @type {string[][]} */
  const asked = [];
  const { cells, refused } = md.readAll(
    [{ id: "a", from: "control", text: "---\nk\n---\nx\n" }, { id: "b", from: "control", text: "y\n" }],
    (contents) => (asked.push(contents), [{ tokens: [para("x\n")], defs: [] }, { error: "Maximum call stack size exceeded" }]),
  );
  assert.deepEqual(asked, [["x\n", "y\n"]]);
  assert.equal(cells[0].md?.lines, "ffftt");
  assert.deepEqual(refused, ['b: the parser threw: "Maximum call stack size exceeded"']);
  // What the parser says goes to the terminal quoted: no control byte of it.
  const errorLine = md.readAll([{ id: "c", from: "control", text: "z\n" }], () => [{ error: "\u001b]52;c;eA==\u0007" }]).refused[0];
  assert.ok(!errorLine.includes("\u001b") && errorLine.includes("\\u001b"), errorLine);
});

test("reference control: Claude Code's import walk takes a word as its binary's walk does", () => {
  const tokens = [
    { type: "paragraph", tokens: [{ type: "text", text: "see @a.md and @b.md#x" }, { type: "codespan", text: "@c.md" }, { type: "strong", tokens: [{ type: "text", text: "@d.md" }] }] },
    { type: "code", text: "@e.md" },
    { type: "html", raw: "<!-- @f.md --> @g.md" },
    { type: "html", raw: "<!-- @x.md -->" },
    { type: "html", raw: "<div>@h.md</div>" },
    { type: "list", items: [{ type: "list_item", tokens: [{ type: "text", text: "@i\\ j.md and @a.md" }] }] },
    { type: "paragraph", tokens: [{ type: "text", text: "@@k.md @#x @/ @/abs.md @~/home.md @./rel.md @(x) mail@l.md\t@m.md" }] },
  ];
  assert.deepEqual(md.walk(tokens), ["a.md", "b.md", "d.md", "g.md", "i j.md", "/abs.md", "~/home.md", "./rel.md", "m.md"]);
});

/** A stand-in for Claude Code's binary text: the reader's steps in their shapes, minified names given. @param {Record<string, string>} n @param {Record<string, string>} [change] */
const binary = (n, change = {}) =>
  [
    `x;import{dirname as ${n.dir},extname as ${n.ext}}from"path";var ${n.set}=new Set([".txt",".md"]);`,
    `function ${n.split}(e){let{frontmatter:n,content:r}=${n.front}(e);if(!n.paths)return{content:r};return{content:r}}`,
    `function ${n.read}(e,n,r,s){let h=${n.ext}(n).toLowerCase();if(h&&!${n.set}.has(h))return t(\`Skipping non-text file in @include: \${n}\`),{info:null,includePaths:[]};let{content:y,paths:b}=${n.split}(e),w=y.includes("<!--"),H=s!==void 0&&y.includes("@"),q=w||H?new ${n.lexer}({gfm:!1}).lex(y):void 0,K=w&&q?${n.comments}(q).content:y,Q=q&&s!==void 0?${n.walk}(q,s):[];return Q}`,
    `function ${n.defaults}(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var ${n.rules}={fences:${change.rule ?? "/^ {0,3}(`{3,}|~{3,})([^\\n]*)/"},code:/^((?: {4}| {0,3}\\t)[^\\n]+)/,fencesBegin:(e)=>new RegExp(\`^ {0,\${Math.min(${change.indent ?? "3"},e-1)}}(?:\\\`\\\`\\\`|~~~)\`),tabs:(e)=>" ".repeat(${change.tab ?? "3"}*e.length)};`,
    `class ${n.lexer}{tokens;options;state;tokenizer;inlineQueue;constructor(e){}}var ${n.m}={};${n.m}.lexer=${n.lexer}.lex;`,
    `function ${n.comments}(${n.a}){let ${n.b}="",${n.c}=!1;for(let ${n.d} of ${n.a}){if(${n.d}.type==="html"){let ${n.e}=${n.d}.raw.replace(/<!--[\\s\\S]*?-->/g,"");if(${n.c}=!0,${n.e}.trim().length>0)${n.b}+=${change.joined ?? n.e};continue}${n.b}+=${n.d}.raw}return{content:${n.b},stripped:${n.c}}}`,
    `function ${n.walk}(e,n){let r=new Set;function s(y){r.add(y)}function h(y){for(let b of y){if(b.type==="code"||b.type==="codespan")continue;if(b.type==="html"){let w=b.raw||"",K=w.replace(/<!--[\\s\\S]*?-->/g,"");if(K.trim().length>0)s(${change.scan ?? "K"});continue}if(b.type==="text")s(b.text||"");if(b.tokens)h(b.tokens)}}return h(e),[...r]}`,
    `var ${n.re}=${change.expr ?? "/^---\\s*\\n([\\s\\S]*?)---\\s*\\n?/"},W3=/x/;function ${n.front}(e,n,r){let s=e;e=${n.bom}(e);let h=e.indexOf("---",3)<0?null:e.match(${n.re});if(!h)return{frontmatter:{},frontmatterAsWritten:{},content:${change.content ?? "s"}};let y=h[1]||"",w=e.slice(h[0].length);return{frontmatter:{},content:w}}`,
    `function ${n.bom}(e){return e.charCodeAt(0)===65279?e.slice(1):e}`,
  ].join("\n");
const NAMES = { dir: "QC", ext: "jqo", set: "tKo", split: "nKo", read: "pYe", lexer: "zA", comments: "BVe", walk: "fKo", front: "xa", re: "qC", bom: "uE", defaults: "pf", rules: "fl", m: "Mk", a: "e", b: "n", c: "r", d: "h", e: "b" };

test("reference control: the steps of Claude Code's reader are found by their shape, whatever the minified names, and a change of what they do is seen", () => {
  const a = md.stepsOf(binary(NAMES));
  assert.deepEqual(Object.entries(a).filter(([k, v]) => k !== "textExtensions" && !/^[0-9a-f]{16}$/.test(String(v))), [], JSON.stringify(a));
  assert.deepEqual(a.textExtensions, [".md", ".txt"]);
  // Another build with other names, locals too: the same steps; read from a Buffer as from text.
  const other = { dir: "aB", ext: "cD", set: "eF", split: "gH", read: "iJ", lexer: "Qx", comments: "e$", walk: "Gh", front: "ij", re: "kL", bom: "mN", defaults: "oP", rules: "qR", m: "sT", a: "u", b: "v", c: "w", d: "z", e: "y" };
  assert.deepEqual(md.stepsOf(binary(other)), a);
  assert.deepEqual(md.stepsOf(Buffer.from(binary(NAMES), "latin1")), a);
  // A function of the same name far from the reader (another bundle in the binary) is not the one hashed.
  assert.deepEqual(md.stepsOf(`function fKo(e){return e}${" ".repeat(20000)}${binary(NAMES)}`), a);
  // A value handed along otherwise moves the step's hash: the comment step keeps the comment, the walk scans the
  // whole comment token, the front matter cut drops a byte order mark it keeps today.
  assert.notEqual(md.stepsOf(binary(NAMES, { joined: "h.raw" })).comments, a.comments);
  assert.notEqual(md.stepsOf(binary(NAMES, { scan: "w" })).walk, a.walk);
  assert.equal(md.stepsOf(binary(NAMES, { content: "e" })).frontMatter, "not found");
  // Another rule of the bundled parser, another front matter expression: seen.
  assert.notEqual(md.stepsOf(binary(NAMES, { rule: "/^ {0,1}(`{3,}|~{3,})([^\\n]*)/" })).parserRules, a.parserRules);
  // A rule the parser builds from a template, and its tokenizer's code: the whole section's hash moves.
  assert.notEqual(md.stepsOf(binary(NAMES, { indent: "2" })).parserCode, a.parserCode);
  assert.notEqual(md.stepsOf(binary(NAMES, { tab: "4" })).parserCode, a.parserCode);
  assert.equal(md.stepsOf(binary(NAMES, { tab: "4" })).parserRules, a.parserRules);
  // The section itself, as a module the child runs, with its Lexer.
  assert.match(String(md.bundledLexer(binary(NAMES))), /^function pf\(\)[^]*\.lexer=zA\.lex;\nexport \{ zA as Lexer \};$/);
  assert.equal(md.bundledLexer("nothing here"), null);
  // The pinned parser against the bundled one, text by text.
  assert.deepEqual(md.lexersDisagree(["a", "b"], [{ tokens: [1], defs: [] }, { tokens: [2], defs: [] }], [{ tokens: [1], defs: [] }, { tokens: [2], defs: [] }]), []);
  assert.deepEqual(md.lexersDisagree(["a", "b"], [{ tokens: [1], defs: [] }, { tokens: [2], defs: [] }], [{ tokens: [1], defs: [] }, { tokens: [3], defs: [] }]), ['"b"']);
  assert.equal(md.stepsOf(binary(NAMES, { expr: "/^---\\n([\\s\\S]*?)\\n---/" })).frontMatter, "not found");
  // No lexer class of that name, two front matter functions, a front matter cut that calls another function: not found.
  assert.equal(md.stepsOf(binary(NAMES).replace("class zA{", "class zB{")).read, "not found");
  const front = /var qC=[^\n]*/.exec(binary(NAMES))?.[0] ?? "";
  assert.equal(md.stepsOf(`${binary(NAMES)}\n${front.replaceAll("xa", "xb")}`).frontMatter, "not found");
  assert.equal(md.stepsOf(binary(NAMES).replace("}=xa(e);if(!n.paths)", "}=xz(e);if(!n.paths)")).read, "not found");
  assert.deepEqual(Object.values(md.stepsOf("nothing here")), ["not found", "not found", "not found", "not found", "not found", "not found", "not found", []]);
  assert.equal(md.codeHash("function ab(c){return c}"), md.codeHash("function xy(z){return z}"));
  assert.notEqual(md.codeHash("let a=1"), md.codeHash("var a=1"));
  // Letters inside a literal are no names: a local renamed where a regular expression says \\s hashes the same.
  const step = (/** @type {string} */ s) => `function BVe(e){let n="",r=!1,${s}=/<!--[\\s\\S]*?-->/g;for(let h of e){if(h.type==="html"){let y=h.raw.trimStart();if(y.startsWith("<!--")&&y.includes("-->")){let b=h.raw.replace(${s},"");if(r=!0,b.trim().length>0)n+=b;continue}}n+=h.raw}return{content:n,stripped:r}}`;
  assert.equal(md.codeHash(step("s")), md.codeHash(step("x")));
  assert.notEqual(md.codeHash(step("s")), md.codeHash(step("s").replace("/g;", "/;")));
  assert.notEqual(md.codeHash('let a="s"'), md.codeHash('let a="x"'));
  assert.equal(md.codeHash('let s="a\\"s";f(s)'), md.codeHash('let x="a\\"s";f(x)'));
  assert.equal(md.codeHash("let g=/a/g;g.test(x)"), md.codeHash("let y=/a/g;y.test(x)"));
  assert.equal(md.codeHash("let s=/[/]s/;f(s)"), md.codeHash("let x=/[/]s/;f(x)"));
  // Two readers, no extname import, two parser defaults: not found.
  const reader = /function pYe[^\n]*/.exec(binary(NAMES))?.[0] ?? "";
  assert.equal(md.stepsOf(`${binary(NAMES)}\n${reader.replace("function pYe", "function pYf")}`).read, "not found");
  assert.equal(md.stepsOf(binary(NAMES).replace("extname as jqo", "basename as jqo")).read, "not found");
  const defaults = /function pf[^;]*;/.exec(binary(NAMES))?.[0] ?? "";
  assert.equal(md.stepsOf(binary(NAMES).replace(defaults, `${defaults}${defaults.replace("pf", "pg")}`)).parserRules, "not found");
  assert.notEqual(md.codeHash("function ab(c,d){return c}"), md.codeHash("function ab(c,d){return d}"));
  // The pinned parser's rules against the bundle's: the same set passes, another is said.
  const rules = md.ruleLiterals(binary(NAMES).slice(binary(NAMES).indexOf("function pf"), binary(NAMES).indexOf(".lexer=zA.lex;")));
  assert.equal(rules.length, 2);
  const steps = /** @type {md.Steps} */ ({ ...a, version: "0" });
  assert.deepEqual(md.rulesMoved(`const a = {fences:${rules[1]},code:${rules[0]}};`, steps), []);
  assert.match(md.rulesMoved(`const a = {fences:/^ {0,2}(\`{3,})/,code:${rules[0]}};`, steps).join(""), /Claude Code's bundle holds/);
  // What a module's comments hold is no rule (marked's text says "/c*$/" in one).
  assert.deepEqual(md.rulesMoved(`// trims /c*$/, the suffix\nconst a = {fences:${rules[1]},code:${rules[0]}};`, steps), []);
});

/** A tar entry: a ustar header and the content padded to 512 bytes. @param {string} name @param {string} text @param {string} [prefix] */
const tarEntry = (name, text, prefix = "") => {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(`${Buffer.byteLength(text).toString(8).padStart(11, "0")}\0`, 124);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write(prefix, 345);
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(text) / 512) * 512);
  body.write(text);
  return Buffer.concat([h, body]);
};

test("reference control: the parser comes out of its tarball by name, and the one pinned is what Claude Code's bundle matches", () => {
  const tar = Buffer.concat([tarEntry("package/README.md", "r".repeat(600)), tarEntry("marked.esm.js", "export const x = 1;", "package/lib"), Buffer.alloc(1024)]);
  assert.equal(md.fileInTar(tar, "package/lib/marked.esm.js")?.toString(), "export const x = 1;");
  assert.equal(md.fileInTar(tar, "package/README.md")?.toString(), "r".repeat(600));
  assert.equal(md.fileInTar(tar, "package/other.js"), null);
  // The version whose rules Claude Code 2.1.310's bundle holds (15.0.5 holds the same rules; its helpers are 15.0.6's).
  assert.equal(md.PARSER.version, "15.0.6");
  assert.equal(md.PARSER.file, "package/lib/marked.esm.js");
  assert.ok(md.PARSER.bytes >= 105_000 && md.PARSER.bytes <= 2 * 1024 * 1024);
});

test("reference control: the parser's tarball is taken only as pinned: its integrity, no redirect, no encoding, no more bytes than its cap", async () => {
  const tgz = gzipSync(Buffer.concat([tarEntry("package/lib/marked.esm.js", "export class Lexer {}"), Buffer.alloc(1024)]));
  const parser = { version: "0", tarball: "https://registry.example/m.tgz", integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`, file: "package/lib/marked.esm.js", bytes: 4096 };
  /** @type {{ url: unknown, opts: any }[]} */
  const asked = [];
  const answer = (/** @type {BodyInit | null} */ body, /** @type {ResponseInit} */ init = {}) => /** @type {typeof fetch} */ (async (url, opts) => (asked.push({ url, opts }), new Response(body, init)));
  assert.deepEqual(await md.loadParser({ fetch: answer(tgz), parser }), { source: "export class Lexer {}" });
  assert.equal(asked[0].url, parser.tarball);
  assert.equal(asked[0].opts.redirect, "error");
  assert.equal(asked[0].opts.headers["accept-encoding"], "identity");
  assert.ok(asked[0].opts.signal instanceof AbortSignal);
  await assert.rejects(md.loadParser({ fetch: answer(Buffer.concat([tgz, Buffer.from("x")])), parser }), /integrity/);
  await assert.rejects(md.loadParser({ fetch: answer(null, { status: 302, headers: { location: "https://evil.example/m.tgz" } }), parser }), /answered 302/);
  await assert.rejects(md.loadParser({ fetch: answer(tgz, { headers: { "content-encoding": "gzip" } }), parser }), /content encoding "gzip" refused/);
  await assert.rejects(md.loadParser({ fetch: answer(tgz, { headers: { "content-length": "5000" } }), parser }), /more than 4096 bytes/);
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(1000))), cancel: () => void (cancelled = true) });
  await assert.rejects(md.loadParser({ fetch: answer(endless), parser }), /more than 4096 bytes/);
  assert.ok(pulled < 10, `${pulled} chunks read`);
  assert.ok(cancelled, "the answer past the cap is cancelled");
  await assert.rejects(md.loadParser({ fetch: answer(Buffer.concat([tgz.subarray(0, 10)])), parser: { ...parser, integrity: `sha512-${createHash("sha512").update(tgz.subarray(0, 10)).digest("base64")}` } }));
  // An answer that stops sending ends at the time limit, whatever the fetch does with its signal.
  const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const slow = new Promise((_, no) => (timer = setTimeout(() => no(new Error("still reading")), 5000)));
  try {
    await assert.rejects(Promise.race([md.loadParser({ fetch: answer(stalled), parser, ms: 100 }), slow]), /timed out after 100 ms/);
    // A fetch that keeps to its signal fails with an abort: said as the time limit too.
    const keeping = /** @type {typeof fetch} */ ((_, opts) => new Promise((_, no) => opts?.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError")))));
    await assert.rejects(Promise.race([md.loadParser({ fetch: keeping, parser, ms: 100 }), slow]), /timed out after 100 ms/);
    // And one whose body fails with the abort, as a fetch's does.
    const failing = /** @type {typeof fetch} */ (async (_, opts) => new Response(new ReadableStream({ start: (c) => opts?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))) })));
    await assert.rejects(Promise.race([md.loadParser({ fetch: failing, parser, ms: 100 }), slow]), /timed out after 100 ms/);
  } finally {
    clearTimeout(timer);
  }
});

test("reference control: the parser runs in a child that reads no file, starts no process and reaches no socket, with only the environment it is given", async () => {
  for (const [v, holds] of /** @type {const} */ ([["20.0.0", false], ["22.12.0", false], ["22.13.0", true], ["23.4.0", false], ["23.5.0", true], ["24.0.0", true]])) assert.equal(md.permissionHolds(v), holds, v);
  const env = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES", "TZ", "LC_ALL", "GIT_CONFIG_NOSYSTEM"].map((k) => [k, process.env[k] ?? ""]));
  // What the child is started with, read on every machine (a stand-in for the sandbox's path, a Node version whose
  // model holds): sandbox-exec with the network denied, the permission model, and by default an empty environment,
  // so a variable of the recorder's never reaches the parser.
  /** @type {{ file: string, args: string[], opts: any }[]} */
  const ran = [];
  const run = /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ opts) => (ran.push({ file, args, opts }), { status: 0, stdout: "[]", stderr: "" }));
  const sandbox = join(realpathSync(mkdtempSync(join(tmpdir(), "en-sbx-"))), "sandbox-exec");
  writeFileSync(sandbox, "");
  process.env.EN_SECRET = "canary";
  try {
    md.lexInChild("export class Lexer {}", [], { run, sandbox, node: "24.0.0" });
  } finally {
    delete process.env.EN_SECRET;
  }
  assert.equal(ran.length, 1);
  assert.equal(ran[0].file, sandbox);
  assert.deepEqual(ran[0].args.slice(0, 6), ["-p", "(version 1)(allow default)(deny network*)", process.execPath, "--permission", "--input-type=module", "-e"]);
  assert.deepEqual(ran[0].opts.env, {});
  // On a Node whose model let a process start (Node 20.0.0 ran execFileSync under it), or where nothing shuts the
  // child's network (no sandbox-exec, macOS's own unless a test names another), the parser does not run at all.
  assert.throws(() => md.lexInChild("export class Lexer {}", ["x"], { env, run, sandbox, node: "20.0.0" }), /permission model holds \(22\.13, 23\.5 or later\); this is 20\.0\.0/);
  assert.throws(() => md.lexInChild("export class Lexer {}", ["x"], { env, run, sandbox: `${sandbox}-absent`, node: "24.0.0" }), /nothing here shuts the parser's network \(no .*sandbox-exec-absent,/);
  assert.equal(ran.length, 1, "a refused child is never started");
  // The sandbox when no test names one is macOS's own; elsewhere the parser is refused, naming it.
  if (existsSync("/usr/bin/sandbox-exec")) {
    md.lexInChild("export class Lexer {}", [], { run, node: "24.0.0" });
    assert.equal(ran[1].file, "/usr/bin/sandbox-exec");
  } else assert.throws(() => md.lexInChild("export class Lexer {}", ["x"], { env, run, node: "24.0.0" }), /nothing here shuts the parser's network \(no \/usr\/bin\/sandbox-exec,/);
  // The child itself runs only where both hold.
  if (!md.permissionHolds()) {
    assert.throws(() => md.lexInChild("export class Lexer {}", ["x"], { env }), new RegExp(`permission model holds \\(22\\.13, 23\\.5 or later\\); this is ${process.versions.node.replaceAll(".", "\\.")}$`));
    return;
  }
  if (!existsSync("/usr/bin/sandbox-exec")) {
    assert.throws(() => md.lexInChild("export class Lexer {}", ["x"], { env }), /nothing here shuts the parser's network/);
    return;
  }
  // A socket on the machine (the Docker API is one): the child's module does not reach it.
  const dir = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-uds-")));
  const sock = join(dir, "s");
  const server = createServer((c) => c.destroy());
  await new Promise((r) => server.listen(sock, () => r(undefined)));
  try {
    const reaching = `import net from "node:net";
export const reached = await new Promise((ok) => { const s = net.connect({ path: ${JSON.stringify(sock)} }, () => { s.destroy(); ok("connected"); }); s.on("error", (e) => ok("refused: " + e.code)); });
export class Lexer { constructor() { this.tokenizer = { def: () => undefined }; } lex(c) { return [{ type: "text", raw: c, reached }]; } }`;
    const [r] = md.lexInChild(reaching, ["x"], { env });
    assert.ok("tokens" in r, JSON.stringify(r));
    assert.match(r.tokens[0].reached, /^refused: /);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const fake = `import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const tried = (f) => { try { f(); return "ran"; } catch (e) { return e.code ?? String(e.message); } };
export class Lexer {
  constructor() { this.tokenizer = { def: () => undefined }; }
  lex(src) {
    if (src === "deep") throw new Error("Maximum call stack size exceeded");
    return [{ type: "paragraph", raw: src, read: tried(() => readFileSync(${JSON.stringify(join(process.env.HOME ?? "/", ".gitconfig"))})), exec: tried(() => execFileSync("id")), env: Object.keys(process.env).sort().join(",") }];
  }
}`;
  const [r, thrown] = md.lexInChild(fake, ["text\n", "deep"], { env });
  assert.ok("tokens" in r);
  const [probe] = r.tokens;
  assert.equal(probe.read, "ERR_ACCESS_DENIED");
  assert.equal(probe.exec, "ERR_ACCESS_DENIED");
  assert.deepEqual(probe.env.split(",").filter((k) => !k.startsWith("__CF")), Object.keys(env).sort());
  assert.deepEqual(r.defs, []);
  assert.deepEqual(thrown, { error: "Maximum call stack size exceeded" });
  assert.throws(() => md.lexInChild("throw new Error('no module')", ["x"], { env }), /the parser's child failed/);
  // A module that answers for the child itself is caught by the count of readings.
  assert.throws(() => md.lexInChild('process.stdout.write(\'[{"tokens":[],"defs":[]}]\'); process.exit(0);', ["x", "y"], { env }), /another number of readings/);
});

test("reference control: a cell's id is plain words in every record, what the recorders print of a cell is quoted, and the claude run is never one a node_modules/.bin holds", () => {
  const escId = "x\u001b]0;t\u0007";
  for (const problems of [md.cellProblems({ id: escId, from: "p", text: "a" }), cellProblems({ id: escId, from: "p", lock: {} }), cc.cellProblems({ id: escId, from: "p", files: {} })]) {
    assert.equal(problems.length, 1);
    assert.ok(!problems[0].includes("\u001b") && problems[0].includes("\\u001b"), problems[0]);
  }
  assert.notDeepEqual(md.cellProblems({ id: "Upper", from: "p", text: "a" }), []);
  assert.deepEqual(cc.cellProblems({ id: "spelling-dash-C", from: "p", files: {} }), []);
  // npm run puts every ancestor's node_modules/.bin first on PATH: none of them is taken, nor a relative folder.
  const top = mkdtempSync(join(tmpdir(), "en-ref-bin-"));
  const bins = join(top, "node_modules", ".bin");
  const real = join(top, "usr", "bin");
  for (const d of [bins, real]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  }
  assert.equal(cc.claudeBinary("claude", [bins, `${bins}/`, "usr/bin", real].join(delimiter))?.path, join(real, "claude"));
  assert.equal(cc.claudeBinary("claude", [bins, "usr/bin"].join(delimiter)), null);
  mkdirSync(join(process.cwd(), "rel"), { recursive: true });
  writeFileSync(join(process.cwd(), "rel", "claude"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(cc.claudeBinary("claude", ["rel", real].join(delimiter))?.path, join(real, "claude"));
  assert.equal(cc.claudeBinary(join(bins, "claude"), "")?.path, join(bins, "claude"));
});

test("reference control: npm run test:reference runs the claude it resolves once, never one a node_modules/.bin holds", () => {
  const top = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-ref-run-")));
  try {
    const planted = join(top, "node_modules", ".bin");
    const real = join(top, "bin");
    const marker = join(top, "ran");
    mkdirSync(planted, { recursive: true });
    mkdirSync(real);
    writeFileSync(join(planted, "claude"), `#!/bin/sh\necho x > '${marker}'\necho 9.9.9\n`, { mode: 0o755 });
    writeFileSync(join(real, "claude"), "#!/bin/sh\necho 0.0.1\n", { mode: 0o755 });
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("./reference/claude.mjs", import.meta.url))], { env: { ...process.env, PATH: [planted, real, process.env.PATH ?? ""].join(delimiter) }, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
    assert.equal(existsSync(marker), false, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`claude: ${join(real, "claude").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // The PATH a recorder hands its children holds no node_modules/.bin and no relative folder either.
    assert.equal(cc.safePath([planted, "rel", real, `${planted}/`].join(delimiter)), real);
    // claude-code.mjs's check imports markdown.mjs: neither imports the other to have the binary, which would
    // leave that import waiting on itself (Node: "unsettled top-level await").
    for (const file of ["markdown.mjs", "../eval/selftest.mjs", "claude.mjs"]) assert.doesNotMatch(readFileSync(new URL(`./reference/${file}`, import.meta.url), "utf8"), /from "\.\/claude-code\.mjs"|from "\.\.\/reference\/claude-code\.mjs"/, file);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("reference: every Actions YAML cell compares as recorded", async () => {
  const rec = ay.readRecord();
  assert.ok(rec.cells.length > 0, "test/reference/actions-yaml.json holds no cell");
  const lines = ay.moves(rec.cells, await openNodes());
  assert.equal(
    lines.join("\n"),
    "",
    `test/reference/actions-yaml.json: ${lines.length} comparison(s) moved. security.ci's YAML reader that gives a finding GitHub's reading does not hold, or misses one it holds, is fixed (a form it cannot follow is refused), or the cell says why ("refused: …", "stricter: …", "gap: <open node>", "invalid: …"), in the commit that moves it.`,
  );
});

test("reference: the Actions YAML record names GitHub's parser, pinned, and holds well-formed cells, each with GitHub's reading", () => {
  const rec = ay.readRecord();
  assert.equal(rec.parser, ay.parserName());
  assert.match(ay.PARSER.commit, /^[0-9a-f]{40}$/);
  assert.equal(ay.PARSER.repo, "https://github.com/actions/runner.git");
  for (const [p, id] of Object.entries(ay.PARSER.trees)) assert.match(id, /^[0-9a-f]{40}$/, p);
  assert.deepEqual(Object.keys(ay.PARSER.trees).sort(), ["src/Directory.Build.props", "src/NuGet.Config", "src/Sdk", "src/global.json"]);
  assert.match(ay.PARSER.image, /^mcr\.microsoft\.com\/dotnet\/sdk:8\.0\.425-[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
  // The build restores in locked mode: every package the SDK takes, YamlDotNet among them, is held to its hash.
  const lock = JSON.parse(readFileSync(new URL("./reference/actions-yaml/packages.lock.json", import.meta.url), "utf8"));
  const yaml = lock.dependencies["net8.0"]["YamlDotNet.Signed"];
  assert.equal(`YamlDotNet.Signed ${yaml.resolved}`, ay.PARSER.yamlDotNet);
  for (const [name, d] of Object.entries(lock.dependencies["net8.0"])) if (/** @type {any} */ (d).type !== "Project") assert.match(/** @type {any} */ (d).contentHash, /^[A-Za-z0-9+/]{86}==$/, name);
  assert.match(readFileSync(new URL("./reference/actions-yaml/Test.csproj", import.meta.url), "utf8"), /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/);
  const ids = rec.cells.map((c) => c.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "an id twice");
  const texts = rec.cells.map((c) => c.text);
  assert.deepEqual(rec.cells.filter((c, i) => texts.indexOf(c.text) !== i).map((c) => c.id), [], "a text twice");
  assert.deepEqual(rec.cells.flatMap(ay.cellProblems), []);
  for (const c of rec.cells) assert.ok(c.github, `${c.id}: no reading`);
  // The record holds each relation, and readings GitHub runs as well as ones it refuses.
  const seen = new Set(rec.cells.map((c) => ay.judge(c).relation));
  for (const want of ay.RELATIONS) assert.ok(seen.has(want), want);
  assert.ok(rec.cells.some((c) => c.github?.yaml && !c.github.workflow.length) && rec.cells.some((c) => c.github?.yaml && c.github.workflow.length));
});

test("reference: every workflow text of the security.ci verdicts corpus has GitHub's reading in the Actions YAML record", () => {
  const verdicts = JSON.parse(readFileSync(new URL("./verdicts/ci.json", import.meta.url), "utf8"));
  const texts = new Set(ay.readRecord().cells.map((c) => c.text));
  /** @type {string[]} */
  const missing = [];
  for (const v of verdicts) {
    const files = [v.workflow, v.head, ...Object.entries({ ...v.files, ...(typeof v.head === "object" ? v.head : {}) }).filter(([p]) => /^\.github\/workflows\/[^/]+$/.test(p)).map(([, t]) => t)];
    for (const t of files) if (typeof t === "string" && !texts.has(t)) missing.push(v.id);
  }
  assert.deepEqual(missing, [], "a workflow the verdicts corpus holds that the record does not: node test/reference/actions-yaml.mjs add <probes.json>");
});

test("reference control: the Actions YAML judge finds a reading that moved, place by place, in both of the hook's modes", () => {
  const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const s = (/** @type {number} */ l, /** @type {string} */ v) => ({ l, t: "s", v });
  /** GitHub's document of `on: <on> / permissions: {} / jobs: a: runs-on: x / steps: [<steps>]`, each step a mapping. @param {any[][]} steps */
  const doc = (steps, on = "push") => ({ l: 1, m: [[s(1, "on"), s(1, on)], [s(2, "permissions"), { l: 2, m: [] }], [s(3, "jobs"), { l: 4, m: [[s(4, "a"), { l: 5, m: [[s(5, "runs-on"), s(5, "x")], [s(6, "steps"), { l: 7, q: steps.map((pairs) => ({ l: 7, m: pairs })) }]] }]] }]] });
  const uses = (/** @type {string} */ v) => [[s(7, "uses"), s(7, v)]];
  const text = (/** @type {string} */ steps, on = "push") => `on: ${on}\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n${steps}`;
  const cell = (/** @type {string} */ t, /** @type {any} */ d, extra = {}) => ({ id: "x", from: "control", text: t, github: { yaml: d, workflow: [] }, ...extra });
  const one = (/** @type {any} */ c, /** @type {Set<string> | undefined} */ open = undefined) => ay.moves([c], open).join("\n");
  assert.equal(ay.judge(cell(text(`      - uses: a/b@${SHA}\n`), doc([uses(`a/b@${SHA}`)]))).relation, "agree");
  // GitHub reads an unpinned action where Ennyn reads a pinned one: the hook passes what it should refuse.
  assert.match(one(cell(text(`      - uses: a/b@${SHA}\n`), doc([uses("a/b@v1")]))), /^x: differs, recorded agree — Ennyn "workflow: nothing; callee: nothing", GitHub "workflow: unpinned a#0; callee: unpinned a#0"$/);
  // Place by place: one unpinned action each, in another step, is no agreement.
  assert.equal(ay.judge(cell(text(`      - uses: a/b@v1\n      - uses: a/b@${SHA}\n`), doc([uses(`a/b@${SHA}`), uses("a/b@v1")]))).relation, "differs");
  // Ennyn refuses what GitHub reads as pinned; a form Ennyn cannot follow; a text GitHub reads no document of.
  const stricter = cell(text("      - uses: a/b@v1\n"), doc([uses(`a/b@${SHA}`)]));
  assert.match(one(stricter), /^x: stricter, recorded agree/);
  assert.equal(one({ ...stricter, except: "stricter: a control" }), "");
  assert.equal(ay.judge(cell(text("      - uses: *nope\n"), doc([uses("a/b@v1")]))).relation, "refused");
  assert.equal(ay.judge({ id: "x", from: "control", text: "a", github: { yamlError: "x", workflow: ["x"] } }).relation, "unparsed");
  // The callee mode compares a pull request's checkout though the file's own trigger is no pull_request_target.
  const fetch = [[s(7, "run"), s(7, "git fetch origin pull/1/head")]];
  assert.equal(ay.judge(cell(text("      - run: git fetch origin pull/1/head\n"), doc([fetch]))).relation, "agree");
  assert.match(one(cell(text("      - run: git fetch origin\n"), doc([fetch]))), /differs, recorded agree — Ennyn "workflow: nothing; callee: nothing", GitHub "workflow: nothing; callee: pwn a#0 run"/);
  // The trigger in any case, and steps in their order, from GitHub's document alone.
  assert.ok(ay.githubPlaces(doc([fetch], "PULL_REQUEST_TARGET")).has("pull_request_target"));
  const placed = [[s(7, "uses"), s(7, `actions/checkout@${SHA}`)], [s(7, "with"), { l: 7, m: [[s(7, "repository"), s(7, "o/r")], [s(7, "path"), s(7, "d")]] }]];
  assert.ok(ay.githubPlaces(doc([placed, uses("./d/x")])).has("unpinned a#1"));
  assert.ok(!ay.githubPlaces(doc([uses("./d/x"), placed])).has("unpinned a#0"));
  // Each kind of finding is a place: a job with no permissions, a write-all, a callee.
  const bare = { l: 1, m: [[s(1, "on"), s(1, "push")], [s(3, "jobs"), { l: 4, m: [[s(4, "a"), { l: 5, m: [[s(5, "permissions"), s(5, "write-all")], [s(6, "uses"), s(6, "./w.yml")]] }], [s(7, "b"), { l: 8, m: [] }]] }]] };
  assert.deepEqual([...ay.githubPlaces(bare)].sort(), ["callee w.yml", "unpermitted b", "write-all a"]);
  // A difference is held only by an open node or by GitHub refusing the workflow, and every listed relation says why.
  const hole = cell(text(`      - uses: a/b@${SHA}\n`), doc([uses("a/b@v1")]));
  assert.equal(one({ ...hole, except: "gap: some-node" }, new Set(["some-node"])), "");
  assert.match(one({ ...hole, except: "gap: closed-node" }, new Set(["some-node"])), /x: names no open graph node: "?closed-node"?/);
  assert.match(one({ ...hole, except: "invalid: GitHub refuses it" }), /x: invalid, but GitHub runs the workflow/);
  assert.equal(one({ ...hole, except: "invalid: GitHub refuses it", github: { ...hole.github, workflow: ["Unexpected value"] } }), "");
  assert.match(one({ ...hole, except: "gap:" }), /x: .*gives no why/);
  // A cell holds GitHub's document or why it read none, never both or neither; what the judge prints is escaped.
  assert.deepEqual(ay.cellProblems({ id: "x", from: "control", text: "a", github: { workflow: [] } }), ["x: github is { yaml | yamlError, workflow: [errors] }"]);
  assert.deepEqual(ay.cellProblems({ id: "x", from: "control", text: "a", github: { yaml: doc([]), yamlError: "y", workflow: [] } }), ["x: github is { yaml | yamlError, workflow: [errors] }"]);
  assert.doesNotMatch(one({ ...hole, except: "gap: \u001b[31m" }, new Set()), /\u001b/);
});

test("reference: npm run test:reference runs every recorder's check, the runner that takes --claude last", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // npm hands a script's arguments to its last command alone: test/reference/claude.mjs forwards --claude to both of its checks.
  assert.equal(pkg.scripts["test:reference"], "node test/reference/npm.mjs check && node test/reference/markdown.mjs check && node test/reference/actions-yaml.mjs check && node test/reference/claude.mjs");
});
