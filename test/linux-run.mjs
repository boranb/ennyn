/**
 * `npm run test:linux`: the suite on Linux as a push sends it (HEAD's history, cloned from a bundle inside
 * each container), first at the floors, then on newer Node majors. The floor image is Ubuntu 22.04 with its
 * own git, which must be GIT_FLOOR, and the Node at the floor of package.json's engines; the newer majors are
 * their official images. A run passes only with a summary of no failed and no skipped tests, the versions it
 * names, exit 0, and as many tests as the other runs: a floor nobody runs, or one that skips what only it
 * can show, cannot pass. Needs docker. It runs before a release (CI starts no job while the repository is private), and the CI
 * workflow runs this same script. test/engines.test.mjs ties it to package.json, the workflow and the READMEs.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_FLOOR, parseVersion } from "../core/git.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Node majors run after the floor. */
export const NEWER = ["22", "24"];

/** The floor image's base: its git is GIT_FLOOR (Ubuntu 22.04 ships 2.34.1). */
export const FLOOR_BASE = "ubuntu:22.04";

/**
 * Every image the run pulls, by the digest of its index as Docker Hub served it on 2026-10-24: a tag can be
 * moved to other contents, a digest cannot. A newer major therefore stays on the release it had that day until
 * the digest is changed here. A floor or major with no digest stops the run (test/engines.test.mjs checks the
 * list); a new digest is read with `docker buildx imagetools inspect <image>`.
 */
export const DIGESTS = Object.freeze({
  "node:20.0.0": "sha256:942fa0013e9adfbde06ad07433bdb0a67cc2ac0d5a3db38f12a9c8f710b41f1c",
  "ubuntu:22.04": "sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956",
  "node:22": "sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384",
  "node:24": "sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
});

/**
 * An image named with its digest: "node:22@sha256:…". One with no digest throws.
 * @param {string} image
 */
export function pinned(image) {
  const digest = /** @type {Record<string, string>} */ (DIGESTS)[image];
  if (!digest) throw new Error(`${image} has no digest in test/linux-run.mjs DIGESTS, so the run would pull whatever the tag names today`);
  return `${image}@${digest}`;
}

/**
 * The floor of a ">=X[.Y[.Z]]" range, written in full ("20.0.0": "20" would install the newest 20.x); null for
 * any other form, which has no single floor to run.
 * @param {string} range
 */
export function nodeFloor(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  return m ? [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number).join(".") : null;
}

/**
 * The floor image: the base with its own git, and the floor Node copied from that version's official image.
 * tzdata: without it git reads the hostile machine's far time zone as UTC, and Node does not.
 * @param {string} node
 */
export function floorDockerfile(node) {
  return `FROM ${pinned(`node:${node}`)} AS node
FROM ${pinned(FLOOR_BASE)}
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git tzdata openssh-client ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && useradd -m -u 1000 node
USER node
`;
}

/**
 * The runs, floor first: the image, the user, and the Node and git each must report (git only for the floor).
 * @param {string} floor
 * @returns {{ image: string, node: string, git: string | null, build?: string }[]}
 */
export function runs(floor) {
  return [
    { image: `ennyn-linux-floor:${floor}`, node: floor, git: GIT_FLOOR, build: floorDockerfile(floor) },
    ...NEWER.map((major) => ({ image: pinned(`node:${major}`), node: major, git: null })),
  ];
}

/**
 * Whether a reported version is the one named: equal in every part the name gives ("22" is any 22.x).
 * @param {string} reported @param {string} named
 */
export function versionIs(reported, named) {
  const r = parseVersion(reported.replace(/^v/, ""));
  const n = named.split(".").map(Number);
  return r !== null && n.every((part, i) => r[i] === part);
}

/**
 * A count from the test runner's own summary: the last "# pass 284" (TAP: Node 20 and 22 when not on a
 * terminal) or "ℹ pass 284" (spec: Node 24) at the start of a line. An indented one belongs to output a
 * failing test quotes. undefined when there is none.
 * @param {string} out @param {string} key
 */
export function summaryCount(out, key) {
  return [...out.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, "gm"))].at(-1)?.[1];
}

/**
 * The verdict on one container's run: it passes only with a summary of no failed and no skipped tests (a
 * skipped test shows nothing on the floor that may need it), the Node and git it names, and exit 0.
 * @param {{ out: string, status: number | null, signal?: string | null, node: string, git: string | null }} run
 * @returns {{ ok: boolean, label: string, wrong: string[], tests: string | undefined, pass: string | undefined }}
 */
