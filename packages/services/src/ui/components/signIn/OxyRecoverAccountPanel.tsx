/**
 * Recovering a passkey account (ADR 0029 D3), auth.oxy.so's `/recover`:
 *
 *   username or email → the code sent to the recovery email → new passkey → signed in
 *
 * The first step answers the same whether or not the account exists, so it
 * never says who has one. An account that uses Commons has no recovery email:
 * it recovers in Commons with its phrase, and the first step says so. The new
 * passkey joins the ones the account has; lost ones are removed afterwards in
 * the account's security settings.
 */

import type React from 'react';
import { useState } from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import { DeviceManager } from '@oxy.so/core';
import { useOxy } from '../../context/OxyContext';
import { runPasskeyRegisterSignIn } from '../../context/passkeyFlow';
import { useI18n } from '../../hooks/useI18n';
import { isPasskeySupported, runRegistrationCeremony } from '../../../webauthn/passkeyClient';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';
import {
  AccountFlowAction,
  AccountFlowErrorLine,
  AccountFlowField,
  AccountFlowNote,
  EmailCodeStep,
  describeAccountFlowError,
  isTicketExpired,
} from './accountFlowParts';

type Step =
  | { name: 'entry' }
  | { name: 'code'; verificationId: string }
  | { name: 'passkey'; recoveryTicket: string; username: string | null };

export interface OxyRecoverAccountPanelProps {
  /** The account has a new passkey and this origin is signed in as it. */
  onRecovered: () => void;
  /** "Back to sign in". */
  onSignIn: () => void;
}

export const OxyRecoverAccountPanel: React.FC<OxyRecoverAccountPanelProps> = ({ onRecovered, onSignIn }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices, handleWebSession } = useOxy();
  const [step, setStep] = useState<Step>({ name: 'entry' });
  const [identifier, setIdentifier] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setError(null);
    setPending(true);
    work()
      .catch((reason: unknown) => {
        if (isTicketExpired(reason)) setStep({ name: 'entry' });
        setError(describeAccountFlowError(reason, t));
      })
      .finally(() => setPending(false));
  };

  const sendCode = async () => {
    const { verificationId } = await oxyServices.startEmailVerification({ purpose: 'recovery', identifier: identifier.trim() });
    setStep({ name: 'code', verificationId });
  };

  const submitIdentifier = () => {
    if (!identifier.trim()) {
      setError(t('recover.identifier.required'));
      return;
    }
    run(sendCode);
  };

  // The ceremony opens the browser's passkey prompt, so it starts from the press.
  const addPasskey = (recoveryTicket: string) =>
    run(() =>
      runPasskeyRegisterSignIn({
        isSupported: isPasskeySupported,
        getRegisterOptions: () => oxyServices.webauthnRegisterOptions({ recoveryTicket }),
        runCeremony: runRegistrationCeremony,
        registerVerify: (response) =>
          oxyServices.webauthnRegisterVerify(response, {
            recoveryTicket,
            deviceFingerprint: JSON.stringify(DeviceManager.getDeviceFingerprint()),
          }),
        commit: async (session) => {
          await handleWebSession(session);
          onRecovered();
        },
      }),
    );

  switch (step.name) {
    case 'code':
      return (
        <EmailCodeStep
          description={t('emailCode.sentIfAccount')}
          verificationId={step.verificationId}
          onConfirmed={({ ticket, username }) => {
            setError(null);
            setStep({ name: 'passkey', recoveryTicket: ticket, username });
          }}
          onResend={sendCode}
          back={{ label: t('signin.actions.back'), onPress: () => setStep({ name: 'entry' }) }}
        />
      );
    case 'passkey':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={t('recover.passkey.title')}
            description={t('recover.passkey.subtitle', { username: step.username ?? '' })}
          />
          {error ? <AccountFlowErrorLine message={error} /> : null}
          <AccountFlowAction
            label={t('recover.passkey.action')}
            onPress={() => addPasskey(step.recoveryTicket)}
            pending={pending}
            testID="recover-create-passkey"
          />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('recover.title')} description={t('recover.subtitle')} />
          <AccountFlowField
            label={t('recover.identifier.label')}
            value={identifier}
            onChange={(value) => {
              setIdentifier(value);
              if (error) setError(null);
            }}
            onSubmit={submitIdentifier}
            error={error}
            disabled={pending}
            placeholder={t('recover.identifier.placeholder')}
            autoComplete="username"
            testID="recover-identifier"
          />
          <AccountFlowNote>{t('recover.commonsNote')}</AccountFlowNote>
          <AccountFlowAction label={t('signin.actions.continue')} onPress={submitIdentifier} pending={pending} testID="recover-continue" />
          <SubtleLink label={t('recover.backToSignIn')} theme={theme} onPress={onSignIn} testID="back-to-sign-in" />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
  }
};
