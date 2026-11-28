/**
 * Creating an Oxy account, in the account dialog of every app (web and native)
 * and on auth.oxy.so's `/login`:
 *
 *   username → date of birth → email → the code sent to it → signed in
 *
 * The date of birth sets the account's age band (ADR 0067); below the minimum
 * unsupervised age the account is created under supervision, awaiting a guardian.
 *
 * The email is confirmed before the account exists, and it is how the account
 * signs in (a code or a link each time). A password and an authenticator app
 * are added later, in the account's security settings. Commons stays the way to
 * hold your own key: the username step says what that means, then "Create it in
 * Commons instead" — and linking Commons later makes the account self-custodied
 * and deletes the email. A host may preview the profile the username becomes
 * (`handlePreviewTemplate`); this screen never names an app's domain itself.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { DatePicker } from '@oxy.so/bloom/date-picker';
import { TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import type { EmailVerificationConfirmResponse } from '@oxy.so/contracts';
import {
  MIN_BIRTH_YEAR,
  SIGN_IN_ERROR_CODES,
  USERNAME_MAX_LENGTH,
  ageBandOf,
  checkContract,
  emailAddressCheck,
  stripDisallowedUsernameCharacters,
} from '@oxy.so/contracts/client';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';
import { useI18n } from '../../hooks/useI18n';
import { useUsernameAvailability } from '../../hooks/useUsernameAvailability';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { fromCalendarDate, toCalendarDate } from '../../utils/calendarDate';
import { renderHandlePreview } from '../../utils/handlePreview';
import {
  shareUsernameLookup,
  usernameLookupCooldownSeconds,
} from '../../utils/usernameLookupBudget';
import { checkUsernameDraft, describeUsernameRefusal } from '../../utils/usernamePolicy';
import { SubtleLink } from '../authChooser/primitives';
import { useAccountDialogHost } from './accountDialogHost';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';
import { readSignInFlow, writeSignInFlow } from './signInFlowStore';
import {
  AccountFlowAction,
  AccountFlowErrorLine,
  AccountFlowField,
  AccountFlowNote,
  AccountFlowProgress,
  EmailCodeStep,
} from './accountFlowParts';
import { describeApiError, errorCode, isTicketExpired } from '../../utils/apiErrorMessage';
import { withoutWhitespace } from '../../utils/withoutWhitespace';

/** Commons' own identity-creation deep link. */
const COMMONS_CREATE_IDENTITY_URL = 'oxycommons://create-identity';

type Step =
  | { name: 'username' }
  | { name: 'birthdate' }
  | { name: 'email' }
  | { name: 'code'; verificationId: string };

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
  /**
   * Preview of the public profile this username becomes. `{username}` is
   * replaced with the typed handle. The host writes its own origin, for
   * example `{base}/@{username}` with that base already filled in. Omitted,
   * the screen uses the template from `OxyProvider`, or shows none. Wins over
   * the provider when both are set.
   */
  handlePreviewTemplate?: string | null;
}

/** What the dialog keeps of this screen across a remount. */
interface SavedSignUpFlow {
  step: Step;
  username: string;
  email: string;
  /** `YYYY-MM-DD`, or empty until the person has picked it. */
  dateOfBirth?: string;
}
const SIGN_UP_FLOW_KEY = 'signup';

