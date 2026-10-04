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
export function availablePaymentsScopes(scopes: ReadonlyArray<string>): Array<PaymentsScope> {
  return PAYMENTS_SCOPES.filter((scope) => scopes.includes(scope));
}

/** Build the next application scope list after toggling payments scopes. */
export function mergePaymentsScopes(
  existingScopes: ReadonlyArray<string>,
  payments: { read: boolean; write: boolean }
): Array<string> {
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

/** Alia's app-only chat also needs the caller's hosted inference capability. */
export const ALIA_MACHINE_SCOPES = ['alia:chat', 'inference:invoke'] as const;

export function hasAliaMachineScopes(scopes: ReadonlyArray<string>): boolean {
  return ALIA_MACHINE_SCOPES.every((scope) => scopes.includes(scope));
}

/** Null means untouched: saving other fields must preserve partial grants too. */
export function mergeAliaMachineScopes(existing: ReadonlyArray<string>, enabled: boolean | null): Array<string> {
  if (enabled === null) return [...existing];
  const other = existing.filter((scope) => !ALIA_MACHINE_SCOPES.includes(scope as typeof ALIA_MACHINE_SCOPES[number]));
  return enabled ? [...other, ...ALIA_MACHINE_SCOPES] : other;
}
