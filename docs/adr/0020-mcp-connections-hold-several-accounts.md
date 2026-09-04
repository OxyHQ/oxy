# 0020 — An MCP connection holds several accounts, and Oxy owns the set

- Status: accepted
- Changes: [0018](0018-native-alia-agency-and-app-capability-catalogs.md) ("Multiple
  accounts are connected in separate grants")
- Scope: external MCP OAuth — Oxy authority, the IdP, and every Oxy app that
  serves an MCP resource

## Context

0018 bound an external MCP access token to one exact resource, audience and
effective account, and left it there: a person who runs several accounts on an
app was told to register a separate connector for each one.

That is not an account model, it is a workaround, and it fails on its own terms:

- MCP clients key a connector by its server URL. Claude allows ONE connection per
  URL, so "authorize a second connection" is advice the client cannot take.
- The person's own mental model is one assistant reaching their accounts. Making
  the connector the account forces them to hold a different tool per identity.
- Mention had already shipped the missing half locally, as `mcp_connections`
  bundles with a Mention-owned link token and a Redis-held active account. The
  central migration retired it, which removed the workaround without answering
  the need. Every other Oxy app would have arrived at the same private copy.

The requirement underneath is small and specific: from inside the assistant, ask
for a link, open it, approve it as another account, and act as that account —
without re-authorizing the connector and without any app inventing its own
account graph.

## Decision

**A connection is the unit a person holds; a grant stays the unit of consent.**

`mcp_oauth_connections` groups grants under the ORIGIN grant — the one whose
token family the client holds and refreshes. `mcp_oauth_connection_accounts` is
its membership, one row per member grant. Membership is a junction, not a column
on the grant, because one grant can be both its own connection's origin and a
member of somebody else's; a `connection_id` column would let a second connector
inherit the first one's account list.

**Every member account approves for itself, once, on the IdP.** The resource
server presents its live access token and asks Oxy for an account-link URL
(`POST /auth/mcp/oauth/connections/link-intent`, service-authenticated).
`mcp_oauth_account_link_intents` stores only the SHA-256 verifier of the opaque
secret; the URL is the credential, single-use and short-lived. Approval happens
at `auth.oxy.so/mcp/link`, signed in as the account being added, and creates a
NORMAL grant for that account with the connection's scopes. It therefore appears
in that account's own grant list and is revoked from that account's own settings,
without touching anyone else's.

**Oxy reports the set, and which member is selected, on introspection.** The
access token is never re-minted or widened: its `account_id` stays the origin
account, and the connection block travels beside the claims. A resource server
serves `active_account_id`; `@oxyhq/mcp` exposes it as `McpPrincipal.activeAccountId`,
so an app that reads the principal gets it without deciding anything.

**Switching is an authorization decision, not a preference.** `POST
/auth/mcp/oauth/connections/active` refuses an account that is not a live member
or whose approver no longer holds `account:act_as`, and the same check runs again
on every introspection — a selection whose consent has lapsed silently falls back
to the origin account.

## Consequences

- One connector, several accounts, no re-authorization — the flow a person can
  actually run from inside their assistant.
- No app owns an account graph any more. The retired Mention bundles are not
  reinstated: `link-account` / `switch-account` / `list-accounts` become thin
  relays over Oxy's connection, and legacy bundles stay frozen and unwidenable.
- A linked account is exactly as revocable as an authorized one, by its own
  owner, because it IS an ordinary grant.
- A connection can span accounts belonging to different people (each approved on
  its own screen, naming the client). That is deliberate — a shared brand account
  reached from one operator's assistant — and it is why membership carries the
  approving principal in its own grant rather than assuming one owner.
- Introspection does one extra membership read per request, and one authority
  check when the selected member is not the origin. Both are on the same call
  that already resolves the grant.

## Alternatives rejected

**Leave it at one account per connector.** Correct on paper, unusable in the one
client that matters, and it pushes every app to rebuild bundles privately —
which is the state this ADR ends.

**Re-mint the token with the new account.** The client holds the token and
refreshes it on its own schedule; there is no path for a tool call to hand it a
new one, and a token whose account changes underneath breaks the exact binding
0018 depends on.

**Let the resource server hold the account set.** That is the retired Mention
bundle, generalized: N apps, N account graphs, N revocation surfaces, and no way
for a person to see from Oxy what their assistant can reach.
