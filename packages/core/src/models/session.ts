import type { UserNameResponse } from '@oxyhq/contracts';

export interface ClientSession {
  sessionId: string;
  deviceId: string;
  expiresAt: string;
  lastActive: string;
  userId?: string;
  isCurrent?: boolean;
  /**
   * The account's ordinal slot (0..N) within the device's account set
   * (`SessionAccount.authuser` in `@oxyhq/contracts`), projected from the
   * device-first `DeviceSessionState` — used purely for stable Google-style
   * account-chooser ordering, not for any token-refresh mechanism.
   */
  authuser?: number;
  /**
   * The HUMAN operating this account, when it is a delegated session — the
   * audit actor behind "The Oxy Collective". Absent when the session belongs to
   * the account itself.
   *
   * The flat wire shape has carried it since the multi-account model shipped and
   * nothing read it, so an operated org rendered exactly like a directly
   * signed-in one. `SessionClient.getActiveContext()` is the richer answer
   * (ADR 0002); this is the same fact on the compatibility lane.
   */
  operatedByUserId?: string;
}

export interface StorageKeys {
  sessions: string; // Array of ClientSession objects
  activeSessionId: string; // ID of currently active session
}

export interface MinimalUserData {
  id: string;
  username: string;
  name: UserNameResponse;
  avatar?: string; // file id
}

export interface SessionLoginResponse {
  sessionId: string;
  deviceId: string;
  expiresAt: string;
  user: MinimalUserData;
  /** JWT access token for API authentication */
  accessToken?: string;
  /**
   * Rotating zero-cookie device credential minted on sign-in / claim. Persisted
   * first-party alongside `deviceId` so cold boot can re-mint via
   * `POST /session/device/token`.
   */
  deviceSecret?: string;
}
