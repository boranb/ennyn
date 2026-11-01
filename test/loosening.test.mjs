import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, stagedVersions } from "../core/git.mjs";
import { ConfigError, DEFAULTS, STRING_LISTS, configFrom, loadConfig } from "../core/config.mjs";
import { LOOSENING_LINE, approvedKeys, gateKeyKind, loaded, loosenedKeys } from "../checks/loosening.mjs";
import { installHook } from "../setup/hook.mjs";
import { TOKENS } from "./secret-shapes.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ennyn.mjs");
const LINE = LOOSENING_LINE;
const CONFIG = ".ennyn/config.json";

/** The config as the gates read it, from the text a project writes. @param {Record<string, unknown>} over */
const eff = (over = {}) => loadConfig({ cwd: mkdtempSync(join(tmpdir(), "en-ls-")), env: {}, override: over });

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A repository whose first commit holds `config` (null: none) and whose commit-msg hook is the real one. @param {Record<string, unknown> | null} [config] */
function repo(config = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-repo-")));
  git(["init", "-q", "-b", "main"], { cwd: dir });
  put(dir, { "base.txt": "x\n", ...(config ? { [CONFIG]: JSON.stringify(config) } : {}) });
  git(["add", "-A"], { cwd: dir });
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  git([...id, "commit", "-q", "--no-verify", "-m", "chore: base"], { cwd: dir });
  installHook({ cwd: dir, cliPath: CLI });
  /** @param {string} message @param {string[]} [extra] @param {NodeJS.ProcessEnv} [env] */
  const commit = (message, extra = [], env = {}) => spawnSync("git", [...id, "commit", "-q", ...extra, "-m", message], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const stage = (/** @type {Record<string, string>} */ files) => (put(dir, files), git(["add", "-A"], { cwd: dir }));
  const held = (/** @type {string} */ rev = "HEAD") => git(["show", `${rev}:${CONFIG}`], { cwd: dir });
  return { dir, commit, stage, held, id };
}

const WORKFLOW = "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n";
const FOREIGN = "https://evil.example.invalid/x/-/x-1.0.0.tgz";
const LOCK = JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "p", version: "1.0.0", dependencies: { x: "1.0.0" } }, "node_modules/x": { version: "1.0.0", resolved: FOREIGN, integrity: "sha512-AAAA" } } });
const PKG = { "package.json": JSON.stringify({ name: "p", version: "1.0.0", dependencies: { x: "1.0.0" } }), "package-lock.json": LOCK };
const OFFLINE = { security: { deps: { online: false } } };
const BAN = { review: { forbidden: [{ text: "SECRETWORD", paths: ["src/**"] }] } };

/** The six keys of the security audit's reproduction: the base refuses `files`, and `to` is the same config with the gate loosened. */
const SIX = [
  { name: "security.ci.paths", base: {}, files: { ".github/workflows/x.yml": WORKFLOW }, to: { security: { ci: { paths: [] } } } },
  { name: "security.ci.except", base: {}, files: { ".github/workflows/x.yml": WORKFLOW }, to: { security: { ci: { except: ["**"] } } } },
  { name: "security.deps.paths", base: OFFLINE, files: PKG, to: { security: { deps: { online: false, paths: [] } } } },
  { name: "security.deps.sources", base: OFFLINE, files: PKG, to: { security: { deps: { online: false, sources: [FOREIGN] } } } },
  { name: "review.forbidden", base: BAN, files: { "src/a.js": "SECRETWORD\n" }, to: { review: { forbidden: [] } } },
  { name: "review.impactRequiredGlobs", base: { review: { impactRequiredGlobs: ["src/**"] } }, files: { "src/a.js": "x\n" }, to: { review: { impactRequiredGlobs: [] } } },
];

for (const k of SIX) {
  test(`one reading: an edit of ${k.name} that is never staged lets nothing through, and is said`, () => {
    const r = repo(k.base);
    r.stage(k.files);
    assert.equal(r.commit("feat: probe").status, 1, "the control: the gate refuses under the committed config");
    put(r.dir, { [CONFIG]: JSON.stringify(k.to) });
    git(["reset", "-q", "--", CONFIG], { cwd: r.dir });
    const c = r.commit("feat: probe");
    assert.equal(c.status, 1, c.stderr);
    assert.match(c.stderr, /\.ennyn\/config\.json in the work tree is not what this commit holds/);
  });
}

/** The config a corpus case moves from: every list and number a gate reads, away from its default. */
const BASE = {
  commitMsg: { types: ["feat", "fix"], subjectMax: 80, style: "terse", skipSubjects: ["^Merge "] },
  review: {
    maxRounds: 2,
    impactRequiredGlobs: ["a/**"],
    impactIgnoreGlobs: ["**/*.test.*"],
    forbidden: [{ text: "X", paths: ["s/**"], except: ["s/t/**"] }],
    cochange: [{ paths: ["src/**"], docs: ["D.md"] }],
  },
  security: {
    everyCycles: 3,
    secrets: { except: ["t/**"] },
    ci: { except: ["c/**"] },
    deps: { allowScripts: ["esbuild"], allow: ["a@1.0.0"], sources: ["git+x"], cooldownDays: 7, minShare: 0.01, minWeekly: 1000, timeout: 20, registries: { "https://r.example": "https://d.example" } },
  },
};
/** @param {(c: any) => void} change */
const moved = (change) => {
  const c = JSON.parse(JSON.stringify(BASE));
  change(c);
  return c;
};
const keysOf = (/** @type {(c: any) => void} */ change) => loosenedKeys(eff(BASE), eff(moved(change)));

test("loosening corpus: a tightening or neutral edit names no key", () => {
  /** @type {Record<string, (c: any) => void>} */
  const accept = {
    "impact glob added": (c) => c.review.impactRequiredGlobs.push("b/**"),
    "impact ignore gone": (c) => (c.review.impactIgnoreGlobs = []),
    "secrets except gone": (c) => (c.security.secrets.except = []),
    "ci except gone": (c) => (c.security.ci.except = []),
    "a forbidden rule added": (c) => c.review.forbidden.push({ text: "Y", paths: ["**"] }),
    "a forbidden except gone": (c) => delete c.review.forbidden[0].except,
    "forbidden paths wider": (c) => c.review.forbidden[0].paths.push("l/**"),
    "a note on a forbidden rule": (c) => (c.review.forbidden[0].note = "why"),
    "a cochange rule added": (c) => c.review.cochange.push({ paths: ["x"], docs: ["y"] }),
    "cochange paths wider": (c) => c.review.cochange[0].paths.push("lib/**"),
    "cochange docs narrower, a doc moved out": (c) => (c.review.cochange[0] = { paths: ["src/**"], docs: ["D.md"], note: "n" }),
    "subject shorter": (c) => (c.commitMsg.subjectMax = 60),
    "cooldown up": (c) => (c.security.deps.cooldownDays = 14),
    "share up": (c) => (c.security.deps.minShare = 0.5),
    "weekly up": (c) => (c.security.deps.minWeekly = 5000),
    "timeout up": (c) => (c.security.deps.timeout = 60),
    "rounds down": (c) => (c.review.maxRounds = 1),
    "audit more often": (c) => (c.security.everyCycles = 2),
    "allowScripts gone": (c) => (c.security.deps.allowScripts = []),
    "a type gone": (c) => (c.commitMsg.types = ["fix"]),
    "a list in another order": (c) => (c.commitMsg.types.reverse(), c.review.impactIgnoreGlobs.reverse(), (c.commitMsg.structuredLines = [...DEFAULTS.commitMsg.structuredLines].reverse())),
    "a registry gone": (c) => (c.security.deps.registries = {}),
    "skip pattern gone": (c) => (c.commitMsg.skipSubjects = []),
    "a key no gate reads": (c) => ((c.language = "tr"), (c.commitMsg.language = "tr"), (c.commitMsg.fixType = "feat"), (c.planner = { splitAbove: 3 }), (c.paths = { handoff: "H.md" }), (c.review.agents = ["a"]), (c.metrics = { reworkDays: 3 })),
  };
  for (const [name, change] of Object.entries(accept)) assert.deepEqual(keysOf(change), [], name);
  // From nothing to something is tighter: no list was there to widen.
  assert.deepEqual(loosenedKeys(eff({}), eff({ commitMsg: { types: ["feat", "fix"] }, security: { everyCycles: 1 } })), []);
  assert.deepEqual(loosenedKeys(eff({ commitMsg: { style: "normal" }, security: { everyCycles: 0 } }), eff({ commitMsg: { style: "terse" }, security: { everyCycles: 9 } })), [], "0 is off: any number is tighter");
});

test("loosening corpus: each way a value loosens names its key, and only its key", () => {
  /** @type {[string, (c: any) => void][]} */
  const reject = [
    ["commitMsg.types", (c) => c.commitMsg.types.push("wip")],
    ["commitMsg.types", (c) => (c.commitMsg.types = [])],
    ["commitMsg.style", (c) => (c.commitMsg.style = "normal")],
    ["commitMsg.subjectMax", (c) => (c.commitMsg.subjectMax = 90)],
    ["commitMsg.subjectMax", (c) => delete c.commitMsg.subjectMax],
    ["commitMsg.bodyMaxLines", (c) => (c.commitMsg.bodyMaxLines = 9)],
    ["commitMsg.bodyMaxChars", (c) => (c.commitMsg.bodyMaxChars = 900)],
    ["commitMsg.structuredLines", (c) => (c.commitMsg.structuredLines = ["Why:"])],
    ["commitMsg.structuredLines", (c) => (c.commitMsg.structuredLines = [])],
    ["commitMsg.structuredLineMax", (c) => (c.commitMsg.structuredLineMax = 900)],
    ["commitMsg.skipSubjects", (c) => c.commitMsg.skipSubjects.push("^nope")],
    ["commitMsg.skipSubjects", (c) => (c.commitMsg.skipSubjects = ["^M"])],
    ["commitMsg.allowMarker", (c) => (c.commitMsg.allowMarker = "[ok:")],
    ["review.maxRounds", (c) => (c.review.maxRounds = 9)],
    ["review.roundsLine", (c) => (c.review.roundsLine = "Rounds:")],
    ["review.thirdRoundLine", (c) => (c.review.thirdRoundLine = "Third:")],
    ["review.impactLine", (c) => (c.review.impactLine = "")],
    ["review.impactRequiredGlobs", (c) => (c.review.impactRequiredGlobs = [])],
    ["review.impactRequiredGlobs", (c) => (c.review.impactRequiredGlobs = ["a/b/**"])],
    ["review.impactIgnoreGlobs", (c) => c.review.impactIgnoreGlobs.push("a/**")],
    ["review.cochange", (c) => (c.review.cochange = [])],
    ["review.cochange", (c) => (c.review.cochange[0].paths = ["lib/**"])],
    ["review.cochange", (c) => c.review.cochange[0].docs.push("E.md")],
    ["review.forbidden", (c) => (c.review.forbidden = [])],
    ["review.forbidden", (c) => (c.review.forbidden[0].text = "Z")],
    ["review.forbidden", (c) => (c.review.forbidden[0].paths = ["l/**"])],
    ["review.forbidden", (c) => c.review.forbidden[0].except.push("s/u/**")],
    ["review.forbidden", (c) => (c.review.forbidden[0].except = ["**"])],
    ["push.warnAtUnpushed", (c) => (c.push = { warnAtUnpushed: 99 })],
    ["security.everyCycles", (c) => (c.security.everyCycles = 9)],
    ["security.everyCycles", (c) => (c.security.everyCycles = 0)],
    ["security.ci.paths", (c) => (c.security.ci.paths = [])],
    ["security.ci.paths", (c) => (c.security.ci.paths = [".github/workflows/*.yml"])],
    ["security.ci.except", (c) => c.security.ci.except.push("**")],
    ["security.deps.paths", (c) => (c.security.deps.paths = [])],
    ["security.deps.cooldownDays", (c) => (c.security.deps.cooldownDays = 1)],
    ["security.deps.minShare", (c) => (c.security.deps.minShare = 0)],
    ["security.deps.minWeekly", (c) => (c.security.deps.minWeekly = 0)],
    ["security.deps.allow", (c) => c.security.deps.allow.push("b@1.0.0")],
    ["security.deps.allowScripts", (c) => c.security.deps.allowScripts.push("x")],
    ["security.deps.sources", (c) => c.security.deps.sources.push("git+y")],
    ["security.deps.online", (c) => (c.security.deps.online = false)],
    ["security.deps.timeout", (c) => (c.security.deps.timeout = 1)],
    ["security.deps.registries", (c) => (c.security.deps.registries["https://e.example"] = null)],
    ["security.deps.registries", (c) => (c.security.deps.registries["https://r.example"] = "https://e.example")],
    ["security.deps.registries", (c) => (c.security.deps.registries["https://r.example"] = null)],
    ["security.deps.advisories", (c) => (c.security.deps.advisories = "")],
    ["security.deps.advisories", (c) => (c.security.deps.advisories = "https://o.example")],
    ["security.deps.advisoryRegistries", (c) => (c.security.deps.advisoryRegistries = [])],
    ["security.deps.advisoryRegistries", (c) => (c.security.deps.advisoryRegistries = ["https://registry.npmjs.org", "https://r.example"])],
    ["security.secrets.except", (c) => c.security.secrets.except.push("u/**")],
    ["security.secrets.except", (c) => (c.security.secrets.except = ["**/t/**"])],
    ["security.secrets.except", (c) => (c.security.secrets.except = ["**"])],
  ];
  for (const [key, change] of reject) assert.deepEqual(keysOf(change), [key], `${key}: ${change}`);
});

test("loosening: every key of the defaults is judged, none by the catch-all; an unlisted key counts on any change", () => {
  /** @param {Record<string, unknown>} o @param {string} at @returns {string[]} */
  const leaves = (o, at = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) && `${at}${k}` !== "security.deps.registries" ? leaves(/** @type {any} */ (v), `${at}${k}.`) : [`${at}${k}`]));
  const kinds = leaves(DEFAULTS).map((k) => [k, gateKeyKind(k)]);
  assert.deepEqual(kinds.filter(([, kind]) => kind === "any"), []);
  assert.ok(kinds.filter(([, kind]) => kind === "gate").length >= 34, "the gates' keys are listed");
  assert.equal(gateKeyKind("security.deps.newKey"), "any");
});

