import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/button` stub.
 *
 * The real `Button` calls `useTheme()`, which THROWS outside a
 * `BloomThemeProvider`, and this suite cannot reach it: Bloom's Button imports
 * `../theme/use-theme` RELATIVELY, and a `moduleNameMapper` entry for
 * `@oxy.so/bloom/theme` never sees a relative specifier. That is the same
 * dual-instance shape Bloom's own `BloomThemeContext` is `globalThis`-anchored
 * to survive — here it just means the package-level mock cannot reach inside.
 *
 * Wrapping every screen render in a real provider was the alternative. It was
 * rejected because these suites assert on the APP — which handler a press runs,
 * what copy appears, which route it targets — and a provider would make each of
 * them depend on Bloom's palette and font loading to prove none of that.
 *
 * Renders a DOM `<button>` so the existing queries (`getByRole('button')`,
 * `getByText`) keep working, and forwards the props those queries turn on.
 * `loading` maps to `disabled`, which is what the real Button does: a busy
 * button ignores presses.
 */
export function Button({
  children,
  onPress,
  disabled,
  loading,
  accessibilityLabel,
  testID,
}: {
  children?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      onClick: disabled || loading ? undefined : onPress,
      disabled: disabled || loading,
      'aria-label': accessibilityLabel,
      'data-testid': testID,
    },
    children,
  );
}

export const GlyphButton = Button;
export const CloseButton = Button;
export default Button;
