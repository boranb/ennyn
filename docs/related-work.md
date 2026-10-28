# Related work

This page looks at the open-source tools people use most to make coding agents faster and more careful, as they stood in October 2026: Claude Code plugins and skill packs, spec-driven workflows, agent harnesses, and tools that check AI-written code. For each one it records how it works, what Ennyn took from it, and what Ennyn left out and why.

Star counts and dates are from 2026-10-27. These projects change every week, so read the tables as a snapshot. The studies Ennyn's design rests on are in [evidence.md](evidence.md); newer ones found in this pass are listed at the end and move there once each is read in full.

## Where Ennyn sits

Most of these tools work through instructions. A skill or a command tells the agent what to do, and the agent decides whether it did it. Few publish a comparison of outcomes with and without the tool.

Ennyn starts from the other end. A lesson that keeps coming back becomes a check that runs without the model (a commit hook, a test, a CLI gate), and each cycle counts what every layer caught and what got through. The closest tools in spirit are Compound Engineering, whose loop also feeds each lesson into the next piece of work and which tests skill changes against a baseline, and tdd-guard, which enforces test-first from a hook rather than from a skill's text.

## The tools

### Claude Code plugins and skill packs

| Project | How it works | What it publishes as evidence |
|---|---|---|
| superpowers (307k) | Skills for brainstorming, plans, subagent-driven development, TDD and debugging. A SessionStart hook loads the skill that tells the agent to use the others. Fixes go through a review loop of up to five rounds. | Small hand-scored skill tests run with fresh subagents, and a separate eval lab that grades real sessions with a model and fixed checks |
| [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) (26k) | Brainstorm, plan, work, simplify, review, compound: each piece of work should make the next one easier. Serious review findings go to a validator agent that marks each one confirmed, rejected or unresolved. | Skill evals that run a change against a baseline git ref in fresh sessions; dated eval reports |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) (45k), the plugins that used to live in anthropics/claude-code | code-review runs parallel review agents, then a subagent checks each issue; only checked issues are kept, and posted to the PR with `--comment`. hookify runs regex rules from hooks that warn or block. security-guidance warns on patterns in edits and runs model reviews at the end of a turn and on commit. ralph-loop is a Stop hook that feeds the prompt back until a completion phrase or an iteration cap. | None found |
| gstack (138k) | Hooks that keep edits inside one directory (`/freeze`), ask before destructive commands and refuse the worst few (`/careful`), a second opinion from another vendor's model, a dry run of a paid eval on a free stub first. | Skill evals in CI judged by a model, with dated reports |
| [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core) (11k; the original get-shit-done, 64k, is archived) | A fresh subagent for each step, a `STATE.md` file, and enforcement hooks that each declare whether they let the action through or stop it when they crash. | None found |
| tdd-guard (2.4k), continued as probity | A PreToolUse hook asks a model to judge each write against the latest test results and blocks code with no failing test behind it. Its docs list the ways around it: writing files through Bash and editing the guard's own state. | A demo |
| agents (42k), [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework) (24k), ECC (291k) | Large catalogs of agents, skills and commands. | Structural validation; speed and token savings claimed |

### Spec and planning workflows

