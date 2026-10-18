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
| Source | `first-write` · `previous-fix` · `pre-existing` |
| Confidence | `high` · `medium` · `low`; low-confidence findings are counted, not listed |
| Check | how you verified it: command, test, or code path read; `unverified` if you could not |

In security reviews, **evidence gaps** (a test does not pin the location of a gate, a path was not tried) are listed under their own heading even at low confidence; they do not open a new round.

## If an impact table was given

First look for its **missing row**: a reader, twin, path, newly accepted input, ceiling state or fake source that the table does not list.

## Rounds

- **Round 1:** full review.
- **Round 2:** only the diff of round-one fixes and the impact-table delta; the same reviewer continues (its context and corpus are kept). Question: "what did this fix open?"
- **Round 3+:** only when an independent signal (test, mutation run, real-system measurement) shows a new class; the reason goes into the commit body.
- **Left after round 2:** a critical or high finding is still fixed; a failing-then-passing test proves the fix, not another round. If no test can prove it, the author stops and asks the user.

## Report

1. Positive observations (0-3, only when sincere).
2. Findings sorted by severity, with all fields.
3. Count line: `Findings: 🔴 a · 🟠 b · 🟡 c · ⚪ d · low-confidence (not listed) e · source: first-write f / previous-fix g / pre-existing h`.
