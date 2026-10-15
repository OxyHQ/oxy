/**
 * Signing in with an email: one message carries a 6-digit code and a one-use
 * link to auth.oxy.so; either signs the person in.
 *
 * `start` answers the same for every identifier — an account that can sign in
 * this way (personal, active, with an email and no Commons key), one that
 * cannot, or none at all — and does the same work: it resolves the account,
 * checks the per-address send budget, proves the requester's device, and
 * writes one `email_verifications` row and one `email_signin_requests` row.
 * Only a real account is mailed, after the answer is decided and without
 * waiting on the relay. A decoy's code and link exist, were never sent, and can
 * never succeed.
 *
 * Which account:
 *
 * - A USERNAME names one account, and only it signs in.
 * - An EMAIL may hold several accounts (`EMAIL_ACCOUNTS_MAX`). The request
 *   names the mailbox, not an account; once the code or the link proves it,
 *   its accounts are read. One signs in directly; several are listed, and the
 *   holder of `requestSecret` chooses one (`chooseEmailSignInAccount`). Proving
 *   the mailbox already let its owner sign in to each of them one by one, so
 *   the list hands over nothing new, and it is shown to nobody else: `start`
 *   still answers the same for every address.
 *
 * Who gets the session:
 *
 * - The code is confirmed by the caller that holds the request's
 *   `requestSecret` — only the dialog that asked was given it.
 * - The link does not sign in whoever opens it. auth.oxy.so proves its own
 *   credential for the browser's shared device, and the request is APPROVED
 *   only when that is the device the dialog proved at `start` (the same
 *   browser); the dialog then collects the session with its `requestSecret`
 *   and, again, that same device. A link requested for someone else's email and
 *   opened by its owner therefore approves nothing for the requester, and the
 *   owner's click never hands a session to the page that opened.
 *
 * Every spend is one conditional update filtered on expiry, so a code, a link
 * or an approval signs in at most once.
 */
import crypto from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  EMAIL_ACCOUNTS_MAX,
  EMAIL_SIGNIN_CHOICE_TTL_MS,
  EMAIL_SIGNIN_LINK_TTL_MS,
  SIGN_IN_ERROR_CODES,
  normalizeEmailSignInCode,
  type EmailSignInAccountOption,
  type EmailSignInChooseAccount,
  type EmailSignInPending,
  type EmailSignInStartRequest,
  type EmailSignInStartResponse,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { emailSignInRequests } from '../db/schema/emailSignInRequests';
import { emailVerifications } from '../db/schema/emailVerifications';
import { users } from '../db/schema/users';
import { hashEmail } from '../utils/contactHash';
import { composeDisplayName } from '../utils/displayName';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { sendSignInEmail } from './accountEmail.mail';
import {
  assertMailConfigured,
  consumeEmailCode,
  recordVerification,
  reserveSendBudget,
} from './accountEmail.service';
import { clearFailures, isLockedOut, reserveAttempt } from './loginLockout.service';
import { resolveProvenDevice, resolveProvenDeviceId } from './deviceJoin.service';
import { SERVER_KEY_LABELS, serverHmacHex } from '../utils/serverKey';
import { normalizeSignInIdentifier } from '../utils/signInIdentifier';

/** Code attempts one requester gets per account per day, across its sign-in requests. */
export const SIGNIN_CODE_FAILURES_PER_DAY = 10;
/** 6-digit code attempts one account gets per day from every requester together (see `confirmEmailSignIn`). */
export const SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY = 50;
const SIGNIN_CODE_REQUESTER_SCOPE = 'signin-code-requester';
const SIGNIN_CODE_ACCOUNT_SCOPE = 'signin-code-account';

/**
 * The daily ceiling on sign-in code attempts, as a lockout. Keyed by the
 * MAILBOX the codes go to (`mailboxKey`), whichever identifier asked: a
 * username and the email it shares with other accounts must not each get
 * their own guesses at the same inbox's codes.
 */
