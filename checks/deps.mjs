/**
 * Dependencies a commit brings (security.deps): the entries of an npm lock file that HEAD's version does not
 * hold. Three rules, each a way the 2026 npm worms spread: an install script runs on every `npm install` with the
 * user's rights (the worms ran theirs from preinstall and from a binding.gyp, which npm runs as `node-gyp
 * rebuild`); a version only days old has not been looked at by anyone (the malicious versions were pulled within
 * hours or days); a version almost nobody installs has not been either.
 *
 * What is checked is what npm installs: the tarball `resolved` names, sealed by `integrity`. An entry from a
 * listed registry whose tarball path, in npm's layout (`…/<name>/-/<name without scope>-<version>.tgz`), names
 * another package or version fails, as does one with no integrity, two digests of one algorithm, an integrity
 * that is not the registry's, or install scripts the registry's manifest shows and the lock leaves out. A path
 * in another layout cannot prove the identity: that is said. A staged `.npmrc` that points npm at a registry no
 * list names fails too, read as npm reads it. `allow` and `allowScripts` name an identity the tarball path
 * proves (or, for scripts, an exact `resolved`), never a name the lock merely writes.
 * Install scripts are read from the lock (npm writes `hasInstallScript`); age, adoption, the registry's
 * integrity and manifest come from the registry the entry was resolved from: the full packument (`time`,
 * `versions`; the abbreviated install document has no `time`) and last week's downloads per version. Only
 * origins `registries` lists are contacted; what is not measured is said, never counted as clean. `ennyn deps`
 * asks OSV for known advisories, and only about packages from the public registries `advisoryRegistries` names.
 *
 * Calibration (2026-10-24): versions 7 to 21 days old of busy packages held 0.66% to 12% of their package's
 * downloads (vite, eslint, zod, @aws-sdk/client-s3, @types/node), but the parallel lines of undici-types held
 * 0.03% to 0.22% with 1,554 to 527,064 downloads, and react 19.0.9 0.00% with 5,791: a share alone would refuse
 * them, so a version is refused only when both its share and its own downloads are low.
 */

import { isUtf8 } from "node:buffer";
import { matchAny } from "../core/glob.mjs";
import { t, tShown } from "../core/i18n.mjs";

/**
 * @typedef {{ key: string, name: string, version: string, resolved: string | null, integrity: string | null, scripts: boolean, bundled: boolean }} LockEntry
 * @typedef {{ paths: string[], cooldownDays: number, minShare: number, minWeekly: number, allow: string[], allowScripts: string[], online: boolean, timeout: number, registries: Record<string, string | null>, advisories: string, advisoryRegistries: string[] }} DepsRule
 * @typedef {{ key: string, vars?: Record<string, string | number> }} Reason why something was not measured: `deps.reason.<key>`
 * @typedef {{ held: number }} Meter the answer bytes held at once in one run
 */

/** A name the npm registry serves: url-safe, one scope at most (old names may hold capitals). */
const NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/** The largest answer read: the largest packument measured (renovate, 2026-10-24) is 73.2 MB, next 31.5 MB. */
export const ANSWER_LIMIT = 160 * 1024 * 1024;
/** The answer bytes one run holds at once, whatever the number of requests: memory stays bounded. */
export const HELD_LIMIT = 256 * 1024 * 1024;

/** @param {Reason} r @param {string} lang */
export const reasonText = (r, lang) => t(`deps.reason.${r.key}`, r.vars ?? {}, lang);

/**
 * Whether npm reads `path` as one of the lock files `paths` names. A case-insensitive file system (macOS,
 * Windows) opens `Package-Lock.json` as `package-lock.json`, so a path is also matched in lower case.
 * @param {string} path @param {string[]} paths
 */
export function lockPath(path, paths) {
  return matchAny(path, paths) || matchAny(path.toLowerCase(), paths.map((g) => g.toLowerCase()));
}

/** An `.npmrc`, in any case: the caller decides which ones npm reads for the project. @param {string} path */
export const npmrcPath = (path) => /(^|\/)\.npmrc$/i.test(path);

/** The directory of a repository path, "" at the top. @param {string} path */
export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The text of a file the rules can read: UTF-8 with no NUL (a byte order mark is dropped); null otherwise.
 * @param {Buffer} bytes
 */
export function lockText(bytes) {
  if (bytes.includes(0) || !isUtf8(bytes)) return null;
  return bytes.toString("utf8").replace(/^﻿/, "");
}

/** @param {any} v @param {string} key @param {string} name */
const entryOf = (v, key, name) => ({
  key,
  name: typeof v.name === "string" ? v.name : name,
  version: typeof v.version === "string" ? v.version : "",
  resolved: typeof v.resolved === "string" ? v.resolved : null,
  integrity: typeof v.integrity === "string" ? v.integrity : null,
  scripts: v.hasInstallScript === true,
  bundled: v.inBundle === true || v.bundled === true,
});

