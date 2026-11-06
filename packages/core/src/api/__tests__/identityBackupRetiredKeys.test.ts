/**
 * The encrypted identity backup carries the retired ring (R4-4, ADR 0061 D7
 * as amended): the CURRENT phrase restores the keys earlier coins sit under.
 * Real crypto round-trip; the ring and the native key write are mocked.
 */
import type { BackupUploadRequest, EncryptedBackupEnvelope } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { setPlatformOS } from '../../utils/platform';

const mockRing = {
  holds: true,
  unreadable: false,
  held: [] as Array<{ privateKey: string; publicKey: string; retiredAt: number }>,
  kept: [] as Array<{ privateKey: string; publicKey: string }>,
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
}));

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RETIRED = 'a7'.repeat(32);
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
  let oxy: OxyServices;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setPlatformOS('ios');
    mockRing.holds = true;
    mockRing.unreadable = false;
    mockRing.held = [];
    mockRing.kept = [];
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
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
      .mockResolvedValueOnce(history())
      .mockResolvedValueOnce(json({ exists: true }));
    await oxy.identity.backup.create(PHRASE);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://test.invalid/identity/key-history');
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

  it('a ring that cannot be checked against the key history fails the backup', async () => {
    mockRing.held = [
      { privateKey: RETIRED, publicKey: KeyManager.derivePublicKey(RETIRED), retiredAt: 1 },
    ];
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockResolvedValue(json({ error: 'down' }, 503));
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
    fetchMock
      .mockResolvedValueOnce(json(previous))
      .mockResolvedValueOnce(history())
      .mockResolvedValueOnce(json({ exists: true }));
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
    fetchMock
      .mockResolvedValueOnce(json(previous))
      .mockResolvedValueOnce(history([])) // the history no longer names it
      .mockResolvedValueOnce(json({ exists: true }));
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

  it('a sealed backup clears the owed flag; isOwed answers for the signed-in account (R5-9)', async () => {
    const owed = jest.spyOn(KeyManager, 'backupOwedFor').mockResolvedValue('me');
    const clear = jest.spyOn(KeyManager, 'clearBackupOwed').mockResolvedValue();
    await expect(oxy.identity.backup.isOwed()).resolves.toBe(true);
    owed.mockResolvedValue('someone-else');
    await expect(oxy.identity.backup.isOwed()).resolves.toBe(false);
    owed.mockResolvedValue('me');
    await createAndCapture();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
