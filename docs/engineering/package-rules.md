# Package rules: boundaries, builds and the runtime traps

> Moved out of `AGENTS.md` unchanged — the compressed rules stay there, this is
> the evidence behind each one.

## Package Boundaries (strict)

- **@oxyhq/contracts** must never import `react`, `react-native`, or `expo-*`. Only `zod` allowed. Platform-agnostic — both server and client import from it directly.
- **@oxyhq/core** must never import `react`, `react-native`, or `expo-*`. Dynamic imports (`await import(...)`) for optional RN modules are allowed.
- **@oxyhq/services** does NOT re-export from `@oxyhq/core` or `@oxyhq/contracts`. Consumers import core types directly from `@oxyhq/core` and API contract types directly from `@oxyhq/contracts`.
- **A module that names an OPTIONAL peer must never be reachable from the root barrel — give it its own export subpath.** `tsc` resolves the specifier of an `import()` even when the call is lazy and wrapped in try/catch, so a barrel re-export drags the specifier into EVERY consumer's type graph and turns an optional peer into a hard install requirement (`TS2307`, plus `TS7006` cascades where parameters lose contextual typing). This is resolver-asymmetric and therefore easy to ship unnoticed: web/Vite consumers resolve the package through `lib/**/*.d.ts` and `skipLibCheck: true` hides it, while Metro/RN consumers resolve the `react-native` condition (published `src/`) and fail. Metro itself is fine — an unresolvable DYNAMIC `import()` bundles cleanly and the `catch` handles it at runtime; only a STATIC import fails the Metro build. The push adapter is the worked example: `@oxyhq/services/notifications` (`packages/services/src/notifications/deviceNotifications.ts`), kept out of the barrel by `packages/services/__tests__/notifications/barrelIsolation.test.ts`, which walks the real module graph. Do NOT "fix" this class with an ambient `declare module 'expo-x'` in `src/types/` reached via `/// <reference path>`: an ambient declaration SHADOWS the real package for the whole consumer program, so an app that DID install the module silently loses its real types. (The existing `src/types/expo-*.d.ts` stubs are safe only because nothing `/// <reference>`s them into a consumer's program — they serve this package's own build.)
- **@oxyhq/api** imports schemas directly from `@oxyhq/contracts`. Server auth helpers come from `@oxyhq/core/server` only; do NOT route contracts through `@oxyhq/core` re-exports.

## ESM/CJS Compatibility (critical)

Both `@oxyhq/core` and `@oxyhq/contracts` ship dual CJS + ESM builds. The ESM build **must not contain `require()` calls** — Vite and other ESM-only bundlers will crash.

- **Never** use `require()` in `packages/core/` or `packages/contracts/` source code
- Use `import ... from` for static imports (JSON files, modules)
- Use `await import(moduleName)` for optional/platform-specific modules (e.g. expo-crypto)
- Guard any unavoidable `require()` with `typeof require !== 'undefined'`
- For platform-specific crypto: use `isReactNative()` → expo-crypto, `isNodeJS()` → node crypto, else → Web Crypto API

## Ambient `declare module` shims (core — critical)

**Never hand-write a `declare module '<pkg>'` for a package that ships types or has an `@types/<pkg>`.** An ambient module declaration SHADOWS the resolved types for every program that includes the declaring file — and `packages/core/tsconfig.json` includes it (`include: ["src"]`) while no consumer's tsconfig does. The result is a package that typechecks against a private view of its dependencies: core's own `tsc` passes, and any consumer compiling core SOURCE gets a different, sometimes broken, program.

This is not hypothetical — it took main's whole `packages/api` jest run down (`TS2305: Module '"elliptic"' has no exported member 'ECKeyPair'`, `Tests: 0 total`). api's jest maps `@oxyhq/core` to source, so it compiled `keyManager.ts` under api's tsconfig, where core's `src/types/elliptic.d.ts` was absent and the real `@types/elliptic` (which has no `ECKeyPair`) applied. The symptom looks environmental — one package builds, another cannot compile the same file — so it reads as a version skew or a stale tree and gets chased there first.

Same trap applies to Metro consumers: the `"react-native"` export condition points at published `src/`, so RN apps compile core/services SOURCE too. Babel does not typecheck, which is the only reason those apps do not also break.

