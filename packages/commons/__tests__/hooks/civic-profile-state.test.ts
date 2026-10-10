import { deriveCivicProfileState } from '@/hooks/useCivicProfileState';

describe('deriveCivicProfileState', () => {
  describe("subject: 'self'", () => {
    it("is 'pending' when the local identity is not yet synced (regardless of network)", () => {
      expect(deriveCivicProfileState({ subject: 'self', isSynced: false, isOnline: true })).toBe(
        'pending',
      );
      expect(deriveCivicProfileState({ subject: 'self', isSynced: false, isOnline: false })).toBe(
        'pending',
      );
    });

    it("is 'live' when synced and online", () => {
      expect(deriveCivicProfileState({ subject: 'self', isSynced: true, isOnline: true })).toBe(
        'live',
      );
    });

    it("is 'cache-first' when synced but offline", () => {
      expect(deriveCivicProfileState({ subject: 'self', isSynced: true, isOnline: false })).toBe(
        'cache-first',
      );
    });
  });

  describe("subject: 'remote'", () => {
    it("never returns 'pending' (a remote card is not the user's own identity)", () => {
      expect(deriveCivicProfileState({ subject: 'remote', isSynced: false, isOnline: true })).toBe(
        'live',
      );
      expect(deriveCivicProfileState({ subject: 'remote', isSynced: false, isOnline: false })).toBe(
        'cache-first',
      );
    });

    it("is 'live' online and 'cache-first' offline", () => {
      expect(deriveCivicProfileState({ subject: 'remote', isSynced: true, isOnline: true })).toBe(
        'live',
      );
      expect(deriveCivicProfileState({ subject: 'remote', isSynced: true, isOnline: false })).toBe(
        'cache-first',
      );
    });
  });
});
