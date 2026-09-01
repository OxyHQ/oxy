# Runbook — rotating or revoking a machine API key (`oxy_sk_…`)

A machine credential is ONE bearer string a stock OpenAI SDK sends as
`Authorization: Bearer oxy_sk_…`. There is no token exchange, so possession is
the whole proof, and that changes what a rotation has to be careful about
compared with an [application credential secret](./application-credential-rotation.md).

The token is `oxy_sk_<16 hex id>_<64 hex secret>`
(`packages/api/src/utils/machineCredentialToken.ts`). It is split at rest:

- `token_prefix` = `oxy_sk_` + the 16-hex id. **Public** — it is what a Console
  row renders to say WHICH key this is, and it authorises nothing on its own.
- `token_hash` = SHA-256 of the FULL token, prefix included. Compared in constant
  time, never returned, never re-derivable.

## Trigger

- **Suspected compromise.** A single string in an environment variable, a CI log
  or an SDK config is the most likely Oxy credential to leak, and the leak is
  immediately usable by anyone who reads it. This is the common case.
- **Scheduled.** A machine credential may carry a caller-chosen lifetime
  (`expiresInSeconds`, 60 seconds to 730 days) set at creation, which lands on
  `expires_at` while the row stays `active`. If one was set, rotate before it
  expires — `isCredentialUsable()` refuses an `active` credential whose
  `expires_at` has passed, so an unnoticed expiry is an outage.
- **A secret-scan finding.** `oxy-machine-credential` is one of the scanner's
  rules, so a commit containing a whole token is refused. If the commit was
  pushed before the gate existed, treat as compromise.

## The one thing that differs from every other rotation here

**A machine rotation revokes the old token IMMEDIATELY unless you ask for a
window.** `graceSeconds` is opt-in and machine-only:

| Request body | Old token |
|---|---|
| `{}` | `status = 'revoked'` the instant the new one is minted. No grace. |
| `{"graceSeconds": 3600}` | `status = 'deprecated'`, `expires_at = now + 1h`, still usable until then. |

`graceSeconds` accepts 1 second to 30 days. The default is the safe one for a
compromise and the wrong one for a planned migration, so decide which you are
doing before you send the request.

## Procedure — planned rotation, with a window

```bash
OXY_API=https://api.oxy.so
APP_ID=<application id>
CRED_ID=<machine credential id>
TOKEN=<user access token with credentials:rotate on that application>

curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"graceSeconds": 86400}' \
  "$OXY_API/applications/$APP_ID/credentials/$CRED_ID/rotate"
```

Response — note that `secret` is `null` for a machine credential and the token is
in `token`:

```json
{
  "credential": { "_id": "<new id>", "tokenPrefix": "oxy_sk_<16 hex>", "status": "active" },
  "secret": null,
  "token": "oxy_sk_<16 hex>_<64 hex>",
  "rotatedFrom": "<CRED_ID>",
  "graceExpiresAt": "<now + 24h>"
}
```

Deploy `token` to the client, then confirm the cutover before the window closes
(below).

## Procedure — suspected compromise

Send no `graceSeconds`. The old token stops working at once and the caller will
fail until the new token is deployed; that is the correct trade when the string is
in someone else's hands.

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' \
  "$OXY_API/applications/$APP_ID/credentials/$CRED_ID/rotate"
```

If you do not need a replacement at all, revoke instead — one call, no new
material to handle:

```bash
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/applications/$APP_ID/credentials/$CRED_ID"
```

## How to verify it took

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/applications/$APP_ID/credentials" \
  | jq '.credentials[] | select(.type == "machine")
        | {_id, tokenPrefix, status, expiresAt, lastUsedAt, rotatedFromCredentialId}'
```

- The old row must be `revoked` (no window) or `deprecated` with a future
  `expiresAt` (window). **`active` means the rotation's second half did not
  land** and both tokens are live.
- The new row must be `active`, with a DIFFERENT `tokenPrefix` — the prefix is
  regenerated, so an unchanged prefix means you are reading the same row.
- `lastUsedAt` on the NEW row must start advancing before the window closes. That
  is the only evidence the client is presenting the new token; a window that
  expires while `lastUsedAt` is still `null` is an outage with a timer on it.
- With a window, ALSO verify after `graceExpiresAt` has passed that the old token
  is refused. A `deprecated` row's `status` does not change when its window ends
  — nothing sweeps this table, deliberately, because the row is the audit trail —
  so the row still reads `deprecated` and only the clock decides. The real check
  is a request with the old token returning 401.

**Do not verify by making a request with the new token from a shell that logs
commands.** The token is the credential; a shell history, a CI log or a `set -x`
is where the next leak comes from.

## Rollback

Within a grace window: put the old token back and it works until `expiresAt`.

With no window, or after `expiresAt`: **there is no rollback.** The old token's
plaintext is gone (only its SHA-256 was ever stored) and the row is `revoked`.
Forward is another rotation.

## Break-glass

**Rate limits are the fastest lever you already have.** A leaked machine key is
bounded before you touch it: `rl:machine:credential:` allows 60 requests/minute
per credential and `rl:machine:application:` allows 300/minute per application,
so one application cannot exceed 300/minute no matter how many keys it holds. An
abusive caller is throttled, not unlimited, which buys time to rotate properly
rather than in a panic.

**If the API is up but nobody has `credentials:rotate`.** `credentials:revoke` is
a separate permission and revoking is the containment; take that. Otherwise an
application owner grants the permission.

**If the API is unreachable.** Same as the application-credential runbook: the
credential is live exactly as long as the row says. A direct database session can
`update application_credentials set status = 'revoked' where token_prefix =
'oxy_sk_<id>'` — keyed on the PREFIX, which is safe to paste into a terminal and
uniquely identifies the row (it is `unique` and case-sensitive). Record it and
append the audit event afterwards.

**If you know a token leaked but not which one.** You have the prefix if you have
any log line of a request it made; `tokenPrefix` is public and indexed. If not,
rotate every `machine` credential of that application in that environment — with
`graceSeconds` set, this is safe, and it is faster than correlating usage events.

**What you cannot do:** recover a token, list tokens with their secrets, or
convert a `tokenPrefix` back into a token. Every one of those would defeat the
one-time-display property, and none of them exists.
