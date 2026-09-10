# Remove NFC/HCE from Commons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the NFC/HCE real-life-attestation path from Commons so the `react-native-hce` patch, both NFC native dependencies and the hand-rolled HCE config plugin disappear, leaving QR as the only attestation transport.

**Architecture:** Pure deletion, consumer-first. Each task removes one consumer surface together with the module it owned, so the workspace type-checks and tests green at the end of every task. The QR flow, the `civic:attested` socket feedback and the whole civic backend are untouched.

**Tech Stack:** Expo SDK 57 / RN 0.86, TypeScript strict, Jest (jest-expo), bun workspaces.

**Spec:** `docs/superpowers/specs/2026-07-21-remove-nfc-hce-design.md`

## Global Constraints

- Package manager is **bun**. Never `npm`/`yarn`/`npx`; use `bun` / `bunx`.
- Run tests through the package's own script: `bun run --filter commons test`. Never bare `bun test`.
- Any `package.json` dependency change commits `bun.lock` **in the same commit**.
- No `any`, no `@ts-ignore`, no `!` non-null assertions, no leftover TODO comments.
- Work happens on the existing branch `chore/commons-remove-nfc-hce`.
- All paths below are relative to the repo root `/home/nate/Oxy/OxyHQServices` unless prefixed with `packages/commons/`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Remove the NFC reader from the scanner

The scanner screen offers a "hold near the other phone" button that reads an NDEF tag instead of scanning a QR. With no Oxy device emitting tags, it reads nothing. Delete the button and the hook behind it; the camera path is untouched.

**Files:**
- Modify: `packages/commons/app/(scan)/index.tsx`
- Delete: `packages/commons/hooks/nfc/useNfcReader.ts`
- Delete: `packages/commons/__tests__/hooks/useNfcReader.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. After this task `packages/commons/hooks/nfc/` still exists (Task 2 deletes its last file).

- [ ] **Step 1: Establish the green baseline**

Run: `bun run --filter commons test`
Expected: PASS. Record the total test count printed by Jest (`Tests: N passed`) — Task 5 checks the delta.

- [ ] **Step 2: Delete the reader hook and its test**

```bash
rm packages/commons/hooks/nfc/useNfcReader.ts
rm packages/commons/__tests__/hooks/useNfcReader.test.tsx
```

- [ ] **Step 3: Run the type-check to verify it fails**

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: FAIL with `Cannot find module '@/hooks/nfc/useNfcReader'` in `app/(scan)/index.tsx`. This is the failing state Step 4 fixes.

The type-check — not Jest — is the gate here: no test file imports the scanner screen, so `bun run --filter commons test` would go green on a broken screen. Trust `tsc` for the dangling-import check and Jest for behaviour.

- [ ] **Step 4: Strip the NFC reader from the scanner screen**

In `packages/commons/app/(scan)/index.tsx`:

4a. Remove `ActivityIndicator` from the `react-native` import (it is used only by the NFC button). The import becomes:

```tsx
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
} from 'react-native';
```

4b. Delete this import line entirely:

```tsx
import { useNfcReader } from '@/hooks/nfc/useNfcReader';
```

4c. Delete both state lines (they sit right after `const [scanError, setScanError] = useState<'invalid' | 'expired' | null>(null);`):

```tsx
  const { available: nfcAvailable, readOnce } = useNfcReader();
  const [nfcReading, setNfcReading] = useState(false);
```

4d. In `resetScannerSession`, delete the line `setNfcReading(false);`. The callback becomes:

```tsx
  const resetScannerSession = useCallback(() => {
    attest.reset();
    setScanned(false);
    setScanError(null);
    setConfirming(false);
    setFlashOn(false);
  }, [attest.reset]);
```

4e. Retarget the `routeParsed` comment — replace:

```tsx
  // Shared routing for anything `parseScan` can resolve, regardless of
  // whether the raw string came from the camera or an NFC read.
```

with:

```tsx
  // Shared routing for anything `parseScan` can resolve.
