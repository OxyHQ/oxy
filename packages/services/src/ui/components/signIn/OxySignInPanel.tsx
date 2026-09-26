/**
 * THE Oxy sign-in screen. The account dialog every Oxy app opens and the
 * auth.oxy.so page render this one component; only where it is mounted
 * differs (`host`). Sign-in happens IN it, on every origin: no window opens.
 *
 *   picker        a returning device: "Choose an account", then "Use another account"
 *   identifier    the header, the Commons way in, and "Email or username" with its
 *                 Continue. On the web, from `md`, the screen is Bloom `AuthCard`'s
 *                 split card and the Commons way in is the embedded QR over its
 *                 photo carousel, in the right column (the account dialog grows to
 *                 that card); below `md` it is "Continue with Oxy" at the top. On
 *                 native it is "Continue with Oxy" ("Get Commons" without Commons).
 *   check-email   one email carries a code and a link. The code is typed here (6
 *                 digits, or the 10-character long code); meanwhile the screen asks
 *                 whether the link was opened in this browser, and signs in when it was.
 *   password      the alternative for an account that has one.
 *   second-factor the authenticator's code, or a backup code, when the account has one.
 *
 * Every answer is the same whether or not the account exists: the email step
 * says "if an account matches".
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Text as RNText, StyleSheet, View } from 'react-native';
import { View as CssView } from 'react-native-css/components';
import { AuthMediaCarousel } from '@oxy.so/bloom/auth-card';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import type { SwitcherContextRow } from '@oxy.so/core';
import {
  EMAIL_SIGNIN_LONG_CODE_LENGTH,
  SIGN_IN_ERROR_CODES,
  TOTP_DIGITS,
  isSecondFactorRequired,
  type LoginResult,
  type SignInStepResult,
} from '@oxy.so/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/OxyContext';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';
import { useDeviceSwitcher } from '../../hooks/useDeviceSwitcher';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceFrameWidth } from '../../hooks/useSurfaceFrameWidth';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { SubtleLink } from '../authChooser/primitives';
import { SIGN_IN_SLIDES } from './artwork';
import { InlineCommonsQr } from './InlineCommonsQr';
import { OxyAccountPicker } from './OxyAccountPicker';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthSplit, OxyAuthTerms } from './OxyAuthScreen';
import {
  AccountFlowAction,
  AccountFlowField,
  AccountFlowNote,
  describeSignInError,
  errorCode,
  formatSignInCodeInput,
  isCompleteSignInCode,
  isRateLimited,
  retryAfterSeconds,
} from './accountFlowParts';
import { readSignInFlow, writeSignInFlow } from './signInFlowStore';
import { resolveSignInMethods } from './signInMethods';

/** Bloom `AuthCard`'s split card width, which the account dialog grows to for it. */
const SPLIT_WIDTH = 880;
/** How often the check-email step asks whether the link was opened in this browser. */
export const EMAIL_SIGNIN_POLL_MS = 2000;
/** How long after an email "Send a new email" waits. */
export const EMAIL_RESEND_COOLDOWN_SECONDS = 30;

/** What the dialog keeps of this screen across a remount (`signInFlowStore`). */
interface SavedSignInFlow {
  step: Step;
  identifier: string;
  showForm: boolean;
  useBackupCode: boolean;
  /** When "Send a new email" may be pressed again (ms). */
  resendUntil: number;
}
const SIGN_IN_FLOW_KEY = 'signin';

type Step =
  | { name: 'start' }
  | { name: 'check-email'; identifier: string; requestId: string; requestSecret: string }
  | { name: 'password'; identifier: string }
  | { name: 'second-factor'; challengeId: string; identifier: string };

