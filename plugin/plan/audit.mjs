/**
 * The audit slot: every `security.everyCycles` cycles it holds a security audit of the project's sensitive
 * paths, with a path table; otherwise a finished feature is audited. Whether this cycle is one comes from the
 * metrics log, not from memory: each cycle ends with one budget record (`budget --record`), and the record of a
 * cycle whose audit was the security audit carries `securityAudit: true` and `covers`, the keys of the records
 * no earlier mark covered.
 *
 * The question is which cycles an audit saw, not where it stands in history: a record's key is a digest of its
 * line, and a cycle counts until a mark covers its key. No git is asked, so a squash or rebase merge, a
 * cherry-pick, an amend, a revert or a moved line changes nothing: a branch's audit covers only the records its
 * log held, a record edited since is another key and counts again, and a line that does not parse is a cycle.
 * The log is only appended to: a record that another names in `replaces` (a cycle recording again at its commit) is
 * no cycle of its own, wherever a merge put the two lines, so a mark replaced by a plain record covers nothing.
 */

import { resolve } from "node:path";
import { DEFAULTS } from "../core/config.mjs";
import { readRegular } from "../core/files.mjs";
import { globToRegExp, matchAny } from "../core/glob.mjs";
import { lockPath, npmrcPath } from "../checks/deps.mjs";
import { currentRecords, KEY, lineKey, logLines, replacesOf } from "../setup/budget.mjs";
import { pathPatterns, riskyPaths } from "../setup/scan.mjs";

export { lineKey };

/**
 * Code and configuration that runs on the project's machines (a developer's, CI's) or holds their secrets,
 * whatever gate reads it: a starting set the security audit reads in every project, matched as a file system
 * that ignores case serves them (`Makeﬁle`, `.huſky/pre-commit`). DESIGN.md lists them; a project adds its own
 * through `review.impactRequiredGlobs`.
 */
export const MACHINE_GLOBS = Object.freeze([
  // An agent's setup and instructions, and a plugin's own layout: hooks, MCP and LSP servers and monitors run programs.
  ".claude/**", "**/.claude-plugin/**", "hooks/**", ".mcp.json", ".lsp.json", "monitors/monitors.json", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/GEMINI.md", ".gemini/**",
  ".cursor/**", "**/.cursorrules", "**/.windsurfrules",
  // Package scripts, package managers, their locks and pinned tools, in any ecosystem.
  "**/package.json", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/.npmrc", "**/.nvmrc", "**/.node-version", "**/pnpm-lock.yaml", "**/pnpm-workspace.yaml", "**/.pnpmfile.cjs", "**/yarn.lock",
  "**/.yarnrc", "**/.yarnrc.yml", ".yarn/releases/**", ".yarn/plugins/**", "**/bun.lock", "**/bun.lockb", "**/bunfig.toml", "**/deno.json", "**/deno.jsonc",
  "**/Cargo.lock", "**/build.rs", ".cargo/**", "**/go.sum", "**/poetry.lock", "**/Pipfile", "**/Pipfile.lock", "**/uv.lock", "**/requirements*.txt",
  "**/setup.py", "**/pyproject.toml", "**/conftest.py", "**/.pypirc", "**/Gemfile", "**/Gemfile.lock", "**/Rakefile", "**/composer.json", "**/composer.lock",
  "**/gradlew", "**/gradlew.bat", "**/gradle/wrapper/**", "**/build.gradle", "**/build.gradle.kts", "**/settings.gradle", "**/settings.gradle.kts",
  "**/mvnw", "**/mvnw.cmd", "**/.mvn/**", "**/.envrc", "**/mise.toml", "**/.mise.toml", "**/.tool-versions", "**/flake.nix", "**/shell.nix",
  "**/renovate.json", "**/.renovaterc", "**/.renovaterc.json",
  // Git hooks.
  ".husky/**", ".githooks/**", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".pre-commit-config.yaml",
  // CI and the forges' own files (workflows, actions, dependabot, CODEOWNERS).
  ".github/**", ".gitlab/**", ".gitlab-ci.yml", ".gitea/**", ".forgejo/**", ".circleci/**", "**/Jenkinsfile", "azure-pipelines.yml", ".buildkite/**",
  ".travis.yml", "bitbucket-pipelines.yml", ".drone.yml", ".woodpecker.yml", ".woodpecker/**", "**/CODEOWNERS",
  // Builds, task runners and development environments.
  "**/Dockerfile", "**/Dockerfile.*", "**/*.Dockerfile", "**/Containerfile", "**/docker-compose*.yml", "**/docker-compose*.yaml", "**/compose.yml",
  "**/compose.yaml", "**/Makefile", "**/GNUmakefile", "**/Taskfile.yml", "**/justfile", ".devcontainer/**", ".vscode/tasks.json", ".vscode/launch.json",
  ".vscode/settings.json", "**/*.code-workspace", ".idea/**", "scripts/**", "**/scripts/**", "script/**", "bin/**", "tools/**",
  // Repository plumbing (filters and submodules fetch or run code), secrets and keys.
  ".gitmodules", "**/.gitattributes", "**/.env", "**/.env.*", "**/.netrc", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*",
]);
/**
 * A name as a case-insensitive file system compares it: compatibility forms composed (`ﬁ` is `fi`, `ſ` is `s`),
 * then full case folding (`ß` is `ss`). ASCII only needs lower case.
 * @param {string} s
 */
