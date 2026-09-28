/**
 * Setting or changing the account's password, from its settings. A password
 * is optional: the account signs in with a code by email without one. The
 * change is confirmed with the current password (when there is one) or a code
 * sent to the account's email, plus the authenticator's code when it has one.
 */

import type React from 'react';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Field } from '@oxy.so/bloom/field';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@oxy.so/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/OxyContext';
import { useSignInMethods } from '../../hooks/queries/useAuthMethods';
import { queryKeys } from '../../hooks/queries/queryKeys';
import { useI18n } from '../../hooks/useI18n';
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import { AccountFlowField } from './accountFlowParts';

export interface OxyPasswordPanelProps {
  /** The password is saved. */
  onDone?: () => void;
  /** "Cancel". */
  onCancel?: () => void;
}

export const OxyPasswordPanel: React.FC<OxyPasswordPanelProps> = ({ onDone, onCancel }) => {
  const { t } = useI18n();
  const { oxyServices, user } = useOxy();
  const queryClient = useQueryClient();
  const keyed = Boolean(user?.publicKey);
  const methods = useSignInMethods({ enabled: !keyed });
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(false);

  if (keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('signInSecurity.password.title')} description={t('linkCommons.already')} />
      </OxyAuthScreen>
    );
  }
  if (!methods.data) return <OxyAuthLoading />;

  const hasPassword = methods.data.hasPassword;

  return (
    <ReauthStep
      title={hasPassword ? t('signInSecurity.password.changeTitle') : t('signInSecurity.password.setTitle')}
      description={t('signInSecurity.password.description', { min: PASSWORD_MIN_LENGTH })}
      action="change_password"
      allowPassword={hasPassword}
      totpEnabled={methods.data.totpEnabled}
      submitLabel={t('signInSecurity.password.save')}
      validate={() => {
        if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
          return t('signInSecurity.password.tooShort', { min: PASSWORD_MIN_LENGTH });
        }
        return password === repeat ? null : t('signInSecurity.password.mismatch');
      }}
      onSubmit={async (reauth) => {
        await oxyServices.auth.password.set({ newPassword: password, reauth, revokeOtherSessions: signOutOthers });
        void queryClient.invalidateQueries({ queryKey: queryKeys.signInMethods.all });
        toast.success(t('signInSecurity.password.saved'));
        onDone?.();
      }}
      secondary={onCancel ? { label: t('common.cancel'), onPress: onCancel } : undefined}
    >
      <AccountFlowField
        label={t('signInSecurity.password.newLabel')}
        value={password}
        onChange={setPassword}
        onSubmit={() => undefined}
        error={null}
        autoComplete="new-password"
        secureTextEntry
        testID="password-new"
      />
      <AccountFlowField
        label={t('signInSecurity.password.repeatLabel')}
        value={repeat}
        onChange={setRepeat}
        onSubmit={() => undefined}
        error={null}
        autoComplete="new-password"
        secureTextEntry
        autoFocus={false}
        testID="password-repeat"
      />
      {/* The field names the switch ("Sign out everywhere else, switch, off")
          and, on web, its label toggles it. One row: label, then the switch. */}
      <Field label={t('signInSecurity.password.signOutOthers')} style={styles.row}>
        <Switch value={signOutOthers} onValueChange={setSignOutOthers} testID="password-sign-out-others" />
      </Field>
    </ReauthStep>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
});
