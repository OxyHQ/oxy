/**
 * The Oxy Keychain routes (ADR 0063, `docs/identity/keychain.md`), against a
 * REAL Postgres.
 *
 * Every key here is generated per run with `@noble/curves` (Ed25519 for the
 * signing keys, X25519 for the box keys); the wraps' and items' ciphertexts are
 * random bytes, since the server never opens one. The tests sign roster
 * entries and wraps exactly as a device must (JCS from `@oxy.so/protocol`,
 * the domain strings of ADR 0063 D8), so a server that checked a different
 * input would refuse them.
 *
 * The auth middleware is replaced by one that sets the bearer's account and
 * `oxyToken` per test; everything after it (the first-party guard, the
 * personal/acting-as/device-session checks, the routes, the database) is real.
 * The rate limiters are mocked (not this file's subject), and so is the
 * ADR 0030 re-verification, whose own suite covers it: here it only has to be
 * asked for `reset_keychain` and to stop a reset when it fails.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';

interface MockAuth {
  userId: string;
  kind: string;
  token: Record<string, unknown>;
}

const mockAuth: MockAuth = { userId: '', kind: 'personal', token: {} };

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown; oxyToken?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: mockAuth.userId, id: mockAuth.userId, kind: mockAuth.kind };
    req.oxyToken = {
      principalUserId: mockAuth.userId,
      subjectAccountId: mockAuth.userId,
      applicationId: null,
      ...mockAuth.token,
    };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockVerifyAccountReauth = jest.fn();
jest.mock('../../services/reauth.service', () => ({
  verifyAccountReauth: (...args: unknown[]) => mockVerifyAccountReauth(...args),
}));

import {
  KEYCHAIN_DOMAINS,
  KEYCHAIN_LIMITS,
  SIGN_IN_ERROR_CODES,
  buildIdentityProofMessage,
  IDENTITY_PROOF_AUDIENCE,
} from '@oxy.so/contracts';
import { canonicalize } from '@oxy.so/protocol';
import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { deviceSessions } from '../../db/schema/deviceSessions';
import {
  keychainEnrollments,
  keychainItems,
  keychainMembers,
  keychainRosterEntries,
  keychainVaults,
  keychainWraps,
} from '../../db/schema/keychain';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { ApiError } from '../../utils/error';
import {
  digestIdentityPayload,
  mintIdentityProofChallenge,
} from '../../services/identityProof.service';
import SignatureService from '../../services/signature.service';
import keychainRouter from '../keychain';

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

let server: http.Server;

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the test reads the answers' JSON by path
  body: Record<string, any>;
}

async function call(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : {} };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function insertUser(values: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...values })
    .returning({ id: users.id });
  return row.id;
}

async function insertDeviceSession(): Promise<string> {
  const [row] = await getDb()
    .insert(deviceSessions)
    .values({ deviceId: `kc-${randomUUID()}` })
    .returning({ id: deviceSessions.id });
  return row.id;
}

/** The bearer every following request carries. */
function actAs(
  userId: string,
  deviceSessionId: string | null,
  token: Record<string, unknown> = {},
) {
  mockAuth.userId = userId;
  mockAuth.kind = 'personal';
  mockAuth.token = { deviceSessionId, ...token };
}

/* -------------------------------------------------------------------------- */
/*  A device, as ADR 0063 D2 makes one                                        */
/* -------------------------------------------------------------------------- */

interface Device {
  id: string;
  signingSecret: Uint8Array;
  member: {
    id: string;
    name: string;
    platform: 'oxyos';
    signingKey: string;
    boxKey: string;
  };
}

function newDevice(name = 'Laptop'): Device {
  const signingSecret = ed25519.utils.randomSecretKey();
  const boxSecret = x25519.utils.randomSecretKey();
  const id = randomUUID();
  return {
    id,
    signingSecret,
    member: {
      id,
      name,
      platform: 'oxyos',
      signingKey: b64(ed25519.getPublicKey(signingSecret)),
      boxKey: b64(x25519.getPublicKey(boxSecret)),
    },
  };
}

interface RecoveryKey {
  signingSecret: Uint8Array;
  keys: { signingKey: string; boxKey: string };
}

