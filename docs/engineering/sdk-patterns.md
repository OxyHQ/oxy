# SDK client patterns (@oxyhq/core and @oxyhq/services)

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

## useCurrentUser Pattern (services)

- `queryFn` must be pure — never call `useAuthStore.setUser()` inside a `queryFn`.
- Side effects on fresh query data belong in a `useEffect` on `query.data` outside the queryFn.

## SDK Cache Sweep on Profile Writes (core)

`oxyServices.updateProfile()` calls `clearCacheByPrefix()` for:
- `GET:/session/user/`
- `GET:/users/me`
- `GET:/profiles/username/`
- The specific user id

Without this sweep the HTTP cache returns stale data and the username onboarding step loops.

## KeyManager Safety (core — critical)

- `createIdentity` / `importKeyPair` throw `IdentityAlreadyExistsError` if an identity already exists. Pass `{ overwrite: true }` to replace.
- Writes use `_persistIdentityAtomic`: backs up the EXISTING identity first, writes new primary → sign/verify probe → only then refreshes backup. A failed `createIdentity({overwrite:true})` rolls primary back to the exact prior bytes — never destroys the prior identity.
- **Identity slots live under DEDICATED expo-secure-store `keychainService`s — never the default.** Primary = `oxy_identity`, backup = `oxy_identity_backup`, both with `_v2`-suffixed key names (`keyManager.ts` `V2_SLOT_LAYOUT`). On Android, anything written WITHOUT an explicit `keychainService` shares expo-secure-store's single default AndroidKeyStore key (`key_v1`) — and expo-secure-store PERMANENTLY DELETES the ciphertext on the read path the instant decryption fails (BadPadding / missing key → `deleteItemImpl` + return `null`, never a throw), so co-located slots die together the moment that one shared key is invalidated. Any NEW secret slot class must get its own `keychainService`. Migration off the legacy default-service layout is lazy (runs on first touch) and interruption-safe (copy → read-back-verify → only then delete legacy) — never bypass it with a direct SecureStore read of an identity key.
- **A non-secret identity marker** (`oxy_identity_marker_v1` in AsyncStorage/localStorage, `identityMarker.ts`) records that an identity was ever provisioned on this device, independent of the keychain. Written by `_persistIdentityAtomic`, cleared only by `deleteIdentity`. It disambiguates "keys empty because this is a fresh install" from "keys empty because the keystore died" — a distinction the keys alone cannot make.
- `KeyManager.getIdentityStatus()` is the authoritative identity probe: `present` / `absent` (no keys, no marker — the ONLY state that may route to create/onboarding) / `lost` (marker present, keys gone — route to recovery, NEVER create) / `unavailable` (a storage read threw — NEVER cached, so callers retry).
- `hasIdentity()` / `getPublicKey()` THROW `IdentityUnavailableError` on a storage read failure instead of degrading to `false`/`null` — never catch that error and treat it as "no identity".
- `attemptIdentityRecovery()` restores a `lost` identity from the v2 backup slot, then the cross-app shared slot (Android EncryptedSharedPreferences bridge / iOS keychain group), validating the recovered public key against the marker's before accepting it — a source holding a different account is skipped, never silently switched.
- `hasIdentity()` requires both keys present, well-formed, and matching (not just key existence).
- `verifyIdentityIntegrity()` performs a full sign/verify probe, not just byte parsing.
- `restoreIdentityFromBackup()` is transient-error-safe: a keychain-read EXCEPTION is treated as transient → refuses to clobber a healthy-but-locked primary. Dual mismatch guards prevent silently switching accounts.
- Strict hex/length/range validation on all private/public key material.
- `canonicalPrivateKey(key) = key.toLowerCase().padStart(64, '0')` applied at every `ec.keyFromPrivate(...)` callsite.
- `isValidPrivateKey` rejects degenerate scalars via `^0{56}` check (rejects `'1'`, `'2'`, etc.).
- `deleteIdentity` signature: `(skipBackup=false, force=false, userConfirmed=false)`. `force=true` deletes the backup slot.

## PrivacySettings Type (core)

`PrivacySettings` interface lives in `packages/core/src/models/interfaces.ts`. `updateProfile`, `getPrivacySettings`, and `updatePrivacySettings` on `OxyServices` are typed against it — no `Record<string, any>` or `Promise<any>` on the SDK surface.

## HttpService (services)

