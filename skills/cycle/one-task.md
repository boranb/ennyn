# One task — a run of one named node or fix

Asked for one task alone, the cycle takes it under the same protocol and closes with the same report: no slots, no mechanization task, no legacy audit.

**When:** the request, or the skill's arguments, name one graph node or describe one fix. Claude Code adds the arguments to the skill's text as a last line `ARGUMENTS: …`, so a runner in a terminal names the node it runs: the skill's command, then the node's id. Nothing named, or a cycle asked for: section 1 of `SKILL.md`.

**A cycle open** on this clone, started and not closed (this session runs it, or `ennyn.mjs worktrees` lists a worktree marked with a number past the handoff's last cycle): the run does not start, and says so. In that cycle's session a fix in words becomes a node at its closing (section 3, step 1); from another session nothing is written.

**Start** as section 1 does: `ennyn.mjs doctor` shows no ✗ (else stop); the config, the handoff and the graph are read in one turn; `ennyn.mjs leftovers --start` notes HEAD.

**A node named:** an open node of the graph. Done, or no such id: stop and say so; never take a near id for it. Not ready (a `needs` not done, a closed gate): say why, and go on only on the user's plain yes.

**A fix in words:** an open node that already asks for it is the task; else write it first as a node at the end of the list, dated (`graph.fields.since`), its source the user's words and the date. The reviewers check the change against a node's ask, and the rows and the closing name it.

**Nobody to ask** (a runner in a terminal): where this file asks, the run stops and says why.

**The task** runs in a fresh agent on a common brief and a task brief, as a task of a cycle does, in a marked worktree ([task-brief.md](task-brief.md)); on a restart the consolidated brief replaces the task brief and the common brief stays. The session is the orchestrator: the plan, step 7, the verdicts, the failure count, the landing. The session that reruns a verdict's numbers and lands the commit is not the one that wrote it, and a restart takes a fresh agent anyway. A host with no subagents: as task-brief.md says.

**Protocol:** section 2 of `SKILL.md`, every step, split between the agent and the session as in a cycle.

**Its number:** the run is a cycle of one task. It takes the next number after the handoff's last cycle, and the next cycle follows it. That number is every row's `cycle`, the rows' ids (`c<N>-t1-…`), the worktree mark (`ennyn:<N>`) and `ennyn.mjs convergence --cycle <N>`, so the command counts this run's rows and no other's. Under the last cycle's number, the counts of a closed cycle would change.

**A fix's defect** is one row of round 0: its code is older than the run's start, so `pre-existing`, with `bornIn` ([report-formats.md](report-formats.md)), and `caughtBy` what reproduced it. A node that asks for something new has no such row.

**Plan,** three lines: `**One task:** [node id, value and cost; for a fix, the node written for it] — impact table: [required/not needed + why] — checks: [tests, mutation, reviewers]`, then the cycle plan's `**Security:**` and `**Agent mode:**` lines as [report-formats.md](report-formats.md) writes them.

**Closing:** section 3 of `SKILL.md`, every step: graph, handoff, convergence, retire lessons, security checks, budget, push. The handoff names the run (cycle N, one task, its node) and keeps the next step for the next cycle.

**Budget:** `ennyn.mjs budget --record` without `--security-audit`: the run has no audit slot. The record counts as a cycle toward `security.everyCycles`, so work done brings the security audit nearer; when `ennyn.mjs audit` says it is due, the report says the next cycle of four holds it.

**Left out:** section 1's slots (core, mechanization, legacy audit), the picks that fill them, and the cycle plan's `**Discovery:**` and `**Tasks:**` lines.

**Report:** as [report-formats.md](report-formats.md) gives a cycle's: `**Task 1 done:**` or `**Task 1 stopped:**`, then `## Cycle complete` with `### Done` holding result 1 and `### Audit` reading `none: one task`, with the security audit's answer when it is due.
