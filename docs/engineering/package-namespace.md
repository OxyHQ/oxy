# Oxy package namespace

All public Oxy platform packages use the `@oxy.so` npm scope and start their
release history in that scope at `1.0.0`. Source code, examples, generated
contracts and application templates import the canonical names directly; the
repository does not ship compatibility aliases.

| Package | Purpose |
|---|---|
| `@oxy.so/contracts` | Shared Zod request and response contracts |
| `@oxy.so/protocol` | Signed records and canonical envelopes |
| `@oxy.so/telemetry` | Privacy-preserving telemetry primitives |
| `@oxy.so/core` | Platform-neutral client and server helpers |
| `@oxy.so/db` | Shared PostgreSQL schema utilities |
| `@oxy.so/mcp` | Model Context Protocol integration |
| `@oxy.so/federation` | Federation primitives |
| `@oxy.so/services` | React and React Native SDK |
| `@oxy.so/app-preset` | Shared Expo application configuration |
| `@oxy.so/expo-splash` | Expo splash-screen integration |
| `@oxy.so/ship` | Application release CLI |
| `@oxy.so/doctor` | Dependency health checks |
| `@oxy.so/api` | Oxy API service package |

Bloom is developed in its own repository and is published as
`@oxy.so/bloom`. Alia and Clarity retain their existing package scopes because
they are separate product families.

Use `workspace:` relationships inside this monorepo. Consumers should use the
declared semver ranges and run `bunx @oxy.so/doctor` locally or in CI to detect
outdated and duplicate Oxy dependencies.
