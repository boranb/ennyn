/**
 * Does `ennyn leftovers` name everything new the cycle left in the work tree, and nothing that was there at its start?
 * Its own tests (test/leftovers.test.mjs) hold its lists; the class this file is for, a verdict that stands for a
 * fact and parts from it on some state, was found 8 times in metrics/leftovers.mjs, all by review. Here the fact is read
 * by test/repo-facts.mjs, from git and the file system alone, at the start and at the closing: every path's bytes on
 * disk, the index and HEAD's tree. A path is new when at the closing it is not what HEAD holds (on disk or in the index)
 * and is not as it was at the start; a file untracked at the start that HEAD now holds was swept in. Ignored untracked
 * files are left out, as the command leaves them out: the project chose to ignore them. A path below a submodule
 * counts as the submodule's. No filter or line-ending setting converts a file in this corpus: a file is compared with
 * its blob by its bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { leftovers, recordStart } from "../metrics/leftovers.mjs";
import { gitignores, head, ignoredBy, index, listing, localRules, skipWorktree, tree, written } from "./repo-facts.mjs";
import { ownHome } from "./own-home.mjs";

const { root: ROOT } = ownHome("en-left-oracle-");
const DIR = realpathSync(ROOT);
const config = { paths: { stateDir: ".git/ennyn" } };

/** An identity of its own (a container derives none), no maintenance racing a reading. */
const SET = ["user.name=t", "user.email=t@t", "commit.gpgsign=false", "protocol.file.allow=always", "gc.auto=0", "maintenance.auto=false"].flatMap((kv) => ["-c", kv]);
/** @param {string} cwd @param {string[]} args */
function g(cwd, args) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** @param {string} dir @param {Record<string, string>} files */
const put = (dir, files) => {
  for (const [p, text] of Object.entries(files)) mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), text);
};
/** @param {string} dir @param {Record<string, string>} files */
const commit = (dir, files) => (put(dir, files), g(dir, ["add", "-A"]), g(dir, ["commit", "-q", "-m", "x"]));

/** A time in the past, so a file's stat in the index is not racy against the index file's own. */
const PAST = new Date(1_000_000_000_000);

/** A repository each state copies: a tracked file of a fixed time, an ignore list, a submodule. */
const BASE = join(DIR, "base");
const SRC = join(DIR, "src");
mkdirSync(SRC), g(SRC, ["init", "-q"]), commit(SRC, { "f.txt": "1\n" });
mkdirSync(BASE), g(BASE, ["init", "-q", "-b", "main"]);
for (const kv of ["gc.auto=0", "maintenance.auto=false", "user.name=t", "user.email=t@t"]) g(BASE, ["config", ...kv.split("=")]);
put(BASE, { "a.txt": "a\n", ".gitignore": "*.log\n" }), utimesSync(join(BASE, "a.txt"), PAST, PAST);
g(BASE, ["add", "-A"]), g(BASE, ["submodule", "add", "-q", SRC, "lib"]), g(BASE, ["commit", "-q", "-m", "base"]);

/** @typedef {{ name: string, start?: (dir: string) => void, cycle: (dir: string) => void, design?: string[] }} State
 *  `design`: the partings the command's design makes, each as the oracle words it, with why in a comment beside it */
