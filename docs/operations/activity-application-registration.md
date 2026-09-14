# Register the remaining deployed activity producers

These are new declared application identities, not claims that registration has
already happened. They must be seeded from a deployed API image containing the
canonical `seedOxyApplicationsSpecs.ts` entries before credential provisioning.

| Producer | Exact new application ID | Type | Authority |
| --- | --- | --- | --- |
| Nilo | `ed143b1b58d60eab417f7d5c` | first_party | `user:read` |
| Oxy Media Worker | `71ea45cf97451563762ead13` | internal | `user:read` |

Nilo's sole web origin is `https://nilo.so`, from its Worker configuration. The
media worker is the existing `oxy-asset-variant-worker` ECS service; it has no
sign-in redirect or feature-write capability. No email worker application is
registered without evidence of an existing deployed email-worker process.

1. Merge the registry change, deploy the corresponding API image, and verify
   its PRIMARY deployment and running image digest.
2. Dispatch **Seed Oxy applications** with `only_app_ids` equal to one exact ID
   above and `dry_run=true`. Inspect the bounded plan, then repeat that exact
   selection with `dry_run=false`. Never select the entire registry.
3. Dispatch **Provision service credential** for that exact ID with
   `credential_lane=service`, first dry-run then real. Nilo receives
   `/oxy/nilo/OXY_SERVICE_API_KEY/SECRET`; the media worker receives the isolated
   `/oxy/oxy-asset-variant-worker/OXY_ACTIVITY_API_KEY/SECRET` pair. Verify only
   parameter names, SecureString types and versions in operator output.
4. Nilo's separate `edge` lane delivers only to the already deployed Worker
   `nilo`. The media worker has no edge lane. Enable publishing only after the
   appropriate deployed adapter and central collector are verified.

Accounts, Auth and Console already have verified official applications. Their
edge-only delivery mappings reuse those identities with fresh isolated
`user:read` principals, leaving existing sign-in or backend credentials alone.
