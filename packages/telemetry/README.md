# `@oxy.so/telemetry`

Framework-agnostic primitives for anonymous, real-time Oxy activity telemetry.
The package has no runtime dependencies and does not import Express, Socket.IO,
Redis, React, React Native or Expo.

## Entry points

- `@oxy.so/telemetry` — shared header names, the CORS header lists and the wire
  types (`TrafficAggregate`, `ActivityAggregate`, `InfrastructureSnapshot`).
- `@oxy.so/telemetry/browser` — ephemeral browser metadata.
- `@oxy.so/telemetry/collector` — bounded HTTP/custom-transport flow aggregation.
- `@oxy.so/telemetry/server` — pure validation, route bucketing and cardinality
  keys/interfaces.
- `@oxy.so/telemetry/metrics` — operational metrics as CloudWatch EMF lines.

Browser code must import the browser entry point explicitly. Server code must
import the server entry point explicitly; the root entry point has no platform
side effects.

## Browser metadata

```ts
import { getBrowserActivityIdHeader, peekBrowserEdgeRegionHeader } from '@oxy.so/telemetry/browser';

const headers = { ...peekBrowserEdgeRegionHeader(), ...getBrowserActivityIdHeader() };
await fetch('https://api.oxy.so/session/status', { headers });
```

This is what `@oxy.so/core` sends on every request: the peek never waits on the
trace. `getBrowserEdgeRegionHeader()` is the awaiting variant.

A CORS allow-list for these headers is `OXY_TELEMETRY_REQUEST_HEADERS` (from the
root entry), and `OXY_TELEMETRY_EXPOSED_HEADERS` for `Access-Control-Expose-Headers`;
import them instead of repeating the header names.

`X-Oxy-Activity-Id` is generated in memory for the current page runtime and
rotates every five minutes. It is not placed in a cookie, local storage,
session storage, IndexedDB or a URL. Closing or reloading the page loses it.

`X-Oxy-Edge-Region` contains only the three-letter Cloudflare PoP code obtained
from the same-origin `/cdn-cgi/trace` endpoint. The helper reads no IP field and
returns, logs and persists none of the rest of the trace response. Discovery is
cached for 15 seconds per runtime (including failed discovery), has a one-second timeout and is disabled on loopback.

`createBrowserTelemetry()` builds an isolated runtime with injected clock,
crypto, location and trace-fetch dependencies; it is the test seam.

## Server primitives

```ts
import {
  metadataFromHeaders,
  presenceKeys,
  sourceRegionFromEdgePop,
} from '@oxy.so/telemetry/server';

const metadata = metadataFromHeaders(request.headers);
const sourceRegion = sourceRegionFromEdgePop(metadata.edgePop); // 'edge-mad' | undefined
const keys = sourceRegion ? presenceKeys(sourceRegion, Date.now()) : [];
```

Validation accepts a three-letter PoP and a 16–64 character opaque activity ID.
It ignores IP and forwarding headers. This package does not instantiate a
store, keep server-global maps, start timers or send realtime events.

`serviceFromPath`, `activityFlow`, `presenceBucket`, `ActivityCardinalityAdapter`,
`ActivityBucket`, `DEFAULT_ACTIVE_CLIENT_WINDOW_MS`, `getBrowserTelemetryHeaders`
and `createBrowserTelemetry` are deprecated: nothing in Oxy uses them and they go in
the next major.

## Active-client definition

An active client is one distinct ephemeral activity ID observed for an edge PoP
during the rolling 60-second presence window. The default representation is the
union of the current and previous 30-second buckets returned by `presenceKeys`.
This is an operational count of active page runtimes, not authenticated users,
people, devices or sessions. ID rotation and multiple tabs mean it must never be
presented as an exact person count.

## Privacy boundary

Allowed public dimensions are PoP, bounded service group, processing region,
request count, approximate active-client cardinality and aggregate timestamps.
Forbidden inputs and outputs include raw or hashed IPs, coordinates derived from
an IP, user/account/session IDs, request bodies, query strings and raw paths.
The opaque activity ID exists only to estimate short-window cardinality and must
not be persisted as an event log or joined to product identity.

## Migration from `@oxy.so/*`

The first consumers will replace browser helpers currently owned privately by
`@oxy.so/core` with imports from `@oxy.so/telemetry/browser`. API collectors will
replace their local validation and bucketing logic with
`@oxy.so/telemetry/server`. This package deliberately provides no compatibility
re-export: consumers move imports directly to the new owner, then the old
private implementations are deleted in the same integration change.

The central API uses the server entry point. Core retains deprecated compatibility
exports while applications migrate their direct imports.

## Collector, realtime and reconnect

The collector records successful, failed and aborted HTTP requests. A completed
response is a separate observed outbound flow; an aborted request never produces
a fabricated response. Scope (`internal`/`external`), direction relative to the
reporter (`inbound`/`outbound`) and type (`identity`, `ai`, `communication`,
`media`, `platform`) are independent dimensions. Source and destination always
follow the actual movement, even when two services share one region.

