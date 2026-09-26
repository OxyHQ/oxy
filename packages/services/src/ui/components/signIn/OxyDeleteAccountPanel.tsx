/**
 * Deleting an account that has no key of its own, from the account's settings
 * (the account dialog's "Manage your account", or the Accounts app):
 *
 *   type the username → a code sent to the account's email (+ the
 *   authenticator's code when it has one) → deleted, and signed out
 *
 * An account with a Commons key is deleted with that key — in Commons, or in
 * an app that holds it (`ManageAccountScreen`); this panel says so instead.
 * It must be rendered signed in as the account.
 */

import type React from 'react';
import { useState } from 'react';
import { useOxy } from '../../context/OxyContext';
import { useSignInMethods } from '../../hooks/queries/useAuthMethods';
import { useI18n } from '../../hooks/useI18n';
import { OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import { AccountFlowField, AccountFlowNote } from './accountFlowParts';

export interface OxyDeleteAccountPanelProps {
  /** The account is gone and this origin signed out of it. */
  onDeleted?: () => void;
  /** "Cancel". */
  onCancel?: () => void;
}

export const OxyDeleteAccountPanel: React.FC<OxyDeleteAccountPanelProps> = ({ onDeleted, onCancel }) => {
  const { t } = useI18n();
  const { user, oxyServices, logout } = useOxy();
  const keyed = Boolean(user?.publicKey);
  const methods = useSignInMethods({ enabled: !keyed });
  const [confirmText, setConfirmText] = useState('');
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('deleteAccount.keyless.done')} description={t('deleteAccount.keyless.doneDescription')} />
      </OxyAuthScreen>
    );
  }

  if (keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('deleteAccount.handoff.commonsTitle')} description={t('deleteAccount.keyless.keyed')} />
      </OxyAuthScreen>
    );
  }

  if (!methods.data) return <OxyAuthLoading />;

  const username = user?.username ?? '';

  return (
    <ReauthStep
      title={t('deleteAccount.title')}
      description={t('deleteAccount.keyless.subtitle', { username })}
      action="delete_account"
      totpEnabled={methods.data.totpEnabled}
      submitLabel={t('deleteAccount.keyless.action')}
      destructive
      validate={() => (confirmText.trim() === username ? null : t('deleteAccount.confirmLabel', { username }))}
      onSubmit={async (proof) => {
        if (!proof.emailCode) throw new Error(t('reauth.errors.invalid'));
        await oxyServices.deleteAccountWithEmailCode(confirmText.trim(), {
          emailCode: proof.emailCode,
          ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
        });
        await logout().catch(() => undefined);
        setDeleted(true);
        onDeleted?.();
      }}
      secondary={onCancel ? { label: t('common.cancel'), onPress: onCancel } : undefined}
    >
      <AccountFlowNote>{t('deleteAccount.warning')}</AccountFlowNote>
      <AccountFlowField
        label={t('deleteAccount.confirmLabel', { username })}
        value={confirmText}
        onChange={setConfirmText}
        onSubmit={() => undefined}
        error={null}
        placeholder={username}
        autoComplete="off"
        testID="delete-account-confirm"
      />
    </ReauthStep>
  );
};
