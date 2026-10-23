import { z } from '@oxy.so/zod3';

// Params with :id (privacy settings)
export const privacyUserIdParams = z.object({
  id: z.string().trim().min(1),
});

// Params with :targetId (block/restrict)
export const targetIdParams = z.object({
  targetId: z.string().trim().min(1),
});

export const privacySettingsSchema = z.object({
  isPrivateAccount: z.boolean().optional(),
  hideOnlineStatus: z.boolean().optional(),
  hideLastSeen: z.boolean().optional(),
  profileVisibility: z.boolean().optional(),
  loginAlerts: z.boolean().optional(),
  blockScreenshots: z.boolean().optional(),
  login: z.boolean().optional(),
  biometricLogin: z.boolean().optional(),
  showActivity: z.boolean().optional(),
  allowTagging: z.boolean().optional(),
  allowMentions: z.boolean().optional(),
  hideReadReceipts: z.boolean().optional(),
  allowDirectMessages: z.boolean().optional(),
  dataSharing: z.boolean().optional(),
  locationSharing: z.boolean().optional(),
  analyticsSharing: z.boolean().optional(),
  sensitiveContent: z.boolean().optional(),
  autoFilter: z.boolean().optional(),
  muteKeywords: z.boolean().optional(),
  discoverableByEmail: z.boolean().optional(),
  discoverableByPhone: z.boolean().optional(),
  fediverseSharing: z.boolean().optional(),
});
