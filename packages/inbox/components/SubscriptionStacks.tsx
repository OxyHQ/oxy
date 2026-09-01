/**
 * The stacked-envelope header of the Subscriptions screen.
 *
 * One column per sender, ordered by volume: the sender's avatar and message
 * count on top, and beneath it a literal pile of envelopes — one per message.
 * The pile is the point: a sender you get 18 emails from towers over one you
 * get 2 from, which a number alone never conveys.
 *
 * The pile is a fixed-height box with each envelope absolutely placed one step
 * above the last, so the box measures exactly the paper it holds. Letting the
 * envelopes overflow a too-short container instead would leave the bottom one
 * clipped by the scroll view. Columns are bottom-aligned so the piles grow
 * upward from a shared baseline.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text } from '@oxyhq/bloom/typography';
import { SPACING as BLOOM_SPACING } from '@oxyhq/bloom/design-tokens';

import { Avatar } from './Avatar';
import { useColors } from '@/constants/theme';
import type { Subscription } from '@/services/emailApi';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

/**
 * Ceiling on how tall a pile can get. High enough that a heavy sender really
 * towers (at `ENVELOPE_STEP` per envelope, 60 is ~360dp of paper), low enough
 * that one outlier does not push the header off the screen.
 */
const MAX_ENVELOPES = 60;
/** Rendered envelope size. */
const ENVELOPE_WIDTH = 60;
const ENVELOPE_HEIGHT = 40;
/** Vertical step between envelopes. Smaller than the image, hence the overlap. */
const ENVELOPE_STEP = 6;
/** Resolved once: a pile can hold 60 of these, and every column draws a pile. */
const ENVELOPE_SOURCE = require('@/assets/images/envelope.png');

function EnvelopePile({ count }: { count: number }) {
  const envelopes = useMemo(
    () => Array.from({ length: Math.min(count, MAX_ENVELOPES) }, (_, i) => i),
    [count],
  );

  // The bottom envelope sits at 0 and the top one at (n-1) steps, so the box
  // has to be that tall plus one whole envelope.
  const height = (envelopes.length - 1) * ENVELOPE_STEP + ENVELOPE_HEIGHT;

  return (
    <View style={[styles.pile, { height }]} pointerEvents="none">
      {envelopes.map((i) => (
        <Image
          key={i}
          source={ENVELOPE_SOURCE}
          style={[styles.envelope, { bottom: i * ENVELOPE_STEP }]}
          resizeMode="contain"
        />
      ))}
    </View>
  );
}

interface SubscriptionStacksProps {
  subscriptions: Subscription[];
  onSelect?: (subscriptionId: string) => void;
}

export function SubscriptionStacks({ subscriptions, onSelect }: SubscriptionStacksProps) {
  const colors = useColors();
  const scrollRef = useRef<ScrollView>(null);

  // Only what the arrows need: whether there is anywhere to go in each
  // direction. The geometry itself lives in a ref — `scrollEventThrottle={16}`
  // means a state write here would be a React commit on every frame of every
  // drag, re-rendering the whole rail of piles.
  const geometry = useRef({ offset: 0, viewport: 0, content: 0 });
  const [edges, setEdges] = useState({ left: false, right: false });

  const ordered = useMemo(
    () => [...subscriptions].sort((a, b) => b.messageCount - a.messageCount),
    [subscriptions],
  );

  const scrollBy = useCallback((direction: -1 | 1) => {
    const { offset, viewport, content } = geometry.current;
    // Move by most of a screenful, keeping a sliver of context on screen.
    const step = Math.max(viewport * 0.8, 160);
    const maxOffset = Math.max(0, content - viewport);
    scrollRef.current?.scrollTo({
      x: Math.min(Math.max(offset + direction * step, 0), maxOffset),
      animated: true,
    });
  }, []);

  /** Recompute which arrows apply; commit only when the answer changes. */
  const syncEdges = useCallback(() => {
    const { offset, viewport, content } = geometry.current;
    const maxOffset = Math.max(0, content - viewport);
    const next = { left: offset > 1, right: offset < maxOffset - 1 };
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // The event already carries the viewport and content widths, so this is
      // also what keeps them current — no onLayout/onContentSizeChange pair.
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      geometry.current = {
        offset: contentOffset.x,
        viewport: layoutMeasurement.width,
        content: contentSize.width,
      };
      syncEdges();
    },
    [syncEdges],
  );

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      geometry.current.viewport = e.nativeEvent.layout.width;
      syncEdges();
    },
    [syncEdges],
  );

  const handleContentSizeChange = useCallback(
    (w: number) => {
      geometry.current.content = w;
      syncEdges();
    },
    [syncEdges],
  );

  if (ordered.length === 0) return null;

  return (
    <View onLayout={handleLayout}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={handleContentSizeChange}
      >
        {ordered.map((sub) => (
          <SubscriptionColumn key={sub._id} subscription={sub} onSelect={onSelect} colorText={colors.unread} />
        ))}
      </ScrollView>

      {edges.left && <ScrollArrow direction="left" onPress={() => scrollBy(-1)} colors={colors} />}
      {edges.right && <ScrollArrow direction="right" onPress={() => scrollBy(1)} colors={colors} />}
    </View>
  );
}

