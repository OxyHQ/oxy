import { KeyManager, type IdentityStatus } from '@oxy.so/core/crypto';

/**
 * The identity verdict routing starts from, after a silent restore when one is
 * possible (OxyHQ/oxy#1388).
 *
 * When the keys are gone — `lost` (the marker says an identity lived here) or
 * `absent` (this app's own data went too) — `KeyManager.attemptIdentityRecovery`
 * tries every copy that needs no phrase: the backup slot, the shared slot and
 * the device backup in Android Block Store, which is the one that survives a
 * wipe of the shared-UID Keystore. All of it is local, so this works offline.
 * If a copy restores the identity the user never sees a recovery screen; if
 * none does, the original verdict stands and routing falls back to the recovery
 * screen (`lost`) or onboarding (`absent`) exactly as before.
 *
 * A restore that throws never breaks the probe: the original verdict is kept.
 */
export async function readIdentityVerdictWithSilentRestore(): Promise<IdentityStatus> {
  const verdict = await KeyManager.getIdentityStatus();
  if (verdict.state !== 'lost' && verdict.state !== 'absent') {
    return verdict;
  }
  try {
    const recovery = await KeyManager.attemptIdentityRecovery();
    if (!recovery.recovered) {
      return verdict;
    }
    return await KeyManager.getIdentityStatus({ bypassCache: true });
  } catch (error) {
    console.warn('[identity] silent restore failed; keeping the original verdict', error);
    return verdict;
  }
}
