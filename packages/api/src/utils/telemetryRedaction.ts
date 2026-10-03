const SECRET_AUTH_SESSION_PATH = /(?:^|\/)(?:auth\/)?session\/(?:status|authorize|cancel|finalize)\/[^/?#]+/;

/**
 * Return true when a raw HTTP target may contain a credential.
 *
 * OpenTelemetry sees the URL before Express resolves a route template. Query
 * values are therefore conservatively excluded, as are auth-session routes
 * whose path parameter is itself the proof used to complete the flow.
 */
export const shouldSuppressHttpTrace = (rawUrl: string | undefined): boolean => {
  if (!rawUrl) return false;

  return rawUrl.includes('?') || SECRET_AUTH_SESSION_PATH.test(rawUrl);
};
