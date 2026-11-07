/**
 * `resolveSignInDevice` — a browser, a phone, or a computer. A native platform
 * is a phone only by name; every other native platform is a computer, which
 * shows the QR a phone scans.
 */

import { Platform } from 'react-native';

const isWebBrowserMock = jest.fn(() => true);
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => isWebBrowserMock(),
}));

import { resolveSignInDevice } from '../../src/ui/utils/signInDevice';

const originalOS = Platform.OS;
const setOS = (os: string): void => {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
};

describe('resolveSignInDevice', () => {
  afterEach(() => setOS(originalOS));

  it('is a browser wherever the DOM says so', () => {
    isWebBrowserMock.mockReturnValue(true);
    setOS('web');
    expect(resolveSignInDevice()).toBe('browser');
  });

  it('is a phone on iOS and Android', () => {
    isWebBrowserMock.mockReturnValue(false);
    setOS('ios');
    expect(resolveSignInDevice()).toBe('phone');
    setOS('android');
    expect(resolveSignInDevice()).toBe('phone');
  });

  it('is a computer on every other native platform (OxyOS, macOS, Windows)', () => {
    isWebBrowserMock.mockReturnValue(false);
    for (const os of ['oxyos', 'macos', 'windows']) {
      setOS(os);
      expect(resolveSignInDevice()).toBe('computer');
    }
  });
});
