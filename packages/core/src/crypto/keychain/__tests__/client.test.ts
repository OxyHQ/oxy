/**
 * `KeychainClient` end to end (ADR 0063): devices against an in-memory Oxy
 * that applies the server's checks (`fakeKeychainServer.ts`), through
 * `oxy.keychain` as on the wire. Every flow of the ADR, and a malicious Oxy:
 * substituted keys, a rolled-back or forked roster, a replayed item, a forged
 * wrap. A refusal writes nothing.
 */
import { KEYCHAIN_ERROR_CODES, KEYCHAIN_RECOVERY } from '@oxy.so/contracts/client';
import type {
  KeychainClient,
  KeychainDeviceRecord,
  KeychainDeviceStore,
  KeychainItemDraft,
  KeychainMemberRecord,
} from '../client';
import { fromBase64Url, toBase64Url } from '../encoding';
import { OxyApiError } from '../../../OxyServices.errors';
import {
  KeychainConflictError,
  KeychainCryptoError,
  KeychainIntegrityError,
  type KeychainStateError,
} from '../errors';
import { decryptItem, type LoginItem } from '../items';
import { generateDeviceKeys } from '../keys';
import { generationBody, rosterHeadOf, signRosterBody } from '../roster';
import { createKeyring, createWrap } from '../wrap';
import { type FakeDevice, FakeKeychainServer } from './fakeKeychainServer';

interface TestStore extends KeychainDeviceStore {
  record: KeychainDeviceRecord | null;
  saves: number;
}

function memoryStore(): TestStore {
  const store: TestStore = {
    record: null,
    saves: 0,
    async load() {
      return store.record
        ? (JSON.parse(JSON.stringify(store.record)) as KeychainDeviceRecord)
        : null;
    },
    async save(record) {
      store.saves += 1;
      store.record = JSON.parse(JSON.stringify(record)) as KeychainDeviceRecord;
    },
    async clear() {
      store.record = null;
    },
  };
  return store;
}

interface TestDevice {
  client: KeychainClient;
  store: TestStore;
  device: FakeDevice;
}

async function device(server: FakeKeychainServer, name: string): Promise<TestDevice> {
  const { oxy, device } = server.device(name);
  const store = memoryStore();
  const client = await oxy.keychain.openClient({ store });
  return { client, store, device };
}

function memberRecord(d: TestDevice): KeychainMemberRecord {
  expect(d.store.record?.kind).toBe('member');
  return d.store.record as KeychainMemberRecord;
}

async function refusal<T extends Error>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (error) {
    return error as T;
  }
  throw new Error('expected a refusal');
}

function login(password: string, extra: Partial<LoginItem> = {}): KeychainItemDraft {
  return {
    type: 'login',
    title: 'Example',
    username: 'nate@example.com',
    password,
    urls: [{ url: 'https://example.com' }],
    apps: [],
    totp: null,
    notes: '',
    passwordHistory: [],
    ...extra,
  } as KeychainItemDraft;
}

/** A vault made on `a`, the recovery key's text returned. */
async function createVault(a: TestDevice): Promise<string> {
  const { recoveryKey } = await a.client.createVault({ deviceName: 'Laptop', platform: 'oxyos' });
  await a.client.confirmRecoveryKey(recoveryKey);
  return recoveryKey;
}

/** `b` joins through `a`'s approval with compared codes. */
async function join(a: TestDevice, b: TestDevice, name = 'Phone'): Promise<void> {
  const { enrollmentId } = await b.client.requestToJoin({ deviceName: name, platform: 'android' });
  await a.client.openJoinRequest(enrollmentId);
  const shown = await b.client.revealWhenOpened();
  const code = await a.client.joinRequestCode(enrollmentId);
  expect(shown).toEqual({ state: 'compare', code });
  await a.client.approveJoinRequest(enrollmentId, { codeConfirmed: true });
  expect(await b.client.completeJoin()).toEqual({ state: 'joined' });
}

