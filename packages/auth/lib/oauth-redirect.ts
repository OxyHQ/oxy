// Native app schemes that are allowed as redirect targets.
const ALLOWED_NATIVE_SCHEMES = ['astro:'];

/** Validate and normalize an OAuth redirect_uri for authorize flows. */
export function safeRedirectUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)) {
        return null;
      }
      if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
        return parsed.origin;
      }
      return parsed.toString();
    }
    if (ALLOWED_NATIVE_SCHEMES.includes(parsed.protocol)) {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate an external MCP client's redirect URI. MCP public clients commonly
 * bind an ephemeral HTTP loopback port, while every non-loopback target must use
 * HTTPS. Credentials and fragments are never valid redirect bindings.
 */
export function safeMcpRedirectUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]';
    if (
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    ) {
      return null;
    }
    // OAuth redirect bindings use exact string comparison. Validation must not
    // normalize a registered URI (for example by removing a root slash).
    return value;
  } catch {
    return null;
  }
}
