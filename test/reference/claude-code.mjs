/**
 * Reference differentials for Claude Code: what Claude Code itself does with a project's settings, instruction and
 * rule files and a plugin's files, recorded, and Ennyn's readings of them replayed against it. Ennyn reads what
 * Claude Code reads in four places: the ask and deny rules a project's settings hold for the commands that leave
 * the machine (setup/permissions.mjs, doctor's ask-rules line), the instruction files a session loads
 * (setup/scan.mjs agentSetup, which budget and init-scan count), the path-scoped rules a touched path loads (the
 * side-copy hook's adapters/claude-code/rules-index.mjs), and the files of a plugin that run or reach the model (the
 * security audit's list, plan/audit.mjs). Cycle 2026-10-25 (11) found the class about 12 times in the settings
 * reading and 9 in the plugin listing, each by a reviewer a round later. Here Claude Code gives the expected values.
 *
 * Recording runs the machine's Claude Code in print mode on the cell's files, in a directory of its own, with a
 * stand-in for the model: a server on 127.0.0.1 that answers the first request with the cell's one tool call (a
 * Bash command or a Read) and every later one with text. Its key is no key of Anthropic's, and the home, config,
 * runtime and temporary directories are the cell's; Claude Code's environment and git's are built here from nothing
 * but PATH, and git runs no hook and no file-system monitor. What Claude Code sent the stand-in is its reading:
 * every Markdown file ends with a marker (`MARK:<path>`; `{{mark}}` puts it in place instead, as in a description a
 * listing shows; `{{nomark}}` leaves a file empty), the markers of the first request are what it loaded at the
 * start, and those new in the last what the tool call loaded. Whether the call was stopped is the run's own report
 * (the result's `permission_denials`), in bypassPermissions mode.
 *
 * A cell runs no command of its own: commands come from this file only. A Bash call names one of SPELLINGS; a hook's
 * or MCP server's command is `{{ran}}`, which appends the file's path to a list, and a plugin's `bin/` script is that
 * too; the programs that reach outside (STUBBED) are stand-ins on PATH that add their name to that list, so a spelling
 * no rule stops writes nothing and calls no one, and a real gh would have no host to reach. The one file a spelling
 * hands to a shell (`runs`) is written here with that marker in it, and only the marker script is written runnable. A cell may give the repository a linked worktree outside it (`worktree`,
 * at ../w) and make its call from a subagent (`agent`: the stand-in calls Agent, and the Bash call comes in the
 * subagent's request). A cell may also put plain files in its home (`home`, never one that runs), set EN_PROBE_* variables
 * (`env`), read a home file (`{ Read: "~/<path>" }`) and start Claude Code with no mode flag or with
 * --dangerously-skip-permissions (`launch`). cellProblems refuses any other command, a cell holding the file its spelling runs, a settings key that runs or redirects something (a helper, a status
 * line, an `env` other than EN_PROBE_*, MCP servers of the project), a path under `.git`, an import outside the cell,
 * and `{{bytes:N}}` past 4 MiB a file or 8 MiB a cell. Not measured by the review that set these rules: reads Claude
 * Code makes in the real home, sockets it opens past a proxy, a process that outlives the run's kill, and the case
 * folding of a Linux disk (the record is taken on macOS).
 *
 * Each place compares to one of:
 *   agree       Ennyn reads what Claude Code does
 *   stricter    Claude Code stops a call Ennyn says no rule stops (a tool-wide rule, a spelling the doctor names
 *               as unmatched): Ennyn warns where it need not, on purpose or in its text
 *   extra       Ennyn counts a file Claude Code did not load there
 *   differs     Ennyn claims what Claude Code does not do: a rule read as asking that Claude Code does not apply,
 *               a spelling it runs that doctor's line does not name, a file it loads that Ennyn does not count or list
 *   unmeasured  Claude Code was not measured there (the tool was not called, the run did not end); never an agreement
 * A cell lists every place that does not agree in `except` ("*" for every other one), each with why:
 * `stricter: …`, `extra: …`, `unmeasured: …`, and for `differs` either `gap: <open graph node>` or `differs: …`
 * (meant). Claude Code's version is in the record: `check` reads every cell again and fails when the version or a
 * reading moved; `record` takes the record again and the test shows which comparisons moved.
 *
 *   node test/reference/claude-code.mjs add <probes.json> [--claude <bin>]   record new cells
 *   node test/reference/claude-code.mjs show [id…]                           each place's comparison
 *   node test/reference/claude-code.mjs check [--claude <bin>]               exit 1 when Claude Code reads a cell otherwise
 *   node test/reference/claude-code.mjs record [--claude <bin>]              take every reading again
 * The binary is `--claude`, else `claude` on PATH (`npm run test:reference -- --claude <bin>`). `check` also holds the
 * binary to the steps around its Markdown parser that test/reference/markdown.json models.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS } from "../../plugin/core/config.mjs";
import { sensitivePaths } from "../../plugin/plan/audit.mjs";
import { askRules } from "../../plugin/setup/permissions.mjs";
import { agentSetup, projectFiles } from "../../plugin/setup/scan.mjs";
import { loadPathScopedRules, rulesForPath } from "../../plugin/adapters/claude-code/rules-index.mjs";
import { claudeBinary, safePath, versionOf } from "./claude-bin.mjs";

export { claudeBinary, safePath, versionOf };

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORD = join(HERE, "claude-code.json");
const CELL_KEYS = ["id", "from", "case", "files", "home", "env", "launch", "call", "cwd", "plugin", "worktree", "agent", "cc", "except", "ennyn"];
export const RELATIONS = /** @type {const} */ (["agree", "stricter", "extra", "differs", "unmeasured"]);

/**
 * The commands a cell's Bash call may be, by name, each with what Ennyn says of it under a rule that covers
 * `git push`: `plain`, its rules claim it (ruleCovers); `matched`, doctor's line names it nowhere as unmatched, so
 * a rule applies; `option`, `quoted`, `shell`, `built`, the classes doctor's line names as unmatched; `none`, no
 * outward command (the cell checks something else). Claude Code before 2.1.309 ran a full path (2.1.306 and 2.1.308
 * measured) and 2.1.207 a subshell, which the line says apart; the record's version matches them. A spelling in a
 * class the line names that Claude Code stops all the same (`G=git; $G push`) is stricter, listed with why. `about`
 * is the command the spelling is judged under, for one that is no push; the cell's rules are read for that command.
 * `runs` is the file the command hands to a shell, in lower case: the recorder writes it, and a cell that makes this
 * call may not hold the name.
 * @type {Readonly<Record<string, { command: string, class: string, about?: string, runs?: string }>>}
 */