test("loosening: the approval line stands in the body at a line's start, and several lines count", () => {
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} review.forbidden, commitMsg.types\n${LINE} review.maxRounds\n`)], ["review.forbidden", "commitMsg.types", "review.maxRounds"]);
  assert.deepEqual([...approvedKeys(`${LINE} review.forbidden\n`)], [], "a subject is no body line");
  assert.deepEqual([...approvedKeys(`chore: x\n\n  ${LINE} review.forbidden\n> ${LINE} commitMsg.types\n`)], [], "indented or quoted");
});

const allowScripts = { security: { deps: { allowScripts: ["x"] } } };
const KEY = "security.deps.allowScripts";

test("loosening hook: a commit that loosens is refused until its message names each key, on every message", () => {
  const r = repo({ commitMsg: { types: ["feat", "fix", "chore"] } });
  r.stage({ [CONFIG]: JSON.stringify({ commitMsg: { types: ["feat", "fix", "chore"] }, ...allowScripts, security: { ...allowScripts.security, secrets: { except: ["t/**"] } } }) });
  const both = `${KEY}, security.secrets.except`;
  const refused = r.commit("chore: loosen");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`This commit loosens ${KEY.replace(/\./g, "\\.")}, security\\.secrets\\.except\\b.*${LINE}`));
  assert.match(refused.stderr, /user's call/);
  assert.equal(r.commit(`chore: loosen\n\n${LINE} ${KEY}\n`).status, 1, "one key of two");
  assert.match(r.commit(`chore: loosen\n\n${LINE} ${KEY}\n`).stderr, /This commit loosens security\.secrets\.except,/, "names what is left");
  assert.equal(r.commit(`chore: loosen\n\n${LINE} security.deps.allow\n`).status, 1, "a key it does not loosen");
  assert.equal(r.commit(`chore: loosen\n\n  ${LINE} ${both}\n`).status, 1, "indented");
  assert.equal(r.commit(`chore: loosen [commit-shape-allow: a reason long enough]\n`).status, 1, "the bypass marker loosens the shape only");
  assert.equal(r.commit("Merge the thing\n").status, 1, "a skipped subject");
  assert.equal(r.commit(`Revert "x"\n`).status, 1, "a revert by hand");
  assert.equal(r.commit(`fixup! chore: base\n\n${LINE} ${both}\n`).status, 1, "a fixup!'s message is dropped");
  assert.match(r.commit(`fixup! chore: base\n\n${LINE} ${both}\n`).stderr, /fixup! commit loosens/);
  const ok = r.commit(`amend! chore: base\n\nchore: base\n\n${LINE} ${both}\n`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(git(["log", "-1", "--format=%s"], { cwd: r.dir }).trim(), "amend! chore: base");
  // The commit after it loosens nothing, whatever line it carries.
  r.stage({ "b.txt": "1\n" });
  assert.equal(r.commit(`chore: more\n\n${LINE} ${KEY}\n`).status, 0, "a stray line refuses nothing");
});

test("loosening hook: the approval line is a structured line: no prose, and held to the structured line's limit", () => {
  const r = repo({ commitMsg: { style: "terse" } });
  r.stage({ [CONFIG]: JSON.stringify({ commitMsg: { style: "terse" }, ...allowScripts }) });
  const line = `${LINE} ${KEY}`;
  assert.match(r.commit(`chore: x\n\n${line} ${"x".repeat(300)}\n\nImpact: none\n`).stderr, /"User-Approved-Loosening:" line is \d+ characters/, "past the limit");
  const c = r.commit(`chore: x\n\n${line}\n\nImpact: none\n`);
  assert.equal(c.status, 0, c.stderr);
});

test("loosening hook: a line git will not store does not count", () => {
  const r = repo();
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  const env = { GIT_EDITOR: `sh -c 'printf "chore: x\\n\\n# ${LINE} ${KEY}\\n" > "$1"' --` };
  assert.equal(spawnSync("git", [...r.id, "commit", "-q"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, ...env } }).status, 1, "a comment line");
  const cut = { GIT_EDITOR: `sh -c 'printf "chore: x\\n# ------------------------ >8 ------------------------\\n${LINE} ${KEY}\\n" > "$1"' --` };
  git(["config", "commit.cleanup", "scissors"], { cwd: r.dir });
  assert.equal(spawnSync("git", [...r.id, "commit", "-q"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, ...cut } }).status, 1, "below the scissors");
  assert.equal(r.commit(`chore: x\n\n${LINE} ${KEY}\n`).status, 0);
});

test("loosening hook: git commit -a and git commit <path> are read as what they will commit", () => {
  const r = repo(BAN);
  put(r.dir, { [CONFIG]: JSON.stringify({}) });
  r.stage({ "src/a.js": "x\n" });
  put(r.dir, { [CONFIG]: JSON.stringify({}) });
  git(["reset", "-q", "--", CONFIG], { cwd: r.dir });
  put(r.dir, { "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: r.dir });
  const a = r.commit("feat: all", ["-a"]);
  assert.equal(a.status, 1, "-a holds the config");
  assert.match(a.stderr, /This commit loosens review\.forbidden\b/);
  const named = r.commit("feat: one", ["b.txt"]);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stderr, /in the work tree is not what this commit holds/, "<path> leaves the config out");
  assert.equal(r.held(), JSON.stringify(BAN));
});

test("loosening hook: the same effect by another way than an edit of the value", () => {
  /** @param {(r: ReturnType<typeof repo>) => void} how @param {RegExp} says @param {string} line */
  const refused = (how, says, line) => {
    const r = repo(BAN);
    r.stage({ "src/a.js": "SECRETWORD\n" });
    how(r);
    const c = r.commit("feat: probe");
    assert.equal(c.status, 1, c.stderr);
    assert.match(c.stderr, says);
    return { r, c, line };
  };
  const deleted = refused((r) => git(["rm", "-q", "-f", CONFIG], { cwd: r.dir }), /This commit loosens review\.forbidden,/, "the defaults");
  assert.doesNotMatch(deleted.c.stderr, /in the work tree/);
  assert.equal(deleted.r.commit(`feat: probe\n\n${LINE} review.forbidden\n`).status, 0, "the commit's own config is the defaults: no rule refuses it");
  refused((r) => git(["mv", CONFIG, ".ennyn/old.json"], { cwd: r.dir }), /This commit loosens review\.forbidden,/, "moved");
  refused((r) => git(["rm", "-q", "--cached", CONFIG], { cwd: r.dir }), /This commit loosens review\.forbidden,/, "out of the index only");
  for (const [text, why] of [["{ not json", /cannot parse/], [JSON.stringify({ ...BAN, nope: 1 }), /unknown key/], [JSON.stringify({ commitMsg: { subjectMax: "x" } }), /must be number/]]) {
    const broken = refused((r) => r.stage({ [CONFIG]: /** @type {string} */ (text) }), /does not load/, "stops loading");
    assert.match(broken.c.stderr, /adds "SECRETWORD"/, "HEAD's rules still run");
    assert.match(broken.c.stderr, why);
    assert.match(broken.c.stderr, /This commit loosens \.ennyn\/config\.json,/);
  }
  const linked = refused((r) => (rmSync(join(r.dir, CONFIG)), symlinkSync("{}", join(r.dir, CONFIG)), git(["add", "-A"], { cwd: r.dir })), /does not load \(symlink\)/, "a link named like a config");
  assert.match(linked.c.stderr, /adds "SECRETWORD"/);
});

test("loosening hook: a key removed so a looser default applies, and a first config, compare on merged values", () => {
  const r = repo({ commitMsg: { subjectMax: 30 } });
  r.stage({ [CONFIG]: "{}\n" });
  assert.match(r.commit("chore: drop the key").stderr, /This commit loosens commitMsg\.subjectMax,/);
  const first = repo(null);
  first.stage({ [CONFIG]: JSON.stringify({ security: { deps: { paths: [] }, ci: { paths: [] }, secrets: { except: ["**"] } } }) });
  const c = first.commit("chore: first config");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens security\.ci\.paths, security\.deps\.paths, security\.secrets\.except,/);
  const fine = repo(null);
  fine.stage({ [CONFIG]: JSON.stringify({ commitMsg: { types: ["feat", "fix", "chore"] }, review: { impactRequiredGlobs: ["src/**"] } }) });
  assert.equal(fine.commit("chore: first config").status, 0);
  // No commit at all yet.
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-empty-")));
  git(["init", "-q", "-b", "main"], { cwd: empty });
  installHook({ cwd: empty, cliPath: CLI });
  put(empty, { [CONFIG]: JSON.stringify(allowScripts) });
  git(["add", "-A"], { cwd: empty });
  const root = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "chore: start"], { cwd: empty, encoding: "utf8" });
  assert.equal(root.status, 1, root.stderr);
  assert.match(root.stderr, /This commit loosens security\.deps\.allowScripts,/);
});

test("one reading: a work tree that is broken, gone or a link sets no gate, and the commit that holds a good config passes", () => {
  const unread = /in the work tree could not be read or does not load; every check used the commit's own config/;
  const other = /in the work tree is not what this commit holds/;
  /** @type {[string, (dir: string) => void, RegExp][]} */
  const ways = [
    ["broken", (dir) => put(dir, { [CONFIG]: "{ not json" }), unread],
    ["unknown key", (dir) => put(dir, { [CONFIG]: JSON.stringify({ nope: 1 }) }), unread],
    ["gone", (dir) => rmSync(join(dir, CONFIG)), other],
    ["a link", (dir) => (rmSync(join(dir, CONFIG)), symlinkSync("/nonexistent", join(dir, CONFIG))), unread],
    ["a directory", (dir) => (rmSync(join(dir, CONFIG)), mkdirSync(join(dir, CONFIG))), unread],
  ];
  for (const [name, how, says] of ways) {
    const r = repo(BAN);
    r.stage({ "src/a.js": "SECRETWORD\n" });
    how(r.dir);
    const c = r.commit("feat: probe");
    assert.equal(c.status, 1, `${name}: ${c.stderr}`);
    assert.match(c.stderr, /adds "SECRETWORD"/, name);
    assert.match(c.stderr, says, name);
  }
  // Gone, a config that sets nothing is still not there.
  const empty = repo({});
  empty.stage({ "b.txt": "1\n" });
  rmSync(join(empty.dir, CONFIG));
  assert.match(empty.commit("feat: probe").stderr, other);
  const hidden = repo(BAN);
  hidden.stage({ "src/a.js": "SECRETWORD\n" });
  git(["update-index", "--skip-worktree", CONFIG], { cwd: hidden.dir });
  put(hidden.dir, { [CONFIG]: "{}" });
  assert.equal(git(["status", "--porcelain", "--", CONFIG], { cwd: hidden.dir }), "", "git status does not show it");
  const c = hidden.commit("feat: probe");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /in the work tree is not what this commit holds/);
  // Spacing alone is no other config.
  const spaced = repo(BAN);
  put(spaced.dir, { [CONFIG]: JSON.stringify(BAN, null, 2), "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: spaced.dir });
  const same = spaced.commit("feat: spaced");
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.stderr, "");
});

test("one reading: every key comes from the commit, the language too", () => {
  const r = repo({ commitMsg: { types: ["feat", "fix"] } });
  put(r.dir, { [CONFIG]: JSON.stringify({ language: "tr", commitMsg: { types: ["feat", "fix"] } }) });
  r.stage({ "b.txt": "1\n" });
  git(["reset", "-q", "--", CONFIG], { cwd: r.dir });
  const c = r.commit("nope");
  assert.equal(c.status, 1);
  assert.match(c.stderr, /Subject must start with a type/);
  assert.doesNotMatch(c.stderr, /Konu/);
});

test("loosening hook: a config HEAD holds that does not load is no baseline, said, and the commit that repairs it passes; neither loading lets the commit through", () => {
  const r = repo(null);
  r.stage({ [CONFIG]: "{ not json" });
  git([...r.id, "commit", "-q", "--no-verify", "-m", "chore: broken"], { cwd: r.dir });
  r.stage({ "b.txt": "1\n" });
  const both = r.commit("chore: nothing to go by");
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stderr, /the config does not load, so this commit was not checked/);
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  const fixed = r.commit("chore: repair");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stderr, /as HEAD holds it could not be read or does not load/);
  // A link in HEAD is read as no config either.
  const l = repo(null);
  symlinkSync("{}", join(l.dir, ".link"));
  mkdirSync(join(l.dir, ".ennyn"));
  symlinkSync("../base.txt", join(l.dir, CONFIG));
  git(["add", "-A"], { cwd: l.dir });
  git([...l.id, "commit", "-q", "--no-verify", "-m", "chore: link"], { cwd: l.dir });
  rmSync(join(l.dir, CONFIG));
  l.stage({ [CONFIG]: "{}" });
  const repaired = l.commit("chore: repair");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stderr, /as HEAD holds it could not be read or does not load \(symlink\)/);
});

test("one reading: ENNYN_CONFIG sets no gate where a config is tracked; where none is, it is used and said; a moved config is read from the index", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-box-")));
  put(box, { "loose.json": "{}" });
  const r = repo(BAN);
  r.stage({ "src/a.js": "SECRETWORD\n" });
  for (const named of [join(box, "loose.json"), join(box, "gone.json"), ".ennyn/loose.json"]) {
    const c = r.commit("feat: probe", [], { ENNYN_CONFIG: named });
    assert.equal(c.status, 1, c.stderr);
    assert.ok(c.stderr.includes(`ENNYN_CONFIG names ${named}; the checks used the commit's own ${CONFIG}.`), c.stderr);
    assert.doesNotMatch(c.stderr, /in the work tree/, "the work tree's config is what the commit holds");
  }
  assert.doesNotMatch(r.commit("feat: probe", [], { ENNYN_CONFIG: CONFIG }).stderr, /ENNYN_CONFIG names/, "naming the project's own says nothing");
  // Nothing tracked: the file named is the only config there is.
  const none = repo(null);
  none.stage({ "src/a.js": "SECRETWORD\n" });
  put(box, { "tight.json": JSON.stringify(BAN) });
  const tight = none.commit("feat: probe", [], { ENNYN_CONFIG: join(box, "tight.json") });
  assert.equal(tight.status, 1, tight.stderr);
  assert.match(tight.stderr, /is in no commit, so what it loosens cannot be read/);
  const absent = none.commit("feat: probe", [], { ENNYN_CONFIG: join(box, "gone.json") });
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stderr, /ENNYN_CONFIG names .*gone\.json, which is not there, and no commit holds a config, so this commit was not checked/);
  // Moved: tracked at the path named, read and compared there.
  const moved2 = repo(null);
  moved2.stage({ ".ennyn/alt.json": JSON.stringify(BAN) });
  git([...moved2.id, "commit", "-q", "--no-verify", "-m", "chore: alt"], { cwd: moved2.dir });
  const env = { ENNYN_CONFIG: ".ennyn/alt.json" };
  moved2.stage({ "b.txt": "1\n" });
  const clean = moved2.commit("feat: nothing to say", [], env);
  assert.deepEqual([clean.status, clean.stderr], [0, ""], "the work tree's copy at the path named is the commit's");
  moved2.stage({ "src/a.js": "SECRETWORD\n" });
  put(moved2.dir, { ".ennyn/alt.json": "{}" });
  git(["reset", "-q", "--", ".ennyn/alt.json"], { cwd: moved2.dir });
  const unstaged = moved2.commit("feat: probe", [], env);
  assert.equal(unstaged.status, 1, unstaged.stderr);
  assert.match(unstaged.stderr, /\.ennyn\/alt\.json in the work tree is not what this commit holds/);
  moved2.stage({ ".ennyn/alt.json": "{}" });
  assert.match(moved2.commit("feat: probe", [], env).stderr, /This commit loosens review\.forbidden,/);
});

test("one reading: a config no commit holds is used as it stands and said; with no config there is nothing to say", () => {
  const r = repo(null);
  put(r.dir, { ".gitignore": ".ennyn/\n", [CONFIG]: JSON.stringify(BAN) });
  r.stage({ "src/a.js": "SECRETWORD\n" });
  const c = r.commit("feat: probe");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /\.ennyn\/config\.json is in no commit, so what it loosens cannot be read/);
  const plain = repo(null);
  plain.stage({ "b.txt": "1\n" });
  const quiet = plain.commit("feat: nothing");
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, "");
});

