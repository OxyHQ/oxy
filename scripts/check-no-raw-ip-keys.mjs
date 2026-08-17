#!/usr/bin/env bun

/**
 * Refuse a raw client IP anywhere in this monorepo's source, and refuse one
 * INSIDE a rate limiter's options twice over.
 *
 * ## THE INVARIANT THIS ENFORCES
 *
 * Oxy persists no user IP — raw, hashed or geo-derived, in Postgres, in a log, in
 * metrics metadata or in a DTO. It is owner-mandated and the threat model behind
 * it is a real one, so hashing is not an acceptable AT-REST form either: a salted
 * hash of the IPv4 space is brute-forceable. Anonymous rate-limit keys are the
 * ONE transient exception, and they must go through a hasher — `hashedIpKey`
 * (`packages/api/src/utils/ipKey.ts`) or core's `hashAnonymousIp` — which buckets
 * IPv6 to its /56 prefix before HMAC'ing under an `rl|` namespace, and whose
 * output lives only as a Redis key with the limiter's own TTL.
 *
 * ## WHAT WENT WRONG, AND WHY IT NEEDS A GATE RATHER THAN A REVIEW
 *
 * `packages/api/src/routes/store.ts` declared
 *
 *     keyGenerator: (req) => req.user?._id?.toString() ?? req.ip ?? 'unknown'
 *
 * and mounted that limiter IMMEDIATELY BEFORE `authMiddleware` on all nine store
 * write routes. Express runs middleware in declaration order, so `req.user` was
 * undefined every time the key was computed: the `?? req.ip` arm was not a rare
 * fallback, it was the only branch that ever executed. Every store write minted a
 * Redis key holding a raw client IP.
 *
 * Nothing about that is visible at the limiter. The keyGenerator reads as
 * account-keyed-with-a-fallback and is correct in isolation; the bug is the ORDER
 * of two arguments two hundred lines below it, and the file's own comment
 * asserted the property that had been inverted. A reviewer would have to hold
 * both halves at once. What a reviewer CAN be asked is the flat question this
 * file answers: is there a raw IP in the source at all, and does the list of
 * places allowed to touch one still describe the tree?
 *
 * ## THE TWO THINGS CHECKED
 *
 *   1. **Every raw-client-IP SOURCE in code is on {@link ALLOWED_IP_SOURCES},
 *      with an exact count.** The list is exact in both directions: a source with
 *      no entry fails, and an entry naming a source that is no longer there fails,
 *      so it cannot outlive what it described. This is what makes touching an IP a
 *      DECISION — it takes an edit to this file, saying why — rather than a line
 *      in a diff nobody reads.
 *
 *   2. **No raw-IP source appears lexically inside a rate limiter's options.**
 *      Not allow-listable, because this is the exact shape of the bug above: the
 *      argument object of `rateLimit(...)`, `expressRateLimit(...)` or
 *      `slowDown(...)` may not read an IP by any spelling. The sanctioned path is
 *      a CALL to a hasher, which reads nothing lexically here — core's own
 *      composed limiter passes because its `resolveKey` lives outside the options
 *      object and goes through `hashAnonymousIp`.
 *
 * A source is any of: a property access or `['...']` index naming `ip`, `ips` or
 * `remoteAddress`; or a string literal naming a forwarded-client-IP header
 * (`x-forwarded-for` and the CDN variants), which is the other way to read one
 * when `trust proxy` is not doing it for you.
 *
 * ## WHY THE TYPESCRIPT PARSER AND NOT A REGEX
 *
 * Because most of what a text census finds here is PROSE, and it cannot tell the
 * difference. On this tree, `grep -rn 'req\.ip'` over `packages/api/src` and
 * `packages/core/src` returns six hits of which THREE are comments —
 * `routes/updates.ts` ("never raw `req.ip`"), `middleware/rateLimiter.ts` and
 * `server/rateLimit.ts` (both explaining why the express-rate-limit v8 validator
 * is disabled) — plus, in `routes/store.ts` itself, the paragraph documenting the
 * bug this gate exists for. The limiter census has the same shape: 115 textual
 * `rateLimit({` hits, 114 real calls, the 115th being `oxy.rateLimit({ store })`
 * inside a doc-comment code fence. A gate whose clean run depends on a comment
 * not being rephrased is not measuring the code. `typescript`'s own lexer handles
 * comments, apostrophes and template strings by construction and is already a
 * dependency of this repo.
 *
 * ## THE CORPUS IS DERIVED, NOT LISTED
 *
 * Every `packages/<pkg>/src` that exists, discovered by reading `packages/`. Not
 * a hand-written list of the two packages that obviously have servers: written
 * that way, this gate would have missed
 * `packages/protocol/src/node/rateLimit.ts`, which keys a rate limiter on a raw
 * `req.ip` and is a real hit (see its entry below). A map a gate SKIPS what is
 * absent from is not a gate.
 *
 * The residue, named: packages laid out without a `src/` — the Expo apps, whose
 * code is a client and has no `req` — and anything outside `packages/`. Verified
 * against a repo-wide `grep` for every source pattern above: outside the derived
 * corpus there is not one hit in code, only comments and test fixtures.
 *
 * ## HOW IT CANNOT PASS VACUOUSLY
 *
 *   - Floors on files read, property accesses walked, limiter calls found and
 *     `keyGenerator` properties found. A corpus that resolved to nothing, or a
 *     traversal that stopped descending, reports exactly what a clean tree
 *     reports — and the last two floors are specifically what stops half 2 from
 *     inspecting zero limiters and calling it clean.
 *   - A file that fails to PARSE contributes no hits, so a parse error is a hard
 *     failure rather than a quiet zero.
 *   - The allow-list's exactness in the other direction: five sources must each
 *     still be found, at their stated count, so a traversal that stopped seeing
 *     property accesses fails on all five at once.
 *
 * `scripts/test-check-no-raw-ip-keys.mjs` is the positive control: it plants each
 * source shape — including the original `store.ts` keyGenerator verbatim — in
 * fixture trees and requires this to flag every one, beside a matched fixture
 * proving the gate can still pass and a comment-only fixture proving it does not
 * fire on prose.
 *
 * Needs nothing built. `typescript` is the only import beyond node builtins.
 *
 * Usage:  bun scripts/check-no-raw-ip-keys.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Members that yield a client address. `remoteAddress` is here beside `ip` on
 * purpose: banning only `req.ip` would leave `req.socket.remoteAddress` as the
 * cheapest way to go green, which is the same hazard through an unwatched door.
 */