export const SPELLINGS = Object.freeze({
  push: { command: "git push", class: "plain" },
  "push-args": { command: "git push origin main", class: "plain" },
  "push-force": { command: "git push --force origin HEAD", class: "plain" },
  "and-after": { command: "git push && true", class: "plain" },
  pipe: { command: "git push | cat", class: "plain" },
  "push-tab": { command: "git push\torigin", class: "matched" },
  "two-spaces": { command: "git  push", class: "matched" },
  "leading-space": { command: "  git push", class: "matched" },
  env: { command: "env git push", class: "matched" },
  "env-i": { command: "env -i git push", class: "matched" },
  variable: { command: "GIT_TRACE=0 git push", class: "matched" },
  "and-before": { command: "true && git push", class: "matched" },
  semicolon: { command: "true; git push", class: "matched" },
  newline: { command: "true\ngit push", class: "matched" },
  background: { command: "true & git push", class: "matched" },
  backslash: { command: "\\git push", class: "matched" },
  quoted: { command: '"git" push', class: "matched" },
  command: { command: "command git push", class: "matched" },
  nohup: { command: "nohup git push", class: "matched" },
  time: { command: "time git push", class: "matched" },
  timeout: { command: "timeout 5 git push", class: "matched" },
  nice: { command: "nice git push", class: "matched" },
  exec: { command: "exec git push", class: "matched" },
  "brace-group": { command: "{ git push; }", class: "matched" },
  if: { command: "if true; then git push; fi", class: "matched" },
  for: { command: "for x in 1; do git push; done", class: "matched" },
  function: { command: "f() { git push; }; f", class: "matched" },
  "full-path": { command: "/usr/bin/git push", class: "matched" },
  subshell: { command: "(git push)", class: "matched" },
  "dash-C": { command: "git -C . push", class: "option" },
  "dash-c": { command: "git -c core.x=y push", class: "option" },
  "no-pager": { command: "git --no-pager push", class: "option" },
  "git-dir": { command: "git --git-dir=.git push", class: "option" },
  "double-dash": { command: "git -- push", class: "option" },
  "quoted-word": { command: 'git "push"', class: "quoted" },
  "ansi-c": { command: "git $'push'", class: "quoted" },
  "split-word": { command: 'git p""ush', class: "quoted" },
  "sh-c": { command: "sh -c 'git push'", class: "shell" },
  "bash-c": { command: "bash -c 'git push'", class: "shell" },
  eval: { command: "eval git push", class: "shell" },
  xargs: { command: "echo push | xargs git", class: "shell" },
  "xargs-I": { command: "echo x | xargs -I{} git push", class: "shell" },
  "pipe-sh": { command: "echo git push | sh", class: "shell" },
  herestring: { command: 'sh <<< "git push"', class: "shell" },
  "find-exec": { command: "find . -maxdepth 0 -exec git push \\;", class: "shell" },
  substitution: { command: "$(echo git) push", class: "built" },
  backtick: { command: "`echo git` push", class: "built" },
  ifs: { command: "git${IFS}push", class: "built" },
  "escaped-word": { command: "git \\push", class: "quoted" },
  "escaped-mid": { command: "git pu\\sh", class: "quoted" },
  "single-quoted": { command: "git 'push'", class: "quoted" },
  "var-built": { command: "G=git; $G push", class: "built" },
  "default-built": { command: "git ${X:-push}", class: "built" },
  "dash-P": { command: "git -P push", class: "option" },
  redirect: { command: "git push > /dev/null", class: "plain" },
  comment: { command: "git push # x", class: "plain" },
  "trailing-semi": { command: "git push;", class: "matched" },
  "trailing-nl": { command: "git push\n", class: "matched" },
  "env-var": { command: "env GIT_TRACE=0 git push", class: "matched" },
  "cd-and": { command: "cd . && git push", class: "matched" },
  "plugin-bin": { command: "en-probe-bin", class: "none" },
  // What the ask rules' reports claim of a command that is no push (setup/permissions.mjs, skills/init/gates.md).
  "gh-api-end": { command: "gh api repos/x -X POST", class: "plain", about: "gh api *-X POST*" },
  "gh-api-first": { command: "gh api -X POST repos/x", class: "plain", about: "gh api *-X POST*" },
  "gh-api-middle": { command: "gh api repos/x -X POST -f a=b", class: "plain", about: "gh api *-X POST*" },
  "gh-api-word-end": { command: "gh api repos/x --method DELETE", class: "plain", about: "gh api *--method DELETE*" },
  "gh-api-glued": { command: "gh api repos/x -XPOST", class: "option", about: "gh api *-X POST*" },
  "gh-api-equals": { command: "gh api repos/x --method=POST", class: "option", about: "gh api *--method POST*" },
  "gh-api-lower": { command: "gh api repos/x -X post", class: "option", about: "gh api *-X POST*" },
  "gh-api-field": { command: "gh api repos/x -f a=b", class: "option", about: "gh api *-X POST*" },
  "gh-api-search": { command: "gh api search/issues -X GET -f q=POST", class: "none" },
  "gh-api-read": { command: "gh api repos/x", class: "none" },
  "gh-repo-delete": { command: "gh repo delete x --yes", class: "plain", about: "gh repo delete" },
  "gh-gist-create": { command: "gh gist create f", class: "plain", about: "gh gist create" },
  "clean-top": { command: "git clean -fd", class: "plain", about: "git clean" },
  "clean-cd-worktree": { command: "cd ../w && git clean -fd", class: "matched", about: "git clean" },
  "clean-semi-worktree": { command: "cd ../w; git clean -fd", class: "matched", about: "git clean" },
  "clean-cd-slash-worktree": { command: "cd ../w/ && git clean -fd", class: "matched", about: "git clean" },
  "clean-dash-C-worktree": { command: "git -C ../w clean -fd", class: "option", about: "git clean" },
  "clean-dash-C-dot": { command: "git -C . clean -fd", class: "option", about: "git clean" },
  "clean-dash-C-slash": { command: "git -C ./ clean -fd", class: "option", about: "git clean" },
  "reset-hard": { command: "git reset --hard", class: "plain", about: "git reset *--hard*" },
  "reset-hard-rev": { command: "git reset --hard HEAD", class: "plain", about: "git reset *--hard*" },
  "reset-rev-hard": { command: "git reset HEAD --hard", class: "plain", about: "git reset *--hard*" },
  "reset-soft": { command: "git reset --soft HEAD", class: "none" },
  "checkout-dashes": { command: "git checkout -- x.txt", class: "plain", about: "git checkout *-- *" },
  "checkout-rev-dashes": { command: "git checkout HEAD -- x.txt", class: "plain", about: "git checkout *-- *" },
  "checkout-new": { command: "git checkout -b other", class: "none" },
  "compose-down-v": { command: "docker compose down -v", class: "plain", about: "docker compose down *-v*" },
  "compose-down-volumes": { command: "docker compose down --volumes", class: "plain", about: "docker compose down *-v*" },
  "compose-down": { command: "docker compose down --remove-orphans", class: "none" },
  "npx-prisma": { command: "npx prisma migrate reset", class: "plain", about: "npx prisma migrate reset" },
  "npm-global": { command: "npm install -g tsx", class: "plain", about: "npm install -g" },
  "npm-global-after": { command: "npm install tsx -g", class: "option", about: "npm install -g" },
  "pipe-to-sh": { command: "echo true | sh", class: "plain", about: "sh" },
  "pipe-to-bash": { command: "echo true | bash", class: "plain", about: "bash" },
  "pipe-to-sh-s": { command: "echo true | sh -s", class: "option", about: "sh" },
  "sh-c-plain": { command: "sh -c true", class: "none" },
  "gh-api-group": { command: "gh api repos/x -iX POST", class: "option", about: "gh api *-X POST*" },
  "gh-api-quoted": { command: 'gh api repos/x -X "POST"', class: "option", about: "gh api *-X POST*" },
  "gh-api-search-phrase": { command: "gh api search/issues -X GET -f 'q=curl -X POST'", class: "none" },
  "gh-api-grep": { command: "gh api repos/x | grep -- '-X POST'", class: "none" },
  "gh-repo-create-push": { command: "gh repo create x --source . --push", class: "plain", about: "gh repo create" },
  "sh-s-rule": { command: "echo true | sh -s", class: "plain", about: "sh -s*" },
  "bash-s-rule": { command: "echo true | bash -s -- -y", class: "plain", about: "bash -s*" },
  "bash-script": { command: "bash x.txt", class: "none", runs: "x.txt" },
  "npm-after-rule": { command: "npm install tsx -g", class: "plain", about: "npm install * -g*" },
  "npm-global-long": { command: "npm install --global tsx", class: "plain", about: "npm install *--global*" },
  "npm-global-long-after": { command: "npm install tsx --global", class: "plain", about: "npm install *--global*" },
  "npm-local": { command: "npm install my-gizmo", class: "none" },
  "npm-dev": { command: "npm install --save-dev tsx", class: "none" },
  "pnpm-after": { command: "pnpm add tsx -g", class: "plain", about: "pnpm add * -g*" },
  "pnpm-global": { command: "pnpm add --global tsx", class: "plain", about: "pnpm add *--global*" },
  "pnpm-local": { command: "pnpm add my-gizmo", class: "none" },
  "compose-v1-down-v": { command: "docker-compose down -v", class: "plain", about: "docker-compose down *-v*" },
  "compose-v1-down": { command: "docker-compose down --remove-orphans", class: "none" },
  "compose-service": { command: "docker compose down api-v2", class: "none" },
  "checkout-dot": { command: "git checkout .", class: "plain", about: "git checkout ." },
  "checkout-dotfile": { command: "git checkout .gitignore", class: "none" },
  "branch-d-f": { command: "git branch -d -f y", class: "plain", about: "git branch -d -f" },
  "branch-d": { command: "git branch -d y", class: "none" },
  "compose-down-pipe": { command: "docker compose down 2>&1 | grep -v warning", class: "none" },
  "npm-global-style": { command: "npm install --global-style tsx", class: "none" },
  "gh-api-flag-quoted": { command: 'gh api "-X" POST repos/x', class: "option", about: "gh api *-X POST*" },
  // What a sandboxed command reads of the cell's home and environment: the reading's `seen` names what came back.
  "secret-read": { command: 'cat "$HOME/.ssh/id_x" "$HOME/.aws/credentials"; echo "token=[$EN_PROBE_TOKEN]"', class: "none" },
});
/**
 * The files a cell's home may hold, each a stand-in read as data: a key in `.ssh` (`id_<name>`), the AWS credentials
 * file, and a file outside the project (`outside.txt`). None is a configuration any program on the way reads.
 */
