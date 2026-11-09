/**
 * The kill signal reader: every call of node's child_process functions (spawn, spawnSync, execFile, execFileSync,
 * exec, execSync, fork) that is given a time limit (`timeout`, or an abort `signal` such as AbortSignal.timeout) names
 * the signal that ends the child at it (`killSignal`), as a string literal or a `const` of one. Node's default is
 * SIGTERM, which a child, or a program that wraps one (unshare, a shell, sandbox-exec), can ignore: measured in cycle
 * 2026-11-09 (30) on Node 22.23.4, a spawnSync with a 1 s limit and no kill signal waited 8 s for a child that ignored
 * SIGTERM, and with SIGKILL returned at 1 s.
 *
 * It reads text, by tokens: comments and strings are no code, a template's `${}` is. It knows the functions by the
 * names a file binds from child_process (an import, a namespace, a destructured load by require, import(), a
 * createRequire loader or process.getBuiltinModule; a call of any other call's result is `unreadable`) and their
 * aliases (`const run = spawnSync`, a parameter's default `run = spawnSync`, `promisify(execFile)`), and reads a
 * call's options when they are an object literal, a spread or name of a `const` object literal declared once in the
 * file, either in parentheses, or nothing. Every other shape is `unreadable`, never passed: options in a parameter
 * or built by a call, a spread of something unread, a computed key, the function or the namespace passed as a value,
 * a call it cannot close. Stated limits: a name is found in the whole file, so a parameter of the same name as a
 * `const` or an alias is read as that constant or function; code in a string (a child's `-e` text) is not read; a
 * regular expression the reader takes for a division is read as code, and a backtick in it opens a template that
 * hides the lines after it up to the next backtick.
 */

const NAMES = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
/** The functions whose second argument is the command's words, the options after them. */
const WITH_ARGS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);
const MODULES = new Set(["child_process", "node:child_process"]);
/** Words after which a `/` starts a regular expression. */
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** @typedef {{ t: "id" | "num" | "str" | "tmpl" | "re" | "p", v: string, line: number }} Token */
/** @typedef {{ line: number, verdict: "no-kill-signal" | "unreadable", why: string }} Problem */

/**
 * The source's tokens; comments dropped, a string's value without its quotes, a template's text parts as `tmpl`.
 * @param {string} s @returns {Token[]}
 */
