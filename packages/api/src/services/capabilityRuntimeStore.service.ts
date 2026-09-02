import { and, eq } from 'drizzle-orm';
import { auditEventSchema, type AuditEvent, type CapabilityTicketClaims } from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { capabilityAuditEvents, capabilityIdempotencyKeys } from '../db/schema/agency';
import { mailboxes } from '../db/schema/mailboxes';
import { messages } from '../db/schema/messages';

export async function persistCapabilityAuditEvent(event: AuditEvent): Promise<void> {
  // Runtime callers and direct route handlers share this write edge. Parse the
  // exact strict contract here so a cast or future caller cannot smuggle an
  // invocation body into the JSON audit envelope.
  const boundedEvent = auditEventSchema.parse(event);
  await getDb().insert(capabilityAuditEvents).values({
    eventKey: boundedEvent.eventId,
    effectiveAccountKey: boundedEvent.effectiveAccountId,
    executorAccountKey: boundedEvent.executor.type === 'agent' ? boundedEvent.executor.accountId : null,
    runKey: boundedEvent.correlation.runId,
    event: boundedEvent,
  }).onConflictDoNothing({ target: capabilityAuditEvents.eventKey });
}

export async function reserveCapabilityEffect(
  claims: CapabilityTicketClaims,
  keyHash: string,
): Promise<boolean> {
  const db = getDb();
  const inserted = await db.insert(capabilityIdempotencyKeys).values({
    effectiveAccountId: claims.resource.effectiveAccountId,
    appSlug: claims.resource.appId,
    tool: claims.tool,
    keyHash,
    ticketJti: claims.jti,
    status: 'started',
  }).onConflictDoNothing({
    target: [
      capabilityIdempotencyKeys.effectiveAccountId,
      capabilityIdempotencyKeys.appSlug,
      capabilityIdempotencyKeys.tool,
      capabilityIdempotencyKeys.keyHash,
    ],
  }).returning({ id: capabilityIdempotencyKeys.id });
  return inserted.length > 0;
}

export async function mailboxBelongsToAccount(mailboxId: string, accountId: string): Promise<boolean> {
  const [mailbox] = await getDb()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, accountId)))
    .limit(1);
  return Boolean(mailbox);
}

export async function messageBelongsToMailbox(
  messageId: string,
  accountId: string,
  mailboxId: string,
): Promise<boolean> {
  const [message] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.id, messageId),
      eq(messages.userId, accountId),
      eq(messages.mailboxId, mailboxId),
    ))
    .limit(1);
  return Boolean(message);
}

export async function messageBelongsToAccount(messageId: string, accountId: string): Promise<boolean> {
  const [message] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.userId, accountId)))
    .limit(1);
  return Boolean(message);
}

export async function finalizeCapabilityEffect(
  claims: CapabilityTicketClaims,
  keyHash: string,
  statusCode: number,
): Promise<void> {
  await getDb().update(capabilityIdempotencyKeys).set({
    status: statusCode < 400 ? 'succeeded' : 'failed',
    responseStatus: statusCode,
  }).where(and(
    eq(capabilityIdempotencyKeys.effectiveAccountId, claims.resource.effectiveAccountId),
    eq(capabilityIdempotencyKeys.appSlug, claims.resource.appId),
    eq(capabilityIdempotencyKeys.tool, claims.tool),
    eq(capabilityIdempotencyKeys.keyHash, keyHash),
  ));
}
