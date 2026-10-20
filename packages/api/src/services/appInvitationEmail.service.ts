/**
 * Invitation emails an application has Oxy send (`POST /apps/invitations/email`,
 * scope `invitations:email`).
 *
 * An application with someone to invite who may have no Oxy account (Nilo
 * inviting an address to a workspace) cannot mail them itself without its own
 * sending domain, and must not be handed Oxy's as a relay. So Oxy sends ONE
 * template it owns — "{inviter} invited you to {resource} on {application}" and
 * a single link — and decides everything that would make it a phishing tool:
 *
 *  - the inviter is an Oxy user id; their NAME is read here, never accepted;
 *  - the link must be on an origin the application registered
 *    (`applications.redirect_uris`), over https, and the email says which host;
 *  - the resource name is plain text, length-capped and escaped, and may not
 *    read as a link (`schemas/appInvitations.schemas.ts`);
 *  - the suppression list binds it like any other mail, and each recipient,
 *    inviter and application has a budget ({@link APP_INVITATION_EMAIL_LIMITS}).
 *
 * ## Accepting, then delivering
 *
 * The request takes the claim (`application_invitation_emails`, unique on the
 * application's `Idempotency-Key`) leased to itself, in the transaction that
 * counts the budgets, answers, and only then speaks to the relay — the shape of
 * `emailDelivery.service.ts`. A relay failure lands on the row; a transient one
 * is retried by the email maintenance pass ({@link processAppInvitationEmails})
 * on the same ladder as a user's mail, which also adopts a claim whose task died.
 * The Message-ID is derived from the row id, so a retry is the same message.
 */

import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getNormalizedUserHandle, normalizeInlineText } from '@oxy.so/core';
import { EMAIL_DOMAIN, SMTP_OUTBOUND_CONFIG } from '../config/email.config';
import { getDb } from '../config/postgres';
import {
  type AppInvitationEmailLocale,
  type ApplicationInvitationEmailRow,
  applicationInvitationEmails,
} from '../db/schema/applicationInvitationEmails';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import { APP_INVITATION_EMAIL_SCOPE } from '../utils/applicationScopes';
import { composeDisplayName } from '../utils/displayName';
import { ForbiddenError, RateLimitedError, ValidationError } from '../utils/error';
import { logger } from '../utils/logger';
import { isLoopbackOrigin, normaliseOrigin } from '../utils/origin';
import { renderAppInvitationEmail } from './appInvitationEmail.mail';
import { findSuppressed, normalizeAddress } from './emailSuppression.service';
import {
  deliveryErrorCode,
  isOutboundRelayConfigured,
  missingRelayError,
  smtpOutbound,
} from './smtp.outbound';

/**
 * The budgets, counted over the ledger in the transaction that adds to it:
 *  - one invitation per recipient per application per hour — a renewal or a
 *    second inviter within the hour is refused, so an address is never mailed
 *    in a burst;
 *  - fifty per inviter per application per day — what one person can make an
 *    application send in their name;
 *  - a thousand per application per day — the ceiling on the application.
 */
export const APP_INVITATION_EMAIL_LIMITS = {
  perRecipient: { max: 1, windowMs: 60 * 60 * 1000 },
  perInviter: { max: 50, windowMs: 24 * 60 * 60 * 1000 },
  perApplication: { max: 1000, windowMs: 24 * 60 * 60 * 1000 },
} as const;

/** The same budget a user's message gets (`emailOutbox.service.ts`). */
export const APP_INVITATION_EMAIL_MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
/** How many due deliveries one maintenance pass takes. */
const PASS_LIMIT = 25;
const NAME_MAX_LENGTH = 64;

/** Where one invitation email stands, as the route answers it. */
export interface AppInvitationEmailDto {
  id: string;
  state: 'sending' | 'retrying' | 'sent' | 'failed';
  attempts: number;
  maxAttempts: number;
  errorCode: ApplicationInvitationEmailRow['errorCode'];
  createdAt: Date;
}

export interface AppInvitationEmailRequest {
  /** The calling application, from the verified service token, never the body. */
  applicationId: string;
  idempotencyKey: string;
  to: string;
  inviterUserId: string;
  resourceName: string;
  acceptUrl: string;
  locale?: string;
}

/** The accepted send, and whether it is the answer to an earlier request with the key. */
export interface AcceptedAppInvitationEmail {
  invitation: AppInvitationEmailDto;
  replayed: boolean;
}

