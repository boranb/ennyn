/**
 * Reference differentials: a check that models another program's reading is replayed against that program's
 * recorded answers (test/reference/). The deps gate's reading of npm's lock and source spellings is compared,
 * place by place, with what npm 10 itself does with each cell (test/reference/npm.mjs records it); a comparison
 * that moved from the one the cell lists fails here. The record never asks the machine: `node
 * test/reference/npm.mjs check` does, and fails when the machine's npm reads a cell otherwise or is another
 * version. git's readings are replayed against git itself (test/git-oracle.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../core/config.mjs";
import { loadGraph } from "../plan/mechanization.mjs";
import { RECORD, RELATIONS, cellProblems, compare, moves, readRecord, unmeasuredOf } from "./reference/npm.mjs";

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
