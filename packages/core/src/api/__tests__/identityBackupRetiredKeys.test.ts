/**
 * The encrypted identity backup carries the retired ring (R4-4, ADR 0061 D7
 * as amended): the CURRENT phrase restores the keys earlier coins sit under.
 * Real crypto round-trip; the ring and the native key write are mocked.
 */
import type { BackupUploadRequest, EncryptedBackupEnvelope } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { RecoveryPhraseService } from '../../crypto/recoveryPhrase';
import { IdentityBackupSupersededError } from '../identity';
import { setPlatformOS } from '../../utils/platform';

const mockRing = {
  holds: true,
  unreadable: false,
  held: [] as Array<{ privateKey: string; publicKey: string; retiredAt: number }>,
  kept: [] as Array<{ privateKey: string; publicKey: string }>,
  quarantined: [] as Array<{ privateKey: string; publicKey: string }>,
};

jest.mock('../../crypto/retiredKeys', () => ({
  ...jest.requireActual('../../crypto/retiredKeys'),
  holdsRetiredRing: async () => mockRing.holds,
  exportRetiredIdentityKeys: async () => {
    if (mockRing.unreadable) throw new Error('retired key ring: the index does not parse');
    return mockRing.held;
  },
  retireIdentityKey: async (key: { privateKey: string; publicKey: string }) => {
    mockRing.kept.push(key);
  },
  quarantineRetiredIdentityKey: async (key: { privateKey: string; publicKey: string }) => {
    mockRing.quarantined.push(key);
  },
}));

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RETIRED = 'a7'.repeat(32);
/** BIP-39 test vector: the phrase of a key a rotation replaced. */
const PREVIOUS_PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PLANTED = 'b8'.repeat(32);

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('oxy.identity.backup carries retired keys', () => {
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  /** `GET /identity/key-history`, answered apart from the backup's own calls. */
  let historyMock: jest.Mock<Promise<Response>, []>;
  let oxy: OxyServices;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setPlatformOS('ios');
    mockRing.holds = true;
    mockRing.unreadable = false;
    mockRing.held = [];
    mockRing.kept = [];
    mockRing.quarantined = [];
    fetchMock = jest.fn();
    historyMock = jest.fn(async () => history());
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).endsWith('/identity/key-history')
        ? historyMock()
        : fetchMock(url, init)) as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.session.setAccessToken(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setPlatformOS('web');
    jest.restoreAllMocks();
  });

  async function createAndCapture(): Promise<EncryptedBackupEnvelope> {
    const current = KeyManager.derivePublicKey(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1',
    );
    const retiredPublic = KeyManager.derivePublicKey(RETIRED);
    mockRing.held = [
      { privateKey: RETIRED, publicKey: retiredPublic, retiredAt: 1 },
      // In the ring, but not one of this account's retired keys: left out.
      { privateKey: PLANTED, publicKey: KeyManager.derivePublicKey(PLANTED), retiredAt: 2 },
    ];
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockResolvedValueOnce(json({ exists: true }));
    await oxy.identity.backup.create(PHRASE);
    expect(historyMock).toHaveBeenCalled();
    return lastUpload();
  }

  const CURRENT_PRIVATE = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1';

  /** The account's key history: the current key, and RETIRED as its one retired key. */
  function history(retired: string[] = [RETIRED]): Response {
    return json({
      publicKey: KeyManager.derivePublicKey(CURRENT_PRIVATE),
      retired: retired.map((key) => ({
        publicKey: KeyManager.derivePublicKey(key),
        retiredAt: '2026-11-01T00:00:00.000Z',
      })),
    });
  }

  /** The envelope of the last POST. */
  function lastUpload(): EncryptedBackupEnvelope {
    const post = [...fetchMock.mock.calls].reverse().find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(post?.[1]?.body)) as BackupUploadRequest;
    return {
      version: body.version,
      algorithm: body.algorithm,
      kdfInfo: body.kdfInfo,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      publicKeyHint: body.publicKeyHint,
      createdAt: body.createdAt,
    };
  }

  it('restore keeps the carried keys in the ring, only those the account retired', async () => {
    const envelope = await createAndCapture();
    jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('restored');
    fetchMock.mockResolvedValueOnce(json(envelope));
    await expect(oxy.identity.backup.restore(PHRASE)).resolves.toBe('restored');
    expect(mockRing.kept).toEqual([
      { privateKey: RETIRED, publicKey: KeyManager.derivePublicKey(RETIRED) },
    ]);
  });

  it('restoreRetiredKeys restores the ring alone, and answers 0 without a backup', async () => {
    const envelope = await createAndCapture();
    fetchMock.mockResolvedValueOnce(json(envelope));
    await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(1);
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(0);
  });

  it('does not attach a delayed backup to the next signed-in account', async () => {
    const envelope = await createAndCapture();
    let release = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      await delayed;
      return json(envelope);
    });
    const restoration = oxy.identity.backup.restoreRetiredKeys(PHRASE);
    oxy.session.setAccessToken(makeJwt({ userId: 'someone-else' }));
    release();
    await expect(restoration).rejects.toThrow('signed-in account changed');
    expect(mockRing.kept).toEqual([]);
  });

  it('does not import an identity after its signed-in owner changes', async () => {
    const envelope = await createAndCapture();
    const importKeyPair = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('restored');
    fetchMock.mockResolvedValueOnce(json(envelope));
    const restoration = oxy.identity.backup.restore(PHRASE);
    oxy.session.setAccessToken(makeJwt({ userId: 'someone-else' }));
    await expect(restoration).rejects.toThrow('signed-in account changed');
    expect(importKeyPair).not.toHaveBeenCalled();
    expect(mockRing.kept).toEqual([]);
  });

  it('refuses a signed-out recovery when another account signs in before import', async () => {
    const envelope = await createAndCapture();
    oxy.session.clear();
    const importKeyPair = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('restored');
    fetchMock.mockResolvedValueOnce(json(envelope));
    const restoration = oxy.identity.backup.restore(PHRASE);
    oxy.session.setAccessToken(makeJwt({ userId: 'someone-else' }));
    await expect(restoration).rejects.toThrow('signed-in account changed');
    expect(importKeyPair).not.toHaveBeenCalled();
    expect(mockRing.kept).toEqual([]);
  });

  it('a ring that cannot be checked against the key history fails the backup', async () => {
    mockRing.held = [
      { privateKey: RETIRED, publicKey: KeyManager.derivePublicKey(RETIRED), retiredAt: 1 },
    ];
    historyMock.mockResolvedValue(json({ error: 'down' }, 503));
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toBeDefined();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  const posted = () => fetchMock.mock.calls.some(([, init]) => init?.method === 'POST');

  it('a ring that cannot be read fails the backup instead of sealing it empty (R5-6)', async () => {
    mockRing.unreadable = true;
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toThrow('retired key ring');
    expect(posted()).toBe(false);
  });

  it('an app that holds no ring seals without one, and never reads it', async () => {
    mockRing.holds = false;
    mockRing.unreadable = true;
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockResolvedValueOnce(json({ exists: true }));
    await oxy.identity.backup.create(PHRASE);
    expect(posted()).toBe(true);
  });

  it('a previous backup that cannot be read is never replaced (R5-6)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'down' }, 503));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toBeDefined();
    expect(posted()).toBe(false);
  });

  it('a re-seal keeps every key the previous backup carried, on a phone whose ring lacks them (R5-6)', async () => {
    const previous = await createAndCapture();
    // Another phone (or a wiped ring): nothing held locally.
    mockRing.held = [];
    mockRing.kept = [];
    fetchMock.mockResolvedValueOnce(json(previous)).mockResolvedValueOnce(json({ exists: true }));
    await oxy.identity.backup.create(PHRASE);
    expect(mockRing.kept.map((key) => key.publicKey)).toEqual([
      KeyManager.derivePublicKey(RETIRED),
    ]);
    // The new backup still carries it.
    mockRing.kept = [];
    fetchMock.mockResolvedValueOnce(json(lastUpload()));
    await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(1);
  });

  it('refuses to seal when a key the previous backup carried would be dropped (R5-6)', async () => {
    const previous = await createAndCapture();
    mockRing.held = [];
    const before = fetchMock.mock.calls.length;
    historyMock.mockResolvedValueOnce(history([])); // the history no longer names it
    fetchMock.mockResolvedValueOnce(json(previous)).mockResolvedValueOnce(json({ exists: true }));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toThrow('not replaced');
    expect(fetchMock.mock.calls.slice(before).some(([, init]) => init?.method === 'POST')).toBe(
      false,
    );
  });

  describe('before a rotation (R5-6)', () => {
    it('reads the previous backup with the current phrase: its retired keys and its key', async () => {
      const previous = await createAndCapture();
      fetchMock.mockResolvedValueOnce(json({ exists: true })).mockResolvedValueOnce(json(previous));
      const read = await oxy.identity.backup.readBeforeRotation(async () => PHRASE);
      expect(read.existed).toBe(true);
      expect(read.carried.map((key) => key.publicKey).sort()).toEqual(
        [KeyManager.derivePublicKey(RETIRED), KeyManager.derivePublicKey(CURRENT_PRIVATE)].sort(),
      );
    });

    it('no backup: nothing to carry, and the phrase is never asked for', async () => {
      const phrase = jest.fn(async () => PHRASE);
      fetchMock.mockResolvedValueOnce(json({ exists: false }));
      await expect(oxy.identity.backup.readBeforeRotation(phrase)).resolves.toEqual({
        existed: false,
        carried: [],
      });
      expect(phrase).not.toHaveBeenCalled();
    });

    it('a backup that exists but cannot be read stops the rotation', async () => {
      fetchMock.mockResolvedValueOnce(json({ exists: true }));
      await expect(oxy.identity.backup.readBeforeRotation(async () => null)).rejects.toThrow(
        'Nothing changed',
      );
      fetchMock
        .mockResolvedValueOnce(json({ exists: true }))
        .mockResolvedValueOnce(json({ error: 'forbidden' }, 403));
      await expect(oxy.identity.backup.readBeforeRotation(async () => PHRASE)).rejects.toThrow(
        'Nothing changed',
      );
      fetchMock.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));
      await expect(oxy.identity.backup.readBeforeRotation(async () => PHRASE)).rejects.toThrow(
        'Nothing changed',
      );
    });
  });

  it('a carried key the account’s history does not name is kept QUARANTINED, never bound (R6-10)', async () => {
    const envelope = await createAndCapture();
    historyMock.mockResolvedValue(history([]));
    fetchMock.mockResolvedValueOnce(json(envelope));
    await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(1);
    expect(mockRing.kept).toEqual([]);
    expect(mockRing.quarantined).toEqual([
      { privateKey: RETIRED, publicKey: KeyManager.derivePublicKey(RETIRED) },
    ]);
  });

  it('a history that cannot be read keeps every carried key quarantined (R6-10)', async () => {
    const envelope = await createAndCapture();
    historyMock.mockResolvedValue(json({ error: 'down' }, 503));
    fetchMock.mockResolvedValueOnce(json(envelope));
    await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(1);
    expect(mockRing.kept).toEqual([]);
    expect(mockRing.quarantined).toHaveLength(1);
  });

  it('seals only under the account’s CURRENT key: a stale phrase uploads nothing (R6-9)', async () => {
    historyMock.mockResolvedValue(
      json({ publicKey: KeyManager.derivePublicKey(RETIRED), retired: [] }),
    );
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toThrow('not the current key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the owed flag stays when the upload is not confirmed (R6-9)', async () => {
    jest.spyOn(KeyManager, 'backupOwedEntry').mockResolvedValue({});
    const clear = jest.spyOn(KeyManager, 'clearBackupOwed').mockResolvedValue();
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockRejectedValueOnce(new Error('network request failed'));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toBeDefined();
    expect(clear).not.toHaveBeenCalled();
  });

  describe('a backup a rotation kept as superseded (R6-8)', () => {
    it('is never restored as THE identity', async () => {
      const envelope = await createAndCapture();
      const importKeyPair = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('restored');
      fetchMock.mockResolvedValueOnce(json({ ...envelope, superseded: true }));
      await expect(oxy.identity.backup.restore(PHRASE)).rejects.toThrow('was replaced');
      expect(importKeyPair).not.toHaveBeenCalled();
    });

    it('gives back its own key with the keys it carried, bound when the history names them', async () => {
      const envelope = await createAndCapture();
      historyMock.mockResolvedValue(
        json({
          publicKey: KeyManager.derivePublicKey(PLANTED),
          retired: [RETIRED, CURRENT_PRIVATE].map((key) => ({
            publicKey: KeyManager.derivePublicKey(key),
            retiredAt: '2026-11-01T00:00:00.000Z',
          })),
        }),
      );
      fetchMock.mockResolvedValueOnce(json({ ...envelope, superseded: true }));
      await expect(oxy.identity.backup.restoreRetiredKeys(PHRASE)).resolves.toBe(2);
      expect(mockRing.kept.map((key) => key.publicKey).sort()).toEqual(
        [KeyManager.derivePublicKey(RETIRED), KeyManager.derivePublicKey(CURRENT_PRIVATE)].sort(),
      );
    });
  });

  it('a sealed backup clears the owed flag; isOwed answers for the signed-in account (R5-9)', async () => {
    const owed = jest.spyOn(KeyManager, 'backupOwedEntry').mockResolvedValue({});
    const clear = jest.spyOn(KeyManager, 'clearBackupOwed').mockResolvedValue();
    await expect(oxy.identity.backup.isOwed()).resolves.toBe(true);
    expect(owed).toHaveBeenLastCalledWith('me');
    owed.mockResolvedValue(null);
    await expect(oxy.identity.backup.isOwed()).resolves.toBe(false);
    owed.mockResolvedValue({});
    await createAndCapture();
    // Only this account's entry (R7-10).
    expect(clear).toHaveBeenCalledWith('me');
  });

  describe('a superseded backup is replaced only with its acknowledgement (R7-2)', () => {
    const previousPrivate = async () =>
      RecoveryPhraseService.derivePrivateKeyFromPhrase(PREVIOUS_PHRASE);
    const previousLookupId = async () =>
      (await RecoveryPhraseService.deriveBackupMaterial(PREVIOUS_PHRASE)).lookupId.toLowerCase();

    /** The previous phrase's backup, sealed while it was the account's key, as served superseded. */
    async function supersededEnvelope(): Promise<EncryptedBackupEnvelope> {
      const previous = await previousPrivate();
      historyMock.mockResolvedValue(
        json({ publicKey: KeyManager.derivePublicKey(previous), retired: [] }),
      );
      fetchMock
        .mockResolvedValueOnce(json({ error: 'not found' }, 404))
        .mockResolvedValueOnce(json({ exists: true }));
      await oxy.identity.backup.create(PREVIOUS_PHRASE);
      const envelope = lastUpload();
      // The rotation: the current key is PHRASE's; the previous one is retired.
      historyMock.mockResolvedValue(history([RETIRED, previous]));
      fetchMock.mockReset();
      mockRing.kept = [];
      return { ...envelope, superseded: true };
    }

    it('sends the owed entry’s acknowledgement, and a refusal is a typed error', async () => {
      const ack = 'ab'.repeat(32);
      jest.spyOn(KeyManager, 'backupOwedEntry').mockResolvedValue({ supersededLookupId: ack });
      const clear = jest.spyOn(KeyManager, 'clearBackupOwed').mockResolvedValue();
      fetchMock
        .mockResolvedValueOnce(json({ error: 'not found' }, 404))
        .mockResolvedValueOnce(
          json({ error: 'IDENTITY_BACKUP_SUPERSEDED', message: 'superseded' }, 409),
        );
      await expect(oxy.identity.backup.create(PHRASE)).rejects.toBeInstanceOf(
        IdentityBackupSupersededError,
      );
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body)).replacesLookupId).toBe(ack);
      expect(clear).not.toHaveBeenCalled();
    });

    it('with the previous phrase, carries its keys and acknowledges it with its locator', async () => {
      const envelope = await supersededEnvelope();
      fetchMock
        .mockResolvedValueOnce(json(envelope)) // the previous phrase opens the superseded backup
        .mockResolvedValueOnce(json({ error: 'not found' }, 404)) // the current phrase has none
        .mockResolvedValueOnce(json({ exists: true }));
      await oxy.identity.backup.create(PHRASE, { previousPhrase: PREVIOUS_PHRASE });
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body)).replacesLookupId).toBe(await previousLookupId());
      expect(mockRing.kept.map((key) => key.publicKey)).toContain(
        KeyManager.derivePublicKey(await previousPrivate()),
      );
    });

    it('a phrase that opens no superseded backup changes nothing', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
      await expect(
        oxy.identity.backup.create(PHRASE, { previousPhrase: PREVIOUS_PHRASE }),
      ).rejects.toThrow('Nothing changed');
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('restoreRetiredKeys records the acknowledgement once every key it holds is bound', async () => {
      const envelope = await supersededEnvelope();
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const previousPublic = KeyManager.derivePublicKey(await previousPrivate());
      fetchMock
        .mockResolvedValueOnce(json(envelope))
        .mockResolvedValueOnce(
          json({ exists: false, superseded: true, publicKeyHint: previousPublic.slice(0, 16) }),
        );
      await expect(oxy.identity.backup.restoreRetiredKeys(PREVIOUS_PHRASE)).resolves.toBe(1);
      expect(mark).toHaveBeenCalledWith('me', { supersededLookupId: await previousLookupId() });
    });

    it('restoreRetiredKeys records nothing for a backup that is not the account’s stored one', async () => {
      const envelope = await supersededEnvelope();
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      fetchMock
        .mockResolvedValueOnce(json(envelope))
        .mockResolvedValueOnce(
          json({ exists: false, superseded: true, publicKeyHint: '04ffffffffffffff' }),
        );
      await oxy.identity.backup.restoreRetiredKeys(PREVIOUS_PHRASE);
      expect(mark).not.toHaveBeenCalled();
    });
  });
});