function accountCeiling(accountKey: string) {
  return {
    scope: SIGNIN_CODE_ACCOUNT_SCOPE,
    identifier: accountKey,
    maxAttempts: SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY,
    windowSeconds: 24 * 60 * 60,
  };
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function mailboxKey(emailHash: string): string {
  return `mailbox:${emailHash}`;
}

function hashesEqual(storedHex: string, candidate: string): boolean {
  const expected = Buffer.from(storedHex, 'hex');
  const given = Buffer.from(sha256Hex(candidate), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function requestInvalid(): ApiError {
  return new ApiError(
    401,
    'This sign-in expired or was already used. Start again.',
    SIGN_IN_ERROR_CODES.requestInvalid,
  );
}

function linkInvalid(): ApiError {
  return new ApiError(
    401,
    'This link expired or was already used.',
    SIGN_IN_ERROR_CODES.linkInvalid,
  );
}

function linkOtherDevice(): ApiError {
  return new ApiError(
    403,
    'This link only works in the browser where you asked to sign in. Enter the code from the email in the app instead.',
    SIGN_IN_ERROR_CODES.linkOtherDevice,
  );
}

/** Only these accounts sign in by email: a Commons account signs in with Commons. */
function signsInByEmail() {
  return and(
    eq(users.kind, 'personal'),
    isNull(users.publicKey),
    eq(users.accountStatus, 'active'),
    isNotNull(users.email),
  );
}

interface SignInTarget {
  /** The one account a username named. */
  userId: string | null;
  /** An email holding at least one account: whoever proves it chooses. */
  mailbox: boolean;
  /** Every account the request can end in (the known-device check). */
  accountIds: string[];
  /** The per-address rate-limit key, and the mailbox's. */
  emailHash: string;
  sendTo: string | null;
  /** For the greeting; null when the address holds several accounts. */
  username: string | null;
}

async function resolveTarget(identifier: string): Promise<SignInTarget> {
  const trimmed = identifier.trim();
  const decoy: SignInTarget = {
    userId: null,
    mailbox: false,
    accountIds: [],
    emailHash: hashEmail(trimmed),
    sendTo: null,
    username: null,
  };
  // One normalisation for the match and every key (`utils/signInIdentifier.ts`);
  // outside it the same query runs against a value nothing matches: a decoy.
  const lookup = normalizeSignInIdentifier(identifier) ?? '';
  const byEmail = lookup.includes('@');
  const match = byEmail
    ? sql`lower(btrim(${users.email})) = ${lookup}`
    : sql`lower(btrim(${users.username})) = ${lookup}`;
  const accounts = await getDb()
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(and(match, signsInByEmail()))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(EMAIL_ACCOUNTS_MAX);
  const email = accounts[0]?.email?.trim().toLowerCase();
  if (!email) return decoy;
  return {
    userId: byEmail ? null : accounts[0].id,
    mailbox: byEmail,
    accountIds: accounts.map((account) => account.id),
    emailHash: hashEmail(email),
    sendTo: email,
    username: accounts.length === 1 ? accounts[0].username : null,
  };
}

/** The accounts a proven mailbox signs in, oldest first. */
async function mailboxAccounts(
  db: DatabaseOrTransaction,
  emailHash: string,
): Promise<EmailSignInAccountOption[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      avatar: users.avatar,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      nameDisplay: users.nameDisplay,
    })
    .from(users)
    .where(and(eq(users.hashedEmail, emailHash), signsInByEmail()))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(EMAIL_ACCOUNTS_MAX);
  return rows.map((row) => {
    const displayName = composeDisplayName({
      name: { first: row.nameFirst, last: row.nameLast, displayName: row.nameDisplay },
    });
    // An absent optional is OMITTED, not emitted as null.
    return {
      id: row.id,
      ...(row.username ? { username: row.username } : {}),
      ...(displayName ? { displayName } : {}),
      ...(row.avatar ? { avatar: row.avatar } : {}),
    };
  });
}

async function verificationEmailHash(
  db: DatabaseOrTransaction,
  verificationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ emailHash: emailVerifications.emailHash })
    .from(emailVerifications)
    .where(eq(emailVerifications.id, verificationId))
    .limit(1);
  return row?.emailHash ?? null;
}

