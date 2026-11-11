# Standard root scripts

Every JS/TS repository exposes the same script names at its root `package.json`, so a person or an agent can run the same command in any repository and a CI job can call the same entry point. Workspaces behind a root script may be named differently; the root script is the contract.

| Script | Does | Writes files |
|---|---|---|
| `lint` | Biome over the whole repository: `biome check .` (format, lint and assists). In a repository whose Expo frontend keeps a minimal ESLint, it then runs that package's `lint` too. CI runs `biome ci .` instead, which never writes and treats warnings per the repository's config | no |
| `lint:fix` | `biome check --write .` | yes |
| `format` | `biome format --write .` (formatting only) | yes |
| `test` | Every workspace's test suite, one command. Never a bare `bun test` at the root of a repository whose packages use Jest or Vitest | no |
| `typecheck` | `tsc --noEmit` (or `tsc -b`) for every workspace, after building any package whose declarations another workspace reads from `dist/` | no |
| `build` | Build every deployable or publishable workspace in dependency order | build output only |
| `check` | The local equivalent of the CI gate: everything above that CI runs plus the repository's own validators (for example `validate:agents-md`, workflow and lockfile checks, `oxy-doctor --ci`), in CI's order, using CI's commands | no |

Rules:

- A script that CI runs is the script a person runs. If CI needs a different invocation (`biome ci .` instead of `biome check .`), the difference is only that CI never writes; document anything else next to the script.
- `check` aggregates; it does not replace the individual scripts. A failing `check` names which script failed.
- A repository without a given script omits it rather than defining a no-op. Do not add a script that always passes.
- Biome's configuration, the ESLint that remains and the traps are in [lint-and-format.md](lint-and-format.md).
- Scripts that read source as text (regex tests, byte-pinned files) must be excluded from the formatter or updated with it; see the same document.

## Current state

The names `lint`, `lint:fix` and `format` are present in every Biome repository and mean what the table says. `test`, `typecheck`, `build` and `check` are present in some repositories and missing or partial in others, and `check` currently aggregates different sets: Mention's builds and typechecks the workspace, CrowdSource's runs its doctor, workflow, AGENTS.md and security validators, Move's runs the AGENTS.md and gate validators with typecheck and build. Repositories converge on the table as they are touched; this document is the target, not a statement that every repository already complies. A few repositories make `lint` stricter with `--error-on-warnings`.

Non-JS exceptions: Kaana is a Go data plane and exposes `make check` (gofmt, build, vet, lint, test, contract) as its aggregate, with `bunx biome ci .` for its TypeScript packages. Astro is a pnpm and Turbo workspace and exposes `test`, `typecheck` and `build` through Turbo. Check a repository's own `AGENTS.md` for its exact commands.
