/**
 * Date formatting and display-name utilities for Commons.
 *
 * `getDisplayName` follows the API user DTO contract: explicit
 * `name.displayName` when present, otherwise the normalized handle via
 * `getNormalizedUserHandle`, then a translated "Unnamed" fallback.
 */

import {
  getAccountDisplayName as coreGetAccountDisplayName,
  getNormalizedUserHandle,
  type DisplayNameUserShape,
} from '@oxyhq/core';

function readDisplayName(user: DisplayNameUserShape | null | undefined): string {
  const name = user?.name;
  if (!name || typeof name !== 'object') return '';
  return typeof name.displayName === 'string' ? name.displayName.trim() : '';
}

/**
 * Formats a date string to a readable format (e.g., "Feb 21, 2025")
 */
export const formatDate = (dateString: string | undefined | null): string => {
  if (!dateString) return '';

  try {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
};

/**
 * Resolves a display label from an API-shaped user record.
 */
export const getDisplayName = (
  user: DisplayNameUserShape | null | undefined,
  locale?: string,
): string => {
  if (!user) return coreGetAccountDisplayName(null, locale);
  const displayName = readDisplayName(user);
  if (displayName) return displayName;
  return (
    getNormalizedUserHandle(user) ??
    coreGetAccountDisplayName(null, locale)
  );
};

/** Like {@link getDisplayName} but returns null instead of the translated "Unnamed" fallback. */
export const getDisplayNameOrNull = (
  user: DisplayNameUserShape | null | undefined,
): string | null => {
  if (!user) return null;
  const displayName = readDisplayName(user);
  if (displayName) return displayName;
  return getNormalizedUserHandle(user) ?? null;
};
