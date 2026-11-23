/**
 * The one config a commit is checked under, and whether the commit loosens a gate.
 *
 * A gate reads the commit's own config: the index GIT_INDEX_FILE names, so `git commit -a`, `git commit <path>` and an
 * index outside the git dir read what they will commit. The work tree's config never sets a gate there, so an edit that
 * is never staged, or hidden with `--skip-worktree`, loosens nothing; when it differs the hook says so. `doctor` and
 * `ennyn deps` still read the work tree: they ask what the project holds now, not what a commit brings.
 *
 * A commit that loosens a gate is refused unless its message carries LOOSENING_LINE naming each key loosened. This
 * is a tripwire and a record, not a boundary: a local hook cannot tell the user from an agent, and whoever can run
 * `git commit --no-verify` (`no-verify-gap`) or set ENNYN_CONFIG with no tracked config skips it. So `ennyn bypass`
 * also reads each commit's config against its parent's, and a key loosened with no line shows there.
 *
 * Direction is read from the two values alone (MOVES); a key whose direction cannot be decided counts as loosening
 * unless shown tighter, and so does a key added to DEFAULTS and listed nowhere here. Lists compare by exact member,
 * so a glob rewritten to be wider is a member added.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_PATH, ConfigError, DEFAULTS, configFrom, loadConfig } from "../core/config.mjs";
import { blobAt, machineFault, newParents, repoPath, stagedNames, stagedVersions, stagedVersionsEach } from "../core/git.mjs";
import { t } from "../core/i18n.mjs";
import { masked } from "./secrets.mjs";

/** The body line that names the keys the user agreed to loosen; an agent never writes it unasked (skills/cycle/SKILL.md). */
export const LOOSENING_LINE = "User-Approved-Loosening:";

/** @param {string[]} a @param {string[]} b */
const grows = (a, b) => b.some((x) => !a.includes(x));
/** @param {string[]} a @param {string[]} b */
const shrinks = (a, b) => grows(b, a);
/** @param {number} a @param {number} b */
const up = (a, b) => b > a;
/** @param {number} a @param {number} b */
const down = (a, b) => b < a;
const any = () => true;
/** A move of where the graph's provenance rule reads, which loosens only while that rule is on before or after it. @param {unknown} _a @param {unknown} _b @param {any} before @param {any} after */
const provenanceRead = (_a, _b, before, after) => Boolean(before.security.privateText.provenance || after.security.privateText.provenance);

/** @typedef {{ text: string, paths: string[], except?: string[] }} Forbidden */
/** @typedef {{ paths: string[], docs: string[] }} Cochange */

/**
 * Each key a gate reads, and whether a move from one value to another loosens that gate; asked only of two values
 * that differ, with both whole configs for a key whose gate runs only under another key (`provenanceRead`). A rule is matched by its text, so a rule with a new text is a rule gone.
 */
