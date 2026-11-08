/**
 * The agent's secret setup, as the settings files and the environment hold it: the mode Claude Code runs in (the
 * no-bypass mode /ennyn:init offers, or the agent as it is), the sandbox and its `credentials`, the Read deny rules for
 * `.env*`, `~/.ssh` and `~/.aws`, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, the Claude Code config folder inside a git work
 * tree (transcripts are plaintext there), and literal secrets in `.mcp.json`. init-scan and doctor report it; init
 * writes the no-bypass block only on the user's yes (skills/init/agent-mode.md).
 *
 * It says what the files hold, not what Claude Code will do: managed settings and command-line flags are not read.
 * The values that keep a file and those that make Claude Code skip it whole were measured on Claude Code 2.1.310 and
 * 2.1.319 (permissions.mjs KEPT holds the first; any other value of those keys may make it skip the file); the block
 * is written with kept values only. A reading of the files, not proof: Claude Code skips a file whole for a wrong value
 * of any of its keys, and Ennyn checks only the keys it reads; a session started in a subdirectory reads that
 * directory's .claude/.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readIfThere } from "../core/files.mjs";
import { gitRun, repoPath } from "../core/git.mjs";
import { textSecrets } from "../checks/secrets.mjs";
import { KEPT, parseSettings, SETTINGS, SETTINGS_LIMIT } from "./permissions.mjs";

/** Each Read deny rule proposed, with the spellings counted as it; any other spelling is a rule missing (a warning). */
export const READ_DENY = /** @type {const} */ ([
  { rule: "Read(.env*)", same: ["Read(**/.env*)"] },
  { rule: "Read(~/.ssh/**)", same: [] },
  { rule: "Read(~/.aws/**)", same: [] },
]);
/** Credential folders a sandboxed command reads unless they are denied. */
export const CREDENTIAL_FILES = /** @type {const} */ (["~/.ssh", "~/.aws"]);
/** Variables proposed for a `deny` entry when the environment sets them: Claude Code has no built-in list. */
export const CREDENTIAL_VARS = /** @type {const} */ (["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
export const SCRUB = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";

/**
 * Whether Claude Code reads the scrub variable as set: 1, true, yes or on, any case, trimmed (2.1.310 and 2.1.319).
 * In the process environment it also forces the permission mode to `default` at start, over bypassPermissions,
 * --dangerously-skip-permissions and `permissions.defaultMode` (measured on 2.1.310; the same code is in 2.1.319).
 * Set only in a project file's `env` it did not change the mode (2.1.310); whether it scrubs from there is not measured.
 * @param {unknown} v
 */
export const scrubOn = (v) => typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v @returns {any[]} */
const list = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} e */
const firstLine = (e) => String(/** @type {Error} */ (e)?.message ?? e).split("\n")[0];

/**
 * The Claude Code config folder: CLAUDE_CONFIG_DIR, else `.claude` in the home folder.
 * @param {NodeJS.ProcessEnv} env
 */
export const configDir = (env) => env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");

/**
 * The block the no-bypass mode writes, exact: every value one Claude Code keeps the file with (measured). `credentials`
 * holds `deny` entries only: a project file's `mask` entries are not honored (Claude Code docs, sandboxing).
 * `worktrees` is the folder the user names for the cycle's worktrees; init-scan gives null, and init asks for it: no
 * setting or file of the cycle names that folder (proposed node `worktrees-folder-key`).
 * @param {{ worktrees: string | null, hosts: readonly string[], vars: readonly string[] }} facts
 */
export function noBypassBlock({ worktrees, hosts, vars }) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: worktrees === null ? [] : [worktrees] },
      network: { allowedDomains: [...hosts] },
      credentials: { files: CREDENTIAL_FILES.map((path) => ({ path, mode: "deny" })), envVars: vars.map((name) => ({ name, mode: "deny" })) },
    },
    permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: "disable", deny: READ_DENY.map((r) => r.rule) },
  };
}

/**
 * The hosts the project's own commands reach: the npm registry with a package.json, GitHub with a remote there.
 * Others the user names.
 * @param {{ npm: boolean, github: boolean }} has
 */
export const neededHosts = ({ npm, github }) => [...(npm ? ["registry.npmjs.org"] : []), ...(github ? ["github.com", "api.github.com"] : [])];

