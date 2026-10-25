# Gates init sets up

## A ban line becomes a `review.forbidden` rule

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

## Ask rules for what leaves the machine

The cycle asks the user before any push. A Claude Code ask rule is the backstop: it prompts before a matching command in every permission mode, bypassPermissions included, over any allow rule, and `.claude/settings.json` applies it without the workspace trust step.

1. **Propose** each rule in `agentSetup.ask.rules` with `where` null or `local` (a rule only in `.claude/settings.local.json` reaches no other clone), each command as `Bash(<command> *)` and its `PowerShell(<command> *)` twin: `git push`; `npm publish` when the repository has a package.json; `gh pr merge`, `gh repo sync` and `gh release` when a remote is on a GitHub host (`agentSetup.ask.githubRemotes`). Propose both forms too for the publish and deploy commands the user names (`pnpm publish`, `npm run deploy`).
2. **Write** them into `permissions.ask` of `.claude/settings.json` on the user's yes, keeping every other key, and commit the file with the config: `uncommitted` or `local` rules reach no other clone.
3. **Say the limits.** Claude Code applies the file only in a session started at the repository's top, and skips it whole when any setting in it is one it rejects; a cloud project thread reads none. A rule matches the command as written, after Claude Code splits `&&`, `;` and pipes and strips wrappers such as `timeout`, `env` and a leading variable. Not matched: `git -C dir push`, `git -c k=v push`, `/usr/bin/git push`, `sh -c '…'`, a git alias, a script or make target that pushes, `gh api`, an MCP tool that writes to the remote. The rule is a backstop, not the gate.
4. **Check** with `ennyn doctor`: `✓ ask rules` names the rules the committed file holds, with these limits; `!` names those missing, uncommitted or only local; `?` what it could not read. `Bash(gh release *)` also asks before `gh release view`, `list` and `download`.