export function tokens(s) {
  /** @type {Token[]} */
  const out = [];
  /** @type {string[]} what each open `{` is: a block or object, or a template's `${` */
  const braces = [];
  let i = 0;
  let line = 1;
  const push = (/** @type {Token["t"]} */ t, /** @type {string} */ v, /** @type {number} */ at) => out.push({ t, v, line: at });
  /** A template's text from `i` to its end or its next `${`. */
  const template = () => {
    const at = line;
    let text = "";
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        text += s.slice(i, i + 2);
        if (s[i + 1] === "\n") line++;
        i += 2;
      } else if (c === "`") {
        i++;
        push("tmpl", text, at);
        return;
      } else if (c === "$" && s[i + 1] === "{") {
        i += 2;
        braces.push("${");
        push("tmpl", text, at);
        return;
      } else {
        if (c === "\n") line++;
        text += c;
        i++;
      }
    }
    push("tmpl", text, at);
  };
  if (s.startsWith("#!")) i = s.indexOf("\n") < 0 ? s.length : s.indexOf("\n");
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (let k = i; k < stop; k++) if (s[k] === "\n") line++;
      i = stop;
    } else if (c === '"' || c === "'") {
      const at = line;
      let k = i + 1;
      let text = "";
      while (k < s.length && s[k] !== c && s[k] !== "\n") {
        if (s[k] === "\\") {
          if (s[k + 1] === "\n") line++;
          text += s.slice(k, k + 2);
          k += 2;
        } else text += s[k++];
      }
      i = k + 1;
      push("str", text, at);
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/") {
      const prev = out[out.length - 1];
      const regex = !prev || (prev.t === "p" && prev.v !== ")" && prev.v !== "]") || (prev.t === "id" && BEFORE_REGEX.has(prev.v)) || prev.t === "tmpl";
      if (!regex) {
        push("p", "/", line);
        i++;
        continue;
      }
      let k = i + 1;
      let inClass = false;
      while (k < s.length && s[k] !== "\n") {
        if (s[k] === "\\") k += 2;
        else if (s[k] === "[") (inClass = true), k++;
        else if (s[k] === "]") (inClass = false), k++;
        else if (s[k] === "/" && !inClass) break;
        else k++;
      }
      k++;
      while (k < s.length && /[a-z]/i.test(s[k])) k++;
      push("re", s.slice(i, k), line);
      i = k;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[\w$]+/.exec(s.slice(i, i + 200));
      const word = m ? m[0] : c;
      push("id", word, line);
      i += word.length;
    } else if (/\d/.test(c) || (c === "." && /\d/.test(s[i + 1] ?? ""))) {
      const m = /^[\w.]+/.exec(s.slice(i, i + 100));
      const num = m ? m[0] : c;
      push("num", num, line);
      i += num.length;
    } else if (c === "{") {
      braces.push("{");
      push("p", c, line);
      i++;
    } else if (c === "}") {
      i++;
      if (braces.pop() === "${") template();
      else push("p", c, line);
    } else if (s.startsWith("...", i)) {
      push("p", "...", line);
      i += 3;
    } else if (s.startsWith("=>", i) || s.startsWith("?.", i)) {
      push("p", s.slice(i, i + 2), line);
      i += 2;
    } else {
      push("p", c, line);
      i++;
    }
  }
  return out;
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/**
 * The index of the token that closes the one at `at`, or -1.
 * @param {Token[]} ts @param {number} at
 */
function closing(ts, at) {
  /** @type {string[]} */
  const want = [];
  for (let k = at; k < ts.length; k++) {
    const { t, v } = ts[k];
    if (t !== "p") continue;
    if (v in OPEN) want.push(OPEN[/** @type {keyof typeof OPEN} */ (v)]);
    else if (v === ")" || v === "]" || v === "}") {
      if (want.pop() !== v) return -1;
      if (!want.length) return k;
    }
  }
  return -1;
}

/**
 * The parts of `ts[from..to)` between commas at the top level.
 * @param {Token[]} ts @param {number} from @param {number} to @returns {Token[][]}
 */
