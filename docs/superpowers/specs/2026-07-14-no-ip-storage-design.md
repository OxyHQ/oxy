# No IP Storage — Privacy Design

**Date:** 2026-07-14
**Status:** Approved
**Owner requirement:** user privacy is paramount (threat model includes state-actor harassment of users). Zero user IP addresses at rest — raw, hashed, or geo-derived. Salted hashes of IPv4 addresses are brute-forceable by anyone with server access, so hashing is NOT an acceptable at-rest form for historical data.

## Scope

`packages/api` (primary), `packages/accounts` (UI rendering of IP), one-shot prod purge script. Inbound email `Received:` headers (third-party sender IPs) are explicitly **kept** (owner decision — standard email practice, not Oxy-user IPs).

## Changes

### 1. SecurityActivity — no IP capture
- Remove `ipAddress` field from `packages/api/src/models/SecurityActivity.ts`.
- `services/securityActivityService.ts`: stop reading `req.ip` / `req.socket.remoteAddress`; remove sanitize/truncate logic; remove `ipAddress` from `ACTIVITY_SELECT_FIELDS`.
- `controllers/securityActivity.controller.ts`: remove `ipAddress` from the `GET /security/activity` DTO.
- No location substitute: **no country either** (owner decision — no location signal of any kind in the security feed). Feed shows device + action + timestamp only.

### 2. Session — no IP, no geo
- Remove `deviceInfo.ipAddress` and `deviceInfo.location` from `packages/api/src/models/Session.ts`.
- `utils/deviceUtils.ts` `getDeviceInfo`: stop reading `req.ip` and `cf-ipcountry`.
- `services/session.service.ts`: remove the `deviceInfo.ipAddress` / `deviceInfo.location` writes (new-session and session-reuse paths).

### 3. deviceId derivation — IP removed from hash
- `utils/deviceUtils.ts` `deriveStableDeviceId`: drop the IP input (hash = salt|userScope|ua|lang). Rationale: sha256 with a known salt is reversible over the IPv4 space by brute force.
- Accepted trade-offs: (a) same user + same UA + same language on two devices dedupe to one deviceId — acceptable because device-first auth uses the client-persisted deviceId as authority; (b) existing derived deviceIds change once after deploy — stale session rows expire via the 7-day sliding TTL.
- `UNRESOLVABLE_IPS` sentinel handling goes away with the IP input.

### 4. Anomaly detection — IP-change detector removed
- Delete `detectRapidIPChanges` from `services/anomalyDetection.service.ts` and its trigger. Signal is moot: password login is being phased out in favor of Commons key identity.

### 5. Civic anti-sybil — IP signal removed
- `services/civic/graphExclusion.ts`: remove IP sets from `sessionFingerprints()`, the `shared_ip` exclusion reason, and the `ignoreSharedIp` option.
- `services/civic/sybil.service.ts`: remove `i:<ip>` inverted-index prints.
- `services/civic/validator.service.ts`: jury exclusion keeps device-fingerprint + interaction-history + affinity throttle. Accepted trade-off: weaker detection of multi-accounts behind one network.

### 6. Rate limiting — HMAC-truncated Redis keys (transient only)
- Anonymous rate limiting stays keyed per client, but the Redis key stores `hmac-sha256(salt, normalizedIp)` truncated — never the raw IP. TTL unchanged (windowMs). Hashing is acceptable HERE because keys live minutes, not history.
- One shared helper in `packages/api` (e.g. `utils/ipKey.ts` `hashedIpKey(req)`), reusing the existing required `DEVICE_ID_SALT`; IPv6-normalize via express-rate-limit's `ipKeyGenerator` before hashing.
- Apply to: default keyGenerators in `middleware/security.ts` (rl:general, rl:auth, rl:idp:service, rl:federation:service, rl:user anonymous fallback) and every route-level `…:ip:<ip>` keyGenerator (civic, links, contacts, userData, users, assets, accounts, nodes, identity routes).
- Follow-up (separate change): same treatment in `@oxy.so/core/server` `rateLimit.ts` for the other Oxy backends.

### 7. Logs — no IP fields
- Remove `ip: req.ip` from `middleware/csrf.ts` warn calls, `routes/auth.ts` service-token issue log, and `middleware/performance.ts` metric metadata.

### 8. Email inbound — unchanged
- `Message.headers` (incl. `Received:` chains with third-party sender IPs) kept as-is per owner decision.

### 9. Data purge (prod, irreversible — owner-confirmed)
- One-shot script `packages/api/scripts/purge-ip-data.ts`:
  - `securityactivities`: `$unset: { ipAddress: 1 }` (730-day TTL means live history exists)
  - `sessions`: `$unset: { 'deviceInfo.ipAddress': 1, 'deviceInfo.location': 1 }`
- Run as one-shot ECS task after the API deploy.

### 10. Cleanup + UI + docs
- Remove dormant `ApiKeyUsage.ipAddress` field (no writer exists).
- `packages/accounts`: remove IP rendering from `utils/activity-format.ts` and `components/security/useSecurityActivityItems.ts`; drop `ipAddress` from any activity type the UI/SDK declares.
- AGENTS.md gains the durable rule: never persist user IPs (raw, hashed, or geo-derived); transient anonymous rate-limit keys must be HMAC-hashed.

## Testing
- Update existing Jest suites touching securityActivity, session.service, deviceUtils, anomalyDetection, civic graphExclusion/sybil/validator, csrf, rate limiters.
- New assertions: security-activity DTO has no `ipAddress`; session docs persist no `deviceInfo.ipAddress`/`location`; rate-limit key for an anonymous request is a hash, not the IP.
- Baselines (correct runner per package): contracts 130, core 722, api 1322, services 195, auth 45 — counts may shift where IP-specific tests are removed.

## Rollout order
1. Land + deploy `packages/api` (stops new IP writes).
2. Run purge script (deletes historical IPs).
3. Accounts UI change ships with the same PR (renders nothing even if old field present).
