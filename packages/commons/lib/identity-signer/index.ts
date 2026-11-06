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
  /** Organization keys (ADR 0061 D6); absent on a binary built before them. */
  readOrganization?(
    accountId: string,
  ): Promise<{ privateKey?: unknown; publicKey?: unknown } | null>;
  writeOrganization?(accountId: string, privateKey: string, publicKey: string): Promise<boolean>;
  clearOrganization?(accountId: string): Promise<void>;
  /**
   * The retired key ring (scope `'personal'` or an organization account id);
   * absent on a binary built before it.
   */
  readRetired?(
    scope: string,
    publicKey: string,
  ): Promise<{ privateKey?: unknown; publicKey?: unknown } | null>;
  writeRetired?(scope: string, privateKey: string, publicKey: string): Promise<boolean>;
  listRetired?(scope: string): Promise<unknown>;
  clearRetired?(scope: string, publicKey: string): Promise<void>;
}

function pairOf(
  value: { privateKey?: unknown; publicKey?: unknown } | null,
): { privateKey: string; publicKey: string } | null {
  const privateKey = value?.privateKey;
  const publicKey = value?.publicKey;
  return typeof privateKey === 'string' && typeof publicKey === 'string'
    ? { privateKey, publicKey }
    : null;
}

/** The ring's public keys as the native side listed them; anything not a string is dropped. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function loadNative(): OxyIdentitySignerNative | null {
  if (Platform.OS !== 'android') return null;
  const native = requireOptionalNativeModule<OxyIdentitySignerNative>('OxyIdentitySigner');
  if (!native || typeof native.read !== 'function' || typeof native.write !== 'function')
    return null;
  return native;
}

/** The signer store, or `null` off Android and on binaries built without it. */
export function createIdentitySignerStore(): IdentitySignerStore | null {
  const native = loadNative();
  if (!native) return null;
  const { readOrganization, writeOrganization, clearOrganization } = native;
  const { readRetired, writeRetired, listRetired, clearRetired } = native;
  return {
    name: 'android-identity-signer',
    read: async () => pairOf(await native.read()),
    write: (privateKey, publicKey) => native.write(privateKey, publicKey),
    clear: () => native.clear(),
    // Organization keys only when this binary's native module carries them;
    // without them `storeOrganizationKey` refuses rather than half-storing.
    ...(typeof readOrganization === 'function' &&
    typeof writeOrganization === 'function' &&
    typeof clearOrganization === 'function'
      ? {
          readOrganization: async (accountId: string) =>
            pairOf(await readOrganization.call(native, accountId)),
          writeOrganization: (accountId: string, privateKey: string, publicKey: string) =>
            writeOrganization.call(native, accountId, privateKey, publicKey),
          clearOrganization: (accountId: string) => clearOrganization.call(native, accountId),
        }
      : {}),
    // The retired ring likewise only when this binary carries all four;
    // without them `retireIdentityKey` refuses on Android rather than keep a
    // key the identity host could never spend.
    ...(typeof readRetired === 'function' &&
    typeof writeRetired === 'function' &&
    typeof listRetired === 'function' &&
    typeof clearRetired === 'function'
      ? {
          readRetired: async (scope: string, publicKey: string) =>
            pairOf(await readRetired.call(native, scope, publicKey)),
          writeRetired: (scope: string, privateKey: string, publicKey: string) =>
            writeRetired.call(native, scope, privateKey, publicKey),
          listRetired: async (scope: string) => stringsOf(await listRetired.call(native, scope)),
          clearRetired: (scope: string, publicKey: string) =>
            clearRetired.call(native, scope, publicKey),
        }
      : {}),
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
