# ADR 0053 — The store distributes OxyOS releases: developer- and store-signed, TUF metadata, installs per account

- Status: proposed (for the owner's review). Nothing is implemented, and no schema,
  route or package changes with this ADR.
- Date: 2026-10-30
- Companion: OxyOS ADR 0030, accepted 2026-10-30
  ([0030-installing-applications.mdx](https://github.com/OxyHQ/OxyOS/blob/main/docs/adr/0030-installing-applications.mdx),
  OxyHQ/OxyOS#164). Its decision 12 is what this ADR decides on this side, and
  the owner's choices it records ("Decided with the platform's author") bind here.
- Builds on: ADR 0012 (Ed25519 for asymmetric signatures), ADR 0045 (app
  recognition), ADR 0047 (Oxy Files on R2, `cloud.oxy.so`), ADR 0049 (no scopes
  between own apps), and the store module (`packages/api/docs/store.mdx`).
- Coordinates with: ADR 0052 (proposed, #2016: the platform holds the session; its
  `oxyos` attestation lane). The per-application token is decided there, not here.
- Scope: what oxy-api, `@oxy.so/core`, `@oxy.so/ship` and the Console add so that
  Atlas can install an application on OxyOS.

## Context

OxyOS installs applications from Atlas, Oxy's store, the way a Mac installs from
the App Store. Under OxyOS ADR 0030:

- A package is the developer's Metro bundle for the `oxyos` platform (JavaScript,
  not Hermes bytecode: Hermes trusts bytecode, so the machine compiles it), plus
  its assets and a JCS manifest naming every file with its SHA-256.
- The developer signs the manifest with Ed25519. The machine pins that key at
  first install, and an update must be signed by it or by a key in its lineage.
- The store signs its approval into TUF metadata (root, targets, snapshot,
  timestamp).
- `oxyos-installd`, a root service, fetches from the store, verifies everything,
  and installs for each account.

The store has none of this:

- **The catalogue has no releases.** `app_listings`, `app_categories`,
  `app_listing_screenshots`, `app_reviews` and `app_review_replies` describe a
  listing. The listing's own header sends versions to `app_updates`. There are no
  platforms, builds, hashes or signatures, and Atlas lists apps it does not
  distribute (its button says *View*, and *Open* goes to `websiteUrl`).
- **Oxy Updates** (`app_updates`, `update_assets`, `update_channels`,
  `routes/updates.ts`, `routes/updatesAdmin.ts`, `oxy-ship`) is the closest thing.
  It is an expo-updates server for `ios` and `android` only:
  - its content-addressed objects (`update_assets`, keyed by SHA-256, immutable,
    `RESTRICT`, under `public/updates/assets/`) and its init/complete upload are
    exactly what a release's files need;
  - but a publisher pushes straight to devices with no review;
  - and every manifest is signed at serve time by an RSA key the API process
    reads from its environment (`UPDATES_CODE_SIGNING_PRIVATE_KEY`, from SSM).
    Whoever runs code in oxy-api can sign code for every device.
- **The inference release tables** (`inference_model_releases`, `…_artifacts`,
  `…_signatures`, `inferenceModelReleaseImmutability.ts`) are the model for
  keeping a signed document: the manifest stored verbatim, an artifact per path,
  detached Ed25519/JCS signatures, append-only by trigger.
- **`application_recognition`** (ADR 0045) holds an application's Android and iOS
  identity, written by staff only. It has no OxyOS identity.

## Decision

### 1. An OxyOS identity on the application's recognition

- **`application_recognition.oxyos_package_id`**: the reverse-DNS id OxyOS uses
  for the application's registry entry and launch records (`so.oxy.mention`). It
  is UNIQUE, written only through the staff recognition lane, as the Android and
  iOS identities are.
- **It is immutable once a release exists.** A trigger refuses the change, and the
  route says why: a machine has pinned it.
- **One identity for both ADRs.** ADR 0052's `oxyos.desktopEntryIds` is this
  column. There is one OxyOS identity per application, never two lists that
  could disagree.

**`application_oxyos_signing_keys`** holds the developer's public keys:
`id`, `application_id`, `key_id` (the first 16 bytes of the key's SHA-256,
base64url), `public_key` (32 bytes of Ed25519, base64url), `status`
(`active`/`retired`), `rotated_from_key_id` and `rotation_signature`, and
`created_by_user_id`, `created_at`.

- **Append-only**, with no `updated_at`. Retiring a key appends a row of its own
  to `application_oxyos_signing_key_events`, never an edit.
- **The first key** is registered by someone with `releases:manage` before the
  first release.
- **Every key after the first release** needs a rotation statement: the JCS
  document `{ application, packageId, newKeyId, newPublicKey, at }`, signed by an
  active key of the lineage, verified at write and stored.
- **A lost key is reset only by a statement the store's offline root threshold
  signs** (decision 4). It is published in the TUF metadata, so it is visible to
  everyone; the online keys cannot do it.
- **The private key never reaches Oxy.** For Oxy's own applications it lives in
  that application's CI secret store, and it is none of the store's keys.

### 2. Releases, their files, their capabilities

**`app_releases`**, one row per submitted release:
- `application_id`, `platform` (`oxyos`, a CHECKed tuple of one), `version`
  (shown to people), `version_code` (an integer that only grows per application
  and platform, UNIQUE on `(application_id, platform, version_code)`);
- `runtime_abi` and `runtime_api` (OxyOS ADR 0030 decision 2);
- `manifest_json` (the document **as received**, the bytes the signature covers,
  exactly as `inference_model_releases.manifest_json` keeps its manifest) with
  `manifest_sha256` and `manifest_size`;
- `signing_key_id` (a reference to the key row) and `developer_signature`
  (base64url);
- `status` and `rollout_percent`;
- `submitted_by_user_id`, `reviewed_by_user_id`, `reviewed_at`, `review_note`;
- `created_at`, `updated_at`.

The signed columns (manifest, digest, size, version, code, runtime, key,
signature) are refused any UPDATE by a column-scoped trigger, the pattern of
`inferenceModelReleaseImmutability.ts`. Status, rollout and review stay writable.

**`app_release_notes`**: `(release_id, locale)` → `body`. These are the words
of a release, not part of the signed package.

**`app_release_files`**: `(release_id, ordinal)` as the primary key, then
`architecture` (`any`, `x86_64`, `aarch64`), `path`, `sha256`, `size`. Its rules:
- **The bytes are `update_assets` rows, reused unchanged.** `sha256` references
  `update_assets.sha256` `ON DELETE RESTRICT`, as `app_update_assets` does. A file
  shared with an update, or with another release, is stored once.
- **The rows must equal the manifest's `files`.** Path, size and digest are
  checked at submit, and a mismatch is a 400 that names the first difference.
- **No native parts for now.** OxyOS ADR 0030's owner decision 9 accepts none, so
  `architecture` is `any` on every accepted release until a native-extension ABI
  exists. Submit refuses the others with a reason, so the column does not need to
  change later.
- **Append-only**, by trigger.

**`app_release_capabilities`**: `(release_id, capability)` → `purpose` (a
`jsonb` map of locale to text). The capability names are OxyOS ADR 0030
decision 8's vocabulary, as a CHECKed tuple. The rows must equal the manifest's
`capabilities`. The review and the store page read these rows, never the
document.

**Where the objects live.** Under `update_assets`' generated key
(`public/updates/assets/<sha256>`), in the bucket and CDN ADR 0047 moved to R2:
`cloud.oxy.so`'s Worker serves `public/` only, and these objects are public.
Renaming the prefix to something neutral (`public/objects/`) is a generated
column, a data move and a Worker purge. That is churn this ADR does not take on
(open question 3).

**Uploading** reuses the two-step presigned flow of `publish.service.ts`
(`initAssets` deduplicating by SHA-256, `completeAssets` checking each object's
size with HEAD), mounted for releases under
`/applications/:appId/releases/oxyos/objects/{init,complete}`.

### 3. States and review

A release moves `draft` → `pending_review` → `approved` → `published`. It can
also leave as `rejected` (out of review), `withdrawn` (by the publisher, before
or after publishing) or `revoked` (by staff, after publishing).

- **Every transition checks its source state**, as listings' do. A wrong one is a
  `409`.
- **Submit** (`releases:manage`) verifies before anything else:
  - the developer signature over `manifest_json`'s bytes, with the named key,
    which must be `active` in the lineage;
  - that the manifest's id is the application's `oxyos_package_id`;
  - that `version_code` is greater than every earlier release's;
  - that every file is `uploaded` and agrees with the manifest;
  - that the capabilities agree with the manifest.

  A release that cannot verify is never stored as submitted.
- **Review** is staff's (`requireStaff`), from a queue beside the listing queue
  (`GET /store/moderation/releases`). It reads each capability's purpose. Approval
  hands the release to the signing service (decision 5), which writes the store's
  signature into the next `targets`, and the release becomes `published` at its
  rollout.
- **Revocation** (`POST /store/moderation/releases/:id/revoke`, with a reason)
  removes the release from `targets` and adds it to `targets`' signed revocation
  list. `oxyos-installd` then stops launching it, tells the person why, and
  installs the newest release that is not revoked. The store fixes a bad release
  by publishing a higher `version_code`, never by serving an older one.
- **First-party only for now.** Submit refuses an application that is not
  `type = 'first_party'` with `isOfficial`, until OxyOS confines applications by
  the kernel (OxyOS ADR 0030 decision 15). Opening the store to third parties is
  then this one check removed, not a redesign.

### 4. The TUF repository

The store serves a TUF 1.0 repository with consistent snapshots, at
`/store/oxyos/v1/` on oxy-api:
- `N.root.json`, `timestamp.json`, `N.snapshot.json`, `N.targets.json` and the
  delegated bins;
- objects by digest from `cloud.oxy.so`.

It is public and unauthenticated, as the storefront is (`docs/store.mdx`).

| Role | Signs | Key | Expiry |
|---|---|---|---|
| `root` | The keys of every role | **Offline**, 2 of 3 hardware keys held by people (the owner's decision) | 1 year, rotated by TUF's chain |
| `targets` | The delegation to the hashed bins | KMS (`targets-release`) | 3 months |
| `bins-NN` (256 hashed bins, by the SHA-256 of `packageId`) | Each published release's target: path `oxyos/<packageId>/<versionCode>/manifest.json` with its hashes and length, and custom data `{ versionCode, runtime: { abi, api }, architecture, signingKeyId, developerSignature, revoked? }`; key resets and revocations | KMS (`targets-release`), at each approval or revocation | 30 days, re-signed weekly |
| `snapshot` | The version of every targets file | KMS (online) | 7 days |
| `timestamp` | The current snapshot | KMS (online) | 1 day, re-signed hourly |

- **Hashed bins** (PEP 458's succinct delegations) keep an approval from
  re-signing one file that lists every application.
- **The CDN** caches the versioned files forever (`immutable`), and
  `timestamp.json` for at most 60 seconds. Objects are immutable by content
  address, as Oxy Updates' are.
- **On the machine,** `oxyos-installd` verifies the chain from the root its image
  carries, refuses older or expired metadata for installs and updates, and never
  needs the metadata to launch what is installed.

### 5. The signing service and key custody

- **Online keys stay out of the API's environment.** The online keys (`targets`,
  the bins, `snapshot`, `timestamp`) are Ed25519 keys in a KMS or HSM that oxy-api
  asks to sign and can never read. Nothing about this store resembles
  `UPDATES_CODE_SIGNING_PRIVATE_KEY`.
  - Signing is a narrow job: it takes the next set of approved and revoked
    releases from the database, renders the metadata, and has the KMS sign it.
  - If the KMS cannot sign Ed25519, the signing runs in an isolated worker whose
    key never leaves an HSM. The ADR's requirement is the custody, not the vendor
    (open question 1).
- **Root ceremonies are rare and recorded:** a new root, a key reset (decision 1),
  or rotating the online keys. They are done offline with the threshold, and the
  signed `root.json` is committed to OxyOS's image (`/usr/share/oxyos/store/`).
- **One key per role,** separate from ADR 0012's service-token key and from Oxy
  Updates' key. A compromise of one is not a compromise of the others.

### 6. Installs, per account

**`app_installs`**: `id`, `user_id`, `application_id`, `device_id` (the OxyOS
machine's Oxy device), `version_code`, `installed_at`, `removed_at`.

- **Written by the machine.** `oxyos-installd` reports through the account's own
  session after a commit or an uninstall, never by a person's word.
- **Shown in the account's data and deleted with it** (`CASCADE` from `users`).
- **What it gives:** Atlas's *Purchased* page, the restoring of a person's
  applications on a new machine, and the store's install count. That count is
  distinct from `app_grants`, which records consent, not installs.
- **What it never holds:** an IP address, and nothing of what the person does in
  the application.

### 7. Reads and the SDK

**Public reads.** `StoreListingDetail` and `StoreListingSummary` gain:
- `developer`: `{ name, verified }` from the owning account, where Atlas now
  prints "Oxy";
- `platforms`: `{ web, ios, android, oxyos }`, each available or null.

`GET /store/apps/:slug/oxyos?abi=&api=&arch=` gives the current published
release for a machine: `version`, `versionCode`, `size`, capabilities with their
purposes in the request's language, release notes, `publishedAt`. It is
**`null`** when there is none, which Atlas renders as "not available for this
computer". What it returns is for showing; what installs is the TUF repository.

**`@oxy.so/core`.** `oxy.store` gains `oxyosRelease(slug, machine)` and the
publisher's `oxy.store.releases.{list, get, create, submit, withdraw}`,
`objects.{init, complete}`, `keys.{list, add, rotate}`. Following the package
rules, nothing imports React or Expo.

**The installer seam** sits beside `oxy.store` (the owner's decision 15). A
runtime that can install registers one, and the application never asks which
platform it is on:

```ts
export type InstallState =
  | { state: 'notInstalled' }
  | { state: 'installing'; fraction: number | null }
  | { state: 'installed'; versionCode: number }
  | { state: 'updateAvailable'; versionCode: number; needsConsent: boolean }
  | { state: 'unavailable'; reason: 'runtime' | 'architecture' | 'revoked' };

export interface StoreInstaller {
  readonly platform: 'oxyos';
  status(slugs: readonly string[]): Promise<Record<string, InstallState>>;
  /** Asks the system; resolves when the person confirmed or declined in the system's sheet, and the work is done. */
  install(slug: string): Promise<'installed' | 'declined'>;
  update(slug: string): Promise<'updated' | 'declined'>;
  uninstall(slug: string): Promise<'removed' | 'declined'>;
  open(slug: string): Promise<void>;
  subscribe(listener: (slug: string, state: InstallState) => void): () => void;
}

export function setStoreInstaller(installer: StoreInstaller | null): void;
export function getStoreInstaller(): StoreInstaller | null;
```

- The OxyOS Bloom host registers one backed by its `OxyOSStore` module before
  the application's code runs. Where none is registered, Atlas shows what it
  shows today.
- The installer takes a slug and hands the machine nothing else. The machine
  resolves slug → package id → release from the TUF metadata itself.

### 8. Publishing: `oxy-ship oxyos`

- **`oxy-ship oxyos build`** runs Metro for the `oxyos` platform against the
  declared runtime (`@oxy.so/app-preset`'s OxyOS target), with the assets in the
  layout the host resolves. It writes the manifest in JCS form. **No `hermesc`:**
  the machine compiles (OxyOS ADR 0030 decision 1).
- **`oxy-ship oxyos sign`** signs with the developer's key from a local file or
  the CI's secret store. The CLI never uploads the private key, and no route
  accepts one.
- **`oxy-ship oxyos publish`** uploads the objects (init/complete), creates the
  release with its notes, and submits it.
- **Auth** is as `oxy-ship` has today: a service credential with a new scope,
  `releases:publish`, restricted to its own application, or a person holding the
  new application permission `releases:manage`. `releases:manage` is
  deliberately not `updates:manage`: pushing an OTA update and submitting a
  store release are different powers.

The Console gets an application's *Releases* page: keys and their lineage,
releases and their states, rollout, notes.

### 9. Rate limits

Prefixed limiters, as the store's are:
- `rl:store:oxyos:meta:`: 600 per minute per hashed IP for the metadata;
- the objects are the CDN's;
- `rl:store:releases:write:`: 20 per minute, keyed by the principal (account or
  credential), never by IP;
- installs reported: 60 per hour per account.

### 10. App assertions

An installed OxyOS application is recognised by the platform: a verified launch
record (OxyOS ADR 0030 decision 7) and the device credential `oxyos-accountd`
holds. That is ADR 0052's `oxyos` attestation lane, over the
`oxyos_package_id` of decision 1. Whether, and how, an application then gets a
token for itself is decided in ADR 0052, not here.

## Alternatives rejected

- **Extending Oxy Updates as it is** (an `oxyos` value in `UPDATE_PLATFORMS`). It
  pushes code to devices with no review, signs at serve time with a key in the
  API's environment, has no developer signature, capability or install, and its
  manifest patches an installed binary's JavaScript rather than describing a
  package. Taken from it: `update_assets`, its upload, byte-stable signed
  documents, the rollout percentage.
- **The store's signature alone** (Play App Signing's model). Then whoever holds
  the store's keys can change any installed application's code. With the
  developer's signature pinned on the machine, neither party alone can. This was
  the owner's decision 1.
- **Signing at serve time** with an online key in the process. That makes oxy-api
  a code-signing oracle for every machine. Approval is signed once, by a key the
  API asks and cannot read, into metadata a CDN can serve.
- **Signed releases without TUF** (a version check only). That leaves freeze,
  mix-and-match and key-compromise recovery to invention. This was the owner's
  decision 3.
- **A new object table** beside `update_assets`. It would be a second
  content-addressed store with the same rules, and two places for one digest's
  bytes.

## Consequences

- The store becomes a distributor, and its threat model is code on people's
  machines. The KMS, the root ceremony and the signing job are new operational
  inputs: the KMS keys, three hardware keys and their holders, and the image's
  `root.json`.
- Atlas's button can tell the truth: *Get* exists only where an installer is
  registered and a release exists for the machine.
- `update_assets` now holds objects with two kinds of owner. Its `RESTRICT` rule
  protects both.

## Enforcement

- **Schema tests:**
  - the immutability triggers refuse an UPDATE of each signed column of
    `app_releases` and any UPDATE of `app_release_files`, the signing keys and
    their events;
  - `oxyos_package_id` cannot change once a release exists;
  - the CHECKed tuples render their constraints.
- **Submit tests:** each refusal (wrong signature, unknown, retired or out-of-
  lineage key, wrong package id, `version_code` not greater, a file missing,
  extra, different or not `uploaded`, capabilities not matching, a native
  architecture, a third party's application) stores nothing.
- **Transition tests:** every illegal transition is a 409.
- **TUF tests:** the rendered metadata verifies with a reference TUF client from
  the test root. Consistent snapshots, bins, expiries and revocation are as
  specified. An approval re-signs one bin, the snapshot and the timestamp, and
  nothing else.
- **Custody tests:** no private key is read from the environment, and the signing
  job runs against a KMS double.
- **Install tests:** reports land only for the session's own account and device,
  and are deleted with the account.
- **SDK tests:** with no installer registered, `getStoreInstaller()` is null.

## Open questions for the owner

1. **The KMS.** Which KMS or HSM signs Ed25519 for the online roles (AWS KMS's
   Ed25519 support or CloudHSM, or an HSM in front of a signing worker)?
2. **The root's three holders**, and where the hardware keys are kept.
3. **The object prefix.** Keep `public/updates/assets/` for release objects
   (recommended now), or generalize the table and prefix in a later migration.
4. **Staged rollouts.** Rollouts by machine bucket (as `rollout_percent` does for
   updates), with the bucket derived from the device id. Or the first release
   published whole.
5. **Restore on a new machine** (`app_installs`): offered at OxyOS setup, or only
   from Atlas's *Purchased* page.
6. **ADR 0052's alignment.** Ratify that its `oxyos.desktopEntryIds` is decision
   1's `oxyos_package_id`.
