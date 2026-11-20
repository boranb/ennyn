/**
 * What `ennyn clone-setup` prints and builds: the per-clone git settings `commits.*` needs, as commands the user runs
 * (it runs no `git config` itself: which key signs, and whether a setting goes to this clone or every one, are the
 * user's), and the allowed-signers file git verifies signatures against, built from GitHub's public list of a user's
 * SSH signing keys (`GET /users/<login>/ssh_signing_keys`, no token: the docs say anyone may read it).
 *
 * The file goes to the state dir (`paths.stateDir`, under the git dir: per clone, never committed), one line a key,
 * `<address> namespaces="git" <key>`, written whole to a temporary file and renamed: an answer that fails, is not 200,
 * is not a list of keys or holds none leaves the file as it was. The API's origin is https://api.github.com;
 * ENNYN_GITHUB_API may name another, and only a loopback one (the tests' server): a remote origin set there would
 * have the file trust whatever keys it serves, and anything that can serve on this machine's loopback could as well
 * write the file itself.
 */

import { join } from "node:path";
import { ADDRESS } from "../core/config.mjs";
import { writeState } from "../core/files.mjs";
import { resolveStateDir, stateRoot } from "../core/git.mjs";

export const API = "https://api.github.com";
/** The file's name in the state dir. */
export const SIGNERS_FILE = "allowed_signers";
/** Most bytes of an answer read: 100 keys of a few hundred bytes each fit many times over. */
const ANSWER_LIMIT = 1024 * 1024;
/** A GitHub login: letters, digits and single hyphens between them, at most 39. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** GitHub's noreply address, `<id>+<login>@users.noreply.github.com` or the older `<login>@…`. */
const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;
/** An SSH public key as an allowed-signers line takes it: its type and its base64 body, nothing after. */
const KEY = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;

/** @typedef {{ key: string, vars: Record<string, string | number> }} Said a catalog line */

/** @param {string} login */
export const isLogin = (login) => LOGIN.test(login);

/**
 * The one login a GitHub noreply address in the list names, with that address; null when none or two do.
 * @param {string[]} addresses
 * @returns {{ login: string, address: string } | null}
 */
export function noreplyLogin(addresses) {
  const found = addresses.map((a) => ({ m: NOREPLY.exec(a), a })).filter((x) => x.m && isLogin(x.m[1]));
  return found.length === 1 ? { login: /** @type {RegExpExecArray} */ (found[0].m)[1], address: found[0].a } : null;
}

/**
 * The API origin to ask: the default, or a loopback one ENNYN_GITHUB_API names.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ base: string } | { refused: string }}
 */
export function apiBase(env) {
  const named = env.ENNYN_GITHUB_API;
  if (named === undefined || named === "") return { base: API };
  try {
    const u = new URL(named);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.origin === named) return { base: named };
  } catch {
    // said below
  }
  return { refused: named };
}

/**
 * The SSH signing keys GitHub lists for `login`, each `<type> <base64>`, or why there are none to write.
 * @param {string} login @param {{ base: string, seconds?: number }} opts
 * @returns {Promise<{ keys: string[] } | { failed: Said }>}
 */
