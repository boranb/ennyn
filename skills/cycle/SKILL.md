---
name: cycle
description: Run one development cycle of four tasks picked from the project's work graph — two core tasks, one mechanization task (turns a recurring defect class into a gate), one legacy audit — each with an impact table before writing, a mutation pass, bounded adversarial review, and a convergence report at the end. Use when asked to "run a cycle", "phase run", "advance the roadmap", or to work through the backlog autonomously.
---

# Cycle — four tasks, measured

No `.ennyn/` in the project yet: run the init skill first. Project settings come from `.ennyn/config.json` (`language` sets the language of every report and commit message you write). Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs" --help` for the helper commands used below.

## 1. Pick the four tasks

Read first, in one turn: the config, the handoff (`paths.handoff`; unset → `HANDOFF.md` at the root) and the graph. The handoff names the commands later steps run (fast test, lint, typecheck, the mutation tool; one it does not name → `commands` and `mutation` of `ennyn.mjs init-scan --json`), the previous cycle's next step and its open risks. Note HEAD: the cycle's bypass count starts there.

| Slot | Source | Rule |
|---|---|---|
| Core ×2 | work graph (`paths.graph`): open, ungated, all `needs` done | Highest value/cost; prefer nodes sharing a `cluster` (one session opens the same files once). Complete, independently verifiable, user-visible value. |
| Mechanization ×1 | `ennyn.mjs mechanization` | A node with `mechanization: true`: turn a recurring defect class into a gate, test, type or lint, then delete the matching prose rule. None ready → the slot becomes a third core task. A graph it refuses (exit 1, the reasons on stderr) is fixed first: the core slots read the same graph. |
| Legacy audit ×1 | `ennyn.mjs audit`: the security audit unless it answers not due; else the audit queue (oldest / never audited / recently affected by a shared change) | Security audit: every path it lists, with a path table (every way to reach what each protects). Else re-check a finished feature: invalid/empty/max input, permission denied, network failure, repeated action, refresh, stale data. Small findings are fixed in the same task with a regression test; large ones become graph nodes. |

A critical problem (crash, data loss, auth break, blocker) may replace one core slot. Write the plan as [report-formats.md](report-formats.md) shows, security line included. Do not wait for approval between tasks; push only with the user's approval.

## 2. Task protocol (every task, in order)

1. **Read** only the relevant files. Independent reads (files, searches, history) go in the **same turn**.
2. **Design brief** for UI work — [design-brief.md](design-brief.md).
3. **Impact table** before the first edit when the change touches a shared decision, predicate, gate or accept/reject rule: `ennyn.mjs impact --symbol <name> --files <paths>`, then complete the five rows (S1 who else reads this · S2 other paths to this state · S3 newly accepted/rejected inputs · S4 at the ceiling / when measurement fails · S5 where fakes come from). Each row is answered by a command's output, never by recall. For heuristic rules, dictionaries and thresholds: build an accept **and** reject corpus and a failing test first. Details: [impact-table.md](impact-table.md).
4. **Implement**, matching existing patterns.
5. **Test** the changed files with the handoff's fast test command, then its lint and typecheck when it names them.
6. **Mutation pass** on the changed files with the handoff's mutation tool; with none (or "not applicable"), hand-pick mutants of the changed lines and run them with `ennyn.mjs mutate <list.json> --command "<fast test>"`, adding `--check "<parse command> {file}"` for files other than JavaScript and JSON (one that does not parse is invalid, never killed; with no check its kills are not counted). It edits files in place: while a reviewer reads the tree, run it in a separate worktree. Record the first-run result (`killed/total`); write a test for each survivor or justify it as equivalent.
7. **Review** with the reviewer agents that match the change: those in `review.agents` when set, otherwise Ennyn's (correctness, security, data correctness). Give them the changed files, the impact table and [finding-schema.md](finding-schema.md). **At most two rounds**: round two looks only at the diff of round-one fixes; a third round needs an independent signal (test, mutation run, real measurement) showing a new class. For security work the round limit is replaced by the path table: list every way to reach the protected state first. A critical or high finding left after round two is still fixed, and the fix is proven by a failing-then-passing test instead of another round; if no test can prove it, stop and ask the user.
8. **A fix is a new write.** If a fix changes a row of the impact table, update the table and give round two the delta.
9. **Record findings** with a class (`<catalog id>` or `new: <name>`) and a source (`first-write` · `previous-fix` · `pre-existing`) as you write them; the cycle report counts these.
10. **Sweep** the same pattern project-wide; update the documents the change affects.
11. **Commit** one task per commit, in Ennyn's convention: it replaces any commit rule in the project's own instructions. Subject `type(scope): text` with a type from `commitMsg.types` when they are set; a repair of an earlier commit uses `commitMsg.fixType` and nothing else does. Text in `commitMsg.language` (else `language`). With `commitMsg.style: terse` the body holds no prose, only the lines below. Subject + short body; detail goes to the graph node or the lesson catalog. Body lines: `Impact: …` · `Review-Rounds: N` · `Mutation: first a/b · last c/d`. `ennyn.mjs commit-check <file>` validates the shape. Move to the next task.

Never report an unrun test, command or check as done; write `not applicable` instead. Three consecutive failed verification rounds on one task → stop and report: task, remaining failure, attempts, likely root cause, changed files, safest next step.

## 3. End of cycle

1. **Graph:** update every node whose status changed; every newly discovered or leftover item becomes a node.
2. **Handoff** (`paths.handoff`): what was done, what is next, open risks — each risk with a permanent home (a document that does not rotate). Its commands stay for the next cycle.
3. **Convergence** in the format of [report-formats.md](report-formats.md): real escapes · fix-introduced · pre-existing · gate-caught, and new classes per review round. The most recurring class becomes a graph node with `mechanization: true` and its source class; if none, write why.
   Count the commit-shape bypasses of this cycle: `ennyn.mjs bypass --from <HEAD noted at the start>`. Each use is listed with its reason; a bypass that recurs is a gate to fix, not a habit.
4. **Retire lessons:** in one lesson file touched this cycle, mark each lesson keep / update / merge / delete; delete the prose of any lesson whose rationale now lives in a test or gate.
5. **Security checks:** `ennyn.mjs deps` (it asks `security.deps.advisories` about public packages; `""` asks none) and doctor's CI line (none: no CI file); each result goes into the report as found, clean or unmeasured (naming what did not run), never clean by default. A finding is fixed now or becomes a graph node.
6. **Budget:** after the last edit of the cycle, `ennyn.mjs budget --record`; add `--security-audit` only when this cycle's audit was the security audit (if `audit` rules it out, the record is unmarked, exit 1: the audit comes back early). The record counts the cycle; a mark covers the cycles recorded before it. Recording again at the same commit replaces it. Commit the metrics log with the graph and the handoff. Text loaded in every session that grew needs a reason in the report. A repeated rule keeps one copy, in the narrowest file that loads where it is needed.
7. **Push:** `ennyn.mjs push-check`; state the unpushed count and **ask** for push approval.