const IP_MEMBERS = new Set(['ip', 'ips', 'remoteAddress']);

/**
 * Headers a proxy or CDN puts the client address in.
 *
 * RFC 7239's bare `Forwarded` is deliberately NOT here. Measured: the pattern
 * matches three ordinary strings in the email code, where `forwarded` means a
 * user forwarded a message — and a gate that fires on the product gets deleted
 * rather than obeyed. Distinguishing the two needs to know what the literal is
 * used AS, which a literal census cannot. Named as residue rather than silently
 * dropped; nothing in this tree reads the bare header, and the `x-` family below
 * is what a proxy in front of Oxy actually sets.
 */
const IP_HEADER_PATTERNS = [
  /^x-forwarded-for$/i,
  /^x-real-ip$/i,
  /^cf-connecting-ip$/i,
  /^true-client-ip$/i,
  /^x-client-ip$/i,
];

/** The rate-limiter factories whose options object half 2 refuses an IP inside. */
const LIMITER_CALLEES = new Set(['rateLimit', 'expressRateLimit', 'slowDown']);

/**
 * Every place in this monorepo's source that may read a client address, what it
 * does with it, and how many times it appears.
 *
 * Exact in both directions — see the header. `count` is part of the assertion so
 * a SECOND raw read cannot hide behind an entry that already excuses the first.
 */
