/**
 * A node --test reporter for test/run.mjs: what each test file's process told of its run, written as JSON once the
 * run is over. node --test passes a file whose process exits 0 whatever number of tests it reported, so a process
 * that ends before its tests do reads as green with fewer tests: a process.exit(0) in a test or in code it loads, or
 * --test-force-exit, which leaves the end of the file's report in its stdout pipe (cycle 44, node:22 and node:22.0.0
 * containers: test/ci.test.mjs reported 26 to 58 of its 80 tests at exit 0).
 *
 * Where Node sends it (measured: 22.12.0, 22.23.5, 24.22.1 and macOS 22.23.4; not 22.0.0, 22.3, 22.6, 22.9; 22.10
 * and 22.11 unmeasured), a file's process sends a summary of its own last, once every test it registered has ended,
 * so a process that ends early, before or after it registers its tests, or a report cut in the pipe, has none; tests
 * a shared helper registers for a file, which node names by the helper's path, count in that file's summary. A
 * --test-force-exit run that ends after a top-level await, before the rest of its tests are registered, still sends
 * one, counting only the early tests (no runner passes the flag, only a hand run can). A run where no summary came,
 * not even the run's own, is read by its tests instead: each top-level test queued, by the file node names it with,
 * must end, and node passes a file itself only when it reported no test. That reading cannot see a process that ends
 * before it registers the rest of its tests: test/hermetic.mjs, loaded into each file's process, fails that process
 * itself when it ends at exit 0 before the file finished loading, or by an explicit exit before node's run in it
 * ended, on every Node. Still unseen there: a file whose own exit listener sets the code back to 0, a process whose
 * loop drains with a test still to register (an unref'd timer), and under --test-force-exit an explicit exit once the
 * file has loaded. Loaded in the node --test process itself: Node's modules only.
 */

import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

/** @typedef {{ tests: number, topLevel: number }} Counts */
/**
 * @typedef {{ name: string, summary: Counts | null, bare: boolean }} FileTally a file the run started, its process's summary,
 * and whether node passed the file itself: it does so only when the file reported no test.
 */
/** @typedef {{ name: string, queued: string[], ended: string[] }} PathTally the top-level tests node names with one path */

/**
 * @param {AsyncIterable<{ type: string, data: { nesting?: number, name?: string, file?: string, counts?: { tests?: unknown, topLevel?: unknown } } }>} source
 * @returns {AsyncGenerator<string>}
 */
export default async function* tally(source) {
  /** @type {Map<string, string>} */
  const real = new Map();
  // One file can come as two spellings: the path node --test was given, and the one a link leads to.
  const key = (/** @type {string} */ path) => {
    let k = real.get(path);
    if (k === undefined) {
      try {
        k = realpathSync(path);
      } catch {
        k = path;
      }
      real.set(path, k);
    }
    return k;
  };
  /** @type {Record<string, FileTally>} */
  const files = {};
  /** @type {Record<string, PathTally>} */
  const paths = {};
  /** @type {Map<string, Counts>} */
  const summaries = new Map();
  let summaried = false;
  for await (const { type, data } of source) {
    if (type === "test:summary") {
      summaried = true;
      // A file's process's own, named by the file it ran; the whole run's names none.
      if (typeof data?.file === "string") summaries.set(key(data.file), { tests: Number(data.counts?.tests), topLevel: Number(data.counts?.topLevel) });
      continue;
    }
    if (data?.nesting !== 0 || typeof data.file !== "string" || typeof data.name !== "string") continue;
    const k = key(data.file);
    // node --test's own test for each file it starts, named by the path it was given.
    if (resolve(data.name) === data.file) {
      if (type === "test:enqueue") files[k] ??= { name: data.name, summary: null, bare: false };
      else if (type === "test:pass" && files[k]) files[k].bare = true;
      continue;
    }
    const entry = (paths[k] ??= { name: relative(process.cwd(), data.file), queued: [], ended: [] });
    if (type === "test:enqueue") entry.queued.push(data.name);
    else if (type === "test:pass" || type === "test:fail") entry.ended.push(data.name);
  }
  for (const [k, entry] of Object.entries(files)) entry.summary = summaries.get(k) ?? null;
  yield `${JSON.stringify({ version: 2, summaries: summaried, files, paths })}\n`;
}
