/**
 * Whether automatic compaction may run now, for the PreCompact hook (hooks/compact-boundary.mjs). The hook holds one
 * kind of compaction: idle compaction of a session whose task is mid-way. A summary taken in the middle of a task
 * loses what the task was doing, and a session nobody is using needs no compaction yet. Everything else passes.
 *
 * Why only that. In Claude Code 2.1.310 a hold of idle compaction removes that compaction and nothing else: the next
 * prompt goes out with the whole conversation, as it would with idle compaction off (`test/reference/precompact.json`,
 * and the lab in DESIGN.md). A hold anywhere else can cost the session: at or past the hard limit it ends the turn, on
 * a 413 it ends the turn, on the auto-mode classifier's request nothing asks again, and a subagent's compaction runs
 * this hook with the main thread's input. So threshold, 413, classifier, subagent and `/compact` compaction run as they
 * do with no hook, and everything here that cannot be measured is a pass.
 *
 * How idle compaction is told from the rest. The input does not say which path called the hook. Idle compaction fires
 * from a timer armed at the end of a turn. Every other path runs right after something was written to a transcript: a
 * prompt, a tool result, a reply. So a compaction is idle when the session's transcripts have been quiet for the gap
 * below, the last reply ended its turn, nothing but Claude Code's bookkeeping came after that reply, and the input's
 * prompt id is still the one that turn ran under. A `/model` since the turn does not stop the timer (measured): it
 * leaves a mark here, and that compaction passes. A new prompt, or a new process, shows in the prompt id even when its
 * line is not in the file yet.
 *
 * The tree is read through `git ls-files --debug`, a format git's manual says may change at any time: a moved format
 * passes, and test/compact-boundary.test.mjs fails on the git upgrade that moves it.
 */

import { isAbsolute, join, relative, resolve, sep, basename, dirname } from "node:path";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { gone, readTail } from "../../core/files.mjs";
import { HOOK_READ_ENV, gitError, gitRun } from "../../core/git.mjs";
import { asciiJson, t } from "../../core/i18n.mjs";

/**
 * Claude Code 2.1.310's models with a 1M window, by the ids a transcript's `message.model` holds.
 * test/reference/precompact.mjs holds it to the binary. A model not here passes, a 200K model too: its ceiling, 100K,
 * is idle compaction's own floor, so no reachable idle compaction of one is ever under it. A 1M variant of a 200K model
 * (`[1m]`, which no transcript line shows) passes the same way.
 */
export const MODEL_WINDOWS = new Map(["claude-haiku-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1"].map((id) => /** @type {[string, number]} */ ([id, 1_000_000])));

/** What a held session keeps between its last reply's context and the end of its window. */
export const HEADROOM = 100_000;

/**
 * How long the session's transcripts must have been quiet. Idle compaction fires at a fraction of the prompt cache's
 * hour after the last request: 0.9 by default, never under 0.5 (2.1.310: the clamp in `i7t`, the keepalive path's
 * floor), so never sooner than this. A later start only makes the rule pass more.
 */
export const IDLE_GAP_MS = 30 * 60_000;

/** How much of the transcript is read: a line holds up to 1.2 MB, and 4 MiB parse in 10 ms on the largest here. */
export const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * What a git call may take: the hook has 10 seconds (hooks/hooks.json) and GIT_CALLS calls to make before its verdict, a
 * test counts them. The log's call, `gitDirOf`, comes after the verdict: a hook killed there lets the compaction run.
 */
export const GIT_MS = 2000;
export const GIT_CALLS = 4;

/**
 * How long after its start the hook first reads the transcript. Claude Code 2.1.310 writes the transcript from a queue
 * every 100 ms (FLUSH_INTERVAL_MS): read at once, the hook can miss the prompt or reply that shows the session is
 * in use.
 */
export const SETTLE_MS = 300;

/** Past this many entries the subagent folders are not looked through, and past this many paths the tree is not: both pass. */
export const SUBAGENT_ENTRIES = 4096;
export const TREE_PATHS = 100_000;

/** The most names given to the summary, and each name's length. */
const MAX_NAMES = 20;
const MAX_NAME = 120;

