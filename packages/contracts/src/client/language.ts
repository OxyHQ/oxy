/** Bounded BCP-47-shaped input; the API resolves supported canonical locales. */
export function isLanguageTag(value: string): boolean {
  return value.length <= 64 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value);
}