/**
 * The installed packages a lock file names. Version 2 and 3: every `packages` entry under a `node_modules/` path
 * (a `\` read as `/`, as npm on Windows reads it), but a link (a workspace's own code). Version 1 (npm 6): its
 * `dependencies` tree, an alias (`"version": "npm:real@5.0.0"`) as the package it is, none at all an empty lock;
 * it records no install scripts (`v1`). A lock that is not JSON (a merge left its conflict markers), of another
 * version, or with no packages is `unread`.
 * @param {string} text
 * @returns {{ entries: LockEntry[], v1?: boolean, unread?: undefined } | { unread: Reason, entries?: undefined, v1?: undefined }}
 */
export function lockEntries(text) {
  /** @type {any} */
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return { unread: { key: "notJson" } };
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return { unread: { key: "notObject" } };
  /** @type {LockEntry[]} */
  const entries = [];
  if (lock.lockfileVersion === 1) {
    const walk = (/** @type {any} */ deps, /** @type {string} */ at, /** @type {number} */ depth) => {
      if (!deps || typeof deps !== "object" || Array.isArray(deps) || depth > 200) return;
      for (const [name, v] of Object.entries(deps)) {
        if (!v || typeof v !== "object") continue;
        const key = `${at}node_modules/${name}`;
        const e = entryOf(v, key, name);
        const alias = /^npm:(.+)@([^@]+)$/.exec(e.version);
        entries.push(alias ? { ...e, name: alias[1], version: alias[2] } : e);
        walk(v.dependencies, `${key}/`, depth + 1);
      }
    };
    walk(lock.dependencies, "", 0);
    return { entries, v1: true };
  }
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) return { unread: { key: "lockVersion", vars: { version: JSON.stringify(lock.lockfileVersion) ?? "none" } } };
  const packages = lock.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return { unread: { key: "noPackages" } };
  for (const [raw, v] of Object.entries(packages)) {
    const key = raw.replace(/\\/g, "/");
    const at = key.lastIndexOf("node_modules/");
    if (at === -1 || !v || typeof v !== "object" || v.link === true) continue;
    entries.push(entryOf(v, key, key.slice(at + "node_modules/".length)));
  }
  return { entries };
}

/** @param {LockEntry} e */
const idOf = (e) => `${e.name}@${e.version}`;
/** @param {LockEntry} e */
const sealOf = (e) => `${idOf(e)} ${e.resolved ?? ""} ${e.integrity ?? ""}`;
/** Sorted by name, then version: messages do not depend on the order answers arrived in. @param {LockEntry} a @param {LockEntry} b */
const byIdentity = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);

/**
 * The entries of `staged` that `head` does not hold: a name@version from the same `resolved` with the same
 * `integrity` (a hoisted package that moves is no new one; one whose `resolved` or `integrity` changed is), once each.
 * @param {LockEntry[]} staged @param {LockEntry[]} head
 */
export function newEntries(staged, head) {
  const had = new Set(head.map(sealOf));
  /** @type {Map<string, LockEntry>} */
  const out = new Map();
  for (const e of staged) if (!had.has(sealOf(e)) && !out.has(sealOf(e))) out.set(sealOf(e), e);
  return [...out.values()];
}

/** npm's tarball layout at the end of a path: the prefix, the package (a scope's slash written or encoded), the file. */
const LAYOUT = /^(.*?)\/((?:@[^/]+(?:\/|%2[fF]))?[^/]+)\/-\/([^/]+)\.tgz$/;