/** The tools that change a file. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * What Claude Code writes after a turn's last reply with no new turn behind it (2.1.310: this repository's 937 turn
 * ends and the lab's). The `hook_` kinds are what a project's Stop hook leaves there: `hook_success`,
 * `hook_system_message`, `hook_non_blocking_error` and `hook_stopped_continuation` measured on the real CLI,
 * `hook_error_during_execution` and `hook_cancelled` read in the same generator of the binary. The rest of the family
 * stays out: `hook_blocking_error` sends the turn on, `hook_additional_context` and `hook_deferred_tool` belong to a
 * tool or a prompt. A name not here, known or new, is a mark that the session moved after that reply: a `/model`
 * leaves `system/local_command`, a process that ended leaves `cost-state`, a prompt leaves `user` and
 * `file-history-snapshot`, a request leaves `api-request`. It decides in the safe direction only, and the log names it.
 */
const BOOKKEEPING = new Set(["ai-title", "atis-latch", "attachment/deferred_tools_record", "attachment/hook_cancelled", "attachment/hook_error_during_execution", "attachment/hook_non_blocking_error", "attachment/hook_stopped_continuation", "attachment/hook_success", "attachment/hook_system_message", "attachment/prompt_snapshot", "last-prompt", "mode", "permission-mode", "queue-operation", "system/away_summary", "system/stop_hook_summary", "system/turn_duration", "tools-used"]);

/** @param {any} o a transcript line */
const kindOf = (o) => (o?.type === "attachment" ? `attachment/${o.attachment?.type}` : o?.type === "system" ? `system/${o.subtype}` : typeof o?.type === "string" ? o.type : "other");

/** A kind as the log may hold it: the transcript's text, so a short plain word or two, else `other`. @param {string} kind */
const kindShown = (kind) => (/^[a-z][a-z0-9_-]{0,47}(?:\/[a-z][a-z0-9_-]{0,47})?$/.test(kind) ? kind : "other");

/**
 * The context a reply's usage reports: what went in, never what came out. null for no usable record.
 * @param {any} usage
 */
function contextTokens(usage) {
  const parts = [usage?.input_tokens ?? 0, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
  if (!parts.every((v) => Number.isSafeInteger(v) && v >= 0)) return null;
  return parts.reduce((a, b) => a + b, 0) || null;
}

/**
 * An absolute path inside one of `roots`, by its spelling. A spelling that does not match is no Edit of this tree: the
 * safe way. A relative path has no root the hook can know: `relative` would read it against the hook's own folder.
 * @param {string[]} roots @param {unknown} path
 */
const inside = (roots, path) => {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
  });
};

/**
 * What the end of a transcript says, line by line in file order. A line that does not parse, or the end of a line
 * still being written, counts as a mark: nothing about it is known.
 * @param {string} text the transcript's end
 * @param {string[]} roots the tree's top, and the session's folder as spelled: a transcript may hold either
 * @returns {{ last: number | null, ended: boolean, mark: string | null, prompt: string | null, tokens: number | null, model: string | null, edit: number | null }}
 *   `last`: the time of the newest line that has one, ms; `ended`: the last reply ended its turn; `mark`: the kind of
 *   the first line after it that is not bookkeeping; `prompt`: the prompt id of the last user line; `tokens`, `model`:
 *   the last reply's context and model; `edit`: the time of the last Edit or Write in the tree, ms
 */
export function tailFacts(text, roots) {
  const out = { last: /** @type {number | null} */ (null), ended: false, mark: /** @type {string | null} */ (null), prompt: /** @type {string | null} */ (null), tokens: /** @type {number | null} */ (null), model: /** @type {string | null} */ (null), edit: /** @type {number | null} */ (null) };
  const lines = text.split("\n");
  const unfinished = lines.pop() !== "";
  for (const line of lines) {
    /** @type {any} */
    let o = null;
    try {
      o = JSON.parse(line);
    } catch {
      // No kind, so a mark, below.
    }
    const at = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(at)) out.last = Math.max(out.last ?? at, at);
    if (o?.isSidechain === true) continue;
    if (o?.type === "user" && typeof o.promptId === "string") out.prompt = o.promptId;
    if (o?.type !== "assistant") {
      if (!BOOKKEEPING.has(kindOf(o))) out.mark ??= kindShown(kindOf(o));
      continue;
    }
    const real = o.isApiErrorMessage !== true && typeof o.message?.model === "string" && o.message.model !== "<synthetic>";
    Object.assign(out, { ended: real && o.message.stop_reason === "end_turn", mark: null, tokens: real ? contextTokens(o.message.usage) : null, model: real ? o.message.model : null });
    const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const b of blocks) {
      if (b?.type !== "tool_use" || !EDIT_TOOLS.has(b.name) || Number.isNaN(at)) continue;
      if (inside(roots, b.input?.file_path ?? b.input?.notebook_path)) out.edit = Math.max(out.edit ?? at, at);
    }
  }
  if (unfinished) out.mark ??= "other";
  return out;
}

