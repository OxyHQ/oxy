/**
 * Deleting an account that has no key of its own, from the account's settings
 * (the account dialog's "Manage your account", or the Accounts app):
 *
 *   type the username → a code sent to the account's email, or its password
 *   when it has no email (+ the authenticator's code when it has one) →
 *   deleted, and signed out
 *
 * An account with a Commons key is deleted with that key — in Commons, or in
 * an app that holds it (`ManageAccountScreen`); this panel says so instead.
 * It must be rendered signed in as the account.
 */

import type React from 'react';
import { useState } from 'react';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import { AccountFlowField, AccountFlowNotice } from './accountFlowParts';
import { accountSecurityFallback, useAccountSecurityState } from './accountSecurityState';

export interface OxyDeleteAccountPanelProps {
  /** The account is gone and this origin signed out of it. */
  onDeleted?: () => void;
  /** "Cancel". */
  onCancel?: () => void;
}

export const OxyDeleteAccountPanel: React.FC<OxyDeleteAccountPanelProps> = ({
  onDeleted,
  onCancel,
}) => {
  const { t } = useI18n();
  const { user, oxyServices, logout } = useOxy();
  const security = useAccountSecurityState();
  const [confirmText, setConfirmText] = useState('');
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t('deleteAccount.keyless.done')}
          description={t('deleteAccount.keyless.doneDescription')}
        />
      </OxyAuthScreen>
    );
  }

  if (security.keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('deleteAccount.handoff.commonsTitle')} />
        <AccountFlowNotice testID="delete-account-keyed">
          {t('deleteAccount.keyless.keyed')}
        </AccountFlowNotice>
      </OxyAuthScreen>
    );
  }

  const fallback = accountSecurityFallback(security, t('deleteAccount.title'), t);
  if (fallback || !security.methods.data) return fallback;
  const { hasEmail, totpEnabled } = security.methods.data;

  const username = user?.username ?? '';

  return (
    <ReauthStep
      title={t('deleteAccount.title')}
      description={t('deleteAccount.keyless.subtitle', { username })}
      action="delete_account"
      // The mailbox proves it when there is one; the password only without.
      allowPassword={!hasEmail}
      allowEmail={hasEmail}
      totpEnabled={totpEnabled}
      submitLabel={t('deleteAccount.keyless.action')}
      destructive
      validate={() =>
        confirmText.trim() === username ? null : t('deleteAccount.confirmLabel', { username })
      }
      onSubmit={async (proof) => {
        // The last word before it is gone: the proof is ready, and nothing has
        // been sent yet. Cancelling keeps the screen as it is, code and all.
        const confirmed = await surfaces.confirm({
          title: t('deleteAccount.title'),
          description: t('deleteAccount.warning'),
          confirmLabel: t('deleteAccount.confirm'),
          cancelLabel: t('common.cancel'),
          destructive: true,
        });
        if (!confirmed) return;
        await oxyServices.users.deleteMe(confirmText.trim(), { reauth: proof });
        await logout().catch(() => undefined);
        setDeleted(true);
        onDeleted?.();
      }}
      secondary={onCancel ? { label: t('common.cancel'), onPress: onCancel } : undefined}
    >
      <AccountFlowNotice type="warning" testID="delete-account-warning">
        {t('deleteAccount.warning')}
      </AccountFlowNotice>
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
