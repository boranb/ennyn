---
name: init
description: Set up Ennyn in a project. Survey the repository, ask only what it cannot answer, then write .ennyn/config.json, a small starting work graph and a handoff stub, and check them. Use when a project has no .ennyn/ yet, or when asked to "set up ennyn", "init ennyn" or "bootstrap the work graph".
---

# Init: config and a starting graph from the repository

The helper is `node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs"`, written `ennyn` below. Every proposal comes from a command's output. The user is asked only what the repository cannot answer.

## 1. Survey (no questions yet)

Run `ennyn init-scan --json`. If `config.path` or `graph.exists` is set, this is an **update**: keep what is there, change only what the user agrees to, and never overwrite the graph. Add or adjust nodes instead. If `config.loaded` is false, every value in the scan is a default, not the project's: fix the listed `config.problems` in the config file, then run the scan again before going on.

## 2. Ask once

Send one message with at most six questions. Each question carries the survey's answer as the default, so "ok" accepts all of them. Skip a question when the survey has nothing for it.

1. **Languages and voice** (`en` | `tr`):
   - `language`: reports and the conversation during a cycle. Default: the language the user writes in.
   - `commitMsg.language`: commit text. Default: `commitStyle.language.guess`, the language the history is written in; `language` when there is no guess.
   - `conversation.style`: `normal`; `focused` (result or next action first, numbered steps, one next step, no preamble); `terse` (answer first, short sentences, no filler). Default `normal`. A hook gives each session the rules; numbers, paths, commands, negations and money or data-loss warnings are never shortened.
   - `commitMsg.style`: `normal`, or `terse` (subject + structured lines, no prose body). Default `normal`.
2. **Commit convention.** It decides how every cycle commit is written and what the rework rate counts as a repair. Show `commitStyle.types` and the fix-label result (`fixSubject`: share and up to three examples), then offer:
   - the history's own types, when it has a convention (`commitStyle.typedShare` ≥ 0.5); ask which one marks a repair;
   - otherwise, by commit language: `en` → `feat, fix, docs, test, refactor, chore` with `fix`; `tr` → the same English types with Turkish text, or Turkish types `özellik, düzeltme, belge, test, düzenleme, bakım` with `düzeltme`;
   - or a free subject: `types` stays empty.
   The fix type is only for repairs of earlier commits. Then the rework rate measures rework, not churn. A `majority` result means the history's rate is a trend only; the convention fixes that from now on.
3. **Generated files and test layout.** From `churn.paths`, ask which are build output; a `generatedMarker` is a strong hint, not proof. Confirmed paths go into `metrics.excludeRe`. When `tests.proposal` is set, show its example files and ask whether they are tests; a production file that matches would leave the rework rate.
4. **Risky paths** (`risky`). These paths require an impact table before any edit. The user adds or removes.
5. **Where the work comes from**:
   - the `roadmap` files (with open/done counts);
   - open GitHub issues (`gh issue list --state open --limit 50 --json number,title,labels`, only when `github` is set and `gh` works);
   - or the user's own words: "What should this project do next? Which finished features matter most?"
6. **What the project already has** (`agentSetup.overlaps`), only when it lists something. A cycle-like skill or command (`overlaps.cycle`): does Ennyn's cycle replace it, or stay beside it for other work? The answer goes into the handoff: in the stub, or, when the handoff exists, as one line added at its end on the user's yes. Reviewer agents (`overlaps.reviewers`): which of them review the cycle's changes (`review.agents`, given the finding schema); none keeps Ennyn's three.

Nothing else is asked; everything else keeps its default.

## 3. Write `.ennyn/config.json`

Write only the keys that differ from the defaults (DESIGN.md has the table). JSON-escape regex values.

- `commitMsg.language`: only when it differs from `language`. `conversation.style` and `commitMsg.style`: only when not `normal`.
- `commitMsg.types` and `commitMsg.fixType`: the agreed convention. The fix type must be one of the types.
- `metrics.fixSubject`: covers the history and the new fix type, `(?:<fixSubject.proposal>)|(?:^<fixType>(\(|:))`, or `^<fixType>(\(|:)` when there is no proposal. Omit it when it equals the default. `doctor` warns when it misses the fix type.
- `metrics.excludeRe`: the scan's `metrics.excludeRe`, then `|` and the `excludePattern` of each confirmed churn path. Always start from the scan's value: a bare path pattern replaces the default and puts docs, lockfiles and `dist/` back into the rework rate.
- `metrics.testRe`: `tests.proposal`, when the user confirmed it.
- `review.impactRequiredGlobs`: the agreed globs. `review.agents`: the reviewers chosen in question 6.
- `sideCopy.roots`: only when `pathScopedRules > 0` and the user keeps plain copies outside git worktrees. Ask where.

## 4. Build the starting graph

Follow [graph.md](graph.md): where the graph goes, a module when the roadmap is already kept in files, node shape, value and cost, done nodes and gates.

## 5. The project's own instructions

The cycle follows Ennyn's convention. When an instruction or rule file sets another commit format or language (`commitLines` of `agentSetup.instructions`; every-session files first, then on-demand ones, then those of other agents; for example "one-line commits"), show each such line and propose replacing it with one that points at `.ennyn/config.json`. Edit it only on the user's yes, so the agent never gets two rules.

## 6. Handoff stub

Write this only when `handoff.exists` is false. An existing handoff gets nothing but the one line from question 6, and only on the user's yes. Write it to `paths.handoff`:

- the commands the cycle runs: the fast test command from `commands`, then lint and typecheck when present;
- the mutation tool from `mutation`, or "none configured: the mutation pass reports not applicable";
- where the graph is;
- "Next: run the cycle skill".

## 7. Check and report

Run `ennyn doctor` and fix every ✗. A `!` stays only when the user has seen and accepted it, for example the fix-label majority.

Report in at most twelve lines:

- files written;
- the fix-label decision, with its share;
- the languages, the voice and the commit convention;
- what was changed in the project's own instructions, or left in conflict and why; an audit queue the project already keeps;
- node counts: open, done and ready;
- the instruction text the project loads: `agentSetup.size.always` in every session, `size.onDemand` by path;
- what was estimated or left at its default;
- "Next: /ennyn:cycle".

Ask before committing the files, and never push.
