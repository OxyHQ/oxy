/**
 * Accounts' additions to the Oxy CSP baseline, read by
 * `packages/core/scripts/writePagesHeaders.ts` after the export.
 *
 * What the embedded Alia SDK loads (its API and voice socket, the avatar runtime,
 * the voice worklets) is the SDK's own declaration, composed in with
 * `withAliaSdkCsp`: no Alia origin is written here. What stays is Accounts' own:
 * the service worker, `blob:` images and fetches, and PostHog.
 */
import { withAliaSdkCsp } from '@alia.onl/sdk/csp';
import type { OxyPagesHeadersOptions } from '@oxy.so/core/server';

export default {
  csp: withAliaSdkCsp({
    workerSrc: ["'self'"],
    imgSrc: ['blob:'],
    connectSrc: ['blob:', 'https://eu.i.posthog.com'],
  }),
} satisfies OxyPagesHeadersOptions;
