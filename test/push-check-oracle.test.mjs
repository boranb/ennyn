/**
 * Does `ennyn push-check` say the cycle may push only where a bare `git push` sends exactly the tested tree's commit,
 * from a clean tree, with nothing behind? Its own tests (test/cli.test.mjs) hold each verdict as a hand-written exit;
 * the class this file is for, a verdict that stands for a fact and parts from it on some state
 * (`stand-in-for-the-fact`), stands behind push-check's record (a tree hash for "tested"), its mode reading and its
 * reading of git config (for "what the push sends"). Here each fact is read from git and the file system alone, never
 * from checks/push-mode.mjs, checks/test-runs.mjs or core/git.mjs:
 *
 * - what the push sends: `git push --dry-run --porcelain` from the checkout, its exit and the lines it prints, against
 *   the upstream's single url (`git config --get-all`, `git remote get-url --push --all`);
 * - what was tested: the last run on HEAD's tree in the record (`<common git dir>/ennyn/test-runs.jsonl`, read as bytes)
 *   green, or the commit `--tested` names holding HEAD's tree with no red run on it in the record;
 * - a clean tree: `git status --porcelain` empty;
 * - the mode: `push.mode` after-closing in HEAD's `.ennyn/config.json` and the work tree's, and the approval line on the
 *   last commit that changed the file;
 * - who wrote what the push sends (`commits` in HEAD's config): each commit of `@{u}..HEAD` by an address the list
 *   holds, and with `signed` one `git verify-commit -v` calls good, for the committer's own address.
 *
 * "May push" is exit 0 with the line that says so (`push.modeRecorded`, `push.modeTested`). The test fails where
 * push-check says it may push and a fact does not hold, where every fact holds and it asks, and where it exits 0, in
 * any mode, without that line (skills/cycle/push.md, step 4, reads exit 0 as the push), unless the corpus names that
 * parting as known: an ask of the design's, with why. The record is written by the real `ennyn test`, never by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownHome } from "./own-home.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const { root: ROOT } = ownHome("en-push-oracle-");
const DIR = realpathSync(ROOT);

/** An identity of its own (a container derives none), no maintenance racing a reading. */
const SET = ["user.name=t", "user.email=t@t", "commit.gpgsign=false", "protocol.file.allow=always", "advice.detachedHead=false", "gc.auto=0", "maintenance.auto=false"].flatMap((kv) => ["-c", kv]);
/** git that may fail. @param {string} cwd @param {string[]} args */
function gq(cwd, args) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000, killSignal: "SIGKILL" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}
/** @param {string} cwd @param {string[]} args */
function g(cwd, args) {
  const r = gq(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}
const lines = (/** @type {string} */ s) => s.split("\n").filter(Boolean);
/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, killSignal: "SIGKILL" });

const APPROVAL = "User-Approved-Loosening: push.mode";

