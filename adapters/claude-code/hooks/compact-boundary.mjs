#!/usr/bin/env node
/**
 * Claude Code PreCompact hook: idle compaction waits while a task is mid-way, below a ceiling; every other compaction
 * goes ahead as it would with no hook. ../compact-boundary.mjs has the rule and why it is shaped so.
 *
 * Exit 2 holds a compaction; every other path ends 0 and lets it run. No config (../project.mjs), or
 * `compaction.defer: false`: the hook is off, past the one git call that finds the config it asks nothing, and nothing
 * is printed or written. A config that does not load: no ask, it has no language, and the reason on stderr. Every other
 * pass asks the summary on stdout for the task, its files and its next step, and names the files when the tree was
 * read. Every block and pass is one JSON line in the state dir, `compact-boundary.jsonl`, with numbers and no names; a
 * log that cannot be written changes nothing. With no git dir there is no log and nothing is created, and none when
 * the tree or the project git names is not the session's. Stderr is Claude Code's debug log on a pass, and read by no
 * one else.
 *
 * The tree is the one in the input's `cwd`: after EnterWorktree that is where the session works and commits. The config
 * and the log stay the project's, where the session started.
 */

import { isAbsolute, join } from "node:path";
import { appendBounded } from "../../../core/files.mjs";
import { resolveStateDir, stateRoot } from "../../../core/git.mjs";
import { shown, t } from "../../../core/i18n.mjs";
import { SETTLE_MS, gitDirOf, judge, real, subagentBusy, summaryRequest, tailFacts, transcriptTail, treeFacts, within } from "../compact-boundary.mjs";
import { hookProjectDir, projectConfig } from "../project.mjs";

/** The log's ceiling, in bytes; past it the older half goes. */
const LOG_BYTES = 256 * 1024;

/** @returns {Promise<string>} */
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * One line for the log: what was measured, no name and no text. Fields that come from the input are kept to plain
 * values, so nothing Claude Code or a transcript holds is copied here.
 * @param {ReturnType<typeof judge>} v @param {unknown} trigger @param {unknown} session @param {number} now
 */
function logLine(v, trigger, session, now) {
  return `${JSON.stringify({
    at: new Date(now).toISOString(),
    session: typeof session === "string" && /^[A-Za-z0-9-]{1,64}$/.test(session) ? session : null,
    verdict: v.block ? "block" : "pass",
    reason: v.reason,
    mark: v.mark,
    trigger: trigger === "auto" || trigger === "manual" ? trigger : null,
    quiet: v.quiet,
    tokens: v.tokens,
    window: v.window,
    ceiling: v.ceiling,
    changed: v.changed === null ? null : v.changed.length,
    edit: v.edit,
  })}\n`;
}

/**
 * core/git.mjs's rule for a state file, that no commit writes in the common git dir, holds only for a real one. Every
 * bare-looking folder is found by walking up from the session, so a session inside its own git dir is in a folder a
 * commit brought, and what the common dir holds is the commit's, on any git: that folder's `commondir` file can name
 * any folder, so this asks of the git dir and of the session's own folder, and no flag decides it, as a git below 2.38
 * reads such a folder as a repository. A git that names no git dir here means no log. A project above no folder of the
 * session is another repository, reached by `core.worktree`.
 * @param {string} started the session's folder @param {string} projectDir @param {string} stateDir @param {string} line
 */
function log(started, projectDir, stateDir, line) {
  try {
    const here = real(started);
    if (within(gitDirOf(started), here) || !within(real(projectDir), here)) return;
    const path = join(resolveStateDir(projectDir, stateDir), "compact-boundary.jsonl");
    appendBounded(stateRoot(projectDir, path), path, line, LOG_BYTES);
  } catch {
    // A log that cannot be written never changes the verdict.
  }
}

async function main() {
  /** @type {any} */
  let input = null;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // The project directory may still come from the environment.
  }
  if (input === null || typeof input !== "object") input = {};
  const started = hookProjectDir(input);
  let config;
  try {
    config = projectConfig(started);
  } catch (err) {
    // One line, and no control character a terminal would act on: the config is the project's text.
    const error = shown(String(/** @type {Error} */ (err).message).trim().replace(/\s*\n\s*(?:- )?/g, "; ")).text;
    process.stderr.write(`${t("compact.notApplied", { error }, "en")}\n`);
    return;
  }
  if (!config?.compaction.defer) return;
  const { projectDir, language } = config;
  await new Promise((done) => setTimeout(done, Math.max(0, SETTLE_MS - process.uptime() * 1000)));
  const now = Date.now();
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : started;
  const verdict = judge({
    trigger: input.trigger,
    prompt: input.prompt_id,
    now,
    tree: () => treeFacts(cwd),
    tail: (top) => {
      const text = transcriptTail(input.transcript_path);
      return text === null ? null : tailFacts(text, top === null ? [cwd] : [top, cwd]);
    },
    subagents: () => subagentBusy(input.transcript_path, now),
  });
  if (verdict.reason !== "other-tree") log(started, projectDir, config.paths.stateDir, logLine(verdict, input.trigger, input.session_id, now));
  if (verdict.block) {
    process.stderr.write(`${t("compact.held", { files: verdict.changed?.length ?? 0, tokens: verdict.tokens ?? 0, ceiling: verdict.ceiling ?? 0 }, "en")}\n`);
    process.exitCode = 2;
    return;
  }
  if (verdict.why !== undefined) process.stderr.write(`${t("compact.unmeasured", { why: `${verdict.reason}: ${verdict.why}` }, "en")}\n`);
  process.stdout.write(`${summaryRequest(verdict.changed ?? [], language)}\n`);
}

// Claude Code stopped reading: end without a stack trace, as a process ended by SIGPIPE. The verdict is the exit code.
process.stdout.on("error", (e) => {
  if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPIPE") process.exit(141);
  throw e;
});
process.stderr.on("error", () => {});

// A hook that fails lets the compaction run.
main().catch(() => {});