export const folded = (s) => (/^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : s.normalize("NFKC").toUpperCase().toLowerCase());
/** The list as one expression over folded names: one test a path. */
const MACHINE_RE = new RegExp(MACHINE_GLOBS.map((g) => globToRegExp(folded(g)).source).join("|"));
/** For the paths it matched: the first rule that names each, shown beside it. */
const MACHINE_EACH = MACHINE_GLOBS.map((g) => /** @type {const} */ ([g, globToRegExp(folded(g))]));

/**
 * What Claude Code loads from a plugin's root besides its manifest (code.claude.com/docs/en/plugins-reference,
 * "Standard layout"): hooks, MCP and LSP servers, monitors and the executables on the Bash tool's PATH run
 * programs; settings, skills (a root `SKILL.md` is one when there is no `skills/`), agents, commands, output styles,
 * workflows and themes reach every session the plugin is enabled in. A root is the folder of a
 * `.claude-plugin/plugin.json`, at any depth (a marketplace keeps several).
 */
export const PLUGIN_GLOBS = Object.freeze(["hooks/**", ".mcp.json", ".lsp.json", "monitors/**", "bin/**", "settings.json", "SKILL.md", "skills/**", "agents/**", "commands/**", "output-styles/**", "workflows/**", "themes/**"]);
const PLUGIN_EACH = PLUGIN_GLOBS.map((g) => /** @type {const} */ ([g, globToRegExp(folded(g))]));
const MANIFEST_DIR = ".claude-plugin";
const MANIFEST = `${MANIFEST_DIR}/plugin.json`;

/**
 * @typedef {{ key: string, budget: boolean, commit: string | null, mark: boolean, covers: string[], replaces: string | null }} CycleRecord
 *   `key`: the line's digest; `budget`: the line is a budget record (else it does not parse, and is a cycle all
 *   the same); `commit`: the commit a budget record names; `mark`: `securityAudit: true`; `covers`: the keys a
 *   mark lists (entries that are no key are dropped; a mark without the list covers only itself); `replaces`: the
 *   key of the record it replaced.
 * @typedef {{
 *   due: boolean | null,
 *   reason: "off" | "never" | "since" | "unread",
 *   every: number,
 *   cycles: number,
 *   since: number | null,
 *   marks: number,
 *   skipped?: number,
 *   error?: string,
 * }} SecurityDue
 *   `cycles`: distinct keys; `since`: those no mark covers (null on an error); `marks`: the marks in the log;
 *   `skipped`: its lines that do not parse, each a cycle.
 */

/**
 * The cycle records of a metrics log (null: no log): every budget record no other names in `replaces`
 * (currentRecords), and every line that does not parse; other JSON (another kind of record) is no cycle. Read as
 * bytes, so a line that is not UTF-8 keeps its key.
 * @param {Buffer | null} bytes
 * @returns {CycleRecord[]}
 */
