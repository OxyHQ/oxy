# Migrating existing assumptions

Four things changed or turned out never to have been what people assumed. Each
section says what to do, and what was done for you.

Status of everything else: [README.md](./README.md).

---

## 1. `chat:completions` and `models:read` are gone

**Replaced by `inference:invoke` and `inference:models:read`
([#974](https://github.com/OxyHQ/oxy/pull/974)).** They were removed outright,
not kept as compatibility aliases.

**Why not aliases:** neither name ever authorised anything. No middleware, route
or service in this repository read either one, so they were a vocabulary entry an
application could hold and never a permission anything checked. An alias for a
name that gated nothing is a second way to spell a no-op.

**What you need to do: nothing.** The migration
(`packages/api/drizzle/0031_inference_scope_family.sql`) rewrote every stored
row to its successor, in the same statement block that stopped the retired names
being writable — `applications`, `application_credentials`,
`account_credentials`, `developer_api_keys`, and `app_grants`.

`app_grants` is rewritten too, and for a user-facing reason rather than
tidiness: a grant records what a user consented to and is read to decide whether
a returning user skips the consent screen. Leaving the old spelling there would
have silently re-prompted every user who had already agreed to exactly that
permission.

If you have the old names hardcoded in your own source or config, replace them:

```diff
- scopes: ['chat:completions', 'models:read']
+ scopes: ['inference:invoke', 'inference:models:read']
```

Anything else in the `inference:*` family is new; see the scope table in
[credentials.md](./credentials.md).

---

## 2. `oxy_dk_…` is a public client id, and never a bearer secret

**Established by [#979](https://github.com/OxyHQ/oxy/pull/979).** The credential
model always treated it as an `ApplicationCredential.publicKey` — the OAuth
`client_id` — while some documentation presented it as a directly usable bearer
API key. The documentation was wrong.

```diff
- Authorization: Bearer oxy_dk_…
+ # There is no bearer form of a client id. Present it beside a secret:
+ #   OAuth:          client_id=oxy_dk_…  +  client_secret=…
+ #   Service tokens: apiKey=oxy_dk_…     +  apiSecret=…
```

**What you need to do:** if you built anything that sends a bare `oxy_dk_…` as a
bearer, it never worked; move it to one of the two flows above. Full detail in
[credentials.md](./credentials.md#3-oxy_dk_-is-a-public-client-id-not-a-bearer).

The single bearer string a standard SDK can send is the `oxy_sk_…` machine
credential. It IS accepted now, by the inference edge (`/v1`), which resolves it
to an application principal before anything is forwarded — but only where the
deployment sets `INFERENCE_MACHINE_CREDENTIAL_AUTH=enabled`. Unset or any other
value means the lane is off and an `oxy_sk_…` bearer is refused, so "accepted" is
a per-deployment fact rather than a property of the credential.

---

## 3. `alia_sk_…` is not an Oxy credential at all

It is an **Alia-issued developer API key**, minted and verified entirely inside
the Alia product. Evidence, from the Alia repository rather than this one:

- minted by Alia's own `DeveloperApiKey` model
  (`~/Oxy/Alia/packages/api/src/models/developer-api-key.ts:123`, which returns
  `` `alia_sk_${key}` ``);
- accepted only by Alia's own `authenticateApiKey` middleware
  (`~/Oxy/Alia/packages/api/src/middleware/auth.ts:107`), which looks it up by
  hash in Alia's own store.

**Nothing in OxyHQServices mints, stores, accepts or recognises the prefix** —
verified by a repo-wide search at the commit this page was written against. Oxy
cannot revoke one, cannot attribute a request to one, and will never accept one
as a bearer.

**What you need to do:** if you hold an `alia_sk_…` key, it is a credential for
Alia's product API and its lifecycle is Alia's. It is not a route into Oxy
inference. The Oxy machine credential that serves that purpose is `oxy_sk_…`, on
the `/v1` edge, where the machine lane is enabled (see §2). Decoupling Alia's
developer keys is workstream 14 of
[#972](https://github.com/OxyHQ/oxy/issues/972), and it is not started.

Separately and confusingly similar: Oxy used to have its own legacy
`developer_api_keys` table. It never authenticated anything in this package, it
was not the same thing as `alia_sk_…`, and workstream 2.3 has now dropped it
(`packages/api/drizzle/0047_retire_developer_api_keys.sql`). There is nothing to
migrate: it had no reader, no writer, and no supported way to authenticate.

---

## 4. `alia-lite`, `alia-v1`, `alia-v1-pro`, `alia-v1-pro-max` are retired

None of those four strings ever identified a model. There is no Alia-trained
model called `alia-v1`; they were **product tiers** a proxy forwarded to Alia,
where something else decided what actually ran. A customer could not learn who
published the weights, which revision served their request, what licence
applied, which region it ran in, or whether their data was retained — because
the identifier carried none of that and never could.

They are **retired as model identities, not renamed or aliased**
([ADR 0008](../adr/0008-catalogue-concept-separation.md)). A compatibility alias
for a name that never identified a model would preserve exactly the ambiguity
being removed.

**What replaces them:** whichever of the six catalogue concepts each use actually
meant — see [catalogue.md](./catalogue.md). A real `<publisher>/<model>` where a
model was meant; a clearly labelled routing profile where a preset was meant.

**What you need to do:** stop sending them. There is no drop-in replacement id to
give you, because the catalogue is empty — this documentation deliberately
invents none rather than printing a plausible-looking model id you cannot call.

### Where they still appear

Reported rather than silently assumed fixed. Occurrence counts are per file, and
each is the count of the four retired strings only.

| Location | Count | Status |
|---|---:|---|
| `packages/console/src/routes/_layout/documentation/models.tsx` | 2 | Both inside a comment explaining what was retired. No standing entry |
| `packages/console/src/routes/_layout/examples.tsx` | 0 | **Cleared** by workstream 9 |
| `packages/console/src/routes/_layout/documentation/sdks.tsx` | 0 | **Cleared** |
| `packages/console/src/routes/_layout/documentation/chat-completions.tsx` | 0 | **Cleared** |
| `packages/console/src/routes/_layout/documentation/quickstart.tsx` | 0 | **Cleared** |
| `packages/api/src/config/email.config.ts` | 1 | **Not a catalogue reference — leave it.** See below |
| `packages/api/src/routes/__tests__/alia.test.ts` | 3 | Fixtures for the proxy, which still exists at `/alia/*` |
| `packages/api/src/services/__tests__/aiLabeling.service.test.ts` | 1 | Fixture for the AI-labelling consumer below |
| `packages/api/src/routes/models-stats.ts` | — | **Gone.** Deleted with its four static entries by [#982](https://github.com/OxyHQ/oxy/pull/982) |
| `packages/console/src/lib/model-reference.ts`, `inferenceCatalogue.service.ts`, `seed-inference-catalogue.ts`, the ADRs and the responsibility matrix | — | Correct — these quote the names in order to retire them |

Console renders the real catalogue now ([#991](https://github.com/OxyHQ/oxy/pull/991)),
so the four names are gone as model identities from every customer-facing screen.
A count here is a fact about a commit, so re-measure before quoting it.

### `AI_LABELING_MODEL` is not one of these

`packages/api/src/config/email.config.ts:100` defaults `AI_LABELING_MODEL` to
`alia-lite`, and it is **correct as it stands.** It is not a fake catalogue
entry and never was one.

The value is sent as the `model` field of a request to **Alia's own API**
(`packages/api/src/services/aiLabeling.service.ts:31` targets
`https://api.alia.onl/v1`, and `:152` puts the configured string in the body).
At that boundary `alia-lite` is a real identifier of an Alia product tier — the
thing Alia's API accepts — so it is an Alia product alias consumed by a product
feature, not an Oxy model id.

What ADR 0008 retires is the use of those four strings **as Oxy model
identities**, in the Oxy catalogue and in Oxy's public examples. An Oxy product
feature naming an Alia tier when calling Alia is a different act, and rewriting
it to a canonical `<publisher>/<model>` would name something Alia's API does not
recognise. (The labelling path is also off by default: `AI_LABELING_ENABLED`
defaults to `false`.)

---

## Deprecation and sunset dates

There are none to publish, and none are invented here. The policy a date will be
issued under, the list of things that will need one, and the reasoning are all in
[deprecation.md](./deprecation.md).

The short version: the two retired scope names authorised nothing and had no
users to notice, `oxy_dk_…` as a bearer never worked, and the four `alia-*`
strings never identified a model. A name nothing checked has no users to give
notice to.

### The Alia proxy has already moved, without a removal

Workstream 4 took `POST /v1/chat/completions` for the Oxy inference edge. **The
proxy itself is unchanged and still reachable at `POST /alia/chat/completions`**
— same router, same first-party gate, same behaviour — so every platform-trusted
caller it served kept a working path, one base URL apart.
`POST /v1/voice/token` and `POST /v1/voice/transcribe` still fall through to it.

The visible consequence is intended: a trusted caller posting to
`/v1/chat/completions` now reaches an edge with no data plane behind it and gets
a typed `service_unavailable`, instead of being silently proxied to Alia on one
shared upstream key with no reservation and no attribution.

**What you need to do:** if you were calling `/v1/chat/completions` as the Alia
proxy, move to `/alia/chat/completions`. If you were calling it expecting the
Oxy inference edge, you are already there — see [sdk.md](./sdk.md). Retiring the
proxy is workstream 14's, and it needs a dated notice addressed to the named
applications that can reach it.
