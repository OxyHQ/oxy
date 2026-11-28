/**
 * What the hosting app told the account dialog about itself.
 *
 * Both fields are optional. Without an app name the sign-in line stays
 * generic, and without a handle template signup shows no profile preview.
 * `OxyProvider` sets this; a screen mounted on its own (auth.oxy.so's
 * `/login`) can pass the same facts as props, which win.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface AccountDialogHost {
  /** The app this dialog signs into, when the host named it. */
  appName?: string | null;
  /**
   * Preview of the public profile a new username becomes. `{username}` is
   * replaced with the typed handle. The host writes its own origin.
   */
  handlePreviewTemplate?: string | null;
}

const EMPTY_ACCOUNT_DIALOG_HOST: AccountDialogHost = {
  appName: null,
  handlePreviewTemplate: null,
};

const AccountDialogHostContext = createContext<AccountDialogHost>(EMPTY_ACCOUNT_DIALOG_HOST);

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const AccountDialogHostProvider: React.FC<AccountDialogHost & { children: ReactNode }> = ({
  appName,
  handlePreviewTemplate,
  children,
}) => {
  const value = useMemo<AccountDialogHost>(
    () => ({
      appName: blankToNull(appName),
      handlePreviewTemplate: blankToNull(handlePreviewTemplate),
    }),
    [appName, handlePreviewTemplate],
  );
  return (
    <AccountDialogHostContext.Provider value={value}>{children}</AccountDialogHostContext.Provider>
  );
};

/** The hosting app's name and profile-preview template, or neither. */
export function useAccountDialogHost(): AccountDialogHost {
  return useContext(AccountDialogHostContext);
}
