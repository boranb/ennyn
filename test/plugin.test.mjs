import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../core/i18n.mjs";
import { FILE_TOOLS } from "../adapters/claude-code/hooks/side-copy-rules.mjs";

// What `claude plugin validate --strict` checks, for machines without the claude CLI.
// Origin: a ": " inside an unquoted agent description made the YAML unparsable, and
// Claude Code then loaded the security reviewer with no name and no description.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

/** @param {string} text @returns {Map<string, string> | null} raw values by key */
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = new Map();
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (kv) out.set(kv[1], kv[2]);
  }
  return out;
}

/** A plain (unquoted) YAML scalar that a parser reads as one string. @param {string} v */
function plainScalarProblem(v) {
  if (/^["']/.test(v)) return null;
  if (/^[[\]{}&*!%@`|>#,?-]/.test(v)) return "starts with a YAML indicator";
  if (/: /.test(v) || /:$/.test(v)) return 'holds ": " (read as a new key)';
  if (/ #/.test(v)) return 'holds " #" (read as a comment)';
  return null;
}

const agents = readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).map((f) => ({ path: `agents/${f}`, name: basename(f, ".md") }));
const skills = readdirSync(join(ROOT, "skills")).filter((d) => existsSync(join(ROOT, "skills", d, "SKILL.md"))).map((d) => ({ path: `skills/${d}/SKILL.md`, name: d }));

test("plugin: every agent and skill has front matter a YAML parser reads, named after its file", () => {
  assert.ok(agents.length >= 3 && skills.length >= 2, "agents and skills found");
  for (const { path, name } of [...agents, ...skills]) {
    const fm = frontMatter(read(path));
    assert.ok(fm, `${path}: front matter between --- lines`);
    assert.equal(fm.get("name"), name, `${path}: name`);
    assert.ok((fm.get("description") ?? "").length > 20, `${path}: description`);
    for (const [key, value] of fm) {
      const problem = plainScalarProblem(value);
      assert.equal(problem, null, `${path}: ${key} ${problem}`);
    }
  }
  // The check itself rejects the defect that started it.
  assert.ok(plainScalarProblem("Starts from the path table: every way in"));
  assert.equal(plainScalarProblem('Review — "how does this break?". Use after a task.'), null);
});

test("plugin: every SKILL.md stays under 8 KB (DESIGN.md: skills are read whole, every time)", () => {
  for (const { path } of skills) assert.ok(statSync(join(ROOT, path)).size < 8 * 1024, `${path}: ${statSync(join(ROOT, path)).size} bytes`);
});

test("plugin: hook commands point at files that exist; manifests agree on name and version", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  const commands = Object.values(hooks).flatMap((/** @type {any[]} */ groups) => groups.flatMap((g) => g.hooks.map((/** @type {any} */ h) => h.command)));
  assert.ok(commands.length >= 3);
  for (const c of commands) {
    const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(c);
    assert.ok(m, `command names a file under the plugin root: ${c}`);
    assert.ok(existsSync(join(ROOT, m[1])), `${m[1]} exists`);
  }
  const pkg = JSON.parse(read("package.json"));
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(plugin.name, pkg.name);
  assert.equal(market.name, pkg.name);
  assert.deepEqual(market.plugins.map((/** @type {any} */ p) => p.name), [pkg.name]);
  assert.equal(plugin.version, pkg.version, "a push without a version bump never reaches users; bump both together");
  // The plugin root is the repository root, so a root CLAUDE.md would be shipped and ignored.
  assert.ok(!existsSync(join(ROOT, "CLAUDE.md")), "developer notes live in .claude/CLAUDE.md");
});

/**
 * Markdown files below `dir`, relative. A walk of its own: Node 20.0 ignores readdirSync's recursive option and
 * lists the top only, so the nested documents went unread on the floor (test/guards.mjs, plugin-pipe).
 * @param {string} dir @returns {string[]}
 */
function markdownFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : markdownFiles(rel);
    return e.name.endsWith(".md") ? [rel] : [];
  });
}

test("docs: no table cell holds an unescaped | inside code (GitHub splits the row there)", () => {
  const tracked = markdownFiles("");
  assert.ok(["docs/evidence.md", "skills/cycle/SKILL.md", "agents/code-reviewer.md", "README.md"].every((f) => tracked.includes(f)), `nested documents read: ${tracked.length}`);
  const bad = [];
  for (const f of tracked) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (!line.startsWith("|")) return;
        for (const span of line.match(/`[^`]*`/g) ?? []) if (/(?<!\\)\|/.test(span)) bad.push(`${f}:${i + 1} ${span}`);
      });
  }
  assert.deepEqual(bad, []);
});

test("i18n: every English key exists in every catalog, vars interpolate, fallback works", () => {
  const en = Object.keys(JSON.parse(read("i18n/en.json"))).sort();
  const catalogs = readdirSync(join(ROOT, "i18n")).filter((f) => f.endsWith(".json") && f !== "en.json");
  assert.ok(catalogs.includes("tr.json"), `catalogs: ${catalogs}`);
  for (const f of catalogs) assert.deepEqual(Object.keys(JSON.parse(read(`i18n/${f}`))).sort(), en, f);
  assert.match(t("shape.subjectTooLong", { len: 130, max: 120 }, "tr"), /130 karakter; sınır 120/);
  assert.throws(() => t("no.such.key"));
});

test("hooks.json: the PostToolUse matcher sends exactly the file tools the side-copy hook handles, by a quoted command that resolves to it", () => {
  const [entry] = JSON.parse(read("hooks/hooks.json")).hooks.PostToolUse;
  assert.deepEqual(entry.matcher.split("|").sort(), [...FILE_TOOLS].sort());
  const [cmd] = entry.hooks;
  assert.equal(cmd.type, "command");
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(cmd.command);
  assert.ok(m, `command must quote \${CLAUDE_PLUGIN_ROOT}: ${cmd.command}`);
  assert.equal(m[1], "adapters/claude-code/hooks/side-copy-rules.mjs");
  assert.ok(read(m[1]).startsWith("#!/usr/bin/env node\n"));
});
