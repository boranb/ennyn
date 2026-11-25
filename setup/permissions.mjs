/**
 * The commands that leave the machine, and which of the project's Claude Code settings files holds an ask or
 * deny rule for each. The cycle asks the user before any push; such a rule is the harness's backstop, not the
 * gate: it prompts in every permission mode, bypassPermissions included, over any allow rule and a PreToolUse
 * hook's allow, unless a PermissionRequest hook answers it; a project's .claude/settings.json applies it without
 * the workspace trust step (code.claude.com/docs/en/permissions).
 *
 * This says what Ennyn read, not what Claude Code will do. Claude Code applies the file only in a session
 * started at the repository's top, skips it whole when any setting in it is one it rejects (Ennyn does not
 * mirror that schema), and matches a rule against the command as it reads it: a push written another way
 * (a git option before push, `sh -c`, `eval`, an alias, a script that pushes, `gh api` with no method or one
 * written otherwise, an MCP tool) is not matched. And it reads a compound command only if Claude Code's parser finishes:
 * when the parser gives up, on length, nodes, a deadline, a stack, a budget spent over the text or a here-document case,
 * a command later in the text runs unasked in bypassPermissions, under every ask rule, and a comment holding an apostrophe
 * after a redirect does the same. The reports say these limits instead of claiming the push is
 * asked about; what Claude Code did with each spelling is recorded in test/reference/claude-code.json and
 * test/reference/pretooluse.json. In a plugin session the PreToolUse hook (adapters/claude-code/hooks/push-spellings.mjs)
 * refuses every push but a plain `git push` at the head of a top-level command, in a text of plain words and list separators:
 * those spellings and an alias set in the command or the session's environment among them. Left are an alias in a config
 * file, a script that pushes, an interpreter, `gh api` and an MCP tool; the hook is no boundary, and with no plugin there
 * is none.
 *
 * What destroys local work or data and what installs outside the project is OFFERED apart, never proposed as a
 * default: a rule reads command text and cannot tell a task's worktree from the main checkout, so one on these
 * commands stops an unattended cycle. The record holds that too (ask-worktree-*).
 *
 * Only the project's own files are read, through the scan's projectFiles rule; user and managed settings are
 * not the repository's. A read that fails throws, as the scan's reads do; doctor names it.
 */

/** The project's settings files, shared first: committed, it reaches every clone. */
export const SETTINGS = /** @type {const} */ ([".claude/settings.json", ".claude/settings.local.json"]);
/** The shell tools a rule names; a push through PowerShell is checked against PowerShell rules only. */
export const TOOLS = /** @type {const} */ (["Bash", "PowerShell"]);
/** Claude Code skips a settings file larger than this. */
export const SETTINGS_LIMIT = 2 * 1024 * 1024;

