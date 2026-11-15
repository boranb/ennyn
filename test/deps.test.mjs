import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_LIMIT, HELD_LIMIT, advisoriesOf, depsMessages, fetchJson, lockEntries, lockPath, newEntries, npmrcEntries, npmrcFindings, scriptsGuardDropped, judgeEntry, pathInside, pkgJson, pkgPathOf, folderKeys, reasonText, registryOf, registryResolver, registryVerdicts, shownSource, sourceForm, specSource, thresholdPercent } from "../checks/deps.mjs";
import { git, indexKinds } from "../core/git.mjs";
import { loadConfig, ConfigError } from "../core/config.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
/** Answers recorded from the real services on 2026-10-24 and cut down; each file names its request. */
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "deps");
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const DAY = 86400e3;
/** The registry's integrity of each recorded minimist version. */
const SEALS = Object.fromEntries(Object.entries(fixture("packument-minimist.json").versions).map(([v, m]) => [v, /** @type {any} */ (m).dist.integrity]));

/**
 * A local server; `handler` answers, every request is kept in `hits` (POST bodies in `bodies`).
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: string) => void} handler
 */
async function server(handler) {
  /** @type {string[]} */
  const hits = [];
  /** @type {string[]} */
  const bodies = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      if (body) bodies.push(body);
      handler(req, res, body);
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (s.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    bodies,
    close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r(undefined)))),
  };
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));

/**
 * The npm registry and its downloads API in one, from the recorded minimist answers: `times` moves a version's
 * publish time, `manifests` adds to a version's manifest, `paths` answers other paths ("hang" never answers).
 * @param {{ times?: Record<string, unknown>, manifests?: Record<string, object>, paths?: Record<string, number | "hang" | string | object> }} [opts]
 */
function npm({ times = {}, manifests = {}, paths = {} } = {}) {
  return server((req, res) => {
    const url = String(req.url);
    if (Object.hasOwn(paths, url)) {
      const p = paths[url];
      if (p === "hang") return;
      return typeof p === "number" ? send(res, p, { error: "x" }) : send(res, 200, p);
    }
    if (url === "/minimist" || url === "/@scope%2Fminimist") {
      const doc = fixture("packument-minimist.json");
      for (const [v, m] of Object.entries(manifests)) doc.versions[v] = { ...doc.versions[v], ...m };
      return send(res, 200, { ...doc, time: { ...doc.time, ...times } });
    }
    if (url === "/versions/minimist/last-week" || url === "/versions/@scope%2Fminimist/last-week") return send(res, 200, fixture("downloads-minimist.json"));
    send(res, 404, { error: "Not found" });
  });
}

/**
 * A lock entry resolved from `origin`'s own tarball of the package, sealed as the registry seals it (minimist)
 * or by a made-up digest.
 * @param {string} origin @param {string} name @param {string} version @param {Record<string, unknown>} [extra]
 */
const entry = (origin, name, version, extra = {}) => ({
  [`node_modules/${name}`]: { version, resolved: `${origin}/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: (name.endsWith("minimist") && SEALS[version]) || "sha512-x", ...extra },
});
/** The same entry under another place in the tree. @param {string} at @param {Record<string, unknown>} e */
const under = (at, e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [`node_modules/${at}/${k}`, v]));
/** @param {Record<string, unknown>} packages */
const lock = (packages) => `${JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "demo", version: "1.0.0" }, ...packages } }, null, 2)}\n`;
/** A rule with a long budget, so a loaded machine is no timeout; the budget tests set their own. @param {Record<string, unknown>} [deps] */
const rule = (deps = {}) => /** @type {import("../checks/deps.mjs").DepsRule} */ (loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-deps-cfg-")), env: {}, override: { security: { deps: { timeout: 120, ...deps } } } }).security.deps);
/** @param {{ reason: import("../checks/deps.mjs").Reason }} x */
const why = (x) => reasonText(x.reason, "en");

test("deps lock: entries under node_modules are read, links and the project's own folders are not; a lock it cannot read says why", () => {
  const text = lock({
    "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", hasInstallScript: true },
    "node_modules/@s/b": { version: "2.0.0", resolved: "https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz" },
    "node_modules/a/node_modules/c": { version: "3.0.0", resolved: "https://registry.npmjs.org/c/-/c-3.0.0.tgz" },
    "node_modules/alias": { name: "real", version: "4.0.0", resolved: "https://registry.npmjs.org/real/-/real-4.0.0.tgz" },
    "node_modules/d": { version: "5.0.0", inBundle: true },
    "node_modules\\win": { version: "6.0.0" },
    "node_modules/ws": { resolved: "packages/ws", link: true },
    "packages/ws": { name: "ws", version: "0.1.0" },
  });
  assert.deepEqual(
    lockEntries(text).entries?.map((e) => [e.key, e.name, e.version, e.scripts, e.bundled]),
    [
      ["node_modules/a", "a", "1.0.0", true, false],
      ["node_modules/@s/b", "@s/b", "2.0.0", false, false],
      ["node_modules/a/node_modules/c", "c", "3.0.0", false, false],
      ["node_modules/alias", "real", "4.0.0", false, false],
      // Bundled by the root project: npm still installs it (arborist's inDepBundle).
      ["node_modules/d", "d", "5.0.0", false, false],
      // A key written with a backslash, as npm on Windows reads it: no entry slips past.
      ["node_modules/win", "win", "6.0.0", false, false],
    ],
  );
  // npm reads packages whenever it is there, whatever lockfileVersion says (arborist's shrinkwrap.js).
  for (const v of ["2", "1", "4", '"3"', "null"]) assert.equal(lockEntries(text.replace('"lockfileVersion": 3', `"lockfileVersion": ${v}`)).entries?.length, 6, v);
  const benign = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-a" } }, packages: { "node_modules/evil": { version: "1.0.0", resolved: `git+ssh://git@github.com/o/evil.git#${SHA}` } } });
  assert.deepEqual(lockEntries(benign).entries?.map((e) => e.name), ["evil"]);
  // dependencies alone, under any version, is read as npm 6 wrote it.
  assert.deepEqual(lockEntries(JSON.stringify({ lockfileVersion: 3, dependencies: { a: { version: "1.0.0" } } })).entries?.map((e) => e.name), ["a"]);
  const key = (/** @type {string} */ t) => /** @type {any} */ (lockEntries(t)).unread?.key;
  assert.equal(key(`<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> side\n`), "notJson");
  assert.equal(key("[]"), "notObject");
  assert.equal(key('{"lockfileVersion": 3, "packages": []}'), "noPackages");
  assert.deepEqual(lockEntries('{"lockfileVersion": 3}'), { entries: [], links: [], specs: [], pkgUnread: [] });
  // A dependency's bundle, as npm decides it: the parent's bundleDependencies, its bundled entries' own trees,
  // a sibling's dependency it bundles; never the inBundle flag alone.
  const bundles = lockEntries(lock({
    "node_modules/p": { version: "1.0.0", bundleDependencies: ["a"] },
    "node_modules/p/node_modules/a": { version: "1.0.0", inBundle: true, dependencies: { c: "1" } },
    "node_modules/p/node_modules/a/node_modules/b": { version: "1.0.0", inBundle: true },
    "node_modules/p/node_modules/c": { version: "1.0.0", inBundle: true },
    "node_modules/p/node_modules/flagged": { version: "1.0.0", inBundle: true },
  })).entries ?? [];
  assert.deepEqual(bundles.map((e) => [e.key.replace(/^node_modules\/p\/node_modules\//, ""), e.bundled]), [["node_modules/p", false], ["a", true], ["a/node_modules/b", true], ["c", true], ["flagged", false]]);
  // The root's bundle is installed; a bundled sibling's dependency it holds a copy of is its own, not the parent's.
  const rooted = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root", bundleDependencies: ["d"] }, "node_modules/d": { version: "1.0.0", inBundle: true }, "node_modules/p": { version: "1.0.0", bundleDependencies: ["a"] }, "node_modules/p/node_modules/a": { version: "1.0.0", dependencies: { c: "1" } }, "node_modules/p/node_modules/a/node_modules/c": { version: "2.0.0" }, "node_modules/p/node_modules/c": { version: "1.0.0" } } })).entries ?? [];
  assert.deepEqual(rooted.map((e) => [e.key, e.bundled]), [["node_modules/d", false], ["node_modules/p", false], ["node_modules/p/node_modules/a", true], ["node_modules/p/node_modules/a/node_modules/c", true], ["node_modules/p/node_modules/c", false]]);
  // A version 1 lock: a top-level bundled entry is the root's, installed, and so is what it holds; a nested one comes
  // in its parent when the parent requires it, and is fetched when it does not.
  assert.deepEqual(lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: { top: { version: "1.0.0", bundled: true, requires: { inner: "1" }, dependencies: { inner: { version: "1.0.0", bundled: true } } }, mid: { version: "1.0.0", requires: { kept: "1" }, dependencies: { kept: { version: "1.0.0", bundled: true }, stray: { version: "1.0.0", bundled: true } } } } })).entries?.map((e) => [e.key, e.bundled]), [["node_modules/top", false], ["node_modules/top/node_modules/inner", false], ["node_modules/mid", false], ["node_modules/mid/node_modules/kept", true], ["node_modules/mid/node_modules/stray", false]]);
  // An entry that stops being bundled is new: npm now fetches it.
  const was = lockEntries(lock({ "node_modules/p": { version: "1.0.0", bundleDependencies: ["a"] }, "node_modules/p/node_modules/a": { version: "1.0.0" } })).entries ?? [];
  const now = lockEntries(lock({ "node_modules/p": { version: "1.0.0" }, "node_modules/p/node_modules/a": { version: "1.0.0" } })).entries ?? [];
  assert.deepEqual(newEntries(now, was).map((e) => e.key), ["node_modules/p/node_modules/a"]);
  // A field of another kind than npm reads is marked, and the raw value makes the entry new.
  const odd = lockEntries(lock({
    "node_modules/r": { version: "1.0.0", resolved: ["https://evil.example/r.tgz"] },
    "node_modules/v": { version: 1 },
    "node_modules/n": { version: "1.0.0", resolved: null, integrity: null },
    "node_modules/l": { resolved: "packages/l", link: "yes" },
    "node_modules/b": { version: "1.0.0", inBundle: "true" },
  }));
  assert.deepEqual([...(odd.entries ?? []), ...(odd.links ?? [])].map((e) => [e.name, e.odd?.field ?? null, e.odd?.kind ?? null]), [["r", "resolved", "array"], ["v", "version", "number"], ["n", null, null], ["b", "inBundle", "string"], ["l", "link", "string"]]);
  const plain = lockEntries(lock({ "node_modules/r": { version: "1.0.0" } })).entries ?? [];
  assert.equal(newEntries(odd.entries ?? [], plain).some((e) => e.name === "r"), true);
});

test("deps v1: a lockfileVersion 1 lock is read from its dependency tree, an alias as the package it is, no tree as an empty lock", () => {
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { esbuild: { version: "1.0.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-1.0.0.tgz", integrity: "sha512-e", dependencies: { inner: { version: "2.0.0", resolved: "https://registry.npmjs.org/inner/-/inner-2.0.0.tgz", integrity: "sha512-i" } } } } });
  const head = lockEntries(v1).entries ?? [];
  assert.deepEqual(head.map((e) => [e.key, e.name, e.version]), [["node_modules/esbuild", "esbuild", "1.0.0"], ["node_modules/esbuild/node_modules/inner", "inner", "2.0.0"]]);
  const v3 = lockEntries(lock({ "node_modules/esbuild": { version: "1.0.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-1.0.0.tgz", integrity: "sha512-e", hasInstallScript: true }, "node_modules/inner": { version: "2.0.0", resolved: "https://registry.npmjs.org/inner/-/inner-2.0.0.tgz", integrity: "sha512-i" } })).entries ?? [];
  assert.deepEqual(newEntries(v3, head), []);
  // It records no install scripts: the hook says so.
  assert.equal(lockEntries(v1).v1, true);
  const aliased = lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: { alias: { version: "npm:@s/real@5.0.0", resolved: "https://registry.npmjs.org/@s/real/-/real-5.0.0.tgz", integrity: "sha512-r" } } })).entries ?? [];
  assert.deepEqual(aliased.map((e) => [e.key, e.name, e.version]), [["node_modules/alias", "@s/real", "5.0.0"]]);
  assert.deepEqual(newEntries(lockEntries(lock({ "node_modules/alias": { name: "@s/real", version: "5.0.0", resolved: "https://registry.npmjs.org/@s/real/-/real-5.0.0.tgz", integrity: "sha512-r" } })).entries ?? [], aliased), []);
  // npm 6 writes no tree for a project with no dependencies: an empty lock, not one it cannot read.
  assert.deepEqual(lockEntries(JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 1 })), { entries: [], links: [], specs: [], pkgUnread: [] });
  // A version that is no exact version is the source itself, as npm converts it: lock.resolved is then ignored.
  const specs = lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: { g: { version: `git+https://github.com/o/g.git#${SHA}`, resolved: "https://registry.npmjs.org/g/-/g-1.0.0.tgz", integrity: "sha512-g" }, t: { version: "https://registry.npmjs.org/t/-/t-1.0.0.tgz", integrity: "sha512-t" }, d: { version: "file:packages/d" }, f: { version: "file:vendor/f-1.0.0.tgz", integrity: "sha512-f" }, o: { version: "1.0.0", from: "git+https://github.com/o/o.git" } } }));
  assert.deepEqual(specs.entries?.map((e) => [e.name, e.version, e.resolved, e.odd?.field ?? null]), [["g", "", `git+https://github.com/o/g.git#${SHA}`, null], ["t", "", "https://registry.npmjs.org/t/-/t-1.0.0.tgz", null], ["f", "", "file:vendor/f-1.0.0.tgz", null], ["o", "1.0.0", null, "from"]]);
  assert.deepEqual(specs.links?.map((e) => [e.name, e.resolved]), [["d", "packages/d"]]);
});

test("deps bundles: npm's own bundled tree, written by npm, is bundled entry for entry; an edge from deep inside a bundle counts, a flag counts where npm reads it back", async () => {
  // npm 10.9.7's lock for a project that depends on npm: 195 entries npm flags inBundle, none of them fetched.
  const real = fixture("lock-npm-bundled.json");
  const flagged = Object.entries(real.packages).filter(([, v]) => /** @type {any} */ (v).inBundle).map(([k]) => k);
  const read = lockEntries(JSON.stringify(real)).entries ?? [];
  assert.deepEqual(read.filter((e) => e.bundled).map((e) => e.key), flagged);
  // From the registry: the root then asks for that version, or npm would fetch its own tarball anew (refetch).
  real.packages["node_modules/npm"].resolved = "https://registry.npmjs.org/npm/-/npm-10.9.7.tgz";
  real.packages[""].dependencies.npm = "10.9.7";
  const judged = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(JSON.stringify(real)), head: Buffer.from(lock({})) }]]), rule({ online: false }), "en");
  assert.deepEqual(judged.errors, []);
  // Bundled by the parent through something it bundles at any depth: cross-spawn's own which depends on isexe,
  // which resolves to the parent's copy (npm's getBundler follows the edge).
  const deep = lockEntries(lock({
    "node_modules/p": { version: "1.0.0", bundleDependencies: ["cross-spawn"] },
    "node_modules/p/node_modules/cross-spawn": { version: "1.0.0", dependencies: { which: "1" } },
    "node_modules/p/node_modules/cross-spawn/node_modules/which": { version: "1.0.0", dependencies: { isexe: "1" } },
    "node_modules/p/node_modules/isexe": { version: "1.0.0" },
    // In a lock of version 2 or later npm reads no flag back (load-virtual.js only does so below version 2): fetched.
    "node_modules/q": { version: "1.0.0", dependencies: { f: "1" } },
    "node_modules/q/node_modules/f": { version: "1.0.0", inBundle: true },
    // A flag it does not: the parent has no edge to it.
    "node_modules/q/node_modules/g": { version: "1.0.0", inBundle: true },
    // The bundle list as npm normalizes it: the old spelling, true for every dependency, an object's keys.
    "node_modules/r": { version: "1.0.0", bundledDependencies: ["old"] },
    "node_modules/r/node_modules/old": { version: "1.0.0" },
    "node_modules/s": { version: "1.0.0", dependencies: { all: "1" }, bundleDependencies: true },
    "node_modules/s/node_modules/all": { version: "1.0.0" },
    "node_modules/t": { version: "1.0.0", bundleDependencies: { keyed: "1" } },
    "node_modules/t/node_modules/keyed": { version: "1.0.0" },
    "node_modules/u": { version: "1.0.0", bundleDependencies: [], bundledDependencies: ["shadowed"] },
    "node_modules/u/node_modules/shadowed": { version: "1.0.0" },
    // A dependency the parent does not bundle and the lock does not flag is installed.
    "node_modules/v": { version: "1.0.0", dependencies: { h: "1" } },
    "node_modules/v/node_modules/h": { version: "1.0.0" },
    // A devDependency is an edge of a top only, never of a bundled package.
    "node_modules/w": { version: "1.0.0", bundleDependencies: ["s"] },
    "node_modules/w/node_modules/s": { version: "1.0.0", devDependencies: { c: "1" } },
    "node_modules/w/node_modules/c": { version: "1.0.0" },
    // An edge from something another package bundles is no edge of this parent's bundle.
    "node_modules/x": { version: "1.0.0" },
    "node_modules/x/node_modules/z": { version: "1.0.0", bundleDependencies: ["inner"] },
    "node_modules/x/node_modules/z/node_modules/inner": { version: "1.0.0", dependencies: { c: "1" } },
    "node_modules/x/node_modules/c": { version: "1.0.0" },
  })).entries ?? [];
  // Below version 2 (npm 6, or none given) npm adds a flagged entry back to its parent's bundle when the parent depends on it.
  for (const version of [1, undefined, null]) {
    const old = lockEntries(JSON.stringify({ lockfileVersion: version, packages: { "": {}, "node_modules/q": { version: "1.0.0", dependencies: { f: "1" } }, "node_modules/q/node_modules/f": { version: "1.0.0", inBundle: true }, "node_modules/q/node_modules/g": { version: "1.0.0", inBundle: true } } })).entries ?? [];
    assert.deepEqual(old.filter((e) => e.bundled).map((e) => e.key), ["node_modules/q/node_modules/f"], String(version));
  }
  const v1 = lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: { q: { version: "1.0.0", requires: { f: "1" }, dependencies: { f: { version: "1.0.0", bundled: true }, g: { version: "1.0.0", bundled: true } } } } })).entries ?? [];
  assert.deepEqual(v1.filter((e) => e.bundled).map((e) => e.key), ["node_modules/q/node_modules/f"]);
  assert.deepEqual(deep.filter((e) => e.bundled).map((e) => e.key), ["node_modules/p/node_modules/cross-spawn", "node_modules/p/node_modules/cross-spawn/node_modules/which", "node_modules/p/node_modules/isexe", "node_modules/r/node_modules/old", "node_modules/s/node_modules/all", "node_modules/t/node_modules/keyed", "node_modules/w/node_modules/s", "node_modules/x/node_modules/z/node_modules/inner"]);
});

test("deps new: a package that moves in the tree is not new; a new version, a new package, one resolved elsewhere and a new integrity are, once each", () => {
  const head = lockEntries(lock({ ...entry("https://r.example", "a", "1.0.0"), ...entry("https://r.example", "b", "1.0.0") })).entries ?? [];
  const moved = lockEntries(lock({ ...entry("https://r.example", "a", "1.0.0"), ...under("x", entry("https://r.example", "b", "1.0.0")) })).entries ?? [];
  assert.deepEqual(newEntries(moved, head), []);
  const changed = lockEntries(lock({ ...entry("https://r.example", "a", "1.1.0"), ...entry("https://evil.example", "b", "1.0.0"), ...entry("https://r.example", "c", "1.0.0"), ...under("x", entry("https://r.example", "c", "1.0.0")) })).entries ?? [];
  assert.deepEqual(newEntries(changed, head).map((e) => `${e.name}@${e.version} ${new URL(String(e.resolved)).host}`), ["a@1.1.0 r.example", "b@1.0.0 evil.example", "c@1.0.0 r.example"]);
  const resealed = lockEntries(lock({ ...entry("https://r.example", "a", "1.0.0", { integrity: "sha512-other" }), ...entry("https://r.example", "b", "1.0.0") })).entries ?? [];
  assert.deepEqual(newEntries(resealed, head).map((e) => e.name), ["a"]);
});