/** A moment in ms and a commit's time in seconds: the moment is later only in a later second. @param {number} ms @param {number} seconds */
const later = (ms, seconds) => Math.floor(ms / 1000) > seconds;

/** One line of `git ls-files -z -t --debug`: its tag, its name, and for a tracked file the index's time and size. */
const LISTED = /(.) ([^\0]*)\0(?:  ctime: [^\n]*\n  mtime: (\d+):\d+\n[^\n]*\n[^\n]*\n  size: (\d+)\t[^\n]*\n)?/gy;

/**
 * What `git ls-files -z -t --debug` listed. Output of any other shape throws.
 * @param {string} text
 * @returns {{ tag: string, name: string, mtime: number | null, size: number | null }[]}
 */
export function listed(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(LISTED)) {
    out.push({ tag: m[1], name: m[2], mtime: m[3] === undefined ? null : Number(m[3]), size: m[4] === undefined ? null : Number(m[4]) });
    at = m.index + m[0].length;
  }
  if (at !== text.length) throw new Error("git ls-files printed a line this hook does not read");
  return out;
}

/**
 * What every git call of the hook is given, on top of core/git.mjs, whose every call runs no file-system monitor and,
 * from git 2.38, reads no bare-looking folder a clone brought in as a repository (a lower git, the floor too, does):
 * nothing here may run the repository's code or reach a network. Takes no optional lock (a merge may be under way). No
 * promisor fetch and no replaced object (HOOK_READ_ENV); a git that does not read that yet (the floor does not) starts
 * a fetch, and GIT_ALLOW_PROTOCOL stops it before any transport.
 */
const QUIET = ["--no-optional-locks"];

/**
 * git's answer, or a throw.
 * @param {string[]} args @param {string} cwd
 */
function asked(args, cwd) {
  const r = gitRun([...QUIET, ...args], { cwd, env: { ...process.env, ...HOOK_READ_ENV, GIT_ALLOW_PROTOCOL: "none" }, within: GIT_MS });
  if (r.error || r.status !== 0) throw gitError(args, r);
  return r.stdout;
}

/** A real path, by the system: the same spelling for one folder however it was reached. @param {string} path */
export const real = (path) => realpathSync.native(path);

/** Whether `dir` is `top` or lies below it, both real paths. @param {string} top @param {string} dir */
export const within = (top, dir) => dir === top || dir.startsWith(top.endsWith(sep) ? top : `${top}${sep}`);

/**
 * The top of the tree `cwd` lies in, when that tree is the session's. `core.worktree` or a `.git` file can point git at
 * another repository, and below git 2.38 a clone's bare-looking folder is enough: those names are not this session's
 * to give. So the top is `cwd` or above it; `cwd` lies outside its own git dir, as every bare-looking folder is found by
 * walking up from the session, whatever its `commondir` file names; and a git dir that is another tree's `.git`, no
 * linked worktree of it, is that tree's. A git dir kept apart under another name passes, a submodule's and a linked
 * worktree's too. So what can write the `.git` entry itself, which no commit can, can still make another repository read
 * as the session's own: this cannot tell those shapes from real ones.
 * @param {string} cwd
 */
function ownTop(cwd) {
  const lines = asked(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], cwd).split("\n");
  if (lines.length !== 4) throw new Error("git rev-parse printed what this hook does not read");
  const [top, gitDir, common] = lines.slice(0, 3).map((path) => real(resolve(cwd, path)));
  const here = real(cwd);
  if (within(top, here) && !within(gitDir, here) && !(gitDir === common && basename(common) === ".git" && dirname(common) !== top)) return top;
  throw Object.assign(new Error("git named a tree that is not the session's"), { reason: "other-tree" });
}

