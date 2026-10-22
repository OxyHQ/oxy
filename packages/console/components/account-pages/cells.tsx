import type { ReactNode } from 'react';
import { Text } from 'react-native';

/** Monospace identifier cell. */
export function MonoCell({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text className={`font-mono text-xs ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
      {children}
    </Text>
  );
}

/** Plain cell text; `muted` for secondary columns. */
export function TextCell({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text className={`text-sm ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
      {children}
    </Text>
  );
}

/** Right-aligned numeric/money cell with tabular figures. */
export function NumberCell({
  children,
  muted = false,
  tone = 'default',
  accessibilityLabel,
}: {
  children: ReactNode;
  muted?: boolean;
  tone?: 'default' | 'negative';
  accessibilityLabel?: string;
}) {
  const color =
    tone === 'negative' ? 'text-destructive' : muted ? 'text-muted-foreground' : 'text-foreground';
  return (
    <Text
      className={`text-sm ${color}`}
      style={{ fontVariant: ['tabular-nums'] }}
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Text>
  );
}
