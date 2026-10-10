interface UserIdentityInput {
  id?: unknown;
  _id?: unknown;
}

function stringifyIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const toStringFn = value.toString;
    if (typeof toStringFn === 'function' && toStringFn !== Object.prototype.toString) {
      const rendered = toStringFn.call(value);
      if (typeof rendered === 'string') {
        const trimmed = rendered.trim();
        return trimmed.length > 0 && trimmed !== '[object Object]' ? trimmed : null;
      }
    }
  }

  return null;
}

/**
 * Returns the stable SDK user id from API payloads that may use either `id` or
 * a raw `_id`.
 */
export function getNormalizedUserId(user: UserIdentityInput | null | undefined): string | null {
  if (!user) {
    return null;
  }

  return stringifyIdentity(user.id) ?? stringifyIdentity(user._id);
}

/**
 * Normalizes a user payload to always expose `id`. Throws when the payload does
 * not contain a usable id, because SDK callers should never receive anonymous
 * user objects from authenticated identity endpoints.
 */
export function normalizeUserIdentity<T extends UserIdentityInput>(user: T): T & { id: string } {
  const id = getNormalizedUserId(user);
  if (!id) {
    throw new Error('User response missing id');
  }

  return { ...user, id };
}

export function normalizeUserIdentityOrNull<T extends UserIdentityInput>(
  user: T | null | undefined,
): (T & { id: string }) | null {
  return user ? normalizeUserIdentity(user) : null;
}
