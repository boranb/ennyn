# Task brief — a fresh agent for each task

**Why:** a model does worse the longer a conversation runs (39% on average across six generation tasks, Laban et al. 2025), and a fork carries the orchestrator's context into the task. Evidence: `docs/evidence.md`, Context and rules.

In Claude Code 2.1.310 a fresh agent is the Agent tool with a named `subagent_type`, not `fork`; it starts without the conversation and the skills loaded there.

## What a brief holds

One common brief for the cycle, one short brief per task, read first, in one turn.

| Part | Content |
|---|---|
| **Task** | the node, its slot, where its evidence is, what to deliver, the commit type |
| **Model** | the author's, named in the brief and set on the Agent call (`model`; Claude Code takes the call's, then the agent's own frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the session's): the session's for code, gates and security, `sonnet` for method text and docs. Reviewers never run below the session's: their agents say `model: inherit`, their Agent call passes no `model`, and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` stays unset (it overrides `inherit`). Ennyn's `scout` (quotes, `path:line`, no judgment) and `summarizer` (a long log's failures with their lines) run on `haiku`, for an author or reviewer's reads. A call's `model` can be dropped without a word (claude-code#100082: 1,149 of 1,371 subagents ran on the parent's): read the model that ran from the agent's transcript, not from the call |
| **Impact table** | its path, or `not needed` and why; a core task gets a path either way: its smallest-change row is answered there before the first edit, with the five rows or without them, and set against the diff before the commit. The agent writes what it learns there |
| **Gate** | the check that exercises this change end to end, in one line, by command: a browser check for a UI change, the project's harness for a money path, a test file otherwise; for an audit, the audited feature's own check; for a security audit, the suites of the gates it touches, named in the brief; for a mechanization task, in words, what it will build, until its report names the command. `none` and why for a task with nothing to run. It runs beside the test that proves a fix, never instead |
| **Files** | what to read first, what to search instead |
| **Paths** | the CLI and this skill's folder, written out: an agent's shell has no `${CLAUDE_PLUGIN_ROOT}`, and a skill read from disk holds it unfilled (Claude Code 2.1.310) |
| **Protocol** | section 2 of `SKILL.md` **without step 7**: the agent starts no reviewers, leaves `Review-Rounds:` out, commits on its branch, reports and stops. After every fix round, before it amends, it runs the brief's gate. After a compaction, before its next edit, it re-reads the files the task changed (`git diff --name-only --merge-base <base branch>` and `git status --short --untracked-files=all`, in its worktree) and its impact table |
| **Commands** | `commands.fastTest` and the handoff's commands, as each runs in a worktree (no installed dependencies). **Name the project's slow gate suites.** The agent runs a new test alone first, its control seen failing once, then the fast test command (`commands.fastTest`, else the handoff's) on the final tree, with any slow gate the task touches (`none`: the brief says so, and the agent writes and runs no test and no mutation pass, says why, and still runs lint and typecheck); a fast command with no slow list is run as it is. A task that adds a slow test says so in its report, and the orchestrator adds it wherever the project lists slow gates. The landing runs the fast test command and the slow gates the task touches (the **Landing** row below), before the main branch moves: a brief that said "do not run the full suite", with no run before landing, let a real defect reach the main branch. One heavy job at a time on the machine: a whole suite, a mutation run, a platform image. A platform or release matrix the handoff names runs before a release, never at the closing. A handoff that names no command short of the whole suite: the whole test command, and say so |
| **Place** | worktree, branch, the base branch (the branch it rebases onto and lands on), snapshot name, the rows file in the kept folder (the orchestrator alone appends to `paths.findings`, at the close). Not to touch: the main checkout, the graph, the handoff. No push, no landing |
| **Traps** | the handoff's traps this work can hit; the report's language |
| **Rules** | prefer running to reading; a claim about what another program does (git, a shell, npm, Claude Code) is checked in that program, with its version, never from memory. Stay in the task: what is small and the task's own is fixed (a finding as finding-schema.md's Outcome says), the rest goes back as a proposed node (id, one-line title, source). No `git stash` in a worktree: the stash is shared across worktrees. The snapshot ref below keeps a copy; to look at the base, read it from git (`git show <start>:<path>`) or a throwaway worktree. A test run keeps its exit status (`set -o pipefail`, or a log file read afterwards). A command that passed is not run again on an unchanged tree |
| **Report** | its last message, in order: changes · impact table · commit · the gate's command and result · for each fix, what exercises it: the gate, a test that failed first, or `none` and why (a comment, a case only another git or platform reaches); the orchestrator reads this when no review follows · checks run, with results · not measured · proposed nodes · handoff text · doubts |

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

- **A mutation run gets a worktree of its own** while a reviewer reads the tree: `ennyn.mjs mutate` edits files in place.
- **Every worktree the cycle makes carries its mark**, a task's and a mutation run's alike: `git worktree add --lock --reason ennyn:<cycle> …`. Each goes once its agent or run has stopped (what a running process writes after the check goes with the folder): a mutation run's right after the run, while its HEAD is its branch's tip (left to the close after the task amends, only a reflog holds that commit and it is kept as `detached`), a task's when it lands or stops, with `ennyn.mjs worktrees --remove <its path>`; at the close, before the push, `ennyn.mjs worktrees --remove` sweeps the rest. A worktree goes only when removing it loses nothing; the report names each one kept and why (a task that did not land keeps its own: its branch is not merged). Squash onto the base branch with `git reset --soft $(git merge-base HEAD <base branch>) && git commit -m "<subject>"`: a squash by `rebase -i` leaves its in-between commits in that worktree's reflog alone, and keeps it. One without the mark is never touched. None goes by hand with `git worktree remove`: Git for Windows 2.47.1 deletes through any junction in it, with or without `--force` (a dependency folder linked from the main copy was emptied), where the command keeps a link HEAD does not hold and never enters one.
- **Shell steps chain with `&&`** after a `cd`, never `;`: after a failed `cd` the next step runs in the wrong tree.
- **Scenario trees are real copies** (`git archive`, a `cp` of plain files), never links into a checkout.

## A commit refused for loosening a gate

A task agent cannot reach the user. Refused with `User-Approved-Loosening:`, it does not retry, write the line, or reword the change around the gate: it stops and reports the keys and why the task needs them. The orchestrator asks the user, in plain words for each key, and only on a plain yes continues the agent with the line to write; on a no, or with the user away, that task is Stopped and the others go on.

## The failure count

The orchestrator writes each task's state and count to a file in that folder at every change: context does not survive compaction.

**A failed verification** is a result that sends the task back: a check the orchestrator reran, a review round, the test that proves a fix after round two, the task's gate after the last round's fixes, the landing suite, or the agent's report that it cannot pass (still red after three tries at one failure). The task's first review round does not count: its findings are the work. Nothing else is exempt, whatever the finding's Source. An agent's own red runs before it reports are no results. A timing failure under load is rerun alone before anything counts, whoever runs the suite.

| State | What happens |
|---|---|
| **Sent back** | First failure: the agent corrects and amends, or a fresh agent does (see below); a task the brief put on a cheaper model is escalated instead, as **Escalation** says. Second: restart. Third or later: stopped. The count is the task's, and nothing resets it |
| **Last round fixed** | The orchestrator reruns the task's gate on the amended commit, before `Review-Rounds:` goes in. Red in that rerun is a failed verification, and it counts |
| **Restart** | Once per task. The agent stops; a fresh agent on a new branch, on the session's model, takes the consolidated brief; the old branch stays. The reviewers keep their context, and a reviewer or the orchestrator runs what they left. A new design is a first write nobody has read: it gets one narrow review, with the failures as step 7's signal |
| **Landing** | One task at a time: rebase, the fast test command and every slow gate the task touches (no command short of the whole suite: the whole test command), whatever the agent ran, then the main branch moves; the whole test command waits for the closing (section 3 of `SKILL.md`). Red there stops the push: a timing failure is rerun alone first; a real one is traced to the landing commit that brought it and fixed in a new `fix:` commit, written and reviewed as a first write, or the push waits. The whole run repeats on the fixed tree, and what follows the last edit is done again: the `fix:` commit's rows appended first, convergence run again (a new block), the graph, the budget record, leftovers, and `bypass` over the new commit. A red closing run is a landed task's defect: it counts against no task (**Landed**), its `fix:` commit is written by a fresh agent on the session's model and reviewed as a first write, and no escalation applies. A clean rebase is no change: it does not recheck meaning, and the suite is the net. A red suite counts; a conflict goes to the agent uncounted; once the others have landed or stopped the main branch holds still, and one more conflict at most can come. What either changes goes to the reviewers as a delta: that failure or conflict is step 7's signal, and `Third-round:` names it |
| **Landed** | Closed: restart and stop no longer apply. A defect found later counts for nothing: a new `fix:` commit, written and reviewed as a first write, or a node |
| **Lost or waiting** | An agent lost to an API error, sleep or a restart, or a check or reviewer that is unavailable, is no failure. Resume the agent, or start one on the same brief (its Model row too) from its branch and snapshot, with that round's open findings. Once the other tasks have landed or stopped it gets one more try: lost or waiting again, it stops; a result of that try goes by the count |
| **Stopped** | That task ends, the others go on. It does not land; its branch and files stay. Its node gets a `gate`, so the next cycle does not pick it alone. The report gives it a line ([report-formats.md](report-formats.md)) and the handoff names it. Only the user sends it round again |

A state this table does not name is the orchestrator's decision, written in the cycle report, never a silent wait.

**Escalation.** It applies only where the author is a subagent that the brief put, by its Model row and the Agent call's `model`, on a model cheaper than the session's (`sonnet` under a stronger session). A task the brief put on the session's model, a host with no subagents, or one whose Agent call takes no model: the failure table stands as written. At the first failed verification the orchestrator reads the author's `ran` in `ennyn agents` (each model that ran, with its calls, most calls first). The task escalates when that list holds any model other than the session's, matched as `ennyn agents` matches an ask (an alias as a whole word of the id, an id with or without a provider's prefix, a date or a version suffix), with the session's model as the ask; or when it holds `unknown` or nothing, or the command is unmeasured (exit 1). A list of only the session's model, or of it and models stronger than it (named in the report), does not escalate: the call's `model` was dropped, and the task ran where escalation would send it. An escalated task goes to a fresh agent on the session's model, by the correction path below: same worktree and branch, the list applied on the existing commit, the count at one. The second failure restarts, on the session's model too. Why the first failure and not only the restart: the research behind the model split found up-front routers fail on software tasks and a gate after a cheap attempt works, and the verification is that gate; the cheaper agent's own reading of its failure is the one input that would steer a same-agent correction wrong. The escalated agent's brief holds verified facts only (the consolidated brief's rows say which) and its Agent call passes the session's model by name.

**A correction sent to a fresh agent.** The count is the rule: the first failure goes to the agent that wrote the task, escalation above excepted. No size is a rule. In Ennyn's own cycles 16 to 19, eight same-agent corrections at 258K to 540K tokens of context held on that try; eight lists went fresh at 561K to 723K, four held and four failed the next verification, none by a slip the list named. Both groups were picked by size, so nothing shows where a same-agent correction starts to fail. When the author's context is large and the list is short and decided, the orchestrator may still send it fresh, past a size it names itself: a judgment, written in the cycle report with the author's size and the reason. It reads the size as the last assistant `usage` of the author's transcript (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`, in `subagents/agent-<id>.jsonl` under the session's transcript folder); `ennyn agents` prints it per agent, in its "last call's context" column. The fresh agent takes the consolidated brief below, but for this case its Place row is the same worktree and branch, and the list is applied on the existing commit (amend, one commit): "start from the base" is the restart's freedom, not this one's. It is not the restart: the count does not move, and the second failure still restarts the task (four of the eight went on to one).

**The consolidated brief** replaces the task's brief; the common brief stays.

| Part | Content |
|---|---|
| **Node** | the task as it stands, its slot, and the failure count |
| **Model** | the model the agent runs on, named: the session's for a restart or an escalation |
| **Place** | worktree, new branch, the base branch, new snapshot name, the impact table's path |
| **What was tried** | each attempt in one line, as the commands run and their results, and the old branch that holds the code |
| **What failed and why** | the failing command and its result; the cause, marked measured or guessed. An escalated task: a cause only if the orchestrator measured it, and never the cheaper model's account |
| **Open findings** | each one whole, with the path of its probe or harness |
| **Tests to carry** | by path, the tests that closed earlier findings: any new start keeps them |
| **Verification** | the commands and harnesses that must pass, the task's gate among them, with expected numbers, and who runs them |

It leaves out the old conversation, explanations no command backs, closed findings, and the failed design as an instruction: the fresh agent may keep that code or start from the base.

## A host with no subagents

The tasks run in turn in one session, and no reviewer can start: review is the session rereading its diff against [finding-schema.md](finding-schema.md), weaker than another reader, and the report says so. Ennyn has not run a cycle on such a host. The second failure stops the task: its consolidated brief also holds what a common brief would, and the handoff names it for a new session.
