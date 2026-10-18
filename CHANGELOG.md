# Changelog

## Unreleased (0.0.x)

- `TRADEMARK.md`: how the name may be used (the code is MIT).
- Core: config loader (all problems reported at once), glob matcher, git helpers that never inherit a hook's repository environment, message catalogs (`en`, `tr`).
- `commit-check`: subject and body limits, structured lines, review-round rule, impact line for guarded paths. It measures the message git will store: `-m` / `-F` keep `#` lines and a scissors line, the editor drops them; a hook's temporary index is read for partial commits.
- Claude Code: side-copy rule bridge (PostToolUse) that inlines as many matching rules as fit and lists the rest; SessionStart reset after compaction or `/clear`.
- `impact`: five-row impact table, each row answered by a command or marked unmeasured.
- `rework`: SZZ strong-link rework rate (owned lines and share, sweep fixes and move commits skipped, open windows censored).
- `mechanization`, `push-check`, convergence parser and formatter.
- `gate-record` / `gate-stats`: one line per commit-gate attempt in machine-local state (duration, result, files, failing step when the wrapper knows it); the summary separates "nothing recorded" from "no attempts" and counts failures without a named step as unmeasured. The origin project had to scrape its gate cost from agent transcripts, where 16% of attempts had no readable outcome.
- Method: cycle skill, finding schema, impact table guide, report formats, three reviewer agents.
