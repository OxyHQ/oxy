import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/badge` stub.
 *
 * Same reason as `__mocks__/bloom-button.tsx`: the real `Badge` calls
 * `useTheme()`, which throws outside a `BloomThemeProvider`, and it reaches the
 * theme through a RELATIVE import that a `moduleNameMapper` entry for
 * `@oxy.so/bloom/theme` cannot intercept.
 *
 * `content` renders as text, because that is what the suites assert on — the
 * offline chip's copy, a credential's status word — and `dot` renders nothing,
 * which is what a badge with no content says.
 */
export function Badge({
  content,
  dot,
  invisible,
  children,
  testID,
}: {
  content?: string | number;
  dot?: boolean;
  invisible?: boolean;
  children?: React.ReactNode;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement | null {
  if (invisible) return children ? React.createElement(React.Fragment, null, children) : null;
  return React.createElement(
    'span',
    { 'data-testid': testID },
    children,
    dot ? null : content,
  );
}

export default Badge;