| Project | How it works | What it publishes as evidence |
|---|---|---|
| [github/spec-kit](https://github.com/github/spec-kit) (143k) | Commands for a constitution, specify, clarify, plan, tasks, analyze, checklist, implement and converge. The checks (analyze, checklists, counting unchecked checklist items, converge) are done by the agent from the command's text. | None found |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) (73k) | A change is a set of added, modified, removed and renamed requirements, merged into the specs when it is archived. A validator in code rejects a requirement with no scenario and duplicate requirements. | None found |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) (55k) | Agent personas and story files. Its code review gives the author's commit messages to one reviewer only, after that reviewer has traced the code. A separate, optional runner, [bmad-loop](https://github.com/bmad-code-org/bmad-loop), decides a story is done from checks on disk, and its deferred-work file takes `gate:` lines that block the stories they name. | None found |
| claude-task-master (28k, last commit April 2026) | A task graph with dependencies. The next task and dependency cycles are found in code; a model scores each task's complexity. | None found |
| [automazeio/ccpm](https://github.com/automazeio/ccpm) (8.4k) | PRD, epic and task files kept in sync with GitHub Issues, and parallel agents in worktrees. | A with-and-without eval of whether the agent followed the steps; the harness is not published |
| [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) (13k) | Research, plan, implement, with the context compacted in between ([advanced-context-engineering-for-coding-agents](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents)). Since October 2026 the repository carries hook scripts, not registered in its checked-in settings: checks before the agent stops, and a refusal of test, typecheck or lint output piped to `head`, `grep`, `tail` and similar tools. | Case studies |
| [Kiro](https://kiro.dev) (AWS) | Steering files loaded always, by file match, by hand, or when the request matches their description; requirements written in EARS form; property tests generated from those requirements. | Vendor posts |

### Agent harnesses and parallel runners

| Project | How it works | What it publishes as evidence |
|---|---|---|
| [Aider](https://github.com/Aider-AI/aider) (50k) | A tree-sitter map of the repository; lint after each edit, and tests when configured, with an error shown inside its enclosing function; an architect model plans and an editor model writes. | Its own editing benchmark |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) (21k), [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (8.9k) | In the interface from the paper (still shipped as the 0.7 configs), an edit that fails a lint check is rejected, files are shown 100 lines at a time and old observations are dropped. mini-swe-agent's agent class is about 100 lines, and it uses bash only. | Ablations in the SWE-agent paper |
| [OpenHands](https://github.com/OpenHands/OpenHands) (92k) | Critic models that score agent output, trained on production traces with rubric labels, with code survival and PR merge as outcome signals. | Self-reported results |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) (28k), [claude-squad](https://github.com/smtg-ai/claude-squad) (8.7k), [container-use](https://github.com/dagger/container-use) (4.1k) | Parallel agents, each in its own worktree, branch or container. vibe-kanban's README says it is being sunset. | None found |
| [Serena](https://github.com/oraios/serena) (31k), [Context7](https://github.com/upstash/context7) (64k) | Language-server tools for the agent; library documentation fetched into the context. | None found |

### Checking AI-written code

| Project | How it works |
|---|---|
| [PR-Agent](https://github.com/The-PR-Agent/pr-agent) (14k) | The model scores its own review suggestions 0-10 and a threshold filters them. |
| [qodo-cover](https://github.com/qodo-ai/qodo-cover) (5.7k) | Generates tests and keeps those that raise coverage. No longer maintained since June 2025. |
| [Stryker](https://github.com/stryker-mutator/stryker-js) (3.3k), mutmut (1.5k) | Mutation testing. Stryker keeps a mutant disabled by a comment in the report, with its reason; mutmut can drop mutants that fail the type checker. |
| [ast-grep](https://github.com/ast-grep/ast-grep) (16k) | Structural search and lint rules, with an official skill for agents. |

## What Ennyn took

Each idea became a node in the work graph (`.ennyn/graph.json`), or an addition to one that was already there. None is built yet.

| Idea | Seen in | Node |
|---|---|---|
| A round-one fix stays in the lines its finding names, and each fix's size is recorded | Imbue's study of review-fix passes | `fix-scope` |
| A fix counts as covered only by a test that fails on the code before the fix | superpowers, where it is asked in prose | `fix-test-red-first` |
| A refuter never takes "could not disprove it" as confirmation | Compound Engineering's validator | `finding-refuter` |
| Deferred findings become nodes, with gate lines on the work they block | bmad-loop's deferred-work file | `finding-triage` |
| Skill changes run against a baseline in evals; the order of the protocol's steps is graded with free graders | Compound Engineering; `claude plugin eval` | `skill-eval-baseline`, `eval-first-cases` |
| Every hook declares what it does when it crashes | GSD Core | `hook-crash-policy` |
| A new rule can start as a warning; waivers end | hookify, Factory's linter guide | `rule-warn-then-block` |
| A fast check on each edited file, returning only the failing lines | SWE-agent, Aider | `edit-time-check` |
| Only the tests the impact table reaches run during a task; the full suite runs at commit | the Ralph post | `impact-scoped-tests` |
| On a new model, one cycle step is switched off for a cycle and the numbers compared | Anthropic's harness posts, Agent OS | `step-drop-trial` |
| Survivor reasons that recur become skip rules for mutants | Google's mutation testing | `mutant-skip-rules` |
| Mutants written from the risks the impact table names; a cheap token check before "equivalent" is accepted | Meta's ACH | `risk-row-mutants` |
| Test output piped to `head`, `grep` or `tail` is refused | HumanLayer | `test-output-cut` |
| A reviewer arm that sees the diff without the author's commit messages, and a faster model for mechanical agents | BMAD, Aider's architect and editor split | `reviewer-model-diversity` |
| A commit that adds a hook, an allow rule or an MCP server to the agent's settings is named | SafeDep's report on npm packages | `claude-config-in-diff` |
| A test that Ennyn's own hooks never grant permissions or hide themselves from the transcript | PromptArmor's plugin demo | `own-hooks-no-permissions` |
| Branch and tag names of 40 or 64 hex characters refused in the repository's rules | Plugin4Shell | `account-hardening` |
| The handoff records the commit it was written at | Cline's memory bank, whose files go stale | `cycle-journal` |
| A size ceiling per host for skill files | A report that Codex loads only the first 8,000 bytes of a SKILL.md (not yet checked) | `codex-skill-bytes` |

## What Ennyn left out

- Constitutions, EARS requirements and persona prompts (spec-kit, Kiro, BMAD). Apart from Kiro's property tests, no code checks them, and they can grow fast: one review saw Kiro turn a small bug into four user stories with sixteen acceptance criteria.
- Finding quotas, such as a review lens that must find at least ten issues (BMAD). BMAD reports that its A/B pilots found the quota raised the hit rate on remaining bugs; Ennyn has not measured it. In the origin project fixes were the largest source of new defects, so Ennyn does not ask for more findings.
- Filtering review suggestions by a score the same model gives them (PR-Agent). The number is the model's own claim about its suggestion, and nothing outside the model checks it.
- Open-ended loops and long review chains (ralph-loop, superpowers' five rounds). Ennyn stops at two review rounds because the third rarely found anything new.
- Large catalogs of agents and skills. Each description is text loaded into every session, and Ennyn's instruction budget should only shrink.
- Serena and Context7. One brings Python and language servers as runtime dependencies; the other fetches third-party text into the context over the network.
- GitHub Issues as the source of truth (ccpm). It needs a network and an account, and Ennyn's graph is a local file.
- Complexity scores from a model (Task Master), best-of-n sampling and trained critics (OpenHands). A model's complexity score is an estimate nothing checks, and the other two multiply the cost of every task.
- Installing Python packages or an SDK when a session starts (security-guidance), and installers that fetch the latest version unpinned (gstack, GSD Core). Ennyn has no runtime dependencies and pins what it fetches.
- Coverage as the bar for generated tests (qodo-cover). Meta's ACH work found that 277 of the 571 tests it generated would have been thrown away under a line-coverage criterion.

## Security reports read

- Plugin4Shell (Air Security, September 2026): a branch named like a 40-character commit hash defeats commit pinning of plugins in four coding agents, and Claude Code and Codex auto-update plugins by default. Secondary sources report it fixed in Claude Code 2.1.179; Claude Code's changelog does not mention it. `agent-setup-risk` already checks for that version.
- SafeDep (May 2026): five typosquatted npm packages run a binary on install and ship a `.claude/settings.json` whose SessionStart hook runs it again; a copy of that file in the project stays after the package is removed.
- PromptArmor: a malicious marketplace plugin rewrites `settings.local.json` to allow `curl`, approves its own curl calls from a PreToolUse hook and hides the hook from the transcript, and a plugin command sends code to the attacker.
- Snyk ToxicSkills (February 2026): of 3,984 skills on two public skill registries, 36.8% had a flaw and 76 were confirmed malicious. Claude Code marketplaces were not in the sample.

## Studies found in this pass

Imbue's study was read in full. The others were read through summaries or in part and are not yet in [evidence.md](evidence.md).

- Imbue, "How AI code review can make correct code worse" (2026-04-29). On SWE-bench Pro, one implement-review-fix pass did not move the mean score significantly. One of 15 tasks that were already solved got worse. A Sonnet fixer given the full review changed 46 lines on average and 343 at most, against 19 and 160 when it saw a summary. Letting the fixer skip findings it could not fix safely removed the worst regressions. The regression result rests on 15 tasks and the line counts on 16.
- SWE-agent (Yang et al., arXiv 2405.15793): 18.0% on SWE-bench Lite with lint-guarded edits and 15.0% without.
- METR (2025-08), 18 issues, one model: agent PRs passed the maintainers' tests on 38% (±19) of attempts, and none of the 15 that were reviewed could be merged as they were.
- CodeRabbit review comments in the field (arXiv 2607.03316): of 31,073 comments on 10,191 PRs in 239 repositories, 36.4% were accepted and 56.3% rejected.
- Meta's ACH (arXiv 2501.12862): mutants generated from a stated concern, then tests that kill them; ACH generated 571 tests, and engineers accepted 73% of the 191 they reviewed. Later Meta work (arXiv 2601.22832) writes tests per diff to catch a wrong change.
- Agent PRs and defects (arXiv 2607.21832) used PyDriller's SZZ, which an earlier study put at a precision of 0.39; the authors could not measure it on their own data. That limit belongs next to Ennyn's rework rate.
- OpenAI, "A practical approach to verifying code at scale" (December 2025): a code reviewer tuned for precision over recall.
- Cross-context review (arXiv 2603.12123, a single-author preprint): a review in a fresh session scored about the same as one in the author's session, and a repeated review lower.
- Anthropic, agentic property-based testing (arXiv 2510.09907).
- "Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl" (15 October 2025).
- A benchmark by a software agency (Uvik), 50 tickets, one team, one model: merge rates of 80-84% with a spec tool and 72% without, with gains on medium and large tickets. The authors put the noise at ±10 points, about the size of the gaps.

## Sources

- Imbue: https://imbue.com/blog/2026-04-29-how-ai-code-review-can-make-correct-code-worse
- SWE-agent: https://arxiv.org/abs/2405.15793
- METR: https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons
- Review comments: https://arxiv.org/abs/2607.03316
- ACH: https://arxiv.org/abs/2501.12862 · tests per diff: https://arxiv.org/abs/2601.22832
- Agent PRs and SZZ: https://arxiv.org/abs/2607.21832
- OpenAI: https://alignment.openai.com/scaling-code-verification/
- Cross-context review: https://arxiv.org/abs/2603.12123
- Property-based testing: https://www.anthropic.com/research/property-based-testing
- Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl (October 2025)
- Uvik: https://uvik.net/blog/spec-driven-development-benchmark/
- Factory, linters for agents: https://factory.com/using-linters-to-direct-agents
- Ralph: a blog post on agent loops (July 2025)
- Anthropic, harness design: https://www.anthropic.com/engineering/harness-design-long-running-apps
- Plugin4Shell: https://labs.cloudsecurityalliance.org/research/csa-research-note-plugin4shell-ai-coding-agent-supply-chain/
- SafeDep: https://safedep.io/malicious-npm-packages-claude-code-hooks/
- PromptArmor: https://promptarmor.com/resources/hijacking-claude-code-via-injected-marketplace-plugins
- Snyk ToxicSkills: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
- Claude Code plugin evals: https://code.claude.com/docs/en/plugin-evals
