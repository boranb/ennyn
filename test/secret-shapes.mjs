/**
 * Secret shapes for the tests, made when a test runs: no line of this repository holds one, so its own
 * commit-msg hook and GitHub's push protection have nothing to refuse here (test/hygiene.test.mjs scans for
 * them). The random parts come from a seeded generator, the same on every run.
 */

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
export const B62 = UPPER + LOWER + DIGITS;
export const B64 = B62 + "+/";
export const B64URL = B62 + "-_";
export const UPPER_DIGITS = UPPER + DIGITS;
export const HEX = DIGITS + "abcdef";

/**
 * `n` characters of `alphabet`, from a small xorshift seeded with `seed`.
 * @param {number} n @param {string} [alphabet] @param {number} [seed]
 */
export function rand(n, alphabet = B62, seed = 7) {
  let x = (seed * 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

/** Prefixes, in parts: written whole they would be the shapes themselves to a reader of this file. */
const P = {
  ghp: "gh" + "p_",
  gho: "gh" + "o_",
  ghu: "gh" + "u_",
  ghs: "gh" + "s_",
  ghr: "gh" + "r_",
  pat: "github" + "_pat_",
  glpat: "gl" + "pat-",
  npm: "np" + "m_",
  xoxb: "xo" + "xb-",
  xoxp: "xo" + "xp-",
  sk: "sk" + "_live_",
  rk: "rk" + "_live_",
  ant: "sk-" + "ant-api03-",
  antAdmin: "sk-" + "ant-admin01-",
  xoxe: "xo" + "xe",
  pypi: "py" + "pi-",
  akia: "AK" + "IA",
  asia: "AS" + "IA",
  begin: "-----" + "BEGIN ",
};

/** One of each kind the hook refuses, with the kind it is reported as. */
export const TOKENS = {
  github: P.ghp + rand(36, B62, 1),
  githubOauth: P.gho + rand(36, B62, 2),
  githubUser: P.ghu + rand(36, B62, 3),
  githubServer: P.ghs + rand(36, B62, 4),
  githubRefresh: P.ghr + rand(36, B62, 5),
  githubStateless: `${P.ghs}1234567_eyJ${rand(30, B64URL, 6)}.${rand(80, B64URL, 7)}.${rand(43, B64URL, 8)}`,
  githubJwt: `${P.ghs}eyJ${rand(60, B64URL, 30)}.${rand(300, B64URL, 31)}.${rand(150, B64URL, 32)}`,
  githubFine: `${P.pat}${rand(22, B62, 9)}_${rand(59, B62, 10)}`,
  gitlab: P.glpat + rand(20, B64URL, 11),
  gitlabRoutable: `${P.glpat}${rand(52, B64URL, 12)}.01.${rand(9, LOWER + DIGITS, 13)}`,
  npm: P.npm + rand(36, B62, 14),
  slackBot: `${P.xoxb}${rand(11, DIGITS, 15)}-${rand(13, DIGITS, 16)}-${rand(24, B62, 17)}`,
  slackUser: `${P.xoxp}${rand(11, DIGITS, 18)}-${rand(11, DIGITS, 19)}-${rand(13, DIGITS, 20)}-${rand(32, HEX, 21)}`,
  stripe: P.sk + rand(24, B62, 22),
  stripeRestricted: P.rk + rand(99, B62, 23),
  anthropic: `${P.ant}${rand(86, B64URL, 24)}-${rand(6, B64URL, 25)}AA`,
  anthropicAdmin: `${P.antAdmin}${rand(86, B64URL, 33)}-${rand(6, B64URL, 34)}AA`,
  slackRotated: `${P.xoxe}.${P.xoxb}1-${rand(150, UPPER_DIGITS, 35)}`,
  slackRefresh: `${P.xoxe}-1-${rand(140, UPPER_DIGITS, 36)}`,
  pypi: `${P.pypi}AgEIcHlwaS5vcmc${rand(90, B64URL, 26)}`,
  awsId: P.akia + rand(16, UPPER_DIGITS, 27),
  awsTemp: P.asia + rand(16, UPPER_DIGITS, 28),
  awsSecret: rand(40, B64, 29),
};

/** The kind each token is reported as. */
export const KIND = {
  github: "github-token",
  githubOauth: "github-token",
  githubUser: "github-token",
  githubServer: "github-token",
  githubRefresh: "github-token",
  githubStateless: "github-token",
  githubJwt: "github-token",
  githubFine: "github-token",
  gitlab: "gitlab-token",
  gitlabRoutable: "gitlab-token",
  npm: "npm-token",
  slackBot: "slack-token",
  slackUser: "slack-token",
  stripe: "stripe-key",
  stripeRestricted: "stripe-key",
  anthropic: "anthropic-key",
  anthropicAdmin: "anthropic-key",
  slackRotated: "slack-token",
  slackRefresh: "slack-token",
  pypi: "pypi-token",
  awsId: "aws-access-key-id",
  awsTemp: "aws-access-key-id",
  awsSecret: "aws-secret-access-key",
};

/** A PEM header (`label`: "PRIVATE KEY", "RSA PRIVATE KEY", "PGP PUBLIC KEY BLOCK"…) and its footer. */
export const pem = (/** @type {string} */ label) => ({ begin: `${P.begin}${label}-----`, end: `-----END ${label}-----` });

/** Base64 lines of a key body, 64 characters each. @param {number} n @param {number} [seed] */
export const body = (n, seed = 31) => Array.from({ length: n }, (_, i) => rand(64, B64, seed + i));

/** Prefixes for the accept corpus (placeholders, documented examples), in parts like the rest. */
export const PREFIX = P;
