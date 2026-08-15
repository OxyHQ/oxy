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
credential — which, as that page states, no endpoint accepts yet.

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
inference, and there is nothing to migrate it to today — the Oxy machine
credential that will eventually serve that purpose (`oxy_sk_…`) authenticates
nowhere yet. Decoupling Alia's developer keys is workstream 14 of
[#972](https://github.com/OxyHQ/oxy/issues/972), and it is not started.

Separately and confusingly similar: Oxy has its own legacy `developer_api_keys`
table. It has no reader or writer left in this package, and removing it is an
open checkbox of workstream 2.3. It is not the same thing as `alia_sk_…`, and
neither is a supported way to authenticate.

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

### Where they still appear, at the time of writing

Reported rather than silently assumed fixed. Occurrence counts are per file.

| Location | Count | Status |
|---|---:|---|
| `packages/console/src/routes/_layout/documentation/models.tsx` | 8 | **Still standing** — Console, workstream 9 |
| `packages/console/src/routes/_layout/examples.tsx` | 7 | **Still standing** |
| `packages/console/src/routes/_layout/documentation/sdks.tsx` | 7 | **Still standing** |
| `packages/console/src/routes/_layout/documentation/chat-completions.tsx` | 4 | **Still standing** |
| `packages/console/src/routes/_layout/documentation/quickstart.tsx` | 2 | **Still standing** |
| `packages/api/src/config/email.config.ts` | 1 | **Still standing** — the `AI_LABELING_MODEL` default, an internal first-party consumer. Needs a deployment-configuration change as well as a code change, so it cannot be fixed by editing this line alone |
| `packages/api/src/routes/__tests__/alia.test.ts` | 3 | Fixtures for the proxy, which still exists |
| `packages/api/src/services/__tests__/aiLabeling.service.test.ts` | 1 | Fixture for the consumer above |
| `packages/api/src/routes/models-stats.ts` | — | **Gone.** Deleted with its four static entries by [#982](https://github.com/OxyHQ/oxy/pull/982) |
| ADRs, the responsibility matrix, `inferenceCatalogue.service.ts`, `seed-inference-catalogue.ts` | 12 | Correct — these quote the names in order to retire them |

---

## Deprecation and sunset dates

There are none to publish, and none are invented here. The reasoning is in
[README.md](./README.md#sunset-dates-cannot-be-published-yet): the two retired
scope names authorised nothing and had no users to notice, and a sunset date is
meaningless before the public edge has a launch date.

The one compatibility path that will need a dated notice is the
`POST /v1/chat/completions` proxy, when workstream 4 replaces it. Its consumer
set is knowable — since [#986](https://github.com/OxyHQ/oxy/pull/986) only
platform-trusted first-party applications can reach it at all — so that notice
can be addressed to named applications rather than published to the world.
