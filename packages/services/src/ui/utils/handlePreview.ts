/**
 * The public profile a typed username would have, from a host template.
 *
 * `{username}` is the only token. The host writes its own origin into the
 * template — `{base}/@{username}` means that host's base, not a domain this
 * SDK knows. An empty handle, or a template with no `{username}`, previews
 * nothing.
 */
export function renderHandlePreview(
  template: string | null | undefined,
  username: string,
): string | null {
  const handle = username.trim();
  if (!template || !handle || !template.includes('{username}')) return null;
  return template.split('{username}').join(handle);
}