function parts(ts, from, to) {
  /** @type {Token[][]} */
  const out = [];
  let depth = 0;
  let cur = [];
  for (let k = from; k < to; k++) {
    const { t, v } = ts[k];
    if (t === "p" && v in OPEN) depth++;
    if (t === "p" && (v === ")" || v === "]" || v === "}")) depth--;
    if (t === "p" && v === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(ts[k]);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Whether a part is a whole bracketed literal: it opens with `open` and its close is its last token. @param {Token[]} part @param {string} open */
const whole = (part, open) => part.length > 1 && part[0].t === "p" && part[0].v === open && closing(part, 0) === part.length - 1;

/**
 * The bindings a file takes from child_process: `named` maps a local name to the function's, `spaces` holds the
 * names of whole-module bindings, `unread` the lines where the module is taken in a shape not read here.
 * @param {Token[]} ts
 */
function bindings(ts) {
  /** @type {Map<string, string>} */
  const named = new Map();
  /** @type {Set<string>} */
  const spaces = new Set();
  /** @type {number[]} */
  const unread = [];
  /** @type {Set<number>} the tokens of the binding clauses, which are no use */
  const clauses = new Set();
  /** `{ a, b as c }` or `{ a, b: c }` from the token after `{`; returns the index of `}`. */
  const destructure = (/** @type {number} */ open, /** @type {string} */ rename) => {
    const end = closing(ts, open);
    if (end < 0) return -1;
    for (const part of parts(ts, open + 1, end)) {
      if (part.length === 1 && part[0].t === "id") named.set(part[0].v, part[0].v);
      else if (part.length === 3 && part[0].t === "id" && part[1].v === rename && part[2].t === "id") {
        if (part[0].v === "default") spaces.add(part[2].v);
        else named.set(part[2].v, part[0].v);
      }
      else return -1;
    }
    for (let k = open; k <= end; k++) clauses.add(k);
    return end;
  };
  /** Whether the token at `k` is called: `x(` or `x?.(`. @param {number} k */
  const called = (k) => ts[k + 1]?.v === "(" || (ts[k + 1]?.v === "?." && ts[k + 2]?.v === "(");
  // The names a file gives createRequire's result (`const req = createRequire(import.meta.url)`): loaders as require.
  // A createRequire result put anywhere else (an object, a later assignment's target that is no name) is unread.
  /** @type {Set<string>} */
  const loaders = new Set();
  for (let k = 0; k < ts.length; k++) {
    if (ts[k].t !== "id" || ts[k].v !== "createRequire") continue;
    const prev = ts[k - 1];
    // The name in an import clause: `import { createRequire } from "node:module"`.
    if ((prev?.v === "{" || prev?.v === ",") && (ts[k + 1]?.v === "}" || ts[k + 1]?.v === ",")) continue;
    if (!called(k)) {
      unread.push(ts[k].line);
      continue;
    }
    const open = ts[k + 1]?.v === "(" ? k + 1 : k + 2;
    const end = closing(ts, open);
    // Called inline: read where the module's name is.
    if (end > 0 && (ts[end + 1]?.v === "(" || (ts[end + 1]?.v === "?." && ts[end + 2]?.v === "("))) continue;
    const at = prev?.v === "." ? k - 2 : k;
    if (ts[at - 1]?.v === "=" && ts[at - 2]?.t === "id" && ts[at - 3]?.v !== ".") loaders.add(ts[at - 2].v);
    else unread.push(ts[k].line);
  }
  // A loader used as a value (`const r = require`, `const load = req`, `const g = process.getBuiltinModule`) is unread:
  // what it loads is not followed.
  for (let k = 0; k < ts.length; k++) {
    const tok = ts[k];
    if (tok.t !== "id" || !(tok.v === "require" || tok.v === "getBuiltinModule" || loaders.has(tok.v)) || called(k)) continue;
    const prev = ts[k - 1];
    const next = ts[k + 1];
    // A declaration's name, an assignment's target, an object's key, a property of the loader (`require.resolve`).
    if (/^(const|let|var)$/.test(prev?.v ?? "") || next?.v === "=" || next?.v === "." || (next?.v === ":" && (prev?.v === "{" || prev?.v === ","))) continue;
    unread.push(tok.line);
  }
  /**
   * The first token of the call that loads the module named at `k`, or -1 when the name is no load: require,
   * import(), a createRequire loader by its name or called inline, process.getBuiltinModule; an optional call
   * (`x?.(…)`) as a call.
   * @param {number} k
   */
  const loadAt = (k) => {
    if (ts[k - 1]?.v !== "(") return -1;
    const c = ts[k - 2]?.v === "?." ? k - 3 : k - 2;
    const callee = ts[c];
    if (callee?.t === "id" && (callee.v === "require" || callee.v === "import" || loaders.has(callee.v))) return c;
    if (callee?.t === "id" && callee.v === "getBuiltinModule") return (ts[c - 1]?.v === "." || ts[c - 1]?.v === "?.") && ts[c - 2]?.t === "id" ? c - 2 : c;
    if (callee?.v !== ")") return -1;
    // A call's result called: `createRequire(import.meta.url)("node:child_process")`.
    let open = c;
    for (let depth = 0; open >= 0; open--) {
      if (ts[open].v === ")") depth++;
      if (ts[open].v === "(" && --depth === 0) break;
    }
    const maker = ts[open - 1]?.v === "?." ? open - 2 : open - 1;
    return ts[maker]?.v === "createRequire" ? (ts[maker - 1]?.v === "." ? maker - 2 : maker) : -2;
  };
  for (let k = 0; k < ts.length; k++) {
    const tok = ts[k];
    if (tok.t !== "str" || !MODULES.has(tok.v)) continue;
    const from = ts[k - 1]?.t === "id" && ts[k - 1].v === "from";
    const start = from ? -1 : loadAt(k);
    // A call of something else's result: what it loads is not known.
    if (start === -2) {
      unread.push(tok.line);
      continue;
    }
    // The module's name in any other place takes nothing: a string in a list, an argument.
    if (!from && start < 0) continue;
    // Static: import <clause> from "child_process"
    if (from) {
      let first = k - 2;
      while (first >= 0 && !(ts[first].t === "id" && ts[first].v === "import")) first--;
      let ok = first >= 0;
      for (let j = first + 1; ok && j < k - 1; ) {
        const t = ts[j];
        if (t.t === "p" && t.v === "{") {
          const end = destructure(j, "as");
          ok = end > 0;
          j = end + 1;
        } else if (t.t === "p" && t.v === "*" && ts[j + 1]?.v === "as" && ts[j + 2]?.t === "id") {
          spaces.add(ts[j + 2].v);
          clauses.add(j + 2);
          j += 3;
        } else if (t.t === "id" && t.v !== "type") {
          spaces.add(t.v);
          clauses.add(j);
          j++;
        } else if (t.t === "p" && t.v === ",") j++;
        else ok = false;
      }
      if (!ok) unread.push(tok.line);
      continue;
    }
    // A load of child_process, after `= [await]` of a const.
    if (ts[k + 1]?.v !== ")") {
      unread.push(tok.line);
      continue;
    }
    let at = start - 1;
    if (ts[at]?.t === "id" && ts[at].v === "await") at--;
    if (ts[at]?.v !== "=") {
      unread.push(tok.line);
      continue;
    }
    const target = ts[at - 1];
    if (target?.t === "id" && /^(const|let|var)$/.test(ts[at - 2]?.v ?? "")) {
      spaces.add(target.v);
      clauses.add(at - 1);
    } else if (target?.v === "}") {
      let open = at - 1;
      let depth = 0;
      for (; open >= 0; open--) {
        if (ts[open].v === "}") depth++;
        if (ts[open].v === "{" && --depth === 0) break;
      }
      if (open < 0 || destructure(open, ":") < 0) unread.push(tok.line);
    } else unread.push(tok.line);
  }
  return { named, spaces, unread, clauses };
}

/**
 * What a run of tokens says about a limit and a kill signal: `limit` (a `timeout` or `signal` key: node ends the child
 * with the kill signal on either), `kill` (a `killSignal` key whose value is a string literal or a `const` of one),
 * `badKill` (a `killSignal` whose value is anything else but `undefined`), `unknown` (a spread or computed key not
 * read).
 * @param {Token[]} ts the whole file @param {Token[]} part the expression @param {Set<string>} [seen]
 * @returns {Said | null} null: not an object this reader can read
 * @typedef {{ limit: boolean, kill: boolean, badKill: boolean, unknown: boolean }} Said
 */
function readOptions(ts, part, seen = new Set()) {
  if (part.length === 1 && part[0].t === "id" && (part[0].v === "undefined" || part[0].v === "null")) return { limit: false, kill: false, badKill: false, unknown: false };
  if (whole(part, "(")) return readOptions(ts, part.slice(1, -1), seen);
  if (part.length === 1 && part[0].t === "id") {
    const value = constant(ts, part[0].v);
    if (!value || seen.has(part[0].v) || !whole(value, "{")) return null;
    return readOptions(ts, value, new Set([...seen, part[0].v]));
  }
  if (!whole(part, "{")) return null;
  const said = { limit: false, kill: false, badKill: false, unknown: false };
  for (const prop of parts(part, 1, part.length - 1)) {
    const [first, second] = prop;
    if (first.t === "p" && first.v === "...") {
      const inner = readOptions(ts, prop.slice(1), seen);
      if (!inner) said.unknown = true;
      else {
        said.limit ||= inner.limit;
        said.kill ||= inner.kill;
        said.badKill ||= inner.badKill;
        said.unknown ||= inner.unknown;
      }
      continue;
    }
    if (first.t === "p" && first.v === "[") {
      said.unknown = true;
      continue;
    }
    const key = first.t === "id" || first.t === "str" || first.t === "num" ? first.v : null;
    if (key === null) {
      said.unknown = true;
      continue;
    }
    if (key === "timeout" || key === "signal") said.limit = true;
    if (key === "killSignal") {
      // `{ killSignal }` is the name's value.
      const value = second?.v === ":" ? prop.slice(2) : prop.length === 1 ? prop : [];
      const named = value.length === 1 && (value[0].t === "str" || (value[0].t === "id" && constantString(ts, value[0].v)));
      if (named) said.kill = true;
      else if (!(value.length === 1 && value[0].t === "id" && value[0].v === "undefined")) said.badKill = true;
    }
  }
  return said;
}

/**
 * Whether the file declares `name` once, as a `const` of a string literal ending at `;` or the line's end.
 * @param {Token[]} ts @param {string} name
 */
function constantString(ts, name) {
  const decl = [];
  for (let k = 1; k < ts.length; k++) if (ts[k].t === "id" && ts[k].v === name && ts[k - 1].t === "id" && /^(const|let|var)$/.test(ts[k - 1].v)) decl.push(k);
  if (decl.length !== 1 || ts[decl[0] - 1].v !== "const" || ts[decl[0] + 1]?.v !== "=" || ts[decl[0] + 2]?.t !== "str") return false;
  const next = ts[decl[0] + 3];
  return !next || next.v === ";" || next.line !== ts[decl[0] + 2].line;
}

/**
 * The value of `name` when the file declares it once, as a `const`, with a value that ends at `;` or the line's
 * end; null otherwise.
 * @param {Token[]} ts @param {string} name @returns {Token[] | null}
 */
function constant(ts, name) {
  const decl = [];
  for (let k = 1; k < ts.length; k++) if (ts[k].t === "id" && ts[k].v === name && /^(const|let|var)$/.test(ts[k - 1].v) && ts[k - 1].t === "id") decl.push(k);
  if (decl.length !== 1 || ts[decl[0] - 1].v !== "const" || ts[decl[0] + 1]?.v !== "=") return null;
  const from = decl[0] + 2;
  if (ts[from]?.t !== "p" || !(ts[from].v in OPEN)) return null;
  const end = closing(ts, from);
  if (end < 0) return null;
  const next = ts[end + 1];
  if (next && next.v !== ";" && next.line === ts[end].line) return null;
  return ts.slice(from, end + 1);
}

/** Whether a part is a function: `function`, `async`, or an arrow at its top. @param {Token[]} part */
const isFunction = (part) => part[0]?.t === "id" && (part[0].v === "function" || part[0].v === "async") || parts(part, 0, part.length).length === 1 && part.some((t, k) => t.v === "=>" && (k === 1 || part[k - 1].v === ")"));

/**
 * Every call in `source` of a child_process function that has a time limit and no kill signal, and every one whose
 * options this reader cannot read. An alias is read as the function: `const run = spawnSync`, a parameter's default
 * `run = spawnSync`, `const run = promisify(execFile)`, and `promisify(execFile)(…)` is a call.
 * @param {string} source @returns {Problem[]}
 */
export function limitProblems(source) {
  const ts = tokens(source);
  const { named, spaces, unread, clauses } = bindings(ts);
  /** @type {Problem[]} */
  const out = unread.map((line) => ({ line, verdict: /** @type {const} */ ("unreadable"), why: "child_process taken in a shape this reader does not read" }));
  /**
   * The function a token names and the index of the reference's last token, or null.
   * @param {number} k @returns {{ fn: string, end: number } | null}
   */
  const useAt = (k) => {
    const tok = ts[k];
    if (tok.t !== "id" || clauses.has(k)) return null;
    const prev = ts[k - 1];
    if (prev?.t === "p" && (prev.v === "." || prev.v === "?.")) return null;
    // An object's key of the same name: `{ spawnSync: 1 }`.
    if (ts[k + 1]?.v === ":" && (prev?.v === "{" || prev?.v === ",")) return null;
    const fn = named.get(tok.v);
    if (fn) return { fn, end: k };
    if (spaces.has(tok.v) && ts[k + 1]?.v === "." && ts[k + 2]?.t === "id") return NAMES.has(ts[k + 2].v) ? { fn: ts[k + 2].v, end: k + 2 } : { fn: "", end: k + 2 };
    if (spaces.has(tok.v)) return { fn: "", end: k };
    return null;
  };
  /** @type {Map<number, number>} a reference's first token to the index of its call's `(`, for promisify(fn)(…) */
  const promisified = new Map();
  // Aliases first, in the order they are written; a name made an alias is read as the function from then on.
  for (let k = 0; k < ts.length; k++) {
    const use = useAt(k);
    if (!use?.fn || ts[use.end + 1]?.v === "(") continue;
    const wrapped = ts[k - 1]?.v === "(" && ts[k - 2]?.t === "id" && ts[k - 2].v === "promisify" && ts[use.end + 1]?.v === ")";
    const assign = wrapped ? k - 3 : k - 1;
    if (wrapped && ts[use.end + 2]?.v === "(") promisified.set(k, use.end + 2);
    else if (ts[assign]?.v === "=" && ts[assign - 1]?.t === "id" && !(ts[assign - 2]?.t === "p" && ts[assign - 2].v === ".")) {
      named.set(ts[assign - 1].v, use.fn);
      clauses.add(assign - 1);
      clauses.add(k);
    }
  }
  for (let k = 0; k < ts.length; k++) {
    const use = useAt(k);
    if (!use) continue;
    const { fn, end: last } = use;
    const tok = ts[k];
    if (!fn) {
      out.push({ line: tok.line, verdict: "unreadable", why: `the module ${tok.v} used as a value` });
      continue;
    }
    const open = promisified.get(k) ?? last + 1;
    if (ts[open]?.v !== "(") {
      out.push({ line: tok.line, verdict: "unreadable", why: `${fn} used as a value, not called` });
      continue;
    }
    const end = closing(ts, open);
    if (end < 0) {
      out.push({ line: tok.line, verdict: "unreadable", why: `a call of ${fn} the reader cannot close` });
      continue;
    }
    const args = parts(ts, open + 1, end);
    /** @type {Token[] | null} */
    let options = null;
    let list = null;
    if (WITH_ARGS.has(fn)) {
      if (args.length >= 3) options = args[2];
      else if (args.length === 2) list = args[1];
    } else if (args.length >= 2) options = args[1];
    if (list) {
      if (list[0]?.t === "p" && list[0].v === "[") continue;
      const value = list.length === 1 && list[0].t === "id" ? constant(ts, list[0].v) : null;
      if (value && whole(value, "[")) continue;
      if (isFunction(list)) continue;
      options = list;
    }
    if (!options || isFunction(options)) continue;
    const said = readOptions(ts, options);
    const where = { line: tok.line };
    if (!said) out.push({ ...where, verdict: "unreadable", why: `the options of ${fn} are not an object this reader reads` });
    else if (said.badKill) out.push({ ...where, verdict: "unreadable", why: `the killSignal of ${fn} is not a string literal or a constant of one` });
    else if (said.kill) continue;
    else if (said.limit) out.push({ ...where, verdict: "no-kill-signal", why: `${fn} has a time limit and no killSignal` });
    else if (said.unknown) out.push({ ...where, verdict: "unreadable", why: `the options of ${fn} hold a spread or key this reader does not read` });
  }
  return out.sort((a, b) => a.line - b.line);
}
