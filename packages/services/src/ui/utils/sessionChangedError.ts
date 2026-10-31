/** A locally superseded request is not a server rejection of the new session. */
export function isSessionChangedError(error: unknown): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && error.code === 'AUTH_SESSION_CHANGED'
  );
}

/** A locally superseded operation must not be mistaken for a server 401. */
export function createSessionChangedError(): Error & { code: string; status: number } {
  return Object.assign(new Error('The request session changed'), {
    code: 'AUTH_SESSION_CHANGED',
    status: 401,
  });
}
