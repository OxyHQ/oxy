import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import type { ReputationLeaderboardEntry } from '@oxy.so/contracts';
import { getNormalizedUserHandle, logger, trustTierLabel } from '@oxy.so/core';
import { useTheme } from '@oxy.so/bloom/theme';
import { H6, Text } from '@oxy.so/bloom/typography';
import { Chip } from '@oxy.so/bloom/chip';
import { Button } from '@oxy.so/bloom/button';
import Ionicons from '../../icons/Ionicons';
import type { BaseScreenProps } from '../../types/navigation';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { useOxy } from '../../context/oxyRuntimeContext';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const AVATAR_SIZE = 40;
const EMPTY_ICON_SIZE = 64;
const ERROR_ICON_SIZE = 48;
/** Ranks within the podium (1–3) get a highlighted row surface. */
const PODIUM_RANK = 3;

const TrustLeaderboardScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
  const themed = useThemedStyles();
  const { oxyServices, user: currentUser } = useOxy();
  const { t, locale } = useI18n();
  const bloomTheme = useTheme();

  const [leaderboard, setLeaderboard] = useState<ReputationLeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentUserId = currentUser?.id ?? '';

  const loadLeaderboard = useCallback(() => {
    setIsLoading(true);
    setError(null);
    oxyServices.reputation
      .leaderboard()
      .then((data) => setLeaderboard(Array.isArray(data) ? data : []))
      .catch((err: unknown) => {
        logger.error(
          'Failed to load trust leaderboard',
          err instanceof Error ? err : new Error(String(err)),
          { component: 'TrustLeaderboardScreen' },
        );
        setError(err instanceof Error ? err.message : null);
      })
      .finally(() => setIsLoading(false));
  }, [oxyServices]);

  useEffect(() => {
    loadLeaderboard();
  }, [loadLeaderboard]);

  const title = t('trust.leaderboard.title') || 'Trust Leaderboard';
  const subtitle = t('trust.leaderboard.subtitle') || 'Top contributors in the community';
  useSurfaceHeader({ title, subtitle });

  const handleEntryPress = useCallback(
    (entry: ReputationLeaderboardEntry) => {
      navigate?.('Profile', { userId: entry.user.id, username: entry.user.username });
    },
    [navigate],
  );

  const renderEntry = useCallback(
    ({ item }: { item: ReputationLeaderboardEntry }) => {
      const displayName = item.user.name?.displayName ?? getNormalizedUserHandle(item.user) ?? '';
      const isViewer = currentUserId !== '' && item.user.id === currentUserId;
      const isPodium = item.rank <= PODIUM_RANK;
      // Viewer's own row and podium ranks get a subtle highlighted surface.

      return (
        <GroupedSection>
          <GroupedSectionItem
            title={displayName}
            description={trustTierLabel(locale, item.trustTier)}
            onPress={() => handleEntryPress(item)}
            accessibilityLabel={`${displayName}, ${t('trust.leaderboard.rankLabel', { rank: item.rank }) || `rank ${item.rank}`}`}
            accessibilityState={{ selected: isViewer }}
            icon={
              <View style={styles.tierRow}>
                <Text style={[themed.mutedText, styles.rank]}>{item.rank}</Text>
                <Avatar
                  source={
                    item.user.avatar
                      ? oxyServices.assets.publicUrl(item.user.avatar, 'thumb')
                      : undefined
                  }
                  name={displayName}
                  size={AVATAR_SIZE}
                />
              </View>
            }
            rightElement={
              <Chip size="sm" variant="subtle" color={isPodium ? 'primary' : 'default'}>
                {item.total}
              </Chip>
            }
            showChevron={false}
          />
        </GroupedSection>
      );
    },
    [oxyServices, currentUserId, handleEntryPress, locale, t, themed],
  );

  const keyExtractor = useCallback(
    (item: ReputationLeaderboardEntry, index: number) => item.user.id || `entry-${index}`,
    [],
  );

  const ItemSeparator = useMemo(() => () => <View style={{ height: 2 }} />, []);

  if (error) {
    return (
      <View style={themed.surface}>
        <View style={[styles.stack, styles.center]}>
          <Ionicons name="alert-circle" size={ERROR_ICON_SIZE} color={bloomTheme.colors.error} />
          <Text style={themed.mutedText2}>
            {error || t('trust.leaderboard.error') || 'Failed to load leaderboard'}
          </Text>
          <Button appearance="solid" tone="accent" onPress={loadLeaderboard}>
            {t('common.retry') || 'Retry'}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={themed.surface}>
      <FlatList
        data={leaderboard}
        renderItem={renderEntry}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        style={styles.section}
        ItemSeparatorComponent={ItemSeparator}
        ListEmptyComponent={
          <View style={[styles.stack2, styles.emptyContainer]}>
            <Ionicons
              name="trophy-outline"
              size={EMPTY_ICON_SIZE}
              color={bloomTheme.colors.textSecondary}
            />
            <Text role="heading" aria-level={6} style={themed.text}>
              {t('trust.leaderboard.empty') || 'No leaderboard data'}
            </Text>
            <Text style={themed.mutedText3}>
              {t('trust.leaderboard.emptyDesc') ||
                'Top contributors will appear here as the community grows.'}
            </Text>
          </View>
        }
      />
    </View>
  );
};

// Layout-only styles: flex centering, measured rank column width, separator
// inset, and row flex layout. Colors, spacing, radius, and typography roles
// live on Bloom components + NativeWind token classes.
const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  rank: {
    width: 28,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },

  stack: { gap: 16, paddingHorizontal: 32 },
  section: { paddingHorizontal: 8, paddingTop: 12 },
  stack2: { gap: 8, paddingHorizontal: 32 },
});

export default TrustLeaderboardScreen;

const useThemedStyles = createTokenStyles((t) => ({
  mutedText: { fontWeight: 700, color: t.mutedForeground },
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  mutedText2: { textAlign: 'center', fontSize: 16, color: t.mutedForeground, lineHeight: 24 },
  text: { marginTop: 8, textAlign: 'center', color: t.foreground },
  mutedText3: { textAlign: 'center', fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
}));
