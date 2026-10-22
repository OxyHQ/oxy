import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { type Application, useDeleteApplication } from '@/hooks/use-applications';
import { isDeleteConfirmed } from '@/lib/application-delete';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/**
 * Deleting an application deletes every file it owns at once (ADR 0043 D8), so
 * the person types its name; the API compares it the same way.
 */
export function DeleteApplicationDialog({
  application,
  open,
  onClose,
}: {
  application: Application;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const deleteApplication = useDeleteApplication();
  const [typed, setTyped] = useState('');
  const confirmed = isDeleteConfirmed(typed, application.name);

  const close = () => {
    setTyped('');
    onClose();
  };

  const handleDelete = async () => {
    if (!confirmed) return;
    try {
      await deleteApplication.mutateAsync({ appId: application._id, confirmName: typed });
      close();
      toast.success(t('applications.general.deleted'));
      router.replace('/apps');
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.general.deleteFailed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('applications.general.deleteTitle')}
      description={t('applications.general.deleteBody', { name: application.name })}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: deleteApplication.isPending },
        {
          label: t('common.delete'),
          color: 'destructive',
          onPress: () => void handleDelete(),
          disabled: !confirmed,
          loading: deleteApplication.isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <Field label={t('applications.general.deleteConfirmLabel', { name: application.name })}>
        <TextFieldInput
          label={t('applications.general.deleteConfirmLabel', { name: application.name })}
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
    </Dialog>
  );
}
