# NFC Attestation + Oxy ID Card Scan Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Android phones emit the real-life-attestation payload over NFC (HCE) while the Oxy ID card is on screen; any phone can tap to receive it; the card physically reacts when read (level 1) and when the server confirms the attestation (level 2, QR flow included).

**Architecture:** The NFC tag content is byte-for-byte the QR string (`oxycommons://attest?payload=…` from `useAttestQr`). Emission = `react-native-hce` NDEF Type 4 session armed while `(id)/index` is focused. Reception = Android system NDEF dispatch (deep link, app closed included) or an in-app `react-native-nfc-manager` reader button (iPhone). Confirmation = new `civic:attested` Socket.IO event to the subject's `user:<id>` room, surfaced to apps through a new generic `SessionClient.onServerEvent` API in `@oxy.so/core` + `useOxyEvent` hook in `@oxy.so/services`. Card effect = two Reanimated shared values (`scanPulse`, `attestGlow`) threaded through the existing `TiltContext` into the Skia canvas.

**Tech Stack:** Expo SDK 57 / RN 0.86, react-native-reanimated + @shopify/react-native-skia, react-native-hce, react-native-nfc-manager, Socket.IO, Jest (per-package configs).

**Spec:** `docs/superpowers/specs/2026-07-11-nfc-attest-card-effect-design.md`

## Global Constraints

- Package manager: **bun only** (`bun add`, `bun install`, `bunx`). After any `package.json` change run `bun install` at the repo root and commit `bun.lock` **in the same commit**.
- TypeScript strict. NEVER: `as any`, `@ts-ignore`, `@ts-expect-error`, `!` non-null assertions, `var`, silent `catch {}`, TODO/FIXME comments, `console.log` (`console.warn`/`console.error` with context are the existing commons convention).
- Avoid `useEffect` when derived state/handlers work; the effects in this plan are legitimate (imperative native-module lifecycles, subscriptions, timers).
- **Concurrent sessions may hold uncommitted work in this repo. PATH-SCOPE every `git add` (list files explicitly). NEVER `git add -A` / `git add .`**
- Workspace deps resolve from build output: after changing `packages/core` run `bun run core:build`; after `packages/services` run `bun run services:build` — BEFORE running commons/type checks that consume them.
- Run each package's own `bun run test` (dispatches to the right runner). Never blanket `bun test` across the monorepo.
- NFC cannot run in emulators — device verification is a separate manual checklist at the end; automated steps stop at unit tests + typecheck + prebuild inspection.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `SessionClient.onServerEvent` (core)

**Files:**
- Modify: `packages/core/src/session/SessionClient.ts`
- Test: `packages/core/src/session/__tests__/SessionClient.serverEvents.test.ts` (new)

**Interfaces:**
- Consumes: existing `SessionClient` socket plumbing (`connectSocket`, `MinimalSocket`, injectable `socketFactory`).
- Produces: `onServerEvent(event: string, listener: (payload: unknown) => void): () => void` — public method on `SessionClient`. Registers a listener for a named server-pushed Socket.IO event; returns an unsubscribe function. Listeners survive socket reconnects and are bound when the socket is (re)created.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/session/__tests__/SessionClient.serverEvents.test.ts`. Reuse the exact harness from `SessionClient.socketFactory.test.ts` (`FakeSocket`, `makeHost`, `SYNC`):

```ts
import type { DeviceSessionState } from '@oxy.so/contracts';
import type { MinimalSocket, SocketIOFactory } from '../socketLoader';
import { SessionClient, type SessionClientHost } from '../SessionClient';

type Handler = (...args: unknown[]) => void;
class FakeSocket implements MinimalSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  on(event: string, cb: Handler) { const l = this.handlers.get(event) ?? []; l.push(cb); this.handlers.set(event, l); }
  off(event: string, cb?: Handler) { if (!cb) { this.handlers.delete(event); return; } this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb)); }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  emitServer(event: string, payload: unknown) { for (const h of this.handlers.get(event) ?? []) h(payload); }
}

const STATE = (rev: number): DeviceSessionState => ({ deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: rev, updatedAt: 1720000000000 });
const SYNC = (rev: number) => ({ state: STATE(rev), activeToken: { accessToken: `jwt-${rev}`, expiresAt: 'x' } });

function makeHost(over: Partial<SessionClientHost> = {}): SessionClientHost {
  return {
    makeRequest: jest.fn().mockResolvedValue(SYNC(1)),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 'tok',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => 'a1',
    ...over,
  };
}

describe('SessionClient.onServerEvent', () => {
  it('delivers a server event to a listener registered BEFORE the socket exists', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    const seen: unknown[] = [];
    client.onServerEvent('civic:attested', (p) => seen.push(p));
    await client.start();
    created?.emitServer('civic:attested', { byUserId: 'u2' });
    expect(seen).toEqual([{ byUserId: 'u2' }]);
    client.stop();
  });

  it('delivers to a listener registered AFTER the socket exists, and unsubscribe stops delivery', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    await client.start();
    const seen: unknown[] = [];
    const unsub = client.onServerEvent('civic:attested', (p) => seen.push(p));
    created?.emitServer('civic:attested', 1);
    unsub();
    created?.emitServer('civic:attested', 2);
    expect(seen).toEqual([1]);
    client.stop();
  });

  it('one listener throwing does not break the others', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    await client.start();
    const seen: unknown[] = [];
    client.onServerEvent('civic:attested', () => { throw new Error('boom'); });
    client.onServerEvent('civic:attested', (p) => seen.push(p));
    created?.emitServer('civic:attested', 'ok');
    expect(seen).toEqual(['ok']);
    client.stop();
  });
});
```

If `MinimalSocket` lacks a member used here, extend the FakeSocket only — do NOT change `MinimalSocket`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bunx jest src/session/__tests__/SessionClient.serverEvents.test.ts`
Expected: FAIL — `client.onServerEvent is not a function`.

- [ ] **Step 3: Implement `onServerEvent`**

In `packages/core/src/session/SessionClient.ts`:

Add fields near the other private members:

```ts
  /** App-facing subscriptions to named server-pushed socket events. */
  private readonly serverEvents = new Map<string, Set<(payload: unknown) => void>>();
  /** Event names already bound on the CURRENT socket instance. */
  private readonly boundServerEvents = new Set<string>();
```

Add the public method + private binder (near `subscribe`):

```ts
  /**
   * Subscribe to a named server-pushed Socket.IO event (e.g. `civic:attested`).
   * Listeners survive reconnects and socket re-creation; the returned function
   * unsubscribes. Payloads are delivered as-is — callers validate shape.
   */
  onServerEvent(event: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.serverEvents.get(event);
    if (!listeners) {
      listeners = new Set();
      this.serverEvents.set(event, listeners);
    }
    listeners.add(listener);
    this.bindServerEvent(event);
    return () => {
      listeners.delete(listener);
    };
  }

  private bindServerEvent(event: string): void {
    if (!this.socket || this.boundServerEvents.has(event)) return;
    this.boundServerEvents.add(event);
    this.socket.on(event, (payload: unknown) => {
      const listeners = this.serverEvents.get(event);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(payload);
        } catch (error) {
          logger.warn('[SessionClient] server-event listener threw', { component: 'SessionClient' }, error);
        }
      }
    });
  }
```