/** A git that fails on the calls whose arguments hold `what`, the others passed on. @param {string} what */
function failingGit(what) {
  const bin = mkdtempSync(join(tmpdir(), "en-ls-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *"${what}"*) echo "fatal: injected" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

test("a hand run reads the same config and fails on what the hook only says", () => {
  const hand = (/** @type {string} */ dir, /** @type {NodeJS.ProcessEnv} */ env = {}) => spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const hook = (/** @type {string} */ dir, /** @type {NodeJS.ProcessEnv} */ env = {}) => spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const r = repo(BAN);
  r.stage({ "src/a.js": "SECRETWORD\n" });
  put(r.dir, { [CONFIG]: "{}", ".git/MSG": "feat: x\n" });
  git(["reset", "-q", "--", CONFIG], { cwd: r.dir });
  const run = hand(r.dir);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /adds "SECRETWORD"/);
  // HEAD's config unread: the hook says so and goes on, a hand run fails.
  const b = repo(null);
  b.stage({ [CONFIG]: "{ not json" });
  git([...b.id, "commit", "-q", "--no-verify", "-m", "chore: broken"], { cwd: b.dir });
  b.stage({ [CONFIG]: "{}" });
  put(b.dir, { ".git/MSG": "chore: x\n" });
  assert.equal(hook(b.dir).status, 0);
  assert.equal(hand(b.dir).status, 1);
  assert.match(hand(b.dir).stderr, /as HEAD holds it could not be read/);
  // A git that cannot answer: the hook says so and the gates run on the file as it stands; a hand run fails.
  const f = repo(BAN);
  f.stage({ "src/a.js": "SECRETWORD\n" });
  put(f.dir, { ".git/MSG": "feat: x\n" });
  const env = failingGit(`-- ${CONFIG}`);
  const failed = hook(f.dir, env);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /The commit's own config could not be read \(fatal: injected\); the work tree's was used, and what this commit loosens was not read\./);
  assert.match(failed.stderr, /adds "SECRETWORD"/);
  assert.equal(hand(f.dir, env).status, 1);
  assert.match(hand(f.dir, env).stderr, /injected/);
  assert.doesNotMatch(hand(f.dir, env).stderr, /could not be read \(fatal/, "git's own failure, not the hook's line");
});

test("loosening hook: a failure past the reading skips nothing, and how git cleans the message is not needed to refuse", () => {
  const r = repo();
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  put(r.dir, { ".git/MSG": "chore: x\n" });
  const env = { ...process.env, ...failingGit("--get-regexp") };
  const c = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens security\.deps\.allowScripts,/);
  assert.match(c.stderr, /this commit's message was not checked, nor its review\.forbidden lines \(fatal: injected\)/, "the message check that fell away is said");
  put(r.dir, { ".git/MSG": `chore: x\n\n${LINE} ${KEY}\n` });
  // The marker is what says this line stays: unknown, the line cannot count, and the refusal says why.
  const line = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env });
  assert.equal(line.status, 1, line.stderr);
  assert.match(line.stderr, new RegExp(`This commit loosens security\\.deps\\.allowScripts, and git's comment marker could not be read \\(fatal: injected\\), so a line ${LINE} may not be stored and counts for nothing`));
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8" }).status, 0, "git answers: the line counts");
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env }).status, 1, "by hand a git that fails stops the command");
  // No commit that loosens nothing is held to that read.
  const plain = repo();
  plain.stage({ "a.txt": "1\n" });
  put(plain.dir, { ".git/MSG": "chore: x\n" });
  assert.equal(spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: plain.dir, encoding: "utf8", env }).status, 0);
});

test("loosening hook: a merge of a branch that holds an approved loosening asks nothing: the side commit is the record", () => {
  const r = repo();
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  assert.equal(r.commit(`chore: loosen\n\n${LINE} ${KEY}\n`).status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "b.txt": "1\n" });
  assert.equal(r.commit("chore: main moves").status, 0);
  const m = spawnSync("git", [...r.id, "merge", "-q", "--no-ff", "--no-edit", "side"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(m.status, 0, m.stderr);
});

/** bypass as the closing report runs it. @param {string} dir @param {string} from @param {string[]} [extra] */
const bypass = (dir, from, extra = []) => spawnSync(process.execPath, [CLI, "bypass", "--from", from, ...extra], { cwd: dir, encoding: "utf8" });

test("bypass: each key a range loosened, with its approval line or none, read from the configs and not from the lines", () => {
  const r = repo({ commitMsg: { types: ["chore", "fix"] } });
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir }).trim();
  const cfg = (/** @type {Record<string, unknown>} */ more) => JSON.stringify({ commitMsg: { types: ["chore", "fix"] }, ...more });
  r.stage({ [CONFIG]: cfg(allowScripts) });
  assert.equal(r.commit(`chore: approved\n\n${LINE} ${KEY}\n`).status, 0);
  r.stage({ [CONFIG]: cfg({ security: { deps: { allowScripts: ["x", "y"] }, ci: { paths: [] } } }) });
  assert.equal(r.commit("chore: past the hook", ["--no-verify"]).status, 0);
  r.stage({ [CONFIG]: cfg({ security: { deps: { allowScripts: ["x", "y"] }, ci: { paths: [] } }, planner: { splitAbove: 3 } }) });
  assert.equal(r.commit("chore: neutral").status, 0);
  r.stage({ "b.txt": "1\n" });
  assert.equal(r.commit("chore: no config [commit-shape-allow: reason of some length]").status, 0);
  const out = bypass(r.dir, start);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /bypass: 1 of 4 commits used it/i);
  assert.match(out.stdout, /reason of some length/);
  const lines = out.stdout.split("\n");
  const first = lines.findIndex((l) => l.includes("chore: approved"));
  const second = lines.findIndex((l) => l.includes("chore: past the hook"));
  assert.ok(first > 0 && second > 0 && second < first, "newest first");
  assert.match(lines[first], /loosened: security\.deps\.allowScripts$/);
  assert.equal(lines[first + 1].trim(), `${LINE} ${KEY}`);
  assert.match(lines[second], /loosened: security\.ci\.paths, security\.deps\.allowScripts$/);
  assert.match(lines[second + 1], /no approval line for security\.ci\.paths, security\.deps\.allowScripts/);
  assert.doesNotMatch(out.stdout, /chore: neutral/);
  const json = JSON.parse(bypass(r.dir, start, ["--json"]).stdout);
  assert.deepEqual(json.loosened.map((/** @type {any} */ l) => [l.subject, l.keys, l.unapproved, l.lines]), [
    ["chore: past the hook", ["security.ci.paths", KEY], ["security.ci.paths", KEY], []],
    ["chore: approved", [KEY], [], [`${LINE} ${KEY}`]],
  ]);
  assert.deepEqual([json.unread, json.unmeasured], [[], []]);
});

test("bypass: a deleted config, a config that stops loading, a first config and a parent that does not load", () => {
  const r = repo(null);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir }).trim();
  const no = ["--no-verify"];
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  assert.equal(r.commit("chore: first", no).status, 0);
  git(["rm", "-q", CONFIG], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: tighter here", no).status, 0);
  git(["rm", "-q", CONFIG], { cwd: r.dir });
  assert.equal(r.commit("chore: deleted", no).status, 0);
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: back", no).status, 0);
  r.stage({ [CONFIG]: "{ not json" });
  assert.equal(r.commit("chore: broken", no).status, 0);
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: repaired", no).status, 0);
  const out = bypass(r.dir, start, ["--json"]);
  assert.equal(out.status, 1, "a commit it could not compare is no none");
  const json = JSON.parse(out.stdout);
  assert.deepEqual(json.loosened.map((/** @type {any} */ l) => [l.subject, l.keys]), [
    ["chore: broken", [CONFIG]],
    ["chore: deleted", ["review.forbidden"]],
    ["chore: first", [KEY]],
  ]);
  assert.equal(json.unread.length, 1);
  assert.match(json.unread[0].reason, /its parent's config: Invalid ennyn config|its parent's config: .*cannot parse/);
  assert.match(bypass(r.dir, start).stdout, /could not be read/);
});

test("bypass: a config outside the repository is unmeasured, not none; a shallow clone's boundary is unread; a repository with no commit says so", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-out-")));
  put(box, { "c.json": "{}" });
  const r = repo(null);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir }).trim();
  r.stage({ "b.txt": "1\n" });
  r.commit("chore: more");
  const out = spawnSync(process.execPath, [CLI, "bypass", "--from", start], { cwd: r.dir, encoding: "utf8", env: { ...process.env, ENNYN_CONFIG: join(box, "c.json") } });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Keys loosened: unmeasured, the config in use lies outside this repository/);
  assert.doesNotMatch(out.stdout, /Keys loosened: none/);
  const tight = repo({ commitMsg: { subjectMax: 30 } });
  tight.stage({ [CONFIG]: "{}" });
  tight.commit("chore: tip", ["--no-verify"]);
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-shallow-")));
  git(["clone", "-q", "--depth", "1", `file://${tight.dir}`, clone], { cwd: tight.dir });
  const shallow = spawnSync(process.execPath, [CLI, "bypass", "--json"], { cwd: clone, encoding: "utf8" });
  assert.equal(shallow.status, 1, shallow.stderr);
  assert.match(JSON.parse(shallow.stdout).unread[0].reason, /shallow/);
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "en-ls-none-")));
  git(["init", "-q", "-b", "main"], { cwd: empty });
  assert.match(spawnSync(process.execPath, [CLI, "bypass"], { cwd: empty, encoding: "utf8" }).stdout, /no commits in the range/);
});

test("one reading: an object the index names and git does not hold is said, HEAD's rules run, and a hand run fails", () => {
  const r = repo(BAN);
  r.stage({ "src/a.js": "SECRETWORD\n" });
  git(["update-index", "--cacheinfo", `100644,${"1".repeat(40)},${CONFIG}`], { cwd: r.dir });
  put(r.dir, { ".git/MSG": "feat: x\n" });
  const run = (/** @type {string[]} */ ...flags) => spawnSync(process.execPath, [CLI, "commit-check", ...flags, ".git/MSG"], { cwd: r.dir, encoding: "utf8" });
  const hook = run("--hook");
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /as this commit holds it could not be read \(notBlob\); HEAD's rules were used, and what it loosens was not read/);
  assert.match(hook.stderr, /adds "SECRETWORD"/);
  assert.doesNotMatch(hook.stderr, /This commit loosens/);
  const hand = run();
  assert.equal(hand.status, 1);
  assert.match(hand.stderr, /^ennyn commit-check: .*could not be read \(notBlob\)/m, "the command stops at what it could not read");
  // Refused by the object alone: nothing else refuses, and the hook lets it through, saying so.
  const quiet = repo();
  git(["update-index", "--cacheinfo", `100644,${"1".repeat(40)},${CONFIG}`], { cwd: quiet.dir });
  put(quiet.dir, { ".git/MSG": "feat: x\n" });
  const said = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: quiet.dir, encoding: "utf8" });
  assert.equal(said.status, 0, said.stderr);
});

test("one reading: a link or a submodule as the first config, and a link HEAD holds that the commit deletes, are read as what they are", () => {
  const r = repo(null);
  mkdirSync(join(r.dir, ".ennyn"));
  symlinkSync("{}", join(r.dir, CONFIG));
  git(["add", "-A"], { cwd: r.dir });
  const c = r.commit("chore: link");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /as this commit holds it does not load \(symlink\)/);
  const m = repo(null);
  git(["update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},${CONFIG}`], { cwd: m.dir });
  put(m.dir, { ".git/MSG": "chore: x\n" });
  const sub = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: m.dir, encoding: "utf8" });
  assert.equal(sub.status, 1, sub.stderr);
  assert.match(sub.stderr, /does not load \(submodule\)/);
  // HEAD's link, gone from the index: no baseline and nothing that loosens.
  const l = repo(null);
  mkdirSync(join(l.dir, ".ennyn"));
  symlinkSync("../base.txt", join(l.dir, CONFIG));
  git(["add", "-A"], { cwd: l.dir });
  git([...l.id, "commit", "-q", "--no-verify", "-m", "chore: link"], { cwd: l.dir });
  git(["rm", "-q", CONFIG], { cwd: l.dir });
  const gone = l.commit("chore: drop the link");
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stderr, /as HEAD holds it could not be read or does not load \(symlink\)/);
});

test("one reading: a config the commit deletes says nothing of the work tree; the secret scan's list then is the default, and a name stays exempt only where HEAD's list names it too", () => {
  const r = repo({ security: { secrets: { except: ["t/**"] } } });
  git(["rm", "-q", CONFIG], { cwd: r.dir });
  const c = r.commit("chore: drop the config");
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stderr, "");
  const n = repo({});
  const name = `t/${TOKENS.npm}.txt`;
  n.stage({ [CONFIG]: JSON.stringify({ security: { secrets: { except: ["t/**"] } } }), [name]: "x\n" });
  const added = n.commit(`chore: exempt\n\n${LINE} security.secrets.except\n`);
  assert.equal(added.status, 1, "the list the commit widens does not exempt the name it adds");
  assert.match(added.stderr, /adds what reads as a secret/);
});

test("bypass: a root commit is read against the defaults", () => {
  const r = repo(allowScripts);
  const out = spawnSync(process.execPath, [CLI, "bypass", "--json"], { cwd: r.dir, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).loosened.map((/** @type {any} */ l) => [l.subject, l.keys]), [["chore: base", [KEY]]]);
});

test("bypass: a commit a merge's first side hides, a link in history, and the dates of a range", () => {
  const r = repo();
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir }).trim();
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  assert.equal(r.commit("chore: side loosens", ["--no-verify"]).status, 0);
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: side takes it back", ["--no-verify"]).status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "b.txt": "1\n" });
  assert.equal(r.commit("chore: main moves").status, 0);
  assert.equal(spawnSync("git", [...r.id, "merge", "-q", "--no-ff", "--no-edit", "side"], { cwd: r.dir, encoding: "utf8" }).status, 0);
  const seen = JSON.parse(bypass(r.dir, start, ["--json"]).stdout);
  assert.deepEqual(seen.loosened.map((/** @type {any} */ l) => l.subject), ["chore: side loosens"]);
  assert.deepEqual(JSON.parse(bypass(r.dir, start, ["--json", "--until", "2000-01-01"]).stdout).loosened, [], "out of the dates");
  const l = repo({ commitMsg: { subjectMax: 30 } });
  const from = git(["rev-parse", "HEAD"], { cwd: l.dir }).trim();
  rmSync(join(l.dir, CONFIG));
  symlinkSync("../base.txt", join(l.dir, CONFIG));
  git(["add", "-A"], { cwd: l.dir });
  assert.equal(l.commit("chore: link", ["--no-verify"]).status, 0);
  rmSync(join(l.dir, CONFIG));
  l.stage({ [CONFIG]: "{}" });
  assert.equal(l.commit("chore: a file again", ["--no-verify"]).status, 0);
  const link = JSON.parse(bypass(l.dir, from, ["--json"]).stdout);
  assert.deepEqual(link.loosened.map((/** @type {any} */ x) => x.keys), [[CONFIG]]);
  assert.match(link.unread[0].reason, /no regular file there/);
});

/** git as a person runs it. @param {string} dir @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
const run = (dir, args, env = {}) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
/** A temporary folder under its real name. @param {string} tag */
const box = (tag) => realpathSync(mkdtempSync(join(tmpdir(), `en-ls-${tag}-`)));
const ELSEWHERE = /git is committing from a place that is not this repository's own top/;
/** The ways where git refuses to answer: nothing is known of the place. */
const UNTOLD = new Set(["a decoy whose config git cannot read", "a decoy of a format git does not know", "a .git file that is no repository"]);
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const M = ["commit", "-q", "-m", "feat: x"];
/** A folder that holds an empty repository. @param {string} [config] that repository's config file */
function decoy(config) {
  const d = box("decoy");
  git(["init", "-q"], { cwd: d });
  if (config) put(d, { ".git/config": config });
  return d;
}

