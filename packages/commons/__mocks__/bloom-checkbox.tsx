import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/checkbox` stub (the real one reads Bloom's theme
 * through a relative import, like the button). A DOM checkbox named by its
 * label, so a test can find it by role and toggle it.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  accessibilityLabel,
  testID,
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  [key: string]: unknown;
}): React.ReactElement {
  return React.createElement('input', {
    type: 'checkbox',
    checked: Boolean(checked),
    disabled,
    'aria-label': accessibilityLabel ?? label,
    'data-testid': testID,
    onChange: () => onCheckedChange?.(!checked),
  });
}

export const CheckboxCard = Checkbox;
