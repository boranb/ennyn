/**
 * How the guards test reads a gate file's tests: the top-level `test("…")` names, every call that declares a
 * test (in code only: comments and the text of strings, templates and regular expressions blanked), and the
 * accounting of a gate's guards against them. test/guards.test.mjs decides each gate file with it;
 * test/verdicts/declarations.json keeps the forms it was given, with their verdicts.
 */

/** The names of the top-level tests a file declares. @param {string} text */
export const testNames = (text) => [...text.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));

/**
 * The file's code with comments taken out and the text inside strings, template literals and regular
 * expression literals blanked (delimiters and line breaks kept), so a count of calls reads code only.
 * @param {string} text
 */
export function codeOf(text) {
  let out = "";
  /** @type {number[]} brace depth outside each open template expression */
  const outer = [];
  let depth = 0;
  let i = 0;
  const blank = (/** @type {string} */ c) => (c === "\n" ? "\n" : " ");
  // The rest of a quoted text from i (past its opening quote); a template stops at `${` too.
  const quoted = (/** @type {string} */ q) => {
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        out += blank(c) + blank(text[i + 1] ?? "");
        i++;
      } else if (c === q) {
        out += q;
        i++;
        return false;
      } else if (q === "`" && c === "$" && text[i + 1] === "{") {
        out += "${";
        i += 2;
        return true;
      } else if (q !== "`" && c === "\n") return false;
      else out += blank(c);
    }
    return false;
  };
  const template = () => {
    if (quoted("`")) {
      outer.push(depth);
      depth = 0;
    }
  };
  // A slash starts a regular expression where a value may begin, not after one.
  const valueMayStart = () => {
    const before = out.trimEnd();
    return before === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/.test(before);
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "'" || c === '"') {
      out += c;
      i++;
      quoted(c);
    } else if (c === "`") {
      out += c;
      i++;
      template();
    } else if (c === "}" && outer.length && depth === 0) {
      out += c;
      i++;
      depth = /** @type {number} */ (outer.pop());
      template();
    } else if (c === "/" && valueMayStart()) {
      out += c;
      let cls = false;
      for (i++; i < text.length && text[i] !== "\n"; i++) {
        const d = text[i];
        if (d === "\\") {
          out += "  ";
          i++;
        } else if (cls ? d === "]" : d === "[") {
          cls = !cls;
          out += " ";
        } else if (!cls && d === "/") {
          out += d;
          i++;
          break;
        } else out += " ";
      }
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Calls that declare a test, wherever they are (a loop, a block, after await; test.skip, it, describe; a space
 * before the parenthesis), in code only (codeOf: a glob like "docs/*.md" in a string is no comment), a subtest
 * (`t.test(`) not counted; and whether node:test's functions are imported under other names (`test as check`,
 * a default or namespace import), which no count could follow.
 * @param {string} text
 */
export const declarations = (text) => {
  const calls = [...codeOf(text).matchAll(/(?<![\w.$])(?:test|it|describe|suite)\s*(?:\??\.\s*\w+\s*|\[[^\]]*\]\s*)?(?:\?\.)?\(/g)].length;
  const imports = [...text.matchAll(/^import\s+([^;]*?)\s+from\s+["'](?:node:)?test["']/gm)].map((m) => m[1]);
  const renamed = imports.some((i) => !/^\{[^}]*\}$/.test(i.trim()) || /\bas\b/.test(i));
  return { calls, renamed };
};

/**
 * A gate file's tests, each decided: named by exactly one guard's pattern, or listed in `others` with why it has
 * no guard, never both; each pattern names exactly one test; every name in `others` is a test of the file; and
 * every top-level test is declared in the form testNames reads, so none goes uncounted.
 * @param {import("./guards.mjs").Gate} gate @param {string} text the gate file
 * @returns {string[]}
 */
export function accounting(gate, text) {
  const names = testNames(text);
  const others = gate.others ?? {};
  const out = [];
  const declared = declarations(text);
  if (declared.renamed) out.push(`${gate.test}: node:test is imported under another name; declare tests as test("…")`);
  if (declared.calls !== names.length) out.push(`${gate.test}: ${declared.calls} tests declared, ${names.length} read as a top-level test("…"): declare each so`);
  for (const g of gate.guards) {
    const named = names.filter((n) => new RegExp(g.pattern).test(n));
    if (named.length !== 1) out.push(`${g.id}: its pattern names ${named.length} tests of ${gate.test}, not one${named.length ? `: ${named.join(" | ")}` : ""}`);
  }
  for (const n of names) {
    const guarded = gate.guards.some((g) => new RegExp(g.pattern).test(n));
    if (guarded && Object.hasOwn(others, n)) out.push(`${gate.test}: "${n}" has a guard and is in others`);
    else if (!guarded && !Object.hasOwn(others, n)) out.push(`${gate.test}: "${n}" has no guard, and others does not say why`);
  }
  for (const [n, why] of Object.entries(others)) {
    if (!names.includes(n)) out.push(`${gate.test}: others names "${n}", no test of the file`);
    else if (!why.trim()) out.push(`${gate.test}: others gives no reason for "${n}"`);
  }
  return out;
}