test("deps identity: an entry is the registry's tarball of its own name and version, or it is refused; another source says why", () => {
  const r = rule();
  const e = (/** @type {Partial<import("../checks/deps.mjs").LockEntry>} */ x) => ({ key: "node_modules/a", name: "a", version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-x", scripts: false, bundled: false, ...x });
  assert.deepEqual(registryOf(e({}), r), { origin: "https://registry.npmjs.org", registry: "https://registry.npmjs.org" });
  assert.deepEqual(registryOf(e({ name: "@s/a", resolved: "https://registry.npmjs.org/@s%2fa/-/a-1.0.0.tgz" }), r), { origin: "https://registry.npmjs.org", registry: "https://registry.npmjs.org" });
  /** @param {Partial<import("../checks/deps.mjs").LockEntry>} x */
  const refused = (x) => {
    const w = /** @type {any} */ (registryOf(e(x), r));
    return [w.refuse === true, reasonText(w.reason, "en")];
  };
  // Another package's tarball under the name, another version, a query that changes what is fetched.
  assert.deepEqual(refused({ resolved: "https://registry.npmjs.org/evil/-/evil-0.0.1.tgz" }), [true, "resolved is /evil/-/evil-0.0.1.tgz, not /a/-/a-1.0.0.tgz"]);
  assert.deepEqual(refused({ version: "1.0.1" }), [true, "resolved is /a/-/a-1.0.0.tgz, not /a/-/a-1.0.1.tgz"]);
  // The file named as the entry's, under another package's directory: still another package's tarball.
  assert.deepEqual(refused({ resolved: "https://registry.npmjs.org/evil/-/a-1.0.0.tgz" }), [true, "resolved is /evil/-/a-1.0.0.tgz, not /a/-/a-1.0.0.tgz"]);
  assert.equal(refused({ resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz?x=1" })[0], true);
  assert.deepEqual(refused({ resolved: "https://registry.evil.example/a/-/a-1.0.0.tgz" }), [false, "from https://registry.evil.example, which security.deps.registries does not list"]);
  assert.deepEqual(refused({ resolved: "git+ssh://git@github.com/o/a.git#abc" }), [false, "from git+ssh://git@github.com/o/a.git, which security.deps.registries does not list"]);
  assert.deepEqual(refused({ name: "../x" }), [false, "not a package name a registry serves"]);
  assert.deepEqual(refused({ resolved: null, bundled: true }), [false, "bundled in another package"]);
  assert.deepEqual(refused({ version: "" }), [false, "no version"]);
  assert.equal(refused({ resolved: "https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz" })[0], false);
  // A registry under a path (Artifactory, Nexus) is the URL the config lists: right after it, npm's layout proves
  // the package, and that configured URL is what is asked. Another repository on the same host, a prefix the lock
  // spells (even on npmjs), or another layout (GitHub Packages) proves nothing: said, never refused, never asked.
  const prefixed = rule({ registries: { "https://corp.example/artifactory/api/npm/npm": null } });
  assert.deepEqual(registryOf(e({ name: "@s/a", resolved: "https://corp.example/artifactory/api/npm/npm/@s/a/-/a-1.0.0.tgz" }), prefixed), { origin: "https://corp.example", registry: "https://corp.example/artifactory/api/npm/npm" });
  const wrong = /** @type {any} */ (registryOf(e({ resolved: "https://corp.example/artifactory/api/npm/npm/evil/-/evil-0.0.1.tgz" }), prefixed));
  assert.deepEqual([wrong.refuse, reasonText(wrong.reason, "en")], [true, "resolved is /artifactory/api/npm/npm/evil/-/evil-0.0.1.tgz, not /artifactory/api/npm/npm/a/-/a-1.0.0.tgz"]);
  /** @param {string} resolved @param {import("../checks/deps.mjs").DepsRule} on */
  const unproven = (resolved, on) => {
    const w = /** @type {any} */ (registryOf(e({ resolved }), on));
    return [w.refuse, w.reason?.key];
  };
  assert.deepEqual(unproven("https://corp.example/artifactory/api/npm/attacker-repo/a/-/a-1.0.0.tgz", prefixed), [undefined, "unproven"]);
  // Registries nested in one another: the longest URL the tarball sits under is its registry.
  const nested = rule({ registries: { "https://corp.example/npm": null, "https://corp.example/npm/team": null } });
  assert.deepEqual(registryOf(e({ resolved: "https://corp.example/npm/team/a/-/a-1.0.0.tgz" }), nested), { origin: "https://corp.example", registry: "https://corp.example/npm/team" });
  assert.deepEqual(unproven("https://registry.npmjs.org/evil/a/-/a-1.0.0.tgz", r), [undefined, "unproven"]);
  assert.deepEqual(unproven("https://corp.example/download/@s/a/1.0.0/0123abcd", prefixed), [undefined, "unproven"]);
  const github = /** @type {any} */ (registryOf(e({ name: "@s/a", resolved: "https://corp.example/download/@s/a/1.0.0/0123abcd" }), prefixed));
  assert.equal(reasonText(github.reason, "en"), "/download/@s/a/1.0.0/0123abcd is in no layout that names the package and version, so its identity is not proven");
});

/** A full commit id. */
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("deps specs: every dependency spec npm may fetch from that is no registry spec is judged by its source, wherever npm reads one", async () => {
  // npm-package-arg's order: a path, an alias, git, a URL, a path again; the rest is the registry's (null).
  assert.deepEqual(
    ["^1.0.0", "1.0.0", "latest", "", "*", "x", "npm:a@1", "npm:@s/a@^2", " https://evil.example/a.tgz ", "github:u/a", "u/a", "vendor/a.tgz", "git+ssh://git@h.example/u/a.git", "file:vendor/a", "./vendor/a", "~/a", "/abs/a", "a.tgz", "a/b/c", "ftp://h/a.tgz", "workspace:*", ".", "..", "C:a"].map(specSource),
    [null, null, null, null, null, null, null, null, "https://evil.example/a.tgz", "github:u/a", "u/a", "vendor/a.tgz", "git+ssh://git@h.example/u/a.git", "file:vendor/a", "file:./vendor/a", "file:~/a", "file:/abs/a", "file:a.tgz", "file:a/b/c", "ftp://h/a.tgz", "workspace:*", "file:.", "file:..", "file:C:a"],
  );
  const R = "https://registry.npmjs.org";
  const reg = (/** @type {string} */ n) => ({ version: "1.0.0", resolved: `${R}/${n}/-/${n}-1.0.0.tgz`, integrity: "sha512-x" });
  const EVIL = "https://evil.example/a.tgz";
  /** @param {Record<string, any>} packages @param {any} [opts] */
  const specs = (packages, opts) => {
    const r = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }), opts);
    return (r.specs ?? []).map((e) => `${e.key} ${e.spec?.from} ${e.resolved}`).concat((r.pkgUnread ?? []).map((u) => `unread ${u.folder} ${u.reason.key}`));
  };
  // An entry's dependencies, optional and peer ones (not its dev ones); a registry spec is none of them.
  assert.deepEqual(specs({ "node_modules/p": { ...reg("p"), dependencies: { a: EVIL, b: "^1" }, optionalDependencies: { c: "github:u/c" }, peerDependencies: { d: "file:../d" }, devDependencies: { e: EVIL } }, "node_modules/a": reg("a") }), [`node_modules/a node_modules/p ${EVIL}`, "node_modules/c node_modules/p github:u/c", "node_modules/d node_modules/p file:../d"]);
  // The root's package.json, its dev dependencies and overrides at any depth ("$" names the root's own), else the lock's root entry.
  const pkg = JSON.stringify({ devDependencies: { a: EVIL }, overrides: { p: { ".": "github:u/p", a: "u/a2" }, "b@^1": "file:../b", c: "$c", "@s/e": "$@s/e", d: "1.0.0" } });
  assert.deepEqual(specs({ "node_modules/a": reg("a") }, { pkg }), [`node_modules/a package.json ${EVIL}`, "node_modules/a package.json u/a2", "node_modules/p package.json github:u/p", "node_modules/b package.json file:../b"]);
  assert.deepEqual(specs({ "": { dependencies: { a: EVIL } } }), [`node_modules/a package.json ${EVIL}`]);
  assert.deepEqual(specs({ "": { dependencies: { a: EVIL } } }, { pkg: null }), [`node_modules/a package.json ${EVIL}`]);
  // A folder the lock names outside node_modules (a workspace, a link's target): its package.json as npm reads it from disk, else the lock's entry.
  const folder = { "node_modules/w": { resolved: "packages/w", link: true }, "packages/w": { name: "w", version: "1.0.0", dependencies: { a: "^1" } }, "node_modules/a": reg("a") };
  assert.deepEqual(specs(folder), []);
  assert.deepEqual(specs(folder, { folders: (/** @type {string} */ k) => (k === "packages/w" ? JSON.stringify({ devDependencies: { a: EVIL } }) : undefined) }), [`node_modules/a packages/w ${EVIL}`]);
  // One that cannot be read is said so, never read as no dependencies; a byte order mark is no problem.
  assert.deepEqual(specs(folder, { folders: () => "{", pkg: { unread: { key: "symlink" } } }), ["unread  symlink", "unread packages/w notJson"]);
  assert.deepEqual(specs({}, { pkg: "[]" }), ["unread  notObject"]);
  assert.deepEqual(specs({}, { pkg: `\uFEFF${JSON.stringify({ dependencies: { a: EVIL } })}` }), [`node_modules/a package.json ${EVIL}`]);
  assert.deepEqual([pkgJson(null), pkgJson(Buffer.from("\uFEFF{}")), pkgJson(Buffer.from([0x7b, 0xe9, 0x7d])), pkgJson(Buffer.from("{}"), { key: "symlink" })], [null, "{}", { unread: { key: "notText" } }, { unread: { key: "symlink" } }]);
  // A version 1 lock: `requires` are an entry's dependencies.
  assert.equal(lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: { p: { version: "1.0.0", resolved: `${R}/p/-/p-1.0.0.tgz`, requires: { a: "github:u/a" } } } })).specs?.length, 1);
  // Judged as a resolved is, its paths read from the folder that asks: git refused, a listed tarball proven, a path inside proven.
  const judge = (/** @type {Record<string, any>} */ packages, /** @type {any} */ opts) => (lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }), opts).specs ?? []).map((e) => { const j = /** @type {any} */ (judgeEntry(e, rule({}), {})); return "inside" in j ? `inside ${j.inside}` : Object.keys(j)[0] === "refuse" ? `refused ${(j.reason.inner ?? j.reason).key}` : Object.keys(j)[0]; });
  assert.deepEqual(judge({ "node_modules/p": { ...reg("p"), dependencies: { a: "github:u/a", b: `${R}/b/-/b-1.0.0.tgz`, c: EVIL } } }), ["refused gitMoving", "listed", "refused from"]);
  assert.deepEqual(judge(folder, { folders: () => JSON.stringify({ dependencies: { a: "file:../a", b: "file:../../../b" } }) }), ["inside packages/a", "refused outside"]);

  // A spec its source proves is no lock entry: nothing of it is asked of a registry, no integrity is asked of it.
  const proven = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(lock({})), head: Buffer.from(lock({})) }], ["package.json", { staged: Buffer.from(JSON.stringify({ dependencies: { a: `${R}/a/-/a-1.0.0.tgz` } })), head: Buffer.from("{}") }]]), rule({ online: false }), "en");
  assert.deepEqual(proven.errors, []);
  // Said as who asks for what: a package.json read beside the lock, one that cannot be read refused, then said.
  const asked = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(lock({})), head: Buffer.from(lock({})) }], ["package.json", { staged: Buffer.from(JSON.stringify({ dependencies: { a: EVIL } })), head: Buffer.from("{}") }]]), rule({ online: false }), "en");
  assert.match(asked.errors.join("\n"), /package-lock\.json: 1 new entries come from a source the check cannot prove.*a ← package\.json \(from https:\/\/evil\.example/);
  const unreadable = (/** @type {Buffer | null} */ head) => depsMessages(new Map([["package-lock.json", { staged: Buffer.from(lock({})), head: Buffer.from(lock({})) }], ["package.json", { staged: Buffer.from([0x7b, 0xe9, 0x7d]), head }]]), rule({ online: false }), "en");
  assert.match((await unreadable(Buffer.from("{}"))).errors.join("\n"), /^package-lock\.json: npm reads package\.json \(not UTF-8 text\) for the dependencies it fetches, and the check could not/m);
  const still = await unreadable(Buffer.from([0x7b, 0xe9, 0x7d]));
  assert.deepEqual(still.errors, []);
  assert.match(still.warnings.join("\n"), /package-lock\.json was not checked against package\.json \(not UTF-8 text\)/);
  // A tag over an entry from no registry URL (a link, a file, git, none): npm fetches the tag from the registry. A
  // version, a range, an alias with none (`*`) or a tag over an entry from a URL is the registry's, held by validateLockfile.
  const tagged = (/** @type {string} */ spec, /** @type {any} */ entry) => specs({ "": { dependencies: { a: spec } }, "node_modules/a": entry, "vendor/a": { name: "a", version: "1.0.0" } });
  const fileEntry = { version: "1.0.0", resolved: "file:vendor/a-1.0.0.tgz" };
  assert.deepEqual(
    [tagged("latest", fileEntry), tagged("npm:evilpkg@latest", { resolved: "vendor/a", link: true }), tagged("next", { version: "1.0.0" }), tagged("latest", reg("a")), tagged("npm:evilpkg", fileEntry), tagged("^1.0.0", fileEntry), tagged("npm:evilpkg@^1", fileEntry), tagged("V2", fileEntry), tagged("x", fileEntry), tagged("x.1", fileEntry), tagged("v1", fileEntry)],
    [["node_modules/a package.json latest"], ["node_modules/a package.json npm:evilpkg@latest"], ["node_modules/a package.json next"], [], [], [], [], ["node_modules/a package.json V2"], [], [], []],
  );
  const [tagEntry] = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "latest" } }, "node_modules/a": fileEntry } })).specs ?? [];
  assert.equal(reasonText(/** @type {any} */ (judgeEntry(tagEntry, rule({}), {})).reason, "en"), "latest is a tag, and the lock's entry there comes from no registry URL (file:vendor/a-1.0.0.tgz): npm fetches the tag from the registry instead, which nothing here checks; write the lock again with npm");
  // `$` names the root's own spec in overrides only; in dependencies it is a spelling like any other.
  assert.deepEqual(specs({ "": { dependencies: { a: "$x/a.tgz" } } }), ["node_modules/a package.json $x/a.tgz"]);
  // sources may name a spec exactly as written, and a refusal says so; a bundled entry's specs are judged too
  // (npm asks a git one for its manifest, cloning it: recorded).
  const gitSpec = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { y: "github:x/y" } } } })).specs ?? [];
  assert.deepEqual(Object.keys(judgeEntry(gitSpec[0], rule({ sources: ["github:x/y"] }), {})), ["sourced", "sealed"]);
  assert.equal(reasonText(/** @type {any} */ (judgeEntry(gitSpec[0], rule({}), {})).reason, "en"), "github:x/y: not pinned to a full commit; listing this exact spec, github:x/y, in security.deps.sources is for the user to decide");
  assert.deepEqual(specs({ "node_modules/p": { ...reg("p"), bundleDependencies: ["c"], dependencies: { c: "*" } }, "node_modules/p/node_modules/c": { version: "1.0.0", inBundle: true, dependencies: { d: "github:u/d" } } }), ["node_modules/d node_modules/p/node_modules/c github:u/d"]);
  // A folder outside the lock's own is none npm reads; a path to one is read as the repository's.
  assert.deepEqual(folderKeys(JSON.stringify({ packages: { "": {}, "packages/w": {}, "../shared": {}, "./a/../b": {}, "node_modules/x": {}, "node_modules/l": { link: true }, "vendor/l": {} } })), ["packages/w", "./a/../b", "vendor/l"]);
  assert.deepEqual([pkgPathOf("app/package-lock.json", "./a/../b"), pkgPathOf("package-lock.json", "")], ["app/b/package.json", "package.json"]);
  assert.deepEqual(specs({ "node_modules/s": { resolved: "../shared", link: true }, "../shared": { name: "s", version: "1.0.0", dependencies: { a: EVIL } } }, { folders: () => JSON.stringify({ dependencies: { a: EVIL } }) }), []);
  // The folders' package.json files are read in one go, both sides together.
  /** @type {string[][]} */
  const batches = [];
  const ws = lock({ "node_modules/w1": { resolved: "packages/w1", link: true }, "packages/w1": { name: "w1", version: "1.0.0" }, "node_modules/w2": { resolved: "packages/w2", link: true }, "packages/w2": { name: "w2", version: "1.0.0" } });
  const batched = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(ws), head: Buffer.from(lock({})) }]]), rule({ online: false }), "en", { pkgRead: (paths) => (batches.push(paths), new Map(paths.map((p) => [p, { staged: p === "packages/w2/package.json" ? JSON.stringify({ dependencies: { a: EVIL } }) : "{}", head: null }]))) });
  assert.deepEqual(batches, [["packages/w1/package.json", "packages/w2/package.json"]]);
  assert.match(batched.errors.join("\n"), /a ← packages\/w2/);
  // An override does not lift a refusal, and the refusal says so.
  const over = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(lock({ "node_modules/p": { ...reg("p"), dependencies: { x: "github:u/x" } }, "node_modules/x": reg("x") })), head: Buffer.from(lock({})) }], ["package.json", { staged: Buffer.from(JSON.stringify({ dependencies: { p: "*" }, overrides: { x: "1.0.0" } })), head: Buffer.from("{}") }]]), rule({ online: false }), "en");
  assert.match(over.errors.join("\n"), /^package-lock\.json: an override in package\.json does not lift these refusals \(x ← node_modules\/p\)/m);
  // New against HEAD as a place and who asks: the same spec asked by another package is new.
  const byP = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/p": { ...reg("p"), dependencies: { a: "github:u/a" } }, "node_modules/a": reg("a") } })).specs ?? [];
  const byQ = lockEntries(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/q": { ...reg("q"), dependencies: { a: "github:u/a" } }, "node_modules/a": reg("a") } })).specs ?? [];
  assert.deepEqual([newEntries(byP, byP).length, newEntries(byQ, byP).length], [0, 1]);
});

