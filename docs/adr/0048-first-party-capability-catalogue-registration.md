# ADR 0048 — Oxy registers the capability catalogue it ships, on every deploy

- Status: accepted
- Date: 2026-10-21
- Amends: ADR 0018 addendum (catalogue `actors`)
- Scope: how a capability catalogue that Oxy itself ships becomes the active registration

## Context

Oxy's own catalogue (`oxyProfileCapabilityCatalog`: `recommendProfiles`,
`readViewerGraph`) is code in this repository, and the authority reads the
ACTIVE REGISTRATION in `app_capability_catalog_registrations`, not the code.
Registration required an application credential with `catalogs:write`, so Oxy's
own catalogue was registered once, by hand, through an ephemeral credential
(the I05 pilot, 2026-10-04), and never again.

#1638 changed the catalogue to 1.1.0 (tools declare `actors`) and the authority
to deny any actor a tool does not name. Production still held 1.0.0, which names
no actors and so defaults to Alia and agents: every requester ticket was refused
`tool_not_available_to_actor`, and Mention's `/recommendations` answered 503 to
every signed-in viewer. The same shape broke it before (2026-10-04 to 10-12,
#1664): code shipped, registration did not.

## Decision

**A catalogue Oxy ships is registered by the deploy that ships it.**

- `deploy-aws.yml` runs `packages/api/scripts/register-oxy-capability-catalog.ts`
  as a post-rollout one-shot task, beside Inbox's registration. It is idempotent:
  the registration is keyed by (app, version, digest).
- The registration carries an explicit authority. `app_capability_catalog_registrations.source`
  is `credential` (an application's `catalogs:write` credential posted it;
  `registered_by_credential_id` names it) or `first_party` (Oxy's deploy; no
  credential). A CHECK ties the two: a credential row has a credential, a
  first-party row has none. No credential is minted, held or revoked for this.
- The owning application is the platform registrar that already holds the
  `catalog:oxy` namespace. The namespace-ownership rule is unchanged and applies
  to both routes.
- The script prints `OXY_CATALOG_BINDING_JSON` — `registrationId`, `version`,
  `digest` — the exact value an app that pins the catalogue carries.

## Consequences

- The registered catalogue can no longer lag the code that reads it.
- Mention still pins the catalogue (`MENTION_OXY_FOREGROUND_CATALOG_BINDING`, in
  `oxy-infra`): its own check that the ticket it was given is for the catalogue
  it approved. `registrationId` is generated at registration, so a NEW catalogue
  version is a two-step rollout: the deploy registers it and prints the binding,
  then the pin moves in `oxy-infra` and Mention redeploys. Until the pin moves,
  tickets are refused `ticket_catalog_no_longer_current`.
- The pilot's `catalogs:write` ephemeral-registrar path stays for apps that
  register their own catalogue (Inbox, Noted); it is not how Oxy registers its
  own.
