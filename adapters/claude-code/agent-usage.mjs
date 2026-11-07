/**
 * What each subagent of a Claude Code session asked for and ran, read from the session's transcripts, read only:
 * `ennyn agents`. A split of models by role can be skipped without a word (claude-code#100082), so the closing
 * report sets the model asked for beside the model that ran.
 *
 * Measured on Claude Code 2.1.310's binary and on transcripts of 2.1.301 to 2.1.317. A session's subagents live in
 * `<projects>/<folder>/<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` beside each (a workflow's
 * agents in folders below). `<projects>` is `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`; `<folder>` is
 * the session's folder in NFC with every character outside `[a-zA-Z0-9]` turned into `-`, and past 200 characters
 * the first 200, `-` and a hash, a folder Claude Code itself finds by that prefix; with a config folder set,
 * CLAUDE_CODE_PROJECT_DIR_NAME of the right shape names it instead.
 *
 * The model asked for, in order: the Agent call's `model` (on the `type: "assistant"` line whose tool_use id is the
 * meta's `toolUseId`, in the session's transcript or another agent's: the same call also stands on lines of other
 * types, which are not read); the meta's `model` (written from 2.1.312 when one is passed; `inherit` for a fork);
 * the `model:` of the agent's file (`.claude/agents/*.md` at the repository's top, only for a session whose first
 * `cwd` is that top, and `<config>/agents/*.md`), read now, not as it was. Nothing asked is `default`: Claude Code then takes the definition's model, which for a built-in
 * agent is only in its binary (`claude-code-guide` runs haiku), or a default set by an environment the transcript
 * does not hold. With neither the call nor the meta, or a meta that names no model and no call to tell whether one
 * was passed, or an agent that is not built in and whose file is not found (or a session of another folder, whose
 * project files are not here), it is `unknown`. A record without `isBuiltIn` whose type is in BUILT_IN and that no
 * agent file takes is built in. Only an asked model is compared with what ran.
 *
 * A message stands on several lines, one per content block, its usage growing as it streams: calls are counted by
 * message id, each usage field taken at its largest. A `<synthetic>` line is no call. A line without usage is a call
 * whose tokens are unmeasured. A fork's transcript starts with a copy of the line that spawned it (30 of 30 forks
 * measured): a line whose message id stands in the transcript that made the call is not the agent's. The context at the last call is the last assistant line's input, cache read and cache
 * write, apart from the sums. A line past READ_LINE_MAX or one that does not parse is skipped and counted.
 * Nothing of a transcript's text is returned: ids, agent types and model names, each held to its shape.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gone } from "../../core/files.mjs";
import { splitFrontMatter } from "./rules-index.mjs";

/** The longest line read: an assistant line measured at 176 KB at most, a tool result's line at 6.5 MB. */
export const READ_LINE_MAX = 16 * 1024 * 1024;
/** Claude Code's folder name keeps this many characters of a long path, then a hash. */
export const FOLDER_KEEP = 200;
/** The most entries walked below a session's subagent folder. */
export const SUBAGENT_ENTRIES = 100_000;
/**
 * The built-in agent types of Claude Code 2.1.310 (its binary's agent definitions with `source: "built-in"`, with
 * `web-fetch`, named by a variable there, and `teammate`, the type a built-in teammate takes when it names none). A record
 * written before the `isBuiltIn` flag (2.1.301, 2.1.306, some of 2.1.312) is read by this list.
 */
export const BUILT_IN = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "claude", "fork", "worker", "workflow-subagent", "comment-thread-analyst", "web-fetch", "teammate"];
/** The aliases the Agent call takes (Claude Code 2.1.310's schema). */
export const ALIASES = ["opus", "sonnet", "haiku", "fable"];

/** A model as a transcript or a file may name it: an alias, an id, a provider's id. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
/** An agent type (`general-purpose`, `plugin:name`) or a session id. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,127}$/u;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
const META_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/;

/** @param {unknown} v */
const model = (v) => (typeof v === "string" && MODEL.test(v) ? v : null);
/** @param {unknown} v */
const name = (v) => (typeof v === "string" && NAME.test(v) ? v : null);

/** A read that failed for another reason than nothing there: said without the path. */
export class TranscriptError extends Error {}

/** @param {unknown} e @param {string} what */
const unreadable = (e, what) => new TranscriptError(`${what} could not be read (${/** @type {NodeJS.ErrnoException} */ (e)?.code ?? "error"})`);

