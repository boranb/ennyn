/**
 * Minimal glob matcher shared by every module that matches paths
 * (rule front matter, impact globs, gate maps). Paths always use "/".
 *
 * Supported: `**` (any number of path segments, including none), `*` (within
 * one segment), `?` (one character within a segment), `{a,b}` alternation
 * (no nesting), `[...]` character classes.
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
            re += ".*";
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
      re += "[^/]";
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
 * @param {string} path project-relative, "/" separated
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function matchAny(path, patterns) {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pat) => globToRegExp(pat).test(p));
}
