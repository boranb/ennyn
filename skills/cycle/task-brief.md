# Task brief — a fresh agent for each task

**Why:** a model does worse the longer a conversation runs (39% on average across six generation tasks, Laban et al. 2025), and a fork carries the orchestrator's context into the task. Evidence: `docs/evidence.md`, Context and rules.

In Claude Code 2.1.310 a fresh agent is the Agent tool with a named `subagent_type`, not `fork`; it starts without the conversation and the skills loaded there.

## What a brief holds

One common brief for the cycle, one short brief per task, read first, in one turn.

| Part | Content |
|---|---|
| **Task** | the node, where its evidence is, what to deliver, the commit type |
| **Impact table** | its path, or `not needed` and why; the agent writes what it learns there |
| **Files** | what to read first, what to search instead |
| **Paths** | the CLI and this skill's folder, written out: an agent's shell has no `${CLAUDE_PLUGIN_ROOT}`, and a skill read from disk holds it unfilled (Claude Code 2.1.310) |
| **Protocol** | section 2 of `SKILL.md` **without step 7**: the agent starts no reviewers, leaves `Review-Rounds:` out, commits on its branch, reports and stops |
| **Commands** | the handoff's commands, as each runs in a worktree (no installed dependencies). **Name the project's slow gate suites.** The agent runs a new test alone first, its control seen failing once, then the handoff's fast test command on the final tree, with any slow gate the task touches; a fast command with no slow list is run as it is. A task that adds a slow test says so in its report, and the orchestrator adds it wherever the project lists slow gates. The whole test command, with any slow gate it does not hold, runs at landing, before the main branch moves: a brief that said "do not run the full suite", with no such run before landing, let a real defect reach the main branch. A handoff that names no command short of the whole suite: the whole test command, and say so |
| **Place** | worktree, branch, snapshot name, the rows file in the kept folder (the orchestrator alone appends to `paths.findings`, at the close). Not to touch: the main checkout, the graph, the handoff. No push, no landing |
| **Traps** | the handoff's traps this work can hit; the report's language |
| **Report** | its last message, in order: changes · impact table · commit · checks run, with results · not measured · proposed nodes · handoff text · doubts |

Leave out the plan for other tasks; mark a guess at a cause or a fix as a guess.

## What the orchestrator keeps

- **The plan, the graph, the handoff.** An agent hands back what they should say.
- **The verdicts.** It starts step 7's reviewers on the reported commit and reruns the numbers a verdict rests on: a reported 0 of 8 was 4 of 8 on a rerun.
- **The commit's last lines.** When review ends, a clean round one too, it amends `Review-Rounds:` in, with `Third-round:` past `review.maxRounds`.

## How a reviewer is briefed

It does not get the author's reasoning. It works in a **folder of its own**, on a real copy of the commit, and its probes and harnesses stay there for the author to rerun. All findings of a round go to the author in one message.

## Keeping the work

- **Everything the cycle needs** (worktrees, briefs, impact tables, findings, reviewers' folders, task states) stays in a folder a restart keeps and no other account can write to, never the system temp folder or the session scratchpad: a restart wiped four worktrees, the ledger and the briefs.
- **The machine stays awake** from the first agent on. macOS: `caffeinate -i -s -t <seconds>` in the background; without `-t` or a command it never returns.
- **Uncommitted work goes into a ref** after each step that works: run this inside the worktree with the task's name.

  ```sh
  set -eu
  name=${1:?task name}
  idx=$(mktemp)
  trap 'rm -f "$idx"' EXIT
  cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE=$idx git add -A
  tree=$(GIT_INDEX_FILE=$idx git write-tree)
  commit=$(git commit-tree "$tree" -p HEAD -m "snapshot $name")
  git update-ref "refs/snapshot/$name" "$commit"
  ```

- **Shell steps chain with `&&`** after a `cd`, never `;`: after a failed `cd` the next step runs in the wrong tree.
- **Scenario trees are real copies** (`git archive`, a `cp` of plain files), never links into a checkout.

## The failure count

The orchestrator writes each task's state and count to a file in that folder at every change: context does not survive compaction.

**A failed verification** is a result that sends the task back: a check the orchestrator reran, a review round, the test that proves a fix after round two, the landing suite, or the agent's report that it cannot pass (still red after three tries at one failure). The task's first review round does not count: its findings are the work. Nothing else is exempt, whatever the finding's Source. An agent's own red runs before it reports are no results. A timing failure under load is rerun alone before anything counts, whoever runs the suite.

| State | What happens |
|---|---|
| **Sent back** | First failure: the agent corrects and amends. Second: restart. Third or later: stopped. The count is the task's, and nothing resets it |
| **Restart** | Once per task. The agent stops; a fresh agent on a new branch takes the consolidated brief; the old branch stays. The reviewers keep their context, and a reviewer or the orchestrator runs what they left. A new design is a first write nobody has read: it gets one narrow review, with the failures as step 7's signal |
| **Landing** | One task at a time: rebase, the handoff's whole test command and every slow gate it does not hold (no single whole command: each test command), whatever the agent ran, then the main branch moves. A clean rebase is no change: it does not recheck meaning, and the suite is the net. A red suite counts; a conflict goes to the agent uncounted. What either changes goes to the reviewers as a delta: that failure or conflict is step 7's signal, and `Third-round:` names it |
| **Landed** | Closed: restart and stop no longer apply. A defect found later counts for nothing: a new `fix:` commit, written and reviewed as a first write, or a node |
| **Lost or waiting** | An agent lost to an API error, sleep or a restart, or a check or reviewer that is unavailable, is no failure. Resume the agent, or start one on the same brief from its branch and snapshot, with that round's open findings. Once the other tasks have landed it gets one more try, then it stops |
| **Stopped** | That task ends, the others go on. It does not land; its branch and files stay. Its node gets a `gate`, so the next cycle does not pick it alone. The report gives it a line ([report-formats.md](report-formats.md)) and the handoff names it. Only the user sends it round again |

A state this table does not name is the orchestrator's decision, written in the cycle report, never a silent wait.

**The consolidated brief** replaces the task's brief; the common brief stays.

| Part | Content |
|---|---|
| **Node** | the task as it stands, and the failure count |
| **Place** | worktree, new branch, new snapshot name, the impact table's path |
| **What was tried** | each attempt in one line, and the old branch that holds the code |
| **What failed and why** | the failing command and its result; the cause, marked measured or guessed |
| **Open findings** | each one whole, with the path of its probe or harness |
| **Tests to carry** | by path, the tests that closed earlier findings: any new start keeps them |
| **Verification** | the commands and harnesses that must pass, with expected numbers, and who runs them |

It leaves out the old conversation, explanations no command backs, closed findings, and the failed design as an instruction: the fresh agent may keep that code or start from the base.

## A host with no subagents

The tasks run in turn in one session, and no reviewer can start: review is the session rereading its diff against [finding-schema.md](finding-schema.md), weaker than another reader, and the report says so. Ennyn has not run a cycle on such a host. The second failure stops the task: its consolidated brief also holds what a common brief would, and the handoff names it for a new session.
