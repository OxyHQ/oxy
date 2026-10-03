# Raw linked responses and context changes

Source `bc8c0b3d7` adds `HttpService.requestResponse` for public or authenticated app endpoints and retains the required-auth wrapper `requestAuthenticatedResponse`. Both return the original unread Response, preserving complete app envelopes and streaming bodies. Callers may supply a trusted platform fetch transport and BodyInit; they still cannot provide SDK authority or change the configured origin. Cookie credentials are omitted and redirects rejected. Only absent/string bodies can repeat once after an HTTP 401; multipart, binary and stream uploads are never repeated. Transport failures never automatically repeat writes.

The session epoch now also changes when an existing bearer changes account/session context or is removed. Same-session token renewal preserves the epoch. The guard compares decoded context only for local fencing, never as proof of token authority. A guarded refresh handler may deliberately adopt a new context: its already-installed exact token may be acknowledged, but no stale token is planted. An operation started under the previous context fails with `AUTH_SESSION_CHANGED`; it is neither replayed with another subject nor returned as a late Response. After handing a Response to the caller, the caller owns cancellation of its stream when its session changes.

`rawResponse.test.ts` uses a real loopback HTTP server and deterministic refresh barriers. Synthetic JWTs identify local contexts; this is not a test of server token verification. Multipart and upload/body cancellation use real fetch. The injected platform transport delegates to Node fetch, so these tests do not certify Expo runtime behavior.

## Evidence

- Original raw-seam RED: 8 failures / 1 passing control.
- Race RED: 6 failures / 12 passing controls. Switch, logout, logout followed by sign-in, ABA, and late HTTP 200 responses are covered; the final suite additionally covers a new session for the same account.
- Final full core: 181 suites / 2,208 tests, zero failures.
- Final focal: 4 suites / 51 tests, zero failures. This includes the additional null-to-person guarded adoption case after the full run.
- TypeScript, scoped Biome, build and fresh pack passed. The pack is a local candidate, not a registry release.

Commands run from `packages/core`: `bun run test --runInBand`; focal `bun run test --runInBand --runTestsByPath src/__tests__/rawResponse.test.ts src/__tests__/linkedClient.test.ts src/__tests__/inSessionRefresh.test.ts src/__tests__/httpServiceAuthSelfAwait.test.ts`; `bun run typescript`; scoped `bunx --no-install biome lint --error-on-warnings`; and `bun run build && bun pm pack --destination /home/nate/Oxy/.agent-evidence` in one command. Workspace utils/contracts/protocol/telemetry were built before successful strict TypeScript.

Intermediate failures remain in the logs. The first redirect matcher incorrectly expected an Error instance although the SDK normalizes transport errors to objects. Cancellation during refresh initially produced TIMEOUT and was corrected to CANCELLED. Initial epoch logic invalidated initial anonymous-to-authenticated linked refresh; the final implementation retains initial installation and invalidates existing-context changes. The initial type check lacked built workspace dependencies; the final check passed after building them. One earlier command used the wrong relative working directory, so its empty selection is not counted as RED. The full initial run predates that adjustment and records one linked-refresh failure. No accepted test assertions were weakened to avoid a session race.

This source is additive for consumers: Noted's required raw wrapper remains available. Homiio adoption follows separately. No publication, production request, native Metro update, registry adoption or server financial-effect claim is made here.
