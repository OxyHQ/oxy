# Accounts by Oxy

Expo app for managing your Oxy account — the equivalent of Google MyAccount. Covers settings, security, sessions, payments, and privacy. **Keyless by design**: identity creation and the self-sovereign identity layer (did:web, signed records, domain verification, "Sign in with Oxy") live in `Commons by Oxy` (`packages/commons`). This app manages an already-created account only.

`accounts.oxy.so` is the **sole owner of account management** in the ecosystem — the IdP (`auth.oxy.so`) permanently redirects its former settings surfaces here.

## Development

```bash
cd packages/accounts
bun install
bun run start        # Expo dev server
bun run ios          # iOS simulator
bun run android      # Android emulator
bun run web          # Web
bun run test         # Jest
bun run typecheck    # tsc --noEmit
```

## Architecture

- **Router**: `expo-router` with `typedRoutes: true` — all `router.push()` calls must use typed path strings, no `as any`.
- **Auth SDK**: `@oxy.so/services` (`OxyProvider` with a registered `clientId`) + `@oxy.so/core` (types). The SDK's device-first cold boot owns session restore end to end — this app implements **no local session restore, callbacks, or token plumbing**.
- **UI**: `@oxy.so/bloom` component library; BloomThemeProvider sets Inter globally — do NOT set `fontFamily: 'Inter-*'` manually.
- **i18n**: `LocaleProvider` + `useTranslation` in `lib/i18n/`; 11 locales; device locale via `Intl.DateTimeFormat()` (no `expo-localization` needed).

## Sign-in

Accounts is a standard official relying party:

- Cold boot restores the session silently from the server-side device session (see [docs/auth/device-session.md](../../docs/auth/device-session.md)); it never redirects to a login page.
- Logged-out users see `(auth)/index.tsx`, which opens the SDK sign-in surface (`OxyAccountDialog`): ONE primary "Continue with Oxy" action (issue #691, Phase 5) that Oxy automatically routes to Commons (same-device deep link / known-install push / QR); there is no password option in this dialog.
- Identity **creation** is in `Commons by Oxy` (`packages/commons`), NOT in this app — Accounts is management-only on all platforms.
- `(auth)`↔`(tabs)` routing keys purely on session state (`isAuthResolved` / `isAuthenticated`); there is no identity-key gate here.

## Key Routes

```
app/
  (auth)/
    index.tsx             — logged-out entry; opens the SDK sign-in surface
  (tabs)/
    index.tsx             — home / account overview
    personal-info.tsx     — profile fields
    security.tsx          — sessions, devices, 2FA
    sessions.tsx          — active sessions
    activity.tsx          — security activity (infinite scroll, GET /security/activity)
    payments.tsx          — subscription, wallet, transactions (reads `timestamp` field)
    data.tsx              — data & privacy
    sharing.tsx           — sharing / family
    family.tsx            — family group
    managed-accounts.tsx  — account graph (orgs, projects, shared accounts)
    authorize.tsx         — connected apps / grants
    scan-qr.tsx           — QR scan entry for cross-device sign-in
    storage.tsx           — storage usage
    search.tsx            — settings search
```

## Shared Modules (use these, don't duplicate)

| Module | Purpose |
|--------|---------|
| `utils/relative-time.ts` + `hooks/useRelativeTime.ts` | i18n-aware relative timestamps |
| `utils/device-utils.ts` | `getDeviceIcon`, `getDeviceDisplayName`, `DeviceRecord`, `groupDevicesByType` |
| `hooks/useAvatarUrl.ts` | Avatar URL with fallback |
| `hooks/useDebounce.ts` | Debounce hook |
| `constants/payments.ts` | `FAIRCOIN_WALLET_URL` and other payment constants |
| `constants/drawer-screens.ts` | Typed `DrawerScreenConfig[]` — data-drives the Drawer.Screen list in `_layout` |
| `lib/account/delete-account-flow.ts` | Safe account deletion (deleteAccount → purgeIdentity → signOutAll) |
| `hooks/identity/useIdentitySync.ts` | Identity auto-sync (byte-identical semantics) |

## Delete Account Flow

Strict order enforced in `lib/account/delete-account-flow.ts`:
1. `oxyServices.deleteAccount(...)` — signed deletion with username confirmation
2. On SUCCESS ONLY: `KeyManager.deleteIdentity(skipBackup=true, force=true, userConfirmed=true)` — purges primary AND backup to prevent zombie identity auto-restore
3. `signOutAll()`
Local-purge failure is non-fatal (logged, not thrown).

## Error Boundaries

Error boundaries at root, `(tabs)`, and `(auth)` layout levels using `ErrorFallback` component.

## expo-router Notes

- No `@react-navigation/*` direct imports.
- Synthesize `{ type: 'OPEN_DRAWER' }` drawer payloads inline.
- `constants/drawer-screens.ts` must live in `constants/`, not `app/` — otherwise expo-router registers it as a route.
- The root `<Stack>` is the SOLE authority for `(auth)`↔`(tabs)` swaps — child screens never navigate across that boundary on the same signal.
