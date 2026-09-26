import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/item` stub — `useTheme()`, as with every other
 * Bloom family this suite stubs.
 *
 * Renders each slot in its own node so `getByText` can reach the title, the
 * subtitle and whatever a row put in its trailing slot separately — as bare
 * siblings they share a parent and a text query matches none of them. Pressable
 * rows render a `<button>` so `getByRole('button')` still finds them.
 */
export function Item({
  title,
  subtitle,
  leading,
  trailing,
  children,
  onPress,
  disabled,
  accessibilityLabel,
  testID,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement {
  const body = [
    leading ? React.createElement('div', { key: 'leading' }, leading) : null,
    children ?? null,
    title ? React.createElement('div', { key: 'title' }, title) : null,
    subtitle ? React.createElement('div', { key: 'subtitle' }, subtitle) : null,
    trailing ? React.createElement('div', { key: 'trailing' }, trailing) : null,
  ];

  return React.createElement(
    onPress ? 'button' : 'div',
    {
      onClick: disabled ? undefined : onPress,
      disabled: onPress ? disabled : undefined,
      'aria-label': accessibilityLabel,
      'data-testid': testID,
    },
    body,
  );
}

export default Item;
