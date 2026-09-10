# OxyHQServices

Oxy platform monorepo (`@oxy.so/sdk`), Bun workspaces + Turbo. Kaana is the
inference API; Oxy is the platform plus the Oxy Console, where every API key
(Alia, Kaana, Mention) is issued; Alia is the assistant with its own permanent
product API.

Read `docs/README.md` first; `docs/adr/` binds; org rules: `~/AGENTS.md`,
`~/Oxy/AGENTS.md`. Budgeted: one line per rule, evidence at its pointer.

## Commands (CI)

```bash
bun install --frozen-lockfile --minimum-release-age=0
bun run build:all                   # turbo, dependency order
cd packages/<pkg> && bun run test   # per package; never a bare `bun test`
bun run validate:agents-md
bun run build && bun pm pack        # release, in the package; never npm pack
```

## Rules

Pointers: files in `docs/engineering/`; a bare `#anchor` is in `package-rules.md`.

**Build** — build-and-deploy.md#commands
- Run each package's own `bun run test`; only `packages/auth` is `bun test`.
- Shared versions live in `workspaces.catalog` as `"catalog:"`.
- Pack with `bun pm pack`, never `npm pack`.
- Anything that re-resolves passes `--minimum-release-age=0`.
- Never publish a tarball you did not build in the same command — #publishing
- TS strict; Biome `--error-on-warnings`; commit `bun.lock` with its `package.json`; path-scope `git add`, never `git add -A` — #coding-standards

**Package boundaries** — #package-boundaries
- `@oxy.so/contracts` and `@oxy.so/core` never import `react`, `react-native` or `expo-*`.
- `@oxy.so/services` never re-exports core or contracts; `@oxy.so/api` takes auth from `@oxy.so/core/server` only.
- A module naming an OPTIONAL peer never reaches the root barrel: own export subpath.
- Never hand-write `declare module '<pkg>'` for a package with types or `@types/` — #ambient-shims
- ESM builds of core and contracts contain no `require()` — #esm-builds
- Every peer range on a package that ships breaking majors has an UPPER bound — #peer-ranges

**Runtime traps**
- Never ship a `\p{…}` regex atom in anything that runs on Hermes; transpile with `regexpu-core` — #hermes-property-escapes
- Keep `packages/services/src/` React-Compiler-safe — #react-compiler
- Align native-module versions UP and add them to `expo.install.exclude` — build-and-deploy.md#architecture

**Identity, auth, privacy** — auth-and-identity.md#auth--session-contract
- `displayName` is optional; the one fallback is the handle via `getNormalizedUserHandle` — #user-identity-contract
- RP origins are zero-cookie; only `auth.oxy.so` holds `__Host-oxy-device`; no third-party cookies, iframes, FedCM, `prompt=none` or silent redirects.
- The SDK never navigates the top-level window on its own; silent restore and hub sync are deleted, not gated.
- ONE `OxyProvider` from `@oxy.so/services` with a registered `clientId`; no app-local restore or sign-in screen.
- App backends use `@oxy.so/core/server`; no local auth middleware; socket rooms from `socket.user.id`.
- App backend clients use `oxyServices.createLinkedClient({ baseURL })`; no local token plumbing.
- Never `new Model(req.body)` or spread `req.body` into an update; whitelist fields.
- Loopback origins stay trusted in ALL environments via `isLoopbackOrigin`; never gate on `NODE_ENV`.
- NEVER persist a user IP, raw, hashed or geo-derived; rate-limit keys go through `hashedIpKey` — platform-features.md#no-ip-invariant

## Terminology

`OxyServices` · `OxyProvider` (the ONE provider) · `useOxy`/`useAuth` · `OxyAccountDialog` (switcher + sign-in) · bottom sheet (auth uses the dialog) · `LogoIcon`/`LogoText`.

## Read before touching

- Auth, sessions, IdP: `docs/auth/index.md`, then `auth-and-identity.md`
- Inference/agents: `docs/inference/request-routing.md` — one-shot AI: Oxy → Kaana; agents/chat: Alia → Oxy → Kaana; provider credentials only in Kaana; sole signed origin `https://kaana.ai`
- In `docs/engineering/`: packaging/Docker/AWS `package-rules.md`, `build-and-deploy.md` · SDK internals `sdk-patterns.md` · local dev `local-dev-cursor-cloud.md` · git diffs/rebases `measurement-traps.md`
