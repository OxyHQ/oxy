# Real OAuth browser preparation

Source8a20b7b03 prepares actual API/IdP and two registered third-party RPs.
Build/typecheck/lint and normal PostgreSQL140fresh/repeat passed. Frozen host is
ready for root Chromium at the manifest in proof.json; no browser flow has run.
The two earlier owned hosts stopped after parentSIGTERM. Raw preparation errors
are retained and identified, rather than treated as acceptance passes.

API `bun run build`, services `bun run build`, auth `bun --no-env-file run build`;
RP `VITE_OXY_CLIENT_ID=oxy_fixture_build_only VITE_FIXTURE_LANE=build bun --no-env-file node_modules/vite/bin/vite.js build scripts/rehearsal/real-oauth-browser --config scripts/rehearsal/real-oauth-browser/vite.config.ts`.
Types `node node_modules/typescript/bin/tsc -p packages/api/tsconfig.scripts.json --noEmit`;
ESLint in packages/api `bun --no-env-file node_modules/eslint/bin/eslint.js scripts/real-oauth-browser-api.ts`.
See tracked fixture README for authority/network boundaries and planned cases.
No packed/registry equivalence, OAuth pass, SSO pass or production pass claimed.
