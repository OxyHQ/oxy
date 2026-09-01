/**
 * Custom error types for better error handling
 */
export class OxyAuthenticationError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code = 'AUTH_ERROR', status = 401) {
    super(message);
    this.name = 'OxyAuthenticationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Thrown when an asset's authorized download URL cannot be resolved.
 *
 * `getFileDownloadUrlAsync` asks the API for a URL that is valid for the
 * CALLER and the asset's actual visibility. When that resolution fails there is
 * no honest fallback: the public CDN origin only serves `public` assets, so
 * handing back `https://cloud.oxy.so/<id>` for an unresolved asset produces a
 * hard 404 at render time and hides the real failure from the caller. This
 * error surfaces the failure instead.
 *
 * The message and fields deliberately carry only the asset id, the requested
 * variant and the HTTP status — never the resolved URL, which embeds a scoped
 * media token.
 *
 * ## `status` lets a caller decide whether a CDN fallback is safe
 *
 * Core itself never falls back to the public CDN builder, because it has no
 * knowledge of the asset's visibility and that URL is a guaranteed 404 for a
 * private asset. A CALLER that knows an asset is public MAY choose to fall back
 * to `getFileDownloadUrl(id, variant)` — but only for a TRANSIENT failure, not
 * a definitive denial:
 *   - `status` 401/403/404 → definitive: the asset is private/denied/missing.
 *     Never CDN-fall-back — it will 404.
 *   - `status` undefined (network error) or 5xx → transient: resolution itself
 *     failed. If the caller independently knows the asset is public, a CDN
 *     fallback is defensible best-effort.
 */
export class AssetUrlResolutionError extends Error {
  public readonly code = 'ASSET_URL_UNRESOLVED';
  public readonly fileId: string;
  public readonly variant?: string;
  public readonly status?: number;
  /**
   * The underlying transport/API failure, when there was one. Declared on the
   * class rather than relying on `Error.cause` because this package targets
   * ES2020, where `cause` is not part of the `Error` type.
   */
  public readonly cause?: unknown;

  constructor(fileId: string, variant: string | undefined, status: number | undefined, cause?: unknown) {
    const variantSuffix = variant ? ` (variant "${variant}")` : '';
    const statusSuffix = typeof status === 'number' ? ` — status ${status}` : '';
    super(`Could not resolve a download URL for asset "${fileId}"${variantSuffix}${statusSuffix}`);
    this.name = 'AssetUrlResolutionError';
    this.fileId = fileId;
    this.variant = variant;
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Thrown when one or more chunks of `getServiceAssetMetadataByIds` could not be
 * resolved.
 *
 * Exists because for this endpoint a FAILED request and an ABSENT asset produce
 * the same observable result. The server legitimately omits unknown/deleted ids,
 * so callers are documented to map the response by `id` and treat a missing
 * entry as "no such asset" — which means a chunk that 429s, times out or 5xxs
 * reads as authoritative absence unless it is raised.
 *
 * That was not hypothetical: a metadata backfill counted every throttled asset
 * as needing no update and exited 0, and the MTN signed-record builder embedded
 * media with no content hash into records that are immutable once signed. Both
 * paths reported success and wrote nothing.
 *
 * `unresolvedIds` carries every id in a failed chunk — not the subset the server
 * would have omitted anyway, which is unknowable when the request never landed.
 * A caller that wants best-effort passes `{ partial: true }` and never sees this.
 */
export class ServiceAssetMetadataError extends Error {
  public readonly code = 'SERVICE_ASSET_METADATA_UNRESOLVED';
  /** Every id belonging to a chunk whose request failed. */
  public readonly unresolvedIds: string[];
  /** HTTP statuses observed across the failed chunks (deduped, ascending). */
  public readonly statuses: number[];
  /**
   * The first underlying transport/API failure. Declared on the class rather
   * than relying on `Error.cause` because this package targets ES2020, where
   * `cause` is not part of the `Error` type.
   */
  public readonly cause?: unknown;

  constructor(unresolvedIds: string[], statuses: number[], cause?: unknown) {
    const uniqueStatuses = Array.from(new Set(statuses)).sort((a, b) => a - b);
    const statusSuffix = uniqueStatuses.length > 0 ? ` — status ${uniqueStatuses.join(', ')}` : '';
    super(
      `Could not resolve asset metadata for ${unresolvedIds.length} id(s)${statusSuffix}. Treat this as unknown, not as absent; pass { partial: true } for best-effort.`,
    );
    this.name = 'ServiceAssetMetadataError';
    this.unresolvedIds = unresolvedIds;
    this.statuses = uniqueStatuses;
    this.cause = cause;
  }
}

export class OxyAuthenticationTimeoutError extends OxyAuthenticationError {
  constructor(operationName: string, timeoutMs: number) {
    super(
      `Authentication timeout (${timeoutMs}ms): ${operationName} requires user authentication. Please ensure the user is logged in before calling this method.`,
      'AUTH_TIMEOUT',
      408
    );
    this.name = 'OxyAuthenticationTimeoutError';
  }
}

