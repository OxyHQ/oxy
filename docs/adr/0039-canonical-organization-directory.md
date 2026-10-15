# ADR 0039 — One organization identity across Oxy products

- Status: accepted; API and SDK implemented, consumer rollout tracked separately
- Date: 2026-10-15
- Decided by: the owner of Oxy

## Decision

The Oxy organization account ID is the canonical real-world organization ID in every product. There is no second company registry with a competing identity. `organization_profiles` is a one-to-one extension of `users`, keyed by the same account ID. Public name and avatar remain on `users`; the extension holds legal name, aliases, website, country, classification, claim state and directory lifecycle. `organizationType` (`business`, `nonprofit`, `public_body`, `community`, `other`) is independent of topical account categories. Personal, organization, project, bot and channel remain the account-kind vocabulary.

A neutral directory entry can exist without a login, parent, member, billing account or application. Adding it grants its submitter no authority. A new managed organization created through the existing account workflow has the authenticated creator's actual owner membership and a claimed directory profile in the same transaction. Account parent/ancestor edges describe operating permissions, never legal corporate ownership.

Only an independent platform staff review can approve a claim on an existing neutral entry. Evidence is private and every decision is audited. A claim request, matching name, email domain, existing follow, imported assertion or source logo is never proof of ownership. Verified domains come exclusively from Oxy's existing verified-domain records. Staff can correct neutral metadata or suppress/reinstate an entry with evidence without pretending to own the organization. Claimed metadata stays under the organization's management permissions.

Database guards and live session/service authority checks prevent unclaimed or disabled organizations acquiring account capabilities. Historical ownerless organizations backfill as unclaimed and their old sessions and applications are disabled; accounts with a real active owner (including inherited ownership) backfill claimed. A deferred constraint requires a directory profile before any new organization transaction commits. Revoking a membership remains possible while an organization is disabled.

Only a neutral source with no operating history or pending claims can merge into a canonical organization. The merge is an identity redirect, not an account-authority transfer. Claimed-source merges are refused. Redirects are flattened; batch resolution returns both the requested ID and canonical ID. Public generic profiles also withhold suppressed and merged directory records.

## Product boundaries

Clarity owns personal work experience and stores the employer's Oxy account ID. Mention renders that history and edits it through Clarity. Mercaria, Homiio and other products retain their own commercial or operational relationships while resolving company facts from Oxy. Existing application records must be archived/mapped explicitly before local editable company facts are removed. Never merge by name.

Trusted ingestion uses a live application service identity, the privileged `organizations:import` scope and an exact staff-granted `organizations:import:<namespace>` capability. Batches contain at most 100 entries and 512 KiB. Bulk insertion and namespace serialization make source mappings idempotent. This lane only creates neutral entries or reuses existing source mappings; it cannot claim ownership, link arbitrary existing account IDs, modify existing facts or import domain verification. Existing public image assets may be attached only if owned by the importing application's owner account. Staff-reviewed linking remains a separate endpoint.

Contracts live in `@oxy.so/contracts`; both browser `OxyServices` and backend `OxyServer` expose the same organizations namespace. Runtime response parsing, pagination, typed errors and service-token transport stay in the SDK. Product-local DTO/validation copies and direct endpoint wrappers are not the integration contract.

## Rollout and limits

Apply migration 0159 before deploying the API. Publish reviewed `@oxy.so/contracts@4.14.0` and `@oxy.so/core@4.8.0` builds from merged source before consumers adopt the registry versions. These versions avoid other in-flight SDK releases; the release build must include all preceding merged SDK changes. Directory UI must mark unclaimed entries and offer a claim action rather than imply an official managed profile. Experience is self-declared; selecting a canonical employer does not verify employment.

Supervised personal accounts and guardian policy are a separate safety domain. Organization membership, family organization or parent-account ownership never makes someone a guardian or grants authority over a personal identity.
