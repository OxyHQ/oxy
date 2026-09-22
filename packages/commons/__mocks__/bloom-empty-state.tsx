import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/empty-state` stub.
 *
 * Same reason as the button and badge stubs: the real `EmptyState` calls
 * `useTheme()` through a relative import a package-level `moduleNameMapper`
 * entry cannot reach, and throws outside a provider.
 *
 * It renders the title, the description and BOTH actions as real `<button>`s,
 * because that is the whole contract these suites assert on: which copy an
 * error state shows and what its retry does. `illustration` renders too, so a
 * test can still see a spinner or a tinted glyph if it looks for one.
 */
interface Action {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}

export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  illustration,
  children,
  footer,
  testID,
}: {
  title?: string;
  description?: string;
  action?: Action;
  secondaryAction?: Action;
  illustration?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement {
  const button = (a: Action | undefined, key: string) =>
    a
      ? React.createElement(
          'button',
          { key, onClick: a.disabled ? undefined : a.onPress, disabled: a.disabled },
          a.label,
        )
      : null;

  return React.createElement(
    'div',
    { 'data-testid': testID },
    illustration,
    // Each string gets its own node, as the real component does: rendered as
    // bare siblings they share one parent, and `getByText` then matches
    // neither — the text is "broken up by multiple elements".
    title ? React.createElement('div', { key: 'title' }, title) : null,
    description ? React.createElement('div', { key: 'description' }, description) : null,
    children,
    button(action, 'action'),
    button(secondaryAction, 'secondary'),
    footer,
  );
}

export default EmptyState;