/** @type {State[]} */
const STATES = [
  { name: "nothing", cycle: () => {} },
  { name: "new file", cycle: (d) => put(d, { "n.txt": "n\n" }) },
  { name: "new file ignored", cycle: (d) => put(d, { "run.log": "\n" }) },
  { name: "new folder", cycle: (d) => put(d, { "out/a.json": "\n", "out/deep/b.json": "\n" }) },
  { name: "untracked at the start", start: (d) => put(d, { "old.txt": "1\n" }), cycle: () => {} },
  { name: "untracked at the start, removed", start: (d) => put(d, { "old.txt": "1\n" }), cycle: (d) => rmSync(join(d, "old.txt")) },
  { name: "untracked at the start, edited", start: (d) => put(d, { "old.txt": "1\n" }), cycle: (d) => put(d, { "old.txt": "2\n" }) },
  { name: "untracked at the start, swept in", start: (d) => put(d, { "old.txt": "1\n" }), cycle: (d) => commit(d, { "n.txt": "n\n" }) },
  { name: "changed at the start", start: (d) => put(d, { "a.txt": "x\n" }), cycle: () => {} },
  { name: "changed at the start, changed further", start: (d) => put(d, { "a.txt": "x\n" }), cycle: (d) => put(d, { "a.txt": "y\n" }) },
  { name: "changed at the start, committed", start: (d) => put(d, { "a.txt": "x\n" }), cycle: (d) => commit(d, {}) },
  { name: "changed at the start, put back", start: (d) => put(d, { "a.txt": "x\n" }), cycle: (d) => put(d, { "a.txt": "a\n" }) },
  { name: "new file committed", cycle: (d) => commit(d, { "n.txt": "n\n" }) },
  { name: "edited", cycle: (d) => put(d, { "a.txt": "edited\n" }) },
  { name: "deleted", cycle: (d) => rmSync(join(d, "a.txt")) },
  { name: "mode changed", cycle: (d) => chmodSync(join(d, "a.txt"), 0o755) },
  { name: "staged rename", cycle: (d) => g(d, ["mv", "a.txt", "b.txt"]) },
  { name: "intent to add", cycle: (d) => (put(d, { "n.txt": "n\n" }), g(d, ["add", "-N", "n.txt"])) },
  { name: "dirty index", cycle: (d) => (put(d, { "a.txt": "staged\n" }), g(d, ["add", "a.txt"]), put(d, { "a.txt": "a\n" })) },
  { name: "nested repository", cycle: (d) => (mkdirSync(join(d, "nested")), g(join(d, "nested"), ["init", "-q"]), commit(join(d, "nested"), { "f.txt": "1\n" })) },
  { name: "submodule edited", cycle: (d) => put(d, { "lib/f.txt": "edited\n" }) },
  { name: "submodule stray", cycle: (d) => put(d, { "lib/stray.txt": "\n" }) },
  { name: "assume-unchanged, edited", start: (d) => g(d, ["update-index", "--assume-unchanged", "a.txt"]), cycle: (d) => put(d, { "a.txt": "edited\n" }) },
  { name: "assume-unchanged, deleted", start: (d) => g(d, ["update-index", "--assume-unchanged", "a.txt"]), cycle: (d) => rmSync(join(d, "a.txt")) },
  { name: "skip-worktree, gone from disk", start: (d) => g(d, ["update-index", "--skip-worktree", "a.txt"]), cycle: (d) => rmSync(join(d, "a.txt")) },
  { name: "changed at the start, mode changed further", start: (d) => put(d, { "a.txt": "x\n" }), cycle: (d) => chmodSync(join(d, "a.txt"), 0o755) },
  { name: "skip-worktree, edited", start: (d) => g(d, ["update-index", "--skip-worktree", "a.txt"]), cycle: (d) => put(d, { "a.txt": "edited\n" }) },
  // Cycle 27 review, round 1: the index or HEAD moving under the same bytes; a folder entry; flagged entries of
  // another kind or mode; a file that cannot be read; a flag set on a file a text attribute would store otherwise.
  { name: "staged at the start, other bytes staged", start: (d) => (put(d, { "a.txt": "x\n" }), g(d, ["add", "a.txt"]), put(d, { "a.txt": "z\n" })), cycle: (d) => (put(d, { "a.txt": "y\n" }), g(d, ["add", "a.txt"]), put(d, { "a.txt": "z\n" })) },
  { name: "changed at the start, other bytes committed, the start's written back", start: (d) => put(d, { "a.txt": "x\n" }), cycle: (d) => (commit(d, { "a.txt": "y\n" }), put(d, { "a.txt": "x\n" })) },
  { name: "nested repository at the start, edited", start: (d) => (mkdirSync(join(d, "nest")), g(join(d, "nest"), ["init", "-q"]), commit(join(d, "nest"), { "f.txt": "1\n" })), cycle: (d) => put(d, { "nest/f.txt": "cycle\n" }) },
  { name: "submodule changed at the start, edited further", start: (d) => put(d, { "lib/f.txt": "start\n" }), cycle: (d) => put(d, { "lib/f.txt": "cycle\n" }) },
  { name: "assume-unchanged, mode changed", start: (d) => g(d, ["update-index", "--assume-unchanged", "a.txt"]), cycle: (d) => chmodSync(join(d, "a.txt"), 0o755) },
  { name: "assume-unchanged, made a folder", start: (d) => g(d, ["update-index", "--assume-unchanged", "a.txt"]), cycle: (d) => (rmSync(join(d, "a.txt")), put(d, { "a.txt/inner": "x\n" })) },
  { name: "assume-unchanged, made a dangling link", start: (d) => g(d, ["update-index", "--assume-unchanged", "a.txt"]), cycle: (d) => (rmSync(join(d, "a.txt")), symlinkSync("nowhere", join(d, "a.txt"))) },
  {
    name: "a link HEAD holds, assume-unchanged, retargeted",
    start: (d) => (symlinkSync("a.txt", join(d, "ln")), g(d, ["add", "ln"]), g(d, ["commit", "-q", "-m", "ln"]), g(d, ["update-index", "--assume-unchanged", "ln"])),
    cycle: (d) => (rmSync(join(d, "ln")), symlinkSync(".gitignore", join(d, "ln"))),
  },
  { name: "unreadable at the start", start: (d) => (put(d, { "secret.key": "k\n" }), chmodSync(join(d, "secret.key"), 0o000)), cycle: () => {} },
  {
    name: "a text attribute added after a CRLF commit, skip-worktree set by the cycle",
    // Its stat set before it is added, so git status trusts it and reads it clean at the start.
    start: (d) => {
      g(d, ["config", "core.autocrlf", "false"]), put(d, { "w.txt": "one\r\ntwo\r\n" }), utimesSync(join(d, "w.txt"), PAST, PAST);
      g(d, ["add", "w.txt"]), g(d, ["commit", "-q", "-m", "crlf"]), commit(d, { ".gitattributes": "w.txt text\n" });
    },
    cycle: (d) => g(d, ["update-index", "--skip-worktree", "w.txt"]),
  },
  // The command reads ignore rules at the closing: a rule the cycle adds to a list hides the file from it (node
  // leftovers-ignore-rules-from-start).
  { name: "a folder the cycle writes with a .gitignore of *", cycle: (d) => put(d, { "out/.gitignore": "*\n", "out/result.json": "{}\n" }), design: ["misses out/.gitignore", "misses out/result.json"] },
  { name: "a rule the cycle appends to the tracked .gitignore", cycle: (d) => (put(d, { "n.txt": "n\n" }), writeFileSync(join(d, ".gitignore"), "n.txt\n", { flag: "a" })), design: ["misses n.txt"] },
  { name: "core.excludesFile the cycle sets", cycle: (d) => (put(d, { "n.txt": "n\n", ".git/mine": "n.txt\n" }), g(d, ["config", "core.excludesFile", join(d, ".git", "mine")])), design: ["misses n.txt"] },
  { name: "new file hidden in .git/info/exclude", cycle: (d) => (put(d, { "n.txt": "n\n" }), writeFileSync(join(d, ".git", "info", "exclude"), "n.txt\n", { flag: "a" })), design: ["misses n.txt"] },
  {
    name: "same size, time set back",
    start: (d) => (g(d, ["config", "core.trustctime", "false"]), g(d, ["config", "core.checkStat", "minimal"])),
    cycle: (d) => (put(d, { "a.txt": "b\n" }), utimesSync(join(d, "a.txt"), PAST, PAST)),
  },
];

