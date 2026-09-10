/** Peable Gateway scopes — self-grantable on third-party applications. */
export const PAYMENTS_SCOPES = ['payments:read', 'payments:write'] as const;

export type PaymentsScope = (typeof PAYMENTS_SCOPES)[number];

/** True for self-service third-party apps that need the Peable carve-out. */
export function isUntrustedThirdPartyApp(application: {
  type: string;
  isOfficial: boolean;
  isInternal: boolean;
}): boolean {
  return (
    application.type === 'third_party' &&
    !application.isOfficial &&
    !application.isInternal
  );
}

/** Payment scopes currently granted on the application. */
export function availablePaymentsScopes(scopes: readonly string[]): PaymentsScope[] {
  return PAYMENTS_SCOPES.filter((scope) => scopes.includes(scope));
}

/** Build the next application scope list after toggling payments scopes. */
export function mergePaymentsScopes(
  existingScopes: readonly string[],
  payments: { read: boolean; write: boolean }
): string[] {
  const withoutPayments = existingScopes.filter(
    (scope) => !PAYMENTS_SCOPES.includes(scope as PaymentsScope)
  );
  const next = [...withoutPayments];
  if (payments.read) {
    next.push('payments:read');
  }
  if (payments.write) {
    next.push('payments:write');
  }
  return next;
}