/** Claude Code's config folder, in NFC as Claude Code 2.1.310 takes it; an empty CLAUDE_CONFIG_DIR is none. @param {NodeJS.ProcessEnv} env */
export const claudeConfigDir = (env = process.env) => (env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")).normalize("NFC");

/**
 * The folder name CLAUDE_CODE_PROJECT_DIR_NAME gives, as Claude Code 2.1.310 takes it: only with a config folder set,
 * of letters, digits, `_` and `-`, at most 64, and no device name of Windows; else null.
 * @param {NodeJS.ProcessEnv} env
 */
export function namedFolder(env = process.env) {
  const v = env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (!env.CLAUDE_CONFIG_DIR || !v || !/^[A-Za-z0-9_-]{1,64}$/.test(v) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v)) return null;
  return v;
}

/** Claude Code's projects folder. @param {NodeJS.ProcessEnv} env */
export const projectsDir = (env = process.env) => join(claudeConfigDir(env), "projects");

/** Claude Code's folder name for a path, without the hash a long one ends with: of the path in NFC. @param {string} path */
export const folderName = (path) => path.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The project folder of `top` in `projects`: the one `named` gives (namedFolder), else by its name, or past
 * FOLDER_KEEP characters the one folder that starts with its prefix and `-`. null when none is there; throws when
 * two are, or the folder cannot be read.
 * @param {string} projects @param {string[]} tops the spellings of the repository's top @param {string | null} [named]
 */
export function projectFolder(projects, tops, named = null) {
  let entries;
  try {
    entries = readdirSync(projects);
  } catch (e) {
    if (gone(e)) return null;
    throw unreadable(e, "the projects folder");
  }
  if (named !== null) return entries.includes(named) ? join(projects, named) : null;
  for (const top of tops) {
    const whole = folderName(top);
    if (whole.length <= FOLDER_KEEP) {
      if (entries.includes(whole)) return join(projects, whole);
      continue;
    }
    const prefix = `${whole.slice(0, FOLDER_KEEP)}-`;
    const found = entries.filter((e) => e.startsWith(prefix));
    if (found.length > 1) throw new TranscriptError(`${found.length} project folders share this repository's long name; give --session`);
    if (found.length === 1) return join(projects, found[0]);
  }
  return null;
}

/**
 * The newest session transcript of a project folder, by its time of change; null when it holds none.
 * @param {string} folder
 */
export function newestSession(folder) {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (e) {
    if (gone(e)) return null;
    throw unreadable(e, "the project folder");
  }
  let best = null;
  let bestTime = -Infinity;
  for (const e of entries) {
    if (!e.name.endsWith(".jsonl") || !name(e.name.slice(0, -6))) continue;
    const path = join(folder, e.name);
    let st;
    try {
      st = statSync(path);
    } catch (err) {
      if (gone(err)) continue;
      throw unreadable(err, "a session transcript");
    }
    if (st.isFile() && st.mtimeMs > bestTime) [best, bestTime] = [path, st.mtimeMs];
  }
  return best;
}

/**
 * The session `ennyn agents` reads when none is given: the one that runs the command, which Claude Code 2.1.310 names
 * in CLAUDE_CODE_SESSION_ID to the processes it starts. With no such variable, or one that is no session id, the
 * newest, with why (`unset`, `malformed`); a running session whose transcript is not in `folder` is `missing`, with
 * no transcript: the newest would be another session's.
 * @param {string} folder @param {NodeJS.ProcessEnv} [env]
 * @returns {{ transcript: string | null, chosen: "running" | "newest" | "missing", why: "unset" | "malformed" | null }}
 */
export function defaultSession(folder, env = process.env) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) return { transcript: newestSession(folder), chosen: "newest", why: "unset" };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { transcript: newestSession(folder), chosen: "newest", why: "malformed" };
  const own = join(folder, `${id}.jsonl`);
  try {
    statSync(own);
  } catch {
    return { transcript: null, chosen: "missing", why: null };
  }
  return { transcript: own, chosen: "running", why: null };
}

/**
 * Each line of a file parsed, in order; a line past READ_LINE_MAX or one that is no JSON object is counted, not
 * returned. null when the file is not there. Only a regular file is opened: a pipe would wait for a writer.
 * @param {string} path @param {string} what @param {(o: any) => void} each
 * @returns {{ skipped: number } | null}
 */
