/**
 * Shared AssetService singleton.
 *
 * AssetService wraps S3Service + the File model and is the canonical surface
 * for any code that needs to reference user-owned files (email attachments,
 * profile media, Mention posts, etc.). Constructing a new instance per
 * request would cause repeated S3 client setup and defeat the in-memory
 * fileCache used by AssetService.getFile. Instead, every consumer imports
 * this shared instance.
 *
 * The S3 client itself lives in `s3ServiceSingleton`. Importing THIS module
 * constructs an AssetService, which anything inside `assetService.ts`'s own
 * import graph cannot do without forming a cycle — so storage-only consumers
 * import that module instead.
 */

import { AssetService } from './assetService';
import { s3Service } from './s3ServiceSingleton';

export const assetService = new AssetService(s3Service);
