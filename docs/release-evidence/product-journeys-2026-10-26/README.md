# Cross-product acceptance — 26 October 2026

This run exercises deployed product interfaces with two dedicated QA accounts.
It supplements the completed workload retirement; it does not reopen its gates.
The [sanitized receipt](./receipt.json) distinguishes browser, API and device
observations. No personal account, existing device key or production policy was
used or modified.

## Observed results

| Journey | Result and boundary |
| --- | --- |
| Console sign-in and settings | The actual account dialog created its own request, received a normal signed Commons approval and claimed the session. Authenticated account/security settings rendered. No browser token injection, mocked API response or cookie. |
| Console account isolation | The real Chromium test added B, switched B → A, signed out A while preserving B, then signed out B. Reload remained anonymous. Both account-specific dashboards were asserted. |
| Mention → Alia | Mention authenticated QA A through the normal dialog. Its actual Ask Alia sheet displayed `QA_OK` after the short text-only request. Alia recorded the conversation with `app: mention`. This is a product UI result, not only a protocol fixture. |
| Conversation ownership | Actual public linked SDK reads returned 200 for A and 404 for B for the same conversation. No tool invocation was present in the stored readback. |
| Streaming and cancellation | Two separately bounded public API requests used `instant`, caps of 64 and 256 output tokens and no retry. Both received content and produced an AbortError after client cancellation. The larger request delivered several distinct SSE chunks. These are API cancellation observations, not a UI Stop-button test or proof of upstream cancellation. |
| Android broker | A new secondary Pixel 8a user contained the existing Commons APK and a newly built, ecosystem-signed Mention APK from exact source `7587a6af619fa6c02d6b650bdf0ded8cb9746a07`. Importing only QA A's key into that profile, then Mention's “Continue with Oxy”, produced the exact QA profile without an email/QR/browser-token workaround. Mention retained the session after a process cold start. |

The Console test is reproducible in
[`scripts/acceptance/product-journeys`](../../../scripts/acceptance/product-journeys/README.md).
Its ordinary test command does not contact production. Explicit live mode uses
already prepared QA fixtures and records only sanitized observations.

## Findings and limits still being checked

- Opening Ask Alia introduced `AWSALBCORS` for `api.alia.onl`. A normal authenticated
  `GET /conversations?app=mention&limit=10` at 06:02:01 UTC independently returned
  `Set-Cookie` names `AWSALB` and `AWSALBCORS`. Values were neither printed nor
  retained. This violates the zero-cookie invariant; its infrastructure fix is
  a separate change. Functional success does not turn this check green.
- The 64-token provider turn completed near the client cancellation boundary and
  was persisted. It therefore does not prove an in-flight provider cancellation.
  The 256-token probe established continued server work: the client aborted at 06:13:41.084 UTC,
  Kaana completed at 06:13:49.705 UTC, and Alia settled 240 output tokens at
  06:13:49.778 UTC. The server intentionally supports completion after a disconnected client. The SDK
  UI Stop currently calls only `AbortController.abort()` (`use-conversation-stream.ts`),
  so explicit Stop and an incidental disconnect are not distinguishable to that
  handler. This contract needs correction without breaking background completion.
  The client AbortError is not an upstream cancellation acceptance pass.
  Exact request identifiers and hashed read-only server receipts are in the JSON.
  Oxy settlement consistency is a separate readback, not inferred from one SSE response.
- The installed Commons APK is version 1.4.0/code 5 with an unknown source commit.
  Its onboarding repeatedly reported offline although the new Mention APK
  subsequently authenticated the same imported QA identity. No current-source
  Commons UI pass or public-key-fingerprint UI observation is claimed.
- Native testing used only the newly created secondary user. The original user
  was restored; cleanup of the QA profile and accounts follows the remaining
  server readbacks. No owner-profile screenshot, identity store, app reset or
  global Commons update was performed. This is Android evidence, not iOS or
  desktop-distribution acceptance.

Three generations were made in total: one normal UI response and two targeted
cancellation attempts. No credits, provider credentials, routing rules or app
permissions were provisioned. No public post, email or other external tool action
was requested. QA cleanup remains an explicit final stage rather than an assumed
side effect of closing the browser.
