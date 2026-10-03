# Coordinated frontend dispatch

These six copies add manual dispatch to the existing frontend workflow. They
are prepared for composition after review; none has been dispatched. Copy only
when the source workflow still matches `beforeSha256` in `manifest.json`.

Root dispatches on `main` with `expected_sha=<exact current main SHA>` and
`ci_run_id=<successful push run for the same repository/SHA>`. The helper checks
both the dispatch and checkout SHA, reads current main, and reads that exact CI
run. It requires `completed/success`, `push/main`, the same head repository and
`.github/workflows/ci.yml` (website uses `checks.yml`). It fails closed on read
errors. The only new permission is `actions: read` in the jobs needing this
check. No additional credentials or deployment targets are introduced.

Original push/workflow_run branches, scope filtering, builds, tests, smokes,
rollback behavior and marker updates are preserved. Mention's manual path
passes the new gate before returning `release=true`; its automatic path still
calls `release-provenance.sh`. Both Mention and CrowdSource still require their
current-main checks and deployment-scope predicates. TNP still runs its
`verify` job and makes deployment depend on it. Clarity/Nilo/TNP/website check
manual provenance again immediately before deployment; Mention/CrowdSource
already repeat their current-main guard before deployment.

`OXY_1519_ROLLOUT_HOLD=true` prevents admission to the affected jobs. This is a
job admission guard, not cancellation of an already-running job. Root separately
captured zero active runs and disabled the previous deployment workflows. A
manual dispatch is used only after deliberate restoration of the appropriate
workflow and hold, with current-main CI accepted. Existing automatically
triggered runs are not evidence of a completed deployment.

Validation: five Python tests cover matching CI, wrong event/ref/SHA/checkout,
hold, stale main, wrong workflow/repository/CI status and API failure. Six parsed
YAML comparisons assert the original event definitions, job names/dependencies
and all existing steps remain unchanged (except Mention's explicit manual
branch around its existing provenance command). These are offline tests, not
GitHub execution or Cloudflare deployment evidence.

Commands from the plan worktree:

```bash
python3 scripts/adoption/frontend-dispatch/test-verify-manual-frontend.py
node scripts/adoption/frontend-dispatch/test-templates.cjs <installed-yaml-package-path>
```

The parser used in this proof is Mention's already-installed `yaml` package;
no dependencies were installed for this preparation.
