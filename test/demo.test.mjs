/**
 * The demo image at the top of the READMEs (docs/assets/demo.svg) is what test/demo/make.mjs makes now: the sample
 * project is built again in a temporary directory, the CLI runs on it, and the image must equal the committed file
 * byte for byte. A change to what the CLI prints for these steps fails here until the image is made again with
 * `node test/demo/make.mjs` and committed with the change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLS, OUT, make, svg, wrap } from "./demo/make.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("demo: the committed image is what the generator makes now, and a changed line of output would differ", () => {
  const committed = readFileSync(OUT, "utf8");
  const fresh = make();
  assert.equal(fresh.svg, committed, "docs/assets/demo.svg drifted from the CLI's output: run node test/demo/make.mjs and commit the image");
  // The control: one changed character of the transcript makes another image, so the comparison above can fail.
  const changed = fresh.lines.map((l) => l.replace(/found in review (\d)/, (_, n) => `found in review ${Number(n) + 1}`));
  assert.notDeepEqual(changed, fresh.lines, "the control changed no line");
  assert.notEqual(svg(changed), committed);
  // What the image shows: the three steps, the sample's place and no other path.
  for (const cmd of ["$ ennyn init-scan", "$ ennyn core"]) assert.ok(fresh.lines.includes(cmd), cmd);
  assert.ok(fresh.lines.some((l) => /^\$ ennyn convergence --cycle 1 --from [0-9a-f]{7}$/.test(l)));
  assert.ok(fresh.lines.some((l) => l.startsWith("Findings: ")), "the convergence block");
  assert.deepEqual(fresh.lines.filter((l) => /(^|[\s(])\/(?!ennyn:)\w/.test(l)), [], "an absolute path in the transcript");
  assert.ok(Buffer.byteLength(committed) < 64 * 1024, "the image stays small");
});

test("demo: wrapping keeps every character, no row is wider than the frame, and the text is escaped", () => {
  const line = `${"word ".repeat(60)}${"x".repeat(COLS + 7)} end`;
  const rows = wrap(line);
  assert.equal(rows.length, 6);
  for (const r of rows) assert.ok([...r].length <= COLS, r);
  assert.ok(rows.slice(1).every((r) => r.startsWith("  ")), "the rest of the line is indented by two");
  // Only the space a row breaks at goes; a word longer than a row is cut where the row ends.
  assert.equal(rows.map((r, i) => (i ? r.slice(2) : r)).join("").replace(/ /g, ""), line.replace(/ /g, ""));
  assert.ok(rows[0].endsWith("word") && rows[1].startsWith("  word"), "a break at a space");
  assert.deepEqual(wrap("short"), ["short"]);
  assert.deepEqual(wrap("x".repeat(COLS)), ["x".repeat(COLS)]);
  // The CLI's text is data in the image: markup in it is shown, never read as markup.
  const image = svg(["$ ennyn x", 'a <b>"c"</b> & d']);
  assert.ok(image.includes("a &lt;b&gt;&quot;c&quot;&lt;/b&gt; &amp; d"), image);
  assert.ok(!image.includes("<b>"));
});

test("demo: both READMEs show the image at the top", () => {
  for (const file of ["README.md", "README.tr.md"]) {
    const head = readFileSync(join(ROOT, file), "utf8").split("\n").slice(0, 20).join("\n");
    assert.match(head, /!\[[^\]]+\]\(docs\/assets\/demo\.svg\)/, file);
  }
});
