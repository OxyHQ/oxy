/**
 * `PUT /users/resolve` against a REAL Postgres.
 *
 * The federated/agent/automated upsert an internal service calls to bring a
 * remote actor into the Oxy graph. Every guard on it is a trust boundary:
 *
 *  - the `federation:write` scope gate,
 *  - the actor-URI ↔ asserted-domain binding (a service must not be able to
 *    claim `alice@mastodon.social` actually lives at `attacker.example`),
 *  - the own-domain guard (`nate@oxy.so` is a NON-ENTITY; minting a
 *    `type:'federated'` row for it would shadow the real local account),
 *  - the local-username collision refusal (account takeover through the
 *    federation pipeline),
 *  - and type immutability (no silent federated→agent promotion).
 *
 * The old suite mocked `models/User` — which this route no longer imports — so
 * every one of those guards ran against a database the suite never set up, and
 * the assertions were about the arguments a `findOneAndUpdate` mock received.
 * Here each guard is checked by what is, or is not, in `users` afterwards.
 *
 * That change is what surfaced the defect this rewrite also fixes: the display
 * name was written with Mongo's `name.first` DOT PATH, and drizzle silently
 * ignores a key that names no column — so every federated actor resolved through
 * this route landed with a NULL display name. "persists the cleaned display
 * name" below is the regression test.
 *
 * Two network boundaries stay mocked: `safeFetch` (the WebFinger probe) and
 * `federationService.scheduleAvatarRefresh` (the off-request-path avatar
 * download). Everything else — validation, the guards, the writes, the
 * serializer, the user cache — is real.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

/** See the identical note in `profilesUsername.test.ts`. */
jest.mock('mongoose', () => jest.requireActual('mongoose'));

const mockSafeFetch = jest.fn();

class FakeSsrfRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRejection';
  }
}

jest.mock('@oxyhq/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: FakeSsrfRejection,
}));

