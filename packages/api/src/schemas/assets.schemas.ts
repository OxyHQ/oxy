import { z } from 'zod';

// Params with :id
export const assetIdParams = z.object({
  id: z.string().trim().min(1),
});

// GET /assets (list)
export const listAssetsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

// GET /assets/:id/url
export const assetUrlQuerySchema = z.object({
  variant: z.string().optional(),
  expiresIn: z.string().regex(/^\d+$/).optional(),
});

// PATCH /assets/:id/visibility
export const updateVisibilitySchema = z.object({
  visibility: z.enum(['private', 'public', 'unlisted']),
});

// DELETE /assets/:id
export const deleteAssetQuerySchema = z.object({
  force: z.enum(['true', 'false']).optional(),
});

// Maximum number of per-file requests accepted by POST /assets/batch-access in
// a single call. A file-manager grid page is ~40 tiles; callers that page beyond
// this chunk client-side.
export const MAX_BATCH_ACCESS_FILES = 100;

// POST /assets/batch-access
//
// Per-file `{ fileId, variant? }` requests (variant omitted = original) so a
// grid can resolve each tile's own rendition (`thumb`/`poster`/…) in ONE round
// trip. Top-level `expiresIn` (seconds) sizes the minted media-token / signed-URL
// lifetime; `context` is the access-check context string (`app:entityType:entityId`,
// or a bare label like `file-manager` which carries no entity gate).
export const batchAccessSchema = z.object({
  files: z
    .array(
      z.object({
        fileId: z.string().trim().min(1),
        variant: z.string().trim().min(1).optional(),
      }),
    )
    .min(1, 'files must not be empty')
    .max(MAX_BATCH_ACCESS_FILES, `Cannot request more than ${MAX_BATCH_ACCESS_FILES} files at once`),
  expiresIn: z.number().int().positive().optional(),
  context: z.string().optional(),
});

// Maximum number of ids accepted by POST /assets/service/by-ids in a single
// request. Mirrors the POST /users/by-ids cap so a single service call can
// resolve all media of one post at once without unbounded fan-out.
export const MAX_ASSETS_BY_IDS = 100;

// POST /assets/service/by-ids
export const assetsByIdsBodySchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, 'ids must not be empty')
    .max(MAX_ASSETS_BY_IDS, `Cannot request more than ${MAX_ASSETS_BY_IDS} assets at once`),
});

// Maximum number of content hashes accepted by POST /assets/service/by-sha256
// in a single request. Mirrors MAX_ASSETS_BY_IDS so the reverse content-address
// lookup has the same per-call fan-out ceiling as the forward id lookup.
export const MAX_ASSETS_BY_SHA256 = 100;

// A lowercase hex SHA-256 digest: exactly 64 hex characters.
const sha256Hex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be a 64-character hex digest');

// POST /assets/service/by-sha256
export const assetsBySha256BodySchema = z.object({
  sha256s: z
    .array(sha256Hex)
    .min(1, 'sha256s must not be empty')
    .max(MAX_ASSETS_BY_SHA256, `Cannot request more than ${MAX_ASSETS_BY_SHA256} hashes at once`),
});

// POST /assets/:id/link — attach a file to an app entity.
export const linkFileSchema = z.object({
  app: z.string().min(1, 'App name is required'),
  entityType: z.string().min(1, 'Entity type is required'),
  entityId: z.string().min(1, 'Entity ID is required'),
  visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  webhookUrl: z.string().url().optional(),
});

// POST /assets/:id/unlink — detach a file from an app entity.
export const unlinkFileSchema = z.object({
  app: z.string().min(1, 'App name is required'),
  entityType: z.string().min(1, 'Entity type is required'),
  entityId: z.string().min(1, 'Entity ID is required'),
});
