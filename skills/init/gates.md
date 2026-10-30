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
4. **Delete the line** only when doctor shows the commit-msg hook running commit-check (`✓ commit-msg hook`). With `core.hooksPath`, a declined hook or a hook that is not Ennyn's, the line stays. The hook is this clone's own: another clone, CI or a cloud session checks nothing until it runs `ennyn install-hook` as SKILL.md does (doctor there warns). Say so in the report, so the user decides whether the line goes now.

The report names each line turned into a gate, and each one kept with why.

## The commit-msg hook

`install-hook` writes this clone's own hook. Under a tracked `core.hooksPath` or husky it writes nothing: from the plugin it prints a block for the project's own hook and the file it goes in.

1. **Show** the block and the file. It goes at the top, before any other command and above husky's own line, so the hook's early exits (exempt subjects, a marker) skip only the project's checks; it names no path of this machine. A project line after it that rewrites the message file changes what is committed, unchecked.
2. **Paste** it on the user's yes: the file is tracked, so every clone runs it, and a clone without the plugin passes each commit with a warning. A new file starts with `#!/bin/sh` and must be executable.
3. **Check** with `ennyn doctor`: `✓ commit-msg hook`, or `!` when the hook is not what install-hook printed, first: paste the block again, exact, at the top. Doctor reads no hand-written shell. Before the block may stand only a shebang (`sh`, `bash`, `dash`, `ksh`, `zsh` or `ash` in a system directory or Homebrew's, or through `/usr/bin/env`; flags `-e`, `-u`, `-x`), comments, blank lines and `set` lines with those flags. husky's own `. "$(dirname …)/_/husky.sh"` goes below it: husky 6 to 8 then run the check twice, harmlessly. A hook that runs other checks first warns and stops no commit: move them below the block. An older block reads the same after an update. `!` also names a file in husky's `_` directory that the index holds: take it out. `!` also says when the filter leaves no node, or the block finds no record or one it cannot run.

What the block does not close, stated so nobody counts on it:

- Whoever sets the shell's startup from the environment (`SHELLOPTS=noexec`, `BASH_ENV`, `ZDOTDIR`, `BASH_FUNC_*`) or `UNAME_s` has the power of `--no-verify`, with no flag to see. So has whoever points `ENNYN_PLUGIN_DATA` or `CLAUDE_CONFIG_DIR` at a directory outside the work tree, whose record names what runs.
- husky's generated stub is not read, only whether the index holds it. `~/.config/husky/init.sh` exiting, `HUSKY=0` and `--no-verify` skip the hook.
- A version manager's shim kept on PATH can pick its node from a repository file (from memory, not measured).
- A work tree that holds the data directory (the dotfiles pattern) refuses clean commits; `install-hook` answers `dataInRepository` there.
- A project whose only node lies in the work tree commits unchecked; `doctor` says so.
- A NUL or a C1 byte in the record is read as each shell reads it.
- A project line after the block can rewrite the message, and what is committed goes unchecked.

## Ask rules for what leaves the machine

The cycle asks the user before any push. A Claude Code ask rule is the backstop: it prompts before a matching command in every permission mode, bypassPermissions included, over any allow rule, and `.claude/settings.json` applies it without the workspace trust step.

1. **Propose** each rule in `agentSetup.ask.rules` with `where` null or `local` (a rule only in `.claude/settings.local.json` reaches no other clone), each command as `Bash(<command> *)` and its `PowerShell(<command> *)` twin: `git push`; `npm publish` when the repository has a package.json; `gh pr merge`, `gh repo sync` and `gh release` when a remote is on a GitHub host (`agentSetup.ask.githubRemotes`). Propose both forms too for the publish and deploy commands the user names (`pnpm publish`, `npm run deploy`).
2. **Write** them into `permissions.ask` of `.claude/settings.json` on the user's yes, keeping every other key, and commit the file with the config: `uncommitted` or `local` rules reach no other clone.
3. **Say the limits** as `ennyn doctor`'s ask line words them (where Claude Code applies the file, the spellings it does not match). The rule is a backstop, not the gate.
4. **Check** with `ennyn doctor`: `✓ ask rules` names the rules the committed file holds, with these limits; `!` names those missing, uncommitted or only local; `?` what it could not read. `Bash(gh release *)` also asks before `gh release view`, `list` and `download`.