const HOME_FILES = [/^\.ssh\/id_[A-Za-z0-9_]+$/, /^\.aws\/credentials$/, /^outside\.txt$/];
/** How a cell starts Claude Code: bypassPermissions (left out), no mode flag, or --dangerously-skip-permissions. */
const LAUNCH = { default: [], "skip-permissions": ["--dangerously-skip-permissions"] };
/** The classes doctor's line names as not matched. */
export const UNMATCHED = Object.freeze(["option", "quoted", "shell", "built"]);

/** The only script a cell may hold (a plugin's `bin/`), and the only MCP server: each writes the run marker. */
const SCRIPT = "#!/bin/sh\n{{ran}}\n";
/** The programs a spelling names that reach outside the cell: each a stand-in that does nothing, first on PATH. */
export const STUBBED = ["gh", "docker", "docker-compose", "npm", "npx", "pnpm"];
/** Top-level settings keys a cell may write, beside `en_probe_*` ones: none runs or redirects anything. */
const SETTINGS_KEYS = ["permissions", "hooks", "model", "env", "sandbox"];
const PERMISSION_KEYS = ["allow", "ask", "deny", "defaultMode", "additionalDirectories", "disableBypassPermissionsMode"];
/**
 * The sandbox keys a cell may write, each with the keys below it: the ones the secret setup reads and the block
 * /ennyn:init writes. None runs a program, opens a port or names a proxy; `allowWrite` widens only what a sandboxed
 * command may write, and a cell's command is a stand-in.
 */
const SANDBOX_KEYS = { enabled: null, failIfUnavailable: null, autoAllowBashIfSandboxed: null, filesystem: ["allowWrite"], network: ["allowedDomains"], credentials: ["files", "envVars"] };
const MANIFEST_KEYS = ["name", "version", "description", "commands", "agents", "skills", "hooks", "mcpServers", "outputStyles"];
/** Keys that run, fetch or redirect, refused in any JSON file of a cell. */
const REFUSED_KEYS = ["url", "headers", "cwd", "apiKeyHelper", "statusLine", "subagentStatusLine", "fileSuggestion", "otelHeadersHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "enableAllProjectMcpServers", "enabledMcpjsonServers", "extraKnownMarketplaces", "enabledPlugins", "dependencies", "lspServers", "monitors"];
const BYTES = /\{\{bytes:(\d+)\}\}/g;
const FILE_BYTES = 4 * 1024 * 1024;
const CELL_BYTES = 8 * 1024 * 1024;

/** A path a cell may hold: plain names, none `.` or `..`, which a marker spells back whole. @param {unknown} p */
const safe = (p) => typeof p === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && p.split("/").every((x) => x !== "." && x !== "..");
const MARK = /MARK:([A-Za-z0-9._/-]+)/g;
/** The file a Read call names: in the project, or `~/<path>` in the cell's home. @param {string} read @param {string} project @param {string} home */
const readPath = (read, project, home) => (read.startsWith("~/") ? join(home, read.slice(2)) : join(project, read));

/**
 * @typedef {{ start: string[], after?: string[], call?: string, ran?: string[], by?: "subagent", seen?: string[] }} CcReading what Claude Code
 *   loaded at the start and after the call (paths), what became of the call (`ran`, `stopped: <reason>`, `unmeasured:
 *   …`), which files' commands ran, and `by`: the run names the cell's subagent as the call's parent; `seen`, for a cell
 *   with `home` or `env`, the home files (`home:<path>`) and variables (`env:<name>`) whose text came back to the model
 * @typedef {{ id: string, from: string, case?: true, files: Record<string, string>, home?: Record<string, string>, env?: Record<string, string>, launch?: keyof typeof LAUNCH, call?: { Bash: string } | { Read: string }, cwd?: string, plugin?: string, worktree?: true, agent?: "foreground" | "background", cc?: CcReading, except?: Record<string, string>, ennyn?: Record<string, string> }} Cell
 *   `case`: Claude Code's reading hangs on the disk folding case (a name in another case), so it is compared only on a
 *   disk that folds case as the record's did; `ennyn`: Ennyn's reading at each place `except` lists, so an accepted
 *   difference that moves to another wrong value is seen
 * @typedef {{ relation: typeof RELATIONS[number], ennyn: string, cc: string }} Comparison
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A cell's files as written in `dir`: placeholders filled, a marker at the end of each Markdown file without one.
 * @param {Cell} c @param {string} dir
 */
export function rendered(c, dir) {
  return Object.fromEntries(
    Object.entries(c.files).map(([path, text]) => {
      const placed = text.includes("{{mark}}") || text.includes("{{nomark}}");
      let body = text
        .split("{{mark}}").join(`MARK:${path}`)
        .split("{{nomark}}").join("")
        .split("{{ran}}").join(`echo ${path} >> ${dir}/.ran`)
        .replace(BYTES, (_, n) => "a".repeat(Number(n)));
      if (!placed && /\.md$/i.test(path)) body += `${body === "" || body.endsWith("\n") ? "" : "\n"}MARK:${path}\n`;
      return [path, body];
    }),
  );
}

/** Writes a cell's files under `dir`, and the file its spelling runs, which holds the run marker. @param {Cell} c @param {string} dir */
export function writeCell(c, dir) {
  for (const [path, body] of Object.entries(rendered(c, dir))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    // The marker script is written runnable, as a plugin's bin/ holds it; nothing else is, whatever its text comes to.
    writeFileSync(join(dir, path), body, { mode: c.files[path] === SCRIPT ? 0o755 : 0o644 });
  }
  const runs = c.call && "Bash" in c.call ? SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (c.call.Bash)]?.runs : undefined;
  if (runs) writeFileSync(join(dir, runs), `echo ${runs} >> ${dir}/.ran\n`);
}

