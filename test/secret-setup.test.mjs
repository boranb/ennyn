import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { parseSettings } from "../setup/permissions.mjs";
import { projectFiles, scanProject } from "../setup/scan.mjs";
import { secretReport } from "../setup/doctor.mjs";
import { noBypassBlock, scrubOn, secretSetup } from "../setup/secret-setup.mjs";

/** The test's environment without what names a token or the scrub variable: a test sets those it reads. */
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|_KEY|SCRUB/.test(k)));
/** A project folder and a home folder of its own, each empty. */
function place() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "en-sec-")));
  const dir = join(top, "p");
  const home = join(top, "home");
  mkdirSync(dir);
  mkdirSync(join(home, ".claude"), { recursive: true });
  // test/hostile.mjs puts the temporary folder in a repository: git looks no higher than this place's own folder.
  return { dir, home, env: /** @type {NodeJS.ProcessEnv} */ ({ ...clean(), HOME: home, CLAUDE_CONFIG_DIR: "", GIT_CEILING_DIRECTORIES: top }) };
}
/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
/** @param {{ dir: string, env: NodeJS.ProcessEnv }} p */
const setupOf = (p) => secretSetup({ env: p.env, pf: projectFiles(p.dir) });
/** Doctor's lines for the place, as keys. @param {{ dir: string, env: NodeJS.ProcessEnv }} p */
function lines(p) {
  /** @type {{ level: string, key: string, vars: any }[]} */
  const out = [];
  secretReport(p.dir, p.env, (level, key, vars = {}) => out.push({ level, key, vars }));
  return out;
}

const BLOCK = { worktrees: "~/.ennyn-p", hosts: ["registry.npmjs.org"], vars: ["GH_TOKEN"] };

test("secret setup: the no-bypass block is exact, every value one Claude Code keeps the file with", () => {
  // The values test/reference/claude-code.json records Claude Code keeping a file with (settings-no-bypass-block):
  // the string "disable", booleans, deny entries; never a SCRUB variable.
  assert.deepEqual(noBypassBlock(BLOCK), {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["~/.ennyn-p"] },
      network: { allowedDomains: ["registry.npmjs.org"] },
      credentials: { files: [{ path: "~/.ssh", mode: "deny" }, { path: "~/.aws", mode: "deny" }], envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
    },
    permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: "disable", deny: ["Read(.env*)", "Read(~/.ssh/**)", "Read(~/.aws/**)"] },
  });
  assert.ok("json" in parseSettings(JSON.stringify(noBypassBlock(BLOCK)), "p"), "the shared reader keeps the block");
});

test("secret setup: for the keys it reads, only a kind measured kept is read; any other value leaves the file unread", () => {
  // Kept: measured on 2.1.310 (test/reference/claude-code.json, settings-no-bypass-*, settings-credentials-mask-project,
  // settings-bypass-disable-string); the permission modes from the schema of 2.1.310 and 2.1.319.
  const keeps = [
    { permissions: { disableBypassPermissionsMode: "disable", defaultMode: "acceptEdits" } },
    { permissions: { defaultMode: "bypassPermissions" } },
    { sandbox: { enabled: true, enabeld: "x" } },
    { sandbox: { enabled: false, failIfUnavailable: true, autoAllowBashIfSandboxed: false, filesystem: { allowWrite: [] }, network: { allowedDomains: ["a"] } } },
    { sandbox: { credentials: { envVars: [{ name: "X", mode: "deny" }, { name: "Y", mode: "mask" }], files: [{ path: "~/.ssh", mode: "deny" }] } } },
  ];
  for (const json of keeps) assert.ok("json" in parseSettings(JSON.stringify(json), "f"), JSON.stringify(json));
  // Measured skipped (the settings-bypass-*, settings-sandbox-*, settings-credentials-* and block cells), and kinds not
  // measured kept (an object, a number on the bypass key): neither is read.
  const odd = [
    [{ permissions: { disableBypassPermissionsMode: true } }, "permissions.disableBypassPermissionsMode"],
    [{ permissions: { disableBypassPermissionsMode: null } }, "permissions.disableBypassPermissionsMode"],
    [{ permissions: { disableBypassPermissionsMode: "Disable" } }, "permissions.disableBypassPermissionsMode"],
    [{ permissions: { disableBypassPermissionsMode: 1 } }, "permissions.disableBypassPermissionsMode"],
    [{ permissions: { defaultMode: "acceptedits" } }, "permissions.defaultMode"],
    [{ sandbox: { enabled: "true" } }, "sandbox"],
    [{ sandbox: { enabled: 1 } }, "sandbox"],
    [{ sandbox: { enabled: null } }, "sandbox"],
    [{ sandbox: { failIfUnavailable: "true" } }, "sandbox"],
    [{ sandbox: { autoAllowBashIfSandboxed: "yes" } }, "sandbox"],
    [{ sandbox: { filesystem: { allowWrite: "~/wt" } } }, "sandbox"],
    [{ sandbox: { network: { allowedDomains: [1] } } }, "sandbox"],
    [{ sandbox: "x" }, "sandbox"],
    [{ sandbox: { credentials: { envVars: [{ name: "X" }] } } }, "sandbox"],
    [{ sandbox: { credentials: { envVars: [{ name: "X", mode: 1 }] } } }, "sandbox"],
    [{ sandbox: { credentials: { envVars: [{ name: "X", mode: "block" }] } } }, "sandbox"],
    [{ sandbox: { credentials: { files: [{ path: "~/.ssh", mode: "block" }] } } }, "sandbox"],
    [{ sandbox: { credentials: { files: [{ mode: "deny" }] } } }, "sandbox"],
    [{ sandbox: { credentials: { envVars: [5] } } }, "sandbox"],
  ];
  for (const [json, key] of odd) assert.deepEqual(parseSettings(JSON.stringify(json), "f"), { unread: `f ${key}` }, JSON.stringify(json));
});

