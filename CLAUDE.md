# Ennyn

A development loop for coding agents, shipped as a Claude Code plugin and a zero-dependency Node CLI. Read README.md for what and why, DESIGN.md for layout, config keys and module APIs.

## Commits

- The only author is Berkay Boran. No `Co-Authored-By` or other trailer that names an assistant.
- Messages in English, conventional style: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Plain words, short body. Check with `node scripts/ennyn.mjs commit-check <message-file>`.
- `fix:` only for repairing an earlier commit: `ennyn rework` counts those subjects.
- Nothing about the projects that use Ennyn goes into this repository: no names, paths or data. Evidence is written anonymously, as "the origin project".

## Tests

- `npm test` and `npm run typecheck` both pass before every commit.
- Tests are hermetic: temporary directories only, never a path outside the repository.

## Release

1. Move the `Unreleased` section of CHANGELOG.md under the new version.
2. Set the version in `package.json`, `package-lock.json` (two places) and `.claude-plugin/plugin.json`.
3. `npm test && npm run typecheck`.
4. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.

Install: `claude plugin marketplace add boranb/ennyn`. The repository stays private until the public release.
