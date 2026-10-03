# CI fixture compatibility follow-up

Run37092451244 on26cf80a5e exposed two source-compatible fixture omissions and one Console type vocabulary omission. API5 expected3600 after the approved issuer moved to300; API6 compared resolver DTOs without the new durable epoch. Four strict equalities now explicitly assert0 before direct seed revoke,1 after revoke,2 after unrelated consent writes, and1 after ordinary trusted sign-in. Authorized/scopes and refusal-marker assertions remain unchanged.

Console AccountPermission now includes the backend's existing credentials:manage; the repository vocabulary guard passes30 account and23 application permissions. No grant or permission expansion occurs at runtime.

The two actual API suites pass47 tests on fresh owned PostgreSQL17 with normal migration139. API scoped ESLint passes. Console scoped ESLint still fails one unchanged no-unnecessary-condition diagnostic in hasImplicitOwnership; the exact26cf baseline also fails at the corresponding line. This change does not conceal that baseline diagnostic. Raw CI logs, the actual local test stdout and launcher/guard/lint records are hashed by proof.json.

Reproduce from source root: `python3 scripts/rehearsal/test-approved-api-1519.py src/services/__tests__/workloadIdentity.db.test.ts src/routes/__tests__/oauthConsentGrants.test.ts` and `bun scripts/check-permission-vocabulary.mjs`. No provider requests, deployment or financial effect. Final integrated CI is tracked at the subsequent pushed head; Forge remains INACTIVE before the final freeze.
