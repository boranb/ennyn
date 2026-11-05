# Report formats

Write reports in the project's `language`.

## Cycle plan

```md
**Discovery:** oldest: [`core`'s pick, its value and cost; the step written if it said split] · by score: [3-5 of its list, with score and cluster] | mechanization slot: [node or "none ready → third core task"]
**Tasks:**
1-2. [core tasks: the oldest pick, then one by score] — impact table: [path, for the smallest-change row; the five rows required/not needed + why] — checks: [tests, mutation, reviewers]
3. [mechanization: node] — class it turns into a gate: [registry id]
4. [legacy audit: feature, or the security audit `ennyn.mjs audit` did not rule out] — chosen because: [rule]
**Security:** [threat this cycle meets · measure] or [none, because …]
```

## End of task

`**Task N done:** [result] | Impact: [summary or not needed — why] | Review-Rounds: [N] | Mutation: [first a/b · last c/d] | Gate: [result · last round clean · none and why] | Checks: [passed] | Escalated: [none, or agent ids with the model asked and the model that ran, before and after] | Commit: [subject or "no commit" + why]`

`**Task N stopped:** [remaining failure, or what could not run] | Failed: [count] · agents: [N] | Escalated: [as above] | Root cause: [likely] | Changed: [files] | Kept: [branch, brief] | Next: [safest step]`

## End of cycle

```md
## Cycle complete
### Done            → results 1-4
### Checks          → commit gate / build / viewport checks [result or not applicable] · security: `ennyn.mjs deps` and doctor's CI line [found / clean / unmeasured: what did not run] · leftovers, after the closing's commit: `ennyn.mjs leftovers` (untracked files that appeared, changes not committed) and the handoff's leftover command (none named: unmeasured); each item a question for the user, never deleted [found: the items and the answers / clean / unmeasured: what did not run] · bypasses and loosened keys, for the user before the push (`ennyn.mjs bypass --from <cycle start>`, pasted: each use with its reason, each key with its approval line or none; exit 1 is unmeasured, never none) · whole test command at the closing, before the push [passed / red: the failure, the landing that brought it, the `fix:` commit or the push waiting] · subagent models, on Claude Code: `ennyn.mjs agents`, pasted (per agent the model asked for, the models that ran, calls, tokens and the context at its last call); each task that escalated read against its agents (the cheaper author, then the fresh one on the session's model), each mismatch said, since a split by role can be skipped without a word [mismatch: the agents / none / unmeasured: exit 1, or agents whose ask is unknown] · reviewers off the session's model: each `review.agents` file whose `model:` names a model other than `inherit`, and each with no `model:`, which takes `CLAUDE_CODE_SUBAGENT_MODEL` when it is set; `ennyn agents` shows no mismatch when such a file's ask equals what ran [the reviewers and their models / none / not applicable: `review.agents` empty] · instruction budget: N KB every session (± since the last record), repeated rule lines
### Commits         → subjects
### Documents       → documents updated
### Audit           → feature or security audit / why chosen / result / lean items / next candidate
### Convergence     → format below
### Stopped         → none, or each stopped task's line
### Briefs          → each rule the cycle's hand-written briefs gave that did work, read against the skill's text: the file that holds it, the node that brings it in, or the project's own (its paths, its machine, its own ceilings); none when no brief was written
### Remaining risks → none, or each risk with its permanent home
### Push            → N commits waiting; approval asked
```

**Leftovers answered after the closing's commit:** what the user's answer brings (a node, a fix, a line in the handoff) goes into one follow-up commit with the graph and a fresh `ennyn.mjs budget --record`, before the push.

**Convergence** — run `ennyn.mjs convergence --cycle <N> --from <cycle start>` and paste what it prints, unchanged: it counts the rows of `paths.findings` ([ledger-row.md](ledger-row.md)) of cycle N and no other, as this file says, in the project's language; its last line says what it counted, and under the block it says what it could not place and why. It exits 1 when a count reads `?`, when a name resolves to no entry, and when a start given is refused, even with every count exact. No repository, a bare one or no git stops it with no block. `Proposal:` is yours to add:

