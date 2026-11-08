/**
 * A box for differential runs against the real bash: a temporary folder whose PATH holds only stand-ins, which write
 * the words they were given and do nothing else, and wrappers that run the machine's own program. A text runs as
 * `bash -c <text>`; what it reached is the stand-ins' lines. Every bash, a nested `bash -c` or `sh -c` too, reads one
 * startup file (BASH_ENV): it switches off the `kill` builtin, so a kill goes to the stand-in on PATH and no process
 * is signalled, and it marks the top shell. `sh` here is bash: dash and zsh would keep a builtin kill. macOS's bash
 * 3.2 started by node with no SHLVL did not read BASH_ENV (measured: the builtin stayed), so SHLVL is set, and
 * `builtins` says where a builtin is still there: a test asks it for every context it runs before it runs any.
 *
 * The safety is the operating system's, not the word check. Every run is inside a boundary (`fence`). On macOS it is
 * sandbox-exec with a profile that denies a signal to any process outside the sandbox, a connection out (a Unix
 * socket too) and a write to a named pipe, checked when the first box is made: from inside, a signal 0 to the shell
 * itself must go and one to a sleeper started outside must be refused as not permitted, with that sleeper still there
 * after. Cycle 27's texts past the check (`bash --posix`, `"$BASH" -l`, a PATH set by `read`, `cd /usr/bin && ./pkill`)
 * ran the real kill and pkill there and reached nothing outside. The profile denies no Mach lookup (launchd's
 * services). On
 * Linux the boundary is the container, read from a PID namespace other than the first and the file the container's
 * engine leaves: the box shares the container with the test runner and the other test files' processes, and those a
 * text can reach. A Linux host outside a container (WSL too) and any other system have no boundary, and the box throws
 * there, as it does where sandbox-exec is missing or lets the signal out. A set-user-ID program (ps on macOS) does not
 * start in the sandbox. `inFence` puts a test's own shell inside the same boundary. The word check (`unsafeTexts`)
 * stays as a first, cheap refusal with its reasons; it is no longer what keeps a real process safe, and texts get past
 * it.
 *
 * Needs bash at /bin/bash or on PATH, and /bin/sh: one that is missing throws, so the test fails, never skips. A run
 * has a time limit, starts in a process group of its own (a kill of its group reaches no test runner), and the
 * runs are sequential. A stand-in writes its line in one write: written in pieces, two stand-ins
 * of one text (a background start and a kill) once wove their lines together.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the machine's program is, by /bin/sh's own lookup on the inherited PATH. @param {string} name */
export function machineProgram(name) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const at = r.stdout.trim();
  return at.startsWith("/") ? at : null;
}

/** The highest PID Linux can give (2^22); macOS gives at most 99,999. */
export const PID_LIMIT = 4194304;

/**
 * What leaves the box: a path or a lookup that finds the real program past the stand-in (`/kill`, `command -p`, a
 * PATH of its own, `hash`, `env -i`, `-u`, `-S`), a builtin turned back on (`enable`, `builtin`), a startup file other than
 * the box's (`BASH_ENV`, `ENV=`, `/etc/`, `~/.`), and a login or interactive shell, which reads /etc/profile: on macOS its
 * path_helper put /usr/bin before the stand-ins, and a real pkill ran. A shell's options are the words after its name
 * that start with `-` or `+`: `bash -c 'kill -l'` holds none.
 */
const LEAVES = /\/kill|command\s+-p|PATH\+?=|\bexport\s+PATH\b|\bhash\b|BASH_ENV|\bENV=|\benable\b|\bbuiltin\b|\benv\s+-[iuS]|\/etc\/|~\/\.|\bsu\b|\bsudo\s+-\w*[is]|--login|--rcfile|--init-file|-o\s*login|\bexec\s+-\w*l|\bexec\s+(?:-\w+\s+)*-a\s*['"]?-|(?:^|[\s'"(;&|`/\\])-(?:ba|z|da|k|c|tc|fi|a|rba)?sh\b|(?:^|[\s'"(;&|`/\\])(?:ba|z|da|k|c|tc|fi|a|rba)?sh(?:\s+['"]?[-+][\w-]*['"]?)*?\s+['"]?[-+][a-zA-Z]*[li]/;

/**
 * The texts that could reach a real kill or a real process, each with why: what leaves the box (LEAVES), or a number
 * a kill, tskill or /PID may get that a process can have, 0 and -1 among them. A signal written `-9` with a word after
 * it is no target. Asked over every generated text before any of them runs, and by the box before each run.
 * @param {string[]} texts
 */
export function unsafeTexts(texts) {
  const out = [];
  for (const text of texts) {
    const found = LEAVES.exec(text);
    if (found) {
      out.push(`${JSON.stringify(text)}: ${found[0]}`);
      continue;
    }
    // Command by command, so a word of the next command is never taken for this one's.
    for (const command of text.split(/[;|&()`{}\n]+/)) {
      const words = command.split(/[\s'"<>]+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        if (!/^(kill|tskill|\/\/?pid|-pid)$/i.test(words[i])) continue;
        for (let j = i + 1; j < words.length && /^(-?\d+|-[A-Za-z]+|--|TERM)$/.test(words[j]); j++) {
          if (!/^-?\d+$/.test(words[j])) continue;
          const signal = j === i + 1 && words[j].startsWith("-") && j + 1 < words.length;
          if (!signal && Math.abs(Number(words[j])) <= PID_LIMIT) out.push(`${JSON.stringify(text)}: ${words[i]} ${words[j]}`);
        }
      }
    }
  }
  return out;
}

