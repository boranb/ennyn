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
schema/config.schema.json           config schema
test/                               node:test suites
docs/                               method guide, evidence, adoption guide
```

## Project config

One file per project: `.ennyn/config.json` (override with `ENNYN_CONFIG`). Unknown keys are errors. Every field has an English default; a project overrides only what differs.

| Key | Default | Meaning |
|---|---|---|
| `language` | `"en"` | language of messages and generated reports (`en`, `tr`) |
| `paths.handoff` | `"HANDOFF.md"` | cycle handoff document |
| `paths.changelog` | `"CHANGELOG.md"` | |
| `paths.graph` | `".ennyn/graph.json"` | work graph (JSON, or a `.mjs` module exporting arrays) |
| `paths.metricsLog` | `".ennyn/metrics.jsonl"` | per-cycle metrics |
| `paths.stateDir` | `".git/ennyn"` | machine-local state (never committed): side-copy injection lists, `gate-attempts.jsonl`; a `.git/…` value resolves through the common git dir, so linked worktrees share it |
| `graph.exports` | `{ "open": "nodes", "done": "done" }` | export names when the graph is a module |
| `graph.fields` | `{ "id": "id", "status": "status", "needs": "needs", "gate": "gate", "value": "value", "cost": "cost", "cluster": "cluster", "mechanization": "mechanization", "source": "source" }` | field names in the graph |
| `graph.openGateValue` | `null` | value of `gate` meaning "no gate" |
| `graph.doneStatus` | `"done"` | |
| `graph.valueScale` | `{ "high": 3, "medium": 2, "low": 1 }` | categorical value → weight (numbers are used as-is) |
| `graph.costScale` | `{ "S": 1, "M": 2, "L": 3, "XL": 5 }` | categorical cost → weight |
| `planner.mechanizationSlots` | `1` | |
| `commitMsg.subjectMax` | `120` | |
| `commitMsg.bodyMaxLines` | `8` | structured lines and trailers excluded |
| `commitMsg.bodyMaxChars` | `800` | |
| `commitMsg.structuredLines` | `["Root cause:", "Prevention added:", "Node:", "Mutation:"]` | prefixes not counted toward the body limit |
| `commitMsg.structuredLineMax` | `300` | |
| `commitMsg.skipSubjects` | `["^Merge ", "^Revert "]` | regexes |
| `commitMsg.allowMarker` | `"[commit-shape-allow:"` | bypass marker; must carry a reason |
| `review.maxRounds` | `2` | |
| `review.roundsLine` | `"Review-Rounds:"` | body line carrying the round count |
| `review.thirdRoundLine` | `"Third-round:"` | required when rounds > max |
| `review.impactLine` | `"Impact:"` | body line carrying the impact summary |
| `review.impactRequiredGlobs` | `[]` | staged paths that require an impact line |
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
| `metrics.fixSubject` | `"^fix(\\(|:)"` | a fix commit; if most commits match, the rate leans toward churn (the CLI says so) |
| `metrics.excludeRe` | docs, `.md`, dot-paths, `generated/` `dist/` `build/` `vendor/`, lockfiles | paths excluded from rework attribution; generated output rewritten by ordinary commits measures churn |
| `metrics.testRe` | `.test.` `.spec.` `/test/` `/__tests__/` `/__fixtures__/` | |
| `metrics.minLines` / `minShare` | `3` / `0.1` | strong link: the origin owns at least this many meaningful deleted lines and this share of the fix's deleted lines (or the fix message names its hash) |
| `metrics.maxFixFiles` | `15` | a fix touching more production files is a sweep and names no origin |
| `metrics.moveSubject` | refactor / rename / move / split / extract / codemod / reformat | origins whose subject says they moved code are skipped |

## Module contracts

All modules are ES modules, zero dependencies, JSDoc-typed, pure where possible. Functions that touch git or the file system take an explicit `cwd`.

- `core/config.mjs` — `loadConfig({ cwd, env }) → config` (defaults deep-merged; throws `ConfigError` listing every unknown key and every type mismatch).
- `core/glob.mjs` — `globToRegExp(pattern) → RegExp`, `matchAny(path, patterns) → boolean`. Supports `**`, `*`, `?`, `{a,b}`, `[...]`. Paths use `/`.
- `core/git.mjs` — `git(args, { cwd }) → string` via `execFileSync`, with `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_PREFIX` removed from the environment; `stagedPaths(cwd, { env? })` (with a hook's environment it reads the index the hook was given, e.g. the temporary index of `git commit -- <path>`, but only when that index belongs to the same repository), `unpushedCount` (returns `null` when there is no upstream), `parseTrailers`, `commonDir`, `resolveStateDir`.
- `core/i18n.mjs` — `t(key, vars, lang)`; missing key in `lang` falls back to `en`; a test asserts every `en` key exists in every catalog.
- `checks/commit-shape.mjs` — `checkCommitShape(message, { config, stagedPaths, cleanup }) → { ok, errors[] }`. It measures the message git will store: `cleanup` is git's mode (`"whitespace"` when the hook sees `GIT_EDITOR=":"`, i.e. `-m` / `-F`, where `#` lines are kept and counted; `"strip"` for the editor). Paths matching `review.impactIgnoreGlobs` (tests, fixtures) never require the impact line.
- `side-copy/map-path.mjs` — `mapSideCopyPath(absPath, { projectDir, roots }) → { root, relPath } | null` (git worktree: same `--git-common-dir`; plain copy: a root under `sideCopy.roots` whose `package.json` `name` equals the project's).
- `adapters/claude-code/rules-index.mjs` — `loadPathScopedRules(projectDir) → [{ file, patterns[] }]` from `.claude/rules/**/*.md` front matter `paths:`.
- `adapters/claude-code/hooks/side-copy-rules.mjs` — PostToolUse hook: for Read/Edit/Write on a side-copy path, emits the matching rules as `hookSpecificOutput.additionalContext`, once per rule per session; exits 0 on every path (never 2; 1 only when it cannot run). `side-copy-reset.mjs` (SessionStart, `compact|clear`) forgets the session's injected list so the rules come back after the context is compacted.
- `impact/table.mjs` — `buildImpactTable({ cwd, config, symbol?, files? }) → { rows }` (five rows, S1-S5); a row that cannot be answered says `unmeasured: <reason>`, never empty. `formatImpactTable(table, config) → markdown`.
- `metrics/szz.mjs` — `reworkRate({ cwd, since, until, days, config, now? }) → { commits, reworked, rate, fixCommits, censored, pairs[] }`. Commits whose window has not closed by `now` are censored, not counted as clean. Checked against the origin project's Python measurement on the same range: September 46/306 vs 46/317, October 30/135 vs 33/141 (the denominators differ in documentation commits and author vs committer time).
- `metrics/gate-log.mjs` — `recordAttempt({ cwd, config, start, end?, exit, kind?, commit?, step?, runner? }) → { path, entry }` appends one JSON line to `<stateDir>/gate-attempts.jsonl` (files from the commit when it passed, from the index when it failed; exit 0 without a commit is a failure; contradictory input throws `RangeError` and writes nothing). `readAttempts(path) → { exists, attempts, skipped }` (no log is reported as such, not as zero attempts; unreadable lines are counted). `summarizeAttempts(attempts, { since?, until? })` → counts, failure rate, nearest-rank median / p90 for passing and failed attempts, time spent in failed attempts, failing steps and how many failures did not name one. Only attempts that go through the wrapper are recorded.
- `metrics/convergence.mjs` — `parseConvergence(handoffText, config) → { realEscape, fixIntroduced, preExisting, gateCaught, perRound }`.
- `plan/mechanization.mjs` — `loadGraph({ cwd, config }) → { open, done }`; `readyNodes(graph, config) → node[]` (not done, gate open, every `needs` id done; best value/cost first), `readyMechanization` (the flagged ones); `pickMechanization({ open, done }, config) → node | null` (the best ready flagged node; ties by id). A node that is not an object, or a module graph that fails to load, is a `GraphError`. Projects that block nodes in more ways than one gate field (the origin project has four) select in their own planner and use this only for scoring.
- `setup/scan.mjs` — `scanProject({ cwd, env }) → { repository, config, metrics, graph, handoff, fixSubject, churn, tests, risky, roadmap, github, pathScopedRules, commands, mutation }`. Read-only; a config that does not load or a path pattern that does not compile is listed in `config.problems` and the default is used; `config.loaded` is false when the config did not load, so no value in the scan is the project's. The fix label is chosen from the last 300 commits that touch a production path (the rework rate's denominator): the conventional pattern when most subjects are conventional, otherwise the pattern anchored at the subject start that matches the most subjects (the more specific one on a tie); more than half matching → `majority` (the rework rate would count churn); only mentions inside subjects → `weak`, nothing proposed. `churn` lists paths rewritten in at least a quarter of recent commits (min. 10) that the rework rate still counts, with a generated-file marker when the file has one and the exact `excludeRe` alternative for it; paths are read with `-z`, so quotes and tabs in names survive.
- `setup/doctor.mjs` — `checkSetup({ cwd, env }) → { ok, items: [{ level: ok | warn | fail, key, vars }], language }`: config loads, its patterns compile, the graph loads with unique ids and known `needs`, something is ready, and the fix label is neither absent nor a majority. Message keys, rendered by the CLI.

## Phases

- **v0.1** — core modules + Claude Code plugin; `/ennyn:init` (survey, at most five questions, config, starting graph from a roadmap file, issues or the user's words, `metrics.fixSubject` from the project's history).
- **v0.2** — Codex manifest; `claude plugin eval` suites; the loop measured on a second project.
- **v1.0** — stable config, official directory submission.
