# Evidence

Ennyn was extracted from a production project (a web application, one author, one coding agent) where the loop ran for nearly 700 sessions. In October 2026 its last 21 cycles were measured to answer one question: why do review rounds and mutation runs keep finding so many defects, and what would reduce them? This page gives the numbers behind each part of the package, their limits, and the published work they were checked against.

## Method and limits

Twelve studies: six on the origin project, six on outside sources.

- **Origin project.** Session transcripts, git history and cycle handoff notes for 21 cycles (October), with an earlier stretch (September) for comparison. Every review finding was entered in a ledger: who found it, where it came from, which defect family it belongs to, whether it repeats. 539 rows.
- **Second rater.** A blind second rating of "could this have been asked before writing?".
- **Outside sources.** Defect-prevention research, process measurement, agent loops used by other teams, and a primary-source check of 16 academic and 9 practitioner claims.

**Limits.** One author and one model; tasks were not assigned at random, and hard tasks get both more research and more review, so the relations below are not causal. 89% of thinking blocks are empty in the transcripts, so "did the author ask?" only sees questions asked visibly (a lower bound). Classification labels are model judgments; the second rater did not agree on "fully" vs "partly" answerable (κ≈0) but did agree on "at least partly". SZZ-style links were 60-67% precise in a hand check of 15; comparisons between months are more reliable than absolute rates.

## Where findings came from

539 findings in 21 cycles, 398 of them product defects (the rest: test blindness, mechanical gate hits, process slips).

| Origin | Product defects |
|---|---|
| Pre-existing (there before the change) | 218 (81 serious) |
| Introduced by a fix | 99 |
| Missed by the first draft | 80 |

| Found by | Findings |
|---|---|
| Review agents (all rounds) | 263 (49%) |
| The author (tests, running it, mutation) | 186 (35%) |
| Commit gate | 44 (8%) |
| CI and production | 17 (2 were escapes of code written in the period) |

76% of serious findings (115 of 152) were found in the expensive layers. Mutation runs and the gate found no serious product defects (none of 64 mutation rows); they find blind tests, dead conditions and latches, which is their job. The pre-existing defects come from the legacy audit and should not go down.

## Fixing findings creates new defects

- 41% of tasks (22/54) took at least two review rounds, 17% at least three.
- Of 32 serious findings in the second and later rounds, 21 (66%) were side effects of the previous round's fix; in tasks that change a heuristic rule, 20 of 23.
- Third and later rounds found a new defect class only twice (sample of 7).
- In security and authentication work, later rounds kept finding other paths of the same class ("the check was added to one path, the sibling path is open"). The problem there was that the paths were not listed up front, not the number of rounds.
- 45% of a task's tool calls came after the first review result. First review to commit: median 43 min with one round, 72 min with two, 77 min with three or more.
- One family, a change that loosens or tightens a rejection rule and newly accepts or rejects the wrong input, was fix-introduced in 43 of 49 rows.

→ Review is capped at two rounds; a third needs an independent signal (`skills/cycle/`, `agents/`, `skills/cycle/finding-schema.md`).

## The questions were known, but asked too late

- Analysis before writing was almost absent: an impact script ran in 2 of 60 tasks, a caller table was written in none. The one common step, a grep for the changed symbol (47/60), did not correlate with the number of findings (ρ=+0.14). A grep finds the symbol's callers; what escaped was a second place making the same decision with another rule, a client/server twin, or another path to the same state.
- The questions themselves were known: 57% of review prompts asked "who else reads this decision?", 22% asked "does this fake come from the real producer?". The author asked the reviewer and did not answer them first.
- The 71 serious new defects by question: newly accepted or rejected inputs 25, who else reads this 15, other paths to this state 10, behaviour at the ceiling or when measurement fails 10, where the fakes come from 4.
- Two raters, 40 change-caused findings: "at least partly answerable before writing" 33/40 and 40/40. On 30 serious defects the blind rater said 10 fully, 18 partly, 2 no (both were outputs of a real model in production).
- Asking before writing directly prevents about a third; for the rest the question needs a measured answer (a corpus, a trial, a failing test).

