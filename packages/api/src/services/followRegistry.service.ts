/**
 * The registry: namespaces, kinds, and targets.
 *
 * This is the half of #809 an APPLICATION talks to, as opposed to the command
 * service, which is the half a USER's actions go through. The separation is not
 * cosmetic — every operation here is authorized against the application's
 * ownership of a namespace, and nothing here consults or changes what anybody
 * follows.
 *
 * ## Three levels, each answering a different question
 *
 * - A **namespace** answers "who is allowed to define this". Claimed once by an
 *   application and never released.
 * - A **kind** answers "what does following this mean" — the verb clients
 *   render, whether reverse lookups are public, whether it federates.
 * - A **target** answers "which thing" — one row per canonical URI, shared by
 *   every user who follows it and every application that shows it.
 *
 * ## Why targets are registered and not created by following
 *
 * `followTarget` takes a target id, never a URI. If following created targets
 * on demand, a typo would become a permanent row that one user follows and
 * nobody else can ever reach — and a client could mint unbounded rows by
 * following URIs it made up. Registration is the moment an application vouches
 * that the thing exists, and it is the operation that costs a scope.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { followNamespaces } from '../db/schema/followNamespaces';
import {
  followTargetKinds,
  type FollowKindCapabilities,
} from '../db/schema/followTargetKinds';
import { followTargets } from '../db/schema/followTargets';
import { users } from '../db/schema/users';
import type { FollowCapability } from './followCapability.service';

/**
 * A namespace is one lowercase segment. Mirrors the CHECK, so the API can say
 * why instead of surfacing a constraint name.
 *
 * Case is NORMALIZED before this is applied, not rejected: `Mercaria` and
 * `mercaria` naming two different namespaces would be a tenancy bug, since a
 * kind's prefix is matched as text and one application would end up owning the
 * name the other believes it registered.
 */
const NAMESPACE_SHAPE = /^[a-z][a-z0-9_]*$/;

/**
 * A kind is `<namespace>.<thing>`, with the thing a single segment too. Nesting
 * (`a.b.c`) is refused because `a.b` reading as a namespace is really a second
 * owner for `a`.
 */
const KIND_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const OXY_USER_KIND = 'oxy.user';
const OXY_USER_URI = /^https:\/\/oxy\.so\/users\/([^/?#]+)$/i;

/** Bounded, because this is stored on every target row and rendered by clients. */
const MAX_METADATA_BYTES = 4096;

export type RegistryFailure =
  | 'invalid_namespace'
  | 'invalid_kind'
  | 'namespace_taken'
  | 'namespace_not_owned'
  | 'namespace_in_use'
  | 'kind_not_owned'
  | 'unknown_kind'
  | 'metadata_too_large'
  | 'invalid_uri'
  | 'local_user_mismatch'
  | 'unknown_local_user';

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; reason: RegistryFailure };

function fail<T>(reason: RegistryFailure): RegistryResult<T> {
  return { ok: false, reason };
}

async function resolveLocalUserIdForTarget(input: {
  kind: string;
  uri: string;
  localUserId?: string;
}): Promise<RegistryResult<string | undefined>> {
  if (input.kind !== OXY_USER_KIND) {
    return { ok: true, value: undefined };
  }

  const parsed = OXY_USER_URI.exec(input.uri)?.[1];
  if (!parsed) return fail('invalid_uri');

  if (input.localUserId && input.localUserId !== parsed) {
    return fail('local_user_mismatch');
  }

  const localUserId = input.localUserId ?? parsed;
  const [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, localUserId))
    .limit(1);

  if (!user) return fail('unknown_local_user');
  return { ok: true, value: localUserId };
}

/**
 * Claim a namespace for the calling application.
 *
 * First come, and idempotent for the application that already holds it — a
 * deploy that runs its registration on every boot must not fail the second
 * time. Claiming one another application holds is refused rather than merged:
 * two applications sharing a namespace is the exact ambiguity the table exists
 * to prevent.
 */
