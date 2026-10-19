/**
 * Setting, changing or removing the account's password, from its settings. A
 * password is optional: the account signs in with a code by email without
 * one, and it can be removed while the account has an email. Each change is
 * confirmed with the current password (when there is one) or a code sent to
 * the account's email, plus the authenticator's code when it has one.
 */

import type React from 'react';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Field } from '@oxy.so/bloom/field';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@oxy.so/contracts/client';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/oxyRuntimeContext';
import { queryKeys } from '../../hooks/queries/queryKeys';
import { useI18n } from '../../hooks/useI18n';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import { AccountFlowField } from './accountFlowParts';
import { accountSecurityFallback, useAccountSecurityState } from './accountSecurityState';

export interface OxyPasswordPanelProps {
  /** The password is saved. */
  onDone?: () => void;
  /** "Cancel". */
  onCancel?: () => void;
}

export const OxyPasswordPanel: React.FC<OxyPasswordPanelProps> = ({ onDone, onCancel }) => {
  const { t } = useI18n();
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const state = useAccountSecurityState();
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(false);

  if (state.keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t('signInSecurity.password.title')}
          description={t('linkCommons.already')}
        />
      </OxyAuthScreen>
    );
  }
  const fallback = accountSecurityFallback(state, t('signInSecurity.password.title'), t);
  if (fallback || !state.methods.data) return fallback;
  const { hasEmail, hasPassword, totpEnabled } = state.methods.data;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.signInMethods.all });

  if (removing) {
    return (
      <ReauthStep
        title={t('signInSecurity.password.removeTitle')}
        description={t('signInSecurity.password.removeDescription')}
        action="change_password"
        allowPassword
        totpEnabled={totpEnabled}
        submitLabel={t('signInSecurity.password.remove')}
        destructive
        onSubmit={async (reauth) => {
          await oxyServices.auth.password.remove(reauth);
          refresh();
          toast.success(t('signInSecurity.password.removed'));
          setRemoving(false);
          onDone?.();
        }}
        secondary={{ label: t('common.cancel'), onPress: () => setRemoving(false) }}
      />
    );
  }

  return (
    <ReauthStep
      title={
        hasPassword
          ? t('signInSecurity.password.changeTitle')
          : t('signInSecurity.password.setTitle')
      }
      description={t('signInSecurity.password.description', { min: PASSWORD_MIN_LENGTH })}
      action="change_password"
      allowPassword={hasPassword}
      allowEmail={hasEmail}
      totpEnabled={totpEnabled}
      submitLabel={t('signInSecurity.password.save')}
      validate={() => {
        if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
          return t('signInSecurity.password.tooShort', { min: PASSWORD_MIN_LENGTH });
        }
        return password === repeat ? null : t('signInSecurity.password.mismatch');
      }}
      onSubmit={async (reauth) => {
        await oxyServices.auth.password.set({
          newPassword: password,
          reauth,
          revokeOtherSessions: signOutOthers,
        });
        refresh();
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
        <Switch
          checked={signOutOthers}
          onCheckedChange={setSignOutOthers}
          testID="password-sign-out-others"
        />
      </Field>
      {/* Without an email the password is the one way in: it stays. */}
      {hasPassword && hasEmail ? (
        <SubtleLink
          label={t('signInSecurity.password.remove')}
          onPress={() => setRemoving(true)}
          testID="password-remove"
        />
      ) : null}
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
