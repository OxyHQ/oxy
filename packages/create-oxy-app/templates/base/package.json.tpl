{
  "name": "{{APP_SLUG}}",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "packages/shared-types",
    "packages/frontend"{{#backend}},
    "packages/backend"{{/backend}}
  ],
  "scripts": {
    "dev:frontend": "bun run --cwd packages/frontend start",
    "build:shared-types": "bun run --cwd packages/shared-types build",
    "build:frontend": "bun run --cwd packages/frontend export:web",
    "lint": "bun run --cwd packages/frontend lint",
    "postinstall": "bun run build:shared-types"{{#backend}},
    "dev:backend": "bun run --cwd packages/backend dev",
    "build:backend": "bun run --cwd packages/backend build",
    "db:generate": "bun run --cwd packages/backend db:generate",
    "db:migrate": "bun run --cwd packages/backend db:migrate",
    "build": "bun run build:shared-types && bun run build:backend"{{/backend}}
  },
  "overrides": {
    "@oxyhq/core": "{{v.oxyCore}}",
    "@oxyhq/bloom": "{{v.oxyBloom}}"
  },
  "resolutions": {
    "@oxyhq/core": "{{v.oxyCore}}",
    "@oxyhq/bloom": "{{v.oxyBloom}}"
  }
}
