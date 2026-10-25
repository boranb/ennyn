/**
 * File presence that never reads a failure as "not there". existsSync answers false for a file it cannot
 * look at (no search permission on its directory): a config then read as "none, defaults apply", a work
 * graph as "not found", a test as missing. test/fault-injection.test.mjs fails every file read in turn.
 */

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Nothing there: ENOENT; ENOTDIR (a file where one of the path's directories should be); ELOOP (a link
 * that leads back to itself names no file); ENAMETOOLONG (no file has such a name).
 * @param {unknown} err
 */
export function gone(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG";
}

/**
 * Whether something is at `path`. false only when nothing is (ENOENT, ENOTDIR); a path that cannot be
 * looked at throws. Not statSync's throwIfNoEntry: on Node 20.0 it hides ENOENT only.
 * @param {string} path
 */
export function present(path) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (gone(err)) return false;
    throw err;
  }
}

/** The most of a project file read: past it the file is no text a scan or a check reads whole. */
export const READ_LIMIT = 16 * 1024 * 1024;

/** The device /dev/null is, once looked up: a project file linked to it reads as empty, as Claude Code reads it. */
let devNull = /** @type {bigint | null | undefined} */ (undefined);
const isDevNull = (/** @type {import("node:fs").BigIntStats} */ st) => {
  if (devNull === undefined) {
    try {
      devNull = statSync("/dev/null", { bigint: true }).rdev;
    } catch {
      devNull = null;
    }
  }
  return st.isCharacterDevice() && devNull !== null && st.rdev === devNull;
};

/**
 * A file's text, or null when nothing is there; a file that is there but cannot be read throws, naming the
 * path (Node's EISDIR message names none). A file found in the project is read only when it is a regular file
 * (/dev/null reads as empty): it is looked at before it is opened, so a pipe is never opened (opening one would
 * wait for a writer) and a device never read, and the open descriptor is looked at again; a directory throws
 * EISDIR, a pipe, socket or other device ENOTREG, a file past `limit` bytes EFBIG unless `head` asks for its first
 * `limit` bytes. A path the user named (`given`: ENNYN_CONFIG) is read as it is, whatever it is: a process
 * substitution, /dev/stdin.
 * @param {string} path
 * @param {{ limit?: number, head?: boolean, given?: boolean }} [opts]
 * @returns {string | null}
 */
export function readIfThere(path, { limit = READ_LIMIT, head = false, given = false } = {}) {
  /** @param {unknown} err */
  const named = (err) => {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    e.message = `${path} could not be read: ${e.message}`;
    return e;
  };
  /** @param {string} code @param {string} text */
  const refused = (code, text) => named(Object.assign(new Error(`${code}: ${text}`), { code }));
  if (given) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if (gone(err)) return null;
      throw named(err);
    }
  }
  let st;
  try {
    st = statSync(path, { bigint: true });
  } catch (err) {
    if (gone(err)) return null;
    throw named(err);
  }
  if (st.isDirectory()) throw refused("EISDIR", "illegal operation on a directory");
  if (isDevNull(st)) return "";
  if (!st.isFile()) throw refused("ENOTREG", "not a regular file (a pipe, a socket or a device)");
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if (gone(err)) return null;
    throw named(err);
  }
  try {
    // Looked at again through the descriptor: what was checked is what is read.
    if (!fstatSync(fd).isFile()) throw refused("ENOTREG", "not a regular file (a pipe, a socket or a device)");
    /** @type {Buffer[]} */
    const parts = [];
    let total = 0;
    // Read to the end, not to the size the file had: it may grow while read, and past the limit it is refused.
    for (;;) {
      const part = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const n = readSync(fd, part, 0, part.length, null);
      if (n === 0) break;
      parts.push(part.subarray(0, n));
      total += n;
      if (total > limit) {
        if (head) break;
        throw refused("EFBIG", `larger than ${limit % (1024 * 1024) ? `${limit} bytes` : `${limit / 1024 / 1024} MB`}`);
      }
    }
    const bytes = Buffer.concat(parts);
    return (head ? bytes.subarray(0, limit) : bytes).toString("utf8");
  } catch (err) {
    if (/** @type {Error} */ (err).message.startsWith(`${path} could not be read: `)) throw err;
    throw named(err);
  } finally {
    closeSync(fd);
  }
}

