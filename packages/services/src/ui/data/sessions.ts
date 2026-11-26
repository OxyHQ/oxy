/**
 * The signed-in account's sessions and devices, held in its
 * `@oxy.so/bloom-data` store: the sessions it has, the sessions on this
 * device, the devices it signed in on, its security information and its
 * storage usage, plus the writes that change them.
 *
 * Each account has its own store, so a switch reads every list afresh and
 * nothing here is cleared by hand. Sessions, devices and the security
 * information are copied to the account's durable store, as their queries
 * were; storage usage is not.
 */
import { action, entity, list, source } from '@oxy.so/bloom-data';
import {
  type AccountStorageUsageResponse,
  authenticatedApiCall,
  type ClientSession,
  type DeviceLinkedSession,
  type OxyServices,
  type SecurityInfo,
  type User as OxyUser,
  type UserDevice,
} from '@oxy.so/core';
import { fetchSessionsWithFallback, mapSessionsToClient } from '../utils/sessionHelpers';
import { ACCOUNT, answerSource } from './answer';
import { sdkRead } from './readOptions';
import { User, userWriter } from './user';
import { normalizeIncoming } from './userRecord';

const SESSION_STALE_MS = 2 * 60_000;
const SESSION_GC_MS = 10 * 60_000;
const DEVICE_STALE_MS = 5 * 60_000;
const DEVICE_GC_MS = 30 * 60_000;

// ── The account's sessions ──────────────────────────────────────────

export const Session = entity<ClientSession>('oxy.session', {
  id: (session) => session.sessionId,
  persist: true,
});

export const Sessions = list('oxy.sessions', { of: Session, persist: true });

/** The account's sessions, read through its active session. `userId` fills rows that name no user. */
export const sessions = source(Sessions, {
  ...sdkRead,
  key: (_oxy: OxyServices, activeSessionId: string, userId: string | undefined) =>
    `${activeSessionId}\u0000${userId ?? ''}`,
  stale: SESSION_STALE_MS,
  gcTime: SESSION_GC_MS,
  load: async (_request, oxy, activeSessionId, userId) => {
    const found = await fetchSessionsWithFallback(oxy, activeSessionId, {
      fallbackDeviceId: undefined,
      fallbackUserId: userId,
    });
    return { items: mapSessionsToClient(found, activeSessionId) };
  },
});

/** One session as its validation describes it (not a row of `Sessions`, whose fields it lacks). */
export const ValidatedSession = entity<ClientSession>('oxy.validated-session', {
  id: (session) => session.sessionId,
  persist: true,
});

export const validatedSession = source(ValidatedSession, {
  ...sdkRead,
  key: (_oxy: OxyServices, sessionId: string) => sessionId,
  stale: SESSION_STALE_MS,
  gcTime: SESSION_GC_MS,
  load: async (_request, oxy, sessionId) => {
    const writeUsers = userWriter();
    const validation = await oxy.session.validate(sessionId, { useHeaderValidation: true });
    if (!validation?.valid || !validation.user) {
      throw new Error('Session not found or invalid');
    }
    writeUsers(validation.user);
    const now = new Date();
    return {
      sessionId,
      deviceId: '', // Device ID not available from validation response
      expiresAt:
        validation.expiresAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastActive: validation.lastActivity || now.toISOString(),
      userId: validation.user.id?.toString() ?? '',
      isCurrent: false,
    };
  },
});

// ── The sessions on this device ─────────────────────────────────────

/** A session on this device; its account is held in `User`, so a profile edit shows on its row. */
export const DeviceSession = entity<DeviceLinkedSession>('oxy.device-session', {
  id: (session) => session.sessionId,
  refs: { user: User },
  persist: true,
});

/** Beside the ids: which rows are this device's own session, so a screen can count the others. */
export interface DeviceSessionsExtra {
  readonly current: readonly string[];
}

export const DeviceSessions = list<DeviceSessionsExtra>('oxy.device-sessions', {
  of: DeviceSession,
  persist: true,
  dropFromExtra: (extra, ids) => ({ current: extra.current.filter((id) => !ids.has(id)) }),
});

export const deviceSessions = source(DeviceSessions, {
  ...sdkRead,
  key: (_oxy: OxyServices, activeSessionId: string) => activeSessionId,
  stale: SESSION_STALE_MS,
  gcTime: SESSION_GC_MS,
  load: async (_request, oxy, activeSessionId) => {
    const rows = (await oxy.devices.sessions(activeSessionId)).map((row) => ({
      ...row,
      user: row.user ? (normalizeIncoming(row.user) ?? undefined) : undefined,
    }));
    return {
      items: rows,
      extra: { current: rows.filter((row) => row.isCurrent).map((row) => row.sessionId) },
    };
  },
  fold: (_current, extra) => extra ?? { current: [] },
});

