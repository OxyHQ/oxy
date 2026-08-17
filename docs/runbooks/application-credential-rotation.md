# Runbook — rotating an application credential secret

Covers a `confidential` or `service` credential: the `oxy_dk_…` public key that
doubles as the OAuth `client_id`, plus the secret presented beside it. The
`oxy_sk_…` machine bearer token is the other lane and has
[its own runbook](./machine-credential-rotation.md); a `public` credential has no
secret and rotation refuses it with a 400.

## Trigger

- **Scheduled.** No expiry is enforced on a `confidential`/`service` credential,
  so nothing forces this; rotate when a person with access to the secret leaves,
  or when a credential's `lastUsedAt` shows it is live and its age is unknown.
- **Suspected compromise.** The secret appeared in a log, a ticket, a screenshot
  or a commit. Then do **not** use the rotation below on its own: rotation leaves
  the old secret working for a seven-day grace window. Rotate, then revoke the
  superseded credential explicitly — the second step is the containment, and the
  order matters because revoking first means an outage until the new secret is
  deployed.
- **A secret-scan finding.** `scripts/check-secret-scan.mjs` failed on a commit.
  Treat as compromise: the commit may already have been pushed, and a secret that
  reached a remote survives a force-push in forks, caches and clones.

## What rotation actually does

`POST /applications/:appId/credentials/:credId/rotate` runs **one transaction**
that:

1. mints a NEW credential row — new `publicKey`, new secret, same `name`, `type`,
   `environment` and `scopes`, with `rotatedFromCredentialId` pointing at the old
   row;
2. sets the OLD row to `status = 'deprecated'` with
   `expiresAt = now + 7 days` (`CREDENTIAL_ROTATION_GRACE_MS`);
3. appends two audit events — `rotated` on the old credential and `created` on
   the new one.

Both writes are in one transaction on purpose: a mint that landed without its
retirement would leave two fully live credentials for the same client.

**The new secret is in the response and nowhere else.** Only its SHA-256 is
stored, so a lost secret is not recoverable — it is another rotation.

During the grace window BOTH credentials authenticate, because
`isCredentialUsable()` accepts `active` and `deprecated`-within-`expiresAt`. That
is the whole point: deploy the new secret at your own pace inside seven days.

## Procedure

Authentication is a user bearer token whose membership carries
`credentials:rotate` on the application. A `Bearer` request skips CSRF, so no
CSRF token is needed.

```bash
OXY_API=https://api.oxy.so
APP_ID=<application id>
CRED_ID=<credential id being replaced>
TOKEN=<a user access token with credentials:rotate on that application>

# 1. Note what you are replacing, so step 4 has something to compare against.
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/applications/$APP_ID/credentials" \
  | jq '.credentials[] | select(._id == "'"$CRED_ID"'")'

# 2. Rotate.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' \
  "$OXY_API/applications/$APP_ID/credentials/$CRED_ID/rotate"
```

The response is:

```json
{
  "credential": { "_id": "<new id>", "publicKey": "oxy_dk_…", "status": "active", "…": "…" },
  "secret": "<the new secret, shown exactly once>",
  "rotatedFrom": "<CRED_ID>",
  "graceExpiresAt": "<now + 7 days>"
}
```

3. **Deploy the new `publicKey` + `secret`** wherever the old pair was
   configured. If that is an Oxy deployment, the pair travels the same path as
   every other platform secret — see
   [service-token-signing-key-rotation.md](./service-token-signing-key-rotation.md#how-a-platform-secret-actually-reaches-production)
   for the GitHub-secret → SSM → task-launch chain, and note that the new value
   only reaches a running task at the NEXT launch.

## How to verify it took

A rotation that reports success and changed nothing is possible: a `credId` that
belongs to another application, or a wrong `appId`, produces a 404 rather than a
silent pass — but a rotation whose second half was rolled back would leave the
old credential live. So read both rows back:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/applications/$APP_ID/credentials" \
  | jq '.credentials[] | {_id, publicKey, status, expiresAt, rotatedFromCredentialId}'
```

All four must hold:

- the NEW credential is `status: "active"` with `expiresAt: null` and
  `rotatedFromCredentialId` equal to the old id;
- the OLD credential is `status: "deprecated"` with an `expiresAt` about seven
  days out — **not** `active`;
- there is exactly ONE `active` credential for that name and environment. Two
  means a previous rotation was abandoned half-way and both secrets are live;
- after the new secret is deployed, the NEW credential's `lastUsedAt` starts
  advancing. Until that field moves, the client is still presenting the old
  secret and revoking it will cause an outage.

`lastUsedAt` on the new credential is the only signal that distinguishes "the new
secret is deployed" from "the new secret is in a password manager". Wait for it.

## Closing the window early (the containment step)

For a suspected compromise, revoke the superseded credential as soon as the new
one is in use:

```bash
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/applications/$APP_ID/credentials/$CRED_ID"
```

`revoked` is refused unconditionally by `isCredentialUsable()`, with no grace and
no expiry check. Verify by reading the list back and confirming
`status: "revoked"`; then confirm the application still works, because this is
the step that turns a leaked-secret incident into an outage if `lastUsedAt` was
not checked first.

The row is **not deleted**, by design — it is the audit hop that
`rotatedFromCredentialId` on the replacement points back at.

## Rollback

**There is none for the mint.** The new secret cannot be un-minted and the old
secret cannot be recovered from its hash.

What you can undo, within the grace window, is the *cutover*: the old credential
still authenticates until `expiresAt`, so putting the old pair back into the
client restores service. Once you have revoked it, the only path forward is
another rotation, and the client is down until the new secret is deployed. This
asymmetry is why the revoke is a separate step from the rotate.

## Break-glass

**If the API is up but you have no bearer token with `credentials:rotate`.**
An account with `credentials:revoke` can still revoke, which stops the leak at
the cost of an outage; that is usually the right trade for a live compromise.
Otherwise a member with owner permission on the application grants the
permission — staff cannot mint a credential on a customer's behalf, and that is
deliberate.

**If the API is unreachable.** There is no offline path, and nothing outside
`oxy-api` can invalidate an application credential: verification is a database
lookup, so the credential is live exactly as long as the row says it is. The
containment options are, in order:

1. Revoke through a direct database session — `update application_credentials set
   status = 'revoked' where id = '<id>'`. Reachable only from inside the VPC (see
   `oxy-infra`'s runbooks for how a session is opened); it bypasses the audit
   trail, so record what you did and when, and append the audit row afterwards.
   No trigger prevents this write: the immutability triggers guard the audit
   tables, not the credential table.
2. If the application is the problem rather than the credential, set the
   APPLICATION to a non-`active` status; every credential resolution path checks
   the owning application first.
3. Suspending the account is the widest hammer and takes its members' access with
   it. `resolveEffectiveAccess` resolves an archived or suspended account to
   nothing.

**If you do not know which credential leaked.** `tokenPrefix` identifies a
machine key without its secret half; a `confidential`/`service` credential is
identified by its `publicKey`, which is public and appears in the logs of
whatever consumed it. If neither narrows it down, rotate every credential of that
application in the same environment — the grace window makes that safe, and it is
cheaper than guessing.
