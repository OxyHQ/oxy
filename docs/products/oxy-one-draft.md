# Oxy One Personal local implementation review

This isolated draft implements a versioned catalogue and SDK read model, public Website `/one`, Accounts plan and subscription presentation, and source-specific adapters in Alia, Mention and Noted. The approved display price is USD 29.99/month, with no trial or annual plan. Benefits are Alia Pro-level 10,000 monthly credits plus existing daily free refill, shared 100 GB decimal storage including Noted attachments, and Mention mono personalization. Personal only.

## Authority and purchase boundary

The detached catalogue template contains editorial terms and benefits; runtime configuration remains unconfigured. Provider choice, provider price IDs and registered product/application/owner identities require review. Server checkout selects an owned offer/version and requires an exact approved amount/currency match. No live provider is connected, and purchase remains unavailable. Existing API-credit checkout is not presented as consumer bundle checkout. Stripe-specific cancellation cannot promise another provider.

SDK service snapshots require the existing account-specific offline consent, application/product identity and intersected scopes. Private profile personalization responses are uncached and subject to account ownership. Accounts and application query state fence account/session switches, reject mismatched responses and hide stale authority.

## Working draft integrations

Alia maintains durable subscription-period allocations independently of free and individual paid balances, reserves and settles real credit operations, and rechecks time after allocation-row lock waits. Cancellation, expiry, overlap and replay cannot mint renewed allowance. Queue identity is persisted without user tokens. Actual balance and plan UI displays the independent sources. Voice requests with an eligible bundle or unknown configured authority fail before inference/storage because a voice-to-credit accounting policy is not approved.

Mention gates mono through the specific capability and canonical profile preset shared by contracts, SDK and API, preserving eligible individual sources. Noted routes attachment ownership and usage through shared storage and fences account/session changes; its ordinary notes and exports remain usable.

Storage admission accounts for actual transformed bytes, streamed owner uploads, pending reservations and durable physical-object cleanup holds. Signed uploads bind exact size/checksum, use unique keys and a restricted SDK transport. Recovery requires trusted quiescence and verified absence; presigned holds do not automatically expire. Fresh configured video/HLS and unsupported copies fail closed. This is not a claim of a globally enforced physical 100 GB cap: historical inventory, uncommitted multipart parts and operational recovery deployment still require review. See `oxy-one-physical-storage-draft.md` and `oxy-one-personalization-upload-draft.md`.

## Validation and delivery limits

Focused API, SDK, Accounts, Alia allocation/locking/UI/voice, Mention and Noted suites passed; Website production build and network-blocked desktop/mobile browser QA passed. The review archive records exact commands, counts, bases and heads. QA screenshots use explicitly synthetic catalogue fixtures, not active purchasable offers.

Alia full dependency installation remains blocked by an upstream libsignal tarball HTTP 403; no bypass was attempted. SDK dist was copied only into ignored local installed packages for cross-repository validation. Normal SDK publication/adoption is required before release. Migrations 0148 and 0149 are prepared together and were not run against production. No remote publication, deployment, catalogue activation, subscriptions or charges occurred.
