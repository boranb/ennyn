# Acceptance scenarios for 0.1.0

These scenarios are the second half of 0.1.0's finish line; the first half is the needs of the release node in the work graph. They run on a second project with the shipped text alone, and every line a person or an orchestrator has to add is written down as a product defect. A finding that stops a scenario (the user cannot finish it, a gate lets through what it says it refuses, data is lost) joins the release needs (at most five findings join this way; a sixth is the user's decision, since whoever runs a scenario also rates what it found); any other finding becomes a graph node with a gate and waits.

Each scenario names who runs it, the start state, the steps in the user's words, what makes it done (a command's exit code or a line it prints), and which of Ennyn's own tests already cover part of it. A test file named here exists in `test/`; "part" means the test runs the piece in a temporary repository, not through a fresh install.

## S1. Install

- **Who:** a developer with Claude Code, in a project that never had Ennyn.
- **Start:** a git repository with no `.ennyn/` folder.
- **Steps:**
  1. Run `claude plugin marketplace add boranb/ennyn` (while the repository is private: `claude plugin marketplace add ./ennyn` from a local clone, as the README says).
  2. Run `claude plugin install ennyn@ennyn`.
  3. Restart Claude Code and work in the project as usual: edit, commit, push.
  4. Look for any file the plugin wrote in the project.
- **Done:** both claude commands exit 0; `git status` shows no new file; no hook refused or changed a command.
- **Covered by:** `test/plugin.test.mjs` and `test/hook.test.mjs` (part: the hooks in a project with no config).

## S2. Init on an existing repository

- **Who:** a developer, in a repository with history and tests.
- **Start:** S1 done; no `.ennyn/` folder.
- **Steps:**
  1. Run `/ennyn:init`.
  2. Answer the questions (at most six), or accept the defaults.
  3. Look at `.ennyn/config.json`, the starting graph and the handoff it wrote.
  4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs" doctor`.
  5. Make a commit with a message of the wrong shape.
- **Done:** `doctor` exits 0; the commit of step 5 is refused by the commit-msg hook; the config holds only keys that differ from the defaults.
- **Covered by:** `test/setup.test.mjs`, `test/cli.test.mjs` (part: init-scan, doctor, install-hook).

## S3. Init on a new project

- **Who:** a developer starting from nothing.
- **Start:** a folder with only a README, a licence and a `.gitignore`; once with a git repository, once without.
- **Steps:**
  1. Run `/ennyn:init`.
  2. Without a repository, answer the proposal to run `git init`.
  3. Answer the questions; note any that the config or the first graph did not need.
  4. Let it make the first commit (settings, ignore rules, config, graph, handoff).
  5. Run `doctor`.
- **Done:** `doctor` exits 0; a repository exists; no question was asked that the config and the first graph do not use.
- **Covered by:** `test/setup.test.mjs` (part: the new-project scan and the `git init` proposal).

## S4. The commit hook

- **Who:** a developer in the project of S2.
- **Start:** `review.forbidden` holds one banned literal; the hook is installed.
- **Steps:**
  1. Stage a file that adds the banned literal and run `git commit`.
  2. Stage a file that adds a line holding a secret in a known token format (a made-up one in the format) and run `git commit`.
  3. Commit with a message of the wrong shape.
  4. Commit a clean change with a correct message.
- **Done:** steps 1 to 3 exit non-zero and say why; step 4 exits 0.
- **Covered by:** `test/hook.test.mjs`, `test/forbidden.test.mjs`, `test/secrets.test.mjs`, `test/commit-shape.test.mjs` (part: each check on its own and through the hook, in temporary repositories).

## S5. One task alone

- **Who:** a developer with a graph of at least one small node.
- **Start:** S2 done; a clean work tree.
- **Steps:**
  1. Ask the agent to run the cycle skill on one named node.
  2. Read the plan it gives before it writes code.
  3. Let it write the smallest-change row, the code and the tests.
  4. Read the review: two rounds at most.
  5. Check the commit message for its structured lines.
  6. Read the closing: convergence and handoff. Expect to be asked before any push.
- **Done:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/ennyn.mjs" convergence --cycle <N>` exits 0; `ennyn push-check` says the push needs the user's approval; nothing was pushed.
- **Covered by:** `test/journal.test.mjs`, `test/method-walk.test.mjs`, `test/findings.test.mjs` (part: the journal, the failure count and the ledger).

## S6. A cycle of four tasks to its closing

- **Who:** a developer with at least four ready nodes.
- **Start:** S5 done.
- **Steps:**
  1. Ask the agent to run a cycle.
  2. Read the plan: at most four nodes and the longest chain of tasks.
  3. During the cycle run `ennyn status`.
  4. Let each task land or stop.
  5. Read the convergence block and the leftovers.
  6. Run `ennyn worktrees` and `ennyn test whole`.
  7. Expect the push to be asked for.
- **Done:** `ennyn leftovers` exits 0; `ennyn worktrees` lists no worktree the cycle marked; `ennyn test whole` exits 0 once; nothing was pushed.
- **Covered by:** `test/journal.test.mjs`, `test/leftovers.test.mjs`, `test/worktrees.test.mjs`, `test/metrics.test.mjs` (part: each command; no test runs a whole cycle).

## S7. No bypass

- **Who:** a developer in a throwaway project.
- **Start:** a project set up by `/ennyn:init` in its no-bypass mode (the agent runs with permission prompts, not with bypassPermissions).
- **Steps:**
  1. Run S5 in that mode.
  2. Write down every prompt that blocks the task and every command that fails because of the mode.
  3. Note what the task needed that the mode refused: docker, ports, worktrees outside the project, network hosts.
- **Done:** the task lands or stops, and the report lists each thing that broke; a task that cannot finish for lack of a documented setting is a stopper.
- **Covered by:** `test/secret-setup.test.mjs` (part: the agent-mode report).

## S8. Update and remove

- **Who:** a developer with S2 done.
- **Start:** the plugin installed; the hook installed with `--plugin-data`.
- **Steps:**
  1. Run `claude plugin marketplace update ennyn` and `claude plugin update ennyn@ennyn`, then restart Claude Code.
  2. Make a commit; the hook should follow the new version.
  3. Ask the agent to run `uninstall-hook`.
  4. Run `claude plugin uninstall ennyn@ennyn` and `claude plugin marketplace remove ennyn`.
- **Done:** step 2 exits 0 with a correct message and refuses a wrong one; `uninstall-hook` exits 0 and lists what stays (config, graph, handoff, logs, ask rules); both removal commands exit 0.
- **Covered by:** `test/setup.test.mjs` (part: uninstall-hook), `test/hook.test.mjs` (part: the hook and the plugin's version record).

## Summary

| Scenario | Covered by tests | Steps only a person can run |
|---|---|---|
| S1 Install | part | the claude commands, restart, a real project |
| S2 Init on an existing repository | part | the questions and the files as a person reads them |
| S3 Init on a new project | part | whether the questions feel needed |
| S4 The commit hook | part | the hook in the second project's own setup |
| S5 One task alone | part | the whole run with a real agent |
| S6 A cycle of four tasks | part | the whole run with a real agent |
| S7 No bypass | part | the whole run in the mode |
| S8 Update and remove | part | the claude update and removal commands |
