import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { isApplicationPermissionKey } from '@oxy.so/contracts';
import { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

/** Collects one new permission key and its description; the caller saves the list. */
export function DeclarePermissionDialog({
  open,
  existingKeys,
  saving,
  onClose,
  onDeclare,
}: {
  open: boolean;
  existingKeys: ReadonlyArray<string>;
  saving: boolean;
  onClose: () => void;
  /** Resolves true once the list was saved, which closes the dialog. */
  onDeclare: (permission: { key: string; description: string }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const trimmedKey = key.trim();
  const keyError =
    trimmedKey.length === 0
      ? undefined
      : !isApplicationPermissionKey(trimmedKey)
        ? t('applications.roles.keyInvalid')
        : existingKeys.includes(trimmedKey)
          ? t('applications.roles.keyDuplicate')
          : undefined;
  const ready = trimmedKey.length > 0 && !keyError && description.trim().length > 0;

  const close = () => {
    setKey('');
    setDescription('');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('applications.roles.add')}
      description={t('applications.roles.permissionsBody')}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: saving },
        {
          label: t('applications.roles.save'),
          disabled: !ready,
          loading: saving,
          shouldCloseOnPress: false,
          onPress: () => {
            void onDeclare({ key: trimmedKey, description: description.trim() }).then((saved) => {
              if (saved) close();
            });
          },
        },
      ]}
    >
      <View className="gap-4 pb-4">
        <Field label={t('applications.roles.key')} error={keyError}>
          <TextFieldInput
            label={t('applications.roles.key')}
            value={key}
            onChangeText={setKey}
            placeholder="payments.operate"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label={t('applications.roles.description')}>
          <TextFieldInput
            label={t('applications.roles.description')}
            value={description}
            onChangeText={setDescription}
            placeholder={t('applications.roles.descriptionPlaceholder')}
          />
        </Field>
      </View>
    </Dialog>
  );
}
