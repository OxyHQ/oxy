import { utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';

// Params with :sessionId
export const sessionIdParams = z.object({
  sessionId: z.string().trim().check(utf16MinLength(1)),
});

// POST /session/logout/:sessionId/:targetSessionId
export const logoutTargetParams = z.object({
  sessionId: z.string().trim().check(utf16MinLength(1)),
  targetSessionId: z.string().trim().check(utf16MinLength(1)),
});

// PUT /session/device/name/:sessionId
export const updateDeviceNameSchema = z.object({
  deviceName: z.string().trim().check(utf16MinLength(1)),
});

// POST /session/users/batch
export const batchUsersSchema = z.object({
  sessionIds: z.array(z.string().trim().check(utf16MinLength(1))).min(1),
});
