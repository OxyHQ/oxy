import type { Application } from '@/hooks/use-applications';

export function arraysEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
}

/** The draft that equals what is stored, so an untouched form is not dirty. */
export function draftFromApplication(application: Application): GeneralDraft {
  return {
    name: application.name,
    description: application.description ?? '',
    websiteUrl: application.websiteUrl ?? '',
    privacyPolicyUrl: application.privacyPolicyUrl ?? '',
    termsUrl: application.termsUrl ?? '',
    icon: application.icon ?? '',
    redirectUris: [...application.redirectUris],
  };
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
    !arraysEqual(draft.redirectUris, stored.redirectUris)
  );
}
