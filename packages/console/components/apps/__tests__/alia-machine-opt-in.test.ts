import { arraysEqual, nextApplicationScopes } from '../general-draft';
import { mergeAliaMachineScopes } from '@/lib/application-scopes';

const untouched = { paymentsRead: false, paymentsWrite: false, aliaMachineAccess: null };

describe('explicit Console Alia capability opt-in', () => {
  it('does not grant capabilities by default', () => {
    const scopes = ['user:read'];
    expect(arraysEqual(nextApplicationScopes(scopes, untouched), scopes)).toBe(true);
  });

  it('saves the explicit pair without dropping other capabilities', () => {
    expect(
      nextApplicationScopes(['user:read', 'payments:read'], {
        paymentsRead: true,
        paymentsWrite: false,
        aliaMachineAccess: true,
      }),
    ).toEqual(['user:read', 'payments:read', 'alia:chat', 'inference:invoke']);
  });

  it('removes the explicit pair without changing other capabilities', () => {
    expect(
      nextApplicationScopes(['user:read', 'alia:chat', 'inference:invoke'], {
        ...untouched,
        aliaMachineAccess: false,
      }),
    ).toEqual(['user:read']);
  });

  it('does not modify a partial grant when the switch is untouched', () => {
    const scopes = ['user:read', 'inference:invoke'];
    expect(nextApplicationScopes(scopes, untouched)).toEqual(scopes);
  });

  it('preserves all scopes when the control is untouched', () => {
    const scopes = ['payments:write', 'inference:invoke', 'user:read'];
    expect(mergeAliaMachineScopes(scopes, null)).toEqual(scopes);
    expect(mergeAliaMachineScopes(scopes, true)).toEqual([
      'payments:write',
      'user:read',
      'alia:chat',
      'inference:invoke',
    ]);
  });
});
