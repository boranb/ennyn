/**
 * What Ennyn's code wrote into a repository, and how it comes out again. install-hook records each file it writes
 * (path and sha256) in the state dir; uninstall-hook removes a recorded file only while it is still the bytes the
 * record names, removes the state dir, and lists what stays for the user to decide.
 *
 * Only code writes can be recorded by code. Init's code writes nothing in the repository: the agent writes the
 * config, the graph, the handoff and the ask rules in `.claude/settings.json` by following skills/init/SKILL.md, so
 * those are listed, never removed, and the list says there is no record of them. The plugin's version record
 * (`<plugin data>/root`) is no file of this repository: every repository whose hook follows the plugin reads it, a
 * SessionStart hook writes it again each session, and `claude plugin uninstall` deletes it; it is named, not recorded.
 *
 * Origin: a write outside what the user asked for needs an easy way back, and deletion permission comes from the
 * record, never from a familiar file name (review of agent-reach, 2026-10-28).
 */

import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gone, readRegular, writeState } from "../core/files.mjs";
import { commonDir, resolveStateDir, stateRoot, underGitDir } from "../core/git.mjs";
import { BLOCK_END, BLOCK_MARKER, PLUGIN_RECORD, hookStatus, namesCheck } from "./hook.mjs";
import { GH_COMMANDS, OFFERED, SETTINGS, TOOLS, readSettings, ruleFor } from "./permissions.mjs";
import { projectFiles } from "./scan.mjs";

/** The record's name in the state dir. */
export const WRITTEN = "written.json";

/** A record larger than this is no record install-hook wrote: read as none, so nothing is removed on its word. */
const WRITTEN_LIMIT = 64 * 1024;

/** @param {Buffer | string} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A file's place as the record keeps it: its directory's real path and its own name, so `/var` and `/private/var`,
 * or a worktree's spelling and the main checkout's, name one file; the file itself is never followed. A directory
 * that is not there keeps the spelling git gave, a real path.
 * @param {string} path absolute
 */
function placeOf(path) {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch (err) {
    if (gone(err)) return path;
    throw err;
  }
}

/** @param {string} cwd @param {string} stateDir config `paths.stateDir` */
export const writtenPath = (cwd, stateDir) => join(resolveStateDir(cwd, stateDir), WRITTEN);

/**
 * The record's entries; [] when there is none, or it is not the shape this module writes (nothing is removed on its
 * word). A record that is there and cannot be read throws.
 * @param {string} cwd @param {string} path absolute (writtenPath)
 * @returns {{ path: string, sha256: string, by: string }[]}
 */
export function readWritten(cwd, path) {
  let bytes;
  try {
    bytes = readRegular(stateRoot(cwd, path), path, { limit: WRITTEN_LIMIT });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "EFBIG") return [];
    throw err;
  }
  if (bytes === null) return [];
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  const files = json?.files;
  if (!Array.isArray(files)) return [];
  const valid = files.filter((f) => f && typeof f.path === "string" && typeof f.by === "string" && typeof f.sha256 === "string");
  // One entry a path, the last standing, as recordWrite keeps them: a path named twice is read once.
  return [...new Map(valid.map((f) => [f.path, f])).values()];
}

/**
 * Records that `by` wrote the file at `path` as it is now: its entry replaced, the others kept.
 * @param {string} cwd @param {string} record absolute (writtenPath) @param {string} path absolute @param {string} by
 */
export function recordWrite(cwd, record, path, by) {
  const at = placeOf(path);
  const files = readWritten(cwd, record).filter((f) => f.path !== at);
  files.push({ path: at, sha256: sha256(readFileSync(path)), by });
  writeState(stateRoot(cwd, record), record, `${JSON.stringify({ files }, null, 2)}\n`, "replace");
}

/**
 * Whether uninstall-hook may remove the state dir `stateDir` names: a folder named `ennyn` directly under the git dir,
 * or one below it. Any other value (`.git` itself, `.git/hooks`, `.git/objects`) holds git's own files.
 * @param {string} stateDir
 */
export function ownStateDir(stateDir) {
  const rest = underGitDir(stateDir);
  return rest !== null && rest.split("/")[1] === "ennyn";
}

/**
 * The lines of a project's own hook that call commit-check: install-hook's block from its first line to its last
 * (1-based, inclusive), else each line that names commit-check.
 * @param {string} text
 * @returns {{ from: number, to: number }[]}
 */
