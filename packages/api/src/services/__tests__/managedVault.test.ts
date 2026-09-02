/**
 * F5c managed-vault provisioning (`provisionManagedVault`), against a REAL
 * Postgres and a REAL custodial signature.
 *
 * The suite this replaces mocked `models/UserNode`, `models/User`,
 * `signedRecord.service`, `repoLog.service`, `signature.service` and
 * `@oxyhq/protocol`, so "custodial-signs a node record, stores it, and
 * materializes a managed UserNode" was checked by reading back the arguments the
 * service had passed to `mockVerifyAndStoreRecord` — a mock that returned
 * `{ ok: true }` no matter what it was handed. Nothing was signed, verified or
 * stored, and none of those models is imported by the service any more.
 *
 * Here the Oxy custodial keypair is real, the envelope really is signed with
 * `OXY_PRIVATE_KEY`, and the chain append goes through the real
 * `verifyAndStoreRecord` — so the record only lands if the custodial signature
 * verifies against the published `OXY_PUBLIC_KEY`, which is the whole point of
 * a custodial provenance record.
 *
 * The guarantees:
 *
 *  - **The vault is a CHAIN registration, not a row.** A `node` record is
 *    appended to the user's own chain (issuer `OXY_DID`, `app.oxy.node`/`self`)
 *    and the head advances; the `user_nodes` row is the projection of it.
 *  - **It fails CLOSED.** No custodial key, no configured fleet base URL, no
 *    such account, or a signature that does not verify → a named reason and
 *    NOTHING written. A half-built vault is worse than none.
 *  - **It is idempotent.** Re-provisioning an active managed vault at the same
 *    endpoint appends no second chain record — a "create my vault" button a user
 *    can double-tap must not grow the ledger.
 *  - **The endpoint is DERIVED from configuration**, never hardcoded.
 *
 * Only `safeFetch` is mocked — the liveness probe is the network.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { eq } from 'drizzle-orm';

const mockSafeFetch = jest.fn();
jest.mock('@oxyhq/core/server', () => ({
  ...jest.requireActual('@oxyhq/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { userNodes } from '../../db/schema/userNodes';
import { users } from '../../db/schema/users';
import userCache from '../../utils/userCache';
import { NODE_COLLECTION, NODE_RKEY } from '../../utils/nodes.constants';
import { OXY_DID, buildUserDid } from '../did.service';
import { getUserNode, provisionManagedVault, removeNode } from '../nodeRegistry.service';


/** Oxy's custodial keypair for the run — what a managed vault is signed with. */
const oxyKey = generateSecp256k1KeyPair();
const OXY_PUBLIC_KEY = oxyKey.publicKey;
const OXY_PRIVATE_KEY = oxyKey.privateKey;

const ENV_KEYS = [
  'OXY_PRIVATE_KEY',
  'OXY_PUBLIC_KEY',
  'MANAGED_NODE_BASE_URL',
  'MANAGED_NODE_PUBLIC_KEY',
] as const;
const originalEnv: Record<string, string | undefined> = {};

let invalidateSpy: jest.SpyInstance<void, [string]>;

beforeAll(async () => {
  await connectPostgres();
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE_KEY;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC_KEY;
  process.env.MANAGED_NODE_BASE_URL = 'https://nodes.oxy.so';
  delete process.env.MANAGED_NODE_PUBLIC_KEY;
  mockSafeFetch.mockResolvedValue({
    status: 200,
    response: { destroy: jest.fn() },
    headers: {},
    finalUrl: '',
  });
});

afterEach(() => {
  invalidateSpy.mockRestore();
});

/** A fresh account with no chain and no node. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** Every chain record on an account, newest last. */
async function chainRecords(userId: string) {
  return getDb()
    .select({
      type: signedRecords.type,
      seq: signedRecords.seq,
      nsid: signedRecords.nsid,
      rkey: signedRecords.rkey,
      publicKey: signedRecords.publicKey,
      verified: signedRecords.verified,
      envelope: signedRecords.envelope,
    })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
}

/** The `user_nodes` row as stored, or `undefined`. */
async function storedNode(userId: string) {
  const [row] = await getDb().select().from(userNodes).where(eq(userNodes.userId, userId)).limit(1);
  return row;
}

/**
 * Poll until the fire-and-forget liveness probe has written, so a floating write
 * never lands after the test that caused it. Fails loudly rather than silently.
 */
