/**
 * How the signed-in account signs in and what happened to it, held in its
 * `@oxy.so/bloom-data` store: its security activity, its linked
 * authentication methods and its sign-in methods. Memory only, as their
 * queries were.
 *
 * Sign-in itself never reads or writes here: these are reads of an account
 * that is already signed in, so nothing here can tell whether some other
 * account exists.
 */
import { entity, list, source } from '@oxy.so/bloom-data';
import type { AuthMethodsResponse, SignInMethods } from '@oxy.so/contracts';
import type { OxyServices, SecurityActivity, SecurityEventType } from '@oxy.so/core';
import { ACCOUNT_VALUE, accountValue } from './accountValue';
import { sdkRead } from './readOptions';

const SECURITY_STALE_MS = 5 * 60_000;
const SECURITY_GC_MS = 10 * 60_000;

// ── Security activity ───────────────────────────────────────────────

export const SecurityEvent = entity<SecurityActivity>('oxy.security-event', {
  id: (event) => event.id,
});

/** What a page of activity says beside its events. */
export interface SecurityActivityPageExtra {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export const SecurityActivityPage = list<SecurityActivityPageExtra>('oxy.security-activity-page', {
  of: SecurityEvent,
});

/** One page of activity, at `offset`. */
export const securityActivityPage = source(SecurityActivityPage, {
  ...sdkRead,
  key: (
    _oxy: OxyServices,
    limit: number | undefined,
    offset: number | undefined,
    eventType: SecurityEventType | undefined,
  ) => `${limit ?? ''}\u0000${offset ?? ''}\u0000${eventType ?? ''}`,
  stale: SECURITY_STALE_MS,
  gcTime: SECURITY_GC_MS,
  load: async (_request, oxy, limit, offset, eventType) => {
    const page = await oxy.devices.securityActivity(limit, offset, eventType);
    const { total, hasMore } = page;
    return { items: page.data, extra: { total, limit: page.limit, offset: page.offset, hasMore } };
  },
  fold: (_current, extra) => extra ?? { total: 0, limit: 0, offset: 0, hasMore: false },
});

export const RecentSecurityActivity = list('oxy.security-activity-recent', { of: SecurityEvent });

/** The latest `limit` events. */
export const recentSecurityActivity = source(RecentSecurityActivity, {
  ...sdkRead,
  key: (_oxy: OxyServices, limit: number) => String(limit),
  stale: SECURITY_STALE_MS,
  gcTime: SECURITY_GC_MS,
  load: async (_request, oxy, limit) => ({
    items: (await oxy.devices.securityActivity(limit, 0)).data,
  }),
});

export const SecurityActivityFeed = list('oxy.security-activity', { of: SecurityEvent });

/** Every event, `limit` at a time: the cursor is the next page's offset. */
export const securityActivity = source(SecurityActivityFeed, {
  ...sdkRead,
  key: (_oxy: OxyServices, limit: number, eventType: SecurityEventType | undefined) =>
    `${limit}\u0000${eventType ?? ''}`,
  stale: SECURITY_STALE_MS,
  gcTime: SECURITY_GC_MS,
  load: async ({ cursor }, oxy, limit, eventType) => {
    const page = await oxy.devices.securityActivity(limit, cursor ? Number(cursor) : 0, eventType);
    return { items: page.data, next: page.hasMore ? String(page.offset + page.limit) : null };
  },
});

// ── Authentication and sign-in methods ──────────────────────────────

export const AuthMethods = accountValue<AuthMethodsResponse>('oxy.auth-methods');

/** The account's linked authentication methods (`GET /auth/methods`). */
export const authMethods = source(AuthMethods, {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT_VALUE,
  stale: SECURITY_STALE_MS,
  gcTime: SECURITY_GC_MS,
  load: (_request, oxy) => oxy.identity.authMethods(),
});

export const SignInMethodsValue = accountValue<SignInMethods>('oxy.sign-in-methods');

/**
 * How the account signs in (`GET /users/me/sign-in-methods`). Refresh it
 * after changing an email, a password or the authenticator.
 */
export const signInMethods = source(SignInMethodsValue, {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT_VALUE,
  stale: 60_000,
  gcTime: 30 * 60_000,
  load: (_request, oxy) => oxy.auth.methods(),
});
