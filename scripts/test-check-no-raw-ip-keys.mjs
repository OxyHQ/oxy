#!/usr/bin/env bun
/**
 * Exercises check-no-raw-ip-keys.mjs against fixture trees.
 *
 * A gate nobody has watched fail is not a gate. Every shape the check claims to
 * catch is PROVEN to go red here — including the original
 * `packages/api/src/routes/store.ts` keyGenerator verbatim, which is the line
 * this gate was written for — beside a matched fixture proving the check can
 * still pass. Without that last case, "everything fails" and "the gate works" are
 * the same observation.
 *
 * The case that decides whether the mechanism was chosen correctly is
 * `ip-named-only-in-comments`. The check parses with the TypeScript compiler
 * rather than scanning text, and that fixture is what a regex census would fail:
 * a file whose only mentions of `req.ip`, `remoteAddress` and
 * `x-forwarded-for` are in a doc comment, a line comment and a comment
 * containing apostrophes. Three such comments exist in the real tree and one is
 * the paragraph in `store.ts` documenting this very bug, so a gate that read them
 * would be permanently red on prose it must not constrain.
 *
 * The allowed-source list is not restated here. The check EMITS it
 * (`RAW_IP_KEYS_EMIT_POLICY=1`) and every fixture is built from that, so a member,
 * a header or an allow-list entry added to the gate is covered by this suite
 * without editing it.
 *
 * Every fixture is a throwaway tree under the OS temp dir holding only the files
 * the check reads. Nothing here touches the real repository: the check resolves
 * its corpus from `cwd`, and each case runs with `cwd` set to its fixture and
 * `RAW_IP_KEYS_FIXTURE_FLOORS=1`, which LOWERS the vacuity floors — never removes
 * them, so `below-the-vacuity-floor` below is still a case this suite states on
 * purpose.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkScript = resolve(scriptDirectory, 'check-no-raw-ip-keys.mjs');
const fixturePrefix = join(tmpdir(), 'oxy-raw-ip-keys-');
const createdFixtures = [];
const failures = [];

/** The gate's own patterns and allow-list, read out of the gate. */
const policy = JSON.parse(
  execFileSync('bun', [checkScript], {
    cwd: scriptDirectory,
    encoding: 'utf8',
    env: { ...process.env, RAW_IP_KEYS_EMIT_POLICY: '1' },
  }),
);

/**
 * The positive control on the DERIVATION itself.
 *
 * Every case below is built from the policy the gate emits, which makes the suite
 * track the gate — and makes a SHRUNKEN gate shrink the suite with it. Measured:
 * deleting `remoteAddress` from `IP_MEMBERS` deleted the `member-access-remoteAddress`
 * case, so the mutation was caught only indirectly, by the allow-list going stale.
 * These are the spellings and factories the gate is ABOUT, so their absence is
 * stated here rather than inferred.
 */
const REQUIRED_POLICY = {
  members: ['ip', 'ips', 'remoteAddress'],
  headers: ['^x-forwarded-for$', '^x-real-ip$', '^cf-connecting-ip$'],
  limiterCallees: ['rateLimit', 'expressRateLimit', 'slowDown'],
  /** The real tree has five; a list that collapsed would pass every case vacuously. */
  minimumAllowed: 4,
};

for (const [field, required] of Object.entries(REQUIRED_POLICY)) {
  if (field === 'minimumAllowed') continue;
  for (const value of required) {
    if (!policy[field].includes(value)) {
      failures.push(
        `policy.${field} does not carry ${JSON.stringify(value)}. The gate stopped watching it, `
        + 'and because every case here is derived from the policy, the case that would have '
        + 'caught that disappeared along with it.',
      );
    }
  }
}
if (policy.allowed.length < REQUIRED_POLICY.minimumAllowed) {
  failures.push(
    `policy.allowed holds ${policy.allowed.length} entries, below the `
    + `${REQUIRED_POLICY.minimumAllowed} floor — an allow-list that collapsed makes both `
    + 'directions of the exactness assertion vacuous.',
  );
}

