# Related work

This page looks at the open-source tools people use most to make coding agents faster and more careful, as they stood in October 2026: Claude Code plugins and skill packs, spec-driven workflows, agent harnesses, tools that check AI-written code, and tools that fetch web pages or map a codebase for an agent. For each one it records how it works, what Ennyn took from it, and what Ennyn left out and why.

Star counts and dates are from 2026-10-27, from 2026-10-28 for the scraping and code-graph tools, and from 2026-11-14 for the tools added on 2026-11-15. These projects change every week, so read the tables as a snapshot. The studies Ennyn's design rests on are in [evidence.md](evidence.md); newer ones found in this pass are listed at the end and move there once each is read in full.

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
| [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) (7.9k on 2026-11-13) | One skill whose description tells the agent to run its CLI first on every web task. The CLI searches 209 guides offline and prints the one asked for. A scan finds dated patterns for about a fifth of the guides, and each finding carries the rule for dropping it. Guides for unstable browser features are found by search but printed only after an opt-in in a committed file. The CLI is fetched at its latest version on every call and reports the agent's search queries to its vendor unless switched off. The install repository is a publish target: source, tests and evals live in a second one. | Each task run with and without the skill on full applications by three agents; Playwright graders that must pass on a reference solution and fail on the untouched application; dated results per agent and model |
| agent-skills (117k on 2026-11-14) | 25 skills for specifying, building, verifying and shipping. An optional hook pair, not registered by the plugin, answers the agent's web fetches from cached copies in a folder of the project. | Three tiers of evals. `claude plugin eval` cases come in pairs: one where a skill must fire and one where it must stay quiet, with the model pinned and the Claude Code version recorded. A run counts as finished only on a successful final result with no permission denial and a result for every tool call. Dated fire rates per description change, including a router change that dropped one skill from 6 of 6 to 1 of 12 with no change to the skill |
| skills (324k on 2026-11-14) | 39 skills a developer uses daily. A `SCOPE.md` bar: an idea stays open only if it describes a failure seen in a real session and matches nothing already rejected. Each rejection is a file in `.out-of-scope/` with a lasting reason and a list of the later requests that matched it; one of them lists five requests about skill names that clash with a host's built-in commands. | None found |

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
| [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (15.6k on 2026-11-09) | One agent holds the context and drafts a design document; fresh subagents read only the document and the files it links, through five review stages with a human gate after each. Reviewers rate findings Blocker, Major or Nit; the author marks each one fix, contest (with evidence the reviewer could read), escalate or decline. A loop converges after two clean rounds and stops at five. A reviewer that fails twice is recorded as not run, never as zero findings. A comprehension reviewer first paraphrases the document; a section it cannot paraphrase is a blocker. A drift report compares design documents with the code by hand. | Unit tests of manifests, frontmatter and links; a live probe that reviewers run isolated; a review benchmark file with no runner |
| planning-with-files (28.1k on 2026-11-14) | Three planning files on disk (plan, findings, progress) and a hook that puts the plan back in front of the agent on every turn. | A recovery eval: a session is cut halfway, a fresh one gets only "Continue the work in this directory.", and the arms are graded on turns to completion, beside a baseline with no planning files. Its eval notes also record a test that reimplemented a fix without loading the shipped script and stayed green while Windows was broken |

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

### Scraping and code-graph tools

Ennyn fetches no web pages, so these were read for other things: how they reach agents, how they are tested and released, and what went wrong in them. Each was read at the commit named in the sources.

| Project | How it works | What it publishes as evidence |
|---|---|---|
| [ScrapeGraphAI](https://github.com/ScrapeGraphAI/Scrapegraph-ai) (32k) | A Python library. A page is fetched with Playwright or requests and split into chunks; a model fills a schema from each chunk, and another model call merges the answers. Telemetry is on by default; for a URL run given a schema it posts the prompt, the schema, the page content, the model's answer and the URL, and the README calls it anonymous usage metrics. One node runs model-written code with `exec` and the full builtins. | None found for extraction quality |
| agent-reach (105k) | A Python CLI, and a skill it links into the skill folders of several agents. Web pages go through `r.jina.ai`, YouTube through yt-dlp, GitHub through `gh`, and X and Reddit through a browser profile that is given that site's cookies from the user's own Chrome. | A release record per action, tied to a digest of the source, with each waiver's reason |
| Scrapling (90k) | A Python scraping library with an MCP server and a skill. Its HTTP client copies a browser's TLS fingerprint; its stealth browser can click Cloudflare's Turnstile box when asked, and always opens contexts with HTTPS errors ignored. After a site changes, a saved element is found again by scoring every element against a stored fingerprint. | Parser speed benchmarks; the text-extraction one parses 5,000 nested empty divs, a page with no text |
| [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (89k) | A Claude Code plugin that builds a knowledge graph of a codebase. Imports are resolved with tree-sitter; summaries and cross-file call edges are written by model agents, and only the import edges the merge script adds back are marked as such. The merge script says about a quarter of the import edges the agents are asked to copy never arrive, lost in batch construction and by the agents. A hook, switched on by a file committed in the repository, tells the agent to update the graph without asking. | Speed and memory of the deterministic scan; no measured token cost and no outcome eval |
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) (147k on 2026-11-14) | A Python CLI (tree-sitter, networkx) that builds a code graph and answers queries from it. Its always-on rule tells the agent to query the graph before its first grep or file read on a codebase question, to put that rule in every subagent prompt that explores code, and not to flag the graph's rewrite in a pull request. Its `affected` command once answered a path it could not match with an empty list and exit 0; it now anchors paths, and exits 3 for an ambiguous name and 4 for no match. | On code, key-fact coverage of 82.0% against 70.8% for grep and read, on 6 questions about one repository |

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
| A size ceiling per host for skill files | A report that Codex loads only the first 8,000 bytes of a SKILL.md, since checked in Codex's code: both of Ennyn's skills lose their last lines, which ask before a push or a commit | `codex-skill-bytes` |
| A quote is checked against a saved raw copy of its source, never against a model's summary of the page | ScrapeGraphAI's check for expected words in fetched text, agent-reach's refusal of challenge pages, Scrapling's relocation by similarity | `source-quote-check` |
| A test that the code's network use matches what the README and SECURITY.md say | ScrapeGraphAI, whose README calls telemetry that sends page content "anonymous usage metrics" | `network-claim-test` |
| Untrusted event fields in a workflow's run lines under any trigger; container images and installs in CI and in skills pinned | Scrapling, ScrapeGraphAI, Understand-Anything | `ci-more-sinks`, `ci-container-pins`, `ci-install-pins` |
| Hook text that tells the agent not to ask, and a committed file that turns such a hook on | Understand-Anything | `agent-setup-risk` |
| A warning on obfuscated lines in files that tools run when they load them | Understand-Anything, after a pull request that hid a payload in a build config | `load-time-obfuscation` |
| A node id never leaves the work graph unannounced | Understand-Anything's check for items lost in a model's rewrite | `graph-id-kept` |
| Every config key is read by code and set by a test | ScrapeGraphAI's documented options that do not work | `config-keys-read-tested` |
| Reviewers called by their registered agent type, with the file path as fallback | Understand-Anything issue #464 (a fix proposed in open PR #504) | `reviewer-agent-names` |
| Tests that keep copies of instruction text in step | ScrapeGraphAI's prompt copies, Understand-Anything's contract tests | `instruction-copies-sync` |
| A report the program renders and the agent shows unchanged | agent-reach | `findings-ledger` |
| A removed config key names the key that replaces it | Scrapling | `config-tombstones` |
| Uninstall removes only files a ledger says Ennyn wrote | agent-reach | `uninstall-path` |
| The impact table's search for nearby tests reads the project's test pattern, which init already sets for other languages | Understand-Anything | `impact-test-conventions` |
| A task agent restates the brief in its own words before it writes; a restatement that misses the ask is a finding against the brief | elephant-goldfish-model's comprehension reviewer | `brief-paraphrase` |
| A reviewer that fails or returns nothing is retried once, then recorded as not run, and its round is not clean | elephant-goldfish-model's review loop | `reviewer-not-run` |
| A rule whose eval cases all pass without the plugin is a candidate for deletion | modern-web-guidance, which prunes the advice models already follow unaided | `skill-eval-baseline` |
| An eval case's prompt never names the rule it tests; a must-not check passes only when every trial does; a case no arm ever passes is read as broken first | modern-web-guidance's task prompts; Anthropic's guide to agent evals | `plugin-eval` |
| A dated idiom or a deprecated call on changed lines is found by the ecosystem's own tool, which init proposes | Go's `go fix` modernizers, written after assistants kept producing older Go; modern-web-guidance's scan | `modern-idiom-check` |
| A hot path is timed before and after a change on one machine in one run, and no performance finding is raised anywhere else | Uber's uReview, where low-impact performance comments were rated poorly; an audit of three performance benchmarks | `perf-before-after` |
| A symbol the repository does not hold is reported as not found, never as a measured zero | graphify's `affected`, after an empty answer to a path it could not match | `impact-symbol-not-found` |
| An eval cell counts only on a successful final result with no permission denial; a check that only sees whether the skill ran stays out of the score; a placebo arm | agent-skills; Agent-Skills-for-Context-Engineering | `plugin-eval` |
| A description change is measured on pairs of prompts where the skill must fire and must stay quiet | agent-skills | `skill-descriptions-when-only` |
| A later proposal that matches a declined node joins it as a prior request, and a declined node keeps a lasting reason | skills' `.out-of-scope/` | `graph-triage` |
| A cycle cut mid-task is continued by a fresh session told only to continue, graded on turns to the next landing | planning-with-files' recovery eval | `eval-first-cases` |
| A resumed run trusts a step only when its file is there: a review round's result, a landed commit on the base branch | Auto-claude-code-research-in-sleep, which resumes at the first phase not accepted rather than the first not done | `journal-result-files` |
| One table of exit codes for every command, with its own code for a check that could not judge | text-to-cad's `NOT CHECKED`, exit 3 | `cli-bug-exit` |
| Bait seeds for reviewers: a defect older than the diff, a claim a caller's guard refutes, a comment telling the reviewer what to report; one finding with a flat and a confident fix report must end alike | agent-skills' review fixtures; academic-research-skills' persuasion pairs | `reviewer-seeded-recall` |
| An added suppression comment (`@ts-ignore`, `eslint-disable`, `noqa`) is read as weakening a test | agent-skills | `test-weakening-warn` |
| Setup proposes Read rules for more secret stores: `~/.config/gh`, `~/.npmrc`, `~/.netrc`, browser profiles | last30days-skill, which reads cookies from the user's browsers | `secret-read-deny-more` |
| Every step number, graph id and config key named in the skills resolves, and a skill is named with its plugin prefix | humanizer's and hallmark's reference checks | `instruction-copies-sync` |

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
- Any of the scraping and code-graph tools as a dependency, an MCP server or a recommended install. Each brings a Python or pnpm stack whose setup installs packages from the network, three of them a browser too. Scrapling's MCP server returns page text with no length limit and can send POST requests to any address; ScrapeGraphAI sends page content to its vendor by default on URL runs given a schema.
- Getting past bot checks (copied TLS fingerprints, clicked CAPTCHAs, browsers with certificate checks off) and reusing the user's browser cookies (agent-reach). For a page that blocks a plain client, an archive snapshot or the user's own browser is enough for research.
- A code graph whose edges come from model agents (Understand-Anything). With no source on an edge, an import the parser resolved and one an agent wrote look the same; Ennyn's impact table answers from git grep and the tests.
- A release run on every push to main (ScrapeGraphAI's semantic-release). The commit type picks the version bump, which would bend how commits are typed and so what `ennyn rework` counts.
- Many agent hosts at once (Understand-Anything, agent-reach). Each host's folders move under the tool; Ennyn adds Codex next and nothing more.
- A scan for high-entropy strings. Minified code and lock-file hashes look the same, and a changed spacing gets past it; `load-time-obfuscation` looks only at files that tools run when they load them.
- Five review stages with a human gate after each, convergence after two clean rounds, and two copies of the same reviewer for recall (elephant-goldfish-model). Ennyn's cycle runs without a person between tasks and stops at two rounds; whether a second copy of a reviewer finds more is what `reviewer-seeded-recall` would measure, and its contest step is `finding-refuter`. Its drift report is a periodic read by a model; Ennyn's co-change rule refuses the commit instead.
- A guide corpus behind a skill, a CLI fetched at its latest version on every call, and usage reports to the vendor (modern-web-guidance). Ennyn ships no knowledge of one platform, pins what it fetches and connects nowhere. What must always happen in Ennyn is a hook or a command, not a skill's description: Vercel measured a skill that was never invoked in 56% of its eval cases. A web project can install modern-web-guidance itself. Its manifests for eight agent hosts are left out as Understand-Anything's were.
- From the 2026-11-15 pass (each read at the commit in the sources): a code graph as a dependency (graphify), for the reasons given for Understand-Anything; a learned-rule command beside init (career-ops), a second road beside the ledger and the class registry; review receipts that hash each file a reviewer read (Claude-Code-Game-Studios), until `audit-coverage-ledger` shows a need; a debug tag the commit hook refuses, since `review.forbidden` already does it and no leak was seen here. Design skills (impeccable) are outside Ennyn's scope; its README says its hooks run outside the model's approval and that its apply step can start an agent with permission checks off.

## Security reports read

- Plugin4Shell (Air Security, September 2026): a branch named like a 40-character commit hash defeats commit pinning of plugins in four coding agents, and Claude Code and Codex auto-update plugins by default. Secondary sources report it fixed in Claude Code 2.1.179; Claude Code's changelog does not mention it. `agent-setup-risk` already checks for that version.
- SafeDep (May 2026): five typosquatted npm packages run a binary on install and ship a `.claude/settings.json` whose SessionStart hook runs it again; a copy of that file in the project stays after the package is removed.
- PromptArmor: a malicious marketplace plugin rewrites `settings.local.json` to allow `curl`, approves its own curl calls from a PreToolUse hook and hides the hook from the transcript, and a plugin command sends code to the attacker.
- Snyk ToxicSkills (February 2026): of 3,984 skills on two public skill registries, 36.8% had a flaw and 76 were confirmed malicious. Claude Code marketplaces were not in the sample.
- ScrapeGraphAI's telemetry, from its repository history: on by default since June 2024. In July 2024 its payload took the URL, the prompt, the schema and the model's answer (listed on its docs page), then the page content (never listed), in commits titled as docs and fix changes. The README's telemetry section, added in September 2024, calls it anonymous usage metrics. The environment variable that turns it off did nothing from v1.65.0 until v2.2.4 (September 2026), although a review bot flagged the break on the pull request that caused it.
- Understand-Anything issue #432: a pull request titled after a real issue (#188) appended a self-decoding payload to a build config (homepage/astro.config.mjs); a comment names two more with the same change, and the maintainer says the payload never reached the repository.
- book-to-skill's security notice (2026-08-17): a re-upload under another account turned off TLS certificate checks, sent host and repository details to an outside endpoint, read the storage of cryptocurrency wallet extensions, uploaded the collected data on macOS, and shipped a Windows executable its CLI could start. `release-0-1-0` already asks for the one source to install Ennyn from.

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
- Found on 2026-11-13, each read in part and checked against a saved copy of the page:
  - Anthropic, "Demystifying evals for AI agents" (9 January 2026): pass^k is the chance that all k trials succeed; a 0% pass rate over many trials is most often a broken task; one-sided evals create one-sided optimization.
  - Vercel, "AGENTS.md outperforms skills in our agent evals" (27 January 2026): 53% with no docs, 53% with a skill (never invoked in 56% of cases), 79% with a skill and explicit instructions, 100% with an 8 KB index in AGENTS.md; one framework, the vendor's own tasks.
  - The Go blog, "Using go fix to modernize Go code" (17 February 2026): assistants wrote Go in the style of their training data and often would not use newer ways when told to in general terms, so the modernizers were written as analyzers.
  - Spotify, background coding agents, part 3 (9 December 2025): the agent does not know what a verifier does, verifiers return only the relevant error lines, and a judge model vetoes about a quarter of sessions, most often for work outside the prompt; the judge itself has no evals.
  - Anthropic, "Building a C compiler with a team of parallel Claudes" (5 February 2026): a test harness that prints a few lines and logs the rest, and a fast mode that runs a fixed random sample per agent.
  - Mozilla, "Behind the Scenes Hardening Firefox with Claude Mythos Preview" (7 May 2026): a finding counts when the harness builds a test case that reproduces it; earlier static reads by a model had too many false positives to scale.
  - Uber, uReview (12 August 2025): comment categories with low developer value are suppressed, low-impact performance comments among them.
  - "Are Performance-Optimization Benchmarks Reliably Measuring Coding Agents?" (arXiv 2607.01211, abstract only): reference patches kept the benchmarks' validity rules in every cross-machine replay for 39 of 102, 11 of 140 and 411 of 498 tasks.

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
- ScrapeGraphAI at 194055e: https://github.com/ScrapeGraphAI/Scrapegraph-ai/tree/194055e
- agent-reach, read at commit 14c2134
- Scrapling, read at commit 0336400
- Understand-Anything at 4e6d329: https://github.com/Egonex-AI/Understand-Anything/tree/4e6d329
- Codex skill loading at e6de6a2423: https://github.com/openai/codex/tree/e6de6a2423/codex-rs/ext/skills/src
- modern-web-guidance at 4dd9683: https://github.com/GoogleChrome/modern-web-guidance/tree/4dd9683
- Anthropic, agent evals: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Vercel: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
- Go blog: https://go.dev/blog/gofix
- agent-skills, read at commit 39b723c
- skills, read at commit 5863806
- planning-with-files, read at commit 51bf62d
- graphify at d4a5b32: https://github.com/Graphify-Labs/graphify/tree/d4a5b32
- Auto-claude-code-research-in-sleep, read at commit 9f30e83
- text-to-cad, read at commit 337ac4e
- academic-research-skills, read at commit 23bd688 (CC BY-NC 4.0, ideas only)
- Agent-Skills-for-Context-Engineering, read at commit 9ff0c99
- humanizer, read at commit b48c832
- hallmark, read at commit 04977e1
- last30days-skill, read at commit 5718ae7
- book-to-skill, read at commit e7bb659
- Spotify: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- Anthropic, C compiler: https://www.anthropic.com/engineering/building-c-compiler
- Mozilla: https://hacks.mozilla.org/2026/05/behind-the-scenes-hardening-firefox/
- Uber: https://www.uber.com/blog/ureview/
- Performance benchmarks: https://arxiv.org/abs/2607.01211
