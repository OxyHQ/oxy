# Oxy API Reference

`useOxy().oxyServices` is the app's one `OxyServices` client (`@oxy.so/core`).
Its methods are grouped by namespace. This page covers the ones apps use most;
the full map — every namespace, the conventions, the transport — is
[`@oxy.so/core` → API](../../core/docs/api.mdx).

```typescript
import { useOxy } from '@oxy.so/services';

const { oxyServices: oxy } = useOxy();
```

## Table of Contents

- [Authentication](#authentication)
- [User Management](#user-management)
- [Social Features](#social-features)
- [File & Asset Management](#file--asset-management)
- [Notifications](#notifications)
- [Privacy & Security](#privacy--security)
- [Payments](#payments)
- [Devices](#devices)
- [Applications & Connected Apps](#applications--connected-apps)
- [Servers](#servers)
- [Error Handling](#error-handling)

## Authentication

Sign-in UI is `OxyAccountDialog` (`useOxy().openAccountDialog()`); apps do not
build their own. The session state behind it:

```typescript
oxy.session.accessToken;       // string | null
oxy.session.userId;            // string | null
oxy.session.isAuthenticated;   // boolean — a token is held (not a server check)
const off = oxy.session.onChange((token) => { /* … */ });
```

`useOxy().logout()` signs out. The sign-in calls themselves live in
`oxy.auth` (`email.*`, `password.*`, `totp.*`, `commons.*`, …) and are driven
by the dialog.

## User Management

```typescript
const me = await oxy.users.me();
const user = await oxy.users.get('user123');
const people = await oxy.users.getMany(['u1', 'u2']);          // one round-trip per 100
const profile = await oxy.users.byUsername('johndoe');
const { data, pagination } = await oxy.users.search('john', { limit: 20 });
await oxy.users.updateMe({ name: { first: 'John' }, bio: 'Hi' });
```

In components prefer the hooks (`useCurrentUser`, `useUpdateProfile`): they add
optimistic updates and cache invalidation.

## Social Features

```typescript
await oxy.follows.follow('user123');
await oxy.follows.unfollow('user123');
const { isFollowing } = await oxy.follows.status('user123');
const statuses = await oxy.follows.statuses(['u1', 'u2']);
const { followers, total, hasMore } = await oxy.follows.followers('user123', { limit: 20, offset: 0 });
const { following } = await oxy.follows.following('user123');
```

Follows of anything other than a person (topics, stores, artists) use
`oxy.follows.followTarget` / `ensureTarget` — see `docs/FOLLOWS.md`.

## File & Asset Management

```typescript
const { file } = await oxy.assets.upload(blob, {
  visibility: 'public',
  onProgress: (p) => console.log(p),
});

const thumb = oxy.assets.publicUrl(file.id, 'thumb');   // sync CDN URL (public files)
const signed = await oxy.assets.url(file.id);           // signed URL (private files)
const { files, hasMore } = await oxy.assets.list({ limit: 20, offset: 0 });
await oxy.assets.setVisibility(file.id, 'unlisted');
await oxy.assets.delete(file.id);
const avatar = await oxy.assets.uploadAvatar(blob, 'user123', 'profiles');
```

## Notifications

```typescript
const { notifications, unreadCount, hasMore } = await oxy.notifications.list({ page: 1, limit: 20 });
const count = await oxy.notifications.unreadCount();
await oxy.notifications.markRead('notification123');
await oxy.notifications.markAllRead();
await oxy.notifications.delete('notification123');
```

## Privacy & Security

```typescript
const settings = await oxy.privacy.settings();
await oxy.privacy.updateSettings({ isPrivateAccount: true });

const blocked = await oxy.privacy.blocked();
await oxy.privacy.block('user123');
await oxy.privacy.unblock('user123');
const isBlocked = await oxy.privacy.isBlocked('user123');

const restricted = await oxy.privacy.restricted();
await oxy.privacy.restrict('user123');
await oxy.privacy.unrestrict('user123');
```

## Trust Screens

`showBottomSheet('TrustCenter')`, `'TrustLeaderboard'`, `'TrustRewards'`,
`'TrustRules'`. Reads: `oxy.reputation.balance()`, `.transactions()`,
`.leaderboard()`, `.rules()` — reputation is read-only for people.

## Payments

```typescript
const payments = await oxy.billing.payments();
const subscription = await oxy.billing.subscription();
const wallet = await oxy.billing.wallet();
const page = await oxy.billing.walletTransactions({ limit: 20 });
```

## Devices

```typescript
const devices = await oxy.devices.list();
await oxy.devices.remove('device123');
const sessions = await oxy.devices.sessions(sessionId);
await oxy.devices.rename(sessionId, 'iPhone 15');
await oxy.devices.logoutAll(sessionId);
```

## Applications & Connected Apps

Applications are managed in the [Oxy Console](https://console.oxy.so). The
user-facing OAuth surface:

```typescript
const app = await oxy.apps.getPublic('oxy_dk_...');     // PublicApplication, no auth needed
const connected = await oxy.apps.connected.list();      // ConnectedApp[]
await oxy.apps.connected.revoke(connected[0].applicationId);
```

## Servers

Backends use `OxyServer` from `@oxy.so/core/server`, not this client:

```typescript
import express from 'express';
import { OxyServer } from '@oxy.so/core/server';

const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
const app = express();

app.use('/api/protected', oxy.middleware.auth());
app.get('/api/protected/user', (req, res) => res.json({ userId: req.userId }));
```

## Error Handling

Every call rejects with `OxyApiError`:

```typescript
import { OxyApiError } from '@oxy.so/core';

try {
  await oxy.users.me();
} catch (error) {
  if (error instanceof OxyApiError && error.status === 401) {
    // signed out
  } else {
    console.error(error);
  }
}
```

Types (`User`, `Notification`, `BlockedUser`, `PublicApplication`, …) are
exported from `@oxy.so/core`.
