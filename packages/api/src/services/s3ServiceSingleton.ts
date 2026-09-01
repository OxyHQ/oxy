/**
 * Shared S3Service singleton.
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

import { createS3Service } from './s3Service';

export const s3Service = createS3Service({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  bucketName: process.env.AWS_S3_BUCKET || '',
  endpointUrl: process.env.AWS_ENDPOINT_URL,
});
