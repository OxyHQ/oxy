/**
 * `runAccountDeletionHandoff` — where a native account deletion can be signed.
 *
 * The deletion is signed with the identity key. When this app does not hold it
 * (Commons keeps it on this device, or it lives on another device), the flow
 * must send the user to Commons' own delete-account screen or explain where to
 * go, and it must never fall through to the in-app deletion (OxyHQ/Mention#1169).
 */

import { surfaces, toast } from '@oxy.so/bloom';
import {
  COMMONS_APP_SCHEME,
  COMMONS_DELETE_ACCOUNT_URL,
  runAccountDeletionHandoff,
  type AccountDeletionHandoffDeps,
} from '../../src/ui/utils/accountDeletionHandoff';

const confirm = surfaces.confirm as unknown as jest.Mock;

// Tag translated strings so a test can tell a translation from the fallback.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars?.site ? `[${key}|${vars.site}]` : `[${key}]`;

const makeDeps = (over: Partial<AccountDeletionHandoffDeps> = {}) => {
  const deps = {
    hasIdentity: jest.fn(async () => false),
    canOpenURL: jest.fn(async () => true),
    openURL: jest.fn(async () => undefined),
    t,
    ...over,
  };
  return deps;
};

beforeEach(() => {
  jest.clearAllMocks();
  confirm.mockResolvedValue(false);
});

describe('runAccountDeletionHandoff', () => {
  it('lets the app run its own deletion when it holds the identity key', async () => {
    const deps = makeDeps({ hasIdentity: jest.fn(async () => true) });

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('local');

    expect(deps.canOpenURL).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(deps.openURL).not.toHaveBeenCalled();
  });

  it("opens Commons' delete-account screen when Commons holds the identity on this device", async () => {
    confirm.mockResolvedValue(true);
    const deps = makeDeps();

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(deps.canOpenURL).toHaveBeenCalledWith(COMMONS_APP_SCHEME);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '[deleteAccount.handoff.commonsTitle]',
        description: '[deleteAccount.handoff.commonsMessage]',
        confirmLabel: '[deleteAccount.handoff.openCommons]',
      }),
    );
    expect(deps.openURL).toHaveBeenCalledTimes(1);
    expect(deps.openURL).toHaveBeenCalledWith('oxycommons://delete-account');
    expect(COMMONS_DELETE_ACCOUNT_URL).toBe('oxycommons://delete-account');
  });

  it('opens nothing when the user declines the handoff', async () => {
    confirm.mockResolvedValue(false);
    const deps = makeDeps();

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deps.openURL).not.toHaveBeenCalled();
  });

  it('says so when Commons cannot be opened after all', async () => {
    confirm.mockResolvedValue(true);
    const deps = makeDeps({ openURL: jest.fn(async () => Promise.reject(new Error('no handler'))) });

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(toast.error).toHaveBeenCalledWith('[deleteAccount.handoff.commonsOpenFailed]');
  });

  it('explains where to delete the account when Commons is not installed', async () => {
    const deps = makeDeps({ canOpenURL: jest.fn(async () => false) });

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '[deleteAccount.handoff.elsewhereTitle]',
        description: '[deleteAccount.handoff.elsewhereMessage|auth.oxy.so/identity]',
        confirmLabel: '[deleteAccount.handoff.gotIt]',
        hideCancel: true,
      }),
    );
    expect(deps.openURL).not.toHaveBeenCalled();
  });

  it('treats a failed install probe as "not installed"', async () => {
    const deps = makeDeps({ canOpenURL: jest.fn(async () => Promise.reject(new Error('probe'))) });

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[deleteAccount.handoff.elsewhereTitle]' }),
    );
    expect(deps.openURL).not.toHaveBeenCalled();
  });

  it('never routes an unreadable keystore anywhere: it reports it and stops', async () => {
    const deps = makeDeps({ hasIdentity: jest.fn(async () => Promise.reject(new Error('locked'))) });

    await expect(runAccountDeletionHandoff(deps)).resolves.toBe('handled');

    expect(toast.error).toHaveBeenCalledWith('[deleteAccount.handoff.identityUnreadable]');
    expect(deps.canOpenURL).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(deps.openURL).not.toHaveBeenCalled();
  });

  it('reads English, not a raw key, against a core that has no string for it', async () => {
    const deps = makeDeps({ canOpenURL: jest.fn(async () => false), t: (key: string) => key });

    await runAccountDeletionHandoff(deps);

    const options = confirm.mock.calls[0]?.[0] as { title: string; description: string };
    expect(options.title).toBe('Delete your account where your identity is');
    expect(options.description).toContain('Settings > Delete account');
    expect(options.description).toContain('auth.oxy.so/identity');
  });
});