→ Five-row impact table before the first edit, each row answered by a command (`ennyn impact`, `skills/cycle/impact-table.md`); for heuristic rules, an accept and reject corpus and a failing test come first.

## Code the task did not ask for

From outside sources read on 2026-10-25; Ennyn has not measured this on its own tasks.

- ponytail, an open-source agent skill (MIT), asks a ladder before code is written: does it need to exist, is it already in this codebase, does the platform do it, does an installed dependency, can it be one line, and only then the minimum.
- In its author's own run the ladder cut delivered code by 53% over 38 tasks. The code of 18 of them was run: there the cut was 30%, and the hidden checks' pass rate stayed flat (87/90 against 86/90). The other 20 were judged by a model only.
- An independent run of an older version wrote 53% fewer statements, and robustness fell from 96.7 to 82.5 on stdin scripts whose task did not mention bad input.
- Its rung "already in this codebase" came from duplicated code (its issue 217).
- Two of its figures, 98.9% and 94.4%, come from a file its author marked superseded: the plugin's hook fired in every arm, the baseline's too. They are not used here, and the never-cut list rests on the independent run.
- Ennyn's own source grew from 5,593 lines at cycle 5 to 12,680 at cycle 11.

**Limits.** One author's run, partly judged by a model, and one independent run of an older version. Both count code size and a pass rate, not defects or later rework, and the robustness drop was measured on one kind of program. The row is asked in prose; whether it changes what Ennyn's tasks write is not yet measured.

→ Before its first edit, a core task answers a smallest-change row: the line of the task that asks for each new piece, what the repository already has (`git grep -w`), what the platform, git or an installed dependency does, and only then new code. Validation of input from outside the process, data-loss handling, security, accessibility and anything the task asks for are never cut (`skills/cycle/impact-table.md`).

## Gates stop recurrence, prose does not

| Defect family | Mechanism | Written rule | Result |
|---|---|---|---|
| Late cache write | dedicated check | — | zero for 11 cycles |
| Silent ceiling | ceiling registry check | one rule | caught before the gate |
| First-load size budget | budget gate | a note | gate catches it in seconds |
| Same decision in several places / sibling path | piecemeal only | rule text since 2026-09, two notes | came back in 13 of 14 cycles |
| Fake not taken from the real producer | none | one line | came back in 4 of the last 4 cycles |

- Of 38 "repeats" in the last four cycles, 9 were caught by the gate before the commit hook, 11 were pre-existing defects found by the audit and 4 were the subject of the task. Only 12 were born in new code and caught in an expensive layer. The old single repeat ratio (70-81%) counted gate successes as repeats.
- Proposals that became work-graph nodes were done 8 times out of 11, within 1-4 cycles. Proposals without a node were done 0 times out of 5; one was proposed four cycles in a row.
- A size latch on the rules file kept new lessons out of it; they lived only in a searchable catalog.

→ One slot per cycle for a mechanization node (`ennyn mechanization`); convergence counted in columns that separate these: found in review, fix-introduced, pre-existing, gate-caught, escaped past commit (`skills/cycle/report-formats.md`, `metrics/convergence.mjs`); a lesson whose reason lives in a test is deleted from the rules.

## Context and rules

- Always-loaded rule text was 72-74% of a session's first request and a median 27% of context in later turns. The project's rule text measured 1.98 bytes per token; a size check that assumed 2.4 undercounted by 21%.
- **Path-scoped rules did not load in side copies** (git worktrees, plain copies). In the main tree a Read loaded them in 24 of 24 cases; in side copies, 4 times in more than 2,000 turns. A controlled headless session confirmed it. One cycle wrote seven code commits with no rule in context; it was the cycle with the most "same decision in several places" defects.
- Reading files in parallel could save at most 12.7% of task turns (about 3 minutes per task). A small lever.
- Earlier cycles ran tasks in forks of the orchestrator; the second project's orchestrator stood at about 652K tokens in the middle of its cycle 2. In cycle 15 tasks ran in fresh agents on a written brief; two tasks that reached a third correction (566K and 533K tokens) moved to a new agent with one consolidated brief, and the first passed both reviewers' checks at once. Two tasks, one author: an example, not a measurement.

