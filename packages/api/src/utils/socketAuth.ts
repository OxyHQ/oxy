/**
 * Socket.IO handshake → room identity, resolved WITHOUT ever trusting a
 * client-supplied user or device id.
 *
 * Two authenticated lanes:
 *  - Bearer access token → user socket (`user:<id>` + `device:<deviceId>` from JWT).
 *    An application token (ADR 0058, `host` claim) joins `user:<id>` only.
 *  - Device credential (`deviceId` + `deviceSecret`) → device-only socket
 *    (`device:<deviceId>` only) for signed-out tabs that already hold the
 *    canonical device id from the one-shot join redirect.
 */
import jwt from 'jsonwebtoken';
import deviceSessionService from '../services/deviceSession.service';
import { logger } from './logger';

/** An authenticated user socket: full identity, both `user:` and `device:` rooms. */
export interface SocketUserIdentity {
  kind: 'user';
  user: { id: string; deviceId?: string; [key: string]: unknown };
}

/** A device-only socket: listens on `device:<deviceId>` without a user bearer. */
export interface SocketDeviceIdentity {
  kind: 'device';
  deviceId: string;
}

/** Resolved handshake identity, or `null` to reject the connection. */
export type SocketIdentity = SocketUserIdentity | SocketDeviceIdentity | null;

/** The subset of a Socket.IO `Handshake` this resolver reads. */
export interface SocketHandshakeAuthInput {
  auth?: Record<string, unknown>;
}

interface AccessTokenClaims extends jwt.JwtPayload {
  userId?: string;
  id?: string;
  deviceId?: string;
  /** Present only on an application token (ADR 0058). */
  host?: unknown;
}

export async function resolveSocketIdentity(
  handshake: SocketHandshakeAuthInput,
): Promise<SocketIdentity> {
  const rawToken = handshake.auth?.token;
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (token) {
    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      logger.error('resolveSocketIdentity: ACCESS_TOKEN_SECRET is not configured');
    } else {
      try {
        const decoded = jwt.verify(token, secret);
        if (typeof decoded !== 'string') {
          const claims = decoded as AccessTokenClaims;
          const userId = claims.userId ?? claims.id;
          if (userId) {
            if (claims.host !== undefined) {
              // An application token (ADR 0058) joins `user:<id>` only: device
              // state is the platform's, so no `device:<id>` room, whatever
              // the claims say.
              const { deviceId: _ignored, ...rest } = claims;
              return { kind: 'user', user: { ...rest, id: userId } };
            }
            return { kind: 'user', user: { id: userId, ...claims } };
          }
        }
      } catch (error) {
        logger.debug('resolveSocketIdentity: bearer verify failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const rawDeviceId = handshake.auth?.deviceId;
  const rawDeviceSecret = handshake.auth?.deviceSecret;
  const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId : '';
  const deviceSecret = typeof rawDeviceSecret === 'string' ? rawDeviceSecret : '';
  if (deviceId && deviceSecret) {
    const state = await deviceSessionService.getStateBySecret(deviceId, deviceSecret);
    if (state) {
      return { kind: 'device', deviceId: state.deviceId };
    }
    logger.debug('resolveSocketIdentity: device credential verify failed', { deviceId });
  }

  return null;
}
