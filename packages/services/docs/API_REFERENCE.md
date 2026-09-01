# Oxy API Reference

Complete reference documentation for all OxyServices methods and features.

## Table of Contents

- [Authentication](#authentication)
- [User Management](#user-management)
- [Social Features](#social-features)
- [File & Asset Management](#file--asset-management)
- [Notifications](#notifications)
- [Privacy & Security](#privacy--security)
- [Trust Screens](#trust-screens)
- [Payments](#payments)
- [Location Services](#location-services)
- [Analytics](#analytics)
- [Device Management](#device-management)
- [Applications & Connected Apps](#applications--connected-apps)
- [Utilities](#utilities)

## Authentication

### `signUp(username, email, password)`

Create a new user account.

```typescript
const response = await oxyServices.signUp('johndoe', 'john@example.com', 'securepassword');
// Returns: { message: string, token: string, user: User }
```

**Parameters:**
- `username` (string): Unique username
- `email` (string): User email address
- `password` (string): User password

**Returns:** `Promise<{ message: string, token: string, user: User }>`

---

### `signIn(username, password)`

Sign in with username and password.

```typescript
const session = await oxyServices.signIn('johndoe', 'password');
// Returns: SessionLoginResponse with token and user data
```

**Parameters:**
- `username` (string): Username or email
- `password` (string): User password

**Returns:** `Promise<SessionLoginResponse>`

---

### `signInWithEmail(email, password)`

Sign in using email address.

```typescript
const session = await oxyServices.signInWithEmail('john@example.com', 'password');
```

**Parameters:**
- `email` (string): Email address
- `password` (string): User password

**Returns:** `Promise<SessionLoginResponse>`

---

### `logout()`

Sign out the current user.

```typescript
await oxyServices.logout();
```

**Returns:** `Promise<void>`

---

### `setTokens(accessToken)`

Manually set the authentication access token.

```typescript
oxyServices.setTokens('access_token_here');
```

**Parameters:**
- `accessToken` (string): JWT access token

**Returns:** `void`

> Session restore uses the zero-cookie device credential (`deviceId` + `deviceSecret`) via `POST /session/device/token`, not a refresh token.

---

### `getCurrentUser()`

Get the currently authenticated user.

```typescript
const user = await oxyServices.getCurrentUser();
// Returns: User object
```

**Returns:** `Promise<User>`

---

### `hasValidToken()`

Check if the current session has a valid token.

```typescript
const isValid = oxyServices.hasValidToken();
// Returns: boolean
```

**Returns:** `boolean`

---

## User Management

### `getUserById(userId)`

Get user information by ID.

```typescript
const user = await oxyServices.getUserById('user123');
```

**Parameters:**
- `userId` (string): User ID

**Returns:** `Promise<User>`

---

### `getProfileByUsername(username)`

Get user profile by username.

```typescript
const profile = await oxyServices.getProfileByUsername('johndoe');
```

**Parameters:**
- `username` (string): Username

**Returns:** `Promise<User>`

---

### `searchProfiles(query, pagination?)`

Search for user profiles with pagination support.

```typescript
const { data, pagination } = await oxyServices.searchProfiles('john', {
  limit: 20,
  offset: 0,
});

data.forEach(profile => {
  console.log(profile.displayName, profile.username, profile._count?.followers);
});
```

**Parameters:**
- `query` (string): Search term (username, name, bio, etc.)
- `pagination` (object, optional):
  - `limit` (number): Number of results to return
  - `offset` (number): Offset for pagination

**Returns:** `Promise<{ data: User[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>`

---

### `updateProfile(updates)`

Update the current user's profile.

```typescript
await oxyServices.updateProfile({
  name: 'John Doe',
  bio: 'Software developer',
  avatar: 'file_id_here'
});
```

**Parameters:**
- `updates` (object): Profile update object

**Returns:** `Promise<User>`

---

### `updateUser(userId, updates)`

Update any user by ID (admin function).

```typescript
await oxyServices.updateUser('user123', { name: 'New Name' });
```

**Parameters:**
- `userId` (string): User ID to update
- `updates` (object): Update object

**Returns:** `Promise<User>`

---

## Social Features

### `followUser(userId)`

Follow a user.

```typescript
const result = await oxyServices.followUser('user123');
// Returns: { success: boolean, message: string }
```

**Parameters:**
- `userId` (string): User ID to follow

**Returns:** `Promise<{ success: boolean, message: string }>`

---

### `unfollowUser(userId)`

Unfollow a user.

```typescript
await oxyServices.unfollowUser('user123');
```

**Parameters:**
- `userId` (string): User ID to unfollow

**Returns:** `Promise<{ success: boolean, message: string }>`

---

### `getFollowStatus(userId)`

Check if you're following a user.

```typescript
const status = await oxyServices.getFollowStatus('user123');
// Returns: { isFollowing: boolean }
```

**Parameters:**
- `userId` (string): User ID to check

**Returns:** `Promise<{ isFollowing: boolean }>`

---

### `getUserFollowers(userId, pagination?)`

Get a user's followers.

```typescript
const result = await oxyServices.getUserFollowers('user123', {
  limit: 20,
  offset: 0
});
// Returns: { followers: User[], total: number, hasMore: boolean }
```

**Parameters:**
- `userId` (string): User ID
- `pagination` (object, optional): Pagination options
  - `limit` (number): Number of results
  - `offset` (number): Offset for pagination

**Returns:** `Promise<{ followers: User[], total: number, hasMore: boolean }>`

---

### `getUserFollowing(userId, pagination?)`

Get users that a user is following.

```typescript
const result = await oxyServices.getUserFollowing('user123');
// Returns: { following: User[], total: number, hasMore: boolean }
```

**Parameters:**
- `userId` (string): User ID
- `pagination` (object, optional): Pagination options

**Returns:** `Promise<{ following: User[], total: number, hasMore: boolean }>`

---

## File & Asset Management

### `uploadRawFile(file, visibility?, metadata?)`

Upload a file to Oxy.

```typescript
const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });
const uploaded = await oxyServices.uploadRawFile(file, 'public', {
  description: 'Profile picture'
});
// Returns: Asset object with file ID
```

**Parameters:**
- `file` (File | Blob): File to upload
- `visibility` ('private' | 'public' | 'unlisted', optional): File visibility
- `metadata` (object, optional): Additional metadata

**Returns:** `Promise<any>`

---

### `getFileDownloadUrl(fileId, variant?, expiresIn?)`

Get a stream/download URL for a file.

This method returns a URL pointing to the `/api/assets/:id/stream` endpoint, which:
- Handles authentication automatically using the current access token (when available)
- Supports image variants (e.g. thumbnails)
- Sets proper media/CORS headers to avoid browser ORB blocking

```typescript
// Thumbnail URL for images (recommended for avatars, profile pictures, etc.)
const thumbUrl = oxyServices.getFileDownloadUrl('file123', 'thumb');

// Custom expiration in seconds (default behavior is usually sufficient)
const expiringUrl = oxyServices.getFileDownloadUrl('file123', 'thumb', 3600);
```

**Parameters:**
- `fileId` (string): File ID
- `variant` (string, optional): Image variant (e.g., 'thumb', 'medium')
- `expiresIn` (number, optional): URL expiration in seconds

**Returns:** `string`

---

### `listUserFiles(limit?, offset?)`

List files uploaded by the current user.

```typescript
const files = await oxyServices.listUserFiles(20, 0);
// Returns: { files: any[], total: number, hasMore: boolean }
```

**Parameters:**
- `limit` (number, optional): Number of results
- `offset` (number, optional): Offset for pagination

**Returns:** `Promise<{ files: any[], total: number, hasMore: boolean }>`

---

### `deleteFile(fileId)`

Delete a file.

```typescript
await oxyServices.deleteFile('file123');
```

**Parameters:**
- `fileId` (string): File ID to delete

**Returns:** `Promise<any>`

---

### `uploadAvatar(file, userId, app?)`

Upload and link an avatar image.

```typescript
const file = new File([blob], 'avatar.jpg');
const avatar = await oxyServices.uploadAvatar(file, 'user123', 'profiles');
```

**Parameters:**
- `file` (File): Avatar image file
- `userId` (string): User ID
- `app` (string, optional): App name (default: 'profiles')

**Returns:** `Promise<any>`

---

## Notifications

### `getNotifications()`

Get all notifications for the current user.

```typescript
const notifications = await oxyServices.getNotifications();
// Returns: Notification[]
```

**Returns:** `Promise<Notification[]>`

---

### `getUnreadCount()`

Get the count of unread notifications.

```typescript
const count = await oxyServices.getUnreadCount();
// Returns: number
```

**Returns:** `Promise<number>`

---

### `markNotificationAsRead(notificationId)`

Mark a notification as read.

```typescript
await oxyServices.markNotificationAsRead('notification123');
```

**Parameters:**
- `notificationId` (string): Notification ID

**Returns:** `Promise<void>`

---

### `markAllNotificationsAsRead()`

Mark all notifications as read.

```typescript
await oxyServices.markAllNotificationsAsRead();
```

**Returns:** `Promise<void>`

---

### `deleteNotification(notificationId)`

Delete a notification.

```typescript
await oxyServices.deleteNotification('notification123');
```

**Parameters:**
- `notificationId` (string): Notification ID

**Returns:** `Promise<void>`

---

## Privacy & Security

### `getBlockedUsers()`

Get list of blocked users.

```typescript
const blocked = await oxyServices.getBlockedUsers();
// Returns: BlockedUser[]
```

**Returns:** `Promise<BlockedUser[]>`

---

### `blockUser(userId)`

Block a user.

```typescript
await oxyServices.blockUser('user123');
```

**Parameters:**
- `userId` (string): User ID to block

**Returns:** `Promise<{ message: string }>`

---

### `unblockUser(userId)`

Unblock a user.

```typescript
await oxyServices.unblockUser('user123');
```

**Parameters:**
- `userId` (string): User ID to unblock

**Returns:** `Promise<{ message: string }>`

---

### `isUserBlocked(userId)`

Check if a user is blocked.

```typescript
const isBlocked = await oxyServices.isUserBlocked('user123');
// Returns: boolean
```

**Parameters:**
- `userId` (string): User ID to check

**Returns:** `Promise<boolean>`

---

### `getRestrictedUsers()`

Get list of restricted users.

```typescript
const restricted = await oxyServices.getRestrictedUsers();
// Returns: RestrictedUser[]
```

**Returns:** `Promise<RestrictedUser[]>`

---

### `restrictUser(userId)`

Restrict a user (limit interactions without fully blocking).

```typescript
await oxyServices.restrictUser('user123');
```

**Parameters:**
- `userId` (string): User ID to restrict

**Returns:** `Promise<{ message: string }>`

---

### `unrestrictUser(userId)`

Unrestrict a user.

```typescript
await oxyServices.unrestrictUser('user123');
```

**Parameters:**
- `userId` (string): User ID to unrestrict

**Returns:** `Promise<{ message: string }>`

---

### `isUserRestricted(userId)`

Check if a user is restricted.

```typescript
const isRestricted = await oxyServices.isUserRestricted('user123');
```

**Parameters:**
- `userId` (string): User ID to check

**Returns:** `Promise<boolean>`

---

## Trust Screens

Trust is exposed through SDK screens rather than core API helpers.

```typescript
showBottomSheet('TrustCenter');
showBottomSheet('TrustLeaderboard');
```

---

## Payments

### `createPayment(data)`

Create a payment.

```typescript
const payment = await oxyServices.createPayment({
  amount: 1000,
  currency: 'USD',
  description: 'Premium subscription'
});
```

**Parameters:**
- `data` (object): Payment data

**Returns:** `Promise<any>`

---

### `getPayment(paymentId)`

Get payment information.

```typescript
const payment = await oxyServices.getPayment('payment123');
```

**Parameters:**
- `paymentId` (string): Payment ID

**Returns:** `Promise<any>`

---

### `getUserPayments()`

Get all payments for the current user.

```typescript
const payments = await oxyServices.getUserPayments();
// Returns: any[]
```

**Returns:** `Promise<any[]>`

---

## Location Services

### `updateLocation(latitude, longitude)`

Update user's current location.

```typescript
await oxyServices.updateLocation(40.7128, -74.0060);
```

**Parameters:**
- `latitude` (number): Latitude coordinate
- `longitude` (number): Longitude coordinate

**Returns:** `Promise<any>`

---

### `getNearbyUsers(radius?)`

Get nearby users.

```typescript
const nearby = await oxyServices.getNearbyUsers(1000); // 1km radius
// Returns: User[]
```

**Parameters:**
- `radius` (number, optional): Search radius in meters

**Returns:** `Promise<any[]>`

---

## Analytics

### `trackEvent(eventName, properties?)`

Track an analytics event.

```typescript
await oxyServices.trackEvent('button_click', {
  button_name: 'sign_in',
  page: 'home'
});
```

**Parameters:**
- `eventName` (string): Event name
- `properties` (object, optional): Event properties

**Returns:** `Promise<void>`

---

### `getAnalytics(startDate?, endDate?)`

Get analytics data.

```typescript
const analytics = await oxyServices.getAnalytics('2024-01-01', '2024-01-31');
```

**Parameters:**
- `startDate` (string, optional): Start date (ISO string)
- `endDate` (string, optional): End date (ISO string)

**Returns:** `Promise<any>`

---

## Device Management

### `registerDevice(deviceData)`

Register a new device.

```typescript
await oxyServices.registerDevice({
  name: 'iPhone 15',
  type: 'ios',
  pushToken: 'push_token_here'
});
```

**Parameters:**
- `deviceData` (object): Device information

**Returns:** `Promise<any>`

---

### `getUserDevices()`

Get all devices for the current user.

```typescript
const devices = await oxyServices.getUserDevices();
// Returns: Device[]
```

**Returns:** `Promise<any[]>`

---

### `removeDevice(deviceId)`

Remove a device.

```typescript
await oxyServices.removeDevice('device123');
```

**Parameters:**
- `deviceId` (string): Device ID

**Returns:** `Promise<void>`

---

## Applications & Connected Apps

Applications are registered and managed in the [Oxy Console](https://console.oxy.so). The SDK exposes the user-facing OAuth surface:

### `getPublicApplication(clientId)`

Resolve an OAuth `client_id` to the owning application's public identity (name, icon, legal URLs, type, scopes). No authentication required — used to render consent/authorize UIs.

```typescript
const app = await oxyServices.getPublicApplication('oxy_dk_...');
// Returns: PublicApplication
```

**Parameters:**
- `clientId` (string): The OAuth `client_id` (an active credential's public key)

**Returns:** `Promise<PublicApplication>`

---

### `listConnectedApps()`

List the OAuth-authorized applications the current user has connected via the consent flow.

```typescript
const apps = await oxyServices.listConnectedApps();
// Returns: ConnectedApp[]
```

**Returns:** `Promise<ConnectedApp[]>`

---

### `revokeAppGrant(applicationId)`

Revoke a connected application's grant. The next sign-in from that app asks for consent again.

```typescript
await oxyServices.revokeAppGrant('68f1c2…'); // the Application id from getAppGrants()
```

**Parameters:**
- `applicationId` (string): The connected application's id (from `ConnectedApp.applicationId`)

**Returns:** `Promise<void>`

---

## Utilities

### `fetchLinkMetadata(url)`

Fetch metadata for a URL (Open Graph, Twitter Cards, etc.).

```typescript
const metadata = await oxyServices.fetchLinkMetadata('https://example.com');
// Returns: { url: string, title: string, description: string, image?: string }
```

**Parameters:**
- `url` (string): URL to fetch metadata for

**Returns:** `Promise<{ url: string, title: string, description: string, image?: string }>`

---

### `auth(options?)` (Express Middleware)

Express.js authentication middleware.

```typescript
import express from 'express';
import { oxyClient } from '@oxyhq/core';

const app = express();

// Protect routes
app.use('/api/protected', oxyClient.auth());

app.get('/api/protected/user', (req, res) => {
  // req.user is available here
  res.json({ user: req.user });
});
```

**Parameters:**
- `options` (object, optional): Middleware options
  - `debug` (boolean): Enable debug logging
  - `onError` (function): Custom error handler
  - `loadUser` (boolean): Load full user data
  - `session` (boolean): Use session-based validation

**Returns:** Express middleware function

---

## Error Handling

All methods throw errors that you should handle:

```typescript
import { OxyAuthenticationError } from '@oxyhq/core';

try {
  await oxyServices.getCurrentUser();
} catch (error) {
  if (error instanceof OxyAuthenticationError) {
    // Handle authentication errors
    console.error('Auth error:', error.message);
  } else {
    // Handle other errors
    console.error('Error:', error.message);
  }
}
```

## Type Definitions

All methods are fully typed. Import types for better TypeScript support:

```typescript
import type { User, Notification, BlockedUser, RestrictedUser } from '@oxyhq/core';
```
