# Oxy Best Practices

Production-ready patterns and best practices for building apps with Oxy.

## Table of Contents

- [Authentication](#authentication)
- [Error Handling](#error-handling)
- [Performance](#performance)
- [Security](#security)
- [State Management](#state-management)
- [Testing](#testing)

## Authentication

### ✅ DO: Handle Authentication State Properly

```typescript
import { useOxy } from '@oxy.so/services';
import { useEffect } from 'react';

function ProtectedComponent() {
  const { isAuthenticated, user, isLoading } = useOxy();

  // Show loading state while checking authentication
  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  // Render protected content
  return <UserDashboard user={user} />;
}
```

### ✅ DO: Persist Authentication Across Sessions

Oxy automatically handles token persistence, but you can customize it:

```typescript
<OxyProvider
  baseURL="https://api.oxy.so"
  storageKeyPrefix="my_app_oxy" // Custom storage key
  onAuthStateChange={(user) => {
    // Sync with your app's state management
    if (user) {
      // User logged in
    } else {
      // User logged out
    }
  }}
>
  {children}
</OxyProvider>
```

### ❌ DON'T: Store Tokens Manually

```typescript
// ❌ BAD: Don't manually store tokens
localStorage.setItem('token', token);

// ✅ GOOD: Let Oxy handle it
await oxyServices.setTokens(token);
```

## Error Handling

### ✅ DO: Use Try-Catch Blocks

```typescript
import { OxyAuthenticationError } from '@oxy.so/services';

async function fetchUserData() {
  try {
    const user = await oxyServices.getCurrentUser();
    return user;
  } catch (error) {
    if (error instanceof OxyAuthenticationError) {
      // Handle authentication errors
      console.error('Auth error:', error.message);
      // Redirect to login
    } else {
      // Handle other errors
      console.error('Error:', error.message);
    }
    throw error; // Re-throw if needed
  }
}
```

### ✅ DO: Provide User-Friendly Error Messages

```typescript
const handleAction = async () => {
  try {
    await oxyServices.someAction();
  } catch (error: any) {
    // Map technical errors to user-friendly messages
    const userMessage = error.message.includes('network')
      ? 'Please check your internet connection'
      : error.message.includes('auth')
      ? 'Please sign in to continue'
      : 'Something went wrong. Please try again.';
    
    Alert.alert('Error', userMessage);
  }
};
```

### ✅ DO: Handle Network Errors Gracefully

```typescript
async function fetchWithRetry(fn: () => Promise<any>, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (i === retries - 1) throw error;
      if (error.message.includes('network')) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

// Usage
const user = await fetchWithRetry(() => oxyServices.getCurrentUser());
```

## Performance

### ✅ DO: Use Caching Effectively

Oxy automatically caches responses, but you can optimize:

```typescript
// ✅ GOOD: Let Oxy cache automatically
const user = await oxyServices.getUserById(userId); // Cached automatically

// ✅ GOOD: Clear cache when needed
oxyServices.clearCache(); // Clear all cache
oxyServices.clearCacheEntry('user:123'); // Clear specific entry
```

### ✅ DO: Batch Related Requests

```typescript
// ❌ BAD: Sequential requests
const user = await oxyServices.getUserById(userId);
const followers = await oxyServices.getUserFollowers(userId);
const following = await oxyServices.getUserFollowing(userId);

// ✅ GOOD: Parallel requests
const [user, followersData, followingData] = await Promise.all([
  oxyServices.getUserById(userId),
  oxyServices.getUserFollowers(userId),
  oxyServices.getUserFollowing(userId)
]);
```

### ✅ DO: Use Pagination for Large Lists

```typescript
const [items, setItems] = useState([]);
const [hasMore, setHasMore] = useState(true);
const [offset, setOffset] = useState(0);

const loadMore = async () => {
  if (!hasMore) return;
  
  const result = await oxyServices.getUserFollowers(userId, {
    limit: 20,
    offset
  });
  
  setItems(prev => [...prev, ...result.followers]);
  setHasMore(result.hasMore);
  setOffset(prev => prev + 20);
};
```

### ✅ DO: Optimize Image Loading

```typescript
// ✅ GOOD: Use appropriate image variants
const thumbUrl = oxyServices.getFileDownloadUrl(fileId, 'thumb'); // Small thumbnail
const fullUrl = oxyServices.getFileDownloadUrl(fileId, 'full'); // Full size

// Use thumbnails in lists, full size in detail views
<Image source={{ uri: thumbUrl }} /> // List view
<Image source={{ uri: fullUrl }} /> // Detail view
```

## Security

### ✅ DO: Validate User Input

```typescript
const handleSignUp = async (username: string, email: string, password: string) => {
  // Validate input
  if (!username || username.length < 3) {
    throw new Error('Username must be at least 3 characters');
  }
  
  if (!email || !email.includes('@')) {
    throw new Error('Invalid email address');
  }
  
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  
  // Proceed with signup
  await oxyServices.signUp(username, email, password);
};
```

### ✅ DO: Use Environment Variables

```typescript
// ✅ GOOD: Use environment variables
const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so'
});

// ❌ BAD: Hardcoded URLs
const oxy = new OxyServices({
  baseURL: 'https://api.oxy.so' // Hardcoded
});
```

### ✅ DO: Handle Sensitive Data Properly

```typescript
// ✅ GOOD: Clear sensitive data on logout
const handleLogout = async () => {
  await oxyServices.logout();
  // Clear any local state
  setUserData(null);
  setTokens(null);
};

// ❌ BAD: Keep sensitive data in memory
const handleLogout = async () => {
  await oxyServices.logout();
  // Don't forget to clear local state!
};
```

## State Management

### ✅ DO: Use React Hooks Properly

```typescript
function UserProfile({ userId }: { userId: string }) {
  const { oxyServices } = useOxy();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    
    const fetchUser = async () => {
      try {
        const userData = await oxyServices.getUserById(userId);
        if (!cancelled) {
          setUser(userData);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch user:', error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchUser();
    
    return () => {
      cancelled = true; // Cleanup on unmount
    };
  }, [userId]);

  if (loading) return <LoadingSpinner />;
  if (!user) return <Text>User not found</Text>;
  
  return <UserCard user={user} />;
}
```

### ✅ DO: Use Custom Hooks for Reusable Logic

```typescript
// hooks/useUserProfile.ts
export function useUserProfile(userId: string) {
  const { oxyServices } = useOxy();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        setLoading(true);
        const userData = await oxyServices.getUserById(userId);
        setUser(userData);
        setError(null);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [userId]);

  return { user, loading, error, refetch: () => fetchUser() };
}

// Usage
function ProfileScreen({ userId }: { userId: string }) {
  const { user, loading, error } = useUserProfile(userId);
  // ...
}
```

## Testing

### ✅ DO: Mock Oxy Services in Tests

```typescript
// __mocks__/@oxy.so/services.ts
export const useOxy = jest.fn(() => ({
  user: { id: '1', name: 'Test User' },
  isAuthenticated: true,
  oxyServices: {
    getCurrentUser: jest.fn().mockResolvedValue({ id: '1', name: 'Test User' }),
    getUserById: jest.fn().mockResolvedValue({ id: '1', name: 'Test User' }),
  },
  login: jest.fn().mockResolvedValue({}),
  logout: jest.fn().mockResolvedValue({}),
}));

// Component.test.tsx
import { useOxy } from '@oxy.so/services';
jest.mock('@oxy.so/services');

test('renders user profile', () => {
  (useOxy as jest.Mock).mockReturnValue({
    user: { id: '1', name: 'Test User' },
    isAuthenticated: true,
  });
  
  render(<UserProfile />);
  expect(screen.getByText('Test User')).toBeInTheDocument();
});
```

### ✅ DO: Test Error Scenarios

```typescript
test('handles authentication error', async () => {
  (useOxy as jest.Mock).mockReturnValue({
    oxyServices: {
      getCurrentUser: jest.fn().mockRejectedValue(
        new OxyAuthenticationError('Invalid token', 'AUTH_ERROR', 401)
      ),
    },
    isAuthenticated: false,
  });

  render(<ProtectedComponent />);
  await waitFor(() => {
    expect(screen.getByText('Please sign in')).toBeInTheDocument();
  });
});
```

## Code Organization

### ✅ DO: Organize API Calls in Services

```typescript
// services/userService.ts
import { oxyClient } from '@oxy.so/core';

export const userService = {
  async getUserProfile(userId: string) {
    return await oxyClient.getUserById(userId);
  },
  
  async updateProfile(updates: any) {
    return await oxyClient.updateProfile(updates);
  },
  
  async getFollowers(userId: string, pagination?: any) {
    return await oxyClient.getUserFollowers(userId, pagination);
  },
};

// Usage in components
import { userService } from '@/services/userService';

const user = await userService.getUserProfile(userId);
```

### ✅ DO: Create Type-Safe Wrappers

```typescript
// types/user.ts
export interface UserProfile {
  id: string;
  name: string;
  username: string;
  avatar?: string;
  bio?: string;
}

// services/userService.ts
export async function getUserProfile(userId: string): Promise<UserProfile> {
  const user = await oxyClient.getUserById(userId);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatar: user.avatar,
    bio: user.bio,
  };
}
```

## Common Patterns

### Loading States

```typescript
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);

const handleAction = async () => {
  setLoading(true);
  setError(null);
  try {
    await oxyServices.someAction();
  } catch (err: any) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
};
```

### Optimistic Updates

```typescript
const handleFollow = async (userId: string) => {
  // Optimistically update UI
  setIsFollowing(true);
  
  try {
    await oxyServices.followUser(userId);
  } catch (error) {
    // Revert on error
    setIsFollowing(false);
    Alert.alert('Error', 'Failed to follow user');
  }
};
```

## Next Steps

- [API Reference](./API_REFERENCE.md) - Complete method documentation
- [Examples](./EXAMPLES.md) - Working code examples
- [Integration Guide](./INTEGRATION_GUIDE.md) - Platform-specific guides

