/**
 * User display name and date formatting utilities.
 *
 * Display-name helpers follow the API contract: prefer `name.displayName` when
 * present, otherwise fall back to the normalized handle via
 * `getNormalizedUserHandle`.
 */

import { getNormalizedUserHandle, type DisplayNameUserShape } from '@oxyhq/core';

/**
 * Formats a date string to a readable format (e.g., "Feb 21, 2025")
 */
export const formatDate = (dateString: string | undefined | null | Date): string => {
  if (!dateString) return '';

  try {
    const date = dateString instanceof Date ? dateString : new Date(dateString);
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

function readDisplayName(user: DisplayNameUserShape | null | undefined): string {
  const name = user?.name;
  if (!name || typeof name !== 'object') return '';
  return typeof name.displayName === 'string' ? name.displayName.trim() : '';
}

/**
 * Gets a display name from user data.
 *
 * Prefers API `name.displayName`, then the normalized handle.
 */
export const getDisplayName = (
  user: DisplayNameUserShape | null | undefined,
): string => {
  const displayName = readDisplayName(user);
  if (displayName) return displayName;
  return getNormalizedUserHandle(user) ?? '';
};

/**
 * Gets a short display name (first token) for compact UI.
 */
export const getShortDisplayName = (
  user: DisplayNameUserShape | null | undefined,
): string => {
  const displayName = readDisplayName(user);
  if (displayName) {
    const firstToken = displayName.split(/\s+/).find(Boolean);
    if (firstToken) return firstToken;
  }

  const handle = getNormalizedUserHandle(user);
  if (handle) {
    const firstToken = handle.split(/\s+/).find(Boolean);
    return firstToken ?? handle;
  }

  return '';
};
