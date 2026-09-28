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
 */

export { createStickersClient } from './client';
export type { StickerPackPage, StickersClient, StickersTransport } from './client';
export { verifyStickerBytes, webCryptoSha256 } from './verify';
export type { Sha256Hex } from './verify';

export {
  STICKER_CANVAS_SIZES,
  STICKER_FALLBACK_SIZE,
  STICKER_MAX_DURATION_MS,
  stickerRefSchema,
  stickerSchema,
} from '@oxy.so/contracts';
export type {
  InstalledStickerPack,
  Sticker,
  StickerFile,
  StickerPack,
  StickerPackStatus,
  StickerPackSummary,
  StickerRef,
} from '@oxy.so/contracts';
