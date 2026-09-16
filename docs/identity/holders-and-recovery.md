# Root holders, enrollment and recovery — inventory

The living record for #1302 and [ADR 0024](../adr/0024-one-oxy-account-root-holders.md).
The ADR says why; this page says what exists, who calls it, and what is still
unverified or unbuilt. Update the row when the code changes — a stale row here is
a bug.

## Vocabulary (for engineers, never for product copy)

| Term | Meaning |
|---|---|
| Root | The account's self-custody secp256k1 key, linked as `users.public_key`. From a BIP-39 phrase (12–24 words): `seed[0:32]`. A few legacy roots are raw private keys with no phrase. |
| Holder | A user-controlled place that can use the root: Commons' keychain, or a web envelope wrap that one passkey's PRF output opens. |
| Recovery material | A phrase or a raw private key. Not a holder. |
| Web envelope | `identity_web_envelopes`: sealed secret + one wrap per passkey. Ciphertext only. Version 1 = 12-word entropy; version 2 = entropy of any length or a raw key, RP-bound wraps. |
| Holder host | `id.oxy.so` — the internal origin that runs every root operation in a browser (ADR 0024 D1). Never named in product copy. |
| Root proof | A signature by the root over `buildIdentityProofMessage` claims, spending a one-use challenge (ADR 0024 D7). |

## Invariants and where they are enforced

| Invariant | Enforced by |
|---|---|
| A personal account is created with its root, or not at all | `POST /webauthn/register/verify` refuses sign-up without `identity` (`IDENTITY_ENROLLMENT_REQUIRED`); the holder host confirms a stable PRF output before registering; `auth.oxy.so` sign-up opens the holder flow; `useOxy().registerWithPasskey` rejects |
| Signing in never unlocks the root | `packages/id/src/identity/passkey.ts` (`assertPasskey` has no PRF extension); status from `GET /identity/web-envelope` metadata or `GET /identity/root-status` |
| Every root operation is one fresh ceremony, wiped after | `withRoot` / `openRootForDisplay` in `packages/id/src/identity/carrier.ts` |
| A root is linked first-time only, with a fresh factor | `POST /auth/link` and `POST /identity/web-envelope/establish` (proof + WebAuthn assertion over the same challenge) |
| A root is never unlinked | `DELETE /auth/link/identity` → `IDENTITY_ROOT_NOT_UNLINKABLE` |
| A root is replaced only by rotation | `POST /auth/rotate/*` (old-root + new-root proofs); rotation deletes the old root's envelope and backup |
| Envelope writes are payload-, revision- and challenge-bound | `identityWebEnvelope.ts` + `identity_proof_challenges`; v1 proofs refused |
| Concurrent holder changes cannot drop each other | `identity_web_envelopes.revision` compare-and-swap (`IDENTITY_ENVELOPE_REVISION_CONFLICT`) |
| Removing a passkey never strands the web holder | `DELETE /auth/link/webauthn/:id` drops that passkey's wrap and refuses the last one (`IDENTITY_LAST_WEB_HOLDER`) |
| Recovery needs only the root | `POST /identity/recovery/{challenge,start,complete}` |
| A stale local copy never overrides the server | The holder uses IndexedDB only when the API gives no answer, and only to show the phrase |
| A transfer relay cannot steer both codes together | Transfer protocol v2 commitment; SAS over both keys + commitment |
| A web holder is removed only after Commons stored the root | v2 receipt signed with the key read back from Commons' keychain, bound to the relayed ciphertext, verified by the web from what it sealed |
| The DID of a personal root is controlled by the person | `buildDidDocument` → `controller: [userDid]` |
| `auth.oxy.so` runs no third-party analytics | No PostHog dependency or wiring; Pages headers in `sensitive` mode strip the Cloudflare beacon; `packages/auth/lib/__tests__/sensitive-origin.test.ts` |

## Routes that touch a personal root

| Route | Authority required | Notes |
|---|---|---|
| `POST /identity/proof-challenge` | bearer | One-use challenge bound to account, action and the root linked at mint time. |
| `GET /identity/root-status` | bearer, any first-party origin | Readiness metadata only. |
| `GET /identity/web-envelope` | bearer, holder host | Envelope + `revision` + holders + readiness facts. |
| `PUT /identity/web-envelope` | holder host, root proof over the envelope digest, `expectedRevision` | CAS on `revision`. |
| `POST /identity/web-envelope/establish` | holder host, root proof, fresh WebAuthn assertion by an existing passkey | Keyless account's first root (or a web holder for a root with none), atomically. |
| `POST /identity/web-envelope/phrase-confirmed` | holder host, root proof, `expectedRevision` | Recovery material written down. |
| `POST /identity/web-envelope/recovery-verified` | holder host, root proof, `expectedRevision` | Recovery material re-derived the root. |
| `DELETE /identity/web-envelope` | holder host, root proof, `expectedRevision` | Removes the web holder. |
| `POST /webauthn/register/verify` (sign-up) | registration challenge + `identity` (envelope + `enroll_identity` proof over that challenge) | User, passkey, root, both auth methods and envelope in one transaction. |
| `POST /identity/recovery/challenge` | holder host, rate-limited per hashed IP | Names no account. |
| `POST /identity/recovery/start` | root proof over that challenge | Learns the account; registration options for a new passkey; ticket. |
| `POST /identity/recovery/complete` | ticket + registration (UV required) + envelope + `recover_account_complete` proof | New passkey + replaced web holder + session. Old passkeys stay. |
| `POST /auth/link` | bearer; keyless → v2 proof + fresh assertion | First link only; same-root call heals the method row. |
| `POST /auth/rotate/challenge`, `/complete` | old-root + new-root proofs, one-use challenge | Only way to replace a root. |
| `DELETE /auth/link/identity` | — | Always refused. |
| `DELETE /auth/link/webauthn/:id` | bearer | Drops the wrap; refuses the last wrap. |
| `POST /identity/move` (+ `/join`, `/reveal`, `/seal`, `/receipt`, `DELETE`) | see `identityMove.ts` | Transfer to Commons. v2: commitment → join → reveal → SAS → seal → v2 receipt. v1 moves still complete. |
| `DELETE /users/me` | root signature | Account deletion. |
| `/identity/backup*` | seed-derived locator | Commons' encrypted backup (full-seed HKDF). Unchanged. |
| `/device-transfer*` | bearer + root proof | Older raw-key transfer, passive-relay model only. **No caller** in Commons, services or Accounts; slated for removal once confirmed unused in production logs. |