test("deps verdicts by source: an entry passes only on a reading with one meaning; every other spelling npm reads is refused, whatever npm makes of it", () => {
  const r = rule({ registries: { "https://registry.npmjs.org": null, "https://corp.example/npm": null }, sources: [`git+ssh://git@github.com/o/listed.git#${SHA}`, "git+ssh://git@github.com/o/moving.git#main", "https://github.com/o/r.tgz", "https://mirror.example/x-1.0.0.tgz", "file:../shared/x.tgz", "../dir", "FILE:../y"] });
  const proven = registryResolver({ staged: Buffer.from("registry=https://registry.npmjs.org/\nscope=\n@corp:registry=https://corp.example/npm\n") });
  /** @param {Partial<import("../checks/deps.mjs").LockEntry>} x @param {string} [dir] @param {boolean} [link] */
  const verdict = (x, dir = "", link = false) => {
    const e = { key: "node_modules/x", name: "x", version: "1.0.0", resolved: null, integrity: "sha512-x", scripts: false, bundled: false, odd: null, ...x };
    const j = /** @type {any} */ (judgeEntry(e, r, { lockDir: dir, registry: e.resolved === null ? proven(e.name) : undefined, link }));
    return "listed" in j ? "listed" : "sourced" in j ? "sourced" : "inside" in j ? "inside" : "said" in j ? "said" : `refused ${j.refuse}`;
  };
  /** @type {[string | null, string, string][]} each npm 10.9.7 reads one way or another */
  const CORPUS = [
    ["https://registry.npmjs.org/x/-/x-1.0.0.tgz", "", "listed"],
    ["HTTPS://REGISTRY.NPMJS.ORG/x/-/x-1.0.0.tgz", "", "listed"],
    // Spellings a URL reads one way and npm another (a leading space is a file to npm, a tab is dropped by URL):
    [" https://registry.npmjs.org/x/-/x-1.0.0.tgz", "", "refused unlisted"],
    ["https://registry.npmjs.org/x/-/x-1.0.0.t\tgz", "", "refused unlisted"],
    ["https://registry.npmjs.org:443/x/-/x-1.0.0.tgz", "", "refused unlisted"],
    ["https:registry.npmjs.org/x/-/x-1.0.0.tgz", "", "refused unlisted"],
    ["https://evil.example/x-1.0.0.tgz", "", "refused unlisted"],
    ["http://registry.npmjs.org/x/-/x-1.0.0.tgz", "", "refused unlisted"],
    ["https://registry.npmjs.org./x/-/x-1.0.0.tgz", "", "refused unlisted"],
    ["https://registry.npmjs.org/evil/-/evil-1.0.0.tgz", "", "refused mismatch"],
    ["https://registry.npmjs.org/prefix/x/-/x-1.0.0.tgz", "", "said"],
    ["https://corp.example/download/x/1.0.0/abc", "", "said"],
    ["https://github.com/o/r/archive/main.tar.gz", "", "refused unlisted"],
    // git in every spelling, pinned or not
    [`git+ssh://git@github.com/o/r.git#${SHA}`, "", "refused git"],
    ["git+https://github.com/o/r.git#main", "", "refused git"],
    ["git://github.com/o/r.git", "", "refused git"],
    ["git+file:///srv/r.git", "", "refused git"],
    [`github:o/r#${SHA}`, "", "refused git"],
    ["gitlab:o/r", "", "refused git"],
    ["o/r", "", "refused git"],
    ["vendor/x.tgz", "", "refused git"],
    ["git@github.com:o/r.git", "", "refused git"],
    ["user:tok@github.com:o/r.git", "", "refused git"],
    ["ssh://git@github.com:o/r.git", "", "refused git"],
    ["https://github.com:o/r", "", "refused git"],
    ["https://github.com/o/r", "", "refused git"],
    // what npm reads as scp-like git on an unscoped name, or a registry spec: never the registry's tarball
    ["github.com:abc", "", "refused git"],
    // what npm reads as a path (test/reference/npm.json): no git named
    ["github.com:o/r", "", "refused unlisted"],
    ["~/x.tgz", "", "refused unlisted"],
    ["evil.example:payload", "", "refused git"],
    ["127.0.0.1:x", "", "refused git"],
    ["1.0.0", "", "refused unlisted"],
    ["latest", "", "refused unlisted"],
    ["npm:real@1.0.0", "", "refused unlisted"],
    // name@spec: npm reads the spec after the name
    ["foo@https://evil.example/x.tgz", "", "refused unlisted"],
    ["foo@git+file:///srv/r.git", "", "refused git"],
    ["foo@npm:evil@1.0.0", "", "refused unlisted"],
    ["foo@file:../x", "", "refused unlisted"],
    ["ftp://host.example/x.tgz", "", "refused unlisted"],
    ["foo:bar", "", "refused unlisted"],
    // a path: file: and a relative path inside the repository, nothing else
    ["file:vendor/x.tgz", "", "inside"],
    ["file:../x.tgz", "app", "inside"],
    ["file:vendor/@s/x-1.0.0.tgz", "", "inside"],
    ["file:%2e%2e/x", "", "inside"],
    ["file:../x.tgz", "", "refused unlisted"],
    ["file:/srv/x.tgz", "", "refused unlisted"],
    ["file:~/x", "", "refused unlisted"],
    ["file:C:/x", "", "refused unlisted"],
    ["file:a\\b", "", "refused unlisted"],
    ["FILE:vendor/x.tgz", "", "refused unlisted"],
    ["./x", "", "refused unlisted"],
    ["../x", "", "refused unlisted"],
    ["x.tgz", "", "refused unlisted"],
    ["a/b/c", "", "refused unlisted"],
    // sources: exact, and in a form with one reading
    [`git+ssh://git@github.com/o/listed.git#${SHA}`, "", "sourced"],
    ["git+ssh://git@github.com/o/moving.git#main", "", "refused git"],
    ["https://github.com/o/r.tgz", "", "refused git"],
    ["https://mirror.example/x-1.0.0.tgz", "", "sourced"],
    ["file:../shared/x.tgz", "", "sourced"],
    ["FILE:../y", "", "refused unlisted"],
  ];
  const wrong = CORPUS.filter(([resolved, dir, want]) => verdict({ resolved }, dir) !== want).map(([resolved, dir, want]) => `${JSON.stringify(resolved)} in ${JSON.stringify(dir)}: ${verdict({ resolved }, dir)}, not ${want}`);
  assert.deepEqual(wrong, []);
  // A path that leaves the repository is outside; one with a \ or a :, which npm on Windows reads otherwise, is notPortable, a link's too.
  const reason = (/** @type {string} */ resolved, link = false) => /** @type {any} */ (judgeEntry({ key: "node_modules/x", name: "x", version: link ? "" : "1.0.0", resolved, integrity: "sha512-x", scripts: false, bundled: false, odd: null }, r, { link })).reason?.key;
  assert.deepEqual(
    [reason("file:../x.tgz"), reason("file:vendor\\x.tgz"), reason("file:vendor:x.tgz"), reason("../x", true), reason("vendor\\x", true), reason("file:vendor/x", true), reason("file:../x\\y.tgz"), reason("/abs/a:b", true)],
    ["outside", "notPortable", "notPortable", "outside", "notPortable", "notPortable", "outside", "outside"],
  );
  // No resolved: an exact version and a name, from a registry the .npmrc names; anything else is refused.
  assert.deepEqual(
    [{}, { name: "@corp/y" }, { version: "1.0.0-rc.1+build.5" }, { version: "git+file:///srv/r.git" }, { version: "https://evil.example/x.tgz" }, { version: "^1.0.0" }, { name: "foo@https://evil.example/x#" }].map((x) => verdict(x)),
    ["listed", "listed", "listed", "refused unlisted", "refused unlisted", "refused unlisted", "refused unlisted"],
  );
  const reasonOf = (/** @type {Partial<import("../checks/deps.mjs").LockEntry>} */ x) => /** @type {any} */ (judgeEntry({ key: "node_modules/x", name: "x", version: "1.0.0", resolved: null, integrity: "sha512-x", scripts: false, bundled: false, ...x }, r, { registry: proven(x.name ?? "x") })).reason?.key;
  assert.deepEqual([reasonOf({ name: "foo@https://evil.example/x#" }), reasonOf({ version: "^1" })], ["noResolvedName", "noResolvedVersion"]);
  // The registry as npm-registry-fetch picks it: the package's own scope, the project's scope, then registry. What
  // the project leaves unset a user's config may set: an entry it would prove is said, one it refuses still refused.
  const picked = (/** @type {string} */ rc, /** @type {string} */ name) => {
    const j = /** @type {any} */ (judgeEntry({ key: `node_modules/${name}`, name, version: "1.0.0", resolved: null, integrity: "sha512-x", scripts: false, bundled: false }, r, { registry: registryResolver({ staged: Buffer.from(rc) })(name) }));
    return "listed" in j ? j.listed.resolved.replace(/\/[^/]+\/-\/.*$|\/@[^/]+\/[^/]+\/-\/.*$/, "") : `${"said" in j ? "said" : "refused"} ${(j.said ?? j.reason).key}`;
  };
  assert.deepEqual(
    [
      picked("registry=https://registry.npmjs.org/\n", "x"),
      picked("registry=https://registry.npmjs.org/\nscope=\n", "x"),
      picked("registry=https://evil.example/\nscope=@corp\n@corp:registry=https://corp.example/npm\n", "x"),
      picked("registry=https://registry.npmjs.org/\nscope=corp\n", "x"),
      picked("registry=https://registry.npmjs.org/\nscope=\n", "@other/x"),
      picked("registry=https://evil.example/\n@corp:registry=https://corp.example/npm\n", "@corp/x"),
      picked("scope=${S}\n@corp:registry=https://corp.example/npm\n", "@corp/x"),
      picked("registry=https://registry.npmjs.org/\nscope=\n@corp:registry=\n", "@corp/x"),
      picked("registry=https://evil.example/\n", "x"),
      picked("registry=https://registry.npmjs.org/\nscope=false\n@false:registry=https://corp.example/npm\n", "x"),
      picked("registry=https://registry.npmjs.org/\nscope[]=a\nscope[]=corp\n@corp:registry=https://corp.example/npm\n", "x"),
      picked('registry=https://registry.npmjs.org/\nscope="null"\n', "x"),
    ],
    ["said noResolvedUser", "https://registry.npmjs.org", "https://corp.example/npm", "said noResolvedUser", "said noResolvedUser", "https://corp.example/npm", "https://corp.example/npm", "https://registry.npmjs.org", "refused noResolvedUnlisted", "refused noResolvedPlain", "refused noResolvedPlain", "refused noResolvedPlain"],
  );
  // A name no registry serves, on a listed registry's tarball: refused, never said as another layout.
  assert.equal(verdict({ name: ".hidden", resolved: "https://registry.npmjs.org/.hidden/-/.hidden-1.0.0.tgz" }), "refused unlisted");
  // A tarball a listed registry proves needs an exact version, in the entry or in the file's name.
  assert.equal(verdict({ version: "^1.0.0", resolved: "https://registry.npmjs.org/x/-/x-^1.0.0.tgz" }), "refused unlisted");
  assert.equal(verdict({ version: "", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" }), "listed");
  // A link to a folder named like a tarball, which sources names: no integrity is asked of a link.
  assert.deepEqual(/** @type {any} */ (judgeEntry({ key: "node_modules/l", name: "l", version: "", resolved: "../dir", integrity: null, scripts: false, bundled: false }, rule({ sources: ["../dir.tgz", "../dir"] }), { link: true })).sealed, false);
  assert.deepEqual(/** @type {any} */ (judgeEntry({ key: "node_modules/l", name: "l", version: "", resolved: "../dir.tgz", integrity: null, scripts: false, bundled: false }, rule({ sources: ["../dir.tgz"] }), { link: true })).sealed, false);
  assert.equal(verdict({}, "", false), "listed");
  const none = /** @type {any} */ (judgeEntry({ key: "node_modules/x", name: "x", version: "1.0.0", resolved: null, integrity: "sha512-x", scripts: false, bundled: false }, r, { registry: registryResolver(undefined)("x") }));
  assert.equal(reasonText(none.reason, "en"), "no resolved URL and no .npmrc beside the lock naming its registry: add the line registry=https://registry.npmjs.org/ to .npmrc");
  // A field of another kind than npm reads is refused, never read as absent.
  for (const odd of [{ field: "resolved", kind: "array" }, { field: "resolved", kind: "object" }, { field: "version", kind: "number" }, { field: "link", kind: "string" }]) assert.equal(verdict({ odd, resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" }), "refused unlisted");
  // A link is a directory, never a spec: packages/a is the project's own folder, not a GitHub repository.
  assert.deepEqual([verdict({ resolved: "packages/a" }, "", true), verdict({ resolved: "../shared" }, "app", true), verdict({ resolved: "../shared" }, "", true), verdict({ resolved: "/srv/shared" }, "", true), verdict({ resolved: "../dir" }, "", true), verdict({ resolved: null }, "", true)], ["inside", "inside", "refused unlisted", "refused unlisted", "sourced", "inside"]);
  assert.deepEqual([pathInside("packages/a", ""), pathInside("a/../../x", ""), pathInside("C:\\x", "")], [true, false, false]);
  // The forms sources honors.
  assert.deepEqual([`git+https://github.com/o/r.git#${SHA}`, "git+https://github.com/o/r.git", "git+ssh://git@github.com/o/r.git#ABC", "https://mirror.example/x.tgz", "https://mirror.example/x.tgz#frag", "HTTPS://mirror.example/x.tgz", "https://gist.github.com/x.tgz", "file:../x", "file:C:/x", "../x", "/srv/x", "x", "o/r"].map(sourceForm), ["git", null, null, "tarball", null, null, null, "path", null, "path", "path", null, null]);
  assert.deepEqual(["git+https://github.com/o/r.git#abc", "https://mirror.example/a/../x.tgz"].map(sourceForm), [null, null]);
  // No credential is shown: a password with @, a query token, a token as the user of a scheme-less source.
  assert.deepEqual(
    ["https://user:p@ss@host.example/x.tgz", "https://host.example/x.tgz?access_token=s3cret&a=1", "TOKEN@github.com:o/r.git", "user:pw@github.com/o/r", "git+ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "npm:real@1.0.0"].map(shownSource),
    ["https://…@host.example/x.tgz", "https://host.example/x.tgz?access_token=…&a=…", "…@github.com:o/r.git", "…@github.com/o/r", "git+ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "npm:real@1.0.0"],
  );
});

test("deps sources: an entry from a place no list names fails, a git dependency fails unless sources names it pinned, a path outside the repository fails, and sources lets through only exact, sealed entries", async () => {
  const LISTED = "https://registry.example";
  const r = rule({ registries: { [LISTED]: null }, online: false });
  const withSources = rule({ registries: { [LISTED]: null }, online: false, sources: [`git+ssh://git@github.com/o/pinned.git#${SHA}`, "git+ssh://git@github.com/o/moving.git#main", "https://mirror.example/sealed-1.0.0.tgz", "https://mirror.example/open-1.0.0.tgz", "file:../shared/x.tgz", "../linked"] });
  /** @param {string} text @param {import("../checks/deps.mjs").DepsRule} on @param {string} [path] */
  const check = (text, on, path = "package-lock.json") => depsMessages(new Map([[path, { staged: Buffer.from(text), head: Buffer.from(lock({})) }]]), on, "en");
  const brought = lock({
    "node_modules/tarball": { version: "1.0.0", resolved: "https://evil.example/tarball-1.0.0.tgz", integrity: "sha512-x" },
    "node_modules/plain": { version: "1.0.0", resolved: "http://evil.example/plain-1.0.0.tgz", integrity: "sha512-x" },
    "node_modules/pinned": { version: "1.0.0", resolved: `git+ssh://git@github.com/o/pinned.git#${SHA}` },
    "node_modules/moving": { version: "1.0.0", resolved: "git+ssh://git@github.com/o/moving.git#main" },
    "node_modules/hosted": { version: "1.0.0", resolved: "github:o/hosted", integrity: "sha512-x" },
    "node_modules/scp": { version: "1.0.0", resolved: `git@github.com:o/scp.git#${SHA}` },
    "node_modules/far": { version: "1.0.0", resolved: "file:../shared/x.tgz", integrity: "sha512-x" },
    "node_modules/near": { version: "1.0.0", resolved: "file:vendor/near-1.0.0.tgz", integrity: "sha512-x" },
    "node_modules/aliased": { version: "1.0.0", resolved: "npm:real@1.0.0", integrity: "sha512-x" },
    "node_modules/odd": { version: "1.0.0", resolved: "ftp://host.example/odd.tgz", integrity: "sha512-x" },
    "node_modules/linked": { resolved: "../linked", link: true },
    "node_modules/workspace": { resolved: "packages/workspace", link: true },
    "node_modules/sealed": { version: "1.0.0", resolved: "https://mirror.example/sealed-1.0.0.tgz", integrity: "sha512-x" },
    "node_modules/open": { version: "1.0.0", resolved: "https://mirror.example/open-1.0.0.tgz" },
  });
  const none = await check(brought, r);
  // Nothing listed: every place no list names is refused, git apart; a file the repository holds is said.
  assert.equal(none.errors.find((e) => /cannot prove/.test(e)), "package-lock.json: 8 new entries come from a source the check cannot prove, and nothing measured them: aliased@1.0.0 (npm:real@1.0.0: neither a listed registry's tarball nor a path inside the repository: install it from a listed registry; listing this exact resolved in security.deps.sources is for the user to decide), far@1.0.0 (file:../shared/x.tgz: outside the repository: listing this exact resolved in security.deps.sources is for the user to decide), linked (../linked: outside the repository: listing this exact resolved in security.deps.sources is for the user to decide), and 5 more");
  assert.equal(none.errors.find((e) => /git dependencies/.test(e)), "package-lock.json: 4 new entries are git dependencies, which npm builds by running their prepare script, even with ignore-scripts, and checks no integrity: hosted@1.0.0 (github:o/hosted: not pinned to a full commit), moving@1.0.0 (git+ssh://git@github.com/o/moving.git#main: not pinned to a full commit), pinned@1.0.0 (git+ssh://git@github.com/o/pinned.git#0123456789abcdef0123456789abcdef01234567), and 1 more; listing the exact resolved, pinned to a full commit, in security.deps.sources is for the user to decide");
  assert.ok(none.warnings.some((w) => /near@1\.0\.0/.test(w) && /a file the repository holds/.test(w)), none.warnings.join("\n"));
  assert.ok(![...none.errors, ...none.warnings].some((x) => /workspace/.test(x)), "a link inside the repository is the project's own code");
  // Listed in sources: exact, sealed or pinned entries pass; a moving git ref and an unsealed tarball do not.
  const listed = await check(brought, withSources);
  assert.match(listed.errors.find((e) => /git dependencies/.test(e)) ?? "", /^package-lock\.json: 3 new entries are git dependencies.*: hosted@1\.0\.0 \(github:o\/hosted: not pinned to a full commit\), moving@1\.0\.0 \(git\+ssh:\/\/git@github\.com\/o\/moving\.git#main: not pinned to a full commit\), scp@1\.0\.0/);
  assert.match(listed.errors.find((e) => /cannot prove/.test(e)) ?? "", /^package-lock\.json: 4 new entries come from a source the check cannot prove.*: aliased@1\.0\.0 .*, odd@1\.0\.0 .*, plain@1\.0\.0 .*and 1 more/);
  assert.match(listed.errors.find((e) => /new entries have no integrity/.test(e)) ?? "", /1 new entries have no integrity.*: open@1\.0\.0/);
  assert.ok(![...listed.errors, ...listed.warnings].some((x) => /pinned@|sealed@|far@|linked/.test(x)), [...listed.errors, ...listed.warnings].join("\n"));
  // Credentials in a git URL are never shown, in a URL or scp-like.
  const token = await check(lock({ "node_modules/t": { version: "1.0.0", resolved: `git+https://user:s3cret@github.com/o/t.git#${SHA}` }, "node_modules/u": { version: "1.0.0", resolved: `user:s3cret@github.com:o/u.git#${SHA}` } }), r);
  assert.ok(!JSON.stringify(token).includes("s3cret"), JSON.stringify(token));
  assert.match(token.errors.join("\n"), /2 new entries are git dependencies/);
  // A directory outside the repository has no integrity to need; a tarball named twice by one algorithm still fails;
  // a listed host's tarball in another layout passes once sources names it.
  const more = rule({ registries: { [LISTED]: null }, online: false, sources: ["file:../dir", "https://mirror.example/twice-1.0.0.tgz", `${LISTED}/download/@s/p/1.0.0/abc`] });
  const extra = await check(lock({ "node_modules/dir": { version: "1.0.0", resolved: "file:../dir" }, "node_modules/twice": { version: "1.0.0", resolved: "https://mirror.example/twice-1.0.0.tgz", integrity: "sha512-a sha512-b" }, "node_modules/@s/p": { version: "1.0.0", resolved: `${LISTED}/download/@s/p/1.0.0/abc`, integrity: "sha512-x" } }), more);
  assert.deepEqual(extra.errors.length, 1, extra.errors.join("\n"));
  assert.match(extra.errors[0], /1 new entries hold two digests of one algorithm.*twice@1\.0\.0/);
  assert.deepEqual(extra.warnings, []);
  // Another layout on a listed registry (GitHub Packages' /download/…): the registry is the project's, only the identity is unproven: said.
  const ghp = await check(lock({ "node_modules/@o/p": { version: "1.0.0", resolved: `${LISTED}/download/@o/p/1.0.0/abcdef`, integrity: "sha512-x" } }), r);
  assert.deepEqual(ghp.errors, []);
  assert.match(ghp.warnings.join("\n"), /\/download\/@o\/p\/1\.0\.0\/abcdef is in no layout that names the package and version/);
  // lockfileVersion 1 keeps the source in `version`: read as the spec it is.
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { g: { version: `git+https://github.com/o/g.git#${SHA}`, from: "git+https://github.com/o/g.git" }, t: { version: "https://evil.example/t-1.0.0.tgz", integrity: "sha512-x" }, f: { version: "file:../f" } } });
  const old = await check(v1, r);
  // A version 1 tarball URL on a listed registry is that registry's tarball, its version from the file's name.
  const v1url = await check(JSON.stringify({ lockfileVersion: 1, dependencies: { x: { version: `${LISTED}/x/-/x-1.0.0.tgz`, integrity: "sha512-x" } } }), r);
  assert.deepEqual(v1url.errors, []);
  // A version 1 entry whose version is a source is that source, as npm converts it: its resolved is ignored.
  const both = await check(JSON.stringify({ lockfileVersion: 1, dependencies: { b: { version: "https://evil.example/b-1.0.0.tgz", resolved: `${LISTED}/b/-/b-1.0.0.tgz`, integrity: "sha512-x" } } }), r);
  assert.match(both.errors.join("\n"), /1 new entries come from a source the check cannot prove.*b \(from https:\/\/evil\.example: listing that registry/);
  assert.match(old.errors.find((e) => /git dependencies/.test(e)) ?? "", /1 new entries are git dependencies.*: g \(git\+https:\/\/github\.com\/o\/g\.git#0123/);
  assert.match(old.errors.find((e) => /cannot prove/.test(e)) ?? "", /2 new entries come from a source the check cannot prove.*: f \(\.\.\/f: outside the repository: listing this exact resolved in security\.deps\.sources is for the user to decide\), t \(from https:\/\/evil\.example: listing that registry/);
  // A link that moves out of the repository is new; one HEAD already holds is not.
  const before = lock({ "node_modules/linked": { resolved: "../linked", link: true } });
  const kept = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(before), head: Buffer.from(before) }]]), r, "en");
  assert.deepEqual(kept.errors, []);
});

test("deps no resolved: an entry with no resolved URL is the tarball of the registry the .npmrc beside the lock names, as the commit holds it; with none, or one it cannot tell, it is refused and nothing is asked", async () => {
  const reg = await npm({ times: { "1.2.7": new Date(Date.now() - 2 * DAY).toISOString() } });
  try {
    const r = rule({ registries: { [reg.origin]: reg.origin } });
    /** @param {Record<string, string>} files lock files new, .npmrc files as HEAD holds them */
    const at = (files) => depsMessages(new Map(Object.entries(files).map(([p, t]) => [p, { staged: Buffer.from(t), head: Buffer.from(p.endsWith(".npmrc") ? t : lock({})) }])), r, "en");
    const bare = lock({ "node_modules/minimist": { version: "1.2.7", integrity: SEALS["1.2.7"] } });
    const named = await at({ "package-lock.json": bare, ".npmrc": `registry=${reg.origin}/\nscope=\n` });
    assert.match(named.errors.join("\n"), /1 new versions are younger than 7 days.*minimist@1\.2\.7/);
    assert.ok(reg.hits.includes("GET /minimist"));
    // With no scope line a user's config may send it elsewhere: said, and not asked.
    const unscoped = await at({ "package-lock.json": bare, ".npmrc": `registry=${reg.origin}/\n` });
    assert.deepEqual(unscoped.errors, []);
    assert.match(unscoped.warnings.join("\n"), /minimist@1\.2\.7|\.npmrc leaves scope unset/);
    // None beside the lock (one in another directory is not the one npm reads for it): npm would ask what a user's
    // config names, which the check does not read; refused, and no name leaves the machine.
    const before = reg.hits.length;
    const unnamed = await at({ "package-lock.json": bare, "other/.npmrc": `registry=${reg.origin}/\n` });
    assert.match(unnamed.errors.join("\n"), /1 new entries come from a source the check cannot prove.*minimist@1\.2\.7 \(no resolved URL and no \.npmrc beside the lock naming its registry/);
    assert.equal(reg.hits.length, before);
    // The advice names the line and the file to write it in.
    const nested = await at({ "app/package-lock.json": bare });
    assert.match(nested.errors.join("\n"), new RegExp(`add the line registry=${reg.origin.replace(/[.]/g, "\\.")}/ to app/\\.npmrc`));
    // A scope's registry is the one for its packages; the lock in a directory reads the .npmrc there.
    const scoped = await at({ "app/package-lock.json": lock({ "node_modules/@scope/minimist": { version: "1.2.7", integrity: SEALS["1.2.7"] } }), "app/.npmrc": `registry=https://evil.example/\n@scope:registry=${reg.origin}\n` });
    assert.match(scoped.errors.join("\n"), /app\/package-lock\.json: 1 new versions are younger than 7 days.*@scope\/minimist@1\.2\.7/);
    // npm reads a key as written: REGISTRY is none of npm's.
    const upper = await at({ "package-lock.json": bare, ".npmrc": `REGISTRY=${reg.origin}/\nregistry=https://evil.example/\nregistry=${reg.origin}\nscope=\n` });
    assert.match(upper.errors.join("\n"), /younger than 7 days/, "the last registry line wins");
    const ignored = await at({ "package-lock.json": bare, ".npmrc": `REGISTRY=${reg.origin}/\n` });
    assert.match(ignored.errors.join("\n"), /no \.npmrc beside the lock naming its registry/);
    // A registry from the environment, or no URL, cannot be told: refused, never asked of a guess.
    const quiet = reg.hits.length;
    for (const [rc, why] of [["registry=${NPM_REGISTRY}\n", "is set from the environment"], ["${KEY}=x\n", "is set from the environment"], ["registry=not a url\n", "is not a URL"]]) {
      const told = await at({ "package-lock.json": bare, ".npmrc": rc });
      assert.match(told.errors.join("\n"), new RegExp(`minimist@1\\.2\\.7 \\(no resolved URL and .*${why}`), rc);
    }
    assert.equal(reg.hits.length, quiet);
    // An empty resolved is none, as npm reads it; a registry under a [section] is none of npm's.
    assert.match((await at({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.7", resolved: "", integrity: SEALS["1.2.7"] } }), ".npmrc": `registry=${reg.origin}\nscope=\n` })).errors.join("\n"), /younger than 7 days/);
    assert.match((await at({ "package-lock.json": bare, ".npmrc": `[x]\nregistry=${reg.origin}\n` })).errors.join("\n"), /no \.npmrc beside the lock naming its registry/);
    // A registry with a query is no registry a list names.
    assert.match((await at({ "package-lock.json": bare, ".npmrc": `registry=${reg.origin}/?x=1\n` })).errors.join("\n"), /npm asks .*\?x=… for it/);
    // The commit deletes the .npmrc beside the lock: no file names a registry, which is not a file that cannot be read.
    const deleted = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(bare), head: Buffer.from(lock({})) }], [".npmrc", { staged: null, head: Buffer.from(`registry=${reg.origin}\n`) }]]), r, "en");
    assert.match(deleted.errors.join("\n"), /no \.npmrc beside the lock naming its registry/);
    // .npmrc and .NPMRC beside one lock: npm opens .npmrc.
    const cased = await at({ "package-lock.json": bare, ".NPMRC": "registry=https://evil.example/\n", ".npmrc": `registry=${reg.origin}\nscope=\n` });
    assert.match(cased.errors.join("\n"), /younger than 7 days/);
    // allowScripts names a package the registry npm asks proves: its install script is allowed.
    const scripted = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(lock({ "node_modules/minimist": { version: "1.2.8", integrity: SEALS["1.2.8"], hasInstallScript: true } })), head: Buffer.from(lock({})) }], [".npmrc", { staged: Buffer.from(`registry=${reg.origin}\nscope=\n`), head: Buffer.from(`registry=${reg.origin}\n`) }]]), rule({ registries: { [reg.origin]: reg.origin }, allowScripts: ["minimist"] }), "en");
    assert.ok(!scripted.errors.some((e) => /install scripts/.test(e)), scripted.errors.join("\n"));
    // A resolved holding a version or a tag is a registry spec npm resolves itself: refused.
    const tagged = await at({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.8", resolved: "latest", integrity: SEALS["1.2.8"] } }), ".npmrc": `registry=${reg.origin}\n` });
    assert.match(tagged.errors.join("\n"), /1 new entries come from a source the check cannot prove.*minimist@1\.2\.8 \(latest: neither/);
    // The .npmrc beside the lock that cannot be read, as HEAD holds it: its entries unmeasured, said, never refused and never clean.
    const link = { staged: null, head: null, unread: /** @type {const} */ ("symlink"), headUnread: /** @type {const} */ ("symlink"), oid: "a".repeat(40), headOid: "a".repeat(40) };
    const unread = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(bare), head: Buffer.from(lock({})) }], [".npmrc", link]]), r, "en");
    assert.deepEqual(unread.errors, []);
    assert.match(unread.warnings.join("\n"), /unmeasured for 1 new versions \(no resolved URL and the \.npmrc beside the lock could not be read\): minimist@1\.2\.7/);
    // The commit brings it (another target): refused, and its entries are still said.
    const retargeted = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(bare), head: Buffer.from(lock({})) }], [".npmrc", { ...link, oid: "b".repeat(40) }]]), r, "en");
    assert.deepEqual(retargeted.errors, [".npmrc: this commit brings a file the check cannot read (a symbolic link), and npm reads it all the same: what it makes npm install or run is not known; make it a plain UTF-8 file of at most 16 MB"]);
    assert.match(retargeted.warnings.join("\n"), /no resolved URL and the \.npmrc beside the lock could not be read/);
    // No object known on either side: nothing shows HEAD holds it as it is, so it counts as brought.
    const blind = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(bare), head: Buffer.from(lock({})) }], [".npmrc", { staged: null, head: null, unread: /** @type {const} */ ("symlink"), headUnread: /** @type {const} */ ("symlink") }]]), r, "en");
    assert.equal(blind.errors.length, 1);
    // The .npmrc a loader gives (one the commit does not stage) is read once per directory, and only when an entry needs it.
    let asked = 0;
    const loaded = (/** @type {string} */ text) => depsMessages(new Map([["package-lock.json", { staged: Buffer.from(text), head: Buffer.from(lock({})) }]]), r, "en", { beside: () => (asked++, { staged: Buffer.from(`registry=${reg.origin}\nscope=\n`) }) });
    await loaded(lock(Object.assign({}, ...["1.2.6", "1.2.7", "1.2.8"].map((v) => ({ [`node_modules/m${v}/node_modules/minimist`]: { version: v, integrity: SEALS[v] } })))));
    assert.equal(asked, 1);
    await loaded(lock(entry(reg.origin, "minimist", "1.2.8")));
    assert.equal(asked, 1);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: age, adoption, the registry's integrity and its manifest's scripts are each read; allowed and measured-clean entries are not found", async () => {
  const reg = await npm({ times: { "1.2.7": new Date(Date.now() - 2 * DAY).toISOString() }, manifests: { "1.2.6": { gypfile: true }, "1.2.5": { scripts: { postinstall: "x" } } } });
  try {
    const r = rule({ registries: { [reg.origin]: reg.origin } });
    const entries = lockEntries(lock({ ...entry(reg.origin, "minimist", "1.2.8"), ...under("x", entry(reg.origin, "minimist", "1.2.7")), ...under("y", entry(reg.origin, "minimist", "0.0.1")), ...under("z", entry(reg.origin, "minimist", "9.9.9")), ...under("w", entry(reg.origin, "minimist", "1.2.6")), ...under("u", entry(reg.origin, "minimist", "1.2.6", { integrity: `${SEALS["1.2.6"]} sha1-y`, hasInstallScript: true })), ...under("v", entry(reg.origin, "minimist", "1.2.5", { integrity: "sha512-not-the-registry-s" })), ...entry(reg.origin, "gone", "1.0.0") })).entries ?? [];
    const v = await registryVerdicts(entries, r);
    assert.deepEqual(v.young.map((y) => [y.entry.version, Math.round(y.tenths / 10)]), [["1.2.7", 2]]);
    // 45 downloads last week, 0.00% of minimist's (recorded): below both lines.
    assert.deepEqual(v.unadopted.map((u) => [u.entry.version, u.weekly]), [["0.0.1", 45]]);
    assert.deepEqual(v.tampered.map((x) => x.entry.version), ["1.2.5"]);
    assert.deepEqual(v.hiddenScripts.map((x) => x.entry.version).sort(), ["1.2.5", "1.2.6"]);
    assert.deepEqual(v.unread.map((u) => [u.entry.name, u.entry.version, why(u), u.part]).sort(), [["gone", "1.0.0", "not found (a private package, or none of that name)", "all"], ["minimist", "9.9.9", "the registry has no such version", "all"]]);
    // One packument and one downloads answer for the package, however many versions.
    assert.deepEqual(reg.hits.filter((h) => h.includes("minimist")).sort(), ["GET /minimist", "GET /versions/minimist/last-week"]);
    const allowed = await registryVerdicts(entries, { ...r, allow: ["minimist@1.2.7", "minimist@0.0.1"], allowScripts: ["minimist"] });
    assert.deepEqual([allowed.young.length, allowed.unadopted.length, allowed.hiddenScripts.length, allowed.tampered.length], [0, 0, 0, 1]);
    // Refused only when share and downloads are both low.
    assert.deepEqual((await registryVerdicts(entries, { ...r, minShare: 0.5, minWeekly: 1e9 })).unadopted.map((u) => u.entry.version).sort(), ["0.0.1", "1.2.5", "1.2.6", "1.2.6"]);
    assert.deepEqual((await registryVerdicts(entries, { ...r, minShare: 0.95, minWeekly: 0 })).unadopted.length, 0);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: exactly the cooldown is old enough, a publish time in the future counts as now, a zero total is no adoption", async () => {
  const published = Date.parse(fixture("packument-minimist.json").time["1.2.8"]);
  const reg = await npm({ times: { "1.2.7": new Date(published + 10 * DAY).toISOString() }, paths: { "/versions/minimist/last-week": { downloads: { "1.2.8": 0 } } } });
  try {
    const r = rule({ registries: { [reg.origin]: reg.origin } });
    const entries = lockEntries(lock({ ...entry(reg.origin, "minimist", "1.2.8"), ...under("x", entry(reg.origin, "minimist", "1.2.7")) })).entries ?? [];
    const at7 = await registryVerdicts(entries, r, { now: published + 7 * DAY });
    assert.deepEqual(at7.young.map((y) => [y.entry.version, y.tenths]), [["1.2.7", 0]]);
    assert.deepEqual(at7.unadopted.map((u) => [u.entry.version, u.weekly, u.total]), [["1.2.8", 0, 0]]);
    const before7 = await registryVerdicts(entries, r, { now: published + 7 * DAY - 1 });
    assert.deepEqual(before7.young.map((y) => y.entry.version).sort(), ["1.2.7", "1.2.8"]);
  } finally {
    await reg.close();
  }
});

