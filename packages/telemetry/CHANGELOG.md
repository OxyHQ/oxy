# Changelog: `@oxy.so/telemetry`

## 1.2.0

### Added

- `peekBrowserEdgeRegionHeader()` (and `peekEdgeRegionHeader()` on a
  `createBrowserTelemetry` instance): the last known edge-region header,
  synchronously. It never waits on the `/cdn-cgi/trace` fetch — `{}` until the
  first discovery lands, and a stale value is refreshed in the background
  (every 10 minutes by default, `edgePeekRefreshMs`). `@oxy.so/core` 3 sends it
  on every request instead of awaiting `getBrowserEdgeRegionHeader()`.