export function toAppInvitationEmailDto(row: ApplicationInvitationEmailRow): AppInvitationEmailDto {
  const base = {
    id: row.id,
    attempts: row.attempts,
    maxAttempts: APP_INVITATION_EMAIL_MAX_ATTEMPTS,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
  switch (row.status) {
    case 'sent':
      return { ...base, state: 'sent', errorCode: null };
    case 'failed':
      return {
        ...base,
        state: row.attempts >= APP_INVITATION_EMAIL_MAX_ATTEMPTS ? 'failed' : 'retrying',
      };
    case 'pending':
    case 'processing':
      return { ...base, state: row.attempts <= 1 ? 'sending' : 'retrying' };
  }
}

/** `es-ES` → `es`; any language the template is not written in → `en`. */
export function invitationLocale(tag: string | undefined): AppInvitationEmailLocale {
  const language = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return language === 'es' ? 'es' : 'en';
}

/**
 * Whether `acceptUrl` may be the link of this application's email: https (or a
 * loopback origin, which reaches nobody but the developer), no credentials in
 * it, and its origin one of the application's registered redirect origins —
 * the set `matchesRegisteredOrigin` (`routes/auth.ts`) admits for its OAuth.
 */
export function isRegisteredAcceptUrl(acceptUrl: string, redirectUris: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(acceptUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const origin = normaliseOrigin(url.href);
  if (!origin) return false;
  if (url.protocol !== 'https:' && !isLoopbackOrigin(origin)) return false;
  return redirectUris.some((uri) => normaliseOrigin(uri) === origin);
}

/** A one-line name for a subject line: inline-normalised and length-capped. */
function displayText(value: string): string {
  const inline = normalizeInlineText(value);
  return inline.length <= NAME_MAX_LENGTH
    ? inline
    : `${inline.slice(0, NAME_MAX_LENGTH - 1).trim()}…`;
}

interface Inviter {
  name: string;
  handle: string | null;
}

/**
 * The inviter as the email names them: an active, local, personal account, by
 * its display name — or, the one fallback, its handle. Null for anyone else: a
 * managed account does not invite people, and an archived one no longer can.
 */
async function resolveInviter(userId: string): Promise<Inviter | null> {
  const [row] = await getDb()
    .select({
      username: users.username,
      nameDisplay: users.nameDisplay,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      type: users.type,
      kind: users.kind,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.accountStatus !== 'active' || row.kind !== 'personal' || row.type !== 'local') {
    return null;
  }
  const handle = getNormalizedUserHandle({ username: row.username, type: row.type });
  const displayName = composeDisplayName({
    name: { displayName: row.nameDisplay, first: row.nameFirst, last: row.nameLast },
  });
  const name = displayName ? displayText(displayName) : handle;
  if (!name) return null;
  return { name, handle: displayName ? handle : null };
}

/** Is this repeat of the key the same invitation the key was first used for? */
type InvitationFields = Pick<
  ApplicationInvitationEmailRow,
  'recipient' | 'inviterUserId' | 'resourceName' | 'acceptUrl' | 'locale'
>;

function sameInvitation(row: ApplicationInvitationEmailRow, request: InvitationFields): boolean {
  return (
    row.recipient === request.recipient &&
    row.inviterUserId === request.inviterUserId &&
    row.resourceName === request.resourceName &&
    row.acceptUrl === request.acceptUrl &&
    row.locale === request.locale
  );
}

function answerRepeat(
  row: ApplicationInvitationEmailRow,
  request: InvitationFields,
): AcceptedAppInvitationEmail {
  if (!sameInvitation(row, request)) {
    throw new ValidationError(
      'This Idempotency-Key was already used for a different invitation. Send this one with a new key.',
      { reason: 'idempotency_key_reused', id: row.id },
    );
  }
  return { invitation: toAppInvitationEmailDto(row), replayed: true };
}

async function findByKey(
  applicationId: string,
  idempotencyKey: string,
): Promise<ApplicationInvitationEmailRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(applicationInvitationEmails)
    .where(
      and(
        eq(applicationInvitationEmails.applicationId, applicationId),
        eq(applicationInvitationEmails.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

function retryAfterSeconds(oldest: Date | null, windowMs: number): number {
  if (!oldest) return Math.ceil(windowMs / 1000);
  return Math.max(1, Math.ceil((oldest.getTime() + windowMs - Date.now()) / 1000));
}

/**
 * Accept one invitation email: refuse what must not be sent, take the claim
 * inside the budgets, and start delivering it. A repeat of the key answers the
 * first acceptance and sends nothing.
 *
 * Refusals, before anything is claimed: 503 no relay at all; 403 the
 * application is not active or lost the scope since its token was minted; 422
 * a link off its registered origins (`accept_url_not_registered`), an inviter
 * who cannot invite (`inviter_unavailable`), a suppressed recipient
 * (`recipient_suppressed`), or the key reused for another invitation
 * (`idempotency_key_reused`); 429 a spent budget, with `Retry-After`.
 */
export async function acceptAppInvitationEmail(
  request: AppInvitationEmailRequest,
): Promise<AcceptedAppInvitationEmail> {
  if (!isOutboundRelayConfigured()) throw missingRelayError();

  const [application] = await getDb()
    .select({
      status: applications.status,
      scopes: applications.scopes,
      redirectUris: applications.redirectUris,
    })
    .from(applications)
    .where(eq(applications.id, request.applicationId))
    .limit(1);
  // The token's scopes were the ceiling when it was minted, up to five minutes
  // ago; the application's own row is the ceiling now.
  if (
    application?.status !== 'active' ||
    !application.scopes.includes(APP_INVITATION_EMAIL_SCOPE)
  ) {
    throw new ForbiddenError('This application may not send invitation emails');
  }

  const wanted: InvitationFields = {
    recipient: normalizeAddress(request.to),
    inviterUserId: request.inviterUserId,
    resourceName: request.resourceName,
    acceptUrl: request.acceptUrl,
    locale: invitationLocale(request.locale),
  };

  const existing = await findByKey(request.applicationId, request.idempotencyKey);
  if (existing) return answerRepeat(existing, wanted);

  if (!isRegisteredAcceptUrl(wanted.acceptUrl, application.redirectUris)) {
    throw new ValidationError(
      'acceptUrl must be an https URL on an origin registered for this application',
      { reason: 'accept_url_not_registered' },
    );
  }
  if (!(await resolveInviter(wanted.inviterUserId))) {
    throw new ValidationError('The inviter is not an active Oxy account that can invite', {
      reason: 'inviter_unavailable',
    });
  }
  const suppressed = await findSuppressed(wanted.inviterUserId, [wanted.recipient]);
  if (suppressed.length > 0) {
    throw new ValidationError('Mail to this address was refused before, so none is sent', {
      reason: 'recipient_suppressed',
      suppression: suppressed[0].reason,
    });
  }

  const owner = `request:${randomUUID()}`;
  const claim = await getDb().transaction(async (tx) => {
    // One application's sends are counted one at a time, so two concurrent
    // requests cannot both fit in the last slot of a budget. Held for the
    // milliseconds this transaction takes; other applications never wait on it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`app-invitation-email:${request.applicationId}`}, 0))`,
    );
    const [raced] = await tx
      .select()
      .from(applicationInvitationEmails)
      .where(
        and(
          eq(applicationInvitationEmails.applicationId, request.applicationId),
          eq(applicationInvitationEmails.idempotencyKey, request.idempotencyKey),
        ),
      )
      .limit(1);
    if (raced) return { claimed: false as const, row: raced };

    const { perRecipient, perInviter, perApplication } = APP_INVITATION_EMAIL_LIMITS;
    const t = applicationInvitationEmails;
    // The database's clock, as `created_at` is written with it.
    const since = (windowMs: number) =>
      sql`now() - ${Math.ceil(windowMs / 1000)}::integer * interval '1 second'`;
    const inWindow = (windowMs: number) => sql`${t.createdAt} > ${since(windowMs)}`;
    const ofRecipient = sql`${t.recipient} = ${wanted.recipient} and ${inWindow(perRecipient.windowMs)}`;
    const ofInviter = sql`${t.inviterUserId} = ${wanted.inviterUserId} and ${inWindow(perInviter.windowMs)}`;
    const ofApplication = inWindow(perApplication.windowMs);
    const widest = Math.max(perRecipient.windowMs, perInviter.windowMs, perApplication.windowMs);
    const [window] = await tx
      .select({
        recipient: sql<number>`count(*) filter (where ${ofRecipient})`.mapWith(Number),
        recipientOldest:
          sql<Date | null>`min(${t.createdAt}) filter (where ${ofRecipient})`.mapWith(t.createdAt),
        inviter: sql<number>`count(*) filter (where ${ofInviter})`.mapWith(Number),
        inviterOldest: sql<Date | null>`min(${t.createdAt}) filter (where ${ofInviter})`.mapWith(
          t.createdAt,
        ),
        application: sql<number>`count(*) filter (where ${ofApplication})`.mapWith(Number),
        applicationOldest:
          sql<Date | null>`min(${t.createdAt}) filter (where ${ofApplication})`.mapWith(
            t.createdAt,
          ),
      })
      .from(t)
      .where(and(eq(t.applicationId, request.applicationId), gte(t.createdAt, since(widest))));
    if (window.recipient >= perRecipient.max) {
      throw new RateLimitedError(
        'This address was sent an invitation from this application recently',
        {
          code: 'INVITATION_RECIPIENT_RATE_LIMITED',
          retryAfterSeconds: retryAfterSeconds(window.recipientOldest, perRecipient.windowMs),
        },
      );
    }
    if (window.inviter >= perInviter.max) {
      throw new RateLimitedError('This inviter has sent as many invitations as a day allows', {
        code: 'INVITATION_INVITER_RATE_LIMITED',
        retryAfterSeconds: retryAfterSeconds(window.inviterOldest, perInviter.windowMs),
      });
    }
    if (window.application >= perApplication.max) {
      throw new RateLimitedError('This application has sent as many invitations as a day allows', {
        code: 'INVITATION_APPLICATION_RATE_LIMITED',
        retryAfterSeconds: retryAfterSeconds(window.applicationOldest, perApplication.windowMs),
      });
    }

    const now = new Date();
    const [row] = await tx
      .insert(applicationInvitationEmails)
      .values({
        applicationId: request.applicationId,
        idempotencyKey: request.idempotencyKey,
        ...wanted,
        status: 'processing',
        attempts: 1,
        lockedAt: now,
        lockedBy: owner,
        nextAttemptAt: now,
      })
      .returning();
    return { claimed: true as const, row };
  });

  if (!claim.claimed) return answerRepeat(claim.row, wanted);
  startInvitationDelivery(claim.row);
  return { invitation: toAppInvitationEmailDto(claim.row), replayed: false };
}

/** The RFC 5322 Message-ID of an invitation: the same on every attempt. */
export function invitationMessageId(id: string): string {
  return `<invitation.${id}@${EMAIL_DOMAIN}>`;
}

/** Deliver a claimed row in the background; the outcome is on the row. */
export function startInvitationDelivery(row: ApplicationInvitationEmailRow): void {
  void deliverInvitation(row).catch((error) => {
    // Bookkeeping failed after the relay was spoken to. The lease expires and
    // the maintenance pass adopts the row — at least once, as for a user's mail.
    logger.error(
      'Invitation email bookkeeping failed',
      error instanceof Error ? error : new Error(String(error)),
      { invitationId: row.id },
    );
  });
}

async function settle(
  id: string,
  values: Partial<
    Pick<
      ApplicationInvitationEmailRow,
      'status' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'errorCode' | 'sentAt'
    >
  >,
): Promise<void> {
  await getDb()
    .update(applicationInvitationEmails)
    .set({ ...values, lockedAt: null, lockedBy: null })
    .where(eq(applicationInvitationEmails.id, id));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/**
 * One delivery attempt of a row the caller holds the claim on. Re-reads what
 * the email shows (the application's name, the inviter) and re-checks the
 * suppression list, so a retry hours later never mails an address that bounced
 * meanwhile, nor in the name of an inviter who can no longer invite.
 */
export async function deliverInvitation(
  row: ApplicationInvitationEmailRow,
): Promise<'sent' | 'retrying' | 'failed'> {
  const [application] = await getDb()
    .select({ name: applications.name, status: applications.status })
    .from(applications)
    .where(eq(applications.id, row.applicationId))
    .limit(1);
  const inviter = await resolveInviter(row.inviterUserId);
  if (application?.status !== 'active' || !inviter) {
    await settle(row.id, {
      status: 'failed',
      attempts: APP_INVITATION_EMAIL_MAX_ATTEMPTS,
      lastError: 'The application or the inviter can no longer send this invitation',
      errorCode: 'cancelled',
    });
    return 'failed';
  }
  const suppressed = await findSuppressed(row.inviterUserId, [row.recipient]);
  if (suppressed.length > 0) {
    await settle(row.id, {
      status: 'failed',
      attempts: APP_INVITATION_EMAIL_MAX_ATTEMPTS,
      lastError: `The recipient is suppressed (${suppressed[0].reason})`,
      errorCode: 'rejected',
    });
    return 'failed';
  }

  const content = renderAppInvitationEmail({
    inviterName: inviter.name,
    inviterHandle: inviter.handle,
    resourceName: row.resourceName,
    applicationName: displayText(application.name),
    acceptUrl: row.acceptUrl,
    locale: row.locale,
  });
  try {
    await smtpOutbound.sendSystem({
      to: row.recipient,
      ...content,
      messageId: invitationMessageId(row.id),
      fromName: displayText(application.name),
    });
  } catch (error) {
    return recordFailure(row, error);
  }
  await settle(row.id, { status: 'sent', sentAt: new Date(), lastError: null, errorCode: null });
  logger.info('Invitation email sent', { invitationId: row.id, applicationId: row.applicationId });
  return 'sent';
}

async function recordFailure(
  row: ApplicationInvitationEmailRow,
  error: unknown,
): Promise<'retrying' | 'failed'> {
  const errorCode = deliveryErrorCode(error);
  const asError = error instanceof Error ? error : new Error(String(error));
  const context = { invitationId: row.id, attempt: row.attempts };
  // A permanent failure does not walk the retry ladder (`emailDelivery.service.ts`).
  if (errorCode !== 'relay_unavailable') {
    await settle(row.id, {
      status: 'failed',
      attempts: APP_INVITATION_EMAIL_MAX_ATTEMPTS,
      lastError: errorText(error),
      errorCode,
    });
    logger.error('Invitation email permanently undeliverable', asError, context);
    return 'failed';
  }
  const delays = SMTP_OUTBOUND_CONFIG.retryDelays;
  const delay = delays[Math.min(Math.max(row.attempts - 1, 0), delays.length - 1)];
  await settle(row.id, {
    status: 'failed',
    nextAttemptAt: new Date(Date.now() + delay),
    lastError: errorText(error),
    errorCode,
  });
  logger.error('Invitation email delivery failed; will retry', asError, context);
  return row.attempts >= APP_INVITATION_EMAIL_MAX_ATTEMPTS ? 'failed' : 'retrying';
}

/** A delivery in flight whose holder stopped holding it. */
function abandoned(now: Date) {
  const t = applicationInvitationEmails;
  return and(
    eq(t.status, 'processing'),
    or(isNull(t.lockedAt), lt(t.lockedAt, new Date(now.getTime() - LEASE_MS))),
  );
}

/** Claim the next due delivery: a retry whose time came, or an abandoned claim. */
async function claimDueInvitation(
  workerId: string,
): Promise<ApplicationInvitationEmailRow | undefined> {
  const t = applicationInvitationEmails;
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          lt(t.attempts, APP_INVITATION_EMAIL_MAX_ATTEMPTS),
          or(
            and(inArray(t.status, ['pending', 'failed']), lte(t.nextAttemptAt, now)),
            abandoned(now),
          ),
        ),
      )
      .orderBy(asc(t.nextAttemptAt), asc(t.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx
      .update(t)
      .set({
        status: 'processing',
        lockedAt: now,
        lockedBy: workerId,
        attempts: sql`${t.attempts} + 1`,
        lastError: null,
        errorCode: null,
      })
      .where(eq(t.id, candidate.id))
      .returning();
    return claimed;
  });
}

const workerId = `app-invitation-email-${randomUUID()}`;

/**
 * The email maintenance pass's share (`cron/snooze.cron.ts`): settle abandoned
 * claims with no attempts left, then deliver what is due. Returns how many
 * deliveries it attempted.
 */
export async function processAppInvitationEmails(): Promise<number> {
  if (!isOutboundRelayConfigured()) return 0;
  await getDb()
    .update(applicationInvitationEmails)
    .set({
      status: 'failed',
      lockedAt: null,
      lockedBy: null,
      lastError:
        'Delivery was interrupted before the relay answered, and its attempts are spent. ' +
        'It may have been delivered.',
      errorCode: 'relay_unavailable',
    })
    .where(
      and(
        abandoned(new Date()),
        gte(applicationInvitationEmails.attempts, APP_INVITATION_EMAIL_MAX_ATTEMPTS),
      ),
    );
  let processed = 0;
  while (processed < PASS_LIMIT) {
    const row = await claimDueInvitation(workerId);
    if (!row) break;
    await deliverInvitation(row);
    processed++;
  }
  return processed;
}