At the END of `connectSocket()`, immediately after `this.socket = socket;`, add:

```ts
    // (Re)bind app-facing server-event subscriptions on the fresh socket.
    this.boundServerEvents.clear();
    for (const event of this.serverEvents.keys()) {
      this.bindServerEvent(event);
    }
```

In `stop()`, inside the `if (this.socket)` block after `this.socket = null;`, add:

```ts
      this.boundServerEvents.clear();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bunx jest src/session/__tests__/`
Expected: all session tests PASS (new file 3/3, no regressions in socket/socketFactory/broadcastChannel tests).

- [ ] **Step 5: Build core and run the full core suite**

Run: `bun run core:build && cd packages/core && bun run test`
Expected: build clean; suite passes (baseline ~722 tests, +3).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/SessionClient.ts packages/core/src/session/__tests__/SessionClient.serverEvents.test.ts
git commit -m "feat(core): SessionClient.onServerEvent — generic server-push event subscription

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `useOxyEvent` hook (services)

**Files:**
- Create: `packages/services/src/ui/hooks/useOxyEvent.ts`
- Modify: `packages/services/src/index.ts` (export)
- Modify (only if needed): `packages/services/src/ui/context/oxyContextTypes.ts` — `sessionClient` must be reachable from the context consumed by hooks. `OxyContext.tsx` already places `sessionClient` in the context value (see `OxyContext.tsx` around lines 334/367); if the context TYPE omits it, add `sessionClient: SessionClient` to the type rather than casting.

**Interfaces:**
- Consumes: `SessionClient.onServerEvent` (Task 1), the internal Oxy context.
- Produces: `useOxyEvent(event: string, handler: (payload: unknown) => void): void` — exported from `@oxy.so/services`. Subscribes for the component's lifetime; `handler` identity may change freely (ref-stable internally).

No unit test in services: the hook is a 15-line lifetime wrapper over `onServerEvent`, which Task 1 tests directly, and Task 4's commons test covers the consumer contract. (Standing up a context harness in services for this would test React, not our logic.)

- [ ] **Step 1: Implement the hook**

`packages/services/src/ui/hooks/useOxyEvent.ts`:

```ts
import { useEffect, useRef } from 'react';

import { useOxy } from '../context/OxyContext';

/**
 * Subscribe to a named server-pushed Socket.IO event (e.g. `civic:attested`)
 * for the lifetime of the component. Payloads arrive as `unknown` — callers
 * validate shape. Handler identity may change between renders; the latest one
 * is always invoked.
 */
export function useOxyEvent(event: string, handler: (payload: unknown) => void): void {
  const { sessionClient } = useOxy();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!sessionClient) return;
    return sessionClient.onServerEvent(event, (payload) => {
      handlerRef.current(payload);
    });
  }, [sessionClient, event]);
}
```