/** How many rules a report line names before it counts the rest. */
const NAMED = 8;
/** A list a report line can hold: at most NAMED names, then `+<the rest>`. @param {readonly string[]} list */
export const capped = (list) => (list.length > NAMED ? [...list.slice(0, NAMED), `+${list.length - NAMED}`] : [...list]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Commands a rule matches as the whole of a command: the shell at the end of a pipe, not `sh -c` or a script. */
const WHOLE = ["sh", "bash"];

/**
 * The rule proposed for a command: `Tool(<command> *)`, a prefix. A command that ends in `*` holds its wildcard
 * already and one in WHOLE takes none: each is the rule's text as it stands.
 * @param {string} command @param {string} tool
 */
export const ruleFor = (command, tool) => `${tool}(${command.endsWith("*") || WHOLE.includes(command) ? command : `${command} *`})`;

/** The permission modes Claude Code 2.1.310 and 2.1.319 take (their settings schema; `manual` is `default`). */
const MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan", "manual"];
/** @param {unknown} v */
const flag = (v) => v === undefined || typeof v === "boolean";
/** @param {unknown} v */
const names = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
/** A credentials list: each entry an object naming its file or variable, with mode deny or mask. @param {unknown} v @param {string} field */
const credentials = (v, field) => v === undefined || (Array.isArray(v) && v.every((e) => isObject(e) && typeof e[field] === "string" && (e.mode === "deny" || e.mode === "mask")));
/** @param {unknown} v @param {(o: Record<string, any>) => boolean} inner */
const part = (v, inner) => v === undefined || (isObject(v) && inner(v));

/**
 * The keys the secret setup reads (setup/secret-setup.mjs), each with the kinds of value Claude Code keeps the file
 * with: an absent key, and the kinds measured kept on 2.1.310 and 2.1.319 (test/reference/claude-code.json, the
 * settings-bypass-*, settings-sandbox-*, settings-credentials-* and settings-no-bypass-* cells; the modes from their
 * schema). Any other value of these keys may make Claude Code skip the whole file, its ask rules with it: measured
 * for a boolean, null and another string on the bypass key, a string, a number and null on the sandbox flags, a
 * string for allowWrite, an entry with no mode or a number for one, a mode typed wrong. So the file is not counted.
 * Claude Code skips a file for a wrong value of any of its keys; the other keys are not checked here.
 * @type {readonly { key: string, kept: (json: Record<string, any>) => boolean }[]}
 */
export const KEPT = [
  { key: "permissions.disableBypassPermissionsMode", kept: (j) => !isObject(j.permissions) || [undefined, "disable"].includes(j.permissions.disableBypassPermissionsMode) },
  { key: "permissions.defaultMode", kept: (j) => !isObject(j.permissions) || j.permissions.defaultMode === undefined || MODES.includes(j.permissions.defaultMode) },
  {
    key: "sandbox",
    kept: (j) =>
      part(j.sandbox, (sb) =>
        flag(sb.enabled) && flag(sb.failIfUnavailable) && flag(sb.autoAllowBashIfSandboxed) &&
        part(sb.filesystem, (fs) => names(fs.allowWrite)) &&
        part(sb.network, (n) => names(n.allowedDomains)) &&
        part(sb.credentials, (c) => credentials(c.files, "path") && credentials(c.envVars, "name"))),
  },
];

/**
 * A settings file's text as Ennyn reads it: the one predicate the hooks reader (init-scan), the ask rules and the
 * secret setup share, so they agree on which files count. `{ json }`, or `{ unread }` naming what gives nothing: no
 * JSON object (a byte order mark is skipped, as Claude Code skips it), `permissions`, `permissions.ask` or
 * `permissions.deny` in a shape Claude Code rejects, each of which makes it skip the whole file, or a value of a key
 * KEPT names that is not a kind it keeps, which may (`<path> <key>`). A `hooks` value that is no object Claude Code
 * drops before its check ("This field was ignored") and keeps the
 * file: it is left out of `json` and named in `dropped`. Other keys are not checked: the reports say a file with any
 * setting Claude Code rejects is skipped whole.
 * @param {string} text @param {string} path
 * @returns {{ json: Record<string, any>, dropped?: string[] } | { unread: string }}
 */
export function parseSettings(text, path) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { unread: path };
  }
  if (!isObject(parsed)) return { unread: path };
  const { hooks, ...rest } = parsed;
  const json = hooks === undefined || isObject(hooks) ? parsed : rest;
  const dropped = json === rest ? { dropped: [`${path} hooks`] } : {};
  const odd = KEPT.find((k) => !k.kept(json));
  if (odd) return { unread: `${path} ${odd.key}` };
  const perms = json.permissions;
  if (perms === undefined) return { json, ...dropped };
  if (!isObject(perms)) return { unread: `${path} permissions` };
  const bad = ["ask", "deny"].find((k) => perms[k] !== undefined && !Array.isArray(perms[k]));
  return bad ? { unread: `${path} permissions.${bad}` } : { json, ...dropped };
}

/**
 * A project settings file read through projectFiles: null when it is not there, undefined when it leads out
 * of the repository (projectFiles names it), else parseSettings's answer; a file over 2 MB is `unread`.
 * @param {{ read: (rel: string, opts?: { limit?: number }) => string | null | undefined }} pf
 * @param {string} path
 */
export function readSettings(pf, path) {
  /** @type {string | null | undefined} */
  let text;
  try {
    text = pf.read(path, { limit: SETTINGS_LIMIT });
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "EFBIG") return { unread: `${path} (over 2 MB)` };
    throw e;
  }
  return text === null || text === undefined ? text : parseSettings(text, path);
}

