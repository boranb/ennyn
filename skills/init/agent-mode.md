# The agent's mode

`init-scan` gives `agentSetup.secrets`: the mode the settings files put the agent in (`noBypass`, or `asIs`), what leaves a secret open, and `proposal`, the exact block the no-bypass mode writes. Doctor reports the same lines.

## The one question

Ask it in question 4, after the push question: "Keep the agent as it is, or run it without bypass?" Show what each means:

- **As it is** (the default; "ok" or no answer): nothing is written. Whoever runs in bypassPermissions keeps it. The report lists what doctor says is open (Read deny rules missing, a secret in `.mcp.json`, the Claude Code folder inside a git work tree), each for the user to fix or keep.
- **Without bypass**: the sandbox is on and the session stops when it cannot start (`failIfUnavailable`); commands that run inside it are allowed without a prompt; file edits are accepted (`acceptEdits`); bypassPermissions is turned off; sandboxed commands may write the folder that holds the cycle's worktrees and reach the hosts the project's commands need; the Read tool may not read `.env*`, `~/.ssh` or `~/.aws`, and sandboxed commands may not read `~/.ssh`, `~/.aws` or the token variables set now. Ask two things with it: the folder that holds the cycle's worktrees, which goes in `allowWrite` (the scan proposes none: no setting of the cycle names that folder, so the user names it, and the cycle must put its worktrees there, or sandboxed commands in them cannot write), and the file, `.claude/settings.local.json` for this person or `.claude/settings.json` for the team (committed with the config).

## Writing the block

Only on a plain "without bypass". Write `proposal` as the scan gives it, with the user's folder as the one entry of `allowWrite` and any host they name added to `allowedDomains`, into the chosen file, keeping every other key: a list the file holds already (`permissions.deny`, `allowWrite`, `allowedDomains`, `credentials`) gets the new entries after its own; a key the file sets to another value is shown and asked about, never overwritten.

Every value is one Claude Code was measured to keep the file with (2.1.310 and 2.1.319). A wrong one makes it skip the whole file, the project's ask rules with it: `disableBypassPermissionsMode` is the string `"disable"`, never `true`; `sandbox.enabled` is `true`, never `"true"`; a credentials `mode` is `deny`. Write no other value for these keys. Then run `ennyn doctor`: its mode line says the settings ask for no bypass, and no agent-setup line says a file may be skipped. That line reads the files, it is no proof: Claude Code skips a settings file whole for a wrong value of any of its keys, and Ennyn checks only the keys it reads. So ask the user for one more step: start a new Claude Code session at the repository's top with `claude --permission-mode bypassPermissions` and check that the permission mode Claude Code shows is not bypass. Only Claude Code can say it applied the file. A session started in a subdirectory reads that directory's `.claude/`, where the mode does not hold.

Say in the report:

- The block does not set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: set in the environment, it starts Claude Code in the default permission mode whatever the settings say, so it cancels both bypass and `acceptEdits`. Doctor warns when it is set.
- `credentials` here holds `deny` entries only: Claude Code does not apply `mask` entries from a project file. A token a command must use (a `gh` call, a publish) can be masked in the user's own `~/.claude/settings.json` or a `--settings` file instead; a denied one is unset for sandboxed commands, and a command that needs it fails, then Claude may retry it outside the sandbox, which asks.
- A host not in `allowedDomains` is asked about; `git push` over SSH reads `~/.ssh`, which the block denies to sandboxed commands, so the push is retried outside the sandbox and asked about, like every push.
- Doctor reads the project's settings files and the user's, not managed settings or the flags a session starts with.

The cycle's plan repeats doctor's mode line (`skills/cycle/report-formats.md`).
