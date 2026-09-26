import type React from 'react';
import { OxyLinkCommonsPanel } from '../components/signIn/OxyLinkCommonsPanel';
import type { BaseScreenProps } from '../types/navigation';
import { AccountSecurityPanelFrame } from './AccountSecurityPanelScreen';

/** `LinkCommons`: make the account self-custodied with the key Commons holds. */
const LinkCommonsScreen: React.FC<BaseScreenProps> = () => (
  <AccountSecurityPanelFrame>
    <OxyLinkCommonsPanel />
  </AccountSecurityPanelFrame>
);

export default LinkCommonsScreen;
