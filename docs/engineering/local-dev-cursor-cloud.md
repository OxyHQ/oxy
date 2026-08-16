# Local development on Cursor Cloud

> Moved out of `AGENTS.md` unchanged.


Local dev is a **Bun workspace monorepo** (`bun@1.3.14`, on `PATH` via `/usr/local/bin/bun`). The startup update script runs only `bun install`. Everything below is not auto-run — do it per session as needed. Standard build/dev/test commands live in the root `README.md`, root `package.json` scripts, and the "Commands" section above; only the non-obvious local caveats are captured here.

**Local infra (not auto-started):**
- **PostgreSQL (required for API + tests)** — start with `docker compose -f docker-compose.dev.yml up -d postgres` (or any local Postgres on `127.0.0.1:5432`). API tests create a throwaway database on every `bun run test` via `jest.globalSetup.ts` and need `TEST_DATABASE_URL` or `DATABASE_URL` pointing at it. Verify with `pg_isready -h 127.0.0.1 -p 5432`.
- **Redis is intentionally unset** — the API falls back to in-memory stores (BullMQ queues, distributed rate limiting, and the multi-instance Socket.IO adapter are disabled). This is fine for local dev.
- **`packages/api/.env`** holds local dev config (Postgres `DATABASE_URL`, locally-generated JWT/`DEVICE_ID_SALT` secrets, and placeholder `AWS_*` values). It is gitignored and persists on the VM. `packages/api/src/config/env.ts` hard-requires `DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` to boot (`DEVICE_ID_SALT` is required in production; dev installs a placeholder when unset). Values are only validated for presence/shape, not connectivity. The placeholder S3 creds let the API boot; **S3-backed features (avatar / email-attachment uploads) will fail** until real S3 or a local MinIO (`AWS_ENDPOINT_URL`) is configured — auth/signup/login flows do not touch S3.

**Build shared libs before running apps:** the API and the web apps resolve `@oxyhq/contracts`, `@oxyhq/protocol`, `@oxyhq/core`, and `@oxyhq/services` from their built output (`dist/` / `lib/`), NOT from source. Built output persists in the VM snapshot, but after changing any of those packages' source you must rebuild them (e.g. `bun run core:build`, `bun run services:build`, or `bun run build:all`) or downstream `bun --watch`/Vite dev servers fail to resolve the workspace dep (Vite reports `@oxyhq/services ... could not be resolved`). The API dev server needs contracts+protocol+core built; the web apps additionally need `@oxyhq/services` built.

**Run the stack (dev mode):**
- API: `bun run api:dev` → Express + Socket.IO on **:4100** (`GET /health` → `{"status":"operational"}`). Hot-reloads via `bun --watch`.
- Auth IdP web app: `VITE_OXY_API_URL=http://localhost:4100 bun run --filter auth dev` → Vite on **:8105**. Point every web/Expo frontend at the local API via its own env var (`auth`: `VITE_OXY_API_URL`; `console`: `VITE_OXY_URL`; Expo apps: `EXPO_PUBLIC_API_URL`). Loopback origins are trusted on the credentialed CORS lane, so `http://localhost:*` can hit the local API directly.

**Hello-world sanity check (auth end-to-end, no S3/Redis needed):**
```bash
curl -s -X POST http://localhost:4100/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"devtest@example.com","username":"devtester","password":"HelloWorld123!","name":{"first":"Dev","last":"Tester"}}'
curl -s -X POST http://localhost:4100/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"devtester","password":"HelloWorld123!"}'
```
Signup passwords must include a special character (server-enforced, beyond the Zod `min(8)`). Both return a device-first session (`accessToken` + `deviceSecret`); use the token as `Authorization: Bearer` against `GET /users/me`. The `auth` web app drives the same flow through its multi-step login form.
