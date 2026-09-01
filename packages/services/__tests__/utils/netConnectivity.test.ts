import {
  isNetConnectivityExplicitlyOffline,
  isNetConnectivityOnline,
} from '../../src/ui/utils/netConnectivity';

describe('netConnectivity', () => {
  describe('isNetConnectivityOnline', () => {
    it('treats connected + reachable as online', () => {
      expect(isNetConnectivityOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
    });

    it('treats connected + probing reachability as online', () => {
      expect(isNetConnectivityOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
    });

    it('treats connected + explicitly unreachable as offline', () => {
      expect(isNetConnectivityOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
    });

    it('treats disconnected as offline', () => {
      expect(isNetConnectivityOnline({ isConnected: false, isInternetReachable: true })).toBe(false);
    });
  });

  describe('isNetConnectivityExplicitlyOffline', () => {
    it('returns false for unknown / timed-out probes', () => {
      expect(isNetConnectivityExplicitlyOffline(null)).toBe(false);
      expect(isNetConnectivityExplicitlyOffline(undefined)).toBe(false);
      expect(isNetConnectivityExplicitlyOffline({ isConnected: null })).toBe(false);
    });

    it('returns true for explicit disconnect', () => {
      expect(isNetConnectivityExplicitlyOffline({ isConnected: false })).toBe(true);
    });

    it('returns true for connected but explicitly unreachable', () => {
      expect(
        isNetConnectivityExplicitlyOffline({ isConnected: true, isInternetReachable: false }),
      ).toBe(true);
    });

    it('returns false while reachability is still probing', () => {
      expect(
        isNetConnectivityExplicitlyOffline({ isConnected: true, isInternetReachable: null }),
      ).toBe(false);
    });
  });
});
