import React from 'react';
import { View } from 'react-native';
import { Divider } from '@oxy.so/bloom/divider';

interface GroupedListProps {
  children: React.ReactNode;
}

/**
 * Stacks rows with a single rule between them — no surrounding card, no per-row
 * box. Separation is a thin line plus the rows' own breathing room, which is
 * the flat language the reputation screen was designed in (see
 * `docs/superpowers/specs/2026-06-27-reputation-screen-redesign.md`).
 *
 * The rule is Bloom's `Divider` now, not a hand-set `StyleSheet.hairlineWidth`
 * with a colour read from `useColors()`. Bloom's own note on that family is the
 * reason: it is "the one separator — nothing else in the library draws a rule by
 * hand", and a rule drawn by hand is a rule that can disagree about its colour
 * and its thickness with every other rule on the screen.
 *
 * It stays an app component rather than becoming `SettingsListGroup`, which
 * draws a rounded CARD. Commons uses both deliberately: the settings screens are
 * grouped cards, and these flat lists are not.
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
