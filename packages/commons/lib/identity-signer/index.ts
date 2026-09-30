import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { KeyManager, type IdentitySignerStore } from '@oxy.so/core/crypto';

/**
 * The identity signer store: the copy of the identity key Commons' identity
 * host signs with on Android (OxyHQ/oxy#1388).
 *
 * Oxy Android apps do not share a UID, and Commons is the only one that holds
 * the identity private key. Its identity host (`modules/oxy-identity-host`, a
 * signature-protected ContentProvider) answers the other Oxy apps with the
 * public key, challenge proofs and scoped derivations — never the key. The
 * provider runs natively and cannot read expo-secure-store, so it signs with
 * this native copy, which `KeyManager` keeps in step with the primary identity.
 * Nothing ever returns it over IPC; `read` here is Commons' own recovery rung.
 */

/** The native half: `modules/oxy-identity-host` (`OxyIdentitySigner`). */
interface OxyIdentitySignerNative {
  read(): Promise<{ privateKey?: unknown; publicKey?: unknown } | null>;
  write(privateKey: string, publicKey: string): Promise<boolean>;
  clear(): Promise<void>;
}

function loadNative(): OxyIdentitySignerNative | null {
  if (Platform.OS !== 'android') return null;
  const native = requireOptionalNativeModule<OxyIdentitySignerNative>('OxyIdentitySigner');
  if (!native || typeof native.read !== 'function' || typeof native.write !== 'function') return null;
  return native;
}

/** The signer store, or `null` off Android and on binaries built without it. */
export function createIdentitySignerStore(): IdentitySignerStore | null {
  const native = loadNative();
  if (!native) return null;
  return {
    name: 'android-identity-signer',
    read: async () => {
      const pair = await native.read();
      const privateKey = pair?.privateKey;
      const publicKey = pair?.publicKey;
      return typeof privateKey === 'string' && typeof publicKey === 'string' ? { privateKey, publicKey } : null;
    },
    write: (privateKey, publicKey) => native.write(privateKey, publicKey),
    clear: () => native.clear(),
  };
}

let installed = false;

/**
 * Register the signer store with `KeyManager`. Call once, at module scope of
 * the root layout, before the first identity read, next to the device backup.
 * Commons is the only app that does this.
 */
export function installIdentitySigner(): void {
  if (installed) return;
  installed = true;
  KeyManager.setIdentitySignerStore(createIdentitySignerStore());
}
