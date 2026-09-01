/** Local display hint when a session lacks explicit `expiresAt` (7 days). */
export const DEFAULT_SESSION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      if (typeof status === 'number') {
        return status;
      }
    }
  }
  return undefined;
}

export function isUnauthorizedStatus(error: unknown): boolean {
  return getHttpStatus(error) === 401;
}