export function checkLines(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(BLOCK_MARKER));
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith(BLOCK_END));
  if (end !== -1) return [{ from: start + 1, to: end + 1 }];
  return lines.flatMap((l, i) => (namesCheck(l) ? [{ from: i + 1, to: i + 1 }] : []));
}

/** The commands whose ask rules init proposes (skills/init/gates.md): what leaves the machine and the offered lists. */
const INIT_COMMANDS = ["git push", "npm publish", ...GH_COMMANDS, ...OFFERED.destroys, ...OFFERED.installs];

/**
 * Whether every part of `path` below the common git dir `common` is there and no link: `path` must lie inside it.
 * @param {string} common @param {string} path
 */
function noLinkFrom(common, path) {
  const rel = relative(common, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let at = common;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Removes the file at `path` when it still holds the bytes `sha` names: it is moved aside in one rename to a new name
 * beside it, hashed there, and deleted; one that no longer matches goes back by a hard link, which replaces nothing a
 * writer put at `path` meanwhile (then it stays aside, and `aside` names it). Where the file system has no hard links
 * (FAT, exFAT, some network shares), it goes back by a rename when nothing stands at `path`.
 * A read that fails puts the file back first, then throws.
 * @param {string} path @param {string} sha @param {(path: string) => Buffer} [read] how the moved file is read (a test's fault)
 * @param {(from: string, to: string) => void} [link] how it is linked back (a test's fault)
 * @returns {"removed" | "changed" | "aside"}
 */
export function removeIfSame(path, sha, read = readFileSync, link = linkSync) {
  const aside = join(dirname(path), `.${basename(path)}.ennyn-removing-${randomBytes(4).toString("hex")}`);
  renameSync(path, aside);
  /** The file back at `path`, unless something new stands there. */
  const back = () => {
    try {
      link(aside, path);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "EEXIST" || there(path)) return "aside";
      renameSync(aside, path);
      return "changed";
    }
    rmSync(aside);
    return "changed";
  };
  let same;
  try {
    same = lstatSync(aside).isFile() && sha256(read(aside)) === sha;
  } catch (err) {
    back();
    throw err;
  }
  if (!same) return back();
  rmSync(aside);
  return "removed";
}

/**
 * uninstall-hook's work. Everything is read first: the hook git runs as install-hook reads it (hookStatus), the recorded
 * files, the state dir (only ownStateDir's, no link on its way from the git dir, and not while a mutation journal holds
 * a file a mutate run left changed), and what stays. A recorded file goes only when it is that hook: `commit-msg` in the
 * hooks directory git runs, inside the common git dir with no link on the way, the same place by real path, a regular
 * file whose bytes, read as it goes (removeIfSame), are the record's. A read that fails stops the command
 * before anything is removed.
 * @param {{ cwd: string, cfg: { configPath: string | null, paths: { stateDir: string, graph: string, handoff: string, metricsLog: string, findings: string } }, data?: string | null }} opts
 *   `data`: the plugin's data directory, when given or named by the session
 */
export function uninstall({ cwd, cfg, data = null }) {
  const common = commonDir(cwd);
  // The hook git runs, read as install-hook reads it.
  const st = hookStatus(cwd);
  const runs = placeOf(st.path);
  const entries = readWritten(cwd, writtenPath(cwd, cfg.paths.stateDir));
  /** @type {{ path: string, result: "removed" | "changed" | "notFile" | "gone" | "outside" | "aside" | "notRun", sha256: string }[]} */
  const files = entries.map((f) => {
    // install-hook writes only the commit-msg hook git runs, in the repository's own hooks directory: a record naming any other place is not its.
    let safe;
    let at;
    try {
      safe = common !== null && noLinkFrom(common, dirname(f.path));
      at = safe ? lstatSync(f.path) : null;
    } catch (err) {
      // A part on the way that is not there: the hook went with it.
      if (gone(err)) return { path: f.path, result: f.path === runs ? "gone" : "outside", sha256: f.sha256 };
      throw err;
    }
    if (!safe || at === null) return { path: f.path, result: "outside", sha256: f.sha256 };
    // install-hook's hook, where git no longer runs it (core.hooksPath set since): said, and kept.
    if (f.path !== runs) return { path: f.path, result: basename(f.path) === "commit-msg" && at.isFile() && sha256(readFileSync(f.path)) === f.sha256 ? "notRun" : "outside", sha256: f.sha256 };
    if (!at.isFile()) return { path: f.path, result: "notFile", sha256: f.sha256 };
    // Whether its bytes are the record's is read once, as it goes (removeIfSame).
    return { path: f.path, result: "removed", sha256: f.sha256 };
  });
  const handled = new Set(files.filter((f) => f.result !== "outside").map((f) => f.path));
  /** @type {{ path: string, result: "none" | "other" | "unrecorded" | "wired", own: string | null, lines: { from: number, to: number }[] }} */
  let hook = { path: st.path, result: "none", own: null, lines: [] };
  if (st.state === "wired") {
    const own = st.unread ?? st.block ?? (st.hooksKind === "husky" ? join(dirname(dirname(st.path)), "commit-msg") : st.path);
    hook = { path: st.path, result: "wired", own, lines: checkLines(readFileSync(own, "utf8")) };
  } else if (st.state === "ennyn" && !handled.has(runs)) hook = { ...hook, result: "unrecorded" };
  else if (st.state === "other" && !handled.has(runs)) hook = { ...hook, result: "other" };
  const state = stateVerdict(cfg.paths.stateDir, common);
  const left = stays(cwd, cfg, data ?? st.data);
  for (const f of files) if (f.result === "removed") f.result = removeIfSame(f.path, f.sha256);
  if (state.result === "removed") rmSync(state.path, { recursive: true });
  return { files: files.map(({ path, result }) => ({ path, result })), hook, state, stays: left };
}

/**
 * Whether the state dir goes: `removed` when it is Ennyn's to remove (the caller removes it). A link on its way from
 * the common git dir, or a real path outside it, keeps it.
 * @param {string} stateDir config `paths.stateDir` @param {string | null} common the common git dir (a real path)
 * @returns {{ path: string, result: "removed" | "none" | "notOwn" | "link" | "mutating", journals: string[] }}
 */
function stateVerdict(stateDir, common) {
  const rest = underGitDir(stateDir);
  if (common === null || rest === null || !ownStateDir(stateDir)) return { path: common !== null && rest !== null ? join(common, rest) : stateDir, result: "notOwn", journals: [] };
  const path = join(common, rest);
  let safe;
  try {
    safe = noLinkFrom(common, path);
  } catch (err) {
    if (gone(err)) return { path, result: "none", journals: [] };
    throw err;
  }
  if (!safe || !lstatSync(path).isDirectory() || !realpathSync.native(path).startsWith(common + sep)) return { path, result: "link", journals: [] };
  // A mutation journal holds the original of a file a mutate run left changed (metrics/mutation.mjs journalPath).
  const journals = readdirSync(path).filter((n) => /^mutate-[0-9a-f]{12}\.json$/.test(n));
  return { path, result: journals.length ? "mutating" : "removed", journals };
}

/** Whether anything is at `path`, a link included. @param {string} path */
function there(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (gone(err)) return false;
    throw err;
  }
}

/**
 * What stays for the user: the config, graph, handoff, metrics log and findings that are there, the ask rules init
 * proposes that `.claude/settings.json` holds, its plan-approval option, and the plugin's version record.
 * @param {string} cwd @param {Parameters<typeof uninstall>[0]["cfg"]} cfg @param {string | null} data
 */
function stays(cwd, cfg, data) {
  const pf = projectFiles(cwd);
  const keys = [cfg.configPath ?? ".ennyn/config.json", cfg.paths.graph, cfg.paths.handoff, cfg.paths.metricsLog, cfg.paths.findings];
  const files = keys.map((p) => relative(cwd, resolve(cwd, p))).filter((p) => there(resolve(cwd, p)));
  const read = readSettings(pf, SETTINGS[0]);
  const json = read && "json" in read ? read.json : null;
  const proposed = new Set(INIT_COMMANDS.flatMap((c) => TOOLS.map((tool) => ruleFor(c, tool))));
  const ask = /** @type {unknown[]} */ (json?.permissions?.ask ?? []).filter((r) => typeof r === "string" && proposed.has(r));
  const planClear = /** @type {any} */ (json)?.showClearContextOnPlanAccept === true;
  return { files, ask: /** @type {string[]} */ (ask), planClear, settingsUnread: read === undefined || (read !== null && "unread" in read), record: data !== null && there(join(data, PLUGIN_RECORD)) ? join(data, PLUGIN_RECORD) : null };
}
