import type React from 'react';
import { OxyDeleteAccountPanel } from '../components/signIn/OxyDeleteAccountPanel';
import type { BaseScreenProps } from '../types/navigation';
import { AccountSecurityPanelFrame } from './AccountSecurityPanelScreen';

/** `DeleteAccount`: delete an account without a key, with a code by email. */
const DeleteAccountScreen: React.FC<BaseScreenProps> = ({ onClose, goBack }) => (
  <AccountSecurityPanelFrame>
    <OxyDeleteAccountPanel onCancel={goBack ?? onClose} />
  </AccountSecurityPanelFrame>
);

export default DeleteAccountScreen;
