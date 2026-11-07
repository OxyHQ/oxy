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

import { generateSecp256k1KeyPair } from '@oxy.so/protocol/secp256k1';
import type { DidDocument } from '@oxy.so/contracts';
import * as protocol from '@oxy.so/protocol/sign';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { SignatureService } from '../../crypto/signatureService';
import { RecoveryPhraseService } from '../../crypto/recoveryPhrase';
import { setPlatformOS } from '../../utils/platform';

// The retired-key ring (ADR 0061 D7 as amended): stubbed so the orchestration
// can be observed; the ring itself is `crypto/__tests__/retiredKeys.test.ts`.
const mockRetire = jest.fn<Promise<void>, [{ privateKey: string; publicKey: string }]>(
  async () => undefined,
);
const mockQuarantine = jest.fn<Promise<void>, [{ privateKey: string; publicKey: string }]>(
  async () => undefined,
);
jest.mock('../../crypto/retiredKeys', () => ({
  ...jest.requireActual('../../crypto/retiredKeys'),
  retireIdentityKey: (key: { privateKey: string; publicKey: string }) => mockRetire(key),
  quarantineRetiredIdentityKey: (key: { privateKey: string; publicKey: string }) =>
    mockQuarantine(key),
}));

/** Route `invalidateCache` into per-key / per-prefix mocks (one pair per client). */
const cacheSpyMap = new WeakMap<OxyServices, { keys: jest.Mock; prefixes: jest.Mock }>();
function cacheSpies(client: OxyServices): { keys: jest.Mock; prefixes: jest.Mock } {
  let spies = cacheSpyMap.get(client);
  if (!spies) {
    const created = { keys: jest.fn(), prefixes: jest.fn() };
    jest
      .spyOn(client.http, 'invalidateCache')
      .mockImplementation(({ keys = [], prefixes = [] }) => {
        for (const key of keys) created.keys(key);
        for (const prefix of prefixes) created.prefixes(prefix);
        return 0;
      });
    cacheSpyMap.set(client, created);
    spies = created;
  }
  return spies;
}

const oldKeyPair = generateSecp256k1KeyPair();
const newKeyPair = generateSecp256k1KeyPair();
const OLD_PUBLIC = oldKeyPair.publicKey;
const NEW_PUBLIC = newKeyPair.publicKey;
const NEW_PRIVATE = newKeyPair.privateKey;

