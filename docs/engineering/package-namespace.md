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
| `@oxy.so/utils` | Dependency-free helpers shared across services |
| `@oxy.so/mcp` | Model Context Protocol integration |
| `@oxy.so/federation` | Federation primitives |
| `@oxy.so/services` | React and React Native SDK |
| `@oxy.so/app-preset` | Shared Expo application configuration |
| `@oxy.so/expo-splash` | Expo splash-screen integration |
| `@oxy.so/ship` | Application release CLI |
| `@oxy.so/doctor` | Dependency health checks |
| `@oxy.so/api` | Oxy API service package |

`@oxy.so/utils` holds only helpers that are copied byte-identically into three
or more REPOS, are pure and dependency-free, and that no repo could reasonably
want a different version of. All three, not any of them — the third clause is
what keeps it from becoming a junk drawer, and its README lists the duplication
that was examined and deliberately left alone (query-param coercion, retry
policy, number formatting), each because the shared version would have had to
overrule a decision some repo made for a measured reason. ADR 0022 is the
precedent: per-app i18n stays duplicated because one catalogue would carry the
wrong weight.

Bloom is developed in its own repository and is published as
`@oxy.so/bloom`. Alia and Clarity retain their existing package scopes because
they are separate product families.

Use `workspace:` relationships inside this monorepo. Consumers should use the
declared semver ranges and run `bunx @oxy.so/doctor` locally or in CI to detect
outdated and duplicate Oxy dependencies.