/** @param {string} s */
const decoded = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * The registry an entry was resolved from: a URL `registries` lists (an origin, or an origin and a path, as
 * Artifactory and Nexus serve one), when `resolved` is, right after that URL, npm's tarball of this very package
 * and version (`/<name>/-/<name without scope>-<version>.tgz`, a scope's slash written or encoded): `{ origin,
 * registry }`, the registry asked about it being that configured URL, never one the lock spells. Otherwise why it
 * is not asked: `refuse` when npm's layout at the end of the path names another package or version; another
 * place on a listed origin (another repository of a shared registry, GitHub Packages' `/download/…`) proves
 * nothing and is said.
 * @param {LockEntry} e @param {DepsRule} rule
 * @returns {{ origin: string, registry: string } | { reason: Reason, refuse?: boolean }}
 */
export function registryOf(e, rule) {
  if (!NAME.test(e.name)) return { reason: { key: "notName" } };
  if (!e.version) return { reason: { key: "noVersion" } };
  if (!e.resolved) return { reason: { key: e.bundled ? "bundled" : "noResolved" } };
  let url;
  try {
    url = new URL(e.resolved);
  } catch {
    return { reason: { key: "badUrl" } };
  }
  const listed = Object.keys(rule.registries).filter((k) => new URL(k).origin === url.origin);
  if (url.origin === "null" || !listed.length) return { reason: { key: "unlisted", vars: { from: url.origin === "null" ? e.resolved.split(/[#?]/)[0] : url.origin } } };
  const href = `${url.origin}${url.pathname}`;
  // The longest listed URL the tarball sits under.
  const registry = listed.filter((k) => href.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0];
  const file = `${e.name.replace(/^@[^/]+\//, "")}-${e.version}`;
  const want = `${registry ? new URL(registry).pathname.replace(/\/$/, "") : ""}/${e.name}/-/${file}.tgz`;
  const mismatch = { reason: { key: "mismatch", vars: { path: `${url.pathname}${url.search}${url.hash}`, want } }, refuse: true };
  if (url.search || url.hash) return mismatch;
  const right = registry ? /^\/((?:@[^/]+(?:\/|%2[fF]))?[^/]+)\/-\/([^/]+)\.tgz$/.exec(href.slice(registry.length)) : null;
  if (right && decoded(right[1]) === e.name && decoded(right[2]) === file) return { origin: url.origin, registry };
  const end = LAYOUT.exec(url.pathname);
  if (end && !(decoded(end[2]) === e.name && decoded(end[3]) === file)) return mismatch;
  return { reason: { key: "unproven", vars: { path: url.pathname } } };
}

/** Whether an install script may run: the proven name, or the exact `resolved`, is in `allowScripts`. @param {LockEntry} e @param {DepsRule} rule */
const scriptsAllowed = (e, rule) => rule.allowScripts.includes(String(e.resolved)) || ("origin" in registryOf(e, rule) && rule.allowScripts.includes(e.name));

/** The digests of an integrity, in order: ssri accepts content that matches any one of the strongest algorithm's. @param {string | null} integrity */
const digests = (integrity) =>
  (integrity ?? "")
    .split(/\s+/)
    .filter((p) => /^[a-z0-9]+-/.test(p))
    .map((part) => ({ algo: part.slice(0, part.indexOf("-")), digest: part.slice(part.indexOf("-") + 1).replace(/\?.*$/, "") }));

/** An integrity with two digests of one algorithm: one of them may seal other bytes. @param {string | null} integrity */
const doubled = (integrity) => {
  const algos = digests(integrity).map((d) => d.algo);
  return algos.some((a, i) => algos.indexOf(a) !== i);
};

/** The name in a registry path: a scope's slash encoded, as the registry expects. @param {string} name */
const pathName = (name) => (name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));

/**
 * Why a request ended without an answer.
 * @param {unknown} e @param {number} seconds @returns {Reason}
 */
function failure(e, seconds) {
  const err = /** @type {Error & { cause?: { code?: string, message?: string }, reason?: Reason }} */ (e);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return { key: "timeout", vars: { s: seconds } };
  if (err?.reason) return err.reason;
  return { key: "network", vars: { error: String(err?.cause?.code || err?.cause?.message || err?.message || e).split("\n")[0] } };
}

/** @param {Reason} reason */
const fail = (reason) => Object.assign(new Error(reason.key), { reason });

/**
 * GET or POST JSON, following no redirect (one could lead to a host no list names), reading the answer as it
 * arrives: at most ANSWER_LIMIT bytes of it (a compressed answer can unpack to any size), and at most HELD_LIMIT
 * bytes of all the answers `meter` counts at once.
 * @param {string} url @param {AbortSignal} signal @param {Meter} meter @param {unknown} [body]
 */
export async function fetchJson(url, signal, meter, body) {
  const res = await fetch(url, {
    signal,
    redirect: "error",
    method: body === undefined ? "GET" : "POST",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok || !res.body) {
    // The body is not read: drop it, so the connection is let go.
    await res.body?.cancel().catch(() => {});
    throw fail(res.status === 404 ? { key: "notFound" } : { key: "http", vars: { status: res.status } });
  }
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      meter.held += value.length;
      if (size > ANSWER_LIMIT || meter.held > HELD_LIMIT) {
        await reader.cancel().catch(() => {});
        throw fail(size > ANSWER_LIMIT ? { key: "tooLarge", vars: { mb: ANSWER_LIMIT / 1024 / 1024 } } : { key: "heldTooMuch", vars: { mb: HELD_LIMIT / 1024 / 1024 } });
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw fail({ key: "notJsonAnswer" });
    }
  } finally {
    meter.held -= size;
  }
}

/** A property of an answer only when it is the answer's own. @param {unknown} o @param {string} k */
const own = (o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? /** @type {any} */ (o)[k] : undefined);

/**
 * Runs the jobs, at most `n` at a time.
 * @template T @param {(() => Promise<T>)[]} jobs @param {number} n
 */
