/**
 * The recovery phrase and a raw private key must not be capturable: the
 * onboarding screen said "Do not screenshot" while the window allowed it
 * (OxyHQ/oxy#1375 item 16).
 */
import React from 'react';
import { render } from '@testing-library/react';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { linkedNativeModules } from 'expo';
import { Platform } from 'react-native';
import { usePreventScreenCapture } from '@/hooks/usePreventScreenCapture';

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({ border: '#ccc', card: '#fff', text: '#000', textSecondary: '#666' }),
}));
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}(${JSON.stringify(params)})` : key,
  }),
}));

import { RecoveryPhraseGrid } from '@/components/identity/RecoveryPhraseGrid';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';

const prevent = preventScreenCaptureAsync as jest.Mock;
const allow = allowScreenCaptureAsync as jest.Mock;

function Guarded({ active }: { active?: boolean }) {
  usePreventScreenCapture(active);
  return null;
}

describe('usePreventScreenCapture', () => {
  beforeEach(() => {
    prevent.mockClear();
    allow.mockClear();
    linkedNativeModules.clear();
    linkedNativeModules.add('ExpoScreenCapture');
    Platform.OS = 'android';
  });

  it('blocks capture while mounted and releases the same key on unmount', () => {
    const { unmount } = render(<Guarded />);
    expect(prevent).toHaveBeenCalledTimes(1);
    const key = prevent.mock.calls[0][0];
    expect(allow).not.toHaveBeenCalled();

    unmount();
    expect(allow).toHaveBeenCalledWith(key);
  });

  it('gives each protected surface its own key, so one cannot release another', () => {
    render(
      <>
        <Guarded />
        <Guarded />
      </>,
    );
    const keys = prevent.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('does nothing while inactive', () => {
    render(<Guarded active={false} />);
    expect(prevent).not.toHaveBeenCalled();
  });

  it('is a no-op on a binary that does not link the native module (an OTA onto an older build)', () => {
    linkedNativeModules.clear();
    expect(() => render(<Guarded />).unmount()).not.toThrow();
    expect(prevent).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
  });
});

describe('surfaces that show or take the recovery phrase', () => {
  beforeEach(() => {
    prevent.mockClear();
    linkedNativeModules.add('ExpoScreenCapture');
    Platform.OS = 'android';
  });

  it('the revealed phrase blocks capture and still reads each word to a screen reader', () => {
    const words = ['legal', 'winner', 'thank'];
    const { container } = render(<RecoveryPhraseGrid words={words} textColor="#000" />);

    expect(prevent).toHaveBeenCalledTimes(1);
    const labels = Array.from(container.querySelectorAll('[aria-label]')).map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'auth.recoveryPhrase.wordLabel({"index":1,"word":"legal"})',
      'auth.recoveryPhrase.wordLabel({"index":2,"word":"winner"})',
      'auth.recoveryPhrase.wordLabel({"index":3,"word":"thank"})',
    ]);
  });

  it('the phrase entry grid blocks capture', () => {
    render(<PhraseInputGrid words={['', '']} onWordChange={jest.fn()} onPaste={jest.fn()} />);
    expect(prevent).toHaveBeenCalledTimes(1);
  });
});
