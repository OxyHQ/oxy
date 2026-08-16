/**
 * Expiry Sweep Registry — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. Fourteen models relied on one, so every table
 * that needs it adds an entry here rather than growing its own cleanup path.
 * The mechanism that reads this registry (`sweepExpiredRows`,
 * `sweepAllExpiredRows`) lives in `@oxyhq/db/expiry` — shared plumbing with no
 * opinion on which tables to sweep. This registry is this schema's own data.
 *
 * ## The shape
 *
 * A Mongo TTL index is `{ <field>: 1 }, { expireAfterSeconds: N }` — delete a
 * document once `<field>` is more than N seconds in the past. A registry entry
 * is exactly that pair, so no semantic can be lost in translation:
 *
 *   { table, column, retentionSeconds }  →  delete where column <= now() - N
 *
 * All three uses in the Mongo schema collapse into it:
 *
 *   - `expireAfterSeconds: 0` on `expiresAt` — the column IS the deadline
 *     (`retentionSeconds: 0`).
 *   - `expireAfterSeconds: N` on `createdAt`/`timestamp` — a retention window
 *     on a birth column.
 *   - `expireAfterSeconds: N` on `expiresAt` — a deliberate GRACE window: the
 *     row outlives its own deadline by N seconds so a read can still answer
 *     "expired" rather than "never existed". Same entry, different column.
 *
 * ## Coexistence with read paths — the part that must not be lost
 *
 * Mongo's TTL monitor runs about once a minute, so an expired document stays
 * readable for up to ~60s. A sweep has the same property. Two classes of read
 * path exist today and they are NOT interchangeable:
 *
 *   (A) Reads that filter on expiry themselves — `expiresAt: { $gt: new Date() }`
 *       in `session.controller.ts:297`, `authSession.service.ts:280`,
 *       `authLinking.ts:303`. For these the sweep is pure housekeeping;
 *       correctness never depends on it. **Port every one of those filters
 *       verbatim.** Dropping one because "the sweep handles it" turns a bounded
 *       lag into a live credential.
 *
 *   (B) Reads that do NOT filter and rely on the row already being gone —
 *       `senderAvatar.service.ts:179` and `:208` return the cached row with no
 *       expiry predicate and no application-side check. For those the sweep is
 *       a CORRECTNESS mechanism, not housekeeping, and the interval is how
 *       stale a served value can be. The right fix on port is to add the
 *       read-side filter and move them into class (A) — then the sweep is
 *       housekeeping everywhere and no table's correctness depends on a job
 *       running.
 *
 * ## Scheduling
 *
 * `sweepExpiredRows` (`@oxyhq/db/expiry`) is the mechanism; wiring it to a
 * schedule belongs with the call-site port, alongside the BullMQ repeatable
 * jobs already in `src/queue/` (env-gated on `REDIS_URL`, inline fallback when
 * absent). Until then it is callable and tested, and nothing reads a swept
 * table yet.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { AFFINITY_EVENT_SEEN_TTL_SECONDS } from '../utils/recommendationWeights';
import { appAffinitySeenEvents } from './schema/appAffinitySeenEvents';
import {
  CREDENTIAL_AUDIT_RETENTION_SECONDS,
  applicationCredentialAuditEvents,
} from './schema/applicationCredentialAuditEvents';
import { authChallenges } from './schema/authChallenges';
import { authCodes } from './schema/authCodes';
import { authSessions } from './schema/authSessions';
import { civicNonces } from './schema/civicNonces';
import {
  PROVIDER_CONNECTION_AUDIT_RETENTION_SECONDS,
  inferenceProviderConnectionAuditEvents,
} from './schema/inferenceProviderConnectionAuditEvents';
import { devicePairingSessions } from './schema/devicePairingSessions';
import { domainVerifications } from './schema/domainVerifications';
import {
  SECURITY_ACTIVITY_RETENTION_SECONDS,
  securityActivities,
} from './schema/securityActivities';
import { senderAvatars } from './schema/senderAvatars';
import { sessions } from './schema/sessions';
import { webauthnChallenges } from './schema/webauthnChallenges';

import {
  API_KEY_USAGE_RETENTION_SECONDS,
  apiKeyUsageEvents,
} from './schema/apiKeyUsageEvents';
import {
  INFERENCE_USAGE_RETENTION_SECONDS,
  inferenceUsageEvents,
} from './schema/inferenceUsageEvents';

/**
 * Every table that had a Mongo TTL index. A table with an expiry column but no
 * entry here is never swept.
 */