test("deps messages: values under a line never print as the line, names come in order, and only adoption unmeasured says so", async () => {
  const published = Date.parse(fixture("packument-minimist.json").time["1.2.8"]);
  const reg = await npm({ paths: { "/versions/minimist/last-week": { downloads: { "1.2.8": 9999, other: 990001 } }, "/versions/err/last-week": 500, "/err": JSON.stringify(fixture("packument-minimist.json")).replaceAll('"minimist"', '"err"') } });
  try {
    const r = rule({ registries: { [reg.origin]: reg.origin }, minWeekly: 1e6 });
    const staged = lock({ ...entry(reg.origin, "zeta", "1.0.0", { hasInstallScript: true }), ...entry(reg.origin, "alpha", "1.0.0", { hasInstallScript: true }), ...entry(reg.origin, "minimist", "1.2.8"), ...entry(reg.origin, "err", "1.2.8", { integrity: SEALS["1.2.8"] }) });
    const young = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(staged), head: null }]]), r, "en", { now: published + 6.96 * DAY });
    assert.match(young.errors.join("\n"), /install scripts.*: alpha@1\.0\.0, zeta@1\.0\.0/);
    assert.match(young.errors.join("\n"), /younger than 7 days.*err@1\.2\.8 \(6\.9 days old\), minimist@1\.2\.8 \(6\.9 days old\)/);
    const old = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(staged), head: null }]]), r, "en", { now: published + 30 * DAY });
    // 9,999 of 1,000,000: 0.9999%, shown as 0.99% under the 1% line, never as 1.00%.
    assert.match(old.errors.join("\n"), /under 1% .*minimist@1\.2\.8 \(0\.99%; 9999\)/);
    assert.match(old.warnings.join("\n"), /package-lock\.json: adoption unmeasured for 1 new versions \(HTTP 500\): err@1\.2\.8/);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: a malformed answer is unread, never a crash; a scoped name is asked with its slash encoded; errors and no answer in time are said", async () => {
  const reg = await npm({
    times: { "1.2.8": { toString: 1 } },
    paths: { "/broken": "{not json", "/versions/err/last-week": 500, "/err": JSON.stringify(fixture("packument-minimist.json")).replaceAll('"minimist"', '"err"'), "/slow": "hang", "/odd": { versions: ["1.0.0"], time: "x" } },
  });
  try {
    const sealed = (/** @type {string} */ name) => entry(reg.origin, name, "1.2.8", { integrity: SEALS["1.2.8"] });
    const entries = lockEntries(lock({ ...entry(reg.origin, "@scope/minimist", "1.2.8"), ...entry(reg.origin, "broken", "1.0.0"), ...sealed("err"), ...entry(reg.origin, "slow", "1.0.0"), ...entry(reg.origin, "odd", "1.0.0") })).entries ?? [];
    const v = await registryVerdicts(entries, rule({ registries: { [reg.origin]: reg.origin }, timeout: 3 }));
    assert.deepEqual(v.young.length + v.unadopted.length + v.tampered.length, 0);
    assert.deepEqual(v.unread.map((u) => [u.entry.name, why(u), u.part]).sort(), [
      ["@scope/minimist", "the registry gives no publish time for this version", "age"],
      ["broken", "an answer that is not JSON", "all"],
      ["err", "HTTP 500", "adoption"],
      ["odd", "the registry has no such version", "all"],
      ["slow", "no answer within the 3 s budget", "all"],
    ]);
    assert.ok(reg.hits.includes("GET /@scope%2Fminimist"), reg.hits.join(", "));
    const none = await registryVerdicts(entries.slice(2, 3), rule({ registries: { [reg.origin]: null } }));
    assert.deepEqual(none.unread.map((u) => [why(u), u.part]), [[`no downloads API is listed for ${reg.origin}`, "adoption"]]);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: an answer that unpacks past the limit is unread within the budget, however small it travels", async () => {
  const bomb = gzipSync(Buffer.alloc(ANSWER_LIMIT + 1, 0x20));
  const reg = await server((req, res) => res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(bomb));
  try {
    const started = performance.now();
    const v = await registryVerdicts(lockEntries(lock(entry(reg.origin, "big", "1.0.0"))).entries ?? [], rule({ registries: { [reg.origin]: reg.origin }, timeout: 60 }));
    // Stopped by the limit, not by the budget.
    assert.deepEqual(v.unread.map(why), [`an answer past ${ANSWER_LIMIT / 1024 / 1024} MB`]);
    assert.ok(performance.now() - started < 60000, `${performance.now() - started} ms`);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: a redirect is not followed, and an origin no list names gets no request at all", async () => {
  const other = await npm();
  const listed = await server((req, res) => res.writeHead(302, { location: `${other.origin}/minimist` }).end());
  try {
    const sent = await registryVerdicts(lockEntries(lock(entry(listed.origin, "minimist", "0.0.1"))).entries ?? [], rule({ registries: { [listed.origin]: listed.origin } }));
    assert.equal(sent.unread.length, 1);
    const unlisted = await registryVerdicts(lockEntries(lock(entry(other.origin, "minimist", "0.0.1"))).entries ?? [], rule({ registries: { [listed.origin]: listed.origin } }));
    assert.deepEqual(unlisted.unread.map(why), [`from ${other.origin}, which security.deps.registries does not list`]);
    assert.deepEqual(other.hits, []);
  } finally {
    await listed.close();
    await other.close();
  }
});