export function cycleRecords(bytes) {
  /** @type {CycleRecord[]} */
  const records = [];
  // Read as the budget reads the log (logLines): a line the budget reads as a record is one here.
  for (const { key, value: o } of logLines(bytes)) {
    if (o === undefined) {
      records.push({ key, budget: false, commit: null, mark: false, covers: [], replaces: null });
      continue;
    }
    if (!o || typeof o !== "object" || o.kind !== "budget") continue;
    const mark = o.securityAudit === true;
    const covers = mark && Array.isArray(o.covers) ? o.covers.filter((/** @type {unknown} */ k) => typeof k === "string" && KEY.test(k)) : [];
    records.push({ key, budget: true, commit: typeof o.commit === "string" ? o.commit : null, mark, covers, replaces: replacesOf(o) });
  }
  // A record another names in `replaces` is replaced by it, as the budget reads the log.
  return currentRecords(records, (r) => r.key, (r) => r.replaces);
}

/**
 * The keys no mark covers: a mark covers the keys it lists and its own.
 * @param {CycleRecord[]} records
 * @returns {Set<string>}
 */
export function uncovered(records) {
  const covered = new Set(records.flatMap((r) => (r.mark ? [r.key, ...r.covers] : [])));
  return new Set(records.map((r) => r.key).filter((k) => !covered.has(k)));
}

/**
 * @param {CycleRecord[]} records
 * @param {number} every `security.everyCycles`; 0 turns the security audit off
 * @returns {SecurityDue}
 */
export function securityDue(records, every) {
  const since = uncovered(records).size;
  const marks = records.filter((r) => r.mark).length;
  const base = { every, cycles: new Set(records.map((r) => r.key)).size, since, marks, skipped: records.filter((r) => !r.budget).length };
  if (every === 0) return { due: false, reason: "off", ...base };
  // No audit recorded yet: the first one is due now.
  if (!marks) return { due: true, reason: "never", ...base };
  // This cycle is the (since + 1)th no audit covered.
  return { due: since + 1 >= every, reason: "since", ...base };
}

/**
 * The metrics log's bytes, null when there is none; read only as a regular file reached through no symbolic link
 * inside the repository (core/files.mjs readRegular). One that is refused or cannot be read throws, naming it.
 * @param {string} root the repository @param {string} path absolute
 */
export function readLog(root, path) {
  return readRegular(root, path);
}

/**
 * The answer `ennyn audit` gives, from the project's metrics log.
 * @param {string} cwd
 * @param {{ paths: { metricsLog: string }, security: { everyCycles: number } }} config
 * @returns {SecurityDue}
 */
export function auditAnswer(cwd, config) {
  const every = config.security.everyCycles;
  let records;
  try {
    records = cycleRecords(readLog(cwd, resolve(cwd, config.paths.metricsLog)));
  } catch (e) {
    return { due: null, reason: "unread", every, cycles: 0, since: null, marks: 0, error: /** @type {Error} */ (e).message };
  }
  return securityDue(records, every);
}

/**
 * What a new mark lists: the keys of the records no earlier mark covers, each once (marks stay small, and a key
 * is covered once).
 * @param {CycleRecord[]} records the log before the mark, without the record it replaces
 */
export function markCovers(records) {
  return [...uncovered(records)];
}

/** The rule a symbolic link is listed under, whatever its name: what it reaches is not resolved here. */
export const LINK_RULE = "symlink";
/** The rule a gitlink is listed under: another repository's code, which a recursive clone brings in. */
export const SUBMODULE_RULE = "submodule";

/**
 * The machine source: every tracked file a rule of MACHINE_GLOBS, or of PLUGIN_GLOBS under a plugin root, names,
 * as the file system would serve it, with the first rule that names it (a plugin rule written under its root).
 * Every symbolic link, at any depth and whatever its name, is listed under LINK_RULE and never followed: where it
 * leads depends on the file system, the clone's folder and the program that reads it, so the audit reads it by
 * hand. A link or a gitlink named `.claude-plugin` still makes its folder a plugin root, by its name. Every gitlink
 * is listed under SUBMODULE_RULE; what a submodule holds is not listed here either.
 * @param {string[]} files
 * @param {string[]} links the index's symbolic links
 * @param {string[]} gitlinks
 */
