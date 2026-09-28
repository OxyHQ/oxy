/**
 * Stickers — the wire shape of Oxy's shared sticker catalogue.
 *
 * One catalogue serves every app: Allo sends a sticker in a chat, Mention draws
 * one in an empty state, and both resolve the same id to the same animation.
 * The API validates its output against these schemas and `@oxy.so/stickers`
 * validates its input against the same ones.
 *
 * A sticker is a Lottie animation plus a static fallback image, both served
 * from Oxy's CDN at content-addressed, immutable URLs. The fallback is what a
 * surface that cannot animate shows — a push notification, a federated copy of
 * a post, a person who asked for reduced motion.
 *
 * Platform-agnostic — zod only. ESM-safe (no `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Limits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The square canvases a sticker may be authored at. Lottie is vectors, so the
 * canvas is a coordinate space rather than a resolution: a 1024 file draws as
 * sharply in a 128-point bubble as a 512 one.
 */
export const STICKER_CANVAS_SIZES = [512, 1024] as const;
/** Size of the static fallback image every sticker gets. */
export const STICKER_FALLBACK_SIZE = 512;
/** Longest loop a sticker may have. */
export const STICKER_MAX_DURATION_MS = 10_000;
/** Highest frame rate a sticker may declare. */
export const STICKER_MAX_FRAME_RATE = 60;
/**
 * Largest Lottie JSON accepted on upload, before the API normalizes it.
 * Exported animations carry pretty-printing and full float precision, so the
 * raw file is routinely many times the size of what is stored.
 */
export const STICKER_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/**
 * Largest animation STORED, after normalization (minified, floats rounded,
 * expressions removed). The CDN compresses JSON in transit, which takes a
 * typical sticker to a few tens of kilobytes on the wire.
 */
export const STICKER_MAX_ANIMATION_BYTES = 1024 * 1024;
/** Largest static fallback accepted on upload, when one is supplied. */
export const STICKER_MAX_FALLBACK_BYTES = 256 * 1024;
/** How many stickers one pack may hold. */
export const STICKER_PACK_MAX_STICKERS = 120;
/** How many packs one person may have installed. */
export const STICKER_MAX_INSTALLED_PACKS = 200;
/** How many ids one resolve call may ask about. */
export const STICKER_RESOLVE_MAX_IDS = 100;

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

/** Lowercase-hex SHA-256 of a file's bytes. */
export const stickerSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters');

/** A pack's public URL segment. */
export const stickerPackSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words joined by hyphens');

export const stickerIdSchema = z.string().min(1).max(64);

export const stickerPackStatusSchema = z.enum(['draft', 'published', 'archived']);
export type StickerPackStatus = z.infer<typeof stickerPackStatusSchema>;

/** One stored file: where to fetch it and the hash its bytes must have. */
export const stickerFileSchema = z.object({
  url: z.string().url(),
  sha256: stickerSha256Schema,
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type StickerFile = z.infer<typeof stickerFileSchema>;

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                 */
/* -------------------------------------------------------------------------- */

export const stickerSchema = z.object({
  id: stickerIdSchema,
  packId: z.string(),
  emoji: z.array(z.string()).min(1),
  keywords: z.array(z.string()),
  size: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  /** The Lottie JSON. */
  animation: stickerFileSchema,
  /** A static image of the same sticker. */
  fallback: stickerFileSchema,
});
export type Sticker = z.infer<typeof stickerSchema>;

/** What a shop card needs. */
export const stickerPackSummarySchema = z.object({
  id: z.string(),
  slug: stickerPackSlugSchema,
  title: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  status: stickerPackStatusSchema,
  publishedAt: z.string().nullable(),
  stickerCount: z.number().int().nonnegative(),
  /** The first sticker, drawn as the pack's cover. Null for an empty draft. */
  cover: stickerSchema.nullable(),
});
export type StickerPackSummary = z.infer<typeof stickerPackSummarySchema>;

export const stickerPackSchema = stickerPackSummarySchema.extend({
  stickers: z.array(stickerSchema),
});
export type StickerPack = z.infer<typeof stickerPackSchema>;

/** A pack in someone's picker. */
export const installedStickerPackSchema = stickerPackSchema.extend({
  installedAt: z.string(),
});
export type InstalledStickerPack = z.infer<typeof installedStickerPackSchema>;

/* -------------------------------------------------------------------------- */
/*  References                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How an app stores or sends a sticker: its id, the pack it came from, and the
 * hash of the animation it showed. The hash lets a receiver verify the bytes it
 * fetched are the ones the sender saw — which matters in an end-to-end
 * encrypted chat, where the server relaying the message never sees it.
 */
export const stickerRefSchema = z.object({
  stickerId: stickerIdSchema,
  packId: z.string().min(1).max(64),
  sha256: stickerSha256Schema,
});
export type StickerRef = z.infer<typeof stickerRefSchema>;

/* -------------------------------------------------------------------------- */
/*  Requests                                                                  */
/* -------------------------------------------------------------------------- */

/** POST /stickers/resolve */
export const resolveStickersRequestSchema = z.object({
  ids: z.array(stickerIdSchema).min(1).max(STICKER_RESOLVE_MAX_IDS),
});
export type ResolveStickersRequest = z.infer<typeof resolveStickersRequestSchema>;

/** Unknown ids are absent, not errors: a caller checks what came back. */
export const resolveStickersResponseSchema = z.object({
  stickers: z.array(stickerSchema),
});
export type ResolveStickersResponse = z.infer<typeof resolveStickersResponseSchema>;

/** PATCH /stickers/me/packs/order — the installed pack ids, first to last. */
export const reorderStickerPacksRequestSchema = z.object({
  packIds: z.array(z.string().min(1).max(64)).max(STICKER_MAX_INSTALLED_PACKS),
});
export type ReorderStickerPacksRequest = z.infer<typeof reorderStickerPacksRequestSchema>;

/** POST /stickers/admin/packs */
export const createStickerPackRequestSchema = z.object({
  slug: stickerPackSlugSchema,
  title: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).nullish(),
  author: z.string().trim().max(64).nullish(),
});
export type CreateStickerPackRequest = z.infer<typeof createStickerPackRequestSchema>;

/** PATCH /stickers/admin/packs/:packId */
export const updateStickerPackRequestSchema = createStickerPackRequestSchema
  .omit({ slug: true })
  .partial();
export type UpdateStickerPackRequest = z.infer<typeof updateStickerPackRequestSchema>;