/**
 * Whether a permission rule, in `ask` or `deny`, matches every command `tool` runs that starts with `command`
 * ("git push" and "git push origin main"). Only a content rule whose one wildcard is the trailing `*` or `:*`
 * counts (`Bash(git push *)`, `Bash(git push:*)`, `Bash(git *)`, `PowerShell(git push *)`), or the rule ruleFor
 * writes for the command. A tool-wide rule (`Bash`, `Bash(*)`) does not: with the sandbox on, Claude Code
 * auto-allows a sandboxed command past it. Any other form is not counted either: a missed rule is a warning,
 * never a push read as asked about.
 *
 * A command that ends in `*` (`gh api *-X POST*`) is a pattern: a prefix of it that ends in `*` or ` *` covers it.
 * Anything else is not counted: ` *` after the whole pattern, which a rule with another `*` in it does not match at
 * the end of a command, and `:*` after another `*`, whose colon Claude Code reads as text: such a rule stops nothing.
 * @param {unknown} rule @param {string} command @param {string} [tool]
 */
export function ruleCovers(rule, command, tool = "Bash") {
  if (typeof rule !== "string" || !rule.startsWith(`${tool}(`) || !rule.endsWith(")")) return false;
  if (rule === ruleFor(command, tool)) return true;
  const body = rule.slice(tool.length + 1, -1);
  if (body.endsWith(":*") && body.slice(0, -2).includes("*")) return false;
  // `:*` is the trailing ` *` written the older way; a `*` without a space before it continues the word.
  const prefix = body.endsWith(":*") ? `${body.slice(0, -2)} ` : body.endsWith("*") ? body.slice(0, -1) : "";
  // Compared as text: a `*` left in the prefix (`Bash(git * push *)`) matches no command, so it is not counted.
  // A trailing ` *` also matches the bare command.
  return prefix !== "" && (command.endsWith("*") ? command : `${command} `).startsWith(prefix);
}

/**
 * `gh api` with a method that writes, wherever it stands: the real spelling puts it after the path, last or not,
 * and only this form stops all of them (`gh api repos/x -X POST` runs under `Bash(gh api * -X POST *)`, recorded).
 * gh sends more than these match. With no method `-f`, `-F` and `--input` post, and a rule wide enough for them stops
 * `-f` with `-X GET`, which is how an agent searches. A method written glued (`-XPOST`, `-iX POST`), with `=`, in lower
 * case or quoted runs too, and that is a decision: a rule that holds the spelling stops it (`Bash(gh api *-X "POST"*)`
 * stops `-X "POST"`, recorded), but there is one more rule for each spelling and each method, and `"-X" POST` still runs
 * under that one. They wait for a hook that reads the command (`gh-api-write-hook`). The form reads text, so a read whose
 * text holds `-X POST` stops as well.
 */
const GH_API_WRITES = ["-X", "--method"].flatMap((flag) => ["POST", "PATCH", "PUT", "DELETE"].map((method) => `gh api *${flag} ${method}*`));

/** The gh commands asked about when ghApplies holds. */
export const GH_COMMANDS = ["gh pr merge", "gh repo sync", "gh release", "gh repo create", "gh repo edit", "gh repo delete", "gh repo rename", "gh repo archive", "gh gist create", ...GH_API_WRITES];

/**
 * Whether the gh commands are asked about: with a remote on a GitHub host, or with no remote at all, since
 * `gh repo create x --source . --push` runs before there is one. A project whose remotes are all elsewhere is left
 * out, and init-scan says what that leaves.
 * @param {{ github: readonly string[], others: readonly string[] }} remotes
 */
export const ghApplies = ({ github, others }) => github.length > 0 || others.length === 0;

/**
 * The rules offered apart from the outward ones, each list a choice: `destroys` local work or data, `installs`
 * outside the project. Their spellings are measured as the outward ones are: `git reset --hard *` misses
 * `git reset HEAD --hard` and `git checkout -- *` misses `git checkout HEAD -- f`; npx is no wrapper a rule looks
 * through; `pip install` also asks inside a virtualenv, which a rule cannot see. The project's own reset and drop
 * scripts are the user's to name.
 */
