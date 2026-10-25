import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/page-header` stub (the real header pulls in
 * expo-blur's ESM build and Bloom's theme). Keeps what a test asserts on: the
 * title, the back button, and the actions slot.
 */
export function PageHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  actions,
  testID,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: React.ReactNode;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement {
  return React.createElement(
    'header',
    { 'data-testid': testID },
    onBack
      ? React.createElement('button', { onClick: onBack, 'aria-label': backLabel ?? 'Back' })
      : null,
    title ? React.createElement('span', null, title) : null,
    subtitle ? React.createElement('span', null, subtitle) : null,
    typeof actions === 'function' ? null : (actions ?? null),
  );
}
