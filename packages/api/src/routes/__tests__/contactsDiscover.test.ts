/**
 * `POST /contacts/discover`, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **A hash only ever resolves to an account that OPTED IN, on that channel.**
 * Contact discovery is an intersection over deterministic hashes, so without the
 * `privacySettings.discoverable*` gate anyone holding an email address can turn
 * this endpoint into an account-existence oracle. Every exclusion here — opted
 * out, opted out on the OTHER channel, archived, restricted, federated, the
 * caller themselves — is a row that really exists in the database and really
 * does not come back.
 *
 * The second guarantee is that the matching is done by the DATABASE on the
 * GENERATED hash columns, not by anything this test hands it: the fixtures write
 * `email` / `phone` and never a hash, and the expected digests are computed
 * independently with `utils/contactHash.ts`. A port that stopped filling
 * `hashed_email` would return nothing here rather than passing on a value the
 * test supplied.
 *
 * The auth middleware and the rate limiter are mocked (this file is about
 * neither token parsing nor Redis).
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/** The account each request authenticates as. Set per test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string; _id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: currentUserId, _id: currentUserId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { hashEmail, hashPhone } from '../../utils/contactHash';
import contactsRouter from '../contacts';

interface DiscoverMatch {
  userId: string;
  hashedIdentifier: string;
  matchType: 'email' | 'phone';
}

interface JsonResponse {
  status: number;
  body: { matches?: DiscoverMatch[]; message?: string; error?: string };
}

let server: http.Server;

type UserFixture = Partial<typeof users.$inferInsert>;

async function insertUser(fields: UserFixture = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...fields })
    .returning({ id: users.id });
  return row.id;
}

async function discover(payload: unknown): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/contacts/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

/** A unique address per call, so parallel suites cannot collide on the unique index. */
let addressCounter = 0;
function freshEmail(): string {
  addressCounter += 1;
  return `discover-${process.pid}-${addressCounter}@example.test`;
}
function freshPhone(): string {
  addressCounter += 1;
  return `+1555${String(process.pid).slice(-4)}${String(addressCounter).padStart(4, '0')}`;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/contacts', contactsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  currentUserId = await insertUser({ email: freshEmail() });
});

// Deliberately NO cleanup. Every fixture carries a unique address, so nothing
// here can collide with a later case — and the throwaway database is shared with
// the whole run, where other suites take global counts whose strict comparisons
// a concurrent DELETE can move DOWN between two reads. The rows go away with the
// database at the end of the run.

describe('POST /contacts/discover', () => {
  it('matches an opted-in account by email hash, and echoes the hash that matched', async () => {
    const email = freshEmail();
    const contact = await insertUser({ email, privacyDiscoverableByEmail: true });

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matches: [{ userId: contact, hashedIdentifier: hashEmail(email), matchType: 'email' }],
    });
  });

  it('matches by phone hash on the phone channel', async () => {
    const phone = freshPhone();
    const contact = await insertUser({ phone, privacyDiscoverableByPhone: true });

    const res = await discover({ hashedEmails: [], hashedPhones: [hashPhone(phone)] });

    expect(res.body).toEqual({
      matches: [{ userId: contact, hashedIdentifier: hashPhone(phone), matchType: 'phone' }],
    });
  });

  it('returns BOTH signals for one account matched on email and phone', async () => {
    const email = freshEmail();
    const phone = freshPhone();
    const contact = await insertUser({
      email,
      phone,
      privacyDiscoverableByEmail: true,
      privacyDiscoverableByPhone: true,
    });

    const res = await discover({
      hashedEmails: [hashEmail(email)],
      hashedPhones: [hashPhone(phone)],
    });

    expect(res.body.matches).toEqual([
      { userId: contact, hashedIdentifier: hashEmail(email), matchType: 'email' },
      { userId: contact, hashedIdentifier: hashPhone(phone), matchType: 'phone' },
    ]);
  });

  it('does NOT match an account that has not opted in — the enumeration gate', async () => {
    const email = freshEmail();
    await insertUser({ email });

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.body).toEqual({ matches: [] });
  });

  it('does NOT cross channels: an email opt-in does not expose the phone', async () => {
    const email = freshEmail();
    const phone = freshPhone();
    await insertUser({ email, phone, privacyDiscoverableByEmail: true });

    const res = await discover({
      hashedEmails: [hashEmail(email)],
      hashedPhones: [hashPhone(phone)],
    });

    expect(res.body.matches?.map((match) => match.matchType)).toEqual(['email']);
  });

  it('excludes the caller, so discovery never returns the address book owner', async () => {
    const email = freshEmail();
    const self = await insertUser({ email, privacyDiscoverableByEmail: true });
    currentUserId = self;

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.body).toEqual({ matches: [] });
  });

  it('excludes archived accounts', async () => {
    const email = freshEmail();
    await insertUser({ email, privacyDiscoverableByEmail: true, accountStatus: 'archived' });

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.body).toEqual({ matches: [] });
  });

  it('excludes accounts at the `restricted` trust tier', async () => {
    const email = freshEmail();
    await insertUser({ email, privacyDiscoverableByEmail: true, reputationTier: 'restricted' });

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.body).toEqual({ matches: [] });
  });

  it.each(['federated', 'agent', 'automated'] as const)(
    'excludes %s accounts from a personal contact-sync flow',
    async (type) => {
      const email = freshEmail();
      await insertUser({ email, privacyDiscoverableByEmail: true, type });

      const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

      expect(res.body).toEqual({ matches: [] });
    },
  );

  it('returns an empty match list for a hash nobody has', async () => {
    const res = await discover({ hashedEmails: [hashEmail(freshEmail())], hashedPhones: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [] });
  });

  it('de-dupes a repeated hash into a single match', async () => {
    const email = freshEmail();
    const contact = await insertUser({ email, privacyDiscoverableByEmail: true });
    const hash = hashEmail(email);

    const res = await discover({ hashedEmails: [hash, hash, hash], hashedPhones: [] });

    expect(res.body.matches).toEqual([
      { userId: contact, hashedIdentifier: hash, matchType: 'email' },
    ]);
  });

  it('rejects an empty payload (400) without querying', async () => {
    const res = await discover({ hashedEmails: [], hashedPhones: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed digest (400)', async () => {
    const res = await discover({ hashedEmails: ['not-a-sha256'], hashedPhones: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized batch (400)', async () => {
    const res = await discover({
      hashedEmails: Array.from({ length: 201 }, (_, i) => hashEmail(`bulk-${i}@example.test`)),
      hashedPhones: [],
    });
    expect(res.status).toBe(400);
  });

  it('matches on the GENERATED column, which normalizes case and whitespace', async () => {
    // The fixture writes a mixed-case, space-padded address; the client hashes
    // the canonical form. They agree only because the database derives
    // `hashed_email` from `lower(btrim(email))` — nothing in this test writes a
    // hash, so a port that dropped the generated column returns nothing here.
    const email = freshEmail();
    const contact = await insertUser({
      email: `  ${email.toUpperCase()}  `,
      privacyDiscoverableByEmail: true,
    });

    const res = await discover({ hashedEmails: [hashEmail(email)], hashedPhones: [] });

    expect(res.body.matches).toEqual([
      { userId: contact, hashedIdentifier: hashEmail(email), matchType: 'email' },
    ]);
  });
});
