/**
 * Resolve `@oxy.so/contracts` from SOURCE for `bun test`.
 *
 * The auth app imports `@oxy.so/contracts` at RUNTIME (`lib/schemas.ts`
 * re-exports the canonical response schemas from it). The package's
 * `main`/`exports` point at `dist/` (the published build), so when the test
 * suite runs in CI WITHOUT `packages/contracts/dist` pre-built, the import
 * fails with `Cannot find module '@oxy.so/contracts'`. That makes the auth
 * tests depend on workspace build order, which is fragile.
 *
 * Bun's test runner has no jest-style `moduleNameMapper`, so the analogous fix
 * is `mock.module` (the same mechanism `setup-mocks.ts` already uses for
 * native-only modules): point the `@oxy.so/contracts` specifier at the package
 * SOURCE. The source uses extensionless relative imports and depends only on
 * `zod`, so it resolves with no build. This must run BEFORE any test file (or
 * `@/lib/schemas`) imports `@oxy.so/contracts`, hence it is the first preload.
 *
 * This is TEST-ONLY: it lives in the test preload and never affects the Vite
 * app build or the worker, which keep consuming the built package.
 */
import { mock } from "bun:test"
import * as contractsSource from "../../../contracts/src/index"

mock.module("@oxy.so/contracts", () => contractsSource)