test("location: a work tree apart from the git dir is refused before any gate, in one line that names no value", () => {
  /** @type {[string, (r: ReturnType<typeof repo>) => { dir?: string, args: string[], env?: NodeJS.ProcessEnv, undo?: () => void }][]} */
  const ways = [
    ["--work-tree, an empty folder", () => ({ args: [`--work-tree=${box("e")}`, ...M] })],
    ["GIT_WORK_TREE with GIT_DIR", (r) => ({ args: M, env: { GIT_DIR: join(r.dir, ".git"), GIT_WORK_TREE: box("e") } })],
    ["GIT_WORK_TREE alone", () => ({ args: M, env: { GIT_WORK_TREE: box("e") } })],
    ["GIT_DIR from a subdirectory", (r) => ({ dir: join(r.dir, "src"), args: M, env: { GIT_DIR: join(r.dir, ".git") } })],
    ["a relative GIT_DIR from a subdirectory", (r) => ({ dir: join(r.dir, "src"), args: M, env: { GIT_DIR: "../.git" } })],
    ["a decoy repository", () => ({ args: [`--work-tree=${decoy()}`, ...M] })],
    ["a decoy whose config git cannot read", () => ({ args: [`--work-tree=${decoy("[[[ not a config\n")}`, ...M] })],
    ["a decoy of a format git does not know", () => ({ args: [`--work-tree=${decoy("[core]\n\trepositoryformatversion = 99\n")}`, ...M] })],
    ["a .git file that is no repository", () => { const d = box("g"); put(d, { ".git": "garbage\n" }); return { args: [`--work-tree=${d}`, ...M] }; }],
    ["a subdirectory as the work tree", (r) => ({ args: [`--work-tree=${join(r.dir, "src")}`, ...M] })],
    ["the parent as the work tree", (r) => ({ args: [`--work-tree=${dirname(r.dir)}`, ...M] })],
    ["core.worktree", (r) => { const e = box("e"); git(["config", "core.worktree", e], { cwd: r.dir }); return { args: M, undo: () => run(r.dir, ["--git-dir=.git", "config", "--unset", "core.worktree"]) }; }],
    // git reads objects, refs and hooks from there: staged under the same variable, the commit reaches that repository's hook.
    ["GIT_COMMON_DIR of another repository", (r) => {
      const other = box("clone");
      git(["clone", "-q", `file://${r.dir}`, other], { cwd: r.dir });
      installHook({ cwd: other, cliPath: CLI });
      const env = { GIT_COMMON_DIR: join(other, ".git") };
      // From an empty index: `add` skips a file whose stat the index holds, and the object must land over there.
      assert.equal(run(r.dir, ["read-tree", "--empty"], env).status, 0);
      assert.equal(run(r.dir, ["add", "-A"], env).status, 0);
      return { args: M, env };
    }],
  ];
  for (const [name, how] of ways) {
    const r = repo(BAN);
    r.stage({ "src/a.js": "SECRETWORD\n", [CONFIG]: "{}" });
    const before = git(["rev-parse", "HEAD"], { cwd: r.dir });
    const w = how(r);
    const c = run(w.dir ?? r.dir, [...r.id, ...w.args], w.env);
    assert.equal(c.status, 1, `${name}: ${c.stderr}`);
    assert.match(c.stderr, UNTOLD.has(name) ? /commit refused: could not tell where git is committing/ : ELSEWHERE, name);
    assert.equal(c.stderr.trim().split("\n").length, 1, `${name}: ${c.stderr}`);
    assert.doesNotMatch(c.stderr, /SECRETWORD|loosens/, name);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: r.dir }), before, name);
    w.undo?.();
  }
});

test("location: a linked worktree, a submodule, a clone, a separate git dir and GIT_DIR naming the real place are checked as any commit", () => {
  /** Each place: a clean commit lands, and a forbidden line is refused by its gate, not by the rule. @param {string} name @param {string} dir @param {(args: string[]) => ReturnType<typeof spawnSync>} commit */
  const holds = (name, dir, commit) => {
    put(dir, { "src/a.js": "SECRETWORD\n" });
    git(["add", "-A"], { cwd: dir });
    const refused = commit(M);
    assert.equal(refused.status, 1, `${name}: ${refused.stderr}`);
    assert.match(String(refused.stderr), /adds "SECRETWORD"/, name);
    assert.doesNotMatch(String(refused.stderr), ELSEWHERE, name);
    put(dir, { "src/a.js": "clean\n" });
    git(["add", "-A"], { cwd: dir });
    const clean = commit(M);
    assert.equal(clean.status, 0, `${name}: ${clean.stderr}`);
  };
  const plain = repo(BAN);
  holds("plain", plain.dir, (a) => run(plain.dir, [...ID, ...a]));
  const up = repo(BAN);
  put(up.dir, { "src/a.js": "x\n" });
  git(["add", "-A"], { cwd: up.dir });
  assert.equal(up.commit("feat: src").status, 0);
  holds("a subdirectory", up.dir, (a) => run(join(up.dir, "src"), [...ID, ...a]));
  const dotGit = repo(BAN);
  holds("GIT_DIR naming the top's", dotGit.dir, (a) => run(dotGit.dir, [...ID, ...a], { GIT_DIR: ".git" }));
  const flags = repo(BAN);
  holds("both flags naming the top", flags.dir, (a) => run(flags.dir, [...ID, "--git-dir=.git", "--work-tree=.", ...a]));
  const spelled = repo(BAN);
  const link = join(box("ln"), "l");
  symlinkSync(spelled.dir, link);
  holds("GIT_DIR through a symbolic link", spelled.dir, (a) => run(spelled.dir, [...ID, ...a], { GIT_DIR: join(link, ".git") }));
  const linked = repo(BAN);
  const w = join(box("wt"), "w");
  git(["worktree", "add", "-q", "-b", "side", w], { cwd: linked.dir });
  holds("a linked worktree", w, (a) => run(w, [...ID, ...a]));
  const clone = box("clone");
  git(["clone", "-q", `file://${linked.dir}`, clone], { cwd: linked.dir });
  installHook({ cwd: clone, cliPath: CLI });
  holds("a clone", clone, (a) => run(clone, [...ID, ...a]));
  const sup = repo(BAN);
  const lib = repo(BAN);
  assert.equal(run(sup.dir, [...ID, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.dir, "lib"]).status, 0);
  assert.equal(sup.commit("chore: lib", ["--no-verify"]).status, 0);
  const sub = join(sup.dir, "lib");
  installHook({ cwd: sub, cliPath: CLI });
  holds("a submodule", sub, (a) => run(sub, [...ID, ...a]));
  const separate = repo(BAN);
  git(["init", "-q", `--separate-git-dir=${join(box("sep"), "g")}`], { cwd: separate.dir });
  holds("a separate git dir", separate.dir, (a) => run(separate.dir, [...ID, ...a]));
});

test("location: with none of git's variables set there is nothing to ask: a hand run stays as it was, in a subdirectory or outside any repository", () => {
  const r = repo(BAN);
  put(r.dir, { "src/a.js": "x\n", ".git/MSG": "feat: x\n" });
  const inside = spawnSync(process.execPath, [CLI, "commit-check", "--hook", join(r.dir, ".git", "MSG")], { cwd: join(r.dir, "src"), encoding: "utf8" });
  assert.equal(inside.status, 0, inside.stderr);
  assert.doesNotMatch(inside.stderr, ELSEWHERE);
  const none = box("none");
  put(none, { MSG: "feat: x\n" });
  const outside = spawnSync(process.execPath, [CLI, "commit-check", "--hook", "MSG"], { cwd: none, encoding: "utf8" });
  assert.equal(outside.status, 0, outside.stderr);
  assert.doesNotMatch(outside.stderr, ELSEWHERE);
});

test("location: a bare repository with a work tree of its own is refused; a git that cannot answer is said, as any git failure", () => {
  const seed = repo(BAN);
  const bare = join(box("cfg"), "cfg.git");
  git(["clone", "-q", "--bare", `file://${seed.dir}`, bare], { cwd: seed.dir });
  mkdirSync(join(bare, "hooks"), { recursive: true });
  put(bare, { "hooks/commit-msg": `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} commit-check --hook "$1"\n` });
  chmodSync(join(bare, "hooks", "commit-msg"), 0o755);
  const home = box("home");
  put(home, { "a.txt": "1\n" });
  const flags = [`--git-dir=${bare}`, `--work-tree=${home}`];
  assert.equal(run(home, [...flags, "add", "a.txt"]).status, 0);
  const c = run(home, [...ID, ...flags, ...M]);
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, ELSEWHERE);
  // git killed mid-answer tells nothing of the place: the machine's fault, said, and the hook's rule for that holds.
  const r = repo(BAN);
  const bin = box("bin");
  put(bin, { git: `#!/bin/sh\ncase "$*" in *absolute-git-dir*) kill -9 $$;; esac\nexec ${JSON.stringify(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim())} "$@"\n` });
  chmodSync(join(bin, "git"), 0o755);
  put(r.dir, { ".git/MSG": "feat: x\n" });
  const fault = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, GIT_DIR: ".git", PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(fault.status, 0, fault.stderr);
  assert.match(fault.stderr, /git failed .*killed by SIGKILL/);
  assert.doesNotMatch(fault.stderr, ELSEWHERE);
});

test("one reading: an index outside the git dir is the one git builds from: its config and its files are read", () => {
  const index = join(box("idx"), "index");
  const env = { GIT_INDEX_FILE: index };
  const r = repo(BAN);
  assert.equal(run(r.dir, ["read-tree", "HEAD"], env).status, 0);
  put(r.dir, { "src/a.js": "SECRETWORD\n" });
  assert.equal(run(r.dir, ["add", "src/a.js"], env).status, 0);
  const banned = r.commit("feat: x", [], env);
  assert.equal(banned.status, 1, banned.stderr);
  assert.match(banned.stderr, /adds "SECRETWORD"/);
  assert.doesNotMatch(banned.stderr, /could not be read/);
  put(r.dir, { [CONFIG]: "{}" });
  assert.equal(run(r.dir, ["add", CONFIG], env).status, 0);
  assert.match(r.commit("feat: x", [], env).stderr, /This commit loosens review\.forbidden,/, "the config comes from that index");
  // The main index holds a loosening, the commit does not: nothing loosens, and the commit is what that index holds.
  const main = repo(BAN);
  main.stage({ [CONFIG]: "{}" });
  const held = join(box("idx"), "index");
  assert.equal(run(main.dir, ["read-tree", "HEAD"], { GIT_INDEX_FILE: held }).status, 0);
  put(main.dir, { "b.txt": "1\n" });
  assert.equal(run(main.dir, ["add", "b.txt"], { GIT_INDEX_FILE: held }).status, 0);
  const c = main.commit("feat: x", [], { GIT_INDEX_FILE: held });
  assert.equal(c.status, 0, c.stderr);
  // A hand run is no commit: an index a leaked environment names stays out, as it was.
  const hand = repo(BAN);
  hand.stage({ "src/a.js": "SECRETWORD\n" });
  put(hand.dir, { ".git/MSG": "feat: x\n" });
  const leaked = spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: hand.dir, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: join(box("idx"), "index") } });
  assert.equal(leaked.status, 1, leaked.stderr);
  assert.match(leaked.stderr, /adds "SECRETWORD"/);
});

test("does not load: any failure to read the commit's config runs HEAD's rules and counts the whole file, a throw and a deep list too", () => {
  for (const [name, text] of [
    ["a member that cannot be a string", '{"commitMsg":{"types":[{"toString":1}]}}'],
    ["a list deeper than the stack", `{"commitMsg":{"types":${"[".repeat(200000)}${"]".repeat(200000)}}}`],
    ["a null member", '{"review":{"impactRequiredGlobs":[null,"src/**"]}}'],
  ]) {
    const r = repo(BAN);
    r.stage({ "src/a.js": "SECRETWORD\n", ".github/workflows/w.yml": WORKFLOW, [CONFIG]: text });
    const c = r.commit("feat: x");
    assert.equal(c.status, 1, `${name}: ${c.stderr}`);
    assert.match(c.stderr, /as this commit holds it does not load/, name);
    assert.match(c.stderr, /This commit loosens \.ennyn\/config\.json,/, name);
    assert.match(c.stderr, /adds "SECRETWORD"/, name);
  }
});

test("does not load: a list key holds strings, each list of the defaults, whatever the other members", () => {
  const lists = [...STRING_LISTS];
  assert.ok(lists.length >= 17, String(lists.length));
  for (const key of lists) {
    for (const bad of [null, 1, true, {}, [], { toString: 1 }]) {
      const over = key.split(".").reduceRight((/** @type {unknown} */ v, k) => ({ [k]: v }), ["ok", bad]);
      const d = box("cfg");
      put(d, { [CONFIG]: JSON.stringify(over) });
      assert.throws(() => loadConfig({ cwd: d, env: {} }), ConfigError, `${key} holding ${JSON.stringify(bad)}`);
    }
  }
});

test("every list of the defaults is a list of strings or has a checked shape of its own", () => {
  /** @param {Record<string, unknown>} o @param {string} at @returns {string[]} */
  const walk = (o, at = "") => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? [`${at}${k}`] : v && typeof v === "object" ? walk(/** @type {any} */ (v), `${at}${k}.`) : []));
  assert.deepEqual(walk(DEFAULTS).filter((k) => !STRING_LISTS.has(k)).sort(), ["impact.twins", "review.cochange", "review.forbidden"]);
});

test("the baseline is the config in force: a rename or a config planted at the default place compares with what HEAD held", () => {
  /** A project whose config lives at conf.json, with the rule. */
  const moved = () => {
    const r = repo(null);
    r.stage({ "conf.json": JSON.stringify(BAN) });
    git([...r.id, "commit", "-q", "--no-verify", "-m", "chore: conf"], { cwd: r.dir });
    return r;
  };
  const renamed = moved();
  git(["mv", "conf.json", "conf2.json"], { cwd: renamed.dir });
  renamed.stage({ "conf2.json": "{}", "src/a.js": "SECRETWORD\n" });
  const dropped = renamed.commit("feat: x", [], { ENNYN_CONFIG: "conf2.json" });
  assert.equal(dropped.status, 1, dropped.stderr);
  assert.match(dropped.stderr, /This commit loosens review\.forbidden,/);
  const kept = moved();
  git(["mv", "conf.json", "conf2.json"], { cwd: kept.dir });
  const same = kept.commit("feat: x", [], { ENNYN_CONFIG: "conf2.json" });
  assert.equal(same.status, 0, `a rename that changes nothing: ${same.stderr}`);
  const planted = moved();
  planted.stage({ [CONFIG]: "{}", "src/a.js": "SECRETWORD\n" });
  const plant = planted.commit("feat: x", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(plant.status, 1, plant.stderr);
  assert.match(plant.stderr, /This commit loosens review\.forbidden,/);
  const lines = planted.commit(`feat: x\n\n${LINE} review.forbidden\n`, [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(lines.status, 0, lines.stderr);
  // From the default place to a named one, in one commit.
  const away = repo(BAN);
  git(["mv", CONFIG, "conf.json"], { cwd: away.dir });
  away.stage({ "conf.json": "{}" });
  assert.match(away.commit("feat: x", [], { ENNYN_CONFIG: "conf.json" }).stderr, /This commit loosens review\.forbidden,/);
  // A first config, with a file gone that is no config: compared with the defaults, as ever.
  const first = repo(null);
  first.stage({ "old.json": JSON.stringify({ name: "p" }) });
  git([...first.id, "commit", "-q", "--no-verify", "-m", "chore: old"], { cwd: first.dir });
  git(["rm", "-q", "old.json"], { cwd: first.dir });
  first.stage({ [CONFIG]: JSON.stringify(BAN) });
  const c = first.commit("feat: x");
  assert.equal(c.status, 0, c.stderr);
});

test("the approval line: only keys and separators after the colon; any other word, or a carriage return, makes it count for nothing", () => {
  const key = "review.forbidden";
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key}, security.ci.paths\n`)], [key, "security.ci.paths"]);
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key},security.ci.paths\n${LINE} commitMsg.types\n`)], [key, "security.ci.paths", "commitMsg.types"]);
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} the user refused ${key}\n`)], [], "a word that is no key");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key} — the user, 2026-11-01\n`)], [], "a note");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key}\rfaked\n`)], [], "a carriage return");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key} \r\n`)], [], "a carriage return as a word of its own");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} ${key} \n`)], [], "a space that is no separator");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} .ennyn/config.json\n`, [".ennyn/config.json"])], [".ennyn/config.json"], "a path the commit loosens as a whole");
  assert.deepEqual([...approvedKeys(`chore: x\n\n${LINE} no/such/file\n`, [".ennyn/config.json"])], []);
  const r = repo(BAN);
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit(`chore: x\n\n${LINE} the user refused ${key}\n`).status, 1);
  assert.equal(r.commit(`chore: x\n\n${LINE} ${key}\n`).status, 0);
});

test("the approval line counts on the narrowest reading: below a scissors line, or on a line the comment marker of this run starts", () => {
  const r = repo();
  r.stage({ [CONFIG]: JSON.stringify(allowScripts) });
  const scissors = "# ------------------------ >8 ------------------------";
  const cut = r.commit(`chore: x\n\n${scissors}\n${LINE} ${KEY}\n`, ["--cleanup=scissors"]);
  assert.equal(cut.status, 1, "git drops it, and no command-line option reaches a hook");
  const kept = r.commit(`chore: x\n\n${scissors}\n${LINE} ${KEY}\n`);
  assert.equal(kept.status, 1, "friction: the line goes above it");
  const marker = run(r.dir, [...ID, "-c", "core.commentChar=U", "commit", "-q", "--cleanup=strip", "-m", `chore: x\n\n${LINE} ${KEY}\n`]);
  assert.equal(marker.status, 1, marker.stderr);
  assert.equal(r.commit(`chore: x\n\n${LINE} ${KEY}\n`).status, 0);
});

