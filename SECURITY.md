# Security

Ennyn runs inside other projects: in their commits (the commit-msg hook) and in their Claude Code sessions (the plugin's hooks). A defect in it can be a defect in each of them.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting (the repository's **Security** tab, **Report a vulnerability**), which is switched on when the repository becomes public; until then the repository is private and its owner is the one to tell. Do not open a public issue for it. Say which version (`package.json`) or commit, which command or hook, and the smallest input that shows it.

## Supported versions

Ennyn is pre-release (0.0.x): fixes go to the newest commit on `main` only.

## What Ennyn runs on a machine

- **The commit-msg hook** (`ennyn install-hook`, never installed without being asked): `node scripts/ennyn.mjs commit-check` on every commit. It reads the message, the git config that shapes it, the config, the staged paths, the lines the `review.forbidden` rules name, and both versions of the staged CI files, lock files and `.npmrc` (of an `.npmrc`, only the keys that change where npm fetches packages from, which config it reads, or what it runs: `registry`, `<scope>:registry`, `replace-registry-host`, `proxy`, `https-proxy`, `http-proxy`, `strict-ssl`, `ca`, `cafile`, `userconfig`, `globalconfig`, `prefix`, `cache` with `offline` or `prefer-offline`, `script-shell`, `node-options`, `git`, `shell`, `ignore-scripts`; tokens and other values are not shown). For the secret scan (`security.secrets`) it also reads, from git, the lines every staged file adds (the files a commit adds whole, by their object; the smallest first, up to 64 MB of a commit), the names the commit adds, and a file whose added lines look like part of a private key, whole; it prints where a secret is and its kind, never the secret, and the scan connects to nothing. It writes nothing. It connects only when a commit changes a lock file (below).
- **Claude Code hooks** (`hooks/hooks.json`): after a file tool touches a side copy of the project, the project's path-scoped rules (`.claude/rules/`) go into the session, and the list of rules given is kept in the state dir (`paths.stateDir`); at session start, that list is reset after compaction, and the conversation style text (`styles/`) is given.
- **Commands** run only when you run them. `mutate` runs the test command it is given and edits files in place, writing each back byte for byte.
- **No runtime dependency**: `package.json` has none. Its two development dependencies (`typescript`, `@types/node`) serve the type check only.
- **Network, only where named**: the commit-msg hook connects only when a commit changes a lock file (`security.deps.paths`), and only to the origins in `security.deps.registries`, about the entries the commit adds whose `resolved` is that registry's own tarball, or that have none and whose registry the `.npmrc` beside the lock names and `security.deps.registries` lists (with no such `.npmrc` the entry is refused and nothing is asked), and at most 160 MB an answer and 256 MB at once: by default `registry.npmjs.org` for the package document and `api.npmjs.org` for last week's downloads. `security.deps.online: false` stops it. `ennyn deps` sends the name and version of each lock entry from the public registries in `security.deps.advisoryRegistries` (by default only `registry.npmjs.org`) to OSV (`security.deps.advisories`, by default `api.osv.dev`); a private registry's package names never leave the machine, and neither do bundled packages, whose versions the lock cannot prove. No other command or hook connects anywhere.

## How this repository is kept

- Every action in `.github/workflows/` is named by its full commit SHA; the workflow token can only read, checkout leaves no credential behind, and `npm ci` runs no install script. The commit-msg hook refuses a new action named by a tag and a workflow that drops its permissions (`security.ci`), but `git revert`, `cherry-pick` and `rebase` run no commit-msg hook; `test/engines.test.mjs` holds the workflow's whole text.
- `npm run test:linux` runs the suite before each push on images pulled by digest.
- `.npmrc` sets `ignore-scripts=true`: `npm ci` and `npm install` here run no dependency's install script, while `npm test` and `npm run` still run the named script. The commit-msg hook refuses a new package with an install script unless `security.deps.allowScripts` names it, and install scripts the registry's manifest shows that the lock leaves out; a binding.gyp neither shows is not seen, since the tarball is not read. `ignore-scripts` does not reach a git dependency: npm builds one by running its `prepare`, so the hook refuses a new git dependency unless `security.deps.sources` names it pinned to a full commit, and any entry whose source has no one meaning it can prove.
