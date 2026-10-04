# Own-Alia private Auto source approval

`reviewed-source-approval.json` is the exact root-frozen approval (SHA-256
`48cc94c95a4d2c0987facb9c5f1bbe9afaee559d3c3b1d733f91f3ebfcb51d1e`).
The source getter parses those same fields independently on each call and denies
at the fixed expiry `2026-10-05T22:51:12Z`. The source contains no request input or
credential material. Existing key and credential identifiers are authority metadata.

The root freeze references the actual repeatable-read imported price readback
(SHA-256 `5346f023fd5ebcdb45b6807363b9e0f19669cdab3cf6a4b8f97c87108f1b3f44`)
and the bounded-content clarification
(SHA-256 `68c6238e7013238963e49b7eb2220155eb25f7c9f3238b2a9f149a9791e3bed0`).
The readback verifies the existing active USD price for the exact Jev revision and
OpenRouter provider, not a new deployment-specific model price or a paid invoice.

This source-only change performs no rollout, database/legal review, provider POST,
key binding, publication or new grant. Pending canonical private legal review
continues to block runtime admission. The retained commissioning 3.6 permit and
ordinary/public decisions gate are unchanged. Real qualification remains pending.
