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
  held: [] as Array<{ privateKey: string; publicKey: string; retiredAt: number }>,
  kept: [] as Array<{ privateKey: string; publicKey: string }>,
};

jest.mock('../../crypto/retiredKeys', () => ({
  ...jest.requireActual('../../crypto/retiredKeys'),
  exportRetiredIdentityKeys: async () => mockRing.held,
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
      .mockResolvedValueOnce(
        json({
          publicKey: current,
          retired: [{ publicKey: retiredPublic, retiredAt: '2026-11-01T00:00:00.000Z' }],
        }),
      )
      .mockResolvedValueOnce(json({ exists: true }));
    await oxy.identity.backup.create(PHRASE);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://test.invalid/identity/key-history');
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as BackupUploadRequest;
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

  it('a ring that cannot be checked against the key history fails the backup', async () => {
    mockRing.held = [
      { privateKey: RETIRED, publicKey: KeyManager.derivePublicKey(RETIRED), retiredAt: 1 },
    ];
    fetchMock.mockResolvedValue(json({ error: 'down' }, 503));
    await expect(oxy.identity.backup.create(PHRASE)).rejects.toBeDefined();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
