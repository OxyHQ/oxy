# NFC Real-Life Attestation + Oxy ID Card Scan Effect — Design

**Date:** 2026-07-11
**Scope:** `packages/commons` (Expo app), one small addition in `packages/api`
**Status:** Approved by owner (conversation, 2026-07-11)

## Goal

Give the Commons real-life attestation flow a second transport besides the QR:
on Android, the Oxy ID card emits its attestation payload over NFC (HCE) while
it is on screen, so the counterparty can tap phones instead of scanning a QR.
The card gives physical feedback: a subtle nudge + shine when it is read over
NFC, and a full holographic shimmer when the attestation is confirmed by the
server (the confirmation effect fires for the QR flow too).

This also serves the broader proof-of-personhood goal: an NFC tap is a
strictly-proximity channel (~4 cm), which is a stronger "we really met"
signal than a QR that could be photographed remotely.

## Platform matrix (hard constraint)

NFC **emission** (tag emulation / HCE) is Android-only — Apple does not grant
HCE to third-party apps (the EEA iOS 17.4+ payments entitlement is not
practically available). NFC **reading** works on both platforms.

| Card shown by (A, emits) | Scanner (B, receives) | NFC works? |
|---|---|---|
| Android | Android | Yes — tap even with B's app closed (system NDEF dispatch) |
| Android | iPhone | Yes — B taps a "Hold near the other phone" button (CoreNFC reader session) |
| iPhone | any | No — A's card offers QR only; the server-confirmation effect still fires |

QR remains the universal fallback and is unchanged.

## Architecture

### Payload

The NFC tag content is **byte-for-byte the same string** the QR encodes:
`oxycommons://attest?payload=…` as built by `useAttestQr` /
`oxyServices.buildAttestQrPayload` (DID + single-use nonce, 10-minute expiry).
No contract or core-mixin changes. It is exposed as an NDEF URI record on an
emulated Type 4 tag.

### Emitter (A, Android, `(id)/index` screen)

- New hook `useNfcAttestEmitter` arms a `react-native-hce` NDEF session while
  the ID screen is focused and a fresh payload exists; disarms on blur/unmount.
- States: `unsupported | off | emitting`. `unsupported` on iOS / no NFC
  hardware (renders nothing extra); `off` when NFC is disabled in Android
  settings (no prompts).
- The HCE session's read event fires `onRead` → triggers the level-1 card
  effect and regenerates the payload (nonce is single-use). Debounced to one
  pulse per reader session.
- Payload expiry (10 min) auto-re-arms with a fresh payload, mirroring the QR
  countdown lifecycle.
- A small "NFC active" indicator shows on the ID screen while `emitting`.

### Receiver (B)

- **Android, app closed or open:** config plugin adds an
  `android.nfc.action.NDEF_DISCOVERED` intent filter for scheme `oxycommons`
  → the system tap dispatch opens `(scan)/attest` with the payload — the exact
  route the QR scanner already uses. Zero in-app reader code on this path.
- **iPhone (and Android in-app fallback):** a "Hold near the other phone"
  button on `(scan)/index` (shown only when NFC hardware is available) starts
  a one-shot `react-native-nfc-manager` NDEF reader session; on read it
  navigates to `(scan)/attest` with the URI.
- From `(scan)/attest` onward the flow is the existing one: B sees A's public
  card, biometric gate, on-device signature, `POST /civic/attest`.

### Server confirmation (both transports)

- `packages/api`: when `POST /civic/attest` accepts an attestation, emit a
  Socket.IO event `civic:attested` `{ byUserId, at }` to the subject's user
  room — same emit pattern as `notification.controller.ts`.
- Commons hook `useAttestedEvent` subscribes with a strict event whitelist
  (pattern: `useSessionSocket`) and fires the level-2 effect.
- This is the **only backend change**.

## Card effect

Wired through the existing `TiltContext` (Reanimated shared values; no JS
re-renders on the animation path). Two new shared values:

- `scanPulse: SharedValue<number>` — level 1
- `attestGlow: SharedValue<number>` — level 2

`Ticket` accepts them as optional props and feeds them into the context;
`holographic-card.tsx` consumes them on its existing Skia canvas.

### Level 1 — "you've been read" (local HCE read event, instant)

- Haptic `selectionAsync`.
- Physical nudge: `withSequence(withTiming(-3° , 90ms), withSpring(0,
  dampingRatio 1.2))` composed into the card's container transform — reads as
  the other phone's tap physically pushing the card.
- Shine sweep: `scanPulse` 0→1 over ~700 ms; the holographic canvas maps it to
  a specular band crossing the card diagonally.

### Level 2 — "attestation confirmed" (socket event; fires for QR and NFC)

- Haptic `notificationAsync(Success)`.
- `attestGlow` 0→1→0 over ~1.8 s: full holographic shimmer (intensifies the
  base hologram) + brief edge glow.
- Temporary check badge overlaid on the card ~2.5 s (plain RN overlay, not in
  the Skia canvas).

`useReducedMotion`: haptics + badge only, no card animation.

## New/changed files

**New (commons):**
- `plugins/with-hce.ts` — config plugin: HCE `<service>` + `aid_list.xml` +
  NFC permission + `NDEF_DISCOVERED` intent filter (Android manifest).
- `hooks/nfc/useNfcAttestEmitter.ts`
- `hooks/nfc/useNfcReader.ts`
- `hooks/civic/useAttestedEvent.ts`

**Changed (commons):**
- `app/(tabs)/(id)/index.tsx` — mount emitter + socket hook; pass effect
  shared values; NFC-active indicator.
- `components/OxyID/tilt-context.tsx` — add `scanPulse`/`attestGlow`.
- `components/OxyID/index.tsx` — optional effect props; nudge in transform.
- `components/holographic-card.tsx` — shine sweep + shimmer from the shared
  values.
- `app/(scan)/index.tsx` — NFC read button.
- `app.json` — `react-native-nfc-manager` plugin (`NFCReaderUsageDescription`,
  Android NFC permission) + `plugins/with-hce.ts`.

**Changed (api):**
- Civic attest route/service — emit `civic:attested` to the subject's room on
  accepted attestation.

**Dependencies (commons only):** `react-native-hce`, `react-native-nfc-manager`.
Both require a new EAS build (dev client included). Neither is pinned by
`@oxy.so/services`, so no `expo.install.exclude` entry is needed.

**Unchanged:** `@oxy.so/contracts`, `@oxy.so/core` mixins (payload builder
already exists), `attest-me.tsx` (QR screen stays as-is).

## Error handling

- NFC off in Android settings → emitter state `off`, indicator hidden, no
  prompts.
- Nonce expires while emitting → auto re-arm with fresh payload.
- Repeated/partial HCE reads → debounce: one pulse per reader session; nonce
  regenerates regardless (single-use).
- Socket down at confirmation time → level-2 effect is lost; acceptable — the
  attestation history screen remains the source of truth. No extra polling.
- B reads but cancels/never signs → only level 1 ever fired; level 2 is
  strictly server-confirmed, so the semantics stay honest.

## Testing

- **Unit (Jest, commons):** emitter state machine (arm/disarm/regenerate-on-
  read/expiry), reader URI parsing, `useAttestedEvent` strict whitelist.
- **Unit (Jest, api):** `civic:attested` emitted on accepted attestation; not
  emitted on rejection.
- **Manual on real hardware (mandatory — emulators have no NFC):**
  Android→Android tap with B's app closed; Android→iPhone via the read
  button; level-1 pulse on A in both; QR flow still works and fires level 2;
  reduced-motion behavior.
