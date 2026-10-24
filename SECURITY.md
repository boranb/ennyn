# Security

Ennyn runs inside other projects: in their commits (the commit-msg hook) and in their Claude Code sessions (the plugin's hooks). A defect in it can be a defect in each of them.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting (the repository's **Security** tab, **Report a vulnerability**), which is switched on when the repository becomes public; until then the repository is private and its owner is the one to tell. Do not open a public issue for it. Say which version (`package.json`) or commit, which command or hook, and the smallest input that shows it.

## Supported versions

Ennyn is pre-release (0.0.x): fixes go to the newest commit on `main` only.

## What Ennyn runs on a machine

- **The commit-msg hook** (`ennyn install-hook`, never installed without being asked): `node scripts/ennyn.mjs commit-check` on every commit. It reads the message, the git config that shapes it, the config, the staged paths, the lines the `review.forbidden` rules name and both versions of the staged CI files. It writes nothing and connects to nothing.
- **Claude Code hooks** (`hooks/hooks.json`): after a file tool touches a side copy of the project, the project's path-scoped rules (`.claude/rules/`) go into the session, and the list of rules given is kept in the state dir (`paths.stateDir`); at session start, that list is reset after compaction, and the conversation style text (`styles/`) is given.
- **Commands** run only when you run them. `mutate` runs the test command it is given and edits files in place, writing each back byte for byte.
- **No runtime dependency**: `package.json` has none. Its two development dependencies (`typescript`, `@types/node`) serve the type check only.
- **No network**: no command or hook connects anywhere.

## How this repository is kept

- Every action in `.github/workflows/` is named by its full commit SHA; the workflow token can only read, checkout leaves no credential behind, and `npm ci` runs no install script. The commit-msg hook refuses a new action named by a tag and a workflow that drops its permissions (`security.ci`), but `git revert`, `cherry-pick` and `rebase` run no commit-msg hook; `test/engines.test.mjs` holds the workflow's whole text.
- `npm run test:linux` runs the suite before each push on images pulled by digest.