test("secret setup: no settings is the agent as it is, with the three Read deny rules missing and nothing else said", () => {
  const p = place();
  const s = setupOf(p);
  assert.equal(s.mode, "asIs");
  assert.deepEqual(s.readDeny, ["Read(.env*)", "Read(~/.ssh/**)", "Read(~/.aws/**)"]);
  assert.deepEqual([s.unprotected, s.maskIgnored, s.drops, s.unmeasured, s.mcp], [[], [], [], [], null]);
  assert.deepEqual(lines(p).map((l) => `${l.level} ${l.key}`), ["ok doctor.agentModeAsIs", "warn doctor.agentReadDeny"]);
});

test("secret setup: bypass in the user's settings stays the agent as it is, and nothing is a fail", () => {
  const p = place();
  put(p.home, { ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }) });
  const s = setupOf(p);
  assert.equal(s.mode, "asIs");
  assert.equal(s.defaultMode, "bypassPermissions");
  assert.ok(lines(p).every((l) => l.level !== "fail"));
});

test("secret setup: the block in either project file is the no-bypass mode, its credentials and Read rules held", () => {
  for (const file of [".claude/settings.local.json", ".claude/settings.json"]) {
    const p = place();
    put(p.dir, { [file]: JSON.stringify(noBypassBlock(BLOCK)) });
    const s = secretSetup({ env: { ...p.env, GH_TOKEN: "x" }, pf: projectFiles(p.dir) });
    assert.equal(s.mode, "noBypass", file);
    assert.equal(s.defaultMode, "acceptEdits");
    assert.deepEqual([s.readDeny, s.unprotected], [[], []], file);
    assert.deepEqual(lines(p).map((l) => l.key), ["doctor.agentModeNoBypass"], file);
  }
});

test("secret setup: the higher file decides: a local file's false over a shared true leaves the agent as it is", () => {
  const p = place();
  put(p.dir, { ".claude/settings.json": JSON.stringify(noBypassBlock(BLOCK)), ".claude/settings.local.json": JSON.stringify({ sandbox: { enabled: false } }) });
  assert.equal(setupOf(p).mode, "asIs");
  // A user file's sandbox is read below the project's, and reaches the mode.
  const q = place();
  put(q.home, { ".claude/settings.json": JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }) });
  put(q.dir, { ".claude/settings.json": JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }) });
  assert.equal(setupOf(q).mode, "noBypass");
  // A sandbox that may be missing runs commands unsandboxed with a warning: not the no-bypass mode.
  const r = place();
  put(r.dir, { ".claude/settings.json": JSON.stringify({ sandbox: { enabled: true }, permissions: { disableBypassPermissionsMode: "disable" } }) });
  assert.equal(setupOf(r).mode, "asIs");
  assert.deepEqual(lines(r).map((l) => l.key).slice(0, 1), ["doctor.agentModeAsIsSandbox"]);
});

