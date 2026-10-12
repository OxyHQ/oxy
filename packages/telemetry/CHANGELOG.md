# Changelog: `@oxy.so/telemetry`

## Unreleased

### Removed (breaking — the next release is a major)

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
