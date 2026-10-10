/** Approved I03 ceiling shared by issuance and both JWT verifiers. */
export const OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS = 300;

/** Call only after signature verification; cache checks alone confer no authority. */
export function hasBoundedServiceTokenLifetime(
  claims: { iat?: unknown; exp?: unknown },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return (
    typeof claims.iat === 'number' &&
    Number.isSafeInteger(claims.iat) &&
    typeof claims.exp === 'number' &&
    Number.isSafeInteger(claims.exp) &&
    claims.iat <= nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS
  );
}