function runCheck(cwd, extraEnv = {}) {
  try {
    const stdout = execFileSync('bun', [checkScript], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RAW_IP_KEYS_FIXTURE_FLOORS: '1', ...extraEnv },
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function write(root, relativePath, contents) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Allow-list entries grouped by the file they live in — see `allowedSource`. */
function groupAllowedByFile(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    const existing = byFile.get(entry.file);
    if (existing === undefined) byFile.set(entry.file, [entry]);
    else existing.push(entry);
  }
  return byFile;
}

/**
 * A source file reproducing EVERY allow-listed entry that lives in it, so the
 * list's other-direction assertion is satisfied and a case can then be about
 * exactly one planted thing. Each expression is emitted `count` times, in code.
 *
 * Grouped rather than written per entry: `packages/core/src/server/rateLimit.ts`
 * carries two entries, and writing one file per entry made the second clobber the
 * first — every fixture then failed on a stale-entry error it had itself caused.
 * The positive control is what caught it.
 */
function allowedSource(entries) {
  const uses = entries.flatMap((entry, entryIndex) =>
    Array.from(
      { length: entry.count },
      (_unused, index) =>
        `export const allowed${entryIndex}_${index} = (req: Req) => String(${entry.expression});`,
    ),
  ).join('\n');
  return (
    'interface Req { ip?: string; ips?: string[]; socket: { remoteAddress?: string } }\n'
    + 'declare const guard: { ip: string };\n'
    + `${uses}\n`
  );
}

/**
 * A limiter call with a real `keyGenerator`, so the two limiter-shaped floors are
 * met by every fixture and a case that fails does so for the reason it names.
 */
function limiterSource(keyGeneratorBody) {
  return (
    'declare function rateLimit(options: unknown): unknown;\n'
    + 'declare function hashedIpKey(req: unknown): string;\n'
    + 'export const limiter = rateLimit({\n'
    + "  prefix: 'rl:fixture:',\n"
    + '  windowMs: 60000,\n'
    + '  max: 20,\n'
    + `  keyGenerator: ${keyGeneratorBody},\n`
    + '});\n'
  );
}

/**
 * A complete fixture: every allowed source reproduced, one limiter, plus whatever
 * the case plants. `omitAllowed` drops one allow-listed entry, which is how the
 * list's exactness in the other direction is exercised.
 */
function createFixture({ files = {}, omitAllowed = null, limiter = 'hashedIpKey', limiterFile = null } = {}) {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);

  const kept = policy.allowed.filter(
    (entry) =>
      omitAllowed === null
      || entry.file !== omitAllowed.file
      || entry.expression !== omitAllowed.expression,
  );
  for (const [file, entries] of groupAllowedByFile(kept)) {
    write(root, file, allowedSource(entries));
  }
  // `limiterFile` REPLACES the standard limiter rather than adding to it, because
  // a case about how limiter options are COUNTED cannot have a second limiter
  // meeting the floor for it.
  write(root, 'packages/fixture/src/limiter.ts', limiterFile ?? limiterSource(limiter));
  for (const [path, contents] of Object.entries(files)) {
    write(root, path, contents);
  }
  return root;
}

/** The allow-listed entries that share `file`, for a case that rewrites it. */
function allowedEntriesIn(file) {
  return policy.allowed.filter((entry) => entry.file === file);
}

