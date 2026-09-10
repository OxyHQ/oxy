# Oxy Integration Guide

Complete integration guide for different platforms and frameworks.

## Table of Contents

- [React Native](#react-native)
- [Expo](#expo)
- [Next.js](#nextjs)
- [React (Web)](#react-web)
- [Node.js / Express](#nodejs--express)
- [Vue.js](#vuejs)
- [Mobile Apps](#mobile-apps)

## React Native

### Installation

```bash
bun add @oxy.so/services react-native-reanimated react-native-gesture-handler
```

### Setup

1. **Add polyfill** (first line of `index.js`):

```javascript
import 'react-native-url-polyfill/auto';
```

2. **Configure Reanimated** in `babel.config.js`:

```javascript
module.exports = {
  plugins: ['react-native-reanimated/plugin'],
};
```

3. **Wrap your app**:

```typescript
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

### Usage Example

```typescript
// components/ProfileScreen.tsx
import { useOxy } from '@oxy.so/services';
import { View, Text, Button } from 'react-native';

export function ProfileScreen() {
  const { user, isAuthenticated, login, logout, oxyServices } = useOxy();
  const [followers, setFollowers] = useState([]);

  useEffect(() => {
    if (isAuthenticated && user) {
      oxyServices.getUserFollowers(user.id)
        .then(result => setFollowers(result.followers));
    }
  }, [isAuthenticated, user]);

  if (!isAuthenticated) {
    return (
      <View>
        <Text>Please sign in</Text>
        <Button title="Sign In" onPress={() => login('username', 'password')} />
      </View>
    );
  }

  return (
    <View>
      <Text>Welcome, {user?.name}!</Text>
      <Text>Followers: {followers.length}</Text>
      <Button title="Sign Out" onPress={logout} />
    </View>
  );
}
```

## Expo

### Installation

```bash
bunx expo install @oxy.so/services expo expo-font expo-image expo-linear-gradient
```

### Setup

1. **Add polyfill** (first line of `App.js`):

```javascript
import 'react-native-url-polyfill/auto';
```

2. **Wrap your app**:

```typescript
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

### Using Expo Image Picker

```typescript
import * as ImagePicker from 'expo-image-picker';
import { useOxy } from '@oxy.so/services';

function AvatarUpload() {
  const { oxyServices, user } = useOxy();

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 1,
    });

    if (!result.canceled) {
      const response = await fetch(result.assets[0].uri);
      const blob = await response.blob();
      const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
      
      const uploaded = await oxyServices.uploadRawFile(file, 'public');
      await oxyServices.updateProfile({ avatar: uploaded.file.id });
    }
  };

  return <Button title="Upload Avatar" onPress={pickImage} />;
}
```

## Next.js

### Installation

```bash
bun add @oxy.so/services
```

### Setup

1. **Create a provider component**:

```typescript
// app/providers.tsx
'use client';

import { OxyProvider } from '@oxy.so/services';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <OxyProvider baseURL={process.env.NEXT_PUBLIC_OXY_API_URL || 'https://api.oxy.so'}>
      {children}
    </OxyProvider>
  );
}
```

2. **Use in layout**:

```typescript
// app/layout.tsx
import { Providers } from './providers';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

3. **Use in components**:

```typescript
// app/profile/page.tsx
'use client';

import { useOxy } from '@oxy.so/services';

export default function ProfilePage() {
  const { user, isAuthenticated } = useOxy();

  if (!isAuthenticated) {
    return <div>Please sign in</div>;
  }

  return <div>Welcome, {user?.name}!</div>;
}
```

### Server-Side Usage

For server components, use the core API directly:

```typescript
// app/api/users/route.ts
import { oxyClient } from '@oxy.so/core';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('id');

  if (!userId) {
    return NextResponse.json({ error: 'User ID required' }, { status: 400 });
  }

  try {
    const user = await oxyClient.getUserById(userId);
    return NextResponse.json(user);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

## React (Web)

### Installation

```bash
bun add @oxy.so/services
```

### Setup

```typescript
// App.tsx
import { OxyProvider } from '@oxy.so/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}

export default App;
```

### File Upload Example

```typescript
import { useOxy } from '@oxy.so/services';

function FileUpload() {
  const { oxyServices } = useOxy();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const uploaded = await oxyServices.uploadRawFile(file, 'public');
      console.log('Uploaded:', uploaded);
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

  return (
    <div>
      <input type="file" onChange={handleFileChange} />
    </div>
  );
}
```

## Node.js / Express

### Installation

```bash
bun add @oxy.so/services express
```

### Basic Setup

```typescript
// server.ts
import express from 'express';
import { oxyClient } from '@oxy.so/core';

const app = express();
app.use(express.json());

// Authentication endpoint
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { username, password } = req.body;
    const session = await oxyClient.signIn(username, password);
    res.json(session);
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
});

// Protected route using middleware
app.use('/api/protected', oxyClient.auth());

app.get('/api/protected/user', (req: any, res) => {
  res.json({ user: req.user });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
```

### Custom Instance

```typescript
import { OxyServices } from '@oxy.so/core';

const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so'
});

// Use in routes
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await oxy.getUserById(req.params.id);
    res.json(user);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});
```

### Advanced: Custom Error Handling

```typescript
app.use('/api/protected', oxyClient.auth({
  debug: process.env.NODE_ENV === 'development',
  onError: (error) => {
    console.error('Auth error:', error);
    // Custom error handling
  },
  loadUser: true // Load full user data
}));
```

## Vue.js

Since OxyProvider is React-based, use the core API directly in Vue:

### Installation

```bash
bun add @oxy.so/services
```

### Setup with Composition API

```typescript
// composables/useOxy.ts
import { ref, onMounted } from 'vue';
import { oxyClient } from '@oxy.so/core';

export function useOxy() {
  const user = ref(null);
  const isAuthenticated = ref(false);
  const loading = ref(false);

  const login = async (username: string, password: string) => {
    loading.value = true;
    try {
      const session = await oxyClient.signIn(username, password);
      await oxyClient.setTokens(session.token);
      user.value = session.user;
      isAuthenticated.value = true;
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    } finally {
      loading.value = false;
    }
  };

  const logout = async () => {
    await oxyClient.logout();
    user.value = null;
    isAuthenticated.value = false;
  };

  const fetchUser = async () => {
    try {
      user.value = await oxyClient.getCurrentUser();
      isAuthenticated.value = true;
    } catch (error) {
      isAuthenticated.value = false;
    }
  };

  onMounted(() => {
    fetchUser();
  });

  return {
    user,
    isAuthenticated,
    loading,
    login,
    logout,
    oxyServices: oxyClient
  };
}
```

### Usage in Component

```vue
<template>
  <div>
    <div v-if="!isAuthenticated">
      <button @click="handleLogin">Sign In</button>
    </div>
    <div v-else>
      <p>Welcome, {{ user?.name }}!</p>
      <button @click="logout">Sign Out</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useOxy } from '@/composables/useOxy';

const { user, isAuthenticated, login, logout } = useOxy();

const handleLogin = async () => {
  try {
    await login('username', 'password');
  } catch (error) {
    console.error('Login failed:', error);
  }
};
</script>
```

## Mobile Apps

### React Native CLI

Follow the [React Native](#react-native) setup above.

### Expo Go

Works out of the box! Just install and use:

```bash
bunx expo install @oxy.so/services
```

### Native Modules

If you need native modules, ensure they're properly linked:

```bash
# iOS
cd ios && pod install && cd ..

# Android - usually auto-linked
```

## Environment Variables

Create a `.env` file:

```bash
# .env
OXY_API_URL=https://api.oxy.so
OXY_CLOUD_URL=https://cloud.oxy.so
NODE_ENV=production
```

Use in your code:

```typescript
const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  cloudURL: process.env.OXY_CLOUD_URL || 'https://cloud.oxy.so'
});
```

## TypeScript Configuration

Add to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@oxy.so/services"]
  }
}
```

## Common Patterns

### Authentication Flow

```typescript
const { login, logout, isAuthenticated, user } = useOxy();

// Login
const handleLogin = async () => {
  try {
    await login(username, password);
    // User is now authenticated
  } catch (error) {
    // Handle error
  }
};

// Logout
const handleLogout = async () => {
  await logout();
  // User is now logged out
};
```

### Data Fetching

```typescript
const { oxyServices, isAuthenticated } = useOxy();
const [data, setData] = useState(null);

useEffect(() => {
  if (isAuthenticated) {
    oxyServices.getCurrentUser()
      .then(setData)
      .catch(console.error);
  }
}, [isAuthenticated]);
```

### Error Handling

```typescript
import { OxyAuthenticationError } from '@oxy.so/services';

try {
  await oxyServices.getCurrentUser();
} catch (error) {
  if (error instanceof OxyAuthenticationError) {
    // Handle auth errors
  } else {
    // Handle other errors
  }
}
```

## Next Steps

- [API Reference](./API_REFERENCE.md) - Complete method documentation
- [Best Practices](./BEST_PRACTICES.md) - Production-ready patterns
- [Examples](./EXAMPLES.md) - Working code examples

