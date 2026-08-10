import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SwitchableAccount } from '@oxyhq/core';
import { useOxy } from '../context/OxyContext';
import { EMPTY_ACCOUNT_DIALOG_SNAPSHOT } from './accountDialogSnapshot';

export interface UseSwitchableAccountsResult {
    /** Every switchable account (device sign-ins + linked graph accounts). */
    accounts: SwitchableAccount[];
    /** True until the initial account-list fetch settles with no data yet. */
    isLoading: boolean;
    /** The currently-active account's device session id, or `null`. */
    currentSessionId: string | null;
}


/**
 * Every account the signed-in user can switch into — device sign-ins AND linked
 * graph accounts (owned orgs + shared-with-you) — as one flat, deduped list with
 * real per-account name / email / avatar / color.
 *
 * This is a thin binding over the shared `AccountDialogController` in
 * `@oxyhq/core` (the SAME headless source the {@link OxyAccountDialogScreen} renders),
 * so there is ONE projection (`projectSwitchableAccounts`) and one switch path
 * (`controller.switchTo`) across the whole SDK — the local duplicate projection
 * this hook used to own has been removed. Every switch routes through
 * `useOxy().switchToAccount(accountId)` (or the dialog's row press).
 */
export function useSwitchableAccounts(): UseSwitchableAccountsResult {
    const { accountDialogController: controller } = useOxy();

    const subscribe = useCallback(
        (listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined),
        [controller],
    );
    const getSnapshot = useCallback(
        () => (controller ? controller.getSnapshot() : EMPTY_ACCOUNT_DIALOG_SNAPSHOT),
        [controller],
    );
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const currentSessionId = useMemo<string | null>(() => {
        const active = snapshot.accounts.find((account) => account.accountId === snapshot.activeAccountId);
        return active?.sessionId ?? null;
    }, [snapshot]);

    return {
        accounts: snapshot.accounts,
        isLoading: snapshot.loading,
        currentSessionId,
    };
}
