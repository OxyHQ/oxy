# Engineering

Oxy is the default owner of ecosystem-wide engineering standards: a rule that applies to more than one repository lives here, and other repositories link to it by GitHub URL instead of copying it.

## Standards

| Doc | What it covers |
|---|---|
| [standards.md](standards.md) | The standard root scripts every repository exposes (`lint`, `lint:fix`, `format`, `test`, `typecheck`, `build`, `check`) |
| [lint-and-format.md](lint-and-format.md) | Biome configuration, the ESLint that remains, and the traps |
| [api-conventions.md](api-conventions.md) | HTTP API contract, errors, and the keyset and offset cursor contract |
| [project-map.md](project-map.md) | Every Oxy repository, what it is for, and how the AI products relate |

## Writing and verifying checks

| Doc | What it covers |
|---|---|
| [gate-writing.md](gate-writing.md) | How to write a gate, census, generator or CI check that can actually fail |
| [build-and-runtime-traps.md](build-and-runtime-traps.md) | Build-freshness, Bun, Metro, Reanimated and Hermes traps |
| [mobile-e2e-isolation.md](mobile-e2e-isolation.md) | Requirements for mobile end-to-end tests that must not reach real services |

## Working with agents

| Doc | What it covers |
|---|---|
| [agent-team-workflow.md](agent-team-workflow.md) | Lead and worker roles, worktrees, handoffs |

## Elsewhere in `docs/engineering/`

Packaging, Docker and AWS: [package-rules.md](package-rules.md) and [build-and-deploy.md](build-and-deploy.md). SDK internals: [sdk-patterns.md](sdk-patterns.md). Git diffs and rebases: [measurement-traps.md](measurement-traps.md). Postgres and Drizzle, and the id-shape rule: [../postgres-and-drizzle.md](../postgres-and-drizzle.md).