/** The scopes the mocked service-auth middleware grants. */
let currentScopes: string[] = ['federation:write'];

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (
    req: { serviceApp?: { type: string; appId: string; appName: string; scopes: string[] } },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      type: 'service',
      appId: 'app-1',
      appName: 'fed-svc',
      scopes: currentScopes,
    };
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: (): string | undefined => undefined,
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Peripheral modules the users router imports for OTHER endpoints. Stubbed so
// mounting it does not open an S3 client or the signed-export model graph;
// none of them is on the `/resolve` path.
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn() },
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../services/identityExport.service', () => ({
  buildExportBundle: jest.fn(),
}));
jest.mock('../../services/signature.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import userCache from '../../utils/userCache';
import usersRouter from '../users';

interface JsonResponse {
  status: number;
  raw: string;
  body: { error?: string; message?: string; data?: Record<string, unknown> };
}

let server: http.Server;
let scheduleAvatarRefreshSpy: jest.SpyInstance;
let invalidateSpy: jest.SpyInstance;

function resolveUser(payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'PUT',
        host: '127.0.0.1',
        port: address.port,
        path: '/users/resolve',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** A `safeFetch` result carrying a WebFinger JRD body. */
function webFingerResult(status: number, body: unknown) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const response = Readable.from([buffer]) as Readable & { destroy: jest.Mock };
  response.destroy = jest.fn();
  return {
    status,
    headers: { 'content-type': 'application/jrd+json' },
    finalUrl: 'https://example.com/.well-known/webfinger',
    response,
  };
}

function token(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function storedByActorUri(actorUri: string) {
  const [row] = await getDb()
    .select({
      id: users.id,
      username: users.username,
      type: users.type,
      nameFirst: users.nameFirst,
      bio: users.bio,
      avatar: users.avatar,
      federationActorUri: users.federationActorUri,
      federationDomain: users.federationDomain,
      federationLastResolvedAt: users.federationLastResolvedAt,
      federationUnavailableAt: users.federationUnavailableAt,
      federationUnavailableReason: users.federationUnavailableReason,
    })
    .from(users)
    .where(eq(users.federationActorUri, actorUri))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
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

beforeEach(() => {
  currentScopes = ['federation:write'];
  mockSafeFetch.mockReset();
  mockSafeFetch.mockResolvedValue(webFingerResult(404, '{}'));
  scheduleAvatarRefreshSpy = jest
    .spyOn(federationService, 'scheduleAvatarRefresh')
    .mockImplementation(() => undefined);
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PUT /users/resolve — scope gate', () => {
  it('rejects a service token without federation:write, and writes nothing', async () => {
    currentScopes = [];
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/federation:write/i);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });
});

describe('PUT /users/resolve — body validation', () => {
  it('400s an unsupported type', async () => {
    const res = await resolveUser({ type: 'local', username: `x${token()}` });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/type must be/i);
  });

  it('400s a missing username', async () => {
    const res = await resolveUser({ type: 'federated' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/username is required/i);
  });

  it('400s a federated body with no actorUri', async () => {
    const res = await resolveUser({
      type: 'federated',
      username: `a${token()}@mastodon.social`,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/actorUri is required/i);
  });

  it('400s a malformed ownerId on an agent, and writes nothing', async () => {
    const username = `bot${token()}`;

    const res = await resolveUser({ type: 'agent', username, ownerId: 'owner-1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ownerId must be a valid user id/i);
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    expect(row).toBeUndefined();
  });

  it('400s a username whose domain disagrees with the asserted domain', async () => {
    const handle = `alice${token()}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@other.example`,
      actorUri: `https://mastodon.social/users/${handle}`,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/username domain does not match/i);
  });
});

describe('PUT /users/resolve — actor-URI host binding', () => {
  it('400s when the actor host does not match the domain and WebFinger does not vouch', async () => {
    const handle = `mallory${token()}`;
    const actorUri = `https://evil.example/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/actorUri hostname/i);
    expect(mockSafeFetch).toHaveBeenCalledWith(
      `https://mastodon.social/.well-known/webfinger?resource=${encodeURIComponent(`acct:${handle}@mastodon.social`)}`,
      expect.anything(),
    );
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  /**
   * A BRIDGE republishes another network's accounts under its own hostname, so
   * for a bridged actor the host and the identity domain differ by design and
   * WebFinger can never reconcile them (x.com publishes none). The reviewed
   * trust list in `config/federationBridgeTrust` is what makes that difference
   * legitimate — a decision THIS service makes, not one the caller asserts. The
   * calling app's `createBridgeRelabeller([...])` entries are deliberately
   * separate and fail closed in both directions.
   */
  it('accepts a bridged actor whose identity domain is the network it mirrors', async () => {
    const handle = `wired${token()}`;
    const actorUri = `https://bird.makeup/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@x.com`,
      actorUri,
      domain: 'x.com',
    });

    expect(res.status).toBe(200);
    // The bridge policy is a local lookup, so no WebFinger round trip is spent.
    expect(mockSafeFetch).not.toHaveBeenCalled();
    const stored = await storedByActorUri(actorUri);
    expect(stored.username).toBe(`${handle}@x.com`);
    expect(stored.federationDomain).toBe('x.com');
    // The actor URI stays the address we actually reach the account at.
    expect(stored.federationActorUri).toBe(actorUri);
  });

  it('400s when a listed bridge claims a network it does not mirror', async () => {
    const handle = `wired${token()}`;
    const actorUri = `https://bird.makeup/users/${handle}`;

    // bird.makeup mirrors X. Being a known bridge is not a licence to vouch for
    // Instagram, so this falls through to WebFinger and is refused like any
    // other mismatched pair.
    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@instagram.com`,
      actorUri,
      domain: 'instagram.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/actorUri hostname/i);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('400s when a host that is not a reviewed bridge claims a network domain', async () => {
    const handle = `wired${token()}`;
    const actorUri = `https://attacker.example/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@x.com`,
      actorUri,
      domain: 'x.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/actorUri hostname/i);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('rejects an actor on the www sibling of the asserted domain without a WebFinger binding', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://www.mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(mockSafeFetch).toHaveBeenCalled();
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('rejects the reverse bare/www sibling pair without a WebFinger binding', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@www.mastodon.social`,
      actorUri,
      domain: 'www.mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(mockSafeFetch).toHaveBeenCalled();
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('accepts a foreign actor host when WebFinger loops the handle back to it', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://ap.mastodon.example/users/${handle}`;
    mockSafeFetch.mockResolvedValue(
      webFingerResult(200, {
        subject: `acct:${handle}@mastodon.social`,
        links: [{ rel: 'self', type: 'application/activity+json', href: actorUri }],
      }),
    );

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(200);
    expect((await storedByActorUri(actorUri)).federationActorUri).toBe(actorUri);
  });

  it('400s a foreign actor host when the WebFinger probe is blocked by the SSRF guard', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://ap.mastodon.example/users/${handle}`;
    mockSafeFetch.mockRejectedValue(new FakeSsrfRejection('blocked'));

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(400);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('stores a did:plc actor verbatim and never probes WebFinger for it', async () => {
    const handle = `alice${token()}`;
    const actorUri = `did:plc:${token()}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@bsky.social`,
      actorUri,
      domain: 'bsky.social',
    });

    expect(res.status).toBe(200);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    const stored = await storedByActorUri(actorUri);
    expect(stored.federationActorUri).toBe(actorUri);
    expect(stored.federationDomain).toBe('bsky.social');
  });

  it('stores a did:web actor verbatim and never probes WebFinger for it', async () => {
    const handle = `alice${token()}`;
    const actorUri = `did:web:${handle}.example.com`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@example.com`,
      actorUri,
      domain: 'example.com',
    });

    expect(res.status).toBe(200);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect((await storedByActorUri(actorUri)).federationActorUri).toBe(actorUri);
  });
});

describe('PUT /users/resolve — own-domain guard', () => {
  it('400s an own-domain handle and never mints a federated shadow row', async () => {
    const handle = `nate${token()}`;
    const actorUri = `https://oxy.so/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@oxy.so`,
      actorUri,
      domain: 'oxy.so',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/own federation domain/i);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });

  it('400s an own-domain handle regardless of the local part', async () => {
    const handle = `anyone${token()}`;
    const actorUri = `https://oxy.so/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@oxy.so`,
      actorUri,
      domain: 'oxy.so',
    });

    expect(res.status).toBe(400);
    expect(await storedByActorUri(actorUri)).toBeUndefined();
  });
});