test("secret setup: with the sandbox on, a token set in the environment and not denied is named, and a project file's mask counts for nothing", () => {
  const p = place();
  put(p.dir, { ".claude/settings.json": JSON.stringify({ sandbox: { enabled: true, credentials: { envVars: [{ name: "NPM_TOKEN", mode: "deny" }, { name: "GH_TOKEN", mode: "mask" }], files: [{ path: "~/.ssh/", mode: "deny" }] } } }) });
  const env = { ...p.env, GH_TOKEN: "x", NPM_TOKEN: "y", AWS_SECRET_ACCESS_KEY: "" };
  const s = secretSetup({ env, pf: projectFiles(p.dir) });
  assert.deepEqual(s.unprotected, ["~/.aws", "GH_TOKEN"]);
  assert.deepEqual(s.maskIgnored, [".claude/settings.json sandbox.credentials.envVars[1]"]);
  // The same mask from the user's own settings applies; an absolute home path counts as `~`.
  put(p.home, { ".claude/settings.json": JSON.stringify({ sandbox: { credentials: { envVars: [{ name: "GH_TOKEN", mode: "mask" }], files: [{ path: `${p.home}/.aws`, mode: "deny" }] } } }) });
  assert.deepEqual(secretSetup({ env, pf: projectFiles(p.dir) }).unprotected, []);
  // With no sandbox, every command reads them anyway: the mode line says that, not one line a token.
  const q = place();
  assert.deepEqual(secretSetup({ env: { ...q.env, GH_TOKEN: "x" }, pf: projectFiles(q.dir) }).unprotected, []);
});

