import React from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { SCREEN_PADDING } from '@/components/ui';
import { withAlpha } from '@/utils/color';
import type { MaterialCommunityIconName } from '@/types/icons';

/** One civic-duty call to action rendered as a carousel card. */
export interface CtaItem {
  key: string;
  icon: MaterialCommunityIconName;
  /** Accent color for the card's rounded icon tile. */
  color: string;
  title: string;
  description: string;
  onPress: () => void;
}

interface GetStartedCarouselProps {
  title: string;
  /** Accessibility label for the dismiss control. */
  dismissLabel: string;
  items: CtaItem[];
  onDismiss: () => void;
}

const CARD_WIDTH = 256;

/**
 * A dismissible "Get started" section: a section label with an X control above a
 * horizontally scrolling row of outlined CTA cards. Each card is a rounded,
 * hairline-bordered surface with a small colored rounded-square icon tile, a
 * bold title, and a muted description — the civic duties that grow a citizen's
 * standing (get attested, validate others, prove personhood).
 */
export function GetStartedCarousel({ title, dismissLabel, items, onDismiss }: GetStartedCarouselProps) {
  const colors = useColors();

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <ThemedText style={[styles.heading, { color: colors.text }]}>{title}</ThemedText>
        <TouchableOpacity
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          hitSlop={10}
          style={styles.dismiss}
        >
          <MaterialCommunityIcons name="close" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.track}
      >
        {items.map((item) => (
          <TouchableOpacity
            key={item.key}
            activeOpacity={0.85}
            onPress={item.onPress}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            style={[styles.card, { borderColor: colors.border, backgroundColor: colors.background }]}
          >
            <View style={[styles.iconTile, { backgroundColor: withAlpha(item.color, 0.14) }]}>
              <MaterialCommunityIcons name={item.icon} size={22} color={item.color} />
            </View>
            <ThemedText style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
              {item.title}
            </ThemedText>
            <ThemedText
              style={[styles.cardDesc, { color: colors.textSecondary }]}
              numberOfLines={2}
            >
              {item.description}
            </ThemedText>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  dismiss: {
    padding: 2,
  },
  // Break the horizontal scroller out of the screen's side gutter so cards can
  // peek to the true screen edge; the leading inset is restored on the content
  // container so the first card sits flush with the page margin (no offset).
  scroll: {
    marginHorizontal: -SCREEN_PADDING,
  },
  track: {
    gap: 12,
    paddingHorizontal: SCREEN_PADDING,
  },
  card: {
    width: CARD_WIDTH,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 10,
  },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  cardDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
});
