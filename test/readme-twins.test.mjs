/**
 * README.md and README.tr.md say the same thing. A test cannot read the prose, but it can read what does
 * not change with the language: the headings and their levels, and per section the list items, quotes,
 * bold claims, table rows with the code in each cell, code blocks, code spans, link targets and numbers.
 * A row, a bullet, a command or a number added to one file and not the other fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TWINS = [
  { file: "README.md", lang: "en" },
  { file: "README.tr.md", lang: "tr" },
];
const SWITCH = new Set(TWINS.map((t) => t.file));
const SPAN = /`[^`\n]+`/g;
const FENCE = /^ *(```|~~~)[^\n]*\n([\s\S]*?)^ *\1/gm;

/**
 * What a translation keeps, section by section (a heading opens one and belongs to it).
 * @param {string} text
 */
function shape(text) {
  /** @type {{ level: number, lines: string[] }[]} */
  const sections = [{ level: 0, lines: [] }];
  let fence = "";
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const f = /^ *(```|~~~)/.exec(line)?.[1];
    if (f && (!fence || f === fence)) fence = fence ? "" : f;
    const h = fence || f ? null : /^(#{1,6}) /.exec(line);
    if (h) sections.push({ level: h[1].length, lines: [] });
    sections[sections.length - 1].lines.push(line);
  }
  return sections.map(({ level, lines }) => {
    const body = lines.join("\n");
    const blocks = [...body.matchAll(FENCE)].map((m) => m[2]);
    const prose = body.replace(FENCE, "");
    const rows = prose.split("\n").filter((l) => l.startsWith("|"));
    // Each row's cells, with the code spans in each: cells keep their order in a translation.
    const table = rows.map((r) => r.split(/(?<!\\)\|/).slice(1, -1).map((cell) => (cell.match(SPAN) ?? []).sort().join(" ")));
    const lists = prose.split("\n").flatMap((l) => /^( *)(?:[-*+]|\d+\.) /.exec(l)?.[1].length ?? []);
    const quotes = prose.split("\n").filter((l) => /^ *>/.test(l)).length;
    const bold = (prose.match(/\*\*[^*\n]+\*\*/g) ?? []).length;
    const spans = (prose.match(SPAN) ?? []).sort();
    const words = prose.replace(SPAN, " ");
    const targets = [
      ...[...words.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
      // Reference definitions, not footnotes ("[^1]: text").
      ...[...words.matchAll(/^ *\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((m) => m[1]),
      // A bare URL ends before closing punctuation or a Turkish suffix ("…/a'da").
      ...[...words.matchAll(/<(https?:\/\/[^>\s]+)>|(?<![(<"])\b(https?:\/\/[^\s)>'’[]+)/g)].map((m) => m[1] ?? m[2].replace(/[.,;:!?]+$/, "")),
      ...[...words.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ];
    // Anchors in the same page are named after the heading, which is translated.
    const links = targets.filter((u) => !SWITCH.has(u) && !u.startsWith("#")).sort();
    const plain = words.replace(/\]\([^)]*\)/g, "]").replace(/^ *\[(?!\^)[^\]]+\]:.*$/gm, "");
    // One separator for both languages, so 0.5 = 0,5 and 1,000 = 1.000, but 0.1 ≠ 1.0; a percentage is
    // kept as one, so %66 = 66% and a dropped % shows.
    const sep = (/** @type {string} */ n) => n.replace(/[.,]/g, ".");
    const numbers = [...(plain.match(/\d+(?:[.,]\d+)*/g) ?? []).map(sep), ...(plain.match(/\d+(?:[.,]\d+)*%|%\d+(?:[.,]\d+)*/g) ?? []).map((p) => `${sep(p.replace("%", ""))}%`)].sort();
    return { level, lists, quotes, bold, table, blocks, spans, links, numbers };
  });
}

/**
 * Whether two code blocks agree. A block's first "language" value may be its own README's language
 * where its twin has the twin's ("language": "tr" in the Turkish example config); every other byte is the
 * same.
 * @param {string} a @param {string} b @param {string} langA @param {string} langB
 */
function sameBlock(a, b, langA, langB) {
  const LANG = /("(?:en|tr)")/;
  const [x, y] = [a.split(LANG), b.split(LANG)];
  if (x.length !== y.length) return false;
  const own = x.findIndex((part, i) => i % 2 === 1 && /"language":\s*$/.test(x[i - 1]));
  return x.every((part, i) => part === y[i] || (i === own && part === `"${langA}"` && y[i] === `"${langB}"`));
}

/**
 * Every difference, as "section n (heading level) key: a ≠ b".
 * @param {ReturnType<typeof shape>} a @param {ReturnType<typeof shape>} b @param {string} langA @param {string} langB
 */
function differences(a, b, langA, langB) {
  const out = [];
  if (a.length !== b.length) out.push(`sections: ${a.length} ≠ ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const key of /** @type {const} */ (["level", "lists", "quotes", "bold", "table", "spans", "links", "numbers", "blocks"])) {
      const [x, y] = [a[i][key], b[i][key]];
      const same =
        key === "blocks"
          ? /** @type {string[]} */ (x).length === /** @type {string[]} */ (y).length && /** @type {string[]} */ (x).every((blk, j) => sameBlock(blk, /** @type {string[]} */ (y)[j], langA, langB))
          : JSON.stringify(x) === JSON.stringify(y);
      if (!same) out.push(`section ${i} (level ${a[i].level}) ${key}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
    }
  }
  return out;
}

test("docs: README.md and README.tr.md keep the same headings, lists, tables, code, links and numbers", () => {
  const [en, tr] = TWINS.map((t) => shape(readFileSync(join(ROOT, t.file), "utf8")));
  assert.deepEqual(differences(en, tr, "en", "tr"), []);
  // Each points at the other in its first lines.
  for (const [i, t] of TWINS.entries()) assert.match(readFileSync(join(ROOT, t.file), "utf8").split("\n").slice(0, 4).join("\n"), new RegExp(`\\]\\(${TWINS[1 - i].file.replace(".", "\\.")}\\)`));
});

test("docs: the twin check fails on drift a translation never makes, and passes a translation", () => {
  const en = [
    "# T `v1`",
    "",
    "Intro with 21 cycles, 66% of them, 0.5 each, 0.2% off, version **0.1**. See [below](#install) or https://example.org/c.[^1]",
    "",
    "> Status: early.",
    "",
    "- **One** thing",
    "- Another, [d](docs/d.md \"Doc\")",
    "  - nested",
    "",
    "## A",
    "",
    "| a | b |",
    "|---|---|",
    "| x `cmd` | y `other` unless `skip` |",
    "| z `third` | w |",
    "",
    "```sh",
    'run --commits "en"',
    "```",
    "",
    "```json",
    '{ "language": "en", "commitMsg": { "language": "en" } }',
    "```",
    "",
    "~~~",
    "plain",
    "~~~",
    "",
    "[ref]: docs/ref.md",
    "[^1]: Measured over 21 cycles.",
    "Also <https://example.org/b>, <a href=\"docs/a.html\">here</a>.",
    "",
  ].join("\n");
  const tr = [
    "# T `v1`",
    "",
    "21 döngülük giriş, %66'sı, her biri 0,5, %0,2 eksik, sürüm **0.1**. Bkz. [aşağı](#kurulum) ya da https://example.org/c'de.[^1]",
    "",
    "> Durum: erken.",
    "",
    "- **Bir** şey",
    "- Başka, [d](docs/d.md \"Belge\")",
    "  - iç içe",
    "",
    "## A çevrildi",
    "",
    "| a | b |",
    "|---|---|",
    "| x `cmd` | `skip` değilse y `other` çevrildi |",
    "| z `third` | w |",
    "",
    "```sh",
    'run --commits "en"',
    "```",
    "",
    "```json",
    '{ "language": "tr", "commitMsg": { "language": "en" } }',
    "```",
    "",
    "~~~",
    "plain",
    "~~~",
    "",
    "[ref]: docs/ref.md",
    "[^1]: 21 döngüde ölçüldü.",
    "Ayrıca <https://example.org/b>, <a href=\"docs/a.html\">burada</a>.",
    "",
  ].join("\n");
  const check = (/** @type {string} */ other) => differences(shape(en), shape(other), "en", "tr");
  assert.deepEqual(check(tr), []);
  const broken = {
    row: tr.replace("| z `third` | w |\n", "| z `third` | w |\n| q | r |\n"),
    column: tr.replace("| a | b |", "| a | b | c |"),
    "span moved to another row": tr.replace("| x `cmd` |", "| x `third` |").replace("| z `third` | w |", "| z `cmd` | w |"),
    number: tr.replace("21 döngülük", "22 döngülük"),
    percent: tr.replace("%66'sı", "66'sı"),
    command: tr.replace("x `cmd`", "x `cmd2`"),
    "heading code": tr.replace("# T `v1`", "# T `v2`"),
    link: tr.replace("docs/d.md", "docs/e.md"),
    "reference link": tr.replace("[ref]: docs/ref.md", "[ref]: docs/other.md"),
    autolink: tr.replace("<https://example.org/b>", "<https://example.org/y>"),
    heading: tr.replace("## A çevrildi", "### A çevrildi"),
    section: tr + "\n## Ek\n\nYalnız burada.\n",
    bullet: tr.replace("- Başka, [d](docs/d.md \"Belge\")\n", "[d](docs/d.md \"Belge\")\n"),
    nesting: tr.replace("  - iç içe", "- iç içe"),
    quote: tr.replace("> Durum: erken.", "Durum: erken."),
    bold: tr.replace("**Bir**", "Bir"),
    code: tr.replace('run --commits "en"', 'run --commits "tr"'),
    "tilde fence": tr.replace("~~~\nplain\n~~~", "~~~\nplain too\n~~~"),
    "extra block": tr.replace("~~~\nplain\n~~~", "~~~\nplain\n~~~\n\n```\nextra\n```"),
    version: tr.replace("sürüm **0.1**", "sürüm **1.0**"),
    "second language key": tr.replace('"commitMsg": { "language": "en" }', '"commitMsg": { "language": "tr" }'),
    "bare url": tr.replace("https://example.org/c'de", "https://example.org/x'de"),
    "html link": tr.replace("docs/a.html", "docs/b.html"),
  };
  for (const [what, text] of Object.entries(broken)) assert.notDeepEqual(check(text), [], what);
  // A block that names both languages, byte for byte the same in both files, is no difference.
  const TR_CONFIG = '{ "language": "tr", "commitMsg": { "language": "en" } }';
  const mixed = en.replace('{ "language": "en", "commitMsg": { "language": "en" } }', TR_CONFIG);
  assert.deepEqual(differences(shape(mixed), shape(tr), "en", "tr"), []);
  // Only the README's own language may stand where its twin names the twin's, not the other way round.
  assert.notDeepEqual(differences(shape(mixed), shape(tr.replace(TR_CONFIG, '{ "language": "en", "commitMsg": { "language": "en" } }')), "en", "tr"), []);
});
