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

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentSetup } from "./scan.mjs";
import { readIfThere } from "../core/files.mjs";
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
 * @returns {{ always: number, onDemand: number, listings: number, files: number, untracked: string[],
 *   repeated: Array<{ line: string, files: string[], everySession: boolean }>, repeatedLines: number, repeatedEverySession: number }}
 */
export function instructionBudget(cwd, files) {
  const tracked = new Set(files);
  const setup = agentSetup(cwd, files);
  const loaded = setup.instructions.filter((i) => i.loads !== "other");
  const counted = loaded.filter((i) => tracked.has(i.path));
  const untracked = loaded.filter((i) => !tracked.has(i.path)).map((i) => i.path);

  // Skill, agent and command descriptions sit in every session's context so the agent can choose them.
  let listings = 0;
  for (const f of files) {
    const m = /^\.claude\/(?:skills\/([^/]+)\/SKILL\.md|agents\/([^/]+)\.md|commands\/(.+)\.md)$/.exec(f);
    if (!m) continue;
    const text = readOrNull(join(cwd, f));
    if (text !== null) listings += Buffer.byteLength(listing(text, m[1] ?? m[2] ?? m[3]), "utf8");
  }

  /** @type {Map<string, { line: string, files: Map<string, string> }>} */
  const seen = new Map();
  for (const i of counted) {
    const text = readOrNull(join(cwd, i.path));
    if (text === null) continue;
    let fenced = false;
    for (const raw of text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
      if (fenced || /^\s*#/.test(raw)) continue;
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
      line: e.line.length > 120 ? e.line.slice(0, 117) + "…" : e.line,
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
    repeated: repeated.slice(0, 20),
    repeatedLines: repeated.length,
    repeatedEverySession: repeated.filter((r) => r.everySession).length,
  };
}

/**
 * @typedef {{ kind: "budget", date: string, commit: string, always: number, onDemand: number, repeatedLines: number }} BudgetRecord
 */

/**
 * Budget records in the metrics log (one JSON line each, `kind: "budget"`), oldest first.
 * A line that does not parse is counted (`skipped`), not read as zero; a budget record with no commit (a
 * string, empty when recorded outside a repository) or no whole, non-negative size in bytes is counted apart
 * (`unusable`). doctor and the budget command name each.
 * @param {string} path
 * @returns {{ records: BudgetRecord[], skipped: number, unusable: number }}
 */
export function readBudgets(path) {
  const text = readOrNull(path);
  if (text === null) return { records: [], skipped: 0, unusable: 0 };
  /** @type {BudgetRecord[]} */
  const records = [];
  let skipped = 0;
  let unusable = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.kind === "budget") {
        if (Number.isSafeInteger(o.always) && o.always >= 0 && typeof o.commit === "string") records.push(o);
        else unusable++;
      }
    } catch {
      skipped++;
    }
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
 * Record the budget, one record per commit (the full hash: a short one changes length from machine to
 * machine). At a commit that already has the last record, that record is replaced: an edit made after
 * recording (the cycle's own clean-up) is counted, and the log keeps one line per commit.
 * @param {string} cwd project directory
 * @param {string} metricsLog `paths.metricsLog`
 * @param {{ always: number, onDemand: number, repeatedLines: number }} budget
 * @param {{ date: string, commit: string }} at
 * @returns {{ path: string, entry: BudgetRecord, replaced: boolean }}
 */
export function recordBudget(cwd, metricsLog, budget, at) {
  const path = resolve(cwd, metricsLog);
  /** @type {BudgetRecord} */
  const entry = { kind: "budget", date: at.date, commit: at.commit, always: budget.always, onDemand: budget.onDemand, repeatedLines: budget.repeatedLines };
  const before = readOrNull(path) ?? "";
  const lines = before.split("\n").filter((l) => l.trim() !== "");
  let lastAt = -1;
  for (let i = lines.length - 1; i >= 0 && lastAt === -1; i--) {
    try {
      if (JSON.parse(lines[i])?.kind === "budget") lastAt = i;
    } catch {
      // Not a record; readBudgets counts it.
    }
  }
  const last = lastAt === -1 ? null : JSON.parse(lines[lastAt]);
  if (last && at.commit && last.commit === at.commit) {
    lines[lastAt] = JSON.stringify(entry);
    writeFileSync(path, lines.join("\n") + "\n");
    return { path, entry, replaced: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  // A last line cut short (a write that was killed) stays a line of its own: glued onto it, the record would never be read.
  appendFileSync(path, (before === "" || before.endsWith("\n") ? "" : "\n") + JSON.stringify(entry) + "\n");
  return { path, entry, replaced: false };
}
