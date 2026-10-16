import { z } from 'zod';

// Params with :id
export const assetIdParams = z.object({
  id: z.string().trim().min(1),
});

// GET /assets (list)
export const listAssetsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  /** `false`: only files no application uses — *not in use* (ADR 0043 D5). */
  inUse: z.enum(['true', 'false']).optional(),
  /**
   * `trash`: only the files the owner moved to trash (ADR 0043 D5). Absent:
   * the library — `active` and `blocked` files, never trashed ones.
   */
  status: z.enum(['trash']).optional(),
});

// GET /assets/admin/lifecycle/sweeps
export const listLifecycleSweepsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
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
    .max(
      MAX_BATCH_ACCESS_FILES,
      `Cannot request more than ${MAX_BATCH_ACCESS_FILES} files at once`,
    ),
  expiresIn: z.number().int().positive().optional(),
  context: z.string().optional(),
});

// POST /assets/service/federation — 200 for a new row AND for an idempotent
// re-upload; `deduplicated` says which. A deduplicated id may already be
// referenced by other posts.
export const federatedMediaUploadResponse = z.object({
  data: z.object({
    file: z.object({
      id: z.string(),
      sha256: z.string(),
      size: z.number(),
      mime: z.string(),
      visibility: z.enum(['public', 'private', 'unlisted']),
    }),
    deduplicated: z.boolean(),
  }),
});

// Maximum number of ids accepted by POST /assets/service/federation/delete.
// A federated post carries a handful of media objects (a carousel of ten, each
// video adding a poster), so 20 covers a post in one call. The request only
// tombstones and records (the S3 purge drains in the background), so its time
// is bounded by 20 short transactions, far inside the ALB idle timeout; the
// per-app limiter counts the request, and 20 bounds what one request can do.
export const MAX_FEDERATED_ASSET_DELETE_IDS = 20;

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
 *  - `deleted`   — this call tombstoned the row; its storage (original,
 *                  variants, HLS segments) is recorded as owed and purged in the
 *                  background, durably, with a CDN invalidation.
 *  - `not_found` — no live row (unknown id, or already deleted): nothing to do,
 *                  and safe to treat as done. Deliberately a 200 result, not an
 *                  HTTP 404, so "already gone" can never be confused with a
 *                  missing route on an older API.
 *  - `in_use`    — this application's federated media, but another account holds
 *                  it (a link it created, a mail attachment, a store listing
 *                  screenshot): content-addressed dedup hands the one live row to
 *                  whoever uploads the same bytes. KEPT; treat as done, never
 *                  retry.
 *  - `forbidden` — the row is live but is not federation media uploaded by the
 *                  calling application; nothing was touched.
 */
export const federatedAssetDeleteResult = z.enum(['deleted', 'not_found', 'in_use', 'forbidden']);

const federatedAssetDeleteItem = z.object({
  id: z.string(),
  result: federatedAssetDeleteResult,
});

