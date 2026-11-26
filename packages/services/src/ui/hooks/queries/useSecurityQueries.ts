import { type ListView, skip, useList } from '@oxy.so/bloom-data';
import type { SecurityEventType } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import {
  recentSecurityActivity,
  type SecurityActivityPageExtra,
  securityActivity,
  securityActivityPage,
} from '../../data/security';

/**
 * One page of the account's security activity, at `offset`: a list of
 * `SecurityEvent` ids, with the page's `total`, `limit`, `offset` and
 * `hasMore` in `extra`. Waits for an active session.
 */
export const useSecurityActivity = (options?: {
  limit?: number;
  offset?: number;
  eventType?: SecurityEventType;
  enabled?: boolean;
}): ListView<SecurityActivityPageExtra> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useList(
    securityActivityPage,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices, options?.limit, options?.offset, options?.eventType] as const)
      : ([skip] as const)),
  );
};

/** The account's latest `limit` security events, as `SecurityEvent` ids. Waits for an active session. */
export const useRecentSecurityActivity = (limit = 10): ListView<unknown> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useList(
    recentSecurityActivity,
    ...(activeSessionId ? ([oxyServices, limit] as const) : ([skip] as const)),
  );
};

/**
 * Every security event of the account, `limit` (default 30) at a time:
 * `more()` reads the next page until the API reports no more. Waits for an
 * active session.
 */
export const useInfiniteSecurityActivity = (options?: {
  limit?: number;
  eventType?: SecurityEventType;
  enabled?: boolean;
}): ListView<unknown> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useList(
    securityActivity,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices, options?.limit ?? 30, options?.eventType] as const)
      : ([skip] as const)),
  );
};