/**
 * The git dir of `cwd`, a real path. Throws when git does not name one: no repository, and from git 2.38 a bare-looking
 * folder. git prints it absolute, or `.` in the folder itself, so a `cwd` spelled through a link reads the same.
 * @param {string} cwd
 */
export const gitDirOf = (cwd) => real(resolve(cwd, asked(["rev-parse", "--git-dir"], cwd).replace(/\n$/, "")));

/**
 * The tree `cwd` lies in: its top, HEAD's commit time, and what changed after that commit. The two halves of
 * `git status` with no tracked file's content read, so no filter runs: names that differ between HEAD and the index,
 * and files whose time or size differ from what the index recorded, or that the index does not hold, and that are newer
 * than the commit. A file older than the commit is not this task's. A tracked file that is gone counts: its time is
 * unknown. A file edited and put back reads as changed, a file changed and left out of a commit reads as clean when the
 * commit is newer: this rule reads time, not content.
 * @param {string} cwd
 * @returns {{ top: string, commit: number, changed: string[] }}
 */
export function treeFacts(cwd) {
  const top = ownTop(cwd);
  const log = asked(["log", "-1", "--format=%ct", "HEAD", "--"], top);
  if (!/^\d+\s*$/.test(log)) throw new Error("git log printed no commit time");
  const commit = Number(log);
  const changed = new Set(asked(["diff-index", "--cached", "--name-only", "-z", "HEAD", "--"], top).split("\0").filter(Boolean));
  const paths = listed(asked(["ls-files", "-z", "-t", "--debug", "--cached", "--others", "--exclude-standard"], top));
  if (paths.length > TREE_PATHS) throw Object.assign(new Error(`more than ${TREE_PATHS} paths`), { reason: "many-paths" });
  for (const { tag, name, mtime, size } of paths) {
    // Sparse checkout leaves it out on purpose; a name that is no UTF-8 cannot be looked up from what git printed.
    if (tag === "S" || name.includes("\ufffd")) continue;
    try {
      const st = lstatSync(join(top, name));
      // A submodule: its own commits say what it holds.
      if (st.isDirectory() && mtime !== null) continue;
      if (later(st.mtimeMs, commit) && !(Math.floor(st.mtimeMs / 1000) === mtime && st.size === size)) changed.add(name);
    } catch (e) {
      if (!gone(e)) throw e;
      if (mtime !== null) changed.add(name);
    }
  }
  return { top, commit, changed: [...changed] };
}

/**
 * Whether anything under the session's subagent folders was written within the gap. A workflow's agents keep their
 * transcripts in folders below it. A subagent's compaction runs the hook with the main thread's input (measured), and
 * it runs right after a write to the subagent's own transcript. Nothing there is no subagent; a folder that cannot be
 * read, or more entries than the bound, throws.
 * @param {string} transcript the main transcript @param {number} now ms
 */
export function subagentBusy(transcript, now) {
  const stack = [join(dirname(transcript), basename(transcript, ".jsonl"), "subagents")];
  let seen = 0;
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (gone(e)) continue;
      throw e;
    }
    for (const entry of entries) {
      if (++seen > SUBAGENT_ENTRIES) throw new Error(`more than ${SUBAGENT_ENTRIES} entries`);
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      try {
        if (now - lstatSync(path).mtimeMs < IDLE_GAP_MS) return true;
      } catch (e) {
        if (!gone(e)) throw e;
      }
    }
  }
  return false;
}

/**
 * The end of a transcript as text, however large the file is; null when it is not there. Its first line may be cut;
 * a line that does not parse is a mark, and the next reply clears it. A link or anything but a regular file throws.
 * @param {unknown} path
 */
export function transcriptTail(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const got = readTail(dirname(path), path, TAIL_BYTES);
  return got === null ? null : got.bytes.toString("utf8");
}

/** @param {unknown} err */
const said = (err) => String(/** @type {Error} */ (err)?.message ?? err).split("\n")[0].slice(0, 200);