## Callers

| Caller | Uses |
|---|---|
| `packages/id` (holder host) | sign-in (no PRF), sign-up with root, establish, phrase/recovery facts, signed-in reseal, signed-out recovery, transfer initiator (v2), account deletion |
| `packages/commons` | Commons sign-up (`/auth/register`, key included), backup, transfer receiver (v1 + v2) |
| `packages/services` account dialog | opens the holder host `/continue` popup for web sign-in, creation and recovery; native creation goes to Commons |
| `packages/auth` (`auth.oxy.so`) | passkey sign-in (no PRF); sign-up opens the canonical flow |
| `packages/accounts` | `GET /identity/root-status` for the recovery-phrase row and recommendations; passkey list/remove |

## Migration classes

Counted by `packages/api/src/scripts/report-identity-holder-classes.ts`
(aggregate only) and `report-accounts-without-identity.ts`.

Baseline (production, read-only, 2026-09-16, after #1305): 51 local personal
roots, all without a web holder (Commons); 3 keyless personal accounts with a
passkey; 0 without any method; 0 web envelopes; 0 transfers in flight. Federated
rows (~102k) are not personal roots.

| Class | Path |
|---|---|
| Commons-only root | Unchanged. Adding a web holder: "Keep my identity in this browser too" on the holder host (recovery material → establish). |
| Web envelope v1 + `oxy.so` passkey | Keeps working. Wraps with no `rpId` are legacy `oxy.so`. Upgrading to v2 happens on the next reseal or recovery. |
| Local-only / server-missing envelope on the holder host | Local copy used only when the API is unreachable, only to show the phrase; otherwise recovery with material. |
| Envelope the current passkey cannot open | Another wrap, or recovery with material (signed-in reseal or signed-out recovery). |
| Keyless personal account (passkey only) | "Finish securing your account" after sign-in on the holder host (establish, fresh assertion). Never created server-side; no new ones can be created. |
| Keyless personal account with no method | Cannot sign in; no path (no factor to prove). Counted, not migrated. |
| 12- or 24-word phrase | Envelope v2 (`mnemonic-entropy`); transfers to Commons (v2 ciphertext lengths). |
| Raw private key | Envelope v2 (`raw-private-key`); signed-out recovery supported. Transfer to Commons not supported (Commons imports phrases). |
| Rotated root | Old envelope deleted by the rotation; any older one reads as absent (`staleRoot` in the census). |
| Managed / federated / bot accounts | Not personal roots; excluded from every path. |
| Transfer in flight on v1 | Completes on v1 (API and Commons keep v1). The web holder only starts v2. |

## Open work (tracked in #1302)

- **Holder host retirement** (ADR 0024 D1): not started. Criteria are in the ADR.
  `auth.oxy.so` no longer runs third-party analytics, but still loads the full
  SDK/UI graph and has no release manifest, so it does not meet the holder gate.
- **Canonical RP ID** (D2): wraps record `rpId`; no credential has been created
  under a non-`oxy.so` RP yet, and there is no legacy→canonical wrap migration.
- **Browser SSO hub** (#937, ADR 0003): still behind `VITE_OXY_BROWSER_HUB`;
  passkey sign-in on the holder host does not establish a hub session.
- **Consent binding**: the `/continue` screen still relies on an explicit
  acknowledgement; no change in #1302.
- **Commons "sign this" approvals** for roots kept only in Commons: not built.
- **`/device-transfer`** removal after production-log confirmation.

## Not verifiable from source

Open gates, not claimed by any test in this repository:

- PRF at `create()` and at the follow-up `get()`, per browser and provider, and
  synced-copy stability (the matrix in #1302).
- iOS/Android: keychain access groups, the Android session broker, reinstall and
  biometric-change behavior, universal/app links for same-phone continuation,
  and Commons reading the root back before signing the v2 receipt on a device.
- Non-technical usability of create → return → second app → recover.
- A content-addressed release manifest check of what the holder host serves.
