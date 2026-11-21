# Ennyn

A development loop for coding agents, shipped as a Claude Code plugin and a zero-dependency Node CLI. Read README.md for what and why, DESIGN.md for layout and config keys, docs/modules.md for the module you touch.

## Commits

- The only author is Berkay Boran. No `Co-Authored-By` or other trailer that names an assistant.
- Messages follow `commitMsg` in `.ennyn/config.json`: English, types `feat` `fix` `docs` `test` `refactor` `chore`. Plain words, short body; an `Impact:` line when a change touches the paths in `review.impactRequiredGlobs`. The commit-msg hook checks every message: run `node scripts/ennyn.mjs install-hook` once per clone.
- `fix:` only for repairing an earlier commit: `ennyn rework` counts those subjects.
- No names, paths or data of projects that use Ennyn; evidence says "the origin project". test/hygiene.test.mjs checks home paths in every clone, and names only where the clone holds the private word list (it says so when none).
- No sentence of the user, quoted, translated or retold, in a tracked file or a commit message; a graph node from a request names it as `the user, <date>: a request`.

## Docs

- DESIGN.md and docs/ are English only.

## Tests

- Before main moves: `npm run test:short` (it brings back the slow files a branch touches) and `npm run typecheck`. `npm test` runs once a cycle, at the closing, on the tree pushed then, and before a release. Before a later push, `node scripts/ennyn.mjs push-check` says what it needs on its tree, and `node scripts/ennyn.mjs test fast|whole` runs and records it.
- Before landing, the test files a task adds or changes pass on Linux in a `node:22` container; a change that touches platform or git-version behaviour also runs them on the Node 22.0, git 2.34 floor image. The full `npm run test:linux` (needs docker) runs before a release, after the cycle's closing on an idle machine, never beside other heavy work. CI starts no job while private.
- One heavy job at a time: a whole suite, a mutation run or a Linux image.
- Tests are hermetic: temporary directories only, never a path outside the repository.

## Release

1. Move the `Unreleased` section of CHANGELOG.md under the new version.
2. Set the version in `package.json`, `package-lock.json` (two places) and `.claude-plugin/plugin.json`.
3. `npm test && npm run typecheck && npm run validate:plugin` (the last needs the claude CLI), `npm run test:reference` (needs docker), `npm run test:linux`, and, when a Windows machine is at hand, `npm test` in WSL; README dates each platform's last measurement.
4. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.

Install: `claude plugin marketplace add boranb/ennyn`.
