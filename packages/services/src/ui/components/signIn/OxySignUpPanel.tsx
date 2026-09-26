/**
 * Account creation in the account dialog.
 *
 * On the web the account is made on auth.oxy.so, in its window over the app
 * (`onCreateOnWeb`), and this app is signed in as it. On native, Commons
 * creates the identity: straight in when it is installed, "Get Commons"
 * otherwise.
 */

import type React from 'react';
import { useCallback } from 'react';
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
  /** The web's one action: auth.oxy.so's sign-up, in its window. */
  onCreateOnWeb: () => void;
}

export const OxySignUpPanel: React.FC<OxySignUpPanelProps> = ({ onSignIn, onCreateOnWeb }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { accountDialogController: controller } = useOxy();
  const snapshot = useAccountDialogSnapshot(controller);
  const web = isWebBrowser();

  const openExternal = useCallback(
    (url: string) => {
      Promise.resolve()
        .then(() => Linking.openURL(url))
        .catch(() => toast.error(t('accountSwitcher.linkOpenFailed')));
    },
    [t],
  );

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
          onPress={onCreateOnWeb}
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
