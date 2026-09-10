# No IP Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all user IP persistence (raw, hashed at rest, geo-derived) from oxy-api; hash the transient rate-limit keys; scrub logs; purge historical prod data.

**Architecture:** Deletion-heavy change across `packages/api` (models, services, middleware, routes), one type removal in `@oxy.so/core`, IP rendering removal in `packages/accounts`, plus a one-shot purge script. One NEW module: `packages/api/src/utils/ipKey.ts` (HMAC-hashed rate-limit key).

**Tech Stack:** Express + Mongoose + express-rate-limit@^7.5 (exports `ipKeyGenerator`) + rate-limit-redis. Tests: Jest (ts-jest) — run per-package `bun run test`, NEVER blanket `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-14-no-ip-storage-design.md`

## Global Constraints

- Package manager: `bun` only. Tests: `cd packages/api && bun run test` (Jest). Core build: `bun run core:build` from repo root.
- NO `as any`, no `@ts-ignore`, no `!` non-null assertions, no TODO comments, no silent catch.
- Clean cuts: remove identifiers entirely + update every call site. No back-compat aliases.
- Email inbound `Message.headers` is OUT OF SCOPE (owner decision: keep).
- Path-scope all `git add` calls (shared package).
- Test baselines before change: api 1322, core 722. Expect small deltas from removed IP-specific tests.

---

### Task 1: `hashedIpKey` helper + hashed rate-limit keys everywhere

**Files:**
- Create: `packages/api/src/utils/ipKey.ts`
- Create: `packages/api/src/utils/__tests__/ipKey.test.ts`
- Modify: `packages/api/src/middleware/rateLimiter.ts` (default keyGenerator)
- Modify: `packages/api/src/middleware/security.ts` (limiters at ~136, 165, 183, 200, 211, 231)
- Modify route keyGenerators: `routes/links.ts:51`, `routes/assets.ts:555,569`, `routes/contacts.ts:73`, `routes/nodes.ts:33,79`, `routes/identity.ts:59`, `routes/accounts.ts:78`, `routes/userData.ts:97`, `routes/civic.ts:65-160` (9 sites), `routes/users.ts:1178,1551`

**Interfaces:**
- Produces: `hashedIpKey(req: Request): string` — HMAC-sha256(DEVICE_ID_SALT, 'rl|' + IPv6-normalized IP), 24 hex chars, `'unknown'` when no IP. Used by every anonymous rate-limit key from here on.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/src/utils/__tests__/ipKey.test.ts
import type { Request } from 'express';
import { hashedIpKey } from '../ipKey';

function reqWithIp(ip: string | undefined): Request {
  return { ip } as Request;
}

