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
import { availableCredentialScopes } from '@/lib/application-scopes';
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
 * Both service credentials and API keys are external authority, even for an
 * Oxy application. They require explicit scopes from the application's ceiling.
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

  const needsScopes = type === 'service' || type === 'machine';
  const availableScopes = needsScopes ? availableCredentialScopes(application, type) : [];
  // A concurrent ceiling change cannot leave a selected scope outside the current list.
  const selectedScopes = scopes.filter((scope) => availableScopes.includes(scope));
  const blocked = !name.trim() || (needsScopes && selectedScopes.length === 0);

  const close = () => {
    setName('');
    setType('confidential');
    setEnvironment('development');
    setScopes([]);
    onClose();
  };

  const chooseType = (next: ApplicationCredentialType) => {
    setType(next);
    setScopes([]);
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
    if (blocked || createCredential.isPending) return;
    try {
      const result = await createCredential.mutateAsync({
        appId: application._id,
        data: {
          name: name.trim(),
          type,
          environment,
          ...(needsScopes ? { scopes: selectedScopes } : {}),
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
        {needsScopes ? (
          <>
            <Admonition type="info">
              {t('applications.credentials.externalCredentialBody')}
            </Admonition>
            {availableScopes.length > 0 ? (
              <GroupedSection
                title={t('applications.credentials.scopes')}
                footer={t('applications.credentials.explicitScopes')}
              >
                {availableScopes.map((scope) => (
                  <GroupedSectionItem
                    key={scope}
                    title={scope}
                    rightElement={
                      <Switch
                        checked={selectedScopes.includes(scope)}
                        onCheckedChange={(checked) => toggle(scope, checked)}
                        accessibilityLabel={scope}
                      />
                    }
                  />
                ))}
              </GroupedSection>
            ) : (
              <Admonition type="info">{t('applications.credentials.grantScopeFirst')}</Admonition>
            )}
          </>
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
