# Dedicated product-journey acceptance

This operator uses normal public registration and signed Commons approval with
new QA keys. It never imports or reads a device key store, fabricates a session,
injects browser storage or substitutes API responses. The signer represents the
Commons protocol peer; it does **not** establish acceptance of Commons' native UI.

Install this independent package with `bun install --minimum-release-age=0`
and run `bun run test`. Live product tests are skipped unless `OXY_QA_LIVE=1`. Its published Core 7.4.0 dependency is separate from the
product bundles under test. No production work happens during install/tests.

## Reviewed operations

Set `OXY_QA_DIR` to an explicit absolute, dedicated directory (0700; files 0600).
The two slots are `a` and `b`; preparation refuses to overwrite a
slot. Never print their contents or retain browser HAR/traces containing tokens.

- `bun run qa prepare a`: generate only a local key, no network.
- `bun run qa register a`: normal signed `POST /auth/register` through the SDK;
  only a new dedicated QA identity. Record the returned account id for cleanup.
- `bun run qa authenticate a`: normal public challenge/verification and `/users/me`.
  This also recovers the same key-owned QA account if registration succeeded but
  the atomic local save failed; it never registers another account.
- `signedApproval('a', publicCode, productOrigin)`: check the real approval-info
  origin, lifetime and own scope-free lane; sign a fresh challenge and approve
  the request initiated by the actual product UI. The product claims and stores
  its session itself. Never log the public code or the request's secret handle.
- `bun run qa delete a <exact-account-id>`: prove the fixture key, check current
  username/id, delete only that account with the normal signed endpoint, verify
  the bearer is refused, then remove the fixture key. Failed cleanup preserves
  the key for recovery. Delete test-owned product artifacts first.

## Acceptance sequence and boundaries

1. Verify public Console, Mention and Alia bundles in fresh Chromium profiles.
2. Register the two QA fixtures after operator review. Sign into Console through
   its actual dialog/Commons request. Read settings; exercise adding the second
   account, switching, reload, sign-out and the resulting account-specific reads.
3. Open Mention's actual Alia sheet. Check normal model/catalogue availability
   before generation. Send one short text-only request, then a second bounded
   streaming request cancelled through the public linked SDK transport. The API
   cancellation test is distinct from the product UI stop control. Record transport/status/terminal
   events and account/conversation attribution, without credentials or unrelated
   user content. Abort on unavailable routing/funding; do not provision credits,
   provider keys or policy changes to force a pass.
4. Verify account isolation after switching and logout. Remove only fixture-owned
   conversations/artifacts, then delete both QA accounts and private files.

Each production write needs an explicit bounded stage in the run receipt.
No payment, publishing, email, bot creation or domain tool is part of these
fixtures. Report UI, protocol, runtime attribution and native evidence separately.
Physical-device checks must use the explicitly selected test device and preserve
all pre-existing identities, keys, applications and data.

## Reproducible live gates

After normal registration and Console onboarding for both QA slots, run
`OXY_QA_LIVE=1 bun run test` with the private directory configured.
`browser.test.mjs` exercises the deployed Console UI without token injection or
response substitution. `alia-ownership.test.mjs` reads the previously created
Mention-origin fixture as A and B, requiring owner 200 and other-account 404.
These tests create normal sign-in sessions but perform no generation.

`alia-readback.mjs` records only the owned conversation metadata and response
cookie **names**, never cookie values. `alia-cancel.mjs` is a separately reviewed
single-generation operator: `instant`, `max_tokens: 64` (or the separately reviewed
`OXY_QA_CANCEL_MAX_TOKENS=256` probe), one request, no retries,
abort on first content or any tool event, and a 25-second deadline. An exclusive
attempt marker prevents re-running an uncertain request. The remote API always
retains its own policy and budget checks. A client AbortError alone does not prove
provider cancellation or refund; correlate the actual server request and ledger.

The independent package lock pins the operator, not the deployed apps. Product
artifacts, native APK provenance, server receipts and remaining limitations are
recorded in the dated acceptance evidence document.
