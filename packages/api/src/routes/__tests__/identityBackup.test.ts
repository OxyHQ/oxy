/**
 * Encrypted off-device identity backup routes (b3 Feature 1), against a REAL
 * Postgres.
 *
 * The guarantees, all of which are about STORED BYTES rather than call shapes:
 *  - the server hashes the client's raw `lookupId` and stores ONLY the hash —
 *    the raw locator appears nowhere in the row (mirroring
 *    `DeviceSession.secretHash`);
 *  - POST is an UPSERT by user — a re-upload REPLACES the prior backup rather
 *    than accumulating a second row, and the `identity_backups_user_id_key`
 *    unique constraint is what makes that structural rather than hopeful;
 *  - a locator collision with a DIFFERENT account is a clean 409, never a silent
 *    overwrite of someone else's backup;
 *  - `GET /status` reports existence without leaking ciphertext or locator;
 *  - the PUBLIC `GET /:lookupId` restore endpoint hashes-and-looks-up in BOTH
 *    the found and not-found paths and returns a constant-shape 404 for an
 *    unknown locator;
 *  - `createdAt` on the wire is the CLIENT's ISO-8601 string, byte for byte —
 *    the column is `text` (`client_created_at`) precisely so a round trip
 *    through a `timestamptz` cannot re-render it in a different string form.
 *
 * ## Why this suite no longer mocks the model
 *
 * It used to replace `models/IdentityBackup` with a hand-written `Map` that
 * simulated `findOneAndUpdate`, including its own reimplementation of the
 * cross-user E11000. Every assertion about "the server stored only the hash"
 * was therefore an assertion about the MOCK's `$set` argument — it would have
 * stayed green against a port that persisted the raw locator, or none at all.
 * The rows here are real, and the "never the raw locator" case reads the row
 * back out of the database and checks every column.
 *
 * The auth middleware and the rate limiters are mocked (this file is about
 * neither token parsing nor Redis).
 */

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import express from 'express';
import type http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

/** The account each request authenticates as. Set per test. */
let currentUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: currentUserId };
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
import { identityBackups } from '../../db/schema/identityBackups';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import identityBackupRouter from '../identityBackup';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;
let OWNER = '';
let STRANGER = '';

const sha256Hex = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function request(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

/** Every stored row for a user, read WITHOUT going through the routes. */
async function storedRows(userId: string) {
  return getDb().select().from(identityBackups).where(eq(identityBackups.userId, userId));
}

/**
 * A locator no other case — or run — has used.
 *
 * `identity_backups_lookup_id_hash_key` is GLOBAL, so a fixed fixture value
 * makes every case after the first 409 on its predecessor's row. Minting a fresh
 * one per case is what lets this file leave its rows behind instead of deleting
 * accounts: the shared run-wide database has other suites taking global counts,
 * and a concurrent DELETE moves those DOWN between two reads.
 */
let lookupCounter = 0;
function freshLookupId(): string {
  lookupCounter += 1;
  return `${process.pid.toString(16)}${lookupCounter.toString(16)}`.padStart(64, 'e');
}

function uploadBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    algorithm: 'xchacha20poly1305',
    kdfInfo: 'oxy-backup-encryption-key',
    nonce: '00'.repeat(24),
    ciphertext: 'deadbeefcafe',
    publicKeyHint: '04abcdef01234567',
    createdAt: '2026-07-16T00:00:00.000Z',
    lookupId: freshLookupId(),
    ...overrides,
  };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/identity/backup', identityBackupRouter);
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
  OWNER = await insertUser();
  STRANGER = await insertUser();
  currentUserId = OWNER;
});

// Deliberately NO cleanup — see `freshLookupId`. Every account and every
// locator is unique to its case, so nothing here can collide with a later one,
// and the rows go away with the throwaway database at the end of the run.