/**
 * Ennyn's readings of a cell whose files are written in `dir`: whether its rules ask about `git push` (or what the
 * spelling is judged under), the kind
 * each instruction file loads as and the file whose import loads it (agentSetup), the rules the side-copy hook
 * gives for a Read's path, and the files the security audit lists.
 * @param {Cell} c @param {string} dir
 */
export function readings(c, dir) {
  const files = Object.keys(c.files).sort();
  const about = (c.call && "Bash" in c.call ? SPELLINGS[c.call.Bash]?.about : undefined) ?? "git push";
  const rule = askRules(projectFiles(dir), [about]).rules.some((r) => r.tool === "Bash" && r.where !== null && r.where !== "unknown");
  const setup = agentSetup(dir, files);
  const kinds = new Map(setup.instructions.map((i) => [i.path, i.loads]));
  const via = new Map(setup.instructions.flatMap((i) => ("via" in i && i.via ? [[i.path, i.via]] : [])));
  const bad = /** @type {{ file: string, pattern: string }[]} */ ([]);
  const relative = (/** @type {string} */ f) => f.slice(dir.length + 1).split("\\").join("/");
  const given = c.call && "Read" in c.call ? rulesForPath(loadPathScopedRules(dir), c.call.Read, bad).map(relative) : [];
  const machine = sensitivePaths(files, DEFAULTS).find((s) => s.source === "machine");
  return { rule, kinds, via, given: new Set(given), bad: new Set(bad.map((b) => relative(b.file))), listed: new Set(machine?.files ?? []) };
}

/** The folder a file loads with: `sub` for sub/CLAUDE.md and sub/.claude/AGENTS.md, `.` for the top's. @param {string} p */
const folderOf = (p) => posix.dirname(p).replace(/(^|\/)\.claude$/, "") || ".";

/**
 * Each place's comparison: Ennyn's readings (from `readings`) against Claude Code's recorded one, both ways.
 * @param {Cell} c @param {ReturnType<typeof readings>} mine @returns {Map<string, Comparison>}
 */
export function compare(c, mine) {
  const cc = /** @type {CcReading} */ (c.cc);
  /** @type {Map<string, Comparison>} */
  const out = new Map();
  // A plugin at the top (`"."`) holds every file.
  const inPlugin = (/** @type {string} */ p) => c.plugin !== undefined && (c.plugin === "." || p.startsWith(`${c.plugin}/`));
  // A file written with no marker cannot show whether Claude Code loaded it: its place is not compared.
  const marked = (/** @type {string} */ p) => {
    const text = c.files[p];
    return text === undefined || text.includes("{{mark}}") || (/\.md$/i.test(p) && !text.includes("{{nomark}}"));
  };
  const spelling = c.call && "Bash" in c.call ? SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (c.call.Bash)] : undefined;
  if (spelling && spelling.class !== "none") {
    // Ennyn says a rule asks when the file holds one covering git push, the call is spelled as doctor's line does
    // not name, and the session starts at the top (the line says one below reads its own folder's .claude/).
    const asks = mine.rule && !UNMATCHED.includes(spelling.class) && !c.cwd;
    const said = asks ? "asks" : mine.rule ? `no rule for this spelling or folder (${spelling.class})` : "no rule";
    if (!cc.call || cc.call.startsWith("unmeasured")) out.set("call", { relation: "unmeasured", ennyn: said, cc: cc.call ?? "none" });
    else {
      const stopped = cc.call.startsWith("stopped");
      out.set("call", { relation: asks ? (stopped ? "agree" : "differs") : stopped ? "stricter" : "agree", ennyn: said, cc: cc.call });
    }
  }
  // Instruction files at the start: Claude Code's loads against what Ennyn counts in every session.
  const start = new Set(cc.start.filter((p) => !inPlugin(p)));
  const always = [...mine.kinds].filter(([, k]) => k === "always").map(([p]) => p);
  for (const p of new Set([...start, ...always])) {
    if (!marked(p)) continue;
    const kind = mine.kinds.get(p) ?? "none";
    out.set(`start:${p}`, { relation: start.has(p) ? (kind === "always" ? "agree" : "differs") : "extra", ennyn: kind, cc: start.has(p) ? "loaded" : "not loaded" });
  }
  // After a Read: a path-scoped rule is the side-copy hook's to give; any other file Ennyn counts on demand loads
  // with a folder the path lies in, or with the file whose import loads it.
  // A Read of the cell's home is outside the project: no instruction file loads with it.
  if (c.call && "Read" in c.call && !c.call.Read.startsWith("~/")) {
    const read = c.call.Read;
    if (!cc.call || cc.call !== "ran") out.set("after", { relation: "unmeasured", ennyn: "-", cc: cc.call ?? "none" });
    else {
      const after = new Set((cc.after ?? []).filter((p) => !inPlugin(p)));
      /** @param {string} p @param {number} [hops] */
      const loadsHere = (p, hops = 0) => {
        if (mine.kinds.get(p) !== "on-demand" || p.startsWith(".claude/rules/") || hops > 8) return false;
        const from = mine.via.get(p);
        if (from !== undefined) return loadsHere(from, hops + 1);
        // A file of the top's that Ennyn counts on demand would load with any path.
        const folder = folderOf(p);
        return folder === "." || read === folder || read.startsWith(`${folder}/`);
      };
      const claimed = [...mine.kinds.keys()].filter((p) => loadsHere(p));
      for (const p of new Set([...after, ...mine.given, ...claimed])) {
        if (!marked(p)) continue;
        const rule = p.startsWith(".claude/rules/");
        const claims = rule ? mine.given.has(p) : loadsHere(p);
        const ennyn = rule ? (claims ? "given" : mine.bad.has(p) ? "a pattern Ennyn cannot read" : "not given") : mine.kinds.get(p) ?? "none";
        out.set(`after:${p}`, { relation: after.has(p) ? (claims ? "agree" : "differs") : claims ? "extra" : "agree", ennyn, cc: after.has(p) ? "loaded" : "not loaded" });
      }
    }
  }
  // A plugin's files that reached the model or ran: each one the audit must list.
  for (const p of new Set([...cc.start, ...(cc.after ?? []), ...(cc.ran ?? [])].filter(inPlugin))) {
    out.set(`load:${p}`, { relation: mine.listed.has(p) ? "agree" : "differs", ennyn: mine.listed.has(p) ? "listed" : "not listed", cc: (cc.ran ?? []).includes(p) ? "ran" : "loaded" });
  }
  return out;
}

/**
 * The comparisons that differ from what the cell lists, each as a line; none when the record holds. A place `except`
 * lists has its why: `stricter: …`, `unmeasured: …`, `differs: …` (meant), and for a hole `gap: <node>` or `extra: …
 * (<node>)`, the open graph node that will close it; `ennyn` pins Ennyn's reading there, so a move from one wrong
 * value to another is seen until the record says why. A cell compared nowhere (`skipped`) moves nothing.
 * @param {{ cell: Cell, got: Map<string, Comparison>, skipped?: string }[]} compared @param {Set<string>} [openNodes] the graph's open node ids
 */
