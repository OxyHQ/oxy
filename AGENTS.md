# OxyHQServices

The Oxy platform monorepo (`@oxyhq/sdk`): the contracts, the core SDK, the one UI
SDK, the API, the IdP, and the apps built on them. Bun workspaces + Turbo.

> **For anything about how this works, read `docs/README.md`** — `docs/adr/`
> holds the binding decisions, `docs/engineering/` the mechanisms this file used
> to restate, and `docs/auth/index.md` is the answerable entry point for
> sessions.
>
> **This file carries only RULES — things that break silently if you get them
> wrong.** Mechanisms, per-issue write-ups and subsystem walkthroughs go in
> `docs/`, never here. Org-wide standards are in `~/AGENTS.md` and
> `~/Oxy/AGENTS.md`; do not repeat them. Versions live in `package.json`.
>
> **Budget: under 12 KB**, enforced by `scripts/check-agents-md-size.mjs`. An
> addition that pushes it over is paid for in the SAME edit.

## Commands

```bash
bun install
bun run build:all      # contracts -> core -> services -> rest
bun run core:build
bun run services:build
bun run dev
bun run test           # delegates through turbo, per package
bun run validate:agents-md
```

- **Always run each package's OWN `bun run test`.** `@oxyhq/{api,core,services,contracts}`
  and `commons` are **Jest**; `packages/auth` is **Bun's native `bun test`**.
  NEVER blanket-invoke `bun test` across the monorepo — it runs Bun's runner over
  the Jest packages and produces dozens of false failures.
- **Shared dependency versions live in `workspaces.catalog`**, referenced as
  `"catalog:"` — root `overrides` included. A range that legitimately differs per
  workspace stays literal, because a catalog entry would assert an agreement that
  does not exist.
- **Pack with `bun pm pack`, never `npm pack`** — `npm` ships the literal string
  `catalog:`, which no consumer can resolve. `scripts/assert-bun-publish.mjs` is
  what makes the catalog safe for published packages.
- **`npm publish <tgz>` and `bun publish <tgz>` run ZERO lifecycle scripts** —
  measured, so `prepublishOnly` (typecheck, test, build, packer assertion) never
  fires and `services@30.0.0` shipped with no `lib/` at all. Never publish a
  tarball you did not build in the SAME command; `postbuild` is what runs
  `packages/services/scripts/verify-package.mjs`, and only a build runs it. Table
  of every pack/publish path: `docs/engineering/package-rules.md`.
- **`bun install` refuses to RESOLVE a dependency published in the last week**
  (`minimumReleaseAge`). Anything that re-resolves must opt out — that is why
  `scripts/check-lockfile-sync.mjs` passes `--minimum-release-age=0`.

Local dev caveats (Postgres, the unset Redis, building shared libs before running
an app, the end-to-end auth smoke test):
`docs/engineering/local-dev-cursor-cloud.md`.

## Package boundaries (strict)

- **`@oxyhq/contracts` and `@oxyhq/core` must never import `react`,
  `react-native` or `expo-*`.** Contracts allows only `zod`; core may use dynamic
  `await import(...)` for optional RN modules.
- **`@oxyhq/services` does NOT re-export from `@oxyhq/core` or
  `@oxyhq/contracts`.** Consumers import those types directly. No
  back-compatibility re-exports anywhere.
- **A module naming an OPTIONAL peer must never be reachable from the root
  barrel — give it its own export subpath.** `tsc` resolves an `import()`
  specifier even when the call is lazy and wrapped in `try`/`catch`, so a barrel
  re-export turns an optional peer into a hard install requirement. It is
  RESOLVER-ASYMMETRIC and therefore ships unnoticed: web/Vite consumers resolve
  `lib/**/*.d.ts` under `skipLibCheck` and never see it, while Metro/RN consumers
  resolve the published `src/` and fail. Worked example:
  `@oxyhq/services/notifications`, kept out of the barrel by
  `packages/services/__tests__/notifications/barrelIsolation.test.ts`.
- **`@oxyhq/api` imports schemas directly from `@oxyhq/contracts`** and server
  auth helpers from `@oxyhq/core/server` only.
- **Never hand-write a `declare module '<pkg>'` for a package that ships types or
  has an `@types/`.** An ambient declaration SHADOWS the resolved types for every
  program including the declaring file — core's tsconfig includes it and no
  consumer's does, so core typechecks against a private view of its dependencies
  and a consumer compiling core SOURCE gets a different program. This took main's
  whole `packages/api` jest run down once, with a symptom that reads as version
  skew. Legitimate ONLY where the dependency has no types AND no `@types/`;
  verify by deleting it and running the package's own `tsc`. Never "fix" the
  optional-peer class this way.
- **The ESM builds of core and contracts must contain no `require()`** — Vite and
  other ESM-only bundlers crash. Use `await import()` for optional/platform
  modules; guard any unavoidable `require()` with `typeof require !== 'undefined'`.
- **Every peer range on a package that ships breaking majors needs an UPPER
  bound.** `"*"` and a bare `">=x"` let a consumer's install silently resolve a
  major the package cannot work with, with no warning from bun at all — the only
  thing that catches it is `tsc` reaching into `node_modules`, which it does only
  because the `react-native` condition points at published `src/`, so an app whose
  typecheck skips `node_modules` gets a green build and a white screen. Raise a
  floor only to a version MEASURED to be the first that works (bisect the
  published tarballs), and re-raise it in the same commit as the code that
  requires it.

## Runtime traps

