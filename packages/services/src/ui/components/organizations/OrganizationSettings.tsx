import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  updateOrganizationSchema,
  type Organization,
  type OrganizationType,
} from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
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
  const organization = useQuery({
    queryKey: ['oxy', 'organizations', accountId],
    queryFn: () => oxyServices.organizations.get(accountId),
    retry: false,
  });
  if (organization.isPending) return <ActivityIndicator />;
  if (organization.isError)
    return (
      <View>
        <Text accessibilityRole="alert">{t('organizationDirectory.failed')}</Text>
        <Button onPress={() => organization.refetch()}>{t('organizationDirectory.retry')}</Button>
      </View>
    );
  if (!canUpdate || !canUsePrivateApi)
    return (
      <SettingsListGroup title={t('organizationDirectory.title')}>
        <Text>{t(`organizationDirectory.types.${organization.data.organizationType}`)}</Text>
        <Text>{t('organizationDirectory.readonly')}</Text>
      </SettingsListGroup>
    );
  return (
    <OrganizationForm
      key={`${accountId}:${organization.data.updatedAt}`}
      organization={organization.data}
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
  const save = useMutation({
    mutationFn: (input: ReturnType<typeof updateOrganizationSchema.parse>) => {
      if (!canUsePrivateApi) throw new Error('An authenticated session is required');
      return oxyServices.organizations.update(organization.accountId, input);
    },
    onSuccess: () => {
      toast.success(t('organizationDirectory.saved'));
      void queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <SettingsListGroup title={t('organizationDirectory.title')}>
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
        {save.isError ? (
          <Text accessibilityRole="alert">{t('organizationDirectory.saveFailed')}</Text>
        ) : null}
        <Button
          disabled={save.isPending || !canUsePrivateApi}
          loading={save.isPending}
          onPress={() => {
            const input = updateOrganizationSchema.safeParse({
              legalName: legalName.trim() || null,
              websiteUrl: website.trim() || null,
              countryCode: country.trim().toUpperCase() || null,
              organizationType: type,
            });
            setInvalid(!input.success);
            if (input.success) save.mutate(input.data);
          }}
        >
          {t('organizationDirectory.save')}
        </Button>
      </View>
    </SettingsListGroup>
  );
}
