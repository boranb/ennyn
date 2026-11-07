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

The cycle asks the user before any push. A Claude Code ask rule is the backstop: it prompts before a matching command in every permission mode, bypassPermissions included, over any allow rule and a PreToolUse hook's allow, unless a `PermissionRequest` hook in the settings answers it: then the call runs and no one is asked. It reads a compound command only if Claude Code's parser finishes: past that, a command later in the text runs unasked in bypassPermissions, and a comment holding an apostrophe after a redirect does the same (`SECURITY.md`). `.claude/settings.json` applies the rule without the workspace trust step.

1. **Propose** each rule in `agentSetup.ask.rules` with `where` null or `local` (a rule only in `.claude/settings.local.json` reaches no other clone), with its `PowerShell` twin: `git push`; `npm publish` when the repository has a package.json; with a remote on a GitHub host (`agentSetup.ask.githubRemotes`) or no remote at all, since `gh repo create x --source . --push` runs before there is one, `gh pr merge`, `gh repo sync`, `gh release`, `gh repo create`, `edit`, `delete`, `rename` and `archive`, `gh gist create`, and `gh api` with a write method. When every remote is on another host (`agentSetup.ask.otherRemotes`) none of these is proposed: say that `gh repo create` and `gh api` run unasked there, and that an SSH alias or an Enterprise host the scan cannot recognize reads as another host. Write each `rule` as the scan gives it: `Bash(gh api *-X POST*)` has no space before its last `*`, and with one Claude Code runs `gh api repos/x -X POST`. Propose `Bash(<command> *)` and `PowerShell(<command> *)` for the publish and deploy commands the user names (`pnpm publish`, `npm run deploy`).
2. **Write** them into `permissions.ask` of `.claude/settings.json` on the user's yes, keeping every other key, and commit the file with the config: `uncommitted` or `local` rules reach no other clone.
3. **Say the limits** as `ennyn doctor`'s ask line words them (where Claude Code applies the file, the spellings it does not match). The rule is a backstop, not the gate. Of `gh api`, these rules stop `-X POST` and `--method POST` as written, for POST, PATCH, PUT and DELETE. gh also sends a method written any other way, and those run unasked: glued (`-XPOST`, `-iX POST`), with `=` (`--method=POST`), in lower case or quoted. So does `-f`, `-F` or `--input` with no method, which posts. A read whose text holds `-X POST` stops like a write: a search, a `--jq` filter, a `grep` after a pipe. Rephrase the read.
4. **Check** with `ennyn doctor`: `✓ ask rules` counts the rules the committed file holds, with these limits; `!` names those missing, uncommitted or only local, the first eight and the number of the rest; `?` what it could not read. `Bash(gh release *)` also asks before `gh release view`, `list` and `download`.

## Who says yes to the push

Ask it as its own question, before the ask rules are proposed: "At the end of a cycle, should the agent ask you before it pushes (`ask`, the default), or push by itself once the closing's checks and the whole test passed on that commit (`after-closing`)?" (The node that asks it beside the no-bypass mode is open: `secret-agent-setup`.)

- `ask`, a bare "ok" or no answer: write no key. Propose the `git push` rules with the rest.
- A plain `after-closing`: write `"push": { "mode": "after-closing" }`, leave both `git push` rules out of what you propose, and carry `User-Approved-Loosening: push.mode` in the commit that writes the config (the hook refuses it without). Say what it means: the closing pushes with a bare `git push` of the current branch to its upstream, only when `ennyn push-check --tested` allows it ([../cycle/push.md](../cycle/push.md)), and names it in the report; no ask rule stands for `git push`, so a bare `git push` also runs unasked at any other time that check holds; the push hook still asks about every other push (a force, a refspec, `--delete`, `--mirror`) and refuses an odd spelling.

`ennyn doctor` names the mode, and warns when a `git push` rule would stop the closing's push.

## Ask rules to offer

`agentSetup.offered` lists two more sets of rules, leaving out those the project holds in either settings file: `destroys`, what destroys local work or data (`git clean`, `git reset --hard`, `git checkout --` and `.`, `git restore`, `git branch -D`, `git worktree remove`, `git stash drop` and `clear`, the docker prunes, `docker volume rm`, `docker compose down -v`, `dropdb`, `terraform destroy`, the prisma resets); `installs`, what installs outside the project (`npm install -g`, `pnpm add -g`, `pip install`, `brew install`, `cargo install`, `go install`, a script piped to `sh` or `bash`). They are a choice, never a default.

1. **The interview asks** whether this project runs unattended cycles, default yes (SKILL.md, question 4). Yes, a bare "ok" or no answer: offer neither set. A rule on these commands stops such a cycle, `pip install` as much as `git clean`. Go to step 4.
2. **On a plain no, offer** each set in one question, with step 4's lines, and ask for the project's own reset or drop scripts by name. Its default is none: "ok" to this question writes none.
3. **Write** only what the user picks, as above, each `rule` as the scan gives it, a named script as `Bash(<script> *)` and its twin. Asked nothing, write nothing. Doctor says nothing of a set declined.
4. **Say in the report.** With a project that runs cycles, this line alone: Neither set was offered: a rule on these commands stops an unattended cycle, since it cannot tell a task's worktree from the main checkout. Otherwise, whatever the answer:
   - These rules read command text and are no boundary: an option before the subcommand, a script or an interpreter gets past them.
   - A rule here stops an unattended cycle: it cannot tell a task's worktree from the main checkout.
   - They stop on text, so some harmless commands stop too: `docker compose down api-v2`, `npm install --global-style tsx`, and a pipe, read as one text, as in `docker compose down 2>&1 | grep -v warning`.
   - They stop the usual spelling, not every one: `git -C <dir> clean`, `git branch -df`, another runner (`pnpm exec`, `bunx`, `python -m pip`) and a script saved and then run stay open, and `pip install` also asks inside a virtualenv, which a rule cannot see.

## Plan approval that clears the context

Claude Code's `showClearContextOnPlanAccept` makes the first option of the plan-approval dialog clear the context and start from the plan alone: the first route a cycle's closing takes to a fresh context ([handover.md](../cycle/handover.md)). Offer it in question 4. On the user's yes, write `"showClearContextOnPlanAccept": true` into `.claude/settings.json`, keeping every other key, and commit it with the config; never into the user's own settings, where it would change the dialog in every project. Say that the VS Code panel does not show the option (Claude Code 2.1.319): there the closing names `/clear` instead.

## A first config that loosens a default

The commit-msg hook compares a first config with the defaults, as it compares any config with HEAD's. A value looser than the default (a shorter `security.deps.cooldownDays`, a longer `security.everyCycles`, the project's own `commitMsg.structuredLines`) is refused until the commit's message holds a body line `User-Approved-Loosening: <key>, <key>` naming each key. The user's answer to the question that set the key is that yes, for that key alone. A key they were not asked about: ask, in plain words, before you write the line.
