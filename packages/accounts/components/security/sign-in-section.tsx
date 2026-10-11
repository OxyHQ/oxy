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
 * "How you sign in" section: a subtitle plus the biometric / public-key
 * sign-in rows. Extracted from the security screen's `renderContent`.
 */
export function SignInSection({ items }: SignInSectionProps) {
  const { t } = useTranslation();

  return (
    <Section title={t('security.sections.howYouSignIn')}>
      <ThemedText style={styles.sectionSubtitle}>
        {t('security.sections.howYouSignInSubtitle')}
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
