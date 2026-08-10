# ADR 0004 — One headless `OxyRuntime` behind one public `OxyProvider`

- Status: accepted
- Date: 2026-08-10
- Issue: #937

## Context

There are effectively two components named `OxyProvider`: the public composition
root (`packages/services/src/ui/components/OxyProvider.tsx`, 324 lines) and the
internal context provider it wraps (`packages/services/src/ui/context/
OxyContext.tsx`, 1409 lines). Consumers cannot tell which one an error, a stack
frame, or a piece of documentation is talking about.

The internal one is where the concerns collected. Its context value
(`oxyContextTypes.ts`) currently exposes, in one object:

- session state — `user`, `sessions`, `activeSessionId`, `isAuthenticated`,
  `isLoading`, `isTokenReady`, `hasAccessToken`, `canUsePrivateApi`,
  `isPrivateApiPending`, `isAuthResolved`, `isStorageReady`, `error`;
- session operations — `signIn`, `handleWebSession`, `startWebOAuthSignIn`,
  `logout`, `logoutAll`, `switchSession`, `removeSession`, `refreshSessions`,
  `clearSessionState`, `clearAllAccountData`;
- the account graph — `accounts`, `switchToAccount`, `refreshAccounts`,
  `createAccount`;
- the dialog — `accountDialogController`, `isAccountDialogOpen`,
  `openAccountDialog`, `closeAccountDialog`;
- **passkey management** — `signInWithPasskey`, `registerWithPasskey`,
  `addPasskey`, `removePasskey`, `revokeSuspiciousSignIn`;
- **device management** — `getDeviceSessions`, `logoutAllDeviceSessions`,
  `updateDeviceName`;
- **language state** — `currentLanguage`, `currentLanguages`,
  `currentLanguageMetadata`, `currentLanguageName`, `currentNativeLanguageName`,
  `setLanguage`;
- **unrelated domain/UI** — `useFollow`, `showBottomSheet`, `openAvatarPicker`;
- plumbing — `storageKeyPrefix`, `clientId`, `oxyServices`, `sessionClient`,
  `hasIdentity`, `getPublicKey`.

Two problems follow. First, **any** change to any of those rebuilds the context
value, so a language change rerenders every auth consumer. Second, session truth
is spread across overlapping owners — `SessionClient` state, session-management
React state, zustand stores, the `OxyServices` token store, the persisted auth
state store, component state, and the Query cache — with implicit `useEffect`
chains synchronising them. When two owners disagree, which one is right is not
answerable from the code.

## Decision

**One headless runtime owns the truth; React is an adapter over it.**

```ts
const runtime = createOxyRuntime({ clientId, sessionMode, platform, services, queryClient });
```

The runtime owns `OxyServices`, `SessionClient`, auth-state persistence, the
device transport adapter, cold boot and refresh, the active
`DeviceAccountContext`, the account directory, the OAuth/Commons sign-in
controller, the account-dialog controller, application session/token state, the
account-scoped cache transition hooks, and reconnect/focus/socket/cross-tab
convergence.

**One snapshot** is the observable state:

```ts
interface OxyRuntimeSnapshot {
  status: 'booting' | 'authenticated' | 'signed_out' | 'error';
  device: DeviceDirectory | null;
  activeContext: DeviceAccountContext | null;
  principal: User | null;
  account: User | null;
  tokenStatus: 'missing' | 'refreshing' | 'ready' | 'error';
  authResolved: boolean;
  switching: boolean;
  error: OxyRuntimeError | null;
}
```

Everything else is a **derived selector**, not a second writable store.

**One stable context**: the provider's value is the runtime reference itself, so
it never changes identity. Hooks (`useAuth`, `useOxy`, `useActiveAccount`,
`useDeviceDirectory`, `useOxyClient`, `useAccountSwitcher`) subscribe with
selectors through `useSyncExternalStore`. They are hooks over one context, not
additional providers.

**One public provider.** The normal integration stays exactly:

```tsx
<OxyProvider clientId={OXY_CLIENT_ID}><App /></OxyProvider>
```

and Commons stays `<OxyProvider clientId={…} sessionMode="identity">`. There is
no `<AuthProvider><SessionProvider><AccountsProvider>…` stack, now or later.
The internal provider stops being a second exported component called
`OxyProvider`; the target names are `OxyRuntime`, `OxyRuntimeContext`, and the
public `OxyProvider` composition root.

**Internal technical providers stay internal.** React Query, Bloom, safe areas,
gesture handler, keyboard, surface host and toast outlets are mounted once by
`OxyProvider` and are implementation details, not session authorities. A
consumer-supplied QueryClient becomes *the* QueryClient — never nested under
another. Outlets that render rows or surfaces mount exactly once.

**Off the central value**, available as focused hooks or ordinary exports from
`@oxyhq/services`: `useFollow`, avatar-picker presentation, arbitrary
bottom-sheet navigation, detailed passkey management, detailed device
management, payments/files/social APIs, and locale metadata that does not
determine session behaviour. They remain available; they are not fields on the
authentication context.

**Missing provider fails fast.** The base hook throws a clear error. Optional
use, if genuinely needed, is an explicit `useOptionalOxy()`. No fabricated
forever-loading runtime with no-op methods.

**Platform differences are explicit files** — `platformAdapter.{web,native}.ts`,
`authStore.{web,native}.ts`, `OxyProvider.{web,native}.tsx` — not
runtime-computed module names or bundler-analysis tricks. Business logic stays
in the shared runtime.

## Alternatives rejected

**Split the context into several providers.** It fixes the rerender problem and
creates the provider stack this ADR exists to prevent, while leaving the
"which owner is right" question untouched — it would have more owners, not
fewer.

**Keep the context and memoize harder.** The value would still be rebuilt by
unrelated state, and the duplicate state owners would remain. Memoization treats
the symptom.

**Move everything into zustand.** Swaps one store technology for another without
answering ordering: the token-before-notify invariant (ADR 0002) is a sequencing
property of a transition, which a store does not express.

## Consequences

- `packages/services/src/` is React-Compiler-compiled inside the `commons` and
  `accounts` apps, so the runtime's external mutable state must be read through
  `useSyncExternalStore` and never out-of-band in a memoizable position.
- Public hooks keep working as compatibility selectors during the migration,
  with deprecated fields marked. Compatibility APIs are removed in an
  intentional major — but duplicate state machines are *not* preserved merely to
  preserve implementation details.
- Cleanup is deterministic: sockets, timers, listeners, popups and subscriptions
  are owned by the runtime and released with it.
- Tests must prove: one public provider mounts; a missing provider throws; a
  supplied QueryClient is not duplicated; outlets mount once; unrelated state
  changes do not rerender auth consumers; cold boot resolves exactly once; one
  switch causes one ordered transition; no token mirror into a global
  `oxyClient` and no app-local `setTokenGetter` or switch-reset gate is
  required; both platform adapters build without pulling unavailable native
  modules.
