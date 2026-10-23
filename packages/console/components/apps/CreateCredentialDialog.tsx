import { Admonition } from '@oxy.so/bloom/admonition';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import type {
  Application,
  ApplicationCredentialType,
  ApplicationEnvironment,
  CredentialWithSecret,
} from '@/hooks/use-applications';
import { useCreateCredential } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import {
  availablePaymentsScopes,
  isUntrustedThirdPartyApp,
  PAYMENTS_SCOPES,
} from '@/lib/application-scopes';
import { useTranslation } from '@/lib/i18n';

const TYPES: ReadonlyArray<ApplicationCredentialType> = [
  'public',
  'confidential',
  'service',
  'machine',
];
const ENVIRONMENTS: ReadonlyArray<ApplicationEnvironment> = [
  'development',
  'staging',
  'production',
];

/**
 * Creates a credential and hands the one-time result to `onCreated`.
 *
 * Which scopes a type takes follows the API: a `service` credential of an
 * untrusted third-party application must name payments scopes, and a `machine`
 * (API key) credential must name at least one scope — the API refuses a
 * scopeless one rather than defaulting it to the application's whole grant.
 */
export function CreateCredentialDialog({
  application,
  open,
  onClose,
  onCreated,
}: {
  application: Application;
  open: boolean;
  onClose: () => void;
  onCreated: (result: CredentialWithSecret) => void;
}) {
  const { t } = useTranslation();
  const createCredential = useCreateCredential();
  const [name, setName] = useState('');
  const [type, setType] = useState<ApplicationCredentialType>('confidential');
  const [environment, setEnvironment] = useState<ApplicationEnvironment>('development');
  const [scopes, setScopes] = useState<Array<string>>([]);

  const paymentsScopes = availablePaymentsScopes(application.scopes);
  const requiresPayments = type === 'service' && isUntrustedThirdPartyApp(application);
  const isMachine = type === 'machine';
  const blocked = !name.trim() || ((requiresPayments || isMachine) && scopes.length === 0);

  const close = () => {
    setName('');
    setType('confidential');
    setEnvironment('development');
    setScopes([]);
    onClose();
  };

  const chooseType = (next: ApplicationCredentialType) => {
    setType(next);
    setScopes(next === 'service' ? paymentsScopes : []);
  };

  const toggle = (scope: string, enabled: boolean) =>
    setScopes((current) =>
      enabled
        ? current.includes(scope)
          ? current
          : [...current, scope]
        : current.filter((item) => item !== scope),
    );

  const handleCreate = async () => {
    try {
      const result = await createCredential.mutateAsync({
        appId: application._id,
        data: {
          name: name.trim(),
          type,
          environment,
          ...((type === 'service' || isMachine) && scopes.length > 0 ? { scopes } : {}),
        },
      });
      close();
      onCreated(result);
      toast.success(t('applications.credentials.created'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.createFailed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('applications.credentials.createTitle')}
      description={t('applications.credentials.createBody')}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: createCredential.isPending },
        {
          label: t('applications.credentials.create'),
          onPress: () => void handleCreate(),
          disabled: blocked,
          loading: createCredential.isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-4 pb-4">
        <Field label={t('applications.credentials.name')}>
          <TextFieldInput
            label={t('applications.credentials.name')}
            value={name}
            onChangeText={setName}
            placeholder={t('applications.credentials.namePlaceholder')}
          />
        </Field>
        <Field label={t('applications.credentials.type')}>
          <RadioGroup
            label={t('applications.credentials.type')}
            variant="card"
            value={type}
            onValueChange={chooseType}
            options={TYPES.map((value) => ({
              value,
              label: t(`applications.credentials.types.${value}`),
              description: t(`applications.credentials.typeHints.${value}`),
            }))}
          />
        </Field>
        {type === 'service' ? (
          paymentsScopes.length > 0 ? (
            <GroupedSection
              title={t('applications.credentials.scopes')}
              footer={
                requiresPayments ? t('applications.credentials.thirdPartyPayments') : undefined
              }
            >
              {PAYMENTS_SCOPES.filter((scope) => paymentsScopes.includes(scope)).map((scope) => (
                <GroupedSectionItem
                  key={scope}
                  title={scope}
                  description={
                    scope === 'payments:read'
                      ? t('applications.scopes.paymentsRead')
                      : t('applications.scopes.paymentsWrite')
                  }
                  rightElement={
                    <Switch
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) => toggle(scope, checked)}
                      accessibilityLabel={scope}
                    />
                  }
                />
              ))}
            </GroupedSection>
          ) : (
            <Admonition type="info">{t('applications.credentials.enablePayments')}</Admonition>
          )
        ) : null}
        {isMachine ? (
          application.scopes.length > 0 ? (
            <GroupedSection
              title={t('applications.credentials.scopes')}
              footer={t('applications.credentials.apiKeyHint')}
            >
              {application.scopes.map((scope) => (
                <GroupedSectionItem
                  key={scope}
                  title={scope}
                  rightElement={
                    <Switch
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) => toggle(scope, checked)}
                      accessibilityLabel={scope}
                    />
                  }
                />
              ))}
            </GroupedSection>
          ) : (
            <Admonition type="info">{t('applications.credentials.grantScopeFirst')}</Admonition>
          )
        ) : null}
        <Field label={t('applications.credentials.environment')}>
          <RadioGroup
            label={t('applications.credentials.environment')}
            variant="chip"
            value={environment}
            onValueChange={setEnvironment}
            options={ENVIRONMENTS.map((value) => ({
              value,
              label: t(`applications.credentials.environments.${value}`),
            }))}
          />
        </Field>
      </View>
    </Dialog>
  );
}
