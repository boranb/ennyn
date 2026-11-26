/**
 * The numbers of docs/evidence.md's "Does it work yet?": `node test/evidence-history.mjs <first> <last>` prints, for
 * cycles <first> to <last> of this repository's findings ledger, the convergence columns summed by tens of cycles,
 * the defects of new code by their source, the review rounds past two, how often a class came back in new code after
 * its first gate landed, the class registry at the last cycle's closing, and the rework rate of fixed date ranges.
 * test/evidence-history.test.mjs holds the page to what it prints.
 *
 * Each cycle is counted by the function `ennyn convergence` runs (cycleReport, plugin/metrics/findings.mjs), with
 * `--from` the cycle's start. The repository keeps no record of a cycle's start, so it is read from the ledger: the
 * commit before the earliest commit of HEAD's first-parent line that a row of the cycle names in `commit`. A count
 * the function cannot place prints `?` and the run exits 1; so does a cycle no row of which names a commit of that
 * line, a row's `bornIn` or a gate commit outside it, and an escaped-old count of its own that differs from the
 * function's.
 *
 * New code's defects are the rows whose source is `first-write` or `previous-fix`, whatever caught them; a fix made
 * those whose source is `previous-fix`. Escaped past commit, old, is split by where its `bornIn` lies: after the
 * first cycle's start (code the loop landed in the range) or before it.
 *
 * The class registry is read as the last cycle's closing left it: the first commit after its last landing that
 * changes the registry. A gate, here, is a registry gate whose action is neither `written-rule` nor `advice`. A
 * class's gate cycle is the cycle whose first landing is the latest at or before its earliest such gate; a gate that
 * landed after the range is in no registry its closing left. A row of new code found again counts once, however many classes it
 * names. A closing's registry that names a gate commit no longer on the line (one the history rewrite of cycle
 * 47 replaced) fails the run. Rework runs `ennyn rework` in UTC days over REWORK's ranges; a range whose window has
 * not closed fails.
 */

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CONFIG_PATH, loadConfig } from "../plugin/core/config.mjs";
import { currentClass, parseClasses, stateCounts } from "../plugin/metrics/classes.mjs";
import { cycleReport } from "../plugin/metrics/findings.mjs";

/** Gate actions that are words only: a rule written down, or a warning that never stops a commit. */
const WORDS_ONLY = new Set(["written-rule", "advice"]);
const COLUMNS = /** @type {const} */ (["foundInReview", "fixIntroduced", "gateCaught", "escapedNew", "escapedOld", "preExisting"]);
/** Date ranges for the rework rate, days read in UTC: each one's seven-day windows had closed when the page was written. */
export const REWORK = [
  ["2026-10-18", "2026-10-31"],
  ["2026-11-01", "2026-11-10"],
  ["2026-11-11", "2026-11-18"],
];
const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "ennyn.mjs");