/**
 * What git and the disk hold of the work tree at `dir`; ignored files by the start's rules, whatever list the cycle
 * wrote or changed, in the tree or outside it.
 * @param {string} dir @param {string[]} rules @param {Map<string, Buffer>} [lists] the start's `.gitignore` files; none: these are the start's
 */
function facts(dir, rules, lists) {
  const h = head(dir);
  const files = listing(dir);
  return { files, lists: gitignores(dir, files), index: index(dir), tree: tree(dir, h), ignored: ignoredBy(dir, rules, lists ?? gitignores(dir, files), files), sparse: skipWorktree(dir) };
}

/**
 * What the cycle left between `s` and `e`: each new path, and each path swept in, by the fact alone.
 * @param {ReturnType<typeof facts>} s @param {ReturnType<typeof facts>} e
 */
function left(s, e) {
  const links = [...e.tree, ...e.index].filter(([, v]) => v.startsWith("160000 ")).map(([p]) => p);
  /** A path below a submodule is the submodule's. @param {string} p */
  const owner = (p) => links.find((l) => p === l || p.startsWith(`${l}/`)) ?? p;
  /** @type {Set<string>} */
  const fresh = new Set();
  /** @type {Set<string>} */
  const swept = new Set();
  const paths = new Set([...s.files.keys(), ...e.files.keys(), ...s.index.keys(), ...e.index.keys(), ...s.tree.keys(), ...e.tree.keys()]);
  for (const p of paths) {
    // A folder holds no bytes: at a path HEAD or the index names as a file, it is that file gone.
    const sf = s.files.get(p) === "d" ? undefined : s.files.get(p);
    const ef = e.files.get(p) === "d" ? undefined : e.files.get(p);
    if (sf === undefined && ef === undefined && ![s.index, e.index, s.tree, e.tree].some((m) => m.has(p))) continue;
    if (e.ignored.has(p) || (s.ignored.has(p) && ef === undefined)) continue;
    // A skip-worktree entry gone from disk is what sparse checkout leaves.
    if (e.sparse.has(p) && ef === undefined && e.index.get(p) === e.tree.get(p)) continue;
    const o = owner(p);
    if (o !== p) {
      if (s.files.get(p) !== e.files.get(p)) fresh.add(o);
      continue;
    }
    const committed = e.tree.get(p);
    // A submodule's folder is what its gitlink writes; what changed inside it is counted above.
    const uncommitted = (ef ?? null) !== (committed && !committed.startsWith("160000 ") ? written(committed) : null) || (e.index.get(p) ?? null) !== (committed ?? null);
    const same = sf === ef && s.index.get(p) === e.index.get(p);
    if (uncommitted && !same) fresh.add(p);
    if (sf !== undefined && !s.tree.has(p) && !s.index.has(p) && !s.ignored.has(p) && committed) swept.add(p);
  }
  return { fresh, swept };
}