export interface OxySignInPanelProps {
  /** This screen signed the origin in. */
  onSignedIn: () => void;
  /** "Don't have an account? Create account". */
  onCreateAccount: () => void;
  /** An email or username to pre-fill, skipping the picker (a re-authentication). */
  loginHint?: string;
  /** The app being continued to, when there is one. */
  appName?: string | null;
  /**
   * `dialog` — inside the account dialog, which the controller closes itself
   * once a request it runs signs in, and where a request shows in place.
   * `page`   — a page of its own (auth.oxy.so): a request opens the dialog to
   * show it, and its completion is reported through `onSignedIn` too.
   */
  host?: 'dialog' | 'page';
}

export const OxySignInPanel: React.FC<OxySignInPanelProps> = ({
  onSignedIn,
  onCreateAccount,
  loginHint,
  appName = null,
  host = 'page',
}) => {
  const theme = useTheme();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { accountDialogController: controller, openAccountDialog, oxyServices, handleWebSession } = useOxy();
  const snapshot = useAccountDialogSnapshot(controller);
  const { principals, activeContext } = useDeviceSwitcher();

  const methods = resolveSignInMethods({
    web: isWebBrowser(),
    commonsAvailability: snapshot.commonsAvailability,
  });

  // In the dialog the step outlives a remount of this screen (the responsive
  // surface swaps its tree at `md`): it is restored from, and saved to, the
  // flow store the dialog's controller owns.
  const flowOwner = host === 'dialog' ? controller : null;
  const [saved] = useState(() => readSignInFlow<SavedSignInFlow>(flowOwner, SIGN_IN_FLOW_KEY));
  const [showForm, setShowForm] = useState(saved?.showForm ?? Boolean(loginHint));
  const [step, setStep] = useState<Step>(saved?.step ?? { name: 'start' });
  const [identifier, setIdentifier] = useState(saved?.identifier ?? loginHint ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [secondFactorCode, setSecondFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(saved?.useBackupCode ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
  const [resendSeconds, setResendSeconds] = useState(() =>
    saved ? Math.max(0, Math.ceil((saved.resendUntil - Date.now()) / 1000)) : 0,
  );

  useEffect(() => {
    writeSignInFlow(flowOwner, SIGN_IN_FLOW_KEY, {
      step,
      identifier,
      showForm,
      useBackupCode,
      resendUntil: Date.now() + resendSeconds * 1000,
    } satisfies SavedSignInFlow);
  }, [flowOwner, step, identifier, showForm, useBackupCode, resendSeconds]);
  const blocked = pending || rateLimitSeconds > 0;

  // The countdown after a 429: one tick a second until the person may retry.
  useEffect(() => {
    if (rateLimitSeconds <= 0) return;
    const timer = setTimeout(() => setRateLimitSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [rateLimitSeconds]);

  // The wait before another email may be asked for.
  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = setTimeout(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendSeconds]);

  // On a page, a request the controller runs (the embedded QR, or one shown in
  // the dialog opened over it) finishes the page's sign-in too. Only one that
  // STARTED here: a completion already on the controller is somebody else's.
  const [mountedAttempt] = useState(snapshot.signIn.attempt);
  const completedHere = snapshot.signIn.phase === 'completed' && snapshot.signIn.attempt !== mountedAttempt;
  useEffect(() => {
    if (host === 'page' && completedHere) onSignedIn();
  }, [host, completedHere, onSignedIn]);

  /** Show the request a controller call just started — the dialog is where it lives. */
  const showRequest = useCallback(() => {
    if (host === 'page') openAccountDialog('qr');
  }, [host, openAccountDialog]);

  const continueWithOxy = () => {
    void controller?.signInWithOxy();
    showRequest();
  };
  const getCommons = () => {
    Promise.resolve()
      .then(() => Linking.openURL(getCommonsAcquisitionUrl(Platform.OS)))
      .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
  };

  const fail = useCallback(
    (reason: unknown) => {
      if (isRateLimited(reason)) setRateLimitSeconds(retryAfterSeconds(reason));
      else setError(describeSignInError(reason, t));
    },
    [t],
  );

  // One sign-in ends once: the typed code and the opened link can race.
  const finishingRef = useRef(false);
  const finish = useCallback(
    async (result: SignInStepResult, from: string): Promise<void> => {
      if (finishingRef.current) return;
      if (isSecondFactorRequired(result)) {
        setError(null);
        setSecondFactorCode('');
        setUseBackupCode(false);
        setStep({ name: 'second-factor', challengeId: result.challengeId, identifier: from });
        return;
      }
      finishingRef.current = true;
      writeSignInFlow(flowOwner, SIGN_IN_FLOW_KEY, undefined);
      try {
        await handleWebSession(result as LoginResult);
      } catch (reason) {
        finishingRef.current = false;
        throw reason;
      }
      onSignedIn();
    },
    [handleWebSession, onSignedIn, flowOwner],
  );

  /** Send the sign-in email and show "Check your email". */
  const startEmail = (name: string) => {
    if (blocked) return;
    setError(null);
    setNotice(null);
    setPending(true);
    oxyServices
      .startEmailSignIn(name)
      .then((started) => {
        if (started.retryLater) {
          setError(t('signin.checkEmail.retryLater'));
          return;
        }
        setCode('');
        setResendSeconds(EMAIL_RESEND_COOLDOWN_SECONDS);
        if (step.name === 'check-email') setNotice(t('signin.checkEmail.resent'));
        setStep({ name: 'check-email', identifier: name, requestId: started.requestId, requestSecret: started.requestSecret });
      })
      .catch(fail)
      .finally(() => setPending(false));
  };

  const submitIdentifier = () => {
    const name = identifier.trim();
    if (!name) {
      setError(t('signin.identifier.required'));
      return;
    }
    startEmail(name);
  };

  const submitCode = (typed: string) => {
    if (step.name !== 'check-email' || blocked) return;
    if (!isCompleteSignInCode(typed)) {
      setError(t('signin.errors.codeInvalid'));
      return;
    }
    const request = step;
    setError(null);
    setNotice(null);
    setPending(true);
    oxyServices
      .confirmEmailSignIn({ requestId: request.requestId, requestSecret: request.requestSecret, code: typed.trim() })
      .then((result) => finish(result, request.identifier))
      .catch((reason: unknown) => {
        setCode('');
        fail(reason);
      })
      .finally(() => setPending(false));
  };

  const submitPassword = () => {
    if (step.name !== 'password' || blocked) return;
    if (!password) {
      setError(t('signin.password.required'));
      return;
    }
    const name = step.identifier;
    setError(null);
    setPending(true);
    oxyServices
      .signInWithPassword({ identifier: name, password })
      .then((result) => finish(result, name))
      .catch(fail)
      .finally(() => setPending(false));
  };

  const submitSecondFactor = (typed: string) => {
    if (step.name !== 'second-factor' || blocked) return;
    const value = typed.trim();
    if (!value) {
      setError(t('signin.errors.secondFactorInvalid'));
      return;
    }
    const challenge = step;
    setError(null);
    setPending(true);
    oxyServices
      .completeSecondFactor({ challengeId: challenge.challengeId, code: value })
      .then((session) => finish(session, challenge.identifier))
      .catch((reason: unknown) => {
        setSecondFactorCode('');
        fail(reason);
      })
      .finally(() => setPending(false));
  };

  // The poll below finishes through the latest `finish` without restarting
  // when a parent re-renders with a new `onSignedIn`.
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  // While "Check your email" shows, ask whether the link was opened in this
  // browser; stop when the step goes, and on a request that is gone. A session
  // the server handed over is always committed, even if the step went away
  // meanwhile: the request is spent, so it would otherwise be lost.
  const emailRequest = step.name === 'check-email' ? step : null;
  const requestId = emailRequest?.requestId ?? null;
  const requestSecret = emailRequest?.requestSecret ?? null;
  const requestIdentifier = emailRequest?.identifier ?? '';
  useEffect(() => {
    if (!requestId || !requestSecret) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const result = await oxyServices.collectEmailSignIn({ requestId, requestSecret });
        if (!('status' in result)) {
          await finishRef.current(result, requestIdentifier);
          return;
        }
        if (stopped) return;
      } catch (reason) {
        if (stopped) return;
        // A spent, expired or unknown request never approves: stop asking.
        if (errorCode(reason) === SIGN_IN_ERROR_CODES.requestInvalid) return;
      }
      if (!stopped) timer = setTimeout(() => void poll(), EMAIL_SIGNIN_POLL_MS);
    };
    timer = setTimeout(() => void poll(), EMAIL_SIGNIN_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [requestId, requestSecret, requestIdentifier, oxyServices]);

  const backToIdentifier = () => {
    setError(null);
    setNotice(null);
    setCode('');
    setPassword('');
    setStep({ name: 'start' });
  };
  const toPassword = (name: string) => {
    setError(null);
    setNotice(null);
    setPassword('');
    setStep({ name: 'password', identifier: name });
  };

  // A returning device starts at WHO. Not while adding an account from inside
  // a signed-in app: the rows are the accounts it would add.
  const pickerAllowed = host === 'dialog' ? !snapshot.hasSession : activeContext !== null;
  const selectContext = async (context: SwitcherContextRow) => {
    const outcome = await controller?.chooseContext(context.contextId).catch(() => 'failed' as const);
    switch (outcome) {
      case 'switched':
        // Every account-scoped query now describes somebody else.
        void queryClient.invalidateQueries();
        onSignedIn();
        return;
      case 'current':
        onSignedIn();
        return;
      case 'signing-in':
        // The request for that account is running; it shows where requests do.
        showRequest();
        return;
      case 'failed':
        // The pair could not be activated as it stands: sign in as it explicitly.
        if (context.handle) {
          setIdentifier(context.handle);
          setShowForm(true);
        } else {
          toast.error(t('accountSwitcher.toasts.activateFailed'));
        }
        return;
      default:
        return;
    }
  };

  const showsPicker = pickerAllowed && !showForm && principals.length > 0;
  // The web screen is the split card from `md`. In the account dialog it grows
  // the dialog to that card; below `md` the dialog is a bottom sheet, which a
  // width does not touch.
  const splits = methods.commons === 'qr';
  useSurfaceFrameWidth(host === 'dialog' && !showsPicker && splits ? SPLIT_WIDTH : null);

  if (showsPicker) {
    return (
      <OxyAccountPicker
        principals={principals}
        appName={appName}
        signedOut={!snapshot.hasSession}
        pendingContextId={snapshot.activatingContextId}
        isLoading={snapshot.activatingContextId !== null}
        onSelectContext={(context) => void selectContext(context)}
        onUseAnother={() => {
          setIdentifier('');
          setShowForm(true);
        }}
      />
    );
  }

  const shownError = rateLimitSeconds > 0 ? t('signin.errors.rateLimited', { seconds: rateLimitSeconds }) : error;
  const clearError = () => {
    if (error) setError(null);
  };

  let form: React.ReactNode;
  switch (step.name) {
    case 'check-email': {
      const request = step;
      form = (
        <OxyAuthScreen className={splits ? 'md:max-w-none' : undefined}>
          <OxyAuthScreenHeader
            title={t('signin.checkEmail.title')}
            description={t('signin.checkEmail.description', { identifier: request.identifier })}
          />
          <AccountFlowField
            label={t('signin.checkEmail.codeLabel')}
            value={code}
            onChange={(value) => {
              const typed = formatSignInCodeInput(value);
              setCode(typed);
              clearError();
              if (isCompleteSignInCode(typed)) submitCode(typed);
            }}
            onSubmit={() => submitCode(code)}
            error={shownError}
            disabled={blocked}
            placeholder="000000"
            autoComplete="one-time-code"
            maxLength={EMAIL_SIGNIN_LONG_CODE_LENGTH + 1}
            hint={t('signin.checkEmail.codeHint')}
            testID="signin-code"
          />
          {notice ? <AccountFlowNote testID="signin-notice">{notice}</AccountFlowNote> : null}
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={() => submitCode(code)}
            pending={pending}
            disabled={rateLimitSeconds > 0}
            testID="signin-code-continue"
          />
          <View style={styles.links}>
            <SubtleLink
              label={
                resendSeconds > 0
                  ? t('signin.checkEmail.resendIn', { seconds: resendSeconds })
                  : t('signin.checkEmail.resend')
              }
              theme={theme}
              onPress={() => startEmail(request.identifier)}
              disabled={blocked || resendSeconds > 0}
              testID="signin-resend"
            />
            <SubtleLink
              label={t('signin.checkEmail.usePassword')}
              theme={theme}
              onPress={() => toPassword(request.identifier)}
              disabled={pending}
              testID="signin-use-password"
            />
            <SubtleLink
              label={t('signin.checkEmail.differentAccount')}
              theme={theme}
              onPress={backToIdentifier}
              disabled={pending}
              testID="signin-different-account"
            />
          </View>
        </OxyAuthScreen>
      );
      break;
    }
    case 'password': {
      const request = step;
      form = (
        <OxyAuthScreen className={splits ? 'md:max-w-none' : undefined}>
          <OxyAuthScreenHeader title={t('signin.password.title')} description={request.identifier} />
          <AccountFlowField
            label={t('signin.password.label')}
            value={password}
            onChange={(value) => {
              setPassword(value);
              clearError();
            }}
            onSubmit={submitPassword}
            error={shownError}
            disabled={blocked}
            autoComplete="current-password"
            secureTextEntry
            testID="signin-password"
          />
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={submitPassword}
            pending={pending}
            disabled={rateLimitSeconds > 0}
            testID="signin-password-continue"
          />
          <View style={styles.links}>
            <SubtleLink
              label={t('signin.password.forgot')}
              theme={theme}
              onPress={() => startEmail(request.identifier)}
              disabled={blocked}
              testID="signin-password-forgot"
            />
            <SubtleLink
              label={t('signin.checkEmail.differentAccount')}
              theme={theme}
              onPress={backToIdentifier}
              disabled={pending}
              testID="signin-different-account"
            />
          </View>
        </OxyAuthScreen>
      );
      break;
    }
    case 'second-factor':
      form = (
        <OxyAuthScreen className={splits ? 'md:max-w-none' : undefined}>
          <OxyAuthScreenHeader
            title={t('signin.secondFactor.title')}
            description={useBackupCode ? t('signin.secondFactor.backupDescription') : t('signin.secondFactor.description')}
          />
          <AccountFlowField
            key={useBackupCode ? 'backup' : 'totp'}
            label={useBackupCode ? t('signin.secondFactor.backupLabel') : t('signin.secondFactor.label')}
            value={secondFactorCode}
            onChange={(value) => {
              if (useBackupCode) {
                setSecondFactorCode(value);
                clearError();
                return;
              }
              const digits = value.replace(/\D/g, '').slice(0, TOTP_DIGITS);
              setSecondFactorCode(digits);
              clearError();
              if (digits.length === TOTP_DIGITS) submitSecondFactor(digits);
            }}
            onSubmit={() => submitSecondFactor(secondFactorCode)}
            error={shownError}
            disabled={blocked}
            placeholder={useBackupCode ? 'xxxxx-xxxxx' : '000000'}
            autoComplete="one-time-code"
            keyboardType={useBackupCode ? 'default' : 'number-pad'}
            maxLength={useBackupCode ? 11 : TOTP_DIGITS}
            testID="signin-second-factor"
          />
          <AccountFlowAction
            label={t('signin.actions.continue')}
            onPress={() => submitSecondFactor(secondFactorCode)}
            pending={pending}
            disabled={rateLimitSeconds > 0}
            testID="signin-second-factor-continue"
          />
          <View style={styles.links}>
            <SubtleLink
              label={useBackupCode ? t('signin.secondFactor.useAuthenticator') : t('signin.secondFactor.useBackup')}
              theme={theme}
              onPress={() => {
                setUseBackupCode(!useBackupCode);
                setSecondFactorCode('');
                setError(null);
              }}
              disabled={pending}
              testID="signin-toggle-backup"
            />
            <SubtleLink
              label={t('signin.checkEmail.differentAccount')}
              theme={theme}
              onPress={backToIdentifier}
              disabled={pending}
              testID="signin-different-account"
            />
          </View>
        </OxyAuthScreen>
      );
      break;
    default: {
      const adding = host === 'dialog' && snapshot.hasSession;
      const title = adding ? t('signin.addAccountTitle') : t('signin.title');
      const description = adding
        ? t('signin.addAccountSubtitle')
        : appName
          ? t('signin.subtitleToApp', { app: appName })
          : t('signin.subtitle');

      const continueWithOxyButton = (
        <Button appearance="outline" tone="neutral" size="lg" fullWidth onPress={continueWithOxy} testID="continue-with-oxy">
          {t('accountSwitcher.continueWithOxy')}
        </Button>
      );
      const divider = <Divider>{t('signin.orContinueWith')}</Divider>;

      form = (
        <OxyAuthScreen className={splits ? 'md:max-w-none' : undefined}>
          <OxyAuthScreenHeader title={title} description={description} />

          {/* The Commons way in, then the email. On the web from `md` the QR
              beside the form IS the Commons way in; below `md` this screen is
              the phone a QR would be scanned with. */}
          {splits ? (
            <CssView className="gap-6 md:hidden">
              {continueWithOxyButton}
              {divider}
            </CssView>
          ) : null}
          {methods.commons === 'continue' ? (
            <View style={styles.stack}>
              {continueWithOxyButton}
              {divider}
            </View>
          ) : null}
          {methods.commons === 'get-commons' ? (
            <View style={styles.stack}>
              <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{t('accountSwitcher.commonsNotInstalled')}</Text>
              <Button appearance="outline" tone="neutral" size="lg" fullWidth onPress={getCommons} testID="get-commons-button">
                {t('accountSwitcher.getCommons')}
              </Button>
              {divider}
            </View>
          ) : null}

          <View style={styles.stack}>
            <AccountFlowField
              label={t('signin.identifier.label')}
              value={identifier}
              onChange={(value) => {
                setIdentifier(value);
                clearError();
              }}
              onSubmit={submitIdentifier}
              error={shownError}
              disabled={blocked}
              placeholder={t('signin.identifier.placeholder')}
              autoComplete="username"
              keyboardType="email-address"
              autoFocus={Platform.OS === 'web'}
              testID="signin-identifier"
            />
            <Text style={[styles.note, styles.noAccount, { color: theme.colors.textSecondary }]}>
              {t('signin.noAccount')}{' '}
              <RNText
                accessibilityRole="link"
                onPress={onCreateAccount}
                style={[styles.noAccountLink, { color: theme.colors.text }]}
                testID="create-account-link"
              >
                {t('signin.createAccount')}
              </RNText>
            </Text>
            <AccountFlowAction
              label={t('signin.actions.continue')}
              onPress={submitIdentifier}
              pending={pending}
              disabled={rateLimitSeconds > 0}
              testID="signin-identifier-continue"
            />
          </View>
          <OxyAuthTerms />
        </OxyAuthScreen>
      );
    }
  }

  if (!splits) return <>{form}</>;
  return (
    <OxyAuthSplit
      bare={host === 'dialog'}
      aside={
        <>
          <AuthMediaCarousel slides={SIGN_IN_SLIDES} style={StyleSheet.absoluteFill} />
          {step.name === 'start' ? <InlineCommonsQr controller={controller} /> : null}
        </>
      }
    >
      {form}
    </OxyAuthSplit>
  );
};

const styles = StyleSheet.create({
  stack: {
    gap: 12,
  },
  links: {
    gap: 4,
  },
  note: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  noAccount: {
    textAlign: 'left',
  },
  noAccountLink: {
    textDecorationLine: 'underline',
  },
});
