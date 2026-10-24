/**
 * Guards: for each gate test, mutants that make what it guards false. Each one must make its gate test
 * fail; test/guards.test.mjs runs them in a clone of the tree. A gate that passes with a guard applied
 * cannot fail where it says it looks: its check is vacuous, or it reads less than it names.
 *
 * A gate test reads this repository's own files, or judges the runs of other code (the fault matrix, the git
 * oracle, the Linux run). Every test file that finds the repository from its own place (`import.meta.url`,
 * `.dirname`, `.filename`, `process.argv[1]`, or an import of a file above test/) is in GATES or in NOT_GATES,
 * and a NOT_GATES file may name the repository only on the lines its `allow` matches. A test that reads a file
 * by a path relative to the working directory fails: test/hermetic.mjs starts every test file in an empty
 * directory. Content guards break the repository the way the gate says it never is; judge guards break the
 * gate's own check, which only a positive control in the gate catches. Names and home paths are written in
 * parts, as in test/hygiene.test.mjs, so this file names none.
 *
 * Cycle 2026-10-23 (6) found this class nine times, all by reviewers: an untested Linux-run decision, a skip
 * read as a pass, a symlinked entry that ran nothing, fault cells on files the fixture lacks, a judge that
 * read JSON as empty, a preload that could stop counting.
 *
 * `pattern` names the one test that guards the claim (node --test-name-pattern): the guard runs that test
 * alone, and a kill is that test reported as failed, not another test of the file, a file that never ran it,
 * or a run ended by a signal. Guards are per test: every top-level test of a gate file is named by a guard's
 * pattern or listed in its entry's `others` with why it has none, so a test added to a gate file is decided.
 */

/** @typedef {{ id: string, why: string, file: string, old: string, new: string, pattern: string }} Guard */
/** @typedef {{ test: string, guards: Guard[], others?: Record<string, string> }} Gate `others`: exact test names, with why each has no guard */

const NAME = "Zor" + "blax";
const HOME = "/" + "Users/someone";

