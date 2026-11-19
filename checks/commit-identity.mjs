/**
 * Who wrote the commits a push sends, and whether each is signed (config `commits`): push-check refuses a push that
 * holds a commit outside the rule, and doctor names a clone whose git settings would make such commits.
 *
 * The rule push-check holds a push to is the strictest of three configs (pushRule): the work tree's (as loadConfig reads
 * it, ENNYN_CONFIG and all), HEAD's and the upstream's `.ennyn/config.json`. So an edit not committed, a config
 * ENNYN_CONFIG names, or a loosening committed inside the range does not take the rule off the commits the push sends:
 * the remote holds the upstream's config until the push lands. Strictest: signing when any asks it, and an address
 * only when every list that is set holds it. Of HEAD's and the upstream's config only the `commits` block is read, and
 * checked by the rules loadConfig holds it to: a key this version retired or renamed elsewhere in the file costs
 * nothing, while JSON that does not parse, or a `commits` block of a wrong shape, is unmeasured.
 *
 * The range is what push-check reads for its tests, `<upstream>..HEAD` (checks/test-runs.mjs pushNeeds), and only
 * where a bare push sends HEAD's branch alone, to the url the upstream is fetched from (pushSendsMore). No upstream,
 * a push that sends more or elsewhere, a shallow clone (whose history may end before the upstream) or a git that
 * fails is unmeasured, never clean.
 * Commits are read with replace refs and grafts off (HOOK_READ_ENV): the push sends the objects as they are.
 *
 * An address passes when `commits.addresses` holds it, compared without case: author and committer both.
 *
 * A signature passes only when it is an SSH signature (every `gpgsig` header of the commit's raw text holds an SSH
 * armor), git says `G` (`%G?`) and the principal the allowed-signers file names for the key
 * (`%GS`) is the committer's address, without case: the committer is who made the commit object, and `G` alone ties
 * the key to no address (a key listed for b@x.test gives `G [b@x.test]` on a commit by a@x.test, git 2.56.0). `U` (a
 * good signature by a key the file does not list, or no file there) does not pass: any key makes one. With no
 * gpg.ssh.allowedSignersFile configured git says `N` for an SSH-signed commit as for an unsigned one; a commit whose
 * raw header holds a `gpgsig` line is then said to be signed and unchecked, never unsigned, and is refused all the
 * same. A line of the file with two principals gives the first, a wildcard its pattern: neither is the committer's
 * address, so such a file is refused; `ennyn clone-setup` writes one address a line. An OpenPGP or X.509 signature is
 * refused whatever git says of it: git calls it `G` for any key the local keyring trusts, a key made on this machine
 * with the committer's address in its user id among them (gpg 2.4), so `G` there says nothing of the list.
 */

import { isAbsolute, join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { CONFIG_PATH, ConfigError, configFrom } from "../core/config.mjs";
import { HOOK_READ_ENV, blobAt, git, gitBytes, gitMaybe, headCommit } from "../core/git.mjs";

/** @typedef {{ addresses: string[] | null, signed: boolean }} Rule addresses in lower case; null: any address */
/** @typedef {{ key: string, vars: Record<string, string> }} Why a catalog line */
/** @typedef {{ hash: string, why: Why[] }} Refused */

/** @param {string} s */
const lower = (s) => s.toLowerCase();

/**
 * The rule the config sets, or null when it sets none (no address and no signing): then nothing here runs.
 * @param {any} config
 * @returns {Rule | null}
 */
export function commitRule(config) {
  const { addresses, signed } = config.commits;
  if (!addresses.length && !signed) return null;
  return { addresses: addresses.length ? addresses.map(lower) : null, signed };
}

/**
 * The strictest of some rules: signing when any asks it; the addresses every set list holds (none, when two lists
 * share none); null with no rule.
 * @param {(Rule | null)[]} rules
 * @returns {Rule | null}
 */
export function strictest(rules) {
  const set = /** @type {Rule[]} */ (rules.filter(Boolean));
  if (!set.length) return null;
  const lists = /** @type {string[][]} */ (set.map((r) => r.addresses).filter((a) => a !== null));
  return { addresses: lists.length ? lists[0].filter((a) => lists.every((l) => l.includes(a))) : null, signed: set.some((r) => r.signed) };
}

/**
 * The rule a config's text sets, from its `commits` block alone, checked as loadConfig checks it: every other key
 * is passed over, so one a later version retired or renamed costs nothing. Null with no block. Text that is no JSON
 * object, or a block of a wrong shape, throws: unmeasured.
 * @param {string} text @param {string} cwd @param {string} where named in the error
 * @returns {Rule | null}
 */
export function ruleOfText(text, cwd, where) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`${where} is not JSON: ${/** @type {Error} */ (e).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${where} holds no JSON object`);
  if (!Object.hasOwn(parsed, "commits")) return null;
  try {
    return commitRule(configFrom(JSON.stringify({ commits: parsed.commits }), { cwd, configPath: join(cwd, CONFIG_PATH) }));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new Error(`${where}: ${e.problems.join("; ")}`);
  }
}

