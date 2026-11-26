/**
 * The terminal demo at the top of README.md and README.tr.md (docs/assets/demo.svg), made from what Ennyn's CLI
 * prints on a made-up project built in a temporary directory: `ennyn init-scan` before any setup, then, once a
 * config, a work graph and one cycle's findings ledger are in place, `ennyn core` and `ennyn convergence`. No model
 * runs: /ennyn:init is a skill a model follows, so the demo shows the survey that skill starts from and the CLI's
 * reports, never a recording of a session. `ennyn doctor` runs on the set-up project and must pass, but is not shown:
 * several of its checks print a paragraph of caveats each, which would fill the frame.
 *
 * Development tooling, so it lives under test/: npm publishes plugin/ and scripts/ (package.json "files"), and the
 * plugin folder is what users install. test/demo.test.mjs runs it again and compares with the committed image.
 *
 *   node test/demo/make.mjs            write docs/assets/demo.svg
 *   node test/demo/make.mjs --text     print the transcript the image shows
 *
 * The output is the same on every run and every machine: fixed commit dates and identity, no user or system git
 * config, the C locale, UTC, a fixed terminal width, and the temporary directory written as the project's place
 * (`~/lamplight`). A line longer than the frame wraps at a space, its rest indented; nothing is cut.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "plugin", "scripts", "ennyn.mjs");
export const OUT = join(ROOT, "docs", "assets", "demo.svg");
/** Where the project seems to live in the transcript. */
const PLACE = "~/lamplight";
/** The frame's width in characters. */
export const COLS = 100;
const WHO = { name: "Sam Sample", email: "sam@lamplight.test" };

