# ennyn — design

## What this is

A development method for coding agents, packaged so any project can adopt it. The method runs in **cycles of four tasks** picked from a **work graph**: two core tasks, one **mechanization** task (turns a recurring defect class into a gate, test, type or lint), and one **legacy audit** (re-checks a finished feature). Every task follows the same protocol: read → impact table (for risky changes) → implement → test → mutation pass → bounded adversarial review → commit. Every cycle ends with a **convergence** report (how many findings were real escapes, fix-introduced, pre-existing, or caught by a gate) and a handoff.

The method was extracted from a production project where it was measured (2026-10): see `docs/evidence.md`.

## Principles (each one is a measured decision, not a preference)

1. **Answer the risky questions before writing, with commands.** Shared decision / gate / accept-reject changes get a five-row impact table (who else reads this · which other paths reach this state · what is newly accepted or rejected · what happens at the ceiling or when measurement fails · where fakes come from). Each row is answered by a command, not by the model's guess.
2. **Review is bounded.** At most two review rounds, correctness and requirements only; round two looks only at the diff of round-one fixes. A third round needs an independent signal (test, mutation run, real measurement).
3. **Lessons become mechanisms, then the prose is deleted.** A recurring defect class becomes a graph node with `mechanization: true`; one slot per cycle is reserved for it. A lesson whose rationale lives in a test is retired from instruction files.
4. **Instruction text is a budget.** Always-loaded instructions are measured in tokens and only shrink.
5. **Small batches.** The cycle ends by asking for push approval; a warning fires above a threshold of unpushed commits.
6. **Measure the loop itself.** Findings carry a class and a source when they are written; convergence, rework (SZZ-style) and review-round yield are computed by scripts, not estimated.

## Layout

```
.claude-plugin/plugin.json          Claude Code plugin manifest
.claude-plugin/marketplace.json     single-repo marketplace (source "./")
skills/                             the method (SKILL.md files, < 8 KB each)
agents/                             reviewer agents sharing one finding schema
hooks/hooks.json                    Claude Code hooks (side-copy rule bridge)
scripts/ennyn.mjs                   CLI entry (no top-level bin/ — claude.ai/Cowork reject it)
core/                               config, glob, git, i18n (zero dependencies, Node >= 20)
checks/                             commit-shape, closeout (later)
side-copy/                          map a side-copy path back to the project path
impact/                             impact table runner
metrics/                            rework (SZZ-style), convergence, gate-attempt log, mutation ledger
plan/                               mechanization slot selection over the work graph
setup/                              /ennyn:init survey (init-scan) and setup check (doctor)
adapters/claude-code/               rules index (paths: front matter), hook entry points
i18n/{en,tr}.json                   message catalogs; output language comes from config
styles/<style>.<lang>.md            conversation style rules (focused, terse), injected at session start
schema/config.schema.json           config schema
test/                               node:test suites; npm test loads hostile.mjs (a hostile machine), then hermetic.mjs (clears it) into each
docs/                               method guide, evidence, adoption guide
```

## Project config

One file per project: `.ennyn/config.json` (override with `ENNYN_CONFIG`). Unknown keys are errors. Every field has an English default; a project overrides only what differs.

