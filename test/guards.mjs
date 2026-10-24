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
