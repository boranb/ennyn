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

## Heuristic rules, dictionaries, thresholds

1. Corpus first, with expected answers, containing both **accept** and **reject** cases (over-restrictive rules are written three times as often as over-permissive ones — Wang et al., MSR 2020).
2. A failing test on the current code.
3. The rule, bound to structure (position, affix, boundary, type, numeric range); a word list may only decide in the safe direction.
4. Keep the corpus and its test in the repository; later versions are measured against it.

## A fix is a write

When a review finding is fixed, check whether the fix changes a row; if it does, update the table and pass the delta to round two. (In the origin project, 66% of serious findings in round two and later were side effects of the previous round's fix.)
