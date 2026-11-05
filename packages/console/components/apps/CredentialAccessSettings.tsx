import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';

import {
  type Application,
  type CallerAccess,
  useUpdateApplication,
} from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import {
  hasAliaMachineScopes,
  isOxyApplication,
  nextApplicationScopes,
} from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';
import { arraysEqual } from './general-draft';

/** Registered workloads and external credentials have separate authority. */
export function CredentialAccessSettings({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const update = useUpdateApplication();
  const canEdit = access.can('app:update');
  // Untouched controls preserve the stored ceiling, including partial Alia grants.
  const [paymentsRead, setPaymentsRead] = useState<boolean | null>(null);
  const [paymentsWrite, setPaymentsWrite] = useState<boolean | null>(null);
  const [aliaMachineAccess, setAliaMachineAccess] = useState<boolean | null>(null);
  const choices = {
    paymentsRead: paymentsRead ?? application.scopes.includes('payments:read'),
    paymentsWrite: paymentsWrite ?? application.scopes.includes('payments:write'),
    aliaMachineAccess,
  };
  const scopes = nextApplicationScopes(application.scopes, choices);
  const dirty = !arraysEqual(scopes, application.scopes);
  const reset = () => {
    setPaymentsRead(null);
    setPaymentsWrite(null);
    setAliaMachineAccess(null);
  };
  const save = async () => {
    if (!canEdit || !dirty || update.isPending) return;
    try {
      await update.mutateAsync({ appId: application._id, data: { scopes } });
      reset();
      toast.success(t('applications.credentials.accessSaved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.general.saveFailed')));
    }
  };

  return (
    <>
      {isOxyApplication(application) ? (
        <Card appearance="plain" border="thin">
          <CardHeader>
            <CardTitle>{t('applications.credentials.workloadTitle')}</CardTitle>
            <CardDescription>{t('applications.credentials.workloadBody')}</CardDescription>
          </CardHeader>
          <CardBody>
            <Text>{t('applications.credentials.workloadAudience')}</Text>
            <Text className="font-mono">{`oxy-service:${application._id}`}</Text>
          </CardBody>
        </Card>
      ) : null}
      <Card appearance="plain" border="thin">
        <CardHeader>
          <CardTitle>{t('applications.credentials.accessTitle')}</CardTitle>
          <CardDescription>{t('applications.credentials.accessBody')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <GroupedSection title={t('applications.credentials.paymentsTitle')}>
              <GroupedSectionItem
                title="payments:read"
                description={t('applications.scopes.paymentsRead')}
                rightElement={
                  <Switch
                    checked={choices.paymentsRead}
                    onCheckedChange={setPaymentsRead}
                    disabled={!canEdit}
                    accessibilityLabel="payments:read"
                  />
                }
              />
              <GroupedSectionItem
                title="payments:write"
                description={t('applications.scopes.paymentsWrite')}
                rightElement={
                  <Switch
                    checked={choices.paymentsWrite}
                    onCheckedChange={setPaymentsWrite}
                    disabled={!canEdit}
                    accessibilityLabel="payments:write"
                  />
                }
              />
            </GroupedSection>
            <GroupedSection
              title={t('applications.credentials.aliaTitle')}
              footer={t('applications.credentials.aliaBody')}
            >
              <GroupedSectionItem
                title="alia:chat + inference:invoke"
                rightElement={
                  <Switch
                    checked={aliaMachineAccess ?? hasAliaMachineScopes(application.scopes)}
                    onCheckedChange={setAliaMachineAccess}
                    disabled={!canEdit}
                    accessibilityLabel={t('applications.credentials.aliaTitle')}
                  />
                }
              />
            </GroupedSection>
            {canEdit ? (
              <View className="flex-row justify-end gap-2">
                <Button appearance="outline" disabled={!dirty || update.isPending} onPress={reset}>
                  {t('applications.general.discard')}
                </Button>
                <Button disabled={!dirty} loading={update.isPending} onPress={() => void save()}>
                  {t('applications.credentials.saveAccess')}
                </Button>
              </View>
            ) : null}
          </View>
        </CardBody>
      </Card>
    </>
  );
}
