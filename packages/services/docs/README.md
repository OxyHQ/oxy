# Oxy Documentation

Welcome to the Oxy developer documentation! This guide will help you integrate Oxy into your application.

## 📚 Documentation Index

### Getting Started
- **[Getting Started Guide](./GETTING_STARTED.md)** - Start here! Quick setup and your first integration
- **[Quick Reference](./QUICK_REFERENCE.md)** - Common operations cheat sheet

### Core Documentation
- **[API Reference](./API_REFERENCE.md)** - Complete API method documentation with examples
- **[Integration Guide](./INTEGRATION_GUIDE.md)** - Platform-specific integration guides (React Native, Expo, Next.js, etc.)
- **[Bottom Sheet Routing](./BOTTOM_SHEET_ROUTING.md)** - Complete guide to the bottom sheet routing system

### Examples & Best Practices
- **[Code Examples](./EXAMPLES.md)** - Complete working examples for common use cases
- **[Best Practices](./BEST_PRACTICES.md)** - Production-ready patterns and tips

## 🚀 Quick Start

1. **Install the package:**
```bash
bun add @oxy.so/services
```

2. **Wrap your app:**
```typescript
import { OxyProvider } from '@oxy.so/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}
```

3. **Use in components:**
```typescript
import { useOxy } from '@oxy.so/services';

function MyComponent() {
  const { user, isAuthenticated, login } = useOxy();
  // Your code here
}
```

## 🌐 Oxy Infrastructure

Oxy services are distributed across specialized domains:

| Domain | Purpose | Description |
|--------|---------|-------------|
| `https://api.oxy.so` | **API** | Main API endpoint for all data operations (users, sessions, social, etc.) |
| `https://auth.oxy.so` | **Authentication** | OAuth authorize/consent IdP for third-party "Sign in with Oxy"; login/signup/recovery flows |
| `https://cloud.oxy.so` | **Media** | CDN for static assets, images, videos, and file storage |

### Usage Examples

```typescript
// API calls go to api.oxy.so
const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

// Authentication redirects go to auth.oxy.so
// (handled automatically by OxyProvider)
<OxyProvider
  baseURL="https://api.oxy.so"
  authWebUrl="https://auth.oxy.so"
/>

// Media/assets are served from cloud.oxy.so
const imageUrl = 'https://cloud.oxy.so/assets/abc123/stream';
```

### Device-first sessions

Sessions are device-first and zero-cookie: `OxyProvider` restores a device's session silently from a first-party `{deviceId, deviceSecret}` (no cookies, no FedCM). Each Oxy app is its own device-first origin — apps on the same device stay in sync in real time via the `session_state` socket event once each is individually signed in. See [device sessions](../../../docs/auth/device-session.md).

## 📖 Documentation Structure

```
docs/
├── GETTING_STARTED.md      # Start here - installation and first steps
├── QUICK_REFERENCE.md      # Quick cheat sheet for common operations
├── API_REFERENCE.md        # Complete API documentation
├── INTEGRATION_GUIDE.md    # Platform-specific guides
├── BOTTOM_SHEET_ROUTING.md # Bottom sheet routing system guide
├── EXAMPLES.md             # Working code examples
└── BEST_PRACTICES.md       # Production patterns and tips
```

## 🎯 Choose Your Path

### New to Oxy?
Start with the **[Getting Started Guide](./GETTING_STARTED.md)** - it will walk you through installation and your first integration in minutes.

### Need a Quick Reminder?
Check the **[Quick Reference](./QUICK_REFERENCE.md)** for common operations and code snippets.

### Building for a Specific Platform?
See the **[Integration Guide](./INTEGRATION_GUIDE.md)** for platform-specific instructions:
- React Native
- Expo
- Next.js
- React (Web)
- Node.js / Express
- Vue.js

### Looking for Examples?
Browse **[Code Examples](./EXAMPLES.md)** for complete working examples:
- Authentication flows
- User management
- File uploads
- Social features
- Real-world apps

### Ready for Production?
Read **[Best Practices](./BEST_PRACTICES.md)** for:
- Error handling
- Performance optimization
- Security
- Testing
- Code organization

## 🔍 Finding What You Need

### By Feature

- **Authentication**: [Getting Started](./GETTING_STARTED.md#authentication) | [API Reference - Auth](./API_REFERENCE.md#authentication)
- **User Management**: [API Reference - Users](./API_REFERENCE.md#user-management) | [Examples](./EXAMPLES.md#user-management-examples)
- **Bottom Sheet Routing**: [Bottom Sheet Routing Guide](./BOTTOM_SHEET_ROUTING.md) - Complete guide to the routing system
- **File Uploads**: [API Reference - Files](./API_REFERENCE.md#file--asset-management) | [Examples](./EXAMPLES.md#file-upload-examples)
- **Social Features**: [API Reference - Social](./API_REFERENCE.md#social-features) | [Examples](./EXAMPLES.md#social-features-examples)
- **Privacy**: [API Reference - Privacy](./API_REFERENCE.md#privacy--security)

### By Platform

- **React Native**: [Integration Guide - React Native](./INTEGRATION_GUIDE.md#react-native)
- **Expo**: [Integration Guide - Expo](./INTEGRATION_GUIDE.md#expo)
- **Next.js**: [Integration Guide - Next.js](./INTEGRATION_GUIDE.md#nextjs)
- **Node.js**: [Integration Guide - Node.js](./INTEGRATION_GUIDE.md#nodejs--express)

## 💡 Common Tasks

### I want to...
- **Add authentication to my app** → [Getting Started](./GETTING_STARTED.md#authentication)
- **Use bottom sheet screens** → [Bottom Sheet Routing Guide](./BOTTOM_SHEET_ROUTING.md)
- **Upload images** → [File Upload Examples](./EXAMPLES.md#file-upload-examples)
- **Show user profiles** → [User Management Examples](./EXAMPLES.md#user-management-examples)
- **Implement follow/unfollow** → [Social Features Examples](./EXAMPLES.md#social-features-examples)
- **Handle errors properly** → [Best Practices - Error Handling](./BEST_PRACTICES.md#error-handling)
- **Optimize performance** → [Best Practices - Performance](./BEST_PRACTICES.md#performance)

## 🆘 Need Help?

- 📖 Check the [Main README](../README.md) for overview
- 🔍 Search the [API Reference](./API_REFERENCE.md) for specific methods
- 💬 Open an issue on [GitHub](https://github.com/OxyHQ/OxyHQServices/issues)
- 🌐 Visit [oxy.so](https://oxy.so) for more information

## 📝 Contributing

Found an issue with the documentation? Want to add an example? Contributions are welcome!

1. Fork the repository
2. Make your changes
3. Submit a pull request

---

**Happy coding! 🚀**