Adjust the import path/name to match how sibling hooks in `packages/services/src/ui/hooks/` import `useOxy` (mirror an existing hook file's import exactly). If `useOxy()`'s return type does not include `sessionClient`, add it to the context type in `oxyContextTypes.ts` (typed as the `SessionClient` class imported `import type { SessionClient } from '@oxy.so/core'` — check how `OxyContext.tsx` already types it and reuse that).

- [ ] **Step 2: Export from the package root**

In `packages/services/src/index.ts`, next to the other hook exports, add:

```ts
export { useOxyEvent } from './ui/hooks/useOxyEvent';
```

- [ ] **Step 3: Build services + run its suite**

Run: `bun run services:build && cd packages/services && bun run test`
Expected: build clean (react-native-builder-bob), suite passes (baseline ~195).

- [ ] **Step 4: Commit**

```bash
git add packages/services/src/ui/hooks/useOxyEvent.ts packages/services/src/index.ts
# plus packages/services/src/ui/context/oxyContextTypes.ts if it was touched
git commit -m "feat(services): useOxyEvent — subscribe to server-pushed socket events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `civic:attested` socket emit (api)

**Files:**
- Modify: `packages/api/src/routes/civic.ts` (the `POST /civic/attestations` handler, ~line 286)
- Test: `packages/api/src/routes/__tests__/civicAttestations.test.ts` (extend)

**Interfaces:**
- Consumes: `getIO()` from `packages/api/src/utils/socket.ts`; `submitRealLifeAttestation` result (`{ ok, recordId, subjectUserId, attestorUserId, points }`).
- Produces: Socket.IO event `civic:attested` to room `user:<subjectUserId>` with payload `{ byUserId: string; recordId: string; points: number; at: string /* ISO */ }`. This exact shape is what Task 4's client hook validates.

- [ ] **Step 1: Write the failing tests**

In `packages/api/src/routes/__tests__/civicAttestations.test.ts`, add a socket mock alongside the existing mocks (top of file, `mock`-prefixed names so Jest's hoisting allows them):

```ts
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../../utils/socket', () => ({ getIO: () => ({ to: mockTo }) }));
```

Clear them in the existing `beforeEach` (or add one): `mockEmit.mockClear(); mockTo.mockClear();`

Add two tests following the file's existing request pattern (mirror how the existing 201-success test builds the request and `mockSubmit` resolution — copy that test and extend the assertions):

```ts
it('emits civic:attested to the subject user room on success', async () => {
  mockSubmit.mockResolvedValue({ ok: true, recordId: 'r1', subjectUserId: 'subj1', attestorUserId: B, points: 25 });
  // ...perform the same POST /civic/attestations request the success test does...
  expect(mockTo).toHaveBeenCalledWith('user:subj1');
  expect(mockEmit).toHaveBeenCalledWith('civic:attested', expect.objectContaining({
    byUserId: B,
    recordId: 'r1',
    points: 25,
    at: expect.any(String),
  }));
});

it('does NOT emit civic:attested when the attestation is rejected', async () => {
  mockSubmit.mockResolvedValue({ ok: false, reason: 'nonce_reused' });
  // ...perform the same POST request the rejection tests do (expecting the mapped error status)...
  expect(mockEmit).not.toHaveBeenCalled();
});
```

Use the file's real request helper/shape and a real rejection `reason` value from the existing tests — do not invent new harness code.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/api && bunx jest src/routes/__tests__/civicAttestations.test.ts`
Expected: new success-emit test FAILS (`mockTo` not called); rejection test may already pass — fine.

- [ ] **Step 3: Implement the emit**

In `packages/api/src/routes/civic.ts`:

Add to the imports: `import { getIO } from '../utils/socket';`

In the `POST /attestations` handler, after the `if (!result.ok) { throwForRealLifeReason(result.reason); }` block and before `res.status(201)`, add:

```ts
    // Level-2 card feedback: tell the subject (A) their attestation landed.
    // Best-effort — a missing io (tests, boot) must never fail the request.
    const io = getIO();
    if (io) {
      io.to(`user:${result.subjectUserId}`).emit('civic:attested', {
        byUserId: result.attestorUserId,
        recordId: result.recordId,
        points: result.points,
        at: new Date().toISOString(),
      });
    }
```

- [ ] **Step 4: Run the civic route tests, then the api suite**

Run: `cd packages/api && bunx jest src/routes/__tests__/civicAttestations.test.ts` → PASS.
Run: `cd packages/api && bun run test`
Expected: full suite passes (baseline ~1322, +2).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/civic.ts packages/api/src/routes/__tests__/civicAttestations.test.ts
git commit -m "feat(api): emit civic:attested to subject on accepted real-life attestation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `useAttestedEvent` hook (commons)

**Files:**
- Create: `packages/commons/hooks/civic/useAttestedEvent.ts`
- Modify: `packages/commons/__mocks__/oxy-services.ts` (add `useOxyEvent` support)
- Test: `packages/commons/__tests__/hooks/useAttestedEvent.test.tsx`

**Interfaces:**
- Consumes: `useOxyEvent` from `@oxy.so/services` (Task 2); event shape from Task 3.
- Produces: `useAttestedEvent(onAttested: (payload: AttestedEventPayload) => void): void` and `interface AttestedEventPayload { byUserId: string; recordId: string; points: number; at: string }`.

- [ ] **Step 1: Extend the services mock**

In `packages/commons/__mocks__/oxy-services.ts` (match the file's existing style), add a capture-and-fire helper:

```ts
type OxyEventHandler = (payload: unknown) => void;
const oxyEventHandlers = new Map<string, Set<OxyEventHandler>>();

export function useOxyEvent(event: string, handler: OxyEventHandler): void {
  React.useEffect(() => {
    let set = oxyEventHandlers.get(event);
    if (!set) {
      set = new Set();
      oxyEventHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, [event, handler]);
}

/** Test helper: fire a fake server-pushed event at all registered handlers. */
export function __emitOxyEvent(event: string, payload: unknown): void {
  for (const handler of [...(oxyEventHandlers.get(event) ?? [])]) handler(payload);
}
```

If the mock file has a `__reset…` helper, clear `oxyEventHandlers` there too. Use whatever React import style the mock already uses.

- [ ] **Step 2: Write the failing test**

`packages/commons/__tests__/hooks/useAttestedEvent.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { __emitOxyEvent } from '@/__mocks__/oxy-services';
import { useAttestedEvent } from '@/hooks/civic/useAttestedEvent';

describe('useAttestedEvent', () => {
  it('fires the callback for a well-formed civic:attested payload', () => {
    const onAttested = jest.fn();
    renderHook(() => useAttestedEvent(onAttested));
    act(() => {
      __emitOxyEvent('civic:attested', { byUserId: 'u2', recordId: 'r1', points: 25, at: '2026-07-11T00:00:00.000Z' });
    });
    expect(onAttested).toHaveBeenCalledWith({ byUserId: 'u2', recordId: 'r1', points: 25, at: '2026-07-11T00:00:00.000Z' });
  });

  it('ignores malformed payloads (strict whitelist)', () => {
    const onAttested = jest.fn();
    renderHook(() => useAttestedEvent(onAttested));
    act(() => {
      __emitOxyEvent('civic:attested', null);
      __emitOxyEvent('civic:attested', 'nope');
      __emitOxyEvent('civic:attested', { byUserId: 42 });
    });
    expect(onAttested).not.toHaveBeenCalled();
  });

  it('never reacts to other event names', () => {
    const onAttested = jest.fn();
    renderHook(() => useAttestedEvent(onAttested));
    act(() => {
      __emitOxyEvent('session_removed', { byUserId: 'u2', recordId: 'r1' });
    });
    expect(onAttested).not.toHaveBeenCalled();
  });
});
```

Run: `cd packages/commons && bunx jest __tests__/hooks/useAttestedEvent.test.tsx`
Expected: FAIL — module `@/hooks/civic/useAttestedEvent` not found.

- [ ] **Step 3: Implement the hook**

`packages/commons/hooks/civic/useAttestedEvent.ts`:

```ts
import { useOxyEvent } from '@oxy.so/services';

export interface AttestedEventPayload {
  byUserId: string;
  recordId: string;
  points: number;
  at: string;
}

/**
 * Fires when the server confirms a real-life attestation for the CURRENT user
 * (`civic:attested` on the user socket room). Strict shape whitelist — a
 * malformed push is dropped, never partially applied.
 */
export function useAttestedEvent(onAttested: (payload: AttestedEventPayload) => void): void {
  useOxyEvent('civic:attested', (payload) => {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    if (typeof p.byUserId !== 'string' || typeof p.recordId !== 'string') return;
    onAttested({
      byUserId: p.byUserId,
      recordId: p.recordId,
      points: typeof p.points === 'number' ? p.points : 0,
      at: typeof p.at === 'string' ? p.at : '',
    });
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/commons && bunx jest __tests__/hooks/useAttestedEvent.test.tsx`
Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/commons/hooks/civic/useAttestedEvent.ts packages/commons/__mocks__/oxy-services.ts packages/commons/__tests__/hooks/useAttestedEvent.test.tsx
git commit -m "feat(commons): useAttestedEvent — server-confirmed attestation listener

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: NFC dependencies + config plugins (commons)

**Files:**
- Create: `packages/commons/plugins/with-hce.js`
- Modify: `packages/commons/package.json`, `packages/commons/app.config.js`, root `bun.lock`

**Interfaces:**
- Produces: installed `react-native-hce` + `react-native-nfc-manager`; Android manifest gains the HCE `CardService`, NFC permission/feature, and an `NDEF_DISCOVERED` intent filter for `oxycommons://attest`; iOS gains NFC reader entitlement + usage string. Later tasks import both libraries.

- [ ] **Step 1: Install deps**

```bash
cd packages/commons && bun add react-native-hce react-native-nfc-manager
cd /home/nate/Oxy/OxyHQServices && bun install
```

Expected: both appear in `packages/commons/package.json` dependencies; `bun.lock` updated.

- [ ] **Step 2: Write the HCE config plugin**

`packages/commons/plugins/with-hce.js` (plain JS — `app.config.js` is JS; mirror its module style):

```js
/**
 * Config plugin for react-native-hce (which ships no plugin of its own) plus
 * the NDEF tap deep link:
 *  - android.permission.NFC + android.hardware.nfc.hce (not required — the app
 *    must install on NFC-less devices; the emitter hook degrades to 'unsupported')
 *  - the HCE CardService (starts DISABLED; react-native-hce toggles it at runtime)
 *  - res/xml/aid_list.xml with the standard NDEF Type 4 AID (D2760000850101)
 *  - NDEF_DISCOVERED intent filter on MainActivity for oxycommons://attest so a
 *    tap opens the scan/attest flow even when the app is closed
 */
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const AID_LIST_XML = `<?xml version="1.0" encoding="utf-8"?>
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/app_name"
    android:requireDeviceUnlock="false">
    <aid-group android:category="other" android:description="@string/app_name">
        <aid-filter android:name="D2760000850101" />
    </aid-group>
</host-apdu-service>
`;

function withHce(config) {
  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const resXmlDir = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(resXmlDir, { recursive: true });
      fs.writeFileSync(path.join(resXmlDir, 'aid_list.xml'), AID_LIST_XML);
      return modConfig;
    },
  ]);

  config = withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === 'android.permission.NFC')) {
      manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.NFC' } });
    }

    manifest['uses-feature'] = manifest['uses-feature'] ?? [];
    if (!manifest['uses-feature'].some((f) => f.$['android:name'] === 'android.hardware.nfc.hce')) {
      manifest['uses-feature'].push({ $: { 'android:name': 'android.hardware.nfc.hce', 'android:required': 'false' } });
    }

    const app = manifest.application?.[0];
    if (!app) throw new Error('with-hce: AndroidManifest has no <application>');

    app.service = app.service ?? [];
    if (!app.service.some((s) => s.$['android:name'] === 'com.reactnativehce.services.CardService')) {
      app.service.push({
        $: {
          'android:name': 'com.reactnativehce.services.CardService',
          'android:exported': 'true',
          'android:enabled': 'false',
          'android:permission': 'android.permission.BIND_NFC_SERVICE',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.nfc.cardemulation.action.HOST_APDU_SERVICE' } }],
            category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.nfc.cardemulation.host_apdu_service',
              'android:resource': '@xml/aid_list',
            },
          },
        ],
      });
    }

    const mainActivity = (app.activity ?? []).find((a) => a.$['android:name'] === '.MainActivity');
    if (mainActivity) {
      mainActivity['intent-filter'] = mainActivity['intent-filter'] ?? [];
      const hasNdef = mainActivity['intent-filter'].some((f) =>
        (f.action ?? []).some((a) => a.$['android:name'] === 'android.nfc.action.NDEF_DISCOVERED'),
      );
      if (!hasNdef) {
        mainActivity['intent-filter'].push({
          action: [{ $: { 'android:name': 'android.nfc.action.NDEF_DISCOVERED' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [{ $: { 'android:scheme': 'oxycommons', 'android:host': 'attest' } }],
        });
      }
    }

    return modConfig;
  });

  return config;
}

module.exports = withHce;
```

**Before finalizing, verify the two react-native-hce facts against the installed package** (`packages/commons/node_modules/react-native-hce/` — or the isolated-linker path `node_modules/.bun/react-native-hce@*/node_modules/react-native-hce`): (a) the service class name `com.reactnativehce.services.CardService` in its `android/src/main/AndroidManifest.xml` or README, and (b) the runtime API names used in Task 6 (`HCESession.getInstance`, `setApplication`, `setEnabled`, `HCESession.Events.HCE_STATE_READ`, `NFCTagType4`, `NFCTagType4NDEFContentType.URL`) in its `src/` TypeScript. Adjust plugin/hook to the real names if they differ.

- [ ] **Step 3: Wire plugins into app.config.js**

In `packages/commons/app.config.js`, in the `plugins` array (after the `expo-camera` entry), add:

```js
      [
        'react-native-nfc-manager',
        {
          nfcPermission: 'Allow $(PRODUCT_NAME) to read attestation cards from nearby phones.',
        },
      ],
      './plugins/with-hce',
```

- [ ] **Step 4: Validate with a prebuild**

```bash
cd packages/commons && bunx expo prebuild --platform android --no-install
grep -A2 "CardService" android/app/src/main/AndroidManifest.xml
grep -B1 -A3 "NDEF_DISCOVERED" android/app/src/main/AndroidManifest.xml
cat android/app/src/main/res/xml/aid_list.xml
```

Expected: service present with `BIND_NFC_SERVICE` + `@xml/aid_list` meta-data; NDEF intent filter with scheme `oxycommons` host `attest`; aid_list.xml matches. Then remove the generated project (CNG — it must not be committed):

```bash
cd packages/commons && rm -rf android ios
```

- [ ] **Step 5: Commit (lockfile in the SAME commit)**

```bash
git add packages/commons/package.json packages/commons/app.config.js packages/commons/plugins/with-hce.js bun.lock
git commit -m "feat(commons): NFC deps + HCE/NDEF config plugins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `useNfcAttestEmitter` hook (commons)

**Files:**
- Create: `packages/commons/hooks/nfc/useNfcAttestEmitter.ts`
- Test: `packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx`

**Interfaces:**
- Consumes: `react-native-hce` (`HCESession`, `NFCTagType4`, `NFCTagType4NDEFContentType`), `react-native-nfc-manager` (`isSupported`, `isEnabled`).
- Produces: `useNfcAttestEmitter(options: { payload: string | null; enabled: boolean; onRead: () => void }): { state: NfcEmitterState }` with `type NfcEmitterState = 'unsupported' | 'off' | 'emitting'`. `'off'` covers both NFC-disabled-in-settings and not-currently-armed (blurred / no payload); the UI only distinguishes `'emitting'`.

- [ ] **Step 1: Write the failing test**

`packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx`:

```tsx
import { renderHook, waitFor, act } from '@testing-library/react';
import { Platform } from 'react-native';

const mockIsSupported = jest.fn(async () => true);
const mockIsEnabled = jest.fn(async () => true);
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: { isSupported: () => mockIsSupported(), isEnabled: () => mockIsEnabled() },
}));