const ALLOWED_IP_SOURCES = [
  {
    file: 'packages/api/src/utils/ipKey.ts',
    expression: 'req.ip',
    count: 1,
    why:
      'THE hasher. `hashedIpKey` is the one sanctioned transient use: it buckets IPv6 to /56 '
      + "before HMAC'ing with DEVICE_ID_SALT under an `rl|` namespace, and the digest lives only "
      + 'as a Redis key with the limiter\'s TTL. Every other limiter in the API reaches an IP '
      + 'through this function or not at all.',
  },
  {
    file: 'packages/core/src/server/rateLimit.ts',
    expression: 'req.ip',
    count: 1,
    why:
      "core's equivalent, feeding `hashAnonymousIp` on the very next lines. `createOxyRateLimit` "
      + 'resolves the session ITSELF before computing a key, so unlike a route-mounted limiter it '
      + 'cannot be defeated by middleware order.',
  },
  {
    file: 'packages/core/src/server/rateLimit.ts',
    expression: 'req.socket.remoteAddress',
    count: 1,
    why:
      'the fallback on the same expression, for a request where `trust proxy` left `req.ip` '
      + 'unset. Feeds the same `hashAnonymousIp` call.',
  },
  {
    file: 'packages/core/src/server/safeFetch.ts',
    expression: 'guard.ip',
    count: 1,
    why:
      'NOT a client address. This is the resolved address of an OUTBOUND url Oxy is about to '
      + 'fetch, pinned so the connection cannot be re-resolved to a private range between the '
      + 'SSRF check and the socket. It is the server talking about a third party, and it is '
      + 'never stored.',
  },
  {
    file: 'packages/protocol/src/node/rateLimit.ts',
    expression: 'req.ip',
    count: 1,
    why:
      'A KNOWN GAP, listed rather than sanctioned. `createRateLimiter` (used by `nodeApp`, the '
      + 'self-hosted / managed node server) keys its in-process window Map on a raw '
      + '`req.ip ?? \'unknown\'`, with no hasher. In memory with a window TTL rather than in a '
      + 'store, so it is the mildest form of the problem — but it is the form, and a heap dump '
      + 'is a surface. Closing it means adding a hasher to a PUBLISHED package and deciding '
      + 'which salt a node operator supplies, which is a change with a republish and a config '
      + 'dimension rather than a line edit. It is written down here so it cannot be lost, and '
      + 'this entry is what a future fix deletes.',
  },
];

/**
 * Floors, measured on this tree at the time of writing: 1132 files, 61348
 * property accesses, 114 limiter calls, 61 `keyGenerator` properties. Set well
 * below each so ordinary growth or a deleted route cannot red the gate, and far
 * above zero so a corpus that resolved to nothing, or a traversal that stopped
 * descending, cannot read as clean.
 *
 * The last two are the ones that matter for half 2: without them, a census that
 * found no limiter at all would report "no IP inside any limiter's options",
 * which is true and measures nothing.
 */
const fixtureFloors = process.env.RAW_IP_KEYS_FIXTURE_FLOORS === '1';
const MINIMUM_FILES = fixtureFloors ? 1 : 900;
const MINIMUM_PROPERTY_ACCESSES = fixtureFloors ? 1 : 45_000;
const MINIMUM_LIMITER_CALLS = fixtureFloors ? 1 : 90;
const MINIMUM_KEY_GENERATORS = fixtureFloors ? 1 : 45;

/**
 * The fixture suite builds its planted cases from the gate's own patterns and its
 * own allow-list, so a member, a header or an entry added above is covered
 * without editing the suite.
 */
if (process.env.RAW_IP_KEYS_EMIT_POLICY === '1') {
  console.log(
    JSON.stringify({
      members: [...IP_MEMBERS],
      headers: IP_HEADER_PATTERNS.map((pattern) => pattern.source),
      limiterCallees: [...LIMITER_CALLEES],
      allowed: ALLOWED_IP_SOURCES.map(({ file, expression, count }) => ({ file, expression, count })),
    }),
  );
  process.exit(0);
}