test("a secret in a config that does not load stays out of what the hook prints", () => {
  const token = Object.values(TOKENS).map(String).find((t) => /^gh/.test(t)) ?? String(Object.values(TOKENS)[0]);
  for (const text of [`{"${token}":1}`, `{"a":"${token}" oops}`, `{"security":{"deps":{"registries":{"https://u:${token}@r.example.invalid":null}}}}`]) {
    const r = repo(BAN);
    r.stage({ [CONFIG]: text });
    const c = r.commit("feat: x");
    assert.equal(c.status, 1, c.stderr);
    assert.ok(!c.stderr.includes(token), c.stderr);
  }
  // No version loads: the line that says so holds the same.
  const none = repo(null);
  put(none.dir, { [CONFIG]: `{"${token}":1}` });
  put(none.dir, { "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: none.dir });
  assert.ok(!none.commit("feat: x").stderr.includes(token));
});

test("loosening: no key is judged by a prefix: one in neither list counts, under any section", () => {
  for (const key of ["metrics.newKey", "paths.newKey", "graph.newKey", "impact.newKey", "planner.newKey", "sideCopy.newKey", "compaction.newKey", "conversation.newKey"]) assert.equal(gateKeyKind(key), "any", key);
});

test("the approval check stands outside the skip list: under a subject the shape check skips, a plain commit that loosens is refused without the line", () => {
  for (const subject of ["Merge x", "Revert x", "fixup! x", "squash! x", "amend! x"]) {
    const r = repo(BAN);
    r.stage({ [CONFIG]: "{}" });
    const c = r.commit(`${subject}\n`);
    assert.equal(c.status, 1, `${subject}: ${c.stderr}`);
    assert.match(c.stderr, /commit loosens review\.forbidden/, subject);
    if (subject !== "fixup! x") assert.equal(r.commit(`${subject}\n\n${LINE} review.forbidden\n`).status, 0, subject);
  }
});

test("a merge: a key is loosened when the commit is looser than every parent; a parent that holds it already asks nothing", () => {
  /** main holds a loosening approved on a side branch; `other` forked before it. */
  const r = repo(BAN);
  git(["checkout", "-q", "-b", "other"], { cwd: r.dir });
  r.stage({ "o.txt": "1\n" });
  assert.equal(r.commit("chore: other").status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify({ ...BAN, ...allowScripts }) });
  assert.equal(r.commit(`chore: open\n\n${LINE} ${KEY}\n`).status, 0);
  git(["checkout", "-q", "other"], { cwd: r.dir });
  const pull = run(r.dir, [...ID, "merge", "-q", "--no-ff", "--no-edit", "main"]);
  assert.equal(pull.status, 0, `the loosening stands in a parent: ${pull.stderr}`);
  // Looser than both: a key neither parent holds.
  const r2 = repo(BAN);
  git(["checkout", "-q", "-b", "side"], { cwd: r2.dir });
  r2.stage({ "s.txt": "1\n" });
  assert.equal(r2.commit("chore: side").status, 0);
  git(["checkout", "-q", "main"], { cwd: r2.dir });
  assert.equal(run(r2.dir, [...ID, "merge", "-q", "--no-ff", "--no-commit", "side"]).status, 0);
  r2.stage({ [CONFIG]: "{}" });
  const own = r2.commit("Merge branch side\n");
  assert.equal(own.status, 1, own.stderr);
  assert.match(own.stderr, /This commit loosens review\.forbidden,/);
  // A MERGE_HEAD anyone writes: git records that commit as a parent, and the report still lists the commit that loosened.
  const r3 = repo(BAN);
  const start = git(["rev-parse", "HEAD"], { cwd: r3.dir });
  git(["checkout", "-q", "-b", "loose"], { cwd: r3.dir });
  r3.stage({ [CONFIG]: "{}" });
  assert.equal(r3.commit("chore: loose", ["--no-verify"]).status, 0);
  const loose = git(["rev-parse", "HEAD"], { cwd: r3.dir });
  git(["checkout", "-q", "main"], { cwd: r3.dir });
  // main moves, or git, reducing the parents, would keep only the one that descends from the other.
  r3.stage({ "m.txt": "1\n" });
  assert.equal(r3.commit("chore: m").status, 0);
  r3.stage({ [CONFIG]: "{}" });
  put(r3.dir, { ".git/MERGE_HEAD": `${loose}\n` });
  const forged = r3.commit("chore: x\n");
  assert.equal(forged.status, 0, forged.stderr);
  assert.equal(git(["rev-list", "--parents", "-1", "HEAD"], { cwd: r3.dir }).split(" ").length, 3, "a parent, on record");
  const report = spawnSync(process.execPath, [CLI, "bypass", "--from", start, "--json"], { cwd: r3.dir, encoding: "utf8" });
  assert.deepEqual(JSON.parse(report.stdout).loosened.map((/** @type {{ hash: string }} */ l) => l.hash), [loose]);
});

test("a stated limit: an amend that takes back the commit's own tightening is refused, friction only: git does not tell a hook it is an amend", () => {
  const r = repo(BAN);
  r.stage({ [CONFIG]: JSON.stringify({ review: { forbidden: [...BAN.review.forbidden, { text: "OTHER", paths: ["**"] }] } }) });
  assert.equal(r.commit("chore: tighten").status, 0);
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: tighten", ["--amend"]).status, 1);
});

test("intent to add: an entry git add -N leaves is no config the commit holds", () => {
  const r = repo(null);
  put(r.dir, { [CONFIG]: JSON.stringify(BAN), "b.txt": "1\n" });
  git(["add", "-N", CONFIG], { cwd: r.dir });
  git(["add", "b.txt"], { cwd: r.dir });
  const c = r.commit("feat: x");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /is in no commit, so what it loosens cannot be read/);
  assert.doesNotMatch(c.stderr, /does not load/);
  assert.equal(git(["ls-tree", "HEAD", "--", CONFIG], { cwd: r.dir }), "");
  // Over a tracked path: the commit deletes it, as git writes the tree.
  const over = repo(BAN);
  git(["rm", "-q", "--cached", CONFIG], { cwd: over.dir });
  git(["add", "-N", CONFIG], { cwd: over.dir });
  over.stage({ "b.txt": "1\n" });
  git(["rm", "-q", "--cached", CONFIG], { cwd: over.dir });
  git(["add", "-N", CONFIG], { cwd: over.dir });
  assert.match(over.commit("feat: x").stderr, /This commit loosens review\.forbidden,/);
  // A real empty file is held, and does not load.
  const empty = repo(BAN);
  empty.stage({ [CONFIG]: "" });
  assert.match(empty.commit("feat: x").stderr, /as this commit holds it does not load/);
});

test("the secret scan goes on past one failed look at the repository: a staged token is refused wherever that call fails", () => {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = box("bin");
  put(bin, { git: `#!/bin/sh\ncase "$*" in *"rev-parse --git-dir"*)\n  n=$(cat "$CF" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$CF"\n  if [ "$n" = "$FAIL_AT" ]; then echo "fatal: boom" >&2; exit 128; fi;;\nesac\nexec ${JSON.stringify(real)} "$@"\n` });
  chmodSync(join(bin, "git"), 0o755);
  const token = Object.values(TOKENS).map(String)[0];
  for (let at = 1; at <= 6; at++) {
    const r = repo();
    r.stage({ "notes.txt": `${token}\n` });
    put(r.dir, { ".git/MSG": "chore: notes\n" });
    const c = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CF: join(box("cf"), "n"), FAIL_AT: String(at) } });
    assert.equal(c.status, 1, `fails at ${at}: ${c.stderr}`);
    assert.match(c.stderr, /notes\.txt/, `fails at ${at}`);
  }
});

/** The report as JSON and as text. @param {string} dir @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function report(dir, args, env = {}) {
  const at = (/** @type {string[]} */ more) => spawnSync(process.execPath, [CLI, "bypass", ...args, ...more], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const text = at([]);
  return { code: text.status, text: text.stdout + text.stderr, json: JSON.parse(at(["--json"]).stdout) };
}

test("bypass: a config no commit holds is unmeasured and named, exit 1, with no none beside it", () => {
  const ignored = repo(null);
  put(ignored.dir, { ".gitignore": ".ennyn/\n" });
  git(["add", ".gitignore"], { cwd: ignored.dir });
  ignored.commit("chore: ignore");
  const s1 = git(["rev-parse", "HEAD"], { cwd: ignored.dir });
  put(ignored.dir, { [CONFIG]: JSON.stringify({ security: { ci: { paths: [] } } }) });
  ignored.stage({ "a.txt": "1\n" });
  ignored.commit("chore: y");
  const a = report(ignored.dir, ["--from", s1]);
  assert.equal(a.code, 1, a.text);
  assert.match(a.text, /unmeasured, \.ennyn\/config\.json is in no commit/);
  assert.doesNotMatch(a.text, /Keys loosened: none|none of/);
  const untracked = repo(null);
  const s2 = git(["rev-parse", "HEAD"], { cwd: untracked.dir });
  put(untracked.dir, { [CONFIG]: "{}", "a.txt": "1\n" });
  git(["add", "a.txt"], { cwd: untracked.dir });
  untracked.commit("chore: y");
  assert.equal(report(untracked.dir, ["--from", s2]).code, 1);
  // No config anywhere: nothing unread, so nothing to say.
  const clean = repo(null);
  const s4 = git(["rev-parse", "HEAD"], { cwd: clean.dir });
  clean.stage({ "a.txt": "1\n" });
  clean.commit("chore: y");
  const c = report(clean.dir, ["--from", s4]);
  assert.equal(c.code, 0, c.text);
  assert.match(c.text, /Keys loosened: none/);
});

test("bypass: a config that changes path in the range is unmeasured, named, and what can be compared is compared", () => {
  const r = repo(BAN);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  git(["mv", CONFIG, "conf.json"], { cwd: r.dir });
  assert.equal(r.commit("chore: move", ["--no-verify"]).status, 0);
  r.stage({ "conf.json": "{}" });
  assert.equal(r.commit("chore: loosen", ["--no-verify"]).status, 0);
  const unset = report(r.dir, ["--from", start]);
  assert.equal(unset.code, 1, unset.text);
  assert.match(unset.text, /unmeasured from \w+ on, \.ennyn\/config\.json left its place there/);
  assert.doesNotMatch(unset.text, /Keys loosened: none/);
  const set = report(r.dir, ["--from", start], { ENNYN_CONFIG: "conf.json" });
  assert.equal(set.code, 1, set.text);
  assert.match(set.text, /moved from \.ennyn\/config\.json to conf\.json/);
  assert.match(set.text, /loosened: review\.forbidden/);
});

test("bypass: its marker, skip list and language come from the commit at the range's end, never the work tree", () => {
  const r = repo({ commitMsg: { allowMarker: "[own-marker:" } });
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.stage({ "a.txt": "1\n" });
  assert.equal(r.commit("feat: y\n\n[own-marker: a reason long enough to count]", ["--no-verify"]).status, 0);
  const control = report(r.dir, ["--from", start]);
  assert.equal(control.json.uses.length, 1, control.text);
  put(r.dir, { [CONFIG]: JSON.stringify({ language: "tr", commitMsg: { allowMarker: "[nothing-here:", skipSubjects: [".*"] } }) });
  const edited = report(r.dir, ["--from", start]);
  assert.equal(edited.json.uses.length, 1, edited.text);
  assert.match(edited.text, /Commit-shape bypass: 1 of 1 commits/);
  put(r.dir, { [CONFIG]: "{ broken" });
  const broken = report(r.dir, ["--from", start]);
  assert.equal(broken.code, 0, broken.text);
  // The end's config does not load: unread, named, and no count stands on a marker it does not know.
  r.stage({ [CONFIG]: "{ broken" });
  assert.equal(r.commit("chore: broke", ["--no-verify"]).status, 0);
  const end = report(r.dir, ["--from", start]);
  assert.equal(end.code, 1, end.text);
  assert.doesNotMatch(end.text, /none of|Keys loosened: none/);
});

test("bypass: replace refs are off, as in the hook", () => {
  const r = repo(BAN);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.stage({ "a.txt": "1\n" });
  assert.equal(r.commit("chore: clean twin").status, 0);
  const clean = git(["rev-parse", "HEAD"], { cwd: r.dir });
  git(["reset", "-q", "--hard", start], { cwd: r.dir });
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: x", ["--no-verify"]).status, 0);
  const bad = git(["rev-parse", "HEAD"], { cwd: r.dir });
  git(["replace", bad, clean], { cwd: r.dir });
  assert.match(report(r.dir, ["--from", start]).text, /loosened: review\.forbidden/);
});

test("bypass: no none beside a commit it could not read; a range of one skipped merge still lists its keys; a merge reads as the hook reads it", () => {
  const r = repo(BAN);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.stage({ [CONFIG]: "{ broken" });
  r.commit("chore: broke", ["--no-verify"]);
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  r.commit("chore: repair", ["--no-verify"]);
  const unread = report(r.dir, ["--from", start]);
  assert.equal(unread.code, 1, unread.text);
  assert.match(unread.text, /could not be read/);
  assert.doesNotMatch(unread.text, /Keys loosened: none/);
  const only = repo(BAN);
  git(["checkout", "-q", "-b", "f"], { cwd: only.dir });
  only.stage({ "f.txt": "1\n" });
  only.commit("chore: f");
  git(["checkout", "-q", "main"], { cwd: only.dir });
  assert.equal(run(only.dir, [...ID, "merge", "-q", "--no-ff", "--no-commit", "f"]).status, 0);
  const from = git(["rev-parse", "f"], { cwd: only.dir });
  only.stage({ [CONFIG]: "{}" });
  only.commit("Merge branch 'f'", ["--no-verify"]);
  const merge = report(only.dir, ["--from", from]);
  assert.equal(merge.json.loosened.length, 1, merge.text);
  assert.match(merge.text, /loosened: review\.forbidden/);
  assert.match(merge.text, /Keys loosened: in 1 of 1 commits/, "a commit the count skips is still one of them");
  // A merge of a commit that holds the approved loosening: the side commit is the record, the merge asks nothing.
  const side = repo(BAN);
  const s = git(["rev-parse", "HEAD"], { cwd: side.dir });
  git(["checkout", "-q", "-b", "open"], { cwd: side.dir });
  side.stage({ [CONFIG]: "{}" });
  assert.equal(side.commit(`chore: open\n\n${LINE} review.forbidden\n`).status, 0);
  const open = git(["rev-parse", "HEAD"], { cwd: side.dir });
  git(["checkout", "-q", "main"], { cwd: side.dir });
  side.stage({ "m.txt": "1\n" });
  assert.equal(side.commit("chore: m").status, 0);
  assert.equal(run(side.dir, [...ID, "merge", "-q", "--no-ff", "--no-edit", "open"]).status, 0);
  assert.deepEqual(report(side.dir, ["--from", s]).json.loosened.map((/** @type {{ hash: string }} */ l) => l.hash), [open]);
});

test("bypass: why a commit went unread follows the language key", () => {
  const r = repo({ language: "tr" });
  r.stage({ [CONFIG]: JSON.stringify({ language: "tr" }) + " " });
  r.commit("chore: y");
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.stage({ [CONFIG]: "{ broken" });
  r.commit("chore: broke", ["--no-verify"]);
  r.stage({ [CONFIG]: JSON.stringify({ language: "tr" }) });
  r.commit("chore: repair", ["--no-verify"]);
  const text = report(r.dir, ["--from", start]).text;
  assert.match(text, /üst commit'inin ayarı/, text);
});

test("a failed read of the staged names says what ran: loosening and the secret scan read apart from it", () => {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = box("bin");
  put(bin, { git: `#!/bin/sh\ncase "$*" in *"--name-status"*) echo "fatal: boom" >&2; exit 128;; esac\nexec ${JSON.stringify(real)} "$@"\n` });
  chmodSync(join(bin, "git"), 0o755);
  const r = repo(BAN);
  const token = Object.values(TOKENS).map(String)[0];
  r.stage({ [CONFIG]: "{}", "notes.txt": `${token}\n` });
  put(r.dir, { ".git/MSG": "feat: x\n" });
  const c = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: r.dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /Staged paths could not be read \(.*boom.*\): the impact-line, review\.forbidden, security\.ci and security\.deps checks had nothing to read/);
  assert.match(c.stderr, /This commit loosens review\.forbidden,/);
  assert.match(c.stderr, /notes\.txt/);
});