export async function claimNamespace(input: {
  capability: FollowCapability;
  namespace: string;
}): Promise<RegistryResult<{ namespace: string; created: boolean }>> {
  const namespace = input.namespace.trim().toLowerCase();
  if (!NAMESPACE_SHAPE.test(namespace)) return fail('invalid_namespace');

  const [existing] = await getDb()
    .select({ applicationId: followNamespaces.applicationId })
    .from(followNamespaces)
    .where(eq(followNamespaces.namespace, namespace))
    .limit(1);

  if (existing) {
    // An unowned namespace — the platform's `oxy`, or one whose application was
    // deleted — is never re-granted. Rows across the whole graph already point
    // at kinds inside it, and letting a different application adopt that
    // identity would silently change what those rows mean.
    return existing.applicationId === input.capability.applicationId
      ? { ok: true, value: { namespace, created: false } }
      : fail('namespace_taken');
  }

  await getDb()
    .insert(followNamespaces)
    .values({ namespace, applicationId: input.capability.applicationId })
    // A concurrent claim by the SAME application must not fail; one by a
    // different application must not silently overwrite. `DO NOTHING` plus the
    // re-read below distinguishes them.
    .onConflictDoNothing({ target: followNamespaces.namespace });

  const [settled] = await getDb()
    .select({ applicationId: followNamespaces.applicationId })
    .from(followNamespaces)
    .where(eq(followNamespaces.namespace, namespace))
    .limit(1);

  if (!settled || settled.applicationId !== input.capability.applicationId) {
    return fail('namespace_taken');
  }

  return { ok: true, value: { namespace, created: true } };
}

/**
 * Release a namespace the caller holds, provided nothing has been registered
 * inside it.
 *
 * ## Why this exists
 *
 * A claim is first-come and otherwise permanent, and registration is
 * user-delegated and therefore client-side — so the first person to open a
 * screen on ANY build of an application triggers it. Mention found the sharp
 * edge before it cost anything: its local `.env` uses a fallback client id that
 * is deliberately not the production one, so a developer reaching that screen
 * while signed in would have bound `mention` to the DEV application, for good.
 * That agent declined to run registration against production at all, which was
 * right and should not have been necessary.
 *
 * Releasing makes the mistake recoverable. It is safe precisely because it is
 * narrow:
 *
 * - Only the HOLDER may release. Another application asking is refused, so this
 *   is not a way to take a name from somebody who has not used it yet.
 * - Only an EMPTY namespace may go. The foreign key from `follow_target_kinds`
 *   is `RESTRICT`, so the database refuses while any kind still points at it —
 *   and that is what keeps the original guarantee intact: a namespace that
 *   anything in the graph names can never be re-granted, because targets and
 *   relationships across the whole graph derive their meaning from it.
 *
 * The unowned platform namespace (`oxy`, `application_id` NULL) can therefore
 * never be released by anyone: no capability matches a NULL holder.
 */
export async function releaseNamespace(input: {
  capability: FollowCapability;
  namespace: string;
}): Promise<RegistryResult<{ namespace: string; released: boolean }>> {
  const namespace = input.namespace.trim().toLowerCase();
  if (!NAMESPACE_SHAPE.test(namespace)) return fail('invalid_namespace');

  const [existing] = await getDb()
    .select({ applicationId: followNamespaces.applicationId })
    .from(followNamespaces)
    .where(eq(followNamespaces.namespace, namespace))
    .limit(1);

  // Releasing something nobody holds is the state the caller asked for, so it
  // succeeds rather than erroring — same reasoning as an idempotent unfollow.
  if (!existing) return { ok: true, value: { namespace, released: false } };

  if (existing.applicationId !== input.capability.applicationId) {
    return fail('namespace_not_owned');
  }

  const [kind] = await getDb()
    .select({ kind: followTargetKinds.kind })
    .from(followTargetKinds)
    .where(eq(followTargetKinds.namespace, namespace))
    .limit(1);

  // Checked here so the caller gets a reason rather than a constraint name; the
  // RESTRICT below is still what actually enforces it, including against a kind
  // registered between this read and the delete.
  if (kind) return fail('namespace_in_use');

  await getDb()
    .delete(followNamespaces)
    .where(
      and(
        eq(followNamespaces.namespace, namespace),
        eq(followNamespaces.applicationId, input.capability.applicationId)
      )
    );

  return { ok: true, value: { namespace, released: true } };
}

