# Oxy Quick Reference

Quick reference guide for common Oxy operations.

## Installation

```bash
bun add @oxy.so/services
```

## React Native Setup

```javascript
// index.js (first line)
import 'react-native-url-polyfill/auto';

// App.tsx
import { OxyProvider } from '@oxy.so/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}
```

## Common Operations

### Authentication

```typescript
const { login, logout, isAuthenticated, user } = useOxy();

// Login
await login('username', 'password');

// Logout
await logout();

// Check auth
if (isAuthenticated) {
  console.log('User:', user?.name);
}
```

### Get User Data

```typescript
const { oxyServices } = useOxy();

// Current user
const user = await oxyServices.users.me();

// User by ID
const user = await oxyServices.users.get('user123');

// Profile by username
const profile = await oxyServices.users.byUsername('johndoe');
```

### Search Profiles

```typescript
const { data, pagination } = await oxyServices.users.search('john', {
  limit: 10,
  offset: 0,
});

data.forEach((profile) => {
  console.log(profile.displayName, profile.username, profile._count?.followers);
});

console.log('Has more?', pagination.hasMore);
```

### Update Profile

```typescript
await oxyServices.users.updateMe({
  name: 'John Doe',
  bio: 'Software developer',
  avatar: 'file_id_here'
});
```

### Follow/Unfollow

```typescript
// Follow
await oxyServices.follows.follow('user123');

// Unfollow
await oxyServices.follows.unfollow('user123');

// Check status
const { isFollowing } = await oxyServices.follows.status('user123');
```

### Upload File

```typescript
const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });
const uploaded = await oxyServices.assets.upload(file, { visibility: 'public' });
const fileId = uploaded.file.id;
```

### Get File URL

```typescript
// Download/stream URL (with auth token, ORB-safe headers, and variants)
const url = oxyServices.assets.publicUrl('file123', 'thumb');
```

### Notifications

```typescript
// Get notifications
const { notifications } = await oxyServices.notifications.list();

// Unread count
const count = await oxyServices.notifications.unreadCount();

// Mark as read
await oxyServices.notifications.markRead('notification123');
await oxyServices.notifications.markAllRead();
```

### Privacy

```typescript
// Block user
await oxyServices.privacy.block('user123');
const blocked = await oxyServices.privacy.blocked();

// Restrict user
await oxyServices.privacy.restrict('user123');
const restricted = await oxyServices.privacy.restricted();

// Check status
const isBlocked = await oxyServices.privacy.isBlocked('user123');
const isRestricted = await oxyServices.privacy.isRestricted('user123');
```

### Error Handling

```typescript
import { OxyAuthenticationError } from '@oxy.so/services';

try {
  await oxyServices.users.me();
} catch (error) {
  if (error instanceof OxyAuthenticationError) {
    // Handle auth error
  } else {
    // Handle other error
  }
}
```

## Node.js / Express

```typescript
import express from 'express';
import { OxyServer } from '@oxy.so/core/server';

const app = express();
const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });

// Sign-in happens in the client (OxyProvider / OxyAccountDialog); the backend
// only verifies the Oxy bearer the client sends.
app.use('/api/protected', oxy.middleware.auth());

app.get('/api/protected/user', (req: any, res) => {
  res.json({ user: req.user });
});
```

## TypeScript Types

```typescript
import type { User, Notification, BlockedUser, RestrictedUser } from '@oxy.so/services';
```

## Common Patterns

### Loading State

```typescript
const [loading, setLoading] = useState(false);

const handleAction = async () => {
  setLoading(true);
  try {
    await oxyServices.someAction();
  } finally {
    setLoading(false);
  }
};
```

### Fetch with Error Handling

```typescript
const fetchData = async () => {
  try {
    const data = await oxyServices.getData();
    return data;
  } catch (error: any) {
    console.error('Error:', error.message);
    throw error;
  }
};
```

## Links

- [Full Documentation](../README.md)
- [Getting Started](./GETTING_STARTED.md)
- [API Reference](./API_REFERENCE.md)
- [Examples](./EXAMPLES.md)
