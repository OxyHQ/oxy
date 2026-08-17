#!/usr/bin/env bun

/**
 * Refuse a commit that carries issued credential material.
 *
 * Nothing in this repository scanned source for secrets before this file: no
 * gitleaks, no trufflehog, no detect-secrets, no CodeQL configuration, no
 * pre-commit hook. The one job named "Security Audit" ran
 * `npm audit --audit-level=high || true`, which is a different question and was
 * answered unconditionally green anyway. Meanwhile `packages/api/.env` was once
 * committed with live JWT secrets in it — the exact shape this refuses.
 *
 * ## WHY NOT GITLEAKS
 *
 * Considered first, and rejected on three counts, none of them about detection
 * quality:
 *
 *   - The maintained action is licensed per organisation for private repos; the
 *     alternative is downloading a release binary in CI, which adds a pinned
 *     version, a checksum and a network dependency to a job whose whole value is
 *     that it is deterministic.
 *   - Its allow-list is a TOML file of regexes and paths. This repository's gate
 *     convention requires an allow-list to carry its own exact-count assertion —
 *     an entry that stops matching must FAIL, so a workaround cannot outlive the
 *     thing it worked around. `.gitleaks.toml` cannot express that.
 *   - Its default rule set fires on high-entropy strings, and this tree is full
 *     of deliberate fixtures: 77 lines assign a credential-shaped name a 20+
 *     character literal, and 50 of those survive every placeholder heuristic
 *     because a test secret like `'secret-only-the-opener-holds'` is meant to
 *     read like a secret. A gate that arrives with 50 findings is turned off.
 *
 * So: a narrower gate that cannot be vacuous, in the shape of the four beside it
 * (`check-lockfile-sync`, `check-deploy-secrets-sync`, `check-migration-phases`,
 * `check-ci-complete`) — a check plus a fixture test that runs before it.
 *
 * ## WHAT IT DETECTS
 *
 * Two things, and both are shapes a fixture does not match by accident:
 *
 *   1. **Issued-token grammars.** A closed list of prefix-and-length shapes that
 *      an issuer mints and nobody types by hand: `sk-…` (OpenAI/Anthropic),
 *      Stripe, AWS access key ids, Google API keys, GitHub tokens and PATs,
 *      Slack, GitLab, npm, a JWT with a real signature, a PEM private key with
 *      an actual body, and Oxy's own `oxy_sk_…` machine credential. Lengths are
 *      set from the real issued shape, which is what keeps the fixtures out: the
 *      longest `sk-` string in this tree is 31 characters after the prefix and a
 *      real OpenAI key is 48.
 *   2. **A tracked dotenv file.** `.env`, `.env.production`, `.env.local` —
 *      anything but the `.example`/`.sample`/`.template` forms. This one is a
 *      PATH rule with no content test, because the file's whole purpose is to
 *      hold values that must not be in git, and it is the only rule that would
 *      have caught the `packages/api/.env` incident.
 *
 * ## WHAT IT DOES NOT DETECT, MEASURED
 *
 * **A home-grown secret assigned to a variable** — `ACCESS_TOKEN_SECRET =
 * '<32 real characters>'` in a script, a workflow or a compose file. The rule for
 * it was written and measured: 77 raw hits on this tree; 8 after excusing
 * placeholder-marked values and values that are an identifier NAMING a secret
 * rather than being one; 50 if the test suites are included. Landing it would
 * have meant either a 50-entry allow-list that the next test file grows, or
 * skipping `__tests__` by path — and a gate that skips what a hand-maintained map
 * omits is not a gate. The residue is therefore named here rather than papered
 * over: this scanner sees issued grammars, not entropy. A secret with no grammar,
 * outside a dotenv file, passes.
 *
 * ## HOW THIS CANNOT PASS VACUOUSLY
 *
 * Every rule carries a `sample` — synthetic material of the right shape — and the
 * run asserts that its own pattern still matches its own sample and that the
 * sample is not excused by the placeholder predicate. That is the positive
 * control, and it runs on every invocation rather than only in the fixture test:
 * a typo in a regex, or a placeholder predicate widened until it excuses
 * everything, turns this red immediately instead of printing a clean zero.
 * Samples are ASSEMBLED at runtime, so no complete token literal exists in this
 * file for the scanner to find in its own source.
 *
 * Two floors sit beside it: the number of files scanned, and the bytes read. A
 * broken `git ls-files` or a listing that stopped resolving reports a clean tree,
 * and those two numbers are the difference between "nothing is there" and
 * "nothing was looked at".
 *
 * ## OUTPUT IS REDACTED
 *
 * A finding prints the file, the line, the column, the rule and the match's
 * LENGTH. Never the match, and never the line it sits on — the line contains the
 * secret. A scanner that prints what it found has published it into the CI log,
 * where it is readable by everyone with access to the run and outlives the commit
 * that is about to be rewritten.
 *
 * Usage:  bun scripts/check-secret-scan.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The tree to scan. Overridable so the fixture test can run the REAL gate. */