/**
 * Register (or update) a kind inside a namespace the caller owns.
 *
 * Updating is restricted to the owner for the same reason registering is: the
 * capabilities on a kind decide what every client renders and whether reverse
 * lookups are public, so letting a second application edit them would let it
 * change another application's privacy posture.
 */
export async function registerKind(input: {
  capability: FollowCapability;
  kind: string;
  label?: string;
  capabilities?: FollowKindCapabilities;
}): Promise<RegistryResult<{ kind: string; created: boolean }>> {
  const kind = input.kind.trim().toLowerCase();
  if (!KIND_SHAPE.test(kind)) return fail('invalid_kind');

  const namespace = kind.split('.')[0];

  const [owner] = await getDb()
    .select({ applicationId: followNamespaces.applicationId })
    .from(followNamespaces)
    .where(eq(followNamespaces.namespace, namespace))
    .limit(1);

  // An unclaimed namespace is not an error the caller can fix by retrying with
  // more permission — it is a missing claim, and the two are reported the same
  // way on purpose: from outside, "not yours" and "nobody's yet, and you did
  // not claim it" call for the same next step.
  if (!owner || owner.applicationId !== input.capability.applicationId) {
    return fail('namespace_not_owned');
  }

  const values = {
    kind,
    namespace,
    applicationId: input.capability.applicationId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
  };

  const [row] = await getDb()
    .insert(followTargetKinds)
    .values(values)
    .onConflictDoUpdate({
      target: followTargetKinds.kind,
      set: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
        updatedAt: new Date(),
      },
      // Owning the namespace is not quite the same as owning every kind in it,
      // and the gap is real rather than theoretical: 0018 granted each existing
      // namespace to whoever registered its FIRST kind, so a namespace that two
      // applications had both written into comes out owned by one of them with
      // the other's kind rows still inside. This predicate is what stops the
      // owner silently redefining those, and it doubles as the guard for the
      // narrow race where the row appears between the SELECT above and here.
      where: eq(followTargetKinds.applicationId, input.capability.applicationId),
    })
    .returning({ kind: followTargetKinds.kind, createdAt: followTargetKinds.createdAt });

  // No row back means the conflict predicate refused: the kind exists and
  // belongs to somebody else. Reported separately from `namespace_not_owned`
  // because the two call for different things — this one cannot be fixed by
  // claiming anything.
  if (!row) return fail('kind_not_owned');

  return { ok: true, value: { kind: row.kind, created: true } };
}

/**
 * Resolve a target by its canonical URI, registering it if this is the first
 * time anyone has asked.
 *
 * Idempotent on the URI, which is what lets every application call it on the
 * way into a screen without coordinating: two applications that describe the
 * same fediverse actor arrive at ONE row, and therefore at one relationship per
 * user rather than one per app.
 *
 * The metadata snapshot is refreshed only by the application that provides the
 * target. A second application passing its own idea of the name would make the
 * display flip depending on which app last looked at it.
 */
export async function ensureTarget(input: {
  capability: FollowCapability;
  uri: string;
  kind: string;
  metadata?: Record<string, unknown>;
  providerReference?: string;
  localUserId?: string;
}): Promise<
  RegistryResult<{ id: string; uri: string; kind: string; created: boolean }>
