import type { Application } from '@/hooks/use-applications';
import { draftFromApplication, isDraftDirty } from '../general-draft';

const application = {
  _id: 'a1',
  name: 'Atlas',
  redirectUris: ['https://a.test/cb'],
  scopes: ['user:read', 'payments:read'],
} as unknown as Application;

describe('General draft', () => {
  it('is clean when nothing was touched', () => {
    expect(isDraftDirty(application, draftFromApplication(application))).toBe(false);
  });

  it('is dirty after a field, a redirect URI or a scope changes', () => {
    const base = draftFromApplication(application);
    expect(isDraftDirty(application, { ...base, name: 'Atlas 2' })).toBe(true);
    expect(isDraftDirty(application, { ...base, redirectUris: [] })).toBe(true);
    expect(isDraftDirty(application, { ...base, paymentsWrite: true })).toBe(true);
    expect(isDraftDirty(application, { ...base, aliaMachineAccess: true })).toBe(true);
  });

  it('reads an unset optional column as the empty string', () => {
    const draft = draftFromApplication(application);
    expect(draft.websiteUrl).toBe('');
    expect(draft.paymentsRead).toBe(true);
    expect(draft.paymentsWrite).toBe(false);
  });
});
