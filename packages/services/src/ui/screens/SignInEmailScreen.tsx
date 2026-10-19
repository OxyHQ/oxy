import type React from 'react';
import { OxyEmailPanel } from '../components/signIn/OxyEmailPanel';
import type { BaseScreenProps } from '../types/navigation';
import { AccountSecurityPanelFrame } from './AccountSecurityPanelScreen';

/** `SignInEmail`: add, change or remove the account's email. */
const SignInEmailScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => (
  <AccountSecurityPanelFrame>
    <OxyEmailPanel onDone={goBack ?? onClose} />
  </AccountSecurityPanelFrame>
);

export default SignInEmailScreen;