/** @param {number} n */
const num = (n) => n.toLocaleString("en-US");
/** @param {number} part @param {number} whole */
const pct = (part, whole) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`);

/**
 * The lines the page holds for cycles first to last, or the reason they cannot be printed, and the start each
 * cycle was counted from.
 * @param {string} root the repository's top
 * @param {number} first @param {number} last
 * @returns {{ lines: string[], problems: string[], starts: Map<number, string> }}
 */
export function history(root, first, last) {
  const problems = [];
  /** @type {Map<number, string>} */
  const starts = new Map();
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const line = git(["rev-list", "--first-parent", "--reverse", "HEAD"]).split("\n");
  const at = new Map(line.map((h, i) => [h, i]));
  /** A hash or its prefix, placed on the line; -1 when it names no commit of it, or more than one. @param {string} h */
  const place = (h) => {
    if (at.has(h)) return /** @type {number} */ (at.get(h));
    const hits = /^[0-9a-f]{7,39}$/.test(h) ? line.filter((x) => x.startsWith(h)) : [];
    return hits.length === 1 ? /** @type {number} */ (at.get(hits[0])) : -1;
  };
  const config = loadConfig({ cwd: root });
  const rows = readFileSync(join(root, config.paths.findings), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

  /** @type {Map<number, number>} cycle → position of its first landing */
  const landing = new Map();
  let lastLanding = -1;
  for (let c = first; c <= last; c++) {
    const placed = rows.filter((r) => r.cycle === c && typeof r.commit === "string").map((r) => place(r.commit)).filter((p) => p >= 0);
    if (placed.length === 0) {
      problems.push(`cycle ${c}: no row names a commit of HEAD's first-parent line, so its start cannot be read`);
      continue;
    }
    landing.set(c, Math.min(...placed));
    lastLanding = Math.max(lastLanding, ...placed);
  }
  if (problems.length) return { lines: [], problems, starts };

  const firstStart = /** @type {number} */ (landing.get(first)) - 1;
  /** @type {Map<string, boolean>} */
  const configAt = new Map();
  const holdsConfig = (/** @type {string} */ h) => {
    if (!configAt.has(h)) configAt.set(h, git(["ls-tree", "--full-tree", "--name-only", h, "--", CONFIG_PATH]) !== "");
    return /** @type {boolean} */ (configAt.get(h));
  };
  const subject = (/** @type {string} */ h) => git(["log", "-1", "--format=%s", h]);
  const live = (/** @type {any} */ r) => r.dupOf === null && r.outcome !== "refuted";
  const newCode = (/** @type {any} */ r) => live(r) && (r.source === "first-write" || r.source === "previous-fix");

  /** @typedef {{ from: number, to: number, tasks: Set<string>, sums: number[], loopOld: number, repairs: Map<string, number>, made: number, fixMade: number, rounds: number[] }} Band */
  const band0 = (/** @type {number} */ c) => /** @type {Band} */ ({ from: c, to: c, tasks: new Set(), sums: COLUMNS.map(() => 0), loopOld: 0, repairs: new Map(), made: 0, fixMade: 0, rounds: [0, 0, 0] });
  /** @type {Band[]} */
  const bands = [];
  const total = band0(first);
  total.to = last;
  /** @type {number[]} */
  const escapedNewIn = [];
  for (let c = first; c <= last; c++) {
    const startAt = /** @type {number} */ (landing.get(c)) - 1;
    const from = line[startAt];
    starts.set(c, from);
    const report = cycleReport({ cwd: root, config, from, cycle: c });
    const counts = report.counts;
    const unknown = COLUMNS.filter((k) => counts[k] === null);
    if (unknown.length || counts.perRound === null) {
      problems.push(`cycle ${c}: ${[...unknown, ...(counts.perRound === null ? ["perRound"] : [])].join(", ")} read ? (ennyn convergence --cycle ${c} --from ${from.slice(0, 12)})`);
      continue;
    }
    const mine = rows.filter((r) => r.cycle === c);
    // Escaped past commit, old, counted again row by row, to split it by where the defect was born.
    let old = 0;
    let loopOld = 0;
    /** @type {string[]} the type of the commit each loop-born old row names as its fix, or "none" */
    const repaired = [];
    for (const r of mine) {
      if (!live(r) || r.source !== "pre-existing") continue;
      const b = typeof r.bornIn === "string" ? place(r.bornIn) : -1;
      if (b < 0) {
        problems.push(`cycle ${c}: row ${r.id} has a bornIn off HEAD's first-parent line`);
        continue;
      }
      if (b > startAt || !holdsConfig(line[b])) continue;
      old++;
      if (b > firstStart) {
        loopOld++;
        const fixedAt = typeof r.commit === "string" ? place(r.commit) : -1;
        repaired.push(fixedAt < 0 ? "none" : (/^([a-z]+)/.exec(subject(line[fixedAt]))?.[1] ?? "other"));
      }
    }
    if (old !== counts.escapedOld) problems.push(`cycle ${c}: escaped past commit old counted ${old} row by row, ${counts.escapedOld} by convergence`);
    if (counts.escapedNew) escapedNewIn.push(c);
    const made = mine.filter(newCode);
    const ten = Math.floor(c / 10);
    let band = bands.at(-1);
    if (!band || Math.floor(band.from / 10) !== ten) bands.push((band = band0(c)));
    band.to = c;
    for (const b of [band, total]) {
      for (const r of mine) b.tasks.add(`${c}\0${r.task}`);
      COLUMNS.forEach((k, i) => (b.sums[i] += /** @type {number} */ (counts[k])));
      b.loopOld += loopOld;
      for (const t of repaired) b.repairs.set(t, (b.repairs.get(t) ?? 0) + 1);
      b.made += made.length;
      b.fixMade += made.filter((r) => r.source === "previous-fix").length;
      counts.perRound.forEach((n, i) => (b.rounds[i] += n));
    }
  }
  if (problems.length) return { lines: [], problems, starts };

  /** @param {Band} b @param {string} name */
  const row = (b, name) => {
    const [review, fix, gate, escNew, escOld, pre] = b.sums;
    const perTask = b.tasks.size === 0 ? "-" : (b.made / b.tasks.size).toFixed(1);
    return `| ${name} | ${num(b.tasks.size)} | ${[review, fix, gate, escNew, escOld, b.loopOld, pre, b.made].map(num).join(" | ")} | ${num(b.fixMade)} (${pct(b.fixMade, b.made)}) | ${perTask} | ${b.rounds.map(num).join(" / ")} |`;
  };
  const lines = [
    `| Cycles | Tasks | Found in review | Fix-introduced | Gate-caught | Escaped past commit, new | Escaped past commit, old | Of them, born since cycle ${first} began | Pre-existing | New code's defects | Of them, made by a fix | New code's defects per task | New classes, round 1 / 2 / 3+ |`,
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...bands.map((b) => row(b, `${b.from}-${b.to}`)),
    row(total, `**${first}-${last}**`),
    "",
  ];
  lines.push(`- Escaped past commit, new, by cycle: ${escapedNewIn.map((c) => `cycle ${c}`).join(", ") || "none"}.`);
  /** @param {Band} b */
  const types = (b) => {
    const named = [...b.repairs].filter(([t]) => t !== "none").sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const fixes = b.repairs.get("fix") ?? 0;
    const all = named.reduce((n, [, k]) => n + k, 0);
    const none = b.repairs.get("none") ?? 0;
    const told = all === 0 ? "" : `${num(fixes)} of ${num(all)} under \`fix:\` (${named.map(([t, k]) => `${t} ${num(k)}`).join(", ")})`;
    return `${b.from}-${b.to}: ${[told, none ? `${num(none)} naming no fixing commit` : ""].filter(Boolean).join(", ")}`;
  };
  lines.push(`- Old escapes born since cycle ${first} began, by the type of the commit each row names as its fix: ${bands.map(types).join(" · ")}.`);
  /** @param {number} a @param {number} b */
  const ratio = (a, b) => (b === 0 ? "-" : (a / b).toFixed(2));
  lines.push(`- Defects a fix made per finding found in review, by band: ${bands.map((b) => ratio(b.sums[1], b.sums[0])).join(", ")} by the fix-introduced column; ${bands.map((b) => ratio(b.fixMade, b.sums[0])).join(", ")} by source (made by a fix, whatever caught it).`);
  const late = rows.filter((r) => r.cycle >= first && r.cycle <= last && r.round >= 3);
  const lateCycles = [...new Set(late.map((r) => r.cycle))].sort((a, b) => a - b);
  lines.push(`- Rows of review round 3 or later: ${num(late.length)}, in cycles ${lateCycles.join(", ") || "none"}.`);

  // The class registry as the last cycle's closing left it.
  const closing = git(["log", "--first-parent", "--reverse", "--format=%H", `${line[lastLanding]}..HEAD`, "--", config.paths.classes]).split("\n")[0];
  if (!closing) return { lines: [], problems: [`no commit after cycle ${last}'s last landing changes ${config.paths.classes}: its closing has not run`], starts };
  const text = git(["show", `${closing}:${config.paths.classes}`]);
  const reg = parseClasses(text, { path: config.paths.classes });
  if (reg.problems.length) return { lines: [], problems: [`${config.paths.classes} at ${closing.slice(0, 12)}: ${reg.problems.join("; ")}`], starts };
  lines.push(`- Class registry at cycle ${last}'s closing (${closing.slice(0, 7)}): ${num(reg.entries.length)} classes, ${stateCounts(reg).map(([s, n]) => `${num(n)} ${s}`).join(", ")}.`);
  const entries = /** @type {{ id: string, gates?: { commit: string, action: string }[] }[]} */ (JSON.parse(text).classes);
  const firsts = [...landing.entries()].sort((a, b) => a[1] - b[1]);
  /** The cycle a commit landed in: the last cycle whose first landing is at or before it; first - 1 before them all. @param {number} p */
  const cycleAt = (p) => firsts.reduce((c, [cycle, pos]) => (pos <= p ? cycle : c), first - 1);
  const counted = rows.filter((r) => r.cycle >= first && r.cycle <= last && newCode(r));
  let gated = 0;
  let back = 0;
  /** @type {Set<string>} */
  const again = new Set();
  /** @type {Set<string>} */
  const againByGate = new Set();
  /** @type {string[]} */
  const quiet = [];
  for (const e of entries) {
    const gates = (e.gates ?? []).filter((g) => !WORDS_ONLY.has(g.action));
    if (gates.length === 0) continue;
    const placed = gates.map((g) => place(g.commit));
    if (placed.some((p) => p < 0)) {
      problems.push(`class ${e.id}: a gate commit is not on HEAD's first-parent line`);
      continue;
    }
    const earliest = Math.min(...placed);
    gated++;
    const since = cycleAt(earliest);
    const found = counted.filter((r) => r.cycle > since && r.class.some((/** @type {string} */ v) => currentClass(reg, v) === e.id));
    if (found.length === 0) quiet.push(`\`${e.id}\` (gate in cycle ${since})`);
    else back++;
    for (const r of found) {
      again.add(r.id);
      if (/^(?:test|gate):/.test(r.caughtBy)) againByGate.add(r.id);
    }
  }
  if (problems.length) return { lines: [], problems, starts };
  lines.push(
    `- Classes with a gate beyond a written rule or advice, landed by cycle ${last}: ${num(gated)}. Found again in new code in a later cycle than their first such gate: ${num(back)} of ${num(gated)} classes, in ${num(again.size)} rows, ${num(againByGate.size)} of them caught by a gate. Not found again: ${quiet.join(", ") || "none"}.`,
  );

  return { lines, problems, starts };
}

