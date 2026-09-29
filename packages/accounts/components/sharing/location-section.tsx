import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, Switch } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

interface LocationSectionProps {
  locationSharing: boolean;
  pendingPrivacyKey: string | null;
  onPrivacyUpdate: (key: string, value: boolean) => void;
}

/**
 * Location sharing section: a single toggle backed by the same privacy-settings
 * API used elsewhere. Extracted from the People & Sharing screen (the inline
 * `locationItems` memo lives here).
 */
export function LocationSection({
  locationSharing,
  pendingPrivacyKey,
  onPrivacyUpdate,
}: LocationSectionProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const locationItems = useMemo<GroupedItem[]>(() => {
    const items: GroupedItem[] = [];

    items.push({
      id: 'location-sharing',
      icon: 'map-marker-outline',
      iconColor: colors.success,
      title: t('sharing.privacy.locationSharing'),
      subtitle: locationSharing
        ? t('sharing.privacy.locationSharingOn')
        : t('sharing.privacy.locationSharingOff'),
      customContent: (
        <Switch
          checked={locationSharing}
          onCheckedChange={(value) => onPrivacyUpdate('locationSharing', value)}
          disabled={pendingPrivacyKey === 'locationSharing'}
        />
      ),
    });

    return items;
  }, [colors, locationSharing, onPrivacyUpdate, pendingPrivacyKey, t]);

  return (
    <Section title={t('sharing.sections.location')}>
      <Text style={[styles.sectionSubtitle, { color: colors.text }]}>
        {t('sharing.sections.locationSubtitle')}
      </Text>
      <AccountCard>
        <GroupedSection items={locationItems} />
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