| Key | Default | Meaning |
|---|---|---|
| `language` | `"en"` | language of reports, CLI output and the conversation during a cycle (`en`, `tr`) |
| `conversation.style` | `"normal"` | `normal`, `focused` or `terse`; a SessionStart hook injects `styles/<style>.<language>.md`. Conversation only, never files or commits |
| `paths.handoff` | `"HANDOFF.md"` | cycle handoff document |
| `paths.changelog` | `"CHANGELOG.md"` | |
| `paths.graph` | `".ennyn/graph.json"` | work graph (JSON, or a `.mjs` module exporting arrays) |
| `paths.metricsLog` | `".ennyn/metrics.jsonl"` | per-cycle metrics, one JSON line each (`budget --record` writes `kind: "budget"`) |
| `paths.stateDir` | `".git/ennyn"` | machine-local state (never committed): side-copy injection lists, `gate-attempts.jsonl`; a `.git/…` value resolves through the common git dir, so linked worktrees share it |
| `graph.exports` | `{ "open": "nodes", "done": "done" }` | export names when the graph is a module |
| `graph.fields` | `{ "id": "id", "status": "status", "needs": "needs", "gate": "gate", "value": "value", "cost": "cost", "cluster": "cluster", "mechanization": "mechanization", "source": "source" }` | field names in the graph |
| `graph.openGateValue` | `null` | value of `gate` meaning "no gate" |
| `graph.doneStatus` | `"done"` | |
| `graph.valueScale` | `{ "high": 3, "medium": 2, "low": 1 }` | categorical value → weight (numbers are used as-is) |
| `graph.costScale` | `{ "S": 1, "M": 2, "L": 3, "XL": 5 }` | categorical cost → weight |
| `planner.mechanizationSlots` | `1` | |
| `commitMsg.language` | `null` | language of commit text; `null` follows `language` |
| `commitMsg.types` | `[]` | subject types, `type(scope): text`, enforced by `commit-check`; empty = free subject; chosen at `/ennyn:init` |
| `commitMsg.fixType` | `"fix"` | type of a commit that repairs an earlier one; must be one of `types`; `metrics.fixSubject` must match it (`doctor` checks) |
| `commitMsg.style` | `"normal"` | `terse`: no prose in the body, only structured lines and trailers (`commit-check`) |
| `commitMsg.subjectMax` | `120` | |
| `commitMsg.bodyMaxLines` | `8` | structured lines and trailers excluded |
| `commitMsg.bodyMaxChars` | `800` | |
| `commitMsg.structuredLines` | `["Root cause:", "Prevention added:", "Node:", "Mutation:"]` | prefixes not counted toward the body limit |
| `commitMsg.structuredLineMax` | `300` | |
| `commitMsg.skipSubjects` | `["^Merge ", "^Revert ", "^fixup! "]` | regexes; subjects git writes itself are never checked (merges, reverts, fixup! commits that autosquash folds away whole). amend! and squash! carry text into history: commit-check checks the new message or the added body |
| `commitMsg.allowMarker` | `"[commit-shape-allow:"` | bypass marker; must carry a reason |
| `review.agents` | `[]` | reviewer agents the cycle uses (given the finding schema); empty = Ennyn's `code-reviewer`, `security-reviewer`, `data-reviewer` |
| `review.maxRounds` | `2` | |
| `review.roundsLine` | `"Review-Rounds:"` | body line carrying the round count |
| `review.thirdRoundLine` | `"Third-round:"` | required when rounds > max |
| `review.impactLine` | `"Impact:"` | body line carrying the impact summary |
| `review.impactRequiredGlobs` | `[]` | staged paths that require an impact line |
| `review.cochange` | `[]` | documents that move with code: `[{ "paths": [globs], "docs": [globs], "note": "…" }]`; `commit-check` warns (never fails) when one of `paths` is staged and none of `docs`. Staged paths, both names of a rename; a `squash!` target's paths count as documents that changed. With `--amend` only the new changes are staged, so a document the amended commit already holds still warns. `doctor` warns about a glob that matches no tracked file and a rule that can never warn |
| `push.warnAtUnpushed` | `20` | |
| `sideCopy.roots` | `[]` | absolute directories where side copies live (e.g. a scratch dir) |
| `sideCopy.maxInjectBytes` | `24000` | above this, the hook lists rule paths instead of inlining them |
| `impact.referenceCommand` | `null` | e.g. `node scripts/code-impact.mjs {symbol} --json` |
| `impact.twins` | `[]` | pairs of roots that mirror each other, e.g. `[["src/lib/engine", "server/src/lib"]]` |
| `impact.coChangeMin` | `3` | |
| `impact.ceilingRegistry` | `null` | path to a registry of ceilings/quotas |
| `impact.fakeGlobs` | `["**/*.test.*"]` | where fakes live |
| `impact.fixtureGlobs` | `["**/__fixtures__/**"]` | recorded real outputs |
| `metrics.reworkDays` | `7` | |
| `metrics.fixSubject` | `"^fix(\\(\|:)"` | a fix commit; if most commits match, the rate leans toward churn (the CLI says so) |
| `metrics.excludeRe` | docs, `.md`, dot-paths, `generated/` `dist/` `build/` `vendor/`, lockfiles | paths excluded from rework attribution; generated output rewritten by ordinary commits measures churn |
| `metrics.testRe` | `.test.` `.spec.` `/test/` `/__tests__/` `/__fixtures__/` | |
| `metrics.minLines` / `minShare` | `3` / `0.1` | strong link: the origin owns at least this many meaningful deleted lines and this share of the fix's deleted lines (or the fix message names its hash) |
| `metrics.maxFixFiles` | `15` | a fix touching more production files is a sweep and names no origin |
| `metrics.moveSubject` | refactor / rename / move / split / extract / codemod / reformat | origins whose subject says they moved code are skipped |

