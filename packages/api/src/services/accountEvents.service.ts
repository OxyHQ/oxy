/**
 * Account events for relying parties (OxyHQ/Mention#1169).
 *
 * When a person deletes their Oxy account, every application that may hold
 * their data has to hear about it and erase. This module records the event in
 * the deletion's own transaction, signs it as a Security Event Token, and serves
 * the pull feed. Delivery lives in `accountEventWebhook.worker.ts`. The design,
 * contract and verification recipe are in `docs/identity/account-events.md`.
 */

import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../config/postgres';
import { signServiceTokenEd25519 } from '../config/serviceTokenSigning';
import {
  accountEventDeliveries,
  accountEvents,
  type AccountEventType,
} from '../db/schema/accountEvents';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';
import { sessions } from '../db/schema/sessions';

/** The `iss` every Oxy-signed token carries (the service-token issuer). */
export const ACCOUNT_EVENT_ISSUER = 'oxy-auth';

/** The SET `events` member for an account deletion. */
export const ACCOUNT_DELETED_EVENT_URI = 'https://oxy.so/events/account.deleted';

/**
 * Applications that hear about every account deletion regardless of history.
 * First-party, internal and system applications serve every Oxy account without
 * a per-user grant (a first-party sign-in does not always record which app a
 * session belongs to), so a history test would miss exactly the apps most
 * likely to hold data — Mention among them. Third-party applications hear only
 * about people who granted them access or signed in to them: telling an app
 * that some stranger deleted their account would disclose the stranger.
 */
const ALWAYS_NOTIFIED_APPLICATION_TYPES = ['first_party', 'internal', 'system'] as const;

/**
 * Events younger than this are not served by the pull feed. Event ids are
 * uuidv7, ordered by creation time, but a transaction that began earlier can
 * commit later; a consumer that advanced its cursor past an id before an older
 * one committed would skip it forever. Holding back the tail by far longer than
 * any deletion transaction runs closes that window.
 */
export const ACCOUNT_EVENT_FEED_SETTLE_MS = 30_000;

export const ACCOUNT_EVENT_FEED_MAX_LIMIT = 200;

export interface RecordedAccountEvent {
  eventId: string;
  recipients: number;
}

/**
 * Record that `userId` deleted their account, with one delivery row per
 * recipient application. MUST run inside the transaction that deletes or
 * archives the account, and BEFORE the `users` row is removed: the recipient
 * query reads the account's grants and sessions, which cascade with it.
 */
export async function recordAccountDeletedEvent(
  tx: Transaction,
  input: { userId: string; username: string | null; retained: boolean },
): Promise<RecordedAccountEvent> {
  const [event] = await tx
    .insert(accountEvents)
    .values({
      type: 'account.deleted',
      userId: input.userId,
      username: input.username,
      retained: input.retained,
    })
    .returning({ id: accountEvents.id });
  if (!event) throw new Error('account event insert returned no row');

  const typeList = sql.join(
    ALWAYS_NOTIFIED_APPLICATION_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const recipients = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.status, 'active'),
        sql`(
          ${applications.type} in (${typeList})
          or exists (
            select 1 from ${appGrants}
            where ${appGrants.applicationId} = ${applications.id}
              and ${appGrants.userId} = ${input.userId}
          )
          or exists (
            select 1 from ${sessions}
            where ${sessions.userId} = ${input.userId}
              and ${sessions.applicationId} = ${applications.id}
          )
        )`,
      ),
    );
  if (recipients.length > 0) {
    await tx
      .insert(accountEventDeliveries)
      .values(recipients.map((application) => ({ eventId: event.id, applicationId: application.id })));
  }

  return { eventId: event.id, recipients: recipients.length };
}

export interface AccountEventForToken {
  id: string;
  type: AccountEventType;
  userId: string;
  username: string | null;
  retained: boolean;
  createdAt: Date;
}

/** Thrown when Oxy has no Ed25519 signing key bound and cannot sign an event. */
export class AccountEventSigningUnavailableError extends Error {
  constructor() {
    super('Oxy has no Ed25519 signing key configured; account events cannot be signed');
    this.name = 'AccountEventSigningUnavailableError';
  }
}

/**
 * The Security Event Token for one event, addressed to one application. `aud`
 * is the receiving application id, so a token captured from one relying party
 * cannot be replayed at another.
 */
export function signAccountEventToken(event: AccountEventForToken, applicationId: string): string {
  const token = signServiceTokenEd25519(
    {
      iss: ACCOUNT_EVENT_ISSUER,
      aud: applicationId,
      iat: Math.floor(event.createdAt.getTime() / 1000),
      jti: event.id,
      events: {
        [ACCOUNT_DELETED_EVENT_URI]: {
          userId: event.userId,
          username: event.username,
          occurredAt: event.createdAt.toISOString(),
          retained: event.retained,
        },
      },
    },
    'secevent+jwt',
  );
  if (!token) throw new AccountEventSigningUnavailableError();
  return token;
}

export interface AccountEventFeedItem {
  eventId: string;
  type: AccountEventType;
  userId: string;
  username: string | null;
  occurredAt: string;
  retained: boolean;
  token: string;
}

export interface AccountEventFeedPage {
  events: AccountEventFeedItem[];
  nextCursor: string | null;
}

/**
 * One page of the pull feed: events addressed to `applicationId`, after the
 * `after` cursor (an event id), oldest first, excluding the unsettled tail.
 */
export async function listAccountEventsForApplication(
  applicationId: string,
  options: { after?: string; limit?: number; now?: Date } = {},
): Promise<AccountEventFeedPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), ACCOUNT_EVENT_FEED_MAX_LIMIT);
  const settledBefore = new Date((options.now ?? new Date()).getTime() - ACCOUNT_EVENT_FEED_SETTLE_MS);
  const rows = await getDb()
    .select({
      id: accountEvents.id,
      type: accountEvents.type,
      userId: accountEvents.userId,
      username: accountEvents.username,
      retained: accountEvents.retained,
      createdAt: accountEvents.createdAt,
    })
    .from(accountEventDeliveries)
    .innerJoin(accountEvents, eq(accountEvents.id, accountEventDeliveries.eventId))
    .where(
      and(
        eq(accountEventDeliveries.applicationId, applicationId),
        lt(accountEvents.createdAt, settledBefore),
        options.after ? gt(accountEventDeliveries.eventId, options.after) : undefined,
      ),
    )
    .orderBy(asc(accountEventDeliveries.eventId))
    .limit(limit);

  const events = rows.map((row) => ({
    eventId: row.id,
    type: row.type,
    userId: row.userId,
    username: row.username,
    occurredAt: row.createdAt.toISOString(),
    retained: row.retained,
    token: signAccountEventToken(row, applicationId),
  }));
  return {
    events,
    nextCursor: events.at(-1)?.eventId ?? options.after ?? null,
  };
}