→ The side-copy hook maps a side-copy path back to the project and injects the matching rules (`hooks/hooks.json`, `adapters/claude-code/`). Each task runs in a fresh agent on a written brief (`skills/cycle/task-brief.md`).

## Speed and rework

| Per task | September | October |
|---|---|---|
| First draft to commit, active time (median) | 22 min (n=49) | 78 min (n=62) |
| Production code lines | 141 | 158 |
| Test lines | 192 | 346 |
| Documentation lines | ~100 | ~200 |
| Review agents | 0.3 | 2.5 |
| Commit message (characters) | 948 | 1,707 |

- With task type and size held fixed, October was 3.07× slower (90% interval 2.30-4.05); with the number of review agents in the model, 2.23×. Task mix explains at most 14%.
- Production code stayed flat while process output doubled.
- Cost: a median 27.3 million tokens per task, nearly all cache reads; cost grows with rounds × context length.
- SZZ-style rework (commits linked to a later fix within 7 days): 8% (14/180) in September, 39% (11/28) in October; 4-5× at all five thresholds tried. Medium confidence: small n.

**Caveat on the rework rate.** On the origin project the "fix" label did not separate defect repair from other work: 233 of the last 348 commits started with `fix(`, and generated files were rewritten in nearly every commit. Over the whole history the same measurement gives 90.8%, and 61.2% with generated files excluded. The absolute rate therefore also counts how often code changes. The September/October comparison uses the same signal on both sides, so it shows direction, not size. `ennyn rework` prints a note when most candidates are fixes; set `metrics.fixSubject` so it matches only real defect repairs. The lasting measure is the source each finding carries when it is written (fix of the previous round, first write, already on the branch), not the commit subject.

→ Commit messages are a subject and a short body, checked before the expensive hook runs (`ennyn commit-check`); `ennyn rework` measures rework every cycle.

## Batch size and the commit gate

- 8 production escapes found in October came from September-October work; 6 of them from work outside the loop, and all of them after one push of 221 commits.
- From the loop itself: 2 production escapes (both had seen 2-3 review rounds) and 4 test or gate escapes visible only in CI.
- The September numbers were partly blind: the end-to-end CI job on the main branch was red for ten pushes and nobody read it.
- Waiting for the hook and its load was 22% of active time; the full gate ran on every commit.

→ Push approval is asked at the end of each cycle and a warning fires above a threshold of unpushed commits (`ennyn push-check`); every commit-gate attempt is recorded so the wait and the waste can be measured before the gate is split (`ennyn gate-record`, `ennyn gate-stats`).

## Baseline

What the next cycles are compared with on the origin project:

| Measure | Baseline | Expected direction |
|---|---|---|
| Tasks with two or more review rounds | 41% | down |
| Fix-introduced share of serious findings in round 2+ | 66% | down |
| Serious defects from first drafts and fixes, per cycle | ~5 (71 / 14) | down |
| Repeats born in new code, caught in an expensive layer | 12 (last 4 cycles) | down |
| Review agents per task | 2.5 | down |
| Active time per task (median) | 78 min | down |
| 7-day rework | 39% (n=28) | down |
| Escapes from the loop to production | 2 in 12 days | not up |
| Serious pre-existing defects found by the audit | 81 | not a target |

Counter-measure: if rounds and time fall while escapes rise, the review cap is loosened again.

## Second project

Three cycles ran on a second project on 2026-10-29: Python, about a hundred commits, a service tested in a simulator, by the same author, with its own agent loop kept beside Ennyn's. The plugin was installed for that project only, at one commit, and the cycles ran from the project's own sessions: the first two in one session, the third in a new one. The orchestrating session counted the findings.

| Cycle | Real escapes | Fix-introduced | Pre-existing | Gate-caught | New classes by review round (1 / 2 / 3) |
|---|---|---|---|---|---|
| 1 | 14 | 10 | 10 | 3 | 13 / 8 / 0 |
| 2 | 16 | 10 | 12 | 2 | 14 / 4 / 0 |
| 3 | 20 | 16 | 17 | 8 | 11 / 4 / 0 |

