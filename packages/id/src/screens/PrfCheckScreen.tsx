import { useState } from 'react';
import { base64UrlToBuffer } from '../identity/base64url';
import { WEB_IDENTITY_PRF_INPUT } from '@oxy.so/core';
import { readPrfOutput } from '../identity/passkey';
import { messageOf } from '../identity/ports';

interface Probe {
  credentialId: string;
  firstPresent: boolean;
  secondPresent: boolean;
  stable: boolean;
}

/**
 * `/prf-check` — does THIS browser + passkey provide a stable PRF output?
 *
 * The design's phase 0 check, runnable on any device: two local ceremonies with
 * the same passkey, comparing the outputs. Nothing is sent to any server and
 * nothing is stored; the outputs themselves are never displayed, only whether
 * they exist and match.
 */
export function PrfCheckScreen() {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ceremony(credentialId?: string) {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        userVerification: 'required',
        allowCredentials: credentialId ? [{ id: base64UrlToBuffer(credentialId), type: 'public-key' }] : undefined,
        extensions: { prf: { eval: { first: WEB_IDENTITY_PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error('No passkey was used');
    return { credentialId: credential.id, output: readPrfOutput(credential.getClientExtensionResults()) };
  }

  async function run() {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const first = await ceremony();
      const second = await ceremony(first.credentialId);
      const stable = !!first.output && !!second.output && first.output.every((byte, index) => byte === second.output?.[index]);
      setProbe({ credentialId: first.credentialId, firstPresent: !!first.output, secondPresent: !!second.output, stable });
      first.output?.fill(0);
      second.output?.fill(0);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h1>Passkey PRF check</h1>
      <p>Checks whether this browser and passkey can keep an Oxy identity. You’ll be asked for your passkey twice. Nothing leaves this page.</p>
      {error ? <p className="error">{error}</p> : null}
      {probe ? (
        <dl className="results">
          <dt>PRF on first use</dt>
          <dd>{probe.firstPresent ? 'yes' : 'no'}</dd>
          <dt>PRF on second use</dt>
          <dd>{probe.secondPresent ? 'yes' : 'no'}</dd>
          <dt>Same secret both times</dt>
          <dd>{probe.stable ? 'yes — this browser can keep your identity' : 'no — this browser cannot keep your identity'}</dd>
          <dt>User agent</dt>
          <dd className="mono">{navigator.userAgent}</dd>
        </dl>
      ) : null}
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Checking…' : 'Run the check'}
        </button>
      </div>
    </section>
  );
}
