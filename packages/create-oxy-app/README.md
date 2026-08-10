# create-oxy-app

Scaffold a new Oxy ecosystem app — an Expo / React Native + Express monorepo
wired to the Oxy SDK (`@oxyhq/services`, `@oxyhq/app-preset`) with the canonical
provider stack, device-first auth, Bloom theming, and an AWS deploy workflow.

## Usage

```bash
bun create oxy-app            # interactive
bun create oxy-app my-app     # into ./my-app
bunx create-oxy-app my-app --yes
```

### Options

```
--name <name>        App display name
--slug <slug>        Package/workspace slug (kebab-case)
--scheme <scheme>    Expo URL scheme
--bundle-id <id>     iOS/Android bundle identifier
--domain <domain>    Backend API domain
--no-backend         Skip the Express + Socket.IO backend
--no-deploy          Skip the AWS deploy workflow
--minimal            Skip the example authenticated screen
--no-install         Do not run `bun install`
--no-git             Do not initialize a git repository
--no-register        Do not register an Oxy client
-y, --yes            Accept all defaults (non-interactive)
```

## What you get

```
my-app/
  packages/
    frontend/       Expo Router · NativeWind · Bloom · @oxyhq/services
    shared-types/   Shared TypeScript types
    backend/        Express · Mongoose · Socket.IO · @oxyhq/core/server   (optional)
  .github/workflows/deploy-aws.yml                                        (optional)
```

All Expo config comes from **`@oxyhq/app-preset`** — the config plugin,
`createOxyMetroConfig`, the Babel/ESLint configs, `base.css`, and the tsconfig
bases — so apps track the ecosystem with a version bump instead of copy-pasting.

The frontend ships the canonical provider stack
(`GestureHandlerRootView → KeyboardProvider → SafeAreaProvider →
BloomThemeProvider → OxyProvider → ImageResolver → LocaleProvider`) with the root
`Stack` as the sole `(auth)`↔`(app)` authority, keyed on the device-first
session.

### AWS deployment setup

Before enabling the generated workflow, provision its app-specific IAM role
(`oxy-<slug>-github-deploy`). Its OIDC trust policy must match the generated
GitHub repository exactly, and its permissions must be limited to that app's
`/oxy/<slug>/*` SSM parameters, `oxy/<slug>` ECR repository, and `<slug>` ECS
service. Do not share a deploy role between generated repositories.

## Oxy client registration

By default the CLI offers to register an `Application` + public credential with
Oxy and write the resulting `clientId` into `packages/frontend/.env`. Skip it
with `--no-register` and register manually at https://console.oxy.so.
