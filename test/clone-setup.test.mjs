/**
 * commits.* (checks/commit-identity.mjs, setup/clone-setup.mjs): the config key, push-check's refusal of a push whose
 * commits are unsigned or written from an address outside the list, doctor's line on a clone that lacks its settings,
 * and `ennyn clone-setup`, which prints those settings and builds the allowed-signers file from a forge's keys.
 *
 * Every signature is made by a real git with SSH keys ssh-keygen makes in the file's temporary folder, and verified by
 * that git through the allowed-signers file: what push-check says is held against what `git verify-commit` says of
 * the same commit. The forge is a loopback server: no test reaches the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, DEFAULTS, loadConfig } from "../core/config.mjs";
import { gateKeyKind, loosenedKeys } from "../checks/loosening.mjs";
import { addressFold, cloneGaps, commitRule, commitsRefused, strictest } from "../checks/commit-identity.mjs";
import { apiBase, noreplyLogin, signersText, signingKeys } from "../setup/clone-setup.mjs";
import { ownHome } from "./own-home.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const { root: ROOT } = ownHome("en-clone-setup-");
const DIR = realpathSync(ROOT);

/** No maintenance racing a reading; signing only where a call asks for it. */
const SET = ["commit.gpgsign=false", "tag.gpgsign=false", "gc.auto=0", "maintenance.auto=false", "advice.detachedHead=false", "protocol.file.allow=always"].flatMap((kv) => ["-c", kv]);
/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
function gq(cwd, args, env = {}) {
  const r = spawnSync("git", [...SET, "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, timeout: 60_000, killSignal: "SIGKILL" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}
/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
function g(cwd, args, env = {}) {
  const r = gq(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}
/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [env] */
const cli = (cwd, args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, T_EXIT: "0", ...env }, timeout: 120_000, killSignal: "SIGKILL" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

/** Keys made here: a and b listed for their addresses, c listed for none. */
const KEYS = join(DIR, "keys");
mkdirSync(KEYS);
for (const k of ["a", "b", "c"]) {
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", k, "-f", join(KEYS, k)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ssh-keygen: ${r.stderr}`);
}
const pub = (/** @type {string} */ k) => readFileSync(join(KEYS, `${k}.pub`), "utf8").trim().split(" ").slice(0, 2).join(" ");
const SIGNERS = join(DIR, "allowed_signers");
writeFileSync(SIGNERS, signersText("a@x.test", [pub("a")]) + signersText("b@x.test", [pub("b")]));

/** Signed by key `k` (git's own SSH signing), or unsigned. @param {string | null} k */
const signing = (k) => (k ? ["-c", "gpg.format=ssh", "-c", `user.signingkey=${join(KEYS, `${k}.pub`)}`] : []);
/** @param {string} author @param {string} committer */
const who = (author, committer) => ({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: committer });

let n = 0;
/**
 * A clone with a bare upstream: its first commit holds the config and is pushed, signed by a; nothing else yet.
 * `signers`: gpg.ssh.allowedSignersFile is set to the file of a and b.
 * @param {Record<string, unknown>} commits @param {{ signers?: boolean, mode?: string }} [o]
 */
function repo(commits, { signers = true, mode = "ask" } = {}) {
  const name = `r${++n}`;
  const bare = join(DIR, `${name}.git`);
  const dir = join(DIR, name);
  g(DIR, ["init", "-q", "--bare", "-b", "main", bare]);
  g(DIR, ["init", "-q", "-b", "main", dir]);
  g(dir, ["config", "user.name", "t"]), g(dir, ["config", "user.email", "a@x.test"]);
  if (signers) g(dir, ["config", "gpg.ssh.allowedSignersFile", SIGNERS]);
  mkdirSync(join(dir, ".ennyn"));
  writeFileSync(join(dir, ".ennyn", "config.json"), JSON.stringify({ commits, push: { mode }, commands: { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' } }));
  g(dir, ["add", "-A"]);
  g(dir, [...signing("a"), "commit", "-q", "-S", "-m", `chore: config${mode === "ask" ? "" : "\n\nUser-Approved-Loosening: push.mode"}`], who("a@x.test", "a@x.test"));
  g(dir, ["remote", "add", "origin", bare]), g(dir, ["push", "-q", "-u", "origin", "main"]);
  return {
    dir,
    bare,
    /** @param {string | null} k @param {string} [author] @param {string} [committer] */
    commit(k, author = "a@x.test", committer = author) {
      g(dir, [...signing(k), "commit", "-q", "--allow-empty", ...(k ? ["-S"] : []), "-m", `chore: c${++n}`], who(author, committer));
      return g(dir, ["rev-parse", "HEAD"]);
    },
    /** The whole test, recorded green on HEAD's tree by the real `ennyn test`. */
    tested() {
      const r = cli(dir, ["test", "whole", "--again"]);
      if (r.code !== 0) throw new Error(`ennyn test whole: ${r.code} ${r.out}${r.err}`);
    },
  };
}
const BOTH = { addresses: ["a@x.test", "b@x.test"], signed: true };
const LINE = /^ {2}([0-9a-f]{12}) (.*)$/gm;
/** push-check's refusal lines, by short hash. @param {string} out */
const refusals = (out) => Object.fromEntries([...out.matchAll(LINE)].map((m) => [m[1], m[2]]));
/** What git itself says of a commit's signature here: verify-commit's exit and the principal it names. @param {string} dir @param {string} h */
function verified(dir, h) {
  const r = gq(dir, ["verify-commit", "-v", h]);
  return { ok: r.status === 0, principal: /Good "git" signature for (\S+) with/.exec(r.err)?.[1] ?? null };
}

test("commits: the key is unset by default, its addresses are checked as a list of plain addresses, and loosening it is said", () => {
  assert.deepEqual(DEFAULTS.commits, { addresses: [], signed: false });
  const at = mkdtempSync(join(DIR, "cfg-"));
  const load = (/** @type {unknown} */ commits) => loadConfig({ cwd: at, env: {}, override: /** @type {any} */ ({ commits }) });
  assert.equal(commitRule(load({})), null);
  assert.deepEqual(commitRule(load({ addresses: ["A@X.test"] })), { addresses: ["a@x.test"], signed: false });
  assert.deepEqual(commitRule(load({ signed: true })), { addresses: null, signed: true });
  // The strictest of several: signing when any asks, an address only when every set list holds it.
  assert.deepEqual(strictest([null, { addresses: ["a@x.test", "b@x.test"], signed: false }, { addresses: ["b@x.test"], signed: true }, { addresses: null, signed: false }]), { addresses: ["b@x.test"], signed: true });
  assert.deepEqual(strictest([{ addresses: ["a@x.test"], signed: false }, { addresses: ["b@x.test"], signed: false }]), { addresses: [], signed: false });
  assert.equal(strictest([null, null]), null);
  assert.ok(load({ addresses: ["1+lo-gin@users.noreply.github.com", "a@b"] }));
  // Accept above, reject here: a principal an allowed-signers file would read as a pattern or as two.
  for (const bad of ["*@x.test", "a,b@x.test", "a b@x.test", "a@@x.test", "a", "", '"a"@x.test', "!a@x.test", "a@x.test ", "a?@x.test"]) {
    assert.throws(() => load({ addresses: [bad] }), (e) => e instanceof ConfigError && e.problems.some((p) => p.startsWith('"commits.addresses" entries')), bad);
  }
  assert.throws(() => load({ addresses: [3] }), (e) => e instanceof ConfigError && e.problems.includes('"commits.addresses" must be a list of strings'));
  assert.throws(() => load({ addresses: "a@x.test" }), ConfigError);
  assert.throws(() => load({ signed: "yes" }), (e) => e instanceof ConfigError && e.problems.some((p) => p.includes('"commits.signed" must be boolean')));
  assert.throws(() => load({ other: 1 }), (e) => e instanceof ConfigError && e.problems.includes('unknown key "commits.other"'));
  assert.equal(gateKeyKind("commits.addresses"), "gate");
  assert.equal(gateKeyKind("commits.signed"), "gate");
  const moved = (/** @type {any} */ a, /** @type {any} */ b) => loosenedKeys({ ...DEFAULTS, commits: a }, { ...DEFAULTS, commits: b });
  assert.deepEqual(moved({ addresses: ["a@x.test"], signed: true }, { addresses: ["a@x.test", "b@x.test"], signed: true }), ["commits.addresses"]);
  assert.deepEqual(moved({ addresses: ["a@x.test"], signed: true }, { addresses: [], signed: false }), ["commits.addresses", "commits.signed"]);
  assert.deepEqual(moved({ addresses: [], signed: false }, { addresses: ["a@x.test"], signed: true }), []);
  assert.deepEqual(moved({ addresses: ["a@x.test", "b@x.test"], signed: false }, { addresses: ["a@x.test"], signed: false }), []);
});

test("commits: push-check refuses each commit the push sends that is unsigned, signed by a key not listed for its committer, or by an address outside the list, and exits 1 in every mode", () => {
  /** @type {[string, (r: ReturnType<typeof repo>) => string, RegExp | null][]} */
  const corpus = [
    ["unsigned", (r) => r.commit(null), /^unsigned$/],
    ["signed by a listed key, its own address", (r) => r.commit("a"), null],
    ["signed by the other listed address's key, as that address", (r) => r.commit("b", "b@x.test"), null],
    ["signed by a key the file does not list", (r) => r.commit("c"), /%G\? is U, a good signature by a key the allowed-signers file does not list/],
    ["signed by a key listed for another address", (r) => r.commit("b"), /^signed by a key the allowed-signers file lists for b@x\.test, not for its committer a@x\.test$/],
    ["an author outside the list", (r) => r.commit("a", "c@x.test", "a@x.test"), /^author c@x\.test is not in commits\.addresses$/],
    ["a committer outside the list", (r) => r.commit("a", "a@x.test", "c@x.test"), /^committer c@x\.test is not in commits\.addresses; signed by a key the allowed-signers file lists for a@x\.test, not for its committer c@x\.test$/],
    ["the addresses in another case", (r) => r.commit("a", "A@X.Test"), null],
    [
      "a signed merge of a signed branch",
      (r) => {
        g(r.dir, ["checkout", "-q", "-b", "side"]), r.commit("b", "b@x.test"), g(r.dir, ["checkout", "-q", "main"]), r.commit("a");
        g(r.dir, [...signing("a"), "merge", "-q", "--no-ff", "-S", "-m", "chore: merge", "side"], who("a@x.test", "a@x.test"));
        return g(r.dir, ["rev-parse", "HEAD"]);
      },
      null,
    ],
    [
      "an unsigned merge of a signed branch",
      (r) => {
        g(r.dir, ["checkout", "-q", "-b", "side"]), r.commit("b", "b@x.test"), g(r.dir, ["checkout", "-q", "main"]), r.commit("a");
        g(r.dir, ["merge", "-q", "--no-ff", "-m", "chore: merge", "side"], who("a@x.test", "a@x.test"));
        return g(r.dir, ["rev-parse", "HEAD"]);
      },
      /^unsigned$/,
    ],
  ];
  for (const [name, make, refused] of corpus) {
    for (const mode of ["ask", "after-closing"]) {
      const r = repo(BOTH, { mode });
      const h = make(r);
      r.tested();
      const res = cli(r.dir, ["push-check"]);
      const lines = refusals(res.out);
      const at = `${name}, ${mode}: ${res.out}${res.err}`;
      if (refused) {
        assert.equal(res.code, 1, at);
        assert.match(res.out, /commits\.\*: 1 of the \d+ commits this push sends break the rule/, at);
        assert.deepEqual(Object.keys(lines), [h.slice(0, 12)], at);
        assert.match(lines[h.slice(0, 12)], refused, at);
      } else {
        // What git says of it agrees: a good signature, by the committer's own principal.
        assert.deepEqual(verified(r.dir, h), { ok: true, principal: g(r.dir, ["log", "-1", "--format=%ce", h]).toLowerCase() }, at);
        assert.match(res.out, /commits\.\*: the \d+ commits this push sends hold allowed addresses/, at);
        assert.deepEqual(lines, {}, at);
        assert.equal(res.code, mode === "ask" ? 3 : 0, at);
      }
    }
  }
});

test("commits: without an allowed-signers file a signed commit is said unchecked, never unsigned, and refused", () => {
  const r = repo({ addresses: [], signed: true }, { signers: false });
  const signed = r.commit("a");
  const unsigned = r.commit(null);
  r.tested();
  const res = cli(r.dir, ["push-check"]);
  assert.equal(res.code, 1, res.out);
  const lines = refusals(res.out);
  assert.match(lines[signed.slice(0, 12)], /^signed, but git verified no signature here/);
  assert.equal(lines[unsigned.slice(0, 12)], "unsigned");
  // git's own reading: %G? is N for both (git 2.34 and later), so the header is what tells them apart.
  assert.equal(g(r.dir, ["log", "-2", "--format=%G?"]), "N\nN");
});

test("commits: with addresses only, an unsigned commit by a listed address passes and one by another address is refused", () => {
  const r = repo({ addresses: ["a@x.test"] });
  r.commit(null);
  r.tested();
  const ok = cli(r.dir, ["push-check"]);
  assert.equal(ok.code, 3, ok.out);
  assert.match(ok.out, /hold allowed addresses/);
  const h = r.commit(null, "c@x.test");
  r.tested();
  const no = cli(r.dir, ["push-check"]);
  assert.equal(no.code, 1, no.out);
  assert.deepEqual(refusals(no.out), { [h.slice(0, 12)]: "author c@x.test is not in commits.addresses; committer c@x.test is not in commits.addresses" });
});

test("commits: nothing to push is no refusal; no upstream and a shallow clone are unmeasured and refused; the key unset says nothing", () => {
  const none = repo(BOTH);
  none.tested();
  const empty = cli(none.dir, ["push-check"]);
  assert.match(empty.out, /commits\.\*: the 0 commits this push sends/);
  assert.equal(empty.code, 3, empty.out);

  const lone = repo(BOTH);
  lone.commit("a"), g(lone.dir, ["branch", "--unset-upstream"]), lone.tested();
  const up = cli(lone.dir, ["push-check"]);
  assert.match(up.out, /commits\.\*: the commits this push sends could not be read \(the branch has no upstream\)/);
  assert.equal(up.code, 1);

  const src = repo(BOTH);
  src.commit("a"), g(src.dir, ["push", "-q"]);
  const shallow = join(DIR, "shallow");
  g(DIR, ["clone", "-q", "--depth", "1", `file://${src.bare}`, shallow]);
  g(shallow, ["config", "gpg.ssh.allowedSignersFile", SIGNERS]);
  g(shallow, [...signing("a"), "commit", "-q", "--allow-empty", "-S", "-m", "chore: shallow"], who("a@x.test", "a@x.test"));
  // The tests met under ask, where push-check would ask (3): the range it cannot read makes it 1.
  assert.equal(cli(shallow, ["test", "whole", "--again"]).code, 0);
  const sh = cli(shallow, ["push-check"]);
  assert.match(sh.out, /: met, recorded at/);
  assert.match(sh.out, /could not be read \(a shallow clone/);
  assert.equal(sh.code, 1, sh.out);

  const off = repo({});
  off.commit(null, "c@x.test"), off.tested();
  const unset = cli(off.dir, ["push-check"]);
  assert.doesNotMatch(unset.out, /commits\.\*/);
  assert.equal(unset.code, 3, unset.out);
});

test("commits: the module reads the range it is given, and a git that fails throws", () => {
  const r = repo(BOTH);
  const a = r.commit("a");
  const u = r.commit(null);
  const rule = /** @type {NonNullable<ReturnType<typeof commitRule>>} */ (commitRule({ commits: BOTH }));
  const res = commitsRefused(r.dir, rule, "refs/remotes/origin/main");
  assert.equal(res.checked, 2);
  assert.deepEqual(res.refused.map((x) => x.hash), [u]);
  assert.deepEqual(commitsRefused(r.dir, rule, a), { checked: 1, refused: [{ hash: u, why: [{ key: "commits.unsigned", vars: {} }] }] });
  assert.throws(() => commitsRefused(r.dir, rule, "refs/remotes/origin/none"));
});

test("commits: push-check holds each allowed-signers shape to git's own %G? and %GS: a namespace not git, a pattern, another address first, an expired line, a revoked key, an unreadable or missing file are refused", () => {
  const r = repo(BOTH);
  const base = r.commit(null);
  const h = r.commit("a");
  const rule = /** @type {NonNullable<ReturnType<typeof commitRule>>} */ (commitRule({ commits: BOTH }));
  const file = join(DIR, "shape_signers");
  const krl = join(DIR, "shape_krl");
  const made = spawnSync("ssh-keygen", ["-q", "-k", "-f", krl, join(KEYS, "a.pub")], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  /** @type {[string, string | null, { revoked?: boolean, shut?: string, missing?: boolean }, string | null][]} */
  const cells = [
    ["listed", `a@x.test ${pub("a")}`, {}, null],
    ["listed in another case", `A@X.TEST ${pub("a")}`, {}, null],
    ["another key listed for the address", `a@x.test ${pub("b")}`, {}, "commits.notGood U"],
    ["revoked in a KRL", `a@x.test ${pub("a")}`, { revoked: true }, "commits.notGood B"],
    ["a KRL that cannot be read", `a@x.test ${pub("a")}`, { revoked: true, shut: krl }, "commits.notGood B"],
    ["a namespace other than git", `a@x.test namespaces="file" ${pub("a")}`, {}, "commits.notGood B"],
    ["a namespace list that negates git", `a@x.test namespaces="*,!git" ${pub("a")}`, {}, "commits.notGood B"],
    ["another address first on the line", `b@x.test,a@x.test ${pub("a")}`, {}, "commits.otherSigner"],
    ["another address on an earlier line", `b@x.test ${pub("a")}\na@x.test ${pub("a")}`, {}, "commits.otherSigner"],
    ["a pattern", `*@x.test ${pub("a")}`, {}, "commits.otherSigner"],
    ["a line expired", `a@x.test valid-before="20200101" ${pub("a")}`, {}, "commits.notGood U"],
    ["a file that cannot be read", `a@x.test ${pub("a")}`, { shut: file }, "commits.notGood U"],
    ["a file that is not there", null, { missing: true }, "commits.notGood U"],
  ];
  for (const [name, text, { revoked, shut, missing }, want] of cells) {
    rmSync(file, { force: true });
    if (text !== null) writeFileSync(file, `${text}\n`);
    g(r.dir, ["config", "gpg.ssh.allowedSignersFile", missing ? join(DIR, "no-such-signers") : file]);
    if (revoked) g(r.dir, ["config", "gpg.ssh.revocationFile", krl]);
    else gq(r.dir, ["config", "--unset", "gpg.ssh.revocationFile"]);
    if (shut) chmodSync(shut, 0o000);
    try {
      const { refused } = commitsRefused(r.dir, rule, base);
      const got = refused.flatMap((x) => x.why.map((w) => (w.key === "commits.notGood" ? `${w.key} ${w.vars.code}` : w.key)));
      assert.deepEqual(got, want ? [want] : [], name);
      assert.ok(refused.every((x) => x.hash === h), name);
    } finally {
      if (shut) chmodSync(shut, 0o644);
    }
  }
});

test("commits: doctor names the settings a clone lacks, says which it read when it holds them, and says nothing with the key unset", () => {
  const r = repo(BOTH);
  const rule = /** @type {NonNullable<ReturnType<typeof commitRule>>} */ (commitRule({ commits: BOTH }));
  g(r.dir, ["config", "user.email", "c@x.test"]);
  // Only what push-check's verdict reads: it reads no tag, so tag signing is clone-setup's advice and no gap here.
  assert.deepEqual(cloneGaps(r.dir, rule), ["commit.gpgsign", "user.signingkey", "gpg.format", "user.email"]);
  const warn = cli(r.dir, ["doctor"]);
  assert.match(warn.out + warn.err, /! commits\.\*: this clone's git settings would make commits push-check refuses: commit\.gpgsign, user\.signingkey, gpg\.format, user\.email/);
  for (const [k, v] of [["commit.gpgsign", "true"], ["user.signingkey", join(KEYS, "a.pub")], ["gpg.format", "ssh"], ["user.email", "A@x.test"]]) g(r.dir, ["config", k, v]);
  assert.deepEqual(cloneGaps(r.dir, rule), []);
  const OK = /✓ commits\.\*: this clone holds the git settings signing needs \(.*\); whether that file lists the key for user\.email, and whether it is revoked, git judges \(%G\?\) on each commit push-check reads/;
  const ok = cli(r.dir, ["doctor"]);
  assert.match(ok.out + ok.err, OK);
  // Doctor reads no line of the allowed-signers file: which line answers for a key turns on every line that holds it and
  // on gpg.ssh.revocationFile. A key the file does not list, or one the revocation file names, reads the same ✓, and
  // push-check, which asks git, refuses the commit that key signs: U, and B for the revoked key (git 2.56.0 and 2.34.1).
  g(r.dir, ["config", "user.signingkey", join(KEYS, "c.pub")]);
  assert.deepEqual(cloneGaps(r.dir, rule), []);
  const unlisted = r.commit("c");
  const revoked = join(DIR, "revoked_keys");
  writeFileSync(revoked, `${pub("a")}\n`), g(r.dir, ["config", "gpg.ssh.revocationFile", revoked]);
  g(r.dir, ["config", "user.signingkey", join(KEYS, "a.pub")]);
  const gone = r.commit("a");
  const doc = cli(r.dir, ["doctor"]);
  assert.match(doc.out + doc.err, OK);
  assert.equal((doc.out + doc.err).match(/commits\.\*/g)?.length, 1, doc.out);
  const push = cli(r.dir, ["push-check"]);
  const why = refusals(push.out);
  assert.match(why[unlisted.slice(0, 12)] ?? "", /%G\? is U,/, push.out);
  assert.match(why[gone.slice(0, 12)] ?? "", /%G\? is B,/, push.out);
  assert.equal(push.code, 1, push.out);
  g(r.dir, ["config", "--unset", "gpg.ssh.revocationFile"]);
  g(r.dir, ["config", "gpg.ssh.allowedSignersFile", join(DIR, "no-such-file")]);
  assert.deepEqual(cloneGaps(r.dir, rule), ["gpg.ssh.allowedSignersFile"]);
  g(r.dir, ["config", "gpg.ssh.allowedSignersFile", KEYS]);
  assert.deepEqual(cloneGaps(r.dir, rule), ["gpg.ssh.allowedSignersFile"], "a folder in the file's place");
  // A file that cannot be looked at is unmeasured, never missing: a folder that refuses a search holds it.
  const shut = join(DIR, "shut");
  mkdirSync(shut), writeFileSync(join(shut, "allowed_signers"), ""), g(r.dir, ["config", "gpg.ssh.allowedSignersFile", join(shut, "allowed_signers")]);
  chmodSync(shut, 0o000);
  try {
    assert.throws(() => cloneGaps(r.dir, rule), (e) => /** @type {NodeJS.ErrnoException} */ (e).code === "EACCES");
    const unread = cli(r.dir, ["doctor"]);
    assert.match(unread.out + unread.err, /\? commits\.\*: this clone's git settings are unmeasured: EACCES/);
  } finally {
    chmodSync(shut, 0o755);
  }
  g(r.dir, ["config", "--unset", "gpg.ssh.allowedSignersFile"]);
  assert.deepEqual(cloneGaps(r.dir, rule), ["gpg.ssh.allowedSignersFile"]);
  assert.deepEqual(cloneGaps(r.dir, { addresses: null, signed: false }), []);
  // Signing asked and no list: the committer's address is still what the key must be listed for, so none is a gap.
  g(r.dir, ["config", "gpg.ssh.allowedSignersFile", SIGNERS]), g(r.dir, ["config", "--unset", "user.email"]);
  assert.deepEqual(cloneGaps(r.dir, { addresses: null, signed: true }), ["user.email"]);
  g(r.dir, ["config", "user.email", "a@x.test"]);
  assert.deepEqual(cloneGaps(r.dir, { addresses: null, signed: true }), []);
  // A relative file is read from the repository's top, not from where the process stands.
  g(r.dir, ["config", "gpg.ssh.allowedSignersFile", "../allowed_signers"]);
  assert.notEqual(process.cwd(), r.dir);
  assert.deepEqual(cloneGaps(r.dir, { addresses: null, signed: true }), []);
  // A list and no signing: the ✓ names user.email alone, no signing setting.
  const listOnly = repo({ addresses: ["a@x.test"] });
  const addressOk = cli(listOnly.dir, ["doctor"]);
  assert.match(addressOk.out + addressOk.err, /✓ commits\.\*: this clone's user\.email is in commits\.addresses\n/);
  assert.doesNotMatch(addressOk.out + addressOk.err, /sign/i);
  const off = repo({});
  const quiet = cli(off.dir, ["doctor"]);
  assert.doesNotMatch(quiet.out + quiet.err, /commits\.\*/);
});

/**
 * A gpg that signs with a fixed OpenPGP armor and calls every signature good from a key it trusts ultimately, for a@x.test.
 * A status line before SIG_CREATED: git 2.34 looks for that line after a line break (measured on the floor image).
 */
const FAKE_GPG = join(DIR, "fake-gpg");
writeFileSync(
  FAKE_GPG,
  `#!/bin/sh
case " $* " in
  *" --verify "*) cat >/dev/null; printf '[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG 0123456789ABCDEF Mallory <a@x.test>\\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-01-01 0 0 4 0 1 10 00 0123456789ABCDEF0123456789ABCDEF01234567\\n[GNUPG:] TRUST_ULTIMATE 0 pgp\\n'; exit 0;;
  *) cat >/dev/null; printf '[GNUPG:] BEGIN_SIGNING H10\\n[GNUPG:] SIG_CREATED D 1 10 00 1 0123456789ABCDEF\\n' >&2; printf -- '-----BEGIN PGP SIGNATURE-----\\n\\niQEzBAABCAAdFiEE\\n-----END PGP SIGNATURE-----\\n'; exit 0;;
esac
`,
);
chmodSync(FAKE_GPG, 0o755);

test("commits: an OpenPGP signature git calls good, for the committer's own address, is refused: only an SSH signature is read against the list", () => {
  const r = repo(BOTH);
  g(r.dir, ["config", "gpg.program", FAKE_GPG]);
  g(r.dir, ["-c", "gpg.format=openpgp", "-c", "user.signingkey=0123456789ABCDEF", "commit", "-q", "--allow-empty", "-S", "-m", "chore: openpgp"], who("a@x.test", "a@x.test"));
  const h = g(r.dir, ["rev-parse", "HEAD"]);
  // git's own reading: good, by a user id that holds the committer's address.
  assert.equal(g(r.dir, ["log", "-1", "--format=%G? %GS"]), "G Mallory <a@x.test>");
  r.tested();
  const res = cli(r.dir, ["push-check"]);
  assert.equal(res.code, 1, res.out);
  assert.deepEqual(refusals(res.out), { [h.slice(0, 12)]: "signed with openpgp, which commits.signed does not take: git calls such a signature good for any key the local keyring trusts, whatever the allowed-signers file lists" });
});

test("commits: the rule is the strictest of the work tree's, HEAD's and the upstream's config: an edit not committed, ENNYN_CONFIG or a loosening inside the range keeps it", () => {
  const plain = JSON.stringify({ commands: { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' } });
  // The commits block taken out of the work tree, not committed: HEAD's config still holds it.
  const work = repo(BOTH);
  const u1 = work.commit(null);
  work.tested();
  writeFileSync(join(work.dir, ".ennyn", "config.json"), plain);
  const r1 = cli(work.dir, ["push-check"]);
  assert.equal(r1.code, 1, r1.out);
  assert.deepEqual(Object.keys(refusals(r1.out)), [u1.slice(0, 12)]);
  // ENNYN_CONFIG names a config with no commits block.
  const named = repo(BOTH);
  const u2 = named.commit(null);
  named.tested();
  writeFileSync(join(DIR, "plain.json"), plain);
  const r2 = cli(named.dir, ["push-check"], { ENNYN_CONFIG: join(DIR, "plain.json") });
  assert.equal(r2.code, 1, r2.out);
  assert.deepEqual(Object.keys(refusals(r2.out)), [u2.slice(0, 12)]);
  // A loosening committed inside the range: the upstream's config still holds the rule for every commit it sends.
  const loose = repo(BOTH);
  const u3 = loose.commit(null);
  writeFileSync(join(loose.dir, ".ennyn", "config.json"), plain);
  g(loose.dir, ["commit", "-q", "-am", "chore: drop commits"], who("c@x.test", "c@x.test"));
  const u4 = g(loose.dir, ["rev-parse", "HEAD"]);
  loose.tested();
  const r3 = cli(loose.dir, ["push-check"]);
  assert.equal(r3.code, 1, r3.out);
  assert.deepEqual(Object.keys(refusals(r3.out)), [u4.slice(0, 12), u3.slice(0, 12)]);
  // The rule set by a commit not pushed yet, then taken out of the work tree: HEAD's config alone holds it.
  const head = repo({});
  writeFileSync(join(head.dir, ".ennyn", "config.json"), JSON.stringify({ ...JSON.parse(plain), commits: BOTH }));
  g(head.dir, ["commit", "-q", "-am", "chore: commits"], who("a@x.test", "a@x.test"));
  const u6 = g(head.dir, ["rev-parse", "HEAD"]);
  head.tested();
  writeFileSync(join(head.dir, ".ennyn", "config.json"), plain);
  const r5 = cli(head.dir, ["push-check"]);
  assert.equal(r5.code, 1, r5.out);
  assert.deepEqual(Object.keys(refusals(r5.out)), [u6.slice(0, 12)]);
  // Two lists: an address only one of them holds is refused.
  const both = repo({ addresses: ["a@x.test", "b@x.test"] });
  writeFileSync(join(both.dir, ".ennyn", "config.json"), JSON.stringify({ ...JSON.parse(plain), commits: { addresses: ["b@x.test"] } }));
  g(both.dir, ["commit", "-q", "-am", "chore: narrower"], who("b@x.test", "b@x.test"));
  const u5 = both.commit(null, "a@x.test");
  both.tested();
  const r4 = cli(both.dir, ["push-check"]);
  assert.equal(r4.code, 1, r4.out);
  assert.deepEqual(Object.keys(refusals(r4.out)), [u5.slice(0, 12)]);
});

test("commits: an address the push's own list adds and the upstream's lacks is named apart, and the remedy it prints clears it", () => {
  const plain = { commands: { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' } };
  const r = repo({ addresses: ["a@x.test"] });
  writeFileSync(join(r.dir, ".ennyn", "config.json"), JSON.stringify({ ...plain, commits: { addresses: ["a@x.test", "b@x.test"] } }));
  g(r.dir, ["commit", "-q", "-am", "chore: add b"], who("a@x.test", "a@x.test"));
  const adds = g(r.dir, ["rev-parse", "HEAD"]);
  const u = r.commit(null, "b@x.test");
  const other = r.commit(null, "c@x.test");
  r.tested();
  const res = cli(r.dir, ["push-check"]);
  assert.equal(res.code, 1, res.out);
  assert.deepEqual(refusals(res.out), {
    [other.slice(0, 12)]: "author c@x.test is not in commits.addresses; committer c@x.test is not in commits.addresses",
    [u.slice(0, 12)]: "author b@x.test is in the commits.addresses this push brings, not yet in the upstream's; committer b@x.test is in the commits.addresses this push brings, not yet in the upstream's",
  });
  assert.match(res.out, /Push first, on its own, a commit that adds the new address/);
  assert.match(res.out, /ennyn clone-setup prints/, "c's refusal keeps the settings remedy");
  // Only the brought address refused: only its remedy is printed, not the clone's settings.
  g(r.dir, ["reset", "-q", "--hard", u]);
  r.tested();
  const only = cli(r.dir, ["push-check"]);
  assert.equal(only.code, 1, only.out);
  assert.match(only.out, /Push first, on its own, a commit that adds the new address/);
  assert.doesNotMatch(only.out, /ennyn clone-setup prints/);
  // The remedy: the commit that adds b, by an address the upstream's list holds, pushed alone; then b's commit passes.
  g(r.dir, ["push", "-q", "origin", `${adds}:main`]);
  const after = cli(r.dir, ["push-check"]);
  assert.match(after.out, /commits\.\*: the 1 commits this push sends hold allowed addresses/);
  assert.equal(after.code, 3, after.out);
});

test("commits: an address the push's own list replaces: the commit by the old one and the one by the new one are each named, and the remedy printed clears both", () => {
  const plain = { commands: { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' } };
  const list = (/** @type {ReturnType<typeof repo>} */ r, /** @type {string[]} */ addresses, /** @type {string} */ by) => {
    writeFileSync(join(r.dir, ".ennyn", "config.json"), JSON.stringify({ ...plain, commits: { addresses } }));
    g(r.dir, ["commit", "-q", "-am", `chore: list ${addresses.join(" ")}`], who(by, by));
    return g(r.dir, ["rev-parse", "HEAD"]);
  };
  const r = repo({ addresses: ["a@x.test"] });
  const base = g(r.dir, ["rev-parse", "HEAD"]);
  const swap = list(r, ["b@x.test"], "a@x.test");
  const u = r.commit(null, "b@x.test");
  r.tested();
  const res = cli(r.dir, ["push-check"]);
  assert.equal(res.code, 1, res.out);
  assert.deepEqual(refusals(res.out), {
    [swap.slice(0, 12)]: "author a@x.test is in the upstream's commits.addresses, which this push drops it from; committer a@x.test is in the upstream's commits.addresses, which this push drops it from",
    [u.slice(0, 12)]: "author b@x.test is in the commits.addresses this push brings, not yet in the upstream's; committer b@x.test is in the commits.addresses this push brings, not yet in the upstream's",
  });
  assert.match(res.out, /Push first, on its own, a commit that adds the new address and keeps every address the upstream's list holds, made by one of them; drop an address in a later push, after the commits it wrote/);
  assert.doesNotMatch(res.out, /ennyn clone-setup prints/);
  // The remedy as printed: a commit by a that adds b and keeps a, pushed alone; then b's commits and, last, the drop.
  g(r.dir, ["reset", "-q", "--hard", base]);
  const adds = list(r, ["a@x.test", "b@x.test"], "a@x.test");
  r.tested();
  const first = cli(r.dir, ["push-check"]);
  assert.match(first.out, /commits\.\*: the 1 commits this push sends hold allowed addresses/);
  g(r.dir, ["push", "-q", "origin", `${adds}:main`]);
  r.commit(null, "b@x.test");
  list(r, ["b@x.test"], "b@x.test");
  r.tested();
  const rest = cli(r.dir, ["push-check"]);
  assert.match(rest.out, /commits\.\*: the 2 commits this push sends hold allowed addresses/);
  assert.equal(rest.code, 3, rest.out);
});

test("commits: one fold for every reader of an address: A to Z lower-cased and nothing else, so a sign that toLowerCase folds into a listed letter is refused", () => {
  assert.equal(addressFold("Me@X.Test"), "me@x.test");
  // KELVIN SIGN folds to k under toLowerCase, and DOTTED CAPITAL I grows a letter: neither is folded here.
  assert.equal("\u212A@x.test".toLowerCase(), "k@x.test");
  assert.equal(addressFold("\u212A@x.test"), "\u212A@x.test");
  assert.equal(addressFold("\u0130@x.test"), "\u0130@x.test");
  assert.deepEqual(commitRule({ commits: { addresses: ["K@X.test"], signed: false } }), { addresses: ["k@x.test"], signed: false });
  const r = repo({ addresses: ["k@x.test"] });
  const kelvin = r.commit(null, "\u212A@x.test");
  r.tested();
  const res = cli(r.dir, ["push-check"]);
  assert.equal(res.code, 1, res.out);
  assert.deepEqual(Object.keys(refusals(res.out)), [kelvin.slice(0, 12)]);
});

test("commits: of HEAD's and the upstream's config only the commits block is read: a key this version does not load passes, a malformed block or broken JSON is unmeasured", () => {
  const cmd = { fastTest: 'exit "$T_EXIT"', wholeTest: 'exit "$T_EXIT"' };
  /** Pushed: a config of `text` at the upstream; then the work tree's mended and committed, signed by a. @param {string} text */
  const upstreamHolds = (text) => {
    const r = repo(BOTH);
    writeFileSync(join(r.dir, ".ennyn", "config.json"), text);
    g(r.dir, [...signing("a"), "commit", "-q", "-S", "--no-verify", "-am", "chore: upstream config"], who("a@x.test", "a@x.test"));
    g(r.dir, ["push", "-q"]);
    writeFileSync(join(r.dir, ".ennyn", "config.json"), JSON.stringify({ commits: BOTH, commands: cmd }));
    g(r.dir, [...signing("a"), "commit", "-q", "-S", "-am", "chore: mended"], who("a@x.test", "a@x.test"));
    r.tested();
    return cli(r.dir, ["push-check"]);
  };
  // A key a later version retired or renamed beside the block: the block is read, the commit the push carries passes.
  const skew = upstreamHolds(JSON.stringify({ commits: BOTH, commands: cmd, retiredKey: 1 }));
  assert.match(skew.out, /commits\.\*: the 1 commits this push sends hold allowed addresses/);
  assert.equal(skew.code, 3, skew.out);
  // The same, with the rule in it holding: an unsigned commit after it is refused.
  const held = repo(BOTH);
  writeFileSync(join(held.dir, ".ennyn", "config.json"), JSON.stringify({ commits: BOTH, commands: cmd, retiredKey: 1 }));
  g(held.dir, [...signing("a"), "commit", "-q", "-S", "--no-verify", "-am", "chore: upstream config"], who("a@x.test", "a@x.test"));
  g(held.dir, ["push", "-q"]);
  writeFileSync(join(held.dir, ".ennyn", "config.json"), JSON.stringify({ commands: cmd }));
  g(held.dir, ["commit", "-q", "-am", "chore: drop it all"], who("a@x.test", "a@x.test"));
  const u = g(held.dir, ["rev-parse", "HEAD"]);
  held.tested();
  const kept = cli(held.dir, ["push-check"]);
  assert.equal(kept.code, 1, kept.out);
  assert.deepEqual(refusals(kept.out), { [u.slice(0, 12)]: "unsigned" });
  // A block of a wrong shape, and JSON that does not parse: unmeasured, refused.
  const shape = upstreamHolds(JSON.stringify({ commits: { signed: "yes" }, commands: cmd }));
  assert.match(shape.out, /could not be read \(\.ennyn\/config\.json at refs\/remotes\/origin\/main: "commits\.signed" must be boolean, got string\)/);
  assert.equal(shape.code, 1, shape.out);
  const list = upstreamHolds(JSON.stringify({ commits: { addresses: ["*@x.test"] }, commands: cmd }));
  assert.match(list.out, /could not be read \(\.ennyn\/config\.json at refs\/remotes\/origin\/main: "commits\.addresses" entries must be addresses/);
  assert.equal(list.code, 1, list.out);
  const broken = upstreamHolds('{"commits": {"signed": true}');
  assert.match(broken.out, /could not be read \(\.ennyn\/config\.json at refs\/remotes\/origin\/main is not JSON/);
  assert.equal(broken.code, 1, broken.out);
  const list2 = upstreamHolds("[]");
  assert.match(list2.out, /could not be read \(\.ennyn\/config\.json at refs\/remotes\/origin\/main holds no JSON object\)/);
  assert.equal(list2.code, 1, list2.out);
  // A byte order mark some editors write is no part of the JSON, as loadConfig reads it.
  const bom = upstreamHolds(`\uFEFF${JSON.stringify({ commits: BOTH, commands: cmd })}`);
  assert.equal(bom.code, 3, bom.out);
  // A config with no block, a key this version refuses beside it: no rule there, nothing said.
  const unset = repo({});
  writeFileSync(join(unset.dir, ".ennyn", "config.json"), '{"nosuchkey": 1}');
  g(unset.dir, ["commit", "-q", "--no-verify", "-am", "chore: broken"]);
  g(unset.dir, ["push", "-q"]);
  writeFileSync(join(unset.dir, ".ennyn", "config.json"), JSON.stringify({ commands: cmd }));
  g(unset.dir, ["commit", "-q", "-am", "chore: mended"]);
  unset.tested();
  const r2 = cli(unset.dir, ["push-check"]);
  assert.doesNotMatch(r2.out, /commits\.\*/);
  assert.equal(r2.code, 3, r2.out);
});

test("commits: a bare push that sends more refs than HEAD's branch, or to a url other than the upstream's, is unmeasured and named; a key that changes neither is not", () => {
  const other = join(DIR, "other.git");
  const spaced = join(DIR, "an other.git");
  g(DIR, ["init", "-q", "--bare", "-b", "main", other]);
  g(DIR, ["init", "-q", "--bare", "-b", "main", spaced]);
  // A local upstream under push.default upstream: the push updates a branch here, and nothing leaves.
  const local = (/** @type {ReturnType<typeof repo>} */ r) => (g(r.dir, ["branch", "base", "origin/main"]), g(r.dir, ["branch", "-q", "-u", "base"]), g(r.dir, ["config", "push.default", "upstream"]));
  /** @type {[string, (r: ReturnType<typeof repo>) => void, RegExp | null][]} */
  const shapes = [
    ["the gh CLI's remote.origin.gh-resolved", (r) => g(r.dir, ["config", "remote.origin.gh-resolved", "base"]), null],
    ["an insteadOf that rewrites fetch and push alike", (r) => (g(r.dir, ["config", `url.${r.bare}.insteadOf`, "alias:"]), g(r.dir, ["remote", "set-url", "origin", "alias:"]), g(r.dir, ["fetch", "-q", "origin"])), null],
    ["a pushurl that is the url", (r) => g(r.dir, ["config", "remote.origin.pushurl", g(r.dir, ["remote", "get-url", "origin"])]), null],
    ["a local upstream", local, null],
    ["a local upstream, a rewrite that does not match its \".\"", (r) => (local(r), g(r.dir, ["config", `url.${other}.insteadOf`, "alias:"])), null],
    // Config on remote "." itself, or a rewrite that matches ".", sends that push to another repository (git 2.56.0 and 2.34.1).
    ["a local upstream with remote...url", (r) => (local(r), g(r.dir, ["config", "remote...url", other])), /\(remote\.\.\.url\): take it out/],
    ["a local upstream with remote...pushurl", (r) => (local(r), g(r.dir, ["config", "remote...pushurl", other])), /\(remote\.\.\.pushurl\): take it out/],
    ["a local upstream with url.<base>.pushInsteadOf .", (r) => (local(r), g(r.dir, ["config", `url.${other}.pushInsteadOf`, "."])), new RegExp(`\\(url\\.${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pushinsteadof\\): take the rewrite`)],
    // An empty value is a prefix of every url: git rewrites "." to the base followed by "." (git 2.56.0).
    ["a local upstream with url.<base>.pushInsteadOf empty", (r) => (local(r), g(r.dir, ["config", `url.${other}.pushInsteadOf`, ""])), /\.pushinsteadof\): take the rewrite of "\." out/],
    ["a local upstream with url.<base with a space>.insteadOf .", (r) => (local(r), g(r.dir, ["config", `url.${spaced}.insteadOf`, "."])), /\.insteadof\): take the rewrite of "\." out/],
    ["push.default matching, a second branch ahead of its remote branch", (r) => (g(r.dir, ["push", "-q", "origin", "main:side"]), g(r.dir, ["branch", "side", "origin/side"]), g(r.dir, ["config", "push.default", "matching"])), /\(push\.default\): set it to simple/],
    ["a remote.origin.push refspec", (r) => g(r.dir, ["config", "--add", "remote.origin.push", "refs/heads/*:refs/heads/*"]), /\(remote\.origin\.push\): take the refspec out/],
    ["a mirror", (r) => g(r.dir, ["config", "remote.origin.mirror", "true"]), /\(remote\.origin\.mirror\): set it to false/],
    ["push.followTags", (r) => g(r.dir, ["config", "push.followTags", "true"]), /\(push\.followTags\): set it to false/],
    ["a pushurl elsewhere", (r) => g(r.dir, ["config", "remote.origin.pushurl", other]), /\(remote\.origin\.pushurl\): make the push go to the one url/],
    ["a second url", (r) => g(r.dir, ["remote", "set-url", "--add", "origin", other]), /\(remote\.origin\.url\): make the push go to the one url/],
    ["a pushInsteadOf", (r) => g(r.dir, ["config", `url.${other}.pushInsteadOf`, g(r.dir, ["remote", "get-url", "origin"])]), /\(url\.<base>\.pushInsteadOf\): make the push go to the one url/],
    // One list with push-mode's: a push that also sends a submodule's commits.
    ["push.recurseSubmodules on-demand", (r) => g(r.dir, ["config", "push.recurseSubmodules", "on-demand"]), /\(push\.recurseSubmodules\): set it to check or no/],
    ["submodule.recurse", (r) => g(r.dir, ["config", "submodule.recurse", "true"]), /\(submodule\.recurse\): set it to false/],
  ];
  for (const [name, set, said] of shapes) {
    const r = repo(BOTH);
    r.commit("a");
    set(r);
    r.tested();
    const res = cli(r.dir, ["push-check"]);
    if (said) {
      assert.match(res.out, /could not be read \(a bare git push may send more than main, or send it elsewhere/, name);
      assert.match(res.out, said, name);
      assert.equal(res.code, 1, `${name}: ${res.out}`);
    } else {
      assert.match(res.out, /commits\.\*: the 1 commits this push sends hold allowed addresses/, name);
      assert.equal(res.code, 3, `${name}: ${res.out}`);
    }
  }
});

/**
 * A loopback forge: each request's path is recorded, and the answer is `answer(path)`.
 * @param {(path: string) => { status?: number, body: string, headers?: Record<string, string> }} answer
 */
async function forge(answer) {
  /** @type {string[]} */
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(String(req.url));
    const a = answer(String(req.url));
    res.writeHead(a.status ?? 200, { "content-type": "application/json", ...(a.headers ?? {}) });
    res.end(a.body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { base: `http://127.0.0.1:${port}`, asked, close: () => new Promise((ok) => server.close(() => ok(undefined))) };
}
/** The CLI, run while this process serves the forge. @param {string} cwd @param {string[]} args @param {Record<string, string>} env */
const cliAsync = (cwd, args, env) =>
  new Promise((ok) => {
    execFile(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, killSignal: "SIGKILL" }, (e, stdout, stderr) => ok({ code: e ? /** @type {any} */ (e).code : 0, out: stdout, err: stderr }));
  });

test("clone-setup: it prints the clone's settings and builds the allowed-signers file from the forge's keys, which git then verifies with", async () => {
  const keys = [{ id: 1, key: pub("a"), title: "laptop", created_at: "2026-01-01T00:00:00Z" }, { id: 2, key: pub("b"), title: "other", created_at: "2026-01-02T00:00:00Z" }];
  const f = await forge(() => ({ body: JSON.stringify(keys) }));
  try {
    const r = repo({ addresses: ["7+test-login@users.noreply.github.com"], signed: true }, { signers: false });
    const res = /** @type {any} */ (await cliAsync(r.dir, ["clone-setup"], { ENNYN_GITHUB_API: f.base }));
    assert.equal(res.code, 0, res.out + res.err);
    assert.deepEqual(f.asked, ["/users/test-login/ssh_signing_keys?per_page=100"]);
    const file = join(g(r.dir, ["rev-parse", "--absolute-git-dir"]), "ennyn", "allowed_signers");
    assert.equal(readFileSync(file, "utf8"), `7+test-login@users.noreply.github.com namespaces="git" ${pub("a")}\n7+test-login@users.noreply.github.com namespaces="git" ${pub("b")}\n`);
    for (const c of ["git config user.email 7+test-login@users.noreply.github.com", "git config gpg.format ssh", "git config commit.gpgsign true", "git config tag.gpgsign true", `git config gpg.ssh.allowedSignersFile ${file}`, "install-hook"]) assert.ok(res.out.includes(c), c);
    assert.match(res.out, /Wrote 2 SSH signing keys GitHub lists for test-login/);
    // The file is one git takes: a commit signed with a listed key, by that address, is good, and push-check passes it.
    g(r.dir, ["config", "gpg.ssh.allowedSignersFile", file]);
    const h = r.commit("a", "7+test-login@users.noreply.github.com");
    assert.deepEqual(verified(r.dir, h), { ok: true, principal: "7+test-login@users.noreply.github.com" });
    assert.deepEqual(refusals(cli(r.dir, ["push-check"]).out), {});
  } finally {
    await f.close();
  }
});

test("clone-setup: a failure, a status other than 200, an answer of another shape or no key leaves the file as it was and exits 1", async () => {
  /** @type {[string, { status?: number, body: string, headers?: Record<string, string> }, RegExp][]} */
  const answers = [
    ["404", { status: 404, body: '{"message":"Not Found"}' }, /HTTP 404, not 200/],
    ["500", { status: 500, body: "[]" }, /HTTP 500/],
    ["not JSON", { body: "<html>" }, /not the list the API documents \(not JSON\)/],
    ["an object", { body: '{"key":"x"}' }, /\(not a list\)/],
    ["a key of another shape", { body: JSON.stringify([{ key: `${pub("a")} comment` }]) }, /\(entry 1 holds no SSH public key\)/],
    ["a key on two lines", { body: JSON.stringify([{ key: `${pub("a")}\nssh-ed25519 AAAA` }]) }, /\(entry 1 holds no SSH public key\)/],
    ["no key field", { body: JSON.stringify([{ id: 1 }]) }, /\(entry 1 holds no SSH public key\)/],
    ["no key", { body: "[]" }, /GitHub lists no SSH signing key for lo-gin/],
    ["a second page", { body: JSON.stringify([{ key: pub("a") }]), headers: { link: '<http://127.0.0.1/x?page=2>; rel="next"' } }, /more than one page/],
  ];
  const r = repo({ addresses: ["a@x.test"], signed: true }, { signers: false });
  const file = join(g(r.dir, ["rev-parse", "--absolute-git-dir"]), "ennyn", "allowed_signers");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "kept\n");
  for (const [name, answer, said] of answers) {
    const f = await forge(() => answer);
    try {
      const res = /** @type {any} */ (await cliAsync(r.dir, ["clone-setup", "--login", "lo-gin"], { ENNYN_GITHUB_API: f.base }));
      assert.equal(res.code, 1, `${name}: ${res.out}`);
      assert.match(res.out, said, name);
      assert.match(res.out, /is left as it was/, name);
      assert.equal(readFileSync(file, "utf8"), "kept\n", name);
    } finally {
      await f.close();
    }
  }
  // A network failure: a port nothing listens on any more.
  const gone = await forge(() => ({ body: "[]" }));
  await gone.close();
  const res = /** @type {any} */ (await cliAsync(r.dir, ["clone-setup", "--login", "lo-gin"], { ENNYN_GITHUB_API: gone.base }));
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /were not read: ECONNREFUSED/);
  assert.equal(readFileSync(file, "utf8"), "kept\n");
});

test("clone-setup: only a loopback origin is taken for the forge, a login is checked, and the key unset or no login is said", async () => {
  assert.deepEqual(apiBase({}), { base: "https://api.github.com" });
  for (const ok of ["http://127.0.0.1:8080", "http://localhost:1", "http://[::1]:9"]) assert.deepEqual(apiBase({ ENNYN_GITHUB_API: ok }), { base: ok });
  for (const no of ["https://keys.example.test", "http://keys.example.test", "http://localhost.example.test:1", "http://127.0.0.1.example.test:80", "http://127.0.0.1:8080/", "https://127.0.0.1:8080", "http://user@127.0.0.1:1", "x"]) assert.deepEqual(apiBase({ ENNYN_GITHUB_API: no }), { refused: no }, no);
  const r = repo({ addresses: ["a@x.test"], signed: true }, { signers: false });
  const far = cli(r.dir, ["clone-setup", "--login", "lo-gin"], { ENNYN_GITHUB_API: "https://keys.example.test" });
  assert.equal(far.code, 1);
  assert.match(far.out, /only a loopback origin/);
  assert.equal(existsSync(join(g(r.dir, ["rev-parse", "--absolute-git-dir"]), "ennyn", "allowed_signers")), false);
  const noLogin = cli(r.dir, ["clone-setup"]);
  assert.equal(noLogin.code, 1);
  assert.match(noLogin.out, /No GitHub login: give --login/);
  // A login a noreply address names answers for that address alone: another --address asks for --login, and nothing is read.
  const team = repo({ addresses: ["111+alice@users.noreply.github.com", "bob@x.test"], signed: true }, { signers: false });
  const other = cli(team.dir, ["clone-setup", "--address", "bob@x.test"], { ENNYN_GITHUB_API: "http://127.0.0.1:1" });
  assert.equal(other.code, 1, other.out);
  assert.match(other.out, /No GitHub login: give --login/);
  assert.equal(existsSync(join(g(team.dir, ["rev-parse", "--absolute-git-dir"]), "ennyn", "allowed_signers")), false);
  assert.equal(cli(r.dir, ["clone-setup", "--login", "-bad"]).code, 2);
  assert.equal(cli(r.dir, ["clone-setup", "--login", "../x"]).code, 2);
  assert.equal(cli(r.dir, ["clone-setup", "--login", "x", "--address", "b@x.test"]).code, 2);
  const unset = cli(repo({}).dir, ["clone-setup"]);
  assert.equal(unset.code, 0);
  assert.match(unset.out, /commits\.addresses is empty and commits\.signed is false/);
  const plain = cli(repo({ addresses: ["a@x.test"] }).dir, ["clone-setup"]);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /git config user\.email a@x\.test/);
  assert.doesNotMatch(plain.out, /gpgsign/);
  assert.deepEqual(noreplyLogin(["a@x.test", "12+Lo-gin@users.noreply.github.com"]), { login: "Lo-gin", address: "12+Lo-gin@users.noreply.github.com" });
  assert.equal(noreplyLogin(["1+a@users.noreply.github.com", "2+b@users.noreply.github.com"]), null);
  assert.equal(noreplyLogin(["a@x.test"]), null);
});

test("clone-setup: one deadline bounds the headers and the whole body: a body that stalls ends at it, and the process exits, garbage collection or not", async () => {
  // The forge in a process of its own, which sends headers and one byte, then nothing, and keeps the connection open.
  const server = spawn(process.execPath, ["-e", 'require("node:http").createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.write("["); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); })'], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((ok) => server.stdout.once("data", (d) => ok(String(d).trim())));
    const module = join(dirname(CLI), "..", "setup", "clone-setup.mjs");
    // The reader in a child with the collector exposed and run while it waits; it must end by itself, nothing closed for it.
    const script = `
      const { signingKeys } = await import(${JSON.stringify(module)});
      const gc = setInterval(() => globalThis.gc(), 50);
      const t0 = Date.now();
      const got = await signingKeys("lo-gin", { base: "http://127.0.0.1:${port}", seconds: 1 });
      clearInterval(gc);
      console.log(JSON.stringify({ got, ms: Date.now() - t0 }));`;
    const r = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(r.status, 0, `${r.status} ${r.signal} ${r.stdout}${r.stderr}`);
    const { got, ms } = JSON.parse(r.stdout);
    assert.deepEqual(got, { failed: { key: "cloneSetup.timeout", vars: { s: 1 } } });
    assert.ok(ms >= 900 && ms < 10_000, String(ms));
  } finally {
    server.kill("SIGKILL");
  }
});

test("clone-setup: the module reads the forge's answer in-process the same way", async () => {
  const f = await forge(() => ({ body: JSON.stringify([{ key: pub("a") }, { key: pub("a") }]) }));
  try {
    assert.deepEqual(await signingKeys("lo-gin", { base: f.base }), { keys: [pub("a")] });
  } finally {
    await f.close();
  }
});