/** A proven request: who signs in, or the accounts to choose from. */
export type ProvenEmailSignIn = { userId: string } | { choice: EmailSignInChooseAccount };

/**
 * The mailbox of `requestId` was just proven. One account: the request is
 * spent and that account signs in. Several: the request waits for the choice
 * until {@link EMAIL_SIGNIN_CHOICE_TTL_MS} from now. None (they went since the
 * email was sent): nothing to sign in to. Every update is conditional, so a
 * request is settled once.
 */
async function settleMailbox(
  db: DatabaseOrTransaction,
  request: { id: string; verificationId: string },
  now: Date,
): Promise<ProvenEmailSignIn | null> {
  const emailHash = await verificationEmailHash(db, request.verificationId);
  const accounts = emailHash ? await mailboxAccounts(db, emailHash) : [];
  const unsettled = and(
    eq(emailSignInRequests.id, request.id),
    eq(emailSignInRequests.mailbox, true),
    isNull(emailSignInRequests.provenAt),
    isNull(emailSignInRequests.completedAt),
    gt(emailSignInRequests.expiresAt, now),
  );
  if (accounts.length === 0) return null;
  if (accounts.length === 1) {
    const spent = await db
      .update(emailSignInRequests)
      .set({ completedAt: now })
      .where(unsettled)
      .returning({ id: emailSignInRequests.id });
    return spent.length === 0 ? null : { userId: accounts[0].id };
  }
  const expiresAt = new Date(now.getTime() + EMAIL_SIGNIN_CHOICE_TTL_MS);
  const proven = await db
    .update(emailSignInRequests)
    .set({ provenAt: now, expiresAt })
    .where(unsettled)
    .returning({ id: emailSignInRequests.id });
  if (proven.length === 0) return null;
  return { choice: { chooseAccount: true, accounts, expiresAt: expiresAt.getTime() } };
}

export async function startEmailSignIn(
  request: EmailSignInStartRequest,
  requesterKey: string,
  now: Date = new Date(),
): Promise<EmailSignInStartResponse> {
  assertMailConfigured();
  let target = await resolveTarget(request.identifier);
  const provenDevice = await resolveProvenDevice(request.device);
  const requesterDeviceId = provenDevice?.deviceId ?? null;
  // A device this account (one of the address's) is already signed in on: it
  // may use the budget's reserved slice, and only it is ever told the mail
  // could not go.
  const knownDevice = target.accountIds.some((id) => provenDevice?.accountIds.includes(id));
  const real = Boolean(target.userId) || target.mailbox;
  const db = getDb();
  // An account whose codes were guessed at too often today gets the long code
  // for the rest of the day: its owner can still type it, nobody can guess it.
  // (Decided for real and decoy targets alike; the answer never says which.)
  // The same one lookup for a decoy (on a key no account uses), so the time
  // taken says nothing about whether the account exists.
  const ceiling = await isLockedOut(
    accountCeiling(real ? mailboxKey(target.emailHash) : `decoy:${target.emailHash}`),
  );
  const longCode = real ? ceiling.locked : false;
  // Over the send budget: answered like any other request, as a decoy that
  // sends nothing — the budget is never visible (`reserveSendBudget`).
  let retryLater = false;
  if (
    !(await reserveSendBudget({
      group: 'public',
      emailHash: target.emailHash,
      requesterKey,
      knownDevice,
    }))
  ) {
    retryLater = knownDevice;
    target = { ...target, userId: null, mailbox: false, sendTo: null };
  }

  const requestSecret = newToken();
  const linkToken = newToken();
  const linkExpiresAt = new Date(now.getTime() + EMAIL_SIGNIN_LINK_TTL_MS);
  const { requestId, code, expiresAt } = await db.transaction(async (tx) => {
    const verification = await recordVerification(
      tx,
      { purpose: 'signin', emailHash: target.emailHash, userId: target.userId, longCode },
      now,
    );
    const [row] = await tx
      .insert(emailSignInRequests)
      .values({
        verificationId: verification.verificationId,
        userId: target.userId,
        mailbox: target.mailbox,
        requestSecretHash: sha256Hex(requestSecret),
        linkTokenHash: sha256Hex(linkToken),
        requesterDeviceId,
        longCode,
        expiresAt: linkExpiresAt,
      })
      .returning({ id: emailSignInRequests.id });
    return { requestId: row.id, code: verification.code, expiresAt: verification.expiresAt };
  });

  if (target.sendTo) {
    const shown = longCode ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
    sendSignInEmail(target.sendTo, {
      code: shown,
      linkToken,
      username: target.username,
      severalAccounts: target.accountIds.length > 1,
    }).catch((error: unknown) => {
      logger.error(
        'Sign-in email could not be sent',
        error instanceof Error ? error : new Error(String(error)),
        {
          component: 'emailSignIn',
        },
      );
    });
  }
  return {
    requestId,
    requestSecret,
    expiresAt: expiresAt.getTime(),
    ...(retryLater ? { retryLater: true as const } : {}),
  };
}

