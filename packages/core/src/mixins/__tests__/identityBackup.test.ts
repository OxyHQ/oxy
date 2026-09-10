/**
 * Encrypted off-device identity backup mixin (b3 Feature 1).
 *
 * Exercises the full client contract with a REAL crypto round-trip (only
 * `KeyManager.importKeyPair` — the native SecureStore write — is mocked):
 *  - `createEncryptedBackup` derives the material, encrypts the identity, and
 *    POSTs the envelope + raw `lookupId` (the server never sees the phrase/key).
 *  - the uploaded envelope decrypts back to the SAME private key via
 *    `restoreFromEncryptedBackup` (round-trip).
 *  - any tamper (ciphertext / nonce / AAD-bound publicKeyHint) fails the
 *    Poly1305 check → restore rejects.
 *  - an existing on-device identity surfaces `IdentityAlreadyExistsError`
 *    UNCHANGED (not flattened by `handleError`), and `overwrite` forwards.
 */
import { OxyServices } from '../../OxyServices';
import { KeyManager, IdentityAlreadyExistsError } from '../../crypto/keyManager';
import { RecoveryPhraseService } from '../../crypto/recoveryPhrase';
import { encryptAead, decryptAead } from '../../crypto/aead';
import type { EncryptedBackupEnvelope, BackupUploadRequest } from '@oxy.so/contracts';

const FIXED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EXPECTED_LOOKUP_ID = '8cad137ca961bfc62a2ef329869e8369777737c7c5353a8d94bb70d888c0ad0d';
const EXPECTED_PRIVATE_KEY = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1';