test("deps budget: one time budget for every lock file of a commit", async () => {
  const reg = await npm({ paths: { "/slow": "hang", "/slower": "hang" } });
  try {
    // Given in reverse: the messages come in path order.
    const versions = new Map([
      ["b/package-lock.json", { staged: Buffer.from(lock(entry(reg.origin, "slower", "1.0.0"))), head: null }],
      ["a/package-lock.json", { staged: Buffer.from(lock(entry(reg.origin, "slow", "1.0.0"))), head: null }],
    ]);
    const started = performance.now();
    const r = await depsMessages(versions, rule({ registries: { [reg.origin]: reg.origin }, timeout: 1 }), "en");
    const took = performance.now() - started;
    assert.equal(r.warnings.filter((w) => /no answer within the 1 s budget/.test(w)).length, 2);
    assert.match(r.warnings[0], /^a\/package-lock\.json/);
    assert.ok(took < 1800, `${took} ms: a budget per lock file would take 2 s`);
  } finally {
    await reg.close();
  }
});

test("deps npmrc: read as npm's ini reads it; a registry no list names is refused in every spelling npm reads, other spellings are not", () => {
  const r = rule({ registries: { "https://registry.npmjs.org": null, "https://corp.example/artifactory/api/npm/npm": null } });
  // Each of these npm 10.9.7 read as the registry (npm config get registry, 2026-10-24).
  for (const text of [
    "registry=https://evil.example/\n",
    "# notes\rregistry=https://evil.example/\n",
    '"registry"=https://evil.example/\n',
    "registry ;x= https://evil.example/\n",
    '"@corp:registry"=https://evil.example/\n',
    'registry="https://registry.npmjs.org@evil.example/"\n',
    "  registry  =  https://evil.example/  ; comment\n",
    "'registry'='https://evil.example/'\n",
    "registry[]=https://evil.example/\n",
    "registry=https://registry.npmjs.org/\r\nregistry=https://evil.example/\n",
  ]) {
    assert.equal(npmrcFindings(text, r).refuse.length, 1, JSON.stringify(text));
  }
  // A refused line is shown without the credentials its URL holds.
  assert.deepEqual(npmrcFindings("registry=https://user:secret@evil.example/\n", r).refuse.map((x) => x.line), ["registry=https://…@evil.example/"]);
  // And these it did not: a section, an escape it keeps.
  for (const text of ["[sec]\nregistry=https://evil.example/\n", "reg\\istry=https://evil.example/\n"]) assert.deepEqual(npmrcFindings(text, r), { refuse: [], said: [] }, JSON.stringify(text));
  // A listed registry, under a path too (Artifactory, Nexus), a trailing slash aside, with credentials in the URL.
  assert.deepEqual(npmrcFindings("registry=https://registry.npmjs.org/\n@corp:registry=https://corp.example/artifactory/api/npm/npm/\nREGISTRY=https://user:token@registry.npmjs.org\n", r), { refuse: [], said: [] });
  // A scope line is judged as the registry it selects: unlisted refused, left to a user's config said.
  assert.deepEqual(npmrcFindings("@x:registry=https://evil.example/\nscope=x\n", r).refuse.map((x) => x.line), ["@x:registry=https://evil.example/", "scope=x"]);
  assert.deepEqual(npmrcFindings("scope=@x\n", r).said.map((x) => [x.line, x.reason.key]), [["scope=@x", "scopeUnset"]]);
  assert.deepEqual(npmrcFindings("scope=x\n@x:registry=https://registry.npmjs.org/\n", r), { refuse: [], said: [] });
  assert.deepEqual(npmrcFindings("scope=\nscope=false\n", r), { refuse: [], said: [] });
  // An empty registry is none to npm, which goes on to the scope's or the default one: no finding, a scope's either.
  assert.deepEqual(npmrcFindings("registry=\n@x:registry=\nscope=x\n", r), { refuse: [], said: [] });
  // Another path on a listed origin is another registry: npm asks /@evil/<name> for each package, and npmjs
  // answers with the scoped package @evil/<name> (npm 10.9.7 asked /@evil/lodash, 2026-10-24).
  for (const text of ["registry=https://registry.npmjs.org/@evil/\n", "@corp:registry=https://registry.npmjs.org/x/\n", "registry=https://registry.npmjs.org\\@evil.example/\n", "registry=https://corp.example/artifactory/api/npm/other/\n", "registry=https://registry.npmjs.org/?x=1\n"]) {
    assert.deepEqual(npmrcFindings(text, r).refuse.map((x) => x.kind), ["registry"], JSON.stringify(text));
  }
  // Keys that make npm read another config file: refused; a cache npm installs from offline: said.
  assert.deepEqual(npmrcFindings("userconfig=./x\nglobalconfig=/tmp/g\nprefix=./p\n", r).refuse.map((x) => [x.n, x.kind]), [[1, "indirect"], [2, "indirect"], [3, "indirect"]]);
  assert.deepEqual(npmrcFindings("cache=./.npm-cache\nprefer-offline=true\n", r).said.map((x) => [x.n, x.reason.key]), [[1, "offlineCache"]]);
  assert.deepEqual(npmrcFindings("cache=./.npm-cache\n", r), { refuse: [], said: [] });
  const said = npmrcFindings("replace-registry-host=always\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=${REG}\n${KEY}=https://evil.example/\nhttps-proxy=http://proxy.example:8080\nstrict-ssl=false\ncafile=/tmp/ca.pem\nscript-shell=/bin/zsh\nnode-options=--require x\nignore-scripts=false\nfund=false\nregistry=not a url\n", r).said;
  assert.deepEqual(said.map((x) => [x.n, x.reason.key]), [[1, "replaceHost"], [3, "fromEnv"], [4, "fromEnvKey"], [5, "proxy"], [6, "tls"], [7, "tls"], [8, "runsCode"], [9, "runsCode"], [10, "scriptsOn"], [12, "notUrl"]]);
  assert.deepEqual(npmrcFindings("replace-registry-host=npmjs\nstrict-ssl=true\nignore-scripts=true\n", r), { refuse: [], said: [] });
});

test("deps: an .npmrc value npm reads as false is said in each spelling npm takes, and no other (measured: npm ci, 10.9.9)", () => {
  const r = rule();
  const said = (/** @type {string} */ line) => npmrcFindings(`${line}\n`, r).said.map((x) => x.reason.key);
  for (const v of ["false", "0", "null", "0.0", "0x0", "-0"]) assert.deepEqual(said(`ignore-scripts=${v}`), ["scriptsOn"], v);
  for (const v of ["true", "1", "no", "off", "yes", "FALSE", ""]) assert.deepEqual(said(`ignore-scripts=${v}`), [], v);
  assert.deepEqual(said("ignore-scripts"), []);
  for (const v of ["false", "0", "null"]) assert.deepEqual(said(`strict-ssl=${v}`), ["tls"], v);
  assert.deepEqual(said("strict-ssl=1"), []);
  // A boolean npm reads as true counts as `true` does.
  const offline = (/** @type {string} */ v) => npmrcFindings(`offline=${v}\ncache=./c\n`, r).said.map((x) => x.reason.key);
  for (const v of ["true", "1", "yes"]) assert.deepEqual(offline(v), ["offlineCache"], v);
  for (const v of ["false", "0", "null"]) assert.deepEqual(offline(v), [], v);
});

test("deps: a boolean is read key by key as npm does: white space trimmed, undefined back to the key's default, an environment value unmeasured (npm ci and a real handshake, 10.9.9)", () => {
  const r = rule();
  const said = (/** @type {string} */ line) => npmrcFindings(`${line}\n`, r).said.map((x) => x.reason.key);
  // `undefined` unsets the key: ignore-scripts goes back to false and install scripts run; strict-ssl goes back to true.
  for (const v of ["undefined", '"undefined"', "'undefined'", "undefined ; c", '" undefined "', `'"undefined"'`, '"\\u00a0undefined"']) {
    assert.deepEqual(said(`ignore-scripts=${v}`), ["scriptsOn"], v);
    assert.deepEqual(said(`strict-ssl=${v}`), [], v);
  }
  assert.deepEqual(said("ignore-scripts=true\nignore-scripts=undefined"), ["scriptsOn"]);
  for (const v of ["Undefined", "UNDEFINED"]) assert.deepEqual(said(`ignore-scripts=${v}`), [], v);
  // npm trims first, the white space quotes keep too, and what JavaScript's trim takes; a zero-width space is text to it.
  for (const v of ['" false"', '"false "', '"\\tfalse"', '"\\nfalse"', '"\\u00a0false"', '"\\ufefffalse"', '"\\u2003false"', '" null "']) assert.deepEqual(said(`ignore-scripts=${v}`), ["scriptsOn"], v);
  for (const v of ['" false"', '"false "']) assert.deepEqual(said(`strict-ssl=${v}`), ["tls"], v);
  for (const v of ['" "', '"\\t"', '" true"', '" 1"', '"\\u200bfalse"']) assert.deepEqual(said(`ignore-scripts=${v}`), [], v);
  // What the variable holds is the machine's: the file does not say.
  for (const key of ["ignore-scripts", "strict-ssl"]) {
    for (const v of ["${X}", "${X?}", '"${X}"', "true${X}", "${X}${Y}"]) assert.deepEqual(said(`${key}=${v}`), ["fromEnv"], `${key}=${v}`);
    assert.deepEqual(said(`${key}=$X`), [], "npm expands only the braces");
  }
  // `'[]'` is an empty list to npm's ini, and the key goes unset as with undefined; a list with anything in it does not.
  assert.deepEqual(said("ignore-scripts='[]'"), ["scriptsOn"]);
  assert.deepEqual(said("ignore-scripts=true\nignore-scripts='[]'"), ["scriptsOn"]);
  assert.deepEqual(said("strict-ssl='[]'"), []);
  for (const v of ["'[true]'", "'[1]'", "'[null]'", "'[[]]'", "'{}'", '"[]"']) assert.deepEqual(said(`ignore-scripts=${v}`), [], v);
  // As one element of a list it unsets nothing, and as a key it is no key of npm's.
  assert.deepEqual(said("ignore-scripts[]='[]'"), []);
  assert.deepEqual(npmrcEntries("'[]'=x\n").map((x) => x.key), [""]);
  // A key with a false default stays off for undefined as for false: no offline, so no committed cache to warn of.
  assert.deepEqual(npmrcFindings("offline=undefined\ncache=./c\n", r).said, []);
  // A guard that was never on cannot be dropped.
  for (const v of ["undefined", '" false"', '" null "']) assert.equal(scriptsGuardDropped(`ignore-scripts=${v}\n`, null), null, v);
  for (const v of ["${X}", "true", '" true"']) assert.ok(scriptsGuardDropped(`ignore-scripts=${v}\n`, null), v);
});

test("deps: a commit that leaves npm reading an older ignore-scripts line loses the setting, though that line is no new one", () => {
  const dropped = (/** @type {string} */ b, /** @type {string} */ a) => scriptsGuardDropped(b, a)?.line ?? null;
  for (const v of ["false", "0", "null", "undefined", "${X}", "'[]'"]) {
    const head = `ignore-scripts=${v}\nignore-scripts=true\n`;
    assert.equal(dropped(head, `ignore-scripts=${v}\n`), "ignore-scripts=true", `${v}: the line after it goes`);
    assert.equal(dropped(head, `ignore-scripts=true\nignore-scripts=${v}\n`), "ignore-scripts=true", `${v}: the two change places`);
    assert.equal(dropped(head, `fund=false\n${head}`), null, `${v}: npm still reads true last`);
  }
  // A line new to the file is npmrcFindings' to say: said once, not twice.
  assert.equal(dropped("ignore-scripts=true\n", "ignore-scripts=false\n"), null);
  assert.equal(dropped("ignore-scripts=true\n", "ignore-scripts=true\nignore-scripts=0\n"), null);
  // npm's own pattern takes no line holding U+2028, so the key is gone from the file: a drop.
  assert.equal(dropped("ignore-scripts=true\n", "ignore-scripts=\u2028false\n"), "ignore-scripts=true");
});

test("deps: a commit that drops ignore-scripts from an .npmrc loses the setting wherever it goes, and only then", () => {
  const off = "fund=false\nignore-scripts=true\n";
  const line = (/** @type {string} */ b, /** @type {string | null} */ a) => scriptsGuardDropped(b, a)?.n ?? null;
  // Gone: the file, the line.
  assert.equal(line(off, null), 2);
  assert.equal(line(off, "fund=false\n"), 2);
  // A bare key is true to npm, and the last line is the one that counts.
  assert.equal(line("ignore-scripts\n", null), 1);
  assert.equal(line("ignore-scripts=false\nignore-scripts=true\n", ""), 2);
  // Still named: `true` keeps it, and `false` is npmrcFindings' to say.
  assert.equal(line(off, off), null);
  assert.equal(line(off, "ignore-scripts=false\n"), null);
  // Nothing to lose: HEAD did not turn them off, or a section npm does not read held the key.
  assert.equal(line("fund=false\n", null), null);
  assert.equal(line("ignore-scripts=false\n", null), null);
  assert.equal(line("[x]\nignore-scripts=true\n", null), null);
  // A key under a section in the new text is no key: the guard is gone.
  assert.equal(line(off, "[x]\nignore-scripts=true\n"), 2);
  // Any value npm reads as true keeps them off, so losing it is said; one it reads as false kept nothing.
  assert.equal(line("ignore-scripts=1\n", null), 1);
  assert.equal(line("ignore-scripts=no\n", null), 1);
  assert.equal(line("ignore-scripts=0\n", null), null);
  assert.equal(line("ignore-scripts=null\n", null), null);
  // npm's keys are exact: this spelling turned nothing off.
  assert.equal(line("IGNORE-SCRIPTS=true\n", null), null);
});

/** The CLI, run without blocking this process: the local servers answer it. @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env] */
function cli(args, cwd, env = process.env) {
  return /** @type {Promise<{ status: number, stdout: string, stderr: string }>} */ (
    new Promise((done) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => done({ status: /** @type {number} */ (status), stdout, stderr }));
    })
  );
}

/** A repository whose config lists `origin` as registry, downloads API, OSV and public registry. @param {string} origin @param {Record<string, unknown>} [deps] @param {Record<string, unknown>} [more] */
function repo(origin, deps = {}, more = {}) {
  const dir = mkdtempSync(join(tmpdir(), "en-deps-repo-"));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  const put = (/** @type {Record<string, string | Buffer>} */ files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(["add", "-A"], { cwd: dir });
  };
  put({ ".ennyn/config.json": JSON.stringify({ ...more, security: { deps: { registries: { [origin]: origin }, advisories: origin, advisoryRegistries: [origin], timeout: 120, ...deps } } }) });
  const commit = () => git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", "chore: base"], { cwd: dir });
  // The config is the commit's own from the start: the check reads it from the index and compares it with HEAD's.
  commit();
  const check = (/** @type {string} */ message = "chore: deps\n", /** @type {string[]} */ flags = ["--hook"]) => {
    writeFileSync(join(dir, ".git", "MSG"), message);
    return cli(["commit-check", ...flags, ".git/MSG"], dir);
  };
  return { dir, put, commit, check };
}

test("deps hook: a lock change that brings an install script, another package's tarball, no integrity, a version days old or one few install fails, and says which", async () => {
  const reg = await npm({ times: { "1.2.7": new Date(Date.now() - 2 * DAY).toISOString() } });
  try {
    const r = repo(reg.origin);
    r.put({ "package-lock.json": lock(entry(reg.origin, "minimist", "1.2.8")) });
    r.commit();
    assert.equal((await r.check()).status, 0, "nothing new");
    r.put({ "package-lock.json": lock({ ...entry(reg.origin, "minimist", "1.2.8", { hasInstallScript: true }), ...under("a", entry(reg.origin, "minimist", "1.2.8")) }) });
    assert.equal((await r.check()).status, 0, "the same version moved, and a flag on a version HEAD holds, are nothing new");
    r.put({ "package-lock.json": lock({ ...entry(reg.origin, "minimist", "1.2.8"), ...entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true }) }) });
    const scripts = await r.check();
    assert.equal(scripts.status, 1);
    assert.match(scripts.stderr, /package-lock\.json: 1 new packages run install scripts.*nat@1\.0\.0/);
    // The name and version the lock writes, the tarball another package's: npm installs the tarball.
    r.put({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.9", resolved: `${reg.origin}/evil/-/evil-0.0.1.tgz`, integrity: "sha512-e" } }) });
    const spoof = await r.check();
    assert.equal(spoof.status, 1);
    assert.match(spoof.stderr, /1 new entries name one package and install another.*minimist@1\.2\.9 \(resolved is \/evil\/-\/evil-0\.0\.1\.tgz, not \/minimist\/-\/minimist-1\.2\.9\.tgz\)/);
    assert.ok(!reg.hits.includes("GET /evil"), "nothing is asked about a tarball the entry does not name");
    r.put({ "package-lock.json": lock({ ...entry(reg.origin, "minimist", "1.2.6", { integrity: undefined }) }) });
    assert.match((await r.check()).stderr, /1 new entries have no integrity.*minimist@1\.2\.6/);
    r.put({ "package-lock.json": lock({ ...entry(reg.origin, "minimist", "1.2.7"), ...under("q", entry(reg.origin, "minimist", "0.0.1")) }) });
    const young = await r.check();
    assert.equal(young.status, 1);
    assert.match(young.stderr, /1 new versions are younger than 7 days.*minimist@1\.2\.7 \(2\.0 days old\)/);
    assert.match(young.stderr, /1 new versions are used by few, under 1% .*minimist@0\.0\.1 \(0\.00%; 45\)/);
    // The bypass marker loosens the shape of the message, not the lock.
    assert.equal((await r.check("chore: deps [commit-shape-allow: testing the marker]\n")).status, 1);
    // A lock that is text and no JSON (npm ci refuses conflict markers), and a deleted one, pass; the first says so.
    r.put({ "package-lock.json": `<<<<<<< HEAD\n${lock({})}=======\n>>>>>>> side\n` });
    const conflict = await r.check();
    assert.equal(conflict.status, 0);
    assert.match(conflict.stderr, /package-lock\.json was not checked: not JSON/);
    // UTF-16 with no byte order mark: its NUL bytes make it no text the check reads, and the commit brings it.
    writeFileSync(join(r.dir, "package-lock.json"), Buffer.from(lock({}), "utf16le"));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const wide = await r.check();
    assert.equal(wide.status, 1);
    assert.match(wide.stderr, /package-lock\.json: this commit brings a file the check cannot read \(not UTF-8 text\)/);
    git(["rm", "-q", "-f", "package-lock.json"], { cwd: r.dir });
    assert.equal((await r.check()).status, 0);
  } finally {
    await reg.close();
  }
});

