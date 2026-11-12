# Building the starting graph

Write the graph to the scan's `graph.path`, as a JSON object with two arrays named by `graph.exports`. With the defaults that is `.ennyn/graph.json` holding `{ "nodes": [...], "done": [...] }`.

- **Already kept in files?** When the project keeps its roadmap in files with a fixed line format (checkbox lines with ids, hours and dependencies; a generated status table), do not copy it: a copy goes stale the day the roadmap changes. Write a small `.mjs` module next to the config that reads those files on every load and exports the two arrays, set `paths.graph` to it, and gate the items the roadmap itself postpones, citing where it says so. Give every node it makes, done ones too, a `source` of `<file>:<line>`: doctor names it when an item is wrong.
- **5 to 15 open nodes** when the work comes from the user's words or a loose list. Each is a complete, independently verifiable piece of user-visible value. A refactor counts only when it unblocks one.
  Shape: `{ "id": "short-kebab-id", "title": "…", "status": "planned", "value": "high|medium|low", "cost": "S|M|L|XL", "cluster": "<area>", "needs": [], "source": "…" }`.
- **From a roadmap file or issues:** one node per item that meets the bar. Merge duplicates. `source` points back to the item, for example `ROADMAP.md:12` or `#42`. Items too vague to verify go into one node per area, titled "Define: …", with value `medium`.
- **value / cost:** estimate them from the item and say so in the report. The user corrects them later.
- **Age:** one core slot takes the oldest node of the highest value. A node's age is its `since` when the graph dates its nodes (a number, smaller is older: a cycle, or a date as `Date.getTime()`), else its place in the list: a new node goes at the end. A module whose roadmap does not list the oldest item first gives every node a `since` from the roadmap. When the graph already uses `since` for something else, rename the field (`graph.fields.since`).
- **A new project's graph** (new-project.md): the first node is the thinnest end-to-end path, with a test. Later nodes are vertical slices; there is no layer-only node and no final test node. The project's "done" line is its fast test, lint and typecheck exiting 0, and one assertion broken on purpose making the test command fail.
- **needs:** set only when a node truly cannot start before another one.
- **done:** finished features worth re-checking, as `{ "id", "title", "status": "done" }`. The cycle's legacy audit picks from these.
- **declined:** none at the start. A node the user refuses later moves to a third array (`graph.exports.declined`) as `{ "id", "title", "reason", "since" }`, the one decisive reason in `reason`: never picked, and no open node may need it.
- **mechanization: true:** only for a defect class that the user or the history names as recurring. Otherwise there are none; the first cycle's convergence report creates them.
- **gate:** for an item the user must start (a release, work in another project's own session), so the cycle does not pick it alone.

## When doctor fails on the items

A ✗ about the items (no id, an id twice, a need no item has, needs that wait on each other) names each item's `source`. In a JSON graph you wrote, fix it. In a module that reads the project's roadmap, the cause is usually that roadmap: show the user the lines doctor names, and change them, or the module, only on their yes. Two marks point at the module instead: a place named twice (`ROADMAP.md:7 ×2`) means the module read one item twice (or two items share that place), and `?` means it made an item with no `source`. Fix the module when you wrote it in this run; a module the project already had is changed only on the user's yes.