export const OFFERED = /** @type {const} */ ({
  destroys: ["git clean", "git reset *--hard*", "git checkout *-- *", "git checkout .", "git restore", "git branch -D", "git branch -d -f", "git worktree remove", "git stash drop", "git stash clear", "docker system prune", "docker volume prune", "docker network prune", "docker image prune", "docker volume rm", "docker compose down *-v*", "docker-compose down *-v*", "dropdb", "terraform destroy", "prisma migrate reset", "npx prisma migrate reset", "prisma db push --force-reset", "npx prisma db push --force-reset"],
  installs: ["npm install -g", "npm install * -g*", "npm install *--global*", "npm i -g", "pnpm add -g", "pnpm add * -g*", "pnpm add *--global*", "pip install", "pip3 install", "brew install", "cargo install", "go install", ...WHOLE, "sh -s*", "bash -s*"],
});

/**
 * The commands Ennyn asks a rule for: `git push` unless `push.mode` is `after-closing`, where the cycle pushes by
 * itself and a rule would stop it; `npm publish` when the repository holds a
 * package.json anywhere (a private root still publishes its workspaces), git could not list its files, or the
 * work tree has one git does not list (an unborn repository, or none); when `gh` holds (ghApplies), GH_COMMANDS
 * (`gh release`: create, upload, edit). OFFERED is no part of this: what a project declines is no warning.
 * @param {string[] | null} files tracked files; null when git could not list them
 * @param {boolean} gh
 * @param {(rel: string) => boolean} [present] whether the work tree holds a file
 * @param {string} [pushMode] the config's `push.mode`
 */
export function outwardCommands(files, gh, present = () => false, pushMode = "ask") {
  const pkg = files === null || files.some((f) => /(^|\/)package\.json$/.test(f)) || present("package.json");
  return [...(pushMode === "after-closing" ? [] : ["git push"]), ...(pkg ? ["npm publish"] : []), ...(gh ? GH_COMMANDS : [])];
}

/**
 * The host a remote URL names, lowercased, and the path after it: `scheme://[user@]host[:port]/path` (the path from
 * its slash, up to a query or fragment) or scp-like `[user@]host:path`; null for a local path. The one reading of a
 * remote URL: the GitHub host (isGithubHost) and the repository init-scan names (githubName) both come from it.
 * @param {string} url
 * @returns {{ host: string, path: string } | null}
 */
export function urlParts(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]*)[^/?#]*([^?#]*)/i.exec(url) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)/s.exec(url);
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}

/**
 * The host a remote URL names, lowercased (urlParts); null for a local path.
 * @param {string} url
 */
export function urlHost(url) {
  return urlParts(url)?.host ?? null;
}

/**
 * Whether a host serves GitHub: github.com, ssh.github.com (SSH over 443), GitHub Enterprise Cloud with data
 * residency on a subdomain of ghe.com (docs.github.com), or GitHub Enterprise Server on a host named github.<domain>.
 * @param {unknown} host
 */
export function isGithubHost(host) {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase();
  return h === "github.com" || h === "ssh.github.com" || GHE_COM.test(h) || /^github(\.[a-z0-9-]+)+$/.test(h);
}

/** A GitHub Enterprise Cloud host with data residency: a subdomain of ghe.com. */
const GHE_COM = /^([a-z0-9-]+\.)+ghe\.com$/;

/**
 * The hosts a GitHub remote's commands reach: its own host, for git, and the host of the API gh sends to, measured
 * with gh 2.92.0 from a repository's remote (GH_DEBUG=api): api.github.com for github.com and ssh.github.com,
 * api.<host> on ghe.com, and the remote's own host (`/api/graphql`, `/api/v3`) on a server named github.<domain>.
 * None for a host that is not GitHub's. A host spelled github.com-<name> is an SSH alias of github.com (the usual
 * second-account setup: `Host github.com-work`, `HostName github.com`; no DNS name ends in a label like com-work): it
 * gives github.com's hosts and not its own name, which nothing connects to. Other aliases are not resolved: gh
 * resolves them with `ssh -G`, but OpenSSH 10.5 reads the account's ~/.ssh/config whatever HOME says and runs its
 * `Match exec` commands (both measured), so a scan would run the user's commands, and a test could not keep the read
 * in its own folder.
 * @param {unknown} host
 * @returns {string[]}
 */
