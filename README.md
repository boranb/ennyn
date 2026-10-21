# Ennyn

**English** · [Türkçe](README.tr.md)

*Ennyn* (pronounced *EN-nin*) is Sindarin for "gates": the Doors of Durin in Tolkien's *The Lord of the Rings*, which open only to the right word. Ennyn turns each recurring lesson into a gate your code has to pass.

A development loop for coding agents that measures itself. Each cycle takes four tasks from the project's work graph: two core tasks, one task that turns a recurring defect class into a gate, and one audit of a finished feature. It ends by counting where the defects came from.

> Status: pre-release (0.0.x). Extracted from a production codebase where the loop ran for nearly 700 sessions; the numbers below come from that project.

## Why

We measured 21 cycles (539 review findings, 398 product defects) of the origin project. Three results shaped this package:

- **Fixing review findings was the main source of new defects.** Fixes introduced more product defects (99) than first drafts missed (80). Of the serious findings in the second and later review rounds, 66% were side effects of the previous round's fix. Third and later rounds found a new defect class only twice.
- **Most risky questions were already known but not answered before the code was written.** Review prompts asked them, and the author answered them only after review. Two independent raters judged nearly all new serious defects at least partly answerable before writing.
- **Lessons written as prose did not stop recurrence; lessons turned into gates did.** A class with a gate stayed at zero for 11 cycles. A class with only a written rule came back in 13 of 14 cycles. Proposals that became work-graph nodes got done 8 times out of 11; proposals without a node got done 0 times out of 5.

Numbers, limits and the published research they were checked against: [docs/evidence.md](docs/evidence.md).

## What it does

| Step | What the loop does | Tooling |
|---|---|---|
| Setup | Reads the repository first: how fixes are labelled, which files most commits rewrite (generated output), the test layout, risky paths, roadmap files and issues. Then it asks at most six questions and writes the config, a starting work graph and a handoff stub; `ennyn doctor` checks them. | `/ennyn:init`, `ennyn init-scan`, `ennyn doctor` |
| Before writing | Five-row impact table, each row answered by a command: who else reads this decision · other paths to this state · newly accepted/rejected inputs · behaviour at the ceiling or when measurement fails · where the fakes come from. For heuristic rules, an accept + reject corpus and a failing test come first. | `ennyn impact` |
| Mutation pass | Hand-picked mutants of the changed lines run against the fast tests one at a time, after the tests pass with none. A mutant that does not parse is invalid, never killed; each file is put back byte for byte, also after an interrupted run. Every survivor gets a test or a reason. | `ennyn mutate` |
| Review | At most two rounds; round two looks only at the diff of round-one fixes. A third round needs an independent signal (test, mutation run, real measurement). Every finding carries a quote, class, source, confidence and how it was checked. | `agents/`, `skills/cycle/finding-schema.md` |
| Commit | Short subject and body; review rounds and impact summary as structured lines. A commit-msg hook checks every message, before the expensive hook runs. | `ennyn commit-check`, `ennyn install-hook` |
| Gate attempts | The commit wrapper records every gate attempt (duration, result, files, failing step when known) in machine-local state; a summary gives the wait, the failure rate and the time spent in failed attempts. Recording never changes the commit's exit code. | `ennyn gate-record`, `ennyn gate-stats` |
| Voice | The conversation can be `focused` (result or next action first, numbered steps) or `terse` (answer first, short sentences); the rules reach each session at start. Commits can be `terse`: subject and structured lines, no prose. Numbers, paths, commands, negations and money or data-loss warnings are never shortened. | `conversation.style`, `commitMsg.style` |
| Side copies | A worktree or plain copy of the project gets the path-scoped rules the main tree would load. | Claude Code hook |
| End of cycle | Convergence in four numbers: real escapes, fix-introduced, pre-existing, gate-caught. The most recurring class becomes a work-graph node flagged `mechanization: true`. One lesson file is pruned. Uses of the commit-shape bypass are counted, and the instruction text loaded in every session is measured; it should only shrink. Push approval is asked, with the unpushed count. | `ennyn mechanization`, `ennyn push-check`, `ennyn rework`, `ennyn bypass`, `ennyn budget` |

`ennyn rework` measures how many commits had lines changed by a fix within N days (an SZZ variant). On the origin project it matched an independent Python implementation: September 46/306 vs 46/317, October 30/135 vs 33/141. The rate is only as good as the project's fix label: when most commits are labelled fix it counts churn, not defect rework, and the tool says so. Set `metrics.fixSubject` to match real repairs; see [docs/evidence.md](docs/evidence.md#speed-and-rework).

## Install (Claude Code)

```sh
claude plugin marketplace add boranb/ennyn
claude plugin install ennyn@ennyn
```

Then, in the project: `/ennyn:init`.

Before the repository is public, install from a local clone: `claude plugin marketplace add ./ennyn`.

Other agents that read [Agent Skills](https://agentskills.io) can use `skills/cycle/` directly. The CLI needs Node 20 or later and has no dependencies: `node scripts/ennyn.mjs --help`.

## Configure

One file per project, `.ennyn/config.json`, written by `/ennyn:init`. Override only what differs from the defaults. Unknown keys and type mismatches are reported together, so a typo cannot silently disable a check.

```json
{
  "language": "en",
  "paths": { "graph": ".ennyn/graph.json" },
  "commitMsg": { "types": ["feat", "fix", "docs", "test", "refactor", "chore"], "fixType": "fix" },
  "review": { "impactRequiredGlobs": ["src/auth/**", "migrations/**"] },
  "impact": { "twins": [["src/lib/engine", "server/src/lib"]] }
}
```

The full table of keys is in [DESIGN.md](DESIGN.md). Reports and the conversation follow `language` (`en` or `tr`); commit text follows `commitMsg.language`, which can differ (Turkish conversation, English commits). `commitMsg.types` sets the subject types `commit-check` enforces, and `commitMsg.fixType` is the one type for repairs of earlier commits, so the rework rate counts repairs, not churn. Both are chosen at `/ennyn:init` and replace any commit rule in the project's own instructions.

The work graph is a JSON file (or an ES module) with two arrays, open and done nodes. Field names are configurable, so an existing graph can be used as it is.

## Status and roadmap

- **0.1**: core modules, Claude Code plugin and `/ennyn:init`: a survey and a short interview that write the config and a starting graph (from a roadmap file, issues or the user's words), with a `metrics.fixSubject` that fits the project's own history.
- **0.2**: a Codex manifest, `claude plugin eval` cases that compare the loop with and without the plugin, and the loop measured on a second project.
- **1.0**: stable config schema.

## License

MIT. See [LICENSE](LICENSE).

## Name

The code is MIT-licensed; the name has its own short policy in [TRADEMARK.md](TRADEMARK.md). *Ennyn* is a word from J.R.R. Tolkien's invented languages. This project is not affiliated with, sponsored or endorsed by the Tolkien Estate, Middle-earth Enterprises or any of their licensees.
