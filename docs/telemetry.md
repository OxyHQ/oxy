# Anonymous activity telemetry

`@oxy.so/telemetry` is the framework-independent contract between Oxy clients,
request collectors and realtime dashboards. Its source and package API live in
[`packages/telemetry`](../packages/telemetry/README.md).

## Architecture

```text
browser runtime
  ├─ ephemeral activity id (memory only, rotates every 5 minutes)
  └─ Cloudflare serving PoP (three letters only)
             │ request headers
             ▼
product/API collector
  ├─ validate metadata
  ├─ reduce path to a bounded service group
  ├─ increment request window
  └─ estimate 60-second distinct runtime cardinality
             │ aggregate buckets
             ▼
snapshot endpoint + realtime transport
             │
             ▼
dashboard
```

The package implements browser metadata generation plus pure server validation,
bucketing and adapter interfaces. The central API collector consumes its server
entry point; it does not host a collector, open sockets or persist data itself.

## Headers

| Header | Meaning | Lifetime |
|---|---|---|
| `X-Oxy-Activity-Id` | Random opaque page-runtime ID used only for approximate cardinality | Five-minute rotation; memory only |
| `X-Oxy-Edge-Region` | Cloudflare PoP code such as `mad` or `cdg` | Cached for the page runtime |

The PoP is the edge location serving the request, not a user's home or precise
position. Neither header contains an account, user, session, device or IP.

## The 60-second metric

“Active clients” means distinct ephemeral activity IDs seen for one PoP in the
current or immediately previous 30-second presence bucket. It approximates page
runtimes active during the last 60 seconds. It does not count people: tabs,
reloads and five-minute ID rotation can change it independently of user count.

Request volume is separate. Every successful eligible request increments its
flow's request total, while repeated requests with one activity ID contribute
only one member to that window's cardinality estimate.

## Privacy contract

Collectors may publish only aggregate request counts, approximate active-client
counts, a bounded service group, edge PoP, processing region and aggregate
timestamps. They must never persist or publish:

- raw or hashed IP addresses;
- IP-derived coordinates or geography;
- the ephemeral activity ID itself;
- user, account, session or device identifiers;
- request bodies, query strings or raw paths.

The browser trace parser extracts only `colo`. The server parser intentionally
does not inspect `X-Forwarded-For` or similar headers.

## Collector and cardinality boundary

Collectors validate headers before use and group requests by source region and
the first safe static route segment. Unknown or dynamic-looking segments become
`platform`. Health, snapshot and streaming control routes are excluded by the
host collector rather than the package.

`ActivityCardinalityAdapter` is deliberately smaller than a Redis API: add an
opaque ID to a time-bounded key and count the union of specified keys. Redis
HyperLogLog is one suitable implementation, but storage choice remains outside
the portable package. A process-local implementation may be used during store
recovery as long as it obeys the same expiry and non-persistence boundary.

## Realtime and reconnect

The realtime channel carries aggregate windows rather than a packet containing
visitor metadata. Request density or animation speed is a dashboard rendering
of the aggregate `requests` value; it does not expose individual requests.

Socket events are transient. A reconnecting dashboard must fetch the current
aggregate snapshot first and then attach to the live channel. Snapshot and live
windows may overlap, so consumers deduplicate by flow plus window start rather
than adding both blindly. Exponential reconnect backoff and transport-specific
authentication remain responsibilities of the socket client.

## Namespace migration

Telemetry is the first shared concern moving from the historical `@oxyhq/*`
namespace to `@oxy.so/*`. Browser consumers will import
`@oxy.so/telemetry/browser`; collectors will import
`@oxy.so/telemetry/server`. There is no alias or re-export through Core. During
integration, each consumer changes its import and deletes the superseded local
implementation in the same commit.

Current status: package source, tests and build exports exist locally at version
`0.1.0`; it is not published because the npm `@oxy.so` organization has not yet
granted the release identity access. The central API uses the server entry point.
Core temporarily retains its compatible browser helpers until this package can
be published and adopted without breaking existing applications.