const MOVES = new Map(/** @type {[string, (a: any, b: any, before: any, after: any) => boolean][]} */ ([
  ["commitMsg.types", (a, b) => a.length > 0 && (b.length === 0 || grows(a, b))],
  ["commitMsg.style", (_, b) => b !== "terse"],
  ["commitMsg.subjectMax", up],
  ["commitMsg.bodyMaxLines", up],
  ["commitMsg.bodyMaxChars", up],
  // A prefix added hides prose from the body's limits; one removed takes its lines out of structuredLineMax.
  ["commitMsg.structuredLines", any],
  ["commitMsg.structuredLineMax", up],
  ["commitMsg.skipSubjects", grows],
  ["commitMsg.allowMarker", any],
  ["review.maxRounds", up],
  ["review.roundsLine", any],
  ["review.thirdRoundLine", any],
  ["review.impactLine", any],
  ["review.impactRequiredGlobs", shrinks],
  ["review.impactIgnoreGlobs", grows],
  ["review.cochange", (/** @type {Cochange[]} */ a, /** @type {Cochange[]} */ b) => a.some((r) => !b.some((s) => !shrinks(r.paths, s.paths) && !grows(r.docs, s.docs)))],
  ["review.forbidden", (/** @type {Forbidden[]} */ a, /** @type {Forbidden[]} */ b) => a.some((r) => !b.some((s) => s.text === r.text && !shrinks(r.paths, s.paths) && !grows(r.except ?? [], s.except ?? [])))],
  ["push.warnAtUnpushed", up],
  // The cycle pushes by itself: the user's ask is gone (skills/cycle/push.md).
  ["push.mode", (_, b) => b !== "ask"],
  // A path no glob matches needs only a fast run before a push (push-check).
  ["push.codeGlobs", shrinks],
  // push-check refuses a commit by an address outside the list: one added lets its commits through, none turns it off.
  ["commits.addresses", (a, b) => a.length > 0 && (b.length === 0 || grows(a, b))],
  ["commits.signed", (a, b) => a && !b],
  // The commands whose green run push-check reads (`ennyn test`): a set command changed or taken away; setting one
  // where none was set is not.
  ["commands.fastTest", (a) => typeof a === "string"],
  ["commands.wholeTest", (a) => typeof a === "string"],
  ["security.everyCycles", (a, b) => b === 0 || (a !== 0 && b > a)],
  ["security.ci.paths", shrinks],
  ["security.ci.except", grows],
  ["security.deps.paths", shrinks],
  ["security.deps.cooldownDays", down],
  ["security.deps.minShare", down],
  ["security.deps.minWeekly", down],
  ["security.deps.allow", grows],
  ["security.deps.allowScripts", grows],
  ["security.deps.sources", grows],
  ["security.deps.online", (a, b) => a && !b],
  // What fails to answer in time is said and passes.
  ["security.deps.timeout", down],
  // A key gone asks one host less; a key added or a value changed names who is believed.
  ["security.deps.registries", (a, b) => Object.keys(b).some((k) => !Object.hasOwn(a, k) || a[k] !== b[k])],
  ["security.deps.advisories", any],
  ["security.deps.advisoryRegistries", any],
  ["security.secrets.except", grows],
  ["security.privateText.home", (a, b) => a && !b],
  ["security.privateText.conversation", (a, b) => a && !b],
  ["security.privateText.addresses", (a, b) => a && !b],
  ["security.privateText.provenance", (a, b) => a && !b],
  ["security.privateText.listExpected", (a, b) => a && !b],
  // Where security.privateText reads. The graph and its sources only while provenance is on in either version (a rule
  // on in neither reads them); the state dir, which holds the list of private words, whatever the config says.
  ["paths.graph", provenanceRead],
  ["paths.stateDir", any],
  ["graph.exports.open", provenanceRead],
  ["graph.exports.done", provenanceRead],
  ["graph.exports.declined", provenanceRead],
  ["graph.fields.source", provenanceRead],
]));

/** The keys a gate reads, as MOVES lists them. */
export const GATE_KEYS = [...MOVES.keys()];

/**
 * Keys no gate reads, each by name: changing one moved no verdict through the real hook, and their readers are the
 * planner, the reports and the session hooks. `metrics.*` is what the closing report measures with, no gate. A key in
 * neither this list nor MOVES counts as loosening on any change, and a test fails on it.
 */
const NO_GATE = new Set([
  "language",
  "conversation.style",
  ...["handoff", "metricsLog", "classes", "findings"].map((k) => `paths.${k}`),
  ...["id", "status", "needs", "gate", "value", "cost", "cluster", "mechanization", "since", "reason", "sourceClass"].map((k) => `graph.fields.${k}`),
  "graph.openGateValue",
  "graph.doneStatus",
  "planner.splitAbove",
  "commitMsg.language",
  "commitMsg.fixType",
  "review.agents",
  "sideCopy.roots",
  "sideCopy.maxInjectBytes",
  "compaction.defer",
  "context.afterCycle",
  ...["referenceCommand", "referenceTimeout", "twins", "ceilingRegistry", "fakeGlobs", "fixtureGlobs"].map((k) => `impact.${k}`),
  ...["fixSubject", "excludeRe", "testRe", "minLines", "minShare", "moveSubject"].map((k) => `metrics.${k}`),
]);

/**
 * @param {Record<string, unknown>} o @param {string} [at]
 * @returns {string[]}
 */