> {
  const uri = input.uri.trim();
  // A URI has to be an absolute address: it is the identity two applications
  // independently arrive at, and a relative or empty string cannot be.
  if (!uri || !/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.length > 2048) return fail('invalid_uri');

  const kind = input.kind.trim().toLowerCase();
  if (!KIND_SHAPE.test(kind)) return fail('invalid_kind');

  if (input.metadata && JSON.stringify(input.metadata).length > MAX_METADATA_BYTES) {
    return fail('metadata_too_large');
  }

  const [kindRow] = await getDb()
    .select({ kind: followTargetKinds.kind })
    .from(followTargetKinds)
    .where(eq(followTargetKinds.kind, kind))
    .limit(1);

  // Registering a target of an unregistered kind would create a row nothing can
  // describe — no verb, no privacy decision for reverse lookups.
  if (!kindRow) return fail('unknown_kind');

  const localUserIdResult = await resolveLocalUserIdForTarget({
    kind,
    uri,
    localUserId: input.localUserId,
  });
  if (!localUserIdResult.ok) return localUserIdResult;
  const localUserId = localUserIdResult.value;

  const [existing] = await getDb()
    .select({
      id: followTargets.id,
      kind: followTargets.kind,
      providerApplicationId: followTargets.providerApplicationId,
    })
    .from(followTargets)
    .where(eq(followTargets.canonicalUri, uri))
    .limit(1);

  if (existing) {
    const isProvider = existing.providerApplicationId === input.capability.applicationId;
    if (isProvider && input.metadata) {
      await getDb()
        .update(followTargets)
        .set({ metadataSnapshot: input.metadata, updatedAt: new Date() })
        .where(eq(followTargets.id, existing.id));
    }
    return {
      ok: true,
      value: { id: existing.id, uri, kind: existing.kind, created: false },
    };
  }

  const [inserted] = await getDb()
    .insert(followTargets)
    .values({
      canonicalUri: uri,
      kind,
      providerApplicationId: input.capability.applicationId,
      ...(input.providerReference ? { providerReference: input.providerReference } : {}),
      ...(localUserId ? { localUserId } : {}),
      ...(input.metadata ? { metadataSnapshot: input.metadata } : {}),
    })
    // Two applications registering the same URI at once is the ordinary case,
    // not a race to report: whoever loses simply reads the winner's row.
    .onConflictDoNothing({ target: followTargets.canonicalUri })
    .returning({ id: followTargets.id, kind: followTargets.kind });

  if (inserted) {
    return { ok: true, value: { id: inserted.id, uri, kind: inserted.kind, created: true } };
  }

  const [settled] = await getDb()
    .select({ id: followTargets.id, kind: followTargets.kind })
    .from(followTargets)
    .where(eq(followTargets.canonicalUri, uri))
    .limit(1);

  if (!settled) return fail('invalid_uri');
  return { ok: true, value: { id: settled.id, uri, kind: settled.kind, created: false } };
}

/**
 * Read a kind's declared capabilities.
 *
 * Exported for clients that render a verb from the kind rather than passing one
 * — the value is the application's, declared once, so two screens of one app
 * cannot disagree about whether a store is followed or subscribed to.
 */
export async function getKindCapabilities(
  kind: string
): Promise<{ kind: string; label: string | null; capabilities: FollowKindCapabilities } | null> {
  const [row] = await getDb()
    .select({
      kind: followTargetKinds.kind,
      label: followTargetKinds.label,
      capabilities: followTargetKinds.capabilities,
    })
    .from(followTargetKinds)
    .where(eq(followTargetKinds.kind, kind.trim().toLowerCase()))
    .limit(1);

  if (!row) return null;
  return { kind: row.kind, label: row.label, capabilities: row.capabilities ?? {} };
}

/** Every kind an application owns. For a console listing, and for its own boot. */
export async function listKindsForApplication(
  applicationId: string
): Promise<Array<{ kind: string; label: string | null }>> {
  return getDb()
    .select({ kind: followTargetKinds.kind, label: followTargetKinds.label })
    .from(followTargetKinds)
    .where(
      and(
        eq(followTargetKinds.applicationId, applicationId),
        sql`${followTargetKinds.kind} is not null`
      )
    )
    .orderBy(followTargetKinds.kind);
}