/**
 * The rule `.ennyn/config.json` at a commit sets (ruleOfText): null where the commit holds none, or no file there.
 * @param {string} cwd @param {string} rev
 * @returns {Rule | null}
 */
function ruleAt(cwd, rev) {
  const bytes = blobAt(cwd, rev, CONFIG_PATH);
  if (bytes === null || typeof bytes === "string") return null;
  return ruleOfText(bytes.toString("utf8"), cwd, `${CONFIG_PATH} at ${rev.slice(0, 40)}`);
}

/**
 * The rule push-check holds the push to: the strictest of the work tree's config, HEAD's and, when the range is known,
 * the upstream's. A git that fails, or a commit's config ruleOfText cannot read, throws.
 * @param {string} cwd the repository's top @param {any} config the work tree's @param {string | null} upstream
 * @returns {Rule | null}
 */
export function pushRule(cwd, config, upstream) {
  const head = headCommit(cwd);
  return strictest([commitRule(config), head ? ruleAt(cwd, head) : null, upstream ? ruleAt(cwd, upstream) : null]);
}

/** What each `%G?` letter other than G and N means, as git's pretty-formats manual words it. */
const SIGNATURE = /** @type {Record<string, string>} */ ({
  B: "a bad signature",
  U: "a good signature by a key the allowed-signers file does not list",
  X: "a good signature that has expired",
  Y: "a good signature by an expired key",
  R: "a good signature by a revoked key",
  E: "a signature git cannot check",
});

/**
 * Each commit of `range` and its identities, read in one git call; with `signed`, its signature as git verifies it
 * (one verification a commit).
 * @param {string} cwd @param {string} range @param {boolean} signed
 */
function commitsOf(cwd, range, signed) {
  const env = { ...process.env, ...HOOK_READ_ENV };
  const fields = signed ? ["%H", "%ae", "%ce", "%G?", "%GS"] : ["%H", "%ae", "%ce"];
  // NUL ends each field: git keeps it out of an ident and a principal; the newline git puts between commits starts the next hash.
  const text = git(["log", `--format=${fields.map((f) => `${f}%x00`).join("")}`, range, "--"], { cwd, env, walk: true });
  const parts = text.split("\0");
  /** @type {{ hash: string, author: string, committer: string, sig: string, signer: string }[]} */
  const out = [];
  for (let at = 0; at + fields.length <= parts.length; at += fields.length) {
    const [hash, author, committer, sig = "", signer = ""] = parts.slice(at, at + fields.length);
    const h = hash.replace(/^\n/, "");
    if (!/^[0-9a-f]{40,64}$/.test(h)) throw new Error(`git log printed no commit hash: ${JSON.stringify(h.slice(0, 80))}`);
    out.push({ hash: h, author, committer, sig, signer });
  }
  return out;
}

/** The armor a signature starts with, by format: what git itself reads to pick the program that verifies it. */
const ARMOR = /** @type {Record<string, string>} */ ({ "-----BEGIN SSH SIGNATURE-----": "ssh", "-----BEGIN PGP SIGNATURE-----": "openpgp", "-----BEGIN PGP MESSAGE-----": "openpgp", "-----BEGIN SIGNED MESSAGE-----": "x509" });

