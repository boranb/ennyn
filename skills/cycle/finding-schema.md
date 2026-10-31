# Finding schema and review rounds

Shared output contract for every reviewer. Include this file in the reviewer's prompt.

**Scope:** correctness (wrong result, crash, data leak, bypassed gate) and requirements (the task's ask not met). Style, naming and refactoring suggestions are out of scope.

## Fields (a finding missing a field does not count)

| Field | Value |
|---|---|
| Title | `🔴/🟠/🟡/⚪ <short name>` |
| Quote | `file:line` and the exact text of that line — a claim that cannot quote a line is not a finding |
| Scenario | which input or state breaks it; expected ↔ actual |
| Class | catalog id, or `new: <short name>` — assign it while writing |
| Source | `first-write`: in the task's own change, not yet landed · `previous-fix`: in a fix made for a finding of the same task, not yet landed · `pre-existing`: already on the default branch when found, whoever wrote it, this cycle's tasks included; it also gives `bornIn`, the commit that last wrote the quoted line ([report-formats.md](report-formats.md)) |
| Confidence | `high` · `medium` · `low`; low-confidence findings are counted, not listed |
| Check | how you verified it: command, test, or code path read; `unverified` if you could not |

In security reviews, **evidence gaps** (a test does not pin the location of a gate, a path was not tried) are listed under their own heading even at low confidence; they do not open a new round.

## Probes

Hand back every input you tried, found or not, as a cell: an id, the input in the gate's own terms, the verdict you expect (`refused`; `said`: let through, saying what it did not check; `pass`), what its reason must hold when the verdict alone would not show the reading (`expectWhy`: the catalog key of a reason, a nested reason's key too, such as `deps.reason.bundled`, never its words), and where it came from:

```json
{ "id": "checkout-in-subshell", "workflow": "on: pull_request_target\n…", "expect": "refused", "from": "cycle 9 ci review r3" }
```

The author adds them to the project's verdict corpus beside the gate's test (in Ennyn: `node test/verdicts.mjs add <gate> <probes.json>`), which replays every cell and fails when a recorded verdict moves, so a later fix that turns a refused cell into a silent pass fails there instead of in a reviewer's next round. A probe that does not get what it expects is a finding, or a gap the work graph names. A recorded verdict changes, and a cell is retired, only by an edit in a commit that says why.

## If an impact table was given

First look for its **missing row**: a reader, twin, path, newly accepted input, ceiling state or fake source that the table does not list.

## Rounds

- **Round 1:** full review.
- **Round 2:** only the diff of round-one fixes and the impact-table delta; the same reviewer continues (its context and corpus are kept). Question: "what did this fix open?"
- **Round 3+:** only when an independent signal (test, mutation run, real-system measurement) shows a new class; the reason goes into the commit body.
- **Left after round 2:** a critical or high finding is still fixed; a failing-then-passing test proves the fix, not another round. If no test can prove it, stop and ask the user.

## Report

1. Positive observations (0-3, only when sincere).
2. Findings sorted by severity, with all fields.
3. Count line: `Findings: 🔴 a · 🟠 b · 🟡 c · ⚪ d · low-confidence (not listed) e · source: first-write f / previous-fix g / pre-existing h`.