export const OxySignUpPanel: React.FC<OxySignUpPanelProps> = ({
  onSignedIn,
  onSignIn,
  host = 'page',
  handlePreviewTemplate,
}) => {
  const theme = useTheme();
  const { t } = useI18n();
  const hostDialog = useAccountDialogHost();
  const {
    oxyServices,
    handleWebSession,
    accountDialogController,
    currentLanguage,
    campaignAttribution,
  } = useOxy();
  const snapshot = useAccountDialogSnapshot(accountDialogController);
  const flowOwner = host === 'dialog' ? accountDialogController : null;
  const [saved] = useState(() => readSignInFlow<SavedSignUpFlow>(flowOwner, SIGN_UP_FLOW_KEY));
  const [step, setStep] = useState<Step>(saved?.step ?? { name: 'username' });
  const [username, setUsername] = useState(saved?.username ?? '');
  const [email, setEmail] = useState(saved?.email ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(saved?.dateOfBirth ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new account is not the one already signed in on this device, so a matching
  // handle is checked rather than treated as "unchanged".
  const availability = useUsernameAvailability(username, step.name === 'username', {
    matchCurrentUser: false,
    // Preview lookups share the ten-a-minute quota with the check below.
    reserveSubmit: true,
  });
  const previewTemplate = (handlePreviewTemplate ?? hostDialog.handlePreviewTemplate)?.trim() || '';
  const handlePreview = renderHandlePreview(previewTemplate, username);
  const liveTaken =
    !error && availability.status === 'taken' && availability.candidate === username.trim();
  const showAvailable =
    !error &&
    availability.status === 'available' &&
    availability.candidate === username.trim() &&
    username.trim().length > 0;

  useEffect(() => {
    writeSignInFlow(flowOwner, SIGN_UP_FLOW_KEY, {
      step,
      username,
      email,
      dateOfBirth,
    } satisfies SavedSignUpFlow);
  }, [flowOwner, step, username, email, dateOfBirth]);

  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setError(null);
    setPending(true);
    work()
      .catch((reason: unknown) => {
        if (isTicketExpired(reason)) setStep({ name: 'email' });
        setError(
          reason instanceof UsernameTakenError
            ? t('signup.username.taken')
            : describeApiError(reason, t),
        );
      })
      .finally(() => setPending(false));
  };

  // The policy is checked here, before the server is asked: the availability
  // check refuses a malformed name with a 400, and that reads as a failure of
  // ours rather than a rule the person can follow.
  const submitUsername = () => {
    const draft = checkUsernameDraft(username, t);
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    const handle = draft.username;
    setUsername(handle);
    // The live check already answered for this exact handle.
    if (availability.status === 'taken' && availability.candidate === handle) {
      setError(t('signup.username.taken'));
      return;
    }
    run(async () => {
      // Reuses the preview's answer for this exact handle, or the one lookup
      // the preview left unused. Past that, wait out the window — sending
      // would be refused and the refusal would count too.
      const outcome = await shareUsernameLookup(handle, 'submit', (name) =>
        oxyServices.auth.checkUsername(name),
      );
      if (outcome === 'deferred') {
        setError(t('signin.errors.rateLimited', { seconds: usernameLookupCooldownSeconds() }));
        return;
      }
      if (!outcome.available) throw new UsernameTakenError();
      setStep({ name: 'birthdate' });
    });
  };

  const submitBirthdate = () => {
    if (!dateOfBirth) {
      setError(t('signup.birthdate.required'));
      return;
    }
    setError(null);
    setStep({ name: 'email' });
  };

  const sendCode = async (address: string) => {
    const { verificationId } = await oxyServices.auth.email.startVerification({
      purpose: 'signup',
      email: address,
    });
    setStep({ name: 'code', verificationId });
  };

  const submitEmail = () => {
    const address = checkContract(emailAddressCheck, email);
    if (address === null) {
      setError(t('signup.email.invalid'));
      return;
    }
    setEmail(address);
    run(() => sendCode(address));
  };

  // The code step reports this promise's failure in place.
  const createAccount = async ({ ticket }: EmailVerificationConfirmResponse): Promise<void> => {
    // A flow restored from before this check existed may carry any name.
    const draft = checkUsernameDraft(username, t);
    if (!draft.ok) {
      setStep({ name: 'username' });
      setError(draft.error);
      return;
    }
    // A flow restored from before this step existed carries no date.
    if (!dateOfBirth) {
      setStep({ name: 'birthdate' });
      setError(t('signup.birthdate.required'));
      return;
    }
    try {
      const session = await oxyServices.auth.signUp({
        username: draft.username,
        email,
        emailTicket: ticket,
        dateOfBirth,
        languages: [currentLanguage],
        ...(campaignAttribution ? { campaignAttribution } : {}),
      });
      await handleWebSession(session, { method: 'signup' });
      writeSignInFlow(flowOwner, SIGN_UP_FLOW_KEY, undefined);
    } catch (reason) {
      if (errorCode(reason) === SIGN_IN_ERROR_CODES.usernameTaken) {
        setStep({ name: 'username' });
        setError(t('signup.username.taken'));
        return;
      }
      // The server refused the name by a rule this client does not know yet:
      // the name is what to change, so that is the step to return to.
      const refused = describeUsernameRefusal(reason, draft.username, t);
      if (refused) {
        setStep({ name: 'username' });
        setError(refused);
        return;
      }
      if (isTicketExpired(reason)) {
        setStep({ name: 'email' });
        setError(describeApiError(reason, t));
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

  // username → date of birth → email → code, drawn as one segmented bar under each header.
  const progressSteps = [
    t('signup.username.label'),
    t('signup.birthdate.label'),
    t('signup.email.label'),
    t('emailCode.title'),
  ];
  const progress = (current: number) => (
    <AccountFlowProgress steps={progressSteps} current={current} testID="signup-progress" />
  );

  switch (step.name) {
    case 'code':
      return (
        <EmailCodeStep
          description={t('emailCode.sentTo', { email })}
          verificationId={step.verificationId}
          onConfirmed={createAccount}
          onResend={() => sendCode(email)}
          back={{ label: t('emailCode.changeEmail'), onPress: () => setStep({ name: 'email' }) }}
          progress={progress(3)}
        />
      );
    case 'email':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={t('signup.email.title')}
            description={t('signup.email.subtitle')}
          />
          {progress(2)}
          <AccountFlowField
            label={t('signup.email.label')}
            value={email}
            onChange={(value) => {
              setEmail(withoutWhitespace(value));
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
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={submitEmail}
            pending={pending}
            testID="signup-email-continue"
          />
          <SubtleLink
            label={t('signin.actions.back')}
            onPress={() => setStep({ name: 'birthdate' })}
            testID="signup-back"
          />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    case 'birthdate':
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader
            title={t('signup.birthdate.title')}
            description={t('signup.birthdate.subtitle')}
          />
          {progress(1)}
          <View style={{ gap: 8 }}>
            <TextFieldLabel>{t('signup.birthdate.label')}</TextFieldLabel>
            <DatePicker
              value={fromCalendarDate(dateOfBirth)}
              minDate={new Date(MIN_BIRTH_YEAR, 0, 1)}
              maxDate={new Date()}
              accessibilityLabel={t('signup.birthdate.label')}
              placeholder={t('signup.birthdate.label')}
              onChange={(date) => {
                setDateOfBirth(date ? toCalendarDate(date) : '');
                if (error) setError(null);
              }}
              testID="signup-birthdate"
            />
            {error ? <AccountFlowErrorLine message={error} /> : null}
          </View>
          {dateOfBirth && ageBandOf(dateOfBirth) === 'under13' ? (
            <AccountFlowNote testID="signup-birthdate-guardian-note">
              {t('signup.birthdate.guardianNote')}
            </AccountFlowNote>
          ) : null}
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={submitBirthdate}
            pending={pending}
            testID="signup-birthdate-continue"
          />
          <SubtleLink
            label={t('signin.actions.back')}
            onPress={() => setStep({ name: 'username' })}
            testID="signup-birthdate-back"
          />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    default:
      return (
        <OxyAuthScreen>
          <OxyAuthScreenHeader title={t('signup.title')} description={t('signup.subtitle')} />
          {progress(0)}
          <View style={styles.usernameBlock}>
            <AccountFlowField
              label={t('signup.username.label')}
              value={username}
              onChange={(value) => {
                setUsername(stripDisallowedUsernameCharacters(value));
                if (error) setError(null);
              }}
              onSubmit={submitUsername}
              error={error ?? (liveTaken ? t('signup.username.taken') : null)}
              disabled={pending}
              placeholder={t('signup.username.placeholder')}
              hint={t('usernamePolicy.hint')}
              maxLength={USERNAME_MAX_LENGTH}
              autoComplete="username"
              testID="signup-username"
            />
            {showAvailable ? (
              <Text
                testID="signup-username-status"
                accessibilityLiveRegion="polite"
                style={[styles.status, { color: theme.colors.success }]}
              >
                {t('signup.username.available')}
              </Text>
            ) : null}
            {handlePreview ? (
              <Text
                testID="signup-handle-preview"
                style={[styles.status, { color: theme.colors.textSecondary }]}
              >
                {handlePreview}
              </Text>
            ) : null}
          </View>
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={submitUsername}
            pending={pending}
            testID="signup-username-continue"
          />
          <View style={styles.commons}>
            <AccountFlowNote testID="signup-commons-note">
              {t('signup.commonsSubtitle')}
            </AccountFlowNote>
            <SubtleLink
              label={t('signup.createInCommons')}
              onPress={createInCommons}
              testID="signup-commons-instead"
            />
          </View>
          <SubtleLink
            label={t('signup.backToSignInLink')}
            onPress={onSignIn}
            testID="back-to-sign-in"
          />
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
  }
};

/** The username was taken between typing it and creating the account. */
class UsernameTakenError extends Error {}

const styles = StyleSheet.create({
  usernameBlock: {
    gap: 8,
  },
  status: {
    fontSize: 16,
    lineHeight: 22,
  },
  commons: {
    gap: 8,
  },
});
