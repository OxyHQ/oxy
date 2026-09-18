# ADR 0026 — A first-party service proves what it IS, not what it knows

- Status: accepted
- Date: 2026-09-18
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

### A binding row, not a naming convention

`application_workload_identities` maps `(provider, subject)` to an application.
Deriving the application from the workload's NAME — `oxy-mention-task` is Mention —
needs no table and was rejected: it makes identity a property of whatever anyone
names an IAM role, so creating a role with the right name is enough to become that
application, and renaming one silently unmakes it.

A row is not the registration ritual this ADR removes. It carries no secret, it is
created by the platform when a service is deployed, and it is what makes a
compromised workload revocable — delete the row.

### What an attestation can never do

- **Widen authority.** The minted token carries the application's own
  non-privileged scopes, exactly as a scopeless credential does. Privileged scopes
  stay reachable only from something a human granted deliberately.
- **Choose an environment.** A credential carries one because a human chose it; an
  attestation carries none, so the environment is the DEPLOYMENT's. Otherwise a
  staging workload could mint itself a production token.
- **Reach a third party.** The mint re-applies `isTrustedApplication`, so a
  third-party application that somehow acquired a binding row still cannot use it.

## Consequences

- An official service needs no credential, no console step and no secret in SSM.
  Adding one to the ecosystem is a deploy, not a ritual.
- Oxy's auth service becomes load-bearing for service-to-service calls in a new
  way: a workload with no cached token cannot start calling until the mint answers.
  The token lives an hour, so a mint outage degrades over an hour rather than at
  once.
- Redis is required for the mint (the nonce must be single-use across API tasks).
  A deployment without it refuses to mint rather than accepting replayable proofs.
- The credential path stays for third parties, and stays for first-party services
  until each has migrated. **That coexistence is temporary by design**: the clean
  cut is each official service losing its credential as it moves, and this ADR is
  not closed until the last one has.
