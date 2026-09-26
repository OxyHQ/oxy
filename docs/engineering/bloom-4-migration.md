# Bloom 4 UI migration

Services 4.0 requires Bloom 4.2 and Core 1.7.3. Install one Bloom instance for the
application and Services: these packages share theme, dialog and interaction
contexts. App Preset 2.0.1 admits Bloom 2, 3 and 4.2+ and Services 2, 3 and 4; it only
couples to their CSS/plugin entry points, which retain the same paths.

## Shared controls

- User and target follow controls bind the existing authenticated stores to
  Bloom `FollowButton`. Unknown status remains disabled and neutral; pending
  writes, rejected mutations, initial seeds, bulk state and callback acceptance
  remain SDK-owned. Secondary surfaces and state animation are Bloom-owned.
- `ProfileButton` binds auth readiness, sign-in and the account dialog to Bloom
  `Button` and `Avatar`. Expanded identities remain visible on every platform;
  the former web-only hover/negative-margin identity reveal is removed.
- User list rows use `ContactRow`; follow controls remain outside the profile
  navigation target. Profile summaries and upload review use `Card` surfaces.
- Header actions, file actions, empty-state actions, language removal and account
  membership actions use `Button`. Secondary actions use subtle surfaces rather
  than the old outlined compatibility recipe.
- File type selection and membership role selection use `SegmentedControl`.
  File search uses `Search`; upload progress uses `Meter`, `Loading` and `Card`.
  The duplicate animated file-mode button and unused PIN renderer were deleted.
- Text uses Bloom typography. Media crop/gallery gestures and image-selection
  targets remain media-specific; replacing their hit areas with form buttons
  would change their interaction. Existing auth, settings, payment and account
  flows retain their Bloom Dialog/Surface, SettingsList and TextField bases.

`OxySignInButton.size` follows Bloom's `SocialButtonSize`: `sm` and `md` (default),
replacing `small` and `medium` at call sites. The major Services version keeps apps on
Bloom 3 from accepting an incompatible SDK through a minor update.

## Core runtime boundary

A runtime Node guard around a literal dynamic import does not prevent Metro
from traversing it. The workload-identity signer (which imports `node:crypto`)
therefore lives only behind `@oxy.so/core/server` (`OxyServer`), an entry native
and browser bundles never import; the client root cannot attest or request a
service token. No consumer alias or Node polyfill is needed.

The map lives in `dist/esm/package.json` and `dist/cjs/package.json`
(`scripts/mark-module-formats.mjs`), because those files are the package scope
for a `#` specifier. Core 1.7.3 used a self-reference to an
`@oxy.so/core/internal/workload-identity` export instead; that resolves for
installed consumers but not for bundlers inside this workspace, where nothing
links `@oxy.so/core` into a `node_modules` it can reach. 1.7.4 replaces it.

## Existing payment limitation

`PeableButton` is an existing unsupported trigger that only reports a warning.
`PaymentGateway` is a demonstration flow: its pay handler waits on a timer and
its done callback reports success without a payment integration. This migration
has not connected the trigger to that demonstration, and has not changed payment
processing. The deprecated `OxyPayButton` alias is retained. A real payment
integration needs its own provider, settlement and cancellation contract; UI
migration must not turn the demonstration into an apparent successful charge.