test("deps hook: a lock npm reads under another case is read, and a staged .npmrc that sends npm to an unlisted registry fails", async () => {
  const reg = await npm();
  try {
    const r = repo(reg.origin);
    r.put({ "Package-Lock.json": lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    assert.match((await r.check()).stderr, /Package-Lock\.json: 1 new packages run install scripts/);
    git(["rm", "-q", "-f", "Package-Lock.json"], { cwd: r.dir });
    r.put({ ".npmrc": "registry=http://127.0.0.1:9/\n" });
    const npmrc = await r.check();
    assert.equal(npmrc.status, 1);
    assert.match(npmrc.stderr, /\.npmrc: points npm at a registry security\.deps\.registries does not list.*line 1: registry=http:\/\/127\.0\.0\.1:9\//);
    r.put({ ".npmrc": `registry=${reg.origin}/\nreplace-registry-host=always\n` });
    const said = await r.check();
    assert.equal(said.status, 0);
    assert.match(said.stderr, /where npm fetches from is unmeasured \(replace-registry-host sends each resolved URL/);
    // A case-insensitive file system opens .NPMRC as the project's .npmrc: one beside a lock file counts.
    r.put({ "app/package-lock.json": lock({}), "app/.NPMRC": "registry=https://evil.example/\n" });
    assert.match((await r.check()).stderr, /app\/\.NPMRC: points npm at a registry/);
    r.put({ "app/.NPMRC": "userconfig=./other-npmrc\n" });
    const indirect = await r.check();
    assert.equal(indirect.status, 1);
    assert.match(indirect.stderr, /app\/\.NPMRC: makes npm read another config file, which the check does not read: line 1: userconfig=\.\/other-npmrc/);
  } finally {
    await reg.close();
  }
});

test("deps hook: the .npmrc beside a staged lock names the registry for entries with no resolved URL, staged or not", async () => {
  const reg = await npm({ times: { "1.2.7": new Date(Date.now() - 2 * DAY).toISOString() } });
  try {
    const r = repo(reg.origin);
    r.put({ ".npmrc": `registry=${reg.origin}/\nscope=\n`, "app/.npmrc": `registry=${reg.origin}/\nscope=\n`, "package-lock.json": lock({}), "app/package-lock.json": lock({}) });
    r.commit();
    r.put({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.7", integrity: SEALS["1.2.7"] } }) });
    const top = await r.check();
    assert.equal(top.status, 1);
    assert.match(top.stderr, /package-lock\.json: 1 new versions are younger than 7 days.*minimist@1\.2\.7/);
    // Both at once: each lock reads its own .npmrc.
    r.put({ "app/package-lock.json": lock({ "node_modules/minimist": { version: "1.2.7", integrity: SEALS["1.2.7"] } }) });
    const both = await r.check();
    assert.match(both.stderr, /^package-lock\.json: 1 new versions are younger than 7 days/m);
    assert.match(both.stderr, /^app\/package-lock\.json: 1 new versions are younger than 7 days/m);
    // A lock at the top with no .npmrc of its own reads none, not one in a subdirectory.
    git(["reset", "-q", "--hard"], { cwd: r.dir });
    git(["rm", "-q", ".npmrc"], { cwd: r.dir });
    r.commit();
    r.put({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.7", integrity: SEALS["1.2.7"] } }) });
    assert.match((await r.check()).stderr, /no \.npmrc beside the lock naming its registry/);
    // An .npmrc beside no lock is not the one npm reads: staged, it is not judged.
    git(["reset", "-q", "--hard"], { cwd: r.dir });
    r.put({ "package-lock.json": lock(entry(reg.origin, "minimist", "1.2.8")), "other/.npmrc": "registry=https://evil.example/\n" });
    assert.equal((await r.check()).status, 0);
  } finally {
    await reg.close();
  }
});

test("deps hook: a path inside the repository holds what the commit holds only when the index tracks it and no symbolic link is on the way; an .npmrc the commit leaves alone is read only when an entry needs it", async () => {
  const reg = await npm();
  try {
    const r = repo(reg.origin);
    mkdirSync(join(r.dir, "packages"), { recursive: true });
    symlinkSync("../../outside", join(r.dir, "packages", "a"));
    symlinkSync("../outside-vendor", join(r.dir, "vendor"));
    symlinkSync("/nonexistent/npmrc", join(r.dir, ".npmrc"));
    r.put({ "packages/b/package.json": "{}\n", "package-lock.json": lock({}) });
    r.commit();
    r.put({
      "package-lock.json": lock({
        "node_modules/a": { resolved: "packages/a", link: true },
        "node_modules/b": { resolved: "packages/b", link: true },
        "node_modules/u": { resolved: "packages/untracked", link: true },
        "node_modules/t": { version: "1.0.0", resolved: "file:vendor/t-1.0.0.tgz", integrity: "sha512-t" },
        ...entry(reg.origin, "minimist", "1.2.8"),
      }),
    });
    // A symbolic link to a folder the repository holds is followed (through a second link too): said, naming the link.
    mkdirSync(join(r.dir, "shared", "a"), { recursive: true });
    writeFileSync(join(r.dir, "shared", "a", "package.json"), "{}\n");
    symlinkSync("../shared/a", join(r.dir, "packages", "in"));
    symlinkSync("in", join(r.dir, "packages", "chain"));
    git(["add", "shared", "packages/in", "packages/chain"], { cwd: r.dir });
    writeFileSync(join(r.dir, "package-lock.json"), lock({ "node_modules/in": { resolved: "packages/in", link: true }, "node_modules/chain": { resolved: "packages/chain", link: true } }));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const inside = await r.check();
    assert.equal(inside.status, 0, inside.stderr);
    assert.match(inside.stderr, /\(packages\/chain: through the symbolic link packages\/chain, to a folder the repository holds\): chain$/m);
    assert.match(inside.stderr, /\(packages\/in: through the symbolic link packages\/in, to a folder the repository holds\): in$/m);
    // Past the link, the rest of the path must be held too; a cycle of links leads nowhere the commit holds.
    symlinkSync("l2", join(r.dir, "packages", "l1"));
    symlinkSync("l1", join(r.dir, "packages", "l2"));
    git(["add", "packages/l1", "packages/l2"], { cwd: r.dir });
    writeFileSync(join(r.dir, "package-lock.json"), lock({ "node_modules/rest": { resolved: "packages/in/missing", link: true }, "node_modules/loop": { resolved: "packages/l1", link: true } }));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const walked = await r.check();
    assert.match(walked.stderr, /rest \(packages\/in\/missing: the index holds nothing there/);
    assert.match(walked.stderr, /loop \(packages\/l1: a symbolic link the index holds leads out of the repository/);
    git(["rm", "-q", "--cached", "packages/l1", "packages/l2"], { cwd: r.dir });
    // A name npm writes decomposed (macOS) against the composed one the index holds: the same folder.
    git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", "--stdin"], { cwd: r.dir, input: "{}\n" }).trim()},packages/caf\u00e9/package.json`], { cwd: r.dir });
    writeFileSync(join(r.dir, "package-lock.json"), lock({ "node_modules/cafe": { resolved: "packages/cafe\u0301", link: true } }));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const nfd = await r.check();
    assert.ok(!/cafe/.test(nfd.stderr), nfd.stderr);
    // A top folder (no directory above it to list) is asked in both forms; a link the index holds decomposed is one.
    const oid = (/** @type {string} */ text) => git(["hash-object", "-w", "--stdin"], { cwd: r.dir, input: text }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${oid("{}\n")},caf\u00e9/package.json`], { cwd: r.dir });
    git(["-c", "core.precomposeUnicode=false", "update-index", "--add", "--cacheinfo", `120000,${oid("../../outside")},packages/lie\u0301n`], { cwd: r.dir });
    writeFileSync(join(r.dir, "package-lock.json"), lock({ "node_modules/top": { resolved: "cafe\u0301", link: true }, "node_modules/lien": { resolved: "packages/li\u00e9n", link: true } }));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const forms = await r.check();
    assert.ok(!/top \(/.test(forms.stderr), forms.stderr);
    assert.match(forms.stderr, /lien \(packages\/li\u00e9n: a symbolic link the index holds leads out of the repository/);
    git(["-c", "core.precomposeUnicode=false", "rm", "-q", "--cached", "caf\u00e9/package.json", "packages/lie\u0301n"], { cwd: r.dir });
    git(["rm", "-q", "--cached", "-r", "shared", "packages/in", "packages/chain", "packages/caf\u00e9"], { cwd: r.dir });
    // A submodule on the way: its commit holds the folder, not this one.
    git(["update-index", "--add", "--cacheinfo", `160000,${SHA},packages/sub`], { cwd: r.dir });
    git(["add", "package-lock.json"], { cwd: r.dir });
    const subbed = lock({ "node_modules/s": { resolved: "packages/sub/pkg", link: true } });
    writeFileSync(join(r.dir, "package-lock.json"), subbed);
    git(["add", "package-lock.json"], { cwd: r.dir });
    assert.match((await r.check()).stderr, /s \(packages\/sub\/pkg: a submodule holds it and not this commit: listing this exact resolved in security\.deps\.sources is for the user to decide\)/);
    git(["rm", "-q", "--cached", "packages/sub"], { cwd: r.dir });
    r.put({
      "package-lock.json": lock({
        "node_modules/a": { resolved: "packages/a", link: true },
        "node_modules/b": { resolved: "packages/b", link: true },
        "node_modules/u": { resolved: "packages/untracked", link: true },
        "node_modules/t": { version: "1.0.0", resolved: "file:vendor/t-1.0.0.tgz", integrity: "sha512-t" },
        ...entry(reg.origin, "minimist", "1.2.8"),
      }),
    });
    const out = await r.check();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /3 new entries come from a source the check cannot prove.*a \(packages\/a: a symbolic link the index holds leads out of the repository: link the folder itself; listing this exact resolved in security\.deps\.sources is for the user to decide\), t@1\.0\.0 \(file:vendor\/t-1\.0\.0\.tgz: a symbolic link/);
    assert.match(out.stderr, /u \(packages\/untracked: the index holds nothing there/);
    assert.ok(!/ b \(|\.npmrc/.test(out.stderr), out.stderr);
    // An entry with no resolved URL asks for the .npmrc: one the check cannot read is named then.
    r.put({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.8", integrity: SEALS["1.2.8"] } }) });
    const unreadRc = await r.check();
    assert.equal(unreadRc.status, 0);
    assert.match(unreadRc.stderr, /unmeasured for 1 new versions \(no resolved URL and the \.npmrc beside the lock could not be read\): minimist@1\.2\.8/);
    // The index holds .npmrc and .NPMRC: npm opens .npmrc.
    const blob = (/** @type {string} */ text) => git(["hash-object", "-w", "--stdin"], { cwd: r.dir, input: text }).trim();
    git(["rm", "-q", "--cached", ".npmrc"], { cwd: r.dir });
    git(["update-index", "--add", "--cacheinfo", `100644,${blob("registry=https://evil.example/\n")},.NPMRC`], { cwd: r.dir });
    git(["update-index", "--add", "--cacheinfo", `100644,${blob(`registry=${reg.origin}\n`)},.npmrc`], { cwd: r.dir });
    git(["checkout", "-q", "HEAD", "--", "package-lock.json"], { cwd: r.dir });
    r.commit();
    // Only the lock is staged (a case-insensitive work tree holds one of the two names).
    writeFileSync(join(r.dir, "package-lock.json"), lock({ "node_modules/minimist": { version: "1.2.8", integrity: SEALS["1.2.8"] } }));
    git(["add", "package-lock.json"], { cwd: r.dir });
    const cased = await r.check();
    assert.ok(!/cannot prove/.test(cased.stderr), cased.stderr);
    assert.ok(reg.hits.includes("GET /minimist"), "asked of the registry .npmrc names");
  } finally {
    await reg.close();
  }
});

test("deps command: the registry of an entry with no resolved URL comes from the committed .npmrc, and one changed in the work tree is said", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin);
    r.put({ ".npmrc": `registry=${osv.origin}\nscope=\n`, "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.8", integrity: "sha512-x" } }) });
    r.commit();
    writeFileSync(join(r.dir, ".npmrc"), "registry=https://evil.example/\nscope=\n");
    const out = await cli(["deps"], r.dir);
    assert.match(out.stdout, /^! \.npmrc differs from the one the index holds: an entry with no resolved URL is judged by the committed one$/m);
    assert.ok(!/✗ minimist/.test(out.stdout), out.stdout);
    assert.ok(osv.bodies.some((b) => b.includes('"minimist"')), "the entry is asked about as the committed registry's");
  } finally {
    await osv.close();
  }
});

test("deps hook: allow and allowScripts name an identity the tarball proves; a name the lock writes over another source is not allowed", async () => {
  const reg = await npm({ times: { "1.2.7": new Date(Date.now() - 2 * DAY).toISOString() } });
  const young = lock({ ...entry(reg.origin, "minimist", "1.2.7", { hasInstallScript: true }) });
  try {
    const ok = repo(reg.origin, { allowScripts: ["minimist"], allow: ["minimist@1.2.7"] });
    // A file that is no lock file is not read as one.
    ok.put({ "package-lock.json": young, "README.md": "{}\n" });
    const passed = await ok.check();
    assert.deepEqual([passed.status, passed.stderr], [0, ""]);
    const spoofed = repo(reg.origin, { allowScripts: ["minimist"] });
    spoofed.put({ "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.7", resolved: "https://elsewhere.example/minimist.tgz", integrity: "sha512-e", hasInstallScript: true } }) });
    assert.match((await spoofed.check()).stderr, /1 new packages run install scripts.*minimist@1\.2\.7/);
    // An exact resolved URL allows its scripts; the source itself is accepted by sources, not by allowScripts.
    const elsewhere = lock({ "node_modules/minimist": { version: "1.2.7", resolved: "https://elsewhere.example/minimist.tgz", integrity: "sha512-e", hasInstallScript: true } });
    const byUrl = repo(reg.origin, { allowScripts: ["https://elsewhere.example/minimist.tgz"], sources: ["https://elsewhere.example/minimist.tgz"] });
    byUrl.put({ "package-lock.json": elsewhere });
    assert.deepEqual([(await byUrl.check()).status], [0], "an exact resolved URL allows its scripts");
    const scriptsOnly = repo(reg.origin, { allowScripts: ["https://elsewhere.example/minimist.tgz"] });
    scriptsOnly.put({ "package-lock.json": elsewhere });
    assert.match((await scriptsOnly.check()).stderr, /1 new entries come from a source the check cannot prove.*minimist@1\.2\.7 \(from https:\/\/elsewhere\.example: listing that registry/);
    const off = repo(reg.origin, { allowScripts: ["minimist"], online: false });
    off.put({ "package-lock.json": young });
    const said = await off.check();
    assert.equal(said.status, 0);
    assert.match(said.stderr, /age, adoption, the registry's integrity and install scripts unmeasured for the new versions: security\.deps\.online is false/);
  } finally {
    await reg.close();
  }
  // The server is gone: the origin is listed, nothing answers.
  const down = repo(reg.origin, { allowScripts: ["minimist"] });
  down.put({ "package-lock.json": young });
  const offline = await down.check();
  assert.equal(offline.status, 0);
  assert.match(offline.stderr, /unmeasured for 1 new versions \(ECONNREFUSED\): minimist@1\.2\.7/);
});

test("deps hook: HEAD's lock it cannot read is said, and every entry the commit stages is then checked as new; a version 1 lock is read on both sides", async () => {
  const reg = await npm();
  try {
    const r = repo(reg.origin, { online: false });
    r.put({ "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: { nat: { version: "1.0.0", resolved: `${reg.origin}/nat/-/nat-1.0.0.tgz`, integrity: "sha512-x" } } }) });
    r.commit();
    r.put({ "package-lock.json": lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    const upgraded = await r.check();
    assert.deepEqual([upgraded.status, upgraded.stderr], [0, ""], "npm's rewrite of a version 1 lock brings nothing new");
    // A lock HEAD cannot read is no way to launder an entry past the check: the next commit's entries are all new.
    r.put({ "package-lock.json": "not json\n" });
    r.commit();
    r.put({ "package-lock.json": lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    const lost = await r.check();
    assert.equal(lost.status, 1);
    assert.match(lost.stderr, /package-lock\.json was not checked: HEAD's version could not be read \(not JSON\)|HEAD's version could not be read \(not JSON\)/);
    assert.match(lost.stderr, /1 new packages run install scripts.*nat@1\.0\.0/);
    // A staged version 1 lock is read: its entries are judged, and it says what it does not record.
    r.put({ "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: { other: { version: "1.0.0", resolved: `${reg.origin}/other/-/other-1.0.0.tgz` } } }) });
    const v1 = await r.check();
    assert.equal(v1.status, 1);
    assert.match(v1.stderr, /lockfileVersion 1 records no install scripts/);
    assert.match(v1.stderr, /1 new entries have no integrity.*other@1\.0\.0/);
    git(["rm", "-q", "-f", "package-lock.json"], { cwd: r.dir });
    symlinkSync("elsewhere.json", join(r.dir, "package-lock.json"));
    git(["add", "-A"], { cwd: r.dir });
    r.commit();
    git(["rm", "-q", "--cached", "package-lock.json"], { cwd: r.dir });
    writeFileSync(join(r.dir, "x.json"), lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })));
    const hash = git(["hash-object", "-w", "x.json"], { cwd: r.dir });
    git(["update-index", "--add", "--cacheinfo", `100644,${hash},package-lock.json`], { cwd: r.dir });
    const link = await r.check();
    assert.match(link.stderr, /HEAD's version could not be read \(a symbolic link\)/);
    assert.equal(link.status, 1);
  } finally {
    await reg.close();
  }
});

test("deps hook: a lock or .npmrc the commit brings that the check cannot read and npm can (not UTF-8 text, a symbolic link, past 16 MB) is refused; the same file HEAD holds is said", async (t) => {
  // Nothing is asked: offline, and the registry is a port no test serves.
  const r = repo("http://127.0.0.1:9", { online: false });
  const brought = (/** @type {string} */ path, /** @type {string} */ reason) => new RegExp(`${path.replace(/\./g, "\\.")}: this commit brings a file the check cannot read \\(${reason}\\), and npm reads it all the same`);
  const said = (/** @type {string} */ path, /** @type {string} */ reason) => new RegExp(`^${path.replace(/\./g, "\\.")} was not checked: ${reason}$`, "m");
  const verdict = async (/** @type {RegExp} */ want, /** @type {number} */ status, /** @type {string} */ what) => {
    const out = await r.check();
    if (out.status !== status || !want.test(out.stderr)) t.diagnostic(`${what}: ${out.status} ${out.stderr}`);
    assert.equal(out.status, status, what);
    assert.match(out.stderr, want, what);
    if (status === 0) assert.doesNotMatch(out.stderr, /this commit brings a file the check cannot read/, what);
  };
  // The lab's lock: a new entry with an install script, and one byte that is not UTF-8.
  const scripted = Buffer.concat([Buffer.from(lock(entry("http://127.0.0.1:9", "nat", "1.0.0", { hasInstallScript: true }))), Buffer.from([0xff])]);
  r.put({ "package.json": "{}\n", "elsewhere.json": lock({}), "package-lock.json": lock({}) });
  r.commit();
  // A link only intended to add (`git add -N`): the index lists it, the commit does not carry it, nothing to judge.
  r.put({ "package.json": '{ "name": "intent" }\n' });
  symlinkSync("elsewhere.json", join(r.dir, "npm-shrinkwrap.json"));
  git(["add", "-N", "npm-shrinkwrap.json"], { cwd: r.dir });
  const intent = await r.check();
  assert.equal(intent.status, 0, intent.stderr);
  assert.doesNotMatch(intent.stderr, /npm-shrinkwrap\.json/);
  git(["rm", "-q", "--cached", "npm-shrinkwrap.json"], { cwd: r.dir });
  rmSync(join(r.dir, "npm-shrinkwrap.json"));
  r.put({ "package.json": "{}\n" });
  r.put({ "package-lock.json": scripted });
  await verdict(brought("package-lock.json", "not UTF-8 text"), 1, "a lock brought not UTF-8");
  r.commit();
  // HEAD holds it; a staged package.json brings the lock into the check, unchanged.
  r.put({ "package.json": '{ "name": "demo" }\n' });
  await verdict(said("package-lock.json", "not UTF-8 text"), 0, "the same bytes at HEAD");
  r.put({ "package-lock.json": Buffer.concat([scripted, Buffer.from([0xfe])]) });
  await verdict(brought("package-lock.json", "not UTF-8 text"), 1, "an edit of it brings it again");
  // A lock that is a symbolic link: from a regular file, held, then pointed elsewhere.
  rmSync(join(r.dir, "package-lock.json"));
  symlinkSync("elsewhere.json", join(r.dir, "package-lock.json"));
  git(["add", "-A"], { cwd: r.dir });
  await verdict(brought("package-lock.json", "a symbolic link"), 1, "a regular lock turned into a link");
  r.commit();
  r.put({ "package.json": '{ "name": "other" }\n' });
  await verdict(said("package-lock.json", "a symbolic link"), 0, "the same link at HEAD");
  rmSync(join(r.dir, "package-lock.json"));
  symlinkSync("package.json", join(r.dir, "package-lock.json"));
  git(["add", "-A"], { cwd: r.dir });
  await verdict(brought("package-lock.json", "a symbolic link"), 1, "a link pointed elsewhere");
  // A link made a regular file that is not UTF-8: another kind, brought.
  rmSync(join(r.dir, "package-lock.json"));
  r.put({ "package-lock.json": scripted });
  await verdict(brought("package-lock.json", "not UTF-8 text"), 1, "a link made bytes that are not UTF-8");
  // The lab's .npmrc: a registry the rule refuses, read by npm past a comment line holding a byte that is not UTF-8.
  r.put({ "package-lock.json": lock({}), ".npmrc": "registry=http://evil.invalid/\n" });
  await verdict(/\.npmrc: points npm at a registry/, 1, "the registry line alone is refused");
  r.put({ ".npmrc": Buffer.from("registry=http://evil.invalid/\n; \xff\n", "latin1") });
  await verdict(brought(".npmrc", "not UTF-8 text"), 1, "an .npmrc brought not UTF-8");
  r.commit();
  // HEAD holds that .npmrc: a lock change whose entry names its tarball does not read it, and passes.
  r.put({ "package-lock.json": lock({ "node_modules/a": { version: "1.0.0", resolved: "http://127.0.0.1:9/a/-/a-1.0.0.tgz", integrity: "sha512-x" } }) });
  const held = await r.check();
  assert.equal(held.status, 0, held.stderr);
  rmSync(join(r.dir, ".npmrc"));
  symlinkSync("elsewhere.json", join(r.dir, ".npmrc"));
  git(["add", "-A"], { cwd: r.dir });
  await verdict(brought(".npmrc", "a symbolic link"), 1, "an .npmrc brought as a link");
  git(["rm", "-q", "-f", ".npmrc"], { cwd: r.dir });
  r.commit();
  // Past 16 MB, one file, freed after: brought, then held.
  r.put({ "package-lock.json": `${lock({}).slice(0, -2)}${" ".repeat(16 * 1024 * 1024)}}\n` });
  await verdict(brought("package-lock.json", "past 16 MB"), 1, "a lock brought past 16 MB");
  r.commit();
  r.put({ "package.json": '{ "name": "third" }\n' });
  await verdict(said("package-lock.json", "past 16 MB"), 0, "the same lock past 16 MB at HEAD");
  rmSync(r.dir, { recursive: true, force: true });
});

test("deps hook: what the lock brings stands when the message check throws, and a name that is not UTF-8 is refused, escaped", async () => {
  const reg = await npm();
  try {
    // A skipSubjects pattern that does not compile: the message cannot be checked; the lock was.
    const r = repo(reg.origin, { online: false }, { commitMsg: { skipSubjects: ["("] } });
    r.put({ "package-lock.json": lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    const thrown = await r.check();
    assert.equal(thrown.status, 1);
    assert.match(thrown.stderr, /1 new packages run install scripts/);
    const named = repo(reg.origin);
    const hash = git(["hash-object", "-w", "--stdin"], { cwd: named.dir, input: lock({}) });
    const name = Buffer.from([...Buffer.from("app‮"), 0xff, ...Buffer.from("/package-lock.json")]);
    git(["update-index", "--add", "--index-info"], { cwd: named.dir, input: Buffer.concat([Buffer.from(`100644 ${hash}\t`), name, Buffer.from("\n")]) });
    const hook = await named.check();
    assert.equal(hook.status, 1);
    assert.match(hook.stderr, /security\.deps was not checked in 1 staged path\(s\) whose names are not UTF-8 \("app\\u202e�\/package-lock\.json"\)/);
    const hand = await named.check("chore: deps\n", []);
    assert.equal(hand.status, 1);
    assert.match(hand.stderr, /security\.deps was not checked in 1 staged path/);
  } finally {
    await reg.close();
  }
});

/** A local OSV: the recorded answer for minimist 1.2.5 (one advisory) and 1.2.8 (none), none for anything else. */
function osvServer() {
  return server((req, res, body) => {
    if (req.url === "/v1/querybatch") {
      const recorded = fixture("osv-querybatch.json").results;
      return send(res, 200, { results: JSON.parse(body).queries.map((/** @type {any} */ q) => (q.package.name === "minimist" ? recorded[q.version === "1.2.5" ? 0 : 1] : {})) });
    }
    if (req.url === "/v1/vulns/GHSA-xvch-5gv4-984h") return send(res, 200, fixture("osv-vuln.json"));
    send(res, 404, {});
  });
}

test("deps command: known advisories with every place that holds them, install scripts once each, and what was not asked; only all measured and clean exits 0", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin);
    r.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")) });
    const clean = await cli(["deps"], r.dir);
    assert.deepEqual([clean.status, clean.stdout], [0, "lock files: 1 · entries: 1 · advisories: 0 · install scripts: 0 · refused: 0 · unmeasured: 0\n"]);
    r.put({
      "package-lock.json": lock({ ...under("a", entry(osv.origin, "minimist", "1.2.5")), ...under("b", entry(osv.origin, "minimist", "1.2.5")), ...entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true }), ...under("c", entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true })), ...entry("https://other.example", "o", "1.0.0") }),
      "sub/package-lock.json": lock({ ...entry(osv.origin, "minimist", "1.2.5"), "node_modules/spoof": { version: "1.0.0", resolved: `${osv.origin}/evil/-/evil-0.0.1.tgz`, integrity: "sha512-e" } }),
    });
    const found = await cli(["deps"], r.dir);
    assert.equal(found.status, 1);
    assert.match(found.stdout, /^✗ GHSA-xvch-5gv4-984h \(CRITICAL; CVE-2021-44906\): Prototype Pollution in minimist: minimist@1\.2\.5 \(package-lock\.json\), minimist@1\.2\.5 \(sub\/package-lock\.json\)$/m);
    assert.equal(found.stdout.match(/runs install scripts/g)?.length, 1, found.stdout);
    assert.match(found.stdout, /^✗ spoof@1\.0\.0 \(sub\/package-lock\.json\) names one package and installs another: resolved is \/evil\/-\/evil-0\.0\.1\.tgz/m);
    assert.ok(!osv.bodies.some((b) => b.includes('"spoof"')), "an entry whose tarball is another package's is not asked about by its name");
    // An entry from a host no list names is a problem, as in the hook, and is not named to OSV.
    assert.match(found.stdout, /^✗ o@1\.0\.0 \(package-lock\.json\) comes from a source the check cannot prove: from https:\/\/other\.example: listing that registry in security\.deps\.registries or this exact resolved in security\.deps\.sources is for the user to decide/m);
    assert.ok(!osv.bodies.some((b) => b.includes('"o"')));
    assert.match(found.stdout, /entries: 5 · advisories: 1 · install scripts: 1 · refused: 2 · unmeasured: 0$/m);
    const json = JSON.parse((await cli(["deps", "--json"], r.dir)).stdout);
    assert.deepEqual([json.advisories.map((/** @type {any} */ a) => a.id), json.scripts, json.clean, json.refused], [["GHSA-xvch-5gv4-984h"], ["nat@1.0.0 (package-lock.json)"], false, [{ entry: "o@1.0.0 (package-lock.json)", kind: "unlisted", code: "from", reason: "from https://other.example: listing that registry in security.deps.registries or this exact resolved in security.deps.sources is for the user to decide" }]]);
  } finally {
    await osv.close();
  }
  // OSV gone: nothing is clean.
  const gone = repo(osv.origin);
  gone.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")) });
  const unmeasured = await cli(["deps"], gone.dir);
  assert.equal(unmeasured.status, 1);
  assert.match(unmeasured.stdout, /advisories unmeasured for 1 entries \(ECONNREFUSED\)/);
  const off = repo(osv.origin, { advisories: "" });
  off.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")) });
  const none = await cli(["deps"], off.dir);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /advisories unmeasured for 1 entries \(security\.deps\.advisories is empty\)/);
});

test("deps shrinkwrap: a package that carries its own npm-shrinkwrap.json is said, and so is every entry under it; a flag of another kind is refused", async () => {
  const R = "https://registry.npmjs.org";
  const reg = (/** @type {string} */ n) => ({ version: "1.0.0", resolved: `${R}/${n}/-/${n}-1.0.0.tgz`, integrity: "sha512-x" });
  const text = lock({ "node_modules/p": { ...reg("p"), hasShrinkwrap: true }, "node_modules/p/node_modules/c": reg("c"), "node_modules/q": reg("q") });
  const read = lockEntries(text).entries ?? [];
  assert.deepEqual(read.map((e) => [e.key, Boolean(e.shrinkwrap), Boolean(e.wrapped)]), [["node_modules/p", true, false], ["node_modules/p/node_modules/c", false, true], ["node_modules/q", false, false]]);
  assert.deepEqual(read.map((e) => Object.keys(judgeEntry(e, rule({}), {}))[0]), ["listed", "said", "listed"]);
  const m = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(text), head: Buffer.from(lock({})) }]]), rule({ online: false }), "en");
  assert.deepEqual(m.errors, []);
  assert.match(m.warnings.join("\n"), /unmeasured for 2 new versions \(a package that carries its own npm-shrinkwrap\.json.*c@1\.0\.0.*p@1\.0\.0|p@1\.0\.0.*c@1\.0\.0/);
  // Turning the flag on makes the entry new.
  assert.equal(newEntries(lockEntries(text).entries ?? [], lockEntries(lock({ "node_modules/p": reg("p"), "node_modules/p/node_modules/c": reg("c"), "node_modules/q": reg("q") })).entries ?? []).length, 2);
  const odd = lockEntries(lock({ "node_modules/p": { ...reg("p"), hasShrinkwrap: "true" } })).entries ?? [];
  assert.deepEqual(/** @type {any} */ (judgeEntry(odd[0], rule({}), {})).reason, { key: "odd", vars: { field: "hasShrinkwrap", kind: "string" } });
});

test("deps specs through the hook and the command: every package.json a lock names is read, and a staged one brings in that lock", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin, { online: false });
    const pkg = (/** @type {Record<string, unknown>} */ more) => `${JSON.stringify({ name: "demo", version: "1.0.0", ...more })}\n`;
    const top = pkg({ dependencies: { minimist: "^1.2.0" }, workspaces: ["packages/w"] });
    r.put({ "package-lock.json": lock({ ...entry(osv.origin, "minimist", "1.2.8"), "node_modules/w": { resolved: "packages/w", link: true }, "packages/w": { name: "w", version: "1.0.0" } }), "package.json": top, "packages/w/package.json": pkg({}) });
    r.commit();
    // The root's package.json alone: the lock beside it is read with it.
    r.put({ "package.json": pkg({ dependencies: { minimist: "https://evil.example/m.tgz" }, workspaces: ["packages/w"] }) });
    const root = await r.check();
    assert.equal(root.status, 1);
    assert.match(root.stderr, /minimist ← package\.json \(from https:\/\/evil\.example/);
    // A workspace's package.json alone: the lock that names its folder is read with it, from the index.
    r.put({ "package.json": top, "packages/w/package.json": pkg({ dependencies: { minimist: "github:u/minimist" } }) });
    const ws = await r.check();
    assert.equal(ws.status, 1);
    assert.match(ws.stderr, /minimist ← packages\/w \(github:u\/minimist: not pinned to a full commit/);
    // A registry spec goes to the registry, which the .npmrc rule judges.
    r.put({ "packages/w/package.json": pkg({ dependencies: { minimist: "^1.2.0" } }) });
    assert.equal((await r.check()).status, 0);
    // The command reads them from the work tree, as regular files.
    writeFileSync(join(r.dir, "packages/w/package.json"), pkg({ dependencies: { minimist: "https://evil.example/m.tgz" } }));
    const cmd = await cli(["deps"], r.dir);
    assert.equal(cmd.status, 1);
    assert.match(cmd.stdout, /^✗ minimist ← packages\/w \(package-lock\.json\) comes from a source the check cannot prove: from https:\/\/evil\.example/m);
    rmSync(join(r.dir, "packages/w/package.json"));
    symlinkSync("../../package.json", join(r.dir, "packages/w/package.json"));
    const linked = await cli(["deps"], r.dir);
    assert.equal(linked.status, 1);
    assert.match(linked.stdout, /packages\/w\/package\.json.*could not be read/);
    rmSync(join(r.dir, "packages/w/package.json"));
    writeFileSync(join(r.dir, "packages/w/package.json"), pkg({}));
    // A spec a source proves is judged for its source only: no entry, nothing asked of OSV, nothing unmeasured.
    writeFileSync(join(r.dir, "packages/w/package.json"), pkg({ dependencies: { v: "file:../../vendor/v" } }));
    mkdirSync(join(r.dir, "vendor/v"), { recursive: true });
    writeFileSync(join(r.dir, "vendor/v/package.json"), pkg({}));
    git(["add", "-A"], { cwd: r.dir });
    const proven = await cli(["deps"], r.dir);
    assert.match(proven.stdout, /^lock files: 1 · entries: 1 · advisories: 0 · install scripts: 0 · refused: 0 · unmeasured: 0$/m);
    writeFileSync(join(r.dir, "packages/w/package.json"), pkg({}));
    // A package with its own npm-shrinkwrap.json, and what sits under it: unmeasured, each said.
    writeFileSync(join(r.dir, "package-lock.json"), lock({ ...entry(osv.origin, "minimist", "1.2.8", { hasShrinkwrap: true }), ...under("minimist", entry(osv.origin, "nat", "1.0.0")), "node_modules/w": { resolved: "packages/w", link: true }, "packages/w": { name: "w", version: "1.0.0" } }));
    const wrapped = await cli(["deps"], r.dir);
    assert.match(wrapped.stdout, /unmeasured: 2$/m);
    assert.match(wrapped.stdout, /minimist@1\.2\.8 \(package-lock\.json\).*npm-shrinkwrap\.json/);
  } finally {
    await osv.close();
  }
});

test("deps command: a source no list names, git and a link out of the repository are problems; an entry with no resolved is asked about as the registry npm asks", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin);
    r.put({ ".npmrc": `registry=${osv.origin}\nscope=\n`, "package-lock.json": lock({ "node_modules/minimist": { version: "1.2.5", integrity: "sha512-x" } }) });
    const asked = await cli(["deps"], r.dir);
    assert.match(asked.stdout, /^✗ GHSA-xvch-5gv4-984h .*: minimist@1\.2\.5 \(package-lock\.json\)$/m);
    assert.match(asked.stdout, /unmeasured: 0$/m);
    r.put({ "package-lock.json": lock({ "node_modules/g": { version: "1.0.0", resolved: `git+ssh://git@github.com/o/g.git#${SHA}` } }) });
    const git = await cli(["deps"], r.dir);
    assert.equal(git.status, 1);
    assert.match(git.stdout, /^✗ g@1\.0\.0 \(package-lock\.json\) is a git dependency, which npm builds by running its prepare script/m);
    r.put({ "packages/w/package.json": "{}\n", "package-lock.json": lock({ "node_modules/l": { resolved: "../outside", link: true }, "node_modules/w": { resolved: "packages/w", link: true } }) });
    const link = await cli(["deps"], r.dir);
    assert.equal(link.status, 1);
    assert.match(link.stdout, /^✗ l \(package-lock\.json\) comes from a source the check cannot prove: \.\.\/outside: outside the repository: listing this exact resolved/m);
    assert.ok(!link.stdout.includes("w ("), link.stdout);
    // A link through a symbolic link to a folder the repository holds is said, as in the hook.
    mkdirSync(join(r.dir, "shared"), { recursive: true });
    writeFileSync(join(r.dir, "shared", "package.json"), "{}\n");
    symlinkSync("../shared", join(r.dir, "packages", "via"));
    r.put({ "package-lock.json": lock({ "node_modules/via": { resolved: "packages/via", link: true } }) });
    const via = await cli(["deps"], r.dir);
    assert.match(via.stdout, /^\? via \(package-lock\.json\) was not checked: packages\/via: through the symbolic link packages\/via, to a folder the repository holds$/m);
    assert.equal(via.status, 1);
    // A link into a folder the index holds as a symbolic link: the command asks the index as the hook does.
    symlinkSync("../../elsewhere", join(r.dir, "packages", "s"));
    r.put({ "package-lock.json": lock({ "node_modules/s": { resolved: "packages/s", link: true } }) });
    assert.match((await cli(["deps"], r.dir)).stdout, /^✗ s \(package-lock\.json\) comes from a source the check cannot prove: packages\/s: a symbolic link/m);
  } finally {
    await osv.close();
  }
});

test("deps command: outside a repository the .npmrc beside a lock is the work tree's, and it says so; the index is asked in batches", async () => {
  const osv = await osvServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "en-deps-out-"));
    mkdirSync(join(dir, ".ennyn"));
    writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ security: { deps: { registries: { [osv.origin]: null }, advisories: osv.origin, advisoryRegistries: [osv.origin] } } }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { minimist: "1" } }));
    writeFileSync(join(dir, ".npmrc"), `registry=${osv.origin}\n`);
    writeFileSync(join(dir, "package-lock.json"), lock({ "node_modules/minimist": { version: "1.2.8", integrity: "sha512-x" } }));
    const out = await cli(["deps"], dir);
    assert.ok(!/✗/.test(out.stdout), out.stdout);
    assert.match(out.stdout, /^! not in a git repository: the \.npmrc beside each lock is read from the work tree/m);
    // Where the file system tells .NPMRC from .npmrc (Linux), npm opens .npmrc.
    writeFileSync(join(dir, ".NPMRC"), "registry=https://evil.example/\n");
    if (readFileSync(join(dir, ".npmrc"), "utf8").includes(osv.origin)) assert.ok(!/✗ minimist/.test((await cli(["deps"], dir)).stdout));
  } finally {
    await osv.close();
  }
  // Tens of thousands of paths: pathspecs go 500 a call, never past what one command line holds.
  const repoDir = mkdtempSync(join(tmpdir(), "en-deps-kinds-"));
  git(["init", "-q", "-b", "main"], { cwd: repoDir });
  const many = Array.from({ length: 30000 }, (_, i) => `packages/a-folder-name-long-enough-to-fill-a-command-line-${i}`);
  git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", "--stdin"], { cwd: repoDir, input: "{}\n" }).trim()},${many[29999]}/package.json`], { cwd: repoDir });
  // Top folders (one pathspec each) and, last, the one the index holds: a reader that stops early misses it.
  const kinds = indexKinds(repoDir, many.map((p, i) => (i < 29999 ? p.slice("packages/".length) : p)));
  assert.deepEqual([kinds.size, [...kinds.values()].filter((k) => k.kind === "tracked").length], [30000, 1]);
});

test("deps command: a read made to fail is unmeasured and exits non-zero, never clean: a staged .npmrc that is a symbolic link, one that is not UTF-8, a name git cannot be asked for, an .npmrc the index holds as a submodule", async () => {
  const osv = await osvServer();
  try {
    const bare = lock({ "node_modules/a": { version: "1.0.0", integrity: "sha512-x" } });
    const oid = (/** @type {string} */ dir, /** @type {string} */ text) => git(["hash-object", "-w", "--stdin"], { cwd: dir, input: text }).trim();
    /** @type {[string, (dir: string) => void][]} */
    const cases = [
      ["an .npmrc that is a symbolic link", (dir) => { symlinkSync("/nonexistent/npmrc", join(dir, ".npmrc")); git(["add", ".npmrc"], { cwd: dir }); }],
      ["an .npmrc that is not UTF-8", (dir) => { writeFileSync(join(dir, ".npmrc"), Buffer.from("registry=https://café.example/\n", "latin1")); git(["add", ".npmrc"], { cwd: dir }); }],
      ["a lock name git cannot be asked for", (dir) => git(["update-index", "--add", "-z", "--index-info"], { cwd: dir, input: Buffer.concat([Buffer.from(`100644 ${oid(dir, bare)}\t`), Buffer.from([0x61, 0xff, 0x2f]), Buffer.from("package-lock.json"), Buffer.from([0])]) })],
      ["an .npmrc the index holds as a submodule", (dir) => git(["update-index", "--add", "--cacheinfo", `160000,${SHA},.npmrc`], { cwd: dir })],
    ];
    for (const [what, make] of cases) {
      const r = repo(osv.origin);
      r.put({ "package-lock.json": bare });
      make(r.dir);
      const out = await cli(["deps"], r.dir);
      assert.notEqual(out.status, 0, `${what}: ${out.stdout}`);
      assert.match(out.stdout, /^\? /m, `${what}: ${out.stdout}`);
      assert.doesNotMatch(out.stdout, /unmeasured: 0$/m, what);
    }
  } finally {
    await osv.close();
  }
});

test("deps command: the lock beside each package.json is read, tracked or not; dependencies with no lock beside or above are no clean result", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin);
    r.put({ "package.json": "{}\n", ".gitignore": "package-lock.json\n" });
    const empty = await cli(["deps"], r.dir);
    assert.deepEqual([empty.status, empty.stdout.split("\n")[0]], [0, "lock files: none"], "a package.json with no dependencies installs nothing");
    r.put({ "package.json": JSON.stringify({ dependencies: { nat: "1.0.0" } }) });
    const none = await cli(["deps"], r.dir);
    assert.equal(none.status, 1);
    assert.match(none.stdout, /^\? package\.json has dependencies, and no lock file beside it or above it/m);
    writeFileSync(join(r.dir, "package-lock.json"), lock(entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true })));
    const ignored = await cli(["deps"], r.dir);
    assert.equal(ignored.status, 1);
    assert.match(ignored.stdout, /^! package-lock\.json is read, but not tracked/m);
    assert.match(ignored.stdout, /nat@1\.0\.0 \(package-lock\.json\) runs install scripts/);
    // In a subdirectory, with no package.json at the top: the lock beside it is still the one npm reads.
    const sub = repo(osv.origin);
    sub.put({ "frontend/package.json": JSON.stringify({ dependencies: { nat: "1.0.0" } }), ".gitignore": "package-lock.json\n" });
    writeFileSync(join(sub.dir, "frontend", "package-lock.json"), lock(entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true })));
    const nested = await cli(["deps"], sub.dir);
    assert.equal(nested.status, 1);
    assert.match(nested.stdout, /^! frontend\/package-lock\.json is read, but not tracked/m);
    // A workspace's member has its lock at the root.
    const ws = repo(osv.origin);
    ws.put({ "package.json": JSON.stringify({ workspaces: ["app"], dependencies: { minimist: "1.2.8" } }), "app/package.json": JSON.stringify({ dependencies: { minimist: "1.2.8" } }), "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")) });
    assert.equal((await cli(["deps"], ws.dir)).status, 0);
    const off = repo(osv.origin, { paths: [] });
    off.put({ "package.json": JSON.stringify({ dependencies: { nat: "1.0.0" } }), "package-lock.json": lock(entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    const quiet = await cli(["deps"], off.dir);
    assert.deepEqual([quiet.status, quiet.stdout.split("\n")[0]], [0, "security.deps.paths is empty: no lock file is read"]);
    const bare = repo(osv.origin, { advisories: "" });
    assert.deepEqual([(await cli(["deps"], bare.dir)).status], [0], "no package.json, no lock: nothing npm installs, nothing to ask OSV");
    const spoof = repo(osv.origin);
    spoof.put({ "package-lock.json": lock({ "node_modules/spoof": { version: "1.0.0", resolved: `${osv.origin}/evil/-/evil-0.0.1.tgz`, integrity: "sha512-e" } }) });
    assert.equal((await cli(["deps"], spoof.dir)).status, 1, "an entry whose tarball is another package's is no clean result");
    const npmrc = repo(osv.origin);
    npmrc.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")), ".npmrc": "registry=https://evil.example/\n" });
    const pointed = await cli(["deps"], npmrc.dir);
    assert.equal(pointed.status, 1);
    assert.match(pointed.stdout, /^✗ \.npmrc: points npm at a registry/m);
    const indirect = repo(osv.origin);
    indirect.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")), ".npmrc": "prefix=./p\n" });
    const elsewhere = await cli(["deps"], indirect.dir);
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stdout, /^✗ \.npmrc: makes npm read another config file, which the check does not read: line 1: prefix=\.\/p/m);
    // One name@version from two hosts: the place says which.
    const two = repo(osv.origin, { registries: { [osv.origin]: null, "https://other.example": null } });
    two.put({ "package-lock.json": lock({ ...entry(osv.origin, "nat", "1.0.0", { hasInstallScript: true }), ...under("x", entry("https://other.example", "nat", "1.0.0", { hasInstallScript: true, integrity: "sha512-y" })) }) });
    const hosts = (await cli(["deps"], two.dir)).stdout;
    assert.match(hosts, new RegExp(`nat@1\\.0\\.0 \\(package-lock\\.json; ${osv.origin.replace(/[.]/g, "\\.")}\\) runs`));
    assert.match(hosts, /nat@1\.0\.0 \(package-lock\.json; https:\/\/other\.example\) runs/);
  } finally {
    await osv.close();
  }
});