const mockSetApplication = jest.fn(async () => undefined);
const mockSetEnabled = jest.fn(async () => undefined);
let readListener: (() => void) | null = null;
const mockRemoveListener = jest.fn();
const mockSession = {
  setApplication: mockSetApplication,
  setEnabled: mockSetEnabled,
  on: jest.fn((_event: string, cb: () => void) => {
    readListener = cb;
    return mockRemoveListener;
  }),
};
jest.mock('react-native-hce', () => ({
  __esModule: true,
  HCESession: {
    getInstance: jest.fn(async () => mockSession),
    Events: { HCE_STATE_READ: 'hceStateRead' },
  },
  NFCTagType4: jest.fn(function (this: Record<string, unknown>, props: unknown) { this.props = props; }),
  NFCTagType4NDEFContentType: { URL: 'url', Text: 'text' },
}));

// eslint-disable-next-line import/first
import { useNfcAttestEmitter } from '@/hooks/nfc/useNfcAttestEmitter';

const PAYLOAD = 'oxycommons://attest?payload=abc';

describe('useNfcAttestEmitter', () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    jest.clearAllMocks();
    readListener = null;
  });
  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  });

  it('arms HCE with the payload and reports emitting', async () => {
    const onRead = jest.fn();
    const { result } = renderHook(() => useNfcAttestEmitter({ payload: PAYLOAD, enabled: true, onRead }));
    await waitFor(() => expect(result.current.state).toBe('emitting'));
    expect(mockSetApplication).toHaveBeenCalledTimes(1);
    expect(mockSetEnabled).toHaveBeenCalledWith(true);
  });

  it('fires onRead when the HCE read event arrives', async () => {
    const onRead = jest.fn();
    const { result } = renderHook(() => useNfcAttestEmitter({ payload: PAYLOAD, enabled: true, onRead }));
    await waitFor(() => expect(result.current.state).toBe('emitting'));
    act(() => { readListener?.(); });
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it('reports off when NFC is disabled in settings', async () => {
    mockIsEnabled.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useNfcAttestEmitter({ payload: PAYLOAD, enabled: true, onRead: jest.fn() }));
    await waitFor(() => expect(result.current.state).toBe('off'));
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('reports unsupported on iOS and never touches native modules', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const { result } = renderHook(() => useNfcAttestEmitter({ payload: PAYLOAD, enabled: true, onRead: jest.fn() }));
    expect(result.current.state).toBe('unsupported');
    expect(mockIsSupported).not.toHaveBeenCalled();
  });

  it('disarms on unmount', async () => {
    const { result, unmount } = renderHook(() => useNfcAttestEmitter({ payload: PAYLOAD, enabled: true, onRead: jest.fn() }));
    await waitFor(() => expect(result.current.state).toBe('emitting'));
    unmount();
    expect(mockRemoveListener).toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenLastCalledWith(false);
  });
});
```

Adjust the `react-native-hce` mock surface to the REAL API discovered in Task 5 step 2 (event listener may be `session.on(event, cb)` returning a remover, or an `addListener`-style API — mirror reality, and update the hook below to match).

Run: `cd packages/commons && bunx jest __tests__/hooks/useNfcAttestEmitter.test.tsx`
Expected: FAIL — hook module not found.

- [ ] **Step 2: Implement the hook**

`packages/commons/hooks/nfc/useNfcAttestEmitter.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