export function moves(compared, openNodes) {
  /** @type {string[]} */
  const out = [];
  for (const { cell: c, got, skipped } of compared) {
    if (skipped) continue;
    const except = c.except ?? {};
    const pinned = c.ennyn ?? {};
    for (const [k, why] of Object.entries(except)) {
      const [rel, ...rest] = why.split(":");
      const text = rest.join(":").trim();
      if (!text) out.push(`${c.id} ${k}: "${why}" gives no why`);
      const node = rel === "gap" ? text : rel === "extra" ? /\(([a-z0-9]+(?:-[a-z0-9]+)+)\)$/.exec(text)?.[1] : undefined;
      if (rel === "extra" && node === undefined) out.push(`${c.id} ${k}: an extra names no graph node, in parentheses at its end`);
      if (node !== undefined && openNodes && !openNodes.has(node)) out.push(`${c.id} ${k}: names no open graph node: ${node}`);
      const r = got.get(k);
      if (!r) out.push(`${c.id} ${k}: listed, but neither Claude Code nor Ennyn has this place`);
      else if (!(k in pinned)) out.push(`${c.id} ${k}: Ennyn's reading is not pinned (${JSON.stringify(r.ennyn)})`);
      else if (pinned[k] !== r.ennyn) out.push(`${c.id} ${k}: Ennyn reads ${JSON.stringify(r.ennyn)}, recorded ${JSON.stringify(pinned[k])}`);
    }
    for (const k of Object.keys(pinned)) if (!(k in except)) out.push(`${c.id} ${k}: Ennyn's reading pinned where except lists nothing`);
    for (const [k, r] of got) {
      const rel = (except[k] ?? "agree").split(":")[0];
      const want = rel === "gap" ? "differs" : rel;
      if (want !== r.relation) out.push(`${c.id} ${k}: ${r.relation}, recorded ${want} — Ennyn ${r.ennyn}, Claude Code ${r.cc}`);
    }
  }
  return out;
}

/**
 * @typedef {{ claudeCode: string, caseFolds: boolean, cells: Cell[] }} Record the Claude Code its readings came from,
 *   whether the disk they were taken on folds case, and the cells
 */

/** The record. @returns {Record} */
export function readRecord(path = RECORD) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The record as written: its header, then one cell a line, so a diff shows the cells that moved. @param {Record} rec */
export function recordText(rec) {
  const cells = rec.cells.map((c) => `    ${JSON.stringify(Object.fromEntries(CELL_KEYS.filter((k) => k in c).map((k) => [k, /** @type {any} */ (c)[k]])))}`);
  return `{\n  "claudeCode": ${JSON.stringify(rec.claudeCode)},\n  "caseFolds": ${JSON.stringify(rec.caseFolds)},\n  "cells": [\n${cells.join(",\n")}\n  ]\n}\n`;
}

/** Whether the disk under `dir` folds case: a name in another case is the same file. @param {string} dir */
export function foldsCase(dir) {
  const probe = join(dir, "en-case-probe");
  writeFileSync(probe, "");
  try {
    return existsSync(join(dir, "EN-CASE-PROBE"));
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * What in one JSON value of a cell could run or reach something: a `command` that is not the run marker (or `sh`
 * running it), `args` other than that, a key that runs, fetches or redirects, an `env` anywhere but at the top of a
 * settings file (`settings`), which fileProblems holds to EN_PROBE_* names. Each problem as a line.
 * @param {unknown} v @param {string} where @param {boolean} settings
 */
function jsonProblems(v, where, settings) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {unknown} */ x, /** @type {string} */ at) => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${at}[${i}]`));
    if (!isObject(x)) return;
    for (const [k, y] of Object.entries(x)) {
      if (REFUSED_KEYS.includes(k) || (k === "env" && !(settings && at === ""))) out.push(`${where}: ${at}${k} runs, fetches or redirects something`);
      else if (k === "command" && y !== "{{ran}}" && !(y === "sh" && JSON.stringify(x.args) === JSON.stringify(["-c", "{{ran}}"]))) out.push(`${where}: ${at}${k} is not the run marker`);
      else if (k === "args" && JSON.stringify(y) !== JSON.stringify(["-c", "{{ran}}"])) out.push(`${where}: ${at}${k} is not sh running the run marker`);
      else walk(y, `${at}${k}.`);
    }
  };
  walk(v, "");
  return out;
}

/**
 * What in a cell's files could run a command, reach the network, read outside the cell or grow past the bounds:
 * each problem as a line. Commands come from this file only (see the head of this file).
 * @param {Cell} c
 */
function fileProblems(c) {
  /** @type {string[]} */
  const out = [];
  let total = 0;
  const inPlugin = (/** @type {string} */ p) => c.plugin !== undefined && (c.plugin === "." || p.startsWith(`${c.plugin}/`));
  for (const [path, text] of Object.entries(c.files)) {
    const at = `${c.id}: ${path}`;
    const parts = path.split("/");
    let bytes = 0;
    for (const m of text.matchAll(BYTES)) bytes += Number(m[1]);
    total += bytes;
    if (bytes > FILE_BYTES) out.push(`${at}: {{bytes}} past ${FILE_BYTES} in a file`);
    if (parts.some((x) => x.toLowerCase() === ".git")) out.push(`${at}: a path under .git (git's hooks and config run code)`);
    // git takes a folder with a HEAD for a repository, with no .git in any path, and with commondir it needs no objects
    // or refs beside it; no HEAD, no repository. Any spelling that reads the index would then run that folder's config.
    if (parts.some((x) => x.toLowerCase() === "head")) out.push(`${at}: a HEAD makes its folder a repository, whose config runs code`);
    if (/@[/~]/.test(text)) out.push(`${at}: an import outside the cell`);
    // A disk that folds case opens a plugin's bin/ under any case of the name, and it goes on PATH.
    if (text.startsWith("#!") || parts.some((x) => x.toLowerCase() === "bin")) {
      if (text !== SCRIPT) out.push(`${at}: a script is the run marker only`);
      continue;
    }
    const name = parts[parts.length - 1];
    const below = parts.indexOf(".claude");
    const dotClaude = below !== -1 && below < parts.length - 1;
    // What a project's .claude/ holds that runs or is listed to run (skills, agents, commands, hooks, styles,
    // plugins, workflows), and JSON other than its settings: none in a cell.
    if (dotClaude && (["skills", "agents", "commands", "hooks", "output-styles", "plugins", "workflows"].includes(parts[below + 1]) || (/\.json$/i.test(name) && !/^settings(\.local)?\.json$/.test(name)))) {
      out.push(`${at}: a .claude/ file a cell may not write`);
      continue;
    }
    if (/\.md$/i.test(path)) {
      // A skill's or command's `!` runs a command; front matter hooks run commands.
      if (text.includes("!`") || /^\s*hooks\s*:/m.test(text)) out.push(`${at}: Markdown that runs a command`);
      continue;
    }
    if (dotClaude && !/^settings(\.local)?\.json$/.test(name)) continue;
    if (name === ".mcp.json" && !inPlugin(path)) out.push(`${at}: the project's MCP servers run commands`);
    if (name === "marketplace.json") out.push(`${at}: a marketplace names sources to fetch`);
    /** @type {unknown} */
    let json;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, "").replace(BYTES, ""));
    } catch {
      // Not JSON as Ennyn reads it: Claude Code may read it more loosely, so it names nothing that runs.
      if (/hooks|helper|status|env|mcp|plugin|marketplace|command|url|director|server|args/i.test(text)) out.push(`${at}: text Ennyn cannot read as JSON naming a setting that runs or redirects`);
      continue;
    }
    out.push(...jsonProblems(json, at, dotClaude));
    if (dotClaude && isObject(json)) {
      for (const k of Object.keys(json)) if (!SETTINGS_KEYS.includes(k) && !k.startsWith("en_probe_")) out.push(`${at}: settings key ${k} is none a cell may write`);
      if (isObject(json.sandbox)) {
        for (const [k, v] of Object.entries(json.sandbox)) {
          if (!Object.hasOwn(SANDBOX_KEYS, k)) out.push(`${at}: sandbox.${k} is none a cell may write`);
          else if (isObject(v)) for (const sub of Object.keys(v)) if (!(SANDBOX_KEYS[/** @type {keyof typeof SANDBOX_KEYS} */ (k)] ?? []).includes(sub)) out.push(`${at}: sandbox.${k}.${sub} is none a cell may write`);
        }
      }
      if (isObject(json.permissions)) {
        for (const k of Object.keys(json.permissions)) if (!PERMISSION_KEYS.includes(k) && !k.startsWith("en_probe_")) out.push(`${at}: permissions.${k} is none a cell may write`);
        const dirs = json.permissions.additionalDirectories;
        if (typeof dirs === "string" || Array.isArray(dirs)) out.push(`${at}: permissions.additionalDirectories names folders outside the cell`);
      }
      if (isObject(json.env)) for (const k of Object.keys(json.env)) if (!/^EN_PROBE_[A-Z0-9_]*$/.test(k)) out.push(`${at}: env ${k} is none a cell may set`);
    }
    if (name === "plugin.json" && parts.includes(".claude-plugin") && isObject(json)) {
      for (const [k, v] of Object.entries(json)) {
        if (!MANIFEST_KEYS.includes(k)) out.push(`${at}: manifest key ${k} is none a cell may write`);
        if (["name", "version", "description"].includes(k)) continue;
        const paths = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
        for (const p of paths) if (typeof p === "string" && !(p.startsWith("./") && safe(p.slice(2).replace(/\/$/, "")))) out.push(`${at}: ${k} names ${p}, no path inside the plugin`);
      }
    }
  }
  if (total > CELL_BYTES) out.push(`${c.id}: {{bytes}} past ${CELL_BYTES} in a cell`);
  return out;
}

