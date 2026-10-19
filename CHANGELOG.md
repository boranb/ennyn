# Changelog

## Unreleased (0.0.x)

- `TRADEMARK.md`: how the name may be used (the code is MIT).
- Core: config loader (all problems reported at once), glob matcher, git helpers that never inherit a hook's repository environment, message catalogs (`en`, `tr`).
- `commit-check`: subject and body limits, structured lines, review-round rule, impact line for guarded paths. It measures the message git will store: `-m` / `-F` keep `#` lines and a scissors line, the editor drops them; a hook's temporary index is read for partial commits.
- Claude Code: side-copy rule bridge (PostToolUse) that inlines as many matching rules as fit and lists the rest; SessionStart reset after compaction or `/clear`.
- `impact`: five-row impact table, each row answered by a command or marked unmeasured.
- `rework`: SZZ strong-link rework rate (owned lines and share, sweep fixes and move commits skipped, open windows censored).
- `mechanization`, `push-check`, convergence parser and formatter.
- `bypass`: commits that used the commit-shape bypass marker, with their reasons, counted as the hook decides (reverts and merges are not uses); `--from <rev>` counts one cycle. Only messages holding the marker are read.
- `gate-record` / `gate-stats`: one line per commit-gate attempt in machine-local state (duration, result, files, failing step when the wrapper knows it); the summary separates "nothing recorded" from "no attempts" and counts failures without a named step as unmeasured. The origin project had to scrape its gate cost from agent transcripts, where 16% of attempts had no readable outcome.
- Method: cycle skill, finding schema, impact table guide, report formats, three reviewer agents. Their front matter is checked by a test as a YAML parser reads it (a ": " in the security reviewer's description had dropped its name and description at load).
- `/ennyn:init` (`skills/init/`): surveys the repository, asks at most six questions, writes `.ennyn/config.json`, a starting work graph and a handoff stub, then runs `doctor`. A roadmap the project already keeps in files is read by a small graph module, not copied.
- `init-scan`: fix label from the last 300 subjects (only a label at the subject start is proposed; a majority or mere mentions are flagged), paths most commits rewrite, test layouts the default `testRe` misses, risky directories, roadmap files and roadmap directories, GitHub remote, test commands (including a `scripts/validate.sh`-style gate script) and the mutation tool.
- `init-scan` reports the project's own agent setup: instruction files with size and their commit-rule lines, rules, skills, agents, commands, hooks, MCP servers, and which of them overlap with Ennyn (a cycle-like skill, reviewer agents); `/ennyn:init` asks how the cycle sits next to them; the reviewers it picks go into the new `review.agents`, which the cycle's review step reads.
- `install-hook`: commit-check as the repository's commit-msg hook (machine-local; never over another hook, never into a tracked `core.hooksPath`); `/ennyn:init` offers it, `doctor` warns when declared commit types have no hook. Ennyn's own commit rule moved from prose into this gate.
- `commit-check` skips `fixup!` subjects (autosquash folds them away whole) and checks what `amend!` and `squash!` carry into history; it reads git's comment marker (`core.commentChar` / `core.commentString`), leaves an empty message to git and accepts any spacing after the type's colon. A test keeps `|` escaped in documentation tables.
- `doctor`: config loads, patterns compile, graph ids are unique and `needs` exist, something is ready, the fix label separates repairs.
- Commit convention: `commitMsg.language` (commit text, can differ from `language`), `commitMsg.types` (enforced by `commit-check`) and `commitMsg.fixType` (the one type for repairs). `/ennyn:init` offers them from the history's language and types and replaces a conflicting commit rule in the project's instructions on the user's yes; `doctor` warns when `metrics.fixSubject` misses the fix type.
- Voice: `conversation.style` (`normal`, `focused`, `terse`; rules in `styles/`, injected by a SessionStart hook in the config language) and `commitMsg.style` (`terse`: no prose body). Numbers, paths, commands, negations and money or data-loss warnings are never shortened; the conversation style never touches files or commits.
- A config whose root is not an object, a graph node that is not an object and a module graph that fails to load are reported as config or graph errors.
