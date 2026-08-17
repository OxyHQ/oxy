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
 * So a null `actorUserId` does not mean "a service credential did this" — the
 * inference the BYOK trail beside this one makes correctly, because a BYOK event
 * really can be caused by a service credential. Here it means nobody did it: a
 * request arrived and was REFUSED. Attributing a refusal to a service credential
 * would invent an actor for an event that has none, and it would read as though a
 * machine had rotated a key when in fact a request failed validation.
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