/** The project's history before Ennyn: [day, subject, files it writes]. One commit a day from 2026-09-01. */
const HISTORY = [
  ["feat: catalog of lamps with prices", { "src/catalog.mjs": "export const lamps = [];\n", "package.json": '{\n  "name": "lamplight",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n', "README.md": "# Lamplight\n\nA small shop for lamps.\n" }],
  ["test: catalog lists every lamp", { "test/catalog.test.mjs": "import 'node:test';\n" }],
  ["feat: cart with item count and total", { "src/cart.mjs": "export function total() {}\n" }],
  ["test: cart totals", { "test/cart.test.mjs": "import 'node:test';\n" }],
  ["fix: cart total rounded each line instead of the sum", { "src/cart.mjs": "export function total() { return 0; }\n" }],
  ["feat(pay): charge a card for the cart total", { "src/pay/charge.mjs": "export function charge() {}\n" }],
  ["docs: how to run the shop locally", { "README.md": "# Lamplight\n\nA small shop for lamps.\n\nRun: npm start\n" }],
  ["fix(pay): charge retried twice on a slow answer", { "src/pay/charge.mjs": "export function charge() { return 1; }\n" }],
  ["feat: discount codes in the cart", { "src/cart.mjs": "export function total() { return 0; }\nexport function discount() {}\n" }],
  ["test: discount codes", { "test/cart.test.mjs": "import 'node:test';\n// discount\n" }],
  ["fix: discount applied after tax", { "src/cart.mjs": "export function total() { return 0; }\nexport function discount() { return 0; }\n" }],
  ["refactor: one price format for cart and catalog", { "src/price.mjs": "export function price() {}\n" }],
  ["feat: stock count per lamp", { "src/catalog.mjs": "export const lamps = [];\nexport const stock = {};\n" }],
  ["fix: stock went negative when two orders came in together", { "src/catalog.mjs": "export const lamps = [];\nexport const stock = { min: 0 };\n" }],
  ["chore: node 22 in package.json", { "package.json": '{\n  "name": "lamplight",\n  "private": true,\n  "type": "module",\n  "engines": { "node": ">=22" },\n  "scripts": { "test": "node --test" }\n}\n' }],
  ["feat(pay): receipts by email", { "src/pay/receipt.mjs": "export function receipt() {}\n" }],
  ["fix(pay): receipt showed the total before the discount", { "src/pay/receipt.mjs": "export function receipt() { return 0; }\n" }],
  ["test(pay): receipts", { "test/receipt.test.mjs": "import 'node:test';\n" }],
  ["feat: order history page", { "src/orders.mjs": "export function history() {}\n" }],
  ["fix: order history sorted oldest first", { "src/orders.mjs": "export function history() { return []; }\n" }],
  ["docs: payment setup", { "docs/payments.md": "# Payments\n" }],
  ["feat: wish list", { "src/wish.mjs": "export function wish() {}\n" }],
  ["fix: wish list lost on logout", { "src/wish.mjs": "export function wish() { return []; }\n" }],
  ["refactor(pay): charge and receipt share the order id", { "src/pay/charge.mjs": "export function charge(id) { return id; }\n" }],
  ["feat: search by lamp colour", { "src/search.mjs": "export function search() {}\n" }],
  ["test: search", { "test/search.test.mjs": "import 'node:test';\n" }],
  ["fix: search ignored the second word", { "src/search.mjs": "export function search() { return []; }\n" }],
  ["feat(pay): refunds by hand from the admin page", { "src/pay/refund.mjs": "export function refund() {}\n" }],
  ["fix(pay): refund allowed twice for one order", { "src/pay/refund.mjs": "export function refund() { return 0; }\n" }],
  ["chore: update the lock file", { "package-lock.json": '{\n  "name": "lamplight",\n  "lockfileVersion": 3,\n  "packages": { "": { "name": "lamplight" } }\n}\n' }],
  ["feat: free shipping over a threshold", { "src/cart.mjs": "export function total() { return 0; }\nexport function discount() { return 0; }\nexport const shipping = 0;\n" }],
  ["fix: free shipping counted the discount twice", { "src/cart.mjs": "export function total() { return 0; }\nexport function discount() { return 0; }\nexport const shipping = 1;\n" }],
  ["feat: gift wrap option", { "src/cart.mjs": "export function total() { return 0; }\nexport function discount() { return 0; }\nexport const shipping = 1;\nexport const wrap = false;\n" }],
  ["feat: lamp reviews", { "src/reviews.mjs": "export function reviews() {}\n" }],
  ["fix: reviews showed for hidden lamps", { "src/reviews.mjs": "export function reviews() { return []; }\n" }],
  ["refactor: catalog reads stock through one function", { "src/catalog.mjs": "export const lamps = [];\nexport const stock = { min: 0 };\nexport function inStock() {}\n" }],
  ["feat(pay): pay later for business accounts", { "src/pay/later.mjs": "export function later() {}\n" }],
  ["fix(pay): pay later skipped the credit limit", { "src/pay/later.mjs": "export function later() { return 0; }\n" }],
  ["feat: order status emails", { "src/orders.mjs": "export function history() { return []; }\nexport function status() {}\n" }],
  ["fix: status email sent before the charge cleared", { "src/orders.mjs": "export function history() { return []; }\nexport function status() { return 0; }\n" }],
];

/** The work graph /ennyn:init leaves, its nodes from the project's notes. */
const GRAPH = {
  nodes: [
    { id: "payment-ledger", title: "One ledger row per charge and refund, so a retry cannot pay twice", status: "planned", value: "high", cost: "S", cluster: "pay", needs: [], source: "fix history of src/pay", since: 1 },
    { id: "refund-flow", title: "Customers ask for a refund themselves, checked against the ledger", status: "planned", value: "high", cost: "M", cluster: "pay", needs: ["payment-ledger"], source: "support notes", since: 1 },
    { id: "stock-lock", title: "Hold stock while an order is paid", status: "planned", value: "medium", cost: "S", cluster: "catalog", needs: [], source: "fix history of src/catalog.mjs", since: 1 },
    { id: "search-typos", title: "Search that forgives one wrong letter", status: "planned", value: "low", cost: "M", cluster: "catalog", needs: [], source: "support notes", since: 1 },
  ],
  done: [],
  declined: [],
};