export function judgeRun({ out, status, signal = null, node, git }) {
  const versions = /^versions: (v\S+) git version (\S+)/m.exec(out);
  const count = (/** @type {string} */ key) => summaryCount(out, key);
  /** @type {string[]} */
  const wrong = [];
  if (count("pass") === undefined) wrong.push("no test summary in the output");
  else {
    if (count("fail") !== "0") wrong.push(`${count("fail") ?? "an unknown number of"} failed`);
    if (count("skipped") !== "0") wrong.push(`${count("skipped") ?? "an unknown number of"} skipped`);
  }
  if (!versions) wrong.push("the container did not say its versions");
  else {
    if (!versionIs(versions[1], node)) wrong.push(`Node ${versions[1]} is not ${node}`);
    if (git && !versionIs(versions[2], git)) wrong.push(`git ${versions[2]} is not ${git}`);
  }
  if (status !== 0) wrong.push(`exit ${status ?? signal}`);
  const label = versions ? `node ${versions[1]} · git ${versions[2]}` : `Node ${node}`;
  return { ok: wrong.length === 0, label, wrong, tests: count("tests"), pass: count("pass") };
}

/**
 * What to show of a failed run: each failing test with the lines that say why (TAP), or the end of the output.
 * @param {string} out
 */
export function failureDetails(out) {
  const lines = out.split("\n");
  /** @type {string[]} */
  const shown = [];
  const indent = (/** @type {string} */ l) => /^\s*/.exec(l)?.[0].length ?? 0;
  lines.forEach((line, i) => {
    // At any depth: a test inside a describe says why above the suite's "1 subtest failed".
    if (!/^\s*not ok /.test(line)) return;
    // The test's own block is indented under it.
    const end = lines.findIndex((l, j) => j > i && indent(l) <= indent(line));
    shown.push(...lines.slice(i, Math.min(end === -1 ? lines.length : end, i + 30)));
  });
  return (shown.length ? shown : lines.slice(-30)).filter((l) => l.trim());
}

/** @param {string[]} args @param {{ input?: string | Buffer, cwd?: string }} [opts] */
function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** Inside each container: clone the bundle from stdin, say the versions, run the suite. */
const IN_CONTAINER = [
  "set -e",
  "cat > /tmp/head.bundle",
  "git -c advice.detachedHead=false clone -q /tmp/head.bundle /tmp/ennyn",
  "cd /tmp/ennyn",
  'echo "versions: $(node --version) $(git --version)"',
  "npm test",
].join("\n");

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const floor = nodeFloor(pkg.engines?.node ?? "");
  if (!floor) {
    console.error(`package.json engines.node "${pkg.engines?.node}" has no single floor (">=X[.Y[.Z]]")`);
    return 2;
  }
  const up = docker(["version", "--format", "{{.Server.Version}}"]);
  if (up.error || up.status !== 0) {
    console.error(`docker is not running, so nothing was tested: ${(up.stderr || up.error?.message || "").trim().split("\n")[0]}`);
    return 2;
  }
  // No index refresh: a commit running in the same tree must not meet this run's lock.
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (dirty.status !== 0) {
    console.error(`git status failed: ${dirty.stderr.trim()}`);
    return 2;
  }
  if (dirty.stdout.trim()) console.log("note: changes that are not committed are not tested; this runs HEAD, as a push sends it");

  const tmp = mkdtempSync(join(tmpdir(), "ennyn-linux-"));
  try {
    const bundle = join(tmp, "head.bundle");
    const made = spawnSync("git", ["bundle", "create", bundle, "HEAD"], { cwd: ROOT, encoding: "utf8" });
    if (made.status !== 0) {
      console.error(`git bundle failed: ${made.stderr.trim()}`);
      return 2;
    }
    const input = readFileSync(bundle);
    let failed = 0;
    /** @type {Set<string>} */
    const totals = new Set();
    for (const run of runs(floor)) {
      if (run.build) {
        const built = docker(["build", "-q", "-t", run.image, "-"], { input: run.build });
        if (built.status !== 0) {
          console.error(`${run.image}: the image did not build: ${built.stderr.trim().split("\n").slice(-3).join(" ")}`);
          failed++;
          continue;
        }
      }
      const r = docker(["run", "--rm", "-i", "--user", "node", run.image, "sh", "-c", IN_CONTAINER], { input });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const verdict = judgeRun({ out, status: r.error ? null : r.status, signal: r.signal ?? r.error?.message ?? null, node: run.node, git: run.git });
      if (verdict.tests) totals.add(verdict.tests);
      if (verdict.ok) console.log(`✓ ${verdict.label}: ${verdict.pass}/${verdict.tests}`);
      else {
        failed++;
        console.log(`✗ ${verdict.label}: ${verdict.wrong.join("; ")}; ${verdict.pass ?? "?"}/${verdict.tests ?? "?"} passed`);
        for (const line of failureDetails(out)) console.log(`  ${line}`);
      }
    }
    // The same commit everywhere: a run with fewer tests did not run them all.
    if (totals.size > 1) {
      failed++;
      console.log(`✗ the runs ran different numbers of tests: ${[...totals].join(", ")}`);
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Run as a script, also through a link (macOS: /tmp is /private/tmp, where import.meta.url is the real path).
const invoked = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = main();
