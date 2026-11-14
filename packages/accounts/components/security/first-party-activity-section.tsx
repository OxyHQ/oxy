import { StyleSheet } from 'react-native';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { ThemedText } from '@/components/themed-text';
import { AccountCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useTranslation } from '@/lib/i18n';
import { summarizeFirstPartyActivity, useFirstPartyActivity } from '@/hooks/useFirstPartyActivity';

/**
 * "What Oxy apps did for you" on the security screen (ADR 0066). Oxy's own
 * apps never ask for permissions; what each one does for the person is
 * declared in Oxy's code and listed here as it happens. Turning a feature off
 * is done in the app that offers it.
 */
export function FirstPartyActivitySection() {
  const colors = useColors();
  const { t } = useTranslation();
  const formatRelativeTime = useRelativeTime();
  const { data } = useFirstPartyActivity();
  const rows = data ? summarizeFirstPartyActivity(data) : [];

  return (
    <Section title={t('security.sections.firstPartyActivity')}>
      <ThemedText style={styles.sectionSubtitle}>{t('firstPartyActivity.explainer')}</ThemedText>
      {rows.length > 0 ? (
        <AccountCard>
          <GroupedSection
            items={rows.map((row) => ({
              id: row.key,
              icon: row.effect === 'write' ? 'pencil-outline' : 'eye-outline',
              iconColor: colors.sidebarIconSecurity,
              title: row.applicationName,
              subtitle: t('firstPartyActivity.row', {
                purpose: row.purpose ?? t('firstPartyActivity.noLongerDeclared'),
                count: row.count,
                time: formatRelativeTime(row.lastAt),
              }),
            }))}
          />
        </AccountCard>
      ) : (
        <ThemedText style={styles.empty}>
          {data ? t('firstPartyActivity.empty') : t('firstPartyActivity.pending')}
        </ThemedText>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
  },
  empty: {
    fontSize: 14,
    opacity: 0.6,
  },
});
