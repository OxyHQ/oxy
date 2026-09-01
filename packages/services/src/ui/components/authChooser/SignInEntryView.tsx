/**
 * The sign-in ENTRY (`signin` / `add` views) — ONE primary action.
 *
 * Issue #691, Phase 5: the normal experience presents no menu of authentication
 * methods. The user sees "Continue with Oxy"; Oxy — not the user — then picks
 * how the request reaches their Commons identity, and the request surface shows
 * honest progress. Everything else (a QR from another device, a passkey on this
 * device, getting Commons, creating an account) lives behind "Having trouble?".
 *
 * Existing accounts still render ABOVE the CTA: "continue as one of these" is a
 * choice of WHO, not of HOW, so it is not one of the competing method buttons
 * the issue removes.
 *
 * On web this view is transient — the container auto-starts the flow the instant
 * the view is reached, because the request surface (QR, or "Check Commons on
 * your phone") IS the primary route there, never something behind a tap.
 */

import type React from 'react';
import { View } from 'react-native';
import { Button } from '@oxyhq/bloom/button';
import type { AccountDialogSnapshot } from '@oxyhq/core';
import TroubleDisclosure from './TroubleDisclosure';
import { AccountRow, Dividerish, SubtleLink } from './primitives';
import { authChooserStyles as styles } from './styles';
import type {
  OxyAuthChooserHandlers,
  OxySignInSurfaceAction,
  SignInAlternatives,
  Theme,
  Translate,
} from './types';

interface SignInEntryViewProps {
  snapshot: AccountDialogSnapshot;
  theme: Theme;
  t: Translate;
  handlers: OxyAuthChooserHandlers;
  /** The ONE primary action. Starts the flow; Oxy chooses the route from there. */
  onContinueWithOxy: () => void;
  alternatives: SignInAlternatives;
}

const SignInEntryView: React.FC<SignInEntryViewProps> = ({
  snapshot,
  theme,
  t,
  handlers,
  onContinueWithOxy,
  alternatives,
}) => {
  // The entry has no chosen route yet, so nothing here can have failed: the
  // alternatives stay behind the disclosure unconditionally.
  const troubleActions: OxySignInSurfaceAction[] = [
    {
      key: 'scan-qr-link',
      label: t('accountSwitcher.scanQr'),
      onPress: alternatives.onShowQr,
    },
    ...(alternatives.passkeyAvailable
      ? [
          {
            key: 'passkey-signin-link',
            label: alternatives.passkeyPending
              ? t('accountSwitcher.passkeySigningIn')
              : t('accountSwitcher.useIdentityOnDevice'),
            onPress: alternatives.onSignInWithPasskey,
            disabled: alternatives.passkeyPending,
          },
        ]
      : []),
    {
      key: 'get-commons-link',
      label: t('accountSwitcher.getCommons'),
      onPress: alternatives.onGetCommons,
    },
  ];

  return (
    <View style={styles.signInBlock}>
      {snapshot.accounts.length > 0 ? (
        <View style={styles.rows}>
          {snapshot.accounts.map((account) => (
            <AccountRow
              key={account.accountId}
              account={account}
              theme={theme}
              switching={snapshot.switchingAccountId === account.accountId}
              disabled={snapshot.switchingAccountId !== null}
              onPress={() => handlers.onSwitch(account.accountId)}
            />
          ))}
          <Dividerish theme={theme} label={t('signin.or')} />
        </View>
      ) : null}

      <Button
        variant="primary"
        onPress={onContinueWithOxy}
        style={styles.primaryButton}
        testID="continue-with-oxy"
      >
        {t('accountSwitcher.continueWithOxy')}
      </Button>

      {/* Account CREATION is not an authentication method — it is the way in for
          someone who has no Oxy ID yet — so it keeps its own subordinate link
          rather than hiding behind a troubleshooting affordance. */}
      <SubtleLink
        label={t('signin.createAccountLink')}
        theme={theme}
        onPress={alternatives.onCreateAccount}
        testID="create-account-link"
      />

      <TroubleDisclosure actions={troubleActions} revealed={false} theme={theme} t={t} />
    </View>
  );
};

export default SignInEntryView;
