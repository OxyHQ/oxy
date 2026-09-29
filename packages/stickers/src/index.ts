/**
 * @oxy.so/stickers — Oxy's shared sticker catalogue, for any app and any
 * backend.
 *
 * ```ts
 * import { createStickersClient } from '@oxy.so/stickers';
 *
 * const stickers = createStickersClient(oxyServices);
 * const found = await stickers.resolve([id]);   // backend: check before storing
 * const packs = await stickers.installedPacks(); // app: the person's picker
 * ```
 *
 * React hooks live in `@oxy.so/stickers/react`.
 *
 * Nothing here loads `@oxy.so/contracts` at runtime — only its types are
 * re-exported — so importing this does not evaluate zod. The schemas and
 * limits are in `@oxy.so/contracts` itself for whoever validates.
 */

export { createStickersClient } from './client';
export type { StickerPackPage, StickersClient, StickersTransport } from './client';
export { verifyStickerBytes, webCryptoSha256 } from './verify';
export type { Sha256Hex } from './verify';

export type {
  InstalledStickerPack,
  Sticker,
  StickerFile,
  StickerPack,
  StickerPackStatus,
  StickerPackSummary,
  StickerRef,
} from '@oxy.so/contracts';