test("deps command: OSV hears only of packages from a public registry; a bundled one, whose version the lock cannot prove, is said", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin, { registries: { [osv.origin]: null, "https://corp.example/npm": null } });
    r.put({
      "package-lock.json": lock({
        ...entry(osv.origin, "minimist", "1.2.8", { bundleDependencies: ["inside"] }),
        ...under("minimist", { "node_modules/inside": { version: "1.0.0", inBundle: true } }),
        ...entry("https://corp.example/npm", "@corp/secret-sauce", "1.0.0", { bundleDependencies: ["@corp/inner"] }),
        ...under("@corp/secret-sauce", { "node_modules/@corp/inner": { version: "1.0.0", inBundle: true } }),
      }),
    });
    const said = await cli(["deps"], r.dir);
    assert.equal(said.status, 1);
    const asked = osv.bodies.flatMap((b) => JSON.parse(b).queries.map((/** @type {any} */ q) => q.package.name)).sort();
    assert.deepEqual(asked, ["minimist"]);
    assert.match(said.stdout, /bundled: the lock cannot prove which version the package holds\): .*inside@1\.0\.0/);
    assert.match(said.stdout, /from https:\/\/corp\.example\/npm, which security\.deps\.advisoryRegistries does not name, so it is not sent to OSV\): @corp\/secret-sauce@1\.0\.0/);
  } finally {
    await osv.close();
  }
});

