/**
 * `deviceTransfer.service` (b3 Feature 2 — device-to-device identity transfer)
 * against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **A pairing past its expiry is refused on the READ, in the statement that
 * would otherwise hand over the sealed key material — not merely swept later.**
 *
 * `device_pairing_sessions` is registered in `db/expiry.ts`, and a sweep lags
 * one interval exactly as Mongo's TTL monitor lagged ~60s. During that window
 * the row is still there and still says `pending`, so anything that stopped
 * filtering on the deadline itself would turn a bounded housekeeping lag into a
 * live credential-transfer window (`db/schema/CONVENTIONS.md`, "Expiry", class
 * (A)). Two places carry it and both are asserted below: the lazy
 * `pending → expired` write on read, and the deadline re-tested INSIDE the
 * atomic claim, so the pre-flight read cannot widen the window.
 *
 * The second guarantee, unchanged in substance from the suite this replaces:
 * **a bearer token alone cannot approve a key clone** — approval requires a
 * FRESH signature over `{action, pairingId, timestamp}` made with the account's
 * CURRENT identity key.
 *
 * ## What changed about the way it is tested
 *
 * The previous suite replaced both models with `jest.fn()`s and asserted the
 * MongoDB filter/update documents:
 *
 * ```ts
 * expect(mockPairingFindOneAndUpdate).toHaveBeenCalledWith(
 *   { pairingId, status: 'pending', expiresAt: { $gt: expect.any(Date) } }, …
 * );
 * ```
 *
 * That is an assertion about the SHAPE of a query, which is worth nothing: it
 * passes whether or not the update matches a row, and the "atomic burn" and
 * "lazy expiry" cases proved only that the service had called a mock with a
 * particular object. Here the rows are real, the two concurrent approves race
 * for real, and the assertions read the stored row back.
 *
 * Real `SignatureService` (secp256k1) is used throughout, so signature
 * acceptance and rejection are genuine. NOTHING is mocked.
 *
 * ## What this suite does NOT cover, measured rather than assumed
 *
 * The atomic claim carries two predicates, `status = 'pending'` and
 * `expires_at > now()`, and a single-process suite cannot observe EITHER
 * independently — every case reaches the pre-flight read first, and the
 * pre-flight refuses the same rows for the same reasons. Both were mutation-
 * tested to establish that rather than hoped:
 *
 *  - deleting `expires_at > now()` from the claim leaves all 26 cases GREEN;
 *  - deleting `status = 'pending'` from the claim leaves them green too when
 *    each is run alone, and turns a deny/approve `Promise.all` red only
 *    SOMETIMES — a flake, so no such case is kept here.
 *
 * The reason is structural: every approve does ~110 ms of SYNCHRONOUS secp256k1
 * verification before it touches the database, which blocks Node's event loop,
 * so two approves issued from one process cannot interleave between their
 * pre-flight and their claim. Those predicates are the CROSS-PROCESS guard —
 * two API containers approving the same pairing — and this suite is honest
 * about not being able to reach them. What it does hold is the outcome every
 * caller sees: a second approve is refused and the first one's sealed material
 * survives.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { devicePairingSessions } from '../../db/schema/devicePairingSessions';
import { users } from '../../db/schema/users';
import {
  initDeviceTransfer,
  getDeviceTransferInfo,
  approveDeviceTransfer,
  denyDeviceTransfer,
  buildApprovalSigningMessage,
  DEVICE_TRANSFER_TTL_MS,
} from '../deviceTransfer.service';
import { SignatureService } from '../signature.service';

/** A stable identity keypair for the caller — the CURRENT key it must sign with. */
const identityKey = generateSecp256k1KeyPair();
const identityPriv = identityKey.privateKey;
const identityPub = identityKey.publicKey;
/** A valid single-use ephemeral public key the old device supplies. */
const oldEphPub = generateSecp256k1KeyPair().publicKey;
/** A valid ephemeral public key the NEW device supplies at init. */
const newEphPub = generateSecp256k1KeyPair().publicKey;