/**
 * Where a file that must be a regular one stands: when `path` lies inside `root` by its own spelling, no component
 * below `root` may be a symbolic link (each looked at with lstat; a component not there yet is not there, and
 * neither is anything below it). Outside `root` the path is the configuration's choice and links there are
 * followed. Either way the file is opened without blocking (a FIFO or a device holds no command) and its
 * descriptor must be a regular file.
 * @param {string} root the repository's top directory
 * @param {string} path absolute
 * @param {string} what "could not be read" or "was not written", the start of a refusal
 * @returns {{ inside: boolean }}
 */
function noLinkBelow(root, path, what) {
  const rel = relative(root, path);
  if (rel.split(sep)[0] === ".." || isAbsolute(rel)) return { inside: false };
  const parts = rel === "" ? [] : rel.split(sep);
  for (let i = 1; i < parts.length; i++) {
    const at = join(root, ...parts.slice(0, i));
    let st;
    try {
      st = lstatSync(at);
    } catch (e) {
      if (gone(e)) return { inside: true };
      throw new Error(`${path} ${what}: ${/** @type {Error} */ (e).message}`);
    }
    if (st.isSymbolicLink()) throw new Error(`${path} ${what}: ${parts.slice(0, i).join("/")} is a symbolic link`);
  }
  return { inside: true };
}

/** Opens `path` as noLinkBelow allows; null when nothing is there and `create` is not set. @param {string} root @param {string} path @param {number} flags @param {string} what */
function openRegular(root, path, flags, what) {
  const { inside } = noLinkBelow(root, path, what);
  const rel = relative(root, path).split(sep).join("/");
  let fd;
  try {
    fd = openSync(path, flags | (constants.O_NONBLOCK ?? 0) | (inside ? constants.O_NOFOLLOW ?? 0 : 0), 0o644);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    // O_NOFOLLOW meets a link as ELOOP (EMLINK on some BSDs): the last component is one.
    if (inside && (err.code === "ELOOP" || err.code === "EMLINK")) throw new Error(`${path} ${what}: ${rel} is a symbolic link`);
    if (gone(err)) return null;
    throw new Error(`${path} ${what}: ${err.message}`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} ${what}: it is no regular file`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * A file's bytes, read only as a regular file (see noLinkBelow); null when nothing is there. A link inside
 * `root`, a FIFO, a device or a directory is refused, naming the path: "could not be read: …".
 * @param {string} root @param {string} path absolute
 * @returns {Buffer | null}
 */
export function readRegular(root, path) {
  const fd = openRegular(root, path, constants.O_RDONLY, "could not be read");
  if (fd === null) return null;
  try {
    return readFileSync(fd);
  } catch (e) {
    throw new Error(`${path} could not be read: ${/** @type {Error} */ (e).message}`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Rewrites or appends to a file only as a regular file (see noLinkBelow), creating it and its directories when
 * they are not there: `edit` gets the text it holds ("" for a new file) and returns the text to write in its
 * place, or `{ append }`. Everything goes through the one descriptor that was checked. A refusal writes nothing:
 * "was not written: …".
 * @param {string} root @param {string} path absolute
 * @param {(text: string) => { replace: string } | { append: string }} edit
 */
export function writeRegular(root, path, edit) {
  noLinkBelow(root, path, "was not written");
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw new Error(`${path} was not written: ${/** @type {Error} */ (e).message}`);
  }
  const fd = /** @type {number} */ (openRegular(root, path, constants.O_RDWR | constants.O_CREAT, "was not written"));
  try {
    const text = readFileSync(fd, "utf8");
    const change = edit(text);
    if ("replace" in change) {
      ftruncateSync(fd, 0);
      writeSync(fd, change.replace, 0);
    } else writeSync(fd, change.append, Buffer.byteLength(text));
  } finally {
    closeSync(fd);
  }
}
