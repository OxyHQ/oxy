export type AuthorizationHeaders = Readonly<{
  authorization?: string | readonly string[];
}>;

/** Parse one RFC 6750 Bearer credential without accepting duplicates. */
export function extractBearerToken(
  headers: AuthorizationHeaders,
): string | undefined {
  const value = headers.authorization;
  if (typeof value === 'string' || value === undefined) {
    return parseBearerValue(value);
  }
  return value.length === 1 ? parseBearerValue(value[0]) : undefined;
}

function parseBearerValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer[ \t]+([^ \t,]+)[ \t]*$/i.exec(value);
  return match?.[1] || undefined;
}
