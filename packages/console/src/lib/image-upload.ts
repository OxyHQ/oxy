import type { OxyServices } from '@oxyhq/core';

/**
 * Shared image-upload helpers for Console logo / avatar widgets.
 *
 * Upload mechanism (Google-Cloud-Console style — upload only, no URL paste):
 *  1. `oxyServices.uploadRawFile(file, 'public')` uploads the raw `File`.
 *  2. The upload response is `{ file: { id, mime, size, ... } }` — the id is at
 *     `response.file.id`. The response does NOT contain a ready URL.
 *  3. We derive a public, directly-renderable URL with the synchronous helper
 *     `oxyServices.getFileDownloadUrl(id)`, which for a public asset returns the
 *     clean CDN URL (`${cloudURL}/<id>`). That URL is token-free by construction
 *     — core never embeds the caller's bearer token in a download URL (#317) —
 *     so persisted logo/avatar metadata cannot disclose a user's access token.
 */

/** Allowed image MIME types for logo / avatar uploads. */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
] as const;

/** Maximum upload size: 2 MB. */
export const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Human-readable max size, used in validation messages. */
export const MAX_IMAGE_UPLOAD_LABEL = '2 MB';

/** Visibility used for uploaded logos/avatars — public so they render unauthenticated. */
const PUBLIC_VISIBILITY = 'public' as const;

const SENSITIVE_URL_QUERY_PARAMS = new Set(['token', 'access_token', 'authorization', 'mt']);

/**
 * Strip credentials from URLs before persisting image metadata.
 *
 * Returns non-URL strings unchanged so callers can still clear fields with an
 * empty string or preserve future asset-id based formats.
 */
export function stripSensitiveImageUrlQueryParams(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  try {
    const url = new URL(trimmed);
    for (const param of SENSITIVE_URL_QUERY_PARAMS) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** Shape of the `uploadRawFile` response that we depend on. */
interface RawFileUploadResponse {
  file: { id: string };
}

function isRawFileUploadResponse(value: unknown): value is RawFileUploadResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const file = (value as { file?: unknown }).file;
  if (!file || typeof file !== 'object') {
    return false;
  }
  return typeof (file as { id?: unknown }).id === 'string';
}

/** Result of validating a candidate image file before upload. */
export type ImageValidationResult = { ok: true } | { ok: false; message: string };

/**
 * Validate a candidate image file against the allowed MIME types and size cap.
 * Returns a discriminated result so callers can surface the precise message.
 */
export function validateImageFile(file: File): ImageValidationResult {
  const isAllowedType = (ALLOWED_IMAGE_MIME_TYPES as ReadonlyArray<string>).includes(file.type);
  if (!isAllowedType) {
    return {
      ok: false,
      message: 'Unsupported image type. Use PNG, JPEG, SVG, or WebP.',
    };
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `Image is too large. The maximum size is ${MAX_IMAGE_UPLOAD_LABEL}.`,
    };
  }
  return { ok: true };
}

/**
 * Upload a public image and return a directly-renderable URL string.
 *
 * @throws when the upload fails or the response is missing a file id.
 */
export async function uploadPublicImage(
  oxyServices: OxyServices,
  file: File
): Promise<string> {
  const fileId = await uploadPublicImageFileId(oxyServices, file);
  return stripSensitiveImageUrlQueryParams(oxyServices.getFileDownloadUrl(fileId));
}

/**
 * Upload a public image and return the FILE ID.
 *
 * The logo widgets store a URL because that is what the Application record
 * holds; a store screenshot stores the id, because `app_listing_screenshots`
 * carries a real foreign key to `files` — which is what stops a purged asset
 * leaving a hole on a published page. Both go through this one upload so the
 * two surfaces cannot drift on visibility or validation.
 *
 * @throws when the upload fails or the response is missing a file id.
 */
export async function uploadPublicImageFileId(
  oxyServices: OxyServices,
  file: File
): Promise<string> {
  const response = await oxyServices.uploadRawFile(file, PUBLIC_VISIBILITY);
  if (!isRawFileUploadResponse(response)) {
    throw new Error('Upload did not return a file id');
  }
  return response.file.id;
}

/** Resolve a stored file id (or absolute URL) to a renderable image URL. */
export function resolveStoredImageUrl(
  oxyServices: OxyServices,
  fileId: string | undefined | null,
  variant: 'thumb' | 'full' = 'thumb',
): string | undefined {
  if (!fileId) return undefined;
  if (fileId.startsWith('http')) return fileId;
  return oxyServices.getFileDownloadUrl(fileId, variant);
}
