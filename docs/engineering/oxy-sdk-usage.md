# Oxy SDK usage, app language, publishing and versions

Rules for apps that consume the Oxy SDK (`@oxy.so/services`, `@oxy.so/core`,
`@oxy.so/contracts`). Relocated from the former machine-local
`frontend-conventions` guide and checked against this repository; the Bloom,
NativeWind and Expo rules from that guide live in the Bloom repository.

## Using the SDK

- **Canonical media goes through one chokepoint:** `oxyServices.getFileDownloadUrl(id, variant)` plus Bloom's `ImageResolver`. Register one `ImageResolverProvider` at the app root (see `packages/accounts/app/_layout.tsx`) and pass bare file ids plus `variant` to `<Avatar source>`. Never pass `uri`, never hardcode `cloud.oxy.so`, never write per-app URL helpers or `avatarUrl` DTO fields. Why: one place owns variants and signing.
- **A stale read after a write has two cache layers:** the SDK linked-client GET cache and the server-side caches in the API. React Query invalidation does not defeat an SDK GET cache. Keep one cache authority per backend resource.
- **Bypass the SDK cache per call** with `{ cache: false }` on consistency-critical reads (for example `getUserById`, `getProfileByUsername`).
- **Profile identity:** `name.displayName` is optional. When absent, fall back to the normalized handle (`displayName?.trim() || handle`, or `getNormalizedUserHandle`). Never recompose from `name.first`/`name.last`/`name.full` and never duplicate instance suffixes. Fix a wrong `displayName` in the serializer or the SDK type, not in a frontend helper. Types come from `@oxy.so/contracts`.
- Post DTOs for an app's own feed are hydrated by that app's backend (Mention uses `PostHydrationService`); controllers never hand-build post `user` objects.

## App language (i18n)

- **Oxy resolves which language; an app never re-derives it.** Pass `OxyProvider`'s `language` prop (`{ supportedLocales, fallbackLocale, onChange }`); `onChange` is the app's own translation library's switch function (for example `i18next.changeLanguage`). No app effect, hook or sync component reads `useOxy().currentLanguage` to drive its own i18n. ADR 0022 retired exactly that defect (Mention, Allo and Homiio each reinvented an account-blind, locally stored guess): [ADR 0022](../adr/0022-app-i18n-follows-oxy-language.md).
- **react-i18next is the ecosystem default for an app's own text** (CLDR plurals, per-locale lazy loading, extraction tooling). The embedded surfaces of `@oxy.so/services` (ManageAccount, the language selector) deliberately keep a separate dependency-free `useI18n()`/`translate()` for their own small vocabulary; that is a different-sized problem, not an inconsistency.
- **One key convention everywhere ([ADR 0055](../adr/0055-translation-keys.md)):** keys are nested objects of identifier segments read as a dotted path (`compose.replySettings.nobody`); the first segment is the namespace. A key is never the English text and never a flat dotted string. Copy shared across features goes under `common`. English is the source; a translation carries only its keys plus the extra plural forms its language needs. Every app runs `oxy-doctor-i18n --ci` (`@oxy.so/doctor`, bin declared in `packages/doctor/package.json`) in CI. `create-oxy-app` scaffolds nested keys.

## Publishing

The release flow itself is [npm-releases.md](../npm-releases.md). Rules specific to SDK packages:

- **Republish `@oxy.so/contracts` first** when core or api start importing a new contracts symbol; verify with a clean external `bun add` plus `import()`.
- **Never publish from uncommitted state.** Merge the version bump to `main` first: an out-of-band publish permanently burns the version number.
- **Pack with `bun pm pack`, never `npm pack`.** npm ships a literal `"workspace:^"` no consumer can resolve; bun rewrites it to a caret range. Read `dependencies` out of the packed tarball (`tar -xzOf <tgz> package/package.json`) and check the substituted range exists on npm: a local version ahead of the published one yields a caret pointing at nothing.
- Verify propagation with a clean external install plus import.

## SDK versions

`package.json` and npm are the single source of truth. Never hardcode a version in prose: read the consumer's `package.json` or run `bun info <pkg> version`.
