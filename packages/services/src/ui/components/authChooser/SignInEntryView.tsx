/**
 * The sign-in ENTRY (`signin` / `add` views) — ONE primary action.
 *
 * Web: "Continue" opens the identity origin (`id.oxy.so`) in a popup, where the
 * person signs in — or creates an account — with a passkey, and the account's
 * self-custody identity is created or unsealed (one identity, two carriers). No
 * philosophy up front: fingerprint, face or device PIN, and they are in. An
 * account that lives on another device is one subordinate link away (Commons
 * QR). Nothing auto-starts: a browser only opens a popup from a user gesture.
 *
 * Native: "Continue with Oxy" — the Commons flow (shared keychain, else the
 * request Oxy routes to the person's Commons identity).
 *
 * Existing accounts still render ABOVE the CTA: "continue as one of these" is a
 * choice of WHO, not of HOW.
 */

import type React from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import {
  showsPrincipalHeaders,
  type AccountDialogSnapshot,
  type SwitcherPrincipalRow,
} from '@oxy.so/core';
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
  /** The device's people, each with the accounts they may act as. */
  principals: SwitcherPrincipalRow[];
  theme: Theme;
  t: Translate;
  handlers: OxyAuthChooserHandlers;
  /** Native's primary action. Starts the Commons flow; Oxy chooses the route from there. */
  onContinueWithOxy: () => void;
  alternatives: SignInAlternatives;
}

const SignInEntryView: React.FC<SignInEntryViewProps> = ({
  snapshot,
  principals,
  theme,
  t,
  handlers,
  onContinueWithOxy,
  alternatives,
}) => {
  const web = alternatives.passkeyAvailable;

  // Web keeps Commons one link away; native keeps its QR/Commons alternatives
  // behind the disclosure, as before.
  const troubleActions: OxySignInSurfaceAction[] = web
    ? [{ key: 'get-commons-link', label: t('accountSwitcher.getCommons'), onPress: alternatives.onGetCommons }]
    : [
        { key: 'scan-qr-link', label: t('accountSwitcher.scanQr'), onPress: alternatives.onShowQr },
        { key: 'get-commons-link', label: t('accountSwitcher.getCommons'), onPress: alternatives.onGetCommons },
      ];

  // Whose route this is only needs naming when the list holds more than one
  // person, or somebody with more than one account — the same rule the account
  // menu's group headers follow.
  const namesTheOperator = showsPrincipalHeaders(principals);
  const rows = principals.flatMap((principal) =>
    principal.contexts.map((context) => ({
      context,
      operatedBy:
        namesTheOperator && context.isDelegated
          ? t('accountSwitcher.context.operatedBy', { name: principal.displayName })
          : null,
    })),
  );

  return (
    <View style={styles.signInBlock}>
      {rows.length > 0 ? (
        <View style={styles.rows}>
          {rows.map(({ context, operatedBy }) => (
            <AccountRow
              key={context.contextId}
              context={context}
              operatedBy={operatedBy}
              theme={theme}
              activating={snapshot.activatingContextId === context.contextId}
              disabled={snapshot.activatingContextId !== null}
              onPress={() => handlers.onActivate(context.contextId)}
            />
          ))}
          <Dividerish theme={theme} label={t('signin.or')} />
        </View>
      ) : null}

      {web ? (
        <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
          {t('accountSwitcher.passkeyHint')}
        </Text>
      ) : null}

      <Button
        appearance="solid" tone="accent"
        onPress={web ? alternatives.onSignInWithPasskey : onContinueWithOxy}
        style={styles.primaryButton}
        testID="continue-with-oxy"
      >
        {web ? t('accountSwitcher.continueWithPasskey') : t('accountSwitcher.continueWithOxy')}
      </Button>

      {/* Account CREATION is not an authentication method — it is the way in for
          someone who has no account yet — so it keeps its own subordinate link. */}
      <SubtleLink
        label={t('signin.createAccountLink')}
        theme={theme}
        onPress={alternatives.onCreateAccount}
        testID="create-account-link"
      />

      {web ? (
        <SubtleLink
          label={t('accountSwitcher.otherDeviceCommons')}
          theme={theme}
          onPress={alternatives.onShowQr}
          testID="scan-qr-link"
        />
      ) : null}

      <TroubleDisclosure actions={troubleActions} revealed={false} theme={theme} t={t} />
    </View>
  );
};

export default SignInEntryView;
