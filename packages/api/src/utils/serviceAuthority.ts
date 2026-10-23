/** Call only with a verified service principal (first-party identities are re-read live). */
export function hasServiceAuthority(
  principal:
    | { authority?: 'first_party' | 'external'; scopes?: readonly string[] }
    | null
    | undefined,
  externalScope: string,
): boolean {
  return (
    principal?.authority === 'first_party' || principal?.scopes?.includes(externalScope) === true
  );
}