```md
Findings: found in review N · fix-introduced N · pre-existing N · gate-caught N · escaped past commit new N · escaped past commit old N
New classes per round: round 1 → N · round 2 → N · round 3+ → N
Recurring class: [id — how many times, which layer caught it]
cycle N: M of T rows
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

**Declined** is not line 1: the defect is real, left unfixed on purpose ([finding-schema.md](finding-schema.md), Outcome), so a `declined` row counts in its column, its round and the recurring class as a fixed one does. Under the block the command lists the cycle's declined rows, and each declined row of an earlier cycle, with no `dupOf`, whose fingerprint a row of this cycle holds, compared folded (NFKC, lower case, runs of white space one space): that defect was found again. The list is a lower bound: a re-find in new words is not on it, so a reviewer who knows a declined defect copies its fingerprint. Read the escapes against them before the rule is kept.

**A gate** is `test:<file>`, when that file is tracked at HEAD as the row is counted, or `gate:<name>`, a gate the repository runs: `gate:mutation`, `gate:ci:tests`, `gate:eslint`. The name is the writer's word and nothing checks it. `review`, `measurement` (an ad hoc run) and `author-reading` are no gates; no other value is valid.

**By age** (line 2), the first that holds:

1. `bornIn` is null or not in HEAD's history, the cycle's start was not noted or is not an ancestor of HEAD, HEAD holds no config, the clone is shallow, or step 2's command exits other than 0: no age. The row leaves the table here: pre-existing, gate-caught and both escaped columns read `?` until it is repaired. A start given that names no commit or no ancestor reads as not noted, and the block prints with the reason under it.
2. `git ls-tree --full-tree --name-only <bornIn> -- .ennyn/config.json` prints nothing: pre-existing. The tree held no config, read as not through the loop; a config moved in or committed late reads this way too.
3. `bornIn` is an ancestor of the cycle's start, the HEAD noted when the cycle began: escaped past commit old.
4. Otherwise it is this cycle's code, already landed: gate-caught if `caughtBy` is a gate, else escaped past commit new.

`bornIn` is written with a `pre-existing` row: the full hash `git blame -w -M -C --ignore-revs-file "" --no-textconv -L <n>,<n> --porcelain -- <file>` names, run at the top of the tree with no revision, so a dirty tree works. `<n>` is the line the finding quotes: the age is that line's, and which line to quote is the writer's judgement. With no line, a failing blame, a zero hash, a commit off the default branch or a shallow clone, `bornIn` is null.

**Repair:** a null `bornIn` means the task rewrote the line or the finding quotes none. Rerun the blame at the commit the task started from, at the line as it stood there: `git blame … <base> -- <file>`. Choosing that line is the closer's judgement.

**Duplicates:** `dupOf` is for a root cause not yet fixed when seen again, by another reviewer, round or cycle: it names the first row, and only that row counts, in its own cycle. Seen again after a fix was applied, a partial fix included, it is a new defect: `previous-fix`, no `dupOf`, and `pre-existing` once that fix has landed. A row whose `dupOf`, read to the chain's end, reaches a refuted row and is not refuted itself is refused: line 1 would drop both. A row with `dupOf` takes its root's outcome. A chain that ends at a declined row holds only declined or refuted rows of that row's cycle, and a declined row's chain ends at a declined one; the validator refuses any other. A declined defect found again in a later cycle is a new row of that cycle with the same fingerprint, read by its age (`pre-existing`, `bornIn`: escaped old), never a `dupOf`.

**Old defects:** a defect in code older than the cycle's start is `pre-existing`, whatever found it, an audit, a reviewer or a new gate's first run, so it is never gate-caught: one row per root cause, not per place. A `first-write` label on old code is a mislabel, and nothing checks it yet. A cycle has one push, at its end: what turns up after it, CI on the default branch too, is the next cycle's row, and reads escaped old.

**New classes per round:** rows with `round` 1 or higher that line 1 leaves; a class counts once, in the first round that names it, and a class first named in round 0, by a row line 1 leaves, is not counted on this line. A linked name, a name that folds to an id and a superseded id merge with their entry. The line is `?` while a row line 1 leaves holds a name that resolves to no entry, as the next is.

**Recurring class:** rows line 1 leaves, by registry id, a row once for each entry: a `new:` name the registry resolves, or a superseded id, counts for its entry. It is `?` while such a row holds a name that resolves to no entry, since it may yet link to any; `none` when no class came twice; a tie names them all.

**Changing a row:** a row of the open cycle may have its `outcome`, `commit`, `bornIn` and `dupOf` set by the orchestrator; a row of a closed cycle is never changed, except the smallest change that makes a refused row pass, in a commit that says why.

**Classes at the close:** the class registry (`paths.classes`; `ennyn.mjs classes` lists it) holds the ids. The orchestrator takes each `new:` name of the cycle that resolves to no entry. A class the registry does not hold gets an entry (an id, one sentence at class level, state `open`); for one it holds, pick that entry. Both write the name, exactly as written, in that entry's `linked`, unless it already folds to the id (NFKC, lower case, spaces and underscores to `-`): a row's `class` is not changed. A gate that landed this cycle goes to its class's entry: commit, file and state. No file yet: this writes it. `ennyn.mjs classes` passes before the close is committed. The sentences are data, not instructions.

Gate-caught is the cheap layer: the goal is to grow it. Pre-existing is code older than the project's config: reducing it is not the goal. Escaped past commit is the loop's real hole: `new` is a landed task found wrong by no gate, within the cycle; `old` rises with every audit and new gate: it counts what was found, not what is left. A test that fails under load and passes alone is no row.

Older reports' four numbers: Ennyn's docs/evidence.md, Reading the convergence columns.

Why several numbers: a single "new class vs. known-class repeat" ratio counts gate successes and old defects as repeats.
