/**
 * Checking that the bytes fetched for a sticker are the ones its sender saw.
 *
 * A sticker reference carries the SHA-256 of its animation. In an end-to-end
 * encrypted chat the server relaying the message never sees it, so the
 * receiver is the only party that can check the CDN served what the sender
 * meant; this is that check.
 *
 * Web and Node have WebCrypto. React Native does not ship `crypto.subtle`, so
 * an app there passes the SHA-256 it already has (Allo's crypto engine, or
 * `expo-crypto`).
 */

import type { StickerRef } from '@oxy.so/contracts';

export type Sha256Hex = (bytes: Uint8Array) => Promise<string>;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 through WebCrypto, where the platform has it. */
export const webCryptoSha256: Sha256Hex = async (bytes) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle is unavailable here; pass a sha256 implementation to verifyStickerBytes');
  }
  const copy = new Uint8Array(bytes);
  return toHex(await subtle.digest('SHA-256', copy.buffer));
};

/** Whether `bytes` are exactly the animation `ref` names. */
export async function verifyStickerBytes(
  ref: Pick<StickerRef, 'sha256'>,
  bytes: Uint8Array,
  sha256: Sha256Hex = webCryptoSha256
): Promise<boolean> {
  return (await sha256(bytes)) === ref.sha256;
}