/**
 * The format of each signature header (`gpgsig`, `gpgsig-sha256`) in each commit's raw text, by hash, read in one
 * `git cat-file --batch`: `ssh`, `openpgp`, `x509` or `other`; an empty list for a commit with none.
 * @param {string} cwd @param {string[]} hashes
 * @returns {Map<string, string[]>}
 */
function signatureFormats(cwd, hashes) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  if (!hashes.length) return found;
  const out = gitBytes(["cat-file", "--batch"], { cwd, env: { ...process.env, ...HOOK_READ_ENV }, input: hashes.map((h) => `${h}\n`).join(""), walk: true });
  let at = 0;
  for (const hash of hashes) {
    const end = out.indexOf(10, at);
    const head = out.subarray(at, end).toString("utf8");
    const m = /^([0-9a-f]+) commit (\d+)$/.exec(head);
    if (!m || m[1] !== hash) throw new Error(`git cat-file --batch answered ${JSON.stringify(head.slice(0, 80))} for ${hash}`);
    const body = out.subarray(end + 1, end + 1 + Number(m[2])).toString("utf8");
    const header = body.slice(0, body.indexOf("\n\n") === -1 ? body.length : body.indexOf("\n\n"));
    found.set(hash, [...header.matchAll(/^gpgsig(?:-sha256)? (.*)$/gm)].map((m) => ARMOR[m[1].trim()] ?? "other"));
    at = end + 1 + Number(m[2]) + 1;
  }
  return found;
}

/** The address a signer is named by: SSH gives the principal. @param {string} signer */
const signerAddress = (signer) => lower(signer);

/**
 * What in git config makes a bare push of `branch` send more refs than that branch, or send it somewhere other than
 * the url its upstream is fetched from, with what to change; null when neither. pushNeeds has already held the push
 * to the upstream's ref (`@{push}`). More refs: push.default matching, a `remote.<name>.push` refspec, a mirror,
 * push.followTags (its tags point only into the branch's history, measured on git 2.56.0, but they are refs the
 * commits check does not read). Elsewhere: push urls (`git remote get-url --push --all`) other than the one fetch url
 * (`git remote get-url`), as a pushurl, a second url or a pushInsteadOf makes them; an insteadOf rewrites both alike.
 * Keys that change neither (a tool's own, as the gh CLI's `remote.<name>.gh-resolved`) pass. A local upstream
 * (remote ".") sends nothing anywhere. closingPush keeps its own, stricter allow list (pushWidened). A git that fails
 * throws.
 * @param {string} cwd @param {string} branch
 * @returns {{ setting: string, change: string } | null}
 */
export function pushSendsMore(cwd, branch) {
  const get = (/** @type {string} */ key, /** @type {string[]} */ type = []) => gitMaybe(["config", ...type, "--get", key], { cwd, absent: [1] });
  const all = (/** @type {string} */ key) => (gitMaybe(["config", "--get-all", key], { cwd, absent: [1] }) ?? "").split("\n").filter(Boolean);
  const remote = get(`branch.${branch}.remote`);
  if (!remote) return { setting: `branch.${branch}.remote`, change: "give the branch an upstream on a remote" };
  if (remote === ".") return null;
  if (get("push.default") === "matching") return { setting: "push.default", change: "set it to simple" };
  if (all(`remote.${remote}.push`).length) return { setting: `remote.${remote}.push`, change: "take the refspec out" };
  if (get(`remote.${remote}.mirror`, ["--type=bool"]) === "true") return { setting: `remote.${remote}.mirror`, change: "set it to false" };
  if (get("push.followTags", ["--type=bool"]) === "true") return { setting: "push.followTags", change: "set it to false, and push tags on their own" };
  const fetchUrl = gitMaybe(["remote", "get-url", remote], { cwd, absent: [2] });
  const pushUrls = (gitMaybe(["remote", "get-url", "--push", "--all", remote], { cwd, absent: [2] }) ?? "").split("\n").filter(Boolean);
  if (pushUrls.length === 1 && pushUrls[0] === fetchUrl) return null;
  const setting = all(`remote.${remote}.pushurl`).length ? `remote.${remote}.pushurl` : all(`remote.${remote}.url`).length > 1 ? `remote.${remote}.url` : "url.<base>.pushInsteadOf";
  return { setting, change: "make the push go to the one url the upstream is fetched from" };
}

