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

export interface ObjectStorageConfig {
  /** Where every object is written and read. */
  primary: S3Config;
  /**
   * The store being migrated from, while a migration is in progress: deletes
   * are repeated there, listings include it, and a copy takes a source not yet
   * migrated from it. Never written.
   */
  legacy?: S3Config;
}

/**
 * Oxy Files lives in Cloudflare R2 (ADR 0047), reached through R2's S3 API with
 * a token scoped to its one bucket:
 *
 *   R2_ENDPOINT            https://<account id>.r2.cloudflarestorage.com
 *   R2_BUCKET              the bucket
 *   R2_ACCESS_KEY_ID       } the bucket's R2 API token (SSM /oxy/<app>/R2_*)
 *   R2_SECRET_ACCESS_KEY   }
 *
 * `AWS_S3_BUCKET` names the S3 bucket the files are migrating FROM; with R2
 * configured it is only the legacy store above, reached with the task role.
 * Without `R2_BUCKET` it is still the primary store — the state before the
 * cutover, and nothing else. Its own names, never `AWS_ENDPOINT_URL` /
 * `AWS_ACCESS_KEY_ID`: every AWS SDK client in the process reads those, so they
 * would send SES, STS and CloudFront calls to R2 with R2's keys.
 */
export function objectStorageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig {
  const awsBucket = env.AWS_S3_BUCKET?.trim() || '';
  const aws: S3Config = {
    region: env.AWS_REGION || 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    bucketName: awsBucket,
    endpointUrl: env.AWS_ENDPOINT_URL,
  };
  const r2Bucket = env.R2_BUCKET?.trim();
  if (!r2Bucket) return { primary: aws };

  const endpointUrl = env.R2_ENDPOINT?.trim() ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
  const missing = Object.entries({
    R2_ENDPOINT: endpointUrl,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  })
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `R2_BUCKET is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not`,
    );
  }
  return {
    // R2 has one region; `auto` is what its S3 API expects.
    primary: { region: 'auto', endpointUrl, bucketName: r2Bucket, accessKeyId, secretAccessKey },
    ...(awsBucket ? { legacy: aws } : {}),
  };
}

/** A store configured from the environment, reporting deletes to `listener`. */
export function createObjectStorage(
  listener?: Parameters<typeof createS3Service>[1],
  env: NodeJS.ProcessEnv = process.env,
): S3Service {
  const { primary, legacy } = objectStorageConfigFromEnv(env);
  return createS3Service(primary, listener, legacy ? createS3Service(legacy) : undefined);
}

// The media bucket is the CDN's origin, so every delete here is also a CDN
// purge (a no-op with a warning while the CDN is not configured — see
// cdnInvalidation.ts).
export const s3Service = createObjectStorage(getCdnInvalidationQueue());