// DELETE /assets/service/federation/:id — a `forbidden` outcome is a 403 instead,
// so the 200 body only ever carries the three done results.
export const federatedAssetDeleteResponse = z.object({
  data: z.object({
    id: z.string(),
    result: z.enum(['deleted', 'not_found', 'in_use']),
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
  // Resolve each hash to THIS account's own live row (rows are per owner).
  // Omitted: the legacy answer, the oldest live row of any owner.
  ownerUserId: z.string().trim().min(1).max(64).optional(),
});

// POST /assets/:id/links — a signed-in owner records that an application uses
// their file (`file_references`, ADR 0043 D4). `app` names the application: its
// id, or one of the legacy strings in `utils/legacyFileLinkApplications.ts`; a
// session bound to one application is recorded as that application.
// `visibility`, when given, is an explicit change by the OWNER, never inferred.
// `webhookUrl` is deprecated (D9): accepted for old clients, ignored — file
// events go to the application's own endpoint now.
export const linkFileSchema = z.object({
  app: z.string().min(1, 'App name is required'),
  entityType: z.string().min(1, 'Entity type is required'),
  entityId: z.string().min(1, 'Entity ID is required'),
  visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  webhookUrl: z.string().url().optional(),
});

// DELETE /assets/:id/links — remove one application's use of a file.
export const unlinkFileSchema = z.object({
  app: z.string().min(1, 'App name is required'),
  entityType: z.string().min(1, 'Entity type is required'),
  entityId: z.string().min(1, 'Entity ID is required'),
});

// GET /assets/service/app — one page of the calling application's own files.
export const listApplicationFilesQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

/** References per `POST`/`DELETE /assets/service/references` call. */
export const MAX_SERVICE_REFERENCES = 100;

/**
 * One reference an application's service token adds or removes. There is no
 * application field: the application is the token's `appId`, so a body naming
 * one is refused (`strict`), never read.
 */
const serviceReferenceSchema = z
  .object({
    fileId: z.string().trim().min(1).max(64),
    entityType: z.string().trim().min(1).max(128),
    entityId: z.string().trim().min(1).max(256),
  })
  .strict();

// POST / DELETE /assets/service/references (ADR 0043 D4).
export const serviceReferencesBodySchema = z
  .object({
    references: z
      .array(serviceReferenceSchema)
      .min(1, 'references must not be empty')
      .max(
        MAX_SERVICE_REFERENCES,
        `Cannot send more than ${MAX_SERVICE_REFERENCES} references at once`,
      ),
  })
  .strict();

/** Pairs per `PUT /assets/service/references/reconcile/:sessionId` page (ADR 0043 D6). */
export const MAX_RECONCILE_PAGE_ITEMS = 1000;

// POST /assets/service/references/reconcile — begin an inventory of one entity type.
export const beginReconcileBodySchema = z
  .object({ entityType: z.string().trim().min(1).max(128) })
  .strict();

// PUT /assets/service/references/reconcile/:sessionId — one page of the inventory.
export const reconcilePageBodySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            fileId: z.string().trim().min(1).max(64),
            entityId: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .min(1, 'items must not be empty')
      .max(
        MAX_RECONCILE_PAGE_ITEMS,
        `Cannot send more than ${MAX_RECONCILE_PAGE_ITEMS} items in one page`,
      ),
  })
  .strict();

// POST /assets/service/references/reconcile/:sessionId/commit
export const commitReconcileBodySchema = z.object({ dryRun: z.boolean().optional() }).strict();

export const reconcileSessionParams = z.object({
  sessionId: z.string().trim().min(1).max(64),
});

/** Imports per `POST /assets/service/app/import/batch` call (ADR 0043 D7). */
export const MAX_IMPORT_BATCH_ITEMS = 50;

/** The reference an import registers for the calling application in the same request. */
const importReferenceSchema = z
  .object({
    entityType: z.string().trim().min(1).max(128),
    entityId: z.string().trim().min(1).max(256),
  })
  .strict();

/**
 * How an audio file's renditions are made (ADR 0043 stage 4c): EBU R128
 * loudness normalization of the HLS ladder and preview, and where the 30-second
 * preview starts. Stored as the file's server-owned `metadata.audioOptions`.
 */
export const audioOptionsSchema = z
  .object({
    normalizeLoudness: z.boolean().optional(),
    previewStartSeconds: z.number().finite().min(0).max(86_400).optional(),
  })
  .strict();

export type AudioOptions = z.infer<typeof audioOptionsSchema>;

const importItemShape = {
  sourceUrl: z.string().trim().min(1).max(2048),
  reference: importReferenceSchema.optional(),
  revalidate: z.boolean().optional(),
  audio: audioOptionsSchema.optional(),
};

// POST /assets/service/app/import — the calling application imports a file by
// URL and owns it. `visibility` is required, as on `POST /assets/service/app`.
export const appImportBodySchema = z
  .object({
    ...importItemShape,
    visibility: z.enum(['private', 'public', 'unlisted']),
  })
  .strict();

// POST /assets/service/app/import/batch — up to 50 of the above, each answered on its own.
export const appImportBatchBodySchema = z
  .object({
    items: z
      .array(appImportBodySchema)
      .min(1, 'items must not be empty')
      .max(MAX_IMPORT_BATCH_ITEMS, `Cannot import more than ${MAX_IMPORT_BATCH_ITEMS} at once`),
  })
  .strict();

