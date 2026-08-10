import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { OxyServices, AccountNode, CreateAccountInput, AccountDialogController, SessionClient } from '@oxyhq/core';
import { logger as loggerUtil } from '@oxyhq/core';
import { isUnauthorizedStatus } from './oxyContextHelpers';
import { IdentityBoundSessionError } from '../session';
import type { CommitInput } from './oxyContextTypes';

interface UseOxyAccountGraphParams {
  isAuthenticated: boolean;
  tokenReady: boolean;
  initialized: boolean;
  /**
   * `sessionMode: 'identity'`. The account graph is a switcher surface, and an
   * identity-bound client authenticates as the owner of the local identity key —
   * permanently. The graph is therefore never fetched and every switch rejects.
   */
  identityBound: boolean;
  oxyServices: OxyServices;
  sessionClient: SessionClient;
  syncFromClient: () => Promise<void>;
  commitSession: (input: CommitInput, options: { activate: boolean }) => Promise<void>;
  accountDialogControllerRef: RefObject<AccountDialogController | null>;
  clearSessionStateRef: RefObject<() => Promise<void>>;
}

export function useOxyAccountGraph({
  isAuthenticated,
  tokenReady,
  initialized,
  identityBound,
  oxyServices,
  sessionClient,
  syncFromClient,
  commitSession,
  accountDialogControllerRef,
  clearSessionStateRef,
}: UseOxyAccountGraphParams) {
  const [accounts, setAccounts] = useState<AccountNode[]>([]);

  const refreshAccounts = useCallback(async (): Promise<void> => {
    if (identityBound || !isAuthenticated || !tokenReady || !oxyServices.getAccessToken()) {
      setAccounts([]);
      return;
    }
    try {
      const list = await oxyServices.listAccounts();
      setAccounts(list);
    } catch (err) {
      if (isUnauthorizedStatus(err)) {
        setAccounts([]);
        await clearSessionStateRef.current();
        return;
      }
      if (__DEV__) {
        loggerUtil.debug('Failed to load accounts', { component: 'OxyContext' }, err as unknown);
      }
    }
  }, [identityBound, isAuthenticated, oxyServices, tokenReady, clearSessionStateRef]);

  useEffect(() => {
    if (!identityBound && isAuthenticated && initialized && tokenReady) {
      refreshAccounts();
      void accountDialogControllerRef.current?.refresh();
    }
  }, [identityBound, isAuthenticated, initialized, tokenReady, refreshAccounts, accountDialogControllerRef]);

  const switchToAccount = useCallback(
    async (accountId: string): Promise<void> => {
      if (identityBound) {
        // Loud rejection, never a silent no-op: a resolved promise here would
        // read to the caller as a completed switch that simply left the user
        // unchanged, which is exactly the confusion this mode must avoid.
        throw new IdentityBoundSessionError('switchToAccount');
      }
      const deviceState = sessionClient.getState();
      if (deviceState?.accounts.some((account) => account.accountId === accountId)) {
        await sessionClient.switchAccount(accountId);
        await syncFromClient();
        return;
      }

      const result = await oxyServices.switchToAccount(accountId);
      if (!result?.user || !result?.sessionId) {
        throw new Error('Account switch did not return a valid session');
      }
      await commitSession(
        {
          sessionId: result.sessionId,
          accessToken: result.accessToken,
          deviceSecret: result.deviceSecret,
          deviceId: result.deviceId,
          expiresAt: result.expiresAt,
          userId: result.user.id,
          user: result.user,
        },
        // A switch is IN-PLACE. Cross-tab/app propagation rides the
        // `session_state` socket.
        { activate: true },
      );
    },
    // The account-scoped cache reset that used to trail both branches here now
    // runs inside the runtime's subject transition, BEFORE any subscriber is
    // woken — so a socket-pushed switch (which never reached this function at
    // all) gets it too.
    [identityBound, oxyServices, sessionClient, syncFromClient, commitSession],
  );

  const createAccount = useCallback(
    async (data: CreateAccountInput): Promise<AccountNode> => {
      const account = await oxyServices.createAccount(data);
      await refreshAccounts();
      return account;
    },
    [oxyServices, refreshAccounts],
  );

  return {
    accounts,
    refreshAccounts,
    switchToAccount,
    createAccount,
  };
}
