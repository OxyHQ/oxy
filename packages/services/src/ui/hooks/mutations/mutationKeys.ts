/**
 * Stable mutation key factories.
 *
 * Mutations that may be queued while offline MUST declare a stable
 * `mutationKey`. When the network comes back, TanStack Query resumes
 * paused mutations grouped by key — so the keys here should be stable
 * across renders and across reloads when persistence is enabled.
 */

export const mutationKeys = {
  // Account-related writes
  account: {
    updateProfile: ['mutation', 'account', 'updateProfile'] as const,
    uploadAvatar: ['mutation', 'account', 'uploadAvatar'] as const,
    updateSettings: ['mutation', 'account', 'updateSettings'] as const,
    updatePrivacySettings: ['mutation', 'account', 'updatePrivacySettings'] as const,
    updateNotificationPreferences: [
      'mutation',
      'account',
      'updateNotificationPreferences',
    ] as const,
    updateUserPreferences: ['mutation', 'account', 'updateUserPreferences'] as const,
    uploadFile: ['mutation', 'account', 'uploadFile'] as const,
  },

  // Session / device writes
  session: {
    switch: ['mutation', 'session', 'switch'] as const,
    logout: ['mutation', 'session', 'logout'] as const,
    logoutAll: ['mutation', 'session', 'logoutAll'] as const,
    updateDeviceName: ['mutation', 'session', 'updateDeviceName'] as const,
    removeDevice: ['mutation', 'session', 'removeDevice'] as const,
  },

  // Connected apps (OAuth grants)
  connectedApps: {
    revoke: ['mutation', 'connectedApps', 'revoke'] as const,
  },
} as const;
