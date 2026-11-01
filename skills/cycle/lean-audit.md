# Lean items of a legacy audit

A legacy audit ranks what it finds: correct, safe, holds under load, tested, fast, and only then lean. After the re-check, list what the audited feature could lose, in its own files only, each item with its lines:

- **Dead code:** a function, a branch or an export nothing reaches; commented-out code.
- **Options no config sets:** a key no project's config holds, and no user story or escape hatch names. A way out that stays without the key (a command's flag, a number the reader takes as it is) is no reason to keep it. One init writes or doctor reports is.
- **A hand-written reader the platform or git already gives.** One a written promise pays for (no dependencies) stays.
- **Near-copies that must change together:** both places, and what makes them drift.

## What happens to an item

- A deletion lands in the same task only with the tests and the mutation pass green. A larger one becomes a graph node: an item whose removal needs more than its own code, its reader's fallback, its document row and its tests.
- A removed branch goes with its option: no constant left where the choice was, except the one value the reader still needs.
- A config key is a contract: after the first release a removed key breaks the projects that set it. Removing a key a gate reads is the user's to say, as loosening a gate is (`SKILL.md`, step 11).
- No rewrite of code for size. No automatic removal of unused imports while other worktrees are open: a branch in parallel may be what uses one.

## In the report

Lean items are their own group, under `### Audit` ([report-formats.md](report-formats.md)): listed, removed, sent to a node. They are never findings: no ledger row, no count in the convergence block, and never a reason for another review round.
