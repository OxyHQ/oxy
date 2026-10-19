/**
 * The account's email, from its settings: add one, change it, or remove it.
 *
 *   add / change: the new address → a code sent to IT, plus the person's
 *   proof (the password, or a code to the current email; + the
 *   authenticator's) → saved, and every other session signed out
 *
 *   remove: only with a password set, confirmed with that password (+ the
 *   authenticator's) → the account signs in, and is recovered, with its
 *   password alone
 *
 * Sign-in codes, links and security notices go to this address. An account
 * with a Commons key has no email; this panel says so instead.
 */

import type React from 'react';
import { useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { EMAIL_CODE_LENGTH, checkContract, emailAddressCheck } from '@oxy.so/contracts/client';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/oxyRuntimeContext';
import { queryKeys } from '../../hooks/queries/queryKeys';
import { useI18n } from '../../hooks/useI18n';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader } from './OxyAuthScreen';
import { ReauthStep } from './ReauthStep';
import {
  AccountFlowAction,
  AccountFlowCodeField,
  AccountFlowField,
  AccountFlowNote,
  AccountFlowNotice,
  describeSignInError,
} from './accountFlowParts';
import { accountSecurityFallback, useAccountSecurityState } from './accountSecurityState';

type Step =
  | { name: 'status' }
  | { name: 'address' }
  | { name: 'confirm'; email: string; verificationId: string }
  | { name: 'remove' };

export interface OxyEmailPanelProps {
  /** The email was added, changed or removed. */
  onDone?: () => void;
}

export const OxyEmailPanel: React.FC<OxyEmailPanelProps> = ({ onDone }) => {
  const { t } = useI18n();
  const { oxyServices, user } = useOxy();
  const queryClient = useQueryClient();
  const security = useAccountSecurityState();
  const [step, setStep] = useState<Step>({ name: 'status' });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (security.keyed) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t('signInSecurity.email.title')}
          description={t('linkCommons.already')}
        />
      </OxyAuthScreen>
    );
  }
  const fallback = accountSecurityFallback(security, t('signInSecurity.email.title'), t);
  if (fallback || !security.methods.data) return fallback;
  const { hasEmail, hasPassword, totpEnabled } = security.methods.data;
  const current = hasEmail ? (user?.email ?? null) : null;

  const finish = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.signInMethods.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
    toast.success(message);
    setStep({ name: 'status' });
    setAddress('');
    setCode('');
    onDone?.();
  };

  const sendCode = (email: string) => {
    if (pending) return;
    setError(null);
    setPending(true);
    oxyServices.auth.email
      .startChange(email)
      .then((started) => {
        setCode('');
        setStep({ name: 'confirm', email, verificationId: started.verificationId });
      })
      .catch((reason: unknown) => setError(describeSignInError(reason, t)))
      .finally(() => setPending(false));
  };

  const submitAddress = () => {
    const email = checkContract(emailAddressCheck, address);
    if (!email) {
      setError(t('signInSecurity.email.invalid'));
      return;
    }
    if (email === current) {
      setError(t('signInSecurity.errors.emailUnchanged'));
      return;
    }
    sendCode(email);
  };

  switch (step.name) {
    case 'address':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={hasEmail ? t('signInSecurity.email.change') : t('signInSecurity.email.add')}
            description={t('signInSecurity.email.newDescription')}
          />
          <AccountFlowField
            label={t('signInSecurity.email.newLabel')}
            value={address}
            onChange={(value) => {
              setAddress(value);
              if (error) setError(null);
            }}
            onSubmit={submitAddress}
            error={error}
            disabled={pending}
            autoComplete="email"
            keyboardType="email-address"
            testID="email-new"
          />
          <AccountFlowAction
            label={t('signInSecurity.email.sendCode')}
            onPress={submitAddress}
            pending={pending}
            testID="email-send-code"
          />
          <SubtleLink
            label={t('common.cancel')}
            onPress={() => {
              setError(null);
              setStep({ name: 'status' });
            }}
            disabled={pending}
            testID="email-cancel"
          />
        </OxyAuthScreen>
      );
    case 'confirm':
      return (
        <ReauthStep
          title={t('signInSecurity.email.confirmTitle')}
          description={t('signInSecurity.email.confirmDescription', { email: step.email })}
          action="change_email"
          allowPassword={hasPassword}
          allowEmail={hasEmail}
          totpEnabled={totpEnabled}
          submitLabel={t('signInSecurity.email.save')}
          validate={() =>
            code.replace(/\D/g, '').length === EMAIL_CODE_LENGTH
              ? null
              : t('emailCode.errors.codeInvalid')
          }
          onSubmit={async (reauth) => {
            await oxyServices.auth.email.change({
              email: step.email,
              verificationId: step.verificationId,
              code: code.replace(/\D/g, ''),
              reauth,
            });
            finish(t('signInSecurity.email.saved'));
          }}
          secondary={{ label: t('common.cancel'), onPress: () => setStep({ name: 'status' }) }}
        >
          <AccountFlowCodeField
            label={t('signInSecurity.email.codeLabel')}
            value={code}
            onChange={setCode}
            error={null}
            length={EMAIL_CODE_LENGTH}
            testID="email-new-code"
          />
          <SubtleLink
            label={t('emailCode.resend')}
            onPress={() => sendCode(step.email)}
            disabled={pending}
            testID="email-new-code-resend"
          />
          {error ? (
            <AccountFlowNotice type="error" testID="email-new-code-error">
              {error}
            </AccountFlowNotice>
          ) : null}
        </ReauthStep>
      );
    case 'remove':
      return (
        <ReauthStep
          title={t('signInSecurity.email.removeTitle')}
          description={t('signInSecurity.email.removeDescription')}
          action="change_email"
          // Confirmed with the password it will rely on, never the mailbox it loses.
          allowPassword
          allowEmail={false}
          totpEnabled={totpEnabled}
          submitLabel={t('signInSecurity.email.remove')}
          destructive
          onSubmit={async (reauth) => {
            await oxyServices.auth.email.remove(reauth);
            finish(t('signInSecurity.email.removed'));
          }}
          secondary={{ label: t('common.cancel'), onPress: () => setStep({ name: 'status' }) }}
        />
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={t('signInSecurity.email.title')}
            description={
              hasEmail
                ? t('signInSecurity.email.description')
                : t('signInSecurity.email.noneDescription')
            }
          />
          {current ? <AccountFlowNote testID="email-current">{current}</AccountFlowNote> : null}
          {!hasEmail ? (
            <AccountFlowNotice type="warning" testID="email-none-warning">
              {t('signInSecurity.noEmailWarning')}
            </AccountFlowNotice>
          ) : null}
          <AccountFlowAction
            label={hasEmail ? t('signInSecurity.email.change') : t('signInSecurity.email.add')}
            onPress={() => {
              setError(null);
              setAddress('');
              setStep({ name: 'address' });
            }}
            pending={false}
            testID="email-change"
          />
          {hasEmail && hasPassword ? (
            <SubtleLink
              label={t('signInSecurity.email.remove')}
              onPress={() => setStep({ name: 'remove' })}
              testID="remove-email-link"
            />
          ) : null}
          {hasEmail && !hasPassword ? (
            <AccountFlowNote testID="email-remove-needs-password">
              {t('signInSecurity.email.removeNeedsPassword')}
            </AccountFlowNote>
          ) : null}
        </OxyAuthScreen>
      );
  }
};
