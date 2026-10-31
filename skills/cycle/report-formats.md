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

`**Task N stopped:** [remaining failure, or what could not run] | Failed: [count] · agents: [N] | Root cause: [likely] | Changed: [files] | Kept: [branch, brief] | Next: [safest step]`

## End of cycle

```md
## Cycle complete
### Done            → results 1-4
### Checks          → commit gate / build / viewport checks [result or not applicable] · security: `ennyn.mjs deps` and doctor's CI line [found / clean / unmeasured: what did not run] · commit-shape bypass: N (`ennyn.mjs bypass --from <cycle start>`; each use with its reason) · instruction budget: N KB every session (± since the last record), repeated rule lines
### Commits         → subjects
### Documents       → documents updated
### Audit           → feature or security audit / why chosen / result / next candidate
### Convergence     → format below
### Stopped         → none, or each stopped task's line
### Remaining risks → none, or each risk with its permanent home
### Push            → N commits waiting; approval asked
```

**Convergence** — counted from the cycle's finding rows:

```md
Findings: found in review N · fix-introduced N · pre-existing N · gate-caught N · escaped past commit new N · escaped past commit old N
New classes per round: round 1 → N · round 2 → N · round 3+ → N
Recurring class: [id — how many times, which layer caught it]
Proposal: [mechanization] → [graph node id]   (or: Proposal: none — [reason])
```

A count is exact or it is `?`. For an estimate write `?` and keep the figure in a sentence below: `~39` reads as unreported.

**One row, one column.** Count once every task has landed: a `test:<file>` row of an unlanded task reads as no gate. A row the validator refuses makes the columns `?` until it is fixed, never a smaller number. For any other, the first line of this table that holds decides:

| # | Row | Column |
|---|---|---|
| 1 | `dupOf` is set, or `outcome` is `refuted` | none |
| 2 | `source: pre-existing` | by age, below |
| 3 | `caughtBy` is a gate | gate-caught |
| 4 | `source: previous-fix` | fix-introduced |
| 5 | `caughtBy: review` | found in review |
| 6 | any other row | none: it stays in the ledger |

**A gate** is `test:<file>`, when that file is tracked at HEAD as the row is counted, or `gate:<name>`, a gate the repository runs: `gate:mutation`, `gate:ci:tests`, `gate:eslint`. The name is the writer's word and nothing checks it. `review`, `measurement` (an ad hoc run) and `author-reading` are no gates; no other value is valid.

**By age** (line 2), the first that holds:

1. `bornIn` is null or not in HEAD's history, the cycle's start was not noted or is not an ancestor of HEAD, HEAD holds no config, the clone is shallow, or step 2's command exits other than 0: no age. The row leaves the table here: pre-existing, gate-caught and both escaped columns read `?` until it is repaired.
2. `git ls-tree --full-tree --name-only <bornIn> -- .ennyn/config.json` prints nothing: pre-existing. The tree held no config, read as not through the loop; a config moved in or committed late reads this way too.
3. `bornIn` is an ancestor of the cycle's start, the HEAD noted when the cycle began: escaped past commit old.
4. Otherwise it is this cycle's code, already landed: gate-caught if `caughtBy` is a gate, else escaped past commit new.

`bornIn` is written once, with a `pre-existing` row: the full hash `git blame -w -M -C --ignore-revs-file "" --no-textconv -L <n>,<n> --porcelain -- <file>` names, run at the top of the tree with no revision, so a dirty tree works. `<n>` is the line the finding quotes: the age is that line's, and which line to quote is the writer's judgement. With no line, a failing blame, a zero hash, a commit off the default branch or a shallow clone, `bornIn` is null.

**Repair:** a null `bornIn` means the task rewrote the line or the finding quotes none. Rerun the blame at the commit the task started from, at the line as it stood there: `git blame … <base> -- <file>`. Choosing that line is the closer's judgement.

**Duplicates:** `dupOf` is for a root cause not yet fixed when seen again, by another reviewer, round or cycle: it names the first row, and only that row counts, in its own cycle. Seen again after a fix was applied, a partial fix included, it is a new defect: `previous-fix`, no `dupOf`, and `pre-existing` once that fix has landed.

**Old defects:** a defect in code older than the cycle's start is `pre-existing`, whatever found it, an audit, a reviewer or a new gate's first run, so it is never gate-caught: one row per root cause, not per place. A `first-write` label on old code is a mislabel, and nothing checks it yet. A cycle has one push, at its end: what turns up after it, CI on the default branch too, is the next cycle's row, and reads escaped old.

**New classes per round:** rows with `round` 1 or higher that line 1 leaves; a class counts once, in the first round that names it, and a class first named in round 0 is not counted on this line.

Gate-caught is the cheap layer: the goal is to grow it. Pre-existing is code older than the project's config: reducing it is not the goal. Escaped past commit is the loop's real hole: `new` is a landed task found wrong by no gate, within the cycle; `old` rises with every audit and new gate: it counts what was found, not what is left. A test that fails under load and passes alone is no row.

Older reports' four numbers: Ennyn's docs/evidence.md, Reading the convergence columns.

Why several numbers: a single "new class vs. known-class repeat" ratio counts gate successes and old defects as repeats.
