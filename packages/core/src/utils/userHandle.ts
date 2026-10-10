export interface UserHandleInput {
  username?: string | null;
  handle?: string | null;
  instance?: string | null;
  isFederated?: boolean | null;
  type?: string | null;
  federation?: {
    domain?: string | null;
  } | null;
}

export type CanonicalUserHandleInput = UserHandleInput;

function normalizeHandlePart(value?: string | null): string | null {
  const trimmed = value?.trim().replace(/^@+/, '');
  if (!trimmed || /[/?#]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Returns the normalized profile handle used by Oxy consumers for display and
 * profile routing.
 *
 * Local users resolve to `username`. Federated users resolve to
 * `username@instance` when the username does not already include an instance.
 * Route-like values are rejected so callers do not accidentally turn paths or
 * query strings into profile destinations.
 */
export function getNormalizedUserHandle(user: UserHandleInput | null | undefined): string | null {
  const username = normalizeHandlePart(user?.username ?? user?.handle);
  if (!username) return null;

  const isFederated = user?.isFederated === true || user?.type === 'federated';
  const instance = normalizeHandlePart(user?.instance ?? user?.federation?.domain);

  if (isFederated && instance && !username.includes('@')) {
    return `${username}@${instance}`;
  }

  return username;
}

/**
 * Compatibility alias for the first public name shipped with this helper.
 * Prefer {@link getNormalizedUserHandle} in new code.
 */
export function getCanonicalUserHandle(
  user: CanonicalUserHandleInput | null | undefined,
): string | null {
  return getNormalizedUserHandle(user);
}