/**
 * The code, from the dialog that holds `requestSecret`. Spends the code and
 * returns the account to finish signing in — or, for an email holding several,
 * the accounts to choose from. A wrong code counts against the code's attempts
 * (committed before the error is thrown).
 */
export async function confirmEmailSignIn(
  input: {
    requestId: string;
    requestSecret: string;
    code: string;
    requesterKey: string;
    device?: { deviceId: string; deviceSecret: string };
  },
  now: Date = new Date(),
): Promise<ProvenEmailSignIn> {
  const provenDevice = await resolveProvenDevice(input.device);
  const outcome = await getDb().transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: emailSignInRequests.id,
        verificationId: emailSignInRequests.verificationId,
        userId: emailSignInRequests.userId,
        mailbox: emailSignInRequests.mailbox,
        requestSecretHash: emailSignInRequests.requestSecretHash,
        longCode: emailSignInRequests.longCode,
      })
      .from(emailSignInRequests)
      .where(
        and(
          eq(emailSignInRequests.id, input.requestId),
          isNull(emailSignInRequests.provenAt),
          isNull(emailSignInRequests.completedAt),
          gt(emailSignInRequests.expiresAt, now),
        ),
      )
      .for('update')
      .limit(1);
    if (!request || !hashesEqual(request.requestSecretHash, input.requestSecret)) {
      return { error: requestInvalid() };
    }
    // Code attempts across requests, reserved atomically before the check:
    // - per (account, requester): SIGNIN_CODE_FAILURES_PER_DAY — the strict
    //   cap. The requester is the hashed IP, kept only in the lockout store
    //   (Redis / memory), never persisted; a right code resets it;
    // - per mailbox: SIGNIN_CODE_ACCOUNT_CEILING_PER_DAY across every
    //   requester and both identifiers that reach it. It is NOT reset by a
    //   right code and nobody is exempt by IP (an attacker can start
    //   requests from any number of addresses). Past
    //   it, a 6-digit code is refused with the same generic error unless the
    //   request comes from a device one of its accounts is already signed in
    //   on; and every NEW email to the mailbox that day carries the long code
    //   (`startEmailSignIn`), which the ceiling does not apply to — so the
    //   owner can still sign in by code while guessing is infeasible. The link
    //   (which needs the requester's own browser) keeps working throughout.
    // A decoy counts on keys of its own.
    const emailHash = await verificationEmailHash(tx, request.verificationId);
    const accountKey =
      (request.userId || request.mailbox) && emailHash
        ? mailboxKey(emailHash)
        : `request:${request.id}`;
    const candidates = request.userId
      ? [request.userId]
      : request.mailbox && emailHash
        ? (await mailboxAccounts(tx, emailHash)).map((account) => account.id)
        : [];
    const requesterBucket = serverHmacHex(
      SERVER_KEY_LABELS.lockoutIdentifier,
      `${accountKey}|${input.requesterKey}`,
    );
    const perRequester = await reserveAttempt({
      scope: SIGNIN_CODE_REQUESTER_SCOPE,
      identifier: requesterBucket,
      maxAttempts: SIGNIN_CODE_FAILURES_PER_DAY,
      windowSeconds: 24 * 60 * 60,
    });
    const perAccount = await reserveAttempt(accountCeiling(accountKey));
    const exempt =
      request.longCode || candidates.some((id) => provenDevice?.accountIds.includes(id));
    const refuse = perRequester.locked || (perAccount.locked && !exempt);
    const checked = await consumeEmailCode(
      tx,
      {
        verificationId: request.verificationId,
        code: normalizeEmailSignInCode(input.code),
        purpose: 'signin',
        // A mailbox's code names no account; a decoy's still never succeeds.
        accountless: request.mailbox,
        refuse,
      },
      now,
    );
    if ('error' in checked) return checked;
    await clearFailures({ scope: SIGNIN_CODE_REQUESTER_SCOPE, identifier: requesterBucket });
    if (request.mailbox) {
      return (await settleMailbox(tx, request, now)) ?? { error: requestInvalid() };
    }
    if (!request.userId || checked.userId !== request.userId) return { error: requestInvalid() };
    await tx
      .update(emailSignInRequests)
      .set({ completedAt: now })
      .where(eq(emailSignInRequests.id, request.id));
    return { userId: request.userId };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome;
}

