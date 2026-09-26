import type { PublicApplication } from '../api/apps';

export interface CommonsApprovalValidationInput {
  application: PublicApplication | null;
  status: string;
  expiresAt: number | string;
}

/**
 * Returns a user-facing blocking reason when an approval payload must not be
 * shown as actionable, or `null` when the request is still pending and valid.
 */
export function getCommonsApprovalBlockingReason(
  info: CommonsApprovalValidationInput,
): string | null {
  if (!info.application?.id) {
    return 'The requesting application could not be resolved.';
  }
  if (info.status !== 'pending') {
    return 'This sign-in request is invalid, already used, or expired.';
  }
  const expiresAtMs = parseCommonsApprovalExpiresAt(info.expiresAt);
  if (expiresAtMs !== null && expiresAtMs < Date.now()) {
    return 'This sign-in request has expired. Ask for a new QR code.';
  }
  return null;
}

/** Normalize API `expiresAt` (number or ISO string) to epoch ms. */
export function parseCommonsApprovalExpiresAt(
  expiresAt: CommonsApprovalValidationInput['expiresAt'],
): number | null {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return expiresAt;
  if (typeof expiresAt === 'string') {
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