const leaves = (o, at = "") =>
  Object.entries(o).flatMap(([k, v]) => {
    const key = at ? `${at}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) && !MOVES.has(key) ? leaves(/** @type {Record<string, unknown>} */ (v), key) : [key];
  });
const KEYS = leaves(DEFAULTS);

/**
 * How a key of the defaults is judged: "gate" has a rule, "none" is read by no gate, "any" is listed nowhere and so
 * counts as loosening on any change.
 * @param {string} key
 * @returns {"gate" | "none" | "any"}
 */
export const gateKeyKind = (key) => (MOVES.has(key) ? "gate" : NO_GATE.has(key) ? "none" : "any");

/** @param {any} cfg @param {string} key */
const valueAt = (cfg, key) => key.split(".").reduce((o, k) => o[k], cfg);

/** A value to compare, a list of strings in any order. @param {unknown} v */
const plain = (v) => JSON.stringify(Array.isArray(v) && v.every((x) => typeof x === "string") ? [...v].sort() : v);

/** Whether two configs hold one value for a key, a list in any order. @param {string} key @param {any} a @param {any} b */
export const sameValue = (key, a, b) => plain(valueAt(a, key)) === plain(valueAt(b, key));

/**
 * The keys that move from `before` to `after` in the direction that loosens their gate.
 * @param {any} before @param {any} after configs as loadConfig gives them, defaults merged
 * @returns {string[]}
 */
export function loosenedKeys(before, after) {
  return KEYS.filter((key) => {
    if (gateKeyKind(key) === "none") return false;
    const [a, b] = [valueAt(before, key), valueAt(after, key)];
    return plain(a) !== plain(b) && (MOVES.get(key) ?? any)(a, b, before, after);
  });
}

/**
 * What the approval lines of a stored message name. After the prefix a line holds keys and separators alone, spaces,
 * tabs and commas: any other word makes it count for nothing, so "the user refused review.forbidden" approves nothing,
 * and neither does a carriage return, which would overprint the line in a raw log and is no separator, so it stands in
 * a word that is no key. The prefix stands at the start of a body line.
 * @param {string} message @param {string[]} [paths] the names of files the commit loosens as a whole
 * @returns {Set<string>}
 */
export function approvedKeys(message, paths = []) {
  return new Set(approvalLines(message).flatMap((l) => (wordsOf(l).every(known(paths)) ? wordsOf(l) : [])));
}

/** What an approval line names. @param {string} line */
const wordsOf = (line) => line.slice(LOOSENING_LINE.length).split(/[ \t,]+/).filter(Boolean);

/** Whether a word of an approval line can stand there. @param {string[]} paths */
const known = (paths) => (/** @type {string} */ w) => KEYS.includes(w) || paths.includes(w);

/** @param {string} message @returns {string[]} */
export const approvalLines = (message) =>
  message
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith(LOOSENING_LINE));

/**
 * The refusal for a commit that loosens `keys` and whose message does not name each of them, and for each approval line
 * that counted for nothing, the word that voided it: a note or a typo on a line the user agreed to would otherwise only
 * repeat "ask them". A fixup!'s message is dropped when it is folded, so no line in it stays on record.
 * @param {string[]} keys @param {string} message as git will store it @param {string} lang
 * @returns {string[]}
 */
export function looseningErrors(keys, message, lang) {
  if (/^fixup! /.test(message)) return [t("shape.looseningFixup", { keys: keys.join(", ") }, lang)];
  const named = approvedKeys(message, keys);
  const left = keys.filter((k) => !named.has(k));
  if (!left.length) return [];
  const voided = approvalLines(message).flatMap((l) => wordsOf(l).find((w) => !known(keys)(w)) ?? []);
  return [t("shape.loosening", { keys: left.join(", "), line: LOOSENING_LINE }, lang), ...voided.map((word) => t("shape.looseningWord", { word: JSON.stringify(word.slice(0, 60)), line: LOOSENING_LINE }, lang))];
}

/**
 * A config's bytes read with everything a file is held to; `error` when they do not load, for whatever reason: a value
 * the validator trips on, or a list deeper than the stack, is a config that does not load like any other. The error is
 * text for the terminal, so it comes masked: a parse error quotes what it read.
 * @param {Buffer} bytes @param {string} cwd @param {string} configPath
 * @returns {{ cfg?: any, error?: string }}
 */
export function loaded(bytes, cwd, configPath) {
  try {
    return { cfg: configFrom(bytes.toString("utf8"), { cwd, configPath }) };
  } catch (e) {
    return { error: masked(String(/** @type {Error} */ (e).message)).replace(/\n+/g, "; ") };
  }
}

/**
 * The config in force at a commit, as the hook reads one: at CONFIG_PATH, else at the path ENNYN_CONFIG names. `rel` is
 * null with neither, the defaults then. One the commit holds as no file, or that does not load, comes with `error`;
 * `wrongType`: its entry names an object that is no blob, so there is no file to judge.
 * @param {string} cwd @param {string} rev @param {string | null} namedRel
 * @returns {{ rel: string | null, cfg?: any, error?: string, wrongType?: boolean }}
 */
export function configAt(cwd, rev, namedRel) {
  for (const rel of namedRel ? [CONFIG_PATH, namedRel] : [CONFIG_PATH]) {
    const bytes = blobAt(cwd, rev, rel);
    if (bytes === null) continue;
    if (bytes === "wrongType") return { rel, error: `${rel} names an object that is no blob`, wrongType: true };
    return { rel, ...(bytes === "other" ? { error: `${rel} is no regular file there` } : loaded(bytes, cwd, join(cwd, rel))) };
  }
  return { rel: null, cfg: configFrom(null, { cwd, configPath: join(cwd, CONFIG_PATH) }) };
}

/** The path inside the repository a name leads to, as git spells it; null outside. @param {string} cwd @param {string} name */
export function inside(cwd, name) {
  const rel = relative(cwd, resolve(cwd, name));
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

/** @typedef {{ key: string, vars: Record<string, string>, fails?: boolean }} Said a line to print; `fails`: what could not be read, which fails a hand run */

/** The commit's config was not read, for a reason no fault of the machine explains: the commit's content may pick it, so it refuses (machineFault). */
export class ConfigPicked extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(String(/** @type {Error} */ (cause)?.message ?? cause));
    this.name = "ConfigPicked";
    this.cause = cause;
  }
}

/** git failed before the commit's config was read, and the file as it stands does not load: neither was read. */
export class ConfigUnread extends ConfigError {
  /** @param {string} git its first line @param {ConfigError} broken */
  constructor(git, broken) {
    super(broken.problems);
    this.name = "ConfigUnread";
    this.git = git;
  }
}

/**
 * What HEAD held in the files a commit deletes that load as a config: the config in force, when the commit renames it
 * and ENNYN_CONFIG names the new place. Nothing else says where it lived. A name that cannot be asked for, or a read
 * that fails, costs that name alone. A name is the commit's to pick and a deletion refuses nothing, so what was not read
 * comes back in `lost` with the rest, for the caller to say: the defaults stay the baseline either way.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @returns {{ cfgs: any[], lost: string | null }}
 */
function deletedConfigs(cwd, env) {
  const { deleted, notUtf8, deletedUnread } = stagedNames(cwd, { env });
  const { versions, unaskable, failed } = stagedVersionsEach(cwd, [...deleted].filter((p) => !notUtf8.includes(p)), { env });
  const first = failed[0]?.error ?? null;
  const lost = first ? String(/** @type {Error & { stderr?: unknown }} */ (first).stderr || /** @type {Error} */ (first).message).trim().split("\n")[0] : unaskable.length || notUtf8.some((p) => deleted.has(p)) || deletedUnread ? "a name git cannot be asked for" : null;
  return { cfgs: [...versions].map(([p, v]) => v.head && loaded(v.head, cwd, join(cwd, p)).cfg).filter(Boolean), lost };
}

/**
 * `keys` less those a parent of the merge in progress already holds: a key is loosened by a merge only when it is looser
 * than every parent, so `git pull` of an approved loosening asks nothing. MERGE_HEAD is a file anyone can write, so only
 * a name git builds on counts (`newParents`): then the commit that loosened stands in history and `ennyn bypass` lists
 * it. A parent that cannot be read, or does not load, takes no key off. CONFIG_PATH as a key is the config taken from
 * its place, so only a parent that holds it at another place takes that off.
 * @param {string} cwd @param {string | null} namedRel @param {any} cfg @param {string[]} keys
 * @returns {string[]}
 */
function pastParents(cwd, namedRel, cfg, keys) {
  if (!keys.length) return keys;
  try {
    const parents = newParents(cwd).map((rev) => configAt(cwd, rev, namedRel));
    return keys.filter((k) => parents.every((p) => !p.cfg || (k === CONFIG_PATH ? p.rel === null || p.rel === CONFIG_PATH : loosenedKeys(p.cfg, cfg).includes(k))));
  } catch {
    return keys;
  }
}

/**
 * The config a commit is checked under, one reading for every key, the language too.
 *
 * Each side reads the config in force there: at its place, else at the path ENNYN_CONFIG names, so a config that moves,
 * or one planted at the default place, compares with what HEAD held. A variable loosens nothing a commit holds: with a
 * config at its place it is said and left out. Tracked nowhere: the file as it stands, the only config there is, said
 * (`configNotInCommit`: no commit will show what it loosens) unless there is none. New at its path, the commit deleting a
 * file that loads as a config: compared with that too, and with the defaults, since a baseline is never better than they
 * are: a decoy the commit deletes launders nothing. That reading of a rename is for a project already moved: a commit
 * that takes the config from the default place counts whole under that path, the content unchanged too, since the next
 * commit with the variable unset finds nothing there and runs the defaults.
 *
 * The commit deletes it: the defaults. It does not load, or is a link, a submodule, too large, or an entry naming an
 * object of another type: HEAD's rules still run, and the whole file counts as loosening under its path, since from
 * there on no gate would run. An object this machine does not hold is no such content: said, and nothing is read. HEAD
 * holds none: compared with the defaults. HEAD's does not load: no baseline, said, so the commit that repairs it is never refused.
 * Neither loads: ConfigError, as for a broken file. A git that fails gives the file as it stands, said: of the choices
 * left it is the one that keeps the gates on, and it is the one place the work tree still sets a gate.
 *
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, hook?: boolean }} opts `hook` false: a git that fails throws
 * @returns {{ cfg: any, headExcept: string[] | null, keys: string[], said: Said[], absent?: boolean }}
 *   `headExcept`: security.secrets.except as HEAD holds it, null with no config there; `keys`: what the commit
 *   loosens; `absent`: ENNYN_CONFIG names no file and nothing is tracked
 * @throws {ConfigError} no version of the config loads; {ConfigUnread} git failed, and the file as it stands does not load;
 *   {ConfigPicked} the read failed in a way no fault of the machine explains
 */
export function commitConfig({ cwd, env = process.env, hook = true }) {
  const asItStands = () => ({ cfg: loadConfig({ cwd, env }), headExcept: null, keys: /** @type {string[]} */ ([]), said: /** @type {Said[]} */ ([]) });
  const named = env.ENNYN_CONFIG || null;
  const namedRel = named ? inside(cwd, named) : null;
  /** @type {Map<string, import("../core/git.mjs").StagedVersion>} */
  let versions = new Map();
  /** @param {(v: import("../core/git.mjs").StagedVersion) => unknown} has @returns {string | null} */
  const place = (has) => [CONFIG_PATH, namedRel].find((p) => p !== null && versions.has(p) && has(/** @type {any} */ (versions.get(p)))) ?? null;
  const onHead = (/** @type {import("../core/git.mjs").StagedVersion} */ v) => v.head || v.headUnread;
  const inCommit = (/** @type {import("../core/git.mjs").StagedVersion} */ v) => v.staged || v.unread;
  /** @type {any[]} */
  let renamed = [];
  /** @type {Said[]} */
  const said = [];
  try {
    if (repoPath("--git-dir", { cwd }) === null) return asItStands();
    try {
      versions = stagedVersions(cwd, [...new Set([CONFIG_PATH, ...(namedRel ? [namedRel] : [])])], { env });
    } catch (e) {
      if (hook && !machineFault(e)) throw new ConfigPicked(e);
      throw e;
    }
    if (place(inCommit) !== null && place(onHead) === null) {
      // Context, as everything a commit deletes: said, and the defaults stay the baseline.
      let lost = null;
      try {
        const gone = deletedConfigs(cwd, env);
        renamed = gone.cfgs;
        lost = gone.lost;
      } catch (e) {
        lost = String(/** @type {Error & { stderr?: unknown }} */ (e).stderr || /** @type {Error} */ (e).message).trim().split("\n")[0];
      }
      if (lost) said.push({ key: "cli.configDeletedUnread", vars: { error: lost }, fails: true });
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof ConfigPicked || !hook) throw e;
    const failure = /** @type {Error & { stderr?: unknown }} */ (e);
    const error = String(failure.stderr || failure.message).trim().split("\n")[0];
    try {
      return { ...asItStands(), said: [{ key: "cli.configUnmeasured", vars: { error } }] };
    } catch (broken) {
      throw broken instanceof ConfigError ? new ConfigUnread(error, broken) : broken;
    }
  }
  const headRel = place(onHead);
  const ownRel = place(inCommit);
  const rel = ownRel ?? headRel;
  if (rel === null) {
    const it = asItStands();
    if (named && !it.cfg.configPath) return { ...it, absent: true };
    return it.cfg.configPath ? { ...it, said: [{ key: "cli.configNotInCommit", vars: { path: named ?? CONFIG_PATH } }] } : it;
  }
  const none = () => ({ cfg: { ...configFrom(null, { cwd, configPath: join(cwd, rel) }), configPath: join(cwd, rel) } });
  const away = headRel === CONFIG_PATH && ownRel !== null && ownRel !== CONFIG_PATH ? [CONFIG_PATH] : [];
  const was = headRel === null ? null : /** @type {import("../core/git.mjs").StagedVersion} */ (versions.get(headRel));
  const now = ownRel === null ? null : /** @type {import("../core/git.mjs").StagedVersion} */ (versions.get(ownRel));
  /** @type {{ cfg?: any, error?: string }} */
  const head = was?.head ? loaded(was.head, cwd, join(cwd, /** @type {string} */ (headRel))) : was?.headUnread ? { error: was.headUnread } : none();
  /** @type {{ cfg?: any, error?: string, unread?: boolean }} */
  const own = now?.staged ? loaded(now.staged, cwd, join(cwd, rel)) : now?.wrongType ? { error: `an object of type ${now.wrongType}` } : now?.unread ? { error: now.unread, unread: now.unread === "notBlob" || now.unread === "unmerged" } : none();
  if (named && rel === CONFIG_PATH && namedRel !== CONFIG_PATH) said.push({ key: "cli.configNamedIgnored", vars: { named, path: rel } });
  if (!head.cfg) said.push({ key: "cli.configHeadUnread", vars: { path: rel, error: String(head.error) }, fails: true });
  const headExcept = (was?.head ? head.cfg : renamed[0])?.security.secrets.except ?? null;
  if (own.cfg) {
    const other = now?.staged ? workTreeLine(cwd, env, rel, own.cfg) : null;
    if (other) said.push({ key: other, vars: { path: rel } });
    const keys = head.cfg ? [...new Set([head.cfg, ...renamed].flatMap((h) => loosenedKeys(h, own.cfg)))] : [];
    return { cfg: own.cfg, headExcept, keys: pastParents(cwd, namedRel, own.cfg, [...keys, ...away]), said };
  }
  if (!head.cfg) throw new ConfigError([`${rel} does not load, here or in HEAD: ${own.error}`]);
  said.push({ key: own.unread ? "cli.configCommitUnread" : "cli.configCommitBroken", vars: { path: rel, error: String(own.error) }, fails: own.unread });
  return { cfg: head.cfg, headExcept, keys: own.unread ? away : [rel], said };
}

/**
 * What to say of the work tree's config against the commit's, by what each sets: spacing is no difference, and null
 * says nothing. Gone, it is another config; one that cannot be read or does not load is said as that.
 * @param {string} cwd @param {NodeJS.ProcessEnv} env @param {string} rel @param {any} cfg
 * @returns {string | null} a catalog key
 */
function workTreeLine(cwd, env, rel, cfg) {
  try {
    const work = loadConfig({ cwd, env: rel === CONFIG_PATH ? { ...env, ENNYN_CONFIG: "" } : env });
    return !work.configPath || JSON.stringify({ ...work, configPath: "" }) !== JSON.stringify({ ...cfg, configPath: "" }) ? "cli.configUnstaged" : null;
  } catch {
    return "cli.configUnstagedUnread";
  }
}
