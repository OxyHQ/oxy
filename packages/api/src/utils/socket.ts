import type { Server as SocketIOServer } from 'socket.io';
import type { DeviceSessionState, SessionAccountsChangedReason } from '@oxy.so/contracts';
import { SESSION_ACCOUNTS_CHANGED_EVENT, SUPERVISION_CHANGED_EVENT } from '@oxy.so/contracts';
import { logger } from './logger';

let io: SocketIOServer | null = null;

export const initializeIO = (socketIO: SocketIOServer) => {
  io = socketIO;
};

export const getIO = () => {
  return io;
};

export const closeIO = () => {
  if (io) {
    if (typeof io.close === 'function') io.close();
    io = null;
  }
};

export function broadcastDeviceState(state: DeviceSessionState): void {
  const server = getIO();
  if (!server) {
    logger.debug('broadcastDeviceState: io not initialised', { deviceId: state.deviceId });
    return;
  }
  server.to(`device:${state.deviceId}`).emit('session_state', state);
}

/**
 * Emit the token-free `session_accounts_changed` signal to `user:<userId>` for
 * each affected user. Unlike {@link broadcastDeviceState} (scoped to a single
 * device/origin), this reaches ALL of a user's connected sockets across their
 * devices/origins so every Oxy app refetches its authenticated session/account
 * state instantly. The payload carries NO token/secret — it is a signal only.
 *
 * `revision` is the mutated DeviceSession revision for device-scoped reasons; for
 * `login` (no device mutation) callers pass 0. Empty / blank ids are dropped, and
 * duplicate ids are de-duplicated so a user is signalled at most once per call.
 */
export function broadcastSessionAccountsChanged(
  userIds: string | readonly string[],
  revision: number,
  reason: SessionAccountsChangedReason,
): void {
  const server = getIO();
  if (!server) return;
  const list = Array.isArray(userIds) ? userIds : [userIds as string];
  const unique = new Set(
    list.filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  for (const userId of unique) {
    server.to(`user:${userId}`).emit(SESSION_ACCOUNTS_CHANGED_EVENT, { userId, revision, reason });
  }
}

/**
 * Emit the token-free {@link SUPERVISION_CHANGED_EVENT} signal to `user:<id>` for
 * each account whose supervision state changed, so every connected Oxy app
 * refetches it instead of polling. It carries no payload; enforcement never
 * depends on it. Blank ids are dropped and duplicates signalled once.
 */
export function broadcastSupervisionChanged(
  accountIds: readonly (string | null | undefined)[],
): void {
  const server = getIO();
  if (!server) return;
  for (const accountId of new Set(accountIds)) {
    if (accountId) server.to(`user:${accountId}`).emit(SUPERVISION_CHANGED_EVENT);
  }
}

export function deviceRoomFor(decoded: { deviceId?: string | null }): string | null {
  return decoded?.deviceId ? `device:${decoded.deviceId}` : null;
}

/**
 * The rooms a connected socket should join, given its resolved identity. An
 * AUTHENTICATED user socket joins BOTH `user:<id>` (notifications) and its
 * `device:<deviceId>` room (JWT claim). A device-only socket joins ONLY its
 * `device:<deviceId>` room — ids are always server-resolved, never client-supplied.
 */
export function socketRoomsFor(identity: {
  user?: { id: string; deviceId?: string | null } | null;
  deviceId?: string | null;
}): string[] {
  const rooms: string[] = [];
  if (identity.user?.id) {
    rooms.push(`user:${identity.user.id}`);
  }
  const deviceRoom = identity.user
    ? deviceRoomFor(identity.user)
    : identity.deviceId
      ? `device:${identity.deviceId}`
      : null;
  if (deviceRoom) {
    rooms.push(deviceRoom);
  }
  return rooms;
}
