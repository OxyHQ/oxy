import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
    buildSwitcherRows,
    projectDevicePrincipals,
    type DeviceContext,
    type SwitcherPrincipalRow,
} from '@oxyhq/core';
import { useOxy } from '../context/OxyContext';
import { useI18n } from './useI18n';
import { EMPTY_ACCOUNT_DIALOG_SNAPSHOT } from './accountDialogSnapshot';

export interface UseDeviceSwitcherResult {
    /**
     * Everyone signed in on this device, each with the accounts they may act as,
     * with names, handles and avatar URLs already resolved.
     *
     * Grouped by PERSON, which is the whole point: the same organization
     * reachable through two people is two rows under two humans. The flat list
     * this replaced was keyed by account id and could show only one of them.
     */
    principals: SwitcherPrincipalRow[];
    /** The active `principal acting as account` pair, or `null`. */
    activeContext: DeviceContext | null;
    /** True until the first directory read settles with nothing to show. */
    isLoading: boolean;
    /** The `contextId` of an activation in flight, or `null`. */
    activatingContextId: string | null;
    /** The `contextId` of a context removal in flight, or `null`. */
    removingContextId: string | null;
    /** The `principalId` of a principal removal in flight, or `null`. */
    removingPrincipalId: string | null;
    /**
     * Make one pair active. Resolves `false` when it was refused — the reason is
     * on the dialog controller's `error`, and the row is simply not offered
     * again after the refresh that follows.
     */
    activateContext: (contextId: string) => Promise<boolean>;
    /** Drop ONE `principal → account` pair, leaving anyone else's route intact. */
    signOutContext: (contextId: string) => Promise<boolean>;
    /** Drop ONE PERSON and every context they reach, and nobody else's. */
    signOutPrincipal: (principalId: string) => Promise<boolean>;
}

/**
 * The device switcher, straight from `GET /session/device/directory` (ADR 0002).
 *
 * A thin binding over the shared `AccountDialogController` in `@oxyhq/core` —
 * the SAME headless source `OxyAccountDialogScreen` renders — so the SDK's own
 * dialog and the `auth.oxy.so` chooser show one list, built once, on the server.
 *
 * It used to hand back a flat `SwitchableAccount[]` assembled here from
 * `listAccounts()` + `getUsersByIds()` unioned with the device's session set.
 * That union was not merely redundant: the client holds ONE caller's account
 * graph, so on a device holding two people it presented one person's answer as
 * the device's, and switchability — an authorization question — was decided
 * client-side. Both are the server's answers now, and selecting a row activates
 * a `contextId`, never an `accountId`.
 */
export function useDeviceSwitcher(): UseDeviceSwitcherResult {
    const { accountDialogController: controller, oxyServices } = useOxy();
    const { locale } = useI18n();

    const subscribe = useCallback(
        (listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined),
        [controller],
    );
    const getSnapshot = useCallback(
        () => (controller ? controller.getSnapshot() : EMPTY_ACCOUNT_DIALOG_SNAPSHOT),
        [controller],
    );
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    // `directory` is a stable reference between reads (`SessionClient` holds the
    // one it applied), so this recomputes only when the device actually moved.
    const principals = useMemo(
        () =>
            buildSwitcherRows(
                projectDevicePrincipals(snapshot.directory),
                snapshot.activeContext?.contextId ?? null,
                (avatar) => (avatar ? oxyServices.getFileDownloadUrl(avatar, 'thumb') : undefined),
                locale,
            ),
        [snapshot.directory, snapshot.activeContext, oxyServices, locale],
    );

    const activateContext = useCallback(
        async (contextId: string) => (controller ? controller.activateContext(contextId) : false),
        [controller],
    );
    const signOutContext = useCallback(
        async (contextId: string) => (controller ? controller.signOutContext(contextId) : false),
        [controller],
    );
    const signOutPrincipal = useCallback(
        async (principalId: string) => (controller ? controller.signOutPrincipal(principalId) : false),
        [controller],
    );

    return {
        principals,
        activeContext: snapshot.activeContext,
        isLoading: snapshot.loading,
        activatingContextId: snapshot.activatingContextId,
        removingContextId: snapshot.removingContextId,
        removingPrincipalId: snapshot.removingPrincipalId,
        activateContext,
        signOutContext,
        signOutPrincipal,
    };
}
