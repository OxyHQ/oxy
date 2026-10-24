# Changelog

## [13.4.0] - 2026-10-24

### Changed

- `plugins/withOxySharedPermissions` now also applies the new
  `plugins/withOxyReleaseSigning`: an app cannot declare the Oxy signature
  permissions without its Android release being signed with, and checked
  against, the ONE ecosystem certificate (SHA-256
  `b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d`, alias
  `oxy`). It replaces `@oxy.so/app-preset/plugin/withOxyAndroidRelease`
  (removed in app-preset 5.0.0) and app-local copies such as Mention's
  `plugins/withAndroidReleaseBuild.js`; prebuild refuses a `build.gradle` one of
  them already edited. Measured on a phone: a debug-signed Mention release took
  ownership of `so.oxy.permission.IDENTITY` / `DEVICE_SESSION`, and every
  correctly signed Oxy app then failed with `INSTALL_FAILED_DUPLICATE_PERMISSION`.
  - The `release` buildType is always signed by `signingConfigs.release`, never
    the debug key. The keystore comes from the Gradle properties
    `OXY_UPLOAD_STORE_FILE`, `OXY_UPLOAD_STORE_PASSWORD` or (new)
    `OXY_UPLOAD_STORE_PASSWORD_FILE`, `OXY_UPLOAD_KEY_ALIAS`, and optionally
    `OXY_UPLOAD_KEY_PASSWORD` / `OXY_UPLOAD_KEY_PASSWORD_FILE` (default: the
    store password). `~/` is expanded.
  - **A release build without the ecosystem key FAILS.** `oxyVerifyReleaseSigning`
    runs before every release variant (`pre…ReleaseBuild`,
    `validateSigning…Release`), opens the release buildType's effective signing
    config and compares the key's certificate with the ecosystem one, so it also
    refuses an EAS-managed or per-app key and a wrong alias. The error says how
    to provide the key and never prints a password. Debug builds never run it,
    and there is no opt-out for release.
  - Opt-in `OXY_UPLOAD_SIGN_DEBUG=true` signs the debug buildType with the same
    key and puts it under the same check (a dev client that can be installed
    next to real Oxy apps). It replaces Willo's `withOxyDebugSigning`
    (`OXY_DEBUG_*`), which prebuild now refuses.
  - An app that declares no Oxy permission (Authenticator) lists
    `plugins/withOxyReleaseSigning` directly.

## [13.3.0] - 2026-10-24

Needs `@oxy.so/core` 7.2.0.

### Added

- `useAccountTheme({ canUse })` applies the account theme to Bloom: the account
  colour always (through `useAccountColor`), the account's mode
  (`user.themePreference.mode`) while this device's theme source is `account`.
  The source (`'app' | 'account'`, default `account`) is a local, per-device
  choice, read synchronously on web so the first paint knows it.
- `useAccountThemeControls()` returns `{ source, changeThemeSource,
  changeThemeMode }` for a settings screen: a mode change applies at once and,
  on the `account` source, is written to the account's portable theme; turning
  the source to `account` seeds an account that has no theme yet. Without a
  session that can reach the account the effective source is `app`.

### Changed

- `useFileDownloadUrl` answers a URL core already resolved in its first render
  (`assets.cachedUrl`), with no request and no loading frame, and returns an
  absolute `http(s)` reference unchanged. A result is never shown for another
  file, variant, expiry or viewer.

## [13.2.0] - 2026-10-24

### Added

- A single query can be kept across restarts for the signed-in account with
  `meta: { persist: 'account' }` (type `AccountQueryMeta`), without declaring
  its root in `accountQueries`: it is written to that account's blob, restored
  before the account cache is ready, dropped from memory on an account switch
  and deleted on sign-out, exactly like a declared root. Meant for the few
  reads that shape a returning user's first paint (tab layout, theme), not for
  lists. Apps that pass no `accountQueries` get this too.

### Changed

- A cold boot that paints a saved session resolves `isAuthResolved` only once
  the account's cached queries are restored (one local read), so the first
  paint already has them instead of shifting a moment later.
- The SDK's query persisters serialize only when a query they keep (or a
  mutation) changes; activity in other queries (feeds, search) no longer
  re-serializes them.
- An account cache whose stored blob cannot be read becomes ready empty
  instead of never becoming ready.

## [13.1.0] - 2026-10-24

### Added

- Runs on React Native 0.81 to 0.88 and Expo SDK 54 to 58 (it needed 0.85 and
  SDK 56). The peer floors are now the Expo SDK 54 stack: `react-native`
  `>=0.81.0`, `expo` `>=54.0.0`, each `expo-*` module at its SDK 54 version,
  `react-native-reanimated` `>=4.1.0`, `react-native-gesture-handler`
  `>=2.28.0`, `react-native-safe-area-context` `>=5.6.0`, `react-native-svg`
  `>=15.12.1`, `react-native-keyboard-controller` `>=1.18.5` and
  `@expo/app-integrity` `>=0.1.10`. `compat/expo-54` installs that stack as an
  external consumer in CI and typechecks, renders and bundles `OxyProvider`
  against it.
- Runs on react-native-macos (Astro). Importing the SDK there used to throw,
  because expo-image and react-native-keyboard-controller have no macOS
  implementation and throw on import. `.macos` forks now draw images and read
  their size through react-native's `Image` and skip the keyboard provider;
  the SDK's own iOS/Android native modules, and the Expo modules macOS lacks,
  are optional at runtime and their features stay off.

### Fixed

- The native OAuth return no longer calls `URLSearchParams.keys()`, which React
  Native's own `URLSearchParams` typings before 0.85 do not declare.

## 13.0.0

### Breaking

- Own application sign-in and account use no longer expose internal app scope or consent controls. External OAuth connections retain consent and scoped access.
- Require core 7 and contracts 6 for the shared authority contract.

## [12.14.0] - 2026-10-23

Needs `@oxy.so/core` 6.16.0.

### Changed

- A returning signed-in user's cold boot paints at once: with a session saved
  on the device, the provider shows the account from its cached profile (and
  the account's cached queries), plants a still-valid persisted token and
  resolves `isAuthResolved` before any network. The app's classification and
  the session are then checked in the background: a fresh registry lookup and
  a mint with the app's own device credential, whose commit refreshes the
  profile. If the registry now classifies the app OAuth-only, or the server
  ends the session (`invalid_device_secret` / `no_active_session` with no
  recovery lane restoring one), it signs out at that moment. If neither can be
  asked (offline, a timeout, a 5xx), the cached session stays on screen and is
  asked again on the lost-token backoff and on reconnect. The provider keeps
  the registry's last verdict per clientId and the last profile it held, in
  its own storage next to the account query cache; a sign-out deletes the
  profile, and a profile only paints for the account the saved session belongs
  to.
- A first boot (nothing cached), an identity-bound provider
  (`sessionMode: 'identity'`) and an OAuth return on the URL boot as before:
  the classification and the session hand-off stay on the critical path, with
  their deadlines.

## [12.13.0] - 2026-10-23

Needs `@oxy.so/contracts` 5.8.0.

### Changed

- `useSupervision()` reads the session's supervision state from the cache
  instead of blocking every mount on a fresh request. `OxyProvider` keeps it
  current: fetched when the session is established, refetched when the app
  returns to the foreground and when the session socket signals
  `supervision_changed`. `data` is undefined only while the session's first
  fetch is pending, while the query is disabled and after a failed fetch. The
  return shape is unchanged; the server still enforces supervision on every
  content request.

## [12.12.0] - 2026-10-22

### Changed

- Creating an account picks its categories with the same editor as the
  account's settings (`AccountCategoriesSection`): the chosen categories in
  order, the first one primary with "Make primary", and the vocabulary to add
  from. The create screen's own position-badge list is gone.

## [12.11.0] - 2026-10-22

Needs `@oxy.so/core` 6.13.0.

### Added

- `AccountSettings` from `@oxy.so/services/screens`: the body of the
  `AccountSettings` surface, for an app that embeds a managed account's
  settings in its own page. `extraSections` renders the app's own sections
  before the danger zone; `onUpdated(account, { cleared })` follows every
  accepted profile write, after the SDK's user cache already holds it, for the
  app's own copies of the identity; `archive` replaces the danger-zone row's
  words (a row with its own `title` shows only its own `description`) and the
  confirmation (a rejection is reported and nothing is archived), runs
  `beforeArchive` after the confirmation and before Oxy's archive (a rejection
  stops the archive), and `onArchived` in place of closing. Without `navigate`, Members opens as a sheet.
- The account settings edit the account's picture — through the same
  source list, cropper and upload as the personal profile — and its
  categories (primary first, "Make primary", the selectable vocabulary to add
  from, at most `MAX_ACCOUNT_CATEGORIES`). A category id this build cannot name
  keeps its row and survives a save.
- `ChangeAvatar` takes an optional `subject` (`{ avatar, displayName }`) to
  preview and offer removing a picture that is not the signed-in user's.

### Changed

- The account settings' Save is enabled only when something changed.
## [12.10.1] - 2026-10-22

### Fixed

