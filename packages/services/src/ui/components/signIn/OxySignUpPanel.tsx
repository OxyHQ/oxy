/**
 * Account creation — the same screen in the account dialog and on
 * auth.oxy.so/signup.
 *
 * An Oxy account is created WITH its self-custody root, or not at all (ADR
 * 0024 D4), and only auth.oxy.so may create one: on the web the
 * account is made in the identity window — the same one a passkey sign-in off
 * an `oxy.so` origin opens — and never on this page, whatever its origin. On
 * native, Commons creates the identity: straight in when it is installed,
 * "Get Commons" otherwise.
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '../../context/OxyContext';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';
import { useI18n } from '../../hooks/useI18n';
import { getCommonsAcquisitionUrl } from '../../utils/commonsStoreLinks';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { SubtleLink } from '../authChooser/primitives';
import { OxyAuthScreen, OxyAuthScreenHeader, OxyAuthTerms } from './OxyAuthScreen';

/** Commons' own identity-creation deep link. */
const COMMONS_CREATE_IDENTITY_URL = 'oxycommons://create-identity';

export interface OxySignUpPanelProps {
  /** "Already have an account? Sign in". */
  onSignIn: () => void;
  /** On a page: the account the identity window created signed this origin in. */
  onSignedIn?: () => void;
  /** See `OxySignInPanelProps.host`. */
  host?: 'dialog' | 'page';
}

export const OxySignUpPanel: React.FC<OxySignUpPanelProps> = ({ onSignIn, onSignedIn, host = 'page' }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { accountDialogController: controller, openAccountDialog } = useOxy();
  const snapshot = useAccountDialogSnapshot(controller);
  const web = isWebBrowser();

  const [mountedAttempt] = useState(snapshot.signIn.attempt);
  const completedHere = snapshot.signIn.phase === 'completed' && snapshot.signIn.attempt !== mountedAttempt;
  useEffect(() => {
    if (host === 'page' && completedHere) onSignedIn?.();
  }, [host, completedHere, onSignedIn]);

  const openExternal = useCallback(
    (url: string) => {
      Promise.resolve()
        .then(() => Linking.openURL(url))
        .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
    },
    [t],
  );

  // Straight from the press: the identity window is a popup.
  const createOnWeb = () => {
    void controller?.startPasskeyHubSignIn();
    if (host === 'page') openAccountDialog('qr');
  };
  const commonsInstalled = snapshot.commonsAvailability === 'available';

  return (
    <OxyAuthScreen>
      <OxyAuthScreenHeader title={t('signup.title')} description={web ? t('signup.webSubtitle') : t('signup.subtitle')} />
      {web ? (
        <Button
          appearance="solid"
          tone="action"
          size="lg"
          fullWidth
          leadingIcon={RiKey2Line}
          onPress={createOnWeb}
          testID="signup-open-identity"
        >
          {t('signup.createAccount')}
        </Button>
      ) : (
        <Button
          appearance="solid"
          tone="action"
          size="lg"
          fullWidth
          onPress={() =>
            openExternal(commonsInstalled ? COMMONS_CREATE_IDENTITY_URL : getCommonsAcquisitionUrl(Platform.OS))
          }
          testID="signup-commons"
        >
          {commonsInstalled ? t('signup.createInCommons') : t('accountSwitcher.getCommons')}
        </Button>
      )}
      <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onSignIn} testID="back-to-sign-in" />
      <OxyAuthTerms />
    </OxyAuthScreen>
  );
};
