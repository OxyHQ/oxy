/**
 * An incremental SHA-256 over content too large to hold at once — what
 * `oxy.assets.uploadLarge` addresses a file by before it asks for an upload URL.
 *
 * Here, behind `@oxy.so/core/crypto`, rather than imported by `api/assets.ts`
 * directly: `@noble/hashes` must load after this entry's polyfill, and through
 * the ONE lazy root, so it never lands in an app's startup JavaScript.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export interface ContentHasher {
  update(chunk: Uint8Array): void;
  /** Lowercase hex. Call once. */
  digestHex(): string;
}

export function createContentHasher(): ContentHasher {
  const hash = sha256.create();
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digestHex: () => bytesToHex(hash.digest()),
  };
}
