# Managed Accounts (Sub-Accounts) Design Spec

## Overview

Allow users to create and manage sub-accounts (managed identities) under their primary account. Sub-accounts are full User documents without passwords, accessible only by their owners/managers. When acting as a sub-account, all API actions (creating posts, properties, follows, etc.) are attributed to the sub-account's userId transparently.

## Data Model

### ManagedAccount (new collection)

```typescript
interface IManagedAccount {
  accountId: ObjectId;     // The sub-account (references User)
  ownerId: ObjectId;       // Who created it (references User, the original owner)
  managers: [{
    userId: ObjectId;      // References User
    role: 'owner' | 'admin' | 'editor';
    addedAt: Date;
    addedBy: ObjectId;
  }];
  createdAt: Date;
  updatedAt: Date;
}
```

- `accountId` is unique — a User can only be a managed account once
- `ownerId` is the creator and cannot be removed
- `managers` array allows multiple users to manage the same sub-account
- Roles: `owner` (full control + delete), `admin` (manage + edit), `editor` (act as only)

### User model additions

```typescript
// New fields on User schema
{
  isManagedAccount: { type: Boolean, default: false },
  managedBy: { type: ObjectId, ref: 'User', default: null }  // points to ownerId for quick lookup
}
```

- `isManagedAccount: true` means this user has no password and cannot login directly
- `managedBy` is denormalized from ManagedAccount.ownerId for fast queries

### Client-side User interface additions

```typescript
// Added to User interface in @oxy.so/core
{
  isManagedAccount?: boolean;
  managedBy?: string;  // userId of owner
}
```

## API Routes

### New routes: `/managed-accounts`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/managed-accounts` | Required | Create a new managed account |
| GET | `/managed-accounts` | Required | List all accounts I manage |
| GET | `/managed-accounts/:accountId` | Required | Get managed account details |
| PUT | `/managed-accounts/:accountId` | Required (owner/admin) | Update managed account profile |
| DELETE | `/managed-accounts/:accountId` | Required (owner only) | Delete managed account |
| POST | `/managed-accounts/:accountId/managers` | Required (owner/admin) | Add a manager |
| DELETE | `/managed-accounts/:accountId/managers/:userId` | Required (owner only) | Remove a manager |

### POST `/managed-accounts` — Create managed account

Request body:
```json
{
  "username": "nates-agency",
  "name": { "first": "Nate's", "last": "Agency" },
  "bio": "Real estate agency",
  "avatar": "file-id-optional"
}
```

Server-side flow:
1. Create a new User document with `isManagedAccount: true`, `managedBy: req.user.id`, no password, no email required
2. Create a ManagedAccount document linking the new user to the owner
3. Generate keypair for ActivityPub federation (same as regular users)
4. Return the new user + managed account relationship

## Acting-As Middleware

### Header: `X-Acting-As: <userId>`

The core mechanism. Inserted into the auth chain after token validation, before route handlers.

### Flow in `@oxy.so/core` `auth()` middleware

```
1. Normal JWT validation → req.user = authenticated user
2. Check X-Acting-As header
3. If present:
   a. Query ManagedAccount where accountId = headerValue 
      AND managers.userId includes req.user.id
   b. If not found → 403 Forbidden
   c. Load the managed account's User document
   d. Set req.originalUser = req.user (preserve original)
   e. Set req.actingAs = { userId: managedUser.id, role: manager.role }
   f. Replace req.user with managed user (set both .id and ._id)
   g. Set req.userId = managed user id
4. Route handler runs with req.user = sub-account
```

### Where to implement

In `packages/core/src/mixins/OxyServices.utility.ts` inside the `auth()` method, after the JWT validation block and before returning `next()`. This ensures ALL apps using `oxy.auth()` automatically get acting-as support.

### Validation endpoint

The middleware needs to verify ownership. Two options:
- **Option A**: API call to `GET /managed-accounts/verify?accountId=X&userId=Y` (adds latency)
- **Option B**: Cache the ManagedAccount relationships in the auth middleware with short TTL

**Chosen: Option A with caching.** First request validates via API, result cached for 5 minutes in-memory. Cache key: `managed:${userId}:${accountId}`.

## SDK Changes (`@oxy.so/core`)

### OxyServices new methods

```typescript
// ManagedAccount CRUD
createManagedAccount(data: CreateManagedAccountInput): Promise<ManagedAccountResponse>
getManagedAccounts(): Promise<ManagedAccountResponse[]>
getManagedAccountDetails(accountId: string): Promise<ManagedAccountResponse>
updateManagedAccount(accountId: string, data: UpdateInput): Promise<ManagedAccountResponse>
deleteManagedAccount(accountId: string): Promise<void>
addManager(accountId: string, userId: string, role: Role): Promise<void>
removeManager(accountId: string, userId: string): Promise<void>
```

### HttpService — automatic header injection

```typescript
// New field on OxyServices
private _actingAsUserId: string | null = null;

// Public method
setActingAs(userId: string | null): void {
  this._actingAsUserId = userId;
}

getActingAs(): string | null {
  return this._actingAsUserId;
}

// In HttpService.getAuthHeader() or request interceptor:
if (this._actingAsUserId) {
  headers['X-Acting-As'] = this._actingAsUserId;
}
```

## RN SDK Changes (`@oxy.so/services`)

### OxyContext additions

```typescript
// New state
actingAs: string | null;                    // userId of active sub-account
managedAccounts: ManagedAccountResponse[];  // cached list

// New methods
setActingAs(userId: string | null): void;   // switch active identity
refreshManagedAccounts(): Promise<void>;    // reload list from API
createManagedAccount(data): Promise<ManagedAccountResponse>;
```

### UI Components

**AccountSwitcherScreen updates:**
- Show managed accounts with "Managed" badge below the session-based accounts
- Tapping a managed account calls `setActingAs(userId)` (no session switch)
- Show current acting-as state with visual indicator
- "Create New Identity" button at bottom

**CreateManagedAccountScreen (new):**
- Form: username, display name, bio, avatar
- Username validation (real-time availability check)
- Creates the managed account and switches to it

**Acting-as banner (new component):**
- Subtle banner at top of app: "Acting as [name]" with tap to switch back
- Only shown when `actingAs` is not null
- Exported from @oxy.so/services for apps to use

## App Integration

### Mention
- AccountCenter: add "Managed Accounts" section
- BottomBar: show acting-as avatar instead of user avatar when active
- Post creation: automatically uses sub-account userId (transparent via middleware)

### Homiio
- Settings: add "Managed Accounts" / "Business Profiles" entry
- Property creation: automatically uses sub-account userId
- SideBar: show acting-as identity

### Allo, TNP
- Settings: add entry point when ready

## Security Considerations

- Sub-accounts cannot login directly (no password, `isManagedAccount: true`)
- The `X-Acting-As` header is ONLY processed after valid JWT authentication
- Role-based access: editors can act-as but cannot delete or manage
- `req.originalUser` is always preserved for audit trails
- Sub-account deletion cascades: remove ManagedAccount doc, optionally deactivate User
- Rate limiting applies to the original user, not the sub-account

## Migration

- Zero migration of existing data
- Existing users are unaffected (isManagedAccount defaults to false)
- Backwards-compatible: no X-Acting-As header = existing behavior
