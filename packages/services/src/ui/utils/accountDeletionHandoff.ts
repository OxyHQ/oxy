import { surfaces } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { IDENTITY_WEB_ORIGIN, logger } from '@oxy.so/core';

/**
 * Commons' own delete-account screen (`app/(tabs)/(settings)/delete-account.tsx`
 * in packages/commons). Expo Router drops the route groups, so the scheme path
 * `delete-account` resolves to it; `oxycommons://` is the scheme the account
 * dialog already probes and hands sign-in approvals to.
 */
export const COMMONS_DELETE_ACCOUNT_URL = 'oxycommons://delete-account';

/** The scheme root `Linking.canOpenURL` probes to tell whether Commons is installed. */
export const COMMONS_APP_SCHEME = 'oxycommons://';

type Translate = (key: string, vars?: Record<string, string | number>) => string | undefined;

export interface AccountDeletionHandoffDeps {
  /** Whether THIS app can read an identity key it could sign the deletion with. */
  hasIdentity: () => Promise<boolean>;
  canOpenURL: (url: string) => Promise<boolean>;
  openURL: (url: string) => Promise<unknown>;
  t: Translate;
}

/**
 * `'local'`: this app holds the identity key, so the caller runs its own
 * delete-account surface. `'handled'`: it does not, and the user has been sent
 * to where the deletion can actually be signed (or told why not).
 */
export type AccountDeletionHandoffResult = 'local' | 'handled';

/**
 * Decide where a native account deletion can happen, before anything is deleted.
 *
 * Deleting an account is signed with the identity private key. When the key
 * lives in Oxy Commons rather than in this app, the API call cannot be made from
 * here, so the deletion is delegated to Commons' own screen when Commons is
 * installed, and explained otherwise. Nothing on the delegated paths calls the
 * deletion API.
 */
export async function runAccountDeletionHandoff(
  deps: AccountDeletionHandoffDeps,
): Promise<AccountDeletionHandoffResult> {
  const { hasIdentity, canOpenURL, openURL, t } = deps;
  const text = (key: string, fallback: string, vars?: Record<string, string>): string => {
    // An older `@oxy.so/core` echoes a key it has no string for; show English then.
    const value = t(key, vars);
    return value && value !== key ? value : fallback;
  };

  let holdsIdentity: boolean;
  try {
    holdsIdentity = await hasIdentity();
  } catch (error) {
    // A locked or unreadable keystore is not proof the identity is elsewhere.
    logger.warn('Identity read failed before account deletion', { component: 'accountDeletionHandoff' }, error);
    toast.error(
      text(
        'deleteAccount.handoff.identityUnreadable',
        "Couldn't read this device's identity storage. Unlock your device and try again.",
      ),
    );
    return 'handled';
  }
  if (holdsIdentity) {
    return 'local';
  }

  let commonsInstalled = false;
  try {
    commonsInstalled = await canOpenURL(COMMONS_APP_SCHEME);
  } catch {
    commonsInstalled = false;
  }

  if (commonsInstalled) {
    const open = await surfaces.confirm({
      title: text('deleteAccount.handoff.commonsTitle', 'Delete your account in Oxy Commons'),
      description: text(
        'deleteAccount.handoff.commonsMessage',
        'Your identity key is kept by Oxy Commons on this device, and deleting your account needs it. Commons will open on Settings > Delete account to finish.',
      ),
      confirmLabel: text('deleteAccount.handoff.openCommons', 'Open Oxy Commons'),
      cancelLabel: text('common.cancel', 'Cancel'),
    });
    if (open) {
      try {
        await openURL(COMMONS_DELETE_ACCOUNT_URL);
      } catch (error) {
        logger.warn('Opening Commons delete-account failed', { component: 'accountDeletionHandoff' }, error);
        toast.error(
          text(
            'deleteAccount.handoff.commonsOpenFailed',
            "Couldn't open Oxy Commons. Open it yourself and go to Settings > Delete account.",
          ),
        );
      }
    }
    return 'handled';
  }

  const site = IDENTITY_WEB_ORIGIN.replace(/^https?:\/\//, '');
  await surfaces.confirm({
    title: text('deleteAccount.handoff.elsewhereTitle', 'Delete your account where your identity is'),
    description: text(
      'deleteAccount.handoff.elsewhereMessage',
      `Deleting your account needs your identity key, and it isn't on this device. Open Oxy Commons on the device that holds your identity and go to Settings > Delete account, or open ${site} in a browser that holds it.`,
      { site },
    ),
    confirmLabel: text('deleteAccount.handoff.gotIt', 'Got it'),
    hideCancel: true,
  });
  return 'handled';
}
