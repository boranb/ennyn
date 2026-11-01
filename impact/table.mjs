/**
 * Impact table: five questions answered by commands before a risky change
 * (shared decision, gate, accept/reject rule) is written.
 *
 *   S1 who else reads or decides this     references + twin roots + co-change
 *   S2 which other paths reach this state entry-point files referencing the symbol
 *   S3 what is newly accepted / rejected  tests and corpora next to the files, tests importing them
 *   S4 the ceiling / failed measurement   ceiling registry + catch / fallback returns
 *   S5 where fakes come from              tests mocking the module, fixtures they cite
 *
 * Every row has an answer. A row that cannot be measured says so
 * ("unmeasured: <reason>"); an empty cell would read as "nothing to worry about".
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { present, readRegular } from "../core/files.mjs";
import { isAbsolute, join, posix, relative } from "node:path";
import { git, gitMaybe, gitRun } from "../core/git.mjs";
import { matchAny } from "../core/glob.mjs";
import { clipped, t } from "../core/i18n.mjs";

/**
 * @typedef {{ id: string, question: string, answer: string, commands: string[] }} ImpactRow
 * @typedef {{ rows: ImpactRow[] }} ImpactTable
 * @typedef {{ label: string, text: string, measured: boolean }} Part
 */

const LIST_MAX = 10;
/** The commits a file must share with an input file to count as changing with it. */
const COCHANGE_MIN = 3;
const OUTPUT_LINES = 40;
const ENTRY_POINT_RE = /(route|handler|cron|schedul|(?:^|[/._-])cli(?:[/._-]|$)|import|webhook|job)/i;
const CATCH_RE = /\bcatch\b\s*[({]/g;
const FALLBACK_RETURN_RE = /\breturn\s+(?:\[\s*\]|null|0)(?![\w.])/g;
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])([^"'`\n]+)\1/g;
/**
 * An import or require statement at the start of a line (its braces may span lines), or an awaited dynamic
 * import: text quoted inside a string is not one.
 */
const STATEMENT_RE = /^[ \t]*(?:(?:import|export)\b[^"'`;]*?(?:\bfrom\s*)?|(?:const|let|var)\b[^\n"'`]*?=\s*(?:await\s+)?(?:require|import)\s*\(\s*|require\s*\(\s*)(["'])([^"'\n]+)\1|(?<![\w"'`])await\s+import\s*\(\s*(["'])([^"'\n]+)\3/gm;
/**
 * A test by its name or its place: x.test.js / x.spec.js, or a file under a top-level test directory
 * that is not a helper, fixture, mock or support file.
 */
const TEST_FILE_RE = /\.(?:test|spec)\.[^/]+$|^(?:test|tests|__tests__|spec)\/(?!(?:.*\/)?(?:helpers?|fixtures?|__fixtures__|support|mocks?|__mocks__|utils?|factories)\/)/;
const MOCK_CALL_RE = /\b(?:(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)|mock\.module|mock)\s*\(\s*(["'`])([^"'`\n]+)\1/g;
const FAKE_RE = /\b(?:vi|jest)\.(?:mock|doMock|fn|spyOn|stubGlobal)\s*\(|\bmock\.(?:fn|method|module|getter|setter)\s*\(|\bmock\s*\(|\bstub\s*\(|\bsinon\./;
const CODE_EXT_RE = /\.(?:[mc]?[jt]sx?)$/;

/**
 * @param {string} p
 */
const normPath = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * An input path as the repository names it: an absolute path inside `cwd` becomes relative to it (agents
 * pass absolute paths; every row compares with git's repository-relative names). The repository root may
 * be named through a link (macOS: /var is /private/var); a link inside the repository is left as it is,
 * as git leaves it. One outside stays.
 * @param {string} cwd @param {string} p
 */
function repoPath(cwd, p) {
  if (!isAbsolute(p)) return normPath(p);
  const roots = [cwd];
  try {
    roots.push(realpathSync(cwd));
  } catch {
    // no real path: the name as given
  }
  for (const root of roots) {
    const rel = relative(root, p);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return normPath(rel);
  }
  return normPath(p);
}

/** @param {string} p */
const stripExt = (p) => p.replace(CODE_EXT_RE, "");

/** @param {string} p */
const base = (p) => p.slice(p.lastIndexOf("/") + 1);

/** @param {string} p */
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** @param {unknown} err */
function errorLine(err) {
  const e = /** @type {{ stderr?: string | Buffer, message?: string }} */ (err);
  const raw = (e.stderr ? String(e.stderr) : "") || e.message || String(err);
  return raw.trim().split("\n")[0].slice(0, 200);
}

/**
 * How a command that did not succeed ended: timed out, killed, not found, or its exit code, with the first
 * line it wrote to stderr.
 * @param {unknown} err @param {string} program @param {number} timeoutSeconds
 */
function commandEnd(err, program, timeoutSeconds) {
  const e = /** @type {{ code?: string, signal?: string | null, status?: number | null, stderr?: string | Buffer }} */ (err);
  const said = (e.stderr ? String(e.stderr) : "").trim().split("\n")[0].slice(0, 200);
  const how =
    e.code === "ETIMEDOUT" ? `timed out after ${timeoutSeconds} s` : e.code === "ENOENT" ? `${program}: not found` : e.signal ? `killed by ${e.signal}` : typeof e.status === "number" ? `exit ${e.status}` : errorLine(err);
  return said && !how.includes(said) ? `${how}: ${said}` : how;
}

/**
 * @param {string[]} items
 * @param {string} lang
 * @param {string} sep
 */
function capList(items, lang, sep = ", ") {
  if (items.length <= LIST_MAX) return items.join(sep);
  return items.slice(0, LIST_MAX).join(sep) + sep + t("impact.more", { n: items.length - LIST_MAX }, lang);
}

/**
 * @param {Part[]} parts
 * @param {string} lang
 */
function answerFrom(parts, lang) {
  if (!parts.some((p) => p.measured)) {
    return t("impact.unmeasured", { reason: parts.map((p) => (parts.length > 1 ? `${p.label}: ${p.text}` : p.text)).join("; ") }, lang);
  }
  return parts
    .map((p) => {
      const text = p.measured ? p.text : t("impact.unmeasured", { reason: p.text }, lang);
      return parts.length > 1 ? `${p.label}: ${text}` : text;
    })
    .join("\n");
}

/**
 * Lazily computed facts shared by several rows.
 */
class Context {
  /**
   * @param {{ cwd: string, config: any, symbol?: string | null, files?: string[] }} opts
   */
  constructor({ cwd, config, symbol, files = [] }) {
    this.cwd = cwd;
    this.config = config;
    this.lang = config.language;
    this.symbol = symbol && symbol.trim() ? symbol.trim() : null;
    this.files = [...new Set(files.map((f) => repoPath(cwd, f)).filter(Boolean))];
    this.testRe = new RegExp(config.metrics.testRe);
    this.excludeRe = new RegExp(config.metrics.excludeRe);
    /** @type {{ ok: true } | { ok: false, error: string } | undefined} */
    this._repo = undefined;
    /** @type {string[] | null | undefined} */
    this._tracked = undefined;
    /** @type {string} */
    this.trackedError = "";
    /** @type {Map<string, number[]> | null | undefined} */
    this._refs = undefined;
    /** @type {string} */
    this.refsError = "";
  }

  /** @param {string} p */
  isTest(p) {
    return this.testRe.test(p) || matchAny(p, this.config.impact.fakeGlobs);
  }

  /** @returns {string | null} error when this is not a usable git repository */
  repoError() {
    if (!this._repo) {
      try {
        git(["rev-parse", "--git-dir"], { cwd: this.cwd });
        this._repo = { ok: true };
      } catch (err) {
        this._repo = { ok: false, error: errorLine(err) };
      }
    }
    return this._repo.ok ? null : this._repo.error;
  }

  /** @returns {string[] | null} null when git cannot list the files (trackedError says why) */
  tracked() {
    if (this._tracked === undefined) {
      try {
        this._tracked = git(["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: this.cwd }).split("\0").filter(Boolean);
      } catch (err) {
        this.trackedError = errorLine(err) || "git ls-files failed";
        this._tracked = null;
      }
    }
    return this._tracked;
  }

  /**
   * Non-test files referencing the symbol as a whole word, with line numbers; null when git grep failed
   * (refsError says why). No match is git grep's exit 1 with nothing on stderr; a file it could not read
   * (exit 1, or 0 when another file matched) or any other failure is not "no references".
   * @returns {Map<string, number[]> | null}
   */
  refs() {
    if (this._refs === undefined) {
      // --no-color: color.ui or color.grep = always would wrap every path and number in escape codes.
      // A sparse checkout leaves files out of the work tree: those are read from the index.
      let sparse;
      try {
        sparse = gitMaybe(["config", "--type=bool", "--get", "core.sparseCheckout"], { cwd: this.cwd, absent: [1] }) === "true";
      } catch (err) {
        this.refsError = errorLine(err) || "git config failed";
        this._refs = null;
        return null;
      }
      const runs = [[], ...(sparse ? [["--cached"]] : [])].map((extra) => gitRun(["grep", "--no-color", ...extra, "-n", "-w", "-F", "-I", "--null", "-e", /** @type {string} */ (this.symbol)], { cwd: this.cwd, walk: true }));
      const bad = runs.find((r) => r.error || (r.status !== 0 && r.status !== 1) || r.stderr.trim());
      if (bad) {
        this.refsError = (bad.error?.message ?? bad.stderr).trim().split("\n")[0].slice(0, 200) || (bad.signal ? `git grep was killed (${bad.signal})` : `git grep exited ${bad.status}`);
        this._refs = null;
        return null;
      }
      const cachedOnly = (runs[1]?.stdout ?? "").split("\n").filter((l) => l.includes("\0") && !present(join(this.cwd, l.slice(0, l.indexOf("\0")))));
      const out = [runs[0].stdout, ...cachedOnly].join("\n");
      /** @type {Map<string, number[]>} */
      const refs = new Map();
      for (const line of out.split("\n")) {
        const nul = line.indexOf("\0");
        if (nul === -1) continue;
        const file = line.slice(0, nul);
        // Tests and excluded paths (docs, notes) mention a symbol without reading it.
        if (this.isTest(file) || this.excludeRe.test(file)) continue;
        // "path\0line\0content" (--null terminates the line number too)
        const n = Number(/^\d+/.exec(line.slice(nul + 1))?.[0] ?? NaN);
        refs.set(file, [...(refs.get(file) ?? []), n]);
      }
      // In path order, as git grep prints them, also when lines from the index were added.
      this._refs = new Map([...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return this._refs;
  }

  grepCommand() {
    return `git grep -n -w -F -e ${this.symbol}`;
  }
}

/** @param {Context} c @returns {ImpactRow} */
function rowS1(c) {
  const { lang, config } = c;
  /** @type {string[]} */
  const commands = [];
  /** @type {Part[]} */
  const parts = [];

  const refLabel = t("impact.part.references", {}, lang);
  if (!c.symbol) {
    parts.push({ label: refLabel, text: t("impact.reason.noSymbol", {}, lang), measured: false });
  } else if (config.impact.referenceCommand) {
    const argv = String(config.impact.referenceCommand)
      .split(/\s+/)
      .filter(Boolean)
      .map((a) => a.split("{symbol}").join(/** @type {string} */ (c.symbol)));
    commands.push(argv.join(" "));
    try {
      const out = execFileSync(argv[0], argv.slice(1), {
        cwd: c.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: config.impact.referenceTimeout * 1000,
      });
      const lines = out.replace(/\s+$/, "").split("\n");
      let text = lines.slice(0, OUTPUT_LINES).join("\n");
      if (lines.length > OUTPUT_LINES) text += "\n" + t("impact.moreLines", { n: lines.length - OUTPUT_LINES }, lang);
      parts.push({ label: refLabel, text: text.trim() ? text : t("impact.s1.noOutput", {}, lang), measured: true });
    } catch (err) {
      parts.push({ label: refLabel, text: t("impact.reason.commandFailed", { error: commandEnd(err, argv[0], config.impact.referenceTimeout) }, lang), measured: false });
    }
  } else if (c.repoError()) {
    parts.push({ label: refLabel, text: t("impact.reason.gitFailed", { error: String(c.repoError()) }, lang), measured: false });
  } else if (!c.refs()) {
    commands.push(c.grepCommand());
    parts.push({ label: refLabel, text: t("impact.reason.gitFailed", { error: c.refsError }, lang), measured: false });
  } else {
    commands.push(c.grepCommand());
    // "Who else": the input files themselves are not readers of their own symbol.
    const refs = new Map([.../** @type {Map<string, number[]>} */ (c.refs())].filter(([file]) => !c.files.includes(file)));
    const n = [...refs.values()].reduce((s, l) => s + l.length, 0);
    if (n === 0) parts.push({ label: refLabel, text: t("impact.s1.noRefs", {}, lang), measured: true });
    else {
      const list = [...refs].map(([file, lines]) => `${file}:${lines.join(",")}`);
      const head = t("impact.s1.refs", { n, files: refs.size }, lang);
      parts.push({ label: refLabel, text: `${head}: ${capList(list, lang, "; ")}`, measured: true });
    }
  }

  const twinLabel = t("impact.part.twins", {}, lang);
  if (!c.files.length) parts.push({ label: twinLabel, text: t("impact.reason.noFiles", {}, lang), measured: false });
  else if (!config.impact.twins.length) parts.push({ label: twinLabel, text: t("impact.reason.noTwins", {}, lang), measured: false });
  else {
    const found = [];
    for (const file of c.files) {
      for (const pair of config.impact.twins) {
        const [a, b] = pair.map(normPath);
        for (const [from, to] of [
          [a, b],
          [b, a],
        ]) {
          if (!file.startsWith(from + "/")) continue;
          const twin = `${to}/${file.slice(from.length + 1)}`;
          found.push(present(join(c.cwd, twin)) ? `${file} ↔ ${twin}` : t("impact.s1.twinMissing", { file, twin }, lang));
        }
      }
    }
    parts.push({ label: twinLabel, text: found.length ? found.join("; ") : t("impact.s1.noTwinRoot", {}, lang), measured: true });
  }

  const coLabel = t("impact.part.coChange", {}, lang);
  if (!c.files.length) parts.push({ label: coLabel, text: t("impact.reason.noFiles", {}, lang), measured: false });
  else if (c.repoError()) parts.push({ label: coLabel, text: t("impact.reason.gitFailed", { error: String(c.repoError()) }, lang), measured: false });
  else {
    /** @type {Map<string, Set<string>>} other file -> commits it shared with an input file */
    const shared = new Map();
    let failed = "";
    for (const file of c.files) {
      // --full-diff: without it --name-only lists only the pathspec itself and no co-change is ever visible.
      const args = ["-c", "core.quotePath=false", "log", "--no-merges", "--full-diff", "--format=%x01%H", "--name-only", "--", file];
      commands.push(`git log --no-merges --full-diff --format=%H --name-only -- ${file}`);
      let out = "";
      try {
        out = git(args, { cwd: c.cwd, walk: true });
      } catch (err) {
        failed ||= errorLine(err);
      }
      for (const chunk of out.split("\x01").slice(1)) {
        const [hash, ...names] = chunk.split("\n").filter(Boolean);
        for (const name of names) {
          if (c.files.includes(name) || c.excludeRe.test(name)) continue;
          if (!shared.has(name)) shared.set(name, new Set());
          /** @type {Set<string>} */ (shared.get(name)).add(hash);
        }
      }
    }
    if (failed) parts.push({ label: coLabel, text: t("impact.reason.gitFailed", { error: failed }, lang), measured: false });
    else {
      const top = [...shared]
        .map(([name, commits]) => ({ name, n: commits.size }))
        .filter((x) => x.n >= COCHANGE_MIN)
        .sort((x, y) => y.n - x.n || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
        .slice(0, 5);
      parts.push({
        label: coLabel,
        text: top.length ? top.map((x) => t("impact.s1.coChange", { file: x.name, n: x.n }, lang)).join(", ") : t("impact.s1.noCoChange", { min: COCHANGE_MIN }, lang),
        measured: true,
      });
    }
  }

  return { id: "S1", question: t("impact.q.S1", {}, lang), answer: answerFrom(parts, lang), commands };
}

/** @param {Context} c @returns {ImpactRow} */
function rowS2(c) {
  const { lang } = c;
  const question = t("impact.q.S2", {}, lang);
  if (!c.symbol) return { id: "S2", question, answer: t("impact.unmeasured", { reason: t("impact.reason.noSymbol", {}, lang) }, lang), commands: [] };
  const repoErr = c.repoError() ?? (c.refs() ? null : c.refsError);
  if (repoErr) return { id: "S2", question, answer: t("impact.unmeasured", { reason: t("impact.reason.gitFailed", { error: repoErr }, lang) }, lang), commands: [] };
  const referencing = [.../** @type {Map<string, number[]>} */ (c.refs()).keys()].filter((f) => !c.files.includes(f));
  const entries = referencing.filter((f) => ENTRY_POINT_RE.test(f));
  const answer = entries.length
    ? `${t("impact.s2.entries", { symbol: c.symbol }, lang)} ${capList(entries, lang)}`
    : t("impact.s2.none", { n: referencing.length }, lang);
  return { id: "S2", question, answer, commands: [c.grepCommand()] };
}

/** @param {Context} c @returns {ImpactRow} */
function rowS3(c) {
  const { lang } = c;
  const question = t("impact.q.S3", {}, lang);
  const un = (/** @type {string} */ reason) => ({ id: "S3", question, answer: t("impact.unmeasured", { reason }, lang), commands: [] });
  if (!c.files.length) return un(t("impact.reason.noFiles", {}, lang));
  const repoErr = c.repoError() ?? (c.tracked() ? null : c.trackedError);
  if (repoErr) return un(t("impact.reason.gitFailed", { error: repoErr }, lang));
  const tracked = /** @type {string[]} */ (c.tracked());
  const found = new Set();
  for (const file of c.files) {
    const dir = dirOf(file);
    const stem = stripExt(base(file));
    const near = tracked.filter((p) => {
      if (c.files.includes(p)) return false;
      if (dir && !p.startsWith(dir + "/")) return false;
      const rest = dir ? p.slice(dir.length + 1) : p;
      const adjacent = !rest.includes("/") || /^(?:__fixtures__|__tests__|tests?)\//.test(rest);
      // A sibling test counts only when it is about this file (named after it, or importing it);
      // a neighbour's test would make an untested file look covered.
      if (!adjacent || !/\.(?:test|spec)\./.test(base(p))) return false;
      if (base(p).startsWith(stem + ".")) return true;
      const abs = join(c.cwd, p);
      return present(abs) && specifiers(SPECIFIER_RE, readFileSync(abs, "utf8")).some((sp) => specifierRefersTo(sp, p, file));
    });
    // A test elsewhere (a top-level test/ directory) counts when an import statement names the file by a
    // relative path; an alias ("@/x") there may be another package's own file.
    for (const p of tracked) {
      if (near.includes(p) || c.files.includes(p) || !TEST_FILE_RE.test(p) || !CODE_EXT_RE.test(p)) continue;
      const abs = join(c.cwd, p);
      if (present(abs) && specifiers(STATEMENT_RE, readFileSync(abs, "utf8")).some((sp) => sp.startsWith(".") && specifierRefersTo(sp, p, file))) near.push(p);
    }
    // Fixtures and corpora near the file count when named after it or cited by one of its tests;
    // a shared __fixtures__/ directory holds other modules' recordings too.
    const cited = near.map((p) => (present(join(c.cwd, p)) ? readFileSync(join(c.cwd, p), "utf8") : ""));
    for (const p of tracked) {
      if (c.files.includes(p) || (dir && !p.startsWith(dir + "/"))) continue;
      const rest = dir ? p.slice(dir.length + 1) : p;
      const fixture = /(?:^|\/)__fixtures__\//.test(rest) && (!rest.includes("/") || /^__fixtures__\//.test(rest));
      const corpus = /corpus|derlem/i.test(rest);
      if (!fixture && !corpus) continue;
      if (base(p).includes(stem) || rest.includes(`${stem}/`) || cited.some((src) => src.includes(base(p)))) near.push(p);
    }
    // Tests named after the file first.
    near.sort((x, y) => Number(!base(x).startsWith(stem)) - Number(!base(y).startsWith(stem)) || (x < y ? -1 : x > y ? 1 : 0));
    for (const p of near) found.add(p);
  }
  const answer = found.size ? `${t("impact.s3.found", {}, lang)} ${capList([...found], lang)}` : t("impact.s3.buildCorpus", {}, lang);
  return { id: "S3", question, answer, commands: ["git ls-files"] };
}

/**
 * Registry entries as [label, value] pairs: array items, or the members of
 * (possibly grouped) maps.
 * @param {unknown} data
 * @returns {[string, unknown][]}
 */
function registryEntries(data) {
  /** @type {[string, unknown][]} */
  const out = [];
  const isMap = (/** @type {unknown} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
  /** @param {unknown} item @param {string} fallback */
  const label = (item, fallback) => {
    if (typeof item === "string") return clipped(item, 80, 79);
    if (isMap(item)) {
      const o = /** @type {Record<string, unknown>} */ (item);
      for (const k of ["id", "name", "key"]) if (typeof o[k] === "string") return /** @type {string} */ (o[k]);
    }
    return fallback;
  };
  if (Array.isArray(data)) data.forEach((item, i) => out.push([label(item, `#${i}`), item]));
  else if (isMap(data)) {
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (data))) {
      if (Array.isArray(v)) v.forEach((item, i) => out.push([label(item, `${k}#${i}`), item]));
      else if (isMap(v) && Object.values(/** @type {object} */ (v)).every(isMap)) {
        for (const [k2, v2] of Object.entries(/** @type {Record<string, unknown>} */ (v))) out.push([k2, v2]);
      } else out.push([k, v]);
    }
  }
  return out;
}

/** @param {Context} c @returns {ImpactRow} */
function rowS4(c) {
  const { lang, config } = c;
  const question = t("impact.q.S4", {}, lang);
  /** @type {string[]} */
  const commands = [];
  /** @type {Part[]} */
  const parts = [];

  const regLabel = t("impact.part.registry", {}, lang);
  const regPath = config.impact.ceilingRegistry;
  if (!c.files.length) parts.push({ label: regLabel, text: t("impact.reason.noFiles", {}, lang), measured: false });
  else if (!regPath) parts.push({ label: regLabel, text: t("impact.reason.noRegistry", {}, lang), measured: false });
  else {
    // Read as a regular file below the project, through no link a commit may hold.
    /** @type {Buffer | null | Error} */
    let read;
    try {
      read = readRegular(c.cwd, join(c.cwd, regPath));
    } catch (err) {
      read = /** @type {Error} */ (err);
    }
    if (read === null) parts.push({ label: regLabel, text: t("impact.reason.registryMissing", { path: regPath }, lang), measured: false });
    else {
      commands.push(`grep -F -e ${c.files.join(" -e ")} ${regPath}`);
      try {
        if (read instanceof Error) throw read;
        // A byte order mark some editors write is no part of the JSON.
        const entries = registryEntries(JSON.parse(read.toString("utf8").replace(/^\uFEFF/, "")));
        const hits = entries
          .filter(([key, value]) => {
            const text = key + "\n" + JSON.stringify(value);
            return c.files.some((f) => text.includes(f));
          })
          .map(([key]) => key);
        parts.push({
          label: regLabel,
          text: hits.length ? t("impact.s4.entries", { n: hits.length, list: capList(hits, lang) }, lang) : t("impact.s4.noEntries", {}, lang),
          measured: true,
        });
      } catch (err) {
        parts.push({ label: regLabel, text: t("impact.reason.registryUnreadable", { path: regPath, error: errorLine(err) }, lang), measured: false });
      }
    }
  }

  const fbLabel = t("impact.part.fallbacks", {}, lang);
  if (!c.files.length) parts.push({ label: fbLabel, text: t("impact.reason.noFiles", {}, lang), measured: false });
  else {
    commands.push(`grep -nE '\\bcatch\\b|return (\\[\\]|null|0)' ${c.files.join(" ")}`);
    const lines = c.files.map((file) => {
      const abs = join(c.cwd, file);
      if (!present(abs)) return t("impact.s4.fileMissing", { file }, lang);
      const src = readFileSync(abs, "utf8");
      const catches = src.match(CATCH_RE)?.length ?? 0;
      const returns = src.match(FALLBACK_RETURN_RE)?.length ?? 0;
      return t("impact.s4.fallbacks", { file, catches, returns }, lang);
    });
    parts.push({ label: fbLabel, text: lines.join("; "), measured: true });
  }

  return { id: "S4", question, answer: answerFrom(parts, lang), commands };
}

/**
 * Does an import / mock specifier written in `fromFile` name the module `file`?
 * Relative specifiers are resolved; alias specifiers ("@/lib/x", "~/x", "lib/x")
 * match by path suffix. Bare package names never match.
 * @param {string} spec
 * @param {string} fromFile
 * @param {string} file
 */
export function specifierRefersTo(spec, fromFile, file) {
  const target = stripExt(file);
  const targets = [target];
  if (target.endsWith("/index")) targets.push(target.slice(0, -"/index".length));
  if (spec.startsWith(".")) {
    const resolved = stripExt(posix.normalize(posix.join(dirOf(fromFile) || ".", spec)));
    return targets.includes(resolved);
  }
  const aliased = /^[@~#]\//.test(spec);
  const s = stripExt(spec.replace(/^[@~#]\//, ""));
  if (!aliased && !s.includes("/")) return false;
  return targets.some((tg) => tg === s || tg.endsWith("/" + s));
}

/**
 * @param {RegExp} re global regex with the specifier in group 2 (or 4)
 * @param {string} src
 */
function specifiers(re, src) {
  return [...src.matchAll(re)].map((m) => m[2] ?? m[4]);
}

/** @param {Context} c @returns {ImpactRow} */
function rowS5(c) {
  const { lang, config } = c;
  const question = t("impact.q.S5", {}, lang);
  const un = (/** @type {string} */ reason) => ({ id: "S5", question, answer: t("impact.unmeasured", { reason }, lang), commands: [] });
  if (!c.files.length) return un(t("impact.reason.noFiles", {}, lang));
  const repoErr = c.repoError() ?? (c.tracked() ? null : c.trackedError);
  if (repoErr) return un(t("impact.reason.gitFailed", { error: repoErr }, lang));

  const tracked = /** @type {string[]} */ (c.tracked());
  const tests = tracked.filter((p) => matchAny(p, config.impact.fakeGlobs) && !c.files.includes(p));
  const fixtures = tracked.filter((p) => matchAny(p, config.impact.fixtureGlobs));
  const lines = [];
  const unsourced = [];
  let fakeTests = 0;
  for (const test of tests) {
    const abs = join(c.cwd, test);
    if (!present(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const mocks = specifiers(MOCK_CALL_RE, src).some((s) => c.files.some((f) => specifierRefersTo(s, test, f)));
    const imports = specifiers(SPECIFIER_RE, src).some((s) => c.files.some((f) => specifierRefersTo(s, test, f)));
    if (!mocks && !imports) continue;
    const fakes = mocks || FAKE_RE.test(src);
    const cited = fixtures.filter((fx) => src.includes(base(fx)));
    const kind = mocks ? "impact.s5.mocks" : fakes ? "impact.s5.importsWithFakes" : "impact.s5.imports";
    const source = cited.length ? t("impact.s5.fixture", { list: capList(cited, lang) }, lang) : t("impact.s5.noFixture", {}, lang);
    lines.push(`${t(kind, { test }, lang)} — ${source}`);
    if (fakes) fakeTests += 1;
    if (fakes && !cited.length) unsourced.push(test);
  }
  const commands = [`git ls-files`, `grep -lE 'mock\\(|import|require' ${config.impact.fakeGlobs.join(" ")}`];
  if (!lines.length) return { id: "S5", question, answer: t("impact.s5.none", {}, lang), commands };
  const tail = unsourced.length
    ? t("impact.s5.unsourced", { list: capList(unsourced, lang) }, lang)
    : t(fakeTests ? "impact.s5.allSourced" : "impact.s5.noFakes", {}, lang);
  return { id: "S5", question, answer: [...lines.slice(0, LIST_MAX), tail].join("\n"), commands };
}

/**
 * @param {{ cwd: string, config: any, symbol?: string | null, files?: string[] }} opts
 * @returns {ImpactTable}
 */
export function buildImpactTable(opts) {
  const c = new Context(opts);
  // A file a row reads that is there but cannot be read leaves that row unmeasured, never "missing".
  const rows = /** @type {const} */ ([["S1", rowS1], ["S2", rowS2], ["S3", rowS3], ["S4", rowS4], ["S5", rowS5]]);
  return {
    rows: rows.map(([id, row]) => {
      try {
        return row(c);
      } catch (err) {
        const reason = errorLine(err);
        return { id, question: t(`impact.q.${id}`, {}, c.lang), answer: t("impact.unmeasured", { reason }, c.lang), commands: [] };
      }
    }),
  };
}

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

/**
 * @param {ImpactTable} table
 * @param {{ language: string }} config
 * @returns {string} markdown table
 */
export function formatImpactTable(table, config) {
  const lang = config.language;
  const head = ["impact.col.row", "impact.col.question", "impact.col.answer", "impact.col.commands"].map((k) => t(k, {}, lang));
  const out = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of table.rows) {
    const cmds = r.commands.map((x) => "`" + x.replace(/`/g, "'") + "`").join("<br>");
    out.push(`| ${r.id} | ${cell(r.question)} | ${cell(r.answer)} | ${cell(cmds)} |`);
  }
  return out.join("\n");
}
