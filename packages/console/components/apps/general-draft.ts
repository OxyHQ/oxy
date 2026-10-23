import type { Application } from '@/hooks/use-applications';
import {
  availablePaymentsScopes,
  mergeAliaMachineScopes,
  mergePaymentsScopes,
} from '@/lib/application-scopes';

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

/** Everything General edits, as the form holds it (strings never null). */
export interface GeneralDraft {
  name: string;
  description: string;
  websiteUrl: string;
  privacyPolicyUrl: string;
  termsUrl: string;
  icon: string;
  redirectUris: Array<string>;
  paymentsRead: boolean;
  paymentsWrite: boolean;
  /** `null` until the Alia switch is touched. */
  aliaMachineAccess: boolean | null;
}

/** The draft that equals what is stored, so an untouched form is not dirty. */
export function draftFromApplication(application: Application): GeneralDraft {
  const payments = availablePaymentsScopes(application.scopes);
  return {
    name: application.name,
    description: application.description ?? '',
    websiteUrl: application.websiteUrl ?? '',
    privacyPolicyUrl: application.privacyPolicyUrl ?? '',
    termsUrl: application.termsUrl ?? '',
    icon: application.icon ?? '',
    redirectUris: [...application.redirectUris],
    paymentsRead: payments.includes('payments:read'),
    paymentsWrite: payments.includes('payments:write'),
    aliaMachineAccess: null,
  };
}

/** The scope list the draft would save. */
export function draftScopes(application: Application, draft: GeneralDraft): Array<string> {
  return nextApplicationScopes(application.scopes, draft);
}

export function isDraftDirty(application: Application, draft: GeneralDraft): boolean {
  const stored = draftFromApplication(application);
  return (
    draft.name !== stored.name ||
    draft.description !== stored.description ||
    draft.websiteUrl !== stored.websiteUrl ||
    draft.privacyPolicyUrl !== stored.privacyPolicyUrl ||
    draft.termsUrl !== stored.termsUrl ||
    draft.icon !== stored.icon ||
    !arraysEqual(draft.redirectUris, stored.redirectUris) ||
    !arraysEqual(draftScopes(application, draft), application.scopes)
  );
}