/** What a cell must hold; each problem as a line. @param {any} c */
export function cellProblems(c) {
  /** @type {string[]} */
  const out = [];
  if (!isObject(c)) return ["a cell is an object"];
  // A plain id: messages print it, and a control byte in it would reach the terminal.
  if (typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(c.id)) return [`id ${JSON.stringify(c.id)} is no plain id (letters, digits, -)`];
  if (typeof c.from !== "string" || !c.from) out.push(`${c.id}: no from`);
  // The recorder writes each path under a directory of its own, and a marker spells it back: plain names only.
  if (!isObject(c.files) || !Object.entries(c.files).every(([k, v]) => safe(k) && typeof v === "string")) out.push(`${c.id}: files maps relative paths of plain names to text`);
  else out.push(...fileProblems(c));
  if (c.call !== undefined && !(isObject(c.call) && Object.keys(c.call).length === 1 && ((typeof c.call.Bash === "string" && Object.hasOwn(SPELLINGS, c.call.Bash)) || safe(c.call.Read) || (typeof c.call.Read === "string" && c.call.Read.startsWith("~/") && isObject(c.home) && Object.hasOwn(c.home, c.call.Read.slice(2)))))) out.push(`${c.id}: call is { Bash: <a name of SPELLINGS> } or { Read: <relative path> }, or { Read: "~/<a file of home>" }`);
  // The cell's home holds plain text, and only at the names HOME_FILES allows: a home file is a program's configuration
  // the recorder or Claude Code may run (.gitconfig's filters, .zshrc).
  if (c.home !== undefined && !(isObject(c.home) && Object.entries(c.home).every(([k, v]) => safe(k) && HOME_FILES.some((re) => re.test(k)) && typeof v === "string" && !v.startsWith("#!") && !v.includes("{{")))) out.push(`${c.id}: home maps ${HOME_FILES.map((re) => re.source).join(", ")} to plain text`);
  if (c.env !== undefined && !(isObject(c.env) && Object.entries(c.env).every(([k, v]) => /^EN_PROBE_[A-Z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("{{")))) out.push(`${c.id}: env maps EN_PROBE_* names to text`);
  if (c.launch !== undefined && !Object.hasOwn(LAUNCH, c.launch)) out.push(`${c.id}: launch is ${Object.keys(LAUNCH).join(" or ")}, or left out (bypassPermissions)`);
  // A shell runs what the file holds. In any folder and any case: `cwd` moves the call, and a disk that folds case opens it.
  const runs = isObject(c.call) && typeof c.call.Bash === "string" && Object.hasOwn(SPELLINGS, c.call.Bash) ? SPELLINGS[c.call.Bash].runs : undefined;
  if (runs !== undefined && isObject(c.files)) for (const p of Object.keys(c.files)) if (p.split("/").some((x) => x.toLowerCase() === runs)) out.push(`${c.id}: ${p}: ${c.call.Bash} runs ${runs}: the recorder writes it, never a cell`);
  for (const k of ["cwd", "plugin"]) if (c[k] !== undefined && !(safe(c[k]) || (k === "plugin" && c[k] === "."))) out.push(`${c.id}: ${k} is a relative path of plain names`);
  for (const k of Object.keys(c)) if (!CELL_KEYS.includes(k)) out.push(`${c.id}: ${k} is no key of a cell (${CELL_KEYS.join(", ")})`);
  if (c.case !== undefined && c.case !== true) out.push(`${c.id}: case is true or left out`);
  if (c.worktree !== undefined && c.worktree !== true) out.push(`${c.id}: worktree is true or left out`);
  if (c.agent !== undefined && !(["foreground", "background"].includes(c.agent) && isObject(c.call) && "Bash" in c.call)) out.push(`${c.id}: agent is foreground or background, on a Bash call`);
  if (c.except !== undefined && (!isObject(c.except) || "*" in c.except || !Object.values(c.except).every((v) => typeof v === "string" && ["stricter", "extra", "differs", "gap", "unmeasured"].includes(v.split(":")[0])))) out.push(`${c.id}: except maps a place (each by name) to "stricter: …", "extra: … (<node>)", "unmeasured: …", "differs: …" or "gap: <node>"`);
  if (c.ennyn !== undefined && (!isObject(c.ennyn) || !Object.values(c.ennyn).every((v) => typeof v === "string"))) out.push(`${c.id}: ennyn maps a place to Ennyn's reading there`);
  return out;
}

/**
 * Every cell compared: each one's files written in a temporary directory of its own, read by Ennyn there. Nothing
 * a cell holds runs: Ennyn's readers only read. A `case` cell on a disk that folds case otherwise than the record's
 * (`caseFolds`) is said, not compared: Claude Code's reading there is not the one recorded.
 * @param {Cell[]} cells @param {boolean} [caseFolds] the record's disk
 * @returns {{ cell: Cell, got: Map<string, Comparison>, skipped?: string }[]}
 */
export function compareAll(cells, caseFolds) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "en-ref-cc-")));
  try {
    const folds = foldsCase(root);
    return cells.map((cell, i) => {
      if (cell.case && folds !== caseFolds) return { cell, got: new Map(), skipped: `recorded on a disk that ${caseFolds ? "folds" : "keeps"} case; this one ${folds ? "folds" : "keeps"} it` };
      const dir = join(root, String(i));
      mkdirSync(dir);
      writeCell(cell, dir);
      return { cell, got: compare(cell, readings(cell, dir)) };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Recording: the machine's Claude Code, run here only.

/** A key the stand-in is given: no key of Anthropic's. Claude Code asks once whether to use a key; the cell's config says yes. */
const KEY = "sk-ant-stand-in-000000000000000000000000";
/** What a cell's subagent is told: the stand-in knows its requests by it. */
const AGENT_PROMPT = "en-probe-subagent";
/** The stand-in's Agent call: what the run names as the parent of each thing the subagent does. */
const AGENT_CALL = "toolu_stand_in_agent";

/**
 * The stand-in for the model: the first request that offers the call's tool gets that call; every other one, text.
 * With `agent`, the first request that offers Agent starts a subagent with AGENT_PROMPT, and the call waits for a
 * request whose first message holds that prompt: the subagent's. The main thread's history holds it too, in the Agent
 * call, and in the background the main thread's next request can come first.
 * @param {{ name: string, input: object } | null} call @param {"foreground" | "background"} [agent]
 * @returns {Promise<{ port: number, bodies: any[], close: () => void }>}
 */
function standIn(call, agent) {
  /** @type {any[]} */
  const bodies = [];
  let called = false;
  let started = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      /** @type {any} */
      let json = {};
      try {
        json = JSON.parse(body);
      } catch {}
      bodies.push(json);
      /** @param {[string, object][]} events */
      const sse = (events) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        res.end();
      };
      const usage = { input_tokens: 1, output_tokens: 1 };
      /** @type {[string, object]} */
      const start = ["message_start", { message: { id: "msg_stand_in", type: "message", role: "assistant", model: json.model ?? "stand-in", content: [], stop_reason: null, stop_sequence: null, usage } }];
      const offers = (/** @type {string} */ name) => (json.tools ?? []).some((/** @type {any} */ t) => t.name === name);
      /** @param {string} id @param {string} name @param {object} input */
      const use = (id, name, input) => sse([start, ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }], ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage }], ["message_stop", {}]]);
      if (agent && !started && offers("Agent")) {
        started = true;
        return use(AGENT_CALL, "Agent", { description: "stand-in", prompt: AGENT_PROMPT, subagent_type: "general-purpose", run_in_background: agent === "background" });
      }
      if (call && !called && offers(call.name) && (!agent || JSON.stringify(json.messages?.[0]?.content ?? "").includes(AGENT_PROMPT))) {
        called = true;
        return use("toolu_stand_in", call.name, call.input);
      }
      sse([start, ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }], ["message_stop", {}]]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, bodies, close: () => server.close() });
    });
  });
}

