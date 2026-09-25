/**
 * THE Oxy sign-in screen. The account dialog every Oxy app opens and the
 * auth.oxy.so IdP page third parties are sent to render this one component,
 * so what the person sees is the same wherever they sign in; only where it is
 * mounted differs (`host`).
 *
 *   picker   a returning device: "Choose an account", then "Use another account"
 *   entry    the header, the Commons way in, the username with its Continue,
 *            "or continue with" a passkey, and the way in for someone with no
 *            account. Continue is a username-first passkey sign-in: the
 *            server scopes the ceremony to that account's credentials, so it
 *            takes a platform passkey AND a hardware security key with no
 *            resident credential (a U2F key such as a Titan). The passkey
 *            button is the discoverable ceremony, with nothing to type. Off an
 *            `oxy.so` origin both run in the identity window instead.
 *            On the web, from `md`, the screen is Bloom `AuthCard`'s split
 *            card and the Commons way in is the embedded QR over its photo
 *            carousel, in the right column; below `md`, and on native, it is
 *            "Continue with Oxy" at the top ("Get Commons" on a native device
 *            without Commons)
 *
 * `signInMethods.ts` owns which blocks a platform gets.
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Text as RNText, StyleSheet, View } from 'react-native';
import { View as CssView } from 'react-native-css/components';
import { AuthMediaCarousel } from '@oxy.so/bloom/auth-card';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiQrCodeLine } from '@oxy.so/bloom/icons/RiQrCodeLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { TextField, TextFieldHint, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { isOxyRpOrigin, type SwitcherContextRow } from '@oxy.so/core';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '../../context/OxyContext';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';
import { useDeviceSwitcher } from '../../hooks/useDeviceSwitcher';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaceFrameWidth } from '../../hooks/useSurfaceFrameWidth';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { SIGN_IN_SLIDES } from './artwork';
import { InlineCommonsQr } from './InlineCommonsQr';
import { OxyAccountPicker } from './OxyAccountPicker';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthSplit, OxyAuthTerms } from './OxyAuthScreen';
import { RATE_LIMIT_SECONDS, describePasskeyError, isRateLimited } from './passkeyError';
import { resolveSignInMethods } from './signInMethods';

/** Bloom `AuthCard`'s split card width, which the account dialog grows to for it. */
const SPLIT_WIDTH = 880;

export interface OxySignInPanelProps {
  /** This screen signed the origin in. */
  onSignedIn: () => void;
  /** "New to Oxy? Create one". */
  onCreateAccount: () => void;
  /** A handle to pre-fill, skipping the picker (a re-authentication). */
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
  const { accountDialogController: controller, openAccountDialog, signInWithPasskey } = useOxy();
  const snapshot = useAccountDialogSnapshot(controller);
  const { principals, activeContext } = useDeviceSwitcher();

  const methods = resolveSignInMethods({
    web: isWebBrowser(),
    oxyRpOrigin: isOxyRpOrigin(),
    commonsAvailability: snapshot.commonsAvailability,
  });