/**
 * macOS's sandbox: everything allowed but a signal to a process outside it, a connection out (a Unix socket too: tmux,
 * ssh -O, docker) and a write to a named pipe (screen's server listens on one): each reached and stopped an outside
 * process from a box text (cycle 28's review).
 */
export const PROFILE = "(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))(deny network-outbound)(deny file-write* (vnode-type FIFO))";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The first PID namespace's inode on Linux (PROC_PID_INIT_INO, include/linux/proc_ns.h). */
export const FIRST_PID_NS = "pid:[4026531836]";

/**
 * The boundary every run goes through, from what the machine says: `{ name, argv }`, argv put before the box's bash.
 * @param {{ platform: string, sandboxExec?: boolean, refused?: number | null, pidNs?: string | null, engineFile?: boolean }} m
 *   `refused`: the exit of the check run in the sandbox, 0 when its signal to the outside sleeper was refused
 */
export function pickFence(m) {
  if (m.platform === "darwin") {
    if (!m.sandboxExec) throw new Error(`this harness needs ${SANDBOX_EXEC}: without it a text past the check can signal any process`);
    if (m.refused !== 0) throw new Error(`a signal left the sandbox, or it did not start (exit ${m.refused}): the box runs nothing`);
    return { name: "sandbox", argv: [SANDBOX_EXEC, "-p", PROFILE] };
  }
  if (m.platform === "linux" && m.pidNs && m.pidNs !== FIRST_PID_NS && m.engineFile) return { name: "container", argv: [] };
  throw new Error(`no boundary keeps a signal in the box on ${m.platform} here (a container on Linux, sandbox-exec on macOS): the box runs nothing`);
}

/**
 * The exit of the check that sandbox-exec fences: 0 when, from inside, a signal 0 to the shell itself goes and one to
 * `pid` (a process outside, alive) is refused as not permitted; a process that is gone answers otherwise. It runs with
 * no exported shell function, as the box's runs do. @param {number | undefined} pid
 */
export function refusedExit(pid) {
  // A sleeper that did not start leaves nothing to refuse: that reads as not fenced, never as fenced.
  const check = pid === undefined ? "exit 5" : `kill -0 $$ || exit 4; out=$(kill -0 ${pid} 2>&1) && exit 3; case "$out" in *"not permitted"*) exit 0;; esac; exit 6`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BASH_FUNC_"))), LC_ALL: "C" };
  return spawnSync(SANDBOX_EXEC, ["-p", PROFILE, "/bin/sh", "-c", check], { env, stdio: "ignore", timeout: 10000 }).status;
}

/** What pickFence reads, read on this machine; the macOS check sends signal 0 only, to a sleeper it started. */
function fenceReadings() {
  const m = { platform: process.platform, sandboxExec: false, refused: /** @type {number | null} */ (null), pidNs: /** @type {string | null} */ (null), engineFile: false };
  if (m.platform === "darwin") {
    m.sandboxExec = existsSync(SANDBOX_EXEC);
    if (!m.sandboxExec) return m;
    const outside = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      m.refused = refusedExit(outside.pid);
      // The sleeper must still be there after the check, or the refusal read was of nothing.
      try {
        if (outside.pid !== undefined) process.kill(outside.pid, 0);
      } catch {
        m.refused = 7;
      }
    } finally {
      outside.kill();
    }
  } else if (m.platform === "linux") {
    try {
      m.pidNs = readlinkSync("/proc/self/ns/pid");
    } catch {}
    m.engineFile = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  }
  return m;
}

