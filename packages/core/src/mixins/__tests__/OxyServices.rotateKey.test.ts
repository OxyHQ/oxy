/**
 * Key-rotation mixin tests (b3 Feature 3).
 *
 * Cover the client orchestration of `oxy.identity.rotateKey(...)`:
 *  - the EXACT signed rotation payload (must match the server's reconstruction
 *    byte-for-byte);
 *  - device-proof signs with the on-device key; phrase-proof re-derives and
 *    signs with the OLD key (proving the last credential can be replaced);
 *  - BOTH proofs are sent: the OLD key signs `rotate_key`, the NEW key signs the
 *    `rotate_key_new` proof-of-possession;
 *  - the safety ordering (local key persisted ONLY after server confirmation);
 *  - the local-persist failure path still surfaces the new phrase;
 *  - the ambiguous-network-failure reconciliation against the DID document.
 *
 * `makeRequest` is stubbed so the tests run with no network. The real
 * secp256k1 signing runs in the phrase-proof test so we can cryptographically
 * assert which key produced each signature.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import type { DidDocument } from '@oxyhq/contracts';
import * as protocol from '@oxyhq/protocol';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { SignatureService } from '../../crypto/signatureService';
import { RecoveryPhraseService } from '../../crypto/recoveryPhrase';
import { setPlatformOS } from '../../utils/platform';

const oldKeyPair = generateSecp256k1KeyPair();
const newKeyPair = generateSecp256k1KeyPair();
const OLD_PUBLIC = oldKeyPair.publicKey;
const NEW_PUBLIC = newKeyPair.publicKey;
const NEW_PRIVATE = newKeyPair.privateKey;

const pendingFixture = {
  phrase: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
  words: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'],
  privateKey: NEW_PRIVATE,
  publicKey: NEW_PUBLIC,
};

function didDocWithKey(publicKeyHex: string): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: 'did:web:oxy.so:u:user-123',
    controller: ['did:web:oxy.so:u:user-123', 'did:web:oxy.so'],
    verificationMethod: [
      {
        id: 'did:web:oxy.so:u:user-123#key-1',
        type: 'EcdsaSecp256k1VerificationKey2019',
        controller: 'did:web:oxy.so:u:user-123',
        publicKeyHex,
      },
    ],
    authentication: ['did:web:oxy.so:u:user-123#key-1'],
    assertionMethod: ['did:web:oxy.so:u:user-123#key-1'],
    alsoKnownAs: [],
    service: [],
  };
}

describe('OxyServices.rotateKey', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;
  let clearEntrySpy: jest.SpyInstance;

  beforeEach(() => {
    setPlatformOS('ios'); // native → the new key is persisted locally after success
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
    jest.spyOn(oxy, 'clearCacheByPrefix').mockReturnValue(0);
    clearEntrySpy = jest.spyOn(oxy, 'clearCacheEntry').mockReturnValue(undefined);
    jest.spyOn(oxy, 'getCurrentUserId').mockReturnValue('user-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('device proof', () => {
    it('signs the exact rotation payload, POSTs challenge→complete, then persists the new key locally', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      const signSpy = jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      // The new-key proof is signed with the pending private key via protocol.signMessage.
      const newKeySignSpy = jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      const result = await oxy.rotateKey({ proof: 'device' });

      expect(result).toEqual({ newPublicKey: NEW_PUBLIC, newPhrase: pendingFixture.phrase, words: pendingFixture.words });

      // The OLD-key signed message MUST match the server's reconstruction byte-for-byte.
      const expectedMessage = JSON.stringify({
        action: 'rotate_key',
        userId: 'user-123',
        oldPublicKey: KeyManager.canonicalPublicKey(OLD_PUBLIC),
        newPublicKey: NEW_PUBLIC,
        challenge: 'chal-1',
        timestamp: 1700000000000,
      });
      expect(signSpy).toHaveBeenCalledWith(expectedMessage);
      // The NEW-key proof is signed with the pending private key over rotate_key_new.
      const expectedNewKeyMessage = JSON.stringify({
        action: 'rotate_key_new',
        userId: 'user-123',
        newPublicKey: NEW_PUBLIC,
        challenge: 'chal-1',
        timestamp: 1700000000000,
      });
      expect(newKeySignSpy).toHaveBeenCalledWith(expectedNewKeyMessage, NEW_PRIVATE);

      expect(makeRequestSpy).toHaveBeenNthCalledWith(1, 'POST', '/auth/rotate/challenge', undefined, expect.objectContaining({ cache: false }));
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/auth/rotate/complete',
        { newPublicKey: NEW_PUBLIC, challenge: 'chal-1', signature: 'sig-hex', newKeyProof: 'newkeyproof-hex', timestamp: 1700000000000 },
        expect.objectContaining({ cache: false }),
      );

      // Persisted ONLY after the server confirmed the swap.
      expect(importSpy).toHaveBeenCalledWith(NEW_PRIVATE, { overwrite: true });
      // DID + auth-method caches are swept.
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/auth/methods');
    });

    it('forwards signOutEverywhere in the complete body', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      await oxy.rotateKey({ proof: 'device', signOutEverywhere: true });

      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/auth/rotate/complete',
        expect.objectContaining({ signOutEverywhere: true, newKeyProof: 'newkeyproof-hex' }),
        expect.anything(),
      );
    });

    it('does NOT throw and surfaces the new phrase when the local key persist fails after a server rotation', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      // The server rotated successfully, but the on-device persist fails.
      jest.spyOn(KeyManager, 'importKeyPair').mockRejectedValue(new Error('secure store write failed'));
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      const result = await oxy.rotateKey({ proof: 'device' });

      // The phrase for the now-live key is surfaced, with a failure flag — never lost.
      expect(result).toEqual({
        newPublicKey: NEW_PUBLIC,
        newPhrase: pendingFixture.phrase,
        words: pendingFixture.words,
        localPersistFailed: true,
      });
      // Caches are still swept (the server key is the new one).
      expect(clearEntrySpy).toHaveBeenCalledWith('GET:/u/user-123/did.json');
    });

    it('throws (no network) when the device holds no identity', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);

      await expect(oxy.rotateKey({ proof: 'device' })).rejects.toThrow(/No on-device identity/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('phrase proof (replace the LAST credential)', () => {
    it('re-derives the CURRENT key from the entered phrase and signs the proof with it', async () => {
      // A real "current" identity whose phrase the user re-enters, and a real new one.
      const current = await RecoveryPhraseService.derivePendingIdentity();
      const next = await RecoveryPhraseService.derivePendingIdentity();
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(next);
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(next.publicKey);

      let completeBody: Record<string, unknown> | undefined;
      makeRequestSpy.mockImplementation((_m: string, path: string, body?: unknown) => {
        if (path === '/auth/rotate/challenge') return Promise.resolve({ challenge: 'chal-x', expiresAt: '2999-01-01T00:00:00.000Z' });
        if (path === '/auth/rotate/complete') {
          completeBody = body as Record<string, unknown>;
          return Promise.resolve({ success: true, publicKey: next.publicKey, message: 'ok' });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      });

      const result = await oxy.rotateKey({ proof: 'phrase', phrase: current.phrase });
      expect(result.newPublicKey).toBe(next.publicKey);

      // The OLD-key signature MUST verify against the current key over the exact message.
      const message = JSON.stringify({
        action: 'rotate_key',
        userId: 'user-123',
        oldPublicKey: KeyManager.canonicalPublicKey(current.publicKey),
        newPublicKey: next.publicKey,
        challenge: 'chal-x',
        timestamp: completeBody?.timestamp,
      });
      expect(await protocol.verifySignature(message, completeBody?.signature as string, current.publicKey)).toBe(true);
      // …and must NOT verify against the new key (proves it was signed by the current key).
      expect(await protocol.verifySignature(message, completeBody?.signature as string, next.publicKey)).toBe(false);

      // The NEW-key proof-of-possession MUST verify against the NEW key.
      const newKeyMessage = JSON.stringify({
        action: 'rotate_key_new',
        userId: 'user-123',
        newPublicKey: next.publicKey,
        challenge: 'chal-x',
        timestamp: completeBody?.timestamp,
      });
      expect(await protocol.verifySignature(newKeyMessage, completeBody?.newKeyProof as string, next.publicKey)).toBe(true);
      // …and must NOT verify against the old key (proves possession of the new key).
      expect(await protocol.verifySignature(newKeyMessage, completeBody?.newKeyProof as string, current.publicKey)).toBe(false);
    });

    it('throws when proof is phrase but no phrase is supplied', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      await expect(oxy.rotateKey({ proof: 'phrase' })).rejects.toThrow(/recovery phrase is required/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('ambiguous network failure', () => {
    it('reconciles a lost complete-response against the DID and treats a landed swap as done', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockRejectedValueOnce(new Error('network lost'))
        .mockResolvedValueOnce(didDocWithKey(NEW_PUBLIC)); // DID already advertises the new key

      const result = await oxy.rotateKey({ proof: 'device' });

      expect(result.newPublicKey).toBe(NEW_PUBLIC);
      expect(makeRequestSpy).toHaveBeenNthCalledWith(3, 'GET', '/u/user-123/did.json', undefined, expect.objectContaining({ cache: false }));
      // The swap landed server-side, so the new key is persisted locally.
      expect(importSpy).toHaveBeenCalledWith(NEW_PRIVATE, { overwrite: true });
    });

    it('surfaces the error and does NOT persist locally when the DID shows the swap did not land', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockRejectedValueOnce(new Error('network lost'))
        .mockResolvedValueOnce(didDocWithKey(OLD_PUBLIC)); // DID still shows the OLD key

      await expect(oxy.rotateKey({ proof: 'device' })).rejects.toBeDefined();
      expect(importSpy).not.toHaveBeenCalled();
    });
  });
});
