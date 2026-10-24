import { integerCheck, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';
import { stickerPackSlugSchema } from '@oxy.so/contracts';

const id = z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64));

export const stickerPackSlugParams = z.object({ slug: stickerPackSlugSchema });
export const stickerPackIdParams = z.object({ packId: id });
export const stickerIdParams = z.object({ stickerId: id });
export const stickerStickerParams = z.object({ packId: id, stickerId: id });

/** GET /stickers/packs and the staff listing. */
export const stickerPacksQuery = z.object({
  limit: z.coerce.number().check(integerCheck()).min(1).max(100).default(24),
  offset: z.coerce.number().check(integerCheck()).min(0).default(0),
});

/** GET /stickers/search — exactly one of the two terms. */
export const stickerSearchQuery = z
  .object({
    emoji: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(32)).optional(),
    q: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)).optional(),
    limit: z.coerce.number().check(integerCheck()).min(1).max(100).default(40),
  })
  .refine((query) => Boolean(query.emoji) !== Boolean(query.q), {
    message: 'Pass exactly one of "emoji" or "q"',
  });

/** A multipart text field holding a comma-separated list. */
const commaList = (maxItems: number, maxLength: number) =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .pipe(z.array(z.string().check(utf16MaxLength(maxLength))).max(maxItems));

/** The text fields beside a sticker upload. */
export const stickerAddFields = z.object({
  emoji: commaList(8, 32).pipe(z.array(z.string()).min(1, 'At least one emoji is required')),
  keywords: commaList(16, 32),
});