test("a merge that keeps one parent's config whole drops what only the other held: the hook asks nothing, and the report lists that merge", () => {
  const r = repo(BAN);
  git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
  r.stage({ "s.txt": "1\n" });
  assert.equal(r.commit("chore: side").status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify({ review: { forbidden: [...BAN.review.forbidden, { text: "OTHER", paths: ["**"] }] } }) });
  assert.equal(r.commit("chore: tighten").status, 0);
  const start = git(["rev-parse", "HEAD"], { cwd: r.dir });
  assert.equal(run(r.dir, [...ID, "merge", "-q", "--no-ff", "--no-commit", "side"]).status, 0);
  git(["checkout", "side", "--", CONFIG], { cwd: r.dir });
  const c = r.commit("Merge branch side\n");
  assert.equal(c.status, 0, c.stderr);
  const out = report(r.dir, ["--from", start]);
  assert.deepEqual(out.json.loosened.map((/** @type {{ subject: string, keys: string[], unapproved: string[] }} */ l) => [l.subject, l.keys, l.unapproved]), [["Merge branch side", ["review.forbidden"], ["review.forbidden"]]], out.text);
  assert.match(out.text, /no approval line for review\.forbidden/);
});

test("does not load: any throw, not only a ConfigError, is a config that does not load, its text masked", () => {
  const token = Object.values(TOKENS).map(String).find((t) => /^gh/.test(t)) ?? String(Object.values(TOKENS)[0]);
  const bytes = /** @type {any} */ ({ toString() { throw new TypeError(`no text: ${token}\nsecond line`); } });
  const out = loaded(bytes, box("cfg"), "c.json");
  assert.equal(out.cfg, undefined);
  assert.ok(String(out.error).startsWith("no text: "), String(out.error));
  assert.ok(!String(out.error).includes(token), String(out.error));
  assert.ok(!String(out.error).includes("\n"), "one line");
});

test("does not load: a throw that is no ConfigError refuses at the hook, where passing would pass every later commit unread", () => {
  // Nothing tracked, and the file named cannot be read: the one config there is. A directory reads as a failure, no verdict on a config.
  const r = repo(null);
  r.stage({ "b.txt": "1\n" });
  const named = box("named");
  const c = r.commit("feat: x", [], { ENNYN_CONFIG: named });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /commit refused: .* could not be read/);
  // A broken file is a verdict: no version loads, and the commit that repairs it must not be locked out.
  const broken = repo(null);
  put(broken.dir, { [CONFIG]: "{ broken", "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: broken.dir });
  const passes = broken.commit("feat: x");
  assert.equal(passes.status, 0, passes.stderr);
  assert.match(passes.stderr, /the config does not load/);
});

test("a merge of more than two: a parent that holds the key takes it off, whatever the others hold", () => {
  const r = repo(BAN);
  for (const [name, files] of /** @type {[string, Record<string, string>][]} */ ([["holds", { [CONFIG]: "{}" }], ["other", { "o.txt": "1\n" }]])) {
    git(["checkout", "-q", "-b", name, "main"], { cwd: r.dir });
    r.stage(files);
    assert.equal(r.commit(`chore: ${name}`, ["--no-verify"]).status, 0);
  }
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "m.txt": "1\n" });
  assert.equal(r.commit("chore: m").status, 0);
  const m = run(r.dir, [...ID, "merge", "-q", "--no-ff", "--no-edit", "holds", "other"]);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(git(["rev-list", "--parents", "-1", "HEAD"], { cwd: r.dir }).split(" ").length, 4, "three parents");
});

test("a merge: a parent that does not load, or a MERGE_HEAD that cannot be read, takes no key off", () => {
  const r = repo(BAN);
  git(["checkout", "-q", "-b", "broken"], { cwd: r.dir });
  r.stage({ [CONFIG]: "{ broken" });
  assert.equal(r.commit("chore: broke", ["--no-verify"]).status, 0);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "m.txt": "1\n" });
  assert.equal(r.commit("chore: m").status, 0);
  assert.equal(run(r.dir, [...ID, "merge", "-q", "-s", "ours", "--no-ff", "--no-commit", "broken"]).status, 0);
  r.stage({ [CONFIG]: "{}" });
  const c = r.commit("Merge branch broken\n");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens review\.forbidden,/);
  const hand = repo(BAN);
  hand.stage({ [CONFIG]: "{}" });
  put(hand.dir, { ".git/MERGE_HEAD": "not a commit\n", ".git/MSG": "chore: x\n" });
  const h = spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: hand.dir, encoding: "utf8" });
  assert.equal(h.status, 1, h.stderr);
  assert.match(h.stderr, /This commit loosens review\.forbidden,/);
});

test("the baseline: every deleted file that loads as a config counts; a file the commit only changes is no rename", () => {
  const two = repo(null);
  two.stage({ "a.json": "{}", "b.json": JSON.stringify(BAN) });
  git([...two.id, "commit", "-q", "--no-verify", "-m", "chore: two"], { cwd: two.dir });
  git(["rm", "-q", "a.json", "b.json"], { cwd: two.dir });
  two.stage({ "conf.json": "{}" });
  const c = two.commit("feat: x", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens review\.forbidden,/);
  // sample.json loads as a config, and stays: the first config compares with the defaults.
  const kept = repo(null);
  kept.stage({ "sample.json": JSON.stringify(BAN) });
  git([...kept.id, "commit", "-q", "--no-verify", "-m", "chore: sample"], { cwd: kept.dir });
  kept.stage({ "sample.json": "{}", [CONFIG]: "{}" });
  const first = kept.commit("feat: x");
  assert.equal(first.status, 0, first.stderr);
});

test("intent to add: an empty config HEAD already holds is the commit's, not a deletion", () => {
  const r = repo(null);
  r.stage({ [CONFIG]: "" });
  git([...r.id, "commit", "-q", "--no-verify", "-m", "chore: empty"], { cwd: r.dir });
  r.stage({ "b.txt": "1\n" });
  const c = r.commit("feat: x");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /does not load, here or in HEAD/);
});

test("does not load: a commit that means it lands by naming the file, since no key says what a broken config loosens", () => {
  const r = repo(BAN);
  r.stage({ [CONFIG]: "{ broken" });
  const refused = r.commit("chore: x");
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /This commit loosens \.ennyn\/config\.json,/);
  assert.equal(r.commit(`chore: x\n\n${LINE} review.forbidden\n`).status, 1, "a key is no name for the whole file");
  const named = r.commit(`chore: x\n\n${LINE} ${CONFIG}\n`);
  assert.equal(named.status, 0, named.stderr);
});

/** A project whose first commit holds no config and whose second brings the rule, as a project grows. */
function grown() {
  const r = repo(null);
  const root = git(["rev-parse", "HEAD"], { cwd: r.dir });
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: rules", ["--no-verify"]).status, 0);
  return { ...r, root };
}
/** @param {{ dir: string }} r */
const headOf = (r) => git(["rev-parse", "HEAD"], { cwd: r.dir });
/** A `git` first on PATH that stops the calls `match` names, in the words git would use. @param {string} match a shell pattern @param {string} words */
function failing(match, words) {
  const bin = box("bin");
  put(bin, { git: `#!/bin/sh\ncase "$*" in ${match}) echo ${JSON.stringify(words)} >&2; exit 128;; esac\nexec ${JSON.stringify(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim())} "$@"\n` });
  chmodSync(join(bin, "git"), 0o755);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}
