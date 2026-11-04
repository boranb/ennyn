# Ennyn

A development loop for coding agents, shipped as a Claude Code plugin and a zero-dependency Node CLI. Read README.md for what and why, DESIGN.md for layout, config keys and module APIs.

## Commits

- The only author is Berkay Boran. No `Co-Authored-By` or other trailer that names an assistant.
- Messages follow `commitMsg` in `.ennyn/config.json`: English, types `feat` `fix` `docs` `test` `refactor` `chore`. Plain words, short body; an `Impact:` line when a change touches the paths in `review.impactRequiredGlobs`. The commit-msg hook checks every message: run `node scripts/ennyn.mjs install-hook` once per clone.
- `fix:` only for repairing an earlier commit: `ennyn rework` counts those subjects.
- No names, paths or data of projects that use Ennyn; evidence says "the origin project". test/hygiene.test.mjs checks.

## Docs

- DESIGN.md and docs/ are English only.

## Tests

- Before main moves: `npm run test:short` (it brings back the slow files a branch touches) and `npm run typecheck`. Before a push: `npm test` once, on the tree that is pushed.
- Before a push, the test files the push adds or changes pass on Linux in a `node:22` container; a change that touches platform or git-version behaviour also runs them on the Node 20 and git 2.34 floor image. The full `npm run test:linux` (needs docker) runs before a release, after the cycle's closing on an idle machine, never beside other heavy work. CI starts no job while the repository is private.
- One heavy job at a time: a whole suite, a mutation run or a Linux image.
- Tests are hermetic: temporary directories only, never a path outside the repository.

## Release

1. Move the `Unreleased` section of CHANGELOG.md under the new version.
2. Set the version in `package.json`, `package-lock.json` (two places) and `.claude-plugin/plugin.json`.
3. `npm test && npm run typecheck && npm run validate:plugin` (the last needs the claude CLI; it checks the manifests, agents, skills and hooks as Claude Code loads them), `npm run test:reference` (the npm, marked, Actions YAML and claude records; needs docker) and `npm run test:linux`.
4. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.

Install: `claude plugin marketplace add boranb/ennyn`. The repository stays private until the public release.