export async function signingKeys(login, { base, seconds = 20 }) {
  const url = `${base}/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`;
  // One deadline for the headers and the whole body: a timer of this call's own, which aborts the request and ends the
  // wait. AbortSignal.timeout alone is collected once fetch has answered, and a body that stalls then never ends.
  const stop = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  // The body's reader, cancelled at the end whatever ended the wait: once the headers came, fetch's abort may no
  // longer reach the connection, and a stalled one held the process open after the deadline (measured, Node 22.23.4).
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  let reader = null;
  const deadline = new Promise((_, fail) => {
    timer = setTimeout(() => {
      stop.abort();
      fail(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    }, seconds * 1000);
  });
  /** @returns {Promise<{ bytes: Buffer } | { failed: Said }>} */
  const read = async () => {
    const res = await fetch(url, { signal: stop.signal, redirect: "error", headers: { accept: "application/vnd.github+json", "user-agent": "ennyn-clone-setup" } });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { failed: { key: "cloneSetup.status", vars: { status: res.status } } };
    }
    // A list longer than one page would be read in part: a key left out is a signer refused, and the rest are not all.
    if (/rel="next"/.test(res.headers.get("link") ?? "")) {
      await res.body.cancel().catch(() => {});
      return { failed: { key: "cloneSetup.tooMany", vars: {} } };
    }
    const body = res.body.getReader();
    reader = body;
    /** @type {Uint8Array[]} */
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      size += value.length;
      if (size > ANSWER_LIMIT) {
        await body.cancel().catch(() => {});
        return { failed: { key: "cloneSetup.shape", vars: { why: `more than ${ANSWER_LIMIT} bytes` } } };
      }
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks) };
  };
  /** @type {{ bytes: Buffer } | { failed: Said }} */
  let got;
  try {
    got = await Promise.race([read(), deadline]);
  } catch (e) {
    const err = /** @type {Error & { cause?: { code?: string, message?: string } }} */ (e);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { failed: { key: "cloneSetup.timeout", vars: { s: seconds } } };
    return { failed: { key: "cloneSetup.network", vars: { error: String(err?.cause?.code || err?.cause?.message || err?.message || e).split("\n")[0] } } };
  } finally {
    clearTimeout(timer);
    stop.abort();
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */ (reader)?.cancel().catch(() => {});
  }
  if ("failed" in got) return got;
  let body;
  try {
    body = JSON.parse(got.bytes.toString("utf8"));
  } catch {
    return { failed: { key: "cloneSetup.shape", vars: { why: "not JSON" } } };
  }
  if (!Array.isArray(body)) return { failed: { key: "cloneSetup.shape", vars: { why: "not a list" } } };
  // Every entry as the docs give it, an object whose own `key` is one public key: one that is not refuses the answer whole.
  const bad = body.findIndex((k) => !k || typeof k !== "object" || Array.isArray(k) || !Object.hasOwn(k, "key") || typeof k.key !== "string" || !KEY.test(k.key));
  if (bad !== -1) return { failed: { key: "cloneSetup.shape", vars: { why: `entry ${bad + 1} holds no SSH public key` } } };
  if (!body.length) return { failed: { key: "cloneSetup.none", vars: { login } } };
  return { keys: [...new Set(body.map((k) => /** @type {string} */ (k.key)))] };
}

/** The allowed-signers file of one address. @param {string} address @param {string[]} keys */
export const signersText = (address, keys) => keys.map((k) => `${address} namespaces="git" ${k}\n`).join("");

/**
 * Where the file goes: the state dir, under the common git dir, so every worktree of the clone reads one file.
 * @param {string} cwd @param {any} config
 */
export const signersPath = (cwd, config) => join(resolveStateDir(cwd, config.paths.stateDir), SIGNERS_FILE);

/**
 * Write the file whole, through a temporary file renamed over it.
 * @param {string} cwd @param {string} path @param {string} text
 */
export function writeSigners(cwd, path, text) {
  writeState(stateRoot(cwd, path), path, text, "replace");
}

/** A word as sh reads it back: quoted unless it holds only characters sh leaves alone. @param {string} s */
const word = (s) => (/^[A-Za-z0-9@._%+=/:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The commands a clone runs for the rule, in order.
 * @param {{ address: string | null, signed: boolean, signingKey: string | null, signers: string, cli: string, pluginData?: string | null }} o
 *   `address`: the user.email to set, null when none was chosen; `signingKey`: the clone's, kept when set; unset, a
 *   fill-in quoted like a value, so the line still parses as pasted (unquoted, its `<` and `>` were redirections, and
 *   sh refused the line while the lines after it ran) and a commit then names the fill-in in git's error
 * @returns {string[]}
 */
export function setupCommands({ address, signed, signingKey, signers, cli, pluginData = null }) {
  return [
    ...(address ? [`git config user.email ${word(address)}`] : []),
    ...(signed
      ? [
          "git config gpg.format ssh",
          `git config user.signingkey ${signingKey ? word(signingKey) : word("<your SSH public key file>")}`,
          "git config commit.gpgsign true",
          "git config tag.gpgsign true",
          `git config gpg.ssh.allowedSignersFile ${word(signers)}`,
        ]
      : []),
    `node ${word(cli)} install-hook${pluginData ? ` --plugin-data ${word(pluginData)}` : ""}`,
  ];
}

/** @param {string} address */
export const isAddress = (address) => ADDRESS.test(address);
