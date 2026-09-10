# Public Key Authentication

Oxy uses **public/private key cryptography** (ECDSA secp256k1) as the primary identity system. Password-based auth is available for the web gateway, but this guide focuses on public key flows across the Oxy ecosystem.

## Overview

### Key Concepts

- **Private Key**: Generated and stored securely on the user's device (never leaves the device)
- **Public Key**: Serves as the unique identifier across the Oxy ecosystem (displayed as truncated public key if no username is set)
- **Digital Signatures**: All actions are cryptographically signed to prove identity
- **Recovery Phrase**: BIP39 mnemonic phrase (12 or 24 words) for backing up and restoring identities
- **Oxy Accounts App**: The dedicated mobile app where users manage their cryptographic identity

### Architecture

```
┌─────────────────┐
│  Oxy Accounts   │  ← User's identity wallet (stores private keys)
│      App        │
└────────┬────────┘
         │
         │ Authorizes via QR/deep link
         │
         ▼
┌─────────────────┐
│  Other Oxy Apps │  ← Use "Sign in with Oxy" button
│  (Third-party)  │
└─────────────────┘
```

### Offline-First Design

The identity system is designed to work **completely offline**:

1. **Identity Generation**: Cryptographic keys are generated locally on the device without any network request
2. **Self-Custody**: The private key is stored securely on the device and never sent to any server
3. **Sync When Online**: When internet is available, the identity syncs with Oxy servers for cross-device features
4. **Works Without Internet**: Users can create and use their identity even without internet connectivity

```typescript
// Create identity (works offline) - no parameters needed!
const result = await createIdentity();
// result.synced = false if offline
// result.recoveryPhrase = ['word1', 'word2', ...]

// Import identity from recovery phrase
const importResult = await importIdentity('word1 word2 ... word12');
// importResult.synced = false if offline

// Check sync status
const isSynced = await isIdentitySynced();

// Manually sync when online
if (!isSynced) {
  await syncIdentity();
}
```

## For End Users

### Creating an Identity

1. Open the **Oxy Accounts** app
2. Choose "Create New Identity"
3. Tap "Generate My Keys"
4. Save your **12-word recovery phrase** securely
5. Confirm a few words from the phrase to verify you saved it
6. Your identity is ready!

Your identity is purely cryptographic - just your public/private key pair. Profile information like username, name, etc. can be added later if desired.

### Importing an Identity

1. Open the **Oxy Accounts** app
2. Choose "Import Identity"
3. Enter your **12-word recovery phrase**
4. Your identity is restored and will sync with the server when online

### Signing In to Other Apps

When you see "Sign in with Oxy" in any app:

1. Click the button (or scan QR code)
2. Oxy Accounts app opens automatically
3. Review permissions and click "Authorize"
4. You're signed in!

Web fallback: if the user is on the web, apps can send them to the auth gateway at `https://accounts.oxy.so/authorize?token=...` to complete the flow.

## For Developers

### Cross-App Authentication Flow

Third-party apps can implement "Sign in with Oxy" using the `OxySignInButton` component:

```typescript
import { OxySignInButton } from '@oxy.so/services';

function LoginScreen() {
  return (
    <View>
      <OxySignInButton 
        variant="contained"
        text="Sign in with Oxy"
      />
    </View>
  );
}
```

This button:
1. Displays a QR code for scanning with Oxy Accounts
2. Shows a "Open Oxy Accounts" button that launches the app via deep link
3. Automatically polls for authorization and completes the login

### Manual Integration

If you need more control over the authentication flow:

```typescript
import { useOxy } from '@oxy.so/services';

function CustomAuthScreen() {
  const { showBottomSheet } = useOxy();
  
  const handleSignIn = () => {
    showBottomSheet('OxyAuth'); // Opens the OxyAuth screen
  };
  
  return (
    <Button title="Sign in with Oxy" onPress={handleSignIn} />
  );
}
```

### Backend API Integration

#### Authentication Endpoints

