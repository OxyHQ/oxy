export interface PendingCredentialReconciliation {
  dryRun: boolean;
  rotateScopeMismatch: boolean;
  pendingCredentialIds: readonly string[];
  appName: string;
  environment: string;
  revokeCredential: (credentialId: string) => Promise<void>;
  recordRevocation: (credentialId: string) => Promise<void>;
}

/**
 * Reconcile abandoned phase-one rows only on an applying run. Keeping this
 * boundary explicit makes DRY_RUN's zero-write contract hold even when an
 * earlier handoff left a pending credential behind.
 */
export async function reconcilePendingCredentials({
  dryRun,
  rotateScopeMismatch,
  pendingCredentialIds,
  appName,
  environment,
  revokeCredential,
  recordRevocation,
}: PendingCredentialReconciliation): Promise<void> {
  if (pendingCredentialIds.length > 0 && !rotateScopeMismatch) {
    throw new Error(
      `Application "${appName}" has an unfinished pending ${environment} service credential (${pendingCredentialIds.join(", ")}). Recover or revoke it before preparing another secret.`,
    );
  }
  if (dryRun) return;

  for (const credentialId of pendingCredentialIds) {
    await revokeCredential(credentialId);
    await recordRevocation(credentialId);
  }
}
