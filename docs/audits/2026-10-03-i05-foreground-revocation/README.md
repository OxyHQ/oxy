# Common SDK direct-approval revocation

Source `7e35b77ff3f5fdf61db2d6b3b838627f8f60bd05` adds
`OxyServer.agency.revokeExecutionAuthorization(id, { requesterToken })` for the
existing requester-authenticated DELETE route. It sends only the requester
bearer to the configured Oxy baseURL; no service mint, attribution override,
cache, deduplication, retry or token log is added. Bounded malformed inputs and
pre-aborted signals are refused before transport. Network failure propagates.

Six own-package tests, strict core TypeScript and two-file scoped Biome pass.
A newly built/packed core candidate runs both ESM/CJS creation and DELETE through
real bounded loopback HTTP after installation. All 581 core files match the
archive. Consumer strict TypeScript uses skipLibCheck. These are transport and
export checks; actual authorization remains the existing API route, and this
packet does not claim publication or live consumer adoption. The prior accepted
archives and consumer are retained unchanged.

The same source corrects a duplicate backslash in the foreground token OpenAPI
pattern. Runtime validation was already correct. Generated pattern positives
and negatives, freshness and 37 guard fixtures pass. The initial installed
fixture's only failure was its old expected four-call count after adding two
DELETE calls; its actual final bound is exactly six, without changing product
behavior.
