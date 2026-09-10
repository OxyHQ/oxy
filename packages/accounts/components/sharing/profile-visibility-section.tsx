import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { RouteName } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, Switch } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

type ShowBottomSheet = (
  screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> },
) => void;

interface ProfileVisibilitySectionProps {
  showBottomSheet?: ShowBottomSheet;
  profileVisibility: boolean;
  pendingPrivacyKey: string | null;
  onPrivacyUpdate: (key: string, value: boolean) => void;
}

/**
 * "About me" section: the profile-visibility toggle, a link to what others see,
 * and a shortcut into the full privacy settings bottom sheet. Extracted from the
 * People & Sharing screen (the inline `profileVisibilityItems` memo lives here).
 */
export function ProfileVisibilitySection({
  showBottomSheet,
  profileVisibility,
  pendingPrivacyKey,
  onPrivacyUpdate,
}: ProfileVisibilitySectionProps) {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  const profileVisibilityItems = useMemo<GroupedItem[]>(() => {
    const items: GroupedItem[] = [];

    // Profile visibility toggle
    items.push({
      id: 'profile-visibility',
      icon: 'eye-outline',
      iconColor: colors.sidebarIconData,
      title: t('sharing.privacy.profileVisibility'),
      subtitle: profileVisibility
        ? t('sharing.privacy.profileVisibilityOn')
        : t('sharing.privacy.profileVisibilityOff'),
      customContent: (
        <Switch
          value={profileVisibility}
          onValueChange={(value) => onPrivacyUpdate('profileVisibility', value)}
          disabled={pendingPrivacyKey === 'profileVisibility'}
        />
      ),
    });

    // What others see
    items.push({
      id: 'about-me',
      icon: 'account-details-outline',
      iconColor: colors.sidebarIconData,
      title: t('sharing.privacy.aboutMe'),
      subtitle: t('sharing.privacy.aboutMeSubtitle'),
      onPress: () => router.push('/(tabs)/personal-info'),
      showChevron: true,
    });

    // Full privacy settings via bottom sheet
    items.push({
      id: 'privacy-settings',
      icon: 'shield-lock-outline',
      iconColor: colors.sidebarIconData,
      title: t('sharing.privacy.allSettings'),
      subtitle: t('sharing.privacy.allSettingsSubtitle'),
      onPress: () => {
        showBottomSheet?.({ screen: 'PrivacySettings' });
      },
      showChevron: true,
    });

    return items;
  }, [colors, profileVisibility, onPrivacyUpdate, pendingPrivacyKey, router, showBottomSheet, t]);

  return (
    <Section title={t('sharing.sections.aboutMe')}>
      <Text style={[styles.sectionSubtitle, { color: colors.text }]}>
        {t('sharing.sections.aboutMeSubtitle')}
      </Text>
      <AccountCard>
        <GroupedSection items={profileVisibilityItems} />
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
