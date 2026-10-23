/** Peable Gateway scopes — self-grantable on third-party applications. */
export const PAYMENTS_SCOPES = ['payments:read', 'payments:write'] as const;

export type PaymentsScope = (typeof PAYMENTS_SCOPES)[number];

/** Presentation only: registering an Oxy app never elevates an API credential. */
export function isOxyApplication(application: {
  type: string;
  isOfficial: boolean;
  isInternal: boolean;
}): boolean {
  return (
    application.isOfficial ||
    application.isInternal ||
    ['first_party', 'internal', 'system'].includes(application.type)
  );
}

/** Mirrors the API's self-service service-credential subset (not workload authority). */
const SELF_SERVICE_SCOPES: ReadonlySet<string> = new Set([
  ...PAYMENTS_SCOPES,
  'files:app:write',
  'files:app:delete',
  'files:references:write',
]);

export function availableCredentialScopes(
  application: { type: string; isOfficial: boolean; isInternal: boolean; scopes: Array<string> },
  type: 'service' | 'machine',
): Array<string> {
  return application.scopes.filter((scope) =>
    type === 'machine' || isOxyApplication(application) || SELF_SERVICE_SCOPES.has(scope),
  );
}

/** Build the next application scope list after toggling payments scopes. */
export function mergePaymentsScopes(
  existingScopes: ReadonlyArray<string>,
  payments: { read: boolean; write: boolean },
): Array<string> {
  if (
    existingScopes.includes('payments:read') === payments.read &&
    existingScopes.includes('payments:write') === payments.write
  ) {
    return [...existingScopes];
  }
  const withoutPayments = existingScopes.filter(
    (scope) => !PAYMENTS_SCOPES.includes(scope as PaymentsScope),
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

/** External Alia chat keys also need the caller's hosted inference scope. */
export const ALIA_MACHINE_SCOPES = ['alia:chat', 'inference:invoke'] as const;

export function hasAliaMachineScopes(scopes: ReadonlyArray<string>): boolean {
  return ALIA_MACHINE_SCOPES.every((scope) => scopes.includes(scope));
}

/** Null means untouched: saving other fields must preserve partial grants too. */
export function mergeAliaMachineScopes(
  existing: ReadonlyArray<string>,
  enabled: boolean | null,
): Array<string> {
  if (enabled === null) return [...existing];
  const other = existing.filter(
    (scope) => !ALIA_MACHINE_SCOPES.includes(scope as (typeof ALIA_MACHINE_SCOPES)[number]),
  );
  return enabled ? [...other, ...ALIA_MACHINE_SCOPES] : other;
}

/** External credential ceiling only; Oxy workloads never use this scope list. */
export function nextApplicationScopes(
  scopes: ReadonlyArray<string>,
  choices: { paymentsRead: boolean; paymentsWrite: boolean; aliaMachineAccess: boolean | null },
): Array<string> {
  return mergeAliaMachineScopes(
    mergePaymentsScopes(scopes, { read: choices.paymentsRead, write: choices.paymentsWrite }),
    choices.aliaMachineAccess,
  );
}