- On React Native (Expo 56), FormData uploads route through `XMLHttpRequest` — do NOT use fetch for multipart uploads on RN (Expo 56's fetch rejects RN file descriptors).
- **Web `{uri}` upload descriptors:** the browser's `FormData` can't read bytes from a `{uri}` object (only RN's can). On web, `assetUpload` materializes `{uri}` → `Blob` via `fetch` before appending (core ≥3.10.1); the API rejects 0-byte uploads with `400 Empty file`. Never persist/append an empty file.

## Offline Mutation Queue (services)

- React Query `networkMode: 'offlineFirst'` with stable `mutationKey` on all mutations
- `useMutationStatus` aggregator hook surfaces "Syncing…" indicators across the app

## Offline-First Persistence (services)

- `@tanstack/react-query-persist-client` wired in `@oxyhq/services` (AsyncStorage; localStorage-backed on web).
- Query whitelist: `accounts`, `users`, `sessions`, `devices`, `privacy`, `payments` queries are persisted; mutations always persisted; 30-day TTL; 1s throttle; v1 cache cleanup on startup.
- `OxyProvider` awaits `restored` before exposing the QueryClient → first paint serves cached data, not a loading spinner.
- `useOnlineStatus()` hook in `@oxyhq/services` — built on `useSyncExternalStore` over `onlineManager`; use for offline banners in app UIs.
- TanStack Query must use a consistent `^5.x` major version across services, console, and test-app-expo — check each workspace's `package.json` for the pinned range.

## useSessionSocket (services)

- Uses an **explicit switch with a strict whitelist**: only `session_removed`, `device_removed`, `sessions_removed` events may trigger a local sign-out.
- **Never** add an `else` / default branch that calls sign-out — unknown events log a dev warning only.
- Shape: `SessionEventType` union + `SessionUpdatePayload` interface; extracted `refreshSessionsSafe` + `triggerLocalSignOut` helpers; no `logout` prop.

## BottomSheet Gesture Patterns (services)

- `closeGenerationRef` bumped on each `open()`; every close callback captures the generation at commit time — stale callbacks from cancelled close cycles no-op.
- Body pan uses `manualActivation()` with `simultaneousWithExternalGesture(scrollViewRef)` — only activates when scroll is at top AND downward movement >8dp. Handle pan is unconditional.
- Modal contents **must** wrap children in `<GestureHandlerRootView>` — RN's `Modal` renders into its own window; the app-root GHRV does not extend into it.
- Backdrop dims proportionally with drag distance (iOS Photos pattern).
- `scrollable?: boolean` prop (default `true`). Set `false` for sheets that own a `VirtualizedList` (no internal ScrollView wrapping).
- `getSheetConfig(routeName, screenProps)` in `navigation/routes.ts` returns `{ scrollable }` per route. `FileManagement` in image-only-picker mode gets `scrollable: false`.

## PhotoPickerView (services)

Activated inside `FileManagementScreen` when `isImageOnlyPicker` is true. Apple Photos-style UI:
- Translucent top bar, full-bleed black backdrop, 3-up phone / 4-up tablet grid.
- Primary ring + spring pulse on selection; sibling dim to 0.6 opacity; numbered selection badge.
- FadeIn stagger 15ms/cell capped at 800ms; skips when `AccessibilityInfo.isReduceMotionEnabled()`.
- Non-blocking 2px upload progress in header; pull-to-refresh; haptics via dynamic `expo-haptics` import.
- Existing file-management flow untouched.

## AvatarCropScreen (services — accounts)

- Translucent top bar (Cancel / title / primary Done CTA), full-bleed `#000` canvas.
- 3×3 thirds grid fades 800ms after gestures end; white ring; floating zoom chip during pinch.
- Entrance spring; haptics on reset / zoom limits / confirm.
- `ActivityIndicator` + "Saving…" during processing; Reset link; full a11y + `announceForAccessibility`; reduced-motion respect.
- i18n keys under `editProfile.crop.*` and `editProfile.toasts.crop*` in en-US.json + es-ES.json.

## New React Query Hooks (@oxyhq/services — exported from package root)

`useUserSubscription`, `useUserPayments`, `useUserWallet`, `useUserWalletTransactions`, `useAccountStorageUsage` — with typed returns (`Subscription`, `Payment`, `Wallet`, `WalletTransaction` in `ui/hooks/queries/paymentTypes.ts`). `payments` + `storage` query-key namespaces added; `payments` whitelisted for offline persistence.

## Bloom Worklets Safety (@oxyhq/bloom)

- BottomSheet pan context must use a **primitive** `SharedValue` (`contextY = useSharedValue(0)`), NEVER an object-valued SharedValue — object SharedValues mutated inside worklets crash under `react-native-worklets@0.8.3` (`removeListener` on UI thread).
- `hooks/mergeRefs.ts` returns a plain `(instance: T|null) => void` (not `React.RefCallback`) so the ref stays assignable across duplicate `@types/react` copies (RN 0.85 / React 19).
