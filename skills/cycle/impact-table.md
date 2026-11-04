# Impact table — before writing, by command

**Why:** in the origin project, almost every new serious defect could at least partly have been asked about before writing (two independent raters agreed), and the reviewers' prompts already contained the question in 57% of reviews — the author asked the reviewer instead of answering it. Generic checklists do not help (Porter, Votta & Basili 1995); scenario questions aimed at specific defect classes do. A model's own impact guess is weak (Stengg et al. 2025): answer every row with a command.

## When

Required (any one): the function, predicate, gate or accept/reject rule you change is read in two or more places · a client/server twin or copy exists · the work touches identity, sessions, permissions, data correctness or parsing of external input · you add a ceiling, quota or limit.

Skip when the diff can be told in one sentence and is local (text, style, a single-caller helper); write `Impact: not needed — <reason>`.

## The five rows

| # | Question | How to answer |
|---|---|---|
| S1 | Who else reads or decides this? | reference search (`impact.referenceCommand` or `git grep -w`), configured twins, co-change history; next to each reader write the **question it asks** — two different questions mean two predicates |
| S2 | Which other paths reach this state? | count the input shapes (spelling × mode × what the other system returns), not code branches; every entry point (route, job, import, CLI) |
| S3 | What is newly accepted or rejected? | count the accepted set before and after on a corpus; **which of the newly accepted are wrong?** |
| S4 | What happens at the ceiling, or when measurement fails? | ceiling registry; `catch` branches and empty returns in the target; is "could not measure" treated as "clean"? |
| S5 | Where do the fakes come from? | the real producer (driver, server response, recorded model output); a fake with no recorded source is listed as such |

A row that cannot be answered says `unmeasured: <reason>`; an empty row is never "clean".

## The smallest-change row

Every core task answers it before its first edit, also when the five rows are skipped, in the file its impact table goes to. One line per new piece (a file, function, option, command or dependency), its cells in this order:

| Piece | Asked by | Already here | Done by | New code |
|---|---|---|---|---|
| its name | the line of the task (its node, its brief or a protocol step) that asks for it, quoted | `git grep -w` of its names and verbs, and what that found | the platform, git or an installed dependency, by running it (`--help`, a probe) with its version; or none | only what the three cells before it leave |

A piece no line asks for is left out and named in one line, `Left out: <piece>, …`; a change that adds no piece writes `No new piece`. **Never cut**, even when no line asks for it: validation of anything read from outside the process (stdin, files, arguments, pasted data), data-loss handling, security, accessibility, anything the task asks for.

A never-cut piece no line asks for still gets its line, with `never cut: <kind>` in its Asked by cell.

Before the commit, set the row against the full diff (`git diff --merge-base <base branch>` for tracked files, `git status --short --untracked-files=all` for new ones): a piece added while writing, a function or option in a file the row already names too, gets its line, and a piece the `Left out` line names is either out of the diff or moved from that line into the row with the line that asks for it.

**Why:** an agent skill that asks this before writing (ponytail, MIT) cut delivered code by 30% on the 18 of its author's 38 tasks whose code was run, with the hidden checks' pass rate flat (87/90 against 86/90); the other 20 were judged by a model only. An independent run of an older version wrote 53% fewer statements, and its robustness fell from 96.7 to 82.5 on stdin scripts whose task did not mention bad input: hence the never-cut list.

## Heuristic rules, dictionaries, thresholds

1. Corpus first, with expected answers, containing both **accept** and **reject** cases (over-restrictive rules are written three times as often as over-permissive ones — Wang et al., MSR 2020).
2. A failing test on the current code.
3. The rule, bound to structure (position, affix, boundary, type, numeric range); a word list may only decide in the safe direction.
4. Keep the corpus and its test in the repository; later versions are measured against it.

## A fix is a write

When a review finding is fixed, check whether the fix changes a row; if it does, update the table and pass the delta to round two. (In the origin project, 66% of serious findings in round two and later were side effects of the previous round's fix.)