const repositoryRoot = process.env.SECRET_SCAN_ROOT
  ? resolve(process.env.SECRET_SCAN_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fixture trees are a handful of files, so the real floors would fail every
 * fixture case for a reason that has nothing to do with secrets. This lowers them
 * to 1; it never removes them, and the per-rule positive control is unaffected.
 */
const fixtureFloors = process.env.SECRET_SCAN_FIXTURE_FLOORS === '1';

/**
 * Synthetic material for the in-run positive control.
 *
 * Deterministic and assembled here rather than written out, so this file
 * contains no complete token literal. The alphabet is walked in a rotation that
 * spells no word, which matters: a sample the placeholder predicate excused
 * would disarm the control it exists to be.
 */
function synthetic(length, alphabet) {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[(index * 7 + 3) % alphabet.length];
  }
  return out;
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The rules. Each pattern runs over the WHOLE file text, not line by line: the
 * PEM rule spans lines, and a line-oriented scan is the classic way a multi-line
 * secret reads as absent. Line and column are derived from the match offset.
 *
 * `sample` is what makes each rule falsifiable on every run — see the header.
 */
const RULES = [
  {
    name: 'openai-family-key',
    what: 'an `sk-…` key (OpenAI, Anthropic and the SDKs that copied the shape)',
    // 40 after the prefix. A legacy OpenAI key is 48, `sk-proj-…` and
    // `sk-ant-api03-…` are longer still, and the longest such string in this
    // tree is 31 — so the floor separates issued keys from fixtures by
    // construction rather than by a name filter.
    pattern: /sk-[A-Za-z0-9_-]{40,}/g,
    sample: `sk-${synthetic(48, LOWER_ALNUM)}`,
  },
  {
    name: 'stripe-key',
    what: 'a Stripe secret, restricted or publishable key',
    pattern: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{24,}/g,
    sample: `sk_live_${synthetic(24, LOWER_ALNUM)}`,
  },
  {
    name: 'aws-access-key-id',
    what: 'an AWS access key id (the half that names the secret half)',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    sample: `AKIA${synthetic(16, UPPER_ALNUM)}`,
  },
  {
    name: 'google-api-key',
    what: 'a Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    sample: `AIza${synthetic(35, BASE64URL)}`,
  },
  {
    name: 'github-token',
    what: 'a GitHub personal, OAuth, user, server or refresh token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
    sample: `ghp_${synthetic(36, LOWER_ALNUM)}`,
  },
  {
    name: 'github-fine-grained-pat',
    what: 'a GitHub fine-grained personal access token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
    sample: `github_pat_${synthetic(60, LOWER_ALNUM)}`,
  },
  {
    name: 'slack-token',
    what: 'a Slack bot, user, app or legacy token',
    pattern: /\bxox[abeprs]-[A-Za-z0-9-]{20,}/g,
    sample: `xoxb-${synthetic(24, LOWER_ALNUM)}`,
  },
  {
    name: 'gitlab-pat',
    what: 'a GitLab personal access token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    sample: `glpat-${synthetic(20, LOWER_ALNUM)}`,
  },
  {
    name: 'npm-token',
    what: 'an npm automation or publish token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    sample: `npm_${synthetic(36, LOWER_ALNUM)}`,
  },
  {
    name: 'signed-jwt',
    what: 'a JWT with a real signature (an unsigned one has an empty third part)',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g,
    sample: `eyJ${synthetic(20, BASE64URL)}.${synthetic(30, BASE64URL)}.${synthetic(43, BASE64URL)}`,
  },
  {
    name: 'oxy-machine-credential',
    what: "Oxy's own `oxy_sk_<16 hex>_<64 hex>` machine bearer token",
    // The exact grammar `utils/machineCredentialToken.ts` mints and parses. The
    // PUBLIC `oxy_dk_…` client id is deliberately NOT a rule: it ships inside
    // mobile bundles and an unauthenticated route serves it, so it appears
    // legitimately in eleven places here and is never a secret.
    pattern: /\boxy_sk_[0-9a-f]{16}_[0-9a-f]{64}\b/g,
    sample: `oxy_sk_${synthetic(16, HEX)}_${synthetic(64, HEX)}`,
  },
  {
    name: 'private-key-body',
    what: 'a PEM private key with an actual body, not a placeholder',
    // Tempered so the body cannot contain `-----`: without that, a file holding
    // two SHORT placeholder blocks (docs/EMAIL.md holds exactly that, 71 lines
    // apart) lets the body length floor be met by the prose BETWEEN them, and
    // the rule reports a leak that is not there.
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----((?:(?!-----)[\s\S]){100,8000})-----END/g,
    sample: `-----BEGIN PRIVATE KEY-----\n${synthetic(200, BASE64URL)}\n-----END PRIVATE KEY-----`,
  },
];

/**
 * A matched value that is inert on its face.
 *
 * The one heuristic here, and it is load-bearing for exactly one rule: an AWS
 * access key id is a FIXED 20 characters, so no length floor can separate
 * `AKIAEXAMPLENOTREAL00` in a contracts test from a real one. For every other
 * rule the length floor already does that work and this predicate is defence in
 * depth.
 *
 * Its failure mode is a false NEGATIVE — a real credential containing one of
 * these substrings is not reported. For CSPRNG material the probability is
 * around 1e-6 per marker; for a HUMAN-chosen secret it is not small at all,
 * which is a further reason the named-assignment rule is not here.
 */
const PLACEHOLDER =
  /(?:example|sample|test|fake|dummy|placeholder|redacted|changeme|your[_-]?|xxx+|not[_-]?a[_-]?real|do[_-]?not[_-]?use)/i;

/**
 * A tracked dotenv file. `.env.example`, `.env.sample` and `.env.template` are
 * the documented forms and are excluded; everything else — `.env`, `.env.local`,
 * `.env.production`, `.env.production.local` — is refused on its path alone.
 *
 * Matched on the BASENAME so a nested `packages/api/.env` is caught, which is
 * the file this rule exists for.
 */
const DOTENV_TRACKED = /^\.env(?:\..+)?$/;
const DOTENV_ALLOWED_SUFFIX = /\.(?:example|sample|template|dist)$/;

/**
 * Deliberate, reasoned survivals — one per (file, rule) pair, with the number of
 * matches expected in that file stated EXACTLY.
 *
 * The exact count is the point. An entry saying "this file has findings" would
 * excuse a second, real key added to the same file later; an entry saying "this
 * file has exactly one" fails when a second appears. The list must also only
 * SHRINK: an entry that matches nothing FAILS the run, so an exception cannot
 * outlive the thing it excused.
 *
 * Nothing here is a live credential, and each entry says why the material is
 * safe rather than merely that it is old.
 */
const ALLOWED_FINDINGS = [
  {
    file: 'packages/api/src/services/__tests__/federation.signedFetch.test.ts',
    rule: 'private-key-body',
    occurrences: 1,
    reason:
      'An RSA key pair generated for the HTTP-signature suite. Signing is the thing under '
      + 'test, so the test needs a real key to sign with; no Oxy or federated system trusts '
      + 'this one, and the public half is fed to the verifier in the same file.',
  },
  {
    file: 'packages/federation/src/__tests__/httpSignature.test.ts',
    rule: 'private-key-body',
    occurrences: 1,
    reason:
      'The same test-only key pair, for the same suite one package down — `@oxyhq/federation` '
      + 'owns the signature primitives and `packages/api` owns the fetch that uses them, and '
      + 'each side signs and verifies independently.',
  },
];

/** Files scanned, and bytes read. Both measured well under today's numbers. */
const MINIMUM_FILES = fixtureFloors ? 1 : 2500;
const MINIMUM_BYTES = fixtureFloors ? 1 : 20 * 1024 * 1024;

/**
 * The fixture test builds one case per rule and one file per allow-list entry, and
 * it has to get both from HERE rather than restating them — a fixture set that
 * restates the rules stops covering the rule added next month, and a restated
 * allow-list proves a synthetic list matches synthetic text.
 *
 * Answered by this same file rather than by a second exported entry point, so
 * there is exactly one code path that CI runs and nothing that can drift from it.
 */
if (process.env.SECRET_SCAN_EMIT_RULES === '1') {
  console.log(
    JSON.stringify({
      rules: RULES.map((rule) => ({ name: rule.name, sample: rule.sample })),
      allowed: ALLOWED_FINDINGS.map((entry) => ({
        file: entry.file,
        rule: entry.rule,
        occurrences: entry.occurrences,
      })),
    }),
  );
  process.exit(0);
}

const problems = [];
const findings = [];

/**
 * Every file git tracks, repo-relative. The index rather than the working tree,
 * so an ignored or generated file cannot be scanned and — more importantly — a
 * secret that is merely present locally is not reported as committed.
 */
function trackedFiles() {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    console.error(`git ls-files failed in ${repositoryRoot}: ${listed.stderr ?? listed.error}`);
    process.exit(1);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

/** Byte offset -> 1-based line and column, from a prefix scan of the text. */
function positionOf(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

// ── The in-run positive control, before anything is scanned ────────────────
//
// Each rule must still match its own sample, and the sample must not be excused.
// A rule that has stopped matching anything cannot report a finding, and an
// absence check that cannot report is indistinguishable from a clean tree.
for (const rule of RULES) {
  rule.pattern.lastIndex = 0;
  const matched = rule.pattern.exec(rule.sample);
  rule.pattern.lastIndex = 0;
  if (matched === null) {
    problems.push(
      `Rule \`${rule.name}\` no longer matches its own sample, so it can never report `
      + `${rule.what}. The pattern is broken; a broken pattern prints a clean zero.`,
    );
    continue;
  }
  if (PLACEHOLDER.test(matched[0])) {
    problems.push(
      `Rule \`${rule.name}\` matches its sample, but the placeholder predicate then excuses `
      + 'it — so the rule is inert. Either the sample accidentally spells a placeholder '
      + 'marker, or PLACEHOLDER has been widened until it excuses real material.',
    );
  }
}

// ── The scan ───────────────────────────────────────────────────────────────
const tracked = trackedFiles();
let filesScanned = 0;
let bytesScanned = 0;
let binaryFiles = 0;

for (const relativePath of tracked) {
  const fullPath = join(repositoryRoot, relativePath);

  // Rule 2: the path alone decides, so it is answered before the file is read —
  // an unreadable `.env` is still a committed `.env`.
  const name = basename(relativePath);
  if (DOTENV_TRACKED.test(name) && !DOTENV_ALLOWED_SUFFIX.test(name)) {
    findings.push({
      file: relativePath,
      line: 0,
      column: 0,
      rule: 'tracked-dotenv-file',
      length: 0,
      detail:
        'A dotenv file is tracked by git. Its purpose is to hold values that must not be '
        + 'committed; the `.example` form is where the KEYS belong.',
    });
    continue;
  }

  let stats;
  try {
    stats = statSync(fullPath);
  } catch {
    // `git ls-files` reports the index, which can name a path the working tree
    // does not have — a half-applied checkout, an interrupted rebase. Loud, not
    // skipped: the unread file is exactly where a secret could sit.
    problems.push(
      `${relativePath} is tracked but could not be stat'd, so this scan was incomplete.`,
    );
    continue;
  }
  if (!stats.isFile()) continue;

  let buffer;
  try {
    buffer = readFileSync(fullPath);
  } catch (error) {
    problems.push(
      `${relativePath} is tracked but could not be read (${error.code ?? error.message}), `
      + 'so this scan was incomplete.',
    );
    continue;
  }

  // A NUL byte makes a present token read as ABSENT to anything that stops at
  // one, and skipping "binary" files leaves a blind spot for free. latin1 maps
  // every byte to a character, so the patterns run over the bytes as they are.
  const isBinary = buffer.includes(0);
  if (isBinary) binaryFiles += 1;
  const text = buffer.toString(isBinary ? 'latin1' : 'utf8');

  filesScanned += 1;
  bytesScanned += buffer.length;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match !== null) {
      if (!PLACEHOLDER.test(match[0])) {
        const { line, column } = positionOf(text, match.index);
        findings.push({
          file: relativePath,
          line,
          column,
          rule: rule.name,
          length: match[0].length,
          detail: rule.what,
        });
      }
      if (match[0].length === 0) break;
      match = rule.pattern.exec(text);
    }
    rule.pattern.lastIndex = 0;
  }
}

// ── The allow-list, with its exact counts ──────────────────────────────────
const observed = new Map();
for (const finding of findings) {
  const key = JSON.stringify([finding.file, finding.rule]);
  observed.set(key, (observed.get(key) ?? 0) + 1);
}

const excusedKeys = new Set();
for (const entry of ALLOWED_FINDINGS) {
  const key = JSON.stringify([entry.file, entry.rule]);
  const count = observed.get(key) ?? 0;
  if (count === 0) {
    problems.push(
      `ALLOWED_FINDINGS still excuses ${entry.rule} in ${entry.file}, which no longer matches `
      + 'anything. The material is gone or the file moved — delete the entry so the list keeps '
      + 'describing the tree.',
    );
    continue;
  }
  if (count !== entry.occurrences) {
    problems.push(
      `ALLOWED_FINDINGS excuses exactly ${entry.occurrences} ${entry.rule} finding(s) in `
      + `${entry.file}, and there are now ${count}. A count that has grown means new material `
      + 'arrived beside the excused material, which the entry says nothing about.',
    );
    continue;
  }
  excusedKeys.add(key);
}

const unexcused = findings.filter(
  (finding) => !excusedKeys.has(JSON.stringify([finding.file, finding.rule])),
);

// ── Vacuity floors ────────────────────────────────────────────────────────
if (filesScanned < MINIMUM_FILES) {
  problems.push(
    `${filesScanned} file(s) scanned is below the ${MINIMUM_FILES} floor. The file listing is `
    + 'probably broken, and a broken listing reports a clean tree.',
  );
}
if (bytesScanned < MINIMUM_BYTES) {
  problems.push(
    `${bytesScanned} byte(s) read is below the ${MINIMUM_BYTES} floor. Files were listed but `
    + 'their contents were not reaching the patterns.',
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────
if (unexcused.length > 0 || problems.length > 0) {
  console.error('Secret scan FAILED:\n');
  for (const finding of unexcused) {
    const where = finding.line === 0 ? finding.file : `${finding.file}:${finding.line}:${finding.column}`;
    const size = finding.length === 0 ? '' : ` [${finding.length} chars, redacted]`;
    console.error(`  ${where}  ${finding.rule}${size}`);
    console.error(`    ${finding.detail}\n`);
  }
  for (const problem of problems) console.error(`  ${problem}\n`);
  if (unexcused.length > 0) {
    console.error(
      '  The match itself is deliberately not printed: a scanner that echoes what it found\n'
      + '  has published it into a CI log that outlives the commit you are about to rewrite.\n'
      + '  Open the file locally at the line above.\n\n'
      + '  ROTATE FIRST, then remove. A secret that reached a remote is compromised even after\n'
      + '  a force-push, because the object survives in forks, caches and clones — removing it\n'
      + '  from history is cleanup, not containment. docs/runbooks/ has the rotation procedure\n'
      + '  for every credential class Oxy issues, and its break-glass path for the ones it does\n'
      + '  not.\n\n'
      + '  If the material is genuinely inert, add an ALLOWED_FINDINGS entry in\n'
      + '  scripts/check-secret-scan.mjs saying WHY, with its exact occurrence count, in the\n'
      + '  same commit as the line it excuses.\n',
    );
  }
  process.exit(1);
}

console.log(
  `Secret scan passed — ${filesScanned} file(s) / ${(bytesScanned / 1048576).toFixed(1)} MiB read `
  + `(${binaryFiles} binary, scanned as bytes); ${RULES.length} rules each verified against their `
  + `own sample; ${ALLOWED_FINDINGS.length} allow-list entr${ALLOWED_FINDINGS.length === 1 ? 'y' : 'ies'} `
  + 'matched their exact declared counts.',
);
