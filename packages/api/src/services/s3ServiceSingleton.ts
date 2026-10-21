/**
 * Shared S3Service singleton — Oxy Files' object store.
 *
 * Split out of `assetServiceSingleton` so that code needing OBJECT STORAGE does
 * not have to import the module that eagerly constructs `AssetService`.
 *
 * That is not a stylistic preference. `assetServiceSingleton` runs
 * `new AssetService(...)` at module-evaluation time, so importing it from
 * anything `assetService.ts` itself imports forms a cycle that resolves to
 * `AssetService === undefined` — the class declaration has not been reached yet
 * — and throws at boot. `queue/assetVariants.queue.ts` is exactly that: it is
 * imported BY `assetService.ts` and needs the storage client to run generation.
 * Keeping the client here gives it a dependency that owns no service.
 */

import { createS3Service, type S3Service } from './s3Service';
import { getCdnInvalidationQueue } from './cdnInvalidation';
import type { S3Config } from '../types/s3.types';

/**
 * Oxy Files lives in Cloudflare R2 (ADR 0047), reached through R2's S3 API with
 * a token scoped to its one bucket:
 *
 *   R2_ENDPOINT            https://<account id>.r2.cloudflarestorage.com
 *   R2_BUCKET              the bucket
 *   R2_ACCESS_KEY_ID       } the bucket's R2 API token (SSM /oxy/<app>/R2_*)
 *   R2_SECRET_ACCESS_KEY   }
 *
 * Its own names, never `AWS_ENDPOINT_URL` / `AWS_ACCESS_KEY_ID`: every AWS SDK
 * client in the process reads those, so they would send SES and STS calls to R2
 * with R2's keys. Local development points R2_ENDPOINT at a MinIO.
 */
export function objectStorageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const bucketName = env.R2_BUCKET?.trim() ?? '';
  const endpointUrl = env.R2_ENDPOINT?.trim() ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
  const missing = Object.entries({
    R2_BUCKET: bucketName,
    R2_ENDPOINT: endpointUrl,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  })
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Oxy Files' object store needs ${missing.join(', ')}`);
  }
  // R2 has one region; `auto` is what its S3 API expects.
  return { region: 'auto', endpointUrl, bucketName, accessKeyId, secretAccessKey };
}

/** The store configured from the environment, reporting deletes to `listener`. */
export function createObjectStorage(
  listener?: Parameters<typeof createS3Service>[1],
  env: NodeJS.ProcessEnv = process.env,
): S3Service {
  return createS3Service(objectStorageConfigFromEnv(env), listener);
}

// The bucket is the CDN's origin, so every delete here is also a cloud.oxy.so
// purge (a no-op with a warning while the purge is not configured).
export const s3Service = createObjectStorage(getCdnInvalidationQueue());
