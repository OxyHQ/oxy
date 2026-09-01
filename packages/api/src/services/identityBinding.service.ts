/**
 * Identity binding — the primitive that makes "no binding proof, no Oxy Trust
 * effect" enforceable rather than aspirational.
 *
 * Before this module, an application reporting moderation could name any Oxy
 * user id and be believed: `award` accepted a bare id. That is the hole the
 * whole reputation bridge is built around, so the binding is not a formality —
 * it is the authorization boundary.
 *
 * WHAT COUNTS AS PROOF, strongest first:
 *
 *  1. `oauth_grant` — the user authorized the application through Oxy's own
 *     OAuth flow, and Oxy wrote the `app_grants` row itself. The application
 *     asserts nothing, and `firstGrantedAt` is Oxy's own record of when the
 *     person was present. This is preferred whenever a grant exists, even when
 *     the registration call arrives later, because an earlier verifiable instant
 *     covers strictly more reported actions.
 *  2. `session_proof` — the application presents the USER'S OWN Oxy access
 *     token alongside its service credential. An application can only hold that
 *     token if the person signed in to it through Oxy, so it proves presence.
 *     This path exists because trusted first-party applications are
 *     auto-approved at authorize time and record NO grant — without it, exactly
 *     the applications closest to Oxy would be the ones unable to prove
 *     anything.
 *
 * NO PROOF MATERIAL IS PERSISTED. The token is verified and discarded; what
 * survives is that the check passed and when. Storing it would turn this table
 * into a credential store, which a binding record is not worth.
 *
 * The time comparison is the part most easily mistaken for decoration. A
 * binding created AFTER the reported action proves that the person is in the
 * application now, not that they were the actor then — so
 * {@link resolveBindingProof} rejects it.
 *
 * ## The cutover bug this port removes
 *
 * Every id here used to pass through a `mongoose.Types.ObjectId.isValid` check
 * before it was allowed to reach a query:
 *
 * ```ts
 * function toObjectId(value: string, field: string): mongoose.Types.ObjectId {
 *   if (!mongoose.Types.ObjectId.isValid(value)) throw new BadRequestError(...);
 *   return new mongoose.Types.ObjectId(value);
 * }
 * // …and, at the top of resolveBindingProof:
 * if (!mongoose.Types.ObjectId.isValid(params.bindingProofId)) {
 *   return { ok: false, reason: 'no_binding_proof' };
 * }
 * ```
 *
 * That regex rejects the **uuid v7 every row created after the Postgres cutover
 * carries** (`@oxyhq/db`'s `generatedId()`). `resolveBindingProof`
 * therefore answered `no_binding_proof` BEFORE QUERYING for any post-cutover
 * binding — so `applyModerationDecision` could not apply an effect at all for
 * such an account, however well-formed the event, however real the seeded
 * binding row. The failure is silent by construction: `no_binding_proof` is a
 * legitimate outcome the emitter is supposed to record and stop retrying on.
 *
 * Both guards are DELETED rather than widened. They only ever existed to stop a
 * malformed string reaching Mongoose as a `CastError`; every id here is now a
 * `text` column compared against a bound parameter, so a malformed value is a
 * value that matches no row — the same "no such binding" outcome it always
 * produced — and the real integrity work is done by the foreign keys on
 * `identity_bindings.application_id` and `.user_id`.
 * `__tests__/identityBinding.service.test.ts` pins this: reinstate either guard
 * and a moderation decision against a post-cutover account stops applying.
 */

import { and, eq } from 'drizzle-orm';
import type { ModerationEffectSkipReason } from '@oxyhq/contracts';

