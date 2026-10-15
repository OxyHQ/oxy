import { ORGANIZATION_TYPES, type OrganizationType } from '@oxy.so/contracts';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Text } from '@oxy.so/bloom/typography';
import { useI18n } from '../../hooks/useI18n';

export function OrganizationTypePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: OrganizationType;
  onChange: (value: OrganizationType) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SettingsListGroup title={t('organizationDirectory.type')}>
      {ORGANIZATION_TYPES.map((type) => (
        <SettingsListItem
          key={type}
          title={t(`organizationDirectory.types.${type}`)}
          accessibilityLabel={t(`organizationDirectory.types.${type}`)}
          disabled={disabled}
          onPress={() => onChange(type)}
          showChevron={false}
          rightElement={value === type ? <Text>✓</Text> : undefined}
        />
      ))}
    </SettingsListGroup>
  );
}