`trafficMiddleware` attaches before routes and reads the verified service
identity after route authentication. `instrumentTrafficFetch` observes actual
outbound calls; internal destination regions come from the peer's `X-Oxy-Region`
response, not a guessed IP location. Unlocated peers remain unlocated. Health,
telemetry collection, infrastructure snapshots, service-token minting and
`/cdn-cgi/` are excluded from observation to prevent control traffic feedback;
`isObservedPath(path, direction)` (reading the `UNOBSERVED_PATHS` table) is the one predicate, so an adapter that does its own
interception imports it instead of copying a pattern.
Custom transports can call the collector's `record` method explicitly.

Each collector retains at most 512 distinct pending flows and publishes chunks
of at most 256. Publishing is best effort: a failed batch is discarded, with no
durable retry queue. These are live operational observations, not billing or
lossless historical request totals. No dashboard viewer is needed to collect.

Realtime transport publishes aggregate buckets, not individual metadata. A
socket event carries `ActivityAggregate` (a `TrafficAggregate` plus
`activeClients`; the infrastructure snapshot is `InfrastructureSnapshot`): request count, approximate active
clients, source/target regions, service and window timestamps. Transport and
fan-out are application concerns and intentionally absent from this package.

Realtime activity events are not a durable replay log. The dashboard retains a
60-second window of distinct flows and resumes live events on reconnect.
Infrastructure is separate: the API broadcasts a complete snapshot on connection
and on changes. Registration/removal updates immediately; heartbeats run every
10 seconds and crashed instances expire after 45 seconds (observed at the next
registry refresh). Only reporting instances are included. The publisher must be
installed in each service before this can represent the whole ecosystem.

The authenticated publisher is `createEcosystemTraffic` from `@oxy.so/core/server`.
It exposes HTTP middleware, `wrapFetch`, `record` for explicit transport events,
and `stop` for graceful removal. It requires a known infrastructure region (or
explicit infrastructure coordinates) and registered temporary workload identity
for own service publication ([ADR 0049](../../docs/adr/0049-first-party-platform-authority.md)).
The shared OxyServer performs attestation and live binding checks. A process can
supply `workloadCredentials` from `createAwsWorkloadCredentialProvider()`
(`@oxy.so/core/server/aws`) for the supported temporary AWS provider chain.
There is no activity-key or service-key fallback for own publication. External
customer API credentials remain separate and do not become first-party authority.
Credentials, user metadata and paths never enter public snapshots. Activity's
internal/external `scope` field classifies traffic; it is not an OAuth permission.

## Operational metrics (CloudWatch EMF)

```ts
import { createEmfPublisher, HTTP_REQUEST_LATENCY, statusClass } from '@oxy.so/telemetry/metrics';

const metrics = createEmfPublisher({ namespace: 'Oxy/Api', service: 'oxy-api' });
metrics.record(HTTP_REQUEST_LATENCY, elapsedMs, {
  Route: '/users/:id', // a log property: free, grouped in Logs Insights
  StatusClass: statusClass(res.statusCode), // a dimension: billed per value
  Caller: 'anonymous',
});
// On shutdown:
metrics.stop();
```

Observations are aggregated in memory and written once per interval (60 s) as
one stdout line per (metric, label set). On ECS with the `awslogs` driver,
CloudWatch Logs extracts the metrics itself: no agent, sidecar or IAM grant.
A `distribution` keeps a ~5 % bucketed histogram, so CloudWatch answers
SampleCount (the count) and percentiles for it.

Every distinct combination of DIMENSION values is a billed custom metric, so a
label is a dimension only when the definition lists it in `dimensionSets`, and
only closed, small sets belong there (status class, a first-party caller).
Route, method, table and every other label stay plain properties on the line:
`stats sum(RequestLatency.Count) by Route` in Logs Insights. At most
`maxSeries` (default 2000) series are held per interval; past that, new series
fold into one whose labels read `other`.

On ECS only, `createEmfPublisherIfDeployed(options)` returns the same publisher
and `null` elsewhere (it checks `ECS_CONTAINER_METADATA_URI_V4`), so a service
does not repeat that gate.

### Conformance fixture

`fixtures/emf-golden.json` is the cross-language contract for the EMF line format.
Each case holds a metric `definition`, `service`, `namespace`, a fixed `now`
(the line's `Timestamp`), optional `maxSeries`, the `observations`
(`{labels, value}`; the strings `"NaN"`, `"Infinity"` and `"-Infinity"` stand for
the non-finite numbers JSON cannot carry) and the `expectedLines` the publisher
must write on flush, in series first-seen order. Lines are compared as parsed
JSON, not as bytes. `src/__tests__/emfGolden.test.ts` runs every case through the
real publisher.

Kaana's Go `internal/emf` must consume the same file (a vendored copy that a
Kaana test keeps byte-identical to this one) and pass every case; change the
fixture here first. Label values are truncated by UTF-16 code units, so a Go
implementation counts UTF-16 units, not bytes or runes. The fixture avoids a cut
inside a surrogate pair, whose result is a lone surrogate that UTF-8 cannot carry.

## Development

```bash
bun run --filter @oxy.so/telemetry typescript
bun run --filter @oxy.so/telemetry test
bun run --filter @oxy.so/telemetry build
```
