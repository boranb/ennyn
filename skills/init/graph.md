# Building the starting graph

Write the graph to the scan's `graph.path`, as a JSON object with two arrays named by `graph.exports`. With the defaults that is `.ennyn/graph.json` holding `{ "nodes": [...], "done": [...] }`.

- **Already kept in files?** When the project keeps its roadmap in files with a fixed line format (checkbox lines with ids, hours and dependencies; a generated status table), do not copy it: a copy goes stale the day the roadmap changes. Write a small `.mjs` module next to the config that reads those files on every load and exports the two arrays, set `paths.graph` to it, and gate the items the roadmap itself postpones, citing where it says so.
- **5 to 15 open nodes** when the work comes from the user's words or a loose list. Each is a complete, independently verifiable piece of user-visible value. A refactor counts only when it unblocks one.
  Shape: `{ "id": "short-kebab-id", "title": "…", "status": "planned", "value": "high|medium|low", "cost": "S|M|L|XL", "cluster": "<area>", "needs": [], "source": "…" }`.
- **From a roadmap file or issues:** one node per item that meets the bar. Merge duplicates. `source` points back to the item, for example `ROADMAP.md:12` or `#42`. Items too vague to verify go into one node per area, titled "Define: …", with value `medium`.
- **value / cost:** estimate them from the item and say so in the report. The user corrects them later.
- **needs:** set only when a node truly cannot start before another one.
- **done:** finished features worth re-checking, as `{ "id", "title", "status": "done" }`. The cycle's legacy audit picks from these.
- **mechanization: true:** only for a defect class that the user or the history names as recurring. Otherwise there are none; the first cycle's convergence report creates them.
- **gate:** for an item the user must start (a release, work in another project's own session), so the cycle does not pick it alone.
