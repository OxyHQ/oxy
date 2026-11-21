import { type ListView, type RecordView, skip, useList, useRecord } from '@oxy.so/bloom-data';
import type { AccountStorageUsageResponse, ClientSession, SecurityInfo } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import {
  type DeviceSessionsExtra,
  deviceSessions,
  devices,
  securityInfo,
  sessions,
  storageUsage,
  validatedSession,
} from '../../data/sessions';

/**
 * The account's sessions, as a list of `Session` ids (read rows with
 * `useEntity(Session, id)`). Waits for an active session.
 */
export const useSessions = (
  userId?: string,
  options?: { enabled?: boolean },
): ListView<unknown> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useList(
    sessions,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices, activeSessionId, userId] as const)
      : ([skip] as const)),
  );
};

/** One session, as its validation describes it. */
export const useSession = (
  sessionId: string | null,
  options?: { enabled?: boolean },
): RecordView<ClientSession> => {
  const { oxyServices } = useOxy();
  return useRecord(
    validatedSession,
    ...(options?.enabled !== false && sessionId
      ? ([oxyServices, sessionId] as const)
      : ([skip] as const)),
  );
};

/**
 * The sessions on this device, as a list of `DeviceSession` ids; `extra.current`
 * names this device's own. Waits for an active session.
 */
export const useDeviceSessions = (options?: {
  enabled?: boolean;
}): ListView<DeviceSessionsExtra> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useList(
    deviceSessions,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices, activeSessionId] as const)
      : ([skip] as const)),
  );
};

/** The account's devices, as a list of `Device` ids. Waits for a signed-in session. */
export const useUserDevices = (options?: { enabled?: boolean }): ListView<unknown> => {
  const { oxyServices, isAuthenticated, activeSessionId } = useOxy();
  return useList(
    devices,
    ...(options?.enabled !== false && isAuthenticated && activeSessionId
      ? ([oxyServices] as const)
      : ([skip] as const)),
  );
};

/** The account's security information. Waits for a signed-in account. */
export const useSecurityInfo = (options?: { enabled?: boolean }): RecordView<SecurityInfo> => {
  const { oxyServices, isAuthenticated } = useOxy();
  return useRecord(
    securityInfo,
    ...(options?.enabled !== false && isAuthenticated
      ? ([oxyServices] as const)
      : ([skip] as const)),
  );
};

/**
 * The account's storage usage (server-aggregated across assets, mail,
 * recordings and the rest). Waits for a signed-in session.
 */
export const useAccountStorageUsage = (options?: {
  enabled?: boolean;
}): RecordView<AccountStorageUsageResponse> => {
  const { oxyServices, isAuthenticated, activeSessionId } = useOxy();
  return useRecord(
    storageUsage,
    ...(options?.enabled !== false && isAuthenticated && activeSessionId
      ? ([oxyServices] as const)
      : ([skip] as const)),
  );
};