/**
 * The verdict. Each rule that does not hold is a pass with its reason, in the order of the node's rules; the block is
 * the one answer that needs them all. `tree` is run first, whatever the verdict: `changed` not null means the tree was
 * read and the summary is given its names, and a tree that is not the session's ends it here. `tail` and `subagents`
 * run only when the answer needs them, and one that throws has measured nothing.
 * @param {{ trigger: unknown, prompt: unknown, now: number, tree: () => ReturnType<typeof treeFacts>, tail: (top: string | null) => ReturnType<typeof tailFacts> | null, subagents: () => boolean }} m
 * @returns {{ block: boolean, reason: string, why?: string, mark: string | null, quiet: number | null, tokens: number | null, window: number | null, ceiling: number | null, edit: boolean | null, changed: string[] | null }}
 *   `why`: what could not be measured, when that is the reason; `mark`: what `since-reply` saw; `quiet`: seconds since
 *   the transcript's newest line
 */
export function judge({ trigger, prompt, now, tree, tail, subagents }) {
  /** @type {ReturnType<typeof judge>} */
  const out = { block: false, reason: "", mark: null, quiet: null, tokens: null, window: null, ceiling: null, edit: null, changed: null };
  /** @param {string} reason @param {string} [why] */
  const pass = (reason, why) => Object.assign(out, { reason, ...(why === undefined ? {} : { why }) });
  /** @type {ReturnType<typeof treeFacts> | null} */
  let read = null;
  /** @type {any} */
  let unread = null;
  try {
    read = tree();
    out.changed = read.changed;
  } catch (err) {
    unread = err;
  }
  if (unread?.reason === "other-tree") return pass(unread.reason, said(unread));
  if (trigger !== "auto") return pass(trigger === "manual" ? "manual" : "not-auto");
  /** @type {ReturnType<typeof tailFacts> | null} */
  let facts;
  try {
    facts = tail(read?.top ?? null);
  } catch (err) {
    return pass("transcript", said(err));
  }
  if (facts === null) return pass("transcript", "no transcript");
  if (facts.last === null) return pass("no-time", "no line with a time in the transcript's end");
  out.quiet = Math.floor((now - facts.last) / 1000);
  if (now - facts.last < IDLE_GAP_MS) return pass("recent");
  if (!facts.ended) return pass("turn-open");
  if (facts.mark !== null) return Object.assign(pass("since-reply"), { mark: facts.mark });
  if (facts.prompt === null || facts.prompt !== prompt) return pass("other-prompt");
  try {
    if (subagents()) return pass("subagent");
  } catch (err) {
    return pass("subagents", said(err));
  }
  if (facts.tokens === null) return pass("no-usage", "the last reply reports no usage");
  out.tokens = facts.tokens;
  const window = facts.model === null ? undefined : MODEL_WINDOWS.get(facts.model);
  if (window === undefined) return pass("model-unknown", "a model the table does not hold");
  out.window = window;
  out.ceiling = window - HEADROOM;
  if (facts.tokens >= out.ceiling) return pass("ceiling");
  if (read === null) return pass(unread?.reason ?? "git", said(unread));
  out.edit = facts.edit !== null && later(facts.edit, read.commit);
  if (out.edit || read.changed.length > 0) return Object.assign(out, { block: true, reason: "mid-task" });
  return pass("boundary");
}

/**
 * What goes on stdout for the summary, on every pass: Claude Code joins a passing hook's stdout to the summary's
 * additional instructions (undocumented, held by test/reference/precompact.mjs), so this is text put before the model.
 * The hook does not know the task or the next step; the summary's author does, so it is asked for them, whatever could
 * be read, and given the names of the changed files when they were read. Names come from git alone, each on a line of
 * its own, as one JSON string of printable ASCII, and cut: a file named like an instruction or a tag stays a quoted
 * file name. Never opens with `{`: that would be read as a verdict.
 * @param {string[]} changed @param {string} lang
 */
export function summaryRequest(changed, lang) {
  const lines = [t("compact.ask", {}, lang)];
  if (changed.length) {
    const names = changed.slice(0, MAX_NAMES);
    lines.push(t("compact.changed", { listed: names.length, left: changed.length - names.length }, lang));
    for (const name of names) {
      const chars = [...name];
      lines.push(`- ${asciiJson(chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join("")}…` : name)}`);
    }
  }
  return lines.join("\n");
}
