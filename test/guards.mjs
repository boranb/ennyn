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
/** A token the secret scan refuses, in parts like the name. */
const TOKEN = "np" + "m_" + "q7Rk2LmVx9TbWc4ZsHn8JyPd3FgAe6Ku5Qo1";

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
      { id: "hygiene-secret", why: "a secret shape in a tracked file", file: "DESIGN.md", old: "# ennyn — design\n", new: `# ennyn — design\n\nnpmrc: ${TOKEN}\n`, pattern: "hygiene: no tracked file holds a secret" },
      { id: "hygiene-secret-judge", why: "a secret scan that finds nothing", file: "checks/secrets.mjs", old: "    if (matchAny(path, except)) continue;\n", new: "    if (path) continue;\n", pattern: "hygiene: no tracked file holds a secret" },
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
      { id: "plugin-ask", why: "a push no rule asks about", file: ".claude/settings.json", old: '"Bash(git push *)"', new: '"Bash(git status *)"', pattern: "plugin: the repository asks before every command" },
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
      { id: "engines-image-tag", why: "a newer major pulled by its tag", file: "test/linux-run.mjs", old: "image: pinned(`node:${major}`)", new: "image: `node:${major}`", pattern: "engines: the Linux run starts at both floors" },
      { id: "engines-action-tag", why: "an action of the workflow named by its tag", file: ".github/workflows/test.yml", old: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0", new: "actions/setup-node@v7", pattern: "engines: the repository's own CI files" },
      { id: "engines-ci-permissions", why: "the workflow's permissions removed", file: ".github/workflows/test.yml", old: "permissions:\n  contents: read\n", new: "", pattern: "engines: the repository's own CI files" },
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
      { id: "hermetic-plugin", why: "a plugin session's data directory left to the tests (install-hook would write its record)", file: "test/hermetic.mjs", old: 'const PLUGIN_VARS = ["ENNYN_PLUGIN_DATA", ', new: "const PLUGIN_VARS = [", pattern: "hermetic: after the hostile machine" },
      { id: "hermetic-system", why: "a setup that leaves the system config readable", file: "test/hermetic.mjs", old: '  GIT_CONFIG_NOSYSTEM: "1",\n', new: "", pattern: "hermetic: after the hostile machine" },
      { id: "hermetic-refuse", why: "a child that drops the setup, let run", file: "test/hermetic.mjs", old: "  if (!missing.length) return;\n", new: "  return;\n", pattern: "hermetic: a child given its own environment" },
      { id: "hermetic-exit", why: "a refused call the code swallowed, forgotten at exit", file: "test/hermetic.mjs", old: "  process.exitCode = 1;\n});", new: "});", pattern: "hermetic: a test file whose code swallows" },
      { id: "hermetic-cwd", why: "a test file that starts in the repository", file: "test/hermetic.mjs", old: "process.chdir(start);\n", new: "", pattern: "hermetic: every test file starts in an empty directory" },
      { id: "hermetic-clean", why: "a test file that leaves its temporary directories", file: "test/hermetic.mjs", old: "  if (!hostileRoot) return;\n", new: "  return;\n", pattern: "hermetic: a test file's temporary directories are gone" },
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
      {
        id: "git-limit-absent",
        why: "a git stopped at its limit, having exited with the code for 'nothing there', read as nothing there",
        file: "core/git.mjs",
        old: "if (!r.error && r.status !== null && r.status !== 0 && absent.includes(r.status)) return null;",
        new: "if (r.status !== null && r.status !== 0 && absent.includes(r.status)) return null;",
        pattern: "fault matrix control: a git call that never ends",
      },
      { id: "git-limit-sync", why: "a git call with no limit", file: "core/git.mjs", old: "      timeout: limit,\n", new: "", pattern: "fault matrix control: a git call that never ends" },
      {
        id: "git-limit-status",
        why: "a stopped git's exit code kept, for a reader to take as an answer",
        file: "core/git.mjs",
        old: "Object.assign(e, { message: stop.message, stderr: stop.stderr, status: null });",
        new: "Object.assign(e, { message: stop.message, stderr: stop.stderr });",
        pattern: "fault matrix control: a git call that never ends",
      },
      { id: "slow-diff-secrets", why: "a file whose diff was stopped left unread by the secret scan", file: "scripts/ennyn.mjs", old: "        for (const p of group) readWhole(p), shownPaths.add(p);\n", new: "        for (const p of group) shownPaths.add(p);\n", pattern: "fault matrix: a file git is slow to diff" },
      { id: "slow-diff-held", why: "a secret HEAD already holds refused when its file is read whole", file: "scripts/ennyn.mjs", old: "      if (before) scan.hits.splice(", new: "      if (!before) scan.hits.splice(", pattern: "fault matrix: a file git is slow to diff" },
      { id: "read-again-once", why: "a file read whole after its diff stopped keeps the hits the diff found, twice", file: "scripts/ennyn.mjs", old: "      scan.hits.splice(0, scan.hits.length, ...scan.hits.filter((h) => h.path !== p));\n", new: "", pattern: "fault matrix: a diff that stops after its output" },
      { id: "slow-diff-forbidden", why: "a slow file that turns off review.forbidden for every file", file: "core/git.mjs", old: "      if (!unread) throw e;\n      const why", new: "      throw e;\n      const why", pattern: "fault matrix: a file git is slow to diff" },
      { id: "git-limit-walk", why: "a walk of the history held to the short limit", file: "metrics/szz.mjs", old: '`${fix}^`, "--", file], { cwd, walk: true });', new: '`${fix}^`, "--", file], { cwd });', pattern: "fault matrix: a call that walks" },
      {
        id: "git-limit-held",
        why: "a stopped stream whose pipes stay open while a process git started holds them",
        file: "core/git.mjs",
        old: "    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();\n",
        new: "",
        pattern: "fault matrix control: a git call that never ends",
      },
    ],
    others: {
      "fault matrix: with any git call failing, killed or never ending, or no git at all, a command fails or says so; a closed pipe is no crash":
        "the matrix itself, 10 s a run and minutes with its hung cells: its judge (fault-says, fault-json) and case lists (fault-cases, fault-hooks) are guarded, and the limits it relies on (git-limit-*) through the control; that its fixture holds the files a case reads is fault-fixture-probes",
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
      { id: "shapes-error-name", why: "a git error named after its -c", file: "core/git.mjs", old: "err.stderr = said || `git ${commandName(args)}: ${how}`;", new: "err.stderr = said || `git ${args[0]}: ${how}`;", pattern: "input shapes: git errors name" },
      { id: "shapes-names", why: "a name that is not UTF-8 asked for, so nothing is checked", file: "scripts/ennyn.mjs", old: "const named = ruled.filter((p) => !notUtf8.includes(p));", new: "const named = ruled;", pattern: "input shapes: every staged" },
      { id: "shapes-names-said", why: "a name that is not UTF-8 passed in silence", file: "scripts/ennyn.mjs", old: "if (unnamed.length) {", new: "if (unnamed.length < 0) {", pattern: "input shapes: every staged" },
      { id: "shapes-secret-names", why: "a changed file whose name is not UTF-8 left unread by the secret scan", file: "scripts/ennyn.mjs", old: "(unasked.has(p) || changes.get(p)?.oldMissing)", new: "(changes.get(p)?.oldMissing)", pattern: "input shapes: every staged" },
      { id: "shapes-too-large", why: "a file past what the hook reads skipped in silence", file: "scripts/ennyn.mjs", old: "  if (past.length) say(", new: "  if (past.length < 0) say(", pattern: "input shapes: every staged" },
      { id: "shapes-secret-bytes", why: "a secret in UTF-16 or UTF-32 read as UTF-8 alone", file: "checks/secrets.mjs", old: "  if (raw?.length && raw.includes(0)) {", new: "  if (raw?.length && raw.includes(0) && false) {", pattern: "input shapes: every staged" },
      { id: "shapes-key-around", why: "a key replaced under a header the commit keeps, passed in silence", file: "scripts/ennyn.mjs", old: "    if (near.length) {", new: "    if (near.length < 0) {", pattern: "input shapes: every staged" },
      { id: "shapes-unsaid", why: "a judge that lets a check say what it has nothing to say", file: "test/input-shapes.test.mjs", old: "if (cell.unsaid && r.stderr.includes(cell.unsaid))", new: "if (cell.unsaid && false)", pattern: "input shapes control: the judge" },
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
      { id: "shapes-record", why: "a record of exact verdicts that is not compared", file: "test/input-shapes.test.mjs", old: '  return movesText("input-shapes", moves(readCells("input-shapes"), got));', new: '  return "";', pattern: "input shapes control: the judge" },
      { id: "shapes-judge", why: "a judge that takes a silent pass for an honest one", file: "test/input-shapes.test.mjs", old: 'return { problem: said ? null : "a silent pass', new: 'return { problem: said || true ? null : "a silent pass', pattern: "input shapes control: the judge" },
    ],
    others: {},
  },
  {
    test: "test/verdicts.test.mjs",
    guards: [
      { id: "verdicts-ci", why: "a YAML line break read at LF and CR only", file: "checks/ci.mjs", old: "const BREAK = /\\r\\n|[\\r\\n\\u0085\\u2028\\u2029]/;", new: "const BREAK = /\\r\\n|[\\r\\n]/;", pattern: "verdicts: every ci cell" },
      { id: "verdicts-deps", why: "install scripts in the lock let through", file: "checks/deps.mjs", old: "const scripts = fresh.filter((e) => e.scripts && !scriptsAllowed(proven(e), rule));", new: "const scripts = fresh.filter((e) => e.scripts && !scriptsAllowed(proven(e), rule) && false);", pattern: "verdicts: every deps cell" },
      { id: "verdicts-secrets", why: "a token after an escaped line break taken for part of a word", file: "checks/secrets.mjs", old: "(?<=\\\\[nrtbfv])|", new: "", pattern: "verdicts: every secrets cell" },
      { id: "verdicts-hook-names", why: "the names a commit adds no longer scanned for secrets by the hook", file: "scripts/ennyn.mjs", old: "  const names = [...changes].filter(([p, c]) => c.status === \"A\" &&", new: "  const names = [].filter(([p, c]) => c.status === \"A\" &&", pattern: "verdicts: every secrets cell" },
      { id: "verdicts-hook-message", why: "the commit message no longer scanned for secrets", file: "checks/commit-shape.mjs", old: "  if (opts.message !== undefined) for (const s of textSecrets(", new: "  if (opts.message !== undefined && false) for (const s of textSecrets(", pattern: "verdicts: every secrets cell" },
      { id: "verdicts-forbidden", why: "a decomposed line compared as written only", file: "checks/commit-shape.mjs", old: "l.text.includes(rule.text) || composed(l.text).includes(text) ||", new: "l.text.includes(rule.text) ||", pattern: "verdicts: every forbidden cell" },
      { id: "verdicts-bans", why: "a ban spelled yasaktır not read", file: "setup/scan.mjs", old: "yasak(t[ıi]r)?", new: "yasak", pattern: "verdicts: every bans cell" },
      { id: "verdicts-hook", why: "a hook whose failure || true throws away read as a check", file: "setup/hook.mjs", old: '      if (cmds[i].sep === "||" && SWALLOW.test(cmds[i + 1]?.text ?? "")) continue;\n', new: "", pattern: "verdicts: every hook cell" },
      { id: "verdicts-declarations", why: "a test declared with a space before its parenthesis not counted", file: "test/declarations.mjs", old: "|suite)\\s*(?:", new: "|suite)(?:", pattern: "verdicts: every declarations cell" },
      { id: "verdicts-cell-shape", why: "a recorded verdict that is none", file: "test/verdicts/input-shapes.json", old: '{"id":"utf8-ascii","verdict":"refused",', new: '{"id":"utf8-ascii","verdict":"refuse",', pattern: "verdicts: every cell file in test/verdicts/" },
      { id: "verdicts-gaps", why: "a gap that names no node of the graph", file: ".ennyn/graph.json", old: '"id": "ci-run-plain-continuation",', new: '"id": "ci-run-plain-continuation-later",', pattern: "verdicts: every gap and known limit names" },
      { id: "verdicts-gap-names-file", why: "a gap's node that does not lead to its cell", file: ".ennyn/graph.json", old: "recorded as a gap cell in test/verdicts/ci.json", new: "recorded as a gap cell", pattern: "verdicts: every gap and known limit names" },
      { id: "verdicts-known-design", why: "a known limit whose DESIGN.md words are gone", file: "DESIGN.md", old: "an `.npmrc` in a directory with no lock file", new: "an `.npmrc` in a directory without a lock file", pattern: "verdicts: every gap and known limit names" },
      { id: "verdicts-env", why: "a cell's git run in the outer repository's environment (GIT_DIR inside a git hook)", file: "test/verdicts.mjs", old: "export function run(cmd, args, { cwd, input, env = cellEnv(), limit = HOOK_LIMIT }) {", new: "export function run(cmd, args, { cwd, input, env = process.env, limit = HOOK_LIMIT }) {", pattern: "verdicts control: a cell's git and hook see none" },
      { id: "verdicts-crash", why: "a crashed hook's catch-all line read as a refusal", file: "test/verdicts.mjs", old: " || /^ennyn commit-check: /m.test(stderr)) throw", new: ") throw", pattern: "verdicts control: a hook that crashes" },
      { id: "verdicts-judge-moves", why: "a judge that compares each cell with itself", file: "test/verdicts.mjs", old: "    const g = got.get(c.id);\n", new: "    const g = got.has(c.id) ? c : undefined;\n", pattern: "verdicts control: a moved verdict fails" },
      { id: "verdicts-judge-recorder", why: "a recorder that adds a recorded id again", file: "test/verdicts.mjs", old: "else if (ids.has(p.id)) refused.push(", new: "else if (ids.has(p.id) && false) refused.push(", pattern: "verdicts control: the recorder" },
      { id: "verdicts-judge-bytes", why: "a latin1 value that cannot be latin1 read anyway", file: "test/verdicts.mjs", old: 'if (k === "latin1" && !/[^\\x00-\\xff]/.test(text))', new: 'if (k === "latin1")', pattern: "verdicts control: a byte value" },
    ],
  },
  {
    test: "test/reference.test.mjs",
    guards: [
      { id: "reference-scope", why: "a project's scope not read: npm sends a package to its registry, the gate proves another", file: "checks/deps.mjs", old: 'else if (x.key === "registry" || x.key === "scope" || x.key.endsWith(":registry")) set.set(x.key, x);', new: 'else if (x.key === "registry" || x.key.endsWith(":registry")) set.set(x.key, x);', pattern: "reference: every npm cell compares" },
      { id: "reference-bundle-spelling", why: "the old bundledDependencies spelling not read as npm reads it", file: "checks/deps.mjs", old: "const bd = m.bundleDependencies === undefined ? m.bundledDependencies : m.bundleDependencies;", new: "const bd = m.bundleDependencies;", pattern: "reference: every npm cell compares" },
      { id: "reference-specs-overrides", why: "the root's overrides not read, though npm fetches what they name", file: "checks/deps.mjs", old: "    if (from === \"\") overrides(pkg.overrides);\n", new: "", pattern: "reference: every npm cell compares" },
      { id: "reference-specs-folders", why: "a workspace's package.json read from the lock's copy, not from disk as npm reads it", file: "checks/deps.mjs", old: "if (parentOf(k) === null) top(k, folders(k), packages[k]);", new: "if (parentOf(k) === null) top(k, undefined, packages[k]);", pattern: "reference: every npm cell compares" },
      { id: "reference-git-tilde", why: "a path in the home directory read as GitHub shorthand, which npm reads as a file", file: "checks/deps.mjs", old: '  if (spec.startsWith("~/")) return false;\n', new: "", pattern: "reference: every npm cell compares" },
      { id: "reference-record-version", why: "a record that names no npm version", file: "test/reference/npm.json", old: '"npm": {"npm":"', new: '"npm": {"npmx":"', pattern: "reference: the npm record names its npm" },
      { id: "reference-judge-same", why: "a judge that takes every reading for npm's", file: "test/reference/npm.mjs", old: 'else out.set(k, { relation: same(claim, n) ? "agree" : "differs", claim, npm: n });', new: 'else out.set(k, { relation: "agree", claim, npm: n });', pattern: "reference control: the judge" },
      { id: "reference-judge-path", why: "a judge that takes any path npm reads for the gate's", file: "test/reference/npm.mjs", old: 'if (at.kind === "file" || at.kind === "directory" || at.kind === "link") return at.path === claim.path;', new: 'if (at.kind === "file" || at.kind === "directory" || at.kind === "link") return true;', pattern: "reference control: each reading is compared" },
      { id: "reference-judge-gap", why: "a gap that names no open node", file: "test/reference/npm.mjs", old: 'if (rel === "gap" && openNodes && !openNodes.has(text))', new: 'if (rel === "gap" && openNodes && !openNodes.has(text) && false)', pattern: "reference control: the judge" },
      { id: "reference-cc-local", why: "CLAUDE.local.md not counted, though Claude Code loads it in every session", file: "setup/scan.mjs", old: 'const ALWAYS_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];', new: 'const ALWAYS_FILES = ["CLAUDE.md", ".claude/CLAUDE.md"];', pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-bom", why: "a settings file with a byte order mark read as none, though Claude Code applies its rules", file: "setup/permissions.mjs", old: 'parsed = JSON.parse(text.replace(/^\\uFEFF/, ""));', new: "parsed = JSON.parse(text);", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-colon", why: "a rule written the older `:*` way not counted, though Claude Code applies it", file: "setup/permissions.mjs", old: 'const prefix = body.endsWith(":*") ? `${body.slice(0, -2)} `', new: 'const prefix = body.endsWith(":*") ? ""', pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-rules", why: "a rule with one path pattern not given for a path Claude Code loads it for", file: "adapters/claude-code/rules-index.mjs", old: "if (patterns) rules.push({ file, patterns });", new: "if (patterns && patterns.length > 1) rules.push({ file, patterns });", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-kept", why: "a trailing /** kept, so src/** names no folder src below the top", file: "adapters/claude-code/rules-index.mjs", old: 'const kept = one.endsWith("/**") ? one.slice(0, -3) : one;', new: "const kept = one;", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-all-star", why: "a rule whose paths are all ** read as path-scoped, though Claude Code loads it in every session", file: "adapters/claude-code/rules-index.mjs", old: 'return out.length && !out.every((p) => p === "**") ? out : null;', new: "return out.length ? out : null;", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-agents-top", why: "AGENTS.md below the top read as loaded beside the top's CLAUDE.md", file: "setup/scan.mjs", old: 'return top || (folder !== "" && stops(folder)) || !holds(f) ? "other"', new: 'return (folder !== "" && stops(folder)) || !holds(f) ? "other"', pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-agents-empty", why: "an empty or comment-only CLAUDE.md read as keeping AGENTS.md out", file: "setup/scan.mjs", old: 'return (frontMatter === null ? text : body).replace(/<!--[\\s\\S]*?-->/g, "").trim() !== "";', new: "return true;", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-after-folder", why: "a file counted on demand compared after a Read only when Claude Code loaded it", file: "test/reference/claude-code.mjs", old: 'return folder === "." || read === folder || read.startsWith(`${folder}/`);', new: "return false;", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-commands", why: "a plugin's commands/ not listed, though Claude Code loads them", file: "plan/audit.mjs", old: '"agents/**", "commands/**", "output-styles/**"', new: '"agents/**", "output-styles/**"', pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-agents", why: "AGENTS.md read as never loaded where it stands in for CLAUDE.md", file: "setup/scan.mjs", old: '"other" : folder === "" ? "always" : "on-demand";', new: '"other" : "other";', pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-hops", why: "an import chain followed a hop further than Claude Code follows it", file: "setup/scan.mjs", old: "for (let hop = 0; hop < 4 && frontier.length; hop++) {", new: "for (let hop = 0; hop < 5 && frontier.length; hop++) {", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-paths-folder", why: "a rule's pattern matched against the whole path only, though Claude Code gives it for what a named folder holds", file: "adapters/claude-code/rules-index.mjs", old: "next[j] = foldersOnly ? Number(j < S) : Number(j > 0);", new: "next[j] = foldersOnly ? Number(j < S) : Number(j === S);", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-paths-last", why: "the first of two paths keys read, though Claude Code reads the last", file: "adapters/claude-code/rules-index.mjs", old: "  for (let i = lines.length - 1; i >= 0; i--) {\n    const m = /^paths\\s*:(.*)$/.exec(lines[i]);", new: "  for (let i = 0; i < lines.length; i++) {\n    const m = /^paths\\s*:(.*)$/.exec(lines[i]);", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-bad-pattern", why: "one pattern no expression holds stops every rule, though Claude Code drops that rule only", file: "adapters/claude-code/rules-index.mjs", old: "          bad.push({ file: r.file, pattern: p });", new: "          throw new Error(p);", pattern: "reference: every Claude Code cell compares" },
      { id: "reference-cc-version", why: "a record that names no Claude Code version", file: "test/reference/claude-code.json", old: '"claudeCode": "', new: '"claudeCodex": "', pattern: "reference: the Claude Code record names" },
      { id: "reference-cc-judge-call", why: "a judge that takes every call Claude Code ran for an agreement", file: "test/reference/claude-code.mjs", old: 'relation: asks ? (stopped ? "agree" : "differs")', new: 'relation: asks ? (stopped ? "agree" : "agree")', pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-judge-pin", why: "an accepted difference whose Ennyn reading moved to another wrong value read as held", file: "test/reference/claude-code.mjs", old: "else if (pinned[k] !== r.ennyn) out.push(", new: "else if (false) out.push(", pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-judge-extra-node", why: "an accepted extra that names no node to close it", file: "test/reference/claude-code.mjs", old: 'if (rel === "extra" && node === undefined) out.push(', new: "if (false) out.push(", pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-judge-marked", why: "a file with no marker read as one Claude Code did not load", file: "test/reference/claude-code.mjs", old: "    if (!marked(p)) continue;\n    const kind", new: "    const kind", pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-judge-case", why: "a case cell compared on a disk that folds case otherwise than the record's", file: "test/reference/claude-code.mjs", old: "if (cell.case && folds !== caseFolds) return", new: "if (false) return", pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-refuse-git", why: "a cell's .git/ file let through, whose hook or fsmonitor git runs", file: "test/reference/claude-code.mjs", old: 'if (parts.some((x) => x.toLowerCase() === ".git")) out.push(', new: "if (false) out.push(", pattern: "reference control: a cell runs no command" },
      { id: "reference-cc-refuse-command", why: "a hook command other than the run marker let through", file: "test/reference/claude-code.mjs", old: 'else if (k === "command" && y !== "{{ran}}"', new: 'else if (k === "command" && false', pattern: "reference control: a cell runs no command" },
      { id: "reference-cc-judge-load", why: "a judge that takes every plugin file for one the audit lists", file: "test/reference/claude-code.mjs", old: 'relation: mine.listed.has(p) ? "agree" : "differs"', new: 'relation: "agree"', pattern: "reference control: the Claude Code judge" },
      { id: "reference-cc-spelling", why: "a spelling Claude Code matches named on doctor's line as unmatched", file: "i18n/en.json", old: "an alias, a script that pushes, gh api, an MCP tool, and on older", new: "env, an alias, a script that pushes, gh api, an MCP tool, and on older", pattern: "reference: doctor's ask line names" },
      { id: "reference-cc-spelling-class", why: "a class of spellings Claude Code runs left off doctor's line", file: "i18n/en.json", old: "a quoted or escaped push (git \\\"push\\\"), ", new: "", pattern: "reference: doctor's ask line names" },
      { id: "reference-cc-judge-gap", why: "a gap that names no open node", file: "test/reference/claude-code.mjs", old: 'if (node !== undefined && openNodes && !openNodes.has(node))', new: 'if (node !== undefined && openNodes && !openNodes.has(node) && false)', pattern: "reference control: the Claude Code judge" },
    ],
    others: {},
  },
  {
    test: "test/eval-selftest.test.mjs",
    guards: [
      { id: "eval-verdict", why: "a recorded verdict other than the one its check must get", file: "test/eval/selftest.json", old: '"quiet": {"doctor-called":false,', new: '"quiet": {"doctor-called":true,', pattern: "eval selftest: every check grades" },
      { id: "eval-grader-edited", why: "a grader edited without taking the record again", file: "test/eval/checks.mjs", old: 'flags: "", match: "not_contains" },', new: 'flags: "", match: "contains" },', pattern: "eval selftest: every check grades" },
      { id: "eval-no-failing", why: "a check with no failing reference: it is never seen to fail", file: "test/eval/checks.mjs", old: '    fail: ["three-calls", "three-calls-run", "three-refused", "subagent-call"],', new: "    fail: [],", pattern: "eval selftest: every check has a passing" },
      { id: "eval-judged-node", why: "a judged entry waiting on a node that is not open", file: "test/eval/checks.mjs", old: 'until: ["eval-trailer-after-run"],', new: 'until: ["eval-trailer-after-runs"],', pattern: "eval selftest: what no check reads is judged" },
      { id: "eval-allowed", why: "a call Claude Code let through read as refused", file: "test/eval/checks.mjs", old: '"grep-doctor", "glob", "glob-nested", "agent-push"];', new: '"grep-doctor", "glob-nested", "agent-push"];', pattern: "eval selftest: the calls let through" },
      { id: "eval-publish", why: "the eval's report published to claude.ai", file: "test/eval/selftest.mjs", old: '"--no-publish", "--no-scaffold",', new: '"--no-scaffold",', pattern: "eval selftest: the recorder's run is shut" },
      { id: "eval-profile", why: "a profile that lets the run reach any local port", file: "test/eval/selftest.mjs", old: '(remote ip "localhost:${port}")', new: '(remote ip "localhost:*")', pattern: "eval selftest: the recorder's run is shut" },
      { id: "eval-canary-skipped", why: "an eval started without the canary proving the profile shut", file: "test/eval/selftest.mjs", old: "const shut = canaryProblems(runCanary(server.port, R));", new: "const shut = [];", pattern: "eval selftest: the recorder runs the canary first" },
      { id: "eval-run-dirs-before", why: "a run directory that was there before the run read as the run's", file: "test/eval/selftest.mjs", old: '.filter((name) => RUN_DIR.test(name) && !before.has(name))', new: '.filter((name) => RUN_DIR.test(name))', pattern: "eval selftest: a run directory is one the eval made" },
      { id: "eval-not-measured", why: "a machine with no sandbox-exec passing check", file: "test/eval/selftest.mjs", old: 'if (e instanceof NotMeasured && cmd === "check") return { code: 1,', new: 'if (e instanceof NotMeasured && cmd === "check") return { code: 0,', pattern: "eval selftest: a machine with no sandbox-exec" },
      { id: "eval-judge", why: "a judge that takes any recorded verdict for the one its check must get", file: "test/eval/selftest.mjs", old: "else if (got[id] !== expected(id, ref))", new: "else if (false)", pattern: "eval selftest control" },
    ],
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
  "test/ci.test.mjs": CLI_ONLY,
  "test/bypass.test.mjs": CLI_ONLY,
  "test/cli.test.mjs": CLI_ONLY,
  "test/deps.test.mjs": { reason: "runs the CLI on temporary repositories against recorded registry and OSV answers", allow: '"scripts", "ennyn\\.mjs"|"__fixtures__", "deps"' },
  "test/forbidden.test.mjs": CLI_ONLY,
  "test/secrets.test.mjs": CLI_ONLY,
  "test/gate-log.test.mjs": CLI_ONLY,
  "test/hook.test.mjs": CLI_ONLY,
  "test/mutation.test.mjs": CLI_ONLY,
  "test/setup.test.mjs": CLI_ONLY,
  "test/impact.test.mjs": { reason: "import.meta is text in a fixture it writes", allow: "__fixtures__/rows\\.jsonl" },
  "test/side-copy.test.mjs": { reason: "runs the side-copy hooks on temporary projects", allow: '"\\.\\./adapters/claude-code/hooks/side-copy-(rules|reset)\\.mjs", import\\.meta\\.url' },
};