export function githubHosts(host) {
  if (typeof host !== "string" || !isGithubHost(host)) return [];
  const h = host.toLowerCase();
  if (h === "github.com" || h === "ssh.github.com") return [h, "api.github.com"];
  if (/^github\.com-[a-z0-9-]+$/.test(h)) return ["github.com", "api.github.com"];
  return GHE_COM.test(h) ? [h, `api.${h}`] : [h];
}

/**
 * Where a rule for each command and tool is: `shared` (.claude/settings.json, and the same file as HEAD holds
 * it: every clone has it), `uncommitted` (.claude/settings.json only as the work tree holds it: untracked,
 * ignored or changed), `local` (.claude/settings.local.json only: this machine), `unknown` (a read that failed,
 * or a HEAD that could not be read or holds no regular file there: not judged), or null. A file that gives
 * nothing (readSettings) or leads out of the repository is named in `unread` and gives no rule. An entry that
 * is no string is skipped, as Claude Code skips a malformed rule and keeps the rest.
 * @param {{ read: (rel: string, opts?: { limit?: number }) => string | null | undefined }} pf
 * @param {string[]} commands
 * @param {{ committed?: (path: string) => { text: string } | { kind: string } | null | undefined, failed?: Set<string> }} [opts]
 *   `committed`: a file as HEAD holds it (core/git.mjs headFile), undefined when it could not be read (the caller
 *   says why); `failed`: the files whose read failed (pf.read gave undefined for them, so they are also in
 *   `unread`; the caller says their error instead)
 * @returns {{ rules: { command: string, tool: string, rule: string, where: "shared" | "uncommitted" | "local" | "unknown" | null }[], unread: string[], head: string | null }}
 */
export function askRules(pf, commands, { committed = () => null, failed = new Set() } = {}) {
  /** @type {string[]} */
  const unread = [];
  const rulesOf = (/** @type {ReturnType<typeof parseSettings> | null | undefined} */ read) =>
    read && "json" in read ? [...(read.json.permissions?.ask ?? []), ...(read.json.permissions?.deny ?? [])] : [];
  const [shared, local] = SETTINGS.map((path) => {
    const read = readSettings(pf, path);
    if (read === undefined) unread.push(path);
    else if (read && "unread" in read) unread.push(read.unread);
    return rulesOf(read);
  });
  /** @type {string | null} */
  let head = null;
  /** @type {unknown[] | null | undefined} HEAD's rules; null: not judged; undefined: not read yet */
  let headRules;
  // HEAD is read only when the work tree's file holds a rule: whether it is committed is asked of nothing else.
  const committedHas = (/** @type {(list: unknown[]) => boolean} */ has) => {
    if (headRules === undefined) {
      const at = committed(SETTINGS[0]);
      if (at === undefined) headRules = null;
      else if (at === null) headRules = [];
      else if ("kind" in at) [head, headRules] = [at.kind, null];
      else headRules = rulesOf(parseSettings(at.text, SETTINGS[0]));
    }
    return headRules === null ? null : has(headRules);
  };
  return {
    rules: commands.flatMap((command) =>
      TOOLS.map((tool) => {
        const has = (/** @type {unknown[]} */ list) => list.some((r) => ruleCovers(r, command, tool));
        const atHead = has(shared) ? committedHas(has) : false;
        /** @type {"shared" | "uncommitted" | "local" | "unknown" | null} */
        const where = has(shared)
          ? atHead === null ? "unknown" : atHead ? "shared" : "uncommitted"
          : failed.has(SETTINGS[0]) ? "unknown" : has(local) ? "local" : failed.has(SETTINGS[1]) ? "unknown" : null;
        return { command, tool, rule: ruleFor(command, tool), where };
      }),
    ),
    unread,
    head,
  };
}