// ── Devices, security information, storage usage ────────────────────

export const Device = entity<UserDevice>('oxy.device', {
  id: (device) => device.id,
  persist: true,
});

export const Devices = list('oxy.devices', { of: Device, persist: true });

/** The account's devices: one list per account, under `ACCOUNT`. */
export const devices = source(Devices, {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT,
  stale: DEVICE_STALE_MS,
  gcTime: DEVICE_GC_MS,
  load: async (_request, oxy) => ({
    items: await authenticatedApiCall(oxy, undefined, () => oxy.devices.list()),
  }),
});

export const securityInfo = answerSource('oxy.security-info', {
  ...sdkRead,
  persist: true,
  key: (_oxy: OxyServices) => ACCOUNT,
  stale: DEVICE_STALE_MS,
  gcTime: DEVICE_GC_MS,
  load: (_request, oxy): Promise<SecurityInfo> => oxy.devices.securityInfo(),
});

/** Server-aggregated usage across assets, mail, recordings and the rest. */
export const storageUsage = answerSource('oxy.storage-usage', {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT,
  stale: DEVICE_STALE_MS,
  gcTime: DEVICE_GC_MS,
  load: (_request, oxy) =>
    authenticatedApiCall<AccountStorageUsageResponse>(oxy, undefined, () => oxy.assets.usage()),
});

/**
 * Reads again what the account's store holds of its sessions and devices,
 * after a write that changed them. What it does not hold is read when a
 * screen asks for it.
 */
function refreshSessionData(oxy: OxyServices, activeSessionId: string | null): void {
  if (activeSessionId) {
    if (Sessions.get(sessions.key(oxy, activeSessionId, undefined))) {
      void sessions.refresh(oxy, activeSessionId, undefined);
    }
    if (DeviceSessions.get(deviceSessions.key(oxy, activeSessionId))) {
      void deviceSessions.refresh(oxy, activeSessionId);
    }
  }
  if (Devices.get(devices.key(oxy))) void devices.refresh(oxy);
  if (securityInfo.entity.has(securityInfo.key(oxy))) void securityInfo.refresh(oxy);
}

function requireSession(activeSessionId: string | null): string {
  if (!activeSessionId) throw new Error('No active session');
  return activeSessionId;
}

// ── Writes ──────────────────────────────────────────────────────────

/** Switches the active session through the provider's `switchSession`; the new account's store reads afresh. */
export const switchSessionAction = action({
  run: (switchSession: (sessionId: string) => Promise<OxyUser>, sessionId: string) =>
    switchSession(sessionId),
});

/** Hides a session's row in every session list the account holds, as the call's layer. */
function hideSession(sessionId: string): void {
  for (const key of Sessions.keys()) Sessions.remove(key, [sessionId]);
  for (const key of DeviceSessions.keys()) DeviceSessions.remove(key, [sessionId]);
}

/**
 * Ends one session (the active one when no target is named); resolves with the
 * session ended. Its row hides at once and returns if the server refuses.
 */
export const logoutSessionAction = action({
  optimistic: (_oxy, activeSessionId, targetSessionId) => {
    const ended = targetSessionId || activeSessionId;
    if (ended) hideSession(ended);
  },
  run: async (
    oxy: OxyServices,
    activeSessionId: string | null,
    targetSessionId: string | undefined,
  ) => {
    const active = requireSession(activeSessionId);
    const ended = targetSessionId || active;
    await oxy.session.logout(active, ended);
    return ended;
  },
  settle: (ended, oxy, activeSessionId) => {
    Session.remove(ended);
    DeviceSession.remove(ended);
    refreshSessionData(oxy, activeSessionId);
  },
});

/** Ends every session of the account, then tears the local session down. */
export const logoutAllAction = action({
  run: async (
    oxy: OxyServices,
    activeSessionId: string | null,
    clearSessionState: () => Promise<void>,
  ) => {
    await oxy.session.logoutAll(requireSession(activeSessionId));
    await clearSessionState();
  },
});

export const renameDeviceAction = action({
  run: (oxy: OxyServices, activeSessionId: string | null, deviceName: string) =>
    oxy.devices.rename(requireSession(activeSessionId), deviceName),
  settle: (_result, oxy, activeSessionId) => refreshSessionData(oxy, activeSessionId),
});

/** Removes a device; resolves with its id. Its row hides at once and returns if the server refuses. */
export const removeDeviceAction = action({
  optimistic: (_oxy, _activeSessionId, deviceId) => {
    for (const key of Devices.keys()) Devices.remove(key, [deviceId]);
  },
  run: async (oxy: OxyServices, _activeSessionId: string | null, deviceId: string) => {
    await oxy.devices.remove(deviceId);
    return deviceId;
  },
  settle: (_deviceId, oxy, activeSessionId) => refreshSessionData(oxy, activeSessionId),
});
