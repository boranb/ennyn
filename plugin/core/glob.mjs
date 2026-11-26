/**
 * Minimal glob matcher shared by every module that matches paths
 * (rule front matter, impact globs, gate maps). Paths always use "/".
 *
 * Supported: `**` (any number of path segments, including none), `*` (within
 * one segment), `?` (one character within a segment, a letter outside the BMP too), `{a,b}` alternation
 * (no nesting), `[...]` character classes.
 *
 * A name matches when the pattern matches it as written, or composed (NFC) the pattern matches the
 * composed name: macOS and many editors write "ü" as "u" and a combining diaeresis, git on Linux keeps
 * the name as given, and a rule written with "ü" names that file too; a pattern with a combining mark
 * after glob syntax (`{e,o}\u0301.md`) still matches as written (test/input-shapes.test.mjs).
 */

const cache = new Map();

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re = "";
  let i = 0;
  let inGroup = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const atStart = i === 0 || pattern[i - 1] === "/";
        const atEnd = i + 2 === pattern.length || pattern[i + 2] === "/";
        if (atStart && atEnd) {
          // "**/" matches zero or more whole segments; trailing "**" matches the rest.
          if (pattern[i + 2] === "/") {
            re += "(?:[^/]+/)*";
            i += 3;
          } else {
            // Any character, line breaks and separators too: "." stops at them, and a name may hold one.
            re += "[\\s\\S]*";
            i += 2;
          }
          continue;
        }
        re += "[^/]*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      // One character: a pair of UTF-16 halves is one, as the name's own letter.
      re += "(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^/])";
      i += 1;
      continue;
    }
    if (c === "{") {
      inGroup = true;
      re += "(?:";
      i += 1;
      continue;
    }
    if (c === "}" && inGroup) {
      inGroup = false;
      re += ")";
      i += 1;
      continue;
    }
    if (c === "," && inGroup) {
      re += "|";
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      re += "[" + body.replace(/\\/g, "\\\\") + "]";
      i = close + 1;
      continue;
    }
    re += c.replace(/[.+^$()|\\]/g, "\\$&");
    i += 1;
  }
  const out = new RegExp("^" + re + "$");
  cache.set(pattern, out);
  return out;
}

/**
 * A glob that matches this path as written, and only it: each letter globToRegExp reads as syntax (`*`, `?`,
 * `[`, `{`, `}`) in a class of its own, which reads as that letter (`app/[locale]` → `app/[[]locale]`). The
 * others (`]`, `,`, `!`, `\`) are already letters outside a class and a group. Append `/**` for what is below.
 * @param {string} path
 */
export function literalGlob(path) {
  return path.replace(/[*?[{}]/g, "[$&]");
}

/** @param {string} s */
const plain = (s) => !/[^\x00-\x7f]/.test(s);

/**
 * @param {string} path project-relative, "/" separated; on Windows "\\" is taken for "/", elsewhere it is a
 *   character a name may hold (git's `src/a\\b.js` is a file in src/)
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function matchAny(path, patterns) {
  const p = (process.platform === "win32" ? path.replace(/\\/g, "/") : path).replace(/^\.\//, "");
  return patterns.some((pat) => globToRegExp(pat).test(p) || (!(plain(p) && plain(pat)) && globToRegExp(pat.normalize("NFC")).test(p.normalize("NFC"))));
}
