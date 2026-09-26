/**
 * Creating an Oxy account, in the account dialog of every app (web and native)
 * and on auth.oxy.so's `/login`:
 *
 *   username → email → the code sent to it → signed in
 *
 * The email is confirmed before the account exists, and it is how the account
 * signs in (a code or a link each time). A password and an authenticator app
 * are added later, in the account's security settings. Commons stays the way to
 * hold your own key: "Create it in Commons instead" — and linking Commons later
 * makes the account self-custodied and deletes the email.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { SIGN_IN_ERROR_CODES, emailAddressSchema, type EmailVerificationConfirmResponse } from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';
import { useI18n } from '../../hooks/useI18n';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';
import { readSignInFlow, writeSignInFlow } from './signInFlowStore';
import {
  AccountFlowAction,
  AccountFlowField,
  AccountFlowNote,
  EmailCodeStep,
  describeSignInError,
  errorCode,
  isTicketExpired,
} from './accountFlowParts';

/** Commons' own identity-creation deep link. */
const COMMONS_CREATE_IDENTITY_URL = 'oxycommons://create-identity';

type Step = { name: 'username' } | { name: 'email' } | { name: 'code'; verificationId: string };

export interface OxySignUpPanelProps {
  /** The account exists and this origin is signed in as it. */
  onSignedIn: () => void;
  /** "Already have an account? Sign in". */
  onSignIn: () => void;
  /**
   * `dialog` — inside the account dialog, where the step outlives a remount of
   * this screen (`signInFlowStore`). `page` — a page of its own.
   */
  host?: 'dialog' | 'page';
}

/** What the dialog keeps of this screen across a remount. */
interface SavedSignUpFlow {
  step: Step;
  username: string;
  email: string;
}
const SIGN_UP_FLOW_KEY = 'signup';

export const OxySignUpPanel: React.FC<OxySignUpPanelProps> = ({ onSignedIn, onSignIn, host = 'page' }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { oxyServices, handleWebSession, accountDialogController } = useOxy();
  const snapshot = useAccountDialogSnapshot(accountDialogController);
  const flowOwner = host === 'dialog' ? accountDialogController : null;
  const [saved] = useState(() => readSignInFlow<SavedSignUpFlow>(flowOwner, SIGN_UP_FLOW_KEY));
  const [step, setStep] = useState<Step>(saved?.step ?? { name: 'username' });
  const [username, setUsername] = useState(saved?.username ?? '');
  const [email, setEmail] = useState(saved?.email ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    writeSignInFlow(flowOwner, SIGN_UP_FLOW_KEY, { step, username, email } satisfies SavedSignUpFlow);
  }, [flowOwner, step, username, email]);

  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setError(null);
    setPending(true);
    work()
      .catch((reason: unknown) => {
        if (isTicketExpired(reason)) setStep({ name: 'email' });
        setError(reason instanceof UsernameTakenError ? t('signup.username.taken') : describeSignInError(reason, t));
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
      const { available } = await oxyServices.auth.checkUsername(handle);
      if (!available) throw new UsernameTakenError();
      setStep({ name: 'email' });
    });
  };

  const sendCode = async (address: string) => {
    const { verificationId } = await oxyServices.auth.email.startVerification({ purpose: 'signup', email: address });
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

  // The code step reports this promise's failure in place.
  const createAccount = async ({ ticket }: EmailVerificationConfirmResponse): Promise<void> => {
    try {
      const session = await oxyServices.auth.signUp({ username: username.trim(), email, emailTicket: ticket });
      await handleWebSession(session);
      writeSignInFlow(flowOwner, SIGN_UP_FLOW_KEY, undefined);
    } catch (reason) {
      if (errorCode(reason) === SIGN_IN_ERROR_CODES.usernameTaken) {
        setStep({ name: 'username' });
        setError(t('signup.username.taken'));
        return;
      }
      if (isTicketExpired(reason)) {
        setStep({ name: 'email' });
        setError(describeSignInError(reason, t));
        return;
      }
      throw reason;
    }
    onSignedIn();
  };

  const createInCommons = () => {
    const url =
      !isWebBrowser() && snapshot.commonsAvailability === 'available'
        ? COMMONS_CREATE_IDENTITY_URL
        : getCommonsAcquisitionUrl(Platform.OS);
    Promise.resolve()
      .then(() => Linking.openURL(url))
      .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
  };

  switch (step.name) {
    case 'code':
      return (
        <EmailCodeStep
          description={t('emailCode.sentTo', { email })}
          verificationId={step.verificationId}
          onConfirmed={createAccount}
          onResend={() => sendCode(email)}
          back={{ label: t('emailCode.changeEmail'), onPress: () => setStep({ name: 'email' }) }}
        />
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
          <AccountFlowNote>{t('signup.laterNote')}</AccountFlowNote>
          <AccountFlowAction label={t('signin.actions.continue')} onPress={submitEmail} pending={pending} testID="signup-email-continue" />
          <SubtleLink label={t('signin.actions.back')} theme={theme} onPress={() => setStep({ name: 'username' })} testID="signup-back" />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signup.title')} description={t('signup.subtitle')} />
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
          <SubtleLink label={t('signup.createInCommons')} theme={theme} onPress={createInCommons} testID="signup-commons-instead" />
          <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onSignIn} testID="back-to-sign-in" />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
  }
};

/** The username was taken between typing it and creating the account. */
class UsernameTakenError extends Error {}
