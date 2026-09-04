# Bootstrap or retire the native product agents

Use the manual **Bootstrap native product agents** workflow on `main`. It runs
the repository bootstrap from the task definition currently serving
`oxy-cluster/oxy-api` in `us-west-2`; it never deploys an image and never accepts
an application, credential, account or agent selector from the operator.

The immutable bindings are:

| Product identity            | Exact value                            |
| --------------------------- | -------------------------------------- |
| Oxy organization            | `69b2d3df5d12f58c9800d651`             |
| Homiio project account      | `6a50444ce8026582b949089d`              |
| Homiio application          | `6a2f851751b784a86fd0e922`             |
| Sindi bot account           | `01a0646a-078f-7974-9645-a5e8be237f47` |
| Sindi service credential    | `01a0648e-ad3f-7608-aa8b-c07bfef6cf73` |
| Sindi Alia agent            | `01a0646a-078f-7514-9800-9f43ceed7df8` |
| Clarity project account     | `01a0646a-078f-7f53-848d-a0f82d9f7fa6` |
| Clarity bot account         | `01a0646a-078f-7120-a993-a03c180c81b0` |
| Clarity public application  | `01a0646a-2382-74a3-a795-788924d55722` |
| Clarity public credential   | `01a0646e-2508-7048-8c08-b1f7b3af634f` |
| Clarity backend application | `01a0648b-8d73-70ad-8e67-1c07ddc5eb6e` |
| Clarity backend credential  | `01a0648b-8d74-7240-adba-80707fdfdf9c` |
| Clarity Alia agent          | `01a0646a-078f-7642-95ef-439952f4f3f9` |

Names are collision diagnostics only. PostgreSQL writes and the Alia hand-off
use those exact primary keys.

## Bootstrap

1. Confirm the live Oxy image contains
   `packages/api/scripts/bootstrap-native-product-agents.ts` and
   `run-native-product-agent-bootstrap.sh` from the same reviewed release.
2. Run `dry-run-bootstrap`. It uses OIDC and a one-shot Fargate task, rolls the
   PostgreSQL transaction back and does not read, create or change SSM secrets.
   Any `live_state_drift`, owner mismatch or structural mismatch is a hard stop:
   diagnose the exact immutable fields from an operator-safe projection, never
   select or repair an account by name, list position or first match.
3. Review the complete CloudWatch plan and copy the printed lowercase
   `planSha256`.
4. Run `apply` from the same `main` revision with that exact hash and a
   non-empty change/ticket reason. The authenticated GitHub actor is the audit
   actor; it is not an operator-editable input.
5. The apply lane repeats a dry preflight before touching SSM. For a credential
   absent from PostgreSQL, it creates its pair once if both parameters are
   absent. For an existing credential, both parameters must already exist; the
   workflow never invents a replacement secret for that fixed ID.
6. The four exact parameters are SecureStrings:

   - `/oxy/homiio/SINDI_OXY_SERVICE_API_KEY`
   - `/oxy/homiio/SINDI_OXY_SERVICE_API_SECRET`
   - `/oxy/clarity/OXY_SERVICE_API_KEY`
   - `/oxy/clarity/OXY_SERVICE_API_SECRET`

   Each key must equal the fixed `oxy_dk_...` client ID. Each secret is exactly
   32 random bytes encoded as 64 lowercase hex characters. A partial pair,
   wrong type, wrong key or malformed secret stops the run.

7. Only the two secret parameters enter the ephemeral ECS task definition as
   secret references. The wrapper writes each to its own `0600` temporary file,
   unsets the plaintext environment variables before Bun starts and removes the
   files on exit. The bootstrap hashes those files locally. Reusing an existing
   database credential succeeds only when that hash equals the stored
   `secretHash`; missing or mismatched material rolls the transaction back.
8. Verify the task's `apply/bootstrap` result and hash, the high-severity
   `security_activities` event, the exact PostgreSQL rows, and both consumers'
   service-token authentication before bootstrapping the matching private Alia
   agent rows in Alia.

The workflow serializes itself and the command also holds a PostgreSQL advisory
transaction lock. A changed database plan between dry run, preflight and apply
fails the approved hash check. The ephemeral task definition is deregistered;
the four durable SecureStrings remain the recovery source of truth.

## Rollback

Run `dry-run-rollback`, review its exact plan hash, then run `rollback` with that
hash and an incident/change reason. Rollback archives the two bot accounts,
revokes the Sindi and Clarity credentials, suspends only the created Clarity
applications and emits the security audit event. It preserves projects, the
existing Homiio application, database history and SSM SecureStrings. It does
not delete Alia data: retire the two exact Alia agent IDs through Alia's own
reviewed bootstrap/rollback after the Oxy result is verified.

Do not delete or overwrite the SSM parameters during rollback. They are needed
to prove identity if the exact credentials are restored. Provider API keys are
outside this workflow and must never be placed in these paths.
