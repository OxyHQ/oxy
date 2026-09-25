import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/stat-bar` stub — `useTheme()`, as with every other
 * Bloom family this suite stubs.
 *
 * `Meter` renders a real `progressbar` carrying its value and name, so a suite
 * can still assert that a screen shows progress toward the next tier, and by
 * how much.
 */
export function Meter({
  value,
  max = 1,
  accessibilityLabel,
  valueText,
  testID,
}: {
  value: number;
  max?: number;
  accessibilityLabel?: string;
  valueText?: string;
  testID?: string;
  [key: string]: unknown;
}) {
  return React.createElement('div', {
    role: 'progressbar',
    'aria-label': accessibilityLabel,
    'aria-valuenow': value,
    'aria-valuemax': max,
    'aria-valuetext': valueText,
    'data-testid': testID,
  });
}

export const MeterRing = Meter;
export const StatBar = Meter;