/** The markers in a request, in order. @param {any} body */
const marks = (body) => [...new Set([...JSON.stringify(body).matchAll(MARK)].map((m) => m[1]))];

/**
 * git's environment for a cell's own repository, from nothing but PATH: no GIT_* of the parent (a GIT_DIR would
 * commit into another repository), no agent socket or secret, the cell's home, no system or global config (a
 * `.gitconfig` in that home names filters that run on `git add`); with the options that run no hook and no file-system
 * monitor.
 * @param {string} root the cell's directory
 */
export function gitEnv(root) {
  return {
    env: { PATH: safePath(), HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TEMPLATE_DIR: join(root, "hooks"), GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" },
    args: ["-c", `core.hooksPath=${join(root, "hooks")}`, "-c", "core.fsmonitor=false"],
  };
}

/** Every process of a group, gone: what a run left behind (an MCP server, a hook) dies with it. @param {number | undefined} pid */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/**
 * Claude Code's reading of one cell, in a directory of its own, removed after.
 * @param {Cell} c @param {string} bin @returns {Promise<CcReading>}
 */
export async function ccReading(c, bin) {
  const problems = cellProblems(c);
  if (problems.length) throw new Error(problems.join("; "));
  // Short: the runtime directory holds a socket whose path has a length limit.
  const R = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-cc-")));
  try {
    const P = join(R, "p");
    for (const d of ["p", "cfg", "home", "run", "tmp", "hooks", "bin"]) mkdirSync(join(R, d));
    writeCell(c, P);
    for (const [path, text] of Object.entries(c.home ?? {})) {
      mkdirSync(dirname(join(R, "home", path)), { recursive: true });
      writeFileSync(join(R, "home", path), text, { mode: 0o644 });
    }
    // Each says it ran, in the cell's list: the reading shows that the stand-in ran and the real program did not.
    for (const name of STUBBED) writeFileSync(join(R, "bin", name), `#!/bin/sh\necho ${name} >> ${P}/.ran\n`, { mode: 0o755 });
    const { env: git, args: quiet } = gitEnv(R);
    execFileSync("git", [...quiet, "init", "-q"], { cwd: P, env: git });
    execFileSync("git", [...quiet, "add", "-A"], { cwd: P, env: git });
    execFileSync("git", [...quiet, "commit", "-qm", "cell", "--allow-empty", "--no-verify"], { cwd: P, env: git });
    if (c.worktree) execFileSync("git", [...quiet, "worktree", "add", "-q", "-b", "en-task", join(R, "w")], { cwd: P, env: git });
    writeFileSync(join(R, "cfg", ".claude.json"), JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, hasCompletedOnboarding: true }));
    const spelling = c.call && "Bash" in c.call ? SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (c.call.Bash)] : undefined;
    const call = !c.call ? null : spelling ? { name: "Bash", input: { command: spelling.command, description: "stand-in" } } : { name: "Read", input: { file_path: readPath(/** @type {{ Read: string }} */ (c.call).Read, P, join(R, "home")) } };
    const server = await standIn(call, c.agent);
    const env = {
      PATH: `${join(R, "bin")}${delimiter}${safePath()}`,
      HOME: join(R, "home"),
      TMPDIR: join(R, "tmp"),
      CLAUDE_CODE_TMPDIR: join(R, "tmp"),
      CLAUDE_CONFIG_DIR: join(R, "cfg"),
      XDG_RUNTIME_DIR: join(R, "run"),
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GH_HOST: "en-probe.invalid",
      ...(c.env ?? {}),
    };
    const args = ["-p", ...(c.launch ? LAUNCH[c.launch] : ["--permission-mode", "bypassPermissions"]), "--output-format", "stream-json", "--verbose", ...(c.plugin ? ["--plugin-dir", join(P, c.plugin)] : []), "stand-in"];
    /** @type {{ out: string, code: number | null, timedOut: boolean }} */
    const run = await new Promise((resolve) => {
      // Its own process group, killed whole when the run ends or runs out of time.
      const child = spawn(bin, args, { cwd: join(P, c.cwd ?? ""), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => ((timedOut = true), killGroup(child.pid)), 90_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", () => {});
      child.on("close", (code) => (clearTimeout(timer), killGroup(child.pid), resolve({ out, code, timedOut })));
    });
    server.close();
    const events = run.out.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const main = server.bodies.filter((b) => Array.isArray(b.tools) && b.tools.length);
    /** @type {CcReading} */
    const reading = { start: main.length ? marks(main[0]).sort() : [] };
    if (call) {
      // The run's result lists the calls it stopped (2.1.310 also sends a permission_denied event, 2.1.207 does not);
      // the tool result's text says whether a deny rule or an ask stopped it.
      const denied = (events.find((e) => e.type === "result")?.permission_denials ?? []).some((/** @type {any} */ d) => d.tool_use_id === "toolu_stand_in");
      const isResult = (/** @type {any} */ x) => x.type === "tool_result" && x.tool_use_id === "toolu_stand_in";
      const turn = events.find((e) => e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some(isResult));
      const result = turn?.message.content.find(isResult);
      const text = JSON.stringify(result?.content ?? "");
      const how = /has been denied/.test(text) ? "deny" : /requested permissions/.test(text) ? "ask" : "other";
      // What of the cell's home and environment came back to the model, by the file's path or the variable's name.
      if (c.home || c.env) reading.seen = [...Object.entries(c.home ?? {}).filter(([, v]) => v.trim() && text.includes(v.trim())).map(([k]) => `home:${k}`), ...Object.entries(c.env ?? {}).filter(([, v]) => v && text.includes(v)).map(([k]) => `env:${k}`)].sort();
      reading.call = run.timedOut ? "unmeasured: the run did not end" : denied ? `stopped: ${how}` : result ? "ran" : `unmeasured: no call (${main.length} request(s), exit ${run.code})`;
      // A call in a cell with `agent` counts only as the run says whose it was.
      if (c.agent) {
        if (turn?.parent_tool_use_id === AGENT_CALL) reading.by = "subagent";
        else reading.call = `unmeasured: not the subagent's call (${reading.call})`;
      }
      if (main.length > 1) {
        const first = new Set(reading.start);
        reading.after = marks(main[main.length - 1]).filter((m) => !first.has(m)).sort();
      }
    } else if (!main.length) reading.call = `unmeasured: no request (exit ${run.code})`;
    const ran = existsSync(join(P, ".ran")) ? [...new Set(readFileSync(join(P, ".ran"), "utf8").split("\n").filter(Boolean))].sort() : [];
    if (ran.length) reading.ran = ran;
    return reading;
  } finally {
    rmSync(R, { recursive: true, force: true });
  }
}

