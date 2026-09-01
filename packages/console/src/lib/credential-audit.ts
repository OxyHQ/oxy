import type { CredentialAuditEvent } from '@/hooks/use-applications';

/**
 * Presentation logic for a credential's audit trail (issue #972, workstream 9).
 *
 * Split out for the same reason the BYOK equivalents are: these are the decisions
 * that can be silently WRONG, and they are testable without rendering.
 *
 * ## The one thing to get right: two correlated states, not four independent ones
 *
 * The wire type carries `eventType`, `reason` and `actorUserId` as three fields,
 * which invites reading them independently. They are not independent:
 *
 *   - `reason` is non-null ONLY on `validation_failed`.
 *   - `actorUserId` is null ONLY on `validation_failed`.
 *
 * So a null `actorUserId` does not mean "a service credential did this". Here it
 * means nobody did it: a request arrived and was REFUSED. Attributing a refusal
 * to a service credential would invent an actor for an event that has none, and
 * it would read as though a machine had rotated a key when in fact a request
 * failed validation.
 *
 * This file originally described the BYOK trail beside it as making that
 * inference CORRECTLY. It does not, and the claim is corrected here rather than
 * left standing, because a comment asserting correctness stops the next reader
 * checking. A BYOK event can be caused by a service credential — but it can also
 * be caused by the PLATFORM, and `inference_provider_connection_audit_events`
 * gives both a null `actor_user_id`; only `actor_kind` separates them. Since
 * every `used` event is written `platform`, the null inference was wrong on the
 * most numerous row in that trail. `lib/provider-connection.ts` now reads
 * `actorKind` there, which is the same discipline as this file's: key off the
 * field that actually distinguishes the states.
 *
 * That is why attribution below keys off `eventType` and never off the nullness
 * of `actorUserId`.
 */

/** Badge tone: a refused validation is the only event that reads as a problem. */
export function credentialAuditVariant(
  event: Pick<CredentialAuditEvent, 'eventType'>
): 'outline' | 'destructive' {
  return event.eventType === 'validation_failed' ? 'destructive' : 'outline';
}

/**
 * Who or what caused this event, in words.
 *
 * Derived from `eventType`, per the header. A transition is performed by a
 * member; a `validation_failed` row is a request that was turned away.
 */
export function credentialAuditAttribution(
  event: Pick<CredentialAuditEvent, 'eventType'>
): string {
  return event.eventType === 'validation_failed' ? 'a refused request' : 'by a member';
}

/**
 * A closed enum as a reader expects to see it: `validation_failed` →
 * `validation failed`, `secret_mismatch` → `secret mismatch`.
 *
 * Applied to the event type and the reason both, so a value added to either enum
 * server-side renders legibly here without a mapping table that would need
 * updating — and without inventing a friendlier name than the one the API uses,
 * which is the name a support conversation will quote.
 */
export function humaniseAuditToken(token: string): string {
  return token.replace(/_/g, ' ');
}
