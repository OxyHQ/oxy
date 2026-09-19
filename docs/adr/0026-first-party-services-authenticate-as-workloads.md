# ADR 0026 — A first-party service proves what it IS, not what it knows

- Status: accepted
- Date: 2026-09-18
- Amended: 2026-09-19 — a binding row may NAME scopes (see "A binding names the
  scopes", below). Without it no service holding a privileged scope could ever
  give up its credential, which is the clean cut this ADR is for.
- Scope: service-to-service authentication between Oxy's own services; third-party applications are unchanged

## Context

Every official Oxy service that calls another one holds an `ApplicationCredential`
— an api key and secret a human issued in the Console and pasted into AWS SSM,
from where a task definition injects it. Mention holds one for Oxy. CrowdSource
issues its own, separate pair for its tenants. Kaana, Alia, Syra and the rest each
carry theirs.

That pair does two jobs: it opens the door, and it says who is knocking. The second
is the one the receiver needs — `applicationId` off the credential is what decides
tenancy, audit attribution and scope — and a long-lived shared secret is a poor way
to do it:

- A human creates it, so a service cannot exist until somebody performs a ritual.
- It lives in at least two places (the issuing console and a parameter store), and
  every copy is somewhere it can leak from.
- Rotation is a calendar entry, so in practice it does not happen.
- The ritual is per PAIR of services, so it grows with the square of the ecosystem.

Nate's ask, in his words: *"ninguna app oficial de oxy tenía que complicarse la vida
teniendo que registrar application ids y client ids… para aplicaciones de terceros
sí, pero para oficiales no tiene sentido"*, plus two constraints — **no dependence
on one cloud**, and **a clean cut**, not two systems living side by side.

What was rejected first, and why it matters: *"they are on the same private
network, so trust the network"*. Thirty services share one VPC and one security
group in `oxy-cluster`. Network position is not identity: it cannot tell Mention
from Alia, so a receiver could not answer "whose note is this?" — and any one
compromised container would speak for all thirty.

## Decision

### The identity comes from the infrastructure, the token comes from Oxy

A workload already carries an identity its platform issues and rotates: an IAM role
on AWS, a service account on Kubernetes, a certificate on hardware we own. A
first-party service proves that identity to Oxy and receives **the same service
token `POST /auth/service-token` has always minted** — same claims, same signature,
same verification. Nothing downstream learns which path a token came from.

Two calls, because a signed proof can be replayed:

1. `POST /auth/service-token/workload/challenge` → a single-use nonce (60s, Redis).
2. `POST /auth/service-token/workload` with `{ provider, nonce, attestation }`.

### AWS attests by signing a call it never makes

AWS hands a task rotating credentials, not a signed statement of identity. So the
caller signs a `GetCallerIdentity` request and sends us the signature; we replay it
to STS, and STS tells us who signed it. We never see a secret, and we learn the
caller from AWS rather than from the caller.

`services/workloadAttestation.service.ts` pins the replay to an exact STS host with
an exact body (a signed request is otherwise an SSRF primitive with a signature
attached), requires our nonce to be inside the signature's `SignedHeaders` (a nonce
the signature does not cover can be swapped by whoever captured it), and refuses a
signature older than five minutes.

What STS answers is the SESSION — `assumed-role/<RoleName>/<SessionName>`, a
different string for every task — so the verifier reduces it to the role before
anything else sees it. A binding names a role, because a role outlives the
containers that assume it.

### Portability is a property of the code, not a promise

`AttestationVerifier` is the only seam that knows where we run. Moving to another
cloud, to Kubernetes, or to our own hardware is one more implementation of that
interface — no caller and no consumer changes, because what they see is an Oxy
token verified against Oxy's JWKS. Nothing above that module names AWS.

### A binding names the scopes

*(Amendment, 2026-09-19. Everything above stands; this replaces the first bullet
of "What an attestation can never do".)*

As first shipped, a workload token carried the application's own NON-privileged
grants and nothing else — the same thing a scopeless credential receives. The
reasoning was sound and is unchanged: privileged authority must be named on
something a human granted deliberately, and an attestation says WHAT is calling,
never what it may do.

What was wrong was the conclusion drawn from it. The attestation is not the only
deliberate human act on this path. **The binding row is one too.** It is written
by staff, it names exactly one IAM role and exactly one application, and it
carries a description somebody typed. It is the attestation path's equivalent of
an `ApplicationCredential` — so it names authority the way one does, and it is
gated at creation the way one is.

