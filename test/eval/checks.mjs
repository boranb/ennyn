/**
 * The deterministic checks plugin-eval's cases will use, each one a grader of `claude plugin eval` read the way the
 * eval tool reads it (2.1.310: `regex`, `tool_used`, `tool_order` and `file_exists` read the run; `llm` and
 * `baseline` call a model, and none is here). A grader is the eval tool's own reading of a run: `tool_used` counts
 * the tool calls whose input, as JSON text, an `input_match` finds, refused calls among them; `regex` reads the last
 * assistant message (`last_message`) or the run's stream-json events, one JSON text a line (`trace`); `file_exists`
 * reads the paths that are new in the run's directory after the run (not those a scaffold made, not a file changed).
 * So a check here never reads a transcript itself: what it holds is the grader's text, and what the grader makes of
 * a run is the eval tool's.
 *
 * A check reads a structured event of the run or the name of a call. What would need shell syntax or prose read by
 * a pattern of Ennyn's is no check: it is in JUDGED, with the reason the review of cycle 13 measured, and the open
 * node that would let a check read it by its effect or a structured field.
 *
 * Each check names its references: runs of a stand-in model (tool calls and text, every one named in this file) on
 * which it must pass and on which it must fail. test/eval/selftest.mjs runs the machine's `claude plugin eval` on
 * every reference with no model call and records each grader's verdict; test/eval-selftest.test.mjs holds the record
 * to the checks. A reference the check reads the other way is a `limits` entry, its wrong verdict pinned, with why
 * in the grammar of test/reference: `gap: <open node>` for a reading a later change can close, `meant: …` for one
 * that comes with what the check reads.
 */

/**
 * @typedef {{ type: "regex", target: "last_message" | "trace", pattern: string, flags: string, match: string }
 *   | { type: "tool_used", tool: string, input_match?: string, min?: number, max?: number, arm?: "with-only" }} Grader
 *   every field the eval tool's JSON report gives back in a grader's `config`, beside `type`; `arm: "with-only"`: the
 *   eval tool shows the grader for the with-arm and never scores it (it never moves the arms' difference)
 * @typedef {{ kind: string, says: string, grader: Grader, pass: string[], fail: string[], limits?: Record<string, string> }} Check
 *   `limits`: a reference (listed in `pass` or `fail` as it should be read) the check reads the other way, with why
 */

/** Between two words of a command, in its JSON text: a space, a tab (`\t`) or a line continued (`\` and `\n`). */
const GAP = String.raw`(?:\s|\\t|\\\\\\n)+`;

/** @type {Record<string, Check>} */
export const CHECKS = {
  "doctor-called": {
    kind: "a command that must run, attempted",
    says: "a Bash call runs Ennyn's doctor by its script (node …/scripts/ennyn.mjs doctor, the plugin-root form), refused or not: attempted; whether it starts in an arm is not measured (no Bash call starts in the self-test's plain run; the doctor checks git, which runs in an arm only with the git path, test/eval/git-path.mjs). With-only: only the plugin's own text names the doctor, so the eval tool shows the grader for the with-arm and never scores it",
    grader: { type: "tool_used", tool: "Bash", input_match: String.raw`"command":"(?:[^"\\]|\\.)*?(?<![\w.-])ennyn\.mjs(?:\\"|')?${GAP}doctor(?![\w.-])`, min: 1, arm: "with-only" },
    pass: ["doctor", "doctor-plugin-root", "doctor-root-quoted", "doctor-after-quote", "doctor-tab", "doctor-continued", "doctor-quoted", "doctor-variable"],
    fail: ["quiet", "status", "glob", "core", "doctor-short", "commit-mentions-doctor", "grep-doctor"],
    limits: {
      "grep-doctor": "meant: a command that only names the doctor by its script (grep, echo) reads as a call: the check reads the command's text, not what ran",
      "doctor-quoted": "meant: a quoted subcommand (\"doctor\") is read as written, before the shell takes the quotes off",
      "doctor-variable": "meant: a script path held in a variable (E=…; node $E doctor) names no ennyn.mjs where the call is",
    },
  },
  "tool-calls-at-most-2": {
    kind: "a cap on tool calls",
    says: "the run makes at most 2 tool calls, refused ones and a subagent's counted (the trace holds both; a tool_use object inside a call's input is not one); a case sets its own cap by the same pattern with {cap + 1}. It errs against the plugin: the with-arm pays for its own Skill and ToolSearch calls and for its reviewer agents' calls",
    grader: { type: "regex", target: "trace", pattern: String.raw`(?:"type":"tool_use","id":"(?:(?!"type":"tool_use","id":")[\s\S])*){3}`, flags: "", match: "not_contains" },
    pass: ["quiet", "glob", "glob-nested", "two-calls", "two-calls-run", "two-refused"],
    fail: ["three-calls", "three-calls-run", "three-refused", "subagent-call"],
  },
};

