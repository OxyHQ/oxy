import type React from 'react';
import { OxyPasswordPanel } from '../components/signIn/OxyPasswordPanel';
import type { BaseScreenProps } from '../types/navigation';
import { AccountSecurityPanelFrame } from './AccountSecurityPanelScreen';

/** `SignInPassword`: set or change the account's password. */
const SignInPasswordScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => (
  <AccountSecurityPanelFrame>
    <OxyPasswordPanel onDone={goBack ?? onClose} onCancel={goBack ?? onClose} />
  </AccountSecurityPanelFrame>
);

export default SignInPasswordScreen;
