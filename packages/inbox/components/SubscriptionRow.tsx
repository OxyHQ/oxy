/**
 * A single row in the subscriptions list.
 *
 * Sender, then the two facts that decide whether to keep it — how much it
 * sends and how much of that you actually open — then the address it comes
 * from, then the way out.
 *
 * Built on Bloom's `Item`, which owns the leading/text/trailing geometry and
 * the row's padding, so this file only supplies content.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Item } from '@oxyhq/bloom/item';
import { Button } from '@oxyhq/bloom/button';
import { Text } from '@oxyhq/bloom/typography';
import { SPACING as BLOOM_SPACING } from '@oxyhq/bloom/design-tokens';
import { useColors } from '@/constants/theme';
import { SenderAvatar } from '@/components/Avatar';
import type { Subscription } from '@/services/emailApi';

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * How often this sender writes, from the real span between its oldest and
 * newest message. A sender seen only once has no span to measure, so it gets
 * no cadence rather than a fabricated one.
 */
function formatCadence(subscription: Subscription): string | null {
  const oldest = Date.parse(subscription.oldestDate);
  const latest = Date.parse(subscription.latestDate);
  if (!Number.isFinite(oldest) || !Number.isFinite(latest)) return null;

  const weeks = (latest - oldest) / MS_PER_WEEK;
  if (weeks <= 0) return null;

  const perWeek = subscription.messageCount / weeks;
  if (perWeek >= 5) return 'daily';
  if (perWeek >= 0.75) return 'weekly';
  if (perWeek >= 0.2) return 'monthly';
  return 'occasionally';
}

export function SubscriptionRow({
  subscription,
  onUnsubscribe,
  isUnsubscribing,
}: {
  subscription: Subscription;
  onUnsubscribe: (senderAddress: string, method?: 'list-unsubscribe' | 'block') => void;
  isUnsubscribing: boolean;
}) {
  const colors = useColors();

  const isBlockOnly = subscription.type === 'frequent';

  const cadence = formatCadence(subscription);
  const readPercent = subscription.messageCount
    ? Math.round((subscription.readCount / subscription.messageCount) * 100)
    : 0;
  // "weekly, 0% read" — cadence is dropped when there is no span to derive it
  // from, leaving the read rate to stand on its own.
  const detail = [cadence, `${readPercent}% read`].filter(Boolean).join(', ');

  const handlePress = () => {
    onUnsubscribe(
      subscription._id,
      isBlockOnly ? 'block' : 'list-unsubscribe',
    );
  };

  return (
    <Item
      leading={
        <SenderAvatar avatarPath={subscription.senderAvatarPath} name={subscription.name} size={40} />
      }
      title={subscription.name}
      titleStyle={styles.name}
      subtitle={
        <View style={styles.details}>
          <Text style={[styles.stats, { color: colors.text }]} numberOfLines={1}>
            <Text style={{ color: colors.secondaryText }}>
              {subscription.messageCount} {subscription.messageCount === 1 ? 'email' : 'emails'}
            </Text>
            {` ${detail}`}
          </Text>
          <Text style={[styles.email, { color: colors.secondaryText }]} numberOfLines={1}>
            {subscription._id}
          </Text>
        </View>
      }
      trailing={
        <Button
          variant={isBlockOnly ? 'destructive' : 'outline'}
          size="small"
          onPress={handlePress}
          disabled={isUnsubscribing}
          loading={isUnsubscribing}
        >
          {isBlockOnly ? 'Block' : 'Unsubscribe'}
        </Button>
      }
    />
  );
}

const styles = StyleSheet.create({
  name: {
    fontSize: 17,
    fontWeight: '700',
  },
  details: {
    gap: BLOOM_SPACING['space-2'],
  },
  stats: {
    fontSize: 14,
  },
  email: {
    fontSize: 14,
  },
});
