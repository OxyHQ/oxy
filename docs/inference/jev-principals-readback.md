# Jev principals readback

A metadata-only readback of the two principals a Jev synthetic-classification
canary could plausibly run as, for review BEFORE any such canary is proposed:

- **Mention** (`6a2f851751b784a86fd0e916`), attested by its ECS task role
  `arn:aws:iam::237343248947:role/oxy-mention-task`. Mention already calls
  `OxyInferenceClient` with that service token against `/v1/responses` for its
  PostClassification, which is why the same application is a plausible
  principal for synthetic classification.
- **Kaana** (`68b7c4e19f2a6d0e3c8b5174`), whose existing credentials are
  listed as metadata.

| Piece | Path |
|---|---|
| Command | `packages/api/scripts/readback-jev-principals.ts` |
| Pure validator | `packages/api/src/scripts/jevPrincipalsReadback.ts` |
| Isolated task builder | `packages/api/scripts/build-jev-principals-readback-task.ts` → `packages/api/src/scripts/jevPrincipalsReadbackTask.ts` |
| Tests | `packages/api/src/scripts/__tests__/jevPrincipalsReadback.test.ts`, `inboxPrincipalReadbackTask.test.ts` |

## Operator scope

- A `ready` result is evidence for review. It is NOT a dispatch approval, a
  provider activation or a grant, and nothing is granted, seeded or
  provisioned implicitly by running it.
- A final canary still needs its own legitimate purpose and must pass the
  routing and rollout gates separately.
- Inbox is a separate production application: its key and credential are not
  read here and must not be repurposed for this.
- Nothing is written. No binding, workload credential, billing profile,
  balance or grant is constructed or materialised; no attestation or token is
  minted; no HTTP call or inference is made.

## What it reads

Only `DATABASE_URL`. All reads share ONE snapshot: the first transaction
statement is `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`, and
`SHOW transaction_read_only = on` plus `SHOW transaction_isolation =
repeatable read` are verified before any data read. No public key, secret,
hash, token or name column is selected.

### Mention

The rules are those of `resolveLiveAgencyWorkloadByHandle`, re-applied inside
the snapshot (the live resolver reads outside it):

- **Handle**: `wl_d61be5cd068abb658ed4d193` is pinned and re-derived on every
  run with `canonicalWorkloadSubject('aws-iam', role)` and
  `workloadAttestationHandle`. A mismatch refuses to run.
- **Binding**: the one `application_workload_identities` row for provider
  `aws-iam` and the exact role, naming the Mention application and unexpired
  at PostgreSQL `now()`.
- **Materialised credential**: the `application_credentials` row whose id IS
  the handle must exist, be `type = 'workload'`, belong to Mention, link to that
  binding by `workload_identity_id`, be `active` and unexpired. It is never
  assumed live and never created here.
- **Application and owner**: Mention `active` and trusted first-party
  (`isTrustedApplication`); owner `active` with no closure fence.
- **Authority**: `workloadBindingScopes(binding.scopes, application.scopes)`
  includes `inference:invoke` — the definition the mint and the live ceiling
  share. A workload row holds no scopes (its CHECK keeps them empty), so it
  narrows nothing; it must exist, be bound and be live.
- **Billing**: `resolveBillingAccount(tx, owner)` on the same transaction, so
  the account that would actually be charged, ancestors included
  (`inheritedFromAncestor` says which). Its USD `account_balances` projection
  must be reproduced by the journal, carry at least one `promotional_grant`, and
  `promotional − reserved ≥ 0.01 USD`. Purchased money and an invoiced credit
  line never count. A negative bucket refuses to run.

### Kaana

Every `application_credentials` row of the Kaana application, as `id`,
`type`, `status`, `usable` (active and unexpired) and
`effectiveInferenceInvoke` (usable, application active, and
`intersectScopes(credential, application)` includes `inference:invoke`).
`usableInvokeCredentialCount` counts the last.

## Result

One line, `JEV_PRINCIPALS_READBACK_RESULT=<json>`: `status`, typed
`blockedReasons`, `database`, Mention's application, owner, workload
credential, binding and billing-account IDs with the invoke boolean and USD
amounts, and Kaana's application and owner IDs, the credential summaries and
the count. No key, label, name, subject, scope list, hash or error text.

Blocked reasons: `mention_application_missing`, `mention_application_inactive`,
`mention_application_untrusted`, `mention_owner_missing`,
`mention_owner_inactive`, `mention_binding_missing`,
`mention_binding_wrong_application`, `mention_binding_expired`,
`mention_credential_missing`, `mention_credential_not_workload`,
`mention_credential_wrong_application`, `mention_credential_unbound`,
`mention_credential_inactive`, `mention_credential_expired`,
`mention_effective_invoke_missing`, `mention_billing_not_provisioned`,
`mention_billing_currency_not_usd`, `mention_balance_missing`,
`mention_ledger_projection_mismatch`, `mention_promotional_grant_missing`,
`mention_missing_funds`, `kaana_application_missing`,
`kaana_application_inactive`, `kaana_owner_missing`, `kaana_owner_inactive`,
`kaana_invoke_credential_missing`.

Exit codes: `0` ready, `2` blocked (result printed), `1` failure (fixed
message only).

## Isolated task and run path

`build-jev-principals-readback-task.ts` applies the same allowlist as the
[Inbox principal readback](inbox-principal-readback.md#isolated-task) to the
exact reviewed live `oxy-api` task definition, with family
`oxy-oxy-api-jev-principals-readback`, command
`run packages/api/scripts/readback-jev-principals.ts` and ONE secret,
`DATABASE_URL` from `arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL`.
Sidecars, the task role, all environment, every other secret (the Inbox key
included), ports, mounts and dependencies are dropped; the live execution role,
awslogs destination and immutable image digest are kept.

The operator run path is the
[Inbox one](inbox-principal-readback.md#run-path-operator-manual) with three
substitutions: the builder `build-jev-principals-readback-task.ts`, the
`--started-by jev-principals-readback` value, and the result prefix
`JEV_PRINCIPALS_READBACK_RESULT=`. It has not been run; the live image must
already contain the command.

## Alia Auto candidate
The same snapshot also reads Alia application `6a2f851751b784a86fd0e934`, bound only to `arn:aws:iam::237343248947:role/oxy-alia-task`. Its workload handle is derived canonically, never assumed live. The existing binding, materialized credential, effective invocation authority, owner and inherited billing journal are validated separately from Mention.
The allowlisted `alia` result has its own `status` and typed-prefix blocked reasons. This concerns synthetic classification within Alia's own Auto parent principal; it never authorizes borrowing Alia for Mention. Metadata readiness does not activate Auto, mint a token or approve dispatch. `autoClassifierApproval` and provider/route gates remain closed.