/** The class registry: two classes the project named at setup. */
const CLASSES = {
  about: "Defect classes of the lamplight shop.",
  classes: [
    { id: "retry-pays-twice", says: "A retried step repeats an effect that should happen once.", state: "open", gates: [], nodes: ["payment-ledger"], linked: [] },
    { id: "unchecked-amount", says: "An amount from outside is used before its sign and size are checked.", state: "open", gates: [], nodes: [], linked: [] },
    { id: "stale-total", says: "A total is read before the change that moves it.", state: "open", gates: [], nodes: [], linked: [] },
  ],
};

/** A day's date at a fixed hour, UTC. @param {number} day days after 2026-09-01 */
const dateOf = (day) => new Date(Date.UTC(2026, 8, 1 + day, 9, 0, 0)).toISOString().replace(".000Z", "Z");

/**
 * Builds the project in `dir` and returns the transcript: each command as typed, then what it printed.
 * @param {string} dir an empty directory
 * @returns {string[]}
 */
export function transcript(dir) {
  const real = realpathSync(dir);
  const repo = join(real, "lamplight");
  const home = join(real, "home");
  mkdirSync(repo);
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "");
  // Only what the runs need: nothing of the user's setup reaches git or the CLI.
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: real,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: real,
    TZ: "UTC",
    LC_ALL: "C",
    LANG: "C",
    COLUMNS: String(COLS),
    NO_COLOR: "1",
  };
  /** @param {string} cmd @param {string[]} args @param {Record<string, string>} [more] */
  const run = (cmd, args, more = {}) => {
    const r = spawnSync(cmd, args, { cwd: repo, env: { ...env, ...more }, encoding: "utf8" });
    if (r.error) throw r.error;
    return r;
  };
  /** @param {string[]} args */
  const git = (args) => {
    const r = run("git", args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** @param {Record<string, string>} files */
  const put = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  /** @param {number} day @param {string} subject */
  const commit = (day, subject) => {
    git(["add", "-A"]);
    const when = dateOf(day);
    const r = run("git", ["commit", "-q", "-m", subject], {
      GIT_AUTHOR_NAME: WHO.name, GIT_AUTHOR_EMAIL: WHO.email, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: WHO.name, GIT_COMMITTER_EMAIL: WHO.email, GIT_COMMITTER_DATE: when,
    });
    if (r.status !== 0) throw new Error(`commit ${subject}: ${r.stderr}`);
    return git(["rev-parse", "HEAD"]);
  };
  /** What the CLI prints, the project's place written as PLACE. @param {string[]} args */
  const ennyn = (args) => {
    const r = run(process.execPath, [CLI, ...args]);
    if (r.status === null) throw new Error(`ennyn ${args.join(" ")}: ended by ${r.signal}`);
    const text = `${r.stdout}${r.stderr}`.replaceAll(repo, PLACE).replace(/\n+$/, "");
    return { status: r.status, lines: text.split("\n") };
  };
  /** @type {string[]} */
  const out = [];
  /** @param {string} shown @param {{ status: number, lines: string[] }} res @param {number} want */
  const step = (shown, res, want) => {
    if (res.status !== want) throw new Error(`ennyn ${shown} exited ${res.status}, not ${want}:\n${res.lines.join("\n")}`);
    if (out.length) out.push("");
    out.push(`$ ennyn ${shown}`, ...res.lines);
  };

  git(["init", "-q", "-b", "main"]);
  const hashes = HISTORY.map(([subject, files], day) => (put(/** @type {Record<string, string>} */ (files)), commit(day, /** @type {string} */ (subject))));
  step("init-scan", ennyn(["init-scan"]), 0);

  // What /ennyn:init writes once the user has answered: the config, the graph, the ask rules the scan proposed,
  // the ignore line for agent worktrees, and the commit-msg hook.
  const scan = JSON.parse(ennyn(["init-scan", "--json"]).lines.join("\n"));
  const ask = scan.agentSetup.ask.rules.map((/** @type {{ rule: string }} */ r) => r.rule);
  const config = {
    language: "en",
    paths: { graph: ".ennyn/graph.json" },
    commitMsg: { types: ["feat", "fix", "docs", "test", "refactor", "chore"], fixType: "fix" },
    commands: { fastTest: "npm test", wholeTest: "npm test" },
    review: { impactRequiredGlobs: ["src/pay/**"] },
  };
  put({
    ".ennyn/config.json": `${JSON.stringify(config, null, 2)}\n`,
    ".ennyn/graph.json": `${JSON.stringify(GRAPH, null, 2)}\n`,
    ".ennyn/classes.json": `${JSON.stringify(CLASSES, null, 2)}\n`,
    ".claude/settings.json": `${JSON.stringify({ permissions: { ask, deny: ["Read(.env*)", "Read(~/.ssh/**)", "Read(~/.aws/**)"] } }, null, 2)}\n`,
    ".gitignore": ".claude/worktrees/\nnode_modules/\n",
  });
  const start = commit(HISTORY.length, "chore: set up ennyn");
  const hook = ennyn(["install-hook"]);
  if (hook.status !== 0) throw new Error(`install-hook: ${hook.lines.join("\n")}`);

  // Cycle 1 takes payment-ledger. Its findings: one caught by a gate before review, two in review's first round,
  // one a first-round fix brought, and one older defect review found in code from before the setup.
  put({ "src/pay/ledger.mjs": "export function record() {}\n", "test/ledger.test.mjs": "import 'node:test';\n" });
  const landed = commit(HISTORY.length + 1, "feat(pay): one ledger row per charge\n\nImpact: charge and refund write through the ledger\nReview-Rounds: 2\nMutation: first 5/6 · last 6/6");
  const old = hashes[7];
  const short = landed.slice(0, 7);
  const row = (/** @type {Record<string, unknown>} */ r) => JSON.stringify({ cycle: 1, task: "payment-ledger", dupOf: null, input: "use", commit: short, bornIn: null, ...r });
  const rows = [
    row({ round: 0, id: "c1-t1-author-r0-01", severity: "medium", class: ["unchecked-amount"], source: "first-write", caughtBy: "gate:mutation", fingerprint: "negative amount written to the ledger", outcome: "fixed-test", file: "src/pay/ledger.mjs", line: 1 }),
    row({ round: 1, id: "c1-t1-rev-r1-01", severity: "high", class: ["retry-pays-twice"], source: "first-write", caughtBy: "review", fingerprint: "retry writes a second ledger row", outcome: "fixed-test", file: "src/pay/ledger.mjs", line: 1 }),
    row({ round: 1, id: "c1-t1-rev-r1-02", severity: "medium", class: ["unchecked-amount"], source: "first-write", caughtBy: "review", fingerprint: "refund larger than the charge accepted", outcome: "fixed-test", file: "src/pay/ledger.mjs", line: 1 }),
    row({ round: 2, id: "c1-t1-rev-r2-01", severity: "low", class: ["stale-total"], source: "previous-fix", caughtBy: "review", fingerprint: "retry guard reads the total before the row", outcome: "fixed", file: "src/pay/ledger.mjs", line: 1 }),
    row({ round: 1, id: "c1-t1-rev-r1-03", severity: "medium", class: ["retry-pays-twice"], source: "pre-existing", caughtBy: "review", fingerprint: "charge retried with no idempotency key", outcome: "node:charge-idempotency", bornIn: old, file: "src/pay/charge.mjs", line: 1 }),
  ];
  put({ ".ennyn/findings.jsonl": `${rows.join("\n")}\n` });
  const graph = structuredClone(GRAPH);
  const [took] = graph.nodes.splice(0, 1);
  graph.done.push(/** @type {never} */ ({ ...took, status: "done" }));
  graph.nodes.push({ id: "charge-idempotency", title: "An idempotency key on every charge", status: "planned", value: "high", cost: "S", cluster: "pay", needs: [], source: "cycle 1 review, c1-t1-rev-r1-03", since: 2 });
  put({ ".ennyn/graph.json": `${JSON.stringify(graph, null, 2)}\n` });
  commit(HISTORY.length + 2, "chore: cycle 1 closed: graph and findings");

  // The setup is one doctor passes, with no problem and no warning.
  const doctor = ennyn(["doctor"]);
  if (doctor.status !== 0 || !doctor.lines.includes("problems: 0 · warnings: 0")) throw new Error(`doctor on the sample project:\n${doctor.lines.join("\n")}`);
  out.push("", "# later: /ennyn:init has written the config and the work graph, and cycle 1 has landed");
  step("core", ennyn(["core"]), 0);
  step(`convergence --cycle 1 --from ${start.slice(0, 7)}`, ennyn(["convergence", "--cycle", "1", "--from", start]), 0);
  return out;
}

/** @param {string} s */
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A line as the frame shows it: rows of at most COLS characters, broken at a space where one is, the rest of the line
 * indented by two. Every character is kept.
 * @param {string} line
 * @returns {string[]}
 */
export function wrap(line) {
  const rows = [];
  let rest = [...line];
  let width = COLS;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const cut = space > 0 ? space : width;
    rows.push(rest.slice(0, cut).join(""));
    rest = rest.slice(space > 0 ? cut + 1 : cut);
    width = COLS - 2;
  }
  rows.push(rest.join(""));
  return rows.map((r, i) => (i ? `  ${r}` : r));
}

