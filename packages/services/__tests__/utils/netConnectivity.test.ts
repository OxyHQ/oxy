import { isNetConnectivityOnline } from '../../src/ui/utils/netConnectivity';

describe('isNetConnectivityOnline', () => {
  it('follows isConnected alone', () => {
    expect(isNetConnectivityOnline({ isConnected: true })).toBe(true);
    expect(isNetConnectivityOnline({ isConnected: false })).toBe(false);
  });

  it('ignores the reachability probe, which networks that block Google fail for good', () => {
    expect(isNetConnectivityOnline({ isConnected: true, isInternetReachable: false })).toBe(true);
    expect(isNetConnectivityOnline({ isConnected: false, isInternetReachable: true })).toBe(false);
  });

  it('counts an unknown state as online, so nothing waits on it', () => {
    expect(isNetConnectivityOnline({ isConnected: null, isInternetReachable: null })).toBe(true);
  });
});
