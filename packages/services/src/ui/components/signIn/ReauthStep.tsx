/**
 * "Confirm it's you": the fresh proof a sensitive change carries (`reauth`) —
 * a code sent to the account's email for THIS change, or the current password
 * where the change accepts one — plus the authenticator's code (or a backup
 * code) when the account has one. The screen that needs it puts its own fields
 * above (`children`) and names its own action; this owns the proof.
 */

import type React from 'react';
import { useState } from 'react';
import {
  EMAIL_CODE_LENGTH,
  TOTP_DIGITS,
  type ReauthAction,
  type ReauthProof,
} from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import {
  AccountFlowAction,
  AccountFlowCodeField,
  AccountFlowErrorLine,
  AccountFlowField,
  AccountFlowNote,
  AccountFlowNotice,
  BACKUP_CODE_LENGTH,
  describeSignInError,
} from './accountFlowParts';

export interface ReauthStepProps {
  title: string;
  description?: string;
  /** The change the emailed code is for: it works for nothing else. */
  action: ReauthAction;
  /** The account has a password, and this change accepts it. */
  allowPassword?: boolean;
  /** The account has an authenticator: its code is required too. */
  totpEnabled: boolean;
  /** The screen's action, once the proof is ready. */
  submitLabel: string;
  destructive?: boolean;
  /** The screen's own fields, checked before anything is sent. */
  validate?: () => string | null;
  /** Make the change with the proof. A rejection is reported in place. */
  onSubmit: (proof: ReauthProof) => Promise<void>;
  /** A way out (Cancel / Back). */
  secondary?: { label: string; onPress: () => void };
  children?: React.ReactNode;
}

export const ReauthStep: React.FC<ReauthStepProps> = ({
  title,
  description,
  action,
  allowPassword = false,
  totpEnabled,
  submitLabel,
  destructive,
  validate,
  onSubmit,
  secondary,
  children,
}) => {
  const { t } = useI18n();
  const { oxyServices } = useOxy();
  const [mode, setMode] = useState<'email' | 'password'>(allowPassword ? 'password' : 'email');
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setError(null);
    setPending(true);
    work()
      .catch((reason: unknown) => setError(describeSignInError(reason, t)))
      .finally(() => setPending(false));
  };

  const sendCode = () =>
    run(async () => {
      const started = await oxyServices.auth.requestReauthCode(action);
      setEmailCode('');
      setVerificationId(started.verificationId);
    });

  const submit = () => {
    const invalid = validate?.() ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }
    if (mode === 'email' && !verificationId) {
      sendCode();
      return;
    }
    const totp = totpCode.trim();
    if (totpEnabled && !totp) {
      setError(t('reauth.errors.totpRequired'));
      return;
    }
    let proof: ReauthProof;
    if (mode === 'password') {
      if (!password) {
        setError(t('signin.password.required'));
        return;
      }
      proof = { password, ...(totp ? { totpCode: totp } : {}) };
    } else {
      const code = emailCode.replace(/\D/g, '');
      if (code.length !== EMAIL_CODE_LENGTH || !verificationId) {
        setError(t('emailCode.errors.codeInvalid'));
        return;
      }
      proof = { emailCode: { verificationId, code }, ...(totp ? { totpCode: totp } : {}) };
    }
    run(() => onSubmit(proof));
  };

  const needsCode = mode === 'email' && !verificationId;

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader title={title} description={description} />
      {children}
      {mode === 'password' ? (
        <AccountFlowField
          label={t('reauth.passwordLabel')}
          value={password}
          onChange={setPassword}
          onSubmit={submit}
          error={null}
          disabled={pending}
          autoComplete="current-password"
          secureTextEntry
          autoFocus={false}
          testID="reauth-password"
        />
      ) : verificationId ? (
        <>
          <AccountFlowNotice testID="reauth-code-sent">{t('reauth.codeSent')}</AccountFlowNotice>
          <AccountFlowCodeField
            label={t('reauth.codeLabel')}
            value={emailCode}
            onChange={setEmailCode}
            error={null}
            disabled={pending}
            length={EMAIL_CODE_LENGTH}
            testID="reauth-code"
          />
        </>
      ) : (
        <AccountFlowNote>{t('reauth.emailDescription')}</AccountFlowNote>
      )}
      {totpEnabled && !needsCode ? (
        <>
          <AccountFlowCodeField
            key={useBackupCode ? 'backup' : 'totp'}
            label={
              useBackupCode ? t('signin.secondFactor.backupLabel') : t('signin.secondFactor.label')
            }
            value={totpCode}
            onChange={setTotpCode}
            error={null}
            disabled={pending}
            length={useBackupCode ? BACKUP_CODE_LENGTH : TOTP_DIGITS}
            type={useBackupCode ? 'alphanumeric' : 'numeric'}
            groupEvery={useBackupCode ? BACKUP_CODE_LENGTH / 2 : undefined}
            autoFocus={false}
            testID="reauth-totp"
          />
          <SubtleLink
            label={
              useBackupCode
                ? t('signin.secondFactor.useAuthenticator')
                : t('signin.secondFactor.useBackup')
            }
            onPress={() => {
              setUseBackupCode(!useBackupCode);
              setTotpCode('');
              setError(null);
            }}
            disabled={pending}
            testID="reauth-toggle-backup"
          />
        </>
      ) : null}
      {error ? <AccountFlowErrorLine message={error} /> : null}
      <AccountFlowAction
        label={needsCode ? t('reauth.sendCode') : submitLabel}
        onPress={submit}
        pending={pending}
        destructive={destructive && !needsCode}
        testID={needsCode ? 'reauth-send-code' : 'reauth-submit'}
      />
      {mode === 'email' && verificationId ? (
        <SubtleLink
          label={t('emailCode.resend')}
          onPress={sendCode}
          disabled={pending}
          testID="reauth-resend"
        />
      ) : null}
      {allowPassword ? (
        <SubtleLink
          label={mode === 'password' ? t('reauth.useEmail') : t('reauth.usePassword')}
          onPress={() => {
            setError(null);
            setMode(mode === 'password' ? 'email' : 'password');
          }}
          disabled={pending}
          testID="reauth-switch-method"
        />
      ) : null}
      {secondary ? (
        <SubtleLink
          label={secondary.label}
          onPress={secondary.onPress}
          disabled={pending}
          testID="reauth-cancel"
        />
      ) : null}
    </OxyAuthScreen>
  );
};
