# Report formats

Write reports in the project's `language`.

## Cycle plan

```md
**Discovery:** oldest: [`core`'s pick, its value and cost; the step written if it said split] · by score: [3-5 of its list, with score and cluster] | mechanization slot: [node or "none ready → third core task"]
**Tasks:**
1-2. [core tasks: the oldest pick, then one by score] — impact table: [required/not needed + why] — checks: [tests, mutation, reviewers]
3. [mechanization: node] — class it turns into a gate: [catalog id]
4. [legacy audit: feature, or the security audit `ennyn.mjs audit` did not rule out] — chosen because: [rule]
**Security:** [threat this cycle meets · measure] or [none, because …]
```

## End of task

`**Task N done:** [result] | Impact: [summary or not needed — why] | Review-Rounds: [N] | Mutation: [first a/b · last c/d] | Checks: [passed] | Commit: [subject or "no commit" + why]`

## End of cycle

```md
## Cycle complete
### Done            → results 1-4
### Checks          → commit gate / build / viewport checks [result or not applicable] · security: `ennyn.mjs deps` and doctor's CI line [found / clean / unmeasured: what did not run] · commit-shape bypass: N (`ennyn.mjs bypass --from <cycle start>`; each use with its reason) · instruction budget: N KB every session (± since the last record), repeated rule lines
### Commits         → subjects
### Documents       → documents updated
### Audit           → feature or security audit / why chosen / result / next candidate
### Convergence     → format below
### Remaining risks → none, or each risk with its permanent home
### Push            → N commits waiting; approval asked
```

**Convergence** — counted from the `Class` and `Source` fields recorded during the cycle:

```md
Findings: real escape N · fix-introduced N · pre-existing N · gate-caught N
New classes per round: round 1 → N · round 2 → N · round 3+ → N
Recurring class: [id — how many times, which layer caught it]
Proposal: [mechanization] → [graph node id]   (or: Proposal: none — [reason])
```

- **Real escape:** born in new code, caught by an expensive layer (reviewer, CI, production).
- **Fix-introduced:** `Source: previous-fix`.
- **Pre-existing:** existed before the change (audits, side findings). Reducing this is not the goal.
- **Gate-caught:** caught by the commit gate or a validator run before it — the cheap layer; the goal is to grow this column.

Why four numbers: a single "new class vs. known-class repeat" ratio counts gate successes and old defects as repeats; in the origin project only 12 of 38 "repeats" in four cycles were real escapes.
