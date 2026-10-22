import { Badge } from '@oxy.so/bloom/badge';

/** The badge vocabulary the console's lib helpers speak (`budgetUtilizationVariant`, ...). */
export type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';

const PAINT = {
  default: { tone: 'neutral', appearance: 'solid' },
  secondary: { tone: 'neutral', appearance: 'subtle' },
  destructive: { tone: 'danger', appearance: 'subtle' },
  outline: { tone: 'neutral', appearance: 'outline' },
  ghost: { tone: 'neutral', appearance: 'plain' },
} as const;

/** A label pill drawn with Bloom's Badge. */
export function StatusBadge({
  label,
  variant = 'secondary',
}: {
  label: string;
  variant?: StatusVariant;
}) {
  const paint = PAINT[variant];
  return (
    <Badge content={label} tone={paint.tone} appearance={paint.appearance} size="label-small" />
  );
}