  const [showForm, setShowForm] = useState(Boolean(loginHint));
  const [identifier, setIdentifier] = useState(loginHint ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
  const blocked = pending || rateLimitSeconds > 0;

  // The countdown after a 429: one tick a second until the person may retry.
  useEffect(() => {
    if (rateLimitSeconds <= 0) return;
    const timer = setTimeout(() => setRateLimitSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [rateLimitSeconds]);

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

  // Both of these open a window or leave the page, so they run straight from
  // the press, before any await.
  const continueWithOxy = () => {
    void controller?.signInWithOxy();
    showRequest();
  };
  const useAnotherDevice = () => {
    void controller?.showQr();
    showRequest();
  };
  const openIdentityWindow = () => {
    void controller?.startPasskeyHubSignIn();
    showRequest();
  };
  const getCommons = () => {
    Promise.resolve()
      .then(() => Linking.openURL(getCommonsAcquisitionUrl(Platform.OS)))
      .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
  };

  const runPasskey = async (username: string | undefined, failToast: string) => {
    if (blocked) return;
    setError(null);
    setPending(true);
    try {
      await signInWithPasskey({ username });
      onSignedIn();
    } catch (err) {
      if (isRateLimited(err)) {
        setRateLimitSeconds(RATE_LIMIT_SECONDS);
      } else {
        const message = describePasskeyError(err, t);
        setError(message);
        toast.error(failToast, { description: message });
      }
    } finally {
      setPending(false);
    }
  };
  const submitUsername = () => {
    const username = identifier.trim();
    if (username) void runPasskey(username, t('signin.errors.failed'));
    else setError(t('signin.username.required'));
  };

  // A returning device starts at WHO. Not while adding an account from inside
  // a signed-in app: the rows are the accounts it would add.
  const pickerAllowed = host === 'dialog' ? !snapshot.hasSession : activeContext !== null;
  const reauthenticate = (context: SwitcherContextRow) => {
    setIdentifier(context.handle ?? '');
    setShowForm(true);
  };
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
        if (host === 'page' && context.handle && methods.passkey === 'direct') reauthenticate(context);
        else toast.error(t('accountSwitcher.toasts.activateFailed'));
        return;
      default:
        return;
    }
  };

  const showsPicker = pickerAllowed && !showForm && principals.length > 0;
  // The web entry is the split card from `md`. In the account dialog it grows
  // the dialog to that card — the same screen auth.oxy.so shows, not a
  // narrower cousin of it; below `md` the dialog is a bottom sheet, which a
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

  const adding = host === 'dialog' && snapshot.hasSession;
  const title = adding ? t('signin.addAccountTitle') : t('signin.title');
  const description = adding
    ? t('signin.addAccountSubtitle')
    : appName
      ? t('signin.subtitleToApp', { app: appName })
      : t('signin.subtitle');
  const noAccount = (
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
  );
  // One solid action per screen: the username's Continue when there is one.
  const commonsAppearance = methods.passkey === 'direct' ? 'outline' : 'solid';

  const continueWithOxyButton = (
    <Button
      appearance={commonsAppearance}
      tone={commonsAppearance === 'solid' ? 'action' : 'neutral'}
      size="lg"
      fullWidth
      onPress={continueWithOxy}
      testID="continue-with-oxy"
    >
      {t('accountSwitcher.continueWithOxy')}
    </Button>
  );

  const form = (
    <OxyAuthScreen className={splits ? 'md:max-w-none' : undefined}>
      <OxyAuthScreenHeader title={title} description={description} />

      {/* Below `md` this screen is the phone a QR would be scanned with. */}
      {splits ? <CssView className="md:hidden">{continueWithOxyButton}</CssView> : null}

      {methods.commons === 'continue' ? continueWithOxyButton : null}
      {methods.commons === 'get-commons' ? (
        <View style={styles.stack}>
          <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{t('accountSwitcher.commonsNotInstalled')}</Text>
          <Button appearance="solid" tone="action" size="lg" fullWidth onPress={getCommons} testID="get-commons-button">
            {t('accountSwitcher.getCommons')}
          </Button>
        </View>
      ) : null}

      {methods.passkey === 'direct' ? (
        <View style={styles.stack}>
          <View style={styles.field}>
            <TextFieldLabel nativeID="username-label">{t('signin.username.label')}</TextFieldLabel>
            <TextField invalid={shownError !== null} disabled={blocked} radius={999} style={styles.input}>
              <TextFieldInput
                testID="username"
                label={t('signin.username.label')}
                value={identifier}
                onValueChange={(value) => {
                  setIdentifier(value);
                  if (error) setError(null);
                }}
                placeholder={t('signin.username.placeholder')}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus={Platform.OS === 'web'}
                returnKeyType="go"
                onSubmitEditing={submitUsername}
                aria-required
              />
            </TextField>
            {shownError ? <TextFieldHint invalid>{shownError}</TextFieldHint> : null}
          </View>
          {noAccount}
          <Button
            appearance="solid"
            tone="action"
            size="lg"
            fullWidth
            loading={pending}
            disabled={blocked}
            onPress={submitUsername}
            testID="username-continue"
          >
            {t('signin.actions.continue')}
          </Button>
        </View>
      ) : null}

      {/* The alternatives to the screen's primary way in, always under it. */}
      <Divider>{t('signin.orContinueWith')}</Divider>

      {methods.passkey === 'none' ? (
        <Button
          appearance="outline"
          tone="neutral"
          size="lg"
          fullWidth
          leadingIcon={RiQrCodeLine}
          onPress={useAnotherDevice}
          testID="scan-qr"
        >
          {t('accountSwitcher.scanQr')}
        </Button>
      ) : (
        <Button
          appearance="outline"
          tone="neutral"
          size="lg"
          fullWidth
          leadingIcon={RiKey2Line}
          disabled={methods.passkey === 'direct' && blocked}
          onPress={
            methods.passkey === 'direct'
              ? () => void runPasskey(undefined, t('signin.errors.failed'))
              : openIdentityWindow
          }
          testID="passkey-sign-in"
        >
          {t('signin.methods.passkey')}
        </Button>
      )}

      {methods.passkey === 'direct' ? null : noAccount}
      <OxyAuthTerms />
    </OxyAuthScreen>
  );

  if (!splits) return form;
  return (
    <OxyAuthSplit
      bare={host === 'dialog'}
      aside={
        <>
          <AuthMediaCarousel slides={SIGN_IN_SLIDES} style={StyleSheet.absoluteFill} />
          <InlineCommonsQr controller={controller} />
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
  field: {
    gap: 6,
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
  input: {
    height: 40,
  },
});
