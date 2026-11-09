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
 * engine leaves: the box shares the container with the test runner and the other test files' processes and files,
 * and those a text can reach. A Linux host outside a container (WSL, a CI machine) gets namespaces of its own
 * (`unshare`: user, PID, mount and network) and a root of its own: the namespace's PID 1 (bash in POSIX mode, so it
 * reads no startup file, and leads a session of its own: no controlling terminal) mounts a new root on a tmpfs that
 * holds /usr and /etc (and the /bin, /lib links), a /dev of null, zero, full, random and urandom (no tty), a fresh
 * /proc, an empty /tmp and the run's own folders at their paths, pivots into it and drops the old one; a step that
 * fails is said (`box-init:`, exit 125) and the run throws. A program a box or a corpus wraps must be in a folder that
 * root holds (`inRoot`): one elsewhere (Homebrew, ~/.local/bin, /opt) is refused by name when the box is made. A text
 * there sees and signals no process outside, reaches no TCP port or abstract socket outside, and sees no path
 * outside the box's folders: no /home, /run (the Docker, PostgreSQL, D-Bus and WSL interop sockets), /mnt (the Windows
 * drive) or the test runner's /tmp (measured, Ubuntu 22.04 on WSL 2, util-linux 2.37.2). It runs as root of its user
 * namespace, the caller's own user outside: /usr and /etc are the machine's, read-only to that user by their modes, and
 * the user keeps its groups (`setgroups` is denied), so a group-writable file under /usr or /etc stays writable. The
 * check when the first box is made: from inside, a signal 0 to a live sleeper started outside must find no such
 * process, with that sleeper there before and after, and a file made outside for the check must not be there. PID 1
 * then starts the run's command in a process group of its own, as `detached` does elsewhere, so the shell is no PID 1
 * that ignores signals, and waits until every process of the run has ended, as a coproc's shell outlives the top
 * shell, before it ends with the command's exit (a signal's as 128 + its number): when PID 1 ends, the kernel ends the
 * rest. unshare ignores SIGTERM, so a run's time limit sends SIGKILL, which takes the namespace down with it
 * (`--kill-child`); `inFence` runs a test's own command with the same limit. Where none holds (no container, and
 * unshare missing or refused, as where unprivileged user namespaces are restricted; any other system) the box throws,
 * naming what it tried, as it does where sandbox-exec is missing or lets the signal out. A set-user-ID program (ps on
 * macOS) does not start in the sandbox. `inFence` puts a test's own shell inside the same boundary. The word check (`unsafeTexts`) stays as a first, cheap
 * refusal with its reasons; it is no longer what keeps a real process safe, and texts get past it.
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
/** Linux outside a container: a PID namespace of the run's own, and the namespace dies when unshare does. */
export const UNSHARE_ARGS = ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--kill-child", "--net"];
const unshareAt = () => ["/usr/bin/unshare", "/bin/unshare"].find((p) => existsSync(p)) ?? null;
/** A program of the machine's by its path, for the namespace's PID 1, which has no PATH it can trust. @param {string} name */
const sbin = (name) => ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map((d) => `${d}/${name}`).find((p) => existsSync(p)) ?? name;
/**
 * The namespace's PID 1, run by bash in POSIX mode (which reads no startup file, BASH_ENV neither), given the folders the run keeps, `--`, then the command. It builds the new
 * root (a step that fails exits 125: the run, and the check, then fail), pivots into it, drops the old root, goes back
 * to the folder it started in where the new root has it, starts the command as a job of its own (`set -m`: its own
 * process group), waits for it, then for every other process the namespace holds, and exits with the command's status.
 */