function expectVerdict(caseName, root, expectedCode, expectedFragments, extraEnv = {}) {
  const { code, output } = runCheck(root, extraEnv);
  if (code !== expectedCode) {
    failures.push(`${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`);
    return;
  }
  for (const fragment of [expectedFragments].flat()) {
    if (!output.includes(fragment)) {
      failures.push(`${caseName}: output does not contain ${JSON.stringify(fragment)}.\n${output}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The positive control: the gate can pass                                   */
/* -------------------------------------------------------------------------- */

expectVerdict('matched', createFixture(), 0, [
  'Raw-client-IP guard passed',
  `${policy.allowed.length} allowed IP sources all still present`,
]);

/* -------------------------------------------------------------------------- */
/*  THE case: the original store.ts keyGenerator, verbatim                    */
/* -------------------------------------------------------------------------- */

// Copied from `packages/api/src/routes/store.ts` as it stood on `main`. Both
// halves of the gate must speak: it is an unlisted IP source AND it is inside a
// limiter's options.
expectVerdict(
  'the-original-store-keygenerator',
  createFixture({
    limiter: "(req) => (req as AuthRequest).user?._id?.toString() ?? req.ip ?? 'unknown'",
  }),
  1,
  [
    "is inside a rate limiter's options",
    'Not allow-listable',
    'is not in ALLOWED_IP_SOURCES',
  ],
);

/* -------------------------------------------------------------------------- */
/*  Every source shape the gate claims to detect                              */
/* -------------------------------------------------------------------------- */

// A member access, per member the gate bans. `remoteAddress` is the one that
// matters: it is the cheapest way to go green on a `req.ip`-only ban, so a gate
// that missed it would push the next author straight at the same hazard.
for (const member of policy.members) {
  expectVerdict(
    `member-access-${member}`,
    createFixture({
      files: {
        'packages/fixture/src/handler.ts':
          'declare const req: { socket: unknown } & Record<string, unknown>;\n'
          + `export const key = String(req.${member});\n`,
      },
    }),
    1,
    [`req.${member}`, 'is not in ALLOWED_IP_SOURCES'],
  );
}

// The same read spelled as an index. A property-access-only census reads clean.
expectVerdict(
  'index-access-with-a-string-key',
  createFixture({
    files: {
      'packages/fixture/src/handler.ts':
        'declare const req: Record<string, unknown>;\n'
        + "export const key = String(req['ip']);\n",
    },
  }),
  1,
  ["req['ip']", 'is not in ALLOWED_IP_SOURCES'],
);

// A forwarded-client-IP header, per pattern the gate carries. This is how an
// address is read when `trust proxy` is not doing it for you.
for (const header of policy.headers) {
  const name = header.replace(/[$^]/g, '');
  expectVerdict(
    `header-literal-${name}`,
    createFixture({
      files: {
        'packages/fixture/src/handler.ts':
          'declare const req: { headers: Record<string, string | undefined> };\n'
          + `export const key = req.headers['${name}'] ?? 'unknown';\n`,
      },
    }),
    1,
    [name, 'is not in ALLOWED_IP_SOURCES'],
  );
}

/* -------------------------------------------------------------------------- */
/*  Half 2 is not allow-listable                                              */
/* -------------------------------------------------------------------------- */

// An IP inside a limiter's options fails EVEN THOUGH its file+expression is on
// the allow-list. Without this the second half would collapse into the first the
// moment somebody excused a file for an unrelated reason.
const hasher = policy.allowed.find((entry) => entry.file.endsWith('utils/ipKey.ts')) ?? policy.allowed[0];
expectVerdict(
  'allow-listed-file-still-fails-inside-a-limiter',
  createFixture({
    files: {
      [hasher.file]:
        `${allowedSource(allowedEntriesIn(hasher.file))}`
        + 'declare function rateLimit(options: unknown): unknown;\n'
        + 'export const sneaky = rateLimit({\n'
        + "  prefix: 'rl:sneaky:',\n"
        + '  keyGenerator: (r: Req) => String(r.ip),\n'
        + '});\n',
    },
  }),
  1,
  ["is inside a rate limiter's options", 'Not allow-listable'],
);

// Every factory name the gate watches, so adding one to LIMITER_CALLEES is
// covered and dropping one is caught. `slowDown` is the sibling of `rateLimit`
// that a `rateLimit`-only check would walk straight past.
for (const callee of policy.limiterCallees) {
  expectVerdict(
    `inside-${callee}`,
    createFixture({
      files: {
        'packages/fixture/src/other.ts':
          `declare function ${callee}(options: unknown): unknown;\n`
          + `export const limiter = ${callee}({ keyGenerator: (req: { ip?: string }) => req.ip ?? 'x' });\n`,
      },
    }),
    1,
    ["is inside a rate limiter's options"],
  );
}

// A member-callee call (`oxy.rateLimit({...})`), the form an identifier-only
// callee check misses — and the form core's own doc comment demonstrates.
expectVerdict(
  'inside-a-member-callee-limiter',
  createFixture({
    files: {
      'packages/fixture/src/other.ts':
        'declare const oxy: { rateLimit(options: unknown): unknown };\n'
        + "export const limiter = oxy.rateLimit({ keyGenerator: (req: { ip?: string }) => req.ip ?? 'x' });\n",
    },
  }),
  1,
  ["is inside a rate limiter's options"],
);

/* -------------------------------------------------------------------------- */
/*  THE MECHANISM CASE: prose is not code                                     */
/* -------------------------------------------------------------------------- */

// The reason this gate parses instead of scanning. Every banned spelling appears
// in this file and NONE of them is code — a doc comment, a line comment, and a
// comment stuffed with apostrophes, which is what opened a string literal and
// swallowed 450 lines elsewhere in this repo. Three comments of exactly this kind
// exist on the real tree, one of them the paragraph in store.ts explaining this
// very bug, so a gate that read them would be permanently red on prose.
expectVerdict(
  'ip-named-only-in-comments',
  createFixture({
    files: {
      'packages/fixture/src/prose.ts':
        '/**\n'
        + ' * Keyed through the hasher, never raw `req.ip`.\n'
        + ' *\n'
        + " * The v8 validator's static scan false-positives on req.ip and spams\n"
        + " * ERR_ERL_KEY_GEN_IPV6, so it's disabled — it isn't reading what we read.\n"
        + " * Don't reach for req.socket.remoteAddress or req.headers['x-forwarded-for']\n"
        + ' * either; they are the same address by another name.\n'
        + ' */\n'
        + '// A line comment: req.ip, req.ips, x-real-ip, cf-connecting-ip.\n'
        + 'declare function hashedIpKey(req: unknown): string;\n'
        + 'export const key = (req: unknown) => hashedIpKey(req);\n',
    },
  }),
  0,
  ['Raw-client-IP guard passed'],
);

// A string that merely CONTAINS a banned header name is not a read of it. The
// header patterns are anchored, and an unanchored version would fire on this.
expectVerdict(
  'header-name-inside-a-longer-string',
  createFixture({
    files: {
      'packages/fixture/src/message.ts':
        "export const help = 'Set x-forwarded-for on your proxy if requests are misattributed.';\n",
    },
  }),
  0,
  ['Raw-client-IP guard passed'],
);

/* -------------------------------------------------------------------------- */
/*  The allow-list is exact in both directions                                */
/* -------------------------------------------------------------------------- */

// An entry naming a source that is no longer there fails, so the list cannot
// outlive what it described — and so a traversal that stopped seeing property
// accesses fails on every entry at once instead of reporting a clean tree.
for (const entry of policy.allowed) {
  expectVerdict(
    `stale-entry-${entry.file}-${entry.expression}`,
    createFixture({ omitAllowed: entry }),
    1,
    ['which this census did not find', entry.file],
  );
}

// A SECOND read in an allow-listed file fails on the count, so an entry that
// excuses one line cannot silently excuse the next one added beside it.
expectVerdict(
  'a-second-read-in-an-allow-listed-file',
  createFixture({
    files: {
      [hasher.file]:
        `${allowedSource(allowedEntriesIn(hasher.file))}`
        + 'export const extra = (req: Req) => String(req.ip);\n',
    },
  }),
  1,
  ['ALLOWED_IP_SOURCES says', 'The count is part of the assertion'],
);

/* -------------------------------------------------------------------------- */
/*  Vacuity floors and malformed inputs                                       */
/* -------------------------------------------------------------------------- */

// The REAL floors against a fixture tree of a dozen files. Nothing is planted:
// this tree is clean, and only the floors can catch that it is also tiny. Without
// them, a corpus that resolved to nothing reports exactly this.
expectVerdict(
  'below-the-vacuity-floor',
  createFixture(),
  1,
  ['is below the', 'floor'],
  { RAW_IP_KEYS_FIXTURE_FLOORS: '0' },
);

// The `keyGenerator` floor is what stops half 2 from inspecting zero limiter
// options and reporting clean, so it has to count every spelling of that property
// the tree actually uses. A limiter that spreads a helper returning its generator
// — `...userScopedKeying(scope)` in `packages/api/src/routes/nodes.ts` — writes it
// SHORTHAND, a different AST node. This fixture's ONLY limiter is written that
// way, so the tree holds one `keyGenerator` and the floor is met; counting only
// the long form, it holds zero and the case goes red on its own vacuity floor,
// which is how this asserts the shorthand is seen rather than assuming it.
expectVerdict(
  'keygenerator-written-in-shorthand-still-counts',
  createFixture({
    limiterFile:
      'declare function rateLimit(options: unknown): unknown;\n'
      + 'declare function hashedIpKey(req: unknown): string;\n'
      + 'const keyGenerator = hashedIpKey;\n'
      + "export const limiter = rateLimit({ prefix: 'rl:fixture:', windowMs: 60000, max: 20, keyGenerator });\n",
  }),
  0,
  ['Raw-client-IP guard passed'],
);

// A file that does not parse contributes no hits, which is indistinguishable
// from a file with nothing in it — so it has to be loud.
expectVerdict(
  'a-file-that-does-not-parse',
  createFixture({
    files: { 'packages/fixture/src/broken.ts': 'export const oops = (((;\n' },
  }),
  1,
  ['did not parse', 'indistinguishable'],
);

// No `packages/` at all: the corpus is empty and the floors are the only thing
// that notices. This is the shape of running the gate from the wrong directory.
const emptyRoot = mkdtempSync(fixturePrefix);
createdFixtures.push(emptyRoot);
expectVerdict('no-packages-directory', emptyRoot, 1, ['file(s) read is below the', 'repository root']);

/* -------------------------------------------------------------------------- */
/*  Scope: tests and generated output are not the corpus                      */
/* -------------------------------------------------------------------------- */

// A test may hold a literal address in a fake request — `sessionRequesterLabel`,
// `deviceUtils` and core's own rateLimit suite all do, correctly. If the gate
// read them it would be red on the tests that prove the hasher works.
expectVerdict(
  'a-planted-read-inside-tests-is-out-of-scope',
  createFixture({
    files: {
      'packages/fixture/src/__tests__/handler.test.ts':
        "export const fake = { ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } };\n"
        + 'export const read = (req: { ip: string }) => req.ip;\n',
      'packages/fixture/src/handler.spec.ts':
        'export const read2 = (req: { ip: string }) => req.ip;\n',
      'packages/fixture/src/dist/bundled.ts':
        'export const read3 = (req: { ip: string }) => req.ip;\n',
    },
  }),
  0,
  ['Raw-client-IP guard passed'],
);

/* -------------------------------------------------------------------------- */

for (const root of createdFixtures) {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} fixture case(s) did not behave as expected:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Raw-client-IP check discriminated ${createdFixtures.length} fixture case(s), including the `
  + 'original store.ts keyGenerator verbatim, every banned member and header, both directions of '
  + 'allow-list drift, and a file naming every one of them only in comments.',
);