describe('PUT /users/resolve — collision and type immutability', () => {
  it('409s an agent username already held by a local user, and leaves that user alone', async () => {
    const username = `taken${token()}`;
    const localUserId = await account({ username, type: 'local' });

    const res = await resolveUser({ type: 'agent', username });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already taken/i);
    const [row] = await getDb()
      .select({ type: users.type })
      .from(users)
      .where(eq(users.id, localUserId));
    expect(row.type).toBe('local');
  });

  it('409s when the existing row has a different type, and does not re-type it', async () => {
    const username = `bot${token()}`;
    const existingId = await account({ username, type: 'automated' });

    const res = await resolveUser({ type: 'agent', username });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cannot change.*type/i);
    const [row] = await getDb()
      .select({ type: users.type })
      .from(users)
      .where(eq(users.id, existingId));
    expect(row.type).toBe('automated');
  });
});

describe('PUT /users/resolve — persistence', () => {
  it('creates the federated row, clears the tombstone and invalidates the user cache', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    const before = Date.now();

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(200);
    const stored = await storedByActorUri(actorUri);
    expect(stored.username).toBe(`${handle}@mastodon.social`);
    expect(stored.type).toBe('federated');
    expect(stored.federationDomain).toBe('mastodon.social');
    expect(stored.federationLastResolvedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.federationUnavailableAt).toBeNull();
    expect(stored.federationUnavailableReason).toBeNull();
    expect(res.body.data?.id).toBe(stored.id);
    expect(invalidateSpy).toHaveBeenCalledWith(stored.id);
  });

  it('clears an existing tombstone on re-resolve rather than leaving the actor dead', async () => {
    const handle = `revived${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    await account({
      username: `${handle}@mastodon.social`,
      type: 'federated',
      federationActorUri: actorUri,
      federationDomain: 'mastodon.social',
      federationUnavailableAt: new Date('2026-01-01T00:00:00.000Z'),
      federationUnavailableReason: 'gone',
    });

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
    });

    expect(res.status).toBe(200);
    const stored = await storedByActorUri(actorUri);
    expect(stored.federationUnavailableAt).toBeNull();
    expect(stored.federationUnavailableReason).toBeNull();
  });

  it('persists the cleaned display name — the dot-path regression', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      displayName: 'Alice 🌸 :verified:',
    });

    expect(res.status).toBe(200);
    // Emoji and shortcodes are stripped by `cleanDisplayName`; what remains MUST
    // reach the column. A Mongo dot-path key here writes nothing at all, and
    // drizzle reports no error.
    const stored = await storedByActorUri(actorUri);
    expect(stored.nameFirst).toBe('Alice');
    expect(res.body.data?.name).toEqual(expect.objectContaining({ first: 'Alice' }));
  });

  it('strips tags from the bio before persisting it (stored-XSS regression)', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      bio: '<script>alert(1)</script>hello <b>world</b>',
    });

    expect(res.status).toBe(200);
    const stored = await storedByActorUri(actorUri);
    expect(stored.bio).not.toContain('<script>');
    expect(stored.bio).not.toContain('<b>');
    expect(stored.bio).toContain('hello');
    expect(res.raw).not.toContain('<script>');
  });

  it('records an agent owner when the ownerId is a real account id', async () => {
    const owner = await account({ username: `owner${token()}` });
    const username = `bot${token()}`;

    const res = await resolveUser({ type: 'agent', username, ownerId: owner });

    expect(res.status).toBe(200);
    const [row] = await getDb()
      .select({ type: users.type, automationOwnerId: users.automationOwnerId })
      .from(users)
      .where(eq(users.username, username));
    expect(row.type).toBe('agent');
    expect(row.automationOwnerId).toBe(owner);
  });
});

describe('PUT /users/resolve — avatar handling', () => {
  it('stores a non-URL avatar synchronously and schedules no download', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      avatar: 'file_already_stored',
    });

    expect(res.status).toBe(200);
    expect((await storedByActorUri(actorUri)).avatar).toBe('file_already_stored');
    expect(scheduleAvatarRefreshSpy).not.toHaveBeenCalled();
  });

  it('schedules the initial download when a remote avatar URL arrives and nothing is stored', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    const avatarUrl = 'https://mastodon.social/avatars/alice.png';

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      avatar: avatarUrl,
    });

    expect(res.status).toBe(200);
    const stored = await storedByActorUri(actorUri);
    // The download is scheduled, never awaited — the stored row carries no
    // avatar yet, which is the documented one-cycle lag.
    expect(stored.avatar).toBeNull();
    expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(stored.id, avatarUrl, undefined, {
      force: false,
    });
  });

  it('skips scheduling when a stored avatar already exists and no refresh was asked for', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    await account({
      username: `${handle}@mastodon.social`,
      type: 'federated',
      federationActorUri: actorUri,
      federationDomain: 'mastodon.social',
      avatar: 'file_existing',
    });

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      avatar: 'https://mastodon.social/avatars/alice.png',
    });

    expect(res.status).toBe(200);
    expect(scheduleAvatarRefreshSpy).not.toHaveBeenCalled();
    expect((await storedByActorUri(actorUri)).avatar).toBe('file_existing');
  });

  it('forces a re-download with refresh: true, passing the existing file id through', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    const avatarUrl = 'https://mastodon.social/avatars/alice.png';
    const existingId = await account({
      username: `${handle}@mastodon.social`,
      type: 'federated',
      federationActorUri: actorUri,
      federationDomain: 'mastodon.social',
      avatar: 'file_existing',
    });

    const res = await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      avatar: avatarUrl,
      refresh: true,
    });

    expect(res.status).toBe(200);
    expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(
      existingId,
      avatarUrl,
      'file_existing',
      { force: true },
    );
  });

  it('accepts forceAvatarRefresh as the alias of refresh', async () => {
    const handle = `alice${token()}`;
    const actorUri = `https://mastodon.social/users/${handle}`;
    const avatarUrl = 'https://mastodon.social/avatars/alice.png';
    const existingId = await account({
      username: `${handle}@mastodon.social`,
      type: 'federated',
      federationActorUri: actorUri,
      federationDomain: 'mastodon.social',
      avatar: 'file_existing',
    });

    await resolveUser({
      type: 'federated',
      username: `${handle}@mastodon.social`,
      actorUri,
      domain: 'mastodon.social',
      avatar: avatarUrl,
      forceAvatarRefresh: true,
    });

    expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(
      existingId,
      avatarUrl,
      'file_existing',
      { force: true },
    );
  });
});