test("deps advisories: a withdrawn advisory is dropped, a record that cannot be read keeps its id, a paged or short answer is said, and 1,001 packages take two calls", async () => {
  let short = false;
  const osv = await server((req, res, body) => {
    if (req.url === "/v1/querybatch") {
      const n = JSON.parse(body).queries.length;
      if (n > 2) return send(res, 200, { results: Array.from({ length: n }, () => ({})) });
      return send(res, 200, { results: [{ vulns: [{ id: "W-1" }, { id: "E-1" }] }, { vulns: [], next_page_token: "t" }].slice(0, short ? 1 : 2) });
    }
    if (req.url === "/v1/vulns/W-1") return send(res, 200, { id: "W-1", summary: "gone", withdrawn: "2026-01-01T00:00:00Z" });
    send(res, 500, {});
  });
  try {
    const r = rule({ registries: { [osv.origin]: null }, advisories: osv.origin, advisoryRegistries: [osv.origin] });
    const entries = lockEntries(lock({ ...entry(osv.origin, "a", "1.0.0"), ...entry(osv.origin, "b", "1.0.0") })).entries ?? [];
    const got = await advisoriesOf(entries, r);
    assert.deepEqual(got.advisories.map((a) => [a.id, a.unread?.key]), [["E-1", "http"]]);
    assert.deepEqual(got.unread.map((u) => [u.entry?.name, u.reason.key]), [["b", "paged"]]);
    short = true;
    const cut = await advisoriesOf(entries, r);
    assert.deepEqual([cut.advisories.length, cut.unread.map((u) => u.reason.key)], [0, ["countMismatch", "countMismatch"]]);
    // A public registry listed under a path is named by that URL.
    const mirror = `${osv.origin}/mirror`;
    const before = osv.bodies.length;
    await advisoriesOf(lockEntries(lock(entry(mirror, "m", "1.0.0"))).entries ?? [], rule({ registries: { [mirror]: null }, advisories: osv.origin, advisoryRegistries: [mirror] }));
    assert.deepEqual(osv.bodies.slice(before).map((b) => JSON.parse(b).queries.map((/** @type {any} */ q) => q.package.name)), [["m"]]);
    const many = lockEntries(lock(Object.assign({}, ...Array.from({ length: 1001 }, (_, i) => entry(osv.origin, `p${i}`, "1.0.0"))))).entries ?? [];
    const start = osv.hits.length;
    await advisoriesOf(many, r);
    assert.deepEqual(osv.hits.slice(start).filter((h) => h.startsWith("POST")), ["POST /v1/querybatch", "POST /v1/querybatch"]);
  } finally {
    await osv.close();
  }
});

test("deps process: the command ends once its work is done, even with a handle left open", async () => {
  const osv = await osvServer();
  try {
    const r = repo(osv.origin);
    r.put({ "package-lock.json": lock(entry(osv.origin, "minimist", "1.2.8")) });
    // A preload that holds the process for a minute, as a lookup the budget gave up on can.
    const hold = join(r.dir, ".git", "hold.cjs");
    writeFileSync(hold, "setTimeout(() => {}, 60000);\n");
    const started = performance.now();
    const done = await cli(["deps"], r.dir, { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(hold)}`.trim() });
    assert.equal(done.status, 0, done.stderr);
    assert.ok(performance.now() - started < 20000, `${performance.now() - started} ms`);
  } finally {
    await osv.close();
  }
});

test("deps display: a share floors from the counts themselves, the threshold prints plainly, and a version with no publish time says only age and adoption", async () => {
  const published = Date.parse(fixture("packument-minimist.json").time["1.2.8"]);
  const reg = await npm({ times: { "1.2.6": null }, paths: { "/versions/minimist/last-week": { downloads: { "1.2.8": 29, other: 9971 } } } });
  try {
    const staged = lock({ ...entry(reg.origin, "minimist", "1.2.8"), ...under("x", entry(reg.origin, "minimist", "1.2.6")) });
    const r = await depsMessages(new Map([["package-lock.json", { staged: Buffer.from(staged), head: null }]]), rule({ registries: { [reg.origin]: reg.origin } }), "en", { now: published + 30 * DAY });
    // 29 of 10,000 is 0.29%: floating point floors it to 0.28.
    assert.match(r.errors.join("\n"), /minimist@1\.2\.8 \(0\.29%; 29\)/);
    assert.match(r.warnings.join("\n"), /package-lock\.json: age and adoption unmeasured for 1 new versions \(the registry gives no publish time for this version\): minimist@1\.2\.6/);
  } finally {
    await reg.close();
  }
  assert.deepEqual([thresholdPercent(1e-9), thresholdPercent(0.07), thresholdPercent(0.01)], ["0.0000001", "7", "1"]);
});

test("deps verdicts: a digest the registry gives, among two of one algorithm, is no tampering; one it does not give is", async () => {
  const reg = await npm({ manifests: { "1.2.8": { dist: { integrity: `sha512-OTHER ${SEALS["1.2.8"]}` } } } });
  try {
    const r = rule({ registries: { [reg.origin]: reg.origin } });
    const ok = await registryVerdicts(lockEntries(lock(entry(reg.origin, "minimist", "1.2.8"))).entries ?? [], r);
    assert.deepEqual(ok.tampered, []);
    const bad = await registryVerdicts(lockEntries(lock(entry(reg.origin, "minimist", "1.2.8", { integrity: "sha512-NEITHER" }))).entries ?? [], r);
    assert.deepEqual(bad.tampered.map((x) => x.entry.version), ["1.2.8"]);
  } finally {
    await reg.close();
  }
});

test("deps verdicts: a registry under a path is asked at its own URL, and its packages are measured like any other", async () => {
  const reg = await server((req, res) => {
    if (req.url === "/artifactory/api/npm/npm/minimist") return send(res, 200, fixture("packument-minimist.json"));
    send(res, 404, {});
  });
  try {
    const resolved = `${reg.origin}/artifactory/api/npm/npm/minimist/-/minimist-0.0.1.tgz`;
    const registry = `${reg.origin}/artifactory/api/npm/npm`;
    const v = await registryVerdicts(lockEntries(lock({ "node_modules/minimist": { version: "0.0.1", resolved, integrity: SEALS["0.0.1"] } })).entries ?? [], rule({ registries: { [registry]: null } }));
    assert.deepEqual(v.unread.map((u) => [why(u), u.part]), [[`no downloads API is listed for ${registry}`, "adoption"]]);
    assert.deepEqual(reg.hits, ["GET /artifactory/api/npm/npm/minimist"]);
    // Another repository on the same host decides nothing: its packument is never asked for.
    const other = `${reg.origin}/artifactory/api/npm/attacker-repo/minimist/-/minimist-0.0.1.tgz`;
    const said = await registryVerdicts(lockEntries(lock({ "node_modules/minimist": { version: "0.0.1", resolved: other, integrity: SEALS["0.0.1"] } })).entries ?? [], rule({ registries: { [registry]: null } }));
    assert.deepEqual(said.unread.map((u) => u.reason.key), ["unproven"]);
    assert.deepEqual(reg.hits, ["GET /artifactory/api/npm/npm/minimist"]);
  } finally {
    await reg.close();
  }
});

test("deps memory: an answer past what one run holds at once is unread", async () => {
  const reg = await server((req, res) => send(res, 200, { ok: true }));
  try {
    await assert.rejects(fetchJson(`${reg.origin}/x`, AbortSignal.timeout(60000), { held: HELD_LIMIT }), (e) => /** @type {any} */ (e).reason?.key === "heldTooMuch");
    const meter = { held: 0 };
    assert.deepEqual(await fetchJson(`${reg.origin}/x`, AbortSignal.timeout(60000), meter), { ok: true });
    assert.equal(meter.held, 0, "an answer read lets its bytes go");
    assert.ok(ANSWER_LIMIT >= 2 * 73.2 * 1024 * 1024, "renovate's packument, 73.2 MB, is read");
  } finally {
    await reg.close();
  }
});

test("deps hook: two digests of one algorithm fail, and an .npmrc counts only where npm reads it for the project", async () => {
  const reg = await npm();
  try {
    const r = repo(reg.origin, { online: false });
    r.put({ "package-lock.json": lock(entry(reg.origin, "minimist", "1.2.8", { integrity: `sha512-EVIL ${SEALS["1.2.8"]}` })) });
    const twice = await r.check();
    assert.equal(twice.status, 1);
    assert.match(twice.stderr, /1 new entries hold two digests of one algorithm.*minimist@1\.2\.8/);
    r.commit();
    r.put({ "test/fixtures/private/.npmrc": "registry=https://evil.example/\n" });
    assert.deepEqual([(await r.check()).status, (await r.check()).stderr], [0, ""], "an .npmrc beside no lock file is no project's");
    r.put({ "app/package-lock.json": lock({}) });
    r.commit();
    r.put({ "app/.npmrc": "registry=https://evil.example/\n" });
    assert.match((await r.check()).stderr, /app\/\.npmrc: points npm at a registry/);
  } finally {
    await reg.close();
  }
});

test("deps process: a refusal that ends through the forced exit still exits 1, and output read late arrives whole", async () => {
  const reg = await npm();
  try {
    const r = repo(reg.origin, { online: false });
    const hold = join(r.dir, ".git", "hold.cjs");
    writeFileSync(hold, "setTimeout(() => {}, 60000);\n");
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(hold)}`.trim() };
    r.put({ "package-lock.json": lock(entry(reg.origin, "nat", "1.0.0", { hasInstallScript: true })) });
    writeFileSync(join(r.dir, ".git", "MSG"), "chore: deps\n");
    const refused = await cli(["commit-check", "--hook", ".git/MSG"], r.dir, env);
    assert.equal(refused.status, 1, refused.stderr);
    // More than a pipe holds, read two seconds late: every byte arrives before the process ends.
    const many = repo(reg.origin);
    many.put({ "package-lock.json": lock(Object.assign({}, ...Array.from({ length: 1500 }, (_, i) => entry("https://unlisted.example", `p${i}`, "1.0.0")))) });
    const json = await new Promise((done) => {
      const child = spawn(process.execPath, [CLI, "deps", "--json"], { cwd: many.dir, env });
      let out = "";
      child.stdout.pause();
      setTimeout(() => child.stdout.on("data", (d) => (out += d)).resume(), 2500);
      child.on("close", () => done(out));
    });
    const parsed = JSON.parse(/** @type {string} */ (json));
    assert.ok(String(json).length > 65536, `${String(json).length} bytes`);
    assert.equal(parsed.refused.length, 1500);
  } finally {
    await reg.close();
  }
});

test("deps config: security.deps checks its kinds and ranges, and a registries map replaces the default one", () => {
  assert.deepEqual(rule({ registries: { "https://npm.example": null } }).registries, { "https://npm.example": null });
  assert.deepEqual(rule({ registries: { "https://acme.jfrog.io/artifactory/api/npm/npm-repo": null } }).registries, { "https://acme.jfrog.io/artifactory/api/npm/npm-repo": null });
  assert.ok(lockPath("app/Package-Lock.JSON", rule().paths));
  for (const bad of [
    { cooldownDays: -1 },
    { minShare: 2 },
    { minWeekly: 1.5 },
    { timeout: 0 },
    { allow: ["minimist"] },
    { allowScripts: [""] },
    { sources: [""] },
    { sources: [3] },
    { paths: ["[z-a]"] },
    { registries: { "https://npm.example/": "https://api.example" } },
    { registries: { "https://npm.example": "ftp://x" } },
    { registries: { "https://npm.example": 3 } },
    { advisories: "osv" },
    { advisoryRegistries: ["registry.npmjs.org"] },
    { registries: { "https://corp.example/npm/": null } },
    { registries: { "https://user:x@corp.example/npm": null } },
    { online: "yes" },
    { extra: 1 },
  ]) {
    assert.throws(() => rule(bad), ConfigError, JSON.stringify(bad));
  }
});
