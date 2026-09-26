/**
 * Deleting a passkey account (ADR 0029 D3), auth.oxy.so's `/delete-account`.
 *
 * A passkey account has no key to sign its deletion with, so the person types
 * the username and asserts one of the account's passkeys — on auth.oxy.so, the
 * one origin that asserts them — over a challenge the API minted for the
 * account. An account with a Commons key is deleted in Commons, with its key.
 * The page must be signed in as the account; the host renders sign-in first.
 */

import type React from 'react';
import { useState } from 'react';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
import { isPasskeySupported, runAuthenticationCeremony } from '../../../webauthn/passkeyClient';
import { PASSKEY_UNSUPPORTED_MESSAGE } from '../../context/passkeyFlow';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import {
  AccountFlowAction,
  AccountFlowErrorLine,
  AccountFlowField,
  AccountFlowNote,
  describeAccountFlowError,
} from './accountFlowParts';

export interface OxyDeleteAccountPanelProps {
  /** The account is gone and this origin signed out of it. */
  onDeleted?: () => void;
}

export const OxyDeleteAccountPanel: React.FC<OxyDeleteAccountPanelProps> = ({ onDeleted }) => {
  const { t } = useI18n();
  const { user, oxyServices, logout } = useOxy();
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('deleteAccount.passkey.done')} description={t('deleteAccount.passkey.closeWindow')} />
      </OxyAuthScreen>
    );
  }

  const username = user?.username ?? '';
  if (user?.publicKey) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t('deleteAccount.handoff.commonsTitle')} description={t('deleteAccount.passkey.commons')} />
      </OxyAuthScreen>
    );
  }

  // The ceremony opens the browser's passkey prompt, so it starts from the press.
  const remove = () => {
    if (pending) return;
    if (confirmText.trim() !== username) {
      setError(t('deleteAccount.confirmLabel', { username }));
      return;
    }
    setError(null);
    setPending(true);
    (async () => {
      if (!isPasskeySupported()) throw new Error(PASSKEY_UNSUPPORTED_MESSAGE);
      const options = await oxyServices.getAccountDeletionOptions();
      const assertion = await runAuthenticationCeremony(options);
      await oxyServices.deleteAccountWithPasskey(confirmText.trim(), assertion);
      await logout().catch(() => undefined);
      setDeleted(true);
      onDeleted?.();
    })()
      .catch((reason: unknown) => setError(describeAccountFlowError(reason, t)))
      .finally(() => setPending(false));
  };

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader title={t('deleteAccount.title')} description={t('deleteAccount.passkey.subtitle', { username })} />
      <AccountFlowNote>{t('deleteAccount.warning')}</AccountFlowNote>
      <AccountFlowField
        label={t('deleteAccount.confirmLabel', { username })}
        value={confirmText}
        onChange={(value) => {
          setConfirmText(value);
          if (error) setError(null);
        }}
        onSubmit={remove}
        error={null}
        disabled={pending}
        placeholder={username}
        autoComplete="off"
        testID="delete-account-confirm"
      />
      {error ? <AccountFlowErrorLine message={error} /> : null}
      <AccountFlowAction
        label={t('deleteAccount.passkey.action')}
        onPress={remove}
        pending={pending}
        disabled={confirmText.trim() !== username}
        testID="delete-account-passkey"
      />
    </OxyAuthScreen>
  );
};