/**
 * Every cell read by the binary, one at a time, on this machine's disk. A `case` cell whose reading was taken on a
 * disk that folds case otherwise (`caseFolds` of the record) keeps that reading: this disk cannot take it.
 * @param {Cell[]} cells @param {string} bin @param {boolean} [caseFolds] the record's disk, when it has cells
 */
export async function readAll(cells, bin, caseFolds) {
  const claudeCode = versionOf(bin);
  const scratch = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "en-cc-")));
  const folds = foldsCase(scratch);
  rmSync(scratch, { recursive: true, force: true });
  /** @type {Cell[]} */
  const out = [];
  let kept = 0;
  for (const c of cells) {
    if (c.case && caseFolds !== undefined && folds !== caseFolds && c.cc) {
      out.push(c);
      kept++;
    } else out.push({ ...c, cc: await ccReading(c, bin) });
  }
  return { claudeCode, caseFolds: caseFolds ?? folds, folds, kept, cells: out };
}

/** What to do when the binary is another version than the record's. @param {string} recorded @param {string} bin @param {string} version */
export const otherVersion = (recorded, bin, version) =>
  `the record is Claude Code ${recorded}, ${bin} is ${version}: point at a ${recorded} binary (npm run test:reference -- --claude <path>, or node test/reference/claude-code.mjs check --claude <path>), or take the record again with this one (node test/reference/claude-code.mjs record --claude <path>) and run test/reference.test.mjs to see what moved\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--claude");
  const [cmd, ...args] = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  /** The binary, said where it was found. */
  const claude = () => {
    const found = claudeBinary(at === -1 ? "claude" : argv[at + 1]);
    if (!found) {
      process.stderr.write("no claude binary found (node_modules/.bin folders on PATH are skipped): point at one with --claude <path>\n");
      process.exit(1);
    }
    process.stdout.write(`claude: ${found.path}${found.file === found.path ? "" : ` (${found.file})`}\n`);
    return found;
  };
  /** @type {Record} */
  const rec = existsSync(RECORD) ? readRecord() : { claudeCode: "", caseFolds: false, cells: [] };
  if (cmd === "add" && args[0]) {
    const probes = JSON.parse(readFileSync(args[0], "utf8"));
    const ids = new Set(rec.cells.map((c) => c.id));
    const problems = (Array.isArray(probes) ? probes : [null]).flatMap((p) => [...cellProblems(p), ...(p && ids.has(p.id) ? [`${p.id}: recorded already`] : []), ...(p && "cc" in p ? [`${p.id}: Claude Code's reading is recorded, never given`] : [])]);
    if (problems.length) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exit(1);
    }
    const bin = claude().path;
    const version = versionOf(bin);
    if (rec.cells.length && version !== rec.claudeCode) {
      process.stderr.write(otherVersion(rec.claudeCode, bin, version));
      process.exit(1);
    }
    const { claudeCode, caseFolds, folds, cells } = await readAll(probes, bin, rec.cells.length ? rec.caseFolds : undefined);
    if (rec.cells.length && folds !== rec.caseFolds && cells.some((c) => c.case)) {
      process.stderr.write(`the record was taken on a disk that ${rec.caseFolds ? "folds" : "keeps"} case, this one ${folds ? "folds" : "keeps"} it: a case cell is added where the record was taken\n`);
      process.exit(1);
    }
    writeFileSync(RECORD, recordText({ claudeCode, caseFolds, cells: [...rec.cells, ...cells] }));
    for (const c of cells) process.stdout.write(`added ${c.id}: ${JSON.stringify(c.cc)}\n`);
  } else if (cmd === "show") {
    for (const { cell, got, skipped } of compareAll(rec.cells.filter((x) => !args.length || args.includes(x.id)), rec.caseFolds)) {
      process.stdout.write(`${cell.id} ${JSON.stringify(cell.cc)}${skipped ? `  (not compared: ${skipped})` : ""}\n`);
      for (const [k, r] of got) process.stdout.write(`  ${r.relation.padEnd(10)} ${k}  Ennyn: ${r.ennyn}  Claude Code: ${r.cc}${cell.except?.[k] ? `  [${cell.except[k]}]` : ""}\n`);
    }
  } else if (cmd === "check" || cmd === "record") {
    const problems = rec.cells.flatMap(cellProblems);
    if (problems.length) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exit(1);
    }
    const found = claude();
    const bin = found.path;
    const version = versionOf(bin);
    if (cmd === "check" && version !== rec.claudeCode) {
      process.stdout.write(otherVersion(rec.claudeCode, bin, version));
      process.exit(1);
    }
    const { claudeCode, caseFolds, kept, cells } = await readAll(rec.cells, bin, rec.caseFolds);
    const moved = cells.filter((c, i) => JSON.stringify(c.cc) !== JSON.stringify(rec.cells[i].cc));
    if (kept) process.stdout.write(`${kept} case cell(s) not read: this disk folds case otherwise than the record's\n`);
    if (cmd === "record") {
      writeFileSync(RECORD, recordText({ claudeCode, caseFolds, cells }));
      process.stdout.write(`recorded ${cells.length} cell(s) with Claude Code ${claudeCode}; ${moved.length} reading(s) moved: ${moved.map((c) => c.id).join(", ") || "none"}\n`);
    } else {
      for (const c of moved) process.stdout.write(`${c.id}: Claude Code now reads ${JSON.stringify(c.cc)}\n  recorded ${JSON.stringify(rec.cells.find((x) => x.id === c.id)?.cc)}\n`);
      const unmeasured = cells.filter((c) => c.cc?.call?.startsWith("unmeasured")).length;
      process.stdout.write(moved.length ? "take the record again (node test/reference/claude-code.mjs record), then run test/reference.test.mjs: it shows the comparisons that moved\n" : `Claude Code ${claudeCode} reads all ${cells.length} cell(s) as recorded\n`);
      if (unmeasured) process.stdout.write(`${unmeasured} cell(s) where Claude Code was not measured\n`);
      // The steps around its Markdown parser that test/reference/markdown.json models, found in the same binary.
      const md = await import("./markdown.mjs");
      const steps = md.stepsMoved(found.file, version, md.readRecord().claudeCode);
      process.stdout.write(steps.length ? `${steps.join("\n")}\nClaude Code reads Markdown otherwise than test/reference/markdown.json models: compare its steps with mdReading and walk in test/reference/markdown.mjs, then node test/reference/markdown.mjs steps --record\n` : `Claude Code ${version}'s Markdown steps are the Markdown record's\n`);
      process.exitCode = moved.length || unmeasured || steps.length ? 1 : 0;
    }
  } else {
    process.stderr.write("usage: node test/reference/claude-code.mjs add <probes.json> | show [id…] | check | record [--claude <bin>]\n");
    process.exit(2);
  }
}