The cost of not having noticed that was measured, not predicted. Mention's
credential names `federation:write`, `signals:write` and `catalogs:write`; when
the key pair came off its task definition at task-definition revision 384, its
federation worker failed every six minutes — 313 × `Missing required scope:
federation:write` plus 2 × `signals:write` between 06:22Z and 15:09Z, against
ZERO in the preceding 36 hours — until the pair was restored at revision 389.
The same rule blocked mention-mcp (`catalogs:write`, required by its own
post-deploy `POST /capabilities/catalogs/register`), Alia (`capabilities:read`,
which is how it builds its tool catalogue), the Oxy website API
(`catalogs:write`) and Homiio's Sindi credential (`acting-as:offline`). Five
applications, one to three privileged scopes each. The rule was not holding a
line; it was making this ADR's clean cut impossible for exactly the services it
was written for.

So `application_workload_identities` carries a `scopes` column, and the mint
decides exactly as `POST /auth/service-token` decides:

- The binding NAMES scopes → the intersection with the application's, so a
  privileged scope survives only when BOTH the binding and the application hold
  it. Either losing it is enough to lose it in the token, at the next mint.
- The binding names NONE → the application's non-privileged grants. This is what
  the path did before the column existed, so every binding written before this
  amendment behaves identically and no backfill exists.

What has NOT changed:

- **The attestation still names nothing.** It selects a binding; the binding
  names the scopes. A workload that proves what it is has no say in what it may
  do.
- **The application's grants are still the ceiling.** A binding can never name a
  scope the application was not granted — refused at the write, and intersected
  away at every mint.
- **Naming a privileged scope is staff's.** The binding writer applies the same
  gate `POST /applications/:appId/credentials` applies, including its symmetry:
  a non-staff caller can neither add a privileged scope nor revoke one by
  omitting it. Absent staff, a privileged scope is refused rather than assumed.

**The operational consequence, and it is a precondition not a footnote:** a
service may give up its key pair only once its binding NAMES every privileged
scope its credential named. Removing the pair first is exactly what took
Mention's federation worker down. The order is: bind with scopes, verify the
minted token carries them, then remove the pair.

### A binding row, not a naming convention

`application_workload_identities` maps `(provider, subject)` to an application.
Deriving the application from the workload's NAME — `oxy-mention-task` is Mention —
needs no table and was rejected: it makes identity a property of whatever anyone
names an IAM role, so creating a role with the right name is enough to become that
application, and renaming one silently unmakes it.

A row is not the registration ritual this ADR removes. It carries no secret, it is
created when a service is deployed, and it is what makes a compromised workload
revocable — delete the row.

It is created by `packages/api/scripts/bind-workload-identity.ts`, run once per
service by staff against that environment's database — not by a route. Exposing a
binding over HTTP means designing who may call it, and the honest answer is "an
operator, out of band, at deploy time". The script refuses to repoint a subject
that already belongs to another application: a repoint is silent and total, the
old service keeps receiving tokens and every one of them now carries someone
else's `applicationId`. Moving a role means deleting the old row first. It also
refuses a subject that is not a role ARN once reduced — a user, the root, a typo —
because `canonicalAwsSubject` passes an unrecognised ARN through unchanged, which
is the right answer for reporting what AWS said and the wrong one for an operator
at a terminal.

### What an attestation can never do

- **Widen authority.** The minted token carries what the BINDING names,
  intersected with the application's own grants — exactly as a credential's
  scopes are, and exactly as a scopeless credential still gets the
  non-privileged ones. The attestation contributes nothing to that decision: it
  selects a binding and stops. Privileged scopes stay reachable only from
  something a human granted deliberately, which since the 2026-09-19 amendment
  above includes the binding row itself. See "A binding names the scopes".
- **Choose an environment.** A credential carries one because a human chose it; an
  attestation carries none, so the environment is the DEPLOYMENT's. Otherwise a
  staging workload could mint itself a production token.
- **Reach a third party.** The mint re-applies `isTrustedApplication`, so a
  third-party application that somehow acquired a binding row still cannot use it.

## Consequences

- An official service needs no credential, no console step and no secret in SSM.
  Adding one to the ecosystem is a deploy plus one binding row, not a ritual — and
  the row is a fact about our infrastructure, not a secret anybody has to keep.
- Oxy's auth service becomes load-bearing for service-to-service calls in a new
  way: a workload with no cached token cannot start calling until the mint answers.
  The token lives an hour, so a mint outage degrades over an hour rather than at
  once.
- Redis is required for the mint (the nonce must be single-use across API tasks).
  A deployment without it refuses to mint rather than accepting replayable proofs.
- A service migrates in two steps, in this order: bind with `--scopes` naming
  every privileged scope its credential named, confirm the minted token carries
  them, and only then take the key pair off the task definition. Doing it the
  other way round is the outage of 2026-09-19.
- The credential path stays for third parties, and stays for first-party services
  until each has migrated. **That coexistence is temporary by design**: the clean
  cut is each official service losing its credential as it moves, and this ADR is
  not closed until the last one has.
