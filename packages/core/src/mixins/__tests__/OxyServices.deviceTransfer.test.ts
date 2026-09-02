/**
 * Device-to-device identity transfer mixin tests (b3 Feature 2 — "add a device").
 *
 * Exercises the E2E crypto path THROUGH the mixins with two independent
 * OxyServices instances (old device + new device) wired to a shared in-memory
 * "relay" that never sees a decryption key:
 *   - ECDH symmetry: the old device seals with `ECDH(oldEphPriv, newEphPub)` and
 *     the new device opens with `ECDH(newEphPriv, oldEphPub)` — same transfer key.
 *   - full round-trip: the private key the old device holds is recovered and
 *     imported byte-for-byte on the new device.
 *   - tamper: a flipped ciphertext byte fails authentication (never imports).
 *
 * The socket is forced OFF (getSocketIO → null) so the deterministic poll path
 * drives the flow; KeyManager + SignatureService.sign are stubbed (the identity
 * key material and the approval signature are not the unit under test here — the
 * server-side signature verification is covered in the api service tests).
 */

jest.mock('../../session/socketLoader', () => ({
  getSocketIO: jest.fn(async () => null),
}));

import {
  deriveSecp256k1PublicKey,
  generateSecp256k1KeyPair,
} from '@oxyhq/protocol/secp256k1';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { SignatureService } from '../../crypto/signatureService';
import { deriveSharedSecret } from '../../crypto/ecdh';
import { hkdfSha256 } from '../../crypto/kdf';
import { encryptAead, decryptAead } from '../../crypto/aead';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/hashes/utils';
import type { DeviceTransferInfoResponse } from '@oxyhq/contracts';

/** A shared in-memory relay: a single pairing row, mirroring the API's shape. */
interface RelayState {
  pairingId: string;
  newDeviceEphemeralPublicKey: string;
  newDeviceLabel: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  oldDeviceEphemeralPublicKey: string | null;
  ciphertext: string | null;
  nonce: string | null;
}