function init() {
  const [mount, umount, pivot, mkdir, rmdir, ln, readlink, touch, sleep] = ["mount", "umount", "pivot_root", "mkdir", "rmdir", "ln", "readlink", "touch", "sleep"].map(sbin);
  return [
    'fail() { echo "box-init: $1" >&2; exit 125; }',
    "here=$PWD; r=/mnt",
    `'${mount}' -t tmpfs -o mode=755 box-root "$r" || fail root`,
    // Recursive: a plain bind of a folder with a mount under it (WSL's /usr/lib/wsl) is refused in a user namespace.
    `for d in usr etc; do '${mkdir}' "$r/$d" && '${mount}' --rbind "/$d" "$r/$d" || fail "$d"; done`,
    `for d in bin sbin lib lib32 lib64 libx32; do if [ -L "/$d" ]; then '${ln}' -s "$('${readlink}' "/$d")" "$r/$d" || fail "$d"; elif [ -d "/$d" ]; then '${mkdir}' "$r/$d" && '${mount}' --rbind "/$d" "$r/$d" || fail "$d"; fi; done`,
    `'${mkdir}' "$r/dev" "$r/proc" "$r/tmp" "$r/.old" || fail dirs`,
    // A /dev of its own: the machine's character devices a run reads or writes, bound one by one, and no /dev/shm.
    "'" + mount + "' -t tmpfs -o mode=755 box-dev \"$r/dev\" || fail dev",
    // No tty: a run has no terminal, and the machine's /dev/tty would be the developer's (cycle 29's review).
    `for n in null zero full random urandom; do '${touch}' "$r/dev/$n" && '${mount}' --bind "/dev/$n" "$r/dev/$n" || fail "dev $n"; done`,
    `'${ln}' -s /proc/self/fd "$r/dev/fd" && '${ln}' -s /proc/self/fd/0 "$r/dev/stdin" && '${ln}' -s /proc/self/fd/1 "$r/dev/stdout" && '${ln}' -s /proc/self/fd/2 "$r/dev/stderr" || fail "dev links"`,
    `'${mount}' -t proc proc "$r/proc" && '${mount}' -t tmpfs -o mode=1777 box-tmp "$r/tmp" || fail mounts`,
    `while [ "$#" -gt 0 ] && [ "$1" != -- ]; do '${mkdir}' -p "$r$1" && '${mount}' --rbind "$1" "$r$1" || fail "keep $1"; shift; done; shift`,
    `cd "$r" && '${pivot}' . .old && cd / && '${umount}' -l /.old && '${rmdir}' /.old || fail pivot`,
    'cd "$here" 2>/dev/null || cd /',
    `unset BOX_TOP; set -m; "$@" & wait "$!"; s=$?; while :; do n=0; for p in /proc/[0-9]*; do n=$((n + 1)); done; [ "$n" -le 1 ] && exit "$s"; '${sleep}' 0.02; done`,
  ].join("\n");
}
/**
 * What goes before a command run in the namespace: unshare, its options, the namespace's PID 1 and its name; then the
 * folders the run keeps, `--` and the command (`fencedArgv`). @param {string} unshare
 */
export function namespaceArgv(unshare) {
  const bash = existsSync("/bin/bash") ? "/bin/bash" : (machineProgram("bash") ?? "bash");
  // setsid: PID 1 leads a session of its own, with no controlling terminal; it is no group leader, so setsid does not
  // fork, and PID 1 stays itself.
  return [unshare, ...UNSHARE_ARGS, sbin("setsid"), "--wait", bash, "--posix", "-c", init(), "box-init"];
}

/**
 * The boundary every run goes through, from what the machine says: `{ name, argv }`, argv put before the box's bash.
 * @param {{ platform: string, sandboxExec?: boolean, refused?: number | null, pidNs?: string | null, engineFile?: boolean, unshare?: string | null }} m
 *   `refused`: the exit of the check run in the sandbox or the namespace (`fenceExit`), 0 when its signal to the
 *   outside sleeper was refused; `unshare`: the program's path, null where it is missing
 */
export function pickFence(m) {
  if (m.platform === "darwin") {
    if (!m.sandboxExec) throw new Error(`this harness needs ${SANDBOX_EXEC}: without it a text past the check can signal any process`);
    if (m.refused !== 0) throw new Error(`a signal left the sandbox, or it did not start (exit ${m.refused}): the box runs nothing`);
    return { name: "sandbox", argv: [SANDBOX_EXEC, "-p", PROFILE] };
  }
  if (m.platform === "linux") {
    if (m.pidNs && m.pidNs !== FIRST_PID_NS && m.engineFile) return { name: "container", argv: [] };
    if (m.unshare && m.refused === 0) return { name: "namespace", argv: namespaceArgv(m.unshare) };
    const container = `no container (PID namespace ${m.pidNs ?? "unread"}, ${m.engineFile ? "an" : "no"} engine file)`;
    const namespace = m.unshare ? `no PID namespace of its own (${m.unshare}: the check's exit ${m.refused})` : "no unshare for a PID namespace";
    throw new Error(`no boundary keeps a signal in the box on linux here: ${container}, ${namespace}: the box runs nothing`);
  }
  throw new Error(`no boundary keeps a signal in the box on ${m.platform} here (a container or a PID namespace on Linux, sandbox-exec on macOS): the box runs nothing`);
}

