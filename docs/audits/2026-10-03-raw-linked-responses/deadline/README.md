# Cancel pending auth waits without cancelling the shared refresh

I11 review exposed that checking AbortSignal only after awaiting auth cannot enforce a caller deadline. Two real HTTP regression cases hold the shared refresh indefinitely, abort the caller and require rejection before releasing the refresh gate: zero transports during auth preflight, exactly one during post-401 refresh. They then release the gate and verify the shared refresh remains usable and the cancelled request never dispatches again.

RED: 2 failures / 23 passes. GREEN: 3 suites / 51 passes; TypeScript and scoped lint pass. Build and fresh pack ran together. The new local pack has its own directory, preserving the prior accepted tarball and proof hashes. This follow-up does not change refresh authority or abort the shared promise.

Commands from packages/core: `bun run test --runInBand --runTestsByPath src/__tests__/rawResponse.test.ts src/__tests__/linkedClient.test.ts src/__tests__/inSessionRefresh.test.ts`; `bun run typescript`; scoped Biome; `bun run build && bun pm pack --destination /home/nate/Oxy/.agent-evidence/i04-raw-response-deadline-pack`.
