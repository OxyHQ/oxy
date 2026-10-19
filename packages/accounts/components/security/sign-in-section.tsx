import React from 'react';
import { StyleSheet } from 'react-native';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { ThemedText } from '@/components/themed-text';
import { AccountCard } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

interface SignInSectionProps {
  items: GroupedItem[];
}

/**
 * "On this device" section: what this app asks before it opens (the biometric
 * row). Nothing on the web, where there is none. How the ACCOUNT signs in is
 * the SDK's `OxySignInSecurityPanel`, above it.
 */
export function SignInSection({ items }: SignInSectionProps) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return null;
  }

  return (
    <Section title={t('security.sections.thisDevice')}>
      <ThemedText style={styles.sectionSubtitle}>
        {t('security.sections.thisDeviceSubtitle')}
      </ThemedText>
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
