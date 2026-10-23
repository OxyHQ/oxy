import { z } from '@oxy.so/zod3';

// Params with :sessionId
export const sessionIdParams = z.object({
  sessionId: z.string().trim().min(1),
});

// POST /session/logout/:sessionId/:targetSessionId
export const logoutTargetParams = z.object({
  sessionId: z.string().trim().min(1),
  targetSessionId: z.string().trim().min(1),
});

// PUT /session/device/name/:sessionId
export const updateDeviceNameSchema = z.object({
  deviceName: z.string().trim().min(1),
});

// POST /session/users/batch
export const batchUsersSchema = z.object({
  sessionIds: z.array(z.string().trim().min(1)).min(1),
});