/** commit-check as the hook runs it, by hand, so a wrapper on PATH reaches it. @param {string} dir @param {NodeJS.ProcessEnv} [env] */
function handHook(dir, env = {}) {
  put(dir, { ".git/MSG": "chore: x\n" });
  return spawnSync(process.execPath, [CLI, "commit-check", "--hook", ".git/MSG"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

test("a merge: a name in MERGE_HEAD takes a key off only as a commit that is no ancestor of HEAD, whatever MERGE_MODE says", () => {
  /** @type {[string, (r: ReturnType<typeof grown>) => string, (r: ReturnType<typeof grown>) => void][]} */
  const ways = [
    ["the root, which holds no config", (r) => r.root, (r) => r.stage({ [CONFIG]: "{}" })],
    ["HEAD itself", (r) => headOf(r), (r) => r.stage({ [CONFIG]: "{}" })],
    ["the root, the config deleted", (r) => r.root, (r) => void git(["rm", "-q", CONFIG], { cwd: r.dir })],
  ];
  for (const mode of [null, "no-ff"]) {
    for (const [name, pick, change] of ways) {
      const r = grown();
      const before = headOf(r);
      const named = pick(r);
      change(r);
      put(r.dir, { ".git/MERGE_HEAD": `${named}\n`, ...(mode ? { ".git/MERGE_MODE": mode } : {}) });
      const c = r.commit("chore: x\n");
      assert.equal(c.status, 1, `${name}, ${mode}: ${c.stderr}`);
      assert.match(c.stderr, /This commit loosens review\.forbidden,/, `${name}, ${mode}`);
      assert.equal(headOf(r), before, `${name}, ${mode}`);
    }
  }
  // A loosening taken back: the commit that held it cannot bring it back, and an approval of then is no approval of now.
  const back = repo(BAN);
  back.stage({ [CONFIG]: "{}" });
  assert.equal(back.commit(`chore: open\n\n${LINE} review.forbidden\n`).status, 0);
  const held = headOf(back);
  back.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(back.commit("chore: taken back").status, 0);
  back.stage({ [CONFIG]: "{}" });
  put(back.dir, { ".git/MERGE_HEAD": `${held}\n`, ".git/MERGE_MODE": "no-ff" });
  const again = back.commit("chore: x\n");
  assert.equal(again.status, 1, again.stderr);
  // The control: the same loosening in a commit that is no ancestor, by `git merge` and by a side that descends from HEAD.
  for (const flags of [["--no-ff"], []]) {
    const side = grown();
    git(["checkout", "-q", "-b", "open"], { cwd: side.dir });
    side.stage({ [CONFIG]: "{}" });
    assert.equal(side.commit(`chore: open\n\n${LINE} review.forbidden\n`).status, 0);
    git(["checkout", "-q", "main"], { cwd: side.dir });
    if (!flags.length) {
      side.stage({ "m.txt": "1\n" });
      assert.equal(side.commit("chore: m").status, 0);
    }
    const m = run(side.dir, [...ID, "merge", "-q", ...flags, "--no-edit", "open"]);
    assert.equal(m.status, 0, m.stderr);
  }
});

test("a merge: an ancestry question that fails takes no key off", () => {
  const r = repo(BAN);
  git(["checkout", "-q", "-b", "open"], { cwd: r.dir });
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: open", ["--no-verify"]).status, 0);
  const open = headOf(r);
  git(["checkout", "-q", "main"], { cwd: r.dir });
  r.stage({ "m.txt": "1\n" });
  assert.equal(r.commit("chore: m").status, 0);
  r.stage({ [CONFIG]: "{}" });
  put(r.dir, { ".git/MERGE_HEAD": `${open}\n` });
  assert.equal(handHook(r.dir).status, 0, "the control: a parent git keeps");
  const c = handHook(r.dir, failing("*merge-base*", "fatal: stopped"));
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens review\.forbidden,/);
});

test("bypass: a merge is compared by value: a key stays off it only at the value of a parent that brought a listed commit", () => {
  const LIST = "security.deps.allow";
  const list = (/** @type {string[]} */ allow) => JSON.stringify({ ...BAN, security: { deps: { allow } } });
  /** Main holds an approved loosening, then a side forks and both move: `merge` writes the config of the merge, past the hook. */
  const merged = (/** @type {string} */ config) => {
    const r = repo(BAN);
    const start = headOf(r);
    r.stage({ [CONFIG]: list(["a@1.0.0"]) });
    assert.equal(r.commit(`chore: allow a\n\n${LINE} ${LIST}\n`).status, 0);
    git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
    r.stage({ "s.txt": "1\n" });
    assert.equal(r.commit("chore: side").status, 0);
    git(["checkout", "-q", "main"], { cwd: r.dir });
    r.stage({ "m.txt": "1\n" });
    assert.equal(r.commit("chore: m").status, 0);
    assert.equal(run(r.dir, [...ID, "merge", "-q", "--no-commit", "--no-ff", "side"]).status, 0);
    r.stage({ [CONFIG]: config });
    assert.equal(r.commit("chore: merge side", ["--no-verify"]).status, 0);
    return { r, start };
  };
  const other = merged(list(["a@1.0.0", "evil@6.6.6"]));
  const out = report(other.r.dir, ["--from", other.start]);
  assert.deepEqual(out.json.loosened.find((/** @type {{ hash: string }} */ l) => l.hash === headOf(other.r))?.keys, [LIST], out.text);
  // A number further than the approved one, the same.
  const max = (/** @type {number} */ n) => JSON.stringify({ ...BAN, commitMsg: { subjectMax: n } });
  const further = repo(JSON.parse(max(50)));
  const from = headOf(further);
  further.stage({ [CONFIG]: max(60) });
  assert.equal(further.commit(`chore: up\n\n${LINE} commitMsg.subjectMax\n`).status, 0);
  git(["checkout", "-q", "-b", "g"], { cwd: further.dir });
  further.stage({ "g.txt": "1\n" });
  assert.equal(further.commit("chore: g").status, 0);
  git(["checkout", "-q", "main"], { cwd: further.dir });
  further.stage({ "m.txt": "1\n" });
  assert.equal(further.commit("chore: m").status, 0);
  assert.equal(run(further.dir, [...ID, "merge", "-q", "--no-commit", "--no-ff", "g"]).status, 0);
  further.stage({ [CONFIG]: max(70) });
  assert.equal(further.commit("chore: merge g", ["--no-verify"]).status, 0);
  assert.equal(report(further.dir, ["--from", from]).json.loosened.length, 2);
  // Past the hook, a commit that held the key before it was taken back: the parent brings nothing, so nothing covers the merge.
  const back = repo(BAN);
  const s = headOf(back);
  back.stage({ [CONFIG]: "{}" });
  assert.equal(back.commit(`chore: open\n\n${LINE} review.forbidden\n`).status, 0);
  const held = headOf(back);
  back.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(back.commit("chore: taken back").status, 0);
  back.stage({ [CONFIG]: "{}" });
  put(back.dir, { ".git/MERGE_HEAD": `${held}\n`, ".git/MERGE_MODE": "no-ff" });
  assert.equal(back.commit("chore: x\n", ["--no-verify"]).status, 0);
  assert.equal(git(["rev-list", "--parents", "-1", "HEAD"], { cwd: back.dir }).split(" ").length, 3, "git keeps the parent under no-ff");
  const loosened = report(back.dir, ["--from", s]).json.loosened;
  assert.equal(loosened.length, 2, JSON.stringify(loosened));
  assert.ok(loosened.some((/** @type {{ hash: string, unapproved: string[] }} */ l) => l.hash === headOf(back) && l.unapproved[0] === "review.forbidden"));
  // A list held by a parent in another order is the same value, and the side commit is the record.
  const order = repo(BAN);
  const o = headOf(order);
  git(["checkout", "-q", "-b", "open"], { cwd: order.dir });
  order.stage({ [CONFIG]: list(["a@1.0.0", "b@1.0.0"]) });
  assert.equal(order.commit(`chore: open\n\n${LINE} ${LIST}\n`).status, 0);
  const open = headOf(order);
  git(["checkout", "-q", "main"], { cwd: order.dir });
  order.stage({ "m.txt": "1\n" });
  assert.equal(order.commit("chore: m").status, 0);
  assert.equal(run(order.dir, [...ID, "merge", "-q", "--no-commit", "--no-ff", "open"]).status, 0);
  order.stage({ [CONFIG]: list(["b@1.0.0", "a@1.0.0"]) });
  assert.equal(order.commit("chore: merge open", ["--no-verify"]).status, 0);
  assert.deepEqual(report(order.dir, ["--from", o]).json.loosened.map((/** @type {{ hash: string }} */ l) => l.hash), [open]);
  // The value a parent holds, with the commit that loosened it outside the range: no record, so the merge is listed.
  assert.deepEqual(report(order.dir, ["--from", open]).json.loosened.map((/** @type {{ hash: string }} */ l) => l.hash), [headOf(order)]);
  /** A side holds an approved list, main moves or tightens: the merge, past the hook, writes `config`. */
  const sideMerged = (/** @type {Record<string, string>} */ onMain, /** @type {string} */ config) => {
    const r = repo(BAN);
    const start = headOf(r);
    git(["checkout", "-q", "-b", "open"], { cwd: r.dir });
    r.stage({ [CONFIG]: list(["a@1.0.0"]) });
    assert.equal(r.commit(`chore: open\n\n${LINE} ${LIST}\n`).status, 0);
    git(["checkout", "-q", "main"], { cwd: r.dir });
    r.stage(onMain);
    assert.equal(r.commit("chore: m").status, 0);
    run(r.dir, [...ID, "merge", "-q", "--no-commit", "--no-ff", "open"]);
    r.stage({ [CONFIG]: config });
    assert.equal(r.commit("chore: merge open", ["--no-verify"]).status, 0);
    return report(r.dir, ["--from", start]).json.loosened.find((/** @type {{ hash: string }} */ l) => l.hash === headOf(r))?.keys;
  };
  assert.deepEqual(sideMerged({ "m.txt": "1\n" }, list(["a@1.0.0", "evil@6.6.6"])), [LIST], "a value past what the side brought is the merge's own");
  // The side commit lists another key: it covers that one, and the tightening main held and the merge dropped stays the merge's.
  assert.deepEqual(sideMerged({ [CONFIG]: max(50) }, list(["a@1.0.0"])), ["commitMsg.subjectMax"]);
});

test("the baseline is never better than the defaults: a deleted file that loads as a config adds to it", () => {
  const OFF = JSON.stringify({ security: { ci: { paths: [] } } });
  const held = (/** @type {string} */ text) => {
    const r = repo(null);
    r.stage({ "d.json": text });
    assert.equal(r.commit("chore: a data file", ["--no-verify"]).status, 0);
    return r;
  };
  // A first config, with a decoy of the same text gone in the same commit.
  const decoyed = held(OFF);
  git(["rm", "-q", "d.json"], { cwd: decoyed.dir });
  decoyed.stage({ [CONFIG]: OFF, ".github/workflows/x.yml": WORKFLOW });
  const c = decoyed.commit("feat: x");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens security\.ci\.paths,/);
  const mv = held(OFF);
  mkdirSync(join(mv.dir, ".ennyn"), { recursive: true });
  git(["mv", "d.json", CONFIG], { cwd: mv.dir });
  mv.stage({ ".github/workflows/x.yml": WORKFLOW });
  assert.match(mv.commit("feat: x").stderr, /This commit loosens security\.ci\.paths,/);
  // Looser than that file though not than the defaults still counts, the rename above all.
  const looser = held(JSON.stringify(BAN));
  git(["mv", "d.json", "e.json"], { cwd: looser.dir });
  looser.stage({ "e.json": "{}" });
  assert.match(looser.commit("feat: x", [], { ENNYN_CONFIG: "e.json" }).stderr, /This commit loosens review\.forbidden,/);
  // The friction it costs: a config looser than the defaults, only renamed, needs the line. The list its name was exempt under stands.
  const moved = held(OFF);
  git(["mv", "d.json", "e.json"], { cwd: moved.dir });
  const plain = moved.commit("feat: x", [], { ENNYN_CONFIG: "e.json" });
  assert.equal(plain.status, 1, plain.stderr);
  assert.equal(moved.commit(`feat: x\n\n${LINE} security.ci.paths\n`, [], { ENNYN_CONFIG: "e.json" }).status, 0);
  const named = held(JSON.stringify({ security: { secrets: { except: ["k/**"] } } }));
  git(["mv", "d.json", "e.json"], { cwd: named.dir });
  named.stage({ [`k/${TOKENS.npm}.txt`]: "x\n" });
  const n = named.commit(`feat: x\n\n${LINE} security.secrets.except\n`, [], { ENNYN_CONFIG: "e.json" });
  assert.equal(n.status, 0, n.stderr);
  // A name exempt under the new list alone stays refused: the list the renamed file held is the one that counts.
  const wider = held(JSON.stringify({ security: { secrets: { except: ["k/**"] } } }));
  git(["mv", "d.json", "e.json"], { cwd: wider.dir });
  wider.stage({ "e.json": JSON.stringify({ security: { secrets: { except: ["k/**", "j/**"] } } }), [`j/${TOKENS.npm}.txt`]: "x\n" });
  const w = wider.commit(`feat: x\n\n${LINE} security.secrets.except\n`, [], { ENNYN_CONFIG: "e.json" });
  assert.equal(w.status, 1, w.stderr);
  assert.match(w.stderr, /adds what reads as a secret/);
});

test("bypass shares the hook's reading: with a config tracked at its place the variable is left out", () => {
  for (const named of ["o/c.json", join(box("out"), "c.json"), "README.md"]) {
    const r = repo(BAN);
    const start = headOf(r);
    put(r.dir, { "o/c.json": "{}", "README.md": "x\n" });
    r.stage({ [CONFIG]: "{}" });
    assert.equal(r.commit("chore: x", ["--no-verify"]).status, 0);
    const out = report(r.dir, ["--from", start], { ENNYN_CONFIG: named });
    assert.equal(out.code, 0, out.text);
    assert.doesNotMatch(out.text, /unmeasured/, named);
    assert.match(out.text, /loosened: review\.forbidden/, named);
  }
  // Nothing at the default place: the variable decides, and exit 1 stands for what no commit holds.
  const none = repo(null);
  const s = headOf(none);
  put(none.dir, { "o/c.json": "{}" });
  const out = report(none.dir, ["--from", s], { ENNYN_CONFIG: "o/c.json" });
  assert.equal(out.code, 1, out.text);
  assert.match(out.text, /unmeasured, o\/c\.json is in no commit/);
  assert.doesNotMatch(out.text, /Keys loosened: none/);
  // A link with nothing behind it is there for the hook, which refuses over it, so it is there for the report.
  const dangling = repo(null);
  const d = headOf(dangling);
  mkdirSync(join(dangling.dir, ".ennyn"));
  symlinkSync("/nonexistent/x", join(dangling.dir, CONFIG));
  const link = report(dangling.dir, ["--from", d]);
  assert.equal(link.code, 1, link.text);
  assert.match(link.text, /unmeasured, \.ennyn\/config\.json is in no commit/);
});

test("bypass: a rename the hook would refuse is no none: unmeasured, named, exit 1", () => {
  /** A project whose config lives at conf.json, renamed to conf2.json past the hook, holding `text`. */
  const renamed = (/** @type {string} */ text) => {
    const r = repo(null);
    r.stage({ "conf.json": JSON.stringify(BAN) });
    assert.equal(r.commit("chore: conf", ["--no-verify"]).status, 0);
    const start = headOf(r);
    git(["mv", "conf.json", "conf2.json"], { cwd: r.dir });
    r.stage({ "conf2.json": text });
    assert.equal(r.commit("chore: rename", ["--no-verify"]).status, 0);
    return { r, start };
  };
  const loose = renamed("{}");
  const out = report(loose.r.dir, ["--from", loose.start], { ENNYN_CONFIG: "conf2.json" });
  assert.equal(out.code, 1, out.text);
  assert.match(out.text, /moved from conf\.json to conf2\.json/);
  assert.doesNotMatch(out.text, /Keys loosened: none/);
  // The same bytes moved: the hook asks nothing, and neither does the report.
  const same = renamed(JSON.stringify(BAN));
  const kept = report(same.r.dir, ["--from", same.start], { ENNYN_CONFIG: "conf2.json" });
  assert.equal(kept.code, 0, kept.text);
  assert.doesNotMatch(kept.text, /unmeasured/);
  // A file the commit only changes is no rename: it stays where it was.
  const kept2 = repo(null);
  kept2.stage({ "sample.json": JSON.stringify(BAN) });
  assert.equal(kept2.commit("chore: sample", ["--no-verify"]).status, 0);
  const at = headOf(kept2);
  kept2.stage({ "sample.json": "{}", [CONFIG]: "{}" });
  assert.equal(kept2.commit("chore: y", ["--no-verify"]).status, 0);
  assert.equal(report(kept2.dir, ["--from", at]).code, 0);
  // A file that only looks like one is not read as the config it is not: it does not load.
  const first = repo(null);
  first.stage({ "old.json": JSON.stringify({ name: "p" }) });
  assert.equal(first.commit("chore: old", ["--no-verify"]).status, 0);
  const from = headOf(first);
  git(["rm", "-q", "old.json"], { cwd: first.dir });
  first.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(first.commit("chore: x", ["--no-verify"]).status, 0);
  assert.equal(report(first.dir, ["--from", from]).code, 0);
});

test("a config no commit holds and git cannot read: a refusal says refused, the file and the way out; what passes says it went unchecked", () => {
  const untracked = (/** @type {(dir: string) => void} */ make) => {
    const r = repo(null);
    put(r.dir, { ".gitignore": ".ennyn/\n" });
    r.stage({ "a.txt": "1\n" });
    make(r.dir);
    return r;
  };
  /** @type {[string, (dir: string) => void][]} */
  const ways = [
    ["a directory", (dir) => void mkdirSync(join(dir, CONFIG), { recursive: true })],
    ["a link", (dir) => { mkdirSync(join(dir, ".ennyn")); symlinkSync("../base.txt", join(dir, CONFIG)); }],
  ];
  for (const [name, make] of ways) {
    const r = untracked(make);
    const c = r.commit("chore: y");
    assert.equal(c.status, 1, `${name}: ${c.stderr}`);
    assert.match(c.stderr, /commit refused/, name);
    assert.match(c.stderr, /\.ennyn\/config\.json/, name);
    assert.match(c.stderr, /repair or remove it/, name);
    assert.match(c.stderr, /ennyn doctor/, name);
    assert.doesNotMatch(c.stderr, /was not checked|in this commit/, name);
  }
  const named = repo(null);
  named.stage({ "b.txt": "1\n" });
  const dir = box("named");
  const c = named.commit("feat: x", [], { ENNYN_CONFIG: dir });
  assert.equal(c.status, 1, c.stderr);
  assert.ok(c.stderr.includes(`commit refused: ${dir} is there`), c.stderr);
  const broken = repo(null);
  put(broken.dir, { [CONFIG]: "{ broken", "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: broken.dir });
  const passes = broken.commit("feat: x");
  assert.equal(passes.status, 0, passes.stderr);
  assert.match(passes.stderr, /so this commit was not checked/);
  assert.doesNotMatch(passes.stderr, /refused/);
});

test("git fails and the work tree's config does not load: the line says neither was read, and git's failure lets the commit through", () => {
  const r = repo(BAN);
  put(r.dir, { [CONFIG]: "{ broken" });
  const c = handHook(r.dir, failing("*ls-files*", "fatal: fork failed"));
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /fatal: fork failed/);
  assert.match(c.stderr, /the work tree's does not load/);
  assert.doesNotMatch(c.stderr, /^ennyn: the config does not load/m);
});

test("grafts are off, as replace refs are: a grafts file moves neither the report nor the ancestry a merge asks", () => {
  const r = repo({});
  const loose = headOf(r);
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: rules", ["--no-verify"]).status, 0);
  const start = headOf(r);
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: rule gone", ["--no-verify"]).status, 0);
  put(r.dir, { ".git/info/grafts": `${headOf(r)} ${loose} ${start}\n` });
  assert.match(report(r.dir, ["--from", start]).text, /loosened: review\.forbidden/);
  const m = grown();
  m.stage({ [CONFIG]: "{}" });
  put(m.dir, { ".git/info/grafts": `${headOf(m)}\n`, ".git/MERGE_HEAD": `${m.root}\n` });
  assert.match(m.commit("chore: x\n").stderr, /This commit loosens review\.forbidden,/);
});

test("location: a refusal says refused and its true cause: a hook that changed folder and a bare repository are named, a failed probe says it could not tell", () => {
  const r = repo(BAN);
  r.stage({ "b.txt": "1\n" });
  const e = run(r.dir, [...ID, `--work-tree=${box("e")}`, ...M]);
  assert.equal(e.status, 1, e.stderr);
  assert.match(e.stderr, /^ennyn: commit refused: /m);
  assert.match(e.stderr, /a hook that changed folder/);
  assert.match(e.stderr, /A bare repository with a work tree of its own cannot be checked/);
  // git refuses the folder for a reason of its own: ownership, here in its words.
  const c = handHook(r.dir, { GIT_DIR: ".git", ...failing("*absolute-git-dir*", "fatal: detected dubious ownership in repository") });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /^ennyn: commit refused: could not tell where git is committing/m);
  assert.match(c.stderr, /detected dubious ownership/);
  assert.doesNotMatch(c.stderr, ELSEWHERE);
  // By hand no commit is being built, so there is no place to be wrong about.
  put(r.dir, { "src/x.txt": "1\n", ".git/MSG": "chore: x\n" });
  const hand = spawnSync(process.execPath, [CLI, "commit-check", "../.git/MSG"], { cwd: join(r.dir, "src"), encoding: "utf8", env: { ...process.env, GIT_DIR: "../.git" } });
  assert.equal(hand.status, 0, hand.stderr);
  assert.doesNotMatch(hand.stderr, /commit refused/);
});

test("the approval line: one that counts for nothing is said, naming the word; a line that names another key says nothing of it", () => {
  const key = "review.forbidden";
  for (const [line, word] of [[`${key} -- the user said yes`, "--"], ["review.forbiden", "review.forbiden"]]) {
    const r = repo(BAN);
    r.stage({ [CONFIG]: "{}" });
    const c = r.commit(`chore: x\n\n${LINE} ${line}\n`);
    assert.equal(c.status, 1, c.stderr);
    assert.ok(c.stderr.includes(`"${word}" is no key`), c.stderr);
    assert.match(c.stderr, /This commit loosens review\.forbidden,/);
  }
  const r = repo(BAN);
  r.stage({ [CONFIG]: "{}" });
  const other = r.commit(`chore: x\n\n${LINE} commitMsg.types\n`);
  assert.equal(other.status, 1, other.stderr);
  assert.doesNotMatch(other.stderr, /is no key/);
  const none = repo(BAN);
  none.stage({ [CONFIG]: "{}" });
  assert.doesNotMatch(none.commit("chore: x").stderr, /is no key/);
  // A path the commit loosens as a whole is a word that may stand there: the word named is the other one.
  const whole = repo(BAN);
  whole.stage({ [CONFIG]: "{ broken" });
  const path = whole.commit(`chore: x\n\n${LINE} ${CONFIG} please\n`);
  assert.equal(path.status, 1, path.stderr);
  assert.ok(path.stderr.includes('"please" is no key'), path.stderr);
});

test("a URL's user and password stay out of what is printed of a config that does not load: no shape tells them", () => {
  const PASSWORD = "hunter2-not-a-shape";
  const text = JSON.stringify({ review: { nope: `https://u:${PASSWORD}@r.example.invalid` }, security: { deps: { registries: { [`https://u:${PASSWORD}@r.example.invalid`]: null } } } });
  const held = repo(BAN);
  held.stage({ [CONFIG]: text });
  const c = held.commit("chore: x");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /does not load/);
  assert.ok(!c.stderr.includes(PASSWORD), c.stderr);
  const none = repo(null);
  put(none.dir, { [CONFIG]: text, "b.txt": "1\n" });
  git(["add", "b.txt"], { cwd: none.dir });
  const passes = none.commit("feat: x");
  assert.match(passes.stderr, /does not load/);
  assert.ok(!passes.stderr.includes(PASSWORD), passes.stderr);
  // The host stays, so the line can be acted on, a password may hold an @, and a word with no scheme is left alone.
  const cut = String(loaded(Buffer.from(`{"https://u:p@${PASSWORD}@r.example.invalid":1,"a@b":2}`), box("cfg"), "c.json").error);
  assert.ok(cut.includes("https://…@r.example.invalid"), cut);
  assert.ok(!cut.includes(PASSWORD), cut);
  assert.ok(cut.includes("a@b"), cut);
});

test("a config's problems are said at once: a list member of another kind hides none of the others", () => {
  const cwd = box("cfg");
  assert.throws(() => configFrom(JSON.stringify({ language: "xx", nope: 1, review: { impactRequiredGlobs: [1, "src/**"] }, commitMsg: { skipSubjects: [null] } }), { cwd, configPath: join(cwd, "c.json") }), (/** @type {Error} */ e) => {
    assert.ok(e instanceof ConfigError);
    for (const part of [/unknown key "nope"/, /"language" must be/, /"review\.impactRequiredGlobs" must be a list of strings/, /"commitMsg\.skipSubjects" must be a list of strings/]) assert.match(e.message, part);
    return true;
  });
});

test("a stated limit: a .git/shallow written by hand makes an ancestor read as new; git keeps the parent, and the report lists the merge", () => {
  const r = grown();
  const start = headOf(r);
  r.stage({ [CONFIG]: "{}" });
  put(r.dir, { ".git/shallow": `${start}\n`, ".git/MERGE_HEAD": `${r.root}\n` });
  const c = r.commit("chore: x\n");
  assert.equal(c.status, 0, c.stderr);
  assert.equal(git(["rev-list", "--parents", "-1", "HEAD"], { cwd: r.dir }).split(" ").length, 3, "a parent, on record");
  const out = report(r.dir, ["--from", start]);
  assert.equal(out.code, 0, out.text);
  assert.deepEqual(out.json.loosened.map((/** @type {{ hash: string, unapproved: string[] }} */ l) => [l.hash, l.unapproved]), [[headOf(r), ["review.forbidden"]]]);
});

test("the commit's config is read as a gate's: a failure no fault of the machine explains refuses, one of the machine is said, and what the commit deletes is context", () => {
  // git answers, and what it prints does not parse: a throw of Ennyn's on its text, no machine's. Letting it through would leave no config read.
  const bin = box("bin");
  put(bin, { git: `#!/bin/sh\ncase "$*" in *ls-files*) printf 'garbage\\000'; exit 0;; esac\nexec ${JSON.stringify(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim())} "$@"\n` });
  chmodSync(join(bin, "git"), 0o755);
  const r = repo(BAN);
  r.stage({ "a.txt": "1\n" });
  const c = handHook(r.dir, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /every gate was not checked, so this commit is refused/i);
  // The machine's fault stays said: the commit goes on, under the file as it stands.
  const fault = handHook(r.dir, failing("*ls-files*", "fatal: fork failed"));
  assert.equal(fault.status, 0, fault.stderr);
  assert.match(fault.stderr, /The commit's own config could not be read \(fatal: fork failed\)/);
  // What the commit deletes is context, and its names can pick the failure: the defaults stay the baseline, said.
  const OFF = JSON.stringify({ security: { ci: { paths: [] } } });
  const d = repo(null);
  d.stage({ "d.json": OFF });
  assert.equal(d.commit("chore: a data file", ["--no-verify"]).status, 0);
  git(["rm", "-q", "d.json"], { cwd: d.dir });
  d.stage({ [CONFIG]: OFF });
  const gone = handHook(d.dir, failing("*--name-status*", "fatal: stopped"));
  assert.equal(gone.status, 1, gone.stderr);
  assert.match(gone.stderr, /This commit loosens security\.ci\.paths,/);
  assert.match(gone.stderr, /the files this commit deletes could not be read \(fatal: stopped\)/i);
  // A name no git argument can hold, and the commit picked it: it costs that name, and the compare with the defaults stands.
  const long = repo(null);
  const name = `${"n".repeat(140 * 1024)}.json`;
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: long.dir, encoding: "utf8", input: "{}" }).stdout.trim();
  const index = (/** @type {string} */ line) => assert.equal(spawnSync("git", ["update-index", "--index-info"], { cwd: long.dir, encoding: "utf8", input: line }).status, 0);
  index(`100644 ${blob}\t${name}\n`);
  assert.equal(long.commit("chore: long", ["--no-verify"]).status, 0);
  index(`0 ${"0".repeat(40)}\t${name}\n`);
  long.stage({ [CONFIG]: OFF });
  const named = handHook(long.dir);
  assert.equal(named.status, 1, named.stderr.slice(0, 400));
  assert.match(named.stderr, /This commit loosens security\.ci\.paths,/);
  assert.match(named.stderr, /the files this commit deletes could not be read \(a name git cannot be asked for\)/i);
  assert.doesNotMatch(named.stderr, /defaults alone/, "the line holds for a decoy beside the real config too");
  // One name that fails costs that name; by hand no commit is being built, so saying it fails the command.
  const one = failing("*ls-files*d.json*", "fatal: stopped");
  const said = handHook(d.dir, one);
  assert.match(said.stderr, /the files this commit deletes could not be read \(fatal: stopped\)/i);
  put(d.dir, { ".git/MSG": `chore: x\n\n${LINE} security.ci.paths\n` });
  const hand = spawnSync(process.execPath, [CLI, "commit-check", ".git/MSG"], { cwd: d.dir, encoding: "utf8", env: { ...process.env, ...one } });
  assert.equal(hand.status, 1, hand.stderr);
  assert.match(hand.stderr, /the files this commit deletes could not be read \(fatal: stopped\)/i);
});