/**
 * The email's link, opened on auth.oxy.so. Approves the request only when
 * auth.oxy.so proves the device the dialog proved at `start`; the approval is
 * collected by the dialog, never returned here. A link opened elsewhere is
 * refused and stays usable in the right browser.
 */
export async function approveEmailSignInLink(
  input: { token: string; device: { deviceId: string; deviceSecret: string } },
  now: Date = new Date(),
): Promise<void> {
  const provenDeviceId = await resolveProvenDeviceId(input.device);
  const db = getDb();
  const [request] = await db
    .select({
      id: emailSignInRequests.id,
      requesterDeviceId: emailSignInRequests.requesterDeviceId,
    })
    .from(emailSignInRequests)
    .where(
      and(
        eq(emailSignInRequests.linkTokenHash, sha256Hex(input.token)),
        or(isNotNull(emailSignInRequests.userId), eq(emailSignInRequests.mailbox, true)),
        isNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.provenAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .limit(1);
  if (!request) throw linkInvalid();
  if (
    !request.requesterDeviceId ||
    !provenDeviceId ||
    provenDeviceId !== request.requesterDeviceId
  ) {
    throw linkOtherDevice();
  }
  const approved = await db
    .update(emailSignInRequests)
    .set({ approvedAt: now })
    .where(
      and(
        eq(emailSignInRequests.id, request.id),
        isNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .returning({ id: emailSignInRequests.id });
  if (approved.length === 0) throw linkInvalid();
}

/**
 * The dialog asks whether its link was opened. Pending until it was; then the
 * request is spent and the account returned (or, for an email holding
 * several, the accounts to choose from) — only to the holder of
 * `requestSecret`, and only with the device proof the request was made with.
 */
export async function collectEmailSignIn(
  input: {
    requestId: string;
    requestSecret: string;
    device?: { deviceId: string; deviceSecret: string };
  },
  now: Date = new Date(),
): Promise<ProvenEmailSignIn | EmailSignInPending> {
  const provenDeviceId = await resolveProvenDeviceId(input.device);
  const db = getDb();
  const [request] = await db
    .select({
      id: emailSignInRequests.id,
      verificationId: emailSignInRequests.verificationId,
      userId: emailSignInRequests.userId,
      mailbox: emailSignInRequests.mailbox,
      requestSecretHash: emailSignInRequests.requestSecretHash,
      requesterDeviceId: emailSignInRequests.requesterDeviceId,
      approvedAt: emailSignInRequests.approvedAt,
      provenAt: emailSignInRequests.provenAt,
      expiresAt: emailSignInRequests.expiresAt,
    })
    .from(emailSignInRequests)
    .where(
      and(
        eq(emailSignInRequests.id, input.requestId),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .limit(1);
  if (!request || !hashesEqual(request.requestSecretHash, input.requestSecret))
    throw requestInvalid();
  if (!request.approvedAt || !(request.userId || request.mailbox) || !request.requesterDeviceId) {
    return { status: 'pending', expiresAt: request.expiresAt.getTime() };
  }
  if (provenDeviceId !== request.requesterDeviceId) throw requestInvalid();
  if (request.mailbox) {
    // Already proven and waiting for the choice (the code got there first, or
    // this is a repeated poll): the same choice again.
    if (request.provenAt) {
      const emailHash = await verificationEmailHash(db, request.verificationId);
      const accounts = emailHash ? await mailboxAccounts(db, emailHash) : [];
      if (accounts.length < 2) throw requestInvalid();
      return {
        choice: { chooseAccount: true, accounts, expiresAt: request.expiresAt.getTime() },
      };
    }
    const settled = await settleMailbox(db, request, now);
    if (!settled) throw requestInvalid();
    return settled;
  }
  const userId = request.userId;
  if (!userId) throw requestInvalid();

  const spent = await db
    .update(emailSignInRequests)
    .set({ completedAt: now })
    .where(
      and(
        eq(emailSignInRequests.id, request.id),
        isNotNull(emailSignInRequests.approvedAt),
        isNull(emailSignInRequests.completedAt),
        gt(emailSignInRequests.expiresAt, now),
      ),
    )
    .returning({ id: emailSignInRequests.id });
  if (spent.length === 0) throw requestInvalid();
  return { userId };
}

/**
 * The account the person chose, from the accounts a proven mailbox listed.
 * Only the holder of `requestSecret`, while the choice lasts, and only one of
 * the address's accounts that can still sign in by email. Spends the request.
 */
export async function chooseEmailSignInAccount(
  input: { requestId: string; requestSecret: string; userId: string },
  now: Date = new Date(),
): Promise<string> {
  const db = getDb();
  const live = and(
    eq(emailSignInRequests.id, input.requestId),
    eq(emailSignInRequests.mailbox, true),
    isNotNull(emailSignInRequests.provenAt),
    isNull(emailSignInRequests.completedAt),
    gt(emailSignInRequests.expiresAt, now),
  );
  const [request] = await db
    .select({
      id: emailSignInRequests.id,
      verificationId: emailSignInRequests.verificationId,
      requestSecretHash: emailSignInRequests.requestSecretHash,
    })
    .from(emailSignInRequests)
    .where(live)
    .limit(1);
  if (!request || !hashesEqual(request.requestSecretHash, input.requestSecret)) {
    throw requestInvalid();
  }
  const emailHash = await verificationEmailHash(db, request.verificationId);
  const accounts = emailHash ? await mailboxAccounts(db, emailHash) : [];
  if (!accounts.some((account) => account.id === input.userId)) throw requestInvalid();
  const spent = await db
    .update(emailSignInRequests)
    .set({ completedAt: now })
    .where(live)
    .returning({ id: emailSignInRequests.id });
  if (spent.length === 0) throw requestInvalid();
  return input.userId;
}
