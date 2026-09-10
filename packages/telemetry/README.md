# `@oxy.so/telemetry`

Framework-agnostic primitives for anonymous, real-time Oxy activity telemetry.
The package has no runtime dependencies and does not import Express, Socket.IO,
Redis, React, React Native or Expo.

Version: `0.1.2`.

## Entry points

- `@oxy.so/telemetry` — shared header names and aggregate interfaces.
- `@oxy.so/telemetry/browser` — ephemeral browser metadata.
- `@oxy.so/telemetry/server` — pure validation, route bucketing and cardinality
  keys/interfaces.

Browser code must import the browser entry point explicitly. Server code must
import the server entry point explicitly; the root entry point has no platform
side effects.

## Browser metadata

```ts
import { getBrowserTelemetryHeaders } from '@oxy.so/telemetry/browser';

const headers = await getBrowserTelemetryHeaders();
await fetch('https://api.oxy.so/session/status', { headers });
```

`X-Oxy-Activity-Id` is generated in memory for the current page runtime and
rotates every five minutes. It is not placed in a cookie, local storage,
session storage, IndexedDB or a URL. Closing or reloading the page loses it.

`X-Oxy-Edge-Region` contains only the three-letter Cloudflare PoP code obtained
from the same-origin `/cdn-cgi/trace` endpoint. The helper reads no IP field and
returns, logs and persists none of the rest of the trace response. Discovery is
cached per runtime, has a one-second timeout and is disabled on loopback.

Use `createBrowserTelemetry()` to create an isolated runtime or inject clock,
crypto, location and trace-fetch dependencies in tests.

## Server primitives

```ts
import {
  activityFlow,
  metadataFromHeaders,
  presenceKeys,
  serviceFromPath,
  type ActivityCardinalityAdapter,
} from '@oxy.so/telemetry/server';

const metadata = metadataFromHeaders(request.headers);
const sourceRegion = metadata.edgePop ? `edge-${metadata.edgePop}` : undefined;
const flow = activityFlow(sourceRegion, serviceFromPath(request.path));
const keys = sourceRegion ? presenceKeys(sourceRegion, Date.now()) : [];
```

Validation accepts a three-letter PoP and a 16–64 character opaque activity ID.
It ignores IP and forwarding headers. `serviceFromPath` keeps only a bounded,
static first route segment, so IDs and full paths cannot enter aggregates.

`ActivityCardinalityAdapter` describes the minimal storage boundary for an
implementation such as Redis HyperLogLog. This package does not instantiate a
store, keep server-global maps, start timers or send realtime events.

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

The intended collector records only successful, non-control-plane requests. It
increments request totals per `source region × bounded service × time window`
and sends the ephemeral activity ID to a cardinality adapter, never to an event
row or log.

Realtime transport publishes aggregate buckets, not individual metadata. A
socket event may carry `ActivityAggregate`: request count, approximate active
clients, source/target regions, service and window timestamps. Transport and
fan-out are application concerns and intentionally absent from this package.

Realtime events are not a durable replay log. After reconnect, a consumer first
loads the collector's current aggregate snapshot and then resumes the live
stream, deduplicating any overlapping window by its stable flow/window identity.
Reconnect backoff, socket lifecycle and snapshot endpoints belong to the
consumer and collector, not these pure primitives.

## Development

```bash
bun run --filter @oxy.so/telemetry typescript
bun run --filter @oxy.so/telemetry test
bun run --filter @oxy.so/telemetry build
```
