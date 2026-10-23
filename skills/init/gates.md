# Turning a ban line into a gate

`init-scan` lists `bans`: lines in the project's instructions that forbid a literal they name in a code span. Each literal comes with the lines of the index that hold it today (`lines`, `files`, `examples`; the instruction files and the config are not counted, and the count covers the whole index, not the line's own scope) and whether a `review.forbidden` rule holds it already (`gated`).

1. **Propose.** Only for a literal that is file content the project keeps out; a command, a branch name or a commit trailer is not. Show the line and its counts, and propose a rule:
   - `text`: the literal as written (case and spaces count);
   - `paths`: where the line says it applies; `**` when it names no place;
   - `except`: files that may hold it (the logger that wraps `console.log`, a document that names it);
   - `note`: the line's reason, in its own words. The hook prints it when it refuses a commit.
2. **Write** the rule into `review.forbidden` on the user's yes. Keep the line for now.
3. **Count** after `ennyn install-hook`: `ennyn doctor` counts, per rule, the lines inside `paths` that hold the text today. Many there mean the rule is not kept. Say so: the user fixes them, narrows `paths`, or drops the rule and keeps the line. A commit that adds a line holding the text fails either way. The old lines stay until someone changes them. A moved file counts in full.
4. **Delete the line** only when doctor shows the commit-msg hook running commit-check (`✓ commit-msg hook`). With `core.hooksPath`, a declined hook or a hook that is not Ennyn's, the line stays. The hook is this clone's own: another clone, CI or a cloud session checks nothing until it runs `ennyn install-hook` (doctor there warns). Say so in the report, so the user decides whether the line goes now.

The report names each line turned into a gate, and each one kept with why.