const pendingFixture = {
  phrase: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
  words: [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
  ],
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
  let historySpy: jest.SpyInstance;

  beforeEach(() => {
    setPlatformOS('ios'); // native → the new key is persisted locally after success
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
    cacheSpies(oxy).prefixes;
    clearEntrySpy = cacheSpies(oxy).keys;
    jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue('user-123');
    mockRetire.mockReset();
    mockRetire.mockResolvedValue(undefined);
    mockQuarantine.mockReset();
    mockQuarantine.mockResolvedValue(undefined);
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(oldKeyPair.privateKey);
    // A backup with nothing to carry over and no other key in the slots,
    // unless a test says so. (With NO backup on record, a rotation needs the
    // person's explicit `createBackup`; that is its own describe below.)
    jest
      .spyOn(oxy.identity.backup, 'readBeforeRotation')
      .mockResolvedValue({ existed: true, carried: [] });
    jest.spyOn(KeyManager, 'heldIdentityPrivateKeys').mockResolvedValue([oldKeyPair.privateKey]);
    // The account's key history (R6-10): the key being replaced is its current root.
    historySpy = jest.spyOn(oxy.identity, 'keyHistory').mockResolvedValue({
      publicKey: KeyManager.canonicalPublicKey(OLD_PUBLIC).toLowerCase(),
      retired: [],
    });
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
      // The new-key proof is signed with the pending private key via the protocol signer.
      const newKeySignSpy = jest
        .spyOn(protocol, 'signMessage')
        .mockResolvedValue('newkeyproof-hex');
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      // The rotation deleted the encrypted backup; it is sealed again under the
      // NEW phrase, carrying the retired ring (R4-4).
      const backupSpy = jest
        .spyOn(oxy.identity.backup, 'seal')
        .mockResolvedValue({ exists: true } as never);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      const result = await oxy.identity.rotateKey({ proof: 'device' });

      expect(result).toEqual({
        newPublicKey: NEW_PUBLIC,
        newPhrase: pendingFixture.phrase,
        words: pendingFixture.words,
        backupRefreshed: true,
      });
      expect(backupSpy).toHaveBeenCalledWith(pendingFixture.phrase, [], {
        replacesLookupId: undefined,
      });

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

      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        1,
        'POST',
        '/auth/rotate/challenge',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/auth/rotate/complete',
        {
          newPublicKey: NEW_PUBLIC,
          challenge: 'chal-1',
          signature: 'sig-hex',
          newKeyProof: 'newkeyproof-hex',
          timestamp: 1700000000000,
        },
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

      await oxy.identity.rotateKey({ proof: 'device', signOutEverywhere: true });

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
      jest
        .spyOn(KeyManager, 'importKeyPair')
        .mockRejectedValue(new Error('secure store write failed'));
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      const result = await oxy.identity.rotateKey({ proof: 'device' });

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

    // The new phrase is the account's recovery phrase from here on. Before this,
    // the slot kept the REPLACED key's phrase, and Settings revealed it as the
    // user's recovery phrase although it recovers nothing.
    describe('the recovery phrase slot', () => {
      function arrangeServerRotation() {
        jest
          .spyOn(RecoveryPhraseService, 'derivePendingIdentity')
          .mockResolvedValue(pendingFixture);
        jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
        jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
        jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
        makeRequestSpy
          .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
          .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });
      }

      it('stores the new phrase once the new key is persisted', async () => {
        arrangeServerRotation();
        const order: string[] = [];
        jest.spyOn(KeyManager, 'importKeyPair').mockImplementation(async () => {
          order.push('key');
          return NEW_PUBLIC;
        });
        const storeSpy = jest
          .spyOn(KeyManager, 'storeRecoveryMnemonic')
          .mockImplementation(async () => {
            order.push('phrase');
          });
        const deleteSpy = jest.spyOn(KeyManager, 'deleteRecoveryMnemonic').mockResolvedValue();

        await oxy.identity.rotateKey({ proof: 'device' });

        expect(storeSpy).toHaveBeenCalledWith(pendingFixture.phrase);
        expect(order).toEqual(['key', 'phrase']);
        expect(deleteSpy).not.toHaveBeenCalled();
      });

      it('clears the replaced phrase when the new one cannot be stored, and still succeeds', async () => {
        arrangeServerRotation();
        jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
        jest
          .spyOn(KeyManager, 'storeRecoveryMnemonic')
          .mockRejectedValue(new Error('keychain write failed'));
        const deleteSpy = jest.spyOn(KeyManager, 'deleteRecoveryMnemonic').mockResolvedValue();

        const result = await oxy.identity.rotateKey({ proof: 'device' });

        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
          newPublicKey: NEW_PUBLIC,
          newPhrase: pendingFixture.phrase,
          words: pendingFixture.words,
          backupRefreshed: false,
        });
      });

      it('leaves the slot alone when the new key itself could not be persisted', async () => {
        arrangeServerRotation();
        jest
          .spyOn(KeyManager, 'importKeyPair')
          .mockRejectedValue(new Error('secure store write failed'));
        const storeSpy = jest.spyOn(KeyManager, 'storeRecoveryMnemonic').mockResolvedValue();
        const deleteSpy = jest.spyOn(KeyManager, 'deleteRecoveryMnemonic').mockResolvedValue();

        const result = await oxy.identity.rotateKey({ proof: 'device' });

        expect(result).toMatchObject({ localPersistFailed: true });
        expect(storeSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
      });
    });

    // The shared slot is what every cross-app reader takes first, including
    // `deriveScopedSeed` — the FairCoin wallet Peable derives. A rotation that
    // wrote only the primary left that wallet on the replaced key, watching
    // addresses the rotated identity will never be paid at, with no error
    // anywhere. Shared is written FIRST so a crash between the two writes leaves
    // the money path on the new key and the primary stale, which fails loudly.
    it('writes the new key to the shared slot too, before the primary', async () => {
      const order: string[] = [];
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(true);
      const sharedSpy = jest
        .spyOn(KeyManager, 'importSharedIdentity')
        .mockImplementation(async () => {
          order.push('shared');
          return NEW_PUBLIC;
        });
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockImplementation(async () => {
        order.push('primary');
        return NEW_PUBLIC;
      });
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      await oxy.identity.rotateKey({ proof: 'device' });

      expect(sharedSpy).toHaveBeenCalledWith(NEW_PRIVATE);
      expect(importSpy).toHaveBeenCalledWith(NEW_PRIVATE, { overwrite: true });
      expect(order).toEqual(['shared', 'primary']);
    });

    it('leaves the shared slot alone on a device that has none', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(false);
      const sharedSpy = jest.spyOn(KeyManager, 'importSharedIdentity');
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      await oxy.identity.rotateKey({ proof: 'device' });

      expect(sharedSpy).not.toHaveBeenCalled();
    });

    // Android: the shared slot is Commons' identity signer store — what the
    // identity host signs with and derives Peable's seed from for every other
    // app. It is written first whenever this app has one (Commons), whether or
    // not it already holds a key, and never probed over IPC.
    it.each([
      [true, ['begin', 'shared', 'primary', 'complete']],
      [false, ['primary', 'complete']],
    ])('on Android, a signer store (%s) decides the shared write', async (hasSigner, expected) => {
      setPlatformOS('android');
      try {
        const order: string[] = [];
        jest
          .spyOn(RecoveryPhraseService, 'derivePendingIdentity')
          .mockResolvedValue(pendingFixture);
        jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
        jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
        jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
        jest.spyOn(KeyManager, 'hasIdentitySignerStore').mockReturnValue(hasSigner);
        jest.spyOn(KeyManager, 'beginKeyRotation').mockImplementation(async (key) => {
          expect(key).toBe(NEW_PUBLIC);
          order.push('begin');
        });
        jest.spyOn(KeyManager, 'completeKeyRotation').mockImplementation(async () => {
          order.push('complete');
        });
        const probe = jest.spyOn(KeyManager, 'hasSharedIdentity');
        jest.spyOn(KeyManager, 'importSharedIdentity').mockImplementation(async () => {
          order.push('shared');
          return NEW_PUBLIC;
        });
        jest.spyOn(KeyManager, 'importKeyPair').mockImplementation(async () => {
          order.push('primary');
          return NEW_PUBLIC;
        });
        makeRequestSpy
          .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
          .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

        await oxy.identity.rotateKey({ proof: 'device' });

        expect(order).toEqual(expected);
        expect(probe).not.toHaveBeenCalled();
      } finally {
        setPlatformOS('ios');
      }
    });

    it('throws (no network) when the device holds no identity', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow(
        /No on-device identity/,
      );
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('the retired key ring', () => {
    it('keeps the replaced key BEFORE asking for the challenge', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      const order: string[] = [];
      mockRetire.mockImplementation(async () => {
        order.push('retire');
      });
      makeRequestSpy.mockImplementation(async (_method: string, path: string) => {
        order.push(path);
        return path.endsWith('/challenge')
          ? { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' }
          : { success: true, publicKey: NEW_PUBLIC, message: 'ok' };
      });

      await oxy.identity.rotateKey({ proof: 'device' });

      expect(mockRetire).toHaveBeenCalledWith({
        privateKey: oldKeyPair.privateKey,
        publicKey: OLD_PUBLIC,
      });
      expect(order).toEqual(['retire', '/auth/rotate/challenge', '/auth/rotate/complete']);
    });

    it('does not rotate (no request at all) when the replaced key cannot be kept', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      mockRetire.mockRejectedValue(new Error('keychain refused'));

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('Nothing changed');
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('does not rotate when the device key cannot be read to keep it', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(null);

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('Nothing changed');
      expect(mockRetire).not.toHaveBeenCalled();
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('on web keeps nothing (no key is stored there) and still rotates', async () => {
      setPlatformOS('web');
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });

      await oxy.identity.rotateKey({ proof: 'device' });
      expect(mockRetire).not.toHaveBeenCalled();
    });
  });

  describe('round 5: no key is dropped by a rotation', () => {
    function arrange() {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      makeRequestSpy
        .mockResolvedValueOnce({ challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' })
        .mockResolvedValueOnce({ success: true, publicKey: NEW_PUBLIC, message: 'ok' });
    }

    it('keeps an older key a slot still holds before overwriting it (R4-12)', async () => {
      arrange();
      const older = generateSecp256k1KeyPair();
      // The account's history names it: it is bound to the account.
      historySpy.mockResolvedValue({
        publicKey: KeyManager.canonicalPublicKey(OLD_PUBLIC).toLowerCase(),
        retired: [
          {
            publicKey: KeyManager.derivePublicKey(older.privateKey).toLowerCase(),
            retiredAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      jest
        .spyOn(KeyManager, 'heldIdentityPrivateKeys')
        .mockResolvedValue([oldKeyPair.privateKey, older.privateKey]);
      const order: string[] = [];
      mockRetire.mockImplementation(async (key) => {
        order.push(`retire:${key.publicKey === OLD_PUBLIC ? 'old' : 'older'}`);
      });
      jest.spyOn(KeyManager, 'importKeyPair').mockImplementation(async () => {
        order.push('overwrite');
        return NEW_PUBLIC;
      });
      jest.spyOn(oxy.identity.backup, 'seal').mockResolvedValue({ exists: true } as never);

      await oxy.identity.rotateKey({ proof: 'device' });
      expect(order).toEqual(['retire:old', 'retire:older', 'overwrite']);
      expect(mockRetire).toHaveBeenLastCalledWith({
        privateKey: older.privateKey,
        publicKey: KeyManager.derivePublicKey(older.privateKey).toLowerCase(),
      });
    });

    it('an older key the history does not name is kept QUARANTINED, never bound to this account (R6-10)', async () => {
      arrange();
      const stranger = generateSecp256k1KeyPair();
      jest
        .spyOn(KeyManager, 'heldIdentityPrivateKeys')
        .mockResolvedValue([oldKeyPair.privateKey, stranger.privateKey]);
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      jest.spyOn(oxy.identity.backup, 'seal').mockResolvedValue({ exists: true } as never);

      await oxy.identity.rotateKey({ proof: 'device' });
      expect(mockQuarantine).toHaveBeenCalledWith({
        privateKey: stranger.privateKey,
        publicKey: KeyManager.derivePublicKey(stranger.privateKey).toLowerCase(),
      });
      // Only the replaced key was bound to the account.
      expect(mockRetire).toHaveBeenCalledTimes(1);
      expect(mockRetire.mock.calls[0]?.[0].publicKey).toBe(OLD_PUBLIC);
    });

    it('does not rotate when the key history cannot be read (R6-10)', async () => {
      arrange();
      makeRequestSpy.mockReset();
      historySpy.mockRejectedValue(new Error('offline'));
      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('Nothing changed');
      expect(makeRequestSpy).not.toHaveBeenCalled();
      expect(mockRetire).not.toHaveBeenCalled();
    });

    it('overwrites nothing when that older key cannot be kept, and returns the new phrase (R4-12)', async () => {
      arrange();
      const older = generateSecp256k1KeyPair();
      jest.spyOn(KeyManager, 'heldIdentityPrivateKeys').mockResolvedValue([older.privateKey]);
      // Not named by the history: kept quarantined, and the keychain refuses.
      mockQuarantine.mockRejectedValueOnce(new Error('keychain refused'));
      const importSpy = jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      const sealSpy = jest.spyOn(oxy.identity.backup, 'seal');

      const result = await oxy.identity.rotateKey({ proof: 'device' });
      expect(result.localPersistFailed).toBe(true);
      expect(result.newPhrase).toBe(pendingFixture.phrase);
      expect(importSpy).not.toHaveBeenCalled();
      expect(sealSpy).not.toHaveBeenCalled();
    });

    it('carries what the previous backup carried into the new one (R5-6)', async () => {
      arrange();
      const carried = [{ privateKey: 'aa'.repeat(32), publicKey: '04ab', retiredAt: 1 }];
      const replacesLookupId = 'ef'.repeat(32);
      jest
        .spyOn(oxy.identity.backup, 'readBeforeRotation')
        .mockResolvedValue({ existed: true, carried, replacesLookupId });
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const order: string[] = [];
      mockQuarantine.mockImplementation(async () => {
        order.push('kept');
      });
      makeRequestSpy.mockReset();
      makeRequestSpy.mockImplementation(async (_m: string, path: string) => {
        order.push(path);
        if (path.endsWith('/challenge')) {
          return { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' };
        }
        if (path.endsWith('/complete')) {
          return { success: true, publicKey: NEW_PUBLIC, message: 'ok' };
        }
        return didDocWithKey(OLD_PUBLIC);
      });
      const sealSpy = jest
        .spyOn(oxy.identity.backup, 'seal')
        .mockResolvedValue({ exists: true } as never);

      await oxy.identity.rotateKey({ proof: 'device' });
      expect(sealSpy).toHaveBeenCalledWith(pendingFixture.phrase, carried, { replacesLookupId });
      // R7-2: the carried keys are in the ring BEFORE the swap, and the owed
      // entry keeps the previous backup's locator for a later seal.
      expect(order.indexOf('kept')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('kept')).toBeLessThan(order.indexOf('/auth/rotate/complete'));
      expect(mark).toHaveBeenCalledWith('user-123', { supersededLookupId: replacesLookupId });
    });

    it('does not rotate when a key the previous backup carries cannot be kept (R7-2)', async () => {
      arrange();
      const carried = [{ privateKey: 'aa'.repeat(32), publicKey: '04ab', retiredAt: 1 }];
      jest
        .spyOn(oxy.identity.backup, 'readBeforeRotation')
        .mockResolvedValue({ existed: true, carried, replacesLookupId: 'ef'.repeat(32) });
      mockQuarantine.mockRejectedValueOnce(new Error('keychain locked'));
      makeRequestSpy.mockReset();
      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('Nothing changed');
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('does not rotate (no challenge) when the backup exists but cannot be read (R5-6)', async () => {
      arrange();
      makeRequestSpy.mockReset();
      (oxy.identity.backup.readBeforeRotation as jest.Mock).mockRestore?.();
      jest.spyOn(oxy.identity.backup, 'status').mockResolvedValue({ exists: true });
      jest.spyOn(KeyManager, 'getRecoveryMnemonicForCurrentIdentity').mockResolvedValue(null);

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('Nothing changed');
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('keeps the backup owed after an AMBIGUOUS failure: no answer, and a DID that cannot be read (R6-9)', async () => {
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const clear = jest.spyOn(KeyManager, 'clearBackupOwed').mockResolvedValue();
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      makeRequestSpy.mockImplementation(async (_m: string, path: string) => {
        if (path.endsWith('/challenge')) {
          return { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' };
        }
        if (path.endsWith('/complete')) throw new Error('network request failed');
        throw new Error('offline');
      });

      const restore = jest.spyOn(KeyManager, 'restoreBackupOwed').mockResolvedValue();
      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('network');
      expect(mark).toHaveBeenCalledWith('user-123', undefined);
      expect(clear).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

    it('a failure before the swap was asked for marks nothing (R6-9)', async () => {
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      makeRequestSpy.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('down');
      expect(mark).not.toHaveBeenCalled();
    });

    it('marks the backup owed before the swap; clears it when the swap did not happen (R5-9)', async () => {
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      // A backup this account already owed BEFORE the attempt (R7-10).
      const before = { supersededLookupId: 'ab'.repeat(32) };
      jest.spyOn(KeyManager, 'backupOwedEntry').mockResolvedValue(before);
      const restore = jest.spyOn(KeyManager, 'restoreBackupOwed').mockResolvedValue();
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      const order: string[] = [];
      mark.mockImplementation(async () => {
        order.push('owed');
      });
      makeRequestSpy.mockImplementation(async (_m: string, path: string) => {
        order.push(path);
        if (path.endsWith('/challenge')) {
          return { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' };
        }
        if (path.endsWith('/complete')) throw Object.assign(new Error('refused'), { status: 400 });
        return didDocWithKey(OLD_PUBLIC);
      });

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow('refused');
      // Owed only once nothing before the swap can fail (R6-9); a definitive
      // 4xx refusal puts back what was owed before the attempt (R7-10).
      expect(order.slice(0, 3)).toEqual([
        '/auth/rotate/challenge',
        'owed',
        '/auth/rotate/complete',
      ]);
      expect(mark).toHaveBeenCalledWith('user-123', undefined);
      expect(restore).toHaveBeenCalledWith('user-123', before);
    });
  });

  describe("a backup the person DELETED is never re-uploaded silently (owner's decision, 2026-11-07)", () => {
    function arrange() {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(OLD_PUBLIC);
      jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
      jest.spyOn(protocol, 'signMessage').mockResolvedValue('newkeyproof-hex');
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(NEW_PUBLIC);
      jest.spyOn(KeyManager, 'storeRecoveryMnemonic').mockResolvedValue();
      jest.spyOn(KeyManager, 'backupOwedEntry').mockResolvedValue(null);
      makeRequestSpy.mockReset();
      makeRequestSpy.mockImplementation(async (method: string, path: string) => {
        if (path === '/identity/backup/status') return { exists: false, optedOut: true };
        if (path.endsWith('/challenge')) {
          return { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' };
        }
        if (path.endsWith('/complete')) {
          return { success: true, publicKey: NEW_PUBLIC, message: 'ok' };
        }
        throw new Error(`unexpected ${method} ${path}`);
      });
      // The real reading of the server's status: whichever device deleted it.
      (oxy.identity.backup.readBeforeRotation as jest.Mock).mockRestore?.();
    }

    it('uploads nothing and marks nothing owed; the replaced key is still kept on this phone', async () => {
      arrange();
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const seal = jest.spyOn(oxy.identity.backup, 'seal');

      const result = await oxy.identity.rotateKey({ proof: 'device' });

      expect(result.backupOptedOut).toBe(true);
      expect(result.backupRefreshed).toBeUndefined();
      expect(seal).not.toHaveBeenCalled();
      expect(mark).not.toHaveBeenCalled();
      const paths = makeRequestSpy.mock.calls.map(([method, path]) => `${method} ${path}`);
      expect(paths).not.toContain('POST /identity/backup');
      // The replaced key stays here for spending (ADR 0061 D7).
      expect(mockRetire).toHaveBeenCalledWith({
        privateKey: oldKeyPair.privateKey,
        publicKey: OLD_PUBLIC,
      });
    });

    it('createBackup: false is a no, like leaving it out', async () => {
      arrange();
      jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const seal = jest.spyOn(oxy.identity.backup, 'seal');
      await oxy.identity.rotateKey({ proof: 'device', createBackup: false });
      expect(seal).not.toHaveBeenCalled();
    });

    it("the person's explicit choice in the flow uploads, with their opt-in, and is owed until sealed", async () => {
      arrange();
      const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const seal = jest
        .spyOn(oxy.identity.backup, 'seal')
        .mockResolvedValue({ exists: true } as never);

      const result = await oxy.identity.rotateKey({ proof: 'device', createBackup: true });

      expect(seal).toHaveBeenCalledWith(pendingFixture.phrase, [], {
        replacesLookupId: undefined,
        optIn: true,
      });
      expect(mark).toHaveBeenCalledWith('user-123', { optIn: true });
      expect(result.backupRefreshed).toBe(true);
      expect(result.backupOptedOut).toBeUndefined();
    });

    describe('no backup on record (never made, or deleted before deletions were recorded)', () => {
      function noneOnRecord() {
        arrange();
        makeRequestSpy.mockImplementation(async (method: string, path: string) => {
          if (path === '/identity/backup/status') return { exists: false };
          if (path.endsWith('/challenge')) {
            return { challenge: 'chal-1', expiresAt: '2999-01-01T00:00:00.000Z' };
          }
          if (path.endsWith('/complete')) {
            return { success: true, publicKey: NEW_PUBLIC, message: 'ok' };
          }
          throw new Error(`unexpected ${method} ${path}`);
        });
      }

      it('declining the backup shown before the swap uploads nothing and owes nothing', async () => {
        noneOnRecord();
        const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
        const seal = jest.spyOn(oxy.identity.backup, 'seal');
        const result = await oxy.identity.rotateKey({ proof: 'device', createBackup: false });
        expect(seal).not.toHaveBeenCalled();
        expect(mark).not.toHaveBeenCalled();
        expect(result.backupOptedOut).toBe(true);
      });

      it("accepting it creates one, sent as the person's opt-in, and is owed until sealed", async () => {
        noneOnRecord();
        const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
        const seal = jest
          .spyOn(oxy.identity.backup, 'seal')
          .mockResolvedValue({ exists: true } as never);
        const result = await oxy.identity.rotateKey({ proof: 'device', createBackup: true });
        // Oxy refuses an upload where the account has no backup row unless it
        // carries the person's opt-in, so their tick is sent as one.
        expect(seal).toHaveBeenCalledWith(pendingFixture.phrase, [], {
          replacesLookupId: undefined,
          optIn: true,
        });
        expect(mark).toHaveBeenCalledWith('user-123', { optIn: true });
        expect(result.backupRefreshed).toBe(true);
        expect(result.backupOptedOut).toBeUndefined();
      });

      it('without a choice it does not rotate: nothing is asked of the server, nothing is owed', async () => {
        // The screen could not show the choice (its own status read failed
        // while this one succeeded): never taken as "create".
        for (const platform of ['ios', 'web'] as const) {
          setPlatformOS(platform);
          noneOnRecord();
          const mark = jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
          const seal = jest.spyOn(oxy.identity.backup, 'seal');
          await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toThrow(
            'Choose whether to create an encrypted backup',
          );
          const paths = makeRequestSpy.mock.calls.map(([method, path]) => `${method} ${path}`);
          expect(paths).not.toContain('POST /auth/rotate/challenge');
          expect(paths).not.toContain('POST /auth/rotate/complete');
          expect(paths).not.toContain('POST /identity/backup');
          expect(seal).not.toHaveBeenCalled();
          expect(mark).not.toHaveBeenCalled();
          mark.mockRestore();
          seal.mockRestore();
        }
        setPlatformOS('ios');
      });
    });

    it('a person who HAS a backup cannot decline its re-seal: it keeps every key', async () => {
      arrange();
      const carried = [{ privateKey: 'aa'.repeat(32), publicKey: '04ab', retiredAt: 1 }];
      jest
        .spyOn(oxy.identity.backup, 'readBeforeRotation')
        .mockResolvedValue({ existed: true, carried, replacesLookupId: 'ef'.repeat(32) });
      jest.spyOn(KeyManager, 'markBackupOwed').mockResolvedValue();
      const seal = jest
        .spyOn(oxy.identity.backup, 'seal')
        .mockResolvedValue({ exists: true } as never);
      await oxy.identity.rotateKey({ proof: 'device', createBackup: false });
      expect(seal).toHaveBeenCalledTimes(1);
    });
  });

  describe('phrase proof (replace the LAST credential)', () => {
    it('refuses a phrase that is not the account’s CURRENT key, before anything changes (R6-10)', async () => {
      const other = await RecoveryPhraseService.derivePendingIdentity();
      makeRequestSpy.mockReset();
      await expect(
        oxy.identity.rotateKey({ proof: 'phrase', phrase: other.phrase }),
      ).rejects.toThrow('not the current key');
      expect(makeRequestSpy).not.toHaveBeenCalled();
      expect(mockRetire).not.toHaveBeenCalled();
    });

    it('re-derives the CURRENT key from the entered phrase and signs the proof with it', async () => {
      // A real "current" identity whose phrase the user re-enters, and a real new one.
      const current = await RecoveryPhraseService.derivePendingIdentity();
      const next = await RecoveryPhraseService.derivePendingIdentity();
      historySpy.mockResolvedValue({
        publicKey: KeyManager.canonicalPublicKey(current.publicKey).toLowerCase(),
        retired: [],
      });
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(next);
      jest.spyOn(KeyManager, 'importKeyPair').mockResolvedValue(next.publicKey);

      let completeBody: Record<string, unknown> | undefined;
      makeRequestSpy.mockImplementation((_m: string, path: string, body?: unknown) => {
        if (path === '/auth/rotate/challenge')
          return Promise.resolve({ challenge: 'chal-x', expiresAt: '2999-01-01T00:00:00.000Z' });
        if (path === '/auth/rotate/complete') {
          completeBody = body as Record<string, unknown>;
          return Promise.resolve({ success: true, publicKey: next.publicKey, message: 'ok' });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      });

      const result = await oxy.identity.rotateKey({ proof: 'phrase', phrase: current.phrase });
      expect(result.newPublicKey).toBe(next.publicKey);
      // The key the phrase derives is the one kept in the retired ring.
      expect(mockRetire).toHaveBeenCalledWith({
        privateKey: current.privateKey,
        publicKey: KeyManager.derivePublicKey(current.privateKey),
      });

      // The OLD-key signature MUST verify against the current key over the exact message.
      const message = JSON.stringify({
        action: 'rotate_key',
        userId: 'user-123',
        oldPublicKey: KeyManager.canonicalPublicKey(current.publicKey),
        newPublicKey: next.publicKey,
        challenge: 'chal-x',
        timestamp: completeBody?.timestamp,
      });
      expect(
        await protocol.verifySignature(
          message,
          completeBody?.signature as string,
          current.publicKey,
        ),
      ).toBe(true);
      // …and must NOT verify against the new key (proves it was signed by the current key).
      expect(
        await protocol.verifySignature(message, completeBody?.signature as string, next.publicKey),
      ).toBe(false);

      // The NEW-key proof-of-possession MUST verify against the NEW key.
      const newKeyMessage = JSON.stringify({
        action: 'rotate_key_new',
        userId: 'user-123',
        newPublicKey: next.publicKey,
        challenge: 'chal-x',
        timestamp: completeBody?.timestamp,
      });
      expect(
        await protocol.verifySignature(
          newKeyMessage,
          completeBody?.newKeyProof as string,
          next.publicKey,
        ),
      ).toBe(true);
      // …and must NOT verify against the old key (proves possession of the new key).
      expect(
        await protocol.verifySignature(
          newKeyMessage,
          completeBody?.newKeyProof as string,
          current.publicKey,
        ),
      ).toBe(false);
    });

    it('throws when proof is phrase but no phrase is supplied', async () => {
      jest.spyOn(RecoveryPhraseService, 'derivePendingIdentity').mockResolvedValue(pendingFixture);
      await expect(oxy.identity.rotateKey({ proof: 'phrase' })).rejects.toThrow(
        /recovery phrase is required/,
      );
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

      const result = await oxy.identity.rotateKey({ proof: 'device' });

      expect(result.newPublicKey).toBe(NEW_PUBLIC);
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        3,
        'GET',
        '/u/user-123/did.json',
        undefined,
        expect.objectContaining({ cache: false }),
      );
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

      await expect(oxy.identity.rotateKey({ proof: 'device' })).rejects.toBeDefined();
      expect(importSpy).not.toHaveBeenCalled();
    });
  });
});