export function eachLine(path, what, each) {
  let fd;
  try {
    if (!statSync(path).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTREG" });
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTREG" });
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (gone(e)) return null;
    throw unreadable(e, what);
  }
  let skipped = 0;
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  let over = false;
  const end = () => {
    if (over) skipped++;
    else if (size) {
      const text = Buffer.concat(parts).toString("utf8").trim();
      if (text) {
        let o;
        try {
          o = JSON.parse(text);
        } catch {
          o = null;
        }
        if (o && typeof o === "object" && !Array.isArray(o)) each(o);
        else skipped++;
      }
    }
    parts = [];
    size = 0;
    over = false;
  };
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      let n;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        throw unreadable(e, what);
      }
      if (n === 0) break;
      let from = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, from)) {
        take(buf.subarray(from, i));
        end();
        from = i + 1;
      }
      take(buf.subarray(from, n));
    }
    end();
  } finally {
    closeSync(fd);
  }
  return { skipped };

  /** @param {Buffer} chunk */
  function take(chunk) {
    if (over || !chunk.length) return;
    size += chunk.length;
    if (size > READ_LINE_MAX) {
      over = true;
      parts = [];
      return;
    }
    parts.push(Buffer.from(chunk));
  }
}

/**
 * The `name:` and `model:` of an agent file's front matter; model null when it names none.
 * @param {string} text
 */
export function agentFileFields(text) {
  const { frontMatter } = splitFrontMatter(text);
  if (frontMatter === null) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of frontMatter.split("\n")) {
    const m = /^(name|model):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m) fields[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { name: fields.name ?? null, model: fields.model === undefined || fields.model === "" ? null : fields.model };
}

/**
 * The agent files in `dirs`, by the name each declares (else its file name): the models each name is given.
 * A file that cannot be read throws.
 * @param {string[]} dirs @param {(path: string) => string | null} read
 * @returns {Map<string, (string | null)[]>}
 */
export function agentFiles(dirs, read) {
  /** @type {Map<string, (string | null)[]>} */
  const byName = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (gone(e)) continue;
      throw unreadable(e, "an agents folder");
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md")) continue;
      let text;
      try {
        text = read(join(dir, e.name));
      } catch (err) {
        throw unreadable(err, "an agent file");
      }
      if (text === null) continue;
      const fields = agentFileFields(text);
      if (!fields) continue;
      const key = fields.name ?? e.name.slice(0, -3);
      byName.set(key, [...(byName.get(key) ?? []), fields.model]);
    }
  }
  return byName;
}

/** @param {string} s */
const normal = (s) => s.toLowerCase().replace(/\[[^\]]*\]$/, "");
/** An id without its provider's prefix and suffixes: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`. @param {string} id */
const core = (id) => {
  const at = id.indexOf("claude-");
  return (at === -1 ? id : id.slice(at)).replace(/-v\d+(:\d+)?$/, "").replace(/[-@]\d{8}$/, "");
};

/**
 * Whether a model that ran is the one asked for: true, false, or null when the ask names no model to compare
 * (`default`, `unknown`, a word that is no alias and no id, `inherit` with no parent model). An alias matches an id
 * that holds it as a whole word (`sonnet`: `claude-sonnet-5-5`, `claude-3-5-sonnet-20241022`); an id matches the
 * same id, with or without a provider's prefix, a date or a version suffix; `inherit` is the parent's model.
 * @param {string} asked @param {string} ran @param {string | null} parent the model of the line that made the call
 * @returns {boolean | null}
 */
export function modelMatches(asked, ran, parent) {
  const a = normal(asked);
  if (a === "inherit") return parent === null ? null : modelMatches(parent, ran, null);
  const r = normal(ran);
  if (ALIASES.includes(a)) return r.split(/[-.@:/_]/).includes(a);
  if (!a.includes("claude-")) return null;
  return r === a || core(r) === core(a);
}

/** @param {unknown} v */
const count = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The tokens a call's prompt held: input, read from cache and written to cache; null when one is not a count.
 * @param {Record<string, unknown>} u a line's usage
 */
export function context(u) {
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(count);
  return parts.includes(null) ? null : /** @type {number[]} */ (parts).reduce((a, b) => a + b, 0);
}

/**
 * @typedef {{ id: string, type: string | null, asked: string, from: "call" | "record" | "file" | null,
 *   ran: Record<string, number>, calls: number, usageMissing: number, output: number, cacheWrite: number,
 *   cacheRead: number, lastContext: number | null, mismatch: boolean | null, first: string }} AgentRow
 */

/**
 * The usage of a session's subagents.
 * @param {{ transcript: string, tops: string[], configDir: string, read: (path: string) => string | null }} o
 *   `tops`: the spellings of the repository's top, whose `.claude/agents` is read only for a session that ran there;
 *   `read`: a file's text, null when not there
 * @returns {{ session: string, there: boolean, agents: AgentRow[], skipped: number, unreadMeta: number }}
 */