export type NfcEmitterState = 'unsupported' | 'off' | 'emitting';

interface UseNfcAttestEmitterOptions {
  /** The `oxycommons://attest?…` string (same bytes as the QR); null while loading. */
  payload: string | null;
  /** Arm only while the owning screen is focused. */
  enabled: boolean;
  /** Fired once per HCE read session — the counterparty pulled the payload. */
  onRead: () => void;
}

/**
 * Emits the attestation payload as an NDEF Type 4 tag via HCE while enabled
 * (Android only). `'off'` covers NFC-disabled AND not-armed; only `'emitting'`
 * drives UI. Arms/disarms with the effect lifecycle; the caller regenerates
 * the payload on read/expiry, which re-arms with fresh bytes.
 */
export function useNfcAttestEmitter({ payload, enabled, onRead }: UseNfcAttestEmitterOptions): {
  state: NfcEmitterState;
} {
  const [state, setState] = useState<NfcEmitterState>(
    Platform.OS === 'android' ? 'off' : 'unsupported',
  );
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!enabled || !payload) {
      setState('off');
      return;
    }

    let cancelled = false;
    let removeListener: (() => void) | null = null;
    let armedSession: { setEnabled: (value: boolean) => Promise<unknown> } | null = null;

    (async () => {
      try {
        const NfcManager = (await import('react-native-nfc-manager')).default;
        const [supported, nfcOn] = await Promise.all([NfcManager.isSupported(), NfcManager.isEnabled()]);
        if (cancelled) return;
        if (!supported) {
          setState('unsupported');
          return;
        }
        if (!nfcOn) {
          setState('off');
          return;
        }

        const { HCESession, NFCTagType4, NFCTagType4NDEFContentType } = await import('react-native-hce');
        if (cancelled) return;
        const tag = new NFCTagType4({
          type: NFCTagType4NDEFContentType.URL,
          content: payload,
          writable: false,
        });
        const session = await HCESession.getInstance();
        // Register the disarm target BEFORE enabling — if the effect is
        // cancelled mid-arm, cleanup must still switch the service off.
        armedSession = session;
        await session.setApplication(tag);
        await session.setEnabled(true);
        if (cancelled) return;
        removeListener = session.on(HCESession.Events.HCE_STATE_READ, () => {
          onReadRef.current();
        });
        setState('emitting');
      } catch (error) {
        console.error('[useNfcAttestEmitter] failed to arm HCE session', error);
        if (!cancelled) setState('off');
      }
    })();

    return () => {
      cancelled = true;
      removeListener?.();
      if (armedSession) {
        armedSession.setEnabled(false).catch((error) => {
          console.warn('[useNfcAttestEmitter] failed to disarm HCE session', error);
        });
      }
    };
  }, [payload, enabled]);

  return { state };
}
```

Match the real `react-native-hce` API surface verified in Task 5 (constructor arguments, event API, whether `setApplication` precedes `setEnabled`). Keep the dynamic `await import(...)` — the module must never load on iOS.

- [ ] **Step 3: Run tests**

Run: `cd packages/commons && bunx jest __tests__/hooks/useNfcAttestEmitter.test.tsx`
Expected: 5/5 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/commons/hooks/nfc/useNfcAttestEmitter.ts packages/commons/__tests__/hooks/useNfcAttestEmitter.test.tsx
git commit -m "feat(commons): useNfcAttestEmitter — HCE attest payload emission

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `useNfcReader` hook (commons)

**Files:**
- Create: `packages/commons/hooks/nfc/useNfcReader.ts`
- Test: `packages/commons/__tests__/hooks/useNfcReader.test.tsx`

**Interfaces:**
- Consumes: `react-native-nfc-manager` (`start`, `isSupported`, `requestTechnology`, `getTag`, `cancelTechnologyRequest`, `Ndef.uri.decodePayload`, `NfcTech.Ndef`).
- Produces: `useNfcReader(): { available: boolean; readOnce: () => Promise<NfcReadResult> }` with `type NfcReadResult = { ok: true; uri: string } | { ok: false; reason: 'cancelled' | 'empty' }`.

- [ ] **Step 1: Write the failing test**

`packages/commons/__tests__/hooks/useNfcReader.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';

const mockStart = jest.fn(async () => undefined);
const mockIsSupported = jest.fn(async () => true);
const mockRequestTechnology = jest.fn(async () => undefined);
const mockGetTag = jest.fn();
const mockCancel = jest.fn(async () => undefined);
const mockDecodePayload = jest.fn(() => 'oxycommons://attest?payload=abc');

jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    start: () => mockStart(),
    isSupported: () => mockIsSupported(),
    requestTechnology: (tech: unknown) => mockRequestTechnology(tech),
    getTag: () => mockGetTag(),
    cancelTechnologyRequest: () => mockCancel(),
  },
  NfcTech: { Ndef: 'Ndef' },
  Ndef: { uri: { decodePayload: (bytes: Uint8Array) => mockDecodePayload(bytes) } },
}));

// eslint-disable-next-line import/first
import { useNfcReader } from '@/hooks/nfc/useNfcReader';

describe('useNfcReader', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports availability from isSupported', async () => {
    const { result } = renderHook(() => useNfcReader());
    await waitFor(() => expect(result.current.available).toBe(true));
  });

  it('reads one NDEF URI record and always releases the technology', async () => {
    mockGetTag.mockResolvedValue({ ndefMessage: [{ payload: [1, 2, 3] }] });
    const { result } = renderHook(() => useNfcReader());
    const read = await result.current.readOnce();
    expect(read).toEqual({ ok: true, uri: 'oxycommons://attest?payload=abc' });
    expect(mockCancel).toHaveBeenCalled();
  });

  it('returns empty for a tag with no NDEF payload', async () => {
    mockGetTag.mockResolvedValue({ ndefMessage: [] });
    const { result } = renderHook(() => useNfcReader());
    const read = await result.current.readOnce();
    expect(read).toEqual({ ok: false, reason: 'empty' });
    expect(mockCancel).toHaveBeenCalled();
  });

  it('returns cancelled when the session throws (user dismissed)', async () => {
    mockRequestTechnology.mockRejectedValueOnce(new Error('cancelled'));
    const { result } = renderHook(() => useNfcReader());
    const read = await result.current.readOnce();
    expect(read).toEqual({ ok: false, reason: 'cancelled' });
    expect(mockCancel).toHaveBeenCalled();
  });
});
```

Run: `cd packages/commons && bunx jest __tests__/hooks/useNfcReader.test.tsx` → FAIL (module not found).

- [ ] **Step 2: Implement the hook**

`packages/commons/hooks/nfc/useNfcReader.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

import NfcManager, { Ndef, NfcTech } from 'react-native-nfc-manager';

export type NfcReadResult = { ok: true; uri: string } | { ok: false; reason: 'cancelled' | 'empty' };

/**
 * One-shot NDEF reader for the "hold near the other phone" action (iPhone, and
 * Android as an in-app alternative to the system tap). `available` gates the
 * button; `readOnce` opens a reader session, decodes the first URI record, and
 * ALWAYS releases the NFC technology.
 */