/**
 * The exit of the check a fence is held to: 0 when, from inside, a signal 0 to the shell itself goes and one to `pid`
 * (a process outside, alive) is refused: in the sandbox as not permitted, a process that is gone answering otherwise;
 * in the namespace as no such process, which a process that is gone answers too, so `fenceExit` asks the sleeper
 * before and after; there `outside`, a file made outside, must not be seen either (9). It runs with no exported shell
 * function and no startup file (BASH_ENV, ENV), as the box's runs do.
 * @param {number | undefined} pid @param {"sandbox" | "namespace"} [fence]
 * @param {string[]} [argv] what runs the check's shell: the fence's own program by default, nothing for none
 * @param {string} [outside]
 */
export function refusedExit(pid, fence = "sandbox", argv = fence === "sandbox" ? [SANDBOX_EXEC, "-p", PROFILE] : [...namespaceArgv(unshareAt() ?? "unshare"), "--"], outside) {
  const refusal = fence === "sandbox" ? "not permitted" : "No such process";
  const seen = outside === undefined ? "" : `[ -e '${outside}' ] && exit 9; `;
  // A sleeper that did not start leaves nothing to refuse: that reads as not fenced, never as fenced.
  const check = pid === undefined ? "exit 5" : `kill -0 $$ || exit 4; out=$(kill -0 ${pid} 2>&1) && exit 3; case "$out" in *"${refusal}"*) ${seen}exit 0;; esac; exit 6`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BASH_FUNC_") && k !== "BASH_ENV" && k !== "ENV")), LC_ALL: "C" };
  // The namespace's check runs in bash, the shell the box runs, which an exported function reaches.
  const shell = fence === "namespace" && existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const [program, ...args] = [...argv, shell, "-c", check];
  return spawnSync(program, args, { env, stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" }).status;
}

/**
 * Whether a process this harness started is still there: a signal 0 from here, and on Linux its state. A child that
 * ended and node has not reaped yet (the check runs synchronously) still answers a signal 0, as a zombie.
 * @param {number | undefined} pid
 */
function alive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return !existsSync("/proc/self/stat");
  }
}

/**
 * The check's exit against `pid`, a sleeper the caller started outside: 5 when it is not there before, 7 when it is
 * gone after, so a refusal is read only from a live process.
 * @param {"sandbox" | "namespace"} fence @param {number | undefined} pid @param {string[]} [argv]
 */