/** @type {Gate[]} */
export const GATES = [
  {
    test: "test/hygiene.test.mjs",
    guards: [
      { id: "hygiene-name", why: "a project name in a tracked file", file: "DESIGN.md", old: "# ennyn — design\n", new: `# ennyn — design\n\nFrom ${NAME}.\n`, pattern: "hygiene: no file, path, symlink" },
      { id: "hygiene-home", why: "a home path in a tracked file", file: "README.md", old: "> Status: pre-release (0.0.x).", new: `> Status: pre-release (0.0.x), from ${HOME}/ennyn.`, pattern: "hygiene: no file, path, symlink" },
      { id: "hygiene-judge", why: "a judge that finds nothing", file: "test/hygiene.test.mjs", old: "  const out = [];\n  for (const raw of text.match(", new: "  const out = [];\n  if (out) return out;\n  for (const raw of text.match(", pattern: "hygiene: a name is found whole" },
      {
        id: "hygiene-log",
        why: "commit messages not read",
        file: "test/hygiene.test.mjs",
        old: 'const log = head ? git(["log", "-z", "--format=%H%x00%B"], { cwd: root }).split("\\0") : [];',
        new: "const log = /** @type {string[]} */ ([]);",
        pattern: "hygiene: the repository scan finds",
      },
    ],
  },
  {
    test: "test/readme-twins.test.mjs",
    guards: [
      { id: "twins-row", why: "a table row in one twin only", file: "README.tr.md", old: "| Kapı denemeleri |", new: "| Kapı denemeleri | `ek` |\n| Kapı denemeleri |", pattern: "docs: README.md and README.tr.md keep" },
      { id: "twins-number", why: "a number in one twin only", file: "README.md", old: "We measured 21 cycles", new: "We measured 22 cycles", pattern: "docs: README.md and README.tr.md keep" },
      { id: "twins-judge", why: "a comparison that finds no difference", file: "test/readme-twins.test.mjs", old: "function differences(a, b, langA, langB) {\n  const out = [];", new: "function differences(a, b, langA, langB) {\n  const out = [];\n  if (out) return out;", pattern: "docs: the twin check fails on drift" },
    ],
  },
  {
    test: "test/plugin.test.mjs",
    guards: [
      { id: "plugin-size", why: "a skill over 8 KB", file: "skills/cycle/SKILL.md", old: "# Cycle — four tasks, measured\n", new: `# Cycle — four tasks, measured\n\n${"x".repeat(8192)}\n`, pattern: "plugin: every SKILL.md stays under 8 KB" },
      { id: "plugin-yaml", why: "front matter a YAML parser misreads", file: "agents/security-reviewer.md", old: "description: Adversarial security review — ", new: "description: Adversarial security review: ", pattern: "plugin: every agent and skill has front matter" },
      { id: "plugin-version", why: "a plugin version the package does not have", file: ".claude-plugin/plugin.json", old: '"version": "0.0.1"', new: '"version": "0.0.2"', pattern: "plugin: hook commands point" },
      { id: "plugin-pipe", why: "a table cell that splits, in a nested document", file: "docs/evidence.md", old: "# Evidence\n", new: "# Evidence\n\n| `a|b` | x |\n", pattern: "docs: no table cell holds" },
      { id: "i18n-key", why: "a message the Turkish catalog lacks", file: "i18n/tr.json", old: '  "doctor.summary": "sorun: {fail} · uyarı: {warn}",\n', new: "", pattern: "i18n: every English key exists" },
      { id: "hooks-matcher", why: "a hook wired for fewer tools than it handles", file: "hooks/hooks.json", old: '"matcher": "Read|Edit|Write|MultiEdit|NotebookEdit"', new: '"matcher": "Read|Edit|Write"', pattern: "hooks.json: the PostToolUse matcher sends exactly" },
    ],
  },
  {
    test: "test/engines.test.mjs",
    guards: [
      { id: "engines-lock", why: "engines and the lock file disagree", file: "package-lock.json", old: '"node": ">=20"', new: '"node": ">=22"', pattern: "engines: the Linux run starts at both floors" },
      { id: "engines-workflow", why: "a workflow changed without the test", file: ".github/workflows/test.yml", old: "          fetch-depth: 0\n", new: "", pattern: "engines: the Linux run starts at both floors" },
      { id: "engines-readme", why: "a README that names another floor", file: "README.md", old: "needs Node 20 or later", new: "needs Node 18 or later", pattern: "engines: both READMEs" },
      { id: "engines-floor-form", why: "a floor read from a range with an upper bound", file: "test/linux-run.mjs", old: "(?:\\.(\\d+))?(?:\\.(\\d+))?$/.exec(range.trim());", new: "(?:\\.(\\d+))?(?:\\.(\\d+))?/.exec(range.trim());", pattern: "engines: the Node floor parses" },
      { id: "engines-version-part", why: "a container version that matches the floor's major only", file: "test/linux-run.mjs", old: "n.every((part, i) => r[i] === part)", new: "n.every((part, i) => i > 0 || r[i] === part)", pattern: "engines: a container's version is the one named" },
    ],
  },
  {
    test: "test/style.test.mjs",
    guards: [
      { id: "style-suffix", why: "Turkish terse that trims suffixes", file: "styles/terse.tr.md", old: "- Ekleri kırpma: olumsuzluk", new: "- Ekleri kırp: olumsuzluk", pattern: "styles: every style but normal" },
      { id: "style-never", why: "a style without the never-shorten list", file: "styles/focused.en.md", old: "Never shorten: numbers", new: "Shorten: numbers", pattern: "styles: every style but normal" },
    ],
    others: {
      "config: conversation.style and commitMsg.style take only their listed values": "a unit of core/config.mjs on configs it builds; it reads no file of the repository",
      "commit style terse: no prose in the body; structured lines, trailers, Merge and the allow marker pass": "a unit of commit-check on messages it writes",
      "hook: injects the style in the config language; nothing for normal or no config; a broken one is said; exit 0 always": "runs the SessionStart hook on temporary projects, as the CLI tests run the CLI",
    },
  },
  {
    test: "test/hermetic.test.mjs",
    guards: [
      { id: "hermetic-script", why: "npm test without the setup", file: "package.json", old: '"test": "node --test --import ./test/hermetic.mjs test/*.test.mjs"', new: '"test": "node --test test/*.test.mjs"', pattern: "hermetic: npm test loads" },
      { id: "hermetic-system", why: "a setup that leaves the system config readable", file: "test/hermetic.mjs", old: '  GIT_CONFIG_NOSYSTEM: "1",\n', new: "", pattern: "hermetic: after the hostile machine" },
      { id: "hermetic-refuse", why: "a child that drops the setup, let run", file: "test/hermetic.mjs", old: "  if (!missing.length) return;\n", new: "  return;\n", pattern: "hermetic: a child given its own environment" },
      { id: "hermetic-exit", why: "a refused call the code swallowed, forgotten at exit", file: "test/hermetic.mjs", old: "  process.exitCode = 1;\n});", new: "});", pattern: "hermetic: a test file whose code swallows" },
      { id: "hermetic-cwd", why: "a test file that starts in the repository", file: "test/hermetic.mjs", old: "process.chdir(start);\n", new: "", pattern: "hermetic: every test file starts in an empty directory" },
      {
        id: "hermetic-env",
        why: "a variable left naming the repository",
        file: "test/hermetic.mjs",
        old: "  else if (v.split(delimiter).some(names) || mentioned.test(v)) delete process.env[k];\n",
        new: "",
        pattern: "hermetic: every test file starts in an empty directory",
      },
    ],
  },
  {
    test: "test/git-oracle.test.mjs",
    guards: [
      {
        id: "oracle-strip",
        why: "a hook that keeps the comment lines git drops",
        file: "checks/commit-shape.mjs",
        old: 'if (cleanup === "strip" && raw.startsWith(comment)) continue;',
        new: 'if (cleanup === "strip" && raw.startsWith(comment + comment)) continue;',
        pattern: "oracle: the commit-msg hook",
      },
      { id: "oracle-signature", why: "a reader the user's config reshapes", file: "core/git.mjs", old: '"log.showSignature=false", ', new: "", pattern: "oracle: the log readers" },
      { id: "oracle-shallow", why: "the edge of a shallow clone taken for a candidate", file: "metrics/szz.mjs", old: "if (!(c.time + window <= nowSec) || edge.has(c.hash)) censored += 1;", new: "if (!(c.time + window <= nowSec)) censored += 1;", pattern: "oracle: in a shallow clone" },
    ],
  },
  {
    test: "test/fault-injection.test.mjs",
    guards: [
      {
        id: "fault-says",
        why: "a judge that takes 'could not be found' for honest",
        file: "test/fault-injection.test.mjs",
        old: "const SAYS = /unmeasured|could not be (measured|read|applied|reset)|was not checked/i;",
        new: "const SAYS = /unmeasured|could not be (found|measured|read|applied|reset)|was not checked/i;",
        pattern: "fault matrix control: the judge",
      },
      {
        id: "fault-json",
        why: "a judge that reads a --json report as a hook's text, and so as empty",
        file: "test/fault-injection.test.mjs",
        old: 'if (o && typeof o === "object" && ("hookSpecificOutput" in o || "systemMessage" in o)) {',
        new: 'if (o && typeof o === "object") {',
        pattern: "fault matrix control: the judge",
      },
      { id: "fault-preload", why: "a preload that fails no read", file: "test/fault-fs.mjs", old: "      if (seen.length === AT) {", new: "      if (seen.length === AT && AT < 0) {", pattern: "fault matrix control: the preload" },
      {
        id: "fault-number",
        why: "a judge that lets a number move in a part that says unmeasured",
        file: "test/fault-injection.test.mjs",
        old: "    if (shapes.has(digits(p))) return `a number changed: ${JSON.stringify(p)}`;",
        new: "    if (shapes.has(digits(p)) && !SAYS.test(p)) return `a number changed: ${JSON.stringify(p)}`;",
        pattern: "fault matrix control: the judge",
      },
      {
        id: "fault-count",
        why: "a judge that lets doctor's count of unmeasured lines move by more than the lines added",
        file: "test/fault-injection.test.mjs",
        old: "counted(after) - counted(before) === marks(got) - marks(clean)) continue;",
        new: "counted(after) >= counted(before)) continue;",
        pattern: "fault matrix control: the judge",
      },
      { id: "fault-cases", why: "a command with no case", file: "test/fault-injection.test.mjs", old: '  { args: ["push-check"] },\n', new: "", pattern: "fault matrix: every command" },
      { id: "fault-hooks", why: "a Claude Code hook with no case", file: "test/fault-injection.test.mjs", old: '    hook: "conversation-style.mjs",\n', new: '    hook: "conversation-style.mjs.off",\n', pattern: "fault matrix: every Claude Code hook" },
      { id: "fault-reference", why: "a killed reference command said without its signal", file: "impact/table.mjs", old: "e.signal ? `killed by ${e.signal}`", new: 'e.signal ? "killed"', pattern: "fault matrix: a reference command" },
    ],
    others: {
      "fault matrix: with any git call failing or killed, or no git at all, a command fails or says so; a closed pipe is no crash":
        "the matrix itself, 10 s a run: its judge (fault-says, fault-json) and case lists (fault-cases, fault-hooks) are guarded; that its fixture holds the files a case reads is fault-fixture-probes",
      "fault matrix: with any file read failing (no permission, a directory in its place), a command fails or says so":
        "the matrix itself, 20 s a run: its judge, case lists and preload (fault-preload) are guarded; that its fixture holds the files a case reads is fault-fixture-probes",
    },
  },
  {
    test: "test/input-shapes.test.mjs",
    guards: [
      { id: "shapes-wide", why: "a hook that reads a UTF-16 or UTF-32 file as bytes alone", file: "core/git.mjs", old: "if (wide) out.set(c.path, [...c.lines, ", new: "if (false) out.set(c.path, [...c.lines, ", pattern: "input shapes: git errors name" },
      { id: "shapes-byte-view", why: "decoded lines that take the place of git's own", file: "core/git.mjs", old: "out.set(c.path, [...c.lines, ...wideLines(", new: "out.set(c.path, [...wideLines(", pattern: "input shapes: git errors name" },
      { id: "shapes-one-path", why: "a large file that stops the check of the whole commit", file: "core/git.mjs", old: "else if (size > WIDE_LIMIT) unread(c, `past ${WIDE_LIMIT / 1024 / 1024} MB`);", new: 'else if (size > WIDE_LIMIT) throw new Error("past the limit");', pattern: "input shapes: git errors name" },
      { id: "shapes-error-name", why: "a git error named after its -c", file: "core/git.mjs", old: "err.stderr = said || `git ${args[at]}: ${how}`;", new: "err.stderr = said || `git ${args[0]}: ${how}`;", pattern: "input shapes: git errors name" },
      { id: "shapes-names", why: "a name that is not UTF-8 asked for, so nothing is checked", file: "scripts/ennyn.mjs", old: "const named = ruled.filter((p) => !notUtf8.includes(p));", new: "const named = ruled;", pattern: "input shapes: every staged" },
      { id: "shapes-names-said", why: "a name that is not UTF-8 passed in silence", file: "scripts/ennyn.mjs", old: "if (unnamed.length) {", new: "if (unnamed.length < 0) {", pattern: "input shapes: every staged" },
      { id: "shapes-unread", why: "an 8-bit line no text can be compared in, passed in silence", file: "checks/commit-shape.mjs", old: ": l.raw)) eightBit = true;", new: ": l.raw)) eightBit = false;", pattern: "input shapes: a line holds" },
      { id: "shapes-nul-8bit", why: "8-bit text beside a NUL, passed in silence", file: "checks/commit-shape.mjs", old: "} else if (!ascii && l.raw && !isUtf8(", new: "} else if (!ascii && l.raw && !l.raw.includes(0) && !isUtf8(", pattern: "input shapes: a line holds" },
      { id: "shapes-decoded-8bit", why: "a decoded file whose own 8-bit lines are no longer judged", file: "checks/commit-shape.mjs", old: "} else if (!ascii && l.raw && !isUtf8(", new: "} else if (!ascii && !lines.some((x) => x.decoded) && l.raw && !isUtf8(", pattern: "input shapes: a line holds" },
      { id: "shapes-decoded-forms", why: "a decoded file whose own lines are not searched for wide bytes", file: "checks/commit-shape.mjs", old: "const bytes = nul && !l.decoded ?", new: "const bytes = nul && !lines.some((x) => x.decoded) ?", pattern: "input shapes: a line holds" },
      { id: "shapes-forms-order", why: "a decoded file searched in the other byte order too", file: "checks/commit-shape.mjs", old: "wideForms(rule.text, lines.find((l) => l.decoded)?.decoded)", new: "wideForms(rule.text)", pattern: "input shapes: a line holds" },
      { id: "shapes-wide-unread", why: "a file not decoded, passed for a text only its decoding finds", file: "checks/commit-shape.mjs", old: "if (wideUnread.has(path) && !ascii)", new: "if (wideUnread.has(path) && ascii)", pattern: "input shapes: a line holds" },
      { id: "shapes-trace", why: "a GIT_TRACE to stdout read as git's answer", file: "core/git.mjs", old: 'for (const k of Object.keys(out)) if (k.startsWith("GIT_TRACE")) delete out[k];', new: "", pattern: "input shapes: git\\(\\) and gitBytes\\(\\) fail" },
      { id: "shapes-binary", why: "binary files named one by one, drowning a text file", file: "checks/commit-shape.mjs", old: 'kind: nul ? "binary" : "text"', new: 'kind: "text"', pattern: "input shapes: a line holds" },
      { id: "shapes-forms", why: "a file with NULs that is not decoded, searched as UTF-8 alone", file: "checks/commit-shape.mjs", old: "(bytes && forms.some((f) => bytes.includes(f)))", new: "false", pattern: "input shapes: a line holds" },
      { id: "shapes-mark", why: "UTF-16LE's mark and U+0000 read as UTF-32", file: "core/encoding.mjs", old: 'if (encoding.startsWith("utf-32") && !utf32(blob, mark.length, encoding === "utf-32le")) continue;', new: "", pattern: "input shapes: a wide file" },
      { id: "shapes-order", why: "UTF-16 read in the other byte order", file: "core/encoding.mjs", old: 'if (odd * 4 >= pairs && even * 16 <= odd) return { encoding: "utf-16le", mark: 0 };', new: 'if (odd * 4 >= pairs && even * 16 <= odd) return { encoding: "utf-16be", mark: 0 };', pattern: "input shapes: a wide file" },
      { id: "shapes-line", why: "a UTF-16 line numbered by git's newline bytes", file: "core/encoding.mjs", old: "const end = Math.min((gitStarts[l.line] ?? blob.length + 1) - 1, blob.length - 1);", new: "const end = gitStarts[l.line - 1] ?? blob.length;", pattern: "input shapes: a wide file" },
      { id: "shapes-glob", why: "a decomposed name that a composed glob does not name", file: "core/glob.mjs", old: '(!(plain(p) && plain(pat)) && globToRegExp(pat.normalize("NFC")).test(p.normalize("NFC")))', new: "false", pattern: "input shapes: a glob matches" },
      { id: "shapes-stderr", why: "a git error whose message is bytes, which the hook takes for a broken config", file: "core/git.mjs", old: 'e.stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : e.stderr;', new: "e.stderr = e.stderr;", pattern: "input shapes: git\\(\\) and gitBytes\\(\\) fail" },
      { id: "shapes-count", why: "a decomposed text the count does not ask for", file: "setup/scan.mjs", old: '[t, t.normalize("NFC"), t.normalize("NFD")]', new: "[t]", pattern: "input shapes: doctor and init-scan count" },
      { id: "shapes-judge", why: "a judge that takes a silent pass for an honest one", file: "test/input-shapes.test.mjs", old: 'return { problem: said ? null : "a silent pass', new: 'return { problem: said || true ? null : "a silent pass', pattern: "input shapes control: the judge" },
    ],
    others: {},
  },
  {
    test: "test/linux-run.test.mjs",
    guards: [
      { id: "linux-skip", why: "a skipped test read as a pass", file: "test/linux-run.mjs", old: 'if (count("skipped") !== "0") wrong.push(', new: 'if (count("skipped") === "none") wrong.push(', pattern: "linux run: a container's run passes only" },
      { id: "linux-totals", why: "runs with different test counts read as one", file: "test/linux-run.mjs", old: "if (totals.size > 1) {", new: "if (totals.size > 9) {", pattern: "linux run: the script passes only when" },
      {
        id: "linux-link",
        why: "a script run through a link that runs nothing",
        file: "test/linux-run.mjs",
        old: 'return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));',
        new: 'return (process.argv[1] ?? "") === fileURLToPath(import.meta.url);',
        pattern: "linux run: run through a link",
      },
      { id: "linux-summary-last", why: "a summary line a test printed taken for the runner's", file: "test/linux-run.mjs", old: '"gm"))].at(-1)?.[1];', new: '"gm"))].at(0)?.[1];', pattern: "linux run: summary counts are the runner's own" },
    ],
    others: {
      "linux run: a failure shows each failing test with why, else the end of the output": "what a failed run prints; it decides no pass or fail",
    },
  },
];

/**
 * Test files that find the repository from their own place but judge no file of it, with the lines that may
 * name it (`allow`, a regular expression): another such line, a ROOT constant added later, makes it a gate.
 * @type {Record<string, { reason: string, allow: string }>}
 */
const CLI_ONLY = { reason: "runs the CLI on temporary repositories", allow: '"scripts", "ennyn\\.mjs"' };
export const NOT_GATES = {
  "test/budget.test.mjs": CLI_ONLY,
  "test/bypass.test.mjs": CLI_ONLY,
  "test/cli.test.mjs": CLI_ONLY,
  "test/forbidden.test.mjs": CLI_ONLY,
  "test/gate-log.test.mjs": CLI_ONLY,
  "test/hook.test.mjs": CLI_ONLY,
  "test/mutation.test.mjs": CLI_ONLY,
  "test/setup.test.mjs": CLI_ONLY,
  "test/impact.test.mjs": { reason: "import.meta is text in a fixture it writes", allow: "__fixtures__/rows\\.jsonl" },
  "test/side-copy.test.mjs": { reason: "runs the side-copy hooks on temporary projects", allow: '"\\.\\./adapters/claude-code/hooks/side-copy-(rules|reset)\\.mjs", import\\.meta\\.url' },
};
