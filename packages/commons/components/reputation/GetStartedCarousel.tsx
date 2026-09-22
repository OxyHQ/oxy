import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import { Card } from '@oxy.so/bloom/card';
import { GlyphButton } from '@oxy.so/bloom/button';
import { H4, Text } from '@oxy.so/bloom/typography';
import { AppIcon, Icons } from '@/constants/icons';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/utils/color';
import type { IconName } from '@/constants/icons';

/** One civic-duty call to action rendered as a carousel card. */
export interface CtaItem {
  key: string;
  icon: IconName;
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
 * A dismissible "Get started" section: a heading with a dismiss control above a
 * run of CTA cards — the civic duties that grow a citizen's standing (get
 * attested, validate others, prove personhood).
 *
 * The run is Bloom's `Carousel` rather than a bare horizontal `ScrollView`, so
 * it snaps, and — the part a `ScrollView` never had — announces itself as a
 * carousel and labels each card "N of M". The cards are Bloom `Card`s, and the
 * dismiss is a `GlyphButton`, the neutral icon button.
 *
 * `showArrows={false}`: the arrows are a pointer affordance and Commons ships to
 * phones only. `showDots` stays on — it is the only thing that says more cards
 * exist, now that the cards no longer bleed to the screen edge.
 *
 * The icon TILE stays hand-drawn. Bloom's `IconCircle` is a fixed 52/64 disc in
 * the accent colour; this is a 40pt rounded SQUARE in the duty's own colour, and
 * the colour is the point — each duty is a different one.
 */
export function GetStartedCarousel({ title, dismissLabel, items, onDismiss }: GetStartedCarouselProps) {
  const colors = useColors();

  return (
    <View className="gap-space-12">
      <View className="flex-row items-center justify-between">
        <H4>{title}</H4>
        <GlyphButton icon={Icons.close} onPress={onDismiss} accessibilityLabel={dismissLabel} />
      </View>

      <Carousel accessibilityLabel={title} showArrows={false} align="start" gap={12}>
        {items.map((item) => (
          <CarouselItem key={item.key} width={CARD_WIDTH} accessibilityLabel={item.title}>
            <Card
              appearance="outline"
              radius="radius-20"
              style={styles.card}
              onPress={item.onPress}
              accessibilityLabel={item.title}
            >
              <View style={[styles.iconTile, { backgroundColor: withAlpha(item.color, 0.14) }]}>
                <AppIcon name={item.icon} size="md" fill={item.color} />
              </View>
              <H4 numberOfLines={1}>{item.title}</H4>
              <Text style={{ color: colors.textSecondary }} numberOfLines={2}>
                {item.description}
              </Text>
            </Card>
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
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
});