describe('hashedIpKey', () => {
  const OLD_SALT = process.env.DEVICE_ID_SALT;
  beforeEach(() => {
    process.env.DEVICE_ID_SALT = 'test-salt-0123456789abcdef';
  });
  afterAll(() => {
    process.env.DEVICE_ID_SALT = OLD_SALT;
  });

  it('is deterministic for the same IP', () => {
    expect(hashedIpKey(reqWithIp('203.0.113.7'))).toBe(hashedIpKey(reqWithIp('203.0.113.7')));
  });

  it('differs across IPs', () => {
    expect(hashedIpKey(reqWithIp('203.0.113.7'))).not.toBe(hashedIpKey(reqWithIp('203.0.113.8')));
  });

  it('never contains the raw IP and is fixed-length hex', () => {
    const key = hashedIpKey(reqWithIp('203.0.113.7'));
    expect(key).not.toContain('203.0.113.7');
    expect(key).toMatch(/^[a-f0-9]{24}$/);
  });

  it('changes with the salt', () => {
    const a = hashedIpKey(reqWithIp('203.0.113.7'));
    process.env.DEVICE_ID_SALT = 'other-salt-0123456789abcdef';
    expect(hashedIpKey(reqWithIp('203.0.113.7'))).not.toBe(a);
  });

  it('buckets IPv6 addresses (same /56 → same key)', () => {
    const a = hashedIpKey(reqWithIp('2001:db8:0:1::1'));
    const b = hashedIpKey(reqWithIp('2001:db8:0:1::2'));
    expect(a).toBe(b);
  });

  it('returns "unknown" when no IP is resolvable', () => {
    expect(hashedIpKey(reqWithIp(undefined))).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && bunx jest src/utils/__tests__/ipKey.test.ts`
Expected: FAIL — `Cannot find module '../ipKey'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/api/src/utils/ipKey.ts
import crypto from 'crypto';
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * Privacy-preserving rate-limit key: the raw client IP must never reach a
 * store at rest (Redis included). IPv6 is bucketed via express-rate-limit's
 * `ipKeyGenerator` (/56 by default) BEFORE hashing so a single v6 host can't
 * rotate through 2^72 keys; the result is then HMAC'd with the server-side
 * DEVICE_ID_SALT (namespaced with 'rl|' so rate-limit keys can never be
 * correlated with deviceId derivations that use the same salt).
 */
export function hashedIpKey(req: Request): string {
  const ip = req.ip;
  if (!ip) {
    return 'unknown';
  }
  const normalized = ipKeyGenerator(ip);
  const salt = process.env.DEVICE_ID_SALT ?? '';
  return crypto.createHmac('sha256', salt).update(`rl|${normalized}`).digest('hex').slice(0, 24);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && bunx jest src/utils/__tests__/ipKey.test.ts`
Expected: PASS (6 tests). If `ipKeyGenerator`'s import name differs in the installed express-rate-limit version, check `node_modules/express-rate-limit/dist/index.d.ts` — v7.5 exports `ipKeyGenerator(ip: string, ipv6Subnet?: number | false): string`.

- [ ] **Step 5: Wire the factory default (`middleware/rateLimiter.ts`)**

Replace the option spread so limiters WITHOUT a custom keyGenerator hash the IP:

```typescript
import { hashedIpKey } from '../utils/ipKey';
// ...
export function rateLimit(options: RateLimitOptions) {
  return expressRateLimit({
    ...makeStore(options.prefix),
    windowMs: options.windowMs,
    max: options.max,
    message: options.message || 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: options.keyGenerator ?? hashedIpKey,
  });
}
```

- [ ] **Step 6: Wire `middleware/security.ts`**

Add `import { hashedIpKey } from '../utils/ipKey';`. Add `keyGenerator: hashedIpKey,` to the four direct `rateLimit({...})` limiters (`rl:general:` ~line 136, `rl:federation:service:` ~165, `rl:idp:service:` ~183, `rl:auth:` ~200) and to `slowDown({...})` (~231). Change `userRateLimiter`'s keyGenerator (~219) to:

```typescript
keyGenerator: (req: Request) => {
  return (req as AuthRequest).user?.id || hashedIpKey(req);
},
```

- [ ] **Step 7: Wire every route-level keyGenerator**

In each site, add `import { hashedIpKey } from '../utils/ipKey';` and replace the fallback expression `req.ip ?? 'unknown'` with `hashedIpKey(req)`. Exact sites (pattern is identical — shown once, apply everywhere):

```typescript
// BEFORE (routes/civic.ts:65 and 8 siblings; links/assets/contacts/nodes/identity/accounts/userData/users)
return userId ? `civic:attest:${userId}` : `civic:attest:ip:${req.ip ?? 'unknown'}`;
// AFTER
return userId ? `civic:attest:${userId}` : `civic:attest:ip:${hashedIpKey(req)}`;
```

Full site list: `routes/links.ts:51`, `routes/assets.ts:555`, `routes/assets.ts:569`, `routes/contacts.ts:73`, `routes/nodes.ts:33`, `routes/nodes.ts:79`, `routes/identity.ts:59`, `routes/accounts.ts:78`, `routes/userData.ts:97`, `routes/civic.ts:65,76,88,100,112,124,136,148,160`, `routes/users.ts:1178`, `routes/users.ts:1551` (this one is `appId ? \`app:${appId}\` : hashedIpKey(req)`).

Verify no stragglers: `grep -rn "req\.ip" packages/api/src --include='*.ts' | grep -v __tests__ | grep -v ipKey.ts` — remaining hits after this task must only be the ones Tasks 2–5 remove (securityActivityService, deviceUtils, anomalyDetection, csrf, performance, auth.ts:2732).

- [ ] **Step 8: Run the api suite + commit**

Run: `cd packages/api && bun run test`
Expected: green (any failure here is a rate-limit test asserting raw-IP keys — update it to assert the hashed shape).

```bash
git add packages/api/src/utils/ipKey.ts packages/api/src/utils/__tests__/ipKey.test.ts packages/api/src/middleware/rateLimiter.ts packages/api/src/middleware/security.ts packages/api/src/routes/links.ts packages/api/src/routes/assets.ts packages/api/src/routes/contacts.ts packages/api/src/routes/nodes.ts packages/api/src/routes/identity.ts packages/api/src/routes/accounts.ts packages/api/src/routes/userData.ts packages/api/src/routes/civic.ts packages/api/src/routes/users.ts
git commit -m "feat(api): hash anonymous rate-limit keys — no raw IPs in Redis"
```

---

### Task 2: SecurityActivity — stop capturing/serving IP

**Files:**
- Modify: `packages/api/src/models/SecurityActivity.ts:53,84-86`
- Modify: `packages/api/src/services/securityActivityService.ts:35,152-154,196,211`
- Modify: `packages/api/src/controllers/securityActivity.controller.ts:106`
- Test: any existing suite touching these (grep `ipAddress` under `packages/api/src/**/__tests__`)

**Interfaces:**
- Produces: `ISecurityActivity` WITHOUT `ipAddress`; `GET /security/activity` DTO WITHOUT `ipAddress`. Task 6 (core type) and Task 7 (accounts UI) depend on this shape.

- [ ] **Step 1: Model — delete the field**

In `models/SecurityActivity.ts` remove `ipAddress?: string;` from `ISecurityActivity` (line 53) and the schema block (lines 84-86):

```typescript
    ipAddress: {
      type: String,
    },
```

- [ ] **Step 2: Service — stop reading req.ip**

In `services/securityActivityService.ts`:
- Line 35: `ACTIVITY_SELECT_FIELDS` becomes `'_id userId eventType eventDescription metadata userAgent deviceId timestamp severity createdAt'`.
- Delete lines 152-154 (`rawIpAddress` + `ipAddress` extraction); keep the `userAgent` extraction and update the stale comment above it to `// Extract and sanitize user agent`.
- Remove `ipAddress,` from the duplicate-placeholder object (line 196) and from `new SecurityActivity({...})` (line 211).

- [ ] **Step 3: Controller — drop from DTO**

In `controllers/securityActivity.controller.ts` delete line 106 (`ipAddress: activity.ipAddress,`).

- [ ] **Step 4: Run tests, fix IP-specific assertions by deletion**

Run: `cd packages/api && bun run test`
Expected: failures ONLY in tests asserting `ipAddress` on security activity — delete those assertions (do not re-add the field).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/models/SecurityActivity.ts packages/api/src/services/securityActivityService.ts packages/api/src/controllers/securityActivity.controller.ts
git commit -m "feat(api): SecurityActivity no longer captures or serves IP addresses"
```

---

### Task 3: Session + deviceUtils — no IP, no geo, IP out of deviceId hash

**Files:**
- Modify: `packages/api/src/models/Session.ts:14,16,62,64`
- Modify: `packages/api/src/utils/deviceUtils.ts` (DeviceFingerprint, DeviceInfo, UNRESOLVABLE_IPS, deriveStableDeviceId, extractDeviceInfo)
- Modify: `packages/api/src/services/session.service.ts:522,581,583`
- Test: `packages/api/src/utils/__tests__/deviceUtils.test.ts`, `packages/api/src/services/__tests__/session.service.test.ts`, `packages/api/src/services/__tests__/session.service.managedSwitch.test.ts`

**Interfaces:**
- Produces: `deriveStableDeviceId(userAgent: string, acceptLanguage: string, userId?: string | null): string | null` (IP parameter REMOVED — update every caller; find them with `grep -rn "deriveStableDeviceId(" packages/api/src`). `DeviceInfo` loses `ipAddress` and `location`. `DeviceFingerprint` loses `ipAddress`.

- [ ] **Step 1: Update deviceUtils tests first (TDD on the new signature)**

In `deviceUtils.test.ts`: change every `deriveStableDeviceId(ua, ip, lang, userId)` call to `deriveStableDeviceId(ua, lang, userId)`. DELETE test cases that assert IP-driven behavior (null on `'127.0.0.1'`/`'::1'`/missing IP; different id per IP). ADD:

```typescript
it('derives the same deviceId regardless of network (no IP input)', () => {
  process.env.DEVICE_ID_SALT = 'test-salt-0123456789abcdef';
  const a = deriveStableDeviceId('Mozilla/5.0 (X11; Linux x86_64)', 'en-US', 'user1');
  expect(a).toMatch(/^[a-f0-9]{32}$/);
  expect(deriveStableDeviceId('Mozilla/5.0 (X11; Linux x86_64)', 'en-US', 'user1')).toBe(a);
});

it('extractDeviceInfo returns no ipAddress and no location', () => {
  const req = {
    headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', 'cf-ipcountry': 'ES' },
    ip: '203.0.113.7',
    connection: { remoteAddress: '203.0.113.7' },
  } as unknown as Request;
  const info = extractDeviceInfo(req);
  expect('ipAddress' in info).toBe(false);
  expect('location' in info).toBe(false);
});
```

Run: `cd packages/api && bunx jest src/utils/__tests__/deviceUtils.test.ts` → FAIL (old signature).

- [ ] **Step 2: Rewrite deviceUtils.ts**

- `DeviceFingerprint`: delete `ipAddress: string;` (line 18).
- `DeviceInfo`: delete `ipAddress?: string;` (32) and `location?: string;` (34).
- Delete `const UNRESOLVABLE_IPS ...` (line 43).
- `deriveStableDeviceId` — new signature and body (doc comment: replace the IP mentions; state that IP is deliberately NOT an input because a salted hash over the IPv4 space is brute-forceable and IP-churn made ids unstable):

```typescript
export function deriveStableDeviceId(
  userAgent: string,
  acceptLanguage: string,
  userId?: string | null
): string | null {
  if (!userAgent || userAgent === 'unknown') {
    return null;
  }
  const salt = getDeviceIdSalt();
  if (!salt) {
    return null;
  }
  const userScope = userId && userId.length > 0 ? userId : PRE_AUTH_USER_SCOPE;
  return crypto
    .createHash('sha256')
    .update(`${salt}|${userScope}|${userAgent}|${acceptLanguage}`)
    .digest('hex')
    .slice(0, 32);
}
```

- `extractDeviceInfo`: delete `const ipAddress = req.ip || req.connection.remoteAddress;` (219); change the derive call (230) to `deriveStableDeviceId(userAgent, acceptLanguage, userId)`; delete `ipAddress,` (247) and the `location: req.headers['cf-ipcountry'] ...` line (249) from the returned object.
- Update ALL other `deriveStableDeviceId(` callers found by grep to the 3-arg form.

- [ ] **Step 3: Session model + service writes**

`models/Session.ts`: delete `ipAddress?: string;` (14) and `location?: string; // General location...` (16) from `ISession`; delete `ipAddress: String,` (62) and `location: String,` (64) from the schema.

`services/session.service.ts`: delete `'deviceInfo.ipAddress': deviceInfo.ipAddress,` (line 522) and `ipAddress: deviceInfo.ipAddress,` / `location: deviceInfo.location,` (581, 583). Then sweep the whole package: `grep -rn "deviceInfo\.ipAddress\|deviceInfo\.location\|deviceInfo\['ipAddress'\]" packages/api/src --include='*.ts'` — every remaining source hit (outside civic/anomaly, handled in Tasks 4-5) must be removed.

- [ ] **Step 4: Run tests, fix session fixtures**

Run: `cd packages/api && bun run test`
Expected: `session.service.test.ts` / `session.service.managedSwitch.test.ts` fixtures that set or assert `deviceInfo.ipAddress`/`location` fail — delete those properties/assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/models/Session.ts packages/api/src/utils/deviceUtils.ts packages/api/src/services/session.service.ts packages/api/src/utils/__tests__/deviceUtils.test.ts packages/api/src/services/__tests__/session.service.test.ts packages/api/src/services/__tests__/session.service.managedSwitch.test.ts
git commit -m "feat(api): sessions store no IP or geo; deviceId hash no longer mixes IP"
```

---

### Task 4: Anomaly detection — remove the IP-change detector

**Files:**
- Modify: `packages/api/src/services/anomalyDetection.service.ts`

- [ ] **Step 1: Delete `detectRapidIPChanges`** (lines 108-145) entirely.

- [ ] **Step 2: Update `checkForAnomalies`** — remove `rapidIP` from the parallel array and its anomaly push:

```typescript
const [newLocation, newDevice, impossibleTravel] = await Promise.all([
  this.detectNewLocation(userId, location),
  this.detectNewDevice(userId, deviceInfo),
  this.detectImpossibleTravel(userId, location),
]);
```

Delete the `if (rapidIP.isAnomaly) { ... 'rapid_ip_change' ... }` block (lines 193-198).

- [ ] **Step 3: Verify + commit**

Run: `cd packages/api && bun run test` → green (grep first for `rapid_ip_change`/`detectRapidIPChanges` in tests; delete matching cases).

```bash
git add packages/api/src/services/anomalyDetection.service.ts
git commit -m "feat(api): drop IP-based anomaly detection"
```

---

### Task 5: Civic anti-sybil — device-only signal; logs scrubbed

**Files:**
- Modify: `packages/api/src/services/civic/graphExclusion.ts`
- Modify: `packages/api/src/services/civic/sybil.service.ts:66-99`
- Modify: every `isSockPuppetRelation`/`sessionFingerprints`/`shareDeviceOrIp` caller (`grep -rn "ignoreSharedIp\|sessionFingerprints\|shareDeviceOrIp\|shared_ip" packages/api/src --include='*.ts'`) — includes `services/civic/validator.service.ts` and the attestation service that passes `ignoreSharedIp: true`
- Modify: `packages/api/src/middleware/csrf.ts` (5× `ip: req.ip`), `packages/api/src/middleware/performance.ts:23`, `packages/api/src/routes/auth.ts:2732`
- Test: `packages/api/src/services/__tests__/civic.graphExclusion.test.ts`

**Interfaces:**
- Produces (clean renames, update all callers): `sessionDeviceIds(userId: string): Promise<Set<string>>` (replaces `sessionFingerprints` — devices only), `shareDevice(a: string, b: string): Promise<boolean>` (replaces `shareDeviceOrIp`), `ExclusionReason = 'self' | 'graph_neighbor' | 'shared_device'`, `isSockPuppetRelation(a, b, opts?: { hops?: number })` (no `ignoreSharedIp`).

- [ ] **Step 1: Update `civic.graphExclusion.test.ts` first** — delete `shared_ip` / `ignoreSharedIp` cases; rename helpers to the new names; keep shared-device cases. Run: `cd packages/api && bunx jest src/services/__tests__/civic.graphExclusion.test.ts` → FAIL.

- [ ] **Step 2: Rewrite `graphExclusion.ts`**

```typescript
export type ExclusionReason = 'self' | 'graph_neighbor' | 'shared_device';

/** Collect a user's active-session device ids. IPs are deliberately NOT a
 * signal: the platform stores no user IPs (privacy invariant — see
 * docs/superpowers/specs/2026-07-14-no-ip-storage-design.md). `deviceId` is
 * the high-confidence per-install identifier (fingerprint rationale below). */
export async function sessionDeviceIds(userId: string): Promise<Set<string>> {
  const sessions = await Session.find({ userId, isActive: true })
    .select('deviceId')
    .lean();
  const devices = new Set<string>();
  for (const session of sessions) {
    const record = session as { deviceId?: string };
    if (record.deviceId) devices.add(record.deviceId);
  }
  return devices;
}

/** True when `a` and `b` share an active-session deviceId. */
export async function shareDevice(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sessionDeviceIds(a), sessionDeviceIds(b)]);
  for (const device of da) {
    if (db.has(device)) {
      return true;
    }
  }
  return false;
}

export async function isSockPuppetRelation(
  a: string,
  b: string,
  opts: { hops?: number } = {},
): Promise<ExclusionResult> {
  if (a === b) {
    return { excluded: true, reason: 'self' };
  }
  if (await areGraphRelated(a, b, opts.hops ?? 1)) {
    return { excluded: true, reason: 'graph_neighbor' };
  }
  if (await shareDevice(a, b)) {
    return { excluded: true, reason: 'shared_device' };
  }
  return { excluded: false };
}
```

Preserve the existing fingerprint-exclusion doc comment on the device-id rationale; delete the header-comment's "SHARED DEVICE / IP" mention of IP, the `ignoreSharedIp` doc, and the `logger` import if now unused.

- [ ] **Step 3: Update `sybil.service.ts`** — `computeSharedFingerprintSignal` uses devices only:

```typescript
for (const accountId of accounts) {
  const devices = await sessionDeviceIds(accountId);
  const prints = [...devices].map((d) => `d:${d}`);
  // ... rest unchanged
```

Update the function doc from "Shared-device/IP cluster signal" to "Shared-device cluster signal". Update the import.

- [ ] **Step 4: Update remaining callers** — validator.service.ts needs no code change (only its doc comment: "shared device/IP" → "shared device"); the attestation caller drops `ignoreSharedIp: true` and its comment. Grep to confirm zero remaining references: `grep -rn "ignoreSharedIp\|shared_ip\|shareDeviceOrIp\|sessionFingerprints" packages/api/src --include='*.ts'` → empty.

- [ ] **Step 5: Scrub logs** — delete the `ip: req.ip,` line in: `middleware/csrf.ts` (5 sites: ~99, ~112, ~127, ~151, ~169), `middleware/performance.ts:23`, `routes/auth.ts:2732`. Then `grep -rn "req\.ip" packages/api/src --include='*.ts' | grep -v __tests__` must return ONLY `utils/ipKey.ts`.

- [ ] **Step 6: Run + commit**

Run: `cd packages/api && bun run test` → green.

```bash
git add packages/api/src/services/civic/ packages/api/src/services/__tests__/civic.graphExclusion.test.ts packages/api/src/middleware/csrf.ts packages/api/src/middleware/performance.ts packages/api/src/routes/auth.ts
git commit -m "feat(api): civic anti-sybil is device-only; logs carry no IPs"
```

---

### Task 6: Dormant `ApiKeyUsage.ipAddress` + `@oxy.so/core` type

**Files:**
- Modify: `packages/api/src/models/ApiKeyUsage.ts:15,72-74`
- Modify: `packages/core/src/models/interfaces.ts:651`

- [ ] **Step 1:** Delete `ipAddress?: string;` from `IApiKeyUsage` and the `ipAddress: { type: String },` schema block in `ApiKeyUsage.ts`.

- [ ] **Step 2:** Delete `ipAddress?: string;` from the `SecurityActivity` interface in `packages/core/src/models/interfaces.ts` (line 651).

- [ ] **Step 3:** Rebuild core so downstream workspaces resolve the new type: `bun run core:build` (repo root). Then `cd packages/core && bun run test` → green (722 ± removed).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/models/ApiKeyUsage.ts packages/core/src/models/interfaces.ts
git commit -m "feat(core+api): remove ipAddress from SecurityActivity type and dormant ApiKeyUsage field"
```

NOTE: this is an SDK type removal — `@oxy.so/core` gets its version bump + npm publish with the next release train (do NOT publish from this branch; see AGENTS.md publish rules).

---

### Task 7: Accounts UI — stop rendering IP

**Files:**
- Modify: `packages/accounts/utils/activity-format.ts:162-182`
- Modify: `packages/accounts/components/security/useSecurityActivityItems.ts:52-65`
- Modify: `packages/accounts/components/activity/activity-details-panel.tsx:57-62`
- Modify: i18n locales containing `detailIp` (`grep -rn "detailIp" packages/accounts`)

- [ ] **Step 1:** `getEventSubtitle` — remove the IP branches:

```typescript
/** Row subtitle (relative time + optional device name). */
export function getEventSubtitle(
    event: SecurityActivity,
    formatters: DayFormatters,
    t: TranslateFn,
): string {
    const relative = formatRelativeTime(event.timestamp, formatters, t);
    const deviceName =
        event.metadata && typeof event.metadata === 'object'
            ? (event.metadata as { deviceName?: unknown }).deviceName
            : undefined;
    const deviceLabel = typeof deviceName === 'string' ? deviceName : null;

    if (deviceLabel) return `${relative} • ${deviceLabel}`;
    return relative;
}
```

- [ ] **Step 2:** `useSecurityActivityItems.ts` — delete the `activity.ipAddress ? ... detailIp ... : null,` entry (line 57) from the details array; update the comment on line 52 (`// Show details on press - include device info, etc.`).

- [ ] **Step 3:** `activity-details-panel.tsx` — delete the `if (event.ipAddress) { ... }` block (~lines 57-62).

- [ ] **Step 4:** Remove the now-unused `security.activity.detailIp` key from every locale file that has it.

- [ ] **Step 5:** Typecheck + commit. Run accounts typecheck (`cd packages/accounts && bunx tsc --noEmit`) — core was rebuilt in Task 6, so any lingering `ipAddress` usage fails here.

```bash
git add packages/accounts/utils/activity-format.ts packages/accounts/components/security/useSecurityActivityItems.ts packages/accounts/components/activity/activity-details-panel.tsx packages/accounts/lib/i18n/
git commit -m "feat(accounts): security activity UI no longer shows IP addresses"
```

---

### Task 8: Purge script (historical prod data)

**Files:**
- Create: `packages/api/scripts/purge-ip-data.ts`

- [ ] **Step 1: Write the script** (mirrors the existing one-shot script pattern in `packages/api/scripts/`; supports `DRY_RUN`):

```typescript
/**
 * One-shot purge of historical IP data (privacy invariant: no user IPs at rest).
 * Removes: securityactivities.ipAddress, sessions.deviceInfo.{ipAddress,location},
 * apikeyusages.ipAddress. Idempotent. DRY_RUN=1 counts without writing.
 * Run as a one-shot ECS task AFTER deploying the api that stops new IP writes.
 */
import mongoose from 'mongoose';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }
  const dryRun = process.env.DRY_RUN === '1';
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('No database handle after connect');
  }

  const targets = [
    { collection: 'securityactivities', filter: { ipAddress: { $exists: true } }, unset: { ipAddress: 1 } },
    {
      collection: 'sessions',
      filter: { $or: [{ 'deviceInfo.ipAddress': { $exists: true } }, { 'deviceInfo.location': { $exists: true } }] },
      unset: { 'deviceInfo.ipAddress': 1, 'deviceInfo.location': 1 },
    },
    { collection: 'apikeyusages', filter: { ipAddress: { $exists: true } }, unset: { ipAddress: 1 } },
  ] as const;

  for (const target of targets) {
    if (dryRun) {
      const count = await db.collection(target.collection).countDocuments(target.filter);
      console.log(`[DRY_RUN] ${target.collection}: ${count} docs would be updated`);
    } else {
      const result = await db.collection(target.collection).updateMany(target.filter, { $unset: target.unset });
      console.log(`${target.collection}: ${result.modifiedCount} docs purged`);
    }
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Dry-run locally** (needs local mongod; skip if not running): `cd packages/api && DRY_RUN=1 MONGODB_URI=mongodb://127.0.0.1:27017/oxy-dev bunx ts-node scripts/purge-ip-data.ts` — match the invocation style of the sibling scripts (check how `backfill-contact-hashes.ts` is documented/run and use the same runner).

- [ ] **Step 3: Commit**

```bash
git add packages/api/scripts/purge-ip-data.ts
git commit -m "feat(api): one-shot purge script for historical IP data"
```

---

### Task 9: Full verification gate

- [ ] **Step 1:** Final IP sweep — each must return ONLY sanctioned hits (`ipKey.ts`, email-inbound header storage, tests):

```bash
grep -rn "req\.ip\b\|remoteAddress\|x-forwarded-for\|cf-ipcountry" packages/api/src --include='*.ts' | grep -v __tests__
grep -rn "ipAddress" packages/api/src packages/core/src packages/accounts --include='*.ts' --include='*.tsx' | grep -v __tests__
```

- [ ] **Step 2:** Full test-build gate (per-package correct runners + builds): api `bun run test`, core `bun run test`, contracts/services unaffected but run root `bun run test` via turbo, plus `bun run build:all`. All green before push.

- [ ] **Step 3:** Add the durable rule to `packages/api`'s governing docs: in `/home/nate/Oxy/OxyHQServices/AGENTS.md` (Auth/Session or Coding Standards section) add — "**No user IPs at rest (privacy invariant):** never persist user IP addresses — raw, hashed, or geo-derived (country included) — in MongoDB, logs, or metrics. Anonymous rate-limit keys must go through `hashedIpKey` (`packages/api/src/utils/ipKey.ts`). Inbound-email `Received:` headers (third-party sender IPs) are the one sanctioned exception."

- [ ] **Step 4:** Push branch, open PR, check CI + bot reviews (gemini/CodeQL), merge on green, deploy, THEN run the purge script as a one-shot ECS task (Task 8 rollout order).
