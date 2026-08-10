/**
 * A missing `<OxyProvider>` must FAIL FAST (ADR 0004).
 *
 * `useOxy()` used to return a fabricated runtime — `isLoading: true`,
 * `isPrivateApiPending: true`, `sessionClient: null`, every async method a
 * rejecting no-op — so an app that forgot the provider rendered a spinner that
 * never resolved, with nothing in the console and every gate (`canUsePrivateApi`
 * false, `isAuthResolved` false) reading exactly like a slow cold boot. The
 * failure surfaced as "auth is broken in production", not as "you forgot a
 * provider".
 *
 * These cases also pin the naming half of the same ADR: `OxyProvider` is the ONE
 * exported component with that name, and the runtime provider is
 * `OxyRuntimeProvider`. Two exported components called `OxyProvider` made every
 * stack frame and doc reference ambiguous.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook } from '@testing-library/react';

import {
  useOxy,
  useOptionalOxy,
  OxyProviderMissingError,
} from '../../src/ui/context/OxyContext';
import * as oxyContextModule from '../../src/ui/context/OxyContext';
import { useI18n } from '../../src/ui/hooks/useI18n';

const SRC = path.join(__dirname, '..', '..', 'src');
const readSource = (relative: string) => readFileSync(path.join(SRC, relative), 'utf8');

describe('useOxy outside a provider', () => {
  it('throws OxyProviderMissingError instead of fabricating a runtime', () => {
    // React logs the thrown render error; silence it so the expected failure
    // does not read as a broken suite.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useOxy())).toThrow(OxyProviderMissingError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('names the fix in the message', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useOxy())).toThrow(/<OxyProvider>/);
      expect(() => renderHook(() => useOxy())).toThrow(/useOptionalOxy/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('carries a stable code so callers can branch on it', () => {
    expect(new OxyProviderMissingError().code).toBe('oxy_provider_missing');
  });
});

describe('useOptionalOxy outside a provider', () => {
  it('returns null rather than a stand-in runtime', () => {
    const { result } = renderHook(() => useOptionalOxy());
    expect(result.current).toBeNull();
  });

  // The ONE sanctioned optional caller. `packages/auth`'s production-bundle
  // probe renders `OxySignInRequestSurface` standalone to prove every element
  // beneath it links; a throw there would report a linkage failure that is not
  // one. The locale is display metadata, never a session gate.
  it('lets useI18n resolve copy from the fallback locale', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.locale).toBe('en-US');
    expect(typeof result.current.t('anything.at.all')).toBe('string');
  });
});

describe('one component named OxyProvider', () => {
  it('the runtime module exports OxyRuntimeProvider and nothing called OxyProvider', () => {
    expect(typeof oxyContextModule.OxyRuntimeProvider).toBe('function');
    expect(Object.keys(oxyContextModule)).not.toContain('OxyProvider');
    // The pre-ADR alias. Its removal is a clean cut, not a deprecation: it was
    // never reachable through any published export subpath.
    expect(Object.keys(oxyContextModule)).not.toContain('OxyContextProvider');
  });

  // `src/ui/server.ts` is deliberately absent: the `@oxyhq/services/ui/server`
  // subpath is an SSR shim that replaces every export with a render-null / empty
  // no-op, `OxyProvider` and `useOxy` included. It is its own published subpath
  // and its own fabricated runtime; retiring it is a public API removal.
  it.each([
    ['index.ts', 'index.ts'],
    ['ui/index.ts', 'ui/index.ts'],
    ['ui/client.ts', 'ui/client.ts'],
  ])('%s exports OxyProvider only from the composition root', (_label, file) => {
    const source = readSource(file);
    const exportsOfOxyProvider = source
      .split('\n')
      .filter((line) => /\bOxyProvider\b/.test(line) && line.trimStart().startsWith('export'));

    expect(exportsOfOxyProvider).toHaveLength(1);
    expect(exportsOfOxyProvider[0]).toMatch(/components\/OxyProvider/);
  });
});