// POST /assets/service/user-media/import — import into an ACCOUNT's files (the
// owner is `x-owner-user-id`, as on `/service/user-media`). Public by default,
// like the user-media upload.
export const userMediaImportBodySchema = z
  .object({
    ...importItemShape,
    visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Large uploads (ADR 0043 stage 4b): a resumable S3 multipart upload of any
// type, up to 8 GiB, opened by an application's service token.
// ---------------------------------------------------------------------------

/** Part URLs one call hands out (`init` and `POST …/:uploadId/parts`). */
export const MAX_UPLOAD_PART_URLS_PER_CALL = 100;

const largeUploadShape = {
  // The content's identity: hex, lowercased (verified against the assembled object).
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hexadecimal characters')
    .transform((value) => value.toLowerCase()),
  size: z.number().int().positive(),
  mime: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
  reference: importReferenceSchema.optional(),
  audio: audioOptionsSchema.optional(),
};

// POST /assets/service/app/uploads — the calling application will own the file.
export const appLargeUploadBodySchema = z
  .object({ ...largeUploadShape, visibility: z.enum(['private', 'public', 'unlisted']) })
  .strict();

// POST /assets/service/user-media/uploads — an account will own it (x-owner-user-id).
export const userMediaLargeUploadBodySchema = z
  .object({
    ...largeUploadShape,
    visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  })
  .strict();

export const largeUploadParams = z.object({
  uploadId: z.string().trim().min(1).max(64),
});

// POST …/uploads/:uploadId/parts — presigned URLs for these parts.
export const largeUploadPartsBodySchema = z
  .object({
    partNumbers: z
      .array(z.number().int().min(1).max(10_000))
      .min(1)
      .max(MAX_UPLOAD_PART_URLS_PER_CALL),
  })
  .strict();

// POST /assets/service/app/adopt — the calling application takes ownership of a
// copy of a file it can read, sharing the stored bytes.
export const appAdoptBodySchema = z
  .object({
    fileId: z.string().trim().min(1).max(64),
    visibility: z.enum(['private', 'public', 'unlisted']),
    reference: importReferenceSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Stage 4c: consent, play sessions, recording targets, large imports.
// ---------------------------------------------------------------------------

// DELETE /assets/:id/access/:applicationId — the owner revokes an application's access.
export const fileAccessParams = z.object({
  id: z.string().trim().min(1).max(64),
  applicationId: z.string().trim().min(1).max(64),
});

// POST /assets/service/streams — open a play session over a file's HLS ladder.
export const playSessionBodySchema = z
  .object({
    fileId: z.string().trim().min(1).max(64),
    endUserId: z.string().trim().min(1).max(64).optional(),
    ttlSeconds: z.number().int().min(60).max(43_200).optional(),
    encryption: z.enum(['aes-128', 'none']).optional(),
    keyAuthorization: z.enum(['none', 'webhook']).optional(),
  })
  .strict();

export const playSessionParams = z.object({
  sessionId: z.string().trim().uuid(),
});

// POST /assets/service/streams/revoke — every live session for a file and/or an end user.
export const revokePlaySessionsBodySchema = z
  .object({
    fileId: z.string().trim().min(1).max(64).optional(),
    endUserId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((body) => body.fileId !== undefined || body.endUserId !== undefined, {
    message: 'Name a fileId, an endUserId, or both',
  });

// GET /assets/streams/:token/:name — a session's playlist, segment, key, preview or waveform.
export const streamObjectParams = z.object({
  token: z.string().min(1).max(200),
  name: z.string().min(1).max(128),
});

const recordingTargetShape = {
  filename: z.string().trim().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
  reference: importReferenceSchema.optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 ** 3)
    .optional(),
  expiresInSeconds: z.number().int().min(60).max(604_800).optional(),
  audio: audioOptionsSchema.optional(),
};

// POST /assets/service/app/recording-targets — the calling application will own the recording.
export const appRecordingTargetBodySchema = z
  .object({ ...recordingTargetShape, visibility: z.enum(['private', 'public', 'unlisted']) })
  .strict();

// POST /assets/service/user-media/recording-targets — an account will own it (x-owner-user-id).
export const userMediaRecordingTargetBodySchema = z
  .object({
    ...recordingTargetShape,
    visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  })
  .strict();

export const recordingTargetParams = z.object({
  targetId: z.string().trim().uuid(),
});

export const ingestImportParams = z.object({
  importId: z.string().trim().uuid(),
});
