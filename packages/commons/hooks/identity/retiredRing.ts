import type { OxyServices } from '@oxy.so/core';
import {
  KeyManager,
  claimRetiredIdentityKeys,
  listRetiredIdentityKeys,
  syncRetiredKeys,
  unmirrorPersonalRetiredKeys,
} from '@oxy.so/core/crypto';

// An older native write must finish before a new account reconciles its mirror.
let pending: Promise<void> = Promise.resolve();

export function reconcileRetiredRing(
  oxy: OxyServices,
  ownerAccountId: string,
  isCurrent: () => boolean,
): Promise<void> {
  let touched = false;
  const run = pending.then(async () => {
    try {
      if (!isCurrent()) return;
      let history = await oxy.identity.keyHistory();
      if (!isCurrent()) return;
      // Keys kept without an owner that Oxy's own records prove were this
      // account's root before it kept a key history (R6-5).
      try {
        history = await oxy.identity.claimQuarantinedKeys(history);
      } catch (error) {
        console.warn('[retiredRing] Could not ask Oxy about kept previous keys', error);
      }
      if (!isCurrent()) return;
      const named = [
        ...(history.publicKey ? [history.publicKey] : []),
        ...history.retired.map((entry) => entry.publicKey),
      ];
      touched = true;
      await claimRetiredIdentityKeys(ownerAccountId, named);
      if (!isCurrent()) return;
      await syncRetiredKeys(ownerAccountId);
      if (!isCurrent() || history.retired.length === 0) return;
      const held = new Set(
        (await listRetiredIdentityKeys({ ownerAccountId })).map((key) => key.publicKey),
      );
      if (!isCurrent()) return;
      if (
        !history.retired.some((entry) => !held.has(KeyManager.canonicalPublicKey(entry.publicKey)))
      )
        return;
      const phrase = await KeyManager.getRecoveryMnemonicForCurrentIdentity();
      if (!isCurrent() || !phrase) return;
      const restored = await oxy.identity.backup.restoreRetiredKeys(phrase);
      if (isCurrent() && restored > 0) await syncRetiredKeys(ownerAccountId);
    } finally {
      // A native write already in flight cannot be canceled. Remove its
      // personal mirror before a queued account starts, including on logout.
      if (touched && !isCurrent()) await unmirrorPersonalRetiredKeys();
    }
  });
  pending = run.catch(() => undefined);
  return run;
}
