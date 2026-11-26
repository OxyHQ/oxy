import { useCallback } from 'react';
import { type Action, type ActionView, useAction } from '@oxy.so/bloom-data';
import type { User } from '@oxy.so/core';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '../../context/oxyRuntimeContext';
import {
  logoutAllAction,
  logoutSessionAction,
  removeDeviceAction,
  renameDeviceAction,
  switchSessionAction,
} from '../../data/sessions';
import { useApiErrorToast } from '../useApiErrorToast';

/**
 * One of this file's actions as a component calls it: `run(...args)` calls
 * `action(...bind(args))` in the tree's store, toasts `success` when it
 * resolves and the API error (under `errorKey`) when it rejects, and rejects
 * with that error.
 */
function useServicesAction<A extends unknown[], U extends unknown[], R>(
  act: Action<A, R>,
  bind: (...args: U) => A,
  errorKey: string,
  success?: string,
): ActionView<U, R> {
  const showApiError = useApiErrorToast();
  const view = useAction(act);
  const call = view.run;
  const run = useCallback(
    async (...args: U) => {
      try {
        const result = await call(...bind(...args));
        if (success) toast.success(success);
        return result;
      } catch (error) {
        showApiError(error, errorKey);
        throw error;
      }
    },
    [call, bind, errorKey, success, showApiError],
  );
  return { ...view, run };
}

/** Switch the active session. Resolves with the account switched to. */
export const useSwitchSession = (): ActionView<[sessionId: string], User> => {
  const { switchSession } = useOxy();
  const bind = useCallback(
    (sessionId: string): [typeof switchSession, string] => [switchSession, sessionId],
    [switchSession],
  );
  return useServicesAction(switchSessionAction, bind, 'actionErrors.switchSession');
};

/** Log out of one session (the active one when none is named). Resolves with the session ended. */
export const useLogoutSession = (): ActionView<[targetSessionId?: string], string> => {
  const { oxyServices, activeSessionId } = useOxy();
  const bind = useCallback(
    (targetSessionId?: string): [typeof oxyServices, string | null, string | undefined] => [
      oxyServices,
      activeSessionId,
      targetSessionId,
    ],
    [oxyServices, activeSessionId],
  );
  return useServicesAction(logoutSessionAction, bind, 'actionErrors.logout');
};

/** Log out of every session of the account. */
export const useLogoutAll = (): ActionView<[], void> => {
  const { oxyServices, activeSessionId, clearSessionState } = useOxy();
  const bind = useCallback(
    (): [typeof oxyServices, string | null, () => Promise<void>] => [
      oxyServices,
      activeSessionId,
      clearSessionState,
    ],
    [oxyServices, activeSessionId, clearSessionState],
  );
  return useServicesAction(
    logoutAllAction,
    bind,
    'actionErrors.logoutAll',
    'Logged out from all sessions',
  );
};

/** Rename this device. */
export const useUpdateDeviceName = (): ActionView<
  [deviceName: string],
  { success: boolean; message: string; deviceName: string }
> => {
  const { oxyServices, activeSessionId } = useOxy();
  const bind = useCallback(
    (deviceName: string): [typeof oxyServices, string | null, string] => [
      oxyServices,
      activeSessionId,
      deviceName,
    ],
    [oxyServices, activeSessionId],
  );
  return useServicesAction(
    renameDeviceAction,
    bind,
    'actionErrors.updateDeviceName',
    'Device name updated',
  );
};

/** Remove a device. Resolves with its id. */
export const useRemoveDevice = (): ActionView<[deviceId: string], string> => {
  const { oxyServices, activeSessionId } = useOxy();
  const bind = useCallback(
    (deviceId: string): [typeof oxyServices, string | null, string] => [
      oxyServices,
      activeSessionId,
      deviceId,
    ],
    [oxyServices, activeSessionId],
  );
  return useServicesAction(removeDeviceAction, bind, 'actionErrors.removeDevice', 'Device removed');
};
