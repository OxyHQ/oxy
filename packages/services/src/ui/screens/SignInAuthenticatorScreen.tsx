import type React from 'react';
import { OxyAuthenticatorPanel } from '../components/signIn/OxyAuthenticatorPanel';
import type { BaseScreenProps } from '../types/navigation';
import { AccountSecurityPanelFrame } from './AccountSecurityPanelScreen';

/** `SignInAuthenticator`: the account's authenticator app and its backup codes. */
const SignInAuthenticatorScreen: React.FC<BaseScreenProps> = () => (
  <AccountSecurityPanelFrame>
    <OxyAuthenticatorPanel />
  </AccountSecurityPanelFrame>
);

export default SignInAuthenticatorScreen;