- "Switch account" in Manage your Oxy account did nothing when the account
  dialog was already open underneath: it now brings the account switcher back to
  the front. The row is hidden for identity-bound sessions, where the switcher
  can never open.
- Closing a morphed account dialog whose host surface is already gone no longer
  leaves the dialog marked open.
- Signing out reports a failed sign-out instead of "Signed out" (Manage), and a
  rejected sign-out in the account menu shows the error instead of an unhandled
  rejection.

## [12.10.0] - 2026-10-22

Needs `@oxy.so/core` 6.12.0.

### Changed

- The file manager lists a `lost` file (ADR 0043 D13) as lost: an offline icon
  and "Lost — its contents could not be recovered" instead of a broken
  thumbnail, no preview or download, and its remove action deletes it (nothing
  is left to put in trash). It is left out of the photos, videos and audio
  views, which show media.

## [12.9.0] - 2026-10-22

Needs `@oxy.so/contracts` 5.6.0.

### Added

- `useAccountColorSave` and `entitledAccountColors` from `@oxy.so/services/ui/client`:
  the account-colour picker's data and write. `colors` is what this account may
  wear (free presets, the one named after its handle, `mono` with its benefit —
  from the contract's gate table), `saveColor` writes `color` and
  `themePreference.colorPreset` in one `updateMe`, and the Bloom theme follows.
  An app renders the select; it keeps no colour state of its own.

## [12.8.0] - 2026-10-21

Needs `@oxy.so/core` 6.11.0.

### Changed

- The follow stores and hooks hold a stable `FollowErrorCode` instead of
  English text: `useFollowTarget().error`, `useFollow().error` /
  `followData[id].error`, `useFollowForButton().error` and the `errors` maps of
  `useFollowTargetStore` and the follow store. A server refusal keeps the
  server's code and status (`offline`, `signed_out`, `forbidden`, `not_found`,
  `rate_limited`), never its message; anything else names the action
  (`read_failed`, `update_failed`, `mode_failed`).
- `FollowButton` and `FollowTargetButton` word every failure through one
  mapping onto core's `follow.errors.*` strings, in the app's language. The
  single-user `FollowButton` now shows that toast when a follow is refused,
  instead of failing silently.
- A signed-out follow from `useFollow` rejects with `OxyAuthenticationError`.

### Added

- `useFollowErrorMessage()` and the `FollowErrorCode` type, for an app that
  renders a follow hook's `error` itself.

### Removed

- The English fallbacks "Could not follow", "Could not unfollow", "Could not
  read follow status", "Failed to update follow status" and friends.

## [12.7.0] - 2026-10-21

### Added

- `useAccountColor` (and `resolveAccountColor`) from `@oxy.so/services/ui/client`:
  one hook that applies the account's colour (`user.color`, falling back to
  `themePreference.colorPreset`) to the Bloom theme, so every Oxy app wears the
  same colour instead of each re-deriving it. The API already refuses `oxy` and
  `faircoin` to any other handle and `mono` without its benefit, on both
  fields. An app with a plan of its own passes `canUse` to withhold a name.

## [12.6.0] - 2026-10-21

Needs `@oxy.so/core` 6.4.0.

### Added

- `FollowButton` (single-user mode) takes `verb` (`follow` | `subscribe` |
  `join` | `watch`) and `labels`, as `FollowTargetButton` does: a fediverse
  community reads "Join"/"Joined". Its accessible name, hint and checking line
  follow the verb ("Joined @fediverse", "Leaves @fediverse").
- `FollowButtonProps`, `SingleFollowButtonProps` and `MultiFollowButtonProps`
  are exported from `@oxy.so/services/ui/client` too.

### Changed

- Both follow buttons read their words from core's `follow.*` strings, in the
  app's language, instead of English literals; the "Follow all" button's
  default labels and hints too. `FollowVerb` and `FollowLabels` keep their
  public names and entry points.
- `FollowTargetButton`'s menu, options button, timed-follow toast and default
  durations are translated too, and its "everywhere" line follows the verb
  ("Leave everywhere"). The default durations are read at render, so a
  `durations` prop still replaces them. Both buttons' error-toast fallback is
  translated.
- `buildFollowMenuItems` takes optional `verb` and `t` (`useI18n().t`); without
  `t` the menu is English, as before.
