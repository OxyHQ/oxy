/**
 * RFC 6749 §2.3 client authentication for the token endpoint.
 *
 * Two methods are supported, and exactly one may be used per request:
 *
 *   - `client_secret_basic` — HTTP Basic (§2.3.1). This is the method RFC 6749
 *     says confidential clients SHOULD use, and the one standard OAuth
 *     libraries reach for by default.
 *   - `client_secret_post` — `client_id` / `client_secret` in the form body.
 *
 * Public clients (PKCE) authenticate with neither; they send `client_id` in the
 * body and prove possession with `code_verifier`.
 *
 * Resolution is deliberately kept free of database access so the parsing rules
 * — which decide WHICH credential the caller claims — are unit-testable on
 * their own, separately from whether that credential is valid.
 */

import { OAuthError } from './oauthResponse';

export interface ResolvedClientAuthentication {
  /** The claimed client identifier, or undefined when the request named none. */
  clientId: string | undefined;
  /**
   * The asserted client secret, or undefined for a public (PKCE) client.
   * Asserting a secret does NOT mean it is correct — the caller verifies it.
   */
  clientSecret: string | undefined;
}

const BASIC_SCHEME = 'basic';

/**
 * Decode one half of a Basic credential.
 *
 * RFC 6749 §2.3.1 requires the client id and secret to be
 * `application/x-www-form-urlencoded`-encoded BEFORE base64, so they must be
 * decoded here — including `+` as a space, which is what that encoding means.
 * Oxy client ids (`oxy_dk_<hex>`) and secrets (hex) contain only unreserved
 * characters, so for real credentials this is the identity transform; it exists
 * so a spec-conforming client with any other credential shape still works.
 *
 * Throws `URIError` on a malformed percent-escape; the caller maps that to
 * `invalid_client` since no Oxy credential can produce one.
 */
function formUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, '%20'));
}

/**
 * Split an `Authorization: Basic` header into its two halves.
 *
 * RFC 7617 §2 splits on the FIRST colon: the user-id may not contain one, the
 * password may.
 */
function decodeBasicCredentials(encoded: string): { clientId: string; clientSecret: string } {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) {
    throw OAuthError.invalidClient('Malformed Basic authorization header.');
  }

  try {
    return {
      clientId: formUrlDecode(decoded.slice(0, separatorIndex)),
      clientSecret: formUrlDecode(decoded.slice(separatorIndex + 1)),
    };
  } catch {
    throw OAuthError.invalidClient('Malformed Basic authorization header.');
  }
}

/**
 * Resolve which client the request claims to be, and with what secret.
 *
 * Rejects:
 *   - an `Authorization` header in any scheme other than `Basic`
 *     (`invalid_client` — the client tried to authenticate and we cannot),
 *   - combining Basic with a body `client_secret`, which RFC 6749 §2.3 forbids
 *     ("MUST NOT use more than one authentication method in each request"),
 *   - a body `client_id` that contradicts the one in the Basic header.
 *
 * The last two are `invalid_request`, not `invalid_client`: the request is
 * self-contradictory, so there is no single credential to even test.
 */
export function resolveClientAuthentication(params: {
  authorizationHeader: string | undefined;
  bodyClientId: string | undefined;
  bodyClientSecret: string | undefined;
}): ResolvedClientAuthentication {
  const { authorizationHeader, bodyClientId, bodyClientSecret } = params;

  if (!authorizationHeader) {
    return { clientId: bodyClientId, clientSecret: bodyClientSecret };
  }

  const separatorIndex = authorizationHeader.indexOf(' ');
  const scheme = separatorIndex < 0 ? authorizationHeader : authorizationHeader.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== BASIC_SCHEME) {
    throw OAuthError.invalidClient('Unsupported client authentication method.');
  }

  const credentials = decodeBasicCredentials(
    separatorIndex < 0 ? '' : authorizationHeader.slice(separatorIndex + 1).trim(),
  );

  if (bodyClientSecret) {
    throw OAuthError.invalidRequest(
      'Use either the Authorization header or client_secret in the body, not both.',
    );
  }
  if (bodyClientId && bodyClientId !== credentials.clientId) {
    throw OAuthError.invalidRequest(
      'client_id in the body does not match the Authorization header.',
    );
  }

  // An empty half (`Basic base64("id:")`) carries no credential — normalise it
  // to `undefined` so downstream presence checks are uniform across both
  // authentication methods.
  return {
    clientId: credentials.clientId || undefined,
    clientSecret: credentials.clientSecret || undefined,
  };
}
