# Finding schema and review rounds

Shared output contract for every reviewer. Include this file in the reviewer's prompt.

**Scope:** correctness (wrong result, crash, data leak, bypassed gate) and requirements: is the ask of the task's node met, all of it? The ask is the node plus the protocol's own steps (the sweep, the documents the change affects, a small fix of the task's own), so those are never unrequested. A requirement finding names its kind in its title: `missing` (not done), `partial` (done in part), `contradicts` (done against the ask) or `unrequested` (done, not asked). A completion claim, in the author's report or the commit message, is no evidence. Style, naming and refactoring suggestions are out of scope.

**Prefer running to reading:** a test, a command or a harness through the real program over a code path read. A claim about what another program does (git, a shell, npm, Claude Code) is checked in that program, with its version, never from memory.

## Fields (a finding missing a field does not count)

| Field | Value |
|---|---|
| Title | `🔴/🟠/🟡/⚪ <short name>` |
| Quote | `file:line` and the exact text of that line — a claim that cannot quote a line is not a finding |
| Scenario | which input or state breaks it, and who produces that input: an attacker, normal use (a person or an agent), or only this project's own writer (the row's `input`); expected ↔ actual |
| Class | registry id (`ennyn.mjs classes` lists them) or `new: <short name>`, several if they fit — assign it while writing |
| Source | `first-write`: in the task's own change, not yet landed · `previous-fix`: in a fix made for a finding of the same task, not yet landed · `pre-existing`: already on the default branch when found, whoever wrote it, this cycle's tasks included; it also gives `bornIn`, the commit that last wrote the quoted line ([report-formats.md](report-formats.md)) |
| Confidence | `high` · `medium` · `low`; low-confidence findings are counted, not listed |
| Check | how you verified it: command, test, or code path read; `unverified` if you could not |

In security reviews, **evidence gaps** (a test does not pin the location of a gate, a path was not tried) are listed under their own heading even at low confidence; they do not open a new round.

**A backstop is judged against habit, not against an attacker.** Where SECURITY.md calls a check a backstop and no boundary (a hook that reads a command's text), an input only an attacker writes is no finding: a program set on getting past text reading always will, and each such shape patched breeds the next. Such an input is a finding only when the project's replay of real agent commands holds its shape, or an agent writes it by habit (a quoted `<<` in a commit message, a heredoc beside a kill word); otherwise it is an evidence gap with its probe, and a shape SECURITY.md already lists as not reached is not even that. The answer to a deliberate shape is a boundary below the text (the operating system's), never a longer word list.

## Probes

Hand back every input you tried, found or not, as a cell: an id, the input in the gate's own terms, the verdict you expect (`refused`; `said`: let through, saying what it did not check; `pass`), what its reason must hold when the verdict alone would not show the reading (`expectWhy`: the catalog key of a reason, a nested reason's key too, such as `deps.reason.bundled`, never its words), and where it came from:

```json
{ "id": "checkout-in-subshell", "workflow": "on: pull_request_target\n…", "expect": "refused", "from": "cycle 9 ci review r3" }
```

The author adds them to the project's verdict corpus beside the gate's test (in Ennyn: `node test/verdicts.mjs add <gate> <probes.json>`), which replays every cell and fails when a recorded verdict moves, so a later fix that turns a refused cell into a silent pass fails there instead of in a reviewer's next round. A probe that does not get what it expects is a finding, or a gap the work graph names. A recorded verdict changes, and a cell is retired, only by an edit in a commit that says why.

## If an impact table was given

First look for its **missing row**: a reader, twin, path, newly accepted input, ceiling state or fake source that the table does not list.

When the table holds a core task's smallest-change row, set it against the full diff: each new piece the diff holds, a function or option inside a file too, is in the row with the line of the task that asks for it; validation of anything read from outside the process, data-loss handling, security and accessibility need no asking line (`never cut`). A piece the row lacks, or its `Left out` line names, is a finding; for a never-cut piece the finding is the row's gap, never the piece.

## Rounds

- **Round 1:** full review.
- **Round 2:** only the diff of round-one fixes and the impact-table delta; the same reviewer continues (its context and corpus are kept). Question: "what did this fix open?"
- **Round 3+:** only when an independent signal (test, mutation run, real-system measurement) shows a new class; the reason goes into the commit body.
- **Left after round 2:** a critical or high finding still gets its outcome (below); a failing-then-passing test proves a fix, not another round. If no test can prove it, stop and ask the user.

## Outcome

Review stays as it is: a reviewer reports every finding it can quote, on gates, hooks and shared code above all. What becomes of each is the orchestrator's (the author's, for round 0), and each finding leaves its round with one outcome, the row's `outcome` ([ledger-row.md](ledger-row.md)):

- **🔴/🟠:** fixed with a test (`fixed-test`), a node (`node:<id>`), or `refuted`. Never `fixed` without a test, never `open` past its round.
- **⚪ whose input only this project's own writer produces:** `declined` (or `refuted`), not fixed and no node: the defect is real, and the convergence report lists it; a fix that landed anyway (a fix the user asked for, another finding's fix) is recorded as what happened, `fixed` or `fixed-test`. The validator refuses `declined` on any other row, and `open` or a node on such a row.
- **Any other ⚪ outside a gate (code that accepts or refuses) and outside shared code (read in two or more places):** `node:<id>`, not fixed in the cycle.
- **The rest:** fixed in the task, with a regression test where one can prove it; a fix larger than the task: a node.

## Report

1. Positive observations (0-3, only when sincere).
2. Findings sorted by severity, with all fields.
3. Count line: `Findings: 🔴 a · 🟠 b · 🟡 c · ⚪ d · low-confidence (not listed) e · source: first-write f / previous-fix g / pre-existing h`.

Each finding is also a row, in the file your prompt names: [ledger-row.md](ledger-row.md).