/**
 * The commits of `<upstream>..HEAD` that break the rule, each with what is wrong, in git log's order; `checked`: how
 * many were read. A shallow clone throws: its history may end before the upstream, and the range would not be what
 * the push sends. A git that fails throws.
 * @param {string} cwd the repository's top @param {Rule} rule @param {string} upstream the full ref pushNeeds read
 * @returns {{ checked: number, refused: Refused[] }}
 */
export function commitsRefused(cwd, rule, upstream) {
  if (gitMaybe(["rev-parse", "--is-shallow-repository"], { cwd, absent: [] }) === "true") throw new Error("a shallow clone: its history may not reach the upstream");
  const branch = gitMaybe(["symbolic-ref", "-q", "--short", "HEAD"], { cwd, absent: [1] });
  if (!branch) throw new Error("HEAD is on no branch");
  const more = pushSendsMore(cwd, branch);
  if (more) throw new Error(`a bare git push may send more than ${branch}, or send it elsewhere (${more.setting}): ${more.change}`);
  const commits = commitsOf(cwd, `${upstream}..HEAD`, rule.signed);
  const formats = rule.signed ? signatureFormats(cwd, commits.map((c) => c.hash)) : /** @type {Map<string, string[]>} */ (new Map());
  /** @type {Refused[]} */
  const refused = [];
  for (const c of commits) {
    /** @type {Why[]} */
    const why = [];
    if (rule.addresses) {
      if (!rule.addresses.includes(lower(c.author))) why.push({ key: "commits.author", vars: { address: c.author } });
      if (!rule.addresses.includes(lower(c.committer))) why.push({ key: "commits.committer", vars: { address: c.committer } });
    }
    const kinds = formats.get(c.hash) ?? [];
    const other = kinds.filter((k) => k !== "ssh");
    if (!rule.signed) {
      // no signature asked
    } else if (!kinds.length) why.push({ key: "commits.unsigned", vars: {} });
    else if (other.length) why.push({ key: "commits.notSsh", vars: { format: [...new Set(other)].join(", ") } });
    else {
      if (c.sig === "G") {
        if (signerAddress(c.signer) !== lower(c.committer)) why.push({ key: "commits.otherSigner", vars: { signer: c.signer, address: c.committer } });
      } else if (c.sig === "N") why.push({ key: "commits.unchecked", vars: {} });
      else why.push({ key: "commits.notGood", vars: { code: c.sig, what: SIGNATURE[c.sig] ?? "a signature git does not verify as good" } });
    }
    if (why.length) refused.push({ hash: c.hash, why });
  }
  return { checked: commits.length, refused };
}

/**
 * The public half of user.signingkey as an allowed-signers line names it, `<type> <base64>`: a `key::` literal, a
 * literal key, or the file it names (a public key, or a private key with its `.pub` beside it). Null when it names no
 * key of that shape; a file that cannot be read throws.
 * @param {string} value as `git config --type=path` gives it @param {string} cwd
 * @returns {string | null}
 */
