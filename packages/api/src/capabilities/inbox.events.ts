import { OxyServices } from '@oxyhq/core';
import { normalizedAppEventSchema, type NormalizedAppEvent } from '@oxyhq/contracts';
import { logger } from '../utils/logger';

const ALIA_API_URL = (process.env.ALIA_API_URL ?? 'https://api.alia.onl').replace(/\/$/, '');
const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

let eventClient: OxyServices | null | undefined;

function serviceClient(): OxyServices | null {
  if (eventClient !== undefined) return eventClient;
  const key = process.env.OXY_EVENT_APPLICATION_KEY?.trim();
  const secret = process.env.OXY_EVENT_APPLICATION_SECRET?.trim();
  if (!key || !secret) {
    eventClient = null;
    return eventClient;
  }
  const client = new OxyServices({ baseURL: OXY_API_URL });
  client.configureServiceAuth(key, secret);
  eventClient = client;
  return eventClient;
}

async function publish(event: NormalizedAppEvent): Promise<boolean> {
  const client = serviceClient();
  if (!client) return false;
  const token = await client.getServiceToken();
  const response = await fetch(`${ALIA_API_URL}/webhooks/oxy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(normalizedAppEventSchema.parse(event)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Alia rejected Inbox event (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return true;
}

function likelyNeedsResponse(input: {
  senderAddress: string;
  subject: string;
  headers: Record<string, string>;
}): string | null {
  const sender = input.senderAddress.toLowerCase();
  if (/\b(?:no-?reply|do-?not-?reply|notifications?)\b/.test(sender)) return null;
  const autoSubmitted = input.headers['auto-submitted']?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return null;
  if (/^(?:bulk|list|junk)$/i.test(input.headers.precedence ?? '')) return null;
  if (/\b(?:receipt|newsletter|notification|statement)\b/i.test(input.subject)) return null;
  return 'Direct non-automated incoming message';
}

export interface InboxMessageEventInput {
  ownerAccountId: string;
  mailboxId: string;
  messageId: string;
  senderAddress: string;
  subject: string;
  headers: Record<string, string>;
  receivedAt: Date;
}

export function buildInboxMessageEvents(input: InboxMessageEventInput): NormalizedAppEvent[] {
  const resource = {
    appId: 'inbox',
    effectiveAccountId: input.ownerAccountId,
    resourceType: 'mailbox',
    resourceId: input.mailboxId,
  } as const;
  const events: NormalizedAppEvent[] = [{
    eventId: `${input.messageId}:new_email`,
    appId: 'inbox',
    accountId: input.ownerAccountId,
    resource,
    type: 'new_email',
    occurredAt: input.receivedAt.toISOString(),
    data: {
      messageId: input.messageId,
      mailboxId: input.mailboxId,
      from: input.senderAddress,
      subject: input.subject,
    },
  }];
  const reason = likelyNeedsResponse(input);
  if (reason) {
    events.push({
      eventId: `${input.messageId}:email_needs_response`,
      appId: 'inbox',
      accountId: input.ownerAccountId,
      resource,
      type: 'email_needs_response',
      occurredAt: input.receivedAt.toISOString(),
      data: { messageId: input.messageId, mailboxId: input.mailboxId, reason },
    });
  }
  return events.map((event) => normalizedAppEventSchema.parse(event));
}

export async function publishInboxMessageEvents(input: InboxMessageEventInput): Promise<void> {
  const events = buildInboxMessageEvents(input);
  const results = await Promise.allSettled(events.map(publish));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.warn('Inbox capability event publish failed', {
        eventId: events[index]?.eventId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}
