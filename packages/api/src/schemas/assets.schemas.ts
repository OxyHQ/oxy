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

// Maximum number of ids accepted by POST /assets/service/federation/delete.
// One federated post carries at most a few dozen media objects (each video adds
// a poster), so 50 covers a post — or a small reconcile batch — in one call,
// while keeping one request's S3 fan-out bounded.
export const MAX_FEDERATED_ASSET_DELETE_IDS = 50;

// POST /assets/service/federation/delete
export const federatedAssetDeleteBodySchema = z
  .object({
    ids: z
      .array(z.string().trim().min(1).max(128))
      .min(1, 'ids must not be empty')
      .max(
        MAX_FEDERATED_ASSET_DELETE_IDS,
        `Cannot delete more than ${MAX_FEDERATED_ASSET_DELETE_IDS} assets at once`,
      ),
  })
  .strict();

/**
 * Per-id outcome of a federated media delete.
 *  - `deleted`   — this call tombstoned the row and purged its S3 objects.
 *  - `not_found` — no live row (unknown id, or already deleted): nothing to do,
 *                  and safe to treat as done. Deliberately a 200 result, not an
 *                  HTTP 404, so "already gone" can never be confused with a
 *                  missing route on an older API.
 *  - `forbidden` — the row is live but is not federation media uploaded by the
 *                  calling application; nothing was touched.
 */
export const federatedAssetDeleteResult = z.enum(['deleted', 'not_found', 'forbidden']);

const federatedAssetDeleteItem = z.object({
  id: z.string(),
  result: federatedAssetDeleteResult,
});

// DELETE /assets/service/federation/:id — a `forbidden` outcome is a 403 instead,
// so the 200 body only ever carries the two success-ish results.
export const federatedAssetDeleteResponse = z.object({
  data: z.object({
    id: z.string(),
    result: z.enum(['deleted', 'not_found']),
  }),
});

// POST /assets/service/federation/delete — always 200; one result per distinct id.
export const federatedAssetBatchDeleteResponse = z.object({
  data: z.object({
    results: z.array(federatedAssetDeleteItem),
  }),
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

// Maximum number of ids accepted by POST /assets/service/linked-url.
//
// A QUARTER of MAX_ASSETS_BY_IDS, and the asymmetry is the point: that route
// returns a few hundred bytes of metadata per id, this one returns a bearer
// credential for the file's CONTENT. The workload it is sized for is "every file
// of one deliverable" — an asset version is a handful of files (a mesh, a couple
// of previews, a licence PDF), not a page of search results — so a caller that
// wants 26 URLs at once is not doing that, and the cheaper metadata route
// already answers any question about a larger set.
export const MAX_ASSETS_LINKED_URL = 25;

// POST /assets/service/linked-url
export const assetsLinkedUrlBodySchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, 'ids must not be empty')
    .max(
      MAX_ASSETS_LINKED_URL,
      `Cannot request more than ${MAX_ASSETS_LINKED_URL} download URLs at once`,
    ),
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
