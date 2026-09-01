/**
 * Back navigation that always has somewhere to go.
 *
 * `router.back()` on its own emits `The action 'GO_BACK' was not handled by
 * any navigator` whenever there is no history entry — opening a screen from a
 * pasted URL, a deep link, or a browser reload. Falling back to an explicit
 * route keeps the control meaningful in those entries instead of dead.
 */

import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

export function useGoBack(fallback: Href = '/') {
  const router = useRouter();

  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(fallback);
  }, [router, fallback]);
}