export function agentUsage({ transcript: given, tops, configDir, read }) {
  // A link names the transcript it points to: its session and its subagents folder are that file's, unless a
  // subagents folder stands beside the link's own name (a session kept with its folder).
  let transcript = given;
  try {
    statSync(join(given.slice(0, -".jsonl".length), "subagents"));
  } catch {
    try {
      transcript = realpathSync(given);
    } catch {
      // The read below says what stands there: nothing, or what could not be read.
    }
  }
  const session = basename(transcript, ".jsonl");
  /** @type {Map<string, { model: string | null, given: boolean, type: string | null, parent: string | null, where: string[] }>} */
  const calls = new Map();
  /** The message ids of each transcript's assistant lines: `""` the session's, else an agent's id. @type {Map<string, Set<string>>} */
  const idsOf = new Map();
  let skipped = 0;
  /** @param {any} o @param {string} where */
  const takeCalls = (o, where) => {
    if (o.type !== "assistant" || !o.message || typeof o.message !== "object") return;
    if (typeof o.message.id === "string") idsOf.get(where)?.add(o.message.id);
    if (!Array.isArray(o.message.content)) return;
    const parent = model(o.message.model);
    for (const c of o.message.content) {
      if (!c || c.type !== "tool_use" || typeof c.id !== "string" || !c.input || typeof c.input !== "object") continue;
      const was = calls.get(c.id);
      if (was) {
        if (!was.where.includes(where)) was.where.push(where);
        continue;
      }
      const given = c.input.model !== undefined;
      calls.set(c.id, { model: model(c.input.model), given, type: name(c.input.subagent_type), parent: parent === "<synthetic>" ? null : parent, where: [where] });
    }
  };
  /** The folder the session ran in, from its first line that names one. @type {string | null} */
  let cwd = null;
  idsOf.set("", new Set());
  const main = eachLine(transcript, "the session transcript", (o) => {
    if (cwd === null && typeof o.cwd === "string" && o.cwd !== "") cwd = o.cwd;
    takeCalls(o, "");
  });
  if (main === null) return { session, there: false, agents: [], skipped: 0, unreadMeta: 0 };
  skipped += main.skipped;

  /** @type {Map<string, { jsonl?: string, meta?: string }>} */
  const files = new Map();
  const stack = [join(transcript.slice(0, -".jsonl".length), "subagents")];
  let seen = 0;
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (gone(e)) continue;
      throw unreadable(e, "a subagent folder");
    }
    for (const e of entries) {
      if (++seen > SUBAGENT_ENTRIES) throw new TranscriptError(`more than ${SUBAGENT_ENTRIES} entries below the session's subagent folder`);
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(path);
        continue;
      }
      const j = AGENT_FILE.exec(e.name);
      const m = META_FILE.exec(e.name);
      const id = j?.[1] ?? m?.[1];
      if (!id) continue;
      const f = files.get(id) ?? {};
      if (j) f.jsonl = path;
      else f.meta = path;
      files.set(id, f);
    }
  }

  /** Each agent's assistant lines, synthetic ones aside, in order. @type {Map<string, { key: string, id: string | null, model: string, u: any }[]>} */
  const linesOf = new Map();
  /** @type {Map<string, string>} */
  const firstOf = new Map();
  for (const [id, f] of files) {
    /** @type {{ key: string, id: string | null, model: string, u: any }[]} */
    const own = [];
    let first = "";
    let line = 0;
    idsOf.set(id, new Set());
    if (f.jsonl) {
      const r = eachLine(f.jsonl, "a subagent transcript", (o) => {
        line++;
        if (!first && typeof o.timestamp === "string") first = o.timestamp;
        takeCalls(o, id);
        if (o.type !== "assistant" || !o.message || typeof o.message !== "object") return;
        const m = o.message.model;
        if (m === "<synthetic>") return;
        const mid = typeof o.message.id === "string" ? o.message.id : null;
        own.push({ key: mid === null ? `line:${line}` : `id:${mid}`, id: mid, model: model(m) ?? "unknown", u: o.message.usage && typeof o.message.usage === "object" ? o.message.usage : null });
      });
      if (r) skipped += r.skipped;
    }
    linesOf.set(id, own);
    firstOf.set(id, first);
  }

  const here = cwd !== null && tops.some((t) => same(t, /** @type {string} */ (cwd)));
  let defs = /** @type {Map<string, (string | null)[]> | null} */ (null);
  // Asked only for a session that ran at this top (`here`): another project's files of the same name say nothing.
  const definitions = () => (defs ??= agentFiles([join(tops[0], ".claude", "agents"), join(configDir, "agents")], read));

  let unreadMeta = 0;
  /** @type {AgentRow[]} */
  const agents = [];
  for (const [id, f] of files) {
    /** @type {any} */
    let meta = null;
    if (f.meta) {
      let text = null;
      try {
        text = read(f.meta);
      } catch (e) {
        throw unreadable(e, "a subagent record");
      }
      try {
        meta = text === null ? null : JSON.parse(text);
      } catch {
        meta = null;
      }
      if (text !== null && (!meta || typeof meta !== "object" || Array.isArray(meta))) {
        meta = null;
        unreadMeta++;
      }
    }
    const call = meta && typeof meta.toolUseId === "string" ? (calls.get(meta.toolUseId) ?? null) : null;
    const type = name(meta?.agentType) ?? call?.type ?? null;
    /** @type {{ asked: string, from: AgentRow["from"] }} */
    let ask = { asked: "unknown", from: null };
    if (call?.model) ask = { asked: call.model, from: "call" };
    else if (call?.given) ask = { asked: "unknown", from: null };
    else if (model(meta?.model)) ask = { asked: /** @type {string} */ (model(meta.model)), from: "record" };
    else if (call && type !== null && meta?.isBuiltIn === true) ask = { asked: "default", from: null };
    else if (call && type !== null && here) {
      const models = [...new Set(definitions().get(type) ?? [])];
      // A record from before the flag (2.1.301 to some of 2.1.312): a built-in name no file takes is the built-in.
      if (!models.length && meta?.isBuiltIn === undefined && BUILT_IN.includes(type)) ask = { asked: "default", from: null };
      else if (models.length === 1 && models[0] === null) ask = { asked: "default", from: null };
      else if (models.length === 1 && model(models[0])) ask = { asked: /** @type {string} */ (models[0]), from: "file" };
    }

    // The line a fork's transcript starts with is a copy of its parent's spawning line: the parent's, not its own.
    const parentIds = idsOf.get(call?.where.find((w) => w !== id) ?? "") ?? new Set();
    const own = /** @type {NonNullable<ReturnType<typeof linesOf.get>>} */ (linesOf.get(id)).filter((l) => l.id === null || !parentIds.has(l.id));
    /** @type {Map<string, number>} */
    const ran = new Map();
    /** @type {Map<string, { output: number | null, write: number | null, read: number | null } | null>} */
    const usage = new Map();
    /** @type {number | null} */
    let lastContext = null;
    for (const l of own) {
      if (!usage.has(l.key)) ran.set(l.model, (ran.get(l.model) ?? 0) + 1);
      const was = usage.get(l.key) ?? null;
      // The context of the agent's last call: what its last assistant line says the prompt held.
      lastContext = l.u ? context(l.u) : null;
      if (!l.u) {
        if (!usage.has(l.key)) usage.set(l.key, null);
        continue;
      }
      /** @param {unknown} v @param {number | null | undefined} before */
      const most = (v, before) => {
        const n = count(v);
        return n === null ? (before ?? null) : Math.max(n, before ?? 0);
      };
      usage.set(l.key, { output: most(l.u.output_tokens, was?.output), write: most(l.u.cache_creation_input_tokens, was?.write), read: most(l.u.cache_read_input_tokens, was?.read) });
    }
    let output = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let usageMissing = 0;
    for (const v of usage.values()) {
      if (!v || v.output === null || v.write === null || v.read === null) usageMissing++;
      output += v?.output ?? 0;
      cacheWrite += v?.write ?? 0;
      cacheRead += v?.read ?? 0;
    }
    const ranBy = Object.fromEntries([...ran].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
    const verdicts = Object.keys(ranBy).map((r) => (r === "unknown" ? null : modelMatches(ask.asked, r, call?.parent ?? null)));
    const mismatch = verdicts.includes(false) ? true : !verdicts.length || verdicts.includes(null) ? null : false;
    agents.push({ id, type, asked: ask.asked, from: ask.from, ran: ranBy, calls: usage.size, usageMissing, output, cacheWrite, cacheRead, lastContext, mismatch, first: /** @type {string} */ (firstOf.get(id)) });
  }
  agents.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.id < b.id ? -1 : 1));
  return { session, there: true, agents, skipped, unreadMeta };
}

/** Whether two spellings of a folder are one: as written or in NFC, a trailing separator aside. @param {string} a @param {string} b */
const same = (a, b) => {
  const n = (/** @type {string} */ p) => p.normalize("NFC").replace(/[\\/]+$/, "");
  return n(a) === n(b);
};
