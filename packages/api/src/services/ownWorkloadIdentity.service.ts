import crypto from 'node:crypto';
import { attestWorkloadIdentity, canAttestWorkloadIdentity } from '@oxy.so/core/server';

import { type AttestedWorkload, verifyWorkloadAttestation } from './workloadAttestation.service';

/**
 * What THIS process is, asked of the same machinery that answers it for every
 * other workload (ADR 0026).
 *
 * oxy-api hosts an application of its own — Inbox — and some of what it does
 * as Inbox never leaves the process: point inference resolves the Inbox
 * authority in-process and hands it to the edge directly. With a key pair that
 * authority was selected by the pair's public key. Without one it is the
 * binding of the role this task runs as, so the process needs its own role.
 *
 * ## Why STS and not configuration
 *
 * A role ARN in an environment variable or a constant would be the process's
 * own word for what it is — exactly what the mint refuses from every caller.
 * So this signs `GetCallerIdentity` with the container's credentials (the one
 * signer, `@oxy.so/core`'s) and verifies it with the one verifier
 * (`verifyWorkloadAttestation`): STS says whose credentials those are, and
 * `canonicalAwsSubject` reduces that to the role a binding names. The answer
 * is the same subject and the same `wl_…` handle a token minted by this task
 * would carry, by construction rather than by agreement.
 *
 * The nonce is ours on both ends, so no Redis challenge is involved: there is
 * no third party to replay a captured proof to, and the proof never leaves
 * this process except as the STS call itself.
 *
 * ## Cached for the life of the process, failures not at all
 *
 * A task's role cannot change while it runs, so one STS round trip per process
 * is the whole cost. Concurrent first callers share it. A failure (STS
 * unreachable, no credentials endpoint) is not remembered: the next caller
 * tries again rather than inheriting an outage. Nothing about AUTHORITY is
 * cached here — the binding behind this identity is re-read on every use by
 * whoever asks.
 */
let pending: Promise<AttestedWorkload> | null = null;

/**
 * This process's attested workload, or `null` when it has none to prove (a
 * laptop, CI, any host without a container credentials endpoint).
 *
 * Throws when it HAS one but it could not be verified right now — the caller
 * decides how to fail, and must fail closed.
 */
export async function ownWorkloadIdentity(): Promise<AttestedWorkload | null> {
  if (!canAttestWorkloadIdentity()) return null;
  if (pending === null) {
    const attempt = attestSelf();
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
  }
  return pending;
}

async function attestSelf(): Promise<AttestedWorkload> {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const proof = await attestWorkloadIdentity({ nonce });
  return verifyWorkloadAttestation(proof.provider, proof.attestation, nonce);
}

/** Test seam: forget the cached identity. */
export function resetOwnWorkloadIdentityForTests(): void {
  pending = null;
}
