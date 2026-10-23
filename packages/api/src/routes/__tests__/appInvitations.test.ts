/**
 * `POST /apps/invitations/email`, over real HTTP against a real Postgres, with
 * the REAL service-token middleware, the REAL budgets and the REAL outbox. Only
 * the SMTP transport (nodemailer), the per-credential burst limiter and the
 * logger are faked.
 *
 * Every refusal is seeded next to a request that would have been sent under a
 * looser rule — a link one origin away from a registered one, an address that
 * bounced for EVERYONE beside one another inviter's complaint names, a budget
 * filled exactly to its limit — so a gate that stopped checking its property
 * turns its case red.
 */

process.env.SMTP_RELAY_HOST = 'email-smtp.us-west-2.amazonaws.com';
process.env.SMTP_RELAY_USER = 'user';
process.env.SMTP_RELAY_PASS = 'pass';

const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: () => ({
      sendMail: (...args: unknown[]) => mockSendMail(...args),
      close: jest.fn(),
    }),
  },
}));
/** The middleware verifies the token itself, so the real JWT must be used. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express, { type Request } from 'express';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import sessionService from '../../services/session.service';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applicationInvitationEmails } from '../../db/schema/applicationInvitationEmails';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import {
  APP_INVITATION_EMAIL_LIMITS,
  APP_INVITATION_EMAIL_MAX_ATTEMPTS,
  invitationMessageId,
  processAppInvitationEmails,
} from '../../services/appInvitationEmail.service';
import { recordSuppression } from '../../services/emailSuppression.service';
import { APP_INVITATION_EMAIL_SCOPE } from '../../utils/applicationScopes';
import appInvitationsRouter from '../appInvitations';

const ORIGIN = 'https://workspace.example';

interface SeededApp {
  appId: string;
  credentialId: string;
  ownerAccountId: string;
  scopes: string[];
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: {
    data?: { id: string; state: string; replayed: boolean; attempts: number };
    error?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

let server: http.Server;
let app: SeededApp;

async function person(
  input: Partial<typeof users.$inferInsert> = {},
): Promise<{ id: string; username: string }> {
  const username = `u${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const [row] = await insertAccountFixtures(
    { username, kind: 'personal', accountStatus: 'active', ...input },
    { id: users.id },
  );
  return { id: row.id, username };
}

async function seedApp(
  options: {
    scopes?: string[];
    tokenScopes?: string[];
    redirectUris?: string[];
    name?: string;
  } = {},
): Promise<SeededApp> {
  const scopes = options.scopes ?? ['user:read', APP_INVITATION_EMAIL_SCOPE];
  const owner = await person();
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: options.name ?? 'Workspace',
      type: 'first_party',
      status: 'active',
      scopes,
      redirectUris: options.redirectUris ?? [ORIGIN],
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: row.id,
      name: 'service',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return {
    appId: row.id,
    credentialId: credential.id,
    ownerAccountId: owner.id,
    scopes: options.tokenScopes ?? scopes,
  };
}

function tokenFor(seeded: SeededApp): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service',
    appId: seeded.appId,
    appName: 'Workspace',
    credentialId: seeded.credentialId,
    ownerAccountId: seeded.ownerAccountId,
    environment: 'production',
    scopes: seeded.scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: issuedAt,
    exp: issuedAt + 300,
  });
}

function post(
  body: unknown,
  options: { key?: string | null; as?: SeededApp; token?: string; requesterToken?: string } = {},
): Promise<Answer> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? tokenFor(options.as ?? app)}`,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    connection: 'close',
  };
  if (options.requesterToken) headers['x-oxy-requester-token'] = options.requesterToken;
  const key = options.key === undefined ? randomUUID() : options.key;
  if (key !== null) headers['idempotency-key'] = key;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/apps/invitations/email',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function recipient(): string {
  return `guest-${randomUUID().slice(0, 12)}@example.org`;
}

async function invitation(inviterId: string, overrides: Record<string, unknown> = {}) {
  return {
    to: recipient(),
    inviterUserId: inviterId,
    resourceName: 'Product team',
    acceptUrl: `${ORIGIN}/invite/${randomUUID()}`,
    ...overrides,
  };
}

async function rowOf(id: string) {
  const [row] = await getDb()
    .select()
    .from(applicationInvitationEmails)
    .where(eq(applicationInvitationEmails.id, id));
  return row;
}

/** The request answers before the relay does; wait for the outcome to land on the row. */
async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const row = await rowOf(id);
    if (row && row.status !== 'processing') return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`invitation ${id} never settled`);
}