- **Never ship a `\p{…}`/`\P{…}` atom in any package that runs on Hermes**
  (core, services, bloom, every app). Mobile Hermes is built with property
  escapes OFF and throws at RUNTIME on every one of them; V8 supports them fully,
  so this never reproduces on web, and `hermesc` accepts them at compile time, so
  the desktop compiler proves nothing. Core builds with `tsc` and no Babel, so a
  property escape in a module-load-time regex crashes every consuming RN app at
  BOOT. Sanctioned fix: transpile to explicit ranges at build time with
  `regexpu-core` (`bun run generate:display-name-policy`). Shipped `dist/` must
  contain zero `\p{`, and `validationUtils.test.ts` guards it.
- **`@oxyhq/services` SOURCE is React-Compiler-compiled inside the `commons` and
  `accounts` apps** — Metro resolves the workspace symlink to a realpath with no
  `node_modules` segment, so Expo's gate treats it as app source. `packages/services/src/`
  must therefore be held to React-Compiler-safe standards.
- **Align native-module versions UP across the whole monorepo** and add the
  package to `expo.install.exclude`, or `expo install --fix` downgrades it back.
  Never let two versions of one native module coexist.

## Identity, auth and privacy

Mechanisms — the device-first session transport, the cookie rule, `DeviceSession`,
cold boot, `sessionMode`, the OAuth transports, service tokens, the IdP:
**`docs/engineering/auth-and-identity.md`** and `docs/auth/index.md`.

- **`name.displayName` is OPTIONAL and the fallback is the HANDLE**, once:
  `displayName ?? handle` via `getNormalizedUserHandle`. Never rebuild a
  multi-field chain, and never require a non-empty `displayName` as a
  session-validity gate.
- **Relying-party origins are ZERO-COOKIE.** `auth.oxy.so` alone holds
  `__Host-oxy-device`, and its value is an opaque random handle and nothing else.
  Still forbidden: third-party cookies, hidden iframes, cross-origin
  `localStorage`, FedCM, gesture-less popups, silent `prompt=none` loops,
  automatic redirect chains between Oxy origins.
- **The SDK NEVER navigates the top-level window on its own.** Every hop to the
  IdP starts from a real user gesture. The silent cold-boot restore and the
  post-sign-in hub sync are DELETED, not gated — do not reintroduce either.
- **ONE `OxyProvider`, from `@oxyhq/services`, on web and native**, with a
  registered `clientId`. Never a second provider, never app-local session
  restore, never an app-local sign-in screen.
- **App backends use `@oxyhq/core/server`** — `createOxyAuthMiddleware`,
  `createOptionalOxyAuth`, `getRequiredOxyUserId`, `authSocket`, `safeFetch`,
  `createOxyCors`, `verifySecret`. Do not define local `AuthRequest`,
  `requireAuth`, bearer parsers or token-decoding middleware in an app; missing
  behaviour belongs in `@oxyhq/core/server`. Derive socket rooms from
  `socket.user.id`, never from a client-supplied id.
- **Never `new Model(req.body)` or spread `req.body` into an update** — resolve
  owner ids server-side and whitelist fields explicitly (mass-assignment IDOR).
- **App backend clients use `oxyServices.createLinkedClient({ baseURL })`.** No
  app-local token providers, auth interceptors, manual `Authorization` headers or
  refresh retries.
- **Loopback dev origins are trusted on the credentialed CORS lane in ALL
  environments, production included** (owner-approved). One predicate,
  `isLoopbackOrigin`. Do NOT gate it on `NODE_ENV`, hardcode a port, or extend it
  to `https://localhost`.
- **NEVER persist a user IP** — raw, hashed or geo-derived, in the database,
  logs, metrics or a DTO. Hashing the IPv4 space is brute-forceable, so it is not
  an acceptable at-rest form. Anonymous rate-limit keys are the one transient
  exception and MUST go through `hashedIpKey`; inbound-email `Received:` headers
  are the one sanctioned stored exception. Do NOT re-add IP capture "for
  security" — it was a deliberate trade-off, not an oversight.

## Coding standards

- TypeScript strict everywhere; Biome with `--error-on-warnings`.
- `core`/`contracts` build with `tsc` (CJS + ESM + types → `dist/`); `services`
  builds with `react-native-builder-bob` (→ `lib/`).
- **PATH-SCOPE every `git add` in a shared package.** Never `git add -A` while
  another session may hold uncommitted work — a concurrent session's federation
  work was nearly swept into an unrelated commit.
- **Regenerate and commit `bun.lock` in the SAME commit as the `package.json`
  change**, per repo.

## Terminology

`OxyServices` (API client, core) · `OxyProvider` (the ONE React provider,
services) · `useOxy` / `useAuth` · `OxyAccountDialog` (account switcher and
sign-in) · bottom sheet (native modal navigation in services; auth flows use the
dialog, not sheets) · `LogoIcon` / `LogoText`.

## Where the rest lives

`docs/engineering/package-rules.md` (the evidence behind every boundary, build
and runtime rule above — the ambient-shim incident, the Hermes verification, the
optional-peer resolver asymmetry) · `docs/engineering/build-and-deploy.md` (AWS,
the inbound email path, containers
and the Dockerfile gotcha, the workspace/dependency graph, contract-first
schemas, key entry points, published version notes) ·
`docs/engineering/auth-and-identity.md` · `docs/engineering/platform-features.md`
(the application model, workspaces, Oxy Trust, rate limiting, federation, OTA
updates, contact discovery, the accounts/commons apps, civic identity, the IP
invariant's full removal list) · `docs/engineering/sdk-patterns.md` ·
`docs/engineering/local-dev-cursor-cloud.md`.
