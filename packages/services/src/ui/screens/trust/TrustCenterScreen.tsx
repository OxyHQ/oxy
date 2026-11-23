import type React from 'react';
import { useMemo } from 'react';
import { skip, useRecord } from '@oxy.so/bloom-data';
import { View, StyleSheet } from 'react-native';
import Ionicons from '../../icons/Ionicons';
import { Chip } from '@oxy.so/bloom/chip';
import { useTheme } from '@oxy.so/bloom/theme';
import { H1, Text } from '@oxy.so/bloom/typography';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { BaseScreenProps } from '../../types/navigation';
import { SettingsIcon } from '../../components/SettingsIcon';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import { useOxy } from '../../context/oxyRuntimeContext';
import { trustTierLabel } from '@oxy.so/core';
import { trustStanding } from '../../data/trust';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const TrustCenterScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
  const themed = useThemedStyles();
  // Reputation/trust is the ACTIVE account's standing (the org/project/bot
  // when switched, else the personal user).
  const { user, oxyServices, isAuthenticated } = useOxy();
  const { t, locale } = useI18n();
  const bloomTheme = useTheme();
  const primaryColor = bloomTheme.colors.primary;

  // Keyed on the account id, not the `user` object: a profile write that
  // replaces `user` must not refetch the ledger.
  const userId = user?.id;
  const standing = useRecord(trustStanding, ...(userId ? [oxyServices, userId] : [skip]));
  const reputationTotal = standing.value?.balance.total ?? null;
  const trustTier = standing.value?.balance.trustTier ?? null;
  const transactions = standing.value?.transactions ?? [];
  const isLoading = standing.isLoading;
  const error = standing.error
    ? (standing.error instanceof Error ? standing.error.message : null) ||
      t('trust.center.loadError') ||
      'Failed to load reputation data'
    : null;

  const resolvedTrustTierLabel = useMemo(
    () => (trustTier ? trustTierLabel(locale, trustTier) : null),
    [trustTier, locale],
  );

  const title = t('trust.center.title') || 'Trust Center';
  useSurfaceHeader({ title });

  if (!isAuthenticated) {
    return (
      <View style={styles.container}>
        <Text style={themed.text}>{t('common.status.notSignedIn') || 'Not signed in'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {/* Balance hero card */}
      <View style={themed.surface}>
        <H1 style={{ color: primaryColor }}>{reputationTotal ?? 0}</H1>
        <Text style={themed.mutedText}>{t('trust.center.balance') || 'Reputation Balance'}</Text>
        {resolvedTrustTierLabel ? (
          <Chip
            variant="subtle"
            color="primary"
            startIcon={<Ionicons name="shield-checkmark-outline" size={14} color={primaryColor} />}
          >
            {resolvedTrustTierLabel}
          </Chip>
        ) : null}
        <Text style={[themed.mutedText2, styles.infoText]}>
          {t('trust.center.info') ||
            'Reputation can only be earned by positive actions in the Oxy Ecosystem. It cannot be sent or received directly.'}
        </Text>
      </View>

      {/* Trust actions */}
      <GroupedSection title={t('trust.center.actions.title') || 'Explore'}>
        <GroupedSectionItem
          icon={<SettingsIcon name="trophy" color={bloomTheme.colors.warning} />}
          title={t('trust.center.actions.leaderboard') || 'Leaderboard'}
          onPress={() => navigate?.('TrustLeaderboard')}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="file-document" color={bloomTheme.colors.info} />}
          title={t('trust.center.actions.rules') || 'Rules'}
          onPress={() => navigate?.('TrustRules')}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="gift" color={bloomTheme.colors.success} />}
          title={t('trust.center.actions.rewards') || 'Rewards'}
          onPress={() => navigate?.('TrustRewards')}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="star" color={bloomTheme.colors.primary} />}
          title={t('trust.center.actions.about') || 'About'}
          onPress={() => navigate?.('AboutTrust')}
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="help-circle" color={bloomTheme.colors.secondary} />}
          title={t('trust.center.actions.faq') || 'FAQ'}
          onPress={() => navigate?.('TrustFAQ')}
        />
      </GroupedSection>

      {/* Reputation history */}
      <GroupedSection title={t('trust.center.history') || 'Reputation History'}>
        {transactions.length === 0 ? (
          <GroupedSectionItem
            icon={<SettingsIcon name="history" color={bloomTheme.colors.textTertiary} />}
            title={t('trust.center.noHistory') || 'No reputation history yet.'}
            showChevron={false}
            disabled
          />
        ) : (
          transactions.map((entry) => (
            <GroupedSectionItem
              key={entry.id}
              icon={
                <SettingsIcon
                  name={entry.points > 0 ? 'plus-circle' : 'minus-circle'}
                  color={entry.points > 0 ? bloomTheme.colors.success : bloomTheme.colors.error}
                />
              }
              title={
                entry.reason ||
                entry.actionType ||
                t('trust.center.noDescription') ||
                'No description'
              }
              description={`${entry.category}${
                entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleString()}` : ''
              }`}
              rightElement={
                <Chip variant="subtle" size="sm" color={entry.points > 0 ? 'success' : 'error'}>
                  {`${entry.points > 0 ? '+' : ''}${entry.points}`}
                </Chip>
              }
              showChevron={false}
            />
          ))
        )}
      </GroupedSection>

      {error ? (
        <Text style={[styles.text2, { color: bloomTheme.colors.error }]}>{error}</Text>
      ) : null}
    </View>
  );
};

// Layout-only styles: the info caption's measured max width. No color, spacing,
// radius, or typography roles live here — those use Bloom token classes.
const styles = StyleSheet.create({
  infoText: {
    maxWidth: 320,
  },

  container: { alignItems: 'center', paddingVertical: 40 },
  section: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 },
  text2: { marginTop: 16, textAlign: 'center', fontSize: 14, lineHeight: 20 },
});

export default TrustCenterScreen;

const useThemedStyles = createTokenStyles((t) => ({
  text: { fontSize: 16, fontWeight: 500, color: t.foreground, lineHeight: 24 },
  surface: {
    marginBottom: 16,
    alignItems: 'center',
    borderRadius: 20,
    backgroundColor: t.muted,
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  mutedText: {
    marginTop: 2,
    marginBottom: 12,
    fontSize: 16,
    color: t.mutedForeground,
    lineHeight: 24,
  },
  mutedText2: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
}));