async function settleProbe(userId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const row = await storedNode(userId);
    if (row === undefined || row.lastProbeAt !== null) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the managed-vault liveness probe');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Poll until a probe reaches `safeFetch` on a node that has ALREADY been probed
 * once, where `last_probe_at` can no longer distinguish "probed again" from
 * "probed before". Fails loudly rather than silently.
 */
async function settleSecondProbe(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (mockSafeFetch.mock.calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the re-provision liveness probe');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('provisionManagedVault — the vault is a chain registration', () => {
  it('custodial-signs a node record onto the chain and projects it into the cache', async () => {
    const userId = await account();

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    const endpoint = `https://nodes.oxy.so/u/${userId}`;

    // The chain record: Oxy-issued, verified, at the node collection/key.
    const records = await chainRecords(userId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'node',
      seq: 0,
      nsid: NODE_COLLECTION,
      rkey: NODE_RKEY,
      publicKey: OXY_PUBLIC_KEY,
      verified: true,
    });
    expect(records[0].envelope).toMatchObject({
      version: 2,
      type: 'node',
      subject: buildUserDid(userId),
      issuer: OXY_DID,
      prev: null,
      collection: NODE_COLLECTION,
      rkey: NODE_RKEY,
      alg: 'ES256K-DER-SHA256',
      record: { endpoint, nodePublicKey: OXY_PUBLIC_KEY, mode: 'pull', managed: true },
    });

    // The head advanced with it.
    const [head] = await getDb()
      .select({ seq: repoHeads.seq, recordCount: repoHeads.recordCount })
      .from(repoHeads)
      .where(eq(repoHeads.userId, userId));
    expect(head).toEqual({ seq: 0, recordCount: 1 });

    // The projection: Oxy-operated, active, at the derived endpoint.
    expect(result.node).toMatchObject({
      endpoint,
      nodePublicKey: OXY_PUBLIC_KEY,
      mode: 'pull',
      managed: true,
      controller: 'oxy',
      status: 'active',
    });
    expect(await storedNode(userId)).toMatchObject({ managed: true, controller: 'oxy', status: 'active' });
    expect(invalidateSpy).toHaveBeenCalledWith(userId);

    await settleProbe(userId);
  });

  it('derives the endpoint from MANAGED_NODE_BASE_URL, trailing slash and all', async () => {
    process.env.MANAGED_NODE_BASE_URL = 'https://vault.example.org/';
    const userId = await account();

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    expect(result.node.endpoint).toBe(`https://vault.example.org/u/${userId}`);
    await settleProbe(userId);
  });

  it('uses a dedicated fleet key when MANAGED_NODE_PUBLIC_KEY is set', async () => {
    const fleetKey = generateSecp256k1KeyPair().publicKey;
    process.env.MANAGED_NODE_PUBLIC_KEY = fleetKey;
    const userId = await account();

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    // The NODE's key is the fleet key; the record is still SIGNED by the
    // custodial key, because that is what makes it Oxy provenance.
    expect(result.node.nodePublicKey).toBe(fleetKey);
    expect((await chainRecords(userId))[0].publicKey).toBe(OXY_PUBLIC_KEY);
    await settleProbe(userId);
  });
});

describe('provisionManagedVault — fails closed', () => {
  /** Nothing at all was written for this account. */
  async function expectNothingProvisioned(userId: string): Promise<void> {
    expect(await chainRecords(userId)).toHaveLength(0);
    expect(await storedNode(userId)).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  }

  it('refuses without the Oxy custodial private key', async () => {
    delete process.env.OXY_PRIVATE_KEY;
    const userId = await account();

    expect(await provisionManagedVault(userId)).toEqual({ ok: false, reason: 'oxy_key_unconfigured' });

    await expectNothingProvisioned(userId);
  });

  it('refuses without the Oxy custodial public key', async () => {
    delete process.env.OXY_PUBLIC_KEY;
    const userId = await account();

    expect(await provisionManagedVault(userId)).toEqual({ ok: false, reason: 'oxy_key_unconfigured' });

    await expectNothingProvisioned(userId);
  });

  it('refuses when the managed-node fleet base URL is unset', async () => {
    delete process.env.MANAGED_NODE_BASE_URL;
    const userId = await account();

    expect(await provisionManagedVault(userId)).toEqual({
      ok: false,
      reason: 'managed_endpoint_unconfigured',
    });

    await expectNothingProvisioned(userId);
  });

  it('refuses a non-HTTPS fleet base URL', async () => {
    process.env.MANAGED_NODE_BASE_URL = 'http://nodes.oxy.so';
    const userId = await account();

    expect(await provisionManagedVault(userId)).toEqual({
      ok: false,
      reason: 'managed_endpoint_unconfigured',
    });

    await expectNothingProvisioned(userId);
  });

  it('refuses for an id that names no account', async () => {
    const ghost = randomUUID();

    expect(await provisionManagedVault(ghost)).toEqual({ ok: false, reason: 'user_not_found' });

    await expectNothingProvisioned(ghost);
  });

  it('refuses a malformed id without throwing', async () => {
    // No id-shape precheck survives the port: a malformed id matches no row.
    expect(await provisionManagedVault('not-an-object-id')).toEqual({
      ok: false,
      reason: 'user_not_found',
    });
  });

  it('refuses when the custodial signature does not verify, and writes nothing', async () => {
    // The published custodial key and the signing key disagree, so the chain
    // rejects the record — the check that makes a custodial record provenance
    // rather than an assertion.
    process.env.OXY_PUBLIC_KEY = generateSecp256k1KeyPair().publicKey;
    const userId = await account();

    expect(await provisionManagedVault(userId)).toEqual({ ok: false, reason: 'provision_failed' });

    await expectNothingProvisioned(userId);
  });
});