async function pool(jobs, n) {
  /** @type {T[]} */
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

/** The time since publication in tenths of a day, floored, at least 0 (a publish time in the future counts as now). @param {number} now @param {number} published */
const tenthsOld = (now, published) => Math.max(0, Math.floor((now - published) / 8640000));

/**
 * What the registry says of new entries whose identity registryOf proved: `tampered` when a digest of its
 * integrity is not the registry's for that algorithm; `hiddenScripts` when the registry's manifest runs install
 * scripts (preinstall, install, postinstall, a binding.gyp) and the lock says none; `young` when published less
 * than `cooldownDays` ago (`tenths`: its age in tenths of a day, floored); `unadopted` when older, with less
 * than `minShare` of its package's downloads last week and fewer than `minWeekly` of its own; `unread` with why
 * and which `part` was not measured: `all` (no manifest: age, adoption, the registry's integrity and install
 * scripts), `age` (the manifest was read: age and adoption) or `adoption`. An entry `allow` names is asked only
 * for its integrity and scripts. One packument and one downloads answer a package; at most eight requests at a
 * time; all within `signal`. Every value of an answer is checked for its kind: a malformed answer is unread.
 * @param {LockEntry[]} entries
 * @param {DepsRule} rule
 * @param {{ now?: number, signal?: AbortSignal, meter?: Meter }} [opts]
 */
export async function registryVerdicts(entries, rule, { now = Date.now(), signal = AbortSignal.timeout(rule.timeout * 1000), meter = { held: 0 } } = {}) {
  /** @type {{ entry: LockEntry, tenths: number }[]} */
  const young = [];
  /** @type {{ entry: LockEntry, weekly: number, total: number }[]} */
  const unadopted = [];
  /** @type {{ entry: LockEntry }[]} */
  const tampered = [];
  /** @type {{ entry: LockEntry }[]} */
  const hiddenScripts = [];
  /** @type {{ entry: LockEntry, reason: Reason, part: "all" | "age" | "adoption" }[]} */
  const unread = [];
  /** @type {Map<string, { registry: string, name: string, entries: LockEntry[] }>} */
  const packages = new Map();
  for (const e of entries) {
    const where = registryOf(e, rule);
    if ("reason" in where) {
      unread.push({ entry: e, reason: where.reason, part: "all" });
      continue;
    }
    const k = `${where.registry} ${e.name}`;
    const p = packages.get(k) ?? { registry: where.registry, name: e.name, entries: [] };
    p.entries.push(e);
    packages.set(k, p);
  }
  await pool(
    [...packages.values()].map((p) => async () => {
      /** @type {unknown} */
      let doc;
      try {
        doc = await fetchJson(`${p.registry}/${pathName(p.name)}`, signal, meter);
      } catch (e) {
        for (const entry of p.entries) unread.push({ entry, reason: failure(e, rule.timeout), part: "all" });
        return;
      }
      const old = [];
      for (const entry of p.entries) {
        const manifest = own(own(doc, "versions"), entry.version);
        if (!manifest || typeof manifest !== "object") {
          unread.push({ entry, reason: { key: "noSuchVersion" }, part: "all" });
          continue;
        }
        const sealed = own(own(manifest, "dist"), "integrity");
        const theirs = digests(typeof sealed === "string" ? sealed : null);
        if (digests(entry.integrity).some((d) => theirs.some((x) => x.algo === d.algo) && !theirs.some((x) => x.algo === d.algo && x.digest === d.digest))) tampered.push({ entry });
        const scripts = own(manifest, "scripts");
        const runs = own(manifest, "hasInstallScript") === true || own(manifest, "gypfile") === true || ["preinstall", "install", "postinstall"].some((k) => typeof own(scripts, k) === "string");
        if (runs && !entry.scripts && !scriptsAllowed(entry, rule)) hiddenScripts.push({ entry });
        if (rule.allow.includes(idOf(entry))) continue;
        const time = own(own(doc, "time"), entry.version);
        const published = typeof time === "string" ? Date.parse(time) : NaN;
        if (!Number.isFinite(published)) unread.push({ entry, reason: { key: "noTime" }, part: "age" });
        else if (now - published < rule.cooldownDays * 86400e3) young.push({ entry, tenths: tenthsOld(now, published) });
        else old.push(entry);
      }
      if (!old.length) return;
      const api = rule.registries[p.registry];
      if (!api) {
        for (const entry of old) unread.push({ entry, reason: { key: "noDownloadsApi", vars: { registry: p.registry } }, part: "adoption" });
        return;
      }
      /** @type {unknown} */
      let counts;
      try {
        counts = own(await fetchJson(`${api}/versions/${pathName(p.name)}/last-week`, signal, meter), "downloads");
        if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw fail({ key: "noDownloads" });
      } catch (e) {
        for (const entry of old) unread.push({ entry, reason: failure(e, rule.timeout), part: "adoption" });
        return;
      }
      const whole = (/** @type {unknown} */ n) => (typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0);
      const total = Object.values(/** @type {object} */ (counts)).reduce((a, n) => a + whole(n), 0);
      for (const entry of old) {
        const weekly = whole(own(counts, entry.version));
        const share = total ? weekly / total : 0;
        if (share < rule.minShare && weekly < rule.minWeekly) unadopted.push({ entry, weekly, total });
      }
    }),
    8,
  );
  return { young, unadopted, tampered, hiddenScripts, unread };
}

/** @param {string} val */
function iniUnsafe(val) {
  // npm's ini (5.0, npm 10): trimmed; quoted, unquoted and JSON-parsed; else cut at the first ; or # not escaped.
  let v = (val || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.charAt(0) === "'") v = v.slice(1, -1);
    try {
      v = JSON.parse(v);
    } catch {
      // as written
    }
    return String(v);
  }
  let esc = false;
  let out = "";
  for (const c of v) {
    if (esc) {
      out += "\\;#".includes(c) ? c : `\\${c}`;
      esc = false;
    } else if (";#".includes(c)) break;
    else if (c === "\\") esc = true;
    else out += c;
  }
  if (esc) out += "\\";
  return out.trim();
}