test("leftovers oracle: the closing names every path new since the start and every one swept in, and nothing that was there at the start", (t) => {
  const rows = [];
  const parted = [];
  for (const st of STATES) {
    const dir = mkdtempSync(join(DIR, "state-"));
    cpSync(BASE, dir, { recursive: true, preserveTimestamps: true });
    st.start?.(dir);
    const rules = localRules(dir, mkdtempSync(join(DIR, "rules-")));
    const s = facts(dir, rules);
    /** @type {ReturnType<typeof leftovers>} */
    let res;
    try {
      recordStart({ cwd: dir, config });
      st.cycle(dir);
      res = leftovers({ cwd: dir, config });
    } catch (err) {
      parted.push(`${st.name}: throws ${/** @type {Error} */ (err).message.split("\n")[0]}`);
      continue;
    }
    const e = facts(dir, rules, s.lists);
    const { fresh, swept } = left(s, e);
    const items = [...res.untracked.items.map((i) => ({ path: i.path, committed: i.committed === true })), ...res.uncommitted.items.flatMap((c) => [c.path, ...(c.from === undefined ? [] : [c.from])].map((path) => ({ path, committed: false })))];
    const names = (/** @type {string} */ p, committed = false) => items.some((i) => i.committed === committed && (i.path === p || (i.path.endsWith("/") && p.startsWith(i.path))));
    const out = [];
    if (res.untracked.state === "unmeasured") out.push("untracked part unmeasured");
    // The command says it compared these by path alone: true of a folder with a repository of its own, a submodule,
    // and a file the start's reading could not read; any other is a parting. A path below a true one is said, not missed.
    const unreadable = (/** @type {string} */ u) =>
      s.files.has(`${u.replace(/\/$/, "")}/.git`) || s.tree.get(u)?.startsWith("160000 ") || s.index.get(u)?.startsWith("160000 ") || / unreadable /.test(s.files.get(u) ?? "");
    for (const u of res.unread ?? []) if (!unreadable(u)) out.push(`names ${u} unread, which the oracle reads`);
    const said = (/** @type {string} */ p) => (res.unread ?? []).some((u) => unreadable(u) && (p === u || p.startsWith(u.endsWith("/") ? u : `${u}/`)));
    for (const p of fresh) if (!names(p) && !said(p)) out.push(`misses ${p}`);
    for (const p of swept) if (!names(p, true)) out.push(`misses ${p}, swept in`);
    for (const i of items) if (![...(i.committed ? swept : fresh)].some((p) => p === i.path || (i.path.endsWith("/") && p.startsWith(i.path)))) out.push(`names ${i.path}${i.committed ? ", swept in" : ""}, which is not new`);
    rows.push(`${st.name}: says ${items.length ? items.map((i) => i.path + (i.committed ? " (swept)" : "")).join(", ") : "clean"}; new: ${[...fresh].join(", ") || "nothing"}; swept: ${[...swept].join(", ") || "nothing"}`);
    const unexpected = out.filter((o) => !st.design?.includes(o));
    if (unexpected.length) parted.push(`${st.name}: ${unexpected.join("; ")}`);
    for (const d of st.design ?? []) if (!out.includes(d)) parted.push(`${st.name}: the design's parting "${d}" is gone: take it out of the corpus`);
  }
  for (const r of rows) t.diagnostic(r);
  assert.deepEqual(parted, [], rows.join("\n"));
});
