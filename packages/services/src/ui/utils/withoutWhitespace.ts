/**
 * Drop every whitespace character, for a field whose value can never hold one:
 * a username, an email address, or the sign-in identifier that is either.
 *
 * A typing aid, like `stripDisallowedUsernameCharacters`: the field never shows
 * a space it would only refuse later, and a pasted ` ada@example.com ` arrives
 * clean. The contract checks still decide.
 */
export function withoutWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}