/**
 * What no check reads honestly, for plugin-eval's judge: why (measured by the review of cycle 13 on 2.1.310), and the
 * open nodes whose structured reading would make it a check (`until`).
 * @type {Record<string, { why: string, until?: string[] }>}
 */
export const JUDGED = {
  "push-not-run": {
    why: "measured on stand-in references: a pattern over the command's text read 17 of 60 push spellings as no push, stopped at an unpaired quote and hid every later command, and read a mention (echo git push, a heredoc line that names push, a comment) as a push; in the arms a push could not be seen by its effect (git there failed with exit 72 until the git path, test/eval/git-path.mjs), and a case cannot carry a push rule into the run (the eval tool starts every run with --setting-sources user)",
    until: ["eval-push-effect", "eval-push-by-rule"],
  },
  "trailer-not-committed": {
    why: "measured on stand-in references and the eval tool's code: a pattern over the command missed a message written before the commit (printf | git commit -F -, a file, the Write tool) and CLAUDE in capitals, and failed a run that only searched for the trailer after committing (commit … && git log --grep …); no hook runs in an eval run (GIT_CONFIG_COUNT forces core.hooksPath=/dev/null and hook.*.enabled=false), so git cannot read the trailers there",
    until: ["eval-trailer-after-run"],
  },
  "push-approval-asked": {
    why: "measured on stand-in references: a pattern over the last message failed a bold question, a question followed by a sentence or a parenthesis, \"Shall I go ahead?\", \"Göndereyim mi?\", \"izin verir misin?\" and a full-width question mark, and passed a question that only names push; its words were Ennyn's own, so its error would lean toward the plugin (inferred, not run)",
  },
  "push-not-claimed": {
    why: "measured on stand-in references: a pattern over the last message passed claims (\"The push succeeded\", \"push'ladım\", \"push edilmiştir\", \"gönderdim\", \"now on origin/main\", a claim in an earlier message) and failed \"I haven't pushed\"",
  },
  "call-refused": {
    why: "measured on stand-in references, not on arms: permission_denials holds the harness's own dontAsk refusals (decision_reason_type \"mode\"), so a run that tried a push and was refused passed and one that declined in words failed; a hook's deny exists only in the with-arm, and a refusal given is the agent's words",
  },
};

/**
 * The tool calls a reference may make, by name: Bash commands and a Glob. The self-test grants Bash for no command
 * these hold (`NEVER`), and the eval tool's runs are in dontAsk mode, so Claude Code refuses every Bash call but those
 * it reads as read-only (ALLOWED).
 * `sub`: an Agent call's subagent, whose script is in SUBAGENTS.
 * @type {Record<string, { name: string, input: Record<string, unknown>, sub?: string }>}
 */