/**
 * The page's block: history's lines, then a rework line for each of REWORK's ranges. The rework runs start first
 * and run beside the count, as each reads the whole history again.
 * @param {string} root @param {number} first @param {number} last
 * @returns {Promise<{ lines: string[], problems: string[] }>}
 */
export async function pageBlock(root, first, last) {
  const runs = REWORK.map(([since, until]) => run(process.execPath, [CLI, "rework", "--since", since, "--until", until, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, TZ: "UTC" } }));
  const counted = history(root, first, last);
  const done = await Promise.allSettled(runs);
  const lines = [...counted.lines];
  const problems = [...counted.problems];
  done.forEach((d, i) => {
    const [since, until] = REWORK[i];
    if (d.status === "rejected") return void problems.push(`rework ${since} to ${until}: ${d.reason}`);
    const r = JSON.parse(d.value.stdout);
    if (r.censored !== 0 || r.shallow) return void problems.push(`rework ${since} to ${until}: ${r.censored} commits whose window has not closed${r.shallow ? ", in a shallow clone" : ""}`);
    lines.push(`- Rework, ${since} to ${until} in UTC days: ${num(r.reworked)} of ${num(r.commits)} commits had lines a \`fix:\` commit changed within ${r.days} days (${(100 * r.rate).toFixed(1)}%).`);
  });
  return problems.length ? { lines: [], problems } : { lines, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [a, b, ...rest] = process.argv.slice(2);
  const first = Number(a);
  const last = Number(b);
  if (rest.length || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    process.stderr.write("usage: node test/evidence-history.mjs <first cycle> <last cycle>\n");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { lines, problems } = await pageBlock(root, first, last);
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
