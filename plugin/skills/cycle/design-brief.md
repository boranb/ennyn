# Design brief — UI work, before code

**Scope:** a core task that creates a user-visible surface or changes the layout or flow of one. Fixes that do not change the look, copy changes and server work skip it.

Unwritten intent cannot be reviewed: without the brief, a UI reviewer can only check generic rules, not "what was this surface trying to be?".

Five lines under the task in the cycle plan:

| Line | Content |
|---|---|
| **Context** | who, doing what, at what moment · which product solves this job and how (one name + behavior) |
| **Direction** | how this surface differs from its neighbor in *job*, and how that reads visually (uniformity ≠ consistency) |
| **Components** | reused ones, read from the code · new ones and why the existing ones are not enough |
| **Behavior** | empty / loading / error / unauthorized · narrow-screen layout · keyboard flow (Tab order, Escape) |
| **Constraints** | limits specific to this surface · **deviation from the design system:** `none` or `yes → reason` |

**Done when** every line is filled or says `none (why)`, and every component name in "Components" is found in the code by search.

The brief is read in three places: the UI reviewer's prompt (it opens its report with a brief ↔ result table), the end-of-task report, and the header comment of the surface's root file (decision-bearing lines only — conversations rotate, comments stay).