/**
 * The settings of an `.npmrc`, read as npm's ini reads them: lines end at CR, LF or both; a line whose first
 * character past spaces is `;` or `#` is a comment; keys and values are unquoted and unescaped, and a `;` or `#`
 * ends an unquoted one; `key[]` is the key; a key under a `[section]` is not one of npm's (`top` false).
 * @param {string} text
 * @returns {{ n: number, line: string, key: string, value: string, top: boolean }[]}
 */
export function npmrcEntries(text) {
  /** @type {{ n: number, line: string, key: string, value: string, top: boolean }[]} */
  const out = [];
  let section = false;
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) return;
    const m = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/.exec(line);
    if (!m) return;
    if (m[1] !== undefined) {
      section = true;
      return;
    }
    let key = iniUnsafe(m[2]);
    if (key.length > 2 && key.endsWith("[]")) key = key.slice(0, -2);
    // The line as shown: credentials in a URL are not printed.
    out.push({ n: i + 1, line: line.trim().replace(/(\/\/)[^/@\s]*@/g, "$1…@"), key, value: m[3] ? iniUnsafe(m[4]) : "true", top: !section });
  });
  return out;
}

/** Keys an `.npmrc` sets that let other bytes in, or run code, said when a commit adds them. @type {Record<string, (value: string) => string | null>} */
const SAID_KEYS = {
  "replace-registry-host": (v) => (["npmjs", "never"].includes(v) ? null : "replaceHost"),
  proxy: (v) => (v && v !== "false" && v !== "null" ? "proxy" : null),
  "https-proxy": (v) => (v && v !== "false" && v !== "null" ? "proxy" : null),
  "http-proxy": (v) => (v && v !== "false" && v !== "null" ? "proxy" : null),
  "strict-ssl": (v) => (v === "false" ? "tls" : null),
  ca: () => "tls",
  cafile: () => "tls",
  "script-shell": () => "runsCode",
  "node-options": () => "runsCode",
  git: () => "runsCode",
  shell: () => "runsCode",
  "ignore-scripts": (v) => (v === "false" ? "scriptsOn" : null),
};

/** Keys that make npm read another config file, which the check does not read: a project has no use for them. */
const INDIRECT_KEYS = new Set(["userconfig", "globalconfig", "prefix"]);

/**
 * The lines of an `.npmrc` that change where npm fetches packages from, which config it reads, or what it runs.
 * `refuse` (`kind`): a `registry` or `<scope>:registry` (any spelling npm reads as one) whose URL, parsed as npm
 * parses it, is not one `registries` lists (its origin and its path, a trailing slash aside: another path on a
 * listed origin is another registry, npmjs answers `/@x/<name>` with the scoped package); `userconfig`,
 * `globalconfig` and `prefix` (`indirect`: npm would read a file the check does not). `said`: a key or value read
 * from the environment (`${…}`), a registry value that is no URL, the keys in SAID_KEYS, and `cache` beside
 * `offline` or `prefer-offline` (a cache committed with the project would be what npm installs).
 * @param {string} text @param {DepsRule} rule
 */
