import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAction, useRecord } from '@oxy.so/bloom-data';
import type { Organization, OrganizationType, UpdateOrganization } from '@oxy.so/contracts';
import { updateOrganizationCheck, checkContract } from '@oxy.so/contracts/client';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { GroupedSection } from '@oxy.so/bloom/grouped-section';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { useQueryClient } from '../../hooks/useQueryClient';
import { organization as organizationSource, updateOrganization } from '../../data/organizations';
import { OrganizationTypePicker } from './OrganizationTypePicker';

export function OrganizationSettings({
  accountId,
  canUpdate,
}: {
  accountId: string;
  canUpdate: boolean;
}) {
  const { oxyServices, canUsePrivateApi } = useOxy();
  const { t } = useI18n();
  const organization = useRecord(organizationSource, oxyServices, accountId);
  if (organization.isLoading) return <ActivityIndicator />;
  if (organization.status === 'error' || !organization.value)
    return (
      <View>
        <Text accessibilityRole="alert">{t('organizationDirectory.failed')}</Text>
        <Button onPress={() => organization.refresh()}>{t('organizationDirectory.retry')}</Button>
      </View>
    );
  if (!canUpdate || !canUsePrivateApi)
    return (
      <GroupedSection title={t('organizationDirectory.title')}>
        <Text>{t(`organizationDirectory.types.${organization.value.organizationType}`)}</Text>
        <Text>{t('organizationDirectory.readonly')}</Text>
      </GroupedSection>
    );
  return (
    <OrganizationForm
      key={`${accountId}:${organization.value.updatedAt}`}
      organization={organization.value}
    />
  );
}

function OrganizationForm({ organization }: { organization: Organization }) {
  const { oxyServices, canUsePrivateApi } = useOxy();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState(organization.legalName ?? '');
  const [website, setWebsite] = useState(organization.websiteUrl ?? '');
  const [country, setCountry] = useState(organization.countryCode ?? '');
  const [type, setType] = useState<OrganizationType>(organization.organizationType);
  const [invalid, setInvalid] = useState(false);
  const save = useAction(updateOrganization);
  const submit = async (input: UpdateOrganization) => {
    try {
      await save.run(oxyServices, () => {
        if (!canUsePrivateApi) throw new Error('An authenticated session is required');
        return { accountId: organization.accountId, input };
      });
    } catch {
      return; // `save.error` shows it.
    }
    toast.success(t('organizationDirectory.saved'));
    // The organization's account and person records carry its name and kind.
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  return (
    <GroupedSection title={t('organizationDirectory.title')}>
      <View className="gap-space-16 p-space-16">
        <TextField>
          <TextFieldInput
            label={t('organizationDirectory.legalName')}
            value={legalName}
            onChangeText={setLegalName}
            maxLength={300}
          />
        </TextField>
        <TextField>
          <TextFieldInput
            label={t('organizationDirectory.website')}
            value={website}
            onChangeText={setWebsite}
            autoCapitalize="none"
            maxLength={2048}
          />
        </TextField>
        <TextField>
          <TextFieldInput
            label={t('organizationDirectory.country')}
            value={country}
            onChangeText={setCountry}
            autoCapitalize="characters"
            maxLength={2}
          />
        </TextField>
        <OrganizationTypePicker value={type} onChange={setType} disabled={save.isPending} />
        {invalid ? (
          <Text accessibilityRole="alert">{t('organizationDirectory.invalid')}</Text>
        ) : null}
        {save.error ? (
          <Text accessibilityRole="alert">{t('organizationDirectory.saveFailed')}</Text>
        ) : null}
        <Button
          disabled={save.isPending || !canUsePrivateApi}
          loading={save.isPending}
          onPress={() => {
            const input = checkContract(updateOrganizationCheck, {
              legalName: legalName.trim() || null,
              websiteUrl: website.trim() || null,
              countryCode: country.trim().toUpperCase() || null,
              organizationType: type,
            });
            setInvalid(input === null);
            if (input) void submit(input);
          }}
        >
          {t('organizationDirectory.save')}
        </Button>
      </View>
    </GroupedSection>
  );
}
