import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { useAccount } from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/** Archive the workspace after typing its name; 409 means it still owns apps. */
export function ArchiveAccountDialog({
  accountId,
  label,
  open,
  onClose,
  onArchived,
}: {
  accountId: string;
  label: string;
  open: boolean;
  onClose: () => void;
  onArchived: () => void;
}) {
  const { t } = useTranslation();
  const { accounts, currentAccount, setCurrentAccount, archiveAccount } = useAccount();
  const [confirmation, setConfirmation] = useState('');
  const [isArchiving, setIsArchiving] = useState(false);

  const close = () => {
    setConfirmation('');
    onClose();
  };

  const archive = async () => {
    if (confirmation !== label) {
      toast.error(t('settingsPage.archive.confirmMismatch'));
      return;
    }
    setIsArchiving(true);
    try {
      await archiveAccount(accountId);
      if (currentAccount?.accountId === accountId) {
        const personal = accounts.find((node) => node.relationship === 'self');
        if (personal) await setCurrentAccount(personal);
      }
      toast.success(t('settingsPage.archive.archived'));
      close();
      onArchived();
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.archive.failed')));
    } finally {
      setIsArchiving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('settingsPage.archive.action')}
      description={t('settingsPage.archive.confirmBody', { name: label })}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t('settingsPage.archive.confirmAction'),
          color: 'destructive',
          onPress: () => void archive(),
          loading: isArchiving,
          disabled: isArchiving || confirmation !== label,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <Field label={t('settingsPage.archive.typeToConfirm', { name: label })}>
        <TextFieldInput
          label={t('settingsPage.archive.confirmLabel')}
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder={label}
        />
      </Field>
    </Dialog>
  );
}
