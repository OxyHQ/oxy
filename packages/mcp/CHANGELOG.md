# Changelog: `@oxy.so/mcp`

## 1.2.0

### Added

- `InternalMcpRefusedError` from `createInternalCatalogMcpClient`: the app
  refused the call before it ran, so the operation did NOT happen — the MCP
  connection failed (the call was never sent) or the call came back 4xx (not
  408) or 503. Every other failure may follow a committed effect and stays a
  plain error the caller must treat as an unknown outcome. Alia read Mention's
  not-ready lane (503) as "outcome unknown" for every read until this.

## 0.6.0

### Added

- `McpConnectionState`, `mcpConnectionStateSchema` and `mcpConnectionStateFrom`:
  the account set one MCP connection may act as, as Oxy reports it on
  introspection (ADR 0020).
- `requestOxyMcpAccountLink` and `selectOxyMcpConnectionAccount` — the two
  connection calls a resource server makes on behalf of a live token: mint the
  single-use link that adds another account, and act as a member.
- `postOxyServiceJson` / `OxyMcpRequestError` for service-authenticated Oxy calls,
  shared with introspection.

### Changed

- `McpPrincipal` gains `activeAccountId` and `connection`. `accountId` is still
  the account the TOKEN is bound to; `activeAccountId` is the member to serve,
  and equals `accountId` on a connection that was never widened.
- `createCatalogMcpHttpService` binds an app's authorization decision to
  `activeAccountId`, so a catalog app serves the selected member.

## 0.1.0

### Added

- Canonical app-catalog adaptation to MCP tools with matching input and output
  schemas.
- OAuth protected-resource validation with exact resource, audience, account
  and live-authorization checks.