function newRecovery(): RecoveryKey {
  const signingSecret = ed25519.utils.randomSecretKey();
  return {
    signingSecret,
    keys: {
      signingKey: b64(ed25519.getPublicKey(signingSecret)),
      boxKey: b64(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    },
  };
}

type Signer = { id: string; signingSecret: Uint8Array };

function recoverySigner(recovery: RecoveryKey): Signer {
  return { id: 'recovery', signingSecret: recovery.signingSecret };
}

/** A roster entry: the JCS body and a signature per signer over the domain-prefixed body. */
function entry(body: Record<string, unknown>, signers: Signer[]) {
  const text = canonicalize(body);
  const input = utf8(`${KEYCHAIN_DOMAINS.roster}\n${text}`);
  return {
    body: text,
    signatures: signers.map((signer) => ({
      signer: signer.id,
      signature: b64(ed25519.sign(input, signer.signingSecret)),
    })),
  };
}

const hashOf = (body: string): string => sha256Hex(`${KEYCHAIN_DOMAINS.roster}\n${body}`);

/** A wrap: random sealed bytes (Oxy never opens one), signed as ADR 0063 D8 says. */
function wrap(vaultId: string, recipient: string, generation: number, signer: Signer) {
  const fields = {
    recipient,
    generation,
    epk: b64(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    nonce: b64(randomBytes(24)),
    ciphertext: b64(randomBytes(96)),
    signer: signer.id,
  };
  const input = utf8(`${KEYCHAIN_DOMAINS.wrap}\n${canonicalize({ vaultId, ...fields })}`);
  return { ...fields, signature: b64(ed25519.sign(input, signer.signingSecret)) };
}

const NOW = '2026-11-07T12:00:00.000Z';

/** The roster as a test keeps it, to write the next entry. */
interface Vault {
  vaultId: string;
  seq: number;
  head: string;
  generation: number;
  recovery: RecoveryKey;
}

function next(vault: Vault, fields: Record<string, unknown>) {
  return {
    v: 1,
    vaultId: vault.vaultId,
    seq: vault.seq + 1,
    prev: vault.head,
    createdAt: NOW,
    ...fields,
  };
}

function advance(vault: Vault, appended: { body: string }[]): void {
  for (const e of appended) {
    vault.seq += 1;
    vault.head = hashOf(e.body);
  }
}

/** Make a vault for the current bearer with `device` as its first member. */
async function createVault(device: Device): Promise<Vault> {
  const recovery = newRecovery();
  const vaultId = randomUUID();
  const genesis = entry(
    {
      v: 1,
      vaultId,
      seq: 0,
      prev: null,
      op: 'genesis',
      member: device.member,
      recovery: recovery.keys,
      createdAt: NOW,
    },
    [device, recoverySigner(recovery)],
  );
  const res = await call('POST', '/keychain', {
    genesis,
    wraps: [wrap(vaultId, device.id, 1, device), wrap(vaultId, 'recovery', 1, device)],
  });
  expect(res.status).toBe(201);
  return { vaultId, seq: 0, head: hashOf(genesis.body), generation: 1, recovery };
}

const commitInput = (vaultId: string, member: Device['member'], deviceNonce: Uint8Array) =>
  Buffer.concat([
    Buffer.from(`${KEYCHAIN_DOMAINS.enrollCommit}\n${canonicalize({ vaultId, member })}`, 'utf8'),
    Buffer.from([0]),
    Buffer.from(deviceNonce),
  ]);

function commitmentOf(vaultId: string, member: Device['member'], deviceNonce: Uint8Array): string {
  return b64(
    createHash('sha256')
      .update(commitInput(vaultId, member, deviceNonce))
      .digest(),
  );
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/keychain', keychainRouter);
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

let OWNER = '';
let SESSION_A = '';
let A: Device;

beforeEach(async () => {
  OWNER = await insertUser();
  SESSION_A = await insertDeviceSession();
  A = newDevice('Laptop');
  actAs(OWNER, SESSION_A);
  mockVerifyAccountReauth.mockReset();
});

/* -------------------------------------------------------------------------- */
/*  Who may call                                                              */
/* -------------------------------------------------------------------------- */

describe('who may call', () => {
  it('refuses a third-party application session', async () => {
    actAs(OWNER, SESSION_A, { applicationId: randomUUID() });
    const res = await call('GET', '/keychain');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('third_party_device_access_denied');
  });

  it('refuses an application token, but lets the platform’s own (`host.self`) through', async () => {
    actAs(OWNER, SESSION_A, {
      host: {
        platform: 'oxyos',
        credentialId: 'c',
        clientId: 'x',
        applicationId: 'app',
        self: false,
      },
    });
    const refused = await call('GET', '/keychain');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('app_token_device_access_denied');

    actAs(OWNER, SESSION_A, {
      host: {
        platform: 'oxyos',
        credentialId: 'c',
        clientId: 'x',
        applicationId: 'app',
        self: true,
      },
    });
    const allowed = await call('GET', '/keychain');
    expect(allowed.status).toBe(200);
  });

  it('refuses an account that is not personal', async () => {
    mockAuth.kind = 'organization';
    const res = await call('GET', '/keychain');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('KEYCHAIN_NOT_AVAILABLE');
  });

  it('refuses someone acting as another account', async () => {
    actAs(OWNER, SESSION_A, { principalUserId: await insertUser() });
    const res = await call('GET', '/keychain');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('KEYCHAIN_NOT_AVAILABLE');
  });

  it('refuses a bearer without a device session', async () => {
    actAs(OWNER, null);
    const res = await call('GET', '/keychain');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('KEYCHAIN_DEVICE_REQUIRED');
  });

  it('marks every answer uncacheable', async () => {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/keychain`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

/* -------------------------------------------------------------------------- */
/*  Creating the vault                                                        */
/* -------------------------------------------------------------------------- */

describe('POST /keychain', () => {
  it('answers no vault before one exists', async () => {
    const res = await call('GET', '/keychain');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ vault: null, roster: [], members: [], self: null });
  });

  it('creates the vault, binds its member to the caller’s device session, and stores both wraps', async () => {
    const vault = await createVault(A);
    const res = await call('GET', '/keychain');
    expect(res.body.data).toMatchObject({
      vault: {
        id: vault.vaultId,
        genesisHash: vault.head,
        rosterSeq: 0,
        generation: 1,
        revision: 0,
      },
      members: [{ id: A.id, orphaned: false, removed: false }],
      self: A.id,
    });
    expect(res.body.data.roster).toHaveLength(1);

    const [member] = await getDb()
      .select()
      .from(keychainMembers)
      .where(eq(keychainMembers.vaultId, vault.vaultId));
    expect(member.deviceSessionId).toBe(SESSION_A);
    const wraps = await getDb()
      .select({ recipient: keychainWraps.recipient })
      .from(keychainWraps)
      .where(eq(keychainWraps.vaultId, vault.vaultId));
    expect(wraps.map((w) => w.recipient).sort()).toEqual([A.id, 'recovery'].sort());

    const own = await call('GET', '/keychain/wrap');
    expect(own.status).toBe(200);
    expect(own.body.data.wrap.recipient).toBe(A.id);
    const recovery = await call('GET', '/keychain/recovery');
    expect(recovery.body.data.wrap.recipient).toBe('recovery');
  });

  it('refuses a second vault', async () => {
    await createVault(A);
    const recovery = newRecovery();
    const vaultId = randomUUID();
    const res = await call('POST', '/keychain', {
      genesis: entry(
        {
          v: 1,
          vaultId,
          seq: 0,
          prev: null,
          op: 'genesis',
          member: A.member,
          recovery: recovery.keys,
          createdAt: NOW,
        },
        [A, recoverySigner(recovery)],
      ),
      wraps: [wrap(vaultId, A.id, 1, A), wrap(vaultId, 'recovery', 1, A)],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('KEYCHAIN_EXISTS');
  });

  it('refuses a genesis whose recovery signature was made with another key', async () => {
    const recovery = newRecovery();
    const vaultId = randomUUID();
    const res = await call('POST', '/keychain', {
      genesis: entry(
        {
          v: 1,
          vaultId,
          seq: 0,
          prev: null,
          op: 'genesis',
          member: A.member,
          recovery: recovery.keys,
          createdAt: NOW,
        },
        [A, recoverySigner(newRecovery())],
      ),
      wraps: [wrap(vaultId, A.id, 1, A), wrap(vaultId, 'recovery', 1, A)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
    expect(
      await getDb().select().from(keychainVaults).where(eq(keychainVaults.id, vaultId)),
    ).toEqual([]);
  });

  it('refuses a body that is not its own JCS, even with valid signatures over it', async () => {
    const recovery = newRecovery();
    const vaultId = randomUUID();
    const fields = {
      v: 1,
      vaultId,
      seq: 0,
      prev: null,
      op: 'genesis',
      member: A.member,
      recovery: recovery.keys,
      createdAt: NOW,
    };
    const body = JSON.stringify(fields, null, 1);
    const input = utf8(`${KEYCHAIN_DOMAINS.roster}\n${body}`);
    const res = await call('POST', '/keychain', {
      genesis: {
        body,
        signatures: [
          { signer: A.id, signature: b64(ed25519.sign(input, A.signingSecret)) },
          { signer: 'recovery', signature: b64(ed25519.sign(input, recovery.signingSecret)) },
        ],
      },
      wraps: [wrap(vaultId, A.id, 1, A), wrap(vaultId, 'recovery', 1, A)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('refuses a body with a key the entry does not have', async () => {
    const recovery = newRecovery();
    const vaultId = randomUUID();
    const res = await call('POST', '/keychain', {
      genesis: entry(
        {
          v: 1,
          vaultId,
          seq: 0,
          prev: null,
          op: 'genesis',
          member: A.member,
          recovery: recovery.keys,
          createdAt: NOW,
          extra: true,
        },
        [A, recoverySigner(recovery)],
      ),
      wraps: [wrap(vaultId, A.id, 1, A), wrap(vaultId, 'recovery', 1, A)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('refuses a wrap not signed by the member', async () => {
    const recovery = newRecovery();
    const vaultId = randomUUID();
    const res = await call('POST', '/keychain', {
      genesis: entry(
        {
          v: 1,
          vaultId,
          seq: 0,
          prev: null,
          op: 'genesis',
          member: A.member,
          recovery: recovery.keys,
          createdAt: NOW,
        },
        [A, recoverySigner(recovery)],
      ),
      wraps: [
        wrap(vaultId, A.id, 1, A),
        wrap(vaultId, 'recovery', 1, { id: A.id, signingSecret: ed25519.utils.randomSecretKey() }),
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_WRAP_INVALID');
  });

  it('refuses unknown request keys and a key that is not 32 bytes', async () => {
    const strict = await call('POST', '/keychain', {
      genesis: { body: '{}', signatures: [] },
      wraps: [],
      x: 1,
    });
    expect(strict.status).toBe(400);
    const vaultId = randomUUID();
    const recovery = newRecovery();
    const short = await call('POST', '/keychain', {
      genesis: entry(
        {
          v: 1,
          vaultId,
          seq: 0,
          prev: null,
          op: 'genesis',
          member: { ...A.member, boxKey: b64(randomBytes(31)) },
          recovery: recovery.keys,
          createdAt: NOW,
        },
        [A, recoverySigner(recovery)],
      ),
      wraps: [wrap(vaultId, A.id, 1, A), wrap(vaultId, 'recovery', 1, A)],
    });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });
});

/* -------------------------------------------------------------------------- */
/*  Adding a device                                                           */
/* -------------------------------------------------------------------------- */

describe('enrollment', () => {
  let vault: Vault;
  let B: Device;
  let SESSION_B: string;

  beforeEach(async () => {
    vault = await createVault(A);
    B = newDevice('Phone');
    SESSION_B = await insertDeviceSession();
  });

  async function enroll(deviceNonce: Uint8Array) {
    actAs(OWNER, SESSION_B);
    const res = await call('POST', '/keychain/enrollments', {
      member: B.member,
      commitment: commitmentOf(vault.vaultId, B.member, deviceNonce),
    });
    expect(res.status).toBe(201);
    return res.body.data.enrollment.id as string;
  }

  async function open(id: string) {
    actAs(OWNER, SESSION_A);
    return call('POST', `/keychain/enrollments/${id}/approver-nonce`, {
      memberId: A.id,
      approverNonce: b64(randomBytes(32)),
    });
  }

  it('adds the device: request, approver’s nonce, reveal, approval, all bound to the ENROLLING session', async () => {
    const deviceNonce = randomBytes(32);
    const id = await enroll(deviceNonce);

    actAs(OWNER, SESSION_A);
    const listed = await call('GET', '/keychain/enrollments');
    expect(listed.body.data.enrollments.map((e: { id: string }) => e.id)).toEqual([id]);
    expect((await open(id)).status).toBe(200);

    actAs(OWNER, SESSION_B);
    const revealed = await call('POST', `/keychain/enrollments/${id}/reveal`, {
      deviceNonce: b64(deviceNonce),
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body.data.enrollment.deviceNonce).toBe(b64(deviceNonce));

    actAs(OWNER, SESSION_A);
    const add = entry(next(vault, { op: 'add', member: B.member }), [A]);
    const approved = await call('POST', `/keychain/enrollments/${id}/approve`, {
      entry: add,
      wrap: wrap(vault.vaultId, B.id, 1, A),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data.vault.rosterSeq).toBe(1);
    expect(approved.body.data.self).toBe(A.id);

    actAs(OWNER, SESSION_B);
    const state = await call('GET', '/keychain');
    expect(state.body.data.self).toBe(B.id);
    const own = await call('GET', '/keychain/wrap');
    expect(own.status).toBe(200);
    expect(own.body.data.wrap).toMatchObject({ recipient: B.id, signer: A.id });
    const read = await call('GET', `/keychain/enrollments/${id}`);
    expect(read.body.data.enrollment.status).toBe('approved');
  });

  it('refuses a revealed nonce that does not open the commitment, and denies the request', async () => {
    const id = await enroll(randomBytes(32));
    await open(id);
    actAs(OWNER, SESSION_B);
    const res = await call('POST', `/keychain/enrollments/${id}/reveal`, {
      deviceNonce: b64(randomBytes(32)),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_COMMITMENT_MISMATCH');
    const read = await call('GET', `/keychain/enrollments/${id}`);
    expect(read.body.data.enrollment.status).toBe('denied');
  });

  it('refuses an expired request (410) at every step', async () => {
    const deviceNonce = randomBytes(32);
    const id = await enroll(deviceNonce);
    await getDb()
      .update(keychainEnrollments)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(keychainEnrollments.id, id));
    const opened = await open(id);
    expect(opened.status).toBe(410);
    expect(opened.body.error).toBe('KEYCHAIN_ENROLLMENT_EXPIRED');
    actAs(OWNER, SESSION_B);
    expect((await call('GET', `/keychain/enrollments/${id}`)).status).toBe(410);
  });

  it('refuses a reveal before the approver’s nonce, and a second approver', async () => {
    const deviceNonce = randomBytes(32);
    const id = await enroll(deviceNonce);
    const early = await call('POST', `/keychain/enrollments/${id}/reveal`, {
      deviceNonce: b64(deviceNonce),
    });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('KEYCHAIN_ENROLLMENT_STATE');
    expect((await open(id)).status).toBe(200);
    expect((await open(id)).status).toBe(409);
  });

  it('refuses an approval that adds another member than the one requested', async () => {
    const deviceNonce = randomBytes(32);
    const id = await enroll(deviceNonce);
    await open(id);
    actAs(OWNER, SESSION_B);
    await call('POST', `/keychain/enrollments/${id}/reveal`, { deviceNonce: b64(deviceNonce) });

    actAs(OWNER, SESSION_A);
    const impostor = newDevice('Phone');
    const res = await call('POST', `/keychain/enrollments/${id}/approve`, {
      entry: entry(next(vault, { op: 'add', member: { ...impostor.member, id: B.id } }), [A]),
      wrap: wrap(vault.vaultId, B.id, 1, A),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('serves nothing to a device whose session is not the member’s', async () => {
    actAs(OWNER, SESSION_B);
    const wrapRes = await call('GET', '/keychain/wrap');
    expect(wrapRes.status).toBe(403);
    expect(wrapRes.body.error).toBe('KEYCHAIN_NOT_MEMBER');
    const items = await call('GET', '/keychain/items');
    expect(items.status).toBe(403);
    const list = await call('GET', '/keychain/enrollments');
    expect(list.status).toBe(403);
    const put = await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 1,
      nonce: b64(randomBytes(24)),
      ciphertext: b64(randomBytes(300)),
    });
    expect(put.status).toBe(403);
    // …and the recovery wrap, which opens only with the recovery key, is any device's.
    expect((await call('GET', '/keychain/recovery')).status).toBe(200);
  });

  it('keeps at most four pending requests, one per device', async () => {
    for (let index = 0; index < KEYCHAIN_LIMITS.maxPendingEnrollments; index++) {
      actAs(OWNER, await insertDeviceSession());
      const device = newDevice();
      const res = await call('POST', '/keychain/enrollments', {
        member: device.member,
        commitment: b64(randomBytes(32)),
      });
      expect(res.status).toBe(201);
    }
    actAs(OWNER, SESSION_B);
    const res = await call('POST', '/keychain/enrollments', {
      member: B.member,
      commitment: b64(randomBytes(32)),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('KEYCHAIN_LIMIT_REACHED');
  });

  it('refuses a request from a device that is already a member', async () => {
    actAs(OWNER, SESSION_A);
    const res = await call('POST', '/keychain/enrollments', {
      member: newDevice().member,
      commitment: b64(randomBytes(32)),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('KEYCHAIN_ALREADY_MEMBER');
  });

  it('lets a member deny a request, and the device withdraw its own', async () => {
    const id = await enroll(randomBytes(32));
    actAs(OWNER, SESSION_A);
    expect((await call('DELETE', `/keychain/enrollments/${id}`)).status).toBe(204);
    actAs(OWNER, SESSION_B);
    expect((await call('GET', `/keychain/enrollments/${id}`)).body.data.enrollment.status).toBe(
      'denied',
    );
    expect((await call('DELETE', `/keychain/enrollments/${id}`)).status).toBe(204);
    expect((await call('GET', `/keychain/enrollments/${id}`)).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/*  The roster                                                                */
/* -------------------------------------------------------------------------- */

describe('POST /keychain/roster', () => {
  let vault: Vault;
  let B: Device;
  let SESSION_B: string;

  /** Add B through the recovery key from B's own session (ADR 0063 D6). */
  async function addByRecovery(device: Device, session: string) {
    actAs(OWNER, session);
    const add = entry(next(vault, { op: 'add', member: device.member }), [
      recoverySigner(vault.recovery),
    ]);
    const res = await call('POST', '/keychain/roster', {
      entries: [add],
      wraps: [wrap(vault.vaultId, device.id, vault.generation, recoverySigner(vault.recovery))],
    });
    if (res.status === 200) advance(vault, [add]);
    return res;
  }

  beforeEach(async () => {
    vault = await createVault(A);
    B = newDevice('Phone');
    SESSION_B = await insertDeviceSession();
  });

  it('adds a device with the recovery key, bound to the caller’s session', async () => {
    const res = await addByRecovery(B, SESSION_B);
    expect(res.status).toBe(200);
    expect(res.body.data.self).toBe(B.id);
    const own = await call('GET', '/keychain/wrap');
    expect(own.body.data.wrap.signer).toBe('recovery');
  });

  it('refuses a recovery add signed with a key that is not the recovery key', async () => {
    actAs(OWNER, SESSION_B);
    const forged = newRecovery();
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'add', member: B.member }), [recoverySigner(forged)])],
      wraps: [wrap(vault.vaultId, B.id, 1, recoverySigner(forged))],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('refuses an entry signed by a device that is not a member', async () => {
    const stranger = newDevice();
    actAs(OWNER, SESSION_A);
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'generation', generation: 2 }), [stranger])],
      wraps: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('refuses a non-member that is not recovering', async () => {
    actAs(OWNER, SESSION_B);
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'generation', generation: 2 }), [A])],
      wraps: [],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('KEYCHAIN_NOT_MEMBER');
  });

  it('refuses an append that does not continue the head (a fork), and a lost race', async () => {
    const recovery = newRecovery();
    const rotate = (r: RecoveryKey) =>
      entry(next(vault, { op: 'recovery', recovery: r.keys }), [A]);
    actAs(OWNER, SESSION_A);
    const first = rotate(recovery);
    const second = rotate(newRecovery());
    const [one, two] = await Promise.all([
      call('POST', '/keychain/roster', {
        entries: [first],
        wraps: [wrap(vault.vaultId, 'recovery', 1, A)],
      }),
      call('POST', '/keychain/roster', {
        entries: [second],
        wraps: [wrap(vault.vaultId, 'recovery', 1, A)],
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect([one, two].find((r) => r.status === 409)?.body.error).toBe('KEYCHAIN_ROSTER_CONFLICT');
    const entries = await getDb()
      .select()
      .from(keychainRosterEntries)
      .where(eq(keychainRosterEntries.vaultId, vault.vaultId));
    expect(entries).toHaveLength(2);

    // A stale prev at the next seq is a fork: refused, nothing stored.
    const fork = entry({ ...next(vault, { op: 'generation', generation: 2 }), seq: 1 }, [A]);
    const forked = await call('POST', '/keychain/roster', { entries: [fork], wraps: [] });
    expect(forked.status).toBe(409);
  });

  it('refuses a removal without a new generation', async () => {
    await addByRecovery(B, SESSION_B);
    actAs(OWNER, SESSION_A);
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'remove', memberId: B.id }), [A])],
      wraps: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROTATION_INCOMPLETE');
  });

  it('refuses a rotation that leaves a remaining recipient without the new key', async () => {
    await addByRecovery(B, SESSION_B);
    actAs(OWNER, SESSION_A);
    const remove = entry(next(vault, { op: 'remove', memberId: B.id }), [A]);
    const generation = entry(
      {
        ...next(vault, { op: 'generation', generation: 2 }),
        seq: vault.seq + 2,
        prev: hashOf(remove.body),
      },
      [A],
    );
    const res = await call('POST', '/keychain/roster', {
      entries: [remove, generation],
      wraps: [wrap(vault.vaultId, A.id, 2, A)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROTATION_INCOMPLETE');
  });

  it('removes a device with a full rotation: its wrap is gone and it is served nothing', async () => {
    await addByRecovery(B, SESSION_B);
    actAs(OWNER, SESSION_A);
    const remove = entry(next(vault, { op: 'remove', memberId: B.id }), [A]);
    const generation = entry(
      {
        ...next(vault, { op: 'generation', generation: 2 }),
        seq: vault.seq + 2,
        prev: hashOf(remove.body),
      },
      [A],
    );
    const res = await call('POST', '/keychain/roster', {
      entries: [remove, generation],
      wraps: [wrap(vault.vaultId, A.id, 2, A), wrap(vault.vaultId, 'recovery', 2, A)],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.vault.generation).toBe(2);
    expect(res.body.data.members).toEqual(
      expect.arrayContaining([{ id: B.id, orphaned: false, removed: true }]),
    );
    const wrapB = await getDb()
      .select()
      .from(keychainWraps)
      .where(and(eq(keychainWraps.vaultId, vault.vaultId), eq(keychainWraps.recipient, B.id)));
    expect(wrapB).toEqual([]);
    actAs(OWNER, SESSION_B);
    expect((await call('GET', '/keychain/wrap')).status).toBe(403);
  });

  it('refuses a wrap for a removed member in the rotation', async () => {
    await addByRecovery(B, SESSION_B);
    actAs(OWNER, SESSION_A);
    const remove = entry(next(vault, { op: 'remove', memberId: B.id }), [A]);
    const generation = entry(
      {
        ...next(vault, { op: 'generation', generation: 2 }),
        seq: vault.seq + 2,
        prev: hashOf(remove.body),
      },
      [A],
    );
    const res = await call('POST', '/keychain/roster', {
      entries: [remove, generation],
      wraps: [
        wrap(vault.vaultId, A.id, 2, A),
        wrap(vault.vaultId, 'recovery', 2, A),
        wrap(vault.vaultId, B.id, 2, A),
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_WRAP_INVALID');
  });

  it('replaces the recovery key with its wrap', async () => {
    actAs(OWNER, SESSION_A);
    const replacement = newRecovery();
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'recovery', recovery: replacement.keys }), [A])],
      wraps: [wrap(vault.vaultId, 'recovery', 1, A)],
    });
    expect(res.status).toBe(200);
    // The old recovery key no longer adds a device.
    const C = newDevice();
    const after = res.body.data.vault;
    actAs(OWNER, await insertDeviceSession());
    const stale = await call('POST', '/keychain/roster', {
      entries: [
        entry(
          {
            v: 1,
            vaultId: vault.vaultId,
            seq: after.rosterSeq + 1,
            prev: after.rosterHead,
            createdAt: NOW,
            op: 'add',
            member: C.member,
          },
          [recoverySigner(vault.recovery)],
        ),
      ],
      wraps: [wrap(vault.vaultId, C.id, 1, recoverySigner(vault.recovery))],
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });

  it('refuses an add by a member outside an enrollment', async () => {
    actAs(OWNER, SESSION_A);
    const res = await call('POST', '/keychain/roster', {
      entries: [entry(next(vault, { op: 'add', member: B.member }), [A])],
      wraps: [wrap(vault.vaultId, B.id, 1, A)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_ROSTER_INVALID');
  });
});

/* -------------------------------------------------------------------------- */
/*  Items                                                                     */
/* -------------------------------------------------------------------------- */

describe('items', () => {
  let vault: Vault;
  beforeEach(async () => {
    vault = await createVault(A);
  });

  const sealed = () => ({ nonce: b64(randomBytes(24)), ciphertext: b64(randomBytes(272)) });

  it('creates, replaces on the right base revision, refuses a stale one, and deletes with a tombstone', async () => {
    const itemId = randomUUID();
    const created = await call('PUT', `/keychain/items/${itemId}`, {
      baseRevision: null,
      generation: 1,
      ...sealed(),
    });
    expect(created.status).toBe(200);
    expect(created.body.data.item).toMatchObject({ id: itemId, revision: 1, deletedAt: null });

    const again = await call('PUT', `/keychain/items/${itemId}`, {
      baseRevision: null,
      generation: 1,
      ...sealed(),
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('KEYCHAIN_ITEM_CONFLICT');

    const replaced = await call('PUT', `/keychain/items/${itemId}`, {
      baseRevision: 1,
      generation: 1,
      ...sealed(),
    });
    expect(replaced.body.data.item.revision).toBe(2);
    const stale = await call('PUT', `/keychain/items/${itemId}`, {
      baseRevision: 1,
      generation: 1,
      ...sealed(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('KEYCHAIN_ITEM_CONFLICT');

    const staleDelete = await call('DELETE', `/keychain/items/${itemId}`, { baseRevision: 1 });
    expect(staleDelete.status).toBe(409);
    const deleted = await call('DELETE', `/keychain/items/${itemId}`, { baseRevision: 2 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.item).toMatchObject({ revision: 3, nonce: null, ciphertext: null });
    expect(deleted.body.data.item.deletedAt).not.toBeNull();

    const other = randomUUID();
    await call('PUT', `/keychain/items/${other}`, {
      baseRevision: null,
      generation: 1,
      ...sealed(),
    });

    const all = await call('GET', '/keychain/items');
    expect(all.body.data).toMatchObject({ revision: 4, more: false });
    expect(
      all.body.data.items.map((i: { id: string; revision: number }) => [i.id, i.revision]),
    ).toEqual([
      [itemId, 3],
      [other, 4],
    ]);
    const since = await call('GET', '/keychain/items?since=3');
    expect(since.body.data.items.map((i: { id: string }) => i.id)).toEqual([other]);
    const page = await call('GET', '/keychain/items?since=0&limit=1');
    expect(page.body.data).toMatchObject({ more: true, revision: 4 });
    expect(page.body.data.items).toHaveLength(1);

    // A tombstone comes back to life only on its own revision.
    const revived = await call('PUT', `/keychain/items/${itemId}`, {
      baseRevision: 3,
      generation: 1,
      ...sealed(),
    });
    expect(revived.body.data.item).toMatchObject({ revision: 5, deletedAt: null });
  });

  it('refuses a generation the vault does not have', async () => {
    const res = await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 2,
      ...sealed(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('KEYCHAIN_GENERATION_INVALID');
  });

  it('refuses an item over the size limit and a malformed nonce', async () => {
    const big = await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 1,
      nonce: b64(randomBytes(24)),
      ciphertext: 'A'.repeat(KEYCHAIN_LIMITS.maxCiphertextLength + 4),
    });
    expect(big.status).toBe(400);
    const nonce = await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 1,
      nonce: b64(randomBytes(12)),
      ciphertext: b64(randomBytes(272)),
    });
    expect(nonce.status).toBe(400);
    const notUuid = await call('PUT', '/keychain/items/not-a-uuid', {
      baseRevision: null,
      generation: 1,
      ...sealed(),
    });
    expect(notUuid.status).toBe(400);
  });

  it('refuses the item past the live-item limit', async () => {
    const rows = Array.from({ length: KEYCHAIN_LIMITS.maxLiveItems }, (_, index) => ({
      vaultId: vault.vaultId,
      itemId: randomUUID(),
      revision: index + 1,
      generation: 1,
      ...sealed(),
    }));
    for (let start = 0; start < rows.length; start += 1000) {
      await getDb()
        .insert(keychainItems)
        .values(rows.slice(start, start + 1000));
    }
    await getDb()
      .update(keychainVaults)
      .set({ revision: rows.length })
      .where(eq(keychainVaults.id, vault.vaultId));
    const res = await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 1,
      ...sealed(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('KEYCHAIN_LIMIT_REACHED');
  });
});

/* -------------------------------------------------------------------------- */
/*  Device sessions and the account                                           */
/* -------------------------------------------------------------------------- */

describe('lifecycle', () => {
  it('orphans a member whose device session row is deleted, and serves it nothing', async () => {
    const vault = await createVault(A);
    await getDb().delete(deviceSessions).where(eq(deviceSessions.id, SESSION_A));
    const [member] = await getDb()
      .select({ deviceSessionId: keychainMembers.deviceSessionId })
      .from(keychainMembers)
      .where(eq(keychainMembers.vaultId, vault.vaultId));
    expect(member.deviceSessionId).toBeNull();

    const state = await call('GET', '/keychain');
    expect(state.body.data.members).toEqual([{ id: A.id, orphaned: true, removed: false }]);
    expect(state.body.data.self).toBeNull();
    expect((await call('GET', '/keychain/wrap')).status).toBe(403);
    expect((await call('GET', '/keychain/items')).status).toBe(403);
  });

  it('deletes the vault and everything under it with the account', async () => {
    const vault = await createVault(A);
    await call('PUT', `/keychain/items/${randomUUID()}`, {
      baseRevision: null,
      generation: 1,
      nonce: b64(randomBytes(24)),
      ciphertext: b64(randomBytes(272)),
    });
    await getDb().delete(users).where(eq(users.id, OWNER));
    for (const table of [
      keychainRosterEntries,
      keychainMembers,
      keychainWraps,
      keychainItems,
      keychainEnrollments,
    ]) {
      expect(await getDb().select().from(table).where(eq(table.vaultId, vault.vaultId))).toEqual(
        [],
      );
    }
    expect(
      await getDb().select().from(keychainVaults).where(eq(keychainVaults.id, vault.vaultId)),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reset                                                                     */
/* -------------------------------------------------------------------------- */

describe('DELETE /keychain', () => {
  it('needs a fresh `reset_keychain` re-verification, and then deletes everything', async () => {
    const vault = await createVault(A);
    mockVerifyAccountReauth.mockImplementation(async (_userId: string, proof: unknown) => {
      if (!proof)
        throw new ApiError(401, 'Confirm it is you first.', SIGN_IN_ERROR_CODES.reauthRequired);
    });
    const refused = await call('DELETE', '/keychain', {});
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('REAUTH_REQUIRED');
    expect(
      await getDb().select().from(keychainVaults).where(eq(keychainVaults.id, vault.vaultId)),
    ).toHaveLength(1);

    const reset = await call('DELETE', '/keychain', {
      reauth: { password: 'a password the test made up' },
    });
    expect(reset.status).toBe(204);
    expect(mockVerifyAccountReauth).toHaveBeenLastCalledWith(
      OWNER,
      { password: 'a password the test made up' },
      'reset_keychain',
    );
    expect(
      await getDb().select().from(keychainVaults).where(eq(keychainVaults.id, vault.vaultId)),
    ).toEqual([]);
    expect((await call('GET', '/keychain')).body.data.vault).toBeNull();
  });

  it('spends nothing when there is no vault', async () => {
    const res = await call('DELETE', '/keychain', { reauth: { password: 'x' } });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('KEYCHAIN_NOT_FOUND');
    expect(mockVerifyAccountReauth).not.toHaveBeenCalled();
  });

  it('on an account with a linked root, needs a one-use root proof bound to the vault', async () => {
    const root = generateSecp256k1KeyPair();
    const owner = await insertUser({ publicKey: root.publicKey.toLowerCase() });
    const session = await insertDeviceSession();
    actAs(owner, session);
    const device = newDevice();
    const vault = await createVault(device);

    const missing = await call('DELETE', '/keychain', {});
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('KEYCHAIN_RESET_PROOF_REQUIRED');

    const proofFor = async (vaultId: string) => {
      const { challenge, expiresAt } = await mintIdentityProofChallenge(owner, 'keychain_reset');
      const message = buildIdentityProofMessage({
        action: 'keychain_reset',
        subject: owner,
        actor: owner,
        rootPublicKey: root.publicKey.toLowerCase(),
        payloadDigest: digestIdentityPayload({ vaultId }),
        expectedRevision: null,
        audience: IDENTITY_PROOF_AUDIENCE,
        challenge,
        expiresAt,
      });
      return {
        v: 2,
        challenge,
        expiresAt,
        signature: SignatureService.signMessage(message, root.privateKey),
      };
    };

    const otherVault = await call('DELETE', '/keychain', {
      rootProof: await proofFor(randomUUID()),
    });
    expect(otherVault.status).toBe(401);
    expect(otherVault.body.error).toBe('IDENTITY_PROOF_INVALID');

    const proof = await proofFor(vault.vaultId);
    expect((await call('DELETE', '/keychain', { rootProof: proof })).status).toBe(204);
    expect(mockVerifyAccountReauth).not.toHaveBeenCalled();
    expect(
      await getDb().select().from(keychainVaults).where(eq(keychainVaults.id, vault.vaultId)),
    ).toEqual([]);
  });
});
