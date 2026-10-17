/**
 * `POST /content-claims` — the public "Report content / rights claim" intake
 * (ADR 0043 D10) — over real `node:http`, the REAL CORS middleware, the REAL
 * rate limiters (in memory: no Redis in the test environment) and a REAL
 * Postgres. Stubbed: the optional session (a bearer of `good` is a signed-in
 * account), the logger.
 *
 *  1. A valid claim answers `201 { id, reference }` and stores the claim
 *     `received`, the claimant SEALED, each URL resolved to the Oxy file it
 *     names (or kept unresolved), the first audit event, and the claimant's
 *     confirmation email in the outbox — which the worker sends with the
 *     reference, to the claimant's address.
 *  2. An invalid one answers `400 { error, code, fields }` with one sentence
 *     per body path, the shape the website maps onto its form.
 *  3. A privacy claim by the affected person carries its 30-day deadline.
 *  4. A signed-in claimant is recorded; nobody needs to be signed in.
 *  5. Ten an hour per network and five a day per email: 429 + Retry-After.
 *  6. CORS: the website's origin (a first-party application) is allowed.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';

let mockSignedInUserId: string | null = null;

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (
    req: { headers: Record<string, string | undefined>; user?: { _id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    if (req.headers.authorization === 'Bearer good' && mockSignedInUserId) {
      req.user = { _id: mockSignedInUserId };
    }
    next();
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { createCorsMiddleware } from '../../config/cors';
import {
  resetOriginRegistryForTests,
  setOriginSnapshotForTests,
} from '../../config/dynamicOriginRegistry';
import {
  contentClaimClaimants,
  contentClaimEvents,
  contentClaimNotifications,
  contentClaimTargets,
  contentClaims,
  files,
  users,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import { runContentClaimNotificationBatch } from '../../services/contentClaims/contentClaimNotification.worker';
import contentClaimsRouter, { SUBMIT_PER_EMAIL, SUBMIT_PER_IP } from '../contentClaims';

jest.setTimeout(60_000);

let server: http.Server;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON response read loosely in assertions
  body: any;
}

let ipCounter = 0;
/** A network of its own, so one test's budget never spends another's. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function send(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Promise<Answer> {
  const address = server.address() as AddressInfo;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'x-forwarded-for': options.ip ?? freshIp(),
          ...(body
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed: unknown = raw;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'copyright',
    contentUrls: ['https://mention.earth/@someone/posts/123'],
    description: 'This photo is mine and was posted without my permission.',
    claimant: {
      name: 'Ada Lovelace',
      email: `ada-${randomBytes(4).toString('hex')}@example.com`,
      relationship: 'rights_holder',
    },
    statements: { goodFaith: true, accurate: true },
    signature: 'Ada Lovelace',
    ...overrides,
  };
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function storedFile(ownerUserId: string) {
  const sha = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      visibility: 'public',
      storageKey: `public/content/2026/10/${sha.slice(0, 2)}/${sha}.png`,
      originalName: 'photo.png',
    })
    .returning();
  return row;
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  process.env.ASSET_CDN_URL = 'https://cloud.oxy.so';
  setOriginSnapshotForTests(['https://oxy.so'], []);
  await connectPostgres();
  const app = express();
  app.set('trust proxy', true);
  app.use(createCorsMiddleware());
  app.use(express.json());
  app.use('/content-claims', contentClaimsRouter);
  app.use(errorHandler);
  server = app.listen(0);
});

afterAll(async () => {
  resetOriginRegistryForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('POST /content-claims', () => {
  it('stores a claim received, sealed, resolved, audited and confirmed', async () => {
    const owner = await account();
    const byId = await storedFile(owner);
    const byStream = await storedFile(owner);
    const byKey = await storedFile(owner);
    const body = claim({
      contentUrls: [
        `https://cloud.oxy.so/${byId.id}`,
        `https://api.oxy.so/assets/${byStream.id}/stream?variant=thumb`,
        `https://cloud.oxy.so/${byKey.storageKey.replace(/^public\//, '')}`,
        'https://mention.earth/@someone/posts/123',
      ],
      originalWorkUrl: 'https://ada.example/portfolio/1',
    });

    const res = await send('POST', '/content-claims', { body });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      reference: expect.stringMatching(/^OXY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
    });

    const [row] = await getDb()
      .select()
      .from(contentClaims)
      .where(eq(contentClaims.id, res.body.id));
    expect(row).toMatchObject({
      reference: res.body.reference,
      kind: 'copyright',
      relationship: 'rights_holder',
      state: 'received',
      submittedByUserId: null,
      deadlineAt: null,
      closedAt: null,
    });

    // Sealed: nothing of the claimant is in clear.
    const [sealed] = await getDb()
      .select()
      .from(contentClaimClaimants)
      .where(eq(contentClaimClaimants.claimId, row.id));
    const stored = JSON.stringify(sealed);
    for (const secret of [
      body.claimant.email,
      body.claimant.name,
      body.description,
      'ada.example',
    ] as string[]) {
      expect(stored).not.toContain(secret);
    }
    expect(sealed.expiresAt).toBeNull();

    const targets = await getDb()
      .select()
      .from(contentClaimTargets)
      .where(eq(contentClaimTargets.claimId, row.id))
      .orderBy(asc(contentClaimTargets.createdAt), asc(contentClaimTargets.id));
    const byUrl = new Map(targets.map((target) => [target.url, target]));
    expect(byUrl.get(`https://cloud.oxy.so/${byId.id}`)).toMatchObject({
      source: 'claimant',
      resolution: 'file',
      fileId: byId.id,
      sha256: byId.sha256,
    });
    expect(byUrl.get(body.contentUrls[1])).toMatchObject({
      fileId: byStream.id,
      sha256: byStream.sha256,
    });
    expect(byUrl.get(body.contentUrls[2])).toMatchObject({
      fileId: byKey.id,
      sha256: byKey.sha256,
    });
    expect(byUrl.get('https://mention.earth/@someone/posts/123')).toMatchObject({
      resolution: 'unresolved',
      fileId: null,
      sha256: null,
    });

    const events = await getDb()
      .select()
      .from(contentClaimEvents)
      .where(eq(contentClaimEvents.claimId, row.id));
    expect(events).toEqual([
      expect.objectContaining({
        action: 'submitted',
        actorUserId: null,
        toState: 'received',
        details: { targets: 4, resolved: 3, erasureRequest: false },
      }),
    ]);

    const queued = await getDb()
      .select()
      .from(contentClaimNotifications)
      .where(eq(contentClaimNotifications.claimId, row.id));
    expect(queued).toEqual([
      expect.objectContaining({ kind: 'claim_received', recipient: 'claimant', sentAt: null }),
    ]);

    // The worker sends it to the claimant, with the reference — at once, even
    // from a task whose clock is behind the database's: `next_attempt_at`
    // defaults to the database's now() (microseconds), the worker's clock is
    // JavaScript's (milliseconds). A minute behind stands for both.
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const behind = () => new Date(Date.now() - 60_000);
    let result = await runContentClaimNotificationBatch({
      ownerId: 'test',
      now: behind,
      send: async (message) => {
        sent.push(message);
      },
    });
    // Other tests' claims share the outbox; ours is among what was sent.
    while (result.claimed > 0 && !sent.some((message) => message.to === body.claimant.email)) {
      result = await runContentClaimNotificationBatch({
        ownerId: 'test',
        now: behind,
        send: async (message) => {
          sent.push(message);
        },
      });
    }
    const mine = sent.find((message) => message.to === body.claimant.email);
    expect(mine?.subject).toContain(res.body.reference);
    expect(mine?.text).toContain('Hi Ada Lovelace,');
    expect(mine?.text).toContain('4 links');
    const [delivered] = await getDb()
      .select()
      .from(contentClaimNotifications)
      .where(eq(contentClaimNotifications.claimId, row.id));
    expect(delivered.sentAt).toBeInstanceOf(Date);
    expect(delivered.attempts).toBe(1);
  });

  it('answers 400 with one sentence per field, the shape the website reads', async () => {
    const res = await send('POST', '/content-claims', {
      body: claim({
        contentUrls: ['http://insecure.example/x', 'https://ok.example/y'],
        description: 'too short',
        claimant: { name: '', email: 'not-an-email', relationship: 'stranger' },
        statements: { goodFaith: false, accurate: true },
        signature: '',
        extra: 'nope',
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: expect.any(String),
      code: 'CONTENT_CLAIM_INVALID',
      fields: {
        'contentUrls.0': 'Each link must be a full address that starts with https://.',
        description: 'Describe the content in at least 20 characters.',
        'claimant.name': 'Enter your full name.',
        'claimant.email': 'Enter an email we can reply to.',
        'claimant.relationship': 'Choose your relationship to the content.',
        'statements.goodFaith': 'Confirm the good-faith statement.',
        signature: 'Type your full name as your signature.',
        extra: 'This field is not part of a report.',
      },
    });

    const empty = await send('POST', '/content-claims', { body: {} });
    expect(empty.status).toBe(400);
    expect(empty.body.fields).toMatchObject({
      kind: 'Choose what you are reporting.',
      contentUrls: 'Add at least one link to the content.',
    });

    const tooMany = await send('POST', '/content-claims', {
      body: claim({ contentUrls: Array.from({ length: 21 }, (_, i) => `https://x.example/${i}`) }),
    });
    expect(tooMany.body.fields).toEqual({ contentUrls: 'Add no more than 20 links.' });
  });

  it('gives an erasure request its 30-day deadline', async () => {
    const before = Date.now();
    const res = await send('POST', '/content-claims', {
      body: claim({
        kind: 'privacy',
        claimant: {
          name: 'Bo',
          email: `bo-${randomBytes(3).toString('hex')}@example.com`,
          relationship: 'affected_person',
        },
      }),
    });
    expect(res.status).toBe(201);
    const [row] = await getDb()
      .select()
      .from(contentClaims)
      .where(eq(contentClaims.id, res.body.id));
    const due = row.deadlineAt?.getTime() ?? 0;
    expect(due - before).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(due - before).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('records a signed-in claimant, and needs nobody signed in', async () => {
    mockSignedInUserId = await account();
    const signedIn = await send('POST', '/content-claims', {
      body: claim(),
      headers: { authorization: 'Bearer good' },
    });
    expect(signedIn.status).toBe(201);
    const [row] = await getDb()
      .select()
      .from(contentClaims)
      .where(eq(contentClaims.id, signedIn.body.id));
    expect(row.submittedByUserId).toBe(mockSignedInUserId);
    const [event] = await getDb()
      .select()
      .from(contentClaimEvents)
      .where(eq(contentClaimEvents.claimId, row.id));
    expect(event.actorUserId).toBe(mockSignedInUserId);

    // A bearer that does not authenticate is simply not a signed-in claimant.
    const stale = await send('POST', '/content-claims', {
      body: claim(),
      headers: { authorization: 'Bearer stale' },
    });
    expect(stale.status).toBe(201);
    mockSignedInUserId = null;
  });

  it(`allows ${SUBMIT_PER_IP} an hour per network, then 429 with Retry-After`, async () => {
    const ip = freshIp();
    for (let i = 0; i < SUBMIT_PER_IP; i += 1) {
      expect((await send('POST', '/content-claims', { body: claim(), ip })).status).toBe(201);
    }
    const refused = await send('POST', '/content-claims', { body: claim(), ip });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.body.error).toBe('RATE_LIMITED');
    // Another network is unaffected.
    expect((await send('POST', '/content-claims', { body: claim() })).status).toBe(201);
  });

  it(`allows ${SUBMIT_PER_EMAIL} a day per claimant email, from any network`, async () => {
    const email = `Repeat-${randomBytes(4).toString('hex')}@Example.com`;
    const asClaimant = (address: string) =>
      claim({ claimant: { name: 'R', email: address, relationship: 'other' } });
    for (let i = 0; i < SUBMIT_PER_EMAIL; i += 1) {
      expect((await send('POST', '/content-claims', { body: asClaimant(email) })).status).toBe(201);
    }
    // The same address in another case is the same claimant.
    const refused = await send('POST', '/content-claims', {
      body: asClaimant(email.toLowerCase()),
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it("answers the website's origin across origins, and nobody else's", async () => {
    const preflight = await send('OPTIONS', '/content-claims', {
      headers: {
        origin: 'https://oxy.so',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://oxy.so');
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('Authorization');

    const posted = await send('POST', '/content-claims', {
      body: claim(),
      headers: { origin: 'https://oxy.so' },
    });
    expect(posted.status).toBe(201);
    expect(posted.headers['access-control-allow-origin']).toBe('https://oxy.so');

    const elsewhere = await send('OPTIONS', '/content-claims', {
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(elsewhere.headers['access-control-allow-origin']).toBeUndefined();
  });
});