/** Back-date ledger rows so a budget fills without sending anything. */
async function fillLedger(
  seeded: SeededApp,
  count: number,
  fields: { inviterUserId: string; recipient?: (i: number) => string },
) {
  const rows = Array.from({ length: count }, (_, i) => ({
    applicationId: seeded.appId,
    idempotencyKey: `filled-${randomUUID()}`,
    inviterUserId: fields.inviterUserId,
    recipient: fields.recipient ? fields.recipient(i) : recipient(),
    resourceName: 'Filled',
    acceptUrl: `${ORIGIN}/filled`,
    locale: 'en' as const,
    status: 'sent' as const,
    attempts: 1,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await getDb()
      .insert(applicationInvitationEmails)
      .values(rows.slice(i, i + 500));
  }
}

beforeAll(async () => {
  await connectPostgres();
  const api = express();
  api.use(express.json());
  api.use('/apps/invitations', appInvitationsRouter);
  api.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = api.listen(0, '127.0.0.1', resolve);
  });
  app = await seedApp();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ response: '250 Ok' });
});

/**
 * A send is delivered after its request answered, so a test that only reads the
 * answer would leave its relay call to land in the NEXT test's mock. Every test
 * ends with nothing in flight.
 */
afterEach(async () => {
  for (let i = 0; i < 100; i++) {
    const [{ inFlight }] = await getDb()
      .select({ inFlight: sql<number>`count(*)`.mapWith(Number) })
      .from(applicationInvitationEmails)
      .where(eq(applicationInvitationEmails.status, 'processing'));
    if (inFlight === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('a delivery was still in flight after its test');
});

describe('who may send', () => {
  it('refuses a token without invitations:email', async () => {
    const unscoped = await seedApp({ scopes: ['user:read'] });
    const inviter = await person();
    const res = await post(await invitation(inviter.id), { as: unscoped });
    expect(res.status).toBe(403);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses a token minted before the application lost the scope', async () => {
    const stale = await seedApp({
      scopes: ['user:read'],
      tokenScopes: ['user:read', APP_INVITATION_EMAIL_SCOPE],
    });
    const inviter = await person();
    const res = await post(await invitation(inviter.id), { as: stale });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Missing required scope: invitations:email');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses a session-shaped bearer outright', async () => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id), { token: 'not-a-service-token' });
    expect(res.status).toBe(401);
  });
});

