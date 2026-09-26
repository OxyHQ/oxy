/**
 * Creating an Oxy account on the web (ADR 0029 D3), auth.oxy.so's `/signup`:
 *
 *   username → recovery email → the code sent to it → passkey → signed in
 *
 * A web account is a username, a passkey and a recovery email — no password, no
 * phrase, no key. The email is confirmed before the account exists, and is
 * used only to get back in (`OxyRecoverAccountPanel`). Commons stays the way to
 * hold your own key: the first step says so, and linking Commons later makes
 * the account self-custodied and deletes the email.
 *
 * Only on auth.oxy.so: the passkey belongs to that origin (RP ID `oxy.so`,
 * asserted only there), and an app's dialog opens this page in a window
 * (`OxySignUpPanel`'s `onCreateOnWeb`).
 */

import type React from 'react';
import { useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { DeviceManager } from '@oxy.so/core';
import { emailAddressSchema } from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { runPasskeyRegisterSignIn } from '../../context/passkeyFlow';
import { useI18n } from '../../hooks/useI18n';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isPasskeySupported, runRegistrationCeremony } from '../../../webauthn/passkeyClient';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';
import {
  AccountFlowAction,
  AccountFlowErrorLine,
  AccountFlowField,
  EmailCodeStep,
  describeAccountFlowError,
  isTicketExpired,
} from './accountFlowParts';

type Step =
  | { name: 'username' }
  | { name: 'email' }
  | { name: 'code'; verificationId: string }
  | { name: 'passkey'; emailTicket: string };

export interface OxyCreateAccountPanelProps {
  /** The account exists and this origin is signed in as it. */
  onSignedIn: () => void;
  /** "Already have an account? Sign in". */
  onSignIn: () => void;
}

export const OxyCreateAccountPanel: React.FC<OxyCreateAccountPanelProps> = ({ onSignedIn, onSignIn }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices, handleWebSession } = useOxy();
  const [step, setStep] = useState<Step>({ name: 'username' });
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setError(null);
    setPending(true);
    work()
      .catch((reason: unknown) => {
        if (isTicketExpired(reason)) setStep({ name: 'email' });
        setError(describeAccountFlowError(reason, t));
      })
      .finally(() => setPending(false));
  };

  const submitUsername = () => {
    const handle = username.trim();
    if (!handle) {
      setError(t('signup.username.required'));
      return;
    }
    run(async () => {
      const { available } = await oxyServices.checkUsernameAvailability(handle);
      if (!available) throw new Error(t('signup.username.taken'));
      setStep({ name: 'email' });
    });
  };

  const sendCode = async (address: string) => {
    const { verificationId } = await oxyServices.startEmailVerification({ purpose: 'signup', email: address });
    setStep({ name: 'code', verificationId });
  };

  const submitEmail = () => {
    const parsed = emailAddressSchema.safeParse(email);
    if (!parsed.success) {
      setError(t('signup.email.invalid'));
      return;
    }
    setEmail(parsed.data);
    run(() => sendCode(parsed.data));
  };

  // The ceremony opens the browser's passkey prompt, so it starts from the press.
  const createPasskey = (emailTicket: string) =>
    run(() =>
      runPasskeyRegisterSignIn({
        isSupported: isPasskeySupported,
        getRegisterOptions: () => oxyServices.webauthnRegisterOptions({ username: username.trim() }),
        runCeremony: runRegistrationCeremony,
        registerVerify: (response) =>
          oxyServices.webauthnRegisterVerify(response, {
            username: username.trim(),
            email,
            emailTicket,
            deviceFingerprint: JSON.stringify(DeviceManager.getDeviceFingerprint()),
          }),
        commit: async (session) => {
          await handleWebSession(session);
          onSignedIn();
        },
      }),
    );

  const getCommons = () => {
    Promise.resolve()
      .then(() => Linking.openURL(getCommonsAcquisitionUrl(Platform.OS)))
      .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
  };

  switch (step.name) {
    case 'code':
      return (
        <EmailCodeStep
          description={t('emailCode.sentTo', { email })}
          verificationId={step.verificationId}
          onConfirmed={({ ticket }) => {
            setError(null);
            setStep({ name: 'passkey', emailTicket: ticket });
          }}
          onResend={() => sendCode(email)}
          back={{ label: t('emailCode.changeEmail'), onPress: () => setStep({ name: 'email' }) }}
        />
      );
    case 'passkey':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signup.passkey.title')} description={t('signup.passkey.subtitle')} />
          {error ? <AccountFlowErrorLine message={error} /> : null}
          <AccountFlowAction
            label={t('signup.passkey.action')}
            onPress={() => createPasskey(step.emailTicket)}
            pending={pending}
            testID="signup-create-passkey"
          />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    case 'email':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signup.email.title')} description={t('signup.email.subtitle')} />
          <AccountFlowField
            label={t('signup.email.label')}
            value={email}
            onChange={(value) => {
              setEmail(value);
              if (error) setError(null);
            }}
            onSubmit={submitEmail}
            error={error}
            disabled={pending}
            placeholder={t('signup.email.placeholder')}
            autoComplete="email"
            keyboardType="email-address"
            testID="signup-email"
          />
          <AccountFlowAction label={t('signin.actions.continue')} onPress={submitEmail} pending={pending} testID="signup-email-continue" />
          <SubtleLink label={t('signin.actions.back')} theme={theme} onPress={() => setStep({ name: 'username' })} testID="signup-back" />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signup.title')} description={t('signup.webSubtitle')} />
          <AccountFlowField
            label={t('signup.username.label')}
            value={username}
            onChange={(value) => {
              setUsername(value);
              if (error) setError(null);
            }}
            onSubmit={submitUsername}
            error={error}
            disabled={pending}
            placeholder={t('signup.username.placeholder')}
            autoComplete="username"
            testID="signup-username"
          />
          <AccountFlowAction label={t('signin.actions.continue')} onPress={submitUsername} pending={pending} testID="signup-username-continue" />
          <SubtleLink label={t('signup.commonsInstead')} theme={theme} onPress={getCommons} testID="signup-commons-instead" />
          <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onSignIn} testID="back-to-sign-in" />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
  }
};
