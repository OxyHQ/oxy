# Changelog: `@oxy.so/telemetry`

## 2.2.0

Additive: single sources for constants and logic that consumers each copied. No
consumer is migrated by this release and no existing behaviour changes, except
the outbound-fetch exclusion widening listed under Changed.

### Added

- `OXY_TELEMETRY_REQUEST_HEADERS` (`X-Oxy-Activity-Id`, `X-Oxy-Edge-Region`: what
  a browser sends, for a CORS `Allow-Headers` list) and
  `OXY_TELEMETRY_EXPOSED_HEADERS` (`X-Oxy-Region`, for `Expose-Headers`), plus the
  constants `OXY_REGION_HEADER` and `OXY_SOURCE_REGION_HEADER`
  (`X-Oxy-Source-Region`, service to service, deliberately not in the request
  list). Tests pin the lists to the constants.
- `@oxy.so/telemetry/collector`: `isObservedPath(path)`, the one predicate for
  "is this path observed?" (probes, the dashboard transport and collection,
  service-token minting, `/cdn-cgi/`). The collector now uses it everywhere.
- `@oxy.so/telemetry/server`: `sourceRegionFromEdgePop(pop)`, the one `edge-<pop>`
  derivation, now used by the collector middleware and the socket/WebSocket
  observers.
- `@oxy.so/telemetry/metrics`: `createEmfPublisherIfDeployed(options, env?)`,
  `null` unless `ECS_CONTAINER_METADATA_URI_V4` is set.
- Root entry types: `TrafficScope`, `TrafficDirection`, `TrafficType`,
  `TrafficFlow`, `TrafficAggregate` (the API's strict activity-batch schema),
  `InfrastructureNode` and `InfrastructureSnapshot` (the `platform_infrastructure`
  socket payload). The collector entry re-exports the traffic types unchanged.
- `fixtures/emf-golden.json` and its test: the cross-language EMF conformance
  fixture Kaana's Go `internal/emf` must also pass (see the README).

### Fixed

- `ActivityAggregate` was stale (`direction: 'inbound'` only, no scope, type or
  service fields). It is now `TrafficAggregate & { activeClients: number }`,
  the exact `platform_activity` socket payload. Nothing in any Oxy repo imports it.

### Changed

- The outbound-fetch exclusion in `instrumentTrafficFetch` was narrower than the
  inbound one (only `/internal/activity`, `/auth/service-token` and
  `/platform-infrastructure`). It now uses `isObservedPath`, so outbound calls to
  probes (`/health`, `/ready`, `/live`), `/platform-stats`, `/platform-activity`,
  `/infra-status`, `/platform-infrastructure/...` and `/cdn-cgi/` are no longer
  recorded as traffic. The inbound middleware behaves exactly as before.

### Deprecated (removal planned for the next major)

No repository under `~/Oxy` imports any of these (verified by search, including
`origin/main` of oxy): `serviceFromPath`, `activityFlow` (and `ActivityFlow`),
`ActivityCardinalityAdapter`, `presenceBucket`, `ActivityBucket`,
`DEFAULT_ACTIVE_CLIENT_WINDOW_MS`, `getBrowserTelemetryHeaders` and
`createBrowserTelemetry` (kept as a test seam until then). The README no longer
advertises them.

## 2.1.0

### Added

- `@oxy.so/telemetry/metrics`: `createEmfPublisher`, a CloudWatch Embedded
  Metric Format publisher for operational metrics. It folds observations in
  memory and writes ONE stdout line per (metric, label set) per interval, so a
  service on ECS with the `awslogs` driver gets CloudWatch metrics with no agent,
  sidecar or scraper. `distribution` metrics carry `Values`/`Counts`, so
  CloudWatch answers SampleCount and p50/p99. Only labels a definition names in
  `dimensionSets` become billed dimensions; every other label is a free log
  property for Logs Insights. Series per interval are capped (`maxSeries`).
  Also `HTTP_REQUEST_LATENCY`, `HTTP_RATE_LIMITED` and `statusClass()`, the
  shared request-metric definitions oxy-api and Mention publish.

## 2.0.0

### Removed (breaking)

- The `@oxy.so/telemetry/edge` entry point (`observeEdgeRequest`,
  `EdgeActivityEnv`). It published Worker/Pages request activity with a per-app
  Oxy key pair (`OXY_EDGE_ACTIVITY_API_KEY/SECRET`) that was never provisioned,
  so no deployment ever published through it. Oxy now reads web traffic from
  Cloudflare's own analytics in oxy-api, keylessly. Consumers drop the wrapper
  and call their handler directly; published 1.2.0 keeps working until then.

## 1.2.0

### Added

- `peekBrowserEdgeRegionHeader()` (and `peekEdgeRegionHeader()` on a
  `createBrowserTelemetry` instance): the last known edge-region header,
  synchronously. It never waits on the `/cdn-cgi/trace` fetch — `{}` until the
  first discovery lands, and a stale value is refreshed in the background
  (every 10 minutes by default, `edgePeekRefreshMs`). `@oxy.so/core` 3 sends it
  on every request instead of awaiting `getBrowserEdgeRegionHeader()`.