- Shims are legitimate ONLY for a dependency with no types at all AND no `@types/` package (`buffer`, `expo-crypto`, `expo-secure-store` — the three left in core). Check both before writing one.
- If a type from a dependency appears in a package's PUBLISHED `.d.ts` (e.g. `KeyManager.getKeyPairObject(): EC.KeyPair`), its `@types/` package belongs in `dependencies`, not `devDependencies` — otherwise it resolves to nothing in the consumer and `skipLibCheck` silently degrades it to `any`.
- Verify a shim is load-bearing by deleting it and running the package's own `tsc`: core's 70-line `elliptic` shim had exactly one line anything used, and its `color` shim was for a package core does not import at all.

## Hermes Unicode Property Escapes (mobile — critical)

Mobile Hermes (RN 0.86, `hermes-v0.17.0`) is built with `HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES` OFF, so it throws `SyntaxError: Invalid RegExp: Invalid property name` at runtime on EVERY `\p{…}`/`\P{…}` atom in a `u`-flag regex — `\p{L}`, `\p{M}`, `\p{Zs}`, `\p{scx=…}`, all of them, not just obscure subcategories. V8 (web) supports them fully, so this NEVER reproduces on web — only on a real native Hermes build. The `u` flag itself and lookbehind `(?<…)` are unaffected; only the `\p{…}` atoms are unsupported.

Why this is especially dangerous for `@oxyhq/core`: core builds with `tsc` (no Babel), so any `\p{…}` in source ships verbatim into `dist/`. A property escape in a MODULE-LOAD-time regex (a top-level literal, or a module-level `new RegExp(…, 'u')`) crashes every consuming RN app at BOOT the instant it imports the core barrel — one bad escape is a whole-ecosystem crash.

