import { updatePrivacyBodySchema } from '../users.schemas';

describe('updatePrivacyBodySchema', () => {
  it('accepts known boolean privacy settings', () => {
    expect(
      updatePrivacyBodySchema.parse({
        privacySettings: { fediverseSharing: false, isPrivateAccount: true },
      }),
    ).toEqual({
      privacySettings: { fediverseSharing: false, isPrivateAccount: true },
    });
  });

  it('rejects unknown privacy settings keys', () => {
    expect(() =>
      updatePrivacyBodySchema.parse({
        privacySettings: { fediverseSharing: 'not-a-boolean' },
      }),
    ).toThrow();
  });

  it('strips unknown privacy settings keys', () => {
    expect(
      updatePrivacyBodySchema.parse({
        privacySettings: { injectedField: true, isPrivateAccount: true },
      }),
    ).toEqual({
      privacySettings: { isPrivateAccount: true },
    });
  });
});
