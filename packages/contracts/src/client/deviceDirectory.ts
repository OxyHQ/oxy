/**
 * Device-directory checks, without Zod. Schemas: `../deviceDirectory.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  DeviceActivateResponse,
  DeviceDirectory,
  DeviceDirectorySync,
} from '../deviceDirectory';
import { ACCOUNT_KINDS } from './accountGraph';
import {
  array,
  boolean,
  exact,
  int,
  minLength,
  nonnegative,
  nullable,
  number,
  object,
  oneOf,
  optional,
  string,
} from './check';
import { activeTokenCheck, deviceSessionStateCheck } from './deviceSession';
import { userNameCheck } from './userResponse';

const DEVICE_CONTEXT_RELATIONSHIPS = ['self', 'owner', 'member'] as const;

const profile = object({
  id: string(minLength(1)),
  username: string(),
  name: optional(userNameCheck),
  avatar: optional(nullable(string())),
  color: optional(nullable(string())),
});

const accountContext = object({
  id: string(minLength(1)),
  accountId: string(minLength(1)),
  kind: oneOf(ACCOUNT_KINDS),
  relationship: oneOf(DEVICE_CONTEXT_RELATIONSHIPS),
  account: profile,
  onDevice: boolean,
  available: boolean,
  active: boolean,
  lastUsedAt: nullable(number()),
});

const principal = object({
  id: string(minLength(1)),
  userId: string(minLength(1)),
  authuser: number(int, nonnegative),
  user: profile,
  contexts: array(accountContext),
});

export const deviceDirectoryCheck = exact<DeviceDirectory>()(
  object({
    deviceId: string(minLength(1)),
    revision: number(int, nonnegative),
    activeContextId: nullable(string()),
    principals: array(principal),
    updatedAt: number(),
  }),
);

export const deviceActivateResponseCheck = exact<DeviceActivateResponse>()(
  object({ directory: deviceDirectoryCheck, activeToken: nullable(activeTokenCheck) }),
);

export const deviceDirectorySyncCheck = exact<DeviceDirectorySync>()(
  object({
    directory: deviceDirectoryCheck,
    state: deviceSessionStateCheck,
    activeToken: nullable(activeTokenCheck),
  }),
);