/**
 * What the files and the environment hold. `pf` reads the project's own files (setup/scan.mjs projectFiles); the
 * user's settings are read from the config folder. A read that fails, or a file that leads out of the
 * repository, is in `unmeasured`, never read as absent; a file holding a value of a key KEPT names that is not a kept
 * kind is in `drops` (Claude Code may skip it whole), any other it skips in `unread`. With any of these among the
 * settings files the mode is not claimed (`mode` `unmeasured`).
 * @param {{ env?: NodeJS.ProcessEnv, pf: { read: (rel: string, opts?: { limit?: number }) => string | null | undefined } }} opts
 */
export function secretSetup({ env = process.env, pf }) {
  /** @type {string[]} */
  const unmeasured = [];
  /** @type {string[]} */
  const drops = [];
  /** @type {string[]} */
  const unread = [];
  const dir = configDir(env);
  const userPath = join(dir, "settings.json");
  // Highest first: local, then shared, then the user's (Claude Code's order below managed settings and flags).
  /** @type {{ path: string, user: boolean, read: () => string | null | undefined }[]} */
  const files = [
    { path: SETTINGS[1], user: false, read: () => pf.read(SETTINGS[1], { limit: SETTINGS_LIMIT }) },
    { path: SETTINGS[0], user: false, read: () => pf.read(SETTINGS[0], { limit: SETTINGS_LIMIT }) },
    { path: userPath, user: true, read: () => readIfThere(userPath, { limit: SETTINGS_LIMIT }) },
  ];
  /** @type {{ path: string, user: boolean, json: Record<string, any> }[]} */
  const read = [];
  for (const f of files) {
    /** @type {string | null | undefined} */
    let text;
    try {
      text = f.read();
    } catch (e) {
      unmeasured.push(/** @type {NodeJS.ErrnoException} */ (e)?.code === "EFBIG" ? `${f.path} could not be read: over 2 MB` : firstLine(e));
      continue;
    }
    // A link out of the repository is not followed (projectFiles), and is no absent file.
    if (text === undefined) unmeasured.push(`${f.path} leads out of the repository, not read`);
    if (text === null || text === undefined) continue;
    const parsed = parseSettings(text, f.path);
    if ("json" in parsed) read.push({ ...f, json: parsed.json });
    else if (KEPT.some((k) => parsed.unread === `${f.path} ${k.key}`)) drops.push(parsed.unread);
    else unread.push(parsed.unread);
  }
  /** The value at `keys` in the first file, highest first, that defines it. @param {string[]} keys */
  const first = (keys) => {
    for (const f of read) {
      const v = keys.reduce((/** @type {any} */ o, k) => (isObject(o) ? o[k] : undefined), f.json);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const enabled = first(["sandbox", "enabled"]) === true;
  const failIfUnavailable = first(["sandbox", "failIfUnavailable"]) === true;
  const bypassOff = first(["permissions", "disableBypassPermissionsMode"]) === "disable";
  const defaultMode = first(["permissions", "defaultMode"]);

  const deny = read.flatMap((f) => list(f.json.permissions?.deny));
  const readDeny = READ_DENY.filter((r) => ![r.rule, ...r.same].some((s) => deny.includes(s))).map((r) => r.rule);

  const home = env.HOME || homedir();
  // Credential entries Claude Code applies from each file: a project file's mask entries it does not.
  const applied = (/** @type {"files" | "envVars"} */ kind) =>
    read.flatMap((f) => list(f.json.sandbox?.credentials?.[kind]).filter((e) => isObject(e) && (e.mode === "deny" || (e.mode === "mask" && f.user))));
  // Named by file, list and index, never by a value from the file: a name pasted wrong can be the token itself.
  const maskIgnored = read
    .filter((f) => !f.user)
    .flatMap((f) => ["files", "envVars"].flatMap((k) => list(f.json.sandbox?.credentials?.[k]).flatMap((e, i) => (isObject(e) && e.mode === "mask" ? [`${f.path} sandbox.credentials.${k}[${i}]`] : []))));
  const names = new Set(applied("envVars").map((e) => e.name));
  const paths = new Set(applied("files").map((e) => String(e.path).replace(/\/+$/, "").replace(/^\/\//, "/").replace(home, "~")));
  const unprotected = [...CREDENTIAL_FILES.filter((p) => !paths.has(p)), ...CREDENTIAL_VARS.filter((n) => env[n] && !names.has(n))];

  const settingsUnread = unmeasured.length > 0 || drops.length > 0 || unread.length > 0;
  const mcp = mcpSecrets(pf, unmeasured);
  return {
    // Not claimed when a settings file was not read whole: what it holds may decide the mode.
    mode: settingsUnread ? "unmeasured" : enabled && failIfUnavailable && bypassOff ? "noBypass" : "asIs",
    sandbox: { enabled, failIfUnavailable },
    bypassOff,
    defaultMode: typeof defaultMode === "string" ? defaultMode : null,
    readDeny,
    // Only where a sandbox runs the commands: with none, every command reads them anyway, and the mode line says so.
    unprotected: enabled ? unprotected : [],
    maskIgnored,
    scrub: { env: scrubOn(env[SCRUB]), files: read.filter((f) => isObject(f.json.env) && scrubOn(f.json.env[SCRUB])).map((f) => f.path) },
    // git gets the process environment with the given one over it: a caller that gives only a few variables still runs git.
    configFolder: configFolder(dir, { ...process.env, ...env }),
    mcp,
    drops,
    unread,
    unmeasured,
    userSettings: userPath,
  };
}

/**
 * The config folder, the git work tree it lies in (`top`, null when none) and the transcripts git would take: files
 * under its `projects` folder that git tracks (`git ls-files`) and that it lists as untracked and not ignored (`git
 * ls-files --others --exclude-standard`, which `git add -A` adds). `error` when git could not say: never read as none.
 * @param {string} dir @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, top: string | null, tracked: number, untracked: number, error?: string }}
 */
export function configFolder(dir, env) {
  const none = { path: dir, top: null, tracked: 0, untracked: 0 };
  // No such folder: there are no transcripts to hold.
  if (!isFolder(dir)) return none;
  /** @type {string | null} */
  let top;
  try {
    top = repoPath("--show-toplevel", { cwd: dir, env });
  } catch (e) {
    return { ...none, error: firstLine(e) };
  }
  if (top === null) return none;
  if (!isFolder(join(dir, "projects"))) return { ...none, top };
  /** @type {number[]} */
  const counts = [];
  for (const args of [["ls-files", "-z", "--", "projects"], ["ls-files", "-z", "--others", "--exclude-standard", "--", "projects"]]) {
    const r = gitRun(args, { cwd: dir, env });
    if (r.error || r.status !== 0) return { ...none, top, error: (r.stderr || firstLine(r.error ?? r.status)).trim().split("\n")[0] };
    counts.push(r.stdout.split("\0").filter(Boolean).length);
  }
  return { path: dir, top, tracked: counts[0], untracked: counts[1] };
}

/** Whether a folder is there. @param {string} dir */
function isFolder(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The literal secrets `.mcp.json` holds: kind and line, never the value. Read as text, and each JSON string written
 * with a backslash decoded, where a `\u` escape can hide one from the text: scanned as `<key>: <value>`, so a kind
 * that needs its label (an AWS secret key) is found, at the string's own line. One pass over the text's strings: a
 * large file costs its length, not its length times its strings. null when there is no file; a file that leads out of
 * the repository is said in `unmeasured`.
 * @param {{ read: (rel: string, opts?: { limit?: number }) => string | null | undefined }} pf @param {string[]} unmeasured
 * @returns {{ kind: string, line: number }[] | null}
 */
function mcpSecrets(pf, unmeasured) {
  /** @type {string | null | undefined} */
  let text;
  try {
    text = pf.read(".mcp.json", { limit: SETTINGS_LIMIT });
  } catch (e) {
    unmeasured.push(/** @type {NodeJS.ErrnoException} */ (e)?.code === "EFBIG" ? ".mcp.json could not be read: over 2 MB" : firstLine(e));
    return null;
  }
  if (text === undefined) unmeasured.push(".mcp.json leads out of the repository, not read");
  if (typeof text !== "string") return null;
  /** @type {{ kind: string, line: number }[]} */
  const hits = textSecrets(text).map((s) => ({ kind: s.kind, line: s.line }));
  let line = 1;
  let at = 0;
  let key = "";
  for (const m of text.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
    for (let i = at; i < /** @type {number} */ (m.index); i++) if (text.charCodeAt(i) === 10) line++;
    at = /** @type {number} */ (m.index);
    /** @type {string} */
    let decoded;
    try {
      decoded = JSON.parse(m[0]);
    } catch {
      continue;
    }
    const isKey = /^\s*:/.test(text.slice(at + m[0].length, at + m[0].length + 64));
    // A string with no backslash reads as written: the text scan above saw it.
    if (m[0].includes("\\")) for (const s of textSecrets(isKey ? decoded : `${key}: ${decoded}`)) hits.push({ kind: s.kind, line });
    if (isKey) key = decoded;
  }
  // A string both scans see (a token before an escape) is one hit.
  return [...new Map(hits.map((h) => [`${h.line} ${h.kind}`, h])).values()];
}