describe('POST /identity/backup', () => {
  it('stores sha256(lookupId) and NEVER the raw lookupId', async () => {
    const rawLookupId = freshLookupId();
    const res = await request('POST', '/identity/backup', uploadBody({ lookupId: rawLookupId }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: true,
      publicKeyHint: '04abcdef01234567',
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    const [stored] = await storedRows(OWNER);
    expect(stored.lookupIdHash).toBe(sha256Hex(rawLookupId));
    // The raw locator is in NO column of the row — not under another name, not
    // appended to the ciphertext, nowhere.
    expect(Object.values(stored).some((value) => String(value).includes(rawLookupId))).toBe(false);
  });

  it('upserts by user — a re-upload REPLACES, never duplicates', async () => {
    const second = freshLookupId();
    await request('POST', '/identity/backup', uploadBody({ lookupId: freshLookupId() }));
    await request('POST', '/identity/backup', uploadBody({ lookupId: second, ciphertext: 'feed' }));

    const rows = await storedRows(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0].lookupIdHash).toBe(sha256Hex(second));
    expect(rows[0].ciphertext).toBe('feed');
  });

  it('never downgrades: an older envelope version cannot replace a newer one (R5-9)', async () => {
    const newer = await request(
      'POST',
      '/identity/backup',
      uploadBody({ version: 2, ciphertext: 'c0ffee' }),
    );
    expect(newer.status).toBe(200);

    const older = await request('POST', '/identity/backup', uploadBody({ version: 1 }));
    expect(older.status).toBe(409);
    const [kept] = await storedRows(OWNER);
    expect(kept.version).toBe(2);
    expect(kept.ciphertext).toBe('c0ffee');

    // The same or a newer version still replaces it.
    const same = await request(
      'POST',
      '/identity/backup',
      uploadBody({ version: 2, ciphertext: 'beef' }),
    );
    expect(same.status).toBe(200);
    const upgraded = await request('POST', '/identity/backup', uploadBody({ version: 3 }));
    expect(upgraded.status).toBe(200);
    const rows = await storedRows(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(3);
  });

  it('stores the client ISO timestamp verbatim, in its own column', async () => {
    await request(
      'POST',
      '/identity/backup',
      uploadBody({ createdAt: '2026-01-02T03:04:05.678Z' }),
    );
    const [stored] = await storedRows(OWNER);
    expect(stored.clientCreatedAt).toBe('2026-01-02T03:04:05.678Z');
  });

  it('rejects a malformed body (Zod validation → 400)', async () => {
    const res = await request('POST', '/identity/backup', uploadBody({ algorithm: 'aes-gcm' }));
    expect(res.status).toBe(400);
    expect(await storedRows(OWNER)).toHaveLength(0);
  });

  it('rejects a malformed lookupId (not 64 hex chars → 400)', async () => {
    const res = await request('POST', '/identity/backup', uploadBody({ lookupId: 'not-hex' }));
    expect(res.status).toBe(400);
    expect(await storedRows(OWNER)).toHaveLength(0);
  });

  it('returns 409 when the lookup hash collides with a different user', async () => {
    const shared = freshLookupId();
    currentUserId = STRANGER;
    await request('POST', '/identity/backup', uploadBody({ lookupId: shared }));

    currentUserId = OWNER;
    const res = await request('POST', '/identity/backup', uploadBody({ lookupId: shared }));
    expect(res.status).toBe(409);

    // The stranger's backup is untouched — a collision must never overwrite it.
    const [strangerRow] = await storedRows(STRANGER);
    expect(strangerRow.userId).toBe(STRANGER);
    expect(await storedRows(OWNER)).toHaveLength(0);
  });
});

describe('GET /identity/backup/status', () => {
  it('reports absence with a constant shape', async () => {
    const res = await request('GET', '/identity/backup/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it('reports presence with the hint + timestamp, no ciphertext/locator', async () => {
    await request('POST', '/identity/backup', uploadBody());
    const res = await request('GET', '/identity/backup/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: true,
      publicKeyHint: '04abcdef01234567',
      createdAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it("reports only the CALLER's backup, never another account's", async () => {
    currentUserId = STRANGER;
    await request('POST', '/identity/backup', uploadBody({ lookupId: freshLookupId() }));

    currentUserId = OWNER;
    const res = await request('GET', '/identity/backup/status');
    expect(res.body).toEqual({ exists: false });
  });
});

describe('DELETE /identity/backup', () => {
  it('is idempotent (succeeds even with no backup)', async () => {
    const res = await request('DELETE', '/identity/backup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('removes an existing backup', async () => {
    await request('POST', '/identity/backup', uploadBody());
    expect(await storedRows(OWNER)).toHaveLength(1);
    const res = await request('DELETE', '/identity/backup');
    expect(res.status).toBe(200);
    expect(await storedRows(OWNER)).toHaveLength(0);
  });

  it("deletes only the CALLER's backup", async () => {
    currentUserId = STRANGER;
    await request('POST', '/identity/backup', uploadBody({ lookupId: freshLookupId() }));

    currentUserId = OWNER;
    await request('POST', '/identity/backup', uploadBody({ lookupId: freshLookupId() }));
    await request('DELETE', '/identity/backup');

    expect(await storedRows(OWNER)).toHaveLength(0);
    expect(await storedRows(STRANGER)).toHaveLength(1);
  });
});

describe('GET /identity/backup/:lookupId (public restore)', () => {
  it('returns the envelope for a known locator — hashing the supplied value', async () => {
    const rawLookupId = freshLookupId();
    await request('POST', '/identity/backup', uploadBody({ lookupId: rawLookupId }));

    const res = await request('GET', `/identity/backup/${rawLookupId}`);
    expect(res.status).toBe(200);
    // Full envelope, no locator/hash leaked — asserted as the WHOLE body so an
    // added column cannot start riding along unnoticed.
    expect(res.body).toEqual({
      version: 1,
      algorithm: 'xchacha20poly1305',
      kdfInfo: 'oxy-backup-encryption-key',
      nonce: '00'.repeat(24),
      ciphertext: 'deadbeefcafe',
      publicKeyHint: '04abcdef01234567',
      createdAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it('returns a constant-shape 404 for an unknown locator', async () => {
    const res = await request('GET', `/identity/backup/${freshLookupId()}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ message: 'Backup not found' });
  });

  it('returns 400 for a malformed locator (wrong length / non-hex)', async () => {
    const res = await request('GET', '/identity/backup/not-a-valid-locator');
    expect(res.status).toBe(400);
  });

  it('does not leak whether a DIFFERENT user has a backup (only the exact locator matches)', async () => {
    currentUserId = STRANGER;
    await request('POST', '/identity/backup', uploadBody({ lookupId: freshLookupId() }));

    const res = await request('GET', `/identity/backup/${freshLookupId()}`);
    expect(res.status).toBe(404);
  });

  it('serves a backup by locator regardless of who is signed in — the locator IS the credential', async () => {
    currentUserId = STRANGER;
    const rawLookupId = freshLookupId();
    await request('POST', '/identity/backup', uploadBody({ lookupId: rawLookupId }));

    currentUserId = OWNER;
    const res = await request('GET', `/identity/backup/${rawLookupId}`);
    expect(res.status).toBe(200);
    expect(res.body.publicKeyHint).toBe('04abcdef01234567');
  });
});

describe('a backup a key rotation superseded (R6-8)', () => {
  /** Mark OWNER's stored backup superseded, as `POST /auth/rotate/complete` does for a v2 one. */
  async function supersede(): Promise<void> {
    await getDb()
      .update(identityBackups)
      .set({ supersededAt: new Date() })
      .where(eq(identityBackups.userId, OWNER));
  }

  it('reads as no backup of the current key in /status', async () => {
    await request('POST', '/identity/backup', uploadBody({ version: 2 }));
    await supersede();
    const res = await request('GET', '/identity/backup/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it('is still served by its locator, marked superseded', async () => {
    const rawLookupId = freshLookupId();
    await request('POST', '/identity/backup', uploadBody({ version: 2, lookupId: rawLookupId }));
    await supersede();
    const res = await request('GET', `/identity/backup/${rawLookupId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, superseded: true });
  });

  it('an older client cannot replace it (v1 refused); a v2 upload replaces it and clears the mark', async () => {
    await request('POST', '/identity/backup', uploadBody({ version: 2, ciphertext: 'c0ffee' }));
    await supersede();

    const older = await request('POST', '/identity/backup', uploadBody({ version: 1 }));
    expect(older.status).toBe(409);
    const [kept] = await storedRows(OWNER);
    expect(kept.ciphertext).toBe('c0ffee');
    expect(kept.supersededAt).toBeInstanceOf(Date);

    const replaced = await request('POST', '/identity/backup', uploadBody({ version: 2 }));
    expect(replaced.status).toBe(200);
    const [row] = await storedRows(OWNER);
    expect(row.supersededAt).toBeNull();
    expect((await request('GET', '/identity/backup/status')).body).toMatchObject({ exists: true });
  });

  it('DELETE removes it', async () => {
    await request('POST', '/identity/backup', uploadBody({ version: 2 }));
    await supersede();
    expect((await request('DELETE', '/identity/backup')).status).toBe(200);
    expect(await storedRows(OWNER)).toHaveLength(0);
  });
});

describe('POST /identity/backup only under the current root (R6-9)', () => {
  /** A fresh uncompressed root per case (`public_key` is unique), as the client derives its hint from. */
  let ROOT = '';
  beforeEach(() => {
    ROOT = generateSecp256k1KeyPair().publicKey;
  });

  async function setRoot(publicKey: string): Promise<void> {
    await getDb().update(users).set({ publicKey }).where(eq(users.id, OWNER));
  }

  it('accepts a hint that is the prefix of the current root', async () => {
    await setRoot(ROOT);
    const res = await request(
      'POST',
      '/identity/backup',
      uploadBody({ publicKeyHint: ROOT.slice(0, 16) }),
    );
    expect(res.status).toBe(200);
  });

  it('refuses a backup sealed under another (a rotated-away) key, keeping the stored one', async () => {
    await setRoot(ROOT);
    await request(
      'POST',
      '/identity/backup',
      uploadBody({ publicKeyHint: ROOT.slice(0, 16), ciphertext: 'c0ffee' }),
    );
    const stale = await request(
      'POST',
      '/identity/backup',
      uploadBody({ publicKeyHint: generateSecp256k1KeyPair().publicKey.slice(0, 16) }),
    );
    expect(stale.status).toBe(409);
    const [kept] = await storedRows(OWNER);
    expect(kept.ciphertext).toBe('c0ffee');
  });

  it('refuses a hint too short to name a key', async () => {
    await setRoot(ROOT);
    const res = await request('POST', '/identity/backup', uploadBody({ publicKeyHint: '04' }));
    expect(res.status).toBe(409);
  });

  it('compares against the canonical spelling of a root stored compressed or upper-case', async () => {
    // A valid point: the generator's x with its even-y prefix.
    const compressed = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';
    await setRoot(compressed);
    const res = await request(
      'POST',
      '/identity/backup',
      uploadBody({ publicKeyHint: '0479be667ef9dcbb' }),
    );
    expect(res.status).toBe(200);
  });
});
