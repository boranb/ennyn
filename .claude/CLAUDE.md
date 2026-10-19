# Ennyn

A development loop for coding agents, shipped as a Claude Code plugin and a zero-dependency Node CLI. Read README.md for what and why, DESIGN.md for layout, config keys and module APIs.

## Commits

- The only author is Berkay Boran. No `Co-Authored-By` or other trailer that names an assistant.
- Messages follow `commitMsg` in `.ennyn/config.json`: English, types `feat` `fix` `docs` `test` `refactor` `chore`. Plain words, short body; an `Impact:` line when a change touches the paths in `review.impactRequiredGlobs`. The commit-msg hook checks every message: run `node scripts/ennyn.mjs install-hook` once per clone.
- `fix:` only for repairing an earlier commit: `ennyn rework` counts those subjects.
- Nothing about the projects that use Ennyn goes into this repository: no names, paths or data. Evidence is written anonymously, as "the origin project".

## Docs

- README.md and README.tr.md say the same thing; change both in the same commit. DESIGN.md and docs/ are English only.

## Tests

- `npm test` and `npm run typecheck` both pass before every commit.
- Tests are hermetic: temporary directories only, never a path outside the repository.

## Release

1. Move the `Unreleased` section of CHANGELOG.md under the new version.
2. Set the version in `package.json`, `package-lock.json` (two places) and `.claude-plugin/plugin.json`.
3. `npm test && npm run typecheck && npm run validate:plugin` (the last needs the claude CLI; it checks the manifests, agents, skills and hooks as Claude Code loads them).
4. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.

Install: `claude plugin marketplace add boranb/ennyn`. The repository stays private until the public release.
