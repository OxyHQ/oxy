import React from 'react';
import { View } from 'react-native';
import { Divider } from '@oxy.so/bloom/divider';

interface GroupedListProps {
  children: React.ReactNode;
}

/**
 * Stacks rows with a single Bloom `Divider` between them — no surrounding card,
 * no per-row box: the flat language the reputation screen was designed in (see
 * `docs/superpowers/specs/2026-06-27-reputation-screen-redesign.md`).
 *
 * Not `SettingsListGroup`, which draws a rounded CARD: the settings screens are
 * grouped cards, and these flat lists deliberately are not.
 */
export function GroupedList({ children }: GroupedListProps) {
  const items = React.Children.toArray(children).filter(Boolean);

  return (
    <View>
      {items.map((child, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Divider />}
          {child}
        </React.Fragment>
      ))}
    </View>
  );
}