describe('KeychainClient', () => {
  it('creates a vault only after the recovery key is typed back', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    expect(await a.client.status()).toEqual({ state: 'no_vault' });

    const { recoveryKey } = await a.client.createVault({ deviceName: 'Laptop', platform: 'oxyos' });
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(server.vault).toBeNull();

    const wrong = await refusal<KeychainStateError>(
      a.client.confirmRecoveryKey('0000-0000-0000-0000-0000-0000-0000-0000'),
    );
    expect(wrong.reason).toBe('recovery_key_mismatch');
    expect(server.vault).toBeNull();
    expect(a.store.saves).toBe(0);

    // Typed loosely: lower case, no hyphens.
    const status = await a.client.confirmRecoveryKey(recoveryKey.replace(/-/g, '').toLowerCase());
    expect(status).toMatchObject({ state: 'member', generation: 1 });
    expect(server.vault).not.toBeNull();
    // The recovery key is never sent: only its public halves are in the genesis.
    expect(JSON.stringify(server.vault?.roster)).not.toContain(recoveryKey);
    const nothing = await refusal<KeychainStateError>(a.client.confirmRecoveryKey(recoveryKey));
    expect(nothing.reason).toBe('nothing_pending');
  });

  it('adds a device after both screens show the same code, and syncs items', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    expect(await b.client.status()).toMatchObject({ state: 'not_member' });

    const { enrollmentId } = await b.client.requestToJoin({
      deviceName: 'Phone',
      platform: 'android',
    });
    expect(await b.client.status()).toMatchObject({ state: 'joining', enrollmentId });
    expect(await b.client.revealWhenOpened()).toEqual({ state: 'waiting' });
    const listed = await a.client.listJoinRequests();
    expect(listed).toEqual([
      expect.objectContaining({
        id: enrollmentId,
        opened: false,
        member: expect.objectContaining({ name: 'Phone' }),
      }),
    ]);

    await a.client.openJoinRequest(enrollmentId);
    expect(await a.client.joinRequestCode(enrollmentId)).toBeNull();
    const shown = await b.client.revealWhenOpened();
    expect(shown.state).toBe('compare');
    const code = await a.client.joinRequestCode(enrollmentId);
    expect(code).toMatch(/^\d{6}$/);
    expect(shown).toEqual({ state: 'compare', code });
    // Read again after the reveal: the same code, no second reveal.
    expect(await b.client.revealWhenOpened()).toEqual({ state: 'compare', code });

    const unconfirmed = await refusal<KeychainStateError>(
      a.client.approveJoinRequest(enrollmentId, { codeConfirmed: false as true }),
    );
    expect(unconfirmed.reason).toBe('code_not_confirmed');
    expect(await b.client.completeJoin()).toEqual({ state: 'waiting' });

    await a.client.approveJoinRequest(enrollmentId, { codeConfirmed: true });
    expect(await b.client.completeJoin()).toEqual({ state: 'joined' });
    const status = await b.client.status();
    expect(status).toMatchObject({ state: 'member', generation: 1 });
    expect(status.state === 'member' && status.members.map((m) => m.name)).toEqual([
      'Laptop',
      'Phone',
    ]);

    const { item } = await a.client.putItem(login('hunter2'));
    expect(item.counter).toBe(1);
    const synced = await b.client.sync();
    expect(synced.items).toEqual([item]);
    expect(synced.deleted).toEqual([]);
    expect((await b.client.sync()).items).toEqual([]);

    await b.client.deleteItem(item.id);
    expect(await a.client.sync()).toMatchObject({ items: [], deleted: [item.id] });
  });

  it('a server that substitutes the new device keys makes the codes differ', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);

    // Oxy shows the approver its own device (keys and nonce of its making),
    // committed before it sees the approver's nonce, as the protocol forces.
    const attacker = generateDeviceKeys();
    const attackerNonce = new Uint8Array(32).fill(7);
    const { enrollmentCommitment } = await import('../enrollment');
    let substituted: { member: never; commitment: string } | null = null;
    server.views.enrollment = (enrollment, viewer) => {
      if (viewer === b.device) return enrollment;
      if (!substituted) {
        const member = {
          ...enrollment.member,
          signingKey: toBase64Url(attacker.signingPublicKey),
          boxKey: toBase64Url(attacker.boxPublicKey),
        };
        substituted = {
          member: member as never,
          commitment: enrollmentCommitment(enrollment.vaultId, member, attackerNonce),
        };
      }
      return {
        ...enrollment,
        member: substituted.member,
        commitment: substituted.commitment,
        deviceNonce: enrollment.deviceNonce === null ? null : toBase64Url(attackerNonce),
      };
    };

    const { enrollmentId } = await b.client.requestToJoin({ deviceName: 'Phone', platform: 'ios' });
    await a.client.openJoinRequest(enrollmentId);
    const shown = await b.client.revealWhenOpened();
    const code = await a.client.joinRequestCode(enrollmentId);
    expect(shown.state).toBe('compare');
    expect(code).toMatch(/^\d{6}$/);
    expect(shown).not.toEqual({ state: 'compare', code });
  });

  it('refuses a revealed nonce that does not open the pinned commitment', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    const { enrollmentId } = await b.client.requestToJoin({ deviceName: 'Phone', platform: 'ios' });
    await a.client.openJoinRequest(enrollmentId);
    await b.client.revealWhenOpened();
    server.views.enrollment = (enrollment, viewer) =>
      viewer === a.device
        ? { ...enrollment, deviceNonce: toBase64Url(new Uint8Array(32)) }
        : enrollment;
    const error = await refusal<KeychainIntegrityError>(a.client.joinRequestCode(enrollmentId));
    expect(error).toBeInstanceOf(KeychainIntegrityError);
    expect(error.reason).toBe('enrollment');
    const approve = await refusal<KeychainStateError>(
      a.client.approveJoinRequest(enrollmentId, { codeConfirmed: true }),
    );
    expect(approve.reason).toBe('join_request_not_open');
  });

  it('joins with the recovery key, and refuses a wrong one', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const c = await device(server, 'c');
    const recoveryKey = await createVault(a);
    const { item } = await a.client.putItem(login('s3cret'));

    const other = '7777-7777-7777-7777-7777-7777-7777-7777';
    const wrong = await refusal<KeychainStateError>(
      c.client.joinWithRecoveryKey(other, { deviceName: 'New laptop', platform: 'linux' }),
    );
    expect(wrong.reason).toBe('recovery_key_mismatch');
    expect(c.store.saves).toBe(0);

    const status = await c.client.joinWithRecoveryKey(recoveryKey, {
      deviceName: 'New laptop',
      platform: 'linux',
    });
    expect(status).toMatchObject({ state: 'member', generation: 1 });
    const roster = server.vault?.roster ?? [];
    expect(roster[roster.length - 1].signatures.map((s) => s.signer)).toEqual([KEYCHAIN_RECOVERY]);
    expect((await c.client.sync()).items).toEqual([item]);
  });

  it('removing a device rotates the vault key; the removed device reads nothing new', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const c = await device(server, 'c');
    await createVault(a);
    await join(a, b);
    await join(a, c, 'Tablet');
    const before = await a.client.putItem(login('old'));
    await c.client.sync();
    const cRecord = memberRecord(c);

    const self = await refusal<KeychainStateError>(
      a.client.removeMember(memberRecord(a).member.id),
    );
    expect(self.reason).toBe('cannot_remove_self');

    await a.client.removeMember(cRecord.member.id);
    expect(server.vault?.generation).toBe(2);
    expect(server.wraps.has(cRecord.member.id)).toBe(false);
    expect([...server.wraps.values()].every((w) => w.generation === 2)).toBe(true);

    const after = await a.client.putItem(login('new'));
    const stored = server.items.get(after.item.id);
    expect(stored?.generation).toBe(2);

    // b fetches its new wrap and reads both generations.
    const bSync = await b.client.sync();
    expect(bSync.items.map((i) => i.id).sort()).toEqual([before.item.id, after.item.id].sort());
    expect(await b.client.status()).toMatchObject({ state: 'member', generation: 2 });

    // c is out: refused, and its keyring cannot open the new item anyway.
    const removed = await refusal<KeychainStateError>(c.client.sync());
    expect(removed.reason).toBe('removed');
    expect(await c.client.status()).toMatchObject({ state: 'removed' });
    const keys = new Map(
      Object.entries(cRecord.keyring).map(([g, k]) => [Number(g), fromBase64Url(k, 32)]),
    );
    expect(() =>
      decryptItem(
        cRecord.vaultId,
        after.item.id,
        { generation: 2, nonce: stored?.nonce as string, ciphertext: stored?.ciphertext as string },
        { keys, generation: 1 },
      ),
    ).toThrow(KeychainCryptoError);
  });

  it('replacing the recovery key rotates; the old key opens nothing new', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const c = await device(server, 'c');
    const oldKey = await createVault(a);
    const { recoveryKey } = await a.client.replaceRecoveryKey();
    expect(recoveryKey).not.toBe(oldKey);
    expect(server.vault?.generation).toBe(1);
    const status = await a.client.confirmRecoveryKey(recoveryKey);
    expect(status).toMatchObject({ state: 'member', generation: 2 });
    expect(server.wraps.get(KEYCHAIN_RECOVERY)?.generation).toBe(2);

    const stale = await refusal<KeychainStateError>(
      c.client.joinWithRecoveryKey(oldKey, { deviceName: 'x', platform: 'web' }),
    );
    expect(stale.reason).toBe('recovery_key_mismatch');
    expect(
      await c.client.joinWithRecoveryKey(recoveryKey, { deviceName: 'x', platform: 'web' }),
    ).toMatchObject({ state: 'member', generation: 2 });
  });

  it('refuses a rolled-back roster and writes nothing', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const c = await device(server, 'c');
    await createVault(a);
    await join(a, b);
    await join(a, c);
    await b.client.sync();
    await a.client.removeMember(memberRecord(c).member.id);
    await b.client.sync();

    const saves = b.store.saves;
    const record = JSON.stringify(b.store.record);
    server.views.roster = (roster) => roster.slice(0, -2);
    const error = await refusal<KeychainIntegrityError>(b.client.sync());
    expect(error).toBeInstanceOf(KeychainIntegrityError);
    expect(error.reason).toBe('rollback');
    const write = await refusal<KeychainIntegrityError>(b.client.putItem(login('x')));
    expect(write.reason).toBe('rollback');
    expect(b.store.saves).toBe(saves);
    expect(JSON.stringify(b.store.record)).toBe(record);
    expect(server.items.size).toBe(0);
  });

  it('refuses a forked roster', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    await join(a, b);
    await b.client.sync();

    // Another history from the same genesis: at seq 1, a generation instead
    // of b's add, validly signed by a member (Oxy keeps every signed entry).
    const aRecord = memberRecord(a);
    const real = server.vault?.roster ?? [];
    const forked = signRosterBody(
      generationBody({
        vaultId: aRecord.vaultId,
        head: rosterHeadOf(real[0]),
        generation: 2,
      }),
      [
        {
          signer: aRecord.member.id,
          signingSecretKey: fromBase64Url(aRecord.signingSecretKey, 32),
        },
      ],
    );
    server.views.roster = (roster) => [roster[0], forked];
    const saves = b.store.saves;
    const error = await refusal<KeychainIntegrityError>(b.client.sync());
    expect(error.reason).toBe('fork');
    expect(b.store.saves).toBe(saves);
  });

  it('refuses an item rolled back to an older counter', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    await join(a, b);
    const first = await a.client.putItem(login('one'));
    const old = {
      ...(server.items.get(first.item.id) as NonNullable<ReturnType<typeof server.items.get>>),
    };
    const second = await a.client.putItem({ ...login('two'), id: first.item.id });
    expect(second.item.counter).toBe(2);
    expect((await b.client.sync()).items[0]).toMatchObject({ counter: 2, password: 'two' });

    // Oxy serves the first ciphertext again as a newer revision.
    server.vault = {
      ...(server.vault as NonNullable<typeof server.vault>),
      revision: (server.vault?.revision ?? 0) + 1,
    };
    server.items.set(first.item.id, { ...old, revision: server.vault.revision });
    const saves = b.store.saves;
    const error = await refusal<KeychainIntegrityError>(b.client.sync());
    expect(error.reason).toBe('counter');
    expect(b.store.saves).toBe(saves);
  });

  it('refuses a wrap Oxy made, and an item list from the past', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const c = await device(server, 'c');
    await createVault(a);
    await join(a, b);
    await join(a, c);
    await b.client.sync();
    await a.client.removeMember(memberRecord(c).member.id);

    const bRecord = memberRecord(b);
    const forger = generateDeviceKeys();
    server.views.ownWrap = (wrap) => {
      const keyring = createKeyring();
      keyring.keys.set(2, new Uint8Array(32).fill(9));
      keyring.generation = 2;
      return createWrap({
        vaultId: bRecord.vaultId,
        recipient: wrap.recipient,
        recipientBoxKey: bRecord.member.boxKey,
        keyring,
        signer: wrap.signer,
        signingSecretKey: forger.signingSecretKey,
      });
    };
    const saves = b.store.saves;
    const error = await refusal<KeychainIntegrityError>(b.client.sync());
    expect(error.reason).toBe('wrap');
    expect(b.store.saves).toBe(saves);
    server.views.ownWrap = undefined;
    await b.client.sync();

    await a.client.putItem(login('p'));
    await b.client.sync();
    server.vault = { ...(server.vault as NonNullable<typeof server.vault>), revision: 0 };
    const past = await refusal<KeychainIntegrityError>(b.client.sync());
    expect(past.reason).toBe('rollback');
  });

  it('merges a conflicting write: the last writer wins and nothing is dropped', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    await join(a, b);
    const { item } = await a.client.putItem(login('one'));
    await b.client.sync();

    const atA = await a.client.putItem({ ...login('two'), id: item.id, createdAt: item.createdAt });
    expect(atA.item.counter).toBe(2);
    // b has not seen "two": its write is based on a stale revision.
    const atB = await b.client.putItem({
      ...login('three'),
      id: item.id,
      createdAt: item.createdAt,
    });
    expect(atB.superseded).toMatchObject({ password: 'two', counter: 2 });
    expect(atB.item).toMatchObject({ password: 'three', counter: 3 });
    expect((atB.item as LoginItem).passwordHistory.map((h) => h.password)).toEqual(['two']);

    const atASync = await a.client.sync();
    expect(atASync.items).toEqual([atB.item]);

    // A deletion that meets a newer write deletes it, and returns what it replaced.
    const atA2 = await a.client.putItem({
      ...login('four'),
      id: item.id,
      createdAt: item.createdAt,
    });
    const deleted = await b.client.deleteItem(item.id);
    expect(deleted.superseded).toMatchObject({ password: 'four' });
    expect(server.items.get(item.id)?.deletedAt).not.toBeNull();
    expect(atA2.item.counter).toBe(4);
  });

  it('gives up with a typed conflict when the item keeps changing, keeping nothing half-done', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    await createVault(a);
    const { item } = await a.client.putItem(login('one'));
    const handle = server.handle.bind(server);
    let puts = 0;
    server.handle = async (dev, method, url, data) => {
      if (method === 'PUT') {
        puts += 1;
        throw new OxyApiError('conflict', { status: 409, code: KEYCHAIN_ERROR_CODES.itemConflict });
      }
      return handle(dev, method, url, data);
    };
    const error = await refusal(a.client.putItem({ ...login('two'), id: item.id }));
    expect(error).toBeInstanceOf(KeychainConflictError);
    expect(puts).toBe(4);
    expect((await a.client.sync()).items).toEqual([]);
  });

  it('a device the account left is orphaned and swept out with a rotation', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    await join(a, b);
    const bId = memberRecord(b).member.id;

    server.leave(b.device);
    const status = await a.client.status();
    expect(status).toMatchObject({ state: 'member', orphanedMemberIds: [bId] });
    expect(await b.client.status()).toMatchObject({ state: 'orphaned' });
    const orphaned = await refusal<KeychainStateError>(b.client.sync());
    expect(orphaned.reason).toBe('orphaned');

    expect(await a.client.sweepOrphans()).toEqual([bId]);
    expect(await a.client.status()).toMatchObject({
      state: 'member',
      generation: 2,
      orphanedMemberIds: [],
    });
    expect(await a.client.sweepOrphans()).toEqual([]);
    expect(server.vault?.generation).toBe(2);
  });

  it('resets the vault only with a re-verification', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    await join(a, b);
    await a.client.putItem(login('gone'));

    const refused = await refusal<{ code: string }>(a.client.reset({}));
    expect(refused.code).toBe('REAUTH_REQUIRED');
    expect(a.store.record).not.toBeNull();

    await a.client.reset({ reauth: { password: 'correct horse' } } as never);
    expect(a.store.record).toBeNull();
    expect(server.vault).toBeNull();
    expect(await a.client.status()).toEqual({ state: 'no_vault' });
    expect(await b.client.status()).toEqual({ state: 'vault_gone' });
    await b.client.forget();
    expect(await b.client.status()).toEqual({ state: 'no_vault' });
    await createVault(b);
    expect(await a.client.status()).toMatchObject({ state: 'not_member' });
  });

  it('completes a vault whose creation answer was lost', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const { recoveryKey } = await a.client.createVault({ deviceName: 'Laptop', platform: 'macos' });
    const handle = server.handle.bind(server);
    let dropped = false;
    server.handle = async (dev, method, url, data) => {
      const answer = await handle(dev, method, url, data);
      if (method === 'POST' && url === '/keychain' && !dropped) {
        dropped = true;
        throw new TypeError('Network request failed');
      }
      return answer;
    };
    await expect(a.client.confirmRecoveryKey(recoveryKey)).rejects.toThrow('Network');
    expect(server.vault).not.toBeNull();
    expect(await a.client.confirmRecoveryKey(recoveryKey)).toMatchObject({ state: 'member' });
  });

  it('a second vault is refused', async () => {
    const server = new FakeKeychainServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    await createVault(a);
    const exists = await refusal<KeychainStateError>(
      b.client.createVault({ deviceName: 'x', platform: 'web' }),
    );
    expect(exists.reason).toBe('vault_exists');
    expect(KEYCHAIN_ERROR_CODES.exists).toBe('KEYCHAIN_EXISTS');
  });
});