```

4f. Delete the whole `handleNfcRead` block, comment included:

```tsx
  // `useNfcReader` already no-ops concurrent calls (module-level busy guard →
  // `{ok:false, reason:'cancelled'}`); `nfcReading` is caller-side defense in
  // depth plus the pending visual on the button.
  const handleNfcRead = useCallback(async () => {
    if (nfcReading) return;
    setNfcReading(true);
    try {
      const read = await readOnce();
      if (!read.ok) return; // cancelled/empty — stay on the scanner
      routeParsed(parseScan(read.uri));
    } finally {
      setNfcReading(false);
    }
  }, [nfcReading, readOnce, routeParsed]);
```

4g. Unwrap the controls row — the flash button is now the only control. Replace the block that starts with `<View style={styles.controlsRow}>` and ends with its closing `</View>` (the one containing both the flash `TouchableOpacity` and the `{nfcAvailable && (…)}` block) with just the flash button:

```tsx
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={toggleFlash}
                  accessibilityRole="button"
                  accessibilityLabel={
                    flashOn ? t('signInApproval.scan.a11y.flashOff') : t('signInApproval.scan.a11y.flashOn')
                  }
                  accessibilityState={{ selected: flashOn }}
                >
                  <MaterialCommunityIcons name={flashOn ? 'flash' : 'flash-off'} size={28} color="#fff" />
                  <Text style={styles.controlText}>
                    {flashOn ? t('signInApproval.scan.flashOn') : t('signInApproval.scan.flashOff')}
                  </Text>
                </TouchableOpacity>
```

4h. Delete the two now-unused style entries from the `StyleSheet.create` block:

```tsx
  controlsRow: {
    flexDirection: 'row',
    gap: 32,
  },
  controlSpinner: {
    // Matches the 28dp icon slot so the pending swap doesn't shift layout.
    height: 28,
  },
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `bun run --filter commons test`
Expected: PASS, with the total lower than the Step 1 baseline by the deleted `useNfcReader` suite.

- [ ] **Step 6: Type-check**

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: no output (exit 0). In particular no "declared but never read" errors for `ActivityIndicator`, `nfcAvailable` or `nfcReading`.

- [ ] **Step 7: Commit**

```bash
git add packages/commons/app/'(scan)'/index.tsx packages/commons/hooks/nfc/useNfcReader.ts packages/commons/__tests__/hooks/useNfcReader.test.tsx
git commit -m "$(cat <<'EOF'
refactor(commons): drop the NFC tag reader from the scanner

With no Oxy device emitting NDEF tags, the reader had nothing to read.
The camera path is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the HCE emitter from the ID screen

The ID screen armed an HCE session while focused and foregrounded, emitting the attest payload as an NDEF tag. Deleting it also removes the screen-level `useAttestQr` call (it existed only to feed the emitter), the AppState gate and the nonce re-mint timer. `AttestQrSheet` owns its own `useAttestQr` and is untouched.

**Files:**
- Modify: `packages/commons/app/(tabs)/(id)/index.tsx`
- Delete: `packages/commons/hooks/nfc/useNfcAttestEmitter.ts`
- Delete: `packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the ID screen still passes `attestGlow={attestGlow}` to `<OxyID>`. It no longer passes `scanPulse` — Task 3 removes that prop from the component.

- [ ] **Step 1: Delete the emitter hook, its test and the now-empty directory**

```bash
rm packages/commons/hooks/nfc/useNfcAttestEmitter.ts
rm packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx
rmdir packages/commons/hooks/nfc
```

- [ ] **Step 2: Run the type-check to verify it fails**

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: FAIL with `Cannot find module '@/hooks/nfc/useNfcAttestEmitter'` in `app/(tabs)/(id)/index.tsx`. As in Task 1, `tsc` is the gate for dangling imports — no test imports this screen.

- [ ] **Step 3: Strip the emitter from the ID screen**

In `packages/commons/app/(tabs)/(id)/index.tsx`:

3a. Drop `AppState` from the `react-native` import (its only use was the foreground gate):

