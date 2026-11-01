/**
 * File presence that never reads a failure as "not there". existsSync answers false for a file it cannot
 * look at (no search permission on its directory): a config then read as "none, defaults apply", a work
 * graph as "not found", a test as missing. test/fault-injection.test.mjs fails every file read in turn.
 */

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
 * looked at throws. Not statSync's throwIfNoEntry: on Node 20.0 it hides ENOENT only. `look`: lstatSync counts a link
 * with nothing behind it.
 * @param {string} path @param {(path: string) => unknown} [look]
 */
export function present(path, look = statSync) {
  try {
    look(path);
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

/** What a read past `limit` says. @param {number} limit */
const tooLarge = (limit) => `larger than ${limit % (1024 * 1024) ? `${limit} bytes` : `${limit / 1024 / 1024} MB`}`;

/**
 * The bytes of `fd` from where it stands, to its end and not to the size the file had: it may grow while read. It
 * stops at `limit` bytes and one more, so a result longer than `limit` is a file past it.
 * @param {number} fd @param {number} limit
 * @returns {Buffer}
 */
function readUpTo(fd, limit) {
  /** @type {Buffer[]} */
  const parts = [];
  let total = 0;
  while (total <= limit) {
    const part = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const n = readSync(fd, part, 0, part.length, null);
    if (n === 0) break;
    parts.push(part.subarray(0, n));
    total += n;
  }
  return Buffer.concat(parts);
}

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
    const bytes = readUpTo(fd, limit);
    if (bytes.length > limit && !head) throw refused("EFBIG", tooLarge(limit));
    return (head ? bytes.subarray(0, limit) : bytes).toString("utf8");
  } catch (err) {
    if (/** @type {Error} */ (err).message.startsWith(`${path} could not be read: `)) throw err;
    throw named(err);
  } finally {
    closeSync(fd);
  }
}

/**
 * Where a file Ennyn reads or writes in the project stands: below `root` by its own spelling, and no component
 * below `root` a symbolic link (each looked at with lstat; a component not there yet is not there, and neither is
 * anything below it). A commit can hold a link, and it may lead anywhere. The last component is left to the
 * open (O_NOFOLLOW), which also does not block (a FIFO or a device holds no command); its descriptor must be a
 * regular file.
 * @param {string} root the project directory, or the git dir for a file in it
 * @param {string} path absolute
 * @param {string} what "could not be read" or "was not written", the start of a refusal
 * @param {{ last?: boolean }} [opts] `last`: the final component is looked at here too
 */
function noLinkBelow(root, path, what, { last = false } = {}) {
  if (leavesRoot(root, path)) throw new Error(`${path} ${what}: it lies outside ${root}`);
  let found;
  try {
    found = linkBelow(root, path, { last });
  } catch (e) {
    throw new Error(`${path} ${what}: ${/** @type {Error} */ (e).message}`);
  }
  if (found) throw new Error(`${path} ${what}: ${found} is a symbolic link`);
}

/** Whether `path` lies outside `root` by its spelling. @param {string} root @param {string} path */
export const leavesRoot = (root, path) => {
  const rel = relative(root, path);
  return rel.split(sep)[0] === ".." || isAbsolute(rel);
};

/**
 * The first component of `path` below `root` that is a symbolic link, as `a/b`; null when there is none, or when
 * `path` lies outside `root` by its spelling. Each component is looked at with lstat; one not there yet is not
 * there, and neither is anything below it. A component that cannot be looked at throws.
 * @param {string} root @param {string} path absolute
 * @param {{ last?: boolean }} [opts] `last: false` leaves the final component to the caller (an O_NOFOLLOW open)
 * @returns {string | null}
 */
export function linkBelow(root, path, { last = true } = {}) {
  if (leavesRoot(root, path)) return null;
  const rel = relative(root, path);
  const parts = rel === "" ? [] : rel.split(sep);
  for (let i = 1; i <= parts.length - (last ? 0 : 1); i++) {
    let st;
    try {
      st = lstatSync(join(root, ...parts.slice(0, i)));
    } catch (e) {
      if (gone(e)) return null;
      throw e;
    }
    if (st.isSymbolicLink()) return parts.slice(0, i).join("/");
  }
  return null;
}

/**
 * Opens `path` as noLinkBelow allows; null when nothing is there and `create` is not set. The last component is
 * looked at with lstat too: where O_NOFOLLOW is missing (Windows) that look is all, a window until the open.
 * @param {string} root @param {string} path @param {number} flags @param {string} what
 */
