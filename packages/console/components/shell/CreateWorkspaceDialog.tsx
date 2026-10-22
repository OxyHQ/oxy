import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';
import { create } from 'zustand';

import { useAccount } from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

const useCreateWorkspaceState = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

/** Open the dialog from anywhere (the workspace menu, the command menu). */
export function openCreateWorkspace(): void {
  useCreateWorkspaceState.getState().setOpen(true);
}

/** Creates an organization workspace and switches into it. Mount ONCE inside the shell. */
export function CreateWorkspaceDialog() {
  const { t } = useTranslation();
  const { createAccount, setCurrentAccount } = useAccount();
  const open = useCreateWorkspaceState((state) => state.open);
  const setOpen = useCreateWorkspaceState((state) => state.setOpen);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const close = () => {
    setOpen(false);
    setName('');
    setHandle('');
  };

  const submit = async () => {
    setIsCreating(true);
    try {
      const created = await createAccount({
        kind: 'organization',
        username: handle.trim(),
        name: { first: name.trim() },
      });
      await setCurrentAccount(created);
      toast.success(t('settingsPage.switcher.created', { name: name.trim() }));
      close();
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.switcher.createFailed')));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('settingsPage.switcher.create')}
      description={t('settingsPage.switcher.createDescription')}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t('common.create'),
          onPress: () => void submit(),
          loading: isCreating,
          disabled: isCreating || !name.trim() || !handle.trim(),
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-4 py-2">
        <TextFieldInput
          label={t('settingsPage.switcher.accountName')}
          value={name}
          onChangeText={setName}
          placeholder="My Team"
          maxLength={50}
        />
        <TextFieldInput
          label={t('settingsPage.switcher.handle')}
          value={handle}
          onChangeText={setHandle}
          placeholder="my-team"
          maxLength={50}
          autoCapitalize="none"
        />
      </View>
    </Dialog>
  );
}