test("secret setup: Read deny rules count as written, in a project or the user's file, and only the spellings named", () => {
  const p = place();
  put(p.dir, { ".claude/settings.local.json": JSON.stringify({ permissions: { deny: ["Read(**/.env*)", "Read(~/.ssh)"] } }) });
  put(p.home, { ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Read(~/.aws/**)"] } }) });
  assert.deepEqual(setupOf(p).readDeny, ["Read(~/.ssh/**)"]);
});

test("secret setup: a file Claude Code may skip is named, a project's and the user's, its values are not read and the mode is not claimed", () => {
  const p = place();
  put(p.dir, { ".claude/settings.json": JSON.stringify({ sandbox: { enabled: "true", failIfUnavailable: true }, permissions: { disableBypassPermissionsMode: "disable" } }) });
  put(p.home, { ".claude/settings.json": JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }) });
  const s = setupOf(p);
  assert.equal(s.mode, "unmeasured");
  assert.deepEqual(s.drops, [".claude/settings.json sandbox", `${join(p.home, ".claude", "settings.json")} permissions.disableBypassPermissionsMode`]);
  const out = lines(p);
  assert.deepEqual(out.slice(0, 2).map((l) => `${l.level} ${l.key}`), ["unmeasured doctor.agentModeUnread", "warn doctor.agentDrops"]);
  // The block with a wrong value elsewhere in the file: not claimed either.
  const b = place();
  put(b.dir, { ".claude/settings.json": JSON.stringify({ ...noBypassBlock(BLOCK), permissions: { ...noBypassBlock(BLOCK).permissions, defaultMode: "acceptedits" } }) });
  assert.equal(setupOf(b).mode, "unmeasured");
  // Not JSON is unread, not a drop: the ask line names a project's, this line the user's.
  const q = place();
  put(q.dir, { ".claude/settings.json": "{" });
  assert.deepEqual([setupOf(q).drops, setupOf(q).unread, setupOf(q).mode], [[], [".claude/settings.json"], "unmeasured"]);
  assert.ok(!lines(q).some((l) => l.key === "doctor.agentUserUnread"));
  const u = place();
  put(u.home, { ".claude/settings.json": "[]" });
  const user = lines(u).find((l) => l.key === "doctor.agentUserUnread");
  assert.deepEqual(user?.vars.list, [join(u.home, ".claude", "settings.json")]);
  assert.equal(user?.level, "unmeasured");
});

test("secret setup: a settings file or .mcp.json that leads out of the repository is unmeasured, never absent, and the mode is not claimed", () => {
  for (const name of [".claude/settings.local.json", ".claude/settings.json", ".mcp.json"]) {
    const p = place();
    put(p.dir, { ".claude/settings.json": JSON.stringify(noBypassBlock(BLOCK)) });
    put(p.home, { "shared.json": JSON.stringify({ sandbox: { enabled: false } }) });
    rmSync(join(p.dir, name), { force: true });
    symlinkSync(join(p.home, "shared.json"), join(p.dir, name));
    const s = setupOf(p);
    assert.ok(s.unmeasured.some((u) => u === `${name} leads out of the repository, not read`), `${name}: ${s.unmeasured}`);
    if (name !== ".mcp.json") assert.equal(s.mode, "unmeasured", name);
    assert.ok(lines(p).some((l) => l.key === "doctor.agentUnmeasured" && /leads out/.test(l.vars.error)), name);
  }
});

test("secret setup: the scrub variable is read as Claude Code reads it, from the environment and from a settings file's env", () => {
  for (const v of ["1", "true", " YES ", "on"]) assert.ok(scrubOn(v), v);
  for (const v of ["0", "false", "no", "off", "", "2", undefined]) assert.ok(!scrubOn(v), String(v));
  const p = place();
  put(p.dir, { ".claude/settings.json": JSON.stringify({ env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } }) });
  const s = secretSetup({ env: { ...p.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "true" }, pf: projectFiles(p.dir) });
  assert.deepEqual(s.scrub, { env: true, files: [".claude/settings.json"] });
  /** @type {string[]} */
  const keys = [];
  secretReport(p.dir, { ...p.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "true" }, (_l, key) => keys.push(key));
  assert.ok(keys.includes("doctor.agentScrubEnv") && keys.includes("doctor.agentScrubFile"), keys.join());
  // The block never sets it.
  assert.doesNotMatch(JSON.stringify(noBypassBlock(BLOCK)), /SCRUB/);
});

test("secret setup: transcripts git tracks or would add under the config folder are counted and said; an ignored one, or another ignored path, decides nothing", () => {
  const p = place();
  git(["init", "-q"], { cwd: p.home });
  // No transcripts yet: nothing git could take.
  assert.deepEqual(setupOf(p).configFolder, { path: join(p.home, ".claude"), top: p.home, tracked: 0, untracked: 0 });
  put(p.home, { ".claude/projects/x/s.jsonl": "{}\n", ".claude/projects/old/t.jsonl": "{}\n" });
  assert.deepEqual([setupOf(p).configFolder.tracked, setupOf(p).configFolder.untracked], [0, 2]);
  assert.ok(lines(p).some((l) => l.key === "doctor.agentConfigInRepo" && l.vars.untracked === 2));
  // One project's folder ignored: the other is still taken.
  put(p.home, { ".gitignore": ".claude/projects/old/\n" });
  assert.deepEqual([setupOf(p).configFolder.tracked, setupOf(p).configFolder.untracked], [0, 1]);
  // All ignored, and the dotfiles pattern: nothing.
  for (const ignore of [".claude/projects/\n", "*\n"]) {
    put(p.home, { ".gitignore": ignore });
    assert.deepEqual([setupOf(p).configFolder.tracked, setupOf(p).configFolder.untracked], [0, 0], ignore);
    assert.ok(!lines(p).some((l) => l.key === "doctor.agentConfigInRepo"), ignore);
  }
  // Ignored but tracked: git add -f took it once, and every commit keeps it.
  git(["add", "-f", ".claude/projects/x/s.jsonl"], { cwd: p.home });
  assert.deepEqual([setupOf(p).configFolder.tracked, setupOf(p).configFolder.untracked], [1, 0]);
  assert.ok(lines(p).some((l) => l.key === "doctor.agentConfigInRepo" && l.vars.tracked === 1));
  // CLAUDE_CONFIG_DIR names the folder; one that is not there holds nothing; none in a work tree: no line.
  const q = place();
  assert.deepEqual(secretSetup({ env: { ...q.env, CLAUDE_CONFIG_DIR: join(q.home, "none") }, pf: projectFiles(q.dir) }).configFolder, { path: join(q.home, "none"), top: null, tracked: 0, untracked: 0 });
  assert.equal(setupOf(q).configFolder.top, null);
});

test("secret setup: a literal token in .mcp.json is named by its line and kind, never by its value", () => {
  const p = place();
  const token = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
  put(p.dir, { ".mcp.json": `{\n  "mcpServers": {\n    "x": { "command": "x", "env": { "T": "${token}" } }\n  }\n}\n` });
  const s = setupOf(p);
  assert.deepEqual(s.mcp, [{ kind: "github-token", line: 3 }]);
  const out = lines(p);
  const hit = out.find((l) => l.key === "doctor.agentMcpSecret");
  assert.equal(hit?.level, "warn");
  assert.doesNotMatch(JSON.stringify(out) + t("doctor.agentMcpSecret", hit?.vars ?? {}), new RegExp(token));
  // A \\u escape hides the token from the text: the parsed value is read, at the line of its key.
  const q = place();
  put(q.dir, { ".mcp.json": `{\n  "mcpServers": {\n    "x": {\n      "command": "x",\n      "env": { "TOK": "\\u0067${token.slice(1)}" }\n    }\n  }\n}\n` });
  assert.deepEqual(setupOf(q).mcp, [{ kind: "github-token", line: 5 }]);
  // Its key on two lines: the string's own line.
  const r = place();
  put(r.dir, { ".mcp.json": JSON.stringify({ a: { T: "x" }, b: { T: `\\u0067${token.slice(1)}` } }, null, 1).replace("\\\\u", "\\u") });
  assert.deepEqual(setupOf(r).mcp, [{ kind: "github-token", line: 6 }]);
  assert.ok(lines(r).some((l) => l.key === "doctor.agentMcpSecret" && l.vars.lines[0] === "6 (github-token)"));
  // A kind that needs its label: the decoded value is read with its key.
  const aws = place();
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKY";
  put(aws.dir, { ".mcp.json": `{\n  "mcpServers": { "x": { "command": "x",\n    "env": { "AWS_SECRET_ACCESS_KEY": "\\u0077${secret.slice(1)}" } } }\n}\n` });
  assert.deepEqual(setupOf(aws).mcp, [{ kind: "aws-secret-access-key", line: 3 }]);
  // A token before an escape in the same string: the text scan and the decoded one see it, and it is one hit.
  const both = place();
  put(both.dir, { ".mcp.json": `{ "env": { "T": "${token}\\n" } }\n` });
  assert.deepEqual(setupOf(both).mcp, [{ kind: "github-token", line: 1 }]);
  // A mask entry whose name is a token is named by its place, never by its value.
  const m = place();
  put(m.dir, { ".claude/settings.json": JSON.stringify({ sandbox: { credentials: { envVars: [{ name: token, mode: "mask" }] } } }) });
  const masked = lines(m).find((l) => l.key === "doctor.agentMaskIgnored");
  assert.deepEqual(masked?.vars.list, [".claude/settings.json sandbox.credentials.envVars[0]"]);
  assert.doesNotMatch(JSON.stringify(lines(m)), new RegExp(token));
});

test("secret setup: a 2 MB .mcp.json of 85,000 escaped strings is read in one pass, not one pass a string", () => {
  // Each value decodes to text found nowhere in the file whose start is everywhere in it (`k<n>z` among keys `k<n>`):
  // looked for in the whole text one string at a time, 2,000 of them took 1.1 s on this machine, so 85,000 some 45 s;
  // one pass takes well under one. The limit is far from both, so load does not decide it.
  const p = place();
  const body = Array.from({ length: 85000 }, (_, i) => `"k${i}":"\\u006b${i}z"`).join(",");
  const text = `{"mcpServers":{"s":{"command":"x","env":{${body}}}}}`;
  assert.ok(text.length < 2 * 1024 * 1024, `${text.length} bytes: under the 2 MB read limit`);
  put(p.dir, { ".mcp.json": text });
  const start = performance.now();
  assert.deepEqual(setupOf(p).mcp, []);
  const took = performance.now() - start;
  assert.ok(took < 15000, `${Math.round(took)} ms`);
});

test("secret setup: init-scan gives the setup and the block, no worktrees folder (init asks for it) and its hosts from the project", () => {
  const p = place();
  git(["init", "-q"], { cwd: p.dir });
  put(p.dir, { "package.json": "{}" });
  const scan = scanProject({ cwd: p.dir, env: { ...p.env, NPM_TOKEN: "x" } });
  const secrets = scan.agentSetup.secrets;
  assert.equal(secrets.mode, "asIs");
  assert.deepEqual(secrets.proposal, noBypassBlock({ worktrees: null, hosts: ["registry.npmjs.org"], vars: ["NPM_TOKEN"] }));
  assert.deepEqual(secrets.proposal.sandbox.filesystem.allowWrite, []);
});