function openRegular(root, path, flags, what) {
  noLinkBelow(root, path, what, { last: true });
  const rel = relative(root, path).split(sep).join("/");
  let fd;
  try {
    fd = openSync(path, flags | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    // O_NOFOLLOW meets a link as ELOOP (EMLINK on some BSDs): the last component is one.
    if (err.code === "ELOOP" || err.code === "EMLINK") throw new Error(`${path} ${what}: ${rel} is a symbolic link`);
    if (gone(err)) return null;
    throw Object.assign(new Error(`${path} ${what}: ${err.message}`), { code: err.code });
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
 * A file's bytes, read only as a regular file below `root` (see noLinkBelow); null when nothing is there. A path
 * outside `root`, a link below it, a FIFO, a device or a directory is refused, naming the path: "could not be read: …",
 * and so is a file past `limit` bytes when one is given (code EFBIG).
 * @param {string} root @param {string} path absolute
 * @param {{ limit?: number }} [opts]
 * @returns {Buffer | null}
 */
export function readRegular(root, path, { limit } = {}) {
  const fd = openRegular(root, path, constants.O_RDONLY, "could not be read");
  if (fd === null) return null;
  try {
    if (limit === undefined) return readFileSync(fd);
    const bytes = readUpTo(fd, limit);
    if (bytes.length > limit) throw Object.assign(new Error(`EFBIG: ${tooLarge(limit)}`), { code: "EFBIG" });
    return bytes;
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    throw Object.assign(new Error(`${path} could not be read: ${err.message}`), { code: err.code });
  } finally {
    closeSync(fd);
  }
}

/**
 * The last `limit` bytes of a regular file below `root` (see noLinkBelow) and the size it had, however large it is;
 * null when nothing is there. A file that grows while it is read is read up to the size it had.
 * @param {string} root @param {string} path absolute @param {number} limit
 * @returns {{ bytes: Buffer, size: number } | null}
 */
export function readTail(root, path, limit) {
  const fd = openRegular(root, path, constants.O_RDONLY, "could not be read");
  if (fd === null) return null;
  try {
    const { size } = fstatSync(fd);
    const bytes = Buffer.allocUnsafe(Math.min(size, limit));
    let done = 0;
    while (done < bytes.length) {
      const n = readSync(fd, bytes, done, bytes.length - done, size - bytes.length + done);
      if (n === 0) break;
      done += n;
    }
    return { bytes: bytes.subarray(0, done), size };
  } catch (e) {
    throw new Error(`${path} could not be read: ${/** @type {Error} */ (e).message}`);
  } finally {
    closeSync(fd);
  }
}

/** Makes the directories of `path` below `root`, once no link stands among them. @param {string} root @param {string} path */
function parents(root, path) {
  noLinkBelow(root, path, "was not written");
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw new Error(`${path} was not written: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Writes all of `bytes` through `fd` at its offset: a write that stops short (a full disk, a file size limit) goes
 * on from where it stopped, so the failure that follows is thrown, never a line cut short and said to be written.
 * The error carries `written`, the bytes that went in before it.
 * @param {number} fd @param {string} path named in the error @param {Buffer} bytes
 */
function writeAll(fd, path, bytes) {
  let done = 0;
  try {
    while (done < bytes.length) {
      const n = writeSync(fd, bytes, done, bytes.length - done, null);
      if (n === 0) throw new Error("the file took no more bytes");
      done += n;
    }
  } catch (e) {
    throw Object.assign(new Error(`${path} was not written: ${/** @type {Error} */ (e).message}`), { written: done });
  }
}

/**
 * Writes a file of Ennyn's own below `root` (the project directory, or the git dir for a state dir under .git): no
 * link from `root` to the file, a regular file only (see openRegular), its directories made. `append` adds `text`
 * in one write at the end (two processes append whole lines), closing a last line cut short first; with `sole`
 * (this process alone writes the file: the metrics log) one that fails is cut off again, so the file is as it
 * was; without it what a failed append put in stays, a line cut short that the next append closes, since cutting
 * could erase a line another process appended in between (two worktrees share a state dir); `replace`
 * writes a new file whole and renames it over the old one, so a write that fails leaves the old one as it was (a
 * temporary name that is already there, a link planted at it too, is removed, never followed; one the failed write
 * left is removed); `create` makes it only when nothing is there, and throws with code EEXIST otherwise.
 * @param {string} root @param {string} path absolute @param {string} text
 * @param {"append" | "replace" | "create"} how
 * @param {{ sole?: boolean }} [opts]
 */
export function writeState(root, path, text, how, { sole = false } = {}) {
  parents(root, path);
  if (how === "replace") {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      rmSync(tmp, { force: true });
    } catch (e) {
      throw new Error(`${path} was not written: ${tmp} could not be removed: ${/** @type {Error} */ (e).message}`);
    }
    try {
      writeState(root, tmp, text, "create");
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return;
  }
  const flags = how === "create" ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
  const fd = /** @type {number} */ (openRegular(root, path, flags, "was not written"));
  try {
    let size = 0;
    let torn = false;
    if (how === "append") {
      size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    }
    try {
      writeAll(fd, path, Buffer.from((torn ? "\n" : "") + text, "utf8"));
    } catch (e) {
      // What the append put in before it failed goes again, when this process alone writes the file and it ends so.
      const written = /** @type {{ written?: number }} */ (e).written ?? 0;
      if (sole && how === "append" && written > 0 && fstatSync(fd).size === size + written) ftruncateSync(fd, size);
      throw e;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `text` to a log of Ennyn's own below `root`; past `max` bytes the file is cut to its newer half, from the
 * start of a line. Two processes that cut at once may lose a line, which a log can bear.
 * @param {string} root @param {string} path absolute @param {string} text @param {number} max
 */
export function appendBounded(root, path, text, max) {
  writeState(root, path, text, "append");
  if ((readTail(root, path, 0)?.size ?? 0) <= max) return;
  const newer = readTail(root, path, Math.floor(max / 2));
  if (newer) writeState(root, path, newer.bytes.subarray(newer.bytes.indexOf(0x0a) + 1).toString("utf8"), "replace");
}

/**
 * Removes a file of Ennyn's state below `root`: no link may stand among its directories (the file itself, a link
 * or not, is what goes). Nothing there is no error.
 * @param {string} root @param {string} path absolute
 */
export function removeState(root, path) {
  noLinkBelow(root, path, "was not removed");
  rmSync(path, { force: true });
}

/**
 * The names in a directory of Ennyn's state below `root`, no link from `root` to it; [] when it is not there.
 * @param {string} root @param {string} dir absolute
 * @returns {string[]}
 */
export function listState(root, dir) {
  noLinkBelow(root, dir, "could not be read", { last: true });
  try {
    return readdirSync(dir);
  } catch (e) {
    if (gone(e)) return [];
    throw e;
  }
}
