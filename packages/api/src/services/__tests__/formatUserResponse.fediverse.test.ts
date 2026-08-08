/**
 * `formatUserResponse` public `fediverseSharing` DTO flag.
 *
 * `privacySettings.fediverseSharing` gates ActivityPub federation for an
 * account. The DTO exposes it as a top-level, PUBLIC, derived boolean
 * (default true, false only when explicitly disabled) — like `isFederated`,
 * the state is observable anyway (the AP actor 404s when off), while the rest
 * of `privacySettings` stays private. Consumers (Mention) depend on this
 * exact field name and default-true-when-absent semantics.
 */


jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logEmailChange: jest.fn(), logProfileUpdate: jest.fn() },
}));

import { userService } from '../user.service';

describe('formatUserResponse fediverseSharing', () => {
  const base = { _id: '507f1f77bcf86cd799439011', username: 'nate', name: { first: 'N' } };

  it('defaults to true when privacySettings absent', () => {
    const dto = userService.formatUserResponse(base as never);
    expect(dto.fediverseSharing).toBe(true);
  });

  it('is false only when explicitly disabled', () => {
    const dto = userService.formatUserResponse({ ...base, privacySettings: { fediverseSharing: false } } as never);
    expect(dto.fediverseSharing).toBe(false);
  });

  it('does not leak the rest of privacySettings publicly', () => {
    const dto = userService.formatUserResponse({ ...base, privacySettings: { fediverseSharing: true, isPrivateAccount: true } } as never);
    expect(dto.privacySettings).toBeUndefined();
  });
});
