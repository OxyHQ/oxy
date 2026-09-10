import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { showBottomSheet, useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { ThemedText } from '@/components/themed-text';
import { AccountCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

/**
 * App language section: a subtitle and a single row showing the active
 * language that opens the language selector bottom sheet on tap.
 *
 * Extracted from the security screen's `renderContent` (the inline
 * `languageItems` memo now lives here).
 */
export function LanguageSection() {
  const colors = useColors();
  const { t } = useTranslation();
  const { currentLanguage } = useOxy();

  const items = useMemo<GroupedItem[]>(() => [{
    id: 'app-language',
    icon: 'translate',
    iconColor: colors.sidebarIconData,
    title: t('security.language.label'),
    // Reflect the account's actual primary locale (its native endonym),
    // which may be a region variant the app UI itself does not ship.
    subtitle: getNativeLanguageName(currentLanguage),
    onPress: () => showBottomSheet('LanguageSelector'),
    showChevron: true,
  }], [colors.sidebarIconData, t, currentLanguage]);

  return (
    <Section title={t('security.sections.language')}>
      <ThemedText style={styles.sectionSubtitle}>{t('security.sections.languageSubtitle')}</ThemedText>
      <AccountCard>
        <GroupedSection items={items} />
      </AccountCard>
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
  },
});