describe('what may be sent', () => {
  it('requires an Idempotency-Key', async () => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id), { key: null });
    expect(res.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['a second link', 'Claim it at https://evil.example'],
    ['a www link', 'Go to www.evil.example now'],
    ['a bidi override', 'Team ‮elpmaxe.live'],
    ['a control character', 'Team\u0007'],
    ['an over-long name', 'x'.repeat(101)],
  ])('refuses a resource name carrying %s', async (_label, resourceName) => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id, { resourceName }));
    expect(res.status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses an inviter name passed as text', async () => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id, { inviterName: 'Your bank' }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['another origin', 'https://evil.example/invite/1'],
    ['a sibling subdomain', 'https://evil.workspace.example/invite/1'],
    ['plain http on the registered host', 'http://workspace.example/invite/1'],
    ['credentials in the URL', 'https://user:pass@workspace.example/invite/1'],
    ['another port', 'https://workspace.example:8443/invite/1'],
  ])('refuses an accept URL on %s', async (_label, acceptUrl) => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id, { acceptUrl }));
    expect(res.status).toBe(422);
    expect(res.body.details?.reason).toBe('accept_url_not_registered');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses plain http even on an origin the application registered, but not loopback', async () => {
    const insecure = await seedApp({
      redirectUris: ['http://insecure.example/callback', 'http://localhost:8081'],
    });
    const inviter = await person();
    const http_ = await post(
      await invitation(inviter.id, { acceptUrl: 'http://insecure.example/invite/1' }),
      { as: insecure },
    );
    const loopback = await post(
      await invitation(inviter.id, { acceptUrl: 'http://localhost:8081/invite/1' }),
      { as: insecure },
    );
    expect(http_.status).toBe(422);
    expect(http_.body.details?.reason).toBe('accept_url_not_registered');
    expect(loopback.status).toBe(202);
  });

  it('refuses an inviter who cannot invite: archived, managed, or unknown', async () => {
    const archived = await person({ accountStatus: 'archived' });
    const managed = await person({ kind: 'organization' });
    for (const inviterUserId of [archived.id, managed.id, randomUUID()]) {
      const res = await post(await invitation(inviterUserId));
      expect(res.status).toBe(422);
      expect(res.body.details?.reason).toBe('inviter_unavailable');
    }
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('sends the one template, named by Oxy, linked where the application registered', async () => {
    const inviter = await person({ nameFirst: 'Ada', nameLast: 'Lovelace' });
    const body = await invitation(inviter.id, { resourceName: 'R&D <team>' });

    const res = await post(body);

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ state: 'sending', replayed: false });
    const id = res.body.data?.id ?? '';
    expect((await settled(id)).status).toBe('sent');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe(body.to);
    expect(mail.from).toEqual({ name: 'Workspace', address: expect.stringMatching(/^noreply@/) });
    expect(mail.messageId).toBe(invitationMessageId(id));
    expect(mail.subject).toBe('Ada Lovelace invited you to R&D <team> on Workspace');
    expect(mail.text).toContain(body.acceptUrl);
    expect(mail.text).toContain('Ada Lovelace (@');
    expect(mail.html).toContain('R&#38;D &#60;team&#62;');
    expect(mail.html).not.toContain('<team>');
    expect(mail.html).toContain(`href="${body.acceptUrl}"`);
    expect(mail.html).toContain('This invitation opens workspace.example.');
    // The only links are the accept URL, twice (the button and the fallback).
    expect(mail.html.match(/href="/g)).toHaveLength(2);
  });

  it('writes it in the inviter-chosen language, and falls back to English', async () => {
    const inviter = await person({ username: undefined, nameDisplay: 'Nate' });
    const spanish = await post(await invitation(inviter.id, { locale: 'es-ES' }));
    const unknown = await post(await invitation(inviter.id, { locale: 'fr' }));
    await settled(spanish.body.data?.id ?? '');
    await settled(unknown.body.data?.id ?? '');
    const subjects = mockSendMail.mock.calls.map((call) => call[0].subject);
    expect(subjects).toContain('Nate te ha invitado a Product team en Workspace');
    expect(subjects).toContain('Nate invited you to Product team on Workspace');
  });

  it('names an inviter with no display name by their handle', async () => {
    const inviter = await person();
    const res = await post(await invitation(inviter.id));
    await settled(res.body.data?.id ?? '');
    expect(mockSendMail.mock.calls[0][0].subject).toBe(
      `${inviter.username} invited you to Product team on Workspace`,
    );
  });

  it('answers a repeat of the key with the first send, and sends nothing more', async () => {
    const inviter = await person();
    const body = await invitation(inviter.id);
    const key = randomUUID();

    const first = await post(body, { key });
    await settled(first.body.data?.id ?? '');
    const repeat = await post(body, { key });

    expect(repeat.status).toBe(200);
    expect(repeat.body.data).toMatchObject({
      id: first.body.data?.id,
      state: 'sent',
      replayed: true,
    });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('sends once when the same key races itself', async () => {
    const inviter = await person();
    const body = await invitation(inviter.id);
    const key = randomUUID();

    const answers = await Promise.all([
      post(body, { key }),
      post(body, { key }),
      post(body, { key }),
    ]);

    const ids = new Set(answers.map((a) => a.body.data?.id));
    expect(ids.size).toBe(1);
    expect(answers.filter((a) => a.status === 202)).toHaveLength(1);
    await settled([...ids][0] ?? '');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('refuses the key reused for a different invitation', async () => {
    const inviter = await person();
    const key = randomUUID();
    await post(await invitation(inviter.id), { key });
    const reused = await post(await invitation(inviter.id), { key });
    expect(reused.status).toBe(422);
    expect(reused.body.details?.reason).toBe('idempotency_key_reused');
  });

  it("scopes a key to its application: another application's same key is its own send", async () => {
    const other = await seedApp();
    const inviter = await person();
    const key = randomUUID();
    const mine = await post(await invitation(inviter.id), { key });
    const theirs = await post(await invitation(inviter.id), { key, as: other });
    expect(mine.status).toBe(202);
    expect(theirs.status).toBe(202);
    expect(theirs.body.data?.id).not.toBe(mine.body.data?.id);
  });
});

describe('the suppression list', () => {
  it('refuses an address that bounced, for everyone', async () => {
    const inviter = await person();
    const body = await invitation(inviter.id);
    await recordSuppression({ address: body.to, reason: 'bounce_permanent', source: 'ses' });

    const res = await post(body);

    expect(res.status).toBe(422);
    expect(res.body.details?.reason).toBe('recipient_suppressed');
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses an address that complained about this inviter, and only this inviter', async () => {
    const reported = await person();
    const other = await person();
    const to = recipient();
    await recordSuppression({
      address: to,
      reason: 'complaint',
      source: 'ses',
      userId: reported.id,
    });

    const refused = await post(await invitation(reported.id, { to }));
    const sent = await post(await invitation(other.id, { to }));

    expect(refused.status).toBe(422);
    expect(sent.status).toBe(202);
  });

  it('does not deliver a queued retry to an address suppressed meanwhile', async () => {
    const inviter = await person();
    const body = await invitation(inviter.id);
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const res = await post(body);
    const id = res.body.data?.id ?? '';
    expect((await settled(id)).status).toBe('failed');

    await recordSuppression({ address: body.to, reason: 'bounce_permanent', source: 'ses' });
    await getDb()
      .update(applicationInvitationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(applicationInvitationEmails.id, id));
    await processAppInvitationEmails();

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(await rowOf(id)).toMatchObject({ status: 'failed', errorCode: 'rejected' });
  });
});

describe('the budgets', () => {
  it('sends one invitation per recipient per application an hour', async () => {
    const own = await seedApp();
    const other = await seedApp();
    const to = recipient();
    const first = await person();
    const second = await person();

    const sent = await post(await invitation(first.id, { to }), { as: own });
    const again = await post(await invitation(second.id, { to }), { as: own });
    const elsewhere = await post(await invitation(second.id, { to }), { as: other });

    expect(sent.status).toBe(202);
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('INVITATION_RECIPIENT_RATE_LIMITED');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(3500);
    expect(elsewhere.status).toBe(202);
  });

  it('lets one inviter send fifty a day, and refuses the fifty-first', async () => {
    const own = await seedApp();
    const inviter = await person();
    const { max } = APP_INVITATION_EMAIL_LIMITS.perInviter;
    await fillLedger(own, max - 1, { inviterUserId: inviter.id });

    const last = await post(await invitation(inviter.id), { as: own });
    const over = await post(await invitation(inviter.id), { as: own });
    const colleague = await post(await invitation((await person()).id), { as: own });

    expect(last.status).toBe(202);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('INVITATION_INVITER_RATE_LIMITED');
    expect(colleague.status).toBe(202);
  });

  it('lets one application send a thousand a day, and refuses the next', async () => {
    const own = await seedApp();
    const { max } = APP_INVITATION_EMAIL_LIMITS.perApplication;
    // Spread over inviters so the per-inviter budget is not what refuses.
    const inviters = await Promise.all(Array.from({ length: 22 }, () => person()));
    for (let i = 0; i < inviters.length - 1; i++) {
      const count = Math.min(49, max - 1 - i * 49);
      if (count > 0) await fillLedger(own, count, { inviterUserId: inviters[i].id });
    }
    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(applicationInvitationEmails)
      .where(eq(applicationInvitationEmails.applicationId, own.appId));
    expect(count).toBe(max - 1);
    const fresh = inviters[inviters.length - 1].id;

    const last = await post(await invitation(fresh), { as: own });
    const over = await post(await invitation(fresh), { as: own });

    expect(last.status).toBe(202);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('INVITATION_APPLICATION_RATE_LIMITED');
  });

  it('forgets a send once its window has passed', async () => {
    const own = await seedApp();
    const to = recipient();
    const inviter = await person();
    await fillLedger(own, 1, { inviterUserId: inviter.id, recipient: () => to });
    const res = await post(await invitation(inviter.id, { to }), { as: own });
    expect(res.status).toBe(202);
  });
});

describe('delivery', () => {
  it('retries a transient failure with the same Message-ID, and settles it sent', async () => {
    const inviter = await person();
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const res = await post(await invitation(inviter.id));
    const id = res.body.data?.id ?? '';
    expect(await settled(id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      errorCode: 'relay_unavailable',
    });

    // Not due yet: the pass leaves it alone.
    await processAppInvitationEmails();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    await getDb()
      .update(applicationInvitationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(applicationInvitationEmails.id, id));
    await processAppInvitationEmails();

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockSendMail.mock.calls[1][0].messageId).toBe(mockSendMail.mock.calls[0][0].messageId);
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('never retries a permanent refusal', async () => {
    const inviter = await person();
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('550 Mailbox unavailable'), { responseCode: 550 }),
    );
    const res = await post(await invitation(inviter.id));
    const id = res.body.data?.id ?? '';
    expect(await settled(id)).toMatchObject({
      status: 'failed',
      attempts: APP_INVITATION_EMAIL_MAX_ATTEMPTS,
      errorCode: 'rejected',
    });
    await getDb()
      .update(applicationInvitationEmails)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(applicationInvitationEmails.id, id));
    await processAppInvitationEmails();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('adopts a claim whose task died, and sends nothing for an inviter archived since', async () => {
    const inviter = await person();
    const gone = await person();
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const [alive, orphan] = await getDb()
      .insert(applicationInvitationEmails)
      .values(
        [inviter.id, gone.id].map((inviterUserId) => ({
          applicationId: app.appId,
          idempotencyKey: randomUUID(),
          inviterUserId,
          recipient: recipient(),
          resourceName: 'Adopted',
          acceptUrl: `${ORIGIN}/invite/adopted`,
          locale: 'en' as const,
          status: 'processing' as const,
          attempts: 1,
          lockedAt: stale,
          lockedBy: 'request:dead',
        })),
      )
      .returning({ id: applicationInvitationEmails.id });
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, gone.id));

    await processAppInvitationEmails();

    expect(await rowOf(alive.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await rowOf(orphan.id)).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

it('own workloads send for the verified inviter without app scopes and cannot substitute another inviter', async () => {
  process.env.ACCESS_TOKEN_SECRET = 'invitation-own-proof-test-secret';
  process.env.REFRESH_TOKEN_SECRET = 'invitation-own-refresh-test-secret';
  const own = await seedApp({ scopes: [] });
  const inviter = await person();
  const stranger = await person();
  const { binding } = await bindWorkloadIdentity({
    applicationId: own.appId,
    subject: `arn:aws:iam::237343248947:role/invitation-own-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const token = signServiceTokenEd25519({
    type: 'service',
    authority: 'first_party',
    tier: 'internal',
    appId: own.appId,
    appName: 'Workspace',
    credentialId: binding.attestationId,
    ownerAccountId: own.ownerAccountId,
    environment: 'development',
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const session = await sessionService.createSession(inviter.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
  });
  const sent = await post(await invitation(inviter.id), {
    token,
    requesterToken: session.accessToken,
  });
  expect(sent.status).toBe(202);
  await settled(sent.body.data!.id);
  expect(mockSendMail).toHaveBeenCalledTimes(1);
  expect(
    (await post(await invitation(stranger.id), { token, requesterToken: session.accessToken }))
      .status,
  ).toBe(403);
  expect((await post(await invitation(inviter.id), { token })).status).toBe(403);
  expect(mockSendMail).toHaveBeenCalledTimes(1);
});
