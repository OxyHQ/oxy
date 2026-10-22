import { mergeAliaMachineScopes, mergePaymentsScopes } from '@/lib/application-scopes';

export function arraysEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * The scope list General would save: the stored scopes with the payments pair
 * and the Alia machine pair merged in. `aliaMachineAccess` is `null` until the
 * person touches the switch, which leaves a partial grant exactly as stored.
 */
export function nextApplicationScopes(
  scopes: ReadonlyArray<string>,
  choices: { paymentsRead: boolean; paymentsWrite: boolean; aliaMachineAccess: boolean | null },
): Array<string> {
  return mergeAliaMachineScopes(
    mergePaymentsScopes(scopes, { read: choices.paymentsRead, write: choices.paymentsWrite }),
    choices.aliaMachineAccess,
  );
}
