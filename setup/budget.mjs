/**
 * Instruction text is a budget that only shrinks (DESIGN.md, principle 4). This
 * turns it into numbers per cycle: bytes an agent loads in every session (the
 * instruction and rule files that always load, the files they import, and the
 * name and description of every skill and agent), bytes it loads when a
 * matching path is touched, and rule lines repeated across instruction files.
 *
 * Only tracked files count: the records are shared through git, and a
 * CLAUDE.local.md or an untracked rule on one machine is that machine's own;
 * those are listed apart.
 *
 * Origin: the origin project's always-loaded rules were 72-74% of a session's
 * first request (docs/evidence.md).
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { agentSetup, outsideFences, projectFiles } from "./scan.mjs";
import { readIfThere, readRegular, writeState } from "../core/files.mjs";
import { clipped } from "../core/i18n.mjs";
import { splitFrontMatter } from "../adapters/claude-code/rules-index.mjs";

/** A line this short is a heading, a label or a fragment, not a rule worth counting twice. */
const MIN_RULE = 40;

/**
 * The words of a line, without list markers, numbering, quotes, table pipes or emphasis, lower case.
 * @param {string} raw
 */
export function ruleKey(raw) {
  return raw
    .replace(/^[\s>|*+-]*(\d+[.)]\s*)?/, "")
    .replace(/[*_`|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** No such file is nothing to count; one that could not be read is no empty file, and the error names it. */
const readOrNull = readIfThere;

/**
 * A front-matter field, also as a YAML block (`description: >` or `|`, the text on the indented lines below).
 * @param {string} frontMatter @param {string} key
 */
export function frontMatterField(frontMatter, key) {
  const lines = frontMatter.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) return "";
  const value = lines[at].slice(key.length + 1).trim();
  if (!/^[>|][+-]?\d*$/.test(value)) return value;
  /** @type {string[]} */
  const block = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !/^\s/.test(l)) break;
    block.push(l.trim());
  }
  return block.join(value.startsWith(">") ? " " : "\n").trim();
}

/**
 * What Claude Code lists in every session for a skill, agent or command: its name and description.
 * @param {string} text @param {string} name used when the front matter has none (commands)
 */
function listing(text, name) {
  const { frontMatter } = splitFrontMatter(text);
  if (frontMatter === null) return "";
  const description = frontMatterField(frontMatter, "description");
  return description ? `${frontMatterField(frontMatter, "name") || name}: ${description}` : "";
}

/**
 * @param {string} cwd
 * @param {string[]} files tracked files
 * @returns {{ always: number, onDemand: number, listings: number, files: number, untracked: string[], outside: string[],
 *   repeated: Array<{ line: string, files: string[], everySession: boolean }>, repeatedLines: number, repeatedEverySession: number }}
 */
export function instructionBudget(cwd, files) {
  const tracked = new Set(files);
  // Whether AGENTS.md loads is decided by tracked files too: an untracked CLAUDE.local.md is one machine's.
  const setup = agentSetup(cwd, files, { tracked: true });
  const loaded = setup.instructions.filter((i) => i.loads !== "other");
  const counted = loaded.filter((i) => tracked.has(i.path));
  const untracked = loaded.filter((i) => !tracked.has(i.path)).map((i) => i.path);

  // Skill, agent and command descriptions sit in every session's context so the agent can choose them.
  let listings = 0;
  // Read as the scan reads: a listing linked out of the repository is not read, so not counted (agentSetup names it).
  const pf = projectFiles(cwd);
  for (const f of files) {
    const m = /^\.claude\/(?:skills\/([^/]+)\/SKILL\.md|agents\/([^/]+)\.md|commands\/(.+)\.md)$/.exec(f);
    if (!m) continue;
    const text = pf.read(f);
    if (typeof text === "string") listings += Buffer.byteLength(listing(text, m[1] ?? m[2] ?? m[3]), "utf8");
  }

  /** @type {Map<string, { line: string, files: Map<string, string> }>} */
  const seen = new Map();
  for (const i of counted) {
    const text = readOrNull(join(cwd, i.path));
    if (text === null) continue;
    // Code blocks as the scan reads them (a block ends at a fence of its own character, as long or longer).
    for (const raw of outsideFences(text)) {
      if (/^\s*#/.test(raw)) continue;
      const key = ruleKey(raw);
      if (key.length < MIN_RULE) continue;
      const entry = seen.get(key) ?? { line: raw.trim(), files: new Map() };
      entry.files.set(i.path, i.loads);
      seen.set(key, entry);
    }
  }
  const repeated = [...seen.values()]
    .filter((e) => e.files.size > 1)
    .map((e) => ({
      line: clipped(e.line, 120),
      files: [...e.files.keys()].sort(),
      // With a copy in an every-session file, the rule is loaded twice whenever the other copy loads.
      everySession: [...e.files.values()].includes("always"),
    }))
    .sort((a, b) => Number(b.everySession) - Number(a.everySession) || (a.line < b.line ? -1 : 1));

  const sum = (/** @type {string} */ kind) => counted.filter((i) => i.loads === kind).reduce((n, i) => n + i.bytes, 0);
  return {
    always: sum("always") + listings,
    onDemand: sum("on-demand"),
    listings,
    files: counted.length,
    untracked,
    // What leads out of the repository is not read, so not counted: said beside the count.
    outside: setup.outside,
    repeated: repeated.slice(0, 20),
    repeatedLines: repeated.length,
    repeatedEverySession: repeated.filter((r) => r.everySession).length,
  };
}

/**
 * One a cycle: `securityAudit` marks a cycle whose audit slot was the security audit, and `covers` lists the keys of
 * the records it covers (plan/audit.mjs counts the cycles no mark covers).
 * @typedef {{ kind: "budget", date: string, commit: string, always: number, onDemand: number, repeatedLines: number, replaces?: string, securityAudit?: true, covers?: string[] }} BudgetRecord
 */

/** A key as a mark lists it, and as a record names the one it replaces: the first 16 hex digits of the line's SHA-256. */
export const KEY = /^[0-9a-f]{16}$/;

/**
 * A record's key: the first 16 hex digits of the SHA-256 of its line, a trailing CR and a leading byte order mark
 * dropped (a checkout with CRLF, an editor's mark: the same record).
 * @param {Buffer} line
 */
export function lineKey(line) {
  let bytes = line;
  if (bytes.length && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, -1);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * One line of the metrics log as a value, undefined when it does not parse. A byte order mark an editor put at its
 * start is dropped: the same record, for the budget, the record that replaces it and the audit's count alike.
 * @param {string} line
 */
export function logEntry(line) {
  try {
    return JSON.parse(line.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/**
 * The lines of a metrics log that hold something, oldest first: each line's key (lineKey, from its bytes, so a line
 * that is not UTF-8 keeps its key) and its value (logEntry; undefined when it does not parse).
 * @param {Buffer | null} bytes
 * @returns {{ key: string, value: any }[]}
 */
export function logLines(bytes) {
  /** @type {{ key: string, value: any }[]} */
  const out = [];
  if (!bytes) return out;
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start);
    const line = bytes.subarray(start, end === -1 ? bytes.length : end);
    start = end === -1 ? bytes.length : end + 1;
    const text = line.toString("utf8");
    if (text.trim()) out.push({ key: lineKey(line), value: logEntry(text) });
  }
  return out;
}

/** The key a budget record names in `replaces`, or null. @param {any} value */
export const replacesOf = (value) => (value && typeof value.replaces === "string" && KEY.test(value.replaces) ? value.replaces : null);

/**
 * The records that count, oldest first: the log is only appended to, and a record that another names in
 * `replaces` (the key of the line it replaced, written by recordBudget) is no record of its own, wherever the lines
 * stand (a merge with merge=union orders them as it likes). A log written before the field reads as it was. The
 * budget, doctor and the audit's count read the log so.
 * @template T @param {T[]} records @param {(r: T) => string} keyOf @param {(r: T) => string | null} replacesOf
 * @returns {T[]}
 */
export function currentRecords(records, keyOf, replacesOf) {
  const replaced = new Set(records.map(replacesOf).filter((k) => k !== null));
  return records.filter((r) => !replaced.has(keyOf(r)));
}

/**
 * Budget records in the metrics log (one JSON line each, `kind: "budget"`), oldest first, those that count
 * (currentRecords). A line that does not parse is counted (`skipped`), not read as zero; a budget record with no
 * commit (a string, empty when recorded outside a repository) or no whole, non-negative size in bytes is counted
 * apart (`unusable`). doctor and the budget command name each.
 * @param {string} path
 * @param {string} [root] the repository: inside it no link leads to the log (core/files.mjs readRegular)
 * @returns {{ records: BudgetRecord[], skipped: number, unusable: number }}
 */
export function readBudgets(path, root = dirname(path)) {
  const lines = logLines(readRegular(root, path));
  const skipped = lines.filter((l) => l.value === undefined).length;
  const budgets = lines.filter((l) => l.value?.kind === "budget");
  /** @type {BudgetRecord[]} */
  const records = [];
  let unusable = 0;
  for (const { value: o } of currentRecords(budgets, (l) => l.key, (l) => replacesOf(l.value))) {
    if (Number.isSafeInteger(o.always) && o.always >= 0 && typeof o.commit === "string") records.push(o);
    else unusable++;
  }
  return { records, skipped, unusable };
}

/**
 * The record a change is measured against: the newest one made at another commit, so recording twice in
 * one cycle does not hide the cycle's growth.
 * @param {BudgetRecord[]} records @param {string} commit
 */
export function previousBudget(records, commit) {
  return [...records].reverse().find((r) => r.commit !== commit) ?? null;
}

/**
 * The record a new one at `commit` replaces: the newest that counts at that commit (none for an empty commit).
 * @template {{ commit: unknown }} T @param {T[]} current oldest first @param {string} commit
 */
export function replacedAt(current, commit) {
  return commit ? ([...current].reverse().find((r) => r.commit === commit) ?? null) : null;
}

/**
 * Record the budget, one record per commit (the full hash: a short one changes length from machine to
 * machine). At a commit that already has a record, the new one names it in `replaces` (its line's key) and replaces
 * it for every reader (currentRecords): an edit made after recording (the cycle's own clean-up) is counted, and
 * each commit has one record that counts. The replacement holds what this call says, so a security audit is marked
 * again when it is recorded again. The log is only appended to: no line is rewritten, so the file keeps its mode
 * and every other line its bytes.
 * @param {string} cwd project directory
 * @param {string} metricsLog `paths.metricsLog`
 * @param {{ always: number, onDemand: number, repeatedLines: number }} budget
 * @param {{ date: string, commit: string, covers?: string[] }} at `covers`: given for a mark, the keys it covers
 * @returns {{ path: string, entry: BudgetRecord, replaced: boolean, replacedDate?: string, replacedEntry?: any }}
 *   `replacedDate` and `replacedEntry`: the record replaced
 */
export function recordBudget(cwd, metricsLog, budget, at) {
  const path = resolve(cwd, metricsLog);
  const budgets = logLines(readRegular(cwd, path)).filter((l) => l.value?.kind === "budget");
  const current = currentRecords(budgets, (l) => l.key, (l) => replacesOf(l.value)).map((l) => ({ ...l, commit: l.value.commit }));
  const was = replacedAt(current, at.commit);
  const last = was?.value ?? null;
  /** @type {BudgetRecord} */
  const entry = { kind: "budget", date: at.date, commit: at.commit, always: budget.always, onDemand: budget.onDemand, repeatedLines: budget.repeatedLines };
  if (was) entry.replaces = was.key;
  if (at.covers) Object.assign(entry, { securityAudit: true, covers: at.covers });
  // Read and appended to only as a regular file: a link inside the repository, a FIFO or a device is refused. A last
  // line cut short (a write that was killed) stays a line of its own: glued onto it, the record would never be read;
  // an append that fails is cut off again, as this process alone writes the log (writeState's `sole`).
  writeState(cwd, path, JSON.stringify(entry) + "\n", "append", { sole: true });
  if (last) return { path, entry, replaced: true, replacedDate: typeof last.date === "string" ? last.date : "", replacedEntry: last };
  return { path, entry, replaced: false };
}
