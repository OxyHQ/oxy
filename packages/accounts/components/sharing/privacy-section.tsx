import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { RouteName } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

type ShowBottomSheet = (
  screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> },
) => void;

interface PrivacySectionProps {
  showBottomSheet?: ShowBottomSheet;
  blockedCount: number;
  restrictedCount: number;
}

/**
 * Privacy & blocking section: blocked and restricted user rows. Both open the
 * PrivacySettings bottom sheet, which owns the full management UI. Extracted
 * from the People & Sharing screen (the inline `privacyItems` memo lives here).
 */
export function PrivacySection({
  showBottomSheet,
  blockedCount,
  restrictedCount,
}: PrivacySectionProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const privacyItems = useMemo<GroupedItem[]>(() => {
    const items: GroupedItem[] = [];

    // Blocked users
    items.push({
      id: 'blocked',
      icon: 'account-cancel-outline',
      iconColor: colors.error,
      title: t('sharing.privacy.blocked'),
      subtitle: blockedCount > 0
        ? t('sharing.privacy.blockedCount', { count: blockedCount })
        : t('sharing.privacy.blockedEmpty'),
      onPress: () => {
        showBottomSheet?.({ screen: 'PrivacySettings' });
      },
      showChevron: true,
    });

    // Restricted users
    items.push({
      id: 'restricted',
      icon: 'account-lock-outline',
      iconColor: colors.warning,
      title: t('sharing.privacy.restricted'),
      subtitle: restrictedCount > 0
        ? t('sharing.privacy.restrictedCount', { count: restrictedCount })
        : t('sharing.privacy.restrictedEmpty'),
      onPress: () => {
        showBottomSheet?.({ screen: 'PrivacySettings' });
      },
      showChevron: true,
    });

    return items;
  }, [colors, blockedCount, restrictedCount, showBottomSheet, t]);

  return (
    <Section title={t('sharing.sections.blocking')}>
      <Text style={[styles.sectionSubtitle, { color: colors.text }]}>
        {t('sharing.sections.blockingSubtitle')}
      </Text>
      <AccountCard>
        <GroupedSection items={privacyItems} />
      </AccountCard>
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
    marginBottom: 8,
  },
});
