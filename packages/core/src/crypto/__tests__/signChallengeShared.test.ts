/**
 * `signChallengeWithSharedKey` tests.
 *
 * Verifies the shared-key challenge signer mirrors `signChallenge` exactly —
 * same `auth:${publicKey}:${challenge}:${timestamp}` message format so the
 * server verification path is unchanged — but sources the SHARED key from
 * `KeyManager` (not the primary device key). We mock the shared key access with
 * a real secp256k1 keypair so signing/verification is genuine.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { verifySignature } from '@oxyhq/protocol';
import { KeyManager } from '../keyManager';
import { SignatureService } from '../signatureService';

describe('SignatureService.signChallengeWithSharedKey', () => {
  const sharedKeyPair = generateSecp256k1KeyPair();
  const sharedPublicKey = sharedKeyPair.publicKey;
  const sharedPrivateKey = sharedKeyPair.privateKey;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('signs with the shared key and uses the unchanged message format', async () => {
    jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue(sharedPublicKey);
    jest.spyOn(KeyManager, 'getSharedPrivateKey').mockResolvedValue(sharedPrivateKey);
    // Guard: it must NOT fall back to the primary device key.
    const primarySpy = jest.spyOn(KeyManager, 'getPublicKey');

    const result = await SignatureService.signChallengeWithSharedKey('chal-123');

    expect(result.publicKey).toBe(sharedPublicKey);
    expect(typeof result.challenge).toBe('string'); // the signature
    expect(typeof result.timestamp).toBe('number');
    expect(primarySpy).not.toHaveBeenCalled();

    // The signature verifies against the SAME message format `signChallenge`
    // uses, proving the format is unchanged and the shared key signed it.
    const message = `auth:${sharedPublicKey}:chal-123:${result.timestamp}`;
    await expect(
      verifySignature(message, result.challenge, sharedPublicKey),
    ).resolves.toBe(true);
  });

  it('throws when no shared identity exists', async () => {
    jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue(null);
    jest.spyOn(KeyManager, 'getSharedPrivateKey').mockResolvedValue(null);

    await expect(
      SignatureService.signChallengeWithSharedKey('chal-123'),
    ).rejects.toThrow(/No shared identity/);
  });

  it('throws when the shared private key is missing even if the public key is present', async () => {
    jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue(sharedPublicKey);
    jest.spyOn(KeyManager, 'getSharedPrivateKey').mockResolvedValue(null);

    await expect(
      SignatureService.signChallengeWithSharedKey('chal-123'),
    ).rejects.toThrow(/No shared identity/);
  });
});