export const EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: authChallenges,
    column: authChallenges.expiresAt,
    retentionSeconds: 0,
    reason:
      'Housekeeping only — every read already filters `expires_at > now()`, ' +
      'so a challenge is unspendable the instant it expires.',
  },
  {
    table: appAffinitySeenEvents,
    column: appAffinitySeenEvents.createdAt,
    retentionSeconds: AFFINITY_EVENT_SEEN_TTL_SECONDS,
    reason:
      'Bounds the idempotency ledger. Deleting a marker reopens the dedup ' +
      'window for an event nobody is still retrying.',
  },
  {
    table: sessions,
    column: sessions.expiresAt,
    retentionSeconds: 0,
    reason:
      'Housekeeping only — every session lookup already filters ' +
      '`is_active` plus `expires_at > now()`, so an expired session is ' +
      'unusable the instant it expires rather than when the sweep runs.',
  },
  {
    table: authCodes,
    column: authCodes.expiresAt,
    retentionSeconds: 300,
    reason:
      'The 5-minute pad is DELIBERATE, not slack: the row outlives its own ' +
      'deadline so a replay of a just-expired code is still recognised as a ' +
      'replay (`used_at` is set) instead of answering "no such code". ' +
      'Lowering it to 0 converts a detected replay into an indistinguishable ' +
      'miss.',
  },
  {
    table: authSessions,
    column: authSessions.expiresAt,
    retentionSeconds: 3600,
    reason:
      'Grace window — the request outlives its deadline for an hour so a late ' +
      'poll is told "expired" rather than "never existed". Every read filters ' +
      'expiry itself, so nothing depends on the sweep for correctness.',
  },
  {
    table: devicePairingSessions,
    column: devicePairingSessions.expiresAt,
    retentionSeconds: 0,
    reason:
      'Storage reclamation ONLY. The verdict a user sees comes from the lazy ' +
      'read path (`deviceTransfer.service.ts:98`), which marks a past-deadline ' +
      'pending row `expired` before the sweep reaches it — deleting it sooner ' +
      'would turn every expired transfer into an unknown one.',
  },
  {
    table: webauthnChallenges,
    column: webauthnChallenges.expiresAt,
    retentionSeconds: 0,
    reason:
      'Housekeeping only — the ceremony verify step checks the deadline and ' +
      'burns `used` atomically, so a challenge is unspendable at expiry.',
  },
  {
    table: domainVerifications,
    column: domainVerifications.expiresAt,
    retentionSeconds: 0,
    reason:
      'Housekeeping only — `identity.ts:439` compares `expires_at` against now ' +
      'and refuses a stale challenge, and a proven domain deletes its own row.',
  },
  {
    table: civicNonces,
    column: civicNonces.expiresAt,
    retentionSeconds: 600,
    reason:
      'SECURITY parameter, not housekeeping: the row IS the used-nonce record, ' +
      'so deleting it frees its hash for reuse. The 10-minute pad is how long ' +
      'a replay stays detectable past the nonce\'s own deadline.',
  },
  {
    table: securityActivities,
    column: securityActivities.occurredAt,
    retentionSeconds: SECURITY_ACTIVITY_RETENTION_SECONDS,
    reason:
      'Two-year audit retention measured from the EVENT, bounding growth ' +
      'while keeping enough history for the activity surface. No read filters ' +
      'on it — an old entry is stale, never unsafe.',
  },
  {
    table: senderAvatars,
    column: senderAvatars.expiresAt,
    retentionSeconds: 0,
    reason:
      'Bounds the avatar cache. Housekeeping ONLY because the port adds the ' +
      'read-side filter Mongo never had — `senderAvatarIsFresh()`. Without ' +
      'that filter this entry would be the sole thing keeping a stale avatar ' +
      'off the screen, which is the class-(B) read this module warns about.',
  },
  {
    table: applicationCredentialAuditEvents,
    column: applicationCredentialAuditEvents.createdAt,
    retentionSeconds: CREDENTIAL_AUDIT_RETENTION_SECONDS,
    reason:
      'Two-year credential lifecycle retention, the same window ' +
      '`security_activities` keeps for the account trail. Nothing reads this ' +
      'table with an expiry predicate and nothing needs to — an old audit ' +
      'entry is stale, never unsafe — so the sweep is purely what bounds ' +
      'growth.',
  },
  {
    table: inferenceProviderConnectionAuditEvents,
    column: inferenceProviderConnectionAuditEvents.createdAt,
    retentionSeconds: PROVIDER_CONNECTION_AUDIT_RETENTION_SECONDS,
    reason:
      'Two-year BYOK connection retention, the same window the credential ' +
      'trail and `security_activities` keep. This sweep is NOT optional ' +
      'housekeeping: `used` events accrue for the life of every connection, ' +
      'bounded only by a per-instance cooldown, so without it the table grows ' +
      'without end. It is also why the immutability trigger on this table ' +
      'guards UPDATE and not DELETE — a DELETE guard would fail this sweep on ' +
      'every run rather than make the trail safer. See ' +
      '`schema/inferenceProviderConnectionImmutability.ts`.',
  },
  {
    table: apiKeyUsageEvents,
    column: apiKeyUsageEvents.createdAt,
    retentionSeconds: API_KEY_USAGE_RETENTION_SECONDS,
    reason:
      'Ninety days of request telemetry, exactly as the Mongo TTL kept. The ' +
      'two readers already bound their own window (`timestamp: { $gte: since }`, ' +
      '`routes/credits.ts:59` and `routes/applications.ts:961`), so the sweep ' +
      'is housekeeping and no reported figure depends on it running.',
  },
  {
    table: inferenceUsageEvents,
    column: inferenceUsageEvents.createdAt,
    retentionSeconds: INFERENCE_USAGE_RETENTION_SECONDS,
    reason:
      'Ninety days of inference telemetry, the same window `api_key_usage_events` ' +
      'has. Detail only: `inference_usage_daily_rollups` is NOT swept, so usage ' +
      'history outlives the per-request rows it was built from. The financial ' +
      'tables — `usage_receipts`, `usage_refunds`, `usage_reservations`, ' +
      '`billing_ledger_entries`, `billing_ledger_postings` — must NEVER appear ' +
      'in this registry: a receipt swept on a telemetry schedule is a destroyed ' +
      'financial record, and it would be silent. ' +
      '`db/__tests__/inferenceLedgerRetention.test.ts` fails if one is added.',
  },
];
