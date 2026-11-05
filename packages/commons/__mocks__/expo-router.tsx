/**
 * Lightweight `expo-router` stub for component tests in the accounts package.
 *
 * `Redirect` renders a marker element carrying its `href` so tests can assert
 * *where* a guard redirects without standing up the real router runtime.
 * `useRouter`/`usePathname` return inert defaults for screens that read them.
 */
import React from 'react';

export interface RedirectProps {
  href: string;
}

export function Redirect({ href }: RedirectProps): React.ReactElement {
  return React.createElement('Redirect', { href, testID: 'redirect' });
}

export interface MockRouter {
  push: jest.Mock;
  replace: jest.Mock;
  back: jest.Mock;
  navigate: jest.Mock;
  canGoBack: jest.Mock;
  dismissTo: jest.Mock;
}

const router: MockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  navigate: jest.fn(),
  canGoBack: jest.fn(() => false),
  dismissTo: jest.fn(),
};

export function useRouter(): MockRouter {
  return router;
}

export function usePathname(): string {
  return '/';
}

export function __getMockRouter(): MockRouter {
  return router;
}

/** Route params a screen under test reads via `useLocalSearchParams()`. */
let searchParams: Record<string, string | undefined> = {};

export function useLocalSearchParams(): Record<string, string | undefined> {
  return searchParams;
}

/** Set (or clear, with no argument) the params the next render will read. */
export function __setMockSearchParams(next: Record<string, string | undefined> = {}): void {
  searchParams = next;
}
