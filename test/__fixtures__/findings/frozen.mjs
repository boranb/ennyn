/**
 * A frozen synthetic ledger: every combination the decision table reads, on a repository of five steps. The numbers
 * test/findings.test.mjs holds it to came from two readings of the table written apart from the command (cycle 16:
 * a script of the task that wrote the table, and its reviewer's). See that test for the one line they differ on.
 */

const SOURCES = ["first-write", "previous-fix", "pre-existing"];
const CAUGHT = ["review", "measurement", "author-reading", "test:test/tracked.test.mjs", "test:test/unlanded.test.mjs", "gate:mutation"];
const OUTCOMES = ["open", "refuted", "fixed-test"];
const FIRST = "c16-frozen-first";

/**
 * @param {{ legacy: string, adopt: string, earlier: string, start: string, now: string }} steps the repository's commits
 * @returns {Record<string, unknown>[]}
 */
export function frozenRows(steps) {
  const base = { cycle: 16, task: "frozen", severity: "low", escapePoint: "none", trigger: "a frozen case", commit: null, file: "code.js", line: 1 };
  /** @type {Record<string, unknown>[]} */
  const rows = [{ ...base, round: 0, id: FIRST, class: ["new: class 0"], source: "first-write", caughtBy: "review", dupOf: null, fingerprint: "frozen first", outcome: "open", bornIn: null }];
  let n = 0;
  for (const source of SOURCES) {
    for (const caughtBy of CAUGHT) {
      for (const dupOf of [null, FIRST]) {
        for (const outcome of OUTCOMES) {
          for (const bornIn of source === "pre-existing" ? Object.values(steps) : [null]) {
            n++;
            rows.push({ ...base, round: n % 5, id: `c16-frozen-${n}`, class: [`new: class ${n % 37}`, ...(n % 13 === 0 ? [`new: class ${n % 7}b`] : [])], source, caughtBy, dupOf, fingerprint: `frozen case ${n}`, outcome, bornIn });
          }
        }
      }
    }
  }
  return rows;
}

/** Rows of no age beside the ones above: `?` in the four columns, and the two others as they were. */
export const noAgeRows = () => [null, "1".repeat(40)].map((bornIn, i) => ({ cycle: 16, task: "frozen", severity: "low", escapePoint: "none", trigger: "a frozen case", commit: null, file: "code.js", line: 1, round: 1, id: `c16-frozen-noage-${i}`, class: ["new: class 0"], source: "pre-existing", caughtBy: "review", dupOf: null, fingerprint: `frozen no age ${i}`, outcome: "open", bornIn }));
