# Oxy-hosted Inbox service calls

Inbox's catalog registrar and normalized-event outbox run inside the Oxy API
process. They share one `OxyServer` with the standard temporary AWS workload
provider. ECS roles and local assumed-role/SSO credentials use that same path;
there is no ECS-environment precheck and no customer-key fallback. Remove
`INBOX_APPLICATION_KEY` and `INBOX_APPLICATION_SECRET` from launch configuration:
either nonempty variable is an explicit configuration error.

The outbox uses `createServiceClient` with Alia's canonical recipient
`oxy-service:6a2f851751b784a86fd0e934`. The shared transport mints protocol 2,
refuses credential-bearing redirects and owns the single 401 refresh. It sends
the original normalized event and stable `Idempotency-Key: event.eventId` on both
attempts; the account and resource inside the event are unchanged. Network/5xx
failures remain failures of the existing durable outbox; no extra local retries,
new requester identity or stored bearer are introduced. The existing ten-second
request deadline and tracing are retained. Each delivery disposes its transport;
the process host retains the shared audience token cache.

`scripts/register-inbox-capability-catalog.ts` uses the shared MCP registrar with
an `oxy-api` service transport, validates the returned catalog version/digest and
disposes both transport and host on completion. Alia still verifies that an event
claims a catalog owned by its authenticated publisher. An official brand or a
payload account identifier does not replace that source-ownership check.

Before activating this producer, verify the running Oxy task role's explicit
binding/environment and the current Inbox catalog's `registeredByApplicationId`.
The same process must own that catalog; do not overwrite another publisher's
registration merely to make delivery succeed. Verify rollout and catalog
readback separately. This source change does not modify production bindings,
secrets, catalog registrations or existing event rows.

Focused verification uses the actual shared SDK and temporary-role provider
against local HTTP issuer/recipient fixtures: canonical audiences, v2 without
scopes, stable payload on 401, no extra 503 retry, redirect refusal and separate
catalog registration. Real PostgreSQL outbox tests preserve transaction rollback,
event deduplication and retry acknowledgement. Tracing tests verify one client
span and propagation through the authenticated transport without bearer copying.