export function fenceExit(fence, pid, argv) {
  if (!alive(pid)) return 5;
  const dir = fence === "namespace" ? realpathSync(mkdtempSync(join(tmpdir(), "en-fence-"))) : undefined;
  try {
    const status = refusedExit(pid, fence, argv ?? (fence === "namespace" ? [...namespaceArgv(unshareAt() ?? "unshare"), "--"] : undefined), dir);
    return alive(pid) ? status : 7;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** A sleeper of the harness's own, outside any fence, for a check to signal (0 only); stopped after. */
function withSleeper(/** @type {(pid: number | undefined) => number | null} */ check) {
  const outside = spawn(["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p)) ?? "sleep", ["30"], { stdio: "ignore" });
  outside.on("error", () => {});
  try {
    return check(outside.pid);
  } finally {
    outside.kill();
  }
}

/** What pickFence reads, read on this machine; each check sends signal 0 only, to a sleeper it started. */
function fenceReadings() {
  const m = { platform: process.platform, sandboxExec: false, refused: /** @type {number | null} */ (null), pidNs: /** @type {string | null} */ (null), engineFile: false, unshare: /** @type {string | null} */ (null) };
  if (m.platform === "darwin") {
    m.sandboxExec = existsSync(SANDBOX_EXEC);
    if (m.sandboxExec) m.refused = withSleeper((pid) => fenceExit("sandbox", pid));
  } else if (m.platform === "linux") {
    try {
      m.pidNs = readlinkSync("/proc/self/ns/pid");
    } catch {}
    m.engineFile = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
    // Outside a container only: in one the container is the boundary, and its seccomp profile refuses the namespace.
    if (!(m.pidNs && m.pidNs !== FIRST_PID_NS && m.engineFile)) {
      m.unshare = unshareAt();
      if (m.unshare) m.refused = withSleeper((pid) => fenceExit("namespace", pid));
    }
  }
  return m;
}

/** @type {{ name: string, argv: string[] } | undefined} */
let picked;
/**
 * The boundary, picked and checked once a process. `ENNYN_SHELL_BOX=none` makes it throw, as a machine with no
 * boundary does: a test proves with it that every test of the box ends when the box throws.
 */
const theFence = () => {
  if (process.env.ENNYN_SHELL_BOX === "none") throw new Error("no boundary keeps a signal in the box: ENNYN_SHELL_BOX=none, the box runs nothing");
  return (picked ??= pickFence(fenceReadings()));
};

/**
 * A run's result, or a throw when the namespace's PID 1 could not build the root: its exit 125 with its own line, so a
 * text's own exit 125 reads as the text's. @template {{ status: number | null, stderr?: string | Buffer | null }} R @param {R} r
 */
function rootBuilt(r) {
  if (r.status === 125 && /^box-init: /m.test(String(r.stderr ?? ""))) throw new Error(`the namespace's root was not built: ${String(r.stderr).trim()}`);
  return r;
}

/** The boundary's name: `sandbox`, `container` or `namespace`. Throws where none holds, as the box does. */
export const fenceName = () => theFence().name;

/** The folders the namespace's root holds of the machine's (`init`), each with its slash. */
const ROOT_HOLDS = ["/usr/", "/etc/", "/bin/", "/sbin/", "/lib/", "/lib32/", "/lib64/", "/libx32/"];
/**
 * Whether a run inside the boundary finds the machine's program at `path`: always, but in the namespace, whose root
 * holds only /usr, /etc and the /bin and /lib folders (a Homebrew, ~/.local/bin or /opt program is not there).
 * @param {string} path
 */
export function inRoot(path) {
  if (theFence().name !== "namespace") return true;
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return ROOT_HOLDS.some((p) => real.startsWith(p));
}

/**
 * A command put inside the box's boundary: the fence's program first, then `argv`; in the namespace the folders kept
 * and `--` come between. Throws where no boundary holds, as the box does. @param {string[]} argv @param {string[]} [keep]
 */
export function fencedArgv(argv, keep = []) {
  const fence = theFence();
  return fence.name === "namespace" ? [...fence.argv, ...keep, "--", ...argv] : [...fence.argv, ...argv];
}

/**
 * A test's own command run inside the box's boundary, with a time limit that holds there: SIGKILL, as unshare ignores
 * SIGTERM. `keep`: the folders the command needs, kept at their paths in the namespace's root (only there is any
 * folder hidden). Throws where no boundary holds, as the box does.
 * @param {string[]} argv
 * @param {{ keep?: string[], limit?: number } & import("node:child_process").SpawnSyncOptionsWithStringEncoding} options
 */
export function inFence(argv, { keep = [], limit = 10000, ...options }) {
  const [program, ...args] = fencedArgv(argv, keep);
  // No exported shell function: the namespace's PID 1 is a bash too.
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([k]) => !k.startsWith("BASH_FUNC_")));
  // A session of its own, as the box's runs: no controlling terminal of the caller's.
  return rootBuilt(spawnSync(program, args, { ...options, env, timeout: limit, killSignal: "SIGKILL", detached: true }));
}

/** A word separator and a line end no generated text holds. */
export const UNIT = "\u001f";

/**
 * @param {string} prefix temporary folder prefix
 * @param {{ stands: Record<string, string>, real: string[], limit?: number }} programs `stands`: each stand-in's name and
 *   the shell lines it runs after writing its words (`$LOG`, `$BOX` set); `real`: programs run as the machine's own;
 *   `limit`: a run's time limit in milliseconds, 10,000 by default
 */
export function shellBox(prefix, { stands, real, limit = 10000 }) {
  const bash = existsSync("/bin/bash") ? "/bin/bash" : machineProgram("bash");
  if (!bash || !existsSync("/bin/sh")) throw new Error("this harness needs bash and /bin/sh");
  if (!inRoot(bash)) throw new Error(`this harness needs bash: ${bash} is in no folder the namespace's root holds (/usr, /etc, /bin, /lib)`);
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
    // A program the run would not find inside fails the run with 127 and nothing said: refused here, by name.
    if (!inRoot(at)) throw new Error(`this harness needs ${name}: ${at} is in no folder the namespace's root holds (/usr, /etc, /bin, /lib)`);
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
  const command = fencedArgv([join(bin, "bash")], [box]);
  /** @param {string} text */
  // SIGKILL at the limit: unshare ignores SIGTERM, and its death takes the namespace's processes with it.
  const inside = (text) => spawnSync(command[0], [...command.slice(1), "-c", text], { cwd, env, input: "", encoding: "utf8", timeout: limit, killSignal: "SIGKILL", detached: true });
  return {
    box,
    cwd,
    /** The boundary the runs are in: `sandbox`, `container` or `namespace`. */
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
      rootBuilt(r);
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