export function npmrcFindings(text, rule) {
  /** @type {{ n: number, line: string, kind: "registry" | "indirect" }[]} */
  const refuse = [];
  /** @type {{ n: number, line: string, reason: Reason }[]} */
  const said = [];
  const entries = npmrcEntries(text).filter((x) => x.top);
  const listed = Object.keys(rule.registries);
  for (const { n, line, key: raw, value } of entries) {
    if (raw.includes("${")) {
      said.push({ n, line, reason: { key: "fromEnvKey" } });
      continue;
    }
    const key = raw.toLowerCase();
    if (INDIRECT_KEYS.has(key)) {
      refuse.push({ n, line, kind: "indirect" });
      continue;
    }
    if (key === "registry" || key.endsWith(":registry")) {
      if (value.includes("${")) {
        said.push({ n, line, reason: { key: "fromEnv" } });
        continue;
      }
      let url;
      try {
        url = new URL(value);
      } catch {
        said.push({ n, line, reason: { key: "notUrl" } });
        continue;
      }
      if (url.origin === "null" || url.search || url.hash || !listed.includes(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)) refuse.push({ n, line, kind: "registry" });
      continue;
    }
    const why = Object.hasOwn(SAID_KEYS, key) ? SAID_KEYS[key](value) : null;
    if (why) said.push({ n, line, reason: { key: why } });
  }
  const offline = entries.some((x) => ["offline", "prefer-offline"].includes(x.key.toLowerCase()) && x.value === "true");
  for (const x of entries) if (offline && x.key.toLowerCase() === "cache") said.push({ n: x.n, line: x.line, reason: { key: "offlineCache" } });
  return { refuse, said };
}

/** A threshold as a plain percent: no exponent, no noise of binary fractions (0.07 × 100 is 7.000000000000001). @param {number} share */
export const thresholdPercent = (share) => Number((share * 100).toPrecision(12)).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });

/**
 * weekly / total as a percent, floored, with as many decimals as the threshold needs (at least two), from the
 * counts themselves: a value under the threshold never prints as it.
 * @param {number} weekly @param {number} total @param {number} threshold
 */
function percent(weekly, total, threshold) {
  const d = Math.max(2, (thresholdPercent(threshold).split(".")[1] ?? "").length);
  if (!total) return `${(0).toFixed(d)}%`;
  const scaled = (BigInt(weekly) * 100n * 10n ** BigInt(d)) / BigInt(total);
  const digits = scaled.toString().padStart(d + 1, "0");
  return `${digits.slice(0, -d)}.${digits.slice(-d)}%`;
}

/** The first three of a list as "name@version (detail)", sorted, and how many more. */
function places(/** @type {{ entry: LockEntry }[]} */ list, /** @type {(x: any) => string} */ detail, /** @type {string} */ lang) {
  const sorted = [...list].sort((a, b) => byIdentity(a.entry, b.entry));
  const shown = sorted.slice(0, 3).map((x) => `${idOf(x.entry)}${detail(x) ? ` (${detail(x)})` : ""}`);
  return list.length > 3 ? [...shown, t("deps.more", { n: list.length - 3 }, lang)] : shown;
}

/** The message key for what was not measured. */
const UNREAD_KEYS = { all: "deps.unread", age: "deps.unreadAge", adoption: "deps.unreadAdoption" };

/**
 * The hook's errors and warnings for the lock files and `.npmrc` files a commit stages (`versions` from
 * stagedVersions; the caller passes only the `.npmrc` files npm reads), in path order: per file, one error per
 * rule its new entries (or new lines) break, the first three places; what was not checked is a warning. A file
 * the commit deletes is skipped. A HEAD version that cannot be read is said, and every entry (or line) then
 * counts as new. One time budget, and one answer meter, for every request of the commit. Values from the files
 * are shown as one line each (tShown).
 * @param {Map<string, import("../core/git.mjs").StagedVersion>} versions
 * @param {DepsRule} rule
 * @param {string} lang
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ errors: string[], warnings: string[] }>}
 */
