/**
 * The shared ingest and import services (ADR 0043 stage 4c): the routes and
 * the upload worker use ONE instance of each over the shared AssetService and
 * S3 client.
 */

import { assetService } from './assetServiceSingleton';
import { FileImportService } from './fileImport.service';
import { FileIngestService } from './fileIngest.service';
import { s3Service } from './s3ServiceSingleton';

export const fileIngestService = new FileIngestService(assetService, s3Service);
export const fileImportService = new FileImportService(assetService, fileIngestService);