export function useNfcReader(): { available: boolean; readOnce: () => Promise<NfcReadResult> } {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    NfcManager.isSupported()
      .then((supported) => {
        if (!cancelled) setAvailable(supported);
      })
      .catch((error) => {
        console.warn('[useNfcReader] isSupported failed', error);
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const readOnce = useCallback(async (): Promise<NfcReadResult> => {
    try {
      await NfcManager.start();
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      const record = tag?.ndefMessage?.[0];
      if (!record?.payload?.length) return { ok: false, reason: 'empty' };
      const uri = Ndef.uri.decodePayload(Uint8Array.from(record.payload));
      if (!uri) return { ok: false, reason: 'empty' };
      return { ok: true, uri };
    } catch (error) {
      // Thrown on user dismissal of the OS sheet — expected, not an error state.
      console.warn('[useNfcReader] read session ended', error);
      return { ok: false, reason: 'cancelled' };
    } finally {
      NfcManager.cancelTechnologyRequest().catch((error) => {
        console.warn('[useNfcReader] cancelTechnologyRequest failed', error);
      });
    }
  }, []);

  return { available, readOnce };
}
```

If the `start()` call placement differs from the real API (some versions require it once at module init), match the installed package's README.

- [ ] **Step 3: Run tests**

Run: `cd packages/commons && bunx jest __tests__/hooks/useNfcReader.test.tsx` → 4/4 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/commons/hooks/nfc/useNfcReader.ts packages/commons/__tests__/hooks/useNfcReader.test.tsx
git commit -m "feat(commons): useNfcReader — one-shot NDEF read for attest handoff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Card effect plumbing — `scanPulse` + `attestGlow` (commons)

**Files:**
- Modify: `packages/commons/components/OxyID/tilt-context.tsx`
- Modify: `packages/commons/components/OxyID/index.tsx`
- Modify: `packages/commons/components/holographic-card.tsx`

**Interfaces:**
- Consumes: existing `TiltContextValue` / `Ticket` / `HolographicCard`.
- Produces: `TiltContextValue` gains `scanPulse: SharedValue<number>` and `attestGlow: SharedValue<number>`. `Ticket` gains optional props `scanPulse?: SharedValue<number>` / `attestGlow?: SharedValue<number>` (internal zero-valued defaults when absent — existing call sites keep compiling). Semantics: `scanPulse` animates 0→1 once per NFC read (drives a diagonal shine sweep + a −3° pitch nudge shaped by `sin(π·t)`); `attestGlow` animates 0→1→0 on server confirmation (boosts iridescence + edge glow). The card only RENDERS these; triggering lives in Task 9.

No new unit test — this is pure Reanimated/Skia rendering (jsdom cannot exercise it); the gate is `tsc` + existing suite + the manual device checklist. Coordinate with any concurrently-running agent on these files (they were recently edited): re-read each file before editing.

- [ ] **Step 1: Extend the tilt context**

In `packages/commons/components/OxyID/tilt-context.tsx`, add to `TiltContextValue` (after `rotation`):

```ts
    /** 0→1 once per NFC read — shine sweep + pitch nudge (level-1 feedback). */
    scanPulse: SharedValue<number>;
    /** 0→1→0 on server-confirmed attestation — full shimmer (level-2 feedback). */
    attestGlow: SharedValue<number>;
```

- [ ] **Step 2: Thread through `Ticket`**

In `packages/commons/components/OxyID/index.tsx`:

Extend props:

```ts
type TicketProps = {
    width: number;
    height: number;
    frontSide?: ReactNode;
    backSide?: ReactNode;
    /** Optional QR face, revealed by a long-press (tap only flips front↔back). */
    qrSide?: ReactNode;
    /** Level-1 NFC-read feedback value (0→1 per read). Internal default: inert. */
    scanPulse?: SharedValue<number>;
    /** Level-2 attestation-confirmed feedback value (0→1→0). Internal default: inert. */
    attestGlow?: SharedValue<number>;
};
```

Inside the component (after `rotation`):

```ts
    // Effect channels — inert local values unless the screen supplies live ones.
    const internalScanPulse = useSharedValue(0);
    const internalAttestGlow = useSharedValue(0);
    const scanPulse = scanPulseProp ?? internalScanPulse;
    const attestGlow = attestGlowProp ?? internalAttestGlow;
```

(Destructure the props as `scanPulse: scanPulseProp, attestGlow: attestGlowProp`.) Add both to the `tiltContext` memo value and its dependency array. Import `SharedValue` type from `react-native-reanimated` if not present.

Add the nudge to `rTiltStyle` — replace the `rotateX` line:

```ts
            { rotateX: `${pitchDeg.value + pressRotateX.value - 3 * Math.sin(Math.min(1, Math.max(0, scanPulse.value)) * Math.PI)}deg` },
```

- [ ] **Step 3: Render the shine sweep + confirm shimmer in the Skia canvas**

In `packages/commons/components/holographic-card.tsx`:

Destructure the new values: `const { nx, ny, mag, isPressed, scanPulse, attestGlow } = useTilt();`

Boost the iridescence with the glow — replace `irisOpacity`:

```ts
    const irisOpacity = useDerivedValue(() =>
        Math.min(1, 0.32 + mag.value * 0.45 + isPressed.value * 0.16 + attestGlow.value * 0.5),
    );
```

Add derived values after `glossOpacity`:

```ts
    // NFC-read shine: a narrow diagonal band that sweeps corner-to-corner as
    // scanPulse runs 0→1, fading in/out with sin(π·t) so it never pops.
    const scanBandStart = useDerivedValue(() => {
        const p = scanPulse.value * 2 - 1;
        return vec(width * (p - 0.6), height * (p - 0.6));
    });
    const scanBandEnd = useDerivedValue(() => {
        const p = scanPulse.value * 2 - 1;
        return vec(width * (p + 0.6), height * (p + 0.6));
    });
    const scanBandOpacity = useDerivedValue(() =>
        Math.sin(Math.min(1, Math.max(0, scanPulse.value)) * Math.PI) * 0.9,
    );

    // Attestation-confirmed edge glow.
    const attestEdgeOpacity = useDerivedValue(() => attestGlow.value * 0.9);
```

Add two groups inside the `<Group>` — the scan band right AFTER the gloss `<Group>`, the edge glow right BEFORE the final edge-definition `RoundedRect`:

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

                {/* Attestation-confirmed iridescent edge glow (attestGlow-driven). */}
                <Group opacity={attestEdgeOpacity}>
                    <RoundedRect
                        x={1.5}
                        y={1.5}
                        width={width - 3}
                        height={height - 3}
                        r={23}
                        style="stroke"
                        strokeWidth={3}>
                        <LinearGradient start={vec(0, 0)} end={vec(width, height)} colors={IRIDESCENT} />
                    </RoundedRect>
                </Group>
```

- [ ] **Step 4: Typecheck + full commons suite**

Run: `cd packages/commons && bunx tsc --noEmit && bun run test`
Expected: clean typecheck; suite passes (both values are optional — `attest-me`/other `Ticket` call sites unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/commons/components/OxyID/tilt-context.tsx packages/commons/components/OxyID/index.tsx packages/commons/components/holographic-card.tsx
git commit -m "feat(commons): scanPulse + attestGlow effect channels on the Oxy ID card

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: ID screen integration + i18n (commons)

**Files:**
- Modify: `packages/commons/app/(tabs)/(id)/index.tsx`
- Modify: `packages/commons/lib/i18n/locales/en.json`, `packages/commons/lib/i18n/locales/es.json`

**Interfaces:**
- Consumes: `useAttestQr` (existing), `useNfcAttestEmitter` (Task 6), `useAttestedEvent` (Task 4), `Ticket` effect props (Task 8).
- Produces: the ID screen emits NFC while focused (Android), pulses on read, shimmers + shows a temporary check badge on confirmation, and shows a small "NFC active" hint while emitting.

- [ ] **Step 1: Wire the hooks into `IdScreen`**

In `packages/commons/app/(tabs)/(id)/index.tsx`:

New imports (merge with existing lines):

```ts
import { useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  Easing,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useAttestQr } from '@/hooks/useAttestQr';
import { useNfcAttestEmitter } from '@/hooks/nfc/useNfcAttestEmitter';
import { useAttestedEvent } from '@/hooks/civic/useAttestedEvent';
```

Inside the component (after the existing `qrPayload` memo):

```ts
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

  // Same payload the attest-me QR uses; one interaction id per screen session.
  const attestContext = useMemo(() => `irl-nfc-${Date.now().toString(36)}`, []);
  const { payload: attestPayload, exp: attestExp, regenerate: regenerateAttest } = useAttestQr(attestContext);

  // Single-use nonce: re-mint when it expires while we are emitting.
  useEffect(() => {
    if (!focused || !attestExp) return;
    const ms = attestExp - Date.now();
    if (ms <= 0) {
      regenerateAttest();
      return;
    }
    const id = setTimeout(regenerateAttest, ms);
    return () => clearTimeout(id);
  }, [focused, attestExp, regenerateAttest]);

  const triggerScanPulse = useCallback(() => {
    void Haptics.selectionAsync();
    if (reducedMotion) return;
    scanPulse.value = 0;
    scanPulse.value = withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }, (finished) => {
      if (finished) scanPulse.value = 0;
    });
  }, [scanPulse, reducedMotion]);

  const [attestedVisible, setAttestedVisible] = useState(false);
  const triggerAttestGlow = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAttestedVisible(true);
    setTimeout(() => setAttestedVisible(false), 2500);
    if (reducedMotion) return;
    attestGlow.value = withSequence(
      withTiming(1, { duration: 400 }),
      withDelay(1000, withTiming(0, { duration: 1400 })),
    );
  }, [attestGlow, reducedMotion]);

  const { state: nfcState } = useNfcAttestEmitter({
    payload: attestPayload,
    enabled: focused,
    onRead: () => {
      triggerScanPulse();
      regenerateAttest();
    },
  });

  useAttestedEvent(triggerAttestGlow);
```

The `setTimeout` in `triggerAttestGlow` must not leak: hold it in a ref and clear it in a small unmount effect (`useEffect(() => () => clearTimeout(ref.current), [])`), replacing the timer on each trigger.

- [ ] **Step 2: Render — effect props, badge, NFC hint**

Pass the values to the card: `<OxyID width={CARD_WIDTH} height={CARD_HEIGHT} scanPulse={scanPulse} attestGlow={attestGlow} …>` (existing faces unchanged).

Inside the `styles.hero` view, after the card, replace the flip-hint block with:

```tsx
          {attestedVisible && (
            <View style={[styles.attestedBadge, { backgroundColor: colors.card }]}>
              <MaterialCommunityIcons name="check-decagram" size={18} color={colors.success ?? colors.tint} />
              <ThemedText style={styles.attestedBadgeText}>{t('civic.attest.confirmed')}</ThemedText>
            </View>
          )}
          <ThemedText style={[styles.flipHint, { color: colors.textSecondary }]}>
            {nfcState === 'emitting' ? t('civic.nfc.active') : t('civic.id.flipHint')}
          </ThemedText>
```

(Use whatever success-tone color key `useColors()` actually provides — check `hooks/useColors.ts`; fall back to `colors.tint`.) Add styles:

```ts
  attestedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  attestedBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
```

- [ ] **Step 3: i18n strings**

Add to `packages/commons/lib/i18n/locales/en.json` (inside the existing `civic` object, matching its nesting style):

```json
"nfc": {
  "active": "NFC active — hold phones together to verify",
  "read": "Hold near the other phone"
},
```

and under `civic.attest`: `"confirmed": "Verified in person"`.

Add to `es.json`:

```json
"nfc": {
  "active": "NFC activo — acerca los móviles para verificar",
  "read": "Acerca el móvil al otro dispositivo"
},
```

and under `civic.attest`: `"confirmed": "Verificado en persona"`.

(`civic.nfc.read` is consumed by Task 10.)

- [ ] **Step 4: Typecheck + suite**

Run: `cd packages/commons && bunx tsc --noEmit && bun run test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "packages/commons/app/(tabs)/(id)/index.tsx" packages/commons/lib/i18n/locales/en.json packages/commons/lib/i18n/locales/es.json
git commit -m "feat(commons): ID screen emits attest payload over NFC with card feedback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Receiver — scan-screen NFC button + attest deep-link payload (commons)

**Files:**
- Modify: `packages/commons/app/(scan)/index.tsx`
- Modify: `packages/commons/app/(scan)/attest.tsx`

**Interfaces:**
- Consumes: `useNfcReader` (Task 7), `parseScan` from `@/lib/commons-signin/parse-scan`, `parseAttestPayload` from `@oxy.so/core`.
- Produces: an NFC read lands on `(scan)/attest` with the SAME params the QR path produces; a system NDEF tap (`oxycommons://attest?payload=…`, Android, app possibly closed) is parsed by `attest.tsx` directly.

- [ ] **Step 1: Route NFC reads through the existing scan routing**

In `packages/commons/app/(scan)/index.tsx`, the barcode handler already parses + routes (`parsed.kind === 'approval' | 'id' | 'attest'`). Extract that routing block into a `routeParsed(parsed: ScanResult)` `useCallback` used by `handleBarcodeScanned`, then add the NFC button:

```tsx
const { available: nfcAvailable, readOnce } = useNfcReader();

const handleNfcRead = useCallback(async () => {
  const read = await readOnce();
  if (!read.ok) return; // cancelled/empty — stay on the scanner
  routeParsed(parseScan(read.uri));
}, [readOnce, routeParsed]);
```

Render a secondary action under the camera view (match the screen's existing control styling — there are already overlay controls; mirror one):

```tsx
{nfcAvailable && (
  <PrimaryButton icon="nfc" label={t('civic.nfc.read')} onPress={handleNfcRead} />
)}
```

Use the screen's real button/overlay components and t() import — mirror what the file already uses rather than introducing new ones. If `parseScan(read.uri)` yields an unknown kind, fall through to the screen's existing invalid-QR feedback path.

- [ ] **Step 2: Accept the raw payload param in attest.tsx**

`(scan)/attest.tsx` currently reads `{ subjectDid?, context?, nonce?, exp? }` params (set by the scanner). A system NDEF tap deep-links `oxycommons://attest?payload=…` → expo-router lands here with a `payload` param instead. Extend the param type with `payload?: string` and derive:

```ts
// System NFC tap (Android) deep-links the raw signed payload; the scanner
// paths pass pre-parsed fields. Normalize both into one shape.
const fromPayload = useMemo(() => {
  if (!raw.payload) return null;
  try {
    return parseAttestPayload(`oxycommons://attest?payload=${encodeURIComponent(raw.payload)}`);
  } catch (error) {
    console.warn('[AttestScreen] invalid NFC attest payload', error);
    return null;
  }
}, [raw.payload]);
```

then prefer `fromPayload`'s fields over the individual params when present. **Before coding, read `packages/commons/lib/commons-signin/parse-scan.ts` lines ~55–85** — it shows exactly how `parseAttestPayload` output maps to the router params (`subjectDid`, `context`, `nonce`, `exp`); mirror that mapping so both entry paths produce identical state, including the exp string→number conversion the screen already does. If `parseAttestPayload` returns null on bad input instead of throwing, drop the try/catch and null-check instead — match the real signature in `@oxy.so/core`.

- [ ] **Step 3: Typecheck + full suite**

Run: `cd packages/commons && bunx tsc --noEmit && bun run test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "packages/commons/app/(scan)/index.tsx" "packages/commons/app/(scan)/attest.tsx"
git commit -m "feat(commons): NFC receive path — reader button + NDEF deep-link attest

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + manual device checklist

**Files:** none (verification only)

- [ ] **Step 1: Full builds + suites**

```bash
cd /home/nate/Oxy/OxyHQServices
bun run build:all
bun run --filter @oxy.so/core test
bun run --filter @oxy.so/services test
bun run --filter @oxy.so/api test
cd packages/commons && bun run test && bunx tsc --noEmit
```

Expected: all green (core ~722+3, services ~195, api ~1322+2, commons prior +12 new).

- [ ] **Step 2: Prebuild smoke (config plugins still valid after all changes)**

```bash
cd packages/commons && bunx expo prebuild --platform android --no-install && rm -rf android ios
```

Expected: prebuild completes without plugin errors.

- [ ] **Step 3: Manual device checklist (real hardware — REQUIRED before shipping; emulators have no NFC)**

Requires a NEW dev-client / EAS build (two new native modules): `cd packages/commons && bunx eas build --profile development --platform android` (and iOS for the reader button).

1. Android A on `(id)` tab → "NFC active" hint appears (NFC on) / absent (NFC off in settings).
2. Android B, **app closed**, tap against A → B opens directly into the attest screen showing A's card; A's card pulses (nudge + shine + haptic) at the moment of the tap.
3. iPhone B → scan FAB → "Hold near the other phone" → tap against A → same attest screen; A pulses.
4. B completes biometric + signs → A's card runs the full shimmer + edge glow + "Verified in person" badge (level 2) within a few seconds.
5. QR path regression: attest-me QR scanned by B → still works end-to-end AND A gets the level-2 shimmer.
6. Reduced motion enabled on A → haptics + badge only, no card animation.
7. Repeat a tap after a completed read → new nonce was minted (payload regenerated), second attest attempt is correctly rejected by the server if within cooldown/exclusion rules.

- [ ] **Step 4: Docs**

Spawn **docs-keeper** to add the NFC attest transport + `useOxyEvent`/`onServerEvent` API to `packages/commons`'s section and the "Key Entry Points" list in `~/Oxy/OxyHQServices/AGENTS.md` (durable rules only, no version pins).