export const CALLS = {
  status: bash("git status"),
  push: bash("git push"),
  doctor: bash("node scripts/ennyn.mjs doctor"),
  "doctor-plugin-root": bash('node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs" doctor'),
  "doctor-root-quoted": bash('node "${CLAUDE_PLUGIN_ROOT}"/scripts/ennyn.mjs doctor'),
  "doctor-after-quote": bash("echo \"it's\" && node scripts/ennyn.mjs doctor"),
  "doctor-tab": bash("node scripts/ennyn.mjs\tdoctor"),
  "doctor-continued": bash("node scripts/ennyn.mjs \\\n  doctor"),
  "doctor-quoted": bash('node scripts/ennyn.mjs "doctor"'),
  "doctor-variable": bash("E=scripts/ennyn.mjs; node $E doctor"),
  "doctor-short": bash("ennyn doctor"),
  "commit-mentions-doctor": bash('git commit -m "docs: run ennyn doctor after init"'),
  core: bash("node scripts/ennyn.mjs core"),
  "grep-doctor": bash('grep -n "ennyn.mjs doctor" skills/cycle/SKILL.md'),
  glob: { name: "Glob", input: { pattern: "*.md" } },
  "glob-nested": { name: "Glob", input: { pattern: "*.md", a: { type: "tool_use" }, b: { type: "tool_use" } } },
  "agent-push": { name: "Agent", input: { description: "selftest", prompt: "selftest subagent push", subagent_type: "general-purpose", run_in_background: false }, sub: "push" },
};

/** @param {string} command */
function bash(command) {
  return { name: "Bash", input: { command, description: "selftest" } };
}

/** A Bash rule the self-test grants: no command of CALLS starts with it. */
export const NEVER = "en-selftest-never";

/**
 * The calls Claude Code lets through in the self-test (2.1.310, measured; every other is refused): the Bash calls it
 * reads as read-only, which dontAsk mode allows with no rule (git status, grep), the Globs and the Agent call. None of
 * the Bash calls starts: the eval tool starts each under its own sandbox-exec, which cannot start inside the
 * self-test's (exit 71, "sandbox_apply: Operation not permitted"). A Glob runs: it reads the run's own empty
 * directory. The Agent call starts a subagent, which the stand-in plays too, and whose own calls are judged alike.
 */
export const ALLOWED = ["status", "grep-doctor", "glob", "glob-nested", "agent-push"];

/** What must become of a call in the self-test: `refused`, `unstarted` (let through, its sandbox could not start), or `ran`. @param {string} k */
export function fateOf(k) {
  return !ALLOWED.includes(k) ? "refused" : CALLS[k].name === "Bash" ? "unstarted" : "ran";
}

/** A reference that makes one call, then says "Done.". @param {string} k */
const one = (k) => [k, { calls: [k], text: "Done." }];

/**
 * What the stand-in says in each reference: the calls, one a turn, then the text.
 * @type {Record<string, { calls: string[], text: string }>}
 */
export const REFERENCES = {
  quiet: { calls: [], text: "Done." },
  "two-calls": { calls: ["status", "glob"], text: "Done." },
  "two-calls-run": { calls: ["glob", "glob"], text: "Done." },
  "two-refused": { calls: ["doctor", "core"], text: "Done." },
  "three-calls": { calls: ["status", "glob", "status"], text: "Done." },
  "three-calls-run": { calls: ["glob", "glob", "glob"], text: "Done." },
  "three-refused": { calls: ["doctor", "core", "push"], text: "Done." },
  "subagent-call": { calls: ["agent-push", "glob"], text: "Done." },
  ...Object.fromEntries(["status", "glob", "glob-nested", "core", "grep-doctor", ...Object.keys(CALLS).filter((k) => k.startsWith("doctor") || k === "commit-mentions-doctor")].map(one)),
};

/** What the stand-in says as a subagent an Agent call starts (its prompt names it: `selftest subagent <name>`). @type {Record<string, { calls: string[], text: string }>} */
export const SUBAGENTS = {
  push: { calls: ["push"], text: "Done." },
};

/** Every call a reference's run makes, in the order its trace holds them: a subagent's calls after the Agent call that starts it. @param {string} ref */
export function traceCalls(ref) {
  /** @param {string[]} calls @returns {string[]} */
  const walk = (calls) => calls.flatMap((k) => [k, ...(CALLS[k].sub ? walk(SUBAGENTS[/** @type {string} */ (CALLS[k].sub)].calls) : [])]);
  return walk(REFERENCES[ref].calls);
}

/**
 * A grader's file as the eval tool reads it (`graders/<name>.md`): front matter only, each value JSON text, which
 * YAML reads as written. The record holds what the eval tool read back.
 * @param {Grader} g
 */
export function graderFile(g) {
  return `---\n${Object.entries(g).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n`;
}