function makeRelay() {
  const state: { row: RelayState | null } = { row: null };
  const infoDto = (): DeviceTransferInfoResponse => {
    const row = state.row!;
    const approved = row.status === 'approved';
    return {
      pairingId: row.pairingId,
      newDeviceEphemeralPublicKey: row.newDeviceEphemeralPublicKey,
      newDeviceLabel: row.newDeviceLabel,
      status: row.status,
      expiresAt: row.expiresAt,
      oldDeviceEphemeralPublicKey: approved ? row.oldDeviceEphemeralPublicKey : null,
      ciphertext: approved ? row.ciphertext : null,
      nonce: approved ? row.nonce : null,
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (method: string, url: string, data?: any): Promise<unknown> => {
    if (method === 'POST' && url === '/identity/device-transfer/init') {
      state.row = {
        pairingId: 'a'.repeat(32),
        newDeviceEphemeralPublicKey: data.newEphPub,
        newDeviceLabel: data.newDeviceLabel ?? null,
        status: 'pending',
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
        oldDeviceEphemeralPublicKey: null,
        ciphertext: null,
        nonce: null,
      };
      return Promise.resolve({ pairingId: state.row.pairingId, expiresAt: state.row.expiresAt });
    }
    if (method === 'GET' && url.startsWith('/identity/device-transfer/')) {
      return Promise.resolve(infoDto());
    }
    if (method === 'POST' && url.endsWith('/approve')) {
      state.row!.oldDeviceEphemeralPublicKey = data.oldEphPub;
      state.row!.ciphertext = data.ciphertext;
      state.row!.nonce = data.nonce;
      state.row!.status = 'approved';
      return Promise.resolve({ success: true, pairingId: state.row!.pairingId, status: 'approved' });
    }
    if (method === 'POST' && url.endsWith('/deny')) {
      state.row!.status = 'denied';
      return Promise.resolve({ success: true, pairingId: state.row!.pairingId, status: 'denied' });
    }
    return Promise.reject(new Error(`unexpected request ${method} ${url}`));
  };
  return { state, handle };
}

describe('OxyServices.deviceTransfer', () => {
  let identityPriv: string;
  let identityPub: string;
  let importedPrivateKey: string | null;

  beforeEach(() => {
    const idKey = generateSecp256k1KeyPair();
    identityPriv = idKey.privateKey;
    identityPub = idKey.publicKey;
    importedPrivateKey = null;

    // Old device HOLDS the identity; new device IMPORTS it. One KeyManager is
    // shared, but the two roles call disjoint methods (get* vs import).
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(identityPriv);
    jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(identityPub);
    jest.spyOn(KeyManager, 'importKeyPair').mockImplementation(async (priv: string) => {
      importedPrivateKey = priv;
      return deriveSecp256k1PublicKey(priv);
    });
    // The server (api service test) verifies the signature; here it is opaque.
    jest.spyOn(SignatureService, 'sign').mockResolvedValue('sig-hex');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clones the identity end-to-end (ECDH symmetry + full round-trip via the mixins)', async () => {
    const relay = makeRelay();
    const newDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    const oldDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    jest.spyOn(newDevice, 'makeRequest').mockImplementation(relay.handle as never);
    jest.spyOn(oldDevice, 'makeRequest').mockImplementation(relay.handle as never);

    // 1. New device registers a pairing (generates + stores its ephemeral key).
    const init = await newDevice.initDeviceTransfer('New iPhone');
    expect(init.pairingId).toHaveLength(32);
    expect(relay.state.row?.newDeviceEphemeralPublicKey).toBe(init.newEphemeralPublicKey);

    // 2. Old device resolves the QR handle and approves (seals the identity key).
    const approveResult = await oldDevice.approveDeviceTransfer(init.pairingId);
    expect(approveResult).toEqual({ success: true, pairingId: init.pairingId, status: 'approved' });
    // The relay stored ONLY ephemeral pubkeys + opaque ciphertext — never the key.
    expect(relay.state.row?.ciphertext).toBeTruthy();
    expect(relay.state.row?.ciphertext).not.toContain(identityPriv);

    // 3. New device awaits approval, decrypts, and imports the SAME private key.
    const outcome = await new Promise<{ status: string; publicKey?: string }>((resolve) => {
      newDevice.subscribeDeviceTransfer(init.pairingId, resolve);
    });

    expect(outcome).toEqual({ status: 'approved', publicKey: identityPub });
    // The recovered private key is byte-for-byte the old device's identity key.
    expect(importedPrivateKey).toBe(identityPriv);
    // Imported WITHOUT overwrite — a fresh device must never clobber an identity.
    expect(KeyManager.importKeyPair).toHaveBeenCalledWith(identityPriv, { overwrite: false });
  });

  it('reports a denied transfer to the subscriber without importing', async () => {
    const relay = makeRelay();
    const newDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    jest.spyOn(newDevice, 'makeRequest').mockImplementation(relay.handle as never);

    await newDevice.initDeviceTransfer();
    relay.state.row!.status = 'denied';

    const outcome = await new Promise<{ status: string }>((resolve) => {
      newDevice.subscribeDeviceTransfer(relay.state.row!.pairingId, resolve);
    });

    expect(outcome).toEqual({ status: 'denied' });
    expect(KeyManager.importKeyPair).not.toHaveBeenCalled();
  });

  it('throws if subscribing to a pairing this instance never initiated', () => {
    const newDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    expect(() => newDevice.subscribeDeviceTransfer('unknown-pair', () => {})).toThrow(
      /initDeviceTransfer first/i,
    );
  });

  it('refuses to approve a non-pending pairing', async () => {
    const relay = makeRelay();
    const newDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    const oldDevice = new OxyServices({ baseURL: 'http://relay.invalid' });
    jest.spyOn(newDevice, 'makeRequest').mockImplementation(relay.handle as never);
    jest.spyOn(oldDevice, 'makeRequest').mockImplementation(relay.handle as never);

    const init = await newDevice.initDeviceTransfer();
    relay.state.row!.status = 'denied';

    await expect(oldDevice.approveDeviceTransfer(init.pairingId)).rejects.toThrow(
      /can no longer be approved/i,
    );
  });
});

/**
 * The exact crypto derivation the mixin uses, pinned independently: two ephemeral
 * pairs agree on a symmetric key, seal/open a JSON key blob, and any tampering
 * with the ciphertext fails authentication.
 */
describe('device-transfer crypto derivation', () => {
  const HKDF_INFO = 'oxy-device-transfer-v1';
  const deriveTransferKey = (shared: Uint8Array, pairingId: string): Uint8Array =>
    hkdfSha256(shared, utf8ToBytes(pairingId), utf8ToBytes(HKDF_INFO), 32);

  it('is symmetric and round-trips the sealed identity key', () => {
    const pairingId = 'b'.repeat(32);
    const oldEph = generateSecp256k1KeyPair();
    const newEph = generateSecp256k1KeyPair();

    const sharedOld = deriveSharedSecret(oldEph.privateKey, newEph.publicKey);
    const sharedNew = deriveSharedSecret(newEph.privateKey, oldEph.publicKey);
    expect(bytesToHex(sharedOld)).toBe(bytesToHex(sharedNew));

    const keyOld = deriveTransferKey(sharedOld, pairingId);
    const keyNew = deriveTransferKey(sharedNew, pairingId);
    expect(bytesToHex(keyOld)).toBe(bytesToHex(keyNew));

    const identity = { privateKey: 'ff'.repeat(32), publicKey: '04' + 'ab'.repeat(64) };
    const { nonce, ciphertext } = encryptAead(keyOld, utf8ToBytes(JSON.stringify(identity)));

    const opened = JSON.parse(bytesToUtf8(decryptAead(keyNew, nonce, ciphertext)));
    expect(opened).toEqual(identity);
  });

  it('fails authentication when the ciphertext is tampered', () => {
    const pairingId = 'c'.repeat(32);
    const oldEph = generateSecp256k1KeyPair();
    const newEph = generateSecp256k1KeyPair();
    const key = deriveTransferKey(
      deriveSharedSecret(oldEph.privateKey, newEph.publicKey),
      pairingId,
    );
    const { nonce, ciphertext } = encryptAead(key, utf8ToBytes('{"privateKey":"deadbeef"}'));

    const tampered = Uint8Array.from(ciphertext);
    tampered[0] ^= 0x01; // flip one bit
    const keyNew = deriveTransferKey(
      deriveSharedSecret(newEph.privateKey, oldEph.publicKey),
      pairingId,
    );
    expect(() => decryptAead(keyNew, nonce, tampered)).toThrow();
    // And a wrong pairingId (wrong HKDF salt) also fails — binds to the pairing.
    const wrongSaltKey = deriveTransferKey(
      deriveSharedSecret(newEph.privateKey, oldEph.publicKey),
      'd'.repeat(32),
    );
    expect(() => decryptAead(wrongSaltKey, nonce, ciphertext)).toThrow();
  });

  it('re-derives from hex the way the wire transports the material', () => {
    const pairingId = 'e'.repeat(32);
    const oldEph = generateSecp256k1KeyPair();
    const newEph = generateSecp256k1KeyPair();
    const keyOld = deriveTransferKey(
      deriveSharedSecret(oldEph.privateKey, newEph.publicKey),
      pairingId,
    );
    const { nonce, ciphertext } = encryptAead(keyOld, utf8ToBytes('{"k":1}'));

    // Wire form: hex strings (exactly what the mixin sends/receives).
    const nonceHex = bytesToHex(nonce);
    const ciphertextHex = bytesToHex(ciphertext);

    const keyNew = deriveTransferKey(
      deriveSharedSecret(newEph.privateKey, oldEph.publicKey),
      pairingId,
    );
    const opened = bytesToUtf8(decryptAead(keyNew, hexToBytes(nonceHex), hexToBytes(ciphertextHex)));
    expect(opened).toBe('{"k":1}');
  });
});