function machine(files, links, gitlinks) {
  const linked = new Set(links);
  const submodules = new Set(gitlinks);
  // The roots as the manifests spell them (a manifest, or a link or submodule named for its folder); a file under
  // one is compared folded, as the file system serves it.
  const isRoot = (/** @type {string} */ f) => {
    const name = folded(f);
    if (name === MANIFEST || name.endsWith(`/${MANIFEST}`)) return 2;
    return (linked.has(f) || submodules.has(f)) && (name === MANIFEST_DIR || name.endsWith(`/${MANIFEST_DIR}`)) ? 1 : 0;
  };
  const roots = files.filter(isRoot).map((f) => f.split("/").slice(0, -isRoot(f)).map((s) => `${s}/`).join(""));
  const ruleOf = (/** @type {string} */ f) => {
    if (linked.has(f)) return LINK_RULE;
    if (submodules.has(f)) return SUBMODULE_RULE;
    const name = folded(f);
    const hit = MACHINE_RE.test(name) ? MACHINE_EACH.find(([, re]) => re.test(name)) : undefined;
    if (hit) return hit[0];
    for (const root of roots) {
      if (!name.startsWith(folded(root))) continue;
      const rest = name.slice(folded(root).length);
      const rule = PLUGIN_EACH.find(([, re]) => re.test(rest));
      if (rule) return root + rule[0];
    }
    return null;
  };
  const rules = files.map(ruleOf);
  const named = files.filter((_, i) => rules[i] !== null);
  return { source: "machine", files: named, rules: /** @type {string[]} */ (rules.filter((r) => r !== null)) };
}

/**
 * The paths a security audit reads, by where they come from: the paths the project marked risky
 * (`review.impactRequiredGlobs`), those init-scan calls risky (matched as directories, literally), the CI and
 * lock files (by the default globs when the commit check is off, `off` then), the code that runs on the
 * project's machines (MACHINE_GLOBS), and Ennyn's own config and metrics log, which can turn a check off or reset
 * the audit.
 * @param {string[]} files tracked files
 * @param {typeof DEFAULTS} config
 * @param {{ configRel?: string | null, logRel?: string | null, links?: string[], gitlinks?: string[] }} [own] the config's
 *   and the log's paths in the repository; the index's symbolic links and gitlinks
 * @returns {{ source: string, files: string[], off?: true, rules?: string[] }[]} only the sources that name a tracked file;
 *   the machine source gives the rule that named each file
 */
export function sensitivePaths(files, config, { configRel = null, logRel = null, links = [], gitlinks = [] } = {}) {
  const ci = config.security.ci.paths;
  const deps = config.security.deps.paths;
  const ciGlobs = ci.length ? ci : DEFAULTS.security.ci.paths;
  const depsGlobs = deps.length ? deps : DEFAULTS.security.deps.paths;
  // A risky path is a directory (or a flat file) as the scan names it: `app/[locale]/auth` is that directory, no glob.
  const risky = new Set(riskyPaths(files, pathPatterns(config, []).re).map((r) => r.path));
  const underRisky = (/** @type {string} */ f) => {
    if (risky.has(f)) return true;
    for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) if (risky.has(f.slice(0, i))) return true;
    return false;
  };
  const sources = [
    { source: "review.impactRequiredGlobs", files: files.filter((f) => matchAny(f, config.review.impactRequiredGlobs)) },
    { source: "init-scan risky", files: risky.size ? files.filter(underRisky) : [] },
    { source: "security.ci.paths", files: files.filter((f) => matchAny(f, ciGlobs)), ...(ci.length ? {} : { off: /** @type {const} */ (true) }) },
    { source: "security.deps.paths", files: files.filter((f) => lockPath(f, depsGlobs) || npmrcPath(f)), ...(deps.length ? {} : { off: /** @type {const} */ (true) }) },
    machine(files, links, gitlinks),
    { source: "ennyn", files: [configRel, logRel].filter((p) => p !== null && files.includes(p)) },
  ];
  return /** @type {{ source: string, files: string[], off?: true, rules?: string[] }[]} */ (sources.filter((s) => s.files.length));
}