```typescript
// 1. Create auth session (from third-party app)
POST /api/auth/session/create
Body: { sessionToken, expiresAt, appId }
Response: { sessionToken, expiresAt, status }

// 2. Check session status (polling)
GET /api/auth/session/status/:sessionToken
Response: { status, authorized, sessionId, publicKey }

// 3. Authorize session (from Oxy Accounts app)
POST /api/auth/session/authorize/:sessionToken
Headers: { 'x-session-id': userSessionId }
Body: { deviceName?, deviceFingerprint? }
Response: { success, sessionId, user }

// 4. User registration
POST /api/auth/register
Body: { publicKey, signature, timestamp }
Response: { user, session }

Note: Identity is purely cryptographic. Username and profile data are optional and can be added later via profile update endpoints.

// 5. Challenge-request authentication
POST /api/auth/challenge
Body: { publicKey }
Response: { challenge, expiresAt }

POST /api/auth/verify
Body: { publicKey, challenge, signature, timestamp, deviceName?, deviceFingerprint? }
Response: { sessionId, deviceId, user }

Note: These endpoints are also available under `/auth` (e.g., `POST /auth/verify`).
```

#### Example: User Registration

```typescript
import { KeyManager, SignatureService } from '@oxy.so/core';

// Client-side (in Oxy Accounts app)
async function registerUser() {
  // 1. Generate key pair (or use existing)
  const publicKey = await KeyManager.createIdentity();
  
  // 2. Create registration signature (no username/email needed)
  const { signature, timestamp } = await SignatureService.createRegistrationSignature();
  
  // 3. Register with backend (identity is just the publicKey)
  const response = await fetch('https://api.oxy.so/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      signature,
      timestamp,
    }),
  });
  
  return response.json();
}

// Profile data (username, name, etc.) can be added later via profile update endpoints
```

#### Example: Challenge-Response Login

```typescript
// Client-side
async function signIn() {
  const publicKey = await KeyManager.getPublicKey();
  
  // 1. Request challenge
  const { challenge } = await fetch(
    `https://api.oxy.so/api/auth/challenge?publicKey=${publicKey}`
  ).then(r => r.json());
  
  // 2. Sign the challenge
  const { challenge: signature, timestamp } = await SignatureService.signChallenge(challenge);
  
  // 3. Verify and create session
  const { sessionId } = await fetch('https://api.oxy.so/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      challenge,
      signature,
      timestamp,
    }),
  }).then(r => r.json());
  
  return sessionId;
}
```

## Crypto Module API

The crypto module is exported from `@oxy.so/core`:

### KeyManager

```typescript
import { KeyManager } from '@oxy.so/core';

// Generate new identity
const publicKey = await KeyManager.createIdentity();

// Import from private key (hex)
const publicKey = await KeyManager.importKeyPair(privateKeyHex);

// Check if identity exists
const hasIdentity = await KeyManager.hasIdentity();

// Get public key
const publicKey = await KeyManager.getPublicKey();

// Get private key (use with caution!)
const privateKey = await KeyManager.getPrivateKey();

// Delete identity
await KeyManager.deleteIdentity();

// Derive public key from private key (utility)
const publicKey = KeyManager.derivePublicKey(privateKeyHex);
```

### SignatureService

```typescript
import { SignatureService } from '@oxy.so/core';

// Sign a message (uses stored private key)
const signature = await SignatureService.sign('Hello, World!');

// Verify a signature
const isValid = await SignatureService.verify(
  'Hello, World!',
  signature,
  publicKey
);

// Create registration signature
const { signature, timestamp } = await SignatureService.createRegistrationSignature(
  'username',
  'email@example.com'
);

// Sign challenge for authentication
const { challenge, timestamp } = await SignatureService.signChallenge('challenge123');

// Sign request data
const { signature, timestamp } = await SignatureService.signRequestData({
  action: 'delete',
  userId: '123',
});
```

### RecoveryPhraseService

```typescript
import { RecoveryPhraseService } from '@oxy.so/core';

// Generate new identity with recovery phrase (12 words)
const { phrase, words, publicKey } = await RecoveryPhraseService.generateIdentityWithRecovery();