- A `FollowDuration.label` is used as written, inside the sentence ("Follow
  for a week"); it is no longer lowercased, which broke languages that
  capitalize nouns. Pass it in sentence case.
- The "Follow all" hint for one account reads "Follows 1 account" rather than
  "Follows all 1 account".

## [12.5.0] - 2026-10-21

Needs `@oxy.so/core` 6.3.0.

### Changed

- Create account, account settings and the profile name editor validate a name
  with `isValidAccountName` for the account's kind: a project, bot or channel
  title takes digits and punctuation like an organization's, and a person's
  name keeps the person policy.

## [12.4.0] - 2026-10-19

Needs `@oxy.so/core` 6.1.0.

### Added

- `SignInSecurity` route and `OxySignInSecurityPanel`: one page with every way
  the account signs in (email, password, authenticator app, Commons) and its
  sessions. "Manage your account" opens it from a single "Sign-in & security"
  row.
- `SignInEmail` route and `OxyEmailPanel`: add, change or remove the email
  (removing only with a password set, confirmed with it).
- `OxyPasswordPanel` can remove the password while the account has an email.
- `ReauthStep` takes `allowEmail`; an account without an email confirms with
  its password.

### Fixed

- The security panels show an error with a retry, or "personal accounts only"
  for an organization, project or bot, instead of loading forever.
- Linking Commons waits for the account's sign-in methods before asking for
  the proof, so an account with an authenticator is always asked for its code.
- "Manage your account" no longer has a "Security settings" row that opened
  the privacy screen.

## [12.3.0] - 2026-10-19

### Added

- `@oxy.so/services/ui/client` exports the data hooks product screens need:
  `useUploadFile`, `useUploadAvatar`, `useFileDownloadUrl`,
  `useMutationStatus`, `useOnlineStatus`, `useDisplayCurrency`,
  `useDisplayPrice` and `DisplayCurrencySelector`. They were root-only, so a
  screen that uploaded a file or showed a price in the viewer's currency
  imported the root barrel and shipped every account screen in first paint
  (mercaria.co's review upload: ~225 KB gzip). None of them reaches a screen;
  `clientEntryIsolation.test.ts` pins both the exports and the isolation.

## [12.2.1] - 2026-10-19

### Added

- `@oxy.so/services/ui/client` exports `useOxyEvent` and `useUpdateProfile`.
  They were root-only, so an app whose startup code listens for realtime
  events or updates the profile (Inbox's socket hook and locale provider) had
  to import the root barrel and ship every account screen in first paint.

### Fixed

- `@oxy.so/services/ui` and `@oxy.so/services/ui/client` tell `@oxy.so/core`
  the platform, as the root entry always did. Only the root barrel called
  `setPlatformOS(Platform.OS)`, so on iOS and Android an app that imported only
  a lean entry (and every app whose only services import is
  `@alia.onl/sdk` 21.5's `ui/client`) left core answering `'unknown'`:
  `isNative()`, `isIOS()` and `isAndroid()` were false, the shared identity key
  was not read, and the Commons session fallback was off. The three client
  entries now import `registerPlatform` first; `cryptoPolyfillOrder.test.ts`
  fails if one stops (that import also evaluates core, and its crypto polyfill,
  before anything else in the lean entries). Web was unaffected (core detects the DOM).

## [12.2.0] - 2026-10-19

### Changed

- `@oxy.so/services/ui` no longer imports the account screens. Since 11.15.0 it
  registered all of them at import, so every app (or SDK) that imported anything
  from `ui` carried the screens in its first-paint bundle and lost the separate
  screen chunk (Allo: +340 KB gzipped, 56 screen modules in the entry). `ui`
  now loads them like `ui/client`: `OxyProvider` fetches the screen chunk at
  startup, and a surface opened before it arrives waits for it. The root
  `@oxy.so/services` entry still registers them synchronously.
  `screenBarrelIsolation` fails if `ui` or `ui/client` statically reaches a
  screen module or `screenComponents`, and `clientEntryIsolation` holds
  `ui/client` to no file under `ui/screens/` and to exporting `useAppAssertion`.
- No image the SDK draws on iOS or Android goes through react-native's `Image`
  any more, so an app may turn Android's GIF/WebP decoders off
  (`expo-build-properties` `android.gifEnabled`/`webpEnabled: false`) and still
  show and measure a user's GIF or WebP. `FileViewer`, `JustifiedPhotoGrid` and
  the avatar crop screen measure an image's size through expo-image
  (`Image.loadAsync`, reported in pixels like `Image.getSize`; a failure still
  falls back as before); the avatar crop stage, profile link previews and the
  Oxy One artwork draw with expo-image. Web keeps react-native-web's
  `Image.getSize`, an `<img>` probe that needs no CORS headers. expo-image was
  already a required peer; no peer range changes.
- `__tests__/packaging/rnImageBoundary.test.ts` fails if any source file other
  than the web measurement fork names react-native's `Image`,
  `ImageBackground` or Reanimated's `Animated.Image` again.

### Fixed

- On web, `OxyProvider` no longer turns a page that scrolls into a huge bottom
  safe-area inset. react-native-safe-area-context 5.9 and later (SDK 58 ships
  5.10.1) measure the web provider's own element and report
  `windowInsets.bottom - (innerHeight - rect.bottom)` without clamping it, and
  `OxyProvider` wrapped the whole document in one: an 844px phone viewport over a
  2690px page got a ~1850px inset, and the mobile account dialog rendered empty.
  On web the provider's root now gives the window's metrics instead (CSS
  `env(safe-area-inset-*)` insets, the viewport as the frame), which is what every
  version before 5.9 reported. iOS and Android still mount `SafeAreaProvider`.
  `SafeAreaRoot.test.tsx` holds both, and fails if another source file mounts
  `SafeAreaProvider` directly.

## [12.1.0] - 2026-10-19

### Added

- `@oxy.so/services/ui/client` exports `useAppAssertion`,
  `AppAssertionProviderMissingError` and their types. `@alia.onl/sdk` read
  `useAppAssertion` from `/ui`, whose import registers every account screen, so
  an app that kept to the lean entry still had all of them (and Bloom's phone
  flags, date picker and plan cards) in its startup bundle through the SDK.

## [12.0.0] - 2026-10-19

### Removed

- `ProfileButton`'s `onNavigateManage` prop and the `onNavigateManage` field of
  `AccountDialogConsumerHooks`. "Manage your Oxy account" in the account dialog
  always opens the SDK's `ManageAccount` screen. Apps used the override to send
  that button to their own settings, which is not where an Oxy account is
  managed. Delete the prop; `onAddAccount`, `onNavigateProfile`, `menuItems` and
  `menuSections` are unchanged.

## [11.17.0] - 2026-10-19

### Added

- `@oxy.so/services/ui/client` exports `FollowTargetButton` (with
  `FollowTargetButtonProps`, `FollowVerb`, `FollowLabels`) and `useSupervision` /
  `supervisionQueryKeys`. The root and `/ui` entries register every account
  screen at import, so the lean `/ui/client` entry is how an app keeps its
  startup bundle small; these were the exports apps still needed the root for.

### Fixed

- `useUsernameAvailability` and `EditProfileFieldScreen` validate with
  `usernameCheck` from `@oxy.so/contracts/client` instead of `usernameSchema`
  from the root barrel. Since 11.15.0 those two imports put all of
  `@oxy.so/contracts` (and its zod) in every app's web bundle — about 360 KB
  raw — and pushed CrowdSource, Homiio and Allo over their bundle budgets. A
  packaging test refuses a runtime import from the root barrel in `src/`.

## [11.16.1] - 2026-10-19

### Fixed

- `useCurrentUser` (mounted by `OxyProvider`) re-reads `GET /users/me` when the
  app returns to the foreground or the tab back into view, at most once per its
  one-minute `staleTime`, instead of following the app-wide
  `refetchOnWindowFocus: false`. It is the only read of the owner's own
  preferences — the device projection resolves profiles through the public
  directory, which carries no `languages` — so languages reordered on another
  device reached an open app only after a restart.

## [11.16.0] - 2026-10-19

### Changed

- The `@oxy.so/core` peer admits 6.x as well as 5.x (`^5.5.0 || ^6.0.0`). Core
  6.0.0 removes only `OxyInferenceClient.decide()` and
  `getGenerationRecordByIdempotencyKey()`, which this package never used.

## [11.14.1] - 2026-10-17

### Fixed

- The config plugins (`withOxySharedPermissions`, `withSharedDeviceSessionProvider`)
  import `expo/config-plugins`, the app's own Expo SDK copy, and this package no
  longer depends on `@expo/config-plugins`. 11.14.0 pinned it exactly at 58.0.9,
  so in every Expo SDK 56 and 57 app that SDK-58 copy was hoisted to the top of
  `node_modules` and Expo's own copy nested under it, leaving a native prebuild
  one config-plugins major away from the app's SDK. `expo` was already a peer
  (`>=56.0.0 <59.0.0`); nothing else changes.

## [11.14.0] - 2026-10-17

Supports Expo SDK 58 (React Native 0.88, React 19.3) as well as SDK 56 and 57.
Same `@oxy.so/core` and `@oxy.so/contracts`.

### Changed

- Peers admit Expo SDK 58: `expo`, `@expo/app-integrity`, `expo-constants`,
  `expo-document-picker`, `expo-file-system`, `expo-haptics`,
  `expo-image-manipulator`, `expo-image-picker`, `expo-linear-gradient`,
  `expo-notifications` and `expo-web-browser` are `>=56.0.0 <59.0.0`,
  `expo-image` `>=2.0.0 <59.0.0`, `expo-modules-core` `<59.0.0`,
  `react-native` `>=0.85.0 <0.89.0`, and `react-native-gesture-handler`
  `>=2.31.1 <4.0.0` (SDK 58 ships 3.3). The gesture code (`GestureHandlerRootView`,
  the `Gesture.Pan`/`Pinch`/`Simultaneous` builders and `GestureDetector`) is
  unchanged: Gesture Handler 3 keeps that API beside its new hooks.
- Compiles under React Native 0.88's strict TypeScript API: the file browser's
  `ScrollView` refs are typed `ComponentRef<typeof ScrollView>` (the class
  instance before 0.88, the `ScrollViewInstance` after it), and the
  pull-to-refresh handlers no longer hand a query's `refetch` promise to
  `RefreshControl.onRefresh`. No runtime change.

## [11.13.0] - 2026-10-17

### Changed

- The `@oxy.so/core` peer admits 5.x as well as 4.x (`^4.21.0 || ^5.0.0`).
  Core 5.0.0 removes only the retired present-requester assertion calls (oxy
  ADR 0042), which this package never used.

## [11.12.0] - 2026-10-16

Needs `@oxy.so/core` 4.21.0 (and so `@oxy.so/contracts` 4.24.0) and the Oxy
API with ADR 0043 stage 4c.

### Changed

- The `@oxy.so/core` peer is `^4.21.0` (it was `^4.20.0`): "Apps with access"
  calls `oxy.assets.listAppAccess` / `revokeAppAccess`, which 4.21.0 adds.

### Added

- **Apps with access** in a file's details (ADR 0043 stage 4c), for the
  owner: the applications that can open the file on their own — one that
  stored it for the person ("Stored this file for you") or one the person
  shared it with ("You shared it") — with their icon, each revocable behind a
  confirmation that names the app and says playback it started stops
  (`oxy.assets.listAppAccess` / `revokeAppAccess`; the row leaves at once and
  comes back if the revoke fails; the list is cached under `files.all`, so a
  library invalidation refreshes it). Every string in all eleven locales
  (`fileManagement.appAccess.*`).

## [11.11.0] - 2026-10-16

Needs `@oxy.so/core` 4.20.0 (and so `@oxy.so/contracts` 4.24.0), and a native
build that includes `@expo/app-integrity` for iOS and Android app assertions.

### Added

- App assertions (ADR 0045): `OxyProvider` obtains this app's Oxy-signed
  `OXY-APP+JWT` for the signed-in session and refreshes it a minute before it
  expires; a session change drops it. The web proves itself with the browser's
  `Origin`; iOS with App Attest and Android with Play Integrity, through
  `@expo/app-integrity`. No app code handles the proof.
- `useAppAssertion()` → `{ status, assertion, applicationId, platform,
  expiresAt, error, getAppAssertion(), getAppAssertionHeaders() }`, for a
  service that needs to know the app (Alia): attach
  `await getAppAssertionHeaders()` (`X-Oxy-App-Assertion`) to the request.
- Peer `@expo/app-integrity` `>=56.0.0 <58.0.0`. It is loaded lazily, so a
  binary built without it (an over-the-air update onto an older build) still
  boots and simply has no assertion (`status: 'unsupported'`).

## [11.9.0] - 2026-10-16

Needs `@oxy.so/core` 4.18.0 (and so `@oxy.so/contracts` 4.22.0).

### Changed

- The `@oxy.so/core` peer is `^4.18.0` (it was an exact version, a leftover
  of the Oxy One prerelease pin), and `@oxy.so/contracts` is a caret
  dependency (it was exact): a later core or contracts 4.x minor no longer
  conflicts with this release or nests a second copy in the app. Core 5 is
  still refused until it is measured here.

### Added

- The file manager marks a file no application uses "Not in use" (ADR 0043
  D5; informational, nothing is removed for it) and one taken down after a
  content claim "Removed after a legal claim" (D10; served to nobody).
- Removing an asset's last link no longer marks it trashed in `assetStore`,
  which matches a link by `applicationId` (falling back to `app`).
- **Trash** in the file manager (ADR 0043 D5). "Delete" on a file, in the
  viewer and for a selection, now MOVES IT TO TRASH (`oxy.assets.trash`): it
  stops being shown anywhere and can be restored. A new `FileTrash` route —
  opened from the trash button beside upload — lists the trash (most recently
  trashed first, with the date), restores a file (`oxy.assets.restore`) and
  deletes one permanently after a confirmation; when apps still use it the API
  refuses and the person is asked again before the delete is forced. A file
  removed after a legal claim cannot be trashed, so removing it stays the
  permanent delete. The library no longer lists trashed files (needs the API
  and `@oxy.so/core` 4.18.0 `assets.list({ status: 'trash' })`). Every string
  is translated in all eleven locales; the viewer's "Delete" button, which
  was English-only, now is too. `queryKeys.files.trash(ownerId)` is the trash
  list's cache key, under `files.all`.

## [11.8.0] - 2026-10-16

Needs `@oxy.so/core` 4.17.0 (exact peer) and `@oxy.so/contracts` 4.21.0.

### Added

- Supervision (ADR 0041): `SupervisionScreen`
  (`showBottomSheet({ screen: 'Supervision', props: { approvalId?, childAccountId? } })`),
  `useSupervision`, and its entries in Manage Account and Create Account (the
  personal-root option). Guardians review purchase approvals line by line with
  fresh reauthentication; children read their own.

## [11.7.0] - 2026-10-16

Needs `@oxy.so/core` 4.15.0 (exact peer) and `@oxy.so/contracts` 4.19.0. No
source change: the peer moves so an app can take core's
`accounts.accessFor` and `assets.uploadLarge` (4.14.0) and application roles
(`requireAppPermission`, 4.15.0) without nesting a second core. 11.7.0 was
never published with the 4.14.0 peer; it is cut from the commit that carries
core 4.15.0.

## [11.6.0] - 2026-10-16

Needs `@oxy.so/core` 4.13.0 (and so `@oxy.so/contracts` 4.17.0).

### Changed

- The provider no longer puts the identity stack in an app's startup
  JavaScript: `KeyManager`, `SignatureService` and `deriveIdentityLinkCode` load
  from `@oxy.so/core/crypto` with `import()` where a key is read or a signature
  made (`ui/utils/identityCrypto.ts`).
- Application classification, the sign-up email, organization forms and the
  username field check with `@oxy.so/contracts/client` instead of the Zod
  schemas (same verdicts, outputs and messages), so services ships no Zod.

## [11.5.0] - 2026-10-15

Needs `@oxy.so/core` 4.10.0. (11.4.0 is #1721's.)

### Added

- One email, several accounts (ADR 0040): after the code or the link proves an
  email that holds several accounts, the sign-in panel lists them
  (`OxyEmailAccountChoice`, name, `@handle` and avatar) and signs in the one
  chosen; its authenticator still applies. A username signs in only its
  account, as before.
- The sign-up panel names `EMAIL_ACCOUNTS_FULL`.
## [11.3.1] - 2026-10-15

Needs `@oxy.so/core` 4.9.1.

### Fixed

- A web origin with nothing to restore (no warm token, no device secret, no OAuth
  return on the URL) resolves auth signed out at once instead of waiting for the
  application classification round trip, which cannot change that outcome. The
  classification still runs, and every boot with something to restore, every
  native and identity-mode boot, and every later sign-in still waits for it.
  Measured on a cold load against `api.oxy.so`: auth resolved 2.08 s to 0.75 s after
  navigation, and the first request after it starts 1.36 s sooner.

## [11.2.0] - 2026-10-14

Promoted from `11.2.0-oxy-one.7` to the stable release; no code change. It is the first
stable Services that admits Bloom 8, 9 and 10 (the Bloom 10 peer is open-ended) and it
needs `@oxy.so/core` 4.5.0. The `oxy-one` entries below are the candidate history.

## [11.2.0-oxy-one.7] - 2026-10-14

### Changed

- The Bloom 10 peer range is open-ended, `>=10.0.0`, instead of the
  `10.0.x` window. Bloom 10.1 and 10.2 (latest 10.2.1) were refused by the window, so
  an app on current Bloom could not install this package without a peer conflict, and
  Bloom 9 for `@alia.onl/sdk` 11 and Bloom 10 could not be reconciled by any app.
  Verified against the official 10.2.1 package as the one Bloom resolution: types and
  all 115 suites / 1050 tests pass. Deliberately uncapped, by decision: Oxy apps always run the latest Bloom, so a
  new Bloom release must never need a Services release first. A Bloom release that
  breaks Services is caught by running this package's suite against Bloom `latest`.

## [11.2.0-oxy-one.6] - 2026-10-14

### Changed

- Admits `@oxy.so/bloom` 10.0.x (peer range `>=10.0.0 <10.1.0`, beside the earlier lines),
  verified against the official 10.0.0 package as the one Bloom resolution: types and all
  115 suites / 1050 tests pass. Bloom 10 turns an avatar into one flat character and removes
  `AvatarConfig` from `agent-avatar`; this package imports nothing from that family.

## [11.2.0-oxy-one.5] - 2026-10-13

### Changed

- Admits `@oxy.so/bloom` 8.1.x and 9.0.x (peer ranges `>=8.0.0 <8.2.0` and
  `>=9.0.0 <9.1.0`), verified against the official 8.1.1 package and the packed
  9.0.0 release candidate: types and all 115 suites / 1050 tests pass with each
  as the one Bloom resolution, and still with the 6.2.1 catalog.
- The three trust screens ask Chip for `size="sm"` instead of `"small"`. Bloom
  9.0 removed the long spellings; `sm` is accepted by every admitted line.

## [11.2.0-oxy-one.4] - 2026-10-12

### Fixed

- An app without the optional peer `expo-clipboard` bundles on Android and iOS
  again. `copyText` loaded it with an `import()` outside any `try`, which Metro
  resolves at build time, so `expo export --platform android` failed with
  `Unable to resolve module expo-clipboard` for every app that renders
  `OxyProvider` without it. The load is now a direct statement of a `try`
  block, the shape Metro marks optional; without the package, copying rejects
  and the caller reports that nothing was copied. A new packaging test holds
  every optional-peer load to that shape. `expo-notifications` already had it
  and is unchanged. Same fix as 11.1.18.

### Changed

- Admits `@oxy.so/bloom` 7.32.x and 7.33.x (peer cap `<7.34.0`), verified
  against the official 7.32.0 and 7.33.0 packages.
- Admits `@oxy.so/bloom` 8.0.x. Bloom 8.0.0's one break moves
  `LinkPreviewCard` off the root barrel to `@oxy.so/bloom/link-preview`, which
  this package does not import.

## [11.2.0-oxy-one.3] - 2026-10-10

### Changed

- Admits `@oxy.so/bloom` up to 7.31.x, so an app on Bloom 7.31.0 (whose
  `video-view` makes web video play inline on iPhone Safari) shares one Bloom
  runtime with this package instead of nesting a second copy under it. Also
  carries the Bloom 7.21–7.30 peer lines admitted since 11.2.0-oxy-one.2. No
  runtime source changes.

## [11.2.0-oxy-one.2] - 2026-10-10

### Fixed

- File uploads no longer fail at 5s with `Request timed out after 5000ms`: the
  peer `@oxy.so/core` moves to 4.5.0-oxy-one.1, whose `assets.upload` allows
  10 minutes. Also carries the Bloom 7.13.1–7.20.x peer lines admitted since
  11.2.0-oxy-one.1.

## [11.0.0] - 2026-09-30

Android apps no longer share the `so.oxy.shared` UID (OxyHQ/oxy#1388). They
share the identity and the device session with Commons (and Accounts) over
signature-protected ContentProvider `call()` IPC instead, the way apps use
`AccountManager`. Commons is the only holder of the identity private key. iOS
is unchanged.

### Breaking changes

- New plugin `@oxy.so/services/plugins/withOxySharedPermissions`, required in
  EVERY Oxy Android app (`@oxy.so/app-preset` 3 applies it): declares and
  requests the signature-level `so.oxy.permission.IDENTITY` and
  `so.oxy.permission.DEVICE_SESSION`, and adds `<queries>` for
  `so.oxy.commons[.dev].identity`, `so.oxy.commons[.dev].devicesession` and
  `so.oxy.accounts[.dev].devicesession`. Never declare `android:sharedUserId`.
- Removed `plugins/withSharedIdentityProvider`, `withSharedIdentityReader` and
  `withSharedDeviceSessionReader`, the `OxyIdentityProvider`/`OxyIdentityStore`
  native classes and the `oxy_shared_identity` file. The raw-key export
  (`getShared`/`putShared`/`hasShared`/`clearShared`) is gone.
- The `OxyIdentity` native module is a client of Commons' identity host:
  `describe`, `proveIdentity`, `deriveScopedSeed`, `signSocialReceive` (the iOS
  stub resolves `nil`). Use it through `@oxy.so/core` 4.
- `withSharedDeviceSessionProvider` (hosts only: Commons, Accounts) declares no
  permission any more and guards the provider with `so.oxy.permission.DEVICE_SESSION`.
- Requires `@oxy.so/core` ^4.0.0.

### Changed

- The device-session provider answers `read`, `write` and `clear`, and checks
  the caller itself: the package comes from `Binder.getCallingUid()` and must be
  an allow-listed Oxy app signed with the host's certificate
  (`hasSigningCertificate` on API 28+, `checkSignatures` below).
- `OxyDeviceSession`: a host app reads and writes its own store; every other
  app sweeps the hosts (Commons, then Accounts) to read and publishes to every
  installed host, and keeps no copy of its own. A publish succeeds only when no
  installed host is left holding an older credential: a host that refuses the
  write is cleared, so the sweep never hands out a stale secret.
- Comments that said UID members share one data directory are corrected: each
  package always had its own; only the Keystore was shared.

## [10.0.0] - 2026-09-29

### Breaking changes

- Requires Bloom ^6.0.0 and migrates SDK UI to canonical appearance, tone and size props.
- FollowButton and FollowTargetButton size now uses sm, md (default), or lg. Replace small, medium and large respectively.
- Preserves account, sign-in, payment and action-sheet behavior, including destructive actions and accessible follow state.

## [9.2.0] - 2026-09-28

### Added

- `@oxy.so/services/ui/client` exports the query, cache and follow helpers an
  app uses at startup: `queryKeys` and the `invalidate*Queries` helpers,
  `upsertCachedUser(s)`, `CLEARABLE_USER_FIELDS`, `clearedFieldsFrom*Update`,
  `useUserProfile(s)`, `useCurrentUser`, `useUserById`, `useUserByUsername`,
  `useFollowerCounts`, `useSeedFollowStatuses`, `useFollowTarget`, the follow
  rules (`resolveFollowPrimaryAction`, `buildFollowMenuItems`,
  `FOLLOW_ACTION_LEAVES_ACTIVE`) and `ProfileButton`. Import them from here
  rather than the root: the root barrel re-exports the sign-in panels (and the
  Commons QR encoder), and Metro does not tree-shake, so any root import ships
  them all, ~140 KB on Mention's home route. A packaging test pins that
  `ui/client` reaches no panel.
- `FollowMenuItem` is exported (the return type of `buildFollowMenuItems`).

### Changed

- The follow rules live in `ui/components/followRules.ts`, free of React and
  Bloom; `FollowTargetButton` imports them. Root exports are unchanged.

## [9.1.0] - 2026-09-28

### Added

- `accountQueries.roots: 'all'`: every query the app runs belongs to the
  signed-in account, for an app whose every read may depend on who is signed
  in (Syra), so no root can be forgotten and survive an account switch. The
  roots `accounts`, `sessions` and `devices` are reserved for the SDK's
  device-level data.

### Fixed

- A restore still in flight when the account changes can no longer hydrate
  the previous account's rows: the account is re-checked in the same tick as
  the hydrate.
- Switching accounts writes the leaving account's latest state first (it
  used to be lost inside the 1 s write throttle); a sign-out then deletes it,
  also when it happens before storage is ready.
- A new build drops persisted queries but keeps queued (paused) mutations, in
  both SDK caches: a deploy no longer loses an action the user made offline.
- Account-declared roots are kept out of the shared cache even when they sit
  under one of the SDK's own prefixes.
- The account cache stops with the provider that owns it (`attach`/`detach`,
  StrictMode-safe).
- SDK queries that carry signed URLs (`assetDownloadUrls`, `avatarCropSource`,
  `avatarCropMeasure`, `justifiedPhotoDimensions`) are never written to an
  account cache, whatever the app declares.

## [8.4.0] - 2026-09-28

Requires `@oxy.so/bloom` ^4.35.0 and `@oxy.so/core` ^3.2.0.

### Added

- Every password field has an eye button that shows and hides the password:
  the sign-in password step, "Confirm it's you", and the new/repeat fields
  when setting a password (Bloom `TextFieldInput revealable`). Pressing it
  leaves focus in the field.
- `OxyProvider` sets Bloom's locale (`@oxy.so/bloom/locale`) to Oxy's
  language (`currentLanguage`), so Bloom's own words ("Show password",
  "Close", "Step 2 of 3") follow the account. The nearest provider still wins:
  a `LocaleProvider` or `BloomProvider locale` that the app mounts above
  `OxyProvider` is kept, and one inside it overrides for its subtree.
- Sign-up shows its three steps (username → email → code) as a Bloom
  `WizardProgress` under each header. Setting up the authenticator shows two
  (scan and confirm → backup codes).
- Deleting an account without a key asks once more ("Delete Forever", a
  destructive Bloom confirm) after the code is typed and before anything is
  sent. Declining keeps the screen and the code.

### Changed

- The wait after too many attempts (429) is a warning notice (Bloom
  `Admonition`) above the action it holds back, counting down. It is no
  longer the field's error. "We sent a new code", "We sent a 6-digit code to
  your email", the delete-account warning, and "This account uses Commons:
  delete it in Oxy Commons" are notices too.
- The backup codes are a Bloom `CodeBlock`, headed by their count, one code per line, with its own
  copy button named "Copy codes". A refused copy says so and leaves the copy
  glyph in place.
- Copying (backup codes, the payment address, App info) uses the browser
  Clipboard API on the web and `expo-clipboard` on iOS and Android.
  `expo-clipboard` is a new OPTIONAL peer: without it, a copy on native
  reports "Failed to copy to clipboard". React Native's deprecated
  `Clipboard` is no longer used.
- Subordinate links ("Send a new code", "Use your password instead", …) are
  Bloom `LinkButton`s in the secondary tone, underlined under a pointer.
- The account picker's activating row shows Bloom's animated `SpinnerIcon`
  instead of a static glyph, and the current account's check sits in the
  Bloom `Avatar`'s own `verified` slot. The loading states of the sign-in screens, the
  Commons QR, linking Commons, a request being prepared, and a route still
  loading use Bloom `Loading`/`SpinnerIcon` instead of React Native's
  `ActivityIndicator`.
- "Sign out everywhere else" (setting a password) is a Bloom `Field` that
  names its switch.

## [8.3.0] - 2026-09-28

### Added

- `OxyProvider`'s `accountQueries` (`AccountQueriesConfig`): an app declares
  the query roots that hold the signed-in account's private data (`roots`,
  persisted; `memoryOnlyRoots`, never written to disk) and the mutation keys
  whose paused instances replay after a restart (`mutationKeys`). The SDK
  stores them per account (`oxy_account_queries:<accountId>`), drops them from
  memory synchronously on an account switch, deletes the signed-out account's
  on sign-out, and restores the signed-in account's before `RequireOxyAuth`
  renders its children (`useOxy().isAccountCacheReady`). Works with the SDK's
  client or one passed as `queryClient`. Apps no longer scope a persister to
  the session themselves.

### Changed

- Every persisted query cache the SDK owns is busted by the build
  (`process.env.OXY_BUILD_ID`, inlined by `@oxy.so/app-preset` 2.1's Babel
  config): a cache written by an older bundle, in an older shape, is never
  served. Without the preset the id is a constant, as before.

## [8.2.0] - 2026-09-27

### Changed

- Every one-time code in the sign-in and account screens is Bloom's
  `InputOtp` (one box per character), named by its `Field` label: the
  sign-in "Check your email" code, the second step's authenticator code and
  backup code, the sign-up email code, "Confirm it's you" (email code and
  authenticator code) and the authenticator set-up code. The sign-in, sign-up
  and second-step codes submit themselves once every box is filled; the
  confirm-it's-you and set-up codes still wait for the screen's own action.
- "Check your email" is six digit boxes. "Does your code have letters?" turns
  it into ten characters in two groups of five for the long code an account
  past its daily guessing ceiling is sent (`XXXXX-XXXXX`; a pasted code with
  its dash fills every box), and "Is your code only numbers?" turns it back.
  The choice survives a remount of the dialog (`signInFlowStore`).
- A backup code is ten characters in two groups of five, in the second step
  and now in "Confirm it's you" too, which gains the same "Use a backup code"
  / "Use your authenticator app" switch instead of one field for either.
- Requires `@oxy.so/bloom` `^4.31.0` (`InputOtp type="alphanumeric"`) and
  `@oxy.so/core` `^3.1.0` (the new strings).

### Removed

- `formatSignInCodeInput` (internal): the field cleans what is typed.

## [8.1.1] - 2026-09-27

### Changed

- Published against `@oxy.so/contracts` 4.x: 8.1.0 required `^3.0.0`, so
  every app on contracts 4 installed a second, nested contracts 3.x (+925 KiB
  in a web bundle). No code change.

## [8.1.0] - 2026-09-27

### Changed

- `OxyAccountPicker` ("Choose an account") is one rounded list: each row is the
  account's name and `@handle` on the left, its avatar (with a check on the
  current account) and a chevron on the right, with a hairline between rows
  that steps aside for a hovered row; "Use another account" is the list's last
  row. Built with NativeWind classes; scrolls past 384px.

### Removed

- `AccountRow` (internal), which only the picker used.

## [8.0.0] - 2026-09-26

Built on `@oxy.so/core` 3.0 (namespaced client, `OxyServer`, subpath entries).

### Changed

- **Breaking:** requires `@oxy.so/core` ^3.0.0. `useOxy().oxyServices` is the
  namespaced client — `oxyServices.users.get(id)`, `oxyServices.assets.upload(file)`,
  … Run core's codemod (`scripts/codemods/core-3/codemod.ts`) over the app.
- `OxyProvider` builds its client with the SDK response cache off: React Query
  owns caching and deduplication, and two caches served stale data after an
  invalidation.
- Privacy settings, Trust center, Trust rewards, Trust rules and search
  settings read through React Query instead of fetching on every mount; the
  Trust center no longer refetches when an unrelated profile field changes.
- "Download your data" saves the signed export (`identity.export()`).
- Translations re-render when a lazily loaded language arrives.

### Added

- A Domains screen in Manage account: verify a domain by DNS TXT record or
  `.well-known` file, list and remove verified domains.

### Removed

- The Saves & collections, FAQ, Feedback and Premium subscription screens, and
  the profile stats: their API routes never existed, so they could only fail or
  show mock data.
- The `oxyClient` singleton mirroring.

## [7.0.0] - 2026-09-26

Requires `@oxy.so/core` ^2.2.0 and `@oxy.so/contracts` ^3.0.0 (passkeys are
removed from the whole platform, ADR 0030).

**Sign-in happens in the dialog, by email** (the plan "Oxy sin passkeys", PR 2
of 4): no passkey, and no auth.oxy.so window except the browser bridge.

### Changed

- `OxySignInPanel` is a sequence of steps, in the dialog of every app (web and
  native) and on auth.oxy.so's `/login`: an email or username → "Check your
  email" (one field takes the 6-digit code or the 10-character `XXXXX-XXXXX`
  code and submits itself once complete; meanwhile the screen asks every 2 s
  whether the email's link was opened in this browser, and signs in when it
  was; "Send a new email" after a 30 s cooldown) → optionally "Use your password
  instead" (with "Forgot it? Get a code by email") → the authenticator's code,
  or a backup code, when the account has one. Errors are inline and never say
  whether an account exists; a 429 counts down. The web split card with the
  Commons QR stays (the QR on the first step only), and "Continue with Oxy"
  stays on top on native and below `md`.
- `OxySignUpPanel` creates the account in place on every platform — username
  (availability checked) → email → its code → signed in — with "Create it in
  Commons instead". Props: `{ onSignedIn, onSignIn }`.
- `OxyDeleteAccountPanel` deletes an account without a key with a code by email
  (+ the authenticator's code), and says where to go for a keyed account.
  `OxyLinkCommonsPanel` confirms the link with a code by email (+ the
  authenticator's). Both are for the account's settings, not auth pages.
- "Manage your account" opens the `DeleteAccount` panel for an account without a
  key (and on the web), and lists Password, Authenticator app and Link Commons
  for it.
- The request view's "Having trouble?" no longer offers a passkey.
- In the account dialog the sign-in and sign-up step survives the surface's
  breakpoint remount (bottom sheet below `md`, centered card from `md`): it is
  kept per dialog in memory while the dialog is open and dropped when it closes.

### Added

- `OxyPasswordPanel` (set or change the password) and `OxyAuthenticatorPanel`
  (set up an authenticator app from its QR and setup key, backup codes shown
  once with "Copy codes", new backup codes, turn off), each confirmed with a
  code by email or the current password (+ the authenticator's code).
- Routes `DeleteAccount`, `LinkCommons`, `SignInPassword` and
  `SignInAuthenticator` for `showBottomSheet`.
- `useSignInMethods()` — `GET /users/me/sign-in-methods`.

### Removed

- `useOxy().continueOnAuth`, `signInWithPasskey`, `addPasskey`,
  `removePasskey`; `useAuthMethods().passkeys`; `OxyCreateAccountPanel` and
  `OxyRecoverAccountPanel` (recovering an account is signing in with a code);
  `OxySignInPanelProps.onRecover`; the `@simplewebauthn/browser` dependency.
- The native delete-account handoff no longer tells a keyless account to delete
  itself on auth.oxy.so: it deletes with an emailed code in the dialog.

## [6.3.0] - 2026-09-26

### Added

- One browser, one session (ADR 0029 D2): the first time a person opens the
  account dialog on the web in an app that holds no device credential, the
  provider opens `auth.oxy.so/bridge` from that press — a window as small as the
  browser allows that joins the app to the browser's device and closes at once.
  If the browser is already signed in, the app is signed in and the dialog
  closes; otherwise the dialog's sign-in carries the device proof, so the
  account is shared with every Oxy app in that browser. Never on page load, on
  auth.oxy.so itself or with `sessionMode: 'identity'`; a blocked window only
  means the app signs in on its own device, as before. Native is unchanged.
- `OxyProvider` wires `OxyServices.setDeviceCredentialProvider` from its store
  on the web, so every sign-in proves the device this origin holds.

### Changed

- Requires `@oxy.so/core` ^1.19.0.
- A lost-token recovery waits only on a credential that still names an account:
  a web credential kept after `no_active_session` (core 1.19.0) can mint again
  once someone signs in, but cannot bring back a session that ended, so the app
  signs out locally as before.

## [6.2.0] - 2026-09-26

### Changed

- Sign-in happens in the account dialog again (ADR 0029 D1, amended): on the
  web it is the split card — the Commons QR on the right ("Continue with Oxy"
  below `md`), the passkey and "Create account" on the left — and only the
  passkey and account creation open auth.oxy.so's window, for that one step.
  6.0's dialog, which moved the whole screen into that window, is gone.

### Added

- `useSurfaceFrameWidth` and `OxyAuthSplit`'s `bare` are back: the dialog grows
  to the 880 split card.

## [6.1.0] - 2026-09-26

Requires `@oxy.so/core` `^1.18.0`.

**Web accounts are a username, a passkey and a recovery email** (ADR 0029 D3):
no web identity, no web recovery phrase.

### Added

- `OxyCreateAccountPanel` (username → recovery email → its code → passkey),
  `OxyRecoverAccountPanel` (username or email → the code sent to the recovery
  email → a new passkey) and `OxyDeleteAccountPanel` (typed username → a
  passkey assertion): auth.oxy.so's `/signup`, `/recover` and
  `/delete-account`, built from the sign-in shell.
- `OxyLinkCommonsPanel`: auth.oxy.so's `/link-commons` — a QR Commons scans
  and signs, the code both devices show, then the passkey. The account
  becomes self-custodied and its recovery email is deleted.
- `useOxy().handleWebSession` takes a `LoginSessionResult` too (a passkey
  registration's session).

### Changed

- "Delete account" on the web opens `auth.oxy.so/delete-account`; the native
  handoff's "elsewhere" copy points there for a passkey account.

### Removed

- The account menu's "Your identity" row (`onOpenIdentity`): there is no web
  identity to open.
- Editing the email in `EditProfileScreen` / `EditProfileFieldScreen`: the
  recovery email is not a profile field.

## [6.0.0] - 2026-09-26

**Web sign-in in auth.oxy.so's window** (ADR 0029 D1). On the web, an app's
account dialog shows "Continue with Oxy" and "Create account", and both open
auth.oxy.so in a window over the app, like "Sign in with Google": the QR, the
username and the passkey are there, on every domain alike. No code picks a
route by domain any more.

### Changed

- `useOxy().continueOnAuth(screen)` opens auth.oxy.so's window
  (`transport: 'popup'`) instead of leaving the tab; a blocked window still
  falls back to the tab. `startWebOAuthSignIn`'s `transport` takes `'popup'`
  as well as `'redirect'`, and passes `screen` in both.
- `OxySignInPanel`: the username, passkey and QR run only on a page
  (`host="page"`, auth.oxy.so). In the dialog on the web it is "Continue with
  Oxy", which reports `onSignedIn` once the window signs the app in.
  `onRecover` has no default: recovery is on auth.oxy.so.
- `OxySignUpPanel` takes `onCreateOnWeb`, the web's one action.

### Removed

- The passkey ceremony inside an app's dialog on `*.oxy.so`, and the
  `isOxyRpOrigin` route choice (`PasskeyRoute`).
- The dialog's 880 split (`useSurfaceFrameWidth`) and `OxyAuthSplit`'s `bare`.

- `OxyProvider`'s `deviceCredentialStorage` prop and the `'ephemeral'` auth
  store. Its one caller was auth.oxy.so with the browser hub on; the hub is
  deleted, and every origin persists its device credential.
- The dead hub-sync lane: `maybeSyncHubAfterCommit` and
  `legacyRedirectLanes` (`allowsAutomaticIdpRedirect`), which nothing called.

## [5.1.0] - 2026-09-26

Requires `@oxy.so/bloom` `^4.26.0`, and includes 4.0.7's fixes (the
`FollowButton` accessible name, OxyHQ/oxy#1375 item 22).

Requires `@oxy.so/core` `^1.16.0`.

**No identity popups** (ADR 0028 D1b). What only auth.oxy.so can do — create an
account with its root, recover it, assert an `oxy.so` passkey from another
domain — happens there, in the same tab, and the person comes back signed in.

### Added

- `useOxy().continueOnAuth(screen)`: go to auth.oxy.so for `signup`, `recover`
  or `signin`, and come back signed in, through the ordinary authorization-code
  redirect. `startWebOAuthSignIn` takes `transport: 'redirect'` and `screen`.
- The sign-in screen's "Lost your passkey? Recover your account" link
  (`OxySignInPanel`'s `onRecover`; on the web it defaults to
  `continueOnAuth('recover')`).

### Changed

- "Create account" in the dialog goes straight to auth.oxy.so/signup on the
  web; the passkey off an `oxy.so` origin is asserted on auth.oxy.so. Neither
  opens a window.

### Removed

- The passkey popup (`passkeyHubPopup`), and `OxySignUpPanel`'s `host` and
  `onSignedIn` props, which only its popup flow used.

## [5.0.1] - 2026-09-26

Requires `@oxy.so/core` `^1.15.0`.

### Changed

- The web identity carrier is `auth.oxy.so` (ADR 0028). The account menu's
  identity row, web account deletion and the deletion hand-off copy point at
  `auth.oxy.so/identity`; the passkey window is `auth.oxy.so/continue`.

### Removed

- `OxyAuthChooser`'s `autoStartSignIn` prop, which had no effect.

## [5.0.0] - 2026-09-26

Requires `@oxy.so/core` `^1.14.0`.

**One sign-in screen.** The account dialog and auth.oxy.so now render the same
screens, from this package: `OxySignInPanel` (sign-in), `OxySignUpPanel`
(account creation) and `OxyAccountPicker` ("Choose an account"), on a shared
shell (`OxyAuthScreen`, `OxyAuthScreenHeader`, `OxyAuthLoading`,
`OxyAuthTerms`). auth.oxy.so mounts them as a page (`host="page"`); the dialog
mounts them in place.

### Added

- The sign-in screen: the device's accounts first, then the Oxy mark and a
  large title, the Commons way in, the username with its Continue, "or
  continue with" a passkey, and "Create account". On the
  web from `md` it is Bloom `AuthCard`'s split card — the form on the left, the
  embedded Commons QR over a photo carousel on the right — and the account
  dialog grows to 880 for it; below `md`, and on native, "Continue with Oxy"
  takes the QR's place ("Get Commons" on a native device without Commons).
  Continue is a username-first passkey sign-in, which also takes a hardware
  security key with no resident credential; the passkey button is the
  discoverable ceremony, with nothing to type. Both run on the page on an
  `oxy.so` origin and in the identity window everywhere else on the web;
  native has none. Layout is NativeWind `className`.
- `useSurfaceFrameWidth(maxWidth)`: a surface screen's say in its dialog's
  width, for a screen whose views differ in width.
- `useOxy().signInWithPasskey` sends the device fingerprint every other
  sign-in path sends when the caller passes none.

### Changed

- **Breaking:** `react-native-css` is a required peer. The root barrel already
  imported it statically (`ProfileButton`); the optional flag only hid that.
- The sign-in entry is no longer one "Continue with Oxy" button with its
  alternatives behind "Having trouble?": every method is on the screen. The
  active request (`qr` view) keeps its disclosure.
- "Create account" in the dialog opens the account-creation screen, whose
  one action opens the identity window, instead of opening the window at once.

### Removed

- **Breaking:** the `OxyAuthChooser` export. The dialog renders it; a page of
  its own mounts `OxySignInPanel` / `OxySignUpPanel` / `OxyAccountPicker`.
- The old sign-in entry and sign-up views (`SignInEntryView`, `SignUpView`)
  and their dead styles.
- **Breaking:** `useOxy().registerWithPasskey`. An Oxy account is created WITH
  its self-custody root in the account dialog's creation flow
  (`openAccountDialog('signup')`), never by a local passkey ceremony (ADR 0024
  D4). No ecosystem app called it; `auth.oxy.so` opens the canonical flow.

## [4.0.7] - 2026-09-26

Requires `@oxy.so/bloom` `^4.26.0` (the `FollowButton` accessible-name override).

### Fixed

- `FollowButton` showed "Following" while a screen reader still heard
  "Follow": Bloom named it by its idle label and left the state to the pressed
  flag, which TalkBack reads as "selected" (OxyHQ/oxy#1375 item 22). The name
  now follows the state in every case: "Checking whether you follow @nate"
  while the status loads, "Follow @nate", and "Following @nate" with the hint
  "Unfollows @nate". While a follow or unfollow is in flight it keeps the state
  it shows and drops the hint. The new optional `username` prop supplies the
  handle; without it the name is "Follow" / "Following". The "Follow all" mode
  names its state the same way, with the account count in the hint.
- `FollowTargetButton` is named by the state it shows ("Following",
  "Requested", "Off here") instead of its idle verb.

## [4.0.6] - 2026-09-26

Requires `@oxy.so/core` `^1.12.0`. The new copy is English until the next core
release carries its `deleteAccount.handoff.*` strings (en-US, es-ES).

### Fixed

- "Delete account" in an app whose identity key Oxy Commons keeps on the same
  device no longer fails with "No identity found on this device". Before
  anything is deleted, the screen checks whether this app holds the key: if it
  does, its own confirmation runs as before; if Commons is installed, it offers
  to open Commons' delete-account screen (`oxycommons://delete-account`);
  otherwise it explains where the account can be deleted (Oxy Commons, Settings
  > Delete account, on the device that holds the identity, or `id.oxy.so` in a
  browser that holds it). None of those paths calls the deletion API. An
  unreadable keystore is reported, never treated as "the key is elsewhere"
  (OxyHQ/Mention#1169).
- A failed deletion's message was error-coloured text on an error-tinted box,
  which read as an empty red rectangle. It is Bloom's error `Admonition` now:
  theme text colour on the theme background with an error border
  (OxyHQ/Mention#1169).

## [4.0.5] - 2026-09-25

Requires `@oxy.so/core` `^1.12.0`.

### Fixed

- Signed out, tapping the device account listed on the sign-in sheet (the
  Commons shared identity) closed the sheet and left the app signed out. It
  now signs in exactly as "Continue with Oxy" does, through
  `AccountDialogController.chooseContext` (OxyHQ/oxy#1375 item 20).
- Signed out, the sheet no longer reads "Add Another Account — Sign in with
  another account", and the listed account no longer carries a check as if it
  were signed in. The title is "Sign in" whenever this app holds no session,
  whatever the device directory lists, and each row reads "Continue as
  @handle" with the account's name beneath (OxyHQ/oxy#1375 item 21).
- Android: `OxyIdentityStore` no longer deletes the androidx master key
  (`_androidx_security_master_key_`) when its keyset cannot be rebuilt. That key
  is one Keystore entry for the whole `so.oxy.shared` UID, so deleting it made
  every other Oxy app's encrypted prefs unreadable. Every store now opens with
  `RecoveryPolicy.RebuildFileOnly`; `RegenerateSharedMasterKey` is removed
  (OxyHQ/oxy#1388).

## [4.0.4] - 2026-09-25

### Fixed

- A signed-out app no longer gets its account back. A device projection whose
  profile fetch was in flight when the session was cleared locally (a token
  refresh firing just before sign-out) finished afterwards and republished the
  account — so a signed-out visitor was greeted by the previous user's name.
  `OxyRuntime.clearSession()` now abandons every projection already in flight.
  With `@oxy.so/core` 1.10.0, the refresh that triggered it cannot plant a bearer
  after the sign-out either.

## [4.0.3] - 2026-09-25

Requires `@oxy.so/core` `^1.9.1`.

### Fixed

- A signed-in app is no longer signed out when its access token is cleared by
  a transient failure (a 401 whose refresh was rate limited, cooling down or
  offline). While the durable device credential survives, the provider keeps
  the user, pauses private queries and re-mints with backoff, the way a
  relaunch does. It signs out once the refresh handler drops the credential on
  a definitive verdict (`invalid_device_secret`, `no_active_session`), or after
  a bounded retry through the shared identity / identity key
  (OxyHQ/Mention#1140). Recovery decisions log at `warn`.

## [4.0.2] - 2026-09-25

Requires `@oxy.so/core` `^1.9.0` and `@oxy.so/bloom` `^4.21.1`.

### Fixed

- The account menu rendered a giant circular "Switch account" row, a huge
  storage card and ~250dp-tall storage chips on Android. Bloom < 4.21 declared
  its type-scale line-heights in px, and react-native-css multiplies a
  line-height it reads through `var()` by the font size (`text-body`: 22 × 15 =
  330dp). Bloom 4.21 writes them as ratios; the Bloom peer floor moves to
  `^4.21.1`, which also brings the bottom-sheet safe-area inset, the inline ✕
  header, the Accordion trigger that no longer wraps, and a collapsed sheet
  header that paints its background on Android (it overlapped the rows of
  "Manage your Oxy Account").

- Signed out, Back from "Create your account" returned to the SIGNED-IN account
  menu. The account dialog's Back now follows the controller's `backView`
  (`@oxy.so/core` 1.9.0), and `OxyAuthChooser` never renders the account menu
  without a signed-in user — the sign-in entry renders in its place
  (OxyHQ/oxy#1375).
- The account menu's icon-font glyphs no longer reach the accessibility tree
  (TalkBack announced `"\u{F0140}"` beside "Switch account"). Both SDK icon
  families hide every glyph with `aria-hidden`, which callers cannot override.
- The "Having trouble?" disclosure spans the content width with a compact,
  centred trigger, instead of a shrink-wrapped column that wrapped the trigger
  to "Having / trouble?" on Android and squeezed its options.
- The sign-in surfaces' primary actions are Bloom's `lg` button (44dp), not the
  36dp default.
- "Manage your Oxy Account": a "Sessions & devices" row read "undefined (This
  device)" — the endpoint sends no device name. The current session is "This
  device" and another is named by its account. "Switch account" reads
  "1 account", not "1 accounts".

## [4.0.1] - 2026-09-21

### Fixed

- `ProfileButton` imports its icons through Bloom's per-glyph subpaths instead
  of the `@oxy.so/bloom/icons` barrel, which Metro retains whole (465 icon
  modules in a consumer's common chunk). `bloomSubpathsResolve.test.ts` rejects
  a runtime import of the barrel.

## [4.0.0] - 2026-09-21

### Changed

- **Breaking:** requires `@oxy.so/bloom` `^4.2.0` and `@oxy.so/core` `^1.7.3`.
  Apps and Services must share ONE Bloom instance (theme, dialog and
  interaction contexts). Shared UI adopts Bloom 4 controls: `FollowButton`,
  `ProfileButton`, user lists, file management, headers and account members.
  See `docs/engineering/bloom-4-migration.md`.
- **Breaking:** `OxySignInButton.size` follows Bloom's `SocialButtonSize`
  (`sm`, `md`), replacing `small` and `medium`.

### Removed

- The duplicate animated file-mode button and the unused PIN renderer.

## [30.2.5] - 2026-09-03

### Added

- Added explicit cross-platform OAuth reconsent through
  `requestOAuthConsent`, with exact scope validation, PKCE and state binding,
  byte-exact redirect verification, and no grant without user interaction.

## [30.2.1] - 2026-09-02

### Changed

- Replaced the full Ionicons and Material Community Icons assets reachable from
  Services UI with exact-shape generated subsets. The consumer payload falls
  from 1,697,384 bytes to 75,172 bytes for those two families. A build gate now
  rejects stale subsets, changed source versions, unrecorded glyph names, or
  reintroduced full-family imports.
- Centralized session commit handling so account activation, token state and
  legacy OAuth redirect lanes converge through one tested flow.

## [28.0.0] - 2026-08-06

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/services` is now Apache-2.0. The code, the API surface and the
behaviour are unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `27.1.3` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

The major is bumped rather than the change being slipped into a patch, so that
nobody on `^27.0.0` is moved to a new licence by a routine install. That is
exactly what happened at `22.5.0`, and it is not happening again.

### Also breaking: the `@oxy.so/core` peer range moves to `^20.0.0`

Core's own relicensing bumped it to `20.0.0`, so the declared peer range has to
follow. Bump `@oxy.so/core` alongside this package. Nothing in the services API
surface changed.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.

## [25.0.0] - 2026-07-30

### Changed
- **BREAKING**: Raised the `@oxy.so/core` peer dependency to `^16.0.0`. Consumers
  must bump core to 16.x when upgrading services — the services API surface is
  unchanged, but the declared peer range was stale after core 16 shipped.

### Removed
- **BREAKING**: Dropped the bundled Inter font family and the font-loading API.
  - Deleted the 7 static Inter TTFs (`src/assets/fonts/Inter/`, 2.41 MB) that shipped
    inside every consumer APK/AAB. No component in this package ever referenced the
    `Inter-*` families they registered.
  - Removed the `FontLoader` component and `setupFonts()` function from all entry
    points (`@oxy.so/services`, `/ui`, `/ui/client`, `/ui/server`), and the implicit
    `setupFonts()` call in `OxyProvider`.
  - Dropped the now-unused `expo-font` peer dependency.
  - Typography is owned by `@oxy.so/bloom`: `BloomThemeProvider` already ships a
    variable Inter (plus BlomusModernus and Geist Mono) and loads it on both native
    and web. Apps that mount `BloomThemeProvider` need no changes.

## [10.2.3] - 2026-06-18

### Fixed
- `OxyProvider` now treats provider-token invalidation as a local sign-out when a user is currently authenticated. If `HttpService` clears the access token after a 401, the provider clears session state and managed accounts instead of leaving stale `isAuthenticated` state active.
- `refreshManagedAccounts` now requires an authenticated, token-ready session and handles a managed-accounts 401 by clearing local auth state. This stops cascades of private endpoint 401s after a stale token is rejected.

## [8.7.0] - 2026-06-14

### Added
- **`appName` prop on `OxyProvider`** — a human-readable display name for the consuming app, surfaced on the central Oxy sign-in / consent experience as "{appName} wants to access your Oxy account".
  - New `resolveAppDisplayName` utility (`src/ui/utils/appName.ts`) resolves the name in order: explicit `appName` → capitalized `storageKeyPrefix` (only when the consumer overrode the default) → `document.title` (web only) → `Platform.OS`.
  - Exposed as a non-empty `appName: string` on the `OxyContext` state.
  - `SignInModal` and `OxyAuthScreen` now send the resolved `appName` as the `appId` on `POST /auth/session/create` instead of `Platform.OS` / an ad-hoc capitalized prefix.

### Fixed
- The consent page no longer shows the literal platform string **"web"** for web consumers that did not pass a name. It now derives a correct brand name from the `storageKeyPrefix` or `document.title`, and only falls back to the platform when an app supplies none of those. (Mention #143)

### Fixed
- **Fixed react-native imports in core modules** - Critical packaging bug fix
  - `HttpService.ts`: Removed direct `Platform` import from react-native
  - `keyManager.ts`: Removed direct `Platform` import from react-native
  - `sonner.ts`: Split into platform-specific files (`sonner.web.ts`, `sonner.native.ts`)
  - `/web` and `/core` entry points now truly have **zero react-native dependencies**

### Added
- **New platform detection utility** (`src/utils/platform.ts`)
  - Provides `isWeb()`, `isNative()`, `isIOS()`, `isAndroid()`, `getPlatformOS()`
  - Works in all environments without importing react-native
  - Platform is auto-initialized in React Native via main entry point

### Changed
- Core modules now use the new platform utility instead of importing `react-native` directly
- Bundlers (Vite, Webpack) no longer need react-native stubs for `/web` or `/core` entry points

### Why This Matters
Before this fix, even when using `@oxy.so/services/web` or `@oxy.so/services/core`, bundlers would encounter `import { Platform } from 'react-native'` in core modules, causing build failures in pure web/Node.js environments. This is now fixed.

## [5.22.0] - 2026-01-27

### Added
- **New `/web` entry point** (`@oxy.so/services/web`) for pure React/Next.js/Vite apps
  - Optimized for web-only applications without Expo or React Native
  - Excludes all React Native dependencies for smaller bundle size
  - No bundler configuration needed (no react-native-web required)
  - Exports `WebOxyProvider` and all web-compatible features
  - Recommended for all pure web applications

### Changed
- Updated package.json exports to properly support all platforms:
  - **Expo 54 (native)**: Uses source files via `react-native` condition
  - **Expo 54 (web)**: Uses pre-built files with react-native-web
  - **Pure React web**: Use `/web` entry point (no RN deps) or main entry with bundler config
  - **Node.js**: Uses core-only build via `node` condition
- Improved TypeScript type exports for better IDE support

### Documentation
- Added comprehensive platform usage guide in README
- Added web bundler configuration section (Vite, Webpack, Next.js)
- Documented when to use each entry point
- Added examples for all supported platforms

### Migration Guide
For pure web apps (Vite, Next.js, CRA), switch to the new `/web` entry point:

```typescript
// Before (requires bundler config)
import { WebOxyProvider } from '@oxy.so/services';

// After (cleaner, no config needed)
import { WebOxyProvider } from '@oxy.so/services/web';
```

No changes needed for Expo apps or Node.js backends - they continue to work as before.

## [Unreleased]

### Changed
- **BREAKING**: Migrated from Phudu to Inter as the default font family for the entire Oxy ecosystem
  - Inter font is now included and automatically loaded
  - All font references updated to use Inter
  - Apps using this package will automatically get Inter fonts
  - See [FONTS.md](./FONTS.md) for complete typography guide

### Added
- Added comprehensive typography documentation ([FONTS.md](./FONTS.md))
- Exported `fontFamilies` and `fontStyles` constants for consistent font usage
- Exported `FontLoader` component and `setupFonts()` function
- Added 7 Inter font weights: Light (300), Regular (400), Medium (500), SemiBold (600), Bold (700), ExtraBold (800), Black (900)

### Removed
- Removed Phudu font family and all related files
- Removed hardcoded platform-specific font checks in favor of centralized constants

### Migration Guide
If you were using the Phudu fonts from this package:

1. Replace all `fontFamilies.phudu*` with `fontFamilies.inter*`:
   ```typescript
   // Before
   fontFamily: fontFamilies.phuduBold
   
   // After
   fontFamily: fontFamilies.interBold
   ```

2. The `fontStyles` constants remain the same (already updated to Inter)

3. No other changes required - Inter fonts load automatically via `FontLoader`

See [FONTS.md](./FONTS.md) for complete documentation.
