# Managed Mention application registration

The operator command registers identity for one dedicated managed Mention
installation. It does not provision AWS resources, deploy a workload, activate a
customer or establish a price. The data-plane module is in oxy-infra; this
registry owns only application identity metadata and the exact workload bindings.

Run inside the Oxy API operator environment, with its database authority:

```sh
bun run packages/api/scripts/register-managed-mention.ts declaration.json
```

The JSON document contains `deploymentId` (the deployment UUID), `ownerAccountId`
(the existing account that owns the application), one exact HTTPS frontend
`origin`, explicit `environment` (`development`, `staging` or `production`), and
`backendRoleArn`, `workerRoleArn`, `mcpRoleArn`. Use the three distinct task-role
ARN outputs of the managed Mention infrastructure module, not execution roles
or the public Mention service's identity. The operator is platform staff;
origins, names and caller-supplied headers never prove that authority. The
command deliberately has no HTTP self-service registration endpoint.

One database transaction creates the registered first-party Application, its
canonical origin declaration, the public OxyProvider client, all three canonical
workload bindings and their attribution rows, and the unique deployment marker.
A failure at any point rolls back all of these, including previously bound roles.
Retrying the same declaration is safe. Concurrent retries serialize by deployment
UUID. The origin and workload registries retain their own uniqueness constraints.

Success prints `MANAGED_APPLICATION_JSON` containing `applicationId` and
`publicClientId`, with state `created` or `unchanged`. The public identifier goes
into the deployment's `EXPO_PUBLIC_OXY_CLIENT_ID` build configuration and
`MENTION_OXY_CLIENT_ID` backend configuration. It is not an API key, secret or
service credential. Workloads authenticate through the shared AWS attestation
provider against the registered role; there is no app scope list or local token
transport.

A repeat checks the immutable owner, origin, environment and role declaration,
and verifies the live application, public credential, origin and bindings.
Ownership transfer, suspension, removed or expired roles, changed origins and
revoked public credentials are refused. Rerunning a deployment command is never
a revocation reset or a credential repair. Those require a separate explicit
operator action through the corresponding canonical registry. No existing
application is adopted based on its display name or website.

The application owns its own private Files assets. Another managed deployment's
service cannot read them, and neither service acquires an unrelated person's
private library merely by being first-party. A separately verified requester may
still access their own library under ADR0049; explicit application file grants
remain governed by ADR0043. Supervised accounts retain their separately approved
contact policy described in ADR0021.

This registration is one control-plane step. It does not demonstrate live STS
attestation, IAM execution policy, backup/restore, tenant ingress/TLS, rollback,
export delivery, or customer activation. Those lifecycle steps remain separate
acceptance gates and must not be inferred from a successful registration result.