/**
 * A scroll affordance pinned to one edge of the row. Only rendered when there
 * is actually room to travel in that direction.
 */
function ScrollArrow({
  direction,
  onPress,
  colors,
}: {
  direction: 'left' | 'right';
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.arrow,
        direction === 'left' ? styles.arrowLeft : styles.arrowRight,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
      accessibilityRole="button"
      accessibilityLabel={direction === 'left' ? 'Scroll left' : 'Scroll right'}
    >
      <MaterialCommunityIcons
        name={direction === 'left' ? 'chevron-left' : 'chevron-right'}
        size={20}
        color={colors.icon}
      />
    </Pressable>
  );
}

function SubscriptionColumn({
  subscription,
  onSelect,
  colorText,
}: {
  subscription: Subscription;
  onSelect?: (subscriptionId: string) => void;
  colorText: string;
}) {
  const handlePress = useCallback(() => onSelect?.(subscription._id), [onSelect, subscription._id]);

  return (
    <View style={styles.column}>
      <Pressable
        onPress={handlePress}
        style={styles.head}
        accessibilityRole="button"
        accessibilityLabel={`${subscription.name}, ${subscription.messageCount} messages`}
      >
        <Avatar
          name={subscription.name}
          size={40}
          avatarUrl={subscription.senderAvatarPath ? `${API_URL}${subscription.senderAvatarPath}` : null}
        />
        <Text style={[styles.count, { color: colorText }]}>{subscription.messageCount}</Text>
      </Pressable>

      <EnvelopePile count={subscription.messageCount} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    // Bottom-aligned so every pile grows from the same baseline.
    alignItems: 'flex-end',
    gap: BLOOM_SPACING['space-12'],
    paddingHorizontal: BLOOM_SPACING['space-16'],
    paddingTop: BLOOM_SPACING['space-32'],
  },
  column: {
    flexShrink: 0,
    alignItems: 'center',
  },
  head: {
    alignItems: 'center',
    gap: BLOOM_SPACING['space-4'],
    marginBottom: BLOOM_SPACING['space-16'],
  },
  count: {
    fontSize: 15,
    fontWeight: '600',
  },
  pile: {
    width: ENVELOPE_WIDTH,
  },
  envelope: {
    position: 'absolute',
    left: 0,
    width: ENVELOPE_WIDTH,
    height: ENVELOPE_HEIGHT,
  },
  arrow: {
    position: 'absolute',
    // Centred against the rail's own height, which the tallest pile sets.
    // `top: '50%'` puts the arrow's top edge on the midline, so it is pulled
    // back up by half its height to sit ON the midline.
    top: '50%',
    transform: [{ translateY: -16 }],
    height: 32,
    width: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: {
    left: BLOOM_SPACING['space-4'],
  },
  arrowRight: {
    right: BLOOM_SPACING['space-4'],
  },
});