/** Every `packages/<pkg>/src`, discovered rather than listed — see the header. */
function corpusRoots() {
  if (!existsSync('packages')) return [];
  return readdirSync('packages')
    .map((pkg) => join('packages', pkg, 'src'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

const SKIP_DIRECTORIES = new Set(['__tests__', '__mocks__', 'node_modules', 'dist', 'lib']);

function sourceFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      sourceFilesUnder(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(path)) continue;
    if (/\.(test|spec)\.tsx?$/.test(path)) continue;
    if (path.endsWith('.d.ts')) continue;
    out.push(path);
  }
  return out;
}

const problems = [];
const unlisted = [];
const insideLimiters = [];

const roots = corpusRoots();
const files = roots.flatMap((root) => sourceFilesUnder(root)).sort();

/**
 * A `(file, expression)` pair as a map key. A JSON tuple rather than a joined
 * string: neither half has a character guaranteed absent from the other — a path
 * and an expression can both contain almost anything — and a separator picked to
 * dodge that (a NUL, say) makes the whole SCRIPT read as binary, at which point
 * `grep` reports every symbol in it as absent. That happened while writing this.
 */
const sourceKey = (file, expression) => JSON.stringify([file, expression]);

/** `sourceKey(...)` -> how many times that exact expression appears. */
const found = new Map();
let propertyAccesses = 0;
let limiterCalls = 0;
let keyGenerators = 0;

const isIpHeader = (value) => IP_HEADER_PATTERNS.some((pattern) => pattern.test(value));

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // A file that did not parse yields no nodes, and no nodes reads exactly like a
  // file with nothing to find.
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, ' ');
    problems.push(
      `${file} did not parse (${first}), so nothing in it was inspected. A file this census `
      + 'cannot read is indistinguishable from a file with no raw IP in it.',
    );
    continue;
  }

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  /** `insideLimiterOptions` is set while descending an argument of a limiter call. */
  const record = (node, expression, inLimiterOptions) => {
    const key = sourceKey(file, expression);
    found.set(key, (found.get(key) ?? 0) + 1);
    if (inLimiterOptions) {
      insideLimiters.push({ file, line: lineOf(node), expression });
    }
  };

  const visit = (node, inLimiterOptions) => {
    let descendInLimiter = inLimiterOptions;

    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (callee !== null && LIMITER_CALLEES.has(callee)) {
        limiterCalls += 1;
        descendInLimiter = true;
      }
    }

    if (
      ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
      && node.name.text === 'keyGenerator'
    ) {
      keyGenerators += 1;
    }

    if (ts.isPropertyAccessExpression(node)) {
      propertyAccesses += 1;
      if (IP_MEMBERS.has(node.name.text)) {
        record(node, node.getText(sourceFile), descendInLimiter);
      }
    }

    if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const accessed = node.argumentExpression.text;
      if (IP_MEMBERS.has(accessed) || isIpHeader(accessed)) {
        record(node, node.getText(sourceFile), descendInLimiter);
      }
    }

    // A bare header name, wherever it is written: `req.headers[H]`,
    // `get(H)`, a constant, a destructure. The literal is the tell.
    if (ts.isStringLiteralLike(node) && isIpHeader(node.text)) {
      record(node, JSON.stringify(node.text), descendInLimiter);
    }

    ts.forEachChild(node, (child) => visit(child, descendInLimiter));
  };

  visit(sourceFile, false);
}

// ── Half 1: every source is listed, at its stated count ────────────────────
const allowedByKey = new Map(
  ALLOWED_IP_SOURCES.map((entry) => [sourceKey(entry.file, entry.expression), entry]),
);

for (const [key, count] of found) {
  const [file, expression] = JSON.parse(key);
  const allowed = allowedByKey.get(key);
  if (allowed === undefined) {
    unlisted.push({ file, expression, count });
    continue;
  }
  if (count !== allowed.count) {
    problems.push(
      `${file} reads \`${expression}\` ${count} time(s); ALLOWED_IP_SOURCES says ${allowed.count}. `
      + 'The count is part of the assertion so a second raw read cannot hide behind the entry '
      + 'that excuses the first — either the new read goes, or the entry says why there are now '
      + `${count}.`,
    );
  }
}

