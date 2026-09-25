import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/loading` stub — `useTheme()` again.
 *
 * Renders a node carrying its accessible name so a suite can assert that a
 * screen is in its loading state rather than its empty one.
 */
export function Loading({ accessibilityLabel }: { accessibilityLabel?: string; [key: string]: unknown }) {
  return React.createElement('div', { role: 'progressbar', 'aria-label': accessibilityLabel });
}

export default Loading;
