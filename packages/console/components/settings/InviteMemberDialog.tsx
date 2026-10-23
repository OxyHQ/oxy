import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { type AssignableAccountRole, useInviteAccountMember } from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

export const ASSIGNABLE_ROLES: ReadonlyArray<AssignableAccountRole> = [
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
];

/** Invite someone to the workspace by username or email, with a role. */
export function InviteMemberDialog({
  accountId,
  open,
  onClose,
  onInvited,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  /** Called after the invite succeeded or failed, so the pending list can refresh. */
  onInvited: () => void;
}) {
  const { t } = useTranslation();
  const invite = useInviteAccountMember();
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<AssignableAccountRole>('editor');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setIdentifier('');
    setRole('editor');
    setError(null);
    onClose();
  };

  const submit = async () => {
    const usernameOrEmail = identifier.trim();
    if (!usernameOrEmail) {
      setError(t('settingsPage.invite.required'));
      return;
    }
    setError(null);
    try {
      await invite.mutateAsync({ accountId, usernameOrEmail, role });
      toast.success(t('settingsPage.invite.sent'));
      close();
    } catch (failure) {
      toast.error(getErrorMessage(failure, t('settingsPage.invite.failed')));
    }
    onInvited();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('settingsPage.invite.title')}
      description={t('settingsPage.invite.description')}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t('settingsPage.invite.send'),
          onPress: () => void submit(),
          loading: invite.isPending,
          disabled: invite.isPending || !identifier.trim(),
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-4 py-2">
        <Field label={t('settingsPage.invite.email')} error={error}>
          <TextFieldInput
            label={t('settingsPage.invite.email')}
            value={identifier}
            onChangeText={(text) => {
              setIdentifier(text);
              if (error) setError(null);
            }}
            onSubmitEditing={() => void submit()}
            placeholder={t('settingsPage.invite.placeholder')}
            invalid={error !== null}
            autoCapitalize="none"
          />
        </Field>
        <Field
          label={t('settingsPage.members.role')}
          description={t(`settingsPage.roleDescriptions.${role}`)}
        >
          <SettingsSelect
            label={t('settingsPage.members.role')}
            value={role}
            onChange={setRole}
            items={ASSIGNABLE_ROLES.map((value) => ({
              value,
              label: t(`settingsPage.roles.${value}`),
            }))}
          />
        </Field>
      </View>
    </Dialog>
  );
}
