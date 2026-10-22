import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import { useGrantApplicationPermission } from '@/hooks/use-application-roles';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/** Grants one of the application's declared permissions to a person by username. */
export function GrantPermissionDialog({
  appId,
  keys,
  open,
  onClose,
}: {
  appId: string;
  keys: ReadonlyArray<string>;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const grant = useGrantApplicationPermission();
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('');
  const [reason, setReason] = useState('');

  const close = () => {
    setUsername('');
    setPermission('');
    setReason('');
    onClose();
  };

  const submit = async () => {
    try {
      await grant.mutateAsync({
        appId,
        username: username.trim().replace(/^@/, ''),
        permission,
        reason: reason.trim() || undefined,
      });
      close();
      toast.success(t('applications.roles.granted'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.grantFailed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('applications.roles.grantTitle')}
      description={t('applications.roles.grantHint')}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: grant.isPending },
        {
          label: t('applications.roles.grant'),
          onPress: () => void submit(),
          disabled: !username.trim() || !permission,
          loading: grant.isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-4">
        <Field label={t('applications.roles.username')}>
          <TextFieldInput
            label={t('applications.roles.username')}
            value={username}
            onChangeText={setUsername}
            placeholder="@username"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label={t('applications.roles.permission')}>
          <Select value={permission} onValueChange={setPermission}>
            <SelectTrigger label={t('applications.roles.permission')}>
              <SelectValue placeholder={t('applications.roles.permissionPlaceholder')} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent
              label={t('applications.roles.permission')}
              items={keys.map((key) => ({ value: key, label: key }))}
              renderItem={(item) => (
                <SelectItem value={item.value} label={item.label}>
                  <SelectItemIndicator />
                  <SelectItemText>{item.label}</SelectItemText>
                </SelectItem>
              )}
            />
          </Select>
        </Field>
        <Field label={t('applications.roles.reason')}>
          <TextFieldInput
            label={t('applications.roles.reason')}
            value={reason}
            onChangeText={setReason}
            placeholder={t('applications.roles.reasonPlaceholder')}
          />
        </Field>
      </View>
    </Dialog>
  );
}