```tsx
import { View, StyleSheet, Platform, AccessibilityInfo } from 'react-native';
```

3b. Drop `useFocusEffect` from the expo-router import (its only use was the emitter's `enabled` gate):

```tsx
import { useRouter } from 'expo-router';
```

3c. Drop `Easing` from the reanimated import (its only use was the scan-pulse timing):

```tsx
import {
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
```

3d. Delete these two import lines:

```tsx
import { useAttestQr } from '@/hooks/useAttestQr';
import { useNfcAttestEmitter } from '@/hooks/nfc/useNfcAttestEmitter';
```

3e. Replace everything from the section comment down to (and including) the `triggerScanPulse` callback — that is, this whole run:

```tsx
  // ---- NFC attest emission + card feedback -------------------------------
  const scanPulse = useSharedValue(0);
  const attestGlow = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // NFC emission must stop the moment the app leaves the foreground (locked,
  // backgrounded, task-switched) — a stale HCE session would keep answering
  // APDU reads with the attestation payload while the device is out of the
  // user's hands. The emitter's own blur/unmount disarm logic handles the
  // `focused`/`enabled` transition; this only tracks OS-level foreground state.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  // Same payload the attest-me QR uses; one interaction id per screen session.
  const attestContext = useMemo(() => `irl-nfc-${Date.now().toString(36)}`, []);
  const { payload: attestPayload, exp: attestExp, regenerate: regenerateAttest } = useAttestQr(attestContext);

  // Single-use nonce: re-mint when it expires while we are emitting.
  useEffect(() => {
    if (!focused || !appActive || !attestExp) return;
    const ms = attestExp - Date.now();
    if (ms <= 0) {
      regenerateAttest();
      return;
    }
    const id = setTimeout(regenerateAttest, ms);
    return () => clearTimeout(id);
  }, [focused, appActive, attestExp, regenerateAttest]);

  const triggerScanPulse = useCallback(() => {
    void Haptics.selectionAsync();
    if (reducedMotion) return;
    scanPulse.value = 0;
    scanPulse.value = withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }, (finished) => {
      if (finished) scanPulse.value = 0;
    });
  }, [scanPulse, reducedMotion]);
```

with:

```tsx
  // ---- Attestation-confirmed card feedback --------------------------------
  const attestGlow = useSharedValue(0);
  const reducedMotion = useReducedMotion();
```

3f. Delete the emitter call that sits between `triggerAttestGlow` and `handleAttestedEvent`:

```tsx
  const { state: nfcState } = useNfcAttestEmitter({
    payload: attestPayload,
    enabled: focused && appActive,
    onRead: () => {
      triggerScanPulse();
      regenerateAttest();
    },
  });
```

3g. Remove the `scanPulse` prop from the card. The `<OxyID>` opening tag becomes:

```tsx
          <OxyID
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            attestGlow={attestGlow}
```

3h. Collapse the flip-hint back to the plain hint:

```tsx
          <ThemedText style={[styles.flipHint, { color: colors.textSecondary }]}>
            {t('civic.id.flipHint')}
          </ThemedText>
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `bun run --filter commons test`
Expected: PASS, lower by the deleted `useNfcAttestEmitter` suite.

- [ ] **Step 5: Type-check**

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: exit 0. `useEffect`, `useMemo`, `useCallback`, `useRef` and `useState` all still have other uses in this file, so no unused-import errors are expected.

- [ ] **Step 6: Commit**

```bash
git add packages/commons/app/'(tabs)'/'(id)'/index.tsx packages/commons/hooks/nfc packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx
git commit -m "$(cat <<'EOF'
refactor(commons): drop the HCE attest emitter from the ID screen

Removes the emitter hook plus the machinery that existed only to feed it:
the screen-level useAttestQr call, the AppState foreground gate and the
nonce re-mint timer. AttestQrSheet keeps its own useAttestQr.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove the `scanPulse` level-1 feedback channel

`scanPulse` fired once per local HCE read: a shine sweep across the Skia card plus a −3° pitch nudge. Nothing can trigger it now, so the whole channel is dead code. `attestGlow` (level 2, driven by the `civic:attested` socket event) stays.

**Files:**
- Modify: `packages/commons/components/OxyID/tilt-context.tsx`
- Modify: `packages/commons/components/OxyID/index.tsx`
- Modify: `packages/commons/components/holographic-card.tsx`

**Interfaces:**
- Consumes: Task 2 already removed the only `scanPulse` prop pass-in, so removing the prop breaks no caller.
- Produces: `TiltContextValue` loses its `scanPulse` field; `TicketProps` loses its optional `scanPulse` prop. `attestGlow` keeps its exact current shape (`SharedValue<number>`, optional prop with an inert internal default).

- [ ] **Step 1: Remove the field from the tilt context**

In `packages/commons/components/OxyID/tilt-context.tsx`, delete these two lines from `TiltContextValue`:

```tsx
    /** 0→1 once per NFC read — shine sweep + pitch nudge (level-1 feedback). */
    scanPulse: SharedValue<number>;
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `bun run --filter commons test`
Expected: FAIL — `components/OxyID/index.tsx` still builds a context object with `scanPulse`, and `holographic-card.tsx` still destructures it (`Property 'scanPulse' does not exist on type 'TiltContextValue'`). If Jest reports PASS here (ts-jest may not surface the type error at runtime), run `cd packages/commons && bunx tsc --noEmit` and confirm it FAILS with that error instead.

- [ ] **Step 3: Remove the prop and the pitch nudge from the card component**

In `packages/commons/components/OxyID/index.tsx`:

3a. Delete the prop from `TicketProps`:

```tsx
    /** Level-1 NFC-read feedback value (0→1 per read). Internal default: inert. */
    scanPulse?: SharedValue<number>;
```

3b. Delete `scanPulse: scanPulseProp,` from the destructured parameter list, leaving:

```tsx
export const Ticket: FC<TicketProps> = memo(({
    width,
    height,
    frontSide,
    backSide,
    qrSide,
    attestGlow: attestGlowProp,
}) => {
```

3c. Collapse the effect-channel block to the surviving channel:

```tsx
    // Effect channel — an inert local value unless the screen supplies a live one.
    const internalAttestGlow = useSharedValue(0);
    const attestGlow = attestGlowProp ?? internalAttestGlow;
```

3d. Drop `scanPulse` from the context object and its dependency array:

```tsx
    const tiltContext = useMemo<TiltContextValue>(
        () => ({
            pitchDeg: tilt.pitchDeg,
            yawDeg: tilt.yawDeg,
            nx: tilt.nx,
            ny: tilt.ny,
            mag: tilt.mag,
            pressRotateX,
            isPressed,
            rotation,
            attestGlow,
            isFront,
            motionEnabled: tilt.motionEnabled,
        }),
        [tilt, pressRotateX, isPressed, rotation, attestGlow, isFront],
    );
```

3e. Simplify `rTiltStyle` — the pitch is now just device tilt plus press tilt:

```tsx
    const rTiltStyle = useAnimatedStyle(() => ({
        transform: [
            { perspective: 900 },
            { translateY: pressTranslateY.value },
            { rotateY: `${rotation.value + yawDeg.value}deg` }, // flip composed with tilt-yaw
            { rotateX: `${pitchDeg.value + pressRotateX.value}deg` },
            { rotateZ: `${yawDeg.value * 0.15}deg` }, // subtle micro-roll
        ],
    }));
```

- [ ] **Step 4: Remove the shine sweep from the Skia card**

In `packages/commons/components/holographic-card.tsx`:

4a. Drop `scanPulse` from the `useTilt()` destructure:

```tsx
    const { nx, ny, mag, isPressed, attestGlow } = useTilt();
```

4b. Delete the three derived values and their comment block:

```tsx
    // NFC-read shine: a narrow diagonal band that sweeps corner-to-corner as
    // scanPulse runs 0→1, fading in/out with sin(π·t) so it never pops. The band
    // centre travels −0.3 → 1.3, so the stripe sits just off-canvas at both ends
    // and crosses mid-canvas exactly when the opacity envelope peaks (t = 0.5).
    const scanBandStart = useDerivedValue(() => {
        const t = Math.min(1, Math.max(0, scanPulse.value));
        const c = -0.3 + 1.6 * t;
        return vec(width * (c - 0.6), height * (c - 0.6));
    });
    const scanBandEnd = useDerivedValue(() => {
        const t = Math.min(1, Math.max(0, scanPulse.value));
        const c = -0.3 + 1.6 * t;
        return vec(width * (c + 0.6), height * (c + 0.6));
    });
    const scanBandOpacity = useDerivedValue(() =>
        Math.sin(Math.min(1, Math.max(0, scanPulse.value)) * Math.PI) * 0.9,
    );
```

4c. Delete the sweep group from the canvas:

```tsx
                {/* NFC-read shine sweep (scanPulse-driven; invisible at rest). */}
                <Group opacity={scanBandOpacity}>
                    <RoundedRect x={0} y={0} width={width} height={height} r={24}>
                        <LinearGradient
                            start={scanBandStart}
                            end={scanBandEnd}
                            colors={[
                                'rgba(255,255,255,0)',
                                'rgba(255,255,255,0)',
                                'rgba(255,255,255,0.9)',
                                'rgba(255,255,255,0)',
                                'rgba(255,255,255,0)',
                            ]}
                            positions={[0, 0.42, 0.5, 0.58, 1]}
                        />
                    </RoundedRect>
                </Group>
```

- [ ] **Step 5: Run the suite and type-check to verify they pass**

Run: `bun run --filter commons test`
Expected: PASS, same total as the end of Task 2.

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/commons/components/OxyID/index.tsx packages/commons/components/OxyID/tilt-context.tsx packages/commons/components/holographic-card.tsx
git commit -m "$(cat <<'EOF'
refactor(commons): remove the scanPulse card-feedback channel

scanPulse fired once per local HCE read; with the emitter gone nothing can
trigger it. attestGlow (civic:attested socket) is unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Remove the native config, both NFC dependencies and the patch

This is the task the whole plan exists for: with no JS consumer left, the dependencies, the hand-rolled HCE config plugin and the `react-native-hce` patch all go.

**Files:**
- Modify: `packages/commons/app.config.js`
- Delete: `packages/commons/plugins/with-hce.js`
- Modify: `packages/commons/package.json`
- Modify: `package.json` (repo root)
- Delete: `patches/react-native-hce@0.3.0.patch` (and the `patches/` directory)
- Modify: `bun.lock` (regenerated)

**Interfaces:**
- Consumes: Tasks 1–3 removed every JS import of `react-native-hce` and `react-native-nfc-manager`.
- Produces: no `patchedDependencies` key anywhere in the repo; the generated Android manifest carries no NFC surface.

- [ ] **Step 1: Prove no JS consumer is left**

Run: `grep -rn "react-native-hce\|react-native-nfc-manager" packages/commons --include='*.ts' --include='*.tsx' --include='*.js' | grep -v node_modules`
Expected: exactly two hits, both in files this task edits — `app.config.js` (the plugin entry) and `plugins/with-hce.js` (its own header comment). Any hit in a `.ts`/`.tsx` file means Task 1–3 was incomplete; stop and fix that first.

- [ ] **Step 2: Remove both plugin entries from the Expo config**

In `packages/commons/app.config.js`, delete this entry from the `plugins` array:

```js
      [
        'react-native-nfc-manager',
        {
          nfcPermission: 'Allow $(PRODUCT_NAME) to read attestation cards from nearby phones.',
        },
      ],
```

and delete this line from the same array:

```js
      './plugins/with-hce',
```

- [ ] **Step 3: Fix the file-header comment that justifies the shared URL scheme**

Still in `packages/commons/app.config.js`, replace:

```js
// The URL scheme is intentionally shared, so the NFC/deep-link plumbing
// (`plugins/with-hce.js`, the `oxycommons://` payloads in @oxy.so/core) keeps
// working unchanged — Android just shows an app chooser when both are installed.
```

with:

```js
// The URL scheme is intentionally shared, so the deep-link plumbing (the
// `oxycommons://` payloads minted in @oxy.so/core) keeps working unchanged —
// Android just shows an app chooser when both are installed.
```

- [ ] **Step 4: Delete the config plugin and the patch**

```bash
rm packages/commons/plugins/with-hce.js
rm patches/react-native-hce@0.3.0.patch
rmdir patches
```

- [ ] **Step 5: Remove both dependencies and the patch registration**

In `packages/commons/package.json`, delete the `"react-native-hce": "^0.3.0",` and `"react-native-nfc-manager": "^3.17.2",` lines from `dependencies`.

In the repo-root `package.json`, delete the whole trailing block:

```json
  "patchedDependencies": {
    "react-native-hce@0.3.0": "patches/react-native-hce@0.3.0.patch"
  }
```

Make sure the key preceding it (`"overrides"`) no longer has a trailing comma before the closing brace.

- [ ] **Step 6: Regenerate the lockfile**

Run: `bun install`
Expected: completes; `bun.lock` changes (both packages removed).

Run: `bun install --frozen-lockfile`
Expected: exit 0. If it fails, run `bun install` once more and diff `bun.lock` between the two runs before assuming a real desync — Bun 1.3.14 is known to false-positive here.

- [ ] **Step 7: Verify the native manifest is clean**

Run: `cd packages/commons && bunx expo prebuild --clean --platform android`
Expected: completes without mentioning `with-hce` or `react-native-nfc-manager`.

Run:
```bash
cd packages/commons && grep -cE "CardService|android.permission.NFC|NDEF_DISCOVERED" android/app/src/main/AndroidManifest.xml; ls android/app/src/main/res/xml/aid_list.xml
```
Expected: `grep -c` prints `0`, and `ls` prints `No such file or directory`.

- [ ] **Step 8: Discard the generated native project**

The `android/` output is a prebuild artifact, not source. Confirm it is ignored and not staged:

Run: `git status --porcelain packages/commons/android | head`
Expected: no output (the directory is gitignored). If it *does* show up, delete it with `rm -rf packages/commons/android` rather than committing it.

- [ ] **Step 9: Run the suite and type-check**

Run: `bun run --filter commons test`
Expected: PASS, same total as the end of Task 3.

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock packages/commons/package.json packages/commons/app.config.js packages/commons/plugins/with-hce.js patches
git commit -m "$(cat <<'EOF'
chore(commons): drop react-native-hce + nfc-manager and the gradle patch

The patch rewrote the library's dead jcenter() repos so Gradle 9 could
build it. Upstream 0.3.0 is the latest release and still ships jcenter()
plus 2019-era AGP, and it has no config plugin — Commons hand-wrote the
CardService, aid_list and NDEF intent filter. With NFC gone all of it goes,
patches/ included.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retire the NFC copy, docstrings and AGENTS.md section

Everything that still *talks* about NFC: two i18n blocks, four docstrings that cite NFC as their motivating entry point, and the AGENTS.md section. The surviving facts in that section (the `civic:attested` socket contract and the deploy-order rule) are preserved, not deleted.

**Files:**
- Modify: `packages/commons/lib/i18n/locales/en.json`
- Modify: `packages/commons/lib/i18n/locales/es.json`
- Modify: `packages/commons/app/(scan)/attest.tsx`
- Modify: `packages/commons/hooks/civic/useAttestAutoDispatch.ts`
- Modify: `packages/commons/hooks/civic/attestStore.ts`
- Modify: `packages/commons/app/+native-intent.ts`
- Modify: `AGENTS.md` (repo root)

**Interfaces:**
- Consumes: Tasks 1–4. No runtime behaviour changes here — copy and comments only, except the removal of two unused translation keys.
- Produces: nothing.

- [ ] **Step 1: Prove the keys are unreferenced**

Run: `grep -rn "civic.nfc" packages/commons --include='*.ts' --include='*.tsx' | grep -v node_modules`
Expected: no output. (Task 1 removed `civic.nfc.read`, Task 2 removed `civic.nfc.active`.) If anything prints, fix that call site first.

- [ ] **Step 2: Delete the `civic.nfc` block from both locales**

From `packages/commons/lib/i18n/locales/en.json`, delete:

```json
    "nfc": {
      "active": "NFC active — hold phones together to verify",
      "read": "Hold near the other phone"
    },
```

From `packages/commons/lib/i18n/locales/es.json`, delete:

```json
    "nfc": {
      "active": "NFC activo — acerca los móviles para verificar",
      "read": "Acerca el móvil al otro dispositivo"
    },
```

- [ ] **Step 3: Run the locale tests to verify parity holds**

Run: `cd packages/commons && bun run test __tests__/i18n`
Expected: PASS. Both locales lost the same key block, so the en/es parity check stays green.

- [ ] **Step 4: Retarget the attest deep-link docstring**

In `packages/commons/app/(scan)/attest.tsx`, replace the first paragraph of the file docstring:

```tsx
/**
 * OS/system NFC deep-link entry for a real-life attestation (the scanner's /
 * B's side). Reached by Android NFC foreground dispatch OR a cold launch
 * straight into `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (the same
 * bytes `OxyServices.civic.buildAttestQrPayload` puts on the QR — see
 * `useNfcAttestEmitter` and `plugins/with-hce.js`). The in-app camera path
 * routes through `app/(scan)/index.tsx` instead.
```

with:

```tsx
/**
 * OS/system deep-link entry for a real-life attestation (the scanner's / B's
 * side). Reached when something outside the app opens
 * `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` — typically the SYSTEM
 * camera scanning A's attest QR, which cold-launches straight into this route.
 * The bytes are exactly what `OxyServices.civic.buildAttestQrPayload` puts on
 * the QR. The in-app camera path routes through `app/(scan)/index.tsx` instead.
```

- [ ] **Step 5: Retarget the auto-dispatch docstring**

In `packages/commons/hooks/civic/useAttestAutoDispatch.ts`, replace the opening paragraph:

```ts
 * One-shot, readiness-gated auto-dispatch for a real-life attestation that
 * arrives via an OS/system entry point — the Android NFC deep link (foreground
 * dispatch while `app/(scan)/attest.tsx` is open, OR a cold launch straight into
 * it). Unlike the in-app scanner, that entry point delivers NO in-app event to
 * hang the submit off, so this hook fires it imperatively the instant the flow
 * is ready.
```

with:

```ts
 * One-shot, readiness-gated auto-dispatch for a real-life attestation that
 * arrives via an OS/system entry point — an external `oxycommons://attest…`
 * deep link opening `app/(scan)/attest.tsx`, typically from the system camera
 * scanning A's QR (including a cold launch straight into it). Unlike the in-app
 * scanner, that entry point delivers NO in-app event to hang the submit off, so
 * this hook fires it imperatively the instant the flow is ready.
```

and, further down, replace the sentence citing the deleted hook:

```ts
 * in-app event — the same native-lifecycle/OS-deep-link category the project's
 * AGENTS.md allows (cf. `useNfcAttestEmitter`). It is NOT derived state and NOT
```

with:

```ts
 * in-app event — the same native-lifecycle/OS-deep-link category the project's
 * AGENTS.md allows. It is NOT derived state and NOT
```

- [ ] **Step 6: Retarget the attest store comments**

In `packages/commons/hooks/civic/attestStore.ts`, replace:

```ts
 *   - Reviewed (`prepare` → biometric → `confirm`): the in-app scanner and the
 *     NFC deep-link screen hold the payload until B reviews A's card and passes
 *     the device gate.
```

with:

```ts
 *   - Reviewed (`prepare` → biometric → `confirm`): the in-app scanner and the
 *     deep-link screen hold the payload until B reviews A's card and passes
 *     the device gate.
```

and replace:

```ts
 *                signing (the confirm-before-submit lane — camera/NFC on the
 *                scanner screen). Nothing is signed until `confirm`.
```

with:

```ts
 *                signing (the confirm-before-submit lane on the scanner
 *                screen). Nothing is signed until `confirm`.
```

- [ ] **Step 7: Retarget the native-intent comment**

In `packages/commons/app/+native-intent.ts`, replace:

```ts
 * FIX (card deep link): a shared Oxy ID QR / NFC tag is
```

with:

```ts
 * FIX (card deep link): a shared Oxy ID QR is
```

- [ ] **Step 8: Replace the AGENTS.md NFC section**

In the repo-root `AGENTS.md`, replace the whole `### NFC Real-Life Attestation (extends Fase 2)` section (its heading and all seven bullets, up to but not including `### Fase 3 — Proof of Personhood`) with:

```markdown
### Real-Life Attestation transport — QR only

- The ONLY transport is the attest QR: `buildAttestQrPayload` →
  `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (raw query keys, there is
  NO `payload=` wrapper). A shows it, B scans it — in-app via `(scan)/index.tsx`,
  or from the system camera, which deep-links straight into `(scan)/attest`.
- **NFC/HCE was removed (2026-07-22).** It carried byte-for-byte the same
  payload, could only ever emit on Android, and forced a patch of the abandoned
  `react-native-hce` (dead `jcenter()` repos vs Gradle 9). Do NOT reintroduce it
  without owning the native module — `react-native-hce` is not an option.
  Design: `docs/superpowers/specs/2026-07-21-remove-nfc-hce-design.md`.
- Card feedback: the `attestGlow` SharedValue is threaded through `TiltContext`
  into the Skia canvas, driven by the `civic:attested` socket event to room
  `user:<subjectUserId>` emitted by `POST /civic/attestations` (payload
  `{byUserId, recordId, points, at, subjectUserId}` — clients drop malformed
  payloads whole and scope the effect to the active identity).
- Deploy-order rule: the api must deploy before a Commons build that requires new
  `civic:attested` payload fields ships (old api + new client = events dropped by
  the strict whitelist).
```

- [ ] **Step 9: Full repo sweep**

Run: `grep -rniE "\bnfc\b|\bhce\b" packages/commons AGENTS.md --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.md' | grep -v node_modules`
Expected: only the two intentional AGENTS.md mentions from Step 8 (the "NFC/HCE was removed" bullet). Anything else is a leftover — fix it before committing.

Run: `git status --porcelain patches; ls patches 2>&1`
Expected: no git output; `ls` reports the directory does not exist.

- [ ] **Step 10: Full gate**

Run: `bun run --filter commons test`
Expected: PASS. Total = the Task 1 Step 1 baseline minus the two deleted NFC suites, and nothing else.

Run: `cd packages/commons && bunx tsc --noEmit`
Expected: exit 0.

Run: `cd packages/commons && bun run lint`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/commons/lib/i18n/locales/en.json packages/commons/lib/i18n/locales/es.json packages/commons/app/'(scan)'/attest.tsx packages/commons/hooks/civic/useAttestAutoDispatch.ts packages/commons/hooks/civic/attestStore.ts packages/commons/app/+native-intent.ts AGENTS.md
git commit -m "$(cat <<'EOF'
docs(commons): retire NFC copy, docstrings and the AGENTS.md section

Keeps the facts that outlive NFC: the civic:attested socket contract that
drives attestGlow, and the api-before-client deploy-order rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Rollout note (post-merge, not part of any task)

Unlinking native modules is a **build-time** change: it does not ship over the air. Commons needs a fresh EAS build before the manifest cleanup reaches devices. An OTA update on top of an existing binary is harmless (the JS simply stops calling the native module) but leaves the old NFC service in the installed manifest until the next store build.