/** Build a non-verified JWT whose payload decodes to the given claims. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

/** A JSON `Response` returning the body verbatim (no `{ data }` wrapper). */
function plainResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('encrypted identity backup mixin', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.httpService.setTokens(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  /** Read + parse the body of the Nth fetch call as the upload request. */
  function uploadBodyFromCall(index: number): BackupUploadRequest {
    const init = fetchMock.mock.calls[index][1];
    return JSON.parse(String(init?.body)) as BackupUploadRequest;
  }

  it('createEncryptedBackup uploads an envelope + raw lookupId derived from the phrase', async () => {
    fetchMock.mockResolvedValueOnce(
      plainResponse({ exists: true, publicKeyHint: '04abc', createdAt: 'x' }),
    );

    await oxy.createEncryptedBackup(FIXED_PHRASE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/identity/backup');
    expect(init?.method).toBe('POST');

    const body = uploadBodyFromCall(0);
    // Envelope metadata.
    expect(body.version).toBe(1);
    expect(body.algorithm).toBe('xchacha20poly1305');
    expect(body.kdfInfo).toBe('oxy-backup-encryption-key');
    // The raw lookup id is the phrase-derived value (server will hash it).
    expect(body.lookupId).toBe(EXPECTED_LOOKUP_ID);
    // Hex ciphertext + 24-byte (48 hex) nonce.
    expect(body.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(body.ciphertext).toMatch(/^[0-9a-f]+$/);
    // The hint is a 16-char prefix of the identity's real public key.
    const publicKey = KeyManager.derivePublicKey(EXPECTED_PRIVATE_KEY);
    expect(body.publicKeyHint).toBe(publicKey.slice(0, 16));
    expect(body.publicKeyHint).toHaveLength(16);
    // The plaintext private key NEVER appears on the wire.
    expect(String(init?.body)).not.toContain(EXPECTED_PRIVATE_KEY);
  });

  it('round-trips: the uploaded envelope decrypts back to the SAME private key', async () => {
    // 1) Encrypt + capture the real envelope.
    fetchMock.mockResolvedValueOnce(
      plainResponse({ exists: true, publicKeyHint: '04', createdAt: 'x' }),
    );
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);
    const envelope: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: uploaded.nonce,
      ciphertext: uploaded.ciphertext,
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    // 2) Restore: intercept the native SecureStore write.
    const importSpy = jest
      .spyOn(KeyManager, 'importKeyPair')
      .mockResolvedValue('restored-public-key');
    fetchMock.mockResolvedValueOnce(plainResponse(envelope));

    const publicKey = await oxy.restoreFromEncryptedBackup(FIXED_PHRASE);

    // The GET targets the locator; import receives the decrypted private key.
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(`http://test.invalid/identity/backup/${EXPECTED_LOOKUP_ID}`);
    expect(init?.method).toBe('GET');
    expect(importSpy).toHaveBeenCalledWith(EXPECTED_PRIVATE_KEY, { overwrite: false });
    expect(publicKey).toBe('restored-public-key');
  });

  it('rejects a tampered ciphertext (Poly1305 authentication fails)', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);

    // Flip the first ciphertext byte.
    const firstByte = uploaded.ciphertext.slice(0, 2);
    const flipped = (Number.parseInt(firstByte, 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: uploaded.nonce,
      ciphertext: flipped + uploaded.ciphertext.slice(2),
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('x');
    fetchMock.mockResolvedValueOnce(plainResponse(tampered));

    await expect(oxy.restoreFromEncryptedBackup(FIXED_PHRASE)).rejects.toThrow();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('rejects when the AAD-bound publicKeyHint is altered', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);

    const tampered: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: uploaded.nonce,
      ciphertext: uploaded.ciphertext,
      publicKeyHint: 'deadbeefdeadbeef', // wrong hint → AAD mismatch
      createdAt: uploaded.createdAt,
    };

    const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('x');
    fetchMock.mockResolvedValueOnce(plainResponse(tampered));

    await expect(oxy.restoreFromEncryptedBackup(FIXED_PHRASE)).rejects.toThrow();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('rejects a mismatched nonce', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);

    const tampered: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: '00'.repeat(24), // wrong nonce
      ciphertext: uploaded.ciphertext,
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    fetchMock.mockResolvedValueOnce(plainResponse(tampered));
    await expect(oxy.restoreFromEncryptedBackup(FIXED_PHRASE)).rejects.toThrow();
  });

  it('rejects when decrypted payload publicKey does not match the recovery phrase', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);

    const { backupKey } = await RecoveryPhraseService.deriveBackupMaterial(FIXED_PHRASE);
    const aad = new TextEncoder().encode(
      JSON.stringify({ version: uploaded.version, publicKeyHint: uploaded.publicKeyHint }),
    );
    const fromHex = (hex: string): Uint8Array => {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    };
    const toHex = (bytes: Uint8Array): string =>
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

    const plaintext = decryptAead(
      backupKey,
      fromHex(uploaded.nonce),
      fromHex(uploaded.ciphertext),
      aad,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
      privateKey: string;
      publicKey: string;
      createdAt: string;
    };
    payload.publicKey = `${payload.publicKey.slice(0, -1)}0`;

    const { nonce, ciphertext } = encryptAead(
      backupKey,
      new TextEncoder().encode(JSON.stringify(payload)),
      aad,
    );
    const tampered: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: toHex(nonce),
      ciphertext: toHex(ciphertext),
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue('x');
    fetchMock.mockResolvedValueOnce(plainResponse(tampered));

    await expect(oxy.restoreFromEncryptedBackup(FIXED_PHRASE)).rejects.toThrow(
      /does not match the recovery phrase/,
    );
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('propagates IdentityAlreadyExistsError UNCHANGED (so the caller can offer overwrite)', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);
    const envelope: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: uploaded.nonce,
      ciphertext: uploaded.ciphertext,
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    jest
      .spyOn(KeyManager, 'importKeyPair')
      .mockRejectedValue(new IdentityAlreadyExistsError('04existingkey'));
    fetchMock.mockResolvedValueOnce(plainResponse(envelope));

    await expect(oxy.restoreFromEncryptedBackup(FIXED_PHRASE)).rejects.toBeInstanceOf(
      IdentityAlreadyExistsError,
    );
  });

  it('forwards overwrite:true to importKeyPair', async () => {
    fetchMock.mockResolvedValueOnce(plainResponse({ exists: true }));
    await oxy.createEncryptedBackup(FIXED_PHRASE);
    const uploaded = uploadBodyFromCall(0);
    const envelope: EncryptedBackupEnvelope = {
      version: uploaded.version,
      algorithm: uploaded.algorithm,
      kdfInfo: uploaded.kdfInfo,
      nonce: uploaded.nonce,
      ciphertext: uploaded.ciphertext,
      publicKeyHint: uploaded.publicKeyHint,
      createdAt: uploaded.createdAt,
    };

    const importSpy = jest
      .spyOn(KeyManager, 'importKeyPair')
      .mockResolvedValue('restored-public-key');
    fetchMock.mockResolvedValueOnce(plainResponse(envelope));

    await oxy.restoreFromEncryptedBackup(FIXED_PHRASE, { overwrite: true });
    expect(importSpy).toHaveBeenCalledWith(EXPECTED_PRIVATE_KEY, { overwrite: true });
  });

  it('getBackupStatus + deleteBackup hit the right endpoints', async () => {
    fetchMock.mockResolvedValueOnce(
      plainResponse({ exists: true, publicKeyHint: '04abc', createdAt: 'iso' }),
    );
    const status = await oxy.getBackupStatus();
    expect(status).toEqual({ exists: true, publicKeyHint: '04abc', createdAt: 'iso' });
    let [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://test.invalid/identity/backup/status');
    expect(init?.method).toBe('GET');

    fetchMock.mockResolvedValueOnce(plainResponse({ success: true }));
    await expect(oxy.deleteBackup()).resolves.toEqual({ success: true });
    [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe('http://test.invalid/identity/backup');
    expect(init?.method).toBe('DELETE');
  });
});