export function signingPublicKey(value, cwd) {
  const shape = (/** @type {string} */ text) => /^(\S+) ([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(text.trim());
  const literal = value.startsWith("key::") ? value.slice(5) : /^(ssh-|ecdsa-|sk-)/.test(value) ? value : null;
  if (literal !== null) return ((m) => (m ? `${m[1]} ${m[2]}` : null))(shape(literal));
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  for (const file of [path, `${path}.pub`]) {
    if (!isFile(file)) continue;
    const m = shape(readFileSync(file, "utf8").split("\n")[0] ?? "");
    if (m && !m[1].startsWith("-----")) return `${m[1]} ${m[2]}`;
  }
  return null;
}

/**
 * Whether an allowed-signers file lists `key` for `address` alone, for git: a line `<address> [namespaces="…git…"]
 * <key> [comment]`, the address one principal, no pattern. A line that holds the key for the address with any other
 * option (valid-before, cert-authority, a quoted option this reading does not follow) is unmeasured; none at all is
 * unlisted.
 * @param {string} text @param {string} address lower case @param {string} key `<type> <base64>`
 * @returns {"listed" | "unlisted" | "unmeasured"}
 */
export function signerListed(text, address, key) {
  const [type, body] = key.split(" ");
  let unsure = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const words = line.split(/\s+/);
    const at = words.findIndex((w, i) => i > 0 && w === type && words[i + 1] === body);
    if (at === -1) continue;
    if (lower(words[0]) !== address) continue;
    const options = words.slice(1, at);
    if (!options.length) return "listed";
    const ns = options.length === 1 ? /^namespaces="([^"\s]*)"$/.exec(options[0]) : null;
    if (ns && ns[1].split(",").includes("git")) return "listed";
    unsure = true;
  }
  return unsure ? "unmeasured" : "unlisted";
}

/**
 * Whether a file is there: none, or something else in its place, is false; a file that cannot be looked at throws, so
 * it is unmeasured, not missing.
 * @param {string} path
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes(String(/** @type {NodeJS.ErrnoException} */ (e).code))) return false;
    throw e;
  }
}

/**
 * What this clone lacks for the rule. `gaps`, by name: with `signed`, commit and tag signing on, a signing key, gpg.format
 * ssh (the allowed-signers file `ennyn clone-setup` builds holds SSH keys), an allowed-signers file that is there and a
 * user.email; with addresses, a user.email the list holds. `key`, with `signed` and no gap: whether the file lists
 * the signing key's public half for user.email (signerListed), `unmeasured` with why when the key or the file could
 * not be read as one; null when not read. Read as git reads them here (every scope). A git that fails throws.
 * @param {string} cwd the repository's top @param {Rule} rule
 * @returns {{ gaps: string[], key: null | "listed" | "unlisted" | { unmeasured: string } }}
 */
export function cloneGaps(cwd, rule) {
  const get = (/** @type {string} */ key, /** @type {string[]} */ type = []) => gitMaybe(["config", ...type, "--get", key], { cwd, absent: [1] });
  /** @type {string[]} */
  const gaps = [];
  const email = get("user.email");
  const signingKey = rule.signed ? get("user.signingkey", ["--type=path"]) : null;
  let file = null;
  if (rule.signed) {
    if (get("commit.gpgsign", ["--type=bool"]) !== "true") gaps.push("commit.gpgsign");
    if (get("tag.gpgsign", ["--type=bool"]) !== "true") gaps.push("tag.gpgsign");
    if (!signingKey) gaps.push("user.signingkey");
    if (get("gpg.format") !== "ssh") gaps.push("gpg.format");
    const named = get("gpg.ssh.allowedSignersFile", ["--type=path"]);
    file = named ? (isAbsolute(named) ? named : resolve(cwd, named)) : null;
    if (!file || !isFile(file)) gaps.push("gpg.ssh.allowedSignersFile");
  }
  if (rule.addresses ? !email || !rule.addresses.includes(lower(email)) : rule.signed && !email) gaps.push("user.email");
  if (!rule.signed || gaps.length) return { gaps, key: null };
  try {
    const pub = signingPublicKey(/** @type {string} */ (signingKey), cwd);
    if (!pub) return { gaps, key: { unmeasured: "user.signingkey names no SSH public key this reading finds" } };
    const listed = signerListed(readFileSync(/** @type {string} */ (file), "utf8"), lower(/** @type {string} */ (email)), pub);
    return { gaps, key: listed === "unmeasured" ? { unmeasured: "the allowed-signers file holds the key for user.email with options this reading does not follow" } : listed };
  } catch (e) {
    return { gaps, key: { unmeasured: String(/** @type {Error} */ (e).message).split("\n")[0] } };
  }
}
