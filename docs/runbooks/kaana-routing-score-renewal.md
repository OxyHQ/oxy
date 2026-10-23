# Renew the reviewed Kaana routing scores

## Trigger

Every reviewed scorecard has a `validUntil`. Runtime refuses the **complete**
route set once any selectable route's score for the requested optimisation is
stale ([routing](../inference/routing.md)), so every Kaana-backed product surface
fails at that instant. The daily
[`kaana-routing-score-expiry-monitor.yml`](../../.github/workflows/kaana-routing-score-expiry-monitor.yml)
goes red and opens the issue "Kaana routing scores expire within 7 days" a week
before the cliff. Renew then, not on the day.

Routes written by the Kaana catalogue sync carry only a `price` score, which
has no validity window, so they never trigger this monitor. The census still
refuses one that lacks its price, price version or `requests` unit, or that
shares a model revision with a measured route (it would refuse that model's
latency, throughput and balanced ranking).

This path renews validity only, with the **same** scores, sources, evidence and
measurement windows, after an owner approval. Changing a score is a new review,
not a renewal.

The renewed validity is derived, never written down: `changedAt` is the start of
the run's UTC day and `validUntil` is `KAANA_REVIEWED_SCORE_VALIDITY_DAYS` (30)
days later ([routing](../inference/routing.md#score-validity)). Every reviewed
route (the three gpt-oss routes, xAI speech and xAI realtime voice) is renewed
together. A route whose reviewed values differ from
`packages/api/src/config/kaanaInitialCatalogue.ts`, or whose current state has
no matching provenance event, is drift and refuses the whole run. No source edit
or deploy is part of a renewal.

## Procedure

1. Only if the dedicated task's image is not the live `oxy-api` digest (step 2
   tells you): in `oxy-infra`, dispatch `terraform-uswest2.yml` with
   `action=plan`, then `action=apply`, targeting
   `terraform_data.kaana_catalogue_bootstrap_image_pin aws_ecs_task_definition.kaana_catalogue_bootstrap`.
   The plan must show the deployed `oxy/oxy-api@sha256:` digest and nothing
   else; the pin tags that digest `pinned-` so ECR never expires it while the
   task names it.
2. Read back the three exact inputs:
   `aws ecs describe-services --cluster oxy-cluster --services oxy-api` (the
   task-definition ARN and its image digest) and
   `aws ecs describe-task-definition --task-definition oxy-kaana-catalogue-bootstrap`
   (the new revision ARN; its image must equal the live digest).
3. Dispatch `renew-kaana-routing-scores.yml` from `main` with `mode=dry-run`,
   the three inputs and `reviewer_user_id=6981c9178fcdefaf81988ffb`. Read the
   planned renewals, the renewed validity and the plan SHA-256 from the job
   summary. Drift fails here and writes nothing.
4. The same UTC day, dispatch it again with `mode=apply`, the same inputs,
   `expected_plan_sha256` from step 3 and a single-line `reason` naming the
   owner approval. On a later day the plan names a later validity, so the apply
   refuses; dry-run again.

## Verify

The apply run itself proves the result: the apply result must carry the
reviewed plan, a fresh dry run must plan zero operations, and the read-only
readiness command must pass at the monitor's seven-day horizon. Then dispatch
`kaana-routing-score-expiry-monitor.yml` once and require it green.

## Rollback

None needed and none offered: validity only moves forward, the previous state
stays in the append-only `inference_deployment_routing_score_events`, and the
scores themselves never change. To shorten validity, author a reviewed
scorecard through the staff API.

## Break-glass

If the workflow path is unavailable before the cliff, a staff user holding
`inference:catalogue:publish` can `PUT
/inference/admin/kaana-deployments/:kaanaDeploymentId/routing-scorecard` with
the complete scorecard (the same reviewed values) and the new `validUntil`. That
write is audited (one event per call, at its wall-clock `changedAt`), so the
bootstrap and the next renewal accept it as long as the reviewed values are
unchanged.
