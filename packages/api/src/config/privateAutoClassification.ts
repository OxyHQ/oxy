import { privateAutoSourceApprovalSchema, type PrivateAutoSourceApproval } from '@oxy.so/contracts';

/** No environment flag, request field or public setter can approve private text exposure. */
export function privateAutoClassifierSourceApproval(): PrivateAutoSourceApproval | undefined {
  return undefined;
}

/** Pure validation for the source getter and synthetic qualification fixtures. */
export function reviewedPrivateAutoApproval(value: unknown, now = Date.now()): PrivateAutoSourceApproval | undefined {
  const parsed = privateAutoSourceApprovalSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(now)) return undefined;
  const approval = parsed.data;
  const expiry = Date.parse(approval.expiresAt);
  const evidenceExpiry = Date.parse(approval.review.evidenceExpiresAt);
  return expiry > now && evidenceExpiry >= expiry ? approval : undefined;
}