### Conversation style

`focused` follows the rules of i-have-adhd: the result or next action first, numbered steps, one next step, no preamble. `terse` follows the base voice of caveman, adapted for Turkish: suffixes are never trimmed, because negation lives in one (*sil* / *silme*). There is no "ultra" level. caveman's 3.1.0 release notes (10 questions, one run, length only) put its base voice 3% below a plain "Answer concisely." and its ultra level 35% below, the latter by dropping grammar; its rules cost about 1,160 input tokens per request. The gain is readability more than tokens. Both projects leave commits, code and documents alone, and so does this one: commit brevity is `commitMsg.style`, which removes prose, never grammar.

## Module contracts

All modules are ES modules, zero dependencies, JSDoc-typed, pure where possible. Functions that touch git or the file system take an explicit `cwd`.

- `core/config.mjs` — `loadConfig({ cwd, env }) → config` (defaults deep-merged; throws `ConfigError` listing every unknown key and every type mismatch, a `review.cochange` rule of the wrong shape, and every glob that does not compile).
- `core/glob.mjs` — `globToRegExp(pattern) → RegExp`, `matchAny(path, patterns) → boolean`. Supports `**`, `*`, `?`, `{a,b}`, `[...]`. Paths use `/`.
- `core/git.mjs` — `git(args, { cwd }) → string` via `execFileSync`, with `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_PREFIX` removed from the environment, the variables that reshape output or pathspecs removed too (`GIT_DIFF_OPTS`, `GIT_EXTERNAL_DIFF`, `GIT_*_PATHSPECS`), literal pathspecs (`src/[id].js` names that file only), and the config that reshapes output pinned (`log.showSignature=false`, `i18n.logOutputEncoding=UTF-8`, `diff.interHunkContext=0`, `log.follow=false`, `log.showRoot=true`; `diff.algorithm=myers` and `diff.indentHeuristic=true`, git's defaults, so the rework rate is the same on every machine). The oracle test runs the readers under a global config and an environment that set these and more. A message stored as UTF-8 under a wrong `encoding` header (i18n.commitEncoding set, an editor writing UTF-8) is re-encoded by git and reads wrong; `stagedPaths(cwd, { env? })` (both names of a rename; with a hook's environment it reads the index the hook was given, e.g. the temporary index of `git commit -- <path>`, but only when that index belongs to the same repository), `unpushedCount` (returns `null` when there is no upstream), `parseTrailers`, `commonDir`, `resolveStateDir`.
- `core/i18n.mjs` — `t(key, vars, lang)`; missing key in `lang` falls back to `en`; a test asserts every `en` key exists in every catalog.
- `checks/commit-shape.mjs` — `checkCommitShape(message, { config, stagedPaths, cleanup, foldTarget?, alsoChanged? }) → { ok, errors[], warnings? }`; `warnings` come from `cochangeWarnings(staged, rules, lang, alsoChanged?)` (review.cochange) and never change `ok`. It measures the message git will store: `cleanup` is git's mode (`"whitespace"` when the hook sees `GIT_EDITOR=":"`, i.e. `-m` / `-F`, where `#` lines are kept and counted; `"strip"` for the editor; `commit.cleanup` overrides both, `"verbatim"` and `"scissors"` included; a `--cleanup=` option never reaches the hook and is not measured). `gitCuts` decides the scissors line as git does: its exact line (the first), only with `-v` / `commit.verbose` or in the scissors mode. When the editor ran with the status template (it has lines that are the comment marker alone, in any language), the template decides: a scissors line git wrote has only comment lines and the diff under it, so `-v` and `--no-verbose` on the command line are seen there; with `-m` / `-F`, `--no-status` or `commit.status=false` there is no template, `commit.verbose` decides and a flag on the command line is not seen. `hookCommitMode({ cwd, message, env }) → { cleanup, comment, cut }` is what the hook reads: commit.cleanup, the comment marker (`commentMarker`: the last of core.commentChar and core.commentString set; `auto`, in any case, from the last line git wrote into the template, else git's rule over the message) and commit.verbose, in two `git config` calls with the hook's environment (`git -c` settings included). Not seen: `GIT_EDITOR=:` set by the user while git still runs the editor path (`--amend`), and `core.commentString` on a git older than 2.45, which ignores it. `test/git-oracle.test.mjs` commits a matrix of these through real git and compares what git stores; the cells a hook cannot see are listed there with the reason. Paths matching `review.impactIgnoreGlobs` (tests, fixtures) never require the impact line.
- `side-copy/map-path.mjs` — `mapSideCopyPath(absPath, { projectDir, roots }) → { root, relPath } | null` (git worktree: same `--git-common-dir`; plain copy: a root under `sideCopy.roots` whose `package.json` `name` equals the project's).
- `adapters/claude-code/rules-index.mjs` — `loadPathScopedRules(projectDir) → [{ file, patterns[] }]` from `.claude/rules/**/*.md` front matter `paths:`.
- `adapters/claude-code/hooks/side-copy-rules.mjs` — PostToolUse hook: for Read/Edit/Write on a side-copy path, emits the matching rules as `hookSpecificOutput.additionalContext`, once per rule per session; exits 0 on every path (never 2; 1 only when it cannot run). `side-copy-reset.mjs` (SessionStart, `compact|clear`) forgets the session's injected list so the rules come back after the context is compacted.
- `impact/table.mjs` — `buildImpactTable({ cwd, config, symbol?, files? }) → { rows }` (five rows, S1-S5); a row that cannot be answered says `unmeasured: <reason>`, never empty, and a git call that fails is such a row, not a zero (git grep's exit 1 is "no match" only with nothing on stderr). Input paths may be absolute; they are read relative to the repository. References come from `git grep --no-color` (from the index in a sparse checkout). S3 lists the tests next to a file (named after it or importing it) and the tests elsewhere (`x.test.js`, or under a top-level `test/` directory) whose import statement names it by a relative path; an alias there may be another package's file. `formatImpactTable(table, config) → markdown`.
- `metrics/szz.mjs` — `reworkRate({ cwd, since, until, days, config, now? }) → { commits, reworked, rate, fixCommits, censored, pairs[] }`. Commits whose window has not closed by `now` are censored, not counted as clean. The log is read with `-z` (a quote or tab in a file name survives), bodies only for fix commits; blame ignores `blame.ignoreRevsFile` lists (a list naming a missing file stops git blame, and the command fails with git's error); in a shallow clone the commits at the edge (git's `shallow` file) are no line's origin; a move subject is matched as written and lowered by the commit language's rules, so `İçe aktar…` meets a lower-case pattern; write `moveSubject` in lower case. Checked against the origin project's Python measurement on the same range: September 46/306 vs 46/317, October 30/135 vs 33/141 (the denominators differ in documentation commits and author vs committer time).
- `metrics/gate-log.mjs` — `recordAttempt({ cwd, config, start, end?, exit, kind?, commit?, step?, runner? }) → { path, entry }` appends one JSON line to `<stateDir>/gate-attempts.jsonl` (files from the commit when it passed, from the index when it failed; exit 0 without a commit is a failure; contradictory input throws `RangeError` and writes nothing). `readAttempts(path) → { exists, attempts, skipped }` (no log is reported as such, not as zero attempts; unreadable lines are counted). `summarizeAttempts(attempts, { since?, until? })` → counts, failure rate, nearest-rank median / p90 for passing and failed attempts, time spent in failed attempts, failing steps and how many failures did not name one. Only attempts that go through the wrapper are recorded.
- `metrics/bypass.mjs` — `bypassUses({ cwd, config, since?, until?, from? }) → { commits, uses: [{ hash, time, subject, reason }] }`. Shares `allowMarkerReason` and `skippedSubject` with `checks/commit-shape.mjs`, so a use is what the hook let through; reads only the messages that hold the marker (`git log -F --grep`, NUL-separated). `from` is a revision (`<from>..HEAD`); an empty one is an error, a mistyped one a git error.
- `metrics/mutation.mjs` — `parseMutants(json) → { mutants, problems }` (a list of `{ id, file, old, new }`, every problem at once; a lone surrogate in `old` or `new` is one); `runMutants({ cwd, mutants, command, check?, journal, timeoutMs? }) → { restored, baseline, timeoutMs, results: [{ id, file, outcome, checked, reason? }] }`. The command runs first with no mutant and must exit 0, else no mutant runs; a `timeoutMs` under 1.5× that run is refused. Per mutant: `old` must occur once (overlapping occurrences count) in a UTF-8 file inside the repository (symlinks resolved), else `unapplied`; the file is checked to parse, a mutant that does not is `invalid`: JavaScript with `node --input-type=<goal> --check` on its source, the goal from the extension, else the nearest package.json `type`, else CommonJS when the original parses as such; JSON with `JSON.parse`; any other file with `check` (`{file}` replaced by the quoted path), which never replaces the built-in two. A check that fails on the original, or gives no answer (past the time limit, did not start), does not apply. Then the command: exit 0 `survived`; past the timeout (default 3× the baseline, at least +30 s, at most setTimeout's 2^31−1 ms) and again past twice that, `timeout`; else `killed`; with no check that applied, a failure or a hang is `unchecked` and a pass is `survived` with `checked: false`. A command that cannot start ends the pass (`MutationError`). It runs in its own process group, killed whole after every run, at the timeout and on SIGINT/SIGTERM/SIGHUP; the file is written back on every way out (an `exit` handler too) and each write moves its mtime to a newer whole second (caches keyed by mtime and size, Python's bytecode). `journalPath(cwd, stateDir)` is per working tree (outside a repository: a per-user directory under the temporary one); it holds the run's pid and the applied mutant's original bytes; the next run restores a file that still holds the mutant, refuses one that changed since, and refuses while the pid lives, pointing at `restoreJournal(cwd, path, { force })` (`ennyn mutate --restore --force`; without force it refuses a live pid too). The first stamp is newer than the file's mtime before the run. `summarizeMutants(results) → { killed, total, timeout, survived, invalid, unapplied, unchecked, uncheckedSurvived }`: killed (timeouts included) / total over checked mutants only.
- `metrics/convergence.mjs` — `parseConvergence(handoffText, config) → { realEscape, fixIntroduced, preExisting, gateCaught, perRound }`.
- `plan/mechanization.mjs` — `loadGraph({ cwd, config }) → { open, done }`; `readyNodes(graph, config) → node[]` (not done, gate open, every `needs` id done; best value/cost first), `readyMechanization` (the flagged ones); `pickMechanization({ open, done }, config) → node | null` (the best ready flagged node; ties by id). A node that is not an object, or a module graph that fails to load, is a `GraphError`. Projects that block nodes in more ways than one gate field (the origin project has four) select in their own planner and use this only for scoring.
- `setup/scan.mjs` — `scanProject({ cwd, env }) → { repository, config, metrics, graph, handoff, fixSubject, commitStyle, churn, tests, risky, roadmap, github, pathScopedRules, agentSetup, commands, mutation }`. Read-only; a config that does not load or a path pattern that does not compile is listed in `config.problems` and the default is used; `config.loaded` is false when the config did not load, so no value in the scan is the project's. The fix label is chosen from the last 300 commits that touch a production path (the rework rate's denominator): every pattern anchored at the subject start that matches, minus those another one covers (the more specific one on equal sets), joined into one alternation, so `fix(ui):` and `düzeltme:` are both counted; more than half matching → `majority` (the rework rate would count churn); only mentions inside subjects → `weak`, nothing proposed. `risky` lists the top-most directory named like auth, migrations, payments, ledger…, or the file itself in a flat layout; `roadmap` includes a roadmap split into a `roadmap/` directory. `agentSetup` lists what the project already has: every instruction and rule file once, with its size, when it loads (`always`, `on-demand` by path, `other` agents; a file imported with `@path`, up to five hops and inside the repository, loads like its importer) and the lines that set a commit rule (`size` sums them per kind), skills and agents (read from disk, symlinks followed), commands, hook events from settings.json and settings.local.json, MCP servers, files that are not valid JSON (`unreadable`), and the overlaps with Ennyn by name: cycle-like skills or commands and reviewer agents. `churn` lists paths rewritten in at least a quarter of recent commits (min. 10) that the rework rate still counts, with a generated-file marker when the file has one and the exact `excludeRe` alternative for it; paths are read with `-z`, so quotes and tabs in names survive.
- `core/style.mjs` — `styleRules(style, lang) → string | null` (`null` for `normal`). `adapters/claude-code/hooks/conversation-style.mjs` (SessionStart, `startup|resume|clear|compact`) prints it as `additionalContext`; no config, a config that does not load, or `normal` → nothing; exit 0 on every path.
- `setup/hook.mjs` — `installHook({ cwd, cliPath }) → { result: installed | updated | unchanged | wired | other | hooksPath, path, hooksPath }` writes a commit-msg hook that runs this machine's CLI (`commit-check "$1"`) into the repository's own hooks directory (`git rev-parse --git-path hooks`, shared by linked worktrees). It leaves a hook that already runs commit-check alone (`wired`, including husky's `.husky/commit-msg` behind its `.husky/_` stubs), writes nothing when `core.hooksPath` is set (`hooksKind`: `repo`, `husky` or `global`, compared as real paths), never overwrites another hook (`other`), and prints the shell-quoted line to add. The hook runs `commit-check --hook`: a config that does not load, a moved CLI or a missing node lets the commit through with a warning. cherry-pick, revert and autosquash folds run no commit-msg hook, so `amend!` and `squash!` text is checked when those commits are made. `hookStatus(cwd)` reads the state; `doctor` warns when `commitMsg.types` is set and no hook runs commit-check.
- `setup/budget.mjs` — `instructionBudget(cwd, files) → { always, onDemand, listings, files, untracked, repeated: [{ line, files, everySession }], repeatedLines, repeatedEverySession }`. Tracked files only (an untracked CLAUDE.local.md or rule is this machine's and is listed in `untracked`). `always` holds the every-session instruction and rule files, what they import, and the name and description of every skill, agent and command (`listings`, YAML block descriptions included); `onDemand` the path-scoped ones. A repeat is a rule line in two or more loaded files (compared without list markers, numbering, quotes, pipes, emphasis or case; headings, code blocks and lines under 40 characters are not rules); `everySession` when a copy loads every session. `recordBudget` writes one record per commit to `paths.metricsLog` (full hash; recording again at that commit replaces the record), `previousBudget` is the newest record made at another commit, `readBudgets` counts lines that do not parse. `doctor` warns when the every-session bytes grew since the last record.
- `setup/doctor.mjs` — `checkSetup({ cwd, env }) → { ok, items: [{ level: ok | warn | fail, key, vars }], language }`: config loads, its patterns and globs compile, the `review.cochange` globs name tracked files, the graph loads with unique ids and known `needs`, something is ready, and the fix label is neither absent nor a majority. Message keys, rendered by the CLI.

## Phases

- **v0.1** — core modules + Claude Code plugin; `/ennyn:init` (survey, at most six questions, config, starting graph from a roadmap file, issues or the user's words, `metrics.fixSubject` from the project's history).
- **v0.2** — Codex manifest; `claude plugin eval` suites; the loop measured on a second project.
- **v1.0** — stable config, official directory submission.