describe('provisionManagedVault — idempotent re-provision', () => {
  it('refreshes an existing active vault WITHOUT appending a second chain record', async () => {
    const userId = await account();
    const first = await provisionManagedVault(userId);
    if (!first.ok) throw new Error(`expected provisioning to succeed, got ${first.reason}`);
    await settleProbe(userId);
    jest.clearAllMocks();

    const second = await provisionManagedVault(userId);

    if (!second.ok) throw new Error(`expected re-provisioning to succeed, got ${second.reason}`);
    expect(second.node.id).toBe(first.node.id);
    // The ledger did not grow — a double-tapped "create my vault" is harmless.
    expect(await chainRecords(userId)).toHaveLength(1);
    // …but the cache is still refreshed and the node re-probed.
    expect(invalidateSpy).toHaveBeenCalledWith(userId);
    // NOT `settleProbe`: `last_probe_at` is already set from the FIRST
    // provision, so it returns immediately and says nothing about whether the
    // SECOND probe has run. The probe is fire-and-forget and does a database
    // round trip before it reaches `safeFetch`, so under any load that lands
    // after this line. Wait for the signal actually being asserted.
    await settleSecondProbe();
    expect(mockSafeFetch).toHaveBeenCalled();
  });

  it('re-provisions when the existing node is SELF-hosted, not managed', async () => {
    const userId = await account();
    await getDb().insert(userNodes).values({
      userId,
      endpoint: `https://nodes.oxy.so/u/${userId}`,
      nodePublicKey: 'ab'.repeat(33),
      mode: 'pull',
      managed: false,
      controller: 'self',
      status: 'active',
    });

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    expect(await chainRecords(userId)).toHaveLength(1);
    expect(await storedNode(userId)).toMatchObject({ managed: true, controller: 'oxy' });
    await settleProbe(userId);
  });

  it('re-provisions when the managed vault has moved to a different endpoint', async () => {
    const userId = await account();
    await provisionManagedVault(userId);
    await settleProbe(userId);
    process.env.MANAGED_NODE_BASE_URL = 'https://vault2.example.org';

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    expect(result.node.endpoint).toBe(`https://vault2.example.org/u/${userId}`);
    // A second chain record, because the registration genuinely changed.
    expect(await chainRecords(userId)).toHaveLength(2);
    await settleProbe(userId);
  });

  it('re-provisions a REVOKED managed vault', async () => {
    const userId = await account();
    await provisionManagedVault(userId);
    await settleProbe(userId);
    await removeNode(userId);

    const result = await provisionManagedVault(userId);

    if (!result.ok) throw new Error(`expected provisioning to succeed, got ${result.reason}`);
    expect(result.node.status).toBe('active');
    expect(await chainRecords(userId)).toHaveLength(2);
    await settleProbe(userId);
  });
});

describe('removeNode — the managed teardown signal', () => {
  it('revokes a managed vault exactly as it revokes a self-hosted node', async () => {
    const userId = await account();
    await provisionManagedVault(userId);
    await settleProbe(userId);
    jest.clearAllMocks();

    await expect(removeNode(userId)).resolves.toBe(true);

    // Operator-agnostic: the row keeps its managed/oxy operator so a node-fleet
    // reconciler can find it to tear the volume down.
    expect(await getUserNode(userId)).toMatchObject({
      status: 'revoked',
      managed: true,
      controller: 'oxy',
    });
    expect(invalidateSpy).toHaveBeenCalledWith(userId);
    // The chain record survives revocation — history is append-only.
    expect(await chainRecords(userId)).toHaveLength(1);
  });
});
