/**
 * The shared large-upload service (ADR 0041 stage 4b): the routes and the
 * worker use ONE instance over the shared AssetService and S3 client.
 */

import { assetService } from './assetServiceSingleton';
import { FileUploadSessionService } from './fileUploadSession.service';
import { s3Service } from './s3ServiceSingleton';

export const fileUploadSessionService = new FileUploadSessionService(assetService, s3Service);