- No task needed a third round: round 3 found no new class in any cycle, and round 2 found fewer new classes after the first cycle (8, then 4 and 4).
- Fixes kept creating defects at about the same rate (10 to 16 per cycle, against 14 to 20 escapes). One round-two fix that no review read opened a regression; the project's own browser gate caught it before the commit (graph node task-gate-after-round-two).
- The commit gate was never bypassed (0 in three cycles); in the third cycle it stopped four messages, each corrected and committed.
- The mechanization slot was empty in the first two cycles because the project's graph module could not mark a node as one; in the third a task was picked by hand, and the gate it built turned red on 6, 42 and 14 cases when past defects were put back.
- The trial found 17 problems in Ennyn itself; each is a graph node whose source starts with "second-project trial".

**Limits.** The columns are as they were written then ([Reading the convergence columns](#reading-the-convergence-columns)). The table counts findings of every severity, so it does not compare with the baseline's serious-defect rows, and one day says nothing about rework, active time or production escapes. Both projects have the same author and a common loop lineage. A Python project without CI never exercised the dependency check (npm lock files only) or the CI checks.

A third project, by the same author, covered those the same day with init and one cycle: TypeScript, an npm lock file and two CI workflows. The dependency check read 540 lock entries and listed 53 known advisories, all but one in the build chain and that one not reachable in the project; it refused none and left none unmeasured. The CI checks stopped no commit; a commit that only added a permissions block passed, as it should, and the doctor's warning on the default token went away. mutate's parse check, given esbuild, read .ts and .tsx mutants with none invalid. Numbers for the cycle: real escapes 5, fix-introduced 3, pre-existing 9, gate-caught 2; new classes by round 4 and 0.

## Reading the convergence columns

The first 15 cycles on Ennyn itself wrote four numbers. Their sums, read from the 15 closing handoffs, are 438, 407, 321 and 178. The columns changed after that. By the research's reading of the handoffs, a judgement and not a count of rows, all 438 "real escapes" were caught by a reviewer before the commit, so they had not escaped the loop; and what each column held had moved from cycle to cycle. Each column now has one definition, in `skills/cycle/report-formats.md`, and each finding lands in one column. The numbers already written, here and in the handoffs, stay as they are. A new cycle compares with them this way:

| Written then | Sum, 15 cycles | Written now | How to compare |
|---|---|---|---|
| real escape | 438 | found in review | Side by side, as hand counts (below): both count new code a reviewer stopped. The old definition also named CI and production. A CI job that stops a defect before it lands is now a gate; a job on the default branch after the push, and production, are the next cycle's row, reading escaped old. |
| fix-introduced | 407 | fix-introduced | Close. A fix's defect that the author's own reading or an ad hoc run caught could sit in gate-caught then and is fix-introduced now: take those rows out to compare. A defect of a fix that had already landed now counts by age: `pre-existing`, gate-caught only if a gate found it in the cycle that wrote it. |
| pre-existing | 321 | pre-existing + escaped past commit new + escaped past commit old | Add the three. On its own, pre-existing now covers only code whose tree held no Ennyn config. |
| gate-caught | 178 | gate-caught | Not directly: see below. |

The two columns differ in both directions.

- Layers that are no gate. Cycles 4 and 9 already name mutation catches, and cycle 9 the author's own tests; cycles 10 and 11 list them with the author's reading, and cycle 15 with ad hoc differential runs. The new column keeps mutation runs and tests that stay in the repository and drops the other two. To compare, add back from the ledger the rows with `caughtBy` `author-reading` or `measurement` that reach line 4 or line 6 of the table in `report-formats.md`.
- Mutation runs. In cycles 12 to 14 the handoffs keep them outside gate-caught: cycle 12 lists them apart, cycles 13 and 14 not at all. The new column holds them, so to compare with those cycles also take out the rows with `caughtBy` `gate:mutation`.
- Some old defects. A new gate or record that found old defects was counted as gate-caught in cycles 11 (3), 12 (11) and 14 (1), as pre-existing in cycles 5, 6 and 14 (5 of 22 in one task), and not at all in cycle 13 (172 places, five nodes). Now they always count by age.

So the rise in the gate's share of findings, gate-caught over gate-caught + real escape + fix-introduced, from 10% in cycles 1-4 to 29% in cycles 12-15, is not a rise of the new column. Counting only the catches a handoff names to a gate in the repository, and leaving out mutation runs and the author's new tests as well, gives about 8% and 13%, a judgement of ±30%, and most of that rise rests on cycle 12's one record. The new column is neither of these numbers.

All 15 cycles are hand counts. Rechecked against the ledgers that survive, cycle 4 matched, cycle 10 was about 1% apart, and cycle 15's real escapes moved 18%, from 39 to 46. The catches named in a handoff do not always add up either: cycle 8's sum to 5 against 4 written, cycle 9's to 8 against 9. Duplicates were removed only from cycle 10 (10, 13 and 29 in cycles 10 to 12), and cycle 12's gate-caught holds 6 timing failures under load.

The fifth column starts empty. The 321 cannot be split by age: the rows of those cycles record no commit for the defective line. The age rule asks whether a tree held the config, not whether a cycle wrote the line. So a config moved in or committed late reads as pre-existing, while the lines of the commit that adds the config, and old work rebased or squashed in after it, read as through the loop. A report with no such column reads as unreported, not as 0, and a report's `real escape` label reads as `found in review` (`metrics/convergence.mjs`). An old block's gate-caught reads as written, under its old meaning: a block that says `real escape`, or has no fifth column, is an old one.

## What the package does not do

- Add review agents or rounds: no evidence of gain without an outside signal.
- Generic checklists or pre-mortem rituals: checklist reading was no better than reading without one; there is no controlled evidence for pre-mortems in software.
- Add prose rules: a lesson becomes a mechanism or a searchable catalog entry.
- Loosen the legacy audit or mutation runs.

## Published evidence

| Topic | Evidence | Strength |
|---|---|---|
| Repeated review rounds | A second inspection meeting did not find more defects and took longer (Porter et al., TSE 1997, 88 inspections). Multi-round LLM review: recall +0.08, false positives +62% (Song 2026, preprint). Five rounds of "improve" raised critical vulnerabilities by 37.6% (Shukla, preprint). Re-inspection is mostly net positive but yields less than the first (Biffl 2001). | Experimental + opinion |
| Checklists | Checklist readers were no more effective than ad hoc readers; scenario-based reading was ~35% better (Porter, Votta, Basili 1995). | Experimental |
| Defect prevention | Causal analysis with an action team cut development defects by 54% at 0.4-0.5% of resources (Mays et al., IBM 1990). | Case study |
| Clones | About half of unintentionally inconsistent clone changes are faults (Juergens et al., ICSE 2009, 107/203). 16-46% of supplementary patches fall outside the first patch's structural dependencies (Park et al. 2016). | Case study |
| Agents miss sibling paths | In large patches the dominant failure is incomplete propagation: agents stop at edge call sites (ProMax 2026, preprint). LLM change-impact estimates are weak (Stengg 2025). | Experimental (preprint) |
| Planning | With a strong model, planning did not change accuracy and cut cost ~30% (Fan 2026). A plan fed by tool output: CodePlan 5 of 6 repositories, unplanned baseline 0. | Experimental |
| Heuristic rules | 17% of regexes are tested; 51% of regex fixes ship without tests; over-restrictive regexes are 3× as common as over-permissive ones (Wang & Stolee 2018, Wang et al. 2020). Property-based tests find ~50× the mutants of unit tests (Ravi & Coblenz 2025). | Case study + experimental |
| Fakes | Keeping fakes in sync with the real thing is the main difficulty (Spadini 2017/2019). 36% of agent test commits add mocks, 26% of human ones (Hora & Robbes 2026). | Case study |
| Bad fixes | 14.8-24.4% of post-release fixes are incorrect (Yin et al., FSE 2011). 29.6% of test-passing agent patches differ from the human patch, ~11% are clearly wrong (Wang, Pradel, Liu, ICSE 2026). | Case study / experimental |
| Self-correction | Without outside feedback, self-correction does not improve and sometimes degrades (Huang et al., ICLR 2024); with a reliable outside signal it helps (Kamoi et al. 2024). | Experimental |
| Long context | Reliability drops as context grows (Chroma 2025, Du 2025, NoLiMa); successful agent traces mostly stay under 20-30K tokens (Raju 2026). Multi-turn conversations: an average drop of 39% across six generation tasks, and the authors advise a new conversation that repeats the information (Laban et al. 2025). | Experimental |
| Instruction density | At 500 instructions the best model followed 68% (IFScale 2025). Context files add no significant success and raise cost by more than 20% (Gloaguen et al. 2026). | Experimental |
| AI and delivery | AI amplifies: without strong tests and small batches, instability rises (DORA 2025). Review time +441% (Faros 2026). | Survey / case study |

Practitioners point the same way: a short instruction file with rules moved into lints and tests (OpenAI harness engineering), few review rounds focused on correctness (Stripe, Every, Claude Code Review), one writer with independent readers (Cognition), retiring learned rules (Every, Cursor Bugbot, beads), fast checks at commit and heavy gates later with small batches (Google presubmit/postsubmit, DORA). No other team or product was found that measures how often defect classes repeat. The tools themselves, and what Ennyn took from each, are in [related-work.md](related-work.md).

## Open questions

- The review cap, finding schema and impact table were first used on a second project (above): three cycles with no third round needed and one round-two regression caught by a project gate. Whether escapes stay down is not yet measured: that needs weeks, not a day.
- The rework thresholds (≥ 3 owned lines and ≥ 10% of the fix, sweeps over 15 production files and move commits skipped) were tuned on the origin project only.
- Rules that do not fit the side-copy budget are only listed; whether subagents receive the hook in side copies was not measured.
- The `[commit-shape-allow: …]` marker checks only that a reason is given; how often it is used is not counted.
- "Works in any project" has two pieces of evidence so far, both from one author: the origin project and a second project in another language. Independent evidence comes only from other people's projects.

## Sources

- Defects and review: Porter, Siy, Toman, Votta, TSE 1997 · Porter, Votta, Basili, TSE 1995 · Biffl et al. 2001 · Mays et al., IBM Systems Journal 1990 · Fagan 1976 · Juergens et al., ICSE 2009 · Yin et al., FSE 2011 · Park et al., MSR 2012 / EMSE 2016 · Wang, Pradel, Liu, ICSE 2026 (arXiv 2503.15223) · Huang et al., ICLR 2024 · Kamoi et al., TACL 2024 · Song, arXiv 2603.16244 · Shukla, arXiv 2506.11022 · Sadowski et al., CACM 2018.
- Agents and context: Laban et al., arXiv 2505.06120 · Du et al., arXiv 2510.05381 · Gloaguen et al., arXiv 2602.11988 · IFScale, arXiv 2507.11538 · Chroma, "Context Rot" 2025 · Raju, arXiv 2602.16069 · Fan, arXiv 2609.20804 · CodePlan, FSE 2024 · ProMax, arXiv 2608.09802 · Stengg, arXiv 2512.19481 · Hora & Robbes, MSR 2026 (arXiv 2602.00409).
- Testing: Spadini et al., MSR 2017 / EMSE 2019 · Ravi & Coblenz, OOPSLA 2025 · Wang & Stolee, FSE 2018 · Wang et al., MSR 2020 · Petrović et al., ICSE 2021 · Zimmermann et al., ICSE 2004.
- Process: DORA 2025 · METR 2025, Feb 2026 · Faros 2025/2026 · GitClear 2025/2026.
- Practitioners: Every, compound engineering · OpenAI, "Harness engineering" (Feb 2026) · Anthropic, "Effective harnesses for long-running agents" (Nov 2025), "Harness design for long-running apps" (Mar 2026), "Effective context engineering" (Sep 2025) · Stripe, Minions part 2 · Cognition, multi-agent writing · Cursor, self-driving codebases and Bugbot learned rules · Ralph (Jul 2025) · beads (Oct 2025) · BMAD v6 · GitHub Spec Kit · Kiro.
