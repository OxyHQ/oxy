import { useCallback, useEffect, useState } from 'react';
import { useOxy } from '@oxy.so/services';
import type { AttestQrPayload } from '@oxy.so/core';

/** Lifecycle of building the real-life-attestation QR the current user (A) shows. */
export type AttestQrState = 'loading' | 'ready' | 'error';

export interface UseAttestQr {
  state: AttestQrState;
  /** The `oxycommons://attest?…` string to encode as a QR; `null` until ready. */
  payload: string | null;
  /** The single-use nonce embedded in the payload. */
  nonce: string | null;
  /** The payload's expiry (epoch ms) — the screen shows a countdown from this. */
  exp: number | null;
  /** Mint a fresh QR (new nonce + expiry). */
  regenerate: () => void;
}

/**
 * Build (and let the user regenerate) the real-life-attestation QR that the
 * person being attested (A) displays. Each build mints a fresh single-use nonce
 * with a 10-minute expiry via `oxyServices.buildAttestQrPayload`. The QR carries
 * no trust data — the scanner (B) re-signs and the server is authoritative.
 *
 * The one-shot build uses a `useEffect` keyed on the SDK client + context +
 * regenerate counter (a legitimate imperative load tied to the screen, mirroring
 * `useCommonsApproval`), not derived state.
 *
 * @param context - The opaque interaction id describing the encounter.
 */
export function useAttestQr(context: string): UseAttestQr {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<AttestQrState>('loading');
  const [data, setData] = useState<AttestQrPayload | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!oxyServices) return;
    let cancelled = false;
    setState('loading');
    oxyServices
      .buildAttestQrPayload({ context })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[useAttestQr] Failed to build attestation QR', error);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [oxyServices, context, reloadKey]);

  const regenerate = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    state,
    payload: data?.payload ?? null,
    nonce: data?.nonce ?? null,
    exp: data?.exp ?? null,
    regenerate,
  };
}
