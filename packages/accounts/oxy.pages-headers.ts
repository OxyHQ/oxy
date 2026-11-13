/**
 * Accounts' additions to the Oxy CSP baseline, read by
 * `packages/core/scripts/writePagesHeaders.ts` after the export.
 *
 * What the embedded Gemies SDK loads (its API and voice socket, the voice worklets) is the SDK's
 * own declaration, composed in with `withGemiesSdkCsp`: no Gemies origin is written here. What
 * stays is Accounts' own: the service worker, `blob:` images and fetches, and PostHog.
 */
import { withGemiesSdkCsp } from '@gemies/sdk/csp';
import type { OxyPagesHeadersOptions } from '@oxy.so/core/server';

export default {
  csp: withGemiesSdkCsp({
    workerSrc: ["'self'"],
    imgSrc: ['blob:'],
    connectSrc: ['blob:', 'https://eu.i.posthog.com'],
  }),
} satisfies OxyPagesHeadersOptions;