import { getDb } from '../config/postgres';
import { appGrants, identityBindings } from '../db/schema';
import { validateSessionToken } from '../middleware/authUtils';
import { UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';

/** One `identity_bindings` row, exactly as stored. */
export type IdentityBindingRecord = typeof identityBindings.$inferSelect;

/** What the registering application supplies, plus what its credential proved. */
export interface RegisterBindingParams {
  /** Resolved from the service credential — never from the request body. */
  applicationId: string;
  /** The credential that presented the proof, recorded for audit only. */
  credentialId?: string;
  /** The application's own identifier for this person. */
  localPrincipalId: string;
  /** The USER'S Oxy access token. Verified, then discarded. */
  userProofToken: string;
}

/** A binding resolution that produced a usable proof. */
export interface BindingResolved {
  ok: true;
  binding: IdentityBindingRecord;
}

/** A binding resolution that did not, and precisely why. */
export interface BindingRejected {
  ok: false;
  reason: Extract<
    ModerationEffectSkipReason,
    'no_binding_proof' | 'binding_after_action' | 'binding_principal_mismatch' | 'binding_revoked'
  >;
}

export type BindingResolution = BindingResolved | BindingRejected;

/**
 * Register (or refresh) the binding between an Oxy user and a local principal in
 * the calling application.
 *
 * Verifies the user's own access token, then takes the EARLIEST verifiable
 * instant of presence: an existing `app_grants` row beats the current moment,
 * because consent Oxy itself recorded is both stronger evidence and covers more
 * of the past. An application cannot make its binding look older than its
 * evidence — `verifiedAt` is derived here, never accepted from the caller.
 *
 * Rebinding a local principal to a DIFFERENT Oxy user revokes the previous
 * binding rather than overwriting it: a past effect references that row, and its
 * original `verifiedAt` is what made the effect legitimate. The revoke and the
 * insert run in ONE transaction, which Mongo could not offer: the partial unique
 * index `identity_bindings_application_id_local_principal_id_active_key` admits
 * exactly one ACTIVE row per (application, local principal), so a crash between
 * the two statements would otherwise leave the principal bound to nobody.
 *
 * @throws UnauthorizedError when the user proof token does not resolve.
 */
export async function registerIdentityBinding(
  params: RegisterBindingParams
): Promise<IdentityBindingRecord> {
  const { applicationId, credentialId } = params;

  const proofUser = await validateSessionToken(params.userProofToken);
  if (!proofUser) {
    throw new UnauthorizedError('The user proof token is invalid or expired');
  }
  const userId = proofUser._id;

  const db = getDb();

  // Prefer Oxy's own record of consent when one exists: it predates this call
  // and the application asserted none of it.
  const [grant] = await db
    .select({ firstGrantedAt: appGrants.firstGrantedAt })
    .from(appGrants)
    .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
    .limit(1);
  const bindingType = grant ? 'oauth_grant' : 'session_proof';
  const verifiedAt = grant?.firstGrantedAt ?? new Date();

  // Mongoose declared `localPrincipalId` with `trim: true`, which applied to
  // BOTH the write and the query filter it cast. Postgres has no counterpart, so
  // per `schema/CONVENTIONS.md` the normalization is re-applied at the call
  // site — otherwise a trailing space would silently create a SECOND binding for
  // the same person and the partial unique index would not object.
  const localPrincipalId = String(params.localPrincipalId).trim();

  const [existing] = await db
    .select()
    .from(identityBindings)
    .where(
      and(
        eq(identityBindings.applicationId, applicationId),
        eq(identityBindings.localPrincipalId, localPrincipalId),
        eq(identityBindings.status, 'active')
      )
    )
    .limit(1);

  if (existing && existing.userId === userId) {
    // Same person: keep the earliest proven instant. A refresh must never move
    // `verifiedAt` forward, or re-registering would retroactively invalidate the
    // reported actions the original binding already covered.
    const earlier = verifiedAt < existing.verifiedAt;
    const [refreshed] = await db
      .update(identityBindings)
      .set({
        verifiedAt: earlier ? verifiedAt : existing.verifiedAt,
        bindingType: earlier ? bindingType : existing.bindingType,
        credentialId: credentialId ?? null,
      })
      .where(eq(identityBindings.id, existing.id))
      .returning();
    return refreshed;
  }

  return db.transaction(async (tx) => {
    if (existing) {
      // `status` and `revoked_at` move together or the row fails the
      // `identity_bindings_revoked_at_check` CHECK — Mongo could express
      // neither half, so a row could read `active` while carrying a
      // `revokedAt`, and the engine's "is not revoked" test reads `status`.
      await tx
        .update(identityBindings)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(identityBindings.id, existing.id));
      logger.warn('Identity binding rebound to a different Oxy user', {
        component: 'identityBinding',
        applicationId,
        bindingId: existing.id,
      });
    }

    const [created] = await tx
      .insert(identityBindings)
      .values({
        applicationId,
        userId,
        localPrincipalId,
        bindingType,
        status: 'active',
        verifiedAt,
        credentialId: credentialId ?? null,
      })
      .returning();
    return created;
  });
}

/** What {@link resolveBindingProof} needs in order to decide. */
export interface ResolveBindingParams {
  /**
   * The application the reported action happened in. The lookup is SCOPED to it,
   * so a binding another application holds is simply not found — an emitter
   * cannot borrow a proof from a tenant it does not speak for.
   */
  applicationId: string;
  /** The `bindingProofId` the event carried. */
  bindingProofId: string;
  /** The Oxy user the event claims the actor resolves to. */
  principalId: string;
  /** When the REPORTED ACTION happened. */
  occurredAt: Date;
}

/**
 * Decide whether a binding proves that `principalId` was the actor at
 * `occurredAt` in `applicationId`.
 *
 * Returns a rejection rather than throwing: a missing or stale binding is a
 * legitimate outcome of a well-formed event, and the emitter must be able to
 * record "delivered, no effect" and stop retrying instead of hammering a
 * permanent error.
 *
 * There is deliberately NO id-shape precheck. See the module header: the one
 * that used to stand here answered `no_binding_proof` without querying for every
 * post-cutover id, which is indistinguishable from a genuine miss.
 */
export async function resolveBindingProof(
  params: ResolveBindingParams
): Promise<BindingResolution> {
  const [binding] = await getDb()
    .select()
    .from(identityBindings)
    .where(
      and(
        eq(identityBindings.id, params.bindingProofId),
        eq(identityBindings.applicationId, params.applicationId)
      )
    )
    .limit(1);
  if (!binding) {
    return { ok: false, reason: 'no_binding_proof' };
  }

  if (binding.userId !== params.principalId) {
    return { ok: false, reason: 'binding_principal_mismatch' };
  }

  // A revoked binding is a statement that the mapping was withdrawn or wrong.
  // Refusing to penalise on a withdrawn proof is the conservative direction, and
  // effects already applied keep referencing the row for audit.
  if (binding.status !== 'active') {
    return { ok: false, reason: 'binding_revoked' };
  }

  // THE time check. A binding verified after the action proves the person is in
  // the application now, not that they were the actor then.
  if (binding.verifiedAt.getTime() > params.occurredAt.getTime()) {
    return { ok: false, reason: 'binding_after_action' };
  }

  return { ok: true, binding };
}