/** A signing key made here, and an allowed-signers file that lists it for the corpus's address t@t. */
const KEY = join(DIR, "key");
const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", KEY], { encoding: "utf8" });
if (keygen.status !== 0) throw new Error(`ssh-keygen: ${keygen.stderr}`);
const SIGNERS = join(DIR, "allowed_signers");
writeFileSync(SIGNERS, `t@t namespaces="git" ${readFileSync(`${KEY}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ")}\n`);

/**
 * A corpus repository: a bare upstream, a checkout of main tracking it with a pushed commit that sets the config, and
 * a second commit not pushed yet. Nothing is recorded. `before`: a commit ahead of the config's, so a clone of depth 2
 * is shallow and still holds the approval.
 */
class Repo {
  /** @param {string} name @param {{ mode?: string, approve?: boolean, upstream?: boolean, before?: boolean, commits?: object }} [o] */
  constructor(name, { mode = "after-closing", approve = true, upstream = true, before = false, commits } = {}) {
    this.bare = join(DIR, `${name}.git`);
    this.dir = join(DIR, name);
    g(DIR, ["init", "-q", "--bare", "-b", "main", this.bare]);
    g(DIR, ["init", "-q", "-b", "main", this.dir]);
    if (before) this.commit("chore: zero", { "z.txt": "z\n" });
    this.put({ ".ennyn/config.json": JSON.stringify({ push: { mode }, commands: { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' }, ...(commits ? { commits } : {}) }), "a.txt": "1\n" });
    this.commit(`chore: push by itself${approve ? `\n\n${APPROVAL}` : ""}`);
    g(this.dir, ["remote", "add", "origin", this.bare]);
    g(this.dir, ["push", "-q", ...(upstream ? ["-u"] : []), "origin", "main"]);
    this.put({ "a.txt": "2\n" }), this.commit("chore: two");
  }
  /** @param {Record<string, string>} files */
  put(files) {
    for (const [p, text] of Object.entries(files)) mkdirSync(dirname(join(this.dir, p)), { recursive: true }), writeFileSync(join(this.dir, p), text);
  }
  commit(msg = "chore: more", files = {}) {
    this.put(files), g(this.dir, ["add", "-A"]), g(this.dir, ["commit", "-q", "--allow-empty", "-m", msg]);
    return this.head();
  }
  head() {
    return g(this.dir, ["rev-parse", "HEAD"]);
  }
  /** A run recorded by the real `ennyn test`, run again on a tree with a green run. @param {"fast" | "whole"} kind @param {number} exit */
  test(kind, exit) {
    const r = cli(this.dir, ["test", kind, "--again"], { T_EXIT: String(exit) });
    if (r.status !== exit || !/Recorded/.test(r.stdout)) throw new Error(`ennyn test ${kind} recorded nothing: ${r.status} ${r.stdout}${r.stderr}`);
  }
  /** HEAD made again, signed with the corpus's key, read through its allowed-signers file. */
  sign() {
    g(this.dir, ["config", "gpg.ssh.allowedSignersFile", SIGNERS]);
    g(this.dir, ["-c", "gpg.format=ssh", "-c", `user.signingkey=${KEY}.pub`, "commit", "-q", "--amend", "--no-edit", "-S"]);
    return this;
  }
  /** A second bare repository. @param {string} name */
  other(name) {
    const p = join(DIR, `${this.dir.split("/").pop()}-${name}.git`);
    g(DIR, ["init", "-q", "--bare", "-b", "main", p]);
    return p;
  }
}

/**
 * @typedef {{ name: string, build: () => Repo, words?: (r: Repo) => [string, string][], known?: Record<string, Record<string, string>> }} Case
 *   `words`: what else `--tested` names, as [label, word], besides nothing (`none`) and HEAD's hash (`HEAD`); `known`:
 *   by label, each parting the oracle words for that run, with why: the design's
 */
const ASKS = "asks where every fact holds";
/** push.md step 4 pushes on exit 0: in every mode, exit 0 is the line that says the cycle may push, and nothing else. */
const ZERO = "exits 0 without saying it may push";
/** @type {Case[]} */
const CASES = [
  { name: "green on HEAD's tree", build: () => ((r) => (r.test("whole", 0), r))(new Repo("green")) },
  { name: "green on the parent's tree, HEAD one commit past", build: () => ((r) => (r.test("whole", 0), r.commit("chore: three", { "a.txt": "3\n" }), r))(new Repo("parent")), words: (r) => [["HEAD~1", g(r.dir, ["rev-parse", "HEAD~1"])]] },
  { name: "red on HEAD's tree", build: () => ((r) => (r.test("whole", 3), r))(new Repo("red")) },
  { name: "green, then red on HEAD's tree", build: () => ((r) => (r.test("whole", 0), r.test("whole", 3), r))(new Repo("green-red")) },
  { name: "red, then green on HEAD's tree", build: () => ((r) => (r.test("whole", 3), r.test("whole", 0), r))(new Repo("red-green")) },
  {
    name: "no record, --tested names HEAD, the parent and a name",
    build: () => new Repo("word"),
    words: (r) => [["HEAD~1", g(r.dir, ["rev-parse", "HEAD~1"])], ["main", "main"], ["HEAD short", r.head().slice(0, 7)]],
    // A name could move between the test and the push: only a hash is taken.
    known: { main: { [ASKS]: "a name is refused, not resolved" } },
  },
  { name: "an empty commit past the green one: the same tree", build: () => ((r) => (r.test("whole", 0), r.commit("chore: empty"), r))(new Repo("empty")), words: (r) => [["HEAD~1", g(r.dir, ["rev-parse", "HEAD~1"])]] },
  {
    name: "no record, an empty commit past the one --tested names: the same tree",
    build: () => ((r) => (r.commit("chore: empty"), r))(new Repo("empty-word")),
    words: (r) => [["HEAD~1", g(r.dir, ["rev-parse", "HEAD~1"])]],
    // The caller's word names a commit, and only HEAD is the commit the push sends.
    known: { "HEAD~1": { [ASKS]: "--tested must name HEAD itself, not a commit of the same tree" } },
  },
  {
    name: "a later commit back on the green tree",
    build: () => ((r) => (r.test("whole", 0), r.commit("chore: three", { "a.txt": "3\n" }), r.commit("chore: back", { "a.txt": "2\n" }), r))(new Repo("back")),
  },
  { name: "green, then a tracked change", build: () => ((r) => (r.test("whole", 0), r.put({ "a.txt": "x\n" }), r))(new Repo("tracked")) },
  { name: "green, then a staged change", build: () => ((r) => (r.test("whole", 0), r.put({ "a.txt": "x\n" }), g(r.dir, ["add", "a.txt"]), r))(new Repo("staged")) },
  { name: "green, then an untracked file", build: () => ((r) => (r.test("whole", 0), r.put({ "u.txt": "u\n" }), r))(new Repo("untracked")) },
  { name: "no record, a tracked change", build: () => ((r) => (r.put({ "a.txt": "x\n" }), r))(new Repo("word-tracked")) },
  { name: "no record, an untracked file", build: () => ((r) => (r.put({ "u.txt": "u\n" }), r))(new Repo("word-untracked")) },
  { name: "green, then an ignored file", build: () => ((r) => (r.test("whole", 0), r.put({ "u.txt": "u\n", ".git/info/exclude": "u.txt\n" }), r))(new Repo("ignored")) },
  {
    name: "green, the upstream moved by another clone, not fetched",
    build: () => {
      const r = new Repo("behind");
      r.test("whole", 0);
      const o = join(DIR, "behind-other");
      g(DIR, ["clone", "-q", r.bare, o]), writeFileSync(join(o, "b.txt"), "b\n"), g(o, ["add", "-A"]), g(o, ["commit", "-q", "-m", "chore: theirs"]), g(o, ["push", "-q", "origin", "main"]);
      return r;
    },
  },
  {
    name: "green, the upstream moved and fetched",
    build: () => {
      const r = new Repo("behind-fetched");
      r.test("whole", 0);
      const o = join(DIR, "behind-fetched-other");
      g(DIR, ["clone", "-q", r.bare, o]), writeFileSync(join(o, "b.txt"), "b\n"), g(o, ["add", "-A"]), g(o, ["commit", "-q", "-m", "chore: theirs"]), g(o, ["push", "-q", "origin", "main"]);
      g(r.dir, ["fetch", "-q", "origin"]);
      return r;
    },
  },
  { name: "green, two upstream urls", build: () => ((r) => (r.test("whole", 0), g(r.dir, ["remote", "set-url", "--add", "origin", r.other("second")]), r))(new Repo("two-urls")) },
  {
    name: "green, remote.origin.push sends main and deletes side",
    build: () => {
      const r = new Repo("refspec-delete");
      g(r.dir, ["push", "-q", "origin", "HEAD~1:refs/heads/side"]), r.test("whole", 0);
      g(r.dir, ["config", "--add", "remote.origin.push", "refs/heads/main:refs/heads/main"]), g(r.dir, ["config", "--add", "remote.origin.push", ":refs/heads/side"]);
      return r;
    },
  },
  { name: "green, push.followTags with an annotated tag", build: () => ((r) => (r.test("whole", 0), g(r.dir, ["tag", "-a", "-m", "v", "v1"]), g(r.dir, ["config", "push.followTags", "true"]), r))(new Repo("follow-tags")) },
  { name: "green, a pushInsteadOf rewrite", build: () => ((r) => (r.test("whole", 0), g(r.dir, ["config", `url.${r.other("insteadof")}.pushInsteadOf`, r.bare]), r))(new Repo("push-insteadof")) },
  { name: "green, a pushurl elsewhere", build: () => ((r) => (r.test("whole", 0), g(r.dir, ["config", "remote.origin.pushurl", r.other("pushurl")]), r))(new Repo("pushurl")) },
  {
    name: "green, branch.main.pushRemote another remote",
    build: () => ((r) => (r.test("whole", 0), g(r.dir, ["remote", "add", "other", r.other("remote")]), g(r.dir, ["config", "branch.main.pushRemote", "other"]), r))(new Repo("push-remote")),
  },
  {
    name: "green, push.default matching with a second branch on the upstream",
    build: () => {
      const r = new Repo("matching");
      g(r.dir, ["push", "-q", "origin", "HEAD~1:refs/heads/side"]), g(r.dir, ["branch", "side", "HEAD"]);
      r.test("whole", 0), g(r.dir, ["config", "push.default", "matching"]);
      return r;
    },
  },
  { name: "green, no upstream", build: () => ((r) => (r.test("whole", 0), r))(new Repo("no-upstream", { upstream: false })) },
  { name: "green, HEAD detached", build: () => ((r) => (r.test("whole", 0), g(r.dir, ["checkout", "-q", "--detach"]), r))(new Repo("detached")) },
  { name: "ask, every other fact met", build: () => ((r) => (r.test("whole", 0), r))(new Repo("ask", { mode: "ask" })) },
  { name: "after-closing with no approval line", build: () => ((r) => (r.test("whole", 0), r))(new Repo("unapproved", { approve: false })) },
  {
    name: "after-closing in the work tree only",
    build: () => {
      const r = new Repo("work-only", { mode: "ask" });
      r.test("whole", 0), r.put({ ".ennyn/config.json": JSON.stringify({ push: { mode: "after-closing" }, commands: { wholeTest: 'exit "$T_EXIT"' } }) });
      g(r.dir, ["update-index", "--assume-unchanged", ".ennyn/config.json"]);
      return r;
    },
  },
  {
    name: "after-closing at HEAD, ask in the work tree",
    build: () => {
      const r = new Repo("head-only");
      r.test("whole", 0), r.put({ ".ennyn/config.json": JSON.stringify({ push: { mode: "ask" }, commands: { wholeTest: 'exit "$T_EXIT"' } }) });
      g(r.dir, ["update-index", "--assume-unchanged", ".ennyn/config.json"]);
      return r;
    },
  },
  { name: "a red fast run only, where the codeGlobs ask a whole one", build: () => ((r) => (r.test("fast", 3), r))(new Repo("red-fast")) },
  {
    name: "a green fast run only, where the codeGlobs ask a whole one",
    build: () => ((r) => (r.test("fast", 0), r))(new Repo("fast")),
    // push.codeGlobs (every path by default) asks a whole run for a change to code: a fast one is less than asked.
    known: { none: { [ASKS]: "a green fast run does not meet a push that changes code" } },
  },
  {
    name: "green, nothing to push",
    build: () => ((r) => (r.test("whole", 0), g(r.dir, ["push", "-q"]), r))(new Repo("pushed")),
    // With nothing to send, the record is not read: the caller's word is asked.
    known: { none: { [ASKS]: "nothing to push needs no run, so the record is not read" } },
  },
  {
    name: "a shallow clone, green",
    build: () => {
      const r = new Repo("shallow-src");
      g(r.dir, ["push", "-q"]);
      const s = join(DIR, "shallow");
      g(DIR, ["clone", "-q", "--depth", "1", `file://${r.bare}`, s]);
      const c = Object.assign(Object.create(Repo.prototype), { dir: s, bare: r.bare });
      c.commit("chore: three", { "a.txt": "3\n" }), c.test("whole", 0);
      return c;
    },
  },
  {
    name: "a shallow clone that holds the approval, green",
    build: () => {
      const r = new Repo("shallow-held-src", { before: true });
      g(r.dir, ["push", "-q"]);
      const s = join(DIR, "shallow-held");
      g(DIR, ["clone", "-q", "--depth", "2", `file://${r.bare}`, s]);
      const c = Object.assign(Object.create(Repo.prototype), { dir: s, bare: r.bare });
      c.commit("chore: three", { "a.txt": "3\n" }), c.test("whole", 0);
      return c;
    },
    // push.md: a shallow clone always asks, whatever history it holds.
    known: { none: { [ASKS]: "a shallow clone asks" }, HEAD: { [ASKS]: "a shallow clone asks" } },
  },
  { name: "green, commits.signed, an unsigned commit", build: () => ((r) => (g(r.dir, ["config", "gpg.ssh.allowedSignersFile", SIGNERS]), r.test("whole", 0), r))(new Repo("unsigned", { commits: { signed: true } })) },
  { name: "green, commits.signed, every commit signed by a listed key", build: () => ((r) => (r.sign().test("whole", 0), r))(new Repo("signed", { commits: { addresses: ["T@t"], signed: true } })) },
  { name: "green, commits.signed, signed with no allowed-signers file", build: () => ((r) => (r.sign(), g(r.dir, ["config", "--unset", "gpg.ssh.allowedSignersFile"]), r.test("whole", 0), r))(new Repo("signed-unread", { commits: { signed: true } })) },
  { name: "green, commits.addresses without the committer's", build: () => ((r) => (r.test("whole", 0), r))(new Repo("address", { commits: { addresses: ["o@t"] } })) },
  {
    name: "green, commits.signed, ask, every commit signed by a listed key",
    build: () => ((r) => (r.sign().test("whole", 0), r))(new Repo("signed-ask", { mode: "ask", commits: { addresses: ["t@t"], signed: true } })),
  },
  {
    name: "green, the upstream branch deleted",
    // git refuses to delete a bare repository's current branch unless it is told to (2.56.0).
    build: () => ((r) => (r.test("whole", 0), g(r.bare, ["config", "receive.denyDeleteCurrent", "ignore"]), g(r.dir, ["push", "-q", "origin", "--delete", "main"]), r))(new Repo("upstream-gone")),
    // An upstream git cannot read leaves what the push needs unmeasured: it asks, though the push would make the branch.
    known: { none: { [ASKS]: "an upstream that is not there is unmeasured" }, HEAD: { [ASKS]: "an upstream that is not there is unmeasured" } },
  },
];

/** What push-check prints where it says the cycle may push (i18n/en.json, push.modeRecorded and push.modeTested). */
const SAYS = /^push\.mode is after-closing and .*: push \S+ with a bare git push/m;

/**
 * The facts of `dir`, from git and the file system alone; `word`: what `--tested` names.
 * @param {string} dir @param {string | undefined} word
 */
function facts(dir, word) {
  const branch = gq(dir, ["symbolic-ref", "-q", "--short", "HEAD"]).out || null;
  const remote = branch ? gq(dir, ["config", "--get", `branch.${branch}.remote`]).out || null : null;
  const urls = remote ? lines(gq(dir, ["config", "--get-all", `remote.${remote}.url`]).out) : [];
  const pushUrls = remote ? lines(gq(dir, ["remote", "get-url", "--push", "--all", remote]).out) : [];
  // What a bare git push would send, by git itself; nothing leaves the machine (the upstreams are bare folders here).
  const dry = gq(dir, ["push", "--dry-run", "--porcelain"]);
  // Each line is `To <url>`, `Done` or a ref line `<flag>\t<from>:<to>\t<summary>`; a deletion's `from` is empty. A
  // line of no such shape is something the push does that this reading cannot name: it sends more than HEAD.
  const said = lines(dry.out).filter((l) => l !== "Done");
  const to = said.filter((l) => l.startsWith("To "));
  const parsed = said.filter((l) => !l.startsWith("To ")).map((l) => /^(.)\t([^:\t]*):([^\t]+)\t(.*)$/.exec(l));
  const refs = parsed.filter((m) => m !== null);
  const headCommit = gq(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).out;
  const headTree = g(dir, ["rev-parse", "HEAD^{tree}"]);
  // A fast-forward (flag space) says `<old>..<new>`: what it sends ends at HEAD. `=` is up to date, `*` a new branch.
  const ends = (/** @type {string} */ summary) => /^[0-9a-f]+\.\.[0-9a-f]+$/.test(summary) && gq(dir, ["rev-parse", "--verify", "-q", `${summary.split("..")[1]}^{commit}`]).out === headCommit;
  const sends =
    dry.status === 0 &&
    urls.length === 1 &&
    pushUrls.length === 1 &&
    pushUrls[0] === urls[0] &&
    to.length === 1 &&
    to[0] === `To ${urls[0]}` &&
    refs.length === 1 &&
    refs.length === parsed.length &&
    refs[0][2] === `refs/heads/${branch}` &&
    refs[0][3] === `refs/heads/${branch}` &&
    (refs[0][1] === "=" || refs[0][1] === "*" || (refs[0][1] === " " && ends(refs[0][4])));
  const ahead = remote ? lines(gq(dir, ["rev-list", "@{u}..HEAD"]).out).length : null;
  // The record, read as bytes: its runs on HEAD's tree, the last one deciding.
  const common = g(dir, ["rev-parse", "--git-common-dir"]);
  const file = join(isAbsolute(common) ? common : join(dir, common), "ennyn", "test-runs.jsonl");
  const onTree = (existsSync(file) ? lines(readFileSync(file, "utf8")) : []).map((l) => JSON.parse(l)).filter((o) => o.tree === headTree);
  const recorded = onTree.at(-1)?.exit === 0;
  const red = onTree.some((o) => o.exit !== 0);
  const named = word === undefined ? null : gq(dir, ["rev-parse", "--verify", "-q", `${word}^{commit}`]).out || null;
  const worded = named !== null && g(dir, ["rev-parse", `${named}^{tree}`]) === headTree && !red;
  const clean = g(dir, ["status", "--porcelain=v1", "--untracked-files=normal"]) === "";
  const modeOf = (/** @type {string | null} */ text) => {
    try {
      return text === null ? "ask" : String(JSON.parse(text).push?.mode ?? "ask");
    } catch {
      return "unread";
    }
  };
  const atHead = gq(dir, ["show", "HEAD:.ennyn/config.json"]);
  const work = join(dir, ".ennyn", "config.json");
  const mode = modeOf(atHead.status === 0 ? atHead.out : null) === "after-closing" && modeOf(existsSync(work) ? readFileSync(work, "utf8") : null) === "after-closing" ? "after-closing" : "ask";
  const approved = gq(dir, ["log", "-1", "--format=%B", "HEAD", "--", ".ennyn/config.json"]).out.split("\n").includes(APPROVAL);
  // commits.*: each commit the push sends, by an address the list holds, and signed good for its committer by git's own check.
  const rule = (() => {
    try {
      return atHead.status === 0 ? JSON.parse(atHead.out).commits ?? {} : {};
    } catch {
      return {};
    }
  })();
  const listed = (rule.addresses ?? []).map((/** @type {string} */ a) => a.toLowerCase());
  const own = (/** @type {string} */ h) => {
    const [author, committer] = g(dir, ["log", "-1", "--format=%ae%n%ce", h]).toLowerCase().split("\n");
    if (listed.length && !(listed.includes(author) && listed.includes(committer))) return false;
    if (!rule.signed) return true;
    const v = gq(dir, ["verify-commit", "-v", h]);
    return v.status === 0 && /Good "git" signature for (\S+) with/.exec(v.err)?.[1]?.toLowerCase() === committer;
  };
  const shallow = g(dir, ["rev-parse", "--is-shallow-repository"]) === "true";
  const written = (!listed.length && !rule.signed) || (remote !== null && !shallow && gq(dir, ["rev-parse", "--verify", "-q", "@{u}"]).status === 0 && lines(g(dir, ["rev-list", "@{u}..HEAD"])).every(own));
  const may = mode === "after-closing" && approved && sends && (recorded || worded) && clean && written;
  return { may, sends, ahead, recorded, worded, red, clean, mode, approved, written, dry: dry.status };
}

test("push-check oracle: it says the cycle may push only where the push sends the tested tree's commit from a clean tree, and asks nowhere else the facts allow", (t) => {
  const rows = [];
  const parted = [];
  for (const c of CASES) {
    const r = c.build();
    const head = r.head();
    /** @type {[string, string | undefined][]} */
    const runs = [["none", undefined], ["HEAD", head], ...(c.words?.(r) ?? [])];
    for (const [label, word] of runs) {
      const f = facts(r.dir, word);
      const res = cli(r.dir, ["push-check", ...(word === undefined ? [] : ["--tested", word])]);
      const says = SAYS.test(res.stdout);
      const name = `${c.name}, --tested ${label}`;
      rows.push(`${name}: exit ${res.status}, ${says ? "may push" : "asks"}; facts ${JSON.stringify(f)}`);
      const out = [];
      if (says && res.status !== 0) out.push(`says it may push and exits ${res.status}`);
      if (says && !f.may) out.push("says it may push where the facts do not hold");
      if (!says && f.may) out.push(ASKS);
      if (!says && res.status === 0) out.push(ZERO);
      const known = c.known?.[label] ?? {};
      for (const o of out) if (!(o in known)) parted.push(`${name}: ${o}`);
      for (const k of Object.keys(known)) if (!out.includes(k)) parted.push(`${name}: the known parting "${k}" (${known[k]}) is gone: take it out of the corpus`);
    }
  }
  // Each row a diagnostic, and no long message on the assertion: a failing one of some 12 KB held node 22's test
  // runner at full CPU past a 40-minute limit after the file's own process had ended (measured on 22.23.4).
  for (const r of rows) t.diagnostic(r);
  assert.deepEqual(parted, []);
});
