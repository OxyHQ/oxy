/**
 * The API role switch (`config/apiRole.ts`).
 *
 * The property that matters most is the one a deploy depends on: an existing
 * task definition, which never heard of `OXY_API_ROLE`, must keep behaving as
 * the whole platform — and a mistyped value must stop the boot rather than fall
 * back to serving every route under the Inbosh hostname.
 */

import { ApiRoleError, getApiRole, isEmailMaintenanceEnabled } from '../apiRole';

describe('getApiRole', () => {
  it('is the platform when the variable is absent, empty or blank', () => {
    expect(getApiRole({})).toBe('platform');
    expect(getApiRole({ OXY_API_ROLE: '' })).toBe('platform');
    expect(getApiRole({ OXY_API_ROLE: '   ' })).toBe('platform');
  });

  it('accepts the two roles by exact name', () => {
    expect(getApiRole({ OXY_API_ROLE: 'platform' })).toBe('platform');
    expect(getApiRole({ OXY_API_ROLE: 'inbosh' })).toBe('inbosh');
    expect(getApiRole({ OXY_API_ROLE: ' inbosh ' })).toBe('inbosh');
  });

  it('refuses anything else, so a typo never serves the whole platform as Inbosh', () => {
    for (const value of ['Inbosh', 'INBOSH', 'email', 'inbox', 'all', 'true']) {
      expect(() => getApiRole({ OXY_API_ROLE: value })).toThrow(ApiRoleError);
    }
  });
});

describe('isEmailMaintenanceEnabled', () => {
  it('keeps the platform service running the maintenance by default (ownership does not move)', () => {
    expect(isEmailMaintenanceEnabled('platform', {})).toBe(true);
  });

  it('does not run it on the inbosh service unless that service is told to', () => {
    expect(isEmailMaintenanceEnabled('inbosh', {})).toBe(false);
    expect(isEmailMaintenanceEnabled('inbosh', { EMAIL_MAINTENANCE_ENABLED: '' })).toBe(false);
  });

  it('lets an explicit setting move it, in either direction, on either service', () => {
    for (const on of ['true', '1', 'yes', 'TRUE']) {
      expect(isEmailMaintenanceEnabled('inbosh', { EMAIL_MAINTENANCE_ENABLED: on })).toBe(true);
    }
    for (const off of ['false', '0', 'no', 'off']) {
      expect(isEmailMaintenanceEnabled('platform', { EMAIL_MAINTENANCE_ENABLED: off })).toBe(false);
    }
  });
});
