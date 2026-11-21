/**
 * Stable mutation key factories.
 *
 * Mutations that may be queued while offline MUST declare a stable
 * `mutationKey`. When the network comes back, TanStack Query resumes
 * paused mutations grouped by key — so the keys here should be stable
 * across renders and across reloads when persistence is enabled.
 */

export const mutationKeys = {
  // Session / device writes
  session: {
    switch: ['mutation', 'session', 'switch'] as const,
    logout: ['mutation', 'session', 'logout'] as const,
    logoutAll: ['mutation', 'session', 'logoutAll'] as const,
    updateDeviceName: ['mutation', 'session', 'updateDeviceName'] as const,
    removeDevice: ['mutation', 'session', 'removeDevice'] as const,
  },
} as const;