/**
 * The transcript as an SVG terminal: a dark frame, which reads on GitHub's light and dark pages alike, so it needs
 * no media query, and no script (an <img> runs none). Text only, in a monospace font; the command stands out, the
 * prompt and the one comment between the steps are grey.
 * @param {string[]} lines
 */
export function svg(lines) {
  const size = 14;
  const lead = 20;
  const pad = 20;
  const bar = 36;
  const rows = lines.flatMap(wrap);
  const width = Math.ceil(COLS * size * 0.6) + 2 * pad;
  const height = bar + pad + rows.length * lead + pad - 6;
  /** @param {string} row */
  const body = (row) =>
    row.startsWith("$ ") ? `<tspan class="p">$ </tspan><tspan class="c">${xml(row.slice(2))}</tspan>` : row.startsWith("# ") ? `<tspan class="p">${xml(row)}</tspan>` : xml(row);
  const text = rows.flatMap((r, i) => (r === "" ? [] : [`<text x="${pad}" y="${bar + pad + 4 + i * lead}">${body(r)}</text>`]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t">
<title id="t">ennyn init-scan, core and convergence on a made-up sample project, as the CLI prints them</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${size}px;fill:#d1d7e0;white-space:pre}
.p{fill:#8b949e}.c{fill:#f0f6fc;font-weight:bold}.h{fill:#8b949e;font-size:13px}
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="#161b22" stroke="#3d444d"/>
<path d="M0.5 ${bar}H${width - 0.5}" stroke="#3d444d"/>
<circle cx="20" cy="18" r="6" fill="#f85149"/><circle cx="40" cy="18" r="6" fill="#d29922"/><circle cx="60" cy="18" r="6" fill="#3fb950"/>
<text class="h" x="${width / 2}" y="23" text-anchor="middle">${xml(PLACE)} — a made-up sample project</text>
<g xml:space="preserve">
${text.join("\n")}
</g>
</svg>
`;
}

/** Builds the image in a temporary directory of its own and removes the directory. */
export function make() {
  const dir = mkdtempSync(join(tmpdir(), "ennyn-demo-"));
  try {
    const lines = transcript(dir);
    return { lines, svg: svg(lines) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const res = make();
  if (process.argv.includes("--text")) process.stdout.write(`${res.lines.join("\n")}\n`);
  else {
    const before = (() => {
      try {
        return readFileSync(OUT, "utf8");
      } catch {
        return null;
      }
    })();
    writeFileSync(OUT, res.svg);
    process.stdout.write(`${before === res.svg ? "unchanged" : "wrote"} ${OUT.slice(ROOT.length + 1)} (${Buffer.byteLength(res.svg)} bytes, ${res.lines.length} lines)\n`);
  }
}
