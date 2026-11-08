/**
 * The SDK's sign-in as a step of a platform's setup (`OxySetupFlow`): the
 * account dialog's own chooser (`OxyAuthChooser`), unchanged — the same sign-in
 * (the Commons QR from `md`, the email's code or link, the password, the
 * authenticator), sign-up and request views every Oxy app shows.
 *
 * The flow is its surface: the chooser asks it for the split card's 880 while
 * its QR side shows and for the flow's own width after, as it asks the account
 * dialog. The step draws no title (the chooser's screens bring their own) and
 * leaves focus to them (the identifier field takes it on a computer).
 *
 * The host learns the sign-in where it always has: the credential a sign-in
 * commits goes to `OxyProvider`'s `authStateStore` (`PlatformSetupAuthStateStore`,
 * with `context.method` 'qr' or 'password' and the typed password), and
 * `useOxy()` follows the signed-in account. Needs `OxyProvider` around the flow.
 */

import OxyAuthChooser from '../OxyAuthChooser';
import type { OxySetupStep } from './OxySetupFlow';

export interface OxySignInStepOptions {
  /** The step's `id`. Default `'oxy-sign-in'`. */
  id?: string;
}

export function oxySignInStep(options: OxySignInStepOptions = {}): OxySetupStep {
  return {
    id: options.id ?? 'oxy-sign-in',
    initialFocus: 'content',
    content: <OxyAuthChooser />,
  };
}