export async function depsMessages(versions, rule, lang, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const signal = AbortSignal.timeout(rule.timeout * 1000);
  const meter = { held: 0 };
  const said = (/** @type {string} */ path, /** @type {Reason} */ reason) => warnings.push(tShown("deps.lockUnread", { path: [path], reason: reasonText(reason, lang) }, lang));
  for (const [path, v] of [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v.unread) {
      said(path, { key: v.unread });
      continue;
    }
    if (!v.staged) continue;
    const text = lockText(v.staged);
    if (text === null) {
      said(path, { key: "notText" });
      continue;
    }
    const before = v.head ? lockText(v.head) : null;
    /** HEAD has a version that cannot be read: said, and everything staged counts as new. @type {Reason | null} */
    let lost = v.headUnread ? { key: v.headUnread } : v.head && before === null ? { key: "notText" } : null;
    if (npmrcPath(path)) {
      if (lost) warnings.push(tShown("deps.baselineUnread", { path: [path], reason: reasonText(lost, lang) }, lang));
      const had = before === null ? { refuse: [], said: [] } : npmrcFindings(before, rule);
      const current = npmrcFindings(text, rule);
      const fresh = (/** @type {{ line: string }[]} */ list, /** @type {{ line: string }[]} */ old) => list.filter((x) => !old.some((o) => o.line === x.line));
      const refuse = /** @type {{ n: number, line: string, kind: "registry" | "indirect" }[]} */ (fresh(current.refuse, had.refuse));
      for (const [kind, key] of [["registry", "deps.npmrc"], ["indirect", "deps.npmrcIndirect"]]) {
        const lines = refuse.filter((r) => r.kind === kind);
        if (lines.length) errors.push(tShown(key, { path: [path], where: lines.slice(0, 3).map((r) => `${r.n}: ${r.line}`) }, lang));
      }
      for (const s of /** @type {{ n: number, line: string, reason: Reason }[]} */ (fresh(current.said, had.said))) warnings.push(tShown("deps.npmrcSaid", { path: [path], where: [`${s.n}: ${s.line}`], why: reasonText(s.reason, lang) }, lang));
      continue;
    }
    const staged = lockEntries(text);
    if (staged.unread !== undefined) {
      said(path, staged.unread);
      continue;
    }
    if (staged.v1) warnings.push(tShown("deps.v1", { path: [path] }, lang));
    const headLock = before === null ? null : lockEntries(before);
    if (!lost && headLock?.unread) lost = headLock.unread;
    if (lost) warnings.push(tShown("deps.baselineUnread", { path: [path], reason: reasonText(lost, lang) }, lang));
    const fresh = newEntries(staged.entries, lost ? [] : (headLock?.entries ?? []));
    const scripts = fresh.filter((e) => e.scripts && !scriptsAllowed(e, rule));
    if (scripts.length) errors.push(tShown("deps.scripts", { path: [path], n: scripts.length, where: places(scripts.map((entry) => ({ entry })), () => "", lang) }, lang));
    // From the lock alone, online or not: npm installs the tarball `resolved` names, checked by its integrity.
    /** @type {{ entry: LockEntry, reason: Reason }[]} */
    const mismatched = [];
    /** @type {LockEntry[]} */
    const listed = [];
    /** @type {{ entry: LockEntry, reason: Reason, part: "all" | "age" | "adoption" }[]} */
    let unread = [];
    for (const entry of fresh) {
      const where = registryOf(entry, rule);
      if ("origin" in where) listed.push(entry);
      else if (where.refuse) mismatched.push({ entry, reason: where.reason });
      else unread.push({ entry, reason: where.reason, part: "all" });
    }
    if (mismatched.length) errors.push(tShown("deps.mismatch", { path: [path], n: mismatched.length, where: places(mismatched, (m) => reasonText(m.reason, lang), lang) }, lang));
    const unsealed = listed.filter((e) => !digests(e.integrity).length);
    if (unsealed.length) errors.push(tShown("deps.integrity", { path: [path], n: unsealed.length, where: places(unsealed.map((entry) => ({ entry })), () => "", lang) }, lang));
    const twice = listed.filter((e) => doubled(e.integrity));
    if (twice.length) errors.push(tShown("deps.integrityDouble", { path: [path], n: twice.length, where: places(twice.map((entry) => ({ entry })), () => "", lang) }, lang));
    const weak = listed.filter((e) => digests(e.integrity).length && !digests(e.integrity).some((d) => d.algo === "sha512"));
    if (weak.length) warnings.push(tShown("deps.integrityWeak", { path: [path], n: weak.length, where: places(weak.map((entry) => ({ entry })), () => "", lang) }, lang));
    const asked = listed.filter((e) => digests(e.integrity).length && !doubled(e.integrity));
    if (asked.length && !rule.online) warnings.push(tShown("deps.offline", { path: [path], n: asked.length }, lang));
    else if (asked.length) {
      const r = await registryVerdicts(asked, rule, { now, signal, meter });
      if (r.tampered.length) errors.push(tShown("deps.tampered", { path: [path], n: r.tampered.length, where: places(r.tampered, () => "", lang) }, lang));
      if (r.hiddenScripts.length) errors.push(tShown("deps.hiddenScripts", { path: [path], n: r.hiddenScripts.length, where: places(r.hiddenScripts, () => "", lang) }, lang));
      // Floored: a version 6.96 days old shows 6.9, under the 7 it is younger than.
      if (r.young.length) errors.push(tShown("deps.young", { path: [path], n: r.young.length, days: rule.cooldownDays, where: places(r.young, (y) => t("deps.daysOld", { n: `${Math.floor(y.tenths / 10)}.${y.tenths % 10}` }, lang), lang) }, lang));
      if (r.unadopted.length) errors.push(tShown("deps.unadopted", { path: [path], n: r.unadopted.length, share: `${thresholdPercent(rule.minShare)}%`, weekly: rule.minWeekly, where: places(r.unadopted, (u) => `${percent(u.weekly, u.total, rule.minShare)}; ${u.weekly}`, lang) }, lang));
      unread = [...unread, ...r.unread];
    }
    /** @type {Map<string, { entry: LockEntry }[]>} */
    const groups = new Map();
    for (const u of unread) {
      const k = `${u.part}\0${reasonText(u.reason, lang)}`;
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    for (const [k, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [part, reason] = /** @type {["all" | "age" | "adoption", string]} */ (k.split("\0"));
      warnings.push(tShown(UNREAD_KEYS[part], { path: [path], n: list.length, reason, where: places(list, () => "", lang) }, lang));
    }
  }
  return { errors, warnings };
}

/**
 * Known advisories of the given entries, from OSV (`advisories`: its API origin): one querybatch call per
 * 1,000 name@versions, then each advisory's own record (a withdrawn one is dropped). What leaves the machine is
 * the name and version of entries from the public registries `advisoryRegistries` names whose `resolved` proves
 * them; a project's private registry, even one `registries` lists, is never named to OSV. A bundled entry is
 * not asked about: the lock cannot prove which version its parent's tarball holds, so it is said. Each advisory
 * names every entry that holds the version.
 * @param {(LockEntry & { path?: string })[]} entries
 * @param {DepsRule} rule
 * @returns {Promise<{ advisories: Advisory[], unread: { entry: (LockEntry & { path?: string }) | null, reason: Reason }[] }>}
 * @typedef {{ id: string, summary: string, severity: string, aliases: string[], entries: (LockEntry & { path?: string })[], unread?: Reason }} Advisory
 *   `unread`: why the advisory's own record could not be read (its id still counts)
 */
export async function advisoriesOf(entries, rule) {
  /** @type {{ entry: (LockEntry & { path?: string }) | null, reason: Reason }[]} */
  const unread = [];
  if (!entries.length) return { advisories: [], unread };
  if (!rule.advisories) return { advisories: [], unread: [{ entry: null, reason: { key: "advisoriesOff" } }] };
  const signal = AbortSignal.timeout(rule.timeout * 1000);
  const meter = { held: 0 };
  /** @type {Map<string, (LockEntry & { path?: string })[]>} */
  const asked = new Map();
  for (const e of entries) {
    const where = e.bundled ? { reason: { key: "bundledUnproven" } } : registryOf(e, rule);
    if ("reason" in where) unread.push({ entry: e, reason: where.reason });
    else if (!rule.advisoryRegistries.includes(where.registry)) unread.push({ entry: e, reason: { key: "private", vars: { registry: where.registry } } });
    else asked.set(idOf(e), [...(asked.get(idOf(e)) ?? []), e]);
  }
  const list = [...asked.keys()];
  /** @type {Map<string, (LockEntry & { path?: string })[]>} */
  const byId = new Map();
  for (let at = 0; at < list.length; at += 1000) {
    const batch = list.slice(at, at + 1000).map((id) => /** @type {LockEntry[]} */ (asked.get(id)));
    /** @type {unknown} */
    let res;
    try {
      res = await fetchJson(`${rule.advisories}/v1/querybatch`, signal, meter, { queries: batch.map(([e]) => ({ package: { name: e.name, ecosystem: "npm" }, version: e.version })) });
      const results = own(res, "results");
      if (!Array.isArray(results) || results.length !== batch.length) throw fail({ key: "countMismatch" });
    } catch (e) {
      for (const holders of batch) for (const entry of holders) unread.push({ entry, reason: failure(e, rule.timeout) });
      continue;
    }
    const results = /** @type {unknown[]} */ (own(res, "results"));
    batch.forEach((holders, i) => {
      // More advisories than one page holds: the rest would need the token, and are not asked for.
      if (own(results[i], "next_page_token")) for (const entry of holders) unread.push({ entry, reason: { key: "paged" } });
      const vulns = own(results[i], "vulns");
      for (const v of Array.isArray(vulns) ? vulns : []) {
        const id = own(v, "id");
        if (typeof id === "string") byId.set(id, [...(byId.get(id) ?? []), ...holders]);
      }
    });
  }
  /** @type {Advisory[]} */
  const advisories = [];
  await pool(
    [...byId].map(([id, hit]) => async () => {
      /** @type {unknown} */
      let doc;
      try {
        doc = await fetchJson(`${rule.advisories}/v1/vulns/${encodeURIComponent(id)}`, signal, meter);
      } catch (e) {
        // Known by its id even without its record: an advisory, not an unread entry.
        advisories.push({ id, summary: "", severity: "", aliases: [], entries: hit, unread: failure(e, rule.timeout) });
        return;
      }
      if (own(doc, "withdrawn")) return;
      const level = own(own(doc, "database_specific"), "severity");
      const scores = own(doc, "severity");
      const score = Array.isArray(scores) ? own(scores[0], "score") : undefined;
      const summary = own(doc, "summary");
      const aliases = own(doc, "aliases");
      advisories.push({
        id,
        summary: typeof summary === "string" ? summary : "",
        severity: typeof level === "string" ? level : typeof score === "string" ? score : "",
        aliases: Array.isArray(aliases) ? aliases.filter((a) => typeof a === "string") : [],
        entries: hit,
      });
    }),
    8,
  );
  advisories.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { advisories, unread };
}