**Rule:** never ship a `\p{…}`/`\P{…}` atom in any package that runs on Hermes (core, services, bloom, and every app). Sanctioned fix (since `@oxyhq/core@12.5.4`): transpile property escapes to explicit code-point ranges at BUILD time with **`regexpu-core`** (the same transform Babel's `@babel/plugin-transform-unicode-property-regex` uses) — see `packages/core/scripts/generateDisplayNamePolicyRanges.mjs` → `displayNamePolicyRanges.generated.ts`, regenerated via `bun run generate:display-name-policy`. Call `rewritePattern(pattern, 'u', { unicodePropertyEscapes: 'transform' })` (no `unicodeFlag` option — keeps the `u` flag, rewrites only the `\p{…}` atoms). Keep the readable `\p{scx=…}` as the semantic source; never hand-edit the generated ranges. Shipped `dist/` must contain zero `\p{`. `validationUtils.test.ts` has a Jest regression guard that fails if any shipped policy source contains a property escape — extend it for new policy regexes.

**Verification:** `hermesc` (the desktop compiler) has the FULL Unicode property table and happily accepts `\p{Zl}` at compile time — that proves nothing about the mobile VM, whose on-device `.so` has zero property-name strings compiled in. Confirm on a real foregrounded Hermes build/device, never the compiler alone.

## React Compiler bundling of `@oxyhq/services` (Expo apps)

`@oxyhq/services` SOURCE is React-Compiler-compiled when bundled inside the `commons` and `accounts` Expo apps, even though `@oxyhq/services` itself declares no compiler flag. Those apps set `experiments.reactCompiler: true`, and because `services` is a workspace symlink whose `package.json` exposes `"react-native": "src/index.ts"`, Metro resolves it to the realpath TS source (no `node_modules` path segment) — so Expo's `isNodeModule` compiler gate treats services source as APP source and compiles it. Consequence: `packages/services/src/` must be held to React-Compiler-safe standards (no render-phase side effects/mutations inside `useMemo` or other compiler-memoizable positions; no reading external mutable state out-of-band in render — see the global React Compiler rule in `~/AGENTS.md`). In Allo, `services` resolves as a real `node_modules` directory, so it is excluded from compilation there — but the monorepo's own apps (commons, accounts) are the binding case.

## Import Conventions

```typescript
// Web (Vite + RN Web) AND Expo / React Native — ONE provider for both
import { OxyProvider, useOxy, OxySignInButton, OxyConsentScreen } from '@oxyhq/services';
import { OxyServices, KeyManager } from '@oxyhq/core';
import { generatePkcePair, generateOAuthState, buildOAuthAuthorizeUrl } from '@oxyhq/core';
import type { User, ApiError } from '@oxyhq/core';
```

When splitting imports: use `import type` for type-only imports, regular `import` for values.

## User Identity Contract

- Oxy API owns `name.displayName` for user/profile DTOs. `composeDisplayName` (`packages/api/src/utils/displayName.ts`) returns a real name (explicit displayName or composed first/last) or `undefined` — it does NOT fall back to username, publicKey, or `'Anonymous'`. `formatUserNameResponse` omits `displayName` when there is no real name.
- `@oxyhq/contracts` owns both the formatted user response contract and `UserProfileUpdate`. `@oxyhq/core`, `@oxyhq/services`, and `@oxyhq/api` import those types directly from `@oxyhq/contracts`; do not re-export them through another package.
- `@oxyhq/core` public `User.name.displayName` is **optional** (`string | undefined`). Consumers render `name.displayName` when present; **when absent, fall back to the handle** via `getNormalizedUserHandle` from `@oxyhq/core`. The pattern is `displayName ?? handle` — a single handle fallback. Do NOT rebuild multi-field chains (`displayName || first || username...`). The account-switcher helper `getAccountDisplayName` (local account surfaces only) keeps its own chain.
- **Display name character policy** (`cleanDisplayName`): allows letters (`\p{L}`) + marks (`\p{M}`) + spaces + apostrophe only; strips emoji, symbols, `:shortcode:`, digits, hyphens, dots, AND orphaned combining marks (a mark not attached to a base letter). Native writes reject 400; federated names are stripped on ingest; existing records were backfilled by a one-shot script that has since run in prod and been removed. These `\p{…}` atoms never ship raw to Hermes — see "Hermes Unicode Property Escapes" below.
- **Auth gate relaxation (originally 2026-06-29; the specific FedCM-era `OxyServices.sso.ts`/`sso.controller.ts` files this predated no longer exist post-wave-2):** every current sign-in/session-parsing path (`OxyServices.auth.ts`, the device-secret mint response, `formatUserResponse`) requires a structured `name` object but treats `displayName` within it as optional — never require a non-empty `displayName` string as a session-validity gate. Do NOT re-tighten this.
- Profile handle normalization belongs in `@oxyhq/core` (`packages/core/src/utils/userHandle.ts`). Consumers must use `getNormalizedUserHandle` for local/federated routes instead of local route helpers or manual domain concatenation.

## Coding Standards

- TypeScript strict mode across all packages
- Biome for linting (`biome lint --error-on-warnings`)
- No backward-compatibility re-exports — clean imports only
- No unnecessary abstractions or over-engineering
- `packages/core/` and `packages/contracts/` build with `tsc` (CJS + ESM + types -> `dist/`)
- `packages/services/` builds with `react-native-builder-bob` (-> `lib/`)
- **Concurrent session ownership (CRITICAL):** when multiple agents or sessions may be editing `packages/api` simultaneously, CONFIRM sole ownership of shared backend files before writing. PATH-SCOPE all git adds (e.g. `git add packages/api/src/routes/civic.ts`) — NEVER `git add -A` or `git add .` in a shared package while another session may have uncommitted work. Incident: a concurrent session's uncommitted federation work was nearly swept into an unrelated commit.
- **Lockfiles before push (any repo):** after any dependency/version bump, run `bun install` to regenerate `bun.lock` and commit it in the SAME commit as the `package.json` change. When bumping a dep across multiple repos, do this per-repo.
- **`bun install --frozen-lockfile` is NOT a lockfile-sync check — do not use it as one.** Measured on bun 1.3.14 against this repo, it exits **0** on both shapes of desync actually shipped here: a workspace package's own `version` bumped without regenerating the lockfile, and a dependency range widened to something the lockfile does not record (`^15.0.0` → `>=15.0.0`). It only fails when a range resolves to nothing at all, which is a resolution error, not a sync check. Believing otherwise is how a desync introduced in `7256c8d6` survived **six** consecutive commits on `main` and two releases. The real check is `scripts/check-lockfile-sync.mjs` (CI job **Lockfile Sync**), and it has **two layers, because neither covers the other**. Layer 2 regenerates with a plain `bun install` and asks git whether `bun.lock` moved — a tracked file changing IS the desync, with no interpretation needed. Layer 1 compares what `bun.lock` RECORDS per workspace (path set, `name`, `version`, root `overrides`, `trustedDependencies`) against the manifests directly, with no install. Layer 1 exists because **whether a plain `bun install` rewrites a stale recorded `version` is repo-dependent and the boundary is not understood**: in THIS repo it does (so layer 2 sees a version bump here, and would have caught the `core@14.0.0` / `services@23.0.0` bumps), but in the CrowdSource monorepo the identical bump leaves `bun.lock` byte-identical and only layer 1 sees it. Do not rely on regeneration alone in a new repo without measuring it there. Run it locally before pushing a manifest change; it names the offending workspace package. `scripts/test-check-lockfile-sync.mjs` (same CI job) holds both layers with offline fixtures — deleting either makes a case go red.