/** An index entry at `path`, a regular file by its mode, naming `oid`. @param {string} dir @param {string} oid @param {string} [path] */
const entryFor = (dir, oid, path = CONFIG) => git(["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], { cwd: dir });

test("wrong object type: an entry that names a tree, a commit or a tag is the commit's content: the whole file counts, alone, under its path", () => {
  for (const [kind, spec] of [["tree", "HEAD^{tree}"], ["commit", "HEAD"], ["tag", "v1"]]) {
    const r = repo(BAN);
    git([...r.id, "tag", "-a", "-m", "v1", "v1"], { cwd: r.dir });
    entryFor(r.dir, git(["rev-parse", spec], { cwd: r.dir }));
    const c = r.commit("chore: x");
    assert.equal(c.status, 1, `${kind}: ${c.stderr}`);
    assert.match(c.stderr, /This commit loosens \.ennyn\/config\.json,/);
    assert.match(c.stderr, new RegExp(`does not load \\(an object of type ${kind}\\)`));
    assert.doesNotMatch(c.stderr, /what it loosens was not read/);
    assert.equal(r.commit("not typed").status, 1, `${kind}: HEAD's rules ran`);
    const line = r.commit(`chore: x\n\n${LINE} ${CONFIG}\n`);
    assert.equal(line.status, 0, `${kind}: the user's line names the file: ${line.stderr}`);
  }
  // At the place the variable names, in a project with none at the default place.
  const moved = repo(null);
  moved.stage({ "conf.json": JSON.stringify(BAN) });
  assert.equal(moved.commit("chore: conf", ["--no-verify"]).status, 0);
  entryFor(moved.dir, git(["rev-parse", "HEAD^{tree}"], { cwd: moved.dir }), "conf.json");
  const c = moved.commit("chore: x", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens conf\.json,/);
  // HEAD's side is the reader's context: the commit's content is what the index brings.
  const past = repo(BAN);
  entryFor(past.dir, git(["rev-parse", "HEAD^{tree}"], { cwd: past.dir }));
  assert.equal(past.commit("chore: x", ["--no-verify"]).status, 0);
  git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", "--stdin"], { cwd: past.dir, input: "{}" })},${CONFIG}`], { cwd: past.dir });
  const held = stagedVersions(past.dir, [CONFIG]).get(CONFIG);
  assert.deepEqual([held?.headUnread, held?.wrongType], ["notBlob", undefined]);
});

test("bypass: a commit whose config entry names no blob is unread, named, exit 1, and the rest of the range is listed", () => {
  const r = repo(BAN);
  const start = headOf(r);
  r.stage({ [CONFIG]: "{}" });
  assert.equal(r.commit("chore: rule gone", ["--no-verify"]).status, 0);
  const gone = headOf(r);
  entryFor(r.dir, git(["rev-parse", "HEAD^{tree}"], { cwd: r.dir }));
  assert.equal(r.commit("chore: no file", ["--no-verify"]).status, 0);
  const wrong = headOf(r);
  const atEnd = report(r.dir, ["--from", start]);
  assert.equal(atEnd.code, 1, atEnd.text);
  assert.doesNotMatch(atEnd.text, /fatal:|bad file/);
  assert.match(atEnd.text, new RegExp(`${wrong.slice(0, 10)} could not be read \\(\\.ennyn/config\\.json names an object that is no blob\\)`));
  assert.match(atEnd.text, new RegExp(`${gone.slice(0, 10)}.*review\\.forbidden`), "the rest is listed");
  assert.match(atEnd.text, /\.ennyn\/config\.json at the range's end does not load/);
  // Past it, the commit that repairs it has no baseline: named too, and nothing stops.
  r.stage({ [CONFIG]: JSON.stringify(BAN) });
  assert.equal(r.commit("chore: repaired", ["--no-verify"]).status, 0);
  const past = report(r.dir, ["--from", start]);
  assert.equal(past.code, 1, past.text);
  assert.match(past.text, new RegExp(`${wrong.slice(0, 10)} could not be read`));
  assert.match(past.text, new RegExp(`${headOf(r).slice(0, 10)} could not be read \\(its parent's config: .ennyn/config\\.json names an object that is no blob\\)`));
  assert.match(past.text, new RegExp(`${gone.slice(0, 10)}.*review\\.forbidden`));
  // A file of that kind the commit deletes is no config it renames, and stops nothing either.
  const decoy = repo(null);
  decoy.stage({ "d.json": "{}" });
  entryFor(decoy.dir, git(["rev-parse", "HEAD^{tree}"], { cwd: decoy.dir }), "d.json");
  assert.equal(decoy.commit("chore: d", ["--no-verify"]).status, 0);
  const from = headOf(decoy);
  decoy.stage({ [CONFIG]: JSON.stringify(BAN) });
  git(["rm", "-q", "--cached", "d.json"], { cwd: decoy.dir });
  assert.equal(decoy.commit("chore: first config", ["--no-verify"]).status, 0);
  assert.equal(report(decoy.dir, ["--from", from]).code, 0);
});

test("a config taken from the default place counts whole under that path, its content unchanged and the variable set, so a commit can no longer leave the next one on the defaults", () => {
  const r = repo(BAN);
  git(["mv", CONFIG, "conf.json"], { cwd: r.dir });
  const c = r.commit("chore: move", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stderr, /This commit loosens \.ennyn\/config\.json,/);
  // The next commit, the variable gone: no config at either place, and the deletion compares with the defaults.
  r.stage({ "src/a.js": "SECRETWORD\n" });
  const next = r.commit("not typed");
  assert.equal(next.status, 1, next.stderr);
  const line = r.commit(`chore: move\n\n${LINE} ${CONFIG}\n`, [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(line.status, 1, `the rule moved with the file: ${line.stderr}`);
  assert.match(line.stderr, /adds "SECRETWORD"/);
  git(["rm", "-q", "--cached", "src/a.js"], { cwd: r.dir });
  const approved = r.commit(`chore: move\n\n${LINE} ${CONFIG}\n`, [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(approved.status, 0, approved.stderr);
  // Moved, the place the variable names is its place: a commit that leaves the config there asks nothing.
  put(r.dir, { "b.txt": "b\n" });
  git(["add", "b.txt"], { cwd: r.dir });
  const stays = r.commit("chore: stays", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(stays.status, 0, stays.stderr);
  // From a project that had moved already, the same rename asks nothing: only the default place is what others read.
  git(["mv", "conf.json", "conf2.json"], { cwd: r.dir });
  const onward = r.commit("chore: again", [], { ENNYN_CONFIG: "conf2.json" });
  assert.equal(onward.status, 0, onward.stderr);
  // A value loosened on the way needs its own name beside the path.
  const both = repo(BAN);
  git(["mv", CONFIG, "conf.json"], { cwd: both.dir });
  both.stage({ "conf.json": "{}" });
  const one = both.commit(`chore: move\n\n${LINE} ${CONFIG}\n`, [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(one.status, 1, one.stderr);
  assert.match(one.stderr, /This commit loosens review\.forbidden,/);
  assert.equal(both.commit(`chore: move\n\n${LINE} ${CONFIG}, review.forbidden\n`, [], { ENNYN_CONFIG: "conf.json" }).status, 0);
  // Its new place does not load: the whole file still counts, under the place it went to.
  const broken = repo(BAN);
  git(["mv", CONFIG, "conf.json"], { cwd: broken.dir });
  broken.stage({ "conf.json": "{not json" });
  assert.match(broken.commit("chore: move", [], { ENNYN_CONFIG: "conf.json" }).stderr, /This commit loosens conf\.json,/);
  // Its object is not on this machine: what it holds is not read, and that it left is.
  const lost = repo(BAN);
  git(["mv", CONFIG, "conf.json"], { cwd: lost.dir });
  entryFor(lost.dir, "1".repeat(40), "conf.json");
  const gone = handHook(lost.dir, { ENNYN_CONFIG: "conf.json" });
  assert.equal(gone.status, 1, gone.stderr);
  assert.match(gone.stderr, /This commit loosens \.ennyn\/config\.json,/);
  // Deleted, with no new place: compared by value as ever, so one that held the defaults loosens nothing.
  const plain = repo({});
  git(["rm", "-q", CONFIG], { cwd: plain.dir });
  const none = plain.commit("chore: no config");
  assert.equal(none.status, 0, none.stderr);
});

test("a merge: a parent that holds the config elsewhere takes the path off; one that holds it at the default place, or holds none, does not", () => {
  /** @param {(r: ReturnType<typeof repo>) => void} onSide @returns {ReturnType<typeof repo>} a repository back on main, moved on, with a side branch */
  const sided = (onSide) => {
    const r = repo(BAN);
    git(["checkout", "-q", "-b", "side"], { cwd: r.dir });
    onSide(r);
    assert.equal(r.commit("chore: side", ["--no-verify"]).status, 0);
    git(["checkout", "-q", "main"], { cwd: r.dir });
    r.stage({ "m.txt": "m\n" });
    assert.equal(r.commit("chore: main", ["--no-verify"]).status, 0);
    return r;
  };
  const honest = sided((r) => git(["mv", CONFIG, "conf.json"], { cwd: r.dir }));
  git([...honest.id, "merge", "-q", "--no-commit", "--no-ff", "side"], { cwd: honest.dir });
  const pulled = honest.commit("chore: merge", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(pulled.status, 0, pulled.stderr);
  // The side keeps it where it was: the move is this commit's own.
  const kept = sided((r) => r.stage({ "s.txt": "s\n" }));
  const side = git(["rev-parse", "side"], { cwd: kept.dir });
  put(kept.dir, { ".git/MERGE_HEAD": `${side}\n` });
  git(["mv", CONFIG, "conf.json"], { cwd: kept.dir });
  const own = kept.commit("chore: merge", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(own.status, 1, own.stderr);
  assert.match(own.stderr, /This commit loosens \.ennyn\/config\.json,/);
  // A parent with no config at all holds no other place for it.
  const none = sided((r) => r.stage({ "s.txt": "s\n" }));
  const empty = spawnSync("git", ["mktree"], { cwd: none.dir, encoding: "utf8", input: "" }).stdout.trim();
  const root = spawnSync("git", [...none.id, "commit-tree", empty, "-m", "chore: bare"], { cwd: none.dir, encoding: "utf8" }).stdout.trim();
  put(none.dir, { ".git/MERGE_HEAD": `${root}\n` });
  git(["mv", CONFIG, "conf.json"], { cwd: none.dir });
  const bare = none.commit("chore: merge", [], { ENNYN_CONFIG: "conf.json" });
  assert.equal(bare.status, 1, bare.stderr);
  assert.match(bare.stderr, /This commit loosens \.ennyn\/config\.json,/);
});