// ── Half 1, the other direction: the list still describes the tree ─────────
for (const entry of ALLOWED_IP_SOURCES) {
  if (found.has(sourceKey(entry.file, entry.expression))) continue;
  problems.push(
    `ALLOWED_IP_SOURCES names \`${entry.expression}\` in ${entry.file}, which this census did `
    + 'not find. It was removed, renamed or rewritten — delete the entry, so the list keeps '
    + 'describing the tree. If it vanished along with the other entries, the traversal is broken.',
  );
}

// ── Vacuity floors ─────────────────────────────────────────────────────────
if (files.length < MINIMUM_FILES) {
  problems.push(
    `${files.length} file(s) read is below the ${MINIMUM_FILES} floor, over ${roots.length} `
    + 'package source root(s). The corpus is not resolving — run this from the repository root.',
  );
}
if (propertyAccesses < MINIMUM_PROPERTY_ACCESSES) {
  problems.push(
    `${propertyAccesses} property access(es) walked is below the ${MINIMUM_PROPERTY_ACCESSES} `
    + 'floor. Files were read but the traversal is not descending into them, and a walk that '
    + 'visits nothing reports exactly what a clean tree reports.',
  );
}
if (limiterCalls < MINIMUM_LIMITER_CALLS) {
  problems.push(
    `${limiterCalls} rate-limiter call(s) found is below the ${MINIMUM_LIMITER_CALLS} floor. `
    + 'The second half of this check inspects the options object of each one, so a census that '
    + 'found none would report "no IP inside any limiter" — true, and measuring nothing.',
  );
}
if (keyGenerators < MINIMUM_KEY_GENERATORS) {
  problems.push(
    `${keyGenerators} \`keyGenerator\` propert(ies) found is below the ${MINIMUM_KEY_GENERATORS} `
    + 'floor. That is the option the original bug lived in; not finding them means the limiter '
    + 'options are not being read.',
  );
}

// ── Verdict ────────────────────────────────────────────────────────────────
if (unlisted.length > 0 || insideLimiters.length > 0 || problems.length > 0) {
  console.error('Raw-client-IP guard FAILED:\n');

  for (const finding of insideLimiters) {
    console.error(
      `  ${finding.file}:${finding.line} — \`${finding.expression}\` is inside a rate limiter's `
      + 'options. Not allow-listable: this is the shape of the bug this gate exists for.\n',
    );
  }
  for (const finding of unlisted) {
    console.error(
      `  ${finding.file} — \`${finding.expression}\` (×${finding.count}) reads a client address `
      + 'and is not in ALLOWED_IP_SOURCES.\n',
    );
  }
  for (const problem of problems) console.error(`  ${problem}\n`);

  if (unlisted.length > 0 || insideLimiters.length > 0) {
    console.error(
      '  Oxy persists no user IP, in any form. The one transient exception is an anonymous\n'
      + '  rate-limit key, and it goes through `hashedIpKey` (packages/api/src/utils/ipKey.ts) —\n'
      + '  which buckets IPv6 to /56 before HMAC and lives only as a Redis key. Pass the request\n'
      + '  to that function instead of reading the address.\n\n'
      + '  A limiter that wants to key on an ACCOUNT must be mounted AFTER the middleware that\n'
      + '  resolves one, and must SKIP the request when it cannot (see the `skip` note in\n'
      + '  packages/api/src/middleware/rateLimiter.ts). An `?? req.ip` fallback behind an\n'
      + '  unresolved principal is not a fallback — in packages/api/src/routes/store.ts it was\n'
      + '  the only branch that ever ran.\n\n'
      + '  If a hit above is not a client address, add an ALLOWED_IP_SOURCES entry in\n'
      + '  scripts/check-no-raw-ip-keys.mjs saying what it is, in the same commit as the code.\n',
    );
  }
  process.exit(1);
}

console.log(
  `Raw-client-IP guard passed — ${files.length} files over ${roots.length} package source roots, `
  + `${propertyAccesses} property accesses walked, ${limiterCalls} rate-limiter calls and `
  + `${keyGenerators} keyGenerator options inspected with no client address inside any of them; `
  + `${ALLOWED_IP_SOURCES.length} allowed IP sources all still present at their stated counts.`,
);
