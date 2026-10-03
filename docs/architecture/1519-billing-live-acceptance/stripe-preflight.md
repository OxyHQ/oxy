# I08 production account/mode and Portal preflight

Prepared only. This closes the missing *operator mechanism*, not the live acceptance criterion. Root executes a fresh reviewed plan after service restoration; no task, provider call, configuration change or financial effect has occurred while preparing this source.

## Evidence required by the approved issue

[Peable#87](https://github.com/OxyHQ/Peable/issues/87), its four comments and `docs/integrations/i08-approved-recurring-cohort.md` require the same existing Mercaria platform account/mode/MoR, one exact merchant/app/environment cohort and no implicit activation. The current execution plan makes production account/mode readback a prerequisite to cohort configuration. Local sandbox account acct_1TnXkUQWiCE02OnU does not establish the deployed account or mode.

The Peable provider's existing contract requires an explicit active Portal configuration with matching livemode, subscription_update disabled, and subscription_cancel either disabled or at_period_end. It verifies this configuration at each call. A configuration with immediate enabled cancellation or subscription updates is reported incompatible; the preflight never changes it. No default is selected automatically, no products/prices/customers are listed or created, and no on_behalf_of/Stripe-Account is sent.

## Reused transport and secret boundary

`scripts/operations/billing-live-acceptance/stripe-preflight-ecs.py` is a narrowly adapted copy of the reviewed inventory transport. Closed profiles are Mercaria and Peable, explicit task-definition families oxy-mercaria/oxy-peable. It validates stable service/task count, image digest, ARM64, network, inherited log prefix and execution role against freshly described metadata. It revalidates the returned and described temporary definition before RunTask.

The **only** admitted secret is the already deployed `STRIPE_SECRET_KEY` reference `arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mercaria/STRIPE_SECRET_KEY`. An inline key or any different reference is refused; no secret value is queried by the launcher. The task has no taskRole, database, server/bootstrap, ports, sidecars, mounted files or other secrets. A future Peable reference/configuration change remains a separate reviewed operation; this launcher does not create one. If the selected deployed container has no reference, preparation writes a private metadata plan with configured=false/status=existing_stripe_reference_absent_no_task_prepared, no executable definition, and zero provider requests. Do not execute that plan.

The task runs the fixed Node reader under the exact existing image. It uses native fetch for GET only, pinned `Stripe-Version:2026-07-29.dahlia`, redirect:error,≤10s per request,≤512KiB streamed response,≤six GETs. There is no Stripe SDK/application import, dotenv, migration, business dispatcher or retry. The reader fetches its own account and a bounded Portal configuration census (≤three pages/100 per page); an explicitly reviewed bpc_ selector adds one retrieve and must match its census projection. Duplicate/cyclic/incomplete pages, mode mismatch or list/retrieve drift reject instead of producing acceptance. The reader emits only id/mode/active/default and subscription update/cancel flags. It omits names, URLs, email, account requirements, metadata, key bytes/hash and arbitrary provider errors.

Account responses do not provide a livemode field. Mode evidence is the actual injected key prefix (sk_/rk_ test/live) plus each returned Portal configuration's livemode. This is explicit configuration evidence, not proof that test becomes live, a secretless assertion, or a remote atomic snapshot. Key never leaves the task. Its only network paths are GET /v1/account, GET /v1/billing_portal/configurations and GET /v1/billing_portal/configurations/bpc_<reviewed id>.

## Root commands

The examples intentionally require an ACTUAL positive revision from fresh service capture. None is pinned to the historical59/7 deployment. Private parent must be0700/owned by root operator.

```bash
python3 -B scripts/operations/billing-live-acceptance/stripe-preflight-ecs.py mercaria --definition oxy-mercaria:ACTUAL_REVISION --plan /PRIVATE/mercaria-stripe-discovery.json
python3 -B scripts/operations/billing-live-acceptance/stripe-preflight-ecs.py peable --definition oxy-peable:ACTUAL_REVISION --plan /PRIVATE/peable-stripe-discovery.json
```

Preparation is AWS metadata read-only. Root reviews raw plan-file SHA256, current source/reader hashes, image/definition/configuration, sole reference and task shape. An admitted configured plan expires in≤1h and executes once:

```bash
python3 -B scripts/operations/billing-live-acceptance/stripe-preflight-ecs.py mercaria --definition oxy-mercaria:ACTUAL_REVISION --plan /PRIVATE/mercaria-stripe-discovery.json --plan-sha256 RAW_FILE_SHA256 --execute --output /PRIVATE/mercaria-stripe-result
```

The initial discovery lists candidates and sets portalSelectionRequired=true, selectedPortalCompatible=null. Root can then choose an **existing** explicit configuration supported by the approved features and prepare a second read-only plan with `--portal-ref bpc_ACTUAL_ID`; use the same selector in execute. This proves that exact configuration rather than inventing a new one. Discovery with zero configurations or no compatible candidate is an actionable blocker; no creation/update is implied.

Every dispatch has an exclusive fsynced intent before RunTask, stable nonce/clientToken/startedBy and no automatic retry. Reconcile an unknown launch response by original identifiers before any repeat; an INACTIVE definition is not proof that no task ran. All acknowledged tasks must read back STOPPED and their temporary definition INACTIVE. Raw account/provider data and key are never logged. The result private projection/receipt binds the image, plan and result digest; ordinary output contains only packet projections. Root reviews cleanup independently.

## Acceptance interpretation

Compare the two actual accountId/mode projections only when both are configured and complete. If Peable remains unconfigured, record that absence and preserve its existing disabled recurring path. A deployment retaining Mercaria's key reference may subsequently be prepared and reviewed, without broad one-off/global rail activation. Any new deployment must be read back again, not inferred from this plan.

For a technical development merchant, only a verified test-mode cohort is coherent. If the existing Mercaria key is live, do not force that merchant into a production cohort or create a new sandbox namespace/key by inference; record the exact namespace discrepancy for the already approved configuration work. The stable store IDs and owner memberships come from the separate SQL inventory; the merchant/namespace comes from actual published SDK readback. No merchant owner is assumed to be the payer, and no new store/cohort/price is fabricated.

A compatible selected Portal, exact two-side account/mode match, actual merchant/app/environment/store bindings, published SDK adoption and ingress verification are separate gates before activating actions. Preserve durable cohort routing when actions are disabled, rather than falling through to a legacy mutator. This preflight does not cover a payment, refund, provider session creation, webhook delivery or customer-reference import.

## Source and API references

The pinned API version and platform read are the existing Mercaria/Peable Stripe client contract. [Stripe account retrieval](https://docs.stripe.com/api/accounts/retrieve), [Portal configuration listing](https://docs.stripe.com/api/customer_portal/configurations/list) and [Portal configuration retrieval](https://docs.stripe.com/api/customer_portal/configurations/retrieve) document the GET/configuration surfaces and pagination. Existing Peable `stripeBillingProvider.ts` defines the exact compatibility flags above.

Local fixtures use fake fetch/Responses and AWS stubs; no real provider/AWS/SQL call is claimed. Eight transport cases check exact secret/container/input preservation and six inherited packet/source controls. Eleven reader cases check projection, GET bounds, mode, incompatible flags, explicit selection, pagination/drift/stream/error rejection and nonce encoding. Root must supply actual postdeployment evidence before marking I08's cohort gate complete.
