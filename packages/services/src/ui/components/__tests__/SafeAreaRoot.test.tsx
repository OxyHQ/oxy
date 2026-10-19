/**
 * `OxyProvider`'s safe-area root on web reports the WINDOW's metrics and never
 * mounts react-native-safe-area-context's measuring web provider.
 *
 * From 5.9 that provider measures its own element and reports
 * `windowInsets.bottom - (innerHeight - rect.bottom)` unclamped, so a provider
 * around a page that scrolls turns everything below the fold into bottom inset.
 * OxyHQ/website measured it: an 844px viewport over a 2690px page gave the mobile
 * account dialog a 2690px layout and an empty body (844px on 5.8.1). Here every
 * element measures as that page, so any provider that consulted it would fail.
 */
import type { ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { Platform } from 'react-native';
import type { EdgeInsets, Rect } from 'react-native-safe-area-context';

const mockMeasuringProvider = jest.fn();

// The library's own contexts and hooks, with its measuring provider recorded.
// (Its real entry loads a codegen native component this jest setup cannot.)
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const SafeAreaInsetsContext = React.createContext<unknown>(null);
  const SafeAreaFrameContext = React.createContext<unknown>(null);
  return {
    __esModule: true,
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    SafeAreaProvider: ({ children }: { children?: ReactNode }) => {
      mockMeasuringProvider();
      return children;
    },
    useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext),
    useSafeAreaFrame: () => React.useContext(SafeAreaFrameContext),
  };
});

import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaRoot } from '../SafeAreaRoot';

const PAGE_HEIGHT = 2690;
const HOME_INDICATOR = 34;

const originalOS = Platform.OS;
const originalGetComputedStyle = window.getComputedStyle;
const originalRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  mockMeasuringProvider.mockClear();
  // jsdom has no env(): the fixed probe padded with env(safe-area-inset-*)
  // reads an iPhone's home-indicator inset at the bottom.
  window.getComputedStyle = ((element: Element) => {
    const style = originalGetComputedStyle(element);
    const probe = (element as HTMLElement).style?.position === 'fixed';
    return new Proxy(style, {
      get(target, key) {
        if (key === 'paddingBottom') return probe ? `${HOME_INDICATOR}px` : '0px';
        if (key === 'paddingTop' || key === 'paddingLeft' || key === 'paddingRight') return '0px';
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 375,
      height: PAGE_HEIGHT,
      right: 375,
      bottom: PAGE_HEIGHT,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterEach(() => {
  Platform.OS = originalOS;
  window.getComputedStyle = originalGetComputedStyle;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

function renderMetrics() {
  const seen: { insets?: EdgeInsets; frame?: Rect } = {};
  function Probe() {
    seen.insets = useSafeAreaInsets();
    seen.frame = useSafeAreaFrame();
    return null;
  }
  const view = render(
    <SafeAreaRoot>
      <Probe />
    </SafeAreaRoot>,
  );
  return { seen, view };
}

describe('SafeAreaRoot', () => {
  it('on web reports env() insets and the viewport frame, not the page', async () => {
    Platform.OS = 'web';
    const { seen, view } = renderMetrics();
    await act(async () => {});
    expect(mockMeasuringProvider).not.toHaveBeenCalled();
    expect(seen.insets).toEqual({ top: 0, right: 0, bottom: HOME_INDICATOR, left: 0 });
    // The react-native mock's window (useWindowDimensions), never PAGE_HEIGHT.
    expect(seen.frame).toEqual({ x: 0, y: 0, width: 375, height: 667 });
    view.unmount();
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
  });

  it('on web provides zero insets until the browser answers', () => {
    Platform.OS = 'web';
    window.getComputedStyle = originalGetComputedStyle;
    const { seen } = renderMetrics();
    expect(seen.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it.each(['ios', 'android'] as const)('on %s mounts the native SafeAreaProvider', (os) => {
    Platform.OS = os;
    renderMetrics();
    expect(mockMeasuringProvider).toHaveBeenCalled();
  });
});

describe('the SDK mounts safe-area providers only through SafeAreaRoot', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const srcRoot = path.resolve(__dirname, '../../..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
  }

  it('no other source file names SafeAreaProvider', () => {
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => /\bSafeAreaProvider\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file))
      .filter((rel) => rel !== path.join('ui', 'components', 'SafeAreaRoot.tsx'))
      // OxyProvider's usage doc shows an APP mounting its own provider.
      .filter((rel) => {
        const code = fs
          .readFileSync(path.join(srcRoot, rel), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        return /\bSafeAreaProvider\b/.test(code);
      });
    expect(offenders).toEqual([]);
  });

  it('OxyProvider wraps its tree in SafeAreaRoot', () => {
    const provider = fs.readFileSync(path.join(srcRoot, 'ui/components/OxyProvider.tsx'), 'utf8');
    expect(provider).toMatch(/import \{ SafeAreaRoot \} from '\.\/SafeAreaRoot'/);
    expect(provider).toMatch(/<SafeAreaRoot>/);
  });
});