// Generate with 24 words (more secure)
const { phrase, words, publicKey } = await RecoveryPhraseService.generateIdentityWithRecovery24();

// Restore identity from phrase
const publicKey = await RecoveryPhraseService.restoreFromPhrase(phrase);

// Validate phrase
const isValid = RecoveryPhraseService.validatePhrase(phrase);

// Get suggestions for partial word (autocomplete)
const suggestions = RecoveryPhraseService.getSuggestions('aband', 5);

// Derive public key from phrase (without storing)
const publicKey = await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase);
```

## Security Best Practices

### Private Key Storage

- Private keys are stored in **Expo SecureStore** on React Native devices
- Keys **never leave the device** - all signing happens locally
- Never log, transmit, or store private keys in plaintext

### Recovery Phrase

- **Always** have users save their recovery phrase before completing registration
- Store recovery phrases securely offline (paper, password manager)
- Never store recovery phrases on servers or in logs
- Provide clear instructions on phrase backup

### Signature Verification

Always verify signatures server-side before processing sensitive operations:

```typescript
import { SignatureService } from '@oxy.so/core';

// Server-side
function verifyRequest(publicKey: string, data: any, signature: string, timestamp: number) {
  // 1. Check timestamp (prevent replay attacks)
  const age = Date.now() - timestamp;
  if (age > 5 * 60 * 1000) { // 5 minutes
    throw new Error('Request expired');
  }
  
  // 2. Verify signature
  const message = JSON.stringify(data);
  const isValid = SignatureService.verifyRequestSignature(
    publicKey,
    data,
    signature,
    timestamp
  );
  
  if (!isValid) {
    throw new Error('Invalid signature');
  }
  
  return true;
}
```

### Challenge-Response Authentication

- Always use unique, time-limited challenges
- Store challenges with expiration times
- Mark challenges as used after verification
- Use cryptographically secure random generation

## Migration from Password Authentication

If you have existing code using password authentication:

### Old Code (Deprecated)

```typescript
// ❌ No longer works
const { login, signUp } = useOxy();
await login('username', 'password');
await signUp('username', 'email', 'password');
```

### New Code

```typescript
// ✅ Use public key authentication
const { createIdentity, importIdentity, signIn } = useOxy();

// For Oxy Accounts app:
const { recoveryPhrase, synced } = await createIdentity();
// Show recovery phrase to user
// synced = false if offline, will auto-sync when online

// For importing:
const { synced } = await importIdentity('word1 word2 ... word12');
// synced = false if offline, will auto-sync when online

// For signing in:
const user = await signIn();
```

### For Third-Party Apps

Use `OxySignInButton` or the `OxyAuth` screen (see "Cross-App Authentication Flow" above).

## Troubleshooting

### "No identity found on this device"

**Solution**: User needs to create or import an identity in the Oxy Accounts app.

### "Invalid signature"

**Possible causes**:
- Message format mismatch (check server-side verification code)
- Wrong private key used for signing
- Timestamp expired or invalid

### "Challenge expired"

**Solution**: Request a new challenge. Challenges typically expire after 5 minutes.

### Recovery phrase validation fails

**Check**:
- All words are from the BIP39 English wordlist
- Words are spelled correctly
- No extra spaces or characters
- Exactly 12 or 24 words

### "Property 'Buffer' doesn't exist" (React Native)

This error should no longer occur as of version 5.15.6+. The `@oxy.so/services` package now includes a Buffer polyfill that is automatically loaded.

If you see this error on an older version, update to the latest version:

```bash
npm update @oxy.so/services
```

The crypto module automatically polyfills the `Buffer` global required by the BIP39 library when running in React Native environments.

## Additional Resources

- [ECDSA (Wikipedia)](https://en.wikipedia.org/wiki/Elliptic_Curve_Digital_Signature_Algorithm)
- [BIP39 Specification](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
- [secp256k1 Curve](https://en.bitcoin.it/wiki/Secp256k1)
- [Digital Signatures Guide](https://www.cloudflare.com/learning/ssl/what-is-a-digital-signature/)