/** @type {{ name: string, argv: string[] } | undefined} */
let picked;
/** The boundary, picked and checked once a process. */
const theFence = () => (picked ??= pickFence(fenceReadings()));

/**
 * A command put inside the box's boundary, for a test that runs a shell of its own on corpus texts: the fence's
 * program first, then `argv`. Throws where no boundary holds, as the box does. @param {string[]} argv
 */
export function inFence(argv) {
  return [...theFence().argv, ...argv];
}

/** A word separator and a line end no generated text holds. */
export const UNIT = "\u001f";

/**
 * @param {string} prefix temporary folder prefix
 * @param {{ stands: Record<string, string>, real: string[] }} programs `stands`: each stand-in's name and the shell
 *   lines it runs after writing its words (`$LOG`, `$BOX` set); `real`: programs run as the machine's own
 */
export function shellBox(prefix, { stands, real }) {
  const bash = existsSync("/bin/bash") ? "/bin/bash" : machineProgram("bash");
  if (!bash || !existsSync("/bin/sh")) throw new Error("this harness needs bash and /bin/sh");
  const fence = theFence();
  const box = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const bin = join(box, "bin");
  const cwd = join(box, "work");
  const log = join(box, "log");
  mkdirSync(bin);
  mkdirSync(cwd);
  const startup = join(box, "startup");
  // A shell's startup file would run in every line; the only one here is this.
  writeFileSync(startup, "enable -n kill\nexport BOX_TOP=${BOX_TOP:-$$}\n");
  for (const shell of ["bash", "sh"]) writeFileSync(join(bin, shell), `#!/bin/sh\nexec '${bash}' "$@"\n`, { mode: 0o755 });
  for (const name of real) {
    const at = machineProgram(name);
    if (!at) throw new Error(`this harness needs ${name}`);
    writeFileSync(join(bin, name), `#!/bin/sh\nexec '${at}' "$@"\n`, { mode: 0o755 });
  }
  for (const [name, body] of Object.entries(stands)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nLOG='${log}'; BOX='${box}'\nline=$(printf '%s\\037%s' "$$" '${name}'; for a in "$@"; do printf '\\037%s' "$a"; done)\nprintf '%s\\n' "$line" >> "$LOG"\n${body}\n`, { mode: 0o755 });
  }
  // The hermetic setup's git variables stay (test/hermetic.mjs refuses a child without them); a shell function the
  // caller exported, its startup files and its PATH do not.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BASH_FUNC_") && !["ENV", "ZDOTDIR", "CDPATH", "GLOBIGNORE", "SHELLOPTS", "BASHOPTS", "IFS", "PS4"].includes(k)));
  const env = { ...inherited, PATH: bin, HOME: box, BASH_ENV: startup, SHLVL: "1", LC_ALL: "C", TMPDIR: box };
  // Every run inside the fence: its program first, then the box's bash.
  const command = [...fence.argv, join(bin, "bash")];
  /** @param {string} text */
  const inside = (text) => spawnSync(command[0], [...command.slice(1), "-c", text], { cwd, env, input: "", encoding: "utf8", timeout: 10000, detached: true });
  return {
    box,
    cwd,
    /** The boundary the runs are in: `sandbox` or `container`. */
    fence: fence.name,
    /**
     * What `bash -c text` ran, one entry a stand-in call: its PID, its name and its words, in the order they were written;
     * the files the text wrote are removed.
     * @param {string} text
     * @returns {{ calls: string[][], status: number | null }}
     */
    run(text) {
      const unsafe = unsafeTexts([text]);
      if (unsafe.length) throw new Error(`refused, it could leave the box: ${unsafe.join("; ")}`);
      writeFileSync(log, "");
      rmSync(cwd, { recursive: true, force: true });
      mkdirSync(cwd);
      const r = inside(text);
      if (r.signal) throw new Error(`bash did not end: ${JSON.stringify(text)}`);
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(UNIT));
      return { calls, status: r.status };
    },
    /**
     * The texts in which `name` is still the shell's builtin, each run with `type -t <name>` in it.
     * @param {string} name @param {string[]} texts each holding `{}` where the check goes
     */
    builtins(name, texts) {
      const unsafe = unsafeTexts(texts.map((t) => t.replaceAll("{}", "")));
      if (unsafe.length) throw new Error(`refused, it could leave the box: ${unsafe.join("; ")}`);
      return texts.filter((t) => {
        const r = inside(t.replaceAll("{}", `type -t ${name}`));
        return r.signal !== null || r.stdout.split("\n").includes("builtin");
      });
    },
    close: () => rmSync(box, { recursive: true, force: true }),
  };
}
