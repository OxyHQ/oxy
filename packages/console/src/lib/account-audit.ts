import type { AccountRelationship } from '@oxyhq/core';
import type { AccountPermission } from '@/hooks/use-account';
import type { AccountAuditActor, AccountAuditEntry, AccountAuditSource } from '@/hooks/use-account-audit';
import { hasImplicitOwnership } from '@/lib/account-access';

/**
 * Presentation logic for an ACCOUNT's audit trail (issue #972, "audit dashboards
 * for credential and billing changes").
 *
 * Split out for the reason `lib/credential-audit.ts` and `lib/provider-connection.ts`
 * were: these are the decisions that can be silently WRONG on a screen that
 * still looks right, and they are testable without rendering anything.
 *
 * ## The actor is a union of FIVE arms, and three of them carry no user id
 *
 * `GET /accounts/:id/audit` unions two tables that do not share an actor model.
 * The credential table records only `actor_user_id`, whose NULL means "nobody
 * acted" — the row is a refused validation. The connection table records an
 * explicit `actor_kind`, where a null id means either the customer's own service
 * credential or Oxy's platform machinery. So the server projects a DISCRIMINATED
 * actor, and this file reads the discriminant.
 *
 * Reading "is there an id" instead is not a hypothetical: it shipped on the
 * per-connection screen and was fixed in #1063. Every `used` event is written
 * `platform`, so on a connection actually serving traffic the wrong label was on
 * the MOST NUMEROUS row — a customer being told their own service credential did
 * something Oxy's data plane did. `__tests__/account-audit.test.ts` drives a
 * `platform` row beside a `service` row and beside a `none` row for that reason:
 * a suite asserting only the `user` arm passes against the bug.
 *
 * ## The permission decision is here too, because a partial trail is the one
 * failure this screen must not have
 *
 * The route requires `credentials:read` AND `inference:providers:read`, and
 * refuses rather than narrowing: a caller holding one would otherwise get a list
 * covering half the account while reading as the whole of it. {@link accountAuditAccess}
 * makes the same decision client-side so the refusal can be explained — naming
 * the permission that is missing — instead of arriving as a bare 403.
 */

/**
 * The two permissions the route demands together.
 *
 * Written out rather than derived, and asserted against the route's own gate in
 * the test: this list IS the refusal rule, so it is the thing that must not
 * drift.
 */
export const ACCOUNT_AUDIT_PERMISSIONS: ReadonlyArray<AccountPermission> = [
  'credentials:read',
  'inference:providers:read',
];

/**
 * Whether this membership may read the account trail, and if not, what is
 * missing.
 *
 * `missing` is a LIST rather than a boolean because the two permissions are held
 * independently — a `developer` holds `credentials:read` and not the other, and
 * a member could hold the reverse — and "you are missing one of two" is not an
 * answer anybody can act on.
 */
export type AccountAuditAccess =
  | { readonly kind: 'permitted' }
  | { readonly kind: 'refused'; readonly missing: ReadonlyArray<AccountPermission> };

/**
 * The parts of an `AccountNode` this decision reads, and nothing else.
 *
 * Structural rather than the whole node so a test can state a case in four
 * lines — an `AccountNode` satisfies it as it stands.
 */
export interface AccountAuditSubject {
  readonly relationship: AccountRelationship;
  readonly callerMembership: { readonly permissions: ReadonlyArray<string> } | null;
}

/**
 * Decide from the caller's own access to this account.
 *
 * Two inputs, because there are two ways to hold a permission. A membership row
 * lists them; the caller's OWN personal account has no row at all and grants
 * every one of them implicitly — see `lib/account-access.ts`. Reading only the
 * row would refuse the owner of a personal account their own audit trail, which
 * is both wrong and the default account.
 */
export function accountAuditAccess(subject: AccountAuditSubject): AccountAuditAccess {
  if (hasImplicitOwnership(subject)) {
    return { kind: 'permitted' };
  }
  const held = subject.callerMembership?.permissions ?? [];
  const missing = ACCOUNT_AUDIT_PERMISSIONS.filter((permission) => !held.includes(permission));
  return missing.length === 0 ? { kind: 'permitted' } : { kind: 'refused', missing };
}

/**
 * Who or what caused this event, in words — read from the actor's KIND, never
 * from whether an id is present.
 *
 * Every arm gets its own sentence, because every arm is a different claim:
 *
 *   `user`     a person on this account did it
 *   `service`  the account's own service credential did it
 *   `platform` Oxy's machinery did it, with no principal at all
 *   `none`     nobody did it — a request arrived and was refused
 *   `unknown`  the row never recorded who, which is not the same as `none`
 *
 * The switch is exhaustive with no `default`, so a sixth arm added server-side is
 * a compile error here rather than a row rendering as one of the other five.
 */
export function accountAuditActorLabel(entry: Pick<AccountAuditEntry, 'actor'>): string {
  const actor: AccountAuditActor = entry.actor;
  switch (actor.kind) {
    case 'user':
      return 'by a member';
    case 'service':
      return 'by a service credential';
    case 'platform':
      return 'by the platform';
    case 'none':
      return 'a refused request';
    case 'unknown':
      return 'actor not recorded';
  }
}

/**
 * The actor's user id, when there is one to show.
 *
 * Only the `user` arm has an id, and `in`-narrowing the union is what makes that
 * true at compile time: there is no field on the other four arms to read, so no
 * edit to this file can print an id for an event that has no actor.
 */
export function accountAuditActorUserId(entry: Pick<AccountAuditEntry, 'actor'>): string | null {
  return entry.actor.kind === 'user' ? entry.actor.userId : null;
}

/** Which table an entry came from, in the words the screen uses for it. */
export function accountAuditSourceLabel(source: AccountAuditSource): string {
  return source === 'application_credential' ? 'credential' : 'provider connection';
}

/**
 * Badge tone for an event.
 *
 * `destructive` on a refused validation ALONE. A revoke or a disable is a
 * deliberate act by somebody with the right to perform it, and colouring those
 * as problems is how a trail stops being read: the only red row should be the
 * one nobody chose.
 */
export function accountAuditVariant(
  entry: Pick<AccountAuditEntry, 'eventType'>
): 'outline' | 'destructive' {
  return entry.eventType === 'validation_failed' ? 'destructive' : 'outline';
}