const CIPHERTEXT = 'ff'.repeat(20);
const NONCE = '00'.repeat(24);

const createdAccounts: string[] = [];
const createdPairings: string[] = [];

/** The account that approves, holding a real identity public key. */
let USER_ID: string;
/** An account with no identity key at all. */
let KEYLESS_USER_ID: string;

async function insertAccount(publicKey?: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `dt-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      publicKey: publicKey ?? null,
      color: 'teal',
    })
    .returning({ id: users.id });
  createdAccounts.push(row.id);
  return row.id;
}

/** A pairing row written directly, so a case can choose its status and deadline. */
async function seedPairing(over: {
  status?: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt?: Date;
  label?: string | null;
} = {}): Promise<string> {
  const pairingId = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(devicePairingSessions)
    .values({
      pairingId,
      newDeviceEphemeralPublicKey: newEphPub,
      newDeviceLabel: over.label === undefined ? 'New iPhone' : over.label,
      status: over.status ?? 'pending',
      expiresAt: over.expiresAt ?? new Date(Date.now() + DEVICE_TRANSFER_TTL_MS),
    });
  createdPairings.push(pairingId);
  return pairingId;
}

/** The stored row, exactly as it is. */
async function storedPairing(pairingId: string) {
  const [row] = await getDb()
    .select()
    .from(devicePairingSessions)
    .where(eq(devicePairingSessions.pairingId, pairingId));
  return row;
}

function signApproval(pairingId: string, privateKey: string, timestamp: number): string {
  return SignatureService.signMessage(
    buildApprovalSigningMessage(pairingId, timestamp),
    privateKey
  );
}

function approvalInput(pairingId: string, over: Record<string, unknown> = {}) {
  const timestamp = Date.now();
  return {
    pairingId,
    authenticatedUserId: USER_ID,
    oldEphPub,
    ciphertext: CIPHERTEXT,
    nonce: NONCE,
    signature: signApproval(pairingId, identityPriv, timestamp),
    timestamp,
    ...over,
  };
}

beforeAll(async () => {
  await connectPostgres();
  USER_ID = await insertAccount(identityPub);
  KEYLESS_USER_ID = await insertAccount();
});

afterAll(async () => {
  const db = getDb();
  if (createdPairings.length > 0) {
    await db
      .delete(devicePairingSessions)
      .where(inArray(devicePairingSessions.pairingId, createdPairings));
  }
  if (createdAccounts.length > 0) {
    await db.delete(users).where(inArray(users.id, createdAccounts));
  }
  await closePostgres();
});

describe('initDeviceTransfer', () => {
  it('stores a pending pairing with a 128-bit id and a three-minute deadline', async () => {
    const before = Date.now();

    const outcome = await initDeviceTransfer({ newEphPub, newDeviceLabel: 'iPad' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    createdPairings.push(outcome.pairingId);

    expect(outcome.pairingId).toMatch(/^[0-9a-f]{32}$/);
    const ttl = outcome.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(DEVICE_TRANSFER_TTL_MS - 30_000);
    expect(ttl).toBeLessThanOrEqual(DEVICE_TRANSFER_TTL_MS + 1_000);

    // The ROW, not the call: the previous suite could only assert that
    // `create` had been handed an object with these keys.
    const stored = await storedPairing(outcome.pairingId);
    expect(stored.newDeviceEphemeralPublicKey).toBe(newEphPub);
    expect(stored.newDeviceLabel).toBe('iPad');
    expect(stored.status).toBe('pending');
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect(stored.expiresAt.getTime()).toBe(outcome.expiresAt.getTime());
    // Nothing sealed until an approval seals it — the CHECK constraint on the
    // table makes a half-written payload unrepresentable, and this is the "all
    // three absent" side of it.
    expect(stored.oldDeviceEphemeralPublicKey).toBeNull();
    expect(stored.ciphertext).toBeNull();
    expect(stored.nonce).toBeNull();
    expect(stored.approvedByUserId).toBeNull();
  });

  it('stores a null label when none is supplied', async () => {
    const outcome = await initDeviceTransfer({ newEphPub });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    createdPairings.push(outcome.pairingId);

    expect((await storedPairing(outcome.pairingId)).newDeviceLabel).toBeNull();
  });

  it('rejects an invalid ephemeral public key WITHOUT writing', async () => {
    const before = await getDb().select({ id: devicePairingSessions.id }).from(devicePairingSessions);

    const outcome = await initDeviceTransfer({ newEphPub: 'not-a-key' });

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Invalid ephemeral public key' });
    const after = await getDb().select({ id: devicePairingSessions.id }).from(devicePairingSessions);
    expect(after).toHaveLength(before.length);
  });
});

describe('getDeviceTransferInfo', () => {
  it('returns null for an unknown pairing', async () => {
    expect(await getDeviceTransferInfo(randomUUID().replace(/-/g, ''))).toBeNull();
  });

  it('returns the pairing without any sealed material while pending', async () => {
    const pairingId = await seedPairing();

    const info = await getDeviceTransferInfo(pairingId);

    expect(info).toEqual({
      pairingId,
      newDeviceEphemeralPublicKey: newEphPub,
      newDeviceLabel: 'New iPhone',
      status: 'pending',
      expiresAt: (await storedPairing(pairingId)).expiresAt.toISOString(),
      oldDeviceEphemeralPublicKey: null,
      ciphertext: null,
      nonce: null,
    });
  });

  it('marks a past-deadline pending pairing expired ON READ and PERSISTS it', async () => {
    // THE lazy-expiry guarantee. The sweep lags, so this read is what produces
    // the verdict — and the stored row must carry it, or the next read would
    // hand out `pending` again.
    const pairingId = await seedPairing({ expiresAt: new Date(Date.now() - 1_000) });

    const info = await getDeviceTransferInfo(pairingId);

    expect(info?.status).toBe('expired');
    expect((await storedPairing(pairingId)).status).toBe('expired');
    // Never leak material for a non-approved pairing.
    expect(info?.ciphertext).toBeNull();
    expect(info?.oldDeviceEphemeralPublicKey).toBeNull();
  });

  it('reports "expired" rather than "not found", which is why the row outlives its deadline', async () => {
    // The reason the sweep keeps a grace window at all: a client whose transfer
    // timed out must be told THAT, not that their pairing never existed.
    const pairingId = await seedPairing({ expiresAt: new Date(Date.now() - 1_000) });

    const info = await getDeviceTransferInfo(pairingId);

    expect(info).not.toBeNull();
    expect(info?.status).toBe('expired');
  });

  it('does not re-expire a pairing that is already denied', async () => {
    const pairingId = await seedPairing({
      status: 'denied',
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect((await getDeviceTransferInfo(pairingId))?.status).toBe('denied');
    expect((await storedPairing(pairingId)).status).toBe('denied');
  });

  it('surfaces the sealed material ONLY once approved', async () => {
    const pairingId = await seedPairing();
    expect((await approveDeviceTransfer(approvalInput(pairingId))).ok).toBe(true);

    const info = await getDeviceTransferInfo(pairingId);

    expect(info?.status).toBe('approved');
    expect(info?.ciphertext).toBe(CIPHERTEXT);
    expect(info?.nonce).toBe(NONCE);
    expect(info?.oldDeviceEphemeralPublicKey).toBe(oldEphPub);
  });
});

describe('approveDeviceTransfer — the dual proof', () => {
  it('seals the material and records who released it', async () => {
    const pairingId = await seedPairing();

    const outcome = await approveDeviceTransfer(approvalInput(pairingId));

    expect(outcome).toEqual({ ok: true, pairingId });
    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('approved');
    expect(stored.oldDeviceEphemeralPublicKey).toBe(oldEphPub);
    expect(stored.ciphertext).toBe(CIPHERTEXT);
    expect(stored.nonce).toBe(NONCE);
    expect(stored.approvedByUserId).toBe(USER_ID);
  });

  it('rejects a signature made with a DIFFERENT key (401) and stores nothing', async () => {
    // The whole point of the dual proof: a stolen bearer token proves account
    // control but NOT key possession, so it must not be able to clone the key.
    const pairingId = await seedPairing();
    const attackerPriv = generateSecp256k1KeyPair().privateKey;
    const timestamp = Date.now();

    const outcome = await approveDeviceTransfer(
      approvalInput(pairingId, {
        signature: signApproval(pairingId, attackerPriv, timestamp),
        timestamp,
      })
    );

    expect(outcome).toEqual({ ok: false, status: 401, message: 'Invalid approval signature' });
    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('pending');
    expect(stored.ciphertext).toBeNull();
  });

  it('rejects a signature over a DIFFERENT pairing id (401)', async () => {
    // The pairing id is inside the signed bytes, so a signature harvested from
    // one transfer cannot be replayed onto another.
    const pairingId = await seedPairing();
    const otherPairingId = await seedPairing();
    const timestamp = Date.now();

    const outcome = await approveDeviceTransfer(
      approvalInput(pairingId, {
        signature: signApproval(otherPairingId, identityPriv, timestamp),
        timestamp,
      })
    );

    expect(outcome).toEqual({ ok: false, status: 401, message: 'Invalid approval signature' });
  });

  it('rejects a stale signature (400) before any DB work', async () => {
    const pairingId = await seedPairing();
    const staleTs = Date.now() - 6 * 60 * 1000;

    const outcome = await approveDeviceTransfer(
      approvalInput(pairingId, {
        signature: signApproval(pairingId, identityPriv, staleTs),
        timestamp: staleTs,
      })
    );

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Approval signature has expired' });
    expect((await storedPairing(pairingId)).status).toBe('pending');
  });

  it('rejects when the account has no identity key (400)', async () => {
    const pairingId = await seedPairing();

    const outcome = await approveDeviceTransfer(
      approvalInput(pairingId, { authenticatedUserId: KEYLESS_USER_ID })
    );

    expect(outcome).toEqual({
      ok: false,
      status: 400,
      message: 'Account has no identity key to transfer',
    });
  });

  it('returns 404 for a user id that matches no row', async () => {
    // No id-shape precheck any more: a malformed id is a value that matches no
    // row, which is the same "no such user" outcome the deleted guard produced.
    const pairingId = await seedPairing();

    expect(
      await approveDeviceTransfer(
        approvalInput(pairingId, { authenticatedUserId: 'not-an-object-id' })
      )
    ).toEqual({ ok: false, status: 404, message: 'User not found' });
  });

  it('rejects an invalid ephemeral public key (400)', async () => {
    const pairingId = await seedPairing();

    expect(await approveDeviceTransfer(approvalInput(pairingId, { oldEphPub: 'nope' }))).toEqual({
      ok: false,
      status: 400,
      message: 'Invalid ephemeral public key',
    });
  });
});

describe('approveDeviceTransfer — expiry and single use', () => {
  it('refuses a past-deadline pairing and persists the expiry', async () => {
    const pairingId = await seedPairing({ expiresAt: new Date(Date.now() - 1_000) });

    const outcome = await approveDeviceTransfer(approvalInput(pairingId));

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Pairing has expired' });
    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('expired');
    expect(stored.ciphertext).toBeNull();
  });

  it('refuses a pairing whose deadline passes while it is still pending', async () => {
    // A deadline reached AFTER the row was written, rather than one already in
    // the past at seed time: the sweep has certainly not run in the 80 ms since,
    // so this is the "still present, still says pending, past its deadline"
    // state the sweep's lag produces — and the answer is a refusal.
    //
    // It does NOT isolate the claim's own `expires_at > now()`: the pre-flight
    // reaches the same verdict first, which the header records as measured.
    const pairingId = await seedPairing({ expiresAt: new Date(Date.now() + 40) });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const outcome = await approveDeviceTransfer(approvalInput(pairingId));

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Pairing has expired' });
    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('expired');
    expect(stored.ciphertext).toBeNull();
  });

  it('rejects an already-approved pairing (409) without overwriting it', async () => {
    const pairingId = await seedPairing();
    await approveDeviceTransfer(approvalInput(pairingId));

    const second = await approveDeviceTransfer(
      approvalInput(pairingId, { ciphertext: 'ee'.repeat(20) })
    );

    expect(second).toEqual({ ok: false, status: 409, message: 'Pairing already processed' });
    expect((await storedPairing(pairingId)).ciphertext).toBe(CIPHERTEXT);
  });

  it('lets exactly ONE of two simultaneously-issued approves win', async () => {
    // Simultaneous from the CALLER's point of view — the header explains why a
    // single process cannot make them interleave inside the service, and why
    // this therefore pins the outcome rather than the mechanism. Both approvals
    // carry a DIFFERENT ciphertext so the stored row names the winner.
    const pairingId = await seedPairing();
    const first = approvalInput(pairingId);
    const second = approvalInput(pairingId, { ciphertext: 'ee'.repeat(20) });

    const [a, b] = await Promise.all([
      approveDeviceTransfer(first),
      approveDeviceTransfer(second),
    ]);

    const winners = [a, b].filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((outcome) => !outcome.ok);
    expect(loser).toMatchObject({ status: 409 });

    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('approved');
    expect([CIPHERTEXT, 'ee'.repeat(20)]).toContain(stored.ciphertext);
  });

  it('returns 404 for an unknown pairing (after a valid signature)', async () => {
    const unknown = randomUUID().replace(/-/g, '');

    expect(await approveDeviceTransfer(approvalInput(unknown))).toEqual({
      ok: false,
      status: 404,
      message: 'Pairing not found',
    });
  });
});

describe('denyDeviceTransfer', () => {
  it('cancels a pending pairing', async () => {
    const pairingId = await seedPairing();

    expect(await denyDeviceTransfer(pairingId)).toEqual({ ok: true, status: 'denied' });
    expect((await storedPairing(pairingId)).status).toBe('denied');
  });

  it('is idempotent for an already-denied pairing', async () => {
    const pairingId = await seedPairing({ status: 'denied' });

    expect(await denyDeviceTransfer(pairingId)).toEqual({ ok: true, status: 'denied' });
    expect((await storedPairing(pairingId)).status).toBe('denied');
  });

  it('refuses to undo an already-approved pairing (409)', async () => {
    const pairingId = await seedPairing();
    await approveDeviceTransfer(approvalInput(pairingId));

    expect(await denyDeviceTransfer(pairingId)).toEqual({
      ok: false,
      status: 409,
      message: 'Cannot deny a approved transfer',
    });
    expect((await storedPairing(pairingId)).status).toBe('approved');
  });

  it('returns 404 for an unknown pairing', async () => {
    expect(await denyDeviceTransfer(randomUUID().replace(/-/g, ''))).toEqual({
      ok: false,
      status: 404,
      message: 'Pairing not found',
    });
  });

  it('refuses to approve a pairing that was denied first, and seals nothing', async () => {
    // The ordered form of the deny/approve conflict. The `Promise.all` form was
    // deliberately NOT kept: which of the two lands first is timing-dependent,
    // so it passes and fails at random — a check that cannot tell success from
    // failure is worse than no check.
    const pairingId = await seedPairing();
    expect(await denyDeviceTransfer(pairingId)).toEqual({ ok: true, status: 'denied' });

    const outcome = await approveDeviceTransfer(approvalInput(pairingId));

    expect(outcome).toEqual({ ok: false, status: 409, message: 'Pairing already processed' });
    const stored = await storedPairing(pairingId);
    expect(stored.status).toBe('denied');
    // The sealed payload is written only on the approve path, and the table's
    // CHECK makes a half-written one impossible — so a denied row carries none
    // of it.
    expect(stored.oldDeviceEphemeralPublicKey).toBeNull();
    expect(stored.ciphertext).toBeNull();
    expect(stored.nonce).toBeNull();
  });
});
