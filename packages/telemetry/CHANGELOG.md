# Changelog: `@oxy.so/telemetry`

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
